/**
 * TE 证书工具 —— 核心逻辑测试（纯 Node，无网络、无浏览器）。
 *
 * 覆盖三块：
 *   1) cert-core 的填充与排版规则（含 4 字姓名加宽这个真实 bug 的回归护栏）
 *   2) cert-cloud 的合批（多页 DOCX 拼装）与服务商契约
 *   3) cert-merge 的 PDF 合并器输入校验
 *
 * 用法: node tests/test_te_cert_cloud_core.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const TOOL = path.join(__dirname, "..", "tools", "te-cert-generator");
const core = require(path.join(TOOL, "cert-core.js"));
const cloud = require(path.join(TOOL, "cert-cloud.js"));
const merge = require(path.join(TOOL, "cert-merge.js"));

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

async function build(name, hospital, year, month, day) {
  const docx = await core.buildDocx(templateBytes, {
    name: name,
    hospital: hospital,
    year: year || "2025",
    month: month || "10",
    day: day || "10",
  });
  const entries = await core.readZip(docx);
  const entry = entries.find((item) => item.name === "word/document.xml");
  return { docx: docx, documentXml: entry.data, xml: Buffer.from(entry.data).toString("utf8") };
}

/** 从 document.xml 里抠出姓名文本框的几何。 */
function nameBox(xml) {
  const anchors = xml.match(/<wp:anchor[\s\S]*?<\/wp:anchor>/g) || [];
  for (const anchor of anchors) {
    const texts = (anchor.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, ""))
      .join("");
    if (texts && texts.length <= 6 && !texts.includes("颁发日期") && !texts.includes("医院")) {
      const pos = (anchor.match(/<wp:posOffset>(-?\d+)<\/wp:posOffset>/g) || []).map((p) =>
        p.replace(/<[^>]+>/g, ""),
      );
      const ext = anchor.match(/<wp:extent cx="(\d+)"/);
      return { text: texts, posH: pos[0], cx: ext ? ext[1] : null };
    }
  }
  return null;
}

function vmlNameBox(xml) {
  const m = xml.match(/margin-left:([\d.]+)pt;margin-top:145\.95pt;height:66\.7pt;width:([\d.]+)pt/);
  return m ? { marginLeft: m[1], width: m[2] } : null;
}

/* ------------------------------------------------------------------ 1. 姓名框 */

async function testNameBox() {
  console.log("\n[1] 姓名框宽度规则（4 字姓名被裁掉的 bug 回归）");

  const K = core.constants;
  const cases = [
    { name: "张三", chars: 2, widen: false },
    { name: "倪文婧", chars: 3, widen: false },
    { name: "欧阳娜娜", chars: 4, widen: true },
    { name: "司马相如", chars: 4, widen: true },
    { name: "欧阳娜娜娜", chars: 5, widen: true },
  ];

  const geo = {};
  for (const item of cases) {
    const built = await build(item.name, "南京市第一医院");
    const box = nameBox(built.xml);
    const vml = vmlNameBox(built.xml);
    geo[item.name] = { box, vml, chars: item.chars };
    check(item.name + "（" + item.chars + " 字）定位到姓名框", Boolean(box && vml));
  }

  // 2 字：完全保持原状（不能回归）
  equal("2 字 posOffsetH 不变", geo["张三"].box.posH, K.NAME_BOX_POS_ORIG);
  equal("2 字 margin-left 不变", geo["张三"].vml.marginLeft, "247.7");
  equal("2 字 框宽不变", geo["张三"].vml.width, "124.5");

  // 3 字：只左移、不加宽（既有行为）
  equal("3 字 posOffsetH = 2917190", geo["倪文婧"].box.posH, K.NAME_BOX_POS_NEW);
  equal("3 字 margin-left = 229.7", geo["倪文婧"].vml.marginLeft, "229.7");
  equal("3 字 框宽仍为 124.5", geo["倪文婧"].vml.width, "124.5");

  // 4 字：加宽到放得下，并整字宽左移
  const four = geo["欧阳娜娜"];
  const need = 4 * K.NAME_BOX_PT_PER_CHAR + 7.2;
  check(
    "4 字 框宽 " + four.vml.width + "pt ≥ 放得下所需的 " + need + "pt",
    Number(four.vml.width) >= need,
  );
  equal("4 字 margin-left = 193.7（左移整整一个字宽 36pt）", four.vml.marginLeft, "193.7");
  equal(
    "4 字 cx = 1581150 + 457200",
    four.box.cx,
    String(Number(K.NAME_BOX_CX_ORIG) + K.NAME_BOX_CX_PER_CHAR),
  );
  equal("4 字 DrawingML cx 与 VML width 一致", Math.round(Number(four.box.cx) / 12700 * 10) / 10, Number(four.vml.width));
  equal("同名不同 4 字姓名几何一致", geo["司马相如"].vml.marginLeft, four.vml.marginLeft);

  // 5 字：规则可外推
  const five = geo["欧阳娜娜娜"];
  equal("5 字 margin-left = 157.7", five.vml.marginLeft, "157.7");
  check("5 字 框宽 " + five.vml.width + "pt ≥ " + (5 * 36 + 7.2) + "pt", Number(five.vml.width) >= 5 * 36 + 7.2);

  // 核心：右边缘钉死，别挤掉与医院名之间的间隙
  console.log("  --- 右边缘必须恒定 ---");
  const PAGE_LEFT = 72.0;
  const INSET = 3.6;
  const rightEdges = cases.map((item) => {
    const g = geo[item.name];
    const textLeft = PAGE_LEFT + Number(g.vml.marginLeft) + INSET;
    return { name: item.name, chars: item.chars, left: textLeft, right: textLeft + item.chars * K.NAME_BOX_PT_PER_CHAR };
  });
  const ref3 = rightEdges.find((r) => r.chars === 3);
  for (const row of rightEdges) {
    if (row.chars <= 3) continue;
    check(
      row.name + "（" + row.chars + " 字）右边缘与 3 字一致",
      Math.abs(row.right - ref3.right) < 0.05,
      "偏移 " + (row.right - ref3.right).toFixed(1) + "pt",
    );
  }
  for (const row of rightEdges) {
    check(
      row.name + " 文字左边缘 " + row.left.toFixed(1) + "pt 未越过页左边距",
      row.left > PAGE_LEFT,
    );
  }

  console.log("  --- 各长度对照 ---");
  console.log("    姓名".padEnd(14) + "字数  文字左   文字右   框宽");
  for (const row of rightEdges) {
    console.log(
      "    " + row.name.padEnd(12) + String(row.chars).padEnd(6) +
      row.left.toFixed(1).padEnd(9) + row.right.toFixed(1).padEnd(9) + geo[row.name].vml.width,
    );
  }
}

/* -------------------------------------------------------------- 2. 合批 DOCX */

async function testBatch() {
  console.log("\n[2] 合批：N 份单页证书拼成一份 N 页 DOCX");

  const people = [
    { name: "靳睿", hospital: "南京鼓楼医院" },
    { name: "欧阳娜娜", hospital: "上海市第六人民医院" },
    { name: "芮法娟", hospital: "南京鼓楼医院" },
  ];
  const items = [];
  for (const person of people) {
    const built = await build(person.name, person.hospital);
    items.push({ name: person.name, docx: built.docx, documentXml: built.documentXml });
  }

  const combinedXml = cloud.buildBatchDocx(
    items.map((item) => ({ name: item.name, documentXml: item.documentXml })),
  );
  const xml = Buffer.from(combinedXml).toString("utf8");

  check("合批产物是 Uint8Array", combinedXml instanceof Uint8Array);
  check("含 <w:body>", xml.includes("<w:body>"));
  equal("<w:sectPr> 只保留一份", (xml.match(/<w:sectPr/g) || []).length, 1);

  // body 一级子元素：N 个内容段 + (N-1) 个分页段 + 1 个 sectPr
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)[1];
  let depth = 0;
  const topLevel = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const close = m[1];
    const tag = m[2];
    const selfClose = m[4];
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    if (close) {
      depth -= 1;
      continue;
    }
    if (depth === 0) topLevel.push(tag);
    if (!selfClose) depth += 1;
  }
  const expected = people.length + (people.length - 1) + 1;
  equal("body 一级子元素数 = N + (N-1) 分页段 + sectPr", topLevel.length, expected);
  equal("最后一个是 sectPr", topLevel[topLevel.length - 1], "w:sectPr");
  equal("段落总数 = N + (N-1)", topLevel.filter((t) => t === "w:p").length, people.length * 2 - 1);

  // 分页符：必须显式插入，不能靠浮动背景图撑页
  const pageBreaks = xml.match(/<w:br w:type="page"\/>/g) || [];
  equal("分页符数量 = N-1", pageBreaks.length, people.length - 1);
  check(
    "分页符出现在内容段之间（第一份之前没有）",
    !/^<w:body><w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/.test(xml),
    "第一份证书前不应有分页符，否则会多出一张空白页",
  );

  const embeds = [...new Set(xml.match(/r:embed="[^"]+"/g) || [])];
  equal("背景图引用去重后只剩 1 个（复用同一张图）", embeds.length, 1);
  equal("背景图引用出现 N 次", (xml.match(/r:embed=/g) || []).length, people.length);

  for (const person of people) {
    check("合批里含 " + person.name + " 的姓名节点", xml.includes(">" + person.name + "<"));
    check("合批里含 " + person.hospital, xml.includes(">" + person.hospital + "<"));
  }

  // 用第一份的 zip 承载
  const batched = await cloud.repackWithDocumentXml(items[0].docx, combinedXml, core.readZip, core.writeZip);
  check("合批 docx 是有效 ZIP", batched[0] === 0x50 && batched[1] === 0x4b);
  const entries = await core.readZip(batched);
  const entry = entries.find((e) => e.name === "word/document.xml");
  check("合批 docx 里的 document.xml 就是拼好的那份", Buffer.from(entry.data).equals(Buffer.from(combinedXml)));
  check("合批 docx 仍含背景图", entries.some((e) => e.name.startsWith("word/media/") && e.data.length > 1000));
  check(
    "合批体积只比单份多一点点（没有复制背景图）",
    batched.length < items[0].docx.length * 1.2,
    "单份 " + items[0].docx.length + " → 合批 " + batched.length,
  );

  // 错误路径必须明确报错，不能产出坏文件
  let threw = false;
  try {
    cloud.buildBatchDocx([{ name: "x", documentXml: new Uint8Array(0) }]);
  } catch {
    threw = true;
  }
  check("缺 document.xml 时抛错而不是产出坏文件", threw);

  threw = false;
  try {
    cloud.buildBatchDocx([{ name: "x", bytes: items[0].docx }]);
  } catch {
    threw = true;
  }
  check("误传整个 docx 包（而非 document.xml）时抛错", threw);
}

/* ------------------------------------------------------- 3. 服务商契约一致性 */

function testProviders() {
  console.log("\n[3] 云服务商契约");

  equal("注册了 3 个服务商", cloud.PROVIDERS.length, 3);
  const ids = cloud.PROVIDERS.map((p) => p.id);
  check("id 唯一", new Set(ids).size === ids.length, ids.join(", "));
  check("含 convertapi", ids.includes("convertapi"));
  check("含 cloudconvert", ids.includes("cloudconvert"));
  check("含 adobe", ids.includes("adobe"));

  // 按份计费/次数有限的场景下，必须有批量上限
  check("MAX_BATCH 是正整数", Number.isInteger(cloud.MAX_BATCH) && cloud.MAX_BATCH > 0, String(cloud.MAX_BATCH));

  for (const provider of cloud.PROVIDERS) {
    check(provider.id + " 有 https 端点", /^https:\/\//.test(provider.endpoint || ""));
    check(provider.id + " 有免费额度说明", Boolean(provider.freeNote));
    check(provider.id + " 声明了凭据字段", Boolean(provider.credential && provider.credential.key));
    const names = provider.credential.fields
      ? provider.credential.fields.map((f) => f.name)
      : [provider.credential.key];
    const source = provider.convert.toString();
    for (const name of names) {
      check(
        provider.id + " 的 convert() 解构了凭据字段 " + name,
        new RegExp("\\b" + name + "\\b").test(source),
      );
    }
  }

  check("getProvider 能取到 convertapi", cloud.getProvider("convertapi") !== null);
  equal("getProvider 对未知 id 返回 null", cloud.getProvider("nope"), null);
}

/* -------------------------------------------------------------- 4. PDF 合并器 */

function testMerge() {
  console.log("\n[4] PDF 合并器的输入校验");

  // 用桌面上的真实 Word PDF（若不存在则跳过），确认对象流能被识别并明确拒绝
  const candidates = [
    path.join(process.env.USERPROFILE || "", "Desktop", "证书PDF基准测试", "TE操作培训证书_靳睿.pdf"),
    path.join(process.env.USERPROFILE || "", "Desktop", "证书PDF基准测试", "TE操作培训证书_张三.pdf"),
  ];
  const real = candidates.find((p) => fs.existsSync(p));
  if (real) {
    const bytes = new Uint8Array(fs.readFileSync(real));
    check("真实 Word PDF 能被识别为 PDF", /^%PDF-/.test(Buffer.from(bytes.subarray(0, 8)).toString("latin1")));
    let message = "";
    try {
      merge.inspect(bytes);
    } catch (error) {
      message = error.message;
    }
    check(
      "对象流 PDF 被明确拒绝而不是产出坏文件",
      /对象流|ObjStm/.test(message),
      "实际信息: " + (message || "（没抛错）"),
    );
    equal("countPages 对不可处理的 PDF 返回 -1", merge.countPages(bytes), -1);
  } else {
    console.log("  skip 桌面上没有真实 PDF 样本，跳过对象流检查");
  }

  let threw = false;
  try {
    merge.mergePdfs([new Uint8Array([1, 2, 3])]);
  } catch {
    threw = true;
  }
  check("非 PDF 输入抛错", threw);

  threw = false;
  try {
    merge.mergePdfs([]);
  } catch {
    threw = true;
  }
  check("空输入抛错", threw);
}

/* --------------------------------------------------------------- 5. 日期解析 */

function testDate() {
  console.log("\n[5] 日期解析（填充正确性的前提）");

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
}

/* ----------------------------------------------------------- 5b. 文件命名 */

function testOutputNaming() {
  console.log("\n[5b] PDF 文件命名：预览、模板、自定义与去重");

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

/* ------------------------------------------------------------- 6. AI 抽取 */

function testAiExtraction() {
  console.log("\n[6] AI 抽取：请求形状与校验复用");

  const ai = require(path.join(TOOL, "cert-ai.js"));

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
  check("提示词给了字段示例", /"records"/.test(ai.PROMPT));
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

  // ---- 图片 + 文字混合：图片给姓名，文字按整批 / 分组 / 个人补医院和日期 ----
  // 不能再把文字里的某一个值无条件套给所有人；多个医院/日期必须逐人或逐组匹配。
  console.log("  --- 图 + 文混合（合并成同一个名单）---");
  const mixed = ai.buildRequestBody({
    text: "这几个人是南京鼓楼医院的，日期 2025年10月10日",
    image: image,
    model: "deepseek-flash",
  });
  const mixedContent = mixed.messages[1].content;
  check("混合输入时 user content 仍是数组", Array.isArray(mixedContent));
  check(
    "同时含文字块与图片块",
    mixedContent.some((part) => part.type === "text") &&
      mixedContent.some((part) => part.type === "image_url"),
  );
  const mixedText = (mixedContent.find((part) => part.type === "text") || {}).text || "";
  check("user 消息里带上了用户输入的原文", mixedText.indexOf("南京鼓楼医院") >= 0);
  check(
    "user 消息点明了「图片是名单、文字是补充」的分工",
    /图片/.test(mixedText) && /文字/.test(mixedText) && /合并/.test(mixedText),
    mixedText.slice(0, 80),
  );
  check(
    "user 消息明确要求「同一个人不要算两条」",
    /不要[\s\S]{0,20}算两条/.test(mixedText) || /不要[\s\S]{0,12}重复/.test(mixedText),
    mixedText.slice(-90),
  );

  check(
    "system 提示词要求医院/日期逐人或逐组匹配",
    /按人|逐人/.test(ai.PROMPT) && /按组|分组/.test(ai.PROMPT),
    "多个医院/日期不能再按整批一刀切",
  );
  check(
    "system 提示词要求完整提取图片每行的姓名/医院/日期",
    /逐行读取 name、hospital、date/.test(ai.PROMPT) &&
      /不能因为常见图片只有姓名而忽略/.test(ai.PROMPT),
    "图片可能本身就是完整表格，不能只读姓名",
  );
  check(
    "user 消息要求先建立完整图片基础表格",
    /逐行提取图片中的姓名、医院和日期/.test(mixedText) && /基础表格/.test(mixedText),
    mixedText.slice(-240),
  );
  check(
    "system 提示词禁止多个值中的一个覆盖全表",
    /不能任选一个值[\s\S]{0,12}覆盖全表|绝不能任选一个覆盖所有人/.test(ai.PROMPT),
    "缺这条规则时模型容易只保留最后一个日期",
  );
  check(
    "旧的整批共用规则已移除",
    !/医院名称\/日期是\*\*整批人共用的\*\*/.test(ai.PROMPT) &&
      !/医院名称与日期套用到图片里的每一位/.test(mixedText),
    "这两句会把局部医院/日期错误扩大到所有人",
  );
  check(
    "只有唯一且无分组迹象的字段才能全局套用",
    /恰好只有一个[\s\S]{0,30}没有任何按人\/按组区分/.test(ai.PROMPT),
    "单值可以作为默认值，多值必须判断归属",
  );
  check(
    "医院与日期分别判断作用域",
    /医院和日期要分别判断/.test(ai.PROMPT),
    "医院可能全局相同，但日期仍可能按组不同",
  );
  check(
    "多值归属不清时留空并标注",
    /多个候选值但归属不清[\s\S]{0,120}保留图片原值[\s\S]{0,80}留空[\s\S]{0,30}note/.test(ai.PROMPT),
    "已有图片值要保留；两边都没有才留空",
  );
  check(
    "system 提示词禁止把医院/日期单独生成记录",
    /不要[\s\S]{0,20}单独生成一条记录/.test(ai.PROMPT),
    ai.PROMPT.slice(ai.PROMPT.indexOf("绝对不要") - 20, ai.PROMPT.indexOf("绝对不要") + 60),
  );
  check(
    "system 提示词同时给了完整图片、局部修正、分组与歧义示例",
    /示例三/.test(ai.PROMPT) && /示例四/.test(ai.PROMPT) &&
      /示例五/.test(ai.PROMPT) && /示例六/.test(ai.PROMPT),
  );
  check(
    "system 提示词以图片人员行为合并锚点并允许文字明确纠错",
    /图片中的人员行是合并锚点/.test(ai.PROMPT) &&
      /文字可以明确纠正某个人的姓名/.test(ai.PROMPT) &&
      /同一个人不能因此变成两条/.test(ai.PROMPT),
    "图片提供基础行，但文字应能纠正明确的 OCR 姓名错误",
  );
  check(
    "user 消息要求逐人匹配且禁止覆盖所有人",
    /逐人匹配/.test(mixedText) && /绝不能任选一个覆盖所有人/.test(mixedText),
    mixedText.slice(-180),
  );

  // ---- 合并流程本身：维护一张带 source 列的数据表，按四步推进 ----
  // 这一组钉的是「流程结构」，而不是某句效果描述。之前那版是一串并列规则，
  // 模型容易跳步、把文字里的值直接套给全表；改成显式的数据表流程后，
  // 下面的断言保证后来者不会把结构化流程又拆回一堆散规则。
  console.log("  --- 合并流程：数据表 + 四步 ---");
  const stepAt = (n) => ai.PROMPT.indexOf(`第 ${n} 步`);
  check(
    "提示词要求维护一张数据表",
    /维护一张.*数据表/.test(ai.PROMPT),
    "没有统一的表，图片和文字就会各解析一遍然后并列输出",
  );
  check(
    "数据表有 source 列，标明每行来自图片还是文字",
    /source/.test(ai.PROMPT) && /来源（图片 \/ 文字）/.test(ai.PROMPT),
    "source 是后来者追溯某行数据出处、以及判断覆盖方向的依据",
  );
  check(
    "四个步骤按顺序出现，没有跳步",
    stepAt(1) > 0 && stepAt(1) < stepAt(2) && stepAt(2) < stepAt(3) && stepAt(3) < stepAt(4) &&
      stepAt(4) > 0,
    [stepAt(1), stepAt(2), stepAt(3), stepAt(4)].join(", "),
  );
  check(
    "第 1 步要求先看清表格结构，不预设图片只有姓名",
    /先看清表格结构/.test(ai.PROMPT) && /不要预设图片只有姓名/.test(ai.PROMPT),
    "图片可能就是完整表格，预设只有姓名会直接丢掉两列数据",
  );
  check(
    "第 2 步是解析图片并填充数据表",
    /解析图片，填充数据表/.test(ai.PROMPT) && /逐行读取/.test(ai.PROMPT),
  );
  check(
    "第 3 步是解析文字并补充到对应行",
    /解析文字/.test(ai.PROMPT) && /补充到对应行/.test(ai.PROMPT),
    "文字是往已有行里补字段，不是重新建一张表",
  );
  check(
    "第 4 步要求以填好的表为准输出，不许再凭印象补字段",
    /对完整数据表做分析/.test(ai.PROMPT) &&
      /不要在输出阶段再凭印象补字段或改变某行的归属/.test(ai.PROMPT),
    "输出阶段再自由发挥，等于绕过前面三步的匹配结果",
  );
  check(
    "内部数据表不得出现在输出的 json 里",
    /数据表是你内部的推理过程/.test(ai.PROMPT) && /不要.*把它打印在 json 里/.test(ai.PROMPT),
    "输出形状一旦多一个 table 字段，extractRecords 就取不到 records",
  );
  check(
    "records 行数必须与数据表一致",
    /records 的长度与数据表的行数一致/.test(ai.PROMPT),
    "表里有几行就该出几条证书，不能多也不能少",
  );
  check(
    "user 消息也指向同一套四步流程",
    /四步流程/.test(mixedText) && /维护那张数据表/.test(mixedText),
    mixedText.slice(-200),
  );

  // 只有图片时不应出现「文字」相关的措辞
  const imgOnly = ai.buildRequestBody({ text: "", image: image, model: "deepseek-flash" });
  const imgOnlyText = imgOnly.messages[1].content.find((p) => p.type === "text").text;
  check(
    "只给图片时不出现「合并文字」的措辞",
    !/补充说明/.test(imgOnlyText),
    imgOnlyText,
  );

  // 文本两端空白不应影响判断（否则会被当成"有文字"）
  const blank = ai.buildRequestBody({ text: "   \n  ", image: image, model: "deepseek-flash" });
  const blankText = blank.messages[1].content.find((p) => p.type === "text").text;
  check("纯空白文本按「只给图片」处理", !/补充说明/.test(blankText), JSON.stringify(blankText.slice(0, 40)));

  // ---- 提示词里绝对不能出现具体日期／机构名 ----
  // 这是真踩过的坑：示例里写了「南京鼓楼医院 2025年10月10日」，模型把示例日期
  // 当成真实信息套到了用户的数据上，产出一批日期错误的记录。
  // 示例必须用占位符，不能有可被照抄的真实值。
  console.log("  --- 提示词不能被示例数据污染 ---");
  const leakedDates = (ai.PROMPT.match(/\d{4}[-年]\d{1,2}[-月]\d{1,2}/g) || []);
  check(
    "提示词里没有任何具体日期（防示例泄漏）",
    leakedDates.length === 0,
    "发现: " + JSON.stringify(leakedDates) + " —— 模型会把示例日期当成真实数据照抄",
  );
  check(
    "提示词里没有具体机构名（示例已换成占位符）",
    ["南京鼓楼医院", "北京协和医院", "上海市第六人民医院"].every(
      (name) => ai.PROMPT.indexOf(name) < 0,
    ),
    "示例里写具体医院名会被照抄到结果里",
  );
  check(
    "提示词声明了具体值都是占位符",
    /占位符/.test(ai.PROMPT) && /不要照抄/.test(ai.PROMPT),
  );
  check(
    "JSON 示例仍然合法（占位符在引号内）",
    (() => {
      const lines = ai.PROMPT.split("\n");
      const jsonLine = lines.find((line) => line.indexOf('{"records"') === 0);
      if (!jsonLine) return false;
      try {
        JSON.parse(jsonLine);
        return true;
      } catch {
        return false;
      }
    })(),
    "示例 json 不能被改成解析不了的形态，否则模型学不到格式",
  );

  // ---- 优先级：先确定文字的适用人群，再以文字覆盖这些人的图片字段 ----
  console.log("  --- 文字按作用域覆盖图片，不能把局部值扩大到全体 ---");
  check(
    "提示词写明已匹配的文字信息优先于图片",
    /已经匹配|匹配到[\s\S]{0,20}文字优先/.test(ai.PROMPT),
    "必须先匹配归属，再谈文字优先级",
  );
  check(
    "提示词区分人员行日期与图片背景日期",
    /同一行\/同一列明确关联[\s\S]{0,20}正常提取/.test(ai.PROMPT) &&
      /不属于任何人员数据行[\s\S]{0,10}才忽略/.test(ai.PROMPT),
    "不能为了忽略模板日期而把表格里的真实日期也丢掉",
  );
  check(
    "文字未涉及的图片字段必须保留",
    /文字没有明确涉及的字段必须保留图片基础表格中的原值/.test(ai.PROMPT) &&
      /文字未涉及的图片字段不变/.test(mixedText),
    "局部修正不能清空其他人的完整图片数据",
  );
  check(
    "提示词只信任明确绑定到个人或小组的文字字段",
    /明确绑定到这个人或其小组/.test(ai.PROMPT),
    "不能把未说明归属的文字值当作已确认",
  );
  check(
    "user 消息里也重申了多值不得全局覆盖",
    /多个医院或多个日期/.test(mixedText) && /覆盖所有人/.test(mixedText),
    mixedText.slice(-80),
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

  equal(
    "能剥掉 markdown 代码块",
    ai.extractJsonText({ choices: [{ message: { content: "```json\n{\"a\":1}\n```" } }] }),
    '{"a":1}',
  );

  // ---- normalize：必须复用 core 的校验，不能自己写一套 ----
  const good = ai.normalize(
    { records: [{ name: "靳睿", hospital: "南京鼓楼医院", date: "2025-10-10", note: "" }] },
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
      records: [
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
    { records: [{ name: "欧阳娜娜", hospital: "某医院", date: "2026-06-04", note: "「娜」字略模糊" }] },
    core,
  );
  equal("aiNote 被保留", noted.records[0].aiNote, "「娜」字略模糊");
  check(
    "aiNote 不并进 issues（它是「不确定」而非「不合法」）",
    noted.records[0].issues.length === 0 && noted.records[0].status === "ready",
    JSON.stringify(noted.records[0].issues),
  );

  // ---- 脏数据不能把整批搞崩 ----
  equal("records 不是数组时返回空", ai.normalize({ records: "x" }, core).records.length, 0);
  equal(
    "数组里的 null 被跳过",
    ai.normalize({ records: [null, { name: "甲", hospital: "乙医院", date: "2025-1-2" }] }, core)
      .records.length,
    1,
  );
  equal(
    "unreadable 透传",
    ai.normalize({ records: [], unreadable: "图片太模糊" }, core).unreadable,
    "图片太模糊",
  );

  // ---- core 缺失时必须抛错，而不是跳过校验 ----
  let threw = false;
  try {
    ai.normalize({ records: [{ name: "甲", hospital: "乙", date: "2025-1-1" }] }, null);
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

/* ------------------------------------------------- 7. 逐份 / 合批两种输出方式 */

async function testOutputModes() {
  console.log("\n[7] PDF 输出方式：默认逐份（每人一个文件）");

  const cloud = require(path.join(TOOL, "cert-cloud.js"));

  // 造一个假服务商，把"调了几次、传了什么"记下来，避免真的联网
  const calls = [];
  const fakeProvider = {
    id: "fake",
    label: "Fake",
    endpoint: "https://example.invalid/",
    freeNote: "测试用",
    credential: { key: "secret", label: "密钥" },
    async convert({ bytes, filename }) {
      calls.push({ bytes: bytes.length, filename: filename });
      // 返回一个最小可识别的 PDF
      return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) };
    },
  };
  cloud.PROVIDERS.push(fakeProvider);

  const items = [
    { name: "靳睿", docx: new Uint8Array([0x50, 0x4b, 3, 4, 1]), fileName: "TE操作培训证书_靳睿.pdf" },
    { name: "耿楠", docx: new Uint8Array([0x50, 0x4b, 3, 4, 2]), fileName: "TE操作培训证书_耿楠.pdf" },
    { name: "张三", docx: new Uint8Array([0x50, 0x4b, 3, 4, 3]), fileName: "TE操作培训证书_张三_2.pdf" },
  ];

  // ---- 默认：逐份 ----
  calls.length = 0;
  const single = await cloud.convertBatch({
    items: items,
    providerId: "fake",
    credentials: { secret: "x" },
    // 刻意不传 batch，验证默认值
  });
  equal("默认逐份：调用次数 = 份数", calls.length, items.length);
  equal("默认逐份：产出文件数 = 份数", single.pdfList.length, items.length);
  equal("默认逐份：batched = false", single.batched, false);
  check(
    "默认逐份：每份的文件名带姓名",
    single.pdfList.every((pdf, i) => pdf.fileName === items[i].fileName),
    JSON.stringify(single.pdfList.map((pdf) => pdf.fileName)),
  );
  check(
    "默认逐份：同名重复的 _2 后缀保住了（不会被覆盖）",
    single.pdfList.map((pdf) => pdf.fileName).join(",").indexOf("_2.pdf") >= 0,
    single.pdfList.map((pdf) => pdf.fileName).join(","),
  );
  check(
    "默认逐份：上传的文件名也逐份区分",
    calls.map((c) => c.filename).join(",").indexOf("耿楠") >= 0,
    calls.map((c) => c.filename).join(","),
  );
  check(
    "逐份不需要 document.xml",
    true,
    "（本用例的 items 就没有 documentXml，能跑通即证明）",
  );

  // ---- 显式合批 ----
  calls.length = 0;
  const docx = new Uint8Array(require("fs").readFileSync(path.join(TOOL, "template-general.docx")));
  const realItems = [];
  for (const name of ["靳睿", "耿楠"]) {
    const built = await build(name, "南京鼓楼医院");
    realItems.push({ name, docx: built.docx, documentXml: built.documentXml });
  }
  const merged = await cloud.convertBatch({
    items: realItems,
    providerId: "fake",
    credentials: { secret: "x" },
    batch: true,
    readZip: core.readZip,
    writeZip: core.writeZip,
  });
  equal("显式合批：只调用 1 次", calls.length, 1);
  equal("显式合批：产出 1 个文件", merged.pdfList.length, 1);
  equal("显式合批：batched = true", merged.batched, true);
  check(
    "合批产物是拼好的多页文档（体积远大于单份）",
    calls[0].bytes > realItems[0].docx.length,
    "上传了 " + calls[0].bytes + " 字节，单份 " + realItems[0].docx.length,
  );
  check("合批文件名不带个人姓名", merged.pdfList[0].fileName === null, String(merged.pdfList[0].fileName));

  // ---- 合批缺 document.xml 时必须明确报错，不能拿 undefined 去拼 ----
  let message = "";
  try {
    await cloud.convertBatch({
      items: [{ name: "甲", docx: docx }],
      providerId: "fake",
      credentials: { secret: "x" },
      batch: true,
      readZip: core.readZip,
      writeZip: core.writeZip,
    });
  } catch (error) {
    message = error.message;
  }
  // items 只有 1 份时走的是逐份路径，所以这里应该成功；用 2 份来测
  let message2 = "";
  try {
    await cloud.convertBatch({
      items: [{ name: "甲", docx: docx }, { name: "乙", docx: docx }],
      providerId: "fake",
      credentials: { secret: "x" },
      batch: true,
      readZip: core.readZip,
      writeZip: core.writeZip,
    });
  } catch (error) {
    message2 = error.message;
  }
  check(
    "合批缺 document.xml 时明确报错（不是拿 undefined 去拼）",
    /document\.xml/.test(message2),
    message2 || "（没有抛错）",
  );

  // ---- 单份 + batch:true 应退化为逐份，不去拼多页 ----
  calls.length = 0;
  const one = await cloud.convertBatch({
    items: [{ name: "单人", docx: docx, documentXml: new Uint8Array(1) }],
    providerId: "fake",
    credentials: { secret: "x" },
    batch: true,
    readZip: core.readZip,
    writeZip: core.writeZip,
  });
  equal("只有 1 份时不做合批（1 次调用）", calls.length, 1);
  equal("只有 1 份时 batched = false", one.batched, false);
}

/* ------------------------------------------- 8. PDF 打包成 ZIP（一次下载） */

async function testPdfZip() {
  console.log("\n[8] 多个 PDF 打包成一个 ZIP");

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

/* ------------------------------------------------------------------ 入口 */

(async function main() {
  console.log("TE 证书工具 · 核心逻辑测试");
  console.log("工具目录: " + TOOL);

  for (const file of ["index.html", "app.js", "cert-core.js", "cert-cloud.js", "cert-merge.js",
    "styles.css", "template-general.docx", "template-special.docx"]) {
    check("存在 " + file, fs.existsSync(path.join(TOOL, file)));
  }

  await testNameBox();
  await testBatch();
  testProviders();
  testMerge();
  testDate();
  testOutputNaming();
  testAiExtraction();
  await testOutputModes();
  await testPdfZip();

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
