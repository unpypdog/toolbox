/**
 * TE 证书本地直接 PDF（实验）。
 *
 * 与此前失败的“pdf-lib 嵌入整套中文字体”方案不同：
 *   1) 原 DOCX 中的整页 JPEG 原样嵌入 PDF，底图不经 Canvas 重采样；
 *   2) 姓名、医院、日期等少量文字由浏览器 Canvas 用本机字体画成透明 PNG；
 *   3) pdf-lib 只负责把底图与透明文字层叠到 A4 横向页面。
 *
 * 代价：实验版的动态文字是图像，不能搜索/复制。好处是完全离线、无中文字体
 * 子集化问题，也不会把 20 多 MB 的字体重复塞进每份证书。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CertDirectPdf = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PROVIDER_ID = "local-direct";
  const MAX_BATCH = 200;
  const DEFAULT_CANVAS = Object.freeze({ width: 2572, height: 1818 });
  const TEXT_INSET = 3.6;
  const BASELINE_RATIO = 1.16;
  const NAME_SHIFT_FOR_THREE = 18;
  const NAME_EXTRA_CHAR_PT = 36;
  const TEXT_COLOR = "#333f50";
  const FONT_FAMILY = '"Microsoft YaHei", "Noto Sans SC", "SimHei", sans-serif';
  // Canvas 与 Word 的字体 ascent/行距实现略有差异；这些偏移来自 2x 渲染逐像素对照。
  const CANVAS_Y_OFFSETS = Object.freeze({
    name: 1.5,
    hospital: 1.5,
    paragraph: 5.5,
    date: 0.25,
  });
  const PARAGRAPH_LINE_HEIGHT = 2.24;
  const PARAGRAPH_FONT_SIZE = 13.9;
  const DATE_LETTER_SPACING = 0.58;

  function abortError() {
    const error = new Error("已取消生成。");
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function codePointLength(value) {
    return Array.from(String(value == null ? "" : value)).length;
  }

  /**
   * 把 cert-core 的基准槽位调整成与 DOCX 同样的姓名框规则。
   * 基准槽位对应 3 字姓名：2 字姓名恢复到原位置，4 字以上向左扩展、右边缘不动。
   */
  function resolveSlot(slot, record) {
    const spec = Object.assign({}, slot.spec || {});
    if (slot.key === "name") {
      const length = codePointLength(record && record.name);
      if (length < 3) {
        spec.left += NAME_SHIFT_FOR_THREE;
      } else if (length > 3) {
        const extra = length - 3;
        spec.left -= NAME_EXTRA_CHAR_PT * extra;
        spec.width += NAME_EXTRA_CHAR_PT * extra;
      }
    }
    return Object.assign({}, slot, { spec: spec });
  }

  function fontDeclaration(size) {
    // Word 参考 PDF 实际回退到 Microsoft YaHei Regular，模板没有 <w:b/>。
    return "400 " + size + "px " + FONT_FAMILY;
  }

  function tokenizeForWrap(text) {
    return String(text).match(/[A-Za-z0-9®._-]+|\s+|[^A-Za-z0-9®._\s-]/g) || [];
  }

  function wrapText(context, text, maxWidth) {
    const explicit = String(text).split("\n");
    if (explicit.length > 1) return explicit;
    const tokens = tokenizeForWrap(text);
    const lines = [];
    let line = "";
    tokens.forEach((token) => {
      const candidate = line + token;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line.trimEnd());
        line = token.trimStart();
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line.trimEnd());
    return lines.length ? lines : [""];
  }

  function drawSlot(context, slot, record) {
    const resolved = resolveSlot(slot, record);
    const spec = resolved.spec;
    context.save();
    context.fillStyle = TEXT_COLOR;
    context.font = fontDeclaration(resolved.key === "paragraph" ? PARAGRAPH_FONT_SIZE : spec.size);
    context.textBaseline = "alphabetic";
    context.textAlign = spec.align === "center" ? "center" : "left";
    context.direction = "ltr";
    if (resolved.key === "date" && "letterSpacing" in context) {
      context.letterSpacing = DATE_LETTER_SPACING + "px";
    }

    const x = spec.align === "center"
      ? spec.left + spec.width / 2
      : spec.left + TEXT_INSET;
    const firstBaseline =
      spec.top + TEXT_INSET + spec.size * BASELINE_RATIO + (CANVAS_Y_OFFSETS[resolved.key] || 0);
    const lines = resolved.key === "paragraph"
      ? wrapText(context, resolved.text, spec.width - TEXT_INSET * 2)
      : [String(resolved.text)];
    const lineStep = spec.size *
      (resolved.key === "paragraph" ? PARAGRAPH_LINE_HEIGHT : (spec.lineHeight || 1.2));

    lines.forEach((line, index) => {
      context.fillText(line, x, firstBaseline + index * lineStep);
    });
    context.restore();
  }

  function createOverlayCanvas(printModel, record, canvasFactory) {
    const factory = canvasFactory || (() => document.createElement("canvas"));
    const canvas = factory();
    canvas.width = DEFAULT_CANVAS.width;
    canvas.height = DEFAULT_CANVAS.height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("浏览器无法创建 Canvas 2D 画布。");

    const scaleX = canvas.width / printModel.page.width;
    const scaleY = canvas.height / printModel.page.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    printModel.slots.forEach((slot) => drawSlot(context, slot, record));
    return canvas;
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== "function") {
        reject(new Error("当前浏览器不支持 Canvas.toBlob，无法生成本地 PDF。"));
        return;
      }
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error("文字图层编码失败。"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, "image/png");
    });
  }

  function pdfLibrary(options) {
    const candidate = options.pdfLib ||
      (typeof globalThis !== "undefined" ? globalThis.PDFLib : null);
    if (!candidate || !candidate.PDFDocument) {
      throw new Error("本地 PDF 引擎未加载，请刷新页面重试。");
    }
    return candidate;
  }

  async function embedBackground(pdfDoc, background) {
    if (!background || !background.data || !background.data.length) {
      throw new Error("证书模板缺少背景图，无法生成本地 PDF。");
    }
    const mime = String(background.mime || "").toLowerCase();
    if (mime.includes("png") || /\.png$/i.test(background.name || "")) {
      return pdfDoc.embedPng(background.data);
    }
    return pdfDoc.embedJpg(background.data);
  }

  function applyMetadata(pdfDoc, title) {
    pdfDoc.setTitle(title || "TE 操作培训证书");
    pdfDoc.setSubject("TE 操作培训证书（本地直接生成实验版）");
    pdfDoc.setCreator("TE Certificate Generator / local-direct experiment");
    pdfDoc.setProducer("pdf-lib 1.17.1");
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setModificationDate(new Date());
  }

  async function addCertificatePage(pdfDoc, backgroundImage, item, options) {
    throwIfAborted(options.signal);
    const model = options.core.printSlots(item.record, options.templateId);
    const canvas = createOverlayCanvas(model, item.record, options.canvasFactory);
    const overlayBytes = await canvasToPngBytes(canvas);
    throwIfAborted(options.signal);
    const overlayImage = await pdfDoc.embedPng(overlayBytes);
    const page = pdfDoc.addPage([model.page.width, model.page.height]);
    page.drawImage(backgroundImage, {
      x: model.image.left,
      y: model.page.height - model.image.top - model.image.height,
      width: model.image.width,
      height: model.image.height,
    });
    page.drawImage(overlayImage, {
      x: 0,
      y: 0,
      width: model.page.width,
      height: model.page.height,
    });
  }

  async function createDocument(items, options) {
    const PDFDocument = pdfLibrary(options).PDFDocument;
    const pdfDoc = await PDFDocument.create();
    applyMetadata(pdfDoc, options.title);
    const backgroundImage = await embedBackground(pdfDoc, options.background);
    const failed = [];
    let done = 0;

    for (const item of items) {
      try {
        await addCertificatePage(pdfDoc, backgroundImage, item, options);
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        failed.push({ name: item.name, error: error.message || String(error) });
      }
      done += 1;
      if (options.onProgress) {
        options.onProgress({ done: done, total: items.length, stage: "本地绘制" });
      }
    }
    if (pdfDoc.getPageCount() === 0) {
      throw new Error(failed.length ? failed[0].error : "没有可写入 PDF 的证书。");
    }
    const bytes = await pdfDoc.save({ useObjectStreams: true, objectsPerTick: 20 });
    return { bytes: new Uint8Array(bytes), failed: failed };
  }

  /**
   * @param {object} options
   * @param {Array<{name:string,fileName:string,record:object}>} options.items
   * @param {boolean} options.batch true 时合成多页 PDF
   * @param {{name:string,mime:string,data:Uint8Array}} options.background
   * @param {object} options.core CertCore（需要 printSlots）
   */
  async function generateBatch(options) {
    const items = options.items || [];
    if (!items.length) throw new Error("没有待生成的证书。");
    if (items.length > MAX_BATCH) {
      throw new Error(`一次最多生成 ${MAX_BATCH} 份，当前 ${items.length} 份。请分批生成。`);
    }
    if (!options.core || typeof options.core.printSlots !== "function") {
      throw new Error("证书排版核心未加载。");
    }
    if (typeof document === "undefined" && !options.canvasFactory) {
      throw new Error("本地直接 PDF 需要浏览器 Canvas 环境。");
    }
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    if (options.batch === true) {
      const merged = await createDocument(items, Object.assign({}, options, {
        title: `TE 操作培训证书（${items.length} 份）`,
      }));
      return {
        pdfList: [{
          name: items.length + " 份证书",
          fileName: items[0].fileName,
          bytes: merged.bytes,
        }],
        failed: merged.failed,
        batched: true,
        warnings: ["实验版为图像型 PDF，动态文字不可搜索或复制。"],
      };
    }

    const pdfList = [];
    const failed = [];
    for (let index = 0; index < items.length; index += 1) {
      throwIfAborted(options.signal);
      const item = items[index];
      try {
        const single = await createDocument([item], Object.assign({}, options, {
          title: item.name ? `TE 操作培训证书 - ${item.name}` : "TE 操作培训证书",
          onProgress: null,
        }));
        pdfList.push({ name: item.name, fileName: item.fileName, bytes: single.bytes });
        failed.push.apply(failed, single.failed);
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        failed.push({ name: item.name, error: error.message || String(error) });
      }
      if (options.onProgress) {
        options.onProgress({ done: index + 1, total: items.length, stage: "本地绘制" });
      }
    }
    return {
      pdfList: pdfList,
      failed: failed,
      batched: false,
      warnings: ["实验版为图像型 PDF，动态文字不可搜索或复制。"],
    };
  }

  return {
    PROVIDER_ID: PROVIDER_ID,
    MAX_BATCH: MAX_BATCH,
    generateBatch: generateBatch,
    resolveSlot: resolveSlot,
    wrapText: wrapText,
    constants: {
      canvas: DEFAULT_CANVAS,
      textInset: TEXT_INSET,
      baselineRatio: BASELINE_RATIO,
      fontFamily: FONT_FAMILY,
      textColor: TEXT_COLOR,
      canvasYOffsets: CANVAS_Y_OFFSETS,
      paragraphLineHeight: PARAGRAPH_LINE_HEIGHT,
      paragraphFontSize: PARAGRAPH_FONT_SIZE,
      dateLetterSpacing: DATE_LETTER_SPACING,
    },
  };
});
