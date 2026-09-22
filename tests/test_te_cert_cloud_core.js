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

/* ------------------------------------------------------- 6b. 截断的端到端路径 */

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

/* ------------------------------------------------------------- 6. AI 抽取 */

async function testAiExtraction() {
  console.log("\n[6] AI 抽取：请求形状与校验复用");

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
