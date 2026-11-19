# -*- coding: utf-8 -*-
"""06 采集 / 数据仓库（任务6/7）"""

import json

from conftest import ApiCase


class TestCollectWarehouse(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    # ---------------- 采集 ----------------
    def test_collect_sources_hides_headers(self):
        body = json.loads(self.get_json("/api/collect/sources").body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)
        for row in body["list"]:
            assert "headers" not in row

    def test_collect_run_requires_keyword(self):
        resp = self.post_json("/api/collect/run", {"keyword": "", "source_ids": [1]})
        assert resp.code == 400
        assert "关键词" in json.loads(resp.body)["error"]

    def test_collect_run_requires_source(self):
        resp = self.post_json("/api/collect/run", {"keyword": "测试", "source_ids": []})
        assert resp.code == 400
        assert "信源" in json.loads(resp.body)["error"]

    def test_collect_run_limits_sources(self):
        resp = self.post_json("/api/collect/run",
                              {"keyword": "测试", "source_ids": list(range(1, 13))})
        assert resp.code == 400
        assert "10" in json.loads(resp.body)["error"]

    def test_collect_run_keyword_too_long(self):
        resp = self.post_json("/api/collect/run",
                              {"keyword": "长" * 65, "source_ids": [1]})
        assert resp.code == 400

    def test_collect_items_page_size(self):
        body = json.loads(self.get_json("/api/collect/items?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 12
        assert body["page"] == 1

    # ---------------- 数据仓库 ----------------
    def test_admin_warehouse_list(self):
        body = json.loads(self.get_json("/api/admin/warehouse?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 20
        for key in ("total", "done", "failed", "pending", "list"):
            assert key in body

    def test_admin_warehouse_detail_missing(self):
        resp = self.get_json("/api/admin/warehouse/99999/detail")
        assert resp.code == 404
        assert "不存在" in json.loads(resp.body)["error"]

    def test_admin_warehouse_batch_empty(self):
        resp = self.post_json("/api/admin/warehouse/batch", {"ids": []})
        assert resp.code == 400

    def test_admin_warehouse_sources(self):
        body = json.loads(self.get_json("/api/admin/warehouse/sources").body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)

    def test_warehouse_items_public(self):
        body = json.loads(self.get_json("/api/warehouse/items?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 20

    def test_deep_one_requires_item_id(self):
        resp = self.get_json("/api/warehouse/deep/one")
        assert resp.code == 400
        assert "item_id" in json.loads(resp.body)["error"]

    def test_deep_batch_requires_scope(self):
        resp = self.get_json("/api/warehouse/deep/batch")
        assert resp.code == 400
