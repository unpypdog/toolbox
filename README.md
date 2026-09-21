# 工具箱 (Toolbox)

实用小工具集合，纯静态 HTML 页面，无需后端。

## 项目结构

```
toolbox/
├── index.html              # 工具箱首页
├── tools/                  # 各个工具，每个工具一个独立文件夹
│   ├── lung-marker/        # 支气管分段标记
│   ├── rmb-upper/          # 人民币大写转换
│   ├── tax-calc/           # 税点计算器
│   ├── training-cert-batch-fill/  # 操作培训证书批量填充
│   └── te-cert-generator/  # TE 培训证书批量生成
└── tests/                  # 测试
```

## 文件组织规则（开发时请遵守）

- 每个工具放在 `tools/<tool-name>/` 下，入口文件命名为 `index.html`
- 测试文件放在 `tests/` 下，命名格式 `test_<tool-name>.py`
- 首页 `index.html` 放在项目根目录
- 新增工具时：在 `tools/` 下创建文件夹 → 编写入口 `index.html` → 在根 `index.html` 添加导航卡片 → 在 `tests/` 创建测试

## 运行测试

```bash
uv sync
uv run python tests/test_toolbox.py
uv run python tests/test_lung_marker.py
uv run python tests/test_rmb_upper.py
uv run python tests/test_tax_calc.py
uv run python tests/test_training_cert_batch_fill.py

# 证书工具（纯 Node，不需要浏览器）
node tests/test_te_cert_cloud_core.js
node tests/lint_te_cert_cloud.js
```

## 工具列表

| 工具 | 路径 | 说明 |
|------|------|------|
| 支气管分段标记 | `tools/lung-marker/` | 右下叶基底段顺序标记，支持后悔模式 |
| 税点计算器 | `tools/tax-calc/` | 含税金额 ÷ 税率，一键算税前与税额 |
| 人民币大写转换 | `tools/rmb-upper/` | 数字金额转大写，符合央行规范 |
| 操作培训证书批量填充 | `tools/training-cert-batch-fill/` | 本地解析 CSV/Excel，批量新增用户 |
| TE 培训证书批量生成 | `tools/te-cert-generator/` | 输入名单即可出证书，本地生成 DOCX，可选云转 PDF |

### TE 培训证书批量生成

填写形如 `靳睿、耿楠、芮法娟、倪文婧 南京鼓楼医院 25年10月10日` 的名单，
解析成可编辑表格，逐条核对后生成证书。

- **DOCX / ZIP**：完全在本机浏览器里生成，不发任何网络请求
- **PDF**：浏览器做不好 DOCX 排版（中文字体嵌入是深水区），所以交给用户自选的
  云转换服务。多份证书会先拼成**一份多页 DOCX**，一次请求换回**一份多页 PDF**。
  API 密钥只存在本机 localStorage，默认值是"不转换"，不选服务商就不会联网。

#### 服务商状态

| 服务商 | 状态 | 说明 |
|---|---|---|
| **ConvertAPI** | ✅ 已端到端验证 | 推荐首选。单次 POST、Bearer 头，250 次/月 |
| Adobe PDF Services | ⚠️ 已实现，未跑通 | 令牌与各步请求头已对齐官方文档，但完整流程未经真实凭据验证 |
| CloudConvert | ⚠️ 已实现，未验证 | 下载地址是服务端返回的动态 URL，可能受 CSP 白名单影响 |

#### 用之前先看

- **必须用 http(s) 打开**，不能双击 HTML。`file://` 的 origin 是不透明的 `null`，
  云转换的跨域请求会被浏览器拦下（报错还很有误导性）。本地起服务：

  ```powershell
  cd <项目根目录>
  python -m http.server 8000
  # 打开 http://127.0.0.1:8000/tools/te-cert-generator/index.html
  ```

- **DOCX 生成不受影响**，`file://` 下照常可用（模板走 base64 载荷）。

修改工具前请先读 `CLAUDE.md` 里这个工具的六条硬约束 —— 全部是踩过的坑，
包括模板载荷同步、CSP 白名单、Adobe 专属令牌端点、预检请求头限制、合批分页符。


