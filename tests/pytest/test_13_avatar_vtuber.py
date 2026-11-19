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
        assert "avatarTtsBtn" in html

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

    def test_page_and_js_reference_local_model(self):
        resp = self.fetch("/static/js/avatar.js", raise_error=False)
        assert resp.code == 200
        js = resp.body.decode("utf-8")
        assert "/static/vendor/three/models/three-vrm-girl.glb" in js
        # 语音走浏览器原生 Web Speech API，不允许外链 TTS
        assert "speechSynthesis" in js
        assert "http" not in js.split("MODEL_URL")[1].split("\n")[0]
