/* 质量运营模块（v3.42.0，独立页面）
 * ---------------------------------------------------------------------------
 * 整商 / 商圈片 / 站点 / 骑手（按钮切换）× 炸班次 / 坏单（视图切换）的本月日期矩阵：
 *   炸班次：行 = 日期，列 = 班次（按数据动态生成）。
 *     绿 = 有排班且全部达成；红 = 有排班且有未达成；琥珀 = 达成标记缺失（今日实时快照）；
 *     灰 = 该班次当天无排班。点单元格弹骑手明细（姓名 / 站点 / 时段 / 达成 / 完单 / 有效在线）。
 *   坏单：行 = 日期，列 = 物流责 / 投诉 / 差评 / 提前点（+ 合计）。
 *     绿 = 该类型当天 0 单；红 = 坏单数。点单元格弹运单明细（运单ID / 骑手 / 站点 / 类型）。
 *
 * 数据源全部复用运力模块已验证的接口：
 *   1) 出勤统计 → 导出明细数据 exportStatisticsDetail/1.0（本月按 7 天分段拉 xlsx）
 *      列：骑手ID / 站点ID / 站点名称 / 考勤日期 / 时段 / 是否排班 / 是否达成 / 时段完单量 / 时段有效在线时长
 *      口径：只看非「全天」班次（系统全天标记不可信，与运力模块班次异常口径一致）；
 *      「是否排班」列存在时按它过滤，缺列时一律视为有排班。
 *   2) 出勤达成同款实时快照 exportAttendance/1.0 —— 仅当月用于补今天（历史日期 T+1 结算）。
 *      快照缺「是否达成」列时对应单元格显示「统计中」。
 *   3) KPI管理 → 考核运单明细 perfDetail.queryDetailList/1.0（tabCode=TRACK_UB）：
 *      4 个 Radio 筛选各查一次 + 违规处罚列表（violationOrderAeolusCenterApi.queryList/1.0，
 *      违规状态=成立、分类=差评+投诉、单次窗口 ≤2 天按 2 天分段）的运单号去重后
 *      逗号拼接 50 单/批回查 —— 与运力模块 v3.41.0 同一套并集口径，不漏不重。
 *
 * 与另两个页面一样：直连优先、失败自动切「静默桥接」；跟随当前登录态，不依赖本地服务。
 * 站点列表走 getTeamsAll/1.0；商圈片沿用运力模块同一套站点→商圈片映射，未映射站点自成一组。
 */

"use strict";

const XT = "https://httpizza.ele.me/xtop/";
const API_ATT_DETAIL = XT + "xtop.fs.special.examine.exportStatisticsDetail/1.0";
const API_ATT_LIVE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const API_KPI_DETAIL = XT + "xtop.performance.fs.opp.perfDetail.queryDetailList/1.0";
const API_VIOLATION = XT + "xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.queryList/1.0";

const ATT_SEG_DAYS = 7;        // 出勤明细接口硬限制：单次最多导出 7 天
const KPI_PAGE_SIZE = 100;     // 实测 pageSize > 100 接口返回空数据
const KPI_MAX_PAGES = 10;      // 每类问题订单最多 10 页 = 1000 单
const VIOL_SEG_DAYS = 2;       // 违规处罚接口硬限制：单次查询 ≤ 2 天
const VIOL_BATCH = 50;         // 违规运单号逗号拼接批量回查的批次大小
const VIOL_MAX_PAGES = 3;      // 每个 2 天段最多翻 3 页
const MONTHS_BACK = 11;        // 当前月 + 往前 11 个月
const LS_MONTH = "wb_ql_month";

// 坏单四列（与运力模块 KPI_COLS 同一套）
const KPI_FILTERS = [
  { is_lgt_duty_incompleted_order: "1" },
  { is_early_delivery_complain_order: "1" },
  { is_early_delivery_negative_rating_order: "1" },
  { is_early_delivery_claim_order: "1" }
];
const KPI_COLS = ["是否物流责取消单", "是否投诉单", "是否差评单", "是否提前点送达不满意单"];
const BAD_COLS = [
  ["lgt", "物流责"], ["complain", "投诉"], ["negative", "差评"], ["early", "提前点"]
];

// 站点 → 商圈片（与考核看板 / 运力模块 / 排班 / 实时出勤同一套映射；未映射站点自成一组）
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
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => String(Math.round(num(v)));
const normId = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, "");
  // 实时快照的「站点id」常是 9.17534438E8 这类科学计数法，转回整数字符串
  if (/^\d+(\.\d+)?[eE]\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return String(n);
  }
  return s;
};
const str = (v) => String(v == null ? "" : v).trim();
const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const curMonth = () => monthStr(new Date());
const shiftMonth = (m, delta) => {
  const [y, mm] = String(m).split("-").map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return monthStr(d);
};
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));
const padDay = (d) => String(d).padStart(2, "0");
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${padDay(d.getMonth() + 1)}-${padDay(d.getDate())}`;
};
function monthBounds(month) {
  const [y, m] = String(month).split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const maxDay = month === curMonth() ? Math.min(lastDay, new Date().getDate()) : lastDay;
  return {
    y, m, maxDay,
    start: new Date(y, m - 1, 1, 0, 0, 0).getTime(),
    end: new Date(y, m - 1, maxDay, 23, 59, 59).getTime()
  };
}
function monthSegments(month) {
  const b = monthBounds(month);
  const out = [];
  for (let d = 1; d <= b.maxDay; d += ATT_SEG_DAYS) {
    out.push([`${month}-${padDay(d)}`, `${month}-${padDay(Math.min(d + ATT_SEG_DAYS - 1, b.maxDay))}`]);
  }
  return out;
}

// ---------------------------------------------------------------- 网络层（与运力模块同款）
const state = {
  via: "direct", gen: 0, loading: false,
  month: curMonth(), dim: "agency", scopeKey: "", view: "shift",
  teams: [], teamErr: "",
  recs: [], attErr: "",
  orders: [], kpiErr: "",
  liveUsed: false
};
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
function checkJson(j, label) {
  if (!j || typeof j !== "object") throw new Error(label + " 未返回 JSON");
  const r = j.result;
  if (r && (r.success === false || String(r.code) === "500")) {
    throw new Error(label + "：" + (r.message || r.msg || "业务失败"));
  }
  if (j.err_code && String(j.err_code) !== "200" && String(j.code) !== "200") {
    throw new Error(label + "：" + (j.msg || "接口拒绝"));
  }
  return j;
}
async function direct(url, method, payload) {
  const opt = { method, credentials: "include", referrerPolicy: "unsafe-url" };
  if (method === "POST") {
    opt.headers = { "Content-Type": "text/plain;charset=UTF-8" };
    opt.body = JSON.stringify(payload || {});
  }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return checkJson(await r.json(), url.split("/").pop().split("/")[0]);
}
async function bridge(url, method, payload) {
  const msg = method === "GET"
    ? { type: "BRIDGE_GET", url }
    : { type: "BRIDGE_API", api: url, payload: payload || {} };
  const resp = await extMsg(msg);
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应（可能尚未登录风神）");
  return checkJson(resp.json, "静默桥接");
}
async function request(url, method, payload) {
  if (state.via === "direct") {
    try { return await direct(url, method, payload); }
    catch (e) {
      // 限频不切通道：切到桥接同样会撞同一个后端限流，退避重试更有效
      if (/频繁|FREQUEN/i.test(String((e && e.message) || e))) throw e;
      state.via = "bridge";
      showNotice("直连未成功（" + (e.message || "未知原因") + "），已自动切到「静默桥接」后台标签取数。", "blue");
    }
  }
  return await bridge(url, method, payload);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 带「请求太频繁」退避重试的请求：违规处罚 / 考核运单明细接口对连发敏感。 */
async function requestRL(url, method, payload, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await request(url, method, payload); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (i < tries - 1 && /频繁|FREQUEN/i.test(msg)) {
        await sleep(1500 * (i + 1) + Math.round(Math.random() * 400));
        continue;
      }
      throw e;
    }
  }
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

// ---------------------------------------------------------------- UI 小件
function setStatus(t) { $("ql-state").textContent = t || ""; }
function setProgress(pct, text) {
  $("progress-wrap").hidden = pct == null;
  if (pct != null) {
    $("bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
    $("progress-text").textContent = text || "";
  }
}
function showNotice(msg, tone) {
  const n = $("notice");
  if (!msg) { n.hidden = true; n.textContent = ""; return; }
  n.hidden = false;
  n.textContent = msg;
  n.style.borderColor = tone === "blue" ? "#93C5FD" : "#F59E0B";
  n.style.background = tone === "blue" ? "#EFF6FF" : "#FFFBEB";
}

// ---------------------------------------------------------------- 维度 / 范围
function teamNameById() {
  const m = Object.create(null);
  for (const t of state.teams) m[t.id] = t.name;
  return m;
}
function areaOf(teamId, siteName) {
  const names = teamNameById();
  const nm = str(siteName) || names[normId(teamId)] || "";
  return SITE_TO_AREA[nm] || nm || ("未映射站点 " + normId(teamId));
}
function areaList() {
  const set = new Set();
  for (const t of state.teams) set.add(SITE_TO_AREA[t.name] || t.name);
  return [...set];
}
function riderList() {
  // 骑手清单来自本月出勤明细 + 坏单明细（出勤数据没到时至少能看到有坏单的骑手）
  const m = new Map();
  for (const r of state.recs) {
    if (!m.has(r.rid)) m.set(r.rid, { rid: r.rid, name: r.name || "", teamId: r.teamId });
    else if (!m.get(r.rid).name && r.name) m.get(r.rid).name = r.name;
  }
  for (const o of state.orders) {
    if (!m.has(o.rid)) m.set(o.rid, { rid: o.rid, name: o.rname || "", teamId: o.teamId });
    else if (!m.get(o.rid).name && o.rname) m.get(o.rid).name = o.rname;
  }
  return [...m.values()].sort((a, b) => (a.name || a.rid).localeCompare(b.name || b.rid));
}
function inScope(rec) {
  const d = state.dim;
  if (d === "agency") return true;
  if (d === "area") return areaOf(rec.teamId, rec.siteName) === state.scopeKey;
  if (d === "site") return normId(rec.teamId) === normId(state.scopeKey);
  if (d === "rider") return normId(rec.rid) === normId(state.scopeKey);
  return true;
}
function scopeLabel() {
  if (state.dim === "agency") return "整商";
  return state.scopeKey || "—";
}

// ---------------------------------------------------------------- 数据源 1/2：出勤明细（含今天实时快照）
async function loadTeams() {
  const j = await request(API_TEAMS, "POST", { metas: {}, params: { request: {} } });
  const d = (j && j.result && j.result.data) || [];
  const arr = Array.isArray(d) ? d : (d.teams || d.list || []);
  return (arr || []).filter((t) => t && t.id).map((t) => ({
    id: normId(t.id), name: String(t.team_name || t.name || t.id)
  }));
}
async function loadSheets(month, teamIds) {
  const segs = monthSegments(month);
  const sheets = [];
  for (let i = 0; i < segs.length; i++) {
    const [s, e] = segs[i];
    const j = await request(API_ATT_DETAIL, "POST", {
      params: { request: { teamIds, startDate: s, endDate: e } }
    });
    const d = (j && j.result && j.result.data) || {};
    const url = d.url || d.downloadUrl;
    if (!url || !/^https?:/.test(String(url))) throw new Error(`出勤明细 ${s}~${e} 未返回下载链接`);
    sheets.push(...(await XLSX_READER.read(await fetchBinary(String(url)))));
    setProgress(10 + Math.round(((i + 1) / segs.length) * 45), `出勤明细 ${s}~${e}（${i + 1}/${segs.length} 段）`);
    if (segs.length > 1) await new Promise((r) => setTimeout(r, 180));
  }
  return sheets;
}
/** 解析骑手 × 时段明细：返回记录数组。defaultDay 供无「考勤日期」列的实时快照使用。 */
function parseAttSheets(sheets, defaultDay) {
  const out = [];
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || rows.length < 2) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = str(h);
      if (k && col[k] === undefined) col[k] = i;
    });
    const idx = (...names) => { for (const n of names) if (col[n] !== undefined) return col[n]; return undefined; };
    const iR = idx("骑手ID", "骑手id", "骑手Id");
    const iName = idx("骑手姓名", "姓名", "骑手名称");
    const iS = idx("站点ID", "站点id", "站点Id");
    const iN = idx("站点名称", "团队名称", "站点");
    const iD = idx("考勤日期", "日期");
    const iP = idx("时段", "班次");
    const iOk = idx("是否达成");
    const iSched = idx("是否排班");
    const iO = idx("时段完单量", "完单量");
    const iV = idx("时段有效在线时长", "有效在线时长", "有效在线");
    if (iR === undefined || iP === undefined) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const per = str(r[iP]);
      if (!per) continue;
      const day = iD !== undefined ? str(r[iD]).slice(0, 10) : str(defaultDay);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      // 有「是否排班」列时按它过滤；没排班的人不进矩阵
      if (iSched !== undefined && str(r[iSched]) === "否") continue;
      const okRaw = iOk !== undefined ? str(r[iOk]) : "";
      const ok = okRaw === "达成" ? 1 : (okRaw === "未达成" ? 0 : -1);
      out.push({
        rid, name: iName !== undefined ? str(r[iName]) : "",
        teamId: iS !== undefined ? normId(r[iS]) : "",
        siteName: iN !== undefined ? str(r[iN]) : "",
        day, per, ok,
        orders: iO !== undefined ? num(r[iO]) : 0,
        online: iV !== undefined ? str(r[iV]) : ""
      });
    }
  }
  return out;
}
async function loadLiveToday(teamIds, today) {
  const j = await request(API_ATT_LIVE, "POST", {
    params: { request: { teamIds, startDate: today, endDate: today } }
  });
  const d = (j && j.result && j.result.data) || {};
  const url = d.url || d.downloadUrl;
  if (!url || !/^https?:/.test(String(url))) throw new Error("实时考勤快照未返回下载链接");
  return await XLSX_READER.read(await fetchBinary(String(url)));
}

// ---------------------------------------------------------------- 数据源 3：坏单（Radio 4 筛选 + 违规处罚补全）
/** 解析一页考核运单明细（带日期），按运单ID 去重合并进 seen（同单标记取并集）。 */
function parseBadRows(j, seen) {
  const d = (j && j.result && j.result.data) || {};
  const heads = (d.multiHeaders || [])[0] || [];
  const rows = Array.isArray(d.data) ? d.data : [];
  const ix = (n) => heads.indexOf(n);
  const iT = ix("运单ID"), iR = ix("骑手ID"), iD = ix("日期");
  const iName = ix("骑手姓名"), iS = ix("站点ID"), iN = ix("站点名称");
  const iF = KPI_COLS.map(ix);
  if (iT < 0 || iR < 0 || iD < 0 || iF.some((i) => i < 0)) return { rows: 0 };
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    const val = (i) => (i >= 0 && cells[i] && cells[i].content != null)
      ? String(cells[i].content).trim() : "";
    const tid = val(iT);
    if (!tid) continue;
    const day = val(iD).slice(0, 10);
    const rec = {
      tid, day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "",
      rid: val(iR), rname: iName >= 0 ? val(iName) : "",
      teamId: iS >= 0 ? normId(val(iS)) : "",
      siteName: iN >= 0 ? val(iN) : "",
      lgt: val(iF[0]) === "是" ? 1 : 0,
      complain: val(iF[1]) === "是" ? 1 : 0,
      negative: val(iF[2]) === "是" ? 1 : 0,
      early: val(iF[3]) === "是" ? 1 : 0
    };
    const prev = seen.get(tid);
    if (prev) {
      for (const k of ["lgt", "complain", "negative", "early"]) prev[k] = Math.max(prev[k], rec[k]);
      if (!prev.day && rec.day) prev.day = rec.day;
      if (!prev.rname && rec.rname) prev.rname = rec.rname;
      if (!prev.siteName && rec.siteName) prev.siteName = rec.siteName;
      if (!prev.teamId && rec.teamId) prev.teamId = rec.teamId;
    } else {
      seen.set(tid, rec);
    }
  }
  return { rows: rows.length };
}
/** 违规处罚列表（差评 / 投诉 · 成立）：按 2 天分段拉整月，返回去重后的运单号数组。
 *  接口对连发敏感（实测连发 6 段即触发「请求太频繁」），段间加 400ms 间隔 + 限频退避重试。 */
async function loadViolationTrackingIds(b) {
  const tids = new Set();
  for (let d = 1; d <= b.maxDay; d += VIOL_SEG_DAYS) {
    const segEnd = Math.min(d + VIOL_SEG_DAYS - 1, b.maxDay);
    const start = new Date(b.y, b.m - 1, d, 0, 0, 0).getTime();
    const end = new Date(b.y, b.m - 1, segEnd, 23, 59, 59, 999).getTime();
    for (let p = 1; p <= VIOL_MAX_PAGES; p++) {
      const j = await requestRL(API_VIOLATION, "POST", {
        params: { request: {
          violationStartTime: start, violationEndTime: end,
          violationStatus: [10],                       // 10 = 成立
          violationCategories: ["BAD_REVIEW", "COMPLAIN"],
          pageNo: p, pageSize: 500
        } }
      });
      const d0 = (j && j.result && j.result.data) || {};
      const list = Array.isArray(d0.violationEventList) ? d0.violationEventList : [];
      for (const x of list) {
        const tid = str(x && x.trackingId);
        if (tid) tids.add(tid);
      }
      if (!list.length || list.length < 500 || (d0.count && p * 500 >= d0.count)) break;
    }
    setProgress(58 + Math.round((d / b.maxDay) * 22), `违规处罚 ${monthStr(new Date(b.y, b.m - 1, d))}-${padDay(d)} 段完成`);
    if (d + VIOL_SEG_DAYS <= b.maxDay) await sleep(400);   // 段间限速，避免触发「请求太频繁」
  }
  return [...tids];
}
async function loadBadOrders(month, onStep) {
  const b = monthBounds(month);
  const seen = new Map();
  for (const filter of KPI_FILTERS) {
    for (let p = 1; p <= KPI_MAX_PAGES; p++) {
      const j = await requestRL(API_KPI_DETAIL, "POST", {
        params: { request: {
          queryParam: Object.assign({ ds: [b.start, b.end] }, filter),
          planType: "UPLUS_AGENCY", tabCode: "TRACK_UB",
          pageIndex: p, pageSize: KPI_PAGE_SIZE
        } }
      });
      const { rows } = parseBadRows(j, seen);
      const d = (j && j.result && j.result.data) || {};
      const total = num(d.total);
      if (rows < KPI_PAGE_SIZE || (total && p * KPI_PAGE_SIZE >= total)) break;
    }
    onStep && onStep();
    await sleep(250);                  // 每类筛选之间稍作间隔，降低限频概率
  }
  setProgress(55, "坏单：违规处罚列表拉取中（差评 / 投诉 · 成立）…");
  // 与运力模块 v3.41.0 同款补全：4 个 Radio 筛选漏普通差评 / 投诉，用违规处罚运单号并集补齐
  try {
    const tids = await loadViolationTrackingIds(b);
    for (let i = 0; i < tids.length; i += VIOL_BATCH) {
      const batch = tids.slice(i, i + VIOL_BATCH);
      const j = await requestRL(API_KPI_DETAIL, "POST", {
        params: { request: {
          queryParam: { ds: [b.start, b.end], trackingId: batch.join(",") },
          planType: "UPLUS_AGENCY", tabCode: "TRACK_UB",
          pageIndex: 1, pageSize: KPI_PAGE_SIZE
        } }
      });
      parseBadRows(j, seen);
      setProgress(82, `坏单：违规运单号回查 ${Math.min(i + VIOL_BATCH, tids.length)}/${tids.length}`);
      if (i + VIOL_BATCH < tids.length) await sleep(300);
    }
  } catch (e) {
    console.warn("[viol] 坏单补全失败（不影响 Radio 筛选结果）:", e && e.message);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- 取数总流程
async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  const gen = ++state.gen;
  $("btn-refresh").disabled = true;
  showNotice("");
  state.teamErr = state.attErr = state.kpiErr = "";
  state.recs = []; state.orders = []; state.liveUsed = false;
  setProgress(2, "读取站点列表…");
  try {
    state.teams = await loadTeams();
  } catch (e) {
    state.teamErr = String((e && e.message) || e);
  }
  if (gen !== state.gen) { state.loading = false; return; }
  if (!state.teams.length) {
    setProgress(null);
    setStatus("");
    $("btn-refresh").disabled = false;
    showNotice("站点列表（getTeamsAll）未取到：" + state.teamErr + "。出勤明细需要站点列表才能拉取，可点「立即刷新」重试。");
    renderAll();
    state.loading = false;
    return;
  }
  const teamIds = state.teams.map((t) => t.id);
  try {
    const sheets = await loadSheets(state.month, teamIds);
    if (gen !== state.gen) { state.loading = false; return; }
    state.recs = parseAttSheets(sheets);
  } catch (e) {
    state.attErr = String((e && e.message) || e);
    state.recs = [];
  }
  // 当月补今天：实时快照（接口忽略日期、永远返回实时数据；缺「是否达成」列时显示「统计中」）
  if (state.month === curMonth() && !state.attErr) {
    try {
      const live = await loadLiveToday(teamIds, todayYmd());
      if (gen !== state.gen) { state.loading = false; return; }
      const liveRecs = parseAttSheets(live, todayYmd());
      if (liveRecs.length) {
        const key = (r) => r.rid + "\u0001" + r.day + "\u0001" + r.per;
        const map = new Map();
        for (const r of state.recs) map.set(key(r), r);
        for (const r of liveRecs) map.set(key(r), r);   // 今天以实时快照为准
        state.recs = [...map.values()];
        state.liveUsed = true;
      }
    } catch (e) { /* 快照失败不阻塞，今天显示 T+1 说明 */ }
  }
  setProgress(55, "坏单明细拉取中…");
  try {
    state.orders = (await loadBadOrders(state.month)).filter((o) => o.day);
  } catch (e) {
    state.kpiErr = String((e && e.message) || e);
    state.orders = [];
  }
  if (gen !== state.gen) { state.loading = false; return; }
  setProgress(100, "");
  setProgress(null);
  // 范围下拉按新数据重建（骑手清单来自出勤 + 坏单明细）
  fillScopeSelect(true);
  renderAll();
  const errs = [state.teamErr && "站点列表", state.attErr && "出勤明细", state.kpiErr && "坏单明细"].filter(Boolean);
  if (errs.length) showNotice("部分数据源未取到：" + errs.join("、") + "，对应行列显示「—」，可点「立即刷新」重试。");
  setStatus(`取数完成 ${new Date().toTimeString().slice(0, 5)}${state.via === "bridge" ? " · 静默桥接" : ""}`);
  $("btn-refresh").disabled = false;
  state.loading = false;
}

// ---------------------------------------------------------------- 矩阵聚合（行 = 骑手，列 = 日期）
/** 范围内的骑手行清单：姓名 / 站点 / 商圈片，按姓名排序。 */
function riderRows() {
  const map = new Map();
  const add = (rid, name, teamId, siteName) => {
    rid = normId(rid);
    if (!rid || rid === "0") return;
    if (!map.has(rid)) map.set(rid, { rid, name: "", teamId: "", siteName: "", area: "" });
    const r = map.get(rid);
    if (name && !r.name) r.name = name;
    if (teamId && !r.teamId) r.teamId = normId(teamId);
    if (siteName && !r.siteName) r.siteName = siteName;
  };
  for (const rec of state.recs) if (inScope(rec)) add(rec.rid, rec.name, rec.teamId, rec.siteName);
  for (const o of state.orders) if (inScope(o)) add(o.rid, o.rname, o.teamId, o.siteName);
  const arr = [...map.values()];
  for (const r of arr) r.area = areaOf(r.teamId, r.siteName);
  arr.sort((a, b) => (a.name || a.rid).localeCompare(b.name || b.rid, "zh-CN"));
  return arr;
}
/** 炸班次：Map(rid -> Map(day -> {fails:[班次名], sched, bad, unk, list}))。
 *  fails 只收「未达成」的班次名（含全天，按用户要求直接展示系统标记）。 */
function shiftRiderMatrix() {
  const cells = new Map();
  for (const r of state.recs) {
    if (!inScope(r)) continue;
    let m = cells.get(r.rid);
    if (!m) cells.set(r.rid, m = new Map());
    let c = m.get(r.day);
    if (!c) m.set(r.day, c = { fails: [], sched: 0, bad: 0, unk: 0, list: [] });
    c.sched++;
    if (r.ok === 0) { c.bad++; c.fails.push(r.per); }
    else if (r.ok === -1) c.unk++;
    c.list.push(r);
  }
  return cells;
}
/** 坏单：Map(rid -> Map(day -> {lgt, complain, negative, early, list}))。
  * 一个订单命中多个标签时每个标签各计一次（用户口径）。 */
function badRiderMatrix() {
  const cells = new Map();
  for (const o of state.orders) {
    if (!inScope(o)) continue;
    if (!(o.lgt || o.complain || o.negative || o.early)) continue;
    let m = cells.get(o.rid);
    if (!m) cells.set(o.rid, m = new Map());
    let c = m.get(o.day);
    if (!c) m.set(o.day, c = { lgt: 0, complain: 0, negative: 0, early: 0, list: [] });
    for (const [k] of BAD_COLS) if (o[k]) c[k]++;
    c.list.push(o);
  }
  return cells;
}

// ---------------------------------------------------------------- 渲染
/** 炸班次单元格：只显示炸掉的班次名（红，一行一个，含全天按系统标记）；空白 = 全部达成或无排班；
 *  实时快照缺「是否达成」列时显示琥珀「统计中」。 */
function shiftCellHtml(c) {
  if (!c) return "";
  let html = "";
  for (const per of c.fails) html += `<span class="qf">${esc(per)}</span>`;
  if (html) return html;
  if (c.unk > 0) return '<span class="qu">统计中</span>';
  return "";
}
/** 坏单单元格：只显示非零类型（红「类型*N」一行一个；一个订单命中多个标签各计一次）。 */
function badCellHtml(c) {
  if (!c) return "";
  let html = "";
  for (const [k, name] of BAD_COLS) {
    if (c[k]) html += `<span class="qf">${esc(name)}*${c[k]}</span>`;
  }
  return html;
}
function renderAll() {
  const month = state.month;
  const b = monthBounds(month);
  $("ql-scope").hidden = state.dim === "agency";
  const viewName = state.view === "shift" ? "炸班次" : "坏单";
  const dimName = { agency: "整商", area: "商圈片", site: "站点", rider: "骑手" }[state.dim];
  $("ql-title").innerHTML =
    `${esc(viewName)}矩阵 · <b>${esc(scopeLabel())}</b>` +
    ` <span class="ql-sub">${esc(month)}（1 ~ ${b.maxDay} 日）· ${esc(dimName)}维度` +
    ` · 出勤明细 ${state.recs.length} 行 · 坏单 ${state.orders.length} 单</span>`;
  const wrap = $("matrix-wrap");
  if (!state.recs.length && !state.orders.length) {
    wrap.innerHTML = `<div class="ql-pop-empty">${esc(state.attErr || state.kpiErr || state.teamErr || "本月暂无数据")}</div>`;
    renderFoot();
    return;
  }
  renderRiderTable(wrap, month, b);
  renderFoot();
}
/** 骑手 × 日期矩阵：行 = 范围内骑手（首列冻结），列 = 本月 1 ~ maxDay 日。 */
function renderRiderTable(wrap, month, b) {
  const riders = riderRows();
  const mat = state.view === "shift" ? shiftRiderMatrix() : badRiderMatrix();
  if (!riders.length) {
    wrap.innerHTML = '<div class="ql-pop-empty">该范围内本月没有骑手数据</div>';
    return;
  }
  const isShift = state.view === "shift";
  const mn = Number(month.slice(5, 7));
  let html = '<table class="ql-tbl"><thead><tr><th class="lft ql-rider">骑手姓名</th>';
  for (let d = 1; d <= b.maxDay; d++) html += `<th title="${esc(month)}-${padDay(d)}">${mn}月${d}日</th>`;
  html += "</tr></thead><tbody>";
  for (const rd of riders) {
    const m = mat.get(rd.rid);
    const sub = (state.dim === "area" ? rd.siteName : rd.area) || "";
    html += `<th class="lft ql-rider"><span class="qr-name">${esc(rd.name || rd.rid)}</span>` +
      `<span class="qr-sub">${esc(rd.name ? rd.rid : "")}${sub ? (rd.name ? " · " : "") + esc(sub) : ""}</span></th>`;
    for (let d = 1; d <= b.maxDay; d++) {
      const ymd = `${month}-${padDay(d)}`;
      const c = m && m.get(ymd);
      const body = isShift ? shiftCellHtml(c) : badCellHtml(c);
      const has = isShift ? (c && (c.bad || c.unk)) : (c && c.list.length);
      html += `<td class="ql-cell${has ? " clickable" : ""}"${has ? ` data-rid="${esc(rd.rid)}" data-day="${ymd}" title="点击看 ${esc(rd.name || rd.rid)} ${ymd} 的${isShift ? "班次" : "坏单"}明细"` : ""}>${body}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  wrap.innerHTML = html;
}
function renderFoot() {
  const isCur = state.month === curMonth();
  $("ql-foot").innerHTML =
    "行 = 范围内的骑手（整商 = 全部骑手；商圈片 / 站点 / 骑手按钮 + 下拉切换范围），列 = 本月日期。<br>" +
    "炸班次 = 出勤统计「导出明细数据」的骑手 × 时段明细（本月按 7 天分段；当月今天取 T0 实时考勤快照），" +
    "红字 = 当天炸掉的班次名（含「全天」，按系统「是否达成」标记），空白 = 全部达成或无排班，" +
    "琥珀「统计中」 = 快照缺达成标记；点击单元格看该骑手当天全部班次明细（含完单量 / 有效在线）。<br>" +
    "坏单 = KPI 考核运单明细 4 类问题订单筛选 + 违规处罚列表（违规状态=成立、违规分类=差评+投诉）" +
    "运单号去重后逗号拼接批量回查，两路按运单取并集、不重复计数（与运力模块投诉 / 差评同口径）；" +
    "红字「类型*N」 = 当天各类型坏单数，一个订单命中多个标签时每个标签单独计算；点击单元格看运单明细。" +
    (isCur ? "今天为 T+1 结算数据，当日的班次 / 坏单次日才完整。" : "");
}

// ---------------------------------------------------------------- 详情弹层
function openPop(title, tableHtml) {
  $("ql-pop-title").textContent = title;
  $("ql-pop-body").innerHTML = tableHtml;
  $("ql-pop-mask").hidden = false;
}
function closePop() { $("ql-pop-mask").hidden = true; }
/** 骑手某天的班次明细：全部排班班次 + 达成标记 + 完单 + 有效在线。 */
function shiftPop(month, rid, day) {
  const list = state.recs.filter((r) => r.rid === rid && r.day === day);
  if (!list.length) { openPop(`${day} 班次明细`, '<div class="ql-pop-empty">该日无排班记录</div>'); return; }
  const name = list[0].name || rid;
  let html = '<table><thead><tr><th>姓名</th><th>站点</th><th>班次</th><th>是否达成</th><th>完单</th><th class="lft">有效在线</th></tr></thead><tbody>';
  const ordered = list.slice().sort((a, b) => a.per.localeCompare(b.per, "zh-CN"));
  for (const r of ordered) {
    const mk = r.ok === 1 ? '<span class="mk yes">达成</span>'
      : r.ok === 0 ? '<span class="mk no">未达成</span>' : '<span class="mk tp">统计中</span>';
    html += `<tr><td>${esc(r.name || rid)}</td><td>${esc(r.siteName || areaOf(r.teamId, r.siteName))}</td>` +
      `<td>${esc(r.per)}</td><td>${mk}</td><td>${int(r.orders)}</td><td class="lft">${esc(r.online || "—")}</td></tr>`;
  }
  html += "</tbody></table>";
  const bad = list.filter((r) => r.ok === 0).length;
  openPop(`${name} · ${day} 班次明细 · 排班 ${list.length} 班${bad ? ` · 炸 ${bad} 班` : " · 全部达成"}`, html);
}
/** 骑手某天的坏单明细：运单ID + 类型标签（多标签全列）。 */
function badPop(month, rid, day) {
  const list = state.orders.filter((o) => o.rid === rid && o.day === day && (o.lgt || o.complain || o.negative || o.early));
  if (!list.length) { openPop(`${day} 坏单明细`, '<div class="ql-pop-empty">该日无坏单记录</div>'); return; }
  const name = list[0].rname || list[0].rid || rid;
  let html = '<table><thead><tr><th>日期</th><th class="lft">运单ID</th><th>骑手</th><th>站点</th><th class="lft">类型</th></tr></thead><tbody>';
  for (const o of list) {
    const chips = BAD_COLS.filter(([k]) => o[k]).map(([, n]) => `<span class="mk tp">${esc(n)}</span>`).join(" ");
    html += `<tr><td>${esc(o.day)}</td><td class="lft">${esc(o.tid)}</td><td>${esc(o.rname || o.rid || "—")}</td>` +
      `<td>${esc(o.siteName || areaOf(o.teamId, o.siteName))}</td><td class="lft">${chips || "—"}</td></tr>`;
  }
  html += "</tbody></table>";
  const tags = list.reduce((n, o) => n + BAD_COLS.filter(([k]) => o[k]).length, 0);
  openPop(`${name} · ${day} 坏单明细 · ${list.length} 单 / ${tags} 个标签`, html +
    '<div class="ql-pop-note">注：一个订单命中多个标签时，每个标签各单独计算一次。</div>');
}
function badName(k) { const f = BAD_COLS.find(([key]) => key === k); return f ? f[1] : k; }

function badName(k) { const f = BAD_COLS.find(([key]) => key === k); return f ? f[1] : k; }

// ---------------------------------------------------------------- 控件
function fillScopeSelect(keep) {
  const sel = $("ql-scope");
  const prev = keep ? state.scopeKey : "";
  let opts = [];
  if (state.dim === "area") opts = areaList().map((a) => [a, a]);
  else if (state.dim === "site") opts = state.teams.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((t) => [t.id, t.name]);
  else if (state.dim === "rider") opts = riderList().map((r) => [r.rid, r.name ? `${r.name}（${r.rid}）` : r.rid]);
  sel.innerHTML = opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("")
    || '<option value="">（本月暂无数据）</option>';
  if (prev && opts.some(([v]) => v === prev)) state.scopeKey = prev;
  else state.scopeKey = opts.length ? opts[0][0] : "";
  sel.value = state.scopeKey;
  sel.hidden = state.dim === "agency";
}
function setDim(d) {
  state.dim = d;
  for (const b of document.querySelectorAll(".ql-dim")) b.classList.toggle("active", b.dataset.dim === d);
  fillScopeSelect(false);
  renderAll();
}
function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll(".ql-view")) b.classList.toggle("active", b.dataset.view === v);
  renderAll();
}
function setMonth(m) {
  if (!validMonth(m)) return;
  const min = shiftMonth(curMonth(), -MONTHS_BACK), max = curMonth();
  if (m < min || m > max) return;
  state.month = m;
  localStorage.setItem(LS_MONTH, m);
  $("month-picker").value = m;
  $("btn-prev-month").disabled = m <= min;
  $("btn-next-month").disabled = m >= max;
  loadAll();
}

// ---------------------------------------------------------------- 启动
function boot() {
  try {
    const m = chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* 测试环境 */ }
  const saved = localStorage.getItem(LS_MONTH);
  $("month-picker").value = validMonth(saved) ? saved : curMonth();
  $("btn-prev-month").textContent = "‹";
  $("btn-next-month").textContent = "›";
  $("month-picker").addEventListener("change", () => setMonth($("month-picker").value));
  $("btn-prev-month").addEventListener("click", () => setMonth(shiftMonth(state.month, -1)));
  $("btn-next-month").addEventListener("click", () => setMonth(shiftMonth(state.month, 1)));
  $("btn-this-month").addEventListener("click", () => setMonth(curMonth()));
  $("btn-refresh").addEventListener("click", () => loadAll());
  for (const b of document.querySelectorAll(".ql-dim")) b.addEventListener("click", () => setDim(b.dataset.dim));
  for (const b of document.querySelectorAll(".ql-view")) b.addEventListener("click", () => setView(b.dataset.view));
  $("ql-scope").addEventListener("change", () => { state.scopeKey = $("ql-scope").value; renderAll(); });
  $("matrix-wrap").addEventListener("click", (ev) => {
    const td = ev.target.closest("td.ql-cell.clickable");
    if (!td || !td.dataset.rid || !td.dataset.day) return;
    if (state.view === "shift") shiftPop(state.month, td.dataset.rid, td.dataset.day);
    else badPop(state.month, td.dataset.rid, td.dataset.day);
  });
  $("ql-pop-close").addEventListener("click", closePop);
  $("ql-pop-mask").addEventListener("click", (ev) => { if (ev.target === $("ql-pop-mask")) closePop(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePop(); });
  setMonth(validMonth($("month-picker").value) ? $("month-picker").value : curMonth());
}

// 测试桩（离线单元回归可用 window.__QL__ 取纯函数）
Object.assign(window.__QL__ = window.__QL__ || {}, {
  state, parseAttSheets, parseBadRows, loadViolationTrackingIds,
  monthBounds, monthSegments, riderRows, shiftRiderMatrix, badRiderMatrix,
  inScope, areaOf, areaList, riderList, shiftCellHtml, badCellHtml, requestRL,
  API_ATT_DETAIL, API_ATT_LIVE, API_TEAMS, API_KPI_DETAIL, API_VIOLATION,
  SITE_TO_AREA, KPI_FILTERS, KPI_COLS, BAD_COLS, VIOL_SEG_DAYS, VIOL_BATCH,
  setDim, setView, setMonth, loadAll, renderAll, shiftPop, badPop
});

boot();
