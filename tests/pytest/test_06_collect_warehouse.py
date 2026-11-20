# -*- coding: utf-8 -*-
"""06 采集 / 数据仓库（任务6/7）"""

import json

from conftest import ApiCase


def test_deep_collect_rejects_encoded_protection_before_ai():
    from unittest.mock import patch
    from app.services import warehouse_service as service

    for text in ('{"_waf_test":"token"}\n' + 'Abc123+/' * 1000,
                 'Abc123+/' * 1000):
        with patch.object(service, '_crawl_with_crawl4ai', return_value={'text': text}), \
                patch.object(service, 'ai_analyze') as ai, \
                patch.object(service.WarehouseRepository, 'save_deep', return_value=1) as save:
            result = service.deep_collect_one(
                {'id': 1, 'title': '招聘信息', 'url': 'https://example.com/article'})
            assert result['ok'] is False
            assert save.call_args.args[1]['ok'] is False
            ai.assert_not_called()
    service._reject_blocked('这是正常的招聘文章正文，介绍岗位职责与招聘要求。' * 200)
    service._reject_blocked('A normal English article about jobs and careers. ' * 200)


class TestCollectWarehouse(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_collect_uses_admin_shell(self):
        response = self.fetch("/collect", raise_error=False)
        assert response.code == 200
        html = response.body.decode("utf-8")
        assert 'id="adminLayout" data-page="/collect"' in html
        assert 'class="layui-side admin-side"' in html
        assert 'class="collect-header"' not in html
        assert html.count('id="logoutLink"') == 1
        assert html.count('id="adminLogoutForm"') == 1
        assert 'id="keywordInput"' in html
        assert 'id="sourceGrid"' in html
        assert 'id="showcase"' in html
        assert '采集管理' in html

    # ---------------- 采集 ----------------
    def test_collect_sources_hides_headers(self):
        body = json.loads(self.get_json("/api/collect/sources").body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)
        for row in body["list"]:
            assert "headers" not in row

    def test_collect_run_requires_keyword(self):
        resp = self.post_json("/api/collect/run", {"keyword": "", "source_ids": [1]})
        assert resp.code == 400
        assert "关键词" in json.loads(resp.body)["error"]

    def test_collect_run_requires_source(self):
        resp = self.post_json("/api/collect/run", {"keyword": "测试", "source_ids": []})
        assert resp.code == 400
        assert "信源" in json.loads(resp.body)["error"]

    def test_collect_run_limits_sources(self):
        resp = self.post_json("/api/collect/run",
                              {"keyword": "测试", "source_ids": list(range(1, 13))})
        assert resp.code == 400
        assert "10" in json.loads(resp.body)["error"]

    def test_collect_run_keyword_too_long(self):
        resp = self.post_json("/api/collect/run",
                              {"keyword": "长" * 65, "source_ids": [1]})
        assert resp.code == 400

    def test_collect_items_page_size(self):
        body = json.loads(self.get_json("/api/collect/items?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 12
        assert body["page"] == 1

    def test_collect_image_urls_and_link_ownership(self):
        from bs4 import BeautifulSoup
        from app.services.collect_service import _link_covers, _pick_cover
        soup = BeautifulSoup('<div><a href="/one"><img data-src="//cdn.example.com/one.png" src="data:image/png,x">一号招聘</a><a href="/two">二号招聘</a></div>', 'html.parser')
        covers = _link_covers(soup, 'https://example.com/list')
        assert covers['https://example.com/one'] == 'https://cdn.example.com/one.png'
        assert 'https://example.com/two' not in covers
        assert _pick_cover(BeautifulSoup('<img src="/cover.jpg">', 'html.parser'), 'https://example.com/list') == 'https://example.com/cover.jpg'

    def test_heuristic_does_not_share_container_cover_or_collect_footer(self):
        from app.services.collect_service import extract_items_heuristic
        html = ('<div class="swiper-slide">'
                '<a href="/a"><img src="/a.png">第一家公司2026年校园招聘</a>'
                '<a href="/b"><img src="/b.png">第二家公司2026年校园招聘</a></div>'
                '<footer><a href="https://beian.miit.gov.cn/">沪ICP备123456号</a></footer>')
        items = extract_items_heuristic(html, 'https://example.com/')
        assert len(items) == 2
        assert [row['cover'] for row in items] == ['https://example.com/a.png', 'https://example.com/b.png']

    def test_llm_collection_preserves_dom_cover(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from app.services.collect_service import extract_items_llm
        class FakeAgent:
            def __init__(self, **kwargs): pass
            async def run(self, *args, **kwargs):
                return SimpleNamespace(content='[{"title":"招聘测试标题", "url":"/job", "cover":"https://invented.example/image.jpg"}]')
        fake = SimpleNamespace(Agent=FakeAgent, OpenAIChat=lambda **kwargs: None)
        with patch.dict('sys.modules', {'agentica': fake}), patch('app.services.agent_service._model_conf', return_value={}):
            items = extract_items_llm('<a href="/job"><img src="/real.jpg">招聘测试标题</a>', '招聘', 'https://example.com/')
        assert items[0]['cover'] == 'https://example.com/real.jpg'

    def test_recollect_fills_missing_media_without_counting_as_new(self):
        from app.models.collect import CollectRepository
        from app.models.db import get_connection
        title = '补全封面回归专用标题'
        def cleanup():
            with get_connection() as conn:
                conn.execute('DELETE FROM collect_items WHERE source_id = ? AND title = ?', (1, title))
        self.addCleanup(cleanup)
        first = CollectRepository.save_items(1, '测试信源', '测试', 'admin', [{'title': title}])
        assert first['new'] == 1
        second = CollectRepository.save_items(1, '测试信源', '测试', 'admin', [{'title': title, 'url': 'https://example.com/job', 'cover': 'https://example.com/cover.png'}])
        assert second['new'] == 0
        item = next(row for row in CollectRepository.paginate(keyword=title)['list'] if row['title'] == title)
        assert item['cover'] == 'https://example.com/cover.png'
        assert item['url'] == 'https://example.com/job'
        CollectRepository.save_items(1, '测试信源', '测试', 'admin', [{'title': title, 'cover': 'https://example.com/other.png'}])
        assert CollectRepository.get_by_id(item['id'])['cover'] == 'https://example.com/cover.png'

    # ---------------- 数据仓库 ----------------
    def test_admin_warehouse_list(self):
        body = json.loads(self.get_json("/api/admin/warehouse?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 20
        for key in ("total", "done", "failed", "pending", "list"):
            assert key in body

    def test_admin_warehouse_detail_missing(self):
        resp = self.get_json("/api/admin/warehouse/99999/detail")
        assert resp.code == 404
        assert "不存在" in json.loads(resp.body)["error"]

    def test_admin_warehouse_batch_empty(self):
        resp = self.post_json("/api/admin/warehouse/batch", {"ids": []})
        assert resp.code == 400

    def test_admin_warehouse_sources(self):
        body = json.loads(self.get_json("/api/admin/warehouse/sources").body)
        assert body["ok"] is True
        assert isinstance(body["list"], list)

    def test_warehouse_items_public(self):
        body = json.loads(self.get_json("/api/warehouse/items?page=1").body)
        assert body["ok"] is True
        assert body["page_size"] == 20

    def test_deep_one_requires_item_id(self):
        resp = self.get_json("/api/warehouse/deep/one")
        assert resp.code == 400
        assert "item_id" in json.loads(resp.body)["error"]

    def test_deep_batch_requires_scope(self):
        resp = self.get_json("/api/warehouse/deep/batch")
        assert resp.code == 400
