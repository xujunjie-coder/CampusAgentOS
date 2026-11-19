"""
认证相关controller模块：登录、注册、登出

三个Handler: 登录/注册/登出
- LoginHandler: GET 展示登录页；POST 校验密码后签发 token 会话（user_sessions）并写入 cookie
- RegisterHandler: 注册，仅能创建 user 角色
- LogoutHandler: 登出，撤销会话（revoked=1）并清除 cookie

任务11 登录安全：
- 连续失败 LOGIN_MAX_FAILS 次锁定 LOGIN_LOCK_MINUTES 分钟，锁定期内统一提示
  「账号或密码错误，请稍后再试」，不暴露账号是否存在
- 每次尝试写 login_logs（用户名/IP/UA/结果），后台可查
- token 明文只在 cookie 中出现，库里只存 SHA256
- 兼容期：登录时仍同步写旧 username/role 签名 cookie，旧登录态与旧代码都能继续工作

角色机制：登录成功后 admin 跳 /admin，user 跳 next 参数或 /
XSRF token 由模板中的 {% module xsrf_form_html() %} 自动生成并随表单提交
"""
import logging
import re

from app import config
from app.controllers.base import BaseHandler
from app.models.session import LoginLogRepository, SessionRepository
from app.models.user import UserRepository

logger = logging.getLogger(__name__)

_USERNAME_RE = re.compile(r'^[\w\u4e00-\u9fa5]{3,32}$')
_MIN_PASSWORD_LEN = 6
# 锁定期与密码错误使用同一提示，避免通过文案判断账号是否存在
_CREDENTIAL_ERROR = "用户名或密码错误"
_LOCKED_ERROR = "账号或密码错误，请稍后再试"


def _safe_next(next_url: str) -> str:
    """回跳地址只接受站内路径，防止 ?next=//evil.com 的开放重定向"""
    if not next_url or not next_url.startswith("/") or next_url.startswith("//"):
        return "/"
    return next_url


class LoginHandler(BaseHandler):
    def get(self):
        self.render("login.html", title="登录", error=None, username="")

    def post(self):
        username = self.get_body_argument("username", "").strip()
        password = self.get_body_argument("password", "")
        client_ip = self.request.remote_ip
        user_agent = self.request.headers.get("User-Agent", "")

        if not username or not password:
            self.set_status(400)
            self.render("login.html", title="登录", error="用户名或密码不能为空", username=username)
            return

        # 1) 锁定期内：直接拒绝，但仍记审计（不区分账号是否存在）
        if UserRepository.is_locked(username):
            LoginLogRepository.record(username, "locked", "锁定期内尝试登录", client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录", error=_LOCKED_ERROR, username=username)
            return

        # 2) 密码校验失败：累计失败次数，达到阈值触发锁定
        if not UserRepository.verify_user(username, password):
            state = UserRepository.record_login_failure(
                username, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MINUTES)
            failed = state.get("failed_count") or 0
            logger.warning("登录失败 username=%s ip=%s failed=%s locked=%s",
                           username, client_ip, failed, state.get("locked"))
            LoginLogRepository.record(
                username, "fail",
                ("密码错误，第%d次" % failed) if failed else "账号不存在",
                client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录",
                        error=_LOCKED_ERROR if state.get("locked") else _CREDENTIAL_ERROR,
                        username=username)
            return

        # 3) 成功：清零失败计数，签发 token 会话
        row = UserRepository.get_user_by_username(username)
        role = row["role"] if row and row["role"] else "user"
        UserRepository.record_login_success(username)
        token, _session = SessionRepository.issue(username, role, client_ip, user_agent)
        self.set_session_cookie(token)
        # 兼容期：旧 username/role 签名 cookie 同步写入，存量前端与旧版本代码不受影响
        self.set_secure_cookie("username", username)
        self.set_secure_cookie("role", role)
        LoginLogRepository.record(username, "success", "密码登录", client_ip, user_agent)
        # 顺带清理过期会话与超期审计，避免表无限增长
        SessionRepository.purge_expired()
        LoginLogRepository.purge_before(90)

        if role == "admin":
            self.redirect("/admin")
        else:
            self.redirect(_safe_next(self.get_argument("next", "/")))


class RegisterHandler(BaseHandler):
    def get(self):
        self.render("register.html", title="注册", error=None, username="")

    def post(self):
        username = self.get_body_argument("username", "").strip()
        password = self.get_body_argument("password", "")
        confirm = self.get_body_argument("confirm", "")

        error = None
        if not _USERNAME_RE.match(username):
            error = "用户名需为3-32位的字母、数字或中文"
        elif len(password) < _MIN_PASSWORD_LEN:
            error = "密码长度不能少于6位"
        elif password != confirm:
            error = "两次输入的密码不一致"
        elif not UserRepository.create_user(username, password):
            # username唯一约束冲突，Repository返回False
            error = "用户名已存在"

        if error:
            self.set_status(400)
            self.render("register.html", title="注册", error=error, username=username)
            return
        self.redirect("/auth/login")



class LogoutHandler(BaseHandler):
    """登出：撤销当前会话（主动失效），清除 token 与兼容期旧 cookie；保持 POST 防 CSRF"""
    def post(self):
        username = self.current_user or ""
        token = self.get_session_token()
        revoked = SessionRepository.revoke(token)
        if username:
            LoginLogRepository.record(username, "logout", "主动登出" if revoked else "会话已失效",
                                      self.request.remote_ip,
                                      self.request.headers.get("User-Agent", ""))
        self.clear_session_cookie()
        self.clear_cookie("username")
        self.clear_cookie("role")
        self.redirect("/auth/login")

