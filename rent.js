/* 物资租用（v3.21.0，第五个独立入口；v3.22.0 加表格导入批量执行 + 本月可绑定导出）
 *
 * 复刻原 FengshenMonitor「物资租用登记」：站点 → 物资类型（电动车 / 住宿）→ 骑手 → 开始/结束日期。
 * 数据源（全部沿用原插件接口，不新增后端）：
 *   getTeamsAll                 站点列表
 *   knightRentPizza.queryRentType       物资类型 [{id,name}]
 *   knightRentPizza.queryTeamKnightInfo 站点骑手 [{teamId,knightId,knightName,mobile}]
 *   knightRentPizza.createRent          登记，固定 rentType=2
 *   ehr/staff/knight/list       人资名单（departmentId=站点 id），带 entryTime / leaveTime / workStatus
 *
 * 租用登记与「装备领用」的区别：领用走 rentType=1、只有 startTime、需要 typeId+categoryId；
 * 租用走 rentType=2、有 startTime + endTime、只需要 categoryId。这里只做租用。
 *
 * 提交会真实写入租用单：单条与批量都先二次确认；批量每条间隔 150ms，
 * 成功 / 失败逐条记入本机「最近提交」，方便事后核对。所有取数与提交都走
 * 「直连优先、失败切静默桥接」的既有双通道，不写任何共享缓存。
 *
 * v3.22.0 两个新增：
 *   1) 批量执行（表格导入）：CSV / XLSX / 直接粘贴都能识别，逐行匹配骑手与物资类型，
 *      预览里标出每行的校验结果，只执行通过的行。模板表头固定 7 列。
 *   2) 本月可绑定日期：用「人资名单的入职 / 离职时间 × 本月日历」算出每位骑手哪天能绑定
 *      （入职前、离职后、今天之前都不能绑），页面画条形图，另可导出日历矩阵 / 逐日明细 CSV。
 *      注意：服务端没有开放「已有租用单查询」接口，所以这里只按在职区间算，
 *      不代表该日期一定没被别的租用单占用。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const API_TYPES = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryRentType/1.0";
const API_KNIGHTS = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryTeamKnightInfo/1.0";
const API_CREATE = XT + "xtop.knight.task.mng.growth.knightRentPizza.createRent/1.0";
const API_STAFF = "https://app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list";

const RENT_TYPE = 2;                 // 2 = 物资租用（1 = 装备领用，本页不用）
const BATCH_GAP_MS = 150;            // 批量提交间隔，与原插件一致
const STAFF_PAGE_SIZE = 500;         // 人资名单每页条数（运力模块实测可用）
const STAFF_MAX_PAGES = 6;           // 单站点最多翻 6 页 = 3000 人，防异常翻页
const IMPORT_MAX_ROWS = 200;         // 一次导入最多执行 200 行
const LS_SITE = "wb_rent_site";
const LS_HISTORY = "wb_rent_history";
const LS_BIND = "wb_rent_bind";
const HISTORY_MAX = 100;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateStrOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStrOf(new Date());
const shiftDate = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return dateStrOf(new Date(y, m - 1, d + days));
};
const hhmm = (d) => d.toTimeString().slice(0, 5);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 把各种写法归一成 YYYY-MM-DD：2026-11-01 / 2026/11/1 / 2026.11.1 / 20261101 /
 *  2026-11-01 00:00:00 / Excel 序列号（45000 这种）。认不出来返回空串。 */
function ymd(v) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  let m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s);
  if (m) {
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return `${m[1]}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    }
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {           // Excel 日期序列号
    const n = Math.round(Number(s));
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return "";
}
const curMonth = () => todayStr().slice(0, 7);
/** 某月全部日期（YYYY-MM-DD 数组） */
function monthDays(month) {
  const [y, m] = String(month || curMonth()).split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return out;
}
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const weekdayOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY[new Date(y, m - 1, d).getDay()];
};

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  teams: [], types: [], knights: [],
  siteId: localStorage.getItem(LS_SITE) || "",
  siteName: "",
  selected: new Set(),
  history: [],
  submitting: false,
  loading: false,
  errors: [],
  finishedAt: null,
  roster: [],                 // 当前站点人资名单（含离职），带 entry / leave
  rosterAt: null,
  rosterErr: "",
  rosterLoading: false,
  rosterSeq: 0,               // 站点切换防串号：只认最后一次请求的结果
  bindMonth: curMonth(),
  bindScope: "site",
  bindLeft: false,
  bindRowsCache: [],
  importRows: [],             // [{line,name,mobile,knightId,...,res:{ok,err,...},done,result}]
  importName: ""
};

function extMsg(msg) {
  try { return chrome.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}

// ---------------------------------------------------------------- 双通道请求
async function bridgeApi(api, payload) {
  const resp = await extMsg({ type: "BRIDGE_API", api, payload });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}
/** 直连优先；CORS / 登录态 / 网络失败自动切静默桥接。测试可用 __RENT_MOCK__ 完全接管。 */
async function postApi(api, payload) {
  if (typeof window.__RENT_MOCK__ === "function") return await window.__RENT_MOCK__(api, payload);
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

/** GET 类接口（人资名单）走 BRIDGE_GET；直连优先，失败切静默桥接。 */
async function getApi(url) {
  if (typeof window.__RENT_GET_MOCK__ === "function") return await window.__RENT_GET_MOCK__(url);
  if (state.via === "bridge") return await bridgeGet(url);
  try {
    const r = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return await bridgeGet(url);
  }
}
async function bridgeGet(url) {
  const resp = await extMsg({ type: "BRIDGE_GET", api: url });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}

// ---------------------------------------------------------------- 取数
async function loadTeams() {
  const j = await postApi(API_TEAMS, { params: {} });
  if (!okJson(j)) throw new Error("站点列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: String(x.id == null ? x.teamId : x.id),
    name: String(x.team_name || x.teamName || x.name || ("站点 " + (x.id == null ? x.teamId : x.id)))
  })).filter((x) => x.id && x.id !== "undefined" && x.id !== "null");
}
async function loadTypes() {
  const j = await postApi(API_TYPES, { params: {} });
  if (!okJson(j)) throw new Error("物资类型：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.id), name: String(x.name || x.id)
  })).filter((x) => x.id > 0);
}
async function loadKnights(siteId) {
  const j = await postApi(API_KNIGHTS, {
    params: { goodsBusinessRentKnightInfoDto: { teamId: num(siteId) } }
  });
  if (!okJson(j)) throw new Error("骑手列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.knightId),
    name: String(x.knightName || ""),
    mobile: String(x.mobile || ""),
    teamId: num(x.teamId) || num(siteId)
  })).filter((x) => x.id > 0);
}
/** 人资名单（成员管理 · 全部状态）：departmentId 就是站点 id，返回带入职 / 离职时间。
 *  同一骑士可能有多条记录（换站 / 复职），按 knightId 去重，优先在职、再取最晚入职。 */
async function loadRoster(teamId, teamName) {
  const out = [];
  for (let p = 1; p <= STAFF_MAX_PAGES; p++) {
    const url = `${API_STAFF}?pageIndex=${p}&pageSize=${STAFF_PAGE_SIZE}&departmentId=${encodeURIComponent(teamId)}`;
    const j = await getApi(url);
    const code = String((j && (j.code || j.err_code)) || "");
    if (code !== "200") throw new Error("人资名单：" + ((j && j.msg) || "接口返回异常"));
    const d = (j && j.data) || {};
    const list = Array.isArray(d.list) ? d.list : [];
    out.push(...list);
    if (!list.length || list.length < STAFF_PAGE_SIZE || (num(d.count) && out.length >= num(d.count))) break;
  }
  const byId = new Map();
  for (const x of out) {
    const id = num(x.knightId || x.id);
    if (!(id > 0)) continue;
    const rec = {
      id,
      name: String(x.staffName || x.knightName || ""),
      mobile: String(x.mobile || ""),
      entry: ymd(x.entryTime),
      leave: ymd(x.leaveTime),
      status: num(x.workStatus) === 1 ? "在职" : (ymd(x.leaveTime) ? "已离职" : "其他"),
      teamId: String(teamId),
      teamName: String(teamName || "")
    };
    const prev = byId.get(id);
    if (!prev) { byId.set(id, rec); continue; }
    const better = (rec.status === "在职" && prev.status !== "在职") ||
      (rec.status === prev.status && rec.entry > prev.entry);
    if (better) byId.set(id, rec);
  }
  return [...byId.values()];
}
/** 站点接口失败时的兜底：复用看板记住的站点 ID，至少还能切换（名称显示为 ID）。 */
function fallbackTeams() {
  try {
    const arr = JSON.parse(localStorage.getItem("wb_team_ids_v1") || "[]");
    return (Array.isArray(arr) ? arr : []).map((id) => ({ id: String(id), name: "站点 " + id }));
  } catch (e) { return []; }
}

// ---------------------------------------------------------------- 渲染
function currentTeam() {
  return state.teams.find((t) => String(t.id) === String(state.siteId)) || null;
}
function currentKnight(id) {
  return state.knights.find((k) => Number(k.id) === Number(id)) || null;
}
function typeName(id) {
  const t = state.types.find((x) => Number(x.id) === Number(id));
  return t ? t.name : String(id || "");
}
function showMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "rent-msg" + (kind ? " " + kind : "");
}
function showNotice(text, kind) {
  const el = $("notice");
  if (!el) return;
  el.textContent = text || "";
  el.className = "notice" + (kind === "bad" ? "" : " blue");
  el.hidden = !text;
}
function renderSites() {
  const sel = $("site-select");
  if (!sel) return;
  if (!state.teams.length) {
    sel.innerHTML = `<option value="">未取到站点</option>`;
    return;
  }
  sel.innerHTML = state.teams.map((t) =>
    `<option value="${esc(t.id)}"${String(t.id) === String(state.siteId) ? " selected" : ""}>${esc(t.name)}</option>`
  ).join("");
}
function renderTypes() {
  const opts = state.types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  for (const id of ["one-type", "batch-type"]) {
    const el = $(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = opts || `<option value="">未取到物资类型</option>`;
    if (prev && state.types.some((t) => String(t.id) === String(prev))) el.value = prev;
  }
}
function knightLabel(k) {
  return k.name + (k.mobile ? " · " + k.mobile : "") + "（" + k.id + "）";
}
function renderKnightSelect() {
  const sel = $("one-knight");
  if (!sel) return;
  const q = String($("one-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  const prev = sel.value;
  sel.innerHTML = `<option value="">请选择骑手（${list.length} 人）</option>` +
    list.map((k) => `<option value="${k.id}">${esc(knightLabel(k))}</option>`).join("");
  if (prev && list.some((k) => String(k.id) === String(prev))) sel.value = prev;
}
function renderBatchList() {
  const box = $("batch-list");
  if (!box) return;
  const q = String($("batch-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="rent-empty">${state.knights.length ? "没有匹配的骑手" : "当前站点暂无骑手"}</div>`;
    updateBatchCount();
    return;
  }
  box.innerHTML = list.map((k) => {
    const on = state.selected.has(k.id);
    return `<label class="rent-check${on ? " checked" : ""}">` +
      `<input type="checkbox" data-knight-id="${k.id}"${on ? " checked" : ""}>` +
      `<span class="rc-name">${esc(k.name || "未命名")}</span>` +
      `<span class="rc-meta">${esc(k.id)}${k.mobile ? " · " + esc(k.mobile) : ""}</span></label>`;
  }).join("");
  box.querySelectorAll("input[data-knight-id]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = num(inp.dataset.knightId);
      if (inp.checked) state.selected.add(id); else state.selected.delete(id);
      const lab = inp.closest(".rent-check");
      if (lab) lab.classList.toggle("checked", inp.checked);
      updateBatchCount();
    });
  });
  updateBatchCount();
}
function updateBatchCount() {
  const el = $("batch-count");
  if (el) el.textContent = `已选 ${state.selected.size} 人`;
  const btn = $("batch-submit");
  if (btn) btn.disabled = state.submitting || state.selected.size === 0;
}
function renderKpis() {
  const box = $("rent-kpis");
  if (!box) return;
  const ok = state.history.filter((h) => h.ok).length;
  const bad = state.history.length - ok;
  box.innerHTML = [
    ["当前站点", currentTeam() ? currentTeam().name : "—"],
    ["站点数", String(state.teams.length)],
    ["当前站点骑手", String(state.knights.length)],
    ["物资类型", String(state.types.length)],
    ["本机登记成功", String(ok)],
    ["本机登记失败", String(bad)]
  ].map(([k, v]) => `<div class="rent-kpi"><b title="${esc(v)}">${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
}
function renderStatus() {
  const sub = $("sub");
  if (sub) {
    const bits = [];
    if (state.siteName) bits.push("站点 " + state.siteName);
    bits.push("骑手 " + state.knights.length);
    bits.push("物资 " + state.types.length);
    bits.push("更新 " + hhmm(state.finishedAt || new Date()));
    bits.push("通道 " + (state.via === "bridge" ? "静默桥接" : "直连"));
    sub.textContent = bits.join(" · ");
  }
  const ch = $("btn-channel");
  if (ch) ch.textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  const foot = $("foot-meta");
  if (foot) {
    foot.textContent = `数据源：getTeamsAll / queryRentType / queryTeamKnightInfo / createRent（rentType=${RENT_TYPE}）` +
      ` / ehr/staff/knight/list（本月可绑定）` +
      ` · 生成 ${hhmm(state.finishedAt || new Date())} · 本机记录 ${state.history.length} 条`;
  }
}
function renderHistory() {
  const t = $("history-table");
  if (!t) return;
  const head = `<thead><tr><th style="width:88px">时间</th><th style="width:180px">站点</th>` +
    `<th style="width:150px">骑手</th><th style="width:96px">物资</th><th style="width:60px">数量</th>` +
    `<th style="width:104px">开始</th><th style="width:104px">结束</th><th>结果</th></tr></thead>`;
  const rows = state.history.slice(0, 20);
  const body = rows.length ? rows.map((h) => {
    const d = new Date(h.at);
    const time = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(d)}`;
    return `<tr><td>${esc(time)}</td><td class="name" title="${esc(h.site)}">${esc(h.site)}</td>` +
      `<td class="name" title="${esc(h.knightName)}（${esc(h.knightId)}）">${esc(h.knightName)}</td>` +
      `<td>${esc(h.typeName)}</td><td>${esc(h.num)}</td><td>${esc(h.start)}</td><td>${esc(h.end)}</td>` +
      `<td class="${h.ok ? "ok" : "bad"}" title="${esc(h.msg || "")}">${h.ok ? "成功" : "失败"}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="rent-empty">还没有提交记录</td></tr>`;
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}
// ---------------------------------------------------------------- 本月可绑定日期
const BIND_LABEL = { ok: "可绑定", past: "已过期", before: "未入职", after: "已离职" };

/** 单日状态：入职前 / 离职后 / 今天之前都不可绑定，其余可绑定（离职当日仍算可绑定）。 */
function bindState(rec, day, today) {
  if (rec.entry && day < rec.entry) return "before";
  if (rec.leave && day > rec.leave) return "after";
  if (day < today) return "past";
  return "ok";
}
/** 按人资名单算「谁在本月哪天可绑定」。默认只留本月还有可绑定日的人，勾了「含已离职」则本月在职过的都留。 */
function computeBind(list, month, includeLeft) {
  const days = monthDays(month);
  const first = days[0], last = days[days.length - 1];
  const today = todayStr();
  const out = [];
  for (const rec of list || []) {
    const inMonth = (!rec.entry || rec.entry <= last) && (!rec.leave || rec.leave >= first);
    if (includeLeft ? !inMonth : false) continue;
    const cells = days.map((d) => bindState(rec, d, today));
    const okDays = days.filter((d, i) => cells[i] === "ok");
    if (!includeLeft && !okDays.length) continue;
    out.push({ ...rec, cells, okDays });
  }
  out.sort((a, b) => b.okDays.length - a.okDays.length || String(a.name).localeCompare(String(b.name), "zh"));
  return out;
}
function bindRows(month, includeLeft, list) {
  return computeBind(list || state.roster, month || state.bindMonth, !!includeLeft);
}
function renderBind() {
  const month = state.bindMonth;
  const days = monthDays(month);
  const rows = bindRows(month, state.bindLeft);
  state.bindRowsCache = rows;
  const sum = $("bind-sum");
  if (sum) {
    if (state.rosterLoading) sum.innerHTML = `<span class="rent-msg info">正在读取人资名单…</span>`;
    else if (state.rosterErr) {
      sum.innerHTML = `<span class="rent-msg error">人资名单没取到：${esc(state.rosterErr)}</span>` +
        ` <button id="bind-retry" class="ghost" style="height:24px;padding:0 10px;">重试</button>`;
      const rb = $("bind-retry");
      if (rb) rb.addEventListener("click", () => loadRosterInto());
    } else {
      const okDays = rows.reduce((s, r) => s + r.okDays.length, 0);
      const people = rows.filter((r) => r.okDays.length).length;
      const left = rows.filter((r) => r.leave && r.leave >= todayStr()).length;
      sum.innerHTML = `<b>${people}</b> 人本月还有可绑定日 · 合计 <b>${okDays}</b> 个可绑定人日` +
        (left ? ` · <b>${left}</b> 人本月离职` : "") +
        `<span class="rent-hint">（名单 ${state.roster.length} 人，含已离职；只按在职区间算，未含服务端已有租用单）</span>`;
    }
  }
  const box = $("bind-rows");
  if (!box) return;
  if (state.rosterLoading) {
    box.innerHTML = `<div class="rent-empty">正在读取人资名单…</div>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<div class="rent-empty">${state.rosterErr ? "人资名单没取到，先点「重试」" : "本月没有可绑定的骑手"}</div>`;
    return;
  }
  const head = `<div class="bind-row head">` +
    `<span>骑手</span><span>入职</span><span>离职</span><span>可绑定</span>` +
    `<span class="bind-bar">${days.map((d) => `<i>${Number(d.slice(-2))}</i>`).join("")}</span></div>`;
  const body = rows.slice(0, 80).map((r) => {
    const tip = r.okDays.length ? `${r.okDays[0]} ~ ${r.okDays[r.okDays.length - 1]} 可绑定` : "本月无剩余可绑定日";
    return `<div class="bind-row" title="${esc(r.name)}（${r.id}）· ${esc(tip)}">` +
      `<span class="br-name">${esc(r.name || "未命名")}<em>${esc(r.id)}${r.status === "已离职" ? " · 已离职" : ""}</em></span>` +
      `<span class="br-date">${esc(r.entry || "—")}</span>` +
      `<span class="br-date">${esc(r.leave || "—")}</span>` +
      `<span class="br-day">${r.okDays.length} 天</span>` +
      `<span class="bind-bar">${r.cells.map((c) => `<i class="${c}"></i>`).join("")}</span></div>`;
  }).join("");
  box.innerHTML = head + body +
    (rows.length > 80 ? `<div class="rent-empty">只显示前 80 人（共 ${rows.length} 人），导出 CSV 看全部</div>` : "");
}

// ---------------------------------------------------------------- CSV 导出
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, rows) {
  const text = "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
/** 全部站点名单：逐个站点拉（每个站点一次请求），失败的站点记下来但不阻断。 */
async function loadAllRoster() {
  const all = [];
  const fails = [];
  for (let i = 0; i < state.teams.length; i++) {
    const t = state.teams[i];
    showMsg("bind-msg", `正在读取 ${i + 1}/${state.teams.length} 个站点的人资名单：${t.name}`, "info");
    try {
      const list = await loadRoster(t.id, t.name);
      all.push(...list);
    } catch (e) { fails.push(`${t.name}（${String(e && e.message ? e.message : e)}）`); }
    if (i < state.teams.length - 1) await sleep(120);
  }
  showMsg("bind-msg", fails.length ? `部分站点没取到：${fails.slice(0, 3).join("；")}` : "", fails.length ? "error" : "");
  return all;
}
/** kind = matrix（日历矩阵）/ detail（逐日明细） */
async function exportBind(kind) {
  const month = state.bindMonth;
  const days = monthDays(month);
  let list = state.roster;
  let scopeLabel = state.siteName || String(state.siteId);
  if (state.bindScope === "all") {
    scopeLabel = "全部站点";
    list = await loadAllRoster();
    if (!list.length) { showMsg("bind-msg", "全部站点都没取到名单，无法导出", "error"); return; }
  } else if (!list.length) {
    showMsg("bind-msg", "当前站点还没有人资名单，先点「重试」", "error");
    return;
  }
  const rows = bindRows(month, state.bindLeft, list);
  if (!rows.length) { showMsg("bind-msg", "这个月没有可导出的骑手", "error"); return; }
  const fileBase = `物资可绑定_${String(scopeLabel).replace(/[\\/:*?"<>|]/g, "_")}_${month}`;

  if (kind === "matrix") {
    const head = ["站点", "骑手姓名", "手机号", "骑士ID", "入职日期", "离职日期", "在职状态", "可绑定天数", "可绑定区间"]
      .concat(days.map((d) => d.slice(-2)));
    const body = rows.map((r) => [
      r.teamName || scopeLabel, r.name, r.mobile, r.id, r.entry || "", r.leave || "", r.status || "",
      r.okDays.length,
      r.okDays.length ? `${r.okDays[0]} ~ ${r.okDays[r.okDays.length - 1]}` : ""
    ].concat(r.cells.map((c) => BIND_LABEL[c])));
    downloadCsv(`${fileBase}_日历.csv`, [head].concat(body));
  } else {
    const head = ["站点", "骑手姓名", "骑士ID", "手机号", "日期", "星期", "状态", "说明"];
    const body = [];
    for (const r of rows) {
      for (let i = 0; i < days.length; i++) {
        const c = r.cells[i];
        if (state.bindLeft === false && c !== "ok") continue;   // 不导出已离职时只留可绑定的日期
        let note = "";
        if (c === "ok" && r.entry === days[i]) note = "入职日";
        else if (c === "ok" && r.leave === days[i]) note = "离职日";
        else if (c === "before") note = "还没入职";
        else if (c === "after") note = "已离职";
        else if (c === "past") note = "今天之前，不能倒签";
        body.push([r.teamName || scopeLabel, r.name, r.id, r.mobile, days[i], "周" + weekdayOf(days[i]),
          BIND_LABEL[c], note]);
      }
    }
    if (!body.length) { showMsg("bind-msg", "可绑定明细是空的", "error"); return; }
    downloadCsv(`${fileBase}_逐日明细.csv`, [head].concat(body));
  }
  showMsg("bind-msg", `已导出 ${rows.length} 位骑手 · ${kind === "matrix" ? "日历矩阵" : "逐日明细"}`, "success");
}

function renderAll() {
  renderSites();
  renderTypes();
  renderKnightSelect();
  renderBatchList();
  renderKpis();
  renderStatus();
  renderHistory();
  renderBind();
}

// ---------------------------------------------------------------- 业务
function validate(knightId, typeId, n, start, end) {
  if (!knightId) return "请选择骑手";
  if (!typeId) return "请选择物资类型";
  if (!(n >= 1 && n <= 99)) return "数量需在 1 ~ 99 之间";
  if (!start || !end) return "请选择开始 / 结束日期";
  if (start > end) return "开始日期不能晚于结束日期";
  return "";
}
function payloadOf(knightId, typeId, n, start, end) {
  const startTime = new Date(start + "T00:00:00").getTime();
  const endTime = new Date(end + "T23:59:59").getTime();
  return {
    params: {
      goodsBusinessRentCreateDto: {
        teamId: num(state.siteId),
        knightId: num(knightId),
        categoryList: [{ categoryId: num(typeId), startTime, endTime, num: num(n) }],
        rentType: RENT_TYPE
      }
    }
  };
}
function pushHistory(rec) {
  state.history.unshift(rec);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(state.history)); } catch (e) { /* 无痕模式忽略 */ }
  renderHistory();
  renderKpis();
}
async function submitOne() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const knightId = num($("one-knight").value);
  const typeId = num($("one-type").value);
  // 不能用 `|| 1` 兜底：数量填 0 时会被悄悄改成 1，绕过「1~99」校验
  const n = Math.trunc(num($("one-num").value));
  const start = $("one-start").value;
  const end = $("one-end").value;
  const err = validate(knightId, typeId, n, start, end);
  if (err) { showMsg("one-msg", err, "error"); return { ok: false, msg: err }; }
  const k = currentKnight(knightId);
  const knightName = k ? k.name : String(knightId);
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为「${knightName}」登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？\n\n提交会真实写入租用单。`
  )) return { ok: false, canceled: true };
  state.submitting = true;
  $("one-submit").disabled = true;
  showMsg("one-msg", "提交中…", "info");
  let ok = false, msg = "";
  try {
    const j = await postApi(API_CREATE, payloadOf(knightId, typeId, n, start, end));
    ok = okJson(j);
    msg = ok ? "success" : msgOf(j);
  } catch (e) {
    msg = String(e && e.message ? e.message : e);
  }
  state.submitting = false;
  $("one-submit").disabled = false;
  showMsg("one-msg", ok ? `登记成功：${knightName} · ${typeName(typeId)} × ${n}` : `登记失败：${msg}`, ok ? "success" : "error");
  pushHistory({
    at: Date.now(), site: state.siteName || String(state.siteId), knightId, knightName,
    typeName: typeName(typeId), num: n, start, end, ok, msg: ok ? "" : msg
  });
  if (ok) {
    $("one-knight").value = "";
    $("one-num").value = "1";
  }
  return { ok, msg };
}
async function submitBatch() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const ids = [...state.selected];
  if (!ids.length) { showMsg("batch-msg", "请至少选择一位骑手", "error"); return { ok: false }; }
  const typeId = num($("batch-type").value);
  const n = Math.trunc(num($("batch-num").value));
  const start = $("batch-start").value;
  const end = $("batch-end").value;
  const err = validate(ids[0], typeId, n, start, end);
  if (err) { showMsg("batch-msg", err, "error"); return { ok: false, msg: err }; }
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为 ${ids.length} 位骑手批量登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？\n\n每条间隔 ${BATCH_GAP_MS}ms，提交会真实写入租用单。`
  )) return { ok: false, canceled: true };

  state.submitting = true;
  $("batch-submit").disabled = true;
  const prog = $("batch-progress");
  prog.hidden = false;
  let ok = 0, bad = 0;
  const fails = [];
  for (let i = 0; i < ids.length; i++) {
    const k = currentKnight(ids[i]) || { id: ids[i], name: String(ids[i]) };
    prog.innerHTML = `正在提交 ${i + 1}/${ids.length} · 成功 ${ok} · 失败 ${bad}` +
      `<div class="rp-bar"><i style="width:${Math.round(i / ids.length * 100)}%"></i></div>`;
    let oneOk = false, msg = "";
    try {
      const j = await postApi(API_CREATE, payloadOf(k.id, typeId, n, start, end));
      oneOk = okJson(j);
      msg = oneOk ? "" : msgOf(j);
    } catch (e) {
      msg = String(e && e.message ? e.message : e);
    }
    if (oneOk) ok++; else { bad++; fails.push(`${k.name}（${msg}）`); }
    pushHistory({
      at: Date.now(), site: state.siteName || String(state.siteId), knightId: k.id, knightName: k.name,
      typeName: typeName(typeId), num: n, start, end, ok: oneOk, msg
    });
    if (i < ids.length - 1) await sleep(BATCH_GAP_MS);
  }
  prog.innerHTML = `批量完成：成功 ${ok} 人${bad ? ` · 失败 ${bad} 人` : ""}` +
    (fails.length ? `<div style="color:#B91C1C;margin-top:4px;">${esc(fails.slice(0, 5).join("；"))}${fails.length > 5 ? " …" : ""}</div>` : "") +
    `<div class="rp-bar"><i style="width:100%"></i></div>`;
  showMsg("batch-msg", `批量完成：成功 ${ok} 人${bad ? `，失败 ${bad} 人` : ""}`, bad ? "error" : "success");
  state.submitting = false;
  state.selected.clear();
  renderBatchList();
  updateBatchCount();
  return { ok: bad === 0, success: ok, fail: bad };
}

// ---------------------------------------------------------------- 表格导入（批量执行）
const IMPORT_ALIAS = {
  name: ["骑手姓名", "姓名", "骑手", "骑手名称", "knightname"],
  mobile: ["手机号", "手机", "手机号码", "电话", "mobile"],
  knightId: ["骑士id", "骑手id", "knightid", "骑手编号"],
  type: ["物资类型", "类型", "物资", "物资名称", "categoryid"],
  count: ["数量", "件数", "num"],
  start: ["开始日期", "开始时间", "开始", "starttime"],
  end: ["结束日期", "结束时间", "结束", "endtime"]
};
const IMPORT_HEADER = ["骑手姓名", "手机号", "骑士ID", "物资类型", "数量", "开始日期", "结束日期"];

/** CSV / 粘贴文本解析：按首行判断是逗号还是制表符分隔，支持双引号包裹与转义。 */
function parseCsv(text) {
  const s = String(text == null ? "" : text).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const firstLine = s.split("\n")[0] || "";
  const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cur = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(cur); cur = ""; continue; }
    if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
    cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}
const normHeader = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "").replace(/[：:]/g, "");
/** 二维数组 → 行对象。表头至少要能定位到「骑手姓名 / 手机号 / 骑士ID」之一。 */
function mapTable(rows) {
  if (!rows || !rows.length) return { err: "表格是空的" };
  const header = (rows[0] || []).map((x) => String(x == null ? "" : x).trim());
  const col = {};
  for (const key of Object.keys(IMPORT_ALIAS)) {
    const aliases = IMPORT_ALIAS[key];
    for (let i = 0; i < header.length; i++) {
      const h = normHeader(header[i]);
      if (h && aliases.includes(h)) { col[key] = i; break; }
    }
  }
  if (col.name === undefined && col.mobile === undefined && col.knightId === undefined) {
    return { err: "表头里没找到「骑手姓名 / 手机号 / 骑士ID」列，请用模板表头" };
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const pick = (k) => (col[k] === undefined ? "" : String(r[col[k]] == null ? "" : r[col[k]]).trim());
    const rec = {
      line: i + 1, name: pick("name"), mobile: pick("mobile"), knightId: pick("knightId"),
      typeRaw: pick("type"), countRaw: pick("count"), startRaw: pick("start"), endRaw: pick("end"),
      res: null, done: false, result: null
    };
    if (!rec.name && !rec.mobile && !rec.knightId) continue;
    out.push(rec);
    if (out.length >= IMPORT_MAX_ROWS) break;
  }
  if (!out.length) return { err: "表格里只有表头，没有数据行" };
  return { rows: out, header, col };
}
/** 单行校验：骑手（当前站点）→ 物资类型 → 数量 → 日期。 */
function resolveImportRow(row) {
  const out = { ok: false, err: "", knight: null, typeId: 0, typeName: "", count: 1, start: "", end: "" };
  let k = null;
  const kid = Math.trunc(num(row.knightId));
  if (kid) k = state.knights.find((x) => x.id === kid) || null;
  if (!k && row.mobile) k = state.knights.find((x) => x.mobile === String(row.mobile).trim()) || null;
  if (!k && row.name) {
    const hits = state.knights.filter((x) => x.name === String(row.name).trim());
    if (hits.length === 1) k = hits[0];
    else if (hits.length > 1) { out.err = "姓名重名，请补手机号或骑士ID"; return out; }
  }
  if (!k) {
    out.err = (kid || row.mobile || row.name) ? "当前站点没有这位骑手（先切站点）" : "缺少骑手姓名 / 手机号 / 骑士ID";
    return out;
  }
  out.knight = k;
  let t = null;
  const tid = Math.trunc(num(row.typeRaw));
  if (tid) t = state.types.find((x) => x.id === tid) || null;
  if (!t && row.typeRaw) {
    const raw = String(row.typeRaw).trim();
    t = state.types.find((x) => x.name === raw) ||
      state.types.find((x) => raw.includes(x.name) || x.name.includes(raw)) || null;
  }
  if (!t) { out.err = "物资类型不认识：" + (row.typeRaw || "（空）"); return out; }
  out.typeId = t.id;
  out.typeName = t.name;
  const c = row.countRaw === "" || row.countRaw == null ? 1 : Math.trunc(num(row.countRaw));
  if (!(c >= 1 && c <= 99)) { out.err = "数量需在 1 ~ 99 之间"; return out; }
  out.count = c;
  const s = ymd(row.startRaw), e = ymd(row.endRaw);
  if (!s || !e) { out.err = "日期看不懂（写 2026-11-01 或 2026/11/1）"; return out; }
  if (s > e) { out.err = "开始日期晚于结束日期"; return out; }
  out.start = s;
  out.end = e;
  out.ok = true;
  return out;
}
function resolveImport() {
  for (const row of state.importRows) row.res = resolveImportRow(row);
  // 完全相同的行直接拦掉：多半是复制粘贴重复，重复提交会生成两条一样的租用单
  const seen = new Map();
  for (const row of state.importRows) {
    if (!row.res.ok) continue;
    const key = [row.res.knight.id, row.res.typeId, row.res.count, row.res.start, row.res.end].join("|");
    if (seen.has(key)) {
      row.res.ok = false;
      row.res.err = `与第 ${seen.get(key)} 行完全重复，已跳过`;
    } else seen.set(key, row.line);
  }
}
function importStats() {
  const ok = state.importRows.filter((r) => r.res && r.res.ok && !r.done).length;
  const bad = state.importRows.filter((r) => r.res && !r.res.ok).length;
  return { ok, bad, total: state.importRows.length };
}
function renderImportPreview() {
  const box = $("import-preview");
  if (!box) return;
  if (!state.importRows.length) {
    box.innerHTML = `<div class="rent-empty">还没有导入数据</div>`;
  } else {
    const head = `<thead><tr><th style="width:46px">行</th><th style="width:150px">骑手</th>` +
      `<th style="width:80px">物资</th><th style="width:52px">数量</th><th style="width:96px">开始</th>` +
      `<th style="width:96px">结束</th><th>校验 / 结果</th></tr></thead>`;
    const body = state.importRows.map((r) => {
      const res = r.res || { ok: false, err: "未校验" };
      let cls = res.ok ? "" : "bad";
      let text = res.ok ? (r.res.typeName || "可执行") : res.err;
      if (r.done) {
        cls = r.result && r.result.ok ? "ok" : "bad";
        text = r.result && r.result.ok ? "提交成功" : "失败：" + ((r.result && r.result.msg) || "未知错误");
      } else if (res.ok) {
        text = "可执行";
      }
      const who = res.knight ? `${esc(res.knight.name)}<em>${esc(res.knight.id)}</em>` : esc(r.name || r.mobile || r.knightId || "—");
      return `<tr><td>${r.line}</td><td class="name">${who}</td>` +
        `<td>${esc(r.res && r.res.typeName ? r.res.typeName : r.typeRaw || "—")}</td>` +
        `<td>${esc(r.res && r.res.ok ? r.res.count : r.countRaw || "—")}</td>` +
        `<td>${esc((r.res && r.res.start) || r.startRaw || "—")}</td>` +
        `<td>${esc((r.res && r.res.end) || r.endRaw || "—")}</td>` +
        `<td class="${cls}" title="${esc(text || "")}">${esc(text || "")}</td></tr>`;
    }).join("");
    box.innerHTML = `<table class="tbl rent-history">${head}<tbody>${body}</tbody></table>`;
  }
  const st = importStats();
  const btn = $("import-run");
  if (btn) {
    btn.disabled = state.submitting || st.ok === 0;
    btn.textContent = st.ok ? `执行 ${st.ok} 条` : "执行 0 条";
  }
  if (st.total) {
    showMsg("import-msg", `共 ${st.total} 行：可执行 ${st.ok} 行` + (st.bad ? `，校验不通过 ${st.bad} 行（会跳过）` : ""),
      st.bad ? "error" : "info");
  }
}
function setImportRows(rows, fileName) {
  state.importRows = rows || [];
  state.importName = fileName || "";
  const nm = $("import-file-name");
  if (nm) nm.textContent = fileName ? `已读取：${fileName}` : "";
  resolveImport();
  renderImportPreview();
}
async function handleImportFile(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    let rows;
    if (/\.(xlsx|xlsm)$/i.test(file.name)) {
      if (typeof XLSX_READER === "undefined") throw new Error("缺少 xlsx 解析器");
      const sheets = await XLSX_READER.read(buf);
      if (!sheets.length) throw new Error("表格里没有工作表");
      // 优先挑表头能对上的工作表
      const keys = ["骑手姓名", "手机号", "骑士ID"];
      let picked = null;
      for (const s of sheets) {
        if (s.rows && s.rows.length && keys.some((k) => s.rows[0].some((c) => normHeader(c) === normHeader(k)))) { picked = s; break; }
      }
      rows = (picked || sheets[0]).rows;
    } else {
      rows = parseCsv(new TextDecoder("utf-8").decode(buf));
    }
    const mapped = mapTable(rows);
    if (mapped.err) { showMsg("import-msg", mapped.err, "error"); return; }
    setImportRows(mapped.rows, file.name);
    showMsg("import-msg", `已读取 ${mapped.rows.length} 行，请核对下方预览`, "info");
  } catch (e) {
    showMsg("import-msg", "读取失败：" + String(e && e.message ? e.message : e), "error");
  }
}
function downloadTemplate() {
  const today = todayStr();
  const last = monthDays(curMonth()).slice(-1)[0];
  const rows = [
    IMPORT_HEADER,
    ["张三", "13800000000", "", "电动车", 1, today, last],
    ["李四", "", "1088920079", "住宿", 1, today, last],
    ["王五", "13900000000", "", "电动车", 2, shiftDate(today, 7), last]
  ];
  downloadCsv("物资租用_导入模板.csv", rows);
  showMsg("import-msg", "模板已下载（示例行是假骑手，导入时会被判定为「当前站点没有这位骑手」并跳过）", "info");
}
async function runImport() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const todo = state.importRows.filter((r) => r.res && r.res.ok && !r.done);
  if (!todo.length) { showMsg("import-msg", "没有可执行的行", "error"); return { ok: false }; }
  const st = importStats();
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认执行 ${todo.length} 条租用登记？` +
    (st.bad ? `\n（另有 ${st.bad} 行校验不通过，会跳过）` : "") +
    `\n\n每条间隔 ${BATCH_GAP_MS}ms，提交会真实写入租用单。`
  )) return { ok: false, canceled: true };

  state.submitting = true;
  $("import-run").disabled = true;
  const prog = $("import-progress");
  if (prog) prog.hidden = false;
  let ok = 0, bad = 0;
  const fails = [];
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    const r = row.res;
    if (prog) {
      prog.innerHTML = `正在提交 ${i + 1}/${todo.length} · 成功 ${ok} · 失败 ${bad}` +
        `<div class="rp-bar"><i style="width:${Math.round(i / todo.length * 100)}%"></i></div>`;
    }
    let oneOk = false, msg = "";
    try {
      const j = await postApi(API_CREATE, payloadOf(r.knight.id, r.typeId, r.count, r.start, r.end));
      oneOk = okJson(j);
      msg = oneOk ? "" : msgOf(j);
    } catch (e) {
      msg = String(e && e.message ? e.message : e);
    }
    row.done = true;
    row.result = { ok: oneOk, msg };
    if (oneOk) ok++; else { bad++; fails.push(`${r.knight.name}（${msg}）`); }
    pushHistory({
      at: Date.now(), site: state.siteName || String(state.siteId), knightId: r.knight.id,
      knightName: r.knight.name, typeName: r.typeName, num: r.count, start: r.start, end: r.end,
      ok: oneOk, msg
    });
    renderImportPreview();
    if (i < todo.length - 1) await sleep(BATCH_GAP_MS);
  }
  if (prog) {
    prog.innerHTML = `导入执行完成：成功 ${ok} 条${bad ? ` · 失败 ${bad} 条` : ""}` +
      (fails.length ? `<div style="color:#B91C1C;margin-top:4px;">${esc(fails.slice(0, 5).join("；"))}${fails.length > 5 ? " …" : ""}</div>` : "") +
      `<div class="rp-bar"><i style="width:100%"></i></div>`;
  }
  state.submitting = false;
  renderImportPreview();
  showMsg("import-msg", `执行完成：成功 ${ok} 条${bad ? `，失败 ${bad} 条` : ""}`, bad ? "error" : "success");
  return { ok: bad === 0, success: ok, fail: bad };
}

/** 拉当前站点的人资名单（用于「本月可绑定」），失败只影响这一块。 */
async function loadRosterInto() {
  if (!state.siteId) return [];
  const seq = ++state.rosterSeq;
  state.rosterLoading = true;
  state.rosterErr = "";
  renderBind();
  let list = [], err = "";
  try {
    list = await loadRoster(state.siteId, state.siteName);
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }
  if (seq !== state.rosterSeq) return state.roster;   // 期间又切了站点，丢弃这次结果
  state.roster = list;
  state.rosterErr = err;
  state.rosterAt = new Date();
  state.rosterLoading = false;
  renderBind();
  return state.roster;
}
// ---------------------------------------------------------------- 事件
async function switchSite(siteId) {
  state.siteId = String(siteId || "");
  try { localStorage.setItem(LS_SITE, state.siteId); } catch (e) { /* ignore */ }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.selected.clear();
  state.knights = [];
  state.roster = [];
  state.rosterErr = "";
  renderSites();
  renderBatchList();
  renderKpis();
  renderStatus();
  renderBind();
  if (!state.siteId) return;
  try {
    state.knights = await loadKnights(state.siteId);
    state.errors = [];
  } catch (e) {
    showNotice("骑手列表加载失败：" + String(e && e.message ? e.message : e), "bad");
  }
  renderAll();
  loadRosterInto();          // 不 await：名单慢一点也不挡主表
}
async function loadAll() {
  state.loading = true;
  state.errors = [];
  try {
    const [teams, types] = await Promise.all([loadTeams(), loadTypes()]);
    state.teams = teams;
    state.types = types;
  } catch (e) {
    state.errors.push(String(e && e.message ? e.message : e));
    if (!state.teams.length) state.teams = fallbackTeams();
    showNotice("站点 / 物资类型加载失败：" + state.errors[0] + "（可点「立即刷新」重试，或切到静默桥接）", "bad");
  }
  if (!state.siteId || !state.teams.some((t) => String(t.id) === String(state.siteId))) {
    state.siteId = state.teams[0] ? String(state.teams[0].id) : "";
  }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.finishedAt = new Date();
  state.loading = false;
  renderAll();
  if (state.siteId) await switchSite(state.siteId);
}

function bind() {
  $("site-select").addEventListener("change", (e) => switchSite(e.target.value));
  $("btn-refresh").addEventListener("click", () => loadAll());
  $("btn-channel").addEventListener("click", async () => {
    state.via = state.via === "direct" ? "bridge" : "direct";
    try { localStorage.setItem("wb_via", state.via); } catch (e) { /* ignore */ }
    renderStatus();
    showNotice(state.via === "bridge"
      ? "已切到「静默桥接」：后台标签页取数，不打断浏览。"
      : "已切回「直连」：由插件页面直接请求接口。", state.via === "bridge" ? "blue" : "bad");
    await loadAll();
  });
  $("btn-clean").addEventListener("click", () => {
    const on = document.body.classList.toggle("clean");
    $("btn-clean").textContent = on ? "退出纯净" : "纯净看板";
  });
  $("btn-goto-assess").addEventListener("click", () => {
    if (window.parent !== window) {
      window.parent.postMessage({ __wbAssess: true, type: "SWITCH", mode: "assess" }, "*");
    } else {
      extMsg({ type: "WB_OPEN_TAB", page: "assess" }).catch(() => {});
    }
  });
  $("one-search").addEventListener("input", renderKnightSelect);
  $("one-submit").addEventListener("click", () => submitOne());
  $("batch-search").addEventListener("input", renderBatchList);
  $("batch-select-all").addEventListener("click", () => {
    const q = String($("batch-search").value || "").trim().toLowerCase();
    for (const k of state.knights) {
      if (!q || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q)) {
        state.selected.add(k.id);
      }
    }
    renderBatchList();
  });
  $("batch-clear").addEventListener("click", () => {
    state.selected.clear();
    renderBatchList();
  });
  $("batch-submit").addEventListener("click", () => submitBatch());

  // ---- 批量执行（表格导入）
  const openImport = () => { const m = $("import-modal"); if (m) m.hidden = false; };
  const closeImport = () => { const m = $("import-modal"); if (m) m.hidden = true; };
  $("btn-import").addEventListener("click", openImport);
  $("import-close").addEventListener("click", closeImport);
  $("import-cancel").addEventListener("click", closeImport);
  $("tpl-download").addEventListener("click", downloadTemplate);
  $("import-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    handleImportFile(f);
  });
  $("import-parse").addEventListener("click", () => {
    const text = String($("import-paste").value || "").trim();
    if (!text) { showMsg("import-msg", "先粘一段表格，或选一个文件", "error"); return; }
    const mapped = mapTable(parseCsv(text));
    if (mapped.err) { showMsg("import-msg", mapped.err, "error"); return; }
    setImportRows(mapped.rows, "粘贴内容");
    showMsg("import-msg", `已解析 ${mapped.rows.length} 行，请核对下方预览`, "info");
  });
  $("import-clear").addEventListener("click", () => {
    $("import-paste").value = "";
    $("import-file").value = "";
    const p = $("import-progress"); if (p) p.hidden = true;
    setImportRows([], "");
    showMsg("import-msg", "", "");
  });
  $("import-run").addEventListener("click", () => runImport());
  $("import-modal").addEventListener("click", (e) => { if (e.target && e.target.id === "import-modal") closeImport(); });

  // ---- 本月可绑定
  $("bind-month").addEventListener("change", (e) => {
    state.bindMonth = e.target.value || curMonth();
    saveBindOpts();
    renderBind();
  });
  $("bind-scope").addEventListener("change", (e) => {
    state.bindScope = e.target.value === "all" ? "all" : "site";
    saveBindOpts();
    showMsg("bind-msg", state.bindScope === "all" ? "导出时会逐个站点读取人资名单，站点多会慢几秒" : "", "info");
  });
  $("bind-left").addEventListener("change", (e) => {
    state.bindLeft = !!e.target.checked;
    saveBindOpts();
    renderBind();
  });
  $("bind-export-matrix").addEventListener("click", () => exportBind("matrix"));
  $("bind-export-detail").addEventListener("click", () => exportBind("detail"));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const n = $("notice"); if (n) n.hidden = true;
      const m = $("import-modal"); if (m) m.hidden = true;
    }
  });
}
function saveBindOpts() {
  try {
    localStorage.setItem(LS_BIND, JSON.stringify({ month: state.bindMonth, scope: state.bindScope, left: state.bindLeft }));
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 测试挂钩
window.__SET_RENT__ = (o) => {
  o = o || {};
  if (Array.isArray(o.teams)) state.teams = o.teams.map((t) => ({ id: String(t.id), name: String(t.name || t.team_name || t.id) }));
  if (Array.isArray(o.types)) state.types = o.types.map((t) => ({ id: num(t.id), name: String(t.name || t.id) }));
  if (Array.isArray(o.knights)) state.knights = o.knights.map((k) => ({
    id: num(k.id == null ? k.knightId : k.id), name: String(k.name || k.knightName || ""),
    mobile: String(k.mobile || ""), teamId: num(k.teamId)
  }));
  if (o.siteId != null) state.siteId = String(o.siteId);
  if (Array.isArray(o.history)) state.history = o.history;
  if (Array.isArray(o.roster)) state.roster = o.roster.map((r) => ({
    id: num(r.id == null ? r.knightId : r.id), name: String(r.name || r.staffName || ""),
    mobile: String(r.mobile || ""), entry: ymd(r.entry || r.entryTime), leave: ymd(r.leave || r.leaveTime),
    status: String(r.status || (r.leave || r.leaveTime ? "已离职" : "在职")),
    teamId: String(r.teamId || state.siteId), teamName: String(r.teamName || "")
  }));
  if (o.bindMonth) state.bindMonth = String(o.bindMonth);
  if (o.bindLeft != null) state.bindLeft = !!o.bindLeft;
  if (o.bindScope) state.bindScope = String(o.bindScope);
  if (Array.isArray(o.importRows)) {
    state.importRows = o.importRows.map((r) => ({
      line: num(r.line) || 1, name: String(r.name || ""), mobile: String(r.mobile || ""),
      knightId: String(r.knightId || ""), typeRaw: String(r.typeRaw || ""), countRaw: String(r.countRaw || ""),
      startRaw: String(r.startRaw || ""), endRaw: String(r.endRaw || ""), res: null, done: false, result: null
    }));
    resolveImport();
  }
  const t = state.teams.find((x) => String(x.id) === String(state.siteId));
  state.siteName = t ? t.name : String(state.siteId || "");
  state.finishedAt = new Date();
  renderAll();
  renderImportPreview();
};
window.__RENT__ = {
  state, postApi, getApi, loadAll, loadTeams, loadTypes, loadKnights, switchSite,
  loadRoster, loadRosterInto, computeBind, bindRows, bindState, monthDays, ymd, exportBind,
  parseCsv, mapTable, resolveImportRow, resolveImport, setImportRows, runImport,
  downloadTemplate, importStats, downloadCsv, csvCell, saveBindOpts,
  submitOne, submitBatch, validate, payloadOf, renderAll, renderHistory, renderBind, renderImportPreview,
  API_TEAMS, API_TYPES, API_KNIGHTS, API_CREATE, API_STAFF, RENT_TYPE, BATCH_GAP_MS, HISTORY_MAX,
  STAFF_PAGE_SIZE, IMPORT_MAX_ROWS
};

(async function init() {
  bind();
  const today = todayStr();
  for (const [id, val] of [["one-start", today], ["one-end", shiftDate(today, 30)],
    ["batch-start", today], ["batch-end", shiftDate(today, 30)]]) {
    const el = $(id);
    if (el) el.value = val;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
    if (Array.isArray(raw)) state.history = raw.slice(0, HISTORY_MAX);
  } catch (e) { state.history = []; }
  try {
    const o = JSON.parse(localStorage.getItem(LS_BIND) || "null");
    if (o && typeof o === "object") {
      if (o.month) state.bindMonth = String(o.month);
      if (o.scope === "all") state.bindScope = "all";
      state.bindLeft = !!o.left;
    }
  } catch (e) { /* ignore */ }
  const bm = $("bind-month"), bs = $("bind-scope"), bl = $("bind-left");
  if (bm) bm.value = state.bindMonth;
  if (bs) bs.value = state.bindScope;
  if (bl) bl.checked = state.bindLeft;
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  renderAll();
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) await loadAll();
})();
