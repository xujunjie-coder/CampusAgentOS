# -*- coding: utf-8 -*-
"""pytest 公共夹具（成员 F 测试基线）

设计要点：
1. **不碰真实库**：先把 DB_PATH 指向临时目录，再导入 app.*，避免误写 database/govagentos.db；
2. **不依赖网络/大模型**：所有用例只打本地 Tornado 应用，chat/model 测试只验证参数校验与错误分支；
3. **不复用 tests/ 下既有冒烟脚本**：那些脚本带真实库副作用（如 test_user.py 会删用户），这里独立建库。
"""

import json
import os
import tempfile
import urllib.parse

# ---------------------------------------------------------------------------
# 必须在导入 app.* 之前设置环境变量：app/models/db.py 在导入时就把 DB_PATH 固化成模块常量
# ---------------------------------------------------------------------------
_TMP_DIR = tempfile.mkdtemp(prefix="701-pytest-")
os.environ.update({
    "DB_DRIVER": "sqlite",
    "DB_PATH": os.path.join(_TMP_DIR, "test.db"),
    "COOKIE_SECRET": "pytest-cookie-secret-0123456789abcdef",
    "XSRF_ENABLED": "0",
    "DEBUG": "0",
    "FACE_ENGINE": "fallback",
    "SESSION_TTL_HOURS": "1",
    "LOGIN_MAX_FAILS": "5",
    "LOGIN_LOCK_MINUTES": "10",
    "LOG_LEVEL": "CRITICAL",
})

from tornado.testing import AsyncHTTPTestCase  # noqa: E402

ADMIN_USER = "admin"
ADMIN_PASS = "admin123"


class ApiCase(AsyncHTTPTestCase):
    """带登录/JSON 便捷方法的接口测试基类

    注意：tornado.testing.AsyncHTTPTestCase 自带的 fetch 不会保存 Cookie，
    这里自行解析 Set-Cookie 并在后续请求中回填 Cookie 头，才能真正走通 token 会话。
    """

    def setUp(self):
        super().setUp()
        self._cookie_jar = {}
        # 临时库是空的，先种一个管理员（真实库里由人工初始化）
        from app.models.user import UserRepository
        if not UserRepository.get_user_by_username(ADMIN_USER):
            UserRepository.create_user(ADMIN_USER, ADMIN_PASS, "admin")

    def get_app(self):
        from app.application import make_app
        return make_app()

    # ---------------- Cookie 维护 ----------------
    def _cookie_header(self):
        return "; ".join("%s=%s" % (k, v) for k, v in self._cookie_jar.items())

    def _absorb_cookie(self, response):
        for raw in response.headers.get_list("Set-Cookie"):
            pair, _, attrs = raw.partition(";")
            name, _, value = pair.partition("=")
            name, value = name.strip(), value.strip()
            if not name:
                continue
            low = attrs.lower()
            expired = "max-age=0" in low or "expires=thu, 01 jan 1970" in low
            if expired or value in ('""', ""):
                self._cookie_jar.pop(name, None)
            else:
                self._cookie_jar[name] = value

    def fetch(self, path, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        if self._cookie_jar:
            headers.setdefault("Cookie", self._cookie_header())
        kwargs["headers"] = headers
        resp = super().fetch(path, **kwargs)
        self._absorb_cookie(resp)
        return resp

    # ---------------- 基础请求 ----------------
    def _json(self, response):
        try:
            return json.loads(response.body.decode("utf-8"))
        except ValueError:
            return None

    def get_json(self, path):
        return self.fetch(path, method="GET", raise_error=False)

    def post_json(self, path, payload):
        return self.fetch(path, method="POST",
                          body=json.dumps(payload, ensure_ascii=False),
                          headers={"Content-Type": "application/json"},
                          raise_error=False)

    def post_form(self, path, data, follow=True):
        return self.fetch(path, method="POST",
                          body=urllib.parse.urlencode(data),
                          headers={"Content-Type": "application/x-www-form-urlencoded"},
                          follow_redirects=follow, raise_error=False)

    def delete(self, path):
        return self.fetch(path, method="DELETE", raise_error=False)

    # ---------------- 登录 ----------------
    def login(self, username=ADMIN_USER, password=ADMIN_PASS):
        resp = self.post_form("/auth/login", {"username": username, "password": password},
                              follow=False)
        assert resp.code == 302, "登录失败：%s" % resp.body[:200]
        return resp

    def login_user(self, username, password):
        """普通用户登录：admin 会跳 /admin，普通用户跳 next 或 /"""
        resp = self.post_form("/auth/login", {"username": username, "password": password},
                              follow=False)
        assert resp.code == 302, "普通用户登录失败：%s" % resp.body[:200]
        return resp

    # ---------------- 数据准备 ----------------
    def ensure_user(self, username, password, role="user"):
        from app.models.user import UserRepository
        if not UserRepository.get_user_by_username(username):
            UserRepository.create_user(username, password, role)

    def ensure_backend_role_without_menus(self):
        """建一个「后台角色但没有任何菜单权限」的账号，用于验证 403 分支"""
        from app.models.role import RoleRepository
        from app.models.user import UserRepository
        code = "limited"
        if not RoleRepository.get_by_code(code):
            RoleRepository.create(code, "受限角色", "pytest 用", "/admin")
        if not UserRepository.get_user_by_username("limited"):
            UserRepository.create_user("limited", "limited123", code)
        return "limited", "limited123"
