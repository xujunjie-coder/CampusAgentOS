"""
app/services/scheduler_service.py —— 定时任务周期调度（成员 E，任务2 定时任务模块）

职责：
1. 装载 scheduled_tasks 表中启用的任务，按调度方式（interval / cron）周期执行；
2. 每次执行：登记 task_logs → 按 task_type 派发到内置处理函数（日志清理 / 自动归档）→
   回写任务运行状态 → 依通知策略推送邮件 / QQ；
3. 调度引擎「APScheduler 优先、缺失显式降级」——沿用项目人脸 / Crawl4AI 的一贯做法：
   - 装了 apscheduler：用 BackgroundScheduler（自带线程池，阻塞型任务不碰 IOLoop）；
   - 没装：降级为 tornado IOLoop 的 call_later + run_in_executor 轻量调度（仅支持 interval，
     cron 任务不自动排程但可手动触发），status()/接口显式标注 engine，不静默降级。

约定：execute_task 为同步阻塞函数，手动触发由控制层放线程池调度；调度器自身在独立线程 /
executor 中运行，绝不在 IOLoop 主线程里做阻塞 DB / 网络调用。
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional

import app.config as config
from app.models.session import now_str
from app.models.task import (
    SCHEDULE_CRON, SCHEDULE_INTERVAL, STATUS_FAILED, STATUS_SUCCESS,
    ScheduledTaskRepository, TaskLogRepository,
)

logger = logging.getLogger(__name__)

ENGINE_APSCHEDULER = "apscheduler"
ENGINE_TORNADO = "tornado"
ENGINE_DISABLED = "disabled"

_scheduler = None            # APScheduler BackgroundScheduler 实例
_started = False
_fallback_handles = {}       # task_id -> IOLoop timeout handle（降级引擎用）
_FALLBACK_TICK = 30          # 降级引擎轮询粒度（秒）：到点即触发到期任务
SCHEDULE_TIMEZONE = 'Asia/Shanghai'


def _try_import_apscheduler():
    try:
        from apscheduler.schedulers.background import BackgroundScheduler  # noqa: F401
        from apscheduler.triggers.cron import CronTrigger  # noqa: F401
        from apscheduler.triggers.interval import IntervalTrigger  # noqa: F401
        return True
    except Exception:
        return False


def detect_engine() -> str:
    """当前应使用的调度引擎（配置关闭=disabled；有 apscheduler=apscheduler；否则 tornado）"""
    if not config.SCHEDULER_ENABLED:
        return ENGINE_DISABLED
    return ENGINE_APSCHEDULER if _try_import_apscheduler() else ENGINE_TORNADO


def status() -> Dict:
    """调度器状态快照：引擎、是否已启动、apscheduler 是否可用、启用任务数、通知渠道可用性"""
    from app.services import notify_service

    engine = detect_engine()
    return {
        "engine": engine,
        "timezone": SCHEDULE_TIMEZONE,
        "apscheduler_available": _try_import_apscheduler(),
        "started": _started and engine != ENGINE_DISABLED,
        "enabled_tasks": ScheduledTaskRepository.count_enabled(),
        "notify": notify_service.channels_status(),
        "note": {
            ENGINE_APSCHEDULER: "APScheduler 后台线程调度，支持间隔与 cron。",
            ENGINE_TORNADO: "APScheduler 未安装，降级为 tornado 事件循环调度（仅间隔任务自动排程，"
                            "cron 任务可手动触发；如需 cron 请安装 apscheduler）。",
            ENGINE_DISABLED: "调度器已由 SCHEDULER_ENABLED=0 关闭，任务仅可手动触发。",
        }[engine],
    }


# ---------------- 内置任务处理函数 ----------------
def _run_log_cleanup(params: Dict) -> Dict:
    """日志清理：删除过旧的登录审计、任务流水，并清理已撤销 / 过期会话"""
    from app.models.session import LoginLogRepository, SessionRepository

    login_days = int(params.get("login_logs_days", 90) or 90)
    task_days = int(params.get("task_logs_days", 30) or 30)
    login_removed = LoginLogRepository.purge_before(login_days)
    sessions_removed = SessionRepository.purge_expired()
    # 任务流水单独清理（保留期由参数控制），放在最后避免清掉本次正在写的记录
    task_removed = TaskLogRepository.purge_before(task_days)
    result = "登录审计清理 %d 条，会话清理 %d 条，任务流水清理 %d 条" % (
        login_removed, sessions_removed, task_removed)
    return {"status": STATUS_SUCCESS, "result": result,
            "detail": json.dumps({"login_removed": login_removed,
                                  "sessions_removed": sessions_removed,
                                  "task_removed": task_removed}, ensure_ascii=False)}


def _run_auto_archive(params: Dict) -> Dict:
    """自动归档：把超过保留期的历史会话消息迁移到 message_archives"""
    from app.models.stats import MessageArchiveRepository

    keep_days = int(params.get("keep_days", 90) or 90)
    archived = MessageArchiveRepository.archive_before(keep_days)
    result = "归档历史会话 %d 条（保留最近 %d 天）" % (archived["archived"], keep_days)
    return {"status": STATUS_SUCCESS, "result": result,
            "detail": json.dumps(archived, ensure_ascii=False)}


_HANDLERS = {
    "log_cleanup": _run_log_cleanup,
    "auto_archive": _run_auto_archive,
}


def _run_qq_daily(params):
    from app.services.qq_daily_service import run_daily
    return run_daily(params)


_HANDLERS['qq_channel_daily'] = _run_qq_daily


def execute_task(task_id: int, trigger: str = "schedule") -> Dict:
    """执行一个任务（同步阻塞）：写流水 → 派发处理 → 回写状态 → 依策略通知。

    返回 {ok, status, result, notify}；任务不存在 / 类型未实现时按失败处理并留痕。
    """
    task = ScheduledTaskRepository.get_by_id(task_id)
    if not task:
        return {"ok": False, "status": STATUS_FAILED, "result": "任务不存在：%s" % task_id}

    log_id = TaskLogRepository.start(task, trigger)
    handler = _HANDLERS.get(task["task_type"])
    try:
        params = json.loads(task.get("params") or "{}")
    except (TypeError, ValueError):
        params = {}

    if handler is None:
        outcome = {"status": STATUS_FAILED,
                   "result": "未实现的任务类型：%s" % task["task_type"], "detail": ""}
    else:
        try:
            outcome = handler(params)
        except Exception as exc:  # 处理函数异常不外泄堆栈给前端，只留可读原因
            logger.exception("定时任务执行异常 task=%s", task["name"])
            outcome = {"status": STATUS_FAILED, "result": "执行异常", "detail": str(exc)[:500]}

    notify_result = _maybe_notify(task, outcome, trigger)
    if task['task_type']=='qq_channel_daily' and not notify_result.get('skipped') and not notify_result.get('ok'):
        outcome['status']=STATUS_FAILED
        outcome['result']=outcome.get('result','')+'；日报投递失败，请检查通知配置和任务日志'
    if task['task_type']=='qq_channel_daily':
        try:
            detail=json.loads(outcome.get('detail') or '{}')
        except ValueError:
            detail={'error':outcome.get('detail','')}
        detail['notification']={key:notify_result.get(key) for key in ('ok','skipped','degraded')}
        outcome['detail']=json.dumps(detail,ensure_ascii=False)
    started_at = now_str()
    TaskLogRepository.finish(log_id, outcome["status"], outcome.get("result", ""),
                             outcome.get("detail", ""))
    ScheduledTaskRepository.mark_run(task_id, started_at, outcome["status"],
                                     next_run_at=_next_run_text(task))

    return {"ok": outcome["status"] == STATUS_SUCCESS, "status": outcome["status"],
            "result": outcome.get("result", ""), "log_id": log_id, "notify": notify_result}


def _maybe_notify(task: Dict, outcome: Dict, trigger: str) -> Dict:
    """按任务通知策略决定是否推送：never 不推；fail 仅失败推；always 总是推"""
    from app.services import notify_service

    notify_on = task.get("notify_on") or "fail"
    channel = task.get("notify_channel") or "none"
    if notify_on == "never" or channel == "none":
        return {"skipped": True, "reason": "通知策略为 never 或渠道为 none"}
    if notify_on == "fail" and outcome["status"] == STATUS_SUCCESS:
        return {"skipped": True, "reason": "任务成功且策略为仅失败通知"}
    if outcome.get('notify_body'):
        report={'subject':outcome['notify_subject'],'body':outcome['notify_body']}
    else:
        report = notify_service.build_task_report(
            task, outcome["status"], outcome.get("result", ""), outcome.get("detail", ""))
    return notify_service.notify(channel, report["subject"], report["body"])


def _next_run_text(task: Dict) -> str:
    """估算下次运行时间文本（interval 精确；cron 交由 apscheduler 计算，这里给近似值）"""
    if task.get("schedule_type") == SCHEDULE_INTERVAL and task.get("interval_seconds"):
        return now_str(datetime.now() + timedelta(seconds=int(task["interval_seconds"])))
    if task.get('schedule_type') == SCHEDULE_CRON and _try_import_apscheduler():
        from apscheduler.triggers.cron import CronTrigger
        from zoneinfo import ZoneInfo
        try:
            stamp=datetime.now(ZoneInfo(SCHEDULE_TIMEZONE))
            return now_str(CronTrigger.from_crontab(task['cron_expr'],timezone=SCHEDULE_TIMEZONE).get_next_fire_time(None,stamp))
        except (ValueError,TypeError):
            return ''
    return ""


# ---------------- 装载 / 启停 ----------------
def start() -> Dict:
    """启动调度器（make_app 末尾调用）；配置关闭则跳过"""
    global _started, _scheduler
    engine = detect_engine()
    if engine == ENGINE_DISABLED:
        logger.info("定时任务调度器已关闭（SCHEDULER_ENABLED=0）")
        return status()
    stop()
    if engine == ENGINE_APSCHEDULER:
        _start_apscheduler()
    else:
        _start_tornado_fallback()
    _started = True
    logger.info("定时任务调度器已启动：engine=%s tasks=%d", engine,
                ScheduledTaskRepository.count_enabled())
    return status()


def stop() -> None:
    """停止调度器（幂等）"""
    global _started, _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:
            pass
        _scheduler = None
    for handle in list(_fallback_handles.values()):
        _cancel_handle(handle)
    _fallback_handles.clear()
    _started = False


def reload_jobs() -> Dict:
    """任务配置变更后重新装载（后台 CRUD 后调用）"""
    global _started
    if not _started:
        return status()
    engine = detect_engine()
    if engine == ENGINE_APSCHEDULER:
        _start_apscheduler()  # replace_existing 语义：重建作业
    elif engine == ENGINE_TORNADO:
        stop()
        _start_tornado_fallback()
        _started = True
    return status()


def _start_apscheduler() -> None:
    global _scheduler
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:
            pass
    _scheduler = BackgroundScheduler(daemon=True,timezone=SCHEDULE_TIMEZONE)
    for task in ScheduledTaskRepository.get_all(enabled_only=True):
        if task["schedule_type"] == SCHEDULE_CRON and task["cron_expr"]:
            try:
                trigger = CronTrigger.from_crontab(task["cron_expr"],timezone=SCHEDULE_TIMEZONE)
            except Exception:
                logger.warning("cron 表达式非法，跳过自动排程 task=%s expr=%r",
                               task["name"], task["cron_expr"])
                continue
        else:
            trigger = IntervalTrigger(seconds=int(task["interval_seconds"] or 3600))
        _scheduler.add_job(lambda tid=task["id"]: execute_task(tid, "schedule"),
                           trigger, id="task_%s" % task["id"], replace_existing=True,
                           max_instances=1, coalesce=True)
    _scheduler.start()
    for job in _scheduler.get_jobs():
        ScheduledTaskRepository.set_next_run(int(job.id.removeprefix('task_')),now_str(job.next_run_time))


def _start_tornado_fallback() -> None:
    """降级引擎：用 IOLoop 定时 tick 扫描到期任务，阻塞执行放 executor"""
    import tornado.ioloop

    for task in ScheduledTaskRepository.get_all(enabled_only=True):
        if task["schedule_type"] == SCHEDULE_CRON:
            continue  # 降级引擎不支持 cron，仅手动触发
        _schedule_interval(task["id"], int(task["interval_seconds"] or 3600))
    # 统一 tick 仅用于日志（真正触发靠每个 interval 的 call_later），此处不额外注册
    tornado.ioloop.IOLoop.current()


def _schedule_interval(task_id: int, seconds: int) -> None:
    import tornado.ioloop

    loop = tornado.ioloop.IOLoop.current()
    deadline = loop.time() + max(1, seconds)

    def _fire():
        # 阻塞执行放线程池，避免卡住 IOLoop；完成后重新登记下一轮
        future = loop.run_in_executor(None, execute_task, task_id, "schedule")
        future.add_done_callback(lambda _f: _reschedule(task_id, seconds))
        _fallback_handles[task_id] = None

    def _reschedule(tid, sec):
        task = ScheduledTaskRepository.get_by_id(tid)
        if task and task["enabled"]:
            _schedule_interval(tid, int(task["interval_seconds"] or sec))

    _fallback_handles[task_id] = loop.call_at(deadline, _fire)


def _cancel_handle(handle) -> None:
    if not handle:
        return
    try:
        import tornado.ioloop

        tornado.ioloop.IOLoop.current().remove_timeout(handle)
    except Exception:
        pass
