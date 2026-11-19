"""
角色 Model(Repository 模式)
把对 roles 表的所有 SQL 收拢到 RoleRepository，上层 Controller 只调用静态方法，不直接拼 SQL。

约定：
- code 唯一（如 admin/user），是角色的业务主键；users.role 存的就是这个 code
- builtin=1 的是系统内置角色，其中 code='admin' 为超级管理员，不允许删除
- 所有方法 @staticmethod，保持与 UserRepository 一致的调用方式
"""

from typing import Optional, List, Dict
from app.models.db import IntegrityError, get_connection


class RoleRepository:
    @staticmethod
    def paginate(keyword: str = None, page: int = 1, limit: int = 20) -> dict:
        """分页拉取角色：支持按编码/名称模糊搜索，返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(code LIKE ? OR name LIKE ?)")
            params += ["%{}%".format(keyword), "%{}%".format(keyword)]
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) AS c FROM roles {}".format(clause), params).fetchone()['c']
            rows = conn.execute(
                "SELECT id, code, name, description, home, builtin, created_at FROM roles {} ORDER BY id LIMIT ? OFFSET ?".format(clause),
                params + [limit, offset]).fetchall()
            return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def get_all() -> List[Dict]:
        """全量角色（下拉选项、工作台统计用），按 id 排序"""
        with get_connection() as conn:
            rows = conn.execute("SELECT id, code, name, description, home, builtin FROM roles ORDER BY id").fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_by_id(role_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute("SELECT id, code, name, description, home, builtin FROM roles WHERE id = ?", (role_id,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_by_code(code: str) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute("SELECT id, code, name, description, home, builtin FROM roles WHERE code = ?", (code,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def create(code: str, name: str, description: str = "", home: str = "/") -> bool:
        """新增自定义角色，builtin 固定 0；code 冲突返回 False"""
        try:
            with get_connection() as conn:
                conn.execute(
                    "INSERT INTO roles (code, name, description, home, builtin) VALUES (?, ?, ?, ?, 0)",
                    (code, name, description, home))
            return True
        except IntegrityError:
            return False

    @staticmethod
    def update(role_id: int, name: str = None, description: str = None, home: str = None) -> Optional[dict]:
        """编辑角色：code 作为业务主键不可改，只改名称/说明/入口。
        默认管理员角色（code='admin'）不允许修改。成功返回 None，否则返回 {error:...}"""
        role = RoleRepository.get_by_id(role_id)
        if not role:
            return {"error": "角色不存在"}
        if role["code"] == "admin":
            return {"error": "默认管理员角色不允许修改"}
        sets, params = [], []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if home is not None:
            sets.append("home = ?")
            params.append(home)
        if not sets:
            return None
        params.append(role_id)
        with get_connection() as conn:
            conn.execute("UPDATE roles SET {} WHERE id = ?".format(", ".join(sets)), params)
        return None

    # ---------- 角色 ↔ 菜单 权限关联（任务4修正） ----------
    @staticmethod
    def get_menu_ids(role_id: int) -> List[int]:
        """取该角色已分配的菜单 id 列表"""
        with get_connection() as conn:
            rows = conn.execute("SELECT menu_id FROM role_menus WHERE role_id = ?", (role_id,)).fetchall()
            return [r["menu_id"] for r in rows]

    @staticmethod
    def set_menus(role_id: int, menu_ids: List[int]) -> bool:
        """重置角色的菜单权限（全量覆盖）：先清后插，去重参数化"""
        ids = sorted({int(m) for m in (menu_ids or [])})
        with get_connection() as conn:
            conn.execute("DELETE FROM role_menus WHERE role_id = ?", (role_id,))
            for mid in ids:
                conn.execute("INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?, ?)", (role_id, mid))
        return True

    @staticmethod
    def menu_ids_by_code(code: str) -> List[int]:
        """按角色 code 取已分配菜单 id（供鉴权/导航过滤）"""
        with get_connection() as conn:
            row = conn.execute("SELECT id FROM roles WHERE code = ?", (code,)).fetchone()
            if not row:
                return []
            rows = conn.execute("SELECT menu_id FROM role_menus WHERE role_id = ?", (row["id"],)).fetchall()
            return [r["menu_id"] for r in rows]

    @staticmethod
    def is_backend_role(code: str) -> bool:
        """是否为可进入后台的角色：超级管理员 admin 恒真；其余角色需至少被分配一个菜单"""
        if code == "admin":
            return True
        return len(RoleRepository.menu_ids_by_code(code)) > 0

    @staticmethod
    def used_by_users(code: str) -> int:
        """统计仍在使用该角色 code 的用户数，用于删除前的占用校验"""
        with get_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = ?", (code,)).fetchone()['c']

    @staticmethod
    def delete(role_id: int) -> Optional[dict]:
        """删除角色：内置 admin 不可删。同时清理其菜单权限关联。返回 None 表示删除成功"""
        role = RoleRepository.get_by_id(role_id)
        if not role:
            return {"error": "角色不存在"}
        if role["code"] == "admin":
            return {"error": "系统默认管理员角色不允许删除"}
        if RoleRepository.used_by_users(role["code"]) > 0:
            return {"error": "该角色下仍有用户，无法删除"}
        with get_connection() as conn:
            conn.execute("DELETE FROM roles WHERE id = ?", (role_id,))
            conn.execute("DELETE FROM role_menus WHERE role_id = ?", (role_id,))
        return None
