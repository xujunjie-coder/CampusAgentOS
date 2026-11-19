# -*- coding: utf-8 -*-
"""14 数智大屏 / 统计报表 / 大屏问答（成员 C · 任务二）

覆盖点：
1. 大屏、报表页可访问且正确挂载 ECharts / bootstrap vendor（技术栈验收项）；
2. /api/stats/snapshot 结构稳定（大屏与报表共用同一份聚合口径）；
3. /api/dashboard/ask 走确定性规则，不依赖外部大模型也能答；
4. 未登录访问返回 302/403，不泄露数据。
"""

import json

from conftest import ApiCase

SNAPSHOT_KEYS = {"generated_at", "days", "overview", "trend", "by_source", "by_risk", "keywords",
                 "by_region", "risk_trend", "latest_risks", "high_risks", "recent_items"}


class TestDashboardReports(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    # ---------------- 页面 ----------------
    def test_dashboard_page(self):
        resp = self.fetch("/admin/dashboard", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "数智大屏" in body
        # 大屏是独立全屏模板：必须自带 ECharts 与 bootstrap-grid（缺一项扣 10%）
        assert "/static/vendor/echarts/echarts.min.js" in body
        assert "/static/vendor/bootstrap/bootstrap-grid.min.css" in body
        assert "/static/js/dashboard.js" in body

    def test_reports_page(self):
        resp = self.fetch("/admin/reports", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "统计报表" in body
        assert "/static/js/reports.js" in body
        assert "/static/js/chart-kit.js" in body
        assert "/static/vendor/bootstrap/bootstrap-grid.min.css" in body

    def test_sentiment_page_renders(self):
        """舆情页首屏必须能独立渲染（模板里的等级标签不能再依赖 {% set %} 变量，
        否则空库/有数据都会 NameError 500）"""
        resp = self.fetch("/admin/sentiment", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "实时风险流" in body
        assert "/static/js/sentiment.js" in body
        assert "/static/vendor/echarts/echarts.min.js" in body
        # 子模板自定义 {% block styles %} 会覆盖父模板，必须自己再引栅格，否则 .row/.col-* 全部失效
        assert "/static/vendor/bootstrap/bootstrap-grid.min.css" in body

    def test_tools_page_renders(self):
        resp = self.fetch("/admin/tools", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "工具链路" in body
        assert "/static/vendor/bootstrap/bootstrap-grid.min.css" in body

    def test_settings_page_renders(self):
        resp = self.fetch("/admin/settings", raise_error=False)
        assert resp.code == 200
        body = resp.body.decode("utf-8")
        assert "系统设置" in body
        assert "/static/js/settings.js" in body
        assert "/static/vendor/bootstrap/bootstrap-grid.min.css" in body

    def test_pages_require_login(self):
        self._cookie_jar.clear()
        resp = self.fetch("/admin/dashboard", raise_error=False, follow_redirects=False)
        assert resp.code in (302, 403)

    # ---------------- 快照 ----------------
    def test_snapshot_structure(self):
        resp = self.get_json("/api/stats/snapshot?days=7")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        snap = body["snapshot"]
        assert SNAPSHOT_KEYS.issubset(set(snap.keys()))
        assert snap["days"] == 7
        assert len(snap["trend"]) == 7
        # by_risk 固定四类补 0，前端饼图依赖这个形状
        assert len(snap["by_risk"]) == 4
        assert {r["level"] for r in snap["by_risk"]} == {"high", "watch", "normal", "error"}
        # 地域聚合必须给出"文本提及"口径的计数与扫描量（空库时 list 为空但结构不变）
        region = snap["by_region"]
        assert isinstance(region["list"], list) and len(region["list"]) <= 34
        assert isinstance(region["matched"], int) and isinstance(region["scanned"], int)

    def test_snapshot_days_clamped(self):
        resp = self.get_json("/api/stats/snapshot?days=9999")
        assert resp.code == 200
        snap = json.loads(resp.body)["snapshot"]
        # 仓储层把 days 收敛到 1..90，避免超大区间拖库
        assert 1 <= snap["days"] <= 90

    # ---------------- 大屏问答 ----------------
    def test_ask_collect_intent(self):
        resp = self.post_json("/api/dashboard/ask", {"question": "最新数据情况"})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["intent"] == "collect"
        assert body["answer"]
        assert isinstance(body["chips"], list) and body["chips"]
        assert body["speak"]

    def test_ask_risk_intent(self):
        resp = self.post_json("/api/dashboard/ask", {"question": "风险预警情况怎么样"})
        assert resp.code == 200
        assert json.loads(resp.body)["intent"] == "risk"

    def test_ask_requires_question(self):
        resp = self.post_json("/api/dashboard/ask", {"question": "  "})
        assert resp.code == 400
        assert "问题" in json.loads(resp.body)["error"]

    # ---------------- 聚合层 ----------------
    def test_by_region_shape(self):
        from app.models.console import ConsoleStatsRepository
        data = ConsoleStatsRepository.by_region(limit=34)
        assert set(data.keys()) >= {"list", "matched", "scanned", "max", "empty"}
        # 测试库没有采集数据：必须明确给出 empty 标记，前端据此显示"暂无地域提及"
        assert isinstance(data["list"], list)
        assert data["empty"] is True
        assert data["matched"] == 0 and data["scanned"] == 0

    def test_province_names_match_geo_json(self):
        """省份简称必须与 china.json 的 feature name 完全一致，否则地图着色会静默失败"""
        import json
        import os
        from app.models.console import PROVINCES

        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        geo_path = os.path.join(root, "app", "static", "vendor", "echarts", "china.json")
        with open(geo_path, "r", encoding="utf-8") as fh:
            geo = json.load(fh)
        names = {feat["properties"]["name"] for feat in geo["features"]}
        assert set(PROVINCES) == names

    def test_risk_trend_shape(self):
        from app.models.console import ConsoleStatsRepository
        data = ConsoleStatsRepository.risk_trend(days=7)
        assert len(data["dates"]) == 7
        assert {s["key"] for s in data["series"]} == {"high", "watch", "normal", "error"}
        for s in data["series"]:
            assert len(s["data"]) == 7
