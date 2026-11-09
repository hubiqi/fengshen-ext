/* 运力模块（独立页面 v3.15.0，v3.16.0 增补出勤 / 考核运单明细，v3.16.1 改复合键）
 * ---------------------------------------------------------------------------
 * 五个数据源，账单主表按「骑手 id」合并成一行一条账单；
 * 后两源（出勤 / 异常订单）按「骑手 id ＋ 站点 id」复合键归集，跨站骑手各站分开计：
 *   1) 骑手账单管家 → 账单查询（targetId=58484 / salary-bill-ub）
 *      POST xtop.lpd.price.mng.zsSalaryBillQueryFs.pageQuerySalaryBill/1.0
 *      → 账单ID / 站点 / 骑手 / 基础薪资方案 / 排班内外单量 / 一口价单量明细
 *        （取分离 / 送分离）/ 账单总金额(income) / 预支(prepaymentBonus)
 *        / 住宿费用(accommodationFee) + 车辆租金(vehicleRental)
 *   2) 人资综合服务 → 成员管理 · 全部（targetId=61068 / staffManagement）
 *      GET app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list（不带 workStatus = 全部状态）
 *      → 是否在职(workStatus) / 入职时间(entryTime) / 离职时间(leaveTime)
 *   3) 招募缺口管理 → 线索结果明细（targetId=61364 / tab=station）
 *      POST xtop.knight.task.mng.growth.knightRecruitResultRead.queryAgencyKnightRecruitResult/1.0
 *      → 是否三方人资（命中带 headHunterCompanyName 的线索）
 *   4) 出勤统计 → 导出明细数据（骑手 × 日期 × 时段），单次最多 7 天、按 7 天分段拉整月
 *      POST xtop.fs.special.examine.exportStatisticsDetail/1.0 → OSS xlsx
 *      → 「本月班次异常数（除全天）」= 是否达成 = 未达成 且 时段 ≠ 全天 的行数
 *      → 「首跑时间」= 本月入职骑手，入职日期起第一次「全天」行完单量 > 0 的日期
 *   5) KPI管理 → 考核数据明细 · UB考核运单明细（targetId=56740 / kpi/detail）
 *      POST xtop.performance.fs.opp.perfDetail.queryDetailList/1.0，tabCode=TRACK_UB
 *      4 个 Radio 筛选各查一次（物流责未完成单 / 不满意单_投诉单 / 不满意单_差评单 /
 *      不满意单_索赔单），按运单ID去重后读 4 个「是否XX单」列，按复合键计数
 *      → 物流责 / 投诉 / 差评 / 提前点
 *
 * 与另两个页面一样：直连优先、失败自动切「静默桥接」；跟随当前登录态，不依赖本地服务。
 * 前三源并行取数先出主表，后两源异步补齐（失败只让对应列显示「—」，不阻断出表）。
 * v3.16.0：账单ID 默认不在页面/导出图里显示，只在「导出 CSV」时带上。
 * v3.16.1：出勤异常 / 首跑 / 4 类坏单改按「骑手 id ＋ 站点 id」聚合，
 *          两个源都读「站点ID」列（与账单 teamId 同体系）；缺站点ID 时归通配键，
 *          仅当该骑手在账单里只有一个站点时才兜底采用，避免跨站串数。
 * v3.18.0：表头点击排序（升序 → 降序 → 取消）＋ 每列漏斗筛选（唯一值多选）；
 *          表头纵向冻结，左侧列可自定义冻结（一列或几列、localStorage 记忆）。
 *          排序与筛选统一作用于页面 / CSV / 复制图片；冻结只是屏幕上的滚动行为，
 *          导出图由 capture.js 关掉 sticky 后还原成完整表格。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_BILL = XT + "xtop.lpd.price.mng.zsSalaryBillQueryFs.pageQuerySalaryBill/1.0";
const API_CLUE = XT + "xtop.knight.task.mng.growth.knightRecruitResultRead.queryAgencyKnightRecruitResult/1.0";
const API_STAFF = "https://app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list";
const API_ATT_DETAIL = XT + "xtop.fs.special.examine.exportStatisticsDetail/1.0";
const API_KPI_DETAIL = XT + "xtop.performance.fs.opp.perfDetail.queryDetailList/1.0";
const PAGE_SIZE = 500;
const KPI_PAGE_SIZE = 100;       // 实测 pageSize > 100 接口返回空数据
const KPI_MAX_PAGES = 10;       // 每类问题订单最多 10 页 = 1000 单，防止异常情况下退化成全量翻页
const ATT_SEG_DAYS = 7;          // 出勤明细接口硬限制：单次最多导出 7 天
const MONTHS_BACK = 11;          // 当前月 + 往前 11 个月 = 最近 12 个月
const MAX_PAGES = 20;
const SRC_LABEL = { bill: "薪资账单", staff: "人资名单", clue: "线索结果明细",
  att: "本月出勤明细", kpi: "考核运单明细" };

// 考核运单明细的 4 个筛选：分别把命中的少量订单拉回来，按运单ID去重后读列值聚合。
// 三个 is_early_delivery_* 是「提前点送达不满意单」的下属分类，合并后正好覆盖提前点列。
const KPI_FILTERS = [
  { is_lgt_duty_incompleted_order: "1" },
  { is_early_delivery_complain_order: "1" },
  { is_early_delivery_negative_rating_order: "1" },
  { is_early_delivery_claim_order: "1" }
];
const KPI_COLS = ["是否物流责取消单", "是否投诉单", "是否差评单", "是否提前点送达不满意单"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => String(Math.round(num(v)));
const money = (v) => "¥" + num(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (v) => (v == null || String(v).trim() === "" ? "—" : String(v));
const shortTime = (v) => {
  const s = String(v == null ? "" : v).trim();
  return s ? s.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}).*$/, "$1 $2") : "—";
};
const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const curMonth = () => monthStr(new Date());
const shiftMonth = (m, delta) => {
  const [y, mm] = String(m).split("-").map(Number);
  return monthStr(new Date(y, mm - 1 + delta, 1));
};
const validMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ""));

// v3.16.1：一个骑手可能在不同站点各有一条账单。出勤异常 / 首跑 / 4 类坏单
// 必须按「骑手 id + 站点 id」归集，否则 A 站的问题订单会被重复记到 B 站账单行上。
// 两个数据源都有「站点ID」列，且与账单 teamId 是同一套 id（实测 7/7 站点全命中）。
const normId = (v) => {
  const s = String(v == null ? "" : v).trim();
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
};
const ANY_SITE = "*";
const pairKey = (rid, teamId) => normId(rid) + "\u0001"
  + normId(teamId == null || String(teamId).trim() === "" ? ANY_SITE : teamId);
// 数据源偶尔缺「站点ID」列时归到通配键；仅当该骑手在账单里只有一个站点时才采用，
// 避免把没有站点信息的数据摊到跨站骑手的某一行上。
function pairGet(map, rid, teamId) {
  const hit = map.get(pairKey(rid, teamId));
  if (hit !== undefined) return hit;
  if (state.singleSiteRiders && state.singleSiteRiders.has(normId(rid)))
    return map.get(pairKey(rid, ANY_SITE));
  return undefined;
}

// 23 列：h 表头 / k 页面字段 / cls 单元格 class / csv 导出字段 / page:false = 只在 CSV 里出现。
// v3.16.0：账单ID 默认不显示（页面与「复制图片」都不含），只有「导出 CSV」才带。
// 页面金额 / 单量用 *Text（带 ¥ 与千分位），CSV 用原始数值，Excel 才能直接求和。
const COLS = [
  { h: "账单ID", k: "billId", cls: "c-bill", csv: "billId", page: false },
  { h: "站点id", k: "teamId", cls: "c-id", csv: "teamId" },
  { h: "站点", k: "team", cls: "c-site", csv: "team" },
  { h: "骑手id", k: "riderId", cls: "c-id", csv: "riderId" },
  { h: "骑手姓名", k: "riderName", cls: "c-name", csv: "riderName" },
  { h: "基础薪资方案名称", k: "scheme", cls: "c-scheme", csv: "scheme" },
  { h: "排班内单量", k: "inOrdersText", cls: "num", csv: "inOrders" },
  { h: "排班外单量", k: "outOrdersText", cls: "num", csv: "outOrders" },
  { h: "取分离单量", k: "takeSepText", cls: "num", csv: "takeSep" },
  { h: "送分离", k: "giveSepText", cls: "num", csv: "giveSep" },
  { h: "账单总金额", k: "totalText", cls: "num c-total", csv: "total" },
  { h: "预支", k: "prepayText", cls: "num c-prepay", csv: "prepay" },
  { h: "绑定扣款", k: "bindText", cls: "num c-bind", csv: "bind" },
  { h: "是否在职", k: "onJobHtml", cls: "", csv: "onJob" },
  { h: "入职时间", k: "entry", cls: "c-ts", csv: "entry" },
  { h: "离职时间", k: "leave", cls: "c-ts", csv: "leave" },
  { h: "是否三方人资", k: "thirdHtml", cls: "", csv: "thirdYesRaw" },
  { h: "本月班次异常数（除全天）", k: "badText", cls: "num c-bad", csv: "bad" },
  { h: "首跑时间", k: "firstRunText", cls: "c-ts c-run", csv: "firstRun" },
  { h: "物流责", k: "lgtText", cls: "num c-flag", csv: "lgt" },
  { h: "投诉", k: "complainText", cls: "num c-flag", csv: "complain" },
  { h: "差评", k: "negativeText", cls: "num c-flag", csv: "negative" },
  { h: "提前点", k: "earlyText", cls: "num c-flag", csv: "early" }
];
const PAGE_COLS = COLS.filter((c) => c.page !== false);

// v3.18.0：排序用「原始数值」而不是带 ¥ / 千分位的显示串；这些 csv 字段都是数值型。
const NUM_CSV = new Set(["inOrders", "outOrders", "takeSep", "giveSep", "total",
  "prepay", "bind", "bad", "lgt", "complain", "negative", "early"]);
const COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const LS_FROZEN = "wb_wf_frozen";
const DEFAULT_FROZEN = ["teamId", "team"];   // 默认冻结最左两列，可在面板里任意改
const MAX_FROZEN = 6;                        // 冻结太多会把可滚动区盖住，给个上限
function loadFrozen() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_FROZEN) || "null");
    if (Array.isArray(raw)) {
      const valid = raw.filter((k) => PAGE_COLS.some((c) => c.k === k));
      return [...new Set(valid)].slice(0, MAX_FROZEN);
    }
  } catch (e) { /* 偏好损坏则用默认 */ }
  return DEFAULT_FROZEN.slice();
}

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  month: validMonth(localStorage.getItem("wb_wf_month")) ? localStorage.getItem("wb_wf_month") : curMonth(),
  query: "", site: "", third: "",
  // 表头视图状态：排序（key + 1 升 / -1 降 / 0 无）、列筛选（k -> Set(显示值)）、冻结列 key 列表
  sort: { key: "", dir: 0 },
  colFilters: Object.create(null),
  frozen: loadFrozen(),
  pop: { type: "", key: "", anchor: null },
  loading: false, gen: 0,
  bills: [], staff: new Map(), clues: new Map(),
  errors: {}, rows: [], loadedAt: null,
  // 主表先出图，这两组明细异步补：失败只让对应列显示「—」，不阻断出表
  // 三组明细统一以「骑手id \u0001 站点id」为键（站点id 缺失时用 "*" 通配）
  attBad: new Map(),        // 复合键 -> 本月除「全天」外「未达成」班次数
  attRun: new Map(),        // 复合键 -> Set(全天行完单量 > 0 的日期)
  kpi: new Map(),           // 复合键 -> { lgt, complain, negative, early }
  singleSiteRiders: new Set(),  // 账单里只出现一个站点的骑手，允许通配键兜底
  crossSiteRiders: 0,          // 账单里跨站点的骑手人数（仅用于页面提示）
  attReady: false, kpiReady: false,
  pendingAtt: false, pendingKpi: false, detailLoading: false
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
      state.via = "bridge";       // 只在本页切换，不改写全局通道偏好
      showNotice("直连未成功（" + (e.message || "未知原因") + "），已自动切到「静默桥接」后台标签取数。", "blue");
    }
  }
  return await bridge(url, method, payload);
}

// ---------------------------------------------------------------- 月份 / 二进制
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
const padDay = (d) => String(d).padStart(2, "0");
function monthSegments(month) {
  const b = monthBounds(month);
  const out = [];
  for (let d = 1; d <= b.maxDay; d += ATT_SEG_DAYS) {
    out.push([`${month}-${padDay(d)}`, `${month}-${padDay(Math.min(d + ATT_SEG_DAYS - 1, b.maxDay))}`]);
  }
  return out;
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

// ---------------------------------------------------------------- 分页取数
async function loadBills(month) {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(API_BILL, "POST", {
      params: { request: { bizType: 3, billCycle: month, teamIds: null, settleStatusList: [], pageNum: p, pageSize: PAGE_SIZE } }
    });
    const r = j.result || {};
    const rows = Array.isArray(r.data) ? r.data : [];
    out.push(...rows);
    const total = num(r.total);
    if (!rows.length || rows.length < PAGE_SIZE || (total && out.length >= total)) break;
  }
  return out;
}
async function loadStaff() {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(`${API_STAFF}?pageIndex=${p}&pageSize=${PAGE_SIZE}`, "GET", null);
    const d = j.data || {};
    const list = Array.isArray(d.list) ? d.list : [];
    out.push(...list);
    const count = num(d.count);
    if (!list.length || list.length < PAGE_SIZE || (count && out.length >= count)) break;
  }
  return out;
}
async function loadClues() {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(API_CLUE, "POST", {
      params: { knightRecruitResultRequest: { pageNum: p, pageSize: PAGE_SIZE } }
    });
    const d = (j.result && j.result.data) || {};
    const list = Array.isArray(d.data) ? d.data : [];
    out.push(...list);
    const count = num(d.count);
    if (!list.length || list.length < PAGE_SIZE || (count && out.length >= count)) break;
  }
  return out;
}

// ---------------------------------------------------------------- 本月出勤明细
// 接口单次最多 7 天，按 7 天分段导出 xlsx（OSS 文件，不是全量 JSON 列表）。
async function loadAttendance(month, teamIds) {
  // 串行逐段请求：导出接口对并发敏感，5 段一起发容易触发「请求过于频繁」限流
  const segs = monthSegments(month);
  const bufs = [];
  for (const [s, e] of segs) {
    const j = await request(API_ATT_DETAIL, "POST", {
      params: { request: { teamIds, startDate: s, endDate: e } }
    });
    const d = (j && j.result && j.result.data) || {};
    const url = d.url || d.downloadUrl;
    if (!url || !/^https?:/.test(String(url))) throw new Error(`出勤明细 ${s}~${e} 未返回下载链接`);
    bufs.push(await fetchBinary(String(url)));
    if (segs.length > 1) await new Promise((r) => setTimeout(r, 180));
  }
  const sheets = [];
  for (const buf of bufs) sheets.push(...(await XLSX_READER.read(buf)));
  return attStatsFromSheets(sheets);
}
function attStatsFromSheets(sheets) {
  const bad = new Map(), run = new Map();
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || !rows.length) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim();
      if (k && col[k] === undefined) col[k] = i;
    });
    const iR = col["骑手ID"] != null ? col["骑手ID"] : col["骑手id"];
    const iS = col["站点ID"] != null ? col["站点ID"]
      : (col["站点id"] != null ? col["站点id"] : col["站点Id"]);
    const iD = col["考勤日期"] != null ? col["考勤日期"] : col["日期"];
    const iP = col["时段"], iOk = col["是否达成"];
    const iO = col["完单量"] != null ? col["完单量"] : col["时段完单量"];
    if ([iR, iD, iP, iOk, iO].some((i) => i === undefined)) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const key = pairKey(rid, iS === undefined ? "" : r[iS]);
      const per = String(r[iP] == null ? "" : r[iP]).trim();
      const day = String(r[iD] == null ? "" : r[iD]).slice(0, 10);
      // 口径按用户确认：直接采信系统「是否达成」标记，排除「全天」
      if (per && per !== "全天" && String(r[iOk] == null ? "" : r[iOk]).trim() === "未达成")
        bad.set(key, (bad.get(key) || 0) + 1);
      // 首跑：全天行完单量 > 0 的日期集合，后面按入职日期过滤取最早一天
      if (per === "全天" && num(r[iO]) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        if (!run.has(key)) run.set(key, new Set());
        run.get(key).add(day);
      }
    }
  }
  return { bad, run };
}

// ---------------------------------------------------------------- 考核运单明细
// 只按 4 个 Radio 筛选拉「有问题」的订单，绝不发起不带筛选的全量运单查询
// （本月约 6 万单、整月可达 20 万单）。multiHeaders + data 逐行读 4 个「是否XX单」列，
// 按运单ID 去重后按「骑手 id + 站点 id」汇总；每类筛选最多翻 KPI_MAX_PAGES 页。
// 「提前点送达不满意单」没有独立筛选项，实测 3 个 is_early_delivery_* 子筛选的并集
// 完整覆盖该列（10 月并集 17 单全部命中，日指标汇总 16 单）。
async function loadKpiFlags(month) {
  const b = monthBounds(month);
  const seen = new Map();
  for (const filter of KPI_FILTERS) {
    for (let p = 1; p <= KPI_MAX_PAGES; p++) {
      const j = await request(API_KPI_DETAIL, "POST", {
        params: { request: {
          queryParam: Object.assign({ ds: [b.start, b.end] }, filter),
          planType: "UPLUS_AGENCY", tabCode: "TRACK_UB",
          pageIndex: p, pageSize: KPI_PAGE_SIZE
        } }
      });
      const d = (j && j.result && j.result.data) || {};
      const heads = (d.multiHeaders || [])[0] || [];
      const rows = Array.isArray(d.data) ? d.data : [];
      const ix = (n) => heads.indexOf(n);
      const iT = ix("运单ID"), iR = ix("骑手ID"), iS = ix("站点ID");
      const iF = KPI_COLS.map(ix);
      if (iR < 0 || iF.some((i) => i < 0)) break;
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : [];
        const val = (i) => (i >= 0 && cells[i] && cells[i].content != null)
          ? String(cells[i].content).trim() : "";
        const tid = val(iT);
        if (tid && seen.has(tid)) continue;
        seen.set(tid || ("__" + seen.size), {
          rid: val(iR), teamId: iS >= 0 ? val(iS) : "",
          lgt: val(iF[0]) === "是" ? 1 : 0,
          complain: val(iF[1]) === "是" ? 1 : 0,
          negative: val(iF[2]) === "是" ? 1 : 0,
          early: val(iF[3]) === "是" ? 1 : 0
        });
      }
      const total = num(d.total);
      if (rows.length < KPI_PAGE_SIZE || (total && p * KPI_PAGE_SIZE >= total)) break;
    }
  }
  const out = new Map();
  for (const v of seen.values()) {
    if (!v.rid) continue;
    const key = pairKey(v.rid, v.teamId);
    const cur = out.get(key) || { lgt: 0, complain: 0, negative: 0, early: 0 };
    cur.lgt += v.lgt; cur.complain += v.complain;
    cur.negative += v.negative; cur.early += v.early;
    out.set(key, cur);
  }
  return out;
}

// ---------------------------------------------------------------- 合并口径
function staffMap(list) {
  const m = new Map();
  for (const s of list || []) {
    const rid = String(s.knightId == null ? s.id : s.knightId).trim();
    if (!rid || rid === "0") continue;
    const prev = m.get(rid);
    if (!prev) { m.set(rid, s); continue; }
    // 同一个人有多条记录时优先在职，其次取更晚的入职时间
    const a = num(s.workStatus) === 1 ? 1 : 0, b = num(prev.workStatus) === 1 ? 1 : 0;
    if (a > b || (a === b && String(s.entryTime || "") > String(prev.entryTime || ""))) m.set(rid, s);
  }
  return m;
}
function clueMap(list) {
  const m = new Map();
  for (const c of list || []) {
    const rid = String(c.knightId == null ? "" : c.knightId).trim();
    const hh = String(c.headHunterCompanyName == null ? "" : c.headHunterCompanyName).trim();
    if (!rid || rid === "0" || !hh) continue;
    if (!m.has(rid)) m.set(rid, hh);
  }
  return m;
}
function splitSep(list) {
  let take = 0, give = 0;
  for (const x of list || []) {
    const desc = String(x && x.priceTypeDesc != null ? x.priceTypeDesc : "");
    const n = num(x && x.orderCount);
    if (/取分离/.test(desc)) take += n;
    else if (/送分离/.test(desc)) give += n;
  }
  return { take, give };
}
function buildRows(bills, staff, clues) {
  return (bills || []).map((b) => {
    const riderId = normId(b.knightId);
    const st = staff.get(riderId);
    const hh = clues.get(riderId);
    const sep = splitSep(b.specialOrderCountDetailList);
    const workStatus = st ? num(st.workStatus) : null;
    const onJob = workStatus === 1 ? "是" : (workStatus === 2 ? "否" : "—");
    const bind = num(b.accommodationFee) + num(b.vehicleRental);
    const bindTip = `住宿费用 ${money(b.accommodationFee)} ＋ 车辆租金 ${money(b.vehicleRental)}`;
    return {
      billId: String(b.settleNum || ""), teamId: normId(b.teamId),
      team: String(b.teamName || ""), riderId, riderName: String(b.knightName || ""),
      scheme: String(b.baseRuleName || ""),
      inOrders: num(b.scheduleOrderCount), outOrders: num(b.noScheduleOrderCount),
      takeSep: sep.take, giveSep: sep.give,
      total: num(b.income), prepay: num(b.prepaymentBonus), bind,
      onJob, entry: shortTime(st && st.entryTime), leave: shortTime(st && st.leaveTime),
      thirdYes: !!hh, thirdName: hh || "",
      // 展示用
      inOrdersText: int(b.scheduleOrderCount), outOrdersText: int(b.noScheduleOrderCount),
      takeSepText: int(sep.take), giveSepText: int(sep.give),
      totalText: money(b.income), prepayText: money(b.prepaymentBonus), bindText: money(bind),
      onJobHtml: onJob === "是" ? '<i class="mk yes">是</i>'
        : onJob === "否" ? '<i class="mk no">否</i>' : '<i class="mk na">—</i>',
      thirdHtml: hh
        ? `<i class="mk third" title="${esc(hh)}">是</i>`
        : '<i class="mk na">否</i>',
      bindTip, staffFound: !!st,
      thirdYesRaw: hh ? "是" : "否",
      bad: 0, firstRun: "", lgt: 0, complain: 0, negative: 0, early: 0
    };
  });
}

// ---------------------------------------------------------------- 异步补列
// 没取到数据时显示「—」而不是 0，避免被误读成「确实没有异常」。
function attachDetail(rows) {
  for (const r of rows) {
    // 同一骑手跨站时按「骑手 id + 站点 id」取各自的数据，不串站、不重复计数
    const rid = r.riderId, tid = r.teamId;
    r.bad = pairGet(state.attBad, rid, tid) || 0;
    r.badText = state.pendingAtt ? "…" : (state.attReady ? int(r.bad) : "—");
    // 首跑时间只给本月入职骑手：入职日期起第一个「全天」完单 > 0 的日期
    const isNew = /^\d{4}-\d{2}-\d{2}/.test(r.entry) && r.entry.slice(0, 7) === state.month;
    const days = pairGet(state.attRun, rid, tid);
    const first = isNew && days
      ? ([...days].filter((d) => d >= r.entry.slice(0, 10)).sort()[0] || "") : "";
    r.firstRun = first;
    r.firstRunText = state.pendingAtt ? "…" : (isNew ? (first || "—") : "—");
    const f = pairGet(state.kpi, rid, tid) || {};
    r.lgt = f.lgt || 0; r.complain = f.complain || 0;
    r.negative = f.negative || 0; r.early = f.early || 0;
    const kt = (n) => state.pendingKpi ? "…" : (state.kpiReady ? int(n) : "—");
    r.lgtText = kt(r.lgt); r.complainText = kt(r.complain);
    r.negativeText = kt(r.negative); r.earlyText = kt(r.early);
  }
  return rows;
}

// ---------------------------------------------------------------- 筛选 / 排序（v3.18.0）
// 单元格的「纯文本值」：页面渲染、列筛选候选值、排序比较共用同一口径。
// 两个 HTML 标记列用对应的文本字段，其余直接取展示串（金额带 ¥、时间已格式化）。
function cellText(r, c) {
  if (!r || !c) return "";
  if (c.k === "onJobHtml") return r.onJob || "—";
  if (c.k === "thirdHtml") return r.thirdYesRaw || "否";
  const v = r[c.k];
  return v == null ? "" : String(v);
}
// 「—」「…」与空串都表示「暂无数据」，排序时永远排最后（升降序都一样）。
const EMPTY_CELL = new Set(["", "—", "…", "-"]);
function sortVal(r, c) {
  const t = cellText(r, c).trim();
  if (EMPTY_CELL.has(t)) return null;
  if (NUM_CSV.has(c.csv)) {
    const n = num(r[c.csv]);
    return Number.isFinite(n) && r[c.csv] != null ? n : null;
  }
  return t;
}
function compareCell(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return typeof a === "number" ? a - b : COLLATOR.compare(String(a), String(b));
}
function defaultCompare(a, b) {
  return a.team.localeCompare(b.team, "zh")
    || a.riderName.localeCompare(b.riderName, "zh")
    || a.billId.localeCompare(b.billId);
}
// exceptKey：算某列筛选候选值时排除该列自身，做法同 Excel（其它筛选照常生效）。
function filteredRows(exceptKey) {
  const q = state.query.trim().toLowerCase();
  const active = Object.entries(state.colFilters)
    .filter(([k, set]) => set && set.size && k !== exceptKey)
    .map(([k, set]) => {
      const c = PAGE_COLS.find((x) => x.k === k);
      return c ? { c, set } : null;
    }).filter(Boolean);
  return state.rows.filter((r) => {
    if (state.site && r.team !== state.site) return false;
    if (state.third === "yes" && !r.thirdYes) return false;
    if (state.third === "no" && r.thirdYes) return false;
    if (q && ![r.billId, r.team, r.teamId, r.riderId, r.riderName, r.scheme]
      .some((v) => String(v).toLowerCase().includes(q))) return false;
    for (const { c, set } of active) if (!set.has(cellText(r, c))) return false;
    return true;
  });
}
function visibleRows() {
  const rows = filteredRows(null);
  const c = state.sort.key ? PAGE_COLS.find((x) => x.k === state.sort.key) : null;
  if (c && state.sort.dir) {
    return rows.sort((a, b) => {
      const va = sortVal(a, c), vb = sortVal(b, c);
      // 「—」「…」等无数据行永远垫底，升序降序都一样；不能乘上 dir 把它们翻到最前
      if (va === null || vb === null) {
        if (va === null && vb === null) return defaultCompare(a, b);
        return va === null ? 1 : -1;
      }
      return (compareCell(va, vb) * state.sort.dir) || defaultCompare(a, b);
    });
  }
  return rows.sort(defaultCompare);
}
function toggleSort(key) {
  const s = state.sort;
  if (s.key !== key) { s.key = key; s.dir = 1; }
  else if (s.dir === 1) s.dir = -1;
  else { s.key = ""; s.dir = 0; }
  closePop();
  applyData();
}
function clearView() {
  state.sort = { key: "", dir: 0 };
  state.colFilters = Object.create(null);
  closePop();
  applyData();
}
function activeFilterCount() { return Object.keys(state.colFilters).length; }

// ---------------------------------------------------------------- 渲染
function renderSummary(rows) {
  const riders = new Set(rows.map((r) => r.riderId).filter(Boolean));
  const on = rows.filter((r) => r.onJob === "是").length;
  const off = rows.filter((r) => r.onJob === "否").length;
  const third = rows.filter((r) => r.thirdYes).length;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const prepay = rows.reduce((a, r) => a + r.prepay, 0);
  const bind = rows.reduce((a, r) => a + r.bind, 0);
  const cards = [
    ["账单数", int(rows.length), ""],
    ["去重骑手", int(riders.size), ""],
    ["在职 / 离职", `${int(on)} / ${int(off)}`, ""],
    ["三方人资", int(third), "third"],
    ["账单总金额", money(total), "money"],
    ["预支合计", money(prepay), "money"],
    ["绑定扣款合计", money(bind), "money"]
  ];
  $("wf-summary").innerHTML = cards.map(([k, v, cls]) =>
    `<div class="wf-card ${cls}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");
  const miss = state.rows.filter((r) => !r.staffFound).length;
  const errs = Object.entries(state.errors).filter(([, v]) => v);
  const bits = [`共 <b>${int(state.rows.length)}</b> 条账单，当前筛选显示 <b>${int(rows.length)}</b> 条`];
  if (miss) bits.push(`<b>${int(miss)}</b> 条账单没在人资名单里匹配到（在职 / 入职 / 离职显示「—」）`);
  if (state.crossSiteRiders) bits.push(`<b>${int(state.crossSiteRiders)}</b> 名骑手跨站点，出勤与坏单按「骑手id＋站点id」各站分开计`);
  if (errs.length) bits.push(`<b>${errs.length}</b> 个数据源未取到：${esc(errs.map(([k]) => SRC_LABEL[k] || k).join("、"))}`);
  $("wf-note").innerHTML = bits.join("　·　");
}

function renderTable(rows) {
  const t = $("wf-table");
  // 表头文字保持纯文本：排序箭头与筛选按钮都是 CSS 伪元素 / 空按钮，
  // textContent 仍是原来的列名，复制图片与 CSV 表头不受交互控件影响。
  const head = "<thead><tr>" + PAGE_COLS.map((c, i) => {
    const cls = (state.sort.key === c.k && state.sort.dir === 1) ? " sort-asc"
      : (state.sort.key === c.k && state.sort.dir === -1) ? " sort-desc" : "";
    const filtered = state.colFilters[c.k] ? " filtered" : "";
    const tip = `${c.h}：点击表头按此列排序（升序 → 降序 → 取消）；点右侧 ▾ 按此列筛选`;
    return `<th class="${cls.trim()}${filtered}" data-sort="${esc(c.k)}" data-i="${i}" title="${esc(tip)}">`
      + `${esc(c.h)}<button type="button" class="wf-th-filter" data-filter="${esc(c.k)}"`
      + ` aria-label="按${esc(c.h)}筛选" title="按「${esc(c.h)}」筛选"></button></th>`;
  }).join("") + "</tr></thead>";
  const body = ["<tbody>"];
  if (!rows.length) {
    body.push(`<tr class="wf-empty"><td colspan="${PAGE_COLS.length}">没有符合条件的账单${state.rows.length ? "（试试清空搜索或筛选）" : "（可切换月份或点「立即刷新」）"}</td></tr>`);
  }
  for (const r of rows) {
    body.push("<tr>" + PAGE_COLS.map((c) => {
      const key = c.k;
      const raw = cellText(r, c);
      const isHtml = key === "onJobHtml" || key === "thirdHtml";
      const txt = isHtml ? (r[key] == null ? "" : r[key]) : esc(raw);
      const title = key === "bindText" ? ` title="${esc(r.bindTip)}"`
        : key === "thirdHtml" && r.thirdName ? ` title="${esc(r.thirdName)}"`
        : key === "badText" ? ' title="按骑手id＋站点id 统计：出勤明细中除全天外「是否达成 = 未达成」的班次数"'
        : key === "firstRunText" && r.firstRun ? ` title="入职 ${esc(r.entry)} 起首个全天有单日"` : "";
      const na = !isHtml && (raw === "—" || raw === "" || raw === "…") ? " c-empty" : "";
      const hot = !isHtml && /^(badText|lgtText|complainText|negativeText|earlyText)$/.test(key)
        && Number(raw) > 0 ? " hot" : "";
      return `<td class="${(c.cls || "") + na + hot}"${title}>${txt}</td>`;
    }).join("") + "</tr>");
  }
  body.push("</tbody>");
  t.innerHTML = head + body.join("");
  applyFreeze();
  renderViewState();
}

// ---------------------------------------------------------------- v3.18.0 冻结列
// left 必须按「前面所有冻结列的真实宽度」累加，不能写死；列宽由内容决定，
// 筛选 / 排序 / 切月后都会变，所以每次重绘与窗口 resize 都重算一次。
function applyFreeze() {
  const t = $("wf-table");
  if (!t) return;
  const ths = [...t.querySelectorAll("thead th")];
  if (!ths.length) return;
  const idx = state.frozen.map((k) => PAGE_COLS.findIndex((c) => c.k === k))
    .filter((i) => i >= 0).sort((a, b) => a - b);
  const last = idx.length ? idx[idx.length - 1] : -1;
  let left = 0;
  const offsets = new Map();
  for (const i of idx) {
    offsets.set(i, left);
    left += ths[i] ? ths[i].getBoundingClientRect().width : 0;
  }
  for (const tr of t.querySelectorAll("tr")) {
    const cells = [...tr.children];
    cells.forEach((td, i) => {
      const hit = offsets.has(i);
      td.classList.toggle("fz", hit);
      td.classList.toggle("fz-edge", hit && i === last);
      if (hit) td.style.left = Math.round(offsets.get(i)) + "px";
      else td.style.left = "";
      // v3.19.1：旧版在这里把滚动列整列 visibility:hidden，导致「列消失 + 留白」。
      // 统一清掉历史内联值，之后只靠 sticky 覆盖，不再隐藏任何列。
      if (td.style.visibility) td.style.visibility = "";
    });
  }
}

// v3.19.1：移除「滚动时整列隐藏」逻辑。
// CSS sticky 下被 visibility:hidden 的列仍占布局宽度，冻结列右侧会出现一大片空白，
// 表头与数据行看起来像丢了几列、数字错位（用户实测反馈）。现在 22 列始终全部可见，
// 滚到左边的列由不透明的冻结列自然盖住，逐列对齐、不会出现空洞。
function setFrozen(keys) {
  const valid = [...new Set((keys || []).filter((k) => PAGE_COLS.some((c) => c.k === k)))]
    .sort((a, b) => PAGE_COLS.findIndex((c) => c.k === a) - PAGE_COLS.findIndex((c) => c.k === b))
    .slice(0, MAX_FROZEN);
  state.frozen = valid;
  try { localStorage.setItem(LS_FROZEN, JSON.stringify(valid)); } catch (e) { /* ignore */ }
  applyFreeze();
  renderViewState();
}
function renderViewState() {
  const bits = [];
  if (state.sort.key && state.sort.dir) {
    const c = PAGE_COLS.find((x) => x.k === state.sort.key);
    if (c) bits.push(`排序：${c.h} ${state.sort.dir > 0 ? "↑" : "↓"}`);
  }
  if (activeFilterCount()) bits.push(`列筛选 ${activeFilterCount()} 列`);
  bits.push(`冻结 ${state.frozen.length} 列`);
  $("wf-state").textContent = bits.join("　·　");
  $("btn-freeze").textContent = `冻结列 (${state.frozen.length})`;
  $("btn-clear-view").disabled = !state.sort.key && !activeFilterCount();
}

// ---------------------------------------------------------------- v3.18.0 表头浮层
function popEl() { return $("wf-pop"); }
function closePop() {
  const p = popEl();
  if (p) { p.hidden = true; p.innerHTML = ""; }
  state.pop = { type: "", key: "", anchor: null };
}
function placePop(anchor) {
  const p = popEl();
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth || 268, h = p.offsetHeight || 320;
  let x = Math.min(r.left, window.innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  p.style.left = Math.max(8, Math.round(x)) + "px";
  p.style.top = Math.round(y) + "px";
}
function colValues(key) {
  const c = PAGE_COLS.find((x) => x.k === key);
  if (!c) return [];
  const m = new Map();
  for (const r of filteredRows(key)) {
    const v = cellText(r, c);
    m.set(v, (m.get(v) || 0) + 1);
  }
  const emptyLast = (v) => EMPTY_CELL.has(String(v).trim()) ? 1 : 0;
  return [...m].sort((a, b) => {
    if (emptyLast(a[0]) !== emptyLast(b[0])) return emptyLast(a[0]) - emptyLast(b[0]);
    return NUM_CSV.has(c.csv)
      ? num(String(a[0]).replace(/[^\d.-]/g, "")) - num(String(b[0]).replace(/[^\d.-]/g, ""))
      : COLLATOR.compare(a[0], b[0]);
  });
}
function openFilterPop(key, anchor) {
  const c = PAGE_COLS.find((x) => x.k === key);
  if (!c) return;
  const values = colValues(key);
  const chosen = state.colFilters[key];
  const p = popEl();
  p.className = "wf-pop";
  p.innerHTML =
    `<div class="wf-pop-head"><span>按「${esc(c.h)}」筛选</span><button type="button" data-act="close" title="关闭">×</button></div>`
    + `<div class="wf-pop-tools"><input type="search" class="wf-pop-search" placeholder="搜索取值…" aria-label="搜索取值">`
    + `<button type="button" data-act="all">全选</button><button type="button" data-act="none">清空</button></div>`
    + `<div class="wf-pop-list">` + (values.length ? values.map(([v, n]) =>
      `<label class="wf-pop-item" data-v="${esc(v)}"><input type="checkbox" data-v="${esc(v)}"`
      + `${!chosen || chosen.has(v) ? " checked" : ""}><span class="v" title="${esc(v)}">${esc(v || "（空）")}</span>`
      + `<span class="n">${n}</span></label>`).join("")
      : `<div class="wf-pop-empty">当前数据没有可用的取值</div>`) + `</div>`
    + `<div class="wf-pop-foot"><button type="button" data-act="clear">清除该列</button>`
    + `<button type="button" class="primary" data-act="apply">应用</button></div>`;
  state.pop = { type: "filter", key, anchor };
  placePop(anchor);
}
function openFreezePop(anchor) {
  const p = popEl();
  p.className = "wf-pop freeze";
  p.innerHTML =
    `<div class="wf-pop-head"><span>冻结左侧列（可指定一列或几列）</span>`
    + `<button type="button" data-act="close" title="关闭">×</button></div>`
    + `<div class="wf-pop-tools"><button type="button" data-act="none">不冻结</button>`
    + `<button type="button" data-act="default">默认（站点id＋站点）</button></div>`
    + `<div class="wf-pop-list">` + PAGE_COLS.map((c, i) =>
      `<label class="wf-pop-item"><input type="checkbox" data-freeze="${esc(c.k)}"`
      + `${state.frozen.includes(c.k) ? " checked" : ""}>`
      + `<span class="v">${i + 1}. ${esc(c.h)}</span></label>`).join("") + `</div>`
    + `<div class="wf-pop-foot"><span class="hint">表头始终冻结；建议从左起连续勾选，最多 ${MAX_FROZEN} 列</span>`
    + `<button type="button" class="primary" data-act="close">完成</button></div>`;
  state.pop = { type: "freeze", key: "", anchor };
  placePop(anchor);
}
function applyFilterPop() {
  const p = popEl();
  const boxes = [...p.querySelectorAll('input[type="checkbox"][data-v]')];
  const all = boxes.length;
  const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.v);
  if (!picked.length) {
    showNotice("至少要保留一个取值；如需取消筛选，请点「清除该列」。", "blue");
    return;
  }
  if (picked.length === all) delete state.colFilters[state.pop.key];
  else state.colFilters[state.pop.key] = new Set(picked);
  closePop();
  applyData();
}
function onPopClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "close") { closePop(); return; }
  const p = popEl();
  if (state.pop.type === "filter") {
    const boxes = [...p.querySelectorAll('input[type="checkbox"][data-v]')];
    if (act === "all" || act === "none") boxes.forEach((b) => { b.checked = act === "all"; });
    if (act === "apply") applyFilterPop();
    if (act === "clear") {
      delete state.colFilters[state.pop.key];
      closePop(); applyData();
    }
  } else if (state.pop.type === "freeze") {
    if (act === "none" || act === "default") {
      const want = act === "default" ? DEFAULT_FROZEN : [];
      p.querySelectorAll("input[data-freeze]").forEach((b) => { b.checked = want.includes(b.dataset.freeze); });
      setFrozen(want);
    }
  }
}

function renderSiteOptions() {
  const sel = $("wf-site");
  const keep = sel.value;
  const sites = [...new Set(state.rows.map((r) => r.team).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh"));
  sel.innerHTML = '<option value="">全部站点</option>' +
    sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (sites.includes(keep)) sel.value = keep; else { sel.value = ""; state.site = ""; }
}

function renderMeta() {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  $("doc-sub").innerHTML = `账单月份 ${esc(state.month)}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${esc(d.toLocaleDateString("zh-CN"))} ${hhmm}`;
  $("sub").textContent = `账单 ${state.bills.length} 条 · 人资 ${state.staff.size} 人 · 线索 ${state.clues.size} 人`;
  const parts = [
    `数据源：账单查询 ${state.month}（${state.bills.length} 条）`,
    `成员管理·全部（${state.staff.size} 人）`,
    `线索结果明细（${state.clues.size} 人带三方人资公司）`,
    `本月出勤明细（${monthSegments(state.month).length} 段 × 最多 7 天）`,
    "考核运单明细（4 类异常订单筛选，不拉全量运单）",
    state.loadedAt ? `取数完成 ${state.loadedAt}` : ""
  ].filter(Boolean);
  $("foot-meta").textContent = parts.join("　·　") + "　·　跟随当前浏览器登录态，换账号自动换商";
  $("doc-foot-small").textContent =
    "账单ID 仅在「导出 CSV」时带出；「是否三方人资」按线索结果明细是否命中带猎头（人资）公司的记录判定；" +
    "人资名单取全部状态（含离职）；绑定扣款 = 住宿费用 + 车辆租金；" +
    "本月班次异常数 = 出勤明细里除「全天」外「是否达成 = 未达成」的班次数；" +
    "首跑时间只给本月入职骑手，取入职日起首个「全天」完单 > 0 的日期；" +
    "物流责 / 投诉 / 差评 / 提前点 = 考核运单明细里 4 类异常订单计数；" +
    "出勤异常 / 首跑 / 4 类坏单均按「骑手id＋站点id」归集，同一骑手跨站点各站分开计、不重复；金额单位人民币元。";
}

function applyData() {
  const base = buildRows(state.bills, state.staff, state.clues);
  // 先算「哪些骑手只有一个站点」，attachDetail 里的通配键兜底要用
  const sites = new Map();
  for (const r of base) {
    const rid = normId(r.riderId);
    if (!sites.has(rid)) sites.set(rid, new Set());
    sites.get(rid).add(normId(r.teamId));
  }
  state.singleSiteRiders = new Set([...sites].filter(([, s]) => s.size === 1).map(([rid]) => rid));
  state.crossSiteRiders = [...sites].filter(([, s]) => s.size > 1).length;
  state.rows = attachDetail(base);
  renderSiteOptions();
  const rows = visibleRows();
  renderSummary(rows);
  renderTable(rows);
  renderMeta();
}

// ---------------------------------------------------------------- 进度 / 提示
function setProgress(pct, text) {
  $("bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("progress-text").textContent = text;
  $("progress-wrap").hidden = pct >= 100;
}
function showNotice(msg, kind) {
  const n = $("notice");
  n.className = "notice" + (kind ? " " + kind : "");
  n.textContent = msg;
  n.hidden = false;
}
function clearNotice() { $("notice").hidden = true; }

// ---------------------------------------------------------------- 主流程
async function loadAll() {
  if (state.loading) return;
  // 测试模式：只按注入的样本重画，不触发任何网络请求（切月也一样）
  if (window.__WB_TEST__) { applyData(); setProgress(100, ""); return; }
  const gen = ++state.gen;
  state.loading = true;
  clearNotice();
  setProgress(8, `正在取 ${state.month} 的三份数据…`);
  $("btn-refresh").disabled = true;
  const label = SRC_LABEL;
  let done = 0;
  const tick = (name) => {
    done++;
    setProgress(8 + done * 28, `已取到${label[name]}，继续…`);
    return gen === state.gen;
  };
  const one = async (name, fn) => {
    try {
      const v = await fn();
      state.errors[name] = "";
      return { name, ok: true, v };
    } catch (e) {
      return { name, ok: false, err: String((e && e.message) || e) };
    }
  };
  const [b, s, c] = await Promise.all([
    one("bill", () => loadBills(state.month)),
    one("staff", () => loadStaff()),
    one("clue", () => loadClues())
  ]);
  if (gen !== state.gen) { state.loading = false; return; }
  for (const r of [b, s, c]) {
    if (r.ok) { tick(r.name); state.errors[r.name] = ""; }
    else state.errors[r.name] = r.err;
  }
  if (b.ok) state.bills = b.v; else if (!state.bills.length) state.bills = [];
  if (s.ok) state.staff = staffMap(s.v);
  if (c.ok) state.clues = clueMap(c.v);
  state.loadedAt = new Date().toTimeString().slice(0, 5);
  applyData();
  const teamIds = [...new Set(state.bills.map((b) => num(b.teamId)).filter((n) => n > 0))];
  const fails = Object.entries(state.errors).filter(([, v]) => v);
  setProgress(100, "");
  if (fails.length) {
    showNotice("部分数据源未取到：" + fails.map(([k, v]) => `${label[k] || k}（${v}）`).join("；") +
      "。已用其余数据出表，可点「立即刷新」重试。");
  } else if (!state.bills.length) {
    showNotice(`${state.month} 没有查到账单，可切换月份再试。`, "blue");
  }
  state.loading = false;
  $("btn-refresh").disabled = false;
  loadDetailData(gen, teamIds);      // 后台补 6 列，不阻塞主表
}

// 主表先出图，再异步补「本月出勤明细 + 考核运单明细」两组数据。
// 任一组失败只让对应列显示「—」；切月用 gen 丢弃过期结果。
async function loadDetailData(gen, teamIds) {
  if (state.detailLoading) return;
  state.detailLoading = true;
  state.pendingAtt = true; state.pendingKpi = true;
  state.attReady = false; state.kpiReady = false;
  state.errors.att = ""; state.errors.kpi = "";
  applyData();                       // 先把「…」摆出来，别让格子像忘了做
  const [a, k] = await Promise.allSettled([
    loadAttendance(state.month, teamIds),
    loadKpiFlags(state.month)
  ]);
  if (gen !== state.gen) { state.detailLoading = false; return; }
  if (a.status === "fulfilled") {
    state.attBad = a.value.bad; state.attRun = a.value.run; state.attReady = true;
  } else {
    state.attBad = new Map(); state.attRun = new Map();
    state.errors.att = String((a.reason && a.reason.message) || a.reason);
  }
  if (k.status === "fulfilled") {
    state.kpi = k.value; state.kpiReady = true;
  } else {
    state.kpi = new Map();
    state.errors.kpi = String((k.reason && k.reason.message) || k.reason);
  }
  state.pendingAtt = false; state.pendingKpi = false;
  state.detailLoading = false;
  applyData();
}

function setMonth(m) {
  if (!validMonth(m)) return;
  const min = shiftMonth(curMonth(), -MONTHS_BACK), max = curMonth();
  if (m < min || m > max) return;
  state.month = m;
  localStorage.setItem("wb_wf_month", m);
  $("month-picker").value = m;
  $("btn-prev-month").disabled = m <= min;
  $("btn-next-month").disabled = m >= max;
  loadAll();
}

// ---------------------------------------------------------------- 导出
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const rows = visibleRows();
  // 账单ID 只在 CSV 里出现；金额 / 单量用原始数值，不带 ¥ 和千分位
  const head = COLS.map((c) => c.h);
  const line = (r) => COLS.map((c) => csvCell(r[c.csv])).join(",");
  const text = [head.map(csvCell).join(","), ...rows.map(line)].join("\r\n");
  const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `风神运力模块_${state.month.replace("-", "")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`已导出 ${rows.length} 条账单为 CSV（Excel 可直接打开）。`, "blue");
}

// ---------------------------------------------------------------- 事件
$("btn-prev-month").addEventListener("click", () => setMonth(shiftMonth(state.month, -1)));
$("btn-next-month").addEventListener("click", () => setMonth(shiftMonth(state.month, 1)));
$("btn-this-month").addEventListener("click", () => setMonth(curMonth()));
$("month-picker").addEventListener("change", (e) => setMonth(e.target.value));
$("btn-refresh").addEventListener("click", () => loadAll());
$("wf-search").addEventListener("input", (e) => { state.query = e.target.value; applyData(); });
$("wf-site").addEventListener("change", (e) => { state.site = e.target.value; applyData(); });
$("wf-third").addEventListener("change", (e) => { state.third = e.target.value; applyData(); });
$("btn-export-csv").addEventListener("click", exportCsv);

// ---- v3.18.0：表头排序 / 列筛选 / 冻结列交互 ----
$("wf-table").addEventListener("click", (e) => {
  const f = e.target.closest && e.target.closest("[data-filter]");
  if (f) { openFilterPop(f.dataset.filter, f); return; }
  const th = e.target.closest && e.target.closest("th[data-sort]");
  if (th) toggleSort(th.dataset.sort);
});
$("btn-freeze").addEventListener("click", (e) => {
  if (!popEl().hidden && state.pop.type === "freeze") { closePop(); return; }
  openFreezePop(e.currentTarget);
});
$("btn-clear-view").addEventListener("click", clearView);
$("wf-pop").addEventListener("click", onPopClick);
$("wf-pop").addEventListener("input", (e) => {
  if (!e.target.classList || !e.target.classList.contains("wf-pop-search")) return;
  const q = e.target.value.trim().toLowerCase();
  popEl().querySelectorAll(".wf-pop-item[data-v]").forEach((it) => {
    it.hidden = !!q && !String(it.dataset.v).toLowerCase().includes(q);
  });
});
$("wf-pop").addEventListener("change", (e) => {
  if (!e.target.matches || !e.target.matches("input[data-freeze]")) return;
  const keys = [...popEl().querySelectorAll("input[data-freeze]:checked")]
    .map((b) => b.dataset.freeze);
  setFrozen(keys);
});
document.addEventListener("click", (e) => {
  const p = popEl();
  if (p.hidden || p.contains(e.target)) return;
  const anchor = state.pop.anchor;
  if (anchor && anchor.contains && anchor.contains(e.target)) return;
  if (e.target.closest && e.target.closest("#btn-freeze")) return;
  closePop();
});
window.addEventListener("resize", applyFreeze);
$("btn-copy-image").addEventListener("click", async (e) => {
  const btn = $("btn-copy-image");
  if (btn.disabled) return;
  if (!window.WB_CAPTURE) { showNotice("图片模块未加载：请重新加载扩展或安装新版 zip。"); return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "正在生成图片…";
  try {
    const ym = state.month.replace("-", "");
    const r = await WB_CAPTURE.capture({
      download: e.shiftKey, date: ym, rootId: "sheet",
      filename: `风神运力模块_${ym}.png`
    });
    const size = `${r.width}×${r.height}`;
    showNotice(r.mode === "clipboard"
      ? `已复制运力模块图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`
      : `运力模块图片已另存为 PNG 文件（${size}）。`, "blue");
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}。可先点「纯净看板」，再用系统截图工具替代。`);
  } finally { btn.disabled = false; btn.textContent = label; }
});
$("btn-clean").addEventListener("click", () => {
  closePop();
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
  if (e.key === "Escape") { clearNotice(); closePop(); }
});

// ---------------------------------------------------------------- 测试钩子
// 注入样本数据后直接出表，不触发任何网络请求；CDP 回归用。
// 明细键支持两种写法：复合键 "骑手id\u0001站点id"，或纯骑手id（归到通配站点，
// 只在账单里该骑手只有一个站点时生效，兼容旧样本）。
function hookPairMap(obj, conv) {
  const out = new Map();
  for (const [k, v] of Object.entries(obj || {})) {
    const parts = String(k).split("\u0001");
    const key = parts.length >= 2 ? pairKey(parts[0], parts[1]) : pairKey(k, ANY_SITE);
    out.set(key, conv(v));
  }
  return out;
}
window.__SET_WORKFORCE__ = (obj) => {
  state.errors = obj.errors || {};
  if (Array.isArray(obj.bills)) state.bills = obj.bills;
  if (Array.isArray(obj.staff)) state.staff = staffMap(obj.staff);
  else if (obj.staff instanceof Map) state.staff = obj.staff;
  if (Array.isArray(obj.clues)) state.clues = clueMap(obj.clues);
  else if (obj.clues instanceof Map) state.clues = obj.clues;
  if (obj.month && validMonth(obj.month)) { state.month = obj.month; $("month-picker").value = obj.month; }
  // 真机测试注入出勤 / 考核运单明细，不发网络请求
  if (obj.att) {
    state.attBad = hookPairMap(obj.att.bad, (v) => num(v));
    state.attRun = hookPairMap(obj.att.run, (v) => new Set(v || []));
    state.attReady = true;
  }
  if (obj.kpi) {
    state.kpi = hookPairMap(obj.kpi, (v) =>
      Object.assign({ lgt: 0, complain: 0, negative: 0, early: 0 }, v));
    state.kpiReady = true;
  }
  if (obj.attReady === false) { state.attReady = false; state.attBad = new Map(); state.attRun = new Map(); }
  if (obj.kpiReady === false) { state.kpiReady = false; state.kpi = new Map(); }
  // 真机回归可显式指定视图状态，避免上一次跑留下的 localStorage 偏好干扰
  if (Array.isArray(obj.frozen)) setFrozen(obj.frozen);
  if (obj.sort) state.sort = { key: obj.sort.key || "", dir: num(obj.sort.dir) };
  if (obj.clearView) clearView();
  state.pendingAtt = false; state.pendingKpi = false;
  state.loadedAt = new Date().toTimeString().slice(0, 5);
  applyData();
  setProgress(100, "");
  return state.rows.length;
};
window.__WF__ = { state, COLS, PAGE_COLS, buildRows, attachDetail, visibleRows, splitSep,
  staffMap, clueMap, money, attStatsFromSheets, monthSegments, monthBounds, exportCsv,
  applyData, loadKpiFlags, loadAttendance, KPI_FILTERS,
  normId, pairKey, pairGet, hookPairMap,
  // v3.18.0 视图能力（真机回归用）
  cellText, sortVal, compareCell, filteredRows, toggleSort, clearView, activeFilterCount,
  colValues, openFilterPop, openFreezePop, applyFilterPop, closePop, setFrozen, applyFreeze,
  loadFrozen, DEFAULT_FROZEN, MAX_FROZEN, NUM_CSV };

// ---------------------------------------------------------------- 初始化
(async function init() {
  $("month-picker").value = state.month;
  $("month-picker").min = shiftMonth(curMonth(), -MONTHS_BACK);
  $("month-picker").max = curMonth();
  $("btn-prev-month").disabled = state.month <= shiftMonth(curMonth(), -MONTHS_BACK);
  $("btn-next-month").disabled = state.month >= curMonth();
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (window.__WB_TEST__) { applyData(); setProgress(100, ""); return; }
  loadAll();
})();
