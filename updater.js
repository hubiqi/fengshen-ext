/* 风神考核看板 · 自动更新模块（MV3 Service Worker / ES module）
 *
 * 版本源：GitHub 公开仓库 main 分支的 version.json，匿名只读，无需任何令牌。
 *        主源 raw.githubusercontent.com；备源 GitHub contents API（带 raw accept 头，实时返回原始 JSON）。
 *        主源在国内网络下偶发超时 / 502，此时自动切备源；不用 jsDelivr 等 CDN 镜像：
 *        它们对 @main 有长缓存，发版后仍返回旧版本号，会让「检查更新」误判为无新版本。
 * 职责：
 *   1. 每 6 小时（以及安装 / 浏览器启动 / 手动点击）检查 GitHub 上的最新版本号
 *   2. 把状态写入 chrome.storage.local，供看板页面与 content script 渲染提示
 *   3. 一键下载新版 zip（chrome.downloads），并标注下载地址与版本说明
 *   4. 检测「磁盘上的插件文件已比运行时新」并自动 chrome.runtime.reload()
 *      —— 用户解压覆盖新版文件后，无需再去 chrome://extensions 手动点重新加载
 *
 * 边界说明：Chrome 扩展运行在沙箱内，不能改写自身安装目录。因此「检查 / 提示 / 下载」
 * 可以全自动，而「把新版文件放进插件目录」这一步必须由用户（或本机脚本）完成；
 * 完成后扩展会自己发现磁盘版本变化并自动重载，形成闭环。
 */

const OWNER = "hubiqi";
const REPO = "fengshen-ext";
const BRANCH = "main";
// 两个源都返回同一份「实时」version.json；任一可达即可完成检查，避免单点网络故障
const VERSION_URLS = [
  { url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/version.json` },
  {
    url: `https://api.github.com/repos/${OWNER}/${REPO}/contents/version.json?ref=${BRANCH}`,
    headers: { "Accept": "application/vnd.github.raw+json" }
  }
];
const REMOTE_TIMEOUT_MS = 8000;              // 单个源最多等 8 秒，超时立即换下一个

const STATE_KEY = "wb_update_state";
const ALARM_CHECK = "wb-upd-check";
const ALARM_POLL = "wb-upd-poll";
const CHECK_PERIOD_MIN = 360;              // 常规检查：6 小时一次
const POLL_PERIOD_MIN = 1;                 // 下载后的快速磁盘轮询：1 分钟一次
const POLL_WINDOW_MS = 30 * 60 * 1000;     // 快速轮询持续 30 分钟
const RELOAD_COOLDOWN_MS = 60 * 1000;      // 防止极端情况下反复 reload

const DEFAULT_STATE = {
  current: "", latest: "", notes: "", download: "", publishedAt: "",
  // source / remoteVersion 用来证明「这次真的连上了 GitHub、读到的远端版本号是多少」，
  // 否则「没有新版本」和「检查请求根本没发出去」在界面上无法区分。
  checkedAt: 0, source: "", remoteVersion: "",
  available: false, skipped: "", downloading: false,
  downloadId: null, downloadedAt: 0, pollUntil: 0, lastReloadAt: 0, error: ""
};

const currentVersion = () => chrome.runtime.getManifest().version;
const swallow = (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); return p; };

/** 数字段逐位比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersion(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

async function getState() {
  const o = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...(o[STATE_KEY] || {}), current: currentVersion() };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch, current: currentVersion() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  await refreshBadge(next);
  // 广播给所有扩展页面（看板标签页 / 悬浮 iframe）；content script 走 storage.onChanged
  try { swallow(chrome.runtime.sendMessage({ type: "WB_UPDATE_CHANGED", state: next })); } catch (e) { /* ignore */ }
  return next;
}

async function refreshBadge(s) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
    await chrome.action.setBadgeText({
      text: s.available && s.latest !== s.skipped ? "NEW" : ""
    });
  } catch (e) { /* 少数内核不支持 badge，忽略 */ }
}

async function fetchJSON(url, timeoutMs = 0, headers = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "omit", signal: ctrl.signal, headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { if (timer) clearTimeout(timer); }
}

/** 依次尝试各版本源：超时 / 网络错误 / 内容不合法都会自动换下一个。
 *  返回 { data, source }，source 为实际命中的域名，用于给 UI 证明链路确实通了。 */
async function fetchVersionJSON() {
  const errors = [];
  for (const src of VERSION_URLS) {
    const bust = (src.url.includes("?") ? "&" : "?") + "t=" + Date.now();
    try {
      const data = await fetchJSON(src.url + bust, REMOTE_TIMEOUT_MS, src.headers || {});
      if (!data || !/^\d+(\.\d+)*$/.test(String(data.version || ""))) {
        throw new Error("version.json 格式不正确");
      }
      return { data, source: new URL(src.url).hostname };
    } catch (e) {
      errors.push(`${new URL(src.url).hostname}: ${e && e.message ? e.message : e}`);
    }
  }
  throw new Error("版本源均不可达（" + errors.join("；") + "）");
}

/** 磁盘自检：解压加载的扩展，其静态资源是实时从磁盘读取的，
 *  因此用户覆盖新版文件后，这里读到的 version.json 就是新版本。 */
async function checkDiskVersion(force) {
  let disk;
  try {
    disk = await fetchJSON(chrome.runtime.getURL("version.json") + "?t=" + Date.now());
  } catch (e) {
    return { ok: false, reason: "disk_unreadable" };
  }
  if (!disk || !/^\d+(\.\d+)*$/.test(String(disk.version || ""))) {
    return { ok: false, reason: "disk_invalid" };
  }
  if (compareVersion(disk.version, currentVersion()) <= 0) {
    return { ok: true, updated: false, disk: disk.version };
  }
  const s = await getState();
  if (!force && Date.now() - (s.lastReloadAt || 0) < RELOAD_COOLDOWN_MS) {
    return { ok: true, updated: false, pending: true, disk: disk.version };
  }
  await setState({ lastReloadAt: Date.now(), available: false, error: "", pollUntil: 0 });
  chrome.runtime.reload();
  return { ok: true, updated: true, disk: disk.version };
}

/** 检查 GitHub 上的新版本。manual=true 时忽略「忽略此版本」的标记并立即返回错误详情 */
async function checkForUpdate(manual = false) {
  try {
    const disk = await checkDiskVersion(false);
    if (disk.updated) return { ok: true, reloading: true };
  } catch (e) { /* 自检失败不影响联网检查 */ }

  try {
    const { data: remote, source } = await fetchVersionJSON();
    const latest = String(remote.version);
    const cmp = compareVersion(latest, currentVersion());
    const s = await getState();
    const skipped = !manual && s.skipped === latest;
    const state = await setState({
      latest: cmp > 0 ? latest : currentVersion(),
      notes: remote.notes || "",
      download: remote.download || "",
      publishedAt: remote.published_at || "",
      checkedAt: Date.now(),
      source, remoteVersion: latest,
      available: cmp > 0 && !skipped,
      error: ""
    });
    return { ok: true, state, hasNew: cmp > 0, source, remoteVersion: latest };
  } catch (e) {
    // 失败时清空上次成功的来源信息，避免界面把「旧记录」当成本次连接成功
    const state = await setState({
      checkedAt: Date.now(), source: "", remoteVersion: "",
      error: String(e && e.message ? e.message : e)
    });
    return { ok: false, state, error: state.error };
  }
}

async function downloadUpdate() {
  const s = await getState();
  if (!s.available || !s.download) return { ok: false, error: "当前没有可下载的新版本" };
  try {
    const filename = `fengshen-ext-v${s.latest}.zip`;
    const id = await chrome.downloads.download({
      url: s.download,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    await setState({
      downloading: true, downloadId: id, downloadedAt: 0,
      pollUntil: Date.now() + POLL_WINDOW_MS, error: ""
    });
    swallow(chrome.alarms.create(ALARM_POLL, {
      delayInMinutes: POLL_PERIOD_MIN, periodInMinutes: POLL_PERIOD_MIN
    }));
    return { ok: true, downloadId: id, filename };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function onPoll() {
  const s = await getState();
  if (!s.pollUntil || Date.now() > s.pollUntil) {
    await chrome.alarms.clear(ALARM_POLL);
    return;
  }
  try {
    const d = await checkDiskVersion(false);
    if (d.updated) await chrome.alarms.clear(ALARM_POLL);
  } catch (e) { /* ignore */ }
}

function bindDownloads() {
  if (!chrome.downloads || !chrome.downloads.onChanged) return;
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state || delta.state.current !== "complete") return;
    try {
      const s = await getState();
      if (s.downloadId != null && delta.id !== s.downloadId) return;
      if (!s.downloading) return;
      await setState({ downloading: false, downloadedAt: Date.now(), downloadId: null });
    } catch (e) { /* ignore */ }
  });
}

let initialized = false;

/** 在 service worker 顶层调用一次，注册定时器与生命周期钩子 */
export function initUpdater() {
  if (initialized) return;
  initialized = true;

  bindDownloads();
  getState().then(refreshBadge).catch(() => {});

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_CHECK) checkForUpdate(false).catch(() => {});
    else if (alarm.name === ALARM_POLL) onPoll().catch(() => {});
  });

  swallow(chrome.alarms.create(ALARM_CHECK, {
    delayInMinutes: 2, periodInMinutes: CHECK_PERIOD_MIN
  }));

  const kick = () => { checkForUpdate(false).catch(() => {}); };
  chrome.runtime.onInstalled.addListener(kick);
  chrome.runtime.onStartup.addListener(kick);

  // SW 每次被唤醒都做一次磁盘自检：覆盖文件后，用户点一下图标即可自动生效
  checkDiskVersion(false).catch(() => {});
}

/** sw.js 的消息路由把 WB_UPD_* 前缀的消息转交到这里 */
export async function handleUpdateMessage(msg) {
  switch (msg.type) {
    case "WB_UPD_STATE":
      return { ok: true, state: await getState() };
    case "WB_UPD_CHECK":
      return checkForUpdate(true);
    case "WB_UPD_DOWNLOAD":
      return downloadUpdate();
    case "WB_UPD_SKIP": {
      const s = await getState();
      return { ok: true, state: await setState({ skipped: s.latest, available: false }) };
    }
    case "WB_UPD_APPLY":
      return checkDiskVersion(true);
    case "WB_UPD_OPEN_EXTENSIONS":
      await chrome.tabs.create({ url: "chrome://extensions" });
      return { ok: true };
    default:
      return { ok: false, error: "未知的更新消息类型" };
  }
}
