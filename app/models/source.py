"""
信源 Model(Repository 模式) —— 任务5
把对 sources 表的所有 SQL 收拢到 SourceRepository，上层 Controller 只调用静态方法，不直接拼 SQL。

信源 = 网络可信的 URL 规格 + Request Headers 规则，只管理数据源与规则，不含采集任务
（采集任务由后续「采集管理」模块基于本表动态发起）。

约定：
- name 唯一，是信源的业务主键
- url：URL 规格模板，可含 {关键字} / {分页} 等占位符，采集时由采集管理模块替换
- headers：Request Headers 以 JSON 对象字符串入库；新增/编辑时支持 RAW 文本解析
  （parse_raw_headers 兼容 DevTools「名称行/值行交替」与标准「Name: Value」两种格式）
- 所有方法 @staticmethod，保持与 RoleRepository/MenuRepository 一致的调用方式
"""

import json
import re
from typing import Optional, List, Dict
from app.models.db import IntegrityError, get_connection

# 合法 header 名（token）：字母数字与 -_ ；标准行格式为「Name: Value」
_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9\-_]+$")
_STD_LINE_RE = re.compile(r"^([A-Za-z0-9\-_]+):\s*(.*)$")
# RAW 里可能混入请求行/状态行（如 GET /s?... HTTP/1.1），解析时跳过
_REQUEST_LINE_RE = re.compile(r"^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s|^HTTP/", re.I)


class SourceRepository:
    # 统一列集合，避免多处漏字段
    _COLS = "id, name, url, headers, description, enabled, created_at"

    @staticmethod
    def parse_raw_headers(raw: str) -> Dict:
        """把 Request Headers 的 RAW 文本解析为 dict，供 JSON 入库。兼容两种粘贴格式：
        1. DevTools RAW：名称行与值行交替（accept 一行、值一行）
        2. 标准格式：每行「Name: Value」
        判定：所有非空行都符合标准格式则按标准解析，否则按交替对解析（允许混入单行标准对）。
        空文本返回 {}；同名 header 后者覆盖前者。"""
        lines = [ln.strip() for ln in (raw or "").splitlines() if ln.strip()]
        lines = [ln for ln in lines if not _REQUEST_LINE_RE.match(ln)]
        if not lines:
            return {}
        headers = {}
        if all(_STD_LINE_RE.match(ln) for ln in lines):
            for ln in lines:
                k, v = _STD_LINE_RE.match(ln).groups()
                headers[k] = v.strip()
            return headers
        i = 0
        while i < len(lines):
            ln = lines[i]
            m = _STD_LINE_RE.match(ln)
            if m:  # 交替格式里混入的单行「Name: Value」
                headers[m.group(1)] = m.group(2).strip()
                i += 1
                continue
            if not _HEADER_NAME_RE.match(ln) or i + 1 >= len(lines):
                i += 1  # 非法名称行 / 末尾落单的名称行：跳过
                continue
            headers[ln] = lines[i + 1]
            i += 2
        return headers

    @staticmethod
    def paginate(keyword: str = None, page: int = 1, limit: int = 20) -> dict:
        """分页拉取信源：支持按名称/URL/简介模糊搜索，返回 {total, list}"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(name LIKE ? OR url LIKE ? OR description LIKE ?)")
            params += ["%{}%".format(keyword)] * 3
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) AS c FROM sources {}".format(clause), params).fetchone()['c']
            rows = conn.execute(
                "SELECT {} FROM sources {} ORDER BY id LIMIT ? OFFSET ?".format(SourceRepository._COLS, clause),
                params + [limit, offset]).fetchall()
            return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def get_all() -> List[Dict]:
        """全量信源（后续采集管理模块选取采集源用），按 id 排序"""
        with get_connection() as conn:
            rows = conn.execute("SELECT {} FROM sources ORDER BY id".format(SourceRepository._COLS)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_by_id(source_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM sources WHERE id = ?".format(SourceRepository._COLS), (source_id,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def create(name: str, url: str, headers: Dict = None, description: str = "", enabled: int = 1) -> bool:
        """新增信源，headers dict 序列化为 JSON 入库；name 冲突返回 False"""
        try:
            with get_connection() as conn:
                conn.execute(
                    "INSERT INTO sources (name, url, headers, description, enabled) VALUES (?, ?, ?, ?, ?)",
                    (name, url, json.dumps(headers or {}, ensure_ascii=False), description, enabled))
            return True
        except IntegrityError:
            return False

    @staticmethod
    def update(source_id: int, name: str = None, url: str = None, headers: Dict = None,
               description: str = None, enabled: int = None) -> Optional[dict]:
        """编辑信源：传 None 的字段保持不变。成功返回 None，否则返回 {error:...}"""
        source = SourceRepository.get_by_id(source_id)
        if not source:
            return {"error": "信源不存在"}
        sets, params = [], []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if url is not None:
            sets.append("url = ?")
            params.append(url)
        if headers is not None:
            sets.append("headers = ?")
            params.append(json.dumps(headers, ensure_ascii=False))
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(enabled)
        if not sets:
            return None
        params.append(source_id)
        try:
            with get_connection() as conn:
                conn.execute("UPDATE sources SET {} WHERE id = ?".format(", ".join(sets)), params)
        except IntegrityError:
            return {"error": "信源名称已存在"}
        return None

    @staticmethod
    def delete(source_id: int) -> Optional[dict]:
        """删除信源。成功返回 None"""
        source = SourceRepository.get_by_id(source_id)
        if not source:
            return {"error": "信源不存在"}
        with get_connection() as conn:
            conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        return None