// 考核计算：与 fengshen-data/assess_image.py 逐行对齐（规划单量完成率 + 标2骑手占比）
// 通用化策略：站点→商圈片映射为「可选表」。命中则用钉钉同一套片区名（数据完全一致）；
// 未命中（换商登录）则回退到接口原生 merchantBusDistrictName，其余口径全部一致。
/* global ASSESS */

const ASSESS = (() => {
  // ---- 时段字典：与 config.py 的 PERIOD_STANDARDS（KPI PDF 第 9-10 页，11 时段全集）逐行对齐 ----
  // 排班统计表只给「班次名」、不给时间区间，所以「时间戳 → 班次」的映射必须靠这份字典；
  // 但「当天到底有哪些班次」以排班表为准：实测 10-31 只有 7 个工作班次，11-05/11-06 多出
  // 「凌晨1」「早餐1」变成 9 个。硬编码列会丢掉这些班次及其预估单量，因此改为排班驱动。
  const PERIOD_DEFS = [
    { name: "凌晨1",   start: 0,            end: 2 * 60 },
    { name: "凌晨2",   start: 2 * 60,       end: 4 * 60 },
    { name: "凌晨3",   start: 4 * 60,       end: 6 * 60 },
    { name: "早餐1",   start: 6 * 60,       end: 8 * 60 },
    { name: "早餐2",   start: 8 * 60,       end: 10 * 60 + 30 },
    { name: "午高峰",  start: 10 * 60 + 30, end: 13 * 60 + 30 },
    { name: "下午茶1", start: 13 * 60 + 30, end: 15 * 60 + 30 },
    { name: "下午茶2", start: 15 * 60 + 30, end: 17 * 60 + 30 },
    { name: "晚高峰",  start: 17 * 60 + 30, end: 20 * 60 },
    { name: "夜宵1",   start: 20 * 60,      end: 22 * 60 },
    { name: "夜宵2",   start: 22 * 60,      end: 24 * 60 }
  ];
  const PERIOD_BY_NAME = new Map(PERIOD_DEFS.map((p) => [p.name, p]));
  // 排班取不到 / 当天排班没有可识别班次时的兜底：与旧版一致的 7 个工作时段
  const DEFAULT_PERIOD_NAMES = ["早餐2", "午高峰", "下午茶1", "下午茶2", "晚高峰", "夜宵1", "夜宵2"];
  const PERIOD_NAMES = DEFAULT_PERIOD_NAMES.slice();   // 兼容既有调用方

  // 可选映射：仅用于把接口站点名还原成钉钉看板的「商圈片」分组，不命中不影响通用性
  const SITE_TO_AREA = {
    "福州仓山区城门站-UB": "福州仓山区城门商圈片",
    "福州台江区宝龙站-UB": "福州台江区台江商圈片",
    "福州台江区万象购物中心站-UB": "福州台江区台江商圈片",
    "福州台江区河下站-UB": "福州台江区台江商圈片",
    "福州鼓楼区杨桥站-UB": "福州台江区台江商圈片",
    "福州鼓楼区福新路站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州鼓楼区五四站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州鼓楼区温泉公园站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州台江区茶亭站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州鼓楼区西湖站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州鼓楼区鼓楼站-UB": "福州鼓楼区茶亭西湖商圈片",
    "福州福清市宏路站-UB": "福州福清市万达宏路商圈片",
    "福州福清市凤凰站-UB": "福州福清市老城商圈片",
    "福州福清市福清万达站-UB": "福州福清市万达宏路商圈片",
    "福州仓山区万达站-UB": "福州仓山区仓山商圈片",
    "福州仓山区南国金辉站-UB": "福州仓山区仓山商圈片",
    "福州仓山区爱琴海站-UB": "福州仓山区仓山商圈片",
    "福州晋安区福新中路站-UB": "福州晋安区商圈片"
  };
  const AREA_ORDER = [
    "福州仓山区城门商圈片", "福州台江区台江商圈片", "福州鼓楼区茶亭西湖商圈片",
    "福州福清市老城商圈片", "福州福清市万达宏路商圈片",
    "福州仓山区仓山商圈片", "福州晋安区商圈片"
  ];

  const ONLINE_MIN_HOURS = 6.0;

  // ---- 计分（assess_image.score_complete / score_biao2）----
  function scoreComplete(rate) {
    if (rate >= 105) return 100.0;
    if (rate >= 100) return 90.0 + (rate - 100) / 5.0 * 10.0;
    if (rate >= 90) return 60.0 + (rate - 90) / 10.0 * 30.0;
    return 0.0;
  }
  function scoreBiao2(p) {
    if (p >= 90) return 100.0;
    if (p >= 80) return 80.0 + (p - 80) / 10.0 * 10.0;
    if (p >= 70) return (p - 70) / 10.0 * 80.0;
    return 0.0;
  }
  const isUB = (site) => String(site).trim().endsWith("-UB");

  function parseDur(s) {
    if (!s) return 0.0;
    const t = String(s).trim();
    const h = /(\d+)\s*小时/.exec(t);
    const m = /(\d+)\s*分钟/.exec(t);
    return (h ? Number(h[1]) : 0) + (m ? Number(m[1]) : 0) / 60.0;
  }

  /** 按「当天实际排班的班次」把完单时间归类；落在未排班时段返回 null（仍计入实际完单，只是不进矩阵）。 */
  function periodOf(ts, periods) {
    if (!ts || !isFinite(Number(ts))) return null;
    const d = new Date(Number(ts));
    const t = d.getHours() * 60 + d.getMinutes();
    for (const name of periods || DEFAULT_PERIOD_NAMES) {
      const p = PERIOD_BY_NAME.get(name);
      if (p && t >= p.start && t < p.end) return name;
    }
    return null;
  }

  const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
  const key = (s) => String(s ?? "").trim();

  /**
   * @param orders   queryTracking 明细数组（全量分页结果）
   * @param schSheets 排班 xlsx 的 sheets
   * @param attSheets 考勤 xlsx 的 sheets
   * @param dateStr  'YYYY-MM-DD'
   * @param XLSX     XLSX_READER
   */
  function build(orders, schSheets, attSheets, dateStr, XLSX) {
    // 站点名 -> 接口原生商圈名（给排班表做映射兜底）
    const teamToDistrict = new Map();
    for (const r of orders) {
      const t = key(r.teamName), d = key(r.merchantBusDistrictName);
      if (t && d && !teamToDistrict.has(t)) teamToDistrict.set(t, d);
    }
    let mappedCnt = 0, fallbackCnt = 0;
    const areaOfSite = (site) => {
      const s = key(site);
      if (SITE_TO_AREA[s]) { mappedCnt++; return SITE_TO_AREA[s]; }
      fallbackCnt++;
      return teamToDistrict.get(s) || s || "未识别";
    };

    // ---------------- 排班：先确定「当天有哪些班次」，再累加规划单量 ----------------
    // 顺序很关键：时段矩阵列、运单时间归类、时段预估单量必须共用同一份 periods，
    // 而这份列表只能来自排班统计表（不同日期 / 合作商的班次数并不相同）。
    const areaSet = new Set();   // 排班有量但当日无完单的片区也要出现在看板上
    const plan = new Map(), headcount = new Map(), periodPlan = new Map();
    const bump = (map, k, field, v) => {
      if (!map.has(k)) map.set(k, {});
      const o = map.get(k);
      o[field] = (o[field] || 0) + v;
    };
    let scheduleOk = false;
    const sch = XLSX.pickSheet(schSheets || [], ["团队名称", "日期", "时段", "预估单量", "应排人数"]);
    const scheduledSet = new Set(), unknownPeriods = new Set();
    if (sch) {
      scheduleOk = true;
      const c = sch.col;
      // 第 1 遍：只读当天排班出现过的班次名（排除「全天」「休息」等非班次行）
      for (const r of sch.rows) {
        if (String(r[c["日期"]] || "").slice(0, 10) !== dateStr) continue;
        const per = key(r[c["时段"]]);
        if (!per || per === "全天" || per === "休息") continue;
        if (PERIOD_BY_NAME.has(per)) scheduledSet.add(per);
        else unknownPeriods.add(per);   // 字典不认识 → 无法做时间归类，底部提示人工核对
      }
    }
    const periods = scheduledSet.size
      ? PERIOD_DEFS.filter((p) => scheduledSet.has(p.name)).map((p) => p.name)  // 按时间先后排序
      : DEFAULT_PERIOD_NAMES.slice();
    const periodSource = scheduledSet.size ? "schedule" : "default";
    const periodSet = new Set(periods);
    if (sch) {
      const c = sch.col;
      // 第 2 遍：按已确定的班次累加规划单量 / 应排人数 / 时段预估单量
      for (const r of sch.rows) {
        if (String(r[c["日期"]] || "").slice(0, 10) !== dateStr) continue;
        const per = key(r[c["时段"]]);
        const site = key(r[c["团队名称"]]);
        const area = areaOfSite(site);
        areaSet.add(area);
        if (per === "全天") {
          bump(headcount, area, "v", num(r[c["应排人数"]]));
        } else if (per === "休息" || per === "") {
          continue;
        } else {
          bump(plan, area, "v", num(r[c["预估单量"]]));
          if (periodSet.has(per)) bump(periodPlan, area, per, num(r[c["预估单量"]]));
        }
      }
    }

    // ---------------- 考勤：骑手 -> 最大全天有效在线时长 ----------------
    const att = new Map();
    let attendanceOk = false;
    const ats = XLSX.pickSheet(attSheets || [], ["骑手id", "全天有效在线时长"]);
    if (ats) {
      attendanceOk = true;
      const c = ats.col;
      for (const r of ats.rows) {
        const rid = key(r[c["骑手id"]]);
        if (!rid) continue;
        const d = parseDur(r[c["全天有效在线时长"]]);
        if (!att.has(rid) || d > att.get(rid)) att.set(rid, d);
      }
    }

    // ---------------- 运单：实际完单 / 时段完单 / 骑手完单 ----------------
    // 口径（与 assess_image.py / 系统一致）：只有「配送成功」计入实际完单。
    // 接口实测：state=40 / stateDesc=配送成功；state=90 / stateDesc=配送失败。
    // 接口 total 是「全部运单」，含配送失败，所以进度条里的「拉取 N 单」必然大于完单数，
    // 两者必须分开标注，否则看起来就像把失败单算进了完单。
    // 判定顺序：先排除任何明确的失败/取消状态，再认成功；状态缺失或不明一律不计入，
    // 避免「state=40 但描述是失败」或将来新增状态被误算成完单。
    const FAIL_WORDS = ["失败", "取消", "关闭", "退款", "拒收", "退回", "未妥投", "异常"];
    const SUCCESS_WORDS = ["配送成功", "配送完成", "已妥投"];
    const classify = (r) => {
      const desc = String(r.stateDesc || r.statusDesc || "").trim();
      const st = Number(r.state);
      if (desc && FAIL_WORDS.some((w) => desc.includes(w))) return "failed";
      if (st === 90) return "failed";
      if (desc && SUCCESS_WORDS.some((w) => desc.includes(w))) return "success";
      if (!desc && st === 40) return "success";       // 兼容没有描述字段的旧数据
      return "unknown";
    };

    // 「人工改派」判定：queryTracking/2.0 实测字段 isReassign（0/1），
    // 对应 KPI 第十三条「系统已指派骑手后，站长手动将订单由原骑手分配给新骑手」。
    // 实测某日首页 90 单里 3 单 isReassign=1，且全部为配送成功单 —— 正是会抬高
    // 骑手完单达标/标2 的那批单。字段名做兼容，接口若新增更细的「人工改派」标记可直接命中。
    // 字段缺失 / 为 0 / 为否 一律按「未改派」处理：宁可少剔除，也不误判达标骑手。
    const REASSIGN_KEYS = ["isManualReassign", "isManualAssign", "isReassign", "reassignFlag", "isChangeAssign"];
    const truthy = (v) => {
      if (v == null || v === "") return false;
      if (typeof v === "number") return v > 0;
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      return !["0", "false", "no", "n", "否", "无", "null", "undefined"].includes(s);
    };
    const isReassigned = (r) => REASSIGN_KEYS.some((k) => k in r && truthy(r[k]));

    // reassigned 只统计「配送成功」里的改派单，即真正从骑手达标里剔除的数量
    const orderStats = { total: orders.length, success: 0, failed: 0, unknown: 0, reassigned: 0 };
    const done = new Map(), periodDone = new Map();
    const knightDay = new Map(), knightDayRaw = new Map(), knightSite = new Map();

    for (const r of orders) {
      const site = key(r.teamName);
      const area = areaOfSite(site);
      areaSet.add(area);
      const cls = classify(r);
      orderStats[cls]++;
      if (cls !== "success") continue;
      const reassigned = isReassigned(r);
      if (reassigned) orderStats.reassigned++;
      // 片区「实际完单」与时段完单不受改派剔除影响：KPI 只规定标1–标5 剔除，
      // 规划单量完成率仍按考核单位承接的全部配送成功单统计。
      done.set(area, (done.get(area) || 0) + 1);
      const per = periodOf(r.completeAt || r.trackingFinishAt, periods);
      if (per) {
        if (!periodDone.has(area)) periodDone.set(area, new Map());
        const m = periodDone.get(area);
        m.set(per, (m.get(per) || 0) + 1);
      }
      const rid = key(r.knightId);
      if (rid) {
        knightSite.set(rid, site);
        knightDayRaw.set(rid, (knightDayRaw.get(rid) || 0) + 1);   // 对账用：含改派单
        // 骑手达标只认「非人工改派」的完成单
        if (!reassigned) knightDay.set(rid, (knightDay.get(rid) || 0) + 1);
      }
    }

    // ---------------- 标2 / 完单达标 ----------------
    // KPI 第十三条「人工改派结算限制」：改派完单量在标1–标5 中剔除。
    // 因此「完单达标人数 / 标2 骑手数」只用 knightDay（非改派成功单）判定；
    // knightDayRaw 仅用于算出「若不剔除会虚高多少人」，方便核对口径变化。
    const thresholdOf = (site) => (isUB(site) ? 26 : 24);
    const doneOk = new Map(), b2 = new Map();
    let dokRaw = 0, b2Raw = 0, downgraded = 0;
    for (const [rid, cntRaw] of knightDayRaw) {
      const site = knightSite.get(rid) || "";
      const th = thresholdOf(site);
      if (cntRaw < th) continue;
      dokRaw++;
      if ((att.get(rid) || 0.0) >= ONLINE_MIN_HOURS) b2Raw++;
      if ((knightDay.get(rid) || 0) < th) downgraded++;   // 原本达标、剔除改派单后跌破门槛
    }
    for (const [rid, cnt] of knightDay) {
      const site = knightSite.get(rid) || "";
      const area = areaOfSite(site);
      if (cnt < thresholdOf(site)) continue;
      doneOk.set(area, (doneOk.get(area) || 0) + 1);
      const dur = att.get(rid) || 0.0;
      if (dur >= ONLINE_MIN_HOURS) b2.set(area, (b2.get(area) || 0) + 1);
    }

    // ---------------- 行组装（顺序与钉钉看板一致）----------------
    const areas = [...areaSet];
    const preferred = AREA_ORDER.filter((a) => areas.includes(a));
    const extra = areas.filter((a) => !AREA_ORDER.includes(a)).sort((a, b) => a.localeCompare(b, "zh-CN"));
    const areaList = [...preferred, ...extra];

    const get = (m, k, f) => (m.get(k) || {})[f] || 0;
    // 与 send_assess_dingtalk.py 一致：过滤「无规划单量且无实际完单」的空片区
    const rows = areaList.map((area) => {
      const p = get(plan, area, "v"), d = done.get(area) || 0;
      const hc = get(headcount, area, "v");
      const dok = doneOk.get(area) || 0, b = b2.get(area) || 0;
      const comp = p ? d / p * 100 : 0.0;
      const b2r = hc ? b / hc * 100 : 0.0;
      const tot = scoreComplete(comp) * 0.4 + scoreBiao2(b2r) * 0.6;
      const pd = {};
      for (const per of periods) {
        const pl = get(periodPlan, area, per);
        const dv = (periodDone.get(area) || new Map()).get(per) || 0;
        pd[per] = { plan: pl, done: dv, rate: pl ? dv / pl * 100 : 0.0 };
      }
      return { area, plan: p, done: d, comp, dok, b2: b, hc, b2r, tot, pd };
    }).filter((r) => r.plan > 0 || r.done > 0);

    const sum = (f) => rows.reduce((x, r) => x + r[f], 0);
    const tPlan = sum("plan"), tDone = sum("done"), tHead = sum("hc");
    const tDok = sum("dok"), tB2 = sum("b2");
    const tComp = tPlan ? tDone / tPlan * 100 : 0.0;
    const tB2r = tHead ? tB2 / tHead * 100 : 0.0;
    const totals = {
      plan: tPlan, done: tDone, comp: tComp, dok: tDok, b2: tB2, hc: tHead, b2r: tB2r,
      tot: scoreComplete(tComp) * 0.4 + scoreBiao2(tB2r) * 0.6
    };
    // 改派口径对账：excluded=被剔除的改派成功单；dokRaw/b2Raw=不剔除时的人数；
    // downgraded=因剔除改派单从达标变不达标的骑手数。看板底部据此展示，便于人工核对。
    const reassignStats = {
      excluded: orderStats.reassigned,
      dokRaw, b2Raw, dok: tDok, b2: tB2, downgraded
    };
    const totalPd = {};
    for (const per of periods) {
      let pl = 0, dv = 0;
      for (const r of rows) { pl += r.pd[per].plan; dv += r.pd[per].done; }
      totalPd[per] = { plan: pl, done: dv, rate: pl ? dv / pl * 100 : 0.0 };
    }

    return {
      rows, totals, totalPd, periods, periodSource, unknownPeriods: [...unknownPeriods],
      orderStats, reassignStats,
      scheduleOk, attendanceOk,
      mapped: mappedCnt > 0, mappingFallback: fallbackCnt > 0,
      areaLabel: mappedCnt > 0 ? "商圈片" : "商圈"
    };
  }

  return { build, PERIOD_NAMES, PERIOD_DEFS, DEFAULT_PERIOD_NAMES, periodOf, scoreComplete, scoreBiao2 };
})();
