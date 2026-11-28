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


@pytest.mark.parametrize("query", [
    "请给我介绍一下我们计算机学院，时长必须超过1分钟",
    "计算机学院招生宣传演讲稿",
])
def test_college_overview_beats_repeated_teacher_biographies(monkeypatch, query):
    overview = ("# 学院组织\n\n## 学院简介\n\n"
                "西华师范大学计算机学院成立于1993年。现有教职员工58人，"
                "具有博士学位教师16人。学院开设三个本科专业。")
    continuation = ("# 学院组织\n\n# 学院组织架构 > ## 学院简介\n\n"
                    "学院设有计算机科学与技术、软件工程、网络空间安全3个教研室。")
    footer = "\n原文：https://scswiki.com/organization/\n署名：SCSWiki 贡献者"
    texts = [overview + footer, continuation + footer] + [
        "# 教研室\n\n#### 教育背景\n\n西华师范大学计算机学院，计算机科学与技术专业，"
        f"{2000 + i}年毕业，现为计算机学院教师。\n原文：https://scswiki.com/teacher/jys"
        for i in range(12)
    ]
    rows = [{"id": 14 if i < 2 else 19, "title": "学院概况与组织" if i < 2 else "教师专栏",
             "content": text, "vector": json.dumps(service.lexical_vector(text))}
            for i, text in enumerate(texts)]
    monkeypatch.setattr(service, "embedding_engine", lambda: None)
    monkeypatch.setattr(service.intelligence, "knowledge_chunks", lambda *a: rows)
    hits = run_local(service.retrieve(query, [14, 19]))
    assert "1993年" in hits[0]["excerpt"]
    assert any("3个教研室" in h["excerpt"] for h in hits[:2])
    assert hits[0]["source_url"] == "https://scswiki.com/organization/"
