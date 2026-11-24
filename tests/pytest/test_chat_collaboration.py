import asyncio
import json
from unittest.mock import AsyncMock, patch

from agentica.run.response import RunEvent, RunResponse, ToolCallInfo
from tornado.testing import gen_test
from agentica import Agent, OpenAIChat
from agentica.subagents import SubagentRegistry, get_subagent_config

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
                assert delegate.call_args.args[1] == "campus_research"
        assert tool.functions["task"].manages_own_timeout

    @gen_test
    async def test_campus_child_inherits_queries_but_cannot_spawn_or_write(self):
        tools = agent_service._tools_for({"tools": '["task", "campus_calendar", "todo"]',
                                          "rag_kb_ids": '["bound-kb"]'})
        registry = SubagentRegistry()
        children = registry._select_child_tools(tools, get_subagent_config("campus_research"))
        names = {name for tool in children for name in registry._tool_names(tool)}
        assert {"campus_calendar", "campus_knowledge"} <= names
        assert "task" not in names and "write_todos" not in names
        lookup = next(tool for tool in children if getattr(tool, "__name__", "") == "campus_knowledge")
        with patch.object(agent_service, "retrieve", new_callable=AsyncMock, return_value=[]) as retrieve:
            await lookup("奖学金")
        retrieve.assert_awaited_once_with("奖学金", ["bound-kb"])

    @gen_test
    async def test_sdk_spawns_campus_child_and_returns_findings(self):
        parent = Agent(model=OpenAIChat(id="test", api_key="test"), tools=[CampusTaskTool()],
                       enable_session_log=False)
        tool = next(t for t in parent.tools if isinstance(t, CampusTaskTool))
        tool.set_parent_agent(parent)
        seen = []

        async def child_reply(child, *args, **kwargs):
            seen.append(child.name)
            yield RunResponse(content="已找到申请材料，须核对适用年份")

        with patch.object(Agent, "run_stream", child_reply):
            result = json.loads(await tool.task("检索申请材料"))
        assert result["success"] is True, result
        assert result["subagent_type"] == "campus_research"
        assert "申请材料" in result["result"] and len(seen) == 1

    def test_collaboration_option_validates_availability(self):
        response = self.post_json("/api/chat", {"message": "查资料", "collaboration": "yes"})
        assert response.code == 400
        with patch.object(chat, "collaboration_available", return_value=False):
            response = self.post_json("/api/chat", {"message": "查资料", "collaboration": True})
        assert response.code == 400
        assert "未启用" in response.body.decode()

    def test_chat_page_renders_collaboration_guide(self):
        response = self.get_json("/")
        assert response.code == 200
        assert 'id="collaborationPreferred"' in response.body.decode()
        assert "什么时候用" in response.body.decode()

    def test_collaboration_preference_reaches_stream(self):
        seen = []

        async def reply(*args, **kwargs):
            seen.append(kwargs.get("collaboration"))
            yield {"type": "delta", "text": "汇总完成"}
            yield {"type": "done", "answer": "汇总完成"}

        with patch.object(chat, "stream_answer", reply), patch.object(chat, "collaboration_available", return_value=True):
            response = self.post_json("/api/chat", {"message": "查资料", "collaboration": True})
        assert b"event: done" in response.body and seen == [True]

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
