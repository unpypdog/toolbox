"""Test the RMB uppercase converter page."""
from playwright.sync_api import sync_playwright

FILE_URL = "file:///C:/Users/unpyp/Desktop/work/temp/lung_marker/rmb-upper.html"


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
        )
        page = context.new_page()
        page.goto(FILE_URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        errors = []

        # Test 1: Page loads with title
        title = page.title()
        if not title:
            errors.append("Page title is empty")
        else:
            print(f"[OK] Page title: {title}")

        # Test 2: Amount input exists
        amount_input = page.locator("#amountInput")
        if amount_input.count() != 1:
            errors.append("Amount input #amountInput not found")
        else:
            print("[OK] Amount input found")

        # Test 3: Result element exists
        result_el = page.locator("#result")
        if result_el.count() != 1:
            errors.append("Result element #result not found")
        else:
            print("[OK] Result element found")

        # Test 4: Input 100 → 壹佰元整
        amount_input.fill("100")
        page.wait_for_timeout(200)
        result_text = result_el.inner_text()
        if "壹佰元整" not in result_text:
            errors.append(f"Expected '壹佰元整' for input 100, got '{result_text}'")
        else:
            print(f"[OK] 100 → {result_text}")

        # Test 5: Input 12000 → 壹万贰仟元整
        amount_input.fill("12000")
        page.wait_for_timeout(200)
        result_text = result_el.inner_text()
        if "壹万贰仟元整" not in result_text:
            errors.append(f"Expected '壹万贰仟元整' for input 12000, got '{result_text}'")
        else:
            print(f"[OK] 12000 → {result_text}")

        # Test 6: Input 100.50 → 壹佰元伍角
        amount_input.fill("100.50")
        page.wait_for_timeout(200)
        result_text = result_el.inner_text()
        if "壹佰元" not in result_text:
            errors.append(f"Expected '壹佰元...' for input 100.50, got '{result_text}'")
        elif "伍角" not in result_text:
            errors.append(f"Expected '伍角' in result for 100.50, got '{result_text}'")
        else:
            print(f"[OK] 100.50 → {result_text}")

        # Test 7: Input 0.01 → 壹分
        amount_input.fill("0.01")
        page.wait_for_timeout(200)
        result_text = result_el.inner_text()
        if "壹分" not in result_text:
            errors.append(f"Expected '壹分' for 0.01, got '{result_text}'")
        else:
            print(f"[OK] 0.01 → {result_text}")

        # Test 8: Input 123456789 → includes 亿 and 万
        amount_input.fill("123456789")
        page.wait_for_timeout(200)
        result_text = result_el.inner_text()
        if "亿" not in result_text:
            errors.append(f"Expected '亿' for large number, got '{result_text}'")
        elif "万" not in result_text:
            errors.append(f"Expected '万' for large number, got '{result_text}'")
        else:
            print(f"[OK] 123456789 → {result_text}")

        # Test 9: Copy button exists
        copy_btn = page.locator("#copyBtn")
        if copy_btn.count() != 1:
            errors.append("Copy button #copyBtn not found")
        else:
            print("[OK] Copy button found")

        # Test 10: Back link exists
        back_link = page.locator("a.back-link")
        if back_link.count() != 1:
            errors.append("Back link a.back-link not found")
        else:
            href = back_link.get_attribute("href")
            if href != "./index.html":
                errors.append(f"Back link href expected './index.html', got '{href}'")
            else:
                print(f"[OK] Back link: {href}")

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
