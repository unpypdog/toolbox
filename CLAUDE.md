# 项目结构规范

## 目录结构

```
toolbox/
├── index.html              # 工具箱首页
├── pyproject.toml          # 项目配置与依赖
├── uv.lock
├── tools/                  # 各个工具，每个工具一个独立文件夹
│   ├── lung-marker/        # 支气管分段标记
│   │   └── index.html
│   ├── rmb-upper/          # 人民币大写转换
│   │   └── index.html
│   ├── tax-calc/           # 税点计算器
│   │   └── index.html
│   ├── training-cert-batch-fill/   # 操作证书考试账号批量导入
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── styles.css
│   │   └── xlsx.full.min.js
│   └── te-cert-generator/  # TE 培训证书批量生成
│       ├── index.html
│       ├── app.js
│       ├── cert-core.js            # 名单解析、校验、命名、模板读取、排版槽位（无网络）
│       ├── cert-direct-pdf.js      # 固定背景 + Canvas 文字的离线 PDF 生成（唯一生成路径）
│       ├── cert-ai.js              # AI 名单抽取（OpenAI 兼容接口，支持图片）
│       ├── styles.css
│       ├── build-templates.js      # docx → base64 载荷（改了 docx 必须重跑）
│       ├── template-*.docx         # 证书模板（只作为背景图载体）
│       ├── template-*.b64.js       # 模板载荷（file:// 下靠它读模板）
│       ├── vendor/pdf-lib.min.js   # 本地 PDF 组装库（含 MIT 许可）
│       └── xlsx.full.min.js
│       # 注：cert-cloud.js / cert-merge.js 已删除，见硬约束 12
└── tests/                  # 测试文件
    ├── screenshots/        # 测试截图（gitignore）
    ├── test_lung_marker.py
    ├── test_rmb_upper.py
    ├── test_tax_calc.py
    ├── test_toolbox.py
    ├── test_training_cert_batch_fill.py
    ├── test_te_cert_generator_core.js    # 证书工具核心逻辑（纯 Node）
    ├── test_te_cert_direct_pdf.js        # 本地直接 PDF 逻辑
    ├── test_te_cert_direct_pdf_browser.py # 真实 Chromium 生成测试
    ├── test_te_cert_ai_images_browser.py # 真实 Chromium 多图输入测试
    ├── lint_te_cert_generator.js         # 证书工具接线检查（纯 Node）
    └── test_te_cert_dom_smoke.js         # 证书工具 DOM 冒烟（最小 DOM 桩）
```

### te-cert-generator 的十四条硬约束

改这个工具前先读这十四条，都是踩过的坑：

1. **模板改了必须重跑载荷**：`node tools/te-cert-generator/build-templates.js`。
   `file://` 下 Chromium 拒绝 fetch 同目录的 docx，模板只能靠 base64 载荷用
   `<script src>` 加载。忘了重跑会用旧模板静默生成证书，`lint_te_cert_generator.js`
   会逐字节比对拦下这种情况。
2. **CSP 里的 `connect-src` 是白名单，且只该剩 AI 一个域名**：
   证书生成过程**一个网络请求都不发**（背景图与文字都在本机合成），
   所以那里除了 `'self' file:` 就只放行 `https://api.deepseek.com`（AI 解析用）。
   不是通配 `https:` —— 那会把这个静态页变成任意外发通道。
   `lint_te_cert_generator.js` 会断言远程域名**恰好一个**，并扫描 index.html
   是否还残留旧云服务商的名字。
3. **隐私文案只讲一件事，但要讲准**：证书生成全程本机完成、不上传任何内容；
   **AI 解析是唯一的联网路径**，且只有用户显式选了服务、填好密钥、点了「AI 解析」
   才会把名单内容发出去。页面必须同时写清这两句 ——
   既不能把 AI 路径写成"不上传"，也不能让用户以为生成证书会联网。
4. **不提供 DOCX 下载入口，而且已经不产出 DOCX**：证书一旦发出去就是最终版，
   源文件可以被随意改动，不适合交付给学员。
   `CertCore.buildDocx` / `fillDocumentXml` 与 `app.js` 的 `buildCertificateItems`
   原本只为云端 DOCX→PDF 服务，云转换移除后它们已**整段删除**（见约束 12）——
   不要再以"以后可能用得上"为理由把它们加回来。
   `test_te_cert_dom_smoke.js` 的 `[5b]` 节有反向断言，防止以后被"顺手"加回来。
5. **PDF 默认逐份输出、自动打包成一个 ZIP**：证书是发给个人的，文件名形如
   `TE操作培训证书_姓名.pdf`（同名重复用 `_2`、`_3` 区分，靠 `record.fileBase`）。
   多个文件必须**打成一个 ZIP 再下载**，且**不设开关**（`const shouldZip = files.length > 1;`）——
   连续触发多次下载会被浏览器拦（要用户逐次点"允许"），还得逐个确认保存位置；
   这是技术细节，不该让用户做选择。单文件不打包，省掉一次解压。
   合成一本多页 PDF 是唯一的开关（`els.pdfMergeToggle`，默认不勾），供归档用 ——
   默认值不能改成合并，客户明确不接受合订本（收件人得自己找自己那页）。
   本地路径下合批就是 pdf-lib 逐页 `addPage`，没有计费差异。

6. **AI 抽取结果必须走 `core.validateRecord`，且字段名不能自创**。
   它读的是 **`dateRaw`**（原始日期字符串），不是 `dateText`；写成后者会让**每一条**
   都报「缺少颁发日期」——看起来像"AI 没抽到日期"，实际是适配层写错了字段名。
   `cert-ai.js` 的 `mergeExtraction()` 先执行图文工作流，`normalize()` 再把合并结果转成 core
   约定的形状；姓名/医院/日期格式校验仍一律交给 core。AI 冲突与存疑只在 core 的结果上
   追加 issue，绝不能另写一套基础字段校验或绕过校验直接生成证书。
   这条契约有断言钉着：`test_te_cert_generator_core.js` 的 `[4]` 节。

7. **每个模块都要在 `index.html` 里真的加载**。
   `app.js` 里写的是 `if (!window.CertAi) return;`，漏加载 `<script>` 的后果是
   **整个面板静默不渲染**——页面上不报错，只是"那块功能不见了"。
   `lint_te_cert_generator.js` 会核对 `window.CertX` 与 `<script src>` 是否配套。

8. **AI 提示词里绝对不能出现具体日期与机构名**（示例只能用占位符）。
   真踩过：示例里写了「〈某医院〉 2025年10月10日」，用户在文本框里写的是
   `26年1月12日`、图片上没有日期，结果模型把**示例里的日期**当成了真实信息，
   套到所有记录上，产出一批日期全错的证书。
   现在提示词里的具体值一律写成 `〈机构全称A〉`／`〈日期B〉` 这类占位符，
   `test_te_cert_generator_core.js` 的 `[4]` 节有一条断言扫描提示词里是否残留真实日期。
   **闸门要同时查两位数年份**：用户和图片里最常写的就是「26年1月12日」「22年10月20日」，
   只查 `\d{4}[-年]…` 会漏掉它们 —— 实测正是这个形态的示例值被模型照搬。
   现在的断言两种形态都查（四位数年份 + `\d{1,2}年\d{1,2}月\d{1,2}日`）。

9. **图文合并必须代码化：AI 只提取事实，绝不能直接输出最终 `records`**。
    旧版把四步流程全写进提示词，让模型同时 OCR、理解作用范围、决定覆盖优先级并输出最终名单；
    这会让相互冲突的规则随模型版本漂移。现在契约固定为：
    - `imageRows`：图片逐行事实（`name / hospital / date / note / evidence`）；
    - `textPeople`：文字中明确作为证书领取人的姓名；
    - `assignments`：文字赋值，只含 `field / value / scope / targets / evidence`；
    - `unreadable`：无法读取的原因。

    真正的 workflow 在 `cert-ai.js` 的 `mergeExtraction()`：图片建立基础行，文字人员补齐缺失行，
    文字赋值按 **global < ordered < rows < named** 从低到高应用。明确姓名或分组只覆盖命中的行，
    文字没涉及的图片字段保留；同等作用范围出现不同值时不猜，转成行级冲突。

    **唯一且无分组迹象的文字全局值代表用户主动填写的本次信息，必须覆盖图片旧值**。
    这是对旧事故的确定性修复：文字日期不再与图片日期比较、调和或拼接，覆盖由代码整字段完成。
    多个候选值却无法确定对应关系时使用 `ambiguous`：保留图片原值并把相关行标成「需处理」。

    **姓名纠正会改掉 `name`，而模型手里始终是图片上的原名**。`mergeExtraction` 因此做了两件事：
    `findByNames` 同时认「当前姓名」和 `_imageName`（图片原名快照），且 `rows` 纠正过的旧名会被
    改写成新名再传给其余赋值。少了任何一件，模型用原名做的点名赋值就查不到目标，转而在兜底
    分支新增一行 —— 一次改名变成两个人，且失败是静默的（只在多出来的那行挂条 issue）。

    护栏必须是行为测试，不再只扫描提示词关键句。`test_te_cert_generator_core.js` 的 `[4]` 节至少覆盖：
    全局覆盖、named/rows/ordered 优先级、同级冲突、ambiguous 保留原值、姓名纠正去重、
    改名后原名点名赋值仍命中同一行、旧版 `records` 不能绕过本地工作流。

10. **`max_tokens` 不能小、思考模式必须显式关掉，截断检查必须在 `JSON.parse` 之前**。
    这三条是同一次故障的三个面，别只改一个：
    DeepSeek 的**思考模式默认开启、思考力度默认 high**，而**思考 token 与正文共用
    `max_tokens`**。所以旧的 `max_tokens: 4096` 会被思考吃光，正文一个字都没轮上 ——
    现象是 `content` 为空 + `finish_reason=length`，报错却写成「名单太长，请分批解析」，
    把用户引向完全错误的方向（照片根本没法分批）。
    现在固定：`MAX_OUTPUT_TOKENS = 32768`（接口上限 1..384K，非思考模式官方默认 8K）+
    `thinking: {type:"disabled"}`（抽名单不需要长链推理，预算全留给正文）。
    换模型或想提高推理力度时，这两个值要一起动。
    另外**截断检查必须放在 `JSON.parse` 之前**：被截断的 json 解析出来是半个对象，
    走到 parse 只会得到「模型输出的不是合法 json」+200 字乱码，真正的原因被盖掉。
    护栏在 `test_te_cert_generator_core.js` 的 `[4]` 节：默认预算下限、接口上限、
    `thinking` 已关、可被 `options.maxTokens` 覆盖、以及「带图片的截断文案必须
    说明图片没法分批」。

11. **`assignments.note` 不是「存疑」通道，代码一律忽略它**。
    表达不确定的**唯一**通道是 `scope: "ambiguous"`。曾经提示词写着「任何不确定都写进对应
    note」，而 `applyValue` 把所有 `note` 都升级成行级 issue：模型给一条 **`global`** 赋值附了
    说明性 note（"文字说明称图片解析日期为 22 年 10 月 20 号，未指明具体人员或行"），
    而 global 作用于每一行 —— **整批记录全部变成「需处理」，用户一条都生成不了**。
    现在：`note` 不在提示词输出格式里、不参与合并，真出现只在 warnings 留一句线索；
    真存疑必须用 `ambiguous`（保留图片原值 + 标「需处理」），那才是该拦的情况。
    护栏：`test_te_cert_generator_core.js` 的 `[4]` 节有「带说明性 note 的全局赋值照常覆盖、
    不把整批标成需处理」与「真存疑走 ambiguous 时依然拦下」两条对照断言。

    相邻的一条：`record.aiSources` 用的是 core 的字段名（`name/hospital/date`），
    而表格那一列叫 `dateRaw` —— `editableCell` 里必须做 `dateRaw → date` 的映射，
    否则日期格的来源角标永远不显示（真实踩过）。

12. **本地直接 PDF 是唯一的生成路径，它是固定背景 + 栅格文字，不是 DOCX 渲染器**。
    `cert-direct-pdf.js` 必须复用 `CertCore.extractImage()` 与 `printSlots()`，原始 JPEG 不重压缩，
    动态文字由浏览器 Canvas 使用微软雅黑绘制为透明 PNG 后叠加；因此文字不可搜索/选中。
    不要重新引入整套中文字体嵌入（旧方案约 23.9MB 且 pdf-lib 子集化曾产出空文字）。
    改坐标、字号或字距后，必须运行 `test_te_cert_direct_pdf_browser.py`，并与 Word 参照图做视觉核对。

    **云端 DOCX→PDF 路径（以及为它服务的整条 DOCX 生成管线）是有意删除的，不要加回来**：
    它的唯一价值是产出可搜索文字，而代价是一整套云适配层、密钥存储、服务商下拉框、
    CSP 白名单、合批分页符这些只在特定引擎下成立的补丁。
    同时删掉的还有 `cert-merge.js`（为"逐份转换后再前端合并"准备，而合批现在由
    pdf-lib 逐页 `addPage` 原生支持）。
    反向断言在 `test_te_cert_generator_core.js` 的 `[6]` 节与 `lint_te_cert_generator.js` 的 `[2]` 节。

13. **图片不等于名单表格；日期允许缺段**。这两条是同一次改进的两面，都是真实素材逼出来的：
    - 用户最自然的用法是把**整张聊天记录截图**丢进来（指令全在图里）。旧版对「只有图片」的输入
      在 user 消息里写着「textPeople 和 assignments 必须为空」，于是医院、日期、后补的姓名
      全被丢掉，表格里只剩姓名 —— 现象像"AI 读不出信息"，其实**是提示词禁止它读**。
      现在聊天记录里被转发的名单图、单独发出的姓名清单、关于医院/日期的说明都按同一套契约
      提取（`imageRows`/`textPeople`/`assignments`），作用范围仍由 `mergeExtraction` 判定。
      **不许把这条限制加回来**。
    - 素材常常只有年月（「那张图片里的名单写〈年份〉年〈月份〉月份左右」，「日」根本不存在）。
      `parseDate` 仍是严格契约（缺段抛错，调用方都要完整日期），但 `validateRecord` 走
      `parseDateParts`：读到年月就原样留在 `dateRaw` 里（表格直接显示给人补）、报
      「日期不完整：只读到 ×× 年 ×× 月，请补「日」」、`date` 保持 null、状态仍是 invalid。
      生成闸门只看 `status === "ready"`，所以缺日的记录永远进不了 PDF —— 这条链不能松。
      把契约改回「date 统一为 YYYY-MM-DD」等于逼模型编一个「日」，那是**静默印错证书**。
    护栏在 `test_te_cert_generator_core.js`：`[2]` 节断言缺段/ garbage 的分界（「10」不许被读成
    2010 年）、`[4]` 节有一张完整聊天记录截图的端到端场景（11 行、医院全局、7 行缺日、
    4 行月份归属不明，全部拦下且不殃及整批）。

14. **一次可以给多张图；同一个人只能落成一条记录**。这两条是同一次改进的两面：
    - 页面（`aiImageInput` 的 `multiple`）与请求（`images: [...]`，最多 `MAX_IMAGES` 张）
      都支持多图。模型按上传顺序把它们编号 1..N，每行带 `image`、赋值可带 `targetImage`。
      **行号是「图内行号」**：第 2 张图的第 1 行 ≠ 第 1 张图的第 1 行，所以匹配一律看
      `{image,row}` 整个坐标（`findByImageRows`），只看行号就会张冠李戴。
      读文件时注意：`input.value = ""` 会把 `files` 这个**活的** FileList 当场清空，
      必须先拷成数组 —— `test_te_cert_ai_images_browser.py` 就是为这类只在真浏览器里
      才暴露的问题存在的（CLAUDE 里记着：桩测不出「选了没反应」）。
    - 提示词要求模型**逐图如实提取、绝不跨图去重**（去重是业务决定，不是提取），
      去重与补齐在 `mergeSameNameRows()`：同名同人 → 补空合一行；同名但值冲突 →
      两条都留并标「疑似重复」。少了它，用户给「聊天截图 + 一张完整名单」就会拿到
      同一个人的两份证书 —— 发出去就收不回来。
    - 相邻的一条：文字日期比图上更粗（只到年月或年）且与图上**同月/同年**时不覆盖，
      保留更精确的那条（`keepsMorePreciseDate`）。否则用户刚补进来的完整名单，
      会被聊天里那句「〈年〉年〈月〉月份左右」打回不完整，还得再填一遍。
      文字说了别的月份/年份照常覆盖 —— 那是改写指令，不是回忆。
    - **`scope:"rows"` 不写行号 = 整组**（`rowsTargets`）：写了 `targetImage` 就是那张图的
      全部行，连图号都没写就是所有图片里的人。实测踩过：模型把「那张图片里的名单」理解成
      整张图、`targetRows` 留空，旧实现只认行号 → 赋值找不到目标 → **一整列日期全空**，
      而提示只有一句「找不到目标：rows」，用户完全不知道该改什么。放宽时必须回一条
      「没写行号，已按第 N 张图的 M 行整组套用」，套错范围比不套更贵。
      **姓名纠正绝不放宽** —— 那条一旦放宽就是把整批人改成同一个名字。
    - **没收窄的 `ambiguous` 只按证据强弱收窄一次**（`ambiguousTargets`）：同一字段上先看
      有没有点名到人的赋值，再看有没有按行的赋值，都没有才退回整批。实测：聊天先给图片里
      那批人定了日期、又对另外几个点名的人改了口，那条没写目标的 ambiguous 把 19 个
      与它无关的人一起标红，整批都生成不了（和约束 11 是同一类事故）。
    - **「某列没解析出来」必须有出口**：AI 面板的「查看 AI 原始返回」（`renderAiRaw`）
      摊开模型返回的 json 原文 + 本地工作流的处理说明；整列全空时提示条还要直说
      「材料里没有就不会替你编」（`missingFieldHints`）。没有这个出口，「模型没给」
      和「给了没落地」长得一模一样，而这两种的修法完全相反 —— 真实排查就卡在这里。
    护栏在 `test_te_cert_generator_core.js` 的 `[4]` 节（合并 / 冲突 / 图内行号定位 /
    更粗日期不覆盖 / 张数与体积闸门 / **DeepSeek 真实返回的整段回归**），
    接线检查在 `lint_te_cert_generator.js`，真实浏览器路径在 `test_te_cert_ai_images_browser.py`。


### te-cert-generator 参考资料：字体与姓名框几何

**这两条是拿原项目的 Word 成品反读出来的实测结论，不要在不知情的情况下改动它们。**

#### 一、证书实际渲染用的是微软雅黑，不是模板声明的思源黑体

模板 DOCX 声明的是「思源黑体 CN Heavy / VF / VF Normal」，但从成品 PDF 的
内部字体资源反读，**实际嵌入的是 `MicrosoftYaHei`**（8 份参考 PDF 全部如此）：

```
模板 DOCX 声明    →  思源黑体 CN Heavy / VF / VF Normal
Word 渲染时找不到  →  回退到 微软雅黑（Microsoft YaHei）
```

而且 Word 原生 DOCX 里 `<w:b/>` 数量为 **0** —— 字重完全靠字体名表达。所以回退成
雅黑后，三处文字的字重差异全部消失，**一律是雅黑 Regular**。

这条直接决定了两件事：换字体时要对齐的是雅黑而非思源黑体；`cert-direct-pdf.js` 的
`FONT_FAMILY` 首选也正是微软雅黑（找不到才退回 Noto Sans SC / SimHei），
所以本机渲染出来的字形与当年的 Word 成品一致。

#### 二、姓名框几何模型与加宽公式

几何现在只有**一份**实现，在 PDF 路径上，分两层：

- **基准槽位**：`cert-core.js` 的 `PRINT_LAYOUT`，由 `printSlots()` 输出。
  坐标是拿参考 PDF 实测落点锚定的，不是从 DOCX 的 EMU 常量推导的
  （推过一版，横向差 4~18pt：Word 的 posOffset 指文字区基准，再叠加 inset 就重复计算了）。
  姓名槽位固定 **124.5pt 宽、左右内边距各 3.6pt，36pt 字号 → 只放得下 3 个字**。
- **加宽规则**：`cert-direct-pdf.js` 的 `resolveSlot(slot, record)`。它按姓名字数改
  `spec.left` 与 `spec.width`，然后交给 Canvas 居中绘制。

```
2 字      left = 基准 left + 18       width = 124.5
3 字      left = 基准 left            width = 124.5        ← 校准基准
n ≥ 4 字  left = 基准 left − 36(n−3)  width = 124.5 + 36(n−3)
```

实测基准落点（页坐标，A4 横向 841.9 × 595.3 pt）：

| 锚点 | 文本左 | 文本宽 | 距顶 | 字号 |
|---|---|---|---|---|
| 姓名（3 字） | 309.89 | 108.00 | 258.52 | 36 |
| 姓名（2 字） | 345.89 | 72.00 | 258.52 | 36 |
| 医院名（7 字） | 429.89 | 126.00 | 273.04 | 18 |
| 日期「颁发日期: …」整行 | 548.47 | — | 513.85 | 12 |

**加宽必须全部往左、把文本框右边缘钉死**：右边缘往右爬会吃掉与医院名之间的间隙
（3 字时间隙只有 16.6pt，右移 36pt 就重叠了）。每个多出的字左移 **36pt**（一个字宽），
不是半个字宽 —— 后者是"重新居中"的做法，在这里是错的锚点。

代价：姓名整体偏左，5 字时文字左边缘约 237.9pt，仍远在页边距内；
背景图在姓名那一行横向是空白（已逐行扫描确认），加宽不会压到东西。

> 历史：模板里原本还有第二套几何表示（`<mc:Choice>` 的 DrawingML `extent cx` 与
> `<mc:Fallback>` 的 VML `width`），两套必须同步改，否则会出现「Word 里正常、WPS 里错位」。
> 那是 DOCX 生成路径的事，随云端转换一并删除了 —— 现在不再有这个问题。

护栏在 `tests/test_te_cert_generator_core.js` 的 `[1]` 节，覆盖 2/3/4/5 字 × 两个模板，
并断言「框右边缘恒定」「**居中文字**的右边缘恒定」「文字右边缘仍在医院名之前」。
注意断言的是**文字**右边缘而不只是框边缘：文字在框内居中，只钉框是钉不住视觉落点的。

## 文件组织规则（必须遵守）

1. **每个工具独立文件夹**：HTML 及其相关的 JS/CSS/Python 执行文件放在 `tools/<tool-name>/` 下，入口文件命名为 `index.html`
2. **测试文件统一管理**：所有测试文件放在 `tests/` 下，命名格式 `test_<tool-name>.py`
3. **首页在根目录**：工具箱首页 `index.html` 留在项目根目录
4. **新增工具流程**：在 `tools/` 下创建以工具名命名的文件夹（kebab-case），入口 `index.html`，在根 `index.html` 中添加导航卡片，在 `tests/` 中创建对应测试文件
5. **工具内引用首页**：工具页面返回首页使用相对路径 `../../index.html`
6. **首页引用工具**：使用相对路径 `./tools/<tool-name>/index.html`（因 `file://` 协议不会自动解析目录到 index.html）

---

# 部署方案评估与推荐

你是一名资深的软件架构与部署顾问，熟悉前后端分离、Monorepo、Serverless、容器化、以及各类云平台（如 Vercel、Netlify、Render、Railway、Fly.io、AWS、GCP、Azure 等）。

当前任务：评估并推荐本项目的开发与部署方案。

---

## 评估原则（最高优先级）

1. **前后端必须拆分评估**。全栈/Monorepo 项目绝不能一刀切丢到同一个平台。Vercel/Netlify 适合前端和短生命周期 Serverless 函数，不适合需要长时间运行进程的后端服务。
2. **根据运行特性选平台，而非根据惯性**。有 WebSocket、长时任务、队列消费、Cron Job 等需求时，优先推荐 Render、Railway、Fly.io 或自建服务器。
3. **给出可执行的方案，而非泛泛而谈**。每套方案必须包含具体平台名称、部署模式、数据库选择，以及推荐度等级。

---

## 评估输入模板

使用以下信息填充评估：

```
【项目信息】
- 项目类型： [全栈 Web 应用 / 纯前端 SPA / 后端 API / 微服务 / 其他]
- 技术栈与结构：
  - 前端： [框架/构建工具，如 Next.js / React SPA / Vue / SvelteKit 等]
  - 后端： [框架，如 Node.js(Express/Nest/Fastify) / Django / Spring Boot / Go 等]
  - 运行特性： [是否需要长链接(WebSocket)、定时任务、后台任务、长时运行进程、大文件处理等]
  - 数据库与存储： [如 Postgres/MySQL/MongoDB/Redis/对象存储等]
- 仓库结构： [前后端同一 Monorepo / 分仓库 / 仅前端 / 仅后端]

【现有/候选平台】
- 已考虑平台： [如 Vercel, Netlify, Render, Railway, Fly.io, Cloudflare Pages/Workers, 自托管等]
- 现有基础设施： [有无云账号、Kubernetes 集群、自建服务器等]

【非功能性约束】
- 预算： [低 / 中 / 高，大致范围]
- 流量与规模： [预估 QPS、并发、用户量级]
- 地区与合规： [如：需在国内访问较快 / 需满足 GDPR / 数据不得出某区域等]
- 性能与延迟要求： [如：首屏需要很快 / 接口延迟必须 < X ms]
- 运维能力： [有无专门 DevOps / 是否能接受自己维护服务器]

【当前阶段】
- 阶段： [plan / deploy]
```

---

## 评估输出格式

### 1. 可行性与推荐度总评

用 1 段话概述当前方案在技术和资源上的可行性。给出总体建议等级：

| 等级 | 说明 |
|------|------|
| **强烈推荐** | 技术栈与平台高度匹配，成本可控，无明显阻塞风险 |
| **推荐** | 整体可行，存在少量需注意的限制或取舍 |
| **谨慎使用** | 存在明显限制或风险，需要额外的变通方案 |
| **不推荐** | 存在无法绕过的技术障碍或成本失控风险 |

### 2. 前端与后端分别评估

#### 前端部署

- 是否适合 Vercel / Netlify / Cloudflare Pages 等前端/Serverless 平台？
- 如果不适合，说明原因（如需要复杂后端路由、长时间运行任务等）。
- 推荐的前端部署模式和平台。

#### 后端部署

- 是否适合部署到 Vercel 这种 Serverless 平台？
- 如果项目有长连接(WebSocket)、长时间任务、任务队列、重型计算等，优先考虑 Render、Railway、Fly.io、自建服务器或容器平台，并解释原因。
- 推荐的后端部署模式和平台。

#### 拆分建议

如果用户提出"把全栈项目全部丢到 Vercel"，必须指出这样做的限制并给出更合理的拆分建议（如：前端 Vercel，后端 Render）。

### 3. 平台组合推荐

列出 2～3 套可行的组合方案，每套包含：

| 维度 | 内容 |
|------|------|
| 前端 | 部署平台 + 模式（静态/SSR/Edge Functions） |
| 后端 | 部署平台 + 模式（Serverless / 容器 / 传统 VM） |
| 数据库与存储 | 推荐托管服务或托管方式 |
| 推荐度 | 高 / 中 / 低 |
| 取舍说明 | 成本、复杂度、可扩展性、运维难度的 2～3 句话 |

### 4. 针对当前阶段的具体建议

**如果是 plan 阶段：**

1. 推荐的目标架构图（文字描述即可）
2. 后续需要验证的关键问题列表：
   - 数据库选型是否确定？
   - 平台免费额度是否足够？
   - 冷启动延迟是否可接受？
   - WebSocket / 长连接需求是否已有明确方案？
   - Monorepo 拆分策略是否已确定？

**如果是 deploy 阶段：**

1. 部署流程步骤（创建项目 → 环境变量 → Monorepo 拆分 → 域名路由等）
2. 关键配置示例（如 Vercel 项目设置要点、Render 服务类型选择、环境变量清单等）

### 5. 风险与补充建议

列出 3～5 个主要风险或注意点（性能、成本、平台锁定、迁移难度等），每条附缓解建议。如有必要，给出后续演进路径（如：前期用 Vercel+Render，后期流量增长后迁移到某云 Kubernetes）。

---

## 平台速查表

| 平台 | 最适合 | 不适合 |
|------|--------|--------|
| **Vercel** | 前端 SSR/SSG、Edge Functions、短生命周期 API | 长时运行后端、WebSocket、Cron Job、大文件处理 |
| **Netlify** | 静态站点、Lambda Functions | 同 Vercel |
| **Cloudflare Pages/Workers** | 边缘渲染、轻量 API | 完整后端框架、长连接 |
| **Render** | Web 服务、后台 Worker、Cron Job、托管数据库 | 极低延迟的边缘计算 |
| **Railway** | 各类后端服务、数据库、快速原型 | 中国大陆访问速度 |
| **Fly.io** | 边缘容器、WebSocket、低延迟全球部署 | 托管数据库生态较弱 |
| **AWS/GCP/Azure** | 大规模、复杂架构、合规需求 | 小项目或运维能力有限的团队 |
| **自托管/VPS** | 完全控制、固定成本、合规 | 无 DevOps 能力的团队 |

---

## 常见场景速判

- **纯前端 SPA + 无后端** → Vercel / Netlify / Cloudflare Pages，直接静态托管。
- **Next.js 全栈（仅 API Routes + SSR）** → Vercel 优先，但需确认 API Routes 无长时任务。
- **Next.js + 独立后端（Express/Django 等）** → 前端 Vercel，后端 Render/Railway/Fly.io。
- **有 WebSocket 或长时任务** → 后端绝对不能放 Vercel，必须用 Render/Railway/Fly.io/自建。
- **需要国内访问** → 优先考虑阿里云/腾讯云或 Cloudflare + 国内 CDN 组合。
- **Monorepo 项目** → 用 Turborepo/Nx 管理，按前端/后端分别部署到不同平台。
