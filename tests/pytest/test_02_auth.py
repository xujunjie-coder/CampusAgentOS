# -*- coding: utf-8 -*-
"""02 认证：登录 / 注册 / 登出 / 未登录契约（任务11/12）"""

import json

from conftest import ApiCase


class TestAuth(ApiCase):
    def test_api_unauthorized_is_json_401(self):
        resp = self.get_json("/api/admin/users")
        assert resp.code == 401
        body = json.loads(resp.body)
        assert body["ok"] is False
        assert body["error"] == "未登录"
        assert body["code"] == "UNAUTHORIZED"

    def test_page_unauthorized_redirects_to_login(self):
        resp = self.fetch("/admin", method="GET", raise_error=False, follow_redirects=False)
        assert resp.code == 302
        assert "/auth/login" in resp.headers["Location"]

    def test_login_empty_fields(self):
        resp = self.post_form("/auth/login", {"username": "", "password": ""}, follow=False)
        assert resp.code == 400

    def test_login_wrong_password(self):
        resp = self.post_form("/auth/login",
                              {"username": "admin", "password": "wrong-pass"}, follow=False)
        assert resp.code == 401

    def test_login_success_redirects_admin(self):
        resp = self.login()
        assert resp.headers["Location"].endswith("/admin")

    def test_login_grants_admin_api_access(self):
        self.login()
        resp = self.get_json("/api/admin/users")
        assert resp.code == 200

    def test_logout_revokes_session(self):
        self.login()
        resp = self.post_form("/auth/logout", {}, follow=False)
        assert resp.code == 302
        resp = self.get_json("/api/admin/users")
        assert resp.code == 401

    def test_register_short_password(self):
        resp = self.post_form("/auth/register",
                              {"username": "newbie1", "password": "123", "confirm": "123"},
                              follow=False)
        assert resp.code == 400

    def test_register_created_and_login(self):
        resp = self.post_form("/auth/register",
                              {"username": "newbie2", "password": "pwd123", "confirm": "pwd123"},
                              follow=False)
        assert resp.code == 302
        # 重复注册
        resp = self.post_form("/auth/register",
                              {"username": "newbie2", "password": "pwd123", "confirm": "pwd123"},
                              follow=False)
        assert resp.code == 400
        # 普通用户登录后跳 /
        resp = self.login_user("newbie2", "pwd123")
        assert resp.headers["Location"] == "/"

    def test_next_open_redirect_is_blocked(self):
        self.post_form("/auth/register",
                       {"username": "redir1", "password": "pwd123", "confirm": "pwd123"},
                       follow=False)
        resp = self.post_form("/auth/login",
                              {"username": "redir1", "password": "pwd123", "next": "//evil.com"},
                              follow=False)
        assert resp.code == 302
        assert resp.headers["Location"] == "/"

    def test_face_login_without_image(self):
        resp = self.fetch("/auth/face/login", method="POST", body="{}",
                          headers={"Content-Type": "application/json"}, raise_error=False)
        assert resp.code == 400
