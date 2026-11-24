"""QQ channel jobs share the collection menu's login, role, XSRF and ACL checks."""
import json
import tornado.web

from app.controllers.admin import backend_required
from app.controllers.collect import CollectApiHandler
from app.models import qq_channel as repository
from app.models.source import SourceRepository
from app.services import qq_channel_service as service


class QQChannelSourcesHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    def get(self):
        if self.guard():
            self.write_json({'ok': True, 'list': SourceRepository.qq_channels()})


class QQChannelRunsHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    def get(self):
        if self.guard():
            self.write_json({'ok': True, 'list': repository.runs()})

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.guard():
            return
        try:
            run_id = service.start_run(self.body(), self.current_user)
        except service.ChannelError as exc:
            self.deny(400, str(exc))
            return
        self.write_json({'ok': True, 'run': repository.get_run(run_id)}, status=202)


class QQChannelRunHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    def get(self, run_id):
        if not self.guard():
            return
        run = repository.get_run(int(run_id))
        if run is None:
            self.deny(404, '采集任务不存在')
            return
        status = self.get_argument('review_status', '')
        try:
            page = max(1, int(self.get_argument('page', '1')))
        except ValueError:
            self.deny(400, '页码必须是整数')
            return
        if status not in ('', 'pending', 'feedback', 'concern'):
            self.deny(400, '审核状态不合法')
            return
        self.write_json({'ok': True, 'run': run, 'items': repository.items(
            int(run_id), page, status, posts_only=run['options'].get('mode') in ('native_search','channel_hot'))})

    @tornado.web.authenticated
    @backend_required
    def post(self, run_id):
        if not self.guard():
            return
        if repository.get_run(int(run_id)) is None:
            self.deny(404, '采集任务不存在')
            return
        data = self.body()
        if not isinstance(data, dict) or data.get('action') != 'stop':
            self.deny(400, '仅支持停止任务')
            return
        repository.request_cancel(int(run_id))
        self.write_json({'ok': True})


class QQChannelReviewHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    def post(self, run_id, item_id):
        if not self.guard():
            return
        data = self.body()
        if not isinstance(data, dict):
            self.deny(400, '参数必须是 JSON 对象')
            return
        status, reason = data.get('status'), data.get('reason', '')
        if status not in ('pending', 'feedback', 'concern') or not isinstance(reason, str) or len(reason) > 1000:
            self.deny(400, '审核状态或说明不合法')
            return
        if status == 'concern' and not reason.strip():
            self.deny(400, '标记需要核实须填写具体依据')
            return
        if not repository.review_item(int(run_id), int(item_id), status, reason.strip(), self.current_user):
            self.deny(404, '采集记录不存在')
            return
        self.write_json({'ok': True})


class QQChannelAnalyzeHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    async def post(self, run_id, item_id):
        if not self.guard():
            return
        run_id, item_id = int(run_id), int(item_id)
        item = repository.get_item(run_id, item_id)
        if not item:
            self.deny(404, '采集记录不存在')
            return
        if item['kind'] == 'post' and json.loads(item.get('metadata') or '{}').get('is_excerpt'):
            self.deny(409,'请先进入人工审核，等待当前帖子全文读取完成后再做 AI 初筛')
            return
        result = await service.analyze_item(item)
        repository.save_analysis(run_id, item_id, result)
        self.write_json({'ok': True, 'analysis':result})


class QQChannelConnectionHandler(CollectApiHandler):
    @tornado.web.authenticated
    @backend_required
    def get(self):
        if self.guard():
            self.write_json({'ok':True,'connection':service.connection_status()})

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.guard():
            return
        if self.get_current_role() != 'admin' or self.request.remote_ip not in ('127.0.0.1','::1'):
            self.deny(403,'请由本机管理员连接腾讯账号')
            return
        data = self.body()
        try:
            if not isinstance(data,dict):
                raise service.ChannelError('参数必须是 JSON 对象')
            service.connect_channel(data.get('channel','CWNUpindao'))
        except service.ChannelError as exc:
            self.deny(400,str(exc))
            return
        self.write_json({'ok':True,'connection':service.connection_status()},status=202)


class QQChannelCommentsHandler(CollectApiHandler):
    def checked_item(self,run_id,item_id):
        item = repository.get_item(int(run_id),int(item_id))
        if not item or item['kind'] != 'post':
            self.deny(404,'帖子不存在')
            return None
        return item

    @tornado.web.authenticated
    @backend_required
    def get(self,run_id,item_id):
        if not self.guard():
            return
        item = self.checked_item(run_id,item_id)
        if not item:
            return
        try:
            page = max(1,int(self.get_argument('page','1')))
        except ValueError:
            self.deny(400,'页码必须是整数')
            return
        self.write_json({'ok':True,'job':repository.comment_job(int(item_id)),
                         'post_content':item['content'],
                         'post_images':json.loads(item.get('metadata') or '{}').get('images',[]),
                         'post_is_excerpt':json.loads(item.get('metadata') or '{}').get('is_excerpt',False),
                         'items':repository.items(int(run_id),page,post_id=item['post_id'])})

    @tornado.web.authenticated
    @backend_required
    def post(self,run_id,item_id):
        if not self.guard() or not self.checked_item(run_id,item_id):
            return
        try:
            job = service.start_comments(int(run_id),int(item_id))
        except service.ChannelError as exc:
            self.deny(400,str(exc))
            return
        self.write_json({'ok':True,'job':job},status=202)
