/**
 * 名单解析 —— AI 抽取（OpenAI 兼容接口，浏览器直连）
 *
 * ⚠ 定位：这是**增强**，不是替代。规则解析（cert-core 的 prepareRecordsFromText）
 *   仍然是默认路径 —— 免费、离线、快、结果可预测。AI 只在两种情况下用：
 *     1) 规则解析失败或结果不对（表格、分行、一句话叙述、含职称工号……）
 *     2) 输入是图片（手机拍的签到表、微信截图），规则解析根本做不到
 *
 * ⚠ 最大的风险是幻觉，而证书印错名字不可挽回。所以本模块的设计原则是：
 *   - 抽取结果必须过和规则解析**同一套**校验（core.validateRecord），
 *     缺姓名/缺医院/日期非法的一律标红，绝不静默进生成队列
 *   - 每条记录带上模型的 note（有疑问的地方），一并显示给用户核对
 *   - 永远不自动补全姓名：提示词明确要求「没看清就留空并写进 note」
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

  /** 提示词里的字段名，改这里要同步改 PROMPT 与 normalize */
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
    "你是证书名单的信息抽取器。从用户给的材料里抽出「颁发证书」所需的三项信息。",
    "",
    "【材料可能有两部分】",
    "用户可能同时给出「一张图片」和「一段文字」。图片可能只有姓名，也可能每一行都包含",
    "姓名、医院和日期；文字可能补充、修正或分组说明。它们是同一次颁发的同一个名单，",
    "不是两批人。",
    "",
    "【内部流程：维护一张数据表，按四步执行 —— 这条最重要】",
    "在推理过程中维护一张人员数据表，列为：name、hospital、date、note，外加一列 source。",
    "source 记录每一行的来源（图片 / 文字）。这张表是本次解析的唯一事实来源，",
    "全程按下面的顺序推进，不要跳步：",
    "",
    "第 1 步 · 先看清表格结构",
    "先分别确认图片和文字各自能提供哪些字段：可能只有姓名，也可能是姓名、医院、日期都有的",
    "完整表格。不要预设图片只有姓名。",
    "",
    "第 2 步 · 解析图片，填充数据表",
    "逐行读取 name、hospital、date，有一项填一项、读不到的字段留空，不要猜。",
    "保持图片原有的行顺序，并把这些行的 source 标为图片。",
    "不能因为常见图片只有姓名而忽略其中已经存在的医院或日期 —— 与具体人员同一行/同一列明确关联",
    "的医院和日期要正常提取。只有装饰文字、模板日期、示例日期、往期证书日期这类，",
    "不属于任何人员数据行的内容才忽略，不要拿它们与文字里的日期比较，也不要取更早或更晚的一个。",
    "图片中的人员行是合并锚点：文字可以明确纠正某个人的姓名、或补充图片漏掉的人，",
    "但同一个人不能因此变成两条。",
    "",
    "第 3 步 · 解析文字，逐人匹配并补充到对应行",
    "文字可能描述整批，也可能分成多个人或多个小组；医院和日期**不一定整批相同**。",
    "先判断每个值的适用范围，再填进对应行：",
    "- 匹配优先级从高到低：文字中明确点名的人 > 明确的分组/范围（如前两位、某几人、",
    "  第一组/第二组）> 行列或列表顺序能一一对应 > 唯一且无分组迹象的全局值。",
    "- 只有文字中**恰好只有一个**医院或日期，且没有任何按人/按组区分的迹象时，才把它作为",
    "  全局值应用给所有行。医院和日期要分别判断：医院可全局而日期分组，或日期全局而医院分组。",
    "- 文字里出现多个医院或多个日期时，必须逐人匹配或逐组匹配，绝不能任选一个覆盖所有人，",
    "  也不能把最后出现的值套给所有人。",
    "- 对已经匹配到某个人或小组的文字值，文字优先：只覆盖这些行的同名字段，",
    "  文字没有明确涉及的字段必须保留图片基础表格中的原值，不要清空或改写。",
    "- 多个候选值但归属不清时：该行该字段已有图片值就保留图片原值，没有就留空，",
    "  并在该行的 note 写明「多个医院/日期，无法确定对应关系」。宁可让用户核对，",
    "  也绝对不要猜一个值。",
    "- 已经明确绑定到这个人的文字字段按文字值确定，属于「已确认」，不用在 note 里表示存疑。",
    "- 文字里已经有对应行（同名或明确指向）的，只补充字段，**不要新增行**。",
    "- 只有文字里出现数据表中没有的新姓名时，才新增一行，source 标为文字。",
    "  **绝对不要**因为文字提到医院或日期，就为它们单独生成一条记录（单独建行）；",
    "  也不要因为同一个人的姓名在图片和文字里都出现就建两行。",
    "",
    "第 4 步 · 对完整数据表做分析，输出结果",
    "数据表填完后逐行核对：每人一行、name 非空、date 已统一成 YYYY-MM-DD。",
    "不要在输出阶段再凭印象补字段或改变某行的归属 —— 你只能从这张表读，",
    "表里没有的内容一律不许在输出里出现。",
    "",
    "【抽取规则】",
    "1. 一项记录 = 一个要颁发证书的人。同一个人不要拆成多条，多个人也不要合并成一条。",
    "2. name：只放姓名本身，去掉编号、职称、工号、称谓（如编号、职称、称谓词）。",
    "3. hospital：机构全称。材料里没有就留空字符串，不要猜、不要编。",
    "4. date：统一写成 YYYY-MM-DD 这种形式。材料里没有日期、或只有月份没有日子，就留空。",
    "5. note：这一条有任何不确定就写一句简短说明；完全确定就留空字符串。",
    "   如果某个字段已在文字中明确绑定到这个人或其小组，就不算不确定；如果文字中有",
    "   多个候选值却无法确定归属，必须留空并在 note 中说明，不能悄悄选一个。",
    "6. 图片里的姓名必须逐字照抄，**绝对不要补全或纠正**。看不清的字写进 note，",
    "   而不是猜一个看起来合理的名字。宁可让用户来核对。",
    "7. 抽不到任何记录时 records 为空数组，并在 unreadable 里说明原因。",
    "8. 只输出 json，不要任何解释文字、不要 markdown 代码块。",
    "",
    "【输出格式】",
    "数据表是你内部的推理过程，**不要**把它打印在 json 里。只输出：",
    '{"records":[{"name":"","hospital":"","date":"","note":""}],"unreadable":""}',
    "records 的长度与数据表的行数一致（读不到任何记录时为空数组）。",
    "",
    "【示例中出现的具体机构名与日期都是占位符，不是本次数据，绝对不要照抄】",
    "",
    "示例一（只有文字）：",
    "输入：〈姓名1〉、〈姓名2〉、〈姓名3〉 〈机构全称A〉 〈日期A〉",
    "数据表：3 行，source 都是文字；医院和日期在文字里各只有一个、且没有分组迹象，",
    "所以作为全局值填给这 3 行。",
    '输出：{"records":[{"name":"〈姓名1〉","hospital":"〈机构全称A〉","date":"〈日期A 的 YYYY-MM-DD 形式〉","note":""},' +
      '{"name":"〈姓名2〉","hospital":"〈机构全称A〉","date":"〈同上〉","note":""},' +
      '{"name":"〈姓名3〉","hospital":"〈机构全称A〉","date":"〈同上〉","note":""}],"unreadable":""}',
    "",
    "示例二（图片给姓名，文字给全局的医院与日期）：",
    "图片上是手写姓名「〈姓名甲〉/〈姓名乙〉/〈姓名丙〉」，没有任何日期；",
    "文字写着「这几个人是〈机构全称B〉的，日期〈日期B〉」。",
    "数据表：先由图片建 3 行（source = 图片），name 填好、hospital 与 date 留空；",
    "再看文字，医院和日期各只有一个值且没有分组迹象，补进这 3 行的空字段。",
    "正确输出是 3 条记录，每条的 hospital 都是「〈机构全称B〉」、date 都是〈日期B〉；",
    "绝不能出现第 4 条以机构名或日期为姓名的记录，也绝不能把日期取成图片上的任何痕迹。",
    "",
    "示例三（图片本身就是完整表格）：",
    "图片每一行都有姓名、机构和日期，文字没有修改这些字段。",
    "数据表：这 3 个字段都在第 2 步就填满，第 3 步没有可补充的内容，表不再变动。",
    "结果逐行完整保留图片里的三项信息，不能只提取姓名，也不能把某一行的机构或日期套到其他行。",
    "",
    "示例四（完整图片表格 + 文字只修正一个人的日期）：",
    "图片每行都有姓名、机构和日期；文字只明确修改〈姓名乙〉的日期。",
    "数据表：第 2 步逐行填满；第 3 步只更新〈姓名乙〉那一行的 date，该行 hospital 不变，",
    "其他行一个字段都不动。",
    "",
    "示例五（图片给姓名，文字分两组）：",
    "图片依次是「〈姓名甲〉/〈姓名乙〉/〈姓名丙〉/〈姓名丁〉」；文字明确说明",
    "「〈姓名甲〉、〈姓名乙〉：〈机构全称C〉，〈日期C〉；",
    "  〈姓名丙〉、〈姓名丁〉：〈机构全称D〉，〈日期D〉」。",
    "数据表：文字把值明确分给了两个小组，所以第 3 步逐组填，而不是当全局值。",
    "正确输出是 4 条：前两人的 hospital/date 使用 C 组，后两人使用 D 组。",
    "绝不能只保留一个日期，也绝不能把最后一组覆盖到所有人。",
    "",
    "示例六（有多个候选值但归属不清）：",
    "图片有多个人名，文字只列出「〈日期E〉、〈日期F〉」，没有说明分别属于谁。",
    "数据表：第 3 步无法把这两个日期落到具体行 —— 该行 date 已有图片原值就保留，",
    "没有就留空；两种情况都要在 note 标明文字中的日期对应关系不明确。",
    "不得任选一个日期套给所有人。",
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

    // 图片与文字是**同一次颁发的同一个名单**。图片可能本身就是含姓名/医院/日期的
    // 完整表格，必须先完整提取填入数据表，再用文字逐人/逐组补充或修正。
    let userText;
    if (image && text) {
      userText =
        "【图片】下面这张图是名单（通常是姓名，可能是手写或截图）。\n" +
        "【文字】以下是用户补充的说明：\n" +
        text +
        "\n\n请把图片与文字**合并成同一个名单**，按系统提示里的四步流程维护那张数据表：" +
        "先看清图片和文字各自能提供哪些字段；" +
        "再逐行提取图片中的姓名、医院和日期，形成基础表格，图片已有的字段都要保留；" +
        "然后把文字中的医院和日期按姓名、分组或明确顺序逐人匹配到对应行；" +
        "文字里可能有多个医院或多个日期，绝不能任选一个覆盖所有人；" +
        "只有某字段在文字里唯一且没有分组迹象时，才作为该字段的全局值；" +
        "匹配到个人或小组的文字值只覆盖对应行的同名字段，文字未涉及的图片字段不变；" +
        "文字里已经有对应行的只补充字段，不要新增行；" +
        "候选值归属不清时，保留已有图片值，没有图片值才留空，并在 note 标明。" +
        "最后以填好的数据表为准输出 json：只有文字里出现新姓名时才多一行，" +
        "同一个人不要因为两处都出现就算两条。";
    } else if (image) {
      userText = "请从这张图片里抽出证书名单。";
    } else {
      userText = text;
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

  function parseDateLoose(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return null;
    const match = text.match(/(\d{2,4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
    if (!match) return null;
    let year = match[1];
    if (year.length === 2) year = "20" + year;
    const month = String(Number(match[2])).padStart(2, "0");
    const day = String(Number(match[3])).padStart(2, "0");
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { year: year, month: month, day: day, dateText: year + "/" + m + "/" + d };
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
    const raw = payload && Array.isArray(payload.records) ? payload.records : [];
    const records = [];

    raw.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const note = String(item.note == null ? "" : item.note).trim();

      // 按 core 的约定构造：dateRaw 放原始字符串，validateRecord 自己解析
      const dateRaw = String(item.date == null ? "" : item.date).trim();
      const base = {
        name: String(item.name == null ? "" : item.name).trim(),
        hospital: String(item.hospital == null ? "" : item.hospital).trim(),
        dateRaw: dateRaw,
      };

      if (!core || typeof core.validateRecord !== "function") {
        throw new Error("cert-core 未加载，无法校验 AI 结果（不能跳过校验直接生成）。");
      }
      const validated = core.validateRecord(base);

      // 日期解析成功时，把展示用的 dateText 也补上（表格允许直接改这一列）
      const extra = {};
      if (validated.date) {
        extra.dateText = validated.date.year + "/" +
          Number(validated.date.month) + "/" + Number(validated.date.day);
      }

      records.push(Object.assign({}, validated, extra, {
        lineNo: index + 1,
        selected: true,
        aiNote: note,
      }));
    });

    return {
      records: records,
      unreadable: String((payload && payload.unreadable) || "").trim(),
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
    parseDateLoose: parseDateLoose,
    normalize: normalize,
    extractRecords: extractRecords,
    readImageFile: readImageFile,
  };
});
