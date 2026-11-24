# -*- coding: utf-8 -*-
"""13 成员 D：3D 数字人（虚拟主播版）资源与页面契约
GLTFLoader / VRM 模型必须本地 vendor（离线可用，禁止外链 CDN）；
页面须引用本地资源并提供语音开关；模型二进制头校验防止下载损坏。
"""

from conftest import ApiCase


class TestAvatarVtuber(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    # ---------------- 页面 ----------------
    def test_avatar_page_ok(self):
        resp = self.fetch("/avatar", raise_error=False)
        assert resp.code == 200
        html = resp.body.decode("utf-8")
        assert "3D 数字人" in html
        # 虚拟主播改造后必须挂 GLTFLoader 和语音开关
        assert "/static/vendor/three/GLTFLoader.js" in html
        assert "avatarTtsBtn" not in html
        assert "avatarPlaybackBtn" in html
        assert "avatarAgentSelect" in html

    def test_avatar_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.fetch("/avatar", follow_redirects=False, raise_error=False)
        assert resp.code == 302

    # ---------------- 本地 vendor 资源（离线承诺） ----------------
    def test_gltf_loader_local_vendor(self):
        resp = self.fetch("/static/vendor/three/GLTFLoader.js", raise_error=False)
        assert resp.code == 200
        assert b"GLTFLoader" in resp.body

    def test_vrm_model_local_vendor(self):
        resp = self.fetch("/static/vendor/three/models/three-vrm-girl.glb", raise_error=False)
        assert resp.code == 200
        assert resp.body[:4] == b"glTF", "VRM/glTF 二进制魔数损坏"
        assert len(resp.body) > 1000000, "模型文件过小，疑似下载不完整"
        vroid = self.fetch("/static/vendor/three/models/vroid-sample-b.vrm", raise_error=False)
        assert vroid.code == 200 and vroid.body[:4] == b"glTF"

    def test_live2d_local_vendor(self):
        prefix = "/static/vendor/live2d/"
        model = prefix + "models/Haru/"
        config = self.fetch(model + "Haru.model3.json", raise_error=False)
        assert config.code == 200
        files = self._json(config)["FileReferences"]
        assert files["Motions"]["Wave"][0]["File"] == "motions/haru_g_m12.motion3.json"
        assert self.fetch(model + files["Moc"]).body.startswith(b"MOC3")
        wave = self._json(self.fetch(model + files["Motions"]["Wave"][0]["File"]))
        wrist_curves = [curve for curve in wave["Curves"] if curve["Id"] in ("ParamHandAngleL", "ParamHandAngleR")]
        assert len(wrist_curves) == 2 and all(len(curve["Segments"]) > 10 for curve in wrist_curves)
        html = self.fetch("/avatar").body.decode("utf-8")
        for filename in ("pixi.min.js", "live2dcubismcore.min.js", "cubism4.min.js"):
            assert prefix + filename in html
            assert self.fetch(prefix + filename, raise_error=False).code == 200

    def test_page_and_js_reference_local_model(self):
        resp = self.fetch("/static/js/avatar.js", raise_error=False)
        assert resp.code == 200
        js = resp.body.decode("utf-8")
        assert "/static/vendor/three/models/three-vrm-girl.glb" in js
        # 语音走浏览器原生 Web Speech API，不允许外链 TTS
        assert "speechSynthesis" in js
        assert "http" not in js.split("MODEL_URL")[1].split("\n")[0]
