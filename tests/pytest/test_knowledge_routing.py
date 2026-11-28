"""Campus questions must reach bound knowledge despite available course files."""
import pytest

from app.services import agent_service as service
from test_knowledge_retrieval import run_local


@pytest.mark.parametrize("query", [
    "请给我介绍一下我们计算机学院，时长必须超过1分钟",
    "计算机学院招生宣传演讲稿",
    "奖学金怎么申请",
])
def test_campus_queries_do_not_search_unnamed_course_attachments(monkeypatch, query):
    calls = []
    async def retrieve(q, ids):
        calls.append(ids)
        return [{"id": 14, "score": 0.7, "excerpt": "学院简介"}]
    monkeypatch.setattr(service, "retrieve", retrieve)
    monkeypatch.setattr(service, "available_local_materials", lambda ids: [
        ("network", {"knowledge_id": 26})])
    hits, materials = run_local(service._retrieve_course_first(query, [14, 19], []))
    assert calls == [[14, 19]]
    assert hits[0]["id"] == 14 and not materials


def test_named_course_still_prefers_its_local_attachment(monkeypatch):
    calls = []
    async def retrieve(q, ids):
        calls.append(ids)
        return [{"id": 26, "score": 0.7, "excerpt": "计算机网络原理", "source_url": ""}]
    monkeypatch.setattr(service, "retrieve", retrieve)
    monkeypatch.setattr(service, "file_path", lambda *args: True)
    materials = [("network", {"knowledge_id": 26})]
    hits, cited = run_local(service._retrieve_course_first("计算机网络有哪些核心知识点", [13], materials))
    assert calls == [["26"]]
    assert hits[0]["id"] == 26 and cited == materials
