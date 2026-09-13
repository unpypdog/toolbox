"use strict";

const API_BASE_STORAGE_KEY = "training-cert-batch-fill.apiBase";
const TOKEN_RENEW_AFTER_MS = 75_000;
const MAX_PREVIEW_ROWS = 200;
const PHONE_RE = /^1[3-9]\d{9}$/;

const HEADER_ALIASES = {
  userName: ["姓名", "用户名", "username", "name"],
  phone: ["手机号", "手机", "phone", "mobile"],
  unitName: ["单位名称", "单位", "unitname", "hospital", "医院名称"],
  address: ["地址", "address", "详细地址"],
};

const STATUS = {
  ready: { label: "待导入", className: "ready" },
  invalid: { label: "校验失败", className: "invalid" },
  existing: { label: "已有手机号 · 跳过", className: "existing" },
  uploading: { label: "正在导入", className: "uploading" },
  success: { label: "新增成功", className: "success" },
  failed: { label: "新增失败", className: "failed" },
  stopped: { label: "已停止 · 未处理", className: "stopped" },
};

const state = {
  file: null,
  records: [],
  encoding: "",
  apiBase: "",
  connected: false,
  token: "",
  tokenCreatedAt: 0,
  importing: false,
  stopRequested: false,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "fileInput", "dropZone", "fileSummary", "fileName", "fileMeta", "downloadTemplateBtn",
    "loginForm", "apiBaseInput", "usernameInput", "passwordInput", "togglePasswordBtn", "connectBtn",
    "connectionPill", "startImportBtn", "stopImportBtn", "exportBtn", "progressBlock",
    "progressText", "progressPercent", "progressBar", "statusFilter", "clearBtn", "statTotal",
    "statReady", "statProblem", "statSuccess", "noticeBar", "emptyState", "tableRegion",
    "previewBody", "tableFootnote", "activityPanel", "activityClock", "activityLog",
    "confirmDialog", "confirmCopy", "confirmReady", "confirmInvalid", "confirmCheckbox",
    "confirmImportBtn", "toastRegion",
  ].forEach((id) => { els[id] = document.getElementById(id); });

  bindEvents();
  els.apiBaseInput.value = readStoredApiBase();
  render();
});

function bindEvents() {
  els.fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) void loadFile(file);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  });
  els.dropZone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (file) void loadFile(file);
  });
  els.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  els.downloadTemplateBtn.addEventListener("click", downloadTemplate);
  els.clearBtn.addEventListener("click", clearFile);
  els.statusFilter.addEventListener("change", renderTable);
  els.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void connect();
  });
  els.togglePasswordBtn.addEventListener("click", togglePassword);
  els.startImportBtn.addEventListener("click", openConfirmation);
  els.stopImportBtn.addEventListener("click", requestStop);
  els.exportBtn.addEventListener("click", exportResults);
  els.confirmCheckbox.addEventListener("change", () => {
    els.confirmImportBtn.disabled = !els.confirmCheckbox.checked;
  });
  els.confirmDialog.addEventListener("close", () => {
    if (els.confirmDialog.returnValue === "default" && els.confirmCheckbox.checked) {
      void runImport();
    }
  });
}

async function loadFile(file) {
  if (state.importing) return;
  const extension = file.name.split(".").pop().toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(extension)) {
    showToast("请选择 CSV、XLSX 或 XLS 文件。", "error");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast("文件超过 20MB，请拆分后再导入。", "error");
    return;
  }

  setNotice("正在本地解析文件…");
  try {
    let matrix;
    let encoding = "";
    if (extension === "csv") {
      const decoded = decodeCsv(await file.arrayBuffer());
      matrix = parseCsv(decoded.text);
      encoding = decoded.encoding;
    } else {
      matrix = await readWorkbook(file);
    }
    state.file = file;
    state.encoding = encoding;
    state.records = matrixToRecords(matrix, encoding);
    resetRunState();
    const problems = state.records.filter((record) => record.status === "invalid").length;
    setNotice(
      problems
        ? `解析完成：发现 ${problems} 条问题记录。问题行不会被导入。`
        : `解析完成：${state.records.length} 条记录均通过本地校验。`,
      problems ? "error" : "success",
    );
    showToast(`已读取 ${state.records.length} 条记录。`);
    render();
  } catch (error) {
    state.file = null;
    state.records = [];
    setNotice(error.message || "文件解析失败，请检查格式。", "error");
    showToast(error.message || "文件解析失败。", "error");
    render();
  }
}

// \u4E2D\u6587 Windows \u4E0A Excel \u5B58\u51FA\u6765\u7684 CSV \u9ED8\u8BA4\u662F GBK\uFF08\u7CFB\u7EDF ANSI \u4EE3\u7801\u9875\uFF09\uFF0C
// \u800C File.text() \u6C38\u8FDC\u6309 UTF-8 \u89E3\u7801\u2014\u2014\u4E2D\u6587\u8868\u5934\u4F1A\u53D8\u6210\u4E71\u7801\uFF0C\u62A5\u201C\u7F3A\u5C11\u5FC5\u8981\u8868\u5934\u201D\uFF0C
// \u4F7F\u7528\u8005\u770B\u5230\u7684\u5374\u662F\u6587\u4EF6\u660E\u660E\u6CA1\u95EE\u9898\u3002\u6240\u4EE5\u81EA\u5DF1\u8BFB\u5B57\u8282\u5224\u65AD\u7F16\u7801\u3002
const FALLBACK_ENCODINGS = ["gbk", "big5"];

function decodeCsv(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  try {
    // \u7528 fatal \u8BA9\u975E\u6CD5\u5B57\u8282\u76F4\u63A5\u629B\u9519\uFF0C\u800C\u4E0D\u662F\u9759\u9ED8\u66FF\u6362\u6210\u66FF\u6362\u5B57\u7B26\u3002
    // \u5426\u5219 GBK \u6587\u4EF6\u4F1A\u88AB\u201C\u6210\u529F\u201D\u89E3\u7801\u6210\u4E00\u5806\u95EE\u53F7\uFF0C\u53CD\u800C\u66F4\u96BE\u67E5\u3002
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    // \u4E0D\u662F\u5408\u6CD5 UTF-8\uFF0C\u7EE7\u7EED\u5F80\u4E0B\u8BD5
  }
  for (const encoding of FALLBACK_ENCODINGS) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
    } catch {
      // \u6362\u4E0B\u4E00\u4E2A\u5019\u9009
    }
  }
  throw new Error("\u65E0\u6CD5\u8BC6\u522B\u6587\u4EF6\u7F16\u7801\u3002\u8BF7\u628A\u6587\u4EF6\u53E6\u5B58\u4E3A UTF-8 \u6216 GBK \u7F16\u7801\u7684 CSV \u540E\u91CD\u8BD5\u3002");
}

async function readWorkbook(file) {
  if (!window.XLSX) {
    throw new Error("Excel 解析组件未加载。请检查网络，或先另存为 CSV。")
  }
  const bytes = await file.arrayBuffer();
  const workbook = window.XLSX.read(bytes, { type: "array", cellDates: false });
  if (!workbook.SheetNames.length) throw new Error("工作簿中没有可读取的工作表。")
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("CSV 引号没有闭合。")
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function matrixToRecords(matrix, encoding = "") {
  const nonEmptyRows = matrix.filter((row) => Array.isArray(row) && row.some((cell) => String(cell).trim()));
  if (nonEmptyRows.length < 2) throw new Error("文件中没有可导入的数据行。")
  const headers = nonEmptyRows[0].map(normalizeHeader);
  const columnMap = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    columnMap[field] = headers.findIndex((header) => aliases.includes(header));
  }
  const missing = ["userName", "phone", "unitName"].filter((field) => columnMap[field] < 0);
  if (missing.length) {
    const labels = { userName: "姓名", phone: "手机号", unitName: "单位名称" };
    // 带上实际用的编码：如果这里显示 utf-8 而文件确实是 GBK，
    // 说明解码走错了分支，有了这个信息就不必再猜。
    const decoded = encoding ? `（按 ${encoding.toUpperCase()} 解码）` : "";
    throw new Error(
      `缺少必要表头：${missing.map((field) => labels[field]).join("、")}${decoded}。请确认首行是列名，且文件编码为 UTF-8 或 GBK。`,
    );
  }

  const seenPhones = new Map();
  const records = [];
  nonEmptyRows.slice(1).forEach((row, dataIndex) => {
    const valueAt = (field) => {
      const column = columnMap[field];
      return column < 0 ? "" : String(row[column] ?? "").trim();
    };
    const record = {
      sourceRow: dataIndex + 2,
      userName: valueAt("userName"),
      phone: valueAt("phone").replace(/[\s-]/g, ""),
      unitName: valueAt("unitName"),
      address: valueAt("address"),
      status: "ready",
      message: "本地校验通过",
      errors: [],
    };
    if (!record.userName) record.errors.push("姓名为空");
    if (!PHONE_RE.test(record.phone)) record.errors.push("手机号格式错误");
    if (!record.unitName) record.errors.push("单位名称为空");
    if (record.phone && seenPhones.has(record.phone)) {
      record.errors.push(`与第 ${seenPhones.get(record.phone)} 行手机号重复`);
    } else if (record.phone) {
      seenPhones.set(record.phone, record.sourceRow);
    }
    if (record.errors.length) {
      record.status = "invalid";
      record.message = record.errors.join("；");
    }
    records.push(record);
  });
  return records;
}

function normalizeHeader(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function readStoredApiBase() {
  try {
    return window.localStorage.getItem(API_BASE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeApiBase(value) {
  try {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, value);
  } catch {
    // file:// 或隐私模式下 localStorage 不可用，退化为不记住
  }
}

function normalizeApiBase(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("请先填写服务地址。");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("服务地址格式不正确，需形如 https://服务器地址:端口");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("服务地址必须以 http:// 或 https:// 开头。");
  }
  // 页面的 CSP 只对回环地址放开明文 http，其他 http 会被浏览器直接拦掉。
  // 在这里提前拒绝并说明原因，免得用户只看到一句无从下手的 Failed to fetch。
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("明文 http 仅允许 localhost 或 127.0.0.1，其他地址请使用 https://。");
  }
  // 只接受「主机 + 端口」。带路径或参数会静默改变请求目标（拼出来是 /api/api/Login/login
  // 或 ?tenant=1/api/Login/login），带 userinfo 的还会把凭据写进 localStorage，
  // 直接违背「密码和令牌不落盘」的承诺——必须挡在存储之前。
  if (parsed.username || parsed.password) {
    throw new Error("服务地址里不要包含账号或密码，凭据请在下方单独填写。");
  }
  // 最常见的误操作是直接粘贴浏览器地址栏里的登录页地址。它带路径，而且
  // 端口通常和接口不同——就算把路径去掉也连不通。所以要挡下来，而且要把
  // 原因说清楚，否则操作者只会卡在同一个地方反复试。
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "请填接口地址，只到主机和端口。浏览器地址栏里的登录页地址不能直接用：它带路径，端口也常和接口不同。",
    );
  }
  return value;
}

async function connect({ quiet = false } = {}) {
  let apiBase;
  try {
    apiBase = normalizeApiBase(els.apiBaseInput.value);
  } catch (error) {
    // 地址一旦非法，之前的连接就不再可信：若只改提示而不清会话，
    // 连接状态会停留在 true，「开始导入」按钮仍可点，点下去会往
    // 上一个地址写入——UI 在撒谎，而且写错了地方。
    state.connected = false;
    state.token = "";
    setConnection("error", "地址无效");
    updateActionState();
    if (!quiet) showToast(error.message, "error");
    throw error;
  }
  state.apiBase = apiBase;
  storeApiBase(apiBase);

  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  if (!username || !password) {
    setConnection("error", "请填写凭据");
    if (!quiet) showToast("请输入账号和密码。", "error");
    throw new Error("账号或密码为空");
  }
  setConnection("loading", "连接中");
  els.connectBtn.disabled = true;
  try {
    const response = await requestJson("/api/Login/login", {
      method: "POST",
      body: { username, password },
      authenticated: false,
    });
    if (!response.success || !response.data?.tokenRes?.accessToken) {
      throw new Error(response.message || "登录失败");
    }
    if (response.data.isEnable === false) throw new Error("该账号已停用");
    state.token = response.data.tokenRes.accessToken;
    state.tokenCreatedAt = Date.now();
    state.connected = true;
    setConnection("connected", "已连接");
    if (!quiet) showToast("连接成功，凭据仅保留在当前页面。")
    updateActionState();
    return true;
  } catch (error) {
    state.token = "";
    state.connected = false;
    setConnection("error", "连接失败");
    updateActionState();
    if (!quiet) showToast(humanizeNetworkError(error), "error");
    throw error;
  } finally {
    els.connectBtn.disabled = false;
  }
}

async function ensureSession() {
  if (!state.token || Date.now() - state.tokenCreatedAt >= TOKEN_RENEW_AFTER_MS) {
    await connect({ quiet: true });
  }
}

async function requestJson(path, options = {}) {
  const { method = "GET", body, authenticated = true, retryAuth = true } = options;
  if (authenticated) await ensureSession();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json; charset=UTF-8",
  };
  if (authenticated && state.token) headers.Authorization = `Bearer ${state.token}`;
  try {
    const response = await fetch(`${state.apiBase}${path}`, {
      method,
      headers,
      body: method === "POST" ? (body === undefined ? "" : JSON.stringify(body)) : undefined,
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status === 401 && authenticated && retryAuth) {
      state.token = "";
      await connect({ quiet: true });
      return requestJson(path, { ...options, retryAuth: false });
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // 服务端报错时经常直接回纯文本——例如登录失败回的是「用户名或密码错误」，
      // Content-Type 是 text/plain。JSON.parse 会失败，但那段文本恰恰是操作者
      // 唯一需要看到的信息，不能换成一句泛泛的「非 JSON 内容」。
      const detail =
        (parsed && parsed.message) || text.trim() || `HTTP ${response.status}`;
      throw new Error(detail);
    }
    if (parsed === null) {
      throw new Error(`接口返回非 JSON 内容（HTTP ${response.status}）`);
    }
    return parsed;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请检查网络后重试");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function openConfirmation() {
  if (state.importing) return;
  const ready = state.records.filter((record) => record.status === "ready").length;
  const invalid = state.records.filter((record) => record.status === "invalid").length;
  if (!ready) {
    showToast("没有可导入的合格记录。", "error");
    return;
  }
  els.confirmReady.textContent = ready.toLocaleString("zh-CN");
  els.confirmInvalid.textContent = invalid.toLocaleString("zh-CN");
  els.confirmCopy.textContent = "系统将先读取现有用户并跳过相同手机号，再逐条创建剩余记录。此操作会写入正式系统。";
  els.confirmCheckbox.checked = false;
  els.confirmImportBtn.disabled = true;
  els.confirmDialog.showModal();
}

async function runImport() {
  if (state.importing) return;
  state.importing = true;
  state.stopRequested = false;
  state.records.forEach((record) => {
    if (["existing", "failed", "stopped"].includes(record.status)) {
      record.status = record.errors.length ? "invalid" : "ready";
      record.message = record.errors.length ? record.errors.join("；") : "等待重新处理";
    }
  });
  prepareImportUi();
  addLog("开始导入流程；正在连接并读取现有手机号。")

  try {
    await ensureSession();
    const existingPhones = await fetchExistingPhones();
    let skipped = 0;
    state.records.forEach((record) => {
      if (record.status === "ready" && existingPhones.has(record.phone)) {
        record.status = "existing";
        record.message = "系统中已存在该手机号";
        skipped += 1;
      }
    });
    addLog(`重复检查完成：系统内 ${existingPhones.size} 个手机号，本次跳过 ${skipped} 条。`)
    render();

    const candidates = state.records.filter((record) => record.status === "ready");
    const total = candidates.length;
    if (!total) {
      addLog("没有需要新增的记录。")
      showToast("所有合格记录都已存在，无需新增。")
      return;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const record = candidates[index];
      if (state.stopRequested) {
        candidates.slice(index).forEach((pending) => {
          pending.status = "stopped";
          pending.message = "用户主动停止，尚未提交";
        });
        addLog(`已停止，剩余 ${candidates.length - index} 条未提交。`)
        break;
      }
      record.status = "uploading";
      record.message = "正在发送";
      updateRecordRow(record);
      updateProgress(index, total, `正在导入：${record.userName}`);
      try {
        const response = await requestJson("/api/User/InsertOrUpdateUsers", {
          method: "POST",
          body: {
            isActivate: false,
            userName: record.userName,
            phone: record.phone,
            unitName: record.unitName,
            address: record.address,
          },
        });
        if (response.success) {
          record.status = "success";
          record.message = response.message || "新增成功";
        } else {
          record.status = "failed";
          record.message = response.message || "接口返回新增失败";
        }
      } catch (error) {
        record.status = "failed";
        record.message = humanizeNetworkError(error);
      }
      updateRecordRow(record);
      updateStats();
      updateProgress(index + 1, total, `${index + 1} / ${total}`);
      if (record.status === "failed") addLog(`第 ${record.sourceRow} 行失败：${record.message}`);
      await wait(140);
    }
  } catch (error) {
    addLog(`流程中止：${humanizeNetworkError(error)}`)
    showToast(humanizeNetworkError(error), "error");
  } finally {
    state.importing = false;
    finishImportUi();
    render();
    const success = state.records.filter((record) => record.status === "success").length;
    const failed = state.records.filter((record) => record.status === "failed").length;
    addLog(`处理结束：新增成功 ${success} 条，失败 ${failed} 条。`)
    showToast(`处理结束：成功 ${success} 条，失败 ${failed} 条。`, failed ? "error" : "success");
  }
}

async function fetchExistingPhones() {
  const phones = new Set();
  const pageSize = 100;
  let pageIndex = 1;
  while (true) {
    if (state.stopRequested) throw new Error("操作已停止");
    const response = await requestJson(
      `/api/User/QueryUsers?pageIndex=${pageIndex}&pageSize=${pageSize}`,
      { method: "POST" },
    );
    if (!response.success) throw new Error(response.message || "读取现有用户失败");
    const rows = Array.isArray(response.data) ? response.data : [];
    rows.forEach((row) => {
      const phone = String(row.phone || "").trim();
      if (phone) phones.add(phone);
    });
    const total = Number(response.total || 0);
    updateProgress(Math.min(pageIndex * pageSize, total), total || 1, "正在检查重复手机号");
    if (!rows.length || pageIndex * pageSize >= total) break;
    pageIndex += 1;
  }
  return phones;
}

function requestStop() {
  state.stopRequested = true;
  els.stopImportBtn.disabled = true;
  els.stopImportBtn.textContent = "正在停止…";
  addLog("收到停止请求；当前请求结束后停止。")
}

function prepareImportUi() {
  els.progressBlock.hidden = false;
  els.stopImportBtn.hidden = false;
  els.stopImportBtn.disabled = false;
  els.stopImportBtn.textContent = "完成当前条后停止";
  els.startImportBtn.disabled = true;
  els.clearBtn.disabled = true;
  els.fileInput.disabled = true;
  els.activityPanel.hidden = false;
  updateProgress(0, 1, "准备中");
}

function finishImportUi() {
  els.stopImportBtn.hidden = true;
  els.fileInput.disabled = false;
  els.exportBtn.disabled = !state.records.some((record) => ["success", "failed", "existing", "stopped"].includes(record.status));
  updateActionState();
}

function resetRunState() {
  state.stopRequested = false;
  els.activityLog.innerHTML = "";
  els.activityPanel.hidden = true;
  els.progressBlock.hidden = true;
  els.exportBtn.disabled = true;
}

function clearFile() {
  if (state.importing) return;
  state.file = null;
  state.records = [];
  state.encoding = "";
  els.fileInput.value = "";
  resetRunState();
  setNotice("选择文件后，系统会在本地检查表头、必填项、手机号格式和重复项。")
  render();
}

function render() {
  const hasFile = Boolean(state.file);
  els.fileSummary.classList.toggle("is-empty", !hasFile);
  els.fileName.textContent = hasFile ? state.file.name : "尚未选择文件";
  els.fileMeta.textContent = hasFile
    ? [
        formatBytes(state.file.size),
        `${state.records.length.toLocaleString("zh-CN")} 条`,
        state.encoding ? state.encoding.toUpperCase() : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "支持 .csv / .xlsx / .xls";
  els.emptyState.hidden = hasFile;
  els.tableRegion.hidden = !hasFile;
  els.clearBtn.disabled = !hasFile || state.importing;
  updateStats();
  renderTable();
  updateActionState();
}

function updateStats() {
  const count = (statuses) => state.records.filter((record) => statuses.includes(record.status)).length;
  els.statTotal.textContent = state.records.length.toLocaleString("zh-CN");
  els.statReady.textContent = count(["ready", "uploading"]).toLocaleString("zh-CN");
  els.statProblem.textContent = count(["invalid", "failed"]).toLocaleString("zh-CN");
  els.statSuccess.textContent = count(["success"]).toLocaleString("zh-CN");
}

function renderTable() {
  if (!state.file) return;
  const filter = els.statusFilter.value;
  const filtered = state.records.filter((record) => {
    if (filter === "problem") return ["invalid", "failed"].includes(record.status);
    if (filter === "pending") return ["ready", "uploading"].includes(record.status);
    if (filter === "done") return ["success", "failed", "existing", "stopped"].includes(record.status);
    return true;
  });
  const visible = filtered.slice(0, MAX_PREVIEW_ROWS);
  els.previewBody.replaceChildren(...visible.map(createRow));
  els.tableFootnote.textContent = filtered.length > MAX_PREVIEW_ROWS
    ? `当前显示前 ${MAX_PREVIEW_ROWS} 条，共 ${filtered.length} 条。导入仍会处理全部合格记录。`
    : `当前显示 ${filtered.length} 条记录。`;
}

function createRow(record) {
  const tr = document.createElement("tr");
  tr.dataset.sourceRow = String(record.sourceRow);
  const values = [record.sourceRow, record.userName, record.phone, record.unitName, record.address];
  values.forEach((value) => {
    const td = document.createElement("td");
    td.textContent = value || "—";
    if (!value) td.className = "cell-muted";
    tr.appendChild(td);
  });
  const statusCell = document.createElement("td");
  statusCell.appendChild(createStatus(record));
  tr.appendChild(statusCell);
  return tr;
}

function createStatus(record) {
  const status = STATUS[record.status] || STATUS.ready;
  const badge = document.createElement("span");
  badge.className = `status-badge status-badge--${status.className}`;
  badge.textContent = record.message || status.label;
  badge.title = record.message || status.label;
  return badge;
}

function updateRecordRow(record) {
  const row = els.previewBody.querySelector(`[data-source-row="${record.sourceRow}"]`);
  if (!row) return;
  const cell = row.lastElementChild;
  cell.replaceChildren(createStatus(record));
}

function updateActionState() {
  const hasReady = state.records.some((record) => record.status === "ready");
  els.startImportBtn.disabled = state.importing || !state.connected || !hasReady;
}

function setConnection(stateName, label) {
  els.connectionPill.dataset.state = stateName;
  els.connectionPill.querySelector("b").textContent = label;
}

function setNotice(message, tone = "neutral") {
  els.noticeBar.dataset.tone = tone;
  els.noticeBar.querySelector("span").textContent = message;
}

function updateProgress(current, total, text) {
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  els.progressText.textContent = text;
  els.progressPercent.textContent = `${percent}%`;
  els.progressBar.style.width = `${percent}%`;
}

function addLog(message) {
  els.activityPanel.hidden = false;
  const now = new Date();
  els.activityClock.textContent = now.toLocaleString("zh-CN", { hour12: false });
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  els.activityLog.prepend(item);
}

function togglePassword() {
  const showing = els.passwordInput.type === "text";
  els.passwordInput.type = showing ? "password" : "text";
  els.togglePasswordBtn.textContent = showing ? "显示" : "隐藏";
  els.togglePasswordBtn.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
}

function downloadTemplate() {
  downloadText(
    "training-cert-batch-fill_template.csv",
    "\uFEFF姓名,手机号,单位名称,地址\r\n张三,13800138000,示例医院,北京市海淀区示例路1号\r\n",
    "text/csv;charset=utf-8",
  );
}

function exportResults() {
  if (!state.records.length) return;
  const rows = [
    ["原文件行号", "姓名", "手机号", "单位名称", "地址", "状态", "结果消息"],
    ...state.records.map((record) => [
      record.sourceRow,
      record.userName,
      record.phone,
      record.unitName,
      record.address,
      STATUS[record.status]?.label || record.status,
      record.message,
    ]),
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  downloadText(`training-cert-batch-fill_result_${stamp}.csv`, csv, "text/csv;charset=utf-8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function showToast(message, tone = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${tone}`;
  toast.textContent = message;
  els.toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function humanizeNetworkError(error) {
  const message = error?.message || String(error);
  if (/Failed to fetch|NetworkError/i.test(message)) {
    // 浏览器出于安全考虑不会把失败原因告诉脚本——跨域被拒、证书有问题、
    // 端口不通，全都表现成同一句 Failed to fetch，只有控制台能看到真正原因。
    // 所以这里只能按这个工具的实际踩坑顺序提示：排第一的是填错地址。
    // 操作者常把浏览器里打开的登录页地址当接口地址填进来，而两者端口通常
    // 不同，登录页也不会返回跨域头——现象和"网络不通"一模一样。
    const target = state.apiBase ? `${state.apiBase} 的接口` : "业务接口";
    return `无法访问 ${target}。请先确认服务地址有没有填错——登录页的地址和接口地址通常不是同一个端口。地址确认无误后，再检查网络、代理、HTTPS 证书或跨域设置。`;
  }
  return message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
