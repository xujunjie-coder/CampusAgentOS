"""
菜单 Model(Repository 模式)
把对 menus 表的所有 SQL 收拢到 MenuRepository，供后台侧边导航渲染、菜单管理（树形/拖拽排序）与角色权限关联使用。

数据结构（任务4修正后）：
- parent_id=0 一级，>0 指向父菜单 id（当前两级，与任务3导航树一致）
- icon：图片列（fontawesome 图标 class）；description：简介列
- enabled=1 才进入侧边导航；sort 控制同级排序（拖拽排序即批量重写 sort/parent_id）
- 与 role_menus 关联实现「不同角色不同后台权限」：角色被分配的菜单 id 决定其可见/可访问范围
- 所有方法 @staticmethod
"""

from typing import Optional, List, Dict
from app.models.db import get_connection


class MenuRepository:
    # 统一列集合，避免多处漏字段
    _COLS = "id, parent_id, name, icon, url, description, sort, enabled"

    @staticmethod
    def get_nav_tree() -> List[Dict]:
        """侧边导航用：只取启用菜单，按 sort 排序，组装成「一级 + children」两级树"""
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT {} FROM menus WHERE enabled = 1 ORDER BY sort, id".format(MenuRepository._COLS)).fetchall()]
        tops, children_map = [], {}
        for m in rows:
            if m["parent_id"] == 0:
                m["children"] = []
                tops.append(m)
            else:
                children_map.setdefault(m["parent_id"], []).append(m)
        for top in tops:
            top["children"] = children_map.get(top["id"], [])
        return tops

    @staticmethod
    def get_tree_all() -> List[Dict]:
        """菜单管理 / 角色分配用：全部菜单（含停用）两级树，按 sort 排序"""
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT {} FROM menus ORDER BY sort, id".format(MenuRepository._COLS)).fetchall()]
        tops, children_map = [], {}
        for m in rows:
            if m["parent_id"] == 0:
                m["children"] = []
                tops.append(m)
            else:
                children_map.setdefault(m["parent_id"], []).append(m)
        for top in tops:
            top["children"] = children_map.get(top["id"], [])
        return tops

    @staticmethod
    def paginate_tree(keyword: str = None, page: int = 1, limit: int = 20) -> dict:
        """菜单管理列表：按「顶级菜单」分页，顶级下挂 children；返回 {total, list}（total 为顶级数量）"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        with get_connection() as conn:
            if keyword:
                like = "%{}%".format(keyword)
                # 命中：顶级自身匹配，或其子级匹配（把命中的顶级都拉出来）
                clause = ("WHERE m0.parent_id = 0 AND ("
                          "m0.name LIKE ? OR m0.description LIKE ? OR m0.url LIKE ? OR m0.id IN "
                          "(SELECT parent_id FROM menus WHERE name LIKE ? OR description LIKE ?))")
                params = [like, like, like, like, like]
            else:
                clause = "WHERE parent_id = 0"
                params = []
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM menus m0 {}".format(clause), params).fetchone()['c']
            tops = [dict(r) for r in conn.execute(
                "SELECT {} FROM menus m0 {} ORDER BY sort, id LIMIT ? OFFSET ?".format(MenuRepository._COLS, clause),
                params + [limit, offset]).fetchall()]
            kids = [dict(r) for r in conn.execute(
                "SELECT {} FROM menus WHERE parent_id != 0 ORDER BY sort, id".format(MenuRepository._COLS)).fetchall()]
        children_map = {}
        for k in kids:
            children_map.setdefault(k["parent_id"], []).append(k)
        for top in tops:
            top["children"] = children_map.get(top["id"], [])
            top["level"] = 1
        return {"total": total, "list": tops}

    @staticmethod
    def get_roots() -> List[Dict]:
        """上级菜单下拉：所有一级菜单"""
        with get_connection() as conn:
            rows = conn.execute("SELECT id, name FROM menus WHERE parent_id = 0 ORDER BY sort, id").fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_by_id(menu_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM menus WHERE id = ?".format(MenuRepository._COLS), (menu_id,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_by_url(url: str) -> Optional[Dict]:
        """按路由地址取菜单（用于接口/页面按菜单鉴权）；同 url 多条时取第一条"""
        if not url:
            return None
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM menus WHERE url = ? ORDER BY id LIMIT 1".format(MenuRepository._COLS), (url,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def create(parent_id: int, name: str, icon: str = "", url: str = "",
               description: str = "", sort: int = 0, enabled: int = 1) -> bool:
        with get_connection() as conn:
            maxsort = conn.execute(
                "SELECT COALESCE(MAX(sort), 0) AS s FROM menus WHERE parent_id = ?", (parent_id,)).fetchone()['s']
            conn.execute(
                "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (parent_id, name, icon, url, description, sort if sort else maxsort + 1, enabled))
        return True

    @staticmethod
    def update(menu_id: int, parent_id: int = None, name: str = None, icon: str = None,
               url: str = None, description: str = None, sort: int = None, enabled: int = None) -> bool:
        sets, params = [], []
        mapping = {"parent_id": parent_id, "name": name, "icon": icon, "url": url,
                   "description": description, "sort": sort, "enabled": enabled}
        for col, val in mapping.items():
            if val is not None:
                sets.append("{} = ?".format(col))
                params.append(val)
        if not sets:
            return True
        params.append(menu_id)
        with get_connection() as conn:
            conn.execute("UPDATE menus SET {} WHERE id = ?".format(", ".join(sets)), params)
        return True

    @staticmethod
    def save_sort(items: List[Dict]) -> int:
        """批量保存拖拽后的层级与顺序：items=[{id,parent_id,sort},...]，全部参数化"""
        n = 0
        with get_connection() as conn:
            for it in items:
                try:
                    mid = int(it["id"])
                except (KeyError, TypeError, ValueError):
                    continue
                conn.execute("UPDATE menus SET parent_id = ?, sort = ? WHERE id = ?",
                             (int(it.get("parent_id", 0)), int(it.get("sort", 0)), mid))
                n += 1
        return n

    @staticmethod
    def has_children(menu_id: int) -> bool:
        with get_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM menus WHERE parent_id = ?", (menu_id,)).fetchone()['c'] > 0

    @staticmethod
    def delete(menu_id: int) -> Optional[dict]:
        """删除菜单：存在子菜单时禁止删除；同时清理 role_menus 关联，避免脏引用。成功返回 None"""
        menu = MenuRepository.get_by_id(menu_id)
        if not menu:
            return {"error": "菜单不存在"}
        if MenuRepository.has_children(menu_id):
            return {"error": "请先删除该菜单下的子菜单"}
        with get_connection() as conn:
            conn.execute("DELETE FROM menus WHERE id = ?", (menu_id,))
            conn.execute("DELETE FROM role_menus WHERE menu_id = ?", (menu_id,))
        return None
