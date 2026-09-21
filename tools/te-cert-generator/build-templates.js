/**
 * 把两个 docx 模板编译成「base64 载荷模块」。
 *
 * 为什么需要它：
 *   双击本地 HTML 打开时（file:// 协议），页面无法 fetch 同目录的 docx ——
 *   Chromium 对 file:// 的 fetch 一律拒绝（TypeError: Failed to fetch），
 *   加 --allow-file-access-from-files、放开 CSP 的 connect-src 都不管用。
 *   但 <script src="本地文件"> 是允许的。
 *   所以把模板字节 base64 后放进 .js，用 <script> 标签按需加载，两种协议下都能用。
 *
 * 生成的文件必须与 docx 保持同步：改了模板就重新跑这个脚本。
 * tests/lint_te_cert_generator_wiring.js 会核对两者是否一致。
 *
 * 用法： node tools/te-cert-generator/build-templates.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PAIRS = [
  { source: "template-general.docx", target: "template-general.b64.js", global: "CERT_TEMPLATE_GENERAL" },
  { source: "template-special.docx", target: "template-special.b64.js", global: "CERT_TEMPLATE_SPECIAL" },
];

/** base64 字符集里不含 </，所以直接放进单引号字符串是安全的。 */
function encode(bytes) {
  return bytes.toString("base64").replace(/(.{120})/g, "$1' +\n  '");
}

PAIRS.forEach(({ source, target, global }) => {
  const sourcePath = path.join(DIR, source);
  if (!fs.existsSync(sourcePath)) {
    console.error("缺少模板文件：" + source);
    process.exit(1);
  }
  const bytes = fs.readFileSync(sourcePath);
  const body = [
    "/* 由 build-templates.js 生成，请勿手改。",
    ` * 源文件：${source}（${bytes.length} 字节，sha256 见文件末尾）`,
    " * 重新生成： node tools/te-cert-generator/build-templates.js",
    " */",
    `window.${global} = {`,
    `  source: '${source}',`,
    `  bytes: ${bytes.length},`,
    `  base64: '${encode(bytes)}',`,
    "};",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(DIR, target), body, "utf8");
  const size = fs.statSync(path.join(DIR, target)).size;
  console.log(`${target}  ← ${source}  (${bytes.length} → ${size} 字节)`);
});

const crypto = require("crypto");
console.log("\n源文件指纹：");
PAIRS.forEach(({ source }) => {
  const bytes = fs.readFileSync(path.join(DIR, source));
  console.log(`  ${source}  sha256=${crypto.createHash("sha256").update(bytes).digest("hex")}`);
});
