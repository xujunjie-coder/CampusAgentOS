"""Render the real chat template and exercise collaboration controls with mocked APIs."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from playwright.async_api import async_playwright
from tornado.template import Loader

ROOT = Path(__file__).resolve().parents[1]


async def main():
    html = Loader(str(ROOT / "app/templates")).load("index.html").generate(
        title="协同验证", username="preview", role="user", site_name="智慧校园",
        site_favicon="", static_url=lambda path: "/static/" + path,
        _tt_modules=SimpleNamespace(xsrf_form_html=lambda: b'<input name="_xsrf" value="test" hidden>'),
    )
    requests = []
    assistant = {"id": 1, "name": "校园助手", "tools": ["task"], "avatar": "fas fa-robot"}

    async def route(request_route):
        request = request_route.request
        path = request.url.split("campus.test", 1)[1].split("?", 1)[0]
        if path == "/":
            return await request_route.fulfill(body=html, content_type="text/html; charset=utf-8")
        if path.startswith("/static/"):
            file = ROOT / "app" / path.lstrip("/")
            return await request_route.fulfill(path=str(file)) if file.is_file() else await request_route.abort()
        if path == "/api/assistants":
            payload = {"list": [assistant], "selected_id": 1, "selected": assistant}
        elif path == "/api/chat":
            requests.append(request.post_data_json)
            events = [
                ("tool", {"name": "task", "call_id": "one", "arguments": {"description": "查询申请条件"}}),
                ("tool", {"name": "task", "call_id": "two", "arguments": {"description": "查询申请材料"}}),
                ("tool", {"name": "task", "call_id": "one", "arguments": {"description": "重复事件"}}),
                ("tool_result", {"name": "task", "call_id": "one", "status": "completed", "result": "已找到申请条件。<script>alert(1)</script>"}),
                ("tool_result", {"name": "task", "call_id": "two", "status": "timeout"}),
                ("delta", "已汇总可靠资料，申请材料仍需确认。"), ("done", {}),
            ]
            body = "".join(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n" for event, data in events)
            return await request_route.fulfill(body=body, content_type="text/event-stream")
        else:
            payload = []
        await request_route.fulfill(json=payload)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="msedge")
        page = await browser.new_page(viewport={"width": 1365, "height": 900})
        await page.route("**/*", route)
        await page.goto("http://campus.test/")
        await page.locator("#sendBtn:not([disabled])").wait_for()
        assert await page.locator("#collaborationGuide").count() == 0
        assert await page.locator("#collaborationPreferred").count() == 0
        await page.locator("#chatInput").fill("请分两路查询奖学金申请条件和申请材料，再汇总。")
        await page.locator("#sendBtn").click()
        await page.get_by_text("已汇总可靠资料，申请材料仍需确认。", exact=True).wait_for()
        assert requests[0]["collaboration"] is False
        await page.get_by_text("已超时", exact=True).wait_for()
        assert await page.locator(".chat-child-card").count() == 2
        assert await page.locator(".chat-team-count").inner_text() == "2 个子智能体"
        assert await page.locator(".chat-team-phase").inner_text() == "本轮已结束"
        assert await page.locator('.chat-child-card[data-status="completed"]').count() == 1
        assert await page.locator('.chat-child-card[data-status="timeout"]').count() == 1
        await page.locator(".chat-child-card summary").first.click()
        assert "已找到申请条件。<script>" in await page.locator(".chat-child-result").first.inner_text()
        assert await page.locator(".chat-child-result script").count() == 0
        summary_box = await page.locator(".chat-child-card summary").first.bounding_box()
        result_box = await page.locator(".chat-child-detail").first.bounding_box()
        assert result_box["y"] >= summary_box["y"] + summary_box["height"]
        await page.locator(".chat-child-card summary").first.click()
        output = ROOT / "outputs/collaboration-ui"
        output.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(output / "desktop.png"), full_page=True)
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.locator(".chat-team").scroll_into_view_if_needed()
        await page.screenshot(path=str(output / "mobile.png"), full_page=True)
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await page.locator(".chat-child-card summary").first.click()
        summary_box = await page.locator(".chat-child-card summary").first.bounding_box()
        result_box = await page.locator(".chat-child-detail").first.bounding_box()
        assert result_box["y"] >= summary_box["y"] + summary_box["height"]
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await browser.close()
    print("PASS: guide removed, automatic collaboration, independent agents, deduplication, statuses, safe findings, mobile layout")


if __name__ == "__main__":
    asyncio.run(main())
