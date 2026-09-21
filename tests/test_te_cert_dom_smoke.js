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
 *   - 云服务下拉框真的被填上了选项
 *   - 默认值是「不转换」（绝不能预选任何会外发数据的服务）
 *   - 选中服务商后密钥输入框按声明生成
 *   - refreshButtons 的行为符合预期
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

  const element = {
    id: id || "",
    tagName: "DIV",
    className: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    type: "",
    dataset: {},
    style: {},
    children: children,
    parentNode: null,
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
      // 云密钥输入框嵌在 <label> 里（div > label > input），只看直接子元素会查不到，
      // 那时测试失败反映的是桩的缺陷，而不是被测代码有问题。
      // dataset.cloudField 对应 HTML 的 data-cloud-field 属性。
      if (selector !== "[data-cloud-field]") return [];
      const found = [];
      const walk = (node) => {
        node.children.forEach((child) => {
          if (child.dataset && child.dataset.cloudField) found.push(child);
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

  // 最小 CertCore / CertCloud 替身：只保留 app.js 初始化路径会碰到的部分
  sandbox.CertCore = {
    TEMPLATES: {
      general: { id: "general", label: "一般版本", file: "template-general.docx" },
      special: { id: "special", label: "260513 特殊版本", file: "template-special.docx" },
    },
  };
  sandbox.CertCloud = require(path.join(TOOL, "cert-cloud.js"));

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

console.log("\n[2] 云转换设置面板");
const providerSelect = app.registry.get("cloudProvider");
check("找到了 cloudProvider 下拉框", Boolean(providerSelect));
check("下拉框被填上了选项", providerSelect && providerSelect.children.length >= 2,
  providerSelect ? "只有 " + providerSelect.children.length + " 个选项" : "元素不存在");

if (providerSelect && providerSelect.children.length) {
  const first = providerSelect.children[0];
  check("第一个选项是「不转换」", first.value === "" && /不转换/.test(first.textContent), first.textContent);
  check("默认选中「不转换」", providerSelect.value === "", "实际 value=" + JSON.stringify(providerSelect.value));

  const ids = providerSelect.children.slice(1).map((option) => option.value);
  check("列出全部服务商", ids.length === app.sandbox.CertCloud.PROVIDERS.length, ids.join(", "));
  check("服务商 id 与模块一致",
    ids.every((id) => app.sandbox.CertCloud.getProvider(id)),
    ids.join(", "));
}

const pdfBtn = app.registry.get("pdfBtn");
check("pdfBtn 默认禁用（没选服务商）", pdfBtn && pdfBtn.disabled === true);

console.log("\n[3] 选中服务商后生成密钥输入框");
if (providerSelect) {
  providerSelect.value = "convertapi";
  providerSelect.dispatch("change");

  const fields = app.registry.get("cloudFields");
  const inputs = fields ? fields.querySelectorAll("[data-cloud-field]") : [];
  check("生成了密钥输入框", inputs.length === 1, "实际 " + inputs.length + " 个");
  if (inputs.length) {
    check("输入框是密码类型", inputs[0].type === "password");
    check("输入框 data-cloud-field = secret", inputs[0].dataset.cloudField === "secret");
    check("输入框带 placeholder", Boolean(inputs[0].placeholder));
  }

  const adobeOption = providerSelect.children.find((option) => option.value === "adobe");
  if (adobeOption) {
    providerSelect.value = "adobe";
    providerSelect.dispatch("change");
    const adobeInputs = app.registry.get("cloudFields").querySelectorAll("[data-cloud-field]");
    check("Adobe 生成两个输入框", adobeInputs.length === 2, "实际 " + adobeInputs.length);
    check(
      "Adobe 字段名是 clientId / clientSecret",
      adobeInputs.map((i) => i.dataset.cloudField).join(",") === "clientId,clientSecret",
      adobeInputs.map((i) => i.dataset.cloudField).join(","),
    );
  }

  // 回到不转换，确认能收回
  providerSelect.value = "";
  providerSelect.dispatch("change");
  check(
    "退回「不转换」后密钥框被清空",
    app.registry.get("cloudFields").querySelectorAll("[data-cloud-field]").length === 0,
  );
}

console.log("\n[4] 隐私提示随选择变化");
const cloudNote = app.registry.get("cloudNote");
check("存在隐私提示元素", Boolean(cloudNote));
check(
  "未选服务商时提示不联网",
  cloudNote && /不联网|只在本机/.test(cloudNote.textContent),
  cloudNote ? cloudNote.textContent : "",
);

if (providerSelect) {
  providerSelect.value = "convertapi";
  providerSelect.dispatch("change");
  check(
    "选中服务商后提示会外发",
    cloudNote && /发送给|外发/.test(cloudNote.textContent),
    cloudNote ? cloudNote.textContent : "",
  );
}

console.log("\n[5] 关键监听已绑定");
for (const id of ["parseBtn", "generateBtn", "pdfBtn", "cloudSaveBtn", "cloudForgetBtn", "cloudProvider"]) {
  const element = app.registry.get(id);
  check(
    id + " 绑定了事件",
    element && (element.hasListener("click") || element.hasListener("change") || element.hasListener("input") || element.hasListener("keydown")),
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

console.log("\n" + "=".repeat(70));
console.log("通过 " + passed + " 项，失败 " + failures.length + " 项。");
if (failures.length) {
  failures.forEach((item) => console.log("  - " + item));
  process.exit(1);
}
