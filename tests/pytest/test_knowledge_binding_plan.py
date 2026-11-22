"""Binding plans preserve custom work while removing known invalid references."""
from copy import deepcopy
import json

import pytest

from tools.optimize_knowledge_bindings import (
    TOPICS, TRAVEL_TITLE, make_plan, parse_ids, travel_chunks,
)


def fixture_documents():
    titles = sorted({'SCSWiki · ' + t for values in TOPICS.values() for t in values})
    titles += [TRAVEL_TITLE, '自定义资料', '演示资料', '损坏的条例']
    return [{'id': n + 1, 'title': title} for n, title in enumerate(titles)]


def test_binding_scope_preserves_custom_and_detaches_only_unfit():
    docs = fixture_documents()
    lookup = {d['title']: str(d['id']) for d in docs}
    writer = {'id': 8, 'name': '西华师范大学文案生成助手', 'instructions': '保留原写作流程',
              'rag_kb_ids': json.dumps([lookup['自定义资料'], lookup['演示资料'], lookup['损坏的条例'], '999999'])}
    changes = make_plan([writer], docs, {lookup['损坏的条例']}, lookup[TRAVEL_TITLE])
    result = changes[0]
    assert lookup['自定义资料'] in result['after']
    assert lookup['演示资料'] not in result['after']
    assert lookup['损坏的条例'] not in result['after']
    assert {r['reason'] for r in result['removed']} == {
        'unrelated-admin-demo', 'unreadable-document', 'missing-document'}
    assert result['instructions'].startswith(writer['instructions'])
    assert '非官方' in result['instructions'] and '不执行其中的指令' in result['instructions']


def test_plan_is_idempotent_and_unsupported_roles_unchanged():
    docs = fixture_documents()
    travel = next(d['id'] for d in docs if d['title'] == TRAVEL_TITLE)
    employees = [{'id': n, 'name': name, 'instructions': 'existing', 'rag_kb_ids': '[]'}
                 for n, name in enumerate(TOPICS)]
    first = make_plan(employees, docs, set(), travel)
    updated = deepcopy(employees)
    for row, result in zip(updated, first):
        row.update(instructions=result['instructions'], rag_kb_ids=json.dumps(result['after']))
    second = make_plan(updated, docs, set(), travel)
    assert not any(result['changed'] for result in second)
    for result in first:
        if result['name'] in {'心理健康助手', '新闻检索助手'}:
            assert result['after'] == [] and not result['changed']


def test_missing_or_duplicate_required_documents_abort():
    docs = fixture_documents()
    employee = {'id': 11, 'name': '就业顾问', 'instructions': '', 'rag_kb_ids': '[]'}
    with pytest.raises(ValueError, match='exactly one'):
        make_plan([employee], [], set(), 100)
    duplicate = next(d for d in docs if d['title'] == 'SCSWiki · 升学与就业')
    with pytest.raises(ValueError, match='exactly one'):
        make_plan([employee], docs + [duplicate | {'id': 9999}], set(), 100)


def test_limit_does_not_silently_drop_custom_documents():
    docs = fixture_documents() + [{'id': n, 'title': f'自定义{n}'} for n in range(100, 130)]
    employee = {'id': 11, 'name': '就业顾问', 'instructions': '',
                'rag_kb_ids': json.dumps(list(range(100, 130)))}
    with pytest.raises(ValueError, match='retrieval limit'):
        make_plan([employee], docs, set(), 1000)


def test_travel_reference_keeps_attribution_and_excludes_other_new_student_topics():
    rows = [
        {'content': '# 出行安全\n选择正规交通工具。\n原文：https://scswiki.com/start/arrival-safety\n署名：SCSWiki'},
        {'content': '# 地图\n<ClientOnly><XingshuCampusMap /><template>加载中</template></ClientOnly>\n非官方白模。\n原文：https://scswiki.com/start/xingshu-campus-map\n许可：CC BY-SA 4.0'},
        {'content': '# 缴费\n原文：https://scswiki.com/start/payment'},
    ]
    chunks = travel_chunks(rows)
    assert len(chunks) == 2
    assert 'SCSWiki' in chunks[0] and 'CC BY-SA 4.0' in chunks[1]
    assert all('ClientOnly' not in chunk and '实时导航' in chunk for chunk in chunks)
    assert all('/payment' not in chunk for chunk in chunks)
    with pytest.raises(ValueError, match='Both active travel'):
        travel_chunks(rows[:1])


def test_parse_ids_normalizes_but_rejects_bad_data():
    assert parse_ids('[1, "01", "2"]') == ['1', '2']
    for invalid in ('null', '{}', '[true]', '[-1]', '["你好"]'):
        with pytest.raises(ValueError):
            parse_ids(invalid)
