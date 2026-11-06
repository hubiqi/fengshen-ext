/* 风神考核看板 · 运单增量同步缓存（v3.3.0）
 *
 * 问题：旧版每次刷新都清空内存并从第 1 页重新拉当日全部运单，
 *       几千单要几十页请求 + 页间节流，刷新一次动辄一分钟以上。
 *
 * 方案：把「当日已同步的运单」按 trackingId 持久化到 chrome.storage.local，
 *       之后刷新只查 [上次同步时刻 - 回溯窗口, 现在] 这个时间窗口，
 *       新单追加、状态变化的单覆盖，历史单直接复用，不再重复请求。
 *
 * 一致性保障（不能只靠水位，否则会漏单 / 漏状态变更）：
 *   1. 常规窗口 15 分钟：覆盖接口入库延迟与状态回写，高峰期也只有 1~2 页；
 *      若对账发现没补齐，自动扩大到 2 小时再试一次，而不是直接退回全量；
 *   2. 每次刷新额外查一次「全日第 1 页」拿 total 做对账锚点，
 *      同时把最新一页的状态刷新进缓存；
 *   3. 扩大窗口后仍「新增行数 ≠ total 增量」，或 total 变小（撤单），
 *      自动降级为全量重拉，绝不会带着残缺数据继续展示；
 *   4. 跨天 / 换合作商 / 缓存结构升级 / 手动点「全量重拉」一律全量重建；
 *   5. 多个看板标签同时刷新时，增量写入会与最新缓存按 ID 合并，互不丢单。
 *
 * 缓存只存在本机浏览器，不上传、不参与任何网络请求。
 */
(function (global) {
  "use strict";

  const SCHEMA = 1;
  const KEY = "wb_orders_current";               // 固定单键：跨天直接覆盖，不会累积历史缓存
  const LOOKBACK_MS = 15 * 60 * 1000;           // 常规增量窗口：上次同步 - 15 分钟
  const RETRY_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 对账没补齐时扩大到 2 小时再试

  const idOf = (r) => String((r && (r.trackingId || r.platformTrackingId)) || "");

  function store() {
    try {
      const s = global.chrome && global.chrome.storage;
      return s && s.local ? s.local : null;
    } catch (e) { return null; }
  }

  /** 读缓存。返回 {ok, cache} 或 {ok:false, reason}；任何异常都退化为「需要全量」。 */
  async function read(date, agencyId) {
    const s = store();
    if (!s) return { ok: false, reason: "浏览器存储不可用" };
    let box;
    try { box = await s.get(KEY); } catch (e) { return { ok: false, reason: "缓存读取失败：" + e.message }; }
    const c = box && box[KEY];
    if (!c || c.schema !== SCHEMA || c.date !== date || !Array.isArray(c.rows) || !c.rows.length) {
      return { ok: false, reason: "首次加载 / 跨天 / 缓存结构升级" };
    }
    if (agencyId && c.agencyId && String(c.agencyId) !== String(agencyId)) {
      return { ok: false, reason: "检测到合作商切换" };
    }
    if (!Number(c.syncedAt)) return { ok: false, reason: "缓存缺少同步水位" };
    return { ok: true, cache: c };
  }

  /**
   * 写缓存。
   * @param {{date:string, agencyId:string, rows:Array, lastTotal:number, mode:string}} meta
   *        mode = "full" 直接覆盖；"incremental" 与最新缓存按 ID 合并（多标签安全）。
   * @returns {Promise<boolean>} 是否写入成功（配额不足等失败时调用方退化为每次全量）
   */
  async function write(meta) {
    const s = store();
    if (!s) return false;
    try {
      const box = await s.get(KEY);
      const cur = box && box[KEY];
      const sameDay = cur && cur.schema === SCHEMA && cur.date === meta.date &&
                      String(cur.agencyId || "") === String(meta.agencyId || "");
      let rows = meta.rows;
      if (meta.mode !== "full" && sameDay && Array.isArray(cur.rows)) {
        // 别的标签可能已经写进了本次没见过的单；增量模式从不删单，合并即可
        const have = new Set(meta.rows.map(idOf));
        rows = meta.rows.concat(cur.rows.filter((r) => !have.has(idOf(r))));
      }
      await s.set({
        [KEY]: {
          schema: SCHEMA,
          date: meta.date,
          agencyId: String(meta.agencyId || ""),
          rows,
          lastTotal: Number(meta.lastTotal || 0),
          syncedAt: Date.now(),
          fullAt: meta.mode === "full" ? Date.now() : Number((sameDay && cur.fullAt) || 0)
        }
      });
      return true;
    } catch (e) { return false; }
  }

  /**
   * 生成本次同步策略。
   * @param {object} res read() 的返回值
   * @param {number} dayStart 当日 00:00 的时间戳
   * @param {boolean} forceFull 用户点了「全量重拉」
   */
  function plan(res, dayStart, forceFull) {
    if (forceFull) return { mode: "full", reason: "手动全量重拉" };
    if (!res || !res.ok) return { mode: "full", reason: (res && res.reason) || "无可用缓存" };
    const c = res.cache;
    const since = Math.max(dayStart, Number(c.syncedAt) - LOOKBACK_MS);
    const retrySince = Math.max(dayStart, Number(c.syncedAt) - RETRY_LOOKBACK_MS);
    return {
      mode: "incremental",
      since,
      retrySince,
      rows: c.rows,
      baseCount: c.rows.length,
      lastTotal: Number(c.lastTotal || 0),
      fullAt: Number(c.fullAt || 0),
      reason: "命中当日缓存"
    };
  }

  global.WB_SYNC = { SCHEMA, KEY, LOOKBACK_MS, RETRY_LOOKBACK_MS, idOf, read, write, plan };
})(typeof window !== "undefined" ? window : globalThis);
