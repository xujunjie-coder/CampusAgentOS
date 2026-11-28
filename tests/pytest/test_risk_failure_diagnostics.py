"""A rejected item must not poison unrelated items in the same model request."""
from io import BytesIO
import json
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from tornado.httpclient import HTTPClientError, HTTPRequest, HTTPResponse

from app.services import intelligence_service as service


def rejection():
    response = HTTPResponse(HTTPRequest("http://model.invalid/chat/completions"), 400,
                            buffer=BytesIO(json.dumps({"error": {"code": 10013}}).encode()))
    return HTTPClientError(400, response=response)


class TestRiskFailureDiagnostics(IsolatedAsyncioTestCase):
    async def test_content_rejection_isolated_without_rewriting_input(self):
        items = [{"id": 1, "title": "新闻改版上线", "summary": "新版本上线"},
                 {"id": 2, "title": "事件报道", "summary": "原始事件摘要"}]
        calls = []

        async def answer(model, instruction, content):
            submitted = json.loads(content)
            calls.append(submitted)
            if len(submitted) > 1 or submitted[0]["id"] == 2:
                raise rejection()
            return {"1": {"level": "normal", "reason": "普通改版新闻", "evidence": ""}}

        with patch.object(service, "complete_json", side_effect=answer), \
                patch.object(service, "chat_engine", return_value={}), \
                patch.object(service.intelligence, "save_review") as save:
            failed = await service.classify_reviews(items)
        self.assertEqual(failed, 1)
        self.assertEqual(calls, [items, [items[0]], [items[1]]])
        self.assertEqual(save.call_args_list[0].args[1], "normal")
        self.assertEqual(save.call_args_list[1].args[1], "error")
        self.assertIn("10013", save.call_args_list[1].args[2])

    async def test_auth_failure_is_not_retried_per_item(self):
        items = [{"id": n, "title": "新闻", "summary": "摘要"} for n in (1, 2)]
        with patch.object(service, "complete_json", new=AsyncMock(side_effect=HTTPClientError(401))) as call, \
                patch.object(service, "chat_engine", return_value={}), \
                patch.object(service.intelligence, "save_review") as save:
            self.assertEqual(await service.classify_reviews(items), 2)
        self.assertEqual(call.await_count, 1)
        self.assertTrue(all("鉴权" in c.args[2] for c in save.call_args_list))

    async def test_fabricated_evidence_stays_failed_with_precise_reason(self):
        items = [{"id": 1, "title": "新闻", "summary": "原文摘要"}]
        result = {"1": {"level": "high", "reason": "发生事故", "evidence": "虚构伤亡"}}
        with patch.object(service, "complete_json", new=AsyncMock(return_value=result)), \
                patch.object(service, "chat_engine", return_value={}), \
                patch.object(service.intelligence, "save_review") as save:
            self.assertEqual(await service.classify_reviews(items), 1)
        self.assertEqual(save.call_args.args[1], "error")
        self.assertIn("连续原文", save.call_args.args[2])
