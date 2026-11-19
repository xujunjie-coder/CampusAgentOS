"""
数据仓库控制器 —— 任务7：/admin/warehouse（layui 后台页，规范与用户/信源管理等模块一致）

分层规则不变：
- 表现层：templates/admin/warehouse.html「功能区 | 列表区 | 分页区（20/页）」+ 深采执行面板，
          交互在 static/js/admin.js 的 WarehouseModule，走本模块 JSON API 与 SSE 接口
- 控制层：页面 Handler 沿用 AdminBaseHandler 渲染壳；API 做 增删改查分页；
          深采接口把阻塞编排放入线程池，进度事件经 asyncio.Queue 转 SSE 实时推给执行面板
- 服务层：services/warehouse_service 负责 Crawl4AI/回退抓取 + AI 模型引擎分析 + 落库编排
- 模型层：CollectRepository 读原数据、WarehouseRepository 读写数仓，控制器不写 SQL

权限：登录 + 后台角色 + require_menu('/admin/warehouse')，
「数据采集 / 数据仓库」菜单由 db.py 幂等种子。

SSE 说明：EventSource 只能发 GET，深采参数经 query string 传递（p 参数为 URL 编码的 JSON）；
单个深采 /api/warehouse/deep/one，批量深采 /api/warehouse/deep/batch
（ids 显式指定，或 all_pending=1 按过滤条件拉未深采原数据批量执行）。
"""

import asyncio
import json
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import tornado.ioloop
import tornado.web

from app.controllers.admin import AdminBaseHandler, AdminApiHandler, backend_required
from app.controllers.sse import SSEBridge
from app.models.collect import CollectRepository
from app.models.source import SourceRepository
from app.models.warehouse import WarehouseRepository, PAGE_SIZE
from app.services import collect_service, warehouse_service

URL_WAREHOUSE = "/admin/warehouse"

# 深采专用线程池：Crawl4AI/requests 抓取与大模型推理都是阻塞调用，与 IOLoop 隔离
_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="warehouse")
# SSE 心跳间隔（秒）：长抓取期间保持面板连接不断
HEARTBEAT_SECONDS = 10


class WarehousePageHandler(AdminBaseHandler):
    """数据仓库页（任务7）：框架壳，列表/深采面板由 admin.js 渲染"""

    template_name = "admin/warehouse.html"
    page_name = "数据仓库"
    nav_url = URL_WAREHOUSE


class WarehouseApiHandler(AdminApiHandler):
    """数仓数据接口基类：统一按「数据仓库」菜单鉴权"""

    def guard(self) -> bool:
        return self.require_menu(URL_WAREHOUSE)


class WarehouseListApiHandler(WarehouseApiHandler):
    """GET /api/admin/warehouse：数仓列表，20/页，标题/关键词/摘要搜索 + 信源/状态过滤"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.guard():
            return
        page, keyword = self._page_args(self)
        source_id = self.get_argument("source_id", "") or None
        status = (self.get_argument("status", "") or "").strip() or None
        data = WarehouseRepository.paginate(keyword=keyword or None, source_id=source_id,
                                            status=status, page=page, limit=PAGE_SIZE)
        self.ok(**data, page=page, page_size=PAGE_SIZE,
                **WarehouseRepository.count_by_status())


class WarehouseItemApiHandler(WarehouseApiHandler):
    """POST /api/admin/warehouse/<id>：更新元信息（标题/AI摘要/关键词）；DELETE 删除数仓记录"""

    @tornado.web.authenticated
    @backend_required
    def post(self, data_id):
        if not self.guard():
            return
        b = self.body()
        if not WarehouseRepository.get_by_id(int(data_id)):
            self.fail("数仓记录不存在", status=404)
            return
        title = b.get("title")
        WarehouseRepository.update_meta(
            int(data_id),
            title=(title or "").strip() or None,
            ai_summary=b.get("ai_summary") if b.get("ai_summary") is not None else None,
            keyword=(b.get("keyword") or "").strip() or None,
        )
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, data_id):
        if not self.guard():
            return
        if not WarehouseRepository.delete(int(data_id)):
            self.fail("数仓记录不存在", status=404)
            return
        self.ok()


class WarehouseDetailApiHandler(WarehouseApiHandler):
    """GET /api/admin/warehouse/<id>：查看完整记录（含详细正文/图片/关键词，供查看弹层）"""

    @tornado.web.authenticated
    @backend_required
    def get(self, data_id):
        if not self.guard():
            return
        row = WarehouseRepository.get_by_id(int(data_id))
        if not row:
            self.fail("数仓记录不存在", status=404)
            return
        try:
            row["ai_keywords"] = json.loads(row.get("ai_keywords") or "[]")
            row["images"] = json.loads(row.get("images") or "[]")
        except json.JSONDecodeError:
            row["ai_keywords"], row["images"] = [], []
        self.ok(data=row)


class WarehouseBatchApiHandler(WarehouseApiHandler):
    """POST /api/admin/warehouse/batch 批量删除，body: {ids:[...]}（与用户管理批量规范一致）"""

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.guard():
            return
        ids = self.body().get("ids") or []
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            self.fail("ids 必须为数字数组")
            return
        if not ids:
            self.fail("没有可删除的项")
            return
        self.ok(deleted=WarehouseRepository.delete_many(ids))


class WarehouseSourcesApiHandler(WarehouseApiHandler):
    """GET /api/admin/warehouse/sources：信源选项（数仓过滤/批量深采按信源），
    复用采集管理选源接口元数据结构，不回传 headers（含 cookie 等敏感规则）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.guard():
            return
        out = []
        for s in SourceRepository.get_all():
            out.append({
                "id": s["id"],
                "name": s["name"],
                "enabled": bool(s["enabled"]),
                "placeholders": collect_service.parse_placeholders(s["url"]),
            })
        self.ok(list=out, collected=CollectRepository.list_sources())


class WarehouseItemsApiHandler(WarehouseApiHandler):
    """GET /api/warehouse/items：原数据（collect_items）列表，供深采选择弹窗；
    only_undone=1 时排除已成功深采的条目，分页与搜索同数仓列表"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.guard():
            return
        page, keyword = self._page_args(self)
        source_id = self.get_argument("source_id", "") or None
        data = CollectRepository.paginate(keyword=keyword or None, source_id=source_id,
                                          page=page, limit=PAGE_SIZE)
        rows = data["list"]
        if self.get_argument("only_undone", "") == "1":
            rows = [r for r in rows if not _deep_done(r["id"])]
        self.ok(total=data["total"], list=rows, page=page, page_size=PAGE_SIZE)


def _deep_done(collect_item_id: int) -> bool:
    row = WarehouseRepository.get_by_collect_item(collect_item_id)
    return bool(row and row["status"] == 2)


# ==================== 深度采集（SSE 执行面板） ====================

class DeepCollectBaseHandler(WarehouseApiHandler):
    """深采 SSE 基类：线程池 job 经 asyncio.Queue 逐事件转 SSE 推送，含心跳与终止事件"""

    def parse_params(self) -> dict:
        """EventSource 只能 GET，深采参数经 ?p=<URL 编码 JSON> 传递"""
        try:
            return json.loads(urllib.parse.unquote(self.get_argument("p", "{}")) or "{}")
        except (json.JSONDecodeError, ValueError):
            return {}

    async def stream(self, job):
        """job(emit) 在线程池执行；事件经 SSEBridge 转 SSE（心跳/超时/断连统一处理）

        任务16：原先手写的「asyncio.Queue + wait_for(HEARTBEAT) + finish」逻辑已抽取到
        app/controllers/sse.py 的 SSEBridge，三处 SSE 端点共用同一套实现。
        """
        self.start_sse()
        bridge = SSEBridge(self, heartbeat_seconds=HEARTBEAT_SECONDS)
        bridge.submit(job, _EXECUTOR)
        try:
            await bridge.stream()
        except Exception:
            pass  # 客户端断开/超时等：静默收尾，job 会在线程池跑完并落库
        finally:
            self.finish_sse()


class DeepCollectOneApiHandler(DeepCollectBaseHandler):
    """GET /api/warehouse/deep/one?p={item_id}：单一深采，SSE 实时推送进度/分析过程/结果"""

    @tornado.web.authenticated
    @backend_required
    async def get(self):
        if not self.guard():
            return
        params = self.parse_params()
        try:
            item_id = int(params.get("item_id"))
        except (TypeError, ValueError):
            self.fail("item_id 不能为空")
            return
        item = CollectRepository.get_by_id(item_id)
        if not item:
            self.fail("原数据不存在", status=404)
            return
        username = self.current_user
        headers = _source_headers_for(item["source_id"])
        ai = bool(params.get("use_ai", True))
        c4a = bool(params.get("use_crawl4ai", True))

        def job(emit):
            return warehouse_service.deep_collect_one(
                item, username, ai, c4a, headers,
                progress=lambda **ev: emit(type="progress", **ev))

        await self.stream(job)


class DeepCollectBatchApiHandler(DeepCollectBaseHandler):
    """GET /api/warehouse/deep/batch?p={ids:[...]} 或 {all_pending:1, keyword/source_id/status}：
    批量深采（显式多选 或 按过滤条件全量未深采），SSE 推送逐条进度与总结果"""

    @tornado.web.authenticated
    @backend_required
    async def get(self):
        if not self.guard():
            return
        params = self.parse_params()
        ids = params.get("ids") or []
        all_pending = bool(params.get("all_pending"))
        items = []
        if all_pending:
            limit = warehouse_service.MAX_BATCH_ITEMS
            page = 1
            while len(items) < limit:
                data = CollectRepository.paginate(
                    keyword=(params.get("keyword") or None),
                    source_id=(params.get("source_id") or None),
                    page=page, limit=PAGE_SIZE)
                rows = data["list"]
                items.extend(r for r in rows if not _deep_done(r["id"]))
                if len(rows) < PAGE_SIZE:
                    break
                page += 1
            items = items[:limit]
        else:
            try:
                ids = [int(i) for i in ids]
            except (TypeError, ValueError):
                self.fail("ids 必须为数字数组")
                return
            if not ids:
                self.fail("请至少选择一条原数据")
                return
            if len(ids) > warehouse_service.MAX_BATCH_ITEMS:
                self.fail("单次批量深采最多 %d 条" % warehouse_service.MAX_BATCH_ITEMS)
                return
            items = [i for i in (CollectRepository.get_by_id(x) for x in ids) if i]
        if not items:
            self.fail("没有符合条件的未深采原数据")
            return
        username = self.current_user
        ai = bool(params.get("use_ai", True))
        c4a = bool(params.get("use_crawl4ai", True))

        def job(emit):
            progress = lambda **ev: emit(type="progress", **ev)  # noqa: E731
            # 批量涉及多信源时逐条取各自信源 headers
            headers_map = {}
            for it in items:
                sid = it["source_id"]
                if sid not in headers_map:
                    headers_map[sid] = _source_headers_for(sid)
            total = len(items)
            warehouse_service._emit(progress, "batch_start", 0,
                                    "批量深采开始：共 %d 条" % total, {"total": total})
            results = []
            for idx, it in enumerate(items):
                try:
                    r = warehouse_service.deep_collect_one(
                        it, username, ai, c4a, headers_map.get(it["source_id"]),
                        progress=progress,
                        base_percent=int(idx * 100 / total), span_percent=int(100 / total))
                except Exception as e:
                    r = {"ok": False, "collect_item_id": it.get("id"),
                         "title": it.get("title"), "error": str(e)}
                results.append(r)
            done = sum(1 for r in results if r.get("ok"))
            warehouse_service._emit(progress, "batch_done", 100,
                                     "批量深采结束：成功 %d / 失败 %d" % (done, total - done),
                                     {"total": total, "success": done, "failed": total - done})
            return results

        await self.stream(job)


def _source_headers_for(source_id: int) -> dict:
    """取信源 Request Headers 规则（详情页同域抓取沿用），异常/缺失返回空"""
    try:
        source = SourceRepository.get_by_id(int(source_id))
        return json.loads(source.get("headers") or "{}") if source else {}
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
