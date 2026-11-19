"""
会话归档管理控制器 —— 成员 E（历史会话追溯 / message_archives 列表）

分层沿用后台规范：
- 表现层：templates/admin/archives.html 出「功能区 | 列表区 | 分页区」壳，列表由 static/js/archives.js 走本模块 JSON API；
- 控制层：AdminArchivesHandler 渲染页面（登录 + 后台角色 + 菜单鉴权），AdminArchivesApiHandler 提供数据接口；
- 模型层：数据走 models/stats.py 的 MessageArchiveRepository.paginate，控制器不写 SQL。

筛选参数：username / session_id / role / start_at / end_at / keyword（content LIKE）。
只读接口，不提供修改 / 删除（归档数据保留可追溯性由业务约束）。
权限：沿用 backend_required + require_menu('/admin/archives')。
"""

import tornado.web

from app.controllers.admin import (
    PAGE_SIZE, AdminApiHandler, AdminBaseHandler, backend_required,
)
from app.models.stats import MessageArchiveRepository

URL_ARCHIVES = "/admin/archives"


# ==================== 页面 ====================

class AdminArchivesHandler(AdminBaseHandler):
    """会话归档页（/admin/archives）：框架壳，列表 / 筛选由 archives.js 走 /api/admin/archives"""

    template_name = "admin/archives.html"
    page_name = "会话归档"
    nav_url = URL_ARCHIVES

    def get_context(self) -> dict:
        return {
            "total": MessageArchiveRepository.count(),
            "roles": ["user", "assistant", "system"],
        }


# ==================== API ====================

def _arg(handler, name: str) -> str:
    return (handler.get_argument(name, "") or "").strip() or None


class AdminArchivesApiHandler(AdminApiHandler):
    """GET /api/admin/archives —— 归档列表分页，支持 username / session_id / role / start_at / end_at / keyword 筛选"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_ARCHIVES):
            return
        try:
            page = max(1, int(self.get_argument("page", "1")))
        except (TypeError, ValueError):
            page = 1
        data = MessageArchiveRepository.paginate(
            username=_arg(self, "username"),
            session_id=_arg(self, "session_id"),
            role=_arg(self, "role"),
            start_at=_arg(self, "start_at"),
            end_at=_arg(self, "end_at"),
            keyword=_arg(self, "keyword"),
            page=page,
            limit=PAGE_SIZE,
        )
        self.ok(**data, page=page, page_size=PAGE_SIZE,
                total_all=MessageArchiveRepository.count())
