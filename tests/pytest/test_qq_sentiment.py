"""Channel posts enter existing risk pipeline once, with excerpt provenance."""
import json
from unittest.mock import AsyncMock,patch

from conftest import ApiCase
from app.models import qq_channel as qq
from app.models import intelligence
from app.models.db import get_connection
from app.services import intelligence_service as svc


class TestChannelSentiment(ApiCase):
    def setUp(self):
        super().setUp()
        self.created_runs=[]
        self.extra_items=[]

    def tearDown(self):
        # The shared temporary DB also hosts tests asserting an empty collection.
        with get_connection() as c:
            for run in self.created_runs:
                channel=qq.get_run(run)['channel']
                links=c.execute('SELECT collect_item_id FROM qq_channel_sentiment_links WHERE channel=?',(channel,)).fetchall()
                for link in links:
                    c.execute('DELETE FROM risk_reviews WHERE item_id=?',(link['collect_item_id'],))
                    c.execute('DELETE FROM collect_items WHERE id=?',(link['collect_item_id'],))
                c.execute('DELETE FROM qq_channel_sentiment_links WHERE channel=?',(channel,))
                c.execute('DELETE FROM qq_channel_items WHERE run_id=?',(run,))
                c.execute('DELETE FROM sources WHERE name=?',('QQ频道 · '+channel,))
            for item in self.extra_items:
                c.execute('DELETE FROM collect_items WHERE id=?',(item,))
        super().tearDown()

    def make_run(self,channel='TestRiskChannel',post='B_risk',text='校园跑平台光线不足导致验证失败',excerpt=True):
        run=qq.create_run({'mode':'native_search','channel':channel,'keywords':['校园跑']},'admin')
        self.created_runs.append(run)
        qq.save_items(run,[dict(id=post,post_id=post,kind='post',content=text,matched=['校园跑'],
                                url='https://pd.qq.com/g/'+channel+'/post/'+post,
                                metadata={'is_excerpt':excerpt})])
        qq.save_items(run,[dict(id='c_'+str(run),post_id=post,kind='comment',content='评论不应自动接入',
                                matched=[],url='https://pd.qq.com/g/'+channel+'/post/'+post)])
        qq.update_run(run,'finished','完成',{})
        return run

    def linked(self,channel):
        with get_connection() as c:
            return dict(c.execute('SELECT c.*,q.is_excerpt FROM collect_items c '
                                  'JOIN qq_channel_sentiment_links q ON q.collect_item_id=c.id '
                                  'WHERE q.channel=?',(channel,)).fetchone())

    def test_dedup_posts_only_and_full_text_never_downgraded(self):
        channel='RiskDedup'
        run=self.make_run(channel)
        assert qq.sync_sentiment_posts(run)==1
        row=self.linked(channel)
        assert '搜索摘要' in row['summary']
        assert '评论不应自动接入' not in row['summary']
        intelligence.save_review(row['id'],'normal','普通投诉','')
        assert qq.sync_sentiment_posts(run)==0
        full=self.make_run(channel,text='校园跑平台光线不足导致验证失败，建议修复',excerpt=False)
        assert qq.sync_sentiment_posts(full)==0
        assert self.linked(channel)['is_excerpt']==0
        with get_connection() as c:
            assert c.execute('SELECT level FROM risk_reviews WHERE item_id=?',(row['id'],)).fetchone()['level']=='error'
        intelligence.save_review(row['id'],'normal','普通反馈','')
        later=self.make_run(channel,text='截断的摘要')
        qq.sync_sentiment_posts(later)
        qq.sync_sentiment_posts()
        assert '建议修复' in self.linked(channel)['summary']
        with get_connection() as c:
            assert c.execute('SELECT level FROM risk_reviews WHERE item_id=?',(row['id'],)).fetchone()['level']=='normal'
            assert c.execute('SELECT COUNT(*) AS n FROM qq_channel_sentiment_links WHERE channel=?',(channel,)).fetchone()['n']==1

    def test_channel_action_only_classifies_imported_posts_and_checks_evidence(self):
        self.login()
        run=self.make_run('RiskAnalyze')
        qq.sync_sentiment_posts(run)
        with get_connection() as c:
            other=c.execute("INSERT INTO collect_items(source_id,title,summary) VALUES (9999,'无关新闻','无关正文')").lastrowid
            self.extra_items.append(other)
        calls=[]
        async def answer(model,instruction,content):
            items=json.loads(content);calls.extend(items)
            assert '普通投诉' in instruction and '搜索摘要' in instruction
            return {str(i['id']):{'level':'normal','reason':'普通反馈，不据此认定安全风险','evidence':''} for i in items}
        with patch.object(svc,'complete_json',side_effect=answer):
            res=self.fetch('/admin/sentiment',method='POST',body=json.dumps({'action':'qq'}),
                           headers={'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'})
        assert res.code==200 and self._json(res)['result']['failed']==0
        assert calls and all(i['id']!=other for i in calls)
        web_items=self._json(self.get_json('/api/collect/items'))['list']
        assert any(i['id']==other for i in web_items)
        assert not any(i['source_name'].startswith('QQ频道 · ') for i in web_items)
        assert any('光线不足' in i['summary'] for i in calls)
        assert qq.comment_job(qq.items(run,posts_only=True)['list'][0]['id']) is None
        page=self.fetch('/admin/sentiment')
        assert page.code==200 and '分析频道帖子'.encode() in page.body

    def test_invalid_evidence_is_retryable_not_normal(self):
        run=self.make_run('RiskEvidence')
        qq.sync_sentiment_posts(run)
        item=self.linked('RiskEvidence')
        async def run_check():
            with patch.object(svc,'complete_json',new=AsyncMock(return_value={str(item['id']):
                     {'level':'high','reason':'编造事故','evidence':'原文不存在的伤亡'}})):
                return await svc.classify_reviews([item])
        assert self.io_loop.run_sync(run_check)==1
        with get_connection() as c:
            assert c.execute('SELECT level FROM risk_reviews WHERE item_id=?',(item['id'],)).fetchone()['level']=='error'
