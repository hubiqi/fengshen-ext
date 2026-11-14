/* 排班模块（独立页面 v3.17.0，第四个独立入口）
 * ---------------------------------------------------------------------------
 * 数据源只有现有的「排班查询 → 导出排班数据」：
 *   POST xtop.fs.special.schedule.exportSchedule/1.0
 *   body { teamIds, startDate: 所选日, endDate: 所选日+1 }（实测必须显式传 teamIds，
 *   传空数组会报「没有该团队的数据权限」；endDate 含次日才会带出排班统计表）
 *   返回 OSS xlsx，三个 sheet：
 *     ① 排班表（宽表：一行一骑手，两列日期）
 *     ② 排班表(行)（一行 = 骑手 × 日期，含「排班」班次串）
 *     ③ 排班统计（团队id / 团队名称 / 日期 / 站点人数 / 时段 / 应排人数 / 排班人数 / 预估单量）
 *
 * 口径（对齐用户提供的排班查询截图与桌面宽表）：
 *   缺口   = 排班人数 − 应排人数
 *   排班率 = 排班人数 / 应排人数（可 >100%，多排班不设上限）
 *   分数   = 排班人数 / 应排人数
 *   全天   = 排班统计里的「全天」行；时段列按当天实际排班动态生成（按 KPI 11 时段顺序）
 *   4排班占比 = 当天排了 ≥4 个班次的骑手数 / 该组「全天」排班人数
 *   时段排班率 = Σ(min(排班人数/应排人数, 100%) × 该时段权重)（v3.19.0）
 *              应排为 0 或当天没有的班次按 100% 计；权重可在「时段权重」面板改
 *   总计   = 各列求和（4排班占比分子分母分别求和后再算；时段排班率按总计行的
 *              各时段总应排 / 总排班重新加权算，不是对各组结果求平均）
 *
 * 站点勾选 / 站点↔商圈片 / 显示方式 / 权重修改都只在本机重算，0 额外请求；
 * 切日期才重新导出，结果按日期缓存在内存。
 * 与另外三个页面一样：直连优先、失败自动切「静默桥接」，跟随当前浏览器登录态。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_SCHEDULE = XT + "xtop.fs.special.schedule.exportSchedule/1.0";
const API_QUERY = XT + "xtop.agencyTrackingFs.queryTracking/2.0";
const TEAM_KEY = "wb_team_ids_v1";        // 与考核看板 / 出勤达成共用「记住的站点范围」
const PAGE_SIZE = 90;
const PAST_DAYS = 90;
const FUTURE_DAYS = 7;                     // 排班一般提前一周可查
const MIN_SHIFTS_FOR_4 = 4;                // 「4排班占比」的班次门槛
const AGENCY_NAME = "福建省双十网络科技有限公司";

// 站点名 → 接口原生商圈片名（与 assess.js 同一套映射；未命中则回退到站点名）
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
// KPI 11 时段标准顺序（与 assess.js PERIOD_DEFS 一致）
const PERIOD_ORDER = ["凌晨1", "凌晨2", "凌晨3", "早餐1", "早餐2", "午高峰",
  "下午茶1", "下午茶2", "晚高峰", "夜宵1", "夜宵2"];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(String(v == null ? 0 : v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const normId = (v) => {
  const s = String(v == null ? "" : v).trim();
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
};
const dateStrOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStrOf(new Date());
const shiftDate = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return dateStrOf(new Date(y, m - 1, d + days));
};
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00").getTime());
const hhmm = (d) => d.toTimeString().slice(0, 5);
const shortArea = (s) => String(s).replace(/^福州/, "").replace(/商圈片$/, "").replace(/商圈$/, "");
const shortSite = (s) => String(s).replace(/^福州/, "").replace(/-UB$/, "").replace(/站$/, "");
const areaOf = (s) => SITE_TO_AREA[String(s || "").trim()] || String(s || "").trim();
const groupName = (site, view) => view === "site" ? shortSite(site) : shortArea(areaOf(site));
const fmtPct = (v) => {
  const n = Math.round(num(v) * 10) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + "%";
};
const SHOW_LABEL = { all: "全部", gap: "缺口", pct: "排班率(百分比)", frac: "排班率(分数)" };

// v3.19.0 时段权重默认值（对齐手机端「时段权重配置」截图）：
// 截图可见 9 项 4/4/4/4/4/30/7/7/20 = 84%，滚动区下面没拍到的夜宵1/夜宵2
// 按「合计 100%」补足各 8%；两值都能在面板里改。
const DEFAULT_WEIGHTS = Object.freeze({
  "凌晨1": 4, "凌晨2": 4, "凌晨3": 4, "早餐1": 4, "早餐2": 4,
  "午高峰": 30, "下午茶1": 7, "下午茶2": 7, "晚高峰": 20,
  "夜宵1": 8, "夜宵2": 8
});
const LS_WEIGHTS = "wb_sch_weights";
function loadWeights() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_WEIGHTS) || "null");
    if (raw && typeof raw === "object") {
      const out = {};
      for (const p of PERIOD_ORDER) {
        const v = Number(raw[p]);
        out[p] = Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_WEIGHTS[p];
      }
      return out;
    }
  } catch (e) { /* 偏好损坏则用默认 */ }
  return { ...DEFAULT_WEIGHTS };
}
function weightSum(w) {
  return PERIOD_ORDER.reduce((a, p) => a + num(w[p]), 0);
}

const savedDate = localStorage.getItem("wb_sch_date");
const savedShow = localStorage.getItem("wb_sch_show");
const state = {
  via: localStorage.getItem("wb_via") || "direct",
  date: validDate(savedDate) ? savedDate : shiftDate(todayStr(), 1),   // 默认 T+1（明天）
  view: localStorage.getItem("wb_sch_view") === "site" ? "site" : "area",
  show: SHOW_LABEL[savedShow] ? savedShow : "all",
  weights: loadWeights(),      // v3.19.0：11 个时段权重，面板可改、localStorage 记忆
  selected: new Set(),
  inited: false,
  allSites: [],
  sheets: [], data: null, errors: [], dataNote: "", teamSource: "",
  loading: false, gen: 0, finishedAt: null,
  // 公司名跟随当前登录态：首次识别站点时顺手从运单行里取 agencyName 并记住，换商自动换名
  agencyName: localStorage.getItem("wb_sch_agency") || AGENCY_NAME,
  memo: new Map()   // 日期 -> sheets，切日期秒回；「立即刷新」强制重拉
};

// ---------------------------------------------------------------- 请求通道
function extMsg(msg) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || {}));
        return;
      }
    } catch (e) { /* 测试环境无扩展运行时 */ }
    resolve({});
  });
}
function unwrap(j) {
  if (!j || typeof j !== "object") throw new Error("接口返回的不是 JSON");
  const res = j.result;
  if (!res || typeof res !== "object") {
    const e = new Error("接口未返回业务结果（登录态失效或请求头被拒绝）");
    e.authSuspect = true; throw e;
  }
  if (String(res.code) !== "200") {
    const e = new Error(String(res.code) + (res.message ? " " + res.message : ""));
    e.code = String(res.code); throw e;
  }
  return res.data || {};
}
async function rawApi(api, payload, via) {
  if (via === "bridge") {
    const resp = await extMsg({ type: "BRIDGE_API", api, payload });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
    return resp.json;
  }
  const r = await fetch(api, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
    credentials: "include", referrerPolicy: "unsafe-url", body: JSON.stringify(payload)
  });
  return await r.json();
}
async function callApi(api, payload, isFirst) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return unwrap(await rawApi(api, payload, state.via));
    } catch (e) {
      lastErr = e;
      if (e.code === "REQUEST_TOO_FREQUENT") { await sleep(1800 * (attempt + 1)); continue; }
      if (isFirst && state.via === "direct" && !state.fallbackTried) {
        state.fallbackTried = true;
        state.via = "bridge";
        localStorage.setItem("wb_via", "bridge");
        showNotice("直连未成功，已自动切换到「静默桥接」：后台标签取数，不弹窗、不抢焦点。", "blue");
        try { await extMsg({ type: "ENSURE_RULES" }); } catch (err) { /* ignore */ }
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("请求失败");
}
async function fetchBinary(url) {
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.arrayBuffer();
  } catch (e) {
    const resp = await extMsg({ type: "FETCH_BINARY", url });
    if (!resp || !resp.ok) throw new Error("xlsx 下载失败：" + ((resp && resp.error) || e.message));
    return resp.buffer;
  }
}

function buildExportPayload(date, teamIds) {
  const d = date || state.date;
  return { params: { request: { teamIds: teamIds || [], startDate: d, endDate: shiftDate(d, 1) } } };
}
// 首次取站点范围：只查当日运单第一页，不分页、不落运单缓存
function buildTeamProbePayload() {
  const now = new Date(), start = new Date(now); start.setHours(0, 0, 0, 0);
  return { params: { request: {
    deliverTypeList: [1, 2], teamIds: [],
    trackingFinishStart: start.getTime(), trackingFinishEnd: now.getTime(),
    merchantConsumerDistanceStart: "0", merchantConsumerDistanceEnd: "999999",
    payAmountStart: "0", payAmountEnd: "999999",
    weightStart: "0", weightEnd: "999999",
    trackingFinishTimePeriodList: ["0-86400"], current: 1, pageSize: PAGE_SIZE
  } } };
}
async function resolveTeamIds() {
  const ids = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(TEAM_KEY) || "[]");
    if (Array.isArray(saved)) for (const id of saved) { const v = String(id || "").trim(); if (v) ids.add(v); }
    if (ids.size) { state.teamSource = "记住的站点范围"; return [...ids]; }
  } catch (e) { /* 解析失败当作没有 */ }
  const d = await callApi(API_QUERY, buildTeamProbePayload(), true);
  for (const r of (Array.isArray(d.data) ? d.data : [])) {
    const id = String((r && r.teamId) || "").trim(); if (id) ids.add(id);
    const agency = String((r && r.agencyName) || "").trim();
    if (agency) {
      state.agencyName = agency;
      try { localStorage.setItem("wb_sch_agency", agency); } catch (e) { /* ignore */ }
    }
  }
  if (ids.size) {
    try { localStorage.setItem(TEAM_KEY, JSON.stringify([...ids])); } catch (e) { /* ignore */ }
  }
  state.teamSource = "首次识别（1 页运单取 teamId）";
  return [...ids];
}

// ---------------------------------------------------------------- 通知 / 进度
function showNotice(text, kind) {
  const n = $("notice"); n.textContent = text; n.className = "notice" + (kind === "blue" ? " blue" : ""); n.hidden = false;
}
function clearNotice() { $("notice").hidden = true; $("notice").textContent = ""; }
function setProgress(step, total, mode) {
  $("bar").style.width = (mode === "done" || mode === "err" ? 100 : Math.round(step / Math.max(1, total) * 100)) + "%";
  $("bar").className = "bar" + (mode === "done" ? " done" : "") + (mode === "err" ? " err" : "");
  $("progress-text").textContent = mode === "done" ? `同步完成 · ${state.date} · 排班表已更新 · ${hhmm(state.finishedAt || new Date())}`
    : mode === "err" ? "加载失败" : "正在导出排班数据…";
}
function setBusy(b) { $("btn-refresh").disabled = b; $("btn-refresh").textContent = b ? "加载中…" : "立即刷新"; }

// ---------------------------------------------------------------- 计算
function splitShifts(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^(休息|未排班|无|-|—)$/.test(s)) return [];
  return s.split(/[、,，\/|;；\s]+/).map((x) => x.trim()).filter(Boolean);
}
/** 一格的三行数值；4排班占比传 {due:分母, real:分子} 复用同一套渲染 */
function cellParts(c) {
  if (!c) return null;
  const real = Math.round(num(c.real)), due = Math.round(num(c.due));
  const gap = real - due;
  const pct = due > 0 ? real / due * 100 : null;
  return {
    real, due, gap,
    gapTxt: (gap > 0 ? "+" : "") + gap,
    gapCls: gap > 0 ? "up" : gap < 0 ? "down" : "flat",
    pct, pctTxt: pct == null ? "—" : fmtPct(pct),
    pctCls: pct == null ? "" : (pct >= 100 ? "pct-good" : pct < 80 ? "pct-bad" : "pct-mid"),
    fracTxt: real + "/" + due
  };
}
/**
 * v3.19.0 时段排班率：Σ(该时段完成率 × 该时段权重) / 100。
 *  - 完成率 = min(排班人数 / 应排人数 × 100, 100)，多排不奖励；
 *  - 某时段应排为 0，或当天压根没有这个班次（cells 里没有该行）→ 按 100% 计；
 *  - 权重合计建议 100%，不强制；合计不是 100% 时结果按实际合计缩放，
 *    合计为 0 时返回 null（单元格显示「—」，不给出误导性的 0%）。
 */
function periodRate(cells, w) {
  const weights = w || state.weights;
  let sum = 0, sumW = 0;
  for (const p of PERIOD_ORDER) {
    const wp = num(weights[p]);
    const c = cells && cells.get(p);
    const due = c ? num(c.due) : 0, real = c ? num(c.real) : 0;
    const rate = due <= 0 ? 100 : Math.min(real / due * 100, 100);
    sum += rate * wp;
    sumW += wp;
  }
  return { value: sumW > 0 ? sum / 100 : null, wsum: sumW };
}
function compute() {
  const stat = XLSX_READER.pickSheet(state.sheets, ["团队名称", "日期", "时段", "应排人数", "排班人数"]);
  if (!stat) throw new Error("排班导出里找不到「排班统计」表（含 团队名称 / 日期 / 时段 / 应排人数 / 排班人数）");
  const line = XLSX_READER.pickSheet(state.sheets, ["日期", "团队id", "骑手id", "排班"]);
  const C = stat.col, date = state.date;
  const rows = stat.rows.filter((r) => String(r[C["日期"]] || "").slice(0, 10) === date);
  if (!rows.length) throw new Error(`${date} 没有排班统计行（该日期可能尚未排班或超出可查范围）`);

  // 站点清单来自导出结果本身，勾选/全选只本地重算、0 额外请求
  const siteMap = new Map();
  for (const r of rows) {
    const id = normId(r[C["团队id"]]), name = String(r[C["团队名称"]] || "").trim();
    if (id && name && !siteMap.has(id)) siteMap.set(id, name);
  }
  state.allSites = [...siteMap].map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const validIds = new Set(state.allSites.map((s) => s.id));
  if (!state.inited) { state.selected = new Set(validIds); state.inited = true; }
  else state.selected = new Set([...state.selected].filter((id) => validIds.has(id)));
  const sel = state.selected;

  const used = rows.filter((r) => sel.has(normId(r[C["团队id"]])));
  const periodSet = new Set();
  for (const r of used) {
    const p = String(r[C["时段"]] || "").trim();
    if (p && p !== "全天" && p !== "休息" && PERIOD_ORDER.includes(p)) periodSet.add(p);
  }
  const periods = PERIOD_ORDER.filter((p) => periodSet.has(p));
  const cols = ["全天", ...periods];

  const groups = new Map();
  const ensure = (name) => {
    let g = groups.get(name);
    if (!g) { g = { name, cells: new Map() }; groups.set(name, g); }
    return g;
  };
  for (const r of used) {
    const site = String(r[C["团队名称"]] || "").trim();
    const per = String(r[C["时段"]] || "").trim();
    if (!cols.includes(per)) continue;
    const g = ensure(groupName(site, state.view));
    const c = g.cells.get(per) || { due: 0, real: 0 };
    c.due += num(r[C["应排人数"]]); c.real += num(r[C["排班人数"]]);
    g.cells.set(per, c);
  }

  // 4排班占比：排班表(行) 里每个骑手当天排了几个可识别班次，≥4 的记 1 人
  const riderShifts = new Map();
  if (line) {
    const L = line.col;
    for (const r of line.rows) {
      if (String(r[L["日期"]] || "").slice(0, 10) !== date) continue;
      if (!sel.has(normId(r[L["团队id"]]))) continue;
      const site = String(r[L["团队名称"]] || "").trim();
      const rid = String(r[L["骑手id"]] || "").trim();
      if (!rid) continue;
      const k = groupName(site, state.view) + "\u0001" + rid;
      const n = splitShifts(r[L["排班"]]).filter((p) => PERIOD_ORDER.includes(p)).length;
      riderShifts.set(k, Math.max(riderShifts.get(k) || 0, n));
    }
  }
  const four = (name) => {
    let hit = 0;
    for (const [k, n] of riderShifts) if (k.startsWith(name + "\u0001") && n >= MIN_SHIFTS_FOR_4) hit++;
    const day = groups.get(name) ? groups.get(name).cells.get("全天") : null;
    const den = day ? Math.round(num(day.real)) : 0;
    return { due: den, real: hit, hasLine: !!line };
  };

  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  for (const g of list) { g.four = four(g.name); g.rate = periodRate(g.cells); }
  const total = { name: "总计", cells: new Map(), four: { due: 0, real: 0, hasLine: !!line } };
  for (const per of cols) {
    let due = 0, real = 0;
    for (const g of list) { const c = g.cells.get(per); if (c) { due += c.due; real += c.real; } }
    total.cells.set(per, { due, real });
  }
  for (const g of list) { total.four.due += g.four.due; total.four.real += g.four.real; }
  // 总计行按所有站点逐时段汇总后的总应排 / 总排班重新加权，不对各组结果求平均
  total.rate = periodRate(total.cells);

  state.data = { date, cols, groups: list, total, sites: state.allSites, selected: state.selected, view: state.view,
    weightSum: weightSum(state.weights) };
  return state.data;
}

// ---------------------------------------------------------------- 渲染
function cellHtml(c, four) {
  const p = cellParts(c);
  if (!p) return `<td class="sch-cell${four ? " sch-four" : ""}">—</td>`;
  return `<td class="sch-cell${four ? " sch-four" : ""}">` +
    `<span class="v-gap ${p.gapCls}">${esc(p.gapTxt)}</span>` +
    `<span class="v-pct ${p.pctCls}">${esc(p.pctTxt)}</span>` +
    `<span class="v-frac">${esc(p.fracTxt)}</span></td>`;
}
/** 加权列单独渲染，不复用 .sch-cell，避免影响「缺口/百分比/分数」三行切换 */
function rateCellHtml(r) {
  if (!r || r.value == null) return `<td class="sch-rate" title="权重合计为 0，暂不计算">—</td>`;
  const cls = r.value >= 100 ? "pct-good" : r.value < 80 ? "pct-bad" : "pct-mid";
  const tip = `Σ(min(排班人数/应排人数, 100%) × 时段权重)；当前权重合计 ${fmtPct(r.wsum)}；应排为 0 或当天无该班次按 100% 计`;
  return `<td class="sch-rate" title="${esc(tip)}">` +
    `<span class="rate-main ${cls}">${esc(fmtPct(r.value))}</span>` +
    `<span class="rate-sub">权重 ${esc(fmtPct(r.wsum))}</span></td>`;
}
function renderTable() {
  const d = state.data;
  const head = `<thead><tr><th class="sch-name">团队名称</th>` +
    d.cols.map((p) => `<th>${esc(p)}</th>`).join("") +
    `<th class="sch-four">4排班占比</th>` +
    `<th class="sch-rate">时段排班率</th></tr></thead>`;
  const rowHtml = (g, isTotal) => `<tr${isTotal ? ' class="sch-total"' : ""}>` +
    `<td class="sch-name">${esc(g.name)}</td>` +
    d.cols.map((p) => cellHtml(g.cells.get(p))).join("") +
    cellHtml(g.four, true) + rateCellHtml(g.rate) + `</tr>`;
  const body = `<tbody>` + (d.groups.length
    ? d.groups.map((g) => rowHtml(g, false)).join("") + rowHtml(d.total, true)
    : `<tr><td class="sch-name" colspan="${d.cols.length + 3}">— 未选中任何站点 —</td></tr>`) + `</tbody>`;
  $("sch-table").innerHTML = head + body;
}
function renderSummary() {
  const d = state.data, t = d.total.cells.get("全天") || { due: 0, real: 0 };
  const p = cellParts(t), f = cellParts(d.total.four);
  const rateVal = d.total.rate && d.total.rate.value != null ? fmtPct(d.total.rate.value) : "—";
  const cards = [
    ["站点", `${d.selected.size}/${d.sites.length}`],
    ["全天应排", String(p.due)], ["全天排班", String(p.real)],
    ["全天缺口", p.gapTxt], ["全天排班率", p.pctTxt], ["4排班占比", f.pctTxt],
    ["时段排班率", rateVal]
  ];
  $("sch-summary").innerHTML = cards.map(([k, v]) => {
    const cls = (k === "全天缺口" ? p.gapCls : "");
    return `<div class="sch-card"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`;
  }).join("");
  $("sch-note").textContent = `统计维度：${state.view === "site" ? "站点" : "商圈片"} · 显示方式：${SHOW_LABEL[state.show]}` +
    ` · 已选 ${d.selected.size}/${d.sites.length} 个站点 · 时段列按 ${d.date} 实际排班动态生成（${d.cols.length - 1} 个）` +
    ` · 时段权重合计 ${fmtPct(d.weightSum)}${Math.abs(d.weightSum - 100) > 0.001 ? "（建议调到 100%）" : ""}` +
    (state.dataNote ? ` · ${state.dataNote}` : "");
}
function renderSitePop() {
  $("site-count").textContent = state.selected.size;
  $("site-list").innerHTML = state.allSites.length
    ? state.allSites.map((s) => `<label><input type="checkbox" data-id="${esc(s.id)}"` +
      `${state.selected.has(s.id) ? " checked" : ""}> ${esc(shortSite(s.name))}</label>`).join("")
    : `<div class="sch-site-list">— 暂无站点 —</div>`;
}
function syncControls() {
  $("date-picker").value = state.date;
  $("date-picker").min = shiftDate(todayStr(), -PAST_DAYS);
  $("date-picker").max = shiftDate(todayStr(), FUTURE_DAYS);
  $("btn-prev").disabled = state.date <= shiftDate(todayStr(), -PAST_DAYS);
  $("btn-next").disabled = state.date >= shiftDate(todayStr(), FUTURE_DAYS);
  // v3.56.0：快捷按钮高亮 + 动态 title，和出勤达成页的「今天 / T-1」保持一致
  const today = todayStr(), t1 = shiftDate(today, 1);
  $("btn-today").classList.toggle("date-active", state.date === today);
  $("btn-t1").classList.toggle("date-active", state.date === t1);
  $("btn-prev").title = $("btn-prev").disabled ? "已到最早可排日期" : `前一天（${shiftDate(state.date, -1)}）`;
  $("btn-next").title = $("btn-next").disabled ? "已到最晚可排日期" : `后一天（${shiftDate(state.date, 1)}）`;
  $("btn-today").title = state.date === today ? "当前已是今天" : `切到今天（${today}）`;
  $("btn-t1").title = state.date === t1 ? "当前已是明天（T+1）" : `切到明天（${t1}）`;
  const delta = Math.round((new Date(state.date + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000);
  $("date-tag").textContent = delta === 0 ? "（今天）" : delta === 1 ? "（明天 · T+1）" : delta > 1 ? `（T+${delta}）` : `（T${delta}）`;
  for (const b of $("view-seg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === state.view);
  for (const b of $("mode-seg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.show === state.show);
  document.body.dataset.show = state.show;
}
function render() {
  $("doc-title").textContent = `${state.agencyName || AGENCY_NAME} · ${state.date} · 排班`;
  $("doc-sub").textContent = `统计维度：${state.view === "site" ? "站点" : "商圈片"}` +
    ` · 显示方式：${SHOW_LABEL[state.show]}` +
    ` · 生成时间 ${hhmm(state.finishedAt || new Date())}`;
  $("sub").textContent = `${state.date} · ${state.view === "site" ? "按站点" : "按商圈片"} · ${state.finishedAt ? "已同步" : "待同步"}`;
  $("foot-meta").textContent = `数据源：exportSchedule/1.0（${state.teamSource || "当前登录态"}） · 生成 ${hhmm(state.finishedAt || new Date())} · 缺口 = 排班 − 应排`;
  syncControls();
  if (!state.data) { renderEmpty(); return; }
  renderTable(); renderSummary(); renderSitePop();
}
function renderEmpty() {
  $("sch-summary").innerHTML = `<div class="sch-card"><span class="k">排班</span><span class="v">—</span></div>`;
  $("sch-note").textContent = state.errors.length ? state.errors[0] : "暂无排班数据";
  $("sch-table").innerHTML = `<tbody><tr><td class="sch-name">— 暂无排班数据 —</td></tr></tbody>`;
  renderSitePop();
}

// ---------------------------------------------------------------- 加载
async function loadAll(force) {
  if (state.loading) return;
  const gen = ++state.gen;
  state.loading = true; setBusy(true); setProgress(0, 1, "export");
  state.errors = []; state.dataNote = "";
  try {
    const memo = force ? null : state.memo.get(state.date);
    if (memo) {
      state.sheets = memo;
      state.dataNote = "已复用本机缓存的该日期数据，点「立即刷新」可重新拉取";
    } else {
      const teamIds = await resolveTeamIds();
      if (gen !== state.gen) return;
      if (!teamIds.length) throw new Error("站点范围为空：请先打开一次「考核看板」让它记住站点，或点「立即刷新」重试");
      const data = await callApi(API_SCHEDULE, buildExportPayload(state.date, teamIds), true);
      const url = (data && typeof data === "object") ? (data.url || data.downloadUrl || data.fileUrl) : data;
      if (!url || typeof url !== "string" || !/^https?:/.test(url)) throw new Error("排班导出未返回下载链接");
      const buf = await fetchBinary(url);
      const sheets = await XLSX_READER.read(buf);
      state.sheets = sheets;
      state.memo.set(state.date, sheets);
    }
    if (gen !== state.gen) return;
    state.finishedAt = new Date();
    compute(); render(); setProgress(1, 1, "done");
  } catch (e) {
    state.errors = [String((e && e.message) || e)];
    state.data = null;
    showNotice("排班取数失败：" + state.errors[0] + "。请确认已在本浏览器登录风神（a.ele.me），或点「立即刷新」重试。");
    render(); setProgress(1, 1, "err");
  } finally {
    state.loading = false; setBusy(false);
  }
}
function reloadLocal() {
  // 站点 / 维度切换：只重算，不重新拉接口
  try { compute(); render(); } catch (e) { state.errors = [String(e.message || e)]; state.data = null; render(); }
}

// ---------------------------------------------------------------- 导出
function exportCsv() {
  const d = state.data;
  if (!d) { showNotice("暂无排班数据可导出。"); return; }
  const head = ["团队名称"];
  for (const p of d.cols) head.push(`${p}缺口`, `${p}排班率`, `${p}分数`);
  head.push("4排班占比", "4排班分数", "时段排班率");
  const lineOf = (g) => {
    const out = [g.name];
    for (const p of d.cols) {
      const c = cellParts(g.cells.get(p));
      out.push(c ? c.gapTxt : "—", c ? c.pctTxt : "—", c ? c.fracTxt : "—");
    }
    const f = cellParts(g.four);
    out.push(f ? f.pctTxt : "—", f ? f.fracTxt : "—",
      g.rate && g.rate.value != null ? fmtPct(g.rate.value) : "—");
    return out.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",");
  };
  const csv = "\uFEFF" + [head.map((x) => `"${x}"`).join(","), ...d.groups.map(lineOf), lineOf(d.total)].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `风神排班_${d.date}_${d.view === "site" ? "站点" : "商圈片"}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showNotice(`已导出 ${d.date} 排班 CSV（${d.groups.length + 1} 行 × ${head.length} 列）。`, "blue");
}

// ---------------------------------------------------------------- v3.19.0 时段权重配置面板
const fmtW = (v) => String(Math.round(num(v) * 100) / 100);   // 支持小数，最多显示两位
function weightInputs() { return [...$("weight-list").querySelectorAll("input[data-period]")]; }
function renderWeightList() {
  $("weight-list").innerHTML = PERIOD_ORDER.map((p) =>
    `<div class="sch-weight-row"><label for="w-${esc(p)}">${esc(p)}</label>` +
    `<div class="sch-weight-box"><input type="number" id="w-${esc(p)}" data-period="${esc(p)}"` +
    ` min="0" max="100" step="0.1" inputmode="decimal" value="${esc(state.weights[p])}">` +
    `<span>%</span></div></div>`).join("");
  updateWeightSum();
}
function updateWeightSum() {
  let sum = 0, bad = 0;
  for (const inp of weightInputs()) {
    const raw = String(inp.value).trim(), v = Number(raw);
    const okv = raw !== "" && Number.isFinite(v) && v >= 0 && v <= 100;
    inp.classList.toggle("bad", !okv);
    if (!okv) bad++; else sum += v;
  }
  $("weight-sum").textContent = fmtW(sum);
  $("weight-warn").textContent = bad ? "有输入不合法（0~100）"
    : Math.abs(sum - 100) > 0.001 ? `建议合计 100%（当前 ${fmtW(sum)}%）` : "";
  return { sum, bad };
}
function openWeightPop() { renderWeightList(); $("weight-overlay").hidden = false; }
function closeWeightPop() { $("weight-overlay").hidden = true; }
function saveWeights(silent) {
  const { sum, bad } = updateWeightSum();
  if (bad) { showNotice("权重必须是 0~100 的数字，请修正红色输入框后再保存。"); return false; }
  const next = {};
  for (const inp of weightInputs()) next[inp.dataset.period] = Number(String(inp.value).trim());
  state.weights = next;
  try { localStorage.setItem(LS_WEIGHTS, JSON.stringify(next)); } catch (e) { /* ignore */ }
  reloadLocal();                 // 只重算，0 额外请求
  if (!silent) showNotice(`时段权重已保存（合计 ${fmtW(sum)}%），宽表已按新权重重算。`, "blue");
  return true;
}
function resetWeights() {
  for (const inp of weightInputs()) inp.value = DEFAULT_WEIGHTS[inp.dataset.period];
  saveWeights(false);           // 恢复默认即生效，不必再点保存
}

// ---------------------------------------------------------------- 事件绑定
$("date-picker").addEventListener("change", () => {
  const v = $("date-picker").value;
  if (!validDate(v)) return;
  state.date = v; localStorage.setItem("wb_sch_date", v);
  state.inited = false; state.data = null;
  loadAll(false);
});
function stepDate(delta) {
  const v = shiftDate(state.date, delta);
  if (v < shiftDate(todayStr(), -PAST_DAYS) || v > shiftDate(todayStr(), FUTURE_DAYS)) return;
  state.date = v; localStorage.setItem("wb_sch_date", v);
  state.inited = false; state.data = null;
  loadAll(false);
}
$("btn-prev").addEventListener("click", () => stepDate(-1));
$("btn-next").addEventListener("click", () => stepDate(1));
$("btn-today").addEventListener("click", () => {
  state.date = todayStr(); localStorage.setItem("wb_sch_date", state.date);
  state.inited = false; state.data = null; loadAll(false);
});
$("btn-t1").addEventListener("click", () => {
  state.date = shiftDate(todayStr(), 1); localStorage.setItem("wb_sch_date", state.date);
  state.inited = false; state.data = null; loadAll(false);
});

$("btn-sites").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("site-pop"); pop.hidden = !pop.hidden;
  $("btn-sites").setAttribute("aria-expanded", String(!pop.hidden));
});
$("site-pop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { $("site-pop").hidden = true; $("btn-sites").setAttribute("aria-expanded", "false"); });
$("btn-site-all").addEventListener("click", () => {
  state.selected = new Set(state.allSites.map((s) => s.id)); reloadLocal();
});
$("btn-site-none").addEventListener("click", () => { state.selected = new Set(); reloadLocal(); });
$("site-list").addEventListener("change", (e) => {
  const box = e.target;
  if (!box || box.tagName !== "INPUT" || !box.dataset.id) return;
  if (box.checked) state.selected.add(box.dataset.id); else state.selected.delete(box.dataset.id);
  reloadLocal();
});
$("view-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]"); if (!b) return;
  state.view = b.dataset.view; localStorage.setItem("wb_sch_view", state.view);
  state.inited = false; reloadLocal();
});
$("mode-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-show]"); if (!b) return;
  state.show = b.dataset.show; localStorage.setItem("wb_sch_show", state.show);
  syncControls(); render();
});
$("btn-refresh").addEventListener("click", () => loadAll(true));
$("btn-weight").addEventListener("click", (e) => {
  e.stopPropagation();
  $("weight-overlay").hidden ? openWeightPop() : closeWeightPop();
});
$("btn-weight-close").addEventListener("click", closeWeightPop);
$("weight-overlay").addEventListener("click", (e) => {
  if (e.target && e.target.id === "weight-overlay") closeWeightPop();
});
$("weight-list").addEventListener("input", updateWeightSum);
$("btn-weight-save").addEventListener("click", () => { if (saveWeights(false)) closeWeightPop(); });
$("btn-weight-reset").addEventListener("click", resetWeights);
$("btn-export-csv").addEventListener("click", exportCsv);
$("btn-copy-image").addEventListener("click", async (e) => {
  const btn = $("btn-copy-image");
  if (btn.disabled) return;
  if (!window.WB_CAPTURE) { showNotice("图片模块未加载：请重新加载扩展或安装新版 zip。"); return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "正在生成图片…";
  try {
    const ymd = state.date.replace(/-/g, "");
    const r = await WB_CAPTURE.capture({
      download: e.shiftKey, date: ymd, rootId: "sheet",
      filename: `风神排班_${ymd}.png`
    });
    const size = `${r.width}×${r.height}`;
    showNotice(r.mode === "clipboard"
      ? `已复制排班图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`
      : `排班图片已另存为 PNG 文件（${size}）。`, "blue");
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}。可先点「纯净看板」，再用系统截图工具替代。`);
  } finally { btn.disabled = false; btn.textContent = label; }
});
$("btn-clean").addEventListener("click", () => {
  closeWeightPop();
  const on = document.body.classList.toggle("clean");
  $("btn-clean").textContent = on ? "退出纯净看板" : "纯净看板";
  if (!on) return;
  const b = document.createElement("button");
  b.id = "btn-clean-float"; b.className = "ghost"; b.textContent = "退出纯净看板";
  b.style.cssText = "position:fixed;right:16px;top:12px;z-index:99;opacity:.35";
  b.onmouseenter = () => { b.style.opacity = "1"; };
  b.onmouseleave = () => { b.style.opacity = ".35"; };
  b.onclick = () => { document.body.classList.remove("clean"); b.remove(); $("btn-clean").textContent = "纯净看板"; };
  document.body.appendChild(b);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clearNotice(); $("site-pop").hidden = true; closeWeightPop(); }
});

// ---------------------------------------------------------------- 测试钩子
// 注入真实排班 xlsx 解析出的 sheets 后直接出表，不发任何网络请求；CDP 回归用。
window.__SET_SCHEDULE__ = (sheets, opts) => {
  const o = opts || {};
  state.sheets = sheets || [];
  if (o.date && validDate(o.date)) { state.date = o.date; localStorage.setItem("wb_sch_date", o.date); }
  if (o.view) state.view = o.view;
  if (o.show) state.show = o.show;
  if (o.selected) { state.selected = new Set(o.selected.map(String)); state.inited = true; }
  if (o.resetSelected) { state.selected = new Set(); state.inited = false; }
  // 真机回归显式指定权重，避免上一次跑留下的 localStorage 偏好干扰
  if (o.weights === "default") state.weights = { ...DEFAULT_WEIGHTS };
  else if (o.weights && typeof o.weights === "object") state.weights = { ...DEFAULT_WEIGHTS, ...o.weights };
  state.finishedAt = new Date();
  try { compute(); render(); setProgress(1, 1, "done"); }
  catch (err) { state.errors = [String(err.message || err)]; state.data = null; render(); }
  return { rows: state.data ? state.data.groups.length : 0, cols: state.data ? state.data.cols.length : 0,
    sites: state.allSites.length, selected: state.selected.size };
};
window.__SCH__ = { state, compute, render, renderTable, renderSummary, syncControls, exportCsv,
  loadAll, reloadLocal, buildExportPayload, buildTeamProbePayload, resolveTeamIds,
  cellParts, splitShifts, groupName, shortArea, shortSite, areaOf, fmtPct,
  SITE_TO_AREA, PERIOD_ORDER, MIN_SHIFTS_FOR_4, AGENCY_NAME,
  // v3.19.0 时段排班率 / 权重配置
  periodRate, rateCellHtml, DEFAULT_WEIGHTS, LS_WEIGHTS, loadWeights, weightSum,
  renderWeightList, updateWeightSum, openWeightPop, closeWeightPop, saveWeights, resetWeights };

// ---------------------------------------------------------------- 初始化
(async function init() {
  syncControls();
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (window.__WB_TEST__) { render(); setProgress(1, 1, "done"); return; }
  loadAll(false);
})();
