/* 物资租用（v3.21.0，第五个独立入口；v3.22.0 加表格导入批量执行 + 本月可绑定导出）
 *
 * 复刻原 FengshenMonitor「物资租用登记」：站点 → 物资类型（电动车 / 住宿）→ 骑手 → 开始/结束日期。
 * 数据源（全部沿用原插件接口，不新增后端）：
 *   getTeamsAll                 站点列表
 *   knightRentPizza.queryRentType       物资类型 [{id,name}]
 *   knightRentPizza.queryTeamKnightInfo 站点骑手 [{teamId,knightId,knightName,mobile}]
 *   knightRentPizza.createRent          登记，固定 rentType=2
 *   ehr/staff/knight/list       人资名单（departmentId=站点 id），带 entryTime / leaveTime / workStatus
 *   knightRentPizza.queryList   已有租用单（queryType=2），带 knightId / categoryId / startTime / endTime
 *
 * 租用登记与「装备领用」的区别：领用走 rentType=1、只有 startTime、需要 typeId+categoryId；
 * 租用走 rentType=2、有 startTime + endTime、只需要 categoryId。这里只做租用。
 *
 * 提交会真实写入租用单：单条与批量都先二次确认；批量每条间隔 150ms，
 * 成功 / 失败逐条记入本机「最近提交」，方便事后核对。所有取数与提交都走
 * 「直连优先、失败切静默桥接」的既有双通道，不写任何共享缓存。
 *
 * v3.22.0 两个新增：
 *   1) 批量执行（表格导入）：CSV / XLSX / 直接粘贴都能识别，逐行匹配骑手与物资类型，
 *      预览里标出每行的校验结果，只执行通过的行。模板表头固定 7 列。
 *   2) 本月可绑定日期：用「人资名单的入职 / 离职时间 × 本月日历」算出每位骑手哪天能绑定
 *      （入职前、离职后、早于 T-6 都不能绑），页面画条形图，另可导出日历矩阵 / 逐日明细 CSV。
 *
 * v3.23.0 两条业务规则：
 *   1) 同一骑手 + 同一物资类型的租用单**区间不能重叠**：新单起始日必须 > 已有单结束日
 *      （例：已有 11-01~11-03，则新单最早 11-04 开始）。数据源是风神物资租用页的
 *      queryList/1.0（queryType=2），逐条 / 批量 / 表格导入 / 可绑定日历四处共用同一套校验。
 *   2) 可绑定窗口由「今天起」放宽到「T-6 起」（可补登记最近 6 天），但入职前 / 离职后仍不可绑。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const API_TYPES = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryRentType/1.0";
const API_KNIGHTS = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryTeamKnightInfo/1.0";
const API_CREATE = XT + "xtop.knight.task.mng.growth.knightRentPizza.createRent/1.0";
const API_RENT_LIST = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryList/1.0";
const API_STAFF = "https://app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list";

const RENT_TYPE = 2;                 // 2 = 物资租用（1 = 装备领用，本页不用）
const QUERY_TYPE = 2;                // queryList 的 queryType：2=租用记录，1=装备领用
const BATCH_GAP_MS = 150;            // 批量提交间隔，与原插件一致
const STAFF_PAGE_SIZE = 500;         // 人资名单每页条数（运力模块实测可用）
const STAFF_MAX_PAGES = 6;           // 单站点最多翻 6 页 = 3000 人，防异常翻页
const RENT_PAGE_SIZE = 500;          // 已有租用单每页条数（实测 500 可用）
const RENT_MAX_PAGES = 20;           // 最多 20 页 = 10000 条
const BIND_BACK_DAYS = 6;            // 可补登记窗口：T-6 起（含）到未来
const IMPORT_MAX_ROWS = 200;         // 一次导入最多执行 200 行
const LS_SITE = "wb_rent_site";
const LS_HISTORY = "wb_rent_history";
const LS_BIND = "wb_rent_bind";
const LS_DEDUCT = "wb_rent_deduct";
const HISTORY_MAX = 100;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateStrOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStrOf(new Date());
const shiftDate = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return dateStrOf(new Date(y, m - 1, d + days));
};
const hhmm = (d) => d.toTimeString().slice(0, 5);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 把各种写法归一成 YYYY-MM-DD：2026-11-01 / 2026/11/1 / 2026.11.1 / 20261101 /
 *  2026-11-01 00:00:00 / Excel 序列号（45000 这种）。认不出来返回空串。 */
function ymd(v) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  let m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s);
  if (m) {
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return `${m[1]}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    }
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {           // Excel 日期序列号
    const n = Math.round(Number(s));
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return "";
}
const curMonth = () => todayStr().slice(0, 7);
/** 最早可登记日 = 今天往前 BIND_BACK_DAYS 天（含当天） */
const earliestBindDate = (today) => shiftDate(today || todayStr(), -BIND_BACK_DAYS);
/** 服务端时间戳（毫秒）→ 本地时区的 YYYY-MM-DD；createRent 也是按本地时区写 T00:00:00 / T23:59:59 */
const ymdFromTs = (ms) => {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? dateStrOf(d) : "";
};
/** 某月全部日期（YYYY-MM-DD 数组） */
function monthDays(month) {
  const [y, m] = String(month || curMonth()).split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return out;
}
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const weekdayOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY[new Date(y, m - 1, d).getDay()];
};

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  teams: [], types: [], knights: [],
  siteId: localStorage.getItem(LS_SITE) || "",
  siteName: "",
  selected: new Set(),
  history: [],
  submitting: false,
  loading: false,
  errors: [],
  finishedAt: null,
  roster: [],                 // 当前站点人资名单（含离职），带 entry / leave
  rosterAt: null,
  rosterErr: "",
  rosterLoading: false,
  rosterSeq: 0,               // 站点切换防串号：只认最后一次请求的结果
  rents: [],                  // 服务端已有租用单 [{knightId,categoryId,typeName,start,end,teamId,teamName}]
  rentsAt: null,
  rentsErr: "",
  rentsLoading: false,
  rentsSeq: 0,
  bindMonth: curMonth(),
  bindScope: "site",
  bindType: "all",            // all / 10001 / 10002：可绑定日历按哪种物资类型算占用
  bindLeft: false,
  bindRowsCache: [],
  importRows: [],             // [{line,name,mobile,knightId,...,res:{ok,err,...},done,result}]
  importName: "",
  deductType: "",             // 按金额反算：整批统一的物资类型
  deductFees: {},             // { typeId: 月扣款 }，按类型分别记忆
  deductInput: "",
  deductRows: [],             // 预览 / 执行结果行
  deductSubmitting: false,
  deductCaps: {}              // { item: 单项封顶元, total: 合计封顶元 }，本机记忆
};

function extMsg(msg) {
  try { return chrome.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}

// ---------------------------------------------------------------- 双通道请求
async function bridgeApi(api, payload) {
  const resp = await extMsg({ type: "BRIDGE_API", api, payload });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}
/** 直连优先；CORS / 登录态 / 网络失败自动切静默桥接。测试可用 __RENT_MOCK__ 完全接管。 */
async function postApi(api, payload) {
  if (typeof window.__RENT_MOCK__ === "function") return await window.__RENT_MOCK__(api, payload);
  if (state.via === "bridge") return await bridgeApi(api, payload);
  try {
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      credentials: "include",
      referrerPolicy: "unsafe-url",
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return await bridgeApi(api, payload);
  }
}
const okJson = (j) => !!j && String(j.code) === "200" && (!j.result || String(j.result.code) === "200");
const dataOf = (j) => (j && j.result ? (j.result.data == null ? j.result : j.result.data) : null);
const msgOf = (j) => (j && j.result && (j.result.msg || j.result.message)) || (j && j.msg) || "未知错误";

/** GET 类接口（人资名单）走 BRIDGE_GET；直连优先，失败切静默桥接。 */
async function getApi(url) {
  if (typeof window.__RENT_GET_MOCK__ === "function") return await window.__RENT_GET_MOCK__(url);
  if (state.via === "bridge") return await bridgeGet(url);
  try {
    const r = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return await bridgeGet(url);
  }
}
async function bridgeGet(url) {
  const resp = await extMsg({ type: "BRIDGE_GET", api: url });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}

// ---------------------------------------------------------------- 取数
async function loadTeams() {
  const j = await postApi(API_TEAMS, { params: {} });
  if (!okJson(j)) throw new Error("站点列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: String(x.id == null ? x.teamId : x.id),
    name: String(x.team_name || x.teamName || x.name || ("站点 " + (x.id == null ? x.teamId : x.id)))
  })).filter((x) => x.id && x.id !== "undefined" && x.id !== "null");
}
async function loadTypes() {
  const j = await postApi(API_TYPES, { params: {} });
  if (!okJson(j)) throw new Error("物资类型：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.id), name: String(x.name || x.id)
  })).filter((x) => x.id > 0);
}
async function loadKnights(siteId) {
  const j = await postApi(API_KNIGHTS, {
    params: { goodsBusinessRentKnightInfoDto: { teamId: num(siteId) } }
  });
  if (!okJson(j)) throw new Error("骑手列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.knightId),
    name: String(x.knightName || ""),
    mobile: String(x.mobile || ""),
    teamId: num(x.teamId) || num(siteId)
  })).filter((x) => x.id > 0);
}
/** 人资名单（成员管理 · 全部状态）：departmentId 就是站点 id，返回带入职 / 离职时间。
 *  同一骑士可能有多条记录（换站 / 复职），按 knightId 去重，优先在职、再取最晚入职。 */
async function loadRoster(teamId, teamName) {
  const out = [];
  for (let p = 1; p <= STAFF_MAX_PAGES; p++) {
    const url = `${API_STAFF}?pageIndex=${p}&pageSize=${STAFF_PAGE_SIZE}&departmentId=${encodeURIComponent(teamId)}`;
    const j = await getApi(url);
    const code = String((j && (j.code || j.err_code)) || "");
    if (code !== "200") throw new Error("人资名单：" + ((j && j.msg) || "接口返回异常"));
    const d = (j && j.data) || {};
    const list = Array.isArray(d.list) ? d.list : [];
    out.push(...list);
    if (!list.length || list.length < STAFF_PAGE_SIZE || (num(d.count) && out.length >= num(d.count))) break;
  }
  const byId = new Map();
  for (const x of out) {
    const id = num(x.knightId || x.id);
    if (!(id > 0)) continue;
    const rec = {
      id,
      name: String(x.staffName || x.knightName || ""),
      mobile: String(x.mobile || ""),
      entry: ymd(x.entryTime),
      leave: ymd(x.leaveTime),
      status: num(x.workStatus) === 1 ? "在职" : (ymd(x.leaveTime) ? "已离职" : "其他"),
      teamId: String(teamId),
      teamName: String(teamName || "")
    };
    const prev = byId.get(id);
    if (!prev) { byId.set(id, rec); continue; }
    const better = (rec.status === "在职" && prev.status !== "在职") ||
      (rec.status === prev.status && rec.entry > prev.entry);
    if (better) byId.set(id, rec);
  }
  return [...byId.values()];
}
/** 已有租用单：物资租用页的「查询」接口。queryType=2 = 租用记录（1 = 装备领用）。
 *  teamIds 支持一次传多个站点；分页 pageSize=500 实测可用。 */
async function loadRents(teamIds) {
  const ids = (teamIds || []).map(num).filter((x) => x > 0);
  const out = [];
  let seen = 0;
  for (let p = 1; p <= RENT_MAX_PAGES; p++) {
    const j = await postApi(API_RENT_LIST, {
      params: {
        goodsBusinessRentQueryDto: {
          page: p, pageSize: RENT_PAGE_SIZE, teamIds: ids, queryType: QUERY_TYPE
        }
      }
    });
    if (!okJson(j)) throw new Error("已有租用单：" + msgOf(j));
    const d = (j && j.result && j.result.data) || {};
    const list = Array.isArray(d.goodsBusinessRentRecordDtos) ? d.goodsBusinessRentRecordDtos : [];
    seen += list.length;
    for (const x of list) {
      if (num(x.rentType) !== RENT_TYPE) continue;      // 只认租用，装备领用不参与
      if (!(num(x.startTime) > 0) || !(num(x.endTime) > 0)) continue;  // 脏数据（0 / 空时间戳）
      const start = ymdFromTs(x.startTime), end = ymdFromTs(x.endTime);
      if (!start || !end || start > end) continue;
      out.push({
        id: num(x.id), knightId: num(x.knightId), knightName: String(x.knightName || ""),
        categoryId: num(x.categoryId), typeName: String(x.categoryName || typeName(x.categoryId)),
        start, end, num: num(x.num), status: num(x.status),
        teamId: String(x.teamId || ""), teamName: String(x.teamName || ""),
        local: false
      });
    }
    if (!list.length || list.length < RENT_PAGE_SIZE || (num(d.total) && seen >= num(d.total))) break;
  }
  return out;
}
/** 站点切换 / 刷新后重拉已有租用单；失败只影响防重叠校验，不挡登记表单。 */
async function loadRentsInto() {
  if (!state.siteId) return [];
  if (window.__WB_TEST__ && !window.__RENT_NET_TEST__) return state.rents;
  const seq = ++state.rentsSeq;
  state.rentsLoading = true;
  state.rentsErr = "";
  renderBind();
  let list = [], err = "";
  // 页面上的防重叠校验只按当前站点取数；「全部站点」导出会另外拉全量，不写进这里
  const ids = [num(state.siteId)];
  try { list = await loadRents(ids); }
  catch (e) { err = String(e && e.message ? e.message : e); }
  if (seq !== state.rentsSeq) return state.rents;
  state.rents = list;
  state.rentsErr = err;
  state.rentsAt = new Date();
  state.rentsLoading = false;
  renderBind();
  return state.rents;
}
/** 提交成功后本地立即并入，保证同一批导入里后面的行也能看到刚提交的单。 */
function addLocalRent(knightId, categoryId, start, end, n, knightName, typeNameStr) {
  const rec = {
    id: 0, knightId: num(knightId), knightName: String(knightName || ""),
    categoryId: num(categoryId), typeName: String(typeNameStr || typeName(categoryId)),
    start, end, num: num(n), status: 2,
    teamId: String(state.siteId), teamName: String(state.siteName || ""),
    local: true
  };
  state.rents.push(rec);
  return rec;
}

// ---------------------------------------------------------------- 防重叠（纯函数，四处共用）
const dayDiff = (a, b) => {
  const [ay, am, ad] = String(a).split("-").map(Number);
  const [by, bm, bd] = String(b).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
};
const sameRentKey = (r, knightId, categoryId) =>
  Number(r.knightId) === Number(knightId) && Number(r.categoryId) === Number(categoryId);
/** 区间重叠：[start,end] 与已有单 [r.start,r.end] 只要有公共日期就算重叠，
 *  所以已有 11-01~11-03 时，新单 start=11-03 也算冲突，必须 11-04 起。 */
function findOverlap(knightId, categoryId, start, end, pool) {
  return (pool || []).filter((r) => sameRentKey(r, knightId, categoryId)
    && r.start && r.end && !(end < r.start || start > r.end));
}
/** 给出能容纳同样天数、且不与任何已有单/批内已计划单重叠的最早起始日（不早于 T-6）。 */
function suggestStart(knightId, categoryId, start, end, pool) {
  const span = Math.max(1, dayDiff(start, end) + 1);
  const minDate = earliestBindDate();
  let s = start < minDate ? minDate : start;
  for (let guard = 0; guard < 400; guard++) {
    const e = shiftDate(s, span - 1);
    const hit = (pool || []).find((r) => sameRentKey(r, knightId, categoryId)
      && r.start && r.end && !(e < r.start || s > r.end));
    if (!hit) return s;
    s = shiftDate(hit.end, 1);
  }
  return "";
}
function overlapText(hits, suggested, typeNameStr) {
  const first = hits[0] || {};
  const range = first.start ? `${first.start}~${first.end}` : "已有单";
  return `与已有 ${typeNameStr || ""} 单重叠（${range}${hits.length > 1 ? ` 等 ${hits.length} 张` : ""}）` +
    (suggested ? `，最早可从 ${suggested} 开始` : "");
}
/** 站点接口失败时的兜底：复用看板记住的站点 ID，至少还能切换（名称显示为 ID）。 */
function fallbackTeams() {
  try {
    const arr = JSON.parse(localStorage.getItem("wb_team_ids_v1") || "[]");
    return (Array.isArray(arr) ? arr : []).map((id) => ({ id: String(id), name: "站点 " + id }));
  } catch (e) { return []; }
}

// ---------------------------------------------------------------- 渲染
function currentTeam() {
  return state.teams.find((t) => String(t.id) === String(state.siteId)) || null;
}
function currentKnight(id) {
  return state.knights.find((k) => Number(k.id) === Number(id)) || null;
}
function typeName(id) {
  const t = state.types.find((x) => Number(x.id) === Number(id));
  return t ? t.name : String(id || "");
}
function showMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "rent-msg" + (kind ? " " + kind : "");
}
function showNotice(text, kind) {
  const el = $("notice");
  if (!el) return;
  el.textContent = text || "";
  el.className = "notice" + (kind === "bad" ? "" : " blue");
  el.hidden = !text;
}
function renderSites() {
  const sel = $("site-select");
  if (!sel) return;
  if (!state.teams.length) {
    sel.innerHTML = `<option value="">未取到站点</option>`;
    return;
  }
  sel.innerHTML = state.teams.map((t) =>
    `<option value="${esc(t.id)}"${String(t.id) === String(state.siteId) ? " selected" : ""}>${esc(t.name)}</option>`
  ).join("");
}
function renderTypes() {
  const opts = state.types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  for (const id of ["one-type", "batch-type", "deduct-type"]) {
    const el = $(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = opts || `<option value="">未取到物资类型</option>`;
    if (prev && state.types.some((t) => String(t.id) === String(prev))) el.value = prev;
  }
  const dt = $("deduct-type");
  if (dt && state.deductType && state.types.some((t) => String(t.id) === String(state.deductType))) {
    dt.value = String(state.deductType);
  }
  const bt = $("bind-type");
  if (bt) {
    bt.innerHTML = `<option value="all">全部物资</option>` + opts;
    bt.value = state.bindType === "all" || state.types.some((t) => String(t.id) === String(state.bindType))
      ? String(state.bindType) : "all";
  }
}
function knightLabel(k) {
  return k.name + (k.mobile ? " · " + k.mobile : "") + "（" + k.id + "）";
}
function renderKnightSelect() {
  const sel = $("one-knight");
  if (!sel) return;
  const q = String($("one-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  const prev = sel.value;
  sel.innerHTML = `<option value="">请选择骑手（${list.length} 人）</option>` +
    list.map((k) => `<option value="${k.id}">${esc(knightLabel(k))}</option>`).join("");
  if (prev && list.some((k) => String(k.id) === String(prev))) sel.value = prev;
}
function renderBatchList() {
  const box = $("batch-list");
  if (!box) return;
  const q = String($("batch-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="rent-empty">${state.knights.length ? "没有匹配的骑手" : "当前站点暂无骑手"}</div>`;
    updateBatchCount();
    return;
  }
  box.innerHTML = list.map((k) => {
    const on = state.selected.has(k.id);
    return `<label class="rent-check${on ? " checked" : ""}">` +
      `<input type="checkbox" data-knight-id="${k.id}"${on ? " checked" : ""}>` +
      `<span class="rc-name">${esc(k.name || "未命名")}</span>` +
      `<span class="rc-meta">${esc(k.id)}${k.mobile ? " · " + esc(k.mobile) : ""}</span></label>`;
  }).join("");
  box.querySelectorAll("input[data-knight-id]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = num(inp.dataset.knightId);
      if (inp.checked) state.selected.add(id); else state.selected.delete(id);
      const lab = inp.closest(".rent-check");
      if (lab) lab.classList.toggle("checked", inp.checked);
      updateBatchCount();
    });
  });
  updateBatchCount();
}
function updateBatchCount() {
  const el = $("batch-count");
  if (el) el.textContent = `已选 ${state.selected.size} 人`;
  const btn = $("batch-submit");
  if (btn) btn.disabled = state.submitting || state.selected.size === 0;
}
function renderKpis() {
  const box = $("rent-kpis");
  if (!box) return;
  const ok = state.history.filter((h) => h.ok).length;
  const bad = state.history.length - ok;
  box.innerHTML = [
    ["当前站点", currentTeam() ? currentTeam().name : "—"],
    ["站点数", String(state.teams.length)],
    ["当前站点骑手", String(state.knights.length)],
    ["物资类型", String(state.types.length)],
    ["本机登记成功", String(ok)],
    ["本机登记失败", String(bad)]
  ].map(([k, v]) => `<div class="rent-kpi"><b title="${esc(v)}">${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
}
function renderStatus() {
  const sub = $("sub");
  if (sub) {
    const bits = [];
    if (state.siteName) bits.push("站点 " + state.siteName);
    bits.push("骑手 " + state.knights.length);
    bits.push("物资 " + state.types.length);
    bits.push("更新 " + hhmm(state.finishedAt || new Date()));
    bits.push("已有单 " + state.rents.length);
    bits.push("通道 " + (state.via === "bridge" ? "静默桥接" : "直连"));
    sub.textContent = bits.join(" · ");
  }
  const ch = $("btn-channel");
  if (ch) ch.textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  const foot = $("foot-meta");
  if (foot) {
    foot.textContent = `数据源：getTeamsAll / queryRentType / queryTeamKnightInfo / createRent（rentType=${RENT_TYPE}）` +
      ` / queryList（已有单，queryType=${QUERY_TYPE}） / ehr/staff/knight/list（在职区间）` +
      ` · 生成 ${hhmm(state.finishedAt || new Date())} · 本机记录 ${state.history.length} 条`;
  }
}
function renderHistory() {
  const t = $("history-table");
  if (!t) return;
  const head = `<thead><tr><th style="width:88px">时间</th><th style="width:180px">站点</th>` +
    `<th style="width:150px">骑手</th><th style="width:96px">物资</th><th style="width:60px">数量</th>` +
    `<th style="width:104px">开始</th><th style="width:104px">结束</th><th>结果</th></tr></thead>`;
  const rows = state.history.slice(0, 20);
  const body = rows.length ? rows.map((h) => {
    const d = new Date(h.at);
    const time = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(d)}`;
    return `<tr><td>${esc(time)}</td><td class="name" title="${esc(h.site)}">${esc(h.site)}</td>` +
      `<td class="name" title="${esc(h.knightName)}（${esc(h.knightId)}）">${esc(h.knightName)}</td>` +
      `<td>${esc(h.typeName)}</td><td>${esc(h.num)}</td><td>${esc(h.start)}</td><td>${esc(h.end)}</td>` +
      `<td class="${h.ok ? "ok" : "bad"}" title="${esc(h.msg || "")}">${h.ok ? "成功" : "失败"}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="rent-empty">还没有提交记录</td></tr>`;
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}
// ---------------------------------------------------------------- 本月可绑定日期
const BIND_LABEL = {
  ok: "可绑定", past: "超出补登期", before: "未入职", after: "已离职", busy: "已绑定"
};

/** 单日状态：入职前 / 离职后 / 早于 T-6 / 已有同类型租用单占用，都不可绑定。
 *  离职当日仍算可绑定；busy 是已经展开好的按日占用表。 */
function bindState(rec, day, today, busy) {
  if (rec.entry && day < rec.entry) return "before";
  if (rec.leave && day > rec.leave) return "after";
  if (day < earliestBindDate(today)) return "past";
  if (busy && busy.length) return "busy";
  return "ok";
}
/** 某骑手在所选物资类型下，被已有租用单覆盖的日期 → 占用说明。 */
function busyMapFor(knightId, typeFilter, pool) {
  const map = Object.create(null);
  const tf = String(typeFilter == null ? state.bindType : typeFilter);
  const src = pool || state.rents;
  for (const r of src) {
    if (Number(r.knightId) !== Number(knightId)) continue;
    if (tf !== "all" && String(r.categoryId) !== tf) continue;
    let d = r.start;
    for (let i = 0; i < 400 && d <= r.end; i++) {
      (map[d] = map[d] || []).push(`${r.typeName} ${r.start}~${r.end}`);
      d = shiftDate(d, 1);
    }
  }
  return map;
}
/** 本月与该骑手（所选类型）有关的已有单，用于导出时写清楚为什么不能绑。 */
function rentsInMonth(knightId, days, typeFilter, pool) {
  const first = days[0], last = days[days.length - 1];
  const tf = String(typeFilter == null ? state.bindType : typeFilter);
  return (pool || state.rents).filter((r) => Number(r.knightId) === Number(knightId)
    && (tf === "all" || String(r.categoryId) === tf)
    && r.start <= last && r.end >= first);
}
/** 按人资名单 + 已有租用单算「谁在本月哪天可绑定」。默认只留本月还有可绑定日的人。 */
function computeBind(list, month, includeLeft, typeFilter, pool) {
  const days = monthDays(month);
  const first = days[0], last = days[days.length - 1];
  const today = todayStr();
  const out = [];
  for (const rec of list || []) {
    const inMonth = (!rec.entry || rec.entry <= last) && (!rec.leave || rec.leave >= first);
    if (includeLeft ? !inMonth : false) continue;
    const busy = busyMapFor(rec.id, typeFilter, pool);
    const cells = days.map((d) => bindState(rec, d, today, busy[d]));
    const okDays = days.filter((d, i) => cells[i] === "ok");
    if (!includeLeft && !okDays.length) continue;
    const ownRents = rentsInMonth(rec.id, days, typeFilter, pool);
    out.push({
      ...rec, cells, okDays, busy, ownRents,
      earliest: okDays.length ? okDays[0] : ""
    });
  }
  out.sort((a, b) => b.okDays.length - a.okDays.length || String(a.name).localeCompare(String(b.name), "zh"));
  return out;
}
function bindRows(month, includeLeft, list, typeFilter, pool) {
  return computeBind(list || state.roster, month || state.bindMonth, !!includeLeft,
    typeFilter == null ? state.bindType : typeFilter, pool);
}
function renderBind() {
  const month = state.bindMonth;
  const days = monthDays(month);
  const rows = bindRows(month, state.bindLeft);
  state.bindRowsCache = rows;
  const sum = $("bind-sum");
  if (sum) {
    if (state.rosterLoading) sum.innerHTML = `<span class="rent-msg info">正在读取人资名单…</span>`;
    else if (state.rosterErr) {
      sum.innerHTML = `<span class="rent-msg error">人资名单没取到：${esc(state.rosterErr)}</span>` +
        ` <button id="bind-retry" class="ghost" style="height:24px;padding:0 10px;">重试</button>`;
      const rb = $("bind-retry");
      if (rb) rb.addEventListener("click", () => { loadRosterInto(); loadRentsInto(); });
    } else {
      const okDays = rows.reduce((s, r) => s + r.okDays.length, 0);
      const people = rows.filter((r) => r.okDays.length).length;
      const left = rows.filter((r) => r.leave && r.leave >= todayStr()).length;
      const busy = rows.reduce((s, r) => s + r.cells.filter((c) => c === "busy").length, 0);
      sum.innerHTML = `<b>${people}</b> 人本月还有可绑定日 · 合计 <b>${okDays}</b> 个可绑定人日` +
        (left ? ` · <b>${left}</b> 人本月离职` : "") +
        `<span class="rent-hint">（T-${BIND_BACK_DAYS} 起可绑 · 名单 ${state.roster.length} 人 · ` +
        `已有租用单 ${state.rents.length} 张${state.rentsErr ? "【取数失败，占用未生效】" : ""}` +
        `${busy ? ` · 占用 ${busy} 人日` : ""}）</span>`;
    }
  }
  const box = $("bind-rows");
  if (!box) return;
  if (state.rosterLoading) {
    box.innerHTML = `<div class="rent-empty">正在读取人资名单…</div>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<div class="rent-empty">${state.rosterErr ? "人资名单没取到，先点「重试」" : "本月没有可绑定的骑手"}</div>`;
    return;
  }
  const head = `<div class="bind-row head">` +
    `<span>骑手</span><span>入职</span><span>离职</span><span>可绑定</span>` +
    `<span class="bind-bar">${days.map((d) => `<i>${Number(d.slice(-2))}</i>`).join("")}</span></div>`;
  const body = rows.slice(0, 80).map((r) => {
    const tip = (r.okDays.length ? `最早可从 ${r.okDays[0]} 开始` : "本月无剩余可绑定日") +
      (r.ownRents.length ? ` · 已有单 ${r.ownRents.slice(0, 2).map((x) => `${x.typeName} ${x.start}~${x.end}`).join("；")}` : "");
    return `<div class="bind-row" title="${esc(r.name)}（${r.id}）· ${esc(tip)}">` +
      `<span class="br-name">${esc(r.name || "未命名")}<em>${esc(r.id)}${r.status === "已离职" ? " · 已离职" : ""}</em></span>` +
      `<span class="br-date">${esc(r.entry || "—")}</span>` +
      `<span class="br-date">${esc(r.leave || "—")}</span>` +
      `<span class="br-day">${r.okDays.length} 天</span>` +
      `<span class="bind-bar">${r.cells.map((c) => `<i class="${c}"></i>`).join("")}</span></div>`;
  }).join("");
  box.innerHTML = head + body +
    (rows.length > 80 ? `<div class="rent-empty">只显示前 80 人（共 ${rows.length} 人），导出 Excel 看全部</div>` : "");
}

// ---------------------------------------------------------------- 文件下载（导入模板 CSV）
// 可绑定日历 / 逐日明细已改为 Excel（.xlsx）双 Sheet，见下方「导出 Excel」段；
// 这里的 CSV 只用于「批量执行」弹层里的导入模板。
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, rows) {
  const text = "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
/** 全部站点名单：逐个站点拉（每个站点一次请求），失败的站点记下来但不阻断。 */
async function loadAllRoster() {
  const all = [];
  const fails = [];
  for (let i = 0; i < state.teams.length; i++) {
    const t = state.teams[i];
    showMsg("bind-msg", `正在读取 ${i + 1}/${state.teams.length} 个站点的人资名单：${t.name}`, "info");
    try {
      const list = await loadRoster(t.id, t.name);
      all.push(...list);
    } catch (e) { fails.push(`${t.name}（${String(e && e.message ? e.message : e)}）`); }
    if (i < state.teams.length - 1) await sleep(120);
  }
  showMsg("bind-msg", fails.length ? `部分站点没取到：${fails.slice(0, 3).join("；")}` : "", fails.length ? "error" : "");
  return all;
}
// ---------------------------------------------------------------- 导出 Excel（住宿 / 租车 双 Sheet）
/** 两个 Sheet 各自只按本类型的已有单判占用，所以「可绑定天数 / 最早起日」会不一样。 */
const EXPORT_GROUPS = [
  { key: "rent", sheet: "租车", match: /电动车|租车|车辆|车/, fallback: 10001 },
  { key: "lodging", sheet: "住宿", match: /住宿|宿舍/, fallback: 10002 }
];
/** 优先按服务端物资类型名找 categoryId，取不到时退回内置 id（电动车 10001 / 住宿 10002）。 */
function groupTypeId(g) {
  const t = state.types.find((x) => g.match.test(String(x.name || "")));
  return String(t ? t.id : g.fallback);
}
/** 「已绑定」下方那行：最多 2 张单，日期缩成 MM-DD，避免撑爆日期列。 */
function boundDetail(list) {
  const arr = (list || []).slice(0, 2)
    .map((s) => String(s).replace(/\d{4}-\d{2}-\d{2}/g, (m) => m.slice(5)));
  if ((list || []).length > 2) arr.push("…");
  return arr.join("\n");
}
const BIND_BASE_HEAD = ["站点", "骑手姓名", "手机号", "骑士ID", "入职日期", "离职日期", "在职状态",
  "可绑定天数", "可绑定区间", "最早可绑定起日", "已有单(本月)"];

function matrixSheet(group, month, list, pool, scopeLabel) {
  const S = XLSX_WRITER.STYLE;
  const days = monthDays(month);
  const rows = bindRows(month, state.bindLeft, list, groupTypeId(group), pool);
  const head = BIND_BASE_HEAD.concat(days);            // 日期列写完整 YYYY-MM-DD，不再只写日号
  const out = [head], styles = [head.map(() => S.head)];
  for (const r of rows) {
    const base = [
      r.teamName || scopeLabel, r.name, r.mobile, r.id, r.entry || "", r.leave || "", r.status || "",
      r.okDays.length,
      r.okDays.length ? `${r.okDays[0]} ~ ${r.okDays[r.okDays.length - 1]}` : "",
      r.earliest || "",
      r.ownRents.map((x) => `${x.typeName} ${x.start}~${x.end}`).join("；")
    ];
    const texts = r.cells.map((c, i) =>
      c === "busy" ? `已绑定\n${boundDetail(r.busy[days[i]])}` : BIND_LABEL[c]);
    out.push(base.concat(texts));
    styles.push(base.map(() => S.info).concat(r.cells.map((c) => S[c] == null ? S.base : S[c])));
  }
  return {
    name: group.sheet, rows: out, styles,
    widths: [16, 12, 14, 14, 13, 13, 10, 12, 26, 17, 38].concat(days.map(() => 18)),
    freeze: { rows: 1, cols: BIND_BASE_HEAD.length },
    headHeight: 30, rowHeight: 36, people: rows.length
  };
}

function detailSheet(group, month, list, pool, scopeLabel) {
  const S = XLSX_WRITER.STYLE;
  const days = monthDays(month);
  const rows = bindRows(month, state.bindLeft, list, groupTypeId(group), pool);
  const head = ["站点", "骑手姓名", "骑士ID", "手机号", "日期", "星期", "状态", "占用单", "说明"];
  const out = [head], styles = [head.map(() => S.head)];
  for (const r of rows) {
    for (let i = 0; i < days.length; i++) {
      const c = r.cells[i], d = days[i];
      // 不勾「含已离职」时只留可绑定 + 已绑定两种日期，其余（未入职 / 已离职 / 超出补登期）略过
      if (state.bindLeft === false && c !== "ok" && c !== "busy") continue;
      let note = "";
      if (c === "ok" && r.entry === d) note = "入职日";
      else if (c === "ok" && r.leave === d) note = "离职日";
      else if (c === "before") note = "还没入职";
      else if (c === "after") note = "已离职";
      else if (c === "past") note = `早于 T-${BIND_BACK_DAYS}，不能补登记`;
      else if (c === "busy") note = "同类型已有租用单，新单须从该单结束次日开始";
      const busyText = c === "busy" ? (r.busy[d] || []).join("；") : "";
      out.push([r.teamName || scopeLabel, r.name, r.id, r.mobile, d, "周" + weekdayOf(d),
        BIND_LABEL[c], busyText, note]);
      styles.push([S.info, S.info, S.info, S.info, S.info, S.info, S[c] == null ? S.base : S[c], S.info, S.info]);
    }
  }
  return {
    name: group.sheet, rows: out, styles,
    widths: [16, 12, 14, 14, 14, 8, 12, 40, 34],
    freeze: { rows: 1, cols: 4 }, headHeight: 30, rowHeight: 22, people: rows.length
  };
}

/** kind = matrix（日历矩阵）/ detail（逐日明细）。两个导出都是 .xlsx，含「住宿」「租车」两个 Sheet。 */
async function exportBind(kind) {
  if (typeof XLSX_WRITER === "undefined") {
    showMsg("bind-msg", "Excel 写入器没加载，刷新页面后重试", "error"); return;
  }
  const month = state.bindMonth;
  let list = state.roster;
  let rentPool = state.rents;
  let scopeLabel = state.siteName || String(state.siteId);
  if (state.bindScope === "all") {
    scopeLabel = "全部站点";
    list = await loadAllRoster();
    if (!list.length) { showMsg("bind-msg", "全部站点都没取到名单，无法导出", "error"); return; }
    showMsg("bind-msg", "正在读取全部站点的已有租用单…", "info");
    try {
      rentPool = await loadRents(state.teams.map((t) => num(t.id)));
    } catch (e) {
      showMsg("bind-msg", "全部站点已有租用单读取失败，导出的已绑定列可能不完整：" + String(e && e.message ? e.message : e), "error");
    }
  } else if (!list.length) {
    showMsg("bind-msg", "当前站点还没有人资名单，先点「重试」", "error");
    return;
  }
  const build = kind === "matrix" ? matrixSheet : detailSheet;
  const sheets = EXPORT_GROUPS.map((g) => build(g, month, list, rentPool, scopeLabel));
  if (sheets.every((s) => s.rows.length === 1)) {
    showMsg("bind-msg", "这个月没有可导出的骑手 / 日期", "error"); return;
  }
  const label = kind === "matrix" ? "日历" : "逐日明细";
  const fileName = `物资可绑定_${String(scopeLabel).replace(/[\\/:*?"<>|]/g, "_")}_${month}_${label}.xlsx`;
  XLSX_WRITER.download(fileName, sheets);
  showMsg("bind-msg", `已导出 ${fileName} · 住宿 ${sheets[1].people} 人 / 租车 ${sheets[0].people} 人（两个 Sheet）`, "success");
}

function renderAll() {
  renderSites();
  renderTypes();
  renderKnightSelect();
  renderBatchList();
  renderKpis();
  renderStatus();
  renderHistory();
  renderBind();
  renderDeduct();
}

// ---------------------------------------------------------------- 按金额反算（纯函数层，不碰 DOM）
// 口径（v3.25.0）：
//   日扣款 = 月扣款 ÷ 当月实际天数
//   目标天次 T = floor(金额 ÷ 月扣款 × 当月天数) = floor(金额 ÷ 日扣款)
//   窗口 = 该骑手该类型「最早可绑定日 → 今天」的第一段连续可绑定日期（截止 T0，不取未来）
//   匹配 = 天数从最大往下降、数量从 1 往上升，取第一个 |T − 天数×数量| ≤ 1 的组合
const DEDUCT_QTY_MAX = 99;          // 单张单数量上限，与 validate 保持一致
const DEDUCT_DEFAULT_FEE = 1000;    // 月扣款默认值，按物资类型可在页面上改
const DEDUCT_CAP_ITEM = 500;        // 单项目封顶（元）：一张单（单个物资类型）最多扣这么多
const DEDUCT_CAP_TOTAL = 1000;      // 合计封顶（元）：同一骑手各类型加起来最多扣这么多

/** 今天所在月的实际天数。 */
function deductMonthDays(today) {
  return monthDays(String(today || todayStr()).slice(0, 7)).length;
}
/** 日扣款 = 月扣款 ÷ 当月天数。 */
const deductDailyFee = (monthlyFee, daysInMonth) =>
  num(daysInMonth) > 0 ? num(monthlyFee) / num(daysInMonth) : 0;
/** 金额 → 目标天次（向下取整）。加极小 eps 抵消浮点误差，避免 8.999999 被截成 8。 */
function deductTarget(amount, monthlyFee, daysInMonth) {
  const a = num(amount), f = num(monthlyFee), d = num(daysInMonth);
  if (!(a > 0) || !(f > 0) || !(d > 0)) return 0;
  return Math.floor((a * d) / f + 1e-9);
}

/** 该骑手该类型在 [T-6, 今天] 内，从「最早的未占用日期」开始的第一段连续可绑定日期。
 *  起点取 max(T-6, 入职日)；前置的已绑定 / 离职后日期跳过，一旦开始遇到阻断就截断（一张单必须连续）。 */
function deductWindow(knightId, typeId, today, roster, rents) {
  const t0 = today || todayStr();
  const first = earliestBindDate(t0);
  const rec = (roster || []).find((x) => Number(x.id) === Number(knightId));
  const entry = rec && rec.entry ? rec.entry : "";
  const leave = rec && rec.leave ? rec.leave : "";
  let from = first;
  if (entry && entry > from) from = entry;

  const busy = Object.create(null);
  for (const r of (rents || [])) {
    if (Number(r.knightId) !== Number(knightId)) continue;
    if (String(r.categoryId) !== String(typeId)) continue;
    let d = r.start;
    for (let i = 0; i < 400 && d <= r.end; i++) { busy[d] = 1; d = shiftDate(d, 1); }
  }
  const dayOk = (d) => !(entry && d < entry) && !(leave && d > leave) && !busy[d];
  let start = "", end = "", maxDays = 0;
  for (let d = from, i = 0; i < 400 && d <= t0; i++, d = shiftDate(d, 1)) {
    if (!dayOk(d)) { if (start) break; else continue; }
    if (!start) start = d;
    end = d; maxDays++;
  }
  let reason = "";
  if (maxDays < 1) {
    reason = from > t0
      ? `最早可登记日 ${from} 晚于今天`
      : `${first} ~ ${t0} 没有可绑定的连续日期（入职前 / 离职后 / 已绑定）`;
  }
  return { start, end, maxDays, first, entry, leave, reason };
}

/** 最优匹配：天数由高到低、数量由低到高，返回第一个误差 ≤ 1 的组合。
 *  q 递增时 total 单调增，一旦 total > T+1 就不必再试更大的 q（对应「误差变大就减少天数」）。
 *  maxTotal > 0 时只接受 total ≤ maxTotal（金额封顶算出来的天次上限），避免匹配结果反超封顶。 */
function planDeduction(target, maxDays, qtyMax, maxTotal) {
  const T = Math.floor(num(target));
  const M = Math.floor(num(maxDays));
  const Q = Math.max(1, Math.min(DEDUCT_QTY_MAX, Math.floor(num(qtyMax) || DEDUCT_QTY_MAX)));
  const MT = num(maxTotal) > 0 ? Math.floor(num(maxTotal)) : 0;
  if (T < 1 || M < 1) return null;
  for (let d = M; d >= 1; d--) {
    for (let q = 1; q <= Q; q++) {
      const total = d * q, diff = T - total;
      if (MT > 0 && total > MT) break;
      if (Math.abs(diff) <= 1) return { days: d, qty: q, total, diff, absDiff: Math.abs(diff) };
      if (total > T + 1) break;
    }
  }
  return null;
}

/** 封顶口径：一张单最多能承载多少天次 = ⌊单项封顶 ÷ 日扣款⌋。 */
function capMaxTotal(capItem, dailyFee) {
  const c = num(capItem), f = num(dailyFee);
  if (!(c > 0) || !(f > 0)) return 0;
  return Math.floor(c / f + 1e-9);
}
/** 今天本机已成功提交的反算金额（同一骑手、各类型合计），用于合计封顶。 */
function todayDeductFee(knightId, history) {
  const today = todayStr();
  let sum = 0;
  for (const h of history || []) {
    if (!h || !h.ok || !(num(h.fee) > 0)) continue;
    if (String(h.knightId) !== String(knightId)) continue;
    if (ymdFromTs(h.at) !== today) continue;
    sum += num(h.fee);
  }
  return sum;
}

/** 单行计划。ctx = { typeId, typeName, monthlyFee, capItem, capTotal, today, roster, rents, knights }，只读不写 state。 */
function planDeductRow(input, ctx) {
  const daysInMonth = deductMonthDays(ctx.today);
  const dailyFee = deductDailyFee(ctx.monthlyFee, daysInMonth);
  const target = deductTarget(input.amount, ctx.monthlyFee, daysInMonth);
  const row = {
    line: input.line, knightId: num(input.knightId), knightName: "",
    amount: num(input.amount), target, daysInMonth, monthlyFee: num(ctx.monthlyFee), dailyFee,
    typeId: num(ctx.typeId), typeName: String(ctx.typeName || typeName(ctx.typeId)),
    earliest: "", start: "", end: "", days: 0, qty: 0, total: 0,
    diff: target, absDiff: target, actualFee: 0,
    capItem: num(ctx.capItem), capTotal: num(ctx.capTotal), capHit: "",
    err: "", merged: false, pick: false, done: false, result: null
  };
  const k = (ctx.knights || []).find((x) => Number(x.id) === Number(row.knightId));
  if (k) row.knightName = k.name;
  if (!(row.amount > 0)) { row.err = "金额需大于 0"; return row; }
  if (!k) { row.err = `当前站点没有骑士ID ${row.knightId}`; return row; }
  if (!(row.monthlyFee > 0)) { row.err = "月扣款需大于 0"; return row; }
  if (target < 1) { row.err = `金额不足 1 个天次（日扣款 ${dailyFee.toFixed(2)} 元）`; return row; }

  // 封顶先判：金额本身超过单项封顶时，怎么配天数×数量都装不下，直接拦下
  const mt = row.capItem > 0 ? capMaxTotal(row.capItem, dailyFee) : 0;
  if (row.capItem > 0 && mt < 1) {
    row.capHit = "item";
    row.err = `日扣款 ¥${dailyFee.toFixed(2)} 已高于单项目封顶 ¥${row.capItem}`;
    return row;
  }
  if (row.capItem > 0 && target > mt) {
    row.capHit = "item";
    row.err = `需扣 ¥${row.amount}（${target} 天次）超过单项目封顶 ¥${row.capItem}：` +
      `一张单最多 ${mt} 天次 ≈ ¥${(mt * dailyFee).toFixed(2)}，请调小金额或分多次登记`;
    return row;
  }

  const win = deductWindow(row.knightId, row.typeId, ctx.today, ctx.roster, ctx.rents);
  row.earliest = win.start || win.first;
  if (win.maxDays < 1) { row.err = win.reason || "没有可补登记的日期"; return row; }
  const plan = planDeduction(target, win.maxDays, DEDUCT_QTY_MAX, mt);
  if (!plan) {
    row.err = `需 ${target} 天次，但 ${win.maxDays} 天 × 数量上限 ${DEDUCT_QTY_MAX} 都匹配不到误差 1 以内`;
    return row;
  }
  row.days = plan.days; row.qty = plan.qty; row.total = plan.total;
  row.diff = plan.diff; row.absDiff = plan.absDiff;
  row.start = win.start; row.end = shiftDate(win.start, plan.days - 1);
  row.actualFee = plan.total * dailyFee;
  if (row.capItem > 0 && row.actualFee > row.capItem + 1e-6) {
    row.capHit = "item";
    row.err = `预计扣款 ¥${row.actualFee.toFixed(2)} 超过单项目封顶 ¥${row.capItem}（${plan.days} 天 × ${plan.qty}）`;
    return row;
  }
  row.err = validate(row.knightId, row.typeId, row.qty, row.start, row.end)
    || checkWindow(row.knightId, row.start, row.end, ctx.roster)
    || checkOverlap(row.knightId, row.typeId, row.start, row.end, ctx.rents);
  row.pick = !row.err;
  return row;
}

/** 多行：同一骑士ID 的金额先合并（一个人只出一张单），再逐行生成计划；
 *  最后做「合计封顶」：同一骑手本批各行 + 今天本机已成功提交的反算金额相加，超合计封顶即拦下。 */
function planDeductRows(inputs, ctx) {
  const merged = new Map();
  for (const it of inputs || []) {
    const id = num(it.knightId);
    const prev = merged.get(id);
    if (prev) { prev.amount += num(it.amount); prev.lines.push(it.line); }
    else merged.set(id, { knightId: id, amount: num(it.amount), line: it.line, lines: [it.line] });
  }
  const rows = [...merged.values()].map((it) => {
    const row = planDeductRow(it, ctx);
    row.line = it.lines.join("+");
    row.merged = it.lines.length > 1;
    return row;
  });
  const capTotal = num(ctx.capTotal);
  if (capTotal > 0) {
    const batchFee = new Map();
    for (const r of rows) {
      if (r.capHit || r.err || !(r.actualFee > 0)) continue;
      const key = String(r.knightId);
      batchFee.set(key, (batchFee.get(key) || 0) + r.actualFee);
    }
    for (const r of rows) {
      if (r.capHit || r.err) continue;
      const key = String(r.knightId);
      const mine = batchFee.get(key) || 0;
      const before = todayDeductFee(r.knightId, ctx.history);
      if (mine + before > capTotal + 1e-6) {
        r.capHit = "total";
        r.err = `合计扣款 ¥${(mine + before).toFixed(2)}（本批 ¥${mine.toFixed(2)}` +
          (before > 0 ? ` + 今天已登记 ¥${before.toFixed(2)}` : "") +
          `）超过合计封顶 ¥${capTotal}`;
        r.pick = false;
      }
    }
  }
  return rows;
}

/** 每行「骑士ID 金额」，支持空格 / 制表符 / 逗号分隔，金额可带 ¥ 元。 */
function parseDeductInput(text) {
  const rows = [], errs = [];
  String(text == null ? "" : text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = String(raw).trim();
    if (!s || /^#/.test(s)) return;
    const parts = s.split(/[\s,，\t;；]+/).filter(Boolean);
    if (parts.length < 2) { errs.push(`第 ${line} 行：需要「骑士ID 金额」两列`); return; }
    if (!/^\d+$/.test(parts[0])) { errs.push(`第 ${line} 行：骑士ID 不是数字（${parts[0]}）`); return; }
    const amount = Number(String(parts[1]).replace(/[¥￥元,]/g, ""));
    if (!Number.isFinite(amount) || !(amount > 0)) { errs.push(`第 ${line} 行：金额不是正数（${parts[1]}）`); return; }
    rows.push({ line, knightId: Number(parts[0]), amount });
  });
  return { rows, errs };
}

// ---------------------------------------------------------------- 业务
function validate(knightId, typeId, n, start, end) {
  if (!knightId) return "请选择骑手";
  if (!typeId) return "请选择物资类型";
  if (!(n >= 1 && n <= 99)) return "数量需在 1 ~ 99 之间";
  if (!start || !end) return "请选择开始 / 结束日期";
  if (start > end) return "开始日期不能晚于结束日期";
  return "";
}
/** 时间窗口：不能早于 T-6；人资名单取到时，还要落在在职区间内。 */
function checkWindow(knightId, start, end, roster) {
  const minDate = earliestBindDate();
  if (start < minDate) return `开始日期不能早于 T-${BIND_BACK_DAYS}（${minDate}）`;
  const rec = (roster || state.roster).find((x) => Number(x.id) === Number(knightId));
  if (!rec) return "";                       // 名单没取到就不硬拦
  if (rec.entry && start < rec.entry) return `开始日期早于入职日 ${rec.entry}`;
  if (rec.leave && end > rec.leave) return `结束日期晚于离职日 ${rec.leave}`;
  return "";
}
/** 同骑手 + 同类型不能重叠；命中时给出能容纳同样天数的最早起始日。 */
function checkOverlap(knightId, typeId, start, end, pool) {
  const src = pool || state.rents;
  const hits = findOverlap(knightId, typeId, start, end, src);
  if (!hits.length) return "";
  const suggested = suggestStart(knightId, typeId, start, end, src);
  return overlapText(hits, suggested, typeName(typeId));
}
function payloadOf(knightId, typeId, n, start, end) {
  const startTime = new Date(start + "T00:00:00").getTime();
  const endTime = new Date(end + "T23:59:59").getTime();
  return {
    params: {
      goodsBusinessRentCreateDto: {
        teamId: num(state.siteId),
        knightId: num(knightId),
        categoryList: [{ categoryId: num(typeId), startTime, endTime, num: num(n) }],
        rentType: RENT_TYPE
      }
    }
  };
}
function pushHistory(rec) {
  state.history.unshift(rec);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(state.history)); } catch (e) { /* 无痕模式忽略 */ }
  renderHistory();
  renderKpis();
}
async function submitOne() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const knightId = num($("one-knight").value);
  const typeId = num($("one-type").value);
  // 不能用 `|| 1` 兜底：数量填 0 时会被悄悄改成 1，绕过「1~99」校验
  const n = Math.trunc(num($("one-num").value));
  const start = $("one-start").value;
  const end = $("one-end").value;
  const err = validate(knightId, typeId, n, start, end)
    || checkWindow(knightId, start, end)
    || checkOverlap(knightId, typeId, start, end);
  if (err) { showMsg("one-msg", err, "error"); return { ok: false, msg: err }; }
  const k = currentKnight(knightId);
  const knightName = k ? k.name : String(knightId);
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为「${knightName}」登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？\n\n提交会真实写入租用单。`
  )) return { ok: false, canceled: true };
  state.submitting = true;
  $("one-submit").disabled = true;
  showMsg("one-msg", "提交中…", "info");
  let ok = false, msg = "";
  try {
    const j = await postApi(API_CREATE, payloadOf(knightId, typeId, n, start, end));
    ok = okJson(j);
    msg = ok ? "success" : msgOf(j);
  } catch (e) {
    msg = String(e && e.message ? e.message : e);
  }
  state.submitting = false;
  $("one-submit").disabled = false;
  showMsg("one-msg", ok ? `登记成功：${knightName} · ${typeName(typeId)} × ${n}` : `登记失败：${msg}`, ok ? "success" : "error");
  pushHistory({
    at: Date.now(), site: state.siteName || String(state.siteId), knightId, knightName,
    typeName: typeName(typeId), num: n, start, end, ok, msg: ok ? "" : msg
  });
  if (ok) {
    addLocalRent(knightId, typeId, start, end, n, knightName, typeName(typeId));
    renderBind();
    $("one-knight").value = "";
    $("one-num").value = "1";
  }
  return { ok, msg };
}
async function submitBatch() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const ids = [...state.selected];
  if (!ids.length) { showMsg("batch-msg", "请至少选择一位骑手", "error"); return { ok: false }; }
  const typeId = num($("batch-type").value);
  const n = Math.trunc(num($("batch-num").value));
  const start = $("batch-start").value;
  const end = $("batch-end").value;
  const err = validate(ids[0], typeId, n, start, end);
  if (err) { showMsg("batch-msg", err, "error"); return { ok: false, msg: err }; }
  const blocked = ids.filter((id) => checkWindow(id, start, end) || checkOverlap(id, typeId, start, end)).length;
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为 ${ids.length} 位骑手批量登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？` +
    (blocked ? `\n其中 ${blocked} 位因时间重叠 / 超出补登期会被跳过。` : "") +
    `\n\n每条间隔 ${BATCH_GAP_MS}ms，提交会真实写入租用单。`
  )) return { ok: false, canceled: true };

  state.submitting = true;
  $("batch-submit").disabled = true;
  const prog = $("batch-progress");
  prog.hidden = false;
  let ok = 0, bad = 0;
  const fails = [];
  for (let i = 0; i < ids.length; i++) {
    const k = currentKnight(ids[i]) || { id: ids[i], name: String(ids[i]) };
    prog.innerHTML = `正在提交 ${i + 1}/${ids.length} · 成功 ${ok} · 失败 ${bad}` +
      `<div class="rp-bar"><i style="width:${Math.round(i / ids.length * 100)}%"></i></div>`;
    let oneOk = false, msg = "";
    const pre = checkWindow(k.id, start, end) || checkOverlap(k.id, typeId, start, end);
    if (pre) {
      msg = pre;                       // 本地拦下，不发请求
    } else {
      try {
        const j = await postApi(API_CREATE, payloadOf(k.id, typeId, n, start, end));
        oneOk = okJson(j);
        msg = oneOk ? "" : msgOf(j);
      } catch (e) {
        msg = String(e && e.message ? e.message : e);
      }
      if (oneOk) addLocalRent(k.id, typeId, start, end, n, k.name, typeName(typeId));
    }
    if (oneOk) ok++; else { bad++; fails.push(`${k.name}（${msg}）`); }
    pushHistory({
      at: Date.now(), site: state.siteName || String(state.siteId), knightId: k.id, knightName: k.name,
      typeName: typeName(typeId), num: n, start, end, ok: oneOk, msg
    });
    if (i < ids.length - 1) await sleep(BATCH_GAP_MS);
  }
  prog.innerHTML = `批量完成：成功 ${ok} 人${bad ? ` · 失败 ${bad} 人` : ""}` +
    (fails.length ? `<div style="color:#B91C1C;margin-top:4px;">${esc(fails.slice(0, 5).join("；"))}${fails.length > 5 ? " …" : ""}</div>` : "") +
    `<div class="rp-bar"><i style="width:100%"></i></div>`;
  showMsg("batch-msg", `批量完成：成功 ${ok} 人${bad ? `，失败 ${bad} 人` : ""}`, bad ? "error" : "success");
  state.submitting = false;
  state.selected.clear();
  renderBatchList();
  updateBatchCount();
  return { ok: bad === 0, success: ok, fail: bad };
}

// ---------------------------------------------------------------- 表格导入（批量执行）
const IMPORT_ALIAS = {
  name: ["骑手姓名", "姓名", "骑手", "骑手名称", "knightname"],
  mobile: ["手机号", "手机", "手机号码", "电话", "mobile"],
  knightId: ["骑士id", "骑手id", "knightid", "骑手编号"],
  type: ["物资类型", "类型", "物资", "物资名称", "categoryid"],
  count: ["数量", "件数", "num"],
  start: ["开始日期", "开始时间", "开始", "starttime"],
  end: ["结束日期", "结束时间", "结束", "endtime"]
};
const IMPORT_HEADER = ["骑手姓名", "手机号", "骑士ID", "物资类型", "数量", "开始日期", "结束日期"];

/** CSV / 粘贴文本解析：按首行判断是逗号还是制表符分隔，支持双引号包裹与转义。 */
function parseCsv(text) {
  const s = String(text == null ? "" : text).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const firstLine = s.split("\n")[0] || "";
  const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cur = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(cur); cur = ""; continue; }
    if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
    cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}
const normHeader = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "").replace(/[：:]/g, "");
/** 二维数组 → 行对象。表头至少要能定位到「骑手姓名 / 手机号 / 骑士ID」之一。 */
function mapTable(rows) {
  if (!rows || !rows.length) return { err: "表格是空的" };
  const header = (rows[0] || []).map((x) => String(x == null ? "" : x).trim());
  const col = {};
  for (const key of Object.keys(IMPORT_ALIAS)) {
    const aliases = IMPORT_ALIAS[key];
    for (let i = 0; i < header.length; i++) {
      const h = normHeader(header[i]);
      if (h && aliases.includes(h)) { col[key] = i; break; }
    }
  }
  if (col.name === undefined && col.mobile === undefined && col.knightId === undefined) {
    return { err: "表头里没找到「骑手姓名 / 手机号 / 骑士ID」列，请用模板表头" };
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const pick = (k) => (col[k] === undefined ? "" : String(r[col[k]] == null ? "" : r[col[k]]).trim());
    const rec = {
      line: i + 1, name: pick("name"), mobile: pick("mobile"), knightId: pick("knightId"),
      typeRaw: pick("type"), countRaw: pick("count"), startRaw: pick("start"), endRaw: pick("end"),
      res: null, done: false, result: null
    };
    if (!rec.name && !rec.mobile && !rec.knightId) continue;
    out.push(rec);
    if (out.length >= IMPORT_MAX_ROWS) break;
  }
  if (!out.length) return { err: "表格里只有表头，没有数据行" };
  return { rows: out, header, col };
}
/** 单行校验：骑手（当前站点）→ 物资类型 → 数量 → 日期。 */
function resolveImportRow(row) {
  const out = { ok: false, err: "", knight: null, typeId: 0, typeName: "", count: 1, start: "", end: "" };
  let k = null;
  const kid = Math.trunc(num(row.knightId));
  if (kid) k = state.knights.find((x) => x.id === kid) || null;
  if (!k && row.mobile) k = state.knights.find((x) => x.mobile === String(row.mobile).trim()) || null;
  if (!k && row.name) {
    const hits = state.knights.filter((x) => x.name === String(row.name).trim());
    if (hits.length === 1) k = hits[0];
    else if (hits.length > 1) { out.err = "姓名重名，请补手机号或骑士ID"; return out; }
  }
  if (!k) {
    out.err = (kid || row.mobile || row.name) ? "当前站点没有这位骑手（先切站点）" : "缺少骑手姓名 / 手机号 / 骑士ID";
    return out;
  }
  out.knight = k;
  let t = null;
  const tid = Math.trunc(num(row.typeRaw));
  if (tid) t = state.types.find((x) => x.id === tid) || null;
  if (!t && row.typeRaw) {
    const raw = String(row.typeRaw).trim();
    t = state.types.find((x) => x.name === raw) ||
      state.types.find((x) => raw.includes(x.name) || x.name.includes(raw)) || null;
  }
  if (!t) { out.err = "物资类型不认识：" + (row.typeRaw || "（空）"); return out; }
  out.typeId = t.id;
  out.typeName = t.name;
  const c = row.countRaw === "" || row.countRaw == null ? 1 : Math.trunc(num(row.countRaw));
  if (!(c >= 1 && c <= 99)) { out.err = "数量需在 1 ~ 99 之间"; return out; }
  out.count = c;
  const s = ymd(row.startRaw), e = ymd(row.endRaw);
  if (!s || !e) { out.err = "日期看不懂（写 2026-11-01 或 2026/11/1）"; return out; }
  if (s > e) { out.err = "开始日期晚于结束日期"; return out; }
  out.start = s;
  out.end = e;
  out.ok = true;
  return out;
}
function resolveImport() {
  const planned = [];   // 批内已通过校验的行，后行要避开前行，防止一次导入自己撞自己
  const seen = new Map();
  for (const row of state.importRows) {
    row.res = resolveImportRow(row);
    if (!row.res.ok) continue;
    const r = row.res;
    const win = checkWindow(r.knight.id, r.start, r.end);
    if (win) { r.ok = false; r.err = win; r.reason = "window"; continue; }
    // 完全相同的行直接拦掉：多半是复制粘贴重复，重复提交会生成两条一样的租用单
    const key = [r.knight.id, r.typeId, r.count, r.start, r.end].join("|");
    if (seen.has(key)) {
      r.ok = false;
      r.err = `与第 ${seen.get(key)} 行完全重复，已跳过`;
      r.reason = "dup";
      continue;
    }
    const pool = state.rents.concat(planned);
    const clash = checkOverlap(r.knight.id, r.typeId, r.start, r.end, pool);
    if (clash) {
      r.ok = false;
      r.err = clash;
      r.reason = "overlap";
      r.suggested = suggestStart(r.knight.id, r.typeId, r.start, r.end, pool);
      continue;
    }
    seen.set(key, row.line);
    planned.push({
      knightId: r.knight.id, categoryId: r.typeId, typeName: r.typeName,
      start: r.start, end: r.end, teamId: String(state.siteId), teamName: String(state.siteName || ""),
      local: true
    });
  }
}
/** 把因「区间重叠」被拦下的行，按各自最早可用起始日整体顺延（保持原有天数）。 */
function shiftOverlapRows() {
  let n = 0;
  for (const row of state.importRows) {
    const r = row.res;
    if (!r || r.ok || r.reason !== "overlap" || !r.suggested) continue;
    const span = dayDiff(r.start, r.end);
    row.startRaw = r.suggested;
    row.endRaw = shiftDate(r.suggested, span);
    row.done = false;
    row.result = null;
    n++;
  }
  if (n) {
    resolveImport();
    renderImportPreview();
    showMsg("import-msg", `已把 ${n} 行顺延到最早可用起始日，请再核对预览后执行`, "info");
  }
  return n;
}
function importStats() {
  const ok = state.importRows.filter((r) => r.res && r.res.ok && !r.done).length;
  const bad = state.importRows.filter((r) => r.res && !r.res.ok).length;
  return { ok, bad, total: state.importRows.length };
}
function renderImportPreview() {
  const box = $("import-preview");
  if (!box) return;
  if (!state.importRows.length) {
    box.innerHTML = `<div class="rent-empty">还没有导入数据</div>`;
  } else {
    const head = `<thead><tr><th style="width:46px">行</th><th style="width:150px">骑手</th>` +
      `<th style="width:80px">物资</th><th style="width:52px">数量</th><th style="width:96px">开始</th>` +
      `<th style="width:96px">结束</th><th>校验 / 结果</th></tr></thead>`;
    const body = state.importRows.map((r) => {
      const res = r.res || { ok: false, err: "未校验" };
      let cls = res.ok ? "" : "bad";
      let text = res.ok ? (r.res.typeName || "可执行") : res.err;
      if (r.done) {
        cls = r.result && r.result.ok ? "ok" : "bad";
        text = r.result && r.result.ok ? "提交成功" : "失败：" + ((r.result && r.result.msg) || "未知错误");
      } else if (res.ok) {
        text = "可执行";
      }
      const who = res.knight ? `${esc(res.knight.name)}<em>${esc(res.knight.id)}</em>` : esc(r.name || r.mobile || r.knightId || "—");
      return `<tr><td>${r.line}</td><td class="name">${who}</td>` +
        `<td>${esc(r.res && r.res.typeName ? r.res.typeName : r.typeRaw || "—")}</td>` +
        `<td>${esc(r.res && r.res.ok ? r.res.count : r.countRaw || "—")}</td>` +
        `<td>${esc((r.res && r.res.start) || r.startRaw || "—")}</td>` +
        `<td>${esc((r.res && r.res.end) || r.endRaw || "—")}</td>` +
        `<td class="${cls}" title="${esc(text || "")}">${esc(text || "")}</td></tr>`;
    }).join("");
    box.innerHTML = `<table class="tbl rent-history">${head}<tbody>${body}</tbody></table>`;
  }
  const st = importStats();
  const btn = $("import-run");
  if (btn) {
    btn.disabled = state.submitting || st.ok === 0;
    btn.textContent = st.ok ? `执行 ${st.ok} 条` : "执行 0 条";
  }
  if (st.total) {
    showMsg("import-msg", `共 ${st.total} 行：可执行 ${st.ok} 行` + (st.bad ? `，校验不通过 ${st.bad} 行（会跳过）` : ""),
      st.bad ? "error" : "info");
  }
}
function setImportRows(rows, fileName) {
  state.importRows = rows || [];
  state.importName = fileName || "";
  const nm = $("import-file-name");
  if (nm) nm.textContent = fileName ? `已读取：${fileName}` : "";
  resolveImport();
  renderImportPreview();
}
async function handleImportFile(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    let rows;
    if (/\.(xlsx|xlsm)$/i.test(file.name)) {
      if (typeof XLSX_READER === "undefined") throw new Error("缺少 xlsx 解析器");
      const sheets = await XLSX_READER.read(buf);
      if (!sheets.length) throw new Error("表格里没有工作表");
      // 优先挑表头能对上的工作表
      const keys = ["骑手姓名", "手机号", "骑士ID"];
      let picked = null;
      for (const s of sheets) {
        if (s.rows && s.rows.length && keys.some((k) => s.rows[0].some((c) => normHeader(c) === normHeader(k)))) { picked = s; break; }
      }
      rows = (picked || sheets[0]).rows;
    } else {
      rows = parseCsv(new TextDecoder("utf-8").decode(buf));
    }
    const mapped = mapTable(rows);
    if (mapped.err) { showMsg("import-msg", mapped.err, "error"); return; }
    setImportRows(mapped.rows, file.name);
    showMsg("import-msg", `已读取 ${mapped.rows.length} 行，请核对下方预览`, "info");
  } catch (e) {
    showMsg("import-msg", "读取失败：" + String(e && e.message ? e.message : e), "error");
  }
}
function downloadTemplate() {
  const today = todayStr();
  const last = monthDays(curMonth()).slice(-1)[0];
  const rows = [
    IMPORT_HEADER,
    ["张三", "13800000000", "", "电动车", 1, today, last],
    ["李四", "", "1088920079", "住宿", 1, today, last],
    ["王五", "13900000000", "", "电动车", 2, shiftDate(today, 7), last]
  ];
  downloadCsv("物资租用_导入模板.csv", rows);
  showMsg("import-msg", "模板已下载（示例行是假骑手，导入时会被判定为「当前站点没有这位骑手」并跳过）", "info");
}
async function runImport() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const todo = state.importRows.filter((r) => r.res && r.res.ok && !r.done);
  if (!todo.length) { showMsg("import-msg", "没有可执行的行", "error"); return { ok: false }; }
  const st = importStats();
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认执行 ${todo.length} 条租用登记？` +
    (st.bad ? `\n（另有 ${st.bad} 行校验不通过，会跳过）` : "") +
    `\n\n每条间隔 ${BATCH_GAP_MS}ms，提交会真实写入租用单。`
  )) return { ok: false, canceled: true };

  state.submitting = true;
  $("import-run").disabled = true;
  const prog = $("import-progress");
  if (prog) prog.hidden = false;
  let ok = 0, bad = 0;
  const fails = [];
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    const r = row.res;
    if (prog) {
      prog.innerHTML = `正在提交 ${i + 1}/${todo.length} · 成功 ${ok} · 失败 ${bad}` +
        `<div class="rp-bar"><i style="width:${Math.round(i / todo.length * 100)}%"></i></div>`;
    }
    let oneOk = false, msg = "";
    // 执行前再查一次：预览之后可能又提交了别的单，避免照着过期预览写出重叠单
    const pre = checkWindow(r.knight.id, r.start, r.end)
      || checkOverlap(r.knight.id, r.typeId, r.start, r.end);
    if (pre) {
      msg = pre;
    } else {
      try {
        const j = await postApi(API_CREATE, payloadOf(r.knight.id, r.typeId, r.count, r.start, r.end));
        oneOk = okJson(j);
        msg = oneOk ? "" : msgOf(j);
      } catch (e) {
        msg = String(e && e.message ? e.message : e);
      }
      if (oneOk) addLocalRent(r.knight.id, r.typeId, r.start, r.end, r.count, r.knight.name, r.typeName);
    }
    row.done = true;
    row.result = { ok: oneOk, msg };
    if (oneOk) ok++; else { bad++; fails.push(`${r.knight.name}（${msg}）`); }
    pushHistory({
      at: Date.now(), site: state.siteName || String(state.siteId), knightId: r.knight.id,
      knightName: r.knight.name, typeName: r.typeName, num: r.count, start: r.start, end: r.end,
      ok: oneOk, msg
    });
    renderImportPreview();
    if (i < todo.length - 1) await sleep(BATCH_GAP_MS);
  }
  if (prog) {
    prog.innerHTML = `导入执行完成：成功 ${ok} 条${bad ? ` · 失败 ${bad} 条` : ""}` +
      (fails.length ? `<div style="color:#B91C1C;margin-top:4px;">${esc(fails.slice(0, 5).join("；"))}${fails.length > 5 ? " …" : ""}</div>` : "") +
      `<div class="rp-bar"><i style="width:100%"></i></div>`;
  }
  state.submitting = false;
  renderImportPreview();
  showMsg("import-msg", `执行完成：成功 ${ok} 条${bad ? `，失败 ${bad} 条` : ""}`, bad ? "error" : "success");
  return { ok: bad === 0, success: ok, fail: bad };
}

/** 拉当前站点的人资名单（用于「本月可绑定」），失败只影响这一块。 */
async function loadRosterInto() {
  if (!state.siteId) return [];
  // 离线测试用 __SET_RENT__ 直接注入名单，别让异步请求把它覆盖掉
  if (window.__WB_TEST__ && !window.__RENT_NET_TEST__) return state.roster;
  const seq = ++state.rosterSeq;
  state.rosterLoading = true;
  state.rosterErr = "";
  renderBind();
  let list = [], err = "";
  try {
    list = await loadRoster(state.siteId, state.siteName);
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }
  if (seq !== state.rosterSeq) return state.roster;   // 期间又切了站点，丢弃这次结果
  state.roster = list;
  state.rosterErr = err;
  state.rosterAt = new Date();
  state.rosterLoading = false;
  renderBind();
  return state.roster;
}
// ---------------------------------------------------------------- 按金额反算（控制器 / 视图）
function loadDeductOpts() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_DEDUCT) || "null");
    if (!o || typeof o !== "object") return;
    if (o.fees && typeof o.fees === "object") state.deductFees = o.fees;
    if (o.type) state.deductType = String(o.type);
    if (o.input) state.deductInput = String(o.input);
    if (o.caps && typeof o.caps === "object") state.deductCaps = o.caps;
  } catch (e) { /* ignore */ }
}
function saveDeductOpts() {
  try {
    localStorage.setItem(LS_DEDUCT, JSON.stringify({
      fees: state.deductFees, type: state.deductType, input: state.deductInput, caps: state.deductCaps
    }));
  } catch (e) { /* ignore */ }
}
function currentDeductType() {
  const el = $("deduct-type");
  if (el && num(el.value) > 0) return num(el.value);
  return state.types.length ? num(state.types[0].id) : 0;
}
function currentDeductFee() {
  const el = $("deduct-fee");
  const v = el ? num(el.value) : 0;
  return v > 0 ? v : DEDUCT_DEFAULT_FEE;
}
/** 单项目封顶（元）：输入框优先，其次本机记忆，最后默认 500。0 表示不封顶。 */
function currentDeductCapItem() {
  const el = $("deduct-cap-item");
  if (el) {
    const v = num(el.value);
    return Number.isFinite(v) && v >= 0 ? v : DEDUCT_CAP_ITEM;
  }
  const s = num(state.deductCaps.item);
  return s >= 0 && state.deductCaps.item != null ? s : DEDUCT_CAP_ITEM;
}
/** 合计封顶（元）：输入框优先，其次本机记忆，最后默认 1000。0 表示不封顶。 */
function currentDeductCapTotal() {
  const el = $("deduct-cap-total");
  if (el) {
    const v = num(el.value);
    return Number.isFinite(v) && v >= 0 ? v : DEDUCT_CAP_TOTAL;
  }
  const s = num(state.deductCaps.total);
  return s >= 0 && state.deductCaps.total != null ? s : DEDUCT_CAP_TOTAL;
}
function deductCtx() {
  const typeId = currentDeductType();
  return {
    typeId, typeName: typeName(typeId), monthlyFee: currentDeductFee(),
    capItem: currentDeductCapItem(), capTotal: currentDeductCapTotal(),
    today: todayStr(), roster: state.roster, rents: state.rents, knights: state.knights,
    history: state.history
  };
}
function renderDeduct() {
  const info = $("deduct-fee-info");
  if (info) {
    const dm = deductMonthDays();
    const fee = deductDailyFee(currentDeductFee(), dm);
    const capI = currentDeductCapItem(), capT = currentDeductCapTotal();
    const capTxt = `单项封顶 ${capI > 0 ? "¥" + capI : "不限"} / 合计 ${capT > 0 ? "¥" + capT : "不限"}` +
      (capI > 0 ? `（单张单最多 ${capMaxTotal(capI, fee)} 天次）` : "");
    info.textContent = `按 ${todayStr().slice(0, 7)}（${dm} 天）折算 · 日扣款 ${fee.toFixed(2)} 元/天次 · ${capTxt}`;
  }
  const t = $("deduct-preview");
  if (!t) return;
  const rows = state.deductRows;
  const head = `<thead><tr><th></th><th>行</th><th>骑手</th><th>金额</th><th>目标天次</th>` +
    `<th>最早可绑</th><th>起止日期</th><th>天数</th><th>数量</th><th>实际天次</th>` +
    `<th>误差</th><th>预计扣款</th><th>状态</th></tr></thead>`;
  if (!rows.length) {
    t.innerHTML = head + `<tbody><tr><td colspan="13" class="rent-empty">每行写「骑士ID 金额」，点「生成预览」</td></tr></tbody>`;
  } else {
    const body = rows.map((r, i) => {
      const st = r.done
        ? (r.result && r.result.ok
          ? `<span style="color:#16A34A">已登记</span>`
          : `<span style="color:#DC2626">失败：${esc((r.result && r.result.msg) || "")}</span>`)
        : (r.err ? `<span style="color:#DC2626">${esc(r.err)}</span>` : `<span style="color:#16A34A">可执行</span>`);
      const pick = `<input type="checkbox" class="deduct-pick" data-i="${i}"` +
        `${r.pick && !r.done && !r.err ? " checked" : ""}${r.done || r.err ? " disabled" : ""}>`;
      const diffTxt = r.days ? (r.diff === 0 ? "0" : (r.diff > 0 ? `少 ${r.diff}` : `多 ${-r.diff}`)) : "—";
      const bad = !!r.err || !!(r.done && r.result && !r.result.ok);
      return `<tr${bad ? ' class="deduct-bad"' : ""}>` +
        `<td>${pick}</td><td>${esc(r.line)}</td>` +
        `<td>${esc(r.knightName || r.knightId)}${r.merged ? "<em>（金额已合并）</em>" : ""}</td>` +
        `<td>¥${r.amount}</td><td>${r.target}</td><td>${esc(r.earliest || "—")}</td>` +
        `<td>${r.start && r.end ? `${r.start} ~ ${r.end}` : "—"}</td>` +
        `<td>${r.days || "—"}</td><td>${r.qty || "—"}</td><td>${r.total || "—"}</td>` +
        `<td>${diffTxt}</td><td>${r.actualFee ? "¥" + r.actualFee.toFixed(2) : "—"}</td>` +
        `<td>${st}</td></tr>`;
    }).join("");
    t.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  const n = rows.filter((r) => r.pick && !r.err && !r.done).length;
  const btn = $("deduct-run");
  if (btn) btn.textContent = `执行 ${n} 条`;
}
/** 解析输入 → 生成预览（不提交）。 */
function generateDeduct() {
  const el = $("deduct-input");
  const text = el ? String(el.value || "") : "";
  state.deductInput = text;
  state.deductType = String(currentDeductType());
  state.deductFees[state.deductType] = currentDeductFee();
  state.deductCaps = { item: currentDeductCapItem(), total: currentDeductCapTotal() };
  const parsed = parseDeductInput(text);
  state.deductRows = planDeductRows(parsed.rows, deductCtx());
  saveDeductOpts();
  renderDeduct();
  const okN = state.deductRows.filter((r) => !r.err).length;
  const msg = parsed.errs.length
    ? `已生成 ${state.deductRows.length} 行 · ${parsed.errs.length} 行输入有误：${parsed.errs.slice(0, 2).join("；")}`
    : (okN ? `已生成 ${okN} 行可执行 · 请核对起止日期与数量后执行` : "没有可执行的行，检查骑士ID / 金额 / 可绑定窗口");
  showMsg("deduct-msg", msg, parsed.errs.length || !okN ? "error" : "info");
  return { rows: state.deductRows, errs: parsed.errs };
}
/** 勾选行逐条提交：执行前二次校验、150ms 间隔、成功并入已有单池与本机历史。 */
async function runDeduct() {
  if (state.deductSubmitting) return { ok: 0, bad: 0, msg: "正在提交中" };
  const rows = state.deductRows.filter((r) => r.pick && !r.err && !r.done);
  if (!rows.length) { showMsg("deduct-msg", "没有可执行的行（先点「生成预览」）", "error"); return { ok: 0, bad: 0 }; }
  const list = rows.map((r) =>
    `${r.knightName || r.knightId} ¥${r.amount} → ${r.start} ~ ${r.end} × ${r.qty}（${r.total} 天次）`).join("\n");
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认按以下计划登记 ${rows.length} 张租用单？\n\n${list}\n\n提交会真实写入租用单，每条间隔 ${BATCH_GAP_MS}ms。`
  )) return { ok: 0, bad: 0, canceled: true };

  state.deductSubmitting = true;
  const btn = $("deduct-run");
  if (btn) btn.disabled = true;
  let ok = 0, bad = 0;
  const fails = [];
  for (const r of rows) {
    // 执行前二次校验：名单 / 已有单 / 封顶可能已变，避免照过期预览提交
    const capI = currentDeductCapItem(), capT = currentDeductCapTotal();
    const capErr = (capI > 0 && r.actualFee > capI + 1e-6)
      ? `预计扣款 ¥${r.actualFee.toFixed(2)} 超过单项目封顶 ¥${capI}`
      : (capT > 0 && r.actualFee + todayDeductFee(r.knightId, state.history) > capT + 1e-6
        ? `合计扣款 ¥${(r.actualFee + todayDeductFee(r.knightId, state.history)).toFixed(2)} 超过合计封顶 ¥${capT}`
        : "");
    const pre = capErr
      || validate(r.knightId, r.typeId, r.qty, r.start, r.end)
      || checkWindow(r.knightId, r.start, r.end)
      || checkOverlap(r.knightId, r.typeId, r.start, r.end);
    if (pre) {
      r.done = true; r.result = { ok: false, msg: pre };
      bad++; fails.push(`${r.knightName || r.knightId}（${pre}）`);
    } else {
      let oneOk = false, msg = "";
      try {
        const j = await postApi(API_CREATE, payloadOf(r.knightId, r.typeId, r.qty, r.start, r.end));
        oneOk = okJson(j);
        msg = oneOk ? "" : msgOf(j);
      } catch (e) { msg = String(e && e.message ? e.message : e); }
      r.done = true; r.result = { ok: oneOk, msg };
      pushHistory({
        at: Date.now(), site: state.siteName || String(state.siteId),
        knightId: r.knightId, knightName: r.knightName || String(r.knightId),
        typeId: r.typeId, typeName: r.typeName, num: r.qty, start: r.start, end: r.end,
        fee: r.actualFee, ok: oneOk, msg
      });
      if (oneOk) {
        ok++;
        addLocalRent(r.knightId, r.typeId, r.start, r.end, r.qty, r.knightName, r.typeName);
      } else { bad++; fails.push(`${r.knightName || r.knightId}（${msg}）`); }
    }
    renderDeduct();
    showMsg("deduct-msg", `执行中 ${ok + bad}/${rows.length}…`, "info");
    if (ok + bad < rows.length) await sleep(BATCH_GAP_MS);
  }
  state.deductSubmitting = false;
  if (btn) btn.disabled = false;
  renderBind();
  const text = `执行完成：成功 ${ok} 条 / 失败 ${bad} 条` + (fails.length ? ` · ${fails.slice(0, 3).join("；")}` : "");
  showMsg("deduct-msg", text, bad ? "error" : "success");
  return { ok, bad, msg: text };
}

// ---------------------------------------------------------------- 事件
async function switchSite(siteId) {
  state.siteId = String(siteId || "");
  try { localStorage.setItem(LS_SITE, state.siteId); } catch (e) { /* ignore */ }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.selected.clear();
  state.knights = [];
  state.roster = [];
  state.rosterErr = "";
  state.rents = [];
  state.rentsErr = "";
  renderSites();
  renderBatchList();
  renderKpis();
  renderStatus();
  renderBind();
  if (!state.siteId) return;
  try {
    state.knights = await loadKnights(state.siteId);
    state.errors = [];
  } catch (e) {
    showNotice("骑手列表加载失败：" + String(e && e.message ? e.message : e), "bad");
  }
  renderAll();
  loadRosterInto();          // 不 await：名单慢一点也不挡主表
  loadRentsInto();           // 已有租用单，防重叠校验的数据源
}
async function loadAll() {
  state.loading = true;
  state.errors = [];
  try {
    const [teams, types] = await Promise.all([loadTeams(), loadTypes()]);
    state.teams = teams;
    state.types = types;
  } catch (e) {
    state.errors.push(String(e && e.message ? e.message : e));
    if (!state.teams.length) state.teams = fallbackTeams();
    showNotice("站点 / 物资类型加载失败：" + state.errors[0] + "（可点「立即刷新」重试，或切到静默桥接）", "bad");
  }
  if (!state.siteId || !state.teams.some((t) => String(t.id) === String(state.siteId))) {
    state.siteId = state.teams[0] ? String(state.teams[0].id) : "";
  }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.finishedAt = new Date();
  state.loading = false;
  renderAll();
  if (state.siteId) await switchSite(state.siteId);
}

function bind() {
  $("site-select").addEventListener("change", (e) => switchSite(e.target.value));
  $("btn-refresh").addEventListener("click", () => loadAll());
  $("btn-channel").addEventListener("click", async () => {
    state.via = state.via === "direct" ? "bridge" : "direct";
    try { localStorage.setItem("wb_via", state.via); } catch (e) { /* ignore */ }
    renderStatus();
    showNotice(state.via === "bridge"
      ? "已切到「静默桥接」：后台标签页取数，不打断浏览。"
      : "已切回「直连」：由插件页面直接请求接口。", state.via === "bridge" ? "blue" : "bad");
    await loadAll();
  });
  $("btn-clean").addEventListener("click", () => {
    const on = document.body.classList.toggle("clean");
    $("btn-clean").textContent = on ? "退出纯净" : "纯净看板";
  });
  $("btn-goto-assess").addEventListener("click", () => {
    if (window.parent !== window) {
      window.parent.postMessage({ __wbAssess: true, type: "SWITCH", mode: "assess" }, "*");
    } else {
      extMsg({ type: "WB_OPEN_TAB", page: "assess" }).catch(() => {});
    }
  });
  $("one-search").addEventListener("input", renderKnightSelect);
  $("one-submit").addEventListener("click", () => submitOne());
  $("batch-search").addEventListener("input", renderBatchList);
  $("batch-select-all").addEventListener("click", () => {
    const q = String($("batch-search").value || "").trim().toLowerCase();
    for (const k of state.knights) {
      if (!q || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q)) {
        state.selected.add(k.id);
      }
    }
    renderBatchList();
  });
  $("batch-clear").addEventListener("click", () => {
    state.selected.clear();
    renderBatchList();
  });
  $("batch-submit").addEventListener("click", () => submitBatch());

  // ---- 按金额反算登记
  $("deduct-type").addEventListener("change", () => {
    state.deductType = String($("deduct-type").value);
    const saved = num(state.deductFees[state.deductType]);
    if (saved > 0) $("deduct-fee").value = saved;
    saveDeductOpts();
    renderDeduct();
  });
  $("deduct-fee").addEventListener("input", () => {
    state.deductFees[String(currentDeductType())] = num($("deduct-fee").value);
    saveDeductOpts();
    renderDeduct();
  });
  for (const [id, key] of [["deduct-cap-item", "item"], ["deduct-cap-total", "total"]]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("input", () => {
      state.deductCaps[key] = num(el.value);
      saveDeductOpts();
      renderDeduct();
    });
  }
  $("deduct-input").addEventListener("input", () => {
    state.deductInput = String($("deduct-input").value || "");
    saveDeductOpts();
  });
  $("deduct-generate").addEventListener("click", () => generateDeduct());
  $("deduct-run").addEventListener("click", () => runDeduct());
  $("deduct-clear").addEventListener("click", () => {
    $("deduct-input").value = "";
    state.deductInput = "";
    state.deductRows = [];
    saveDeductOpts();
    renderDeduct();
    showMsg("deduct-msg", "", "info");
  });
  $("deduct-preview").addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains("deduct-pick")) return;
    const i = num(el.dataset.i);
    if (state.deductRows[i]) state.deductRows[i].pick = !!el.checked;
    renderDeduct();
  });

  // ---- 批量执行（表格导入）
  const openImport = () => { const m = $("import-modal"); if (m) m.hidden = false; };
  const closeImport = () => { const m = $("import-modal"); if (m) m.hidden = true; };
  $("btn-import").addEventListener("click", openImport);
  $("import-close").addEventListener("click", closeImport);
  $("import-cancel").addEventListener("click", closeImport);
  $("tpl-download").addEventListener("click", downloadTemplate);
  $("import-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    handleImportFile(f);
  });
  $("import-parse").addEventListener("click", () => {
    const text = String($("import-paste").value || "").trim();
    if (!text) { showMsg("import-msg", "先粘一段表格，或选一个文件", "error"); return; }
    const mapped = mapTable(parseCsv(text));
    if (mapped.err) { showMsg("import-msg", mapped.err, "error"); return; }
    setImportRows(mapped.rows, "粘贴内容");
    showMsg("import-msg", `已解析 ${mapped.rows.length} 行，请核对下方预览`, "info");
  });
  $("import-clear").addEventListener("click", () => {
    $("import-paste").value = "";
    $("import-file").value = "";
    const p = $("import-progress"); if (p) p.hidden = true;
    setImportRows([], "");
    showMsg("import-msg", "", "");
  });
  $("import-run").addEventListener("click", () => runImport());
  $("import-shift").addEventListener("click", () => shiftOverlapRows());
  $("import-modal").addEventListener("click", (e) => { if (e.target && e.target.id === "import-modal") closeImport(); });

  // ---- 本月可绑定
  $("bind-month").addEventListener("change", (e) => {
    state.bindMonth = e.target.value || curMonth();
    saveBindOpts();
    renderBind();
  });
  $("bind-scope").addEventListener("change", (e) => {
    state.bindScope = e.target.value === "all" ? "all" : "site";
    saveBindOpts();
    showMsg("bind-msg", state.bindScope === "all" ? "导出时会逐个站点读取人资名单与已有租用单，站点多会慢几秒" : "", "info");
  });
  $("bind-type").addEventListener("change", (e) => {
    state.bindType = e.target.value || "all";
    saveBindOpts();
    renderBind();
  });
  $("bind-refresh").addEventListener("click", async () => {
    showMsg("bind-msg", "正在重新读取已有租用单…", "info");
    const list = await loadRentsInto();
    if (!state.rentsErr) showMsg("bind-msg", `已读取 ${list.length} 张已有租用单`, "success");
    else showMsg("bind-msg", "读取失败：" + state.rentsErr, "error");
  });
  $("bind-left").addEventListener("change", (e) => {
    state.bindLeft = !!e.target.checked;
    saveBindOpts();
    renderBind();
  });
  $("bind-export-matrix").addEventListener("click", () => exportBind("matrix"));
  $("bind-export-detail").addEventListener("click", () => exportBind("detail"));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const n = $("notice"); if (n) n.hidden = true;
      const m = $("import-modal"); if (m) m.hidden = true;
    }
  });
}
function saveBindOpts() {
  try {
    localStorage.setItem(LS_BIND, JSON.stringify({
      month: state.bindMonth, scope: state.bindScope, type: state.bindType, left: state.bindLeft
    }));
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 测试挂钩
window.__SET_RENT__ = (o) => {
  o = o || {};
  if (Array.isArray(o.teams)) state.teams = o.teams.map((t) => ({ id: String(t.id), name: String(t.name || t.team_name || t.id) }));
  if (Array.isArray(o.types)) state.types = o.types.map((t) => ({ id: num(t.id), name: String(t.name || t.id) }));
  if (Array.isArray(o.knights)) state.knights = o.knights.map((k) => ({
    id: num(k.id == null ? k.knightId : k.id), name: String(k.name || k.knightName || ""),
    mobile: String(k.mobile || ""), teamId: num(k.teamId)
  }));
  if (o.siteId != null) state.siteId = String(o.siteId);
  if (Array.isArray(o.history)) state.history = o.history;
  if (Array.isArray(o.roster)) state.roster = o.roster.map((r) => ({
    id: num(r.id == null ? r.knightId : r.id), name: String(r.name || r.staffName || ""),
    mobile: String(r.mobile || ""), entry: ymd(r.entry || r.entryTime), leave: ymd(r.leave || r.leaveTime),
    status: String(r.status || (r.leave || r.leaveTime ? "已离职" : "在职")),
    teamId: String(r.teamId || state.siteId), teamName: String(r.teamName || "")
  }));
  if (o.bindMonth) state.bindMonth = String(o.bindMonth);
  if (o.bindLeft != null) state.bindLeft = !!o.bindLeft;
  if (o.bindScope) state.bindScope = String(o.bindScope);
  if (o.bindType != null) state.bindType = String(o.bindType);
  if (Array.isArray(o.rents)) state.rents = o.rents.map((r) => ({
    id: num(r.id), knightId: num(r.knightId == null ? r.kid : r.knightId),
    knightName: String(r.knightName || ""),
    categoryId: num(r.categoryId == null ? r.typeId : r.categoryId),
    typeName: String(r.typeName || typeName(r.categoryId == null ? r.typeId : r.categoryId)),
    start: ymd(r.start), end: ymd(r.end), num: num(r.num) || 1,
    status: num(r.status) || 2,
    teamId: String(r.teamId || state.siteId), teamName: String(r.teamName || ""),
    local: !!r.local
  }));
  if (Array.isArray(o.importRows)) {
    state.importRows = o.importRows.map((r) => ({
      line: num(r.line) || 1, name: String(r.name || ""), mobile: String(r.mobile || ""),
      knightId: String(r.knightId || ""), typeRaw: String(r.typeRaw || ""), countRaw: String(r.countRaw || ""),
      startRaw: String(r.startRaw || ""), endRaw: String(r.endRaw || ""), res: null, done: false, result: null
    }));
    resolveImport();
  }
  if (o.deductType != null) {
    state.deductType = String(o.deductType);
    const el = $("deduct-type"); if (el) el.value = state.deductType;
  }
  if (o.deductFee != null) {
    const el = $("deduct-fee");
    if (el) el.value = num(o.deductFee);
    state.deductFees[String(currentDeductType())] = num(o.deductFee);
  }
  if (o.capItem != null) {
    state.deductCaps.item = num(o.capItem);
    const el = $("deduct-cap-item"); if (el) el.value = num(o.capItem);
  }
  if (o.capTotal != null) {
    state.deductCaps.total = num(o.capTotal);
    const el = $("deduct-cap-total"); if (el) el.value = num(o.capTotal);
  }
  if (o.deductInput != null) {
    state.deductInput = String(o.deductInput);
    const el = $("deduct-input"); if (el) el.value = state.deductInput;
  }
  if (Array.isArray(o.deductRows)) {
    state.deductRows = o.deductRows.map((r) => ({
      line: String(r.line || 1), knightId: num(r.knightId), knightName: String(r.knightName || ""),
      amount: num(r.amount), target: num(r.target), daysInMonth: num(r.daysInMonth) || deductMonthDays(),
      monthlyFee: num(r.monthlyFee) || currentDeductFee(),
      dailyFee: num(r.dailyFee) || deductDailyFee(currentDeductFee(), deductMonthDays()),
      typeId: num(r.typeId) || currentDeductType(),
      typeName: String(r.typeName || typeName(currentDeductType())),
      earliest: String(r.earliest || ""), start: String(r.start || ""), end: String(r.end || ""),
      days: num(r.days), qty: num(r.qty), total: num(r.total),
      diff: num(r.diff), absDiff: num(r.absDiff), actualFee: num(r.actualFee),
      err: String(r.err || ""), merged: !!r.merged,
      pick: r.pick == null ? !r.err : !!r.pick, done: !!r.done, result: r.result || null
    }));
  }
  const t = state.teams.find((x) => String(x.id) === String(state.siteId));
  state.siteName = t ? t.name : String(state.siteId || "");
  state.finishedAt = new Date();
  renderAll();
  renderImportPreview();
};
window.__RENT__ = {
  state, postApi, getApi, loadAll, loadTeams, loadTypes, loadKnights, switchSite,
  loadRoster, loadRosterInto, loadRents, loadRentsInto, addLocalRent,
  findOverlap, suggestStart, checkOverlap, checkWindow, overlapText, dayDiff, earliestBindDate,
  computeBind, bindRows, bindState, busyMapFor, monthDays, ymd, exportBind,
  EXPORT_GROUPS, groupTypeId, boundDetail, BIND_LABEL, matrixSheet, detailSheet,
  XLSX_WRITER: (typeof XLSX_WRITER === "undefined" ? null : XLSX_WRITER),
  parseCsv, mapTable, resolveImportRow, resolveImport, shiftOverlapRows, setImportRows, runImport,
  downloadTemplate, importStats, downloadCsv, csvCell, saveBindOpts,
  submitOne, submitBatch, validate, payloadOf, renderAll, renderHistory, renderBind, renderImportPreview,
  deductMonthDays, deductDailyFee, deductTarget, deductWindow, planDeduction,
  planDeductRow, planDeductRows, parseDeductInput, deductCtx,
  generateDeduct, runDeduct, renderDeduct, loadDeductOpts, saveDeductOpts,
  API_TEAMS, API_TYPES, API_KNIGHTS, API_CREATE, API_RENT_LIST, API_STAFF,
  RENT_TYPE, QUERY_TYPE, BATCH_GAP_MS, HISTORY_MAX, BIND_BACK_DAYS,
  STAFF_PAGE_SIZE, RENT_PAGE_SIZE, IMPORT_MAX_ROWS,
  DEDUCT_QTY_MAX, DEDUCT_DEFAULT_FEE, LS_DEDUCT,
  DEDUCT_CAP_ITEM, DEDUCT_CAP_TOTAL, capMaxTotal, todayDeductFee, planDeduction,
  currentDeductCapItem, currentDeductCapTotal
};

(async function init() {
  bind();
  const today = todayStr();
  for (const [id, val] of [["one-start", today], ["one-end", shiftDate(today, 30)],
    ["batch-start", today], ["batch-end", shiftDate(today, 30)]]) {
    const el = $(id);
    if (el) el.value = val;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
    if (Array.isArray(raw)) state.history = raw.slice(0, HISTORY_MAX);
  } catch (e) { state.history = []; }
  try {
    const o = JSON.parse(localStorage.getItem(LS_BIND) || "null");
    if (o && typeof o === "object") {
      if (o.month) state.bindMonth = String(o.month);
      if (o.scope === "all") state.bindScope = "all";
      if (o.type) state.bindType = String(o.type);
      state.bindLeft = !!o.left;
    }
  } catch (e) { /* ignore */ }
  const bm = $("bind-month"), bs = $("bind-scope"), bt = $("bind-type"), bl = $("bind-left");
  if (bm) bm.value = state.bindMonth;
  if (bs) bs.value = state.bindScope;
  if (bt) bt.value = state.bindType;
  if (bl) bl.checked = state.bindLeft;
  loadDeductOpts();
  const di = $("deduct-input"), df = $("deduct-fee");
  if (di) di.value = state.deductInput;
  if (df) df.value = num(state.deductFees[state.deductType]) > 0
    ? num(state.deductFees[state.deductType]) : DEDUCT_DEFAULT_FEE;
  const ci = $("deduct-cap-item"), ct = $("deduct-cap-total");
  if (ci) ci.value = state.deductCaps.item != null ? num(state.deductCaps.item) : DEDUCT_CAP_ITEM;
  if (ct) ct.value = state.deductCaps.total != null ? num(state.deductCaps.total) : DEDUCT_CAP_TOTAL;
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  renderAll();
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) await loadAll();
})();
