"""
用户中心 Controller（成员 D，任务2：用户中心页面）
- UserPageHandler        GET  /user                    个人中心页（登录可见）
- UserProfileApiHandler  GET  /api/user/profile        资料 + 账户概览统计
                         POST /api/user/profile        自助改昵称/头像
- UserPasswordApiHandler POST /api/user/password       本人改密：验证旧密 → 重算盐哈希 →
                         撤销全部旧会话并重新签发当前会话（与任务11「改密即失效」口径一致）
- UserSessionsApiHandler GET  /api/user/sessions       本人活跃会话列表（多端登录自查）

安全约定：不回传密码哈希/盐值/token 哈希；改密走 PBKDF2 同构逻辑（models/user.py）。
"""

import json

import tornado.web

from app.controllers.base import BaseHandler
from app.models.face import FaceRepository
from app.models.message import MessageRepository
from app.models.session import SessionRepository
from app.models.user import UserRepository

_MIN_PASSWORD_LEN = 6


class UserPageHandler(BaseHandler):
    @tornado.web.authenticated
    def get(self):
        self.render("user.html", title="个人中心", username=self.current_user,
                    role=self.get_current_role())


class UserProfileApiHandler(BaseHandler):
    def get(self):
        profile = UserRepository.get_profile(self.current_user)
        if not profile:
            self.write_json({"ok": False, "error": "用户不存在", "code": "NOT_FOUND",
                             "request_id": self.request_id}, status=404)
            return
        profile["stats"] = {
            "messages": MessageRepository.count(self.current_user),
            "sessions": len(SessionRepository.list_active(self.current_user)),
            "faces": FaceRepository.count(self.current_user),
        }
        self.write_json({"ok": True, "profile": profile})

    def post(self):
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.write_json({"ok": False, "error": "请求体必须为 JSON", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        nickname = payload.get("nickname")
        avatar = payload.get("avatar")
        if nickname is not None and not isinstance(nickname, str):
            self.write_json({"ok": False, "error": "昵称格式不正确", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        # 头像只允许 FontAwesome 类名白名单（fas fa-xxx），防注入且与全站图标口径一致
        if avatar is not None:
            import re
            if not isinstance(avatar, str) or (avatar.strip() and
                                               not re.fullmatch(r"fas fa-[a-z0-9-]{1,32}", avatar.strip())):
                self.write_json({"ok": False, "error": "头像仅支持站内图标类名", "code": "BAD_REQUEST",
                                 "request_id": self.request_id}, status=400)
                return
        if nickname is None and avatar is None:
            self.write_json({"ok": False, "error": "没有需要更新的字段", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        if not UserRepository.update_profile(self.current_user, nickname=nickname, avatar=avatar):
            self.write_json({"ok": False, "error": "用户不存在", "code": "NOT_FOUND",
                             "request_id": self.request_id}, status=404)
            return
        self.write_json({"ok": True, "profile": UserRepository.get_profile(self.current_user)})


class UserPasswordApiHandler(BaseHandler):
    def post(self):
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.write_json({"ok": False, "error": "请求体必须为 JSON", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        old = str(payload.get("old_password") or "")
        new = str(payload.get("new_password") or "")
        if not UserRepository.verify_user(self.current_user, old):
            self.write_json({"ok": False, "error": "原密码不正确", "code": "FORBIDDEN",
                             "request_id": self.request_id}, status=403)
            return
        if len(new) < _MIN_PASSWORD_LEN:
            self.write_json({"ok": False, "error": "新密码长度不能少于6位", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        if new == old:
            self.write_json({"ok": False, "error": "新密码不能与原密码相同", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        UserRepository.change_password(self.current_user, new)
        # 改密后旧会话全部失效（任务11 口径），并为当前浏览器重签一个，避免把自己踢下线
        SessionRepository.revoke_username(self.current_user)
        role = self.get_current_role() or "user"
        token, _session = SessionRepository.issue(
            self.current_user, role, self.request.remote_ip or "",
            self.request.headers.get("User-Agent", "")[:200])
        self.set_session_cookie(token)
        self.write_json({"ok": True, "message": "密码已修改，其他设备的登录态已全部失效"})


class UserSessionsApiHandler(BaseHandler):
    def get(self):
        rows = SessionRepository.list_active(self.current_user)
        # 只回展示字段：created_at/last_seen_at/expires_at + 设备信息，绝不回 token_hash
        self.write_json({"ok": True, "list": [
            {"client_ip": r.get("client_ip") or "", "user_agent": r.get("user_agent") or "",
             "created_at": r.get("created_at") or "", "last_seen_at": r.get("last_seen_at") or "",
             "expires_at": r.get("expires_at") or ""} for r in rows]})
