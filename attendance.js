// 出勤达成看板（独立页面 v3.7.1）—— 与「指定日考核看板」完全分开的入口与画面
//
// 本页只做一件事：算「应排 / 实排 / 有效出勤」并输出实排达成、应排达成两张宽表。
// 不拉运单明细、不写运单缓存、不改动原考核看板的任何画面或导出图。
//
// v3.20.0：两张表末列新增「时段排班率」= 11 时段加权。
//   已结束班次完成率 = min(有效出勤/应排, 100%)；T0 未开始 / 进行中班次
//   降级用「排班完成率」= min(排班/应排, 100%)；无该班次或应排 0 按 100%。
//   权重与排班模块共用 localStorage.wb_sch_weights，改一次两个模块同步。
//
// 日期可选择（默认今天，可回看最近 90 天；日期框两侧有 ‹ › 箭头逐日快切，
// 到「今天」或「90 天前」边界自动置灰）。两条取数链路：
//   今天：exportSchedule/1.0 排班统计 + exportAttendance/1.0 实时考勤（当日快照）
//   T-1 及更早：exportSchedule/1.0 排班统计（支持历史日期）
//              + exportStatisticsDetail/1.0（出勤统计 → 导出明细数据，骑手 × 时段）
//   实测 exportAttendance/1.0 会忽略 startDate/endDate，传任何历史日期都返回当前实时快照，
//   所以历史日期必须改走时段明细；明细经 ASSESS.detailToAttendance() 标准成同样的列，
//   再由 ASSESS.build() 用同一套口径计算，避免两套口径漂移。
//
// 全天的系统「是否达成」标记不可信：明细里全天行的目标时长 / 目标完单为空，
// 系统标记并非按运力标准判定。本页一律忽略该列，全天按「有效在线≥6h 且 完单≥18单」
// 手工判定；时段达成按 config.py PERIOD_STANDARDS 的时长 + 完单双门槛判定。
//
// teamIds 的取法：优先复用原看板已落盘的运单缓存（0 次额外请求）；缓存不存在时
// 只查当日运单第 1 页取站点 ID（1 次请求）。历史日期的站点范围与今天一致。

const XT = "https://httpizza.ele.me/xtop/";
const API_QUERY = XT + "xtop.agencyTrackingFs.queryTracking/2.0";
const API_SCHEDULE = XT + "xtop.fs.special.schedule.exportSchedule/1.0";
const API_ATTENDANCE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
// 出勤统计 → 导出明细数据：按 teamIds + 日期范围一次性返回所有骑手的时段明细
const API_ATT_DETAIL = XT + "xtop.fs.special.examine.exportStatisticsDetail/1.0";
const PAGE_SIZE = 90;
const THROTTLE_MS = 1200;
const REFRESH_MS = 5 * 60 * 1000;
const HISTORY_DAYS = 90;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => String(Math.round(Number(n || 0)));
// 与截图一致：整数不补 .0（95%、100%、102.3%、400%）
const attPct = (n) => {
  const v = Math.round(Number(n || 0) * 10) / 10;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
};
// 商圈片全名 -> 表内简称（福州台江区台江商圈片 -> 台江区台江）
const shortArea = (s) => String(s).replace(/^福州/, "").replace(/商圈片$/, "").replace(/商圈$/, "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateStrOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStrOf(new Date());
// 用本地时间做日期加减，避免 toISOString 的 UTC 偏移把 T-1 算错
const shiftDate = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return dateStrOf(new Date(y, m - 1, d + days));
};
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00").getTime());
const hhmm = (d) => d.toTimeString().slice(0, 5);

// ---------------------------------------------------------------- v3.20.0 时段权重
// 固定 11 个 KPI 时段（与 assess.js PERIOD_DEFS、schedule.js PERIOD_ORDER 完全一致）。
// 加权列固定遍历这 11 项，不随「当天只排了几个班」变化：没排的班按 100% 计入。
const ATT_PERIOD_ORDER = ["凌晨1", "凌晨2", "凌晨3", "早餐1", "早餐2", "午高峰",
  "下午茶1", "下午茶2", "晚高峰", "夜宵1", "夜宵2"];
const ATT_DEFAULT_WEIGHTS = Object.freeze({
  "凌晨1": 4, "凌晨2": 4, "凌晨3": 4, "早餐1": 4, "早餐2": 4,
  "午高峰": 30, "下午茶1": 7, "下午茶2": 7, "晚高峰": 20,
  "夜宵1": 8, "夜宵2": 8
});
const ATT_LS_WEIGHTS = "wb_sch_weights";   // 与排班模块「时段权重」面板共用同一份配置
function loadAttWeights() {
  try {
    const raw = JSON.parse(localStorage.getItem(ATT_LS_WEIGHTS) || "null");
    if (raw && typeof raw === "object") {
      const out = {};
      for (const p of ATT_PERIOD_ORDER) {
        const v = Number(raw[p]);
        out[p] = Number.isFinite(v) && v >= 0 && v <= 100 ? v : ATT_DEFAULT_WEIGHTS[p];
      }
      return out;
    }
  } catch (e) { /* 偏好损坏则用默认 */ }
  return { ...ATT_DEFAULT_WEIGHTS };
}
const attWeightSum = (w) => ATT_PERIOD_ORDER.reduce((a, p) => a + (Number(w[p]) || 0), 0);

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  date: todayStr(), mode: "live",
  // 「实排达成 / 应排达成」页签：一次只看一张表，切过的选择记在本机
  view: localStorage.getItem("wb_att_view") === "due" ? "due" : "real",
  // T0 炸班明细里的「全天」默认关：一天没过完，按 6h / 18 单判「全天未达标」不准。
  // 勾选后只是粗略看一眼，不参与任何达成率计算；选择同样记在本机。
  rosterDay: localStorage.getItem("wb_att_roster_day") === "on",
  loading: false, gen: 0, errors: [], fallbackTried: false,
  schSheets: [], attSheets: [], assess: null, detailStats: null,
  startedAt: null, finishedAt: null, dataNote: "", teamSource: "", teamCount: 0,
  memo: new Map(),  // 日期 -> 已加载的 sheets，切换日期秒回；「立即刷新」强制重拉
  teamIds: [],
  weights: loadAttWeights(),   // v3.20.0：11 时段权重，与排班模块共用、可跨页实时同步
  // T-3 / T-2 / T-1 历史异常：日期 -> Map<rid, 炸班班次数>；按日期缓存，切日期不重拉
  histFails: new Map(), histPending: new Set(), histErrors: new Map(),
  histDetail: new Map()   // 日期 -> histDayMap，点标红班次时查近三天的时长 / 完单 / 是否达标
};

function extMsg(msg) {
  try { return chrome.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}

// ---------------------------------------------------------------- 请求体
function buildExportPayload(kind, teamIds, date) {
  const d = date || state.date || todayStr();
  // 排班导出的 endDate 要含次日才会带出排班统计表；历史日期同样适用（实测返回起止两天）
  return { params: { request: {
    teamIds,
    startDate: d,
    endDate: kind === "schedule" ? shiftDate(d, 1) : d
  } } };
}
// 只在缓存缺失时用来取 teamIds 的「当日第 1 页」，不分页、不落缓存
function buildQueryPayload(page) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return { params: { request: {
    deliverTypeList: [1, 2], teamIds: [],
    trackingFinishStart: start.getTime(), trackingFinishEnd: now.getTime(),
    merchantConsumerDistanceStart: "0", merchantConsumerDistanceEnd: "999999",
    payAmountStart: "0", payAmountEnd: "999999",
    weightStart: "0", weightEnd: "999999",
    trackingFinishTimePeriodList: ["0-86400"],
    current: page, pageSize: PAGE_SIZE
  } } };
}

// ---------------------------------------------------------------- 双通道请求（与考核看板同一套）
async function rawApi(api, payload, via) {
  if (via === "bridge") {
    const resp = await extMsg({ type: "BRIDGE_API", api, payload });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
    return resp.json;
  }
  try {
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      credentials: "include",
      referrerPolicy: "unsafe-url",
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    const err = new Error("直连失败：" + (e && e.message ? e.message : String(e)));
    err.authSuspect = true;
    throw err;
  }
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
async function callApi(api, payload, isFirst) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return unwrap(await rawApi(api, payload, state.via));
    } catch (e) {
      lastErr = e;
      if (e.code === "REQUEST_TOO_FREQUENT") { await sleep(1800 * (attempt + 1)); continue; }
      if (e.code === "PAGE_SIZE_OVER_RANGE") { await sleep(1500); continue; }
      if (isFirst && state.via === "direct" && !state.fallbackTried) {
        state.fallbackTried = true;
        await switchChannel("bridge",
          "直连未成功（" + (e.message || "未知原因") + "），已自动切换到「静默桥接」：后台标签取数，不弹窗、不抢焦点。");
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("请求失败");
}
async function switchChannel(via, msg) {
  state.via = via;
  localStorage.setItem("wb_via", via);
  $("btn-channel").textContent = "通道：" + (via === "bridge" ? "静默桥接" : "直连");
  if (msg) showNotice(msg, "blue");
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- xlsx 下载与解析
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
async function loadExportSheet(api, kind, teamIds, date) {
  const data = await callApi(api, buildExportPayload(kind, teamIds, date), false);
  const url = (data && typeof data === "object") ? (data.url || data.downloadUrl) : data;
  if (!url || typeof url !== "string" || !/^https?:/.test(url)) {
    const label = kind === "schedule" ? "排班" : (kind === "detail" ? "历史出勤明细" : "考勤");
    throw new Error(label + "导出未返回下载链接");
  }
  const buf = await fetchBinary(url);
  return await XLSX_READER.read(buf);
}

// ---------------------------------------------------------------- 通知 / 进度
function showNotice(text, kind) {
  const n = $("notice");
  n.innerHTML = esc(text);
  n.className = "notice" + (kind === "blue" ? " blue" : "");
  n.hidden = false;
}
function clearNotice() { $("notice").hidden = true; $("notice").textContent = ""; }
function setProgress(step, total, mode) {
  const bar = $("bar");
  bar.style.width = (mode === "done" || mode === "err" ? 100 : Math.round(step / Math.max(1, total) * 100)) + "%";
  bar.className = "bar" + (mode === "done" ? " done" : "") + (mode === "err" ? " err" : "");
  $("progress-text").textContent =
    mode === "done" ? `同步完成 · ${state.date} · ${state.assess && state.assess.attendance.ok ? "两张达成表已更新" : "数据待补齐"} · ${hhmm(state.finishedAt || new Date())}` :
    mode === "err" ? "加载失败" :
    mode === "export" ? (state.mode === "history" ? "正在导出排班 / 历史时段明细…" : "正在导出排班 / 实时考勤…") :
    mode === "teams" ? "正在确定站点范围…" : "连接风神接口…";
}
function setBusy(b) { $("btn-refresh").disabled = b; $("btn-refresh").textContent = b ? "加载中…" : "立即刷新"; }

// ---------------------------------------------------------------- 计算 + 渲染
function recompute() {
  // 运单传空数组：出勤达成只依赖排班统计 + 考勤（实时快照或历史时段明细），
  // 与原考核看板的运单增量链路解耦；dateStr 传所选日期，排班统计按该日期过滤。
  state.assess = ASSESS.build([], state.schSheets, state.attSheets, state.date, XLSX_READER);
  state.mode = isToday(state.date) ? "live" : "history";
  render();
}
const isToday = (d) => d === todayStr();

// ---------------------------------------------------------------- 实排 / 应排 页签切换
// 两张表只是分母不同（实排 = 排班人数，应排 = 应排人数），分子同为「有效出勤」。
// 并排竖着放要滚两遍几乎一样的数字，所以收成一组页签：默认看实排达成，点另一个换分母。
// 切换只动显示，不重新取数、不重算口径；两张表在切换前都已渲染好，点了即刻生效。
const VIEW_KEY = "wb_att_view";
function applyView() {
  const due = state.view === "due";
  $("att-title-real").hidden = due;
  $("att-title-due").hidden = !due;
  $("wrap-real").hidden = due;
  $("wrap-due").hidden = !due;
  for (const [id, on] of [["btn-view-real", !due], ["btn-view-due", due]]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
}
function setView(view) {
  const v = view === "due" ? "due" : "real";
  if (v === state.view) return;
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 无痕模式忽略 */ }
  applyView();
}
function bindViewSwitch() {
  const box = $("att-switch");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-view]");
    if (!b) return;
    setView(b.dataset.view);
  });
  // 页签按 ← → 也能翻，键盘操作不用去点
  box.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = state.view === "real" ? "due" : "real";
    setView(next);
    const b = $(next === "due" ? "btn-view-due" : "btn-view-real");
    if (b && b.focus) b.focus();
  });
}

// ---------------------------------------------------------------- T0 清单「全天」开关（v3.13.1）
// 今天还没结束，「全天」按 6h / 18 单判出来的炸班名单不准（人还在陆续上线、单还在攒）。
// 所以 T0 的炸班明细矩阵默认不给「全天」列；想粗略看可点标题右侧开关临时打开。
// 只作用于清单：矩阵表头的全天列、顶部「整商全天」概览都不动。历史日期是定稿数据，
// 开关隐藏、全天照常显示。
const ROSTER_DAY_KEY = "wb_att_roster_day";
function applyRosterDay() {
  const b = $("btn-roster-day");
  if (!b) return;
  const live = isToday(state.date);
  b.hidden = !live;                       // 历史日期不需要这个开关
  b.classList.toggle("on", state.rosterDay);
  b.setAttribute("aria-checked", state.rosterDay ? "true" : "false");
  b.title = state.rosterDay
    ? "「全天」已手动打开：今天还没结束，这批人仅供参考；点一下关掉"
    : "今天还没结束，全天按 6h / 18 单判定不准；默认关闭，打开后仅供参考";
}
function setRosterDay(on) {
  const v = !!on;
  if (v === state.rosterDay) return;
  state.rosterDay = v;
  try { localStorage.setItem(ROSTER_DAY_KEY, v ? "on" : "off"); } catch (e) { /* 无痕模式忽略 */ }
  render();   // 清单、标题、说明、底部计数一起刷新；不重新取数
}
function bindRosterDay() {
  const b = $("btn-roster-day");
  if (!b) return;
  b.addEventListener("click", () => setRosterDay(!state.rosterDay));
}

// 两张表共用同一份「有效出勤」分子：实排达成 = 有效出勤/实排，应排达成 = 有效出勤/应排。
// 分母为 0 显示「—」；未结束班次且暂无达标骑手时显示「统计中 / 未开始」。
// 炸班明细的 key 必须与 assess.js 的 attKey 一致（area + \u0001 + 时段）
const failKey = (area, per) => area + "\u0001" + per;
const failListOf = (att, area, per) => (att.fails && att.fails[failKey(area, per)]) || [];

/** 排了班但没达标的骑手数：点击单元格就展开这批人（片区行才可点，总计行不展开） */
function attCell(c, per, mode, att, area) {
  const den = mode === "real" ? c.real : c.due;
  const rate = mode === "real" ? c.realRate : c.dueRate;
  const fails = area ? failListOf(att, area, per) : [];
  const attr = area ? ` data-area="${esc(area)}" data-per="${esc(per)}"` : "";
  const tip = `应排 ${fmt(c.due)} · 实排 ${fmt(c.real)} · 有效出勤 ${fmt(c.valid)}` +
    (fails.length ? ` · 炸班 ${fails.length} 人（点击查看明细）` : "");
  if (!(den > 0) || rate == null) return `<td class="att-cell zero"${attr} title="${esc(tip)}">—</td>`;
  if (c.valid === 0 && att.ongoing.includes(per)) {
    const label = att.noData.includes(per) ? "未开始" : "统计中";
    return `<td class="att-cell pending"${attr} title="${esc(tip)}"><b>${label}</b>` +
           `<span>${fmt(c.valid)}/${fmt(den)}</span></td>`;
  }
  const cls = rate >= 100 ? "good" : (rate >= 80 ? "warn" : "bad");
  return `<td class="att-cell ${cls}"${attr} title="${esc(tip + " · 达成 " + attPct(rate))}">` +
         `<b>${attPct(rate)}</b><span>${fmt(c.valid)}/${fmt(den)}</span></td>`;
}

// ---------------------------------------------------------------- v3.20.0 时段排班率
/**
 * Σ(时段完成率 × 时段权重) / 100，固定遍历 11 个 KPI 时段。
 *  - 已结束班次：完成率 = min(有效出勤 / 应排, 100%)（应排达成口径，与表内格子一致）
 *  - T0 未开始 / 进行中班次：达成数据还没跑出来，降级用「排班完成率」
 *    = min(排班 / 应排, 100%)，避免把未来班次算成 0% 炸班
 *  - 当天没有该班次 / 应排为 0：按 100%（与排班模块「时段排班率」同口径）
 *  - 权重合计建议 100%，不自动归一化；合计为 0 返回 null（显示「—」）
 * cells 既可以是片区行的 cells，也可以是 att.totals（两者结构相同）。
 */
function attPeriodRate(cells, att) {
  let sum = 0, sumW = 0;
  for (const p of ATT_PERIOD_ORDER) {
    const wp = Number(state.weights[p]) || 0;
    const c = cells && cells[p];
    const due = c ? Number(c.due) || 0 : 0;
    const real = c ? Number(c.real) || 0 : 0;
    const valid = c ? Number(c.valid) || 0 : 0;
    const pending = (att && att.ongoing || []).includes(p);
    const rate = due <= 0 ? 100
      : pending ? Math.min(real / due * 100, 100)
      : Math.min(valid / due * 100, 100);
    sum += rate * wp;
    sumW += wp;
  }
  return { value: sumW > 0 ? sum / 100 : null, wsum: sumW };
}
function attRateTip(r) {
  return `Σ(时段完成率 × 时段权重) / 100；已结束班次 = min(有效出勤/应排,100%)，` +
    `T0 未开始 / 进行中 = min(排班/应排,100%)，无该班次或应排 0 = 100%；` +
    `权重合计 ${attPct(r.wsum)}（与排班模块共用，可在排班模块「时段权重」面板修改）`;
}
function attRateCell(r) {
  if (!r || r.value == null) return `<td class="att-cell att-rate zero" title="权重合计为 0，暂不计算">—</td>`;
  const cls = r.value >= 100 ? "good" : (r.value >= 80 ? "warn" : "bad");
  return `<td class="att-cell att-rate ${cls}" title="${esc(attRateTip(r))}">` +
    `<b>${attPct(r.value)}</b><span>权重 ${attPct(r.wsum)}</span></td>`;
}

// T0（今天）只展示**已经结束的班次**：还没跑完的班次，人还在陆续上线、单还在攒，
// 这个时点把它算成「炸班」既不公平也没意义（11-06 快照里夜宵2 有 84 人才刚上线 10 分钟）。
// 历史日期是定稿数据，所有班次都算已结束，原样展示。
// 「全天」不是班次，矩阵表头与顶部整商全天概览仍保留（清单另按开关处理，见 rosterPeriods）。
function periodsFor(att) {
  if (!isToday(state.date)) return att.periods.slice();
  const ongoing = att.ongoing || [];
  return att.periods.filter((p) => p === "全天" || !ongoing.includes(p));
}

// 显式传进来的数组（哪怕是空数组）都按「过滤后的班次」用；只有不传时才退回全量。
// 清早一个班次都没跑完时过滤结果可能是空数组，不能用 truthy 判断把它丢回全量。
const pickP = (att, periods) => Array.isArray(periods) ? periods : att.periods;

// 清单专用：在矩阵班次的基础上，T0 且开关关闭时再去掉「全天」。
function rosterPeriods(att, periods) {
  const P = pickP(att, periods);
  if (!isToday(state.date) || state.rosterDay) return P;
  return P.filter((p) => p !== "全天");
}

// 全天口径下有多少炸班人次（用于清单说明与底部计数）
function dayFailCount(att) {
  let n = 0;
  for (const [k, list] of Object.entries(att.fails || {})) {
    const cut = k.indexOf("\u0001");
    if (cut >= 0 && k.slice(cut + 1) === "全天") n += list.length;
  }
  return n;
}

function renderAttTable(id, att, mode, periods) {
  const P = pickP(att, periods);
  // 总宽仍锁 1218px（导出图宽度不变）：末列「时段排班率」固定 112px，其余班次均分，字号保持常规
  const firstW = 210, rateW = 112, totalW = 1218;
  const subW = ((totalW - firstW - rateW) / Math.max(1, P.length)).toFixed(2);
  const cols = `<colgroup><col style="width:${firstW}px">` +
    P.map(() => `<col style="width:${subW}px">`).join("") +
    `<col style="width:${rateW}px"></colgroup>`;
  const rateHeadTip = attRateTip({ wsum: attWeightSum(state.weights) });
  const head = `<thead><tr><th>团队名称</th>` + P.map((p) => {
    const st = att.standards[p];
    const hint = p === "全天"
      ? "全天：有效在线≥6小时 且 完单≥18单"
      : `有效在线≥${(st && st.timeMin) || 0}分钟 且 完单≥${(st && st.orders) || 0}单`;
    return `<th title="${esc(hint)}">${esc(p)}</th>`;
  }).join("") + `<th class="att-rate" title="${esc(rateHeadTip)}">时段排班率</th></tr></thead>`;
  const body = ["<tbody>"];
  for (const r of att.rows) {
    body.push(`<tr><td class="name" title="${esc(r.area)}">${esc(shortArea(r.area))}</td>` +
      P.map((p) => attCell(r.cells[p], p, mode, att, r.area)).join("") +
      attRateCell(attPeriodRate(r.cells, att)) + `</tr>`);
  }
  body.push(`<tr class="total"><td>总计</td>` +
    P.map((p) => attCell(att.totals[p], p, mode, att, "")).join("") +
    attRateCell(attPeriodRate(att.totals, att)) + `</tr></tbody>`);
  const t = $(id);
  t.style.width = totalW + "px";
  t.style.minWidth = totalW + "px";
  t.innerHTML = cols + head + body.join("");
}

// ---------------------------------------------------------------- 炸班明细矩阵（v3.14.0）
// 一人一行 × 时段列：站点 / 姓名+id / 异常次数 / 各时段（✓ 达标、✗ 炸班、空 = 没排这个班）/
// T-3 / T-2 / T-1（大前天、前天、昨日的异常班次汇总）/ T+1排班。
// ✗ 直接来自 att.fails（与弹窗同源）；✓ 来自考勤原始表里「排班状态 = 排班」且不在 fails 的格子。
// 这样不用重算判定标准，也不会和 ASSESS.build 的口径漂移。
function scheduledSet(sheets) {
  const out = new Set();
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || !rows.length) continue;
    const head = rows[0].map((x) => String(x == null ? "" : x).trim());
    const iR = head.indexOf("骑手id"), iS = head.indexOf("排班状态"), iP = head.indexOf("时段");
    if (iR < 0 || iS < 0 || iP < 0) continue;
    for (const r of rows.slice(1)) {
      if (String(r[iS] == null ? "" : r[iS]).trim() !== "排班") continue;
      const rid = String(r[iR] == null ? "" : r[iR]).trim();
      const per = String(r[iP] == null ? "" : r[iP]).trim();
      if (rid && per) out.add(rid + "\u0001" + per);
    }
  }
  return out;
}

function splitShifts(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^(休息|未排班|无|-|—)$/.test(s)) return [];
  return s.split(/[、,，\/|;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** 排班导出 endDate 已含次日，xlsx 天然带回所选日（T）+ 次日（T+1）的骑手排班，0 额外请求 */
function tomorrowSchedule(schSheets, date) {
  const target = shiftDate(date, 1);
  const out = new Map();
  for (const sh of schSheets || []) {
    const rows = sh && sh.rows;
    if (!rows || !rows.length) continue;
    const head = rows[0].map((x) => String(x == null ? "" : x).trim());
    const iR = head.indexOf("骑手id");
    if (iR < 0) continue;
    // 行式：日期 / 骑手id / 排班
    const iD = head.indexOf("日期"), iA = head.indexOf("排班");
    if (iD >= 0 && iA >= 0) {
      for (const r of rows.slice(1)) {
        if (String(r[iD] == null ? "" : r[iD]).slice(0, 10) !== target) continue;
        const rid = String(r[iR] == null ? "" : r[iR]).trim();
        if (rid) out.set(rid, splitShifts(r[iA]));
      }
      if (out.size) return out;
    }
    // 宽式：表头形如 "2026-11-07 周六"
    const col = head.findIndex((h) => h.slice(0, 10) === target);
    if (col >= 0) {
      for (const r of rows.slice(1)) {
        const rid = String(r[iR] == null ? "" : r[iR]).trim();
        if (rid) out.set(rid, splitShifts(r[col]));
      }
      if (out.size) return out;
    }
  }
  return out;
}

// 与 assess.js parseDur 同款：「2小时26分钟」/「2:26」/纯分钟，统一换算成分钟
// 与 assess.js parseDur 完全同口径（返回分钟）：只认「2小时26分钟」这种文本，
// 纯数字 / "2:26" 一律当 0 —— 否则 T-3/T-2/T-1 的判定会和当天 build() 漂移。
function parseDurMin(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t) return 0;
  const h = /(\d+)\s*小时/.exec(t), m = /(\d+)\s*分钟?/.exec(t);
  if (!h && !m) return 0;
  return (h ? Number(h[1]) : 0) * 60 + (m ? Number(m[1]) : 0);
}

/** 历史某天的「骑手 × 班次」判定明细：rid -> Map<班次, {min, orders, ok}>。
 *  达标的行也留着（追溯弹窗要显示「是否达标」），全天行不算班次。 */
function histDayMap(sheets, standards) {
  const out = new Map();
  const defs = (typeof ASSESS !== "undefined" && ASSESS.PERIOD_DEFS) || [];
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || !rows.length) continue;
    const head = rows[0].map((x) => String(x == null ? "" : x).trim());
    const iR = head.indexOf("骑手id"), iS = head.indexOf("排班状态"), iP = head.indexOf("时段");
    const iV = head.indexOf("时段有效在线时长"), iO = head.indexOf("时段完单量");
    if (iR < 0 || iS < 0 || iP < 0) continue;
    for (const r of rows.slice(1)) {
      if (String(r[iS] == null ? "" : r[iS]).trim() !== "排班") continue;
      const rid = String(r[iR] == null ? "" : r[iR]).trim();
      const per = String(r[iP] == null ? "" : r[iP]).trim();
      if (!rid || !per || per === "全天") continue;
      const std = (standards && standards[per]) || defs.find((d) => d.name === per);
      if (!std) continue;
      const min = parseDurMin(iV >= 0 ? r[iV] : "");
      const orders = iO >= 0 ? (Number(r[iO]) || 0) : 0;
      const ok = min >= std.timeMin && orders >= std.orders;
      if (!out.has(rid)) out.set(rid, new Map());
      const m = out.get(rid), old = m.get(per);
      // 同一骑手同一时段多行时保留「更好」的那次，与 ASSESS.build 的取法一致
      if (!old || min > old.min || orders > old.orders) m.set(per, { min, orders, ok });
    }
  }
  return out;
}

/** T-3 / T-2 / T-1 单元格用的汇总：每人当天炸班班次数 */
function histCounts(dayMap) {
  const out = new Map();
  for (const [rid, m] of dayMap) {
    let n = 0;
    for (const rec of m.values()) if (!rec.ok) n++;
    if (n) out.set(rid, n);
  }
  return out;
}

function failRowsOf(att, periods) {
  const areaIdx = new Map((att.rows || []).map((r, i) => [r.area, i]));
  const allow = new Set(pickP(att, periods));
  const out = [];
  for (const [k, list] of Object.entries(att.fails || {})) {
    const cut = k.indexOf("\u0001");
    const area = k.slice(0, cut), per = k.slice(cut + 1);
    if (!allow.has(per)) continue;          // T0 未结束的班次不进清单
    for (const x of list) {
      out.push({ ...x, area, per,
        ai: areaIdx.has(area) ? areaIdx.get(area) : 99 });
    }
  }
  out.sort((a, b) => (a.ai - b.ai) || (a.min - b.min) ||
    (a.orders - b.orders) || String(a.name || a.rid).localeCompare(String(b.name || b.rid), "zh"));
  return out;
}

/** 把「片区 × 班次」的 fails 重组成「一人一行」的矩阵行；异常次数 = 这一行可见 ✗ 的个数 */
function matrixRows(att, periods) {
  const P = pickP(att, periods);
  const failRows = failRowsOf(att, P);
  const sched = scheduledSet(state.attSheets);
  const bad = new Map(), who = new Map();
  for (const x of failRows) {
    if (!who.has(x.rid)) who.set(x.rid, { rid: x.rid, name: x.name || "—", site: x.site || "" });
    if (!bad.has(x.rid)) bad.set(x.rid, new Set());
    bad.get(x.rid).add(x.per);
  }
  const rows = [];
  for (const [rid, meta] of who) {
    const b = bad.get(rid);
    const cells = P.map((per) => b.has(per) ? "no" : (sched.has(rid + "\u0001" + per) ? "ok" : ""));
    // bad 一并带出去：T+1排班里与本日炸班同名的班次要标红并可点开追溯
    rows.push({ ...meta, bad: b, cells, cnt: cells.filter((c) => c === "no").length });
  }
  rows.sort((a, b) => (b.cnt - a.cnt) || String(a.site).localeCompare(String(b.site), "zh")
    || String(a.name).localeCompare(String(b.name), "zh") || String(a.rid).localeCompare(String(b.rid)));
  return { P, rows, total: failRows.length };
}

function histCell(dateStr, rid) {
  if (state.histPending.has(dateStr)) return "…";
  const m = state.histFails.get(dateStr);
  return m ? fmt(m.get(rid) || 0) : "—";
}

function renderRosterMatrix(att, periods) {
  const box = $("fail-roster"), tbl = $("table5");
  const { P, rows, total } = matrixRows(att, periods);
  const live = isToday(state.date);
  const dayOff = live && !state.rosterDay;      // T0 的「全天」是否被关掉
  const dayN = dayFailCount(att);
  const tomorrow = tomorrowSchedule(state.schSheets, state.date);
  const hDates = [-3, -2, -1].map((k) => shiftDate(state.date, k));
  const colCount = P.length + 7;

  if (!rows.length) {
    // 清早把「全天」关掉后，可能一个已结束班次都还没炸班；别把整块藏掉，
    // 否则用户连「打开全天」的开关都点不到。给一句空态，开关留在标题右侧。
    if (dayOff && dayN > 0) {
      box.hidden = false;
      $("fr-title").textContent = "炸班明细 · 已结束班次暂无炸班（全天未结束，已默认关闭）";
      $("fr-note").innerHTML = "今天还没有已结束班次的炸班记录；全天口径要等当天跑完才准，" +
        `想粗略看可点标题右侧的 <b>显示全天</b>（${fmt(dayN)} 人次，仅供参考）。`;
      tbl.innerHTML = `<tbody><tr><td class="fr-empty" colspan="${colCount}">— 已结束班次暂无炸班 —</td></tr></tbody>`;
      return 0;
    }
    box.hidden = true; tbl.innerHTML = ""; return 0;
  }
  box.hidden = false;

  $("fr-title").textContent =
    `炸班明细 · 共 ${rows.length} 人 / ${total} 个炸班班次` + (dayOff ? " · 不含全天" : "");

  const tips = [
    `一人一行：<i class="mk ok">✓</i> 该班次达标、<i class="mk no">✗</i> 炸班、空白为没排这个班；` +
    `<b>异常次数</b> = 这一行 ✗ 的个数。` +
    `T-3 / T-2 / T-1 分别是大前天 / 前天 / 昨日的炸班班次汇总（— 为明细未取到），` +
    `「T+1排班」中 T = 当前所选日期，显示的是 T 的次日（T+1）排班；查历史日期时是「该日 + 1 天」，不是真实的明天，数据取自排班导出的次日每人时段。`
  ];
  if (live) {
    const skipped = att.periods.filter((p) => p !== "全天" && (att.ongoing || []).includes(p));
    tips.push(skipped.length
      ? `今天只列 <b>已结束</b> 的班次，${skipped.join("、")} 还没跑完（人还在陆续上线），结束后会自动出现在这里。`
      : "今天所有班次都已结束，下面是这些班次的完整名单。");
  }
  if (dayOff) {
    tips.push(dayN > 0
      ? `<b>「全天」已默认关闭</b>：今天还没过完，按 6h / 18 单判「全天未达标」不准，${fmt(dayN)} 人次暂不列入；想粗略看可点标题右侧开关（仅供参考）。`
      : `<b>「全天」已默认关闭</b>：今天还没过完，全天口径不准，想粗略看可点标题右侧开关。`);
  } else if (P.includes("全天")) {
    tips.push(live
      ? "「全天」列为手动打开：今天还没结束，这一列仅供参考。"
      : "「全天」列是整天口径，与各班次列并列展示。");
  }
  tips.push("T+1排班按班次拆开显示：与本日炸班班次同名的标红，点标红班次可看该骑手近三天这个班次的日期 / 是否达标 / 有效时长 / 有效完单。");
  tips.push("名单取自考勤「排班状态 = 排班」的记录，与排班统计的「排班人数」可能差 1–2 人。");
  $("fr-note").innerHTML = tips.join(" ");

  // 列宽自适应：不写死 colgroup，交给 table-layout:auto 按内容分列；
  // 「T+1排班」允许整段换行，宁可把行撑高也不截断。
  const head = `<thead><tr><th>站点</th><th>姓名+id</th><th class="num">异常次数</th>` +
    P.map((p) => `<th class="per" title="${esc(p)}：✓ 达标 / ✗ 炸班 / 空 = 未排该班">${esc(p)}</th>`).join("") +
    `<th class="num" title="${hDates[0]} 炸班班次数">T-3</th>` +
    `<th class="num" title="${hDates[1]} 炸班班次数">T-2</th>` +
    `<th class="num" title="${hDates[2]} 炸班班次数">T-1</th>` +
    `<th title="T = 当前所选日期；T+1 = 所选日期的次日排班。查历史日期时显示该日 + 1 天，不是真实的明天">T+1排班</th></tr></thead>`;

  const body = ["<tbody>"];
  for (const r of rows) {
    const site = String(r.site || "").replace(/^福州/, "");
    const tm = tomorrow.get(r.rid);
    const tmText = tm ? (tm.length ? tm.join("、") : "休息") : "—";
    const tmHtml = tm && tm.length
      ? tm.map((p) => {
          const hit = r.bad.has(p);      // T+1 又排了本日炸掉的那个班 → 标红可点
          return `<span class="rm-shift${hit ? " hit" : ""}"` +
            (hit ? ` data-rid="${esc(r.rid)}" data-per="${esc(p)}" role="button" tabindex="0"` +
              ` title="${esc(p)}：本日炸班，点击查看近三天该班次追溯"` : "") +
            `>${esc(p)}</span>`;
        }).join(`<i class="rm-sep">、</i>`)
      : esc(tmText);
    body.push(`<tr>` +
      `<td class="rm-site" title="${esc(r.site)}">${esc(site)}</td>` +
      `<td class="rm-who"><b>${esc(r.name)}</b><span>${esc(r.rid)}</span></td>` +
      `<td class="num rm-cnt">${fmt(r.cnt)}</td>` +
      r.cells.map((c, i) => `<td class="rm-cell${c ? " " + c : " blank"}" data-per="${esc(P[i])}">` +
        (c === "no" ? `<i class="mk no">✗</i>` : c === "ok" ? `<i class="mk ok">✓</i>` : "") +
        `</td>`).join("") +
      hDates.map((d) => `<td class="num rm-hist" title="${d}">${histCell(d, r.rid)}</td>`).join("") +
      `<td class="rm-tmr" title="${esc(tmText)}">${tmHtml}</td></tr>`);
  }
  body.push("</tbody>");
  tbl.innerHTML = head + body.join("");
  return total;
}
function render() {
  const a = state.assess;
  if (!a) return;
  const att = a.attendance;
  const now = state.finishedAt || new Date();
  const blocks = $("att-blocks");
  const history = state.mode === "history";
  const modeLabel = history ? "历史明细" : "实时快照";
  let failShown = 0, skippedPeriods = [], shownCount = 0, dayHidden = 0;

  $("mode-tag").textContent = modeLabel;
  $("mode-tag").className = "mode-tag" + (history ? " history" : "");
  $("auto").disabled = history;
  $("auto").title = history ? "历史日期为定稿数据，无需自动刷新" : "今天的实时快照每 5 分钟自动刷新";
  $("btn-today").classList.toggle("date-active", !history);
  $("btn-t1").classList.toggle("date-active", state.date === shiftDate(todayStr(), -1));
  if ($("date-picker").value !== state.date) $("date-picker").value = state.date;
  syncDateNav();
  $("doc-note").textContent = history
    ? "数据源：排班统计（应排人数 / 排班人数）+ 出勤统计历史时段明细（有效在线时长 / 完单量）；全天达成按有效在线≥6小时且完单≥18单手工判定，不采用系统的全天达成标记"
    : "数据源：排班统计（应排人数 / 排班人数）+ 实时考勤（排班状态 / 时段有效在线 / 时段完单）；有效出勤按 KPI 时段标准双达标去重，全天按 6h / 18 单";
  $("doc-foot-small").textContent = history
    ? `注：${state.date} 为历史日期，取次日定稿的时段明细，不再显示「统计中」；全天达成忽略系统的「是否达成」标记，按 6h / 18 单手工计算；两张表按当日排班实际班次动态生成列`
    : "注：考勤为当日实时快照，只列已结束的班次（未跑完的班次结束后自动出现）；下方炸班明细为「一人一行 × 时段列」矩阵，默认不含「全天」列（今天未结束，判定不准，可在清单标题右侧手动打开）；T-3 / T-2 / T-1 取近三天的出勤明细；两张表按当日排班实际班次动态生成列，宽表可左右滑动查看全部时段";

  if (!att || !att.ok) {
    // 排班 / 考勤任一侧取不到时，别把两张空表塞进「复制图片」的画面
    blocks.hidden = true;
    $("fail-roster").hidden = true;
    const why = att && att.missing.length ? att.missing.join("、") + " 未取到" : "排班 / 考勤未取到";
    $("att-kpi").innerHTML = `<span class="muted">出勤达成暂不可用：${esc(why)}</span>`;
    $("att-note").textContent = history
      ? "本页需要排班统计（应排人数 / 排班人数）与出勤统计时段明细（骑手ID / 站点 / 是否排班 / 时段 / 有效在线时长 / 完单量）同时可用；数据取到后会自动显示两张达成表。"
      : "本页需要排班统计（应排人数 / 排班人数）与实时考勤（排班状态 / 时段 / 时段有效在线时长 / 时段完单量）同时可用；数据取到后会自动显示两张达成表。";
  } else {
    blocks.hidden = false;
    const day = att.totals["全天"] || { due: 0, real: 0, valid: 0, realRate: null, dueRate: null };
    const rateAll = attPeriodRate(att.totals, att);   // v3.20.0：整商加权值（总计行同一个数）
    $("att-kpi").innerHTML =
      `整商全天：应排 <b>${fmt(day.due)}</b> · 实排 <b>${fmt(day.real)}</b> · 有效出勤 <b>${fmt(day.valid)}</b>` +
      `　｜　实排达成 <b>${day.realRate == null ? "—" : attPct(day.realRate)}</b>` +
      ` · 应排达成 <b>${day.dueRate == null ? "—" : attPct(day.dueRate)}</b>` +
      ` · 时段排班率 <b>${rateAll.value == null ? "—" : attPct(rateAll.value)}</b>`;
    let note = `应排 = 排班统计「应排人数」；实排 = 「排班人数」；有效出勤 = 考勤「排班状态=排班」且` +
      `（时段有效在线≥该时段标准 且 时段完单≥该时段标准）的去重骑手数，全天按 6h / 18 单。` +
      `实排达成 = 有效出勤÷实排；应排达成 = 有效出勤÷应排（多排班可 >100%，不封顶）。` +
      `末列「时段排班率」= Σ(11 时段完成率 × 时段权重)/100：已结束班次按 min(有效出勤/应排,100%)，` +
      `今天未开始 / 进行中的班次按 min(排班/应排,100%) 补，无该班次或应排 0 按 100%；` +
      `当前权重合计 ${attPct(rateAll.wsum)}，与排班模块「时段权重」面板共用（改一次两边同步）。`;
    note += history
      ? ` 历史日期取「出勤统计 → 导出明细数据」的骑手时段明细；系统全天行「是否达成」标记有误，本页忽略它，按有效在线≥6小时且完单≥18单手工判定。`
      : ` 今天只显示 <b>已结束</b> 的班次：未跑完的班次人还在陆续上线、单还在攒，算成不达标没意义，结束后会自动出现。` +
        ` 下方炸班明细矩阵默认也不给 <b>全天</b> 列：一天没过完，按 6h / 18 单判「全天未达标」不准，` +
        `可在清单标题右侧手动打开，仅供参考。`;
    if (att.degraded) {
      note += ` <span class="warn-text">考勤导出缺少「完单量」列，有效出勤已降级为只看有效在线时长。</span>`;
    }
    const P = periodsFor(att);
    const skipped = history ? [] : att.periods.filter((p) => p !== "全天" && (att.ongoing || []).includes(p));
    if (skipped.length && P.length <= 1) {
      note += ` <span class="warn-text">今天还没有已结束的班次（${skipped.join("、")} 进行中），矩阵先只看全天。</span>`;
    }
    $("att-note").innerHTML = note;
    $("att-title-real").textContent = `${state.date} · 实排达成（有效出勤 / 实排）`;
    $("att-title-due").textContent = `${state.date} · 应排达成（有效出勤 / 应排）`;
    renderAttTable("table3", att, "real", P);
    renderAttTable("table4", att, "due", P);
    // 矩阵用 P（保留全天），清单用 rosterPeriods（T0 默认再去掉全天）
    failShown = renderRosterMatrix(att, rosterPeriods(att, P));
    dayHidden = (isToday(state.date) && !state.rosterDay) ? dayFailCount(att) : 0;
    skippedPeriods = skipped;
    shownCount = P.length - 1;
  }

  $("doc-sub").innerHTML = `考核日期 ${state.date} · ${modeLabel}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${hhmm(now)}`;
  $("sub").innerHTML =
    `排班 <b>${a.scheduleOk ? "✓" : "…"}</b> · 考勤 <b>${a.attendanceOk ? "✓" : "…"}</b>` +
    ` · <b>${att ? att.rows.length : 0}</b> ${a.areaLabel}` +
    ` · 数据源 <b>${modeLabel}</b>` +
    ` · 更新 <b>${hhmm(now)}</b>` +
    ` · 通道 <b>${state.via === "bridge" ? "静默桥接" : "直连"}</b>`;

  // 没进清单的人次单独交代清楚：全天（T0 默认关） + 未结束班次，别让人以为漏了人
  const excludedFails = att && att.ok ? Math.max(0, (att.failTotal || 0) - failShown) : 0;
  const excludedBits = [];
  const dayPart = Math.min(dayHidden, excludedFails);
  if (dayPart > 0) excludedBits.push(`全天 ${fmt(dayPart)} 人次（今天未结束，默认关闭）`);
  if (excludedFails - dayPart > 0) excludedBits.push(`未结束班次 ${fmt(excludedFails - dayPart)} 人次`);
  const excludedText = excludedFails
    ? `（另有 ${fmt(excludedFails)} 人次暂不计入：${excludedBits.join(" + ")}）` : "";

  $("foot-meta").textContent =
    `考核日期 ${state.date} · 数据源：${history
      ? "exportSchedule/1.0 + exportStatisticsDetail/1.0（历史时段明细，全天按 6h / 18 单手工判定）"
      : "exportSchedule/1.0 + exportAttendance/1.0（实时快照）"}（跟随当前登录账号，不拉运单明细）` +
    ` · 站点范围：${esc(state.teamSource || "待确定")}${state.teamCount ? `（${state.teamCount} 个站点）` : ""}` +
    (att ? ` · 时段矩阵：按当日排班 ${att.periods.length - 1} 个班次动态生成（${att.periods.join(" / ")}）` +
      (skippedPeriods.length ? `，今天只显示已结束的 ${shownCount} 个（${skippedPeriods.join("、")} 进行中）` : "") : "") +
    (a.unknownPeriods && a.unknownPeriods.length
      ? ` · 排班中有未识别班次：${a.unknownPeriods.join("、")}（字典无对应时间区间，未纳入矩阵）` : "") +
    (att && !att.ok && att.missing.length ? ` · 缺少列：${att.missing.join("、")}` : "") +
    ` · 口径与 config.py / review_report.py 一致 · ${a.mapped ? "已匹配钉钉商圈片分组" : "按接口原生商圈分组"}` +
    (state.dataNote ? ` · ${state.dataNote}` : "") +
    (state.detailStats ? ` · 历史明细 ${state.detailStats.rows} 行 / ${state.detailStats.riders} 名骑手` : "") +
    (att && att.ok
      ? ` · 炸班 ${fmt(failShown)} 个班次已按「一人一行 × 时段列」列在下方矩阵里` + excludedText +
        ` · T-3 / T-2 / T-1 取大前天 / 前天 / 昨日的出勤明细` +
        `；点表格任一单元格可只看该格，弹窗不进入导出图` : "") +
    (state.startedAt && state.finishedAt ? ` · 本次耗时 ${((state.finishedAt - state.startedAt) / 1000).toFixed(0)}s` : "");

  // 两张表都已渲染，最后按当前页签决定显示哪一张（数据缺失时整块隐藏，这里只切内部状态）
  applyView();
  applyRosterDay();   // 切日期后开关该不该出现、是不是勾选态，跟着一起摆好
}

// ---------------------------------------------------------------- 炸班明细弹窗
// 「炸班」= 排了班（排班状态=排班）但当班次没达到有效出勤标准的骑手：
//   要么没上线 / 有效在线为 0，要么有效在线不足，要么完单不够。
// 点击实排 / 应排表里的任一单元格，展开该片区 × 该班次的这批人，直接看有效时长与完单。
const minsText = (n) => {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 60) return v + " 分";
  const h = Math.floor(v / 60), m = v % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

function openFailModal(area, per) {
  const a = state.assess && state.assess.attendance;
  if (!a || !a.ok) return;
  const list = failListOf(a, area, per);
  const row = (a.rows || []).find((r) => r.area === area);
  const c = (row && row.cells[per]) || { due: 0, real: 0, valid: 0, realRate: null };
  const std = per === "全天"
    ? (a.dayStandard || { timeMin: 0, orders: 0 })
    : ((a.standards && a.standards[per]) || { timeMin: 0, orders: 0 });

  $("fail-title").textContent = `${shortArea(area)} · ${per} · 炸班 ${list.length} 人`;
  $("fail-sub").textContent =
    `应排 ${fmt(c.due)} · 实排 ${fmt(c.real)} · 有效出勤 ${fmt(c.valid)}` +
    ` · 实排达成 ${c.realRate == null ? "—" : attPct(c.realRate)}` +
    `　｜　标准：有效在线 ≥${minsText(std.timeMin)} 且 完单 ≥${std.orders} 单`;

  const ongoing = (a.ongoing || []).includes(per);
  const tips = [];
  if (ongoing) {
    tips.push("该班次尚未结束（实时快照），下面这些骑手可能还在补齐有效时长 / 完单，稍后会自动刷新。");
  }
  tips.push("明细取自考勤「排班状态 = 排班」的骑手记录，与排班统计的「排班人数」可能相差 1–2 人（两套表口径不同）。");
  if (!list.length) tips.unshift("该班次排班的骑手全部达到有效出勤标准，没有炸班。");
  $("fail-tip").textContent = tips.join(" ");

  if (!list.length) {
    $("fail-tbl").innerHTML = `<tbody><tr><td class="fail-empty">— 无炸班骑手 —</td></tr></tbody>`;
  } else {
    const head = `<thead><tr><th>骑手</th><th>站点</th><th>有效在线</th><th>完单</th><th>未达标原因</th></tr></thead>`;
    const body = list.map((x) => {
      const bad = x.reason === "未出勤";
      return `<tr class="${bad ? "off" : ""}">` +
        `<td class="who"><b>${esc(x.name || "—")}</b><span>${esc(x.rid || "")}</span></td>` +
        `<td class="site" title="${esc(x.site)}">${esc(String(x.site || "").replace(/^福州/, ""))}</td>` +
        `<td>${minsText(x.min)}</td>` +
        `<td>${fmt(x.orders)}</td>` +
        `<td class="why">${esc(x.reason)}</td></tr>`;
    }).join("");
    $("fail-tbl").innerHTML = head + `<tbody>${body}</tbody>`;
  }
  $("fail-modal").hidden = false;
  document.body.classList.add("fail-open");
  const x = $("fail-x");
  if (x && x.focus) x.focus();
}

function closeFailModal() {
  const m = $("fail-modal");
  if (!m || m.hidden) return false;
  m.hidden = true;
  document.body.classList.remove("fail-open");
  return true;
}

function bindFailModal() {
  for (const id of ["table3", "table4"]) {
    const t = $(id);
    if (!t) continue;
    t.addEventListener("click", (e) => {
      const td = e.target.closest && e.target.closest("td.att-cell[data-area]");
      if (!td) return;
      openFailModal(td.dataset.area, td.dataset.per);
    });
  }
  const m = $("fail-modal");
  if (m) m.addEventListener("click", (e) => {
    if (e.target === m || (e.target.dataset && e.target.dataset.close !== undefined)) closeFailModal();
  });
  const x = $("fail-x");
  if (x) x.addEventListener("click", closeFailModal);
}

// ---------------------------------------------------------------- 次日班次异常追溯弹窗（v3.14.0）
// 点「T+1排班」里标红的班次，列出该骑手近三天（T-3 / T-2 / T-1）在同一班次的
// 日期 / 是否达标 / 有效时长 / 有效完单。数据来自同一份历史出勤明细（state.histDetail），
// 按日期缓存，点开时 0 额外请求。弹窗在 #sheet 之外，不会进「复制图片」。
function riderMeta(rid) {
  const att = state.assess && state.assess.attendance;
  for (const list of Object.values((att && att.fails) || {})) {
    for (const x of list) {
      if (String(x.rid) === String(rid)) return { name: x.name || "—", site: x.site || "" };
    }
  }
  return { name: "—", site: "" };
}

function closeHistModal() {
  const m = $("hist-modal");
  if (!m || m.hidden) return false;
  m.hidden = true;
  const other = $("fail-modal");
  if (!other || other.hidden) document.body.classList.remove("fail-open");
  for (const tr of document.querySelectorAll("#table5 tr.hist-open")) tr.classList.remove("hist-open");
  return true;
}

function openHistModal(rid, per) {
  const m = $("hist-modal");
  if (!m) return;
  closeFailModal();                       // 两个弹窗不叠着开
  const att = state.assess && state.assess.attendance;
  const defs = (typeof ASSESS !== "undefined" && ASSESS.PERIOD_DEFS) || [];
  const std = (att && att.standards && att.standards[per]) || defs.find((d) => d.name === per);
  const who = riderMeta(rid);
  const site = String(who.site || "").replace(/^福州/, "");
  $("hist-title").textContent = `${per} · 近三天班次异常追溯`;
  $("hist-sub").textContent = `${who.name}（${rid}）${site ? " · " + site : ""} · 本日该班次炸班`;
  $("hist-tip").innerHTML = (std
    ? `判定口径与当天一致：<b>有效时长 ≥ ${minsText(std.timeMin)}</b> 且 <b>有效完单 ≥ ${fmt(std.orders)} 单</b> 才算达标，任一不足即炸班。`
    : "判定口径与当天一致，有效时长与完单同时达标才算达标。") +
    "数据取「出勤统计 → 导出明细数据」中该骑手该时段的记录；当天没排这个班或明细未生成时，该行会给出提示。";

  const dates = [-3, -2, -1].map((k) => shiftDate(state.date, k));
  const labels = ["大前天", "前天", "昨日"];
  const rows = dates.map((d, i) => {
    const dayMap = state.histDetail.get(d);
    const byPer = dayMap && dayMap.get(String(rid));
    const rec = byPer && byPer.get(per);
    const day = `<td class="hist-date">${d}<span>${labels[i]}</span></td>`;
    if (!rec) {
      const why = state.histPending.has(d) ? "取数中…"
        : state.histErrors.has(d) ? "明细未取到（" + esc(state.histErrors.get(d)) + "）"
          : "未排该班 / 无明细";
      return `<tr>${day}<td colspan="3" class="hist-none">${why}</td></tr>`;
    }
    const mark = rec.ok ? `<i class="mk ok">✓ 达标</i>` : `<i class="mk no">✗ 未达标</i>`;
    return `<tr${rec.ok ? "" : " class=\"off\""}>${day}<td>${mark}</td>` +
      `<td>${minsText(rec.min)}</td><td>${fmt(rec.orders)} 单</td></tr>`;
  }).join("");
  $("hist-tbl").innerHTML =
    `<thead><tr><th>日期</th><th>是否达标</th><th>有效时长</th><th>有效完单</th></tr></thead>` +
    `<tbody>${rows}</tbody>`;
  m.hidden = false;
  document.body.classList.add("fail-open");
  const x = $("hist-x");
  if (x && x.focus) x.focus();
}

function bindHistModal() {
  const t = $("table5");
  if (t) {
    const openFrom = (s) => {
      if (!s) return false;
      const tr = s.closest && s.closest("tr");
      if (tr) tr.classList.add("hist-open");
      openHistModal(s.dataset.rid, s.dataset.per);
      return true;
    };
    const hitOf = (e) => e.target.closest &&
      e.target.closest(".rm-shift.hit[data-rid][data-per]");
    t.addEventListener("click", (e) => { openFrom(hitOf(e)); });
    t.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const s = hitOf(e);
      if (!s) return;
      e.preventDefault();
      openFrom(s);
    });
  }
  const m = $("hist-modal");
  if (m) m.addEventListener("click", (e) => {
    if (e.target === m || (e.target.dataset && e.target.dataset.close !== undefined)) closeHistModal();
  });
  const x = $("hist-x");
  if (x) x.addEventListener("click", closeHistModal);
}

// ---------------------------------------------------------------- 主流程
// 站点范围与考核看板共用同一份缓存（TEAM_KEY），两页之间不重复查运单
const TEAM_KEY = "wb_team_ids_v1";

async function resolveTeamIds(gen) {
  const ids = new Set();
  // ① 两个看板共用的「记住的站点范围」：绝大多数情况走这里，0 请求
  try {
    const saved = JSON.parse(localStorage.getItem(TEAM_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      for (const id of saved) { const v = String(id || "").trim(); if (v) ids.add(v); }
      if (ids.size) { state.teamSource = "记住的站点范围"; return [...ids]; }
    }
  } catch (e) { /* 解析失败当作没有 */ }
  try {
    // 历史日期先看当天缓存，没有再借今天的缓存：站点范围一般不随日期变化
    const days = [...new Set([state.date, todayStr()])];
    for (const day of days) {
      const res = (typeof WB_SYNC !== "undefined")
        ? await WB_SYNC.read(day, localStorage.getItem("wb_agency") || "") : null;
      if (res && res.ok && res.cache && Array.isArray(res.cache.rows)) {
        for (const r of res.cache.rows) {
          const id = String((r && r.teamId) || "").trim();
          if (id) ids.add(id);
        }
      }
      if (ids.size) {
        try { localStorage.setItem(TEAM_KEY, JSON.stringify([...ids])); } catch (e) { /* ignore */ }
        state.teamSource = "旧运单缓存（只读 teamId）";
        return [...ids];
      }
    }
  } catch (e) { /* 缓存不可用时继续走接口 */ }
  if (gen !== state.gen) return [];
  try {
    setProgress(1, 1, "teams");
    const d = await callApi(API_QUERY, buildQueryPayload(1), true);
    if (gen !== state.gen) return [];
    for (const r of (Array.isArray(d.data) ? d.data : [])) {
      const id = String((r && r.teamId) || "").trim();
      if (id) ids.add(id);
    }
    if (ids.size) {
      try { localStorage.setItem(TEAM_KEY, JSON.stringify([...ids])); } catch (e) { /* ignore */ }
    }
    state.teamSource = "首次识别（1 页运单取 teamId）";
  } catch (e) {
    state.teamSource = "账号默认范围";
    state.errors.push("站点范围查询失败：" + (e.message || String(e)));
  }
  return [...ids];   // 为空时导出接口按当前账号的默认范围返回
}

/** 按所选日期取考勤：今天走实时快照 xlsx，历史日期走时段明细 xlsx 并标准化 */
async function loadAttendanceSheets(mode, teamIds, date) {
  if (mode === "live") {
    return { sheets: await loadExportSheet(API_ATTENDANCE, "attendance", teamIds, date), stats: null };
  }
  const detail = await loadExportSheet(API_ATT_DETAIL, "detail", teamIds, date);
  const conv = ASSESS.detailToAttendance(detail, date, XLSX_READER);
  if (conv.error) throw new Error(conv.error);
  return { sheets: conv.sheets, stats: conv.stats };
}

// ---------------------------------------------------------------- T-3 / T-2 / T-1 历史异常（v3.14.0）
// 主表先出图，再异步并行补三天数据：每天 1 次「出勤统计 → 导出明细数据」，
// 标准化后按与当天相同的时段标准手工判定，按骑手汇总炸班班次数。
// 按日期缓存，切日期/刷新不重复拉；任一天失败只让那一列显示「—」，不影响主表。
async function loadHistFails(gen) {
  if (window.__WB_TEST__) return;   // 真机测试走 __SET_HIST__ 注入，不发真请求
  const att = state.assess && state.assess.attendance;
  if (!att || !att.ok) return;
  const dates = [-3, -2, -1].map((k) => shiftDate(state.date, k));
  const todo = dates.filter((d) => !state.histFails.has(d) && !state.histPending.has(d));
  if (!todo.length) return;
  for (const d of todo) state.histPending.add(d);
  render();                                   // 先把「…」摆出来，别让格子像忘了做
  const teamIds = state.teamIds || [];
  await Promise.allSettled(todo.map(async (d) => {
    try {
      const detail = await loadExportSheet(API_ATT_DETAIL, "detail", teamIds, d);
      const conv = ASSESS.detailToAttendance(detail, d, XLSX_READER);
      if (conv.error || !conv.sheets || !conv.sheets.length) {
        throw new Error(conv.error || "明细为空");
      }
      // 明细留全量（含达标行）：点标红班次追溯近三天时要显示时长 / 完单 / 是否达标；
      // T-3 / T-2 / T-1 单元格只取其中的炸班班次数。
      const dayMap = histDayMap(conv.sheets, att.standards);
      state.histDetail.set(d, dayMap);
      state.histFails.set(d, histCounts(dayMap));
      state.histErrors.delete(d);
    } catch (e) {
      state.histDetail.delete(d);
      state.histErrors.set(d, (e && e.message) ? e.message : String(e));
    } finally {
      state.histPending.delete(d);
    }
  }));
  if (gen !== state.gen) return;              // 已经切了别的日期，别覆盖新画面
  render();                                   // 三天都回来后一次性重画
}

async function loadAll(opts) {
  if (state.loading) return;
  const force = !!(opts && opts.force);
  const gen = ++state.gen;
  state.loading = true;
  const date = state.date;
  const mode = isToday(date) ? "live" : "history";
  Object.assign(state, {
    mode, schSheets: [], attSheets: [], assess: null, detailStats: null,
    errors: [], fallbackTried: false,
    dataNote: "", startedAt: new Date(), finishedAt: null, teamSource: "", teamCount: 0
  });
  setBusy(true); clearNotice(); setProgress(0, 1, "connect");

  // 历史数据是定稿快照，切回同一天直接复用内存结果；「立即刷新」强制重拉
  const memoKey = date + ":" + state.via;
  const memo = force ? null : state.memo.get(memoKey);
  if (memo) {
    state.schSheets = memo.sch;
    state.attSheets = memo.att;
    state.detailStats = memo.detailStats || null;
    state.teamSource = memo.teamSource || "";
    state.teamCount = memo.teamCount || 0;
    state.finishedAt = memo.finishedAt || new Date();
    state.dataNote = "已复用本机缓存的该日期数据，点「立即刷新」可重新拉取";
    recompute(); render(); setProgress(1, 1, "done");
    state.loading = false; setBusy(false);
    loadHistFails(gen);
    return;
  }

  try {
    const teamIds = await resolveTeamIds(gen);
    if (gen !== state.gen) return;
    state.teamIds = teamIds;
    state.teamCount = teamIds.length;
    if (!teamIds.length) {
      showNotice("站点范围为空：历史出勤明细必须带站点 ID。请先打开一次「考核看板」让它写入运单缓存，或点「立即刷新」重试。", "blue");
    }
    setProgress(1, 1, "export");
    const results = await Promise.allSettled([
      loadExportSheet(API_SCHEDULE, "schedule", teamIds, date),
      loadAttendanceSheets(mode, teamIds, date)
    ]);
    if (gen !== state.gen) return;
    if (results[0].status === "fulfilled") state.schSheets = results[0].value;
    if (results[1].status === "fulfilled") {
      state.attSheets = results[1].value.sheets;
      state.detailStats = results[1].value.stats;
    }
    const attLabel = mode === "history" ? "历史出勤明细" : "考勤";
    const failed = [];
    if (results[0].status === "rejected") failed.push("排班（" + results[0].reason.message + "）");
    if (results[1].status === "rejected") failed.push(attLabel + "（" + results[1].reason.message + "）");
    if (failed.length) {
      state.dataNote = "部分数据未取到：" + failed.join("、");
      showNotice(`排班 / ${attLabel}未全部取到：${esc(failed.join("；"))}。请确认已在本浏览器登录风神（a.ele.me），或点「通道」切换取数方式后重试。`);
    }
    recompute();
    state.finishedAt = new Date();
    render();
    setProgress(1, 1, "done");
    if (!failed.length) {
      state.memo.set(memoKey, {
        sch: state.schSheets, att: state.attSheets, detailStats: state.detailStats,
        teamSource: state.teamSource, teamCount: state.teamCount, finishedAt: state.finishedAt
      });
    }
    const att = state.assess.attendance;
    if (!att.ok && !failed.length) {
      showNotice(`出勤达成暂不可用：${esc(att.missing.length ? att.missing.join("、") + " 未取到" : "排班统计 / " + attLabel + "表结构不匹配")}。请确认导出的 xlsx 含所需列，或点「立即刷新」重试。`);
    }
    loadHistFails(gen);
  } catch (e) {
    setProgress(1, 1, "err");
    showNotice("同步失败：" + esc(e.message || String(e)) + "。请确认已在本浏览器登录风神（a.ele.me），且已在 chrome://extensions 重新加载扩展。");
  } finally {
    if (gen === state.gen) { state.loading = false; setBusy(false); }
  }
}
function restart(force) { state.gen++; state.loading = false; loadAll({ force: !!force }); }

// ---------------------------------------------------------------- 日期选择
/** 到边界就把箭头置灰：最左 = 90 天前，最右 = 今天，避免点了没反应 */
function syncDateNav() {
  const today = todayStr();
  $("btn-prev-day").disabled = state.date <= shiftDate(today, -HISTORY_DAYS);
  $("btn-next-day").disabled = state.date >= today;
  $("btn-prev-day").title = $("btn-prev-day").disabled
    ? `已到可查范围最早日期（最近 ${HISTORY_DAYS} 天）` : "往前一天（更早）";
  $("btn-next-day").title = $("btn-next-day").disabled
    ? "已是今天，不能查看未来日期" : "往后一天（更近）";
}
function setDate(date) {
  const today = todayStr();
  if (!validDate(date) || date > today || date < shiftDate(today, -HISTORY_DAYS)) {
    showNotice(`只能查最近 ${HISTORY_DAYS} 天（含今天），已保持 ${state.date}。`, "blue");
    $("date-picker").value = state.date;
    return;
  }
  if (date === state.date) return;
  state.date = date;
  state.mode = isToday(date) ? "live" : "history";
  localStorage.setItem("wb_att_date", date);
  $("date-picker").value = date;
  syncDateNav();   // 数据还在拉取时也立即更新箭头状态
  restart(false);
}
$("date-picker").addEventListener("change", (e) => setDate(e.target.value));
$("btn-today").addEventListener("click", () => setDate(todayStr()));
$("btn-t1").addEventListener("click", () => setDate(shiftDate(todayStr(), -1)));
$("btn-prev-day").addEventListener("click", () => setDate(shiftDate(state.date, -1)));
$("btn-next-day").addEventListener("click", () => setDate(shiftDate(state.date, 1)));

// ---------------------------------------------------------------- 事件
$("btn-refresh").addEventListener("click", () => restart(true));
$("btn-copy-image").addEventListener("click", async (e) => {
  const btn = $("btn-copy-image");
  if (btn.disabled) return;
  if (!window.WB_CAPTURE) {
    showNotice("图片模块未加载：请在 chrome://extensions 重新加载扩展，或安装新版 zip。");
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "正在生成图片…";
  clearNotice();
  try {
    const date = state.date.replace(/-/g, "");
    const r = await WB_CAPTURE.capture({
      download: e.shiftKey, date,
      rootId: "sheet", filename: `风神出勤达成_${date}.png`
    });
    const size = `${r.width}×${r.height}`;
    showNotice(r.mode === "clipboard"
      ? `已复制出勤达成图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`
      : r.mode === "download"
        ? `出勤达成图片已另存为 PNG 文件（${size}）。`
        : `当前环境不允许写入剪贴板，已自动下载 PNG 图片（${size}）。`, "blue");
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}。可先点「纯净看板」，再用系统截图工具替代。`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
// 「考核看板 ↗」：切回原入口的独立页面；在悬浮面板里切换页签，独立标签页则新开一个标签
$("btn-goto-assess").addEventListener("click", () => {
  if (window.parent !== window) {
    window.parent.postMessage({ __wbAssess: true, type: "SWITCH", mode: "assess" }, "*");
  } else {
    extMsg({ type: "WB_OPEN_TAB", page: "assess" }).catch(() => {});
  }
});
$("auto").addEventListener("change", (e) => localStorage.setItem("wb_att_auto", e.target.checked ? "1" : "0"));
$("btn-channel").addEventListener("click", async () => {
  const next = state.via === "direct" ? "bridge" : "direct";
  await switchChannel(next, next === "bridge"
    ? "已切到「静默桥接」：后台标签页取数，不会打断浏览。"
    : "已切回「直连」：完全不打开任何页面，由插件页面直接请求接口。");
  restart(true);
});
$("btn-clean").addEventListener("click", () => {
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
setInterval(() => {
  // 历史日期是定稿数据，不需要每 5 分钟重拉；只有「今天」的实时快照才自动刷新
  if (!$("auto").checked || state.loading || document.hidden || state.mode !== "live") return;
  loadAll();
}, REFRESH_MS);

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 弹窗打开时 Esc 只关弹窗，不要把整个看板面板也关掉
  if (closeHistModal()) return;
  if (closeFailModal()) return;
  if (window.parent !== window) {
    window.parent.postMessage({ __wbAssess: true, type: "CLOSE" }, "*");
  }
});

// 离线渲染验证用的注入钩子（生产环境不会主动调用）
window.__SET_DATA__ = (sch, att, date, mode) => {
  if (date && validDate(date)) {
    state.date = date;
    localStorage.setItem("wb_att_date", date);
    $("date-picker").value = date;
  }
  state.schSheets = sch || [];
  state.attSheets = att || [];
  state.finishedAt = new Date();
  recompute();
  if (mode === "history" || mode === "live") { state.mode = mode; render(); }
};
// 测试用：注入 T-3/T-2/T-1。第一个参数是「日期 -> {骑手id: 异常班次数}」，
// 第二个参数可选，是「日期 -> {骑手id: {班次: {min, orders, ok}}}」的追溯明细。
window.__SET_HIST__ = (obj, detail) => {
  state.histPending.clear();
  state.histErrors.clear();
  state.histFails.clear();
  state.histDetail.clear();
  for (const [d, m] of Object.entries(obj || {})) {
    state.histFails.set(d, new Map(Object.entries(m || {})));
  }
  for (const [d, byRider] of Object.entries(detail || {})) {
    const dayMap = new Map();
    for (const [rid, byPer] of Object.entries(byRider || {})) {
      const perMap = new Map();
      for (const [per, rec] of Object.entries(byPer || {})) {
        perMap.set(per, {
          min: Number(rec && rec.min) || 0,
          orders: Number(rec && rec.orders) || 0,
          ok: !!(rec && rec.ok)
        });
      }
      dayMap.set(String(rid), perMap);
    }
    state.histDetail.set(d, dayMap);
  }
  render();
};

(async function init() {
  bindFailModal();
  bindHistModal();
  bindViewSwitch();
  bindRosterDay();
  // v3.20.0：排班模块改了时段权重 → 本机实时重算，不用刷新页面、不发任何请求
  window.addEventListener("storage", (e) => {
    if (e.key && e.key !== ATT_LS_WEIGHTS) return;
    state.weights = loadAttWeights();
    if (state.assess && state.assess.attendance && state.assess.attendance.ok) render();
  });
  applyView();       // 按上次选的页签先把显示摆好，数据到了再渲染表格
  applyRosterDay();  // 全天开关默认关，历史日期下先藏起来
  const a = localStorage.getItem("wb_att_auto"); if (a != null) $("auto").checked = a === "1";
  const saved = localStorage.getItem("wb_att_date");
  const today = todayStr();
  if (validDate(saved) && saved <= today && saved >= shiftDate(today, -HISTORY_DAYS)) state.date = saved;
  state.mode = isToday(state.date) ? "live" : "history";
  $("date-picker").value = state.date;
  $("date-picker").max = today;
  $("date-picker").min = shiftDate(today, -HISTORY_DAYS);
  syncDateNav();
  $("btn-channel").textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) loadAll();
})();
