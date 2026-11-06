// 考核计算：与 fengshen-data/assess_image.py 逐行对齐（规划单量完成率 + 标2骑手占比）
// 通用化策略：站点→商圈片映射为「可选表」。命中则用钉钉同一套片区名（数据完全一致）；
// 未命中（换商登录）则回退到接口原生 merchantBusDistrictName，其余口径全部一致。
/* global ASSESS */

const ASSESS = (() => {
  // ---- 7 个工作时段（config.PERIOD_STANDARDS）----
  const PERIODS = [
    { name: "早餐2",   start: 8 * 60,        end: 10 * 60 + 30 },
    { name: "午高峰",  start: 10 * 60 + 30,  end: 13 * 60 + 30 },
    { name: "下午茶1", start: 13 * 60 + 30,  end: 15 * 60 + 30 },
    { name: "下午茶2", start: 15 * 60 + 30,  end: 17 * 60 + 30 },
    { name: "晚高峰",  start: 17 * 60 + 30,  end: 20 * 60 },
    { name: "夜宵1",   start: 20 * 60,       end: 22 * 60 },
    { name: "夜宵2",   start: 22 * 60,       end: 24 * 60 }
  ];
  const PERIOD_NAMES = PERIODS.map((p) => p.name);

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

  function periodOf(ts) {
    if (!ts || !isFinite(Number(ts))) return null;
    const d = new Date(Number(ts));
    const t = d.getHours() * 60 + d.getMinutes();
    const p = PERIODS.find((x) => t >= x.start && t < x.end);
    return p ? p.name : null;   // 00:00-08:00 凌晨单不计入 7 时段（与钉钉看板一致）
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

    // ---------------- 排班：规划单量 / 应排骑手 / 时段预估单量 ----------------
    const areaSet = new Set();   // 排班有量但当日无完单的片区也要出现在看板上
    const plan = new Map(), headcount = new Map(), periodPlan = new Map();
    const bump = (map, k, field, v) => {
      if (!map.has(k)) map.set(k, {});
      const o = map.get(k);
      o[field] = (o[field] || 0) + v;
    };
    let scheduleOk = false;
    const sch = XLSX.pickSheet(schSheets || [], ["团队名称", "日期", "时段", "预估单量", "应排人数"]);
    if (sch) {
      scheduleOk = true;
      const c = sch.col;
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
          if (PERIOD_NAMES.includes(per)) bump(periodPlan, area, per, num(r[c["预估单量"]]));
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
    const done = new Map(), periodDone = new Map();
    const knightDay = new Map(), knightSite = new Map();
    const isSuccess = (r) => r.state === 40 || String(r.stateDesc) === "配送成功";

    for (const r of orders) {
      const site = key(r.teamName);
      const area = areaOfSite(site);
      areaSet.add(area);
      if (!isSuccess(r)) continue;
      done.set(area, (done.get(area) || 0) + 1);
      const per = periodOf(r.completeAt || r.trackingFinishAt);
      if (per) {
        if (!periodDone.has(area)) periodDone.set(area, new Map());
        const m = periodDone.get(area);
        m.set(per, (m.get(per) || 0) + 1);
      }
      const rid = key(r.knightId);
      if (rid) {
        knightDay.set(rid, (knightDay.get(rid) || 0) + 1);
        knightSite.set(rid, site);
      }
    }

    // ---------------- 标2 / 完单达标 ----------------
    const doneOk = new Map(), b2 = new Map();
    for (const [rid, cnt] of knightDay) {
      const site = knightSite.get(rid) || "";
      const area = areaOfSite(site);
      if (cnt < (isUB(site) ? 26 : 24)) continue;
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
      for (const per of PERIOD_NAMES) {
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
    const totalPd = {};
    for (const per of PERIOD_NAMES) {
      let pl = 0, dv = 0;
      for (const r of rows) { pl += r.pd[per].plan; dv += r.pd[per].done; }
      totalPd[per] = { plan: pl, done: dv, rate: pl ? dv / pl * 100 : 0.0 };
    }

    return {
      rows, totals, totalPd, periods: PERIOD_NAMES,
      scheduleOk, attendanceOk,
      mapped: mappedCnt > 0, mappingFallback: fallbackCnt > 0,
      areaLabel: mappedCnt > 0 ? "商圈片" : "商圈"
    };
  }

  return { build, PERIOD_NAMES, scoreComplete, scoreBiao2 };
})();
