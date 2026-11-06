/* 风神考核看板 · 常驻悬浮入口（content script）
 * 参考 FengshenMonitor 的交互：在风神页面常驻一颗可拖动的小圆图标，
 * 点击在当前页面直接展开看板浮层，不新开标签页、不打断正在看的页面。
 * 看板本体复用已验证的 dashboard.html（扩展页面 iframe），取数逻辑一行不改。
 */
(function () {
  "use strict";

  if (window.top !== window.self) return;                    // 只在顶层页面注入
  if (document.getElementById("wb-assess-host")) return;    // 防止重复注入

  const HAS_EXT = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
  const PAGE = HAS_EXT ? chrome.runtime.getURL("dashboard.html") : "dashboard.html";
  const POS_KEY = "wb_assess_launcher_pos";
  const SIZE = 56;
  const EDGE = 16;
  const DEFAULT_TOP = 236;   // 避开 FengshenMonitor 那颗默认 top:150px 的悬浮球

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
  .wb-btn {
    height: 30px; padding: 0 11px; border-radius: 6px; border: 1px solid rgba(255,255,255,.32);
    background: rgba(255,255,255,.13); color: #fff; font-size: 12px; cursor: pointer;
    white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
  }
  .wb-btn:hover { background: rgba(255,255,255,.26); }
  .wb-btn.close { border-color: transparent; font-size: 19px; width: 30px; padding: 0; justify-content: center; line-height: 1; }
  .wb-frame { flex: 1; width: 100%; border: 0; background: #fff; display: block; }
  .wb-loading { position: absolute; align-self: center; color: #fff; font-size: 13px; opacity: .85; display: none; }

  @media (max-width: 700px) {
    .wb-mask { align-items: stretch; }
    .wb-panel { width: 100vw; height: 100vh; border-radius: 0; }
    .wb-head .wb-sub { display: none; }
  }
  `;

  const ICON = `<svg class="wb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3v18h18"/><rect x="6.5" y="11" width="3" height="7" fill="currentColor" stroke="none"/>
      <rect x="11.5" y="7" width="3" height="11" fill="currentColor" stroke="none"/>
      <rect x="16.5" y="13" width="3" height="5" fill="currentColor" stroke="none"/>
    </svg>`;

  // ---------------------------------------------------------------- 存储（位置记忆）
  function savePos(p) {
    try {
      if (chrome.storage && chrome.storage.local) { chrome.storage.local.set({ [POS_KEY]: p }); return; }
    } catch (e) { /* 降级到 localStorage */ }
    try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }
  function loadPos(cb) {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(POS_KEY, (o) => cb((o && o[POS_KEY]) || null));
        return;
      }
    } catch (e) { /* 降级 */ }
    let v = null;
    try { v = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch (e) { /* ignore */ }
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
    <div class="wb-launcher" id="wbBall" title="考核看板（点击打开 / 可拖动）">
      ${ICON}<span class="wb-txt">考核</span><span class="wb-dot"></span><span class="wb-upd">NEW</span>
    </div>
    <div class="wb-tip" id="wbTip">考核看板 · 点击打开（可拖动）</div>
    <div class="wb-mask" id="wbMask">
      <div class="wb-panel" id="wbPanel">
        <div class="wb-head">
          <span class="wb-title">指定日考核看板</span>
          <span class="wb-sub" id="wbSub">规划单量完成率 · 标2骑手占比 · 时段达成矩阵</span>
          <span class="wb-spacer"></span>
          <button class="wb-btn" id="wbReload" title="重新拉取数据">↻ 刷新</button>
          <button class="wb-btn" id="wbNewTab" title="在独立标签页打开">↗ 新标签打开</button>
          <button class="wb-btn close" id="wbClose" title="关闭（Esc）">×</button>
        </div>
        <iframe class="wb-frame" id="wbFrame" title="风神考核看板" allowtransparency="false"></iframe>
      </div>
    </div>`;
  if (root === host) {
    // 极老内核无 Shadow DOM：直接挂（样式仍生效）
    while (wrap.firstChild) host.appendChild(wrap.firstChild);
  } else {
    root.appendChild(wrap);
  }
  const q = (id) => root.getElementById ? root.getElementById(id) : document.getElementById(id);
  const ball = q("wbBall"), tip = q("wbTip"), mask = q("wbMask");
  const frame = q("wbFrame"), panel = q("wbPanel");

  // ---------------------------------------------------------------- 自动更新角标
  // 与 service worker 通过 chrome.storage 同步：发现 GitHub 新版本时给悬浮球挂红标，
  // 提示文案同步更新；用户覆盖新版文件后 SW 会自动 reload，红标随之清除。
  function applyUpdateState(s) {
    const on = !!(s && s.available && s.latest !== s.skipped);
    ball.classList.toggle("has-update", on);
    tip.textContent = on
      ? "发现新版本 v" + s.latest + " · 打开看板可一键更新"
      : "考核看板 · 点击打开（可拖动）";
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

  let loaded = false;
  let open = false;

  function showTip(show, x, y) {
    if (show) {
      tip.style.left = Math.max(4, x - 168) + "px";
      tip.style.top = Math.max(4, y - 34) + "px";
      tip.classList.add("show");
    } else tip.classList.remove("show");
  }

  function setOpen(v) {
    open = v;
    mask.classList.toggle("open", v);
    ball.classList.toggle("active", v);
    // 与 FengshenMonitor 一致：面板展开时收起悬浮球，避免遮罩下露出半透明色块
    ball.style.display = v ? "none" : "flex";
    if (v && !loaded) {
      // 懒加载：首次打开才让看板开始拉数；关闭只隐藏，避免每次重开都重跑 1 分钟
      frame.src = PAGE;
      loaded = true;
    }
    if (!v) showTip(false);
  }

  // ---------------------------------------------------------------- 拖动 + 点击
  let drag = null;
  function place(left, top) {
    ball.style.left = left + "px";
    ball.style.top = top + "px";
  }
  loadPos((saved) => {
    const p = fit(saved && isFinite(saved.left) ? saved : { left: window.innerWidth - SIZE - EDGE, top: DEFAULT_TOP });
    place(p.left, p.top);
  });

  ball.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = ball.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    try { ball.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    showTip(false);
  });
  ball.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; ball.classList.add("dragging"); }
    place(clamp(drag.ox + dx, 0, window.innerWidth - SIZE),
          clamp(drag.oy + dy, 0, window.innerHeight - SIZE));
  });
  ball.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    ball.classList.remove("dragging");
    try { ball.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    if (!d.moved) { setOpen(!open); return; }
    // 松手吸附到最近侧边
    const r = ball.getBoundingClientRect();
    const snapLeft = r.left + SIZE / 2 < window.innerWidth / 2
      ? EDGE : window.innerWidth - SIZE - EDGE;
    const p = fit({ left: snapLeft, top: r.top });
    place(p.left, p.top);
    savePos(p);
  });
  ball.addEventListener("pointercancel", () => { drag = null; ball.classList.remove("dragging"); });
  ball.addEventListener("mouseenter", (e) => {
    const r = ball.getBoundingClientRect();
    showTip(true, r.left, r.top);
  });
  ball.addEventListener("mouseleave", () => showTip(false));
  ball.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------------------------------------------------------------- 面板按钮
  q("wbClose").addEventListener("click", () => setOpen(false));
  mask.addEventListener("click", (e) => { if (e.target === mask) setOpen(false); });
  q("wbReload").addEventListener("click", () => { frame.src = PAGE + "?_t=" + Date.now(); });
  q("wbNewTab").addEventListener("click", () => {
    if (HAS_EXT) chrome.runtime.sendMessage({ type: "WB_OPEN_TAB" });
  });

  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) setOpen(false); }, true);
  window.addEventListener("resize", () => {
    const r = ball.getBoundingClientRect();
    const p = fit({ left: r.left, top: r.top });
    place(p.left, p.top);
  });

  // iframe 内按 Esc / 点「新标签打开」时通过 postMessage 通知父页面
  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.__wbAssess !== true) return;
    if (d.type === "CLOSE") setOpen(false);
    if (d.type === "TOGGLE") setOpen(!open);
  });

  // 工具栏图标：在当前风神页面直接切换悬浮面板（不用切标签页）
  if (HAS_EXT && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "WB_TOGGLE_PANEL") {
        const next = typeof msg.open === "boolean" ? msg.open : !open;
        setOpen(next);
        sendResponse({ ok: true, open });
      }
    });
  }
})();
