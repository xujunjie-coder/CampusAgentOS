"""
数字员工 Model(Repository 模式) —— 任务9
把对 digital_employees 表的所有 SQL 收拢到 DigitalEmployeeRepository，
上层 Controller 只调用静态方法，不直接拼 SQL。

数字员工 = agentica Agent 的数据库化配置：任务9 将 agent_service.py 中硬编码的
「旅行规划师」抽离入库统一管理，核心三大配置：
- instructions 提示词：Markdown 正文（编辑器产出）+ link_files 关联的 md 文件清单
  （相对 workspace 根目录，注入时由 agent_service 拼在正文之后）
- tools 工具链路：工具 id 的 JSON 数组（id -> agentica 工具映射在 agent_service.TOOL_REGISTRY；
  后续任务接「工具管理模块」动态选择，此处按预留 id 存储）
- workspace 工作空间：相对项目根目录的路符串（agentica Workspace 的 path，按 user_id 隔离用户目录）

约定：
- name 唯一，是数字员工的业务主键
- is_default=1 标记前台对话默认使用的数字员工，全库有且仅有一个（与模型引擎 is_default 同构）
- rag_kb_ids 为 RAG 知识库预留列（RAG 管理模块未实现，仅存储 id 数组）
- model_binding 为模型绑定预留列（空 = 沿用模型引擎默认模型）
- 所有方法 @staticmethod，保持与 ModelEngineRepository 等一致的调用方式
"""

import json
from typing import Optional, List, Dict
from app.models.db import IntegrityError, get_connection

# 橱窗列表规格（任务9：一行 4 列，12 条/页）
EMPLOYEE_PAGE_SIZE = 12

# 卡片头像可选图标（本地 vendor 为 FontAwesome 5 free，类名须 v5 真实存在）
AVATAR_ICONS = [
    "fas fa-briefcase", "fas fa-robot", "fas fa-user-tie", "fas fa-sitemap",
    "fas fa-pen-fancy", "fas fa-chart-line", "fas fa-magic", "fas fa-compass",
]


class DigitalEmployeeRepository:
    # 统一列集合，避免多处漏字段
    _COLS = ("id, name, description, avatar, instructions, link_files, tools, workspace_path, "
             "model_binding, rag_kb_ids, enabled, is_default, "
             "enable_long_term_memory, enable_experience_capture, created_at, updated_at")

    @staticmethod
    def paginate(keyword: str = None, enabled: int = None,
                 page: int = 1, limit: int = EMPLOYEE_PAGE_SIZE) -> dict:
        """橱窗分页拉取数字员工：支持按名称/简介/提示词模糊搜索 + 启停状态过滤，返回 {total, list}。
        默认员工置顶，其余按 id 升序"""
        page = max(1, int(page))
        limit = max(1, int(limit))
        offset = (page - 1) * limit
        where, params = [], []
        if keyword:
            where.append("(name LIKE ? OR description LIKE ? OR instructions LIKE ?)")
            params += ["%{}%".format(keyword)] * 3
        if enabled is not None:
            where.append("enabled = ?")
            params.append(int(enabled))
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM digital_employees {}".format(clause), params).fetchone()["c"]
            rows = conn.execute(
                "SELECT {} FROM digital_employees {} ORDER BY is_default DESC, id LIMIT ? OFFSET ?".format(
                    DigitalEmployeeRepository._COLS, clause),
                params + [limit, offset]).fetchall()
            return {"total": total, "list": [dict(r) for r in rows]}

    @staticmethod
    def get_all() -> List[Dict]:
        """全量数字员工（默认置顶），供其他链路取候选"""
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT {} FROM digital_employees ORDER BY is_default DESC, id".format(
                    DigitalEmployeeRepository._COLS)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_by_id(employee_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM digital_employees WHERE id = ?".format(
                    DigitalEmployeeRepository._COLS), (employee_id,)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_default() -> Optional[Dict]:
        """默认且启用的数字员工（前台对话默认使用）；无则返回 None，由调用方决定兜底"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM digital_employees WHERE is_default = 1 AND enabled = 1 "
                "ORDER BY id LIMIT 1".format(DigitalEmployeeRepository._COLS)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_first_enabled() -> Optional[Dict]:
        """第一个启用数字员工：默认位缺失/默认被停用时的回退"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM digital_employees WHERE enabled = 1 ORDER BY id LIMIT 1".format(
                    DigitalEmployeeRepository._COLS)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def create(name: str, instructions: str = "", link_files: List[str] = None,
               tools: List[str] = None, workspace_path: str = "workspace",
               description: str = "", avatar: str = "fas fa-briefcase",
               model_binding: str = "", rag_kb_ids: List = None, enabled: int = 1,
               enable_long_term_memory: int = 1, enable_experience_capture: int = 1) -> Optional[int]:
        """新增数字员工，name 冲突返回 None。库内还没有任何员工时自动成为默认员工。成功返回新 id"""
        try:
            with get_connection() as conn:
                has_default = conn.execute(
                    "SELECT COUNT(*) AS c FROM digital_employees WHERE is_default = 1").fetchone()["c"] > 0
                cur = conn.execute(
                    "INSERT INTO digital_employees (name, description, avatar, instructions, link_files, tools, "
                    "workspace_path, model_binding, rag_kb_ids, enabled, is_default, "
                    "enable_long_term_memory, enable_experience_capture) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (name, description, avatar, instructions,
                     json.dumps(link_files or [], ensure_ascii=False),
                     json.dumps(tools or [], ensure_ascii=False),
                     workspace_path, model_binding,
                     json.dumps(rag_kb_ids or [], ensure_ascii=False),
                     enabled, 0 if has_default else 1,
                     enable_long_term_memory, enable_experience_capture))
                return cur.lastrowid
        except IntegrityError:
            return None

    @staticmethod
    def update(employee_id: int, name: str = None, description: str = None, avatar: str = None,
               instructions: str = None, link_files: List[str] = None, tools: List[str] = None,
               workspace_path: str = None, model_binding: str = None, rag_kb_ids: List = None,
               enabled: int = None, enable_long_term_memory: int = None,
               enable_experience_capture: int = None) -> Optional[dict]:
        """编辑数字员工（含启停开关）：传 None 的字段保持不变，更新时刷新 updated_at。
        停用默认员工时把默认位让给下一个启用员工；完成后幂等补齐默认位，
        保证前台始终有可用默认。成功返回 None"""
        employee = DigitalEmployeeRepository.get_by_id(employee_id)
        if not employee:
            return {"error": "数字员工不存在"}
        sets, params = [], []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if avatar is not None:
            sets.append("avatar = ?")
            params.append(avatar)
        if instructions is not None:
            sets.append("instructions = ?")
            params.append(instructions)
        if link_files is not None:
            sets.append("link_files = ?")
            params.append(json.dumps(link_files, ensure_ascii=False))
        if tools is not None:
            sets.append("tools = ?")
            params.append(json.dumps(tools, ensure_ascii=False))
        if workspace_path is not None:
            sets.append("workspace_path = ?")
            params.append(workspace_path)
        if model_binding is not None:
            sets.append("model_binding = ?")
            params.append(model_binding)
        if rag_kb_ids is not None:
            sets.append("rag_kb_ids = ?")
            params.append(json.dumps(rag_kb_ids, ensure_ascii=False))
        if enable_long_term_memory is not None:
            sets.append("enable_long_term_memory = ?")
            params.append(enable_long_term_memory)
        if enable_experience_capture is not None:
            sets.append("enable_experience_capture = ?")
            params.append(enable_experience_capture)
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(enabled)
            if not enabled and employee["is_default"]:
                sets.append("is_default = 0")
        if not sets:
            return None
        sets.append("updated_at = datetime('now', 'localtime')")
        params.append(employee_id)
        try:
            with get_connection() as conn:
                conn.execute("UPDATE digital_employees SET {} WHERE id = ?".format(", ".join(sets)), params)
                # 幂等补齐默认位（覆盖停用默认、历史数据默认位空缺等场景）
                DigitalEmployeeRepository._promote_first(conn)
        except IntegrityError:
            return {"error": "数字员工名称已存在"}
        return None

    @staticmethod
    def delete(employee_id: int) -> Optional[dict]:
        """删除数字员工。删除后幂等补齐默认位（默认位空缺时让给剩余第一个启用员工）。成功返回 None"""
        employee = DigitalEmployeeRepository.get_by_id(employee_id)
        if not employee:
            return {"error": "数字员工不存在"}
        with get_connection() as conn:
            conn.execute("DELETE FROM digital_employees WHERE id = ?", (employee_id,))
            DigitalEmployeeRepository._promote_first(conn)
        return None

    @staticmethod
    def set_default(employee_id: int) -> Optional[dict]:
        """把指定启用数字员工设为前台默认（先清旧默认再置新默认）。成功返回 None"""
        employee = DigitalEmployeeRepository.get_by_id(employee_id)
        if not employee:
            return {"error": "数字员工不存在"}
        if not employee["enabled"]:
            return {"error": "数字员工已停用，请先启用再设为默认"}
        with get_connection() as conn:
            conn.execute("UPDATE digital_employees SET is_default = 0 WHERE is_default = 1")
            conn.execute("UPDATE digital_employees SET is_default = 1 WHERE id = ?", (employee_id,))
        return None

    @staticmethod
    def _promote_first(conn) -> None:
        """内部：默认位空缺时，把剩余第一个启用员工提为默认（须在事务连接内调用）"""
        has_default = conn.execute(
            "SELECT COUNT(*) AS c FROM digital_employees WHERE is_default = 1").fetchone()["c"] > 0
        if has_default:
            return
        row = conn.execute(
            "SELECT id FROM digital_employees WHERE enabled = 1 ORDER BY id LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE digital_employees SET is_default = 1 WHERE id = ?", (row["id"],))
