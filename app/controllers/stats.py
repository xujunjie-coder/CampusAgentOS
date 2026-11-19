"""
数据统计接口控制器 —— 成员 E

面向成员 C 的「数智大屏 / 统计报表」提供只读聚合数据接口，数据全部来自 models/stats.py。
- 只读、无副作用，不修改任何业务数据；
- 权限：需登录 + 后台角色（大屏 / 报表属后台可视化），与工作台同为「仅需后台身份」不绑定具体菜单；
- 统一走 AdminApiHandler 的 ok/fail 信封，前端 fetch 直接可用。
"""

import tornado.web

from app.controllers.admin import AdminApiHandler, backend_required
from app.models.stats import StatsRepository


def _days_arg(handler, default: int = 14) -> int:
    try:
        return max(1, min(int(handler.get_argument("days", str(default))), 90))
    except (TypeError, ValueError):
        return default


class StatsOverviewApiHandler(AdminApiHandler):
    """GET /api/stats/overview —— 总览计数（用户 / 会话 / 消息 / 采集 / 数仓 / token / 风险 / 任务）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        self.ok(data=StatsRepository.overview())


class StatsTrendApiHandler(AdminApiHandler):
    """GET /api/stats/trend?days= —— 近 N 天按天趋势（采集 / 消息 / token 三线）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        self.ok(days=_days_arg(self), trend=StatsRepository.daily_trend(_days_arg(self)))


class StatsBySourceApiHandler(AdminApiHandler):
    """GET /api/stats/by-source —— 按信源统计采集条目分布（排行 / 地图）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        try:
            limit = int(self.get_argument("limit", "10"))
        except (TypeError, ValueError):
            limit = 10
        self.ok(list=StatsRepository.by_source(limit))


class StatsByRiskApiHandler(AdminApiHandler):
    """GET /api/stats/by-risk —— 舆情风险等级分布（预警饼图）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        self.ok(list=StatsRepository.by_risk())


class StatsKeywordsApiHandler(AdminApiHandler):
    """GET /api/stats/keywords —— 高频采集关键词（词云 / 热词榜）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        try:
            limit = int(self.get_argument("limit", "12"))
        except (TypeError, ValueError):
            limit = 12
        self.ok(list=StatsRepository.top_keywords(limit))


class StatsReportApiHandler(AdminApiHandler):
    """GET /api/stats/report?days= —— 报表数据包：总览 + 趋势 + 信源 + 风险 + 热词一次返回，
    供大屏 / 报表页一次性拉取，减少前端多次请求。"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        days = _days_arg(self)
        self.ok(days=days,
                overview=StatsRepository.overview(),
                trend=StatsRepository.daily_trend(days),
                by_source=StatsRepository.by_source(),
                by_risk=StatsRepository.by_risk(),
                keywords=StatsRepository.top_keywords())
