// 风神考核看板（插件版 v3.10.0）—— 与 fengshen-data/assess_image.py 生成的钉钉看板同口径、同排版
// 数据源全部在插件内获取，跟随当前浏览器登录态：
//   1) exportSchedule/1.0     -> 排班 xlsx（规划单量 / 应排骑手 / 时段预估单量）
//   2) exportAttendance/1.0   -> 实时考勤 xlsx（全天 / 时段有效在线时长 + 完单量）
//   3) exportStatisticsDetail/1.0 -> 历史日期的出勤明细（骑手 × 时段，同样含时长与完单量）
//   4) queryTracking/2.0 (isReassign=1) -> 只查当日人工改派单，用于标1–标5 剔除
// 不访问任何本地服务，不依赖 Python。v3.9.0 起不再同步运单明细：完单量直接取自考勤统计。
//
// v3.3.0：运单改为增量同步（sync.js 持久化当日缓存 + 终态时间水位窗口 + total 对账）。
//   刷新时先用缓存秒开渲染，再只查「终态水位 - 15min ~ 现在」拿新单/状态变更。
//   全量只发生在：首次 / 跨天 / 换商 / 缓存异常 / 撤单 / 连续 3 次对账未补齐 / 手动「全量重拉」。
// v3.3.6：标2 / 完单达标只认「非人工改派」的配送成功单（isReassign != 1，KPI 第十三条）；
//   片区「实际完单 / 订单完成率 / 时段完单」口径不变，仍按全部配送成功单统计。
// v3.4.0：工具条「复制图片」把 #sheet 渲染成 2 倍高清 PNG 写入剪贴板（capture.js），
//   剪贴板不可用时自动降级为下载 PNG；Shift+点击直接另存为文件。
// v3.4.1：时段矩阵改为按当日排班实际班次动态生成（assess.js 两遍扫描排班表），
//   表 2 随班次数量动态压缩子列宽、保持 1218px 总宽不撑破「复制图片」画布。
// v3.4.2：字体改用系统默认 UI 字体栈并统一数字等宽；移除 compact 的 10/11px 压缩，
//   班次变多时只压缩列宽、字号一律保持常规（一级表头 colspan=2 本就足够宽）。
// v3.4.3：取消「每 30 分钟强制全量校准」（自动刷新 5min → 每半小时必全量一次），
//   改为滚动分片状态校准（每 30 分钟只查 1 片 2 小时历史窗口，仍是增量）；
//   对账放宽：接口入库延迟不再降级全量，保留缓存 + 水位不推进 + 下次续补，
//   连续 3 次补不齐才回退全量；只有 total 变小（撤单）才立即重建。
// v3.9.0：考核看板不再同步运单，完单直接取「出勤统计」。
//   出勤统计本身是 骑手 × 时段 粒度，每行同时带「有效在线时长」和「完单量」，
//   全天行再给全天合计 —— 正是考核系统的口径来源。于是本次请求从「上百页运单」降到
//   「排班 + 考勤 / 出勤明细」两个导出接口，秒级出结果，且天然和系统口径一致。
//   两条链路（与出勤达成页同一套）：
//     今天：exportAttendance/1.0 实时快照（含 全天/时段完单量）
//     T-1 及更早：exportStatisticsDetail/1.0 出勤明细，经 detailToAttendance() 标准化
//   站点范围（teamIds）单独缓存，识别一次长期复用；只有首次 / 换商才查 1 次运单第 1 页。
//   运单相关代码（增量 / 水位 / 对账 / 校准）保留在 sync.js 里，但考核看板已不再调用。
// v3.10.0：补回「人工改派剔除」—— 只查改派单，不拉全量运单。
//   实测出勤统计的全天完单 = 运单「配送成功」单数（11-06：9051 = 9051，逐骑手 233/233 全等），
//   也就是考勤口径本身**没有**剔除人工改派，直接拿来算标2 会偏高。
//   而 queryTracking/2.0 支持 isReassign=1 直接筛选：11-06 全天 9345 单里改派只有 159 单，
//   2 页就取完。于是「排班 + 考勤 + 改派单」仍是 4 个请求、秒级出结果，
//   既保住 v3.9.0 的速度，又把 KPI 第十三条的剔除加回来了。

const XT = "https://httpizza.ele.me/xtop/";
// 只用于「识别站点范围」：首次 / 换商时取 1 页拿 teamId，不再分页同步运单
const API_QUERY = XT + "xtop.agencyTrackingFs.queryTracking/2.0";
const API_SCHEDULE = XT + "xtop.fs.special.schedule.exportSchedule/1.0";
const API_ATTENDANCE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
// 出勤统计 → 导出明细数据：历史日期的骑手 × 时段明细（替代忽略日期的实时考勤导出）
const API_ATT_DETAIL = XT + "xtop.fs.special.examine.exportStatisticsDetail/1.0";
const PAGE_SIZE = 90;        // 实测 >90 返回 PAGE_SIZE_OVER_RANGE
const REFRESH_MS = 5 * 60 * 1000;
const HISTORY_DAYS = 90;
const TEAM_KEY = "wb_team_ids_v1";   // 站点范围缓存：识别一次长期复用，避免每次刷新都查运单

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 数值展示不带千分位分隔符，与钉钉下发看板保持一致
const fmt = (n) => String(Math.round(Number(n || 0)));
const p1 = (n) => Number(n || 0).toFixed(1) + "%";
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
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) &&
  !isNaN(new Date(s + "T00:00:00").getTime());
const isToday = (d) => d === todayStr();
const hhmm = (d) => d.toTimeString().slice(0, 5);

// 本次加载的元信息：不再有「增量 / 全量 / 页数 / 水位」，只看数据来源与耗时
const newLoadStat = () => ({ teamRequests: 0, history: false, reassignPages: 0, reassignTotal: 0 });

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  date: todayStr(), mode: "live",
  loading: false, gen: 0, errors: [], fallbackTried: false,
  startedAt: null, finishedAt: null, lastErr: "",
  schSheets: [], attSheets: [], dataNote: "", assess: null, detailStats: null,
  reassignOrders: null,   // null=没查/查询失败；数组=已查（可能是空数组，表示当天没有改派）
  teamSource: "", teamCount: 0, teamIds: [],
  memo: new Map(),   // 历史日期 -> 已加载结果，切回同日期秒回；「立即刷新」强制重拉
  load: newLoadStat()
};

// ---------------------------------------------------------------- 请求体
// T0：当日 00:00 ~ 现在（实时窗口）；T-1 及更早：所选日期 00:00 ~ 23:59:59.999（整天定稿窗口）。
// 时间维度固定为「运单终态时间」，历史日期沿用同一条时间轴，口径与 T0 完全一致。
function windowToday(date) {
  const d = date || state.date || todayStr();
  const [y, m, day] = String(d).split("-").map(Number);
  const start = new Date(y, m - 1, day, 0, 0, 0, 0);
  const end = isToday(d) ? new Date() : new Date(y, m - 1, day, 23, 59, 59, 999);
  return { start, end };
}
// 时间维度固定为「运单终态时间」：trackingFinishStart / trackingFinishEnd
// 接口按 trackingFinishAt 过滤并倒序返回；状态回写会改变终态时间，
// 所以增量窗口必须沿这条时间轴推进，才能把新单和状态变更一起捞回来。
// since/end 省略时按所选日期给出全量窗口（历史日期是整天，今天是 00:00~现在）。
// extra 用于「只查改派单」：传 { isReassign: 1, teamIds } 即可让接口直接筛改派单。
function buildQueryPayload(page, since, end, date, extra) {
  const w = windowToday(date);
  return { params: { request: {
    deliverTypeList: [1, 2],
    teamIds: [],
    trackingFinishStart: since == null ? w.start.getTime() : since,
    trackingFinishEnd: end == null ? w.end.getTime() : end,
    merchantConsumerDistanceStart: "0", merchantConsumerDistanceEnd: "999999",
    payAmountStart: "0", payAmountEnd: "999999",
    weightStart: "0", weightEnd: "999999",
    trackingFinishTimePeriodList: ["0-86400"],
    current: page, pageSize: PAGE_SIZE,
    ...(extra || {})
  } } };
}
function buildExportPayload(kind, teamIds, date) {
  const d = date || state.date || todayStr();
  // 排班导出的 endDate 要含次日才会带出排班统计表；历史日期同样适用（实测返回起止两天）
  return { params: { request: {
    teamIds,
    startDate: d,
    endDate: kind === "schedule" ? shiftDate(d, 1) : d
  } } };
}

// ---------------------------------------------------------------- 双通道请求
async function rawApi(api, payload, via) {
  if (via === "bridge") {
    const resp = await chrome.runtime.sendMessage({ type: "BRIDGE_API", api, payload });
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

// 统一重试 + 第一页直连失败自动降级到静默桥接
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
  try { await chrome.runtime.sendMessage({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- xlsx 下载与解析
async function fetchBinary(url) {
  // 扩展页面对已授权的主机享有 CORS 豁免；个别内核下失败则交给 service worker 取。
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.arrayBuffer();
  } catch (e) {
    const resp = await chrome.runtime.sendMessage({ type: "FETCH_BINARY", url });
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
/** 按所选日期取考勤：今天走实时快照，历史日期走时段明细并标准化成同款 8 列。
 *  exportAttendance/1.0 实测忽略历史日期，所以 T-1 必须换 exportStatisticsDetail/1.0。 */
async function loadAttendanceSheets(mode, teamIds, date) {
  if (mode === "live") {
    return { sheets: await loadExportSheet(API_ATTENDANCE, "attendance", teamIds, date), stats: null };
  }
  const detail = await loadExportSheet(API_ATT_DETAIL, "detail", teamIds, date);
  const conv = ASSESS.detailToAttendance(detail, date, XLSX_READER);
  if (conv.error) throw new Error(conv.error);
  return { sheets: conv.sheets, stats: conv.stats };
}

/** 只查「人工改派」运单（isReassign=1）。
 *  为什么还要查运单：出勤统计的全天完单 = 运单「配送成功」单数（实测 11-06 逐骑手 233/233
 *  完全相等），说明考勤口径**没有**剔除人工改派；而 KPI 第十三条要求在标1–标5 里剔除。
 *  为什么不拉全量：接口支持 isReassign 直接筛选，11-06 全天 9345 单里改派只有 159 单，
 *  2 页就取完 —— 比分页拉上万单便宜两个数量级，切日期仍是秒级。 */
const MAX_REASSIGN_PAGES = 20;   // 兜底：异常时最多 20 页（1800 单），不让它把加载拖住
async function loadReassignOrders(teamIds, date) {
  const out = [];
  let total = 0;
  for (let page = 1; page <= MAX_REASSIGN_PAGES; page++) {
    const d = await callApi(API_QUERY,
      buildQueryPayload(page, undefined, undefined, date, { isReassign: 1, teamIds: teamIds || [] }),
      page === 1);
    const list = Array.isArray(d.data) ? d.data : [];
    if (typeof d.total === "number") total = d.total;
    out.push(...list);
    state.load.reassignPages = page;
    state.load.reassignTotal = total || out.length;
    if (!list.length || out.length >= total) break;
    await sleep(450);   // 接口有频率限制，改派单本来就只有两三页，慢一点更稳
  }
  return out;
}

// ---------------------------------------------------------------- 通知 / 进度
function showNotice(text, kind) {
  const n = $("notice");
  n.innerHTML = esc(text);
  n.className = "notice" + (kind === "blue" ? " blue" : "");
  n.hidden = false;
}
function clearNotice() { $("notice").hidden = true; $("notice").textContent = ""; }
function setProgress(page, pages, mode) {
  const ratio = pages > 0 ? Math.min(100, page / pages * 100) : 0;
  const bar = $("bar");
  bar.style.width = ratio + "%";
  bar.className = "bar" + (mode === "done" ? " done" : "") + (mode === "err" ? " err" : "");
  const a = state.assess;
  // 完单口径变了：现在直接取「出勤统计」，不再有「拉取 N 单（含失败单）」
  const scope = a && a.totals
    ? `实际完单 ${fmt(a.totals.done)}（出勤统计）`
    : "";
  $("progress-text").textContent =
    mode === "done" ? `${state.mode === "history" ? "历史定稿" : "实时快照"}完成${scope ? " · " + scope : ""}` :
    mode === "err" ? "加载失败" :
    mode === "export" ? (state.mode === "history" ? "正在获取排班 / 历史出勤明细 / 改派单…" : "正在获取排班 / 实时考勤 / 改派单…") :
    mode === "team" ? "正在识别站点范围…" :
    "连接风神接口…";
}
function setBusy(b) { $("btn-refresh").disabled = b; $("btn-refresh").textContent = b ? "加载中…" : "立即刷新"; }

// ---------------------------------------------------------------- 计算 + 渲染
function recompute() {
  // dateStr 传所选日期：排班统计 / 时段矩阵都按该日期的行过滤，历史日期不会串到今天。
  // orders 传空数组 = 完单取自出勤统计（v3.9.0 起不再同步运单）；
  // opts.reassignOrders = 只查回来的改派单（v3.10.0），仅用于标1–标5 的达标剔除。
  // 注意：null 与 [] 语义不同 —— null 表示「没查到」，此时不传 opts，标2 就退回不剔除。
  const opts = Array.isArray(state.reassignOrders) ? { reassignOrders: state.reassignOrders } : undefined;
  state.assess = ASSESS.build([], state.schSheets, state.attSheets, state.date, XLSX_READER, opts);
  render();
}

function renderTable1(a) {
  const head = ["商圈片", "规划<br>单量", "实际<br>完单", "订单<br>完成率", "完单<br>达标",
                "标2<br>(含6h)", "应排<br>骑手", "标二<br>占比", "考核<br>得分"];
  // innerHTML 会覆盖 table 内的 colgroup，所以列宽必须随表一起重绘
  const colgroup = `<colgroup><col style="width:228px"><col style="width:70px"><col style="width:70px">` +
    `<col style="width:96px"><col style="width:86px"><col style="width:90px">` +
    `<col style="width:70px"><col style="width:92px"><col style="width:84px"></colgroup>`;
  const thTitle = {
    2: "实际完单：出勤统计的全天完单合计（= 运单「配送成功」单数），人工改派单仍计入片区实际完单",
    4: "完单达标人数：按骑手当日「非人工改派」完成单判定（UB≥26 / 其他≥24）",
    5: "标2骑手：非人工改派完单达标 且 全天有效在线时长≥6h；人工改派完单已剔除"
  };
  const out = [colgroup, "<thead><tr>" + head.map((h, i) =>
    `<th${thTitle[i] ? ' title="' + thTitle[i] + '"' : ""}>${h}</th>`).join("") + "</tr></thead><tbody>"];
  const compCell = (v) => a.scheduleOk ? `<td class="${v < 90 ? "red" : "bold"}">${p1(v)}</td>` : `<td class="zero">—</td>`;
  for (const r of a.rows) {
    const b2cls = r.b2r < 70 ? "red" : (r.b2r < 80 ? "orange" : "bold");
    out.push(`<tr><td class="name" title="${esc(r.area)}">${esc(r.area)}</td>` +
      `<td>${a.scheduleOk ? fmt(r.plan) : "—"}</td><td>${fmt(r.done)}</td>` +
      compCell(r.comp) +
      `<td>${fmt(r.dok)}</td><td class="bold">${fmt(r.b2)}</td>` +
      `<td>${a.scheduleOk ? fmt(r.hc) : "—"}</td>` +
      `<td class="${a.attendanceOk ? b2cls : "zero"}">${a.attendanceOk && a.scheduleOk ? p1(r.b2r) : "—"}</td>` +
      `<td class="bold">${a.scheduleOk && a.attendanceOk ? r.tot.toFixed(1) : "—"}</td></tr>`);
  }
  const t = a.totals;
  out.push(`<tr class="total"><td>整商合计</td>` +
    `<td>${a.scheduleOk ? fmt(t.plan) : "—"}</td><td>${fmt(t.done)}</td>` +
    `<td>${a.scheduleOk ? p1(t.comp) : "—"}</td>` +
    `<td>${fmt(t.dok)}</td><td>${fmt(t.b2)}</td>` +
    `<td>${a.scheduleOk ? fmt(t.hc) : "—"}</td>` +
    `<td>${a.attendanceOk && a.scheduleOk ? p1(t.b2r) : "—"}</td>` +
    `<td>${a.scheduleOk && a.attendanceOk ? t.tot.toFixed(1) : "—"}</td></tr></tbody>`);
  $("table1").innerHTML = out.join("");
}

function renderTable2(a) {
  const P = a.periods || ASSESS.DEFAULT_PERIOD_NAMES;
  // 表 2 总宽固定 1218px（与钉钉看板 PNG 版式、以及「复制图片」的 1240px 画布一致）：
  // 班次从 7 个变 9/11 个时压缩子列宽，而不是让表格撑到 1506/1794px 溢出被裁。
  const firstW = 210, totalW = 1218;
  const subW = Math.max(34, Math.floor((totalW - firstW) / Math.max(1, P.length * 2)));
  const cols = `<colgroup><col class="first" style="width:${firstW}px">` +
    P.map(() => `<col class="sub" style="width:${subW}px"><col class="sub" style="width:${subW}px">`).join("") +
    `</colgroup>`;
  const t2 = $("table2");
  t2.style.width = totalW + "px";
  t2.style.minWidth = totalW + "px";
  // 班次变多只压缩列宽，字号保持常规（一级表头 colspan=2 仍有 90px+，无需缩小）。
  // 旧版会给表加 compact 把整张表压到 10/11px，小字发虚不好看，已移除。
  const h1 = `<thead><tr><th rowspan="2">${esc(a.areaLabel)}</th>` +
    P.map((p) => `<th colspan="2">${esc(p)}</th>`).join("") + "</tr><tr>" +
    P.map(() => "<th>完单量</th><th>完单率</th>").join("") + "</tr></thead>";
  const cells = (pd, isTotal) => P.map((p) => {
    const x = pd[p] || { plan: 0, done: 0, rate: 0 };
    const cls = (!isTotal && x.rate < 90) ? "red" : "bold";
    return `<td>${fmt(x.done)}</td>` +
           `<td class="rate ${a.scheduleOk ? cls : "zero"}">${a.scheduleOk ? p1(x.rate) : "—"}</td>`;
  }).join("");
  const body = ["<tbody>"];
  for (const r of a.rows) body.push(`<tr><td class="name" title="${esc(r.area)}">${esc(r.area)}</td>${cells(r.pd, false)}</tr>`);
  body.push(`<tr class="total"><td>整商合计</td>${cells(a.totalPd, true)}</tr></tbody>`);
  $("table2").innerHTML = cols + h1 + body.join("");
  $("mt-main").textContent = `各${a.areaLabel} × 各时段 规划单量达成`;
}

function renderBroadcast(a) {
  const list = [...a.rows].sort((x, y) => x.comp - y.comp);
  if (!list.length) { $("broadcast").innerHTML = `<span class="muted">暂无数据</span>`; return; }
  const t = a.totals, worst = list[0];
  let h = `<div class="bc-head">整商订单完成率 <b>${a.scheduleOk ? p1(t.comp) : "—"}</b>` +
    `（实际完单 ${fmt(t.done)} / 规划 ${a.scheduleOk ? fmt(t.plan) : "—"}）` +
    `｜标二占比 <b>${a.attendanceOk && a.scheduleOk ? p1(t.b2r) : "—"}</b></div>`;
  h += `<ul class="bc-list">` + list.map((r, i) =>
    `<li class="${i === 0 ? "worst" : ""}"><span class="num">${i + 1}</span>${esc(r.area)}` +
    `<span class="val">${a.scheduleOk ? p1(r.comp) : "—"}</span>` +
    `<span class="muted">（${fmt(r.done)}/${a.scheduleOk ? fmt(r.plan) : "—"}）${i === 0 ? " ⬅ 进度最低" : ""}</span></li>`
  ).join("") + `</ul>`;
  h += `<div class="bc-tip">👉 进度最低片区 <b>${esc(worst.area)}</b>` +
    `（${a.scheduleOk ? p1(worst.comp) : "—"}），请抓紧调度补单。</div>`;
  $("broadcast").innerHTML = h;
}

function loadSummary() {
  const out = [`站点范围 ${state.teamCount || 0} 个（${state.teamSource || "未识别"}）`];
  out.push(state.mode === "history"
    ? "历史定稿：排班统计 + 出勤明细导出，不读也不写任何运单缓存"
    : "实时快照：排班统计 + 实时考勤导出（含时段 / 全天完单量）");
  if (state.load.reassignPages) {
    out.push(`改派单 ${state.load.reassignTotal || 0} 张 / ${state.load.reassignPages} 次请求（只查 isReassign=1）`);
  }
  if (state.load.teamRequests) out.push(`本次用 ${state.load.teamRequests} 次运单请求识别 teamId`);
  return out.join(" · ");
}

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
/** 工具条与导出画面的日期 / 数据源文案：切换日期时立即刷新，不必等网络返回 */
function syncDateChrome() {
  const history = state.mode === "history";
  const modeLabel = history ? "历史定稿" : "实时快照";
  $("mode-tag").textContent = modeLabel;
  $("mode-tag").className = "mode-tag" + (history ? " history" : "");
  $("auto").disabled = history;
  $("auto").title = history ? "历史日期为定稿数据，无需自动刷新" : "今天每 5 分钟自动增量刷新";
  $("btn-today").classList.toggle("date-active", !history);
  $("btn-t1").classList.toggle("date-active", state.date === shiftDate(todayStr(), -1));
  if ($("date-picker").value !== state.date) $("date-picker").value = state.date;
  syncDateNav();
  // 表头日期必须立即跟着切换：历史日期首次拉取可能要几分钟，
  // 若等 render() 才更新，用户会一直看到上一天的日期，误以为没切成功。
  $("doc-sub").innerHTML = `考核日期 ${state.date} · ${modeLabel}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${hhmm(state.finishedAt || new Date())}`;
  $("btn-full").title = history
    ? "忽略本机缓存，重新拉取该历史日期的排班统计与出勤明细"
    : "忽略本机缓存，重新拉取今天的排班统计与实时考勤";
  $("doc-note").textContent = history
    ? `标2骑手 = ${state.date} 完单≥门槛(UB26 / 其他24) 且 全天有效在线时长≥6h；完单量取自出勤统计（考核系统口径），标2 已剔除人工改派成功单，片区「实际完单」仍含改派单`
    : "标2骑手 = 当日 完单≥门槛(UB26 / 其他24) 且 全天有效在线时长≥6h（实时考勤快照）；完单量取自考勤导出，标2 已剔除人工改派成功单，片区「实际完单」仍含改派单";
  $("doc-foot-small").textContent = history
    ? `注：${state.date} 为历史定稿数据；排班取该日排班统计，完单量与有效在线时长取「出勤统计 → 导出明细数据」的骑手 × 时段明细（全天按 6h / 18 单手工判定，不采信系统达成标记）；人工改派单单独按 isReassign=1 查回后从骑手达标剔除；时段矩阵按该日排班实际班次动态生成，不影响实际完单合计`
    : "注：考勤为当日实时快照，上午时段有效在线时长普遍未满6h，6h口径在上午偏低；标2 已按当日已发生的改派单剔除；时段矩阵按当日排班实际班次动态生成（班次时间区间取自 KPI 11 时段标准）。完整考核以当日结束 / 次日刷新后为准";
  return modeLabel;
}

function render() {
  const a = state.assess;
  if (!a) return;
  // 不再拉运单，就没有 agencyName / agencyId 可读；沿用上次记住的合作商名，
  // 首次使用显示「当前登录账号」。站点数来自排班 / 考勤导出的 teamIds。
  const mainName = localStorage.getItem("wb_agency_name") || "当前登录账号";
  const agencyId = localStorage.getItem("wb_agency") || "";

  renderTable1(a);
  renderTable2(a);
  renderBroadcast(a);

  // 工具条与导出画面的日期 / 数据源文案：历史日期和今天必须一眼可分
  const modeLabel = syncDateChrome();
  const history = state.mode === "history";
  const now = state.finishedAt || new Date();
  $("sub").innerHTML =
    `合作商 <b>${esc(mainName)}</b>${agencyId ? `（ID ${esc(agencyId)}）` : ""}` +
    ` · 站点 <b>${state.teamCount || 0}</b> / <b>${a.rows.length}</b> ${a.areaLabel}` +
    ` · 数据源 <b>${modeLabel}</b>` +
    ` · 完单 <b>出勤统计</b>` +
    (a.reassignStats ? ` · 改派 <b>${fmt(a.reassignStats.excluded)}</b> 已剔除` : "") +
    ` · 更新 <b>${hhmm(now)}</b>` +
    ` · 通道 <b>${state.via === "bridge" ? "静默桥接" : "直连"}</b>` +
    ` · 排班/考勤 <b>${a.scheduleOk ? "✓" : "…"}/${a.attendanceOk ? "✓" : "…"}</b>`;

  $("foot-meta").textContent =
    `考核日期 ${state.date} · 数据源：${history
      ? "exportSchedule/1.0（该日排班统计）+ exportStatisticsDetail/1.0（出勤统计 → 导出明细数据）"
      : "exportSchedule/1.0（排班统计）+ exportAttendance/1.0（实时考勤快照）"}` +
    `（均在插件内直接请求，跟随当前登录账号）` +
    (history
      ? " · 历史定稿结果只放本机内存，不读也不写运单缓存"
      : " · 不再同步运单明细，完单量与有效在线时长同源") +
    (a.doneSource === "waybill"
      ? ` · 完单口径：运单明细（配送成功 ${fmt(a.orderStats ? a.orderStats.success : 0)} / 共 ${fmt(a.orderStats ? a.orderStats.total : 0)} 单）`
      : " · 完单口径：出勤统计的全天完单合计（实测 = 运单「配送成功」单数，逐骑手一致）") +
    (a.reassignStats
      ? (a.reassignStats.queried != null
        // 考勤口径：改派单是单独查回来的，顺便写明查了多少张、多少张因未送达不参与剔除
        ? ` · 标2口径：已单独查回该日人工改派单 ${fmt(a.reassignStats.queried)} 张，其中配送成功 ${fmt(a.reassignStats.excluded)} 张已从骑手达标剔除（完单达标 ${fmt(a.reassignStats.dokRaw)}→${fmt(a.reassignStats.dok)}、标2 ${fmt(a.reassignStats.b2Raw)}→${fmt(a.reassignStats.b2)}，${fmt(a.reassignStats.downgraded)} 人因此跌破门槛）；片区实际完单仍含改派单`
        // 运单口径：全量运单里就地判定，没有「单独查回」这一步
        : ` · 标2口径：人工改派成功单 ${fmt(a.reassignStats.excluded)} 单已从骑手达标统计剔除（完单达标 ${fmt(a.reassignStats.dokRaw)}→${fmt(a.reassignStats.dok)}、标2 ${fmt(a.reassignStats.b2Raw)}→${fmt(a.reassignStats.b2)}，${fmt(a.reassignStats.downgraded)} 人因此跌破门槛）；片区实际完单仍含改派单`)
      : " · 标2口径：本次未取到改派单，标2 按考勤完单原值统计（含人工改派），人数可能偏高；点「立即刷新」重试即可") +
    (a.periods
      ? ` · 时段矩阵：按当日排班 ${a.periods.length} 个班次动态生成（${a.periods.join(" / ")}）` +
        (a.periodSource === "default" ? "，排班未取到故回退默认 7 班次" : "") +
        `；落在未排班时段的完单不计入矩阵，但仍计入实际完单`
      : "") +
    (a.unknownPeriods && a.unknownPeriods.length
      ? ` · 排班中有未识别班次：${a.unknownPeriods.join("、")}（字典无对应时间区间，未纳入时段矩阵，其预估单量仍计入规划单量）`
      : "") +
    ` · 口径与 assess_image.py 一致 · ${a.mapped ? "已匹配钉钉商圈片分组" : "按接口原生商圈分组"}` +
    (loadSummary() ? ` · ${loadSummary()}` : "") +
    (state.dataNote ? ` · ${state.dataNote}` : "") +
    (state.detailStats ? ` · 历史明细 ${state.detailStats.rows} 行 / ${state.detailStats.riders} 名骑手` : "") +
    (state.errors.length ? ` · 失败 ${state.errors.length} 项` : "") +
    (state.startedAt && state.finishedAt ? ` · 本次耗时 ${((state.finishedAt - state.startedAt) / 1000).toFixed(1)}s` : "");
}

// ---------------------------------------------------------------- 主流程
// v3.9.0：只调两个导出接口（排班统计 + 考勤 / 出勤明细），没有分页、没有增量缓存、没有对账。
const SYNC = (typeof WB_SYNC !== "undefined") ? WB_SYNC : null;

function readTeamCache() {
  try {
    const a = JSON.parse(localStorage.getItem(TEAM_KEY) || "[]");
    return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
  } catch (e) { return []; }
}
function writeTeamCache(ids) {
  try { localStorage.setItem(TEAM_KEY, JSON.stringify([...new Set(ids.map(String).filter(Boolean))])); }
  catch (e) { /* 隐私模式写不进去也不影响本次展示 */ }
}

/**
 * 站点范围（teamIds）：导出接口传 teamIds=[] 会报「没有该团队的数据权限」，所以必须先有 teamId 列表。
 * 取法按代价从低到高：
 *   ① localStorage 里记住的上次结果（0 请求，绝大多数刷新走这条）
 *   ② 旧版留下的运单缓存（0 请求，过渡期兼容；只读 teamId，不同步运单）
 *   ③ 实在没有才查 1 页运单（1 请求，只为拿 teamId —— 比分页同步上万单便宜两个数量级）
 */
async function resolveTeamIds(date) {
  const cached = readTeamCache();
  if (cached.length) { state.teamSource = "记住的站点范围"; return cached; }

  try {
    const res = SYNC ? await SYNC.read(date, localStorage.getItem("wb_agency") || "") : null;
    const rows = res && res.ok && res.cache && res.cache.rows;
    if (Array.isArray(rows) && rows.length) {
      const ids = rows.map((r) => String((r && r.teamId) || "")).filter(Boolean);
      if (ids.length) {
        writeTeamCache(ids);
        state.teamSource = "旧运单缓存（只读 teamId）";
        return [...new Set(ids)];
      }
    }
  } catch (e) { /* 缓存不可用则继续往下试 */ }

  try {
    state.load.teamRequests++;
    const d = await callApi(API_QUERY, buildQueryPayload(1, undefined, undefined, date), true);
    const ids = (Array.isArray(d.data) ? d.data : [])
      .map((r) => String(r.teamId || "")).filter(Boolean);
    if (ids.length) {
      writeTeamCache(ids);
      state.teamSource = "首次识别（1 页运单取 teamId）";
      return [...new Set(ids)];
    }
  } catch (e) { /* 落到下面的账号默认范围 */ }

  state.teamSource = "账号默认范围";
  return [];
}

/** 拉排班 + 考勤（历史日期为出勤明细）+ 改派单，随后立即重算渲染。返回失败项，供上层决定是否缓存结果。 */
async function loadSheets(gen, date, teamIds) {
  const history = state.mode === "history";
  const attLabel = history ? "历史出勤明细" : "考勤";
  setProgress(0, 1, "export");
  const results = await Promise.allSettled([
    loadExportSheet(API_SCHEDULE, "schedule", teamIds, date),
    loadAttendanceSheets(state.mode, teamIds, date),
    loadReassignOrders(teamIds, date)
  ]);
  if (gen !== state.gen) return { failed: [] };
  if (results[0].status === "fulfilled") state.schSheets = results[0].value;
  if (results[1].status === "fulfilled") {
    state.attSheets = results[1].value.sheets;
    state.detailStats = results[1].value.stats;
  }
  // 改派单失败时保持 null：宁可明确提示「标2 未剔除改派」，也不悄悄少扣一批人
  state.reassignOrders = results[2].status === "fulfilled" ? results[2].value : null;
  const failed = [];
  if (results[0].status === "rejected") failed.push("排班（" + results[0].reason.message + "）");
  if (results[1].status === "rejected") failed.push(attLabel + "（" + results[1].reason.message + "）");
  if (results[2].status === "rejected") failed.push("人工改派单（" + results[2].reason.message + "）");
  if (failed.length) {
    state.dataNote = "部分数据未取到：" + failed.join("、");
    showNotice(`排班 / ${attLabel}未全部取到：${esc(failed.join("；"))}。相关列显示「—」，其余列不受影响。` +
      (history ? "历史出勤明细通常在次日生成，刚过零点可能尚未就绪，可稍后点「立即刷新」或改查更早日期。" : ""));
  }
  state.errors = failed.slice();
  recompute();
  return { failed };
}

async function loadAll(opts) {
  if (state.loading) return;
  const gen = ++state.gen;
  state.loading = true;
  const date = state.date;
  const history = !isToday(date);
  const force = !!(opts && opts.force);

  Object.assign(state, {
    mode: history ? "history" : "live",
    errors: [], lastErr: "", schSheets: [], attSheets: [], detailStats: null,
    reassignOrders: null,
    teamSource: "", teamCount: 0, teamIds: [], dataNote: "", assess: null,
    startedAt: new Date(), finishedAt: null, load: newLoadStat()
  });
  state.load.history = history;
  setBusy(true); clearNotice(); setProgress(0, 1, "connect");

  // 历史日期是定稿快照，切回同一天直接复用内存结果；「立即刷新」强制重拉
  const memoKey = date + ":" + state.via;
  const memo = (history && !force) ? state.memo.get(memoKey) : null;
  if (memo) {
    state.schSheets = memo.sch;
    state.attSheets = memo.att;
    state.detailStats = memo.detailStats;
    state.reassignOrders = Array.isArray(memo.reassign) ? memo.reassign : null;
    state.teamSource = memo.teamSource;
    state.teamCount = memo.teamCount;
    state.finishedAt = memo.finishedAt || new Date();
    state.dataNote = "已复用本机内存里的该日期定稿数据，点「立即刷新」可强制重拉";
    recompute();
    setProgress(1, 1, "done");
    state.loading = false; setBusy(false);
    return;
  }

  try {
    setProgress(0, 1, "team");
    const teamIds = await resolveTeamIds(date);
    if (gen !== state.gen) return;
    state.teamIds = teamIds;
    state.teamCount = teamIds.length;
    if (!teamIds.length) throw new Error("未能识别站点范围（接口没有返回团队 ID）");

    const { failed } = await loadSheets(gen, date, teamIds);
    if (gen !== state.gen) return;

    state.finishedAt = new Date();
    render();
    setProgress(1, 1, "done");

    // 历史定稿结果只放内存（按日期 + 通道），不碰任何运单缓存
    if (history && !failed.length) {
      state.memo.set(memoKey, {
        sch: state.schSheets, att: state.attSheets, detailStats: state.detailStats,
        reassign: state.reassignOrders,
        teamSource: state.teamSource, teamCount: state.teamCount,
        finishedAt: state.finishedAt
      });
    }
    if (!failed.length && state.assess && !state.assess.rows.length) {
      showNotice(history
        ? `${date} 没有排班 / 完单数据。请确认该日期账号有数据，或改选其它日期。`
        : "当日暂无排班 / 完单数据。请确认已在本浏览器登录风神（a.ele.me）且账号有数据。", "blue");
    }
  } catch (e) {
    state.lastErr = e.message || String(e);
    setProgress(0, 1, "err");
    showNotice(`${history ? `${date} 历史定稿加载失败` : "加载失败"}：${esc(state.lastErr)}。请确认：① 已在本浏览器登录风神（a.ele.me）；② chrome://extensions 中已重新加载本扩展；③ 可点右上角「通道」手动切换直连 / 静默桥接后重试。`);
  } finally {
    if (gen === state.gen) { state.loading = false; setBusy(false); }
  }
}

function restart(opts) { state.gen++; state.loading = false; loadAll(opts); }

// ---------------------------------------------------------------- 事件
$("btn-refresh").addEventListener("click", () => restart({ force: true }));
// 「复制图片」：把看板画面（#sheet）渲染成 2 倍高清 PNG 写进剪贴板，可直接粘贴到钉钉 / 微信。
// 剪贴板不可用时自动降级为下载 PNG；按住 Shift 点击则直接另存为文件。
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
    // 文件名用所选日期，历史日期导出不会和今天的图混在一起
    const r = await WB_CAPTURE.capture({ download: e.shiftKey, date: state.date.replace(/-/g, "") });
    const size = `${r.width}×${r.height}`;
    if (r.mode === "clipboard") {
      showNotice(`已复制看板图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`, "blue");
    } else if (r.mode === "download") {
      showNotice(`看板图片已另存为 PNG 文件（${size}）。`, "blue");
    } else {
      showNotice(`当前环境不允许写入剪贴板，已自动下载 PNG 图片（${size}），可直接拖进钉钉 / 微信。`, "blue");
    }
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}。可先点「纯净看板」，再用系统截图工具替代。`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
// 「重识站点」：清掉记住的 teamIds 再拉一次。换账号 / 站点增减后站点范围会变，用它重置。
$("btn-full").addEventListener("click", () => {
  try { localStorage.removeItem(TEAM_KEY); } catch (e) { /* ignore */ }
  restart({ force: true });
});
$("auto").addEventListener("change", (e) => localStorage.setItem("wb_auto", e.target.checked ? "1" : "0"));
$("btn-channel").addEventListener("click", async () => {
  const next = state.via === "direct" ? "bridge" : "direct";
  await switchChannel(next, next === "bridge"
    ? "已切到「静默桥接」：后台（不激活）的风神标签页上下文取数，复用已打开页面，不弹窗。"
    : "已切回「直连」：完全不打开任何页面，由插件页面直接请求接口。");
  restart({ force: true });
});
$("btn-clean").addEventListener("click", () => {
  const on = document.body.classList.toggle("clean");
  $("btn-clean").textContent = on ? "退出纯净看板" : "纯净看板";
  if (!document.body.classList.contains("clean")) return;
  // 纯净模式下把按钮临时挂在标题右侧，保证能退出
  const b = document.createElement("button");
  b.id = "btn-clean-float"; b.className = "ghost"; b.textContent = "退出纯净看板";
  b.style.cssText = "position:fixed;right:16px;top:12px;z-index:99;opacity:.35";
  b.onmouseenter = () => { b.style.opacity = "1"; };
  b.onmouseleave = () => { b.style.opacity = ".35"; };
  b.onclick = () => { document.body.classList.remove("clean"); b.remove(); $("btn-clean").textContent = "纯净看板"; };
  document.body.appendChild(b);
});
setInterval(() => {
  // 历史日期是定稿数据，不需要每 5 分钟重拉；只有 T0 的实时快照才自动增量刷新
  if (!$("auto").checked || state.loading || document.hidden || state.mode !== "live") return;
  loadAll();
}, REFRESH_MS);

// ---------------------------------------------------------------- 日期选择事件
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
  localStorage.setItem("wb_assess_date", date);   // 与出勤页 wb_att_date 分开，互不干扰
  $("date-picker").value = date;
  syncDateChrome();   // 不等网络返回就更新标签 / 箭头 / 画面口径文案
  restart({ force: true });
}
$("date-picker").addEventListener("change", (e) => setDate(e.target.value));
$("btn-today").addEventListener("click", () => setDate(todayStr()));
$("btn-t1").addEventListener("click", () => setDate(shiftDate(todayStr(), -1)));
$("btn-prev-day").addEventListener("click", () => setDate(shiftDate(state.date, -1)));
$("btn-next-day").addEventListener("click", () => setDate(shiftDate(state.date, 1)));

// 嵌在风神页面的悬浮面板里时，支持 Esc 关闭面板（独立标签页打开时父窗口即自身，不触发）
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ __wbAssess: true, type: "CLOSE" }, "*");
  }
});

(async function init() {
  const a = localStorage.getItem("wb_auto"); if (a != null) $("auto").checked = a === "1";
  const saved = localStorage.getItem("wb_assess_date");
  const today = todayStr();
  if (validDate(saved) && saved <= today && saved >= shiftDate(today, -HISTORY_DAYS)) {
    state.date = saved;
    state.mode = isToday(saved) ? "live" : "history";
  }
  $("date-picker").value = state.date;
  $("date-picker").max = today;
  $("date-picker").min = shiftDate(today, -HISTORY_DAYS);
  syncDateChrome();
  $("btn-channel").textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  try { await chrome.runtime.sendMessage({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  // 测试钩子：仅在离线渲染验证时置位，生产环境恒为 false
  if (!window.__WB_TEST__) loadAll();
})();
