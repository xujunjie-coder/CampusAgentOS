"""
WebSocket 基础通道封装（任务16）

- 握手鉴权：复用任务11 的 token 会话（cookie session_token），未登录 close(4401)；
  兼容期旧 username/role 签名 cookie；与 HTTP 侧共用 user_sessions，强制下线即时生效。
- 来源校验：check_origin 只放行同源与 CORS 白名单。
- 统一协议：客户端 {"type", "id", "payload"} → 服务端 {"type", "id", "ok", "data"|"error"}。
- 心跳：服务端每 WS_HEARTBEAT_SECONDS 发 ping，客户端回 pong；超时 close(4408)。
- 连接注册表：username → 连接集合，支持按用户推送/广播/踢下线（与后台强制下线联动）。

本次只提供基础通道与演示端点（/ws 回显、/ws/notify 推送），不替换既有 SSE 业务链路。
"""

import json
import logging
import time
from typing import Dict, Optional, Set

import tornado.ioloop
import tornado.websocket

from app import config
from app.controllers.base import SESSION_COOKIE
from app.models.session import SessionRepository

logger = logging.getLogger(__name__)

# 未登录 / 心跳超时 / 被踢的关闭码（RFC6455 4000-4999 为应用自定义）
CLOSE_UNAUTHORIZED = 4401
CLOSE_ORIGIN_DENIED = 4403
CLOSE_TIMEOUT = 4408
CLOSE_KICKED = 4409

# 连接注册表：username → 活跃连接
_CONNECTIONS: Dict[str, Set["BaseWebSocketHandler"]] = {}


def _same_origin(handler, origin: str) -> bool:
    """同源判断：协议 + Host 完全一致（无 Origin 头的非浏览器客户端放行，鉴权仍由会话把关）"""
    if not origin:
        return True
    host = handler.request.headers.get("Host", "")
    for scheme in ("http://", "https://", "ws://", "wss://"):
        if origin == scheme + host:
            return True
    return False


def push_to_user(username: str, payload: dict) -> int:
    """向某用户的全部连接推送一条消息，返回送达连接数"""
    sent = 0
    for handler in list(_CONNECTIONS.get(username, ())):
        try:
            handler.push(payload)
            sent += 1
        except Exception:
            handler.close(CLOSE_TIMEOUT, "推送失败，连接已关闭")
    return sent


def broadcast(payload: dict) -> int:
    """向全部在线连接广播，返回送达连接数"""
    return sum(push_to_user(name, payload) for name in list(_CONNECTIONS.keys()))


def kick_user(username: str, reason: str = "账号已在别处下线") -> int:
    """踢下线某用户全部连接（后台强制下线 / 改密后调用），返回关闭的连接数"""
    closed = 0
    for handler in list(_CONNECTIONS.get(username, ())):
        try:
            handler.close(CLOSE_KICKED, reason)
            closed += 1
        except Exception:
            pass
    _CONNECTIONS.pop(username, None)
    return closed


def online_count(username: str = None) -> int:
    if username:
        return len(_CONNECTIONS.get(username, ()))
    return sum(len(v) for v in _CONNECTIONS.values())


class BaseWebSocketHandler(tornado.websocket.WebSocketHandler):
    """WebSocket 基类：鉴权 + 协议 + 心跳 + 注册表"""

    # 单条消息上限（字节），防止恶意大包
    max_message_bytes = 256 * 1024

    def initialize(self, **kwargs):
        self.username: Optional[str] = None
        self.session: Optional[dict] = None
        self._last_pong = time.time()
        self._heartbeat_timer = None

    # ---------------- 握手 ----------------
    def check_origin(self, origin: str) -> bool:
        if _same_origin(self, origin):
            return True
        return origin in config.CORS_ALLOW_ORIGINS

    def get_current_user(self) -> Optional[str]:
        """与 HTTP 侧一致：token 会话优先；携带了无效 token 时不再回落旧 cookie"""
        raw = self.get_secure_cookie(SESSION_COOKIE)
        token = raw.decode("utf-8") if raw else ""
        if token:
            session = SessionRepository.get_active(token)
            if session:
                self.session = session
                return session["username"]
            return None
        if SESSION_COOKIE in self.request.cookies:
            return None
        username = self.get_secure_cookie("username")
        return username.decode("utf-8") if username else None

    def open(self, *args, **kwargs):
        self.username = self.get_current_user()
        if not self.username:
            self.close(CLOSE_UNAUTHORIZED, "未登录")
            return
        _CONNECTIONS.setdefault(self.username, set()).add(self)
        self._last_pong = time.time()
        self._start_heartbeat()
        self.push({"type": "ready", "data": {"username": self.username,
                                             "heartbeat": config.WS_HEARTBEAT_SECONDS}})
        logger.info("WebSocket 连接建立 user=%s 在线=%d", self.username, online_count())

    def on_close(self):
        self._stop_heartbeat()
        if self.username:
            conns = _CONNECTIONS.get(self.username)
            if conns:
                conns.discard(self)
                if not conns:
                    _CONNECTIONS.pop(self.username, None)
        logger.info("WebSocket 连接关闭 user=%s 在线=%d", self.username, online_count())

    # ---------------- 协议 ----------------
    def push(self, payload: dict) -> None:
        """服务端主动下发（自动补默认字段，避免客户端拿到不完整结构）"""
        message = {"ok": True, "id": None, "type": "notify"}
        message.update(payload or {})
        self.write_message(json.dumps(message, ensure_ascii=False))

    def reply(self, msg_id, ok: bool, data=None, error: str = "", msg_type: str = "response"):
        message = {"type": msg_type, "id": msg_id, "ok": bool(ok)}
        if ok:
            message["data"] = data
        else:
            message["error"] = error or "处理失败"
        self.write_message(json.dumps(message, ensure_ascii=False))

    def on_message(self, raw):
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8", "replace")
        if len(raw.encode("utf-8")) > self.max_message_bytes:
            self.close(CLOSE_TIMEOUT, "消息过大")
            return
        try:
            message = json.loads(raw or "{}")
        except (json.JSONDecodeError, ValueError):
            self.reply(None, False, error="消息必须是 JSON")
            return
        if not isinstance(message, dict):
            self.reply(None, False, error="消息必须是 JSON 对象")
            return
        msg_type = (message.get("type") or "").strip()
        msg_id = message.get("id")
        payload = message.get("payload")
        if msg_type == "ping":
            self._last_pong = time.time()
            self.reply(msg_id, True, {"server_time": int(time.time())}, msg_type="pong")
        elif msg_type == "pong":
            self._last_pong = time.time()
        elif msg_type == "echo":
            self.reply(msg_id, True, payload, msg_type="echo")
        elif msg_type == "notify":
            # 演示：客户端触发一次服务端推送（真实推送由后台任务调用 push_to_user）
            push_to_user(self.username, {"type": "notify", "data": payload})
            self.reply(msg_id, True, {"pushed": True})
        else:
            self.reply(msg_id, False, error="未知消息类型：%s" % (msg_type or "(空)"))

    # ---------------- 心跳 ----------------
    def _start_heartbeat(self):
        self._heartbeat_timer = tornado.ioloop.PeriodicCallback(
            self._heartbeat_tick, config.WS_HEARTBEAT_SECONDS * 1000)
        self._heartbeat_timer.start()

    def _stop_heartbeat(self):
        if self._heartbeat_timer is not None:
            try:
                self._heartbeat_timer.stop()
            except Exception:
                pass
            self._heartbeat_timer = None

    def _heartbeat_tick(self):
        """超过 2 个心跳周期没有 pong，视为客户端已死，主动断开"""
        if time.time() - self._last_pong > config.WS_HEARTBEAT_SECONDS * 2:
            self.close(CLOSE_TIMEOUT, "心跳超时")
            return
        try:
            self.write_message(json.dumps({"type": "ping", "ok": True, "id": None,
                                           "data": {"ts": int(time.time())}}))
        except tornado.websocket.WebSocketClosedError:
            self._stop_heartbeat()


class EchoWebSocketHandler(BaseWebSocketHandler):
    """/ws：基础通道演示端点（心跳 + 回显 + 服务端推送）"""


class NotifyWebSocketHandler(BaseWebSocketHandler):
    """/ws/notify：服务端事件推送通道（后台长任务进度后续可平滑迁移到这里）"""

    def open(self, *args, **kwargs):
        super().open(*args, **kwargs)
        if self.username:
            self.push({"type": "notify", "data": {"message": "已订阅通知通道"}})
