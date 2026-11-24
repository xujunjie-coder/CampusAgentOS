"""
采集管理控制器 —— 任务6：采集管理页（/collect，复用后台框架）

分层规则不变：
- 表现层：templates/collect.html 后台内容页（关键词输入区 | 信源采集选择区 | 采集数据橱窗列表区），
          交互全部在 static/js/collect.js，走本模块 JSON API
- 控制层：页面 Handler 渲染壳；API Handler 校验参数后把阻塞采集编排放入线程池（run_in_executor），
          避免 requests / 智能体推理阻塞 Tornado IOLoop
- 服务层：services/collect_service 负责 参数替换/抓取/双引擎解析/落库 编排
- 模型层：SourceRepository 选源、CollectRepository 读写采集数据，控制器不写 SQL

权限：沿用后台菜单鉴权体系（登录 + 后台角色 + require_menu('/collect')），
「数据采集 / 采集管理」菜单由 db.py 幂等种子，侧边导航显示采集管理并高亮当前入口。
"""

import asyncio
import json
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import tornado.ioloop
import tornado.web

from app.controllers.admin import AdminGuard, AdminBaseHandler, backend_required
from app.models.collect import CollectRepository, PAGE_SIZE
from app.models.source import SourceRepository
from app.services import collect_service
from app.services.intelligence_service import review_pending

URL_COLLECT = "/collect"
# 单次批量采集的信源数上限，防止一次请求占用线程池过久
MAX_SOURCES_PER_RUN = 10

# 采集专用线程池：抓取与大模型解析都是阻塞调用，与 IOLoop 隔离
_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="collect")


class CollectPageHandler(AdminBaseHandler):
    """采集管理复用后台框架、导航与菜单权限。"""

    template_name = "collect.html"
    page_name = "采集管理"
    nav_url = URL_COLLECT

    def get_context(self):
        return {'collect_mode':'web'}


class CollectQQPageHandler(CollectPageHandler):
    template_name = 'collect_qq.html'
    page_name = '采集管理'

    def get_context(self):
        return {'collect_mode':'qq'}


class CollectApiHandler(AdminGuard):
    """采集数据接口基类：api=True（错误走 JSON），统一菜单鉴权"""

    api = True

    def guard(self) -> bool:
        code = self.get_current_role()
        if not code or not self.require_menu(URL_COLLECT):
            return False
        return True

    def body(self) -> dict:
        try:
            return json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}


class CollectSourcesApiHandler(CollectApiHandler):
    """GET /api/collect/sources：启用信源 + 占位符元数据（驱动信源选择区与可视化参数配置）。
    只暴露 id/名称/简介/域名/占位符，不回传 headers（含 cookie 等敏感规则）。"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.guard():
            return
        out = []
        for s in SourceRepository.get_all():
            if not s["enabled"] or SourceRepository.channel_id(s['url']):
                continue
            out.append({
                "id": s["id"],
                "name": s["name"],
                "description": s["description"],
                "host": urllib.parse.urlparse(s["url"]).netloc,
                "placeholders": collect_service.parse_placeholders(s["url"]),
            })
        self.write_json({"ok": True, "list": out})


class CollectRunApiHandler(CollectApiHandler):
    """POST /api/collect/run：批量采集。
    body: {keyword, source_ids:[...], params:{信源id:{占位符:值}}, page_index, use_llm}
    在线程池并行采集信源，按选择顺序返回结果（单源失败不影响其余信源）。"""

    @tornado.web.authenticated
    @backend_required
    async def post(self):
        if not self.guard():
            return
        data = self.body()
        keyword = (data.get("keyword") or "").strip()
        if not keyword or len(keyword) > 64:
            self.deny(400, "关键词不能为空且不超过 64 字")
            return
        source_ids = data.get("source_ids") or []
        if not isinstance(source_ids, list) or not source_ids:
            self.deny(400, "请至少选择一个信源")
            return
        if len(source_ids) > MAX_SOURCES_PER_RUN:
            self.deny(400, "单次最多采集 %d 个信源" % MAX_SOURCES_PER_RUN)
            return
        sources = []
        for sid in source_ids:
            try:
                source = SourceRepository.get_by_id(int(sid))
            except (TypeError, ValueError):
                source = None
            if not source or not source["enabled"]:
                self.deny(400, "信源不存在或已停用：%s" % sid)
                return
            if SourceRepository.channel_id(source['url']):
                self.deny(400, 'QQ 频道请使用采集管理中的 QQ 频道入口')
                return
            sources.append(source)
        params = data.get("params") or {}
        try:
            page_index = max(1, int(data.get("page_index") or 1))
        except (TypeError, ValueError):
            page_index = 1
        use_llm = bool(data.get("use_llm", True))
        username = self.current_user

        def job(source):
            try:
                sp = params.get(str(source["id"])) or params.get(source["id"]) or {}
                return collect_service.collect(source, keyword, sp, page_index, username, use_llm)
            except Exception as e:  # 兜底：单源异常不中断批量采集
                return {"ok": False, "source_id": source["id"],
                        "source_name": source["name"], "error": str(e)}

        loop = tornado.ioloop.IOLoop.current()
        results = await asyncio.gather(
            *(loop.run_in_executor(_EXECUTOR, job, source) for source in sources))
        for result in results:
            if result["ok"] and result["fetched"]:
                loop.spawn_callback(review_pending, result["source_id"])
        self.write_json({"ok": True, "results": results,
                         "new_total": sum(r.get("new", 0) for r in results)})


class CollectItemsApiHandler(CollectApiHandler):
    """GET /api/collect/items：采集数据橱窗列表，12 条/页，支持关键词与信源过滤"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.guard():
            return
        keyword = self.get_argument("keyword", "").strip() or None
        source_id = self.get_argument("source_id", "") or None
        page = self.get_argument("page", "1")
        try:
            page = int(page)
        except ValueError:
            page = 1
        data = CollectRepository.paginate(keyword=keyword, source_id=source_id,
                                          page=page, limit=PAGE_SIZE, exclude_channels=True)
        self.write_json({"ok": True, "total": data["total"], "page": max(1, page),
                         "page_size": PAGE_SIZE, "list": data["list"]})
