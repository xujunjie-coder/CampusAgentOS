"""Exercise the real face dialog with mocked APIs and a synthetic camera."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

from playwright.async_api import async_playwright, expect
from tornado.template import Loader

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "outputs/face-settings-ui"


async def main():
    print("Rendering face settings template", flush=True)
    html = Loader(str(ROOT / "app/templates")).load("index.html").generate(
        title="人脸设置预览", username="preview", role="user", site_name="智慧校园",
        site_favicon="", static_url=lambda path: "/static/" + path,
        _tt_modules=SimpleNamespace(xsrf_form_html=lambda: b'<input name="_xsrf" value="test" hidden>'),
    )
    faces = [dict(id=3, face_label="日常照片", enabled=True, quality=.88,
                  created_at="2026-11-24 14:30", needs_reenrollment=False)]
    status = dict(ok=True, enabled=True, degraded=False)
    submissions = []
    toggles = []

    async def route(intercept):
        request = intercept.request
        path = request.url.split("localhost", 1)[1].split("?", 1)[0]
        if path == "/":
            return await intercept.fulfill(body=html, content_type="text/html; charset=utf-8")
        if path.startswith("/static/"):
            # Isolate the dialog from unrelated chat/music requests.
            if path.endswith(".js") and path.rsplit("/", 1)[-1] not in ("face.js", "face-capture.js"):
                return await intercept.fulfill(body="", content_type="application/javascript")
            file = ROOT / "app" / path.lstrip("/")
            return await intercept.fulfill(path=str(file)) if file.is_file() else await intercept.abort()
        if path == "/api/face/status":
            payload = dict(status, faces=list(faces), count=len(faces))
        elif path == "/api/face/enroll":
            submissions.append(request.post_data_json)
            faces.append(dict(id=4, face_label=request.post_data_json["label"], enabled=True,
                              quality=.91, created_at="2026-11-24 14:35"))
            status["enabled"] = True
            payload = dict(ok=True, count=len(faces), quality=.91)
        elif path == "/api/face/toggle":
            toggles.append(request.post_data_json)
            status["enabled"] = request.post_data_json["enabled"]
            payload = dict(ok=True, enabled=status["enabled"])
        elif request.method == "DELETE":
            faces[:] = [face for face in faces if str(face["id"]) != path.rsplit("/", 1)[-1]]
            payload = dict(ok=True, count=len(faces))
        else:
            payload = {}
        await intercept.fulfill(json=payload)

    print("Starting browser checks", flush=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="msedge", timeout=20000)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        await page.route("**/*", route)
        await page.goto("http://localhost/")
        await page.locator("#chatSideFoot").evaluate("e => e.classList.add('open')")
        print("Checking dialog layout and actions", flush=True)
        # Camera frames come from an animated canvas, not a user's real camera.
        await page.evaluate("""() => {
            window.cameraMode = 'ok'; window.stoppedTracks = 0;
            navigator.mediaDevices.getUserMedia = async () => {
                if (window.cameraMode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
                if (window.cameraMode === 'pending') await new Promise(resolve => window.releaseCamera = resolve);
                const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 540;
                const ctx = canvas.getContext('2d'); let tick = 0, running = true;
                const draw = () => {
                    ctx.fillStyle = '#b9cbd6'; ctx.fillRect(0, 0, 720, 540);
                    ctx.fillStyle = '#647e99'; ctx.beginPath(); ctx.ellipse(360, 520, 170, 150, 0, 0, 7); ctx.fill();
                    ctx.fillStyle = '#e8ceb9'; ctx.beginPath(); ctx.ellipse(360, 245, 85, 115, 0, 0, 7); ctx.fill();
                    ctx.fillStyle = '#43546a'; ctx.fillRect(323, 230, 12, 8); ctx.fillRect(385, 230, 12, 8);
                    ctx.fillStyle = '#a07b6e'; ctx.fillRect(340, 290, 40, 5);
                    ctx.fillStyle = '#fff'; ctx.fillRect((tick++ % 100), 0, 2, 2);
                    if (running) requestAnimationFrame(draw);
                }; draw();
                const stream = canvas.captureStream(30);
                stream.getTracks().forEach(track => {
                    const stop = track.stop.bind(track);
                    track.stop = () => { running = false; window.stoppedTracks++; stop(); };
                });
                return stream;
            };
        }""")
        OUTPUT.mkdir(parents=True, exist_ok=True)
        await page.locator("#faceEntry").click()
        await expect(page.locator("#faceStart")).to_be_enabled()
        await expect(page.locator("#faceEngine")).to_be_hidden()
        await expect(page.locator("#faceSubmit")).to_be_hidden()
        await expect(page.locator("#faceCapture")).to_be_hidden()
        await expect(page.locator("#faceRetake")).to_be_hidden()
        await expect(page.locator("#faceCount")).to_have_text("1")
        await expect(page.locator("[data-face-del]")).to_be_hidden()
        await page.screenshot(path=str(OUTPUT / "desktop.png"), animations="disabled")

        for width in (390, 320):
            await page.set_viewport_size({"width": width, "height": 844})
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert await page.locator(".face-dialog").evaluate("e => e.scrollWidth <= e.clientWidth")
            if width == 390:
                await page.screenshot(path=str(OUTPUT / "mobile.png"), animations="disabled")
        await page.set_viewport_size({"width": 1440, "height": 1000})

        # The account switch is independent of per-record status.
        await page.locator(".face-switch").click()
        await expect(page.locator("#faceEnabled")).not_to_be_checked()
        assert toggles == [{"enabled": False}]
        await expect(page.locator(".face-status-badge")).to_have_text("已启用")

        # Camera -> shutter -> preview -> retake -> preview -> enroll.
        await page.locator("#faceStart").click()
        await expect(page.locator("#faceStage")).to_have_class("face-stage is-live")
        await page.wait_for_function("document.querySelector('#faceVideo').readyState >= 2")
        await expect(page.locator("#faceCapture")).to_be_visible()
        await page.locator("#faceCapture").click()
        await expect(page.locator("#faceSubmit")).to_be_visible()
        await expect(page.locator("#faceCapture")).to_be_hidden()
        await expect(page.locator("#faceEnroll")).to_be_focused()
        await page.screenshot(path=str(OUTPUT / "preview.png"), animations="disabled")
        await page.locator("#faceRetake").click()
        await expect(page.locator("#faceCapture")).to_be_visible()
        await page.locator("#faceCapture").click()
        await expect(page.locator("#faceEnroll")).to_be_enabled()
        await page.locator("#faceLabel").fill("新照片")
        await page.locator("#faceEnroll").click()
        await expect(page.locator("#faceCount")).to_have_text("2")
        assert len(submissions[0]["frames"]) == 3
        assert submissions[0]["label"] == "新照片"
        await expect(page.locator("#faceEnabled")).to_be_checked()
        await expect(page.locator("#faceSubmit")).to_be_hidden()
        assert await page.evaluate("window.stoppedTracks") > 0

        # Invalid uploads stay in the current state; valid uploads use photo confirmation.
        await page.locator("#faceFile").set_input_files(dict(name="bad.txt", mimeType="text/plain", buffer=b"bad"))
        await expect(page.locator("#faceHint")).to_contain_text("仅支持")
        image = OUTPUT / "preview.png"
        await page.locator("#faceFile").set_input_files(str(image))
        await expect(page.locator("#faceEnroll")).to_be_visible()
        await expect(page.locator("#faceRetake")).to_have_text("重新选择")
        async with page.expect_file_chooser() as chooser:
            await page.locator("#faceRetake").click()
        await (await chooser.value).set_files(str(image))
        await page.locator("#faceEnroll").click()
        await expect(page.locator("#faceCount")).to_have_text("3")
        assert "image" in submissions[1] and "frames" not in submissions[1]

        await page.locator(".face-row-details summary").first.click()
        await page.locator("[data-face-del]").first.click()
        await expect(page.locator("#faceCount")).to_have_text("2")
        await page.keyboard.press("Escape")
        await expect(page.locator("#faceMask")).to_be_hidden()
        await expect(page.locator("#faceEntry")).to_be_focused()

        # Permission failure leaves upload available, and late permission releases tracks.
        await page.locator("#faceEntry").click()
        await expect(page.locator("#faceStart")).to_be_enabled()
        await page.evaluate("window.cameraMode = 'denied'")
        await page.locator("#faceStart").click()
        await expect(page.locator("#faceHint")).to_contain_text("权限被拒绝")
        await expect(page.locator("#faceUpload")).to_be_enabled()
        await page.evaluate("window.cameraMode = 'pending'")
        await page.locator("#faceStart").click()
        await page.wait_for_function("!!window.releaseCamera")
        previous = await page.evaluate("window.stoppedTracks")
        await page.locator("#faceClose").click()
        await page.evaluate("window.releaseCamera()")
        await page.wait_for_function("n => window.stoppedTracks > n", arg=previous)
        await expect(page.locator("#faceMask")).to_be_hidden()

        # Empty/incompatible records and unavailable engines are visibly actionable.
        faces.clear()
        await page.locator("#faceEntry").click()
        await expect(page.locator(".face-empty")).to_be_visible()
        await expect(page.locator("#faceEnabled")).to_be_disabled()
        await page.locator("#faceClose").click()
        status.update(degraded=True, reason="模型未加载")
        await page.locator("#faceEntry").click()
        await expect(page.locator("#faceEngine")).to_contain_text("模型未加载")
        await expect(page.locator("#faceStart")).to_be_disabled()
        await expect(page.locator("#faceUpload")).to_be_disabled()
        assert not errors, errors
        await browser.close()
    print("PASS: desktop/mobile, camera/retake, upload/reselect, enroll, toggle, delete, empty/degraded, permission/close cleanup")


if __name__ == "__main__":
    asyncio.run(main())
