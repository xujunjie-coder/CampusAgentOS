from unittest.mock import patch

from agentica.run.response import RunEvent, RunResponse, ToolCallInfo
from tornado.testing import gen_test

from app.controllers import chat
from app.services import agent_service
from conftest import ApiCase


class TestAvatarPresentation(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_presentation_flag_reaches_service_and_rejects_non_boolean(self):
        seen = []

        async def reply(*args, **kwargs):
            seen.append(kwargs.get("presentation", False))
            yield {"type": "delta", "text": "正式回答"}
            yield {"type": "done", "answer": "正式回答"}

        with patch.object(chat, "stream_answer", reply):
            for enabled in (True, False):
                response = self.post_json("/api/chat", {
                    "message": "介绍学院", "presentation": enabled,
                })
                assert b"event: done" in response.body
        assert seen == [True, False]
        assert self.post_json("/api/chat", {
            "message": "介绍学院", "presentation": "yes",
        }).code == 400

    @gen_test
    async def test_only_final_tool_free_answer_is_spoken(self):
        class FakeAgent:
            instructions = []

            async def run_stream(self, *args, **kwargs):
                yield RunResponse(content="先查一下资料。")
                call = ToolCallInfo(tool_name="search", tool_call_id="one")
                yield RunResponse(event=RunEvent.tool_call_started, tool_call=call)
                yield RunResponse(event=RunEvent.tool_call_completed, tool_call=call)
                yield RunResponse(content="换个关键词再试。")
                yield RunResponse(event=RunEvent.tool_call_started, tool_call=call)
                yield RunResponse(event=RunEvent.tool_call_completed, tool_call=call)
                yield RunResponse(content="学院设有")
                yield RunResponse(content="三个本科专业。")

        for enabled in (True, False):
            with patch.object(agent_service, "get_agent", return_value=FakeAgent()), \
                    patch.object(agent_service, "chat_engine", return_value=None):
                events = [event async for event in agent_service.stream_answer(
                    "介绍学院", "test", presentation=enabled)]
            text = "".join(event["text"] for event in events if event["type"] == "delta")
            assert text == ("学院设有三个本科专业。" if enabled else
                            "先查一下资料。换个关键词再试。学院设有三个本科专业。")
            assert events[-1] == {"type": "done", "answer": text}
            assert len([event for event in events if event["type"] == "tool"]) == 2
