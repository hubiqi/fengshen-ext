/* 全局自动刷新设置
 *
 * 默认 5 分钟，可在任意页面工具栏里改：关闭 / 1 / 3 / 5 / 10 / 15 / 30 / 60 分钟。
 * 设置存在 localStorage（wb_auto_refresh_sec_v1），所有模块、所有标签页共用一份。
 *
 * 用法：
 *   WBAutoRefresh.register(fn)      // 注册一个刷新回调，按当前间隔自动执行
 *   WBAutoRefresh.enabled()         // 是否开启自动刷新
 *   WBAutoRefresh.sec               // 当前间隔（秒），0 = 关闭
 *   WBAutoRefresh.set(sec)          // 修改间隔（秒），立即生效
 *   WBAutoRefresh.setEnabled(bool)  // 页面层面临时禁用（如考勤历史日期），不改用户设置
 */
(function () {
  "use strict";

  const KEY = "wb_auto_refresh_sec_v1";
  const DEFAULT_SEC = 300;
  const OPTIONS = [
    { sec: 0, label: "关闭" },
    { sec: 60, label: "1 分钟" },
    { sec: 180, label: "3 分钟" },
    { sec: 300, label: "5 分钟" },
    { sec: 600, label: "10 分钟" },
    { sec: 900, label: "15 分钟" },
    { sec: 1800, label: "30 分钟" },
    { sec: 3600, label: "60 分钟" }
  ];

  function readSec() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
    if (raw === null || raw === "") return DEFAULT_SEC;
    const n = parseInt(raw, 10);
    return isFinite(n) && n >= 0 ? n : DEFAULT_SEC;
  }

  function fmt(sec) {
    if (!sec) return "关闭";
    if (sec % 3600 === 0) return `${sec / 3600} 小时`;
    if (sec % 60 === 0) return `${sec / 60} 分钟`;
    return `${sec} 秒`;
  }

  const subs = [];
  let timer = null;
  let selEl = null;
  let uiEnabled = true;
  let running = false;
  let lastRun = Date.now();

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const sec = readSec();
    if (!sec || !uiEnabled || !subs.length) return;
    timer = setTimeout(run, sec * 1000);
  }

  async function run() {
    timer = null;
    const sec = readSec();
    if (!sec || !uiEnabled || document.hidden || running) { schedule(); return; }
    running = true;
    lastRun = Date.now();
    try {
      for (const s of subs) {
        try { await s.fn(); } catch (e) { /* 单个模块失败不影响其它模块 */ }
      }
    } finally {
      running = false;
    }
    schedule();
  }

  function paint() {
    if (!selEl) return;
    const sec = readSec();
    if (!Array.prototype.some.call(selEl.options, (o) => +o.value === sec)) {
      const op = document.createElement("option");
      op.value = String(sec);
      op.textContent = fmt(sec);
      selEl.appendChild(op);
    }
    selEl.value = String(sec);
    selEl.classList.toggle("is-off", !sec);
    selEl.title = sec
      ? `自动刷新间隔：${fmt(sec)}（所有模块共用，可修改）`
      : "自动刷新已关闭（所有模块共用，可修改）";
  }

  function set(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    try { localStorage.setItem(KEY, String(n)); } catch (e) { /* ignore */ }
    paint();
    schedule();
  }

  function setEnabled(on) {
    uiEnabled = !!on;
    if (selEl) {
      selEl.classList.toggle("is-locked", !uiEnabled);
      selEl.title = uiEnabled
        ? "自动刷新间隔（所有模块共用，可修改）"
        : "当前是历史定稿数据，本页不自动刷新（设置本身可改，只影响实时页面）";
    }
    schedule();
  }

  function register(fn) {
    if (typeof fn !== "function") return () => {};
    const item = { fn };
    subs.push(item);
    if (subs.length === 1) schedule();
    return () => {
      const i = subs.indexOf(item);
      if (i >= 0) subs.splice(i, 1);
      if (!subs.length) schedule();
    };
  }

  function injectStyle() {
    if (document.getElementById("wb-ar-style")) return;
    const st = document.createElement("style");
    st.id = "wb-ar-style";
    st.textContent = [
      ".wb-ar{font-size:12px;color:#374151;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}",
      ".wb-ar-sel{height:28px;font-size:12px;padding:0 6px;border:1px solid #CBD5E1;border-radius:6px;",
      "background:#fff;color:#1F2937;outline:none;cursor:pointer;font-family:inherit}",
      ".wb-ar-sel:hover{border-color:#94A3B8}",
      ".wb-ar-sel.is-off{color:#B45309;border-color:#FCD34D;background:#FFFBEB}",
      ".wb-ar-sel.is-locked{opacity:.65}",
      ".wb-ar-sel:disabled{opacity:.55;cursor:not-allowed;background:#F8FAFC}"
    ].join("");
    document.head.appendChild(st);
  }

  function mount() {
    injectStyle();
    if (selEl && selEl.isConnected) { paint(); return; }
    const bar = document.getElementById("toolbar") || document.querySelector(".toolbar");
    if (!bar) return;

    const wrap = document.createElement("span");
    wrap.className = "chk wb-ar";
    wrap.id = "wb-ar-wrap";
    const txt = document.createElement("span");
    txt.textContent = "自动刷新";

    selEl = document.createElement("select");
    selEl.id = "wb-ar-sel";
    selEl.className = "wb-ar-sel";
    for (const o of OPTIONS) {
      const op = document.createElement("option");
      op.value = String(o.sec);
      op.textContent = o.label;
      selEl.appendChild(op);
    }
    selEl.addEventListener("change", () => set(selEl.value));
    wrap.append(txt, selEl);

    const btn = document.getElementById("btn-refresh");
    if (btn && btn.parentNode) btn.parentNode.insertBefore(wrap, btn);
    else bar.appendChild(wrap);

    paint();
  }

  window.addEventListener("storage", (e) => {
    if (!e || e.key !== KEY) return;
    paint();
    schedule();
  });

  // 切回页面时：如果这一轮本该刷新（隐藏期间跳过过），回来立刻补一次
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const sec = readSec();
    if (!sec || !uiEnabled || running) return;
    if (Date.now() - lastRun < sec * 1000) return;
    if (timer) { clearTimeout(timer); timer = null; }
    run();
  });

  // 同页其它脚本改设置时立即生效
  window.addEventListener("wb:auto-refresh", () => { paint(); schedule(); });

  window.WBAutoRefresh = {
    get sec() { return readSec(); },
    get enabled() { return readSec() > 0 && uiEnabled; },
    set,
    setEnabled,
    register,
    format: fmt,
    mount,
    DEFAULT_SEC
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
