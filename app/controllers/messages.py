"""
对话记录管理控制器 —— 成员 E（messages 表跨用户后台管理）

分层沿用后台规范：
- 表现层：templates/admin/messages.html「功能区 | 列表区 | 分页区」+ 详情弹层，交互在 static/js/messages.js；
- 控制层：AdminMessagesPageHandler 渲染页面，AdminMessagesApiHandler（列表 + 批量删除）/
          AdminMessageItemApiHandler（详情 + 单条删除）提供 JSON 接口；
- 模型层：数据走 models/message.py 的 MessageRepository.admin_* 方法。

筛选：username / session_id / role / keyword(content) / start_at / end_at。
操作：查看详情、删除单条、批量删除。
权限：backend_required + require_menu('/admin/messages')；admin 超管绕过菜单校验。

说明：本接口跨用户读取 messages，仅后台可用；普通用户仍走 /api/history 的 username 隔离视图。
"""

import tornado.web

from app.controllers.admin import (
    PAGE_SIZE, AdminApiHandler, AdminBaseHandler, backend_required,
)
from app.models.message import MessageRepository

URL_MESSAGES = "/admin/messages"


# ==================== 页面 ====================

class AdminMessagesPageHandler(AdminBaseHandler):
    """对话记录管理页（/admin/messages）：框架壳，列表/详情/删除由 messages.js 渲染"""

    template_name = "admin/messages.html"
    page_name = "对话记录"
    nav_url = URL_MESSAGES

    def get_context(self) -> dict:
        return {
            "total": MessageRepository.count_all(),
            "roles": ["user", "assistant", "system"],
        }


# ==================== API ====================

def _arg(handler, name: str):
    return (handler.get_argument(name, "") or "").strip() or None


class AdminMessagesApiHandler(AdminApiHandler):
    """GET /api/admin/messages —— 分页列表；POST {action:'delete_batch', ids:[...]} —— 批量删除"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_MESSAGES):
            return
        try:
            page = max(1, int(self.get_argument("page", "1")))
        except (TypeError, ValueError):
            page = 1
        data = MessageRepository.admin_paginate(
            username=_arg(self, "username"),
            session_id=_arg(self, "session_id"),
            role=_arg(self, "role"),
            keyword=_arg(self, "keyword"),
            start_at=_arg(self, "start_at"),
            end_at=_arg(self, "end_at"),
            page=page, limit=PAGE_SIZE,
        )
        self.ok(**data, page=page, page_size=PAGE_SIZE,
                total_all=MessageRepository.count_all())

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_MESSAGES):
            return
        b = self.body()
        action = (b.get("action") or "").strip()
        if action == "delete_batch":
            ids = b.get("ids") or []
            deleted = MessageRepository.admin_delete_batch(ids)
            self.ok(deleted=deleted)
        else:
            self.fail("未知操作：%s" % action)


class AdminMessageItemApiHandler(AdminApiHandler):
    """GET /api/admin/messages/<id> 详情；DELETE /api/admin/messages/<id> 删除单条"""

    @tornado.web.authenticated
    @backend_required
    def get(self, msg_id):
        if not self.require_menu(URL_MESSAGES):
            return
        row = MessageRepository.admin_get(int(msg_id))
        if not row:
            self.fail("消息不存在", status=404)
            return
        self.ok(data=row)

    @tornado.web.authenticated
    @backend_required
    def delete(self, msg_id):
        if not self.require_menu(URL_MESSAGES):
            return
        deleted = MessageRepository.admin_delete(int(msg_id))
        self.ok(deleted=deleted)
