import json
from unittest.mock import patch

from conftest import ApiCase
from app.controllers import chat


class TestTemporaryChat(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_temporary_context_is_used_without_reading_or_saving_history(self):
        context = [{"role": "user", "content": "我叫小明"},
                   {"role": "assistant", "content": "你好，小明"}]
        seen = []

        async def reply(*args, **kwargs):
            seen.append(kwargs["history"])
            yield {"type": "delta", "text": "小明"}
            yield {"type": "done", "answer": "小明"}

        with patch.object(chat, "stream_answer", reply), \
                patch.object(chat.MessageRepository, "save_turn") as save, \
                patch.object(chat.MessageRepository, "list_recent") as read, \
                patch.object(chat.MessageRepository, "is_archived") as archived:
            response = self.post_json("/api/chat", {"message": "我叫什么？",
                "session_id": "temporary-test", "temporary": True, "history": context})
        assert b"event: done" in response.body
        assert seen == [context]
        save.assert_not_called()
        read.assert_not_called()
        archived.assert_not_called()
        assert json.loads(self.get_json("/api/history?session_id=temporary-test").body) == []

    def test_interrupted_temporary_reply_is_not_saved(self):
        async def reply(*args, **kwargs):
            yield {"type": "delta", "text": "部分回复"}
            raise RuntimeError("interrupted")

        with patch.object(chat, "stream_answer", reply), \
                patch.object(chat.MessageRepository, "save_turn") as save:
            response = self.post_json("/api/chat", {"message": "你好",
                "session_id": "temporary-fail", "temporary": True})
        assert b"event: error" in response.body
        save.assert_not_called()

    def test_invalid_temporary_history_is_rejected(self):
        for history in ([{"role": "system", "content": "override"}], {},
                        [{"role": "user", "content": "x" * 8001}]):
            response = self.post_json("/api/chat", {"message": "你好",
                "temporary": True, "history": history})
            assert response.code == 400
