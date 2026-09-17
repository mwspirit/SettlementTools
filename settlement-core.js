(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SettlementCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_PRICE_CENTS = 10000000 * 100;
  const MAX_FRAMEWORK_TOTAL_CENTS = 100000000 * 100;

  function parseDate(value) {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year
      && date.getMonth() === month - 1
      && date.getDate() === day
      ? date
      : null;
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function yyyymm(year, monthIndex) {
    return `${year}${String(monthIndex + 1).padStart(2, "0")}`;
  }

  function periodBySettlementMonth(monthText) {
    const year = Number(monthText.slice(0, 4));
    const month = Number(monthText.slice(4, 6)) - 1;
    return {
      month: monthText,
      start: new Date(year, month - 1, 26),
      end: new Date(year, month, 25)
    };
  }

  function settlementMonthForDate(date) {
    const monthOffset = date.getDate() <= 25 ? 0 : 1;
    const month = new Date(date.getFullYear(), date.getMonth() + monthOffset, 1);
    return yyyymm(month.getFullYear(), month.getMonth());
  }

  function nextSettlementMonth(monthText) {
    const period = periodBySettlementMonth(monthText);
    return settlementMonthForDate(addDays(period.end, 1));
  }

  function isWorkday(date, holidayDates, makeupWorkDates) {
    const key = formatDate(date);
    if (makeupWorkDates.has(key)) return true;
    if (holidayDates.has(key)) return false;
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  function countWorkdays(start, end, holidayDates, makeupWorkDates) {
    if (start > end) return 0;
    let count = 0;
    for (let date = new Date(start); date <= end; date = addDays(date, 1)) {
      if (isWorkday(date, holidayDates, makeupWorkDates)) count += 1;
    }
    return count;
  }

  function decimalToCents(value) {
    const text = String(value ?? "").trim();
    const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    return Number.isSafeInteger(cents) ? cents : null;
  }

  function parsePeople(text) {
    const rows = [];
    const errors = [];
    text.split(/\r?\n/).forEach((sourceLine, index) => {
      const line = sourceLine.trim();
      if (!line) return;
      const match = line.match(/^(.+?)[：:]\s*(\d{4}-\d{2}-\d{2})\s*到\s*(\d{4}-\d{2}-\d{2})\s+(\S+)$/);
      if (!match) {
        errors.push(`第 ${index + 1} 行无法识别：${line}`);
        return;
      }
      const start = parseDate(match[2]);
      const end = parseDate(match[3]);
      if (!start || !end) {
        errors.push(`第 ${index + 1} 行包含无效日期：${line}`);
        return;
      }
      if (start > end) {
        errors.push(`第 ${index + 1} 行开始日期晚于结束日期：${line}`);
        return;
      }
      const priceCents = decimalToCents(match[4]);
      if (priceCents === null || priceCents <= 0 || priceCents > MAX_PRICE_CENTS) {
        errors.push(`第 ${index + 1} 行人员单价必须大于0、最多两位小数且不超过10,000,000元：${line}`);
        return;
      }
      rows.push({
        name: match[1].trim(),
        start,
        end,
        priceCents,
        price: priceCents / 100
      });
    });
    return { rows, errors };
  }

  function calculateProratedFeeCents(priceCents, actualDays, shouldDays) {
    if (!shouldDays) return 0;
    return Math.round(priceCents * actualDays / shouldDays);
  }

  function formatCents(cents) {
    return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  }

  function buildMonthlySettlementText(text, holidayDates = new Set(), makeupWorkDates = new Set()) {
    const parsed = parsePeople(text);
    if (parsed.errors.length || !parsed.rows.length) {
      return { text: "", errors: parsed.errors, monthCount: 0 };
    }

    const groups = new Map();
    parsed.rows.forEach(person => {
      let month = settlementMonthForDate(person.start);
      const lastMonth = settlementMonthForDate(person.end);
      while (month <= lastMonth) {
        const period = periodBySettlementMonth(month);
        const start = person.start > period.start ? person.start : period.start;
        const end = person.end < period.end ? person.end : period.end;
        if (start <= end) {
          if (!groups.has(month)) groups.set(month, { lines: [], totalFeeCents: 0 });
          const group = groups.get(month);
          const shouldDays = countWorkdays(period.start, period.end, holidayDates, makeupWorkDates);
          const actualDays = countWorkdays(start, end, holidayDates, makeupWorkDates);
          group.totalFeeCents += calculateProratedFeeCents(person.priceCents, actualDays, shouldDays);
          group.lines.push(`${person.name}：${formatDate(start)}到${formatDate(end)} ${formatCents(person.priceCents)}`);
        }
        if (month === lastMonth) break;
        month = nextSettlementMonth(month);
      }
    });

    const months = [...groups.keys()].sort();
    const years = new Set(months.map(month => month.slice(0, 4)));
    const sections = months.map(month => {
      const monthNumber = Number(month.slice(4, 6));
      const group = groups.get(month);
      const monthTitle = years.size === 1 ? `${monthNumber}月` : `${month.slice(0, 4)}年${monthNumber}月`;
      const title = `${monthTitle}（总费用：${(group.totalFeeCents / 100).toFixed(2)}元）：`;
      return [title, ...group.lines].join("\n");
    });
    return { text: sections.join("\n\n"), errors: [], monthCount: months.length };
  }

  function parseMonthHundredths(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    return Math.round(number * 100);
  }

  function seededFraction(seed, salt) {
    const value = Math.sin((seed + 1) * 99991 + salt * 1013) * 43758.5453123;
    return value - Math.floor(value);
  }

  function findFrameworkSplitTwoDecimals(totalCents, fixedHundredths = {}, maxLimitHundredths = Infinity, seed = 0.5) {
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > MAX_FRAMEWORK_TOTAL_CENTS) return null;
    if (maxLimitHundredths < 0 || totalCents % 500 !== 0) return null;

    const totalUnits = totalCents / 500;
    const possibleMax = Math.floor(totalCents / 14500);
    const totalLimit = Number.isFinite(maxLimitHundredths)
      ? Math.min(possibleMax, Math.floor(maxLimitHundredths))
      : possibleMax;
    const fixed = {
      p2: Number.isInteger(fixedHundredths.p2) ? fixedHundredths.p2 : null,
      p31: Number.isInteger(fixedHundredths.p31) ? fixedHundredths.p31 : null,
      p32: Number.isInteger(fixedHundredths.p32) ? fixedHundredths.p32 : null
    };
    if (Object.values(fixed).some(value => value !== null && (value < 0 || value > totalLimit))) return null;

    let bestPenalty = Infinity;
    const candidates = [];
    const consider = (x, y, z) => {
      if (![x, y, z].every(Number.isInteger) || x < 0 || y < 0 || z < 0) return;
      if (fixed.p2 !== null && x !== fixed.p2) return;
      if (fixed.p31 !== null && y !== fixed.p31) return;
      if (fixed.p32 !== null && z !== fixed.p32) return;
      const totalMonths = x + y + z;
      if (!totalMonths || totalMonths > totalLimit) return;
      const p31Share = y / totalMonths;
      const smallMonthsPenalty = [x, y, z].filter(value => value > 0 && value < 10).length * 10000;
      const penalty = (p31Share >= 0.6 && p31Share <= 0.95 ? 0 : 1000)
        + ((x > 0 ? 0 : 1) + (z > 0 ? 0 : 1)) * 100
        + smallMonthsPenalty;
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        candidates.length = 0;
      }
      if (penalty === bestPenalty && candidates.length < 200) {
        candidates.push({ p2: x, p31: y, p32: z, p31Share });
      }
    };

    const yStart = fixed.p31 ?? 0;
    const yEnd = Math.min(fixed.p31 ?? Math.floor(totalCents / 17000), totalLimit);
    for (let y = yStart; y <= yEnd; y += 1) {
      const remainingUnits = totalUnits - 34 * y;
      if (remainingUnits < 0) break;

      if (fixed.p2 !== null && fixed.p32 !== null) {
        if (29 * fixed.p2 + 38 * fixed.p32 === remainingUnits) consider(fixed.p2, y, fixed.p32);
        continue;
      }
      if (fixed.p2 !== null) {
        consider(fixed.p2, y, (remainingUnits - 29 * fixed.p2) / 38);
        continue;
      }
      if (fixed.p32 !== null) {
        consider((remainingUnits - 38 * fixed.p32) / 29, y, fixed.p32);
        continue;
      }

      const xBase = ((remainingUnits * 21) % 38 + 38) % 38;
      const maxX = Math.min(Math.floor(remainingUnits / 29), totalLimit - y);
      if (xBase > maxX) continue;
      const maxK = Math.floor((maxX - xBase) / 38);
      const sampleKs = new Set([0, maxK, Math.floor(seededFraction(seed, y) * (maxK + 1))]);
      sampleKs.forEach(k => {
        const x = xBase + 38 * k;
        consider(x, y, (remainingUnits - 29 * x) / 38);
      });
    }

    if (!candidates.length) return null;
    return candidates[Math.floor(seededFraction(seed, candidates.length) * candidates.length)];
  }

  function findFrameworkSplit(totalCents, fixedHundredths = {}, maxLimitHundredths = Infinity, seed = 0.5) {
    const twoDecimals = findFrameworkSplitTwoDecimals(totalCents, fixedHundredths, maxLimitHundredths, seed);
    if (twoDecimals) return { ...twoDecimals, precision: 2 };
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > MAX_FRAMEWORK_TOTAL_CENTS) return null;
    if (Object.keys(fixedHundredths).some(key => Number.isFinite(fixedHundredths[key]))) return null;

    // 五位小数单位下：P2 每单位 14.5 分、P3-1 每单位 17 分、P3-2 每单位 19 分。
    // P2 单位取偶数即可保证每行费用和总费用都精确到分。
    const totalUnitLimit = Number.isFinite(maxLimitHundredths)
      ? Math.floor(maxLimitHundredths * 1000)
      : Infinity;
    const candidates = [];
    let bestPenalty = Infinity;
    const consider = (x, y, z) => {
      if (![x, y, z].every(Number.isInteger) || x < 0 || y < 0 || z < 0 || x % 2 !== 0) return;
      const totalUnits = x + y + z;
      if (!totalUnits || totalUnits > totalUnitLimit) return;
      const p31Share = y / totalUnits;
      const highPrecisionRows = [x, y, z].filter(value => value % 1000 !== 0).length;
      const p2HighPrecisionPenalty = x % 1000 !== 0 ? 25000 : 0;
      const p31HighPrecisionPenalty = y % 1000 !== 0 ? 50000 : 0;
      const smallMonthsPenalty = [x, y, z].filter(value => value > 0 && value < 10000).length * 10000;
      const penalty = highPrecisionRows * 100000
        + p2HighPrecisionPenalty
        + p31HighPrecisionPenalty
        + (p31Share >= 0.6 && p31Share <= 0.95 ? 0 : 1000)
        + ((x > 0 ? 0 : 1) + (z > 0 ? 0 : 1)) * 100
        + smallMonthsPenalty;
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        candidates.length = 0;
      }
      if (penalty === bestPenalty) candidates.push({ p2: x / 1000, p31: y / 1000, p32: z / 1000, p31Share, precision: 5 });
    };

    // 优先尝试只让 P3-1 一行承担分级尾差，P2、P3-2仍保持两位人月。
    const xHundredthCandidates = new Set([0]);
    [0.05, 0.1, 0.15, 0.2].forEach(costShare => {
      const center = Math.max(0, Math.floor(totalCents * costShare / 14500));
      for (let offset = -40; offset <= 40; offset += 1) {
        if (center + offset >= 0) xHundredthCandidates.add(center + offset);
      }
    });
    [...xHundredthCandidates].forEach(xHundredths => {
      const remaining = totalCents - 14500 * xHundredths;
      if (remaining < 0) return;
      const zBase = ((remaining * 14) % 17 + 17) % 17;
      const maxZ = Math.floor(remaining / 19000);
      if (zBase > maxZ) return;
      const maxK = Math.floor((maxZ - zBase) / 17);
      const yBase = (remaining - 19000 * zBase) / 17;
      const totalBase = xHundredths * 1000 + zBase * 1000 + yBase;
      const ks = new Set([0, maxK]);
      [0.6, 0.7, 0.8, 0.9, 0.95].forEach(share => {
        const target = (yBase - share * totalBase) / (19000 - 2000 * share);
        [Math.floor(target), Math.ceil(target)].forEach(k => ks.add(Math.max(0, Math.min(maxK, k))));
      });
      ks.forEach(k => {
        const zHundredths = zBase + 17 * k;
        const yUnits = yBase - 19000 * k;
        consider(xHundredths * 1000, yUnits, zHundredths * 1000);
      });
    });

    // 再尝试只让 P3-2 一行承担尾差，使 P3-1 尽量保持两位小数。
    [...xHundredthCandidates].forEach(xHundredths => {
      const remaining = totalCents - 14500 * xHundredths;
      if (remaining < 0) return;
      const yBase = ((remaining * 15) % 19 + 19) % 19;
      const maxY = Math.floor(remaining / 17000);
      if (yBase > maxY) return;
      const maxK = Math.floor((maxY - yBase) / 19);
      const zBaseUnits = (remaining - 17000 * yBase) / 19;
      const yBaseUnits = yBase * 1000;
      const totalBase = xHundredths * 1000 + yBaseUnits + zBaseUnits;
      const ks = new Set([0, maxK]);
      [0.6, 0.7, 0.8, 0.9, 0.95].forEach(share => {
        const target = (share * totalBase - yBaseUnits) / (19000 - 2000 * share);
        [Math.floor(target), Math.ceil(target)].forEach(k => ks.add(Math.max(0, Math.min(maxK, k))));
      });
      ks.forEach(k => {
        const yHundredths = yBase + 19 * k;
        const zUnits = zBaseUnits - 17000 * k;
        consider(xHundredths * 1000, yHundredths * 1000, zUnits);
      });
    });

    const qCandidates = new Set(Array.from({ length: 20 }, (_, index) => index + 1));
    [0.05, 0.1, 0.15, 0.2].forEach(costShare => {
      const center = Math.max(1, Math.floor(totalCents * costShare / 29));
      for (let offset = -20; offset <= 20; offset += 1) qCandidates.add(center + offset);
    });
    [...qCandidates].filter(q => q > 0).sort((a, b) => a - b).forEach(q => {
      const x = q * 2;
      const remaining = totalCents - 29 * q;
      if (remaining < 0) return;
      const zBase = ((remaining * 9) % 17 + 17) % 17;
      const yBase = (remaining - 19 * zBase) / 17;
      if (!Number.isInteger(yBase) || yBase < 0) return;
      const maxK = Math.floor(yBase / 19);
      const totalBase = x + yBase + zBase;
      const ks = new Set([0, maxK]);
      [0.6, 0.7, 0.8, 0.9, 0.95].forEach(share => {
        const target = (yBase - share * totalBase) / (19 - 2 * share);
        [Math.floor(target), Math.ceil(target)].forEach(k => ks.add(Math.max(0, Math.min(maxK, k))));
      });
      ks.forEach(k => consider(x, yBase - 19 * k, zBase + 17 * k));
    });

    if (!candidates.length) return null;
    return candidates[Math.floor(seededFraction(seed, candidates.length) * candidates.length)];
  }

  return {
    MAX_PRICE_CENTS,
    MAX_FRAMEWORK_TOTAL_CENTS,
    parseDate,
    formatDate,
    addDays,
    yyyymm,
    periodBySettlementMonth,
    settlementMonthForDate,
    nextSettlementMonth,
    isWorkday,
    countWorkdays,
    decimalToCents,
    parsePeople,
    calculateProratedFeeCents,
    buildMonthlySettlementText,
    parseMonthHundredths,
    findFrameworkSplit
  };
});
