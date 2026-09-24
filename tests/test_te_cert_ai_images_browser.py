"""Real Chromium test for the multi-image input of the AI panel.

The AI panel used to accept exactly one image. That restriction was silent:
picking a second file simply replaced the first, and the user had no way to
tell. This test drives the real file input with several files and checks the
whole local path that changed:

    multiple attribute -> FileReader -> numbered list -> per-image remove

No network and no API key: parsing itself is not exercised here, only the
image intake (which is where the "only one image" bug lived).

注意：页面 CSP 是 script-src 'self'，所以这里一律不用 wait_for_function
（它会把字符串当 JS 求值，被 CSP 直接拦掉），改用 expect() 的自动等待。

Usage: uv run python tests/test_te_cert_ai_images_browser.py
"""

from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "tools" / "te-cert-generator" / "index.html"
WORK = ROOT / ".tmp-cert-experiment" / "ai-image-input"

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd4000000"
    "0049454e44ae426082"
)
# 浏览器只把文件读成 data URL、不解码，所以内容只需让扩展名推出正确的 mime
JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")
GIF = b"GIF89a"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"OK {name}")
    else:
        failures.append(name + (f" — {detail}" if detail else ""))
        print(f"FAIL {name}" + (f" — {detail}" if detail else ""))


def write_fixtures() -> dict[str, Path]:
    WORK.mkdir(parents=True, exist_ok=True)
    payloads = {"名单-第一张.png": PNG, "聊天截图-第二张.jpg": JPEG, "第三张.png": PNG}
    paths = {}
    for name, payload in payloads.items():
        path = WORK / name
        path.write_bytes(payload)
        paths[name] = path
    return paths


def item_names(page) -> list[str]:
    # 用 text_content 而不是 inner_text：面板折叠时后者会返回空串
    return [
        (text or "").strip()
        for text in page.locator("#aiImageList .image-item-name").all_text_contents()
    ]


def run() -> None:
    fixtures = write_fixtures()
    first = fixtures["名单-第一张.png"]
    second = fixtures["聊天截图-第二张.jpg"]
    third = fixtures["第三张.png"]
    bad = WORK / "不支持的格式.bmp"
    bad.write_bytes(b"BM")

    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(PAGE.as_uri(), wait_until="load")
        # 等 app.js 真的初始化过：服务商下拉框是 init 时填充的。
        # 用 DOM 事实而不是 wait_for_function —— 页面 CSP 不允许把字符串当 JS 求值。
        expect(page.locator("#aiProvider option")).not_to_have_count(0)
        # AI 面板默认折叠，展开它才是用户真实看到的样子。
        # 用 > 限定直接子元素：面板里还嵌着「查看 AI 原始返回」那个 details，
        # 写成 `#aiBlock summary` 会同时命中两个 summary（Playwright 严格模式会直接报错）。
        page.locator("#aiBlock > summary").click()
        expect(page.locator("#aiBlock")).to_have_attribute("open", "")
        # 文件输入框本身就是 CSS 隐藏的（点的是它外面那层 label），set_input_files 不受影响

        check("初始没有已选图片", page.locator("#aiImageList li").count() == 0)
        check(
            "初始提示未选择图片",
            "尚未选择图片" in page.locator("#aiImageName").inner_text(),
            page.locator("#aiImageName").inner_text(),
        )

        # 一次选两张：这是「只能上传一张」的核心回归点
        page.set_input_files("#aiImageInput", [str(first), str(second)])
        expect(page.locator("#aiImageList li")).to_have_count(2)
        check("一次可以选两张", page.locator("#aiImageList li").count() == 2)
        check(
            "列表按上传顺序编号",
            item_names(page) == [f"1. {first.name}", f"2. {second.name}"],
            str(item_names(page)),
        )
        check(
            "汇总显示张数与顺序",
            "已选 2 张图片" in page.locator("#aiImageName").inner_text(),
            page.locator("#aiImageName").inner_text(),
        )
        check(
            "汇总显示合计体积与张数上限",
            "上限 4 张" in page.locator("#aiImageMeta").inner_text(),
            page.locator("#aiImageMeta").inner_text(),
        )

        # 再追加一张：应当累加而不是替换
        page.set_input_files("#aiImageInput", [str(third)])
        expect(page.locator("#aiImageList li")).to_have_count(3)
        check("再次选择是追加而不是替换", page.locator("#aiImageList li").count() == 3)
        check("第三张排在第 3 位", item_names(page)[2] == f"3. {third.name}", str(item_names(page)))

        # 移除中间那张：后面的必须重新编号，否则序号与模型看到的顺序就对不上
        page.locator("#aiImageList li").nth(1).locator(".image-item-remove").click()
        expect(page.locator("#aiImageList li")).to_have_count(2)
        check("可以逐张移除", page.locator("#aiImageList li").count() == 2)
        check(
            "移除后重新编号",
            item_names(page) == [f"1. {first.name}", f"2. {third.name}"],
            str(item_names(page)),
        )

        # 坏格式要被拦下，且不能把已选的图挤掉
        page.set_input_files("#aiImageInput", [str(bad)])
        page.wait_for_timeout(300)
        check("不支持的格式被拦下", page.locator("#aiImageList li").count() == 2)
        check(
            "拦下时把原因写进了提示条",
            "不支持" in page.locator("#noticeBar").inner_text(),
            page.locator("#noticeBar").inner_text(),
        )

        # 一键清空
        page.locator("#aiClearImageBtn").click()
        expect(page.locator("#aiImageList li")).to_have_count(0)
        check("一键移除全部", page.locator("#aiImageList li").count() == 0)
        check(
            "移除后提示回到未选择",
            "尚未选择图片" in page.locator("#aiImageName").inner_text(),
            page.locator("#aiImageName").inner_text(),
        )

        check("整个过程没有页面异常", not errors, "; ".join(errors))
        browser.close()


if __name__ == "__main__":
    run()
    if failures:
        print()
        for item in failures:
            print("  - " + item)
        raise SystemExit(f"{len(failures)} 项失败")
    print("=== ALL TESTS PASSED ===")
