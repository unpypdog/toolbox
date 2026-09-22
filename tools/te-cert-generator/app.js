"use strict";

/**
 * TE 培训证书批量生成 —— 页面逻辑。
 *
 * 两条产出路径：
 *   1) 本地生成 DOCX / ZIP —— 直接填充 word/document.xml，零网络、零后端。
 *   2) 云端转 PDF —— 把拼好的多页 DOCX 交给用户自己选的云转换服务，
 *      浏览器直连（各服务商都放行了 CORS，已实测），API Key 只存在本机
 *      localStorage，不经过任何中间服务器。
 *      **只有在用户显式选好服务商并填好密钥后才会联网**，默认不联网。
 *
 * 表格路径：一行写一条，姓名用顿号或逗号隔开，后面跟医院名称和日期，例如
 *   靳睿、耿楠、芮法娟、倪文婧 南京鼓楼医院 25年10月10日
 * 解析出来的每一行都会进预览表，姓名/医院/日期三个单元格可以直接点进去改。
 * 也保留 CSV / Excel 导入，供名单已经在表格里的场景。
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 500;
const TEMPLATE_TIMEOUT_MS = 15000;

/** 云转换凭据在本机浏览器里的存放键。只存本机，永不外发到别处。 */
const CLOUD_STORE_KEY = "te-cert-cloud-credentials-v1";

/** AI 解析设置的存放键（与服务商分开存，互不干扰） */
const AI_STORE_KEY = "te-cert-ai-settings-v1";

/** 输出命名偏好只含普通文本，单独存放；逐行覆盖不跨批次保存。 */
const NAMING_STORE_KEY = "te-cert-output-naming-v1";

/**
 * 当前页面是不是用 file:// 打开的。
 *
 * 这个判断很关键：file:// 页面的 origin 是不透明的 `null`，而多数服务商只在
 * **成功响应**里回 Access-Control-Allow-Origin，出错时（4xx/5xx）不带。
 * 于是浏览器的报错会变成一句极具误导性的
 *   "No 'Access-Control-Allow-Origin' header is present on the requested resource"
 * 把真正的 400 / 401 原因盖掉，让人以为是密钥或服务端配置问题，
 * 实际却是「用 file:// 打开」这件事本身导致的。
 * 实测（2026-09）：Adobe 的 IMS 令牌端点正是如此 —— 预检带 CORS 头、
 * 真实请求成功时也带，但 400 时不带。
 */
const IS_FILE_PROTOCOL = typeof location !== "undefined" && location.protocol === "file:";

const STATUS = {
  ready: { label: "可生成" },
  invalid: { label: "需处理" },
};

/** 快速输入框里的示例，同时也是「下载示例」里给的内容 */
const SAMPLE_TEXT = "靳睿、耿楠、芮法娟、倪文婧 南京鼓楼医院 25年10月10日";

const state = {
  records: [],
  nextLineNo: 1,
  selected: new Set(),
  template: "general",
  generating: false,
  source: "",
  fileMeta: "",
  parseNotes: [],
  /** 云转换服务商 id，空串表示未启用（默认不联网） */
  cloudProvider: "",
  /** 当前服务商的凭据，形如 { secret: "..." } 或 { clientId, clientSecret } */
  cloudCredentials: {},
  /** 让用户中途取消云转换 */
  cloudAbort: null,
  /** AI 解析服务商 id，空串表示未启用 */
  aiProvider: "",
  /** AI 解析设置：{ apiKey, model, endpoint } */
  aiSettings: {},
  /** PDF/ZIP 命名模板；初始化时会用 CertCore 的默认值覆盖。 */
  naming: {
    individual: "TE操作培训证书_{姓名}",
    merged: "TE操作培训证书_{份数}份_{时间}",
    archive: "TE操作培训证书_{时间}",
  },
  /** 待解析的图片：{ base64, mime, name } */
  aiImage: null,
  /** 让用户中途取消 AI 解析 */
  aiAbort: null,
  /** 编辑中的单元格定位，重渲染后用来恢复焦点与光标 */
  editing: null,
  /** 失焦是否由鼠标点击引起（用来决定要不要整表重绘） */
  pointerDown: false,
};

const templateCache = new Map();
const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "quickInput", "parseBtn", "clearInputBtn", "insertSampleBtn", "downloadSampleBtn",
    "fileInput", "fileDropLabel", "fileSummary", "fileName", "fileMeta",
    "pdfBtn", "selectedCount", "clearAllBtn",
    "progressBlock", "progressText", "progressPercent", "progressBar",
    "statusFilter", "statTotal", "statReady", "statProblem", "statDuplicate",
    "noticeBar", "emptyState", "tableRegion", "previewBody", "tableFootnote", "addRowBtn",
    "selectAll", "activityPanel", "activityClock", "activityLog", "toastRegion",
    "cloudProvider", "cloudFields", "cloudHelp", "cloudNote", "cloudSaveBtn", "cloudForgetBtn",
    "pdfMergeToggle", "pdfBtnLabel",
    "namingDetails", "pdfNamePattern", "mergedNamePattern", "zipNamePattern", "namingPreview",
    "namingResetBtn",
    "aiProvider", "aiFields", "aiHelp", "aiNote", "aiParseBtn", "aiImageInput", "aiImageLabel",
    "aiImageSummary", "aiImageName", "aiImageMeta", "aiClearImageBtn",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  if (!window.CertCore) {
    setNotice("生成核心脚本未加载，请刷新页面重试。", "error");
    return;
  }
  if (!window.CertCloud) {
    setNotice("云转换模块未加载，DOCX 生成仍可用。", "warn");
  }

  restoreCloudSettings();
  restoreAiSettings();
  restoreNamingSettings();
  bindEvents();
  render();
});

function bindEvents() {
  els.parseBtn.addEventListener("click", () => applyQuickInput());
  els.quickInput.addEventListener("keydown", (event) => {
    // Ctrl/Cmd + Enter 直接解析，免得上手去找按钮
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      applyQuickInput();
    }
  });
  els.quickInput.addEventListener("input", () => {
    els.parseBtn.disabled = !els.quickInput.value.trim();
    // AI 解析按钮的可用性也依赖文本（也接受「只有图片、没有文本」的情况）
    refreshButtons();
  });
  els.clearInputBtn.addEventListener("click", () => {
    els.quickInput.value = "";
    els.parseBtn.disabled = true;
    refreshButtons();
    els.quickInput.focus();
  });
  els.insertSampleBtn.addEventListener("click", () => {
    els.quickInput.value = els.quickInput.value.trim()
      ? els.quickInput.value.replace(/\s*$/, "\n") + SAMPLE_TEXT
      : SAMPLE_TEXT;
    els.parseBtn.disabled = false;
    els.quickInput.focus();
  });
  els.downloadSampleBtn.addEventListener("click", downloadSampleCsv);

  els.fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) void loadFile(file);
  });

  // 拖入文件必须 preventDefault，否则浏览器会直接打开这个文件、把页面带走
  ["dragenter", "dragover"].forEach((name) => {
    els.fileDropLabel.addEventListener(name, (event) => {
      event.preventDefault();
      els.fileDropLabel.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    els.fileDropLabel.addEventListener(name, (event) => {
      event.preventDefault();
      els.fileDropLabel.classList.remove("is-dragging");
    });
  });
  els.fileDropLabel.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (file) void loadFile(file);
  });
  els.fileDropLabel.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  els.statusFilter.addEventListener("change", renderTable);
  els.pdfBtn.addEventListener("click", () => void generatePdf());
  els.clearAllBtn.addEventListener("click", clearAll);
  els.addRowBtn.addEventListener("click", addRow);
  els.selectAll.addEventListener("change", () => toggleSelectAll(els.selectAll.checked));

  if (els.cloudProvider) {
    els.cloudProvider.addEventListener("change", () => {
      state.cloudProvider = els.cloudProvider.value;
      const stored = loadStoredCloud();
      state.cloudCredentials = (state.cloudProvider && stored[state.cloudProvider]) || {};
      renderCloudFields(stored);
      render();
    });
    // 输出方式开关：按钮文案跟着变，让用户点之前就知道会得到什么
    if (els.pdfMergeToggle) {
      els.pdfMergeToggle.addEventListener("change", () => {
        if (els.pdfBtnLabel) {
          els.pdfBtnLabel.textContent = els.pdfMergeToggle.checked
            ? "转换并下载 PDF（合并成一本）"
            : "转换并下载 PDF（每人一个）";
        }
      });
    }
    els.cloudSaveBtn.addEventListener("click", saveCloudSettings);
    els.cloudForgetBtn.addEventListener("click", forgetCloudSettings);
  }

  ["pdfNamePattern", "mergedNamePattern", "zipNamePattern"].forEach((id) => {
    if (!els[id]) return;
    els[id].addEventListener("input", onNamingInput);
  });
  if (els.namingResetBtn) {
    els.namingResetBtn.addEventListener("click", resetNamingSettings);
  }

  if (els.aiProvider) {
    els.aiProvider.addEventListener("change", () => {
      state.aiProvider = els.aiProvider.value;
      const stored = loadStoredAi();
      state.aiSettings = (state.aiProvider && stored[state.aiProvider]) || {};
      renderAiFields(stored);
      renderAiImageSummary();
      render();
    });

    // API Key / 模型名改动时就落盘，并刷新按钮可用性
    els.aiFields.addEventListener("input", () => {
      try {
        state.aiSettings = collectAiSettings();
      } catch {
        state.aiSettings = state.aiSettings || {};
      }
      persistAi();
      refreshButtons();
    });

    els.aiImageInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) void loadAiImage(file);
    });
    // 拖放：与 CSV 导入同一套交互，但要 preventDefault 否则浏览器会直接打开图片
    ["dragover", "dragenter"].forEach((name) => {
      els.aiImageLabel.addEventListener(name, (event) => {
        event.preventDefault();
        els.aiImageLabel.classList.add("is-dragging");
      });
    });
    ["dragleave", "dragend"].forEach((name) => {
      els.aiImageLabel.addEventListener(name, () => {
        els.aiImageLabel.classList.remove("is-dragging");
      });
    });
    els.aiImageLabel.addEventListener("drop", (event) => {
      event.preventDefault();
      els.aiImageLabel.classList.remove("is-dragging");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) void loadAiImage(file);
    });

    els.aiClearImageBtn.addEventListener("click", clearAiImage);
    els.aiParseBtn.addEventListener("click", () => void runAiParse());
  }

  document.querySelectorAll('input[name="template"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.template = input.value;
    });
  });

  // 单元格编辑：contenteditable 的 input 事件不会冒泡丢失，这里统一用捕获处理
  els.previewBody.addEventListener("input", onCellInput);
  els.previewBody.addEventListener("blur", onCellBlur, true);
  els.previewBody.addEventListener("keydown", onCellKeydown);
  els.previewBody.addEventListener("paste", onCellPaste);
  els.previewBody.addEventListener("change", onRowCheckboxChange);
  els.previewBody.addEventListener("click", onRowAction);
  // 记录「失焦是不是鼠标点出来的」：见 onCellBlur
  document.addEventListener("mousedown", () => {
    state.pointerDown = true;
    window.setTimeout(() => {
      state.pointerDown = false;
    }, 0);
  });
}

/* ------------------------------------------------------------ 快速输入 */

function applyQuickInput() {
  const text = els.quickInput.value;
  if (!text.trim()) return;

  let prepared;
  try {
    prepared = window.CertCore.prepareRecordsFromText(text);
  } catch (error) {
    setNotice(error.message || "解析失败。", "error");
    showToast(error.message || "解析失败。", "error");
    return;
  }

  // 重新解析会把当前编辑结果覆盖掉，所以给出可预期的追加语义：
  // 表格已有内容时，把新解析的行追加在后面
  const appended = state.records.length > 0;
  const offset = appended ? state.nextLineNo - 1 : 0;
  const incoming = prepared.records.map((record) => {
    record.lineNo += offset;
    return record;
  });
  const records = appended ? state.records.concat(incoming) : incoming;
  applyOutputNames(records);
  state.records = records;
  state.nextLineNo = records.length + 1;
  state.parseNotes = prepared.notes || [];
  state.source = "text";

  incoming.forEach((record) => {
    if (record.status === "ready") state.selected.add(record.lineNo);
  });

  logActivity(
    `解析快速输入：新增 ${incoming.length} 条` +
      (appended ? `（原有 ${records.length - incoming.length} 条保留）` : ""),
  );
  render();
  reportParseResult(incoming, prepared.notes);
}

function reportParseResult(incoming, notes) {
  const ready = incoming.filter((record) => record.status === "ready").length;
  const problem = incoming.length - ready;
  const parts = [`已解析 ${incoming.length} 条，其中 ${ready} 条可直接生成`];
  if (problem) parts.push(`${problem} 条需要在表格里补全`);
  if (notes && notes.length) parts.push(notes.join("；"));
  setNotice(parts.join("。") + "。", problem ? "warn" : "success");
  showToast(`已解析 ${incoming.length} 条记录。`, problem ? "error" : "success");
}

/* ---------------------------------------------------------- 文件导入 */

async function loadFile(file) {
  if (state.generating) return;
  const extension = file.name.split(".").pop().toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(extension)) {
    showToast("请选择 CSV、XLSX 或 XLS 文件。", "error");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showToast("文件超过 20MB，请拆分后再生成。", "error");
    return;
  }

  setNotice("正在本地解析文件…");
  try {
    // 换文件时先清掉上一次的编码信息，否则先导入 GBK 再导入 xlsx 会残留旧编码
    state.encoding = "";
    const matrix = extension === "csv" ? await readCsv(file) : await readWorkbook(file);
    const prepared = window.CertCore.prepareRecords(matrix);
    if (prepared.records.length > window.CertCore.MAX_ROWS) {
      throw new Error(
        `单次最多处理 ${window.CertCore.MAX_ROWS} 条记录，当前 ${prepared.records.length} 条，请拆分文件。`,
      );
    }
    state.records = prepared.records;
    state.nextLineNo = prepared.records.length + 1;
    state.selected = new Set(
      prepared.records.filter((record) => record.status === "ready").map((record) => record.lineNo),
    );
    state.source = "file";
    // 只写 state，DOM 交给 render()：两个地方都写会互相覆盖（曾经把 #fileMeta 写空）
    state.fileMeta =
      `${file.name} · ${prepared.records.length} 行` +
      (state.encoding ? ` · 编码=${state.encoding}` : "");

    const problem = prepared.records.length - countReady();
    setNotice(
      `已导入 ${prepared.records.length} 条` +
        (problem ? `，其中 ${problem} 条需要处理` : "") +
        (prepared.headerFound ? "" : "（未识别到表头，按前三列顺序解析）") +
        "。",
      problem ? "warn" : "success",
    );
    logActivity(`已导入 ${file.name}：${prepared.records.length} 条`);
    showToast(`已导入 ${prepared.records.length} 条记录。`);
  } catch (error) {
    setNotice(error.message || "文件解析失败，请检查格式。", "error");
    showToast(error.message || "文件解析失败。", "error");
  }
  render();
}

function countReady() {
  return state.records.filter((record) => record.status === "ready").length;
}

// 中文 Windows 上 Excel 导出的 CSV 默认是 GBK，而 File.text() 永远按 UTF-8 解码，
// 结果就是中文表头变乱码。所以自己读字节判断编码。
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
    // fatal 让非法字节直接抛错，而不是静默替换成 U+FFFD
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    /* 不是合法 UTF-8，继续往下试 */
  }
  for (const encoding of FALLBACK_ENCODINGS) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error("无法识别文件编码。请另存为 UTF-8 或 GBK 编码的 CSV 后重试。");
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
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  row.push(value);
  rows.push(row);
  return rows;
}

async function readCsv(file) {
  const decoded = decodeCsv(await file.arrayBuffer());
  state.encoding = decoded.encoding;
  return parseCsv(decoded.text);
}

async function readWorkbook(file) {
  if (!window.XLSX) {
    throw new Error("Excel 解析组件未加载。请检查文件是否完整，或先另存为 CSV。");
  }
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  if (!workbook.SheetNames.length) throw new Error("工作簿中没有可读取的工作表。");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
}

/* ------------------------------------------------------------ 表格编辑 */

function recordByLine(lineNo) {
  return state.records.find((record) => record.lineNo === lineNo);
}

function findCell(node) {
  return node && node.closest ? node.closest("[data-field]") : null;
}

function onCellInput(event) {
  const cell = findCell(event.target);
  if (!cell) return;
  const record = recordByLine(Number(cell.dataset.line));
  if (!record) return;

  const field = cell.dataset.field;
  const value = cell.textContent.replace(/\u00a0/g, " ").trim();
  // 输出文件名是当前批次的单行覆盖值，不参与证书数据校验。
  // 输入过程中不回写当前单元格，避免自动补 `.pdf` 打断光标；失焦时统一规范化显示。
  if (field === "outputName") {
    record.outputNameOverride = window.CertCore.stripOutputExtension(value);
    state.editing = { lineNo: record.lineNo, field: field };
    applyOutputNames(state.records);
    refreshFileNameCells(record.lineNo);
    refreshStats();
    return;
  }
  const revalidated = window.CertCore.validateRecord({
    name: field === "name" ? value : record.name,
    hospital: field === "hospital" ? value : record.hospital,
    dateRaw: field === "dateRaw" ? value : record.dateRaw,
  });
  // aiConflicts 里每条都记着它属于哪个字段（cert-ai 的 addRowIssue 保证的）。
  // 用户手动编辑某个字段，就等于亲自核对过这个字段 —— 所以只解除**这个字段**的冲突，
  // 其它字段的存疑必须原样留着。以前是无差别清空整行 note + 冲突，
  // 结果「改了个姓名」会把「日期存疑」一起抹掉，那条提醒再也不会出现。
  const aiField = field === "dateRaw" ? "date" : field;
  const remainingAiConflicts = Array.isArray(record.aiConflicts)
    ? record.aiConflicts.filter((item) => item && item.field !== aiField)
    : [];
  remainingAiConflicts.forEach((item) => {
    if (item.message && revalidated.issues.indexOf(item.message) < 0) {
      revalidated.issues.push(item.message);
    }
  });
  revalidated.status = revalidated.issues.length ? "invalid" : "ready";
  Object.assign(record, revalidated);
  record.aiConflicts = remainingAiConflicts;
  // 通用 aiNote 没有字段归属，无法按字段解除；它已经由 cert-ai 升级成 issue 了，
  // 这里保留原文用于展示（statusBadge 那行「AI 存疑：…」）。
  state.editing = { lineNo: record.lineNo, field: field };

  // 输出文件名依赖姓名，必须在这里重算：不能等失焦（点别处/不回点都不会触发），
  // 否则表格里显示的文件名会停在旧值上。
  applyOutputNames(state.records);

  // 只刷新这一行的状态与统计，避免整表重绘打断输入
  refreshRowStatus(record);
  refreshFileNameCells();
  pruneSelection();
  refreshStats();
  refreshButtons();
  refreshSelectAll();
}

function onCellBlur(event) {
  const cell = findCell(event.target);
  if (!cell) return;
  state.editing = null;
  applyOutputNames(state.records);

  // 鼠标点击造成的失焦不能整表重绘：重绘会把用户正准备点的「复制 / 删除」按钮从 DOM 里换掉，
  // 紧接着的 click 就落在了一个已脱离文档的元素上，第一次点击会被吞掉。
  // 这种情况下只就地刷新文件名单元格，结构保持不变。
  if (state.pointerDown) {
    refreshFileNameCells();
    return;
  }
  render();
}

/** 只同步输出文件名单元格，不重建表格。 */
function refreshFileNameCells(skipLineNo) {
  state.records.forEach((record) => {
    if (record.lineNo === skipLineNo) return;
    const row = els.previewBody.querySelector(`tr[data-line="${record.lineNo}"]`);
    const fileCell = row && row.querySelector(".col-file");
    if (fileCell) {
      fileCell.textContent = record.outputName || "—";
      fileCell.title = record.outputName || "";
    }
  });
}

function onCellKeydown(event) {
  const cell = findCell(event.target);
  if (!cell) return;
  if (event.key === "Enter") {
    // 让单元格可以换行输入会让表格行高失控，这里统一当「确认」
    event.preventDefault();
    cell.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cell.textContent = cell.dataset.original || "";
    cell.blur();
  }
}

function onCellPaste(event) {
  const cell = findCell(event.target);
  if (!cell) return;
  // 从 Excel 粘进来会带 HTML 与换行，只保留纯文本的第一行
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData("text/plain") || "";
  const clean = text.split(/\r?\n/)[0].replace(/\t/g, " ").trim();
  document.execCommand("insertText", false, clean);
}

function onRowCheckboxChange(event) {
  const box = event.target.closest('input[type="checkbox"][data-line]');
  if (!box) return;
  const lineNo = Number(box.dataset.line);
  if (box.checked) state.selected.add(lineNo);
  else state.selected.delete(lineNo);
  refreshButtons();
  refreshSelectAll();
}

function onRowAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const lineNo = Number(button.dataset.line);
  if (button.dataset.action === "remove") removeRow(lineNo);
  if (button.dataset.action === "duplicate") duplicateRow(lineNo);
}

function removeRow(lineNo) {
  state.records = state.records.filter((record) => record.lineNo !== lineNo);
  state.selected.delete(lineNo);
  applyOutputNames(state.records);
  logActivity(`已删除第 ${lineNo} 行`);
  render();
}

function duplicateRow(lineNo) {
  const source = recordByLine(lineNo);
  if (!source) return;
  const copy = window.CertCore.validateRecord({
    name: source.name,
    hospital: source.hospital,
    dateRaw: source.dateRaw,
  });
  if (source.outputNameOverride) copy.outputNameOverride = source.outputNameOverride;
  copy.lineNo = state.nextLineNo;
  state.nextLineNo += 1;
  state.records.push(copy);
  if (copy.status === "ready") state.selected.add(copy.lineNo);
  applyOutputNames(state.records);
  render();
}

function addRow() {
  // 追加一行时默认复制上一行的医院与日期，连续录入同批次名单会快很多
  const last = state.records[state.records.length - 1];
  const record = window.CertCore.validateRecord({
    name: "",
    hospital: last ? last.hospital : "",
    dateRaw: last ? last.dateRaw : "",
  });
  record.lineNo = state.nextLineNo;
  state.nextLineNo += 1;
  state.records.push(record);
  applyOutputNames(state.records);
  render();

  const cell = els.previewBody.querySelector(
    `[data-field="name"][data-line="${record.lineNo}"]`,
  );
  if (cell) {
    cell.focus();
    placeCaretAtEnd(cell);
  }
}

/** 主路径：把快速输入拆出的记录放进表格里逐个确认 */
function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  const records = state.records;
  const ready = countReady();
  const problem = records.length - ready;
  const duplicates = records.filter((record) => record.fileNameDuplicated).length;

  els.tableRegion.hidden = records.length === 0;
  els.emptyState.hidden = records.length > 0;
  els.fileSummary.hidden = state.source !== "file";
  if (state.source === "file") {
    const parts = String(state.fileMeta || "").split(" · ");
    els.fileName.textContent = parts[0] || "已导入文件";
    els.fileMeta.textContent = parts.slice(1).join(" · ");
  }

  renderTable();
  refreshStats();
  refreshButtons();
  refreshSelectAll();
}

function refreshStats() {
  const records = state.records;
  const ready = countReady();
  els.statTotal.textContent = String(records.length);
  els.statReady.textContent = String(ready);
  els.statProblem.textContent = String(records.length - ready);
  els.statDuplicate.textContent = String(
    records.filter((record) => record.fileNameDuplicated).length,
  );
}

function refreshButtons() {
  const ready = countReady();
  // PDF 走云转换，所以还要求先选好服务商；没选就不让点，避免点了才发现没配
  const cloudReady = Boolean(state.cloudProvider && window.CertCloud);
  els.pdfBtn.disabled = state.generating || ready === 0 || !cloudReady;
  els.clearAllBtn.disabled = state.generating || state.records.length === 0;
  els.addRowBtn.disabled = state.generating;
  els.selectAll.disabled = ready === 0;

  // 勾选数显示在表格底部：它决定「转全部」还是「只转勾选的」，得让用户看得见
  if (els.selectedCount) {
    els.selectedCount.textContent = state.selected.size
      ? `已勾选 ${state.selected.size} 条（将只转换这些）`
      : "未勾选（将转换全部可生成的）";
  }

  // AI 解析：选了服务、且（有文本或有图片）才可点。
  // 与 PDF 按钮同样的思路 —— 配置不全时先禁用，而不是点了才报错。
  if (els.aiParseBtn) {
    const hasContent = Boolean(els.quickInput.value.trim() || state.aiImage);
    const aiReady = Boolean(state.aiProvider && window.CertAi && hasContent);
    els.aiParseBtn.disabled = state.generating || !aiReady;
    els.aiClearImageBtn.disabled = state.generating || !state.aiImage;
  }
}

/** FileReader 的 Promise 封装，供 AI 图片读取用。 */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

function refreshSelectAll() {
  const ready = countReady();
  els.selectAll.checked = ready > 0 && state.selected.size === ready;
  els.selectAll.indeterminate = state.selected.size > 0 && state.selected.size < ready;
  els.selectAll.disabled = ready === 0;
}

/** 勾选集合里只保留「仍然可生成」的行，否则改了单元格后会残留幽灵勾选。 */
function pruneSelection() {
  const alive = new Set(
    state.records.filter((record) => record.status === "ready").map((record) => record.lineNo),
  );
  [...state.selected].forEach((lineNo) => {
    if (!alive.has(lineNo)) state.selected.delete(lineNo);
  });
}

/** 只更新某一行的状态徽标，用于输入过程中不打断光标 */
function refreshRowStatus(record) {
  const row = els.previewBody.querySelector(`tr[data-line="${record.lineNo}"]`);
  if (!row) return;
  const cell = row.querySelector(".col-status");
  if (!cell) return;
  cell.textContent = "";
  cell.appendChild(statusBadge(record));
  const fileCell = row.querySelector(".col-file");
  if (fileCell) fileCell.textContent = record.outputName || "—";
}

function statusBadge(record) {
  const wrap = document.createElement("div");
  const badge = document.createElement("span");
  badge.className = `status-badge is-${record.status}`;
  badge.textContent = STATUS[record.status].label;
  wrap.appendChild(badge);
  if (record.issues.length) {
    const hint = document.createElement("small");
    hint.textContent = record.issues.join("；");
    wrap.appendChild(hint);
  }
  // AI 的疑问备注单独一行展示具体细节；cert-ai 同时会把它升级为 issue，
  // 让该行进入「需处理」且不自动勾选。证书信息不能带着模型疑问直接生成。
  if (record.aiNote) {
    const note = document.createElement("small");
    note.className = "ai-note";
    note.textContent = "AI 存疑：" + record.aiNote;
    wrap.appendChild(note);
  }
  return wrap;
}

function visibleRecords() {
  const filter = els.statusFilter.value;
  return state.records.filter((record) => {
    if (filter === "problem") return record.status === "invalid";
    if (filter === "ready") return record.status === "ready";
    if (filter === "duplicate") return record.fileNameDuplicated;
    return true;
  });
}

function renderTable() {
  const list = visibleRecords();
  const shown = list.slice(0, MAX_PREVIEW_ROWS);
  els.previewBody.textContent = "";

  shown.forEach((record) => {
    const row = document.createElement("tr");
    row.dataset.line = String(record.lineNo);
    if (record.status === "invalid") row.className = "is-invalid";

    const pick = document.createElement("td");
    pick.className = "col-pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.line = String(record.lineNo);
    box.checked = state.selected.has(record.lineNo);
    box.disabled = record.status !== "ready" || state.generating;
    box.setAttribute("aria-label", `选择第 ${record.lineNo} 行 ${record.name || "（无姓名）"}`);
    pick.appendChild(box);
    row.appendChild(pick);

    row.appendChild(cell(String(record.lineNo), "col-line"));
    row.appendChild(editableCell(record, "name", record.name, "姓名", "col-name"));
    row.appendChild(editableCell(record, "hospital", record.hospital, "医院名称", "col-hospital"));
    row.appendChild(editableCell(record, "dateRaw", record.dateRaw, "颁发日期", "col-date"));

    const fileCell = editableCell(
      record,
      "outputName",
      record.outputName || "",
      "输出文件名（扩展名固定为 PDF）",
      "col-file",
    );
    fileCell.title = record.outputName || "";
    row.appendChild(fileCell);

    const statusCell = document.createElement("td");
    statusCell.className = "col-status";
    statusCell.appendChild(statusBadge(record));
    row.appendChild(statusCell);

    const actions = document.createElement("td");
    actions.className = "col-actions";
    actions.appendChild(rowButton("duplicate", record.lineNo, "复制本行", "⧉"));
    actions.appendChild(rowButton("remove", record.lineNo, "删除本行", "✕"));
    row.appendChild(actions);

    els.previewBody.appendChild(row);
  });

  const parts = [`共 ${list.length} 条`];
  if (list.length > shown.length) parts.push(`表格只显示前 ${MAX_PREVIEW_ROWS} 条，生成不受影响`);
  parts.push("姓名、医院、日期和输出文件名都可直接修改，PDF 后缀由系统固定");
  els.tableFootnote.textContent = parts.join(" · ") + "。";

  // 编辑中的单元格在重绘后恢复焦点与光标，避免用户打字打到一半被打断
  if (state.editing) {
    const node = els.previewBody.querySelector(
      `[data-field="${state.editing.field}"][data-line="${state.editing.lineNo}"]`,
    );
    if (node) {
      node.focus();
      placeCaretAtEnd(node);
    }
    state.editing = null;
  }
}

function cell(text, className) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

/** aiSources 的取值形如 "image" / "text:global" / "text:named"，转成人话。 */
function sourceLabel(source) {
  if (source === "image") return "图片";
  const scope = String(source).replace(/^text:/, "");
  if (scope === "global") return "文字（整批）";
  if (scope === "named") return "文字（点名）";
  if (scope === "rows") return "文字（按行）";
  if (scope === "ordered") return "文字（按顺序）";
  return "文字";
}

function editableCell(record, field, value, label, className) {
  const td = document.createElement("td");
  td.className = className + " is-editable";
  td.dataset.field = field;
  td.dataset.line = String(record.lineNo);
  td.dataset.original = value || "";
  td.contentEditable = state.generating ? "false" : "true";
  td.spellcheck = false;
  td.setAttribute("role", "textbox");
  td.setAttribute("aria-label", `第 ${record.lineNo} 行 ${label}`);
  // AI 结果标出每个字段的来源：图片上的原值，还是文字覆盖进来的、按什么作用范围。
  // 只看表格分不清「这个日期是图上印的还是我写的」，核对时要的就是这一条线索。
  // 注意字段名对不上：aiSources 用 core 约定的 `date`，而这一列是 `dateRaw`。
  const source = record.aiSources && record.aiSources[field === "dateRaw" ? "date" : field];
  if (source && value) {
    td.dataset.source = source;
    td.title = `来源：${sourceLabel(source)}`;
  }
  td.textContent = value || "";
  if (!value) td.classList.add("is-blank");
  return td;
}

function rowButton(action, lineNo, title, glyph) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.dataset.action = action;
  button.dataset.line = String(lineNo);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = glyph;
  return button;
}

function toggleSelectAll(shouldSelect) {
  state.records.forEach((record) => {
    if (record.status !== "ready") return;
    if (shouldSelect) state.selected.add(record.lineNo);
    else state.selected.delete(record.lineNo);
  });
  render();
}

/* ----------------------------------------------------------- 提示与进度 */

function setNotice(message, tone) {
  els.noticeBar.classList.remove("is-error", "is-warn", "is-success");
  if (tone) els.noticeBar.classList.add("is-" + tone);
  els.noticeBar.querySelector("span").textContent = message;
}

function logActivity(message) {
  els.activityPanel.hidden = false;
  els.activityClock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const item = document.createElement("li");
  const stamp = document.createElement("time");
  stamp.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  item.appendChild(stamp);
  item.appendChild(text);
  els.activityLog.prepend(item);
  while (els.activityLog.children.length > 30) {
    els.activityLog.lastElementChild.remove();
  }
}

function showToast(message, tone) {
  const toast = document.createElement("div");
  toast.className = "toast" + (tone ? " is-" + tone : "");
  toast.textContent = message;
  els.toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function setProgress(current, total, label) {
  els.progressBlock.hidden = false;
  const percent = total ? Math.round((current / total) * 100) : 0;
  els.progressText.textContent = label || `正在生成 ${current} / ${total}`;
  els.progressPercent.textContent = percent + "%";
  els.progressBar.style.width = percent + "%";
}

function resetProgress() {
  els.progressBlock.hidden = true;
  els.progressBar.style.width = "0%";
}

/* -------------------------------------------------------------- 模板读取 */

/**
 * 模板从哪来？
 *
 * 优先用同目录的 .b64.js 载荷（<script> 按需加载）：
 *   file:// 下 Chromium 一律拒绝 fetch 同目录文件（TypeError: Failed to fetch），
 *   放开 CSP 的 connect-src、加 --allow-file-access-from-files 都没用；
 *   但 <script src="本地文件"> 是允许的，所以把 docx 字节 base64 后放进 js 里。
 *   这条路径在 file:// 和 GitHub Pages 上都成立，因此作为主路径。
 *
 * fetch 原始 docx 只作为兜底：万一 .b64.js 没同步（改了模板忘了重新生成），
 * http(s) 部署下还能回退到真文件，不至于整个工具不可用。
 */
const TEMPLATE_LOADERS = {
  general: {
    label: "一般版本模板",
    global: "CERT_TEMPLATE_GENERAL",
    script: "template-general.b64.js",
    file: "template-general.docx",
  },
  special: {
    label: "260513 特殊版本模板",
    global: "CERT_TEMPLATE_SPECIAL",
    script: "template-special.b64.js",
    file: "template-special.docx",
  },
};

/** 注入一个本地 js 并等它执行完（脚本里会把 window[global] 挂上）。 */
function loadScriptOnce(src, globalName) {
  return new Promise((resolve, reject) => {
    if (window[globalName]) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[data-template="${globalName}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src + " 加载失败。")));
      return;
    }
    const script = document.createElement("script");
    script.src = "./" + src;
    script.dataset.template = globalName;
    script.addEventListener("load", () => {
      if (window[globalName]) resolve();
      else reject(new Error(`${src} 已加载但没有提供 ${globalName}。`));
    });
    script.addEventListener("error", () => reject(new Error(src + " 加载失败，请确认文件存在。")));
    document.head.appendChild(script);
  });
}

async function loadTemplate(templateId) {
  if (templateCache.has(templateId)) return templateCache.get(templateId);
  const spec = TEMPLATE_LOADERS[templateId];
  if (!spec) throw new Error("未知的模板：" + templateId);

  let bytes = null;
  try {
    await loadScriptOnce(spec.script, spec.global);
    const payload = window[spec.global];
    bytes = window.CertCore.base64ToBytes(payload.base64);
  } catch (error) {
    // 回退到直接读取 docx（http(s) 下可用）
    bytes = await window.CertCore.fetchBytes("./" + spec.file, TEMPLATE_TIMEOUT_MS);
  }

  const checked = await window.CertCore.assertTemplate(bytes, spec.label);
  templateCache.set(templateId, checked);
  return checked;
}

/* -------------------------------------------------------------- 输出命名 */

function namingDefaults() {
  return Object.assign(
    {
      individual: "TE操作培训证书_{姓名}",
      merged: "TE操作培训证书_{份数}份_{时间}",
      archive: "TE操作培训证书_{时间}",
    },
    window.CertCore.DEFAULT_NAMING_PATTERNS || {},
  );
}

function loadStoredNaming() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAMING_STORE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function namingPattern(key) {
  const defaults = namingDefaults();
  const value = String((state.naming && state.naming[key]) || "").trim();
  return value || defaults[key];
}

function persistNamingSettings() {
  try {
    localStorage.setItem(NAMING_STORE_KEY, JSON.stringify(state.naming));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，本次会话内仍然有效 */
  }
}

function restoreNamingSettings() {
  const defaults = namingDefaults();
  const stored = loadStoredNaming();
  state.naming = {
    individual: String(stored.individual || defaults.individual),
    merged: String(stored.merged || defaults.merged),
    archive: String(stored.archive || defaults.archive),
  };
  if (els.pdfNamePattern) els.pdfNamePattern.value = state.naming.individual;
  if (els.mergedNamePattern) els.mergedNamePattern.value = state.naming.merged;
  if (els.zipNamePattern) els.zipNamePattern.value = state.naming.archive;
  renderNamingPreview();
}

function applyOutputNames(records) {
  return window.CertCore.assignOutputNames(records || state.records, {
    pattern: namingPattern("individual"),
  });
}

function renderNamingPreview() {
  if (!els.namingPreview || !window.CertCore) return;
  const sample = {
    姓名: "张三",
    医院: "示例医院",
    日期: "2025-10-20",
    序号: "1",
    份数: "3",
    时间: "20250922_1200",
  };
  const individual = window.CertCore.renderFileName(
    namingPattern("individual"), sample, "TE操作培训证书_张三", "pdf",
  );
  const merged = window.CertCore.renderFileName(
    namingPattern("merged"), sample, "TE操作培训证书_3份", "pdf",
  );
  const archive = window.CertCore.renderFileName(
    namingPattern("archive"), sample, "TE操作培训证书", "zip",
  );
  els.namingPreview.textContent = `示例：${individual} · 合并：${merged} · 压缩包：${archive}`;
}

function onNamingInput() {
  state.naming = {
    individual: els.pdfNamePattern ? els.pdfNamePattern.value : namingPattern("individual"),
    merged: els.mergedNamePattern ? els.mergedNamePattern.value : namingPattern("merged"),
    archive: els.zipNamePattern ? els.zipNamePattern.value : namingPattern("archive"),
  };
  persistNamingSettings();
  applyOutputNames(state.records);
  refreshFileNameCells();
  refreshStats();
  renderNamingPreview();
}

function resetNamingSettings() {
  state.naming = namingDefaults();
  try {
    localStorage.removeItem(NAMING_STORE_KEY);
  } catch {
    /* 本次会话仍然可以恢复默认值 */
  }
  if (els.pdfNamePattern) els.pdfNamePattern.value = state.naming.individual;
  if (els.mergedNamePattern) els.mergedNamePattern.value = state.naming.merged;
  if (els.zipNamePattern) els.zipNamePattern.value = state.naming.archive;
  applyOutputNames(state.records);
  refreshFileNameCells();
  refreshStats();
  renderNamingPreview();
  showToast("文件命名已恢复默认值。");
}

/* ------------------------------------------------------------ 云转换设置 */

/**
 * 凭据只写 localStorage，不写 cookie、不发往任何第三方。
 * 这里刻意不做混淆：它本来就是用户自己的密钥，藏起来只会让人误以为安全。
 */
function loadStoredCloud() {
  try {
    const raw = localStorage.getItem(CLOUD_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCloud() {
  try {
    const all = loadStoredCloud();
    if (state.cloudProvider) {
      all[state.cloudProvider] = state.cloudCredentials;
      localStorage.setItem(CLOUD_STORE_KEY, JSON.stringify(all));
    }
  } catch {
    /* 隐私模式下 localStorage 可能不可写，静默降级为「本次会话有效」 */
  }
}

function restoreCloudSettings() {
  if (!window.CertCloud || !els.cloudProvider) return;

  els.cloudProvider.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "不转换（仅生成本地文件）";
  els.cloudProvider.appendChild(none);
  window.CertCloud.PROVIDERS.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label + "（" + provider.freeNote + "）";
    els.cloudProvider.appendChild(option);
  });

  const stored = loadStoredCloud();
  // 默认选中「不转换」：绝不能在用户没明确同意前把证书传出去
  state.cloudProvider = "";
  state.cloudCredentials = {};
  els.cloudProvider.value = "";
  renderCloudFields(stored);
}

/** 按当前选中的服务商重建密钥输入框。 */
function renderCloudFields(stored) {
  if (!els.cloudFields || !window.CertCloud) return;
  els.cloudFields.textContent = "";

  const fileHint = IS_FILE_PROTOCOL
    ? "\n\n⚠ 当前页面是用 file:// 打开的（双击 HTML）。跨域请求在这种页面上" +
      "会因 origin 为 null 而被浏览器拦掉，报出来往往是一句误导性的" +
      "「No 'Access-Control-Allow-Origin' header」。想用云转换，请改用" +
      "本地服务器（在项目根目录执行 python -m http.server 8000，然后打开" +
      "http://127.0.0.1:8000/tools/te-cert-generator/index.html）" +
      "或部署到 GitHub Pages。DOCX 生成不受影响，file:// 下照常可用。"
    : "";

  const provider = window.CertCloud.getProvider(state.cloudProvider);
  if (!provider) {
    els.cloudHelp.textContent = "";
    if (els.cloudNote) {
      els.cloudNote.textContent = IS_FILE_PROTOCOL
        ? "默认不联网。注意：file:// 下云转换不可用（origin 为 null 会被浏览器拦），" +
          "DOCX 生成不受影响。"
        : "默认不联网。姓名、医院、日期只在本机浏览器里处理。";
    }
    if (els.cloudSaveBtn) els.cloudSaveBtn.disabled = true;
    if (els.cloudForgetBtn) els.cloudForgetBtn.disabled = true;
    return;
  }

  const saved = (stored && stored[provider.id]) || state.cloudCredentials || {};
  const spec = provider.credential;
  const fields = spec.fields || [{ name: spec.key, label: spec.label, placeholder: spec.placeholder, secret: true }];

  fields.forEach((field) => {
    const label = document.createElement("label");
    label.className = "cloud-field";
    const caption = document.createElement("span");
    caption.textContent = field.label;
    const input = document.createElement("input");
    input.type = field.secret === false ? "text" : "password";
    input.dataset.cloudField = field.name;
    input.placeholder = field.placeholder || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = saved[field.name] || "";
    label.appendChild(caption);
    label.appendChild(input);
    els.cloudFields.appendChild(label);
  });

  els.cloudHelp.textContent = (spec.help || "") + fileHint;
  if (els.cloudNote) {
    els.cloudNote.textContent =
      "⚠ 选好服务商后，证书内容会发送给 " +
      provider.label +
      "。只在你确认可以外发时使用。" +
      (IS_FILE_PROTOCOL ? "\n⚠ 但当前是 file:// 打开，云转换会被浏览器拦下，需改用本地服务器。" : "");
  }
  if (els.cloudSaveBtn) els.cloudSaveBtn.disabled = false;
  if (els.cloudForgetBtn) els.cloudForgetBtn.disabled = false;
}

/** 从输入框收集凭据。缺项直接报错，不要带着半份密钥去发请求。 */
function collectCloudCredentials() {
  const provider = window.CertCloud.getProvider(state.cloudProvider);
  if (!provider) return null;
  const credentials = {};
  const inputs = els.cloudFields.querySelectorAll("[data-cloud-field]");
  for (const input of inputs) {
    const value = input.value.trim();
    if (!value) {
      throw new Error("请先填写「" + (input.previousSibling ? input.previousSibling.textContent : "密钥") + "」。");
    }
    credentials[input.dataset.cloudField] = value;
  }
  return credentials;
}

function saveCloudSettings() {
  try {
    const credentials = collectCloudCredentials();
    if (!credentials) return;
    state.cloudCredentials = credentials;
    persistCloud();
    setNotice("云转换密钥已保存在本机浏览器。证书内容只有在你点「转换并下载 PDF」时才会外发。", "success");
    showToast("密钥已保存在本机。", "success");
  } catch (error) {
    setNotice(error.message, "error");
    showToast(error.message, "error");
  }
}

function forgetCloudSettings() {
  try {
    const all = loadStoredCloud();
    if (state.cloudProvider) delete all[state.cloudProvider];
    localStorage.setItem(CLOUD_STORE_KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
  state.cloudCredentials = {};
  els.cloudFields.querySelectorAll("[data-cloud-field]").forEach((input) => {
    input.value = "";
  });
  setNotice("已清除本机保存的密钥。", "success");
  showToast("已清除本机保存的密钥。");
}

/* ------------------------------------------------------------ AI 解析设置 */

/**
 * AI 是「增强」不是「替代」：规则解析仍是默认路径（免费、离线、可预测）。
 * 只有规则解析失败、或输入是图片时才需要它。
 * 与云转换一致：默认不选服务商 = 不联网；密钥只存本机 localStorage。
 */
function loadStoredAi() {
  try {
    const raw = localStorage.getItem(AI_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistAi() {
  try {
    const all = loadStoredAi();
    if (state.aiProvider && state.aiSettings) {
      all[state.aiProvider] = state.aiSettings;
      localStorage.setItem(AI_STORE_KEY, JSON.stringify(all));
    }
  } catch {
    /* 隐私模式下不可写，降级为本次会话有效 */
  }
}

function restoreAiSettings() {
  if (!window.CertAi || !els.aiProvider) return;

  els.aiProvider.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "不用 AI（仅用规则解析）";
  els.aiProvider.appendChild(none);
  window.CertAi.PROVIDERS.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    els.aiProvider.appendChild(option);
  });

  const stored = loadStoredAi();
  // 默认「不用 AI」：不能在用户没明确同意前把名单发出去
  const first = window.CertAi.PROVIDERS[0];
  state.aiProvider = "";
  state.aiSettings = {};
  els.aiProvider.value = "";
  renderAiFields(Object.assign({}, stored, first ? { [first.id]: stored[first.id] || {} } : {}));
  renderAiImageSummary();
}

function renderAiFields(stored) {
  if (!els.aiFields || !window.CertAi) return;
  els.aiFields.textContent = "";

  const provider = window.CertAi.getProvider(state.aiProvider);
  if (!provider) {
    els.aiHelp.textContent = "";
    if (els.aiNote) {
      els.aiNote.textContent = "默认不联网。规则解析免费、离线，覆盖日常绝大多数写法。";
    }
    refreshButtons();
    return;
  }

  const saved = (stored && stored[provider.id]) || state.aiSettings || {};

  const addField = (name, label, placeholder, value, secret) => {
    const wrap = document.createElement("label");
    wrap.className = "cloud-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.dataset.aiField = name;
    input.placeholder = placeholder || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = value || "";
    wrap.appendChild(caption);
    wrap.appendChild(input);
    els.aiFields.appendChild(wrap);
  };

  addField("apiKey", "API Key", provider.keyPlaceholder, saved.apiKey, true);
  addField("model", "模型名", provider.defaultModel || "例如 deepseek-flash", saved.model || provider.defaultModel, false);
  // 「其它 OpenAI 兼容接口」需要手填地址
  if (!provider.endpoint) {
    addField("endpoint", "接口地址", "https://…/v1/chat/completions", saved.endpoint, false);
  }

  els.aiHelp.textContent = provider.help || "";
  if (els.aiNote) {
    els.aiNote.textContent =
      "⚠ 点「AI 解析」会把左侧文本与所选图片发送给 " +
      provider.label +
      "。图片尤其注意：签到表上往往还有别的信息。" +
      "抽取结果会逐条过校验，缺项红标，但**请务必对着原图核对姓名**。";
  }
  refreshButtons();
}

/** 从输入框收集 AI 设置。缺 Key 或缺模型名时报错，不带半份配置去发请求。 */
function collectAiSettings() {
  const provider = window.CertAi.getProvider(state.aiProvider);
  if (!provider) return null;
  const settings = {};
  els.aiFields.querySelectorAll("[data-ai-field]").forEach((input) => {
    settings[input.dataset.aiField] = input.value.trim();
  });
  if (!settings.apiKey) throw new Error("请先填写 API Key。");
  if (!settings.model) settings.model = provider.defaultModel;
  if (!settings.model) throw new Error("请先填写模型名。");
  // 用默认端点的服务商，不需要用户填地址
  if (provider.endpoint) settings.endpoint = provider.endpoint;
  if (!settings.endpoint) throw new Error("请先填写接口地址。");
  return settings;
}

/** 把 File 读成 { base64, mime, name }，本地先做格式与体积检查。 */
async function loadAiImage(file) {
  try {
    const image = await window.CertAi.readImageFile(file, readAsDataUrl);
    state.aiImage = image;
    renderAiImageSummary();
    render();
    setNotice("已选择图片「" + image.name + "」，点「AI 解析」开始识别。", "success");
  } catch (error) {
    state.aiImage = null;
    els.aiImageInput.value = "";
    renderAiImageSummary();
    render();
    setNotice(error.message, "error");
    showToast(error.message, "error");
  }
}

function clearAiImage() {
  state.aiImage = null;
  els.aiImageInput.value = "";
  renderAiImageSummary();
  render();
  setNotice("已移除图片。");
}

function renderAiImageSummary() {
  if (!els.aiImageSummary) return;
  const image = state.aiImage;
  els.aiImageSummary.classList.toggle("is-empty", !image);
  els.aiImageName.textContent = image ? image.name : "尚未选择图片";
  els.aiImageMeta.textContent = image
    ? image.mime.replace("image/", "").toUpperCase()
    : "";
}

/**
 * 用 AI 抽取名单，并把结果按与规则解析**相同的语义**并入表格。
 *
 * 追加而不是覆盖：与「解析到表格」一致，表格已有内容时新记录接在后面。
 * 反过来说，重新解析不会清掉用户手改过的行 —— 这一点必须保持一致，
 * 否则用户改完再点一次 AI 就白改了。
 */
async function runAiParse() {
  if (state.generating) return;

  if (!window.CertAi) {
    setNotice("AI 解析模块未加载，请刷新页面。", "error");
    return;
  }
  if (!state.aiProvider) {
    setNotice("请先在「交给 AI 解析」里选择一个服务。默认不联网。", "warn");
    showToast("请先选择 AI 服务。", "error");
    els.aiProvider.focus();
    return;
  }

  let settings;
  try {
    settings = collectAiSettings();
  } catch (error) {
    setNotice(error.message, "error");
    showToast(error.message, "error");
    return;
  }
  state.aiSettings = settings;
  persistAi();

  const text = els.quickInput.value.trim();
  if (!text && !state.aiImage) {
    setNotice("没有可解析的内容：请填文本，或选一张名单图片。", "error");
    showToast("请先填文本或选图片。", "error");
    return;
  }

  const provider = window.CertAi.getProvider(state.aiProvider);
  state.generating = true;
  state.aiAbort = new AbortController();
  render();
  setProgress(0, 1, "准备中");
  logActivity(`开始 AI 解析（${provider.label}${state.aiImage ? "，含图片" : ""}）`);

  try {
    const result = await window.CertAi.extractRecords({
      text: text,
      image: state.aiImage,
      apiKey: settings.apiKey,
      model: settings.model,
      endpoint: settings.endpoint,
      core: window.CertCore,
      signal: state.aiAbort.signal,
      onStage: (stage) => setProgress(0, 1, stage),
    });

    if (!result.records.length) {
      throw new Error(
        result.unreadable
          ? "没有抽出任何记录：" + result.unreadable
          : "没有抽出任何记录。请确认内容里确实有姓名，或换一张更清晰的图片。",
      );
    }

    // 与规则解析相同的合并语义：追加、重排行号、重算输出文件名、只勾选可生成的
    const appended = state.records.length > 0;
    const offset = appended ? state.nextLineNo - 1 : 0;
    const incoming = result.records.map((record) => {
      record.lineNo += offset;
      return record;
    });
    const records = appended ? state.records.concat(incoming) : incoming;
    applyOutputNames(records);
    state.records = records;
    state.nextLineNo = records.length + 1;
    state.source = "ai";
    incoming.forEach((record) => {
      if (record.status === "ready") state.selected.add(record.lineNo);
    });

    resetProgress();
    render();

    const noted = incoming.filter((record) => record.aiNote).length;
    const notes = Array.isArray(result.warnings) ? result.warnings.slice() : [];
    if (result.unreadable) notes.push(result.unreadable);
    if (noted) notes.push(`${noted} 条 AI 标了存疑，请重点核对`);
    reportParseResult(incoming, notes);

    logActivity(
      `AI 解析完成：新增 ${incoming.length} 条` +
        (appended ? `（原有 ${records.length - incoming.length} 条保留）` : "") +
        (result.usage ? `，用了 ${result.usage.total_tokens || "?"} tokens` : ""),
    );
    if (noted) {
      setNotice(
        `AI 抽出 ${incoming.length} 条，其中 ${noted} 条模型自己标了存疑 —— ` +
          "请对着原文/原图逐条核对姓名后再生成。",
        "warn",
      );
    }
  } catch (error) {
    resetProgress();
    const message =
      error && error.name === "AbortError" ? "已取消 AI 解析。" : error.message || "AI 解析失败。";
    setNotice(message, "error");
    showToast(message, "error");
    logActivity("AI 解析失败：" + message);
  } finally {
    state.generating = false;
    state.aiAbort = null;
    render();
  }
}

/* -------------------------------------------------------- 生成与下载 DOCX */

/** 让出一帧给界面刷新。requestAnimationFrame 在后台标签页/无头环境可能不触发，
 *  所以和 setTimeout 赛跑：谁先到用谁，避免生成流程被卡住。 */
function nextFrame() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    window.requestAnimationFrame(done);
    window.setTimeout(done, 40);
  });
}


function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "_" +
    pad(now.getHours()) +
    pad(now.getMinutes())
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让部分浏览器下载中断，留足时间再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------------------------------------------ 生成 PDF */

/** 可生成的记录（ZIP 与 PDF 都用这个口径） */
function printableRecords() {
  return state.records.filter((record) => record.status === "ready");
}

/**
 * 逐份生成证书 docx。
 *
 * needDocumentXml 决定要不要顺带取出 document.xml：
 *   逐份转换（默认）只需要 docx；只有合批才需要 document.xml 去拼多页文档。
 *   多一步 unzip 就多一分开销，默认模式下不做无用的解析。
 */
async function buildCertificateItems(targets, templateBytes, needDocumentXml, onTick) {
  const items = [];
  const failed = [];
  for (let index = 0; index < targets.length; index += 1) {
    const record = targets[index];
    try {
      const docx = await window.CertCore.buildDocx(templateBytes, {
        name: record.name,
        hospital: record.hospital,
        year: record.date.year,
        month: record.date.month,
        day: record.date.day,
      });
      const item = {
        name: record.name,
        docx: docx,
        // 预览与最终下载共用同一个已消毒、已去重的 PDF 文件名。
        fileName: record.outputName || (record.fileBase || "TE操作培训证书_" + record.name) + ".pdf",
      };
      if (needDocumentXml) {
        const entries = await window.CertCore.readZip(docx);
        const entry = entries.find((each) => each.name === "word/document.xml");
        if (!entry) throw new Error("生成的 docx 缺少 word/document.xml");
        item.documentXml = entry.data;
      }
      items.push(item);
    } catch (error) {
      failed.push({ record: record, message: error.message || String(error) });
    }
    if (onTick) onTick(index + 1, targets.length);
  }
  return { items: items, failed: failed };
}

/**
 * 云端转 PDF。
 *
 * 走「合批」：N 份证书拼成一份 N 页 DOCX，一次请求换回一份 N 页 PDF。
 * 这样既不必在前端合并 PDF（云端产物是对象流 PDF，前端合并代价高），
 * 又能在 Adobe 那边把 N 次计费压成 1 次（1 事务最多 50 页）。
 *
 * 合批不是必须的：模板不一致时 cert-cloud 会抛错，那时自动退回逐份转换。
 */
async function generatePdf() {
  if (state.generating || !state.records.length) return;

  if (!window.CertCloud) {
    setNotice("云转换模块未加载，请刷新页面；本地 DOCX 生成不受影响。", "error");
    showToast("云转换模块未加载。", "error");
    return;
  }
  if (!state.cloudProvider) {
    setNotice("请先在左侧「PDF 转换服务」里选择一个服务商。默认不联网转换。", "warn");
    showToast("请先选择 PDF 转换服务。", "error");
    els.cloudProvider.focus();
    return;
  }

  const targets = state.records.filter(
    (record) => record.status === "ready" && state.selected.has(record.lineNo),
  );
  const list = targets.length ? targets : printableRecords();
  if (!list.length) {
    showToast("没有可生成 PDF 的记录。", "error");
    return;
  }
  if (list.length > window.CertCloud.MAX_BATCH) {
    setNotice(
      `一次最多转换 ${window.CertCloud.MAX_BATCH} 份，当前 ${list.length} 份。请勾选后分批转换。`,
      "error",
    );
    showToast(`超过 ${window.CertCloud.MAX_BATCH} 份，请分批。`, "error");
    return;
  }

  let credentials;
  try {
    credentials = collectCloudCredentials();
  } catch (error) {
    setNotice(error.message, "error");
    showToast(error.message, "error");
    return;
  }
  state.cloudCredentials = credentials;
  persistCloud();

  const provider = window.CertCloud.getProvider(state.cloudProvider);
  const meta = window.CertCore.TEMPLATES[state.template];
  // 默认逐份：证书是发给个人的，每人拿到自己那张 TE操作培训证书_姓名.pdf。
  // 合成一本再发下去，收件人还得自己找自己那页 —— 实际使用中不接受。
  const wantMerged = Boolean(els.pdfMergeToggle && els.pdfMergeToggle.checked);
  state.generating = true;
  state.cloudAbort = new AbortController();
  render();
  setProgress(0, list.length, "正在生成证书…");
  logActivity(
    `开始云端转 PDF（${provider.label}，${list.length} 份，${meta.label}，` +
      (wantMerged ? "合并为一份多页 PDF）" : "每人一个独立 PDF）"),
  );

  try {
    const templateBytes = await loadTemplate(state.template);
    const built = await buildCertificateItems(
      list,
      templateBytes,
      wantMerged, // 只有合批才需要 document.xml
      (done, total) => {
        if (done % 3 === 0 || done === total) {
          setProgress(done, total, `正在生成证书 ${done} / ${total}`);
        }
      },
    );
    built.failed.forEach((item) =>
      logActivity(`跳过 ${item.record.name || "（无姓名）"}：${item.message}`),
    );
    if (!built.items.length) throw new Error("所有记录都生成失败了，请检查模板文件是否完整。");

    const result = await window.CertCloud.convertBatch({
      items: built.items,
      providerId: state.cloudProvider,
      credentials: credentials,
      batch: wantMerged,
      readZip: window.CertCore.readZip,
      writeZip: window.CertCore.writeZip,
      signal: state.cloudAbort.signal,
      onProgress: (info) => {
        const total = info.total || 1;
        const done = info.done || 0;
        setProgress(done, total, `${provider.label} · ${info.stage || "处理中"}`);
      },
    });

    result.failed.forEach((item) => logActivity(`转换失败 ${item.name}：${item.error}`));
    if (!result.pdfList.length) {
      throw new Error(
        result.failed.length
          ? "转换全部失败：" + result.failed[0].error
          : "转换没有返回任何 PDF。",
      );
    }

    setProgress(list.length, list.length, "正在保存…");
    let savedBytes = 0;
    const outputStamp = timestamp();
    const aggregateValues = { 份数: list.length, 时间: outputStamp };
    const mergedFileName = window.CertCore.renderFileName(
      namingPattern("merged"),
      aggregateValues,
      `TE操作培训证书_${list.length}份_${outputStamp}`,
      "pdf",
    );
    const archiveFileName = window.CertCore.renderFileName(
      namingPattern("archive"),
      aggregateValues,
      `TE操作培训证书_${outputStamp}`,
      "zip",
    );
    const files = result.pdfList.map((item, index) => {
      savedBytes += item.bytes.length;
      // 逐份时用带姓名的文件名（客户就是按姓名分发的）；
      // 合批产物是一本合订本，退回带时间戳的统称文件名。
      return {
        name: result.batched
          ? mergedFileName
          : item.fileName || `TE操作培训证书_${item.name || outputStamp}_${index + 1}.pdf`,
        data: item.bytes,
      };
    });

    // 多文件一律打包成 ZIP：连续触发多次下载会被浏览器拦（要用户逐次点"允许"），
    // 还得逐个确认保存位置。这不是用户该做的选择，所以不做开关、直接打包。
    // 单文件没必要打包，省掉一次解压。
    const shouldZip = files.length > 1;
    let zipBytes = 0;
    if (shouldZip) {
      await nextFrame();
      const zipEntries = files.map((file) => ({ name: file.name, data: file.data }));
      const zip = await window.CertCore.writeZip(zipEntries);
      zipBytes = zip.length;
      triggerDownload(
        new Blob([zip], { type: "application/zip" }),
        archiveFileName,
      );
    } else {
      files.forEach((file) => {
        triggerDownload(new Blob([file.data], { type: "application/pdf" }), file.name);
      });
    }

    resetProgress();
    const okCount = result.batched ? list.length - built.failed.length : result.pdfList.length;
    logActivity(
      `已下载 PDF：${files.length} 个文件，共约 ${formatBytes(savedBytes)}` +
        (shouldZip ? `，打包为 ZIP（${formatBytes(zipBytes)}）` : "") +
        (result.batched ? "（合并为一份多页 PDF）" : "（每人一个独立 PDF）"),
    );
    setNotice(
      `已生成 ${files.length} 个 PDF（覆盖 ${okCount} 份证书，共 ${formatBytes(savedBytes)}）` +
        (shouldZip
          ? `，打包为 ZIP（${formatBytes(zipBytes)}）下载，解压后每人一个带姓名的 PDF。`
          : "，已下载。") +
        (result.failed.length ? ` ${result.failed.length} 条失败已记录在下方。` : ""),
      result.failed.length ? "warn" : "success",
    );
    showToast(
      shouldZip ? "PDF 已打包下载：" + files.length + " 个文件。" : "PDF 已下载。",
      result.failed.length ? "error" : "success",
    );
  } catch (error) {
    resetProgress();
    const message = error && error.name === "AbortError" ? "已取消转换。" : error.message || "转换失败。";
    setNotice(message, "error");
    showToast(message, "error");
    logActivity("转换失败：" + message);
  } finally {
    state.generating = false;
    state.cloudAbort = null;
    render();
  }
}

/* -------------------------------------------------------------- 其它动作 */

function downloadSampleCsv() {
  const csv =
    "姓名,医院名称,颁发日期\n" +
    "靳睿,南京鼓楼医院,2025/10/10\n" +
    "耿楠,南京鼓楼医院,2025/10/10\n" +
    "芮法娟,南京鼓楼医院,2025/10/10\n";
  triggerDownload(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), "TE证书名单示例.csv");
  showToast("已下载示例 CSV（导入用）。");
}

function clearAll() {
  if (state.generating) return;
  state.records = [];
  state.selected = new Set();
  state.nextLineNo = 1;
  state.parseNotes = [];
  state.source = "";
  state.fileMeta = "";
  els.fileInput.value = "";
  els.activityLog.textContent = "";
  els.activityPanel.hidden = true;
  setNotice("在左侧输入姓名、医院和日期，点「解析到表格」后即可逐条修改。");
  render();
}
