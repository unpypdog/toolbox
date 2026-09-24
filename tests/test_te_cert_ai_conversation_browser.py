"""真实 Chromium：AI 首次提取 → 多轮修改预览 → 确认应用 → IndexedDB 刷新恢复。"""

import json
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
SHOT = ROOT / ".tmp-cert-experiment" / "ai-workbench.png"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def chat_response(content):
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": json.dumps(content, ensure_ascii=False)},
                "finish_reason": "stop",
            }
        ],
        "usage": {"total_tokens": 123},
    }


def main():
    errors = []
    requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/tools/te-cert-generator/index.html"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        def handle_api(route, request):
            body = request.post_data_json
            requests.append(body)
            if len(requests) == 1:
                content = {
                    "imageRows": [
                        {"image": 1, "row": 1, "name": "张三", "hospital": "南京鼓楼医院", "date": "2026/1"},
                        {"image": 2, "row": 1, "name": "李四", "hospital": "南京鼓楼医院", "date": ""},
                    ],
                    "textPeople": [],
                    "assignments": [],
                    "unreadable": "",
                }
            elif len(requests) == 2:
                content = {
                    "reply": "第二张图整批日期改为 2022/10。",
                    "operations": [
                        {
                            "type": "set_field_by_source",
                            "sourceImage": 2,
                            "field": "dateRaw",
                            "value": "2022/10",
                            "reason": "用户明确指定",
                        }
                    ],
                    "questions": [],
                    "decisions": ["第二张图整批日期为 2022/10"],
                }
            else:
                content = {
                    "reply": "按各条已有年月统一补为 10 号。",
                    "operations": [{"type": "set_day_all", "day": 10, "reason": "用户明确覆盖旧决定"}],
                    "questions": [],
                    "decisions": ["所有记录按各自年月统一补 10 号"],
                }
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(chat_response(content), ensure_ascii=False),
            )

        page.route("https://api.deepseek.com/**", handle_api)
        page.goto(url)
        page.wait_for_load_state("networkidle")

        page.locator("#aiBlock > summary").click()
        expect(page.locator("#workspace")).to_have_class(re.compile(r"ai-mode"))
        expect(page.locator("#aiSessionSelect option")).to_have_count(1)

        page.locator("#aiProvider").select_option("deepseek")
        page.locator('[data-ai-field="apiKey"]').fill("test-key")
        page.locator("#aiComposer").fill("请识别两张图里的名单")
        page.locator("#aiParseBtn").click()

        expect(page.locator("#previewBody tr")).to_have_count(2)
        expect(page.locator('[data-field="dateRaw"]').nth(0)).to_have_text("2026/1")
        expect(page.locator("#aiMessages .is-assistant")).to_have_count(1)

        page.locator("#aiComposer").fill("第二张图片完整目录的日期都是2022年10月份")
        page.locator("#aiSendBtn").click()
        expect(page.locator("#aiPendingBlock")).to_be_visible()
        expect(page.locator("#aiPendingList li")).to_have_count(1)
        # 模型只能提出建议，确认前表格必须保持原值。
        expect(page.locator('[data-field="dateRaw"]').nth(1)).to_have_text("")

        page.locator("#aiApplyBtn").click()
        expect(page.locator("#aiPendingBlock")).to_be_hidden()
        expect(page.locator('[data-field="dateRaw"]').nth(1)).to_have_text("2022/10")

        # 真实反馈里的卡点：最新明确指令应直接覆盖“不补日”的旧决定。
        page.locator("#aiComposer").fill("所有记录日期按对应月份统一补为10号")
        page.locator("#aiSendBtn").click()
        expect(page.locator("#aiPendingList li")).to_have_count(2)
        page.locator("#aiApplyBtn").click()
        expect(page.locator('[data-field="dateRaw"]').nth(0)).to_have_text("2026/01/10")
        expect(page.locator('[data-field="dateRaw"]').nth(1)).to_have_text("2022/10/10")

        page.wait_for_timeout(400)
        stored = page.evaluate("window.CertAiSession.list().then(items => items.length)")
        assert stored >= 1, "IndexedDB 没有保存会话"

        SHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOT), full_page=True)

        page.reload()
        page.wait_for_load_state("networkidle")
        expect(page.locator("#previewBody tr")).to_have_count(2)
        expect(page.locator('[data-field="dateRaw"]').nth(0)).to_have_text("2026/01/10")
        expect(page.locator('[data-field="dateRaw"]').nth(1)).to_have_text("2022/10/10")
        expect(page.locator("#aiSessionSelect option")).to_have_count(1)

        assert len(requests) == 1, f"两条明确批量指令应由本地执行，实际仍发出 {len(requests) - 1} 次额外请求"
        assert not errors, "页面错误：" + " | ".join(errors)
        browser.close()

    server.shutdown()
    server.server_close()
    thread.join(timeout=2)

    print("OK 首次提取进入表格")
    print("OK ‘第二张图整批’按图片来源直接定位表格")
    print("OK 多轮修改先预览、确认前不改表")
    print("OK 最新明确指令可覆盖旧决定并统一补日")
    print("OK 两条明确批量指令均在本地解析，没有额外联网")
    print("OK IndexedDB 刷新后恢复会话与记录")
    print("OK 截图：" + str(SHOT))


if __name__ == "__main__":
    main()
