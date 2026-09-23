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
 * 用法: node tests/lint_te_cert_cloud.js
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
const certCloud = read("cert-cloud.js");
const certMerge = read("cert-merge.js");
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
check("页面引用了 cert-cloud.js", scripts.includes("./cert-cloud.js"), scripts.join(", "));
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

// cert-merge.js 刻意不加载：主路径不需要合并 PDF（合批一次拿回多页 PDF），
// 它只是"逐份转换后想再合成一本"时的备用工具，而那个功能尚未实现。
// 这条反向断言把「刻意不加载」这个决定固化下来，免得后人当成遗漏又加回去
// （加回去只是白费 10KB，但会让人误以为合并功能已经接上了）。
check(
  "cert-merge.js 刻意不从页面加载（备用工具，非主路径）",
  !scripts.includes("./cert-merge.js"),
  "有人把它加回页面了 —— 主路径不需要它，接上它会让人误以为合并功能可用",
);
check(
  "cert-merge.js 文件仍在（备用工具，别顺手删掉）",
  fs.existsSync(path.join(TOOL, "cert-merge.js")),
);

// app.js 用到的每个全局模块，页面都必须真的加载它。
// 漏一个的后果是静默的：初始化里那句 `if (!window.CertX) return;` 会让整个面板
// 不渲染，页面上没有报错，只是"那块功能不见了"。
// （在 DOM 冒烟测试的桩里踩过一次：没注入 CertAi 时 AI 面板整块不出现。）
const globalModules = [
  { global: "CertCore", file: "cert-core.js" },
  { global: "CertDirectPdf", file: "cert-direct-pdf.js" },
  { global: "CertCloud", file: "cert-cloud.js" },
  { global: "CertAi", file: "cert-ai.js" },
];
for (const item of globalModules) {
  const used = new RegExp("window\\.?" + item.global + "\\b|window\\[\"" + item.global + "\"\\]").test(appJs);
  check("app.js 用到了 " + item.global, used, "没用到就不用管加载，但通常意味着接线断了");
  if (used) {
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

// CSP 里写死的云服务域名必须与 cert-cloud.js **实际发起请求**的端点一致。
// 注意：必须先剥掉注释再提取 —— 否则注释里"曾经用过某端点"的记录会被当成
// 实际依赖，检查就变成了误报制造机（真踩过：把旧 IMS 端点写进注释后，
// 这条检查开始报「CSP 缺少 ims-na1.adobelogin.com」，而代码早就不用它了）。
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

const cloudHosts = hostsIn(certCloud);
const missingHosts = [...cloudHosts].filter((host) => !csp.includes(host));
check(
  "cert-cloud.js 实际用到的域名都在 CSP 白名单里",
  missingHosts.length === 0,
  "CSP 缺少: " + JSON.stringify(missingHosts),
);
check(
  "剥注释后仍提取到域名（防止正则把代码也剥没了）",
  cloudHosts.size >= 3,
  "只提取到 " + JSON.stringify([...cloudHosts]),
);

// AI 模块同理：它直连的端点也必须在 CSP 白名单里，否则浏览器直接拦掉请求。
// 这是"AI 解析根本发不出去"这类故障的第一嫌疑点。
const certAi = read("cert-ai.js");
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
check(
  "CSP 没有放开通配 https:（避免变成任意外发通道）",
  !/connect-src[^;]*\shttps:\s*;/.test(csp) && !/connect-src[^;]*\shttps:\*/.test(csp),
  csp,
);

/* ------------------------------------------------------- 3. 关键函数与导出 */

console.log("\n[3] 关键函数与导出");

check("app.js 有 generatePdf", /async function generatePdf\(/.test(appJs));
check("app.js 有 collectCloudCredentials", /function collectCloudCredentials\(/.test(appJs));
check("app.js 有 restoreCloudSettings", /function restoreCloudSettings\(/.test(appJs));
check("app.js 接入本地直接 PDF 模块", /window\.CertDirectPdf\.generateBatch/.test(appJs));
check("app.js 不再有打印预览残留", !/window\.print\(|printRoot/.test(appJs));

// cert-cloud 的导出必须覆盖 app.js 实际用到的接口。
// 用真实的模块导出对象来断言，而不是拿正则去抠源码 —— 源码里有嵌套的 `};`，
// 正则很容易截断，那样这个检查会变成「看起来在查、其实查不到」。
const cloudModule = require(path.join(TOOL, "cert-cloud.js"));
const directPdfModule = require(path.join(TOOL, "cert-direct-pdf.js"));
const mergeModule = require(path.join(TOOL, "cert-merge.js"));

for (const api of ["PROVIDER_ID", "MAX_BATCH", "generateBatch", "resolveSlot"]) {
  check("cert-direct-pdf 导出 " + api, typeof directPdfModule[api] !== "undefined", "实际类型: " + typeof directPdfModule[api]);
}

for (const api of ["PROVIDERS", "MAX_BATCH", "getProvider", "convertBatch", "buildBatchDocx", "repackWithDocumentXml"]) {
  check("cert-cloud 导出 " + api, typeof cloudModule[api] !== "undefined", "实际类型: " + typeof cloudModule[api]);
}

for (const api of ["mergePdfs", "countPages", "inspect"]) {
  check("cert-merge 导出 " + api, typeof mergeModule[api] !== "undefined", "实际类型: " + typeof mergeModule[api]);
}

// app.js 真的会调用这些函数 —— 只导出不调用也是一种断线
for (const call of [
  "window.CertCloud.getProvider",
  "window.CertCloud.convertBatch",
  "window.CertCloud.PROVIDERS",
  "window.CertCloud.MAX_BATCH",
]) {
  check("app.js 调用了 " + call, appJs.includes(call));
}

check("PROVIDERS 至少有 3 个服务商", cloudModule.PROVIDERS.length >= 3, "实际 " + cloudModule.PROVIDERS.length + " 个");
check(
  "每个服务商都有 id / label / convert / credential",
  cloudModule.PROVIDERS.every(
    (p) => p.id && p.label && typeof p.convert === "function" && p.credential && p.credential.key,
  ),
  JSON.stringify(cloudModule.PROVIDERS.map((p) => p.id)),
);

// 凭据字段名必须与 convert() 解构的形参一致，否则会带着 undefined 去发请求
for (const provider of cloudModule.PROVIDERS) {
  const spec = provider.credential;
  const names = spec.fields
    ? spec.fields.map((f) => f.name)
    : [spec.key];
  const source = provider.convert.toString();
  const missing = names.filter((name) => !new RegExp("\\b" + name + "\\b").test(source));
  check(
    provider.id + " 的凭据字段名出现在 convert() 里",
    missing.length === 0,
    "字段 " + JSON.stringify(missing) + " 在 convert() 中找不到同名形参",
  );
}

/* --------------------------------------------------------- 4. 隐私文案一致性 */

console.log("\n[4] 隐私说明不能自相矛盾");

check(
  "本地直接生成明确说明不联网",
  /完全离线|不联网/.test(indexHtml) && /不会发出网络请求|完全本地处理/.test(appJs),
);
check(
  "页面明确提示会外发给所选服务",
  /发送给|会发送|外发/.test(indexHtml) || /发送给|外发/.test(appJs),
);
check(
  "默认不选择任何 PDF 生成方式",
  /cloudProvider:\s*""/.test(appJs) && /none\.value = ""/.test(appJs),
  "默认不能预选本地或云端方式",
);
check(
  "代码里有「密钥只存本机」的说明",
  /仅本机|只存本机|保存在本机/.test(appJs) || /仅本机/.test(indexHtml),
);

/* --------------------------------------------------------------- 5. 样式 */

console.log("\n[5] 新增样式存在");

for (const cls of [".cloud-block", ".cloud-select", ".cloud-field", ".cloud-note", ".cloud-help"]) {
  check("styles.css 有 " + cls, styles.includes(cls + " ") || styles.includes(cls + ",") || styles.includes(cls + "{") || new RegExp(cls.replace(".", "\\.") + "\\s*\\{").test(styles));
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
  const match = source.match(/base64: '([\s\S]*?)',\n\};/);
  if (!match) {
    check("能解析载荷 " + pair.payload, false);
    continue;
  }
  const decoded = Buffer.from(match[1].replace(/' \+\n  '/g, ""), "base64");
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

/* ------------------------------------------------ 5. 云请求头不能超出预检白名单 */

console.log("\n[5b] 发往云服务的自定义请求头必须在各端点的预检白名单内");

// 为什么需要这条：浏览器会对任何非「简单请求头」触发预检，预检没过浏览器直接拦掉，
// 请求根本到不了服务端。而 **Node 的 fetch 不做预检**，所以这类问题在 Node 侧
// 探测、单元测试里全都看不见 —— 只有真实浏览器会炸。
// 踩过的坑：给 Adobe 的 /operation/createpdf 带了 x-request-id，
// 浏览器报 "Request header field x-request-id is not allowed by
// Access-Control-Allow-Headers in preflight response"。
//
// 实测（2026-09）各端点被允许的自定义头：
//   Adobe /token、/assets、/operation/createpdf:
//     Authorization, Content-Type, X-Api-Key, User-Agent, If-Modified-Since, x-api-app-info
//   （注意 /assets 与 /token 不含 x-api-app-info，这里取交集之上的保守集合）
//   ConvertAPI: content-type, content-disposition, origin, accept, authorization
//   CloudConvert: *（通配）
const ADOBE_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "x-api-key",
  "user-agent",
  "if-modified-since",
];

// 「简单请求头」不需要预检，永远安全
const SAFE_HEADERS = ["accept", "accept-language", "content-language", "content-type", "range"];

/** 从请求头字面量里取出头名（小写）。 */
function headerNamesIn(source) {
  const names = new Set();
  // { "Content-Type": ..., Authorization: ..., "x-api-key": ... }
  const re = /["']?([A-Za-z][A-Za-z0-9-]*)["']?\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1].toLowerCase();
    // 排除对象字面量里的常规键名与错误信息片段
    if (/^(https?|origin|location|body|graphql)$/.test(name)) continue;
    names.add(name);
  }
  return names;
}

const adobeBlock = certCloud.match(/const adobe = \{[\s\S]*?\n  \};/);
check("能定位到 adobe 适配器", Boolean(adobeBlock));

if (adobeBlock) {
  const offender = [];
  for (const name of headerNamesIn(adobeBlock[0])) {
    if (SAFE_HEADERS.includes(name)) continue;
    if (ADOBE_ALLOWED_HEADERS.includes(name)) continue;
    // 只关心看起来像请求头的键（含连字符或以 x- 开头）
    if (name.includes("-") || name.startsWith("x")) offender.push(name);
  }
  check(
    "Adobe 请求里没有超出预检白名单的头",
    offender.length === 0,
    "发现: " + JSON.stringify(offender) +
      " —— 浏览器预检会拦掉，且 Node 侧测不出来",
  );
  check(
    "Adobe 用的自定义头都在白名单内（反向确认检查不是空转）",
    [...headerNamesIn(adobeBlock[0])].some((n) => n === "x-api-key"),
    "连 x-api-key 都没扫到，说明扫描逻辑失效了",
  );
}

check(
  "已移除 randomId（原先只用于那个被禁止的 x-request-id）",
  !/function randomId\(/.test(certCloud),
  "留着会诱导后人再次把它加进请求头",
);

/* ------------------------------------------------------------------ 结果 */

console.log("\n" + "=".repeat(70));
console.log("通过 " + passed + " 项，失败 " + failures.length + " 项。");
if (failures.length) {
  failures.forEach((item) => console.log("  - " + item));
  process.exit(1);
}
