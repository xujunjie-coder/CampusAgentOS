"""
数据仓库 Model(Repository 模式) —— 任务7
把对 warehouse_data 表的所有 SQL 收拢到 WarehouseRepository，上层 Controller 只调用静态方法，不直接拼 SQL。

数据仓库 = 采集管理 collect_items 原数据经「深度采集（AI模型引擎 + Crawl4AI）」抽取详细正文后的落库表。
一条原数据（collect_items.id）对应一条深采结果：UNIQUE(collect_item_id) 保证重复深采只更新不新增。

约定：
- 分页 20/页（与用户管理等后台模块一致，开发限制要求）
- content_md 存 Crawl4AI/回退引擎抽取的正文 Markdown，ai_summary / ai_keywords 存大模型分析结果
- images 存 JSON 数组字符串（正文图片 URL 列表）
- status：0 未采集 / 1 采集失败 / 2 采集成功（列表列展示与深采过滤都依赖它）
- 所有方法 @staticmethod，保持与 SourceRepository / CollectRepository 一致的调用方式
"""

import json
from typing import Dict, List

from app.models import db
from app.models.db import get_connection

# 后台列表分页：20 条/页（任务7 开发限制第 6 条）
PAGE_SIZE = 20

STATUS_PENDING = 0
STATUS_FAILED = 1
STATUS_DONE = 2


class WarehouseRepository:
    _COLS = ("id, collect_item_id, source_id, source_name, keyword, title, url, "
             "content_md, content_text, word_count, ai_summary, ai_keywords, images, "
             "engine, llm_used, error, status, username, created_at, updated_at")

    @staticmethod
    def save_deep(collect_item: Dict, data: Dict, username: str = "") -> int:
        """深采结果入库：按 collect_item_id UPSERT（重复深采覆盖正文与分析结果，刷新 updated_at）。
        data 为 warehouse_service 产出的结果字典。返回数仓记录 id。"""
        images = data.get("images") or []
        with get_connection() as conn:
            row = None
            if db.DB_DRIVER == "sqlite":
                row = conn.execute(
                    "SELECT id FROM warehouse_data WHERE collect_item_id = ?",
                    (collect_item["id"],)).fetchone()
            params = (
                collect_item["id"], collect_item["source_id"], collect_item["source_name"],
                collect_item["keyword"],
                (data.get("title") or collect_item["title"] or "").strip(),
                (data.get("url") or collect_item["url"] or "").strip(),
                data.get("content_md") or "",
                data.get("content_text") or "",
                int(data.get("word_count") or 0),
                data.get("ai_summary") or "",
                json.dumps(data.get("ai_keywords") or [], ensure_ascii=False),
                json.dumps(images, ensure_ascii=False),
                data.get("engine") or "",
                1 if data.get("llm_used") else 0,
                "" if data.get("ok", True) else (data.get("error") or "")[:500],
                STATUS_DONE if data.get("ok", True) else STATUS_FAILED,
                username,
            )
            if db.DB_DRIVER == "mysql":
                # 任务14：MySQL 用一条 ON DUPLICATE KEY UPDATE 完成 UPSERT（由 UNIQUE(collect_item_id) 触发）
                conn.execute(
                    "INSERT INTO warehouse_data (collect_item_id, source_id, source_name, keyword, "
                    "title, url, content_md, content_text, word_count, ai_summary, ai_keywords, images, "
                    "engine, llm_used, error, status, username) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON DUPLICATE KEY UPDATE title=VALUES(title), url=VALUES(url), "
                    "content_md=VALUES(content_md), content_text=VALUES(content_text), "
                    "word_count=VALUES(word_count), ai_summary=VALUES(ai_summary), "
                    "ai_keywords=VALUES(ai_keywords), images=VALUES(images), engine=VALUES(engine), "
                    "llm_used=VALUES(llm_used), error=VALUES(error), status=VALUES(status), "
                    "username=VALUES(username), updated_at=CURRENT_TIMESTAMP", params)
                saved = conn.execute(
                    "SELECT id FROM warehouse_data WHERE collect_item_id = ?",
                    (collect_item["id"],)).fetchone()
                return saved["id"] if saved else 0
            if row:
                conn.execute(
                    "UPDATE warehouse_data SET title=?, url=?, content_md=?, content_text=?, "
                    "word_count=?, ai_summary=?, ai_keywords=?, images=?, engine=?, llm_used=?, "
                    "error=?, status=?, username=?, updated_at=datetime('now', 'localtime') "
                    "WHERE collect_item_id = ?", params[4:] + (collect_item["id"],))
                return row["id"]
            cur = conn.execute(
                "INSERT INTO warehouse_data (collect_item_id, source_id, source_name, keyword, "
                "title, url, content_md, content_text, word_count, ai_summary, ai_keywords, images, "
                "engine, llm_used, error, status, username) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params)
            return cur.lastrowid

    @staticmethod
    def get_by_id(data_id: int) -> Dict:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM warehouse_data WHERE id = ?".format(WarehouseRepository._COLS),
                (data_id,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def get_by_collect_item(collect_item_id: int) -> Dict:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM warehouse_data WHERE collect_item_id = ?".format(
                    WarehouseRepository._COLS),
                (collect_item_id,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def paginate(keyword: str = None, source_id: int = None, status: str = None,
                 page: int = 1, limit: int = PAGE_SIZE) -> Dict:
        """分页拉取数仓数据（深采在前、新入库在前）：标题/关键词/摘要模糊搜索 + 信源/状态过滤。
        status 传 'done'/'failed'/'pending' 或空。返回 {total, list}（列表不含正文大字段，减轻传输）。"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(title LIKE ? OR keyword LIKE ? OR ai_summary LIKE ?)")
            params += ["%{}%".format(keyword)] * 3
        if source_id:
            where.append("source_id = ?")
            params.append(int(source_id))
        status_map = {"done": STATUS_DONE, "failed": STATUS_FAILED, "pending": STATUS_PENDING}
        if status in status_map:
            where.append("status = ?")
            params.append(status_map[status])
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        cols = WarehouseRepository._COLS.replace("content_md, content_text, ", "")
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM warehouse_data {}".format(clause), params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM warehouse_data {} "
                "ORDER BY (CASE WHEN status = 2 THEN 0 ELSE 1 END), id DESC LIMIT ? OFFSET ?".format(
                    cols, clause), params + [limit, offset]).fetchall()
        return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def update_meta(data_id: int, title: str = None, ai_summary: str = None,
                    keyword: str = None) -> bool:
        """更新数仓记录的元信息（查看/编辑弹层保存：标题、AI 摘要、采集关键词）；正文只读不回改"""
        sets, params = [], []
        for col, val in (("title", title), ("ai_summary", ai_summary), ("keyword", keyword)):
            if val is not None:
                sets.append("%s = ?" % col)
                params.append(val)
        if not sets:
            return True
        params.append(int(data_id))
        with get_connection() as conn:
            conn.execute(
                "UPDATE warehouse_data SET {}, "
                "updated_at = datetime('now', 'localtime') WHERE id = ?".format(", ".join(sets)),
                params)
        return True

    @staticmethod
    def delete(data_id: int) -> bool:
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM warehouse_data WHERE id = ?", (int(data_id),))
        return cur.rowcount > 0

    @staticmethod
    def delete_many(ids: List[int]) -> int:
        ids = [int(i) for i in ids or []]
        if not ids:
            return 0
        with get_connection() as conn:
            before = conn.total_changes
            conn.executemany("DELETE FROM warehouse_data WHERE id = ?",
                             [(i,) for i in ids])
            return conn.total_changes - before

    @staticmethod
    def count_all() -> int:
        with get_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM warehouse_data").fetchone()["c"]

    @staticmethod
    def count_by_status() -> Dict:
        """工作台/列表统计：各状态条数"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS c FROM warehouse_data GROUP BY status").fetchall()
        stats = {"done": 0, "failed": 0, "pending": 0}
        for r in rows:
            stats[{STATUS_DONE: "done", STATUS_FAILED: "failed",
                   STATUS_PENDING: "pending"}.get(r["status"], "pending")] = r["c"]
        return stats
