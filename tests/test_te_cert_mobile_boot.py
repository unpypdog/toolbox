"""Real Chromium test for the mobile first screen of the certificate tool.

Two production faults are pinned here, both reported from a phone:

1. 首屏把两个大库也算进去了。xlsx.full.min.js（约 0.9 MB）与 pdf-lib（约 0.5 MB）
   占首屏体积的 86%，却只有「导入 Excel」「生成 PDF」才用得上。手机端实测
   400 kbps 下 DOMContentLoaded 要 14s，去掉之后约 2s —— 用户的原话是
   「要缓存好久之后才可以正常打开」。

2. 点开「AI 名单工作台」却切不进 AI 工作站。首屏 HTML/CSS 一两秒就画出来了，
   而 defer 脚本要等十几秒；用户在这个窗口里点开 <details>，浏览器原生展开，
   但 toggle 事件早于监听器绑定触发，.ai-mode 永远补不上，再等也不会恢复。
   修复是让布局由 body 末尾那个几百字节的 ai-mode-boot.js 在解析期接管。

三条场景：
    A. 把 5 个 defer 脚本全部掐断，只留 ai-mode-boot.js —— 点开面板仍必须切进
       AI 工作站。这条是确定性的：不靠"够快"，而是证明布局与那些大脚本无关。
    B. 限速 + 移动视口冷启动：首屏不许下载 xlsx / pdf-lib，请求数与体积都有预算。
    C. 不省流时空闲预取会补上 pdf-lib，且手机视口下真的生成得出一份 PDF。
    D. 用户已经在 AI 工作站里时不许预取（限速下它会占带宽十几秒），
       但点「生成」仍要按需拿到引擎。

用法: uv run python tests/test_te_cert_mobile_boot.py
"""

import contextlib
import http.server
import json
import socket
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".tmp-cert-experiment" / "mobile-boot"

# Chrome DevTools 的 "Slow 4G" 档：400 kbps 下行、400ms RTT。
# 取这一档是因为它复现了用户描述的等待长度，而且足够慢到让"脚本就绪前"那个窗口稳定存在。
SLOW_4G = {"download": 400_000 / 8, "upload": 400_000 / 8, "latency": 400}

# 首屏必须有的东西：HTML、CSS、5 个业务脚本 + 1 个早期布局脚本。
# 写死成白名单，是为了让"又往 head 里塞了个大文件"当场变成失败，而不是慢慢变慢。
BOOT_FILES = {
    "index.html",
    "styles.css",
    "cert-core.js",
    "cert-direct-pdf.js",
    "cert-ai.js",
    "cert-ai-session.js",
    "app.js",
    "ai-mode-boot.js",
}

# 布局必须在这些脚本缺席时也成立（场景 A 会把它们全部掐断）
DEFERRED_SCRIPTS = [
    "cert-core.js",
    "cert-direct-pdf.js",
    "cert-ai.js",
    "cert-ai-session.js",
    "app.js",
]

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"OK {name}")
    else:
        failures.append(name + (f" — {detail}" if detail else ""))
        print(f"FAIL {name}" + (f" — {detail}" if detail else ""))


def free_port() -> int:
    with contextlib.closing(socket.socket()) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextlib.contextmanager
def serve(directory: Path):
    """本机 http 服务：限速要靠 CDP 的网络模拟，file:// 不过网络栈。"""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *args):  # 保持输出干净
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", free_port()), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def mobile_context(browser, **kwargs):
    return browser.new_context(
        viewport={"width": 393, "height": 851},
        device_scale_factor=2.75,
        is_mobile=True,
        has_touch=True,
        accept_downloads=True,
        **kwargs,
    )


def throttle(context, profile: dict, cpu_rate: int = 4) -> None:
    session = context.new_cdp_session(context.pages[0])
    session.send("Network.enable")
    session.send("Network.setCacheDisabled", {"cacheDisabled": True})
    session.send(
        "Network.emulateNetworkConditions",
        {
            "offline": False,
            "latency": profile["latency"],
            "downloadThroughput": profile["download"],
            "uploadThroughput": profile["upload"],
        },
    )
    session.send("Emulation.setCPUThrottlingRate", {"rate": cpu_rate})


def scenario_layout_without_app(browser, url: str, errors: list[str]) -> None:
    """A：掐断全部 defer 脚本，布局仍必须切得过去。"""
    context = mobile_context(browser)

    def block(route, request):
        if any(request.url.endswith(name) for name in DEFERRED_SCRIPTS):
            route.abort()
        else:
            route.continue_()

    context.route("**/*", block)
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector("#aiBlock > summary", state="visible", timeout=60_000)
    page.click("#aiBlock > summary", force=True)
    try:
        page.wait_for_selector("#workspace.ai-mode", timeout=10_000)
        applied = True
    except Exception as error:  # noqa: BLE001 - 失败信息要用原文
        applied = False
        errors.append("ai-mode 未出现：" + str(error).splitlines()[0])
    state = page.evaluate(
        "() => ({aiMode: document.getElementById('workspace').classList.contains('ai-mode'),"
        " sessions: document.getElementById('aiSessionSelect').options.length,"
        " workspace: Boolean(window.CertCore)})"
    )
    check(
        "5 个 defer 脚本全被掐断，点开面板仍然切进 AI 工作站",
        applied and state["aiMode"],
        json.dumps(state, ensure_ascii=False),
    )
    check(
        "此刻 app.js 确实没跑（不是测试自欺）",
        state["sessions"] == 0 and state["workspace"] is False,
        json.dumps(state, ensure_ascii=False),
    )
    context.close()


def scenario_first_screen(browser, url: str, errors: list[str]) -> None:
    """B：限速冷启动的首屏预算，以及 xlsx 的按需加载。"""
    context = mobile_context(browser)
    # 关掉空闲预取，否则"首屏没下载 pdf-lib"会被后台预取污染成不稳定断言。
    # 省流（saveData）本来就是预取的正常关闭开关，用它而不是改代码。
    context.add_init_script(
        "Object.defineProperty(navigator, 'connection', "
        "{value: {saveData: true, effectiveType: '4g'}, configurable: true});"
    )
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    requested: list[str] = []
    page.on("request", lambda request: requested.append(request.url.split("/")[-1]))
    throttle(context, SLOW_4G)

    page.goto(url, wait_until="commit")
    page.wait_for_selector("#aiBlock > summary", state="visible", timeout=180_000)
    # 脚本还远没就绪的那一刻点开面板 —— 就是用户投诉的那个时刻
    page.click("#aiBlock > summary", force=True)
    page.wait_for_selector("#aiSessionSelect option", state="attached", timeout=180_000)
    page.wait_for_timeout(1500)  # 给"偷跑"的请求一点时间暴露自己

    boot_requests = list(requested)
    check(
        "首屏不下载 xlsx（约 0.9 MB，只有导入 Excel 才用）",
        "xlsx.full.min.js" not in boot_requests,
        "实际请求：" + ", ".join(boot_requests),
    )
    check(
        "首屏不下载 pdf-lib（约 0.5 MB，只有生成 PDF 才用）",
        "pdf-lib.min.js" not in boot_requests,
        "实际请求：" + ", ".join(boot_requests),
    )
    unexpected = {name for name in boot_requests if name and name not in BOOT_FILES}
    check(
        "首屏只请求了必要文件",
        not unexpected,
        "多出来的：" + ", ".join(sorted(unexpected)),
    )
    transfer = page.evaluate(
        "() => performance.getEntriesByType('resource')"
        ".reduce((sum, e) => sum + (e.decodedBodySize || 0), 0)"
    )
    # 原始字节约 270 KB（gzip 后约 65 KB）。改动前的 1.7 MB 会因为这一条当场失败。
    check(
        "首屏原始体积在预算内（< 400 KB）",
        transfer < 400_000,
        f"实际 {transfer:,} 字节",
    )
    check(
        "面板在这条真实路径上也切进了 AI 工作站",
        page.evaluate("document.getElementById('workspace').classList.contains('ai-mode')"),
    )

    # xlsx 只在真的选了 Excel 时才下载（这里不需要合法工作簿：
    # 断言的是"下载时机"，解析失败与否由别处覆盖）
    probe = OUTPUT / "按需加载探针.xlsx"
    probe.write_bytes(b"not a real workbook")
    page.set_input_files("#fileInput", str(probe))
    page.wait_for_timeout(3000)
    check(
        "选了 .xlsx 才下载 xlsx 组件",
        "xlsx.full.min.js" in requested,
        "按需加载没接上，导入 Excel 会直接报「组件未加载」",
    )
    notice = page.inner_text("#noticeBar")
    check(
        "组件到位后报的是文件问题，不是「组件未加载」",
        "组件未加载" not in notice,
        notice.strip(),
    )
    context.close()


def scenario_generate_on_phone(browser, url: str, errors: list[str]) -> None:
    """C：不省流时的空闲预取，以及手机视口下真的出一份 PDF。"""
    context = mobile_context(browser)
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    late: list[str] = []
    page.on("request", lambda request: late.append(request.url.split("/")[-1]))
    page.goto(url, wait_until="load")
    page.wait_for_selector("#aiSessionSelect option", state="attached", timeout=120_000)
    page.wait_for_timeout(6000)  # 等空闲预取
    check(
        "空闲预取把 pdf-lib 拉到本地（点生成时不必再等）",
        "pdf-lib.min.js" in late,
        "实际请求：" + ", ".join(late),
    )
    check(
        "空闲预取不会顺手把 xlsx 也拉下来",
        "xlsx.full.min.js" not in late,
        "实际请求：" + ", ".join(late),
    )

    page.fill("#quickInput", "张小三 南京鼓楼医院 26年9月23日")
    page.click("#parseBtn")
    expect(page.locator("#statReady")).to_have_text("1", timeout=60_000)
    with page.expect_download(timeout=120_000) as download_info:
        page.click("#pdfBtn")
    target = OUTPUT / "mobile-lazy-pdf.pdf"
    download_info.value.save_as(target)
    data = target.read_bytes()
    check(
        "手机视口下真的生成了 PDF",
        data.startswith(b"%PDF-") and len(data) > 100_000,
        f"{len(data):,} 字节",
    )
    context.close()


def scenario_prefetch_yields_to_ai(browser, url: str, errors: list[str]) -> None:
    """D：用户人在 AI 工作站里时，预取不许抢带宽。

    这条是拿限速实测定的：400 kbps 下预取要从 6.3s 一直占到 17.3s，
    而这期间正是用户发材料、等 AI 回话的时候 —— 引擎该等他自己点「生成」。
    """
    context = mobile_context(browser)
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    seen: list[str] = []
    page.on("request", lambda request: seen.append(request.url.split("/")[-1]))
    throttle(context, SLOW_4G)

    page.goto(url, wait_until="commit")
    page.wait_for_selector("#aiBlock > summary", state="visible", timeout=180_000)
    # 抢在空闲预取之前进 AI 工作站（实测预取要等到 ~6s，这里是 ~1s）
    page.click("#aiBlock > summary", force=True)
    page.wait_for_selector("#aiSessionSelect option", state="attached", timeout=180_000)
    page.wait_for_timeout(8000)  # 给它足够时间去"偷跑"
    check(
        "人在 AI 工作站里时不预取 pdf-lib（带宽留给 AI 请求）",
        "pdf-lib.min.js" not in seen,
        "实际请求：" + ", ".join(seen),
    )

    # 但按需加载这条链不能因此断掉：点生成时仍然要能拿到引擎。
    # 生成前先「返回设置」——AI 工作站布局下设置面板是隐藏的，快速输入框点不到。
    page.click("#aiCloseBtn")
    page.wait_for_selector("#quickInput", state="visible", timeout=60_000)
    page.fill("#quickInput", "张小三 南京鼓楼医院 26年9月23日")
    page.click("#parseBtn")
    expect(page.locator("#statReady")).to_have_text("1", timeout=60_000)
    with page.expect_download(timeout=180_000) as download_info:
        page.click("#pdfBtn")
    download_info.value.save_as(OUTPUT / "ai-mode-lazy-pdf.pdf")
    check(
        "该按需加载的时候照样加载（生成走的还是同一条 ensureLibrary）",
        "pdf-lib.min.js" in seen,
        "实际请求：" + ", ".join(seen),
    )
    context.close()


def run() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    with serve(ROOT) as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        url = f"{base}/tools/te-cert-generator/index.html"
        scenario_layout_without_app(browser, url, errors)
        scenario_first_screen(browser, url, errors)
        scenario_generate_on_phone(browser, url, errors)
        scenario_prefetch_yields_to_ai(browser, url, errors)
        browser.close()

    check("整个过程没有页面异常", not errors, " | ".join(errors))

    print("\n" + "=" * 70)
    if failures:
        print(f"失败 {len(failures)} 项：")
        for item in failures:
            print("  - " + item)
        raise SystemExit(1)
    print("全部通过。")


if __name__ == "__main__":
    run()
