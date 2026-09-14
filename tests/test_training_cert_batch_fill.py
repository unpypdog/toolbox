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
DEFAULT_API_BASE = "https://z.fibrotouch.com:3962"

# 工具源码允许出现的外部主机：SVG 命名空间，以及 CSP 里的回环地址。
# 除此之外只给默认预填的业务地址开一个口子，且限定它只能出现在 app.js——
# 这个地址出现在模板、样式或说明文案里，同样说明护栏被绕开了。
ALLOWED_HOSTS = {"www.w3.org", "localhost", "127.0.0.1"}
DEFAULT_API_HOST = "z.fibrotouch.com"
DEFAULT_API_HOST_FILES = {"app.js"}
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
                if host in ALLOWED_HOSTS:
                    continue
                if host == DEFAULT_API_HOST and name in DEFAULT_API_HOST_FILES:
                    continue
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

        # Test 6b: 没有历史记录的浏览器里，服务地址预填默认值。
        # 必须开独立 context 才能拿到空 localStorage——同 context 下前面
        # 连接成功的地址会盖过默认值，断言就测不到默认值本身了。
        fresh_context = browser.new_context(viewport={"width": 1280, "height": 900})
        fresh_page = fresh_context.new_page()
        fresh_page.goto(FILE_URL)
        fresh_page.wait_for_load_state("networkidle")
        fresh_page.wait_for_timeout(300)
        prefilled = fresh_page.locator("#apiBaseInput").input_value()
        if prefilled != DEFAULT_API_BASE:
            errors.append(f"Service address not prefilled with the default: {prefilled!r}")
        else:
            print(f"[OK] Service address prefilled with the default: {prefilled}")
        fresh_context.close()

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

        # Test 17: 非 UTF-8 编码的 CSV 也要能解析
        # 中文 Windows 上 Excel 存出的 CSV 默认是 GBK，而 File.text() 只按 UTF-8
        # 解码，中文表头会变成乱码——报出来的却是“缺少必要表头”，
        # 使用者看到的则是文件明明没问题。这条断言锁住编码回退逻辑。
        gbk_page = context.new_page()
        gbk_page.goto(FILE_URL)
        gbk_page.wait_for_load_state("networkidle")
        gbk_page.wait_for_timeout(400)
        gbk_page.set_input_files(
            "#fileInput",
            {
                "name": "gbk.csv",
                "mimeType": "text/csv",
                "buffer": (
                    "姓名,手机号,单位名称,地址\n"
                    "张三,13800138000,示例医院,北京市海淀区示例路1号\n"
                ).encode("gbk"),
            },
        )
        gbk_page.wait_for_timeout(600)
        gbk_total = gbk_page.locator("#statTotal").inner_text().strip()
        gbk_ready = gbk_page.locator("#statReady").inner_text().strip()
        gbk_meta = gbk_page.locator("#fileMeta").inner_text().strip()
        if gbk_total != "1" or gbk_ready != "1":
            errors.append(f"GBK CSV not parsed: total={gbk_total} ready={gbk_ready}")
        elif "GBK" not in gbk_meta.upper():
            errors.append(f"Detected encoding not surfaced in the file summary: {gbk_meta}")
        else:
            print(f"[OK] GBK CSV parsed; summary reads '{gbk_meta}'")
        gbk_page.close()

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
