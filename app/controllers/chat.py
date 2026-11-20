"""
智能体会话服务Controller层模块
包含2个主要接口，都要求登录后才能访问
- 1ChatHandler:POST /api/chat 以流式方式返回智能体问答结果
- 2HistoryHandler:GET /api/history 返回当前用户在SQLite中的会话历史记录,取最新对话。

任务10（数字员工与前台用户侧关联）：
- 请求体可选 employee_id 指定本轮对话的数字助理（输入区选择器下发），
  不传则沿用用户已保存的助理/系统默认数字员工（关联解析见 controllers/assistant.pick_assistant）
- 流开始时先下发 assistant 事件，告知前端本轮实际应答的助理（头像/名称/工具链路）
- assistant 消息落库时记录应答助理 id 与名称，历史记录按发言人身份渲染
"""

import asyncio
from contextlib import aclosing
import json
import logging
import re

from tornado.iostream import StreamClosedError

from app.controllers.assistant import assistant_brief, pick_assistant
from app.controllers.base import BaseHandler
from app.models.message import MessageRepository
from app.services.agent_service import stream_answer


CHAT_IDLE_TIMEOUT_SECONDS = 90
_ACTIVE = set()
_TIMEOUT_MESSAGE = "长时间没有收到新进度，已停止等待。你可以重试。"


def valid_session(value):
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", value)


class ChatHandler(BaseHandler):
    _stream_task = None

    def on_connection_close(self):
        if self._stream_task is not None:
            self._stream_task.cancel()
        super().on_connection_close()

    async def post(self):
        if not self.current_user:
            self.write_json({"detail": "未登录","login_url": "/auth/login"}, status=401)
            return
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
            message = payload.get("message")
        except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
            self.write_json({"detail": "请求体必须为JSON，且包含message字段"}, status=400)
            return
        if not isinstance(message, str) or not message.strip() or len(message) > 8000:
            self.write_json({"detail": "请输入 1 至 8000 字的消息"}, status=400)
            return

        session_id = payload.get("session_id", "default")
        if not valid_session(session_id):
            self.write_json({"detail": "会话编号无效"}, status=400)
            return
        username = self.current_user
        active_key = (username, session_id)
        if active_key in _ACTIVE:
            self.write_json({"detail": "该会话正在生成回复"}, status=409)
            return
        if MessageRepository.is_archived(username, session_id):
            self.write_json({"detail": "请先恢复已归档的会话"}, status=409)
            return
        # 任务10：按用户选定助理解析本轮智能体配置（显式选择会同步写入用户关联）
        employee, err = pick_assistant(username, payload.get("employee_id"))
        if err:
            self.write_json({"detail": err}, status=400)
            return
        employee_id = employee["id"] if employee else 0
        employee_name = employee["name"] if employee else ""
        history = [{"role": row["role"], "content": row["content"][:2000],
                    **({"interrupted": True} if row["is_partial"] else {})}
                   for row in MessageRepository.list_recent(username, 16, session_id)]

        self.start_sse()

        # 本轮实际应答的数字助理：前端据此给气泡署名/头像，不用猜测客户端选中项
        _ACTIVE.add(active_key)
        self._stream_task = asyncio.current_task()
        loop = asyncio.get_running_loop()
        deadline = asyncio.timeout(CHAT_IDLE_TIMEOUT_SECONDS)
        partial_answer = []
        saved = False
        error_message = None
        try:
            async with deadline:
                await self.send_event("assistant", assistant_brief(employee))
                async with aclosing(stream_answer(message, username, employee, history=history)) as events:
                    async for event in events:
                        deadline.reschedule(loop.time() + CHAT_IDLE_TIMEOUT_SECONDS)
                        etype = event["type"]
                        if etype == "delta":
                            partial_answer.append(event["text"])
                            await self.send_event("delta", event["text"])

                        elif etype == "tool":
                            await self.send_event("tool", {"name": event["name"], "arguments": event["arguments"]})
                        elif etype == "reasoning":
                            await self.send_event("reasoning", {"text": event["text"]})
                        elif etype == "notice":
                            await self.send_event("notice", {"text": event["text"]})
                        elif etype == "sources":
                            await self.send_event("sources", {"items": event.get("items") or []})
                        elif etype == "done":
                            answer = event.get("answer", "")
                            if answer:
                                # 任务10：记录应答助理身份，历史回放时按发言人渲染
                                MessageRepository.save_turn(username, session_id, message, answer,
                                                            employee_id, employee_name)
                                saved = True


                if not saved:
                    raise RuntimeError("Chat stream ended without a complete reply")
                await self.send_event("done", {})

        except (StreamClosedError, asyncio.CancelledError):
            pass
        except TimeoutError:
            error_message = _TIMEOUT_MESSAGE
        except Exception:
            error_message = _TIMEOUT_MESSAGE if deadline.expired() else "模型暂不可用，请稍后重试"
        finally:
            if not saved:
                try:
                    MessageRepository.save_turn(username, session_id, message, "".join(partial_answer),
                                                employee_id, employee_name, partial=True)
                except Exception:
                    logging.exception("Failed to save interrupted chat turn")
            self._stream_task = None
            _ACTIVE.discard(active_key)
        if error_message:
            await self.send_chat_error(error_message)

    async def send_chat_error(self, message):
        try:
            await self.send_event("error", {"message": message})
        except StreamClosedError:
            pass

class HistoryHandler(BaseHandler):
    def get(self):
        """任务10：返回行附带 employee_id/employee_name，前端按应答助理渲染头像与署名"""
        if not self.current_user:
            self.write_json({"detail": "未登录","login_url": "/auth/login"}, status=401)
            return
        limit = self.get_argument("limit", "50")
        try:
            limit = int(limit)
        except ValueError:
            limit = 50
        if limit <= 0:
            limit = 50
        archived = self.get_argument("archived", "") == "1"
        if self.get_argument("sessions", "") == "1":
            self.write_json(MessageRepository.list_sessions(self.current_user, archived=archived))
            return
        session_id = self.get_argument("session_id", "default")
        if not valid_session(session_id):
            self.write_json({"detail": "会话编号无效"}, status=400)
            return
        self.write_json(MessageRepository.list_recent(
            self.current_user, min(limit, 100), session_id, archived=archived))

    def post(self):
        if not self.current_user:
            self.write_json({"detail": "未登录"}, status=401)
            return
        try:
            payload = json.loads(self.request.body)
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict) or not valid_session(payload.get("session_id")) or \
                payload.get("action") not in ("archive", "restore", "delete"):
            self.write_json({"detail": "会话编号或操作无效"}, status=400)
            return
        session_id = payload["session_id"]
        if (self.current_user, session_id) in _ACTIVE:
            self.write_json({"detail": "请等该会话回复结束后再操作"}, status=409)
            return
        if not MessageRepository.change_session(self.current_user, session_id, payload["action"]):
            self.write_json({"detail": "该会话已变更，请刷新列表后重试"}, status=404)
            return
        self.write_json({"ok": True})

