/* 物资租用（v3.21.0，第五个独立入口）
 *
 * 复刻原 FengshenMonitor「物资租用登记」：站点 → 物资类型（电动车 / 住宿）→ 骑手 → 开始/结束日期。
 * 数据源（全部沿用原插件接口，不新增后端）：
 *   getTeamsAll                 站点列表
 *   knightRentPizza.queryRentType       物资类型 [{id,name}]
 *   knightRentPizza.queryTeamKnightInfo 站点骑手 [{teamId,knightId,knightName,mobile}]
 *   knightRentPizza.createRent          登记，固定 rentType=2
 *
 * 租用登记与「装备领用」的区别：领用走 rentType=1、只有 startTime、需要 typeId+categoryId；
 * 租用走 rentType=2、有 startTime + endTime、只需要 categoryId。这里只做租用。
 *
 * 提交会真实写入租用单：单条与批量都先二次确认；批量每条间隔 150ms，
 * 成功 / 失败逐条记入本机「最近提交」，方便事后核对。所有取数与提交都走
 * 「直连优先、失败切静默桥接」的既有双通道，不写任何共享缓存。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_TEAMS = XT + "xtop.lpd.intelligentConfig.getTeamsAll/1.0";
const API_TYPES = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryRentType/1.0";
const API_KNIGHTS = XT + "xtop.knight.task.mng.growth.knightRentPizza.queryTeamKnightInfo/1.0";
const API_CREATE = XT + "xtop.knight.task.mng.growth.knightRentPizza.createRent/1.0";

const RENT_TYPE = 2;                 // 2 = 物资租用（1 = 装备领用，本页不用）
const BATCH_GAP_MS = 150;            // 批量提交间隔，与原插件一致
const LS_SITE = "wb_rent_site";
const LS_HISTORY = "wb_rent_history";
const HISTORY_MAX = 100;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateStrOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStrOf(new Date());
const shiftDate = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return dateStrOf(new Date(y, m - 1, d + days));
};
const hhmm = (d) => d.toTimeString().slice(0, 5);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  teams: [], types: [], knights: [],
  siteId: localStorage.getItem(LS_SITE) || "",
  siteName: "",
  selected: new Set(),
  history: [],
  submitting: false,
  loading: false,
  errors: [],
  finishedAt: null
};

function extMsg(msg) {
  try { return chrome.runtime.sendMessage(msg); }
  catch (e) { return Promise.reject(e); }
}

// ---------------------------------------------------------------- 双通道请求
async function bridgeApi(api, payload) {
  const resp = await extMsg({ type: "BRIDGE_API", api, payload });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应");
  return resp.json;
}
/** 直连优先；CORS / 登录态 / 网络失败自动切静默桥接。测试可用 __RENT_MOCK__ 完全接管。 */
async function postApi(api, payload) {
  if (typeof window.__RENT_MOCK__ === "function") return await window.__RENT_MOCK__(api, payload);
  if (state.via === "bridge") return await bridgeApi(api, payload);
  try {
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      credentials: "include",
      referrerPolicy: "unsafe-url",
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return await bridgeApi(api, payload);
  }
}
const okJson = (j) => !!j && String(j.code) === "200" && (!j.result || String(j.result.code) === "200");
const dataOf = (j) => (j && j.result ? (j.result.data == null ? j.result : j.result.data) : null);
const msgOf = (j) => (j && j.result && (j.result.msg || j.result.message)) || (j && j.msg) || "未知错误";

// ---------------------------------------------------------------- 取数
async function loadTeams() {
  const j = await postApi(API_TEAMS, { params: {} });
  if (!okJson(j)) throw new Error("站点列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: String(x.id == null ? x.teamId : x.id),
    name: String(x.team_name || x.teamName || x.name || ("站点 " + (x.id == null ? x.teamId : x.id)))
  })).filter((x) => x.id && x.id !== "undefined" && x.id !== "null");
}
async function loadTypes() {
  const j = await postApi(API_TYPES, { params: {} });
  if (!okJson(j)) throw new Error("物资类型：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.id), name: String(x.name || x.id)
  })).filter((x) => x.id > 0);
}
async function loadKnights(siteId) {
  const j = await postApi(API_KNIGHTS, {
    params: { goodsBusinessRentKnightInfoDto: { teamId: num(siteId) } }
  });
  if (!okJson(j)) throw new Error("骑手列表：" + msgOf(j));
  const arr = dataOf(j) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: num(x.knightId),
    name: String(x.knightName || ""),
    mobile: String(x.mobile || ""),
    teamId: num(x.teamId) || num(siteId)
  })).filter((x) => x.id > 0);
}
/** 站点接口失败时的兜底：复用看板记住的站点 ID，至少还能切换（名称显示为 ID）。 */
function fallbackTeams() {
  try {
    const arr = JSON.parse(localStorage.getItem("wb_team_ids_v1") || "[]");
    return (Array.isArray(arr) ? arr : []).map((id) => ({ id: String(id), name: "站点 " + id }));
  } catch (e) { return []; }
}

// ---------------------------------------------------------------- 渲染
function currentTeam() {
  return state.teams.find((t) => String(t.id) === String(state.siteId)) || null;
}
function currentKnight(id) {
  return state.knights.find((k) => Number(k.id) === Number(id)) || null;
}
function typeName(id) {
  const t = state.types.find((x) => Number(x.id) === Number(id));
  return t ? t.name : String(id || "");
}
function showMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "rent-msg" + (kind ? " " + kind : "");
}
function showNotice(text, kind) {
  const el = $("notice");
  if (!el) return;
  el.textContent = text || "";
  el.className = "notice" + (kind === "bad" ? "" : " blue");
  el.hidden = !text;
}
function renderSites() {
  const sel = $("site-select");
  if (!sel) return;
  if (!state.teams.length) {
    sel.innerHTML = `<option value="">未取到站点</option>`;
    return;
  }
  sel.innerHTML = state.teams.map((t) =>
    `<option value="${esc(t.id)}"${String(t.id) === String(state.siteId) ? " selected" : ""}>${esc(t.name)}</option>`
  ).join("");
}
function renderTypes() {
  const opts = state.types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  for (const id of ["one-type", "batch-type"]) {
    const el = $(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = opts || `<option value="">未取到物资类型</option>`;
    if (prev && state.types.some((t) => String(t.id) === String(prev))) el.value = prev;
  }
}
function knightLabel(k) {
  return k.name + (k.mobile ? " · " + k.mobile : "") + "（" + k.id + "）";
}
function renderKnightSelect() {
  const sel = $("one-knight");
  if (!sel) return;
  const q = String($("one-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  const prev = sel.value;
  sel.innerHTML = `<option value="">请选择骑手（${list.length} 人）</option>` +
    list.map((k) => `<option value="${k.id}">${esc(knightLabel(k))}</option>`).join("");
  if (prev && list.some((k) => String(k.id) === String(prev))) sel.value = prev;
}
function renderBatchList() {
  const box = $("batch-list");
  if (!box) return;
  const q = String($("batch-search").value || "").trim().toLowerCase();
  const list = state.knights.filter((k) => !q
    || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="rent-empty">${state.knights.length ? "没有匹配的骑手" : "当前站点暂无骑手"}</div>`;
    updateBatchCount();
    return;
  }
  box.innerHTML = list.map((k) => {
    const on = state.selected.has(k.id);
    return `<label class="rent-check${on ? " checked" : ""}">` +
      `<input type="checkbox" data-knight-id="${k.id}"${on ? " checked" : ""}>` +
      `<span class="rc-name">${esc(k.name || "未命名")}</span>` +
      `<span class="rc-meta">${esc(k.id)}${k.mobile ? " · " + esc(k.mobile) : ""}</span></label>`;
  }).join("");
  box.querySelectorAll("input[data-knight-id]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = num(inp.dataset.knightId);
      if (inp.checked) state.selected.add(id); else state.selected.delete(id);
      const lab = inp.closest(".rent-check");
      if (lab) lab.classList.toggle("checked", inp.checked);
      updateBatchCount();
    });
  });
  updateBatchCount();
}
function updateBatchCount() {
  const el = $("batch-count");
  if (el) el.textContent = `已选 ${state.selected.size} 人`;
  const btn = $("batch-submit");
  if (btn) btn.disabled = state.submitting || state.selected.size === 0;
}
function renderKpis() {
  const box = $("rent-kpis");
  if (!box) return;
  const ok = state.history.filter((h) => h.ok).length;
  const bad = state.history.length - ok;
  box.innerHTML = [
    ["当前站点", currentTeam() ? currentTeam().name : "—"],
    ["站点数", String(state.teams.length)],
    ["当前站点骑手", String(state.knights.length)],
    ["物资类型", String(state.types.length)],
    ["本机登记成功", String(ok)],
    ["本机登记失败", String(bad)]
  ].map(([k, v]) => `<div class="rent-kpi"><b title="${esc(v)}">${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
}
function renderStatus() {
  const sub = $("sub");
  if (sub) {
    const bits = [];
    if (state.siteName) bits.push("站点 " + state.siteName);
    bits.push("骑手 " + state.knights.length);
    bits.push("物资 " + state.types.length);
    bits.push("更新 " + hhmm(state.finishedAt || new Date()));
    bits.push("通道 " + (state.via === "bridge" ? "静默桥接" : "直连"));
    sub.textContent = bits.join(" · ");
  }
  const ch = $("btn-channel");
  if (ch) ch.textContent = "通道：" + (state.via === "bridge" ? "静默桥接" : "直连");
  const foot = $("foot-meta");
  if (foot) {
    foot.textContent = `数据源：getTeamsAll / queryRentType / queryTeamKnightInfo / createRent（rentType=${RENT_TYPE}）` +
      ` · 生成 ${hhmm(state.finishedAt || new Date())} · 本机记录 ${state.history.length} 条`;
  }
}
function renderHistory() {
  const t = $("history-table");
  if (!t) return;
  const head = `<thead><tr><th style="width:88px">时间</th><th style="width:180px">站点</th>` +
    `<th style="width:150px">骑手</th><th style="width:96px">物资</th><th style="width:60px">数量</th>` +
    `<th style="width:104px">开始</th><th style="width:104px">结束</th><th>结果</th></tr></thead>`;
  const rows = state.history.slice(0, 20);
  const body = rows.length ? rows.map((h) => {
    const d = new Date(h.at);
    const time = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(d)}`;
    return `<tr><td>${esc(time)}</td><td class="name" title="${esc(h.site)}">${esc(h.site)}</td>` +
      `<td class="name" title="${esc(h.knightName)}（${esc(h.knightId)}）">${esc(h.knightName)}</td>` +
      `<td>${esc(h.typeName)}</td><td>${esc(h.num)}</td><td>${esc(h.start)}</td><td>${esc(h.end)}</td>` +
      `<td class="${h.ok ? "ok" : "bad"}" title="${esc(h.msg || "")}">${h.ok ? "成功" : "失败"}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="rent-empty">还没有提交记录</td></tr>`;
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}
function renderAll() {
  renderSites();
  renderTypes();
  renderKnightSelect();
  renderBatchList();
  renderKpis();
  renderStatus();
  renderHistory();
}

// ---------------------------------------------------------------- 业务
function validate(knightId, typeId, n, start, end) {
  if (!knightId) return "请选择骑手";
  if (!typeId) return "请选择物资类型";
  if (!(n >= 1 && n <= 99)) return "数量需在 1 ~ 99 之间";
  if (!start || !end) return "请选择开始 / 结束日期";
  if (start > end) return "开始日期不能晚于结束日期";
  return "";
}
function payloadOf(knightId, typeId, n, start, end) {
  const startTime = new Date(start + "T00:00:00").getTime();
  const endTime = new Date(end + "T23:59:59").getTime();
  return {
    params: {
      goodsBusinessRentCreateDto: {
        teamId: num(state.siteId),
        knightId: num(knightId),
        categoryList: [{ categoryId: num(typeId), startTime, endTime, num: num(n) }],
        rentType: RENT_TYPE
      }
    }
  };
}
function pushHistory(rec) {
  state.history.unshift(rec);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(state.history)); } catch (e) { /* 无痕模式忽略 */ }
  renderHistory();
  renderKpis();
}
async function submitOne() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const knightId = num($("one-knight").value);
  const typeId = num($("one-type").value);
  // 不能用 `|| 1` 兜底：数量填 0 时会被悄悄改成 1，绕过「1~99」校验
  const n = Math.trunc(num($("one-num").value));
  const start = $("one-start").value;
  const end = $("one-end").value;
  const err = validate(knightId, typeId, n, start, end);
  if (err) { showMsg("one-msg", err, "error"); return { ok: false, msg: err }; }
  const k = currentKnight(knightId);
  const knightName = k ? k.name : String(knightId);
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为「${knightName}」登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？\n\n提交会真实写入租用单。`
  )) return { ok: false, canceled: true };
  state.submitting = true;
  $("one-submit").disabled = true;
  showMsg("one-msg", "提交中…", "info");
  let ok = false, msg = "";
  try {
    const j = await postApi(API_CREATE, payloadOf(knightId, typeId, n, start, end));
    ok = okJson(j);
    msg = ok ? "success" : msgOf(j);
  } catch (e) {
    msg = String(e && e.message ? e.message : e);
  }
  state.submitting = false;
  $("one-submit").disabled = false;
  showMsg("one-msg", ok ? `登记成功：${knightName} · ${typeName(typeId)} × ${n}` : `登记失败：${msg}`, ok ? "success" : "error");
  pushHistory({
    at: Date.now(), site: state.siteName || String(state.siteId), knightId, knightName,
    typeName: typeName(typeId), num: n, start, end, ok, msg: ok ? "" : msg
  });
  if (ok) {
    $("one-knight").value = "";
    $("one-num").value = "1";
  }
  return { ok, msg };
}
async function submitBatch() {
  if (state.submitting) return { ok: false, msg: "正在提交中" };
  const ids = [...state.selected];
  if (!ids.length) { showMsg("batch-msg", "请至少选择一位骑手", "error"); return { ok: false }; }
  const typeId = num($("batch-type").value);
  const n = Math.trunc(num($("batch-num").value));
  const start = $("batch-start").value;
  const end = $("batch-end").value;
  const err = validate(ids[0], typeId, n, start, end);
  if (err) { showMsg("batch-msg", err, "error"); return { ok: false, msg: err }; }
  if (!window.__RENT_NO_CONFIRM__ && !confirm(
    `确认为 ${ids.length} 位骑手批量登记 ${typeName(typeId)} × ${n}\n${start} ~ ${end}？\n\n每条间隔 ${BATCH_GAP_MS}ms，提交会真实写入租用单。`
  )) return { ok: false, canceled: true };

  state.submitting = true;
  $("batch-submit").disabled = true;
  const prog = $("batch-progress");
  prog.hidden = false;
  let ok = 0, bad = 0;
  const fails = [];
  for (let i = 0; i < ids.length; i++) {
    const k = currentKnight(ids[i]) || { id: ids[i], name: String(ids[i]) };
    prog.innerHTML = `正在提交 ${i + 1}/${ids.length} · 成功 ${ok} · 失败 ${bad}` +
      `<div class="rp-bar"><i style="width:${Math.round(i / ids.length * 100)}%"></i></div>`;
    let oneOk = false, msg = "";
    try {
      const j = await postApi(API_CREATE, payloadOf(k.id, typeId, n, start, end));
      oneOk = okJson(j);
      msg = oneOk ? "" : msgOf(j);
    } catch (e) {
      msg = String(e && e.message ? e.message : e);
    }
    if (oneOk) ok++; else { bad++; fails.push(`${k.name}（${msg}）`); }
    pushHistory({
      at: Date.now(), site: state.siteName || String(state.siteId), knightId: k.id, knightName: k.name,
      typeName: typeName(typeId), num: n, start, end, ok: oneOk, msg
    });
    if (i < ids.length - 1) await sleep(BATCH_GAP_MS);
  }
  prog.innerHTML = `批量完成：成功 ${ok} 人${bad ? ` · 失败 ${bad} 人` : ""}` +
    (fails.length ? `<div style="color:#B91C1C;margin-top:4px;">${esc(fails.slice(0, 5).join("；"))}${fails.length > 5 ? " …" : ""}</div>` : "") +
    `<div class="rp-bar"><i style="width:100%"></i></div>`;
  showMsg("batch-msg", `批量完成：成功 ${ok} 人${bad ? `，失败 ${bad} 人` : ""}`, bad ? "error" : "success");
  state.submitting = false;
  state.selected.clear();
  renderBatchList();
  updateBatchCount();
  return { ok: bad === 0, success: ok, fail: bad };
}

// ---------------------------------------------------------------- 事件
async function switchSite(siteId) {
  state.siteId = String(siteId || "");
  try { localStorage.setItem(LS_SITE, state.siteId); } catch (e) { /* ignore */ }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.selected.clear();
  state.knights = [];
  renderSites();
  renderBatchList();
  renderKpis();
  renderStatus();
  if (!state.siteId) return;
  try {
    state.knights = await loadKnights(state.siteId);
    state.errors = [];
  } catch (e) {
    showNotice("骑手列表加载失败：" + String(e && e.message ? e.message : e), "bad");
  }
  renderAll();
}
async function loadAll() {
  state.loading = true;
  state.errors = [];
  try {
    const [teams, types] = await Promise.all([loadTeams(), loadTypes()]);
    state.teams = teams;
    state.types = types;
  } catch (e) {
    state.errors.push(String(e && e.message ? e.message : e));
    if (!state.teams.length) state.teams = fallbackTeams();
    showNotice("站点 / 物资类型加载失败：" + state.errors[0] + "（可点「立即刷新」重试，或切到静默桥接）", "bad");
  }
  if (!state.siteId || !state.teams.some((t) => String(t.id) === String(state.siteId))) {
    state.siteId = state.teams[0] ? String(state.teams[0].id) : "";
  }
  const t = currentTeam();
  state.siteName = t ? t.name : state.siteId;
  state.finishedAt = new Date();
  state.loading = false;
  renderAll();
  if (state.siteId) await switchSite(state.siteId);
}

function bind() {
  $("site-select").addEventListener("change", (e) => switchSite(e.target.value));
  $("btn-refresh").addEventListener("click", () => loadAll());
  $("btn-channel").addEventListener("click", async () => {
    state.via = state.via === "direct" ? "bridge" : "direct";
    try { localStorage.setItem("wb_via", state.via); } catch (e) { /* ignore */ }
    renderStatus();
    showNotice(state.via === "bridge"
      ? "已切到「静默桥接」：后台标签页取数，不打断浏览。"
      : "已切回「直连」：由插件页面直接请求接口。", state.via === "bridge" ? "blue" : "bad");
    await loadAll();
  });
  $("btn-clean").addEventListener("click", () => {
    const on = document.body.classList.toggle("clean");
    $("btn-clean").textContent = on ? "退出纯净" : "纯净看板";
  });
  $("btn-goto-assess").addEventListener("click", () => {
    if (window.parent !== window) {
      window.parent.postMessage({ __wbAssess: true, type: "SWITCH", mode: "assess" }, "*");
    } else {
      extMsg({ type: "WB_OPEN_TAB", page: "assess" }).catch(() => {});
    }
  });
  $("one-search").addEventListener("input", renderKnightSelect);
  $("one-submit").addEventListener("click", () => submitOne());
  $("batch-search").addEventListener("input", renderBatchList);
  $("batch-select-all").addEventListener("click", () => {
    const q = String($("batch-search").value || "").trim().toLowerCase();
    for (const k of state.knights) {
      if (!q || k.name.toLowerCase().includes(q) || k.mobile.includes(q) || String(k.id).includes(q)) {
        state.selected.add(k.id);
      }
    }
    renderBatchList();
  });
  $("batch-clear").addEventListener("click", () => {
    state.selected.clear();
    renderBatchList();
  });
  $("batch-submit").addEventListener("click", () => submitBatch());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { const n = $("notice"); if (n) n.hidden = true; }
  });
}

// ---------------------------------------------------------------- 测试挂钩
window.__SET_RENT__ = (o) => {
  o = o || {};
  if (Array.isArray(o.teams)) state.teams = o.teams.map((t) => ({ id: String(t.id), name: String(t.name || t.team_name || t.id) }));
  if (Array.isArray(o.types)) state.types = o.types.map((t) => ({ id: num(t.id), name: String(t.name || t.id) }));
  if (Array.isArray(o.knights)) state.knights = o.knights.map((k) => ({
    id: num(k.id == null ? k.knightId : k.id), name: String(k.name || k.knightName || ""),
    mobile: String(k.mobile || ""), teamId: num(k.teamId)
  }));
  if (o.siteId != null) state.siteId = String(o.siteId);
  if (Array.isArray(o.history)) state.history = o.history;
  const t = state.teams.find((x) => String(x.id) === String(state.siteId));
  state.siteName = t ? t.name : String(state.siteId || "");
  state.finishedAt = new Date();
  renderAll();
};
window.__RENT__ = {
  state, postApi, loadAll, loadTeams, loadTypes, loadKnights, switchSite,
  submitOne, submitBatch, validate, payloadOf, renderAll, renderHistory,
  API_TEAMS, API_TYPES, API_KNIGHTS, API_CREATE, RENT_TYPE, BATCH_GAP_MS, HISTORY_MAX
};

(async function init() {
  bind();
  const today = todayStr();
  for (const [id, val] of [["one-start", today], ["one-end", shiftDate(today, 30)],
    ["batch-start", today], ["batch-end", shiftDate(today, 30)]]) {
    const el = $(id);
    if (el) el.value = val;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
    if (Array.isArray(raw)) state.history = raw.slice(0, HISTORY_MAX);
  } catch (e) { state.history = []; }
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  renderAll();
  if (state.via === "bridge") showNotice("当前使用「静默桥接」通道：后台标签页取数，不会打断浏览。", "blue");
  if (!window.__WB_TEST__) await loadAll();
})();
