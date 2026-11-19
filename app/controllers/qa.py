"""
智能问数 Controller（成员 D，任务1核心：智能问数）
- QaPageHandler        GET  /qa                     问数页（登录可见）
- QaAskApiHandler      POST /api/qa/ask             选数字员工 → qa_service 出报告 → 落库
- QaHistoryApiHandler  GET  /api/qa/history         本人问数历史（用户隔离）
- QaReportApiHandler   GET  /api/qa/report/<id>     取单条完整报告（只能取自己的）

数字助理解析复用任务10 的 pick_assistant：employee_id 缺省时跟随用户已选/系统默认。
"""

import json

import tornado.web

from app.controllers.assistant import pick_assistant
from app.controllers.base import BaseHandler
from app.models.qa import QaRepository
from app.services import qa_service


class QaPageHandler(BaseHandler):
    @tornado.web.authenticated
    def get(self):
        self.render("qa.html", title="智能问数", username=self.current_user,
                    role=self.get_current_role())


class QaAskApiHandler(BaseHandler):
    async def post(self):
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.write_json({"ok": False, "error": "请求体必须为 JSON", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        question = str(payload.get("question") or "").strip()
        if not question:
            self.write_json({"ok": False, "error": "请输入要问的问题", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        if len(question) > 500:
            self.write_json({"ok": False, "error": "问题长度不能超过500字", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        employee, err = pick_assistant(self.current_user, payload.get("employee_id"))
        if err:
            self.write_json({"ok": False, "error": err, "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        report = await qa_service.ask(question, employee)
        report_id = QaRepository.save(
            self.current_user, question,
            (employee or {}).get("id") or 0, (employee or {}).get("name") or "",
            report, report.get("source") or "heuristic")
        self.write_json({"ok": True, "id": report_id, "report": report})


class QaHistoryApiHandler(BaseHandler):
    def get(self):
        rows = QaRepository.list_recent(self.current_user, 20)
        self.write_json({"ok": True, "list": rows})


class QaReportApiHandler(BaseHandler):
    def get(self, report_id):
        row = QaRepository.get(self.current_user, report_id)
        if not row:
            self.write_json({"ok": False, "error": "报告不存在", "code": "NOT_FOUND",
                             "request_id": self.request_id}, status=404)
            return
        self.write_json({"ok": True, "report": row})
