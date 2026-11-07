/* 风神看板 · 一颗总按钮 + 两个独立功能入口（content script）
 *
 * v3.6.0：新功能「出勤达成」不再挂在原考核看板里，改为独立页面：
 *   总按钮（可拖动） -> 展开小菜单 -> 「考核看板」/「出勤达成」两个子入口
 *   子入口分别打开 dashboard.html / attendance.html，各自独立刷新与复制图片。
 * 面板顶部另有「考核看板 / 出勤达成」两个页签，双 iframe 各自保留状态，
 * 切回来不会重新拉数、也不会互相污染。两个功能分开，但入口归到同一颗总按钮里。
 */
(function () {
  "use strict";

  if (window.top !== window.self) return;                    // 只在顶层页面注入
  if (document.getElementById("wb-assess-host")) return;    // 防止重复注入

  const HAS_EXT = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
  const SIZE = 56;
  const EDGE = 16;
  const DEFAULT_TOP = 236;   // 避开 FengshenMonitor 那颗默认 top:150px 的悬浮球
  const PAGES = {
    assess: HAS_EXT ? chrome.runtime.getURL("dashboard.html") : "dashboard.html",
    attendance: HAS_EXT ? chrome.runtime.getURL("attendance.html") : "attendance.html"
  };
  const POS_KEY = "wb_assess_launcher_pos";   // 只有一颗总按钮，位置只记一份
  const DEF_TOP = DEFAULT_TOP;
  const HEAD = {
    assess: { title: "指定日考核看板", sub: "规划单量完成率 · 标2骑手占比 · 时段达成矩阵" },
    attendance: { title: "出勤达成", sub: "应排 / 实排 / 有效出勤 · 实排达成 / 应排达成" }
  };

  // ---------------------------------------------------------------- 样式（Shadow DOM 隔离）
  const CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wb-launcher {
    position: fixed; width: ${SIZE}px; height: ${SIZE}px; z-index: 2147483600;
    border-radius: 50%; border: 2px solid rgba(255,255,255,.85); cursor: pointer;
    background: linear-gradient(145deg, #4a7fd0 0%, #2f5597 62%, #24427a 100%);
    box-shadow: 0 6px 20px rgba(24,54,110,.38), 0 2px 6px rgba(0,0,0,.18);
    color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center;
    user-select: none; -webkit-user-select: none; touch-action: none; line-height: 1;
    transition: transform .16s ease, box-shadow .16s ease, opacity .16s ease;
  }
  .wb-launcher:hover { transform: scale(1.08); box-shadow: 0 8px 26px rgba(24,54,110,.5); }
  .wb-launcher.dragging { transition: none; opacity: .82; cursor: grabbing; transform: scale(1.04); }
  .wb-launcher.active { background: linear-gradient(145deg, #d97706 0%, #b45309 100%); }
  .wb-launcher .wb-ico { width: 19px; height: 19px; margin-bottom: 2px; display: block; }
  .wb-launcher .wb-txt { font-size: 13px; font-weight: 700; letter-spacing: 1px; }
  .wb-launcher .wb-dot {
    position: absolute; top: -2px; right: -2px; width: 13px; height: 13px; border-radius: 50%;
    background: #22c55e; border: 2px solid #fff; display: none;
  }
  .wb-launcher.active .wb-dot { display: block; }
  /* GitHub 发现新版本时的角标，放左上角避开右上角的激活绿点 */
  .wb-launcher .wb-upd {
    position: absolute; top: -5px; left: -7px; height: 18px; min-width: 18px; padding: 0 4px;
    border-radius: 9px; background: #dc2626; color: #fff; border: 2px solid #fff;
    font-size: 9px; font-weight: 700; line-height: 14px; letter-spacing: .3px;
    display: none; align-items: center; justify-content: center;
  }
  .wb-launcher.has-update .wb-upd { display: flex; }
  .wb-tip {
    position: fixed; z-index: 2147483601; padding: 6px 10px; border-radius: 6px;
    background: rgba(17,24,39,.92); color: #fff; font-size: 12px; white-space: nowrap;
    pointer-events: none; opacity: 0; transition: opacity .15s; box-shadow: 0 4px 12px rgba(0,0,0,.2);
  }
  .wb-tip.show { opacity: 1; }

  /* 总按钮展开的功能菜单：两个独立入口放在一起，不再散落两颗球 */
  .wb-menu {
    position: fixed; z-index: 2147483602; width: 204px; padding: 6px;
    border-radius: 12px; background: #FFFFFF; border: 1px solid #E5E7EB;
    box-shadow: 0 14px 40px rgba(15,23,42,.22), 0 2px 8px rgba(0,0,0,.10);
    display: none; flex-direction: column; gap: 4px;
  }
  .wb-menu.open { display: flex; }
  .wb-menu-head { padding: 4px 8px 6px; font-size: 11px; color: #6B7280;
    border-bottom: 1px solid #F3F4F6; margin-bottom: 2px; }
  .wb-menu-item {
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
    border: 0; border-radius: 8px; background: transparent; color: #1F2937;
    font-size: 13px; font-weight: 600; cursor: pointer; text-align: left;
  }
  .wb-menu-item:hover { background: #F3F6FC; }
  .wb-menu-item > span:last-child { min-width: 0; flex: 1; }
  .wb-menu-item .mi-ico { width: 28px; height: 28px; border-radius: 8px; flex: 0 0 28px;
    display: inline-flex; align-items: center; justify-content: center; color: #FFF; }
  .wb-menu-item .mi-ico svg { width: 16px; height: 16px; }
  .wb-menu-item.assess .mi-ico { background: #2F5597; }
  .wb-menu-item.attendance .mi-ico { background: #0B7C60; }
  .wb-menu-item .mi-sub { display: block; font-size: 10px; font-weight: 400; color: #6B7280;
    margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .wb-mask {
    position: fixed; inset: 0; z-index: 2147483610; background: rgba(15,23,42,.48);
    display: none; align-items: center; justify-content: center;
  }
  .wb-mask.open { display: flex; }
  .wb-panel {
    width: min(1460px, 96vw); height: min(92vh, 980px); background: #fff;
    border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;
    box-shadow: 0 28px 90px rgba(0,0,0,.36), 0 0 0 1px rgba(255,255,255,.5);
  }
  .wb-head {
    height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 12px;
    padding: 0 14px 0 18px; color: #fff;
    background: linear-gradient(100deg, #2f5597 0%, #3b6fc0 100%);
  }
  .wb-head .wb-title { font-size: 15px; font-weight: 700; white-space: nowrap; }
  .wb-head .wb-sub { font-size: 11px; opacity: .78; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wb-head .wb-spacer { flex: 1; }
  .wb-tabs { display: inline-flex; gap: 4px; padding: 3px; border-radius: 8px;
    background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.18); }
  .wb-tab { height: 26px; padding: 0 12px; border-radius: 6px; border: 1px solid transparent;
    background: transparent; color: rgba(255,255,255,.82); font-size: 12px; cursor: pointer;
    white-space: nowrap; }
  .wb-tab:hover { background: rgba(255,255,255,.16); }
  .wb-tab.active { background: rgba(255,255,255,.30); border-color: rgba(255,255,255,.55);
    color: #fff; font-weight: 700; }
  .wb-btn {
    height: 30px; padding: 0 11px; border-radius: 6px; border: 1px solid rgba(255,255,255,.32);
    background: rgba(255,255,255,.13); color: #fff; font-size: 12px; cursor: pointer;
    white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
  }
  .wb-btn:hover { background: rgba(255,255,255,.26); }
  .wb-btn.close { border-color: transparent; font-size: 19px; width: 30px; padding: 0; justify-content: center; line-height: 1; }
  .wb-frame { flex: 1; width: 100%; border: 0; background: #fff; display: block; }
  .wb-frame[hidden] { display: none !important; }
  .wb-loading { position: absolute; align-self: center; color: #fff; font-size: 13px; opacity: .85; display: none; }

  @media (max-width: 700px) {
    .wb-mask { align-items: stretch; }
    .wb-panel { width: 100vw; height: 100vh; border-radius: 0; }
    .wb-head .wb-sub { display: none; }
  }
  `;

  const ICON_ASSESS = `<svg class="wb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3v18h18"/><rect x="6.5" y="11" width="3" height="7" fill="currentColor" stroke="none"/>
      <rect x="11.5" y="7" width="3" height="11" fill="currentColor" stroke="none"/>
      <rect x="16.5" y="13" width="3" height="5" fill="currentColor" stroke="none"/>
    </svg>`;
  const ICON_ATT = `<svg class="wb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="3"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0"/>
      <path d="M16 8v5l3 2"/><circle cx="16" cy="13" r="7"/>
    </svg>`;

  // ---------------------------------------------------------------- 存储（每个入口各记各的位置）
  function savePos(p, key) {
    try {
      if (chrome.storage && chrome.storage.local) { chrome.storage.local.set({ [key]: p }); return; }
    } catch (e) { /* 降级到 localStorage */ }
    try { localStorage.setItem(key, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }
  function loadPos(key, cb) {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(key, (o) => cb((o && o[key]) || null));
        return;
      }
    } catch (e) { /* 降级 */ }
    let v = null;
    try { v = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { /* ignore */ }
    cb(v);
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function fit(p) {
    const maxL = window.innerWidth - SIZE - EDGE;
    const maxT = window.innerHeight - SIZE - EDGE;
    const left = clamp(Number(p && p.left), EDGE, Math.max(EDGE, maxL));
    const top = clamp(Number(p && p.top), EDGE, Math.max(EDGE, maxT));
    return { left, top };
  }

  // ---------------------------------------------------------------- 建 DOM
  const host = document.createElement("div");
  host.id = "wb-assess-host";
  const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  (document.body || document.documentElement).appendChild(host);

  const wrap = document.createElement("div");
  wrap.innerHTML = `<style>${CSS}</style>
    <div class="wb-launcher" id="wbBall" title="风神看板（点击展开功能菜单 / 可拖动）">
      ${ICON_ASSESS}<span class="wb-txt">看板</span><span class="wb-dot"></span><span class="wb-upd">NEW</span>
    </div>
    <div class="wb-tip" id="wbTip">风神看板 · 点击展开（考核 / 出勤）</div>
    <div class="wb-menu" id="wbMenu">
      <div class="wb-menu-head">选择要打开的功能</div>
      <button class="wb-menu-item assess" id="wbMenuAssess">
        <span class="mi-ico">${ICON_ASSESS}</span>
        <span>考核看板<span class="mi-sub">完成率 · 标2占比 · 时段</span></span>
      </button>
      <button class="wb-menu-item attendance" id="wbMenuAtt">
        <span class="mi-ico">${ICON_ATT}</span>
        <span>出勤达成<span class="mi-sub">应排 / 实排 / 有效出勤</span></span>
      </button>
    </div>
    <div class="wb-mask" id="wbMask">
      <div class="wb-panel" id="wbPanel">
        <div class="wb-head">
          <span class="wb-title" id="wbTitle">指定日考核看板</span>
          <span class="wb-sub" id="wbSub">规划单量完成率 · 标2骑手占比 · 时段达成矩阵</span>
          <span class="wb-spacer"></span>
          <div class="wb-tabs">
            <button class="wb-tab active" id="wbTabAssess" title="切回原考核看板（独立页面）">考核看板</button>
            <button class="wb-tab" id="wbTabAtt" title="切到出勤达成（独立页面）">出勤达成</button>
          </div>
          <button class="wb-btn" id="wbReload" title="重新拉取当前看板的数据">↻ 刷新</button>
          <button class="wb-btn" id="wbNewTab" title="把当前看板在独立标签页打开">↗ 新标签打开</button>
          <button class="wb-btn close" id="wbClose" title="关闭（Esc）">×</button>
        </div>
        <!-- clipboard-write：iframe 是扩展页（跨源），需显式授予才能写「复制图片」 -->
        <iframe class="wb-frame" id="wbFrame" title="风神考核看板" allow="clipboard-write *" allowtransparency="false"></iframe>
        <iframe class="wb-frame" id="wbFrameAtt" title="风神出勤达成看板" allow="clipboard-write *" allowtransparency="false" hidden></iframe>
      </div>
    </div>`;
  if (root === host) {
    // 极老内核无 Shadow DOM：直接挂（样式仍生效）
    while (wrap.firstChild) host.appendChild(wrap.firstChild);
  } else {
    root.appendChild(wrap);
  }
  const q = (id) => root.getElementById ? root.getElementById(id) : document.getElementById(id);
  const ball = q("wbBall"), tip = q("wbTip"), mask = q("wbMask"), menu = q("wbMenu");
  const frames = { assess: q("wbFrame"), attendance: q("wbFrameAtt") };
  const tabs = { assess: q("wbTabAssess"), attendance: q("wbTabAtt") };
  const MODES = ["assess", "attendance"];

  // ---------------------------------------------------------------- 自动更新角标（挂在总按钮上）
  let updateState = null;
  function tipFor() {
    if (updateState && updateState.on) return "发现新版本 v" + updateState.latest + " · 打开看板可一键更新";
    return "风神看板 · 点击展开（考核 / 出勤）";
  }
  function applyUpdateState(s) {
    const on = !!(s && s.available && s.latest !== s.skipped);
    updateState = { on, latest: s && s.latest };
    ball.classList.toggle("has-update", on);
  }
  try {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get("wb_update_state", (o) => applyUpdateState(o && o.wb_update_state));
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes.wb_update_state) {
            applyUpdateState(changes.wb_update_state.newValue);
          }
        });
      }
    }
  } catch (e) { /* 存储不可用时静默降级，不影响看板 */ }

  let open = false;
  let menuOpen = false;
  let mode = "assess";
  const loaded = new Set();

  function showTip(show, x, y, text) {
    if (show) {
      tip.textContent = text;
      tip.style.left = Math.max(4, x - 168) + "px";
      tip.style.top = Math.max(4, y - 34) + "px";
      tip.classList.add("show");
    } else tip.classList.remove("show");
  }

  // 菜单贴着总按钮展开：球在屏幕右侧时向左弹，靠左时向右弹，始终留在可视区内
  function placeMenu() {
    const r = ball.getBoundingClientRect();
    const mw = 204, mh = menu.offsetHeight || 130;
    const preferLeft = r.left + SIZE / 2 > window.innerWidth / 2;
    const left = clamp(preferLeft ? r.left - mw - 12 : r.right + 12,
                       8, Math.max(8, window.innerWidth - mw - 8));
    const top = clamp(r.top - 8, 8, Math.max(8, window.innerHeight - mh - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function setMenu(v) {
    menuOpen = v;
    menu.classList.toggle("open", v);
    ball.classList.toggle("menu-open", v);
    if (v) placeMenu();
    else showTip(false);
  }

  function applyMode() {
    q("wbTitle").textContent = HEAD[mode].title;
    q("wbSub").textContent = HEAD[mode].sub;
    for (const m of MODES) {
      frames[m].hidden = (m !== mode);
      tabs[m].classList.toggle("active", m === mode);
    }
    ball.classList.toggle("active", open);
  }

  function setOpen(v, nextMode) {
    if (nextMode && PAGES[nextMode]) mode = nextMode;
    open = v;
    mask.classList.toggle("open", v);
    // 与 FengshenMonitor 一致：面板展开时收起总按钮，避免遮罩下露出半透明色块
    ball.style.display = v ? "none" : "flex";
    if (v) setMenu(false);
    applyMode();
    if (v && !loaded.has(mode)) {
      // 懒加载：每个入口首次打开才拉数；切换页签时另一个 iframe 保持原状态，不重跑
      frames[mode].src = PAGES[mode];
      loaded.add(mode);
    }
    if (!v) showTip(false);
  }

  // ---------------------------------------------------------------- 唯一总按钮：拖动 + 点击展开菜单
  function bindBall(el) {
    let drag = null;
    const place = (left, top) => { el.style.left = left + "px"; el.style.top = top + "px"; };
    loadPos(POS_KEY, (saved) => {
      const p = fit(saved && isFinite(saved.left) ? saved
        : { left: window.innerWidth - SIZE - EDGE, top: DEF_TOP });
      place(p.left, p.top);
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      showTip(false);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) { drag.moved = true; el.classList.add("dragging"); }
      place(clamp(drag.ox + dx, 0, window.innerWidth - SIZE),
            clamp(drag.oy + dy, 0, window.innerHeight - SIZE));
    });
    el.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      el.classList.remove("dragging");
      try { el.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      if (!d.moved) { setMenu(!menuOpen); return; }   // 点总按钮只展开菜单，不直接跳进某个功能
      // 松手吸附到最近侧边
      const r = el.getBoundingClientRect();
      const snapLeft = r.left + SIZE / 2 < window.innerWidth / 2
        ? EDGE : window.innerWidth - SIZE - EDGE;
      const p = fit({ left: snapLeft, top: r.top });
      place(p.left, p.top);
      savePos(p, POS_KEY);
    });
    el.addEventListener("pointercancel", () => { drag = null; el.classList.remove("dragging"); });
    el.addEventListener("mouseenter", () => {
      const r = el.getBoundingClientRect();
      showTip(true, r.left, r.top, tipFor());
    });
    el.addEventListener("mouseleave", () => showTip(false));
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", () => {
      const r = el.getBoundingClientRect();
      const p = fit({ left: r.left, top: r.top });
      place(p.left, p.top);
      if (menuOpen) placeMenu();
    });
  }
  bindBall(ball);

  // 菜单里的两个子入口：各自打开自己的独立页面
  q("wbMenuAssess").addEventListener("click", () => { setMenu(false); setOpen(true, "assess"); });
  q("wbMenuAtt").addEventListener("click", () => { setMenu(false); setOpen(true, "attendance"); });
  // 点页面其他地方 / 按 Esc：先收起菜单，再收起面板
  document.addEventListener("pointerdown", (e) => {
    if (!menuOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(ball) || path.includes(menu)) return;
    setMenu(false);
  }, true);

  // ---------------------------------------------------------------- 面板按钮
  q("wbClose").addEventListener("click", () => setOpen(false));
  mask.addEventListener("click", (e) => { if (e.target === mask) setOpen(false); });
  tabs.assess.addEventListener("click", () => setOpen(true, "assess"));
  tabs.attendance.addEventListener("click", () => setOpen(true, "attendance"));
  q("wbReload").addEventListener("click", () => {
    frames[mode].src = PAGES[mode] + "?_t=" + Date.now();
  });
  q("wbNewTab").addEventListener("click", () => {
    if (HAS_EXT) chrome.runtime.sendMessage({ type: "WB_OPEN_TAB", page: mode });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (menuOpen) { setMenu(false); return; }
    if (open) setOpen(false);
  }, true);

  // iframe 内按 Esc / 点「考核看板 ↗」/ 关闭时通过 postMessage 通知父页面
  window.addEventListener("message", (e) => {
    if (e.source !== frames.assess.contentWindow && e.source !== frames.attendance.contentWindow) return;
    const d = e.data;
    if (!d || d.__wbAssess !== true) return;
    if (d.type === "CLOSE") setOpen(false);
    if (d.type === "TOGGLE") setOpen(!open);
    if (d.type === "SWITCH" && PAGES[d.mode]) setOpen(true, d.mode);
  });

  // 工具栏图标：在当前风神页面直接切换悬浮面板（不用切标签页）；
  // 指定 mode 时可直接打开对应功能，未指定则沿用上次打开的页签。
  if (HAS_EXT && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "WB_TOGGLE_PANEL") {
        const next = typeof msg.open === "boolean" ? msg.open : !open;
        setOpen(next, PAGES[msg.mode] ? msg.mode : undefined);
        sendResponse({ ok: true, open, mode });
      }
    });
  }
})();
