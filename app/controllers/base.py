"""
controller层公共基类（任务11 改造）

四类通用能力：
- 1 身份解析：token 会话优先（user_sessions 表），并保留旧 username/role 签名 cookie 兼容回退
- 2 统一鉴权中间件：prepare() 里校验会话并滑动续期；/api/* 未登录直接 401 JSON
     （历史上未登录的 /api 会被 @tornado.web.authenticated 302 到登录页，前端 fetch 拿到 HTML 报 JSON 解析错）
- 3 write_json：统一 JSON 响应（中文不转义）
- 4 sse：把一个事件封装成 SSE 报文文本（任务16 起由 app/controllers/sse.py 统一封装）

另有装饰器：
- session_required：接口 401 JSON / 页面 302 带 next
- admin_required：需 role=admin，否则 403（保持原语义与文案）
"""

import functools
import json
import logging
import time
import uuid
from typing import Dict, Optional

import tornado.escape
import tornado.web

from app import config
from app.controllers.errors import APIError, exception_to_api_error, message_for_status
from app.controllers.sse import SSEMixin
from app.models.session import SessionRepository

logger = logging.getLogger(__name__)

# 随仓库入库的默认品牌图标（app/static/uploads/brand/ 下，SVG ≤ 4 KB）：
# 系统设置里未配置 site_logo / site_favicon 时用它兜底，保证换机器/新库也能看到品牌标识；
# 在 /admin/settings 上传后会写入 system_settings，改为上传件优先。
DEFAULT_SITE_LOGO = "/static/uploads/brand/logo-cwnu.svg"
DEFAULT_SITE_FAVICON = "/static/uploads/brand/favicon-cwnu.svg"

# 会话 token 的 cookie 名；与旧 username/role cookie 并存，兼容期内两者都认
SESSION_COOKIE = "session_token"


class BaseHandler(tornado.web.RequestHandler, SSEMixin):
    _session_loaded = False
    _session_cache = None
    _legacy_blocked = False

    # ---------------- 会话 ----------------
    def get_session_token(self) -> str:
        """读取签名 cookie 中的会话 token（明文只在客户端与服务端内存里出现）"""
        raw = self.get_secure_cookie(SESSION_COOKIE)
        return raw.decode("utf-8") if raw else ""

    def get_session(self) -> Optional[Dict]:
        """当前请求的有效会话（每个请求只查一次库）"""
        if self._session_loaded:
            return self._session_cache
        self._session_loaded = True
        token = self.get_session_token()
        if token:
            session = SessionRepository.get_active(token)
            if session is None:
                # token 过期/被撤销：清掉 token 与同一批签发的旧 cookie，避免兼容回退把登出"救回来"
                self.clear_session_cookie()
                self.clear_cookie("username")
                self.clear_cookie("role")
                self._legacy_blocked = True
            self._session_cache = session
        return self._session_cache

    def set_session_cookie(self, token: str, ttl_hours: int = None) -> None:
        """写入会话 cookie：HttpOnly 防脚本窃取，SameSite=Lax 防跨站提交，path=/ 全站生效"""
        ttl = int(ttl_hours or config.SESSION_TTL_HOURS)
        self.set_secure_cookie(SESSION_COOKIE, token, expires=time.time() + ttl * 3600,
                               httponly=True, samesite="Lax", path="/")

    def clear_session_cookie(self) -> None:
        self.clear_cookie(SESSION_COOKIE, path="/")

    def has_session_cookie(self) -> bool:
        """客户端是否携带过 token cookie（即使签名失效也算，用于判定「该走 token 分支」）"""
        return self._legacy_blocked or SESSION_COOKIE in self.request.cookies

    def get_current_user(self) -> Optional[str]:
        """token 会话优先；只有从未拿过 token 的老客户端才回落旧签名 cookie

        关键点：携带了 token cookie 但已过期/被撤销时**不再回退**旧 cookie，
        否则「登出/强制下线/改密」对这些客户端形同无效。
        """
        session = self.get_session()
        if session:
            return session["username"]
        if self.has_session_cookie():
            return None
        username = self.get_secure_cookie("username")
        return username.decode("utf-8") if username else None

    def get_current_role(self) -> Optional[str]:
        session = self.get_session()
        if session:
            return session["role"] or "user"
        if self.has_session_cookie():
            return None
        role = self.get_secure_cookie("role")
        return role.decode("utf-8") if role else None

    # ---------------- 统一鉴权中间件 ----------------
    def is_api_request(self) -> bool:
        """接口请求（/api/ 前缀）一律按 JSON 语义响应，不参与页面重定向"""
        return self.request.path.startswith("/api/")

    def prepare(self):
        """prepare 先于业务方法执行：会话续期 + /api 未登录直接 401 JSON

        在 prepare 中 finish() 后 Tornado 不会再调用 get/post，因此各 Handler 上原有的
        @tornado.web.authenticated 不会把接口请求重定向到登录页。
        """
        session = self.get_session()
        if session:
            # 滑动续期：60 秒内重复访问不写库
            SessionRepository.touch(session)
        if self.request.method == "OPTIONS":
            return  # CORS 预检由任务15 的 options() 统一 204，鉴权不拦截
        if self.is_api_request() and not self.current_user:
            self.write_json({"ok": False, "error": "未登录", "code": "UNAUTHORIZED",
                             "request_id": self.request_id}, status=401)
            self.finish()  # 必须显式结束：否则 Tornado 会继续调用业务方法，拼出「302 + JSON 残体」
            return

    def require_login(self) -> None:
        """未登录的统一出口：接口 401 JSON，页面 302 带上 next 回跳路径"""
        if self.is_api_request():
            self.write_json({"ok": False, "error": "未登录", "code": "UNAUTHORIZED",
                             "request_id": self.request_id}, status=401)
        else:
            self.redirect("/auth/login?next=" + tornado.escape.url_escape(self.request.uri))

    # ---------------- 请求编号 / 安全头 / CORS（任务15） ----------------
    @property
    def request_id(self) -> str:
        """请求编号：优先透传客户端 X-Request-Id，否则生成一个；贯穿响应头、错误体与日志"""
        cached = getattr(self, "_request_id", "")
        if cached:
            return cached
        rid = (self.request.headers.get("X-Request-Id") or "").strip()[:64]
        if not rid:
            rid = uuid.uuid4().hex[:16]
        self._request_id = rid
        return rid

    @staticmethod
    def cors_origin(origin: str) -> str:
        """CORS 白名单精确匹配（默认空=仅同源，不下发任何 CORS 头）"""
        if not origin:
            return ""
        return origin if origin in config.CORS_ALLOW_ORIGINS else ""

    def set_default_headers(self):
        """每个响应都带的安全头 + 命中的 CORS 头"""
        self.set_header("X-Content-Type-Options", "nosniff")
        self.set_header("X-Frame-Options", "SAMEORIGIN")
        self.set_header("Referrer-Policy", "same-origin")
        self.set_header("X-Request-Id", self.request_id)
        origin = self.cors_origin(self.request.headers.get("Origin", ""))
        if origin:
            # 命中白名单才回显精确 Origin（禁止 "*" 与 allow-credentials 同时出现）
            self.set_header("Access-Control-Allow-Origin", origin)
            self.set_header("Vary", "Origin")
            self.set_header("Access-Control-Allow-Credentials", "true")
            self.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.set_header("Access-Control-Allow-Headers",
                            "Content-Type, X-Xsrftoken, X-Request-Id, Authorization")
            self.set_header("Access-Control-Max-Age", "600")

    def options(self, *args, **kwargs):
        """CORS 预检统一 204（XSRF 不拦截 OPTIONS）"""
        self.set_status(204)
        self.finish()

    # ---------------- 统一错误出口（任务15） ----------------
    def wants_json(self) -> bool:
        """接口请求或显式要 JSON 的请求走 JSON 错误体，其余走错误页"""
        if self.is_api_request():
            return True
        accept = self.request.headers.get("Accept", "") or ""
        return ("application/json" in accept
                or self.request.headers.get("X-Requested-With") == "XMLHttpRequest")

    def write_error(self, status_code: int, **kwargs) -> None:
        """Tornado 所有 send_error / 未捕获异常的最终出口

        - /api/* → {"ok": false, "error": 中文, "code": ..., "request_id": ...}
        - 页面  → templates/error.html（状态码 + 文案 + 请求编号）
        - 500 一律固定文案，堆栈只写服务端日志，绝不回给客户端（debug=True 也不例外）
        """
        exc_info = kwargs.get("exc_info")
        exc = exc_info[1] if exc_info else None
        err = exception_to_api_error(exc) if exc is not None else APIError(
            message_for_status(status_code), status_code)
        rid = self.request_id
        if err.status >= 500:
            logger.error("请求异常 rid=%s %s %s user=%s status=%s",
                         rid, self.request.method, self.request.path, self.current_user, err.status,
                         exc_info=exc_info)
        else:
            logger.info("请求被拒绝 rid=%s %s %s status=%s：%s",
                        rid, self.request.method, self.request.path, err.status, err.message)

        self.set_status(err.status)
        if self.wants_json():
            self.set_header("Content-Type", "application/json; charset=utf-8")
            self.finish(json.dumps({"ok": False, "error": err.message, "code": err.code,
                                    "request_id": rid}, ensure_ascii=False))
            return
        try:
            self.render("error.html", title="请求未能完成", status=err.status,
                        message=err.message, request_id=rid)
        except Exception:  # 模板异常时至少给出可读文本，避免二次错误
            self.finish("%d: %s（请求编号 %s）" % (err.status, err.message, rid))

    # ---------------- 响应 ----------------
    def write_json(self, data: dict, status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json; charset=utf-8")
        # ensure_ascii=False，确保中文不会被转义
        self.write(json.dumps(data, ensure_ascii=False))

    @staticmethod
    def sse(event: str, data: str) -> str:
        """单个 SSE 报文（保留旧接口签名；新代码请用 app.controllers.sse.SSEMixin）"""
        payload = json.dumps(data, ensure_ascii=False)
        return "event: %s\ndata: %s\n\n" % (event, payload)

    # ---------------- 模板渲染（站点品牌注入） ----------------
    def render(self, template_name: str, **kwargs) -> None:
        """渲染前统一注入站点品牌（任务三：系统名称/图标可在 /admin/settings 动态配置）

        取不到配置（DB 未初始化/异常）时退回默认名称，保证页面永远可渲染；
        子类显式传入同名参数时以子类为准（setdefault）。
        """
        try:
            from app.services import settings_service
            brand = settings_service.branding()
            kwargs.setdefault("site_name", brand.get("site_name") or "西华师范大学 · 智慧校园")
            kwargs.setdefault("site_logo", brand.get("site_logo") or DEFAULT_SITE_LOGO)
            kwargs.setdefault("site_favicon", brand.get("site_favicon") or DEFAULT_SITE_FAVICON)
            kwargs.setdefault("site_subtitle", brand.get("site_subtitle") or "西华师范大学智慧校园服务智能体平台")
        except Exception:
            kwargs.setdefault("site_name", "西华师范大学 · 智慧校园")
            kwargs.setdefault("site_logo", DEFAULT_SITE_LOGO)
            kwargs.setdefault("site_favicon", DEFAULT_SITE_FAVICON)
            kwargs.setdefault("site_subtitle", "西华师范大学智慧校园服务智能体平台")
        super().render(template_name, **kwargs)


def session_required(method):
    """登录校验：接口未登录 → 401 JSON；页面未登录 → 302 /auth/login?next=原路径"""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        if not self.current_user:
            self.require_login()
            return None
        return method(self, *args, **kwargs)
    return wrapper


def admin_required(method):
    """管理员权限校验：需登录且role=admin，否则403；与@authenticated配合使用"""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        if self.get_current_role() != "admin":
            self.set_status(403)
            self.finish("403: Forbidden，需要管理员权限")
            return
        return method(self, *args, **kwargs)
    return wrapper


class NotFoundHandler(BaseHandler):
    """未匹配任何路由时的兜底 Handler（任务15）

    Tornado 默认用自家 ErrorHandler，绕过了 BaseHandler 的统一错误出口，
    导致 404 拿不到安全头/CORS/请求编号，/api 下还会回 HTML。
    这里注册为 Application.default_handler_class，抛 404 交给 write_error 统一处理。
    """

    def prepare(self):
        raise tornado.web.HTTPError(404)
