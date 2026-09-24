/**
 * TE 操作培训证书 —— 纯本地核心：名单解析、字段校验、输出命名、模板读取、排版槽位。
 *
 * 这里只负责「数据」与「版式」两件事，不产出任何 DOCX：
 *   - 名单 → 记录（parseDate / validateRecord / prepareRecords*）
 *   - 记录 → 输出文件名（assignOutputNames / renderFileName）
 *   - 模板 docx → 背景图字节（readZip / extractImage / assertTemplate）
 *   - 记录 → 打印槽位（printSlots，供 cert-direct-pdf 用 Canvas 画字）
 *
 * 历史：原先还有一条「填充 word/document.xml 生成 DOCX」的路径，那是为云端
 * DOCX→PDF 服务商准备的中间产物。云转换移除后它没有任何调用方（本地直接 PDF 走的是
 * 「模板背景图 + Canvas 文字」），已整段删除。模板 docx 现在只作为**背景图载体**存在。
 *
 * 沿用的原 generate_certs.py 经验（仍适用于 PDF 版式）：
 *   - 不把去重用的 _2 后缀写进证书姓名：Python 版会把「张三_2」印在证书上
 *   - 日期解析放进逐行 try：Python 版一条坏数据会中断整批
 *
 * 同时导出 UMD，使 Node 端夹具测试能直接跑同一份逻辑，避免「测试的和线上跑的不是一套」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CertCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ 常量 */

  const TEMPLATES = {
    general: { id: "general", label: "一般版本", file: "template-general.docx" },
    special: { id: "special", label: "260513 特殊版本", file: "template-special.docx" },
  };
  const DEFAULT_NAMING_PATTERNS = Object.freeze({
    individual: "TE操作培训证书_{姓名}",
    merged: "TE操作培训证书_{份数}份_{时间}",
    archive: "TE操作培训证书_{时间}",
  });
  const MAX_ROWS = 3000;
  const ZIP_DOS_TIME = 0x0021; // 1980-01-01 00:00:08，固定值让压缩包可复现
  const ZIP_DOS_DATE = 0x0021; // 1980-01-01

  /**
   * 打印（PDF）版式。
   *
   * 坐标直接**锚定参考 PDF 的实测落点**，而不是从模板的 EMU 常量推导。
   * 参考 PDF = 原 Python 脚本 + Word 导出的成品，用 pdfplumber 读出实际文字位置：
   *   name      文本 309.89..417.89，包围盒顶 258.52，字号 36（粗）
   *   hospital  文本起点 429.89，包围盒顶 273.04，字号 18
   *   date      文本起点 548.47，包围盒顶 513.85，字号 12
   *
   * 为什么不再推导：从 posOffset/extent 推过一版，横向差 4~18pt。
   * 原因是 Word 的 posOffset 指**文字区**基准，再叠加 inset 就重复计算了；
   * 姓名框的实际位置也与 posOffset 对不上。实测锚定最可靠，也最容易复核。
   *
   * 槽位语义：left/top 是**文本框左上角**，与参考 PDF 的文本落点关系为
   *   左对齐：文本左 = left + inset
   *   居中  ：文本左 = left + inset + (内容宽 - 文本宽) / 2
   *   基线  ：页高 -(top + inset + ascent)
   */
  const PAGE = { width: 841.9, height: 595.3 };
  const TEXT_INSET = 3.6;
  const BASELINE_RATIO = 1.16; // Noto Sans SC / 思源黑体：ascent 1160 / upem 1000

  const PRINT_LAYOUT = {
    general: {
      page: PAGE,
      image: { left: 0, top: 0, width: 841.45, height: 595.05 },
      slots: {
        // 姓名居中：内容宽 117.3，文本宽 108 → 文本左 = left + 3.6 + 4.65
        //   要落在 309.89，故 left = 301.64
        name: {
          left: 301.64, top: 238.79, width: 124.5, height: 66.7,
          size: 36, weight: 800, align: "center",
        },
        // 左对齐：文本左 = left + 3.6 = 429.89 → left = 426.29
        hospital: {
          left: 426.29, top: 261.38, width: 240, height: 45,
          size: 18, weight: 500, align: "left",
        },
        // 文本左 = left + 3.6 = 548.47 → left = 544.87
        date: {
          left: 544.87, top: 504.87, width: 360, height: 48.05,
          size: 12, weight: 400, align: "left",
        },
      },
    },
    special: {
      page: PAGE,
      image: { left: 0, top: 0, width: 841.45, height: 595.05 },
      slots: {
        paragraph: {
          left: 153.95, top: 316.2, width: 542.95, height: 86.95,
          size: 14, weight: 500, align: "center", lineHeight: 1.92,
        },
        name: {
          left: 301.64, top: 238.79, width: 124.5, height: 66.7,
          size: 36, weight: 800, align: "center",
        },
        hospital: {
          left: 426.29, top: 261.38, width: 240, height: 45,
          size: 18, weight: 500, align: "left",
        },
        date: {
          left: 544.87, top: 504.87, width: 360, height: 48.05,
          size: 12, weight: 400, align: "left",
        },
      },
    },
  };

  /** 特殊版模板里那段固定说明文字（不含姓名），从模板原文提取，避免手抄出错。 */
  const SPECIAL_PARAGRAPH =
    "经专业培训评估，您已通过超声探头引导定位和震动控制瞬时弹性成像技术的相关理论\n" +
    "及实际操作培训的考核，具备独立规范操作iLivTouch®设备资质，授予正式认证!";

  /* --------------------------------------------------------------- 文本处理 */

  function stripOuter(value) {
    return String(value == null ? "" : value).trim();
  }

  /** 归一化表头：去空格、全角括号、统一小写，便于别名匹配。 */
  function normalizeHeader(value) {
    return String(value == null ? "" : value)
      .replace(/[\s\u3000]/g, "")
      .replace(/[（）()【】\[\]:：*]/g, "")
      .toLowerCase();
  }

  const HEADER_ALIASES = {
    name: ["姓名", "名字", "学员姓名", "name", "username"],
    hospital: ["医院名称", "医院", "单位名称", "单位", "机构名称", "hospital", "unitname"],
    date: ["颁发日期", "发证日期", "日期", "date", "issuedate"],
  };

  function matchHeaderRow(row) {
    const columns = { name: -1, hospital: -1, date: -1 };
    let hits = 0;
    row.forEach((cell, index) => {
      const key = normalizeHeader(cell);
      if (!key) return;
      Object.keys(HEADER_ALIASES).forEach((field) => {
        if (columns[field] === -1 && HEADER_ALIASES[field].includes(key)) {
          columns[field] = index;
          hits += 1;
        }
      });
    });
    return hits >= 2 ? columns : null;
  }

  /**
   * 日期解析的唯一实现：兼容 2026/5/12、2026-05-12、2026.5.12、2026年5月12日（含「号」），
   * 也接受**只有年月或只有年**的形态（22年10月、2022-10、2022）。
   *
   * 为什么必须接受不完整日期：素材里经常只有年月。聊天记录里写的是「那张图片里的名单写
   * 〈年份〉年〈月份〉月份左右」，日根本不存在；旧实现对这种输入直接抛「日期格式无法识别」，
   * 于是模型只剩两条路 —— 丢掉日期，或者自己编一个「日」，后者会静默印出日期错误的证书。
   * 现在把读到的那部分读进来，由 validateRecord 标成「日期不完整」并保持 invalid：
   * 生成闸门不放行，用户只需要补上缺的那一段。
   *
   * @returns {{year:string, month:string, day:string, complete:boolean}}
   */
  function parseDateParts(value) {
    const text = stripOuter(value);
    const normalized = text
      .replace(/[年月]/g, "/")
      .replace(/[日号]/g, "")
      .replace(/[-.]/g, "/")
      .replace(/\/+/g, "/")
      // 「22年10月」「2022年」这类写法末尾会留下一个分隔符，先削掉再匹配，
      // 否则只有年月的日期会被判成「格式无法识别」——正是要修的那个场景。
      .replace(/\/+$/, "");
    // 一段（只有年）、两段（年月）、三段（年月日）都收。
    // 一段必须是四位年份：否则日期格里的「10」「25」会被读成 2010 年 / 2025 年，
    // 比一句「无法识别」更误导人。
    const match = normalized.match(
      /^\s*(\d{1,4})\s*(?:\/\s*(\d{1,2}))?(?:\s*\/\s*(\d{1,2}))?\s*$/,
    );
    if (!match || (!match[2] && match[1].length < 4)) {
      throw new Error("日期格式无法识别：" + text);
    }
    // 手输场景常见「25年10月10日」，两位年份按 20xx 处理
    const year = match[1].length <= 2 ? 2000 + Number(match[1]) : Number(match[1]);
    const month = match[2] ? Number(match[2]) : 0;
    const day = match[3] ? Number(match[3]) : 0;
    if (year < 1900 || year > 2999) throw new Error("年份超出范围：" + text);
    if (match[2] && (month < 1 || month > 12)) throw new Error("月份超出范围：" + text);
    if (match[3]) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day < 1 || day > lastDay) throw new Error("日期不存在：" + text);
    }
    return {
      year: String(year),
      month: match[2] ? String(month).padStart(2, "0") : "",
      day: match[3] ? String(day).padStart(2, "0") : "",
      complete: Boolean(match[2] && match[3]),
    };
  }

  /**
   * 严格解析：必须精确到「日」，缺段一律抛错。
   * 这是**对外契约**（parseDate 的调用方都要求完整日期），不完整日期只走 validateRecord。
   */
  function parseDate(value) {
    const parts = parseDateParts(value);
    if (!parts.complete) {
      throw new Error(
        "日期不完整（缺" + (parts.month ? "「日」" : "「月」「日」") + "）：" + stripOuter(value),
      );
    }
    return { year: parts.year, month: parts.month, day: parts.day };
  }

  /** 把「只读到哪一段」写成给用户看的提示：能补的只是缺的那一段。 */
  function incompleteDateMessage(parts) {
    const known = parts.month
      ? parts.year + " 年 " + Number(parts.month) + " 月"
      : parts.year + " 年";
    return (
      "日期不完整：只读到 " + known + "，请补" + (parts.month ? "「日」" : "「月」「日」")
    );
  }

  /* -------------------------------------------------------------- 数据行 */

  function rowsFromMatrix(matrix) {
    const rows = (matrix || []).map((row) =>
      (Array.isArray(row) ? row : [row]).map((cell) => (cell == null ? "" : String(cell))),
    );
    // 去掉尾部整行为空的记录（Excel 存盘常留几千个空行）
    while (rows.length && rows[rows.length - 1].every((cell) => stripOuter(cell) === "")) {
      rows.pop();
    }
    return rows;
  }

  /**
   * 校验单条记录，返回 { name, hospital, dateRaw, date, status, issues }。
   * 手输、改表格、导入文件三条路径都走这里，保证校验规则只有一份。
   */
  function validateRecord(input) {
    const name = stripOuter(input.name);
    const hospital = stripOuter(input.hospital);
    const dateRaw = stripOuter(input.dateRaw);
    const issues = [];

    if (!name) issues.push("缺少姓名");
    if (!hospital) issues.push("缺少医院名称");
    if (!dateRaw) issues.push("缺少颁发日期");

    let date = null;
    if (dateRaw) {
      try {
        const parts = parseDateParts(dateRaw);
        if (parts.complete) {
          date = { year: parts.year, month: parts.month, day: parts.day };
        } else {
          // 读到年月（甚至只有年）不是「格式错误」而是信息不完整：
          // 仍然是 invalid（不会进生成队列），但用户只需要补缺的那一段，
          // 不必把整条日期重打。
          issues.push(incompleteDateMessage(parts));
        }
      } catch (error) {
        issues.push(error.message);
      }
    }
    if (name.length > 30) issues.push("姓名超过 30 字，排版可能异常");
    if (hospital.length > 60) issues.push("医院名称超过 60 字，可能超出文本框");

    return {
      name: name,
      hospital: hospital,
      dateRaw: dateRaw,
      date: date,
      status: issues.length ? "invalid" : "ready",
      issues: issues,
    };
  }

  /** 日期占位符统一成 YYYY-MM-DD；无效日期保留原文，方便用户在预览里发现问题。 */
  function outputDate(record) {
    if (record && record.date) {
      return [record.date.year, record.date.month, record.date.day].join("-");
    }
    return stripOuter(record && record.dateRaw);
  }

  /** 去掉用户可能顺手输入的扩展名；真正的扩展名由调用方固定追加。 */
  function stripOutputExtension(value) {
    return String(value == null ? "" : value).trim().replace(/\.(?:pdf|docx|zip)$/i, "");
  }

  /** 展开文件名模板并清理非法字符。未知占位符原样保留，避免静默吞掉用户文字。 */
  function renderFileBase(pattern, values, fallback) {
    const source = stripOutputExtension(pattern);
    const expanded = source.replace(/\{([^{}]+)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(values || {}, key)
        ? String(values[key] == null ? "" : values[key])
        : whole,
    );
    return safeFileName(expanded, fallback || "未命名", 120);
  }

  function renderFileName(pattern, values, fallback, extension) {
    const ext = String(extension || "pdf").replace(/^\.+/, "").toLowerCase();
    return renderFileBase(pattern, values, fallback) + "." + ext;
  }

  /**
   * 生成最终 PDF 文件名：同名自动加 _2、_3 后缀。
   * 后缀只用于文件名，**不会**写进证书里的姓名（原 Python 脚本会把「张三_2」印在证书上）。
   * `record.outputNameOverride` 是当前批次的单行覆盖值；扩展名仍由程序固定为 .pdf。
   */
  function assignOutputNames(records, options) {
    const pattern = (options && options.pattern) || DEFAULT_NAMING_PATTERNS.individual;
    const occurrences = new Map();
    records.forEach((record, index) => {
      const values = {
        姓名: record.name,
        医院: record.hospital,
        日期: outputDate(record),
        序号: record.lineNo || index + 1,
      };
      const fallback = "TE操作培训证书_" + safeFileName(record.name, "第" + values.序号 + "行");
      const override = stripOutputExtension(record.outputNameOverride);
      const base = override
        ? safeFileName(override, fallback, 120)
        : renderFileBase(pattern, values, fallback);
      const key = base.toLocaleLowerCase();
      const count = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, count);
      record.fileBase = base + (count > 1 ? "_" + count : "");
      record.outputName = record.fileBase + ".pdf";
      record.fileNameDuplicated = count > 1;
      record.duplicate = count > 1;
    });
    return records;
  }

  /**
   * 从表格矩阵构造记录（导入 CSV / Excel 用）。
   * 返回 { headerFound, columns, records }。
   */
  function prepareRecords(matrix) {
    const rows = rowsFromMatrix(matrix);
    if (!rows.length) {
      throw new Error("文件里没有可读取的数据行。");
    }

    let columns = matchHeaderRow(rows[0]);
    const headerFound = Boolean(columns);
    let body;
    if (columns) {
      body = rows.slice(1);
    } else {
      // 没有可识别的表头时按「姓名, 医院名称, 颁发日期」的位置解析，与原脚本一致
      columns = { name: 0, hospital: 1, date: 2 };
      body = rows;
    }

    const records = [];
    body.forEach((row, index) => {
      const lineNo = headerFound ? index + 2 : index + 1;
      const raw = {
        name: columns.name >= 0 ? row[columns.name] : "",
        hospital: columns.hospital >= 0 ? row[columns.hospital] : "",
        dateRaw: columns.date >= 0 ? row[columns.date] : "",
      };
      const record = validateRecord(raw);
      if (!record.name && !record.hospital && !record.dateRaw) return; // 中间的空行跳过
      record.lineNo = lineNo;
      records.push(record);
    });

    if (!records.length) {
      throw new Error("文件里没有有效的数据行（姓名/医院/日期三列都为空）。");
    }
    return { headerFound, columns, records: assignOutputNames(records) };
  }

  /* ------------------------------------------------------ 手输快速解析 */

  // 分隔符：中英文逗号/顿号/分号/竖线/斜杠，以及连续空白
  const SEPARATOR_RE = /[、,，;；\/|\s\u3000]+/;
  const SEPARATOR_RE_G = /[、,，;；\/|\s\u3000]+/g;
  // 日期可以写成 2025/1/1、2025-1-1、2025.1.1、25年10月10日、2025年10月10日。
  // 前面必须是行首或分隔符：否则「测试2025/1/1」这种写法会把姓名末尾的数字一起吃掉。
  const DATE_AT_SEP = "(?:^|[\\s\\u3000、,，;；\\/|])";
  const DATE_DIGITS = "(\\d{2,4})\\s*[\\/\\-. ]\\s*(\\d{1,2})\\s*[\\/\\-. ]\\s*(\\d{1,2})\\s*[日号]?";
  const DATE_CN = "(\\d{2,4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]?";
  const DATE_TAIL_RE = new RegExp("(?:" + DATE_AT_SEP + ")(?:" + DATE_DIGITS + "|" + DATE_CN + ")\\s*$");
  const DATE_FULL_RE = new RegExp("^(?:" + DATE_DIGITS + "|" + DATE_CN + ")$");
  /** 数字形式的日期统一成 yyyy/m/d，中文形式保留原样（parseDate 两种都能读）。 */
  const DATE_DIGIT_RE = /^\d{2,4}\s*[\/\-.\s]\s*\d{1,2}\s*[\/\-.\s]\s*\d{1,2}$/;
  // 医院机构名特征词
  const HOSPITAL_KEYWORDS = [
    "医院", "卫生院", "诊所", "卫生所", "卫生服务中心", "妇幼保健院", "保健院",
    "疾控中心", "防治所", "疗养院", "医务室", "医疗中心", "附属医院", "鼓楼", "协和",
  ];
  const KEYWORD_RE = new RegExp(HOSPITAL_KEYWORDS.join("|"));
  // 医院名以特征词结尾；前缀里刻意不含「、，」——它们只可能出现在姓名之间
  const HOSPITAL_TAIL_RE = new RegExp(
    "([\\u4e00-\\u9fa5A-Za-z0-9()\\[\\]（）·.\\-\\s]*?(?:" + HOSPITAL_KEYWORDS.join("|") + "))\\s*$",
  );

  function splitNameList(value) {
    return value
      .split(SEPARATOR_RE)
      .map((part) => stripOuter(part))
      .filter(Boolean);
  }

  /**
   * 把「姓名列表 + 医院 + 日期」的一行拆成 { names, hospital, dateText, note }。
   *
   * 医院名写在最后，所以从行尾往前啃：
   *   1) 先摘掉结尾的日期
   *   2) 再用「机构名特征词」从最后一段里啃出医院名；啃不出来就把最后一段当医院名
   *   3) 剩下的部分按分隔符切开就是姓名
   * 顿号/逗号只用于分隔姓名，因此正则在遇到它们时一定会停下，不会把「倪文婧」吞进医院名。
   * 完全用空格分隔姓名、且医院名不含特征词时无法可靠切分，会在表格里提示用户确认。
   */
  function splitQuickLine(line) {
    const text = stripOuter(line);
    if (!text) return null;

    // 1) 摘日期：整行只有日期、或日期紧跟在分隔符之后且位于行尾时才算
    let body = text;
    let dateText = "";
    if (DATE_FULL_RE.test(text)) {
      dateText = text.replace(/\s+/g, "");
      body = "";
    } else {
      const dateMatch = text.match(DATE_TAIL_RE);
      if (dateMatch) {
        body = stripOuter(text.slice(0, dateMatch.index));
        dateText = stripOuter(dateMatch[0]);
        dateText = DATE_DIGIT_RE.test(dateText)
          ? dateText.replace(/\s+/g, "").replace(/[-.]/g, "/")
          : dateText.replace(/\s+/g, "");
      }
    }
    if (!body) {
      return { names: [""], hospital: "", dateText: dateText, note: "这一行只有日期，请补姓名与医院" };
    }

    // 2) 取最后一段找医院名
    const lastSep = Math.max(
      body.lastIndexOf("、"), body.lastIndexOf(","), body.lastIndexOf("，"),
      body.lastIndexOf(";"), body.lastIndexOf("；"), body.lastIndexOf("/"), body.lastIndexOf("|"),
      body.lastIndexOf(" "), body.lastIndexOf("\u3000"),
    );
    const headPart = stripOuter(body.slice(0, lastSep + 1));
    const tailPart = stripOuter(body.slice(lastSep + 1));
    const tailMatch = tailPart.match(HOSPITAL_TAIL_RE);

    let names = [];
    let hospital = "";
    let note = "";

    if (tailMatch && tailMatch[1]) {
      hospital = stripOuter(tailMatch[1]);
      names = splitNameList(headPart);
    } else if (lastSep >= 0) {
      const headNames = splitNameList(headPart);
      if (headNames.length) {
        // 医院名没被特征词命中（如「南京鼓楼医院」）：末段当医院名，前面都是姓名
        hospital = tailPart;
        names = headNames;
      } else {
        // 整行只有一段：拆成姓名，医院名留空让用户补
        names = splitNameList(tailPart);
        note = "没识别到医院名称，请在表格里补上";
      }
    } else {
      names = splitNameList(body);
      note = "没识别到医院名称，请在表格里补上";
    }

    if (!names.length) names = [""];
    if (!hospital && !note) note = "没识别到医院名称，请在表格里补上";
    return { names: names, hospital: hospital, dateText: dateText, note: note };
  }

  /**
   * 解析「快速输入」文本区，一行一条，一行里的多个姓名展开成多条记录。
   * 返回 { rows, notes, lines }：rows 是可直接交给 prepareRecords 的矩阵。
   */
  function parseQuickEntry(text) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const rows = [];
    const notes = [];
    lines.forEach((line, index) => {
      if (!stripOuter(line)) return;
      const parsed = splitQuickLine(line);
      if (!parsed) return;
      parsed.names.forEach((name) => {
        rows.push([name, parsed.hospital, parsed.dateText]);
      });
      if (parsed.note) notes.push(`第 ${index + 1} 行：${parsed.note}`);
    });
    return { rows: rows, notes: notes, lines: lines.length };
  }

  /** 从原始文本构造记录（快速输入用），矩阵路径与文件导入完全一致。 */
  function prepareRecordsFromText(text) {
    const parsed = parseQuickEntry(text);
    if (!parsed.rows.length) {
      throw new Error("还没有可解析的内容。请按「姓名、姓名 医院名称 日期」的格式输入。");
    }
    const prepared = prepareRecords(parsed.rows);
    prepared.notes = parsed.notes;
    prepared.source = "text";
    return prepared;
  }

  /** 文件名只做 Windows/浏览器非法字符替换，中文姓名原样保留（Python 版同此）。 */
  function safeFileName(name, fallback, maxLength) {
    const cleaned = String(name || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, maxLength || 60);
    return cleaned || fallback || "未命名";
  }

  /**
   * 读取同目录下的模板（走 fetch）。只在 http(s) 或测试环境可用：
   * file:// 下 Chromium 一律拒绝 fetch，报 TypeError: Failed to fetch。
   * 本地双击打开的场景由 loadTemplate 的 base64 载荷兜底。
   *
   * 注意不要传 cache 选项：file:// 下不接受 cache-mode 覆写。
   * @param {string} url 相对或绝对地址
   * @param {number} [timeoutMs] 超时（默认 15 秒）
   * @returns {Promise<Uint8Array>}
   */
  async function fetchBytes(url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs || 15000)
      : null;
    const options = controller ? { signal: controller.signal } : {};
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`读取 ${url} 失败（HTTP ${response.status}）。`);
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error(`${url} 不是有效的 docx 文件，请确认文件已完整提交。`);
      }
      return bytes;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error(`读取 ${url} 超时。`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------ ZIP 读 / 写 */

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // 浏览器用原生 CompressionStream('deflate-raw')，Node 用 zlib.deflateRawSync，
  // 都是「裸 deflate」，与 Python zipfile 的 ZIP_DEFLATED 同一格式。
  function getDeflater() {
    if (typeof CompressionStream === "function") {
      return async function deflateRaw(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
    }
    if (typeof require === "function") {
      try {
        const zlib = require("zlib");
        return async function deflateRaw(bytes) {
          return new Uint8Array(zlib.deflateRawSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
        };
      } catch (error) {
        /* 落到下面报错 */
      }
    }
    throw new Error("当前环境不支持 deflate 压缩，无法打包下载。");
  }
  const deflateRaw = getDeflater();

  /**
   * 生成 ZIP 压缩包（deflate 压缩，中文文件名用 UTF-8 + 置 bit 11 标记）。
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Promise<Uint8Array>}
   */
  async function writeZip(entries) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);
      const isDirectory = entry.name.endsWith("/");
      const compressed = isDirectory ? data : await deflateRaw(data);
      const method = isDirectory || compressed.length >= data.length ? 0 : 8;
      const payload = method === 8 ? compressed : data;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 文件名
      lv.setUint16(8, method, true);
      lv.setUint16(10, ZIP_DOS_TIME, true);
      lv.setUint16(12, ZIP_DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, payload);

      central.push({ nameBytes: nameBytes, method: method, crc: crc, size: payload.length, rawSize: data.length, offset: offset });
      offset += local.length + payload.length;
    }

    const centralStart = offset;
    for (const item of central) {
      const header = new Uint8Array(46 + item.nameBytes.length);
      const cv = new DataView(header.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, item.method, true);
      cv.setUint16(12, ZIP_DOS_TIME, true);
      cv.setUint16(14, ZIP_DOS_DATE, true);
      cv.setUint32(16, item.crc, true);
      cv.setUint32(20, item.size, true);
      cv.setUint32(24, item.rawSize, true);
      cv.setUint16(28, item.nameBytes.length, true);
      cv.setUint32(42, item.offset, true);
      header.set(item.nameBytes, 46);
      chunks.push(header);
      offset += header.length;
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, offset - centralStart, true);
    ev.setUint32(16, centralStart, true);
    chunks.push(end);

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    chunks.forEach((chunk) => {
      out.set(chunk, cursor);
      cursor += chunk.length;
    });
    return out;
  }

  /**
   * 读取 ZIP 的所有条目（含目录项，保持原始顺序，保证模板所有部件都不丢）。
   * @param {Uint8Array} bytes
   * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
   */
  async function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];

    // 从尾部找 EOCD（注释最长 65535 字节）
    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minPos; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("模板不是有效的 docx（缺少 ZIP 结束记录）。");

    const count = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);

    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) {
        throw new Error("模板目录结构异常，无法解析。");
      }
      const flags = view.getUint16(pointer + 8, true);
      const method = view.getUint16(pointer + 10, true);
      const size = view.getUint32(pointer + 20, true);
      const nameLen = view.getUint16(pointer + 28, true);
      const extraLen = view.getUint16(pointer + 30, true);
      const commentLen = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const rawName = bytes.subarray(pointer + 46, pointer + 46 + nameLen);
      const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "utf-8").decode(rawName);

      // 本地头里的 extra 长度可能与中央目录不同，必须重新读取
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      let data;
      if (size === 0 || name.endsWith("/")) {
        data = new Uint8Array(0);
      } else {
        const raw = bytes.subarray(dataStart, dataStart + size);
        data = method === 0 ? raw.slice() : await inflateRaw(raw);
      }

      entries.push({ name: name, data: data });
      pointer += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function getInflater() {
    if (typeof DecompressionStream === "function") {
      return async function inflateRaw(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
    }
    if (typeof require === "function") {
      try {
        const zlib = require("zlib");
        return async function inflateRaw(bytes) {
          return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
        };
      } catch (error) {
        /* 落到下面报错 */
      }
    }
    throw new Error("当前环境不支持解压，无法读取 docx 模板。");
  }
  const inflateRaw = getInflater();

  /** base64 → Uint8Array。浏览器用 atob，Node 用 Buffer。 */
  function base64ToBytes(base64) {
    const clean = String(base64).replace(/\s+/g, "");
    if (typeof atob === "function") {
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(clean, "base64"));
  }

  /**
   * 校验模板字节。
   *
   * 模板现在**只作为背景图载体**使用（PDF 版式来自 PRINT_LAYOUT，文字由 Canvas 现画），
   * 所以这里查的就是背景图在不在 —— 光有 word/document.xml 而缺 media，
   * 生成时才会在更深的地方炸，错误信息也更难懂。
   * @param {Uint8Array} bytes
   * @param {string} label 出错信息里用的名字
   */
  async function assertTemplate(bytes, label) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error(`${label} 不是有效的 docx 文件（缺少 ZIP 头）。`);
    }
    const entries = await readZip(bytes);
    const hasImage = entries.some(
      (entry) =>
        entry.name.startsWith("word/media/") && !entry.name.endsWith("/") && entry.data.length > 0,
    );
    if (!hasImage) {
      throw new Error(`${label} 里没有背景图（word/media/），无法用于生成证书。`);
    }
    return bytes;
  }

  /**
   * 把一条记录展开成打印用的文本片段（供 cert-direct-pdf 绘制文字层）。
   * 日期文本是成品证书上的最终形态：`颁发日期: 2025 年 06 月 19 日`
   * @param {object} record 含 name / hospital / year / month / day
   * @param {string} templateId general | special
   */
  function printSlots(record, templateId) {
    const layout = PRINT_LAYOUT[templateId];
    if (!layout) throw new Error("未知的模板：" + templateId);
    const slots = [];
    const push = (key, text) => {
      const spec = layout.slots[key];
      if (spec) slots.push({ key: key, text: text, spec: spec });
    };
    if (templateId === "special") push("paragraph", SPECIAL_PARAGRAPH);
    push("name", record.name);
    push("hospital", record.hospital);
    push("date", "颁发日期: " + record.year + " 年 " + record.month + " 月 " + record.day + " 日");
    return { page: layout.page, image: layout.image, slots: slots };
  }

  /** 取出模板里的背景图（打印版要单独作为 <img> 铺在底层）。 */
  async function extractImage(templateBytes) {
    const entries = await readZip(templateBytes);
    // 必须跳过目录项：docx 里有一个长度为 0 的 "word/media/"，
    // startsWith 会先命中它，直接当成图片就会拿到空数据。
    const image = entries.find(
      (entry) => entry.name.startsWith("word/media/") && !entry.name.endsWith("/") && entry.data.length > 0,
    );
    if (!image) return null;
    let mime = "image/jpeg";
    if (image.name.endsWith(".png")) mime = "image/png";
    else if (image.name.endsWith(".gif")) mime = "image/gif";
    return { name: image.name, mime: mime, data: image.data };
  }

  return {
    TEMPLATES: TEMPLATES,
    DEFAULT_NAMING_PATTERNS: DEFAULT_NAMING_PATTERNS,
    MAX_ROWS: MAX_ROWS,
    normalizeHeader: normalizeHeader,
    matchHeaderRow: matchHeaderRow,
    parseDate: parseDate,
    parseDateParts: parseDateParts,
    validateRecord: validateRecord,
    assignOutputNames: assignOutputNames,
    prepareRecords: prepareRecords,
    splitQuickLine: splitQuickLine,
    parseQuickEntry: parseQuickEntry,
    prepareRecordsFromText: prepareRecordsFromText,
    safeFileName: safeFileName,
    stripOutputExtension: stripOutputExtension,
    renderFileBase: renderFileBase,
    renderFileName: renderFileName,
    fetchBytes: fetchBytes,
    base64ToBytes: base64ToBytes,
    assertTemplate: assertTemplate,
    printSlots: printSlots,
    extractImage: extractImage,
    readZip: readZip,
    writeZip: writeZip,
    crc32: crc32,
  };
});
