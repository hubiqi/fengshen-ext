/* 风神考核看板 · 一键复制图片（v3.4.0）
 *
 * 目标：把 #sheet（1:1 复刻钉钉考核看板 PNG 的主画面）渲染成一张高清 PNG，
 *       写入系统剪贴板，方便直接 Ctrl/⌘+V 粘贴到钉钉 / 微信；不支持时自动降级为下载 PNG。
 *
 * 实现方式：SVG foreignObject 内嵌 XHTML + 内联样式 → Image → Canvas → PNG Blob。
 *   - 纯本地、零依赖、零网络请求，不引入 html2canvas 之类的第三方库；
 *   - 默认按 1240px 逻辑宽度、2 倍像素密度导出，不受当前窗口宽窄影响；
 *     v3.14.0 起画布宽度自适应：若 #sheet 里的内容（如炸班明细的「T+1排班」列）
 *     实际比基准宽，就把画布放宽到内容宽，绝不裁掉右侧列；
 *   - 剥离响应式 @media 规则并显式还原桌面版字号，避免窄屏窗口导出「手机排版」；
 *   - 不含工具条、更新提示、播报区与底部元信息，只截看板画面本身。
 */
(function (global) {
  "use strict";

  const BASE_WIDTH = 1240;           // 基准逻辑宽度，与 dashboard.css 中 .sheet 一致
  let WIDTH = BASE_WIDTH;            // 本次出图的实际宽度，toBlob 时按内容重算（只放宽）
  const SCALE = 2;                    // 2 倍图，粘贴到钉钉仍然清晰
  // 与 dashboard.css 的 html/body 字体栈保持一致，保证导出图与屏幕上的字形一致。
  // SVG foreignObject 内不会命中 html/body 选择器，所以这里必须显式写在根节点上。
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif";

  // @media 规则在「测量 DOM 高度」时会按当前窗口宽度生效，导出的图会跟着变形。
  // 因此导出时统一覆盖回桌面版（>=1260px）的取值，保证任何窗口宽度下出图一致。
  const DESKTOP_OVERRIDES = [
    [".sheet", "padding-left:0;padding-right:0;"],
    [".tbl-scroll", "margin:0;padding:0;"],
    [".scroll-hint", "display:none;"],
    [".mt-note", "display:inline;margin-top:0;font-size:20px;font-weight:700;color:#1F2937;"],
    [".doc-title", "font-size:30px;"],
    [".doc-sub", "font-size:16px;"],
    [".doc-note", "font-size:15px;"],
    [".doc-foot", "font-size:13px;"],
    [".doc-foot.small", "font-size:12px;"],
    // v3.28.0：实时出勤监控。这些必须写成内联样式——量高度时用的是页面里的克隆节点，
    // 只写进导出 SVG 的样式表不会影响高度测量，max-height:460px 会把明细表后面的内容挤掉。
    [".rt-table-wrap", "overflow:visible;max-height:none;height:auto;"],
    ["table.tbl.rt-area-table thead th,table.tbl.rt-detail-table thead th", "position:static;top:auto;"],
    [".rt-exp", "display:none;"],
    [".rt-timer", "display:none;"]
  ];

  /** 画布宽度自适应：默认 1240；#sheet 里有内容比它更宽时放宽，避免右侧列被裁掉。
   *  只放宽不缩窄，常规画面仍导出原来的 2480px 宽 PNG，老习惯不变。 */
  function measureWidth(src) {
    let w = 0;
    // v3.15.0：运力模块 17 列天然比 1240 宽，measureWidth 也要量它，否则导出图右侧被裁
    const sels = "table.tbl.fr,.fail-roster,table.tbl.att,.fr-note,.att-note,.att-kpi," +
      "table.tbl.wf,.wf-summary,.wf-note,table.tbl.sch,.sch-summary,.sch-note," +
      "table.tbl.rt-area-table,table.tbl.rt-detail-table";
    for (const el of Array.from(src.querySelectorAll(sels) || [])) {
      if (el.closest && el.closest("[hidden]")) continue;
      try { if (global.getComputedStyle(el).display === "none") continue; } catch (e) { /* ignore */ }
      const r = el.getBoundingClientRect();
      w = Math.max(w, r.width || 0, el.scrollWidth || 0);
    }
    // 没超过基准就保持原来的 1240（导出图仍是 2480px 宽，老习惯不变）；
    // 只有内容确实更宽才放宽，并留 24px 白边，避免表格边框贴着画布边缘。
    if (w <= BASE_WIDTH) return BASE_WIDTH;
    return Math.min(Math.ceil(w) + 24, 3200);
  }

  /** 收集当前页面的 CSS 文本；跳过媒体查询（导出固定按桌面宽度），并补上强制布局。 */
  function collectCss(rootId) {
    const rules = [];
    for (const sheet of Array.from(document.styleSheets || [])) {
      let list;
      try { list = sheet.cssRules; } catch (e) { continue; }   // 跨域样式表不可读则跳过
      for (const r of Array.from(list || [])) {
        if (r.type === 4) continue;                             // CSSRule.MEDIA_RULE
        rules.push(r.cssText);
      }
    }
    rules.push(`.sheet { width:${WIDTH}px !important;max-width:none !important;margin:0 !important; }`);
    // v3.28.0：根节点不一定叫 .sheet（实时出勤用的是 #rt-wrap），统一按 id 锁宽度
    if (rootId && rootId !== "sheet") {
      rules.push(`#${rootId} { width:${WIDTH}px !important;max-width:none !important;margin:0 !important; }`);
    }
    rules.push(`.tbl-scroll { overflow:visible !important;width:${WIDTH}px !important; }`);
    // v3.18.0：运力模块屏幕上有「表头 + 左侧列」冻结，导出图必须还原成一张完整表格，
    // 否则 sticky 会让表头悬浮、max-height 会把滚动区以外的内容挤掉。
    rules.push(`.tbl-scroll { max-height:none !important;height:auto !important; }`);
    rules.push(`table.tbl.wf thead th,table.tbl.wf tbody td` +
      ` { position:static !important;top:auto !important;left:auto !important;box-shadow:none !important; }`);
    // 排序箭头 / 筛选漏斗只是屏幕上的交互标记，不该出现在发给钉钉的图里
    rules.push(`table.tbl.wf thead th::after { content:none !important;display:none !important; }`);
    rules.push(`table.tbl.wf thead th button.wf-th-filter { display:none !important; }`);
    // v3.19.1 起不再隐藏滚动列，无需再做 visibility 还原
    rules.push(`.wf-pop { display:none !important; }`);
    // v3.19.0：排班模块的「时段权重配置」弹窗也不能混进导出图
    rules.push(`.sch-weight-overlay { display:none !important; }`);
    // v3.28.0：实时出勤监控的表格外面包着 max-height:460px 的滚动区，导出必须放开，
    // 否则只截到一屏；表头 sticky 也要还原成静态行，展开箭头是屏幕上的交互标记，不导出。
    rules.push(`.rt-table-wrap { overflow:visible !important;max-height:none !important;height:auto !important; }`);
    rules.push(`table.tbl.rt-area-table thead th,table.tbl.rt-detail-table thead th` +
      ` { position:static !important;top:auto !important; }`);
    rules.push(`.rt-exp,.rt-timer,.rt-pop { display:none !important; }`);
    if (WIDTH > BASE_WIDTH) {
      // 画布加宽时，标题 / 说明等原本锁 1218px 的块跟着铺满，固定宽的达成矩阵居中
      rules.push(`.att-kpi,.att-note,.att-switch,.att-block-title,.fr-head,.fr-title,.fr-note,` +
        `.wf-summary,.wf-note,.sch-summary,.sch-note,.doc-title,.doc-sub,.doc-note,.doc-foot` +
        ` { width:${WIDTH}px !important;max-width:none !important; }`);
      rules.push(`table.tbl.att,table.tbl.wf,table.tbl.sch { margin-left:auto !important;margin-right:auto !important; }`);
    }
    return rules.join("\n");
  }

  const escXml = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /**
   * 把看板主画面渲染为 PNG Blob。返回 {blob,width,height}（width/height 为实际像素）。
   * rootId 默认 "sheet"；v3.6.0 起「出勤达成」是独立页面，可传自己的根节点 id，
   * 两个入口各自导出自己的画面，互不混入。
   * v3.30.0：opts.title 存在时，在克隆画面最前面插一段标题区（主标题 + 可选副标题），
   * 只出现在导出图里、用内联样式，不影响页面本身；插入后再量高度，保证不被裁掉。
   */
  async function toBlob(rootId, opts) {
    const o = opts || {};
    const src = document.getElementById(rootId || "sheet");
    if (!src) throw new Error("未找到看板画面（#" + (rootId || "sheet") + "）");
    WIDTH = measureWidth(src);

    const holder = document.createElement("div");
    holder.style.cssText =
      `position:fixed;left:-100000px;top:0;width:${WIDTH}px;background:#FFFFFF;pointer-events:none;`;
    const clone = src.cloneNode(true);
    // 独立入口（出勤达成 / 实时出勤）的根节点自带 1240px 外框，导出时左右留 20px 白边，
    // 用 border-box 保证内容区仍是 WIDTH，量高度与出图完全一致。
    const padX = rootId && rootId !== "sheet" ? 20 : 0;
    clone.setAttribute("style",
      `width:${WIDTH}px;max-width:none;margin:0;padding:28px ${padX}px 36px;` +
      `${padX ? "box-sizing:border-box;" : ""}` +
      `background:#FFFFFF;color:#1F2937;font-family:${FONT};`);
    for (const [sel, css] of DESKTOP_OVERRIDES) {
      for (const n of Array.from(clone.querySelectorAll(sel))) n.style.cssText += css;
    }
    if (o.title) {
      const box = document.createElement("div");
      box.setAttribute("style",
        `width:100%;box-sizing:border-box;text-align:center;margin:0 0 16px;padding:0 0 10px;` +
        `border-bottom:2px solid #2F5597;font-family:${FONT};`);
      const h = document.createElement("div");
      h.textContent = String(o.title);
      h.setAttribute("style", "font-size:28px;line-height:1.35;font-weight:700;color:#1F2937;letter-spacing:.5px;");
      box.appendChild(h);
      if (o.subtitle) {
        const sub = document.createElement("div");
        sub.textContent = String(o.subtitle);
        sub.setAttribute("style", "font-size:12.5px;line-height:1.5;color:#6B7280;margin-top:4px;font-weight:400;");
        box.appendChild(sub);
      }
      clone.insertBefore(box, clone.firstChild);
    }
    holder.appendChild(clone);
    document.body.appendChild(holder);

    let height, xhtml;
    try {
      height = Math.ceil(clone.getBoundingClientRect().height) + 4;
      xhtml = new XMLSerializer().serializeToString(clone);
    } finally {
      document.body.removeChild(holder);
    }
    if (!height || height < 100) throw new Error("看板画面高度异常，可能尚未渲染完成");

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
      `viewBox="0 0 ${WIDTH} ${height}">` +
      `<foreignObject x="0" y="0" width="${WIDTH}" height="${height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${WIDTH}px;height:${height}px;` +
      `margin:0;padding:0;background:#FFFFFF;color:#1F2937;font-family:${FONT};">` +
      `<style>${escXml(collectCss(rootId || "sheet"))}</style>${xhtml}</div></foreignObject></svg>`;

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("图片渲染失败（SVG 生成异常）"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建绘图上下文");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.drawImage(img, 0, 0, WIDTH, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG 编码失败")), "image/png");
    });
    return { blob, width: canvas.width, height: canvas.height };
  }

  /**
   * 写图片到系统剪贴板。返回是否成功（失败时调用方降级为下载）。
   * 可传 Blob 或 Promise<Blob>：Promise 形式让 clipboard.write() 在点击任务内同步发起，
   * 后续图片渲染再慢也不会丢掉 transient user activation（Chrome 对写剪贴板的硬性要求）。
   */
  async function writeClipboard(blobOrPromise) {
    const nav = global.navigator;
    if (!nav || !nav.clipboard || typeof global.ClipboardItem === "undefined") return false;
    try {
      const item = new global.ClipboardItem({ "image/png": blobOrPromise });
      await nav.clipboard.write([item]);
      return true;
    } catch (e) {
      // 少数内核不接受 Promise 形式（或首次写失败）：拿到实体 Blob 再试一次
      try {
        const blob = await blobOrPromise;
        await nav.clipboard.write([new global.ClipboardItem({ "image/png": blob })]);
        return true;
      } catch (e2) { return false; }
    }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "风神考核看板.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /**
   * 一键复制入口。
   * @param {{download?:boolean, date?:string, rootId?:string, filename?:string,
   *          title?:string, subtitle?:string}} opts
   *        download=true 时直接另存为 PNG；rootId/filename 供独立页面指定自己的画面与文件名；
   *        title/subtitle 给导出图加标题区（不写就没有，老入口行为不变）
   * @returns {Promise<{mode:"clipboard"|"download"|"fallback", width:number, height:number}>}
   */
  async function capture(opts) {
    const o = opts || {};
    const rendering = toBlob(o.rootId, o);        // 立即开工，不先 await
    const name = o.filename || `风神考核看板_${o.date || today()}.png`;
    if (o.download) {
      const { blob, width, height } = await rendering;
      download(blob, name);
      return { mode: "download", width, height };
    }
    // 剪贴板写入在用户点击的任务里同步发起；生成 PNG 的 Promise 稍后再 resolve
    const copied = await writeClipboard(rendering.then((r) => r.blob));
    const { blob, width, height } = await rendering;
    if (copied) return { mode: "clipboard", width, height };
    download(blob, name);                       // 剪贴板不可用时自动降级为下载 PNG
    return { mode: "fallback", width, height };
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  global.WB_CAPTURE = {
    BASE_WIDTH, SCALE,
    get WIDTH() { return WIDTH; },   // 本次出图实际采用的逻辑宽度（自适应后）
    toBlob, writeClipboard, download, capture
  };
})(typeof window !== "undefined" ? window : globalThis);
