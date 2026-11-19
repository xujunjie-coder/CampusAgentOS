"""
临时会话（登录会话）查询控制器 —— 成员 E（user_sessions 表后台管理）

分层沿用后台规范：
- 表现层：templates/admin/sessions.html「功能区 | 列表区 | 分页区」，交互在 static/js/sessions.js；
- 控制层：AdminSessionsPageHandler 渲染页面；AdminSessionsApiHandler 提供列表 + 撤销 + 清理接口；
- 模型层：数据走 models/session.py 的 SessionRepository.admin_paginate / revoke_by_id / admin_stats /
          purge_expired / revoke_username。

筛选：username / client_ip / state(active|revoked|expired|all)。
操作：撤销单条会话、按用户名批量撤销、清理已撤销与过期会话。
权限：backend_required + require_menu('/admin/sessions')。

术语提示：这里的「会话」= 登录会话（token 会话），与 messages.session_id（对话会话）不同。
"""

import tornado.web

from app.controllers.admin import (
    PAGE_SIZE, AdminApiHandler, AdminBaseHandler, backend_required,
)
from app.models.session import SessionRepository
from app.models.user import UserRepository
from app.models.db import get_connection

URL_SESSIONS = "/admin/sessions"


# ==================== 页面 ====================

class AdminSessionsPageHandler(AdminBaseHandler):
    """临时会话查询页（/admin/sessions）：框架壳，列表/撤销由 sessions.js 渲染"""

    template_name = "admin/sessions.html"
    page_name = "临时会话"
    nav_url = URL_SESSIONS

    def get_context(self) -> dict:
        return {"stats": SessionRepository.admin_stats()}


# ==================== API ====================

def _arg(handler, name: str):
    return (handler.get_argument(name, "") or "").strip() or None


class AdminSessionsApiHandler(AdminApiHandler):
    """GET /api/admin/sessions —— 分页列表 + 概况；POST {action} —— 撤销 / 清理"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_SESSIONS):
            return
        try:
            page = max(1, int(self.get_argument("page", "1")))
        except (TypeError, ValueError):
            page = 1
        state = (self.get_argument("state", "") or "active").strip().lower()
        if state not in ("active", "revoked", "expired", "all"):
            state = "active"
        data = SessionRepository.admin_paginate(
            username=_arg(self, "username"),
            client_ip=_arg(self, "client_ip"),
            state=state,
            page=page, limit=PAGE_SIZE,
        )
        self.ok(**data, page=page, page_size=PAGE_SIZE, state=state,
                stats=SessionRepository.admin_stats())

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_SESSIONS):
            return
        b = self.body()
        action = (b.get("action") or "").strip()
        if action == "revoke":
            sid = int(b.get("id") or 0)
            if not sid:
                self.fail("缺少会话 id")
                return
            ok = SessionRepository.revoke_by_id(sid)
            # 联动关闭该用户 WebSocket（若可查到 username）
            self._try_kick_ws_by_id(sid)
            self.ok(revoked=1 if ok else 0)
        elif action == "revoke_username":
            username = (b.get("username") or "").strip()
            if not username:
                self.fail("缺少 username")
                return
            revoked = SessionRepository.revoke_username(username)
            self._try_kick_ws(username)
            self.ok(revoked=revoked, username=username)
        elif action == "purge_expired":
            removed = SessionRepository.purge_expired()
            self.ok(removed=removed)
        else:
            self.fail("未知操作：%s" % action)

    @staticmethod
    def _try_kick_ws(username: str):
        try:
            from app.controllers.ws import kick_user
            kick_user(username, "后台强制下线")
        except Exception:
            pass

    @staticmethod
    def _try_kick_ws_by_id(session_id: int):
        try:
            from app.controllers.ws import kick_user
            with get_connection() as conn:
                row = conn.execute(
                    "SELECT username FROM user_sessions WHERE id = ?", (session_id,)).fetchone()
            if row:
                kick_user(row["username"], "后台强制下线")
        except Exception:
            pass
