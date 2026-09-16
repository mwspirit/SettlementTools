const test = require("node:test");
const assert = require("node:assert/strict");
const xlsx = require("../xlsx-export");

test("生成的工作簿具有 XLSX ZIP 结构和必要部件", () => {
  const bytes = xlsx.buildWorkbook([{
    name: "测试&明细",
    widths: [12, 16],
    rows: [
      [{ value: "姓名", style: 1 }, { value: "金额", style: 1 }],
      [{ value: "张三" }, { value: 123.45, type: "number", style: 2 }]
    ]
  }]);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("hex"), "504b0304");
  const binary = Buffer.from(bytes).toString("latin1");
  for (const name of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(binary.includes(name), `应包含 ${name}`);
  }
});

test("工作簿支持带缓存值的 Excel 公式", () => {
  const bytes = xlsx.buildWorkbook([{
    name: "公式测试",
    rows: [[
      { value: 123.45, type: "formula", formula: "ROUND(C2*D2,2)", style: 2 }
    ]]
  }]);
  const binary = Buffer.from(bytes).toString("utf8");
  assert.ok(binary.includes("<f>ROUND(C2*D2,2)</f><v>123.45</v>"));
});
