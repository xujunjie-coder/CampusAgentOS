"""Source-management API and QQ selector integration, using only a temporary DB."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest.mock import patch

from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application, create_signed_value

from app.controllers.admin import AdminSourcesApiHandler, AdminSourceItemHandler
from app.controllers.collect import CollectSourcesApiHandler
from app.controllers.qq_channel import QQChannelSourcesHandler
from app.models import source as source_model
from app.models.source import SourceRepository


class TestQQSources(AsyncHTTPTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.database = Path(self.temp.name) / 'sources.db'
        with self.connection() as conn:
            conn.execute('CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, '
                         'url TEXT, headers TEXT, description TEXT, enabled INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
        self.mock_db = patch.object(source_model, 'get_connection', self.connection)
        self.mock_db.start()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.mock_db.stop()
        self.temp.cleanup()

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.database)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def get_app(self):
        return Application([
            (r'/api/admin/sources', AdminSourcesApiHandler),
            (r'/api/admin/sources/(\d+)', AdminSourceItemHandler),
            (r'/api/collect/qq/sources', QQChannelSourcesHandler),
            (r'/api/collect/sources', CollectSourcesApiHandler),
        ], cookie_secret='qq-sources-test-secret', xsrf_cookies=False)

    def request(self, path, body=None, authenticated=True, method=None):
        headers = {}
        if authenticated:
            headers['Cookie'] = '; '.join(name+'='+create_signed_value('qq-sources-test-secret',name,value).decode()
                                         for name,value in [('username','admin'),('role','admin')])
        if body is not None:
            headers['Content-Type'] = 'application/json'
        return self.fetch(path, method=method or ('POST' if body is not None else 'GET'),
                          body=json.dumps(body) if body is not None else None, headers=headers)

    def test_create_edit_disable_and_delete_channel(self):
        payload = dict(name='西华师大第二频道',source_type='qq_channel',channel_id='583an87117',enabled=1)
        assert self.request('/api/admin/sources',payload).code == 200
        source = SourceRepository.get_all()[0]
        assert source['url'] == 'https://pd.qq.com/g/583an87117'
        listed = json.loads(self.request('/api/admin/sources').body)['list'][0]
        assert listed['channel_id'] == '583an87117' and listed['source_type'] == 'qq_channel'
        channels = json.loads(self.request('/api/collect/qq/sources').body)['list']
        assert channels == [dict(id=source['id'],name=payload['name'],channel='583an87117')]
        assert 'headers' not in channels[0]
        assert json.loads(self.request('/api/collect/sources').body)['list'] == []
        assert self.request('/api/admin/sources/'+str(source['id']),dict(payload,enabled=0)).code == 200
        assert json.loads(self.request('/api/collect/qq/sources').body)['list'] == []
        assert self.request('/api/admin/sources/'+str(source['id']),method='DELETE').code == 200
        assert SourceRepository.get_all() == []

    def test_invalid_channel_and_unauthenticated_access(self):
        assert self.request('/api/collect/qq/sources',authenticated=False).code == 401
        assert self.request('/api/admin/sources',dict(name='bad',source_type='qq_channel',channel_id='x/../y')).code == 400
        assert SourceRepository.get_all() == []


def test_qq_source_recognition_is_strict_and_enabled_channels_are_deduplicated():
    assert SourceRepository.channel_id('https://pd.qq.com/g/583an87117') == '583an87117'
    for url in ['https://pd.qq.com.evil/g/CWNUpindao','https://pd.qq.com/g/a/post/B_one','http://pd.qq.com/g/abc']:
        assert not SourceRepository.channel_id(url)
    sources = [dict(id=1,name='one',url='https://pd.qq.com/g/abc',enabled=1),
               dict(id=2,name='duplicate',url='https://pd.qq.com/g/abc/',enabled=1),
               dict(id=3,name='disabled',url='https://pd.qq.com/g/xyz',enabled=0)]
    with patch.object(SourceRepository,'get_all',return_value=sources):
        assert SourceRepository.qq_channels() == [dict(id=1,name='one',channel='abc')]
