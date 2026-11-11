/* 实时出勤监控（v3.27.0，第六个独立入口）
 *
 * 目标：把风神「实时出勤监控」里一个站点一个站点看的数据，按商圈片汇总成一张表，
 * 30 秒（可改）自动刷新，并把「异常」与「不在线」的骑手单独列出来。
 *
 * 数据源（全部沿用线上接口，不新增后端）：
 *   getTeamsAll                     站点列表（含 org_id / tenant_id）
 *   listCustomTime                  时段（timeCode / timeName / startTime / endTime / current）
 *   listScheduleStatistics          该站点当天各时段：应排 predictNum / 实排 actualNum / 运力规模
 *   listAttendance                  该站点该时段每位骑手：排班 timeCode[]、在线 workStatus、背单 deliveryOrder
 *
 * 口径（与线上页面逐项核对过）：
 *   应排   = Σ predictNum（排班需求人数）
 *   实排   = Σ actualNum（实际排班人数）
 *   在线   = workStatus === 1 的骑手数（含未排班但还在线的，所以在线率可能略高于 100%）
 *   背单   = deliveryOrder > 0
 *   下线背单 = 不在线 && 背单 > 0
 *   异常   = 已排本时段 && 不在线 && 背单 === 0
 *   在线率 = 在线 ÷ 实排
 *
 * 架构：纯函数层（时段 / 单站汇总 / 商圈片聚合，不碰 DOM）+ 取数层（并发 4、单站失败不阻断）
 * + 视图层（KPI / 商圈片表 / 两张明细表）+ 定时器（切后台暂停、回前台补一次）。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const API_TIMES = XT + "xtop.fs.realTimeAttendance.listCustomTime/1.0";
const API_STAT = XT + "xtop.fs.special.schedule.listScheduleStatistics/1.0";
const API_ATT = XT + "xtop.fs.special.realtimeattendance.listAttendance/1.0";

const DEFAULT_GAP = 30;        // 默认 30 秒刷新一次
const MIN_GAP = 10;            // 最小 10 秒，防止把接口打爆
const MAX_GAP = 3600;          // 最大 1 小时
const STAT_TTL = 5 * 60 * 1000; // 应排 / 实排缓存 5 分钟（排班不会 30 秒一变）
const CONCURRENCY = 4;         // 同时最多 4 个站点在飞
const ONLINE_WORK_STATUS = 1;  // workStatus=1 表示在线（线上「在线人数」就是这个数）
const SLOT_IGNORE = [2, 9999]; // 休息 / 全天，不参与时段选择

const LS_GAP = "wb_rt_gap";
const LS_SITES = "wb_rt_sites";
const LS_SLOT = "wb_rt_slot";

// 站点名 → 商圈片（与 assess.js / schedule.js 同一套映射；没命中的按站点自己成组）
const SITE_TO_AREA = {
  "福州仓山区城门站-UB": "福州仓山区城门商圈片",
  "福州台江区宝龙站-UB": "福州台江区台江商圈片",
  "福州台江区万象购物中心站-UB": "福州台江区台江商圈片",
  "福州台江区河下站-UB": "福州台江区台江商圈片",
  "福州鼓楼区杨桥站-UB": "福州台江区台江商圈片",
  "福州鼓楼区福新路站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州鼓楼区五四站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州鼓楼区温泉公园站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州台江区茶亭站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州鼓楼区西湖站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州鼓楼区鼓楼站-UB": "福州鼓楼区茶亭西湖商圈片",
  "福州福清市宏路站-UB": "福州福清市万达宏路商圈片",
  "福州福清市凤凰站-UB": "福州福清市老城商圈片",
  "福州福清市福清万达站-UB": "福州福清市万达宏路商圈片",
  "福州仓山区万达站-UB": "福州仓山区仓山商圈片",
  "福州仓山区南国金辉站-UB": "福州仓山区仓山商圈片",
  "福州仓山区爱琴海站-UB": "福州仓山区仓山商圈片",
  "福州晋安区福新中路站-UB": "福州晋安区商圈片"
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad2 = (n) => String(n).padStart(2, "0");
const dateStrOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => dateStrOf(new Date());
const hhmmss = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  teams: [],
  slots: [],
  slotMode: "auto",            // auto / 具体 timeCode
  siteIds: [],
  siteAll: true,
  siteDraft: [],
  sites: [],                   // 单站汇总
  areas: [],                   // 商圈片汇总
  abnormal: [],                // 异常骑手
  offline: [],                 // 其余不在线（下线背单）
  gap: DEFAULT_GAP,
  countdown: 0,
  timer: null,
  auto: true,
  loading: false,
  lastAt: null,
  errors: [],
  seq: 0,
  statCache: new Map(),        // `${teamId}|${date}` → {at, byCode, teamKnightNum}
  expanded: new Set(),
  slotCode: ""
};

// ---------------------------------------------------------------- 双通道请求
function extMsg(msg) {
  try { return chrome.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}
async function bridgeApi(api, payload) {
  const resp = await extMsg({ type: "BRIDGE_API", api, payload });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}
/** 直连优先；CORS / 登录态 / 网络失败自动切静默桥接。测试可用 __RT_MOCK__ 接管。 */
async function postApi(api, payload) {
  if (typeof window.__RT_MOCK__ === "function") return await window.__RT_MOCK__(api, payload);
  if (state.via === "bridge") return await bridgeApi(api, payload);
  try {
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      credentials: "include",
      referrerPolicy: "unsafe-url",
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return await bridgeApi(api, payload);
  }
}
const okJson = (j) => !!j && String(j.code) === "200" && (!j.result || String(j.result.code) === "200");
const dataOf = (j) => (j && j.result ? (j.result.data == null ? j.result : j.result.data) : null);
const msgOf = (j) => (j && j.result && (j.result.msg || j.result.message)) || (j && j.msg) || "未知错误";

// ---------------------------------------------------------------- 取数层
async function loadTeams() {
  const j = await postApi(API_TEAMS, { params: {} });
  if (!okJson(j)) throw new Error("站点列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: String(x.id == null ? x.teamId : x.id),
    name: String(x.team_name || x.teamName || x.name || ("站点 " + (x.id == null ? x.teamId : x.id))),
    orgId: String(x.org_id || x.orgId || ""),
    tenantId: String(x.tenant_id || x.tenantId || ""),
    teamKnightNum: num(x.team_load)
  })).filter((x) => x.id && x.id !== "undefined" && x.id !== "null");
}
/** 时段列表：一次带上全部站点，返回的 current 就是线上按当前时间算出来的时段。 */
async function loadSlots(teamIds) {
  const ids = (teamIds || []).map(num).filter(Boolean);
  const j = await postApi(API_TIMES, { params: { request: { teamIds: ids } } });
  if (!okJson(j)) throw new Error("时段：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    code: num(x.timeCode), name: String(x.timeName || x.timeCode),
    start: String(x.startTime || ""), end: String(x.endTime || ""),
    current: !!x.current
  })).filter((x) => x.code > 0 && !SLOT_IGNORE.includes(x.code));
}
/** 单站当天排班统计：应排 / 实排 / 运力规模，按 timeCode 分开。 */
async function loadStat(team, date) {
  const day = date || todayStr();
  const j = await postApi(API_STAT, {
    metas: { teamid: team.id, orgid: num(team.orgId), tenantid: num(team.tenantId) },
    params: { request: { startDate: day, endDate: day, teamId: String(team.id), orgId: num(team.orgId) } }
  });
  if (!okJson(j)) throw new Error("排班统计：" + msgOf(j));
  const arr = dataOf(j) || [];
  const one = (Array.isArray(arr) ? arr : []).find((x) => String(x.shiftDate || "").slice(0, 10) === day) || arr[0] || {};
  const byCode = Object.create(null);
  for (const t of (one.timeList || [])) {
    byCode[num(t.timeCode)] = {
      predict: num(t.predictNum), actual: num(t.actualNum),
      name: String(t.timeName || ""), start: String(t.startTime || ""), end: String(t.endTime || "")
    };
  }
  return { byCode, teamKnightNum: num(one.teamKnightNum) };
}
/** 单站某时段的骑手表（含未排班的人，用来算在线 / 背单）。 */
async function loadAttendance(team, code) {
  const j = await postApi(API_ATT, {
    metas: { teamid: num(team.id), orgid: num(team.orgId), tenantid: num(team.tenantId) },
    params: { request: { teamId: num(team.id), timeCode: String(code), shiftedOffline: 0, orgId: num(team.orgId) } }
  });
  if (!okJson(j)) throw new Error("实时出勤：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    teamId: String(x.teamId == null ? team.id : x.teamId),
    knightId: num(x.knightId), name: String(x.knightName || ""), mobile: String(x.mobile || ""),
    timeCode: Array.isArray(x.timeCode) ? x.timeCode.map(num) : (x.timeCode == null ? [] : [num(x.timeCode)]),
    timeName: Array.isArray(x.timeName) ? x.timeName.map(String) : (x.timeName ? [String(x.timeName)] : []),
    workStatus: num(x.workStatus), status: num(x.status),
    order: num(x.deliveryOrder),
    onlineTime: num(x.timeOnlineTime), validOnline: num(x.timeValidOnlineTime),
    onlineTarget: num(x.timeOnlineTimeTarget),
    startOnline: num(x.startOnlineTime),
    fullOnline: num(x.fullDayOnlineTime), fullOrder: num(x.fullDayFinishOrder)
  }));
}
/** 并发上限 mapLimit（站点多时别把浏览器同时挂 20 个请求）。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length) || 1).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- 纯函数层（不碰 DOM）
/** "13:30" → 810 */
function timeToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
/** 当前时间落在哪个时段（end 写成 00:00 的按 24:00 算）。 */
function slotAt(slots, date) {
  const list = slots || [];
  if (!list.length) return null;
  const d = date || new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const s of list) {
    const a = timeToMin(s.start);
    let b = timeToMin(s.end);
    if (b <= a) b = 1440;
    if (mins >= a && mins < b) return s;
  }
  return list.find((s) => s.current) || list[list.length - 1];
}
/** 选中的时段：固定某档就用它，否则按当前时间。 */
function pickSlot(slots, mode, date) {
  const list = slots || [];
  if (!list.length) return null;
  if (mode && mode !== "auto") {
    const hit = list.find((s) => String(s.code) === String(mode));
    if (hit) return hit;
  }
  return slotAt(list, date);
}
const slotText = (s) => (s ? `${s.name} ${s.start}~${s.end}` : "");
/** 这一行骑手在本时段有没有排班。 */
function isScheduled(row, code) {
  const c = num(code);
  const codes = Array.isArray(row.timeCode) ? row.timeCode.map(num) : [num(row.timeCode)];
  return codes.includes(c);
}
const isOnline = (row) => num(row.workStatus) === ONLINE_WORK_STATUS;
const ordersOf = (row) => num(row.order == null ? row.deliveryOrder : row.order);
const pct = (a, b) => (num(b) > 0 ? num(a) / num(b) : null);
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const n = Math.round(v * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + "%";
}
/** 单站汇总：应排 / 实排取自排班统计，在线 / 背单 / 异常用实时骑手表算。
 *  v3.29.0：在线只算**本时段排班且在线**的人（未排班但在线的骑手不计入），
 *  否则在线 ÷ 实排 会超过 100%。 */
function siteSummary(team, stat, rows, code) {
  const list = rows || [];
  const sched = list.filter((r) => isScheduled(r, code));
  const online = sched.filter((r) => isOnline(r));                 // 排班在线
  const onlineAll = list.filter((r) => isOnline(r)).length;        // 全站在线（仅展示用）
  const offlineOrder = list.filter((r) => !isOnline(r) && ordersOf(r) > 0);
  const abnormal = sched.filter((r) => !isOnline(r) && ordersOf(r) === 0);
  const cell = (stat && stat.byCode && stat.byCode[num(code)]) || null;
  return {
    teamId: String(team.id), teamName: team.name,
    area: SITE_TO_AREA[String(team.name || "").trim()] || String(team.name || ""),
    应排: num(cell && cell.predict), 实排: num(cell && cell.actual),
    在线: online.length, 下线背单: offlineOrder.length, 异常: abnormal.length,
    骑手数: list.length, 在线全站: onlineAll,
    sched, online, offlineOrder, abnormal, rows: list,
    statOk: !!cell
  };
}
/** 按商圈片聚合。 */
function aggByArea(sites) {
  const map = new Map();
  for (const s of sites || []) {
    const key = s.area || s.teamName;
    if (!map.has(key)) {
      map.set(key, { area: key, sites: [], 应排: 0, 实排: 0, 在线: 0, 下线背单: 0, 异常: 0, 骑手数: 0, 在线全站: 0 });
    }
    const a = map.get(key);
    a.sites.push(s);
    for (const f of ["应排", "实排", "在线", "下线背单", "异常", "骑手数", "在线全站"]) a[f] += num(s[f]);
  }
  const list = [...map.values()];
  for (const a of list) a.rate = pct(a.在线, a.实排);
  list.sort((x, y) => y.异常 - x.异常 || y.应排 - x.应排 || String(x.area).localeCompare(String(y.area), "zh"));
  return list;
}
/** 明细行：异常 / 不在线共用一套字段。
 *  v3.29.1：「本时段在线」列改显示**有效在线**（timeValidOnlineTime ÷ 60），
 *  原始在线（timeOnlineTime）与目标时长只放在悬浮提示里，避免把毛时长当成考核口径。 */
function detailRow(site, row) {
  const online = isOnline(row);
  const rawMin = Math.round(num(row.onlineTime) / 60);
  const validMin = Math.round(num(row.validOnline) / 60);
  const targetMin = Math.round(num(row.onlineTarget) / 60);
  const tip = `本时段有效在线 ${validMin} 分（timeValidOnlineTime）` +
    ` · 原始在线 ${rawMin} 分（timeOnlineTime）` +
    (targetMin > 0 ? ` · 目标 ${targetMin} 分` : "");
  return {
    area: site.area, site: site.teamName, teamId: site.teamId,
    knightId: num(row.knightId), name: String(row.name || ""), mobile: String(row.mobile || ""),
    shifts: (row.timeName || []).join(" / "),
    online, orders: ordersOf(row),
    onlineMin: rawMin, validMin, targetMin, onlineTipText: tip,
    lastOnline: num(row.startOnline) > 0 ? hhmm(new Date(num(row.startOnline))) : "",
    kind: online ? "online" : (ordersOf(row) > 0 ? "offline-order" : "abnormal")
  };
}
/** 从一个站点的汇总里抽出两张明细表。 */
function buildDetails(sites) {
  const abnormal = [], offline = [];
  for (const s of sites || []) {
    for (const r of s.abnormal) abnormal.push(detailRow(s, r));
    for (const r of s.offlineOrder) offline.push(detailRow(s, r));
  }
  const byName = (a, b) => String(a.site).localeCompare(String(b.site), "zh") || a.knightId - b.knightId;
  abnormal.sort((a, b) => String(a.area).localeCompare(String(b.area), "zh") || byName(a, b));
  offline.sort((a, b) => b.orders - a.orders || String(a.area).localeCompare(String(b.area), "zh") || byName(a, b));
  return { abnormal, offline };
}
/** 总计：反过来把商圈片再合一遍。 */
function totals(areas) {
  const t = { 应排: 0, 实排: 0, 在线: 0, 下线背单: 0, 异常: 0, 骑手数: 0, 在线全站: 0 };
  for (const a of areas || []) for (const f of Object.keys(t)) t[f] += num(a[f]);
  t.rate = pct(t.在线, t.实排);
  return t;
}

// ---------------------------------------------------------------- 视图层
function showMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "rt-msg" + (kind ? " " + kind : "");
}
function showNotice(text, kind) {
  const el = $("notice");
  if (!el) return;
  el.textContent = text || "";
  el.className = "notice" + (kind === "bad" ? "" : " blue");
  el.hidden = !text;
}
function selectedTeams() {
  const ids = new Set(state.siteIds.map(String));
  return state.teams.filter((t) => ids.has(String(t.id)));
}
function siteLabel() {
  const sel = selectedTeams();
  if (state.siteAll && state.teams.length) return `全部站点（${state.teams.length}）`;
  if (!sel.length) return state.teams.length ? "选择站点" : "未取到站点";
  if (sel.length === 1) return sel[0].name;
  return `${sel[0].name} 等 ${sel.length} 个站点`;
}
function renderSitePicker() {
  const label = $("site-label");
  if (label) label.textContent = siteLabel();
  const box = $("site-pop-list");
  if (box) {
    const q = String(($("site-search") && $("site-search").value) || "").trim().toLowerCase();
    const draft = new Set(state.siteDraft.map(String));
    const list = state.teams.filter((t) => !q
      || t.name.toLowerCase().includes(q) || String(t.id).includes(q));
    box.innerHTML = list.length
      ? list.map((t) => `<label class="rt-site-row${draft.has(String(t.id)) ? " on" : ""}">` +
        `<input type="checkbox" data-site-id="${esc(t.id)}"${draft.has(String(t.id)) ? " checked" : ""}>` +
        `<span class="sr-name">${esc(t.name)}</span>` +
        `<span class="sr-id">${esc(t.id)}</span></label>`).join("")
      : `<div class="rt-empty">${state.teams.length ? "没有匹配的站点" : "站点没取到，点「立即刷新」重试"}</div>`;
    box.querySelectorAll("input[data-site-id]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const id = String(inp.dataset.siteId);
        const set = new Set(state.siteDraft.map(String));
        if (inp.checked) set.add(id); else set.delete(id);
        state.siteDraft = [...set];
        const row = inp.closest(".rt-site-row");
        if (row) row.classList.toggle("on", inp.checked);
        renderSiteCount();
      });
    });
  }
  renderSiteCount();
}
function renderSiteCount() {
  const el = $("site-pop-count");
  const total = state.teams.length, n = state.siteDraft.length;
  if (el) el.textContent = !total ? "站点没取到，点「立即刷新」重试"
    : (n ? `已选 ${n} / ${total} 个站点` : `未选站点（共 ${total} 个）`);
  const ap = $("site-apply");
  if (ap) ap.disabled = !n || !total;
}
function openSitePop(open) {
  const pop = $("site-pop"), btn = $("site-btn");
  if (!pop) return;
  pop.hidden = !open;
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  state.siteDraft = state.siteAll ? state.teams.map((t) => String(t.id)) : state.siteIds.slice();
  const s = $("site-search");
  if (s) s.value = "";
  renderSitePicker();
}
function renderSlotSelect() {
  const sel = $("rt-slot");
  if (!sel) return;
  const cur = slotAt(state.slots, new Date());
  sel.innerHTML = `<option value="auto">自动（当前：${esc(slotText(cur) || "—")}）</option>` +
    state.slots.map((s) => `<option value="${s.code}">${esc(slotText(s))}</option>`).join("");
  sel.value = state.slotMode === "auto" ? "auto" : String(state.slotMode);
  if (![...sel.options].some((o) => o.value === sel.value)) sel.value = "auto";
}
function activeSlot() {
  return pickSlot(state.slots, state.slotMode, new Date());
}
function renderKpis() {
  const box = $("rt-kpis");
  if (!box) return;
  const t = totals(state.areas);
  const list = [
    ["应排", String(t.应排), "排班需求人数"],
    ["实排", String(t.实排), "实际排班人数"],
    ["在线", String(t.在线), "本时段排班且在线（workStatus=1）的人数；未排班但在线的不计入"],
    ["下线背单", String(t.下线背单), "不在线但背着单"],
    ["在线率", fmtPct(t.rate), "排班在线 ÷ 实排，不会超过 100%"],
    ["异常", String(t.异常), "已排本时段、不在线且 0 背单"]
  ];
  box.innerHTML = list.map(([k, v, tip], i) => `<div class="rt-kpi${i === 5 && t.异常 ? " bad" : ""}" title="${esc(tip)}">` +
    `<b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("") +
    `<div class="rt-kpi meta" title="本次统计的站点数与骑手数"><b>${state.sites.length}</b><span>站点 · ${t.骑手数} 骑手</span></div>`;
}
/** 在线单元格的悬浮说明：说明「只算排班在线」，顺带给出未计入的全站在线人数。 */
function onlineTip(row) {
  const on = num(row.在线), all = num(row.在线全站);
  const extra = all > on ? `；另有 ${all - on} 人未排班但当前在线，未计入` : "";
  return `本时段排班且在线 ${on} 人${extra}`;
}
function rateCell(v) {
  const cls = v == null ? "" : (v < 0.8 ? " bad" : (v < 0.95 ? " warn" : ""));
  const bar = v == null ? "" : `<i style="width:${Math.max(0, Math.min(100, Math.round(v * 100)))}%"></i>`;
  return `<span class="rt-rate${cls}"><span class="rt-rate-txt">${fmtPct(v)}</span><span class="rt-rate-bar">${bar}</span></span>`;
}
function renderAreas() {
  const t = $("rt-areas");
  if (!t) return;
  const head = `<thead><tr><th class="c-idx"></th><th class="c-area">商圈片</th><th class="c-num">站点</th>` +
    `<th class="c-num" title="排班需求人数（listScheduleStatistics 的 predictNum）">应排</th>` +
    `<th class="c-num" title="实际排班人数（listScheduleStatistics 的 actualNum）">实排</th>` +
    `<th class="c-num" title="本时段排班且在线（workStatus=1）的人数；未排班但在线的不计入，所以不会高于实排">在线</th>` +
    `<th class="c-num" title="不在线但手里还有单（deliveryOrder>0）">下线背单</th>` +
    `<th class="c-rate" title="排班在线 ÷ 实排">在线率</th>` +
    `<th class="c-num" title="已排本时段 + 不在线 + 0 背单">异常</th></tr></thead>`;
  if (!state.areas.length) {
    t.innerHTML = head + `<tbody><tr><td colspan="9" class="rt-empty">${state.loading ? "正在取数…" : "还没有数据，点「立即刷新」"}</td></tr></tbody>`;
    return;
  }
  const siteHead = `<tr class="rt-sub-head"><td></td><td colspan="8">` +
    `<span class="rt-sub-title">站点明细</span></td></tr>`;
  const rows = state.areas.map((a) => {
    const open = state.expanded.has(a.area);
    const body = `<tr class="rt-area-row${a.异常 ? " has-bad" : ""}" data-area="${esc(a.area)}">` +
      `<td class="c-idx"><button class="rt-exp" data-area="${esc(a.area)}" title="${open ? "收起" : "展开"}站点明细">${open ? "▾" : "▸"}</button></td>` +
      `<td class="c-area" title="${esc(a.area)}">${esc(a.area)}</td>` +
      `<td class="c-num">${a.sites.length}</td>` +
      `<td class="c-num">${a.应排}</td><td class="c-num">${a.实排}</td>` +
      `<td class="c-num" title="${esc(onlineTip(a))}">${a.在线}</td>` +
      `<td class="c-num">${a.下线背单}</td><td class="c-rate">${rateCell(a.rate)}</td>` +
      `<td class="c-num${a.异常 ? " bad" : ""}">${a.异常}</td></tr>`;
    if (!open) return body;
    const subs = a.sites.slice().sort((x, y) => y.异常 - x.异常 || y.应排 - x.应排).map((s) =>
      `<tr class="rt-site-row2">` +
      `<td class="c-idx"></td>` +
      `<td class="c-area" title="${esc(s.teamName)}">${esc(s.teamName)}</td>` +
      `<td class="c-num">—</td>` +
      `<td class="c-num">${s.statOk ? s.应排 : "—"}</td><td class="c-num">${s.statOk ? s.实排 : "—"}</td>` +
      `<td class="c-num" title="${esc(onlineTip(s))}">${s.在线}</td><td class="c-num">${s.下线背单}</td>` +
      `<td class="c-rate">${rateCell(pct(s.在线, s.实排))}</td>` +
      `<td class="c-num${s.异常 ? " bad" : ""}">${s.异常}</td></tr>`).join("");
    return body + subs;
  }).join("");
  const tot = totals(state.areas);
  const foot = `<tr class="rt-total"><td></td><td>合计</td><td class="c-num">${state.sites.length}</td>` +
    `<td class="c-num">${tot.应排}</td><td class="c-num">${tot.实排}</td>` +
    `<td class="c-num" title="${esc(onlineTip(tot))}">${tot.在线}</td>` +
    `<td class="c-num">${tot.下线背单}</td><td class="c-rate">${rateCell(tot.rate)}</td>` +
    `<td class="c-num${tot.异常 ? " bad" : ""}">${tot.异常}</td></tr>`;
  t.innerHTML = head + `<tbody>${rows}${foot}</tbody>`;
  t.querySelectorAll("button.rt-exp").forEach((b) => {
    b.addEventListener("click", () => {
      const k = b.dataset.area;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      renderAreas();
    });
  });
}
function detailHead(first) {
  return `<thead><tr><th class="c-site">站点</th><th class="c-area">商圈片</th><th class="c-name">骑手</th>` +
    `<th class="c-mobile">手机号</th><th class="c-shift">排班时段</th>` +
    (first ? `<th class="c-num">背单</th>` : "") +
    `<th class="c-num" title="本时段有效在线时长（timeValidOnlineTime，剔除无效在线）；悬浮单个单元格可看原始在线时长与目标时长">有效在线</th>` +
    `<th class="c-num">最近上线</th><th class="c-state">状态</th></tr></thead>`;
}
function renderDetails() {
  const ta = $("rt-abnormal"), to = $("rt-offline");
  const ca = $("rt-abnormal-count"), co = $("rt-offline-count");
  if (ca) ca.textContent = `${state.abnormal.length} 人`;
  if (co) co.textContent = `${state.offline.length} 人`;
  if (ta) {
    ta.innerHTML = detailHead(false) + `<tbody>` + (state.abnormal.length
      ? state.abnormal.map((r) => `<tr>` +
        `<td class="c-site" title="${esc(r.site)}">${esc(r.site.replace(/^福州/, "").replace(/-UB$/, ""))}</td>` +
        `<td class="c-area" title="${esc(r.area)}">${esc(r.area)}</td>` +
        `<td class="c-name">${esc(r.name || "未命名")}<em>${esc(r.knightId)}</em></td>` +
        `<td class="c-mobile">${esc(r.mobile)}</td>` +
        `<td class="c-shift" title="${esc(r.shifts)}">${esc(r.shifts || "—")}</td>` +
        `<td class="c-num" title="${esc(r.onlineTipText)}">${r.validMin} 分</td>` +
        `<td class="c-num">${esc(r.lastOnline || "—")}</td>` +
        `<td class="c-state bad">异常 · 0 背单不在线</td></tr>`).join("")
      : `<tr><td colspan="8" class="rt-empty">${state.loading ? "正在取数…" : "本时段没有异常骑手 🎉"}</td></tr>`) + `</tbody>`;
  }
  if (to) {
    to.innerHTML = detailHead(true) + `<tbody>` + (state.offline.length
      ? state.offline.map((r) => `<tr>` +
        `<td class="c-site" title="${esc(r.site)}">${esc(r.site.replace(/^福州/, "").replace(/-UB$/, ""))}</td>` +
        `<td class="c-area" title="${esc(r.area)}">${esc(r.area)}</td>` +
        `<td class="c-name">${esc(r.name || "未命名")}<em>${esc(r.knightId)}</em></td>` +
        `<td class="c-mobile">${esc(r.mobile)}</td>` +
        `<td class="c-shift" title="${esc(r.shifts)}">${esc(r.shifts || "—")}</td>` +
        `<td class="c-num warn">${r.orders}</td>` +
        `<td class="c-num" title="${esc(r.onlineTipText)}">${r.validMin} 分</td>` +
        `<td class="c-num">${esc(r.lastOnline || "—")}</td>` +
        `<td class="c-state warn">下线背单</td></tr>`).join("")
      : `<tr><td colspan="9" class="rt-empty">${state.loading ? "正在取数…" : "本时段没有下线背单的骑手"}</td></tr>`) + `</tbody>`;
  }
}
function renderTimer() {
  const el = $("rt-timer");
  if (el) {
    el.textContent = state.auto
      ? (state.countdown > 0 ? `${state.countdown}s 后刷新` : "即将刷新…")
      : "自动刷新已暂停";
    el.className = "rt-timer" + (state.auto ? "" : " paused");
  }
  const b = $("btn-auto");
  if (b) b.textContent = state.auto ? "暂停" : "继续";
}
function renderStatus() {
  const sub = $("sub");
  if (sub) {
    const bits = [];
    bits.push("站点 " + siteLabel());
    const slot = activeSlot();
    if (slot) bits.push(`时段 ${slotText(slot)}`);
    bits.push(state.loading ? "取数中…" : `更新 ${state.lastAt ? hhmmss(state.lastAt) : "—"}`);
    bits.push("通道 " + (state.via === "bridge" ? "静默桥接" : "直连"));
    sub.textContent = bits.join(" · ");
  }
  const ch = $("btn-channel");
  if (ch) ch.textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  const stamp = $("rt-stamp");
  if (stamp) stamp.textContent = state.lastAt ? `数据时间 ${hhmmss(state.lastAt)}` : "";
  const hint = $("rt-scope-hint");
  if (hint) {
    const slot = activeSlot();
    hint.textContent = `${siteLabel()} · ${slot ? slotText(slot) : "—"} · 按商圈片汇总，在线只算排班在线，点行首箭头展开站点明细`;
  }
  const foot = $("foot-meta");
  if (foot) {
    foot.textContent = `数据源：getTeamsAll / listCustomTime / listScheduleStatistics / listAttendance` +
      ` · 刷新间隔 ${state.gap}s · ${state.auto ? "自动刷新中" : "已暂停"} · 生成 ${hhmmss(new Date())}`;
  }
}
function renderAll() {
  renderSitePicker();
  renderSlotSelect();
  renderKpis();
  renderAreas();
  renderDetails();
  renderTimer();
  renderStatus();
}

// ---------------------------------------------------------------- 刷新
/** 单站排班统计按 5 分钟缓存：应排 / 实排不会 30 秒一变，省一半请求。 */
async function statFor(team, date) {
  const key = `${team.id}|${date}`;
  const hit = state.statCache.get(key);
  if (hit && Date.now() - hit.at < STAT_TTL) return hit.value;
  const value = await loadStat(team, date);
  state.statCache.set(key, { at: Date.now(), value });
  return value;
}
async function refresh(opts) {
  const o = opts || {};
  if (state.loading) return { skipped: true };
  const seq = ++state.seq;
  state.loading = true;
  state.errors = [];
  state.countdown = state.gap;
  renderStatus();
  renderTimer();
  if (!o.silent) showMsg("rt-msg", "正在取数…", "info");
  try {
    if (!state.teams.length) {
      state.teams = await loadTeams();
      if (state.siteAll) state.siteIds = state.teams.map((t) => String(t.id));
      else state.siteIds = state.siteIds.filter((id) => state.teams.some((t) => String(t.id) === String(id)));
      if (!state.siteIds.length) { state.siteAll = true; state.siteIds = state.teams.map((t) => String(t.id)); }
    }
    const teams = selectedTeams();
    if (!state.slots.length) state.slots = await loadSlots(teams.map((t) => t.id));
    const slot = activeSlot();
    if (!slot) throw new Error("没取到时段列表");
    state.slotCode = String(slot.code);
    const day = todayStr();
    const results = await mapLimit(teams, CONCURRENCY, async (team) => {
      let stat = null, rows = [], errs = [];
      try { stat = await statFor(team, day); } catch (e) { errs.push("排班统计 " + String(e && e.message ? e.message : e)); }
      try { rows = await loadAttendance(team, slot.code); } catch (e) { errs.push("实时出勤 " + String(e && e.message ? e.message : e)); }
      if (seq !== state.seq) return null;
      const sum = siteSummary(team, stat, rows, slot.code);
      sum.err = errs.join("；");
      return sum;
    });
    if (seq !== state.seq) return { stale: true };
    state.sites = results.filter(Boolean);
    state.areas = aggByArea(state.sites);
    const det = buildDetails(state.sites);
    state.abnormal = det.abnormal;
    state.offline = det.offline;
    state.errors = state.sites.filter((s) => s.err).map((s) => `${s.teamName}（${s.err}）`);
    state.lastAt = new Date();
    state.loading = false;
    renderAll();
    const t = totals(state.areas);
    if (state.errors.length) {
      showMsg("rt-msg", `已刷新，但有 ${state.errors.length} 个站点没取到：${state.errors.slice(0, 3).join("；")}`, "error");
    } else {
      showMsg("rt-msg", `已刷新 ${state.sites.length} 个站点 · 应排 ${t.应排} / 实排 ${t.实排} / 在线 ${t.在线} / 异常 ${t.异常}`, "success");
    }
    return { ok: true, totals: t };
  } catch (e) {
    state.loading = false;
    const msg = String(e && e.message ? e.message : e);
    showNotice("实时出勤取数失败：" + msg + "（可点「立即刷新」重试，或切到静默桥接）", "bad");
    showMsg("rt-msg", "取数失败：" + msg, "error");
    renderAll();
    return { ok: false, msg };
  }
}

// ---------------------------------------------------------------- 定时器
function startTimer() {
  stopTimer();
  state.countdown = state.gap;
  state.timer = setInterval(tick, 1000);
  renderTimer();
}
function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
function tick() {
  if (!state.auto) return;
  state.countdown -= 1;
  if (state.countdown <= 0) {
    state.countdown = state.gap;
    refresh({ silent: true });
  }
  renderTimer();
}
function setGap(sec) {
  const v = Math.floor(num(sec));
  state.gap = Math.min(MAX_GAP, Math.max(MIN_GAP, v || DEFAULT_GAP));
  try { localStorage.setItem(LS_GAP, String(state.gap)); } catch (e) { /* ignore */ }
  const el = $("rt-gap");
  if (el && num(el.value) !== state.gap) el.value = state.gap;
  state.countdown = state.gap;
  renderTimer();
  renderStatus();
}
function setAuto(on) {
  state.auto = !!on;
  if (state.auto) startTimer(); else stopTimer();
  renderTimer();
  renderStatus();
  const b = $("btn-auto");
  if (b) b.className = "ghost" + (state.auto ? "" : " active");
}
function saveSites() {
  try {
    localStorage.setItem(LS_SITES, JSON.stringify({ ids: state.siteIds, all: state.siteAll }));
    localStorage.setItem(LS_SLOT, String(state.slotMode));
  } catch (e) { /* ignore */ }
}
function loadOpts() {
  try {
    const g = num(localStorage.getItem(LS_GAP));
    state.gap = g >= MIN_GAP && g <= MAX_GAP ? g : DEFAULT_GAP;
  } catch (e) { state.gap = DEFAULT_GAP; }
  try {
    const o = JSON.parse(localStorage.getItem(LS_SITES) || "null");
    if (o && Array.isArray(o.ids)) {
      state.siteIds = o.ids.map(String);
      state.siteAll = !!o.all;
    }
  } catch (e) { /* ignore */ }
  try {
    const s = localStorage.getItem(LS_SLOT);
    if (s) state.slotMode = s === "auto" ? "auto" : String(s);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 一键复制图片
/** 出图文件名：风神实时出勤_20261111_1543_下午茶1.png（时段名去掉括号里的时间，避免文件名太长）。 */
function shotName() {
  const d = state.lastAt || new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const slot = activeSlot();
  const slotName = slot ? String(slot.name || slot.code || "").replace(/[\/:*?"<>|\s]+/g, "") : "";
  return `风神实时出勤_${stamp}${slotName ? "_" + slotName : ""}.png`;
}
/** 把当前画面（KPI + 商圈片表 + 两张明细表 + 口径说明）导出成 PNG：
 *  优先写系统剪贴板，按住 Shift 或剪贴板不可用时自动另存为 PNG 文件。 */
async function copyImage(e) {
  const btn = $("btn-copy");
  if (btn && btn.disabled) return;
  if (!window.WB_CAPTURE) {
    showNotice("图片模块没加载：请在 chrome://extensions 重新加载扩展，或安装新版 zip。", "bad");
    return;
  }
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "正在生成图片…"; }
  const name = shotName();
  try {
    const r = await window.WB_CAPTURE.capture({
      download: !!(e && e.shiftKey), rootId: "rt-wrap", filename: name
    });
    const size = `${r.width}×${r.height}`;
    showNotice(r.mode === "clipboard"
      ? `已复制实时出勤图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`
      : r.mode === "download"
        ? `实时出勤图片已另存为 PNG（${size}）。`
        : `当前环境不允许写剪贴板，已自动下载 PNG 图片（${size}）。`, "blue");
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}`, "bad");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------------------------------------------------------------- 事件
function bind() {
  $("site-btn").addEventListener("click", () => {
    const pop = $("site-pop");
    openSitePop(!!(pop && pop.hidden));
  });
  $("site-search").addEventListener("input", renderSitePicker);
  $("site-all").addEventListener("click", () => {
    state.siteDraft = state.teams.map((t) => String(t.id));
    renderSitePicker();
  });
  $("site-none").addEventListener("click", () => {
    state.siteDraft = [];
    renderSitePicker();
  });
  $("site-apply").addEventListener("click", async () => {
    const ids = state.siteDraft.map(String).filter(Boolean);
    if (!ids.length) { showNotice("至少选一个站点", "bad"); return; }
    state.siteIds = ids;
    state.siteAll = ids.length === state.teams.length;
    saveSites();
    openSitePop(false);
    state.expanded.clear();
    renderAll();
    await refresh();
  });
  document.addEventListener("click", (e) => {
    const pick = $("site-pick"), pop = $("site-pop");
    if (!pick || !pop || pop.hidden) return;
    if (!pick.contains(e.target)) openSitePop(false);
  });
  $("rt-slot").addEventListener("change", (e) => {
    state.slotMode = e.target.value === "auto" ? "auto" : String(e.target.value);
    saveSites();
    renderAll();
    refresh({ silent: true });
  });
  $("btn-refresh").addEventListener("click", () => refresh());
  $("btn-copy").addEventListener("click", (e) => copyImage(e));
  $("rt-gap").addEventListener("change", (e) => setGap(e.target.value));
  $("rt-gap").addEventListener("blur", (e) => setGap(e.target.value));
  $("btn-auto").addEventListener("click", () => setAuto(!state.auto));
  $("btn-channel").addEventListener("click", async () => {
    state.via = state.via === "direct" ? "bridge" : "direct";
    try { localStorage.setItem("wb_via", state.via); } catch (e) { /* ignore */ }
    renderStatus();
    showNotice(state.via === "bridge"
      ? "已切到「静默桥接」：后台标签页取数，不打断浏览。"
      : "已切回「直连」：由插件页面直接请求接口。", state.via === "bridge" ? "blue" : "bad");
    await refresh({ silent: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTimer();
    } else if (state.auto) {
      startTimer();
      refresh({ silent: true });
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const n = $("notice"); if (n) n.hidden = true;
      openSitePop(false);
    }
  });
}

// ---------------------------------------------------------------- 测试挂钩
window.__SET_RT__ = (o) => {
  o = o || {};
  if (Array.isArray(o.teams)) state.teams = o.teams.map((t) => ({
    id: String(t.id), name: String(t.name || t.team_name || t.id),
    orgId: String(t.orgId || t.org_id || "31020276"), tenantId: String(t.tenantId || t.tenant_id || "31020276")
  }));
  if (Array.isArray(o.slots)) state.slots = o.slots.map((s) => ({
    code: num(s.code == null ? s.timeCode : s.code), name: String(s.name || s.timeName || ""),
    start: String(s.start || s.startTime || ""), end: String(s.end || s.endTime || ""), current: !!s.current
  }));
  if (Array.isArray(o.siteIds)) { state.siteIds = o.siteIds.map(String); state.siteAll = false; }
  if (o.siteAll != null) state.siteAll = !!o.siteAll;
  if (Array.isArray(o.sites)) {
    state.sites = o.sites.map((s) => ({ statOk: true, ...s }));
    state.areas = aggByArea(state.sites);
    const det = buildDetails(state.sites);
    state.abnormal = det.abnormal;
    state.offline = det.offline;
  }
  if (o.slotMode) state.slotMode = String(o.slotMode);
  if (o.gap != null) state.gap = num(o.gap) || DEFAULT_GAP;
  if (o.lastAt) state.lastAt = new Date(o.lastAt);
  if (!state.teams.length) return;
  if (state.siteAll || !state.siteIds.length) state.siteIds = state.teams.map((t) => String(t.id));
  state.siteDraft = state.siteIds.slice();
  state.lastAt = state.lastAt || new Date();
  renderAll();
};
window.__RT__ = {
  state, postApi, loadTeams, loadSlots, loadStat, loadAttendance, mapLimit,
  timeToMin, slotAt, pickSlot, slotText, isScheduled, isOnline, ordersOf, pct, fmtPct,
  siteSummary, aggByArea, detailRow, buildDetails, totals, statFor, refresh,
  startTimer, stopTimer, tick, setGap, setAuto, saveSites, loadOpts, renderAll, renderAreas, renderDetails,
  copyImage, shotName,
  selectedTeams, siteLabel, activeSlot, SITE_TO_AREA, DEFAULT_GAP, MIN_GAP, MAX_GAP, STAT_TTL,
  CONCURRENCY, ONLINE_WORK_STATUS, LS_GAP, LS_SITES, LS_SLOT,
  API_TEAMS, API_TIMES, API_STAT, API_ATT
};

(async function init() {
  loadOpts();
  bind();
  const g = $("rt-gap");
  if (g) g.value = state.gap;
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  renderAll();
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) {
    await refresh();
    startTimer();
  } else {
    renderTimer();
  }
})();
