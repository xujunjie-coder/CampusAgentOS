"""
定时任务与任务执行日志 Model(Repository 模式) —— 成员 E（任务2 定时任务模块）

把对 scheduled_tasks（周期任务配置）与 task_logs（任务执行流水）两张表的所有 SQL 收拢到这里，
上层 Controller / Service 只调用静态方法，不直接拼 SQL，保持与 SourceRepository / WarehouseRepository
一致的 Repository 分层风格。

设计约定：
- scheduled_tasks 描述「一个周期任务怎么跑」：调度方式（interval 间隔 / cron 表达式）、启停、
  通知策略（成功/失败/总是/从不 × 邮件/QQ/两者/不通知）、上次与下次运行时间、上次结果状态。
- task_logs 描述「某一次运行发生了什么」：触发方式（schedule 调度 / manual 手动）、状态、
  起止时间、耗时、结果摘要与详情。归档与清理都靠时间字段判定，可重复执行。
- 时间统一存 'YYYY-MM-DD HH:MM:SS' 文本（与 session.py 一致），SQLite / MySQL 的 DATETIME 可直接比较，
  方言差异由任务14 的连接层消化，这里只写参数化 SQL。
- 所有方法 @staticmethod。
"""

import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from app.models.db import get_connection
from app.models.session import TIME_FMT, now_str

# 后台列表分页：20 条/页（与用户管理等后台模块一致）
PAGE_SIZE = 20

# 内置任务类型：scheduler_service 按 task_type 派发到对应处理函数
# log_cleanup=日志清理（登录审计/过期会话/任务流水）；auto_archive=历史会话自动归档
TASK_TYPES = {
    "log_cleanup": "日志清理",
    "auto_archive": "自动归档",
}

# 调度方式
SCHEDULE_INTERVAL = "interval"
SCHEDULE_CRON = "cron"

# 通知时机 / 通知渠道
NOTIFY_ON = ("always", "fail", "never")
NOTIFY_CHANNELS = ("none", "email", "qq", "both")

# 任务运行状态
STATUS_RUNNING = "running"
STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class ScheduledTaskRepository:
    """周期任务配置：CRUD + 启停 + 运行状态回写"""

    _COLS = ("id, name, task_type, description, params, schedule_type, interval_seconds, "
             "cron_expr, enabled, notify_on, notify_channel, last_run_at, next_run_at, "
             "last_status, created_at, updated_at")

    @staticmethod
    def normalize(task_type: str, schedule_type: str, interval_seconds, cron_expr: str,
                  notify_on: str, notify_channel: str, params) -> Dict:
        """把外部传入的字段收敛为合法值（非法即回退默认），供 create/update 复用"""
        schedule_type = schedule_type if schedule_type in (SCHEDULE_INTERVAL, SCHEDULE_CRON) else SCHEDULE_INTERVAL
        interval = _to_int(interval_seconds, 0)
        if schedule_type == SCHEDULE_INTERVAL and interval < 10:
            interval = 3600  # 间隔任务下限保护：最短 10 秒，缺省给 1 小时
        return {
            "task_type": task_type if task_type in TASK_TYPES else "log_cleanup",
            "schedule_type": schedule_type,
            "interval_seconds": interval,
            "cron_expr": (cron_expr or "").strip()[:120],
            "notify_on": notify_on if notify_on in NOTIFY_ON else "fail",
            "notify_channel": notify_channel if notify_channel in NOTIFY_CHANNELS else "none",
            "params": json.dumps(params if isinstance(params, dict) else {}, ensure_ascii=False),
        }

    @staticmethod
    def create(name: str, task_type: str, description: str, fields: Dict,
               enabled: int = 1) -> int:
        """新增任务；fields 为 normalize 后的字典。返回新任务 id"""
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO scheduled_tasks (name, task_type, description, params, schedule_type, "
                "interval_seconds, cron_expr, enabled, notify_on, notify_channel, last_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')",
                (name[:64], fields["task_type"], (description or "")[:255], fields["params"],
                 fields["schedule_type"], fields["interval_seconds"], fields["cron_expr"],
                 1 if enabled else 0, fields["notify_on"], fields["notify_channel"]))
            return cur.lastrowid

    @staticmethod
    def update(task_id: int, name: str, description: str, fields: Dict,
               enabled: Optional[int] = None) -> bool:
        """更新任务；enabled 传 None 表示不改启停。刷新 updated_at"""
        sets = ["name = ?", "description = ?", "params = ?", "schedule_type = ?",
                "interval_seconds = ?", "cron_expr = ?", "notify_on = ?", "notify_channel = ?",
                "task_type = ?"]
        params = [name[:64], (description or "")[:255], fields["params"], fields["schedule_type"],
                  fields["interval_seconds"], fields["cron_expr"], fields["notify_on"],
                  fields["notify_channel"], fields["task_type"]]
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        params.append(int(task_id))
        with get_connection() as conn:
            conn.execute(
                "UPDATE scheduled_tasks SET {}, updated_at = datetime('now', 'localtime') "
                "WHERE id = ?".format(", ".join(sets)), params)
        return True

    @staticmethod
    def delete(task_id: int) -> bool:
        """删除任务配置（执行流水保留，task_logs.task_id 允许指向已删除任务）"""
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM scheduled_tasks WHERE id = ?", (int(task_id),))
        return cur.rowcount > 0

    @staticmethod
    def set_enabled(task_id: int, enabled: int) -> bool:
        with get_connection() as conn:
            conn.execute(
                "UPDATE scheduled_tasks SET enabled = ?, "
                "updated_at = datetime('now', 'localtime') WHERE id = ?",
                (1 if enabled else 0, int(task_id)))
        return True

    @staticmethod
    def get_by_id(task_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM scheduled_tasks WHERE id = ?".format(
                    ScheduledTaskRepository._COLS), (int(task_id),)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def get_by_name(name: str) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM scheduled_tasks WHERE name = ?".format(
                    ScheduledTaskRepository._COLS), (name,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def get_all(enabled_only: bool = False) -> List[Dict]:
        """全量任务（供调度器装载）；enabled_only=True 只取启用的"""
        sql = "SELECT {} FROM scheduled_tasks".format(ScheduledTaskRepository._COLS)
        if enabled_only:
            sql += " WHERE enabled = 1"
        sql += " ORDER BY id"
        with get_connection() as conn:
            return [dict(r) for r in conn.execute(sql).fetchall()]

    @staticmethod
    def paginate(keyword: str = None, status: str = None, page: int = 1,
                 limit: int = PAGE_SIZE) -> Dict:
        """后台分页：名称/描述/类型模糊搜索 + 启停过滤（on/off），返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(name LIKE ? OR description LIKE ? OR task_type LIKE ?)")
            params += ["%{}%".format(keyword)] * 3
        if status == "on":
            where.append("enabled = 1")
        elif status == "off":
            where.append("enabled = 0")
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM scheduled_tasks {}".format(clause), params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM scheduled_tasks {} ORDER BY id DESC LIMIT ? OFFSET ?".format(
                    ScheduledTaskRepository._COLS, clause), params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def mark_run(task_id: int, started_at: str, status: str, next_run_at: str = "") -> None:
        """一次运行结束后回写：上次运行时间、上次状态、下次运行时间（next 为空则不动）"""
        sets = ["last_run_at = ?", "last_status = ?"]
        params = [started_at, status]
        if next_run_at:
            sets.append("next_run_at = ?")
            params.append(next_run_at)
        params.append(int(task_id))
        with get_connection() as conn:
            conn.execute(
                "UPDATE scheduled_tasks SET {}, updated_at = datetime('now', 'localtime') "
                "WHERE id = ?".format(", ".join(sets)), params)

    @staticmethod
    def count_enabled() -> int:
        with get_connection() as conn:
            return conn.execute(
                "SELECT COUNT(*) AS c FROM scheduled_tasks WHERE enabled = 1").fetchone()["c"]


class TaskLogRepository:
    """任务执行流水：开始 / 结束 / 分页 / 清理"""

    @staticmethod
    def start(task: Dict, trigger: str) -> int:
        """登记一次运行（状态 running），返回流水 id"""
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO task_logs (task_id, task_name, task_type, `trigger`, status, started_at, "
                "result, detail) VALUES (?, ?, ?, ?, ?, ?, '', '')",
                (task["id"], task["name"], task["task_type"],
                 "manual" if trigger == "manual" else "schedule", STATUS_RUNNING, now_str()))
            return cur.lastrowid

    @staticmethod
    def finish(log_id: int, status: str, result: str = "", detail: str = "") -> None:
        """结束一次运行：写状态、结果摘要、详情与耗时"""
        finished = now_str()
        with get_connection() as conn:
            row = conn.execute("SELECT started_at FROM task_logs WHERE id = ?",
                               (int(log_id),)).fetchone()
            duration = 0
            if row:
                try:
                    duration = int((datetime.strptime(finished, TIME_FMT)
                                    - datetime.strptime(row["started_at"], TIME_FMT)).total_seconds() * 1000)
                except (TypeError, ValueError):
                    duration = 0
            conn.execute(
                "UPDATE task_logs SET status = ?, finished_at = ?, duration_ms = ?, result = ?, detail = ? "
                "WHERE id = ?",
                (status, finished, max(0, duration), (result or "")[:500], (detail or "")[:2000],
                 int(log_id)))

    @staticmethod
    def paginate(task_id: int = None, status: str = None, page: int = 1,
                 limit: int = PAGE_SIZE) -> Dict:
        """流水分页：可按任务与状态过滤，倒序返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if task_id:
            where.append("task_id = ?")
            params.append(int(task_id))
        if status in (STATUS_SUCCESS, STATUS_FAILED, STATUS_RUNNING):
            where.append("status = ?")
            params.append(status)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM task_logs" + clause, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT id, task_id, task_name, task_type, `trigger`, status, started_at, finished_at, "
                "duration_ms, result, created_at FROM task_logs" + clause
                + " ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def latest(limit: int = 10) -> List[Dict]:
        """最近若干条流水（工作台/大屏概览用）"""
        limit = max(1, min(int(limit or 10), 100))
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT id, task_id, task_name, task_type, `trigger`, status, started_at, finished_at, "
                "duration_ms, result FROM task_logs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def purge_before(keep_days: int = 30) -> int:
        """清理过旧流水（默认保留 30 天），返回删除条数"""
        cutoff = now_str(datetime.now() - timedelta(days=max(1, int(keep_days))))
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM task_logs WHERE created_at < ?", (cutoff,))
        return cur.rowcount
