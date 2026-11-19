"""
智能问数报告 Model(Repository模式) —— 成员 D（任务1：智能问数）
把对 qa_reports 表的所有 SQL 收拢到 QaRepository：
- save：一次问数产出的报告落库（report 为 JSON 字符串）
- list_recent / get：按用户隔离的历史查询（用户只能看自己的问数记录）
用户隔离约束与 MessageRepository 相同：读写都带 username 条件。
"""

import json
from typing import Dict, List, Optional

from app.models.db import get_connection


class QaRepository:
    @staticmethod
    def save(username: str, question: str, employee_id: int, employee_name: str,
             report: Dict, source: str) -> int:
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO qa_reports (username, question, employee_id, employee_name, report, source)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (username, question[:500], int(employee_id or 0), employee_name or "",
                 json.dumps(report, ensure_ascii=False), source))
            return cur.lastrowid

    @staticmethod
    def list_recent(username: str, limit: int = 20) -> List[Dict]:
        limit = max(1, min(int(limit), 100))
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT id, question, employee_id, employee_name, source, created_at,"
                " substr(question, 1, 60) AS title"
                " FROM qa_reports WHERE username = ? ORDER BY id DESC LIMIT ?",
                (username, limit)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get(username: str, report_id: int) -> Optional[Dict]:
        """按 id 取单条完整报告（带用户隔离：查别人的行等于不存在）"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id, question, employee_id, employee_name, report, source, created_at"
                " FROM qa_reports WHERE username = ? AND id = ?",
                (username, int(report_id))).fetchone()
            if not row:
                return None
            out = dict(row)
            try:
                out["report"] = json.loads(out["report"] or "{}")
            except ValueError:
                out["report"] = {}
            return out
