"""
模型 Token 统计 Model(Repository 模式) —— 任务8.1
把对 model_token_logs 表的所有 SQL 收拢到 TokenStatsRepository，上层不直接拼 SQL。

每次真实调用模型（后台对话/向量/图片测试、前台智能体对话）成功后落一条流水，
橱窗卡片与统计图表都由这张表聚合得出：
- 卡片反馈：paginate 时子查询带出各模型的 call_count / token_total（零新增列）
- 图形化：近 N 日按天趋势（输入/输出分列）+ 按模型排行，供控制层统计接口消费
- 聚合列全平台共享，模型增删不影响流水（engine_id 允许指向已删除模型，查询按 LEFT JOIN 兜底）
"""

from typing import Dict, List, Optional

from app.models import db
from app.models.db import Error, get_connection

# 调用来源：model_test=后台模型橱窗测试入口，chat=前台智能体对话
TOKEN_KINDS = {"model_test": "模型测试", "chat": "智能体对话"}


class TokenStatsRepository:

    @staticmethod
    def record(engine_id: int, kind: str, prompt_tokens: int, completion_tokens: int,
               total_tokens: int, username: str = "") -> Optional[int]:
        """落一条 token 流水；数值做非负兜底，合计缺失时用 输入+输出"""
        try:
            p = max(0, int(prompt_tokens or 0))
            c = max(0, int(completion_tokens or 0))
            t = max(0, int(total_tokens or 0)) or (p + c)
            if t <= 0:
                return None
            with get_connection() as conn:
                cur = conn.execute(
                    "INSERT INTO model_token_logs (engine_id, kind, prompt_tokens, completion_tokens, total_tokens, username) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (engine_id, kind if kind in TOKEN_KINDS else "model_test", p, c, t, username or ""))
                return cur.lastrowid
        except Error:
            return None  # 统计落库失败不影响主链路

    @staticmethod
    def stats_by_engine() -> Dict[int, Dict]:
        """按模型聚合 {engine_id: {call_count, token_total, prompt_total, completion_total}}（全时段）"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT engine_id, COUNT(*) AS call_count, SUM(total_tokens) AS token_total, "
                "SUM(prompt_tokens) AS prompt_total, SUM(completion_tokens) AS completion_total "
                "FROM model_token_logs GROUP BY engine_id").fetchall()
            return {r["engine_id"]: {
                "call_count": r["call_count"] or 0,
                "token_total": r["token_total"] or 0,
                "prompt_total": r["prompt_total"] or 0,
                "completion_total": r["completion_total"] or 0,
            } for r in rows}

    @staticmethod
    def summary() -> Dict:
        """全局汇总：调用次数 / 输入 / 输出 / 合计 token"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS call_count, COALESCE(SUM(prompt_tokens),0) AS prompt_total, "
                "COALESCE(SUM(completion_tokens),0) AS completion_total, COALESCE(SUM(total_tokens),0) AS token_total "
                "FROM model_token_logs").fetchone()
            return dict(row)

    @staticmethod
    def daily_trend(days: int = 14) -> List[Dict]:
        """近 N 天按天趋势（含 0 值日补齐，图表不缺列）：[{date, prompt, completion, total, calls}]

        任务14：日期骨架改在 Python 侧生成，聚合用 substr(created_at,1,10) + created_at >= ?
        —— 避免 SQLite 的 date('now','localtime')/WITH RECURSIVE 在 MySQL 5.7 上不可用
        （5.7 不支持 CTE），同时不依赖 ONLY_FULL_GROUP_BY 的宽松模式。
        """
        from datetime import date, timedelta

        days = max(1, min(int(days or 14), 90))
        start_day = date.today() - timedelta(days=days - 1)
        start_at = start_day.strftime("%Y-%m-%d 00:00:00")
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT substr(created_at, 1, 10) AS d, SUM(prompt_tokens) AS prompt, "
                "SUM(completion_tokens) AS completion, SUM(total_tokens) AS total, COUNT(*) AS calls "
                "FROM model_token_logs WHERE created_at >= ? "
                "GROUP BY substr(created_at, 1, 10) ORDER BY d", (start_at,)).fetchall()
        by_day = {r["d"]: dict(r) for r in rows}
        out = []
        for i in range(days):
            day = (start_day + timedelta(days=i)).strftime("%Y-%m-%d")
            item = by_day.get(day) or {}
            out.append({"date": day, "prompt": item.get("prompt") or 0,
                        "completion": item.get("completion") or 0,
                        "total": item.get("total") or 0, "calls": item.get("calls") or 0})
        return out

    @staticmethod
    def model_ranking(limit: int = 8) -> List[Dict]:
        """按模型 token 排行（橱窗/图表主数据），LEFT JOIN 兜底已删除模型"""
        # 字符串拼接语法按方言切换：SQLite 用 ||，MySQL 用 CONCAT（MySQL 的 || 是逻辑或）
        if db.DB_DRIVER == "mysql":
            fallback = "CONCAT('（已删除模型 #', l.engine_id, '）')"
        else:
            fallback = "'（已删除模型 #' || l.engine_id || '）'"
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT l.engine_id, COALESCE(e.name, " + fallback + ") AS name, "
                "COALESCE(e.type, '') AS type, COUNT(*) AS call_count, "
                "SUM(l.total_tokens) AS token_total, SUM(l.prompt_tokens) AS prompt_total, "
                "SUM(l.completion_tokens) AS completion_total "
                "FROM model_token_logs l LEFT JOIN model_engines e ON e.id = l.engine_id "
                # GROUP BY 带上 e.name/e.type：MySQL 的 ONLY_FULL_GROUP_BY 要求非聚合列完整出现
                "GROUP BY l.engine_id, e.name, e.type ORDER BY token_total DESC LIMIT ?",
                (limit,)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def recent_logs(engine_id: int = None, limit: int = 10) -> List[Dict]:
        """最近调用明细（可按模型过滤），供统计弹层列表"""
        limit = max(1, min(int(limit or 10), 50))
        with get_connection() as conn:
            if engine_id:
                rows = conn.execute(
                    "SELECT l.id, l.engine_id, COALESCE(e.name, '（已删除模型）') AS name, l.kind, "
                    "l.prompt_tokens, l.completion_tokens, l.total_tokens, l.username, l.created_at "
                    "FROM model_token_logs l LEFT JOIN model_engines e ON e.id = l.engine_id "
                    "WHERE l.engine_id = ? ORDER BY l.id DESC LIMIT ?", (engine_id, limit)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT l.id, l.engine_id, COALESCE(e.name, '（已删除模型）') AS name, l.kind, "
                    "l.prompt_tokens, l.completion_tokens, l.total_tokens, l.username, l.created_at "
                    "FROM model_token_logs l LEFT JOIN model_engines e ON e.id = l.engine_id "
                    "ORDER BY l.id DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def delete_by_engine(engine_id: int) -> int:
        """删除模型时清理其流水（保持统计口径与橱窗一致）"""
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM model_token_logs WHERE engine_id = ?", (engine_id,))
            return cur.rowcount