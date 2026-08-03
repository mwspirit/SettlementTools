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

  function findFrameworkSplit(totalCents, fixedHundredths = {}, maxLimitHundredths = Infinity, seed = 0.5) {
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
      const penalty = (p31Share >= 0.6 && p31Share <= 0.95 ? 0 : 1000)
        + ((x > 0 ? 0 : 1) + (z > 0 ? 0 : 1)) * 100;
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
    parseMonthHundredths,
    findFrameworkSplit
  };
});
