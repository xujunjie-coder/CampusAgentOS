# -*- coding: utf-8 -*-
"""15 系统设置 / 工具链路（成员 C · 任务三）

覆盖点：
1. 设置页可访问，模板注入 values/database/mysql/drivers/face_engines/env_path；
2. 品牌配置落库后，全站标题与后台顶栏同步（动态系统名称验收项）；
3. 输入校验（空名称、超长名称、非法图片、非法阈值）都返回 400 而不是 500；
4. 数据库页只做连通性测试，**不触发真实切换**（切换会改 .env，测试禁止）；
5. 非超管访问设置页被拒；工具链路接口形状稳定。
"""

import json
import os
import shutil
import tempfile

from conftest import ApiCase

PNG_1X1 = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"
           "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class TestSettings(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()
        # 图标落盘目录改到临时目录：避免把测试图片写进仓库 app/static/uploads/brand/
        from app.services import settings_service
        self._brand_dir = tempfile.mkdtemp(prefix="ck_brand_")
        settings_service.BRAND_DIR = self._brand_dir

    def tearDown(self):
        shutil.rmtree(self._brand_dir, ignore_errors=True)
        super().tearDown()

    # ---------------- 页面 ----------------
    def test_settings_page(self):
        resp = self.fetch("/admin/settings", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        for section in ("系统标识", "数据库连接", "语音与人脸模型", "安全与会话"):
            assert section in body
        assert "/static/js/settings.js" in body

    def test_tools_page(self):
        resp = self.fetch("/admin/tools", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "工具链路" in body
        assert "/static/js/tools.js" in body

    # ---------------- 接口：读取 ----------------
    def test_get_settings(self):
        resp = self.get_json("/api/admin/settings")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert set(body["values"].keys()) >= {"site_name", "site_subtitle", "site_logo",
                                              "site_favicon", "ui_watermark", "dashboard_refresh",
                                              "tts_voice", "tts_rate", "face_engine", "face_threshold"}
        assert body["database"]["driver"] in ("sqlite", "mysql")
        assert isinstance(body["drivers"], list) and len(body["drivers"]) == 2
        assert isinstance(body["face_engines"], list) and body["face_engines"]
        assert body["env_path"]

    # ---------------- 接口：品牌保存 ----------------
    def test_save_brand_and_reflect_everywhere(self):
        payload = {"action": "save", "group": "brand",
                   "values": {"site_name": "政务数据验收平台", "site_subtitle": "验收演示",
                              "ui_watermark": "0", "dashboard_refresh": "15"}}
        resp = self.post_json("/api/admin/settings", payload)
        assert resp.code == 200
        assert json.loads(resp.body)["ok"] is True
        # 回读
        resp = self.get_json("/api/admin/settings")
        values = json.loads(resp.body)["values"]
        assert values["site_name"] == "政务数据验收平台"
        assert values["dashboard_refresh"] == "15"
        # 全站生效：后台壳的标题/品牌名
        resp = self.fetch("/admin", raise_error=False)
        assert "政务数据验收平台" in resp.body.decode("utf-8")

    def test_save_brand_rejects_empty_name(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "save", "group": "brand", "values": {"site_name": ""}})
        assert resp.code == 400
        assert "名称" in json.loads(resp.body)["error"]

    def test_save_brand_rejects_long_name(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "save", "group": "brand",
                               "values": {"site_name": "长" * 60}})
        assert resp.code == 400

    def test_unknown_group_rejected(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "save", "group": "nope", "values": {"x": "1"}})
        assert resp.code == 400

    # ---------------- 接口：图标上传 ----------------
    def test_brand_image_upload(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "brand", "kind": "logo", "data_uri": PNG_1X1})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["url"].startswith("/static/uploads/brand/")
        assert body["ext"] == "png"
        assert body["size"] > 0

    def test_brand_image_rejects_non_image(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "brand", "kind": "logo",
                               "data_uri": "data:text/plain;base64,aGVsbG8="})
        assert resp.code == 400
        assert "图片" in json.loads(resp.body)["error"]

    def test_brand_image_rejects_unknown_kind(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "brand", "kind": "avatar", "data_uri": PNG_1X1})
        assert resp.code == 400

    # ---------------- 接口：数据库 ----------------
    def test_db_test_sqlite(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "db_test", "driver": "sqlite", "params": {}})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True and body["driver"] == "sqlite"

    def test_db_test_unknown_driver(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "db_test", "driver": "oracle", "params": {}})
        assert resp.code == 400

    def test_db_switch_same_driver_rejected(self):
        # 测试库固定 sqlite：再切 sqlite 应被拒，避免无意义写 .env
        resp = self.post_json("/api/admin/settings",
                              {"action": "db_switch", "driver": "sqlite", "params": {}})
        assert resp.code == 400
        assert "SQLite" in json.loads(resp.body)["error"]

    # ---------------- 接口：语音校验（失败分支不落 .env） ----------------
    def test_voice_invalid_threshold(self):
        resp = self.post_json("/api/admin/settings",
                              {"action": "save", "group": "voice",
                               "values": {"face_threshold": "5.0", "tts_rate": "1.0"}})
        assert resp.code == 400

    # ---------------- 工具链路 ----------------
    def test_tools_api(self):
        resp = self.get_json("/api/admin/tools")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        ids = {t["id"] for t in body["tools"]}
        # 六个工具与 agent_service 注册表对齐；少一个说明注册/展示脱节
        assert {"weather", "todo", "task", "memory", "warehouse", "mcp_search"} <= ids
        assert body["total_tools"] >= 6
        assert isinstance(body["employees"], list)

    # ---------------- 权限 ----------------
    def test_settings_denied_for_normal_user(self):
        self.ensure_user("u_norm1", "pwd123", "user")
        self.login_user("u_norm1", "pwd123")
        resp = self.fetch("/admin/settings", raise_error=False, follow_redirects=False)
        assert resp.code in (302, 403)
