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
 *   6) v3.41.0 差评 / 投诉补全：违规处罚（targetId=57532 / ZSViolationPunish）
 *      POST xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.queryList/1.0
 *      违规状态=成立、违规分类=差评+投诉，接口单次窗口 ≤2 天 → 按 2 天分段拉整月；
 *      运单号去重后逗号拼接（50 单/批）回查考核运单明细，把「是否投诉单 / 是否差评单」
 *      等标记并集合并进第 5 源 —— 4 个 Radio 筛选只覆盖「提前点送达不满意单」子类，
 *      普通差评 / 投诉会漏，两路并集才完整。
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
// v3.36.0：与「出勤达成」T0 同源 —— 实时考勤当日快照（忽略日期参数，永远返回当前实时数据）
const API_ATT_LIVE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
const API_KPI_DETAIL = XT + "xtop.performance.fs.opp.perfDetail.queryDetailList/1.0";
// v3.41.0：违规处罚列表（违规状态=成立 / 违规分类=差评+投诉），单次查询窗口不能超过 2 天
const API_VIOLATION = XT + "xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.queryList/1.0";
const VIOL_SEG_DAYS = 2;          // 违规处罚接口硬限制：单次查询 ≤ 2 天
const VIOL_BATCH = 50;            // 差评/投诉运单号逗号拼接批量回查考核运单明细的批次大小
const VIOL_MAX_PAGES = 3;         // 每个 2 天段最多翻 3 页（pageSize=500，异常情况防全量翻页）
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const SHARE_LS = "wb_wf_raw_v2_";      // v3.46.0：质量运营复用运力模块整月原始明细（同源 localStorage）
const SCALE_LS = "wb_wf_scale_v1";        // v3.31.0：手填的规模目标 / 招募目标 / 招聘缺口 / 渠道名称
const SCALE_LS_DAYS = "wb_wf_scale_days_v1"; // v3.34.0 两个可调统计天数；v3.35.0 增加首跑对比天数
const SCALE_DAYS = 5;                      // 有效出勤规模默认近 5 天
const SCALE_ONJOB_DAYS = 7;                // 在职规模默认近 7 天
const SCALE_FIRST_DAYS = 14;               // v3.35.0：今日首跑对比窗口默认近 14 天（T-14 ~ T-1）
const SCALE_DAYS_MIN = 1, SCALE_DAYS_MAX = 10;              // 有效出勤规模可选 1~10 天
const SCALE_ONJOB_DAYS_MIN = 3, SCALE_ONJOB_DAYS_MAX = 15;  // 在职规模可选 3~15 天
const SCALE_FIRST_DAYS_MIN = 1, SCALE_FIRST_DAYS_MAX = 30;  // 首跑对比窗口可选 1~30 天
const SCALE_MODE_LABEL = {
  any: "有效在线时长>0 或 完单量>0",
  both: "有效在线时长>0 且 完单量>0",
  achieved: "是否达成=达成（不含全天）"
};
// v3.32.0：规模汇总按商圈片聚合，站点→商圈片与考核看板 / 排班 / 实时出勤同一套映射。
// 映射不到的站点按自己的站点名自成一组，不会漏数。
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
// 片区显示顺序与考核看板一致，未识别的片区按名称排在后面。
const SCALE_AREA_ORDER = [
  "福州仓山区城门商圈片", "福州台江区台江商圈片", "福州鼓楼区茶亭西湖商圈片",
  "福州福清市老城商圈片", "福州福清市万达宏路商圈片",
  "福州仓山区仓山商圈片", "福州晋安区商圈片"
];
const PAGE_SIZE = 500;
const KPI_PAGE_SIZE = 100;       // 实测 pageSize > 100 接口返回空数据
const KPI_MAX_PAGES = 10;       // 每类问题订单最多 10 页 = 1000 单，防止异常情况下退化成全量翻页
const ATT_SEG_DAYS = 7;          // 出勤明细接口硬限制：单次最多导出 7 天
const MONTHS_BACK = 11;          // 当前月 + 往前 11 个月 = 最近 12 个月
const MAX_PAGES = 20;
const SRC_LABEL = { bill: "薪资账单", staff: "人资名单", clue: "线索结果明细",
  att: "本月出勤明细", kpi: "考核运单明细", viol: "违规处罚明细" };

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
  staffList: [], clueList: [],          // v3.31.0：汇总要按站点聚合，保留原始人资 / 线索列表
  errors: {}, rows: [], loadedAt: null,
  // v3.32.0 规模汇总：渠道 1 行 + 商圈片明细 N 行；
  // effective / onJob / firstRun = 商圈片名 -> Set(骑手id)，均已排除人资名单里的离职状态。
  scale: {
    days: loadScaleDays().days, onJobDays: loadScaleDays().onJobDays,
    firstDays: loadScaleDays().firstDays,
    start: "", end: "", mode: "any", week: "",
    teams: [], areas: [], byTeam: Object.create(null),
    effective: new Map(), onJob: new Map(), firstRun: new Map(), left: new Set(),
    firstDiag: [],                 // v3.35.0：今日首跑逐人判定明细（姓名 / 完单 / 排除原因）
    manual: loadScaleManual(), ready: false, onJobReady: false, firstReady: false,
    sheets: null, todayRows: null, liveToday: false,
    loading: false, err: "", attAt: ""
  },
  // 主表先出图，这两组明细异步补：失败只让对应列显示「—」，不阻断出表
  // 三组明细统一以「骑手id \u0001 站点id」为键（站点id 缺失时用 "*" 通配）
  attBad: new Map(),        // 复合键 -> 本月除「全天」外「未达成」班次数
  attRun: new Map(),        // 复合键 -> Set(全天行完单量 > 0 的日期)
  kpi: new Map(),           // 复合键 -> { lgt, complain, negative, early }
  violMap: new Map(),       // v3.47.0：违规处罚运单 → 投诉/差评独立标签 + 兜底元信息
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
  const bad = new Map(), run = new Map(), rawRows = [];   // v3.46.0：rawRows 供质量运营复用
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
    const iName = col["骑手姓名"] != null ? col["骑手姓名"] : col["姓名"];
    const iN = col["站点名称"] != null ? col["站点名称"] : col["团队名称"];
    const iSched = col["是否排班"];
    const iPlan = col["排班时段"];
    const iV = col["时段有效在线时长"] != null ? col["时段有效在线时长"] : col["有效在线时长"];
    if ([iR, iD, iP, iOk, iO].some((i) => i === undefined)) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const key = pairKey(rid, iS === undefined ? "" : r[iS]);
      const per = String(r[iP] == null ? "" : r[iP]).trim();
      const day = String(r[iD] == null ? "" : r[iD]).slice(0, 10);
      const d8 = String(r[iD] == null ? "" : r[iD]).replace(/\D/g, "").slice(0, 8);
      const dayN = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : day;
      // v3.46.0：与质量运营同口径保留原始排班行（只留「排班」，快照按「排班时段」过滤）
      const schedRaw = iSched === undefined ? "" : String(r[iSched] == null ? "" : r[iSched]).trim();
      const isSched = iSched === undefined
        ? (iPlan === undefined || String(r[iPlan] == null ? "" : r[iPlan]).split(/[、,，]/).map(x => x.trim()).includes(per))
        : schedRaw === "排班";
      const okRaw = String(r[iOk] == null ? "" : r[iOk]).trim();
      if (isSched && per && /^\d{4}-\d{2}-\d{2}$/.test(dayN)) {
        rawRows.push({
          rid, name: iName === undefined ? "" : String(r[iName] == null ? "" : r[iName]).trim(),
          teamId: iS === undefined ? "" : normId(r[iS]),
          siteName: iN === undefined ? "" : String(r[iN] == null ? "" : r[iN]).trim(),
          day: dayN, per, ok: okRaw === "达成" ? 1 : (okRaw === "未达成" ? 0 : -1),
          orders: num(r[iO]),
          online: iV === undefined ? "" : String(r[iV] == null ? "" : r[iV]).trim()
        });
      }
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
  return { bad, run, rows: rawRows };
}

// ---------------------------------------------------------------- 考核运单明细
// 只按 4 个 Radio 筛选拉「有问题」的订单，绝不发起不带筛选的全量运单查询
// （本月约 6 万单、整月可达 20 万单）。multiHeaders + data 逐行读 4 个「是否XX单」列，
// 按运单ID 去重后按「骑手 id + 站点 id」汇总。
// 「提前点送达不满意单」没有独立筛选项，实测 3 个 is_early_delivery_* 子筛选的并集
// 完整覆盖该列。
// v3.41.0 差评 / 投诉补全：4 个 Radio 筛选只能覆盖「提前点送达不满意单」的子类，
// 普通差评 / 投诉单会漏。改从违规处罚列表（违规状态=成立、违规分类=差评+投诉）
// 拉整月运单号（接口单次 ≤2 天 → 按 2 天分段），去重后逗号拼接 50 单/批回查
// 考核运单明细，把「是否投诉单 / 是否差评单」等标记与 Radio 筛选的结果取并集。
// 解析一页考核运单明细：读 4 个「是否XX单」列，按运单ID去重合并进 seen。
// 已存在的运单取各标记的并集（max），补全路不会把 Radio 路已拿到的标记冲掉。
/** 违规处罚 item → 差评 / 投诉独立标签（v3.47.0，与质量运营同口径）。
 *  真机核实：提前点送达类投诉违规（violationReason「未在收货地址附近点击送达」）
 *  在考核运单明细里「是否投诉单 / 是否差评单」列全是「否」，只靠回查 KPI 明细会漏计；
 *  因此违规分类本身就是一个独立的投诉 / 差评标签，与 KPI 4 列取并集。 */
function violationFlags(x) {
  const tid = String((x && x.trackingId) || "").trim();
  if (!tid) return null;
  const cat = String((x && x.violationCategory) || "").toUpperCase();
  const d8 = String((x && x.violationTime) || "").replace(/\D/g, "").slice(0, 8);
  const day = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : "";
  const ki = String((x && x.knightInfo) || "").split("-");
  const ti = String((x && x.teamInfo) || "").split("-");
  return {
    tid, day,
    rid: normId(ki[0] || ""), rname: ki.slice(1).join("-"),
    teamId: normId(ti[0] || ""), siteName: ti.slice(1).join("-"),
    complain: cat === "COMPLAIN" ? 1 : 0,
    negative: cat === "BAD_REVIEW" ? 1 : 0
  };
}
/** 把违规处罚投诉 / 差评标记并入 seen（同单不重复计数）；KPI 回查缺行时用违规 item 兜底建行。 */
function applyViolationFlags(seen) {
  let added = 0, boosted = 0;
  for (const [tid, v] of state.violMap) {
    const cur = seen.get(tid);
    if (cur) {
      if (v.complain && !cur.complain) { cur.complain = 1; boosted++; }
      if (v.negative && !cur.negative) { cur.negative = 1; boosted++; }
      if (!cur.day && v.day) cur.day = v.day;
      if (!cur.rid && v.rid) cur.rid = v.rid;
      if (!cur.rname && v.rname) cur.rname = v.rname;
      if (!cur.teamId && v.teamId) cur.teamId = v.teamId;
      if (!cur.siteName && v.siteName) cur.siteName = v.siteName;
    } else if (v.day && (v.complain || v.negative)) {
      seen.set(tid, {
        tid, day: v.day, rid: v.rid, rname: v.rname, teamId: v.teamId, siteName: v.siteName,
        lgt: 0, complain: v.complain, negative: v.negative, early: 0
      });
      added++;
    }
  }
  return { added, boosted };
}
function parseKpiRows(j, seen) {
  const d = (j && j.result && j.result.data) || {};
  const heads = (d.multiHeaders || [])[0] || [];
  const rows = Array.isArray(d.data) ? d.data : [];
  const ix = (n) => heads.indexOf(n);
  const iT = ix("运单ID"), iR = ix("骑手ID"), iS = ix("站点ID");
  const iD = ix("日期"), iName = ix("骑手姓名"), iN = ix("站点名称"), iCreate = ix("运单创建时间");
  const iF = KPI_COLS.map(ix);
  if (iR < 0 || iF.some((i) => i < 0)) return { rows: 0 };
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    const val = (i) => (i >= 0 && cells[i] && cells[i].content != null)
      ? String(cells[i].content).trim() : "";
    const tid = val(iT);
    // 「日期」列实际是 20261111 这样的 8 位紧凑格式（真机核实），统一归一为 YYYY-MM-DD
    const d8 = (iD >= 0 ? val(iD) : "").replace(/\D/g, "").slice(0, 8)
      || (iCreate >= 0 ? val(iCreate) : "").replace(/\D/g, "").slice(0, 8);
    const day = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : "";
    const flags = {
      rid: val(iR), teamId: iS >= 0 ? val(iS) : "",
      tid, day, rname: iName >= 0 ? val(iName) : "", siteName: iN >= 0 ? val(iN) : "",
      lgt: val(iF[0]) === "是" ? 1 : 0,
      complain: val(iF[1]) === "是" ? 1 : 0,
      negative: val(iF[2]) === "是" ? 1 : 0,
      early: val(iF[3]) === "是" ? 1 : 0
    };
    const prev = tid && seen.get(tid);
    if (prev) {
      prev.lgt = Math.max(prev.lgt, flags.lgt);
      prev.complain = Math.max(prev.complain, flags.complain);
      prev.negative = Math.max(prev.negative, flags.negative);
      prev.early = Math.max(prev.early, flags.early);
      if (!prev.day && flags.day) prev.day = flags.day;
      if (!prev.rname && flags.rname) prev.rname = flags.rname;
      if (!prev.siteName && flags.siteName) prev.siteName = flags.siteName;
    } else {
      seen.set(tid || ("__" + seen.size), flags);
    }
  }
  return { rows: rows.length };
}

// 违规处罚列表（差评 / 投诉 · 成立）：按 2 天分段拉整月，返回去重后的运单号数组
async function loadViolationTrackingIds(b) {
  const tids = new Set();
  state.violMap = new Map();
  for (let d = 1; d <= b.maxDay; d += VIOL_SEG_DAYS) {
    const segEnd = Math.min(d + VIOL_SEG_DAYS - 1, b.maxDay);
    const start = new Date(b.y, b.m - 1, d, 0, 0, 0).getTime();
    const end = new Date(b.y, b.m - 1, segEnd, 23, 59, 59, 999).getTime();
    for (let p = 1; p <= VIOL_MAX_PAGES; p++) {
      const j = await request(API_VIOLATION, "POST", {
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
        const v = violationFlags(x);
        if (!v) continue;
        tids.add(v.tid);
        const prev = state.violMap.get(v.tid);
        if (prev) {
          prev.complain = Math.max(prev.complain, v.complain);
          prev.negative = Math.max(prev.negative, v.negative);
          if (!prev.day && v.day) prev.day = v.day;
          if (!prev.rname && v.rname) prev.rname = v.rname;
          if (!prev.siteName && v.siteName) prev.siteName = v.siteName;
        } else {
          state.violMap.set(v.tid, v);
        }
      }
      if (!list.length || list.length < 500 || (d0.count && p * 500 >= d0.count)) break;
    }
  }
  return [...tids];
}

async function loadKpiFlags(month) {
  const b = monthBounds(month);
  const seen = new Map();
  state.violMap = new Map();
  for (const filter of KPI_FILTERS) {
    for (let p = 1; p <= KPI_MAX_PAGES; p++) {
      const j = await request(API_KPI_DETAIL, "POST", {
        params: { request: {
          queryParam: Object.assign({ ds: [b.start, b.end] }, filter),
          planType: "UPLUS_AGENCY", tabCode: "TRACK_UB",
          pageIndex: p, pageSize: KPI_PAGE_SIZE
        } }
      });
      const { rows } = parseKpiRows(j, seen);
      const d = (j && j.result && j.result.data) || {};
      const total = num(d.total);
      if (rows < KPI_PAGE_SIZE || (total && p * KPI_PAGE_SIZE >= total)) break;
    }
  }
  // v3.41.0 差评 / 投诉补全：违规处罚（成立）运单号 → 逗号拼接批量回查考核运单明细。
  // 失败只少补一部分数据，不让整个考核运单明细源挂掉。
  try {
    const tids = await loadViolationTrackingIds(b);
    for (let i = 0; i < tids.length; i += VIOL_BATCH) {
      const batch = tids.slice(i, i + VIOL_BATCH);
      const j = await request(API_KPI_DETAIL, "POST", {
        params: { request: {
          queryParam: { ds: [b.start, b.end], trackingId: batch.join(",") },
          planType: "UPLUS_AGENCY", tabCode: "TRACK_UB",
          pageIndex: 1, pageSize: KPI_PAGE_SIZE
        } }
      });
      parseKpiRows(j, seen);
    }
  } catch (e) {
    console.warn("[viol] 差评/投诉补全失败（不影响 Radio 筛选结果）:", e && e.message);
  }
  // v3.47.0：违规分类（成立投诉 / 差评）作为独立标签并入，与考核运单明细 4 列取并集。
  // 一个订单同时命中「提前点」与「差评 / 投诉」时，两个标签都要单独计数。
  applyViolationFlags(seen);
  // v3.46.0：把带日期 / 运单号 / 骑手 / 站点的原始坏单留给质量运营复用
  state.rawOrders = [...seen.values()]
    .filter((v) => v.tid && v.day && (v.lgt || v.complain || v.negative || v.early))
    .map((v) => ({ tid: v.tid, day: v.day, rid: v.rid, rname: v.rname || "",
      teamId: normId(v.teamId || ""), siteName: v.siteName || "",
      lgt: v.lgt, complain: v.complain, negative: v.negative, early: v.early }));
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

// ---------------------------------------------- v3.31.0 规模汇总 / v3.32.0 商圈片与口径修订
/* 一张「渠道汇总 1 行 + 商圈片明细 N 行」的表，整块在 #sheet 内，页面与「复制图片」
   用的是同一份 DOM，所以导出图和屏幕上的数值 / 排版完全一致。
   自动：站点（getTeamsAll）→ 商圈片（SITE_TO_AREA）、代理商名称（线索结果明细 / 本机商名）、
         在职规模、今日入职 / 首跑 / 离职、N天有效出勤规模、规模达成率、净缺口、汇总行合计。
   手填：渠道名称、规模目标 W46、招募目标、渠道招聘缺口（浅黄格，按周次本机记忆）。
   v3.32.0 三条口径（用户逐条核对）：
     1) 明细按商圈片聚合，站点名先映射到商圈片，未命中的按站点自成一组；
     2) 列名是「5天有效出勤规模」（N 随所选区间天数变），取数逻辑沿用 v3.31.0：
        区间内至少 1 天有效的骑手，按「商圈片 + 骑手」去重、汇总行再跨片区去重；
     3) 「在职规模」不再取人资 workStatus=1，改取 T-7 ~ T-1 考勤明细里「全天」行
        有效的骑手去重；两类人数都排除人资名单里已离职 / 非在职状态的骑手。
   v3.35.0 两条修订（用户逐条核对）：
     1) 表头「今日入司」改叫「今日入职」；
     2) 「今日首跑」改为：今日完单量>0 的骑手，对比 T-N ~ T-1（默认 14 天，可设置）
        从未有完单量>0 的「新增」骑手；历史对比按骑手全局去重（换站点不算新增），
        计数按今日所在商圈片归类、汇总行再跨片区去重，同样排除离职状态。
   数据源就是算「炸班次」的 exportStatisticsDetail（含每天的有效在线时长与完单量）。 */
function loadScaleManual() {
  try {
    const o = JSON.parse(localStorage.getItem(SCALE_LS) || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
function saveScaleManual() {
  try { localStorage.setItem(SCALE_LS, JSON.stringify(state.scale.manual)); } catch (e) { /* ignore */ }
}
/** v3.34.0：天数只允许各自范围内的整数，越界 / 非数字 / 缺失都退回默认。 */
function clampScaleDays(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}
function loadScaleDays() {
  let days = SCALE_DAYS, onJobDays = SCALE_ONJOB_DAYS, firstDays = SCALE_FIRST_DAYS;
  try {
    const o = JSON.parse(localStorage.getItem(SCALE_LS_DAYS) || "{}");
    if (o && typeof o === "object" && !Array.isArray(o)) {
      days = clampScaleDays(o.days, SCALE_DAYS_MIN, SCALE_DAYS_MAX, SCALE_DAYS);
      onJobDays = clampScaleDays(o.onJobDays, SCALE_ONJOB_DAYS_MIN, SCALE_ONJOB_DAYS_MAX, SCALE_ONJOB_DAYS);
      firstDays = clampScaleDays(o.firstDays, SCALE_FIRST_DAYS_MIN, SCALE_FIRST_DAYS_MAX, SCALE_FIRST_DAYS);
    }
  } catch (e) { /* 读不到就用默认 */ }
  return { days, onJobDays, firstDays };
}
function saveScaleDays() {
  try {
    localStorage.setItem(SCALE_LS_DAYS, JSON.stringify({
      days: state.scale.days, onJobDays: state.scale.onJobDays, firstDays: state.scale.firstDays
    }));
  } catch (e) { /* ignore */ }
}
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const todayYmd = () => ymdOf(new Date());
function shiftDay(s, n) {
  const d = parseYmd(s);
  if (!d) return "";
  d.setDate(d.getDate() + n);
  return ymdOf(d);
}
/** v3.34.0：有效出勤规模的天数可在「规模设置」里调整（默认近 5 天，可选 1~10 天）。 */
function defaultScaleRange() {
  const t = todayYmd();
  const n = state.scale.days || SCALE_DAYS;
  return [shiftDay(t, -n), shiftDay(t, -1)];
}
/** v3.34.0：在职规模默认近 7 天（可选 3~15 天），不随有效出勤的起止日期手动微调。 */
function scaleOnJobRange() {
  const t = todayYmd();
  const n = state.scale.onJobDays || SCALE_ONJOB_DAYS;
  return [shiftDay(t, -n), shiftDay(t, -1)];
}
/** v3.35.0：今日首跑的对比窗口 T-N ~ T-1（默认近 14 天，可在「规模设置」里改 1~30 天）。 */
function scaleFirstRange() {
  const t = todayYmd();
  const n = state.scale.firstDays || SCALE_FIRST_DAYS;
  return [shiftDay(t, -n), shiftDay(t, -1)];
}
function scaleShortFirstRange() {
  const [s, e] = scaleFirstRange();
  const f = (x) => String(x || "").slice(5).replace(/-/g, "");
  return f(s) + "-" + f(e);
}
/** 表头「N天有效出勤规模」里的 N = 所选区间含首尾的天数。 */
function scaleRangeDays() {
  const a = parseYmd(state.scale.start), b = parseYmd(state.scale.end);
  if (!a || !b || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}
function scaleShortOnJobRange() {
  const [s, e] = scaleOnJobRange();
  const f = (x) => String(x || "").slice(5).replace(/-/g, "");
  return f(s) + "-" + f(e);
}
/** ISO 周次：表头「规模目标 W46」跟着统计区间的结束日走。 */
function isoWeek(s) {
  const d = parseYmd(s);
  if (!d) return 1;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const first = new Date(t.getFullYear(), 0, 4);
  first.setDate(first.getDate() + 3 - ((first.getDay() + 6) % 7));
  return 1 + Math.round((t - first) / (7 * 86400000));
}
/** 出勤明细接口单次最多 7 天，任意区间按 7 天切段。 */
function dateSegments(start, end) {
  const a = parseYmd(start), b = parseYmd(end), out = [];
  if (!a || !b || b < a) return out;
  let cur = new Date(a);
  while (cur <= b) {
    const s = ymdOf(cur);
    const e = new Date(cur);
    e.setDate(e.getDate() + Math.min(ATT_SEG_DAYS - 1, Math.round((b - cur) / 86400000)));
    out.push([s, ymdOf(e)]);
    cur = new Date(e);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
/** 「02小时30分钟」→ 150 分钟；也兼容纯数字。 */
function parseDuration(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return num(s);
  const h = /(\d+)\s*小时/.exec(s), m = /(\d+)\s*分钟/.exec(s);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}
function scaleWeek() {
  return "W" + isoWeek(state.scale.end || todayYmd());
}
function scaleBucket() {
  const w = scaleWeek();
  if (!state.scale.manual[w]) state.scale.manual[w] = { channel: "", rows: Object.create(null) };
  const b = state.scale.manual[w];
  if (!b.rows) b.rows = Object.create(null);
  return b;
}
function manualRow(key) {
  const b = scaleBucket();
  if (!b.rows[key]) {
    // v3.32.0：v3.31.0 手填按站点 id 存，改按商圈片聚合后把该片区旧站点的数值求和搬过来，
    // 不让用户上一版填的目标 / 招募目标 / 招聘缺口因为换了行维度而白填。
    const g = (state.scale.areas || []).find((x) => x.key === key);
    const ids = g ? g.teamIds : [];
    const sumOld = (f) => {
      let has = false, v = 0;
      for (const tid of ids) {
        const raw = b.rows[tid] && b.rows[tid][f];
        const s = String(raw == null ? "" : raw).trim();
        if (!s || !Number.isFinite(Number(s))) continue;
        has = true; v += Number(s);
      }
      return has ? String(v) : "";
    };
    b.rows[key] = { target: sumOld("target"), recruit: sumOld("recruit"), gap: sumOld("gap") };
  }
  return b.rows[key];
}
function manualNum(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** v3.37.0：在职规模 / 有效出勤规模支持右键手动增减 n 人。
 *  field = "onJob" | "eff"，增量按「W 周 + 商圈片」记在本机（和规模目标同一份手填数据）。
 *  返回 0 表示没调过；正数加人、负数减人。 */
function scaleAdj(key, field) {
  const m = manualRow(key);
  const v = manualNum(field === "eff" ? m.adjEff : m.adjOnJob);
  return v == null ? 0 : Math.round(v);
}
function setScaleAdj(key, field, v) {
  const m = manualRow(key);
  const n = Math.round(Number(v) || 0);
  if (field === "eff") m.adjEff = n ? n : "";
  else m.adjOnJob = n ? n : "";
  saveScaleManual();
}
/** 所有商圈片的手动增减合计（汇总行 = 跨片区去重人数 + 这个合计）。 */
function scaleAdjSum(field) {
  let v = 0;
  for (const g of (state.scale.areas || [])) v += scaleAdj(g.key, field);
  return v;
}
function scaleShortRange() {
  const f = (s) => String(s || "").slice(5).replace(/-/g, "");
  return f(state.scale.start) + "-" + f(state.scale.end);
}
/** 站点名 → 商圈片；没命中的按站点名自成一组（不丢数，也不误并到别的片区）。 */
function scaleAreaOfSite(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return "";
  if (SITE_TO_AREA[s]) return SITE_TO_AREA[s];
  const bare = s.replace(/-UB$/i, "").trim();
  for (const [k, v] of Object.entries(SITE_TO_AREA)) {
    if (k.replace(/-UB$/i, "").trim() === bare) return v;
  }
  return s;
}
/** 站点列表 → 商圈片分组（代理商名取该片区里出现最多的），顺序与考核看板一致。 */
function scaleAreaGroups(teams) {
  const map = new Map();
  for (const t of teams || []) {
    const area = scaleAreaOfSite(t.name) || String(t.name || t.id || "未识别");
    if (!map.has(area)) map.set(area, { key: area, name: area, teamIds: [], agencies: new Map() });
    const g = map.get(area);
    g.teamIds.push(t.id);
    const a = String(t.agency || "").trim();
    if (a) g.agencies.set(a, (g.agencies.get(a) || 0) + 1);
  }
  const list = [...map.values()].map((g) => {
    let best = "", n = 0;
    for (const [a, c] of g.agencies) if (c > n) { best = a; n = c; }
    return { key: g.key, name: g.name, agency: best || scaleGlobalAgency(), teamIds: g.teamIds };
  });
  list.sort((a, b) => {
    const ia = SCALE_AREA_ORDER.indexOf(a.name), ib = SCALE_AREA_ORDER.indexOf(b.name);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return String(a.name).localeCompare(String(b.name), "zh-CN");
  });
  return list;
}
/** 出勤明细行 → 商圈片 key：先用站点ID 找站点名，再用站点名兜底。 */
function scaleAreaKey(teamId, siteName, teams) {
  const id = normId(teamId);
  for (const t of teams || []) if (normId(t.id) === id) return scaleAreaOfSite(t.name);
  return scaleAreaOfSite(siteName) || (id || ANY_SITE);
}
function scaleSheetOpts(s) {
  const teams = s.teams || [];
  return {
    left: s.left || new Set(),
    diag: s.firstDiag,             // v3.35.0：首跑逐人判定明细（其它口径不使用）
    areaOf: (tid, siteName) => scaleAreaKey(tid, siteName, teams)
  };
}
/** 人资名单里明确已离职 / 非在职的骑手，两类规模都要排除。状态未知的不误排除。 */
function scaleLeftRiders(list) {
  const out = new Set();
  for (const s of staffMap(list || []).values()) {
    const rid = normId(s.knightId == null ? s.id : s.knightId);
    if (!rid) continue;
    const leave = String(s.leaveTime == null ? "" : s.leaveTime).trim();
    const raw = s.workStatus;
    const known = raw !== undefined && raw !== null && String(raw).trim() !== "";
    if (leave || (known && num(raw) !== 1)) out.add(rid);
  }
  return out;
}
/** 本机记住的商名（与实时出勤导出图标题同源）。 */
function scaleGlobalAgency() {
  try {
    const a = localStorage.getItem("wb_agency_name") || localStorage.getItem("wb_sch_agency");
    if (a && String(a).trim()) return String(a).trim();
  } catch (e) { /* ignore */ }
  const counts = new Map();
  for (const c of state.clueList || []) {
    const a = String(c.entryAgencyName || c.pushingAgencyName || "").trim();
    if (a) counts.set(a, (counts.get(a) || 0) + 1);
  }
  let best = "", n = 0;
  for (const [a, c] of counts) if (c > n) { best = a; n = c; }
  return best || "福建省双十网络科技有限公司";
}
/** 按站点从线索结果明细里取出现最多的代理商名，取不到用全局商名。 */
function scaleAgencyOf(teamId, nameToId, fallback) {
  const counts = new Map();
  for (const c of state.clueList || []) {
    const tid = normId(c.resultTeam || c.entryTeam || c.pushingTeam);
    const name = String(c.resultTeamName || c.entryTeamName || c.pushingTeamName || "").trim();
    if (!((tid && tid === teamId) || (name && nameToId[name] === teamId))) continue;
    const a = String(c.entryAgencyName || c.pushingAgencyName || c.organizationName || "").trim();
    if (a) counts.set(a, (counts.get(a) || 0) + 1);
  }
  let best = "", n = 0;
  for (const [a, c] of counts) if (c > n) { best = a; n = c; }
  return best || fallback;
}
function scaleTeamsFromBills() {
  const map = new Map();
  for (const b of state.bills || []) {
    const id = normId(b.teamId);
    if (!id || id === "0") continue;
    if (!map.has(id)) map.set(id, { id, name: String(b.teamName || ("站点 " + id)) });
  }
  return [...map.values()];
}
async function loadScaleTeams() {
  const j = await request(API_TEAMS, "POST", { metas: {}, params: { request: {} } });
  const d = (j && j.result && j.result.data) || [];
  const arr = Array.isArray(d) ? d : (d.teams || d.list || []);
  return (arr || []).filter((t) => t && t.id).map((t) => ({
    id: normId(t.id), name: String(t.team_name || t.name || t.id)
  }));
}
function scaleTeamsWithAgency(teams) {
  const nameToId = Object.create(null);
  for (const t of teams) nameToId[t.name] = t.id;
  const global = scaleGlobalAgency();
  return teams.map((t) => ({ id: t.id, name: t.name, agency: scaleAgencyOf(t.id, nameToId, global) }));
}
/** 人资名单：在职 / 今日入职 / 今日离职，按 departmentId 聚合（先按骑手去重）。 */
function scaleStaffStats(list, today) {
  const out = Object.create(null);
  const empty = () => ({ onJob: 0, entry: 0, leave: 0 });
  const m = staffMap(list);
  for (const s of m.values()) {
    const tid = normId(s.departmentId);
    if (!tid) continue;
    if (!out[tid]) out[tid] = empty();
    if (num(s.workStatus) === 1) out[tid].onJob++;
    if (String(s.entryTime || "").slice(0, 10) === today) out[tid].entry++;
    if (String(s.leaveTime || "").slice(0, 10) === today) out[tid].leave++;
  }
  return out;
}
/** v3.35.0：今日首跑 = 今日「完单量>0」的出勤骑手里，T-N ~ T-1 从未有完单的「新增」骑手。
 *  · 历史对比按骑手 id 全局去重：只要对比窗口内任何一天、任何站点有完单，就不算新增；
 *  · 计数按「今日所在商圈片 + 骑手」归类，汇总行调用方再跨片区去重；
 *  · 与两类规模一样排除人资名单里已离职 / 非在职状态的骑手；
 *  · 只看「完单量」，不看有效在线时长 / 是否达成 / 时段，也不依赖人资入职日期。
 *  v3.36.0：今日骑手优先由 opts.todayRows 提供（T0 实时考勤快照解析结果）；
 *  不传时仍可从 sheets 里找「考勤日期=今天」的行（快照失败时回退当天导出明细）。
 *  返回 Map(商圈片 -> Set(骑手id))，与 effective / onJob 的返回结构一致。 */
function scaleFirstRunFromSheets(sheets, nameToId, today, start, end, opts) {
  const o = opts || {};
  const left = o.left || new Set();
  const diag = o.diag;                 // v3.35.0：可选的判定明细，供「今日首跑」表头点开自查
  const todayRows = o.todayRows;       // v3.36.0：T0 实时快照的今日骑手（含姓名 / 商圈片 / 全天完单）
  const hist = new Set(), histDay = new Map();
  const todayByArea = new Map(), todayInfo = new Map();
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || rows.length < 2) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim();
      if (k && col[k] === undefined) col[k] = i;
    });
    const idx = (...names) => { for (const n of names) if (col[n] !== undefined) return col[n]; return undefined; };
    const iR = idx("骑手ID", "骑手id"), iS = idx("站点ID", "站点id", "站点Id");
    const iN = idx("站点名称"), iD = idx("考勤日期", "日期");
    const iO = idx("完单量", "时段完单量"), iName = idx("骑手姓名", "姓名");
    if (iR === undefined || iD === undefined || iO === undefined) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const day = String(r[iD] == null ? "" : r[iD]).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const isToday = day === today;
      if (!isToday && !(start && day >= start && end && day <= end)) continue;
      if (isToday && todayRows) continue;              // v3.36.0：今日改由实时快照提供，避免重复/串数
      const name = iName === undefined ? "" : String(r[iName] == null ? "" : r[iName]).trim();
      const siteName = iN === undefined ? "" : String(r[iN] == null ? "" : r[iN]).trim();
      let tid = iS !== undefined ? normId(r[iS]) : "";
      if (!tid && siteName) tid = nameToId[siteName] || "";
      if (!tid) tid = ANY_SITE;
      const key = (o.areaOf ? o.areaOf(tid, siteName) : "") || tid || ANY_SITE;
      if (left.has(rid)) {                                // 排除离职状态（今日也记一条，便于自查）
        if (isToday && diag) todayInfo.set(rid, { rid, name, site: siteName, area: key, orders: 0, left: true });
        continue;
      }
      const orders = num(r[iO]);
      if (!isToday) {
        if (orders > 0) {
          hist.add(rid);
          if (!histDay.has(rid) || day > histDay.get(rid)) histDay.set(rid, day);
        }
        continue;
      }
      const prev = todayInfo.get(rid);
      if (!prev || orders > prev.orders) {
        todayInfo.set(rid, { rid, name, site: siteName, area: key, orders, left: false });
      }
      if (orders > 0) {                                  // 首跑只认完单量 > 0
        if (!todayByArea.has(key)) todayByArea.set(key, new Set());
        todayByArea.get(key).add(rid);
      }
    }
  }
  if (todayRows) {                                    // v3.36.0：T0 实时考勤快照的今日骑手
    for (const r of todayRows) {
      const key = r.area || ANY_SITE;
      if (r.left) {
        if (diag) todayInfo.set(r.rid, { rid: r.rid, name: r.name, site: r.site, area: key, orders: 0, left: true });
        continue;
      }
      const prev = todayInfo.get(r.rid);
      if (!prev || r.orders > prev.orders) {
        todayInfo.set(r.rid, { rid: r.rid, name: r.name, site: r.site, area: key, orders: r.orders, left: false });
      }
      if (r.orders > 0) {
        if (!todayByArea.has(key)) todayByArea.set(key, new Set());
        todayByArea.get(key).add(r.rid);
      }
    }
  }
  const out = new Map();
  for (const [key, set] of todayByArea) {
    const fresh = new Set();
    for (const rid of set) if (!hist.has(rid)) fresh.add(rid);
    if (fresh.size) out.set(key, fresh);
  }
  if (diag) {
    diag.length = 0;
    for (const r of todayInfo.values()) {
      diag.push({
        rid: r.rid, name: r.name, site: r.site, area: r.area, orders: r.orders, today,
        status: r.left ? "left" : (r.orders > 0 ? (hist.has(r.rid) ? "old" : "new") : "no-order"),
        lastDay: histDay.get(r.rid) || ""
      });
    }
    diag.sort((a, b) => String(a.name || a.rid).localeCompare(String(b.name || b.rid), "zh-CN"));
  }
  return out;
}
/** 从出勤明细 xlsx 里算「区间内至少 1 天有效出勤」的骑手，按商圈片 + 骑手去重。
 *  opts.areaOf(teamId, siteName) 给分组 key（不传则退回站点 id，供纯函数单测用）；
 *  opts.left 是人资名单里明确离职 / 非在职的骑手，两类规模都要排除；
 *  opts.onlyFullDay 只看「全天」行，用于在职规模。 */
function scaleEffectiveFromSheets(sheets, mode, nameToId, start, end, opts) {
  const o = opts || {};
  const left = o.left || new Set();
  const onlyFullDay = !!o.onlyFullDay;
  const out = new Map();
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || rows.length < 2) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim();
      if (k && col[k] === undefined) col[k] = i;
    });
    const idx = (...names) => { for (const n of names) if (col[n] !== undefined) return col[n]; return undefined; };
    const iR = idx("骑手ID", "骑手id"), iS = idx("站点ID", "站点id", "站点Id");
    const iN = idx("站点名称"), iD = idx("考勤日期", "日期");
    const iP = idx("时段"), iOk = idx("是否达成");
    const iO = idx("完单量", "时段完单量"), iV = idx("有效在线时长");
    if (iR === undefined || iD === undefined) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid || left.has(rid)) continue;         // v3.32.0：排除离职状态
      const day = String(r[iD] == null ? "" : r[iD]).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (start && day < start) continue;
      if (end && day > end) continue;
      const siteName = iN === undefined ? "" : String(r[iN] == null ? "" : r[iN]).trim();
      if (onlyFullDay) {                          // 在职规模只认「全天」行
        if (iP === undefined) continue;
        if (String(r[iP] == null ? "" : r[iP]).trim() !== "全天") continue;
      }
      let ok = false;
      if (mode === "achieved") {
        ok = iOk !== undefined && String(r[iOk] || "").trim() === "达成"
          && (onlyFullDay || iP === undefined || String(r[iP] || "").trim() !== "全天");
      } else {
        const dur = iV !== undefined ? parseDuration(r[iV]) : 0;
        const ord = iO !== undefined ? num(r[iO]) : 0;
        ok = mode === "both" ? (dur > 0 && ord > 0) : (dur > 0 || ord > 0);
      }
      if (!ok) continue;
      let tid = iS !== undefined ? normId(r[iS]) : "";
      if (!tid && siteName) tid = nameToId[siteName] || "";
      if (!tid) tid = ANY_SITE;
      const key = (o.areaOf ? o.areaOf(tid, siteName) : "") || tid || ANY_SITE;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key).add(rid);
    }
  }
  return out;
}
/** 在职规模：T-7 ~ T-1 的「全天」行里有效出勤的骑手，按商圈片去重（同样排除离职）。 */
function scaleOnJobFromSheets(sheets, mode, nameToId, start, end, opts) {
  return scaleEffectiveFromSheets(sheets, mode, nameToId, start, end,
    Object.assign({}, opts, { onlyFullDay: true }));
}
/** 按选定区间拉出勤明细（同一接口，≤7 天自动分段）。 */
async function loadScaleSheets(start, end, teamIds) {
  const segs = dateSegments(start, end);
  if (!segs.length) throw new Error("汇总日期区间无效");
  const sheets = [];
  for (const [s, e] of segs) {
    const j = await request(API_ATT_DETAIL, "POST", {
      params: { request: { teamIds, startDate: s, endDate: e } }
    });
    const d = (j && j.result && j.result.data) || {};
    const url = d.url || d.downloadUrl;
    if (!url || !/^https?:/.test(String(url))) throw new Error(`汇总出勤 ${s}~${e} 未返回下载链接`);
    sheets.push(...(await XLSX_READER.read(await fetchBinary(String(url)))));
    if (segs.length > 1) await new Promise((r) => setTimeout(r, 180));
  }
  return sheets;
}
/** v3.36.0：T0 实时考勤快照（与「出勤达成」的 loadAttendanceSheets('live') 同一接口）。
 *  exportAttendance/1.0 实测忽略 startDate/endDate，永远返回「当前实时」全站 xlsx，
 *  所以只能用于今天；历史对比必须继续走 exportStatisticsDetail。 */
async function loadScaleLiveSheets(teamIds, today) {
  const j = await request(API_ATT_LIVE, "POST", {
    params: { request: { teamIds, startDate: today, endDate: today } }
  });
  const d = (j && j.result && j.result.data) || {};
  const url = d.url || d.downloadUrl;
  if (!url || !/^https?:/.test(String(url))) throw new Error("实时考勤快照未返回下载链接");
  return await XLSX_READER.read(await fetchBinary(String(url)));
}
/** 从实时考勤快照里取「今天出勤的骑手」：按骑手 id 去重，
 *  完单量取「全天完单量」与「时段完单量」的最大值（全天是当天累计，实时可用）。
 *  返回数组 [{rid,name,site,area,orders,left}]，orders=0 的也保留以便诊断显示原因。 */
function scaleTodayFromLiveSheets(liveSheets, nameToId, opts) {
  const o = opts || {};
  const left = o.left || new Set();
  const byRid = new Map();
  for (const sh of liveSheets || []) {
    const rows = sh && sh.rows;
    if (!rows || rows.length < 2) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim();
      if (k && col[k] === undefined) col[k] = i;
    });
    const idx = (...names) => { for (const n of names) if (col[n] !== undefined) return col[n]; return undefined; };
    const iR = idx("骑手id", "骑手ID", "骑手Id");
    const iName = idx("姓名", "骑手姓名", "骑手名称");
    const iN = idx("站点名称", "团队名称", "站点");
    const iS = idx("站点ID", "站点id", "站点Id", "站点id");
    const iFull = idx("全天完单量", "完单量");
    const iPer = idx("时段完单量");
    if (iR === undefined) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const site = iN === undefined ? "" : String(r[iN] == null ? "" : r[iN]).trim();
      const name = iName === undefined ? "" : String(r[iName] == null ? "" : r[iName]).trim();
      // 快照里的「站点id」常是 9.17534432E8 这类科学计数法，商圈片以站点名称为准
      const tid = (iS !== undefined ? normId(r[iS]) : "") || nameToId[site] || "";
      const orders = Math.max(iFull === undefined ? 0 : num(r[iFull]),
        iPer === undefined ? 0 : num(r[iPer]));
      const prev = byRid.get(rid);
      if (!prev || orders > prev.orders) {
        byRid.set(rid, {
          rid, name, site, orders, left: left.has(rid),
          area: (o.areaOf ? o.areaOf(tid, site) : "") || tid || ANY_SITE
        });
      }
    }
  }
  return [...byRid.values()];
}
/** 组装商圈片行与汇总行；两类人数在汇总行再跨片区按骑手全局去重，其余按片区相加。
 *  v3.37.0：净缺口 = 在职规模 − 规模目标；汇总行的净缺口只累加「缺口」（负数），
 *  某片区超编的人不能补别的片区的缺口，所以超编不参与汇总。 */
function computeScaleRows() {
  const s = state.scale;
  const ready = s.ready, onJobReady = s.onJobReady;
  const areas = (s.areas && s.areas.length) ? s.areas : scaleAreaGroups(s.teams);
  s.areas = areas;
  const rows = areas.map((g) => {
    const m = manualRow(g.key);
    const effBase = ready ? (s.effective.get(g.key) || new Set()).size : null;
    const onJobBase = onJobReady ? (s.onJob.get(g.key) || new Set()).size : null;
    const effAdj = scaleAdj(g.key, "eff"), onJobAdj = scaleAdj(g.key, "onJob");
    const eff = effBase == null ? null : Math.max(0, effBase + effAdj);
    const onJob = onJobBase == null ? null : Math.max(0, onJobBase + onJobAdj);
    const firstRun = s.firstReady ? (s.firstRun.get(g.key) || new Set()).size : null;
    const dyn = { entry: 0, leave: 0 };
    for (const tid of g.teamIds) {
      const st = s.byTeam[tid] || {};
      dyn.entry += num(st.entry);
      dyn.leave += num(st.leave);
    }
    const target = manualNum(m.target), recruit = manualNum(m.recruit), gap = manualNum(m.gap);
    return {
      teamId: g.key, name: g.name, agency: g.agency,
      onJob, onJobBase, onJobAdj, effective: eff, effBase, effAdj,
      entry: dyn.entry, leave: dyn.leave, firstRun,
      target, recruit, gap,
      rate: onJob != null && target && target > 0 ? onJob / target : null,
      net: onJob != null && target !== null ? onJob - target : null
    };
  });
  const sum = (f, nullable) => {
    let has = false, v = 0;
    for (const r of rows) { const x = r[f]; if (x == null) continue; has = true; v += x; }
    return has ? v : (nullable ? null : 0);
  };
  const union = (map, ok) => {
    if (!ok) return null;
    const all = new Set();
    for (const set of map.values()) for (const rid of set) all.add(rid);
    return all.size;
  };
  const effAllBase = union(s.effective, ready);
  const onJobAllBase = union(s.onJob, onJobReady);
  const effAdjAll = scaleAdjSum("eff"), onJobAdjAll = scaleAdjSum("onJob");
  const effAll = effAllBase == null ? null : Math.max(0, effAllBase + effAdjAll);
  const onJobAll = onJobAllBase == null ? null : Math.max(0, onJobAllBase + onJobAdjAll);
  const firstAll = union(s.firstRun, s.firstReady);
  const target = sum("target", true);
  // 汇总净缺口：只加负数（缺口），超编单独统计，不抵别的片区
  const nets = rows.map((r) => r.net).filter((v) => v != null);
  const netTotal = nets.length ? nets.reduce((a, v) => a + Math.min(v, 0), 0) : null;
  const surplus = nets.length ? nets.reduce((a, v) => a + Math.max(v, 0), 0) : null;
  const defAreas = rows.filter((r) => r.net != null && r.net < 0).length;
  const total = {
    teamId: "*", name: "", agency: scaleGlobalAgency(), isTotal: true,
    onJob: onJobAll, onJobBase: onJobAllBase, onJobAdj: onJobAdjAll,
    effective: effAll, effBase: effAllBase, effAdj: effAdjAll,
    entry: sum("entry"), leave: sum("leave"), firstRun: firstAll,
    target, recruit: sum("recruit", true), gap: sum("gap", true),
    rate: onJobAll != null && target && target > 0 ? onJobAll / target : null,
    net: netTotal, surplus, defAreas
  };
  return { rows, total };
}
function scaleCell(field, r) {
  const v = r[field];
  const attrs = ` data-row="${esc(r.teamId)}" data-cell="${field}"`;
  if (v == null) return { text: "—", cls: "num c-empty", attrs };
  if (field === "rate") {
    return {
      text: Math.round(v * 100) + "%", cls: "num", attrs,
      title: "规模达成率 = 在职规模 ÷ 规模目标"
    };
  }
  if (field === "net") {
    const cls = v < 0 ? " cell-neg" : (v > 0 ? " cell-pos" : "");
    const title = r.isTotal
      ? `汇总净缺口 = 各商圈片「在职规模 − 规模目标」里负数的合计 = ${int(v)}` +
        (r.surplus ? `；另有超编 +${int(r.surplus)} 人，不能抵其他商圈片的缺口` : "")
      : "净缺口 = 在职规模 − 规模目标";
    return { text: (v > 0 ? "+" : "") + int(v), cls: "num" + cls, attrs, title };
  }
  if (field === "onJob" || field === "effective") {
    const adj = field === "onJob" ? r.onJobAdj : r.effAdj;
    const base = field === "onJob" ? r.onJobBase : r.effBase;
    // v3.38.0：不再显示右上角蓝色增减上标，单元格直接显示调整后的最终人数
    const html = int(v);
    const tip = adj
      ? `自动 ${int(base)} ${adj > 0 ? "＋" : "−"} 手动 ${int(Math.abs(adj))} = ${int(v)}；右键可继续调整`
      : (r.isTotal ? "汇总 = 各商圈片合计（含手动增减）；请在明细行右键调整"
        : "右键可手动增加 / 减少 n 人");
    const cls = "num wf-adjable" + (r.isTotal ? " wf-adj-total" : "");
    // data-adj 用归一化值："effective" → "eff"，与 openScaleAdj 的判定一致（否则右键有效出勤规模会被误路由到在职规模）
    const adjKey = field === "effective" ? "eff" : field;
    return { text: int(v), html, cls, attrs: attrs + ` data-adj="${adjKey}"`, title: tip };
  }
  if (field === "entry" || field === "firstRun" || field === "leave") {
    const has = num(v) > 0;
    const cls = "num" + (has ? " wf-people" : "");
    const tip = has
      ? (field === "entry" ? "点击查看今日入职骑手明细"
        : field === "leave" ? "点击查看今日离职骑手明细" : "点击查看今日首跑骑手明细")
      : "";
    return { text: int(v), cls, attrs: attrPlus(attrs, has, field), title: tip };
  }
  return { text: int(v), cls: "num", attrs };
}
/** 有数值时给单元格挂「点开骑手明细」的标记，0 不挂（点了也没内容）。 */
function attrPlus(attrs, on, field) {
  return on ? attrs + ` data-people="${field}"` : attrs;
}
function scaleEditCell(r, field, numeric, isTotal) {
  const v = r[field];
  const txt = v == null ? "" : String(v);
  const tip = numeric ? "点击填写数字；留空表示未填" : "点击填写渠道名称";
  return `<td class="wf-edit${numeric ? " num" : ""}${txt ? "" : " empty"}"` +
    ` contenteditable="true" spellcheck="false" data-team="${esc(r.teamId)}"` +
    ` data-field="${field}" data-numeric="${numeric ? 1 : 0}"` +
    ` data-row="${esc(r.teamId)}" data-cell="${field}" title="${esc(tip)}">${esc(txt)}</td>`;
}
function scaleTextCell(field, text, cls) {
  return `<td class="${cls || ""}" title="${esc(text)}" data-cell="${field}">${esc(text || "—")}</td>`;
}
function scaleRowHtml(r, isTotal) {
  const s = state.scale;
  const numTotal = (field) => isTotal
    ? `<td class="num${r[field] == null ? " c-empty" : ""}" data-row="*" data-cell="${field}">${r[field] == null ? "—" : int(r[field])}</td>`
    : scaleEditCell(r, field, true, isTotal);
  const c = (field) => {
    const d = scaleCell(field, r);
    return `<td class="${d.cls}"${d.attrs}${d.title ? ` title="${esc(d.title)}"` : ""}>` +
      (d.html || esc(d.text)) + "</td>";
  };
  const bucket = state.scale.manual[scaleWeek()] || {};   // 只读，别为渲染创建空周次
  const first = isTotal
    ? scaleEditCell({ teamId: "*", channel: bucket.channel || "" }, "channel", false, true)
    : scaleTextCell("agency", r.agency, "name");
  const second = isTotal ? scaleTextCell("agency", r.agency, "name") : scaleTextCell("name", r.name, "name");
  return "<tr" + (isTotal ? ' class="wf-scale-total"' : "") + ">" + [
    first, second, numTotal("target"), c("onJob"), c("effective"), c("rate"), c("net"),
    c("entry"), c("firstRun"), c("leave"), numTotal("recruit"), numTotal("gap")
  ].join("") + "</tr>";
}
/** v3.35.0：今日首跑逐人判定明细的计数（口径说明与浮层共用）。 */
function scaleDiagCount(status) {
  return (state.scale.firstDiag || []).filter((x) => x.status === status).length;
}
const SCALE_FIRST_STATUS = {
  new: ["计入首跑", "sfd-ok"],
  old: ["窗口内有完单", "sfd-old"],
  "no-order": ["今日完单=0", "sfd-no"],
  left: ["已离职 / 非在职", "sfd-left"]
};
function firstDetailRows(q) {
  const list = (state.scale.firstDiag || []).slice();
  const kw = String(q || "").trim().toLowerCase();
  if (!kw) return list;
  return list.filter((x) => String(x.name || "").toLowerCase().includes(kw)
    || String(x.rid).includes(kw) || String(x.area || "").includes(kw));
}
function renderFirstDetail() {
  const box = $("sfd-body"), sum = $("sfd-sum");
  if (!box) return;
  const diag = state.scale.firstDiag || [];
  if (sum) {
    sum.textContent = diag.length
      ? `今日实时考勤快照 ${diag.length} 人 ｜ 计入首跑 ${scaleDiagCount("new")} ｜ ` +
        `窗口内已有完单 ${scaleDiagCount("old")} ｜ 今日完单=0 ${scaleDiagCount("no-order")} ｜ ` +
        `离职排除 ${scaleDiagCount("left")} ｜ 对比窗口 T-${state.scale.firstDays}~T-1`
      : "没有取到今日实时考勤快照（exportAttendance/1.0）：点「立即刷新」重试；" +
        "对比窗口（T-N~T-1）内有过完单的骑手也不算首跑。";
  }
  const q = $("sfd-search") ? $("sfd-search").value : "";
  const rows = firstDetailRows(q);
  box.innerHTML = rows.length ? rows.map((x) => {
    const st = SCALE_FIRST_STATUS[x.status] || ["未知", ""];
    const why = x.status === "old" ? `最近一次完单 ${esc(x.lastDay || "—")}`
      : x.status === "new" ? "对比窗口内从未有完单"
      : x.status === "no-order" ? "今日有出勤但完单量为 0"
      : "人资名单里有离职时间或状态非在职";
    return `<tr class="${st[1]}"><td class="sfd-name">${esc(x.name || "未命名")}<em>${esc(x.rid)}</em></td>` +
      `<td>${esc(x.area || "未识别站点")}</td><td>${int(x.orders)}</td>` +
      `<td>${st[0]}</td><td class="sfd-why">${why}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="c-empty">没有取到数据，或没有匹配的骑手</td></tr>`;
}
function openFirstDetail() {
  const p = $("scale-first-pop");
  if (!p) return;
  closeScaleSettings();
  const s = $("sfd-search");
  if (s) s.value = "";
  renderFirstDetail();
  p.hidden = false;
}
function closeFirstDetail() { const p = $("scale-first-pop"); if (p) p.hidden = true; }
function bindFirstDetail() {
  const tb = $("wf-scale-table"), p = $("scale-first-pop");
  if (!tb || !p) return;
  tb.addEventListener("click", (e) => {
    const th = e.target && e.target.closest ? e.target.closest("[data-first-detail]") : null;
    if (th) { e.stopPropagation(); openFirstDetail(); }
  });
  for (const id of ["sfd-close", "sfd-done"]) {
    const el = $(id);
    if (el) el.addEventListener("click", closeFirstDetail);
  }
  const search = $("sfd-search");
  if (search) search.addEventListener("input", renderFirstDetail);
  document.addEventListener("click", (e) => {
    if (p.hidden || p.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest("[data-first-detail]")) return;
    closeFirstDetail();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !p.hidden) closeFirstDetail(); });
}
// ------------------------------------- v3.37.0 三类人数的骑手明细 / 两类规模的手动增减
const SCALE_PEOPLE = {
  entry: { title: "今日入职", col: "入职时间", tip: "人资名单 entryTime 为今天" },
  leave: { title: "今日离职", col: "离职时间", tip: "人资名单 leaveTime 为今天" },
  firstRun: { title: "今日首跑", col: "今日完单", tip: "今日完单>0 且对比窗口内从无完单" }
};
let peopleState = { kind: "entry", key: "*" };
function scaleAreaNameOf(key) {
  if (!key || key === "*") return "全部商圈片";
  const g = (state.scale.areas || []).find((x) => x.key === key);
  return g ? g.name : key;
}
/** 站点 id → 商圈片（人资名单只有 departmentId，要用站点列表翻译成商圈片）。 */
function scaleAreaOfTeam(tid) {
  const id = normId(tid);
  const t = (state.scale.teams || []).find((x) => normId(x.id) === id);
  return t ? scaleAreaOfSite(t.name) : "";
}
/** 今日入职 / 离职：人资名单里 entryTime / leaveTime 落在今天的骑手。 */
function scaleStaffPeople(kind, key) {
  const today = todayYmd();
  const out = [];
  for (const s of staffMap(state.staffList || []).values()) {
    const raw = String((kind === "entry" ? s.entryTime : s.leaveTime) || "");
    if (raw.slice(0, 10) !== today) continue;
    const area = scaleAreaOfTeam(s.departmentId) || "未识别站点";
    if (key && key !== "*" && area !== key) continue;
    out.push({
      rid: normId(s.knightId == null ? s.id : s.knightId),
      name: String(s.staffName || s.knightName || ""),
      area, time: raw.slice(5, 16).replace("T", " "), orders: null
    });
  }
  return out;
}
/** 今日首跑：直接复用逐人判定明细里「计入首跑」的那批人。 */
function scaleFirstPeople(key) {
  return (state.scale.firstDiag || [])
    .filter((x) => x.status === "new" && (!key || key === "*" || x.area === key))
    .map((x) => ({ rid: x.rid, name: x.name, area: x.area, time: "", orders: x.orders }));
}
function scalePeopleRows() {
  const { kind, key } = peopleState;
  const list = kind === "firstRun" ? scaleFirstPeople(key) : scaleStaffPeople(kind, key);
  const q = String(($("sp-search") || {}).value || "").trim().toLowerCase();
  const hit = !q ? list : list.filter((x) =>
    String(x.name || "").toLowerCase().includes(q) || String(x.rid).includes(q)
    || String(x.area || "").toLowerCase().includes(q));
  return hit.sort((a, b) =>
    String(a.area || "").localeCompare(String(b.area || ""), "zh-CN")
    || String(a.name || a.rid).localeCompare(String(b.name || b.rid), "zh-CN"));
}
function renderScalePeople() {
  const p = $("scale-people");
  if (!p) return;
  const { kind, key } = peopleState;
  const meta = SCALE_PEOPLE[kind] || SCALE_PEOPLE.entry;
  const all = kind === "firstRun" ? scaleFirstPeople(key) : scaleStaffPeople(kind, key);
  const rows = scalePeopleRows();
  const title = $("sp-title");
  if (title) title.textContent = `${meta.title} · ${scaleAreaNameOf(key)} · ${all.length} 人`;
  const sum = $("sp-sum");
  if (sum) {
    sum.textContent = `${meta.title}共 ${all.length} 人 ｜ 口径：${meta.tip}` +
      (all.length ? `；按商圈片列出，点表格里某个片区的数字只看该片区，点汇总行看全部。` : "。");
  }
  const col = $("sp-col4");
  if (col) col.textContent = meta.col;
  const hint = $("sp-hint");
  if (hint) hint.textContent = kind === "firstRun"
    ? "历史按骑手全局对比（换站点不算首跑），已排除离职状态"
    : "来源：人资综合服务 → 成员管理（全部状态）";
  const box = $("sp-body");
  if (!box) return;
  box.innerHTML = rows.length ? rows.map((x) => `<tr>` +
    `<td class="sfd-name">${esc(x.name || "未命名")}<em>${esc(x.rid)}</em></td>` +
    `<td>${esc(x.rid)}</td><td>${esc(x.area || "未识别站点")}</td>` +
    `<td>${kind === "firstRun" ? int(x.orders) : esc(x.time || "—")}</td></tr>`).join("")
    : `<tr><td colspan="4" class="c-empty">没有匹配的骑手</td></tr>`;
}
function openScalePeople(kind, key) {
  const p = $("scale-people");
  if (!p) return;
  closeScaleSettings(); closeScaleAdj(); closeFirstDetail(); closePop();
  peopleState = { kind: SCALE_PEOPLE[kind] ? kind : "entry", key: key || "*" };
  const s = $("sp-search");
  if (s) s.value = "";
  renderScalePeople();
  p.hidden = false;
}
function closeScalePeople() { const p = $("scale-people"); if (p) p.hidden = true; }
function bindScalePeople() {
  const tb = $("wf-scale-table"), p = $("scale-people");
  if (!tb || !p) return;
  tb.addEventListener("click", (e) => {
    const td = e.target && e.target.closest ? e.target.closest("td[data-people]") : null;
    if (!td) return;
    e.stopPropagation();
    openScalePeople(td.dataset.people, td.dataset.row);
  });
  for (const id of ["sp-close", "sp-done"]) {
    const el = $(id);
    if (el) el.addEventListener("click", closeScalePeople);
  }
  const search = $("sp-search");
  if (search) search.addEventListener("input", renderScalePeople);
  document.addEventListener("click", (e) => {
    if (p.hidden || p.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest("td[data-people]")) return;
    closeScalePeople();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !p.hidden) closeScalePeople(); });
}
const adjState = { key: "", field: "onJob" };
function adjFieldLabel(field) { return field === "eff" ? "有效出勤规模" : "在职规模"; }
function renderAdjSum() {
  const box = $("adj-sum");
  const { key, field } = adjState;
  const base = field === "eff"
    ? (state.scale.effective.get(key) || new Set()).size
    : (state.scale.onJob.get(key) || new Set()).size;
  const adj = scaleAdj(key, field);
  const now = Math.max(0, base + adj);
  const t = $("adj-title");
  if (t) t.textContent = `${adjFieldLabel(field)} · ${scaleAreaNameOf(key)}`;
  if (!box) return;
  let html = `自动取数 <b>${int(base)}</b> 人` +
    (adj ? ` ${adj > 0 ? "＋" : "−"} 手动 <b>${int(Math.abs(adj))}</b> 人` : "（暂未手动调整）") +
    ` = 当前 <b>${int(now)}</b> 人`;
  // v3.38.0：在职规模增减会同步到同片区有效出勤规模，提示用户
  if (field === "onJob") html += `<div class="adj-synced">在职规模增减会同步到同片区「有效出勤规模」</div>`;
  box.innerHTML = html;
}
function openScaleAdj(td) {
  const p = $("scale-adj");
  if (!p) return;
  adjState.key = td.dataset.row;
  adjState.field = td.dataset.adj === "eff" ? "eff" : "onJob";
  closeScaleSettings(); closeScalePeople(); closeFirstDetail(); closePop();
  renderAdjSum();
  const n = $("adj-n");
  if (n) n.value = "1";
  p.hidden = false;
  const r = td.getBoundingClientRect();
  const w = p.offsetWidth || 306, h = p.offsetHeight || 200;
  const x = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  p.style.left = Math.round(x) + "px";
  p.style.top = Math.round(y) + "px";
}
function closeScaleAdj() { const p = $("scale-adj"); if (p) p.hidden = true; }
function applyScaleAdj(sign) {
  const nEl = $("adj-n");
  const n = Math.max(1, Math.round(Math.abs(Number(nEl && nEl.value) || 0)) || 1);
  const cur = scaleAdj(adjState.key, adjState.field);
  setScaleAdj(adjState.key, adjState.field, cur + sign * n);
  // v3.38.0：在职规模增减时，同商圈片的有效出勤规模同步增减相同人数
  if (adjState.field === "onJob") {
    const effCur = scaleAdj(adjState.key, "eff");
    setScaleAdj(adjState.key, "eff", effCur + sign * n);
  }
  renderScale();
  renderAdjSum();
}
function resetScaleAdj() {
  setScaleAdj(adjState.key, adjState.field, 0);
  if (adjState.field === "onJob") setScaleAdj(adjState.key, "eff", 0);
  renderScale();
  renderAdjSum();
}
function bindScaleAdj() {
  const tb = $("wf-scale-table"), p = $("scale-adj");
  if (!tb || !p) return;
  tb.addEventListener("contextmenu", (e) => {
    const td = e.target && e.target.closest ? e.target.closest("td[data-adj]") : null;
    if (!td) return;
    e.preventDefault();
    if (td.dataset.row === "*") {
      showNotice("汇总行 = 各商圈片合计（含手动增减），请在商圈片明细行上右键调整。", "blue");
      return;
    }
    openScaleAdj(td);
  });
  for (const id of ["adj-close"]) {
    const el = $(id);
    if (el) el.addEventListener("click", closeScaleAdj);
  }
  const plus = $("adj-plus"), minus = $("adj-minus"), reset = $("adj-reset");
  if (plus) plus.addEventListener("click", () => applyScaleAdj(1));
  if (minus) minus.addEventListener("click", () => applyScaleAdj(-1));
  if (reset) reset.addEventListener("click", resetScaleAdj);
  const n = $("adj-n");
  if (n) n.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyScaleAdj(1); } });
  document.addEventListener("click", (e) => {
    if (p.hidden || p.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest("td[data-adj]")) return;
    closeScaleAdj();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !p.hidden) closeScaleAdj(); });
}
function renderScale() {
  const box = $("wf-scale-table");
  if (!box) return;
  const s = state.scale;
  if (!s.teams.length) s.teams = scaleTeamsWithAgency(scaleTeamsFromBills());
  const week = scaleWeek();
  s.week = week;
  const heads = [
    ["渠道名称", "grp-d"], ["商圈片信息", "grp-d"], [`规模目标 ${week}`, "grp-a"],
    ["在职规模", "grp-a"], [`${scaleRangeDays()}天有效出勤规模 ${scaleShortRange()}`, "grp-a"],
    ["规模达成率", "grp-a"], ["净缺口", "grp-c"],
    ["今日入职", "grp-b"], ["今日首跑", "grp-b"], ["今日离职", "grp-b"],
    ["招募目标", "grp-b"], ["渠道招聘缺口", "grp-c"]
  ];
  const subs = ["代理商名称", "商圈片名称", ...heads.slice(2).map((h) => h[0])];
  const cols = [13, 15, 7, 6, 12, 7, 7, 6, 6, 6, 7, 8];
  const { rows, total } = computeScaleRows();
  const colgroup = "<colgroup>" + cols.map((w) => `<col style="width:${w}%">`).join("") + "</colgroup>";
  // v3.35.0：「今日首跑」主表头 / 副表头可点，打开逐人判定明细自查
  const clickAttr = ' data-first-detail="1" title="点击查看今日首跑逐人判定明细"';
  const head = "<thead><tr>" + heads.map(([t, g], i) =>
    `<th class="${g}"${i === 8 ? clickAttr : ""}>${esc(t)}</th>`).join("") + "</tr></thead>";
  const subhead = '<tbody><tr class="wf-scale-subhead">' + subs.map((t, i) =>
    `<th class="${heads[i][1]}"${i === 8 ? clickAttr : ""}>${esc(t)}</th>`).join("") + "</tr></tbody>";
  // v3.33.0：按参考图「上半渠道汇总 1 行 / 下半代理商名称 · 商圈片名称明细 N 行」，
  // 渠道汇总行紧跟主表头，明细子表头移到汇总行下面（原来第 2 / 3 行对调）。
  const totalBody = "<tbody>" + scaleRowHtml(total, true) + "</tbody>";
  const detailBody = "<tbody>" + (rows.length ? rows.map((r) => scaleRowHtml(r, false)).join("")
    : `<tr><td colspan="12" class="c-empty">没有取到商圈片，点「立即刷新」重试</td></tr>`) + "</tbody>";
  box.innerHTML = colgroup + head + totalBody + subhead + detailBody;

  const title = $("wf-scale-title");
  if (title) {
    title.innerHTML = `规模汇总 · ${esc(week)} · 统计区间 ${esc(s.start)} ~ ${esc(s.end)}` +
      ` · 按商圈片聚合（${int(rows.length)} 个商圈片 / ${int((s.teams || []).length)} 站点）` +
      `<span class="wf-scale-sub">口径：${esc(SCALE_MODE_LABEL[s.mode] || SCALE_MODE_LABEL.any)}` +
      ` · 在职规模 T-${s.onJobDays}~T-1（${esc(scaleShortOnJobRange())}）全天有效出勤` +
      ` · 今日首跑对比 T-${s.firstDays}~T-1（${esc(scaleShortFirstRange())}）新增` +
      ` · 今日骑手 ${s.liveToday ? "T0 实时考勤快照" : "当天明细"}` +
      ` · 两类规模均已排除离职` +
      (s.attAt ? ` · 出勤数据 ${esc(s.attAt)}` : "") + "</span>";
  }
  const note = $("wf-scale-note");
  if (note) {
    note.innerHTML = `<b>口径</b>：<b>${esc(heads[4][0])}</b> = 所选区间内至少 1 天有效的骑手，` +
      `按「商圈片＋骑手」去重、汇总行再跨片区去重，<b>排除人资名单里已离职 / 非在职状态</b>；` +
      `<b>在职规模</b> = T-${s.onJobDays}~T-1（${esc(scaleShortOnJobRange())}）考勤明细里「全天」行有效的骑手去重，同样排除离职；` +
      `明细行按商圈片聚合（站点名映射到商圈片，未识别的按站点自成一组）。` +
      `今日入职 / 离职 = 人资名单 <code>entryTime / leaveTime</code> 为今天；` +
      `<b>今日首跑</b> = 今日「完单量&gt;0」的出勤骑手里，T-${s.firstDays}~T-1（${esc(scaleShortFirstRange())}）` +
      `从未有过完单的「新增」骑手，历史按骑手全局对比（换站点 / 商圈片不算新增）、按今日所在商圈片计数` +
      `、汇总行再跨片区去重，同样排除离职；` +
      `<b>规模达成率 = 在职规模 ÷ 规模目标</b>，<b>净缺口 = 在职规模 − 规模目标</b>；` +
      `汇总行的净缺口<b>只累加缺口（负数）</b>，某片区超编的人不抵别的片区缺口` +
      (total.surplus ? `（当前超编场景合计 +${int(total.surplus)} 人，未参与汇总）` : "") + `。` +
      `<b>在职规模 / ${esc(heads[4][0])}</b> 单元格<u>右键</u>可手动增加 / 减少 n 人（按 ${esc(week)}、按商圈片记在本机，汇总行自动合计）；` +
      `点 <b>今日入职 / 今日首跑 / 今日离职</b> 的数字可看骑手明细。` +
      `浅黄格（渠道名称 / 规模目标 / 招募目标 / 渠道招聘缺口）点击即可填写，按 ${esc(week)} 记在本机；` +
      `汇总行自动合计。数据源：站点列表 / 人资名单 / 线索结果明细 / 历史出勤明细 ` +
      `<code>exportStatisticsDetail</code>（T-N~T-1）＋ 今日实时考勤快照 ` +
      `<code>exportAttendance/1.0</code>（T0，与「出勤达成」同源，含当天累计完单量，快照失败才回退当天明细）。` +
      `<br><b>今日首跑自查</b>：点表头「今日首跑」看逐人判定；` +
      (s.firstDiag && s.firstDiag.length
        ? `今日实时快照 ${int(s.firstDiag.length)} 人 → 计入 ${int(scaleDiagCount("new"))} 人 / ` +
          `对比窗口内已有完单 ${int(scaleDiagCount("old"))} 人 / 今日完单=0 ${int(scaleDiagCount("no-order"))} 人 / ` +
          `离职排除 ${int(scaleDiagCount("left"))} 人。`
        : `今日实时考勤快照暂未取到，点「立即刷新」重试；首跑会显示「—」或 0。`) +
      (s.loading ? ` <span class="wf-scale-loading">正在读取汇总数据…</span>` : "") +
      (s.err ? ` <span class="wf-scale-loading">汇总取数提示：${esc(s.err)}（其余数据不受影响）</span>` : "");
  }
}
/** 手填后只改派生格，不整表重绘，编辑焦点不会被抢走。 */
function updateScaleDerived() {
  const { rows, total } = computeScaleRows();
  const byId = Object.create(null);
  for (const r of rows) byId[r.teamId] = r;
  const tds = document.querySelectorAll("#wf-scale-table td.wf-scale-total-cell, #wf-scale-table td[data-cell]");
  for (const td of tds) {
    if (td.classList.contains("wf-edit")) continue;
    const r = td.dataset.row === "*" ? total : byId[td.dataset.row];
    if (!r || !td.dataset.cell) continue;
    const d = scaleCell(td.dataset.cell, r);
    if (d.html) td.innerHTML = d.html; else td.textContent = d.text;
    td.className = d.cls;
    if (d.title) td.title = d.title; else td.removeAttribute("title");
  }
}
/** 汇总数据：站点→商圈片 / 人资统计 / 历史窗口 + 当天两段考勤明细；失败只提示，不挡主表。 */
async function loadScaleData(gen) {
  const s = state.scale;
  if (s.loading) return;
  s.loading = true; s.err = "";
  s.ready = false; s.onJobReady = false; s.firstReady = false;
  s.sheets = null; s.firstDiag.length = 0;
  renderScale();
  try {
    if (window.__WB_TEST__ && !window.__WF_SCALE_NET_TEST__) return; // 测试态由 __SET_WORKFORCE__ 注入
    let teams = [];
    try { teams = await loadScaleTeams(); }
    catch (e) { s.err = "站点列表：" + String((e && e.message) || e); }
    const base = teams.length ? teams : scaleTeamsFromBills();
    const nameToId = Object.create(null);
    for (const t of base) nameToId[t.name] = t.id;
    s.teams = scaleTeamsWithAgency(base);
    s.areas = scaleAreaGroups(s.teams);
    s.left = scaleLeftRiders(state.staffList);
    s.byTeam = scaleStaffStats(state.staffList, todayYmd());
    const opts = scaleSheetOpts(s);
    const [os, oe] = scaleOnJobRange();
    const [fs, fe] = scaleFirstRange();
    const today = todayYmd();
    const ids = base.map((t) => t.id);
    // 三类口径的历史区间都止于 T-1：取最早的起点一次导出共用，段间已有错峰。
    // v3.36.0：今日骑手改走「出勤达成」T0 同款实时考勤快照 exportAttendance（当天完单实时可得）；
    // 快照不可用时才回退当天的 exportStatisticsDetail 明细（可能尚未结算）。
    const last = shiftDay(today, -1);
    const histStart = [s.start, os, fs].filter(Boolean).sort()[0] || fs;
    const histEnd = [s.end, oe, fe, last].filter(Boolean).sort().pop() || last;
    let hist = null, liveRows = null, todaySheets = null;
    try {
      // 与整月明细的导出请求错峰，避免同一个导出接口被并发限流
      await new Promise((r) => setTimeout(r, 120));
      hist = await loadScaleSheets(histStart, histEnd, ids);
      s.onJob = scaleOnJobFromSheets(hist, s.mode, nameToId, os, oe, opts);
      s.onJobReady = true;
      s.effective = scaleEffectiveFromSheets(hist, s.mode, nameToId, s.start, s.end, opts);
      s.ready = true;
      s.attAt = new Date().toTimeString().slice(0, 8);
    } catch (e) {
      s.err = (s.err ? s.err + "；" : "") + "规模出勤：" + String((e && e.message) || e);
    }
    try {
      await new Promise((r) => setTimeout(r, 180));
      liveRows = scaleTodayFromLiveSheets(await loadScaleLiveSheets(ids, today), nameToId, opts);
      s.liveToday = true;
    } catch (e) {
      s.liveToday = false;
      s.err = (s.err ? s.err + "；" : "") + "实时考勤快照：" + String((e && e.message) || e);
      try {
        await new Promise((r) => setTimeout(r, 180));
        todaySheets = await loadScaleSheets(today, today, ids);
        s.err += "（已回退当天导出明细，可能尚未结算）";
      } catch (e2) {
        s.err = (s.err ? s.err + "；" : "") + "今日首跑回退：" + String((e2 && e2.message) || e2);
      }
    }
    if (hist && (liveRows || todaySheets)) {
      s.sheets = hist.concat(todaySheets || []);
      s.todayRows = liveRows;
      const firstOpts = liveRows ? Object.assign({}, opts, { todayRows: liveRows }) : opts;
      s.firstRun = scaleFirstRunFromSheets(s.sheets, nameToId, today, fs, fe, firstOpts);
      s.firstReady = true;
    }
  } finally {
    s.loading = false;
    if (gen && gen !== state.gen) return;
    renderScale();
  }
}
/** v3.36.0：明细补完后用已缓存的汇总出勤明细 + 今日实时快照重算「今日首跑」，不发请求。 */
function refreshScaleFirstRun() {
  const s = state.scale;
  if (!s.sheets) return;
  const nameToId = Object.create(null);
  for (const t of (s.teams || [])) nameToId[t.name] = t.id;
  const [fs, fe] = scaleFirstRange();
  const opts = Object.assign({}, scaleSheetOpts(s), s.todayRows ? { todayRows: s.todayRows } : {});
  s.firstRun = scaleFirstRunFromSheets(s.sheets, nameToId, todayYmd(), fs, fe, opts);
  s.firstReady = true;
  renderScale();
}
// ------------------------------------- v3.34.0 规模统计口径设置 / v3.35.0 首跑对比天数
/* 「规模设置」按钮打开一个小浮层：有效出勤规模近 N 天（1~10，默认 5）、
   在职规模近 M 天（3~15，默认 7）、今日首跑对比近 K 天（1~30，默认 14）。
   浮层挂在 body 上、不进 #sheet，所以「复制图片」导出图里只有表头 / 口径说明的
   变化，不会出现按钮。三个天数统一记在本机 wb_wf_scale_days_v1。 */
function scaleSettingsEl() { return $("scale-settings"); }
function scaleDayOptions(id, lo, hi, cur) {
  const el = $(id);
  if (!el) return;
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(`<option value="${n}">近 ${n} 天</option>`);
  el.innerHTML = out.join("");
  el.value = String(clampScaleDays(cur, lo, hi, lo));
}
function placeScaleSettings(anchor) {
  const p = scaleSettingsEl();
  if (!p) return;
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth || 336, h = p.offsetHeight || 280;
  let x = Math.min(r.left, window.innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  p.style.left = Math.max(8, Math.round(x)) + "px";
  p.style.top = Math.round(y) + "px";
}
function openScaleSettings(anchor) {
  const p = scaleSettingsEl();
  if (!p) return;
  closePop();
  scaleDayOptions("ss-days", SCALE_DAYS_MIN, SCALE_DAYS_MAX, state.scale.days);
  scaleDayOptions("ss-onjob-days", SCALE_ONJOB_DAYS_MIN, SCALE_ONJOB_DAYS_MAX, state.scale.onJobDays);
  scaleDayOptions("ss-first-days", SCALE_FIRST_DAYS_MIN, SCALE_FIRST_DAYS_MAX, state.scale.firstDays);
  const note = $("ss-note");
  if (note) {
    const [os, oe] = scaleOnJobRange();
    const [fs, fe] = scaleFirstRange();
    note.textContent = `当前有效出勤区间：${state.scale.start} ~ ${state.scale.end}（${scaleRangeDays()} 天）；`
      + `在职规模：${os} ~ ${oe}（近 ${state.scale.onJobDays} 天）；`
      + `今日首跑对比：${fs} ~ ${fe}（近 ${state.scale.firstDays} 天）。`;
  }
  placeScaleSettings(anchor);
}
function closeScaleSettings() {
  const p = scaleSettingsEl();
  if (p) p.hidden = true;
}
function applyScaleSettings() {
  const d = $("ss-days"), j = $("ss-onjob-days"), f = $("ss-first-days");
  state.scale.days = clampScaleDays(d && d.value, SCALE_DAYS_MIN, SCALE_DAYS_MAX, SCALE_DAYS);
  state.scale.onJobDays = clampScaleDays(j && j.value,
    SCALE_ONJOB_DAYS_MIN, SCALE_ONJOB_DAYS_MAX, SCALE_ONJOB_DAYS);
  state.scale.firstDays = clampScaleDays(f && f.value,
    SCALE_FIRST_DAYS_MIN, SCALE_FIRST_DAYS_MAX, SCALE_FIRST_DAYS);
  // 应用天数 = 快捷把区间重设为 T-N ~ T-1；手动改日期框仍可继续微调
  const [ds, de] = defaultScaleRange();
  state.scale.start = ds;
  state.scale.end = de;
  const a = $("scale-start"), b = $("scale-end");
  if (a) a.value = ds;
  if (b) b.value = de;
  saveScaleDays();
  closeScaleSettings();
  state.scale.ready = false;
  state.scale.onJobReady = false;
  state.scale.firstReady = false;
  renderScale();
  loadScaleData(state.gen);
}
function bindScaleSettings() {
  const btn = $("btn-scale-settings"), p = scaleSettingsEl();
  if (!btn || !p) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!p.hidden) { closeScaleSettings(); return; }
    openScaleSettings(btn);
  });
  for (const id of ["ss-close", "ss-cancel"]) {
    const el = $(id);
    if (el) el.addEventListener("click", closeScaleSettings);
  }
  const apply = $("ss-apply");
  if (apply) apply.addEventListener("click", applyScaleSettings);
  document.addEventListener("click", (e) => {
    if (p.hidden || p.contains(e.target) || e.target === btn) return;
    closeScaleSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !p.hidden) closeScaleSettings();
  });
}
function bindScaleEvents() {
  const start = $("scale-start"), end = $("scale-end"), mode = $("scale-mode");
  const [ds, de] = defaultScaleRange();
  state.scale.start = start.value || ds;
  state.scale.end = end.value || de;
  start.value = state.scale.start;
  end.value = state.scale.end;
  mode.value = state.scale.mode;
  const reload = () => {
    const a = parseYmd(start.value), b = parseYmd(end.value);
    if (!a || !b || b < a) { showNotice("汇总日期区间不合法：结束日不能早于起始日。", "blue"); return; }
    if ((b - a) / 86400000 > 60) { showNotice("汇总区间最长 60 天，请缩短日期。", "blue"); return; }
    state.scale.start = start.value;
    state.scale.end = end.value;
    // 手动改日期后让「规模设置」里的天数跟实际区间同步（超出 1~10 天保留上次值）
    const n = Math.round((b - a) / 86400000) + 1;
    state.scale.days = clampScaleDays(n, SCALE_DAYS_MIN, SCALE_DAYS_MAX, state.scale.days);
    saveScaleDays();
    state.scale.ready = false;
    state.scale.onJobReady = false;
    renderScale();
    loadScaleData(state.gen);
  };
  start.addEventListener("change", reload);
  end.addEventListener("change", reload);
  mode.addEventListener("change", () => {
    state.scale.mode = mode.value;
    state.scale.ready = false;
    state.scale.onJobReady = false;
    renderScale();
    loadScaleData(state.gen);
  });
  const table = $("wf-scale-table");
  table.addEventListener("focusin", (e) => {
    const td = e.target.closest && e.target.closest("td.wf-edit");
    if (td) td.dataset.orig = td.textContent;
  });
  table.addEventListener("input", (e) => {
    const td = e.target.closest && e.target.closest("td.wf-edit");
    if (!td) return;
    td.classList.toggle("empty", !td.textContent.trim());
  });
  table.addEventListener("focusout", (e) => {
    const td = e.target.closest && e.target.closest("td.wf-edit");
    if (!td) return;
    const v = td.textContent.replace(/\u00a0/g, " ").trim();
    const field = td.dataset.field;
    if (field === "channel") scaleBucket().channel = v;
    else {
      const m = manualRow(td.dataset.team);
      m[field] = td.dataset.numeric === "1"
        ? (v !== "" && Number.isFinite(Number(v)) ? v : "") : v;
    }
    td.textContent = v;
    td.classList.toggle("empty", !v);
    saveScaleManual();
    updateScaleDerived();
  });
  table.addEventListener("keydown", (e) => {
    const td = e.target.closest && e.target.closest("td.wf-edit");
    if (!td) return;
    if (e.key === "Enter") { e.preventDefault(); td.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); td.textContent = td.dataset.orig || ""; td.blur(); }
  });
}

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
    "考核运单明细（4 类异常订单筛选 + 违规处罚差评/投诉运单号批量补全，不拉全量运单）",
    state.loadedAt ? `取数完成 ${state.loadedAt}` : ""
  ].filter(Boolean);
  $("foot-meta").textContent = parts.join("　·　") + "　·　跟随当前浏览器登录态，换账号自动换商";
  $("doc-foot-small").textContent =
    "账单ID 仅在「导出 CSV」时带出；「是否三方人资」按线索结果明细是否命中带猎头（人资）公司的记录判定；" +
    "人资名单取全部状态（含离职）；绑定扣款 = 住宿费用 + 车辆租金；" +
    "本月班次异常数 = 出勤明细里除「全天」外「是否达成 = 未达成」的班次数；" +
    "首跑时间只给本月入职骑手，取入职日起首个「全天」完单 > 0 的日期；" +
    "物流责 / 投诉 / 差评 / 提前点 = 考核运单明细里 4 类异常订单计数；" +
    "投诉 / 差评另经违规处罚列表（违规状态=成立、违规分类=差评+投诉、接口按 2 天分段）的运单号" +
    "去重后逗号拼接批量回查考核运单明细补全，两路取并集，普通差评 / 投诉不再漏计；" +
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
  renderScale();
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
  if (s.ok) { state.staff = staffMap(s.v); state.staffList = s.v; }
  if (c.ok) { state.clues = clueMap(c.v); state.clueList = c.v; }
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
  loadScaleData(gen);                // v3.31.0：规模汇总（站点 / 人资 / 区间考勤），同样不阻塞
}

// 主表先出图，再异步补「本月出勤明细 + 考核运单明细」两组数据。
// 任一组失败只让对应列显示「—」；切月用 gen 丢弃过期结果。
async function loadDetailData(gen, teamIds) {
  if (state.detailLoading) return;
  state.detailLoading = true;
  state.pendingAtt = true; state.pendingKpi = true;
  state.attReady = false; state.kpiReady = false;
  state.errors.att = ""; state.errors.kpi = "";
  state.rawOrders = [];                 // v3.46.0：按月重置共享坏单明细
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
  refreshScaleFirstRun();            // v3.31.0：本月首跑明细补完后刷新汇总「今日首跑」
  // v3.46.0：整月原始明细写入同源缓存，质量运营「炸班次 / 坏单」直接复用，零重复请求
  try {
    const complete = a.status === "fulfilled" && k.status === "fulfilled";
    const teams = (state.scale.teams && state.scale.teams.length) ? state.scale.teams : scaleTeamsFromBills();
    const raw = {
      v: 2, month: state.month, ts: Date.now(), complete,
      teams: (teams || []).map((t) => ({ id: String(t.id), name: String(t.name || "") })),
      recs: (a.status === "fulfilled" && Array.isArray(a.value.rows)) ? a.value.rows : [],
      orders: state.rawOrders || []
    };
    // 半份数据不写缓存，避免质量运营复用后「坏单矩阵出不来」
    if (complete && (raw.recs.length || raw.orders.length))
      localStorage.setItem(SHARE_LS + state.month, JSON.stringify(raw));
  } catch (e) { /* 配额不足不影响主表 */ }
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
  if (Array.isArray(obj.staff)) state.staffList = obj.staff;
  if (Array.isArray(obj.clues)) state.clueList = obj.clues;
  // v3.32.0：规模汇总样本（站点→商圈片 / 区间 / 出勤明细 sheets），全部离线，不发请求
  if (obj.scale) {
    const sc = state.scale, o = obj.scale;
    sc.firstDiag = [];
    if (o.start) { sc.start = o.start; $("scale-start").value = o.start; }
    if (o.end) { sc.end = o.end; $("scale-end").value = o.end; }
    if (o.mode) { sc.mode = o.mode; $("scale-mode").value = o.mode; }
    if (o.days !== undefined) sc.days = clampScaleDays(o.days, SCALE_DAYS_MIN, SCALE_DAYS_MAX, SCALE_DAYS);
    if (o.onJobDays !== undefined) sc.onJobDays = clampScaleDays(o.onJobDays,
      SCALE_ONJOB_DAYS_MIN, SCALE_ONJOB_DAYS_MAX, SCALE_ONJOB_DAYS);
    if (o.firstDays !== undefined) sc.firstDays = clampScaleDays(o.firstDays,
      SCALE_FIRST_DAYS_MIN, SCALE_FIRST_DAYS_MAX, SCALE_FIRST_DAYS);
    if (Array.isArray(o.teams)) sc.teams = scaleTeamsWithAgency(o.teams);
    sc.areas = scaleAreaGroups(sc.teams);
    sc.left = o.left ? new Set(o.left) : scaleLeftRiders(state.staffList);
    if (state.staffList.length) sc.byTeam = scaleStaffStats(state.staffList, todayYmd());
    if (o.byTeam) for (const [tid, v] of Object.entries(o.byTeam)) sc.byTeam[tid] = v;
    const opts = scaleSheetOpts(sc);
    const [os, oe] = Array.isArray(o.onJobRange) ? o.onJobRange : scaleOnJobRange();
    const [fs, fe] = Array.isArray(o.firstRange) ? o.firstRange : scaleFirstRange();
    const nameToId = Object.create(null);
    for (const t of sc.teams) nameToId[t.name] = t.id;
    // v3.36.0：真机回归可直接注入 T0 实时考勤快照样本（与线上 exportAttendance 的列一致）
    sc.todayRows = Array.isArray(o.liveSheets)
      ? scaleTodayFromLiveSheets(o.liveSheets, nameToId, opts)
      : (Array.isArray(o.todayRows) ? o.todayRows : null);
    sc.liveToday = !!sc.todayRows;
    if (Array.isArray(o.sheets)) {
      sc.effective = scaleEffectiveFromSheets(o.sheets, sc.mode, nameToId, sc.start, sc.end, opts);
      sc.onJob = scaleOnJobFromSheets(o.sheets, sc.mode, nameToId, os, oe, opts);
      sc.onJobReady = true;
      const firstOpts = sc.todayRows ? Object.assign({}, opts, { todayRows: sc.todayRows }) : opts;
      sc.firstRun = scaleFirstRunFromSheets(o.sheets, nameToId, o.today || todayYmd(), fs, fe, firstOpts);
      sc.firstReady = true;
      sc.sheets = o.sheets;
    }
    if (o.effective) {
      sc.effective = new Map(Object.entries(o.effective).map(([k, v]) => [k, new Set(v || [])]));
    }
    if (o.onJob) {
      sc.onJob = new Map(Object.entries(o.onJob).map(([k, v]) => [k, new Set(v || [])]));
    }
    if (o.firstRun) {
      sc.firstRun = new Map(Object.entries(o.firstRun).map(([k, v]) => [k, new Set(v || [])]));
    }
    if (o.onJobReady !== undefined) sc.onJobReady = !!o.onJobReady;
    if (o.firstReady !== undefined) sc.firstReady = !!o.firstReady;
    sc.ready = o.ready !== false;
    sc.err = String(o.err || "");
    sc.attAt = String(o.attAt || "");
    sc.loading = false;
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
  applyData, loadKpiFlags, loadAttendance, KPI_FILTERS, violationFlags, applyViolationFlags,
  // v3.41.0 差评 / 投诉补全（违规处罚 → 批量回查考核运单明细）
  parseKpiRows, loadViolationTrackingIds, API_VIOLATION, VIOL_SEG_DAYS, VIOL_BATCH,
  normId, pairKey, pairGet, hookPairMap,
  // v3.18.0 视图能力（真机回归用）
  cellText, sortVal, compareCell, filteredRows, toggleSort, clearView, activeFilterCount,
  colValues, openFilterPop, openFreezePop, applyFilterPop, closePop, setFrozen, applyFreeze,
  loadFrozen, DEFAULT_FROZEN, MAX_FROZEN, NUM_CSV,
  // v3.31.0 规模汇总 / v3.32.0 商圈片与口径修订 / v3.35.0 今日首跑新增口径
  ymdOf, parseYmd, shiftDay, todayYmd, defaultScaleRange, scaleOnJobRange, scaleFirstRange,
  scaleRangeDays, scaleShortOnJobRange, scaleShortFirstRange, isoWeek, dateSegments, parseDuration,
  scaleWeek, scaleBucket, manualRow, manualNum, scaleShortRange, scaleGlobalAgency, scaleAgencyOf,
  loadScaleManual, saveScaleManual,
  scaleAreaOfSite, scaleAreaGroups, scaleAreaKey, scaleSheetOpts, scaleLeftRiders,
  scaleTeamsFromBills, loadScaleTeams, scaleTeamsWithAgency, scaleStaffStats,
  scaleFirstRunFromSheets, scaleEffectiveFromSheets, scaleOnJobFromSheets,
  loadScaleSheets, loadScaleLiveSheets, scaleTodayFromLiveSheets, API_ATT_LIVE,
  computeScaleRows, scaleCell, renderScale,
  updateScaleDerived, loadScaleData, refreshScaleFirstRun, bindScaleEvents,
  clampScaleDays, loadScaleDays, saveScaleDays,
  openScaleSettings, closeScaleSettings, applyScaleSettings, bindScaleSettings,
  scaleDiagCount, firstDetailRows, renderFirstDetail, openFirstDetail, closeFirstDetail, bindFirstDetail,
  SCALE_FIRST_STATUS,
  // v3.37.0：右键手动增减 + 三类人数骑手明细
  scaleAdj, setScaleAdj, scaleAdjSum, adjFieldLabel, renderAdjSum, openScaleAdj, closeScaleAdj,
  applyScaleAdj, resetScaleAdj, bindScaleAdj,
  scaleAreaNameOf, scaleAreaOfTeam, scaleStaffPeople, scaleFirstPeople, scalePeopleRows,
  renderScalePeople, openScalePeople, closeScalePeople, bindScalePeople, SCALE_PEOPLE,
  SCALE_LS, SCALE_LS_DAYS, SCALE_DAYS, SCALE_ONJOB_DAYS, SCALE_FIRST_DAYS,
  SCALE_DAYS_MIN, SCALE_DAYS_MAX, SCALE_ONJOB_DAYS_MIN, SCALE_ONJOB_DAYS_MAX,
  SCALE_FIRST_DAYS_MIN, SCALE_FIRST_DAYS_MAX,
  SCALE_MODE_LABEL, SITE_TO_AREA, SCALE_AREA_ORDER, API_TEAMS };

// ---------------------------------------------------------------- 初始化
(async function init() {
  bindScaleSettings();               // v3.34.0 / v3.35.0：规模设置按钮（三个可调天数）
  bindFirstDetail();                  // v3.35.0：点「今日首跑」表头看逐人判定明细
  bindScalePeople();                  // v3.37.0：点今日入职 / 首跑 / 离职的数字看骑手明细
  bindScaleAdj();                     // v3.37.0：在职规模 / 有效出勤规模 右键手动增减
  bindScaleEvents();                 // v3.31.0：先设好汇总默认区间（天数可配），再渲染
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
