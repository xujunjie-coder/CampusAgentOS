"""
后台管理（admin）控制器 —— 任务4（修正版）：用户 / 角色 / 菜单 三模块 + 角色-菜单权限关联；任务5：信源管理

分层规则不变：
- 表现层：templates/admin/*.html 出「功能区 | 列表区 | 分页区」框架壳与静态表头，
          列表/树/拖拽排序由 static/js/admin.js 走本模块 JSON API
- 控制层：AdminBaseHandler 渲染页面（登录 + 后台角色 + 按菜单鉴权）；AdminApiHandler 提供数据接口
- 模型层：数据一律走 models 下 Repository（User/Role/Menu/Source/Message），控制器不写 SQL

权限模型（任务4修正：不同角色不同后台权限访问）：
- 超级管理员角色 code='admin' 恒有全部权限（绕过一切菜单校验，防止把自己锁死）
- 其余「后台角色」= 在「角色管理」里被分配了至少一个菜单的角色；登录后：
  * 侧边导航只显示其被分配的菜单（build_nav 按 allowed menu ids 过滤）
  * 访问 /admin/* 页面与对应 /api/admin/* 接口，校验其角色是否拥有该菜单（按菜单 url 匹配），无则 403
"""

import functools
import json

import tornado.web

from app.controllers.base import BaseHandler
from app.models.message import MessageRepository
from app.models.menu import MenuRepository
from app.models.role import RoleRepository
from app.models.session import LoginLogRepository, SessionRepository
from app.models.source import SourceRepository
from app.models.user import UserRepository

# 三模块统一每页 20 条（开发限制要求）
PAGE_SIZE = 20

# 各管理页面对应的菜单路由：页面与其数据接口都按该菜单鉴权
URL_USERS = "/admin/users"
URL_ROLES = "/admin/roles"
URL_MENUS = "/admin/menus"
URL_SOURCES = "/admin/sources"


def allowed_ids_for(role_code):
    """角色可访问的菜单 id 集合；超级管理员返回 None 表示不限制"""
    if role_code == "admin":
        return None
    return set(RoleRepository.menu_ids_by_code(role_code))


def build_nav(active_path: str, allowed_ids) -> list:
    """从 menus 表读启用导航树，按角色权限过滤 + 当前路径打高亮/展开标记"""
    if active_path in ('/collect/web','/collect/qq'):
        active_path='/collect'
    nav = []
    for top in MenuRepository.get_nav_tree():
        children = []
        for c in top.get("children", []):
            if allowed_ids is None or c["id"] in allowed_ids:
                children.append({**c, "label": c["name"], "active": c.get("url") == active_path})
        parent_allowed = allowed_ids is None or top["id"] in allowed_ids
        # 无子项权限且父项本身也不是可点菜单（无 url 或无权限）则整组隐藏
        if not children and not (parent_allowed and top.get("url")):
            continue
        expanded = any(child["active"] for child in children)
        nav.append({
            **top,
            "label": top["name"],
            "children": children,
            "has_children": bool(children),
            "active": (top.get("url") == active_path) and not children,
            "expanded": expanded,
        })
    return nav


def backend_required(method):
    """后台访问校验：当前角色须为超级管理员或被分配了后台菜单，否则 403（页面文本 / 接口 JSON）"""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        code = self.get_current_role()
        if not code or not RoleRepository.is_backend_role(code):
            self.deny(403, "需要后台访问权限")
            return
        return method(self, *args, **kwargs)
    return wrapper


class AdminGuard(BaseHandler):
    """权限与响应公共设施：页面（api=False，纯文本错误）与接口（api=True，JSON 错误）共用"""

    api = False

    def deny(self, status: int, message: str) -> None:
        if self.api:
            self.write_json({"ok": False, "error": message}, status=status)
        else:
            self.set_status(status)
            self.finish("%d: %s" % (status, message))

    def role_code(self):
        return self.get_current_role()

    def allowed_ids(self):
        return allowed_ids_for(self.role_code())

    def require_menu(self, url):
        """细粒度菜单校验：url=None 表示仅需后台身份；超管绕过；否则须拥有该菜单"""
        if url is None or self.role_code() == "admin":
            return True
        menu = MenuRepository.get_by_url(url)
        if not menu or menu["id"] not in self.allowed_ids():
            self.deny(403, "无权访问该功能")
            return False
        return True


# ==================== 页面 ====================

class AdminBaseHandler(AdminGuard):
    """后台页面基类：登录 + 后台角色 + 可选菜单校验，注入导航与页面上下文"""

    template_name = ""
    page_name = ""
    nav_url = None  # 该页面对应菜单 url；None 表示后台角色皆可进（如工作台）

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(self.nav_url):
            return
        self.render_admin(**self.get_context())

    def get_context(self) -> dict:
        return {}

    def render_admin(self, **context) -> None:
        self.render(
            self.template_name,
            title="后台管理 · %s" % self.page_name,
            username=self.current_user,
            role=self.role_code() or "admin",
            nav=build_nav(self.request.path, self.allowed_ids()),
            active_nav=self.request.path,
            page_name=self.page_name,
            page_size=PAGE_SIZE,
            **context,
        )


class AdminDashboardHandler(AdminBaseHandler):
    """工作台：后台首页，服务端直接渲染只读概览；后台角色均可进"""

    template_name = "admin/index.html"
    page_name = "工作台"
    nav_url = None

    def get_context(self) -> dict:
        users = UserRepository.get_all_users()
        admin_users = [u for u in users if u["role"] == "admin"]
        return {
            "total_users": len(users),
            "admin_count": len(admin_users),
            "user_count": len(users) - len(admin_users),
            "total_messages": MessageRepository.count_all(),
            "recent_users": list(reversed(users))[:5],
        }


class AdminUsersHandler(AdminBaseHandler):
    """用户管理页：框架壳，列表由 admin.js 走 /api/admin/users"""

    template_name = "admin/users.html"
    page_name = "用户管理"
    nav_url = URL_USERS


class AdminRolesHandler(AdminBaseHandler):
    """角色管理页：框架壳，列表/权限分配由 admin.js 走 /api/admin/roles"""

    template_name = "admin/roles.html"
    page_name = "角色管理"
    nav_url = URL_ROLES


class AdminMenusHandler(AdminBaseHandler):
    """菜单管理页：框架壳，树形列表/拖拽排序由 admin.js 走 /api/admin/menus"""

    template_name = "admin/menus.html"
    page_name = "菜单管理"
    nav_url = URL_MENUS


class AdminSourcesHandler(AdminBaseHandler):
    """信源管理页（任务5）：框架壳，列表由 admin.js 走 /api/admin/sources"""

    template_name = "admin/sources.html"
    page_name = "信源管理"
    nav_url = URL_SOURCES


# ==================== 数据接口（JSON API） ====================

class AdminApiHandler(AdminGuard):
    """后台数据接口基类：api=True（错误走 JSON），统一 JSON 解析与响应 + 分页参数"""

    api = True

    def current_user_id(self):
        row = UserRepository.get_user_by_username(self.current_user)
        return row["id"] if row else None

    def body(self) -> dict:
        try:
            return json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    @staticmethod
    def _page_args(handler):
        page = handler.get_argument("page", "1")
        keyword = (handler.get_argument("keyword", "") or "").strip()
        try:
            page = max(1, int(page))
        except ValueError:
            page = 1
        return page, keyword

    def ok(self, **data):
        self.write_json({"ok": True, **data})

    def fail(self, message: str, status: int = 400):
        self.write_json({"ok": False, "error": message}, status=status)


# -------------------- 用户管理 --------------------

class AdminUsersApiHandler(AdminApiHandler):
    """GET /api/admin/users 列表+分页+搜索 ；POST 新增用户"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_USERS):
            return
        page, keyword = self._page_args(self)
        role = (self.get_argument("role", "") or "").strip()
        self.ok(**UserRepository.paginate(keyword=keyword or None, role=role or None, page=page, limit=PAGE_SIZE))

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_USERS):
            return
        b = self.body()
        username = (b.get("username") or "").strip()
        password = b.get("password") or ""
        role = (b.get("role") or "user").strip()
        if not username or len(username) < 3 or len(username) > 32:
            self.fail("用户名需为3-32位")
            return
        if len(password) < 6:
            self.fail("密码长度不能少于6位")
            return
        if role and not RoleRepository.get_by_code(role):
            self.fail("所选角色不存在")
            return
        if not UserRepository.create_user(username, password, role):
            self.fail("用户名已存在")
            return
        self.ok()


class AdminUserItemHandler(AdminApiHandler):
    """POST /api/admin/users/<id> 更新 ；DELETE 删除单个用户"""

    @tornado.web.authenticated
    @backend_required
    def post(self, user_id):
        if not self.require_menu(URL_USERS):
            return
        b = self.body()
        username = (b.get("username") or "").strip() or None
        role = (b.get("role") or "").strip() or None
        password = b.get("password") or None
        if role and not RoleRepository.get_by_code(role):
            self.fail("所选角色不存在")
            return
        if password is not None and len(password) < 6:
            self.fail("密码长度不能少于6位")
            return
        before = UserRepository.get_user_by_id(int(user_id))
        if not before:
            self.fail("用户不存在", status=404)
            return
        if not UserRepository.update_user(int(user_id), username=username, role=role, password=password):
            self.fail("用户名已存在")
            return
        # 任务11：改密/改角色/改名后，该用户既有会话立即失效（需重新登录）
        if password or (role and role != before.get("role")) or (username and username != before.get("username")):
            SessionRepository.revoke_username(before["username"])
            if username and username != before["username"]:
                SessionRepository.revoke_username(username)
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, user_id):
        if not self.require_menu(URL_USERS):
            return
        if int(user_id) == self.current_user_id():
            self.fail("不能删除当前登录的账号")
            return
        target = UserRepository.get_user_by_id(int(user_id))
        UserRepository.delete_user(int(user_id))
        # 任务11：删除用户后清掉其全部会话，避免残留登录态指向已不存在的账号
        if target:
            SessionRepository.revoke_username(target["username"])
            SessionRepository.purge_expired()
        self.ok()


class AdminUsersBatchHandler(AdminApiHandler):
    """POST /api/admin/users/batch 批量删除，body: {ids:[...]}，自动排除自身账号"""

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_USERS):
            return
        ids = self.body().get("ids") or []
        try:
            ids = [int(i) for i in ids]
        except (TypeError, ValueError):
            self.fail("ids 必须为数字数组")
            return
        ids = [i for i in ids if i != self.current_user_id()]
        if not ids:
            self.fail("没有可删除的项（当前登录账号已排除）")
            return
        self.ok(deleted=UserRepository.delete_users(ids))


class AdminUserLogoutHandler(AdminApiHandler):
    """POST /api/admin/users/<id>/logout —— 强制下线该用户全部会话（任务11）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, user_id):
        if not self.require_menu(URL_USERS):
            return
        target = UserRepository.get_user_by_id(int(user_id))
        if not target:
            self.fail("用户不存在", status=404)
            return
        revoked = SessionRepository.revoke_username(target["username"])
        self.ok(username=target["username"], revoked=revoked)


class AdminLoginLogsApiHandler(AdminApiHandler):
    """GET /api/admin/login-logs —— 登录审计分页查询（仅用户管理权限可看）

    参数：page、keyword（用户名模糊）、result（success/fail/locked/logout/...）
    """

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_USERS):
            return
        page, keyword = self._page_args(self)
        result = (self.get_argument("result", "") or "").strip()
        self.ok(**LoginLogRepository.paginate(page=page, limit=PAGE_SIZE,
                                              username=keyword or None, result=result or None))


# -------------------- 角色管理 --------------------

class AdminRolesApiHandler(AdminApiHandler):
    """GET /api/admin/roles 列表+分页+搜索（all=1 返回全量供下拉，仅需后台身份）；POST 新增角色"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if self.get_argument("all", "") == "1":
            # 用户表单角色下拉：任意后台角色可读
            if not self.require_menu(None):
                return
            self.ok(list=RoleRepository.get_all())
            return
        if not self.require_menu(URL_ROLES):
            return
        page, keyword = self._page_args(self)
        self.ok(**RoleRepository.paginate(keyword=keyword or None, page=page, limit=PAGE_SIZE))

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_ROLES):
            return
        b = self.body()
        code = (b.get("code") or "").strip()
        name = (b.get("name") or "").strip()
        description = (b.get("description") or "").strip()
        home = (b.get("home") or "/").strip() or "/"
        if not code or not name:
            self.fail("角色编码与名称不能为空")
            return
        if not RoleRepository.create(code, name, description, home):
            self.fail("角色编码已存在")
            return
        self.ok()


class AdminRoleItemHandler(AdminApiHandler):
    """POST /api/admin/roles/<id> 更新（默认管理员不可改）；DELETE 删除角色（内置 admin/被占用不可删）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, role_id):
        if not self.require_menu(URL_ROLES):
            return
        b = self.body()
        err = RoleRepository.update(
            int(role_id),
            name=(b.get("name") or "").strip() or None,
            description=b.get("description") if b.get("description") is not None else None,
            home=(b.get("home") or "").strip() or None,
        )
        if err:
            self.fail(err["error"])
            return
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, role_id):
        if not self.require_menu(URL_ROLES):
            return
        err = RoleRepository.delete(int(role_id))
        if err:
            self.fail(err["error"])
            return
        self.ok()


class AdminRoleMenusHandler(AdminApiHandler):
    """GET /api/admin/roles/<id>/menus 返回菜单全树 + 该角色已分配 menu_ids；POST 保存分配"""

    @tornado.web.authenticated
    @backend_required
    def get(self, role_id):
        if not self.require_menu(URL_ROLES):
            return
        role = RoleRepository.get_by_id(int(role_id))
        if not role:
            self.fail("角色不存在", status=404)
            return
        self.ok(role=role, tree=MenuRepository.get_tree_all(), assigned=RoleRepository.get_menu_ids(int(role_id)))

    @tornado.web.authenticated
    @backend_required
    def post(self, role_id):
        if not self.require_menu(URL_ROLES):
            return
        rid = int(role_id)
        role = RoleRepository.get_by_id(rid)
        if not role:
            self.fail("角色不存在", status=404)
            return
        if role["code"] == "admin":
            self.fail("默认管理员拥有全部权限，无需分配")
            return
        ids = self.body().get("menu_ids") or []
        RoleRepository.set_menus(rid, ids)
        self.ok(assigned=RoleRepository.get_menu_ids(rid))


# -------------------- 菜单管理 --------------------

class AdminMenusApiHandler(AdminApiHandler):
    """GET /api/admin/menus 树形分页（tree=1 返回全树供分配, roots=1 一级下拉）；POST 新增菜单"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        # tree=1：角色分配页读取菜单结构，仅需后台身份
        if self.get_argument("tree", "") == "1":
            if not self.require_menu(None):
                return
            self.ok(list=MenuRepository.get_tree_all())
            return
        if not self.require_menu(URL_MENUS):
            return
        if self.get_argument("roots", "") == "1":
            self.ok(list=MenuRepository.get_roots())
            return
        page, keyword = self._page_args(self)
        self.ok(**MenuRepository.paginate_tree(keyword=keyword or None, page=page, limit=PAGE_SIZE))

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_MENUS):
            return
        b = self.body()
        name = (b.get("name") or "").strip()
        if not name:
            self.fail("菜单名称不能为空")
            return
        MenuRepository.create(
            parent_id=int(b.get("parent_id") or 0),
            name=name,
            icon=(b.get("icon") or "").strip(),
            url=(b.get("url") or "").strip(),
            description=(b.get("description") or "").strip(),
            sort=int(b.get("sort") or 0),
            enabled=1 if b.get("enabled", 1) in (1, "1", True, "true") else 0,
        )
        self.ok()


class AdminMenuItemHandler(AdminApiHandler):
    """POST /api/admin/menus/<id> 更新（含简介）；DELETE 删除菜单（有子菜单不可删）"""

    @tornado.web.authenticated
    @backend_required
    def post(self, menu_id):
        if not self.require_menu(URL_MENUS):
            return
        b = self.body()
        enabled = b.get("enabled")
        MenuRepository.update(
            int(menu_id),
            parent_id=int(b.get("parent_id")) if b.get("parent_id") is not None else None,
            name=(b.get("name") or "").strip() or None,
            icon=b.get("icon") if b.get("icon") is not None else None,
            url=b.get("url") if b.get("url") is not None else None,
            description=b.get("description") if b.get("description") is not None else None,
            sort=int(b.get("sort")) if b.get("sort") is not None else None,
            enabled=(1 if enabled in (1, "1", True, "true") else 0) if enabled is not None else None,
        )
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, menu_id):
        if not self.require_menu(URL_MENUS):
            return
        err = MenuRepository.delete(int(menu_id))
        if err:
            self.fail(err["error"])
            return
        self.ok()


class AdminMenusSortHandler(AdminApiHandler):
    """POST /api/admin/menus/sort 拖拽排序批量保存，body: {items:[{id,parent_id,sort},...]}"""

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_MENUS):
            return
        items = self.body().get("items") or []
        if not isinstance(items, list) or not items:
            self.fail("items 不能为空")
            return
        n = MenuRepository.save_sort(items)
        self.ok(saved=n)


# -------------------- 信源管理（任务5） --------------------

class AdminSourcesApiHandler(AdminApiHandler):
    """GET /api/admin/sources 列表+分页+搜索；POST 新增信源（Request Headers 支持 RAW 解析入库）"""

    @tornado.web.authenticated
    @backend_required
    def get(self):
        if not self.require_menu(URL_SOURCES):
            return
        page, keyword = self._page_args(self)
        data = SourceRepository.paginate(keyword=keyword or None, page=page, limit=PAGE_SIZE)
        for source in data['list']:
            source['channel_id'] = SourceRepository.channel_id(source['url'])
            source['source_type'] = 'qq_channel' if source['channel_id'] else 'web'
        self.ok(**data)

    @tornado.web.authenticated
    @backend_required
    def post(self):
        if not self.require_menu(URL_SOURCES):
            return
        b = self.body()
        name = (b.get("name") or "").strip()
        url = (b.get("url") or "").strip()
        raw = b.get("headers_raw") or ""
        if b.get('source_type') == 'qq_channel':
            try:
                url = SourceRepository.channel_url(b.get('channel_id'))
            except ValueError as exc:
                self.fail(str(exc))
                return
            raw = ''
        if not name:
            self.fail("信源名称不能为空")
            return
        if len(name) > 64:
            self.fail("信源名称不能超过64个字符")
            return
        if not url.startswith(("http://", "https://")):
            self.fail("URL 规格须以 http:// 或 https:// 开头")
            return
        headers = SourceRepository.parse_raw_headers(raw)
        if raw.strip() and not headers:
            self.fail("Request Headers RAW 解析失败，请检查格式")
            return
        enabled = 1 if b.get("enabled", 1) in (1, "1", True, "true") else 0
        if not SourceRepository.create(name, url, headers, (b.get("description") or "").strip(), enabled):
            self.fail("信源名称已存在")
            return
        self.ok()


class AdminSourceItemHandler(AdminApiHandler):
    """POST /api/admin/sources/<id> 更新（headers_raw 传空串则清空）；DELETE 删除信源"""

    @tornado.web.authenticated
    @backend_required
    def post(self, source_id):
        if not self.require_menu(URL_SOURCES):
            return
        b = self.body()
        name = (b.get("name") or "").strip() or None
        url = (b.get("url") or "").strip() or None
        if b.get('source_type') == 'qq_channel':
            try:
                url = SourceRepository.channel_url(b.get('channel_id'))
            except ValueError as exc:
                self.fail(str(exc))
                return
            b['headers_raw'] = ''
        if name is not None and len(name) > 64:
            self.fail("信源名称不能超过64个字符")
            return
        if url is not None and not url.startswith(("http://", "https://")):
            self.fail("URL 规格须以 http:// 或 https:// 开头")
            return
        headers = None
        if b.get("headers_raw") is not None:
            raw = b.get("headers_raw") or ""
            headers = SourceRepository.parse_raw_headers(raw)
            if raw.strip() and not headers:
                self.fail("Request Headers RAW 解析失败，请检查格式")
                return
        enabled = b.get("enabled")
        err = SourceRepository.update(
            int(source_id),
            name=name,
            url=url,
            headers=headers,
            description=b.get("description") if b.get("description") is not None else None,
            enabled=(1 if enabled in (1, "1", True, "true") else 0) if enabled is not None else None,
        )
        if err:
            self.fail(err["error"])
            return
        self.ok()

    @tornado.web.authenticated
    @backend_required
    def delete(self, source_id):
        if not self.require_menu(URL_SOURCES):
            return
        err = SourceRepository.delete(int(source_id))
        if err:
            self.fail(err["error"])
            return
        self.ok()
