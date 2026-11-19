# -*- coding: utf-8 -*-
"""03 用户管理：CRUD、删除保护、批量、强制下线、登录审计（任务4/11）"""

import json

from conftest import ApiCase


class TestAdminUsers(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def _user_id(self, username):
        from app.models.user import UserRepository
        row = UserRepository.get_user_by_username(username)
        return row["id"] if row else None

    def test_list_users(self):
        resp = self.get_json("/api/admin/users?page=1")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert body["total"] >= 1
        assert isinstance(body["list"], list)

    def test_create_user_and_search(self):
        resp = self.post_json("/api/admin/users",
                              {"username": "u_pytest1", "password": "pwd123", "role": "user"})
        assert resp.code == 200
        assert json.loads(resp.body)["ok"] is True
        resp = self.get_json("/api/admin/users?keyword=u_pytest1")
        body = json.loads(resp.body)
        assert body["total"] == 1
        assert body["list"][0]["username"] == "u_pytest1"

    def test_create_user_duplicate(self):
        self.post_json("/api/admin/users",
                       {"username": "u_dup1", "password": "pwd123", "role": "user"})
        resp = self.post_json("/api/admin/users",
                              {"username": "u_dup1", "password": "pwd123", "role": "user"})
        assert resp.code == 400
        assert "已存在" in json.loads(resp.body)["error"]

    def test_create_user_invalid_username(self):
        resp = self.post_json("/api/admin/users",
                              {"username": "ab", "password": "pwd123", "role": "user"})
        assert resp.code == 400

    def test_create_user_short_password(self):
        resp = self.post_json("/api/admin/users",
                              {"username": "u_short1", "password": "123", "role": "user"})
        assert resp.code == 400

    def test_create_user_unknown_role(self):
        resp = self.post_json("/api/admin/users",
                              {"username": "u_role1", "password": "pwd123", "role": "ghost"})
        assert resp.code == 400
        assert "角色不存在" in json.loads(resp.body)["error"]

    def test_update_password(self):
        self.post_json("/api/admin/users",
                       {"username": "u_pwd1", "password": "oldpwd1", "role": "user"})
        uid = self._user_id("u_pwd1")
        resp = self.post_json("/api/admin/users/%d" % uid, {"password": "newpwd1"})
        assert resp.code == 200
        # 旧密码失效
        resp = self.post_form("/auth/login",
                              {"username": "u_pwd1", "password": "oldpwd1"}, follow=False)
        assert resp.code == 401
        # 新密码可登录
        resp = self.login_user("u_pwd1", "newpwd1")
        assert resp.code == 302

    def test_delete_self_is_blocked(self):
        uid = self._user_id("admin")
        resp = self.delete("/api/admin/users/%d" % uid)
        assert resp.code == 400
        assert "不能删除当前登录" in json.loads(resp.body)["error"]

    def test_delete_user_ok(self):
        self.post_json("/api/admin/users",
                       {"username": "u_del1", "password": "pwd123", "role": "user"})
        uid = self._user_id("u_del1")
        resp = self.delete("/api/admin/users/%d" % uid)
        assert resp.code == 200
        assert self._user_id("u_del1") is None

    def test_delete_missing_user_is_idempotent(self):
        resp = self.delete("/api/admin/users/99999")
        assert resp.code == 200

    def test_batch_delete_empty(self):
        resp = self.post_json("/api/admin/users/batch", {"ids": []})
        assert resp.code == 400
        assert "没有可删除的项" in json.loads(resp.body)["error"]

    def test_batch_delete_excludes_self(self):
        admin_id = self._user_id("admin")
        resp = self.post_json("/api/admin/users/batch", {"ids": [admin_id]})
        assert resp.code == 400
        assert "当前登录账号已排除" in json.loads(resp.body)["error"]

    def test_batch_delete_ids_must_be_numbers(self):
        resp = self.post_json("/api/admin/users/batch", {"ids": ["abc"]})
        assert resp.code == 400

    def test_force_logout(self):
        self.post_json("/api/admin/users",
                       {"username": "u_kick1", "password": "pwd123", "role": "user"})
        uid = self._user_id("u_kick1")
        resp = self.post_json("/api/admin/users/%d/logout" % uid, {})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["username"] == "u_kick1"
        assert "revoked" in body

    def test_force_logout_missing_user(self):
        resp = self.post_json("/api/admin/users/99999/logout", {})
        assert resp.code == 404

    def test_login_logs(self):
        resp = self.get_json("/api/admin/login-logs?page=1")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)
        assert "total" in body
