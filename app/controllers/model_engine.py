"""
模型引擎管理控制器 —— 任务8：大模型及服务管理（OpenAI 接口范式接入）

分层规则与后台其他模块一致：
- 表现层：templates/admin/models.html 出橱窗框架壳（一行 2 列，4 条/页），
          卡片/弹层/对话测试由 static/js/models.js 走本模块 JSON/SSE API
- 控制层：页面与接口沿用 admin.py 的 AdminBaseHandler/AdminApiHandler 鉴权设施
          （登录 + 后台角色 + 按菜单 /admin/models 校验）
- 服务层：对话/嵌入/图片测试走 services/model_service.py（AsyncHTTPClient 真异步）
- 模型层：数据一律走 ModelEngineRepository，控制器不写 SQL

接口约定：
- 列表/详情不下发完整 api_key，只给脱敏串（前4后4），编辑留空表示保持不变
- 模型配置任何变更都会 reset_agents()，让前台智能体下次对话按最新默认模型重建
- 对话测试为 SSE 流（与 /api/chat 事件约定一致）：delta 纯文本串，
  reasoning/usage/result/image/error 为对象，done 收尾
- 任务8.1：GET /api/admin/models/stats 输出 token 统计（汇总/按天趋势/模型排行/明细），
  橱窗列表随行下发 token_total/call_count 与全页最大值 token_max（卡片直观反馈 + 迷你条比例）
"""

import tornado.web

from app.controllers.admin import AdminBaseHandler, AdminApiHandler, backend_required
from app.models.model_engine import ModelEngineRepository, MODEL_TYPES
from app.models.token_stats import TokenStatsRepository
from app.services import model_service
from app.services.agent_service import reset_agents

URL_MODELS = "/admin/models"
# 橱窗列表规格：一行 2 列，4 条/页（任务8要求，区别于其他模块 20/页）
MODEL_PAGE_SIZE = 4
# 允许参与对话测试的类型（图片/嵌入走各自的测试端点）
_CHAT_TYPES = ("text", "multimodal", "vl")


def _mask_key(key: str) -> str:
    """api_key 脱敏：保留前4后4，中间打码；短 key 全打码"""
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return key[:4] + "****" + key[-4:]


def _public_row(row: dict) -> dict:
    """列表/详情下发前脱敏 api_key，并附类型展示名"""
    out = dict(row)
    out["api_key"] = _mask_key(row.get("api_key") or "")
    out["type_label"] = MODEL_TYPES.get(row.get("type"), row.get("type"))
    return out


# ==================== 页面 ====================

class AdminModelsHandler(AdminBaseHandler):
    """模型引擎页（任务8）：橱窗框架壳，卡片由 models.js 走 /api/admin/models"""

    template_name = "admin/models.html"
    page_name = "模型引擎"
    nav_url = URL_MODELS

    def get_context(self) -> dict:
        return {
            "model_types": [{"code": c, "label": l} for c, l in MODEL_TYPES.items()],
            "model_page_size": MODEL_PAGE_SIZE,
        }


# ==================== 数据接口（JSON API） ====================

class AdminModelsApiHandler(AdminApiHandler):
    """GET /api/admin/models 橱窗分页（4/页）+搜索+类型过滤；POST 新增模型"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_MODELS):
            return
        page, keyword = self._page_args(self)
        mtype = (self.get_argument("type", "") or "").strip()
        if mtype and mtype not in MODEL_TYPES:
            self.fail("未知的模型类型")
            return
        data = ModelEngineRepository.paginate(keyword=keyword or None, mtype=mtype or None,
                                              page=page, limit=MODEL_PAGE_SIZE)
        data["list"] = [_public_row(r) for r in data["list"]]
        # 任务8.1：卡片 token 直观反馈——分页行已带 token_total/call_count，
        # 另附全库最大值 token_max 作迷你条百分比宽度基准（当前页最大值至少 1，防除零）
        token_max = max([s["token_total"] for s in TokenStatsRepository.stats_by_engine().values()]
                        + [r.get("token_total", 0) for r in data["list"]] + [1])
        self.ok(**data, token_max=token_max, summary=TokenStatsRepository.summary())

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_MODELS):
            return
        b = self.body()
        name = (b.get("name") or "").strip()
        api_url = (b.get("api_url") or "").strip()
        model_id = (b.get("model_id") or "").strip()
        mtype = (b.get("type") or "text").strip()
        if not name or len(name) > 64:
            self.fail("模型名称需为1-64个字符")
            return
        if not api_url.startswith(("http://", "https://")):
            self.fail("API 地址须以 http:// 或 https:// 开头")
            return
        if not model_id:
            self.fail("模型标识（model_id）不能为空")
            return
        if mtype not in MODEL_TYPES:
            self.fail("未知的模型类型")
            return
        new_id = ModelEngineRepository.create(
            name, api_url, (b.get("api_key") or "").strip(), model_id, mtype,
            thinking=1 if b.get("thinking") in (1, "1", True, "true") else 0,
            enabled=1 if b.get("enabled", 1) in (1, "1", True, "true") else 0,
            description=(b.get("description") or "").strip(),
        )
        if new_id is None:
            self.fail("模型名称已存在")
            return
        reset_agents()
        self.ok(id=new_id)


class AdminModelItemHandler(AdminApiHandler):
    """POST /api/admin/models/<id> 更新（api_key 留空保持不变）；DELETE 删除（默认模型自动让位）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, engine_id):
        if not self.require_menu(URL_MODELS):
            return
        b = self.body()
        name = (b.get("name") or "").strip() or None
        api_url = (b.get("api_url") or "").strip() or None
        model_id = (b.get("model_id") or "").strip() or None
        mtype = (b.get("type") or "").strip() or None
        if name is not None and len(name) > 64:
            self.fail("模型名称不能超过64个字符")
            return
        if api_url is not None and not api_url.startswith(("http://", "https://")):
            self.fail("API 地址须以 http:// 或 https:// 开头")
            return
        if mtype is not None and mtype not in MODEL_TYPES:
            self.fail("未知的模型类型")
            return
        enabled = b.get("enabled")
        err = ModelEngineRepository.update(
            int(engine_id),
            name=name,
            api_url=api_url,
            api_key=(b.get("api_key") or "").strip() or None,
            model_id=model_id,
            mtype=mtype,
            thinking=(1 if b.get("thinking") in (1, "1", True, "true") else 0) if b.get("thinking") is not None else None,
            enabled=(1 if enabled in (1, "1", True, "true") else 0) if enabled is not None else None,
            description=b.get("description") if b.get("description") is not None else None,
        )
        if err:
            self.fail(err["error"])
            return
        reset_agents()
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, engine_id):
        if not self.require_menu(URL_MODELS):
            return
        err = ModelEngineRepository.delete(int(engine_id))
        if err:
            self.fail(err["error"])
            return
        TokenStatsRepository.delete_by_engine(int(engine_id))  # 任务8.1：同步清理该模型 token 流水
        reset_agents()
        self.ok()


class AdminModelDefaultHandler(AdminApiHandler):
    """POST /api/admin/models/<id>/default 设为系统默认模型（须启用态）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, engine_id):
        if not self.require_menu(URL_MODELS):
            return
        err = ModelEngineRepository.set_default(int(engine_id))
        if err:
            self.fail(err["error"])
            return
        reset_agents()
        self.ok()


class AdminModelStatsHandler(AdminApiHandler):
    """GET /api/admin/models/stats 模型 token 统计（任务8.1，图形化呈现数据源）：
    query: days=近 N 日趋势（1-90，默认 14）、engine_id=可选只看某模型明细
    返回：summary 全局汇总 / trend 按天趋势（含 0 值日补齐）/ ranking 模型排行 / logs 最近明细"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_MODELS):
            return
        try:
            days = int(self.get_argument("days", "14"))
        except ValueError:
            days = 14
        engine_id = self.get_argument("engine_id", "").strip()
        logs = TokenStatsRepository.recent_logs(int(engine_id) if engine_id else None, 12)
        self.ok(days=max(1, min(days, 90)),
                summary=TokenStatsRepository.summary(),
                trend=TokenStatsRepository.daily_trend(days),
                ranking=TokenStatsRepository.model_ranking(8),
                logs=logs)


class AdminModelTestHandler(AdminApiHandler):
    """POST /api/admin/models/<id>/test 模型测试（SSE 流）：
    - text/multimodal/vl：body {messages:[{role,content}...], thinking:0/1}，流式对话测试；
      vl/multimodal 的 content 可为 OpenAI 视觉范式数组（text + image_url），由前端组装
    - embedding：body {text:"..."}，一次性返回向量维度与预览（result 事件）
    - image：body {prompt:"..."}，一次性返回图片 URL/base64（image 事件）
    """

    @tornado.web.authenticated
    @backend_required
    async def post(self, engine_id):
        if not self.require_menu(URL_MODELS):
            return
        model = ModelEngineRepository.get_by_id(int(engine_id))
        if not model:
            self.fail("模型不存在", status=404)
            return
        if not model["enabled"]:
            self.fail("模型已停用，请先启用再测试")
            return
        b = self.body()

        self.start_sse()

        try:
            if model["type"] in _CHAT_TYPES:
                messages = b.get("messages") or []
                # 只放行合法 role，过滤空内容，限制上下文条数防止滥用
                clean = []
                for m in messages[-40:]:
                    role = m.get("role")
                    content = m.get("content")
                    if role in ("system", "user", "assistant") and content:
                        clean.append({"role": role, "content": content})
                if not clean or clean[-1]["role"] != "user":
                    await self.send_event("error", {"message": "messages 须以一条 user 消息结尾"})
                    return
                thinking = b.get("thinking") in (1, "1", True, "true")
                async for event in model_service.stream_chat_test(model, clean, thinking):
                    etype = event["type"]
                    if etype == "delta":
                        await self.send_event("delta", event["text"])
                    elif etype == "reasoning":
                        await self.send_event("reasoning", {"text": event["text"]})
                    elif etype == "usage":
                        await self.send_event("usage", event["usage"])
                    elif etype == "notice":
                        await self.send_event("notice", {"message": event["message"]})
                    elif etype == "error":
                        await self.send_event("error", {"message": event["message"]})
            elif model["type"] == "embedding":
                text = (b.get("text") or "").strip()
                if not text:
                    await self.send_event("error", {"message": "text 不能为空"})
                    return
                result = await model_service.embedding_test(model, text)
                await self.send_event("result", result)
            elif model["type"] == "image":
                prompt = (b.get("prompt") or "").strip()
                if not prompt:
                    await self.send_event("error", {"message": "prompt 不能为空"})
                    return
                result = await model_service.image_test(model, prompt)
                await self.send_event("image", result)

            await self.send_event("done", {})
        except Exception as e:
            await self.send_event("error", {"message": str(e)})