/**
 * TE 证书工具 —— DOM 冒烟测试（纯 Node，无浏览器）。
 *
 * 为什么需要它：
 *   静态检查能确认 id 存在、导出齐全，但**证明不了页面初始化不抛异常**。
 *   这个工具真出过一次：app.js 引用了 HTML 上不存在的 id，
 *   bindEvents() 执行到那一行就中断，后面所有监听一个都没绑上，
 *   9 个功能静默失效 —— 页面上没有任何报错，只有点了没反应。
 *
 * 做法：用一个极小的 DOM 桩把 app.js 真正跑起来，然后断言：
 *   - DOMContentLoaded 处理完不抛错
 *   - 生成方式面板不再需要"选服务商"（云端路径已移除，只有本地一条路）
 *   - 页面上不存在任何密钥输入框（生成证书不需要任何凭据）
 *   - refreshButtons 的行为符合预期
 *   - AI 面板该渲染的仍然渲染
 *
 * 这是桩，不是真实浏览器。它验证不了布局与渲染，
 * 但能拦住「初始化就崩」这类最贵的问题。
 *
 * 用法: node tests/test_te_cert_dom_smoke.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TOOL = path.join(__dirname, "..", "tools", "te-cert-generator");

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

/* ------------------------------------------------------------- 极简 DOM 桩 */

function makeElement(id) {
  const listeners = new Map();
  const children = [];
  let text = "";
  const classSet = new Set();

  const element = {
    id: id || "",
    tagName: "DIV",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    type: "",
    dataset: {},
    style: {},
    children: children,
    parentNode: null,
    // 真实 DOM 的 classList 每个元素都有。桩里缺它会让被测代码直接抛
    // 「Cannot read properties of undefined」——那是桩的缺陷，不是代码的 bug。
    classList: {
      add: (...names) => names.forEach((name) => classSet.add(name)),
      remove: (...names) => names.forEach((name) => classSet.delete(name)),
      contains: (name) => classSet.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classSet.has(name) : Boolean(force);
        if (on) classSet.add(name);
        else classSet.delete(name);
        return on;
      },
    },
    get className() {
      return Array.from(classSet).join(" ");
    },
    set className(value) {
      classSet.clear();
      String(value || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classSet.add(name));
    },
    // 真实 DOM 里给 textContent 赋值会清空所有子节点（文本替换元素内容）。
    // 桩如果把它当普通属性，清空操作就失效，会掩盖真实的时序 bug ——
    // 这里必须按规范语义实现。
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value === undefined || value === null ? "" : String(value);
      children.length = 0;
    },
    set innerHTML(value) {
      text = value === undefined || value === null ? "" : String(value);
      children.length = 0;
    },
    get innerHTML() {
      return text;
    },
    appendChild(child) {
      child.parentNode = element;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    remove() {
      if (element.parentNode) element.parentNode.removeChild(element);
    },
    insertBefore(child) {
      return element.appendChild(child);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      (listeners.get(type) || []).forEach((handler) => handler(event || { type: type }));
    },
    hasListener(type) {
      return (listeners.get(type) || []).length > 0;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      // 真实 querySelectorAll 查的是**所有后代**，不只是直接子元素。
      // AI 输入框嵌在 <label> 里（div > label > input），只看直接子元素会查不到，
      // 那时失败反映的是桩的缺陷而不是被测代码有问题。
      if (selector !== "[data-ai-field]") return [];
      const found = [];
      const walk = (node) => {
        node.children.forEach((child) => {
          if (child.dataset && child.dataset.aiField) found.push(child);
          walk(child);
        });
      };
      walk(element);
      return found;
    },
    focus() {},
    click() {
      element.dispatch("click", { type: "click" });
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
  return element;
}

/** 读取 index.html 上的 id，为每个 id 建一个元素，其余查询返回 null。 */
function buildDocument(html) {
  const ids = new Set((html.match(/\bid="([^"]+)"/g) || []).map((t) => t.replace(/id="|"/g, "")));
  const registry = new Map();
  ids.forEach((id) => registry.set(id, makeElement(id)));

  const body = makeElement("__body");
  const documentElement = makeElement("__html");
  const listeners = new Map();

  const document = {
    documentElement: documentElement,
    body: body,
    getElementById(id) {
      return registry.get(id) || null;
    },
    createElement(tag) {
      const element = makeElement("");
      element.tagName = String(tag).toUpperCase();
      return element;
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text, parentNode: null };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    dispatch(type) {
      (listeners.get(type) || []).forEach((handler) => handler({ type: type }));
    },
  };

  return { document: document, registry: registry };
}

/* ---------------------------------------------------------------- 加载 app.js */

function loadApp() {
  const html = fs.readFileSync(path.join(TOOL, "index.html"), "utf8");
  const { document, registry } = buildDocument(html);

  const errors = [];
  const sandbox = {
    document: document,
    window: null,
    console: {
      log: () => {},
      warn: (...args) => errors.push("warn: " + args.join(" ")),
      error: (...args) => errors.push("error: " + args.join(" ")),
    },
    localStorage: {
      _data: {},
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null;
      },
      setItem(key, value) {
        this._data[key] = String(value);
      },
      removeItem(key) {
        delete this._data[key];
      },
    },
    // FileReader 桩：AI 图片读取要用。回调立即触发，模拟读成功。
    FileReader: function FileReader() {
      this.result = null;
      this.onload = null;
      this.onerror = null;
      this.readAsDataURL = () => {
        this.result = "data:image/jpeg;base64,AAAA";
        if (this.onload) this.onload();
      };
    },
    setTimeout: (fn) => {
      if (typeof fn === "function") fn();
      return 0;
    },
    clearTimeout: () => {},
    Blob: function Blob(parts, options) {
      this.parts = parts;
      this.type = (options && options.type) || "";
      this.size = 0;
    },
    URL: {
      createObjectURL: () => "blob:stub",
      revokeObjectURL: () => {},
    },
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    AbortController: AbortController,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    Error: Error,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  // 最小 CertCore / CertDirectPdf / CertAi 替身：只保留 app.js 初始化路径会碰到的部分。
  //
  // 注意这里不能省命名相关的成员：DOMContentLoaded → restoreNamingSettings →
  // renderNamingPreview 会调 renderFileName，桩里缺了就在初始化中途抛错，
  // 后续断言会跟着一起红 —— 看起来像页面坏了，其实只是桩的保真度不够。
  // 之所以在桩里现写一遍而不是直接 require cert-core.js：那会把真实实现拉进来，
  // 断言就不再只盯着 app.js 的接线了。
  //
  // DEFAULT_NAMING_PATTERNS 是防漂移的唯一来源：真实默认值一旦改了，
  // 下面的断言会直接指出这份副本过期，而不是悄悄让桩和实现分叉。
  sandbox.CertCore = {
    TEMPLATES: {
      general: { id: "general", label: "一般版本", file: "template-general.docx" },
      special: { id: "special", label: "260513 特殊版本", file: "template-special.docx" },
    },
    DEFAULT_NAMING_PATTERNS: {
      individual: "TE操作培训证书_{姓名}",
      merged: "TE操作培训证书_{份数}份_{时间}",
      archive: "TE操作培训证书_{时间}",
    },
    stripOutputExtension: (value) =>
      String(value == null ? "" : value).trim().replace(/\.(?:pdf|docx|zip)$/i, ""),
    renderFileName: (pattern, values, fallback, extension) => {
      const expanded = String(pattern == null ? "" : pattern).replace(/\{([^{}]+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key]) : whole,
      );
      return expanded + "." + String(extension || "pdf").replace(/^\.+/, "");
    },
  };
  sandbox.CertDirectPdf = require(path.join(TOOL, "cert-direct-pdf.js"));
  // AI 模块也要加载：app.js 的 restoreAiSettings 依赖 window.CertAi，
  // 桩里不给它就会静默跳过整个 AI 面板的渲染 —— 那是桩的保真度问题，
  // 会让人误以为页面代码坏了。（真实页面里靠 <script src> 加载。）
  sandbox.CertAi = require(path.join(TOOL, "cert-ai.js"));
  sandbox.CertAiSession = require(path.join(TOOL, "cert-ai-session.js"));

  const source = fs.readFileSync(path.join(TOOL, "app.js"), "utf8");
  const context = vm.createContext(sandbox);

  try {
    vm.runInContext(source, context, { filename: "app.js" });
  } catch (error) {
    errors.push("加载 app.js 抛错: " + error.message);
    return { errors: errors, registry: registry, document: document, sandbox: sandbox, bootFailed: true };
  }

  try {
    document.dispatch("DOMContentLoaded");
  } catch (error) {
    errors.push("DOMContentLoaded 处理抛错: " + error.message);
  }

  return { errors: errors, registry: registry, document: document, sandbox: sandbox, bootFailed: false };
}

/* -------------------------------------------------------------------- 断言 */

console.log("TE 证书工具 · DOM 冒烟测试（桩，非真实浏览器）\n");

const app = loadApp();

console.log("[1] 初始化不抛错");
check("app.js 加载成功", !app.bootFailed);
check(
  "DOMContentLoaded 处理过程没有异常",
  !app.errors.some((e) => e.includes("抛错")),
  app.errors.join(" | "),
);
check("没有 console.error", !app.errors.some((e) => e.startsWith("error:")), app.errors.join(" | "));

// 桩里的 DEFAULT_NAMING_PATTERNS 是真实默认值的副本。副本过期不会报错，
// 只会让这个套件悄悄不再覆盖真实行为 —— 所以拿真实现逐字段比一次。
const realCore = require(path.join(TOOL, "cert-core.js"));
check(
  "桩里的命名默认值与 cert-core.js 一致",
  JSON.stringify(app.sandbox.CertCore.DEFAULT_NAMING_PATTERNS) ===
    JSON.stringify(realCore.DEFAULT_NAMING_PATTERNS),
  "桩=" + JSON.stringify(app.sandbox.CertCore.DEFAULT_NAMING_PATTERNS) +
    " 实现=" + JSON.stringify(realCore.DEFAULT_NAMING_PATTERNS),
);

console.log("\n[2] PDF 生成方式面板：只剩本地一条路");
{
  const html = require("fs").readFileSync(path.join(TOOL, "index.html"), "utf8");

  // 云端路径移除后不该再有"选服务商"这一步：选它是为了决定要不要把证书发出去，
  // 而现在根本没有第二个选项。留着它只会让用户以为还有别的生成方式。
  for (const id of ["cloudProvider", "cloudFields", "cloudHelp", "cloudNote", "cloudSaveBtn", "cloudForgetBtn"]) {
    check("页面不再有 #" + id, app.registry.get(id) === undefined || app.registry.get(id) === null);
  }
  check(
    "页面不再出现云服务商的名字",
    !/convertapi|cloudconvert|adobe/i.test(html),
    "残留文案会让人以为还能走云端",
  );
  check(
    "生成说明写明本机完成",
    /零网络请求|不上传任何内容/.test(html),
    "只有一条路时，这条路必须把「本机完成」这件事说清楚",
  );
}

const pdfBtn = app.registry.get("pdfBtn");
check("pdfBtn 默认禁用（还没有可生成的记录）", pdfBtn && pdfBtn.disabled === true);

console.log("\n[3] 生成证书不需要任何密钥输入框");
{
  const fields = app.registry.get("cloudFields");
  check("页面没有密钥输入容器", !fields);
  check(
    "app.js 里不再引用 data-cloud-field",
    !/data-cloud-field/.test(require("fs").readFileSync(path.join(TOOL, "app.js"), "utf8")),
  );
}

console.log("\n[4] 隐私提示只讲本地，AI 面板单独讲外发");
{
  const source = require("fs").readFileSync(path.join(TOOL, "app.js"), "utf8");
  // 生成路径不联网这件事现在是静态文案，不再随"选择"变化 ——
  // 所以断言的是"不存在 cloudNote 这个会变的元素"，以及 AI 面板仍会提示外发。
  const aiNote = app.registry.get("aiNote");
  check("存在 AI 隐私提示元素", Boolean(aiNote));
  check(
    "未选 AI 服务时提示不联网",
    aiNote && /不联网|只在本机/.test(aiNote.textContent),
    aiNote ? aiNote.textContent : "",
  );

  const aiProvider = app.registry.get("aiProvider");
  if (aiProvider && aiProvider.children.length) {
    aiProvider.value = "deepseek";
    aiProvider.dispatch("change");
    check(
      "选中 AI 服务后提示会外发",
      aiNote && /发送给|外发/.test(aiNote.textContent),
      aiNote ? aiNote.textContent : "",
    );
    aiProvider.value = "";
    aiProvider.dispatch("change");
  }
  check(
    "app.js 不再有云端凭据的存取代码",
    !/CLOUD_STORE_KEY|persistCloud|loadStoredCloud/.test(source),
  );
}

console.log("\n[5] 关键监听已绑定");
for (const id of ["parseBtn", "pdfBtn", "pdfMergeToggle"]) {
  const element = app.registry.get(id);
  check(
    id + " 绑定了事件",
    element && (element.hasListener("click") || element.hasListener("change") || element.hasListener("input") || element.hasListener("keydown")),
  );
}

// DOCX 下载入口与 DOCX 生成能力都必须不存在：
//   1) 证书一旦发出去就是最终版，源文件可以被随意改动，不适合交付给学员；
//   2) 生成器本身也已随云端路径删除，留着它只会让人以为还有一条 DOCX 路径。
// 反向断言防止以后有人"顺手"把它加回来。
console.log("\n[5b] 不提供 DOCX 下载入口，也不再有 DOCX 生成能力");
{
  const html = require("fs").readFileSync(path.join(TOOL, "index.html"), "utf8");
  const source = require("fs").readFileSync(path.join(TOOL, "app.js"), "utf8");
  check("页面没有「生成 ZIP（DOCX）」按钮", !/generateBtn/.test(html));
  check("app.js 里没有 generateBtn 残留", !/generateBtn/.test(source));
  check("页面没有「只下载勾选的」按钮", !/downloadSelectedBtn/.test(html));
  check("app.js 里没有 downloadSelectedBtn 残留", !/downloadSelectedBtn/.test(source));
  check(
    "页面没有任何返回 ZIP 的 DOCX 下载入口",
    !/生成 ZIP/.test(html) && !/下载.*\.docx/i.test(html),
    "源文件可以被随意改动，不适合交付给学员",
  );
  check(
    "app.js 里不再有 DOCX 生成逻辑",
    !/buildCertificateItems/.test(source) && !/CertCore\.buildDocx/.test(source),
    "它只服务于已移除的云端转换，留着就是死代码",
  );
}

console.log("\n[6] 表格相关监听绑定在 previewBody 上");
const previewBody = app.registry.get("previewBody");
check("previewBody 存在", Boolean(previewBody));
if (previewBody) {
  for (const type of ["input", "blur", "keydown", "click", "change"]) {
    check("previewBody 绑定了 " + type, previewBody.hasListener(type));
  }
}

console.log("\n[7] AI 解析面板");
const aiProvider = app.registry.get("aiProvider");
check("找到了 aiProvider 下拉框", Boolean(aiProvider));
check(
  "AI 下拉框被填上了选项",
  aiProvider && aiProvider.children.length >= 2,
  aiProvider ? "只有 " + aiProvider.children.length + " 个选项" : "元素不存在",
);
if (aiProvider && aiProvider.children.length) {
  const firstAi = aiProvider.children[0];
  check(
    "第一个选项是「不用 AI」",
    firstAi.value === "" && /不用 AI/.test(firstAi.textContent),
    firstAi.textContent,
  );
  check("默认选中「不用 AI」", aiProvider.value === "", "实际 value=" + JSON.stringify(aiProvider.value));
  const aiIds = aiProvider.children.slice(1).map((option) => option.value);
  check("列出的服务与模块一致", aiIds.every((id) => app.sandbox.CertAi.getProvider(id)), aiIds.join(", "));
}

const aiParseBtn = app.registry.get("aiParseBtn");
check("aiParseBtn 默认禁用（没选服务也没内容）", aiParseBtn && aiParseBtn.disabled === true);

console.log("\n[8] 选中 AI 服务后生成密钥与模型输入框");
if (aiProvider) {
  aiProvider.value = "deepseek";
  aiProvider.dispatch("change");

  const aiFields = app.registry.get("aiFields");
  const aiInputs = aiFields ? aiFields.querySelectorAll("[data-ai-field]") : [];
  check("生成了 AI 输入框", aiInputs.length >= 2, "实际 " + aiInputs.length + " 个");
  const names = aiInputs.map((input) => input.dataset.aiField);
  check("含 apiKey 字段", names.indexOf("apiKey") >= 0, names.join(","));
  check("含 model 字段", names.indexOf("model") >= 0, names.join(","));
  check(
    "内置服务不需要用户填端点（端点写死在代码里）",
    names.indexOf("endpoint") < 0,
    names.join(","),
  );
  const keyInput = aiInputs.find((input) => input.dataset.aiField === "apiKey");
  check("apiKey 是密码类型", keyInput && keyInput.type === "password");
  const modelInput = aiInputs.find((input) => input.dataset.aiField === "model");
  check(
    "模型名预填了 deepseek-flash",
    modelInput && modelInput.value === "deepseek-flash",
    modelInput ? modelInput.value : "",
  );

  // 选了服务但既没文本也没图片 → 仍不可点
  check("选了服务但没有内容时仍禁用", aiParseBtn.disabled === true);

  // 有文本后应变为可点
  const quickInput = app.registry.get("quickInput");
  quickInput.value = "靳睿 南京鼓楼医院 2025-10-10";
  quickInput.dispatch("input");
  check(
    "有文本 + 选了服务后 AI 按钮可点",
    aiParseBtn.disabled === false,
    "仍为禁用 —— refreshButtons 的 AI 分支没生效",
  );

  // 回到「不用 AI」
  aiProvider.value = "";
  aiProvider.dispatch("change");
  check("退回「不用 AI」后 AI 按钮又禁用", aiParseBtn.disabled === true);
  check(
    "退回「不用 AI」后输入框被清空",
    app.registry.get("aiFields").querySelectorAll("[data-ai-field]").length === 0,
  );
}

console.log("\n[9] AI 相关监听已绑定");
for (const id of [
  "aiProvider", "aiParseBtn", "aiImageInput", "aiImageLabel", "aiImageList", "aiClearImageBtn",
  "aiBlock", "aiSessionSelect", "aiNewSessionBtn", "aiDeleteSessionBtn", "aiCloseBtn",
  "aiComposer", "aiSendBtn", "aiApplyBtn", "aiDiscardBtn", "aiCancelBtn",
]) {
  const element = app.registry.get(id);
  check(
    id + " 绑定了事件",
    element &&
      (element.hasListener("click") ||
        element.hasListener("change") ||
        element.hasListener("drop") ||
        element.hasListener("dragover") ||
        element.hasListener("input") ||
        element.hasListener("toggle") ||
        element.hasListener("keydown")),
  );
}
const aiImageLabel = app.registry.get("aiImageLabel");
check("图片拖放区监听了 dragover（否则拖入会把浏览器拽去打开图片）", aiImageLabel && aiImageLabel.hasListener("dragover"));
check("图片拖放区监听了 drop", aiImageLabel && aiImageLabel.hasListener("drop"));

// 逐张移除用的是事件委托（按钮是动态生成的，不能逐个绑定）。
// 这里只验证「点一下不会抛」：桩里 aiImages 为空，处理函数应当直接返回。
const aiImageList = app.registry.get("aiImageList");
check("已选图片列表监听了 click（逐张移除靠它）", aiImageList && aiImageList.hasListener("click"));
let removeThrew = null;
try {
  aiImageList.dispatch("click", { type: "click", target: { dataset: { removeImage: "0" } } });
  aiImageList.dispatch("click", { type: "click", target: {} });
} catch (error) {
  removeThrew = error;
}
check("点击移除按钮不抛异常（空列表时直接返回）", removeThrew === null, removeThrew && removeThrew.message);
check(
  "HTML 上图片输入允许选多张",
  /<input id="aiImageInput"[^>]*\bmultiple\b/.test(
    fs.readFileSync(path.join(TOOL, "index.html"), "utf8"),
  ),
);

console.log("\n[10] PDF 输出方式开关");
{
  const toggle = app.registry.get("pdfMergeToggle");
  const label = app.registry.get("pdfBtnLabel");
  const html = require("fs").readFileSync(path.join(TOOL, "index.html"), "utf8");
  const source = require("fs").readFileSync(path.join(TOOL, "app.js"), "utf8");

  check("找到了 pdfMergeToggle", Boolean(toggle));
  check("找到了 pdfBtnLabel", Boolean(label));
  check(
    "HTML 里开关默认不带 checked（默认每人一个独立 PDF）",
    /<input id="pdfMergeToggle" type="checkbox"\s*\/>/.test(html),
    "客户要的是每人一个 PDF，默认不能是合并",
  );
  check(
    "HTML 里按钮初始文案说「每人一个」",
    // 初始文案是 HTML 的职责；桩不解析 HTML 内容，所以这里直接查源码字符串
    /id="pdfBtnLabel">[^<]*每人一个/.test(html),
    (html.match(/id="pdfBtnLabel">([^<]*)/) || [])[1] || "没找到",
  );

  if (toggle) {
    // 默认状态：桩不解析 HTML 的 checked，这里显式设为 false 模拟真实默认
    toggle.checked = false;
    check("默认不勾选", toggle.checked === false);

    toggle.checked = true;
    toggle.dispatch("change");
    check(
      "勾选后文案变成「合并成一本」",
      label && /合并成一本/.test(label.textContent),
      label ? label.textContent : "",
    );
    toggle.checked = false;
    toggle.dispatch("change");
    check(
      "取消勾选后文案改回「每人一个」",
      label && /每人一个/.test(label.textContent),
      label ? label.textContent : "",
    );
  }

  // 这两个 id 必须在 els 声明列表里 —— 漏掉的后果是元素永远 undefined，
  // 而代码里有 `if (els.X)` 保护，于是**静默失效**：开关勾了没用、文案不变，
  // 页面上没有任何报错。真踩过一次。
  const declaredBlock = source.match(/\[\s*\n([\s\S]*?)\]\.forEach\(\(id\) =>/);
  for (const id of ["pdfMergeToggle", "pdfBtnLabel"]) {
    check(
      id + " 在 els 声明列表里（漏了会静默失效）",
      declaredBlock && declaredBlock[1].indexOf('"' + id + '"') >= 0,
      "只在别处出现不算，必须进声明列表才会被 getElementById 取到",
    );
  }

  // app.js 必须把这个开关接到 CertDirectPdf.generateBatch 的 batch 参数上，
  // 否则开关只是个装饰，勾不勾都走同一条路
  check(
    "generatePdf 把开关接到了 generateBatch 的 batch 参数",
    /batch:\s*wantMerged/.test(source) && /pdfMergeToggle\.checked/.test(source),
    "开关没接线的话，勾选不会改变输出方式",
  );
  check(
    "默认意图是逐份（wantMerged 来自 checked，未勾选即 false）",
    /const wantMerged = Boolean\(els\.pdfMergeToggle && els\.pdfMergeToggle\.checked\)/.test(source),
  );

  // ---- ZIP 打包：自动进行，没有开关 ----
  // 连续多次下载会被浏览器拦（要用户逐次点"允许"），这不是用户该做的选择，
  // 所以不做开关、直接打包。这里断言"开关没有被加回来"。
  check(
    "没有 ZIP 开关（打包是自动的）",
    !app.registry.get("pdfZipToggle") && !/pdfZipToggle/.test(html),
    "ZIP 是技术细节，页面不该出现这个选项",
  );
  check(
    "取不到元素也不会退化成逐个下载（没有依赖开关的分支）",
    /const shouldZip = files\.length > 1;/.test(source),
    "打包条件只取决于文件数",
  );
}

console.log("\n" + "=".repeat(70));
console.log("通过 " + passed + " 项，失败 " + failures.length + " 项。");
if (failures.length) {
  failures.forEach((item) => console.log("  - " + item));
  process.exit(1);
}
