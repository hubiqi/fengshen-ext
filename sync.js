/* 风神考核看板 · 运单增量同步缓存（v3.3.5）
 *
 * 问题：旧版每次刷新都清空内存并从第 1 页重新拉当日全部运单，
 *       几千单要几十页请求 + 页间节流，刷新一次动辄一分钟以上。
 *
 * 时间维度：接口查询条件 trackingFinishStart / trackingFinishEnd 就是
 *   「运单终态时间」（实测：15 分钟窗口返回的单 trackingFinishAt 全在窗口内，
 *    trackingCreatedAt 可以早到几小时前；且接口按终态时间倒序返回）。
 *   运单状态回写 / 改判会改变终态时间，所以增量窗口必须沿终态时间轴推进，
 *   不能用「本地同步完成时刻」当水位——本机时钟与服务端有偏差时会错位漏单。
 *
 * 方案：把「当日已同步的运单」按 trackingId 持久化到 chrome.storage.local，
 *   记录本次所见运单的最大终态时间 finishWatermark 作为水位，
 *   之后只查 [水位 - 回溯窗口, 现在] 这个终态时间窗口，
 *   新单追加、状态变化的单覆盖，历史单直接复用，不再重复请求。
 *
 * 一致性保障（不能只靠水位，否则会漏单 / 漏状态变更）：
 *   1. 常规窗口 15 分钟：覆盖接口入库延迟与状态回写，高峰期也只有 1~2 页；
 *      若对账发现没补齐，自动扩大到 2 小时再试一次，而不是直接退回全量；
 *   2. 每次刷新额外查一次「全日第 1 页」拿 total 做对账锚点，
 *      该页按终态时间倒序，顺带刷新最新 90 单的状态；
 *   3. 扩大窗口后仍「新增行数 ≠ total 增量」，或 total 变小（撤单），
 *      自动降级为全量重拉，绝不会带着残缺数据继续展示；
 *   4. **状态回写不会改变 total，total 对账发现不了**。若改判把终态时间
 *      回退到窗口之外，任何时间窗口都捞不到 → 每 30 分钟自动做一次全量校准；
 *   5. 跨天 / 换合作商 / 缓存结构升级 / 手动点「全量重拉」一律全量重建；
 *   6. 多个看板标签同时刷新时，增量写入会与最新缓存按 ID 合并，互不丢单。
 *
 * 缓存只存在本机浏览器，不上传、不参与任何网络请求。
 */
(function (global) {
  "use strict";

  const SCHEMA = 2;                             // v3.3.5：水位改为终态时间，旧缓存自动失效重建
  const KEY = "wb_orders_current";               // 固定单键：跨天直接覆盖，不会累积历史缓存
  const LOOKBACK_MS = 15 * 60 * 1000;           // 常规增量窗口：终态水位 - 15 分钟
  const RETRY_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 对账没补齐时扩大到 2 小时再试
  const STATE_REFRESH_MS = 30 * 60 * 1000;     // 状态回写校准：每 30 分钟做一次全量
  const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;    // 窗口最多回溯 2 小时，避免水位过旧时拉回大半天

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
   * @param {{date:string, agencyId:string, rows:Array, lastTotal:number, mode:string, finishWatermark:number}} meta
   *        mode = "full" 直接覆盖；"incremental" 与最新缓存按 ID 合并（多标签安全）。
   *        finishWatermark = 本次所见运单的最大「运单终态时间」，作为下次增量窗口的水位。
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
          finishWatermark: Number(meta.finishWatermark || 0) || Date.now(),
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
    const fullAt = Number(c.fullAt || 0);
    // 状态回写不改变 total，total 对账发现不了；改判还可能把终态时间回退到窗口之外。
    // 因此每 30 分钟自动做一次全量校准，把这类单的最新状态刷新回来。
    if (!fullAt || Date.now() - fullAt > STATE_REFRESH_MS) {
      const mins = fullAt ? Math.round((Date.now() - fullAt) / 60000) : 0;
      return {
        mode: "full",
        reason: fullAt ? `状态回写校准：距上次全量 ${mins} 分钟` : "缓存缺少全量校准时间"
      };
    }
    // 水位 = 本次同步所见运单的最大「运单终态时间」，不是本地同步完成的时刻。
    // 限制最多回溯 2 小时：水位异常偏旧时也不会退化成拉回大半天的数据。
    const wm = Number(c.finishWatermark || 0) || Number(c.syncedAt) || Date.now();
    const floor = Math.max(dayStart, Date.now() - MAX_WINDOW_MS);
    const since = Math.max(floor, wm - LOOKBACK_MS);
    const retrySince = Math.max(floor, wm - RETRY_LOOKBACK_MS);
    return {
      mode: "incremental",
      since,
      retrySince,
      watermark: wm,
      rows: c.rows,
      baseCount: c.rows.length,
      lastTotal: Number(c.lastTotal || 0),
      fullAt,
      reason: "命中当日缓存（终态时间水位）"
    };
  }

  global.WB_SYNC = {
    SCHEMA, KEY, LOOKBACK_MS, RETRY_LOOKBACK_MS, STATE_REFRESH_MS, MAX_WINDOW_MS,
    idOf, read, write, plan
  };
})(typeof window !== "undefined" ? window : globalThis);
