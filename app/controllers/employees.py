"""
数字员工管理控制器 —— 任务9：以 agentica 为基础的智能体管理模块

把 agent_service.py 中硬编码的「旅行规划师」抽离到 digital_employees 表统一管理，
核心三大配置：instructions 提示词（Markdown 可视化编辑 + 多 md 文件关联）、
工具链路（tools）、agentica 工作空间（workspace 目录）。

分层规则与后台其他模块一致：
- 表现层：templates/admin/employees.html 出橱窗框架壳（一行 4 列，12 条/页），
          卡片/弹层/MD编辑器/文件浏览器由 static/js/employees.js 走本模块 JSON API
- 控制层：页面与接口沿用 admin.py 的 AdminBaseHandler/AdminApiHandler 鉴权设施
          （登录 + 后台角色 + 按菜单 /admin/employees 校验）
- 模型层：数据一律走 DigitalEmployeeRepository，控制器不写 SQL

接口约定：
- 列表/启停/删除/设默认等任何配置变更都会 reset_agents()，前台对话下次即按最新配置重建
- 任务10：助理被停用/删除后，同步把仍选定它的用户关联清零（前台自动回到跟随系统默认）
- 关联 md 文件路径一律相对 workspace 根目录，浏览与读取均做防穿越校验（只允许 workspace 内）
- 橱窗列表卡片下发 instructions_preview（截断串），编辑弹层按需 GET 详情取完整正文
- rag_kb_ids 绑定知识文档，tools 配置数字员工可调用的工具
"""

import json
import os
import re

import tornado.web

from app.controllers.admin import AdminBaseHandler, AdminApiHandler, backend_required
from app.models.digital_employee import (
    DigitalEmployeeRepository, EMPLOYEE_PAGE_SIZE, AVATAR_ICONS)
from app.models.user import UserRepository
from app.services.agent_service import reset_agents

TOOL_OPTIONS = {
    "weather": ("天气查询", "fas fa-cloud-sun"),
    "todo": ("任务清单", "fas fa-list"),
    "task": ("子智能体委派", "fas fa-sitemap"),
    "memory": ("长期记忆（工作空间）", "fas fa-brain"),
    "warehouse": ("数仓检索", "fas fa-database"),
    "mcp_search": ("MCP 网络搜索", "fas fa-search"),
    "campus_shuttle": ("校园班车查询", "fas fa-bus"),
    "campus_calendar": ("校历与考试周", "fas fa-calendar-alt"),
    "campus_gpa": ("绩点与奖学金测算", "fas fa-calculator"),
    "campus_directory": ("校内办事黄页", "fas fa-map-signs"),
}

URL_EMPLOYEES = "/admin/employees"
# workspace 根目录：数字员工文件关联/工作空间浏览的安全边界
WORKSPACE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, "workspace"))


def _safe_workspace_path(rel_path: str):
    """把相对 workspace 根的路径归一化为绝对路径；防穿越（越界/绝对路径/盘符）返回 None"""
    rel = (rel_path or "").replace("\\", "/").strip("/")
    if not rel or re.search(r"[<>|:*?\x00]", rel) or ":" in rel:
        return None
    full = os.path.abspath(os.path.join(WORKSPACE_ROOT, rel))
    if full != WORKSPACE_ROOT and not full.startswith(WORKSPACE_ROOT + os.sep):
        return None
    return full


def _preview(text: str, n: int = 100) -> str:
    """提示词预览串：压掉换行与 Markdown 噪音后截断，供卡片展示"""
    flat = re.sub(r"[#*`>\-\n]+", " ", text or "").strip()
    flat = re.sub(r"\s+", " ", flat)
    return flat[:n] + ("…" if len(flat) > n else "")


def _public_row(row: dict) -> dict:
    """列表行瘦身：JSON 列解析成原生数组，另附 instructions_preview（大正文不下发列表）"""
    out = dict(row)
    for col in ("link_files", "tools", "rag_kb_ids"):
        raw = out.get(col) or "[]"
        try:
            out[col] = json.loads(raw)
        except (ValueError, TypeError):
            out[col] = []
    out["instructions_preview"] = _preview(out.pop("instructions", "") or row.get("instructions", ""))
    return out


def _bool_arg(v, default: int = 1) -> int:
    return 1 if v in (1, "1", True, "true") else (default if v is None else 0)


def _norm_tools(tools) -> list:
    """只保留已注册工具编号"""
    if not isinstance(tools, list):
        return []
    return [t for t in tools if isinstance(t, str) and t in TOOL_OPTIONS]


def _norm_link_files(files) -> list:
    """关联文件路径校验：必须落在 workspace 内且为 .md 文件，非法项静默过滤（重复项只保留首个）"""
    out = []
    if not isinstance(files, list):
        return out
    for f in files:
        full = _safe_workspace_path(f if isinstance(f, str) else "")
        if full and full.lower().endswith(".md") and os.path.isfile(full):
            rel = os.path.relpath(full, WORKSPACE_ROOT).replace("\\", "/")
            if rel not in out:
                out.append(rel)
    return out


def _release_disabled_users(employee_id: int) -> None:
    """任务10：数字员工被停用或删除后，把 users.assistant_employee_id 仍指向它的账号
    重置为跟随系统默认（0），避免前台用户带着失效助理进入对话。幂等"""
    row = DigitalEmployeeRepository.get_by_id(int(employee_id))
    if row and row["enabled"]:
        return
    UserRepository.clear_assistant(int(employee_id))


def _form_fields(b: dict) -> dict:
    """把请求体里显式传了的字段归一化为 Repository update 参数（未传的保持 None）"""
    fields = {}
    if b.get("name") is not None:
        fields["name"] = (b.get("name") or "").strip()
    for key in ("description", "avatar", "instructions", "workspace_path", "model_binding"):
        if b.get(key) is not None:
            fields[key] = (b.get(key) or "").strip()
    if "link_files" in b:
        fields["link_files"] = _norm_link_files(b.get("link_files"))
    if "tools" in b:
        fields["tools"] = _norm_tools(b.get("tools"))
    if "rag_kb_ids" in b:
        raw = b.get("rag_kb_ids")
        fields["rag_kb_ids"] = [str(i) for i in raw] if isinstance(raw, list) else []
    for key in ("enabled", "enable_long_term_memory", "enable_experience_capture"):
        if b.get(key) is not None:
            fields[key] = _bool_arg(b.get(key))
    return fields


# ==================== 页面 ====================

class AdminEmployeesHandler(AdminBaseHandler):
    """数字员工页（任务9）：橱窗框架壳，卡片由 employees.js 走 /api/admin/employees"""

    template_name = "admin/employees.html"
    page_name = "数字员工"
    nav_url = URL_EMPLOYEES

    def get_context(self) -> dict:
        return {
            "tool_options": [{"id": key, "label": label, "icon": icon}
                             for key, (label, icon) in TOOL_OPTIONS.items()],
            "avatar_icons": AVATAR_ICONS,
            "employee_page_size": EMPLOYEE_PAGE_SIZE,
        }


# ==================== 数据接口（JSON API） ====================

class AdminEmployeesApiHandler(AdminApiHandler):
    """GET /api/admin/employees 橱窗分页（12/页）+搜索+启停过滤；POST 新增数字员工"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_EMPLOYEES):
            return
        page, keyword = self._page_args(self)
        status = (self.get_argument("status", "") or "").strip()
        enabled = None
        if status:
            if status not in ("on", "off"):
                self.fail("未知的状态过滤值")
                return
            enabled = 1 if status == "on" else 0
        data = DigitalEmployeeRepository.paginate(keyword=keyword or None, enabled=enabled,
                                                  page=page, limit=EMPLOYEE_PAGE_SIZE)
        data["list"] = [_public_row(r) for r in data["list"]]
        self.ok(**data)

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_EMPLOYEES):
            return
        b = self.body()
        name = (b.get("name") or "").strip()
        if not name or len(name) > 64:
            self.fail("数字员工名称需为1-64个字符")
            return
        if not (b.get("instructions") or "").strip() and not _norm_link_files(b.get("link_files")):
            self.fail("instructions 提示词与关联 md 文件至少配置一项")
            return
        workspace_path = (b.get("workspace_path") or "workspace").strip() or "workspace"
        if not os.path.isdir(os.path.abspath(os.path.join(
                os.path.dirname(__file__), os.pardir, os.pardir, workspace_path.replace("\\", "/")))):
            self.fail("工作空间目录不存在（须为项目根目录下的相对路径）")
            return
        new_id = DigitalEmployeeRepository.create(
            name,
            instructions=b.get("instructions") or "",
            link_files=_norm_link_files(b.get("link_files")),
            tools=_norm_tools(b.get("tools")),
            workspace_path=workspace_path,
            description=(b.get("description") or "").strip(),
            avatar=(b.get("avatar") or "fas fa-briefcase").strip(),
            model_binding=(b.get("model_binding") or "").strip(),
            rag_kb_ids=[str(i) for i in (b.get("rag_kb_ids") or []) if isinstance(i, (str, int))],
            enabled=_bool_arg(b.get("enabled", 1)),
            enable_long_term_memory=_bool_arg(b.get("enable_long_term_memory", 1)),
            enable_experience_capture=_bool_arg(b.get("enable_experience_capture", 1)),
        )
        if new_id is None:
            self.fail("数字员工名称已存在")
            return
        reset_agents()
        self.ok(id=new_id)


class AdminEmployeeItemHandler(AdminApiHandler):
    """GET /api/admin/employees/<id> 编辑详情（含完整 instructions 正文）；
    POST 更新（含启停开关）；DELETE 删除（默认员工自动让位）"""

    @tornado.web.authenticated
    @backend_required
    def get(self, employee_id):
        if not self.require_menu(URL_EMPLOYEES):
            return
        row = DigitalEmployeeRepository.get_by_id(int(employee_id))
        if not row:
            self.fail("数字员工不存在", status=404)
            return
        self.ok(row=_public_row(row), instructions=row["instructions"])

    @tornado.web.authenticated
    @backend_required
    def post(self, employee_id):
        if not self.require_menu(URL_EMPLOYEES):
            return
        b = self.body()
        fields = _form_fields(b)
        if "name" in fields and (not fields["name"] or len(fields["name"]) > 64):
            self.fail("数字员工名称需为1-64个字符")
            return
        if "workspace_path" in fields:
            wp = fields["workspace_path"] or "workspace"
            fields["workspace_path"] = wp
            if not os.path.isdir(os.path.abspath(os.path.join(
                    os.path.dirname(__file__), os.pardir, os.pardir, wp.replace("\\", "/")))):
                self.fail("工作空间目录不存在（须为项目根目录下的相对路径）")
                return
        err = DigitalEmployeeRepository.update(int(employee_id), **fields)
        if err:
            self.fail(err["error"])
            return
        _release_disabled_users(int(employee_id))
        reset_agents()
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, employee_id):
        if not self.require_menu(URL_EMPLOYEES):
            return
        err = DigitalEmployeeRepository.delete(int(employee_id))
        if err:
            self.fail(err["error"])
            return
        _release_disabled_users(int(employee_id))
        reset_agents()
        self.ok()


class AdminEmployeeDefaultHandler(AdminApiHandler):
    """POST /api/admin/employees/<id>/default 设为前台默认数字员工（须启用态）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, employee_id):
        if not self.require_menu(URL_EMPLOYEES):
            return
        err = DigitalEmployeeRepository.set_default(int(employee_id))
        if err:
            self.fail(err["error"])
            return
        reset_agents()
        self.ok()


class AdminEmployeeToggleHandler(AdminApiHandler):
    """POST /api/admin/employees/<id>/toggle 启停开关，body: {enabled:0/1}（缺省按取反切换）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, employee_id):
        if not self.require_menu(URL_EMPLOYEES):
            return
        row = DigitalEmployeeRepository.get_by_id(int(employee_id))
        if not row:
            self.fail("数字员工不存在", status=404)
            return
        b = self.body()
        enabled = _bool_arg(b.get("enabled")) if b.get("enabled") is not None else (0 if row["enabled"] else 1)
        err = DigitalEmployeeRepository.update(int(employee_id), enabled=enabled)
        if err:
            self.fail(err["error"])
            return
        _release_disabled_users(int(employee_id))
        reset_agents()
        self.ok(enabled=enabled)


class AdminEmployeeFilesHandler(AdminApiHandler):
    """GET /api/admin/employees/files?path=相对workspace根 工作空间文件浏览（任务9 workspace 配置与管理）：
    返回当前目录的子目录链（可下钻）与 md 文件清单（供 instructions 关联）；仅允许 workspace 内路径"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_EMPLOYEES):
            return
        rel = (self.get_argument("path", "") or "").strip("/")
        full = _safe_workspace_path(rel) if rel else WORKSPACE_ROOT
        if full is None or not os.path.isdir(full):
            self.fail("目录不存在或不在 workspace 范围内", status=404)
            return
        dirs, mds = [], []
        try:
            for name in sorted(os.listdir(full), key=str.lower):
                if name.startswith((".", "__")):
                    continue
                item = os.path.join(full, name)
                rel_item = (rel + "/" if rel else "") + name
                if os.path.isdir(item):
                    dirs.append(rel_item)
                elif name.lower().endswith(".md"):
                    mds.append({"path": rel_item, "name": name,
                                "size": os.path.getsize(item)})
        except OSError as e:
            self.fail("目录读取失败：%s" % e)
            return
        self.ok(path=rel, dirs=dirs, mds=mds)
