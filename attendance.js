// 出勤达成看板（独立页面 v3.7.0）—— 与「指定日考核看板」完全分开的入口与画面
//
// 本页只做一件事：算「应排 / 实排 / 有效出勤」并输出实排达成、应排达成两张宽表。
// 不拉运单明细、不写运单缓存、不改动原考核看板的任何画面或导出图。
//
// 日期可选择（默认今天，可回看最近 90 天）。两条取数链路：
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

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  date: todayStr(), mode: "live",
  loading: false, gen: 0, errors: [], fallbackTried: false,
  schSheets: [], attSheets: [], assess: null, detailStats: null,
  startedAt: null, finishedAt: null, dataNote: "", teamSource: "", teamCount: 0,
  memo: new Map()   // 日期 -> 已加载的 sheets，切换日期秒回；「立即刷新」强制重拉
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

// 两张表共用同一份「有效出勤」分子：实排达成 = 有效出勤/实排，应排达成 = 有效出勤/应排。
// 分母为 0 显示「—」；未结束班次且暂无达标骑手时显示「统计中 / 未开始」。
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
  // 与考核看板表 2 一样锁 1218px 总宽：班次从 7 变 9/11 时只压缩列宽，字号保持常规
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

function render() {
  const a = state.assess;
  if (!a) return;
  const att = a.attendance;
  const now = state.finishedAt || new Date();
  const blocks = $("att-blocks");
  const history = state.mode === "history";
  const modeLabel = history ? "历史明细" : "实时快照";

  $("mode-tag").textContent = modeLabel;
  $("mode-tag").className = "mode-tag" + (history ? " history" : "");
  $("auto").disabled = history;
  $("auto").title = history ? "历史日期为定稿数据，无需自动刷新" : "今天的实时快照每 5 分钟自动刷新";
  $("btn-today").classList.toggle("date-active", !history);
  $("btn-t1").classList.toggle("date-active", state.date === shiftDate(todayStr(), -1));
  if ($("date-picker").value !== state.date) $("date-picker").value = state.date;
  $("doc-note").textContent = history
    ? "数据源：排班统计（应排人数 / 排班人数）+ 出勤统计历史时段明细（有效在线时长 / 完单量）；全天达成按有效在线≥6小时且完单≥18单手工判定，不采用系统的全天达成标记"
    : "数据源：排班统计（应排人数 / 排班人数）+ 实时考勤（排班状态 / 时段有效在线 / 时段完单）；有效出勤按 KPI 时段标准双达标去重，全天按 6h / 18 单";
  $("doc-foot-small").textContent = history
    ? `注：${state.date} 为历史日期，取次日定稿的时段明细，不再显示「统计中」；全天达成忽略系统的「是否达成」标记，按 6h / 18 单手工计算；两张表按当日排班实际班次动态生成列`
    : "注：考勤为当日实时快照，未结束班次的有效出勤会随时间补齐；两张表按当日排班实际班次动态生成列，宽表可左右滑动查看全部时段";

  if (!att || !att.ok) {
    // 排班 / 考勤任一侧取不到时，别把两张空表塞进「复制图片」的画面
    blocks.hidden = true;
    const why = att && att.missing.length ? att.missing.join("、") + " 未取到" : "排班 / 考勤未取到";
    $("att-kpi").innerHTML = `<span class="muted">出勤达成暂不可用：${esc(why)}</span>`;
    $("att-note").textContent = history
      ? "本页需要排班统计（应排人数 / 排班人数）与出勤统计时段明细（骑手ID / 站点 / 是否排班 / 时段 / 有效在线时长 / 完单量）同时可用；数据取到后会自动显示两张达成表。"
      : "本页需要排班统计（应排人数 / 排班人数）与实时考勤（排班状态 / 时段 / 时段有效在线时长 / 时段完单量）同时可用；数据取到后会自动显示两张达成表。";
  } else {
    blocks.hidden = false;
    const day = att.totals["全天"] || { due: 0, real: 0, valid: 0, realRate: null, dueRate: null };
    $("att-kpi").innerHTML =
      `整商全天：应排 <b>${fmt(day.due)}</b> · 实排 <b>${fmt(day.real)}</b> · 有效出勤 <b>${fmt(day.valid)}</b>` +
      `　｜　实排达成 <b>${day.realRate == null ? "—" : attPct(day.realRate)}</b>` +
      ` · 应排达成 <b>${day.dueRate == null ? "—" : attPct(day.dueRate)}</b>`;
    let note = `应排 = 排班统计「应排人数」；实排 = 「排班人数」；有效出勤 = 考勤「排班状态=排班」且` +
      `（时段有效在线≥该时段标准 且 时段完单≥该时段标准）的去重骑手数，全天按 6h / 18 单。` +
      `实排达成 = 有效出勤÷实排；应排达成 = 有效出勤÷应排（多排班可 >100%，不封顶）。`;
    note += history
      ? ` 历史日期取「出勤统计 → 导出明细数据」的骑手时段明细；系统全天行「是否达成」标记有误，本页忽略它，按有效在线≥6小时且完单≥18单手工判定。`
      : ` 考勤为当日实时快照，未结束班次会随时间补齐。`;
    if (att.degraded) {
      note += ` <span class="warn-text">考勤导出缺少「完单量」列，有效出勤已降级为只看有效在线时长。</span>`;
    }
    $("att-note").innerHTML = note;
    $("att-title-real").textContent = `${state.date} · 实排达成（有效出勤 / 实排）`;
    $("att-title-due").textContent = `${state.date} · 应排达成（有效出勤 / 应排）`;
    renderAttTable("table3", att, "real");
    renderAttTable("table4", att, "due");
  }

  $("doc-sub").innerHTML = `考核日期 ${state.date} · ${modeLabel}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${hhmm(now)}`;
  $("sub").innerHTML =
    `排班 <b>${a.scheduleOk ? "✓" : "…"}</b> · 考勤 <b>${a.attendanceOk ? "✓" : "…"}</b>` +
    ` · <b>${att ? att.rows.length : 0}</b> ${a.areaLabel}` +
    ` · 数据源 <b>${modeLabel}</b>` +
    ` · 更新 <b>${hhmm(now)}</b>` +
    ` · 通道 <b>${state.via === "bridge" ? "静默桥接" : "直连"}</b>`;

  $("foot-meta").textContent =
    `考核日期 ${state.date} · 数据源：${history
      ? "exportSchedule/1.0 + exportStatisticsDetail/1.0（历史时段明细，全天按 6h / 18 单手工判定）"
      : "exportSchedule/1.0 + exportAttendance/1.0（实时快照）"}（跟随当前登录账号，不拉运单明细）` +
    ` · 站点范围：${esc(state.teamSource || "待确定")}${state.teamCount ? `（${state.teamCount} 个站点）` : ""}` +
    (att ? ` · 时段矩阵：按当日排班 ${att.periods.length - 1} 个班次动态生成（${att.periods.join(" / ")}）` : "") +
    (a.unknownPeriods && a.unknownPeriods.length
      ? ` · 排班中有未识别班次：${a.unknownPeriods.join("、")}（字典无对应时间区间，未纳入矩阵）` : "") +
    (att && !att.ok && att.missing.length ? ` · 缺少列：${att.missing.join("、")}` : "") +
    ` · 口径与 config.py / review_report.py 一致 · ${a.mapped ? "已匹配钉钉商圈片分组" : "按接口原生商圈分组"}` +
    (state.dataNote ? ` · ${state.dataNote}` : "") +
    (state.detailStats ? ` · 历史明细 ${state.detailStats.rows} 行 / ${state.detailStats.riders} 名骑手` : "") +
    (state.startedAt && state.finishedAt ? ` · 本次耗时 ${((state.finishedAt - state.startedAt) / 1000).toFixed(0)}s` : "");
}

// ---------------------------------------------------------------- 主流程
async function resolveTeamIds(gen) {
  const ids = new Set();
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
      if (ids.size) { state.teamSource = "复用原看板运单缓存"; return [...ids]; }
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
    state.teamSource = "当日运单首页";
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
    return;
  }

  try {
    const teamIds = await resolveTeamIds(gen);
    if (gen !== state.gen) return;
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
  } catch (e) {
    setProgress(1, 1, "err");
    showNotice("同步失败：" + esc(e.message || String(e)) + "。请确认已在本浏览器登录风神（a.ele.me），且已在 chrome://extensions 重新加载扩展。");
  } finally {
    if (gen === state.gen) { state.loading = false; setBusy(false); }
  }
}
function restart(force) { state.gen++; state.loading = false; loadAll({ force: !!force }); }

// ---------------------------------------------------------------- 日期选择
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
  restart(false);
}
$("date-picker").addEventListener("change", (e) => setDate(e.target.value));
$("btn-today").addEventListener("click", () => setDate(todayStr()));
$("btn-t1").addEventListener("click", () => setDate(shiftDate(todayStr(), -1)));

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
  if (e.key === "Escape" && window.parent !== window) {
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

(async function init() {
  const a = localStorage.getItem("wb_att_auto"); if (a != null) $("auto").checked = a === "1";
  const saved = localStorage.getItem("wb_att_date");
  const today = todayStr();
  if (validDate(saved) && saved <= today && saved >= shiftDate(today, -HISTORY_DAYS)) state.date = saved;
  state.mode = isToday(state.date) ? "live" : "history";
  $("date-picker").value = state.date;
  $("date-picker").max = today;
  $("date-picker").min = shiftDate(today, -HISTORY_DAYS);
  $("btn-channel").textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) loadAll();
})();
