/** TE 证书本地直接 PDF —— 纯逻辑测试（完整 PDF 由真实浏览器冒烟覆盖）。 */
"use strict";

const path = require("path");
const direct = require(path.join(__dirname, "..", "tools", "te-cert-generator", "cert-direct-pdf.js"));
const core = require(path.join(__dirname, "..", "tools", "te-cert-generator", "cert-core.js"));

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.error("  FAIL " + label + (detail ? " — " + detail : ""));
  }
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= (tolerance || 0.01);
}

console.log("TE 证书 · 本地直接 PDF 逻辑\n");

check("provider id 固定", direct.PROVIDER_ID === "local-direct", direct.PROVIDER_ID);
check("批量上限是正整数", Number.isInteger(direct.MAX_BATCH) && direct.MAX_BATCH > 0);
check("画布与证书背景同尺寸", direct.constants.canvas.width === 2572 && direct.constants.canvas.height === 1818);

const base = {
  key: "name",
  text: "姓名",
  spec: { left: 301.64, top: 238.79, width: 124.5, height: 66.7, size: 36, align: "center" },
};
const two = direct.resolveSlot(base, { name: "张三" }).spec;
const three = direct.resolveSlot(base, { name: "张小三" }).spec;
const four = direct.resolveSlot(base, { name: "欧阳娜娜" }).spec;
const five = direct.resolveSlot(base, { name: "阿布都热西" }).spec;

check("2 字姓名恢复模板原位置", near(two.left, 319.64) && near(two.width, 124.5), JSON.stringify(two));
check("3 字姓名使用校准基准", near(three.left, 301.64) && near(three.width, 124.5), JSON.stringify(three));
check("4 字姓名向左扩 36pt", near(four.left, 265.64) && near(four.width, 160.5), JSON.stringify(four));
check("5 字姓名继续向左扩", near(five.left, 229.64) && near(five.width, 196.5), JSON.stringify(five));
check(
  "3/4/5 字姓名框右边缘固定",
  near(three.left + three.width, four.left + four.width) &&
    near(four.left + four.width, five.left + five.width),
);

const general = core.printSlots(
  { name: "张小三", hospital: "南京鼓楼医院", year: "2026", month: "09", day: "23" },
  "general",
);
check("一般版输出 3 个动态槽位", general.slots.length === 3, String(general.slots.length));
check("日期文案与 DOCX 一致", general.slots[2].text === "颁发日期: 2026 年 09 月 23 日", general.slots[2].text);

const special = core.printSlots(
  { name: "张小三", hospital: "南京鼓楼医院", year: "2026", month: "09", day: "23" },
  "special",
);
check("特殊版多一个说明段落", special.slots.length === 4, String(special.slots.length));
check("特殊版说明保留 Word 的两行断点", special.slots[0].text.includes("理论\n及实际"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
