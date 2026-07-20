"""Test the lung segment marker web app on mobile viewport."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import sys

PROJECT_ROOT = Path(__file__).parent.parent
FILE_URL = f"file:///{PROJECT_ROOT / 'tools' / 'lung-marker' / 'index.html'}"
SCREENSHOT_DIR = PROJECT_ROOT / 'tests' / 'screenshots'
SCREENSHOT_DIR.mkdir(exist_ok=True)

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},  # iPhone 14 size
            device_scale_factor=3,
        )
        page = context.new_page()
        page.goto(FILE_URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)  # let initial animations finish

        errors = []

        # === Screenshot of initial state ===
        page.screenshot(path=str(SCREENSHOT_DIR / "test_01_initial.png"), full_page=True)
        print("[OK] Initial screenshot saved")

        # === Test 1: Four buttons display correctly ===
        btns = page.locator(".seg-btn")
        count = btns.count()
        if count != 4:
            errors.append(f"Expected 4 buttons, got {count}")
        else:
            print(f"[OK] Test 1: {count} buttons found")

        labels = ["前", "后", "内", "外"]
        for i, label in enumerate(labels):
            btn_text = btns.nth(i).locator(".seg-icon").inner_text()
            if btn_text != label:
                errors.append(f"Button {i}: expected '{label}', got '{btn_text}'")
        if not any("Button" in e for e in errors):
            print(f"[OK] Test 1: All button labels correct: {labels}")

        # === Test 2: Clicking buttons shows order numbers ===
        # Click buttons in order: 前(0), 内(2), 后(1), 外(3)
        click_order = [0, 2, 1, 3]
        for idx in click_order:
            btns.nth(idx).click()
            page.wait_for_timeout(200)

        page.screenshot(path=str(SCREENSHOT_DIR / "test_02_all_selected.png"), full_page=True)

        # Verify order badges
        for i in range(4):
            badge = btns.nth(i).locator(".order-badge")
            badge_text = badge.inner_text()
            # Expected order for each button index
            expected_orders = {0: "1", 1: "3", 2: "2", 3: "4"}
            if badge_text != expected_orders[i]:
                errors.append(f"Button {i}: expected order {expected_orders[i]}, got '{badge_text}'")
            if not badge.evaluate("el => el.classList.contains('show')"):
                errors.append(f"Button {i}: badge should be visible")

        if not any("expected order" in e for e in errors) and not any("badge should be visible" in e for e in errors):
            print("[OK] Test 2: Order badges show correctly (前=1, 内=2, 后=3, 外=4)")

        # Verify order slots
        slots = page.locator(".order-slot")
        for i in range(4):
            slot_label = slots.nth(i).locator(".slot-label").inner_text()
            expected_labels = {0: "前", 1: "内", 2: "后", 3: "外"}
            if slot_label != expected_labels[i]:
                errors.append(f"Order slot {i}: expected '{expected_labels[i]}', got '{slot_label}'")
        if not any("Order slot" in e for e in errors):
            print("[OK] Test 2: Order track slots display correct labels")

        # === Test 3: Reset clears all ===
        page.locator("#resetBtn").click()
        page.wait_for_timeout(300)

        page.screenshot(path=str(SCREENSHOT_DIR / "test_03_after_reset.png"), full_page=True)

        for i in range(4):
            badge = btns.nth(i).locator(".order-badge")
            if badge.evaluate("el => el.classList.contains('show')"):
                errors.append(f"Button {i}: badge should be hidden after reset")
            if btns.nth(i).evaluate("el => el.classList.contains('selected')"):
                errors.append(f"Button {i}: should not be selected after reset")

        for i in range(4):
            slot_label = slots.nth(i).locator(".slot-label").inner_text()
            if slot_label != "—":
                errors.append(f"Order slot {i}: expected '—' after reset, got '{slot_label}'")

        if not any("after reset" in e for e in errors):
            print("[OK] Test 3: Reset clears all selections")

        # === Test 4: Regret mode enforces LIFO undo (always on) ===
        # Re-select buttons: 前(1), 后(2), 内(3), 外(4)
        for idx in [0, 1, 2, 3]:
            btns.nth(idx).click()
            page.wait_for_timeout(150)

        page.wait_for_timeout(300)
        page.screenshot(path=str(SCREENSHOT_DIR / "test_04a_regret_mode.png"), full_page=True)

        # Verify only button 外 (index 3, order 4) has can-undo class
        for i in range(4):
            has_undo = btns.nth(i).evaluate("el => el.classList.contains('can-undo')")
            if i == 3:
                if not has_undo:
                    errors.append(f"Button 外 (index 3) should have can-undo glow")
            else:
                if has_undo:
                    errors.append(f"Button {labels[i]} should NOT have can-undo glow (not the last)")

        # Try to undo button 前 (index 0, order 1) — should FAIL (not the last)
        btns.nth(0).click()
        page.wait_for_timeout(300)
        # Button 前 should still have order 1
        badge_text = btns.nth(0).locator(".order-badge").inner_text()
        if badge_text != "1":
            errors.append(f"Regret mode should prevent undoing non-last button; expected badge '1', got '{badge_text}'")

        # Verify shake animation triggered on ineligible button
        had_shake = btns.nth(0).evaluate("el => el.classList.contains('shake')")
        if had_shake:
            print("[OK] Test 4: Shake animation triggered on ineligible button click")
        else:
            # shake is transient (removed after animation), may have already finished
            pass

        page.screenshot(path=str(SCREENSHOT_DIR / "test_04b_undo_blocked.png"), full_page=True)

        # Now undo button 外 (index 3, order 4) — should SUCCEED (is the last)
        btns.nth(3).click()
        page.wait_for_timeout(300)
        badge_text = btns.nth(3).locator(".order-badge")
        if badge_text.evaluate("el => el.classList.contains('show')"):
            errors.append("Button 外 should be unselected after undo")

        # Now button 内 (index 2, order 3) should be eligible
        has_undo = btns.nth(2).evaluate("el => el.classList.contains('can-undo')")
        if not has_undo:
            errors.append("Button 内 should now be eligible for undo (became last)")

        # Undo 内
        btns.nth(2).click()
        page.wait_for_timeout(200)

        # Undo 后
        btns.nth(1).click()
        page.wait_for_timeout(200)

        # Undo 前
        btns.nth(0).click()
        page.wait_for_timeout(200)

        page.screenshot(path=str(SCREENSHOT_DIR / "test_04c_all_undone.png"), full_page=True)

        # Verify all cleared
        for i in range(4):
            if btns.nth(i).evaluate("el => el.classList.contains('selected')"):
                errors.append(f"Button {labels[i]} should be unselected after full undo chain")

        if not any("after full undo" in e for e in errors) and not any("should NOT have can-undo" in e for e in errors):
            print("[OK] Test 4: LIFO undo chain works (外→内→后→前)")

        # === Summary ===
        if errors:
            print(f"\n=== {len(errors)} ERROR(S) ===")
            for e in errors:
                print(f"  FAIL: {e}")
            sys.exit(1)
        else:
            print("\n=== ALL TESTS PASSED ===")

        browser.close()

if __name__ == "__main__":
    run()
