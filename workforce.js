/* 运力模块（独立页面 v3.15.0）
 * ---------------------------------------------------------------------------
 * 三个数据源，按「骑手 id」合并成一行一条账单的 17 列明细表：
 *   1) 骑手账单管家 → 账单查询（targetId=58484 / salary-bill-ub）
 *      POST xtop.lpd.price.mng.zsSalaryBillQueryFs.pageQuerySalaryBill/1.0
 *      → 账单ID / 站点 / 骑手 / 基础薪资方案 / 排班内外单量 / 一口价单量明细
 *        （取分离 / 送分离）/ 账单总金额(income) / 预支(prepaymentBonus)
 *        / 住宿费用(accommodationFee) + 车辆租金(vehicleRental)
 *   2) 人资综合服务 → 成员管理 · 全部（targetId=61068 / staffManagement）
 *      GET app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list（不带 workStatus = 全部状态）
 *      → 是否在职(workStatus) / 入职时间(entryTime) / 离职时间(leaveTime)
 *   3) 招募缺口管理 → 线索结果明细（targetId=61364 / tab=station）
 *      POST xtop.knight.task.mng.growth.knightRecruitResultRead.queryAgencyKnightRecruitResult/1.0
 *      → 是否三方人资（命中带 headHunterCompanyName 的线索）
 *
 * 与另两个页面一样：直连优先、失败自动切「静默桥接」；跟随当前登录态，不依赖本地服务。
 * 三个源并行取数、任一失败不影响其余两源，缺失字段显示「—」。
 */

const XT = "https://httpizza.ele.me/xtop/";
const API_BILL = XT + "xtop.lpd.price.mng.zsSalaryBillQueryFs.pageQuerySalaryBill/1.0";
const API_CLUE = XT + "xtop.knight.task.mng.growth.knightRecruitResultRead.queryAgencyKnightRecruitResult/1.0";
const API_STAFF = "https://app2-edu.ele.me/kunkka-svr/ehr/staff/knight/list";
const PAGE_SIZE = 500;
const MONTHS_BACK = 11;          // 当前月 + 往前 11 个月 = 最近 12 个月
const MAX_PAGES = 20;
const SRC_LABEL = { bill: "薪资账单", staff: "人资名单", clue: "线索结果明细" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => String(Math.round(num(v)));
const money = (v) => "¥" + num(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (v) => (v == null || String(v).trim() === "" ? "—" : String(v));
const shortTime = (v) => {
  const s = String(v == null ? "" : v).trim();
  return s ? s.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}).*$/, "$1 $2") : "—";
};
const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const curMonth = () => monthStr(new Date());
const shiftMonth = (m, delta) => {
  const [y, mm] = String(m).split("-").map(Number);
  return monthStr(new Date(y, mm - 1 + delta, 1));
};
const validMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ""));

// 17 列：表头 / 字段 / 单元格 class。CSV 用 *Text 后缀的纯文本值，不带 ¥ 和 HTML。
const COLS = [
  ["账单ID", "billId", "c-bill"],
  ["站点id", "teamId", "c-id"],
  ["站点", "team", "c-site"],
  ["骑手id", "riderId", "c-id"],
  ["骑手姓名", "riderName", "c-name"],
  ["基础薪资方案名称", "scheme", "c-scheme"],
  ["排班内单量", "inOrdersText", "num"],
  ["排班外单量", "outOrdersText", "num"],
  ["取分离单量", "takeSepText", "num"],
  ["送分离", "giveSepText", "num"],
  ["账单总金额", "totalText", "num c-total"],
  ["预支", "prepayText", "num c-prepay"],
  ["绑定扣款（住宿费用+车辆租金）", "bindText", "num c-bind"],
  ["是否在职", "onJobHtml", ""],
  ["入职时间", "entry", "c-ts"],
  ["离职时间", "leave", "c-ts"],
  ["是否三方人资", "thirdHtml", ""]
];

const state = {
  via: localStorage.getItem("wb_via") || "direct",
  month: validMonth(localStorage.getItem("wb_wf_month")) ? localStorage.getItem("wb_wf_month") : curMonth(),
  query: "", site: "", third: "",
  loading: false, gen: 0,
  bills: [], staff: new Map(), clues: new Map(),
  errors: {}, rows: [], loadedAt: null
};

// ---------------------------------------------------------------- 请求通道
function extMsg(msg) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || {}));
        return;
      }
    } catch (e) { /* 测试环境无扩展运行时 */ }
    resolve({});
  });
}
function checkJson(j, label) {
  if (!j || typeof j !== "object") throw new Error(label + " 未返回 JSON");
  const r = j.result;
  if (r && (r.success === false || String(r.code) === "500")) {
    throw new Error(label + "：" + (r.message || r.msg || "业务失败"));
  }
  if (j.err_code && String(j.err_code) !== "200" && String(j.code) !== "200") {
    throw new Error(label + "：" + (j.msg || "接口拒绝"));
  }
  return j;
}
async function direct(url, method, payload) {
  const opt = { method, credentials: "include", referrerPolicy: "unsafe-url" };
  if (method === "POST") {
    opt.headers = { "Content-Type": "text/plain;charset=UTF-8" };
    opt.body = JSON.stringify(payload || {});
  }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return checkJson(await r.json(), url.split("/").pop().split("/")[0]);
}
async function bridge(url, method, payload) {
  const msg = method === "GET"
    ? { type: "BRIDGE_GET", url }
    : { type: "BRIDGE_API", api: url, payload: payload || {} };
  const resp = await extMsg(msg);
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "静默桥接通道无响应（可能尚未登录风神）");
  return checkJson(resp.json, "静默桥接");
}
async function request(url, method, payload) {
  if (state.via === "direct") {
    try { return await direct(url, method, payload); }
    catch (e) {
      state.via = "bridge";       // 只在本页切换，不改写全局通道偏好
      showNotice("直连未成功（" + (e.message || "未知原因") + "），已自动切到「静默桥接」后台标签取数。", "blue");
    }
  }
  return await bridge(url, method, payload);
}

// ---------------------------------------------------------------- 分页取数
async function loadBills(month) {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(API_BILL, "POST", {
      params: { request: { bizType: 3, billCycle: month, teamIds: null, settleStatusList: [], pageNum: p, pageSize: PAGE_SIZE } }
    });
    const r = j.result || {};
    const rows = Array.isArray(r.data) ? r.data : [];
    out.push(...rows);
    const total = num(r.total);
    if (!rows.length || rows.length < PAGE_SIZE || (total && out.length >= total)) break;
  }
  return out;
}
async function loadStaff() {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(`${API_STAFF}?pageIndex=${p}&pageSize=${PAGE_SIZE}`, "GET", null);
    const d = j.data || {};
    const list = Array.isArray(d.list) ? d.list : [];
    out.push(...list);
    const count = num(d.count);
    if (!list.length || list.length < PAGE_SIZE || (count && out.length >= count)) break;
  }
  return out;
}
async function loadClues() {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await request(API_CLUE, "POST", {
      params: { knightRecruitResultRequest: { pageNum: p, pageSize: PAGE_SIZE } }
    });
    const d = (j.result && j.result.data) || {};
    const list = Array.isArray(d.data) ? d.data : [];
    out.push(...list);
    const count = num(d.count);
    if (!list.length || list.length < PAGE_SIZE || (count && out.length >= count)) break;
  }
  return out;
}

// ---------------------------------------------------------------- 合并口径
function staffMap(list) {
  const m = new Map();
  for (const s of list || []) {
    const rid = String(s.knightId == null ? s.id : s.knightId).trim();
    if (!rid || rid === "0") continue;
    const prev = m.get(rid);
    if (!prev) { m.set(rid, s); continue; }
    // 同一个人有多条记录时优先在职，其次取更晚的入职时间
    const a = num(s.workStatus) === 1 ? 1 : 0, b = num(prev.workStatus) === 1 ? 1 : 0;
    if (a > b || (a === b && String(s.entryTime || "") > String(prev.entryTime || ""))) m.set(rid, s);
  }
  return m;
}
function clueMap(list) {
  const m = new Map();
  for (const c of list || []) {
    const rid = String(c.knightId == null ? "" : c.knightId).trim();
    const hh = String(c.headHunterCompanyName == null ? "" : c.headHunterCompanyName).trim();
    if (!rid || rid === "0" || !hh) continue;
    if (!m.has(rid)) m.set(rid, hh);
  }
  return m;
}
function splitSep(list) {
  let take = 0, give = 0;
  for (const x of list || []) {
    const desc = String(x && x.priceTypeDesc != null ? x.priceTypeDesc : "");
    const n = num(x && x.orderCount);
    if (/取分离/.test(desc)) take += n;
    else if (/送分离/.test(desc)) give += n;
  }
  return { take, give };
}
function buildRows(bills, staff, clues) {
  return (bills || []).map((b) => {
    const riderId = String(b.knightId == null ? "" : b.knightId).trim();
    const st = staff.get(riderId);
    const hh = clues.get(riderId);
    const sep = splitSep(b.specialOrderCountDetailList);
    const workStatus = st ? num(st.workStatus) : null;
    const onJob = workStatus === 1 ? "是" : (workStatus === 2 ? "否" : "—");
    const bind = num(b.accommodationFee) + num(b.vehicleRental);
    const bindTip = `住宿费用 ${money(b.accommodationFee)} ＋ 车辆租金 ${money(b.vehicleRental)}`;
    return {
      billId: String(b.settleNum || ""), teamId: String(b.teamId || ""),
      team: String(b.teamName || ""), riderId, riderName: String(b.knightName || ""),
      scheme: String(b.baseRuleName || ""),
      inOrders: num(b.scheduleOrderCount), outOrders: num(b.noScheduleOrderCount),
      takeSep: sep.take, giveSep: sep.give,
      total: num(b.income), prepay: num(b.prepaymentBonus), bind,
      onJob, entry: shortTime(st && st.entryTime), leave: shortTime(st && st.leaveTime),
      thirdYes: !!hh, thirdName: hh || "",
      // 展示用
      inOrdersText: int(b.scheduleOrderCount), outOrdersText: int(b.noScheduleOrderCount),
      takeSepText: int(sep.take), giveSepText: int(sep.give),
      totalText: money(b.income), prepayText: money(b.prepaymentBonus), bindText: money(bind),
      onJobHtml: onJob === "是" ? '<i class="mk yes">是</i>'
        : onJob === "否" ? '<i class="mk no">否</i>' : '<i class="mk na">—</i>',
      thirdHtml: hh
        ? `<i class="mk third" title="${esc(hh)}">是</i>`
        : '<i class="mk na">否</i>',
      bindTip, staffFound: !!st
    };
  });
}

// ---------------------------------------------------------------- 筛选 / 排序
function visibleRows() {
  const q = state.query.trim().toLowerCase();
  const rows = state.rows.filter((r) => {
    if (state.site && r.team !== state.site) return false;
    if (state.third === "yes" && !r.thirdYes) return false;
    if (state.third === "no" && r.thirdYes) return false;
    if (q && ![r.billId, r.team, r.teamId, r.riderId, r.riderName, r.scheme]
      .some((v) => String(v).toLowerCase().includes(q))) return false;
    return true;
  });
  return rows.sort((a, b) =>
    a.team.localeCompare(b.team, "zh") || a.riderName.localeCompare(b.riderName, "zh") || a.billId.localeCompare(b.billId));
}

// ---------------------------------------------------------------- 渲染
function renderSummary(rows) {
  const riders = new Set(rows.map((r) => r.riderId).filter(Boolean));
  const on = rows.filter((r) => r.onJob === "是").length;
  const off = rows.filter((r) => r.onJob === "否").length;
  const third = rows.filter((r) => r.thirdYes).length;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const prepay = rows.reduce((a, r) => a + r.prepay, 0);
  const bind = rows.reduce((a, r) => a + r.bind, 0);
  const cards = [
    ["账单数", int(rows.length), ""],
    ["去重骑手", int(riders.size), ""],
    ["在职 / 离职", `${int(on)} / ${int(off)}`, ""],
    ["三方人资", int(third), "third"],
    ["账单总金额", money(total), "money"],
    ["预支合计", money(prepay), "money"],
    ["绑定扣款合计", money(bind), "money"]
  ];
  $("wf-summary").innerHTML = cards.map(([k, v, cls]) =>
    `<div class="wf-card ${cls}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");
  const miss = state.rows.filter((r) => !r.staffFound).length;
  const errs = Object.entries(state.errors).filter(([, v]) => v);
  const bits = [`共 <b>${int(state.rows.length)}</b> 条账单，当前筛选显示 <b>${int(rows.length)}</b> 条`];
  if (miss) bits.push(`<b>${int(miss)}</b> 条账单没在人资名单里匹配到（在职 / 入职 / 离职显示「—」）`);
  if (errs.length) bits.push(`<b>${errs.length}</b> 个数据源未取到：${esc(errs.map(([k]) => SRC_LABEL[k] || k).join("、"))}`);
  $("wf-note").innerHTML = bits.join("　·　");
}

function renderTable(rows) {
  const t = $("wf-table");
  const head = "<thead><tr>" + COLS.map(([h]) => `<th>${esc(h)}</th>`).join("") + "</tr></thead>";
  const body = ["<tbody>"];
  if (!rows.length) {
    body.push(`<tr class="wf-empty"><td colspan="${COLS.length}">没有符合条件的账单${state.rows.length ? "（试试清空搜索或筛选）" : "（可切换月份或点「立即刷新」）"}</td></tr>`);
  }
  for (const r of rows) {
    body.push("<tr>" + COLS.map(([, key, cls], i) => {
      const raw = r[key] == null ? "" : r[key];
      const isHtml = key === "onJobHtml" || key === "thirdHtml";
      const txt = isHtml ? raw : esc(raw);
      const title = key === "bindText" ? ` title="${esc(r.bindTip)}"`
        : key === "thirdHtml" && r.thirdName ? ` title="${esc(r.thirdName)}"` : "";
      const na = !isHtml && (raw === "—" || raw === "") ? " c-empty" : "";
      return `<td class="${cls}${na}"${title}>${txt}</td>`;
    }).join("") + "</tr>");
  }
  body.push("</tbody>");
  t.innerHTML = head + body.join("");
}

function renderSiteOptions() {
  const sel = $("wf-site");
  const keep = sel.value;
  const sites = [...new Set(state.rows.map((r) => r.team).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh"));
  sel.innerHTML = '<option value="">全部站点</option>' +
    sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (sites.includes(keep)) sel.value = keep; else { sel.value = ""; state.site = ""; }
}

function renderMeta() {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  $("doc-sub").innerHTML = `账单月份 ${esc(state.month)}&nbsp;&nbsp;&nbsp;&nbsp;生成时间 ${esc(d.toLocaleDateString("zh-CN"))} ${hhmm}`;
  $("sub").textContent = `账单 ${state.bills.length} 条 · 人资 ${state.staff.size} 人 · 线索 ${state.clues.size} 人`;
  const parts = [
    `数据源：账单查询 ${state.month}（${state.bills.length} 条）`,
    `成员管理·全部（${state.staff.size} 人）`,
    `线索结果明细（${state.clues.size} 人带三方人资公司）`,
    state.loadedAt ? `取数完成 ${state.loadedAt}` : ""
  ].filter(Boolean);
  $("foot-meta").textContent = parts.join("　·　") + "　·　跟随当前浏览器登录态，换账号自动换商";
  $("doc-foot-small").textContent =
    "「是否三方人资」按线索结果明细是否命中带猎头（人资）公司的记录判定；人资名单取全部状态（含离职）；绑定扣款 = 住宿费用 + 车辆租金；金额单位人民币元。";
}

function applyData() {
  state.rows = buildRows(state.bills, state.staff, state.clues);
  renderSiteOptions();
  const rows = visibleRows();
  renderSummary(rows);
  renderTable(rows);
  renderMeta();
}

// ---------------------------------------------------------------- 进度 / 提示
function setProgress(pct, text) {
  $("bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("progress-text").textContent = text;
  $("progress-wrap").hidden = pct >= 100;
}
function showNotice(msg, kind) {
  const n = $("notice");
  n.className = "notice" + (kind ? " " + kind : "");
  n.textContent = msg;
  n.hidden = false;
}
function clearNotice() { $("notice").hidden = true; }

// ---------------------------------------------------------------- 主流程
async function loadAll() {
  if (state.loading) return;
  // 测试模式：只按注入的样本重画，不触发任何网络请求（切月也一样）
  if (window.__WB_TEST__) { applyData(); setProgress(100, ""); return; }
  const gen = ++state.gen;
  state.loading = true;
  clearNotice();
  setProgress(8, `正在取 ${state.month} 的三份数据…`);
  $("btn-refresh").disabled = true;
  const label = SRC_LABEL;
  let done = 0;
  const tick = (name) => {
    done++;
    setProgress(8 + done * 28, `已取到${label[name]}，继续…`);
    return gen === state.gen;
  };
  const one = async (name, fn) => {
    try {
      const v = await fn();
      state.errors[name] = "";
      return { name, ok: true, v };
    } catch (e) {
      return { name, ok: false, err: String((e && e.message) || e) };
    }
  };
  const [b, s, c] = await Promise.all([
    one("bill", () => loadBills(state.month)),
    one("staff", () => loadStaff()),
    one("clue", () => loadClues())
  ]);
  if (gen !== state.gen) { state.loading = false; return; }
  for (const r of [b, s, c]) {
    if (r.ok) { tick(r.name); state.errors[r.name] = ""; }
    else state.errors[r.name] = r.err;
  }
  if (b.ok) state.bills = b.v; else if (!state.bills.length) state.bills = [];
  if (s.ok) state.staff = staffMap(s.v);
  if (c.ok) state.clues = clueMap(c.v);
  state.loadedAt = new Date().toTimeString().slice(0, 5);
  applyData();
  const fails = Object.entries(state.errors).filter(([, v]) => v);
  setProgress(100, "");
  if (fails.length) {
    showNotice("部分数据源未取到：" + fails.map(([k, v]) => `${label[k]}（${v}）`).join("；") +
      "。已用其余数据出表，可点「立即刷新」重试。");
  } else if (!state.bills.length) {
    showNotice(`${state.month} 没有查到账单，可切换月份再试。`, "blue");
  }
  state.loading = false;
  $("btn-refresh").disabled = false;
}

function setMonth(m) {
  if (!validMonth(m)) return;
  const min = shiftMonth(curMonth(), -MONTHS_BACK), max = curMonth();
  if (m < min || m > max) return;
  state.month = m;
  localStorage.setItem("wb_wf_month", m);
  $("month-picker").value = m;
  $("btn-prev-month").disabled = m <= min;
  $("btn-next-month").disabled = m >= max;
  loadAll();
}

// ---------------------------------------------------------------- 导出
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const rows = visibleRows();
  // CSV 里金额 / 单量用原始数值，不带 ¥ 和千分位，Excel 才能直接求和
  const keys = ["billId", "teamId", "team", "riderId", "riderName", "scheme",
    "inOrders", "outOrders", "takeSep", "giveSep",
    "total", "prepay", "bind", "onJob", "entry", "leave"];
  const head = COLS.map(([h]) => h);
  const line = (r) => keys.map((k) => csvCell(r[k])).concat(csvCell(r.thirdYes ? "是" : "否")).join(",");
  const text = [head.map(csvCell).join(","), ...rows.map(line)].join("\r\n");
  const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `风神运力模块_${state.month.replace("-", "")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`已导出 ${rows.length} 条账单为 CSV（Excel 可直接打开）。`, "blue");
}

// ---------------------------------------------------------------- 事件
$("btn-prev-month").addEventListener("click", () => setMonth(shiftMonth(state.month, -1)));
$("btn-next-month").addEventListener("click", () => setMonth(shiftMonth(state.month, 1)));
$("btn-this-month").addEventListener("click", () => setMonth(curMonth()));
$("month-picker").addEventListener("change", (e) => setMonth(e.target.value));
$("btn-refresh").addEventListener("click", () => loadAll());
$("wf-search").addEventListener("input", (e) => { state.query = e.target.value; applyData(); });
$("wf-site").addEventListener("change", (e) => { state.site = e.target.value; applyData(); });
$("wf-third").addEventListener("change", (e) => { state.third = e.target.value; applyData(); });
$("btn-export-csv").addEventListener("click", exportCsv);
$("btn-copy-image").addEventListener("click", async (e) => {
  const btn = $("btn-copy-image");
  if (btn.disabled) return;
  if (!window.WB_CAPTURE) { showNotice("图片模块未加载：请重新加载扩展或安装新版 zip。"); return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "正在生成图片…";
  try {
    const ym = state.month.replace("-", "");
    const r = await WB_CAPTURE.capture({
      download: e.shiftKey, date: ym, rootId: "sheet",
      filename: `风神运力模块_${ym}.png`
    });
    const size = `${r.width}×${r.height}`;
    showNotice(r.mode === "clipboard"
      ? `已复制运力模块图片（${size} PNG），可直接 Ctrl/⌘+V 粘贴到钉钉 / 微信。`
      : `运力模块图片已另存为 PNG 文件（${size}）。`, "blue");
  } catch (err) {
    showNotice(`生成图片失败：${String((err && err.message) || err)}。可先点「纯净看板」，再用系统截图工具替代。`);
  } finally { btn.disabled = false; btn.textContent = label; }
});
$("btn-clean").addEventListener("click", () => {
  const on = document.body.classList.toggle("clean");
  $("btn-clean").textContent = on ? "退出纯净看板" : "纯净看板";
  if (!on) return;
  const b = document.createElement("button");
  b.id = "btn-clean-float"; b.className = "ghost"; b.textContent = "退出纯净看板";
  b.style.cssText = "position:fixed;right:16px;top:12px;z-index:99;opacity:.35";
  b.onmouseenter = () => { b.style.opacity = "1"; };
  b.onmouseleave = () => { b.style.opacity = ".35"; };
  b.onclick = () => { document.body.classList.remove("clean"); b.remove(); $("btn-clean").textContent = "纯净看板"; };
  document.body.appendChild(b);
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearNotice(); });

// ---------------------------------------------------------------- 测试钩子
// 注入三份样本数据后直接出表，不触发任何网络请求；CDP 回归用。
window.__SET_WORKFORCE__ = (obj) => {
  state.errors = obj.errors || {};
  if (Array.isArray(obj.bills)) state.bills = obj.bills;
  if (Array.isArray(obj.staff)) state.staff = staffMap(obj.staff);
  else if (obj.staff instanceof Map) state.staff = obj.staff;
  if (Array.isArray(obj.clues)) state.clues = clueMap(obj.clues);
  else if (obj.clues instanceof Map) state.clues = obj.clues;
  if (obj.month && validMonth(obj.month)) { state.month = obj.month; $("month-picker").value = obj.month; }
  state.loadedAt = new Date().toTimeString().slice(0, 5);
  applyData();
  setProgress(100, "");
  return state.rows.length;
};
window.__WF__ = { state, COLS, buildRows, visibleRows, splitSep, staffMap, clueMap, money };

// ---------------------------------------------------------------- 初始化
(async function init() {
  $("month-picker").value = state.month;
  $("month-picker").min = shiftMonth(curMonth(), -MONTHS_BACK);
  $("month-picker").max = curMonth();
  $("btn-prev-month").disabled = state.month <= shiftMonth(curMonth(), -MONTHS_BACK);
  $("btn-next-month").disabled = state.month >= curMonth();
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    if (m && m.version) $("tb-ver").textContent = "v" + m.version;
  } catch (e) { /* ignore */ }
  try { await extMsg({ type: "ENSURE_RULES" }); } catch (e) { /* ignore */ }
  if (window.__WB_TEST__) { applyData(); setProgress(100, ""); return; }
  loadAll();
})();
