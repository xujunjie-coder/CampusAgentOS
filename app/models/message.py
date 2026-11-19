"""
模型会话记录 Model(Repository模式)
把对message表的所有SQL收拢到MessageRepository类中
上层Controller只调用MessageRepository类中的方法，不直接操作数据库，符合Repository模式


用户隔离是本模块的核心约束，每个用户的数据相互隔离，不泄露用户数据
- 1所有读写方法都必须带username，并放进where条件
- 2需要保证每个username用户只能看到自己的数据，不能看到其他用户数据
- 3所有的方法都通过静态方法实现，不通过实例方法实现

后台管理（成员 E）：paginate / get_by_id / delete / delete_batch / count_all_with_filter 为跨用户管理接口，
仅 AdminMessageApiHandler 调用，需菜单鉴权，不对普通用户开放。
"""


from typing import List, Dict, Optional

from app.models.db import get_connection

class MessageRepository:
    @staticmethod
    def save(username:str, role:str, message:str,
             employee_id: int = 0, employee_name: str = "", session_id: str = "default") -> int:
        """
        保存用户会话记录
        :param username: 用户名
        :param role: 角色
        :param message: 会话内容
        :param employee_id: 任务10：应答的数字员工 id（用户消息传 0）
        :param employee_name: 任务10：应答的数字员工名称（反范式存储，与采集表 source_name 同构）
        :return: 插入的记录ID
        """
        with get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO messages (username, role, content, employee_id, employee_name, session_id) VALUES (?, ?, ?, ?, ?, ?)",
                (username, role, message, int(employee_id or 0), employee_name or "", session_id)
            )
            return cursor.lastrowid
    @staticmethod
    def list_recent(username: str, limit: int = 50, session_id: str = "default",
                    *, archived: bool = False) -> List[Dict]:
        """读取某用户的指定的若干条消息（按时间正序返回），含任务10的应答助理身份"""
        with get_connection() as conn:
            if archived:
                rows = conn.execute(
                    """SELECT id, username, role, content, employee_id, employee_name, is_partial,
                              origin_created_at AS created_at
                       FROM message_archives WHERE username = ? AND session_id = ?
                       ORDER BY origin_id DESC, id DESC LIMIT ?""", (username, session_id, limit)).fetchall()
                return [dict(row) for row in reversed(rows)]
            rows = conn.execute(
                """SELECT id, username, role, content, employee_id, employee_name, is_partial, created_at FROM (
                SELECT id, username, role, content, employee_id, employee_name, is_partial, created_at FROM messages WHERE username = ? AND session_id = ?
                ORDER BY id DESC LIMIT ?
                ) AS recent
                ORDER BY id ASC
                """,
                (username, session_id, limit)
            ).fetchall()

            return [dict(row) for row in rows]


    @staticmethod
    def list_sessions(username, *, archived=False):
        table = "message_archives" if archived else "messages"
        archived_only = """AND NOT EXISTS (
            SELECT 1 FROM messages m WHERE m.username = a.username AND m.session_id = a.session_id
        )""" if archived else ""
        with get_connection() as conn:
            return [dict(row) for row in conn.execute(
                f"""SELECT m.session_id, substr(m.content, 1, 50) AS title
                   FROM {table} m JOIN (
                     SELECT MIN(a.id) AS first_id, MAX(a.id) AS last_id FROM {table} a
                     WHERE a.username = ? {archived_only} GROUP BY a.session_id
                   ) s ON m.id = s.first_id ORDER BY s.last_id DESC LIMIT 100""", (username,))]

    @staticmethod
    def is_archived(username, session_id):
        with get_connection() as conn:
            return bool(conn.execute(
                """SELECT 1 FROM message_archives a WHERE a.username = ? AND a.session_id = ?
                   AND NOT EXISTS (SELECT 1 FROM messages m
                                   WHERE m.username = a.username AND m.session_id = a.session_id)
                   LIMIT 1""", (username, session_id)).fetchone())

    @staticmethod
    def change_session(username, session_id, action):
        key = (username, session_id)
        where = " WHERE username = ? AND session_id = ?"
        fields = "username, session_id, role, content, employee_id, employee_name, is_partial"
        with get_connection() as conn:
            if conn.driver == "sqlite":
                conn.execute("BEGIN IMMEDIATE")
            else:
                for table in ("messages", "message_archives"):
                    conn.execute(f"SELECT id FROM {table}" + where + " FOR UPDATE", key).fetchall()
            if action == "archive":
                conn.execute(
                    f"""INSERT INTO message_archives (origin_id, {fields}, origin_created_at)
                        SELECT id, {fields}, created_at FROM messages""" + where + " ORDER BY id", key)
                return conn.execute("DELETE FROM messages" + where, key).rowcount
            if action == "restore":
                if conn.execute("SELECT 1 FROM messages" + where + " LIMIT 1", key).fetchone():
                    return 0
                conn.execute(
                    f"""INSERT INTO messages ({fields}, created_at)
                        SELECT {fields}, origin_created_at FROM message_archives""" + where +
                    " ORDER BY origin_id, id", key)
                return conn.execute("DELETE FROM message_archives" + where, key).rowcount
            if action == "delete":
                active = conn.execute("DELETE FROM messages" + where, key).rowcount
                return active + conn.execute("DELETE FROM message_archives" + where, key).rowcount
            raise ValueError("未知会话操作")

    @staticmethod
    def save_turn(username, session_id, question, answer, employee_id, employee_name, *, partial=False):
        with get_connection() as conn:
            conn.executemany(
                """INSERT INTO messages (username, session_id, role, content, employee_id, employee_name, is_partial)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [(username, session_id, "user", question, 0, "", 0),
                 (username, session_id, "assistant", answer, employee_id, employee_name, int(partial))])

    @staticmethod
    def count(username: Optional[str]) -> int:
        """
        统计某用户的消息数量
        
        """
        with get_connection() as conn:
            row = conn.execute("SELECT COUNT(id) AS c FROM messages WHERE username = ?", (username,)).fetchone()
            return row['c'] if row else 0

    @staticmethod
    def count_all() -> int:
        """后台工作台统计：全库消息总数（跨用户，仅供 admin 页面展示，普通用户不可达）"""
        with get_connection() as conn:
            row = conn.execute("SELECT COUNT(id) AS c FROM messages").fetchone()
            return row['c'] if row else 0

    # ==================== 后台管理专用（成员 E）====================

    _ADMIN_COLS = ("id, username, session_id, role, content, employee_id, employee_name, "
                   "is_partial, created_at")

    @staticmethod
    def _admin_where(username=None, session_id=None, role=None, keyword=None,
                     start_at=None, end_at=None):
        where, params = [], []
        if username:
            where.append("username LIKE ?"); params.append("%%%s%%" % username)
        if session_id:
            where.append("session_id LIKE ?"); params.append("%%%s%%" % session_id)
        if role:
            where.append("role = ?"); params.append(role)
        if keyword:
            where.append("content LIKE ?"); params.append("%%%s%%" % keyword)
        if start_at:
            where.append("created_at >= ?"); params.append(start_at)
        if end_at:
            where.append("created_at <= ?"); params.append(end_at)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        return clause, params

    @staticmethod
    def admin_paginate(username=None, session_id=None, role=None, keyword=None,
                       start_at=None, end_at=None, page=1, limit=20) -> Dict:
        """后台分页：支持多条件筛选，倒序。不隔离 username，仅供 Admin 使用。"""
        page = max(1, int(page)); limit = max(1, int(limit))
        offset = (page - 1) * limit
        clause, params = MessageRepository._admin_where(
            username, session_id, role, keyword, start_at, end_at)
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(id) AS c FROM messages" + clause, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM messages".format(MessageRepository._ADMIN_COLS) + clause
                + " ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
        return {"total": int(total), "list": [dict(r) for r in rows]}

    @staticmethod
    def admin_get(msg_id: int) -> Optional[Dict]:
        """后台取单条详情（完整 content）。"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM messages WHERE id = ?".format(MessageRepository._ADMIN_COLS),
                (int(msg_id),)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def admin_delete(msg_id: int) -> int:
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM messages WHERE id = ?", (int(msg_id),))
        return cur.rowcount

    @staticmethod
    def admin_delete_batch(ids: List[int]) -> int:
        ids = [int(i) for i in (ids or []) if i]
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        with get_connection() as conn:
            cur = conn.execute(
                "DELETE FROM messages WHERE id IN (%s)" % placeholders, ids)
        return cur.rowcount

    @staticmethod
    def admin_count(username=None, session_id=None, role=None, keyword=None,
                    start_at=None, end_at=None) -> int:
        clause, params = MessageRepository._admin_where(
            username, session_id, role, keyword, start_at, end_at)
        with get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(id) AS c FROM messages" + clause, params).fetchone()
        return int(row["c"]) if row else 0
