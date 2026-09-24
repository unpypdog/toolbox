"use strict";

const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "te-cert-generator");
const ai = require(path.join(TOOL, "cert-ai.js"));
const sessions = require(path.join(TOOL, "cert-ai-session.js"));
const core = require(path.join(TOOL, "cert-core.js"));

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok  ", label);
  } else {
    failed += 1;
    console.error("  FAIL", label, detail || "");
  }
}

(async () => {
  console.log("TE 证书工具 · AI 多轮会话测试\n");

  console.log("[1] 本地会话与上下文裁剪");
  const session = sessions.createSession({
    title: "鼓楼医院名单",
    messages: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "消息 " + index,
    })),
    decisions: ["日期保持材料原样"],
  });
  check("新会话有稳定 id", /^ai-/.test(session.id));
  check("会话不包含 API Key 字段", !("apiKey" in session));

  const records = [
    {
      recordId: "r-1",
      lineNo: 1,
      name: "张三",
      hospital: "南京鼓楼医院",
      dateRaw: "2026/9",
      status: "invalid",
      issues: ["日期不完整"],
      aiImageRefs: [{ image: 1, row: 1 }],
    },
    {
      recordId: "r-2",
      lineNo: 2,
      name: "李四",
      hospital: "南京鼓楼医院",
      dateRaw: "2026/9/24",
      status: "ready",
      issues: [],
      aiImageRefs: [{ image: 2, row: 1 }],
    },
  ];
  const context = sessions.buildContext(session, records, "张三日期改成 9 月 24 日", 6);
  check("上下文只带最近 6 条消息", context.recentConversation.length === 6);
  check("上下文带当前完整记录快照", context.currentRecords.length === 2);
  check("未解决问题只带异常记录", context.unresolvedIssues.length === 1);
  check("确认过的决策进入上下文", context.confirmedDecisions[0] === "日期保持材料原样");

  const saved = await sessions.save(session);
  const loaded = await sessions.load(saved.id);
  check("无 IndexedDB 的 Node 环境使用内存降级", loaded && loaded.title === session.title);
  check("会话列表可按更新时间读取", (await sessions.list()).some((item) => item.id === saved.id));
  const sourced = ai.normalize(
    { imageRows: [{ image: 2, row: 7, name: "王五", hospital: "", date: "" }] },
    core,
  ).records[0];
  check("首次识图记录保留图片编号与图内行号", sourced.aiImageRefs[0].image === 2 && sourced.aiImageRefs[0].row === 7);
  check(
    "会话快照保留图片来源，后续可按‘第二张图’操作表格",
    sessions.snapshotRecords([sourced])[0].aiImageRefs[0].image === 2,
  );

  console.log("\n[2] 多轮请求只发送裁剪后的事实上下文");
  const body = ai.buildConversationRequestBody({ model: "deepseek-flash", context });
  check("使用 JSON 输出模式", body.response_format.type === "json_object");
  check("system 使用校对操作协议", body.messages[0].content === ai.CONVERSATION_PROMPT);
  check("不重看图片时 user content 是字符串", typeof body.messages[1].content === "string");
  check("请求包含稳定 recordId", body.messages[1].content.includes("r-1"));
  check("提示词禁止整表重写", /不要输出完整 records/.test(body.messages[1].content));
  check("校对协议只允许白名单字段", /name\/hospital\/dateRaw/.test(ai.CONVERSATION_PROMPT));
  check("最新明确指令可以覆盖旧决定，不再循环确认", /不得反复要求再次确认/.test(ai.CONVERSATION_PROMPT));

  console.log("\n[3] 操作白名单、预览与本地执行");
  const normalized = ai.normalizeOperations(
    {
      reply: "我会修正日期并补一人。",
      operations: [
        { type: "set_field", targetId: "r-1", field: "dateRaw", value: "2026/9/24" },
        {
          type: "add_record",
          record: { name: "王五", hospital: "南京鼓楼医院", dateRaw: "2026/9/24" },
        },
        { type: "remove_record", targetId: "not-exist" },
        { type: "set_field", targetId: "r-2", field: "outputName", value: "越权" },
      ],
      decisions: ["张三日期为 2026/9/24"],
    },
    records,
    core,
  );
  check("合法操作留下两项", normalized.operations.length === 2, normalized.operations.length);
  check("不存在目标被拒绝", normalized.errors.some((item) => item.includes("找不到")));
  check("非白名单字段被拒绝", normalized.errors.some((item) => item.includes("不允许")));

  const applied = ai.applyOperations(records, normalized.operations, core);
  check("应用不修改原数组", records[0].dateRaw === "2026/9");
  check("日期修改已执行", applied.records[0].dateRaw === "2026/9/24");
  check("修改后重新校验为可生成", applied.records[0].status === "ready");
  check("新增记录进入表格", applied.records.some((item) => item.name === "王五"));
  check("新增记录也经过本地校验", applied.records.find((item) => item.name === "王五").status === "ready");
  check("执行后行号连续", applied.records.every((item, index) => item.lineNo === index + 1));

  const merge = ai.normalizeOperations(
    {
      operations: [{
        type: "merge_records",
        targetIds: ["r-1", "r-2"],
        record: { name: "张三", hospital: "南京鼓楼医院", dateRaw: "2026/9/24" },
      }],
    },
    records,
    core,
  );
  const merged = ai.applyOperations(records, merge.operations, core);
  check("两条记录可以在确认后合并为一条", merged.records.length === 1);
  check("合并保留首条稳定 recordId", merged.records[0].recordId === "r-1");

  console.log("\n[4] 真实对话回归：第二张图整批与统一补日");
  const byImage = ai.normalizeOperations(
    {
      operations: [{
        type: "set_field_by_source",
        sourceImage: 2,
        field: "dateRaw",
        value: "2022/10",
        reason: "用户明确说第二张图片整批属于 2022 年 10 月",
      }],
    },
    records,
    core,
  );
  check("按第 2 张图只匹配到对应记录", byImage.operations.length === 1);
  check("按图片来源定位到李四", byImage.operations[0].targetId === "r-2");

  const mixedMonths = [
    Object.assign({}, records[0], { dateRaw: "2022/10" }),
    Object.assign({}, records[1], { dateRaw: "2026/1" }),
  ];
  const fillDay = ai.normalizeOperations(
    {
      operations: [{
        type: "set_day_all",
        day: 10,
        reason: "用户明确确认全部记录按各自月份补 10 号",
      }],
    },
    mixedMonths,
    core,
  );
  check("统一补日覆盖全部记录", fillDay.operations.length === 2);
  check(
    "统一补日保留每条原有年月",
    fillDay.operations.map((item) => item.value).join(",") === "2022/10/10,2026/01/10",
    fillDay.operations.map((item) => item.value).join(","),
  );
  const filled = ai.applyOperations(mixedMonths, fillDay.operations, core);
  check("两种月份都能直接应用到表格", filled.records.every((item) => item.status === "ready"));

  const localByImage = ai.deriveExplicitOperations(
    "第二张图片里面的完整目录应该全部日期是22年的10月份",
    records,
    core,
  );
  check("明确的‘第二张图整批’命令可在本地识别", localByImage.operations.length === 1);
  check("两位年份按 2000 年代规范化", localByImage.operations[0].value === "2022/10");
  const localDay = ai.deriveExplicitOperations(
    "所有记录日期改为对应月份的10号",
    mixedMonths,
    core,
  );
  check("明确的‘所有记录补10号’不再交给模型循环确认", localDay.operations.length === 2);

  console.log("\n" + "=".repeat(70));
  console.log(`通过 ${passed} 项，失败 ${failed} 项。`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
