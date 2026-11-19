# -*- coding: utf-8 -*-
"""04 角色 / 菜单 / 权限树（任务4）"""

import json

from conftest import ApiCase


class TestRolesMenus(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_roles_list(self):
        resp = self.get_json("/api/admin/roles?page=1")
        body = json.loads(resp.body)
        assert resp.code == 200 and body["ok"] is True
        assert body["total"] >= 2  # admin + user

    def test_roles_all(self):
        body = json.loads(self.get_json("/api/admin/roles?all=1").body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)

    def test_create_role_and_duplicate(self):
        resp = self.post_json("/api/admin/roles",
                              {"code": "qa", "name": "质检员", "description": "测试用"})
        assert resp.code == 200
        resp = self.post_json("/api/admin/roles", {"code": "qa", "name": "质检员"})
        assert resp.code == 400
        assert "已存在" in json.loads(resp.body)["error"]

    def test_create_role_requires_fields(self):
        resp = self.post_json("/api/admin/roles", {"code": "", "name": ""})
        assert resp.code == 400

    def test_admin_role_cannot_be_deleted(self):
        from app.models.role import RoleRepository
        admin_role = RoleRepository.get_by_code("admin")
        resp = self.delete("/api/admin/roles/%d" % admin_role["id"])
        assert resp.code == 400
        assert "不允许删除" in json.loads(resp.body)["error"]

    def test_role_in_use_cannot_be_deleted(self):
        from app.models.role import RoleRepository
        user_role = RoleRepository.get_by_code("user")
        resp = self.delete("/api/admin/roles/%d" % user_role["id"])
        assert resp.code == 400
        assert "仍有用户" in json.loads(resp.body)["error"]

    def test_role_menus_get_and_assign(self):
        from app.models.role import RoleRepository
        self.post_json("/api/admin/roles", {"code": "qa2", "name": "质检员2"})
        role = RoleRepository.get_by_code("qa2")
        body = json.loads(self.get_json("/api/admin/roles/%d/menus" % role["id"]).body)
        assert body["ok"] is True
        assert isinstance(body["tree"], list)
        assert "assigned" in body
        resp = self.post_json("/api/admin/roles/%d/menus" % role["id"], {"menu_ids": [1]})
        assert resp.code == 200
        assert json.loads(resp.body)["assigned"] == [1]

    def test_admin_role_menus_assign_rejected(self):
        from app.models.role import RoleRepository
        role = RoleRepository.get_by_code("admin")
        resp = self.post_json("/api/admin/roles/%d/menus" % role["id"], {"menu_ids": [1]})
        assert resp.code == 400
        assert "无需分配" in json.loads(resp.body)["error"]

    def test_menus_tree_and_roots(self):
        body = json.loads(self.get_json("/api/admin/menus?tree=1").body)
        assert body["ok"] is True and isinstance(body["list"], list)
        body = json.loads(self.get_json("/api/admin/menus?roots=1").body)
        assert body["ok"] is True and isinstance(body["list"], list)

    def test_menu_sort_requires_items(self):
        resp = self.post_json("/api/admin/menus/sort", {"items": []})
        assert resp.code == 400
        assert "items 不能为空" in json.loads(resp.body)["error"]

    def test_menu_create_requires_name(self):
        resp = self.post_json("/api/admin/menus", {"name": "", "parent_id": 0})
        assert resp.code == 400

    def test_menu_with_children_cannot_be_deleted(self):
        resp = self.post_json("/api/admin/menus",
                             {"name": "pytest父菜单", "parent_id": 0, "url": "/admin/pytest-parent"})
        assert resp.code == 200
        from app.models.menu import MenuRepository
        parent = MenuRepository.get_by_url("/admin/pytest-parent")
        resp = self.post_json("/api/admin/menus",
                             {"name": "pytest子菜单", "parent_id": parent["id"], "url": ""})
        assert resp.code == 200
        resp = self.delete("/api/admin/menus/%d" % parent["id"])
        assert resp.code == 400

    def test_limited_backend_role_forbidden(self):
        code, password = self.ensure_backend_role_without_menus()
        self.login_user(code, password)
        resp = self.get_json("/api/admin/users")
        assert resp.code == 403
        assert json.loads(resp.body)["ok"] is False
