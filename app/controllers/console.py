"""
数智大屏 / 统计报表 / 工具链路 / 系统设置 控制器（成员 C）

页面与接口一览：
- GET  /admin/dashboard            全屏数智大屏（脱离五段式后台壳）
- GET  /admin/reports              统计报表（后台壳内）
- GET  /admin/tools                工具链路
- GET  /admin/settings             系统设置（仅超级管理员）
- GET  /api/stats/snapshot         一次性快照（大屏/报表/预警台首屏）
- GET  /api/stats/stream           SSE 实时推送（event: bootstrap / snapshot / heartbeat）
- POST /api/dashboard/ask          大屏语音问答（库内口径直答，不依赖外部模型）
- GET  /api/admin/tools            工具注册表 + 数字员工绑定矩阵
- GET  /api/admin/settings         设置全量读取（密码掩码）
- POST /api/admin/settings         保存 / 上传图标 / 测试库 / 切换库

权限：沿用 backend_required + require_menu；系统设置额外要求 role_code()=="admin"（超管强校验）。
SSE：复用 app/controllers/sse.py 的 SSEMixin（响应头/心跳/断连检测统一口径），
     不新造事件名，沿用 heartbeat；业务事件用 bootstrap / snapshot。
"""

import asyncio
import logging

import tornado.web

from app.controllers.admin import AdminApiHandler, AdminBaseHandler, backend_required
from app.models.console import ConsoleStatsRepository, _ALIASES_SORTED
from app.models.digital_employee import DigitalEmployeeRepository
from app.services import settings_service

logger = logging.getLogger(__name__)

URL_DASHBOARD = "/admin/dashboard"
URL_REPORTS = "/admin/reports"
URL_TOOLS = "/admin/tools"
URL_SETTINGS = "/admin/settings"

# 工具注册表展示元数据：id 必须与 services/agent_service.py 的 TOOL_REGISTRY / CAMPUS_TOOLS / _tools_for 对齐
TOOL_META = {
    "weather": {"name": "天气查询", "kind": "内置工具", "provider": "agentica · WeatherTool",
                "desc": "按城市返回实时天气，供数字员工在对话中按需调用"},
    "todo": {"name": "待办管理", "kind": "内置工具", "provider": "agentica · BuiltinTodoTool",
             "desc": "为当前用户创建/查看待办，写入 agentica workspaces 工作空间"},
    "task": {"name": "任务管理", "kind": "内置工具", "provider": "agentica · BuiltinTaskTool",
             "desc": "为当前用户创建任务与子任务，支撑多轮任务型对话"},
    "memory": {"name": "长期记忆", "kind": "内置工具", "provider": "agentica · BuiltinMemoryTool",
               "desc": "在用户级工作空间内做长期记忆读写，跨会话保持偏好"},
    "warehouse": {"name": "数仓检索", "kind": "数据工具", "provider": "本地 warehouse_data",
                  "desc": "按关键词检索已入库正文（status=2），把站内数据作为对话依据"},
    "mcp_search": {"name": "网络搜索", "kind": "MCP", "provider": "/mcp/news",
                   "desc": "经 MCP 通道检索公开新闻（优先国内可达 RSS 源），补齐站外实时信息"},
    "campus_shuttle": {"name": "校园班车查询", "kind": "校园工具", "provider": "CampusAgentOS · CWNU",
                       "desc": "查询华凤校区、北湖校区及都京方向通勤校车停靠点与公交接驳参考"},
    "campus_calendar": {"name": "校历与考试周", "kind": "校园工具", "provider": "CampusAgentOS · CWNU",
                        "desc": "按今日日期动态计算本学期阶段、选课、四六级与期末考试周参考节点"},
    "campus_gpa": {"name": "绩点与奖学金测算", "kind": "校园工具", "provider": "CampusAgentOS · CWNU",
                   "desc": "解析成绩单并计算 4.0/5.0 制参考 GPA，同步匹配国奖/励志/校奖条件"},
    "campus_directory": {"name": "校内办事黄页", "kind": "校园工具", "provider": "CampusAgentOS · CWNU",
                         "desc": "检索教务、资助、就业、图书馆、报修、校园网及心理危机热线"},
}


# ==================== 页面 ====================

class AdminConsoleDashboardHandler(AdminBaseHandler):
    """数智大屏：全屏模板（独立于后台五段式壳），数据由 SSE/快照接口供给"""

    template_name = "admin/dashboard.html"
    page_name = "数智大屏"
    nav_url = URL_DASHBOARD

    def get_context(self) -> dict:
        brand = settings_service.branding()
        try:
            refresh = int(brand.get("dashboard_refresh") or 10)
        except (TypeError, ValueError):
            refresh = 10
        return {
            "refresh_seconds": max(5, min(refresh, 120)),
            "site_subtitle": brand.get("site_subtitle") or "西华师范大学智慧校园服务智能体平台",
            "watermark": brand.get("ui_watermark") == "1",
        }


class AdminReportsHandler(AdminBaseHandler):
    """统计报表：四分区（趋势/信源/风险/热词）+ 自选图例 + PNG 导出 + SSE 实时"""

    template_name = "admin/reports.html"
    page_name = "统计报表"
    nav_url = URL_REPORTS


class AdminToolsHandler(AdminBaseHandler):
    """工具链路：工具注册表 + 数字员工绑定矩阵（只读展示，配置跳数字员工页）"""

    template_name = "admin/tools.html"
    page_name = "工具链路"
    nav_url = URL_TOOLS


class AdminSettingsHandler(AdminBaseHandler):
    """系统设置：系统名称/图标、数据库切换、语音与人脸模型、安全参数"""

    template_name = "admin/settings.html"
    page_name = "系统设置"
    nav_url = URL_SETTINGS

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(self.nav_url):
            return
        if self.role_code() != "admin":
            self.deny(403, "系统设置仅超级管理员可访问")
            return
        self.render_admin(**self.get_context())

    def get_context(self) -> dict:
        return settings_service.load_all()


# ==================== 快照 / SSE ====================

class StatsSnapshotApiHandler(AdminApiHandler):
    """GET /api/stats/snapshot?days=14 —— 大屏/报表/预警台首屏一次性取全量"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        try:
            days = int(self.get_argument("days", "14"))
        except ValueError:
            days = 14
        self.ok(snapshot=ConsoleStatsRepository.snapshot(days=days))


class StatsStreamHandler(AdminBaseHandler):
    """GET /api/stats/stream?interval=10 —— SSE 实时推送

    - 首帧 event:bootstrap 下发完整快照，前端据此建图；
    - 之后每 interval 秒 event:snapshot 下发同一结构（前端做增量更新而非重建图表）；
    - 空闲帧用 SSEMixin.heartbeat() 发注释行，防止中间代理 60s 断流；
    - 客户端断开时通过 client_gone() 退出循环，避免线程/协程泄漏。
    """

    api = True

    @tornado.web.authenticated
    @backend_required
    async def get(self):
        try:
            interval = int(self.get_argument("interval", "10"))
        except ValueError:
            interval = 10
        interval = max(5, min(interval, 120))
        try:
            days = int(self.get_argument("days", "14"))
        except ValueError:
            days = 14
        days = max(7, min(days, 90))

        self.start_sse()
        try:
            await self.send_event("bootstrap", ConsoleStatsRepository.snapshot(days=days))
            ticks = 0
            while not self.client_gone():
                for _ in range(interval):
                    await asyncio.sleep(1)
                    if self.client_gone():
                        return
                    ticks += 1
                    if ticks % 15 == 0:
                        await self.heartbeat("")
                await self.send_event("snapshot", ConsoleStatsRepository.snapshot(days=days))
        except asyncio.CancelledError:
            raise
        except (ConnectionError, tornado.web.HTTPError):
            pass
        except Exception:
            logger.exception("大屏 SSE 推送异常")
        finally:
            self.finish_sse()


# ==================== 大屏语音问答 ====================

def _match_question_region(question: str) -> str:
    if "南充" in question:
        return "四川"
    for alias, province in _ALIASES_SORTED:
        if alias in question:
            return province
    return ""


def _answer_question(question: str, snap: dict) -> dict:
    """库内口径直答 + 大屏画面联动指令（action）：
    按问题意图命中指标并可选附带前端联动 action（地球聚焦/切换双校区/高亮面板），
    不依赖外部大模型，答辩或离线环境同样稳定响应。
    """
    q = (question or "").strip()
    ov = snap.get("overview") or {}
    risk = ov.get("risk") or {}
    counts = risk.get("counts") or {}
    token = ov.get("token") or {}
    chips = []
    intent = "overview"
    action = None

    def num(value):
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def add(label, value, unit=""):
        chips.append({"label": label, "value": str(value), "unit": unit})

    def warehouse_total() -> int:
        """overview["warehouse"] 是 {done,failed,pending} 字典，这里统一成"已入库正文"总数"""
        wh = ov.get("warehouse")
        if isinstance(wh, dict):
            return num(wh.get("done"))
        return num(wh)

    matched_region = _match_question_region(q)

    if any(k in q for k in ("校区", "华凤", "北湖", "都京")):
        intent = "campus"
        action = {"type": "switch_map_mode", "mode": "campus"}
        kws = snap.get("keywords") or []
        top_kw = "、".join(str(r.get("keyword")) for r in kws[:3]) or "奖学金、双选会"
        add("华凤校区", "主枢纽", "")
        add("北湖校区", "联动枢纽", "")
        add("高风险线索", num(counts.get("high")), "条")
        add("今日采集", num(ov.get("collect_today")), "条")
        answer = "已为您切换至「华凤 / 北湖双校区」态势视图：今日校园关注焦点集中在 %s，待关注与高风险线索共 %d 条。" % (
            top_kw, num(counts.get("high")) + num(counts.get("watch")))

    elif matched_region:
        intent = "region_focus"
        action = {"type": "focus_region", "region": matched_region}
        reg_list = (snap.get("by_region") or {}).get("list") or []
        hit = next((r for r in reg_list if r.get("name") == matched_region), None)
        rank = (reg_list.index(hit) + 1) if hit else 0
        cnt = num(hit.get("value")) if hit else 0
        add("聚焦区域", matched_region, "")
        add("文本提及", cnt, "篇")
        if rank:
            add("全网排名", "第 %d 名" % rank, "")
        answer = (
            "已在 3D 地球定位至「%s」：当前关联资讯与报道共 %d 篇（全国排名第 %d）。" % (matched_region, cnt, rank)
            if hit else
            "已在 3D 地球定位至「%s」节点：当前采集中暂未出现高频文本提及，可点击地球节点查看关联轨迹。" % matched_region
        )

    elif any(k in q for k in ("风险", "预警", "隐患", "异常", "安全", "舆情")):
        intent = "risk"
        action = {"type": "highlight_panel", "target": "risk"}
        high, watch = num(counts.get("high")), num(counts.get("watch"))
        add("高风险", high, "条")
        add("关注", watch, "条")
        add("待复核", num(counts.get("error")), "条")
        latest = (snap.get("high_risks") or [None])[0]
        answer = "当前共识别高风险 %d 条、关注级 %d 条、待复核 %d 条。" % (
            high, watch, num(counts.get("error")))
        if latest:
            answer += "最新一条高风险线索是《%s》，来自%s。" % (
                (latest.get("title") or "")[:40], latest.get("source_name") or "未知信源")
        else:
            answer += "目前没有未处理的高风险线索。"

    elif any(k in q for k in ("信源", "来源", "渠道", "站点")):
        intent = "source"
        action = {"type": "highlight_panel", "target": "source"}
        sources = snap.get("by_source") or []
        for row in sources[:4]:
            add(row.get("source_name") or "-", num(row.get("count")), "条")
        top = "、".join("%s %d 条" % (r.get("source_name"), num(r.get("count")))
                       for r in sources[:3])
        answer = ("信源采集量前三位是 %s。" % top) if top else "暂无信源采集记录。"

    elif any(k in q for k in ("关键词", "热词", "主题", "焦点")):
        intent = "keywords"
        action = {"type": "highlight_panel", "target": "center"}
        kws = snap.get("keywords") or []
        for row in kws[:5]:
            add(row.get("keyword") or "-", num(row.get("count")), "次")
        top = "、".join(str(r.get("keyword")) for r in kws[:5])
        answer = ("当前热词集中在 %s。" % top) if top else "暂未形成热词。"

    elif any(k in q for k in ("趋势", "增长", "环比", "走势", "这几天")):
        intent = "trend"
        action = {"type": "highlight_panel", "target": "trend"}
        trend = snap.get("trend") or []
        last7 = sum(num(r.get("collect")) for r in trend[-7:])
        prev7 = sum(num(r.get("collect")) for r in trend[-14:-7])
        delta = last7 - prev7
        rate = ("%+.1f%%" % (delta * 100.0 / prev7)) if prev7 else "无法计算（上期无数据）"
        add("近 7 日采集", last7, "条")
        add("前 7 日采集", prev7, "条")
        add("环比", rate)
        answer = "近 7 日采集 %d 条，前 7 日 %d 条，环比 %s。" % (last7, prev7, rate)

    elif any(k in q for k in ("地区", "地域", "省份", "地图", "分布")):
        intent = "region"
        action = {"type": "switch_map_mode", "mode": "globe"}
        regions = (snap.get("by_region") or {}).get("list") or []
        for row in regions[:4]:
            add(row.get("name") or "-", num(row.get("value")), "篇")
        top = "、".join("%s %d 篇" % (r.get("name"), num(r.get("value"))) for r in regions[:3])
        answer = (("标题/摘要提及最多的省级行政区是 %s（按文本提及口径）。" % top)
                  if top else "当前采集内容未提及具体省级行政区。")

    elif any(k in q for k in ("用户", "活跃", "在线", "会话")):
        intent = "users"
        action = {"type": "highlight_panel", "target": "kpis"}
        add("用户总数", num(ov.get("users")), "人")
        add("活跃会话", num(ov.get("active_sessions")), "个")
        add("对话消息", num(ov.get("messages")), "条")
        answer = "平台现有用户 %d 人，活跃会话 %d 个，累计对话消息 %d 条。" % (
            num(ov.get("users")), num(ov.get("active_sessions")), num(ov.get("messages")))

    elif any(k in q for k in ("token", "模型", "成本", "调用")):
        intent = "token"
        action = {"type": "highlight_panel", "target": "kpis"}
        add("模型调用", num(token.get("call_count")), "次")
        add("Token 合计", num(token.get("token_total")), "")
        answer = "模型累计调用 %d 次，消耗 Token %d。" % (
            num(token.get("call_count")), num(token.get("token_total")))

    elif any(k in q for k in ("采集", "数据量", "最新", "总量", "多少数据")):
        intent = "collect"
        action = {"type": "highlight_panel", "target": "kpis"}
        wh = warehouse_total()
        add("采集总量", num(ov.get("collect_total")), "条")
        add("今日新增", num(ov.get("collect_today")), "条")
        add("数仓正文", wh, "篇")
        answer = "累计采集 %d 条，今日新增 %d 条，已入数仓正文 %d 篇。" % (
            num(ov.get("collect_total")), num(ov.get("collect_today")), wh)

    else:
        action = {"type": "highlight_panel", "target": "kpis"}
        wh = warehouse_total()
        add("采集总量", num(ov.get("collect_total")), "条")
        add("今日新增", num(ov.get("collect_today")), "条")
        add("高风险", num(counts.get("high")), "条")
        add("数仓正文", wh, "篇")
        answer = "当前平台累计采集 %d 条（今日 %d 条），数仓正文 %d 篇，高风险线索 %d 条。" % (
            num(ov.get("collect_total")), num(ov.get("collect_today")),
            wh, num(counts.get("high")))

    answer += "（数据口径：库内实时聚合，与统计报表同源，生成于 %s）" % snap.get("generated_at", "")
    return {
        "question": q,
        "intent": intent,
        "answer": answer,
        "chips": chips,
        "speak": answer.split("（数据口径")[0],
        "action": action,
        "generated_at": snap.get("generated_at", ""),
        "suggest": ["华凤北湖双校区", "四川关注情况", "风险预警情况", "信源采集排名"],
    }


class DashboardAskApiHandler(AdminApiHandler):
    """POST /api/dashboard/ask {question} —— 大屏语音/文字问答"""

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_DASHBOARD):
            return
        body = self.body()
        question = (body.get("question") or "").strip()
        if not question:
            self.fail("请输入问题")
            return
        if len(question) > 200:
            self.fail("问题请控制在 200 字以内")
            return
        snap = ConsoleStatsRepository.snapshot(days=14)
        self.ok(**_answer_question(question, snap))


# ==================== 工具链路 ====================

def _registry_snapshot() -> dict:
    """读取工具注册表 + 数字员工绑定矩阵（只读，不缓存：员工随时可能被改）"""
    try:
        from app.services.agent_service import TOOL_REGISTRY
        ids = list(TOOL_REGISTRY.keys())
    except Exception:  # agentica 未装时不阻断页面，按元数据兜底
        ids = [k for k in TOOL_META if k in ("weather", "todo", "task", "memory")]
    ids = ids + [
        k for k in ("warehouse", "mcp_search", "campus_shuttle", "campus_calendar", "campus_gpa", "campus_directory")
        if k not in ids
    ]

    employees = []
    try:
        for row in DigitalEmployeeRepository.get_all():
            tools = row.get("tools") or "[]"
            if isinstance(tools, str):
                try:
                    import json as _json
                    tools = _json.loads(tools or "[]")
                except ValueError:
                    tools = []
            employees.append({
                "id": row.get("id"),
                "name": row.get("name"),
                "enabled": bool(row.get("enabled")),
                "is_default": bool(row.get("is_default")),
                "tools": [t for t in (tools or []) if isinstance(t, str)],
            })
    except Exception:
        logger.exception("读取数字员工失败")

    tools = []
    for tid in ids:
        meta = TOOL_META.get(tid, {"name": tid, "kind": "自定义", "provider": "-", "desc": ""})
        bound = [e for e in employees if tid in e["tools"]]
        tools.append({
            "id": tid, "name": meta["name"], "kind": meta["kind"],
            "provider": meta["provider"], "desc": meta["desc"],
            "bound_count": len(bound), "bound": [{"id": e["id"], "name": e["name"]} for e in bound],
        })
    return {
        "tools": tools,
        "employees": employees,
        "total_tools": len(tools),
        "bound_total": sum(t["bound_count"] for t in tools),
    }


class AdminToolsApiHandler(AdminApiHandler):
    """GET /api/admin/tools —— 工具注册表 + 绑定矩阵"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_TOOLS):
            return
        self.ok(**_registry_snapshot())


# ==================== 系统设置接口 ====================

class AdminSettingsApiHandler(AdminApiHandler):
    """GET 读取全部设置；POST 按 action 分流：save / brand / db_test / db_switch"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self._guard():
            return
        self.ok(**settings_service.load_all())

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self._guard():
            return
        body = self.body()
        action = (body.get("action") or "save").strip()
        actor = self.current_user or ""
        try:
            if action == "save":
                group = (body.get("group") or "").strip()
                values = body.get("values") or {}
                if not isinstance(values, dict):
                    self.fail("values 需为对象")
                    return
                result = settings_service.save(group, values, actor=actor)
                logger.info("系统设置保存 group=%s keys=%s actor=%s", group,
                            ",".join(sorted(values.keys())), actor)
                self.ok(group=group, **result)

            elif action == "brand":
                kind = (body.get("kind") or "").strip()
                data_uri = body.get("data_uri") or ""
                result = settings_service.save_brand_image(kind, data_uri)
                logger.info("系统图标更新 kind=%s url=%s actor=%s", kind, result.get("url"), actor)
                self.ok(**result)

            elif action == "db_test":
                driver = (body.get("driver") or "").strip()
                params = body.get("params") or {}
                result = settings_service.test_database(driver, params)
                self.ok(**result)

            elif action == "db_switch":
                driver = (body.get("driver") or "").strip()
                params = body.get("params") or {}
                params.pop("password_masked", None)
                result = settings_service.switch_database(driver, params, actor=actor)
                logger.warning("数据库驱动已切换 driver=%s actor=%s", driver, actor)
                self.ok(**result)

            else:
                self.fail("未知操作：%s" % action)
        except settings_service.SettingsError as exc:
            self.fail(str(exc))
        except Exception:
            logger.exception("系统设置操作失败 action=%s", action)
            self.fail("操作失败，请查看服务端日志")

    def _guard(self) -> bool:
        """系统设置双重校验：菜单权限 + 超管身份（普通后台角色只能看不能改）"""
        if not self.require_menu(URL_SETTINGS):
            return False
        if self.role_code() != "admin":
            self.deny(403, "系统设置仅超级管理员可操作")
            return False
        return True
