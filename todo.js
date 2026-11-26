/* 今日待办 · 商站任务（v3.57.23）
 * 数据源：商站任务管理 /task/list（fearow）
 *   POST xtop.ryze.fs.agency.team.task.listByPage/1.0
 *   params.queryVO = { status:"started", pageSize, pageIndex }
 * 只取「已开始」的任务；按任务名称前缀分类，分类可单独设置预警提前量（0 ~ 不限）。
 */
"use strict";

const XT = "https://httpizza.ele.me/xtop/";
const API_TASKS = XT + "xtop.ryze.fs.agency.team.task.listByPage/1.0";
const API_TASK_DETAIL = XT + "xtop.ryze.fs.agency.team.task.queryByTaskId/1.0";
const LS_WARN = "wb_todo_warn_v1";
const LS_STATION = "wb_todo_station_v1";
const LS_TRAIN = "wb_todo_train_v1";
const LS_TRAIN_DAYS = "wb_todo_train_days_v1";
const TRAIN_REPORT_ID = "860325";
const TRAIN_DATASET_ID = 59237060;
const QUARK_WIDGET = "https://quark.alibaba.com/fbi/.json?action=report/WidgetAction&event_submit_doGetWidgetData=true&componentName=fbi-common-table&_widgetId=kmrd93s7";
const LS_TRAIN_SEC = "wb_todo_train_sec_v1";
const API_LEDGER_LIST = XT + "xtop.ryze.standing.book.fs.queryStandingBook/1.0";
const API_LEDGER_DETAIL = XT + "xtop.ryze.standing.book.fs.queryStandingBookById/1.0";
const API_LEDGER_CHECK = XT + "xtop.ryze.standing.book.fs.checkStandingBook/1.0";
const API_LEDGER_CANCEL = XT + "xtop.ryze.standing.book.fs.cancelStandingBook/1.0";
const API_OSS_DL = XT + "xtop.fs.oss.getDownloadUrl/1.0";
const LS_LEDGER = "wb_todo_ledger_v1";
const LS_VOIDED = "wb_todo_voided_v1";
const LS_CAT = "wb_todo_cat_cfg_v1";
/** 每个待办分类的预警口径；以后加新分类，在这里加一行即可（设置弹层会自动出现）。 */
const CAT_SPEC = [
  { k: "trainDays", name: "新骑手培训", hint: "近 N 天到期", min: 1, max: 30, def: 5, unit: "天" },
  { k: "ledgerDays", name: "台账待审核", hint: "近 N 天上传", min: 1, max: 30, def: 30, unit: "天" },
  { k: "resignHours", name: "离职待审核", hint: "剩余 ≤ N 小时", min: 1, max: 72, def: 72, unit: "小时" }
];
function loadCatCfg() {
  const out = {};
  for (const c of CAT_SPEC) out[c.k] = c.def;
  try {
    const raw = localStorage.getItem(LS_CAT);
    if (raw) {
      const o = JSON.parse(raw) || {};
      for (const c of CAT_SPEC) {
        const v = Number(o[c.k]);
        if (Number.isFinite(v)) out[c.k] = Math.max(c.min, Math.min(c.max, Math.round(v)));
      }
      return out;
    }
  } catch (e) { /* ignore */ }
  // 兼容旧版本只存了培训天数
  const old = Number(localStorage.getItem(LS_TRAIN_DAYS));
  if (Number.isFinite(old) && old >= 1 && old <= 30) out.trainDays = Math.round(old);
  return out;
}
function saveCatCfg() {
  try { localStorage.setItem(LS_CAT, JSON.stringify(state.catCfg)); } catch (e) { /* ignore */ }
}
const API_RESIGN_LIST = XT + "xtop.lpd.rights.knightSepAgrmtFsWeb.listPage/1.0";
const API_RESIGN_STATES = XT + "xtop.lpd.rights.knightSepAgrmtFsWeb.getSepAgrmtProcessState/1.0";
const API_RESIGN_CONFIRM = XT + "xtop.lpd.rights.knightSepAgrmtFsWeb.confirmSepAgrmt/1.0";
const API_RESIGN_APPROVE = XT + "xtop.lpd.rights.knightSepAgrmtFsWeb.approveCancelSeqAgrmt/1.0";
const LS_RESIGN = "wb_todo_resign_v1";
const LS_RESIGN_AUTO = "wb_todo_resign_auto_v1";
const LS_RESIGN_AUTO_H = "wb_todo_resign_auto_h_v1";   // 自动确认阈值（小时），默认 12
const RESIGN_PAGE_URL = "https://aeolus.ele.me/?targetId=66300#/app/xuanxing/hooh-mixin/fengshen-rider-resignation/index.html";
const LEDGER_DAYS = 30;        // 台账取值窗口：跟台账明细页默认的「近 30 天」一致
const OSS_APP = {
  appId: "94A54F5D-F7D0-A69B-10A6-E2D591F33010",
  ossCredentials: "CDAAD9C3-551E-2378-8436-98F17175FA48"
};
/** 培训表字段（顺序即报表列顺序，用于 guid 兜底匹配）。 */
const TRAIN_FIELDS = [
  ["mmmk0dnd7_oxgqct", "商类型"], ["mm36phkpx_02o28o", "城市"],
  ["mm36pf415_x08yhx", "knight_id"], ["mm36pf415_4ptepm", "骑手姓名"],
  ["mm3heag6w_q4ilc8", "站点id"], ["mm3heaii5_x5xvft", "站点名称"],
  ["mm56glinz_w0wisi", "新骑手类型[纯新骑手/回归骑手/换商骑手]"],
  ["mm3ftrmzc_f0g5uc", "新骑手属于代理id"], ["mm3ftrpdd_onvd8s", "新骑手属于代理商"],
  ["mm36pf417_e2pj15", "考核期内是否在职"], ["mmmmzy87n_ejhvs3", "是否需要参加培训"],
  ["mm3bqpbij_8784sq", "是否有效完成培训"], ["mmmn02ios_vki9zc", "距离截止天数"],
  ["mm36pi6s1_wmsd2i", "首跑或回归绑定日期"], ["mm3bqpfps_tbzmkd", "完成培训截止日期"],
  ["mm36pjj35_xx3up7", "快乐出发安全回家"], ["mm36pjj36_wpg5lk", "让每一次骑行都安全回家一"],
  ["mm36pjj37_wfn3mc", "让每一次骑行都安全回家二"], ["mm36pjj37_afn5nz", "文明配送从我做起一"],
  ["mm36pjj38_qbpe1e", "文明配送从我做起二"], ["mm36pjj38_aiilnq", "预防火灾保护生命"],
  ["mm36pk2ds_2vzitc", "台账上传时间"], ["mm36pk624_o9tyjw", "台账检核状态"],
  ["mmmkcvzlv_z0up8q", "培训课程考试完成日期list"], ["mmdmzqxjm_72zx7v", "数据分区日期[当前天减1属于正常]"]
];
const TRAIN_GUIDS = TRAIN_FIELDS.map((f) => f[0]);
const TRAIN_GUID_NAME = new Map(TRAIN_FIELDS);
const TRAIN_COND = {
  distance: { id: "mmmn03ao6_9mz4f4", name: "en-mmmn03ao6_q29gpj", field: "距离截止天数" },
  need: { id: "mmayskiff_pdi9ke", name: "en-mmayskifg_9l5kfz", field: "是否需要参加培训" },
  done: { id: "xuhecaec", name: "en-xuhecaec", field: "是否有效完成培训" }
};
const TASK_PAGE_URL = "https://aeolus.ele.me/?targetId=51724#/task/list";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const DEFAULT_WARN = { default: 0, groups: {} };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => String(Math.round(num(v)));
const str = (v) => String(v == null ? "" : v).trim();

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  tasks: [], loading: false, error: "",
  filter: "warn", query: "",
  cfg: loadWarnCfg(), loadedAt: null,
  stations: loadStationCache(), stationLoading: false,
  training: [], trainingAt: 0, trainingLoading: false, trainingError: "", trainingViewUrl: "",
  trainSecHint: "",
  catCfg: loadCatCfg(),
  trainDays: 5,
  ledger: [], ledgerAt: 0, ledgerLoading: false, ledgerError: "",
  voided: loadVoided(),
  handled: new Map(), refreshAllBusy: false,
  resign: [], resignAt: 0, resignLoading: false, resignError: "", resignDebug: "",
  resignModal: null, resignBusy: false,
  resignAuto: localStorage.getItem(LS_RESIGN_AUTO) === "1",
  resignAutoH: loadResignAutoH(),
  resignAutoDone: new Set(), resignAutoFail: new Map(), resignAutoBusy: false,
  resignAutoErr: "",
  ledgerModal: null, ledgerBusy: false, ledgerPlayers: [],
  // v3.57.90 健康证待处理（未上传 / 即将过期 / 已过期，启用中）
  health: [], healthAt: 0, healthLoading: false, healthError: "",
  healthPartial: false, healthOrderError: "", healthTeams: [],
  healthOnly: localStorage.getItem("wb_todo_health_only_v1") === "1"
};

function loadWarnCfg() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_WARN) || "null");
    if (!o || typeof o !== "object") return { default: 0, groups: {} };
    const groups = {};
    for (const [k, v] of Object.entries(o.groups || {})) {
      if (v === null) groups[k] = null;
      else if (Number.isFinite(Number(v)) && Number(v) >= 0) groups[k] = Math.round(Number(v));
    }
    return {
      default: Number.isFinite(Number(o.default)) && Number(o.default) >= 0 ? Math.round(Number(o.default)) : 0,
      groups
    };
  } catch (e) { return { default: 0, groups: {} }; }
}
function saveWarnCfg() {
  try { localStorage.setItem(LS_WARN, JSON.stringify(state.cfg)); } catch (e) { /* ignore */ }
}
function warnCfgText(v) { return v === null ? "不限" : `${int(v)} 天`; }
function loadTrainDays() {
  const raw = localStorage.getItem(LS_TRAIN_DAYS);
  if (raw == null || raw === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 30 ? Math.round(n) : 5;
}
function saveTrainDays(n) {
  try { localStorage.setItem(LS_TRAIN_DAYS, String(n)); } catch (e) { /* ignore */ }
}
function loadTrainCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_TRAIN) || "null");
    if (!o || !Array.isArray(o.rows) || o.days !== state.trainDays) return null;
    if (!o.ts || Date.now() - o.ts > 5 * 60 * 1000) return null;
    return o;
  } catch (e) { return null; }
}
function saveTrainCache(rows) {
  try {
    localStorage.setItem(LS_TRAIN, JSON.stringify({ ts: Date.now(), days: state.trainDays, rows }));
  } catch (e) { /* ignore */ }
}

/** 任务对象里的骑手 / 站点 / 服务商信息。 */
function taskObjectInfo(t) {
  const raw = str(t.taskObject);
  const m = /^(\d+)\(([^)]*)\)(.*)$/.exec(raw);
  return {
    id: m ? m[1] : "",
    kind: m ? m[2] : "",
    name: m ? m[3].trim() : raw,
    raw
  };
}
function riderOf(t) {
  const o = taskObjectInfo(t);
  return /骑手/.test(o.kind) ? { id: o.id, name: o.name } : null;
}
function stationOf(t) {
  const o = taskObjectInfo(t);
  if (/骑手/.test(o.kind)) return t.station || o.name || "—";
  if (/站点/.test(o.kind)) return o.name || "—";
  if (/服务商/.test(o.kind)) return o.name || "全商";
  if (/^【安全】/.test(str(t.taskName))) return "全商";
  return o.name || "—";
}
function loadStationCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_STATION) || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
function saveStationCache() {
  try { localStorage.setItem(LS_STATION, JSON.stringify(state.stations)); } catch (e) { /* ignore */ }
}
/** 骑手任务用任务详情里的 taskObject（站点名）补站点，带并发限制与本地缓存。 */
async function enrichStations(tasks) {
  const pending = tasks.filter((t) => {
    const r = riderOf(t);
    return r && !state.stations[t.taskInstanceId];
  });
  if (!pending.length) return;
  state.stationLoading = true;
  let idx = 0;
  const worker = async () => {
    while (idx < pending.length) {
      const t = pending[idx++];
      try {
        const j = await request(API_TASK_DETAIL, { params: { taskInstanceId: t.taskInstanceId } });
        const d = (j && j.result && j.result.data) || {};
        const obj = str(d.taskObject);
        const o = /^(\d+)\(([^)]*)\)(.*)$/.exec(obj);
        const station = /站点/.test(o ? o[2] : "") ? (o[3] || "").trim() : (obj || "");
        if (station) state.stations[t.taskInstanceId] = station;
      } catch (e) { /* 单个任务失败不影响其他行 */ }
    }
  };
  await Promise.all(new Array(Math.min(4, pending.length)).fill(0).map(worker));
  saveStationCache();
  state.stationLoading = false;
  for (const t of tasks) {
    if (state.stations[t.taskInstanceId]) t.station = state.stations[t.taskInstanceId];
  }
}

function extMsg(msg) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || {}));
        return;
      }
    } catch (e) { /* ignore */ }
    resolve({});
  });
}
async function direct(url, payload) {
  const body = JSON.stringify(payload || {});
  // 优先交给后台 SW 代发（不受扩展页 CORS 限制），失败再退回页面直连
  try {
    const viaSw = await extMsg({
      type: "FETCH_PROXY", url, method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" }, body
    });
    if (viaSw && typeof viaSw.text === "string" && viaSw.text) {
      return JSON.parse(viaSw.text);
    }
    if (viaSw && viaSw.error) {
      // 代理报错时继续尝试直连
    }
  } catch (e) { /* ignore */ }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    credentials: "include",
    body
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
async function bridge(url, payload) {
  const resp = await extMsg({ type: "BRIDGE_API", api: url, payload: payload || {} });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应（可能尚未登录风神）");
  return resp.json;
}
async function request(url, payload) {
  const first = state.via;
  try { return first === "direct" ? await direct(url, payload) : await bridge(url, payload); }
  catch (e) {
    const second = first === "direct" ? "bridge" : "direct";
    state.via = second;
    try { return second === "direct" ? await direct(url, payload) : await bridge(url, payload); }
    catch (e2) { state.via = first; throw e2; }
  }
}

let noticeTimer = null;
function showNotice(msg, tone, autoHide) {
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  const n = $("notice");
  if (!n) return;
  if (!msg) { n.hidden = true; n.textContent = ""; return; }
  n.hidden = false;
  n.textContent = msg;
  n.style.borderColor = tone === "err" ? "#FCA5A5" : "#93C5FD";
  n.style.background = tone === "err" ? "#FEF2F2" : "#EFF6FF";
  if (autoHide) {
    noticeTimer = setTimeout(() => { noticeTimer = null; showNotice(""); }, autoHide);
  }
}

function taskGroup(t) {
  const name = str(t.taskName);
  if (/^【安全】/.test(name)) return "【安全】";
  const first = name.split("-")[0].trim();
  return first || str(t.taskCategory) || "其他任务";
}
function taskThreshold(group) {
  const g = state.cfg.groups;
  if (Object.prototype.hasOwnProperty.call(g, group)) return g[group];
  return state.cfg.default;
}
function parseTime(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
function ymdTime(d) {
  if (!d) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function shortTime(d) {
  if (!d) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dayDiff(d) {
  if (!d) return null;
  const now = new Date();
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86400000);
}
function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0分";
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}天${h ? h + "小时" : ""}`;
  if (h > 0) return `${h}小时${m ? m + "分" : ""}`;
  return `${m}分`;
}
function remainText(exp) {
  if (!exp) return "—";
  const ms = exp.getTime() - Date.now();
  return ms < 0 ? `已超时 ${durationText(-ms)}` : `剩 ${durationText(ms)}`;
}
/** 预警级别：overdue / today / warn / unlimited / ok */
function warnState(t) {
  const exp = t.expAt;
  if (!exp) return { level: "ok", label: "—", days: null };
  const days = dayDiff(exp);
  const th = taskThreshold(t.group);
  if (days < 0) return { level: "overdue", label: `已超时`, days };
  if (days === 0) return { level: "today", label: "今日到期", days };
  if (th === null) return { level: "unlimited", label: "不限", days };
  if (days <= th) return { level: "warn", label: `预警 ${days}天`, days };
  return { level: "ok", label: "—", days };
}
function isWarn(s) { return s.level !== "ok"; }

/** Quark 报表的会话密钥 secParam 只在报表页面（服务端渲染的配置）里，取一次缓存起来复用。 */
function loadTrainSec() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_TRAIN_SEC) || "null");
    if (o && o.sec) return o;
  } catch (e) { /* ignore */ }
  return null;
}
function saveTrainSec(sec, token) {
  try { localStorage.setItem(LS_TRAIN_SEC, JSON.stringify({ sec, token: token || "", ts: Date.now() })); }
  catch (e) { /* ignore */ }
}
function clearTrainSec() {
  try { localStorage.removeItem(LS_TRAIN_SEC); } catch (e) { /* ignore */ }
}

/** 扩展页直连被 CORS/重定向拦住时，交给后台 SW 代取；失败再退回页面 fetch。 */
async function proxyText(url, opts) {
  // v3.57.97：网络抖动 / SW 刚好重启时 "Failed to fetch" 很常见，自动重试一次再报错
  let resp = null;
  let swErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await extMsg(Object.assign({ type: "FETCH_PROXY", url }, opts || {}));
    } catch (e) { resp = null; }
    if (resp && (resp.ok || resp.text != null)) return resp;
    if (resp && resp.error) swErr = String(resp.error);
    if (attempt === 0) await sleepMs(400);
  }
  const init = { method: (opts && opts.method) || "GET", credentials: "include" };
  if (opts && opts.headers) init.headers = opts.headers;
  if (opts && opts.body != null) init.body = opts.body;
  let lastMsg = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, init);
      return { ok: r.ok, status: r.status, finalUrl: r.url, text: await r.text() };
    } catch (e) {
      lastMsg = String((e && e.message) || e);
      if (attempt === 0) await sleepMs(400);
    }
  }
  throw new Error(swErr ? `后台代取失败：${swErr}；直连也失败：${lastMsg}` : lastMsg);
}

/** 在报表页里等 PageInfo 就绪，取 secParam（该函数会被序列化注入页面，不能引用外部变量）。 */
async function readPageInfoSec() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const pi = window.PageInfo;
    if (pi && pi.widgets && pi.secParam) break;
    await sleep(400);
  }
  const pi = window.PageInfo;
  if (!pi) return null;
  return {
    sec: pi.secParam || "",
    token: (pi.auth && pi.auth.reportIdToken) || ""
  };
}
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(on); } catch (e) { /* ignore */ }
      resolve();
    };
    const on = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    try { chrome.tabs.onUpdated.addListener(on); } catch (e) { /* ignore */ }
    setTimeout(finish, timeout);
  });
}

const FBI_PAGE_URL = "https://aeolus.ele.me/?targetId=51676#/fbi";
const TRAIN_META_API = "https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=" + TRAIN_REPORT_ID;
async function resolveTrainViewUrl() {
  try {
    const r = await extMsg({ type: "FETCH_PROXY", url: TRAIN_META_API });
    if (r && r.text) {
      const j = JSON.parse(r.text);
      if (j && j.data && j.data.url) return j.data.url;
    }
  } catch (e) { /* next */ }
  try {
    const r = await extMsg({ type: "BRIDGE_GET", url: TRAIN_META_API });
    if (r && r.ok && r.json && r.json.data && r.json.data.url) return r.json.data.url;
  } catch (e) { /* next */ }
  try {
    const j = await fetch(TRAIN_META_API, { credentials: "include" }).then((x) => x.json());
    if (j && j.data && j.data.url) return j.data.url;
  } catch (e) { /* ignore */ }
  return "";
}

/** v3.57.64/65：取不到 secParam 时，后台静默打开一次 FBI 报表页，读到密钥后立即关闭。 */
async function recoverTrainSec() {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) return null;
  const urls = [];
  showNotice("培训密钥失效，正在后台打开 FBI 报表页取密钥（读完自动关闭）…", "", 6000);
  const view = state.trainingViewUrl || await resolveTrainViewUrl();
  if (view) { state.trainingViewUrl = view; urls.push(view); }
  urls.push(FBI_PAGE_URL);
  for (const url of urls) {
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      await waitTabComplete(tab.id, 20000);
      await sleepMs(3000);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, allFrames: true, world: "MAIN", func: readPageInfoSec
      });
      for (const item of res || []) {
        const out = item && item.result;
        if (out && out.sec) {
          saveTrainSec(out.sec, out.token);
          return { sec: out.sec, token: out.token };
        }
      }
    } catch (e) { /* 换下一个地址 */ }
    finally {
      if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ } }
    }
  }
  return null;
}

async function fetchWidget(j, token, sec) {
  const body = Object.assign({}, j);
  if (token) body.reportIdToken = token;
  if (sec) body.secureParams = sec;
  body.metaTime = new Date().toISOString().replace("T", " ").slice(0, 19);
  const resp = await proxyText(QUARK_WIDGET, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "params=" + encodeURIComponent(JSON.stringify(body))
  });
  try { return JSON.parse(resp.text || "null"); } catch (e) { throw new Error("培训数据接口返回异常（非 JSON）"); }
}

/** 打开报表视图页拉一次配置，抠出 secParam（6MB 左右，只在失效时走一次）。 */
async function refreshTrainSec() {
  // 优先让 SW 直接返回 secParam：6MB 报表页不过消息通道，也不受页面 CORS 影响
  try {
    const r = await extMsg({ type: "QUARK_SEC", reportId: TRAIN_REPORT_ID });
    if (r && r.ok && r.sec) {
      if (r.url) state.trainingViewUrl = r.url;
      saveTrainSec(r.sec, r.token);
      return { sec: r.sec, token: r.token };
    }
    if (r && r.url) state.trainingViewUrl = r.url;
    if (r && r.error) state.trainSecHint = String(r.error);
  } catch (e) { /* 回退到下面的直连/代理路径 */ }
  if (state.trainSecHint) throw new Error(state.trainSecHint);
  const meta = await proxyText("https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=" + TRAIN_REPORT_ID);
  let j = null;
  try { j = JSON.parse(meta.text || "null"); } catch (e) { j = null; }
  const url = j && j.data && j.data.url;
  if (!url) throw new Error("没有取到培训报表地址（风神登录态可能已过期）");
  state.trainingViewUrl = url;
  const page = await proxyText(url);
  const html = page.text || "";
  const pick = (key) => {
    const i = html.indexOf('\\"' + key + '\\":\\"');
    if (i < 0) return "";
    const from = i + key.length + 6;
    const to = html.indexOf('\\"', from);
    return to > from ? html.slice(from, to).replace(/\\\//g, "/") : "";
  };
  const sec = pick("secParam");
  const token = pick("reportIdToken");
  if (!sec) {
    throw new Error(state.trainSecHint
      || "报表配置里没有拿到访问密钥（可能需要重新登录风神 / 打开一次 FBI 报表）");
  }
  saveTrainSec(sec, token);
  return { sec, token };
}

function trainWidgetJob(days) {
  const distValues = [];
  for (let i = 1; i <= days; i++) distValues.push(String(i));
  const configs = [
    { datasetGuid: TRAIN_DATASET_ID, type: "datasetId" },
    { datasetGuid: TRAIN_DATASET_ID, type: "count", config: { needCount: true } },
    { datasetGuid: TRAIN_DATASET_ID, type: "field", config: { guids: TRAIN_GUIDS } }
  ];
  const push = (c, values) => configs.push({
    datasetGuid: TRAIN_DATASET_ID, type: "condition",
    config: { id: c.id, name: c.name, value: values, valueType: "multiSelect" }
  });
  push(TRAIN_COND.distance, distValues);
  push(TRAIN_COND.need, ["是"]);
  push(TRAIN_COND.done, ["未完成"]);
  return { widgetId: "kmrd93s7", queryId: "mm2x84uv1_28gk3z", dataType: "unifiedTable", configs, needDebugInfo: false, reportId: TRAIN_REPORT_ID };
}

/** 解析表格返回：优先用列标题，标题缺失时用 guid 兜底。 */
function parseTrainTable(value, days) {
  const cols = (value.columns || []).map((c) => {
    const p = (c.cells && c.cells[0] && c.cells[0].props) || {};
    return p.label || TRAIN_GUID_NAME.get(p.guid) || "";
  });
  const ix = new Map();
  cols.forEach((label, i) => { if (label && !ix.has(label)) ix.set(label, i); });
  const get = (row, name) => {
    const i = ix.get(name);
    return i == null || !row[i] ? "" : String(row[i].v == null ? "" : row[i].v);
  };
  const seen = new Set();
  const rows = [];
  for (const row of (value.values || [])) {
    const need = get(row, "是否需要参加培训");
    const done = get(row, "是否有效完成培训");
    const n = Number(get(row, "距离截止天数"));
    if (need !== "是" || done !== "未完成") continue;
    if (!Number.isFinite(n) || n < 1 || n > days) continue;
    const rid = get(row, "knight_id");
    const expire = get(row, "完成培训截止日期");
    const key = rid + "|" + expire;
    if (seen.has(key)) continue;
    seen.add(key);
    const courses = [
      ["快乐出发安全回家", "快乐出发安全回家"],
      ["让每一次骑行都安全回家一", "让每一次骑行都安全回家一"],
      ["让每一次骑行都安全回家二", "让每一次骑行都安全回家二"],
      ["文明配送从我做起一", "文明配送从我做起一"],
      ["文明配送从我做起二", "文明配送从我做起二"],
      ["预防火灾保护生命", "预防火灾保护生命"]
    ].map(([label, col]) => ({ label, done: get(row, col) === "已完成" }));
    rows.push({
      rid, name: get(row, "骑手姓名"), stationId: get(row, "站点id"),
      station: get(row, "站点名称"), newType: get(row, "新骑手类型[纯新骑手/回归骑手/换商骑手]"),
      distance: n, expire, bindDate: get(row, "首跑或回归绑定日期"),
      ledgerStatus: get(row, "台账检核状态"), ledgerTime: get(row, "台账上传时间"),
      examDates: get(row, "培训课程考试完成日期list"),
      courses, courseDone: courses.filter((c) => c.done).length, done, need
    });
  }
  return rows;
}

/** 直接走 Quark 报表接口取培训数据，不打开任何标签页。 */
async function fetchTraining(opts) {
  const silent = !!(opts && opts.silent);
  if (state.trainingLoading) return;
  state.trainingLoading = true;
  state.trainingError = "";
  state.trainSecHint = "";
  renderAll();
  try {
    const days = Math.max(1, Math.min(30, Math.round(state.trainDays) || 5));
    const job = trainWidgetJob(days);
    let ok = false, lastErr = null;
    // v3.57.97：取数层偶发 "Failed to fetch"（网络抖动 / SW 正在重启）自动重试，不直接报失败
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let cached = loadTrainSec();
        let j = await fetchWidget(job, cached && cached.token, cached && cached.sec);
        if (!j || j.code !== 0 || !j.data || !j.data.value) {
          let fresh = null;
          try {
            fresh = await refreshTrainSec();
          } catch (e) {
            fresh = await recoverTrainSec();
            if (!fresh) throw e;
          }
          j = await fetchWidget(job, fresh.token, fresh.sec);
        }
        const value = j && j.data && j.data.value;
        if (!value) {
          const msg = (j && (j.message || j.finalMessage)) || "培训数据接口返回异常";
          if (/token|登录|permission|权限/i.test(msg)) clearTrainSec();
          throw new Error(msg);
        }
        if (!(value.columns || []).length) throw new Error("培训表结构变化，没有读取到列");
        const rows = parseTrainTable(value, days);
        state.training = rows;
        state.trainingAt = Date.now();
        saveTrainCache(rows);
        if (!silent) {
          showNotice(`已刷新新骑手培训待办 ${rows.length} 条（近 ${days} 天到期、需培训且未完成）。`, "", 3000);
        }
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        const transient = /Failed to fetch|NetworkError|network error|HTTP 5\d\d|接口返回异常（非 JSON）/i.test(msg);
        if (!transient || attempt >= 2) throw e;
        if (!silent) showNotice(`培训数据网络波动（${msg}），正在第 ${attempt + 2} 次尝试…`, "", 2500);
        await sleepMs(800 * (attempt + 1));
      }
    }
    if (!ok && lastErr) throw lastErr;
  } catch (e) {
    state.trainingError = String((e && e.message) || e);
    if (!silent) showNotice(`培训待办读取失败：${state.trainingError}。可直接点「刷新培训」重试。`, "err");
  } finally {
    state.trainingLoading = false;
    renderAll();
  }
}

/** 刚审核/作废过的台账 id，短时间内不再出现在待审核里（防服务端延迟）。 */
function handledRecently(id) {
  const key = String(id);
  const ts = state.handled.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 5 * 60 * 1000) { state.handled.delete(key); return false; }
  return true;
}
function markHandled(id) { state.handled.set(String(id), Date.now()); }

function loadVoided() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_VOIDED) || "[]");
    return new Set(Array.isArray(o) ? o.map(String) : []);
  } catch (e) { return new Set(); }
}
function saveVoided(set) {
  try { localStorage.setItem(LS_VOIDED, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}
function loadLedgerCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_LEDGER) || "null");
    if (!o || !Array.isArray(o.rows)) return null;
    if (!o.ts || Date.now() - o.ts > 5 * 60 * 1000) return null;
    return o;
  } catch (e) { return null; }
}
function saveLedgerCache(rows) {
  try { localStorage.setItem(LS_LEDGER, JSON.stringify({ ts: Date.now(), rows })); } catch (e) { /* ignore */ }
}
function ledgerIsThreeCard(r) { return /三级教育/.test(str(r.templateName)); }
function ledgerRider(r) {
  const d = str(r.knightInfoDesc);
  const m = /^(\d+)_(.*)$/.exec(d);
  return { id: str(r.knightInfoId) || (m ? m[1] : ""), name: m ? m[2] : d };
}
function ledgerPassed(r) { return num(r.checkResult) === 2; }
/** 台账状态：未上传 / 待检核 / 已检核 / 未通过；平台二审状态放 title。 */
function ledgerState(r) {
  if (!r) return { key: "none", label: "台账未上传", cls: "none", tip: "" };
  if (!r.checkAt) return { key: "check", label: "台账待检核", cls: "pend", tip: "还没检核" };
  if (ledgerPassed(r)) {
    return { key: "pass", label: "台账已检核", cls: "ok", tip: str(r.auditStatusDesc) || "已检核通过" };
  }
  return { key: "fail", label: "台账未通过", cls: "bad", tip: str(r.reason) || "检核不通过" };
}
/** 台账是否有效（status=2 是被作废的台账，不算待审核）。 */
function ledgerValid(r) { return num(r.status) === 1; }
/** 近 30 天上传、还没检核的台账（预警对象，排除已作废）。 */
function ledgerPending() {
  const from = Date.now() - num(state.catCfg.ledgerDays || 30) * 86400000;
  return state.ledger
    .filter((r) => ledgerValid(r) && !r.checkAt && num(r.createAt) >= from
      && !state.voided.has(String(r.id)) && !handledRecently(r.id))
    .sort((a, b) => {
      const ac = ledgerIsThreeCard(a) ? 1 : 0;
      const bc = ledgerIsThreeCard(b) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return num(b.createAt) - num(a.createAt);
    });
}
/** 骑手 id → 最新一条三级教育卡台账。 */
function threeCardIndex() {
  const map = new Map();
  for (const r of state.ledger) {
    if (!ledgerIsThreeCard(r)) continue;
    if (!ledgerValid(r) || state.voided.has(String(r.id))) continue;
    const rid = ledgerRider(r).id;
    if (!rid) continue;
    const cur = map.get(rid);
    if (!cur || num(r.createAt) > num(cur.createAt)) map.set(rid, r);
  }
  return map;
}

async function fetchLedger(opts) {
  const silent = !!(opts && opts.silent);
  const force = !!(opts && opts.force);
  if (state.ledgerLoading) {
    if (force) setTimeout(() => fetchLedger({ silent, force: true }), 800);
    return;
  }
  state.ledgerLoading = true;
  state.ledgerError = "";
  renderAll();
  try {
    const now = new Date();
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const rows = [];
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const j = await request(API_LEDGER_LIST, {
        params: { request: { pageSize: 100, createAtStart: t0 - LEDGER_DAYS * 86400000, createAtEnd: t0 + 86400000 - 1000, pageIndex: page } }
      });
      const d = (j && j.result && j.result.data) || {};
      const list = Array.isArray(d.data) ? d.data : [];
      total = num(d.total);
      rows.push(...list);
      if (!list.length || rows.length >= total) break;
    }
    state.ledger = rows;
    state.ledgerAt = Date.now();
    saveLedgerCache(rows);
    if (!silent) {
      const pend = ledgerPending().length;
      showNotice(`已刷新台账明细 ${rows.length} 条，其中近 ${int(state.catCfg.ledgerDays)} 天待审核 ${pend} 条。`, "", 3000);
    }
  } catch (e) {
    state.ledgerError = String((e && e.message) || e);
    if (!silent) showNotice(`台账明细读取失败：${state.ledgerError}。可直接点「刷新台账」重试。`, "err");
  } finally {
    state.ledgerLoading = false;
    renderAll();
  }
}

function ledgerFileKind(hash) {
  const m = /(mp4|mov|m4v|jpe?g|png|gif|webp|bmp|pdf|mp3|wav|m4a)$/i.exec(str(hash).toLowerCase());
  const k = m ? m[1] : "";
  if (/^mp4|mov|m4v$/.test(k)) return "video";
  if (/^jpe?g$|png|gif|webp|bmp/.test(k)) return "image";
  if (k === "pdf") return "pdf";
  if (/mp3|wav|m4a/.test(k)) return "audio";
  return "file";
}
function ledgerMime(hash) {
  const h = str(hash).toLowerCase();
  if (/mp4$/.test(h)) return "video/mp4";
  if (/mov$|m4v$/.test(h)) return "video/quicktime";
  if (/pdf$/.test(h)) return "application/pdf";
  if (/png$/.test(h)) return "image/png";
  if (/gif$/.test(h)) return "image/gif";
  if (/webp$/.test(h)) return "image/webp";
  if (/bmp$/.test(h)) return "image/bmp";
  if (/jpe?g$/.test(h)) return "image/jpeg";
  if (/mp3$/.test(h)) return "audio/mpeg";
  if (/wav$/.test(h)) return "audio/wav";
  if (/m4a$/.test(h)) return "audio/mp4";
  return "application/octet-stream";
}
function hevcSupported() {
  const v = document.createElement("video");
  return !!v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
}
/** 读 MP4 头部 stsd，拿到视频编码 fourcc（hvc1 / hev1 / avc1 ...）。 */
async function probeVideoCodec(url) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-262143" } });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 200) return "";
    const needle = [0x73, 0x74, 0x73, 0x64];
    let idx = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] === needle[0] && buf[i + 1] === needle[1] && buf[i + 2] === needle[2] && buf[i + 3] === needle[3]) { idx = i; break; }
    }
    if (idx < 0 || idx + 20 > buf.length) return "";
    return String.fromCharCode(buf[idx + 16], buf[idx + 17], buf[idx + 18], buf[idx + 19]).trim();
  } catch (e) { return ""; }
}
function videoFallbackHtml(url, idx, row) {
  return `<div class="lg-vf" data-vf-idx="${idx}">` +
    `<div class="lg-vf-tip">这个视频是 <b>H.265（HEVC）</b> 编码，Chrome 内核无法内嵌播放（只有声音）。</div>` +
    `<div class="lg-vf-acts"><button type="button" class="primary lg-vf-open" data-vf-url="${esc(url)}">用系统播放器打开</button>` +
    `<a class="lg-vf-link" href="${esc(url)}" target="_blank" rel="noreferrer">在新标签打开</a></div>` +
    `<div class="lg-vf-note">点按钮会下载到浏览器下载目录并自动用系统播放器（QuickTime / IINA）打开。</div></div>`;
}

let hevcPlayerModPromise = null;
/** 用 WASM 软解把 HEVC 画到 canvas 上，内嵌播放。 */
async function mountHevcInline(container, url, name) {
  try {
    if (!hevcPlayerModPromise) {
      hevcPlayerModPromise = import(chrome.runtime.getURL("hevc-player.js"));
    }
    const mod = await hevcPlayerModPromise;
    const destroy = await mod.mountHevcPlayer(container, { url, name, fallbackUrl: url });
    const mask = $("td-lg-mask");
    if (typeof destroy === "function") {
      if (!mask || mask.hidden) destroy();
      else state.ledgerPlayers.push(destroy);
    }
  } catch (e) {
    container.innerHTML = videoFallbackHtml(url, 1, null) +
      `<div class="lg-vf-note">软解加载失败：${esc(String((e && e.message) || e))}</div>`;
  }
}

/** 下载到本机并用系统默认播放器打开（兜底）。 */
function openInSystemPlayer(url, filename) {
  const safe = String(filename || "ledger-video.mp4").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  if (typeof chrome === "undefined" || !chrome.downloads || !chrome.downloads.download) {
    window.open(url, "_blank", "noopener");
    return;
  }
  chrome.downloads.download({ url, filename: safe, saveAs: false, conflictAction: "overwrite" }, (id) => {
    if (chrome.runtime.lastError || !id) {
      window.open(url, "_blank", "noopener");
      return;
    }
    const open = () => { try { chrome.downloads.open(id); } catch (e) { /* ignore */ } };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current !== "complete") return;
      chrome.downloads.onChanged.removeListener(onChanged);
      open();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }, (items) => {
      if (items && items[0] && items[0].state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        open();
      }
    });
  });
}

/** HEVC 视频：Chrome 只能解出音轨，画面全黑，这里检测到后给系统播放器入口。 */
function bindVideoFallback(container, row) {
  if (!container) return;
  container.querySelectorAll("video.lg-media-v").forEach((v) => {
    let done = false;
    const mark = () => {
      if (done || v.videoWidth > 0) return;
      done = true;
      const wrap = document.createElement("div");
      wrap.className = "lg-vf";
      const name = `${str(row && row.name) || "台账附件"}-${String(v.dataset.idx || "1")}`;
      wrap.innerHTML = `<div class="lg-vf-tip">这个视频是 <b>H.265（HEVC）</b> 编码，Chrome 内核无法内嵌播放（只有声音）。</div>` +
        `<div class="lg-vf-acts"><button type="button" class="primary lg-vf-open">用系统播放器打开</button>` +
        `<a class="lg-vf-link" href="${esc(v.src)}" target="_blank" rel="noreferrer">在新标签打开</a></div>` +
        `<div class="lg-vf-note">点按钮会下载到浏览器下载目录并自动用系统播放器打开（如 QuickTime / IINA）。</div>`;
      v.replaceWith(wrap);
      const btn = wrap.querySelector(".lg-vf-open");
      if (btn) btn.addEventListener("click", () => openInSystemPlayer(v.src, name + ".mp4"));
    };
    v.addEventListener("loadeddata", () => { if (!v.videoWidth) mark(); });
    v.addEventListener("error", mark);
    setTimeout(() => { if (v.readyState >= 1 && !v.videoWidth) mark(); }, 3500);
  });
}

function ledgerMediaHtml(url, hash) {
  const kind = ledgerFileKind(hash);
  const u = esc(url);
  if (kind === "video") return `<video class="lg-media-v" controls preload="metadata" playsinline src="${u}"></video>`;
  if (kind === "image") return `<a class="lg-media-a" href="${u}" target="_blank" rel="noreferrer"><img class="lg-media-i" src="${u}" alt="附件"></a>`;
  if (kind === "audio") return `<audio class="lg-media-a2" controls preload="metadata" src="${u}"></audio>`;
  if (kind === "pdf") return `<iframe class="lg-media-pdf" src="${u}#zoom=page-width&view=FitH" title="附件"></iframe>`;
  return `<a class="lg-media-link" href="${u}" target="_blank" rel="noreferrer">打开附件</a>`;
}

// ---------------------------------------------------------------- 离职待审核
function loadResignCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_RESIGN) || "null");
    if (!o || !Array.isArray(o.rows)) return null;
    if (!o.ts || Date.now() - o.ts > 5 * 60 * 1000) return null;
    return o;
  } catch (e) { return null; }
}
function saveResignCache(rows) {
  try { localStorage.setItem(LS_RESIGN, JSON.stringify({ ts: Date.now(), rows })); } catch (e) { /* ignore */ }
}
// 「已撤销 / 撤销通过 / 已通过 / 已拒绝 …」都含「撤销」或「通过」这类字眼，
// 必须先排除终态，否则历史记录（"已撤销"）会被误判成「撤销待审核」。
const RESIGN_DONE_RE = /已撤销|撤销通过|撤销成功|已通过|审核通过|已拒绝|已驳回|已失效|已取消|已终止|已完成|已过期|已关闭/;
/** 接口状态字段名不统一（stateCode / fsSeqAgrmtStateCode / stateName…），统一补 stateCode：
 *  created = 待审核离职日期，cancelProcessCreated = 撤销申请待审核。 */
function resignStateCode(r) {
  const raw = str(r.stateCode || r.fsSeqAgrmtStateCode || r.seqAgrmtStateCode
    || r.processStateCode || r.agreementStateCode || r.state || "");
  if (raw === "created" || raw === "cancelProcessCreated") return raw;   // 接口给了明确状态码就用它
  const name = str(r.stateName || r.statusName || r.stateDesc || "");
  if (RESIGN_DONE_RE.test(name)) return raw;        // 终态：原样保留，不算待审核
  if (/待审核|审核中|待处理/.test(name)) {
    return /撤销/.test(name) ? "cancelProcessCreated" : "created";
  }
  return raw;
}
function normalizeResignRows(rows) {
  return (rows || []).map((r) => ({ ...r, stateCode: resignStateCode(r) }));
}
/** 这条申请是不是「待审核」（终态一律排除，避免历史数据混进来）。 */
function resignIsPendingRow(r) {
  const name = str(r.stateName || r.statusName || r.stateDesc || "");
  if (RESIGN_DONE_RE.test(name)) return false;
  return r.stateCode === "created" || r.stateCode === "cancelProcessCreated"
    || /待审核|审核中|待处理/.test(name);
}
/** created = 待审核离职日期；cancelProcessCreated = 撤销申请待审核。 */
function resignPending() {
  const limitMs = num(state.catCfg.resignHours || 72) * 3600 * 1000;
  return state.resign
    .filter(resignIsPendingRow)
    .filter((r) => {
      const ts = toMs(r.initiatingAt);
      if (!ts) return true;
      return ts + 72 * 3600 * 1000 - Date.now() <= limitMs;
    })
    .sort((a, b) => num(a.initiatingAt) - num(b.initiatingAt));
}
/** 从各种返回结构里挖出列表（data / list / records / 嵌套一层）。 */
function resignExtract(j) {
  const pack = j && (j.result !== undefined ? j.result : j.data);
  const cands = [];
  const dig = (o, depth) => {
    if (!o || depth > 2 || typeof o !== "object") return;
    if (Array.isArray(o)) { cands.push({ list: o, total: o.length }); return; }
    for (const k of ["data", "list", "records", "items", "rows"]) {
      if (Array.isArray(o[k])) cands.push({ list: o[k], total: num(o.total != null ? o.total : (o.totalCount != null ? o.totalCount : o[k].length)) });
    }
    for (const k of ["data", "result", "page", "payload"]) {
      if (o[k] && typeof o[k] === "object") dig(o[k], depth + 1);
    }
  };
  dig(pack, 0);
  cands.sort((a, b) => b.list.length - a.list.length);
  return cands[0] || { list: [], total: 0 };
}
/** 参数包裹方式在不同 xtop 服务里不一致，这里依次试几种，取第一个有数据的。 */
async function resignFetchPage(pageIndex, pageSize, condition) {
  const cond = condition || {};
  const body = { pageIndex, pageSize, condition: cond };
  const shapes = [
    { params: body },
    body,
    { params: { pageIndex, pageSize, ...cond } },
    { pageIndex, pageSize, ...cond },
    { params: { request: body } },
    { request: body }
  ];
  let lastRaw = null;
  let lastErr = "";
  for (const shape of shapes) {
    let j = null;
    try { j = await request(API_RESIGN_LIST, shape); } catch (e) { lastErr = String((e && e.message) || e); continue; }
    lastRaw = j;
    const got = resignExtract(j);
    if (got.list.length || got.total > 0) { state.resignDebug = ""; return got; }
  }
  // 有些 xtop 服务要求至少带一个筛选条件，空条件返回 0：再按待审核状态码试一次
  for (const code of ["created", "cancelProcessCreated"]) {
    for (const shape of [{ params: { pageIndex, pageSize, condition: { fsSeqAgrmtStateCode: code } } },
      { pageIndex, pageSize, condition: { fsSeqAgrmtStateCode: code } }]) {
      let j = null;
      try { j = await request(API_RESIGN_LIST, shape); } catch (e) { continue; }
      lastRaw = j;
      const got = resignExtract(j);
      if (got.list.length || got.total > 0) { state.resignDebug = ""; return got; }
    }
  }
  // 直连一直空：再用页面上下文（风神标签）发一次，带上 Referer / 登录态
  try {
    const bridged = await extMsg({ type: "BRIDGE_API", api: API_RESIGN_LIST, payload: shapes[0] });
    if (bridged && bridged.ok && bridged.json) {
      lastRaw = bridged.json;
      const got = resignExtract(bridged.json);
      if (got.list.length || got.total > 0) { state.resignDebug = ""; return got; }
    }
  } catch (e) { /* ignore */ }
  if (lastRaw) {
    state.resignDebug = `返回片段：${JSON.stringify(lastRaw).slice(0, 260)}`;
  } else if (lastErr) {
    state.resignDebug = `请求失败：${lastErr}`;
  }
  return { list: [], total: 0 };
}
/** 自动确认阈值（小时）：默认 12，可改 1~72，存在本机 */
function loadResignAutoH() {
  const n = Number(localStorage.getItem(LS_RESIGN_AUTO_H));
  if (!isFinite(n) || n <= 0) return 12;
  return Math.min(72, Math.max(1, Math.round(n)));
}
function resignAutoLabel() {
  const b = $("btn-resign-auto");
  const box = $("resign-auto-h");
  if (box && document.activeElement !== box) box.value = String(state.resignAutoH);
  if (!b) return;
  b.textContent = `自动确认：${state.resignAuto ? "开" : "关"}`;
  b.classList.toggle("is-on", !!state.resignAuto);
  b.title = `审批剩余不足 ${state.resignAutoH} 小时时，自动用最迟离职日期确认通过（当前${state.resignAuto ? "已开启" : "关闭"}，右侧可改阈值）`;
}
/** 离职操作类接口的参数包裹方式不统一（params / 裸参数 / params.request），
 *  依次试几种，返回第一个「业务成功」的结果；全部失败才抛出最后一次的错误。 */
async function callResignAction(url, inners) {
  const list = Array.isArray(inners) ? inners : [inners];
  const shapes = (inner) => [{ params: inner }, inner, { params: { request: inner } }];
  let lastErr = null;
  for (const inner of list) {
    for (const shape of shapes(inner)) {
      try {
        const j = await request(url, shape);
        const fail = ledgerCallFailed(j);
        if (!fail) return j;
        lastErr = new Error(fail);
        lastErr.raw = j;
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error("接口无响应");
}

/** confirmSepAgrmt 的 separationAt 可能是「YYYY-MM-DD」也可能是时间戳，两种都试。 */
function resignConfirmPayloads(row, date) {
  const base = { orgCode: row.orgCode, employeeId: row.employeeId };
  const dms = new Date(String(date) + "T00:00:00").getTime();
  const out = [{ ...base, separationAt: date }];
  if (Number.isFinite(dms) && dms > 0) out.push({ ...base, separationAt: dms });
  return out;
}

/** 剩余 ≤ 阈值（默认 12 小时）且未处理过的「待审核离职日期」→ 用最迟日期自动确认。
 *  默认关闭，需手动开启。返回本次自动确认成功的条数。 */
async function autoConfirmResign() {
  if (!state.resignAuto || state.resignBusy || state.resignAutoBusy) return 0;
  const rows = resignPending().filter((r) => r.stateCode === "created");
  if (!rows.length) return 0;
  state.resignAutoBusy = true;
  let done = 0;
  try {
    for (const row of rows) {
      const key = resignKey(row);
      if (state.resignAutoDone.has(key)) continue;
      const failAt = state.resignAutoFail.get(key) || 0;
      if (failAt && Date.now() - failAt < 10 * 60 * 1000) continue;
      const dl = resignDeadline(row);
      if (!dl || dl.left <= 0 || dl.left > state.resignAutoH * 3600 * 1000) continue;
      const date = resignDateRange(row).end;
      const who = row.employeeName || row.knightId || "";
      try {
        await callResignAction(API_RESIGN_CONFIRM, resignConfirmPayloads(row, date));
        state.resignAutoDone.add(key);
        state.resignAutoFail.delete(key);
        state.resignAutoErr = "";
        state.resign = state.resign.filter((r) => resignKey(r) !== key);
        done++;
        showNotice(`已自动确认 ${who} 的离职日期：${date}（审核${dl.text}，阈值 ${state.resignAutoH}h）`, "", 6000);
      } catch (e) {
        state.resignAutoFail.set(key, Date.now());
        const msg = String((e && e.message) || e);
        const raw = e && e.raw ? ` 返回：${JSON.stringify(e.raw).slice(0, 220)}` : "";
        state.resignAutoErr = `${who}：${msg}${raw}`;
        showNotice(`自动确认失败：${who}（${msg}）。10 分钟内不再重试，可点「处理」手动确认。`, "err", 12000);
        renderAll();
        try { console.warn("[resign-auto] 自动确认失败", row && row.knightId, e); } catch (x) { /* ignore */ }
      }
    }
  } finally {
    state.resignAutoBusy = false;
    if (done) { saveResignCache(state.resign); renderAll(); }
  }
  return done;
}

async function fetchResign(opts) {
  const silent = !!(opts && opts.silent);
  if (state.resignLoading) return;
  state.resignLoading = true;
  state.resignError = "";
  renderAll();
  try {
    const rows = [];
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const got = await resignFetchPage(page, 100);
      rows.push(...got.list);
      total = num(got.total);
      if (!got.list.length || rows.length >= total) break;
    }
    state.resign = normalizeResignRows(rows);
    state.resignAt = Date.now();
    saveResignCache(state.resign);
    setTimeout(() => { autoConfirmResign(); }, 300);
    if (!silent) {
      const pend = resignPending().length;
      showNotice(`已刷新离职申请 ${rows.length} 条，其中待审核 ${pend} 条。`, "", 3000);
    }
  } catch (e) {
    state.resignError = String((e && e.message) || e);
    if (!silent) showNotice(`离职待审核读取失败：${state.resignError}。可点「刷新」重试。`, "err", 4000);
  } finally {
    state.resignLoading = false;
    renderAll();
  }
}
function resignTime(v) {
  if (!v) return "—";
  const ms = toMs(v);
  const d = new Date(ms || str(v));
  if (!ms || isNaN(d.getTime())) return str(v).slice(0, 16);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 统一时间戳：兼容 10 位秒、13 位毫秒、ISO、YYYY-MM-DD。 */
function toMs(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const strv = str(v);
  let t = Date.parse(strv);
  if (!Number.isFinite(t)) t = Date.parse(strv.replace(/-/g, "/"));
  return Number.isFinite(t) ? t : 0;
}

/** 平台规则：发起后 72 小时内要审核完，否则系统自动通过。 */
function resignDeadline(r) {
  const ts = toMs(r.initiatingAt);
  if (!ts) return null;
  const deadline = ts + 72 * 3600 * 1000;
  const left = deadline - Date.now();
  return {
    deadline,
    left,
    text: left <= 0 ? `已超时 ${durationText(-left)}` : `剩 ${durationText(left)}`,
    level: left <= 0 ? "bad" : left <= 6 * 3600 * 1000 ? "warn" : "ok"
  };
}

function resignDay(v) {
  if (!v) return "—";
  return str(v).slice(0, 10);
}
/** 统一转成 YYYY-MM-DD（兼容时间戳 / ISO / 2026-11-30 这类）。 */
function resignDateStr(v) {
  if (v == null || v === "") return "";
  const raw = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ms = toMs(v);
  if (!ms) return "";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 平台限制：可选范围 = 期望离职日期 ~ 发起时间 + 31 天。 */
function resignDateRange(row) {
  const today = resignDateStr(Date.now());
  const start = resignDateStr(row.expectSeparationAt) || today;
  const initMs = toMs(row.initiatingAt) || Date.now();
  const end = resignDateStr(initMs + 31 * 86400000) || resignDateStr(Date.now() + 31 * 86400000);
  return { start, end };
}
function renderResign() {
  const sec = $("td-resign");
  const box = $("td-resign-list");
  const sub = $("td-resign-sub");
  if (!sec || !box) return;
  const visible = state.filter !== "training" && state.filter !== "ledger"
    && state.filter !== "health";
  sec.hidden = !visible;
  if (!visible) return;
  const rows = resignPending();
  if (sub) {
    const parts = [];
    if (state.resignLoading) parts.push("正在读取离职申请…");
    else if (state.resignError) parts.push("读取失败：" + state.resignError);
    else parts.push(`剩余 ≤ ${int(state.catCfg.resignHours)} 小时 · 待审核 ${rows.length} 条`);
    if (state.resignAutoErr) parts.push("自动确认失败：" + state.resignAutoErr.slice(0, 60));
    if (state.resignAt) parts.push("更新于 " + shortTime(new Date(state.resignAt)));
    sub.textContent = parts.join(" · ");
  }
  if (state.resignLoading && !state.resign.length) {
    box.innerHTML = `<div class="td-train-empty">正在读取离职申请…</div>`;
    return;
  }
  if (state.resignError && !state.resign.length) {
    box.innerHTML = `<div class="td-train-empty err">离职待审核读取失败：${esc(state.resignError)}</div>`;
    return;
  }
  if (!rows.length) {
    if (!state.resign.length) {
      box.innerHTML = state.resignAt
        ? `<div class="td-train-empty">接口返回 0 条离职申请。<br>` +
          (state.resignDebug ? `<span class="small small-hint">${esc(state.resignDebug)}</span>` : "") + `</div>`
        : `<div class="td-train-empty">当前没有待审核的离职申请 🎉</div>`;
      return;
    }
    const map = new Map();
    for (const r of state.resign) {
      const k = `${str(r.stateName) || "—"}${r.stateCode ? `(${r.stateCode})` : ""}`;
      map.set(k, (map.get(k) || 0) + 1);
    }
    const list = [...map.entries()].map(([k, n]) => `${esc(k)} ×${n}`).join(" · ");
    box.innerHTML = `<div class="td-train-empty">接口有数据，但没有匹配到「待审核」状态。<br>` +
      `返回的状态：${list}<br><span class="small">把这个发我，我按实际状态码改匹配规则。</span></div>`;
    return;
  }
  box.innerHTML = rows.map((r) => {
    const cancel = r.stateCode === "cancelProcessCreated";
    const badge = cancel ? "撤销待审核" : "待审核";
    const when = cancel
      ? `撤销申请 · 期望离职 ${esc(resignDateStr(r.expectSeparationAt) || "—")}`
      : `期望离职 <b>${esc(resignDateStr(r.expectSeparationAt) || "—")}</b>`;
    return `<div class="td-lrow is-resign">` +
      `<div class="l-main"><div class="l-title">${esc(r.employeeName || "—")}` +
      `<span class="l-cat">${esc(r.currentDeptName || "—")}</span></div>` +
      `<div class="l-meta">骑手 ${esc(r.knightId || "—")}${r.knightMobile ? " · " + esc(r.knightMobile) : ""}` +
      ` ｜ ${when} ｜ 发起 ${esc(resignTime(r.initiatingAt))}` +
      (() => {
        const dl = resignDeadline(r);
        if (!dl) return "";
        const tip = `截止 ${ymdTime(new Date(dl.deadline))}（72 小时内未审核将自动通过）`;
        return ` ｜ <span class="rg-left ${dl.level}" title="${esc(tip)}">审核${esc(dl.text)}</span>`;
      })() +
      `</div></div>` +
      `<span class="td-badge ${cancel ? "warn" : "today"}">${badge}</span>` +
      `<button type="button" class="ghost l-btn" data-resign-key="${esc(resignKey(r))}">处理</button></div>`;
  }).join("");
  box.querySelectorAll("[data-resign-key]").forEach((b) => {
    b.addEventListener("click", () => openResignModal(b.dataset.resignKey));
  });
}

function resignKey(r) { return `${str(r.orgCode)}_${str(r.employeeId)}_${str(r.initiatingAt)}`; }

function openResignModal(key) {
  const row = state.resign.find((r) => resignKey(r) === key);
  if (!row) return;
  state.resignModal = row;
  const cancel = row.stateCode === "cancelProcessCreated";
  const mask = $("td-rg-mask");
  if (mask) mask.hidden = false;
  if ($("td-rg-title")) $("td-rg-title").textContent = cancel ? "撤销申请处理" : "离职日期审核";
  const body = $("td-rg-body");
  const acts = $("td-rg-acts");
  if (body) {
    body.innerHTML =
      `<div class="lg-info">` +
      `<div><span>骑手</span><b>${esc(row.employeeName || "—")} · ${esc(row.knightId || "—")}</b></div>` +
      `<div><span>站点</span><b>${esc(row.currentDeptName || "—")}</b></div>` +
      `<div><span>期望离职</span><b>${esc(resignDateStr(row.expectSeparationAt) || "—")}</b></div>` +
      `<div><span>发起时间</span><b>${esc(resignTime(row.initiatingAt))}</b></div>` +
      `<div><span>申请状态</span><b>${esc(row.stateName || "—")}</b></div>` +
      (() => {
        const dl = resignDeadline(row);
        if (!dl) return "";
        return `<div><span>审核期限</span><b class="rg-left ${dl.level}" title="发起后 72 小时未审核将自动通过">` +
          `${esc(dl.text)}（截止 ${esc(ymdTime(new Date(dl.deadline)))}）</b></div>`;
      })() +
      (row.knightMobile ? `<div><span>手机号</span><b>${esc(row.knightMobile)}</b></div>` : "") +
      `</div>` +
      (cancel ? `<div class="td-train-empty" style="padding:14px 8px">该骑手撤销了离职申请，确认后按你的选择处理。</div>`
        : (() => {
          const range = resignDateRange(row);
          const dl = resignDeadline(row);
          const urgent = dl && dl.left > 0 && dl.left <= state.resignAutoH * 3600 * 1000;
          return `<div class="rg-date"><label for="td-rg-date">离职日期</label>` +
            `<input id="td-rg-date" type="date" min="${range.start}" max="${range.end}" ` +
            `value="${esc(range.end)}"></div>` +
            `<div class="rg-tip">可选范围：${esc(range.start)} 到 ${esc(range.end)}（默认已选最迟日期）</div>` +
            (urgent ? `<div class="rg-tip rg-urgent">审批剩余不足 ${esc(String(state.resignAutoH))} 小时（${esc(dl.text)}），已默认选最迟日期，请尽快确认。</div>` : "");
        })());
  }
  if (acts) {
    acts.innerHTML = cancel
      ? `<button type="button" class="ghost danger" id="td-rg-reject">拒绝撤销</button>` +
        `<button type="button" class="primary" id="td-rg-pass">同意撤销</button>`
      : `<button type="button" class="ghost" id="td-rg-close2">取消</button>` +
        `<button type="button" class="primary" id="td-rg-pass">确认通过</button>`;
    const pass = $("td-rg-pass");
    if (pass) pass.addEventListener("click", () => submitResign(cancel ? "approveCancel" : "confirmDate", true));
    const reject = $("td-rg-reject");
    if (reject) reject.addEventListener("click", () => submitResign("approveCancel", false));
    const c2 = $("td-rg-close2");
    if (c2) c2.addEventListener("click", closeResignModal);
  }
}

function closeResignModal() {
  state.resignModal = null;
  const mask = $("td-rg-mask");
  if (mask) mask.hidden = true;
  const body = $("td-rg-body");
  if (body) body.innerHTML = "";
  const acts = $("td-rg-acts");
  if (acts) acts.innerHTML = "";
}

async function submitResign(kind, pass) {
  const row = state.resignModal;
  if (!row || state.resignBusy) return;
  state.resignBusy = true;
  try {
    let payload = null;
    if (kind === "confirmDate") {
      const d = str(($("td-rg-date") || {}).value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        showNotice("请选择离职日期。", "err", 3000);
        return;
      }
      const range = resignDateRange(row);
      if (d < range.start || d > range.end) {
        showNotice(`离职日期要在 ${range.start} 到 ${range.end} 之间。`, "err", 4000);
        return;
      }
      payload = { params: { orgCode: row.orgCode, employeeId: row.employeeId, separationAt: d } };
    } else {
      payload = { params: { orgCode: row.orgCode, employeeId: row.employeeId, pass: !!pass } };
    }
    if (kind === "confirmDate") {
      await callResignAction(API_RESIGN_CONFIRM, resignConfirmPayloads(row, str(payload.params.separationAt)));
    } else {
      await callResignAction(API_RESIGN_APPROVE, payload.params);
    }
    const key = resignKey(row);
    state.resign = state.resign.filter((r) => resignKey(r) !== key);
    saveResignCache(state.resign);
    closeResignModal();
    showNotice(kind === "confirmDate" ? "已通过离职审核。" : (pass ? "已同意撤销。" : "已拒绝撤销。"), "", 3200);
    renderAll();
    fetchResign({ silent: true });
  } catch (e) {
    showNotice(`处理失败：${String((e && e.message) || e)}`, "err", 4500);
  } finally {
    state.resignBusy = false;
  }
}


// ---------------------------------------------------------------- 健康证待处理（v3.57.90）
// 数据源：蜂鸟 TEAM 骑手列表 GET knight.ele.me/aeolus/knights_info
//   healthcert_status：0 未上传 / 5 即将过期 / 4 已过期；available_status=1 = 启用中
// 近 8 天是否有单：T-7 ~ T-1 用「出勤统计 → 导出明细数据」按骑手汇总「全天」完单，
//   T0 用实时考勤快照的「全天完单量」（复用出勤达成那套取数，不另造口径）。
const API_HC = "https://knight.ele.me/aeolus/knights_info";
const API_HC_STAFF = "https://app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list";
const API_HC_DETAIL = XT + "xtop.fs.special.examine.exportStatisticsDetail/1.0";
const API_HC_LIVE = XT + "xtop.fs.special.realtimeattendance.exportAttendance/1.0";
const HC_PAGE_URL = "https://aeolus.ele.me/?targetId=54052#/knight/knightList/index?quick_filter=expired_healthcert";
const LS_HEALTH = "wb_todo_health_v1";
const HC_KEEP_MS = 5 * 60 * 1000;
const HC_PAGE = 100;
const HC_STATUS = [
  { code: 0, key: "none", label: "未上传", cls: "today", weight: 2 },
  { code: 5, key: "risk", label: "即将过期", cls: "warn", weight: 1 },
  { code: 4, key: "expired", label: "已过期", cls: "overdue", weight: 3 }
];

const hcPad = (n) => String(n).padStart(2, "0");
function hcToday() {
  const d = new Date();
  return `${d.getFullYear()}-${hcPad(d.getMonth() + 1)}-${hcPad(d.getDate())}`;
}
function hcShift(date, days) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${hcPad(dt.getMonth() + 1)}-${hcPad(dt.getDate())}`;
}
const maskMobile = (v) => {
  const s = String(v || "");
  return s.length >= 7 ? s.slice(0, 3) + "****" + s.slice(-4) : s;
};
/** 入职天数：入职当天算第 1 天（today - 入职日 + 1）。 */
function hcDaysSince(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y) return null;
  const start = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.floor((today - start) / 86400000);
  return diff >= 0 ? diff + 1 : null;
}
/** 人资名单：骑手 → 入职日期（优先在职记录；同一骑手多条取最晚入职）。 */
async function loadHealthStaff() {
  const map = new Map();
  for (let page = 1; page <= 20; page++) {
    const r = await proxyText(`${API_HC_STAFF}?pageIndex=${page}&pageSize=500`);
    let j = null;
    try { j = JSON.parse(r.text || "null"); } catch (e) { j = null; }
    const d = j && j.data;
    const list = d && Array.isArray(d.list) ? d.list : [];
    if (!list.length) break;
    for (const x of list) {
      const rid = String(x.knightId == null ? x.id : x.knightId).trim();
      if (!rid) continue;
      const entry = String(x.entryTime || "").slice(0, 10);
      const onJob = Number(x.workStatus) === 1;
      const cur = map.get(rid);
      if (!cur || (onJob && !cur.onJob) || (onJob === cur.onJob && entry > cur.entryTime)) {
        map.set(rid, { entryTime: entry, onJob });
      }
    }
    const total = Number(d.count || d.total || 0);
    if (total && page * 500 >= total) break;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  return map;
}
function loadHealthCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_HEALTH) || "null");
    if (!o || !Array.isArray(o.rows) || !o.ts) return null;
    if (Date.now() - o.ts > HC_KEEP_MS) return null;
    return o;
  } catch (e) { return null; }
}
function saveHealthCache() {
  try {
    localStorage.setItem(LS_HEALTH, JSON.stringify({
      ts: Date.now(), rows: state.health, teams: state.healthTeams, partial: state.healthPartial
    }));
  } catch (e) { /* ignore */ }
}

/** 导出接口 → 下载链接 */
async function healthExportUrl(api, payload) {
  const r = await proxyText(api, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload)
  });
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { /* ignore */ }
  const d = j && j.result && j.result.data;
  const url = d && (d.url || d.downloadUrl);
  if (!url) throw new Error((j && j.error && j.error.message) || "导出接口未返回下载链接");
  return url;
}
async function healthReadXlsx(url) {
  // OSS 下载优先走扩展页直连（SW 的 CORS 规则已放行 aliyuncs）；
  // 消息通道无法可靠传 ArrayBuffer，所以 FETCH_BINARY 只作为兜底并做一次转换。
  let buf = null;
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    buf = await r.arrayBuffer();
  } catch (e) {
    const b = await extMsg({ type: "FETCH_BINARY", url });
    if (!b || !b.ok) throw new Error((b && b.error) || (e && e.message) || "xlsx 下载失败");
    buf = b.buffer instanceof ArrayBuffer ? b.buffer : new Uint8Array(b.buffer || []).buffer;
  }
  return await XLSX_READER.read(buf);
}
/** 出勤明细：累加「全天」行的完单量；实时快照：取每人的「全天完单量」 */
function hcNormDate(v) {
  const s = String(v == null ? "" : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}
/** 把一份出勤导出并进汇总：total 为骑手总完单，byDay 为骑手 × 日期完单，dataDates 记录文件里实际有数据的日期。
 *  明细文件：只认「时段=全天」行，累加；实时快照：同一骑手每行都重复全天完单量，取最大值。 */
function mergeHealthSheet(sheets, opts) {
  const { live, today, total, byDay, dataDates } = opts;
  for (const sh of sheets || []) {
    const rows = sh && sh.rows;
    if (!rows || rows.length < 2) continue;
    const col = Object.create(null);
    rows[0].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim();
      if (k && col[k] === undefined) col[k] = i;
    });
    const iR = col["骑手ID"] != null ? col["骑手ID"] : col["骑手id"];
    if (iR == null) continue;
    const cell = (r, i) => (i == null || i < 0 || r[i] == null ? "" : String(r[i]).trim());
    if (live) {
      const iD = col["全天完单量"];
      if (iD == null) continue;
      dataDates.add(today);
      const maxToday = new Map();
      for (const r of rows.slice(1)) {
        const rid = cell(r, iR);
        if (!rid) continue;
        const n = Number(r[iD]) || 0;
        if (!maxToday.has(rid) || n > maxToday.get(rid)) maxToday.set(rid, n);
      }
      for (const [rid, n] of maxToday) {
        if (!byDay.has(rid)) byDay.set(rid, new Map());
        byDay.get(rid).set(today, n);
        total.set(rid, (total.get(rid) || 0) + n);
      }
    } else {
      const iP = col["时段"];
      if (iP == null) continue;
      const iO = col["完单量"] != null ? col["完单量"] : col["全天完单量"];
      if (iO == null) continue;
      const iDate = col["考勤日期"] != null ? col["考勤日期"] : col["日期"];
      for (const r of rows.slice(1)) {
        const d = hcNormDate(iDate == null ? "" : r[iDate]);
        if (d) dataDates.add(d);
        if (cell(r, iP) !== "全天") continue;
        const rid = cell(r, iR);
        if (!rid || !d) continue;
        const n = Number(r[iO]) || 0;
        if (!byDay.has(rid)) byDay.set(rid, new Map());
        const m = byDay.get(rid);
        m.set(d, (m.get(d) || 0) + n);
        total.set(rid, (total.get(rid) || 0) + n);
      }
    }
  }
}

async function loadHealthOrders(teamIds) {
  if (!teamIds || !teamIds.length) throw new Error("没有取到站点 ID");
  const today = hcToday();
  const days = [];
  for (let i = -7; i <= 0; i++) days.push(hcShift(today, i));   // T-7 ~ T0
  const [a, b] = await Promise.allSettled([
    healthExportUrl(API_HC_DETAIL, { params: { request: {
      teamIds, startDate: hcShift(today, -7), endDate: hcShift(today, -1)
    } } }),
    healthExportUrl(API_HC_LIVE, { params: { request: {
      teamIds, startDate: today, endDate: today
    } } })
  ]);
  const total = new Map(), byDay = new Map(), dataDates = new Set();
  let ok = 0, firstErr = "";
  if (a.status === "fulfilled") {
    try {
      mergeHealthSheet(await healthReadXlsx(a.value), { live: false, today, total, byDay, dataDates });
      ok++;
    } catch (e) { firstErr = firstErr || String((e && e.message) || e); }
  } else firstErr = String((a.reason && a.reason.message) || a.reason || "");
  if (b.status === "fulfilled") {
    try {
      mergeHealthSheet(await healthReadXlsx(b.value), { live: true, today, total, byDay, dataDates });
      ok++;
    } catch (e) { firstErr = firstErr || String((e && e.message) || e); }
  } else firstErr = firstErr || String((b.reason && b.reason.message) || b.reason || "");
  if (!ok) throw new Error(firstErr || "订单数据未取到");
  return { total, byDay, days, dataDates };
}

async function fetchHealth(opts) {
  const silent = !!(opts && opts.silent);
  if (state.healthLoading) return;
  state.healthLoading = true;
  state.healthError = "";
  renderAll();
  try {
    const seen = new Map();
    let teams = [];
    for (const st of HC_STATUS) {
      let got = 0, total = 0;
      for (let page = 1; page <= 20; page++) {
        const qs = `?team_id=-1&id_certify_status=-1&healthcert_status=${st.code}` +
          `&violation_status=-1&work_status=-1&equipment_code_status=-1` +
          `&available_status=1&knight_label=-1&page_now=${page}&page_size=${HC_PAGE}&audit_status=-1`;
        const r = await proxyText(API_HC + qs);
        let j = null;
        try { j = JSON.parse(r.text); } catch (e) { /* ignore */ }
        const d = j && j.data;
        if (!d) throw new Error((j && (j.message || j.name)) || "健康证名单读取失败");
        if (!teams.length && Array.isArray(d.teams)) {
          teams = d.teams.map((t) => Number(t.id)).filter((n) => n > 0);
        }
        total = Number(d.total) || total;
        const list = Array.isArray(d.knights) ? d.knights : [];
        for (const k of list) {
          const id = String(k.id == null ? "" : k.id);
          if (!id || seen.has(id)) continue;
          seen.set(id, {
            id, name: k.knight_name || "—", mobile: k.mobile || "",
            teamId: k.team_id, teamName: k.team_name || "",
            workStatus: k.work_status, available: k.available_status,
            hcCode: Number(k.healthcert_status), hc: st,
            orders8: null, hasOrder: false
          });
        }
        got += list.length;
        if (!list.length || got >= total) break;
        await new Promise((r2) => setTimeout(r2, 120));
      }
    }
    const rows = [...seen.values()];
    // 入职日期 / 入职天数：补人资名单（健康证接口不带入职时间）
    try {
      const staff = await loadHealthStaff();
      for (const r of rows) {
        const st = staff.get(r.id);
        r.entry = st && st.entryTime ? st.entryTime : "";
        r.entryDays = r.entry ? hcDaysSince(r.entry) : null;
      }
    } catch (e) {
      for (const r of rows) { r.entry = ""; r.entryDays = null; }
    }
    let orders = null;
    try {
      orders = await loadHealthOrders(teams);
      state.healthPartial = false;
      state.healthOrderError = "";
    } catch (e) {
      state.healthPartial = true;
      state.healthOrderError = String((e && e.message) || e);
    }
    for (const r of rows) {
      const n = orders ? (orders.total.get(r.id) || 0) : null;
      r.orders8 = n == null ? null : n;
      r.hasOrder = !!(n && n > 0);
      // 近 8 天（T-7~T0）逐日完单：文件里整日没数据的显示「—」，其余按 0 计
      r.days = orders ? orders.days.map((d) => {
        const m = orders.byDay.get(r.id);
        const v = m && m.has(d) ? m.get(d) : (orders.dataDates.has(d) ? 0 : null);
        return { d, n: v };
      }) : null;
    }
    state.health = rows;
    state.healthTeams = teams;
    state.healthAt = Date.now();
    saveHealthCache();
    if (!silent) {
      const has = rows.filter((r) => r.hasOrder).length;
      showNotice(`健康证待处理 ${rows.length} 人（近 8 天有单 ${has} 人）` +
        (state.healthPartial ? `；订单数据未取到：${state.healthOrderError}` : ""),
        state.healthPartial ? "err" : "", 4500);
    }
  } catch (e) {
    state.healthError = String((e && e.message) || e);
    if (!silent) showNotice("健康证名单读取失败：" + state.healthError, "err", 5000);
  } finally {
    state.healthLoading = false;
    renderAll();
  }
}

function healthPending() {
  return state.health.slice().sort((x, y) =>
    (y.hasOrder ? 1 : 0) - (x.hasOrder ? 1 : 0) ||
    (y.hc && y.hc.weight || 0) - (x.hc && x.hc.weight || 0) ||
    String(x.name).localeCompare(String(y.name), "zh-CN"));
}

function renderHealth() {
  const sec = $("td-health"), box = $("td-health-list"), sub = $("td-health-sub");
  if (!sec || !box) return;
  const visible = state.filter !== "training" && state.filter !== "ledger"
    && state.filter !== "resign";
  sec.hidden = !visible;
  if (!visible) return;
  const all = healthPending();
  const list = state.healthOnly ? all.filter((x) => x.hasOrder) : all;
  const btn = $("btn-health-only");
  if (btn) {
    btn.textContent = `只看有单：${state.healthOnly ? "开" : "关"}`;
    btn.classList.toggle("is-on", state.healthOnly);
  }
  if (sub) {
    const parts = [];
    if (state.healthLoading) parts.push("正在读取健康证名单…");
    else if (state.healthError) parts.push("读取失败：" + state.healthError);
    else {
      const none = all.filter((x) => x.hc.key === "none").length;
      const risk = all.filter((x) => x.hc.key === "risk").length;
      const exp = all.filter((x) => x.hc.key === "expired").length;
      const has = all.filter((x) => x.hasOrder).length;
      parts.push(`启用中 ${all.length} 人 · 未上传 ${none} / 即将过期 ${risk} / 已过期 ${exp} · 近8天有单 ${has} 人`);
      if (state.healthPartial) parts.push("订单数据未取到（显示 —）");
    }
    if (state.healthAt) parts.push("更新于 " + shortTime(new Date(state.healthAt)));
    sub.textContent = parts.join(" · ");
  }
  if (state.healthLoading && !all.length) {
    box.innerHTML = `<div class="td-train-empty">正在读取健康证名单…</div>`;
    return;
  }
  if (state.healthError && !all.length) {
    box.innerHTML = `<div class="td-train-empty err">健康证名单读取失败：${esc(state.healthError)}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="td-train-empty">` +
      (state.healthOnly ? "近 8 天没有跑单的健康证异常骑手 🎉" : "没有未上传 / 即将过期 / 已过期的骑手 🎉") +
      `</div>`;
    return;
  }
  const today = hcToday();
  box.innerHTML = list.map((r) => {
    const ord = r.orders8 == null ? "近8天完单 —"
      : (r.orders8 > 0 ? `近8天完单 ${int(r.orders8)} 单` : "近8天无单");
    const entryBox = r.entry
      ? `<div class="hc-entry-box" title="入职日期 ${esc(r.entry)}${r.entryDays != null ? " · 入职第 " + int(r.entryDays) + " 天" : ""}">` +
        `<span class="hc-entry-date"><i>入职</i>${esc(r.entry)}</span>` +
        (r.entryDays != null
          ? `<span class="hc-entry-days">${int(r.entryDays)}<small>天</small></span>`
          : "") +
        `</div>`
      : "";
    const days = Array.isArray(r.days) ? `<div class="hc-days">` + r.days.map((x) => {
      const lab = x.d === today ? "今天" : x.d.slice(5);
      const has = x.n != null && x.n > 0;
      const txt = x.n == null ? "—" : int(x.n);
      const tip = x.n == null ? `${x.d} 数据未出` : `${x.d} 完单 ${int(x.n)} 单`;
      return `<span class="hc-day${has ? " has" : ""}${x.n == null ? " na" : ""}" title="${esc(tip)}">` +
        `<i>${esc(lab)}</i><b>${esc(txt)}</b></span>`;
    }).join("") + `</div>` : "";
    return `<div class="td-lrow is-health">` +
      `<div class="l-main"><div class="l-title">${esc(r.name)}` +
      `<span class="l-cat">${esc(r.teamName || "—")}</span></div>` +
      `<div class="l-meta">骑手 ${esc(String(r.id))}` +
      (r.mobile ? ` · ${esc(maskMobile(r.mobile))}` : "") +
      ` ｜ ${r.hasOrder ? `<b class="td-has-order">${esc(ord)}</b>` : esc(ord)}</div>` +
      days + `</div>` +
      entryBox +
      `<span class="td-badge ${r.hc.cls}" title="健康证状态">${esc(r.hc.label)}</span></div>`;
  }).join("");
}

function renderLedger() {
  const sec = $("td-ledger");
  const box = $("td-ledger-list");
  const sub = $("td-ledger-sub");
  if (!sec || !box) return;
  const visible = state.filter !== "training" && state.filter !== "resign"
    && state.filter !== "health";
  sec.hidden = !visible;
  if (!visible) return;
  const pending = ledgerPending();
  if (sub) {
    const parts = [];
    if (state.ledgerLoading) parts.push("正在读取台账明细…");
    else if (state.ledgerError) parts.push("读取失败：" + state.ledgerError);
    else parts.push(`近 ${int(state.catCfg.ledgerDays)} 天上传 · 未审核 ${pending.length} 条`);
    if (state.ledgerAt) parts.push("更新于 " + shortTime(new Date(state.ledgerAt)));
    sub.textContent = parts.join(" · ");
  }
  if (state.ledgerLoading && !state.ledger.length) {
    box.innerHTML = `<div class="td-train-empty">正在读取台账明细…</div>`;
    return;
  }
  if (state.ledgerError && !state.ledger.length) {
    box.innerHTML = `<div class="td-train-empty err">台账明细读取失败：${esc(state.ledgerError)}</div>`;
    return;
  }
  if (!pending.length) {
    box.innerHTML = `<div class="td-train-empty">近 ${int(state.catCfg.ledgerDays)} 天没有待审核的台账 🎉</div>`;
    return;
  }
  box.innerHTML = pending.map((r) => {
    const rider = ledgerRider(r);
    const cls = ledgerIsThreeCard(r) ? "is-card" : "";
    return `<div class="td-lrow ${cls}">` +
      `<div class="l-main"><div class="l-title">${esc(r.templateName || "台账")}` +
      `<span class="l-cat">${esc(str(r.firstCategoryName) + "/" + str(r.secondCategoryName))}</span></div>` +
      `<div class="l-meta">${esc(rider.name || rider.id || "—")}${rider.id ? ` · ${esc(rider.id)}` : ""}` +
      ` ｜ 台账日期 ${esc(r.dateInfo || "—")} ｜ 上传 ${esc(ymdTime(new Date(num(r.createAt))))}` +
      ` ｜ ${esc(r.creatorName || "—")}</div></div>` +
      `<span class="td-badge today">待审核</span>` +
      `<button type="button" class="ghost l-btn" data-ledger-id="${esc(r.id)}">审核</button></div>`;
  }).join("");
}

async function openLedgerModal(id) {
  const row = state.ledger.find((r) => String(r.id) === String(id));
  if (!row) return;
  state.ledgerModal = { row };
  const mask = $("td-lg-mask");
  if (mask) mask.hidden = false;
  const rider = ledgerRider(row);
  if ($("td-lg-title")) $("td-lg-title").textContent = `${row.templateName || "台账"} · 台账审核`;
  if ($("td-lg-reason")) { $("td-lg-reason").hidden = true; $("td-lg-reason").value = ""; }
  const voidBtn = $("td-lg-void");
  if (voidBtn) {
    const can = row.cancelButton !== false;
    voidBtn.hidden = false;
    voidBtn.disabled = !can;
    voidBtn.title = can ? "作废这条台账（不可恢复）" : "该台账当前状态不允许作废（超过可作废时间或已处理）";
  }
  const body = $("td-lg-body");
  if (!body) return;
  const req = str(row.templateMaintenanceRequirement).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  body.innerHTML =
    `<div class="lg-info">` +
    `<div><span>台账</span><b>${esc(row.name || "—")}</b></div>` +
    `<div><span>骑手</span><b>${esc(rider.name || "—")}${rider.id ? ` · ${esc(rider.id)}` : ""}</b></div>` +
    `<div><span>台账日期</span><b>${esc(row.dateInfo || "—")}</b></div>` +
    `<div><span>上传</span><b>${esc(ymdTime(new Date(num(row.createAt))))} · ${esc(row.creatorName || "—")}</b></div>` +
    (req ? `<div class="lg-req"><span>维护要求</span><b>${esc(req.slice(0, 260))}</b></div>` : "") +
    `</div><div class="lg-media" id="td-lg-media"><div class="lg-media-tip">正在读取附件…</div></div>`;
  const box = $("td-lg-media");
  const hashes = Array.isArray(row.fileHash) ? row.fileHash : (row.fileHash ? [row.fileHash] : []);
  if (!hashes.length) {
    if (box) box.innerHTML = `<div class="lg-media-tip">这条台账没有附件</div>`;
    return;
  }
  try {
    const j = await request(API_OSS_DL, {
      params: {
        request: {
          files: hashes.map((h) => ({
            fileHash: h, contentDisposition: "inline", contentType: ledgerMime(h)
          })),
          app: OSS_APP
        }
      }
    });
    const list = (j && j.result && j.result.data) || [];
    if (!box) return;
    if (!list.length) { box.innerHTML = `<div class="lg-media-tip">附件地址读取失败</div>`; return; }
    const supportHevc = hevcSupported();
    const probed = await Promise.all(list.map(async (x) => {
      const kind = ledgerFileKind(x.fileHash);
      let bad = false;
      if (kind === "video") {
        const codec = await probeVideoCodec(x.url);
        bad = !supportHevc && /^hvc1$|^hev1$/i.test(codec);
      }
      return { url: x.url, hash: x.fileHash, kind, bad };
    }));
    if (!box) return;
    box.innerHTML = probed.map((x, i) => {
      const cls = x.bad ? " is-hevc" : (x.kind === "pdf" ? " is-pdf" : (x.kind === "image" ? " is-img" : ""));
      const media = x.bad
        ? `<div class="lg-hevc" data-hevc-url="${esc(x.url)}" data-hevc-name="${esc(str(row && row.name) + "-" + (i + 1))}"></div>`
        : ledgerMediaHtml(x.url, x.hash);
      return `<div class="lg-media-item${cls}"><div class="lg-media-cap">附件${i + 1}</div>${media}</div>`;
    }).join("");
    box.querySelectorAll("video.lg-media-v").forEach((v, i) => { v.dataset.idx = String(i + 1); });
    box.querySelectorAll("[data-vf-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = num((btn.closest(".lg-vf") || {}).dataset && btn.closest(".lg-vf").dataset.vfIdx) || 1;
        openInSystemPlayer(btn.dataset.vfUrl, `${str(row && row.name) || "台账附件"}-${i}.mp4`);
      });
    });
    box.querySelectorAll(".lg-hevc").forEach((el) => {
      mountHevcInline(el, el.dataset.hevcUrl, el.dataset.hevcName);
    });
    bindVideoFallback(box, row);
  } catch (e) {
    if (box) box.innerHTML = `<div class="lg-media-tip err">附件读取失败：${esc(String((e && e.message) || e))}</div>`;
  }
}

function closeLedgerModal() {
  state.ledgerModal = null;
  for (const destroy of state.ledgerPlayers.splice(0)) { try { destroy(); } catch (e) { /* ignore */ } }
  const mask = $("td-lg-mask");
  if (mask) mask.hidden = true;
  const body = $("td-lg-body");
  if (body) body.innerHTML = "";
}

/** 判断 XTOP 返回是否算成功：外层 code + 内层业务码；内层 0/200 都当成功。 */
function ledgerCallFailed(j) {
  if (!j) return "接口无响应";
  if (j.error) return j.error.message || "接口报错";
  if (j.code !== undefined && j.code !== 200 && j.code !== 0) return j.message || "接口返回异常";
  const r = j.result;
  if (r && typeof r === "object") {
    if (r.code !== undefined && r.code !== 0 && r.code !== 200) return r.message || "操作失败";
    if (r.data === false) return r.message || "操作失败";
  }
  return "";
}

async function voidLedger() {
  const st = state.ledgerModal;
  if (!st || state.ledgerBusy) return;
  const row = st.row;
  const label = str(row.name) || "这条台账";
  if (!window.confirm(`确定作废「${label}」？\n作废后不可恢复，也不会再出现在待审核里。`)) return;
  state.ledgerBusy = true;
  try {
    const j = await request(API_LEDGER_CANCEL, { params: { request: row.id } });
    const fail = ledgerCallFailed(j);
    if (fail) throw new Error(fail);
    markHandled(row.id);
    state.voided.add(String(row.id));
    saveVoided(state.voided);
    state.ledger = state.ledger.filter((r) => String(r.id) !== String(row.id));
    saveLedgerCache(state.ledger);
    closeLedgerModal();
    showNotice("作废完成。", "", 3000);
    renderAll();
    fetchLedger({ silent: true, force: true });
    setTimeout(() => fetchLedger({ silent: true, force: true }), 3500);
  } catch (e) {
    showNotice(`台账作废失败：${String((e && e.message) || e)}`, "err", 4000);
  } finally {
    state.ledgerBusy = false;
  }
}

async function submitLedger(pass) {
  const st = state.ledgerModal;
  if (!st || state.ledgerBusy) return;
  const row = st.row;
  const reasonEl = $("td-lg-reason");
  const reason = str(reasonEl && reasonEl.value);
  if (!pass) {
    if (reasonEl) reasonEl.hidden = false;
    if (!reason) {
      if (reasonEl) reasonEl.focus();
      showNotice("请先填写不通过原因，再点「确定不通过」。", "err", 2600);
      return;
    }
  }
  state.ledgerBusy = true;
  const passBtn = $("td-lg-pass");
  const rejectBtn = $("td-lg-reject");
  if (passBtn) passBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;
  try {
    const payload = pass
      ? { params: { request: { id: row.id, result: 1 } } }
      : { params: { request: { id: row.id, result: 2, refuseReason: reason } } };
    const j = await request(API_LEDGER_CHECK, payload);
    const fail = ledgerCallFailed(j);
    if (fail) throw new Error(fail);
    markHandled(row.id);
    for (const r of state.ledger) {
      if (String(r.id) !== String(row.id)) continue;
      r.checkAt = Date.now();
      r.checkResult = pass ? 2 : 4;
    }
    saveLedgerCache(state.ledger);
    closeLedgerModal();
    showNotice(pass ? "审核完成：已通过。" : "审核完成：已拒绝。", "", 3200);
    renderAll();
    fetchLedger({ silent: true, force: true });
    setTimeout(() => fetchLedger({ silent: true, force: true }), 3500);
  } catch (e) {
    showNotice(`台账审核失败：${String((e && e.message) || e)}`, "err", 4000);
  } finally {
    state.ledgerBusy = false;
    if (passBtn) passBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
  }
}

/** 培训卡剩余天数按「完成培训截止日期」算（报表数据是 T-1，距离截止天数是昨天的口径）。 */
function trainLevel(expire, fallback) {
  const exp = parseTime(expire ? expire + " 23:59:59" : "");
  const n = exp ? dayDiff(exp) : Number(fallback) - 1;
  if (!Number.isFinite(n)) return { cls: "", label: "—", days: null };
  if (n < 0) return { cls: "is-urgent", label: `已超期 ${-n} 天`, days: n };
  if (n === 0) return { cls: "is-urgent", label: "今日截止", days: n };
  if (n <= 2) return { cls: "is-warn", label: `剩 ${n} 天`, days: n };
  return { cls: "is-fresh", label: `剩 ${n} 天`, days: n };
}
function renderTraining() {
  const sec = $("td-train");
  const grid = $("td-train-grid");
  const sub = $("td-train-sub");
  if (!sec || !grid) return;
  const visible = state.filter !== "overdue" && state.filter !== "today"
    && state.filter !== "ledger" && state.filter !== "resign" && state.filter !== "health";
  sec.hidden = !visible;
  if (!visible) return;
  const cards = threeCardIndex();
  const isAllDone = (r) => {
    const total = r.courses && r.courses.length ? r.courses.length : 6;
    if ((r.courseDone || 0) < total) return false;
    const lr = cards.get(String(r.rid));
    return !!(lr && lr.checkAt);
  };
  const rows = state.training.slice().sort((a, b) => {
    const ad = isAllDone(a) ? 1 : 0;
    const bd = isAllDone(b) ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return a.distance - b.distance;
  });
  if (sub) {
    const parts = [];
    if (state.trainingLoading) parts.push("正在读取培训数据…");
    else if (state.trainingError) parts.push("读取失败：" + state.trainingError);
    else {
      const finished = rows.filter(isAllDone).length;
      parts.push(`${rows.length} 人 · 已完成 ${finished} 人 · 近 ${int(state.trainDays)} 天到期`);
    }
    if (state.trainingAt) parts.push("更新于 " + shortTime(new Date(state.trainingAt)));
    sub.textContent = parts.join(" · ");
  }
  if (state.trainingLoading && !rows.length) {
    grid.innerHTML = `<div class="td-train-empty">正在读取 FBI 培训报表…</div>`;
    return;
  }
  if (state.trainingError && !rows.length) {
    const link = state.trainingViewUrl
      ? `<button type="button" class="ghost td-train-open" data-train-url="${esc(state.trainingViewUrl)}">打开培训报表登录</button>`
      : "";
    grid.innerHTML = `<div class="td-train-empty err">培训数据读取失败：${esc(state.trainingError)}${link}</div>`;
    grid.querySelectorAll("[data-train-url]").forEach((b) => {
      b.addEventListener("click", () => window.open(b.dataset.trainUrl, "_blank", "noopener"));
    });
    return;
  }
  if (!rows.length) {
    grid.innerHTML = `<div class="td-train-empty">近 ${int(state.trainDays)} 天内没有需要培训且未完成的骑手 🎉</div>`;
    return;
  }
  grid.innerHTML = rows.map((r) => {
    const lv = trainLevel(r.expire, r.distance);
    const total = r.courses && r.courses.length ? r.courses.length : 6;
    const done = r.courseDone || 0;
    const pct = Math.round((done / total) * 100);
    const dots = (r.courses || []).map((c) =>
      `<i class="${c.done ? "on" : ""}" title="${esc(c.label)}：${c.done ? "已完成" : "未完成"}"></i>`).join("");
    const finished = isAllDone(r);
    const lr = cards.get(String(r.rid));
    const ls = ledgerState(lr);
    const day = lr ? str(lr.dateInfo) : "";
    const ledger = `<span class="lg-st ${ls.cls}"${ls.tip ? ` title="${esc(ls.tip)}"` : ""}>${esc(ls.label)}</span>` +
      (ls.key !== "none" && day ? " · " + esc(day) : "");
    const cls = finished ? "is-done" : lv.cls;
    const left = finished ? `<span class="tc-done">✓ 已完成</span>` : `<span class="tc-left">${esc(lv.label)}</span>`;
    return `<article class="td-tcard ${cls}" title="${esc(r.name)} · ${esc(r.station)}">` +
      `<div class="tc-head"><b class="tc-name">${esc(r.name || r.rid)}</b>` +
      `<span class="tc-type">${esc(r.newType || "新骑手")}</span>` +
      left + `</div>` +
      `<div class="tc-site">${esc(r.station || "—")}</div>` +
      `<div class="tc-line"><span>截止 <b>${esc(r.expire || "—")}</b></span>` +
      `<span class="tc-id">ID ${esc(r.rid || "—")}</span></div>` +
      `<div class="tc-course"><span class="tc-dots">${dots}</span>` +
      `<span class="tc-pct">课程 ${done}/${total}</span></div>` +
      `<div class="tc-bar"><i style="width:${pct}%"></i></div>` +
      `<div class="tc-ledger">${ledger}</div></article>`;
  }).join("");
}

function allItems() {
  return state.tasks;
}

async function loadTasks() {
  if (state.loading) return;
  state.loading = true;
  state.error = "";
  setState("正在读取商站任务…", "loading");
  renderKpis();
  try {
    const rows = [];
    let total = 0, page = 1;
    for (; page <= MAX_PAGES; page++) {
      const j = await request(API_TASKS, {
        params: { queryVO: { status: "started", pageSize: PAGE_SIZE, pageIndex: page } }
      });
      const d = (j && j.result && j.result.data) || {};
      const list = Array.isArray(d.data) ? d.data : [];
      total = num(d.total);
      rows.push(...list);
      if (!list.length || rows.length >= total) break;
    }
    const seen = new Set();
    state.tasks = rows.filter((t) => {
      const key = str(t.taskInstanceId) || `${t.taskId}|${t.taskObject}|${t.taskExpireTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((t) => {
      const expAt = parseTime(t.taskExpireTime);
      return Object.assign({}, t, {
        group: taskGroup(t),
        expAt,
        expText: shortTime(expAt)
      });
    }).sort((a, b) => {
      const av = a.expAt ? a.expAt.getTime() : Infinity;
      const bv = b.expAt ? b.expAt.getTime() : Infinity;
      return av - bv || String(a.taskName).localeCompare(String(b.taskName), "zh-CN");
    });
    for (const t of state.tasks) {
      if (state.stations[t.taskInstanceId]) t.station = state.stations[t.taskInstanceId];
    }
    await enrichStations(state.tasks);
    state.loadedAt = new Date();
    setState(`已读取 ${state.tasks.length} 条已开始任务 · ${ymdTime(state.loadedAt)}`, "");
  } catch (e) {
    state.error = String((e && e.message) || e);
    setState(`读取失败：${state.error}`, "err");
    showNotice(`商站任务读取失败：${state.error}。可直接点「立即刷新」重试；若仍失败，确认当前浏览器已登录风神。`, "err");
  } finally {
    state.loading = false;
    renderAll();
  }
}

/** 「立即刷新」= 商站任务 + 培训 + 台账，三块一起刷。 */
async function refreshAll() {
  if (state.refreshAllBusy) return;
  state.refreshAllBusy = true;
  const btn = $("btn-refresh");
  const label = btn ? btn.textContent : "立即刷新";
  if (btn) { btn.disabled = true; btn.textContent = "刷新中…"; }
  try {
    await Promise.allSettled([
      loadTasks(),
      fetchTraining({ silent: true }),
      fetchLedger({ silent: true }),
      fetchResign({ silent: true }),
      fetchHealth({ silent: true })
    ]);
    const bits = [
      `商站任务 ${state.tasks.length} 条`,
      `培训 ${state.training.length} 人`,
      `台账待审核 ${ledgerPending().length} 条`,
      `离职待审核 ${resignPending().length} 条`,
      `健康证待处理 ${state.health.length} 人`
    ];
    const errs = [];
    if (state.error) errs.push("商站任务：" + state.error);
    if (state.trainingError) errs.push("培训：" + state.trainingError);
    if (state.ledgerError) errs.push("台账：" + state.ledgerError);
    if (state.resignError) errs.push("离职：" + state.resignError);
    if (state.healthError) errs.push("健康证：" + state.healthError);
    if (errs.length) showNotice("部分数据刷新失败 —— " + errs.join("；"), "err", 6000);
    else showNotice("已刷新全部数据：" + bits.join(" · "), "", 3200);
    renderAll();
  } finally {
    state.refreshAllBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = label || "立即刷新"; }
  }
}

function setState(text, cls) {
  const el = $("td-state");
  if (!el) return;
  el.textContent = text;
  el.className = "td-state" + (cls ? " " + cls : "");
}

function filteredTasks() {
  const q = str(state.query).toLowerCase();
  return allItems().filter((t) => {
    const ws = warnState(t);
    if (state.filter === "training") return false;
    if (state.filter === "warn" && !isWarn(ws)) return false;
    if (state.filter === "today" && ws.level !== "today") return false;
    if (state.filter === "overdue" && ws.level !== "overdue") return false;
    if (!q) return true;
    return `${t.taskName} ${t.taskObject} ${t.executorName} ${t.taskDesc} ${t.group} ${t.taskCategory} ${t.riderName || ""} ${t.station || ""}`
      .toLowerCase().includes(q);
  });
}

function renderKpis() {
  const box = $("td-kpis");
  const catBox = $("td-kpis-cats");
  if (!box) return;
  let warnTasks = 0, today = 0, overdue = 0;
  for (const t of state.tasks) {
    const ws = warnState(t);
    if (isWarn(ws)) warnTasks++;
    if (ws.level === "today") today++;
    if (ws.level === "overdue") overdue++;
  }
  const train = state.training.length;
  const ledgerCount = ledgerPending().length;
  const resignCount = resignPending().length;
  const healthCount = state.health.length;
  const totalWarn = warnTasks + train + ledgerCount + resignCount + healthCount;

  const warnGroups = new Map();
  for (const t of state.tasks) {
    const g = t.group;
    if (!warnGroups.has(g)) warnGroups.set(g, 0);
    if (isWarn(warnState(t))) warnGroups.set(g, warnGroups.get(g) + 1);
  }
  const warnChips = [...warnGroups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([g, n]) => `<span class="td-warn-chip${n ? "" : " is-zero"}">${esc(g)} <b>${int(n)}</b></span>`)
    .join("");

  const top = [
    { k: "warn", label: "任务预警", v: totalWarn, cls: "warn", big: true,
      s: `全部预警 ${int(totalWarn)} 条`,
      breakdown: [["商站任务", warnTasks], ["新骑手培训", train], ["台账待审核", ledgerCount],
        ["离职待审核", resignCount], ["健康证待处理", healthCount]],
      chips: warnChips },
    { k: "today", label: "今日到期", v: today, cls: "bad", s: "商站任务有效期在今天" },
    { k: "overdue", label: "已超时", v: overdue, cls: "bad", s: "商站任务已过有效期" }
  ];
  const cats = [
    { k: "all", label: "商站任务", v: state.tasks.length, cls: "", s: "状态 = 已开始" },
    { k: "training", label: "新骑手培训", v: train, cls: train ? "warn" : "",
      s: `近 ${int(state.catCfg.trainDays)} 天到期 · 未完成` },
    { k: "ledger", label: "台账待审核", v: ledgerCount, cls: ledgerCount ? "bad" : "",
      s: `近 ${int(state.catCfg.ledgerDays)} 天上传 · 未审核` },
    { k: "resign", label: "离职待审核", v: resignCount, cls: resignCount ? "bad" : "",
      s: `剩余 ≤ ${int(state.catCfg.resignHours)} 小时` },
    { k: "health", label: "健康证待处理", v: healthCount, cls: healthCount ? "warn" : "",
      s: "启用中 · 未上传 / 即将过期 / 已过期" }
  ];

  const paint = (cards, target) => {
    if (!target) return;
    target.innerHTML = cards.map((c) => {
      const inner = c.breakdown
        ? `<span class="k">${esc(c.label)}</span>` +
          `<span class="v">${int(c.v)}</span>` +
          `<span class="big-cats">` +
          c.breakdown.map(([name, n]) =>
            `<span class="big-cat">${esc(name)}<b${n ? "" : ' class="is-zero"'}>${int(n)}</b></span>`).join("") +
          `</span>` +
          (c.chips ? `<span class="td-warn-chips">${c.chips}</span>` : "")
        : `<span class="k">${esc(c.label)}</span><span class="v">${int(c.v)}</span>` +
          `<span class="s">${esc(c.s)}</span>`;
      return `<button type="button" class="td-card ${c.cls}${c.big ? " big" : ""}${state.filter === c.k ? " active" : ""}" data-filter="${c.k}">` +
        inner + `</button>`;
    }).join("");
    target.querySelectorAll("[data-filter]").forEach((b) => {
      b.addEventListener("click", () => setFilter(b.dataset.filter));
    });
  };
  paint(top, box);
  paint(cats, catBox);
}

function renderTable() {
  const t = $("td-table");
  if (!t) return;
  const wrap = $("td-table-wrap");
  const only = state.filter === "training" || state.filter === "ledger"
    || state.filter === "resign" || state.filter === "health";
  if (wrap) wrap.hidden = only;
  if (only) return;
  const rows = filteredTasks();
  const head = `<thead><tr>` +
    `<th class="c-warn">预警</th><th class="c-name">任务名称</th><th class="c-obj">站点 / 任务对象</th>` +
    `<th class="c-cat">任务分类</th><th class="c-remain">剩余时间</th></tr></thead>`;
  if (!allItems().length) {
    t.innerHTML = head + `<tbody><tr><td colspan="5" class="td-empty">` +
      `${state.loading ? "正在读取…" : "当前没有「已开始」的商站任务"}</td></tr></tbody>`;
    return;
  }
  if (!rows.length) {
    t.innerHTML = head + `<tbody><tr><td colspan="5" class="td-empty">没有符合当前筛选 / 搜索的任务</td></tr></tbody>`;
    return;
  }
  const body = rows.map((r) => {
    const ws = warnState(r);
    const cls = ws.level === "overdue" ? " is-overdue"
      : ws.level === "today" ? " is-today"
      : (ws.level === "warn" || ws.level === "unlimited") ? " is-warn" : "";
    const badgeCls = ws.level === "overdue" ? "overdue"
      : ws.level === "today" ? "today"
      : ws.level === "unlimited" ? "unlimited"
      : ws.level === "warn" ? "warn" : "ok";
    const rider = riderOf(r);
    const o = taskObjectInfo(r);
    const station = stationOf(r);
    const sub = rider ? `骑手 ${rider.name || "—"} · ${rider.id}`
      : /站点/.test(o.kind) ? "站点任务"
      : /服务商/.test(o.kind) ? "服务商任务" : (r.taskCategory || "任务");
    return `<tr class="${cls.trim()} clickable" data-task-id="${esc(r.taskId || "")}" data-task-name="${esc(r.taskName || "")}" title="点击打开商站任务管理">` +
      `<td class="c-warn"><span class="td-badge ${badgeCls}">${esc(ws.label)}</span></td>` +
      `<td class="c-name"><div class="td-name">${esc(r.taskName || "—")}` +
      `<small>${esc(r.taskId || "")}${r.priority ? ` · ${esc(r.priority)}` : ""}</small></div></td>` +
      `<td class="c-obj"><div class="td-site">${esc(station)}</div>` +
      `<small class="td-obj-sub">${esc(sub)}</small></td>` +
      `<td class="c-cat"><span class="td-cat" title="${esc(r.taskCategory || "")}">${esc(r.group)}</span></td>` +
      `<td class="c-remain td-mono">${esc(remainText(r.expAt))}</td>` +
      `</tr>`;
  }).join("");
  t.innerHTML = head + `<tbody>${body}</tbody>`;
  t.querySelectorAll("tr.clickable[data-task-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      // 目前只能定位到「商站任务管理」列表页；有具体任务详情路由后可在这里拼 taskInstanceId
      window.open(TASK_PAGE_URL, "_blank", "noopener");
    });
  });
}
function renderCount() {
  const el = $("td-count");
  if (!el) return;
  const rows = filteredTasks();
  let warn = 0;
  for (const t of state.tasks) if (isWarn(warnState(t))) warn++;
  if (state.filter === "training") {
    el.textContent = `新骑手培训 ${state.training.length} 人` +
      (state.trainingLoading ? " · 正在读取…" : "");
    return;
  }
  if (state.filter === "resign") {
    el.textContent = `离职待审核 ${resignPending().length} 条` +
      (state.resignLoading ? " · 正在读取…" : "");
    return;
  }
  if (state.filter === "ledger") {
    el.textContent = `台账待审核 ${ledgerPending().length} 条` +
      (state.ledgerLoading ? " · 正在读取…" : "");
    return;
  }
  if (state.filter === "health") {
    el.textContent = `健康证待处理 ${state.health.length} 人` +
      (state.healthLoading ? " · 正在读取…" : "");
    return;
  }
  el.textContent = `显示 ${rows.length} / 共 ${state.tasks.length} 条 · 预警 ${warn} 条`;
}
function renderWarnSummary() {
  const el = $("warn-summary");
  if (!el) return;
  el.textContent = `培训${int(state.catCfg.trainDays)}天/台账${int(state.catCfg.ledgerDays)}天/离职${int(state.catCfg.resignHours)}h`;
}

function syncFilterChips() {
  document.querySelectorAll(".td-filter").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === state.filter);
  });
}

function renderAll() {
  syncFilterChips();
  renderKpis();
  renderTraining();
  renderLedger();
  renderResign();
  renderHealth();
  renderTable();
  renderCount();
  renderWarnSummary();
}

function setFilter(f) {
  state.filter = f || "all";
  document.querySelectorAll(".td-filter").forEach((b) => b.classList.toggle("active", b.dataset.filter === state.filter));
  renderAll();
}

// ---------------------------------------------------------------- 预警设置
function cfgGroups() {
  const set = new Set(state.tasks.map((t) => t.group));
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function renderCfgRows() {
  const box = $("td-cfg-rows");
  if (!box) return;
  const groups = cfgGroups();
  const row = (key, name, val, isDefault) => {
    const unlimited = val === null;
    return `<div class="td-cfg-row" data-key="${esc(key)}"${isDefault ? ' data-default="1"' : ""}>` +
      `<div class="g" title="${esc(name)}">${esc(name)}${isDefault ? ' <small>未单独设置的分类</small>' : ""}</div>` +
      `<input type="number" min="0" step="1" value="${unlimited ? "" : int(val)}" ${unlimited ? "disabled" : ""}` +
      ` aria-label="${esc(name)} 提前天数">` +
      `<label><input type="checkbox" ${unlimited ? "checked" : ""}> 不限</label></div>`;
  };
  const catRows = CAT_SPEC.map((c) => `<div class="td-cfg-row" data-cat="${esc(c.k)}">` +
    `<div class="g">${esc(c.name)} <small>${esc(c.hint)}</small></div>` +
    `<input type="number" min="${c.min}" max="${c.max}" step="1" value="${int(state.catCfg[c.k])}"` +
    ` aria-label="${esc(c.name)}${esc(c.hint)}">` +
    `<span class="unit">${esc(c.unit)}</span></div>`).join("");
  box.innerHTML = `<div class="td-cfg-sub">待办分类预警口径</div>` + catRows +
    `<div class="td-cfg-sub">商站任务分类提前量</div>` +
    row("__default__", "默认", state.cfg.default, true) +
    groups.map((g) => row(g, g, taskThreshold(g), false)).join("");
  box.querySelectorAll(".td-cfg-row").forEach((line) => {
    const cb = line.querySelector('input[type="checkbox"]');
    const input = line.querySelector('input[type="number"]');
    // 「新骑手培训」那行只有天数输入、没有「不限」勾选框，这里要跳过，否则会抛错导致弹层打不开
    if (!cb || !input) return;
    cb.addEventListener("change", () => {
      input.disabled = cb.checked;
      if (cb.checked) input.value = "";
      else if (input.value === "") input.value = "0";
    });
  });
}
function openWarnCfg() {
  renderCfgRows();
  const mask = $("td-cfg-mask");
  if (mask) mask.hidden = false;
}
function closeWarnCfg() {
  const mask = $("td-cfg-mask");
  if (mask) mask.hidden = true;
}
function saveWarnCfgFromDom() {
  const cfg = { default: 0, groups: {} };
  const cat = Object.assign({}, state.catCfg);
  document.querySelectorAll("#td-cfg-rows .td-cfg-row").forEach((line) => {
    const catKey = line.dataset.cat || "";
    const key = line.dataset.key || "";
    const cb = line.querySelector('input[type="checkbox"]');
    const input = line.querySelector('input[type="number"]');
    if (catKey) {
      const spec = CAT_SPEC.find((c) => c.k === catKey);
      const raw = Math.round(Number(input && input.value));
      cat[catKey] = spec && Number.isFinite(raw)
        ? Math.max(spec.min, Math.min(spec.max, raw))
        : (spec ? spec.def : 0);
      return;
    }
    if (!input) return;
    const v = cb && cb.checked ? null : Math.max(0, Math.round(Number(input.value) || 0));
    if (key === "__default__") cfg.default = v === null ? 0 : v;
    else if (key) cfg.groups[key] = v;
  });
  const trainChanged = cat.trainDays !== state.catCfg.trainDays;
  state.cfg = cfg;
  state.catCfg = cat;
  state.trainDays = cat.trainDays;
  saveWarnCfg();
  saveCatCfg();
  saveTrainDays(cat.trainDays);
  closeWarnCfg();
  showNotice("预警设置已保存，已按新口径重算。", "", 2500);
  if (trainChanged) {
    try { localStorage.removeItem(LS_TRAIN); } catch (e) { /* ignore */ }
    state.training = [];
    fetchTraining();
  } else renderAll();
}

function bind() {
  $("btn-refresh").addEventListener("click", refreshAll);
  $("btn-train-refresh").addEventListener("click", fetchTraining);
  const rgMask = $("td-rg-mask");
  if (rgMask) rgMask.addEventListener("click", (e) => { if (e.target === rgMask) closeResignModal(); });
  const rgClose = $("td-rg-close");
  if (rgClose) rgClose.addEventListener("click", closeResignModal);
  const rauto = $("btn-resign-auto");
  if (rauto) rauto.addEventListener("click", async () => {
    if (!state.resignAuto && !window.confirm(`开启后，审批剩余不足 ${state.resignAutoH} 小时的离职申请会自动用「最迟离职日期」确认通过（不可撤销）。确定开启？`)) return;
    state.resignAuto = !state.resignAuto;
    state.resignAutoErr = "";
    try { localStorage.setItem(LS_RESIGN_AUTO, state.resignAuto ? "1" : "0"); } catch (e) { /* ignore */ }
    resignAutoLabel();
    if (!state.resignAuto) return;
    // 先数一下有多少条落入阈值，方便在「一条都没有」时给出明确反馈
    const hit = resignPending().filter((r) => r.stateCode === "created").filter((r) => {
      const dl = resignDeadline(r);
      return dl && dl.left > 0 && dl.left <= state.resignAutoH * 3600 * 1000;
    }).length;
    if (!hit) {
      const loading = state.resignLoading || !state.resignAt;
      showNotice(loading
        ? `自动确认已开启（审核剩余 ≤${state.resignAutoH} 小时）。正在读取离职申请，读取完成后会自动处理。`
        : `自动确认已开启（审核剩余 ≤${state.resignAutoH} 小时）。当前没有落入阈值的待审核离职日期。`, "", 5000);
      return;
    }
    await autoConfirmResign();
  });
  const rh = $("resign-auto-h");
  if (rh) {
    const applyH = () => {
      const n = Number(rh.value);
      const v = isFinite(n) && n > 0 ? Math.min(72, Math.max(1, Math.round(n))) : 12;
      state.resignAutoH = v;
      rh.value = String(v);
      try { localStorage.setItem(LS_RESIGN_AUTO_H, String(v)); } catch (e) { /* ignore */ }
      resignAutoLabel();
      if (state.resignAuto) autoConfirmResign();
    };
    rh.addEventListener("change", applyH);
    rh.addEventListener("blur", applyH);
    rh.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyH(); rh.blur(); } });
  }
  const rbtn = $("btn-resign-refresh");
  if (rbtn) rbtn.addEventListener("click", () => fetchResign());
  const ropen = $("btn-resign-open");
  if (ropen) ropen.addEventListener("click", () => window.open(RESIGN_PAGE_URL, "_blank", "noopener"));
  const hbtn = $("btn-health-refresh");
  if (hbtn) hbtn.addEventListener("click", () => fetchHealth());
  const honly = $("btn-health-only");
  if (honly) honly.addEventListener("click", () => {
    state.healthOnly = !state.healthOnly;
    try { localStorage.setItem("wb_todo_health_only_v1", state.healthOnly ? "1" : "0"); } catch (e) { /* ignore */ }
    renderAll();
  });
  const hopen = $("btn-health-open");
  if (hopen) hopen.addEventListener("click", () => window.open(HC_PAGE_URL, "_blank", "noopener"));
  const lbtn = $("btn-ledger-refresh");
  if (lbtn) lbtn.addEventListener("click", () => fetchLedger());
  const llist = $("td-ledger-list");
  if (llist) llist.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ledger-id]");
    if (b) openLedgerModal(b.dataset.ledgerId);
  });
  const lmask = $("td-lg-mask");
  if (lmask) lmask.addEventListener("click", (e) => { if (e.target === lmask) closeLedgerModal(); });
  const lclose = $("td-lg-close");
  if (lclose) lclose.addEventListener("click", closeLedgerModal);
  const lpass = $("td-lg-pass");
  if (lpass) lpass.addEventListener("click", () => submitLedger(true));
  const lreject = $("td-lg-reject");
  if (lreject) lreject.addEventListener("click", () => submitLedger(false));
  const lvoid = $("td-lg-void");
  if (lvoid) lvoid.addEventListener("click", voidLedger);
  $("btn-warn-cfg").addEventListener("click", openWarnCfg);
  $("td-cfg-close").addEventListener("click", closeWarnCfg);
  $("td-cfg-save").addEventListener("click", saveWarnCfgFromDom);
  $("td-cfg-reset").addEventListener("click", () => {
    state.cfg = { default: 0, groups: {} };
    const cat = {};
    for (const c of CAT_SPEC) cat[c.k] = c.def;
    state.catCfg = cat;
    state.trainDays = cat.trainDays;
    saveWarnCfg();
    saveCatCfg();
    saveTrainDays(cat.trainDays);
    renderCfgRows();
    renderAll();
  });
  $("td-cfg-mask").addEventListener("click", (e) => { if (e.target === $("td-cfg-mask")) closeWarnCfg(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("td-rg-mask") && !$("td-rg-mask").hidden) { closeResignModal(); return; }
    if (!$("td-lg-mask") || $("td-lg-mask").hidden) closeWarnCfg();
    else closeLedgerModal();
  });
  document.querySelectorAll(".td-filter").forEach((b) => {
    b.addEventListener("click", () => setFilter(b.dataset.filter));
  });
  let timer = null;
  $("td-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; renderAll(); }, 120);
  });
}

window.__TODO__ = {
  state, loadTasks, fetchTraining, renderTraining, allItems,
  fetchLedger, renderLedger, ledgerPending, fetchResign, renderResign, resignPending,
  fetchHealth, renderHealth, healthPending,
  threeCardIndex, openLedgerModal, submitLedger, voidLedger,
  warnState, stationOf, riderOf, filter: filteredTasks, renderAll, setFilter
};

// 自动刷新间隔取全局设置（默认 5 分钟，可在工具栏改；0 = 关闭）
function autoRefreshMs() {
  const sec = window.WBAutoRefresh ? WBAutoRefresh.sec : 300;
  return sec > 0 ? sec * 1000 : 0;
}

function autoRefresh(force) {
  const every = autoRefreshMs();
  if (!every) return;
  const now = Date.now();
  const taskAt = state.loadedAt ? state.loadedAt.getTime() : 0;
  const due = (last) => force || !last || now - last >= every - 5000;
  if (!state.loading && due(taskAt)) loadTasks();
  if (!state.trainingLoading && due(state.trainingAt)) {
    fetchTraining({ silent: true });
  }
  if (!state.ledgerLoading && due(state.ledgerAt)) {
    fetchLedger({ silent: true });
  }
  if (!state.resignLoading && due(state.resignAt)) {
    fetchResign({ silent: true });
  }
  // 健康证要额外拉两次出勤导出，自动刷新放慢到至少 15 分钟一次；手动「刷新」不受限
  if (!state.healthLoading && (force || !state.healthAt || now - state.healthAt >= Math.max(every, 15 * 60 * 1000) - 5000)) {
    fetchHealth({ silent: true });
  }
}

(function boot() {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
      $("tb-ver").textContent = "v" + chrome.runtime.getManifest().version;
    }
  } catch (e) { /* ignore */ }
  state.trainDays = num(state.catCfg.trainDays) || 5;
  bind();
  const cached = loadTrainCache();
  if (cached) {
    state.training = cached.rows || [];
    state.trainingAt = cached.ts || 0;
  }
  const lcached = loadLedgerCache();
  if (lcached) {
    state.ledger = lcached.rows || [];
    state.ledgerAt = lcached.ts || 0;
  }
  const rcached = loadResignCache();
  if (rcached) {
    state.resign = normalizeResignRows(rcached.rows || []);
    state.resignAt = rcached.ts || 0;
  }
  const hcached = loadHealthCache();
  if (hcached) {
    state.health = hcached.rows || [];
    state.healthTeams = hcached.teams || [];
    state.healthPartial = !!hcached.partial;
    state.healthAt = hcached.ts || 0;
  }
  resignAutoLabel();
  renderAll();
  loadTasks();
  fetchTraining({ silent: !!cached });
  fetchLedger({ silent: !!lcached });
  fetchResign({ silent: !!rcached });
  fetchHealth({ silent: !!hcached });
  setInterval(autoRefresh, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) autoRefresh(false);
  });
})();
