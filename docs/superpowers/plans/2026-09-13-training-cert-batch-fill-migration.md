# 操作培训证书批量填充迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面目录 `操作证书信息批量填充/网页端/` 下的静态批量导入页面迁移进 toolbox 成为正式工具 `tools/training-cert-batch-fill/`，并完成脱敏。

**Architecture:** 保留原三文件结构（`index.html` + `app.js` + `styles.css`），外加内置的 SheetJS。唯一的结构性改造是把硬编码的 `API_BASE` 常量换成运行时从输入框读取、可选用 localStorage 记住的服务地址，从而让公开仓库的源码里不含任何业务地址和账号名。

**Tech Stack:** Plain HTML/CSS/JS（零构建）、内置 SheetJS 0.20.3、Playwright (Python) e2e 测试、GitHub Pages。

**源文件位置（只读，不修改）：** `C:\Users\unpyp\Desktop\work\project\操作证书信息批量填充\网页端\`

**目标仓库：** `D:\project\toolbox`（公开仓库，分支 `master`）

---

### Task 1: 内置 SheetJS 库文件

**Files:**
- Create: `tools/training-cert-batch-fill/xlsx.full.min.js`

- [ ] **Step 1: 创建工具目录**

```powershell
New-Item -ItemType Directory -Force "D:\project\toolbox\tools\training-cert-batch-fill"
```

- [ ] **Step 2: 下载官方 SheetJS 0.20.3 构建**

注意必须带 `User-Agent`，否则 cdn.sheetjs.com 返回 403。

```powershell
$url = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
$out = "D:\project\toolbox\tools\training-cert-batch-fill\xlsx.full.min.js"
Invoke-WebRequest -Uri $url -OutFile $out -UserAgent "Mozilla/5.0" -Headers @{ Referer = "https://cdn.sheetjs.com/" }
```

- [ ] **Step 3: 校验文件正确**

```powershell
$f = "D:\project\toolbox\tools\training-cert-batch-fill\xlsx.full.min.js"
(Get-Item $f).Length
Get-Content $f -TotalCount 1
```

Expected: 长度 `951904`；首行为 `/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */`

若长度或首行不符，说明拿到的是错误页面而非库文件，停止并排查。

- [ ] **Step 4: Commit**

```bash
cd /d/project/toolbox
git add tools/training-cert-batch-fill/xlsx.full.min.js
git commit -m "chore: 内置 SheetJS 0.20.3 到 training-cert-batch-fill"
```

---

### Task 2: 写失败的工具页 e2e 测试（TDD RED）

本任务先写完整测试，此时工具页尚不存在，测试必定失败——这是有意为之的 RED。

**Files:**
- Create: `tests/test_training_cert_batch_fill.py`

- [ ] **Step 1: 写测试文件**

沿用 `tests/test_tax_calc.py` 的既有模式（模块 docstring、`run()`、`errors` 列表、`[OK]` 打印、失败 `raise SystemExit(1)`）。

```python
"""Test the training certificate batch fill page."""
import base64
import hashlib
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT_ROOT = Path(__file__).parent.parent
TOOL_DIR = PROJECT_ROOT / "tools" / "training-cert-batch-fill"
FILE_URL = f"file:///{TOOL_DIR / 'index.html'}"

SHEETJS_SHA256 = "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41"

API_BASE = "https://api.example.test:8443"

# 工具源码允许出现的外部主机：SVG 命名空间，以及 CSP 里的回环地址。
# 任何其他主机都意味着业务地址被写死进了公开仓库。
ALLOWED_HOSTS = {"www.w3.org", "localhost", "127.0.0.1"}
HOST_RE = re.compile(r"https?://([A-Za-z0-9._-]+)")

EXISTING_PHONE = "13700137000"
PASSWORD = "secret-value"

FIXTURE_CSV = (
    "姓名,手机号,单位名称,地址\n"
    "张三,13800138000,示例医院,北京市海淀区示例路1号\n"
    "李四,12000000000,示例医院,\n"
    "王五,13900139000,,上海市\n"
    "赵六,13800138000,另一家医院,广州市\n"
    "孙七,13700137000,第二医院,杭州市\n"
)

ALIAS_CSV = (
    "用户名,手机,医院名称,详细地址\n"
    "周八,13600136000,第三医院,成都市\n"
)

EXPECTED_PAYLOAD = {
    "isActivate": False,
    "userName": "张三",
    "phone": "13800138000",
    "unitName": "示例医院",
    "address": "北京市海淀区示例路1号",
}


def csv_upload(name, content):
    return {"name": name, "mimeType": "text/csv", "buffer": content.encode("utf-8")}


def mock_api(page, insert_payloads):
    """拦截并模拟业务接口，测试全程不打真实服务。"""

    def handle(route):
        url = route.request.url
        if url.endswith("/api/Login/login"):
            route.fulfill(json={
                "success": True,
                "message": "登录成功",
                "data": {"isEnable": True, "tokenRes": {"accessToken": "mock-token"}},
            })
        elif "/api/User/QueryUsers" in url:
            route.fulfill(json={
                "success": True,
                "total": 1,
                "data": [{"phone": EXISTING_PHONE}],
            })
        elif url.endswith("/api/User/InsertOrUpdateUsers"):
            insert_payloads.append(route.request.post_data_json)
            route.fulfill(json={"success": True, "message": "完善成功"})
        else:
            route.fulfill(status=404, json={"success": False, "message": "unexpected"})

    page.route(f"{API_BASE}/**", handle)


def overflow_px(page):
    return page.evaluate(
        "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
    )


EXPECTED_TITLE = "操作培训证书批量填充"

REQUIRED_IDS = (
    "fileInput", "apiBaseInput", "usernameInput", "passwordInput", "connectBtn",
    "connectionPill", "startImportBtn", "confirmCheckbox", "confirmImportBtn",
    "exportBtn", "previewBody", "statTotal", "statReady", "statProblem",
)


def run():
    missing = []
    if not (TOOL_DIR / "index.html").is_file():
        missing.append("tools/training-cert-batch-fill/index.html")
    if not (TOOL_DIR / "app.js").is_file():
        missing.append("tools/training-cert-batch-fill/app.js")
    if missing:
        print("FAIL: not yet created — " + ", ".join(missing))
        raise SystemExit(1)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.goto(FILE_URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        errors = []
        insert_payloads = []

        # Test 0: 关键元素齐全——避免后续断言退化成 30 秒超时
        absent = [fid for fid in REQUIRED_IDS if page.locator(f"#{fid}").count() != 1]
        if absent:
            errors.append(f"Missing required elements: {', '.join(absent)}")
            print(f"\n=== {len(errors)} ERROR(S) ===")
            for e in errors:
                print(f"  FAIL: {e}")
            browser.close()
            raise SystemExit(1)
        print(f"[OK] All {len(REQUIRED_IDS)} required elements present")

        # Test 1: 页面标题
        title = page.title()
        if title != EXPECTED_TITLE:
            errors.append(f"Page title expected '{EXPECTED_TITLE}', got '{title}'")
        else:
            print(f"[OK] Page title: {title}")

        # Test 2: 返回链接
        back_link = page.locator("a.back-link")
        if back_link.count() != 1:
            errors.append("Back link a.back-link not found")
        else:
            href = back_link.get_attribute("href")
            if href != "../../index.html":
                errors.append(f"Back link href expected '../../index.html', got '{href}'")
            elif not (PROJECT_ROOT / "index.html").is_file():
                errors.append("Back link target ../../index.html does not exist on disk")
            else:
                print(f"[OK] Back link: {href}")

        # Test 3: 工具源码不含任何外部主机
        # 正向断言而非黑名单：写死业务地址、又或者将来换了个新地址，
        # 都会在这里暴露，不必事先知道具体主机名。
        leaks = []
        for name in ("index.html", "app.js", "styles.css"):
            source_path = TOOL_DIR / name
            if not source_path.is_file():
                errors.append(f"{name} missing; host scan skipped")
                continue
            for host in HOST_RE.findall(source_path.read_text(encoding="utf-8")):
                if host not in ALLOWED_HOSTS:
                    leaks.append(f"{name} references external host '{host}'")
        if leaks:
            errors.extend(leaks)
        else:
            print("[OK] No external host references in the tool sources")

        # Test 4: SheetJS 已内置且与锁定的官方构建逐字节一致
        xlsx_path = TOOL_DIR / "xlsx.full.min.js"
        if not xlsx_path.is_file():
            errors.append("xlsx.full.min.js is not vendored into the tool folder")
        else:
            digest = hashlib.sha256(xlsx_path.read_bytes()).hexdigest()
            if digest != SHEETJS_SHA256:
                errors.append(
                    f"Vendored SheetJS checksum mismatch: got {digest}, "
                    f"expected {SHEETJS_SHA256}"
                )
            else:
                print("[OK] SheetJS vendored and checksum matches the pinned build")

        # Test 5: CSP 收紧脚本源、仅在 connect 上放宽
        csp = page.locator("meta[http-equiv='Content-Security-Policy']").get_attribute("content") or ""
        if "script-src 'self'" not in csp or "cdn.sheetjs.com" in csp:
            errors.append(f"CSP script-src not tightened to 'self': {csp}")
        elif "connect-src https:" not in csp:
            errors.append(f"CSP connect-src lacks https: allowance: {csp}")
        else:
            print("[OK] CSP narrowed for scripts, relaxed for connect only")

        # Test 6: 账号框无预填
        if page.locator("#usernameInput").input_value():
            errors.append("Username input is prefilled")
        else:
            print("[OK] Username input not prefilled")

        # Test 7: CSV 解析与本地校验
        page.set_input_files("#fileInput", csv_upload("fixture.csv", FIXTURE_CSV))
        page.wait_for_timeout(500)
        for selector, want in (("#statTotal", "5"), ("#statReady", "2"), ("#statProblem", "3")):
            got = page.locator(selector).inner_text().strip()
            if got != want:
                errors.append(f"{selector} expected {want}, got {got}")
            else:
                print(f"[OK] {selector} = {got}")

        # Test 8: 空服务地址不能连接
        page.fill("#apiBaseInput", "")
        page.fill("#usernameInput", "tester")
        page.fill("#passwordInput", PASSWORD)
        page.click("#connectBtn")
        page.wait_for_timeout(400)
        if page.locator("#connectionPill").get_attribute("data-state") != "error":
            errors.append("Empty service address did not put the pill into error state")
        else:
            print("[OK] Empty service address rejected")

        # Test 9: 非法服务地址被拒
        page.fill("#apiBaseInput", "not-a-url")
        page.click("#connectBtn")
        page.wait_for_timeout(400)
        if page.locator("#connectionPill").get_attribute("data-state") != "error":
            errors.append("Malformed service address was accepted")
        else:
            print("[OK] Malformed service address rejected")

        # Test 10: 合法地址连接成功
        mock_api(page, insert_payloads)
        page.fill("#apiBaseInput", API_BASE)
        page.click("#connectBtn")
        page.wait_for_timeout(600)
        if page.locator("#connectionPill").get_attribute("data-state") != "connected":
            errors.append("Connect with a valid address did not reach connected state")
        else:
            print("[OK] Connected using the runtime service address")

        # Test 11: 导入流程——跳过已有手机号，且请求体精确匹配契约
        page.click("#startImportBtn")
        page.wait_for_timeout(300)
        page.check("#confirmCheckbox")
        page.click("#confirmImportBtn")
        page.wait_for_function(
            "() => !document.querySelector('#exportBtn').disabled", timeout=20000
        )
        page.wait_for_timeout(300)

        if insert_payloads != [EXPECTED_PAYLOAD]:
            errors.append(f"Insert payload mismatch: {insert_payloads}")
        else:
            print("[OK] Insert payload matches the API contract exactly")

        skipped = page.locator("#previewBody .status-badge--existing").count()
        if skipped != 1:
            errors.append(f"Expected 1 skipped existing phone, got {skipped}")
        else:
            print("[OK] Existing phone skipped without an insert request")

        # Test 12: 凭据不落盘
        stored = page.evaluate("""() => {
          const out = [];
          try {
            for (let i = 0; i < window.localStorage.length; i += 1) {
              const key = window.localStorage.key(i);
              out.push(key + "=" + window.localStorage.getItem(key));
            }
          } catch (error) {
            return "__unavailable__";
          }
          return out.join(";");
        }""")
        if stored == "__unavailable__":
            errors.append(
                "localStorage unreadable: address persistence and credential checks unverified"
            )
        elif PASSWORD in stored or "mock-token" in stored:
            errors.append(f"Credential leaked into localStorage: {stored}")
        elif f"training-cert-batch-fill.apiBase={API_BASE}" not in stored:
            errors.append(f"Service address was not remembered: {stored or '(empty)'}")
        else:
            print(f"[OK] Service address remembered, no credential stored: {stored}")

        # Test 12b: 新开页面时地址自动回填（同 origin 共享 localStorage）
        restored = context.new_page()
        restored.goto(FILE_URL)
        restored.wait_for_load_state("networkidle")
        restored.wait_for_timeout(400)
        if restored.locator("#apiBaseInput").input_value() != API_BASE:
            errors.append("Remembered service address was not restored on a fresh page")
        else:
            print("[OK] Remembered service address restored on a fresh page")
        restored.close()

        # Test 13: 桌面无横向溢出
        desktop_overflow = overflow_px(page)
        if desktop_overflow > 1:
            errors.append(f"Desktop horizontal overflow: {desktop_overflow}px")
        else:
            print("[OK] No horizontal overflow on desktop 1280")

        # Test 14: 手机视口无横向溢出（加载文件以覆盖表格场景）
        mobile = browser.new_context(
            viewport={"width": 390, "height": 844}, device_scale_factor=3
        )
        mobile_page = mobile.new_page()
        mobile_page.goto(FILE_URL)
        mobile_page.wait_for_load_state("networkidle")
        mobile_page.wait_for_timeout(300)
        mobile_page.set_input_files("#fileInput", csv_upload("fixture.csv", FIXTURE_CSV))
        mobile_page.wait_for_timeout(500)
        mobile_rows = mobile_page.locator("#previewBody tr").count()
        mobile_overflow = overflow_px(mobile_page)
        if mobile_rows != 5:
            errors.append(f"Mobile page did not render the table: {mobile_rows} rows")
        elif mobile_overflow > 1:
            errors.append(f"Mobile horizontal overflow: {mobile_overflow}px")
        else:
            print("[OK] No horizontal overflow on mobile 390 with the table rendered")

        # Test 14b: 390px 下 h1 必须单行
        # 折行不会产生横向溢出，overflow 断言查不出来，只能数行盒。
        # 用 Range.getClientRects() 去重纵向坐标，而不是拿高度除以行高
        # ——后者依赖 line-height: normal 的字体度量，换台机器就不准。
        heading_lines = mobile_page.evaluate("""() => {
          const h1 = document.querySelector('.brand-copy h1');
          const range = document.createRange();
          range.selectNodeContents(h1);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.y))).size;
        }""")
        if heading_lines != 1:
            errors.append(f"h1 wraps to {heading_lines} lines at 390px (orphan check)")
        else:
            print("[OK] h1 stays on one line at 390px")
        mobile.close()

        # Test 15: 表头别名可识别
        alias_page = context.new_page()
        alias_page.goto(FILE_URL)
        alias_page.wait_for_load_state("networkidle")
        alias_page.wait_for_timeout(300)
        alias_page.set_input_files("#fileInput", csv_upload("alias.csv", ALIAS_CSV))
        alias_page.wait_for_timeout(500)
        total = alias_page.locator("#statTotal").inner_text().strip()
        ready = alias_page.locator("#statReady").inner_text().strip()
        if total != "1" or ready != "1":
            errors.append(f"Header aliases not recognised: total={total} ready={ready}")
        else:
            print("[OK] Header aliases recognised")
        alias_page.close()

        # Test 16: Excel 解析（用页面内置 SheetJS 生成样本，验证离线可用）
        # 这是内置 SheetJS 的核心收益：不再依赖 CDN，断网也能解析 xlsx。
        xlsx_b64 = page.evaluate("""() => {
          const rows = [
            ["姓名", "手机号", "单位名称", "地址"],
            ["钱九", "13500135000", "第四医院", "南京市"],
          ];
          const sheet = XLSX.utils.aoa_to_sheet(rows);
          const book = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
          return XLSX.write(book, { type: "base64", bookType: "xlsx" });
        }""")
        if not xlsx_b64:
            errors.append("Vendored SheetJS failed to build a sample workbook")
        else:
            xlsx_page = context.new_page()
            xlsx_page.goto(FILE_URL)
            xlsx_page.wait_for_load_state("networkidle")
            xlsx_page.wait_for_timeout(400)
            xlsx_page.set_input_files("#fileInput", {
                "name": "fixture.xlsx",
                "mimeType": (
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                "buffer": base64.b64decode(xlsx_b64),
            })
            xlsx_page.wait_for_timeout(800)
            xlsx_total = xlsx_page.locator("#statTotal").inner_text().strip()
            xlsx_ready = xlsx_page.locator("#statReady").inner_text().strip()
            if xlsx_total != "1" or xlsx_ready != "1":
                errors.append(
                    f"XLSX parsing failed: total={xlsx_total} ready={xlsx_ready}"
                )
            else:
                print("[OK] XLSX parsed offline through the vendored SheetJS")
            xlsx_page.close()

        if errors:
            print(f"\n=== {len(errors)} ERROR(S) ===")
            for e in errors:
                print(f"  FAIL: {e}")
            browser.close()
            raise SystemExit(1)
        else:
            print("\n=== ALL TESTS PASSED ===")
            browser.close()


if __name__ == "__main__":
    run()
```

- [ ] **Step 2: 运行测试确认失败（RED）**

```powershell
cd D:\project\toolbox
uv run python tests/test_training_cert_batch_fill.py
```

Expected: 失败，且输出首行为：

```
FAIL: not yet created — tools/training-cert-batch-fill/index.html, tools/training-cert-batch-fill/app.js
```

退出码 1。（`run()` 开头的守卫就是为此而加：否则 `page.goto` 会直接抛 Playwright 异常，看不出是预期中的 RED 还是测试本身写错了。）

- [ ] **Step 3: Commit（TDD RED）**

```bash
cd /d/project/toolbox
git add tests/test_training_cert_batch_fill.py
git commit -m "Add failing training-cert-batch-fill tests (TDD RED)"
```

---

### Task 3: 迁移并脱敏 index.html

**Files:**
- Create: `tools/training-cert-batch-fill/index.html`（源：`网页端/index.html`）

- [ ] **Step 1: 复制源文件到工具目录**

```powershell
$src = "C:\Users\unpyp\Desktop\work\project\操作证书信息批量填充\网页端\index.html"
$dst = "D:\project\toolbox\tools\training-cert-batch-fill\index.html"
Copy-Item $src $dst -Force
```

- [ ] **Step 2: 替换 CSP**

把 `<meta http-equiv="Content-Security-Policy" ...>` 的 `content` 整段替换为：

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self'
```

- [ ] **Step 3: 替换 title 与 description**

title 改为 `操作培训证书批量填充`。

description 的 `content` 改为 `在浏览器本地解析 CSV 或 Excel，并批量新增用户。`

- [ ] **Step 4: 替换 favicon**

把整个 `<link rel="icon" ...>` 的 href 换为下面这段中性图形（与原文同样的 `%3C`/`%3E`/`%23` 编码风格）：

```
data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230c1822'/%3E%3Crect x='18' y='12' width='28' height='40' rx='3' fill='none' stroke='%235ce1c5' stroke-width='4'/%3E%3Cpath d='M24 26h16M24 34h16M24 42h10' stroke='%235ce1c5' stroke-width='3.5' stroke-linecap='round'/%3E%3Ccircle cx='47' cy='50' r='5' fill='%23ff8b5d'/%3E%3C/svg%3E
```

- [ ] **Step 5: SheetJS 改引本地文件**

把这段：

```html
    <script
      defer
      src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
    ></script>
```

改为：

```html
    <script defer src="./xlsx.full.min.js"></script>
```

- [ ] **Step 6: 中性化品牌字标**

把 `<div class="brand-mark" aria-hidden="true">F<span>+</span></div>` 改为：

```html
      <div class="brand-mark" aria-hidden="true">证</div>
```

- [ ] **Step 7: 加返回链接并改写标题文案**

把 brand-copy 整段：

```html
      <div class="brand-copy">
        <p class="eyebrow"><原业务系统标识> · DATA OPERATIONS</p>
        <h1>用户导入台</h1>
      </div>
```

改为：

```html
      <div class="brand-copy">
        <a class="back-link" href="../../index.html">&#x2190; 返回工具箱</a>
        <p class="eyebrow">CERT DATA OPERATIONS</p>
        <h1>操作培训证书批量填充</h1>
      </div>
```

- [ ] **Step 8: 加服务地址输入框**

在 `<form id="loginForm" class="login-form">` 内、账号 label **之前**插入：

```html
            <label>
              <span>服务地址</span>
              <input
                id="apiBaseInput"
                name="apiBase"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://服务器地址:端口"
              />
            </label>
```

（`.login-form input` 已有通用样式，无需新增 CSS。）

**这里不要加 `required`，也不要给 `<form>` 加 `novalidate`。** 加 `required` 会让浏览器原生约束校验在地址为空时直接吞掉 submit 事件——`app.js` 绑在 form 的 `submit` 上，于是 `normalizeApiBase` 永远不执行，`setConnection("error", …)` 也不执行，Test 8 必然失败。空地址的拒绝逻辑由 JS 校验负责，这是设计意图。

- [ ] **Step 9: 去掉账号预填**

把账号 input 预填的 `value="<原业务账号>"` 删掉并加 placeholder：

```html
              <input id="usernameInput" name="username" autocomplete="username" placeholder="登录账号" required />
```

- [ ] **Step 10: 改写安全说明文案**

把 `<p class="security-note">` 内容改为：

```
服务地址会保存在本机浏览器；密码和令牌不会写入 LocalStorage、Cookie 或仓库，刷新页面即清除。
```

- [ ] **Step 11: 改写 footer**

把 footer 整段：

```html
    <footer>
      <span>STATIC CLIENT / GITHUB PAGES READY</span>
      <span>API · <原业务地址></span>
    </footer>
```

改为：

```html
    <footer>
      <span>STATIC CLIENT / 服务地址由使用者填写</span>
      <span>数据仅在本机浏览器解析</span>
    </footer>
```

- [ ] **Step 12: 确认没有遗漏的敏感字符串**

```powershell
Select-String -Path "D:\project\toolbox\tools\training-cert-batch-fill\index.html" -Pattern "https?://" -CaseSensitive:$false
```

Expected: 只出现三处，且都不是业务主机——SVG 命名空间 `http://www.w3.org`，以及 CSP 里的 `http://localhost:*` 与 `http://127.0.0.1:*`。若出现第四处，说明有外部资源或业务地址残留。

- [ ] **Step 13: Commit**

```bash
cd /d/project/toolbox
git add tools/training-cert-batch-fill/index.html
git commit -m "feat: 迁移并脱敏 training-cert-batch-fill 页面结构"
```

（此时页面还跑不起来——`app.js` 与 `styles.css` 尚未迁入，e2e 测试的守卫仍会报 not yet created，属预期。）

---

### Task 4: 迁移 app.js，API 地址改为运行时配置

**Files:**
- Create: `tools/training-cert-batch-fill/app.js`（源：`网页端/app.js`）

- [ ] **Step 1: 复制源文件**

```powershell
$src = "C:\Users\unpyp\Desktop\work\project\操作证书信息批量填充\网页端\app.js"
$dst = "D:\project\toolbox\tools\training-cert-batch-fill\app.js"
Copy-Item $src $dst -Force
```

- [ ] **Step 2: 常量换成存储键**

把：

```js
const API_BASE = "https://<原业务主机>:<端口>";
```

改为：

```js
const API_BASE_STORAGE_KEY = "training-cert-batch-fill.apiBase";
```

- [ ] **Step 3: state 增加 apiBase**

把：

```js
const state = {
  file: null,
  records: [],
  connected: false,
  token: "",
```

改为：

```js
const state = {
  file: null,
  records: [],
  apiBase: "",
  connected: false,
  token: "",
```

- [ ] **Step 4: 注册新元素 id**

在 `DOMContentLoaded` 的 id 数组里，把 `"loginForm", "usernameInput", "passwordInput", "togglePasswordBtn", "connectBtn",` 一行改为：

```js
    "loginForm", "apiBaseInput", "usernameInput", "passwordInput", "togglePasswordBtn", "connectBtn",
```

- [ ] **Step 5: 加载时回填已记住的地址**

在 `DOMContentLoaded` 回调里，把：

```js
  bindEvents();
  render();
```

改为：

```js
  bindEvents();
  els.apiBaseInput.value = readStoredApiBase();
  render();
```

- [ ] **Step 6: 新增三个地址相关函数**

插入到 `async function connect(` 之前：

```js
function readStoredApiBase() {
  try {
    return window.localStorage.getItem(API_BASE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeApiBase(value) {
  try {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, value);
  } catch {
    // file:// 或隐私模式下 localStorage 不可用，退化为不记住
  }
}

function normalizeApiBase(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("请先填写服务地址。");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("服务地址格式不正确，需形如 https://服务器地址:端口");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("服务地址必须以 http:// 或 https:// 开头。");
  }
  // 页面的 CSP 只对回环地址放开明文 http，其他 http 会被浏览器直接拦掉。
  // 在这里提前拒绝并说明原因，免得用户只看到一句无从下手的 Failed to fetch。
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("明文 http 仅允许 localhost 或 127.0.0.1，其他地址请使用 https://。");
  }
  // 只接受「主机 + 端口」。带路径或参数会静默改变请求目标（拼出来是 /api/api/Login/login
  // 或 ?tenant=1/api/Login/login），带 userinfo 的还会把凭据写进 localStorage，
  // 直接违背「密码和令牌不落盘」的承诺——必须挡在存储之前。
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("请填接口地址，只到主机和端口。浏览器地址栏里的登录页地址不能直接用：它带路径，端口也常和接口不同。");
  }
  return value;
}
```

- [ ] **Step 7: connect() 开头校验并记住地址**

把：

```js
async function connect({ quiet = false } = {}) {
  const username = els.usernameInput.value.trim();
```

改为：

```js
async function connect({ quiet = false } = {}) {
  let apiBase;
  try {
    apiBase = normalizeApiBase(els.apiBaseInput.value);
  } catch (error) {
    // 地址一旦非法，之前的连接就不再可信：若只改提示而不清会话，
    // 连接状态会停留在 true，「开始导入」按钮仍可点，点下去会往
    // 上一个地址写入——UI 在撒谎，而且写错了地方。
    state.connected = false;
    state.token = "";
    setConnection("error", "地址无效");
    updateActionState();
    if (!quiet) showToast(error.message, "error");
    throw error;
  }
  state.apiBase = apiBase;
  storeApiBase(apiBase);

  const username = els.usernameInput.value.trim();
```

- [ ] **Step 8: 让请求使用运行时地址**

把：

```js
    const response = await fetch(`${API_BASE}${path}`, {
```

改为：

```js
    const response = await fetch(`${state.apiBase}${path}`, {
```

- [ ] **Step 8b: 改掉两个导出文件名**

`app.js` 里有两处导出文件名带着**业务系统标识前缀**，必须一并改掉。Test 3 的主机扫描查不出它们（文件名里没有主机名），但工具会把业务标识写进用户下载的文件名，这两处在原计划里被漏掉了。

这两处分别在 `downloadTemplate()` 与 `exportResults()` 中（搜 `downloadText(` 即可定位，文件里只有这两个调用点）。把两处的文件名前缀统一改为 `training-cert-batch-fill_`，即：

```js
    "training-cert-batch-fill_template.csv",
```

```js
    `training-cert-batch-fill_result_${stamp}.csv`,
```

（后缀 `_template.csv` / `_result_<时间戳>.csv` 保持不变。）

- [ ] **Step 9: 确认没有遗漏的常量引用与敏感字符串**

```powershell
Select-String -Path "D:\project\toolbox\tools\training-cert-batch-fill\app.js" -Pattern "https?://[A-Za-z0-9]|API_BASE\b(?!_)|业务系统|业务账号"
```

Expected: 无输出。

用 `https?://[A-Za-z0-9]` 而不是裸的 `https?://`：Step 6 的三条错误提示文案里写着「形如 https://服务器地址:端口」「必须以 http:// 或 https:// 开头」，这些是给人看的说明文字，竖线后面跟的是中文或空格，不会命中；而任何真实写成 `https://某主机` 的残留都会命中。这也正是 e2e 测试里 `HOST_RE` 的判定口径。

`API_BASE\b(?!_)` 会放过 `API_BASE_STORAGE_KEY`，命中其他 `API_BASE` 用法即为漏改。若这个 PowerShell 版本不支持负向先行断言，改用手工确认：该文件里 `API_BASE` 只应出现在 `API_BASE_STORAGE_KEY` 这一个标识符中。

- [ ] **Step 10: 语法检查**

```powershell
node --check "D:\project\toolbox\tools\training-cert-batch-fill\app.js"
```

Expected: 无输出（退出码 0）。

- [ ] **Step 11: Commit**

```bash
cd /d/project/toolbox
git add tools/training-cert-batch-fill/app.js
git commit -m "feat: 服务地址改为运行时填写，去掉硬编码业务地址"
```

---

### Task 5: 迁移 styles.css 并新增返回链接样式

**Files:**
- Create: `tools/training-cert-batch-fill/styles.css`（源：`网页端/styles.css`）

- [ ] **Step 1: 复制源文件**

```powershell
$src = "C:\Users\unpyp\Desktop\work\project\操作证书信息批量填充\网页端\styles.css"
$dst = "D:\project\toolbox\tools\training-cert-batch-fill\styles.css"
Copy-Item $src $dst -Force
```

- [ ] **Step 2: 加返回链接样式**

在 `.brand-mark span { ... }` 规则块之后插入：

```css
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: rgba(255, 255, 255, 0.72);
  text-decoration: none;
  font-size: 0.8rem;
  font-weight: 600;
  transition: color 0.2s;
}

.back-link:active,
.back-link:hover {
  color: var(--mint);
}
```

颜色用浅色是因为返回链接位于深色 `.masthead` 内；其余样式（表格 `min-width: 840px`、`[hidden]` 全局规则、移动端媒体查询）沿用源文件，**不要改动**——这两条是上一轮修复过的移动端与隐藏态问题。

- [ ] **Step 2b: 修 h1 在 390px 下的孤字折行**

标题从 4 个字（用户导入台）变成 10 个字（操作培训证书批量填充）后，在 390px 视口下会差约 1.1px 折成「9 字 + 孤零零一个『充』」。这不是溢出，`overflow` 断言看不见它，只有截图能发现。

现有 `h1` 规则是 `font-size: clamp(1.65rem, 3vw, 2.4rem)`，390px 时落到下限 1.65rem（26.4px），加上 `letter-spacing: 0.08em` 共约 285px，而可用宽度是 284px。

在文件末尾的媒体查询区域追加：

```css
@media (max-width: 430px) {
  .brand-copy h1 {
    font-size: clamp(1.35rem, 6.2vw, 1.65rem);
    text-wrap: balance;
  }
}
```

390px 时字号约 24.2px，标题约 261px，单行放得下；320px 时仍会折行，`text-wrap: balance` 让它折成 5+5 而不是留一个孤字。

- [ ] **Step 2c: 清掉只为 `F+` 字标存在的死样式**

字标已从 `F+` 变成单个 `证`，以下两条规则失去意义：

- `.brand-mark span { color: var(--orange); font-size: 0.75em; }` —— 整条删除（页面里已无 `.brand-mark span`）
- `.brand-mark` 里的 `letter-spacing: -0.1em;` —— 删除。它原本是把 `+` 往 `F` 上收，对单个 CJK 字形只会让字略偏左

`.brand-mark` 的 `font-size: 2rem` 保留即可（实测 `证` 在 64px 框内宽约 29px，居中正常）。

- [ ] **Step 3: 确认无敏感字符串**

```powershell
Select-String -Path "D:\project\toolbox\tools\training-cert-batch-fill\styles.css" -Pattern "https?://" -CaseSensitive:$false
```

Expected: 无输出。

- [ ] **Step 4: Commit**

```bash
cd /d/project/toolbox
git add tools/training-cert-batch-fill/styles.css
git commit -m "feat: 新增返回工具箱链接样式"
```

---

### Task 6: 跑通工具页全部测试

**Files:**
- Modify: `tests/test_training_cert_batch_fill.py`
- 其余为验证 Task 1–5 的产物

- [ ] **Step 0: 补一条 h1 单行断言**

Task 5 修掉的「390px 标题折成 9 字 + 孤字」是**没有任何断言覆盖**的——它折行而非溢出，`overflow` 检查看不见。代码质量审查实测确认：漏掉的那 1.1px 只能靠数行盒发现，且该断言在旧 CSS 上会返回 2（即确实能抓到回归）。

在手机视口那段（`mobile_rows` / `mobile_overflow` 判断之后、`mobile.close()` 之前）插入：

```python
        # Test 14b: 390px 下 h1 必须单行
        # 折行不会产生横向溢出，overflow 断言查不出来，只能数行盒。
        # 用 Range.getClientRects() 去重纵向坐标，而不是拿高度除以行高
        # ——后者依赖 line-height: normal 的字体度量，换台机器就不准。
        heading_lines = mobile_page.evaluate("""() => {
          const h1 = document.querySelector('.brand-copy h1');
          const range = document.createRange();
          range.selectNodeContents(h1);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.y))).size;
        }""")
        if heading_lines != 1:
            errors.append(f"h1 wraps to {heading_lines} lines at 390px (orphan check)")
        else:
            print("[OK] h1 stays on one line at 390px")
```

不要用 `height / line-height` 来判断行数：`line-height: normal` 时行高由字体度量决定，换台机器结果就变了。不要断言 340px 附近的换行边界，那里只差 0.72px，本身就会随字体浮动——要断就断 390px。

- [ ] **Step 1: 运行测试**

```powershell
cd D:\project\toolbox
uv run python tests/test_training_cert_batch_fill.py
```

Expected:
```
[OK] All 14 required elements present
[OK] Page title: 操作培训证书批量填充
[OK] Back link: ../../index.html
[OK] No external host references in the tool sources
[OK] SheetJS vendored and checksum matches the pinned build
[OK] CSP narrowed for scripts, relaxed for connect only
[OK] Username input not prefilled
[OK] #statTotal = 5
[OK] #statReady = 2
[OK] #statProblem = 3
[OK] Empty service address rejected
[OK] Malformed service address rejected
[OK] Connected using the runtime service address
[OK] Insert payload matches the API contract exactly
[OK] Existing phone skipped without an insert request
[OK] Service address remembered, no credential stored: training-cert-batch-fill.apiBase=https://api.example.test:8443
[OK] Remembered service address restored on a fresh page
[OK] No horizontal overflow on desktop 1280
[OK] No horizontal overflow on mobile 390 with the table rendered
[OK] h1 stays on one line at 390px
[OK] Header aliases recognised
[OK] XLSX parsed offline through the vendored SheetJS

=== ALL TESTS PASSED ===
```

- [ ] **Step 2: 失败则逐一修复**

常见原因与对策：

| 现象 | 原因 | 对策 |
|---|---|---|
| `CSP script-src not tightened` | Task 3 Step 2 没生效 | 检查 meta content 是否整体替换 |
| `Insert payload mismatch` | 请求体字段名或顺序不符 | 对比 `app.js` 中 `runImport` 的 body 与 `EXPECTED_PAYLOAD` |
| `Mobile horizontal overflow` | `table { min-width: 840px }` 丢 | 确认 Task 5 Step 1 是完整复制而非重写 |
| `Empty service address rejected` 失败 | `connect()` 未在开头校验 | 检查 Task 4 Step 7 |
| `statReady`/`statProblem` 数字不符 | fixture 或被 `--skip-invalid` 类逻辑影响 | 对照 `matrixToRecords` 的校验分支 |

- [ ] **Step 3: 截图人工核对**

仅靠断言无法发现布局塌陷，必须看图确认。先把截图脚本写到仓库外的临时目录（避免污染仓库），再用 Write 工具创建文件 `C:\Users\unpyp\AppData\Local\Temp\capture_training_cert.py`：

```python
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(r"D:\project\toolbox")
URL = f"file:///{ROOT / 'tools' / 'training-cert-batch-fill' / 'index.html'}"
OUT = ROOT / "tests" / "screenshots"
CSV = (
    "姓名,手机号,单位名称,地址\n"
    "张三,13800138000,示例医院,北京市海淀区示例路1号\n"
    "李四,12000000000,示例医院,\n"
    "王五,13900139000,,上海市\n"
)

OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for label, width, height, scale in (
        ("desktop", 1280, 900, 1),
        ("mobile", 390, 844, 3),
        ("mobile-320", 320, 844, 3),
    ):
        ctx = browser.new_context(
            viewport={"width": width, "height": height}, device_scale_factor=scale
        )
        page = ctx.new_page()
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(400)
        page.set_input_files(
            "#fileInput",
            {"name": "f.csv", "mimeType": "text/csv", "buffer": CSV.encode("utf-8")},
        )
        page.wait_for_timeout(600)
        target = OUT / f"training-cert-{label}.png"
        page.screenshot(path=str(target), full_page=True)
        print(f"saved {target}")
        ctx.close()
    browser.close()
```

然后运行：

```powershell
cd D:\project\toolbox
uv run python "$env:TEMP\capture_training_cert.py"
```

Expected: 打印两行 `saved D:\project\toolbox\tests\screenshots\training-cert-desktop.png` 与 `...mobile.png`。

- [ ] **Step 4: 查看截图**

用 Read 工具打开 `tests/screenshots/training-cert-desktop.png` 与 `tests/screenshots/training-cert-mobile.png`，确认：

- 左上角有「← 返回工具箱」，且与深色顶栏对比清晰可读
- 顶栏字标是「证」，不是业务系统品牌字
- 「服务地址」输入框位于账号之上，样式与其他输入框一致
- 账号框为空（无预填）
- 统计卡片显示 3 条记录、1 合格、2 问题
- 手机版表格在容器内横向滚动，中文未被压成单字竖排
- 页面无横向溢出
- **390px 下 h1「操作培训证书批量填充」是完整一行，末字没有孤行**（这条 `overflow` 断言查不出来，只能看）
- **320px 下标题折成 5+5 两行且长度接近**，不是「9 字 + 孤字」（`text-wrap: balance` 的效果，是本次改动引入的行为，值得人眼看一次）
- **手机版顶栏高度不夸张**（实测 390px 下约 166px，占屏高不到 20%）

- [ ] **Step 5: 确认三个文件都已提交且工作区干净**

Task 3、4、5 已各自提交，本任务只验证：

```bash
cd /d/project/toolbox
git status --short
git log --oneline -4
```

Expected: `git status --short` 无输出（截图目录被 `*.png` 忽略）；`git log` 顶部三条分别是 index.html、app.js、styles.css 的提交。

若有未提交内容，说明前面某个任务漏提交，先补提交再继续。

- [ ] **Step 6: 全仓库脱敏闸门**

工具源码干净不等于仓库干净——`docs/` 与 `tests/` 同样会被推送。在**任何推送之前**跑：

```bash
cd /d/project/toolbox
git log -p origin/master..HEAD | grep -n -i -E "业务主机关键词|业务账号关键词|业务端口" || echo "干净"
```

Expected: `干净`，即无任何命中。命中就说明脱敏只做了一半，必须处理后再推送。

注意**不要**写成 `git grep ... origin/master..HEAD`：`git grep` 不接受版本区间参数，会以 `fatal: unable to resolve revision` 报错退出——看起来像"没输出"，实际是命令压根没跑。用 `git log -p` 管道给 `grep`，才能覆盖每个提交的每一行差异（包括只存在于中间提交、后来被改掉的内容）。

注意：这类关键词**不要**写进任何会被提交的文件（包括本计划、设计文档和测试），否则闸门自身就成了泄漏点。需要时用自己的记忆或本机笔记核对，测试里改用正向断言（见 Task 2 的 Test 3）。

---

### Task 7: 首页卡片、README 与现有测试的数量断言

新增卡片会让 `tests/test_toolbox.py` 里 4 处写死的「3 张卡片」失败，必须同步修正。

**Files:**
- Modify: `index.html`
- Modify: `README.md`
- Modify: `tests/test_toolbox.py`

- [ ] **Step 1: 先修现有测试的数量断言**

用 Edit 工具做 4 处替换（全文替换 `!= 3` 相关的卡片断言）：

`index.html` 卡片数从 3 变 4，涉及 `tests/test_toolbox.py` 第 33–34、77、94、112 行。

第 33–34 行：

```python
        if card_count != 3:
            errors.append(f"Expected 3 tool cards, got {card_count}")
```

改为：

```python
        if card_count != 4:
            errors.append(f"Expected 4 tool cards, got {card_count}")
```

第 77、94、112 行三处 `!= 3` 全部改为 `!= 4`：

```python
        if cards2.count() != 4:
```

```python
        if page.locator(".tool-card").count() != 4:
```

```python
        if page.locator(".tool-card").count() != 4:
```

- [ ] **Step 2: 为新卡片补一条测试断言**

在 Test 5（第三张卡片）之后插入：

```python
        # Test 5b: Fourth card links to the certificate batch fill tool
        fourth_link = cards.nth(3).get_attribute("href")
        if fourth_link != "./tools/training-cert-batch-fill/index.html":
            errors.append(f"Card 3: expected href './tools/training-cert-batch-fill/index.html', got '{fourth_link}'")
        else:
            print(f"[OK] Card 3 → tools/training-cert-batch-fill/index.html")
```

- [ ] **Step 3: 加图标配色类**

在 `index.html` 的 `.icon-rmb { background: var(--gold-bg); color: var(--gold); }` 之后插入：

```css
  .icon-cert { background: var(--violet-light); color: var(--violet); }
```

- [ ] **Step 4: 加导航卡片**

在 `.tools-grid` 内、**人民币大写转换卡片之后**（即作为第 4 张，保持前三张顺序不变以免破坏既有断言）插入：

```html
    <a class="tool-card" href="./tools/training-cert-batch-fill/index.html">
      <div class="tool-icon icon-cert">&#x1F4CB;</div>
      <div class="tool-info">
        <span class="tool-name">操作培训证书批量填充</span>
        <span class="tool-desc">本地解析 CSV/Excel，批量新增用户</span>
      </div>
      <span class="tool-arrow">&#x203A;</span>
    </a>
```

- [ ] **Step 5: 更新 README 工具表格**

在 `README.md` 的工具列表表格末尾追加一行：

```markdown
| 操作培训证书批量填充 | `tools/training-cert-batch-fill/` | 本地解析 CSV/Excel，批量新增用户 |
```

- [ ] **Step 5b: 更新 README 的运行测试命令列表**

`README.md` 的「运行测试」代码块目前只列了 4 个测试文件。在 `uv run python tests/test_tax_calc.py` 之后追加一行：

```bash
uv run python tests/test_training_cert_batch_fill.py
```

- [ ] **Step 6: 跑首页测试**

```powershell
cd D:\project\toolbox
uv run python tests/test_toolbox.py
```

Expected: `=== ALL TESTS PASSED ===`，输出含 `[OK] 4 tool cards found` 与 `[OK] Card 3 → tools/training-cert-batch-fill/index.html`

- [ ] **Step 7: 回归其余测试**

```powershell
cd D:\project\toolbox
uv run python tests/test_training_cert_batch_fill.py
uv run python tests/test_lung_marker.py
uv run python tests/test_rmb_upper.py
uv run python tests/test_tax_calc.py
```

Expected: 四个文件都以 `=== ALL TESTS PASSED ===` 结束。

- [ ] **Step 8: Commit**

```bash
cd /d/project/toolbox
git add index.html README.md tests/test_toolbox.py
git commit -m "feat: 首页新增操作培训证书批量填充卡片

同步更新首页卡片数量断言（3 → 4）并补第 4 张卡片的链接断言。"
```

---

## 完成标准

- `tools/training-cert-batch-fill/` 含 4 个文件：`index.html`、`app.js`、`styles.css`、`xlsx.full.min.js`
- 工具目录内源码不含任何外部主机（`www.w3.org` 与回环地址除外），由 Test 3 的正向断言保证
- 仓库内所有被跟踪文件（含 docs 与 tests）均不含业务主机、业务账号名与业务端口
- 工具页有指向 `../../index.html` 的 `a.back-link`，CSP 中 `script-src 'self'` 且 `connect-src` 含 `https:`
- 首页有 4 张卡片，新卡片链接正确
- 5 个测试文件全部 `ALL TESTS PASSED`
- 截图人工核对通过（桌面 + 手机）
- 真实业务地址、账号密码、真实用户 CSV 均未进入仓库
