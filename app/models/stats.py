"""
数据统计与会话归档 Model(Repository 模式) —— 成员 E

两块职责：
1. StatsRepository —— 面向「数智大屏 / 统计报表」（成员 C 消费）的只读聚合查询：
   总览计数、按天趋势、按信源分布、按风险等级分布、高频关键词。全部走参数化 SQL，
   日期骨架在 Python 侧生成（MySQL 5.7 不支持 CTE，SQLite 的 date('now') 也不同源），
   与 token_stats.daily_trend 保持同一套跨库写法。
2. MessageArchiveRepository —— 历史会话「自动归档」落地表 message_archives 的读写：
   把超过保留期的 messages 迁移到归档表，主表保持轻量，归档数据仍可追溯。

约定：时间统一 'YYYY-MM-DD HH:MM:SS' 文本；所有方法 @staticmethod；聚合列 COALESCE 兜底 0。
"""

from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from app.models.db import get_connection
from app.models.session import TIME_FMT, now_str

# 舆情风险等级（与 intelligence_service 输出口径一致）
RISK_LEVELS = ("high", "watch", "normal", "error")
RISK_LABELS = {"high": "高风险", "watch": "关注", "normal": "常规", "error": "待重试"}


def _day_series(days: int) -> List[str]:
    """生成含今天的最近 N 天日期字符串列表（升序）"""
    days = max(1, min(int(days or 14), 90))
    start = date.today() - timedelta(days=days - 1)
    return [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]


def _start_at(days: int) -> str:
    days = max(1, min(int(days or 14), 90))
    return (date.today() - timedelta(days=days - 1)).strftime("%Y-%m-%d 00:00:00")


def _count(conn, table: str, where: str = "", params=None) -> int:
    sql = "SELECT COUNT(*) AS c FROM %s" % table
    if where:
        sql += " " + where
    return int(conn.execute(sql, params or ()).fetchone()["c"])


class StatsRepository:
    """只读统计聚合，供大屏 / 报表接口消费"""

    @staticmethod
    def overview() -> Dict:
        """总览计数：用户 / 在线会话 / 消息 / 采集 / 数仓 / token / 风险 / 任务"""
        from app.models.task import ScheduledTaskRepository
        from app.models.token_stats import TokenStatsRepository
        from app.models.warehouse import WarehouseRepository
        from app.models.session import SessionRepository

        with get_connection() as conn:
            users = _count(conn, "users")
            messages = _count(conn, "messages")
            collect = _count(conn, "collect_items")
            collect_today = _count(conn, "collect_items", "WHERE collected_at >= ?",
                                   (date.today().strftime("%Y-%m-%d 00:00:00"),))
            risk_rows = conn.execute(
                "SELECT level, COUNT(*) AS c FROM risk_reviews GROUP BY level").fetchall()
        risk = {lv: 0 for lv in RISK_LEVELS}
        for r in risk_rows:
            risk[r["level"]] = risk.get(r["level"], 0) + int(r["c"])
        token = TokenStatsRepository.summary()
        warehouse = WarehouseRepository.count_by_status()
        return {
            "users": users,
            "active_sessions": len(SessionRepository.list_active()),
            "messages": messages,
            "collect_total": collect,
            "collect_today": collect_today,
            "warehouse": warehouse,
            "token": {
                "call_count": int(token.get("call_count") or 0),
                "token_total": int(token.get("token_total") or 0),
            },
            "risk": {"counts": risk, "labels": RISK_LABELS},
            "tasks_enabled": ScheduledTaskRepository.count_enabled(),
        }

    @staticmethod
    def daily_trend(days: int = 14) -> List[Dict]:
        """近 N 天按天趋势：采集条目 / 会话消息 / token 用量三线合一（含 0 值日补齐）"""
        from app.models.token_stats import TokenStatsRepository

        days = max(1, min(int(days or 14), 90))
        start = _start_at(days)
        series = _day_series(days)
        with get_connection() as conn:
            collect_rows = conn.execute(
                "SELECT substr(collected_at, 1, 10) AS d, COUNT(*) AS c FROM collect_items "
                "WHERE collected_at >= ? GROUP BY substr(collected_at, 1, 10)", (start,)).fetchall()
            msg_rows = conn.execute(
                "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c FROM messages "
                "WHERE created_at >= ? GROUP BY substr(created_at, 1, 10)", (start,)).fetchall()
        collect_by = {r["d"]: int(r["c"]) for r in collect_rows}
        msg_by = {r["d"]: int(r["c"]) for r in msg_rows}
        token_by = {t["date"]: t for t in TokenStatsRepository.daily_trend(days)}
        out = []
        for day in series:
            tk = token_by.get(day, {})
            out.append({
                "date": day,
                "collect": collect_by.get(day, 0),
                "messages": msg_by.get(day, 0),
                "tokens": int(tk.get("total") or 0),
            })
        return out

    @staticmethod
    def by_source(limit: int = 10) -> List[Dict]:
        """按信源统计采集条目数（大屏地图 / 排行），倒序取前 N"""
        limit = max(1, min(int(limit or 10), 50))
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT source_id, source_name, COUNT(*) AS c FROM collect_items "
                "GROUP BY source_id, source_name ORDER BY c DESC LIMIT ?", (limit,)).fetchall()
        return [{"source_id": r["source_id"], "source_name": r["source_name"] or "（未知信源）",
                 "count": int(r["c"])} for r in rows]

    @staticmethod
    def by_risk() -> List[Dict]:
        """风险等级分布（舆情预警饼图）：固定四类，缺失补 0"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT level, COUNT(*) AS c FROM risk_reviews GROUP BY level").fetchall()
        counts = {lv: 0 for lv in RISK_LEVELS}
        for r in rows:
            counts[r["level"]] = counts.get(r["level"], 0) + int(r["c"])
        return [{"level": lv, "label": RISK_LABELS.get(lv, lv), "count": counts[lv]}
                for lv in RISK_LEVELS]

    @staticmethod
    def top_keywords(limit: int = 12) -> List[Dict]:
        """高频采集关键词（大屏词云 / 热词榜）"""
        limit = max(1, min(int(limit or 12), 50))
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT keyword, COUNT(*) AS c FROM collect_items "
                "WHERE keyword IS NOT NULL AND keyword <> '' "
                "GROUP BY keyword ORDER BY c DESC LIMIT ?", (limit,)).fetchall()
        return [{"keyword": r["keyword"], "count": int(r["c"])} for r in rows]


class MessageArchiveRepository:
    """历史会话归档：把过期消息从 messages 迁移到 message_archives，主表保持轻量"""

    _COLS = ("id, origin_id, username, session_id, role, content, employee_id, employee_name, "
             "is_partial, origin_created_at, archived_at")

    @staticmethod
    def archive_before(keep_days: int = 90) -> Dict:
        """把 created_at 早于 (今天 - keep_days) 的消息整体迁移到归档表并删除原行。
        返回 {archived: 迁移条数, cutoff: 截止时间}。SQLite / MySQL 均用「先查后删」保证可移植。"""
        keep_days = max(1, int(keep_days or 90))
        cutoff = now_str(datetime.now() - timedelta(days=keep_days))
        archived_at = now_str()
        with get_connection() as conn:
            if conn.driver == "sqlite":
                conn.execute("BEGIN IMMEDIATE")
            lock_rows = " FOR UPDATE" if conn.driver == "mysql" else ""
            rows = conn.execute(
                "SELECT id, username, session_id, role, content, employee_id, employee_name, "
                "is_partial, created_at FROM messages WHERE created_at < ? ORDER BY id" + lock_rows,
                (cutoff,)).fetchall()
            if not rows:
                return {"archived": 0, "cutoff": cutoff}
            conn.executemany(
                "INSERT INTO message_archives (origin_id, username, session_id, role, content, "
                "employee_id, employee_name, is_partial, origin_created_at, archived_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(r["id"], r["username"], r["session_id"], r["role"], r["content"],
                  int(r["employee_id"] or 0), r["employee_name"] or "",
                  int(r["is_partial"] or 0), r["created_at"], archived_at) for r in rows])
            ids = [r["id"] for r in rows]
            placeholders = ",".join("?" for _ in ids)
            conn.execute("DELETE FROM messages WHERE id IN (%s)" % placeholders, ids)
        return {"archived": len(rows), "cutoff": cutoff}

    @staticmethod
    def count() -> int:
        with get_connection() as conn:
            return int(conn.execute("SELECT COUNT(*) AS c FROM message_archives").fetchone()["c"])

    @staticmethod
    def paginate(username: str = None, session_id: str = None,
                 start_at: str = None, end_at: str = None,
                 role: str = None, keyword: str = None,
                 page: int = 1, limit: int = 20) -> Dict:
        """归档记录分页（追溯历史会话）。
        筛选：username / session_id 精准或模糊；role 精准；start_at/end_at 按 origin_created_at 闭区间；
        keyword 走 content LIKE。倒序（最新归档优先）。"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if username:
            where.append("username LIKE ?")
            params.append("%{}%".format(username))
        if session_id:
            where.append("session_id LIKE ?")
            params.append("%{}%".format(session_id))
        if role:
            where.append("role = ?")
            params.append(role)
        if start_at:
            where.append("origin_created_at >= ?")
            params.append(start_at)
        if end_at:
            where.append("origin_created_at <= ?")
            params.append(end_at)
        if keyword:
            where.append("content LIKE ?")
            params.append("%{}%".format(keyword))
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM message_archives" + clause, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM message_archives".format(MessageArchiveRepository._COLS) + clause
                + " ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}
