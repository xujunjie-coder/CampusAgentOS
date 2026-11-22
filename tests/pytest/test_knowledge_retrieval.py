"""Knowledge provenance and corrupt-text handling without external models."""
import json

import pytest

from app.services import intelligence_service as service


def run_local(coro):
    """Local lexical retrieval has no I/O awaits, so it needs no socket-backed loop."""
    try:
        coro.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coro.close()
    raise AssertionError("Test unexpectedly requested asynchronous I/O")


@pytest.mark.parametrize("url", [
    "https://scswiki.com/services/scholarship",
    "https://scswiki.com/start/financial-aid#申请",
    "https://scswiki.com:443/study/cpp-basics",
])
def test_provenance_accepts_exact_https_origin(url):
    assert service._scswiki_source_url("内容\n\n原文：" + url + "\n署名：SCSWiki") == url


@pytest.mark.parametrize("line", [
    "原文：http://scswiki.com/services/scholarship",
    "原文：https://scswiki.com.evil.example/page",
    "原文：https://scswiki.com@evil.example/page",
    "原文：https://user:password@scswiki.com/page",
    "原文：https://scswiki.com:8080/page",
    "原文：javascript:alert(1)",
    "原文：//scswiki.com/page",
    "[正文链接](https://scswiki.com/page)",
    "原文：https://scswiki.com:bad/page",
    "原文：https://scswiki.com/pa\x00ge",
])
def test_provenance_rejects_untrusted_urls(line):
    assert service._scswiki_source_url(line) == ""


def test_control_filter_preserves_markdown_and_rejects_binary_text():
    assert service.is_usable_knowledge_text("# 标题\n\n|列|值|\r\n\t正常文本\n")
    assert service.is_usable_knowledge_text("a" * 100 + "\x00")
    assert not service.is_usable_knowledge_text("正常" + "\x00" * 20)
    assert not service.is_usable_knowledge_text("内容" + "\x1b" * 4)
    assert not service.is_usable_knowledge_text("")


def test_retrieve_filters_corrupt_chunks_and_preserves_bound_ids(monkeypatch):
    text = "# 奖学金\n申请条件和评定流程\n原文：https://scswiki.com/services/scholarship"
    vector = service.lexical_vector(text)
    good = {"id": 12, "title": "SCSWiki · 办事指南", "content": text, "vector": json.dumps(vector)}
    bad = dict(good, id=13, content="奖学金\x00" * 100)
    calls = []
    monkeypatch.setattr(service, "embedding_engine", lambda: None)
    def rows(ids, model):
        calls.append((ids, model))
        return [bad, good]
    monkeypatch.setattr(service.intelligence, "knowledge_chunks", rows)
    hits = run_local(service.retrieve("奖学金评定", ["12", "13", "12", "invalid"]))
    assert calls == [([12, 13], "local-lexical-v1")]
    assert len(hits) == 1 and hits[0]["id"] == 12
    assert hits[0]["source_url"] == "https://scswiki.com/services/scholarship"


def test_retrieve_without_url_keeps_existing_documents(monkeypatch):
    text = "校内奖学金申请条件和评定流程"
    monkeypatch.setattr(service, "embedding_engine", lambda: None)
    monkeypatch.setattr(service.intelligence, "knowledge_chunks", lambda *a: [
        {"id": 7, "title": "学院细则", "content": text,
         "vector": json.dumps(service.lexical_vector(text))}])
    hits = run_local(service.retrieve("奖学金申请", [7]))
    assert hits and hits[0]["source_url"] == ""
