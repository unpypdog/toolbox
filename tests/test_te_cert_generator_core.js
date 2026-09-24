/**
 * TE 证书工具 —— 核心逻辑测试（纯 Node，无网络、无浏览器）。
 *
 * 覆盖：
 *   1) 姓名框宽度规则（含 4 字姓名被裁掉这个真实 bug 的回归护栏）
 *   2) 日期解析与 PDF 文件命名
 *   3) AI 抽取的请求形状、校验复用与截断处理
 *   4) 多个 PDF 打包成一个 ZIP
 *   5) 模板读取，以及「云端 DOCX→PDF 与其 DOCX 生成管线已彻底移除」的反向断言
 *
 * 用法: node tests/test_te_cert_generator_core.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const TOOL = path.join(__dirname, "..", "tools", "te-cert-generator");
const core = require(path.join(TOOL, "cert-core.js"));
const direct = require(path.join(TOOL, "cert-direct-pdf.js"));
// 放在模块级而不是 testAiExtraction 内部：testTruncationEndToEnd 是同级的独立函数，
// 写在函数里它取不到，只会报一句 "ai is not defined"。
const ai = require(path.join(TOOL, "cert-ai.js"));

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

function equal(name, actual, expected) {
  check(name, actual === expected, "期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
}

const templateBytes = new Uint8Array(fs.readFileSync(path.join(TOOL, "template-general.docx")));

/** 取某个模板里姓名槽位的最终几何（cert-core 给基准，cert-direct-pdf 施加加宽规则）。 */
function nameSlotGeometry(name, templateId) {
  const model = core.printSlots(
    { name: name, hospital: "南京市第一医院", year: "2025", month: "10", day: "10" },
    templateId || "general",
  );
  const slot = model.slots.find((each) => each.key === "name");
  return {
    base: slot.spec,
    spec: direct.resolveSlot(slot, { name: name }).spec,
    chars: Array.from(name).length,
    page: model.page,
  };
}

/** 居中文字的实际落点：文本框按 spec.align 居中时，文字左右边缘在这里。 */
function centeredTextEdges(geo) {
  const content = geo.spec.width - direct.constants.textInset * 2;
  const textWidth = geo.chars * geo.base.size;
  const left = geo.spec.left + direct.constants.textInset + (content - textWidth) / 2;
  return { left: left, right: left + textWidth, textWidth: textWidth };
}


/* ------------------------------------------------------------------ 1. 姓名框 */

async function testNameBox() {
  console.log("\n[1] 姓名框宽度规则（4 字姓名被裁掉的 bug 回归）");

  const INSET = direct.constants.textInset;
  const cases = [
    { name: "张三", chars: 2 },
    { name: "倪文婧", chars: 3 },
    { name: "欧阳娜娜", chars: 4 },
    { name: "司马相如", chars: 4 },
    { name: "欧阳娜娜娜", chars: 5 },
  ];

  // 基准几何来自 cert-core.printSlots，加宽由 cert-direct-pdf.resolveSlot 施加 ——
  // 这正是真实生成路径调用的两个函数，所以这条护栏钉的是成品 PDF 的落点。
  const geo = {};
  for (const item of cases) {
    for (const templateId of ["general", "special"]) {
      const key = templateId + "/" + item.name;
      geo[key] = nameSlotGeometry(item.name, templateId);
      check(key + "（" + item.chars + " 字）定位到姓名槽位", Boolean(geo[key].spec));
    }
  }

  const THREE = nameSlotGeometry("倪文婧");
  const BASE_WIDTH = THREE.base.width;
  const CHAR_PT = THREE.base.size; // 36pt 字号 = 一个全角字宽

  // 2 字：模板原始位置（3 字基准左移过的量要还回去），框宽不变
  const two = nameSlotGeometry("张三").spec;
  equal("2 字 框宽不变", two.width, BASE_WIDTH);
  equal("2 字 位置 = 3 字基准 + 18pt", two.left, THREE.base.left + 18);

  // 3 字：校准基准，只左移不加宽
  equal("3 字 用校准基准", THREE.spec.left, THREE.base.left);
  equal("3 字 框宽仍为 " + BASE_WIDTH, THREE.spec.width, BASE_WIDTH);

  // 4 字：加宽到放得下，并整字宽左移
  const four = nameSlotGeometry("欧阳娜娜").spec;
  const need = 4 * CHAR_PT + INSET * 2;
  check(
    "4 字 框宽 " + four.width + "pt ≥ 放得下所需的 " + need + "pt",
    four.width >= need,
    "框宽不够会重演「欧阳娜娜」被裁成「欧阳娜」",
  );
  equal("4 字 左移整整一个字宽 36pt", four.left, THREE.base.left - CHAR_PT);
  equal("4 字 框宽 = 基准 + 36pt", four.width, BASE_WIDTH + CHAR_PT);
  equal("同名不同 4 字姓名几何一致", nameSlotGeometry("司马相如").spec.left, four.left);

  // 5 字：规则可外推
  const five = nameSlotGeometry("欧阳娜娜娜").spec;
  equal("5 字 左移 72pt", five.left, THREE.base.left - CHAR_PT * 2);
  check("5 字 框宽 ≥ " + (5 * CHAR_PT + INSET * 2) + "pt", five.width >= 5 * CHAR_PT + INSET * 2);

  // 核心：右边缘钉死，别挤掉与医院名之间的间隙。
  // 文本框右边缘与「居中文字」的右边缘都要恒定 —— 后者才是视觉上真正看的那个。
  console.log("  --- 右边缘必须恒定 ---");
  const rows = cases.map((item) => {
    const g = geo["general/" + item.name];
    return {
      name: item.name,
      chars: item.chars,
      boxRight: g.spec.left + g.spec.width,
      text: centeredTextEdges(g),
      width: g.spec.width,
    };
  });
  const ref3 = rows.find((row) => row.chars === 3);
  for (const row of rows) {
    if (row.chars <= 3) continue;
    check(
      row.name + "（" + row.chars + " 字）框右边缘与 3 字一致",
      Math.abs(row.boxRight - ref3.boxRight) < 0.05,
      "偏移 " + (row.boxRight - ref3.boxRight).toFixed(1) + "pt",
    );
    check(
      row.name + "（" + row.chars + " 字）文字右边缘与 3 字一致",
      Math.abs(row.text.right - ref3.text.right) < 0.05,
      "偏移 " + (row.text.right - ref3.text.right).toFixed(1) + "pt —— 右移会吃掉与医院名的间隙",
    );
  }
  // 医院名槽位的左边缘：姓名文字右边缘必须留在它左边
  const hospital = core
    .printSlots({ name: "倪文婧", hospital: "南京市第一医院", year: "2025", month: "10", day: "10" }, "general")
    .slots.find((each) => each.key === "hospital").spec;
  for (const row of rows) {
    check(
      row.name + " 文字右边缘 " + row.text.right.toFixed(1) + "pt 仍在医院名左边缘 "
        + hospital.left.toFixed(1) + "pt 之前",
      row.text.right < hospital.left,
    );
  }
  for (const row of rows) {
    check(
      row.name + " 文字左边缘 " + row.text.left.toFixed(1) + "pt 未越过页左边距",
      row.text.left > 0,
    );
  }

  // 两个模板的姓名槽位基准必须一致，否则两个版本的排版会各走一套规则
  equal(
    "两个模板的姓名槽位基准一致",
    nameSlotGeometry("倪文婧", "special").base.left,
    THREE.base.left,
  );
  equal(
    "两个模板的姓名框宽一致",
    nameSlotGeometry("倪文婧", "special").base.width,
    BASE_WIDTH,
  );

  console.log("  --- 各长度对照 ---");
  console.log("    姓名".padEnd(14) + "字数  文字左   文字右   框宽");
  for (const row of rows) {
    console.log(
      "    " + row.name.padEnd(12) + String(row.chars).padEnd(6) +
      row.text.left.toFixed(1).padEnd(9) + row.text.right.toFixed(1).padEnd(9) + row.width,
    );
  }
}

/* --------------------------------------------------------------- 2. 日期解析 */

function testDate() {
  console.log("\n[2] 日期解析（生成正确性的前提）");

  equal("25年10月10日", core.parseDate("25年10月10日").year + "-" + core.parseDate("25年10月10日").month + "-" + core.parseDate("25年10月10日").day, "2025-10-10");
  equal("2025-10-10", core.parseDate("2025-10-10").month, "10");
  equal("2025.6.3", core.parseDate("2025.6.3").month, "06");
  equal("2025/1/1", core.parseDate("2025/1/1").day, "01");

  let threw = false;
  try {
    core.parseDate("");
  } catch {
    threw = true;
  }
  check("空日期抛错", threw);

  // ---- 只有年月 / 只有年：读到的那部分必须留住，缺的那部分绝不许编 ----
  // 真实素材：聊天记录写「那张图片里的名单写〈年份〉年〈月份〉月份左右」，
  // 「日」根本不存在。旧实现一律抛「格式无法识别」，模型只能丢掉日期或自己编一个日。
  console.log("  --- 不完整日期：读到的留住、缺的留给用户补 ---");
  const partial = core.validateRecord({ name: "甲", hospital: "乙医院", dateRaw: "2022-10" });
  equal("只有年月的记录仍是需处理", partial.status, "invalid");
  equal("原始年月原样保留在 dateRaw 里（表格直接显示给人补）", partial.dateRaw, "2022-10");
  equal("不完整日期不产出 date 对象（生成路径拿不到它就印不出错证书）", partial.date, null);
  check(
    "原因写明「日期不完整」而不是「格式无法识别」",
    /日期不完整/.test(partial.issues.join("")) && /「日」/.test(partial.issues.join("")),
    partial.issues.join(" | "),
  );
  check("提示里带上已读到的年月", /2022\s*年\s*10\s*月/.test(partial.issues.join("")), partial.issues.join(""));

  const cnPartial = core.validateRecord({ name: "甲", hospital: "乙医院", dateRaw: "22年10月" });
  check(
    "中文写法「22年10月」同样只算不完整，不是格式错误",
    /日期不完整/.test(cnPartial.issues.join("")),
    cnPartial.issues.join(" | "),
  );

  const yearOnly = core.validateRecord({ name: "甲", hospital: "乙医院", dateRaw: "2022" });
  check(
    "只有年份时提示补「月」「日」",
    /日期不完整/.test(yearOnly.issues.join("")) && /「月」「日」/.test(yearOnly.issues.join("")),
    yearOnly.issues.join(" | "),
  );

  const strayNumber = core.validateRecord({ name: "甲", hospital: "乙医院", dateRaw: "10" });
  check(
    "日期格里的「10」仍是格式错误（绝不会被读成 2010 年）",
    /格式无法识别/.test(strayNumber.issues.join("")),
    strayNumber.issues.join(" | "),
  );

  let strictThrew = false;
  try {
    core.parseDate("2022-10");
  } catch {
    strictThrew = true;
  }
  check("parseDate 仍是严格契约（缺日抛错），不完整日期只走 validateRecord", strictThrew);
  equal("parseDateParts 只读到年月时 complete=false", core.parseDateParts("2022-10").complete, false);
  equal("parseDateParts 年月日齐全时 complete=true", core.parseDateParts("2022-10-20").complete, true);
  equal("中文「号」也能解析（日期正则本来就允许号）", core.parseDate("2025年1月1号").day, "01");
}

/* ----------------------------------------------------------- 3. 文件命名 */

function testOutputNaming() {
  console.log("\n[3] PDF 文件命名：预览、模板、自定义与去重");

  const records = [
    Object.assign(core.validateRecord({
      name: "张三",
      hospital: "甲/医院",
      dateRaw: "2025-10-20",
    }), { lineNo: 1 }),
    Object.assign(core.validateRecord({
      name: "张三",
      hospital: "甲/医院",
      dateRaw: "2025-10-20",
    }), { lineNo: 2 }),
  ];

  core.assignOutputNames(records);
  equal("默认预览是 PDF，不再显示 DOCX", records[0].outputName, "TE操作培训证书_张三.pdf");
  equal("同名第二份自动加 _2", records[1].outputName, "TE操作培训证书_张三_2.pdf");
  equal("fileBase 同样含去重后缀（最终下载不能丢）", records[1].fileBase, "TE操作培训证书_张三_2");
  check("重复标记只落在后续冲突项", !records[0].fileNameDuplicated && records[1].fileNameDuplicated);

  core.assignOutputNames(records, { pattern: "{序号}_{医院}_{姓名}_{日期}" });
  equal(
    "模板展开姓名/医院/日期/序号并清理非法字符",
    records[0].outputName,
    "1_甲_医院_张三_2025-10-20.pdf",
  );
  equal("序号不同后不再误判重名", records[1].outputName, "2_甲_医院_张三_2025-10-20.pdf");

  // 用 ASCII 冒号：safeFileName 只替换 Windows 非法字符，全角「：」是合法字符、
  // 会被原样保留。这条断言要验的是「去掉旧扩展名并固定 .pdf」，不是字符替换，
  // fixture 里放全角冒号会让期望值和真实行为对不上。
  records[0].outputNameOverride = "客户指定:张三.docx";
  core.assignOutputNames(records, { pattern: "不会使用_{姓名}" });
  equal("单行覆盖会去掉旧扩展名并固定为 PDF", records[0].outputName, "客户指定_张三.pdf");
  records[0].outputNameOverride = "";
  core.assignOutputNames(records, { pattern: "新规则_{姓名}" });
  equal("清空单行覆盖后恢复批量规则", records[0].outputName, "新规则_张三.pdf");

  equal(
    "合并 PDF 模板固定追加 .pdf",
    core.renderFileName("归档_{份数}人_{时间}.docx", { 份数: 3, 时间: "20250922_1200" }, "归档", "pdf"),
    "归档_3人_20250922_1200.pdf",
  );
  equal(
    "ZIP 模板固定追加 .zip",
    core.renderFileName("证书包_{时间}.pdf", { 时间: "20250922_1200" }, "证书包", "zip"),
    "证书包_20250922_1200.zip",
  );
}

/* ------------------------------------------------------- 4b. 截断的端到端路径 */

/**
 * extractRecords 里那条截断检查，靠 stub fetch 才能走到。
 *
 * 为什么值得单独测：这个检查必须发生在 extractJsonText **之前**。
 * 截断时 content 可能直接是空串，那样会先撞上"空内容"分支，拿到一句不含输入形态
 * 的兜底文案 —— 带图片的用户就会被建议去"按行拆分"，而照片根本没法拆。
 * 只测 truncatedError 是看不出这个顺序问题的。
 */
async function testTruncationEndToEnd() {
  console.log("  --- 截断：走真实的 extractRecords 路径 ---");

  const realFetch = globalThis.fetch;
  let lastBody = null;

  /** 让 fetch 返回一个 finish_reason=length 的"被截断"响应 */
  function stubFetch(content) {
    globalThis.fetch = async (_url, init) => {
      lastBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: content }, finish_reason: "length" }],
            usage: { completion_tokens: 32768 },
          }),
      };
    };
  }

  const call = (extra) =>
    ai.extractRecords(
      Object.assign(
        {
          apiKey: "sk-test",
          model: "deepseek-flash",
          endpoint: "https://example.invalid/chat/completions",
          core: core,
          text: "靳睿、耿楠",
        },
        extra,
      ),
    );

  try {
    // 截断但正文非空：旧代码会走到 JSON.parse，报"不是合法 json"+乱码
    stubFetch('{"records":[{"name":"靳睿"');
    let err = null;
    try {
      await call({});
    } catch (error) {
      err = error;
    }
    check("正文被截断时报的是输出预算问题，而不是「不是合法 json」", Boolean(err), "没有抛错");
    // 注意 detail 要写成 err ? err.message : ...
    // 直接写 `err && err.message` 时，条件里已经判过 err 为真，
    // 一旦条件失败 detail 反而会因为 err 为 null 触发别的异常，把真正的原因盖掉。
    const detailOf = (e) => (e ? e.message : "没有抛错");
    check(
      "报错里不含「不是合法 json」这种误导性措辞",
      Boolean(err) && !/不是合法 json/.test(err.message),
      detailOf(err),
    );
    check(
      "报错点明是输出预算（并带上真实预算数字）",
      Boolean(err) && /预算/.test(err.message) && /32768/.test(err.message),
      detailOf(err),
    );
    // 请求里必须真的把预算和思考开关送出去了，否则改了默认值也白搭
    equal("请求真的带上了 32768 的预算", lastBody.max_tokens, 32768);
    equal("请求真的关掉了思考模式", lastBody.thinking.type, "disabled");

    // 截断且正文为空：这条最容易被顺序问题坑 —— 会先撞"空内容"分支
    stubFetch("");
    err = null;
    try {
      await call({ image: { base64: "AAAA", mime: "image/jpeg" } });
    } catch (error) {
      err = error;
    }
    check(
      "空正文 + 带图片时，给的是「图片没法分批」而不是「按行拆分」",
      Boolean(err) && /图片没法分批/.test(err.message) && !/按行拆/.test(err.message),
      detailOf(err),
    );

    stubFetch("");
    err = null;
    try {
      await call({});
    } catch (error) {
      err = error;
    }
    check(
      "空正文 + 纯文本时，给的才是「按行拆分」",
      Boolean(err) && /按行拆/.test(err.message),
      detailOf(err),
    );

    // 反向确认：非截断的空内容仍走原来的"重试一次"提示，别被截断逻辑吞掉
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    });
    err = null;
    try {
      await call({});
    } catch (error) {
      err = error;
    }
    check(
      "非截断的空内容仍提示「重试一次」",
      Boolean(err) && /重试/.test(err.message) && !/预算/.test(err.message),
      detailOf(err),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ------------------------------------------------------------- 4. AI 抽取 */

async function testAiExtraction() {
  console.log("\n[4] AI 抽取：请求形状与校验复用");

  // ---- 请求体形状：错了只会在运行时炸，而这里没有真实 key 可测 ----
  const textBody = ai.buildRequestBody({ text: "靳睿 南京鼓楼医院 2025-10-10", model: "deepseek-flash" });
  equal("model 透传", textBody.model, "deepseek-flash");
  equal("用 json 输出模式", textBody.response_format.type, "json_object");
  equal("不用流式", textBody.stream, false);
  equal("temperature 归零（抽取要稳定）", textBody.temperature, 0);
  equal("两条消息：system + user", textBody.messages.length, 2);
  equal("system 放提示词", textBody.messages[0].role, "system");
  equal("user 是消息数组的第二个", textBody.messages[1].role, "user");
  check("纯文本时 user content 是字符串", typeof textBody.messages[1].content === "string");

  // 官方要求：JSON Output 必须让提示词里出现 "json" 字样并给出格式示例
  check("提示词里出现了 json 字样", /json/i.test(ai.PROMPT));
  check(
    "提示词给了事实提取契约",
    /"imageRows"/.test(ai.PROMPT) && /"textPeople"/.test(ai.PROMPT) && /"assignments"/.test(ai.PROMPT),
  );
  check("提示词明确要求逐字照抄、不许补全", /照抄|不要补全|不要猜/.test(ai.PROMPT));

  // ---- 图片：必须放在 user 消息里（放 system/assistant 会被 400 拒绝）----
  const image = { base64: "AAAA", mime: "image/jpeg", name: "x.jpg" };
  const imgBody = ai.buildRequestBody({ text: "", image: image, model: "deepseek-flash" });
  const content = imgBody.messages[1].content;
  check("带图片时 user content 变成数组", Array.isArray(content));
  const parts = content.filter((part) => part.type);
  check("含 text 块", parts.some((part) => part.type === "text"));
  const imagePart = parts.find((part) => part.type === "image_url");
  check("含 image_url 块", Boolean(imagePart));
  check(
    "图片走 base64 data URL",
    imagePart && /^data:image\/jpeg;base64,AAAA$/.test(imagePart.image_url.url),
    imagePart ? imagePart.image_url.url.slice(0, 40) : "",
  );
  check(
    "system 消息里没有图片（会被接口 400 拒绝）",
    typeof imgBody.messages[0].content === "string",
  );

  console.log("  --- AI 只提取事实，代码执行工作流 ---");
  check("提示词禁止模型输出最终 records", /不要输出最终 records/.test(ai.PROMPT));
  check(
    "混合输入要求分别提取而不是让模型合并",
    /分别输出图片行、文字人员与文字赋值/.test(
      (ai.buildRequestBody({ text: "说明", image: image, model: "m" }).messages[1].content[0] || {}).text || "",
    ),
  );

  const baseImage = [
    { row: 1, name: "甲", hospital: "图片医院甲", date: "2022-10-20", note: "" },
    { row: 2, name: "乙", hospital: "图片医院乙", date: "2022-10-20", note: "" },
    { row: 3, name: "丙", hospital: "图片医院丙", date: "2022-10-20", note: "" },
  ];

  const globalOverride = ai.normalize(
    {
      imageRows: baseImage,
      textPeople: [{ name: "甲" }, { name: "乙" }, { name: "丙" }],
      assignments: [
        { field: "date", value: "2026-01-12", scope: "global", targetNames: [], targetRows: [] },
      ],
    },
    core,
  );
  check(
    "全局文字日期由代码整字段覆盖全部图片旧日期",
    globalOverride.records.every((record) => record.dateRaw === "2026-01-12"),
    JSON.stringify(globalOverride.records.map((record) => record.dateRaw)),
  );
  check(
    "文字日期覆盖时不影响图片医院",
    globalOverride.records.map((record) => record.hospital).join("|") ===
      "图片医院甲|图片医院乙|图片医院丙",
  );

  const priority = ai.normalize(
    {
      imageRows: baseImage,
      textPeople: [{ name: "甲" }, { name: "乙" }, { name: "丙" }],
      assignments: [
        { field: "date", value: "2026-01-01", scope: "global" },
        { field: "date", value: "2026-02-02", scope: "rows", targetRows: [1, 2] },
        { field: "date", value: "2026-03-03", scope: "named", targetNames: ["乙"] },
      ],
    },
    core,
  );
  equal("代码优先级：分组覆盖全局", priority.records[0].dateRaw, "2026-02-02");
  equal("代码优先级：明确姓名覆盖分组", priority.records[1].dateRaw, "2026-03-03");
  equal("代码优先级：未命中分组的行保留全局值", priority.records[2].dateRaw, "2026-01-01");

  const ordered = ai.normalize(
    {
      imageRows: baseImage,
      textPeople: [],
      assignments: [
        {
          field: "hospital",
          scope: "ordered",
          values: ["顺序医院甲", "顺序医院乙", "顺序医院丙"],
        },
      ],
    },
    core,
  );
  equal("顺序赋值第 1 行", ordered.records[0].hospital, "顺序医院甲");
  equal("顺序赋值第 3 行", ordered.records[2].hospital, "顺序医院丙");

  const ambiguous = ai.normalize(
    {
      imageRows: baseImage,
      textPeople: [],
      assignments: [
        {
          field: "date",
          scope: "ambiguous",
          values: ["2026-04-04", "2026-05-05"],
          note: "原文未说明对应关系",
        },
      ],
    },
    core,
  );
  check(
    "歧义赋值不覆盖图片原值",
    ambiguous.records.every((record) => record.dateRaw === "2022-10-20"),
  );
  check(
    "歧义赋值把相关行标为需处理且不自动选择",
    ambiguous.records.every(
      (record) => record.status === "invalid" && record.selected === false && /无法确定对应关系/.test(record.issues.join("")),
    ),
  );
  check(
    "歧义冲突保留字段标签，供表格按字段解除",
    ambiguous.records.every(
      (record) => Array.isArray(record.aiConflicts) && record.aiConflicts[0].field === "date",
    ),
  );

  const sameScopeConflict = ai.normalize(
    {
      imageRows: baseImage.slice(0, 1),
      textPeople: [],
      assignments: [
        { field: "date", value: "2026-06-06", scope: "global" },
        { field: "date", value: "2026-07-07", scope: "global" },
      ],
    },
    core,
  );
  equal("同级冲突不猜第二个值", sameScopeConflict.records[0].dateRaw, "2026-06-06");
  check("同级冲突进入需处理", /两个同等范围/.test(sameScopeConflict.records[0].issues.join("")));

  const correctedName = ai.normalize(
    {
      imageRows: [{ row: 1, name: "甲错字", hospital: "图片医院", date: "2026-01-01" }],
      textPeople: [{ name: "甲正确" }],
      assignments: [{ field: "name", value: "甲正确", scope: "rows", targetRows: [1] }],
    },
    core,
  );
  equal("文字可按图片行纠正 OCR 姓名", correctedName.records[0].name, "甲正确");
  equal("姓名纠正后不会再新增重复人员", correctedName.records.length, 1);

  // ---- 姓名纠正后，用「图片上的原名」做的点名赋值必须仍然命中同一个人 ----
  // 模型是从图片读的姓名：它在 rows 里纠正了姓名，别处的 named 赋值却仍写着原名。
  // 曾经的处理是「先纠正姓名、再应用其余赋值」，于是原名查不到 → 兜底分支新增一行，
  // 一次改名变成两个人（第 2 行凭空多出来，还缺医院）。
  const correctedWithNamed = ai.normalize(
    {
      imageRows: [{ row: 1, name: "甲错字", hospital: "图片医院", date: "2026-01-01" }],
      textPeople: [{ name: "甲正确" }],
      assignments: [
        { field: "name", value: "甲正确", scope: "rows", targetRows: [1] },
        { field: "date", value: "2026-09-09", scope: "named", targetNames: ["甲错字"] },
      ],
    },
    core,
  );
  equal("姓名纠正不会被原名点名赋值拆成两行", correctedWithNamed.records.length, 1);
  equal("纠正后的姓名保留", correctedWithNamed.records[0].name, "甲正确");
  equal("原名点名赋值落在纠正后的那一行", correctedWithNamed.records[0].dateRaw, "2026-09-09");
  equal("改名后图片医院仍在", correctedWithNamed.records[0].hospital, "图片医院");
  equal(
    "改名后没有多余的兜底警告",
    correctedWithNamed.warnings.filter((w) => /未列入 textPeople/.test(w)).length,
    0,
  );
  // textPeople 里写的是原名时，同样不能新增一行
  const correctedTextPeople = ai.normalize(
    {
      imageRows: [{ row: 1, name: "甲错字", hospital: "图片医院", date: "2026-01-01" }],
      textPeople: [{ name: "甲错字" }, { name: "乙" }],
      assignments: [{ field: "name", value: "甲正确", scope: "rows", targetRows: [1] }],
    },
    core,
  );
  equal("textPeople 用原名也不会重复建行", correctedTextPeople.records.length, 2);
  equal("被改名的行只出现一次", correctedTextPeople.records[0].name, "甲正确");

  // ---- assignments.note 不是「存疑」通道，绝不能因此把整批标成需处理 ----
  // 真实故障：模型给一条 global 日期赋值附了说明性 note，代码把它升级成行级 issue，
  // 而 global 作用于所有行 —— 每一行都变成「需处理」，用户一步都走不下去。
  const notedGlobal = ai.normalize(
    {
      imageRows: baseImage,
      textPeople: baseImage.map((row) => ({ name: row.name })),
      assignments: [
        {
          field: "date",
          value: "2026-01-12",
          scope: "global",
          evidence: "文字：26年1月12日",
          note: "文字说明称图片解析日期为22年10月20号，未指明具体人员或行",
        },
        {
          field: "hospital",
          value: "南京鼓楼医院",
          scope: "global",
          evidence: "文字：南京鼓楼医院",
          note: "文字说明称图片解析医院是南京鼓楼医院，未指明具体人员或行",
        },
      ],
    },
    core,
  );
  check(
    "带说明性 note 的全局赋值照常覆盖，不把整批标成需处理",
    notedGlobal.records.every(
      (record) => record.dateRaw === "2026-01-12" && record.hospital === "南京鼓楼医院",
    ),
    JSON.stringify(notedGlobal.records.map((record) => record.status)),
  );
  check(
    "没有任何一行因为赋值 note 被拦下",
    notedGlobal.records.every((record) => record.status === "ready" && record.selected === true),
    JSON.stringify(notedGlobal.records.map((record) => record.issues)),
  );
  check(
    "被忽略的 note 留一条线索（而不是静默丢掉）",
    notedGlobal.warnings.some((w) => /note 已忽略/.test(w)),
    JSON.stringify(notedGlobal.warnings),
  );
  // 真正的不确定仍然必须拦下：走 ambiguous
  check(
    "真存疑走 ambiguous 时依然拦下",
    ambiguous.records.every((record) => record.status === "invalid"),
  );
  equal("assignments 提示词不再要求用 note 表达不确定", /写进对应 note/.test(ai.PROMPT), false);

  // ---- 真实素材：聊天记录截图，不是名单表格 ----
  // 一张图里同时有：被转发进来的名单图（7 人）、单独发出的姓名清单（4 人）、
  // 关于医院的说明（南京鼓楼医院）、关于日期的分组说明（图片那批 22 年 10 月、
  // 后给的 4 个名字 26 年 1 月或 2 月），以及 3 条读不到内容的语音。
  // 旧提示词对「只有图片」的输入要求 assignments 必须为空，这张图就只出得来 7 个姓名。
  const CHAT_IMAGE = {
    imageRows: [
      { row: 1, name: "熊亚莉", evidence: "熊亚莉" },
      { row: 2, name: "姚仁玲", evidence: "姚仁玲" },
      { row: 3, name: "夏娟", evidence: "夏娟" },
      { row: 4, name: "张帆", evidence: "张帆" },
      { row: 5, name: "黄睿", evidence: "黄睿" },
      { row: 6, name: "贾蓓", evidence: "贾蓓" },
      { row: 7, name: "王健", evidence: "王健" },
    ],
    textPeople: [
      { name: "靳睿", evidence: "靳睿、耿楠、芮法娟、倪文婧" },
      { name: "耿楠", evidence: "靳睿、耿楠、芮法娟、倪文婧" },
      { name: "芮法娟", evidence: "靳睿、耿楠、芮法娟、倪文婧" },
      { name: "倪文婧", evidence: "靳睿、耿楠、芮法娟、倪文婧" },
    ],
    assignments: [
      { field: "hospital", value: "南京鼓楼医院", scope: "global", evidence: "南京鼓楼医院" },
      {
        field: "date",
        value: "2022-10",
        scope: "rows",
        targetRows: [1, 2, 3, 4, 5, 6, 7],
        evidence: "那张图片里的名单写 22 年 10 月份左右吧",
      },
      {
        field: "date",
        values: ["2026-01", "2026-02"],
        scope: "ambiguous",
        targetNames: ["靳睿", "耿楠", "芮法娟", "倪文婧"],
        evidence: "26 年的 1 月份 2 月份吧",
      },
    ],
    unreadable: "3 条语音消息未转文字，内容不可读",
  };
  const chat = ai.normalize(CHAT_IMAGE, core);
  equal("聊天记录里两种来源的人员都建了行（图片 7 + 文字 4）", chat.records.length, 11);
  check(
    "医院从聊天文字里读到并填到每一行",
    chat.records.every((record) => record.hospital === "南京鼓楼医院"),
    JSON.stringify(chat.records.map((record) => record.hospital)),
  );
  check(
    "图片里那批拿到 22 年 10 月（年月留住、只缺「日」）",
    chat.records.slice(0, 7).every(
      (record) => record.dateRaw === "2022-10" && /日期不完整/.test(record.issues.join("")),
    ),
    JSON.stringify(chat.records.slice(0, 7).map((record) => record.issues)),
  );
  check(
    "后给的 4 个人没有被图片日期覆盖，也没有被编一个月份",
    chat.records.slice(7).every((record) => record.dateRaw === ""),
    JSON.stringify(chat.records.slice(7).map((record) => record.dateRaw)),
  );
  check(
    "月份分不清归属时只标记这 4 个人，不殃及整批",
    chat.records.slice(7).every((record) => /无法确定对应关系/.test(record.issues.join(""))) &&
      chat.records.slice(0, 7).every((record) => !/无法确定对应关系/.test(record.issues.join(""))),
    JSON.stringify(chat.records.map((record) => record.issues)),
  );
  check(
    "11 条全部拦下（缺日的记录绝不静默放行生成）",
    chat.records.every((record) => record.status === "invalid" && record.selected === false),
    JSON.stringify(chat.records.map((record) => record.status)),
  );
  equal("读不到的语音条原样上报", chat.unreadable, "3 条语音消息未转文字，内容不可读");

  // ---- 两张图：聊天截图里那份残缺名单 + 一张完整名单 ----
  // 真实用法：截图里的人数不全（或者只有姓名），再补一张完整名单让 AI 一起看。
  // 最大的风险是**同一个人被两张图各写一行 → 生成两份证书**，所以同一个人必须收敛成一行。
  console.log("  --- 多张图：同一个人只能有一条记录 ---");
  const twoImages = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "熊亚莉" },
        { image: 1, row: 2, name: "姚仁玲" },
        { image: 1, row: 3, name: "夏娟" },
        { image: 2, row: 1, name: "熊亚莉", hospital: "南京鼓楼医院", date: "2022-10-20" },
        { image: 2, row: 2, name: "姚仁玲", hospital: "南京鼓楼医院", date: "2022-10-20" },
        { image: 2, row: 3, name: "夏娟", hospital: "南京鼓楼医院", date: "2022-10-20" },
        { image: 2, row: 4, name: "张帆", hospital: "南京鼓楼医院", date: "2022-10-20" },
      ],
      textPeople: [],
      assignments: [],
      unreadable: "",
    },
    core,
  );
  equal("两张图重复的人只留一条（3 + 4 → 4 条，不是 7 条）", twoImages.records.length, 4);
  check(
    "残缺名单由完整名单补齐，且补完就是可生成状态",
    twoImages.records.every(
      (record) =>
        record.status === "ready" &&
        record.hospital === "南京鼓楼医院" &&
        record.dateRaw === "2022-10-20",
    ),
    JSON.stringify(twoImages.records.map((record) => [record.name, record.hospital, record.dateRaw, record.status])),
  );
  check(
    "合并这件事本身要说明（不能静默把人并掉）",
    twoImages.warnings.some((warning) => /同名行已合并/.test(warning) && /空缺字段/.test(warning)),
    JSON.stringify(twoImages.warnings),
  );

  // 同名但值对不上：可能是同名两个人，也可能是同一人的两条矛盾来源 —— 一律不猜
  const sameNameConflict = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "熊亚莉", hospital: "甲医院", date: "2022-10-20" },
        { image: 2, row: 1, name: "熊亚莉", hospital: "乙医院", date: "2022-10-20" },
      ],
      textPeople: [],
      assignments: [],
      unreadable: "",
    },
    core,
  );
  equal("同名但医院对不上时不合并，两条都留", sameNameConflict.records.length, 2);
  check(
    "两条都进「需处理」并写明是疑似重复",
    sameNameConflict.records.every(
      (record) => record.status === "invalid" && /疑似重复/.test(record.issues.join("")),
    ),
    JSON.stringify(sameNameConflict.records.map((record) => record.issues)),
  );
  check(
    "矛盾的两条都不会被自己的冲突说明洗掉原值",
    sameNameConflict.records.map((record) => record.hospital).join("|") === "甲医院|乙医院",
  );

  // 同名合并后，按行号下的赋值仍要能找到合并进来的那一行
  const mergedTargeting = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "甲" },
        { image: 2, row: 1, name: "甲", hospital: "甲医院" },
      ],
      textPeople: [],
      assignments: [
        { field: "date", value: "2026-05-06", scope: "rows", targetImage: 2, targetRows: [1] },
      ],
      unreadable: "",
    },
    core,
  );
  equal("合并后仍能被「第 2 张图第 1 行」的赋值命中", mergedTargeting.records.length, 1);
  equal("命中后值写到了合并后的那一行", mergedTargeting.records[0].dateRaw, "2026-05-06");

  // ---- 多图的行号定位：第 2 张图的第 1 行 ≠ 第 1 张图的第 1 行 ----
  const perImageTargeting = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "甲", hospital: "甲医院" },
        { image: 1, row: 2, name: "乙", hospital: "甲医院" },
        { image: 2, row: 1, name: "丙", hospital: "甲医院" },
        { image: 2, row: 2, name: "丁", hospital: "甲医院" },
      ],
      textPeople: [],
      assignments: [
        { field: "date", value: "2026-01-01", scope: "rows", targetImage: 2, targetRows: [1, 2] },
      ],
      unreadable: "",
    },
    core,
  );
  check(
    "带 targetImage 时只命中那张图的行",
    perImageTargeting.records.map((record) => record.dateRaw).join("|") === "||2026-01-01|2026-01-01",
    perImageTargeting.records.map((record) => record.dateRaw).join("|"),
  );

  // ---- 文字日期比图上更粗时，不许把精确日期打回不完整 ----
  // 用户补一张完整名单，正是为了把「日」补上；聊天里那句「〈年〉年〈月〉月份左右」
  // 只是同一个月的模糊回忆。用它覆盖等于把刚补齐的信息又抹掉，还得再填一遍。
  const vagueDateSource = {
    imageRows: [
      { image: 1, row: 1, name: "甲" },
      { image: 2, row: 1, name: "甲", hospital: "甲医院", date: "2022-10-20" },
    ],
    textPeople: [],
    unreadable: "",
  };
  const vagueDate = ai.normalize(
    {
      imageRows: vagueDateSource.imageRows,
      textPeople: [],
      assignments: [{ field: "date", value: "2022-10", scope: "rows", targetImage: 1, targetRows: [1] }],
      unreadable: "",
    },
    core,
  );
  equal("更粗的文字日期不覆盖同月的精确日期", vagueDate.records[0].dateRaw, "2022-10-20");
  check(
    "这件事要说出来，不能静默忽略",
    vagueDate.warnings.some((warning) => /没有覆盖更精确的/.test(warning)),
    JSON.stringify(vagueDate.warnings),
  );
  equal("保留精确日期后这条可直接生成", vagueDate.records[0].status, "ready");
  equal(
    "文字只到年、图上更精确时不覆盖",
    ai.normalize(
      {
        imageRows: vagueDateSource.imageRows,
        textPeople: [],
        assignments: [{ field: "date", value: "2022", scope: "rows", targetImage: 1, targetRows: [1] }],
        unreadable: "",
      },
      core,
    ).records[0].dateRaw,
    "2022-10-20",
  );
  equal(
    "文字说的是别的月份时照常覆盖（那是改写指令，不是回忆）",
    ai.normalize(
      {
        imageRows: vagueDateSource.imageRows,
        textPeople: [],
        assignments: [{ field: "date", value: "2022-11", scope: "rows", targetImage: 1, targetRows: [1] }],
        unreadable: "",
      },
      core,
    ).records[0].dateRaw,
    "2022-11",
  );

  // ---- DeepSeek 真实返回（用户实测原文，只省掉赘余的空字段）----
  // 现象：医院全填上了，日期一整列「点击填写」。根因是那条 rows 赋值**没写行号**：
  // 模型眼里「那张图片里的名单」就是整张图，不需要逐行点名，而旧实现只认行号，
  // 于是赋值找不到目标 —— 提示里只有一句「找不到目标：rows」，用户根本不知道该干什么。
  const REAL_IMAGE_1 = ["陈重", "严晓敏", "张昭萍", "张勇扬", "吴卫华", "李婕", "熊亚莉",
    "姚仁玲", "夏娟", "张帆", "黄睿", "贾蓓", "王健", "王贵阳", "姚可方", "杨玥", "田安然",
    "李惠惠", "刘嘉城"];
  const REAL_IMAGE_2 = ["熊亚莉", "姚仁玲", "夏娟", "张帆", "黄睿", "贾蓓", "王健"];
  const realPayload = {
    imageRows: REAL_IMAGE_1.map((name, index) => ({ image: 1, row: index + 1, name: name })).concat(
      REAL_IMAGE_2.map((name, index) => ({ image: 2, row: index + 1, name: name })),
    ),
    textPeople: ["靳睿", "耿楠", "芮法娟", "倪文婧"].map((name) => ({
      name: name,
      evidence: "靳睿、耿楠、芮法娟、倪文婧",
    })),
    assignments: [
      { field: "hospital", value: "南京鼓楼医院", scope: "global", evidence: "南京鼓楼医院" },
      { field: "date", value: "2022-10", scope: "rows", targetImage: 1, targetRows: [],
        evidence: "那张图片里的名单写 22 年 10 月份左右吧" },
      { field: "date", value: "2025", scope: "named", targetImage: 0,
        targetNames: ["靳睿", "耿楠", "芮法娟", "倪文婧"], evidence: "然后后面几个给你的名字写 25 年" },
      { field: "date", value: "2026-01", scope: "ambiguous", targetImage: 0, targetNames: [],
        targetRows: [], evidence: "26 年的 1 月份 2 月份吧" },
    ],
    unreadable: "",
  };
  const realRun = ai.normalize(realPayload, core);
  equal("真实返回：两张图的 26 行按姓名合并成 19 行，再加 4 个文字点名的人", realRun.records.length, 23);
  check(
    "真实返回：医院全局赋值落到每一行（当时用户看到的就是这一列好的）",
    realRun.records.every((record) => record.hospital === "南京鼓楼医院"),
  );
  check(
    "真实返回：没写行号的「图片那批」按整张图套用（这正是日期整列为空的根因）",
    realRun.records.slice(0, 19).every((record) => record.dateRaw === "2022-10"),
    JSON.stringify(realRun.records.map((record) => record.dateRaw)),
  );
  check(
    "真实返回：4 个文字点名的人拿到的是被推翻的 25 年，且被标成待确认",
    realRun.records.slice(19).every(
      (record) => record.dateRaw === "2025" && /无法确定对应关系/.test(record.issues.join("")),
    ),
    JSON.stringify(realRun.records.slice(19).map((record) => [record.dateRaw, record.issues])),
  );
  check(
    "真实返回：提示里说清「没写行号，按第 1 张图的 19 行整组套用」",
    realRun.warnings.some((warning) => /没有写明具体行号/.test(warning) && /19 行/.test(warning)),
    JSON.stringify(realRun.warnings),
  );
  check(
    "真实返回：那条没写目标的 ambiguous 只落在被点名的 4 个人身上，不殃及 19 个无关的人",
    realRun.records.slice(0, 19).every((record) => !/无法确定对应关系/.test(record.issues.join(""))) &&
      realRun.records.slice(19).every((record) => /无法确定对应关系/.test(record.issues.join(""))),
    JSON.stringify(realRun.records.map((record) => record.issues)),
  );
  check(
    "真实返回：一条都不能直接生成（日期全都缺「日」，闸门照旧拦住）",
    realRun.records.every((record) => record.status === "invalid"),
  );

  // ---- 「没写行号」的放宽只给医院和日期，姓名纠正绝不放宽 ----
  const nameWidening = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "甲" },
        { image: 1, row: 2, name: "乙" },
      ],
      textPeople: [],
      assignments: [{ field: "name", value: "丙", scope: "rows", targetImage: 1, targetRows: [] }],
      unreadable: "",
    },
    core,
  );
  check(
    "姓名纠正没写行号时绝不放宽成整批改名",
    nameWidening.records.map((record) => record.name).join("|") === "甲|乙",
    nameWidening.records.map((record) => record.name).join("|"),
  );
  check(
    "拒绝放宽会给出说明",
    nameWidening.warnings.some((warning) => /找不到目标/.test(warning)),
    JSON.stringify(nameWidening.warnings),
  );
  const allImagesWidening = ai.normalize(
    {
      imageRows: [
        { image: 1, row: 1, name: "甲" },
        { image: 2, row: 1, name: "乙" },
      ],
      textPeople: [{ name: "丙" }],
      assignments: [{ field: "date", value: "2026-03-04", scope: "rows", targetImage: 0, targetRows: [] }],
      unreadable: "",
    },
    core,
  );
  check(
    "连图号都没写时按「所有图片里的人」套用，且不碰纯文字的人",
    allImagesWidening.records.slice(0, 2).every((record) => record.dateRaw === "2026-03-04") &&
      allImagesWidening.records[2].dateRaw === "",
    JSON.stringify(allImagesWidening.records.map((record) => record.dateRaw)),
  );

  // ---- 没写目标的 ambiguous 要收窄，不能把整批标红 ----
  const narrowed = ai.normalize(
    {
      imageRows: [1, 2, 3, 4].map((index) => ({
        image: 1,
        row: index,
        name: "人" + index,
        hospital: "甲医院",
        date: "2022-10-20",
      })),
      textPeople: [],
      assignments: [
        { field: "date", value: "2026-01-01", scope: "named", targetNames: ["人1", "人2"] },
        { field: "date", value: "2026-02", scope: "ambiguous", targetNames: [], targetRows: [] },
      ],
      unreadable: "",
    },
    core,
  );
  check(
    "没写目标的 ambiguous 收窄到同字段已点名的行，不殃及整批",
    narrowed.records.slice(0, 2).every((record) => /无法确定对应关系/.test(record.issues.join(""))) &&
      narrowed.records.slice(2).every((record) => !/无法确定对应关系/.test(record.issues.join(""))),
    JSON.stringify(narrowed.records.map((record) => record.issues)),
  );

  // ---- 请求形状：多张图按上传顺序排进 user 消息 ----
  const secondImage = { base64: "BBBB", mime: "image/png", name: "y.png" };
  const twoImageBody = ai.buildRequestBody({
    text: "",
    images: [image, secondImage],
    model: "m",
  });
  const twoImageParts = twoImageBody.messages[1].content;
  equal("两张图 = 1 个 text 块 + 2 个 image 块", twoImageParts.length, 3);
  check(
    "图片顺序与上传顺序一致",
    twoImageParts[1].image_url.url.indexOf("AAAA") >= 0 &&
      twoImageParts[2].image_url.url.indexOf("BBBB") >= 0,
    twoImageParts.map((part) => part.type).join(","),
  );
  check(
    "user 消息里说明了张数与编号规则",
    /编号 1 到 2/.test(twoImageParts[0].text),
    twoImageParts[0].text,
  );
  equal(
    "单张 image 的老调用方式仍然可用（既有集成不受影响）",
    ai.buildRequestBody({ text: "", image: image, model: "m" }).messages[1].content.length,
    2,
  );
  equal("没有图片时 content 仍是纯字符串", typeof textBody.messages[1].content, "string");

  // ---- 提示词必须禁止模型跨图去重（去重是本地工作流的事）----
  check(
    "提示词要求逐图提取、绝不跨图去重",
    /绝不跨图去重/.test(ai.PROMPT) && /每张图各自逐行提取/.test(ai.PROMPT),
  );
  check(
    "提示词里的行要带 image 编号、赋值可带 targetImage",
    /"image":1/.test(ai.PROMPT) && /"targetImage"/.test(ai.PROMPT),
  );

  // ---- 提示词安全：图片里的文字说明同样要读，但不许模型自己合并 ----
  const imageOnlyBody = ai.buildRequestBody({ text: "", image: image, model: "m" });
  const imageOnlyText = (
    imageOnlyBody.messages[1].content.find((part) => part.type === "text") || {}
  ).text || "";
  equal(
    "只有图片输入时不再禁止 textPeople / assignments（聊天记录正走这条路径）",
    /必须为空/.test(imageOnlyText),
    false,
  );
  check(
    "只有图片时说明「图片里的文字」也是材料",
    /聊天记录/.test(imageOnlyText) && /(文字赋值|assignments)/.test(imageOnlyText),
    imageOnlyText,
  );
  check("提示词把聊天记录/便签列为图片形态", /聊天记录/.test(ai.PROMPT) && /便签/.test(ai.PROMPT));
  check(
    "提示词禁止把聊天抬头/群名/昵称里的姓名当人员",
    /抬头|群名|昵称/.test(ai.PROMPT),
  );
  check(
    "提示词要求日期缺段就少写、绝不补齐",
    /绝不补/.test(ai.PROMPT) && /YYYY-MM/.test(ai.PROMPT),
  );
  check(
    "提示词说明 ambiguous 可以带 targetNames（只标记那几个人）",
    /ambiguous/.test(ai.PROMPT) && /targetNames/.test(ai.PROMPT),
  );

  const newPerson = ai.normalize(
    {
      imageRows: baseImage.slice(0, 1),
      textPeople: [{ name: "文字新增" }],
      assignments: [
        { field: "hospital", value: "文字医院", scope: "named", targetNames: ["文字新增"] },
        { field: "date", value: "2026-08-08", scope: "named", targetNames: ["文字新增"] },
      ],
    },
    core,
  );
  equal("文字明确出现的新人员由代码补行", newPerson.records.length, 2);
  equal("新人员的点名医院赋值生效", newPerson.records[1].hospital, "文字医院");

  const legacy = ai.normalize(
    { records: [{ name: "绕过", hospital: "旧格式医院", date: "2026-01-01" }] },
    core,
  );
  equal("旧版最终 records 不能绕过本地工作流", legacy.records.length, 0);
  check("旧版格式给出可重试提示", /旧版格式/.test(legacy.unreadable));

  // ---- 提示词安全：不能混入可被模型照抄的真实示例值 ----
  const leakedDates = [
    ...(ai.PROMPT.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/g) || []),
    ...(ai.PROMPT.match(/\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g) || []),
  ];
  equal("新提取提示词里没有具体日期", leakedDates.length, 0);
  check(
    "新提取提示词里没有具体机构名",
    ["南京鼓楼医院", "北京协和医院", "上海市第六人民医院"].every(
      (name) => ai.PROMPT.indexOf(name) < 0,
    ),
  );

  // ---- extractJsonText：官方明确说 JSON Output 偶尔返回空内容 ----
  let message = "";
  try {
    ai.extractJsonText({ choices: [{ message: { content: "" } }] });
  } catch (error) {
    message = error.message;
  }
  check("空内容给出可操作提示（而不是 JSON.parse 报错）", /空内容|重试/.test(message), message);

  message = "";
  try {
    ai.extractJsonText({ choices: [{ message: { content: "  " }, finish_reason: "length" }] });
  } catch (error) {
    message = error.message;
  }
  check("截断时提示分批", /截断|长度/.test(message), message);

  // ---- 输出预算：4096 太小是「被截断」的真正根因，不是名单太长 ----
  // DeepSeek 思考模式默认开启且力度默认 high，思考 token 与正文共用 max_tokens：
  // 4096 会被思考吃光，正文一个字都没轮上，表现就是 content 空 + finish_reason=length。
  const DEFAULT_BUDGET = textBody.max_tokens;
  check(
    "默认输出预算不再是 4096（思考 token 会把它吃光）",
    DEFAULT_BUDGET >= 16384,
    "实际 " + DEFAULT_BUDGET,
  );
  check(
    "输出预算不超过 1..384K 的接口上限",
    DEFAULT_BUDGET >= 1 && DEFAULT_BUDGET <= 393216,
    "越界会被接口直接 400 拒绝，实际 " + DEFAULT_BUDGET,
  );
  check(
    "显式关掉思考模式，把预算全留给正文",
    textBody.thinking && textBody.thinking.type === "disabled",
    JSON.stringify(textBody.thinking),
  );
  equal(
    "调用方仍可覆盖输出预算",
    ai.buildRequestBody({ text: "张三", model: "m", maxTokens: 1024 }).max_tokens,
    1024,
  );
  check(
    "关思考模式不影响其它 OpenAI 兼容服务（对方忽略不认识的字段）",
    Boolean(ai.buildRequestBody({ text: "张三", model: "m" }).thinking),
    "该字段必须始终存在，否则只有 DeepSeek 能跑",
  );

  // 截断文案必须区分「图片没法分批」——旧文案让人把照片分两半上传，做不到
  message = "";
  try {
    ai.extractJsonText({ choices: [{ message: { content: "  " }, finish_reason: "length" }] });
  } catch (error) {
    message = error.message;
  }
  check("截断文案点明是输出预算用完了，而不是笼统说名单太长", /预算/.test(message), message);
  check(
    "不带图片时教用户按行拆分并说明结果会自动追加",
    /按行拆/.test(message) && /追加/.test(message),
    message,
  );
  const imgTrunc = ai.truncatedError(true, 32768).message;
  check(
    "带图片时明说图片没法分批（否则用户会去把照片切两半）",
    /图片没法分批/.test(imgTrunc) && /分几次解析/.test(imgTrunc),
    imgTrunc,
  );
  check(
    "带图片与不带图片给出的是两套不同的建议",
    imgTrunc !== ai.truncatedError(false, 32768).message,
  );
  check(
    "截断文案带上实际预算数字，便于判断该调多大",
    /32768/.test(ai.truncatedError(false, 32768).message),
  );

  equal(
    "能剥掉 markdown 代码块",
    ai.extractJsonText({ choices: [{ message: { content: "```json\n{\"a\":1}\n```" } }] }),
    '{"a":1}',
  );

  // ---- 截断的端到端路径：要放在 const ai 之后（函数体里会用到它）----
  await testTruncationEndToEnd();

  // ---- 多图读取闸门：格式、单张体积、张数、合计体积 ----
  const fakeFile = (name, type, size) => ({ name: name, type: type, size: size });
  const readStub = () => Promise.resolve("data:image/jpeg;base64,QQ==");
  const batch = await ai.addImageFiles(
    [],
    [fakeFile("a.jpg", "image/jpeg", 100), fakeFile("b.bmp", "image/bmp", 10), fakeFile("c.png", "image/png", 100)],
    readStub,
  );
  equal("合法的两张都收下（坏图不连累好图）", batch.images.length, 2);
  equal("非法格式只报一条", batch.errors.length, 1);
  check("错误里点名是哪张图", /b\.bmp/.test(batch.errors[0]), batch.errors[0]);
  check("读进来的图片带体积（合计闸门要用）", batch.images[0].bytes === 100);

  const overflow = await ai.addImageFiles(
    new Array(ai.MAX_IMAGES).fill(null).map(() => ({ bytes: 1 })),
    [fakeFile("d.jpg", "image/jpeg", 100)],
    readStub,
  );
  equal("超过张数上限不再追加", overflow.images.length, ai.MAX_IMAGES);
  check("超过张数时给出可操作的提示", /最多一次解析/.test(overflow.errors.join("")), overflow.errors.join("|"));

  check("张数上限远小于图片 token 会把预算吃光的量级", ai.MAX_IMAGES >= 2 && ai.MAX_IMAGES <= 8, String(ai.MAX_IMAGES));
  check(
    "合计体积上限不小于单张上限（否则单张合法图也传不出去）",
    ai.MAX_TOTAL_IMAGE_BYTES >= ai.MAX_IMAGE_BYTES,
  );

  // ---- normalize：必须复用 core 的校验，不能自己写一套 ----
  const good = ai.normalize(
    {
      imageRows: [{ name: "靳睿", hospital: "南京鼓楼医院", date: "2025-10-10", note: "" }],
      textPeople: [],
      assignments: [],
    },
    core,
  );
  equal("正常记录可生成", good.records[0].status, "ready");
  equal("dateRaw 按 core 约定填充", good.records[0].dateRaw, "2025-10-10");
  check("解析出了 date 对象", Boolean(good.records[0].date));
  equal("date 的年份", good.records[0].date && good.records[0].date.year, "2025");

  // 这一条是最容易写错的地方：core.validateRecord 读的是 dateRaw 而不是 dateText。
  // 传错字段名会让所有记录都报「缺少颁发日期」——看起来像"AI 没抽到日期"，
  // 实际是适配层写错了。用断言钉死。
  const wrongField = core.validateRecord({ name: "甲", hospital: "乙医院", dateText: "2025-10-10" });
  check(
    "反证：传给 validateRecord 的字段必须是 dateRaw（写成 dateText 会误报）",
    wrongField.issues.indexOf("缺少颁发日期") >= 0,
    "这条断言是给适配层立的规矩，如果它不再成立说明 core 改了契约",
  );

  console.log("  --- 缺项必须标红，绝不静默通过 ---");
  const bad = ai.normalize(
    {
      imageRows: [
        { name: "", hospital: "某医院", date: "2025-10-10" },
        { name: "张三", hospital: "", date: "2025-10-10" },
        { name: "李四", hospital: "某医院", date: "" },
        { name: "王五", hospital: "某医院", date: "不是日期" },
        { name: "赵六", hospital: "某医院", date: "2025-13-45" },
      ],
    },
    core,
  );
  check(
    "5 条缺项/异常输入全部标为需处理",
    bad.records.length === 5 && bad.records.every((r) => r.status === "invalid"),
    bad.records.map((r) => r.status).join(","),
  );
  check(
    "每条都给出了具体原因",
    bad.records.every((r) => r.issues.length > 0),
    JSON.stringify(bad.records.map((r) => r.issues)),
  );
  check("月份越界被抓住", bad.records[4].issues.join("").indexOf("超出范围") >= 0);

  // ---- AI 的存疑备注要保留下来，供人工核对 ----
  const noted = ai.normalize(
    {
      imageRows: [
        { name: "欧阳娜娜", hospital: "某医院", date: "2026-06-04", note: "「娜」字略模糊" },
      ],
      textPeople: [],
      assignments: [],
    },
    core,
  );
  equal("aiNote 被保留", noted.records[0].aiNote, "「娜」字略模糊");
  check(
    "aiNote 会阻止存疑记录自动进入生成队列",
    noted.records[0].issues.length > 0 && noted.records[0].status === "invalid" && !noted.records[0].selected,
    JSON.stringify(noted.records[0].issues),
  );

  // ---- 脏数据不能把整批搞崩 ----
  equal(
    "imageRows 不是数组时返回空",
    ai.normalize({ imageRows: "x", textPeople: [], assignments: [] }, core).records.length,
    0,
  );
  equal(
    "数组里的 null 被跳过",
    ai.normalize(
      {
        imageRows: [null, { name: "甲", hospital: "乙医院", date: "2025-1-2" }],
        textPeople: [],
        assignments: [],
      },
      core,
    ).records.length,
    1,
  );
  equal(
    "unreadable 透传",
    ai.normalize({ imageRows: [], textPeople: [], assignments: [], unreadable: "图片太模糊" }, core)
      .unreadable,
    "图片太模糊",
  );

  // ---- core 缺失时必须抛错，而不是跳过校验 ----
  let threw = false;
  try {
    ai.normalize(
      {
        imageRows: [{ name: "甲", hospital: "乙", date: "2025-1-1" }],
        textPeople: [],
        assignments: [],
      },
      null,
    );
  } catch {
    threw = true;
  }
  check("cert-core 缺失时抛错（不能跳过校验直接生成）", threw);

  // ---- 图片本地预检：格式与体积 ----
  const okTypes = ai.ALLOWED_IMAGE_TYPES;
  check("允许 JPEG", okTypes.indexOf("image/jpeg") >= 0);
  check("允许 PNG", okTypes.indexOf("image/png") >= 0);
  check("拒绝了 image/bmp", okTypes.indexOf("image/bmp") < 0);
  check("图片上限存在且合理", ai.MAX_IMAGE_BYTES > 0 && ai.MAX_IMAGE_BYTES <= 32 * 1024 * 1024);

  // ---- 服务商配置 ----
  check("注册了 DeepSeek", ai.getProvider("deepseek") !== null);
  const ds = ai.getProvider("deepseek");
  check("DeepSeek 声明支持图片", ds.supportsImage === true);
  check("DeepSeek 端点正确", /^https:\/\/api\.deepseek\.com\//.test(ds.endpoint), ds.endpoint);
  equal("默认模型是 deepseek-flash", ds.defaultModel, "deepseek-flash");
}

/* ------------------------------------------- 5. PDF 打包成 ZIP（一次下载） */

async function testPdfZip() {
  console.log("\n[5] 多个 PDF 打包成一个 ZIP");

  // writeZip 原本只装 docx，装 PDF 要实测：ZIP 头是否正、中文名是否保住、能否往返
  const names = ["TE操作培训证书_靳睿.pdf", "TE操作培训证书_欧阳娜娜.pdf", "TE操作培训证书_张三_2.pdf"];
  const entries = names.map((name, index) => ({
    name: name,
    // 造点有重复内容的伪 PDF，好验证压缩确实生效
    data: new Uint8Array(4096).fill(0x41 + index),
  }));

  const zip = await core.writeZip(entries);
  check("ZIP 有 PK 头", zip[0] === 0x50 && zip[1] === 0x4b);
  check("ZIP 体积小于原始总和（压缩生效）", zip.length < 4096 * 3, zip.length + " vs " + 4096 * 3);

  const read = await core.readZip(zip);
  const fileEntries = read.filter((entry) => !entry.name.endsWith("/"));
  equal("解压后文件数一致", fileEntries.length, names.length);
  equal(
    "文件名（含中文与 _2 后缀）完整保住",
    fileEntries.map((entry) => entry.name).sort().join("|"),
    names.slice().sort().join("|"),
  );
  for (const entry of fileEntries) {
    equal(entry.name + " 的内容长度往返一致", entry.data.length, 4096);
  }

  // 单个文件时不打包（没必要多一层解压）
  const one = await core.writeZip([{ name: names[0], data: entries[0].data }]);
  const oneRead = await core.readZip(one);
  equal("单文件 ZIP 也能正常读", oneRead.filter((e) => !e.name.endsWith("/")).length, 1);

  // app.js 的打包条件：多于一个文件就打包，**没有开关** ——
  // 连续下载会被浏览器拦，这不是用户该做的选择，所以不给选项。
  const appSource = require("fs").readFileSync(path.join(TOOL, "app.js"), "utf8");
  const htmlSource = require("fs").readFileSync(path.join(TOOL, "index.html"), "utf8");
  check(
    "只有多于 1 个文件时才打包",
    /const shouldZip = files\.length > 1;/.test(appSource),
    "单文件也打包会让用户白白多解压一次",
  );
  check(
    "打包是自动的，没有开关（不该再出现 pdfZipToggle）",
    !/pdfZipToggle/.test(appSource) && !/pdfZipToggle/.test(htmlSource),
    "ZIP 是技术细节，不该让用户选",
  );
  check(
    "打包时不逐个触发下载（否则浏览器仍会拦）",
    /if \(shouldZip\)[\s\S]{0,400}writeZip[\s\S]{0,200}\} else \{[\s\S]{0,200}triggerDownload/.test(appSource),
    "两条路必须是互斥的 if/else",
  );
  check("ZIP 的 MIME 是 application/zip", /"application\/zip"/.test(appSource));
}

/* ------------------------------------------------ 6. 云端路径已彻底移除 */

/**
 * 这个工具曾经有一条「填充 DOCX → 交给云端服务商转 PDF」的路径。本地直接 PDF 落地后
 * 它对本场景已无作用，连同只服务于它的 DOCX 生成器一起删除了。
 *
 * 为什么要有**反向断言**：残留一半的接线比整块保留更危险 ——
 *   - 页面若还挂着 cert-cloud.js 的 <script>，浏览器会 404，但不会报错，
 *     看起来像"功能消失"；CSP 里留着已不存在的服务商域名则是无声的外发口子；
 *   - cert-core 若还导出 buildDocx，将来很容易有人"顺手"再把它接回某条路径。
 * 这些都不需要浏览器就能查，所以固化成断言。
 */
function testCloudRemoved() {
  console.log("\n[6] 云端 DOCX→PDF 与其 DOCX 生成管线已彻底移除");

  const appSource = fs.readFileSync(path.join(TOOL, "app.js"), "utf8");
  const coreSource = fs.readFileSync(path.join(TOOL, "cert-core.js"), "utf8");
  const html = fs.readFileSync(path.join(TOOL, "index.html"), "utf8");

  for (const file of ["cert-cloud.js", "cert-merge.js"]) {
    check(file + " 已删除", !fs.existsSync(path.join(TOOL, file)));
  }
  check(
    "index.html 不再引用 cert-cloud.js / cert-merge.js",
    !/cert-cloud\.js|cert-merge\.js/.test(html),
    "残留的 <script src> 只会 404，页面上不报错、只是功能不见了",
  );

  // DOCX 生成能力：运行时已无调用方，导出与实现都该消失
  for (const api of ["buildDocx", "fillDocumentXml", "escapeXml"]) {
    check("cert-core 不再导出 " + api, typeof core[api] === "undefined", "实际类型: " + typeof core[api]);
  }
  check("cert-core 不再有 fillDocumentXml 实现", !/function fillDocumentXml\(/.test(coreSource));
  check("cert-core 不再有姓名框 EMU/VML 常量", !/NAME_BOX_POS_ORIG|HOSPITAL_CX_ORIG/.test(coreSource));
  check("app.js 不再构造 DOCX", !/buildDocx|buildCertificateItems/.test(appSource));

  // CSP：connect-src 只剩 AI 那一个白名单域名
  const csp = (html.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/) || [])[1] || "";
  check("CSP 存在", Boolean(csp));
  const connect = (csp.match(/connect-src([^;]*)/) || [])[1] || "";
  const remote = (connect.match(/https:\/\/[a-z0-9.-]+/g) || []);
  equal("connect-src 只剩 1 个远程域名（AI 解析用）", remote.length, 1);
  check("那个域名是 api.deepseek.com", remote[0] === "https://api.deepseek.com", remote.join(", "));
  for (const host of ["convertapi", "cloudconvert", "adobe", "amazonaws"]) {
    check("CSP 不再放行 " + host, !connect.includes(host), connect);
  }
  check(
    "CSP 仍放行 file:（读本地模板需要）",
    /connect-src[^;]*file:/.test(csp),
    csp,
  );
  check(
    "CSP 仍放行 blob:（背景图需要）",
    /img-src[^;]*blob:/.test(csp),
    csp,
  );
}

/* ------------------------------------------------------------------ 入口 */

(async function main() {
  console.log("TE 证书工具 · 核心逻辑测试");
  console.log("工具目录: " + TOOL);

  for (const file of ["index.html", "app.js", "cert-core.js", "cert-direct-pdf.js", "cert-ai.js",
    "styles.css", "template-general.docx", "template-special.docx"]) {
    check("存在 " + file, fs.existsSync(path.join(TOOL, file)));
  }

  await testNameBox();
  testDate();
  testOutputNaming();
  testAiExtraction();
  await testPdfZip();
  testCloudRemoved();

  console.log("\n" + "=".repeat(70));
  console.log("通过 " + passed + " 项，失败 " + failures.length + " 项。");
  if (failures.length) {
    failures.forEach((item) => console.log("  - " + item));
    process.exit(1);
  }
})().catch((error) => {
  console.error("\n测试异常终止：" + (error && error.stack ? error.stack : error));
  process.exit(1);
});
