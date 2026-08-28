const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../settlement-core");

test("严格校验日期并支持闰年", () => {
  assert.ok(core.parseDate("2024-02-29"));
  assert.equal(core.parseDate("2025-02-29"), null);
  assert.equal(core.parseDate("2026-02-30"), null);
});

test("月底日期进入下一个结算月且不会跳月", () => {
  assert.equal(core.settlementMonthForDate(core.parseDate("2025-01-31")), "202502");
  assert.equal(core.settlementMonthForDate(core.parseDate("2025-08-31")), "202509");
  assert.equal(core.settlementMonthForDate(core.parseDate("2025-12-26")), "202601");
});

test("空行不影响错误信息的真实行号", () => {
  const parsed = core.parsePeople("张三：2026-01-01到2026-01-02 10000\n\n错误数据");
  assert.equal(parsed.rows.length, 1);
  assert.match(parsed.errors[0], /^第 3 行/);
});

test("人员单价必须有效、为正、最多两位小数且有上限", () => {
  assert.equal(core.parsePeople("甲：2026-01-01到2026-01-02 123.45").rows[0].priceCents, 12345);
  for (const price of ["0", "1.234", "Infinity", "10000000.01"]) {
    assert.equal(core.parsePeople(`甲：2026-01-01到2026-01-02 ${price}`).rows.length, 0);
  }
});

test("按分计算每日折算费用", () => {
  assert.equal(core.calculateProratedFeeCents(1900000, 1, 3), 633333);
  assert.equal(core.calculateProratedFeeCents(1900000, 2, 3), 1266667);
  assert.equal(core.calculateProratedFeeCents(1900000, 0, 0), 0);
});

test("工作日计算识别法定假日和调休", () => {
  const holidays = new Set(["2026-01-01"]);
  const makeupDays = new Set(["2026-01-04"]);
  const start = core.parseDate("2026-01-01");
  const end = core.parseDate("2026-01-05");
  assert.equal(core.countWorkdays(start, end, holidays, makeupDays), 3);
});

test("按结算月份输出可复制文本并保留人员顺序", () => {
  const input = `刘洋：2026-07-21到2026-10-25 20500
张福宇：2026-07-27到2026-10-25 20500
王恩光：2026-08-03到2026-10-25 23500
刘辉：2026-07-28到2026-10-25 20500
王南龙：2026-08-18到2026-10-25 20500`;
  const holidays = new Set();
  const makeupDays = new Set();
  const expected = `7月（总费用：3904.76元）：
刘洋：2026-07-21到2026-07-25 20500

8月（总费用：84318.18元）：
刘洋：2026-07-26到2026-08-25 20500
张福宇：2026-07-27到2026-08-25 20500
王恩光：2026-08-03到2026-08-25 23500
刘辉：2026-07-28到2026-08-25 20500
王南龙：2026-08-18到2026-08-25 20500

9月（总费用：105500.00元）：
刘洋：2026-08-26到2026-09-25 20500
张福宇：2026-08-26到2026-09-25 20500
王恩光：2026-08-26到2026-09-25 23500
刘辉：2026-08-26到2026-09-25 20500
王南龙：2026-08-26到2026-09-25 20500

10月（总费用：105500.00元）：
刘洋：2026-09-26到2026-10-25 20500
张福宇：2026-09-26到2026-10-25 20500
王恩光：2026-09-26到2026-10-25 23500
刘辉：2026-09-26到2026-10-25 20500
王南龙：2026-09-26到2026-10-25 20500`;
  const result = core.buildMonthlySettlementText(input, holidays, makeupDays);
  assert.equal(result.monthCount, 4);
  assert.equal(result.text, expected);
});

test("跨年按月文本标题包含年份以避免同月混淆", () => {
  const result = core.buildMonthlySettlementText("甲：2025-12-20到2026-01-26 10000");
  assert.match(result.text, /^2025年12月（总费用：/);
  assert.match(result.text, /2026年1月（总费用：/);
});

test("费用拆分保持总费用完全一致", () => {
  for (const yuan of [300000, 500000, 1000000, 100000000]) {
    const totalCents = yuan * 100;
    const split = core.findFrameworkSplit(totalCents, {}, Infinity, 0.42);
    assert.ok(split, `应能拆分 ${yuan} 元`);
    assert.equal(14500 * split.p2 + 17000 * split.p31 + 19000 * split.p32, totalCents);
  }
});

test("费用拆分支持手动固定值并拒绝非5元整数倍", () => {
  const original = core.findFrameworkSplit(30000000, {}, Infinity, 0.42);
  const fixed = core.findFrameworkSplit(30000000, { p2: original.p2 }, Infinity, 0.7);
  assert.ok(fixed);
  assert.equal(fixed.p2, original.p2);
  assert.equal(core.findFrameworkSplit(30000123), null);
});
