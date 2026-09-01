# 工具箱 (Toolbox)

实用小工具集合，纯静态 HTML 页面，无需后端。

## 项目结构

```
toolbox/
├── index.html              # 工具箱首页
├── tools/                  # 各个工具，每个工具一个独立文件夹
│   ├── lung-marker/        # 支气管分段标记
│   ├── rmb-upper/          # 人民币大写转换
│   └── tax-calc/           # 税点计算器
└── tests/                  # Playwright e2e 测试
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
```

## 工具列表

| 工具 | 路径 | 说明 |
|------|------|------|
| 支气管分段标记 | `tools/lung-marker/` | 右下叶基底段顺序标记，支持后悔模式 |
| 税点计算器 | `tools/tax-calc/` | 含税金额 ÷ 税率，一键算税前与税额 |
| 人民币大写转换 | `tools/rmb-upper/` | 数字金额转大写，符合央行规范 |
