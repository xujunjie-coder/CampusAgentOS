"""
页面控制器：前台（用户侧）页面
后台（admin 侧）页面已按模块拆分到 controllers/admin.py
"""

import tornado.web

from app.controllers.base import BaseHandler


class IndexHandler(BaseHandler):
    @tornado.web.authenticated
    def get(self):
        self.render("index.html", title="西华师范大学 · 智慧校园智能体平台", username=self.current_user, role=self.get_current_role())


class CampusMapHandler(BaseHandler):
    @tornado.web.authenticated
    def get(self):
        self.render("campus_map.html", title="行署校区")
