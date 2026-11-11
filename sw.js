// 风神考核看板（插件版 v3.2.0） - MV3 Service Worker（ES module）
// 职责：
//   1. 注册 declarativeNetRequest 动态规则，为扩展自身发出的 xtop 请求补上正确的 Origin / Referer
//      （静态 rules.json 在部分 Chromium 版本上不作用于扩展自己发起的 fetch，动态规则是必需的双保险）
//   2. 给 OSS 的 xlsx 响应补 CORS 头，保证排班/考勤文件在插件页内可解析
//   3. 点击图标打开 / 复用看板标签页
//   4. 提供「静默桥接通道」：直连失败时，在后台（不激活）的风神标签页上下文里发请求，
//      天然携带页面 Cookie 与正确 Referer，全程不弹窗、不抢焦点、不依赖任何本地服务。
//   5. FETCH_BINARY：个别内核下扩展页 fetch 二进制受限时，由 SW 代取。
//   6. 自动更新：由 updater.js 定时检查 GitHub 版本、下载新版，并在磁盘文件更新后自动重载。
//      本文件只做消息路由，不承载更新业务逻辑。

import { initUpdater, handleUpdateMessage } from "./updater.js";

initUpdater();

const REF = "https://a.ele.me/app/fnjp-gfe/pikipek-apps/aeolus/index.html?platform=fs";
const RULE_ID = 91001;
const CORS_RULE_ID = 91002;
const DASHBOARD = chrome.runtime.getURL("dashboard.html");
// v3.6.0：出勤达成是独立页面，两个入口可以各自在独立标签页打开，互不覆盖
const ATTENDANCE = chrome.runtime.getURL("attendance.html");
// v3.15.0：运力模块是第三个独立页面
const WORKFORCE = chrome.runtime.getURL("workforce.html");
// v3.17.0：排班模块是第四个独立页面
const SCHEDULE = chrome.runtime.getURL("schedule.html");
// v3.21.0：物资租用是第五个独立页面
const RENT = chrome.runtime.getURL("rent.html");
// v3.27.0：实时出勤监控是第六个独立页面
const REALTIME = chrome.runtime.getURL("realtime.html");
const PAGE_URL = { assess: DASHBOARD, attendance: ATTENDANCE, workforce: WORKFORCE, schedule: SCHEDULE, rent: RENT, realtime: REALTIME };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 请求头规则
async function ensureRules() {
  const rules = [
    {
      id: RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "https://a.ele.me" },
          { header: "Referer", operation: "set", value: REF }
        ]
      },
      condition: {
        urlFilter: "||httpizza.ele.me/xtop/",
        resourceTypes: ["xmlhttprequest"],
        // 不干预风神前端页面自己发出的请求（它们本来就带着正确的头）
        excludedInitiatorDomains: ["a.ele.me", "r.ele.me", "ele.me"]
      }
    },
    {
      // 排班 / 考勤 xlsx 落在 OSS，部分响应不带 CORS 头，补一条作为兜底
      id: CORS_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" }
        ]
      },
      condition: {
        urlFilter: "||aliyuncs.com/",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    }
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID, CORS_RULE_ID],
    addRules: rules
  });
  return true;
}

chrome.runtime.onInstalled.addListener(() => { ensureRules().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureRules().catch(() => {}); });
ensureRules().catch(() => {}); // SW 每次被唤醒都幂等确认一次

// ---------------------------------------------------------------- 看板标签页 / 悬浮面板
async function openDashboardTab(page) {
  const url = PAGE_URL[page] || DASHBOARD;
  const all = await chrome.tabs.query({});
  const exist = all.find((t) => (t.url || "").startsWith(url));
  if (exist) {
    await chrome.tabs.update(exist.id, { active: true });
    if (exist.windowId != null) await chrome.windows.update(exist.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// 点工具栏图标：当前风神页面有常驻悬浮球时，直接展开/收起面板；
// 不在风神页面（或页面尚未刷新注入）时，退回打开独立标签页。
chrome.action.onClicked.addListener(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null && /^https?:\/\/[^/]*\.?ele\.me\//.test(tab.url || "")) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "WB_TOGGLE_PANEL" });
      if (res && res.ok) return;
    }
  } catch (e) { /* 未注入 content script，走标签页 */ }
  await openDashboardTab();
});

// ---------------------------------------------------------------- 静默桥接标签
let bridgeTabId = null;
let bridgeOwned = false;   // 只有插件自己新建的标签才允许被关闭

async function getBridgeTab() {
  if (bridgeTabId != null) {
    try {
      const t = await chrome.tabs.get(bridgeTabId);
      if (t && (t.url || "").startsWith("https://a.ele.me/")) return bridgeTabId;
    } catch (e) { /* 标签已关闭 */ }
    bridgeTabId = null;
  }
  // 复用用户已经打开的风神页面，避免多开（此标签不属于插件，永不关闭）
  const opened = await chrome.tabs.query({ url: "https://a.ele.me/*" });
  if (opened.length) {
    bridgeTabId = opened[0].id;
    bridgeOwned = false;
    return bridgeTabId;
  }
  // 万不得已才新建一个后台标签（active:false，不抢焦点）
  const t = await chrome.tabs.create({ url: REF, active: false });
  bridgeTabId = t.id;
  bridgeOwned = true;
  await sleep(1500);
  return bridgeTabId;
}

// 注入到 a.ele.me 页面 isolated world 执行：页面上下文天然满足 Cookie 与 Referer 校验。
// api 由消息传入，因此运单查询 / 排班导出 / 考勤导出共用同一条桥接通道。
async function apiInPage(api, payload) {
  const r = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    credentials: "include",
    referrerPolicy: "unsafe-url",
    body: JSON.stringify(payload)
  });
  return { status: r.status, json: await r.json() };
}

// v3.15.0：人资成员管理是 GET 接口（app2-edu.ele.me），同样借桥接标签的 Cookie / Referer 发请求
async function getInPage(url) {
  const r = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
  return { status: r.status, json: await r.json() };
}

const QUERY_API = "https://httpizza.ele.me/xtop/xtop.agencyTrackingFs.queryTracking/2.0";

async function bridgeApi(api, payload, method) {
  const isGet = String(method || "POST").toUpperCase() === "GET";
  const func = isGet ? getInPage : apiInPage;
  const args = isGet ? [api] : [api, payload];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tabId = await getBridgeTab();
      const out = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args
      });
      const val = out && out[0] && out[0].result;
      if (!val) throw new Error("桥接标签未返回结果（可能尚未登录风神）");
      return { ok: true, ...val };
    } catch (e) {
      lastErr = e;
      await sleep(900);
      if (attempt >= 1) {
        if (bridgeTabId != null && bridgeOwned) {
          try { await chrome.tabs.remove(bridgeTabId); } catch (x) { /* ignore */ }
        }
        bridgeTabId = null;
        bridgeOwned = false;
      }
    }
  }
  return { ok: false, error: String(lastErr || "桥接通道失败") };
}

async function fetchBinary(url) {
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return { ok: true, buffer: await r.arrayBuffer() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------- 消息路由
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 自动更新相关消息统一转交 updater.js，SW 只负责路由与响应格式
  if (msg.type.startsWith("WB_UPD_")) {
    handleUpdateMessage(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === "ENSURE_RULES") {
    ensureRules().then(() => sendResponse({ ok: true }))
                 .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 悬浮面板标题栏的「新标签打开」：按当前页签打开对应的独立页面
  if (msg.type === "WB_OPEN_TAB") {
    openDashboardTab(msg.page).then(() => sendResponse({ ok: true }))
                      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "BRIDGE_API" || msg.type === "BRIDGE_QUERY" || msg.type === "BRIDGE_GET") {
    const isGet = msg.type === "BRIDGE_GET";
    bridgeApi(msg.api || msg.url || QUERY_API, msg.payload, isGet ? "GET" : (msg.method || "POST"))
      .then(sendResponse);
    return true;
  }

  if (msg.type === "FETCH_BINARY") {
    fetchBinary(msg.url).then(sendResponse);
    return true;
  }

  if (msg.type === "CLOSE_BRIDGE") {
    (async () => {
      // 只关插件自己创建的后台标签，绝不误关用户正在使用的风神页面
      if (bridgeTabId != null && bridgeOwned) {
        try { await chrome.tabs.remove(bridgeTabId); } catch (e) { /* ignore */ }
        bridgeTabId = null;
        bridgeOwned = false;
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
