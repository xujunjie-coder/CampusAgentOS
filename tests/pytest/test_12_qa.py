# -*- coding: utf-8 -*-
"""12 成员 D：智能问数（/qa 页 + /api/qa/ask|history|report）
测试环境无模型引擎 → qa_service 必然走启发式兜底，恰好验证「离线可跑通」承诺；
报告契约字段（title/summary/metrics/chart/insights/advice/source）逐项核对。
"""

import json

import app.services.model_service as model_service
from conftest import ApiCase


class TestQa(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()
        # conftest 基线承诺「不依赖网络/大模型」：仓库 .env 可能带真实凭据，
        # 这里临时禁用引擎解析，强制走启发式统计直出，结果确定且不产生外部调用。
        self._orig_chat_engine = model_service.chat_engine
        model_service.chat_engine = lambda employee=None: None

    def tearDown(self):
        model_service.chat_engine = self._orig_chat_engine
        super().tearDown()

    def test_ask_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.post_json("/api/qa/ask", {"question": "趋势如何"})
        assert resp.code == 401

    def test_qa_page_ok_and_login_gate(self):
        resp = self.fetch("/qa", raise_error=False)
        assert resp.code == 200
        assert "智能问数" in resp.body.decode("utf-8")
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.fetch("/qa", follow_redirects=False, raise_error=False)
        assert resp.code == 302

    def test_ask_validates_question(self):
        assert self.post_json("/api/qa/ask", {}).code == 400
        assert self.post_json("/api/qa/ask", {"question": "   "}).code == 400
        assert self.post_json("/api/qa/ask", {"question": "问" * 501}).code == 400

    def test_ask_bad_employee(self):
        resp = self.post_json("/api/qa/ask", {"question": "概况", "employee_id": 99999})
        assert resp.code == 400
        assert "数字助理" in json.loads(resp.body)["error"]

    def test_ask_returns_contract_report(self):
        resp = self.post_json("/api/qa/ask", {"question": "近7天采集量趋势怎么样？"})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True and body["id"] > 0
        r = body["report"]
        assert r["title"] and r["summary"]
        assert r["source"] in ("model", "heuristic")
        # 测试环境无模型可用 → 必为启发式统计直出
        assert r["source"] == "heuristic"
        assert isinstance(r["metrics"], list) and r["metrics"]
        for m in r["metrics"]:
            assert set(m) == {"name", "value", "unit"}
        chart = r["chart"]
        assert chart["type"] in ("bar", "line")
        assert len(chart["labels"]) == len(chart["values"])
        assert isinstance(r["insights"], list) and r["advice"]
        assert r["generated_at"]

    def test_history_and_report_user_isolation(self):
        asked = json.loads(self.post_json("/api/qa/ask", {"question": "信源分布"}).body)
        report_id = asked["id"]
        # 本人历史可见
        hist = json.loads(self.get_json("/api/qa/history").body)
        assert hist["ok"] is True
        assert any(h["id"] == report_id for h in hist["list"])
        # 本人可取完整报告
        one = json.loads(self.get_json("/api/qa/report/%d" % report_id).body)
        assert one["ok"] is True
        assert one["report"]["report"]["source"] in ("model", "heuristic")
        # 换用户：历史与单条报告都隔离（别人的 id 视为不存在）
        self.ensure_user("qa_other", "other12345")
        self.post_form("/auth/logout", {}, follow=False)
        self.login_user("qa_other", "other12345")
        hist2 = json.loads(self.get_json("/api/qa/history").body)
        assert hist2["list"] == []
        assert self.get_json("/api/qa/report/%d" % report_id).code == 404

    def test_ask_non_json_body(self):
        resp = self.fetch("/api/qa/ask", method="POST", body="raw-text",
                          headers={"Content-Type": "application/json"}, raise_error=False)
        assert resp.code == 400
