# 操作培训证书批量填充（training-cert-batch-fill）设计文档

日期：2026-09-13
状态：已批准

## 背景与目标

把此前在桌面目录 `操作证书信息批量填充/网页端/` 下完成的静态批量导入页面，迁移进 toolbox 成为正式工具。

该页面的原始用途：操作者在浏览器本地解析 CSV/Excel，校验后批量向业务系统新增用户记录（姓名、手机号、单位名称、地址），这些用户随后用于签发操作培训证书。页面本身不含证书字段——证书不是本工具的数据，`userName`/`phone`/`unitName`/`address` 才是接口实际要求的字段。

迁移要解决的核心矛盾：**页面必须知道业务服务地址才能工作，而服务地址不能出现在公开仓库的源码里。**

## 迁移范围

只迁移网页版。原 Python CLI（`bulk_upload_users.py`）留在桌面目录作为离线备份，不进 toolbox——网页版在功能上已完全覆盖它（本地解析、校验、查重、逐条导入、结果导出）。

## 产物结构

```
toolbox/
├── index.html                                              # 修改：加导航卡片
├── README.md                                               # 修改：工具表格加一行
├── tools/training-cert-batch-fill/
│   ├── index.html                                          # 入口
│   ├── app.js                                              # 逻辑
│   ├── styles.css                                          # 样式
│   └── xlsx.full.min.js                                    # 内置 SheetJS 0.20.3（951KB）
├── tests/test_training_cert_batch_fill.py                  # 新建
└── docs/superpowers/specs/
    └── 2026-09-13-training-cert-batch-fill-design.md       # 本文档
```

保留三文件结构（而非合并为单文件）：`app.js` 有 685 行、`styles.css` 有 1088 行，合并后约 1900 行单文件可维护性明显下降。CLAUDE.md 规则 1 明确允许工具携带独立 JS/CSS 文件。

**不迁移的文件及原因：**

| 文件 | 不迁移原因 |
|------|-----------|
| `.github/workflows/deploy-pages.yml` | GitHub 只执行仓库根目录的 workflow，置于 `tools/` 下是死文件；toolbox 作为整体部署 |
| `.nojekyll` | 仅在站点根目录生效；子目录内无 `_` 前缀文件，不需要 |
| `preview-desktop.png` / `preview-mobile.png` | toolbox 的 `.gitignore` 已忽略 `*.png` |
| 工具自带的 `README.md` | 表格格式说明折入本文档；其余章节（独立部署到 GitHub Pages）因部署方式改为 toolbox 整体部署而作废 |

**绝不迁移：** `users_template.csv`、`upload_results_*.csv`。这些文件含真实医师姓名与手机号，而 toolbox 仓库是公开的。

## 脱敏清单

| 位置 | 现状 | 改为 |
|------|------|------|
| `index.html` title、meta description、h1、eyebrow | 含业务系统品牌名与「用户导入台」 | 「操作培训证书批量填充」及中性文案 |
| `index.html` brand-mark `F+` | 业务系统品牌字标 | 中性图标（证件/表格意象） |
| `index.html` favicon（内联 SVG） | 品牌字母 "F" | 中性图形 |
| `index.html` footer 里的硬编码业务地址 | 明文业务主机与端口 | 删除，改为「服务地址由使用者填写」 |
| `index.html` 账号输入框预填 | 预填真实业务账号名 | 去掉 `value`，仅保留 `placeholder` |
| `app.js` 两处 `downloadText` 文件名 | 含业务系统标识的导出文件名 | 改为按工具名命名（`training-cert-batch-fill_*`） |

配套约束：**仓库内所有被跟踪文件（含 `docs/` 与 `tests/`）都不得出现业务主机、业务账号名或业务端口。** 文档里引用这些值时一律用占位符（如 `<原业务主机>:<端口>`）。测试也不得把它们写成字符串常量——否则脱敏只做了一半，一推送即前功尽弃。
| `app.js` `API_BASE` 常量 | 硬编码业务地址 | 运行时从服务地址输入框读取 |
| `styles.css` | — | 新增 `.back-link` 与地址输入框样式 |

数据字段名（`userName`、`phone`、`unitName`、`address`）与界面列头（姓名、手机号、单位名称、地址）**保持原样**，不改用证书语义——这四项是接口实际要求的字段。

## 服务地址的运行时处理

- 输入框置于「连接系统」面板最上方，`placeholder` 为 `https://服务器地址:端口`
- 提交前校验：必须是 `http://` 或 `https://` 开头的绝对地址，否则提示且不发起请求
- 可选记住地址：`localStorage` key 为 `training-cert-batch-fill.apiBase`，**只存地址**
- 原有的「密码和令牌不写入 LocalStorage / Cookie」承诺继续成立，页面文案相应改为「仅记住服务地址」
- 地址输入框的值保存在内存状态中；登录、查重、逐条导入、401 重登全程复用同一地址
- `file://` 打开时 Chromium 可能禁用 localStorage，因此读写一律 `try/catch` 包裹，失败即退化为「不记住」，不向用户报错

## CSP 调整

```
script-src 'self'                                          收紧：不再信任 cdn.sheetjs.com
connect-src https: http://localhost:* http://127.0.0.1:*    放宽：地址运行时才确定，无法白名单
```

其余指令（`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`）不变。

**这是一次真实的防护强度取舍**：`connect-src` 从单域名放宽到任意 https 源，意味着若出现 XSS，数据外传目标不再受限。缓解依据是本页面所有动态渲染均使用 `textContent`，无 `innerHTML` 注入点。此取舍已向使用者说明并获批准。

## 内置 SheetJS

- 来源：`https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`（官方 0.20.3 构建，951,904 字节）
- 校验和：`sha256:cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`，由 `tests/test_training_cert_batch_fill.py` 断言
- 授权：SheetJS 社区版为 Apache-2.0，上游版权声明完整保留在文件首行
- 落位：`tools/training-cert-batch-fill/xlsx.full.min.js`
- 更新方式：下载同一 URL 时**必须带 `User-Agent`**（否则 403），然后同步更新上面的 sha256 与测试中的 `SHEETJS_SHA256` 常量
- `index.html` 改为 `<script defer src="./xlsx.full.min.js">`
- 收益：彻底离线可用、无第三方 CDN 依赖、`script-src` 可收紧为 `'self'`
- 代价：仓库增加约 930KB
- 原有降级逻辑保留：库未加载成功时提示「Excel 解析组件未加载，请先另存为 CSV」，CSV 功能不受影响

## 页面结构

- 顶部新增 `← 返回工具箱` 链接，指向 `../../index.html`（CLAUDE.md 规则 5）
- 沿用现有三面板布局：01 选择数据文件 / 02 连接系统 / 03 执行导入
- 「连接系统」面板顺序：服务地址 → 账号 → 密码 → 测试连接

## 首页入口（index.html）

- 导航卡片名称：操作培训证书批量填充
- 描述：本地解析 CSV/Excel，批量新增用户
- 链接：`./tools/training-cert-batch-fill/index.html`
- 图标：`&#x1F4CB;`（📋），新增 `.icon-cert` 类，配色用根 `index.html` 已定义但尚未被占用的 `--violet` / `--violet-light`（`#7c3aed` / `#ede9fe`），与现有三张卡片不撞色

## 测试（tests/test_training_cert_batch_fill.py）

沿用现有 Playwright e2e 模式：headless chromium、390x844 视口、`file://` 加载、`page.route()` 拦截并模拟 API（**不打真实接口**）。验证：

1. 页面可加载，标题非空
2. 返回链接存在，href 为 `../../index.html`，且该文件真实存在
3. CSV 解析正确：4 条记录 → 1 条合格、3 条问题，四个统计数字正确
4. 表头别名可识别（用户名 / 手机 / 单位 / 医院名称）
5. 服务地址为空时无法连接，且给出提示
6. 填写地址 + 账号 + 密码后点击连接，mock 返回令牌，状态变为「已连接」
7. 断言发往 `/api/User/InsertOrUpdateUsers` 的请求体精确等于 `{isActivate:false, userName, phone, unitName, address}`
8. 线上已存在的手机号被标记跳过，不发起新增请求
9. 桌面 1280 与手机 390 两种视口下均无横向溢出
10. 断言 localStorage 中不含密码与令牌（最多只有服务地址）

## 已知风险

1. **公开暴露面仍存在**：脱敏只是不再主动公开服务地址与账号名。页面部署在公开站点，任何访问者都能看到工具存在并尝试登录。真正的防线是账号密码强度，不是隐藏 URL。
2. **CSP 放宽**（见上）。
3. **仓库增重约 930KB**（内置 SheetJS）。
4. **地址需按环境填写一次**：可接受的操作成本，换来源码不含业务地址。

## 文件清单

| 文件 | 操作 |
|------|------|
| `tools/training-cert-batch-fill/index.html` | 新建（脱敏自桌面副本） |
| `tools/training-cert-batch-fill/app.js` | 新建（脱敏自桌面副本） |
| `tools/training-cert-batch-fill/styles.css` | 新建（脱敏 + 新增样式） |
| `tools/training-cert-batch-fill/xlsx.full.min.js` | 新建（下载官方构建） |
| `index.html` | 修改（添加导航卡片与图标样式） |
| `README.md` | 修改（工具表格加一行） |
| `tests/test_training_cert_batch_fill.py` | 新建 |
