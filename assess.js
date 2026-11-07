// 考核计算：与 fengshen-data/assess_image.py 逐行对齐（规划单量完成率 + 标2骑手占比）
// v3.5.0 追加「出勤达成」：应排 / 实排 / 有效出勤 × 时段矩阵（口径对齐 config.py + review_report.py）
// v3.7.0 追加「历史日期」：T-1 及更早日期改用出勤统计的时段明细，标准成实时考勤表结构；
//   系统「是否达成」列在全天行不可信，一律忽略，由 build() 按 6h / 18 单手工判定。
// 通用化策略：站点→商圈片映射为「可选表」。命中则用钉钉同一套片区名（数据完全一致）；
// 未命中（换商登录）则回退到接口原生 merchantBusDistrictName，其余口径全部一致。
/* global ASSESS */

const ASSESS = (() => {
  // ---- 时段字典：与 config.py 的 PERIOD_STANDARDS（KPI PDF 第 9-10 页，11 时段全集）逐行对齐 ----
  // 排班统计表只给「班次名」、不给时间区间，所以「时间戳 → 班次」的映射必须靠这份字典；
  // 但「当天到底有哪些班次」以排班表为准：实测 10-31 只有 7 个工作班次，11-05/11-06 多出
  // 「凌晨1」「早餐1」变成 9 个。硬编码列会丢掉这些班次及其预估单量，因此改为排班驱动。
  // timeMin / orders = 「有效出勤」判定标准（config.py PERIOD_STANDARDS，KPI PDF 第 9-10 页）：
  // 骑手在该时段「有效在线时长 ≥ timeMin 分钟」且「完单量 ≥ orders 单」才算有效出勤。
  const PERIOD_DEFS = [
    { name: "凌晨1",   start: 0,            end: 2 * 60,       timeMin: 90,  orders: 1 },
    { name: "凌晨2",   start: 2 * 60,       end: 4 * 60,       timeMin: 78,  orders: 1 },
    { name: "凌晨3",   start: 4 * 60,       end: 6 * 60,       timeMin: 72,  orders: 1 },
    { name: "早餐1",   start: 6 * 60,       end: 8 * 60,       timeMin: 90,  orders: 1 },
    { name: "早餐2",   start: 8 * 60,       end: 10 * 60 + 30, timeMin: 120, orders: 1 },
    { name: "午高峰",  start: 10 * 60 + 30, end: 13 * 60 + 30, timeMin: 150, orders: 5 },
    { name: "下午茶1", start: 13 * 60 + 30, end: 15 * 60 + 30, timeMin: 90,  orders: 2 },
    { name: "下午茶2", start: 15 * 60 + 30, end: 17 * 60 + 30, timeMin: 90,  orders: 2 },
    { name: "晚高峰",  start: 17 * 60 + 30, end: 20 * 60,      timeMin: 120, orders: 3 },
    { name: "夜宵1",   start: 20 * 60,      end: 22 * 60,      timeMin: 90,  orders: 2 },
    { name: "夜宵2",   start: 22 * 60,      end: 24 * 60,      timeMin: 90,  orders: 2 }
  ];
  // 「全天」按运力标准 1 等效：全天有效在线≥6h 且 全天完单≥18（config.py DAY_STANDARD）
  const DAY_ATTEND_STANDARD = { timeMin: 360, orders: 18 };
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
  // 出勤达成表按「商圈片出勤看板」的顺序（与钉钉考核看板的片区顺序不同），
  // 未列出的片区（换商 / 新增站点）按考核表顺序排在后面，保证不丢行。
  const ATT_AREA_ORDER = [
    "福州鼓楼区茶亭西湖商圈片", "福州福清市老城商圈片", "福州台江区台江商圈片",
    "福州福清市万达宏路商圈片", "福州仓山区城门商圈片"
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
   * 把「出勤统计 → 导出明细数据」的 xlsx 标准成实时考勤表的列结构，供 build() 复用同一套口径。
   *
   * 为什么需要它：
   *   exportAttendance/1.0 实测忽略 startDate/endDate，无论传哪天都返回「当前实时快照」，
   *   所以 T-1 及更早日期必须用 exportStatisticsDetail/1.0 的骑手 × 时段明细。
   *   该文件每行是 骑手 × 时段，含「是否排班 / 有效在线时长 / 完单量」，另有「全天」汇总行。
   *
   * 为什么忽略「是否达成」：
   *   明细表全天行的 目标完单量 / 目标在线时长 为空，系统给的「达成」标记并非按
   *   6 小时 / 18 单判定（实测会把不达标的骑手标成达成）。因此这里完全不读该列，
   *   全天达成统一交给 build() 用 DAY_ATTEND_STANDARD 手工判定；时段达成也由 build()
   *   按 PERIOD_DEFS 的 timeMin / orders 判定，避免两套口径漂移。
   *
   * @returns {{sheets:Array, stats:Object, error?:string}}
   */
  function detailToAttendance(detailSheets, dateStr, XLSX) {
    const candidates = [
      ["骑手ID", "时段", "有效在线时长", "完单量"],
      ["骑手id", "时段", "有效在线时长", "完单量"],
      ["骑手ID", "时段", "时段有效在线时长", "时段完单量"],
      ["骑手id", "时段", "时段有效在线时长", "时段完单量"]
    ];
    let s = null;
    for (const must of candidates) {
      s = XLSX.pickSheet(detailSheets || [], must);
      if (s) break;
    }
    if (!s) {
      return { sheets: [], stats: { rows: 0, riders: 0 },
        error: "出勤明细表缺少 骑手ID / 时段 / 有效在线时长 / 完单量 列" };
    }
    const c = s.col;
    const colOf = (names) => { for (const n of names) if (c[n] !== undefined) return c[n]; return -1; };
    const iRider = colOf(["骑手ID", "骑手id"]);
    const iSite = colOf(["站点名称", "团队名称", "站点"]);
    const iStatus = colOf(["是否排班", "排班状态"]);
    const iPer = colOf(["时段"]);
    const iValid = colOf(["有效在线时长", "时段有效在线时长"]);
    const iOrders = colOf(["完单量", "时段完单量"]);
    const iDate = colOf(["考勤日期", "日期"]);
    const missing = [];
    if (iSite < 0) missing.push("站点名称");
    if (iStatus < 0) missing.push("是否排班");
    if (missing.length) {
      return { sheets: [], stats: { rows: 0, riders: 0 },
        error: "出勤明细表缺少 " + missing.join("、") + " 列" };
    }

    // 先扫「全天」行拿到每个骑手当日的有效在线时长 / 完单量，
    // 再把它复制到该骑手每一行，凑齐实时考勤表里的「全天…」两列。
    const dayRows = new Map();
    const onDate = (r) => iDate < 0 || String(r[iDate] ?? "").slice(0, 10) === dateStr;
    for (const r of s.rows) {
      if (!onDate(r) || key(r[iPer]) !== "全天") continue;
      const rid = key(r[iRider]);
      if (!rid || dayRows.has(rid)) continue;
      dayRows.set(rid, {
        valid: String(r[iValid] ?? "").trim(),
        orders: String(r[iOrders] ?? "").trim()
      });
    }
    const header = ["站点名称", "骑手id", "排班状态", "时段",
      "全天有效在线时长", "全天完单量", "时段有效在线时长", "时段完单量"];
    const rows = [header];
    let dayRowsMissing = 0;
    for (const r of s.rows) {
      if (!onDate(r)) continue;
      const rid = key(r[iRider]);
      if (!rid) continue;
      const d = dayRows.get(rid);
      if (!d) dayRowsMissing++;
      rows.push([
        key(r[iSite]), rid, key(r[iStatus]), key(r[iPer]),
        d ? d.valid : "", d ? d.orders : "",
        String(r[iValid] ?? "").trim(), String(r[iOrders] ?? "").trim()
      ]);
    }
    return {
      sheets: [{ name: "出勤明细(标准化)", rows }],
      stats: {
        rows: rows.length - 1, riders: dayRows.size, dayRowsMissing,
        ignoredDayFlag: true, dayStandard: DAY_ATTEND_STANDARD
      }
    };
  }

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
    // 纯解析（不计数）：出勤模块复用同一套商圈片分组，不能把 areaLabel 的映射统计带偏
    const areaOf = (site) => {
      const s = key(site);
      return SITE_TO_AREA[s] || teamToDistrict.get(s) || s || "未识别";
    };
    let mappedCnt = 0, fallbackCnt = 0;
    const areaOfSite = (site) => {
      if (SITE_TO_AREA[key(site)]) mappedCnt++;
      else fallbackCnt++;
      return areaOf(site);
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

    // ---------------- 出勤达成：应排 / 实排 / 有效出勤 ----------------
    // 口径与 fengshen-data/config.py PERIOD_STANDARDS + review_report.py 一致：
    //   应排 = 排班统计「应排人数」；实排 = 排班统计「排班人数」（站点×时段按商圈片聚合）
    //   有效出勤 = 「排班状态=排班」且 (时段有效在线时长≥timeMin 且 时段完单量≥orders)
    //     的去重骑手数；全天用 DAY_ATTEND_STANDARD（6h / 18 单，运力标准1等效）
    //   考勤来源：今天用 exportAttendance 实时快照；历史日期用 exportStatisticsDetail
    //     时段明细经 detailToAttendance() 标准成同样的列。两者都只认原始时长/完单量，
    //     不采信系统自带的「是否达成」标记（全天标记实测有误）。
    //   实排达成 = 有效出勤 / 实排；应排达成 = 有效出勤 / 应排（可 >100%，多排班不设上限）
    const attCols = ["全天", ...periods];
    const attKey = (area, per) => area + "\u0001" + per;
    const attDue = new Map(), attReal = new Map(), attValid = new Map();
    // 排班统计表若没有「排班人数」列（旧导出）则单独再找一次，避免整块数据失效
    const schAtt = (sch && sch.col["排班人数"] !== undefined)
      ? sch : XLSX.pickSheet(schSheets || [], ["团队名称", "日期", "时段", "应排人数", "排班人数"]);
    let attScheduleOk = false;
    if (schAtt) {
      attScheduleOk = true;
      const c = schAtt.col;
      for (const r of schAtt.rows) {
        if (String(r[c["日期"]] || "").slice(0, 10) !== dateStr) continue;
        const per = key(r[c["时段"]]);
        if (!attCols.includes(per)) continue;        // 休息 / 未识别班次不进矩阵
        const k = attKey(areaOf(key(r[c["团队名称"]])), per);
        attDue.set(k, (attDue.get(k) || 0) + num(r[c["应排人数"]]));
        attReal.set(k, (attReal.get(k) || 0) + num(r[c["排班人数"]]));
      }
    }

    // 考勤导出列名容错：缺关键列时明确提示，缺「完单量」则退化成只看有效在线时长
    const colOf = (c, names) => {
      for (const n of names) if (c[n] !== undefined) return c[n];
      return -1;
    };
    let attOk = false, attMissing = [], attDegraded = false;
    const validSets = new Map(), periodActivity = new Set();
    if (ats) {
      const c = ats.col;
      const iRider = c["骑手id"];
      const iSite = colOf(c, ["站点名称", "团队名称", "站点", "团队"]);
      const iStatus = colOf(c, ["排班状态"]);
      const iPer = colOf(c, ["时段"]);
      const iPValid = colOf(c, ["时段有效在线时长", "有效在线时长"]);
      const iPOrders = colOf(c, ["时段完单量", "完单量"]);
      const iDValid = colOf(c, ["全天有效在线时长"]);
      const iDOrders = colOf(c, ["全天完单量"]);
      const missing = [];
      if (iSite < 0) missing.push("站点名称");
      if (iStatus < 0) missing.push("排班状态");
      if (iPer < 0) missing.push("时段");
      if (iPValid < 0) missing.push("时段有效在线时长");
      if (iDValid < 0) missing.push("全天有效在线时长");
      if (missing.length) attMissing = missing;
      else {
        attOk = true;
        if (iPOrders < 0 || iDOrders < 0) attDegraded = true;
        for (const r of ats.rows) {
          const per = key(r[iPer]);
          const rid = key(r[iRider]);
          const durP = parseDur(r[iPValid]);
          const ordP = iPOrders >= 0 ? num(r[iPOrders]) : 0;
          if (durP > 0 || ordP > 0) periodActivity.add(per);
          if (!rid || key(r[iStatus]) !== "排班") continue;
          let valid = false;
          // parseDur 返回「小时」（标2 的 6h 门槛沿用），时段标准 timeMin 是「分钟」
          if (per === "全天") {
            const ordD = iDOrders >= 0 ? num(r[iDOrders]) : 0;
            valid = parseDur(r[iDValid]) * 60 >= DAY_ATTEND_STANDARD.timeMin &&
                    (iDOrders < 0 || ordD >= DAY_ATTEND_STANDARD.orders);
          } else {
            const p = PERIOD_BY_NAME.get(per);
            if (p && periodSet.has(per)) {
              valid = durP * 60 >= p.timeMin && (iPOrders < 0 || ordP >= p.orders);
            }
          }
          if (!valid || !attCols.includes(per)) continue;
          const k = attKey(areaOf(key(r[iSite])), per);
          if (!validSets.has(k)) validSets.set(k, new Set());
          validSets.get(k).add(rid);       // 同一骑手同一时段可能有多行，去重
        }
        for (const [k, s] of validSets) attValid.set(k, s.size);
      }
    } else attMissing = ["考勤表"];

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

    // ---------------- 出勤达成表组装（与考核表共用同一份商圈片顺序）----------------
    const attRows = [], attTotals = {};
    for (const per of attCols) attTotals[per] = { due: 0, real: 0, valid: 0 };
    const attAreas = [...ATT_AREA_ORDER.filter((x) => areaList.includes(x)),
                      ...areaList.filter((x) => !ATT_AREA_ORDER.includes(x))];
    for (const area of attAreas) {
      const cells = {};
      let any = false;
      for (const per of attCols) {
        const k = attKey(area, per);
        const due = attDue.get(k) || 0, real = attReal.get(k) || 0, valid = attValid.get(k) || 0;
        if (due || real || valid) any = true;
        cells[per] = {
          due, real, valid,
          realRate: real > 0 ? valid / real * 100 : null,
          dueRate: due > 0 ? valid / due * 100 : null
        };
        attTotals[per].due += due; attTotals[per].real += real; attTotals[per].valid += valid;
      }
      if (any) attRows.push({ area, cells });
    }
    for (const per of attCols) {
      const t = attTotals[per];
      t.realRate = t.real > 0 ? t.valid / t.real * 100 : null;
      t.dueRate = t.due > 0 ? t.valid / t.due * 100 : null;
    }
    // 考勤是「当日实时快照」：未结束的班次（例如 22:00 后看 22:10 导出的夜宵2）
    // 有效出勤还没跑满，达成率会随时间补齐，看板上标注「统计中 / 未开始」而不是误显示 0%。
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const minute = now.getHours() * 60 + now.getMinutes();
    const ongoing = localDate === dateStr ? attCols.filter((per) => {
      if (per === "全天") return true;
      const p = PERIOD_BY_NAME.get(per);
      return !p || minute < p.end;
    }) : [];
    const noData = attCols.filter((per) => per !== "全天" && !periodActivity.has(per));
    const attendance = {
      ok: attOk && attScheduleOk, scheduleOk: attScheduleOk, attendanceOk: attOk,
      degraded: attDegraded, missing: attMissing,
      periods: attCols, rows: attRows, totals: attTotals,
      standards: Object.fromEntries(PERIOD_DEFS.map((p) => [p.name, { timeMin: p.timeMin, orders: p.orders }])),
      dayStandard: DAY_ATTEND_STANDARD, ongoing, noData
    };

    return {
      rows, totals, totalPd, periods, periodSource, unknownPeriods: [...unknownPeriods],
      orderStats, reassignStats, attendance,
      scheduleOk, attendanceOk,
      mapped: mappedCnt > 0, mappingFallback: fallbackCnt > 0,
      areaLabel: mappedCnt > 0 ? "商圈片" : "商圈"
    };
  }

  return { build, detailToAttendance,
           PERIOD_NAMES, PERIOD_DEFS, DEFAULT_PERIOD_NAMES, DAY_ATTEND_STANDARD,
           periodOf, scoreComplete, scoreBiao2 };
})();
