"""
模型引擎 Model(Repository 模式) —— 任务8
把对 model_engines 表的所有 SQL 收拢到 ModelEngineRepository，上层 Controller 只调用静态方法，不直接拼 SQL。

模型引擎 = OpenAI 接口范式的大模型服务接入配置（api_url + api_key + model_id），
按主流 MaaS 服务分类支持五种模型类型；全系统有且仅有一个默认模型（is_default=1），
供智能体对话 / 后续深度采集等需要 AI 能力的链路统一取用。

约定：
- name 唯一，是模型的业务主键；model_id 为服务端真实模型标识，允许重复（同一服务可建多条配置）
- type 取值见 MODEL_TYPES：text/multimodal/image/vl/embedding
- thinking=1 表示该模型支持思维链，对话测试时可切换 enable_thinking 开关
- api_key 属敏感配置：列表接口由控制层脱敏后下发，Repository 原样存取
- 所有方法 @staticmethod，保持与 SourceRepository 等一致的调用方式
"""

from typing import Optional, List, Dict
from app.models.db import IntegrityError, get_connection

# 模型类型（对齐主流 MaaS 服务分类）：code -> 展示名
MODEL_TYPES = {
    "text": "文本类",
    "multimodal": "多模态类",
    "image": "图片类",
    "vl": "VL类",
    "embedding": "嵌入模型类",
}


class ModelEngineRepository:
    # 统一列集合，避免多处漏字段
    _COLS = "id, name, api_url, api_key, model_id, type, thinking, enabled, is_default, description, created_at"

    @staticmethod
    def paginate(keyword: str = None, mtype: str = None, page: int = 1, limit: int = 4) -> dict:
        """橱窗分页拉取模型：支持按名称/model_id/简介模糊搜索 + 类型过滤，返回 {total, list}。
        任务8.1：子查询带出各模型 token 累计（token_total/call_count），卡片直观反馈零新增列"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(name LIKE ? OR model_id LIKE ? OR description LIKE ?)")
            params += ["%{}%".format(keyword)] * 3
        if mtype:
            where.append("type = ?")
            params.append(mtype)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        # 与 model_token_logs 的关联子查询：无流水时为 0，不影响主表行
        stats_cols = ("COALESCE((SELECT SUM(total_tokens) FROM model_token_logs t WHERE t.engine_id = model_engines.id), 0) AS token_total, "
                      "COALESCE((SELECT COUNT(*) FROM model_token_logs t WHERE t.engine_id = model_engines.id), 0) AS call_count")
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) AS c FROM model_engines {}".format(clause), params).fetchone()['c']
            rows = conn.execute(
                "SELECT {}, {} FROM model_engines {} ORDER BY is_default DESC, id LIMIT ? OFFSET ?".format(
                    ModelEngineRepository._COLS, stats_cols, clause),
                params + [limit, offset]).fetchall()
            return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def get_all() -> List[Dict]:
        """全量模型（默认模型置顶），按 is_default DESC, id 排序"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT {} FROM model_engines ORDER BY is_default DESC, id".format(ModelEngineRepository._COLS)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_by_id(engine_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM model_engines WHERE id = ?".format(ModelEngineRepository._COLS), (engine_id,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_default() -> Optional[Dict]:
        """当前默认模型（is_default=1）；无默认时返回 None，由调用方决定兜底策略"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM model_engines WHERE is_default = 1 ORDER BY id LIMIT 1".format(
                    ModelEngineRepository._COLS)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def create(name: str, api_url: str, api_key: str, model_id: str, mtype: str = "text",
               thinking: int = 0, enabled: int = 1, description: str = "") -> Optional[int]:
        """新增模型，name 冲突返回 None；库内还没有任何模型时自动成为默认模型。成功返回新 id"""
        try:
            with get_connection() as conn:
                has_default = conn.execute(
                    "SELECT COUNT(*) AS c FROM model_engines WHERE is_default = 1").fetchone()["c"] > 0
                cur = conn.execute(
                    "INSERT INTO model_engines (name, api_url, api_key, model_id, type, thinking, enabled, is_default, description) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (name, api_url, api_key, model_id, mtype, thinking, enabled, 0 if has_default else 1, description))
                return cur.lastrowid
        except IntegrityError:
            return None

    @staticmethod
    def update(engine_id: int, name: str = None, api_url: str = None, api_key: str = None,
               model_id: str = None, mtype: str = None, thinking: int = None,
               enabled: int = None, description: str = None) -> Optional[dict]:
        """编辑模型：传 None 的字段保持不变（api_key 传空串视为保持不变，防止误清空）。
        成功返回 None，否则返回 {error:...}"""
        engine = ModelEngineRepository.get_by_id(engine_id)
        if not engine:
            return {"error": "模型不存在"}
        sets, params = [], []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if api_url is not None:
            sets.append("api_url = ?")
            params.append(api_url)
        if api_key:
            sets.append("api_key = ?")
            params.append(api_key)
        if model_id is not None:
            sets.append("model_id = ?")
            params.append(model_id)
        if mtype is not None:
            sets.append("type = ?")
            params.append(mtype)
        if thinking is not None:
            sets.append("thinking = ?")
            params.append(thinking)
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(enabled)
            # 停用默认模型时把默认位让给下一个启用模型，保证系统始终有可用默认
            if not enabled and engine["is_default"]:
                sets.append("is_default = 0")
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if not sets:
            return None
        params.append(engine_id)
        try:
            with get_connection() as conn:
                conn.execute("UPDATE model_engines SET {} WHERE id = ?".format(", ".join(sets)), params)
                if not enabled and engine["is_default"]:
                    ModelEngineRepository._promote_first(conn)
        except IntegrityError:
            return {"error": "模型名称已存在"}
        return None

    @staticmethod
    def delete(engine_id: int) -> Optional[dict]:
        """删除模型。若删的是默认模型，自动把默认位让给剩余第一个启用模型。成功返回 None"""
        engine = ModelEngineRepository.get_by_id(engine_id)
        if not engine:
            return {"error": "模型不存在"}
        with get_connection() as conn:
            conn.execute("DELETE FROM model_engines WHERE id = ?", (engine_id,))
            if engine["is_default"]:
                ModelEngineRepository._promote_first(conn)
        return None

    @staticmethod
    def set_default(engine_id: int) -> Optional[dict]:
        """把指定启用模型设为全系统唯一默认模型（先清旧默认再置新默认）。成功返回 None"""
        engine = ModelEngineRepository.get_by_id(engine_id)
        if not engine:
            return {"error": "模型不存在"}
        if not engine["enabled"]:
            return {"error": "模型已停用，请先启用再设为默认"}
        with get_connection() as conn:
            conn.execute("UPDATE model_engines SET is_default = 0 WHERE is_default = 1")
            conn.execute("UPDATE model_engines SET is_default = 1 WHERE id = ?", (engine_id,))
        return None

    @staticmethod
    def _promote_first(conn) -> None:
        """内部：默认位空缺时，把剩余第一个启用模型提为默认（须在事务连接内调用）"""
        has_default = conn.execute(
            "SELECT COUNT(*) AS c FROM model_engines WHERE is_default = 1").fetchone()["c"] > 0
        if has_default:
            return
        row = conn.execute(
            "SELECT id FROM model_engines WHERE enabled = 1 ORDER BY id LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE model_engines SET is_default = 1 WHERE id = ?", (row["id"],))