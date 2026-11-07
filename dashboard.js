// 风神考核看板（插件版 v3.5.0）—— 与 fengshen-data/assess_image.py 生成的钉钉看板同口径、同排版
// 数据源全部在插件内获取，跟随当前浏览器登录态：
//   1) queryTracking/2.0      -> 运单明细（实际完单 / 时段完单 / 骑手完单 / 站点商圈）
//   2) exportSchedule/1.0     -> 排班 xlsx（规划单量 / 应排人数 / 排班人数 / 时段预估单量）
//   3) exportAttendance/1.0   -> 考勤 xlsx（全天有效在线时长用于标2；逐时段有效在线 / 完单用于出勤达成）
// 不访问任何本地服务，不依赖 Python，换账号登录即自动切换合作商。
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
// v3.5.0：新增「出勤达成」模块 —— 应排 / 实排 / 有效出勤 × 时段矩阵，
//   两张宽表分别为「实排达成 = 有效出勤÷实排」「应排达成 = 有效出勤÷应排」。
//   应排 / 实排取排班统计，有效出勤取实时考勤按 KPI 时段标准双达标去重骑手数；
//   工具条可显示 / 隐藏该模块，隐藏时复制图片不含这两张表。

const XT = "https://httpizza.ele.me/xtop/";
const API_QUERY = XT + "xtop.agencyTrackingFs.queryTracking/2.0";
const API_SCHEDULE = XT + "xtop.fs.special.schedule.exportSchedule/1.0";
const API_ATTENDANCE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
const PAGE_SIZE = 90;        // 实测 >90 返回 PAGE_SIZE_OVER_RANGE
const THROTTLE_MS = 1200;    // 实测 1.2s 间隔可稳定避开 REQUEST_TOO_FREQUENT
const REFRESH_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 数值展示不带千分位分隔符，与钉钉下发看板保持一致
const fmt = (n) => String(Math.round(Number(n || 0)));
const p1 = (n) => Number(n || 0).toFixed(1) + "%";
// 出勤达成百分比：与截图一致，整数不补 .0（95%、100%、102.3%、400%）
const attPct = (n) => {
  const v = Math.round(Number(n || 0) * 10) / 10;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
};
// 商圈片全名 -> 出勤看板上的简称（福州台江区台江商圈片 -> 台江区台江）
const shortArea = (s) => String(s).replace(/^福州/, "").replace(/商圈片$/, "").replace(/商圈$/, "");
const attShown = () => localStorage.getItem("wb_att_show") !== "0";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hhmm = (d) => d.toTimeString().slice(0, 5);

const newSyncStat = () => ({
  mode: "full", reason: "", pages: 0, fullPages: 0, watermark: 0,
  added: 0, updated: 0, reused: 0, saved: true,
  calib: null, short: 0, keepWatermark: false, prevWatermark: 0, missStreak: 0
});

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  rows: [], index: new Map(), total: 0, pages: 0,
  loading: false, gen: 0, errors: [], fallbackTried: false, agencyWarned: false,
  startedAt: null, finishedAt: null, lastErr: "",
  schSheets: [], attSheets: [], dataNote: "", assess: null,
  sync: newSyncStat()
};

// ---------------------------------------------------------------- 请求体
function windowToday() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return { start, end: now };
}
// 时间维度固定为「运单终态时间」：trackingFinishStart / trackingFinishEnd
// 接口按 trackingFinishAt 过滤并倒序返回；状态回写会改变终态时间，
// 所以增量窗口必须沿这条时间轴推进，才能把新单和状态变更一起捞回来。
// since/end 省略时为「当日 00:00 ~ 现在」的全量窗口。
function buildQueryPayload(page, since, end) {
  const { start, end: now } = windowToday();
  return { params: { request: {
    deliverTypeList: [1, 2],
    teamIds: [],
    trackingFinishStart: since == null ? start.getTime() : since,
    trackingFinishEnd: end == null ? now.getTime() : end,
    merchantConsumerDistanceStart: "0", merchantConsumerDistanceEnd: "999999",
    payAmountStart: "0", payAmountEnd: "999999",
    weightStart: "0", weightEnd: "999999",
    trackingFinishTimePeriodList: ["0-86400"],
    current: page, pageSize: PAGE_SIZE
  } } };
}
function buildExportPayload(kind, teamIds) {
  const d = todayStr();
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const next = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
  return { params: { request: {
    teamIds,
    startDate: d,
    endDate: kind === "schedule" ? next : d
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
async function loadExportSheet(api, kind, teamIds) {
  const data = await callApi(api, buildExportPayload(kind, teamIds), false);
  const url = (data && typeof data === "object") ? (data.url || data.downloadUrl) : data;
  if (!url || typeof url !== "string" || !/^https?:/.test(url)) {
    throw new Error(kind === "schedule" ? "排班" : "考勤" + "导出未返回下载链接");
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
function setProgress(page, pages, mode) {
  const ratio = pages > 0 ? Math.min(100, page / pages * 100) : 0;
  const bar = $("bar");
  bar.style.width = ratio + "%";
  bar.className = "bar" + (mode === "done" ? " done" : "") + (mode === "err" ? " err" : "");
  // 「拉取 N 单」是接口返回的全部运单（含配送失败），不是实际完单，必须写清楚口径
  const st = state.assess && state.assess.orderStats;
  const scope = st
    ? `拉取 ${fmt(state.rows.length)} 单（配送成功 ${fmt(st.success)} · 配送失败 ${fmt(st.failed)}${st.unknown ? ` · 状态不明 ${fmt(st.unknown)}` : ""}）`
    : `拉取 ${fmt(state.rows.length)} 单`;
  const doneTail = st ? ` · 实际完单 ${fmt(st.success)}（仅配送成功）` : "";
  $("progress-text").textContent =
    mode === "done" ? `${state.sync.mode === "incremental" ? "增量完成" : "全量完成"} · ${state.sync.pages} 页 / ${scope}${doneTail}` :
    mode === "err" ? "加载失败" :
    mode === "export" ? "正在获取排班 / 考勤…" :
    mode === "connect" ? "连接风神接口…" :
    mode === "anchor" ? "校验当日总数…" :
    `${mode === "incr" ? "增量同步" : "全量同步"} ${page}/${pages} 页（${scope}）`;
}
function setBusy(b) { $("btn-refresh").disabled = b; $("btn-refresh").textContent = b ? "加载中…" : "立即刷新"; }

// ---------------------------------------------------------------- 计算 + 渲染
function recompute() {
  state.assess = ASSESS.build(state.rows, state.schSheets, state.attSheets, todayStr(), XLSX_READER);
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
    2: "实际完单：仅统计配送成功（state=40），已剔除配送失败；人工改派单仍计入片区实际完单",
    4: "完单达标人数：按骑手当日「非人工改派」配送成功单判定（UB≥26 / 其他≥24）",
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

// ---------------------------------------------------------------- 出勤达成模块（v3.5.0）
// 两张表共用同一份「有效出勤」分子：实排达成 = 有效出勤/实排，应排达成 = 有效出勤/应排。
// 分母为 0 显示「—」；未结束班次且暂无达标骑手时显示「统计中 / 未开始」，
// 避免把考勤实时快照里「还没跑完的班次」误报成 0% 告警。
function attCell(c, per, mode, att) {
  const den = mode === "real" ? c.real : c.due;
  const rate = mode === "real" ? c.realRate : c.dueRate;
  const tip = `应排 ${fmt(c.due)} · 实排 ${fmt(c.real)} · 有效出勤 ${fmt(c.valid)}`;
  if (!(den > 0) || rate == null) return `<td class="att-cell zero" title="${esc(tip)}">—</td>`;
  if (c.valid === 0 && att.ongoing.includes(per)) {
    const label = att.noData.includes(per) ? "未开始" : "统计中";
    return `<td class="att-cell pending" title="${esc(tip)}"><b>${label}</b>` +
           `<span>${fmt(c.valid)}/${fmt(den)}</span></td>`;
  }
  const cls = rate >= 100 ? "good" : (rate >= 80 ? "warn" : "bad");
  return `<td class="att-cell ${cls}" title="${esc(tip + " · 达成 " + attPct(rate))}">` +
         `<b>${attPct(rate)}</b><span>${fmt(c.valid)}/${fmt(den)}</span></td>`;
}

function renderAttTable(id, att, mode) {
  const P = att.periods;
  // 与表 2 一样锁 1218px 总宽：班次从 7 变 9/11 时只压缩列宽，字号保持常规
  const firstW = 210, totalW = 1218;
  const subW = ((totalW - firstW) / Math.max(1, P.length)).toFixed(2);
  const cols = `<colgroup><col style="width:${firstW}px">` +
    P.map(() => `<col style="width:${subW}px">`).join("") + `</colgroup>`;
  const head = `<thead><tr><th>团队名称</th>` + P.map((p) => {
    const st = att.standards[p];
    const hint = p === "全天"
      ? "全天：有效在线≥6小时 且 完单≥18单"
      : `有效在线≥${(st && st.timeMin) || 0}分钟 且 完单≥${(st && st.orders) || 0}单`;
    return `<th title="${esc(hint)}">${esc(p)}</th>`;
  }).join("") + `</tr></thead>`;
  const body = ["<tbody>"];
  for (const r of att.rows) {
    body.push(`<tr><td class="name" title="${esc(r.area)}">${esc(shortArea(r.area))}</td>` +
      P.map((p) => attCell(r.cells[p], p, mode, att)).join("") + `</tr>`);
  }
  body.push(`<tr class="total"><td>总计</td>` +
    P.map((p) => attCell(att.totals[p], p, mode, att)).join("") + `</tr></tbody>`);
  const t = $(id);
  t.style.width = totalW + "px";
  t.style.minWidth = totalW + "px";
  t.innerHTML = cols + head + body.join("");
}

function renderAttendance(a) {
  const box = $("attendance-section");
  const att = a.attendance;
  if (!att) { box.hidden = true; return; }
  box.hidden = !attShown();
  // 排班 / 考勤任一侧取不到时，别把两张空表塞进「复制图片」的画面
  const blocks = $("att-blocks");
  if (!att.ok) {
    blocks.hidden = true;
    const why = att.missing.length ? att.missing.join("、") + " 未取到" : "排班 / 考勤未取到";
    $("att-kpi").innerHTML = `<span class="muted">出勤达成暂不可用：${esc(why)}</span>`;
    $("att-note").textContent = "本模块需要排班统计（应排人数 / 排班人数）与实时考勤（排班状态 / 时段 / 时段有效在线时长 / 时段完单量）同时可用；数据取到后会自动显示两张达成表。";
    return;
  }
  blocks.hidden = false;
  const day = att.totals["全天"] || { due: 0, real: 0, valid: 0, realRate: null, dueRate: null };
  $("att-kpi").innerHTML =
    `整商全天：应排 <b>${fmt(day.due)}</b> · 实排 <b>${fmt(day.real)}</b> · 有效出勤 <b>${fmt(day.valid)}</b>` +
    `　｜　实排达成 <b>${day.realRate == null ? "—" : attPct(day.realRate)}</b>` +
    ` · 应排达成 <b>${day.dueRate == null ? "—" : attPct(day.dueRate)}</b>`;
  const note = `应排 = 排班统计「应排人数」；实排 = 「排班人数」；有效出勤 = 实时考勤「排班状态=排班」且` +
    `（时段有效在线≥该时段标准 且 时段完单≥该时段标准）的去重骑手数，全天按 6h / 18 单。` +
    `实排达成 = 有效出勤÷实排；应排达成 = 有效出勤÷应排（多排班可 >100%，不封顶）。` +
    `考勤为当日实时快照，未结束班次会随时间补齐。`;
  let extra = "";
  if (att.degraded) {
    extra += ` <span class="warn-text">考勤导出缺少「完单量」列，有效出勤已降级为只看有效在线时长。</span>`;
  }
  $("att-note").innerHTML = note + extra;
  $("att-title-real").textContent = `${todayStr()} · 实排达成（有效出勤 / 实排）`;
  $("att-title-due").textContent = `${todayStr()} · 应排达成（有效出勤 / 应排）`;
  renderAttTable("table3", att, "real");
  renderAttTable("table4", att, "due");
}

function checkAgency(name, id) {
  if (!name || name === "未识别" || name === "未知" || state.agencyWarned) return;
  const k = id || name;
  const prev = localStorage.getItem("wb_agency");
  const prevName = localStorage.getItem("wb_agency_name") || prev;
  if (prev && prev !== k) {
    state.agencyWarned = true;
    showNotice(`检测到登录账号 / 合作商切换：${prevName} → ${name}。数据已随当前浏览器登录态更新；如需固定看某一家商，请保持该账号登录。`);
  }
  localStorage.setItem("wb_agency", k);
  localStorage.setItem("wb_agency_name", name);
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

function syncSummary() {
  const s = state.sync;
  if (!s.pages && !s.reused) return "";
  const out = [
    `${s.mode === "incremental" ? "增量同步" : "全量同步"}：本次 ${s.pages} 页请求`,
    `缓存复用 ${fmt(s.reused)} 单 · 新增 ${fmt(s.added)} 单 · 状态回写 ${fmt(s.updated)} 单`
  ];
  if (s.mode === "incremental" && s.fullPages > s.pages) out.push(`省去 ${fmt(s.fullPages - s.pages)} 页全量拉取`);
  if (s.calib) out.push(`历史状态校准 ${hhmm(new Date(s.calib.since))}–${hhmm(new Date(s.calib.end))}（增量分片，非全量）`);
  if (s.short > 0) out.push(`接口待补 ${fmt(s.short)} 单（水位不推进，下次自动续补）`);
  if (s.watermark) out.push(`水位=终态时间 ${hhmm(new Date(s.watermark))}`);
  if (s.reason) out.push(`触发原因：${s.reason}`);
  if (!s.saved) out.push("缓存写入失败，下次刷新将退化为全量");
  return out.join(" · ");
}

function render() {
  const a = state.assess;
  if (!a) return;
  const agencies = new Map();
  let agencyId = "";
  for (const r of state.rows) {
    const n = String(r.agencyName || "未识别");
    agencies.set(n, (agencies.get(n) || 0) + 1);
    if (!agencyId && r.agencyId) agencyId = String(r.agencyId);
  }
  const main = [...agencies.entries()].sort((x, y) => y[1] - x[1])[0];
  const mainName = main ? main[0] : "未识别";
  checkAgency(mainName, agencyId);

  renderTable1(a);
  renderTable2(a);
  renderAttendance(a);
  renderBroadcast(a);

  const now = state.finishedAt || new Date();
  $("doc-sub").innerHTML = `考核日期 ${todayStr()}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${hhmm(now)}`;
  $("sub").innerHTML =
    `合作商 <b>${esc(mainName)}</b>${agencyId ? `（ID ${esc(agencyId)}）` : ""}` +
    ` · <b>${a.rows.length}</b> ${a.areaLabel}` +
    ` · 更新 <b>${hhmm(now)}</b>` +
    ` · 同步 <b>${state.sync.mode === "incremental" ? "增量" : "全量"}</b>` +
    ` · 通道 <b>${state.via === "bridge" ? "静默桥接" : "直连"}</b>` +
    ` · 排班/考勤 <b>${a.scheduleOk ? "✓" : "…"}/${a.attendanceOk ? "✓" : "…"}</b>`;

  $("foot-meta").textContent =
    `数据源：queryTracking/2.0 + exportSchedule/1.0 + exportAttendance/1.0（均在插件内直接请求，跟随当前登录账号）` +
    (a.orderStats
      ? ` · 运单口径：接口 ${fmt(state.rows.length)} 单 = 配送成功 ${fmt(a.orderStats.success)} + 配送失败 ${fmt(a.orderStats.failed)}${a.orderStats.unknown ? ` + 状态不明 ${fmt(a.orderStats.unknown)}` : ""}；实际完单只算配送成功，失败单已剔除`
      : "") +
    (a.reassignStats
      ? ` · 标2口径：人工改派成功单 ${fmt(a.reassignStats.excluded)} 单已从骑手达标统计剔除（完单达标 ${fmt(a.reassignStats.dokRaw)}→${fmt(a.reassignStats.dok)}、标2 ${fmt(a.reassignStats.b2Raw)}→${fmt(a.reassignStats.b2)}，${fmt(a.reassignStats.downgraded)} 人因此跌破门槛）；片区实际完单仍含改派单`
      : "") +
    (a.periods
      ? ` · 时段矩阵：按当日排班 ${a.periods.length} 个班次动态生成（${a.periods.join(" / ")}）` +
        (a.periodSource === "default" ? "，排班未取到故回退默认 7 班次" : "") +
        `；落在未排班时段的完单不计入矩阵，但仍计入实际完单`
      : "") +
    (a.unknownPeriods && a.unknownPeriods.length
      ? ` · 排班中有未识别班次：${a.unknownPeriods.join("、")}（字典无对应时间区间，未纳入时段矩阵，其预估单量仍计入规划单量）`
      : "") +
    (a.attendance && a.attendance.ok
      ? ` · 出勤达成：应排 ${fmt(a.attendance.totals["全天"].due)} / 实排 ${fmt(a.attendance.totals["全天"].real)} / 有效出勤 ${fmt(a.attendance.totals["全天"].valid)}（整商全天）；有效出勤按 KPI 时段标准（有效在线时长 + 完单量双达标）判定`
      : "") +
    ` · 口径与 assess_image.py 一致 · ${a.mapped ? "已匹配钉钉商圈片分组" : "按接口原生商圈分组"}` +
    ` · pageSize=${PAGE_SIZE} · 页间节流 ${THROTTLE_MS}ms` +
    (syncSummary() ? ` · ${syncSummary()}` : "") +
    (state.dataNote ? ` · ${state.dataNote}` : "") +
    (state.errors.length ? ` · 失败页 ${state.errors.length}` : "") +
    (state.startedAt && state.finishedAt ? ` · 本次耗时 ${((state.finishedAt - state.startedAt) / 1000).toFixed(0)}s` : "");
}

// ---------------------------------------------------------------- 主流程（增量 / 全量）
const SYNC = (typeof WB_SYNC !== "undefined") ? WB_SYNC : null;

// 按 trackingId 建索引：新单追加、状态变化的单直接覆盖，既不重复计数也不丢历史
function resetRows(rows) {
  state.rows = rows ? rows.slice() : [];
  state.index = new Map();
  state.rows.forEach((r, i) => {
    const id = String(r.trackingId || r.platformTrackingId || "");
    if (id && !state.index.has(id)) state.index.set(id, i);
  });
  state.sync.added = 0;
  state.sync.updated = 0;
}
function pushRows(rows) {
  for (const r of rows) {
    const id = String(r.trackingId || r.platformTrackingId || "");
    if (!id) { state.rows.push(r); state.sync.added++; continue; }
    const at = state.index.get(id);
    if (at == null) { state.index.set(id, state.rows.length); state.rows.push(r); state.sync.added++; }
    else { state.rows[at] = r; state.sync.updated++; }
  }
}

// 排班 / 考勤 + 落缓存 + 收尾渲染，增量与全量共用
async function finishSync(gen, date, agencyId, total, mode) {
  if (gen !== state.gen) return;
  setProgress(1, 1, "export");
  const teamIds = [...new Set(state.rows.map((r) => String(r.teamId || "")).filter(Boolean))];
  const results = await Promise.allSettled([
    loadExportSheet(API_SCHEDULE, "schedule", teamIds),
    loadExportSheet(API_ATTENDANCE, "attendance", teamIds)
  ]);
  if (gen !== state.gen) return;
  if (results[0].status === "fulfilled") state.schSheets = results[0].value;
  if (results[1].status === "fulfilled") state.attSheets = results[1].value;
  const failed = [];
  if (results[0].status === "rejected") failed.push("排班（" + results[0].reason.message + "）");
  if (results[1].status === "rejected") failed.push("考勤（" + results[1].reason.message + "）");
  if (failed.length) {
    state.dataNote = "部分数据未取到：" + failed.join("、");
    showNotice(`排班 / 考勤未全部取到：${esc(failed.join("；"))}。完成率、标二占比、考核得分相关列暂显示「—」，其余数据不受影响。`);
  }
  recompute();

  // 缓存写入失败不影响本次展示，只让下次刷新退化为全量
  const aid = localStorage.getItem("wb_agency") || agencyId || "";
  // 终态时间水位：本次所见运单里最大的 trackingFinishAt，作为下次增量窗口的起点。
  // 对账没补齐（接口入库延迟）时水位保持原值，下次窗口会从同一位置重新覆盖，
  // 把延迟单自动续补回来，而不是靠降级全量去捞。
  const latestWatermark = state.rows.reduce((m, r) => {
    const t = Number(r.trackingFinishAt || r.completeAt || r.trackingCancelAt || 0);
    return t > m ? t : m;
  }, 0) || Date.now();
  const finishWatermark = (mode === "incremental" && state.sync.keepWatermark && state.sync.prevWatermark)
    ? state.sync.prevWatermark : latestWatermark;
  state.sync.watermark = finishWatermark;   // 底部展示（全量也能看到终态时间水位）
  const saved = SYNC ? await SYNC.write({
    date, agencyId: aid, rows: state.rows, lastTotal: total, mode, finishWatermark,
    calibFrom: state.sync.calib ? state.sync.calib.nextFrom : undefined,
    // 全量本身已覆盖全天状态，也记为一次校准，避免刚同步完又立刻拉校准片
    calibAt: (mode === "full" || state.sync.calib) ? Date.now() : undefined,
    missStreak: state.sync.missStreak || 0
  }) : false;
  state.sync.saved = saved;
  if (!saved) state.dataNote = (state.dataNote ? state.dataNote + "；" : "") + "本地缓存写入失败，下次刷新将退化为全量";

  state.finishedAt = new Date();
  render();
  setProgress(1, 1, "done");
  if (state.errors.length && !failed.length) {
    showNotice(`有 ${state.errors.length} 页运单加载失败（已展示其余数据）。可点「立即刷新」重试。`);
  } else if (!state.total) {
    showNotice("当日暂无运单。请确认已在本浏览器登录风神（a.ele.me）且账号有数据。", "blue");
  }
}

async function loadAll(opts) {
  if (state.loading) return;
  const gen = ++state.gen;
  state.loading = true;
  const date = todayStr();
  const forceFull = !!(opts && opts.forceFull);
  const agencyId = localStorage.getItem("wb_agency") || "";

  Object.assign(state, {
    rows: [], total: 0, pages: 0, errors: [], lastErr: "",
    fallbackTried: false, agencyWarned: false, schSheets: [], attSheets: [],
    dataNote: "", assess: null, startedAt: new Date(), finishedAt: null,
    sync: newSyncStat()
  });
  state.index = new Map();
  setBusy(true); clearNotice(); setProgress(0, 1, "connect");

  try {
    const res = SYNC ? await SYNC.read(date, agencyId) : { ok: false, reason: "缓存模块不可用" };
    const p = SYNC ? SYNC.plan(res, windowToday().start.getTime(), forceFull) : { mode: "full", reason: "缓存模块不可用" };
    state.sync.mode = p.mode;
    state.sync.reason = p.reason || "";
    state.sync.watermark = Number(p.watermark || 0);
    let anchorTotal = 0;

    if (p.mode === "incremental") {
      resetRows(p.rows);
      state.sync.reused = p.baseCount;
      state.sync.prevWatermark = Number(p.watermark || 0);
      recompute();                         // 先拿本地缓存秒开渲染，不等网络

      // A) 全日第 1 页：拿 total 作对账锚点，顺便刷新最新一页的状态
      const anchor = await callApi(API_QUERY, buildQueryPayload(1), true);
      if (gen !== state.gen) return;
      anchorTotal = Number(anchor.total || 0);
      state.total = anchorTotal;
      state.sync.pages++;
      state.sync.fullPages = Math.max(1, Math.ceil(anchorTotal / PAGE_SIZE));
      state.pages = state.sync.fullPages;
      pushRows(Array.isArray(anchor.data) ? anchor.data : []);
      recompute();
      setProgress(1, 1, "anchor");

      // B) 常规窗口 / 扩窗 / 状态校准分片共用的分页拉取；窗口起止固定避免分页漂移
      const end = Date.now();
      const pullWindow = async (since, wEnd, quiet) => {
        const to = wEnd == null ? end : wEnd;
        await sleep(THROTTLE_MS);
        if (gen !== state.gen) return false;
        const w1 = await callApi(API_QUERY, buildQueryPayload(1, since, to), false);
        if (gen !== state.gen) return false;
        const winPages = Math.max(1, Math.ceil(Number(w1.total || 0) / PAGE_SIZE));
        state.sync.pages++;
        pushRows(Array.isArray(w1.data) ? w1.data : []);
        recompute();
        setProgress(1, winPages, "incr");
        for (let i = 2; i <= winPages; i++) {
          if (gen !== state.gen) return false;
          await sleep(THROTTLE_MS);
          if (gen !== state.gen) return false;
          try {
            const d = await callApi(API_QUERY, buildQueryPayload(i, since, to), false);
            if (gen !== state.gen) return false;
            pushRows(Array.isArray(d.data) ? d.data : []);
            recompute();
          } catch (e) { if (!quiet) state.errors.push(`增量第 ${i} 页：${e.message}`); }
          state.sync.pages++;
          setProgress(i, winPages, "incr");
        }
        return true;
      };

      // C) 对账：只有 total 变小（撤单）才立即全量重建。
      //    total 增长但窗口没捞齐 = 接口入库延迟，不再降级全量：
      //    保留缓存 + 水位不推进 + missStreak 计数，下次刷新从同一位置自动续补；
      //    连续 MAX_MISS_STREAK 次仍补不齐才回退全量，避免接口长期异常时一直展示残缺数据。
      const reconcile = () => {
        const grew = state.rows.length - p.baseCount;
        const expect = anchorTotal - p.lastTotal;
        return {
          shrank: p.lastTotal > 0 && anchorTotal < p.lastTotal,
          grew, expect,
          // 用「缓存缺口」而不是「本次新增 vs total 增量」：后者在延迟单补回后
          // 会因 expect 归零而让 missStreak 失效，前者能持续反映缓存是否真的缺单。
          short: Math.max(0, anchorTotal - state.rows.length)
        };
      };

      await pullWindow(p.since, end);
      if (gen !== state.gen) return;
      let r = reconcile();
      if (!r.shrank && r.short > 0) {
        // 常规窗口没补齐 → 扩大到 2 小时再试一次（仍是增量，不是全量）
        state.errors.length = 0;
        await pullWindow(p.retrySince, end);
        if (gen !== state.gen) return;
        r = reconcile();
      }
      const streak = r.short > 0 ? p.missStreak + 1 : 0;
      if (r.shrank) {
        state.sync.reason = `接口对账：运单总数变小（缓存 ${p.lastTotal} → 接口 ${anchorTotal}，疑似撤单），全量重建缓存`;
      } else if (r.short > 0 && streak >= (SYNC ? SYNC.MAX_MISS_STREAK : 3)) {
        state.sync.reason = `接口对账：连续 ${streak} 次未补齐（待补 ${r.short} 单），全量重建缓存`;
      } else {
        // 正常增量路径：保留缓存、按需推进水位，再做一片历史状态校准
        state.sync.short = r.short;
        state.sync.keepWatermark = r.short > 0;
        state.sync.missStreak = streak;
        if (p.calib) {
          try {
            // 校准分片失败不影响本次增量结果：calibFrom 不推进，下次重试同一片
            const ok = await pullWindow(p.calib.since, p.calib.end, true);
            if (!ok) return;
            state.sync.calib = p.calib;
          } catch (e) { /* 忽略，下次重试同一片 */ }
        }
        await finishSync(gen, date, agencyId, anchorTotal, "incremental");
        return;
      }
      state.errors.length = 0;
      state.sync.mode = "full";
      state.sync.keepWatermark = false;
      state.sync.missStreak = 0;
    }

    // ---- 全量路径：首次 / 跨天 / 换商 / 手动 / 对账降级 ----
    state.sync.mode = "full";
    resetRows();
    state.sync.reused = 0;
    const dayEnd = Date.now();
    const first = await callApi(API_QUERY, buildQueryPayload(1, undefined, dayEnd), true);
    if (gen !== state.gen) return;
    state.total = Number(first.total || 0);
    state.pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    state.sync.fullPages = state.pages;
    state.sync.pages++;
    anchorTotal = state.total;
    pushRows(Array.isArray(first.data) ? first.data : []);
    recompute();
    setProgress(1, state.pages, "full");
    for (let i = 2; i <= state.pages; i++) {
      if (gen !== state.gen) return;
      await sleep(THROTTLE_MS);
      if (gen !== state.gen) return;
      try {
        const d = await callApi(API_QUERY, buildQueryPayload(i, undefined, dayEnd), false);
        if (gen !== state.gen) return;
        pushRows(Array.isArray(d.data) ? d.data : []);
        recompute();
      } catch (e) { state.errors.push(`第 ${i} 页：${e.message}`); }
      state.sync.pages++;
      setProgress(i, state.pages, "full");
    }
    if (gen !== state.gen) return;
    await finishSync(gen, date, agencyId, anchorTotal, "full");
  } catch (e) {
    state.lastErr = e.message || String(e);
    setProgress(0, 1, "err");
    const cached = state.rows.length && state.sync.mode === "incremental" ? "当前展示的是本地缓存数据；" : "";
    showNotice(`同步失败：${esc(state.lastErr)}。${cached}请确认：① 已在本浏览器登录风神（a.ele.me）；② chrome://extensions 中已重新加载本扩展；③ 可点右上角「通道」手动切换直连 / 静默桥接后重试。`);
  } finally {
    if (gen === state.gen) { state.loading = false; setBusy(false); }
  }
}

function restart(opts) { state.gen++; state.loading = false; loadAll(opts); }

// ---------------------------------------------------------------- 事件
$("btn-refresh").addEventListener("click", () => restart());
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
    const r = await WB_CAPTURE.capture({ download: e.shiftKey, date: todayStr().replace(/-/g, "") });
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
// 「出勤达成」：控制新模块是否出现在看板画面里；隐藏时「复制图片」也不会带上这两张宽表
$("btn-attendance").addEventListener("click", () => {
  const on = !attShown();
  localStorage.setItem("wb_att_show", on ? "1" : "0");
  $("btn-attendance").textContent = "出勤达成：" + (on ? "显示" : "隐藏");
  if (state.assess) renderAttendance(state.assess);
  showNotice(on
    ? "已显示「出勤达成」模块，点「复制图片」会一起导出实排达成 / 应排达成两张表。"
    : "已隐藏「出勤达成」模块，复制图片只含原有考核看板。", "blue");
});
// 「全量重拉」：忽略本地缓存，重新分页拉当日全部运单并重建缓存（数据校准用）
$("btn-full").addEventListener("click", () => restart({ forceFull: true }));
$("auto").addEventListener("change", (e) => localStorage.setItem("wb_auto", e.target.checked ? "1" : "0"));
$("btn-channel").addEventListener("click", async () => {
  const next = state.via === "direct" ? "bridge" : "direct";
  await switchChannel(next, next === "bridge"
    ? "已切到「静默桥接」：后台（不激活）的风神标签页上下文取数，复用已打开页面，不弹窗。"
    : "已切回「直连」：完全不打开任何页面，由插件页面直接请求接口。");
  restart();
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
  if (!$("auto").checked || state.loading || document.hidden) return;
  loadAll();
}, REFRESH_MS);

// 嵌在风神页面的悬浮面板里时，支持 Esc 关闭面板（独立标签页打开时父窗口即自身，不触发）
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ __wbAssess: true, type: "CLOSE" }, "*");
  }
});

(async function init() {
  const a = localStorage.getItem("wb_auto"); if (a != null) $("auto").checked = a === "1";
  $("btn-channel").textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  $("btn-attendance").textContent = "出勤达成：" + (attShown() ? "显示" : "隐藏");
  try { await chrome.runtime.sendMessage({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  // 测试钩子：仅在离线渲染验证时置位，生产环境恒为 false
  if (!window.__WB_TEST__) loadAll();
})();
