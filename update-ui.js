/* 风神考核看板 · 更新提示条（扩展页面脚本）
 * 只负责渲染与交互，所有业务逻辑都在 service worker 的 updater.js 里。
 * 非扩展环境（比如单独打开 dashboard.html）直接跳过，不影响原看板。
 */
(function () {
  "use strict";

  const HAS_EXT = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage;
  if (!HAS_EXT) return;

  const STATE_KEY = "wb_update_state";
  const $ = (id) => document.getElementById(id);
  const banner = $("update-banner");
  if (!banner) return;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const timeText = (ts) => {
    if (!ts) return "尚未检查";
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };

  let state = null;
  let forceShow = false;   // 手动点「检查更新」后，即使失败也让提示条可见

  function setHint(text, bad) {
    const el = $("ub-hint");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.classList.toggle("bad", !!bad);
  }

  function render(s) {
    if (s) state = s;
    if (!state) return;

    $("tb-ver").textContent = "v" + (chrome.runtime.getManifest().version || state.current || "");

    const hasNew = state.available && state.latest !== state.skipped;
    const downloaded = hasNew && !!state.downloadedAt;
    const show = hasNew || (!!state.error && forceShow);
    banner.hidden = !show;
    if (!show) return;

    $("ub-title").textContent = state.error && !hasNew
      ? "检查更新失败"
      : downloaded ? `新版 v${state.latest} 已下载到「下载」目录`
                   : `发现新版本 v${state.latest}`;

    $("ub-meta").textContent = [
      "当前 v" + state.current,
      state.publishedAt ? "发布于 " + state.publishedAt : "",
      "上次检查 " + timeText(state.checkedAt)
    ].filter(Boolean).join(" · ");

    $("ub-notes").textContent = state.error && !hasNew
      ? "无法连接 GitHub：" + state.error + "（可稍后重试，不影响看板取数）"
      : downloaded
        ? "把 zip 解压后的文件覆盖到插件目录（含 version.json）。插件会在 1 分钟内自动检测并重载，也可点右侧「立即生效」。"
        : (state.notes || "修复问题与功能改进，建议更新。");

    const btnDl = $("ub-download");
    btnDl.disabled = !!state.downloading;
    btnDl.textContent = state.downloading ? "下载中…" : downloaded ? "重新下载" : "下载新版 zip";

    const btnApply = $("ub-apply");
    btnApply.classList.toggle("primary", downloaded);
    btnApply.disabled = !downloaded;

    $("ub-skip").hidden = !hasNew;
    $("ub-ext").hidden = !downloaded;
  }

  // ---------------------------------------------------------------- 初始与同步
  send({ type: "WB_UPD_STATE" })
    .then((r) => render(r && r.state))
    .catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "WB_UPDATE_CHANGED") render(msg.state);
  });
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STATE_KEY]) render(changes[STATE_KEY].newValue);
    });
  }

  // ---------------------------------------------------------------- 交互
  $("btn-update").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    forceShow = true;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "检查中…";
    try {
      const r = await send({ type: "WB_UPD_CHECK" });
      if (r && r.reloading) { setHint("检测到磁盘已是新版，正在自动重载…"); return; }
      render(r && r.state);
      if (r && !r.ok) setHint("检查失败，请确认网络可访问 raw.githubusercontent.com 后重试。", true);
      else setHint(r && r.hasNew ? "发现新版本。" : "已是最新版本。");
    } catch (err) {
      setHint("无法连接插件后台，请重新加载扩展后重试。", true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $("ub-download").addEventListener("click", async () => {
    try {
      const r = await send({ type: "WB_UPD_DOWNLOAD" });
      if (!r || !r.ok) { setHint("下载失败：" + ((r && r.error) || "未知错误"), true); return; }
      setHint("已开始下载 " + r.filename + "，完成后这里会提示如何覆盖。");
    } catch (err) {
      setHint("下载失败，请稍后重试或直接到 GitHub Releases 页面下载。", true);
    }
  });

  $("ub-apply").addEventListener("click", async () => {
    try {
      const r = await send({ type: "WB_UPD_APPLY" });
      if (r && r.updated) { setHint("检测到新版文件，正在自动重载…"); return; }
      setHint("插件目录里还没检测到新版文件。请确认 zip 已解压并覆盖到插件目录（version.json 也要一起覆盖）。", true);
    } catch (err) {
      setHint("检测失败，请在 chrome://extensions 里点「重新加载」。", true);
    }
  });

  $("ub-skip").addEventListener("click", async () => {
    const r = await send({ type: "WB_UPD_SKIP" });
    render(r && r.state);
  });

  $("ub-ext").addEventListener("click", () => send({ type: "WB_UPD_OPEN_EXTENSIONS" }).catch(() => {}));
})();
