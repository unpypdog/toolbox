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
 *   - 日期允许缺段：素材只给到年月就只存年月，缺的那段留给用户补，绝不由模型编
 *
 * ⚠ 图片不只是名单表格：聊天记录截图里既有被转发进来的名单图，也有关于医院和日期的
 *   文字说明，两者都是事实来源（前者进 imageRows/textPeople，后者进 assignments）。
 *   所以**不能因为「输入是图片」就要求 assignments 为空** —— 那正是「聊天记录只能
 *   提取出姓名」这个真实故障的根因（见 buildRequestBody 里的注释）。
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
 *        所以浏览器直连可用，且 401 时能读到真实错误正文，而不是被浏览器
 *        包装成一句误导性的「没有 CORS 头」。
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
  /**
   * 一次能带的图片张数上限。
   * 真实用法就是「聊天截图（说明都在里面）+ 一张完整名单」两张，留出余量到 4 张。
   * 再多张会把上下文预算吃光（图片 token 很贵），模型也更容易在多张图之间串行 ——
   * 串了就是错名单，宁可让用户分两次解析再核对。
   */
  const MAX_IMAGES = 4;
  /** 所有图片合计上限：先在客户端拦一道，避免把请求体撑爆 */
  const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
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
    "【图片的形态】图片不只是名单表格，还可能是聊天记录截图、便签、批注、文件说明。",
    "图片里的**文字说明和表格里的姓名一样是材料**，不要因为某段文字不在表格里就当装饰丢掉：",
    "- 被转发的名单图、单独发出的姓名清单：姓名进 imageRows 或 textPeople；",
    "- 关于医院、日期的说明（「医院换成〈机构全称A〉」「日期写〈年份A〉年〈月份A〉月」这类）：",
    "  进 assignments，作用范围按它指向的对象判断。",
    "",
    "【图片事实 imageRows】",
    "逐行读取与人员明确关联的 name、hospital、date，保持图片行序，row 从 1 开始。",
    "多张图片时每行还要写 image（第几张图，1 开始），并按图片先后顺序排列。",
    "**每张图各自逐行提取，绝不跨图去重**：同一个人在多张图里都出现就各写一行，",
    "合并与补齐由程序完成；你少写一行，人数就会少一个。",
    "图片可能只有姓名，也可能是完整表格；存在的字段都要读，读不到就留空，不要猜。",
    "图片里的装饰、模板、示例或往期日期若不属于任何人员行，不要放进人员字段；",
    "属于说明性文字的按上一条进 assignments。",
    "姓名逐字照抄；看不清就在 note 说明，不要自行纠正。evidence 填该行可见的简短原文。",
    "",
    "【文字人员 textPeople】",
    "列出材料中明确作为证书领取人的姓名，只放姓名本身，去掉编号、职称、工号和称谓。",
    "聊天记录里单独发出的姓名清单也算人员。不要把医院、日期或说明文字当成人名，",
    "也不要把聊天抬头、群名、联系人昵称里的姓名当成人名。evidence 填包含该姓名的简短原文。",
    "",
    "【文字赋值 assignments】",
    "把材料中的医院、日期以及明确的姓名纠正提取成赋值指令。这里只报告值和它在原文中的",
    "作用范围，不执行覆盖。field 只能是 hospital、date、name。",
    "date 只写读到的部分：读到年月日写 YYYY-MM-DD，只读到年月写 YYYY-MM，只读到年写 YYYY。",
    "**绝不补材料里没有的月或日**，也不要为了凑格式编造任何一段。",
    "scope 只能是下面五种：",
    "- named：原文明确定义给某些姓名，姓名放 targetNames。",
    "- rows：原文明确定义给图片中的某些行/位置/分组，1 开始的行号放 targetRows；",
    "  说的是整张图里的全部人时，写 targetImage 并让 targetRows 留空（程序按「那张图的全部行」",
    "  处理）；说的是某几个人时不要用 rows，改用 named。",
    "- ordered：原文给出可与图片人员行一一对应的一列值，按顺序放 values。",
    "- global：该字段恰好只有一个值，且没有任何按人或按组区分的迹象。",
    "- ambiguous：出现多个候选值，但原文无法判断分别属于谁；values 放全部候选值。",
    "  候选值明确属于某几个人、只是分不清谁配哪个值时，仍然用 ambiguous，但**必须**把这些姓名",
    "  放进 targetNames（或把行号放进 targetRows）——留空等于告诉程序「整批都可能受影响」，",
    "  整批都会被标成待确认；能确定范围时绝不能留空。",
    "医院和日期分别判断 scope。不要因为图片已有值就改变 scope；你只忠实报告原文表达。",
    "name 纠正只能使用 rows，并用 targetRows 指明被纠正的图片行。",
    "只有明确指向本次名单的说明才是赋值：提问、否定、复述、举例、寒暄都不是事实，",
    "被否掉的候选值绝不能当成赋值；同一件事改过口的取最后一次的说法，**只输出最终那个值**，",
    "不要同时输出被推翻的旧值 —— 两个都输出会让同一个人拿到前后矛盾的信息。",
    "语音条、表情、被遮挡或看不清的部分读不到内容，写进 unreadable，不要猜。",
    "evidence 必须摘录支持这条赋值的简短原文；没有证据就不要创建赋值。",
    "",
    "没有相应材料时数组为空；读不到或看不清的内容一律留空。",
    "只输出 json，不要解释、不要 markdown、不要输出最终 records。输出形状必须是：",
    '{"imageRows":[{"image":1,"row":1,"name":"","hospital":"","date":"","note":"","evidence":""}],' +
      '"textPeople":[{"name":"","note":"","evidence":""}],' +
      '"assignments":[{"field":"date","value":"","values":[],"scope":"global","targetImage":0,' +
      '"targetNames":[],"targetRows":[],"evidence":""}],"unreadable":""}',
    "示例中的空字符串只是格式占位符，不是本次数据。",
  ].join("\n");

  const CONVERSATION_PROMPT = [
    "你是证书名单校对助手。浏览器会给你当前记录快照、未解决问题、已确认决策、最近对话和用户本轮指令。",
    "你的职责是理解用户想改什么并提出结构化操作；你不能直接重写整张表，也不能补造材料中不存在的事实。",
    "姓名、医院、日期都是高风险字段。日期只允许写入 dateRaw；材料缺少日时不能自行猜日，但用户本轮明确指定某日时必须按用户指令修改，这不属于猜测。",
    "targetId 必须逐字使用 currentRecords 里的 recordId。用户指代不清时不要猜目标，把问题写入 questions，operations 留空。",
    "confirmedDecisions 和 recentConversation 是历史，不是不可撤销的锁。最新用户指令明确出现“确认、全部、统一、覆盖、改为”等含义时，视为已经授权覆盖旧决定，不得反复要求再次确认。",
    "例如用户先说不补日，后来明确说“所有记录统一补为10号”，应立即提出修改操作；不能再次询问是否覆盖。",
    "此例应输出 set_day_all 且 day=10；不要把多个不同年月拼成一个含“或”的 dateRaw 字符串。",
    "允许的操作只有：",
    "1. set_field：{type,targetId,field,value,reason}，field 仅 name/hospital/dateRaw；",
    "2. set_field_many：{type,targetIds:[...],field,value,reason}，明确点名多条时使用；",
    "3. set_field_all：{type,field,value,reason}，用户明确说全部/所有记录时使用；",
    "4. set_field_by_source：{type,sourceImage,field,value,reason}，用户明确说第几张图片整批时使用；记录来源见 aiImageRefs；",
    "5. set_day_all：{type,day,reason}，用户说所有记录按各自年月统一补同一个日时使用；浏览器会保留各条年月；",
    "6. set_day_by_source：{type,sourceImage,day,reason}，某张图按各自年月统一补日时使用；",
    "7. add_record：{type,record:{name,hospital,dateRaw},reason}；",
    "8. remove_record：{type,targetId,reason}；",
    "9. merge_records：{type,targetIds:[...],record:{name,hospital,dateRaw},reason}。",
    "删除和合并必须是用户明确要求或当前重复关系非常明确；拿不准就提问。",
    "reply 用简短中文说明你理解了什么；decisions 只写本轮可长期沿用且用户明确确认的事实。",
    "只输出 json，不要 markdown。输出形状：",
    '{"reply":"","operations":[],"questions":[],"decisions":[]}',
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
   * 多张图按数组顺序排开，编号 1..N 与提示词、user 消息里的说法一致。
   */
  function buildContent(text, images) {
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean);
    if (!list.length) return text;
    return [{ type: "text", text: text }].concat(
      list.map((image) => ({
        type: "image_url",
        // 用 base64 data URL 内联，避免依赖外部图床；接口从内容判断真实格式
        image_url: { url: "data:" + image.mime + ";base64," + image.base64 },
      })),
    );
  }

  /**
   * 构造完整请求体。抽成纯函数是为了能在 Node 里断言 ——
   * 请求形状错了只会在运行时才炸，而这里没有真实 key 可测。
   */
  function buildRequestBody(options) {
    const text = (options.text || "").trim();
    // 两种调用都认：images 数组（多图）与单个 image（老调用方与既有测试）
    const images = (Array.isArray(options.images) ? options.images : [options.image]).filter(Boolean);

    // 模型只提取两种来源各自表达的事实与作用范围。图文合并由 mergeExtraction()
    // 在本地按固定规则执行，不能再把业务流程交给模型自由发挥。
    //
    // ⚠ 这里曾经对「只有图片」的输入要求 textPeople 与 assignments 必须为空，
    //   理由是「图片只是一张名单表」。真实素材打脸：用户最自然的用法就是把整张
    //   聊天记录截图丢进来（指令全在图里），那一行字直接把医院、日期和后补的姓名
    //   全部丢掉，界面上只剩下姓名 —— 看起来像「AI 读不出信息」，其实是提示词禁止它读。
    //   现在图片里的文字说明与表格里的姓名同等对待，只是仍然不许模型自己做合并。
    //
    // ⚠ 多张图时还要说清编号与「不许跨图去重」：合并是本地工作流的事（mergeSameNameRows），
    //   模型自己删一行就等于少一个人，而这种少是静默的。
    const countText = "共 " + images.length + " 张图片，按先后顺序编号 1 到 " + images.length + "。";
    let userText;
    if (images.length && text) {
      userText =
        "【文字材料（用户主动输入）】\n" +
        text +
        "\n\n【图片材料】随附 " + countText + "\n" +
        "请严格按 system 消息的提取契约，分别输出图片行、文字人员与文字赋值。" +
        "每张图各自逐行提取并写明 image 编号，不要跨图去重。" +
        "不要合并、不要决定覆盖关系、不要输出最终 records。";
    } else if (images.length) {
      userText =
        "只有图片材料，" + countText + "\n" +
        "先判断每张图是哪一类：名单/表格，还是聊天记录、便签、批注。\n" +
        "图片里的文字说明同样算材料：被转发的名单图、单独发出的姓名清单是人员，" +
        "关于医院或日期的说明是文字赋值。\n" +
        "请严格按 system 消息的提取契约输出 imageRows、textPeople 与 assignments；" +
        "每行写明它来自第几张图，不要跨图去重。" +
        "不要合并、不要决定覆盖关系、不要输出最终 records。";
    } else {
      userText =
        "只有文字材料。提取 textPeople 与 assignments；imageRows 必须为空。\n\n" + text;
    }

    return {
      model: options.model,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: buildContent(userText, images) },
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

  function buildConversationRequestBody(options) {
    const images = (Array.isArray(options.images) ? options.images : []).filter(Boolean);
    const context = options.context && typeof options.context === "object" ? options.context : {};
    const userText =
      "以下是本轮上下文。仅根据它提出操作，不要输出完整 records。\n" +
      JSON.stringify(context) +
      (images.length
        ? "\n本轮另附原始图片，请只用它核对用户本轮明确要求的字段，不要重新抽取整批。"
        : "");
    return {
      model: options.model,
      messages: [
        { role: "system", content: CONVERSATION_PROMPT },
        { role: "user", content: buildContent(userText, images) },
      ],
      response_format: { type: "json_object" },
      max_tokens: options.maxTokens || 8192,
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

  /**
   * 建一行工作表记录。
   *
   * `imageRef` 是这张图里的坐标 { image, row }：image 是第几张图，row 是模型给的图内行号
   * （没给就按该图内的出现顺序补）。多张图时同一个 row 会在不同图里重复出现，
   * 所以行定位必须连图号一起看 —— 只按 row 匹配会把第 2 张图第 1 行错认成第 1 张图第 1 行。
   */
  function makeWorkflowRow(item, source, imageRow, imageRef) {
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
      // 摊平后的全局序号（数组顺序），只在没写明图号的旧格式里当兜底匹配
      _imageRow: imageRow || null,
      // 这一行来自哪些图的哪些行：同名合并后会有多条，赋值定位必须全部认得
      _imageRows: imageRef ? [imageRef] : [],
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
      targetImage: Number(item.targetImage) > 0 ? Math.floor(Number(item.targetImage)) : 0,
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

  /**
   * 按图内坐标找行。
   *
   * 多张图时行号会在图与图之间重复，所以匹配要看 { image, row } 整个坐标：
   *   - 模型给了 targetImage 就只认那张图；
   *   - 没给（老格式、单图、或原文没说是哪张图）就按行号在**所有图**里找，
   *     并额外认「摊平后的全局序号」—— 多图被模型连续编号时也能命中。
   * 同名合并进来的行带着多条坐标，任何一条命中都算命中，否则按行号下的赋值会找不到人。
   */
  function findByImageRows(records, rows, image) {
    if (!rows.length) return [];
    return records.filter((record) =>
      (record._imageRows || []).some(
        (ref) => rows.indexOf(ref.row) >= 0 && (!image || ref.image === image),
      ) || (!image && record._imageRow != null && rows.indexOf(record._imageRow) >= 0),
    );
  }

  /** ordered 的一列值对应哪些行：指定了图号就只用那张图的行，顺序保持摊平顺序。 */
  function orderedTargets(records, image) {
    const imageRecords = records.filter((record) => (record._imageRows || []).length > 0);
    if (!image) return imageRecords;
    return imageRecords.filter((record) =>
      record._imageRows.some((ref) => ref.image === image),
    );
  }

  function assignmentLabel(assignment) {
    return assignment.field === "date" ? "日期" : assignment.field === "hospital" ? "医院" : "姓名";
  }

  /**
   * 把日期文本折成可比较的键：`2022`／`2022-10`／`2022-10-20`。
   * 只用来判断「谁更精确、说的还是不是同一个月」，严格解析仍然只由 core 负责。
   */
  function dateKey(value, core) {
    if (!core || typeof core.parseDateParts !== "function") return "";
    try {
      const parts = core.parseDateParts(value);
      return [parts.year, parts.month, parts.day].filter(Boolean).join("-");
    } catch {
      return "";
    }
  }

  /**
   * 文字日期是不是「更粗但说的是同一个月」——是的话就不该覆盖已经拿到的精确日期。
   *
   * 真实场景：聊天里说「那张图片里的名单写〈年〉年〈月〉月份左右」，同时用户还补了一张
   * 完整名单，上面写着具体的年月日。前者只是同一个月的模糊回忆，用它覆盖等于把用户刚
   * 补进来的「日」又抹掉，还得让人再填一遍。
   *
   * 只在**包含关系**下让路：文字更粗、且图上的值以它为前缀。文字说了别的月份/年份
   * （那就是真正的改写指令）或者本身更精确时，一律按老规矩由文字覆盖。
   */
  function keepsMorePreciseDate(current, incoming, core) {
    const next = dateKey(incoming, core);
    const existing = dateKey(current, core);
    if (!next || !existing) return false;
    if (next === existing) return false; // 一样精确，走正常覆盖（等价于不改）
    return existing.indexOf(next + "-") === 0;
  }

  function applyValue(record, assignment, value, warnings, core) {
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

    if (
      assignment.field === "date" &&
      keepsMorePreciseDate(record.dateRaw, text, core)
    ) {
      if (warnings) {
        pushUnique(
          warnings,
          "文字日期「" + text + "」只到年月，没有覆盖更精确的「" + record.dateRaw +
            "」（同一个月，保留更完整的那条）",
        );
      }
      record._fieldRules[assignment.field] = { priority: priority, value: text };
      return;
    }

    if (assignment.field === "date") record.dateRaw = text;
    else record[assignment.field] = text;
    record.aiSources[assignment.field] = "text:" + assignment.scope;
    record._fieldRules[assignment.field] = { priority: priority, value: text };
  }

  /**
   * rows 作用范围到底覆盖哪些行。
   *
   * 实测踩到的坑（DeepSeek 真实返回）：聊天里说「那张图片里的名单写〈年份〉年〈月份〉月」，
   * 模型给了 `scope:"rows"` + `targetImage:1`，**targetRows 却是空的** —— 它眼里的「那张图
   * 里的名单」就是整张图，不需要逐行点名。旧实现只认行号，于是赋值找不到目标、
   * 一整列日期全空，而提示词里那句「找不到目标」用户根本看不出该怎么办。
   *
   * 现在的口径：行号为空 = 这一组就是「那张图里的人」；连图号都没写就是「所有图片里的人」。
   * **姓名纠正不放宽** —— 那条一旦放宽就会把整批人改成同一个名字。
   */
  function rowsTargets(records, assignment) {
    if (assignment.targetRows.length) {
      return findByImageRows(records, assignment.targetRows, assignment.targetImage);
    }
    if (assignment.field === "name") return [];
    return orderedTargets(records, assignment.targetImage);
  }

  function targetsForAssignment(records, assignment) {
    if (assignment.scope === "global") return records.slice();
    if (assignment.scope === "named") return findByNames(records, assignment.targetNames);
    if (assignment.scope === "rows") return rowsTargets(records, assignment);
    return [];
  }

  /**
   * ambiguous 没写目标时标记哪些行。
   *
   * 不能再无条件「整批」：一条没写目标的 ambiguous 会把整批标成需处理，用户一条都生成不了
   * （约束 11 记的那次事故就是这么来的）。收窄按证据强弱挑一层，不做并集：
   *   1. 同一字段上有过**点名到人**的赋值 → 就用那批人（点名是最强的证据）；
   *   2. 只有过按行/按图的赋值 → 用那批行；
   *   3. 一处都没有 → 才退回整批。
   * 实测例子：聊天先给图片里那批人定了日期，又对另外几个点名的人改了口 ——
   * 那条没收窄的 ambiguous 把 19 个与它无关的人一起标红了。
   */
  function ambiguousTargets(records, assignments, assignment) {
    const collect = (scope) => {
      const list = [];
      const push = (record) => {
        if (list.indexOf(record) < 0) list.push(record);
      };
      assignments.forEach((other) => {
        if (!other || other === assignment || other.field !== assignment.field) return;
        if (other.scope !== scope) return;
        if (scope === "named") findByNames(records, other.targetNames).forEach(push);
        else rowsTargets(records, other).forEach(push);
      });
      return list;
    };

    const byName = collect("named");
    if (byName.length) return byName;
    const byRows = collect("rows");
    if (byRows.length) return byRows;
    return records.slice();
  }

  function markAmbiguous(records, assignments, assignment, warnings) {
    let targets = [];
    if (assignment.targetNames.length) targets = findByNames(records, assignment.targetNames);
    else if (assignment.targetRows.length) {
      targets = findByImageRows(records, assignment.targetRows, assignment.targetImage);
    } else targets = ambiguousTargets(records, assignments, assignment);

    const values = assignment.values.length ? assignment.values : [assignment.value].filter(Boolean);
    const message =
      "文字中的" + assignmentLabel(assignment) + "无法确定对应关系" +
      (values.length ? "（候选：" + values.join(" / ") + "）" : "");
    if (!targets.length) pushUnique(warnings, message);
    targets.forEach((record) => addRowIssue(record, message, assignment.field));
  }

  function applyAssignments(records, assignments, warnings, fieldFilter, core) {
    assignments
      .filter((assignment) => assignment && fieldFilter(assignment))
      .sort((left, right) => {
        const lp = left.scope === "ambiguous" ? -1 : SCOPE_PRIORITY[left.scope];
        const rp = right.scope === "ambiguous" ? -1 : SCOPE_PRIORITY[right.scope];
        return lp - rp || left.index - right.index;
      })
      .forEach((assignment) => {
        if (assignment.scope === "ambiguous") {
          markAmbiguous(records, assignments, assignment, warnings);
          return;
        }
        if (assignment.field === "name" && assignment.scope !== "rows") {
          pushUnique(warnings, "姓名纠正没有指向明确图片行，已忽略");
          return;
        }
        if (assignment.scope === "ordered") {
          const imageRecords = orderedTargets(records, assignment.targetImage);
          if (!imageRecords.length || assignment.values.length !== imageRecords.length) {
            const message =
              "文字中的" + assignmentLabel(assignment) + "顺序值数量与图片人员行数不一致";
            pushUnique(warnings, message);
            imageRecords.forEach((record) => addRowIssue(record, message, assignment.field));
            return;
          }
          imageRecords.forEach((record, index) =>
            applyValue(record, assignment, assignment.values[index], warnings, core),
          );
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
        // 行号为空被放宽成「整组」时必须说出来：套错范围比不套更贵，
        // 用户至少要在提示里看到「这次是凭什么套上去的」。
        if (
          assignment.scope === "rows" &&
          !assignment.targetRows.length &&
          assignment.field !== "name"
        ) {
          pushUnique(
            warnings,
            "文字中的" + assignmentLabel(assignment) + "没有写明具体行号，已按" +
              (assignment.targetImage ? "第 " + assignment.targetImage + " 张图" : "所有图片") +
              "里的 " + targets.length + " 行整组套用，请核对范围",
          );
        }
        targets.forEach((record) => applyValue(record, assignment, assignment.value, warnings, core));
      });
  }

  /** 同名合并时允许互相补齐的字段（name 是合并键，不在这里）。 */
  const MERGEABLE_FIELDS = ["hospital", "dateRaw"];

  /**
   * 同名行合并：同一个人在多张图里各出现一次时，必须收敛成一行。
   *
   * 为什么必须在本地做：用户常同时给「聊天截图里那份残缺名单」和「一张完整名单」，
   * 两张图里都有这个人。模型看不到另一张图里的同名人该怎么处理（也不该由它决定），
   * 所以提示词要求它**逐图如实提取、绝不跨图去重**，去重与补齐在这里完成。
   * 少了这一步，一次上传就会给同一个人发出两份证书 —— 静默的、发出去就收不回来的错。
   *
   * 规则（保守优先，绝不猜）：
   *   - 姓名归一化后相同（去空格、忽略大小写）才可能是同一人；
   *   - 只有一边有值的字段直接补过去 —— 这就是「用完整名单补全残缺名单」；
   *   - 两边都有值且不同 → **不合并**：两行都留、都标成需处理，由用户判断是不是同一个人；
   *   - 空姓名行永不参与合并（那本来就是缺项，合并只会把它藏起来）。
   *
   * 被并进来的 note 会一并继承，也就继承了「AI 存疑」标记 —— 宁可多让人看一眼，
   * 也不能把一条本来存疑的信息在合并时悄悄洗白。
   */
  function mergeSameNameRows(records, warnings) {
    const groups = new Map();
    records.forEach((record) => {
      const key = normalizedName(record.name);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    const removed = new Set();
    const mergedNames = [];
    let filled = 0;

    groups.forEach((group) => {
      if (group.length < 2) return;
      const keeper = group[0];
      let mergedHere = false;
      group.slice(1).forEach((donor) => {
        const conflicts = MERGEABLE_FIELDS.map((field) => {
          const left = clean(keeper[field]);
          const right = clean(donor[field]);
          return left && right && left !== right
            ? assignmentLabel({ field: field }) + "「" + left + "」与「" + right + "」"
            : "";
        }).filter(Boolean);

        if (conflicts.length) {
          // 同名但值对不上：可能是同名两个人，也可能是同一人的两条矛盾来源。
          // 这里不猜 —— 两条都保留并标红，用户删掉多余的那条就行。
          const message =
            "疑似重复：同名「" + keeper.name + "」在两处的值不一致（" + conflicts.join("，") +
            "），两条都保留，请确认要哪一条";
          addRowIssue(keeper, message);
          addRowIssue(donor, message);
          return;
        }

        MERGEABLE_FIELDS.forEach((field) => {
          if (clean(keeper[field]) || !clean(donor[field])) return;
          keeper[field] = donor[field];
          if (donor.aiSources && donor.aiSources[field]) {
            keeper.aiSources[field] = donor.aiSources[field];
          }
          filled += 1;
        });
        // 坐标并进来：合并之后，按行号下的赋值仍然要能找到这一行
        (donor._imageRows || []).forEach((ref) => keeper._imageRows.push(ref));
        if (donor.aiNote) {
          keeper.aiNote = [keeper.aiNote, donor.aiNote].filter(Boolean).join("；");
        }
        removed.add(donor);
        mergedHere = true;
      });
      if (mergedHere) mergedNames.push(keeper.name);
    });

    if (!mergedNames.length) return;

    // 原地替换数组内容：调用方持有的是同一个引用（后面还要用 records）
    const survivors = records.filter((record) => !removed.has(record));
    records.length = 0;
    survivors.forEach((record) => records.push(record));

    const shown = mergedNames.slice(0, 6).join("、");
    pushUnique(
      warnings,
      "同名行已合并 " + mergedNames.length + " 组（" + shown +
        (mergedNames.length > 6 ? " 等 " + mergedNames.length + " 人" : "") + "）" +
        (filled ? "，空缺字段由另一处补上 " + filled + " 处" : "") +
        "；若其中确有同名不同人，请核对后再生成",
    );
  }

  /**
   * 把模型提取出的独立事实按固定工作流合并。这里才是业务规则的唯一实现：
   * 图片建立基础行；文字姓名补齐缺失人员；同名行收敛成一行；
   * 文字赋值按 global < ordered < rows < named 从低到高覆盖。
   * 同等作用范围出现不同值时不猜，转成行级冲突。
   *
   * @param {object} payload 模型返回的 json
   * @param {object} [core] window.CertCore；只用来比较日期的精确程度。
   *   不传时行为与以前一致（文字赋值一律覆盖），仍可独立调用。
   */
  function mergeExtraction(payload, core) {
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
    // 图内行号：模型没写 row 就按该图内的出现顺序补；没写 image 就当成第 1 张图
    // （单图是绝大多数调用，这样旧响应不改也能命中按行号的赋值）。
    const seenPerImage = {};
    const records = imageRows
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const imageIndex = Number(item.image) > 0 ? Math.floor(Number(item.image)) : 1;
        seenPerImage[imageIndex] = (seenPerImage[imageIndex] || 0) + 1;
        const rowInImage =
          Number(item.row) > 0 ? Math.floor(Number(item.row)) : seenPerImage[imageIndex];
        return makeWorkflowRow(item, "image", index + 1, { image: imageIndex, row: rowInImage });
      });
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
      const corrected = findByImageRows(
        records,
        assignment.targetRows,
        assignment.targetImage,
      ).filter((record) => record._imageName && record.name !== record._imageName);
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

    // 同名行必须先收敛：否则「残缺名单 + 完整名单」两张图会让同一个人生成两份证书。
    // 放在文字赋值之前，是因为合并会把被并行的图片坐标接过来，按行号的赋值才找得到人。
    mergeSameNameRows(records, warnings);

    applyAssignments(records, assignments, warnings, (assignment) => assignment.field !== "name", core);

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
    const merged = mergeExtraction(payload, core);
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
        aiImageRefs: Array.isArray(item._imageRows) ? item._imageRows.slice() : [],
        aiConflicts: Array.isArray(item.workflowConflicts) ? item.workflowConflicts.slice() : [],
      }));
    });

    return {
      records: records,
      unreadable: merged.unreadable,
      warnings: merged.warnings,
    };
  }

  /* ---------------------------------------------------------- 多轮修改协议 */

  function operationId(index) {
    return "op-" + Date.now().toString(36) + "-" + index;
  }

  function recordId() {
    return "record-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  /**
   * 把模型给的操作收紧成浏览器可执行的白名单。
   * 无效目标、未知字段、空合并都只进入 errors，不会混入可应用列表。
   */
  function normalizeOperations(payload, records, core) {
    const source = payload && typeof payload === "object" ? payload : {};
    const current = Array.isArray(records) ? records : [];
    const byId = new Map(current.map((item) => [String(item.recordId || ""), item]));
    const allowedFields = new Set(["name", "hospital", "dateRaw"]);
    const operations = [];
    const errors = [];

    function addSetOperation(raw, index, targetId, suffix, forcedValue) {
      const field = raw.field === "date" ? "dateRaw" : String(raw.field || "");
      if (!byId.has(targetId)) {
        errors.push("第 " + (index + 1) + " 个修改找不到目标记录。");
        return;
      }
      if (!allowedFields.has(field)) {
        errors.push("第 " + (index + 1) + " 个修改使用了不允许的字段。");
        return;
      }
      const before = byId.get(targetId);
      operations.push({
        id: operationId(String(index) + "-" + suffix),
        type: "set_field",
        reason: String((raw && raw.reason) || "").trim(),
        targetId,
        field,
        value: String(forcedValue === undefined ? (raw.value == null ? "" : raw.value) : forcedValue).trim(),
        targetName: before.name || "未命名记录",
        before: String(before[field] || ""),
      });
    }

    function idsFromSource(sourceImage) {
      const image = Number(sourceImage);
      return current
        .filter((record) =>
          Array.isArray(record.aiImageRefs) &&
          record.aiImageRefs.some((ref) => Number(ref && ref.image) === image),
        )
        .map((record) => String(record.recordId || ""))
        .filter(Boolean);
    }

    function addDayOperations(raw, index, targetIds) {
      const day = Number(raw.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        errors.push("第 " + (index + 1) + " 个统一补日操作的 day 无效。");
        return;
      }
      targetIds.forEach((targetId, offset) => {
        const record = byId.get(targetId);
        let parts;
        try {
          parts = core.parseDateParts(record && record.dateRaw);
        } catch {
          parts = null;
        }
        if (!parts || !parts.year || !parts.month) {
          errors.push("「" + ((record && record.name) || "未命名记录") + "」缺少可保留的年月，未自动补日。");
          return;
        }
        addSetOperation(
          Object.assign({}, raw, { field: "dateRaw" }),
          index,
          targetId,
          "day-" + offset,
          parts.year + "/" + parts.month + "/" + day,
        );
      });
    }

    (Array.isArray(source.operations) ? source.operations : []).forEach((raw, index) => {
      const type = String((raw && raw.type) || "");
      const base = {
        id: operationId(index),
        type,
        reason: String((raw && raw.reason) || "").trim(),
      };

      if (type === "set_field") {
        const targetId = String(raw.targetId || "");
        addSetOperation(raw, index, targetId, "single");
        return;
      }

      if (type === "set_field_many" || type === "set_field_all" || type === "set_field_by_source") {
        let targetIds = [];
        if (type === "set_field_all") targetIds = current.map((record) => String(record.recordId || ""));
        else if (type === "set_field_by_source") targetIds = idsFromSource(raw.sourceImage);
        else if (Array.isArray(raw.targetIds)) {
          targetIds = Array.from(new Set(raw.targetIds.map(String))).filter((id) => byId.has(id));
        }
        if (!targetIds.length) {
          errors.push("第 " + (index + 1) + " 个批量修改没有匹配到记录。");
          return;
        }
        targetIds.forEach((targetId, offset) => addSetOperation(raw, index, targetId, offset));
        return;
      }

      if (type === "set_day_all" || type === "set_day_by_source") {
        const targetIds = type === "set_day_all"
          ? current.map((record) => String(record.recordId || ""))
          : idsFromSource(raw.sourceImage);
        if (!targetIds.length) {
          errors.push("第 " + (index + 1) + " 个统一补日操作没有匹配到记录。");
          return;
        }
        addDayOperations(raw, index, targetIds);
        return;
      }

      if (type === "add_record") {
        const item = raw.record && typeof raw.record === "object" ? raw.record : {};
        const validated = core.validateRecord({
          name: String(item.name || "").trim(),
          hospital: String(item.hospital || "").trim(),
          dateRaw: String(item.dateRaw || item.date || "").trim(),
        });
        operations.push(Object.assign(base, {
          record: Object.assign({}, validated, { recordId: recordId() }),
        }));
        return;
      }

      if (type === "remove_record") {
        const targetId = String(raw.targetId || "");
        if (!byId.has(targetId)) {
          errors.push("第 " + (index + 1) + " 个删除找不到目标记录。");
          return;
        }
        operations.push(Object.assign(base, {
          targetId,
          targetName: byId.get(targetId).name || "未命名记录",
        }));
        return;
      }

      if (type === "merge_records") {
        const targetIds = Array.isArray(raw.targetIds)
          ? Array.from(new Set(raw.targetIds.map(String))).filter((id) => byId.has(id))
          : [];
        if (targetIds.length < 2) {
          errors.push("第 " + (index + 1) + " 个合并不足两条有效目标。");
          return;
        }
        const item = raw.record && typeof raw.record === "object" ? raw.record : {};
        const validated = core.validateRecord({
          name: String(item.name || "").trim(),
          hospital: String(item.hospital || "").trim(),
          dateRaw: String(item.dateRaw || item.date || "").trim(),
        });
        operations.push(Object.assign(base, {
          targetIds,
          targetNames: targetIds.map((id) => byId.get(id).name || "未命名记录"),
          record: Object.assign({}, validated, { recordId: targetIds[0] }),
        }));
        return;
      }

      errors.push("第 " + (index + 1) + " 个操作类型不受支持。");
    });

    return {
      reply: String(source.reply || "").trim(),
      operations,
      questions: (Array.isArray(source.questions) ? source.questions : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
      decisions: (Array.isArray(source.decisions) ? source.decisions : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
      errors,
    };
  }

  function revalidateRecord(record, core, resolvedField) {
    const validated = core.validateRecord({
      name: record.name || "",
      hospital: record.hospital || "",
      dateRaw: record.dateRaw || "",
    });
    const conflictField = resolvedField === "dateRaw" ? "date" : resolvedField;
    const remainingConflicts = Array.isArray(record.aiConflicts)
      ? record.aiConflicts.filter((item) => !conflictField || item.field !== conflictField)
      : [];
    remainingConflicts.forEach((item) => {
      if (item && item.message) pushUnique(validated.issues, item.message);
    });
    validated.status = validated.issues.length ? "invalid" : "ready";
    return Object.assign({}, record, validated, {
      recordId: record.recordId || recordId(),
      aiNote: remainingConflicts.length ? record.aiNote || "" : "",
      aiConflicts: remainingConflicts,
    });
  }

  /** 纯函数式应用：返回新数组，调用方确认前的 state 不会被改动。 */
  function applyOperations(records, operations, core) {
    let next = (records || []).map((record) => Object.assign({}, record));
    const applied = [];
    (operations || []).forEach((operation) => {
      if (operation.type === "set_field") {
        const index = next.findIndex((item) => item.recordId === operation.targetId);
        if (index < 0) return;
        next[index][operation.field] = operation.value;
        next[index] = revalidateRecord(next[index], core, operation.field);
        applied.push(operation.id);
      } else if (operation.type === "add_record") {
        next.push(revalidateRecord(Object.assign({}, operation.record), core));
        applied.push(operation.id);
      } else if (operation.type === "remove_record") {
        const before = next.length;
        next = next.filter((item) => item.recordId !== operation.targetId);
        if (next.length !== before) applied.push(operation.id);
      } else if (operation.type === "merge_records") {
        const indexes = operation.targetIds
          .map((id) => next.findIndex((item) => item.recordId === id))
          .filter((index) => index >= 0);
        if (indexes.length < 2) return;
        const insertAt = Math.min.apply(Math, indexes);
        const targets = new Set(operation.targetIds);
        next = next.filter((item) => !targets.has(item.recordId));
        next.splice(insertAt, 0, revalidateRecord(Object.assign({}, operation.record), core));
        applied.push(operation.id);
      }
    });
    next.forEach((record, index) => {
      record.lineNo = index + 1;
    });
    return { records: next, applied };
  }

  /**
   * 对最常见、且用户意图已经完全明确的批量命令做本地解析。
   * 这不是自由文本 AI：只认很窄的句式，命中后仍走 normalizeOperations 和确认预览。
   * 好处是模型不会在“用户已经确认”之后继续循环追问，也不会漏掉 23 条里的某几条。
   */
  function deriveExplicitOperations(instruction, records, core) {
    const text = String(instruction || "").replace(/\s+/g, "").trim();
    if (!text) return null;

    const allDay = text.match(
      /(?:全部|所有|全体|整批)(?:\d+条)?记录.*?日期.*?(?:补(?:为|成)?|改(?:为|成)?|设(?:为|成)?).*?(\d{1,2})(?:号|日)/,
    );
    if (allDay) {
      const day = Number(allDay[1]);
      const result = normalizeOperations(
        {
          reply: "已按当前表格中每条记录原有的年月，统一补为 " + day + " 号。",
          operations: [{ type: "set_day_all", day, reason: "用户明确要求全部记录统一补日" }],
          questions: [],
          decisions: ["全部记录按各自年月统一补为 " + day + " 号"],
        },
        records,
        core,
      );
      if (result.operations.length) return result;
    }

    const imageNumber = { 一: 1, 二: 2, 三: 3, 四: 4 };
    const byImage = text.match(
      /第([一二三四1-4])张(?:图片|图像|图).*?(?:日期|年月).*?(\d{2,4})年(?:的)?(\d{1,2})月份?/,
    );
    if (byImage) {
      const sourceImage = imageNumber[byImage[1]] || Number(byImage[1]);
      let year = Number(byImage[2]);
      if (year < 100) year += 2000;
      const month = Number(byImage[3]);
      const value = year + "/" + month;
      const result = normalizeOperations(
        {
          reply: "已把第 " + sourceImage + " 张图片对应记录的日期改为 " + value + "。",
          operations: [{
            type: "set_field_by_source",
            sourceImage,
            field: "dateRaw",
            value,
            reason: "用户明确指定图片范围和年月",
          }],
          questions: [],
          decisions: ["第 " + sourceImage + " 张图片对应记录的日期为 " + value],
        },
        records,
        core,
      );
      if (result.operations.length) return result;
    }
    return null;
  }

  async function continueConversation(options) {
    const endpoint = options.endpoint || (getProvider("deepseek") || {}).endpoint;
    if (!endpoint) throw new Error("没有配置接口地址。");
    if (!options.apiKey) throw new Error("请先填写 API Key。");
    if (!options.model) throw new Error("请先填写模型名。");
    if (!options.context || !String(options.context.instruction || "").trim()) {
      throw new Error("请先写清这次要修改什么。");
    }

    const body = buildConversationRequestBody({
      model: options.model,
      context: options.context,
      images: options.images,
    });
    if (options.onStage) options.onStage("正在理解修改要求…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + options.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (options.signal && options.signal.aborted) throw error;
        throw new Error("请求超时（超过 " + Math.round(DEFAULT_TIMEOUT_MS / 1000) + " 秒）。");
      }
      throw new Error("请求失败：" + (error && error.message ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    }

    const rawText = await response.text();
    if (!response.ok) {
      let detail = rawText.slice(0, 200);
      try {
        const parsedError = JSON.parse(rawText);
        detail = (parsedError.error && (parsedError.error.message || parsedError.error.type)) || detail;
      } catch {
        /* 保留原始摘要。 */
      }
      throw new Error("HTTP " + response.status + "：" + (detail || "未知错误"));
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error("服务端返回的不是 JSON：" + rawText.slice(0, 200));
    }
    const finishReason = payload.choices && payload.choices[0] && payload.choices[0].finish_reason;
    if (finishReason === "length") throw truncatedError(false, body.max_tokens);
    const jsonText = extractJsonText(payload);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("模型输出的不是合法 json：" + jsonText.slice(0, 200));
    }
    const normalized = normalizeOperations(parsed, options.records, options.core);
    return Object.assign(normalized, {
      usage: payload.usage || null,
      raw: jsonText,
    });
  }

  /* -------------------------------------------------------------- 主流程 */

  /**
   * 调 AI 抽取名单。
   *
   * @param {object} options
   * @param {string} options.text 文本输入（可为空，只要给了图片）
   * @param {Array<{base64:string, mime:string, name:string}>} [options.images] 图片（0~4 张，按顺序编号）
   * @param {{base64:string, mime:string, name:string}} [options.image] 单张图片（等价于 images: [image]）
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {string} [options.endpoint] 覆盖端点（用于"其它 OpenAI 兼容接口"）
   * @param {object} options.core window.CertCore
   * @param {AbortSignal} [options.signal]
   * @param {(stage:string)=>void} [options.onStage]
   * @returns {Promise<{records:Array, unreadable:string, usage:object|null, raw:string}>}
   */
  async function extractRecords(options) {
    const { text, apiKey, model, core, signal, onStage } = options;
    const images = (
      Array.isArray(options.images) ? options.images : [options.image]
    ).filter(Boolean);
    const endpoint = options.endpoint || (getProvider("deepseek") || {}).endpoint;

    if (!endpoint) throw new Error("没有配置接口地址。");
    if (!apiKey) throw new Error("请先填写 API Key。");
    if (!model) throw new Error("请先填写模型名。");
    if (!text && !images.length) throw new Error("没有可解析的内容：请填文本或选一张图片。");

    const body = buildRequestBody({ text: text, images: images, model: model });

    if (onStage) onStage(images.length ? "正在识别图片…" : "正在解析文本…");

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
      // DeepSeek 的错误响应**带 CORS 头**，所以这里能读到真实原因，不会被浏览器掩盖
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
      throw truncatedError(images.length > 0, body.max_tokens);
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

  /** 把 File 读成 { base64, mime, name, bytes }，并在本地先做大小与格式检查。 */
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
            // 合计体积闸门要用它。base64 会膨胀 4/3，不能拿字符串长度当体积。
            bytes: Number(file.size) || 0,
          });
        })
        .catch(() => reject(new Error("图片读取失败。")));
    });
  }

  /**
   * 往已有列表里追加图片：逐张做格式/体积检查，并卡住张数与合计体积。
   *
   * 一张坏图不该让整批失败，所以合法的都读进来，非法的逐条给出原因。
   * 张数与体积是**先到先得**：超出的那几张直接不收，而不是把已有的挤掉。
   *
   * @returns {Promise<{images:Array, errors:string[]}>}
   */
  async function addImageFiles(existing, files, readAsDataUrl) {
    const images = Array.isArray(existing) ? existing.slice() : [];
    const errors = [];
    const list = Array.prototype.slice.call(files || []);
    let total = images.reduce((sum, image) => sum + (Number(image.bytes) || 0), 0);

    for (const file of list) {
      if (images.length >= MAX_IMAGES) {
        errors.push("最多一次解析 " + MAX_IMAGES + " 张图片，后面的没有加入。");
        break;
      }
      let image;
      try {
        image = await readImageFile(file, readAsDataUrl);
      } catch (error) {
        errors.push((file && file.name ? file.name + "：" : "") + error.message);
        continue;
      }
      if (total + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
        errors.push(
          (image.name ? image.name + "：" : "") + "这几张图片合计超过 " +
            Math.round(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024) + " MB，请压缩后再试。",
        );
        break;
      }
      total += image.bytes;
      images.push(image);
    }

    return { images: images, errors: errors };
  }

  return {
    PROVIDERS: PROVIDERS,
    FIELDS: FIELDS,
    PROMPT: PROMPT,
    CONVERSATION_PROMPT: CONVERSATION_PROMPT,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_IMAGES: MAX_IMAGES,
    MAX_TOTAL_IMAGE_BYTES: MAX_TOTAL_IMAGE_BYTES,
    MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
    ALLOWED_IMAGE_TYPES: ALLOWED_IMAGE_TYPES,
    getProvider: getProvider,
    buildRequestBody: buildRequestBody,
    buildConversationRequestBody: buildConversationRequestBody,
    extractJsonText: extractJsonText,
    // 导出供测试覆盖「带图片」那条分支：extractRecords 里要 mock fetch 才走得到
    truncatedError: truncatedError,
    mergeExtraction: mergeExtraction,
    normalize: normalize,
    normalizeOperations: normalizeOperations,
    applyOperations: applyOperations,
    deriveExplicitOperations: deriveExplicitOperations,
    extractRecords: extractRecords,
    continueConversation: continueConversation,
    readImageFile: readImageFile,
    addImageFiles: addImageFiles,
  };
});
