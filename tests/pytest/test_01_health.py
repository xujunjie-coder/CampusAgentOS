# -*- coding: utf-8 -*-
"""01 健康检查与框架级行为（任务15/17）"""

import json

from conftest import ApiCase


class TestHealth(ApiCase):
    def test_healthz_ok(self):
        resp = self.get_json("/healthz")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert body["db"] == "sqlite"
        assert body["version"].startswith("v"), body
        assert resp.headers["Cache-Control"] == "no-store"

    def test_healthz_is_anonymous(self):
        """未登录也能探活"""
        resp = self.fetch("/healthz", method="GET", raise_error=False)
        assert resp.code == 200

    def test_unknown_api_returns_json_404(self):
        resp = self.get_json("/api/not-exists")
        assert resp.code == 404
        body = json.loads(resp.body)
        assert body["ok"] is False
        assert body["code"] == "NOT_FOUND"
        assert body.get("request_id")

    def test_unknown_page_renders_error_page(self):
        resp = self.fetch("/not-a-page", method="GET", raise_error=False,
                          headers={"Accept": "text/html"})
        assert resp.code == 404
        assert "text/html" in resp.headers.get("Content-Type", "")

    def test_security_headers_present(self):
        resp = self.get_json("/healthz")
        assert resp.headers["X-Content-Type-Options"] == "nosniff"
        assert resp.headers["X-Frame-Options"] == "SAMEORIGIN"
        assert resp.headers.get("X-Request-Id")

    def test_request_id_passthrough(self):
        resp = self.fetch("/healthz", method="GET",
                          headers={"X-Request-Id": "pytest-rid-001"}, raise_error=False)
        assert resp.headers["X-Request-Id"] == "pytest-rid-001"

    def test_options_preflight(self):
        resp = self.fetch("/api/chat", method="OPTIONS", raise_error=False)
        assert resp.code == 204

    def test_wrong_method_on_api(self):
        self.login()
        resp = self.delete("/api/chat")
        assert resp.code == 405
        body = json.loads(resp.body)
        assert body["ok"] is False
        assert body["code"] == "METHOD_NOT_ALLOWED"
