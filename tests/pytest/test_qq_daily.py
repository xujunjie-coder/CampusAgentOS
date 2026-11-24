"""Hot snapshots, scoped analysis, verified topics and noon delivery scheduling."""
import asyncio
import json
from unittest.mock import AsyncMock,patch

import pytest

from conftest import ApiCase
from app.models import qq_channel as repo
from app.models.task import ScheduledTaskRepository as Tasks
from app.models.db import get_connection
from app.services import qq_daily_service as daily
from app.services import scheduler_service as scheduler


def html(post='B_daily',heat=3,text='热水供应讨论',active='热门'):
    return '<div class="tab-bar__item is-active">'+active+'</div>'+f'''
    <a class="game-guild-main__short-content" href="https://pd.qq.com/g/DailyTest/post/{post}">
    <div class="feed-detail-text">{text}</div><span class="edit-time">11-24</span>
    <div class="game-guild-main__short-content__like"><span class="game-guild-main__short-content__text">{heat}</span></div></a>'''


def test_hot_scope_and_parameters():
    with pytest.raises(ValueError):daily.hot_posts(html(active='最新'),'DailyTest',{'DailyTest'})
    assert daily.hot_posts(html(),'other',{'other'})==[]
    row=daily.hot_posts(html(),'DailyTest',{'DailyTest'})[0]
    assert row['heat']==3 and row['author']=='' and row['metadata']['is_excerpt']
    assert daily.hot_posts('<div class="tab-bar__item is-active">全部</div>'+html(),'DailyTest',{'DailyTest'})
    for params in ({'channel':'../bad'},{'max_posts':101},{'sample_posts':True},{'sample_posts':1}):
        with pytest.raises(ValueError):daily.validate_params(params)


def test_noon_uses_shanghai_timezone_independent_of_host():
    from apscheduler.triggers.cron import CronTrigger
    from datetime import datetime,timezone
    trigger=CronTrigger.from_crontab('0 12 * * *',timezone=scheduler.SCHEDULE_TIMEZONE)
    stamp=trigger.get_next_fire_time(None,datetime(2026,11,24,0,0,tzinfo=timezone.utc))
    assert stamp.isoformat()=='2026-11-24T12:00:00+08:00'


def test_keyword_fallback_does_not_repeat_personal_details():
    topics=daily.keyword_topics([dict(id='B_health',content='献血后咨询细节',heat=10),
                                 dict(id='B_food',content='食堂价格讨论',heat=3)])
    assert topics[0]['title']=='健康咨询与校园医疗'
    assert topics[0]['post_ids']==['B_health']
    assert '献血后咨询细节' not in topics[0]['summary']


def test_report_labels_fallback_and_keeps_personal_details_out_of_mail(tmp_path):
    posts=[dict(id='B_one',content='献血后个人情况细节',heat=5,url='https://pd.qq.com/g/DailyTest/post/B_one')]
    coverage={'discovered_posts':1}
    with patch.object(daily,'collect_snapshot',return_value=(99,posts,coverage)), \
         patch.object(daily,'analyze_snapshot',new=AsyncMock(return_value=[dict(post_id='B_one',level='watch')])), \
         patch.object(daily,'summarize_topics',new=AsyncMock(side_effect=ValueError('unavailable'))), \
         patch.object(daily.config,'PROJECT_ROOT',str(tmp_path)):
        outcome=daily.run_daily({})
    assert outcome['status']=='success'
    assert '按关键词分组' in outcome['notify_body'] and '并非模型生成' in outcome['notify_body']
    assert '待人工核实的线索' in outcome['notify_body'] and posts[0]['url'] in outcome['notify_body']
    assert posts[0]['content'] not in outcome['notify_body']


@patch('app.services.model_service.chat_engine',return_value={})
def test_topic_requires_existing_post_and_verbatim_evidence(_engine):
    posts=[dict(id='B_daily',content='热水供应讨论',heat=1)]
    async def verify():
        from app.services import model_service
        with patch.object(model_service,'complete_json',new=AsyncMock(return_value={'topics':[
                dict(title='热水供应',summary='讨论供应体验',post_ids=['B_fake'],evidence='热水供应讨论')]})):
            with pytest.raises(ValueError):await daily.summarize_topics(posts)
        with patch.object(model_service,'complete_json',new=AsyncMock(return_value={'topics':[
                dict(title='热水供应',summary='讨论供应体验',post_ids=['B_daily'],evidence='热水供应')]})):
            assert len(await daily.summarize_topics(posts))==1
    asyncio.run(verify())


class TestDailyPipeline(ApiCase):
    def test_snapshot_sorts_hot_samples_without_opening_posts_or_comments(self):
        class Browser:
            def __init__(self,**kwargs):self.index=0
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def hot(self,channel):assert channel=='DailyTest'
            def html(self):return html('B_low',1) if self.index==0 else html('B_high',9)
            def scroll(self):self.index+=1;return {'before':0,'after':100}
        options=daily.validate_params(dict(channel='DailyTest',max_posts=1,sample_posts=2,max_scrolls=3))
        with patch.object(daily.qq,'BrowserCollector',Browser):
            run,posts,progress=daily.collect_snapshot(options)
        assert [p['id'] for p in posts]==['B_high']
        assert progress['scanned_comments']==0
        rows=daily.run_reviews(run)
        assert len(rows)==1 and '热门列表摘要' in rows[0]['summary']
        assert repo.comment_job(repo.items(run,posts_only=True)['list'][0]['id']) is None
        with get_connection() as c:
            c.execute('DELETE FROM collect_items WHERE id=?',(rows[0]['id'],))
            c.execute('DELETE FROM qq_channel_sentiment_links WHERE channel=?',('DailyTest',))
            c.execute('DELETE FROM sources WHERE name=?',('QQ频道 · DailyTest',))
            c.execute('DELETE FROM qq_channel_items WHERE run_id=?',(run,))
            c.execute('DELETE FROM qq_channel_runs WHERE id=?',(run,))

    def test_failed_mail_is_task_failure_and_report_body_is_delivered(self):
        fields=Tasks.normalize('qq_channel_daily','cron',0,'0 12 * * *','always','qq',{})
        task=Tasks.create('Daily mail failure','qq_channel_daily','',fields,enabled=0)
        outcome=dict(status='success',result='已分析',detail='{}',notify_subject='日报',notify_body='归纳话题正文')
        with patch.dict(scheduler._HANDLERS,{'qq_channel_daily':lambda params:dict(outcome)}):
            from app.services import notify_service
            with patch.object(notify_service,'notify',return_value={'ok':False,'skipped':False,'degraded':False}) as send:
                result=scheduler.execute_task(task,'manual')
        assert not result['ok'] and '投递失败' in result['result']
        send.assert_called_once_with('qq','日报','归纳话题正文')
        assert Tasks.get_by_id(task)['last_status']=='failed'

    def test_daily_api_rejects_invalid_channel(self):
        self.login()
        result=self.post_json('/api/admin/tasks',dict(name='bad daily',task_type='qq_channel_daily',
                  params={'channel':'../bad'},schedule_type='cron',cron_expr='0 12 * * *'))
        assert result.code==400
