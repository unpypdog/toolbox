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
│   ├── training-cert-batch-fill/   # 操作培训证书批量填充
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── styles.css
│   │   └── xlsx.full.min.js
│   └── te-cert-generator/  # TE 培训证书批量生成
│       ├── index.html
│       ├── app.js
│       ├── cert-core.js            # 模板填充、ZIP、日期解析（无网络）
│       ├── cert-cloud.js           # 云端 DOCX→PDF 适配层（浏览器直连）
│       ├── cert-ai.js              # AI 名单抽取（OpenAI 兼容接口，支持图片）
│       ├── cert-merge.js           # PDF 合并（备用工具，页面未加载，见文件头说明）
│       ├── styles.css
│       ├── build-templates.js      # docx → base64 载荷（改了 docx 必须重跑）
│       ├── template-*.docx         # 证书模板
│       ├── template-*.b64.js       # 模板载荷（file:// 下靠它读模板）
│       └── xlsx.full.min.js
└── tests/                  # 测试文件
    ├── screenshots/        # 测试截图（gitignore）
    ├── test_lung_marker.py
    ├── test_rmb_upper.py
    ├── test_tax_calc.py
    ├── test_toolbox.py
    ├── test_training_cert_batch_fill.py
    ├── test_te_cert_cloud_core.js        # 证书工具核心逻辑（纯 Node）
    ├── lint_te_cert_cloud.js             # 证书工具接线检查（纯 Node）
    └── test_te_cert_dom_smoke.js         # 证书工具 DOM 冒烟（最小 DOM 桩）
```

### te-cert-generator 的十二条硬约束

改这个工具前先读这十二条，都是踩过的坑：

1. **模板改了必须重跑载荷**：`node tools/te-cert-generator/build-templates.js`。
   `file://` 下 Chromium 拒绝 fetch 同目录的 docx，模板只能靠 base64 载荷用
   `<script src>` 加载。忘了重跑会用旧模板静默生成证书，`lint_te_cert_cloud.js`
   会逐字节比对拦下这种情况。
2. **CSP 里的 `connect-src` 是白名单**：云转换的三个服务商域名写死在这里，
   不是通配 `https:`。新增服务商要同时改 `cert-cloud.js` 的端点和 `index.html`
   的 CSP，linter 会核对两边是否一致。
3. **不能说"不上传"**：DOCX 全程本地，但 PDF 转换会把证书内容发给用户选定的
   云服务。页面文案必须讲清楚这一点，默认值必须是"不转换"。
4. **不提供 DOCX 下载入口**：证书一旦发出去就是最终版，源文件可以被随意改动，
   不适合交付给学员。DOCX 只作为云转换的**中间产物**存在 ——
   `CertCore.buildDocx` 与 `buildCertificateItems` 必须保留（PDF 转换依赖它们），
   但页面上不能有任何"下载 / 导出 DOCX / ZIP 里是 docx"的入口或文案。
   `test_te_cert_dom_smoke.js` 的 `[5b]` 节有反向断言，防止以后被"顺手"加回来。
5. **Adobe PDF Services 必须用它的专属令牌端点**（照搬通用 Adobe IMS 会一直 400）：

   ```
   POST https://pdf-services.adobe.io/token      ← 不是 ims-na1.adobelogin.com/ims/token/v3
   Content-Type: application/x-www-form-urlencoded
   client_id=<Client ID>&client_secret=<Client Secret>   ← 没有 grant_type
   ```

   两者的差别不只是端点：IMS 出错时**不带** `Access-Control-Allow-Origin`，浏览器
   会把 400 报成"没有 CORS 头"，把真正原因盖掉；专属端点出错时带 `ACAO: *`，能读到
   错误正文。另外 Adobe 的资产上传与成品下载都是直连 S3 预签名地址，CSP 必须放行
   `dcplatformstorageservice-prod-us-east-1.s3-accelerate.amazonaws.com`（美国区）
   和 `dcplatformstorageservice-prod-eu-west-1.s3.amazonaws.com`（欧洲区）。
6. **PDF 默认逐份输出、自动打包成一个 ZIP**：证书是发给个人的，文件名形如
   `TE操作培训证书_姓名.pdf`（同名重复用 `_2`、`_3` 区分，靠 `record.fileBase`）。
   多个文件必须**打成一个 ZIP 再下载**，且**不设开关**（`const shouldZip = files.length > 1;`）——
   连续触发多次下载会被浏览器拦（要用户逐次点"允许"），还得逐个确认保存位置；
   这是技术细节，不该让用户做选择。单文件不打包，省掉一次解压。
   合成一本多页 PDF 是唯一的开关（`els.pdfMergeToggle`，默认不勾），供归档用 ——
   默认值不能改成合并，客户明确不接受合订本（收件人得自己找自己那页）。
   计费差异：逐份 = N 次调用；合并 = 1 次（Adobe 按「1 事务最多 50 页」计费）。
7. **合批必须显式插分页符**（只在勾选合并时走这条路）：每份证书靠 `<w:p>` 分隔，
   但背景图是 `<wp:anchor>` 浮动对象、不贡献段落高度，所以不能指望它撑页。
   实测 15 份合批被引擎全排进一页。要在第二份起每份前面插入
   `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`。
   另外合批需要每份的 `documentXml`（由 `readZip` 取出），缺了要**明确报错**，
   不能拿 undefined 去拼、产出一份坏文档。
8. **不要给 Adobe 的请求加自定义头**（除了 `Authorization` / `Content-Type` / `X-Api-Key`）。
   浏览器对任何非简单请求头都会先发预检，预检没过就直接拦掉、请求到不了服务端。
   实测 `createpdf` 端点允许的头只有 `Authorization, Content-Type, X-Api-Key,
   User-Agent, If-Modified-Since, x-api-app-info` —— 加个看起来很无害的
   `x-request-id` 就会报 "Request header field … is not allowed by
   Access-Control-Allow-Headers"。**Node 的 fetch 不做预检，所以这类问题在 Node 侧
   探测和单元测试里全都看不见**；`lint_te_cert_cloud.js` 有一条专门核对它。

9. **AI 抽取结果必须走 `core.validateRecord`，且字段名不能自创**。
   它读的是 **`dateRaw`**（原始日期字符串），不是 `dateText`；写成后者会让**每一条**
   都报「缺少颁发日期」——看起来像"AI 没抽到日期"，实际是适配层写错了字段名。
   `cert-ai.js` 的 `normalize()` 只负责把模型输出转成 core 约定的形状，
   校验一律交给 core，绝不自己写一套（那样 AI 的结果就可能绕过校验直接生成证书）。
   这条契约有断言钉着：`test_te_cert_cloud_core.js` 的 `[6]` 节。

10. **每个云/AI 模块都要在 `index.html` 里真的加载**。
   `app.js` 里写的是 `if (!window.CertAi) return;`，漏加载 `<script>` 的后果是
   **整个面板静默不渲染**——页面上不报错，只是"那块功能不见了"。
   `lint_te_cert_cloud.js` 会核对 `window.CertX` 与 `<script src>` 是否配套。

11. **AI 提示词里绝对不能出现具体日期与机构名**（示例只能用占位符）。
   真踩过：示例里写了「〈某医院〉 2025年10月10日」，用户在文本框里写的是
   `26年1月12日`、图片上没有日期，结果模型把**示例里的日期**当成了真实信息，
   套到所有记录上，产出一批日期全错的证书。
   现在提示词里的具体值一律写成 `〈机构全称A〉`／`〈日期B〉` 这类占位符，
   `test_te_cert_cloud_core.js` 的 `[6]` 节有一条断言扫描提示词里
   是否残留 `\d{4}[-年]\d{1,2}[-月]\d{1,2}` 形态的真实日期。

12. **图文合并 = 维护一张带 `source` 列的数据表，按四步走**。
    提示词的骨架是「内部流程」那四步，改它等于改这个工具的解析行为，动手前先读完这条：
    在推理中维护一张人员数据表（`name` / `hospital` / `date` / `note` + `source`），
    `source` 标明每行来自图片还是文字，这张表是本次解析的唯一事实来源。
    顺序固定为：**① 看清结构**（不预设图片只有姓名）→ **② 解析图片填表**（逐行读全
    字段，读不到的留空）→ **③ 解析文字补到对应行**（按「明确姓名 > 分组/范围 >
    可一一对应的顺序 > 唯一且无分组迹象的全局值」匹配）→ **④ 对完整表分析后输出**
    （不许再凭印象补字段）。
    两个易错点：图片可能每行都有姓名、医院和日期，**必须逐行提取全部字段**，
    只有不属于任何人员数据行的模板/示例/往期日期才忽略，逐行数据里的日期必须读取；
    文字里出现多个候选值却判断不了归属时，图片已有值就保留原值、否则留空，并写进 `note`，
    **绝不任选一个覆盖所有人**。
    为什么要有 `source` 列：它是判断覆盖方向的依据 —— 同一行里，文字明确匹配到的字段
    覆盖图片值，文字没提到的图片字段必须保留。没有这张表，模型会退化成「先读图片、
    再拿文字整体覆盖一遍」，把局部修正扩大成整批修改。
    提示词里**只描述流程、不描述中间产物**：数据表是内部推理，输出仍然只有
    `{"records":[...],"unreadable":""}`，多一个字段 `extractRecords` 就取不到数据。
    护栏在 `test_te_cert_cloud_core.js` 的 `[6]` 节，钉住四步的顺序、`source` 列、
    「不许把表打印进 json」以及上面那两条易错点。


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

这条直接决定了两件事：换字体时要对齐的是雅黑而非思源黑体；云端转换之所以可行，
正是因为微软雅黑是 Windows 自带字体，转换引擎大概率有。

#### 二、姓名框几何模型与加宽公式

模板姓名框固定 124.5pt 宽、左右内边距各 3.6pt，36pt 字号下**只放得下 3 个字**。
文本框内文字居中，所以：

```
姓名左边缘（相对正文区） L(n) = A - 18n     n = 字数
姓名右边缘              R(n) = A + 18n
间隙到医院名             G(n) = 98 - 18n    （n=2 时 62、n=3 时 44，与实测吻合）
```

实测基准落点（页坐标，A4 横向 841.92 × 595.32 pt）：

| 锚点 | x0 | 宽度 | 距顶 | 字号 |
|---|---|---|---|---|
| 姓名（3 字） | 309.89 | 108.00 | 258.52 | 36 |
| 姓名（2 字） | 345.89 | 72.00 | 258.52 | 36 |
| 医院名（7 字） | 429.89 | 126.00 | 273.04 | 18 |
| 日期「颁发日期: …」整行 | 602.94 | 725.38−602.94 | 513.85 | 12 |

**4 字及以上必须同时加宽文本框并左移**，且加宽要**全部往左、右边缘钉死**：
右边缘往右爬会吃掉与医院名之间的间隙（3 字时间隙 16.6pt，右移 36pt 就重叠了）。
每个多出的字左移 **36pt**（一个字宽），不是半个字宽 —— 后者是"重新居中"的做法，
在这里是错的锚点。

| 姓名 | posOffsetH | extent cx | margin-left | VML width |
|---|---|---|---|---|
| 2 字 | 3145790 | 1581150 | 247.7pt | 124.5pt |
| 3 字 | 2917190 | 1581150 | 229.7pt | 124.5pt |
| 4 字 | 2459990 | 2038350 | 193.7pt | 160.5pt |

DrawingML 的 `extent cx` 与 VML 的 `width` **必须同步改**，否则会出现
「Word 里正常、WPS 里错位」——模板里有两套几何表示（`<mc:Choice>` 与
`<mc:Fallback>`）。背景图在姓名那一行横向是空白（已逐行扫描确认），加宽不会压到东西。

护栏在 `tests/test_te_cert_cloud_core.js` 的 `[1]` 节，覆盖 2/3/4/5 字 × 两个模板，
并断言「右边缘恒定」与「左边缘不越页边距」。


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
