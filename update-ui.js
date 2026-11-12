/* 风神考核看板 · 更新提示条（扩展页面脚本）
 * 只负责渲染与交互，所有业务逻辑都在 service worker 的 updater.js 里。
 * 非扩展环境（比如单独打开 dashboard.html）直接跳过，不影响原看板。
 *
 * 反馈原则：点「检查更新」后一定要给出明确结论。
 *   「已是最新」必须带上实际命中的版本源与远端版本号，用来证明请求真的打通了；
 *   「检查失败」必须明确说明「无法确认是否有新版」，绝不能让用户误以为是已是最新。
 * 反馈条独立于 update-banner：无新版时横幅是隐藏的，反馈条仍然可见。
 */
(function () {
  "use strict";

  const HAS_EXT = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage;
  if (!HAS_EXT) return;

  const STATE_KEY = "wb_update_state";
  const $ = (id) => document.getElementById(id);
  const banner = $("update-banner");
  const statusBar = $("update-status");
  if (!banner) return;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const timeText = (ts) => {
    if (!ts) return "尚未检查";
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };

  let state = null;
  let forceShow = false;      // 手动点「检查更新」后，即使失败也让更新横幅可见
  let manualStatus = null;    // 手动检查的详细结论（含版本源），优先于「上次检查」简版
  let statusDismissed = false;// 用户主动关闭反馈条后，不再被自动检查重新弹出

  function setHint(text, bad) {
    const el = $("ub-hint");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.classList.toggle("bad", !!bad);
  }

  function showStatus(text, kind) {
    if (!statusBar) return;
    const icon = $("us-icon");
    if (icon) icon.textContent = kind === "bad" ? "✕" : kind === "new" ? "↑" : kind === "info" ? "↻" : "✓";
    const textEl = $("us-text");
    if (textEl) textEl.textContent = text;
    statusBar.classList.toggle("bad", kind === "bad");
    statusBar.classList.toggle("new", kind === "new");
    statusBar.classList.toggle("info", kind === "info");
    statusBar.hidden = false;
  }

  /** 独立于横幅的「检查结果」反馈：无新版 / 有新版 / 失败三态，以及定时检查的静默结论 */
  function renderStatus(s) {
    if (!statusBar || statusDismissed || !s) return;
    const hasNew = s.available && s.latest !== s.skipped;
    if (hasNew) {
      showStatus(`发现新版本 v${s.latest}（当前 v${s.current}），详见上方更新条`, "new");
      return;
    }
    if (s.error) {
      showStatus(`检查更新失败：${s.error} · 无法确认是否有新版本（这不代表已是最新），请检查网络后点「检查更新」重试`, "bad");
      return;
    }
    if (manualStatus) { showStatus(manualStatus.text, manualStatus.kind); return; }
    if (!s.checkedAt) { statusBar.hidden = true; return; }
    showStatus(
      `上次检查 ${timeText(s.checkedAt)}：已是最新版本 v${s.current}` +
      (s.source ? ` · 已连上 GitHub（${s.source}），远端版本 v${s.remoteVersion || s.current}` : ""),
      "ok"
    );
  }

  function render(s) {
    if (s) state = s;
    if (!state) return;

    $("tb-ver").textContent = "v" + (chrome.runtime.getManifest().version || state.current || "");

    const hasNew = state.available && state.latest !== state.skipped;
    const downloaded = hasNew && !!state.downloadedAt;
    const show = hasNew || (!!state.error && forceShow);
    banner.hidden = !show;
    renderStatus(state);
    if (!show) return;

    $("ub-title").textContent = state.error && !hasNew
      ? "检查更新失败"
      : downloaded ? `新版 v${state.latest} 已下载到「下载」目录`
                   : `发现新版本 v${state.latest}`;

    $("ub-meta").textContent = [
      "当前 v" + state.current,
      state.publishedAt ? "发布于 " + state.publishedAt : "",
      "上次检查 " + timeText(state.checkedAt),
      state.source ? "版本源 " + state.source : ""
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
    // v3.20.1：下载完成后直接给一个打开「下载」文件夹的入口
    const folder = $("ub-folder");
    if (folder) folder.hidden = !downloaded;
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
  const btnClose = $("us-close");
  if (btnClose) btnClose.addEventListener("click", () => {
    statusDismissed = true;
    manualStatus = null;
    if (statusBar) statusBar.hidden = true;
  });

  $("btn-update").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    forceShow = true;
    manualStatus = null;
    statusDismissed = false;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "检查中…";
    showStatus("正在连接 GitHub 读取版本文件…", "info");
    try {
      const r = await send({ type: "WB_UPD_CHECK" });
      if (r && r.reloading) {
        manualStatus = { text: "检测到磁盘上的插件文件已是新版，正在自动重载…", kind: "info" };
        showStatus(manualStatus.text, "info");
        return;
      }
      if (!r) {
        showStatus("插件后台没有返回结果，请在 chrome://extensions 里重新加载扩展后重试（这不代表已是最新）。", "bad");
        return;
      }
      if (!r.ok) { render(r.state); return; }        // 失败：明确告知无法确认是否有新版
      if (r.hasNew) { render(r.state); return; }    // 有新版本：横幅 + 「发现新版本」

      const s = r.state || {};
      const cur = s.current || chrome.runtime.getManifest().version || "";
      const src = r.source || s.source || "";
      const remote = r.remoteVersion || s.remoteVersion || cur;
      manualStatus = {
        text: `已是最新版本 v${cur} · 已成功连接 GitHub（${src || "版本源"}），远端版本 v${remote} · ${timeText(Date.now())} 检查`,
        kind: "ok"
      };
      render(s);
    } catch (err) {
      manualStatus = null;
      showStatus("无法连接插件后台，请在 chrome://extensions 里重新加载扩展后重试（这不代表已是最新）。", "bad");
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

  const btnFolder = $("ub-folder");
  if (btnFolder) btnFolder.addEventListener("click", () => {
    send({ type: "WB_UPD_OPEN_FOLDER" }).then((r) => {
      if (r && r.ok === false) setHint("无法自动打开下载文件夹，请手动到系统「下载」目录找 zip。", true);
    }).catch(() => setHint("无法自动打开下载文件夹，请手动到系统「下载」目录找 zip。", true));
  });

  // ---------------------------------------------------------------- 一键热更新
  // 点「热更新」：把扩展内置的 scripts/hot-update.command 下载到「下载」文件夹，
  // 同时把脚本文本显示出来（浏览器拦截可执行下载时可直接复制自建）。双击脚本即自动更新。
  const btnHot = $("btn-hot");
  const hotPanel = $("hot-panel");
  const hpScript = $("hp-script");
  const hpTip = $("hp-tip");
  const hpCopied = $("hp-copied");
  const b64u = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  };
  if (btnHot) btnHot.addEventListener("click", async () => {
    let text = "";
    try {
      const resp = await fetch(chrome.runtime.getURL("scripts/hot-update.command") + "?t=" + Date.now());
      text = await resp.text();
    } catch (e) { text = ""; }
    hpScript.value = text;
    hotPanel.hidden = false;
    if (text) {
      try {
        await chrome.downloads.download({
          url: "data:application/octet-stream;base64," + b64u(text),
          filename: "fengshen-hot-update.command",
          saveAs: false,
          conflictAction: "overwrite"
        });
        hpTip.innerHTML = "脚本已放到「下载」文件夹（<code>fengshen-hot-update.command</code>）。<b>去「下载」里双击它</b>即可自动下载新版、覆盖到插件目录并在 1 分钟内自动重载。若双击后提示选择目录，选中你加载扩展的那个文件夹即可。";
      } catch (e) {
        hpTip.innerHTML = "浏览器拦截了脚本下载（常见于可执行文件）。请直接<b>复制下方文本</b>，粘贴到一个新建文件并命名为 <code>fengshen-hot-update.command</code>，再双击运行即可。";
      }
    } else {
      hpTip.textContent = "未能读取内置脚本，请直接到扩展目录的 scripts/hot-update.command 双击运行，或复制下方文本自建脚本。";
    }
  });
  if ($("hp-close")) $("hp-close").addEventListener("click", () => { hotPanel.hidden = true; });
  if ($("hp-copy")) $("hp-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(hpScript.value);
    } catch (e) {
      hpScript.select();
      if (document.execCommand) document.execCommand("copy");
    }
    hpCopied.hidden = false;
    setTimeout(() => { hpCopied.hidden = true; }, 1500);
  });
})();
