"""
对话导出 PDF Controller（成员 D，任务2：导出对话 PDF）
- ChatExportHandler  GET /api/chat/export?session_id=xxx
  从 messages 取该用户该会话最近 500 条 → pdf_service 渲染真 PDF →
  Content-Disposition 附件下载（文件名带会话与日期，非 ASCII 部分用 RFC 5987 编码）。
会话 id 复用 chat.py 的 valid_session 白名单，防目录/SQL 异常输入。
"""

import urllib.parse
from datetime import datetime

from app.controllers.base import BaseHandler
from app.controllers.chat import valid_session
from app.models.message import MessageRepository
from app.services import pdf_service

_MAX_MESSAGES = 500


class ChatExportHandler(BaseHandler):
    def get(self):
        session_id = self.get_argument("session_id", "default")
        if not valid_session(session_id):
            self.write_json({"ok": False, "error": "session_id 格式非法",
                             "code": "BAD_REQUEST", "request_id": self.request_id}, status=400)
            return
        messages = MessageRepository.list_recent(
            self.current_user, _MAX_MESSAGES, session_id,
            archived=self.get_argument("archived", "") == "1")
        pdf_bytes = pdf_service.build_chat_pdf(self.current_user, session_id, messages)
        base = "对话记录_%s_%s.pdf" % (session_id, datetime.now().strftime("%Y%m%d"))
        quoted = urllib.parse.quote(base)
        self.set_header("Content-Type", "application/pdf")
        self.set_header("Content-Length", str(len(pdf_bytes)))
        self.set_header("Content-Disposition",
                        'attachment; filename="chat_%s.pdf"; '
                        "filename*=UTF-8''%s" % (urllib.parse.quote(session_id), quoted))
        self.set_header("Cache-Control", "no-store")
        self.write(pdf_bytes)
