"""
定时任务管理控制器 —— 成员 E（任务2 定时任务模块）

分层沿用后台规范：
- 表现层：templates/admin/tasks.html 出「功能区 | 列表区 | 分页区」壳，列表/弹层由 static/js/tasks.js 走本模块 JSON API；
- 控制层：AdminTasksHandler 渲染页面（登录 + 后台角色 + 菜单鉴权），API Handler 提供数据接口；
- 模型 / 服务层：数据走 models/task.py 的 Repository，执行与调度走 services/scheduler_service.py。

权限：沿用 backend_required + require_menu('/admin/tasks')，与信源 / 数仓等后台模块一致。
手动触发把阻塞的 execute_task 放入线程池（run_in_executor），不卡 IOLoop。
"""

import json

import tornado.ioloop
import tornado.web

from app.controllers.admin import (
    PAGE_SIZE, AdminApiHandler, AdminBaseHandler, backend_required,
)
from app.models.task import (
    NOTIFY_CHANNELS, NOTIFY_ON, SCHEDULE_CRON, SCHEDULE_INTERVAL, TASK_TYPES,
    ScheduledTaskRepository, TaskLogRepository,
)
from app.models.settings import SystemSettingsRepository
from app.services import scheduler_service, notify_service

URL_TASKS = "/admin/tasks"
URL_NOTIFY = "/admin/notify"


# ==================== 页面 ====================

class AdminTasksHandler(AdminBaseHandler):
    """定时任务管理页：框架壳，列表 / 弹层 / 日志由 tasks.js 走 /api/admin/tasks"""

    template_name = "admin/tasks.html"
    page_name = "定时任务"
    nav_url = URL_TASKS

    def get_context(self) -> dict:
        return {
            "task_types": TASK_TYPES,
            "schedule_types": {SCHEDULE_INTERVAL: "固定间隔", SCHEDULE_CRON: "Cron 表达式"},
            "notify_on": {"always": "总是通知", "fail": "仅失败通知", "never": "不通知"},
            "notify_channels": {"none": "不通知", "email": "邮件", "qq": "QQ", "both": "邮件+QQ"},
            "scheduler": scheduler_service.status(),
            "notify_status": notify_service.channels_status(),
        }


class AdminNotifyPageHandler(AdminBaseHandler):
    """通知配置页面（/admin/notify）：邮件 SMTP / QQ 机器人在线配置"""

    template_name = "admin/notify.html"
    page_name = "通知配置"
    nav_url = URL_NOTIFY


# ==================== 数据接口 ====================

def _validate_and_normalize(b: dict):
    """校验并归一任务字段；返回 (fields, error)。error 非空即校验失败"""
    name = (b.get("name") or "").strip()
    if not name or len(name) > 64:
        return None, "任务名称必填且不超过 64 字"
    task_type = (b.get("task_type") or "").strip()
    if task_type not in TASK_TYPES:
        return None, "任务类型非法"
    schedule_type = (b.get("schedule_type") or SCHEDULE_INTERVAL).strip()
    cron_expr = (b.get("cron_expr") or "").strip()
    if schedule_type == SCHEDULE_CRON:
        if not cron_expr:
            return None, "Cron 任务必须填写表达式"
    params = b.get("params")
    if isinstance(params, str):
        try:
            params = json.loads(params or "{}")
        except (ValueError, TypeError):
            params = {}
    fields = ScheduledTaskRepository.normalize(
        task_type, schedule_type, b.get("interval_seconds"), cron_expr,
        (b.get("notify_on") or "fail").strip(), (b.get("notify_channel") or "none").strip(),
        params if isinstance(params, dict) else {})
    return {"name": name, "description": (b.get("description") or "").strip(),
            "fields": fields, "enabled": b.get("enabled", 1)}, None


class AdminTasksApiHandler(AdminApiHandler):
    """GET /api/admin/tasks 列表 + 分页 + 搜索/启停过滤；POST 新增任务"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_TASKS):
            return
        page, keyword = self._page_args(self)
        status = (self.get_argument("status", "") or "").strip()
        data = ScheduledTaskRepository.paginate(keyword=keyword or None,
                                                status=status or None, page=page, limit=PAGE_SIZE)
        self.ok(scheduler=scheduler_service.status(), **data)

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_TASKS):
            return
        b = self.body()
        parsed, err = _validate_and_normalize(b)
        if err:
            self.fail(err)
            return
        if ScheduledTaskRepository.get_by_name(parsed["name"]):
            self.fail("任务名称已存在")
            return
        task_id = ScheduledTaskRepository.create(
            parsed["name"], parsed["fields"]["task_type"], parsed["description"],
            parsed["fields"], enabled=parsed["enabled"])
        scheduler_service.reload_jobs()
        self.ok(id=task_id)


class AdminTaskItemHandler(AdminApiHandler):
    """GET 任务详情；POST 更新；DELETE 删除"""

    @tornado.web.authenticated
    @backend_required
    def get(self, task_id):
        if not self.require_menu(URL_TASKS):
            return
        row = ScheduledTaskRepository.get_by_id(int(task_id))
        if not row:
            self.fail("任务不存在", status=404)
            return
        try:
            row["params"] = json.loads(row.get("params") or "{}")
        except (ValueError, TypeError):
            row["params"] = {}
        self.ok(row=row)

    @tornado.web.authenticated
    @backend_required
    def post(self, task_id):
        if not self.require_menu(URL_TASKS):
            return
        row = ScheduledTaskRepository.get_by_id(int(task_id))
        if not row:
            self.fail("任务不存在", status=404)
            return
        b = self.body()
        parsed, err = _validate_and_normalize(b)
        if err:
            self.fail(err)
            return
        dup = ScheduledTaskRepository.get_by_name(parsed["name"])
        if dup and dup["id"] != int(task_id):
            self.fail("任务名称已存在")
            return
        ScheduledTaskRepository.update(int(task_id), parsed["name"], parsed["description"],
                                       parsed["fields"], enabled=parsed["enabled"])
        scheduler_service.reload_jobs()
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, task_id):
        if not self.require_menu(URL_TASKS):
            return
        if not ScheduledTaskRepository.delete(int(task_id)):
            self.fail("任务不存在", status=404)
            return
        scheduler_service.reload_jobs()
        self.ok()


class AdminTaskToggleHandler(AdminApiHandler):
    """POST /api/admin/tasks/<id>/toggle 启停任务（缺省按取反）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, task_id):
        if not self.require_menu(URL_TASKS):
            return
        row = ScheduledTaskRepository.get_by_id(int(task_id))
        if not row:
            self.fail("任务不存在", status=404)
            return
        b = self.body()
        enabled = b.get("enabled")
        enabled = (1 if not row["enabled"] else 0) if enabled is None else (1 if enabled else 0)
        ScheduledTaskRepository.set_enabled(int(task_id), enabled)
        scheduler_service.reload_jobs()
        self.ok(enabled=enabled)


class AdminTaskRunHandler(AdminApiHandler):
    """POST /api/admin/tasks/<id>/run 手动触发一次（线程池执行，不卡 IOLoop）"""

    @tornado.web.authenticated
    @backend_required
    async def post(self, task_id):
        if not self.require_menu(URL_TASKS):
            return
        row = ScheduledTaskRepository.get_by_id(int(task_id))
        if not row:
            self.fail("任务不存在", status=404)
            return
        result = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, scheduler_service.execute_task, int(task_id), "manual")
        self.ok(result=result)


class AdminTaskLogsApiHandler(AdminApiHandler):
    """GET /api/admin/task-logs 任务执行流水分页（可按任务/状态过滤）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_TASKS):
            return
        page, _kw = self._page_args(self)
        try:
            task_id = int(self.get_argument("task_id", "0") or 0)
        except ValueError:
            task_id = 0
        status = (self.get_argument("status", "") or "").strip()
        data = TaskLogRepository.paginate(task_id=task_id or None, status=status or None,
                                          page=page, limit=PAGE_SIZE)
        self.ok(**data)


class AdminSchedulerStatusHandler(AdminApiHandler):
    """GET /api/admin/scheduler 调度器状态；POST 重启 / 重载调度器"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_TASKS):
            return
        self.ok(scheduler=scheduler_service.status())

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_TASKS):
            return
        b = self.body()
        action = (b.get("action") or "reload").strip()
        if action == "restart":
            st = scheduler_service.start()
        else:
            st = scheduler_service.reload_jobs()
        self.ok(scheduler=st)


class AdminNotifyTestHandler(AdminApiHandler):
    """POST /api/admin/notify/test 测试通知渠道（邮件 / QQ），返回可用性明细"""

    @tornado.web.authenticated
    @backend_required
    async def post(self):
        if not self.require_menu(URL_TASKS):
            return
        b = self.body()
        channel = (b.get("channel") or "email").strip()
        result = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, notify_service.notify, channel, "GovAgentOS 通知测试",
            "这是一条来自定时任务模块的通知测试消息。")
        self.ok(result=result, status=notify_service.channels_status())


# ==================== 通知配置（Web 页面在线配置） ====================

# 通知配置字段定义（key -> 显示名, 是否敏感）
NOTIFY_FIELDS = [
    ("notify_smtp_host", "SMTP 服务器", False),
    ("notify_smtp_port", "SMTP 端口", False),
    ("notify_smtp_user", "SMTP 账号", False),
    ("notify_smtp_password", "SMTP 密码/授权码", True),
    ("notify_smtp_ssl", "SSL (1/0)", False),
    ("notify_mail_from", "发件人邮箱", False),
    ("notify_mail_to", "收件人(逗号分隔)", False),
    ("notify_qq_webhook_url", "QQ 机器人 Webhook", False),
    ("notify_qq_smtp_user", "QQ 邮箱账号", False),
    ("notify_qq_smtp_password", "QQ 邮箱授权码", True),
    ("notify_qq_to", "QQ 收件人", False),
]


class AdminNotifyConfigHandler(AdminApiHandler):
    """GET /api/admin/notify/config 返回当前通知配置（密码字段脱敏）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_TASKS):
            return
        all_vals = SystemSettingsRepository.get_all()
        config_out = {}
        for key, label, sensitive in NOTIFY_FIELDS:
            val = all_vals.get(key, "")
            if sensitive and val:
                config_out[key] = "****"  # 密码不回传前端
            else:
                config_out[key] = val
        self.ok(config=config_out, fields=[
            {"key": k, "label": l, "sensitive": s} for k, l, s in NOTIFY_FIELDS
        ], status=notify_service.channels_status())


class AdminNotifyConfigSaveHandler(AdminApiHandler):
    """POST /api/admin/notify/config/save 保存通知配置到数据库"""

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_TASKS):
            return
        b = self.body()
        data = b.get("config") or {}
        # 只保存已知字段，忽略未知 key
        valid_keys = {k for k, _, _ in NOTIFY_FIELDS}
        to_save = {k: str(v) for k, v in data.items() if k in valid_keys and v != "****"}
        if to_save:
            SystemSettingsRepository.set_many(to_save)
        self.ok(status=notify_service.channels_status())
