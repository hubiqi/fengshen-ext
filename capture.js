/* 风神考核看板 · 一键复制图片（v3.4.0）
 *
 * 目标：把 #sheet（1:1 复刻钉钉考核看板 PNG 的主画面）渲染成一张高清 PNG，
 *       写入系统剪贴板，方便直接 Ctrl/⌘+V 粘贴到钉钉 / 微信；不支持时自动降级为下载 PNG。
 *
 * 实现方式：SVG foreignObject 内嵌 XHTML + 内联样式 → Image → Canvas → PNG Blob。
 *   - 纯本地、零依赖、零网络请求，不引入 html2canvas 之类的第三方库；
 *   - 固定按 1240px 逻辑宽度、2 倍像素密度导出，不受当前窗口宽窄影响；
 *   - 剥离响应式 @media 规则并显式还原桌面版字号，避免窄屏窗口导出「手机排版」；
 *   - 不含工具条、更新提示、播报区与底部元信息，只截看板画面本身。
 */
(function (global) {
  "use strict";

  const WIDTH = 1240;                 // 与 dashboard.css 中 .sheet 的逻辑宽度一致
  const SCALE = 2;                    // 2 倍图，粘贴到钉钉仍然清晰
  const FONT = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Heiti SC',sans-serif";

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
    [".doc-foot.small", "font-size:12px;"]
  ];

  /** 收集当前页面的 CSS 文本；跳过媒体查询（导出固定按桌面宽度），并补上强制布局。 */
  function collectCss() {
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
    rules.push(`.tbl-scroll { overflow:visible !important;width:${WIDTH}px !important; }`);
    return rules.join("\n");
  }

  const escXml = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** 把看板主画面渲染为 PNG Blob。返回 {blob,width,height}（width/height 为实际像素）。 */
  async function toBlob() {
    const src = document.getElementById("sheet");
    if (!src) throw new Error("未找到看板画面（#sheet）");

    const holder = document.createElement("div");
    holder.style.cssText =
      `position:fixed;left:-100000px;top:0;width:${WIDTH}px;background:#FFFFFF;pointer-events:none;`;
    const clone = src.cloneNode(true);
    clone.setAttribute("style",
      `width:${WIDTH}px;max-width:none;margin:0;padding:28px 0 36px;` +
      `background:#FFFFFF;color:#1F2937;font-family:${FONT};`);
    for (const [sel, css] of DESKTOP_OVERRIDES) {
      for (const n of Array.from(clone.querySelectorAll(sel))) n.style.cssText += css;
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
      `<style>${escXml(collectCss())}</style>${xhtml}</div></foreignObject></svg>`;

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
   * @param {{download?:boolean, date?:string}} opts download=true 时直接另存为 PNG
   * @returns {Promise<{mode:"clipboard"|"download"|"fallback", width:number, height:number}>}
   */
  async function capture(opts) {
    const o = opts || {};
    const rendering = toBlob();                  // 立即开工，不先 await
    const name = `风神考核看板_${o.date || today()}.png`;
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

  global.WB_CAPTURE = { WIDTH, SCALE, toBlob, writeClipboard, download, capture };
})(typeof window !== "undefined" ? window : globalThis);
