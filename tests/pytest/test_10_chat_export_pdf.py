# -*- coding: utf-8 -*-
"""10 成员 D：导出对话 PDF（/api/chat/export，reportlab 服务端真 PDF）"""

import json

from conftest import ApiCase


class TestChatExportPdf(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def _seed_messages(self, session_id="pytestpdf"):
        from app.models.message import MessageRepository
        MessageRepository.save_turn("admin", session_id, "帮我分析数据",
                                    "好的，**已生成**分析报告", 1, "测试助理")
        return session_id

    def test_export_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.get_json("/api/chat/export")
        assert resp.code == 401

    def test_export_rejects_bad_session_id(self):
        resp = self.get_json("/api/chat/export?session_id=" + "a" * 65)
        assert resp.code == 400
        body = json.loads(resp.body)
        assert body["ok"] is False
        assert "session_id" in body["error"]

    def test_export_returns_real_pdf(self):
        session_id = self._seed_messages()
        resp = self.fetch("/api/chat/export?session_id=" + session_id, raise_error=False)
        assert resp.code == 200
        assert resp.headers.get("Content-Type") == "application/pdf"
        assert "attachment" in resp.headers.get("Content-Disposition", "")
        assert resp.body[:5] == b"%PDF-"
        assert len(resp.body) > 1000
        # 用户隔离：另一个用户导出同名会话只能得到空占位文档（不泄露别人正文）
        self.ensure_user("pdf_other", "other12345")
        self.post_form("/auth/logout", {}, follow=False)
        self.login_user("pdf_other", "other12345")
        resp2 = self.fetch("/api/chat/export?session_id=" + session_id, raise_error=False)
        assert resp2.code == 200
        assert resp2.body[:5] == b"%PDF-"
        # 空占位文档必然比含正文消息的文档短
        assert len(resp2.body) < len(resp.body)

    def test_export_empty_session_still_pdf(self):
        resp = self.fetch("/api/chat/export?session_id=no_such_session", raise_error=False)
        assert resp.code == 200
        assert resp.body[:5] == b"%PDF-"
