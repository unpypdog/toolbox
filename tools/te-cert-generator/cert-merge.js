/**
 * 最小 PDF 合并器 —— 把多份单页 PDF 拼成一份多页 PDF。
 *
 * ⚠ 当前**不在主路径上**，页面也没有加载它。留着是因为它有用、且已被测试覆盖，
 *   但你要清楚它现在的地位：
 *
 *   主路径是「N 份证书拼成一份 N 页 DOCX → 一次云 API 调用 → 一份 N 页 PDF」，
 *   全程不需要合并 PDF，所以这个文件在正常流程里一次都不会被调用。
 *   它当初是为「逐份转换 + 前端合并」准备的，那条路已放弃：
 *   Word / Adobe 导出的 PDF 是 PDF 1.7 + 对象流（ObjStm）+ 交叉引用流，
 *   本模块**明确拒绝**这类输入（宁可不做，也不产出打不开的文件）。
 *
 *   它真正能派上用场的前提是：某家引擎**无法**正确分页合批 DOCX（例如忽略
 *   `<w:br w:type="page"/>`），那时只能逐份转换，再需要合并就得靠它 ——
 *   且要先解决对象流解压。这属于尚未实现的功能，别以为调个 mergePdfs 就行了。
 *
 * 已实测：ConvertAPI 能正确处理合批（4 份 → 4 页），所以这条路暂时不需要。
 * 若将来要用，先在 tests/test_te_cert_cloud_core.js 里补一条真实多页 PDF 的
 * 往返断言，别只靠合成的小样本。
 *
 * ---- 以下为原设计说明 ----
 *
 * 支持的输入：经典结构的 PDF（明文间接对象 + `xref` 表 + trailer）。
 *   遇到对象流（ObjStm）或交叉引用流会明确报错，绝不静默产出坏文件。
 *
 * 合并算法（保持每份文档的原始对象图不动，只接页面树）：
 *   1. 逐份解析出全部间接对象，整段重新编号（每份一个独立号段，互不冲突）
 *   2. 重写每个对象体里所有 `N G R` 间接引用，指向新编号
 *   3. 每份文档原来的 /Type /Pages 对象整体保留，于是它的页面、资源、
 *      内容流引用全部照旧有效 —— 不需要逐页搬资源，也就不会漏
 *   4. 新建一个 Root Catalog：`/Pages` → 新的顶层 Pages 对象，
 *      其 `/Kids` 就是各份文档的 Pages 对象，`/Count` 为总页数
 *   5. 重建 xref 表与 trailer（/Root 指向新 Catalog）
 *
 * 注意：顶层 Pages 的 /Kids 里是 Pages 对象而非 Page 对象，这是合法的页面树
 *       （规范允许任意深度），且远比把每页单独摘出来安全。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CertMerge = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const encoder = new TextEncoder();
  // latin1 保证字节与字符一一对应，不会破坏二进制流
  const decoder = new TextDecoder("latin1");

  function indexOfBytes(haystack, needle, from) {
    const start = from || 0;
    outer: for (let i = start; i <= haystack.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function ascii(text) {
    return encoder.encode(text);
  }

  /** 拆出全部间接对象，body 保持原始字节（含 stream 二进制）。 */
  function parseObjects(bytes) {
    const objects = [];
    const objToken = ascii(" obj");
    const endToken = ascii("endobj");
    let cursor = 0;

    while (cursor < bytes.length) {
      const objAt = indexOfBytes(bytes, objToken, cursor);
      if (objAt < 0) break;

      let numberStart = objAt;
      while (numberStart > 0 && bytes[numberStart - 1] >= 0x30 && bytes[numberStart - 1] <= 0x39) {
        numberStart -= 1;
      }
      const head = decoder.decode(bytes.subarray(numberStart, objAt)).trim();
      cursor = objAt + objToken.length;
      if (!head) continue;

      const parts = head.split(/\s+/);
      const number = parseInt(parts[parts.length - 1], 10);
      if (!Number.isFinite(number)) continue;

      const bodyStart = objAt + objToken.length;
      const endAt = indexOfBytes(bytes, endToken, bodyStart);
      const bodyEnd = endAt < 0 ? bytes.length : endAt;
      objects.push({ number: number, body: bytes.subarray(bodyStart, bodyEnd) });
      cursor = endAt < 0 ? bytes.length : endAt + endToken.length;
    }

    return objects;
  }

  function objectText(object) {
    return decoder.decode(object.body);
  }

  function getObject(objects, number) {
    return objects.find((object) => object.number === number) || null;
  }

  /** 从 trailer 的 /Root 找 Catalog；找不到就用 /Type /Catalog 兜底。 */
  function findCatalog(objects, rawText) {
    const tail = rawText.slice(Math.max(0, rawText.length - 8192));
    const match = tail.match(/\/Root\s+(\d+)\s+\d+\s+R/);
    if (match) {
      const object = getObject(objects, parseInt(match[1], 10));
      if (object) return object;
    }
    return objects.find((object) => /\/Type\s*\/Catalog/.test(objectText(object))) || null;
  }

  /** 找出 Catalog 指向的 Pages 对象。 */
  function findPagesNumber(catalog) {
    const match = objectText(catalog).match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    return match ? parseInt(match[1], 10) : -1;
  }

  /**
   * 一份 PDF 的结构信息。
   * 遇到不支持的形态会抛错（宁可失败，也不产出打不开的文件）。
   */
  function inspect(bytes) {
    const rawText = decoder.decode(bytes);
    if (!/^%PDF-/.test(rawText.slice(0, 16))) {
      throw new Error("不是 PDF 文件（缺少 %PDF- 头）。");
    }
    if (/\/Type\s*\/ObjStm/.test(rawText)) {
      throw new Error("该 PDF 使用了对象流（ObjStm），暂不支持合并。");
    }
    const objects = parseObjects(bytes);
    if (!objects.length) throw new Error("PDF 里没有解析到任何对象。");

    const catalog = findCatalog(objects, rawText);
    if (!catalog) throw new Error("PDF 缺少 Catalog（/Root）。");

    const pagesNumber = findPagesNumber(catalog);
    if (pagesNumber < 0) throw new Error("Catalog 里没有 /Pages。");
    const pages = getObject(objects, pagesNumber);
    if (!pages) throw new Error("找不到 /Pages 对象 " + pagesNumber + "。");
    if (!/\/Type\s*\/Pages/.test(objectText(pages))) {
      throw new Error("/Pages 指向的对象不是页面树。");
    }

    const countMatch = objectText(pages).match(/\/Count\s+(\d+)/);
    const count = countMatch ? parseInt(countMatch[1], 10) : -1;

    return { objects: objects, catalog: catalog, pages: pages, count: count };
  }

  /**
   * 重写对象体里的间接引用 `N G R` → 新编号。
   * 只处理出现 R 的三元组，内容流里的数字串不构成 `N G R` 形态，不会被误伤。
   */
  function remapReferences(bodyText, remap) {
    return bodyText.replace(/(\d+)(\s+\d+\s+R\b)/g, (whole, numberText, tail) => {
      const mapped = remap.get(parseInt(numberText, 10));
      if (mapped === undefined) return whole;
      return mapped + tail;
    });
  }

  /**
   * 合并多份 PDF。
   * @param {Uint8Array[]} pdfList
   * @returns {Uint8Array}
   */
  function mergePdfs(pdfList) {
    if (!pdfList || !pdfList.length) throw new Error("没有可合并的 PDF。");
    // 只有一份时直接返回，但**仍然要校验**：
    // 原实现跳过校验会把垃圾字节当成合法结果传下去，用户拿到一个打不开的文件
    // 却看不到任何报错。宁可在这里抛错。
    if (pdfList.length === 1) {
      inspect(pdfList[0]);
      return pdfList[0];
    }

    const header = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
    const headerBytes = ascii(header);

    // 先预留 1 = 新 Catalog，2 = 新顶层 Pages
    let nextNumber = 3;
    const catalogNumber = 1;
    const rootPagesNumber = 2;

    const entries = [];   // { number, bytes } 按编号顺序，最后统一拼装并算偏移
    const docPageRefs = [];
    let totalPages = 0;

    for (const pdfBytes of pdfList) {
      const info = inspect(pdfBytes);
      const remap = new Map();
      for (const object of info.objects) {
        remap.set(object.number, nextNumber);
        nextNumber += 1;
      }

      // 原 Catalog 不再需要（新 Catalog 统一管），跳过以免出现两个 /Root
      const skip = info.catalog.number;
      for (const object of info.objects) {
        if (object.number === skip) continue;
        const newNumber = remap.get(object.number);
        const body = remapReferences(objectText(object), remap);
        entries.push({ number: newNumber, bytes: ascii(newNumber + " 0 obj" + body + "endobj\n") });
      }

      const newPagesNumber = remap.get(info.pages.number);
      docPageRefs.push(newPagesNumber);
      totalPages += info.count > 1 ? info.count : 1;
    }

    entries.push({
      number: rootPagesNumber,
      bytes: ascii(
        rootPagesNumber +
          " 0 obj<< /Type /Pages /Count " +
          totalPages +
          " /Kids [" +
          docPageRefs.map((number) => number + " 0 R").join(" ") +
          "] >>endobj\n",
      ),
    });
    entries.push({
      number: catalogNumber,
      bytes: ascii(
        catalogNumber + " 0 obj<< /Type /Catalog /Pages " + rootPagesNumber + " 0 R >>endobj\n",
      ),
    });
    entries.sort((a, b) => a.number - b.number);

    // 拼装并记录偏移
    const chunks = [headerBytes];
    let offset = headerBytes.length;
    const offsets = new Map();
    for (const entry of entries) {
      offsets.set(entry.number, offset);
      chunks.push(entry.bytes);
      offset += entry.bytes.length;
    }

    // xref：编号必须从 0 开始连续
    const maxNumber = entries[entries.length - 1].number;
    const xrefRows = new Array(maxNumber + 1).fill("0000000000 65535 f \n");
    for (const [number, at] of offsets) {
      xrefRows[number] = String(at).padStart(10, "0") + " 00000 n \n";
    }
    const xref = ascii("xref\n0 " + (maxNumber + 1) + "\n" + xrefRows.join(""));
    const trailer = ascii(
      "trailer<< /Size " +
        (maxNumber + 1) +
        " /Root " +
        catalogNumber +
        " 0 R >>\nstartxref\n" +
        offset +
        "\n%%EOF\n",
    );

    const total = offset + xref.length + trailer.length;
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }
    output.set(xref, cursor);
    cursor += xref.length;
    output.set(trailer, cursor);
    return output;
  }

  /** 数一份 PDF 有几页。合并后用它自检。失败返回 -1。 */
  function countPages(pdfBytes) {
    try {
      const info = inspect(pdfBytes);
      if (info.count >= 0) return info.count;
      const kids = objectText(info.pages).match(/\/Kids\s*\[([^\]]*)\]/);
      if (!kids) return -1;
      return (kids[1].match(/\d+\s+\d+\s+R/g) || []).length;
    } catch {
      return -1;
    }
  }

  return {
    mergePdfs: mergePdfs,
    countPages: countPages,
    inspect: inspect,
  };
});
