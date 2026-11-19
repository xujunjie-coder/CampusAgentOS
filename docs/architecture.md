# GovCheckDataAgentOS 架构设计说明

> 项目代号：某省数据瞭望系统（GovAgentOS）
> 技术框架：**Tornado（Web 层） + Agentica（智能体层） + SQLite（持久层）**
> 运行入口：根目录 [`app.py`](../app.py)，默认监听端口 `10086`

---

## 一、整体设计思路

本项目采用典型的 **分层架构（Layered Architecture）**，自上而下分为四层，各层职责单一、依赖方向严格向下（上层可依赖下层，下层不反向依赖上层）：

```
┌─────────────────────────────────────────────┐
│  表现层  templates / static（前端页面与资源）    │  Tornado 模板渲染 + 静态文件
├─────────────────────────────────────────────┤
│  控制层  app/controllers（Handler 路由与请求处理）│  Tornado RequestHandler
├─────────────────────────────────────────────┤
│  服务层  app/services（智能体业务编排）           │  Agentica Agent 封装
├─────────────────────────────────────────────┤
│  模型层  app/models（数据访问 Repository）        │  SQLite 数据读写
└─────────────────────────────────────────────┘
```

设计目标：
- **Web 框架轻量化**：使用 Tornado 的原生异步 / 协程能力，天然支持聊天场景的长连接与流式响应（SSE）。
- **智能体能力解耦**：将 Agentica 智能体逻辑集中在 `services` 层，控制器只做请求转发，便于替换/升级智能体实现。
- **数据访问可移植**：持久层仅依赖 Python 内置 `sqlite3`，数据库即一个文件（`database/govagentos.db`），零额外部署成本。

---

## 二、目录结构与分层映射

| 目录 / 文件 | 所属层 | 职责说明 |
| --- | --- | --- |
| [`app.py`](../app.py) | 启动入口 | 创建应用（`make_app`）、监听端口、启动 IOLoop 事件循环 |
| [`app/application.py`](../app/application.py) | 应用装配 | 维护路由表、模板/静态目录配置、安全配置、启动前 `init_db()` |
| `app/controllers/` | 控制层 | HTTP 请求处理，路由到具体 Handler |
| `app/services/` | 服务层 | 智能体业务编排（对接 Agentica） |
| `app/models/` | 模型层 | 数据库访问（Repository 模式） |
| `app/templates/` | 表现层 | Tornado 模板（`.html`） |
| `app/static/` | 表现层 | CSS / JS 静态资源 |
| `database/` | 持久层 | SQLite 数据库文件 |
| `tests/` | 测试 | 独立脚本式测试用例 |
| `workspace/` | 工作区 | 智能体运行时产物目录（预留） |

---

## 三、各层设计详解

### 3.1 应用装配层（application.py）

[`make_app()`](../app/application.py) 是整个 Web 应用的组装工厂，负责：

1. **启动初始化**：在返回应用前先调用 `init_db()`，保证数据库表结构就绪。
2. **路由表维护**：以正则 → Handler 的列表声明路由，形成对外 API 面貌：

   | 路由 | Handler | 说明 |
   | --- | --- | --- |
   | `/` | `IndexHandler` | 主页（需登录） |
   | `/collect` | `CollectPageHandler` | 采集中心独立主页（任务6，需登录+后台角色+菜单鉴权，无 layui） |
   | `/api/chat` | `ChatHandler` | 对话接口，SSE 流式返回（任务10：接受 `employee_id`，首帧 `assistant` 事件下发应答助理） |
   | `/api/history` | `HistoryHandler` | 当前用户会话历史（JSON，任务10 随行返回应答助理身份） |
   | `/api/assistants` | `AssistantListApiHandler` | 数字助理清单与当前生效选择（任务10，仅需登录） |
   | `/api/assistants/select` | `AssistantSelectApiHandler` | 保存用户↔数字助理关联（任务10，`0`=跟随系统默认） |
   | `/api/collect/sources` | `CollectSourcesApiHandler` | 采集选源：启用信源 + URL 占位符元数据 |
   | `/api/collect/run` | `CollectRunApiHandler` | 批量采集（线程池执行，单源失败不中断） |
   | `/api/collect/items` | `CollectItemsApiHandler` | 采集数据橱窗列表（12 条/页） |
   | `/admin/warehouse` | `WarehousePageHandler` | 数据仓库后台页（任务7，layui 三段式 20/页） |
   | `/api/admin/warehouse*` | `Warehouse*ApiHandler` | 数仓 CRUD/分页/过滤/详情/批量删除/信源与原数据选项 |
   | `/api/warehouse/deep/one` `/api/warehouse/deep/batch` | `DeepCollect*ApiHandler` | 单一/批量深度采集（线程池执行 + SSE 实时推送执行面板事件） |
   | `/admin`、`/admin/users\|roles\|menus\|sources\|models\|employees` | `Admin*Handler` | 后台管理页面（任务3～9，layui 框架） |
   | `/api/admin/*` | `Admin*ApiHandler` | 后台用户/角色/菜单/信源 CRUD 接口 |
   | `/auth/login` | `LoginHandler` | 登录 |
   | `/auth/register` | `RegisterHandler` | 注册（业务未实现） |
   | `/auth/logout` | `LogoutHandler` | 登出 |
   | `/static/(.*)` | `StaticFileHandler` | 静态资源 |

3. **全局配置**：`template_path`、`static_path` 定位资源；`cookie_secret` 用于签名 Cookie；`login_url` 指定未登录跳转地址；`xsrf_cookies=True` 开启 CSRF 防护；`debug=True` 开发模式。

### 3.2 控制层（controllers）

- [`base.py`](../app/controllers/base.py) 定义公共基类 `BaseHandler`，向所有 Handler 提供三项通用能力：
  1. `get_current_user()`：从**签名 Cookie** 中读取用户名，作为 Tornado 认证机制的钩子（配合 `@authenticated` 装饰器实现登录拦截）。
  2. `write_json()`：统一的 JSON 响应封装，`ensure_ascii=False` 保证中文不被转义。
  3. `sse()`：静态方法，将事件封装为 **Server-Sent Events** 报文文本，为智能体流式输出预留通道。

- [`page.py`](../app/controllers/page.py)：`IndexHandler` 用 `@tornado.web.authenticated` 保护，渲染主页并回显当前登录用户。
- [`auth.py`](../app/controllers/auth.py)：登录/注册/登出三个 Handler，遵循**传统表单提交范式**——成功用 `redirect` 重定向，失败用 `render` 回显 `error` 变量；XSRF token 由模板 `{% module xsrf_form_html() %}` 自动生成。登录成功后通过 `set_secure_cookie("username", ...)` 写入签名 Cookie。
- [`chat.py`](../app/controllers/chat.py)：**（已实现）** 控制层与 `services` 智能体层的桥梁。
  - `ChatHandler POST /api/chat`：校验登录与 JSON 请求体中的 `message` 字段 → 任务10：经 `pick_assistant` 解析本次应答助理（显式 `employee_id` > 已保存助理 > 默认员工，非法/停用直接 400 JSON 不进 SSE）→ `MessageRepository.save` 落库用户提问 → 设置 `text/event-stream` 响应头 → 先下发 `assistant` 事件声明本轮应答身份 → `async for` 消费 `agent_service.stream_answer` 产出的事件字典，按 `delta`（增量文本）/ `tool`（工具名与参数，前端渲染调用时间线）/ `reasoning`（思维链）/ `done`（汇总答案携助理身份落库）分类经 `BaseHandler.sse()` 封装回传，异常时下发 `error` 事件。
  - `HistoryHandler GET /api/history`：按 `limit`（默认 50）返回当前用户历史记录（含 `employee_id`/`employee_name`）。
- [`assistant.py`](../app/controllers/assistant.py)：**（任务10 已实现）** 前台数字助理选择控制层。`AssistantListApiHandler` 返回启用助理清单与当前生效选择；`AssistantSelectApiHandler` 保存用户关联（`employee_id=0` 恢复跟随默认）；共享函数 `pick_assistant` 统一存在性/启用态校验与关联落库（与 `/api/chat` 同源，避免「能选上但对话报错」），`assistant_brief` 收敛下发字段（不含 instructions 大正文）；仅 `@authenticated`，不校验后台菜单。
- [`collect.py`](../app/controllers/collect.py)：**（任务6 已实现）** 采集管理控制层。`CollectPageHandler` 渲染独立采集主页（不继承 layui 后台框架）；`CollectSourcesApiHandler` 返回启用信源与占位符元数据（不回传含 cookie 的 headers）；`CollectRunApiHandler` 校验关键词/选源/参数后经 `run_in_executor` 把阻塞采集编排放入专用线程池（规避 IOLoop 阻塞隐患），逐源汇总结果；`CollectItemsApiHandler` 提供橱窗分页数据。权限沿用 `backend_required` + `require_menu('/collect')` 菜单鉴权体系。
- [`warehouse.py`](../app/controllers/warehouse.py)：**（任务7 已实现）** 数据仓库控制层。`WarehousePageHandler` 渲染 layui 后台页；`WarehouseListApiHandler`（20/页 + 搜索/信源/状态过滤）、`WarehouseItemApiHandler`（更新元信息 / 删除）、`WarehouseDetailApiHandler`（含正文详情，JSON 字段解析）、`WarehouseBatchApiHandler`（批量删除）、`WarehouseSourcesApiHandler`（信源选项，复用 `collect_service.parse_placeholders` 不回传敏感 headers）、`WarehouseItemsApiHandler`（原数据列表，`only_undone=1` 排除已成功深采）提供 CRUD；`DeepCollectOneApiHandler`/`DeepCollectBatchApiHandler` 把深采编排放入专用 `ThreadPoolExecutor`，`stream()` 经 `asyncio.Queue` 转 SSE（含 `HEARTBEAT_SECONDS` 心跳、`asyncio.wrap_future` 收尾下发 `result`）实时推送执行面板。权限沿用 `backend_required` + `require_menu('/admin/warehouse')`。
- [`tasks.py`](../app/controllers/tasks.py)：**（成员 E 已实现）** 定时任务管理控制层。`AdminTasksHandler` 渲染 layui 后台页（壳出调度器状态条）；`AdminTasksApiHandler`/`AdminTaskItemHandler`（列表分页 + 搜索/启停过滤、详情、新增/编辑/删除）、`AdminTaskToggleHandler`（启停）、`AdminTaskRunHandler`（手动触发——把阻塞的 `execute_task` 经 `run_in_executor` 放线程池，不卡 IOLoop）、`AdminTaskLogsApiHandler`（执行流水分页）、`AdminSchedulerStatusHandler`（调度器状态/重载/重启）、`AdminNotifyTestHandler`（通知渠道测试）提供 JSON API。`_validate_and_normalize` 收敛并校验任务字段（非法即拒），任何配置变更后调 `scheduler_service.reload_jobs()` 重装载。权限沿用 `backend_required` + `require_menu('/admin/tasks')`。
- [`stats.py`](../app/controllers/stats.py)：**（成员 E 已实现）** 数据统计接口控制层，面向成员 C 的数智大屏/报表提供只读聚合：`StatsOverviewApiHandler`/`StatsTrendApiHandler`/`StatsBySourceApiHandler`/`StatsByRiskApiHandler`/`StatsKeywordsApiHandler`/`StatsReportApiHandler`（`/api/stats/*`）均只读、无副作用，数据全部来自 `models/stats.py` 的 `StatsRepository`；权限仅需 `backend_required`（大屏/报表属后台可视化，与工作台同为仅需后台身份，不绑定具体菜单）。
- [`archives.py`](../app/controllers/archives.py)：**（成员 E 已实现）** 会话归档控制层。`AdminArchivesHandler` 渲染 `/admin/archives` 壳（总量状态条 + 筛选区）；`AdminArchivesApiHandler` 返回 `message_archives` 分页与 `total_all`。权限 `backend_required` + `require_menu('/admin/archives')`。
- [`messages.py`](../app/controllers/messages.py)：**（成员 E 已实现）** 对话记录管理控制层。`AdminMessagesPageHandler` 渲染页面；`AdminMessagesApiHandler` 提供六条件分页列表与 `delete_batch` 批量删除；`AdminMessageItemApiHandler` 提供详情（全文 `content`）与单条 DELETE。本模块有意**不按 username 隔离**（后台跨用户审计），与前台 `/api/history` 隔离视图共存；权限 `require_menu('/admin/messages')`。
- [`sessions.py`](../app/controllers/sessions.py)：**（成员 E 已实现）** 登录会话查询控制层。`AdminSessionsPageHandler` 渲染页并在 `get_context()` 注入 `admin_stats()` 概况；`AdminSessionsApiHandler` 提供分页列表（`state` ∈ active/revoked/expired/all）与三种写操作（`revoke` 按 id 撤销、`revoke_username` 批量下线、`purge_expired` 清理）；`_try_kick_ws`/`_try_kick_ws_by_id` 反查 username 后联动 `ws.kick_user` 踢下 WebSocket（异常静默不阻断主流程）；权限 `require_menu('/admin/sessions')`。
- [`user.py`](../app/controllers/user.py)：**（成员 D 已实现）** 前台用户中心控制层。`UserPageHandler` 渲染 `/user` 页；`UserProfileApiHandler` GET 返回本人档案（id/username/nickname/avatar/role/时间戳/face_enabled/assistant_employee_id + messages/sessions/faces 三项统计），**绝不下发 password_hash/salt**；POST 保存昵称（≤32 字）与头像（仅 `fas fa-xxx` 白名单，非法 400，两字段均缺 400）；`UserPasswordApiHandler` 本人改密——旧密错 403、新密 <6 位或与旧密相同 400，成功后 `SessionRepository.revoke_username` 使全部旧会话失效并为当前浏览器重签 cookie；`UserSessionsApiHandler` 返回本人活跃会话（只回 IP/设备/时间，不回 token）。权限仅 `@tornado.web.authenticated`。
- [`chat_export.py`](../app/controllers/chat_export.py)：**（成员 D 已实现）** 对话导出 PDF 控制层。`ChatExportHandler GET /api/chat/export?session_id=`：`valid_session` 校验（非法 400 JSON）→ `MessageRepository.list_recent(user, 500, session_id)` 取本会话升序消息 → `pdf_service.build_chat_pdf` 生成字节流 → 以 `application/pdf` + RFC 5987 双语 `Content-Disposition` 附件下载。强制只导出**当前登录用户自己的会话**，天然用户隔离。
- [`music.py`](../app/controllers/music.py)：**（成员 D 已实现）** @音乐曲库控制层。`MusicSearchApiHandler GET /api/music/search`：`q`（≤50 字，空词=按播放量热门）+ `limit`（非法回退 5，上限 20）→ `MusicRepository.search`；`MusicPlayApiHandler POST /api/music/play`：`{"id":n}` 校验（非整数 400、不存在 404）→ `bump_play` 播放计数 +1 → 回传含 `file` 播放地址的曲目。只读曲库、仅 `@authenticated`。
- [`qa.py`](../app/controllers/qa.py)：**（成员 D 已实现）** 智能问数控制层。`QaPageHandler` 渲染 `/qa` 页；`QaAskApiHandler POST /api/qa/ask`：question 非空 ≤500 字 → `pick_assistant` 解析应答助理（与 `/api/chat` 同源，err 即 400）→ `await qa_service.ask` 出报告 → `QaRepository.save` 落库 → 回 `{ok,id,report}`；`QaHistoryApiHandler` 本人问数历史（用户隔离）；`QaReportApiHandler GET /api/qa/report/(\d+)` 取单条完整报告，**别人的 id 视为不存在 404**。
- [`avatar.py`](../app/controllers/avatar.py)：**（成员 D 已实现）** 3D 数字人页面壳。`AvatarPageHandler GET /avatar`：`@tornado.web.authenticated` 渲染 avatar.html（虚拟主播：本地 vendor VRM 模型 + GLTFLoader + 浏览器原生 TTS，均前端能力）；对话复用既有 `/api/chat` SSE 通道，后端零新增推理逻辑。

### 3.3 服务层（services）

- [`agent_service.py`](../app/services/agent_service.py)：**（已实现）** 智能体业务编排核心，Agentica 在此封装，控制器不直接感知 Agentica 细节：
  - `resolve_employee(user_id, employee_id=None)`：**（任务10）** 按「显式选择 > 用户已保存助理 > 系统默认员工 > 首个启用员工 > None（硬编码兜底）」逐级解析生效数字员工，选中项停用/删除自动回退不抛异常。
  - `build_agent(user_id, employee=None)`：优先按库内数字员工（任务9 默认员工/任务10 所选助理）装配——模型用 `OpenAIChat`（优先默认模型引擎，回退 `.env`）；按 `tools` 勾选从 `TOOL_REGISTRY` 注入工具；提示词 = 库内 instructions + workspace 关联 md（防穿越）；`workspace=Workspace(path, user_id=user_id)` 按用户隔离工作目录与长期记忆；库内无可用员工时回退 `_FALLBACK_INSTRUCTIONS` 硬编码旅行规划师，对话永不断链。
  - `get_agent(user_id, employee=None)`：模块级字典 `_agents` 按 `(user_id, employee_id)` 元组缓存 Agent 实例，同用户切助理不串配置、同助理复用实例；`reset_agents()` 配置变更后重建。
  - `stream_answer(message, user_id, employee=None)`：异步生成器，`agent.run_stream()` 逐块产出事件字典（`tool` / `delta` / `reasoning` / `done`），供控制层转成 SSE 报文。
- [`collect_service.py`](../app/services/collect_service.py)：**（任务6 已实现）** 采集编排服务，基于信源（URL 规格 + Request Headers）完成数据批量自动化采集：
  - `parse_placeholders` / `build_url`：识别 URL 规格占位符——含「关键字」自动用采集关键词（URL 编码）替换、含「分页」按步长 10 自动替换，其余占位符为信源自带参数，由采集主页可视化参数配置区提供值，缺参抛 `CollectError`。
  - `fetch_html`：按信源 Headers 规则抓取页面（requests，20s 超时），自动纠正未声明 charset 的中文编码。
  - **双引擎解析**：`extract_items_llm` 优先——页面 markdown 化（保留链接）后交给 Agentica 专用「采集解析智能体」（`OpenAIChat` 配置同 `.env`，60s 超时）输出严格 JSON 条目；大模型不可用/超时/输出不合法时自动回退 `extract_items_heuristic`（BeautifulSoup 解析百度资讯等新闻结果块的 标题/链接/时间/封面/摘要）。
  - `collect`：单信源编排（参数替换→抓取→解析→`CollectRepository.save_items` 按信源去重落库），返回逐源统计（引擎/解析数/新增数）。本模块全部为同步阻塞函数，**必须由控制层经线程池调度**，不得直接在 IOLoop 里调用。
- [`warehouse_service.py`](../app/services/warehouse_service.py)：**（任务7 已实现）** 深度采集编排服务，把采集原数据（`collect_items`）深采为详细正文并落 `warehouse_data`：
  - **抓取双路**：`crawl_page` 优先 `_crawl_with_crawl4ai`（Crawl4AI `AsyncWebCrawler` + `CrawlerRunConfig`，`CRAWL4AI_AVAILABLE` 运行期探测），内核缺失/异常时回退 `_fetch_with_requests` + `_heuristic_main_content`（`article`/`.article-content` 等容器优先 + 最长文本退化 + 相对链接补全 + 图片收集）。
  - **AI 引擎**：`_default_engine` 取「模型引擎管理」(任务8) 默认模型 `ModelEngineRepository.get_default()`、回退 `.env`；`ai_analyze`（`AsyncHTTPClient` POST `{api_url}/chat/completions`，`thinking` 下发 `enable_thinking`，稳健解析严格 JSON）产出摘要 + 关键词，失败回退 `heuristic_analyze`（规则摘要 + 2/3-gram 关键词）。
  - **编排**：`deep_collect_one`（抓取→分析→`WarehouseRepository.save_deep` UPSERT 落库，按区间回报 `start/crawl/parsed/ai/rule_done/saved/error` 进度事件）、`deep_collect_batch`（逐条均分进度、单条失败不中断、发 `batch_start/batch_done`）；`MAX_BATCH_ITEMS=50`。同为同步阻塞编排，由控制层线程池调度。
- [`scheduler_service.py`](../app/services/scheduler_service.py)：**（成员 E 已实现）** 定时任务周期调度核心。`detect_engine()` 按「`SCHEDULER_ENABLED` 开关 + apscheduler 可用性」选引擎（apscheduler / tornado / disabled）；`start()/stop()/reload_jobs()` 装载 `scheduled_tasks` 中启用任务（APScheduler `BackgroundScheduler` 独立线程；降级引擎用 IOLoop `call_at` + `run_in_executor`，仅 interval 自动排程）；`execute_task(task_id, trigger)` 为同步阻塞函数：写 `task_logs` 流水→按 `task_type` 派发内置处理（`_run_log_cleanup` 清理登录审计/过期会话/任务流水，`_run_auto_archive` 迁移过期会话）→回写任务运行状态→依通知策略推送。`status()` 显式标注 engine/note/notify，不静默降级。
- [`notify_service.py`](../app/services/notify_service.py)：**（成员 E 已实现）** 定时任务结果推送（邮件 / QQ）。全用标准库 `smtplib`/`ssl`/`urllib`，零额外依赖：`send_email` SMTP_SSL/STARTTLS；`send_qq` webhook 优先、回退 QQ 邮箱 SMTP；`notify(channel,...)` 统一 dispatch 并汇总。未配置对应渠道返回 `{ok:False, degraded:True, reason:中文}` 不抛异常；真实凭据只从运行环境读取，日志只记渠道与原因、不出口令。
- [`pdf_service.py`](../app/services/pdf_service.py)：**（成员 D 已实现）** 对话导出 PDF 渲染服务。reportlab Platypus 版式（标题/元信息/用户与助理气泡段落/页脚页码）；中文用 `UnicodeCIDFont('STSong-Light')` CJK 字体——**纯本地渲染、不联网、无需系统字体**；`build_chat_pdf(username, session_id, messages) -> bytes` 为唯一对外入口，消息文本经 `_safe` 转义防止 XML 标签注入。
- [`qa_service.py`](../app/services/qa_service.py)：**（成员 D 已实现）** 智能问数编排服务。`_collect_context` 只读汇总数据仓库/采集/会话/人脸等运行统计；`ask(question, employee)` 优先走所选助理的大模型出结构化报告（`_normalize_model_report` 严格校验补齐字段契约），模型不可用/输出非法时降级 `_heuristic_report`（规则统计报告），**报告契约恒定**：`{title,summary,metrics[{name,value,unit}],chart{type,labels,series},insights,advice,source,generated_at}`，`source` ∈ model/heuristic 供前端标注。

### 3.4 模型层（models）

- [`db.py`](../app/models/db.py)：数据库访问基础设施，只负责三件事——
  1. 定位数据库文件路径 `DB_PATH`（`database/govagentos.db`）；
  2. 提供连接工厂 `get_connection()`（每次返回独立连接，`row_factory=sqlite3.Row` 使结果可按列名访问；连接时顺带 `os.makedirs` 保证目录存在）；
  3. `init_db()` 使用 `CREATE TABLE IF NOT EXISTS` 幂等建表，并为 `messages.username` 建普通索引 `idx_messages_username` 加速按用户查询。

  > 设计要点：**每次操作都新建连接**，以适配 Tornado 多协程环境，避免连接跨协程复用带来的隐患。

  两张核心表：
  - `users`：`id / username(唯一) / password_hash / salt / role / assistant_employee_id(任务10，0=跟随系统默认) / created_at`
  - `messages`：`id / username / role / content / employee_id / employee_name(任务10，应答助理身份) / created_at`（`role` 支持 `user / system / assistant / tool`）

- [`user.py`](../app/models/user.py)：`UserRepository`，采用 **Repository 模式** 收拢 users 表的所有 SQL。安全设计是全项目亮点：
  - **绝不明文存密码**：注册时用 `secrets.token_bytes(16)` 为每个用户生成随机盐；
  - **PBKDF2-HMAC-SHA256** 迭代 `100000` 次进行哈希，仅存储 `password_hash` 与 `salt`；
  - 登录时用同一盐值重算哈希并比对，即使数据库泄露也无法还原密码；
  - 用户名重复注册通过捕获 `sqlite3.IntegrityError` 判定并返回失败。

- [`message.py`](../app/models/message.py)：`MessageRepository`，同样为 Repository 模式，**核心约束是"用户数据隔离"**：所有读写方法都必须带 `username` 并写入 `WHERE` 条件，确保每个用户只能访问自己的会话；方法均以 `@staticmethod` 提供。

- [`source.py`](../app/models/source.py) / [`collect.py`](../app/models/collect.py)：**（任务5/6 已实现）** 数据链路两表的 Repository。`SourceRepository` 管理信源（name 唯一、URL 规格模板、headers JSON、`parse_raw_headers` 兼容两种 RAW 粘贴格式、`get_all` 供采集选源）；`CollectRepository` 管理采集数据 `collect_items`（`UNIQUE(source_id, title)` 按信源去重、`save_items` 批量增量入库、`paginate` 橱窗分页 12/页支持标题/关键词搜索与信源过滤），是后续「数据仓库」模块的原始数据底座。
- [`warehouse.py`](../app/models/warehouse.py)：**（任务7 已实现）** `WarehouseRepository` 收拢 `warehouse_data` 表 SQL（全方法 `@staticmethod`，Repository 模式）。数据仓库 = 采集原数据经深度采集后的正文仓库，一条原数据 `UNIQUE(collect_item_id)` 对应一条深采结果：`save_deep`（UPSERT，成功 `status=2`、失败 `status=1` 留存 `error`）、`paginate`（`PAGE_SIZE=20`，标题/关键词/摘要搜索 + 信源/状态过滤，列表不带正文大字段，成功优先再 id 倒序）、`get_by_id`/`get_by_collect_item`/`update_meta`/`delete`/`delete_many`/`count_all`/`count_by_status`。`db.py init_db()` 建表 + `_seed_warehouse_menu` 幂等补种「数据采集 / 数据仓库」菜单。
- [`task.py`](../app/models/task.py)：**（成员 E 已实现）** `ScheduledTaskRepository`（`scheduled_tasks` 周期任务配置：CRUD + `set_enabled` 启停 + `mark_run` 运行回写 + `paginate` 分页搜索 + `normalize` 字段收敛：间隔下限保护/非法类型回退/cron 截断）与 `TaskLogRepository`（`task_logs` 执行流水：`start`/`finish` 回写耗时、`paginate`、`latest`、`purge_before` 过期清理）；内置任务类型 `log_cleanup`/`auto_archive`、调度方式 `interval`/`cron`、通知策略/渠道常量。`db.py init_db()` 建表 + `_seed_default_tasks` 预置两条内置运维任务。
- [`stats.py`](../app/models/stats.py)：**（成员 E 已实现）** `StatsRepository`（面向大屏/报表的只读聚合：`overview`/`daily_trend`/`by_source`/`by_risk`/`top_keywords`，日期骨架在 Python 侧生成、聚合用 `substr` 分组，避免 MySQL 5.7 不支持 CTE）与 `MessageArchiveRepository`（`message_archives` 历史会话自动归档：`archive_before` 先查后删跨库可移植、`paginate` 追溯、`count`）；`paginate` 已扩展为支持 username/session_id/role/keyword/时间区间多条件筛选。
- [`settings.py`](../app/models/settings.py)：**（成员 E 已实现）** `SystemSettingsRepository` 收拢 `system_settings`（key 主键 + value + updated_at）的 key-value 读写，全方法 `@staticmethod`：`get`/`get_many`/`get_all`/`set`/`set_many`/`delete`。作为通知配置的数据库侧底座，配合 `notify_service` 实现「DB 优先 + `.env` 兜底」；配置项统一 `notify_` 前缀以免与其他系统配置冲突。已知限制：`set`/`set_many` 用 `INSERT OR REPLACE`，方言层未翻译该写法，`DB_DRIVER=mysql` 下需改 `ON DUPLICATE KEY UPDATE`。
- [`message.py`](../app/models/message.py)（成员 E 扩展）：新增 `admin_paginate`/`admin_get`/`admin_delete`/`admin_delete_batch`/`admin_count` 与 `_admin_where` 筛选辅助（username/session_id 模糊、role 精准、keyword 走 `content LIKE`、start_at/end_at 闭区间）；列表不携正文大字段，详情才取全文；原 `username` 隔离方法保持不变。
- [`session.py`](../app/models/session.py)（成员 E 扩展）：新增 `admin_paginate`（`state` 四档筛选、id 倒序）、`admin_stats`（active/revoked/expired 三态计数）、`revoke_by_id`（后台按会话 id 撤销，**不需要 token 明文**，因库里只存 SHA256 哈希无法反查）。
- [`music.py`](../app/models/music.py)：**（成员 D 已实现）** `MusicRepository` 收拢 `music_tracks` 表 SQL（全 `@staticmethod`，Repository 模式）：`search(keyword, limit)` 名称/歌手/标签 `LIKE` 检索、空词按 `play_count DESC` 热门；`list_all`/`get`/`bump_play`（播放计数 +1）。种子 6 首本地音频由 `db.py` 幂等补种，音频文件为 `tests/gen_music_wavs.py` 标准库 `wave` 离线合成的 wav（固定随机种子，可重复生成）。
- [`qa.py`](../app/models/qa.py)：**（成员 D 已实现）** `QaRepository` 收拢 `qa_reports` 表：`save(username, question, employee_id, employee_name, report, source)`（报告整体 JSON 序列化存储）、`list_recent(username, limit)`（用户隔离、列表不带报告大字段）、`get(username, report_id)`（**按 username+id 双条件取行**，越权即 None→控制器回 404）。
- [`user.py`](../app/models/user.py)（成员 D 扩展）：`users` 表补 `nickname`/`avatar` 列（`db.py` `_add_column_if_missing` 幂等迁移）；新增 `UserRepository.get_profile`（只回展示字段，绝不包含密码哈希/盐值）、`update_profile`（昵称 ≤32 字截断、头像只存白名单类名）与 `change_password`（重算盐 + PBKDF2 哈希，与注册同构）；改密校验复用既有 `verify_user`，不限制后台 `admin` 用户走同一接口。

---

## 四、编码规范与约定

从现有代码可归纳出以下项目编码风格：

1. **模块级文档字符串**：每个模块顶部用中文 docstring 说明"本模块只做哪几件事"，并附设计说明与安全要点。
2. **类型注解**：函数签名普遍带 `typing` 注解（`Optional`、`List`、`Dict` 等）。
3. **Repository 模式**：数据访问一律收拢到 `XxxRepository` 类的静态方法，控制器不直接写 SQL。
4. **参数化 SQL**：所有查询使用 `?` 占位符，杜绝字符串拼接，防止 SQL 注入。
5. **上下文管理**：数据库连接统一用 `with get_connection() as conn:` 保证及时关闭。
6. **认证与 CSRF**：基于签名 Cookie + `@authenticated` 装饰器 + `xsrf_form_html()` 三件套。
7. **响应风格双轨**：页面交互用 `render/redirect`（传统表单），数据/流式交互用 `write_json`/`sse`（为智能体预留）。

---

## 五、核心业务流程

### 5.1 用户认证流程
```
浏览器表单 POST /auth/login
   → LoginHandler.post 读取 username/password
   → UserRepository.verify_user（重算 PBKDF2 哈希并比对）
   → 成功：set_secure_cookie 写入签名 Cookie，redirect 到 /
   → 失败：render 回登录页并回显 error
访问受保护页 / → IndexHandler 经 @authenticated 拦截 → get_current_user 校验 Cookie
登出 /auth/logout → LogoutHandler.clear_cookie → redirect 登录页
```

### 5.2 对话 / 智能体流程（已实现主链路，含任务10 数字助理关联）
```
页面加载：chat.js GET /api/assistants（启用助理清单 + 当前生效选择）→ 渲染输入区选择器与侧栏人设卡
用户切换助理：POST /api/assistants/select → pick_assistant 校验存在/启用并写入 users.assistant_employee_id
前端 index.html fetch POST /api/chat（JSON body {message, employee_id} + X-Xsrftoken 头）
   → ChatHandler 经 pick_assistant 解析应答助理（显式 > 已保存 > 默认 > 首个启用；非法/停用 400 不进 SSE）
   → MessageRepository.save 落库用户提问（employee_id=0）
   → 首帧 sse("assistant", assistant_brief) 下发本轮实际应答助理（前端气泡按此渲染署名/头像）
   → agent_service.stream_answer：get_agent((user_id, employee_id)) 按所选助理装配并缓存
   → agent.run_stream 逐块产出事件 dict（tool / delta / reasoning / done）经 SSE 流式回传（打字机效果）
   → done 携带的完整答案由 MessageRepository.save 携助理 id/名称落库（role=assistant）
   → 页面刷新 GET /api/history 拉取历史（含 employee_id/employee_name，气泡按发言人身份渲染）
后台联动：数字员工被停用/删除 → _release_disabled_users 清零选定用户关联 → 前台自动回退默认助理不报错
```

### 5.3 采集管理流程（任务6 已实现）
```
采集主页 /collect（独立科技感页面，零 layui）
   ① 关键词输入区：关键词 + AI 智能解析开关
   ② 信源选择区：GET /api/collect/sources 渲染启用信源卡片（多选）；
      URL 占位符含「关键字/分页」自动填充，其余占位符选中后展开可视化参数配置
   ③ 点击「启动采集」→ POST /api/collect/run（keyword + source_ids + params）
   → CollectRunApiHandler 校验后经 run_in_executor 放入采集线程池（不阻塞 IOLoop）
   → collect_service.collect 逐源编排：build_url 占位符替换 → fetch_html 按 Headers 抓取
   → 双引擎解析：Agentica 采集解析智能体（严格 JSON）失败自动回退 BeautifulSoup 启发式
   → CollectRepository.save_items 按 UNIQUE(source_id, title) 去重落库 collect_items
   → 前端刷新橱窗列表：GET /api/collect/items（1 行 3 列，12 条/页，封面+标题+时间，自定义分页）
```

### 5.4 数据仓库深度采集流程（任务7 已实现）
```
后台 /admin/warehouse（layui 三段式，20/页）列表展示 warehouse_data 深采结果
单一深采：行「深采/重采」→ EventSource GET /api/warehouse/deep/one?p={item_id,use_ai,use_crawl4ai}
批量深采：「批量深采」→（勾选行 ids 或 all_pending 全量未深采）→ EventSource GET /api/warehouse/deep/batch
   → DeepCollect*ApiHandler 把 warehouse_service.deep_collect_one/batch 放入专用线程池（不阻塞 IOLoop）
   → 抓取：crawl_page 优先 Crawl4AI，内核缺失/异常回退 requests + _heuristic_main_content 正文抽取
   → 分析：ai_analyze 走「模型引擎管理」默认模型（无则回退 .env，均不可用回退 heuristic_analyze）
   → WarehouseRepository.save_deep 按 UNIQUE(collect_item_id) UPSERT 落 warehouse_data（status=2/1）
   → stream() 经 asyncio.Queue 把 progress/batch_done 事件转 SSE，前端执行面板实时渲染进度条+阶段日志+结果汇总
   → 收尾 result 事件下发完整结果，前端补满 100% 并主动 es.close() 防重连重复触发，随后刷新列表
```

---

## 六、实现进度与待完善清单

> **进度更新（v0.11.0）**：任务1～10 均已完成——登录/注册与角色分流、AI 对话页、layui 后台框架、用户/角色/菜单管理、信源管理（任务5）、采集管理（任务6）、模型引擎管理与 Token 统计（任务8/8.1）、数据仓库（任务7）、数字员工管理（任务9：智能体配置入库按库装配）、数字助理选择（任务10：前台输入区用户↔数字员工关联，选择持久化 + 应答身份落库与回显）。下文早期清单中「注册链路空缺」等描述已过时（注册与后台各模块均已落地），保留仅作历史参考；IOLoop 阻塞隐患在采集/深采链路已用线程池规避，对话链路仍待同样处理。

项目已从脚手架阶段推进到**智能体对话主链路打通**：`/api/chat` SSE 流式对话、`/api/history` 历史查询、Agentica 智能体服务（旅行规划师人设 + 工具集 + 按用户 workspace 隔离与长期记忆）均已落地；早期文档记录的 `os.pash.abspath`、路由 `(r"", ...)`、`message.py` 的 SQL 拼写/列名错误、`login.html` 块名不匹配等问题已修复。当前遗留问题如下，供后续任务补齐：

- **未完成模块**：
  - 注册链路整体空缺：`RegisterHandler.get/post` 为 `pass`，`templates/register.html`、`static/css/base.css`、`static/js/base.js` 均为空文件，`login.html` 也没有跳转注册的入口。
  - 历史对话上下文尚未接入智能体：`ChatHandler` 只把本轮 `message` 传给 `stream_answer`，`MessageRepository.list_recent` 组装上下文的设计流程未实现。

- **待修正的代码问题（疑似 bug）**：
  - ~~[`user.py`](../app/models/user.py) 方法归属不一致导致 `AttributeError`~~：**已修复**（`get_user_by_username`/`verify_user` 已收拢为类内 `@staticmethod`，`tests/test_user.py` 验证通过）。注意 `create_user` 仍是实例方法，注册实现时需统一调用方式。
  - ~~[`agent_service.py`](../app/services/agent_service.py) `done` 误在循环内~~：**已修复**（`yield done` 已移到 `async for` 之后，仅流结束时产出一次）。
  - ~~[`chat.py`](../app/controllers/chat.py)~~：**已修复**——`json.load`→`json.loads`（并 `.decode("utf-8")`）；`HistoryHandler` 的 `limit` 已 `int()` 转换并处理非法值/`<=0`；删除 `from email import message` 误导入；每块事件后 `await self.flush()` 实现真正流式。
  - ~~[`index.html`](../app/templates/index.html)~~：**已重写修复**——块名 `body`→`content`；修复非法嵌套表单（聊天 form 移出 logout form）；`addLine` 参数名统一为 `label` 且用 `textContent`；submit 监听器已真正调用 `submitMessage`；已补齐 `loadHistory`、`delta`(纯文本)/`tool`/`reasoning`/`error`/`done` 各 SSE 事件的前端消费。
  - ~~[`application.py`](../app/application.py) 缺 `/api` 路由~~：**已修复**——磁盘曾长期为旧版（无 `controllers.chat` 导入、无 `/api/chat`、`/api/history` 路由），与 IDE 缓冲区不一致导致运行实例 404；已用 Write 强制落盘并验证 `/api/chat` 命中 Handler（消息成功落库）。
  - ⚠️ **运行期新发现**：`agent.run_stream` 阻塞时整个 Tornado 单线程 IOLoop 会被卡住（实测 `/api/chat` 进入智能体后因本地模型后端 `127.0.0.1:11435` 未响应而挂起，期间 `/api/history` 等请求无法被服务）。需确认 agentica 是否为真异步，或将阻塞调用移出事件循环（如 `run_in_executor`）。

- **环境依赖**：`.env` 键名拼写 `BASE_UEL` 已修正为 `BASE_URL`（代码读 `os.getenv("BASE_URL")`）；需保证 `BASE_URL/API_KEY/MODEL_ID` 均有值，且 `127.0.0.1:11435` 的本地模型服务需处于运行状态，否则智能体调用会挂起。`dist/` 目录当前为空。

> 说明：以上问题不影响对架构分层与业务意图的理解，但会影响实际运行，属于待完善的实现细节。

---

---

## 八、任务11～18 落地说明（成员 A：后端框架 & 权限/登录模块）

> 本次在不改动既有业务行为的前提下补齐「鉴权会话 / 人脸登录 / 配置中心 / 双库适配 / 统一异常与 CORS /
> SSE 与 WebSocket 基础封装 / 工程基线」，事件名与接口路径保持向后兼容。

| 任务 | 新增/改造 | 关键约定 |
| --- | --- | --- |
| 11 Token 会话 | `models/session.py`、`users` 补列、`user_sessions`/`login_logs` 表、`base.py` 中间件、`auth.py` 登录/登出、`admin.py` 强制下线与登录审计 | 库内只存 token 的 SHA256；`/api/*` 未登录一律 401 JSON（不再 302）；页面 302 带 `next`；失败 5 次锁 10 分钟（可配）；改密/改角色/删除用户自动撤销会话 |
| 12 人脸登录 | `models/face.py`、`services/face_service.py`、`controllers/face.py`、`login.html` 摄像头入口、用户管理「人脸」列与弹层 | 真实引擎（onnxruntime + ArcFace ONNX）优先，缺失时 `auto` 显式降级并在响应/页面标注 `degraded/real/reason`；特征加密入库、接口不回传向量；图片 ≤5MB 且仅 jpg/png/webp |
| 13 配置中心 | `app/config.py`、`.env.example`、`app.py`/`application.py`/services 改造 | `.env` 只在 config 里加载一次；`COOKIE_SECRET` 必填（缺失/示例值启动即报中文错误）；端口/DEBUG/XSRF/DB/会话/人脸/CORS 全部可配 |
| 14 双库适配 | `db.py` 连接层抽象（`Connection`/`Cursor`/`Row`）、10 个 Repository 去 sqlite3、`requirements.txt` | Repository 继续写 `?`，包装层按方言转 `%s`；DDL 自动翻译（AUTO_INCREMENT / VARCHAR / MEDIUMTEXT / CURRENT_TIMESTAMP / InnoDB）；异常归一 `db.Error/IntegrityError/OperationalError`；MySQL 5.7 实测通过 |
| 15 异常与 CORS | `controllers/errors.py`、`base.py`（`write_error`/安全头/`options`）、`templates/error.html` | 页面错误页 / 接口 JSON 双形态；`request_id` 透传；500 固定文案不泄露堆栈；CORS 白名单精确匹配（不用 `*`）+ 预检 204 |
| 16 SSE/WS | `controllers/sse.py`（`SSEMixin`/`SSEBridge`/`Heartbeat`）、`controllers/ws.py`、三处 SSE 端点改造 | 事件名保持 `assistant/delta/tool/reasoning/done/error`、`progress/result/batch_done/heartbeat`；WS 统一协议 `{type,id,payload}`，握手复用会话、Origin 白名单、心跳 30s、注册表支持踢下线 |
| 17 工程基线 | `controllers/health.py`（`/healthz`）、`requirements.txt`、`app.py` 日志 | `/healthz` 匿名可用，返回 `{ok, db, version}`，DB 故障 503，不泄露连接信息 |
| 18 前台自助人脸 | `static/js/face.js`、`static/css/face.css`、`templates/index.html`（侧栏「人脸」+ 弹层）、`controllers/face.py`（`FaceToggleApiHandler`） | 登录后不跳页即可录入/管理；摄像头不可用（http 非 localhost / 无设备 / 拒绝授权）自动回退「上传照片」并给可读文案；总开关只改 `face_enabled` 不删特征；降级模式醒目提示 |

### 8.1 新增路由

| 路由 | 说明 |
| --- | --- |
| `POST /auth/face/login` | 刷脸登录（可选 username：1:1 / 1:N），与密码登录共用会话 |
| `GET/POST/DELETE /api/face/*` | 本人人脸状态、录入、1:1 校验、删除 |
| `POST /api/face/toggle` | 本人开启/关闭人脸登录（任务18，仅改开关不删特征） |
| `GET/POST/DELETE /api/admin/users/<id>/faces[/<fid>]` | 后台人脸查看、代录、启停、删除 |
| `POST /api/admin/users/<id>/logout` | 强制下线（撤销该用户全部会话，联动 WS 踢下线入口） |
| `GET /api/admin/login-logs` | 登录审计分页（用户管理权限） |
| `GET /healthz` | 健康检查 |
| `/ws`、`/ws/notify` | WebSocket 基础通道（回显/心跳、服务端推送） |

### 8.2 回归结果（2026-11-07）

| 测试 | 结果 |
| --- | --- |
| `tests/smoke_config.py` | 31/31 |
| `tests/smoke_auth.py` | 35/35 |
| `tests/smoke_db.py`（SQLite 方言 + 全链路） | 64/64 |
| `tests/smoke_db_mysql.py`（MySQL 5.7.26 实测） | 44/44 |
| `tests/smoke_face.py` | 41/41（含任务18 自助开关 9 项） |
| `tests/smoke_errors.py` | 31/31 |
| `tests/smoke_stream.py`（SSE/WS/healthz） | 27/27 |
| 既有 8 套 smoke（admin/assistant/collect/employees/models/sources/warehouse/user） | 全绿 |
| Playwright UI 复验（assistant/employees/models） | 21/21、25/25、20/20 |
| `tests/verify_face_ui.py`（任务18 前台人脸设置） | 25/25 |

### 8.4 前台自助人脸入口（任务18）

- 入口：前台侧栏底部「人脸」按钮（所有登录用户可见）→「人脸设置」弹层，不跳页、不中断对话。
- 交互：摄像头预览（`getUserMedia`）→ 拍照/重拍；摄像头不可用（http 非 localhost / 无设备 / 拒绝授权）
  自动回退「上传照片」并给出中文提示；录入前显示取景建议与质量/引擎结果。
- 数据：列表展示编号/标签/质量/引擎/时间/启用状态并支持单张删除；总开关走 `POST /api/face/toggle`，
  只改 `users.face_enabled`，关闭后特征保留；删空自动关闭。
- 安全：复用任务12/15 约定——图片只在内存中提取特征、不入 `static/`、接口不回传向量；
  写操作需 `X-Xsrftoken`；会话失效统一 401 JSON 并跳转登录页。

### 8.3 已知限制（需后续增强）

- 人脸真实引擎为「中心裁剪 + ArcFace 嵌入」，未接入 SCRFD 人脸检测：多人合影/大幅侧脸场景需补检测器；
  兜底算法（Pillow+numpy）精度有限，已在接口与页面显式提示。
- 旧 `username/role` cookie 兼容期未设截止时间；携带过 token cookie 的客户端在会话失效后不再回退旧 cookie。
- MySQL 联调实例为 phpstudy 的 5.7.26（默认引擎 MyISAM），DDL 已强制 `ENGINE=InnoDB`；切换实例后请重跑
  `tests/smoke_db_mysql.py`。
- `.env` 目前仍被 git 跟踪（历史遗留，含 API Key），建议人类负责人执行 `git rm --cached .env` 后再发布。

---

## 九、定时任务 / 消息通知 / 数据统计落地说明（成员 E）

> 本块补齐任务二中「定时任务周期执行 + 邮件/QQ 通知」与「数据统计接口」，不侵入既有业务；
> 新增 `scheduled_tasks`/`task_logs`/`message_archives` 三表与 `/admin/tasks`、`/api/admin/tasks*`、
> `/api/admin/scheduler`、`/api/admin/notify/test`、`/api/stats/*` 路由，向后兼容。

| 交付块 | 新增/改造 | 关键约定 |
| --- | --- | --- |
| 定时任务调度 | `services/scheduler_service.py`、`models/task.py`、`controllers/tasks.py`、`templates/admin/tasks.html`、`static/js/tasks.js`、`static/css/tasks.css` | APScheduler 优先、缺失降级 tornado（IOLoop `call_at` + `run_in_executor`）、`SCHEDULER_ENABLED=0` 仅手动触发；`status()` 显式标注 engine/note，不静默降级；`execute_task` 为同步阻塞函数，手动触发经线程池；CRUD 后 `reload_jobs()` 重装载 |
| 自动归档 / 日志清理 | `models/stats.py`（`MessageArchiveRepository`）、`scheduler_service._run_auto_archive`/`_run_log_cleanup`、`db.py` `_seed_default_tasks` | 内置两任务默认每天一次、仅失败通知、渠道默认不通知；归档采用「先查后删」跨库可移植，`origin_id` 保留可追溯；清理登录审计/过期会话/任务流水 |
| 消息通知 | `services/notify_service.py` | 全标准库 `smtplib`/`ssl`/`urllib`零依赖；邮件 SMTP_SSL/STARTTLS，QQ webhook 优先回退邮箱 SMTP；未配置渠道显式 `degraded` 不报错；凭据只从运行环境读、日志不出口令 |
| 数据统计接口 | `models/stats.py`（`StatsRepository`）、`controllers/stats.py` | 只读、无副作用，仅需 `backend_required`（不绑定菜单）；日期骨架 Python 生成 + `substr` 分组避免 MySQL 5.7 CTE；为成员 C 大屏/报表提供 overview/trend/by-source/by-risk/keywords/report |

新增路由：`/admin/tasks`、`/api/admin/tasks`、`/api/admin/tasks/<id>``/toggle``/run`、`/api/admin/task-logs`、`/api/admin/scheduler`、`/api/admin/notify/test`、`/api/stats/*`。配置新增（`.env.example`）：`SCHEDULER_ENABLED`/`SMTP_*`/`MAIL_*`/`QQ_*`。

回归结果：`tests/smoke_tasks.py` **33/33**（normalize 纯函数 + 菜单/默认任务种子 + 任务 CRUD/toggle/重名/非法拦截 + 手动运行与执行日志 + 调度器状态 + 通知降级 + 自动归档 + 统计接口），SCHEDULER_ENABLED=0 走手动触发路径，隔离临时库。

---

## 十、前台用户端增强落地说明（成员 D）

> 本块补齐任务二前台用户应用的 5 项缺项：用户中心、导出对话 PDF、3D 数字人、@音乐播放、智能问数；
> 新增 `music_tracks`/`qa_reports` 两表与 `users.nickname/avatar` 两列，以及 `/user`、`/avatar`、`/qa`、
> `/api/user/*`、`/api/chat/export`、`/api/music/*`、`/api/qa/*` 共 13 条路由，全部向后兼容。

| 交付块 | 新增/改造 | 关键约定 |
| --- | --- | --- |
| 用户中心 | `controllers/user.py`、`models/user.py`（扩展）、`templates/user.html`、`static/js/user.js`、`static/css/user.css` | 档案/改密/多端会话三视图；不回传哈希/盐值/token；头像仅 `fas fa-xxx` 白名单；改密沿用任务11「改密即全部旧会话失效」口径并为当前浏览器重签 cookie |
| 导出对话 PDF | `services/pdf_service.py`、`controllers/chat_export.py`、`chat.js`/`index.html`/`chat.css`（导出按钮） | reportlab Platypus + `STSong-Light` CJK 字体纯本地渲染；只导当前用户当前会话（≤500 条），RFC 5987 中文文件名附件下载；依赖已钉进 `requirements.txt`（reportlab） |
| 3D 数字人 | `controllers/avatar.py`、`templates/avatar.html`、`static/js/avatar.js`、`static/css/avatar.css`、`static/vendor/three/`（含 `GLTFLoader.js`、`models/three-vrm-girl.glb`） | 动漫风虚拟主播：pixiv VRM 示例模型（CC 宽松，allowedUserName=Everyone）+ three.js r128/GLTFLoader 全本地 vendor（不依赖外网 CDN）；口型 morph（a/i/u/e/o）+ 眨眼 + joy 表情由 morphTargetInfluences 直接驱动，humanoid 骨骼程序化 idle/视线跟随/手势；语音用浏览器原生 Web Speech API（零依赖，可静音）；降级链模型失败→程序化低多边形人形，WebGL 不可用→文本对话面板；对话严格复用 `/api/chat` SSE 事件契约 |
| @音乐播放 | `models/music.py`、`controllers/music.py`、`chat.js`（前缀拦截 + 播放卡片）、`static/music/`、`tests/gen_music_wavs.py` | 对话输入 `@音乐 关键词` 前端拦截→ `/api/music/search` 检索→ HTML5 audio 卡片单首互斥播放 + `/api/music/play` 计数；曲库 6 首离线合成 wav（标准库 `wave`、固定种子可重生成），零联网零版权风险 |
| 智能问数 | `services/qa_service.py`、`models/qa.py`、`controllers/qa.py`、`templates/qa.html`、`static/js/qa.js`、`static/css/qa.css` | 报表契约恒定（metrics/chart/insights/advice/source）；大模型优先、失败降级启发式统计并在报告标注来源；历史与单条报告严格 username 隔离（越权 404）；前端零依赖 canvas 绘图 |

新增依赖：`reportlab==5.1.0`（已写入 `requirements.txt` 并安装）；three.min.js / GLTFLoader.js / three-vrm-girl.glb（VRM 数字人模型）均为本地 vendor 静态资源，不新增 pip 依赖；语音朗读用浏览器原生 Web Speech API，无服务端依赖。

回归结果：`tests/pytest/test_09_user_center.py`（13 项）+ `test_10_chat_export_pdf.py`（4 项）+ `test_11_music.py`（9 项）+ `test_12_qa.py`（7 项）+ `test_13_avatar_vtuber.py`（5 项）共 **38/38**；全量回归 130 条中 129 通过，唯一失败 `test_07_chat_requires_message` 为既有基线问题（非本次改动引入，见 CHANGELOG）。测试拦截大模型：setUp 将 `model_service.chat_engine` 置 None，遵守 conftest「不依赖网络/大模型」基线。

---

## 七、小结

本项目以 **Tornado 承载 Web 异步能力、Agentica 承载智能体推理、SQLite/MySQL 承载轻量持久化**，通过
「表现—控制—服务—模型」四层解耦，配合 Repository 模式、参数化 SQL、PBKDF2 加盐哈希、Token 会话与
XSRF 防护、统一异常出口等约定，形成面向「数据瞭望智能对话」场景的完整链路。

任务1～18 均已落地：登录/注册与人脸登录、角色分流、AI 对话页、layui 后台、用户/角色/菜单与信源管理、
采集与数据仓库、模型引擎与 Token 统计、数字员工与数字助理选择、Token 会话与登录安全、
配置中心、SQLite/MySQL 双库适配、统一异常与 CORS、SSE/WebSocket 基础通道、健康检查、
以及登录后的前台自助人脸录入入口。成员 E 已补齐定时任务周期调度（APScheduler 优先 + 降级）、
自动归档 / 日志清理、邮件/QQ 通知与面向大屏/报表的数据统计接口（`/admin/tasks`、`/api/stats/*`）。
成员 D 已交付前台用户端增强五件套：用户中心（`/user`）、导出对话 PDF（`/api/chat/export`）、
3D 数字人（`/avatar`）、@音乐播放（`/api/music/*`）与智能问数（`/qa`、`/api/qa/*`）。
下一步重点：人脸检测器（SCRFD）增强、旧 cookie 兼容期收敛、对话链路彻底移出 IOLoop 阻塞。
