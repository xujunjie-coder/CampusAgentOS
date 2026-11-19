"""
人脸登录与人脸数据管理接口（任务12）

前台（登录后，走 token 会话）：
- GET    /api/face/status        录入状态、张数、引擎能力（含是否降级）
- POST   /api/face/enroll        录入/追加一张人脸（JSON base64 或 multipart），成功后开启本人人脸登录
- POST   /api/face/verify        1:1 校验（本人已登录场景）
- DELETE /api/face/<id>          删除本人指定人脸记录

匿名登录：
- POST   /auth/face/login        必填用户名，仅与该账号的人脸特征比对

后台（用户管理权限）：
- GET    /api/admin/users/<id>/faces              查看该用户人脸录入情况
- POST   /api/admin/users/<id>/faces              代录入（label 可选）
- POST   /api/admin/users/<id>/faces/<fid>        启停某张人脸
- DELETE /api/admin/users/<id>/faces/<fid>        删除某张人脸

安全：图片只在内存中处理，不入 static/；接口绝不返回特征向量；登录失败复用任务11 的锁定策略。
"""

import json
import logging

import tornado.ioloop
import tornado.web

from app import config
from app.controllers.admin import AdminApiHandler, backend_required, URL_USERS
from app.controllers.base import BaseHandler, session_required
from app.models.face import FaceRepository
from app.models.db import get_connection
from app.models.session import LoginLogRepository, SessionRepository
from app.models.user import UserRepository
from app.services import face_service

logger = logging.getLogger(__name__)


def _read_image(handler) -> bytes:
    """从请求取图片：优先 multipart 文件（img/file），其次 JSON 的 image 字段（base64/dataURL）"""
    files = handler.request.files or {}
    for field in ("img", "file", "image"):
        if files.get(field):
            return face_service.parse_image_input(files[field][0]["body"])
    raw = (handler.get_body_argument("image", "") or "").strip()
    if not raw:
        try:
            payload = json.loads(handler.request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        raw = payload.get("image") or ""
    if not raw:
        raise face_service.FaceError("缺少图片：请上传 img 文件或 JSON 中的 image（base64/dataURL）")
    return face_service.parse_image_input(raw)


def _face_error(handler, exc: Exception, status: int = 400):
    """统一错误出口：FaceError 回 400 并带可读文案"""
    if isinstance(exc, face_service.FaceError):
        handler.write_json({"ok": False, "error": str(exc)}, status=status)
    else:
        logger.warning("人脸接口异常：%r", exc)
        handler.write_json({"ok": False, "error": "人脸处理失败，请重试"}, status=400)


def _read_capture(handler, *, require_sequence=False):
    # 三帧是固定上限，额外限制每帧大小，避免匿名登录占用过多解码资源。
    frames = None
    if handler.request.headers.get("Content-Type", "").startswith("application/json"):
        try:
            payload = json.loads(handler.request.body)
        except (ValueError, UnicodeError):
            raise face_service.FaceError("拍摄请求格式错误") from None
        if not isinstance(payload, dict):
            raise face_service.FaceError("拍摄请求格式错误")
        if "frames" in payload:
            frames = payload["frames"]
            if not isinstance(frames, list) or len(frames) != face_service.CAPTURE_FRAME_COUNT:
                raise face_service.FaceError("请使用摄像头连续拍摄三帧")
    if frames is None:
        if require_sequence:
            raise face_service.FaceError("请使用摄像头连续拍摄三帧")
        return [_read_image(handler)]
    if any(not isinstance(frame, str) or len(frame) > 512 * 1024 for frame in frames):
        raise face_service.FaceError("摄像头画面过大，请重新拍摄")
    return [face_service.parse_image_input(frame) for frame in frames]


def _face_status(username):
    info = face_service.engine_info()
    faces = FaceRepository.list_by_user(username)
    version = info["feature_version"]
    for face in faces:
        face["needs_reenrollment"] = face["feature_algo"] != version
    usable = any(face["enabled"] and not face["needs_reenrollment"] for face in faces)
    return dict(enabled=bool(usable and UserRepository.get_face_enabled(username)),
                count=len(faces), faces=faces, **info)


class FaceBaseHandler(BaseHandler):
    """前台人脸接口基类：JSON 响应"""

    def ok(self, **data):
        self.write_json({"ok": True, **data})

    def fail(self, message: str, status: int = 400):
        self.write_json({"ok": False, "error": message}, status=status)


class FaceStatusApiHandler(FaceBaseHandler):
    """GET /api/face/status：本人录入状态 + 引擎能力（降级时明确提示精度受限）"""

    @session_required
    def get(self):
        self.ok(**_face_status(self.current_user))


class FaceEnrollApiHandler(FaceBaseHandler):
    """POST /api/face/enroll：录入/覆盖一张人脸，成功后自动开启本人人脸登录"""

    @session_required
    async def post(self):
        username = self.current_user
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        label = (payload.get("label") or self.get_body_argument("label", "default")).strip() or "default"
        try:
            captures = _read_capture(self)
            vector, quality = await tornado.ioloop.IOLoop.current().run_in_executor(
                None, face_service.enroll_capture, captures)
        except Exception as exc:
            _face_error(self, exc)
            return
        info = face_service.engine_info()
        face_id = FaceRepository.upsert(username, label, vector, info["feature_version"], quality, 1)
        UserRepository.set_face_enabled(username, 1)
        LoginLogRepository.record(username, "face_enroll", "录入人脸 %s" % label,
                                  self.request.remote_ip,
                                  self.request.headers.get("User-Agent", ""))
        self.ok(face_id=face_id, label=label, quality=round(quality, 4),
                count=FaceRepository.count(username), **info)


class FaceVerifyApiHandler(FaceBaseHandler):
    """POST /api/face/verify：1:1 校验（与本人已录入人脸比对）"""

    @session_required
    async def post(self):
        username = self.current_user
        features = FaceRepository.list_features(username)
        if not features:
            self.fail("尚未录入人脸，请先录入", status=404)
            return
        try:
            image_bytes = _read_image(self)
            best = await tornado.ioloop.IOLoop.current().run_in_executor(
                None, face_service.best_match, [image_bytes], features)
        except Exception as exc:
            _face_error(self, exc)
            return
        info = face_service.engine_info()
        matched = best["score"] >= face_service.threshold()
        self.ok(matched=matched, score=round(best["score"], 4), **info)


class FaceDeleteApiHandler(FaceBaseHandler):
    """DELETE /api/face/<id>：删除本人一张人脸；删空后自动关闭人脸登录"""

    @session_required
    def delete(self, face_id):
        username = self.current_user
        if not FaceRepository.delete(int(face_id), username):
            self.fail("人脸记录不存在或不属于当前账号", status=404)
            return
        remaining = FaceRepository.count(username)
        if remaining == 0:
            UserRepository.set_face_enabled(username, 0)
        self.ok(count=remaining)


class FaceToggleApiHandler(FaceBaseHandler):
    """POST /api/face/toggle：本人开启/关闭人脸登录（只改开关，不删除已录特征）

    - 关：face_enabled=0，特征与记录全部保留，随时可再开；
    - 开：要求至少有一条启用的人脸记录，否则拒绝并提示先录入；
    - 写登录审计（face_open / face_close），便于后台登录日志追溯。
    """

    @session_required
    def post(self):
        username = self.current_user
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        raw = payload.get("enabled", self.get_body_argument("enabled", None))
        if raw is None:
            self.fail("缺少 enabled 参数（true / false）")
            return
        enabled = 1 if raw in (1, "1", True, "true", "on") else 0
        if enabled:
            status = _face_status(username)
            if not any(face["enabled"] and not face["needs_reenrollment"] for face in status["faces"]):
                self.fail("尚未录入可用人脸，请先录入后再开启人脸登录")
                return
        UserRepository.set_face_enabled(username, enabled)
        LoginLogRepository.record(username, "face_open" if enabled else "face_close",
                                  "开启人脸登录" if enabled else "关闭人脸登录",
                                  self.request.remote_ip,
                                  self.request.headers.get("User-Agent", ""))
        self.ok(enabled=bool(enabled), count=FaceRepository.count(username))


class FaceLoginHandler(BaseHandler):
    """POST /auth/face/login：刷脸登录（匿名）

    - username 必填，只与该账号启用的特征比对
    - 通过后签发与密码登录同一套 token 会话并写审计；失败复用任务11 的失败计数与锁定
    """

    async def post(self):
        client_ip = self.request.remote_ip
        user_agent = self.request.headers.get("User-Agent", "")
        try:
            body = self.request.body.decode("utf-8")
            payload = json.loads(body) if body.strip().startswith("{") else {}
        except Exception:
            payload = {}
        raw_username = (payload.get("username") if isinstance(payload, dict) else None)
        if raw_username is None:
            raw_username = self.get_body_argument("username", "")
        username = raw_username.strip() if isinstance(raw_username, str) else ""
        if not username or len(username) > 32:
            self.set_status(400)
            self.render("login.html", title="登录", error="请输入有效的登录用户名", username="")
            return

        if UserRepository.is_locked(username):
            LoginLogRepository.record(username, "locked", "人脸登录锁定期内尝试", client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录", error="尝试次数过多，请稍后再试", username=username)
            return

        if not UserRepository.get_face_enabled(username) or not FaceRepository.has_enabled(username):
            LoginLogRepository.record(username, "face_fail", "未录入/未开启人脸登录",
                                      client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录", error="该账号未开启人脸登录", username=username)
            return

        try:
            images = _read_capture(self, require_sequence=True)
            features = FaceRepository.list_features(username)
            best = await tornado.ioloop.IOLoop.current().run_in_executor(
                None, face_service.best_match, images, features)
        except face_service.LivenessRejected as exc:
            state = UserRepository.record_login_failure(username, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MINUTES)
            locked = bool(state.get("locked"))
            if not locked:
                self.set_header("X-Face-Retry", "1")
            LoginLogRepository.record(username, "face_fail", "静默活体检测未通过", client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录",
                        error="尝试次数过多，请稍后再试" if locked else str(exc), username=username)
            return
        except face_service.FaceError as exc:
            if isinstance(exc, face_service.CaptureQualityError):
                self.set_header("X-Face-Retry", "1")
            self.set_status(400)
            self.render("login.html", title="登录", error=str(exc), username=username)
            return
        except Exception:
            logger.exception("人脸登录处理失败")
            self.set_status(503)
            self.render("login.html", title="登录", error="人脸识别暂不可用，请改用密码登录", username=username)
            return

        if best["score"] < face_service.threshold():
            state = UserRepository.record_login_failure(
                username, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MINUTES)
            locked = bool(state.get("locked"))
            if not locked:
                self.set_header("X-Face-Retry", "1")
            LoginLogRepository.record(username, "face_fail",
                                      "人脸比对未通过 score=%.3f" % best["score"],
                                      client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录",
                        error="尝试次数过多，请稍后再试" if locked
                        else "人脸尚未匹配，请正对镜头并确认用户名", username=username)
            return

        row = UserRepository.get_user_by_username(username)
        if not row or not UserRepository.get_face_enabled(username):
            LoginLogRepository.record(username, "face_fail", "人脸登录未启用",
                                      client_ip, user_agent)
            self.set_status(401)
            self.render("login.html", title="登录", error="该账号未开启人脸登录", username=username)
            return

        role = row["role"] or "user"
        UserRepository.record_login_success(username)
        token, _session = SessionRepository.issue(username, role, client_ip, user_agent)
        self.set_session_cookie(token)
        # 兼容期：与密码登录一致，同步旧 cookie
        self.set_secure_cookie("username", username)
        self.set_secure_cookie("role", role)
        LoginLogRepository.record(username, "face_success",
                                  "人脸登录 score=%.3f engine=%s" % (
                                      best["score"], face_service.engine_info()["engine"]),
                                  client_ip, user_agent)
        if role == "admin":
            self.redirect("/admin")
        else:
            self.redirect("/")


class AdminUserFacesApiHandler(AdminApiHandler):
    """GET/POST /api/admin/users/<id>/faces —— 查看 / 代录该用户人脸（用户管理权限）"""

    @tornado.web.authenticated
    @backend_required
    def get(self, user_id):
        if not self.require_menu(URL_USERS):
            return
        target = UserRepository.get_user_by_id(int(user_id))
        if not target:
            self.fail("用户不存在", status=404)
            return
        username = target["username"]
        self.ok(username=username, **_face_status(username))

    @tornado.web.authenticated
    @backend_required
    async def post(self, user_id):
        if not self.require_menu(URL_USERS):
            return
        target = UserRepository.get_user_by_id(int(user_id))
        if not target:
            self.fail("用户不存在", status=404)
            return
        payload = self.body()
        label = (payload.get("label") or "admin").strip()[:32] or "admin"
        try:
            captures = _read_capture(self)
            vector, quality = await tornado.ioloop.IOLoop.current().run_in_executor(
                None, face_service.enroll_capture, captures)
        except Exception as exc:
            _face_error(self, exc)
            return
        info = face_service.engine_info()
        username = target["username"]
        face_id = FaceRepository.upsert(username, label, vector, info["feature_version"], quality, 1)
        UserRepository.set_face_enabled(username, 1)
        LoginLogRepository.record(username, "face_enroll", "管理员代录人脸 %s" % label,
                                  self.request.remote_ip,
                                  self.request.headers.get("User-Agent", ""))
        self.ok(face_id=face_id, label=label, quality=round(quality, 4),
                count=FaceRepository.count(username), **info)


class AdminUserFaceItemHandler(AdminApiHandler):
    """POST /api/admin/users/<id>/faces/<fid> 启停；DELETE 删除"""

    @tornado.web.authenticated
    @backend_required
    def post(self, user_id, face_id):
        if not self.require_menu(URL_USERS):
            return
        target = UserRepository.get_user_by_id(int(user_id))
        if not target:
            self.fail("用户不存在", status=404)
            return
        face = FaceRepository.get_by_id(int(face_id))
        if not face or face["username"] != target["username"]:
            self.fail("人脸记录不存在", status=404)
            return
        payload = self.body()
        enabled = payload.get("enabled")
        enabled = 1 if enabled in (1, "1", True, "true") else 0
        with get_connection() as conn:
            conn.execute("UPDATE user_faces SET enabled = ? WHERE id = ?", (enabled, int(face_id)))
        if not FaceRepository.has_enabled(target["username"]):
            UserRepository.set_face_enabled(target["username"], 0)
        self.ok(face_id=int(face_id), enabled=enabled)

    @tornado.web.authenticated
    @backend_required
    def delete(self, user_id, face_id):
        if not self.require_menu(URL_USERS):
            return
        target = UserRepository.get_user_by_id(int(user_id))
        if not target:
            self.fail("用户不存在", status=404)
            return
        face = FaceRepository.get_by_id(int(face_id))
        if not face or face["username"] != target["username"]:
            self.fail("人脸记录不存在", status=404)
            return
        FaceRepository.delete(int(face_id))
        remaining = FaceRepository.count(target["username"])
        if remaining == 0:
            UserRepository.set_face_enabled(target["username"], 0)
        self.ok(count=remaining)

