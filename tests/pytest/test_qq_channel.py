"""QQ collection correctness/coverage and authenticated job/review API contract."""
from unittest.mock import patch, AsyncMock
import asyncio

import pytest

from conftest import ApiCase
from app.models import qq_channel as repo
from app.services import qq_channel_service as svc


def options(**kw):
    return svc.validate_options(dict(channel='CWNUpindao', keywords='热水，食堂', **kw))


def detail(post_id='B_one', body='学生提案', comment='热水收费', extra=''):
    return '''<div class="detail"><h3 class="user-info__name-text">作者</h3>
    <div id="feed-content-%s"><span class="feed-detail-text">%s</span>
    <div class="feed-info__detail__time">2026-11-22</div>
    <div id="comment-container-%s"><div class="comment-bar__comment-count">评论3</div>
    <div id="c_first"><span class="comment-list-item__info__title-name">甲</span>
    <span class="comment-list-item__info__title-time">1天前</span>
    <div class="comment-richcontent"><span class="feed-detail-text">%s</span></div></div>
    <div id="c_second"><span class="comment-list-item__info__title-name">乙</span>
    <div class="comment-richcontent"><span class="feed-detail-text">%s</span></div></div>
    %s</div></div></div>''' % (post_id, body, post_id, comment, comment, extra)


def test_options_reject_untrusted_channels_and_bad_limits():
    for change in ({'channel':'https://evil.test'}, {'channel':'../../admin'}, {'max_posts':True},
                   {'max_posts':101}, {'max_comments':0}, {'keywords':[]},
                   {'start_date':'2026-02-30'}, {'start_date':'2026-11-23','end_date':'2026-11-22'}):
        with pytest.raises(svc.ChannelError):
            svc.validate_options(dict({'channel':'CWNUpindao', 'keywords':'校园'}, **change))
    assert svc.matching_keywords('ＡＢＣ 食堂', ['abc','宿舍','食堂']) == ['abc','食堂']
    assert svc.validate_options({'keywords':'热水，热水;食堂'})['keywords'] == ['热水','食堂']


def test_parse_ignores_sidebar_and_preserves_identical_comments_by_different_people():
    post = {'id':'B_one','url':'https://pd.qq.com/g/CWNUpindao/post/B_one'}
    parsed = svc.parse_post('<aside>热水恶意内容</aside>' + detail(), post)
    records = parsed['records']
    assert records[0]['content'] == '学生提案'
    assert records[0]['time'] == '2026-11-22'
    assert len(records) == 3
    assert records[1]['id'] != records[2]['id']
    assert records[1]['content'] == records[2]['content'] == '热水收费'
    assert svc.matching_keywords(records[0]['content'], ['热水']) == []
    assert all('恶意内容' not in r['content'] for r in records)


def test_links_only_accept_same_channel_https_posts():
    html = ''.join('<a href="%s">帖</a>' % url for url in [
        '/g/CWNUpindao/post/B_one?subc=12', 'https://pd.qq.com/g/CWNUpindao/post/B_one',
        'https://evil.test/g/CWNUpindao/post/B_bad', 'https://pd.qq.com/g/other/post/B_bad',
        'javascript:alert(1)', 'https://pd.qq.com:443/g/CWNUpindao/post/B_bad'])
    assert svc.links_from_html(html,'CWNUpindao') == [
        {'id':'B_one','url':'https://pd.qq.com/g/CWNUpindao/post/B_one'}]


class FakeCollector:
    def __init__(self):
        self.location = ''; self.screen = 0; self.expanded = False
    def open(self, url, selector):
        self.location = url
    def html(self):
        if '/post/' in self.location:
            post_id = self.location.rsplit('/',1)[-1]
            reply = '<div id="r_reply"><div class="comment-richcontent">食堂建议</div></div>' if self.expanded else ''
            return detail(post_id, extra=reply)
        # Simulate recycled DOM: the first screen disappears after scrolling.
        post_id = 'B_one' if self.screen == 0 else 'B_two'
        return '<a href="/g/CWNUpindao/post/%s">未命中关键词的标题</a>' % post_id
    def scroll(self, comments=False):
        if not comments: self.screen += 1
    def expand_reply(self):
        if self.expanded: return False
        self.expanded = True; return True


def test_virtual_list_accumulation_comment_only_matches_and_partial_coverage():
    saved, updates = [], []
    def emit(message, progress, rows):
        updates.append(progress); saved.extend(rows)
    result = svc.scan_channel_legacy(options(max_posts=2,max_scrolls=6), FakeCollector(), lambda:None, emit)
    assert result['discovered_posts'] == result['scanned_posts'] == 2
    assert result['scanned_comments'] == 6
    assert result['matched'] == len(saved) == 6
    assert all(r['kind'] != 'post' for r in saved)
    assert {r['post_id'] for r in saved} == {'B_one','B_two'}
    assert result['coverage'] == 'partial'
    assert any('上限' in w for w in result['warnings'])


def test_date_filter_does_not_treat_unknown_as_in_range():
    opt = options(start_date='2026-11-22',end_date='2026-11-22')
    assert svc.in_date_range('2026-11-22', opt) is True
    assert svc.in_date_range('2026-11-23', opt) is False
    assert svc.in_date_range('', opt) is None


def test_body_does_not_include_nested_comments_and_reply_keeps_parent_context():
    parsed = svc.parse_post(detail(extra='<div id="r_reply"><div class="comment-richcontent">食堂建议</div></div>'),
                            {'id':'B_one','url':'https://pd.qq.com/g/CWNUpindao/post/B_one'})
    assert parsed['records'][0]['content'] == '学生提案'
    reply = parsed['records'][-1]
    assert reply['kind'] == 'reply'
    assert reply['parent_id'] == 'c_second'
    assert '父评论：\n热水收费' in reply['context']


def test_post_images_keep_order_deduplicate_and_exclude_comments_avatars_emoji():
    body = '''<img src="https://example.com/one.jpg">
    <img src="https://example.com/one.jpg">
    <img src="placeholder" data-src="//example.com/two.jpg">
    <div style="background-image:url('https://example.com/three.jpg')"></div>
    <img alt="avatar-img" src="https://example.com/avatar.jpg">
    <img alt="emoji" src="https://example.com/emoji.gif">
    <img src="javascript:alert(1)"><img src="https://[invalid">
    <div class="user-info"><img src="https://example.com/author.jpg"></div>'''
    html = detail(body=body, extra='<div id="c_photo"><img src="https://example.com/comment.jpg"></div>')
    result = svc.parse_post(html, {'id': 'B_one', 'url': 'https://pd.qq.com/g/CWNUpindao/post/B_one'})
    assert result['records'][0]['metadata']['images'] == [
        'https://example.com/one.jpg', 'https://example.com/two.jpg', 'https://example.com/three.jpg']
    assert result['images'] == 3


def test_inline_styling_does_not_split_keyword():
    html = detail(comment='<span>热</span><strong>水</strong>收费<br>建议改进')
    parsed = svc.parse_post(html,{'id':'B_one','url':'https://pd.qq.com/g/CWNUpindao/post/B_one'})
    assert parsed['records'][1]['content'] == '热水收费\n建议改进'
    assert svc.matching_keywords(parsed['records'][1]['content'], ['热水']) == ['热水']


def test_image_metadata_updates_preserve_existing_post_metrics(tmp_path):
    import json
    import sqlite3
    from contextlib import contextmanager
    database = tmp_path / 'images.db'
    @contextmanager
    def connection():
        with sqlite3.connect(database) as conn:
            conn.row_factory = sqlite3.Row
            yield conn
    with connection() as conn:
        conn.execute('CREATE TABLE qq_channel_items(id INTEGER,run_id INTEGER,content TEXT,metadata TEXT)')
        conn.execute('INSERT INTO qq_channel_items VALUES(1,2,?,?)', ('摘要', json.dumps({'likes': 95, 'is_excerpt': True})))
    with patch.object(repo, 'get_connection', connection):
        repo.update_post(2, 1, {'content': '', 'metadata': {'images': ['https://example.com/a.jpg']}})
    with connection() as conn:
        result = conn.execute('SELECT * FROM qq_channel_items').fetchone()
        metadata = json.loads(result['metadata'])
        assert metadata == {'likes': 95, 'is_excerpt': False, 'images': ['https://example.com/a.jpg']}
        assert result['content'] == ''


def test_finished_legacy_thread_is_refreshed_once_for_images():
    with patch.object(repo, 'get_item', return_value={'kind': 'post', 'metadata': '{}'}), \
         patch.object(repo, 'comment_job', return_value={'status': 'finished'}), \
         patch.object(repo, 'create_comment_job'), patch.object(svc._pool, 'submit') as submit:
        try:
            svc.start_comments(1, 2)
            assert submit.call_count == 1
        finally:
            svc._slot.release()
    with patch.object(repo, 'get_item', return_value={'kind': 'post', 'metadata': '{"images":[]}'}), \
         patch.object(repo, 'comment_job', return_value={'status': 'finished'}), \
         patch.object(svc._pool, 'submit') as submit:
        svc.start_comments(1, 2)
        submit.assert_not_called()


def test_no_new_links_while_scroll_moves_does_not_stop_at_first_page():
    class LongList(FakeCollector):
        def html(self):
            if '/post/' in self.location:
                return super().html()
            post_id = 'B_one' if self.screen < 5 else 'B_two'
            return '<a href="/g/CWNUpindao/post/%s">帖</a>' % post_id
        def scroll(self, comments=False):
            if comments:
                return {'before':0,'after':0,'at_end':True}
            self.screen += 1
            return {'before':self.screen-1,'after':self.screen,'at_end':False}
    result = svc.scan_channel_legacy(options(max_posts=2,max_scrolls=10),LongList(),lambda:None,lambda *args:None)
    assert result['scanned_posts'] == result['discovered_posts'] == 2


def test_cancel_check_propagates_without_fabricating_success():
    def stop(): raise svc.StopCollection('stop')
    with pytest.raises(svc.StopCollection):
        svc.collect_channel(options(), FakeCollector(), stop, lambda *args:None)


def native_html(channel='CWNUpindao', scope='global-in-guild-result'):
    cards = []
    for post_id, stamp, likes in [('B_one','2026-11-23',1),('B_two','2026-11-20',20),('B_three','2026-11-22',20)]:
        cards.append('''<a href="/g/%s/post/%s"><div class="feed-card">
        <div class="main-text"><span>热水相关帖子</span><span class="suffix">全文</span></div>
        <div class="source"><span class="name">作者</span><span>%s</span></div>
        <div class="game-guild-main__short-content__like"><span class="game-guild-main__short-content__text">%d</span></div>
        <div class="game-guild-main__short-content__comment"><span class="game-guild-main__short-content__text">8</span></div>
        <div class="game-guild-main__short-content__share"><span class="game-guild-main__short-content__text">2</span></div>
        </div></a>''' % (channel,post_id,stamp,likes))
    return '<div class="main-title"><span class="btn-label">稀饭频道丨西华师范大学</span></div><div class="%s">%s</div>' % (scope,''.join(cards))


def test_native_search_never_opens_post_or_reads_comments():
    class Native:
        def __init__(self): self.searching=False;self.searches=[]
        def open(self,url,selector):
            assert '/post/' not in url
        def html(self):return native_html() if self.searching else '<h1>目标频道</h1>'
        def search(self,channel,keyword):self.searching=True;self.searches.append(keyword)
        def scroll_search(self):return {'before':0,'after':0}
    c=Native();snapshots=[]
    result=svc.collect_channel(options(),c,lambda:None,lambda message,p,rows:snapshots.extend(rows))
    assert c.searches==['热水','食堂']
    assert result['matched']==3
    assert result['scanned_comments']==0
    assert all(r['kind']=='post' for r in snapshots)
    assert all(r['metadata']['is_excerpt'] for r in snapshots)
    assert snapshots[-1]['matched']==['热水','食堂']


def test_native_search_rejects_global_fallback_and_other_channels():
    with pytest.raises(svc.ChannelError,match='本频道搜索'):
        svc.search_posts(native_html(scope='global-result'),'CWNUpindao',{'CWNUpindao'},'热水')
    assert svc.search_posts(native_html(channel='other'),'CWNUpindao',{'CWNUpindao'},'热水')==[]
    records=svc.search_posts(native_html(),'CWNUpindao',{'CWNUpindao'},'热水')
    assert records[0]['content']=='热水相关帖子'
    assert records[1]['heat']==30
    assert svc.count_number('1.2万')==12000


def test_native_loading_skeleton_is_not_a_successful_empty_search():
    html='<div class="main-title"><span class="main-btn">目标频道</span></div><div class="global-in-guild-result"><div class="skeleton__feed-card"></div></div>'
    with pytest.raises(svc.ChannelError,match='仍在加载'):
        svc.search_posts(html,'CWNUpindao',{'CWNUpindao'},'校园跑')


def test_in_channel_poster_time_and_name_are_parsed():
    html=native_html().replace('class="source"','class="poster"')
    records=svc.search_posts(html,'CWNUpindao',{'CWNUpindao'},'热水')
    assert records[0]['author']=='作者'
    assert records[0]['time']=='2026-11-23'
    assert records[0]['sort_time'].startswith('2026-11-23')


def test_ai_requires_verbatim_evidence_from_target_not_parent():
    item = {'content':'食堂价格太贵，希望改进', 'content_text':'某人发来一段威胁'}
    for finding in ({'category':'safety','reason':'威胁','evidence':'一段威胁'},
                    {'category':'feedback','reason':'正常投诉','evidence':''},
                    {'category':'invented','reason':'不合法分类','evidence':'食堂'}):
        with patch('app.services.model_service.complete_json',new=AsyncMock(return_value=finding)), \
             patch('app.services.model_service.chat_engine',return_value={'model_id':'test'}):
            assert asyncio.run(svc.analyze_item(item))['category'] == 'error'
    valid = {'category':'feedback','reason':'这是收费建议','evidence':'食堂价格太贵'}
    with patch('app.services.model_service.complete_json',new=AsyncMock(return_value=valid)), \
         patch('app.services.model_service.chat_engine',return_value={'model_id':'test'}):
        assert asyncio.run(svc.analyze_item(item)) == valid


class TestQQChannelApi(ApiCase):
    def test_login_and_menu_required(self):
        assert self.get_json('/api/collect/qq/runs').code == 401
        user, password = self.ensure_backend_role_without_menus()
        self.login_user(user,password)
        assert self.get_json('/api/collect/qq/runs').code == 403

    def test_reject_invalid_body_and_options(self):
        self.login()
        for body in ([], {'keywords':''}, {'keywords':'热水','max_posts':1000}):
            assert self.post_json('/api/collect/qq/runs',body).code == 400

    def test_run_items_review_dedup_and_cancellation(self):
        self.login()
        legacy = options();legacy.pop('mode')
        run_id = repo.create_run(legacy, 'admin')
        record = dict(id='c_one',kind='comment',post_id='B_one',content='热水收费贵',
                      url='https://pd.qq.com/g/CWNUpindao/post/B_one',matched=['热水'],context='学生提案')
        assert repo.save_items(run_id,[record,record]) == 1
        data = self._json(self.get_json('/api/collect/qq/runs/%d' % run_id))
        assert data['items']['total'] == 1
        item_id = data['items']['list'][0]['id']
        path = '/api/collect/qq/runs/%d/items/%d/review' % (run_id,item_id)
        assert self.post_json(path,{'status':'concern','reason':''}).code == 400
        assert self.post_json(path,{'status':'feedback','reason':'正常的收费建议'}).code == 200
        assert repo.items(run_id)['list'][0]['reviewer'] == 'admin'
        assert self.post_json('/api/collect/qq/runs/%d/items/%d/review' % (run_id+1,item_id),
                              {'status':'feedback'}).code == 404
        repo.update_run(run_id,'running','开始',{})
        assert self.post_json('/api/collect/qq/runs/%d' % run_id,{'action':'stop'}).code == 200
        repo.update_run(run_id,'running','竞态进度',{})
        assert repo.get_run(run_id)['status'] == 'cancelling'
        repo.recover_interrupted()
        assert repo.get_run(run_id)['status'] == 'interrupted'

    def test_start_returns_job_without_waiting_for_browser(self):
        self.login()
        with patch.object(svc._pool, 'submit') as submit:
            response = self.post_json('/api/collect/qq/runs', {'keywords':'热水'})
            assert response.code == 202
            run = self._json(response)['run']
            assert run['status'] == 'queued'
            assert submit.called
            assert self.post_json('/api/collect/qq/runs', {'keywords':'食堂'}).code == 400
        svc._slot.release()

    def test_ai_assistance_does_not_overwrite_human_review(self):
        self.login()
        run_id = repo.create_run(options(), 'admin')
        repo.save_items(run_id,[dict(id='c_ai',kind='comment',post_id='B_one',content='热水收费贵',
                                    url='https://pd.qq.com/g/CWNUpindao/post/B_one',matched=['热水'])])
        item_id = repo.items(run_id)['list'][0]['id']
        repo.review_item(run_id,item_id,'feedback','收费反馈','admin')
        result = {'category':'verify','reason':'待核实','evidence':'热水收费贵'}
        with patch.object(svc,'analyze_item',new=AsyncMock(return_value=result)):
            response = self.post_json('/api/collect/qq/runs/%d/items/%d/analyze' % (run_id,item_id),{})
        assert response.code == 200
        row = repo.items(run_id)['list'][0]
        assert row['analysis'] == result
        assert row['review_status'] == 'feedback'

    def test_collection_page_has_channel_panel(self):
        self.login()
        response = self.fetch('/collect/qq')
        assert response.code == 200
        assert b'qq-channel.js' in response.body
        assert b'id="qqChannelSection"' in response.body
        assert b'id="qqConnectBtn"' in response.body
        assert b'id="qqMaxComments"' not in response.body
        assert b'id="keywordInput"' not in response.body
        assert b'js/collect.js' not in response.body
        assert b'id="qqReviewDialog"' in response.body
        for url in ('/collect','/collect/web'):
            web=self.fetch(url)
            assert web.code==200
            assert b'id="keywordInput"' in web.body
            assert b'id="qqChannelSection"' not in web.body
            assert b'js/qq-channel.js' not in web.body

    def test_post_cards_paginate_twelve_with_stable_order(self):
        self.login()
        run_id=repo.create_run(options(),'admin')
        repo.save_items(run_id,[dict(id='B_page_'+str(i),kind='post',post_id='B_page_'+str(i),
                                    content='帖子'+str(i),matched=[],heat=30-i,
                                    url='https://pd.qq.com/g/CWNUpindao/post/B_page_'+str(i)) for i in range(25)])
        pages=[self._json(self.get_json('/api/collect/qq/runs/%s?page=%s'%(run_id,p)))['items'] for p in (1,2,3)]
        assert [len(p['list']) for p in pages]==[12,12,1]
        assert all(p['page_size']==12 and p['total']==25 for p in pages)
        assert len({r['id'] for p in pages for r in p['list']})==25
        assert repo.items(run_id,page=99,posts_only=True)['page']==3

    def test_hot_first_recent_second_and_comments_not_in_post_list(self):
        self.login()
        run_id=repo.create_run(options(),'admin')
        rows=svc.search_posts(native_html(),'CWNUpindao',{'CWNUpindao'},'热水')
        repo.save_items(run_id,rows)
        repo.save_items(run_id,[dict(id='c_extra',kind='comment',post_id='B_one',content='热水收费',
                                     url=rows[0]['url'],matched=[])])
        data=self._json(self.get_json('/api/collect/qq/runs/%d' % run_id))
        assert [r['external_id'] for r in data['items']['list']]==['B_three','B_two','B_one']
        item_id=next(r['id'] for r in data['items']['list'] if r['external_id']=='B_one')
        thread=self._json(self.get_json('/api/collect/qq/runs/%d/items/%d/comments' % (run_id,item_id)))
        assert thread['job'] is None
        assert thread['items']['total']==1

    def test_comment_job_is_only_created_after_explicit_review_action(self):
        self.login()
        run_id=repo.create_run(options(),'admin')
        rows=svc.search_posts(native_html(),'CWNUpindao',{'CWNUpindao'},'热水')
        repo.save_items(run_id,rows)
        item_id=repo.items(run_id,posts_only=True)['list'][0]['id']
        path='/api/collect/qq/runs/%d/items/%d/comments' % (run_id,item_id)
        assert self._json(self.get_json(path))['job'] is None
        with patch.object(svc._pool,'submit') as submit:
            try:
                assert self.post_json(path,{}).code==202
                assert submit.call_args.args[0] is svc._comments_worker
                assert repo.comment_job(item_id)['status']=='queued'
                assert self.post_json(path,{}).code==202
                assert submit.call_count==1
            finally:
                svc._slot.release()

    def test_comment_worker_saves_current_thread_including_nonmatching_replies(self):
        self.login()
        run_id=repo.create_run(options(),'admin')
        rows=svc.search_posts(native_html(),'CWNUpindao',{'CWNUpindao'},'热水')
        repo.save_items(run_id,rows)
        item=repo.items(run_id,posts_only=True)['list'][0]
        repo.create_comment_job(run_id,item['id'])
        class Browser(FakeCollector):
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def html(self):
                reply='<div id="r_irrelevant"><div class="comment-richcontent">说得好</div></div>'
                return detail(item['post_id'],extra=reply)
        assert svc._slot.acquire(blocking=False)
        with patch.object(svc,'BrowserCollector',Browser):
            svc._comments_worker(run_id,item['id'])
        assert repo.comment_job(item['id'])['status']=='finished'
        assert repo.items(run_id,post_id=item['post_id'])['total']==3
        assert repo.get_item(run_id,item['id'])['content']=='学生提案'

    def test_post_images_are_persisted_and_returned_with_thread(self):
        self.login()
        run_id = repo.create_run(options(), 'admin')
        rows = svc.search_posts(native_html(), 'CWNUpindao', {'CWNUpindao'}, '热水')
        repo.save_items(run_id, rows)
        item = repo.items(run_id, posts_only=True)['list'][0]
        urls = ['https://example.com/post.jpg']
        repo.update_post(run_id, item['id'], {'content': '', 'metadata': {'images': urls}})
        thread = self._json(self.get_json('/api/collect/qq/runs/%d/items/%d/comments' % (run_id, item['id'])))
        assert thread['post_images'] == urls
        assert thread['post_content'] == ''
        assert thread['post_is_excerpt'] is False
        assert repo.items(run_id, posts_only=True)['list'][0]['metadata']['images'] == urls

    def test_connection_endpoint_does_not_open_browser_on_get(self):
        self.login()
        with patch.object(svc,'connect_channel') as connect:
            assert self.get_json('/api/collect/qq/connection').code==200
            connect.assert_not_called()
            assert self.post_json('/api/collect/qq/connection',{'channel':'CWNUpindao'}).code==202
            connect.assert_called_once_with('CWNUpindao')
