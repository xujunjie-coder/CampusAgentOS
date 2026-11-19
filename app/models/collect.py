"""
采集数据 Model(Repository 模式) —— 任务6
把对 collect_items 表的所有 SQL 收拢到 CollectRepository，上层 Controller 只调用静态方法，不直接拼 SQL。

采集数据 = 采集管理模块从信源抓回并解析出的条目（橱窗列表展示：封面 + 标题 + 时间），
是后续「数据仓库」模块的原始数据底座。

约定：
- 同一信源下按标题去重（UNIQUE(source_id, title)），重复采集只增量入库新条目
- url / cover / summary / published_at 允许为空（信源页面未必提供），展示层负责兜底
- 所有方法 @staticmethod，保持与 SourceRepository 等一致的调用方式
"""

from typing import Dict, List
from app.models.db import get_connection

# 橱窗列表规格：1 行 3 列，12 条/页
PAGE_SIZE = 12


class CollectRepository:
    _COLS = ("id, source_id, source_name, keyword, title, url, cover, summary, "
             "published_at, username, collected_at")

    @staticmethod
    def save_items(source_id: int, source_name: str, keyword: str, username: str,
                   items: List[Dict]) -> Dict:
        """批量入库采集条目（INSERT OR IGNORE 按 source_id+title 去重）。
        返回 {saved: 库内累计条数, new: 本次新增条数}；无标题的条目跳过。"""
        rows = []
        for it in items or []:
            title = (it.get("title") or "").strip()
            if not title:
                continue
            rows.append((source_id, source_name, keyword, title,
                         (it.get("url") or "").strip(),
                         (it.get("cover") or "").strip(),
                         (it.get("summary") or "").strip()[:500],
                         (it.get("time") or it.get("published_at") or "").strip(),
                         username))
        with get_connection() as conn:
            before = conn.total_changes
            conn.executemany(
                "INSERT OR IGNORE INTO collect_items "
                "(source_id, source_name, keyword, title, url, cover, summary, published_at, username) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            new = conn.total_changes - before
            saved = conn.execute(
                "SELECT COUNT(*) AS c FROM collect_items WHERE source_id = ?", (source_id,)).fetchone()["c"]
        return {"saved": saved, "new": new}

    @staticmethod
    def paginate(keyword: str = None, source_id: int = None, page: int = 1,
                 limit: int = PAGE_SIZE) -> Dict:
        """分页拉取采集数据（新采集在前）：支持按标题/采集关键词模糊搜索与信源过滤，
        返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(title LIKE ? OR keyword LIKE ?)")
            params += ["%{}%".format(keyword)] * 2
        if source_id:
            where.append("source_id = ?")
            params.append(int(source_id))
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM collect_items {}".format(clause), params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM collect_items {} ORDER BY id DESC LIMIT ? OFFSET ?".format(
                    CollectRepository._COLS, clause), params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def get_by_id(item_id: int) -> Dict:
        """按 id 取单条原数据（数据仓库深采入口），不存在返回 None"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM collect_items WHERE id = ?".format(CollectRepository._COLS),
                (int(item_id),)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def list_sources() -> List[Dict]:
        """已产生采集数据的信源选项（数仓/原数据列表过滤下拉），含条数统计"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT source_id, source_name, COUNT(*) AS c FROM collect_items "
                "GROUP BY source_id, source_name ORDER BY source_id").fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def count_all() -> int:
        with get_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM collect_items").fetchone()["c"]