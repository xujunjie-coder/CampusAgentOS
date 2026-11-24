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
                ("tool_result", {"name": "task", "call_id": "one", "status": "completed"}),
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
        await page.locator("#collaborationGuide summary").click()
        await page.locator("[data-collaboration-example]").first.click()
        assert await page.locator("#collaborationPreferred").is_checked()
        assert "奖学金" in await page.locator("#chatInput").input_value()
        assert not requests, "Example must not submit automatically"
        await page.locator("#sendBtn").click()
        await page.get_by_text("已汇总可靠资料，申请材料仍需确认。", exact=True).wait_for()
        assert requests[0]["collaboration"] is True
        assert not await page.locator("#collaborationPreferred").is_checked()
        await page.get_by_text("等待超时，主助理将汇总已有资料", exact=True).wait_for()
        assert await page.locator(".chat-process.collapsed").count() == 0
        output = ROOT / "outputs/collaboration-ui"
        output.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(output / "desktop.png"), full_page=True)
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.screenshot(path=str(output / "mobile.png"), full_page=True)
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await browser.close()
    print("PASS: example, one-turn preference, task statuses, expanded progress, mobile layout")


if __name__ == "__main__":
    asyncio.run(main())
