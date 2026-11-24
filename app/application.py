"""
application模块：定义web应用输入
- 路由表的维护和创建
- 配置目录、静态文件夹、模板目录
- 登录/安全相关配置
- 启动前需要执行的初始化操作：init_db()
- make_app()  创建web应用
"""

import os
import mimetypes
import tornado.web

from app.controllers.auth import LoginHandler, RegisterHandler, LogoutHandler
from app.controllers.base import NotFoundHandler
from app.controllers.chat import ChatHandler, HistoryHandler
from app.controllers.course_materials import CourseMaterialHandler
from app.controllers.health import HealthHandler
from app.controllers.face import (
    AdminUserFaceItemHandler,
    AdminUserFacesApiHandler,
    FaceDeleteApiHandler,
    FaceEnrollApiHandler,
    FaceLoginHandler,
    FaceStatusApiHandler,
    FaceToggleApiHandler,
    FaceVerifyApiHandler,
)
from app.controllers.ws import EchoWebSocketHandler, NotifyWebSocketHandler
from app.controllers.assistant import (
    AssistantListApiHandler,
    AssistantSelectApiHandler,
)

from app.controllers.page import IndexHandler, CampusMapHandler
from app.controllers.collect import (
    CollectPageHandler, CollectQQPageHandler,
    CollectSourcesApiHandler,
    CollectRunApiHandler,
    CollectItemsApiHandler,
)
from app.controllers.qq_channel import (
    QQChannelRunsHandler, QQChannelRunHandler, QQChannelReviewHandler, QQChannelAnalyzeHandler,
    QQChannelConnectionHandler, QQChannelCommentsHandler,
)
from app.controllers.warehouse import (
    WarehousePageHandler,
    WarehouseListApiHandler,
    WarehouseItemApiHandler,
    WarehouseDetailApiHandler,
    WarehouseBatchApiHandler,
    WarehouseSourcesApiHandler,
    WarehouseItemsApiHandler,
    DeepCollectOneApiHandler,
    DeepCollectBatchApiHandler,
)
from app.controllers.admin import (
    AdminDashboardHandler,
    AdminUsersHandler,
    AdminRolesHandler,
    AdminMenusHandler,
    AdminSourcesHandler,
    AdminUsersApiHandler,
    AdminUserItemHandler,
    AdminUsersBatchHandler,
    AdminUserLogoutHandler,
    AdminLoginLogsApiHandler,
    AdminRolesApiHandler,
    AdminRoleItemHandler,
    AdminRoleMenusHandler,
    AdminMenusApiHandler,
    AdminMenuItemHandler,
    AdminMenusSortHandler,
    AdminSourcesApiHandler,
    AdminSourceItemHandler,
)
from app.controllers.model_engine import (
    AdminModelsHandler,
    AdminModelsApiHandler,
    AdminModelItemHandler,
    AdminModelDefaultHandler,
    AdminModelStatsHandler,
    AdminModelTestHandler,
)
from app.controllers.employees import (
    AdminEmployeesHandler,
    AdminEmployeesApiHandler,
    AdminEmployeeItemHandler,
    AdminEmployeeDefaultHandler,
    AdminEmployeeToggleHandler,
    AdminEmployeeFilesHandler,
)
from app.controllers.intelligence import KnowledgeHandler, SentimentHandler, SentimentSocket
from app.controllers.mcp import NewsMcpHandler
# 成员 E：定时任务管理 / 数据统计接口 + 启动期拉起调度器
from app.controllers.tasks import (
    AdminTasksHandler,
    AdminTasksApiHandler,
    AdminTaskItemHandler,
    AdminTaskToggleHandler,
    AdminTaskRunHandler,
    AdminTaskLogsApiHandler,
    AdminSchedulerStatusHandler,
    AdminNotifyTestHandler,
    AdminNotifyPageHandler,
    AdminNotifyConfigHandler,
    AdminNotifyConfigSaveHandler,
)
from app.controllers.stats import (
    StatsOverviewApiHandler,
    StatsTrendApiHandler,
    StatsBySourceApiHandler,
    StatsByRiskApiHandler,
    StatsKeywordsApiHandler,
    StatsReportApiHandler,
)
# 成员 E：会话归档页（追溯 message_archives）
from app.controllers.archives import (
    AdminArchivesHandler,
    AdminArchivesApiHandler,
)
# 成员 E：对话记录管理（messages 跨用户）+ 临时会话查询（user_sessions）
from app.controllers.messages import (
    AdminMessagesPageHandler,
    AdminMessagesApiHandler,
    AdminMessageItemApiHandler,
)
from app.controllers.sessions import (
    AdminSessionsPageHandler,
    AdminSessionsApiHandler,
)
# 成员 D：用户中心 / 对话导出 PDF / @音乐 / 智能问数 / 3D 数字人（任务1+任务2）
from app.controllers.user import (
    UserPageHandler,
    UserProfileApiHandler,
    UserPasswordApiHandler,
    UserSessionsApiHandler,
)
from app.controllers.chat_export import ChatExportHandler
from app.controllers.music import MusicSearchApiHandler, MusicPlayApiHandler
from app.controllers.qa import (
    QaPageHandler,
    QaAskApiHandler,
    QaHistoryApiHandler,
    QaReportApiHandler,
)
from app.controllers.avatar import AvatarPageHandler
# 成员 C：数智大屏 / 统计报表 / 工具链路 / 系统设置 + 快照与 SSE 推送
from app.controllers.console import (
    AdminConsoleDashboardHandler,
    AdminReportsHandler,
    AdminToolsHandler,
    AdminSettingsHandler,
    StatsSnapshotApiHandler,
    StatsStreamHandler,
    DashboardAskApiHandler,
    AdminToolsApiHandler,
    AdminSettingsApiHandler,
)
from app.services import scheduler_service
from app.models.db import init_db
import app.config as config

_BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))

TEMPLATE_DIR = os.path.join(_BASE_DIR, 'app', "templates")
STATIC_DIR = os.path.join(_BASE_DIR, 'app', "static")

def make_app():
    # 启动期再做一次严格校验：配置缺失/非法直接抛 ConfigError，禁止带病启动
    config.reload(strict=True)
    # WebP 静态资源的 MIME：Windows 上 mimetypes 会把 .webp 猜成
    # application/octet-stream，浏览器会把「系统图标 / 浏览器图标」当成下载或不渲染
    mimetypes.add_type("image/webp", ".webp")
    init_db()
    os.makedirs(os.path.join(_BASE_DIR, "workspace"), exist_ok=True)
    application = tornado.web.Application(
        [
            # 前台（用户侧）
            (r"/", IndexHandler),
            (r"/api/chat", ChatHandler),
            (r"/api/course-materials/([a-z0-9-]+)/(preview|file|download)", CourseMaterialHandler),
            (r"/api/history", HistoryHandler),
            (r"/mcp/news", NewsMcpHandler),

            # 成员 D：用户中心（任务2）
            (r"/user", UserPageHandler),
            (r"/api/user/profile", UserProfileApiHandler),
            (r"/api/user/password", UserPasswordApiHandler),
            (r"/api/user/sessions", UserSessionsApiHandler),

            # 成员 D：对话导出 PDF（任务2，GET 直接回 PDF 附件流）
            (r"/api/chat/export", ChatExportHandler),

            # 成员 D：@音乐 播放（任务2，本地内置曲库）
            (r"/api/music/search", MusicSearchApiHandler),
            (r"/api/music/play", MusicPlayApiHandler),

            # 成员 D：智能问数（任务1核心：数仓统计 + 模型报告）
            (r"/qa", QaPageHandler),
            (r"/campus-map", CampusMapHandler),
            (r"/api/qa/ask", QaAskApiHandler),
            (r"/api/qa/history", QaHistoryApiHandler),
            (r"/api/qa/report/(\d+)", QaReportApiHandler),

            # 成员 D：3D 数字人交互页（任务2，three.js 本地 vendor）
            (r"/avatar", AvatarPageHandler),

            # 数字助理选择（任务10：数字员工与前台用户侧关联，仅登录鉴权、不走后台菜单）
            (r"/api/assistants", AssistantListApiHandler),
            (r"/api/assistants/select", AssistantSelectApiHandler),

            # 后台（admin 侧）：/admin 为工作台，其余为各管理模块页（框架，模块功能属任务4）
            (r"/admin", AdminDashboardHandler),
            (r"/admin/users", AdminUsersHandler),
            (r"/admin/roles", AdminRolesHandler),
            (r"/admin/menus", AdminMenusHandler),
            (r"/admin/sources", AdminSourcesHandler),
            (r"/admin/warehouse", WarehousePageHandler),
            (r"/admin/models", AdminModelsHandler),
            (r"/admin/employees", AdminEmployeesHandler),
            (r"/admin/knowledge", KnowledgeHandler),
            (r"/admin/sentiment", SentimentHandler),
            (r"/ws/admin/sentiment", SentimentSocket),

            # 后台管理数据接口（任务4：用户/角色/菜单 增删改查 + 分页）
            (r"/api/admin/users", AdminUsersApiHandler),
            (r"/api/admin/users/batch", AdminUsersBatchHandler),
            # 任务11：强制下线该用户全部会话
            (r"/api/admin/users/(\d+)/logout", AdminUserLogoutHandler),
            # 任务12：人脸数据管理（查看/代录/启停/删除）
            (r"/api/admin/users/(\d+)/faces", AdminUserFacesApiHandler),
            (r"/api/admin/users/(\d+)/faces/(\d+)", AdminUserFaceItemHandler),
            (r"/api/admin/users/(\d+)", AdminUserItemHandler),
            # 任务11：登录审计（仅用户管理权限可查）
            (r"/api/admin/login-logs", AdminLoginLogsApiHandler),
            (r"/api/admin/roles", AdminRolesApiHandler),
            (r"/api/admin/roles/(\d+)/menus", AdminRoleMenusHandler),
            (r"/api/admin/roles/(\d+)", AdminRoleItemHandler),
            (r"/api/admin/menus", AdminMenusApiHandler),
            (r"/api/admin/menus/sort", AdminMenusSortHandler),
            (r"/api/admin/menus/(\d+)", AdminMenuItemHandler),

            # 信源管理数据接口（任务5：URL 规格 + Request Headers 规则 CRUD + 分页）
            (r"/api/admin/sources", AdminSourcesApiHandler),
            (r"/api/admin/sources/(\d+)", AdminSourceItemHandler),

            # 模型引擎管理（任务8：OpenAI 范式接入 CRUD + 默认模型 + 对话/嵌入/图片测试，橱窗 4/页；
            # 任务8.1：token 统计接口 + 列表随行下发卡片数据）
            (r"/api/admin/models", AdminModelsApiHandler),
            (r"/api/admin/models/stats", AdminModelStatsHandler),
            (r"/api/admin/models/(\d+)/default", AdminModelDefaultHandler),
            (r"/api/admin/models/(\d+)/test", AdminModelTestHandler),
            (r"/api/admin/models/(\d+)", AdminModelItemHandler),

            # 数字员工管理（任务9：agentica 智能体配置入库，橱窗 4 列 12/页；
            # instructions MD 可视化编辑 + md 文件关联 + 工具链路/工作空间/RAG 预留）
            (r"/api/admin/employees", AdminEmployeesApiHandler),
            (r"/api/admin/employees/files", AdminEmployeeFilesHandler),
            (r"/api/admin/employees/(\d+)/default", AdminEmployeeDefaultHandler),
            (r"/api/admin/employees/(\d+)/toggle", AdminEmployeeToggleHandler),
            (r"/api/admin/employees/(\d+)", AdminEmployeeItemHandler),

            # 采集管理（任务6：独立采集主页，无 layui；关键词 + 选源参数配置 + 橱窗列表 12/页）
            (r"/collect", CollectPageHandler),
            (r"/collect/web", CollectPageHandler),
            (r"/collect/qq", CollectQQPageHandler),
            (r"/api/collect/sources", CollectSourcesApiHandler),
            (r"/api/collect/run", CollectRunApiHandler),
            (r"/api/collect/items", CollectItemsApiHandler),
            (r"/api/collect/qq/runs", QQChannelRunsHandler),
            (r"/api/collect/qq/connection", QQChannelConnectionHandler),
            (r"/api/collect/qq/runs/(\d+)", QQChannelRunHandler),
            (r"/api/collect/qq/runs/(\d+)/items/(\d+)/review", QQChannelReviewHandler),
            (r"/api/collect/qq/runs/(\d+)/items/(\d+)/analyze", QQChannelAnalyzeHandler),
            (r"/api/collect/qq/runs/(\d+)/items/(\d+)/comments", QQChannelCommentsHandler),

            # 数据仓库（任务7：深采正文仓库 CRUD 20/页 + 单一/批量深采 SSE 执行面板）
            (r"/api/admin/warehouse", WarehouseListApiHandler),
            (r"/api/admin/warehouse/batch", WarehouseBatchApiHandler),
            (r"/api/admin/warehouse/sources", WarehouseSourcesApiHandler),
            (r"/api/admin/warehouse/(\d+)", WarehouseItemApiHandler),
            (r"/api/admin/warehouse/(\d+)/detail", WarehouseDetailApiHandler),
            (r"/api/warehouse/items", WarehouseItemsApiHandler),
            (r"/api/warehouse/deep/one", DeepCollectOneApiHandler),
            (r"/api/warehouse/deep/batch", DeepCollectBatchApiHandler),

            # 定时任务管理（成员 E：周期调度 / 自动归档 / 日志清理 / 结果通知）
            (r"/admin/tasks", AdminTasksHandler),
            (r"/api/admin/tasks", AdminTasksApiHandler),
            (r"/api/admin/tasks/(\d+)/toggle", AdminTaskToggleHandler),
            (r"/api/admin/tasks/(\d+)/run", AdminTaskRunHandler),
            (r"/api/admin/tasks/(\d+)", AdminTaskItemHandler),
            (r"/api/admin/task-logs", AdminTaskLogsApiHandler),
            (r"/api/admin/scheduler", AdminSchedulerStatusHandler),
            (r"/api/admin/notify/test", AdminNotifyTestHandler),
            (r"/admin/notify", AdminNotifyPageHandler),
            (r"/api/admin/notify/config", AdminNotifyConfigHandler),
            (r"/api/admin/notify/config/save", AdminNotifyConfigSaveHandler),

            # 会话归档（成员 E：message_archives 历史会话追溯，支持多条件筛选）
            (r"/admin/archives", AdminArchivesHandler),
            (r"/api/admin/archives", AdminArchivesApiHandler),

            # 对话记录管理（成员 E：messages 跨用户后台管理 + 删除）
            (r"/admin/messages", AdminMessagesPageHandler),
            (r"/api/admin/messages", AdminMessagesApiHandler),
            (r"/api/admin/messages/(\d+)", AdminMessageItemApiHandler),

            # 临时会话查询（成员 E：user_sessions 登录会话列表 + 撤销）
            (r"/admin/sessions", AdminSessionsPageHandler),
            (r"/api/admin/sessions", AdminSessionsApiHandler),

            # 数据统计接口（成员 E：为成员 C 的数智大屏 / 报表提供只读聚合数据）
            (r"/api/stats/overview", StatsOverviewApiHandler),
            (r"/api/stats/trend", StatsTrendApiHandler),
            (r"/api/stats/by-source", StatsBySourceApiHandler),
            (r"/api/stats/by-risk", StatsByRiskApiHandler),
            (r"/api/stats/keywords", StatsKeywordsApiHandler),
            (r"/api/stats/report", StatsReportApiHandler),

            # 成员 C：数智大屏（全屏）/ 统计报表 / 工具链路 / 系统设置
            (r"/admin/dashboard", AdminConsoleDashboardHandler),
            (r"/admin/reports", AdminReportsHandler),
            (r"/admin/tools", AdminToolsHandler),
            (r"/admin/settings", AdminSettingsHandler),
            # 快照 + SSE 实时推送 + 大屏语音问答
            (r"/api/stats/snapshot", StatsSnapshotApiHandler),
            (r"/api/stats/stream", StatsStreamHandler),
            (r"/api/dashboard/ask", DashboardAskApiHandler),
            # 工具链路只读接口 + 系统设置读写（含库切换与图标上传）
            (r"/api/admin/tools", AdminToolsApiHandler),
            (r"/api/admin/settings", AdminSettingsApiHandler),

            # 任务16：WebSocket 基础通道（握手鉴权 + 心跳 + 回显/推送）
            (r"/ws", EchoWebSocketHandler),
            (r"/ws/notify", NotifyWebSocketHandler),

            # 任务12：人脸登录与本人人脸数据
            (r"/api/face/status", FaceStatusApiHandler),
            (r"/api/face/enroll", FaceEnrollApiHandler),
            (r"/api/face/verify", FaceVerifyApiHandler),
    (r"/api/face/toggle", FaceToggleApiHandler),
            (r"/api/face/(\d+)", FaceDeleteApiHandler),
            (r"/auth/face/login", FaceLoginHandler),

            # 任务17：健康检查（不要求登录、不泄露配置）
            (r"/healthz", HealthHandler),

            (r"/auth/login", LoginHandler),
            (r"/auth/register", RegisterHandler),
            (r"/auth/logout", LogoutHandler),
            (r"/static/(.*)", tornado.web.StaticFileHandler, {"path": STATIC_DIR}),
        ],
        template_path=TEMPLATE_DIR,
        static_path=STATIC_DIR,
        # 任务13：密钥/调试开关/XSRF 全部来自配置中心，不再硬编码
        cookie_secret=config.COOKIE_SECRET,
        login_url="/auth/login",
        xsrf_cookies=config.XSRF_ENABLED,
        debug=config.DEBUG,
        # 任务15：未匹配路由也走 BaseHandler 的统一错误出口（安全头/CORS/请求编号/JSON）
        default_handler_class=NotFoundHandler,
    )
    # 成员 E：启动定时任务调度器（SCHEDULER_ENABLED=0 时内部自动跳过；
    # APScheduler 走独立后台线程，tornado 降级引擎用 IOLoop.call_at，均不阻塞启动）
    scheduler_service.start()
    return application
