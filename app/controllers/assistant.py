"""
数字助理选择控制器 —— 任务10：完成数字员工与前台用户侧的关联

任务9 把智能体配置抽到了 digital_employees 表，但前台对话仍固定用「默认数字员工」，
用户侧没有任何选择入口。本模块补齐这条关联：
- 用户在对话页输入区选定「数字助理」，选择结果写入 users.assistant_employee_id（按用户持久化）
- 对话接口 /api/chat 按「本次显式选择 > 用户已保存助理 > 系统默认员工 > 第一个启用员工」装配智能体
- 会话记录 messages 落库应答助理的身份（id + 名称），历史记录按发言人渲染

分层与权限：
- 表现层：templates/index.html 输入区选择器 + static/js/chat.js 交互（下拉面板 + 持久化调用）
- 控制层：本模块 Handler 只继承 BaseHandler，@tornado.web.authenticated 即可访问
          （前台用户侧接口，不校验后台角色与菜单权限）
- 模型层：数据一律走 DigitalEmployeeRepository / UserRepository，控制器不写 SQL

接口约定：
- GET  /api/assistants        可选数字助理清单（仅启用态）+ 当前生效选择
- POST /api/assistants/select 保存选定助理，employee_id=0 表示恢复跟随系统默认
- pick_assistant(...) 供 /api/chat 复用：同一套关联解析与校验规则，校验失败返回错误文案
- 助理被删除或停用后不报错：读取时自动回退默认员工，users 偏好由后台删除动作幂等清零
"""

import json

import tornado.web

from app.controllers.base import BaseHandler
from app.models.digital_employee import DigitalEmployeeRepository
from app.models.user import UserRepository
from app.services.agent_service import resolve_employee


def _json_list(raw) -> list:
    """tools/rag_kb_ids 等 JSON 列容错解析：非法值一律回退空列表"""
    if isinstance(raw, list):
        return raw
    try:
        data = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []


def assistant_brief(row: dict) -> dict:
    """前台下发字段收敛：只给展示与身份确认所需内容，不带 instructions 大正文与盐化配置"""
    if not row:
        return {}
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "avatar": row["avatar"] or "fas fa-robot",
        "tools": _json_list(row.get("tools")),
        "workspace_path": row["workspace_path"],
        "is_default": row["is_default"],
        "enabled": row["enabled"],
    }


def effective_assistant(username: str) -> dict:
    """当前用户实际生效的助理：与 /api/chat 同源（resolve_employee），保证选中所见与对话实际一致"""
    return resolve_employee(username)


def pick_assistant(username: str, employee_id):
    """任务10：对话入口的「用户 ↔ 数字助理」关联解析，返回 (助理行, 错误文案)：
    - 不传 employee_id：按已保存助理/系统默认解析，不写库
    - 传具体 id：校验存在且启用（否则返回错误，由调用方转 400），同时把该选择落库为用户关联
    - 传 0：恢复跟随系统默认数字员工（清空关联）"""
    if employee_id is None:
        return resolve_employee(username), None
    try:
        eid = int(employee_id)
    except (TypeError, ValueError):
        return None, "employee_id 必须为数字"
    if eid < 0:
        return None, "employee_id 取值非法"
    if eid == 0:
        UserRepository.set_assistant_id(username, 0)
        return (DigitalEmployeeRepository.get_default()
                or DigitalEmployeeRepository.get_first_enabled()), None
    row = DigitalEmployeeRepository.get_by_id(eid)
    if not row:
        return None, "数字助理不存在，请重新选择"
    if not row["enabled"]:
        return None, "数字助理已停用，请重新选择"
    UserRepository.set_assistant_id(username, eid)
    return row, None


class AssistantListApiHandler(BaseHandler):
    """GET /api/assistants：可对话的数字助理清单（仅启用态，默认员工置顶）与当前选定项"""

    @tornado.web.authenticated
    def get(self):
        items = [assistant_brief(r) for r in DigitalEmployeeRepository.get_all() if r["enabled"]]
        selected = assistant_brief(effective_assistant(self.current_user))
        self.write_json({
            "ok": True,
            "list": items,
            "saved_id": UserRepository.get_assistant_id(self.current_user),
            "selected_id": selected.get("id", 0),
            "selected": selected,
            "total": len(items),
        })


class AssistantSelectApiHandler(BaseHandler):
    """POST /api/assistants/select 保存用户选定的数字助理（用户↔助理关联落库）

    body: {employee_id: 数字员工 id，0 = 恢复跟随系统默认数字员工}；
    校验与 /api/chat 完全同源（pick_assistant），避免“能选上但对话报错”的不一致"""

    def body(self) -> dict:
        try:
            return json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    @tornado.web.authenticated
    def post(self):
        b = self.body()
        if "employee_id" not in b:
            self.write_json({"detail": "请指定 employee_id（0 表示跟随系统默认数字员工）"}, status=400)
            return
        employee, err = pick_assistant(self.current_user, b.get("employee_id"))
        if err:
            self.write_json({"detail": err}, status=400)
            return
        # saved_id 回显的是用户关联字段值（0=跟随系统默认），selected 才是实际生效的助理
        self.write_json({"ok": True,
                         "saved_id": UserRepository.get_assistant_id(self.current_user),
                         "selected": assistant_brief(employee)})
