# -*- coding: utf-8 -*-
"""05 信源 / 模型引擎 / 数字员工（任务5/8/9）"""

import json

from conftest import ApiCase


class TestSourcesModelsEmployees(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    # ---------------- 信源 ----------------
    def test_sources_list(self):
        body = json.loads(self.get_json("/api/admin/sources?page=1").body)
        assert body["ok"] is True
        assert "total" in body

    def test_source_requires_http_url(self):
        resp = self.post_json("/api/admin/sources",
                              {"name": "pytest源", "url": "ftp://x", "description": ""})
        assert resp.code == 400
        assert "http" in json.loads(resp.body)["error"]

    def test_source_name_too_long(self):
        resp = self.post_json("/api/admin/sources",
                              {"name": "a" * 65, "url": "https://example.com"})
        assert resp.code == 400

    def test_source_bad_headers_raw(self):
        resp = self.post_json("/api/admin/sources",
                              {"name": "pytest源2", "url": "https://example.com",
                               "headers_raw": "这不是合法的请求头"})
        assert resp.code == 400

    def test_source_create_duplicate_and_update(self):
        resp = self.post_json("/api/admin/sources",
                              {"name": "pytest官方源", "url": "https://example.com/news",
                               "headers_raw": "Accept: text/html", "description": "测试"})
        assert resp.code == 200
        resp = self.post_json("/api/admin/sources",
                              {"name": "pytest官方源", "url": "https://example.com/news"})
        assert resp.code == 400
        assert "已存在" in json.loads(resp.body)["error"]
        # 定位并清空 headers
        body = json.loads(self.get_json("/api/admin/sources?keyword=pytest官方源").body)
        row = body["list"][0]
        resp = self.post_json("/api/admin/sources/%d" % row["id"], {"headers_raw": ""})
        assert resp.code == 200

    # ---------------- 模型 ----------------
    def test_models_list_masks_api_key(self):
        resp = self.post_json("/api/admin/models",
                              {"name": "pytest模型", "api_url": "https://api.example.com/v1",
                               "model_id": "gpt-test", "type": "text",
                               "api_key": "sk-1234567890abcdef"})
        assert resp.code == 200
        body = json.loads(self.get_json("/api/admin/models?keyword=pytest模型").body)
        assert body["ok"] is True
        row = body["list"][0]
        assert "****" in row["api_key"]
        assert "token_max" in body

    def test_model_validation(self):
        resp = self.post_json("/api/admin/models",
                              {"name": "bad", "api_url": "ftp://x", "model_id": "m"})
        assert resp.code == 400
        resp = self.post_json("/api/admin/models",
                              {"name": "bad2", "api_url": "https://x", "model_id": ""})
        assert resp.code == 400

    def test_model_stats_days_clamp(self):
        body = json.loads(self.get_json("/api/admin/models/stats?days=999").body)
        assert body["days"] == 90
        body = json.loads(self.get_json("/api/admin/models/stats?days=abc").body)
        assert body["days"] == 14
        for key in ("summary", "trend", "ranking", "logs"):
            assert key in body

    def test_model_test_disabled(self):
        resp = self.post_json("/api/admin/models",
                              {"name": "pytest停用模型", "api_url": "https://api.example.com",
                               "model_id": "m", "type": "text", "enabled": 0})
        assert resp.code == 200
        mid = json.loads(resp.body)["id"]
        resp = self.post_json("/api/admin/models/%d/test" % mid,
                              {"messages": [{"role": "user", "content": "hi"}]})
        assert resp.code == 400
        assert "模型已停用" in json.loads(resp.body)["error"]

    def test_model_default_missing(self):
        resp = self.post_json("/api/admin/models/99999/default", {})
        assert resp.code in (400, 404)

    # ---------------- 数字员工 ----------------
    def test_employees_list_and_bad_status(self):
        body = json.loads(self.get_json("/api/admin/employees?page=1").body)
        assert body["ok"] is True
        resp = self.get_json("/api/admin/employees?status=weird")
        assert resp.code == 400
        assert "状态过滤" in json.loads(resp.body)["error"]

    def test_employee_detail_missing(self):
        resp = self.get_json("/api/admin/employees/99999")
        assert resp.code == 404

    def test_employee_create_requires_content(self):
        resp = self.post_json("/api/admin/employees",
                              {"name": "pytest员工", "instructions": "", "link_files": []})
        assert resp.code == 400
        assert "至少配置一项" in json.loads(resp.body)["error"]

    def test_employee_files_traversal_blocked(self):
        resp = self.get_json("/api/admin/employees/files?path=../app")
        assert resp.code == 404
        assert "workspace" in json.loads(resp.body)["error"]

    def test_employee_files_root(self):
        import os
        from app.controllers.employees import WORKSPACE_ROOT
        if not os.path.isdir(WORKSPACE_ROOT):
            import pytest
            pytest.skip("工程缺少 workspace/ 目录（任务书要求），文件浏览接口返回 404；见 acceptance-checklist.md")
        body = json.loads(self.get_json("/api/admin/employees/files?path=").body)
        assert body["ok"] is True
        assert isinstance(body["dirs"], list)
        assert isinstance(body["mds"], list)
