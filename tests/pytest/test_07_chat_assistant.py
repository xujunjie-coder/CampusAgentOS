# -*- coding: utf-8 -*-
"""07 前台：助理选择 / 对话参数校验 / 历史（任务10）"""

import json

from conftest import ApiCase


class TestChatAssistant(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_assistants_list(self):
        resp = self.get_json("/api/assistants")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)
        assert "selected_id" in body

    def test_assistants_list_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.get_json("/api/assistants")
        assert resp.code == 401

    def test_select_assistant_missing_field(self):
        resp = self.post_json("/api/assistants/select", {})
        assert resp.code == 400

    def test_select_assistant_unknown(self):
        resp = self.post_json("/api/assistants/select", {"employee_id": 99999})
        assert resp.code == 400
        assert "数字助理" in json.loads(resp.body)["detail"]

    def test_select_assistant_default(self):
        resp = self.post_json("/api/assistants/select", {"employee_id": 0})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["saved_id"] == 0

    def test_chat_requires_json_body(self):
        resp = self.fetch("/api/chat", method="POST", body="not-json",
                          headers={"Content-Type": "application/json"}, raise_error=False)
        assert resp.code == 400
        assert "JSON" in json.loads(resp.body)["detail"]

    def test_chat_requires_message(self):
        resp = self.post_json("/api/chat", {"message": ""})
        assert resp.code == 400
        assert "消息" in json.loads(resp.body)["detail"]

    def test_history_returns_bare_array(self):
        resp = self.get_json("/api/history")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert isinstance(body, list)

    def test_history_limit_tolerates_bad_value(self):
        resp = self.get_json("/api/history?limit=abc")
        assert resp.code == 200
        assert isinstance(json.loads(resp.body), list)
