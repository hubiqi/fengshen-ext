// 风神考核看板（插件版 v3.3.6）—— 与 fengshen-data/assess_image.py 生成的钉钉看板同口径、同排版
// 数据源全部在插件内获取，跟随当前浏览器登录态：
//   1) queryTracking/2.0      -> 运单明细（实际完单 / 时段完单 / 骑手完单 / 站点商圈）
//   2) exportSchedule/1.0     -> 排班 xlsx（规划单量 / 应排骑手 / 时段预估单量）
//   3) exportAttendance/1.0   -> 考勤 xlsx（全天有效在线时长，用于标2 6h 门槛）
// 不访问任何本地服务，不依赖 Python，换账号登录即自动切换合作商。
//
// v3.3.0：运单改为增量同步（sync.js 持久化当日缓存 + 时间水位窗口 + total 对账）。
//   刷新时先用缓存秒开渲染，再只查「上次同步 - 2h 回溯窗口」拿新单/状态变更；
//   对账不一致、跨天、换商、缓存异常、手动「全量重拉」时才回退到全量分页。
// v3.3.6：标2 / 完单达标只认「非人工改派」的配送成功单（isReassign != 1，KPI 第十三条）；
//   片区「实际完单 / 订单完成率 / 时段完单」口径不变，仍按全部配送成功单统计。

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
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hhmm = (d) => d.toTimeString().slice(0, 5);

const newSyncStat = () => ({
  mode: "full", reason: "", pages: 0, fullPages: 0, watermark: 0,
  added: 0, updated: 0, reused: 0, saved: true
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
  const P = a.periods;
  const cols = `<colgroup><col class="first">${P.map(() => '<col class="sub"><col class="sub">').join("")}</colgroup>`;
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
  if (s.watermark) out.push(`水位=终态时间 ${hhmm(new Date(s.watermark))}`);
  if (s.reason && s.mode === "full") out.push(`触发原因：${s.reason}`);
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
  // 终态时间水位：本次所见运单里最大的 trackingFinishAt，作为下次增量窗口的起点
  const finishWatermark = state.rows.reduce((m, r) => {
    const t = Number(r.trackingFinishAt || r.completeAt || r.trackingCancelAt || 0);
    return t > m ? t : m;
  }, 0) || Date.now();
  state.sync.watermark = finishWatermark;   // 底部展示（全量也能看到终态时间水位）
  const saved = SYNC ? await SYNC.write({ date, agencyId: aid, rows: state.rows, lastTotal: total, mode, finishWatermark }) : false;
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

      // B) 只查「上次同步 - 常规窗口」内的新单 / 状态变更，分页窗口固定避免漂移
      const end = Date.now();
      const pullWindow = async (since) => {
        await sleep(THROTTLE_MS);
        if (gen !== state.gen) return false;
        const w1 = await callApi(API_QUERY, buildQueryPayload(1, since, end), false);
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
            const d = await callApi(API_QUERY, buildQueryPayload(i, since, end), false);
            if (gen !== state.gen) return false;
            pushRows(Array.isArray(d.data) ? d.data : []);
            recompute();
          } catch (e) { state.errors.push(`增量第 ${i} 页：${e.message}`); }
          state.sync.pages++;
          setProgress(i, winPages, "incr");
        }
        return true;
      };
      // C) 对账：新增行数必须等于接口 total 的增量；total 变小说明撤单，分页失败也不能算成功
      const reconcile = () => {
        const grew = state.rows.length - p.baseCount;
        const expect = anchorTotal - p.lastTotal;
        return {
          ok: anchorTotal > 0 && expect >= 0 && grew === expect && !state.errors.length,
          grew, expect
        };
      };

      await pullWindow(p.since);
      if (gen !== state.gen) return;
      let r = reconcile();
      if (!r.ok && r.expect >= 0) {
        // 常规窗口没补齐（接口入库延迟等）→ 扩大到 2 小时再试一次，避免直接退回全量
        state.errors.length = 0;
        await pullWindow(p.retrySince);
        if (gen !== state.gen) return;
        r = reconcile();
      }
      if (r.ok) {
        await finishSync(gen, date, agencyId, anchorTotal, "incremental");
        return;
      }
      state.sync.reason = `对账需全量校准（缓存 ${p.lastTotal} → 接口 ${anchorTotal}，本地新增 ${r.grew} / 预期 ${r.expect}${state.errors.length ? "，且增量分页有失败" : ""}）`;
      state.errors.length = 0;
      state.sync.mode = "full";
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
  try { await chrome.runtime.sendMessage({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  // 测试钩子：仅在离线渲染验证时置位，生产环境恒为 false
  if (!window.__WB_TEST__) loadAll();
})();
