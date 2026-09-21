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
