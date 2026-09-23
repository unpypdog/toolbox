/**
 * TE 证书工具的接线检查（纯 Node，不需要浏览器）。
 *
 * 存在的理由：这个工具踩过好几次「不打开浏览器就发现不了」的坑 ——
 *   - app.js 引用了 HTML 上没有的 id（`fileDropLabel`），bindEvents 抛错中断，
 *     后面所有监听一个都没绑上，9 个功能静默失效
 *   - CSP 里 img-src 漏了 blob:，背景图被静默拦掉，页面只剩文字
 *   - 定义了函数却忘了加进导出对象（extractImage），调用处拿到 undefined
 * 这些都不需要浏览器就能查，所以固化成检查项，改完先跑它。
 *
 * 用法: node tests/lint_te_cert_generator.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "te-cert-generator");

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok   " + name);
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function read(file) {
  return fs.readFileSync(path.join(TOOL, file), "utf8");
}

const appJs = read("app.js");
const indexHtml = read("index.html");
const certCore = read("cert-core.js");
const certDirect = read("cert-direct-pdf.js");
const certAi = read("cert-ai.js");
const styles = read("styles.css");

console.log("TE 证书工具接线检查\n");

/* ------------------------------------------------------- 1. 元素 id 一致性 */

console.log("[1] app.js 用到的 id 都在 HTML 上存在");

// 从 DOMContentLoaded 的 id 列表里取出声明的元素
const declaredBlock = appJs.match(/\[\s*\n([\s\S]*?)\]\.forEach\(\(id\) => \{\s*\n\s*els\[id\] = document\.getElementById\(id\)/);
const declared = new Set();
if (declaredBlock) {
  (declaredBlock[1].match(/"([^"]+)"/g) || []).forEach((token) => {
    declared.add(token.replace(/"/g, ""));
  });
}
check("解析出 els 声明列表", declared.size > 20, "只解析到 " + declared.size + " 个");

const used = new Set();
const useRe = /els\.([A-Za-z_$][\w$]*)/g;
let match;
while ((match = useRe.exec(appJs)) !== null) used.add(match[1]);

const undeclared = [...used].filter((id) => !declared.has(id));
check(
  "每个 els.<名字> 都在列表里声明过",
  undeclared.length === 0,
  "未声明却被使用: " + JSON.stringify(undeclared),
);

const htmlIds = new Set((indexHtml.match(/\bid="([^"]+)"/g) || []).map((t) => t.replace(/id="|"/g, "")));
const missingInHtml = [...declared].filter((id) => !htmlIds.has(id));
check(
  "声明的 id 在 HTML 上都能找到",
  missingInHtml.length === 0,
  "HTML 里没有: " + JSON.stringify(missingInHtml),
);

const declaredButUnused = [...declared].filter((id) => !used.has(id));
check(
  "声明了却没用的死条目（提示用，不阻断）",
  true,
  declaredButUnused.length ? "未使用: " + JSON.stringify(declaredButUnused) : "",
);

/* ------------------------------------------------------------- 2. 脚本与 CSP */

console.log("\n[2] 脚本引用与 CSP");

const scripts = (indexHtml.match(/<script[^>]*src="([^"]+)"/g) || []).map((t) =>
  t.replace(/.*src="|"/g, ""),
);
check("页面引用了 cert-ai.js", scripts.includes("./cert-ai.js"), scripts.join(", "));
check("页面引用了本地直接 PDF 模块", scripts.includes("./cert-direct-pdf.js"), scripts.join(", "));
check("页面从本地 vendor 加载 pdf-lib", scripts.includes("./vendor/pdf-lib.min.js"), scripts.join(", "));
check(
  "pdf-lib 的 MIT 许可证随 vendor 文件保留",
  fs.existsSync(path.join(TOOL, "vendor", "pdf-lib.LICENSE.md")),
);
check(
  "已移除旧的 cert-pdf.js 引用",
  !scripts.includes("./cert-pdf.js"),
  "还在引用已删除的 cert-pdf.js",
);

// 云端 DOCX→PDF 路径已整块移除。这四条是**反向断言**：
// 残留的 <script src> 只会 404（页面上不报错，只是"功能不见了"），
// 而 CSP 里留着已不存在的服务商域名则是个无声的外发口子。
// 删干净之后把它们钉住，免得有人照着旧文档又接回来。
for (const file of ["cert-cloud.js", "cert-merge.js"]) {
  check(
    file + " 刻意不存在（云端路径已移除）",
    !scripts.includes("./" + file) && !fs.existsSync(path.join(TOOL, file)),
    "文件或页面引用又回来了 —— 本工具现在只走本地直接 PDF",
  );
}

// app.js 用到的每个全局模块，页面都必须真的加载它。
// 漏一个的后果是静默的：初始化里那句 `if (!window.CertX) return;` 会让整个面板
// 不渲染，页面上没有报错，只是"那块功能不见了"。
// （在 DOM 冒烟测试的桩里踩过一次：没注入 CertAi 时 AI 面板整块不出现。）
const globalModules = [
  { global: "CertCore", file: "cert-core.js" },
  { global: "CertDirectPdf", file: "cert-direct-pdf.js" },
  { global: "CertAi", file: "cert-ai.js" },
];
for (const item of globalModules) {
  const uses = new RegExp("window\\.?" + item.global + "\\b|window\\[\"" + item.global + "\"\\]").test(appJs);
  check("app.js 用到了 " + item.global, uses, "没用到就不用管加载，但通常意味着接线断了");
  if (uses) {
    check(
      "页面加载了 " + item.file + "（否则 " + item.global + " 相关面板会静默不渲染）",
      scripts.includes("./" + item.file),
      "app.js 在用 " + item.global + "，但 index.html 没有 <script src=\"./" + item.file + "\">",
    );
  }
}

for (const src of scripts) {
  const file = src.replace("./", "");
  check("脚本文件存在: " + file, fs.existsSync(path.join(TOOL, file)));
}

const csp = (indexHtml.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/) || [])[1] || "";
check("CSP 存在", Boolean(csp));
check("CSP 放行 file:（读本地模板需要）", /connect-src[^;]*file:/.test(csp), csp);
check("CSP 放行 blob:（背景图需要）", /img-src[^;]*blob:/.test(csp), csp);
check(
  "CSP 放行 data:（图标与内联背景图需要）",
  /img-src[^;]*data:/.test(csp),
  csp,
);

// 证书生成本身一个网络请求都不发，所以 connect-src 里除了本地与 AI 之外不该有别的。
const connectDirective = (csp.match(/connect-src([^;]*)/) || [])[1] || "";
const connectHosts = (connectDirective.match(/https:\/\/[a-z0-9.-]+/g) || []);
check(
  "connect-src 只放行 AI 解析这一个远程域名",
  connectHosts.length === 1 && connectHosts[0] === "https://api.deepseek.com",
  "实际: " + JSON.stringify(connectHosts),
);

// 注释里绝不能残留旧域名：CSP 是白名单，注释里的记录容易被后人当成"还需要它"。
// 真踩过：把旧 IMS 端点写进注释后，一条检查开始报「CSP 缺少 ims-na1.adobelogin.com」，
// 而代码早就不用它了。
for (const host of ["convertapi", "cloudconvert", "adobe", "amazonaws", "adobelogin"]) {
  check(
    "index.html 里不再出现 " + host,
    !indexHtml.toLowerCase().includes(host),
    "云端服务商的残留引用（CSP、注释、文案都算）",
  );
}
check(
  "CSP 没有放开通配 https:（避免变成任意外发通道）",
  !/connect-src[^;]*\shttps:\s*;/.test(csp) && !/connect-src[^;]*\shttps:\*/.test(csp),
  csp,
);

// AI 模块直连的端点也必须在 CSP 白名单里，否则浏览器直接拦掉请求。
// 这是"AI 解析根本发不出去"这类故障的第一嫌疑点。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "); // 行注释（避免误伤 https://）
}

function hostsIn(source) {
  return new Set(
    (stripComments(source).match(/https:\/\/[a-z0-9.-]+/g) || []).map((u) => new URL(u).host),
  );
}

const aiHosts = hostsIn(certAi);
const missingAiHosts = [...aiHosts].filter((host) => !csp.includes(host));
check(
  "cert-ai.js 实际用到的域名都在 CSP 白名单里",
  missingAiHosts.length === 0,
  "CSP 缺少: " + JSON.stringify(missingAiHosts) + " —— AI 请求会被浏览器直接拦掉",
);
check(
  "cert-ai.js 确实声明了直连端点",
  aiHosts.size >= 1,
  "一个域名都没提取到，检查等于空转",
);

/* ------------------------------------------------------- 3. 关键函数与导出 */

console.log("\n[3] 关键函数与导出");

check("app.js 有 generatePdf", /async function generatePdf\(/.test(appJs));
check("app.js 接入本地直接 PDF 模块", /window\.CertDirectPdf\.generateBatch/.test(appJs));
check("app.js 不再有打印预览残留", !/window\.print\(|printRoot/.test(appJs));

const coreModule = require(path.join(TOOL, "cert-core.js"));
const directPdfModule = require(path.join(TOOL, "cert-direct-pdf.js"));

for (const api of ["PROVIDER_ID", "MAX_BATCH", "generateBatch", "resolveSlot"]) {
  check("cert-direct-pdf 导出 " + api, typeof directPdfModule[api] !== "undefined", "实际类型: " + typeof directPdfModule[api]);
}

// cert-core 在移除云端路径后只剩「数据 + 版式 + 模板读取」三类能力。
// DOCX 生成器的导出必须消失 —— 留着它，将来很容易有人顺手接回某条路径。
for (const api of ["printSlots", "extractImage", "assertTemplate", "readZip", "writeZip", "validateRecord", "renderFileName"]) {
  check("cert-core 导出 " + api, typeof coreModule[api] !== "undefined", "实际类型: " + typeof coreModule[api]);
}
for (const api of ["buildDocx", "fillDocumentXml", "escapeXml", "constants"]) {
  check(
    "cert-core 不再导出 " + api + "（只服务于已移除的云端 DOCX 路径）",
    typeof coreModule[api] === "undefined",
    "实际类型: " + typeof coreModule[api],
  );
}

// app.js 真的会调用这些函数 —— 只导出不调用也是一种断线
for (const call of [
  "window.CertDirectPdf.generateBatch",
  "window.CertDirectPdf.MAX_BATCH",
  "window.CertCore.printSlots",
  "window.CertCore.extractImage",
  "window.CertCore.writeZip",
]) {
  const reachable = appJs.includes(call) || certDirect.includes(call.replace("window.CertCore.", "options.core."));
  check("真的会走到 " + call, reachable, "没有调用点，导出等于死代码");
}
check(
  "app.js 不再构造 DOCX（buildCertificateItems 已随云端路径删除）",
  !/buildDocx|buildCertificateItems|documentXml/.test(appJs),
  "残留的 DOCX 构造代码没有任何消费方",
);

/* --------------------------------------------------------- 4. 隐私文案一致性 */

console.log("\n[4] 隐私说明不能自相矛盾");

check(
  "页面明确说明生成过程不联网",
  /零网络请求|不上传任何内容|不发任何网络请求/.test(indexHtml) &&
    /零网络|不上传任何内容|不发任何网络请求/.test(appJs + certDirect),
  "证书生成路径必须写明本机完成",
);
check(
  "AI 外发提示仍在（AI 是唯一的联网路径）",
  /发给该服务|发送给/.test(indexHtml) && /发送给/.test(appJs),
  "AI 面板必须讲清楚名单会外发给所选服务",
);
check(
  "默认不启用 AI",
  /aiProvider:\s*""/.test(appJs) && /none\.value = ""/.test(appJs),
  "默认不能预选任何会外发数据的服务",
);
check(
  "代码里有「密钥只存本机」的说明",
  /仅本机|只存本机|保存在本机/.test(appJs),
);

/* --------------------------------------------------------------- 5. 样式 */

console.log("\n[5] 新增样式存在");

// 这些类名是 AI 面板与「生成方式」说明共用的表单样式。
// 注意：云端路径移除后它们**不再叫 cloud-*** —— 名字里带 cloud 会误导后人以为还有云转换。
for (const cls of [".generate-block", ".generate-title", ".service-select", ".service-field", ".service-help", ".service-note"]) {
  check(
    "styles.css 有 " + cls,
    new RegExp(cls.replace(".", "\\.") + "\\s*[,{]").test(styles),
    "类名不存在会让对应区块掉样式",
  );
}
for (const cls of [".cloud-block", ".cloud-title", ".cloud-select", ".cloud-field", ".cloud-note"]) {
  check("styles.css 不再有 " + cls, !new RegExp(cls.replace(".", "\\.") + "\\s*[,{]").test(styles));
}

/* ------------------------------------------------- 6. base64 载荷与模板同步 */

console.log("\n[6] base64 模板载荷与 docx 必须字节一致");

// 为什么必须有这条：file:// 下 fetch 读不到同目录的 docx（Chromium 直接拒绝），
// 所以模板是以 base64 载荷的形式用 <script src> 加载的。改了 docx 却忘了重跑
// build-templates.js，工具就会静默用旧模板生成证书 —— 没有任何报错。
// 这条检查是纯 Node 的，不依赖浏览器。
const crypto = require("crypto");

const payloadPairs = [
  { docx: "template-general.docx", payload: "template-general.b64.js", global: "CERT_TEMPLATE_GENERAL" },
  { docx: "template-special.docx", payload: "template-special.b64.js", global: "CERT_TEMPLATE_SPECIAL" },
];

for (const pair of payloadPairs) {
  const docxPath = path.join(TOOL, pair.docx);
  const payloadPath = path.join(TOOL, pair.payload);
  if (!fs.existsSync(payloadPath)) {
    check("载荷存在: " + pair.payload, false, "缺文件，file:// 下模板将无法加载");
    continue;
  }
  const source = fs.readFileSync(payloadPath, "utf8");
  const payloadMatch = source.match(/base64: '([\s\S]*?)',\n\};/);
  if (!payloadMatch) {
    check("能解析载荷 " + pair.payload, false);
    continue;
  }
  const decoded = Buffer.from(payloadMatch[1].replace(/' \+\n  '/g, ""), "base64");
  const real = fs.readFileSync(docxPath);
  const same = decoded.length === real.length && decoded.equals(real);
  check(
    pair.payload + " 与 " + pair.docx + " 字节一致",
    same,
    same ? "" : `载荷 ${decoded.length} 字节 / 文件 ${real.length} 字节 —— 请重跑 node tools/te-cert-generator/build-templates.js`,
  );
  check(
    pair.payload + " 暴露的全局名是 " + pair.global,
    source.includes("window." + pair.global + " ="),
  );
  check(
    pair.payload + " 与 docx 的 sha256 一致",
    crypto.createHash("sha256").update(decoded).digest("hex") ===
      crypto.createHash("sha256").update(real).digest("hex"),
  );
}

// app.js 的模板加载器要指向真实存在的载荷与全局名
const loadersBlock = appJs.match(/TEMPLATE_LOADERS\s*=\s*\{([\s\S]*?)\};/);
check("app.js 里有 TEMPLATE_LOADERS", Boolean(loadersBlock));
if (loadersBlock) {
  for (const pair of payloadPairs) {
    check("TEMPLATE_LOADERS 引用了 " + pair.payload, loadersBlock[1].includes(pair.payload));
    check("TEMPLATE_LOADERS 引用了 " + pair.global, loadersBlock[1].includes(pair.global));
  }
}

// 模板现在只作为背景图载体。assertTemplate 必须查的是背景图，而不是 document.xml ——
// 查错了会在"模板没有 media"时放过它，直到更深处才炸，错误信息也更难懂。
check(
  "assertTemplate 查的是背景图而不是 word/document.xml",
  /word\/media\//.test(certCore) && /assertTemplate[\s\S]{0,600}word\/media\//.test(certCore),
  "模板只作为背景图载体，校验目标要跟着变",
);
check(
  "cert-core 里不再出现 document.xml（注释除外）",
  !/word\/document\.xml/.test(stripComments(certCore)),
  "DOCX 生成器已删除，不该再读这个部件 —— 注释里保留历史说明是允许的",
);

/* ------------------------------------------------------------------ 结果 */

console.log("\n" + "=".repeat(70));
console.log("通过 " + passed + " 项，失败 " + failures.length + " 项。");
if (failures.length) {
  failures.forEach((item) => console.log("  - " + item));
  process.exit(1);
}
