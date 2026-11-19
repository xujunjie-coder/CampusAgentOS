# GovCheckDataAgentOS 目录框架（framework.md）

成员 B 的新增模块沿用现有分层。知识仓库与舆情由 `controllers/intelligence.py`、`services/intelligence_service.py`、`models/intelligence.py` 和后台模板承载，MCP 传输位于 `services/mcp_service.py`。配置和验收步骤见 [成员 B 开发与验收指南](member-b-development.md)。

> 本文件由 AI 助手自行维护，在每次任务节点按项目实际结构更新；目录用途注释为人类特定维护内容，保持不变。
> 最近更新：**v0.12.0 成员 C（2026-11-11）**——前端基建补齐并落地：`vendor/bootstrap`（5.3.3，完整版 + grid-only）与 `vendor/echarts`（5.5.1 + `china.json`）本地化，新增 `static/js/chart-kit.js`、`static/js/console-common.js`、`static/css/console.css` 三个公共底座；后台新增 `/admin/dashboard`（全屏数智大屏）、`/admin/reports`（统计报表）、`/admin/tools`（工具链路）、`/admin/settings`（系统设置，仅超管）四页并重建 `/admin/sentiment`（舆情预警台）；后端配套 `models/console.py`（大屏/报表只读聚合）、`services/settings_service.py`（设置读写 / `.env` 写回 / 图标上传 / 库切换）、`controllers/console.py`（9 个 Handler）+ 9 条路由 + `_seed_console_menus()` 菜单幂等种子；`models.js` Token 统计由手写图表改为 ECharts。此前：成员 D `/avatar` 3D 数字人升级为虚拟主播形态——本地 vendor 新增 `GLTFLoader.js` 与 pixiv 动漫风 VRM 模型 `three-vrm-girl.glb`（口型 morph + humanoid 骨骼），语音改浏览器原生 Web Speech API（离线零依赖，可静音），新增 `test_13_avatar_vtuber.py`；仍属未发布的成员 D 段。此前：成员 D 前台用户端增强五件套（/user 用户中心、/api/chat/export 对话导出 PDF、/avatar 3D 数字人、@音乐播放、/qa 智能问数）已落地，清单见文末附表；未发布，版本号待负责人切版时确定。此前 v0.11.0——任务9 数字员工模块（/admin/employees 橱窗 4 列 12/页 + 手写 MD 编辑器 + workspace 文件浏览，digital_employees 表，智能体按库装配）与任务10 数字助理选择（前台输入区选择器 + users.assistant_employee_id 关联持久化 + messages 应答助理身份 + /api/assistants）上线。此前任务5 信源/任务6 采集/任务7 数仓/任务8・8.1 模型引擎已并入。版本变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

```
D:.
|   .env                                # 环境变量（MODEL_ID / API_KEY / BASE_URL 等，供 agent_service 读取；含密钥，注意勿入库）
|   app.py                              # 运行入口，make_app() 后监听 10086 端口
|
+---app                                 # Web 应用主包（四层架构所在）
|   |   application.py                  # 应用装配：路由表 / 模板与静态目录 / 安全配置 / init_db()
|   |   __init__.py
|   |
|   +---controllers                     # 控制层：HTTP 请求处理
|   |       admin.py                    # 后台管理：AdminBaseHandler 页面壳 + AdminApiHandler 用户/角色/菜单/信源 JSON CRUD
|   |       assistant.py                # 数字助理选择（任务10）：/api/assistants 清单 + /api/assistants/select 持久化，pick_assistant 与对话同源
|   |       auth.py                     # 登录 / 注册 / 登出 Handler
|   |       base.py                     # BaseHandler：认证钩子 + write_json + SSE 封装
|   |       chat.py                     # /api/chat 流式对话（任务10 按所选助理应答 + assistant 事件）+ /api/history 历史记录
|   |       collect.py                  # 采集管理（任务6）：/collect 独立主页 + 选源/批量采集/橱窗列表 JSON API（线程池隔离阻塞）
|   |       employees.py                # 数字员工管理（任务9）：/admin/employees 页面壳 + 橱窗 CRUD/启停/设默认/workspace 文件浏览；停用删除联动清零用户助理关联（任务10）
|   |       model_engine.py             # 模型引擎管理（任务8）：/admin/models 页面壳 + OpenAI 范式 CRUD/设默认/SSE 测试 + token 统计接口
|   |       page.py                     # IndexHandler 主页（@authenticated）
|   |       warehouse.py                # 数据仓库（任务7）：/admin/warehouse 页面壳 + CRUD/分页20/详情/信源与原数据 + 单一/批量深采 SSE 接口
|   |       __init__.py
|   |
|   +---models                          # 模型层：Repository 数据访问
|   |       collect.py                  # CollectRepository：采集数据批量去重入库 + 橱窗分页（12/页，标题/关键词/信源过滤）
|   |       db.py                       # get_connection() / init_db() 幂等建表 + 补列 + 种子 + 约束修复
|   |       digital_employee.py         # DigitalEmployeeRepository：digital_employees 智能体配置 CRUD + 唯一默认 + 橱窗分页12/页（任务9）
|   |       menu.py                     # MenuRepository：两级菜单树、get_nav_tree() 驱动侧边导航
|   |       message.py                  # MessageRepository：会话记录读写（强制 username 隔离；任务10 随行存取应答助理身份）
|   |       model_engine.py             # ModelEngineRepository：模型接入配置 CRUD + 唯一默认(is_default) + 橱窗分页4/页（任务8）
|   |       role.py                     # RoleRepository：角色 CRUD（code 唯一、内置与占用角色删除保护）
|   |       source.py                   # SourceRepository：信源 CRUD + parse_raw_headers（DevTools RAW/标准格式解析入库）
|   |       token_stats.py              # TokenStatsRepository：模型调用 token 流水与聚合统计（任务8.1，model_token_logs）
|   |       user.py                     # UserRepository：PBKDF2 加盐哈希、登录校验、分页与增删改 + 用户↔助理关联偏好（任务10）
|   |       warehouse.py                # WarehouseRepository：warehouse_data 深采正文 UPSERT + 分页20/过滤/详情/批量删除（任务7）
|   |       __init__.py
|   |
|   +---services                        # 服务层：Agentica 智能体编排
|   |       agent_service.py            # build_agent 按库内所选助理装配 / get_agent (user_id, employee_id) 缓存 / resolve_employee 逐级解析 / stream_answer SSE 事件流
|   |       collect_service.py          # 采集编排（任务6）：占位符解析/URL构建/抓取/大模型+智能体解析（回退启发式）/落库
|   |       model_service.py            # 模型引擎测试通道（任务8）：AsyncHTTPClient 流式对话/向量/图片 SSE + token 用量采集
|   |       warehouse_service.py        # 深度采集编排（任务7）：Crawl4AI/requests 双路抓取 + AI 默认模型分析(回退规则) + 落库 + 进度事件
|   |       __init__.py
|   |
|   +---static                          # 表现层：静态资源
|   |   +---css
|   |   |       admin.css               # 后台管理页样式（布局、表格、弹层）
|   |   |       base.css                # 全局样式 + 对话页全屏布局 + 数字助理选择器/气泡署名/toast（任务10）
|   |   |       collect.css             # 采集中心独立主页样式（任务6）：科技感主题 + 橱窗 3 列响应式
|   |   |       employees.css            # 数字员工橱窗与 MD 编辑器/文件浏览样式（任务9）：4 列 grid 响应式
|   |   |       models.css              # 模型引擎管理橱窗与测试/统计弹层样式（任务8）：卡片色饰条 + token 反馈 + 图表
|   |   +---js
|   |   |       admin.js                # 后台各模块（用户/角色/菜单/信源）：列表/搜索/laypage 分页/layer 弹层表单/批量删除
|   |   |       base.js                 # 全局脚本（导航抽屉等通用交互）
|   |   |       chat.js                 # 对话页：轻量 Markdown 渲染 + SSE 事件消费 + 输入区数字助理选择器（任务10）
|   |   |       collect.js              # 采集中心（任务6）：选源/参数配置/批量采集/橱窗分页（零 layui）
|   |   |       employees.js            # 数字员工（任务9）：橱窗渲染/手写 MD 编辑器三态/workspace 文件浏览/工具勾选（零第三方）
|   |   |       models.js               # 模型引擎管理（任务8）：橱窗渲染/表单/设默认/流式测试/Token 统计弹层
|   |   \---vendor                      # 第三方前端组件（本地入库，不依赖外网 CDN）
|   |       +---fontawesome             # FontAwesome 5（css/all.min.css + webfonts/*）
|   |       \---layui                   # layui 2.x（css/layui.css + font/* + layui.js）
|   |
|   \---templates                       # 表现层：Tornado 模板
|       |   base.html                   # 基模板：声明 block content / block scripts，含 _xsrf 隐藏表单
|       |   collect.html                # 采集中心独立主页（任务6）：不继承基模板、零 layui，三区布局
|       |   index.html                  # 主页：AI 对话界面（左侧栏 + 消息区 + composer 内数字助理选择器，任务10）
|       |   login.html                  # 登录页
|       |   register.html               # 注册页（layui 表单）
|       \---admin                       # 后台管理模板
|           |   base.html               # 后台基模板：侧边导航（数据库驱动）+ 内容区
|           |   index.html              # 后台首页（概览）
|           |   employees.html           # 数字员工（任务9）：功能区/橱窗区/分页区壳
|           |   menus.html              # 菜单管理
|           |   models.html             # 模型引擎管理（任务8）：橱窗壳 + 卡片网格 + 统计/测试入口
|           |   roles.html              # 角色管理
|           |   sources.html            # 信源管理（任务5）
|           |   users.html              # 用户管理
|           \   warehouse.html          # 数据仓库（任务7）：功能区/列表区/分页区三段式 20/页壳
|
+---database                    #项目数据仓库，包括数据库配置或文件或与数据有关的存储都放置于此
+---dist                        #项目所需要用到的第三方模块，供你提取应用于项目开发（当前为空）
+---docs                         #vibecoding所需要的工程资料，用于你理解开发要求和管理开发进度，该目录中的资料除人类特定维护的文件外，其他文件由你自行维护，确保项目持续迭代。文件在每次任务节点时，自行维护。
|       agent_roles.md                   # 协作规则（发布决策权 / 版本号规则 / 工作流范式）——人类特定维护
|       architecture.md                  # 架构设计说明（分层详解 / 编码规范 / 业务流程 / 进度与待完善清单）
|       CHANGELOG.md                     # 版本变更日志（每个版本的新增/变更/修复/清理），本次新建
|       codingPrompt.md                  # 编码任务提示词资料（任务1～10，任务9 数字员工、任务10 数字助理选择）
|       framework.md                     # 本文件，目录框架
|       requirements.md                  # 需求说明（当前为空文件，待人类补充）
|       VERSION                          # 当前开发版本号，与 git tag 保持一致（见 agent_roles.md 第二节）
|
+---tests                        #测试用例的脚本目录，所有测试脚本都放于此，只能增加，不能删减。不要将测试脚本或临时程序写到此外其他地方。
|       preview_collect.py               # 采集主页浏览器 UI 验证预览环境（临时库+夹具信源，10087 端口），python tests/preview_collect.py 运行
|       preview_warehouse.py             # 数据仓库浏览器 UI 预览引导（夹具详情页服务+演示数据+应用，10086 端口），python tests/preview_warehouse.py 运行
|       smoke_admin.py                   # 后台管理真实 HTTP 冒烟（登录/CRUD/403/删除保护），python tests/smoke_admin.py 运行
|       smoke_assistant.py               # 数字助理选择冒烟（底座补列/选择持久化/对话身份链路/解析优先级/缓存隔离/后台联动，48 项），python tests/smoke_assistant.py 运行
|       smoke_collect.py                 # 采集管理冒烟（占位符/URL构建/双引擎解析/采集去重/橱窗分页/菜单鉴权），python tests/smoke_collect.py 运行
|       smoke_employees.py               # 数字员工冒烟（种子入库/CRUD校验/防穿越/分页/默认让位/读库装配/权限，36 项），python tests/smoke_employees.py 运行
|       smoke_models.py                  # 模型引擎管理冒烟（种子/CRUD/默认唯一/SSE 流式对话与 token），python tests/smoke_models.py 运行
|       smoke_sources.py                 # 信源管理冒烟（RAW解析/CRUD/分页/菜单鉴权），python tests/smoke_sources.py 运行
|       smoke_warehouse.py               # 数据仓库冒烟（正文抽取/分析/深采链路/SSE 单一与批量/CRUD分页/权限，48 项），python tests/smoke_warehouse.py 运行
|       verify_assistant_ui.py           # 数字助理选择 Playwright 真实渲染复验（自起临时库隔离服务，21 项），python tests/verify_assistant_ui.py 运行
|       verify_employees_ui.py           # 数字员工 Playwright 真实渲染复验（4 列橱窗/MD 三态/文件浏览/保存设默认删除，25 项），python tests/verify_employees_ui.py 运行
|       verify_models_ui.py              # 模型引擎管理 Playwright 真实渲染复验，python tests/verify_models_ui.py 运行
|       test_user.py                     # 用户注册 / 登录校验脚本，python tests/test_user.py 运行
|
+---venv                         #项目的虚拟空间，由python -m venv venv得到，项目需要在虚拟空间中完成运行和开发。
|
\---workspace                    #agentica智能体生成的用户级工作空间，你开发时，不要乱动。（agent_service 按 user_id 在此隔离生成，用于长期记忆；已 gitignore 不入库）
```

## 附：任务11～18 新增文件（成员 A）

| 路径 | 职责 |
| --- | --- |
| `app/config.py` | 配置中心：唯一读取 `.env` 的地方，类型转换 + 启动期严格校验（`ConfigError`） |
| `.env.example` | 配置样例（占位符，无真实密钥）；本仓库 `.env` 按团队决定亦入库，提交前需自行确认不含敏感凭据 |
| `requirements.txt` | 运行依赖清单（pymysql 标注为多库可选依赖） |
| `app/models/session.py` | 会话（只存 token SHA256）+ 登录审计 Repository |
| `app/models/face.py` | 人脸特征加密存储（Fernet，密钥由 `COOKIE_SECRET` 派生） |
| `app/services/face_service.py` | 人脸引擎抽象：ONNX（真实精度）/ fallback（兜底演示）、图片校验与相似度 |
| `app/controllers/face.py` | 人脸状态/录入/校验/删除、刷脸登录、后台人脸管理接口 |
| `app/controllers/errors.py` | `APIError` 与异常映射（HTTP/DB/参数 → 中文文案 + code） |
| `app/controllers/sse.py` | `SSEMixin`（统一响应头/事件编码/心跳/收尾）与 `SSEBridge`（线程池→SSE） |
| `app/controllers/ws.py` | WebSocket 基类（会话鉴权、Origin 白名单、协议、心跳、连接注册表、踢下线） |
| `app/controllers/health.py` | `/healthz` 健康检查（匿名、无配置泄露） |
| `app/templates/error.html` | 统一错误页（状态码 + 文案 + 请求编号） |
| `app/static/js/face.js` | 任务18 前台「人脸设置」：摄像头取帧、照片上传、录入/删除、人脸登录总开关、降级提示 |
| `app/static/css/face.css` | 人脸设置弹层样式（左右分栏 + 375 宽小屏适配） |
| `tests/smoke_config.py` `smoke_auth.py` `smoke_db.py` `smoke_db_mysql.py` `smoke_face.py` `smoke_errors.py` `smoke_stream.py` | 任务11～18 的冒烟/联调用例（共 273 项） |
| `tests/verify_face_ui.py` | 任务18 前台人脸设置 Playwright UI 复验（25 项，隔离临时库 + 随机端口） |

## 附：成员 E 新增文件（定时任务 / 消息通知 / 数据统计）

| 路径 | 职责 |
| --- | --- |
| `app/models/task.py` | ScheduledTaskRepository（周期任务配置 CRUD / 启停 / 运行回写 / 分页）+ TaskLogRepository（执行流水 start/finish/paginate/purge） |
| `app/models/stats.py` | StatsRepository（面向大屏/报表的只读聚合：总览/趋势/信源/风险/热词）+ MessageArchiveRepository（历史会话自动归档） |
| `app/services/scheduler_service.py` | 定时任务调度核心：APScheduler 优先、缺失降级 tornado；execute_task 派发内置任务 + 通知；start/stop/reload_jobs/status |
| `app/services/notify_service.py` | 邮件 / QQ 通知封装：标准库 smtplib + webhook，未配置显式降级（不引新依赖、不外泄口令） |
| `app/controllers/tasks.py` | `/admin/tasks` 页面壳 + 任务 CRUD / toggle / run / task-logs / scheduler / notify-test JSON API |
| `app/controllers/stats.py` | `/api/stats/*` 只读统计接口（overview/trend/by-source/by-risk/keywords/report） |
| `app/templates/admin/tasks.html` | 定时任务管理页壳：调度器状态条 + 功能区 / 列表区 / 分页区 |
| `app/static/js/tasks.js` | 定时任务前端：列表/搜索/分页、新增编辑弹层（调度方式切换 + 类型参数 + 通知策略）、手动运行 / 启停 / 删除 / 执行日志 / 重载调度 / 通知测试 |
| `app/static/css/tasks.css` | 定时任务页样式（状态条 / 任务行 / 状态徽标 / 参数区 / 日志弹层） |
| `tests/smoke_tasks.py` | 定时任务 / 通知 / 统计 / CRUD 冒烟（33 项，SCHEDULER_ENABLED=0 走手动触发路径，隔离临时库） |

## 附：成员 E 新增文件（通知配置页 / 会话管理三页）

| 路径 | 职责 |
| --- | --- |
| `app/models/settings.py` | `SystemSettingsRepository`：`system_settings` key-value 表底座（get/get_many/get_all/set/set_many/delete），通知项 `notify_` 前缀 |
| `app/models/message.py`（扩展） | `MessageRepository.admin_paginate/admin_get/admin_delete/admin_delete_batch/admin_count` + `_admin_where` 辅助，供后台跨用户查看与清理 |
| `app/models/session.py`（扩展） | `SessionRepository.admin_paginate`（active/revoked/expired/all）、`admin_stats`（三态计数）、`revoke_by_id`（不依赖 token 明文） |
| `app/models/stats.py`（扩展） | `MessageArchiveRepository.paginate` 支持 username/session_id/role/keyword/时间区间多条件筛选 |
| `app/controllers/archives.py` | `/admin/archives` 页面壳 + `message_archives` 分页 JSON API |
| `app/controllers/messages.py` | `/admin/messages` 页面壳 + 列表/批量删除 + 详情/单条删除 JSON API |
| `app/controllers/sessions.py` | `/admin/sessions` 页面壳 + 会话列表/概况 + 撤销/批量下线/清理 JSON API（撤销联动 `ws.kick_user`） |
| `app/templates/admin/notify.html` | 通知配置页壳：渠道可用性状态条 + 邮件/QQ 分组表单 + 保存与测试 |
| `app/templates/admin/archives.html` | 会话归档页壳：状态条 / 筛选区 / 列表区 / 分页区 |
| `app/templates/admin/messages.html` | 对话记录页壳：统计条 / 六条件筛选 / 全选列表 / 分页区 |
| `app/templates/admin/sessions.html` | 临时会话页壳：三态概况卡 / 筛选+撤销+批量下线+清理 / 分页区 |
| `app/static/js/notify.js` | 通知配置前端：动态渲染字段、敏感位脱敏回填、保存与渠道测试 |
| `app/static/js/archives.js` | 会话归档前端：多条件筛选、分页、详情查看 |
| `app/static/js/messages.js` | 对话记录前端：筛选/分页/全选/批量删除/详情弹层/单条删除 |
| `app/static/js/sessions.js` | 临时会话前端：筛选/分页/撤销单条/按用户下线/清理已撤销与过期 |
| `app/static/css/{notify,archives,messages,sessions}.css` | 上述四页状态条/概况卡/工具栏/弹层样式 |
| `tests/verify_messages_sessions.py` | 对话记录 + 临时会话验收（52 项）：页面渲染、全量筛选、分页越界、详情、删除、会话撤销/下线/清理、菜单注册；写操作只走自建测试数据并自清理 |

## 附：成员 D 新增文件（前台用户端增强：用户中心 / 导出PDF / 3D数字人 / @音乐 / 智能问数）

| 路径 | 职责 |
| --- | --- |
| `app/controllers/user.py` | `/user` 页壳 + `/api/user/profile`（档案查看/昵称头像保存）+ `/api/user/password`（本人改密，旧会话全部失效重签）+ `/api/user/sessions`（本人活跃会话） |
| `app/controllers/chat_export.py` | `GET /api/chat/export?session_id=` 当前会话导出真 PDF 附件（reportlab，只导本人会话） |
| `app/controllers/music.py` | `GET /api/music/search` 曲库检索（空词=热门）+ `POST /api/music/play` 取播放地址并 play_count+1 |
| `app/controllers/qa.py` | `/qa` 页壳 + `POST /api/qa/ask`（问数出报告落库）+ `/api/qa/history` + `/api/qa/report/(id)`（用户隔离，越权 404） |
| `app/controllers/avatar.py` | `GET /avatar` 3D 数字人页壳（对话复用 `/api/chat` SSE，后端零新增推理） |
| `app/services/pdf_service.py` | reportlab Platypus 渲染对话 PDF；`STSong-Light` CJK 字体纯本地离线，文本转义防注入 |
| `app/services/qa_service.py` | 问数编排：采集/数仓/会话只读统计上下文 → 大模型优先出结构化报告，失败降级启发式；契约恒定含 source 标注 |
| `app/models/music.py` | `MusicRepository`：`music_tracks` 表 LIKE 检索/热门/get/bump_play |
| `app/models/qa.py` | `QaRepository`：`qa_reports` 落库与用户隔离查询（save/list_recent/get） |
| `app/models/user.py`（扩展） | `get_profile`/`update_profile`/`change_password`（成员 D 段，昵称/头像自助维护与本人改密，不回哈希/盐值） |
| `app/models/db.py`（扩展） | 末尾「成员 D」段：`music_tracks`/`qa_reports` 建表、`users.nickname/avatar` 补列、6 首内置曲库幂等种子 |
| `app/templates/{user,qa,avatar}.html` | 三个前台新页壳（继承 base.html，用户侧栏入口） |
| `app/static/js/{user,qa,avatar}.js` | 用户中心/智能问数（零依赖 canvas 图表）/3D 数字人（VRM 虚拟主播：GLTFLoader 加载 + morph 口型 + Web Speech API 朗读，失败降级程序化人形）前端 |
| `app/static/css/{user,qa,avatar}.css` | 上述三页样式 |
| `app/static/music/*.wav` | 6 首离线合成示例曲目（由 `tests/gen_music_wavs.py` 标准库 wave 合成，固定种子可重生成） |
| `app/static/vendor/three/three.min.js` | three.js r128 本地 vendor（不依赖外网 CDN） |
| `app/static/vendor/three/GLTFLoader.js` | three.js r128 配套 glTF/VRM 加载器本地 vendor（examples/js 非模块版，挂全局 THREE） |
| `app/static/vendor/three/models/three-vrm-girl.glb` | 动漫风 VRM 数字人模型（pixiv three-vrm 示例，2.6MB，43 表情 morph + humanoid 骨骼，本地分发零下载） |
| `app/static/js/chat.js` / `app/templates/index.html` / `app/static/css/chat.css`（改造） | @音乐前缀拦截与播放卡片、导出 PDF 按钮、侧栏 我的/数字人/问数 入口 |
| `requirements.txt`（改造） | 新增 `reportlab==5.1.0`（对话导出 PDF 服务端渲染） |
| `tests/gen_music_wavs.py` | 曲库音频生成脚本（python tests/gen_music_wavs.py 重跑即可幂等重建 6 首 wav） |
| `tests/pytest/test_09_user_center.py` `test_10_chat_export_pdf.py` `test_11_music.py` `test_12_qa.py` `test_13_avatar_vtuber.py` | 成员 D 五项能力 pytest 用例（共 38 项，隔离临时库、不依赖网络/大模型） |

## 附：成员 C 新增文件（前端基建 + 数智大屏 / 统计报表 / 智能舆情 / 工具链路 / 系统设置）

| 路径 | 职责 |
| --- | --- |
| `app/static/vendor/echarts/echarts.min.js` | ECharts 5.5.1（1.03 MB），从 npm 中文镜像 `echarts-5.5.1.tgz` 取 `dist/echarts.min.js`，离线可用 |
| `app/static/vendor/echarts/china.json` | 中国省级地图 GeoJSON（61 KB，34 个省级 feature，简称与后端 `PROVINCES` 一致），供 `echarts.registerMap('china')` |
| `app/static/vendor/bootstrap/bootstrap.min.css` | Bootstrap 5.3.3 完整版（232 KB），供需要组件的独立页使用 |
| `app/static/vendor/bootstrap/bootstrap-grid.min.css` | Bootstrap 5.3.3 仅栅格/flex/间距版（51 KB，不含 Reboot），后台壳在 layui 之后引入，避免覆盖 layui 按钮/表单 |
| `app/static/js/chart-kit.js` | ECharts 统一封装：`init/dispose/setOption` + `renderLine/renderBar/renderPie/renderChinaMap/renderRankBar` + `exportPng` + `loadChinaMap`（XHR 懒加载并缓存 Promise）+ 空态 `.ck-empty` + `ResizeObserver` 自适应 + 明暗两套主题色 |
| `app/static/js/console-common.js` | 页面公共工具：`api`（自动带 `X-Xsrftoken`，401 跳 `/auth/login?next=`，`ok:false` 抛错）、`esc/fmtNum/fmtTime/toast/debounce/tabSwitch/xsrf` |
| `app/static/css/console.css` | 五页共用样式：亮色 `.ck-*`（面板/KPI/分段器/徽标/表格/图例/风险流/设置卡）+ 暗色大屏 `.ckb-*`（全屏网格/面板/KPI/预警流/问答浮层/底部滚动/热词）+ 1200px/860px 两档窄屏兜底 |
| `app/models/console.py` | `ConsoleStatsRepository`：`by_region`（34 省文本提及口径 + `_PROVINCE_ALIASES` 省会/计划单列市映射）、`latest_risks`、`risk_trend`（7 日四等级）、`recent_items`、`snapshot`（大屏/报表/预警台共用一次聚合）；只读、参数化 SQL、扫描行数上限 3000 |
| `app/services/settings_service.py` | 系统设置服务：`DEFAULTS/GROUPS` 白名单、`branding()` 20 秒缓存（供 `BaseHandler.render` 注入）、`load_all`、`save`（分组校验 + `.env` 写回）、`save_brand_image`（真实字节校验、≤64 KB、随机文件名）、`test_database`、`switch_database`（先测后切 + 失败回滚 + `init_db()`） |
| `app/controllers/console.py` | 9 个 Handler：大屏/报表/工具/设置四页 + `/api/stats/snapshot`、`/api/stats/stream`（SSE）、`/api/dashboard/ask`、`/api/admin/tools`、`/api/admin/settings`；含 `TOOL_META` 六工具元数据、`_answer_question` 九类意图确定性直答、`_registry_snapshot` 绑定矩阵 |
| `app/templates/admin/dashboard.html` | 数智大屏全屏模板（独立 DOCTYPE，不继承五段式壳）：6 KPI + 5 面板 + 底部滚动 + 语音问答浮层 + 隐藏 xsrf 表单 |
| `app/templates/admin/reports.html` | 统计报表页壳：时段/实时开关/导出工具条 + 6 KPI + 6 面板（趋势/风险饼/信源/风险走势/热词/最新清单） |
| `app/templates/admin/sentiment.html`（重建） | 舆情预警台：服务端渲染首屏 reviews + 四等级 KPI + 等级筛选 + 处置说明；WebSocket 增量由 JS 接管 |
| `app/templates/admin/tools.html` | 工具链路页壳：搜索 + 4 KPI + 工具×员工绑定矩阵表 |
| `app/templates/admin/settings.html` | 系统设置页壳（仅超管）：系统标识 / 数据库 / 语音与人脸 / 安全与会话 四张 layui 表单卡 |
| `app/static/js/dashboard.js` | 大屏：SSE 消费（bootstrap/snapshot/onerror + 3 秒快照兜底）、4 张图表、预警流/滚动条/热词、TTS 播报（新高风险增量提醒）、Web Speech ASR（不支持时显式提示）、全屏/刷新/播报开关 |
| `app/static/js/reports.js` | 报表：双 Y 轴趋势（三系列可勾选图例）、风险饼、信源排行/占比切换、7 日风险堆叠柱、热词、最新清单、分区 PNG 导出、SSE 开关 |
| `app/static/js/sentiment.js`（重建） | 舆情：WS 全量替换、等级筛选、高风险高亮/提示音（WebAudio）/桌面通知、退避重连、7 日走势 |
| `app/static/js/tools.js` | 工具链路：拉取 `/api/admin/tools`、KPI 汇总、工具行渲染、本地搜索 |
| `app/static/js/settings.js` | 系统设置：品牌保存、Logo/Favicon 上传（data URI → 接口落盘）、驱动切换显隐、连通性测试、切换确认（成功回登录页）、TTS 声音列表、安全参数保存 |
| `app/controllers/base.py`（覆写 `render`） | 所有页面渲染前注入 `site_name/site_subtitle/site_logo/site_favicon`，异常时回退默认值，保证品牌配置全站生效 |
| `app/models/db.py`（`_seed_console_menus()`） | 菜单幂等种子：新增「数据看板」分组（数智大屏/统计报表）、智能体服务下「工具链路」、系统管理下「系统设置」；「智能舆情」「知识仓库」仅在 `parent_id==0` 时归位，不覆盖人工排序 |
| `app/static/js/models.js`（改造） | Token 统计弹层改 ECharts：双折线趋势 + 横向排行条，echarts/chart-kit 按需动态注入，弹层关闭 `dispose` |
| `tests/pytest/test_14_dashboard_reports.py` | 大屏/报表/快照/问答 14 项：页面挂载 vendor、快照键集、地域口径、省份与 china.json 对齐、问答分支、未登录拦截 |
| `tests/pytest/test_15_settings.py` | 系统设置/工具链 13 项：设置读取、品牌保存全站生效、空/超长名校验、图标白名单、库测试分支、禁止同驱动切换、工具接口形状、非超管 403 |

**设计口径**

1. **地图不伪造地理分布**：`warehouse_data` / `collect_items` 均无 `region` 字段，大屏地图按「标题/摘要文本中出现的省级行政区或省会城市」计数，页面固定展示口径说明；拿到 A/B 侧 `region` 字段后可替换为真实采集地分布，前端契约不变。
2. **一条 SSE 供两页**：大屏与报表共用 `/api/stats/stream`（`interval` 可调），舆情不迁移、继续用既有 WS，避免两套推送口径互相打架。
3. **bootstrap 只做栅格**：后台壳只引 `bootstrap-grid.min.css`（无 Reboot），按钮/表单/弹层一律 layui；大屏独立页可同时引 grid 与完整版，两套样式不交叉污染。


