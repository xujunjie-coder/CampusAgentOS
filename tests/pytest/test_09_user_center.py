# -*- coding: utf-8 -*-
"""09 成员 D：用户中心（/user 页 + /api/user/profile|password|sessions）"""

import json

from conftest import ADMIN_PASS, ApiCase


def _restore_admin_password():
    """临时库在整个 pytest 会话内跨文件共享，改密用例必须恢复基线密码，
    否则后续文件的 login()（admin/admin123）会全部失败。"""
    from app.models.user import UserRepository
    UserRepository.change_password("admin", ADMIN_PASS)


class TestUserCenter(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    # ---------------- 鉴权 ----------------
    def test_profile_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.get_json("/api/user/profile")
        assert resp.code == 401

    def test_user_page_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.fetch("/user", follow_redirects=False, raise_error=False)
        assert resp.code == 302
        assert "/auth/login" in resp.headers.get("Location", "")

    def test_user_page_ok(self):
        resp = self.fetch("/user", raise_error=False)
        assert resp.code == 200
        assert "个人中心" in resp.body.decode("utf-8")

    # ---------------- 资料 ----------------
    def test_profile_fields(self):
        resp = self.get_json("/api/user/profile")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        profile = body["profile"]
        assert profile["username"] == "admin"
        assert "password" not in profile and "salt" not in profile
        for key in ("messages", "sessions", "faces"):
            assert key in profile["stats"]

    def test_update_nickname_and_avatar(self):
        resp = self.post_json("/api/user/profile",
                              {"nickname": "测试昵称", "avatar": "fas fa-moon"})
        assert resp.code == 200
        assert json.loads(resp.body)["profile"]["nickname"] == "测试昵称"
        # 再查一次确认落库
        profile = json.loads(self.get_json("/api/user/profile").body)["profile"]
        assert profile["nickname"] == "测试昵称"
        assert profile["avatar"] == "fas fa-moon"

    def test_update_rejects_bad_avatar(self):
        resp = self.post_json("/api/user/profile", {"avatar": "javascript:alert(1)"})
        assert resp.code == 400
        assert "头像" in json.loads(resp.body)["error"]

    def test_update_rejects_empty_payload(self):
        resp = self.post_json("/api/user/profile", {})
        assert resp.code == 400

    def test_update_rejects_non_json(self):
        resp = self.fetch("/api/user/profile", method="POST", body="raw",
                          headers={"Content-Type": "application/json"}, raise_error=False)
        assert resp.code == 400

    # ---------------- 改密 ----------------
    def test_password_wrong_old(self):
        resp = self.post_json("/api/user/password",
                              {"old_password": "错误密码", "new_password": "newpass123"})
        assert resp.code == 403

    def test_password_too_short(self):
        resp = self.post_json("/api/user/password",
                              {"old_password": ADMIN_PASS, "new_password": "123"})
        assert resp.code == 400

    def test_password_same_as_old(self):
        resp = self.post_json("/api/user/password",
                              {"old_password": ADMIN_PASS, "new_password": ADMIN_PASS})
        assert resp.code == 400

    def test_password_change_keeps_current_session(self):
        new_pass = "pytest-newpass-1"
        resp = self.post_json("/api/user/password",
                              {"old_password": ADMIN_PASS, "new_password": new_pass})
        assert resp.code == 200
        assert json.loads(resp.body)["ok"] is True
        # 当前浏览器会话仍有效（重签发了 token）
        assert self.get_json("/api/user/profile").code == 200
        # 旧密码登录失败、新密码登录成功
        self.post_form("/auth/logout", {}, follow=False)
        bad = self.post_form("/auth/login", {"username": "admin", "password": ADMIN_PASS},
                             follow=False)
        assert bad.code != 302 or "login" in bad.headers.get("Location", "")
        good = self.post_form("/auth/login", {"username": "admin", "password": new_pass},
                              follow=False)
        assert good.code == 302
        _restore_admin_password()

    # ---------------- 会话列表 ----------------
    def test_sessions_no_token_leak(self):
        resp = self.get_json("/api/user/sessions")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        for row in body["list"]:
            assert "token" not in json.dumps(row)
            assert "expires_at" in row
