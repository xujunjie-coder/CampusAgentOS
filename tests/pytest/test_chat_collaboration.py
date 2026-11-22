import asyncio
import json
from unittest.mock import AsyncMock, patch

from agentica.run.response import RunEvent, RunResponse, ToolCallInfo
from tornado.testing import gen_test

from app.controllers import chat
from app.services import agent_service
from app.services.agent_service import BuiltinTaskTool, CampusTaskTool
from conftest import ApiCase


class TestChatCollaboration(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_silent_subagent_batch_outlives_normal_idle_and_parent_finishes(self):
        async def reply(*args, **kwargs):
            for call_id in ("one", "two"):
                yield {"type": "tool", "name": "task", "call_id": call_id, "arguments": {}}
            await asyncio.sleep(.3)
            yield {"type": "tool_result", "name": "task", "call_id": "one", "status": "timeout"}
            yield {"type": "tool_result", "name": "task", "call_id": "two", "status": "completed"}
            yield {"type": "delta", "text": "根据已有资料汇总"}
            yield {"type": "done", "answer": "根据已有资料汇总"}

        with patch.object(chat, "stream_answer", reply), patch.multiple(
                chat, CHAT_IDLE_TIMEOUT_SECONDS=.15, CHAT_HEARTBEAT_SECONDS=.025,
                CHAT_COLLABORATION_TIMEOUT_SECONDS=1):
            resp = self.post_json("/api/chat", {"message": "分两路查询", "session_id": "parallel-ok"})
        assert resp.code == 200
        assert b": ping" in resp.body and b"event: done" in resp.body
        assert resp.body.count(b"event: tool_result") == 2
        assert b"event: error" not in resp.body
        history = json.loads(self.get_json("/api/history?session_id=parallel-ok").body)
        assistant = next(row for row in history if row["role"] == "assistant")
        assert assistant["content"] == "根据已有资料汇总" and not assistant["is_partial"]

    def test_keepalive_does_not_extend_business_timeout(self):
        cleaned_up = []

        async def reply(*args, **kwargs):
            try:
                yield {"type": "tool", "name": "task", "call_id": "stuck", "arguments": {}}
                await asyncio.sleep(10)
            finally:
                cleaned_up.append(True)

        with patch.object(chat, "stream_answer", reply), patch.multiple(
                chat, CHAT_IDLE_TIMEOUT_SECONDS=.15, CHAT_HEARTBEAT_SECONDS=.025,
                CHAT_COLLABORATION_TIMEOUT_SECONDS=.25):
            resp = self.post_json("/api/chat", {"message": "协作超时", "session_id": "parallel-timeout"})
        assert b": ping" in resp.body and b"event: error" in resp.body
        assert b"event: done" not in resp.body and cleaned_up == [True]
        assert "子智能体协作等待超时" in resp.body.decode()

    @gen_test
    async def test_delegated_time_budget_survives_tool_clone(self):
        tool = CampusTaskTool().clone()
        with patch.object(BuiltinTaskTool, "task", new_callable=AsyncMock) as delegate:
            for requested, expected in [(None, 120), (0, 120), (999, 120), (25, 25)]:
                await tool.task("research", timeout=requested)
                assert delegate.call_args.kwargs["timeout"] == expected
        assert tool.functions["task"].manages_own_timeout

    @gen_test
    async def test_agentica_partial_timeout_is_reported_without_stopping_parent(self):
        class Agent:
            async def run_stream(self, *args, **kwargs):
                call = ToolCallInfo(tool_name="task", tool_call_id="child-1")
                yield RunResponse(event=RunEvent.tool_call_started, tool_call=call)
                call.content = json.dumps({"success": False, "status": "timeout", "partial": True})
                yield RunResponse(event=RunEvent.tool_call_completed, tool_call=call)
                yield RunResponse(content="已汇总可用内容")

        with patch.object(agent_service, "get_agent", return_value=Agent()), \
                patch.object(agent_service, "chat_engine", return_value=None):
            events = [event async for event in agent_service.stream_answer("查资料", "test")]
        assert events[0]["call_id"] == "child-1"
        assert events[1] == {"type": "tool_result", "name": "task", "call_id": "child-1", "status": "timeout"}
        assert events[-1] == {"type": "done", "answer": "已汇总可用内容"}
