"""
用户Model(Repository模式)
把对users表的所有SQL收拢到UserRepository类中
上层Controller只调用UserRepository类中的方法，不直接操作数据库，符合Repository模式

安全要点：
- 1绝不明文密码，注册时给每个用户生成16字节随机的密码盐，并使用密码盐对密码进行哈希，每次生成随机字符串
- 2密码哈希使用PBKDF2，迭代100000次，密钥长度32字节，盐值长度16字节，只存储哈希后的密码，不存储明文密码
- 3登录时用同一个Salt，重新计算密码哈希，并与存储的哈希值进行比较，判断密码是否匹配，即使数据库泄露，密码也无法直接还原
- 4username唯一，不能重复注册，如果重复注册则失败，因为会报IntegrityError，以此判断是否存在“用户名已存在”的情况
- 5所有方法均为@staticmethod，上层以UserRepository.xxx(...)静态调用，避免实例调用混用导致AttributeError
- 6role字段区分用户(user)/管理员(admin)，注册入口只能创建user
- 7任务10：assistant_employee_id 字段完成“用户 ↔ 数字助理”关联，0 表示跟随系统默认数字员工

"""

import re
import secrets
import hashlib
from datetime import datetime, timedelta
from typing import Optional
from app.models.db import IntegrityError, get_connection
from app.models.session import now_str


_PBKDF2_ITERATIONS = 100000

# 密码哈希函数
def _hash_password(password: str, salt: bytes) -> str:
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt,
        _PBKDF2_ITERATIONS,
       
    )
    return digest.hex()

"""用户Repository类"""
class UserRepository:
   @staticmethod
   def create_user(username: str, password: str, role: str = 'user') -> bool:
        """创建用户：注册链路只传默认role='user'，admin角色仅限初始化预置"""
        salt = secrets.token_bytes(16)
        password_hash = _hash_password(password, salt)
        try:
            with get_connection() as conn:
                conn.execute('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)', (username, password_hash, salt.hex(), role))
            return True
        except IntegrityError:
            #用户名已存在
            return False

   @staticmethod
   def get_user_by_username(username: str) -> Optional[dict]:
        with get_connection() as conn:
            return conn.execute('SELECT id, username, password_hash, salt, role, created_at FROM users WHERE username = ?', (username,)).fetchone()

   @staticmethod
   def get_all_users() -> list:
        """管理员用户列表：不含密码哈希与盐值，避免敏感字段外泄"""
        with get_connection() as conn:
            rows = conn.execute("SELECT id, username, role, created_at FROM users ORDER BY id").fetchall()
            return [dict(row) for row in rows]

   @staticmethod
   def verify_user(username: str, password: str) -> bool:
        """验证用户是否正确"""
        row = UserRepository.get_user_by_username(username)
        if row is None:
            return False
        salt = bytes.fromhex(row['salt'])
        password_hash = _hash_password(password, salt)
        return password_hash == row['password_hash']

   # ---------- 任务4：后台用户管理的分页/搜索/增删改 ----------
   @staticmethod
   def get_user_by_id(user_id: int) -> Optional[dict]:
        with get_connection() as conn:
            row = conn.execute('SELECT id, username, role, created_at FROM users WHERE id = ?', (user_id,)).fetchone()
            return dict(row) if row else None

   @staticmethod
   def paginate(keyword: str = None, role: str = None, page: int = 1, limit: int = 20) -> dict:
        """分页拉取用户：支持按用户名模糊搜索 + 角色筛选，返回 {total, list}，不含密码字段

        任务12：随行带出 face_enabled / face_count（用户管理列表的「人脸」列），一次查询避免 N+1。
        """
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("username LIKE ?")
            params.append("%{}%".format(keyword))
        if role:
            where.append("role = ?")
            params.append(role)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) AS c FROM users {}".format(clause), params).fetchone()['c']
            rows = conn.execute(
                "SELECT id, username, role, created_at, last_login_at, face_enabled, "
                "(SELECT COUNT(*) FROM user_faces f WHERE f.username = users.username) AS face_count "
                "FROM users {} ORDER BY id LIMIT ? OFFSET ?".format(clause),
                params + [limit, offset]).fetchall()
            return {"total": total, "list": [dict(r) for r in rows]}

   @staticmethod
   def update_user(user_id: int, username: str = None, role: str = None, password: str = None) -> bool:
        """更新用户：只改传入的字段；password 为空则保持原密码。用户名冲突返回 False"""
        sets, params = [], []
        if username:
            sets.append("username = ?")
            params.append(username)
        if role:
            sets.append("role = ?")
            params.append(role)
        if password:
            salt = secrets.token_bytes(16)
            sets.append("password_hash = ?")
            params.append(_hash_password(password, salt))
            sets.append("salt = ?")
            params.append(salt.hex())
        if not sets:
            return True
        params.append(user_id)
        try:
            with get_connection() as conn:
                conn.execute("UPDATE users SET {} WHERE id = ?".format(", ".join(sets)), params)
            return True
        except IntegrityError:
            #用户名与其他账号重复
            return False

   @staticmethod
   def delete_user(user_id: int) -> bool:
        with get_connection() as conn:
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return True

   @staticmethod
   def delete_users(user_ids: list) -> int:
        """批量删除，逐个参数化，返回删除条数"""
        if not user_ids:
            return 0
        n = 0
        with get_connection() as conn:
            for uid in user_ids:
                conn.execute("DELETE FROM users WHERE id = ?", (uid,))
                n += 1
        return n

   # ---------- 任务10：前台用户与数字助理（数字员工）的关联 ----------
   @staticmethod
   def get_assistant_id(username: str) -> int:
        """读取该用户在对话页选定的数字助理 id；0 = 未选择（跟随系统默认数字员工）"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT assistant_employee_id AS eid FROM users WHERE username = ?", (username,)).fetchone()
        return int(row["eid"] or 0) if row else 0

   @staticmethod
   def set_assistant_id(username: str, employee_id: int) -> bool:
        """保存用户选定的数字助理（0 = 恢复跟随系统默认）；用户不存在返回 False"""
        try:
            eid = int(employee_id or 0)
        except (TypeError, ValueError):
            return False
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE users SET assistant_employee_id = ? WHERE username = ?", (eid, username))
        return cur.rowcount > 0

   @staticmethod
   def clear_assistant(employee_id: int) -> int:
        """数字员工被删除/停用后，把仍指向它的用户偏好重置为跟随系统默认，返回重置人数"""
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE users SET assistant_employee_id = 0 WHERE assistant_employee_id = ?", (int(employee_id),))
        return cur.rowcount

   # ---------- 任务11：登录安全（最近登录 / 失败计数 / 锁定） ----------
   @staticmethod
   def get_login_state(username: str) -> Optional[dict]:
        """读取登录安全状态：失败次数与锁定截止时间（locked_until 空串=未锁定）"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id, username, role, last_login_at, failed_count, locked_until "
                "FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None

   @staticmethod
   def record_login_success(username: str) -> None:
        """登录成功：刷新最近登录时间并清零失败计数/解除锁定"""
        with get_connection() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ?, failed_count = 0, locked_until = '' "
                "WHERE username = ?", (now_str(), username))

   @staticmethod
   def record_login_failure(username: str, max_fails: int, lock_minutes: int) -> dict:
        """登录失败：失败计数 +1，达到阈值则锁定 lock_minutes 分钟。返回最新状态。

        不存在的账号不会走到这里（调用方只在 verify 前查库），避免凭空造出用户行。
        """
        state = UserRepository.get_login_state(username)
        if not state:
            return {"failed_count": 0, "locked": False, "locked_until": ""}
        failed = int(state.get("failed_count") or 0) + 1
        locked_until = state.get("locked_until") or ""
        if failed >= int(max_fails) and int(lock_minutes) > 0:
            locked_until = now_str(datetime.now() + timedelta(minutes=int(lock_minutes)))
        with get_connection() as conn:
            conn.execute("UPDATE users SET failed_count = ?, locked_until = ? WHERE username = ?",
                         (failed, locked_until, username))
        return {"failed_count": failed, "locked": bool(locked_until),
                "locked_until": locked_until}

   @staticmethod
   def is_locked(username: str) -> bool:
        """是否处于锁定期（locked_until 大于当前时间）；到期后自动放行但保留计数"""
        state = UserRepository.get_login_state(username)
        if not state:
            return False
        locked_until = state.get("locked_until") or ""
        return bool(locked_until) and locked_until > now_str()

   @staticmethod
   def clear_login_state(username: str) -> None:
        """管理员解锁/重置时调用：清零失败计数并解除锁定"""
        with get_connection() as conn:
            conn.execute("UPDATE users SET failed_count = 0, locked_until = '' WHERE username = ?",
                         (username,))

   # ---------- 任务12：人脸登录开关 ----------
   @staticmethod
   def set_face_enabled(username: str, enabled: int) -> bool:
        """开启/关闭该账号的人脸登录（0/1），返回是否有该用户"""
        with get_connection() as conn:
            cur = conn.execute("UPDATE users SET face_enabled = ? WHERE username = ?",
                               (1 if int(enabled) else 0, username))
        return cur.rowcount > 0

   @staticmethod
   def get_face_enabled(username: str) -> bool:
        with get_connection() as conn:
            row = conn.execute("SELECT face_enabled AS e FROM users WHERE username = ?",
                               (username,)).fetchone()
        return bool(row and row["e"])

   # ---------- 成员 D：用户中心（昵称/头像自助维护） ----------
   @staticmethod
   def get_profile(username: str) -> Optional[dict]:
        """用户中心自助查看：只回展示字段，绝不包含密码哈希/盐值"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id, username, nickname, avatar, role, created_at, last_login_at, "
                "face_enabled, assistant_employee_id FROM users WHERE username = ?",
                (username,)).fetchone()
        return dict(row) if row else None

   @staticmethod
   def update_profile(username: str, nickname: str = None, avatar: str = None) -> bool:
        """用户自助改昵称/头像（只改传入项）；长度截断防超长写入，用户不存在返回 False"""
        sets, params = [], []
        if nickname is not None:
            sets.append("nickname = ?")
            params.append(str(nickname).strip()[:32])
        if avatar is not None:
            sets.append("avatar = ?")
            params.append(str(avatar).strip()[:64])
        if not sets:
            return True
        params.append(username)
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE users SET {} WHERE username = ?".format(", ".join(sets)), params)
        return cur.rowcount > 0

   @staticmethod
   def change_password(username: str, new_password: str) -> bool:
        """本人改密：重算盐与 PBKDF2 哈希（与注册同构）；用户不存在返回 False"""
        salt = secrets.token_bytes(16)
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE users SET password_hash = ?, salt = ? WHERE username = ?",
                (_hash_password(new_password, salt), salt.hex(), username))
        return cur.rowcount > 0
