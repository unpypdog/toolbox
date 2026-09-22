/**
 * 名单解析 —— AI 抽取（OpenAI 兼容接口，浏览器直连）
 *
 * ⚠ 定位：这是**增强**，不是替代。规则解析（cert-core 的 prepareRecordsFromText）
 *   仍然是默认路径 —— 免费、离线、快、结果可预测。AI 只在两种情况下用：
 *     1) 规则解析失败或结果不对（表格、分行、一句话叙述、含职称工号……）
 *     2) 输入是图片（手机拍的签到表、微信截图），规则解析根本做不到
 *
 * ⚠ 最大的风险是幻觉，而证书印错名字不可挽回。所以本模块把职责硬拆开：
 *   - AI 只返回图片事实、文字人员和带作用范围的赋值指令，不输出最终名单
 *   - mergeExtraction 在本地按固定优先级完成匹配、覆盖与冲突判定
 *   - 合并结果再过 core.validateRecord；缺项、冲突和 AI note 一律标红
 *   - 永远不自动补全姓名：看不清就留空并写进 note
 *
 * 为什么需要它：实测规则解析在这些输入上会失败或静默出错 ——
 *   制表符表格 → 整行塌成一条；姓名与信息分行 → 拆出一堆垃圾记录；
 *   「Jin Rui, Geng Nan, Nanjing Gulou Hospital, …」→ 一个词一条；
 *   日期写在前面 → 全乱；带「1. 靳睿 主治医师」→ 工号被当姓名。
 *   更糟的是「医院名不含特征词」（如「中大附一」）时会**静默丢掉日期**而不报错。
 *
 * 实测过的接口契约（2026-09，DeepSeek）：
 *   POST https://api.deepseek.com/chat/completions
 *   Authorization: Bearer <key>
 *   { model: "deepseek-flash", messages: [...], response_format: {type:"json_object"} }
 *   CORS：预检 200 且回显 Origin，**错误响应也带 Access-Control-Allow-Origin**，
 *        所以浏览器直连可用，且 401 时能读到真实错误（不像 Adobe 会被 CORS 掩盖）。
 *   同一个 deepseek-flash 模型同时支持图片与 json 输出，所以文本/图片共用一条路径。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CertAi = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 120000;

  /** 单张图片大小上限：接口限 32 MiB，这里留足余量并按常见手机照片设限 */
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  /** 最终证书字段名；提取契约另外包含 imageRows / textPeople / assignments */
  const FIELDS = ["name", "hospital", "date", "note"];

  /**
   * 输出预算与思考模式的默认值。
   *
   * 4096 这个旧默认值本身就是「模型输出被长度限制截断」的根因，不是名单太长：
   * DeepSeek 的思考模式**默认开启且思考力度默认 high**（见官方 Thinking Mode 文档），
   * 而思考 token 与正文共用 max_tokens —— 4096 很可能被思考吃光，正文一个字都没轮上
   * （表现为 content 为空 + finish_reason=length）。
   *
   * 两个默认值配合着看：max_tokens 给足（非流式非思考模式官方默认 8K，思考模式 64K），
   * 思考模式显式关掉。抽名单不需要长链推理，关掉能把预算全留给正文；
   * 需要更强推理时可以打开，那时 max_tokens 也够用。
   *
   * 各服务商通用：OpenAI 兼容接口会忽略不认识的 thinking 字段。
   */
  const MAX_OUTPUT_TOKENS = 32768;
  const THINKING_TYPE = "disabled";

  const PROMPT = [
    "你是证书材料的事实提取器。你只负责识别材料中明确出现的事实，不负责合并图文、",
    "选择覆盖优先级或生成最终证书名单；这些业务决定全部由程序完成。",
    "",
    "材料可能包含图片、文字或两者。必须把图片与文字分开观察，不能用一边的内容补写另一边。",
    "尤其不能拿图片日期修正文字日期，也不能把两边日期拼成第三个日期。",
    "",
    "【图片事实 imageRows】",
    "逐行读取与人员明确关联的 name、hospital、date，保持图片行序，row 从 1 开始。",
    "图片可能只有姓名，也可能是完整表格；存在的字段都要读，读不到就留空，不要猜。",
    "图片里的装饰、模板、示例或往期日期若不属于任何人员行，不要放进人员字段。",
    "姓名逐字照抄；看不清就在 note 说明，不要自行纠正。evidence 填该行可见的简短原文。",
    "",
    "【文字人员 textPeople】",
    "列出文字中明确作为证书领取人的姓名，只放姓名本身，去掉编号、职称、工号和称谓。",
    "不要把医院、日期或说明文字当成人名。evidence 填包含该姓名的简短原文。",
    "",
    "【文字赋值 assignments】",
    "把文字中的医院、日期以及明确的姓名纠正提取成赋值指令。这里只报告值和它在原文中的",
    "作用范围，不执行覆盖。field 只能是 hospital、date、name；date 统一为 YYYY-MM-DD。",
    "scope 只能是下面五种：",
    "- named：原文明确定义给某些姓名，姓名放 targetNames。",
    "- rows：原文明确定义给图片中的某些行/位置/分组，1 开始的行号放 targetRows。",
    "- ordered：原文给出可与图片人员行一一对应的一列值，按顺序放 values。",
    "- global：该字段在文字中恰好只有一个值，且没有任何按人或按组区分的迹象。",
    "- ambiguous：出现多个候选值，但原文无法判断分别属于谁；values 放全部候选值，并说明原因。",
    "医院和日期分别判断 scope。不要因为图片已有值就改变 scope；你只忠实报告文字表达。",
    "name 纠正只能使用 rows，并用 targetRows 指明被纠正的图片行。",
    "evidence 必须摘录支持这条赋值的简短原文；没有证据就不要创建赋值。",
    "",
    "没有相应材料时数组为空；读不到或看不清的内容一律留空。",
    "只输出 json，不要解释、不要 markdown、不要输出最终 records。输出形状必须是：",
    '{"imageRows":[{"row":1,"name":"","hospital":"","date":"","note":"","evidence":""}],' +
      '"textPeople":[{"name":"","note":"","evidence":""}],' +
      '"assignments":[{"field":"date","value":"","values":[],"scope":"global",' +
      '"targetNames":[],"targetRows":[],"evidence":""}],"unreadable":""}',
    "示例中的空字符串只是格式占位符，不是本次数据。",
  ].join("\n");

  const PROVIDERS = [
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      defaultModel: "deepseek-flash",
      // 同一模型既能读图也能出 json，所以不用区分文本/图片路径
      supportsImage: true,
      keyPlaceholder: "粘贴 DeepSeek API Key（sk- 开头）",
      help: "在 platform.deepseek.com 创建 API Key。密钥只存本机浏览器。",
      models: ["deepseek-flash", "deepseek-v4-pro"],
    },
    {
      id: "openai-compatible",
      label: "其它 OpenAI 兼容接口",
      endpoint: "",
      defaultModel: "",
      supportsImage: true,
      keyPlaceholder: "粘贴该服务的 API Key",
      help:
        "填任意 OpenAI 兼容服务的地址与模型名，例如本机 Ollama" +
        "（http://localhost:11434/v1/chat/completions，模型填 qwen2.5vl）。" +
        "注意：该地址必须在页面的 CSP 白名单里，否则浏览器会直接拦掉请求。",
      models: [],
    },
  ];

  function getProvider(id) {
    return PROVIDERS.find((provider) => provider.id === id) || null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------ 请求构造 */

  /**
   * 构造 user 消息的 content。
   * 图片必须放在 user 消息里 —— 接口规定 system / assistant 里出现图片会返回 400。
   */
  function buildContent(text, image) {
    if (!image) return text;
    return [
      { type: "text", text: text },
      {
        type: "image_url",
        // 用 base64 data URL 内联，避免依赖外部图床；接口从内容判断真实格式
        image_url: { url: "data:" + image.mime + ";base64," + image.base64 },
      },
    ];
  }

  /**
   * 构造完整请求体。抽成纯函数是为了能在 Node 里断言 ——
   * 请求形状错了只会在运行时才炸，而这里没有真实 key 可测。
   */
  function buildRequestBody(options) {
    const text = (options.text || "").trim();
    const image = options.image || null;

    // 模型只提取两种来源各自表达的事实与作用范围。图文合并由 mergeExtraction()
    // 在本地按固定规则执行，不能再把业务流程交给模型自由发挥。
    let userText;
    if (image && text) {
      userText =
        "【文字材料（用户主动输入）】\n" +
        text +
        "\n\n【图片材料】随附的图片。\n" +
        "请严格按 system 消息的提取契约，分别输出图片行、文字人员与文字赋值。" +
        "不要合并、不要决定覆盖关系、不要输出最终 records。";
    } else if (image) {
      userText =
        "只有图片材料。逐行提取 imageRows；textPeople 和 assignments 必须为空。" +
        "不要输出最终 records。";
    } else {
      userText =
        "只有文字材料。提取 textPeople 与 assignments；imageRows 必须为空。\n\n" + text;
    }

    return {
      model: options.model,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: buildContent(userText, image) },
      ],
      // JSON Output：必须同时满足「提示词里出现 json 字样」+ 给出格式示例
      response_format: { type: "json_object" },
      // 给足余量，避免 json 被截断成半个对象（详见 MAX_OUTPUT_TOKENS 的说明）
      max_tokens: options.maxTokens || MAX_OUTPUT_TOKENS,
      // 思考 token 与正文共用 max_tokens，抽名单不需要长链推理，关掉更稳
      thinking: { type: THINKING_TYPE },
      temperature: 0,
      stream: false,
    };
  }

  /* ------------------------------------------------------------ 响应处理 */

  /**
   * 输出被长度限制截断时的报错。
   *
   * 必须说清两件事，否则用户会照着旧文案去"分批解析"，而根因根本不在名单长度：
   *   1. 这是输出预算被用完了（思考 token 与正文共用同一份额度）；
   *   2. 带图片时要明确"图片没法分批"——旧文案让人把照片分两半上传，是做不到的。
   */
  function truncatedError(hasImage, maxTokens) {
    return new Error(
      "模型输出被长度限制截断了（finish_reason=length）——" +
        "输出预算 " + (maxTokens || MAX_OUTPUT_TOKENS) + " token 被用完，正文没有生成完整。" +
        "如果是名单很长，请分批解析" +
        (hasImage
          ? "（图片没法分批，可以把签到表分几段拍、或每个部门一张图，分几次解析后追加结果）。"
          : "（按行拆成几段，分几次解析，结果会自动追加到表格里）。"),
    );
  }

  /**
   * 从模型返回里取出 json 文本。
   * 官方文档明确提到 JSON Output 偶尔会返回空内容，所以空内容要给可操作的提示，
   * 而不是让 JSON.parse 抛一句没头没尾的错。
   *
   * 这里**不做**截断处理：`extractRecords` 会在调用它之前就按 finish_reason 抛错，
   * 因为那里才知道调用方的输入形态（有没有图片），文案才给得准。
   * 下面这个分支只作为兜底 —— 直接调用本函数时不该拿到截断的响应。
   */
  function extractJsonText(payload) {
    const choice = payload && payload.choices && payload.choices[0];
    const message = choice && choice.message;
    const content = message && message.content;
    if (typeof content !== "string" || !content.trim()) {
      const finish = choice && choice.finish_reason;
      if (finish === "length") {
        throw truncatedError(false, null);
      }
      throw new Error(
        "模型返回了空内容。这是 JSON Output 的已知偶发问题，重试一次通常就好了。",
      );
    }
    // 有些兼容服务会包一层 markdown 代码块，容错剥掉
    return content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  /* ---------------------------------------------- 本地工作流：事实 -> 最终记录 */

  const SCOPE_PRIORITY = { global: 0, ordered: 1, rows: 2, named: 3 };
  const ASSIGNABLE_FIELDS = ["name", "hospital", "date"];
  const ASSIGNMENT_SCOPES = ["named", "rows", "ordered", "global", "ambiguous"];

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function cleanList(value) {
    if (!Array.isArray(value)) return [];
    return value.map(clean).filter(Boolean);
  }

  function cleanRows(value) {
    if (!Array.isArray(value)) return [];
    const seen = {};
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0 && !seen[item] && (seen[item] = true));
  }

  function normalizedName(value) {
    return clean(value).replace(/\s+/g, "").toLocaleLowerCase();
  }

  function pushUnique(list, value) {
    const text = clean(value);
    if (text && list.indexOf(text) < 0) list.push(text);
  }

  function makeWorkflowRow(item, source, imageRow) {
    const note = clean(item && item.note);
    const name = clean(item && item.name);
    return {
      name: name,
      hospital: clean(item && item.hospital),
      dateRaw: clean(item && (item.date != null ? item.date : item.dateRaw)),
      aiNote: note,
      aiSources: {
        name: source,
        hospital: source,
        date: source,
      },
      workflowIssues: [],
      workflowConflicts: [],
      _imageRow: imageRow || null,
      // 图片上的原始姓名快照，命名赋值匹配用（姓名纠正会改掉 name）
      _imageName: name,
      _fieldRules: {},
    };
  }

  function addRowIssue(record, message, field) {
    if (!record) return;
    pushUnique(record.workflowIssues, message);
    if (field && !record.workflowConflicts.some((item) => item.field === field && item.message === message)) {
      record.workflowConflicts.push({ field: field, message: message });
    }
  }

  function assignmentValue(assignment) {
    return clean(assignment && assignment.value);
  }

  function normalizeAssignment(item, index, warnings) {
    if (!item || typeof item !== "object") {
      pushUnique(warnings, "第 " + (index + 1) + " 条文字赋值不是对象，已忽略");
      return null;
    }
    const field = clean(item.field);
    const scope = clean(item.scope);
    if (ASSIGNABLE_FIELDS.indexOf(field) < 0) {
      pushUnique(warnings, "第 " + (index + 1) + " 条文字赋值的 field 无效，已忽略");
      return null;
    }
    if (ASSIGNMENT_SCOPES.indexOf(scope) < 0) {
      pushUnique(warnings, "第 " + (index + 1) + " 条文字赋值的 scope 无效，已忽略");
      return null;
    }
    return {
      field: field,
      scope: scope,
      value: assignmentValue(item),
      values: cleanList(item.values),
      targetNames: cleanList(item.targetNames),
      targetRows: cleanRows(item.targetRows),
      evidence: clean(item.evidence),
      index: index,
      droppedNote: clean(item.note),
    };
  }

  function findByNames(records, names) {
    const wanted = names.map(normalizedName).filter(Boolean);
    // 姓名可能已被 rows 赋值纠正过，而模型手里的姓名是从图片读的。
    // 同时认「当前姓名」与「图片上的原始姓名」，否则同一人的点名赋值会找不到目标、
    // 转而在 :504 的兜底分支里新增一行 —— 一次改名就变成两个人。
    return records.filter(
      (record) =>
        wanted.indexOf(normalizedName(record.name)) >= 0 ||
        (record._imageName && wanted.indexOf(normalizedName(record._imageName)) >= 0),
    );
  }

  function findByImageRows(records, rows) {
    return records.filter((record) => rows.indexOf(record._imageRow) >= 0);
  }

  function assignmentLabel(assignment) {
    return assignment.field === "date" ? "日期" : assignment.field === "hospital" ? "医院" : "姓名";
  }

  function applyValue(record, assignment, value) {
    const text = clean(value);
    const label = assignmentLabel(assignment);
    if (!text) {
      addRowIssue(record, "文字中的" + label + "赋值为空，未覆盖原值", assignment.field);
      return;
    }

    const priority = SCOPE_PRIORITY[assignment.scope];
    const previous = record._fieldRules[assignment.field];
    if (previous && previous.priority === priority && previous.value !== text) {
      addRowIssue(
        record,
        "文字中有两个同等范围但不同的" + label + "：" + previous.value + " / " + text,
        assignment.field,
      );
      return;
    }
    if (previous && previous.priority > priority) return;

    if (assignment.field === "date") record.dateRaw = text;
    else record[assignment.field] = text;
    record.aiSources[assignment.field] = "text:" + assignment.scope;
    record._fieldRules[assignment.field] = { priority: priority, value: text };
  }

  function targetsForAssignment(records, assignment) {
    if (assignment.scope === "global") return records.slice();
    if (assignment.scope === "named") return findByNames(records, assignment.targetNames);
    if (assignment.scope === "rows") return findByImageRows(records, assignment.targetRows);
    return [];
  }

  function markAmbiguous(records, assignment, warnings) {
    let targets = [];
    if (assignment.targetNames.length) targets = findByNames(records, assignment.targetNames);
    else if (assignment.targetRows.length) targets = findByImageRows(records, assignment.targetRows);
    else targets = records.slice();

    const values = assignment.values.length ? assignment.values : [assignment.value].filter(Boolean);
    const message =
      "文字中的" + assignmentLabel(assignment) + "无法确定对应关系" +
      (values.length ? "（候选：" + values.join(" / ") + "）" : "");
    if (!targets.length) pushUnique(warnings, message);
    targets.forEach((record) => addRowIssue(record, message, assignment.field));
  }

  function applyAssignments(records, assignments, warnings, fieldFilter) {
    assignments
      .filter((assignment) => assignment && fieldFilter(assignment))
      .sort((left, right) => {
        const lp = left.scope === "ambiguous" ? -1 : SCOPE_PRIORITY[left.scope];
        const rp = right.scope === "ambiguous" ? -1 : SCOPE_PRIORITY[right.scope];
        return lp - rp || left.index - right.index;
      })
      .forEach((assignment) => {
        if (assignment.scope === "ambiguous") {
          markAmbiguous(records, assignment, warnings);
          return;
        }
        if (assignment.field === "name" && assignment.scope !== "rows") {
          pushUnique(warnings, "姓名纠正没有指向明确图片行，已忽略");
          return;
        }
        if (assignment.scope === "ordered") {
          const imageRecords = records.filter((record) => record._imageRow != null);
          if (!imageRecords.length || assignment.values.length !== imageRecords.length) {
            const message =
              "文字中的" + assignmentLabel(assignment) + "顺序值数量与图片人员行数不一致";
            pushUnique(warnings, message);
            imageRecords.forEach((record) => addRowIssue(record, message, assignment.field));
            return;
          }
          imageRecords.forEach((record, index) => applyValue(record, assignment, assignment.values[index]));
          return;
        }

        const targets = targetsForAssignment(records, assignment);
        if (!targets.length) {
          pushUnique(
            warnings,
            "文字中的" + assignmentLabel(assignment) + "赋值找不到目标：" +
              (assignment.targetNames.join("、") || assignment.targetRows.join("、") || assignment.scope),
          );
          return;
        }
        targets.forEach((record) => applyValue(record, assignment, assignment.value));
      });
  }

  /**
   * 把模型提取出的独立事实按固定工作流合并。这里才是业务规则的唯一实现：
   * 图片建立基础行；文字姓名补齐缺失人员；文字赋值按 global < ordered < rows < named
   * 从低到高覆盖。同等作用范围出现不同值时不猜，转成行级冲突。
   */
  function mergeExtraction(payload) {
    const input = payload && typeof payload === "object" ? payload : {};
    const warnings = [];
    const hasWorkflowShape =
      Array.isArray(input.imageRows) || Array.isArray(input.textPeople) || Array.isArray(input.assignments);
    if (!hasWorkflowShape && Array.isArray(input.records)) {
      return {
        records: [],
        warnings: ["模型返回了旧版 records 格式，未让它绕过本地工作流"],
        unreadable: "模型返回了旧版格式，请重试一次。",
      };
    }

    const imageRows = Array.isArray(input.imageRows) ? input.imageRows : [];
    const records = imageRows
      .filter((item) => item && typeof item === "object")
      .map((item, index) => makeWorkflowRow(item, "image", index + 1));
    const assignments = (Array.isArray(input.assignments) ? input.assignments : [])
      .map((item, index) => normalizeAssignment(item, index, warnings))
      .filter(Boolean);

    // assignments.note 曾经被当成「不确定」并用在每一行上 —— 一次带 note 的 global
    // 赋值就把整批标成需处理、谁也生成不了。表达不确定的唯一通道是 ambiguous，
    // 所以这里的 note 一律不采用；真出现了就留一条线索，而不是静默丢掉。
    assignments.forEach((assignment) => {
      if (!assignment.droppedNote) return;
      pushUnique(
        warnings,
        "第 " + (assignment.index + 1) + " 条文字赋值的 note 已忽略" +
          "（存疑请改用 ambiguous 作用范围）：" + assignment.droppedNote,
      );
    });

    // 姓名纠正必须先做，后续 named 赋值与 textPeople 才能命中纠正后的姓名。
    applyAssignments(records, assignments, warnings, (assignment) => assignment.field === "name");

    // 姓名被改掉后，其余赋值里那些从图片读来的姓名就成了旧名。
    // 在这里把旧名改写成纠正后的姓名，让它们仍然指向同一个人，而不是各自新增一行。
    // 只动得到 rows 纠正的那些行 —— 旧名匹配不到任何记录时保持原样，交给后面的兜底分支。
    assignments.forEach((assignment) => {
      if (assignment.field !== "name" || assignment.scope !== "rows") return;
      const corrected = findByImageRows(records, assignment.targetRows).filter(
        (record) => record._imageName && record.name !== record._imageName,
      );
      if (!corrected.length || !assignment.value) return;
      assignments.forEach((other) => {
        if (other === assignment) return;
        other.targetNames = other.targetNames.map((name) =>
          corrected.some((record) => normalizedName(record._imageName) === normalizedName(name))
            ? assignment.value
            : name,
        );
      });
    });

    const textPeople = Array.isArray(input.textPeople) ? input.textPeople : [];
    textPeople.forEach((person) => {
      if (!person || typeof person !== "object") return;
      const name = clean(person.name);
      if (!name) return;
      const matches = findByNames(records, [name]);
      const target = matches[0] || makeWorkflowRow({ name: name }, "text", null);
      if (!matches.length) records.push(target);
      const note = clean(person.note);
      if (note) {
        target.aiNote = [target.aiNote, note].filter(Boolean).join("；");
      }
    });

    // 模型偶尔漏填 textPeople，但 named 的目标本身也是明确出现的姓名证据。
    assignments.forEach((assignment) => {
      if (assignment.scope !== "named") return;
      assignment.targetNames.forEach((name) => {
        if (findByNames(records, [name]).length) return;
        const row = makeWorkflowRow({ name: name }, "text", null);
        addRowIssue(row, "该姓名来自文字赋值目标，但模型未列入 textPeople，请核对", "name");
        records.push(row);
      });
    });

    applyAssignments(records, assignments, warnings, (assignment) => assignment.field !== "name");

    records.forEach((record) => {
      delete record._fieldRules;
    });

    return {
      records: records,
      warnings: warnings,
      unreadable: clean(input.unreadable),
    };
  }

  /**
   * 把模型返回的对象规整成内部记录，并**复用规则解析那套校验**。
   *
   * 这是本模块最重要的一段：AI 的输出绝不能绕过校验直接进生成队列。
   * 缺项的一律标记出来交给用户在表格里改，而不是静默生成一份有问题的证书。
   *
   * ⚠ 字段名必须用 core 约定的形态，不能自创：
   *   core.validateRecord 读的是 `dateRaw`（原始日期字符串），不是 `dateText`。
   *   传错字段名的后果是**永远报「缺少颁发日期」**——一个静默的、看起来像
   *   "AI 没抽到日期"的错误，实际是适配层写错了。别改字段名。
   *
   * @param {object} payload 模型返回的 json
   * @param {object} core window.CertCore（用它的 validateRecord）
   */
  function normalize(payload, core) {
    const merged = mergeExtraction(payload);
    const raw = merged.records;
    const records = [];

    raw.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const note = clean(item.aiNote != null ? item.aiNote : item.note);

      // 按 core 的约定构造：dateRaw 放原始字符串，validateRecord 自己解析
      const dateRaw = clean(item.dateRaw != null ? item.dateRaw : item.date);
      const base = {
        name: clean(item.name),
        hospital: clean(item.hospital),
        dateRaw: dateRaw,
      };

      if (!core || typeof core.validateRecord !== "function") {
        throw new Error("cert-core 未加载，无法校验 AI 结果（不能跳过校验直接生成）。");
      }
      const validated = core.validateRecord(base);
      const workflowIssues = Array.isArray(item.workflowIssues) ? item.workflowIssues : [];
      workflowIssues.forEach((issue) => pushUnique(validated.issues, issue));
      if (note) pushUnique(validated.issues, "AI 提取含存疑信息，请核对");
      validated.status = validated.issues.length ? "invalid" : "ready";

      // 日期解析成功时，把展示用的 dateText 也补上（表格允许直接改这一列）
      const extra = {};
      if (validated.date) {
        extra.dateText = validated.date.year + "/" +
          Number(validated.date.month) + "/" + Number(validated.date.day);
      }

      records.push(Object.assign({}, validated, extra, {
        lineNo: index + 1,
        selected: validated.status === "ready",
        aiNote: note,
        aiSources: item.aiSources || {},
        aiConflicts: Array.isArray(item.workflowConflicts) ? item.workflowConflicts.slice() : [],
      }));
    });

    return {
      records: records,
      unreadable: merged.unreadable,
      warnings: merged.warnings,
    };
  }

  /* -------------------------------------------------------------- 主流程 */

  /**
   * 调 AI 抽取名单。
   *
   * @param {object} options
   * @param {string} options.text 文本输入（可为空，只要给了图片）
   * @param {{base64:string, mime:string, name:string}|null} options.image 图片（可选）
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {string} [options.endpoint] 覆盖端点（用于"其它 OpenAI 兼容接口"）
   * @param {object} options.core window.CertCore
   * @param {AbortSignal} [options.signal]
   * @param {(stage:string)=>void} [options.onStage]
   * @returns {Promise<{records:Array, unreadable:string, usage:object|null, raw:string}>}
   */
  async function extractRecords(options) {
    const { text, image, apiKey, model, core, signal, onStage } = options;
    const endpoint = options.endpoint || (getProvider("deepseek") || {}).endpoint;

    if (!endpoint) throw new Error("没有配置接口地址。");
    if (!apiKey) throw new Error("请先填写 API Key。");
    if (!model) throw new Error("请先填写模型名。");
    if (!text && !image) throw new Error("没有可解析的内容：请填文本或选一张图片。");

    const body = buildRequestBody({ text: text, image: image, model: model });

    if (onStage) onStage(image ? "正在识别图片…" : "正在解析文本…");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (signal && signal.aborted) throw error;
        throw new Error("请求超时（超过 " + Math.round(DEFAULT_TIMEOUT_MS / 1000) + " 秒）。");
      }
      throw new Error(
        "请求失败：" + (error && error.message ? error.message : String(error)) +
          " —— 常见原因是网络不通、Key 填错，或该地址不在页面 CSP 白名单里（会被浏览器直接拦掉）。",
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    const rawText = await response.text();
    if (!response.ok) {
      // DeepSeek 的错误响应**带 CORS 头**，所以这里能读到真实原因（不像 Adobe 会被掩盖）
      let detail = "";
      try {
        const json = JSON.parse(rawText);
        detail = (json.error && (json.error.message || json.error.type)) || "";
      } catch {
        detail = rawText.slice(0, 200);
      }
      if (response.status === 401 || response.status === 403) {
        detail += "（请检查 API Key 是否正确、是否还有余额）";
      }
      throw new Error("HTTP " + response.status + "：" + (detail || "未知错误"));
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error(
        "服务端返回的不是 JSON（HTTP " + response.status + "）：" + rawText.slice(0, 200),
      );
    }

    // 截断检查必须在取正文和 JSON.parse **之前**，两个原因：
    //   1. 被截断的 json 解析出来是半个对象，走到 parse 只会得到一句
    //      "不是合法 json"+200 字乱码，把真正的原因盖掉（官方文档也提醒过
    //      finish_reason="length" 时 content 可能被截断）；
    //   2. 截断时 content 可能直接为空，那样会先撞上 extractJsonText 里的
    //      "空内容"分支，拿到一句不含输入形态的兜底文案 —— 带图片的用户就会
    //      被建议去"按行拆分"，而照片根本没法拆。
    // 放在这里还能拿到真实的调用形态（有没有图片），文案才给得准。
    const finishReason =
      payload.choices && payload.choices[0] && payload.choices[0].finish_reason;
    if (finishReason === "length") {
      throw truncatedError(Boolean(image), body.max_tokens);
    }

    const jsonText = extractJsonText(payload);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("模型输出的不是合法 json：" + jsonText.slice(0, 200));
    }

    if (onStage) onStage("正在校验…");
    const normalized = normalize(parsed, core);

    return {
      records: normalized.records,
      unreadable: normalized.unreadable,
      warnings: normalized.warnings,
      usage: payload.usage || null,
      raw: jsonText,
    };
  }

  /** 把 File 读成 { base64, mime, name }，并在本地先做大小与格式检查。 */
  function readImageFile(file, readAsDataUrl) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error("没有选择图片。"));
        return;
      }
      if (ALLOWED_IMAGE_TYPES.indexOf(file.type) < 0) {
        reject(
          new Error(
            "不支持的图片格式：" + (file.type || "未知") + "。支持 JPEG / PNG / GIF / WebP。",
          ),
        );
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        reject(
          new Error(
            "图片太大（" + Math.round(file.size / 1024 / 1024) + " MB），上限 " +
              Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + " MB。请压缩或裁剪后重试。",
          ),
        );
        return;
      }
      readAsDataUrl(file)
        .then((dataUrl) => {
          const comma = String(dataUrl).indexOf(",");
          if (comma < 0) {
            reject(new Error("图片读取失败。"));
            return;
          }
          resolve({
            base64: String(dataUrl).slice(comma + 1),
            mime: file.type,
            name: file.name || "image",
          });
        })
        .catch(() => reject(new Error("图片读取失败。")));
    });
  }

  return {
    PROVIDERS: PROVIDERS,
    FIELDS: FIELDS,
    PROMPT: PROMPT,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
    ALLOWED_IMAGE_TYPES: ALLOWED_IMAGE_TYPES,
    getProvider: getProvider,
    buildRequestBody: buildRequestBody,
    extractJsonText: extractJsonText,
    // 导出供测试覆盖「带图片」那条分支：extractRecords 里要 mock fetch 才走得到
    truncatedError: truncatedError,
    mergeExtraction: mergeExtraction,
    normalize: normalize,
    extractRecords: extractRecords,
    readImageFile: readImageFile,
  };
});
