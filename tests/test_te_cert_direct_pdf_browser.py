"""Real Chromium smoke test for the fully-local certificate PDF generator.

This is the ONLY generation path now (the cloud DOCX→PDF route was removed),
so this test covers the whole product: template → local PDF, no network.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "tools" / "te-cert-generator" / "index.html"
OUTPUT = ROOT / ".tmp-cert-experiment" / "browser-output"


def generate(page, text: str, template: str, merged: bool, output_name: str) -> Path:
    page.goto(PAGE.as_uri(), wait_until="load")
    page.wait_for_function("window.CertCore && window.CertDirectPdf && window.PDFLib")
    page.locator("#quickInput").fill(text)
    page.locator("#parseBtn").click()
    page.wait_for_function("document.querySelector('#statReady').textContent !== '0'")
    if template != "general":
        page.locator(f'input[name="template"][value="{template}"]').check()
    page.locator("#pdfMergeToggle").set_checked(merged)
    # 没有"选生成方式"这一步了：记录一就绪按钮就该可用。
    page.wait_for_function("!document.querySelector('#pdfBtn').disabled")

    with page.expect_download(timeout=120_000) as download_info:
        page.locator("#pdfBtn").click()
    download = download_info.value
    target = OUTPUT / output_name
    download.save_as(target)
    page.wait_for_function("document.querySelector('#noticeBar').textContent.includes('已生成')")
    return target


def run() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    requests: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        page.on("pageerror", lambda error: errors.append(str(error)))
        # 生成过程必须一个网络请求都不发 —— 这是移除云端路径后最重要的产品承诺。
        page.on("request", lambda request: requests.append(request.url))

        general = generate(
            page,
            "张小三 南京鼓楼医院 26年9月23日",
            "general",
            False,
            "direct-general.pdf",
        )
        special = generate(
            page,
            "欧阳娜娜、靳睿 南京鼓楼医院 26年9月23日",
            "special",
            True,
            "direct-special-merged.pdf",
        )
        browser.close()

    assert not errors, "Browser page errors: " + " | ".join(errors)
    # 反向确认这条断言不是空转：页面自己的 file:// 请求必须被记下来。
    # 少了它，监听器一旦没生效，requests 会是空的，下面那条 0 远程请求就变成永远通过。
    assert requests, "No requests observed at all — the request listener is not working"
    remote = [url for url in requests if url.startswith(("http://", "https://"))]
    assert not remote, "Certificate generation must not touch the network: " + " | ".join(remote)
    print(f"OK offline check — {len(requests)} local requests, 0 remote ({len(remote)} expected)")
    for output in (general, special):
        data = output.read_bytes()
        assert data.startswith(b"%PDF-"), f"Not a PDF: {output}"
        assert len(data) > 100_000, f"Suspiciously small PDF: {output} ({len(data)} bytes)"
        print(f"OK {output.relative_to(ROOT)} — {len(data):,} bytes")


if __name__ == "__main__":
    run()

