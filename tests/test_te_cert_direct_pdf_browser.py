"""Real Chromium smoke test for the fully-local certificate PDF experiment."""

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
    page.locator("#cloudProvider").select_option("local-direct")
    page.locator("#pdfMergeToggle").set_checked(merged)
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
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        page.on("pageerror", lambda error: errors.append(str(error)))

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
    for output in (general, special):
        data = output.read_bytes()
        assert data.startswith(b"%PDF-"), f"Not a PDF: {output}"
        assert len(data) > 100_000, f"Suspiciously small PDF: {output} ({len(data)} bytes)"
        print(f"OK {output.relative_to(ROOT)} — {len(data):,} bytes")


if __name__ == "__main__":
    run()
