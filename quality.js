/* 质量运营模块（v3.53.0，独立页面）
 * ---------------------------------------------------------------------------
 * 整商 / 商圈片 / 站点 / 骑手（按钮切换）× 炸班次 / 坏单（视图切换）的本月日期矩阵，
 * 行主体随维度变化（v3.45.0）：整商 = 1 行汇总；商圈片 / 站点 = 各一行；
 * 骑手 = 只显示本月有炸班或坏单的骑手。列 = 本月 1 ~ 今日 + 「本月合计」，表尾有「合计」行。
 * v3.48.1：修复面板 iframe 被拦截（manifest 漏声明本页 3 个资源）；页加载后向宿主上报 READY。
 * v3.48.0：「全天」班次单独定义达标标准（默认 完单量 ≥ 18 单 且 有效在线时长 ≥ 6 小时），
 *   不采信系统「是否达成」标记；工具条「全天标准」可编辑、本机记忆、改完立即重算矩阵。
 *   历史明细读「完单量 / 有效在线时长」，T0 实时快照读「全天完单量 / 全天有效在线时长」
 *   并按「排班状态」过滤（全天汇总行不在「排班时段」计划里）。
 * v3.53.0：T0（今天）炸班次参考「出勤达成」的方法恢复显示 —— 实时快照按
 *   ASSESS.PERIOD_DEFS / PERIOD_STANDARDS 只统计已结束班次、用「有效在线时长 + 完单量」
 *   双门槛判定（不采信系统标记），未结束 / 整班次数据未出显示琥珀「统计中」不算炸班；
 *   T0「全天」默认不判（一天没过完 18单/6小时不准），工具条开关可临时打开仅供参考；
 *   共享缓存仍只写 T+1 历史明细，T0 快照只存内存。撤销 v3.50.0 的「整列砍掉 T0」。
 * v3.52.0：骑手维度严格只显示「当前视图」有问题的骑手（旧版取炸班∪坏单并集，坏单视图里
 *   大量整行空白的骑手让人以为没过滤）；标题显示共/显示/隐藏人数，矩阵对整月合计为 0 的
 *   骑手行做二次剔除，骑手行副标题显示整月炸班 / 坏单数量，弹层问题记录优先。
 * v3.51.0：骑手维度按整月汇总降序排序（当前视图合计优先、另一视图合计次之）；
 *   筛选口径改用 recOk()（全天自定义标准也算「有问题」），与矩阵合计列完全一致。
 * v3.50.0：曾把当天 T0 整列砍掉（未结算全天被判成 223 个炸班）—— v3.53.0 起改为
 *   参考出勤达成口径恢复显示，仅保留「共享缓存只写 T+1 历史明细」这一条。
 * v3.49.0：坏单口径回退到「只认考核运单明细标签」—— 申诉 / 违规处罚明细只提供运单号
 *   用于回查匹配，违规分类不再产生任何坏单标签；回查命中但 4 列全「否」的单直接剔除。
 *   （v3.47.0 曾把 149 个成立违规单按分类计入，导致坏单虚高，本版按用户口径撤销。）
 *   申诉 item 的 violationTime / knightInfo / teamInfo 只用于补全已命中坏单的元信息。
 *   共享缓存升 v3，升级后旧缓存自动失效重取。
 * v3.46.0：① 数据优先复用运力模块写下的整月原始明细（同源 localStorage 缓存，零重复请求，
 *   「立即刷新」强制重拉）；② 坏单「日期」列实际是 20261111 紧凑格式，统一归一 YYYY-MM-DD
 *   （此前校验失败导致坏单全被过滤、矩阵空白）；③ 面板 iframe 内默认走静默桥接 + 弹层
 *   「↗ 新标签」兜底，行键改用安全分隔符；④ 两个矩阵都加汇总数量。
 *   炸班次单元格：只显示炸掉的班次（红，含「全天」按系统标记），同一班次炸多人显示
 *     「班次*n」（人数降序）；空白 = 全部达成或无排班；实时快照缺达成标记 → 琥珀「统计中」。
 *   坏单单元格：只显示非零类型（红「类型*N」，一个订单命中多个标签各计一次）。
 *   点单元格弹该行当天的明细（班次：骑手 / 达成 / 完单 / 有效在线；坏单：运单 + 标签）。
 *
 * 数据源全部复用运力模块已验证的接口：
 *   1) 出勤统计 → 导出明细数据 exportStatisticsDetail/1.0（本月按 7 天分段拉 xlsx）
 *      「是否排班」取值为 排班/未排班/休息 —— 只保留「排班」行（v3.44.0 修复统计中满天飞）。
 *   2) 出勤达成同款实时快照 exportAttendance/1.0 —— 仅当月用于补今天（历史 T+1 结算），
 *      快照按「排班时段」计划列过滤（时段不在计划里的行跳过）。
 *   3) KPI管理 → 考核运单明细 perfDetail.queryDetailList/1.0（tabCode=TRACK_UB）：
 *      4 个 Radio 筛选各查一次 + 违规处罚列表（violationOrderAeolusCenterApi.queryList/1.0，
 *      违规状态=成立、分类=差评+投诉、单次窗口 ≤2 天按 2 天分段）的运单号去重后
 *      逗号拼接 50 单/批回查 —— 与运力模块 v3.41.0 同一套并集口径，不漏不重。
 *
 * 与另两个页面一样：直连优先、失败自动切「静默桥接」；限频错误退避重试不切通道。
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
/** v3.53.0：T0（今天）炸班次口径参考「出勤达成」—— 与 ASSESS.PERIOD_DEFS /
 *  config.py PERIOD_STANDARDS 同源（start/end/timeMin 单位：分钟，orders：单）。
 *  只统计「已结束」的班次；未结束/进行中的班次显示琥珀「统计中」、不算炸班。 */
const T0_PERIODS = [
  { name: "凌晨1",   start: 0,              end: 2 * 60,       timeMin: 90,  orders: 1 },
  { name: "凌晨2",   start: 2 * 60,         end: 4 * 60,       timeMin: 78,  orders: 1 },
  { name: "凌晨3",   start: 4 * 60,         end: 6 * 60,       timeMin: 72,  orders: 1 },
  { name: "早餐1",   start: 6 * 60,         end: 8 * 60,       timeMin: 90,  orders: 1 },
  { name: "早餐2",   start: 8 * 60,         end: 10 * 60 + 30, timeMin: 120, orders: 1 },
  { name: "午高峰",  start: 10 * 60 + 30,   end: 13 * 60 + 30, timeMin: 150, orders: 5 },
  { name: "下午茶1", start: 13 * 60 + 30,   end: 15 * 60 + 30, timeMin: 90,  orders: 2 },
  { name: "下午茶2", start: 15 * 60 + 30,   end: 17 * 60 + 30, timeMin: 90,  orders: 2 },
  { name: "晚高峰",  start: 17 * 60 + 30,   end: 20 * 60,      timeMin: 120, orders: 3 },
  { name: "夜宵1",   start: 20 * 60,        end: 22 * 60,      timeMin: 90,  orders: 2 },
  { name: "夜宵2",   start: 22 * 60,        end: 24 * 60,      timeMin: 90,  orders: 2 }
];
const t0PeriodOf = (per) => T0_PERIODS.find((p) => p.name === per);
/** 当前时间该班次是否还没跑完（与出勤达成 ASSESS.build 的 ongoing 同口径：minute < end）。 */
function t0Ongoing(per, now) {
  const p = t0PeriodOf(per);
  if (!p) return false;
  const d = now || new Date();
  return (d.getHours() * 60 + d.getMinutes()) < p.end;
}
/** T0 实时快照记录判定（参考出勤达成）：
 *  - 未结束班次 / 整班次数据还没跑出来 → -1「统计中」，绝不误判成炸班；
 *  - 已结束班次 → 双门槛「有效在线 ≥ timeMin 且 完单 ≥ orders」判达标，不采信系统标记；
 *  - 「全天」是汇总行，一天没过完按 18单/6小时判不准 → 默认整行不参与，
 *    工具条「T0 全天」开关打开时才按可编辑标准判定（仅供参考）。
 *  历史日期仍走原来的口径（系统「是否达成」+ 全天自定义标准），不受影响。 */
function applyT0Verdict(recs, now) {
  const d = now || new Date();
  const minute = d.getHours() * 60 + d.getMinutes();
  const activity = new Map();     // 班次 -> 快照里是否已有任何有效数据
  for (const r of recs) {
    if (r.per === "全天") continue;
    if (num(r.orders) > 0 || (parseHours(r.online) || 0) > 0) activity.set(r.per, true);
  }
  const out = [];
  let ended = 0, ongoing = 0;
  for (const r of recs) {
    r.t0 = true;
    if (r.per === "全天") {
      if (!state.t0AllDay) continue;                 // T0 全天默认不判
      r.ok = allDayVerdict(r, state.allDay);        // 开关打开时按 18单/6小时（仅供参考）
      out.push(r);
      continue;
    }
    const p = t0PeriodOf(r.per);
    if (!p || minute < p.end) { r.ok = -1; ongoing++; out.push(r); continue; }
    ended++;
    if (!activity.get(r.per)) { r.ok = -1; out.push(r); continue; }  // 整班次数据未出
    const h = parseHours(r.online);
    r.ok = (h !== null && h * 60 >= p.timeMin && num(r.orders) >= p.orders) ? 1 : 0;
    out.push(r);
  }
  return { recs: out, ended, ongoing };
}

/** v3.53.0：从出勤记录里剥掉「当天 T0」的历史行，用于① 读取共享缓存时去重
 *  ② 写回共享缓存时保证缓存只含 T+1 结算明细。T0 实时快照另存 state.t0Raw / state.recs，
 *  按出勤达成口径判定后参与矩阵，但绝不写入缓存（避免未结算数据污染其它模块）。 */
function settledRecs(recs, month) {
  const m = month || state.month;
  if (m !== curMonth()) return recs || [];
  const t = todayYmd();
  return (recs || []).filter((r) => r.day !== t);
}
/** v3.53.0：T0 参考出勤达成口径恢复显示 —— 两个视图的列范围都是本月 1 ~ 今天。
 *  （保留函数供标题 / 渲染统一调用，兼容历史月份。） */
function shiftDayMax(month, b) { return b.maxDay; }
function monthSegments(month) {
  const b = monthBounds(month);
  const out = [];
  for (let d = 1; d <= b.maxDay; d += ATT_SEG_DAYS) {
    out.push([`${month}-${padDay(d)}`, `${month}-${padDay(Math.min(d + ATT_SEG_DAYS - 1, b.maxDay))}`]);
  }
  return out;
}

// ---------------------------------------------------------------- 网络层（与运力模块同款）
const SHARE_LS = "wb_wf_raw_v3_";     // 与运力模块同源共享的整月原始明细缓存
const ALLDAY_LS = "wb_ql_allday_v1";            // v3.48.0：全天班次达标标准（本机记忆、可编辑）
const ALLDAY_DEFAULT = { orders: 18, hours: 6 };// 默认：完单量 ≥ 18 单 且 有效在线时长 ≥ 6 小时
function loadAllDayCfg() {
  try {
    const v = JSON.parse(localStorage.getItem(ALLDAY_LS) || "null");
    if (v && isFinite(v.orders) && isFinite(v.hours)) {
      return {
        orders: Math.max(0, Math.min(200, Math.round(Number(v.orders)))),
        hours: Math.max(0, Math.min(24, Math.round(Number(v.hours) * 10) / 10))
      };
    }
  } catch (e) { /* 坏数据用默认值 */ }
  return Object.assign({}, ALLDAY_DEFAULT);
}
/** 「11小时06分钟」/「6小时」/「6」→ 小时数；空或无法识别 → null。 */
function parseHours(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t) return null;
  let m = t.match(/^(\d+)\s*小时\s*(\d+)\s*分/);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  m = t.match(/^(\d+)\s*分/);
  if (m) return Number(m[1]) / 60;
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:小时|时|h)$/i);
  if (m) return Number(m[1]);
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return null;
}
/** 全天班次按自定义标准判定：完单量 ≥ N 且 有效时长 ≥ H 才算达标，否则炸班；
 *  两项都没有数据 → -1「统计中」（不把无数据行误判成炸班）。 */
function allDayVerdict(rec, cfg) {
  const c = cfg || state.allDay || ALLDAY_DEFAULT;
  const orders = num(rec && rec.orders);
  const hours = parseHours(rec && rec.online);
  if (hours === null && !orders) return -1;
  return (orders >= c.orders && (hours || 0) >= c.hours) ? 1 : 0;
}
/** 统一的班次达成判定：全天走自定义标准，其余班次仍采信系统「是否达成」标记。 */
function recOk(rec) {
  if (!rec) return -1;
  if (rec.t0) return rec.ok;      // v3.53.0：T0 已按出勤达成口径（含全天开关）判定
  return rec.per === "全天" ? allDayVerdict(rec, state.allDay) : rec.ok;
}
function allDayLabel() { return `${state.allDay.orders}单 / ${state.allDay.hours}小时`; }
const state = {
  // v3.46.0：面板 iframe 内默认走「静默桥接」（后台标签取数，登录态稳定）；
  // 独立标签页默认直连。任一通道失败自动切另一条再试一次。
  via: (typeof window !== "undefined" && window.top !== window.self) ? "bridge" : "direct",
  gen: 0, loading: false, force: false, fromShared: false,
  month: curMonth(), dim: "agency", scopeKey: "", view: "shift",
  teams: [], teamErr: "",
  recs: [], attErr: "",
  orders: [], kpiErr: "",
  violMap: new Map(),         // v3.49.0：申诉/违规明细运单 → 仅元信息（不产生坏单标签）
  allDay: loadAllDayCfg(),    // v3.48.0：全天班次达标标准（可编辑）
  riderStats: null,           // v3.52.0：骑手维度过滤统计（共 N 名 / 显示 M 名 / 隐藏 X 名）
  t0AllDay: (() => { try { return localStorage.getItem("wb_ql_t0_allday") === "on"; }
    catch (e) { return false; } })(),   // v3.53.0：T0 全天开关（默认关，本机记忆）
  t0Raw: [], t0Info: null, t0Err: "", liveUsed: false
};
/** 读取运力模块写下的整月原始明细（localStorage 在扩展各页面间同源共享）。 */
function readShared(month) {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARE_LS + month) || "null");
    if (!raw || raw.v !== 3 || raw.month !== month) return null;
    if (raw.complete === false) return null;      // 半份数据不复用
    if (!Array.isArray(raw.recs) || !Array.isArray(raw.orders)) return null;
    if (!raw.recs.length && !raw.orders.length) return null;
    if (!raw.ts || Date.now() - raw.ts > 12 * 3600 * 1000) return null;   // 12 小时内有效
    return raw;
  } catch (e) { return null; }
}
function writeShared(month, teams, recs, orders) {
  try {
    localStorage.setItem(SHARE_LS + month, JSON.stringify({
      v: 3, month, ts: Date.now(),
      teams: (teams || []).map((t) => ({ id: String(t.id), name: String(t.name || "") })),
      recs: recs || [], orders: orders || []
    }));
  } catch (e) { /* 配额不足不影响出表 */ }
}
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
  const first = state.via;
  const call = (via) => via === "direct" ? direct(url, method, payload) : bridge(url, method, payload);
  try { return await call(first); }
  catch (e) {
    // 限频不切通道：切通道同样撞同一个后端限流，交给 requestRL 退避重试
    if (/频繁|FREQUEN/i.test(String((e && e.message) || e))) throw e;
    const second = first === "direct" ? "bridge" : "direct";
    state.via = second;
    showNotice((first === "direct" ? "直连" : "静默桥接") + "未成功（" +
      (e.message || "未知原因") + "），已自动切到「" +
      (second === "direct" ? "直连" : "静默桥接") + "」重试。", "blue");
    try { return await call(second); }
    catch (e2) { state.via = first; throw e2; }
  }
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
function inScope() { return true; }   // v3.45.0：行实体随维度分组，不再按范围过滤记录（保留空实现兼容旧引用）
function dimNameCn() {
  return { agency: "整商", area: "商圈片", site: "站点", rider: "骑手" }[state.dim] || "";
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
    const iStatus = idx("排班状态");    // 实时快照
    const iPlan = idx("排班时段");      // 实时快照：当天排班计划（「午高峰、晚高峰、…」）
    const iO = idx("时段完单量", "完单量");
    const iV = idx("时段有效在线时长", "有效在线时长", "有效在线");
    const iAO = idx("全天完单量");       // 实时快照的全天汇总行专用列
    const iAV = idx("全天有效在线时长");
    if (iR === undefined || iP === undefined) continue;
    for (const r of rows.slice(1)) {
      const rid = normId(r[iR]);
      if (!rid) continue;
      const per = str(r[iP]);
      if (!per) continue;
      const rawDay = iD !== undefined ? str(r[iD]) : str(defaultDay);
      const d8 = rawDay.replace(/\D/g, "").slice(0, 8);
      const day = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : rawDay.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const isAllDay = per === "全天";
      // 「是否排班」实际取值为 排班 / 未排班 / 休息 —— 只保留「排班」；
      // 未排班 / 休息行的「是否达成」必为空，不滤掉会把整片格子染成「统计中」。
      if (iSched !== undefined) {
        if (str(r[iSched]) !== "排班") continue;
      } else if (isAllDay) {
        // 实时快照的「全天」是汇总行，不在「排班时段」计划里 —— 改按「排班状态」判断
        if (iStatus !== undefined && str(r[iStatus]) !== "排班") continue;
      } else if (iPlan !== undefined) {
        const plan = str(r[iPlan]);
        const planArr = plan.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
        if (!planArr.includes(per)) continue;
      }
      const okRaw = iOk !== undefined ? str(r[iOk]) : "";
      const ok = okRaw === "达成" ? 1 : (okRaw === "未达成" ? 0 : -1);
      // 全天行优先取「全天完单量 / 全天有效在线时长」列（实时快照），
      // 历史明细只有「完单量 / 有效在线时长」，iAO/iAV 为 undefined 时自动回退。
      const orders = (isAllDay && iAO !== undefined) ? num(r[iAO]) : (iO !== undefined ? num(r[iO]) : 0);
      const online = (isAllDay && iAV !== undefined) ? str(r[iAV]) : (iV !== undefined ? str(r[iV]) : "");
      out.push({
        rid, name: iName !== undefined ? str(r[iName]) : "",
        teamId: iS !== undefined ? normId(r[iS]) : "",
        siteName: iN !== undefined ? str(r[iN]) : "",
        day, per, ok, orders, online
      });
    }
  }
  return out;
}
/** 当天 T0 实时考勤快照（exportAttendance 忽略日期、永远返回当前实时数据）。
 *  v3.53.0 恢复使用：由 loadT0() 解析后按出勤达成口径判定已结束班次。 */
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
/** 违规处罚 / 申诉明细 item → 仅解析元信息（v3.49.0）。
 *  用户口径：申诉明细只提供运单号用于回查「匹配」考核运单明细，坏单标签一律以考核明细
 *  的 4 个「是否XX单」列为准；违规分类（COMPLAIN / BAD_REVIEW）不再产生任何坏单标签。
 *  violationTime「2026-11-12T22:46:16」/ knightInfo「ID-姓名」/ teamInfo「ID-站点名」
 *  仅用于补全考核明细行缺失的日期 / 骑手 / 站点。 */
function violationMeta(x) {
  const tid = str(x && x.trackingId);
  if (!tid) return null;
  const d8 = String((x && x.violationTime) || "").replace(/\D/g, "").slice(0, 8);
  const day = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : "";
  const ki = String((x && x.knightInfo) || "").split("-");
  const ti = String((x && x.teamInfo) || "").split("-");
  return {
    tid, day,
    rid: normId(ki[0] || ""), rname: ki.slice(1).join("-"),
    teamId: normId(ti[0] || ""), siteName: ti.slice(1).join("-")
  };
}
/** v3.49.0：申诉明细只补元信息 —— 绝不产生坏单标签、绝不新建坏单行。
 *  仅当该运单已被考核明细命中且已有标签、但缺日期 / 骑手 / 站点时才补空字段。 */
function applyViolationMeta(seen) {
  let filled = 0;
  for (const [tid, v] of state.violMap) {
    const cur = seen.get(tid);
    if (!cur || !hasKpiTag(cur)) continue;
    let hit = false;
    if (!cur.day && v.day) { cur.day = v.day; hit = true; }
    if (!cur.rid && v.rid) { cur.rid = v.rid; hit = true; }
    if (!cur.rname && v.rname) { cur.rname = v.rname; hit = true; }
    if (!cur.teamId && v.teamId) { cur.teamId = v.teamId; hit = true; }
    if (!cur.siteName && v.siteName) { cur.siteName = v.siteName; hit = true; }
    if (hit) filled++;
  }
  return { filled };
}
/** 坏单标签唯一来源 = 考核运单明细 4 列；全「否」的回查命中行不算坏单。 */
function hasKpiTag(o) { return !!(o && (o.lgt || o.complain || o.negative || o.early)); }
function keepKpiTagged(seen) {
  let dropped = 0;
  for (const [tid, o] of seen) {
    if (!hasKpiTag(o)) { seen.delete(tid); dropped++; }
  }
  return dropped;
}
function parseBadRows(j, seen) {
  const d = (j && j.result && j.result.data) || {};
  const heads = (d.multiHeaders || [])[0] || [];
  const rows = Array.isArray(d.data) ? d.data : [];
  const ix = (n) => heads.indexOf(n);
  const iT = ix("运单ID"), iR = ix("骑手ID"), iD = ix("日期");
  const iName = ix("骑手姓名"), iS = ix("站点ID"), iN = ix("站点名称");
  const iCreate = ix("运单创建时间");
  const iF = KPI_COLS.map(ix);
  if (iT < 0 || iR < 0 || iF.some((i) => i < 0)) return { rows: 0 };
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    const val = (i) => (i >= 0 && cells[i] && cells[i].content != null)
      ? String(cells[i].content).trim() : "";
    const tid = val(iT);
    if (!tid) continue;
    // 真机核实：「日期」列是 20261111 这类 8 位紧凑格式（也可能是 2026-11-11 / 带时间），
    // 统一归一成 YYYY-MM-DD；日期列缺失时退到「运单创建时间」。
    const d8 = (iD >= 0 ? val(iD) : "").replace(/\D/g, "").slice(0, 8)
      || (iCreate >= 0 ? val(iCreate) : "").replace(/\D/g, "").slice(0, 8);
    const day = /^\d{8}$/.test(d8) ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : "";
    const rec = {
      tid, day,
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
  state.violMap = new Map();
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
        const v = violationMeta(x);       // v3.49.0：只取运单号 + 元信息，不取违规分类标签
        if (!v) continue;
        tids.add(v.tid);
        const prev = state.violMap.get(v.tid);
        if (prev) {
          if (!prev.day && v.day) prev.day = v.day;
          if (!prev.rid && v.rid) prev.rid = v.rid;
          if (!prev.rname && v.rname) prev.rname = v.rname;
          if (!prev.teamId && v.teamId) prev.teamId = v.teamId;
          if (!prev.siteName && v.siteName) prev.siteName = v.siteName;
        } else {
          state.violMap.set(v.tid, v);
        }
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
  state.violMap = new Map();
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
  // v3.49.0：坏单数量一律以考核运单明细 4 个标签列为准。
  // 申诉 / 违规明细只提供运单号用于回查匹配；命中但 4 列全「否」的单不计坏单
  // （v3.47.0 曾把违规分类当独立标签，导致 149 个成立单被计入、坏单虚高）。
  const vm = applyViolationMeta(seen);
  const dropped = keepKpiTagged(seen);
  if (vm.filled || dropped)
    setProgress(88, `按考核明细标签定稿：${vm.filled} 单补元信息 / ${dropped} 单无标签剔除`);
  return [...seen.values()];
}

/** 用保存的 T0 原始快照重算判定（切换「T0 全天」开关 / 改全天标准时立即重算，不重新取数）。 */
function refreshT0() {
  const t = todayYmd();
  const raw = (state.t0Raw || []).map((r) => Object.assign({}, r, { day: t }));
  const v = applyT0Verdict(raw, new Date());
  state.recs = [...(state.recs || []).filter((r) => !r.t0), ...v.recs];
  state.t0Info = {
    ended: v.ended, ongoing: v.ongoing,
    rows: v.recs.length, allDay: state.t0AllDay, used: state.liveUsed
  };
}
/** 当前月拉一次 T0 实时考勤快照，按出勤达成口径判定后并入 state.recs。
 *  快照只在内存里用，绝不写进同源共享缓存（缓存只存 T+1 结算的历史明细）。 */
async function loadT0(teamIds, gen) {
  state.t0Raw = []; state.t0Info = null; state.t0Err = "";
  if (state.month !== curMonth() || !teamIds || !teamIds.length) return;
  try {
    const live = await loadLiveToday(teamIds, todayYmd());
    if (gen !== state.gen) return;
    state.t0Raw = parseAttSheets(live, todayYmd());
    state.liveUsed = true;
    refreshT0();
  } catch (e) {
    state.t0Err = String((e && e.message) || e);
    state.t0Raw = [];
  }
}
function toggleT0AllDay() {
  if (state.month !== curMonth()) {
    showNotice("「T0 全天」只对当月今天生效；切回本月再调整。", "blue");
    return;
  }
  state.t0AllDay = !state.t0AllDay;
  try { localStorage.setItem("wb_ql_t0_allday", state.t0AllDay ? "on" : "off"); } catch (e) { /* 无痕忽略 */ }
  if (state.t0Raw.length) refreshT0();
  renderAll();
  showNotice(state.t0AllDay
    ? "T0「全天」已临时打开：一天没过完，这批人仅供参考，次日 T+1 结算后以历史明细为准。"
    : "T0「全天」已关闭（默认）：当天不判全天，避免未结算数据被算成大片炸班。", "blue");
}

// ---------------------------------------------------------------- 取数总流程
async function loadAll(force) {
  if (state.loading) return;
  state.loading = true;
  const gen = ++state.gen;
  $("btn-refresh").disabled = true;
  showNotice("");
  state.force = !!force;
  state.fromShared = false;
  state.teamErr = state.attErr = state.kpiErr = "";
  state.recs = []; state.orders = []; state.liveUsed = false;
  state.t0Raw = []; state.t0Info = null; state.t0Err = "";   // v3.53.0：切月不残留 T0 快照

  // v3.46.0：运力模块已把整月原始明细写进同源缓存 —— 质量运营直接复用，零重复请求。
  // 「立即刷新」= force，跳过缓存重新拉一遍。
  const shared = state.force ? null : readShared(state.month);
  if (shared) {
    state.teams = shared.teams || [];
    state.recs = settledRecs(shared.recs || []);
    state.orders = (shared.orders || []).filter((o) => o.day && hasKpiTag(o));
    state.fromShared = true;
    if (!state.teams.length) { try { state.teams = await loadTeams(); } catch (e) { /* 站点名映射降级 */ } }
    // v3.53.0：缓存只含 T+1 历史明细，当天 T0 另拉一次实时快照（出勤达成口径）
    await loadT0(state.teams.map((t) => t.id), gen);
    if (gen !== state.gen) { state.loading = false; return; }
    setProgress(null);
    renderAll();
    const at = new Date(shared.ts).toTimeString().slice(0, 5);
    showNotice(`已复用运力模块 ${state.month} 的整月明细（${at} 取数）：出勤 ${state.recs.length} 行 / 坏单 ${state.orders.length} 单；当天 T0 按出勤达成口径单独取数。需要最新数据点「立即刷新」强制重拉。`, "blue");
    setStatus(`复用运力模块 · ${at}`);
    $("btn-refresh").disabled = false;
    state.loading = false;
    state.force = false;
    return;
  }
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
    state.recs = settledRecs(parseAttSheets(sheets));
  } catch (e) {
    state.attErr = String((e && e.message) || e);
    state.recs = [];
  }
  setProgress(55, "坏单明细拉取中…");
  try {
    state.orders = (await loadBadOrders(state.month)).filter((o) => o.day && hasKpiTag(o));
  } catch (e) {
    state.kpiErr = String((e && e.message) || e);
    state.orders = [];
  }
  if (gen !== state.gen) { state.loading = false; return; }
  // v3.53.0：当天 T0 参考「出勤达成」—— 实时快照只统计已结束班次、双门槛判定，
  // 未结束显示「统计中」、全天默认不判；恢复当天这一列，不再整列砍掉。
  setProgress(92, "当天 T0 实时快照（出勤达成口径）…");
  await loadT0(teamIds, gen);
  if (gen !== state.gen) { state.loading = false; return; }
  setProgress(100, "");
  setProgress(null);
  // 共享缓存只写 T+1 结算的历史明细，T0 快照绝不入缓存
  writeShared(state.month, state.teams, settledRecs(state.recs), state.orders);
  renderAll();
  const errs = [state.teamErr && "站点列表", state.attErr && "出勤明细", state.kpiErr && "坏单明细"].filter(Boolean);
  if (errs.length) showNotice("部分数据源未取到：" + errs.join("、") + "，对应行列显示「—」，可点「立即刷新」重试。");
  setStatus(`取数完成 ${new Date().toTimeString().slice(0, 5)}${state.via === "bridge" ? " · 静默桥接" : ""}`);
  $("btn-refresh").disabled = false;
  state.loading = false;
}

// ---------------------------------------------------------------- 矩阵聚合（行 = 骑手，列 = 日期）
/** 行实体随维度变化（v3.45.0）：整商 = 1 行汇总；商圈片 / 站点 = 各一行；
 *  骑手 = 只显示本月有炸班或坏单的骑手。返回 [{key, name, sub}]。 */
function entityRows() {
  const d = state.dim;
  if (d === "agency") return [{ key: "__AGENCY__", name: "整商汇总", sub: "" }];
  if (d === "area") {
    const m = new Map();   // area -> {sites:Set}
    for (const r of state.recs) {
      const a = areaOf(r.teamId, r.siteName);
      if (!m.has(a)) m.set(a, new Set());
      m.get(a).add(normId(r.teamId) || a);
    }
    for (const o of state.orders) {
      if (!(o.lgt || o.complain || o.negative || o.early)) continue;
      const a = areaOf(o.teamId, o.siteName);
      if (!m.has(a)) m.set(a, new Set());
      m.get(a).add(normId(o.teamId) || a);
    }
    return [...m.entries()].map(([a, sites]) =>
      ({ key: "A|" + a, name: a, sub: `${sites.size} 个站点` }))
      .sort((x, y) => x.name.localeCompare(y.name, "zh-CN"));
  }
  if (d === "site") {
    const names = teamNameById();
    const m = new Map();   // teamId -> name
    for (const r of state.recs) m.set(normId(r.teamId) || normId(r.siteName), str(r.siteName));
    for (const o of state.orders) {
      if (!(o.lgt || o.complain || o.negative || o.early)) continue;
      m.set(normId(o.teamId) || normId(o.siteName), str(o.siteName));
    }
    return [...m.entries()].map(([tid, sn]) =>
      ({ key: "S|" + tid, name: sn || names[tid] || ("站点 " + tid),
        sub: areaOf(tid, sn) }))
      .sort((x, y) => x.name.localeCompare(y.name, "zh-CN"));
  }
  // 骑手维度（v3.52.0）：严格只显示「当前视图」本月确实有问题的骑手 ——
  //   炸班次视图：整月炸班次数 > 0；坏单视图：整月坏单标签数 > 0。
  // 旧版取「炸班 ∪ 坏单」并集，导致坏单视图里出现大量整行空白、本月合计为「—」的
  // 骑手（整月累积有过一次炸班的人本就很多），看起来完全像没有过滤。
  // 汇总口径与矩阵行末「本月合计」完全一致：炸班 = recOk()===0 的班次数（全天走自定义标准），
  // 坏单 = 4 个标签数之和（一个订单命中多个标签各计一次）。
  const infos = riderInfoMap();
  const shiftTotal = new Map(), badTotal = new Map();
  const inc = (m, rid, n) => { const k = normId(rid); if (k) m.set(k, (m.get(k) || 0) + n); };
  for (const r of state.recs) if (recOk(r) === 0) inc(shiftTotal, r.rid, 1);
  for (const o of state.orders) {
    const n = (o.lgt || 0) + (o.complain || 0) + (o.negative || 0) + (o.early || 0);
    if (n) inc(badTotal, o.rid, n);
  }
  const viewShift = state.view === "shift";
  const all = [...infos.values()];
  const list = all.filter((r) =>
    (viewShift ? (shiftTotal.get(r.rid) || 0) : (badTotal.get(r.rid) || 0)) > 0);
  // 过滤效果可见化：标题显示「共 N 名 / 显示 M 名 / 隐藏 X 名」
  state.riderStats = {
    total: all.length, shown: list.length, hidden: all.length - list.length, view: state.view
  };
  // 主排序 = 当前视图的整月合计（多 → 少）；相同则按另一视图的整月合计（多 → 少）；最后按姓名
  list.sort((a, b) => {
    const as = shiftTotal.get(a.rid) || 0, bs = shiftTotal.get(b.rid) || 0;
    const ab = badTotal.get(a.rid) || 0, bb = badTotal.get(b.rid) || 0;
    const primary = viewShift ? bs - as : bb - ab;
    if (primary) return primary;
    const secondary = viewShift ? bb - ab : bs - as;
    if (secondary) return secondary;
    return String(a.name || a.rid).localeCompare(String(b.name || b.rid), "zh-CN");
  });
  return list.map((r) => {
    const site = r.siteName || r.area || "";
    const sf = shiftTotal.get(r.rid) || 0, bd = badTotal.get(r.rid) || 0;
    return {
      key: "R|" + r.rid, name: r.name || r.rid,
      sub: (site ? site + " · " : "") + `整月炸班 ${sf} / 坏单 ${bd}`
    };
  });
}
/** 骑手信息（主站点 = 本月班次最多的站点），供骑手维度行与弹层使用。 */
function riderInfoMap() {
  const map = new Map();
  const riderOf = (rid) => {
    if (!map.has(rid)) map.set(rid, { rid, name: "", sites: new Map() });
    return map.get(rid);
  };
  for (const rec of state.recs) {
    const rid = normId(rec.rid);
    if (!rid || rid === "0") continue;
    const r = riderOf(rid);
    if (rec.name && !r.name) r.name = rec.name;
    const key = normId(rec.teamId) + "\u0001" + str(rec.siteName);
    r.sites.set(key, (r.sites.get(key) || 0) + 1);
  }
  for (const o of state.orders) {
    const rid = normId(o.rid);
    if (!rid || rid === "0") continue;
    const r = riderOf(rid);
    if (o.rname && !r.name) r.name = o.rname;
    if (!r.sites.size) {
      const key = normId(o.teamId) + "\u0001" + str(o.siteName);
      r.sites.set(key, (r.sites.get(key) || 0) + 1);
    }
  }
  for (const r of map.values()) {
    let best = "", bestN = -1;
    for (const [k, n] of r.sites) if (n > bestN) { bestN = n; best = k; }
    const [teamId, siteName] = best ? best.split("\u0001") : ["", ""];
    r.teamId = teamId; r.siteName = siteName;
    r.area = areaOf(teamId, siteName);
  }
  return map;
}
/** 记录（出勤行 / 坏单）→ 当前维度下的行实体键（与 entityRows 的 key 一一对应）。 */
function entityKeyOf(rec) {
  const d = state.dim;
  if (d === "agency") return "__AGENCY__";
  if (d === "area") return "A|" + areaOf(rec.teamId, rec.siteName);
  if (d === "site") return "S|" + (normId(rec.teamId) || normId(rec.siteName));
  return "R|" + normId(rec.rid);          // rider
}
/** 按行实体分组的炸班次矩阵：Map(key -> Map(day -> {fails:Map(班次->人数), sched, unk, list}))。 */
function shiftMatrix() {
  const cells = new Map();
  for (const r of state.recs) {
    const ek = entityKeyOf(r);
    let m = cells.get(ek);
    if (!m) cells.set(ek, m = new Map());
    let c = m.get(r.day);
    if (!c) m.set(r.day, c = { fails: new Map(), sched: 0, unk: 0, list: [] });
    c.sched++;
    const ok = recOk(r);        // 全天按可编辑标准判定，其它班次采信系统标记
    if (ok === 0) c.fails.set(r.per, (c.fails.get(r.per) || 0) + 1);
    else if (ok === -1) c.unk++;
    if (r.t0) c.t0 = true;      // v3.53.0：T0 单元格即便已有炸班，也保留「统计中」提示
    c.list.push(r);
  }
  return cells;
}
/** 按行实体分组的坏单矩阵：Map(key -> Map(day -> {lgt, complain, negative, early, list}))。
  * 一个订单命中多个标签时每个标签各计一次（用户口径）。 */
function badMatrix() {
  const cells = new Map();
  for (const o of state.orders) {
    if (!(o.lgt || o.complain || o.negative || o.early)) continue;
    const ek = entityKeyOf(o);
    let m = cells.get(ek);
    if (!m) cells.set(ek, m = new Map());
    let c = m.get(o.day);
    if (!c) m.set(o.day, c = { lgt: 0, complain: 0, negative: 0, early: 0, list: [] });
    for (const [k] of BAD_COLS) if (o[k]) c[k]++;
    c.list.push(o);
  }
  return cells;
}

// ---------------------------------------------------------------- 渲染
/** 炸班次单元格：只显示炸掉的班次（红，一行一个，含全天按系统标记）；
 *  同一班次炸的人数 > 1 时显示「班次*n」（人数降序）；空白 = 全部达成或无排班；
 *  实时快照缺「是否达成」列时显示琥珀「统计中」。 */
function shiftCellHtml(c) {
  if (!c) return "";
  let html = "";
  const fails = [...c.fails.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  for (const [per, n] of fails) html += `<span class="qf">${esc(per)}${n > 1 ? "*" + n : ""}</span>`;
  // 历史日期有炸班时只显示炸班（沿用旧表现）；T0 还要保留「进行中班次统计中」提示
  if (c.unk > 0 && (!html || c.t0)) html += '<span class="qu">统计中</span>';
  return html;
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
/** v3.52.0：标题里显示骑手维度的过滤统计，让「只显示问题骑手」可见可核对。 */
function titleHtml(month, b) {
  const viewName = state.view === "shift" ? "炸班次" : "坏单";
  const dimName = { agency: "整商", area: "商圈片", site: "站点", rider: "骑手" }[state.dim];
  const rs = state.dim === "rider" ? state.riderStats : null;
  const lastDay = shiftDayMax(month, b);
  return `${esc(viewName)}矩阵 · <b>${esc(dimName)}</b>` +
    ` <span class="ql-sub">${esc(month)}（1 ~ ${lastDay} 日）· ${esc(dimName)}维度` +
    ` · 出勤明细 ${state.recs.length} 行 · 坏单 ${state.orders.length} 单` +
    (state.view === "shift" ? ` · 全天标准 ${esc(allDayLabel())}` : "") +
    (state.month === curMonth() && state.t0Info && state.view === "shift"
      ? ` · <b class="ql-stat">T0 已结束 ${state.t0Info.ended} 班 / 进行中 ${state.t0Info.ongoing} 班 · 全天${state.t0Info.allDay ? "开" : "关"}</b>` : "") +
    (rs ? ` · <b class="ql-stat">骑手共 ${rs.total} 名 / 只显示 ${rs.shown} 名问题骑手 / 隐藏 ${rs.hidden} 名</b>` : "") +
    ` · ${state.fromShared ? "运力模块缓存" : "独立取数"}</span>`;
}
function renderAll() {
  const month = state.month;
  const b = monthBounds(month);
  // 提前算骑手行，让标题能显示过滤统计（renderMatrixTable 复用同一份，不重复聚合）
  const preRows = state.dim === "rider" ? entityRows() : null;
  $("ql-title").innerHTML = titleHtml(month, b);
  const wrap = $("matrix-wrap");
  if (!state.recs.length && !state.orders.length) {
    wrap.innerHTML = `<div class="ql-pop-empty">${esc(state.attErr || state.kpiErr || state.teamErr || "本月暂无数据")}</div>`;
    renderFoot();
    return;
  }
  renderMatrixTable(wrap, month, b, preRows);
  if (state.dim === "rider") $("ql-title").innerHTML = titleHtml(month, b);  // 二次过滤后刷新统计
  renderFoot();
}
/** 单元格的汇总数量：炸班次 = 炸掉的班次数；坏单 = 各类型标签数之和。 */
function cellCount(c, isShift) {
  if (!c) return 0;
  if (isShift) { let n = 0; for (const v of c.fails.values()) n += v; return n; }
  return BAD_COLS.reduce((n, [k]) => n + (c[k] || 0), 0);
}
/** 行主体随维度变化的日期矩阵：行 = 行实体（首列冻结），列 = 本月日期 + 本月合计；
 *  表尾再加一行「合计」（每个日期的全维度汇总）。 */
let lastRows = [];          // 供点击弹层按行键查行名
function renderMatrixTable(wrap, month, b, preRows) {
  const rows = preRows || entityRows();
  lastRows = rows;
  const mat = state.view === "shift" ? shiftMatrix() : badMatrix();
  const isShift = state.view === "shift";
  const emptyHtml = state.dim === "rider"
    ? `<div class="ql-pop-empty">本月没有${isShift ? "炸班" : "坏单"}的骑手</div>`
    : '<div class="ql-pop-empty">本月暂无数据</div>';
  if (!rows.length) { wrap.innerHTML = emptyHtml; return; }
  const maxDay = isShift ? shiftDayMax(month, b) : b.maxDay;
  if (!maxDay) {
    wrap.innerHTML = '<div class="ql-pop-empty">本月还没有 T+1 结算的日期，明天再来看炸班次</div>';
    return;
  }
  const mn = Number(month.slice(5, 7));
  const headLabel = { agency: "整商", area: "商圈片", site: "站点", rider: "骑手姓名" }[state.dim];
  const sumName = isShift ? "炸班合计" : "坏单合计";
  let html = `<table class="ql-tbl"><thead><tr><th class="lft ql-rider">${esc(headLabel)}</th>`;
  for (let d = 1; d <= maxDay; d++) html += `<th title="${esc(month)}-${padDay(d)}">${mn}月${d}日</th>`;
  html += `<th class="ql-sum-col" title="该行本月汇总数量">${esc(sumName)}</th></tr></thead><tbody>`;
  const dayTotals = new Array(maxDay + 1).fill(0);
  let grand = 0, renderedRows = 0;
  for (const rd of rows) {
    const m = mat.get(rd.key);
    let cells = "", rowSum = 0;
    const perDay = new Array(maxDay + 1).fill(0);
    for (let d = 1; d <= maxDay; d++) {
      const ymd = `${month}-${padDay(d)}`;
      const c = m && m.get(ymd);
      const body = isShift ? shiftCellHtml(c) : badCellHtml(c);
      const n = cellCount(c, isShift);
      rowSum += n; perDay[d] = n;
      const has = isShift ? (c && (c.fails.size || c.unk)) : (c && c.list.length);
      cells += `<td class="ql-cell${has ? " clickable" : ""}"${has ? ` data-key="${esc(rd.key)}" data-day="${ymd}" title="点击看 ${esc(rd.name)} ${ymd} 的${isShift ? "班次" : "坏单"}明细"` : ""}>${body}</td>`;
    }
    // v3.52.0 渲染层双保险：骑手维度整月合计为 0 的行一律不渲染，
    // 保证矩阵里出现的每一行在当前视图都确实有问题（无空白占位行）。
    if (state.dim === "rider" && rowSum === 0) continue;
    renderedRows++;
    for (let d = 1; d <= maxDay; d++) dayTotals[d] += perDay[d];
    grand += rowSum;
    html += `<th class="lft ql-rider"><span class="qr-name">${esc(rd.name)}</span>` +
      `<span class="qr-sub">${esc(rd.sub || "")}</span></th>`;
    html += cells;
    html += `<td class="ql-cell ql-sum${rowSum ? " clickable" : ""}"${rowSum ? ` data-key="${esc(rd.key)}" data-day="" title="点击查看 ${esc(rd.name)} 整月明细"` : ""}>` +
      `<span class="qs">${rowSum || "—"}</span></td>`;
    html += "</tr>";
  }
  if (!renderedRows) { wrap.innerHTML = emptyHtml; return; }
  // 表尾合计行：每日期的全维度汇总 + 总计
  html += `<tr class="ql-total-row"><th class="lft ql-rider"><span class="qr-name">合计</span>` +
    `<span class="qr-sub">${esc(isShift ? "炸班次数" : "坏单标签数")}</span></th>`;
  for (let d = 1; d <= maxDay; d++) html += `<td class="ql-cell"><span class="qs">${dayTotals[d] || "—"}</span></td>`;
  html += `<td class="ql-cell ql-sum ql-grand"><span class="qs">${grand || "—"}</span></td></tr>`;
  html += "</tbody></table>";
  wrap.innerHTML = html;
  // 二次过滤后回写真实显示/隐藏数量，供标题展示
  if (state.dim === "rider" && state.riderStats) {
    state.riderStats.shown = renderedRows;
    state.riderStats.hidden = Math.max(0, state.riderStats.total - renderedRows);
  }
}
function renderFoot() {
  const isCur = state.month === curMonth();
  $("ql-foot").innerHTML =
    "行随维度切换：整商 = 全部数据汇总成一行；商圈片 / 站点 = 每个商圈片 / 站点一行（副标题为站点数 / 所属商圈片）；" +
    "骑手 = <b>只显示当前视图本月确实有问题的骑手</b>：炸班次视图 = 整月有炸班，坏单视图 = 整月有坏单；" +
    "全达成 / 无坏单的骑手一律不显示（标题给出「共 N 名 / 只显示 M 名 / 隐藏 X 名」可直接核对），" +
    "名下站点 = 该骑手本月班次最多的站点；" +
    "<b>骑手行按整月汇总排序</b>：当前视图的「本月合计」从多到少，相同则按另一视图的合计从多到少（炸班次↔坏单），" +
    "副标题同时显示该骑手整月炸班次数 / 坏单标签数。列 = 本月日期。<br>" +
    "炸班次 = 出勤统计「导出明细数据」的骑手 × 时段明细（本月按 7 天分段）+ 当天 T0 实时考勤快照；" +
    "<b>历史日期（T+1 结算）</b>采信系统「是否达成」标记、全天走可编辑标准；" +
    "<b>今天 T0 参考「出勤达成」的方法</b>：只统计<b>已结束</b>的班次（与 ASSESS.PERIOD_DEFS 同一套时段结束时间），" +
    "用「有效在线时长 ≥ 时段标准 且 完单量 ≥ 时段标准」双门槛判定、不采信系统标记；" +
    "未结束 / 整班次数据还没跑出来的显示琥珀「统计中」、<b>不算炸班</b>；" +
    "T0「全天」默认不参与判定（一天没过完，18单/6小时判不准），工具条「T0 全天」开关可临时打开仅供参考，" +
    "标题给出「T0 已结束 N 班 / 进行中 M 班」。只统计「是否排班 = 排班」的班次；" +
    "红字 = 当天炸掉的班次（同一班次炸多人显示「班次*n」，人数降序）。" +
    `<b>「全天」单独定义、不采信系统「是否达成」标记</b>：完单量 ≥ ${state.allDay.orders} 单 <b>且</b> 有效在线时长 ≥ ${state.allDay.hours} 小时才算达标，否则计为炸班 —— 工具条「全天标准 <b>${esc(allDayLabel())}</b>」可编辑、本机记忆，改完立即重算；其余班次仍按系统标记。` +
    "空白 = 全部达成或无排班；历史明细缺达成标记、T0 未结束 / 数据未出时显示琥珀「统计中」（不算炸班）；" +
    "点击单元格看该行当天的排班班次明细（骑手 / 班次 / 完单量 / 有效在线）。<br>" +
    "坏单 = KPI 考核运单明细 4 类问题订单筛选，另用申诉 / 违规明细（违规状态=成立、分类=差评+投诉）" +
    "的运单号去重后逗号拼接<b>回查匹配</b>考核运单明细，两路按运单去重；" +
    "<b>坏单标签与数量一律以考核运单明细的 4 个「是否XX单」列为准</b> —— 申诉明细的违规分类本身不算标签，" +
    "回查命中但 4 列全「否」的单不计入坏单（避免虚高）；一个订单命中多个标签时每个标签单独计算。与运力模块同口径；" +
    "红字「类型*N」 = 当天各类型坏单数，点击单元格看运单明细。" +
    "右侧「本月合计」= 该行整月汇总数量（点击看整月明细），表尾「合计」= 每个日期的全维度汇总；" +
    "数据优先复用运力模块已取到的整月明细（同源缓存，零重复请求），点「立即刷新」强制重拉；" +
    "缓存只含 T+1 历史明细；T0 实时快照只存内存、绝不写入缓存。" +
    (isCur ? "今天（T0）按出勤达成口径显示已结束班次的炸班，次日 T+1 结算后由历史明细覆盖。" : "");
}

// ---------------------------------------------------------------- 详情弹层
let lastPopTitle = "", lastPopHtml = "";
function openPop(title, tableHtml) {
  lastPopTitle = title; lastPopHtml = tableHtml;
  $("ql-pop-title").textContent = title;
  $("ql-pop-body").innerHTML = tableHtml;
  const mask = $("ql-pop-mask");
  mask.hidden = false;
  // v3.46.0：面板 iframe 里浮层可能被宿主裁剪 —— 尺寸为 0 时自动在独立标签打开明细
  try {
    const r = $("ql-pop").getBoundingClientRect();
    if (window.top !== window.self && (!r.width || !r.height)) {
      mask.hidden = true; popInNewTab(); return;   // 仅面板 iframe 内自动兜底
    }
  } catch (e) { /* 测试环境无布局 */ }
}
function closePop() { $("ql-pop-mask").hidden = true; }
/** 弹层兜底：把明细表写到独立标签页（iframe 内弹窗失败时也能看）。 */
function popInNewTab() {
  if (typeof window.open !== "function") return;      // 离线测试桩无窗口 API
  const w = window.open("", "_blank");
  if (!w) {
    showNotice("浏览器拦截了新标签，请允许弹窗，或点面板右上角「↗ 新标签打开」后再点单元格。");
    return;
  }
  const css = "body{font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;padding:22px;color:#1F2937}" +
    "h2{font-size:16px;margin:0 0 14px}table{border-collapse:collapse;width:100%;font-size:12px}" +
    "th,td{border:1px solid #EEF0F3;padding:5px 8px;text-align:center}th{background:#FAFBFD;font-weight:600}" +
    "td.lft,th.lft{text-align:left}.mk{display:inline-block;padding:0 8px;border-radius:8px;font-size:12px;font-weight:600}" +
    ".mk.yes{background:#E7F6EC;color:#15803D}.mk.no{background:#FDECEC;color:#C22F2F}.mk.tp{background:#EEF2FF;color:#4338CA}" +
    ".ql-pop-note{margin-top:8px;font-size:12px;color:#6B7280}";
  w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<title>${esc(lastPopTitle)}</title><style>${css}</style></head><body>` +
    `<h2>${esc(lastPopTitle)}</h2><div class="ql-pop-body">${lastPopHtml}</div></body></html>`);
  w.document.close();
}
/** 某行某天的班次明细：该实体当天全部排班班次 + 达成标记 + 完单 + 有效在线。 */
function shiftPop(month, key, day) {
  const list = state.recs.filter((r) => entityKeyOf(r) === key && (!day || r.day === day));
  if (!list.length) { openPop(`${day} 班次明细`, '<div class="ql-pop-empty">该日无排班记录</div>'); return; }
  const row = lastRows.find((r) => r.key === key);
  const name = row ? row.name : dimNameCn();
  const showRider = state.dim !== "rider";
  const showSite = state.dim === "agency" || state.dim === "area";
  let html = "<table><thead><tr>";
  if (showRider) html += "<th>骑手</th>";
  if (showSite) html += "<th>站点</th>";
  html += '<th>班次</th><th>是否达成</th><th>完单</th><th class="lft">有效在线</th></tr></thead><tbody>';
  // v3.52.0：问题优先 —— 未达成排最前，其次统计中，最后达成；同类再按班次 / 姓名
  const okRank = (r) => { const v = recOk(r); return v === 0 ? 0 : (v === -1 ? 1 : 2); };
  const ordered = list.slice().sort((a, b) =>
    okRank(a) - okRank(b) || a.per.localeCompare(b.per, "zh-CN") ||
    (a.name || "").localeCompare(b.name || "", "zh-CN"));
  for (const r of ordered) {
    const ok = recOk(r);
    const mk = ok === 1 ? '<span class="mk yes">达成</span>'
      : ok === 0 ? '<span class="mk no">未达成</span>' : '<span class="mk tp">统计中</span>';
    const perCell = r.per === "全天"
      ? `<span title="按自定义全天标准判定">全天<sup class="ql-sup">自定义</sup></span>` : esc(r.per);
    html += "<tr>";
    if (showRider) html += `<td>${esc(r.name || r.rid)}</td>`;
    if (showSite) html += `<td>${esc(r.siteName || areaOf(r.teamId, r.siteName))}</td>`;
    html += `<td>${perCell}</td><td>${mk}</td><td>${int(r.orders)}</td><td class="lft">${esc(r.online || "—")}</td></tr>`;
  }
  html += "</tbody></table>";
  if (list.some((r) => r.per === "全天")) {
    html += `<div class="ql-pop-note">「全天」班次不采信系统「是否达成」标记，按自定义标准判定：` +
      `完单量 ≥ ${state.allDay.orders} 单 <b>且</b> 有效在线时长 ≥ ${state.allDay.hours} 小时为达标，否则计为炸班` +
      `（工具条「全天标准」可修改，当前 ${esc(allDayLabel())}）。</div>`;
  }
  if (list.some((r) => r.t0)) {
    html += `<div class="ql-pop-note">今天（T0）参考「出勤达成」口径：只判已结束班次，` +
      `按「有效在线时长 + 完单量」双门槛达标判定；未结束 / 数据未出显示「统计中」不算炸班；` +
      `全天默认不判（当前${state.t0AllDay ? "已临时打开，仅供参考" : "关闭"}）。</div>`;
  }
  const bad = list.filter((r) => recOk(r) === 0).length;
  openPop(`${name} · ${day || "整月"} 班次明细 · 排班 ${list.length} 班${bad ? ` · 炸 ${bad} 班` : " · 全部达成"}`, html);
}
/** 某行某天的坏单明细：运单ID + 类型标签（多标签全列）。 */
function badPop(month, key, day) {
  const list = state.orders.filter((o) => entityKeyOf(o) === key && (!day || o.day === day) && (o.lgt || o.complain || o.negative || o.early));
  if (!list.length) { openPop(`${day} 坏单明细`, '<div class="ql-pop-empty">该日无坏单记录</div>'); return; }
  const row = lastRows.find((r) => r.key === key);
  const name = row ? row.name : dimNameCn();
  const showRider = state.dim !== "rider";
  let html = "<table><thead><tr><th>日期</th><th class=\"lft\">运单ID</th>";
  if (showRider) html += "<th>骑手</th><th>站点</th>";
  html += '<th class="lft">类型</th></tr></thead><tbody>';
  for (const o of list) {
    const chips = BAD_COLS.filter(([k]) => o[k]).map(([, n]) => `<span class="mk tp">${esc(n)}</span>`).join(" ");
    html += `<tr><td>${esc(o.day)}</td><td class="lft">${esc(o.tid)}</td>`;
    if (showRider) html += `<td>${esc(o.rname || o.rid || "—")}</td><td>${esc(o.siteName || areaOf(o.teamId, o.siteName))}</td>`;
    html += `<td class="lft">${chips || "—"}</td></tr>`;
  }
  html += "</tbody></table>";
  const tags = list.reduce((n, o) => n + BAD_COLS.filter(([k]) => o[k]).length, 0);
  openPop(`${name} · ${day || "整月"} 坏单明细 · ${list.length} 单 / ${tags} 个标签`, html +
    '<div class="ql-pop-note">注：一个订单命中多个标签时，每个标签各单独计算一次。</div>');
}
function badName(k) { const f = BAD_COLS.find(([key]) => key === k); return f ? f[1] : k; }

// ---------------------------------------------------------------- 控件
function setDim(d) {
  state.dim = d;
  for (const b of document.querySelectorAll(".ql-dim")) b.classList.toggle("active", b.dataset.dim === d);
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

// ---------------------------------------------------------------- 全天标准设置（v3.48.0）
function openAllDayCfg() {
  $("cfg-orders").value = state.allDay.orders;
  $("cfg-hours").value = state.allDay.hours;
  $("ql-cfg-mask").hidden = false;
}
function closeAllDayCfg() { $("ql-cfg-mask").hidden = true; }
function saveAllDayCfg(reset) {
  let o, h;
  if (reset) { o = ALLDAY_DEFAULT.orders; h = ALLDAY_DEFAULT.hours; }
  else {
    o = Number($("cfg-orders").value); h = Number($("cfg-hours").value);
    if (!isFinite(o) || o < 0 || o > 200 || !isFinite(h) || h < 0 || h > 24) {
      showNotice("全天标准请输入有效范围：完单量 0~200 单、有效在线时长 0~24 小时。");
      return;
    }
  }
  state.allDay = { orders: Math.round(o), hours: Math.round(h * 10) / 10 };
  try { localStorage.setItem(ALLDAY_LS, JSON.stringify(state.allDay)); } catch (e) { /* 配额不足 */ }
  $("allday-cfg").textContent = allDayLabel();
  closeAllDayCfg();
  if (state.t0Raw && state.t0Raw.length) refreshT0();   // v3.53.0：T0 全天开关打开时同步重算
  renderAll();                 // 只重算矩阵，不重新取数
  showNotice(`全天标准已设为「完单 ≥ ${state.allDay.orders} 单 且 有效时长 ≥ ${state.allDay.hours} 小时」，矩阵已立即重算。`, "blue");
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
  $("btn-refresh").addEventListener("click", () => loadAll(true));   // 强制重拉，跳过运力模块缓存
  $("allday-cfg").textContent = allDayLabel();
  $("btn-allday").addEventListener("click", openAllDayCfg);
  try { $("t0-allday-cfg").textContent = state.t0AllDay ? "开" : "关"; } catch (e) { /* 测试桩 */ }
  $("btn-t0-allday").addEventListener("click", () => {
    toggleT0AllDay();
    try { $("t0-allday-cfg").textContent = state.t0AllDay ? "开" : "关"; } catch (e) { /* 测试桩 */ }
  });
  $("ql-cfg-close").addEventListener("click", closeAllDayCfg);
  $("cfg-reset").addEventListener("click", () => saveAllDayCfg(true));
  $("cfg-save").addEventListener("click", () => saveAllDayCfg(false));
  $("ql-cfg-mask").addEventListener("click", (ev) => { if (ev.target === $("ql-cfg-mask")) closeAllDayCfg(); });
  $("ql-pop-newtab").addEventListener("click", popInNewTab);
  for (const b of document.querySelectorAll(".ql-dim")) b.addEventListener("click", () => setDim(b.dataset.dim));
  for (const b of document.querySelectorAll(".ql-view")) b.addEventListener("click", () => setView(b.dataset.view));
  $("matrix-wrap").addEventListener("click", (ev) => {
    const td = ev.target.closest("td.ql-cell.clickable");
    if (!td || !td.dataset.key || td.dataset.day === undefined) return;
    try {
      if (state.view === "shift") shiftPop(state.month, td.dataset.key, td.dataset.day);
      else badPop(state.month, td.dataset.key, td.dataset.day);
    } catch (e) {
      showNotice("弹窗打开失败（" + (e.message || "未知原因") + "），已尝试在独立标签打开明细；也可点面板右上角「↗ 新标签打开」。");
      popInNewTab();
    }
  });
  $("ql-pop-close").addEventListener("click", closePop);
  $("ql-pop-mask").addEventListener("click", (ev) => { if (ev.target === $("ql-pop-mask")) closePop(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { closePop(); closeAllDayCfg(); }
  });
  setMonth(validMonth($("month-picker").value) ? $("month-picker").value : curMonth());
}

// 测试桩（离线单元回归可用 window.__QL__ 取纯函数）
Object.assign(window.__QL__ = window.__QL__ || {}, {
  state, parseAttSheets, parseBadRows, loadViolationTrackingIds,
  monthBounds, monthSegments, entityRows, shiftMatrix, badMatrix, entityKeyOf,
  areaOf, shiftCellHtml, badCellHtml, requestRL, riderInfoMap,
  readShared, writeShared, cellCount, popInNewTab, renderMatrixTable, titleHtml,
  violationMeta, applyViolationMeta, hasKpiTag, keepKpiTagged, settledRecs, shiftDayMax,
  T0_PERIODS, t0Ongoing, applyT0Verdict, refreshT0, loadT0, toggleT0AllDay,
  parseHours, allDayVerdict, recOk, loadAllDayCfg, saveAllDayCfg, openAllDayCfg, closeAllDayCfg,
  allDayLabel, ALLDAY_DEFAULT, ALLDAY_LS,
  API_ATT_DETAIL, API_ATT_LIVE, API_TEAMS, API_KPI_DETAIL, API_VIOLATION,
  SITE_TO_AREA, KPI_FILTERS, KPI_COLS, BAD_COLS, VIOL_SEG_DAYS, VIOL_BATCH,
  setDim, setView, setMonth, loadAll, renderAll, shiftPop, badPop
});

// v3.48.1：面板 iframe 内脚本已加载 → 回报宿主「READY」；宿主 3 秒没收到就说明
// 扩展页被浏览器/其它扩展拦截（例如显示「此页面已被屏蔽」），会给出新标签/重试兜底。
// 独立标签页、离线测试桩下 parent 不可用，静默跳过。
try {
  if (typeof window.parent !== "undefined" && window.parent !== window.self &&
      typeof window.parent.postMessage === "function") {
    window.parent.postMessage({ __wbAssess: true, type: "READY" }, "*");
  }
} catch (e) { /* ignore */ }

boot();
