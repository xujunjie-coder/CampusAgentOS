"""Check real dashboard scrolling with mocked snapshots and local static assets."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

from playwright.async_api import async_playwright
from tornado.template import Loader

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def main():
    html = Loader(str(ROOT / "app/templates")).load("admin/dashboard.html").generate(
        site_favicon="", site_logo="", refresh_seconds=10, watermark=False,
        static_url=lambda path: "/static/" + path,
        _tt_modules=SimpleNamespace(xsrf_form_html=lambda: b""),
    )
    rows = [{"title": f"第{i}条：在食堂这一份 25 正常吗？ [B_0525fc6a888f08001441152187792247830X60]",
             "level": "normal", "level_label": "常规", "reviewed_at": "2026-11-24 04:26",
             "source_name": "校园频道", "reason": "测试线索", "evidence": "正文", "collected_at": "2026-11-24 04:26"}
            for i in range(1, 9)]
    collect = [9, 12, 254, 2, 0, 1, 0, 2, 0, 12, 81, 9, 18, 69]
    messages = [6, 8, 22, 2, 0, 1, 0, 2, 0, 9, 2, 15, 6, 4]
    trend = [{"date": f"2026-11-{11+i}", "collect": collect[i], "messages": messages[i]} for i in range(14)]
    snapshot = {"overview": {}, "trend": trend, "by_risk": [], "by_source": [], "keywords": [],
                "by_region": {"list": [], "matched": 0, "scanned": 0},
                "latest_risks": rows, "recent_items": rows, "generated_at": "2026-11-24 17:30"}

    async def route(r):
        path = urlsplit(r.request.url).path
        if path == "/":
            return await r.fulfill(body=html, content_type="text/html; charset=utf-8")
        if path.startswith("/static/"):
            file = ROOT / "app" / path.lstrip("/")
            return await r.fulfill(path=str(file)) if file.is_file() else await r.abort()
        await r.fulfill(json={"snapshot": snapshot})

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", ignore_default_args=["--hide-scrollbars"])
        page = await browser.new_page(viewport={"width": 1600, "height": 900}, reduced_motion="reduce")
        await page.add_init_script("""
            localStorage.setItem('ckb_sound', '0');
            window.EventSource = class {
                constructor() { this.listeners = {}; window.feedSource = this; }
                addEventListener(name, callback) { this.listeners[name] = callback; }
                close() {}
            };
        """)
        await page.route("**/*", route)
        await page.goto("http://dashboard.test/")
        await page.wait_for_function("window.feedSource")

        async def emit():
            await page.evaluate("snap => feedSource.listeners.snapshot({data: JSON.stringify(snap)})", snapshot)

        await emit()
        feed = page.locator("#feedRisk")
        assert await feed.locator("li").count() == 8
        assert await page.locator("#feedSub").inner_text() == "最近 8 条"
        assert "[B_" not in await feed.inner_text()
        assert "[B_" not in await page.locator("#footTicker").inner_text()
        output = ROOT / "outputs/dashboard-feed"
        output.mkdir(parents=True, exist_ok=True)
        for width, height in [(1600, 900), (1280, 720)]:
            await page.set_viewport_size({"width": width, "height": height})
            assert await feed.evaluate("el => el.scrollHeight > el.clientHeight")
            await feed.hover()
            await page.mouse.wheel(0, 1000)
            await page.wait_for_function("document.getElementById('feedRisk').scrollTop > 0")
            await feed.evaluate("el => el.scrollTop = el.scrollHeight")
            previous = await feed.evaluate("el => el.scrollTop")
            await emit()
            assert abs(await feed.evaluate("el => el.scrollTop") - previous) <= 1
            last = await feed.locator("li").last.bounding_box()
            bounds = await feed.bounding_box()
            assert last["y"] >= bounds["y"] and last["y"] + last["height"] <= bounds["y"] + bounds["height"] + 1
            await page.screenshot(path=str(output / f"{width}.png"))
        await feed.locator("li").last.click()
        assert "第8条" in await page.locator("#drillTitle").inner_text()
        assert "[B_" not in await page.locator("#drillTitle").inner_text()
        await browser.close()
    print("PASS: 8 rows, wheel scrolling, eighth-row details, refresh position, clean feed/ticker titles")


if __name__ == "__main__":
    asyncio.run(main())
