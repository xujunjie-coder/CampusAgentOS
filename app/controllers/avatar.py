"""
3D 数字人 Controller（成员 D，任务2：3D 数字人交互页）
- AvatarPageHandler  GET /avatar  数字人页（登录可见）
页面本体是纯前端（three.js vendor + 复用 /api/chat SSE 契约），后端只负责鉴权渲染；
业务 API 与对话页完全同源（/api/chat、/api/assistants），不新增数据接口。
"""

import tornado.web

from app.controllers.base import BaseHandler


class AvatarPageHandler(BaseHandler):
    @tornado.web.authenticated
    def get(self):
        self.render("avatar.html", title="3D 数字人", username=self.current_user,
                    role=self.get_current_role())
