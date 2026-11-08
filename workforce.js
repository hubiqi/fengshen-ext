/* 运力模块（独立页面 v3.15.0，v3.16.0 增补出勤 / 考核运单明细）
 * ---------------------------------------------------------------------------
 * 五个数据源，按「骑手 id」合并成一行一条账单的明细表：
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
 *      不满意单_索赔单），按运单ID去重后读 4 个「是否XX单」列，按骑手 id 计数
 *      → 物流责 / 投诉 / 差评 / 提前点
 *
 * 与另两个页面一样：直连优先、失败自动切「静默桥接」；跟随当前登录态，不依赖本地服务。
 * 前三源并行取数先出主表，后两源异步补齐（失败只让对应列显示「—」，不阻断出表）。
 * v3.16.0：账单ID 默认不在页面/导出图里显示，只在「导出 CSV」时带上。
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

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  month: validMonth(localStorage.getItem("wb_wf_month")) ? localStorage.getItem("wb_wf_month") : curMonth(),
  query: "", site: "", third: "",
  loading: false, gen: 0,
  bills: [], staff: new Map(), clues: new Map(),
  errors: {}, rows: [], loadedAt: null,
  // 主表先出图，这两组明细异步补：失败只让对应列显示「—」，不阻断出表
  attBad: new Map(),        // 骑手id -> 本月除「全天」外「未达成」班次数
  attRun: new Map(),        // 骑手id -> Set(全天行完单量 > 0 的日期)
  kpi: new Map(),           // 骑手id -> { lgt, complain, negative, early }
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
    const iD = col["考勤日期"] != null ? col["考勤日期"] : col["日期"];
    const iP = col["时段"], iOk = col["是否达成"];
    const iO = col["完单量"] != null ? col["完单量"] : col["时段完单量"];
    if ([iR, iD, iP, iOk, iO].some((i) => i === undefined)) continue;
    for (const r of rows.slice(1)) {
      const rid = String(r[iR] == null ? "" : r[iR]).trim();
      if (!rid) continue;
      const per = String(r[iP] == null ? "" : r[iP]).trim();
      const day = String(r[iD] == null ? "" : r[iD]).slice(0, 10);
      // 口径按用户确认：直接采信系统「是否达成」标记，排除「全天」
      if (per && per !== "全天" && String(r[iOk] == null ? "" : r[iOk]).trim() === "未达成")
        bad.set(rid, (bad.get(rid) || 0) + 1);
      // 首跑：全天行完单量 > 0 的日期集合，后面按入职日期过滤取最早一天
      if (per === "全天" && num(r[iO]) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        if (!run.has(rid)) run.set(rid, new Set());
        run.get(rid).add(day);
      }
    }
  }
  return { bad, run };
}

// ---------------------------------------------------------------- 考核运单明细
// 只按 4 个 Radio 筛选拉「有问题」的订单，绝不发起不带筛选的全量运单查询
// （本月约 6 万单、整月可达 20 万单）。multiHeaders + data 逐行读 4 个「是否XX单」列，
// 按运单ID 去重后按骑手汇总；每类筛选最多翻 KPI_MAX_PAGES 页。
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
      const iT = ix("运单ID"), iR = ix("骑手ID");
      const iF = KPI_COLS.map(ix);
      if (iR < 0 || iF.some((i) => i < 0)) break;
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : [];
        const val = (i) => (i >= 0 && cells[i] && cells[i].content != null)
          ? String(cells[i].content).trim() : "";
        const tid = val(iT);
        if (tid && seen.has(tid)) continue;
        seen.set(tid || ("__" + seen.size), {
          rid: val(iR),
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
    const cur = out.get(v.rid) || { lgt: 0, complain: 0, negative: 0, early: 0 };
    cur.lgt += v.lgt; cur.complain += v.complain;
    cur.negative += v.negative; cur.early += v.early;
    out.set(v.rid, cur);
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
    const riderId = String(b.knightId == null ? "" : b.knightId).trim();
    const st = staff.get(riderId);
    const hh = clues.get(riderId);
    const sep = splitSep(b.specialOrderCountDetailList);
    const workStatus = st ? num(st.workStatus) : null;
    const onJob = workStatus === 1 ? "是" : (workStatus === 2 ? "否" : "—");
    const bind = num(b.accommodationFee) + num(b.vehicleRental);
    const bindTip = `住宿费用 ${money(b.accommodationFee)} ＋ 车辆租金 ${money(b.vehicleRental)}`;
    return {
      billId: String(b.settleNum || ""), teamId: String(b.teamId || ""),
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
    const rid = r.riderId;
    r.bad = state.attBad.get(rid) || 0;
    r.badText = state.pendingAtt ? "…" : (state.attReady ? int(r.bad) : "—");
    // 首跑时间只给本月入职骑手：入职日期起第一个「全天」完单 > 0 的日期
    const isNew = /^\d{4}-\d{2}-\d{2}/.test(r.entry) && r.entry.slice(0, 7) === state.month;
    const days = state.attRun.get(rid);
    const first = isNew && days
      ? ([...days].filter((d) => d >= r.entry.slice(0, 10)).sort()[0] || "") : "";
    r.firstRun = first;
    r.firstRunText = state.pendingAtt ? "…" : (isNew ? (first || "—") : "—");
    const f = state.kpi.get(rid) || {};
    r.lgt = f.lgt || 0; r.complain = f.complain || 0;
    r.negative = f.negative || 0; r.early = f.early || 0;
    const kt = (n) => state.pendingKpi ? "…" : (state.kpiReady ? int(n) : "—");
    r.lgtText = kt(r.lgt); r.complainText = kt(r.complain);
    r.negativeText = kt(r.negative); r.earlyText = kt(r.early);
  }
  return rows;
}

// ---------------------------------------------------------------- 筛选 / 排序
function visibleRows() {
  const q = state.query.trim().toLowerCase();
  const rows = state.rows.filter((r) => {
    if (state.site && r.team !== state.site) return false;
    if (state.third === "yes" && !r.thirdYes) return false;
    if (state.third === "no" && r.thirdYes) return false;
    if (q && ![r.billId, r.team, r.teamId, r.riderId, r.riderName, r.scheme]
      .some((v) => String(v).toLowerCase().includes(q))) return false;
    return true;
  });
  return rows.sort((a, b) =>
    a.team.localeCompare(b.team, "zh") || a.riderName.localeCompare(b.riderName, "zh") || a.billId.localeCompare(b.billId));
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
  if (errs.length) bits.push(`<b>${errs.length}</b> 个数据源未取到：${esc(errs.map(([k]) => SRC_LABEL[k] || k).join("、"))}`);
  $("wf-note").innerHTML = bits.join("　·　");
}

function renderTable(rows) {
  const t = $("wf-table");
  const head = "<thead><tr>" + PAGE_COLS.map((c) => `<th>${esc(c.h)}</th>`).join("") + "</tr></thead>";
  const body = ["<tbody>"];
  if (!rows.length) {
    body.push(`<tr class="wf-empty"><td colspan="${PAGE_COLS.length}">没有符合条件的账单${state.rows.length ? "（试试清空搜索或筛选）" : "（可切换月份或点「立即刷新」）"}</td></tr>`);
  }
  for (const r of rows) {
    body.push("<tr>" + PAGE_COLS.map((c) => {
      const key = c.k;
      const raw = r[key] == null ? "" : r[key];
      const isHtml = key === "onJobHtml" || key === "thirdHtml";
      const txt = isHtml ? raw : esc(raw);
      const title = key === "bindText" ? ` title="${esc(r.bindTip)}"`
        : key === "thirdHtml" && r.thirdName ? ` title="${esc(r.thirdName)}"`
        : key === "badText" ? ' title="出勤明细中除全天外「是否达成 = 未达成」的班次数"'
        : key === "firstRunText" && r.firstRun ? ` title="入职 ${esc(r.entry)} 起首个全天有单日"` : "";
      const na = !isHtml && (raw === "—" || raw === "") ? " c-empty" : "";
      const hot = !isHtml && /^(badText|lgtText|complainText|negativeText|earlyText)$/.test(key)
        && Number(raw) > 0 ? " hot" : "";
      return `<td class="${c.cls || ""}${na}${hot}"${title}>${txt}</td>`;
    }).join("") + "</tr>");
  }
  body.push("</tbody>");
  t.innerHTML = head + body.join("");
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
    "物流责 / 投诉 / 差评 / 提前点 = 考核运单明细里 4 类异常订单按骑手计数；金额单位人民币元。";
}

function applyData() {
  state.rows = attachDetail(buildRows(state.bills, state.staff, state.clues));
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
window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearNotice(); });

// ---------------------------------------------------------------- 测试钩子
// 注入三份样本数据后直接出表，不触发任何网络请求；CDP 回归用。
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
    state.attBad = new Map(Object.entries(obj.att.bad || {}));
    state.attRun = new Map(Object.entries(obj.att.run || {}).map(([k, v]) => [k, new Set(v || [])]));
    state.attReady = true;
  }
  if (obj.kpi) {
    state.kpi = new Map(Object.entries(obj.kpi).map(([k, v]) =>
      [k, Object.assign({ lgt: 0, complain: 0, negative: 0, early: 0 }, v)]));
    state.kpiReady = true;
  }
  if (obj.attReady === false) { state.attReady = false; state.attBad = new Map(); state.attRun = new Map(); }
  if (obj.kpiReady === false) { state.kpiReady = false; state.kpi = new Map(); }
  state.pendingAtt = false; state.pendingKpi = false;
  state.loadedAt = new Date().toTimeString().slice(0, 5);
  applyData();
  setProgress(100, "");
  return state.rows.length;
};
window.__WF__ = { state, COLS, PAGE_COLS, buildRows, attachDetail, visibleRows, splitSep,
  staffMap, clueMap, money, attStatsFromSheets, monthSegments, monthBounds, exportCsv,
  applyData, loadKpiFlags, loadAttendance, KPI_FILTERS };

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
