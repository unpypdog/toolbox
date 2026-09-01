"""Test the toolbox homepage."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT_ROOT = Path(__file__).parent.parent
FILE_URL = f"file:///{PROJECT_ROOT / 'index.html'}"


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

        # Test 2: Three tool cards exist
        cards = page.locator(".tool-card")
        card_count = cards.count()
        if card_count != 3:
            errors.append(f"Expected 3 tool cards, got {card_count}")
        else:
            print(f"[OK] {card_count} tool cards found")

        # Test 3: First card links to lung marker
        first_link = cards.nth(0).get_attribute("href")
        if first_link != "./tools/lung-marker/index.html":
            errors.append(f"Card 0: expected href './tools/lung-marker/index.html', got '{first_link}'")
        else:
            print(f"[OK] Card 0 → tools/lung-marker/index.html")

        # Test 4: Second card links to tax calc
        second_link = cards.nth(1).get_attribute("href")
        if second_link != "./tools/tax-calc/index.html":
            errors.append(f"Card 1: expected href './tools/tax-calc/index.html', got '{second_link}'")
        else:
            print(f"[OK] Card 1 → tools/tax-calc/index.html")

        # Test 5: Third card links to RMB converter
        third_link = cards.nth(2).get_attribute("href")
        if third_link != "./tools/rmb-upper/index.html":
            errors.append(f"Card 2: expected href './tools/rmb-upper/index.html', got '{third_link}'")
        else:
            print(f"[OK] Card 2 → tools/rmb-upper/index.html")

        # Test 6: Navigate to lung marker and back
        cards.nth(0).click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        h1 = page.locator("h1")
        if h1.count() == 0:
            errors.append("Navigation to lung marker page failed: no h1 found")
        else:
            h1_text = h1.inner_text()
            if "右下叶基底段" not in h1_text:
                errors.append(f"Lung marker page h1 mismatch: got '{h1_text}'")
            else:
                print("[OK] Navigated to lung marker page")

        page.go_back()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        cards2 = page.locator(".tool-card")
        if cards2.count() != 3:
            errors.append("Back navigation to homepage failed")
        else:
            print("[OK] Back navigation to homepage works")

        # Test 7: Navigate to tax calc and back via back link
        cards2.nth(1).click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        back_link = page.locator("a.back-link")
        if back_link.count() != 1:
            errors.append("Tax calc page missing back link after navigation")
        else:
            print("[OK] Tax calc page has back link")
        back_link.click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        if page.locator(".tool-card").count() != 3:
            errors.append("Back link to homepage failed")
        else:
            print("[OK] Back link returns to homepage")

        # Test 8: Navigate to RMB converter and back
        cards3 = page.locator(".tool-card")
        cards3.nth(2).click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        back_link2 = page.locator("a.back-link")
        if back_link2.count() != 1:
            errors.append("RMB converter page missing back link after navigation")
        else:
            print("[OK] RMB converter page has back link")
        back_link2.click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        if page.locator(".tool-card").count() != 3:
            errors.append("Back link from RMB converter to homepage failed")
        else:
            print("[OK] Full navigation cycle works")

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
