"""
会话与登录审计 Repository（任务11）

- SessionRepository：登录会话落库，**只存 token 的 SHA256 哈希**，明文只在签发响应侧存在一次；
  过期/撤销都靠库字段判定，因此可主动失效（改密、强制下线、删除用户）。
- LoginLogRepository：登录审计流水（成功/失败/锁定/人脸），后台按用户与时间分页查询。

时间统一存 'YYYY-MM-DD HH:MM:SS' 文本：SQLite 与 MySQL 的 DATETIME 都可直接比较大小，
方言差异由任务14 的连接层消化，这里只写参数化 SQL。
"""

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from app import config
from app.models.db import get_connection

TIME_FMT = "%Y-%m-%d %H:%M:%S"


def now_str(moment: datetime = None) -> str:
    """当前（或指定）时间的标准文本形式"""
    return (moment or datetime.now()).strftime(TIME_FMT)


def hash_token(token: str) -> str:
    """token → SHA256 十六进制摘要；库里只存这个，泄露数据库也无法还原登录凭据"""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


class SessionRepository:
    """登录会话：签发 / 校验 / 续期 / 撤销"""

    @staticmethod
    def issue(username: str, role: str, client_ip: str = "", user_agent: str = "",
              ttl_hours: int = None) -> Tuple[str, Dict]:
        """签发会话：返回 (明文 token, 会话信息)；明文只在本函数返回值中出现一次"""
        token = secrets.token_urlsafe(32)
        ttl = int(ttl_hours or config.SESSION_TTL_HOURS)
        now = datetime.now()
        expires = now + timedelta(hours=ttl)
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO user_sessions (token_hash, username, role, client_ip, user_agent, "
                "created_at, last_seen_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (hash_token(token), username, role or "user", (client_ip or "")[:64],
                 (user_agent or "")[:255], now_str(now), now_str(now), now_str(expires)))
            session_id = cur.lastrowid
        return token, {"id": session_id, "username": username, "role": role or "user",
                       "expires_at": now_str(expires)}

    @staticmethod
    def get_active(token: str) -> Optional[Dict]:
        """按明文 token 取仍有效的会话（未撤销且未过期），无则 None"""
        if not token:
            return None
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id, username, role, client_ip, user_agent, created_at, last_seen_at, expires_at "
                "FROM user_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > ?",
                (hash_token(token), now_str())).fetchone()
        return dict(row) if row else None

    @staticmethod
    def touch(session: Dict, min_interval_seconds: int = 60) -> None:
        """滑动续期 last_seen_at：间隔太短不写库，避免每个静态资源都产生一次 UPDATE"""
        last_seen = session.get("last_seen_at") or ""
        try:
            gap = (datetime.now() - datetime.strptime(last_seen, TIME_FMT)).total_seconds()
        except (TypeError, ValueError):
            gap = min_interval_seconds + 1
        if gap < min_interval_seconds:
            return
        session["last_seen_at"] = now_str()
        with get_connection() as conn:
            conn.execute("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?",
                         (session["last_seen_at"], session["id"]))

    @staticmethod
    def revoke(token: str) -> bool:
        """撤销单个会话（登出）；返回是否真的撤销了有效会话"""
        if not token:
            return False
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE user_sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0",
                (hash_token(token),))
        return cur.rowcount > 0

    @staticmethod
    def revoke_username(username: str) -> int:
        """撤销某用户全部会话（改密/改角色/强制下线/删除用户），返回受影响的会话数"""
        if not username:
            return 0
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE user_sessions SET revoked = 1 WHERE username = ? AND revoked = 0",
                (username,))
        return cur.rowcount

    @staticmethod
    def purge_expired() -> int:
        """清理已撤销与已过期的会话记录（登录时顺带调用，避免表无限增长）"""
        with get_connection() as conn:
            cur = conn.execute(
                "DELETE FROM user_sessions WHERE revoked = 1 OR expires_at <= ?", (now_str(),))
        return cur.rowcount

    @staticmethod
    def list_active(username: str = None) -> List[Dict]:
        """在线的会话列表（不含 token 哈希），可用于后台展示与强制下线"""
        sql = ("SELECT id, username, role, client_ip, user_agent, created_at, last_seen_at, expires_at "
               "FROM user_sessions WHERE revoked = 0 AND expires_at > ?")
        params = [now_str()]
        if username:
            sql += " AND username = ?"
            params.append(username)
        sql += " ORDER BY id DESC"
        with get_connection() as conn:
            return [dict(r) for r in conn.execute(sql, params).fetchall()]

    @staticmethod
    def count_active(username: str) -> int:
        """某用户当前有效会话数（多端登录互不影响，仅用于展示）"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions WHERE username = ? AND revoked = 0 AND expires_at > ?",
                (username, now_str())).fetchone()
        return int(row["c"]) if row else 0

    @staticmethod
    def revoke_by_id(session_id: int) -> bool:
        """后台按会话 id 撤销（不依赖 token 明文）。"""
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE user_sessions SET revoked = 1 WHERE id = ? AND revoked = 0",
                (int(session_id),))
        return cur.rowcount > 0

    @staticmethod
    def admin_paginate(username: str = None, client_ip: str = None,
                       state: str = "active", page: int = 1, limit: int = 20) -> Dict:
        """后台会话列表分页。state: active(未撤销且未过期) / revoked / expired / all。倒序。"""
        page = max(1, int(page)); limit = max(1, int(limit))
        offset = (page - 1) * limit
        now = now_str()
        where, params = [], []
        if state == "active":
            where.append("revoked = 0"); where.append("expires_at > ?"); params.append(now)
        elif state == "revoked":
            where.append("revoked = 1")
        elif state == "expired":
            where.append("revoked = 0"); where.append("expires_at <= ?"); params.append(now)
        # state == "all" 不额外限定
        if username:
            where.append("username LIKE ?"); params.append("%%%s%%" % username)
        if client_ip:
            where.append("client_ip LIKE ?"); params.append("%%%s%%" % client_ip)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions" + clause, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT id, username, role, client_ip, user_agent, created_at, last_seen_at, "
                "expires_at, revoked FROM user_sessions" + clause
                + " ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
        return {"total": int(total), "list": [dict(r) for r in rows]}

    @staticmethod
    def admin_stats() -> Dict:
        """后台会话概况：活跃 / 已撤销 / 已过期 计数。"""
        now = now_str()
        with get_connection() as conn:
            active = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions WHERE revoked=0 AND expires_at > ?",
                (now,)).fetchone()["c"]
            revoked = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions WHERE revoked=1").fetchone()["c"]
            expired = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions WHERE revoked=0 AND expires_at <= ?",
                (now,)).fetchone()["c"]
        return {"active": int(active), "revoked": int(revoked), "expired": int(expired)}


class LoginLogRepository:
    """登录审计：只记用户名/IP/UA/结果，绝不记录密码或 token"""

    @staticmethod
    def record(username: str, result: str, message: str = "", client_ip: str = "",
               user_agent: str = "") -> None:
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO login_logs (username, client_ip, user_agent, result, message) "
                "VALUES (?, ?, ?, ?, ?)",
                ((username or "")[:32], (client_ip or "")[:64], (user_agent or "")[:255],
                 (result or "")[:32], (message or "")[:255]))

    @staticmethod
    def paginate(page: int = 1, limit: int = 20, username: str = None,
                 result: str = None) -> Dict:
        """后台查询：支持按用户名与结果筛选，倒序返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if username:
            where.append("username LIKE ?")
            params.append("%{}%".format(username))
        if result:
            where.append("result = ?")
            params.append(result)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) AS c FROM login_logs" + clause, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT id, username, client_ip, user_agent, result, message, created_at "
                "FROM login_logs" + clause + " ORDER BY id DESC LIMIT ? OFFSET ?",
                params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def purge_before(keep_days: int = 90) -> int:
        """清理过旧审计记录，返回删除条数（默认保留 90 天）"""
        cutoff = now_str(datetime.now() - timedelta(days=max(1, int(keep_days))))
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM login_logs WHERE created_at < ?", (cutoff,))
        return cur.rowcount
