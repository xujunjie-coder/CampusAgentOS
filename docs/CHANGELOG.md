# GovCheckDataAgentOS 变更日志（CHANGELOG.md）

## 2026-11-24 · CampusAgentOS 功能完善与项目展示

- 信源管理支持新增、编辑、停用 QQ 频道，采集页选择已启用频道；普通网页与 QQ 专用采集分开使用信源。
- QQ 搜索按钮增加加载反馈，筛选常显；帖子详情改为正文/评论布局，回复按层级展开，整帖集中审核。
- 正文图片 URL 提取、去重、持久化与详情展示，历史帖子按需补采；不含图片 OCR 或永久归档。
- 知识文档列表改为每页 15 条及服务端分页，保留总数与删除末页回退。
- 校园地图增加方向按钮，保留用户校正的建筑、理科楼分栋及校门名称；重建时自动应用校正。
- 聊天子任务增加独立状态与结果展示，限制查询预算、上下文和超时；完善人脸设置的拍摄/上传流程与大屏明细滚动。
- README 按功能和技术实现重写，增加项目讲解、技术取舍、简历草稿及本批验证范围。

验证见 [2026-11-24 验证记录](validation-2026-11-24.md)。下方为早期版本记录。

> 本文件由 AI 助手在**每次任务节点/版本提交时**维护，记录每个版本对外可见的变更。
>
> 版本号遵循 [`agent_roles.md`](agent_roles.md) 第二节规则：主开发线为 `v0.x.0`，次版本号随功能模块完成加 1；
> 版本号同时记录在 [`VERSION`](VERSION)，git tag 与开发版本号保持一致（本地与线上同步）。
>
> 分类含义：**新增** = 新功能/新模块；**变更** = 既有行为的调整；**修复** = 缺陷修正；**清理** = 工程与仓库卫生。

---

## [未发布] - 2026-11-12（成员 F：依赖巡检 + 双库实测 + 文档补齐）

> 本段为交付前的环境与工程卫生修复，不改动业务逻辑；目的是让「换一台机器按文档重装」不再崩在依赖上。

### 新增

- **[`tools/download_face_model.py`](../tools/download_face_model.py)**：一条命令把 InsightFace ArcFace `w600k_r50.onnx`（≈174MB）下载到 `database/models/face/`。双源降级（hf-mirror 镜像 → HuggingFace 官方 `Aitrepreneur/insightface` → `lyphanthuc/buffalo_l` 备用 → GitHub `buffalo_l.zip` 解包，每源 30s 超时自动切换，不会静默卡住）、支持 `HF_ENDPOINT` 覆盖、`--proxy/--no-proxy` 代理控制与 `--url` 自定义直链、下载后校验体积并用 `onnxruntime` 做加载自检（打印输入名/形状，防下成错误页面）；已存在则跳过，不做重复下载。
- **仓库根 [`README.md`](../README.md)**：技术栈 12 项对照（含 MCP 实例）、目录结构、四步快速开始（含 `playwright install chromium`）、页面导航、测试命令、已知降级表、文档索引。
- **[`docs/deploy.md`](deploy.md)**：环境要求、Windows/Linux 首次部署、`.env` 全量配置表、前台/systemd/任务计划三种启动方式、Nginx 反代（SSE/WS 必须关缓冲）、SQLite 备份恢复、MySQL 切换步骤与四条限制、部署后冒烟清单、9 类故障排查、升级回滚。
- **[`docs/bug-log.md`](bug-log.md)**：本轮 10 条已修复、8 条已知限制（单进程/空库切换/MySQL 写设置/换 embedding 需重建索引/run_stream 阻塞/人脸降级/登录路径/密钥入库）、4 条待修。
- **[`tests/artifacts/`](../tests/artifacts)**：把 `tests/` 根的 16 张验证截图移入，脚本与产物分离；[`tests/verify_models_ui.py`](../tests/verify_models_ui.py) 的 `SHOT_DIR` 同步改指 `tests/artifacts`，避免再往根目录写图（2026-11-12 交付前清理：截图属过程产物已删除，脚本重跑会自动重建目录）。

### 变更

- **`requirements.txt`**：新增 `apscheduler==3.11.3`（定时任务 cron 依赖）；可选人脸依赖说明改为「只需 `onnxruntime` + 模型文件」，删除代码未使用的 `opencv-python`；两个 requirements 文件改为 **UTF-8 with BOM**，修复中文 Windows 下 pip 按 cp936 解码崩溃（`UnicodeDecodeError: 'gbk' codec can't decode byte 0xa7`）。
- **智能对话页侧栏（[`index.html`](../app/templates/index.html) / [`chat.js`](../app/static/js/chat.js) / [`chat.css`](../app/static/css/chat.css)）**：移除「快捷提问」区块（成都亲子游/三亚 vs 青岛/云南国庆/拉萨天气 4 条示例问句），腾出的空间全部给历史会话：原下拉选择器改为可点击列表 `#chatSessionList`，当前会话高亮、新建未入库会话置顶为「新会话（未保存）」、列表自成一列可滚动并占满侧栏剩余高度；空状态提示同步改为引导点击历史会话。
- **后台工作台（[`admin/index.html`](../app/templates/admin/index.html) / [`admin.py`](../app/controllers/admin.py) / [`admin.css`](../app/static/css/admin.css)）**：移除右侧「建设进度」卡片（12 条任务状态列表），同时清理只服务于它的 `ADMIN_ROADMAP` 常量、`roadmap` 模板上下文与 `.admin-progress*` 样式；右侧栅格保留「系统信息」卡片。
- **数字员工简介文案（[`db.py`](../app/models/db.py)）**：预置「旅行规划师」的简介由内部实现说明（「任务9预置：从 agent_service 硬编码抽离入库…」）改为产品化介绍「来自数据瞭望的旅行规划助手，支持行程编排、预算测算、天气查询、景点美食筛选与偏好记忆。」；种子文案与现有 SQLite / MySQL 库记录同步更新，对话页侧栏与后台数字员工列表即时生效。
- **测试目录精简**：交付前移除 `tests/` 根 26 个手工冒烟/UI 复验脚本（`smoke_*` / `verify_*` / `preview_*` / `gen_music_wavs` / `test_member_b` / `test_user`）与截图产物，测试基线统一为 `tests/pytest/`（160 项）；`README.md` / `deploy.md` / `acceptance-checklist.md` 中的复跑命令同步改为 pytest。
- **[`docs/acceptance-checklist.md`](acceptance-checklist.md)**：按代码证据重判——MCP 转 ✅（`/mcp/news` + `mcp_service` + `mcp_search`）、AI 对话转 ✅（RAG 实测命中 2 条、11435 在线）、多轮对话与历史会话转 ✅（`history` 注入 + `?sessions=1`）、定时任务去「后端」限定（实测 `engine=apscheduler`）、`workspace/` 与 `requirements.md` 两项偏差消除；技术栈判缺风险由 2 项（-20%）收敛到 1 项（AHLLMProxy，-10%）。

### 修复

- **[`tests/pytest/test_07_chat_assistant.py`](../tests/pytest/test_07_chat_assistant.py)**：`test_chat_requires_message` 仍断言英文 `message`，而接口文案早已改为「请输入 1 至 8000 字的消息」，改为匹配「消息」后 160 个用例全绿。
- **MySQL 双库兼容（[`db.py`](../app/models/db.py) / [`task.py`](../app/models/task.py) / [`settings.py`](../app/models/settings.py)）**：现场切库（SQLite → MySQL 5.7.26 → SQLite）暴露并修复 4 个建库/读写缺陷——① `to_placeholders()` 未转义 SQL 字面量 `%`（`LIKE 'https://%.baidu.com/%'` 被 pymysql 当格式串）；② DDL 列名未加反引号（`trigger` / `key` 是 MySQL 保留字）；③ 表级约束 `UNIQUE(source_id, title)` 被按列名拆分、`KEY` 前缀误吞 `keyword` 列（新增 `_is_table_constraint()`）；④ `INSERT OR REPLACE` 未翻译为 `REPLACE INTO`（LIM-003 根因）。详见 `docs/bug-log.md` BUG-011~014。

### 验证（2026-11-12 双库现场切换）

- **切换链路**：`settings_service.switch_database("mysql", ...)` → 目标库 `govagentos`（MySQL 5.7.26）自动建 **23 张表**并种子 26 菜单/2 角色/1 默认数字员工/1 默认模型 → 重启后 `/healthz` 返回 `"db":"mysql"`。
- **MySQL 驱动 HTTP 冒烟**：注册→提权→登录（users/user_sessions/login_logs 落库）、`/admin` 与 `/admin/settings|users|tasks|messages|models` 均 200、`/api/chat` SSE 正常、会话列表可见 `mysql-demo`；Repository 层 `task_logs`（`trigger` 列）与 `system_settings`（重复覆盖/删除）均通过。
- **切回 SQLite**：恢复 `.env` 并重启，`/healthz` 返回 `"db":"sqlite"`；原库 users 9 / messages 85 / task_logs 10 / system_settings 11 完好，旧账号登录与历史会话可用。
- **回归**：`python -m pytest` → **160 passed**；备份保留在 `logs/env.demo-bak-20261112-103439` 与 `logs/govagentos.db.demo-bak-20261112-103439`。

### 环境（本机已装，不入库）

- `apscheduler 3.11.3`（含 `tzdata`/`tzlocal`）、`pytest 9.2.0` + `pytest-html 4.2.0`、`onnxruntime 1.31.1`（含 `flatbuffers`/`protobuf`）；
- Playwright **Chromium 1248** + ffmpeg 内核（国内网络用 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` 下载），实测可启动页面；
- 验证：`pytest` 160 用例 0 失败（`pytest --html=logs/pytest-report.html --self-contained-html` 生成 158 KB 自包含报告，退出码 0）；`scheduler_service.status()` 返回 `engine=apscheduler`；`chromium.launch()` 成功；Crawl4AI 实采 `/healthz` 返回 `engine: crawl4ai`。
- **人脸模型已就位**：`w600k_r50.onnx`（174,383,860 字节 / 166.3 MiB）落到 `database/models/face/`（不入库），重启后 `face_service.engine_info()` = `{"engine": "onnx", "real": true, "degraded": false, "threshold": 0.35}`。下载过程踩到并修复两个脚本缺陷：临时文件跨盘 `os.replace` 报 `WinError 17`（改为目标同卷暂存）、首选 HF repo 已失效返 401（换两个公开镜像 repo + GitHub zip 兜底）。

---

## [未发布] - 2026-11-11（成员 C：前端基建 + 数智大屏 / 统计报表 / 智能舆情 / 工具链路 / 系统设置）

> 本段对应成员 C 分工（`/admin` 全部页面 + ECharts 大屏/报表 + 前端静态资源封装）。技术栈补齐 bootstrap 5.3.3
> 与 echarts 5.5.1（含省级地图），并补齐压在成员 C 身上的四个功能模块与两个基建产物；向后兼容，未打 Tag，
> `docs/VERSION` 同步升至 **v0.12.0**（按 `agent_roles.md` 的 `v0.x.0` 规则，成员 C 模块完成 +1 次版本）。
> 版本发布与 tag 仍由人类负责人决定。

### 新增

- **前端第三方资源本地化**（[`app/static/vendor/echarts/echarts.min.js`](../app/static/vendor/echarts/echarts.min.js)、
  [`china.json`](../app/static/vendor/echarts/china.json)、[`app/static/vendor/bootstrap/bootstrap.min.css`](../app/static/vendor/bootstrap/bootstrap.min.css)、
  [`bootstrap-grid.min.css`](../app/static/vendor/bootstrap/bootstrap-grid.min.css)）：echarts 5.5.1（1.03 MB）与
  bootstrap 5.3.3（完整版 232 KB + 仅栅格版 51 KB），均从 npm 中文镜像取包后解压复制，**零 CDN 依赖、离线可用**；
  `china.json` 的 34 个省级 feature name 与后端 `PROVINCES` 完全对齐（有单测守住）。
- **图表与页面公共底座**：[`static/js/chart-kit.js`](../app/static/js/chart-kit.js)（ECharts 统一封装：折线/柱/饼/中国地图/
  排行条、暗色主题、空态、`ResizeObserver` 自适应、`dispose`、PNG 导出、`loadChinaMap` 懒加载注册）、
  [`static/js/console-common.js`](../app/static/js/console-common.js)（`api` 请求带 XSRF、401 跳登录、`esc/fmtNum/fmtTime/toast/debounce/tabSwitch`）、
  [`static/css/console.css`](../app/static/css/console.css)（亮色 `.ck-*` 面板/KPI/表格/badge + 暗色大屏 `.ckb-*` 全屏布局 + 窄屏兜底）。
- **数智大屏**（[`controllers/console.py`](../app/controllers/console.py) 的 `AdminConsoleDashboardHandler`、
  [`templates/admin/dashboard.html`](../app/templates/admin/dashboard.html) + [`static/js/dashboard.js`](../app/static/js/dashboard.js)）：
  `/admin/dashboard` 独立全屏模板（不继承后台五段式壳）；6 KPI + 采集/对话 14 日趋势 + 中国地图省级着色 + 风险等级饼 +
  信源排行 + 实时预警流 + 底部最新采集滚动条 + 热词条；**SSE 实时**（`bootstrap` 首帧 / `snapshot` 增量 / `heartbeat` 保活，
  断线由 EventSource 自动重连并重新 bootstrap）；**语音播报**（`speechSynthesis`，中文声线优先，支持开关与语速）、
  **语音/文字问答**（麦克风走 Web Speech，不可用时浮层显式提示「请键盘输入」，不静默失败）、全屏/刷新/返回后台。
  地图数据口径为「采集标题/摘要中的省级行政区或省会城市文本提及」，页面明确标注，**不伪造采集地分布**。
- **统计报表**（`AdminReportsHandler` + [`templates/admin/reports.html`](../app/templates/admin/reports.html) +
  [`static/js/reports.js`](../app/static/js/reports.js)）：`/admin/reports`；7/14/30/90 日时段切换、6 KPI、趋势双 Y 轴
  （条数左轴 + Token 右轴，三系列可勾选自选图例）、风险等级饼、信源排行/占比切换、近 7 日风险堆叠柱、热词 Top16、
  最新采集清单；每分区独立 PNG 导出 + 「导出全部」；SSE 实时开关（关时回到按需刷新）。
- **只读聚合层**（[`models/console.py`](../app/models/console.py)）：`ConsoleStatsRepository` 提供 `by_region`（34 省文本提及
  口径，含 `_PROVINCE_ALIASES` 省会/计划单列市映射，按长度倒序匹配）、`latest_risks`、`risk_trend`（7 日四等级）、
  `recent_items`、`snapshot`（一次返回大屏/报表/预警台所需全部结构）；全部参数化 SQL，扫描行数有上限（各表 3000 行）。
- **智能舆情预警台重建**（[`templates/admin/sentiment.html`](../app/templates/admin/sentiment.html) +
  [`static/js/sentiment.js`](../app/static/js/sentiment.js)）：首屏服务端渲染 `reviews`（WS 断开也能读），WebSocket
  `/ws/admin/sentiment` 3 秒推送全量替换；四等级 KPI、等级筛选、高风险高亮 + 提示音（WebAudio，无音频文件）+
  桌面通知（权限未授予时显式关闭开关）、断线指数退避重连（最多 8 次后停）、7 日风险走势图；「分析待处理条目」沿用
  成员 B 的 `review_pending()`（表单 POST + 303 回页，提交时按钮置灰防重复）。
- **工具链路页**（`AdminToolsHandler` + `GET /api/admin/tools` + [`templates/admin/tools.html`](../app/templates/admin/tools.html) +
  [`static/js/tools.js`](../app/static/js/tools.js)）：`/admin/tools` 只读展示 6 个注册工具（weather/todo/task/memory/
  warehouse/mcp_search）的类型/提供方/说明 + 数字员工绑定矩阵（`digital_employees.tools`）与本地搜索；不提供动态注册，
  配置统一跳数字员工页，避免双写。
- **系统设置**（`AdminSettingsHandler` + `GET/POST /api/admin/settings` + [`services/settings_service.py`](../app/services/settings_service.py) +
  [`templates/admin/settings.html`](../app/templates/admin/settings.html) + [`static/js/settings.js`](../app/static/js/settings.js)）：
  `/admin/settings`（仅 `role_code()=="admin"`）。四张卡：**系统标识**（名称/副标题/Logo/Favicon/水印/大屏刷新间隔）、
  **数据库**（`db_test` 连通性预检 + `db_switch` 先测后切、失败回滚、`init_db()` 在目标库建表、`.env` 用临时文件
  `os.replace` 写回）、**语音与人脸**（TTS 声音列表/语速/自动播报、ASR 开关、人脸引擎与阈值）、**安全与会话**
  （会话有效期/失败锁定次数与时长/审计保留天数）。图标上传只认真实字节（png/jpg/gif/webp/svg，≤64 KB，随机文件名，
  落 `static/uploads/brand/`），不信任客户端 MIME 与文件名。
- **全局品牌注入**（[`controllers/base.py`](../app/controllers/base.py) 覆写 `render`、[`templates/base.html`](../app/templates/base.html)、
  [`templates/admin/base.html`](../app/templates/admin/base.html)）：所有页面统一注入 `site_name/site_subtitle/site_logo/site_favicon`，
  浏览器标题、favicon、后台 Logo/品牌名、foot 技术栈行、大屏标题全部改为动态，改配置 20 秒缓存过期后即生效（无需重启）。
- **系统图标与浏览器图标（品牌标识资产）**（[`static/uploads/brand/logo-govcheck.webp`](../app/static/uploads/brand/logo-govcheck.webp)、
  [`favicon-govcheck.webp`](../app/static/uploads/brand/favicon-govcheck.webp)）：按登录页/大屏的科技风设计——深空蓝渐变圆角方形底板，
  中央青蓝渐变同心雷达环 + 中心发光点 + 斜向光束（favicon 为同符号的加粗简化版，16px 仍可辨）；两枚均为 **WebP（256×256 / 6.1 KB、
  64×64 / 1.7 KB）**，远低于上传接口 64 KB 上限，四角透明可叠在深色与浅色底上。已通过 `/admin/settings` 的真实上传接口
  （`action=brand`）落库并生效：登录页品牌位、后台顶栏、数智大屏顶栏、`<link rel=icon>` 全部引用同一套标识；
  [`controllers/base.py`](../app/controllers/base.py) 增加 `DEFAULT_SITE_LOGO/DEFAULT_SITE_FAVICON` 兜底，新库/换机器未配置时也显示该标识，
  设置里上传后以 DB 值为准。
- **静态资源 WebP MIME 与顶栏图标尺寸**（[`application.py`](../app/application.py)、[`static/css/admin.css`](../app/static/css/admin.css)、
  [`templates/admin/base.html`](../app/templates/admin/base.html)）：Windows 上 `mimetypes` 把 `.webp` 猜成 `application/octet-stream`
  （浏览器可能不渲染 favicon），启动时显式注册 `image/webp`；后台顶栏新增 `.admin-logo-img` 规则（26×26、圆角 6px、`object-fit: cover`），
  修复上传 256px 方形图标后把 200px 宽 logo 区撑破的问题；`admin.css` 补版本号 `?v=20261111a` 避免浏览器吃旧缓存。
- **菜单与路由**（[`models/db.py`](../app/models/db.py) 的 `_seed_console_menus()` 幂等种子、[`application.py`](../app/application.py)）：
  新增分组「数据看板」（数智大屏 / 统计报表），「智能体服务」下加「工具链路」，「系统管理」下加「系统设置」，
  并把早期顶级误挂的「智能舆情」「知识仓库」保守归位（仅当 `parent_id==0` 时移动，不覆盖人工排序）。
- **测试**（[`tests/pytest/test_14_dashboard_reports.py`](../tests/pytest/test_14_dashboard_reports.py)、
  [`test_15_settings.py`](../tests/pytest/test_15_settings.py)）：30 个用例，覆盖页面挂载 vendor、快照结构、地域口径、
  省份与 `china.json` 对齐、问答规则分支、设置读取/保存/校验、图标上传白名单、库测试失败分支、工具接口形状、非超管 403，
  以及五页（大屏/报表/舆情/工具/设置）首屏 200 渲染回归。
- **RAG 示例知识库入库**（[`docs/knowledge-samples/`](knowledge-samples/)）：补 3 篇可检索的示例文档
  （采集与信源管理办法、舆情风险分级口径、系统使用手册），经 `/admin/knowledge` 同一条 `index_document()` 链路入库，
  当前 `knowledge_documents=3`、`knowledge_chunks=7`；库内暂无启用中的 embedding 模型，按设计降级为
  `local-lexical-v1` 词法向量（`fingerprint` 一致，检索可命中），启动模型代理后可重新索引升级为语义向量。

### 变更

- **登录页科技风改版**（[`templates/login.html`](../app/templates/login.html) + [`static/css/login.css`](../app/static/css/login.css)）：
  由单卡片居中改为左右分栏（品牌视觉 52% / 表单 48%），左侧深空蓝底 + 坐标网格 + 向下扫描光带 + 浮动粒子 +
  系统名/副标题/三项能力清单，右侧浅色表单区；tab 改胶囊式，输入框与主按钮改青蓝渐变（`focus` 光晕、
  hover 浮起），错误块与人脸取景框同步换肤。**表单契约零变更**：仍是 `POST /auth/login` + `xsrf_form_html()`，
  人脸登录仍走 `POST /auth/face/login`，`username/password/faceUsername` 等 id 与错误回显逻辑原样保留；
  ≤860px 自动退化为「顶部品牌条 + 单列表单」，1024px 收窄品牌栏。真机验证：窄屏/1440px 双档视觉正常、
  console 无报错、用验收账号登录后正常跳转 `/admin`；`/auth/register` 未受影响（仍沿用 base.css 旧样式）。
- **注册页同源改版 + 登录页去掉「安全登录」胶囊**（[`templates/register.html`](../app/templates/register.html)）：
  注册页由旧 `auth-wrap + layui-card` 单卡片改为与登录页同构的左右分栏（复用 `login.css`），左侧品牌区文案换成注册语义
  （「一个账号 / 贯通全域」+ 统一身份、角色自动分配、数据隔离三条清单），右上 chip 为 `ACCOUNT`；右侧三字段
  （用户名 / 密码 / 确认密码）配字段标签与图标，主按钮同款青蓝渐变。**提交契约零变更**：仍是 `POST /auth/register` +
  `xsrf_form_html()`，字段名 `username/password/confirm` 与 `{{ username }}` 回填、`{% raw error %}` 回显原样保留；
  窄屏同样退化为顶部品牌条 + 单列表单。同时删除登录页右上角「安全登录」胶囊及其 CSS（`.panel-top`/`.panel-chip`），
  样式表版本号升至 `?v=20261111d`。真机验证：1600/1440px 与 759px 两档视觉正常；错误分支（用户名过短）在新样式下
  正确回显且保留输入；注册成功后 302 回 `/auth/login`，用新账号登录进入前台工作台（普通用户角色），与后端行为一致。
- **模型 Token 统计弹层改用 ECharts**（[`static/js/models.js`](../app/static/js/models.js)）：原手写 `div` 柱状图替换为
  双折线趋势 + 横向排行条，图表资源按需注入（本页无 echarts 时动态加载，避免全站每页多拉 1 MB），弹层关闭时
  `dispose` 两个实例；汇总卡与调用明细表保持原样。
- **后台壳引入 bootstrap 栅格**（[`templates/admin/base.html`](../app/templates/admin/base.html)）：只加载 `bootstrap-grid.min.css`
  （不含 Reboot），位置在 layui 之后、`admin.css` 之前，按钮/表单/弹层仍统一用 layui，避免两套组件互相覆盖。
- **`base.html` 标题契约**：`<title>` 改为「系统名称 | 页面标题」，并支持动态 favicon；旧页面不传 `site_name` 时回退原样。
- `docs/VERSION` 由 `v0.11.1` → `v0.12.0`；`docs/acceptance-checklist.md` 技术栈 11/12 与工具链路、信源、任务二三相关行同步翻绿。

### 修复

- **系统图标撑破后台顶栏 logo 区**（[`templates/admin/base.html`](../app/templates/admin/base.html)、
  [`templates/admin/dashboard.html`](../app/templates/admin/dashboard.html)、[`static/css/admin.css`](../app/static/css/admin.css)）：
  上传 256×256 方形图标后，顶栏 `<img>` 没有尺寸约束，会按原始像素渲染并越出 200px 宽的 `.admin-logo`，盖住左侧菜单；
  现改为模板内联 `width/height=26` + CSS 兜底 `.admin-logo img{width/height/max-width/max-height:26px;object-fit:cover}`，
  并给 `.admin-logo` 加 `overflow:hidden;white-space:nowrap`，大屏顶栏 `<img>` 同样补 26×26 属性；
  `admin.css` 版本号再升到 `?v=20261111b`，避免浏览器继续用旧缓存（旧缓存正是用户侧仍看到大图的原因）。
- **`overview()["warehouse"]` 是 `{done,failed,pending}` 字典而非整数**：`_answer_question` 与前端 KPI 统一换算为
  「已入库正文」数，避免大屏问答出现 0 或 TypeError。
- **`by_source` / `top_keywords` 字段名**：按仓储层真实返回（`source_name`/`count`、`keyword`/`count`）修正大屏问答的
  读取键，原按 `name`/`value` 读取会静默丢失数据。
- **Font Awesome 版本口径**：模板与 JS 统一使用 FA5 名称（`fa-sync-alt`/`fa-shield-alt`/`fa-exclamation-triangle`），
  避免 `fa-rotate`/`fa-triangle-exclamation` 等 FA6 名称在本地 FA5 资源下渲染成空白。
- **设置页 MySQL 密码掩码**：页面回显 `******` 时，`db_test` / `db_switch` 不再用掩码去连库，服务端回退到 `.env`
  现网密码，避免「测试连接」误报账号密码错误或把掩码写进 `.env`。
- **`/admin/sentiment` 首屏 500（NameError: LEVEL_LABELS）**：模板在 `{% extends %}` 子模板里用 `{% set %}` 定义
  等级映射，但块内渲染取不到该变量，导致真实库有 75 条 review 时整页 500。改为块内 `if/elif` 直接输出等级中文名，
  并补 `test_sentiment_page_renders` 等三页首屏回归用例（该缺陷在纯 pytest 页面断言缺位时不会被发现）。
- **舆情/报表/工具/设置四页栅格失效（KPI 卡片竖排）**：这四页各自写了 `{% block styles %}`，把
  `admin/base.html` 里的 `bootstrap-grid.min.css` 覆盖掉了，页面里的 `.row/.col-xl-3/.col-xl-4` 全部退化为块级堆叠。
  四页 styles 块内补引 `bootstrap-grid.min.css`，并在页面渲染用例里加断言，防止再被覆盖。
- **舆情页筛选"点了没反应"**：`renderList()` 只渲染 `state.reviews`（该数组仅由 WebSocket 推送填充），WS 尚未推第一帧时
  点「高风险/关注」会把整列清空成"该等级下暂无记录"，看起来像按钮失效。改为：WS 无数据时直接对服务端已渲染的
  `data-level` 行做显隐过滤，WS 到达后仍走原整表重建路径。
- **舆情页 KPI 显示「—条」且命中数为 0**：启动时只等 `loadSnapshot()` 的异步结果，快照请求未返回前一直是占位符。
  `boot()` 改为先用服务端渲染的行统计等级计数与总数，快照仅在页面无服务端行时兜底。
- **分析失败无任何提示**：`review_pending()` 依赖 `.env` 的 `BASE_URL`（`127.0.0.1:11435`）；本地模型服务未启动时，
  每条分析都会落到"模型不可用或证据校验失败，可重试"，而页面只回一个 303，用户视角就是"点了没反应"。前端改为：
  检测到 error 且原因为模型不可用时，在工具栏下方插入显式红色说明条（指出 11435 未启动、需先启动模型再重试），
  并在分析提交后（`localStorage` 标记 + 303 回页）弹出本次结果汇总（高风险/关注/常规/待重试各几条）。
- **窄窗口下大屏地图整块消失（`/admin/dashboard`）**：大屏的三列比例靠 CSS Grid 锁死；窗口宽度 ≤860px 时
  `@media` 把 `.ckb-body` 改成 `display:block` 单列堆叠，父级失去固定高度，而地图容器 `.ckb-chart-flex` 的
  `height:auto; min-height:0` 会塌成 0 高，ECharts 初始化在 0 高画布上 → 地图不可见（面板只剩标题和热词）。
  窄屏兜底段给 `.ckb-chart-flex` 显式 380px、普通 `.ckb-chart` 220px、面板 280/520px 的最小高度，并让热词行换行；
  ≤1200px 时地图面板给 340px 下限。图表的 `window.resize`/ResizeObserver 自适应不变，窗口拉宽或进全屏即恢复三列。
- **窄屏下大屏问答浮层压住「实时预警流」**：`.ckb-ask` 是 `position:absolute` 的底部浮层，单列堆叠时直接盖住最后一个面板；
  ≤860px 给 `.ckb-body` 加 `padding-bottom:200px`，保证预警流能滚动到浮层上方。
- **报表「最新采集」链接全部指向当前页**：`ConsoleStatsRepository.recent_items()` 的 SELECT 漏了 `url` 列，
  前端 `r.url || '#'` 退化成空锚点。补上 `url` 字段后，10 条清单都指向原始信源链接。
- **`console.css` 引用加缓存键**（`?v=20261111b`，大屏 + 舆情/报表/工具/设置四页）：样式修复后浏览器仍用旧缓存，
  会出现"改了 CSS 但页面没变"的假象。

### 清理

- 大屏/报表/舆情/工具/设置五页统一走 `chart-kit.js` + `console-common.js`，不再各页复制请求/格式化/图表代码。

---

## [未发布] - 2026-11-10（成员 D：前台用户端增强——用户中心 / PDF 导出 / 3D 数字人 / @音乐 / 智能问数）

> 本段补齐任务一核心「智能问数」与任务二中属成员 D 的四项前台能力（用户中心 / 3D 数字人 / 导出对话 PDF / @音乐），
> 全部向后兼容，未提交、未打 Tag、VERSION 未改动，发布时机由人类负责人决定。

### 新增

- **用户中心**（[`controllers/user.py`](../app/controllers/user.py)、[`models/user.py`](../app/models/user.py) 扩展、
  [`user.html`](../app/templates/user.html) + [`user.js`](../app/static/js/user.js) + [`user.css`](../app/static/css/user.css)）：
  `/user` 个人中心页 + `/api/user/profile`（资料/统计，不回传哈希）、`/api/user/password`（验旧密、PBKDF2 重算盐哈希、
  改密后旧会话全部失效并重签当前会话，与任务11口径一致）、`/api/user/sessions`（本人活跃会话自查）；
  `users` 表新增 `nickname`/`avatar` 列（`_add_column_if_missing` 幂等）。
- **导出对话 PDF**（[`services/pdf_service.py`](../app/services/pdf_service.py)、[`controllers/chat_export.py`](../app/controllers/chat_export.py)）：
  `GET /api/chat/export?session_id=` 服务端 reportlab Platypus 渲染真 PDF（内置 CID 字体 STSong-Light，全离线中文），
  正文 xhtml_escape 后入 Paragraph 防标签注入；取本人会话最近 500 条，`is_partial` 红字标注，空会话回占位文档；
  对话页头部新增「导出PDF」按钮（[`chat.js`](../app/static/js/chat.js)）。
- **3D 数字人（虚拟主播版）**（[`controllers/avatar.py`](../app/controllers/avatar.py)、[`avatar.html`](../app/templates/avatar.html) +
  [`avatar.js`](../app/static/js/avatar.js) + [`avatar.css`](../app/static/css/avatar.css)）：`/avatar` 页采用动漫风 VRM 数字人模型
  pixiv `three-vrm-girl`（[`vendor/three/models/three-vrm-girl.glb`](../app/static/vendor/three/models/three-vrm-girl.glb)，2.6MB，
  随仓库分发零下载）+ 本地 vendor three.js r128 与其配套
  [`GLTFLoader.js`](../app/static/vendor/three/GLTFLoader.js)，unlit 动漫材质、43 个表情 morph：口型 a/i/u/e/o（索引 32~36）、
  眨眼（12）、joy 表情（2）；标准 humanoid 骨骼程序化驱动 idle 呼吸/头随鼠标视线/说话手势。**语音朗读**用浏览器原生
  Web Speech API（离线零依赖、无新 pip 包）：回复按句切分（。！？；换行）排队朗读，朗读期间口型 morph 随节奏切换，
  发送区提供静音开关（localStorage 持久化）；降级链：模型加载失败 → 低多边形程序化数字人（文字节奏模拟张嘴），
  WebGL 不可用 → 纯文字页；对话仍复用 `/api/chat` SSE 契约（独立 `session_id=avatar3d`），实时字幕逐字同步。
  模型许可：pixiv three-vrm 示例模型（meta：allowedUserName=Everyone），仅教学项目本地分发。
- **@音乐 播放**（[`models/music.py`](../app/models/music.py)、[`controllers/music.py`](../app/controllers/music.py)、
  [`tests/gen_music_wavs.py`](../tests/gen_music_wavs.py)）：`music_tracks` 表 + 幂等种子 6 首内置曲库；音频由脚本用标准库
  `wave` 程序化合成落 `static/music/*.wav`（12秒/22050Hz/16bit，离线可重跑）；`/api/music/search` 多词交集检索 +
  热门排序，`/api/music/play` 取地址并计数；对话页 `@音乐 关键词` 前缀拦截，气泡内 HTML5 audio 卡片自动播放，
  单路互斥不叠音。
- **智能问数**（[`models/qa.py`](../app/models/qa.py)、[`services/qa_service.py`](../app/services/qa_service.py)、
  [`controllers/qa.py`](../app/controllers/qa.py)、[`qa.html`](../app/templates/qa.html) + [`qa.js`](../app/static/js/qa.js) +
  [`qa.css`](../app/static/css/qa.css)）：`/qa` 页「选数字员工 → 提问 → 问数报告」全链路：`StatsRepository` 真实统计快照（成员 E 交付）
  → 模型结构化 JSON 分析（`complete_json`，字段级校验），模型不可用/非法时启发式兜底，永不报错；报告契约
  title/summary/metrics/chart/insights/advice，前端零依赖 canvas 手绘 bar/line；`qa_reports` 表按用户隔离历史回放。

### 变更

- [`application.py`](../app/application.py)：登记成员 D 的 13 条路由（`/user`、`/api/user/*`×3、`/api/chat/export`、`/api/music/*`×2、`/qa`、`/api/qa/*`×3、`/avatar`）。
- [`db.py`](../app/models/db.py)：`init_db()` 尾部新增成员 D 段（users 加列、`music_tracks`/`qa_reports` 建表 + 曲库种子），全部幂等。
- [`index.html`](../app/templates/index.html) / [`chat.js`](../app/static/js/chat.js) / [`chat.css`](../app/static/css/chat.css)：侧栏新增个人中心/数字人/问数入口，头部新增导出按钮，输入区新增 @音乐 拦截与音频卡片样式；侧栏底部入口改为手风琴式：默认只显示用户行（账号 + 退登 + 展开箭头），点击展开整行列表入口（个人中心/3D 数字人/智能问数/人脸管理/后台管理，图标+名称+箭头，与快捷提问行同构），修复窄栏下链接被挤压竖排显示不全的问题。
- [`requirements.txt`](../requirements.txt)：新增「成员 D」段：`reportlab==5.1.0`（服务端 PDF）；three.js 为 vendor 静态资源非 pip 依赖。
- [`docs/api.md`](api.md)：新增 2.3～2.6 成员 D 接口详述，路由表/数据表/缺项清单/变更记录同步。

### 修复

- **虚拟主播首帧机位/请求格式/图标三缺陷**（[`avatar.js`](../app/static/js/avatar.js)、[`avatar.html`](../app/templates/avatar.html)）：
  ① 模型导出单位非米级，固定机位 (0,1.28,1.05) 陷入身体——改为按 `Box3` 包围盒自适应取景（身高 h 驱动机位/网格缩放，脚底对齐 y=0）；
  ② 绑定姿态为 T-pose 双臂平举——新增 `lowerArm()` 用 `setFromUnitVectors` 几何四元数把上臂旋到世界下方（免猜旋转符号，留 12% 余量不完全绷直），基准姿态在垂手后捕获使 idle/手势叠加原点正确；
  ③ `/api/chat` 基线契约为 JSON 请求体，form 编码被 400「请求体必须为JSON」拒收——改 `JSON.stringify` + `Content-Type: application/json`（与 chat.js 同口径），并兼容 SSE 对象载荷（`{text}/{message}/{name}`）与 `detail` 错误字段；
  ④ 仓内 FontAwesome 为 v5，v6 类名 `fa-volume-high/xmark` 渲染空白——改 `fa-volume-up/fa-volume-mute`。
- **虚拟主播背对镜头且骨骼动画全部失效**（[`avatar.js`](../app/static/js/avatar.js)）：① 该模型 glTF 节点名是 Unity Humanoid 风（`J_Bip_L_UpperArm` 等），与 VRM humanoid 映射名（`leftUpperArm`）不同，按映射名正则匹配骨骼结果为空——垂手/视线/idle/手势全部静默不生效；新增 `BONE_ALIASES` 双命名别名表统一收归。② 模型实际面朝 -Z，+Z 机位看到的是后背——`root.rotation.y = Math.PI` 正对镜头，同步翻转视线跟随 X 项符号。③ `reasoning` 事件每个增量碎片新建一行导致字幕刷屏（英文思维链碎片满屏）——改为合并到同一「思考」行，`assistant`/`delta`/`done` 时重置行。
- **@音乐主曲目无法播放**（[`chat.js`](../app/static/js/chat.js) `renderMusicCard`）：此前只给卡片首曲挂 `play` 回调且回调内先 `stopCurrentAudio()`，而 `currentAudio` 正是首曲自身——autoplay 一开播就被自己暂停；热门排序按 `play_count DESC`，`静谧晨光` 恒居首位故必中此 bug，其余非首位条目未挂回调反而可播。现改为给卡片内每路音频挂回调，开播时只暂停旧音频不暂停自身；曲目互斥语义不变。
- **@音乐「正在播放」徽标不跟随切歌**（同上 `renderMusicCard`）：徽标此前渲染时写死在首项，切播其他曲目后仍显示在首行。现改为动态维护：任一路音频 `play` 时清除卡内旧徽标并挂到自己行，`pause`/`ended` 只摘自己行徽标（避免旧音频滞后事件误删新曲目徽标），播完自动消失。
- **3D 数字人随对话推进整体上移出屏**（[`avatar.css`](../app/static/css/avatar.css)）：`.avatar-app` 原为 `min-height:100vh`，字幕变长时整页被撑高产生页面级滚动，舞台跟滚跑掉；现改 `height:100vh + overflow:hidden` 固定视口，字幕只在面板内滚动（其 `overflow-y:auto` 此前因父级无定高而未生效），`.avatar-stage` 的 `min-height:420px` 同步降为 0。另修复降级提示常驻：`.avatar-fallback` 的作者层 `display:flex` 盖过 UA `[hidden]{display:none}`，舞台被撑高时会在画布下方露出「不支持 WebGL」文案，补 `[hidden]{display:none}` 压制。

### 测试

- 新增 pytest 用例 5 个文件 38 条：[`test_09_user_center.py`](../tests/pytest/test_09_user_center.py)、
  [`test_10_chat_export_pdf.py`](../tests/pytest/test_10_chat_export_pdf.py)、[`test_11_music.py`](../tests/pytest/test_11_music.py)、
  [`test_12_qa.py`](../tests/pytest/test_12_qa.py)、[`test_13_avatar_vtuber.py`](../tests/pytest/test_13_avatar_vtuber.py)：覆盖鉴权/参数校验/用户隔离/PDF 真字节流/音频静态可播/问数报告契约与启发式兜底/数字人本地 vendor 资源（GLTFLoader、VRM 魔数与体积）及页面契约。
- 问数用例临时禁用 `model_service.chat_engine`，遵守 conftest「不依赖网络/大模型」基线（仓内 `.env` 带真实凭据时也不会产生外部调用）。
- 全量回归：130 条中 129 通过；唯一失败 `test_07_chat_assistant::test_chat_requires_message` 为既有基线问题（chat.py 的校验文案改版后未同步用例，非本段改动引入）。

---

## [未发布] - 2026-11-10（成员 E：通知配置页 + 会话管理三页）

> 本段补齐成员 E「会话管理」职责的后台界面与通知参数的在线配置入口，共四个页面：
> `/admin/notify`（通知配置）、`/admin/archives`（会话归档）、`/admin/messages`（对话记录）、`/admin/sessions`（临时会话）。
> **未提交、未打 Tag、VERSION 未改动**，版本号与发布时机由人类负责人决定。所有改动保持既有接口向后兼容。

### 新增

- **通知配置页**（[`models/settings.py`](../app/models/settings.py)、[`controllers/tasks.py`](../app/controllers/tasks.py) 的
  `AdminNotifyPageHandler`/`AdminNotifyConfigHandler`/`AdminNotifyConfigSaveHandler`、[`admin/notify.html`](../app/templates/admin/notify.html) +
  [`notify.js`](../app/static/js/notify.js) + [`notify.css`](../app/static/css/notify.css)）：新增 `system_settings` key-value 表与
  `SystemSettingsRepository`（get/get_many/get_all/set/set_many/delete，通知项约定 `notify_` 前缀）；邮件 SMTP / QQ 机器人参数改为
  **数据库优先、`.env` 兜底**，后台可在线修改与清空回退；密码类字段读取时脱敏、不回传明文。
- **会话归档页**（[`controllers/archives.py`](../app/controllers/archives.py)、[`admin/archives.html`](../app/templates/admin/archives.html) +
  [`archives.js`](../app/static/js/archives.js) + [`archives.css`](../app/static/css/archives.css)）：`/admin/archives` 查 `message_archives`，
  `MessageArchiveRepository.paginate` 扩展为支持 username / session_id / role / keyword / `origin_created_at` 时间区间多条件筛选。
- **对话记录管理页**（[`controllers/messages.py`](../app/controllers/messages.py)、[`admin/messages.html`](../app/templates/admin/messages.html) +
  [`messages.js`](../app/static/js/messages.js) + [`messages.css`](../app/static/css/messages.css)）：`/admin/messages` 跳出 `messages` 表的
  `username` 隔离视图，面向后台跨用户查看；`MessageRepository` 新增 `admin_paginate`/`admin_get`/`admin_delete`/`admin_delete_batch`/`admin_count`
  与 `_admin_where` 辅助；六条件筛选 + 详情弹层（全文不截断）+ 单条删除 + 全选批量删除。
- **临时会话查询页**（[`controllers/sessions.py`](../app/controllers/sessions.py)、[`admin/sessions.html`](../app/templates/admin/sessions.html) +
  [`sessions.js`](../app/static/js/sessions.js) + [`sessions.css`](../app/static/css/sessions.css)）：`/admin/sessions` 查 `user_sessions` 登录会话；
  `SessionRepository` 新增 `admin_paginate`（`state` ∈ active/revoked/expired/all）/`admin_stats`（三态计数）/`revoke_by_id`（不依赖 token 明文）；
  支持撤销单条、按用户名批量下线、清理已撤销与过期，撤销时联动 `ws.kick_user` 踢下 WebSocket。

### 变更

- [`application.py`](../app/application.py)：登记 `/admin/notify`、`/api/admin/notify/config{,/save}`、`/admin/archives`、`/api/admin/archives`、
  `/admin/messages`、`/api/admin/messages`、`/api/admin/messages/(\d+)`、`/admin/sessions`、`/api/admin/sessions` 共 9 条路由。
- [`services/notify_service.py`](../app/services/notify_service.py)：渠道配置读取改为走 `SystemSettingsRepository`，保留 `.env` 兜底与未配置显式降级语义不变。
- [`db.py`](../app/models/db.py)：`init_db()` 建 `system_settings` 表；新增 `_ensure_ops_group`（获取或创建「系统运维」分组）与
  `_seed_notify_menu`/`_seed_archive_menu`/`_seed_messages_menu`/`_seed_sessions_menu` 四个按 url 幂等的菜单种子（sort 2/3/4/5）。

### 修复

- `admin/sessions.html` 对 dict 上下文用了 `{{ stats.active }}` 点号访问，Tornado 模板不回退 `__getitem__`，导致 `/admin/sessions` 抛
  `AttributeError` 返回 500 —— 改为项目既有的 `{{ stats["active"] }}` 方括号约定。
- `messages.js` 详情弹层在无应答助理时输出冗余的 `— (id=0)` —— 改为仅输出 `—`。

### 测试

- 新增 [`tests/verify_messages_sessions.py`](../tests/verify_messages_sessions.py)：**52/52** 全绿（两页页面渲染 + 全部筛选维度 + 分页越界 +
  详情 + 单条/批量删除 + 会话撤销/批量下线/清理 + 参数校验 + 菜单注册）；写操作只针对自建的 `_e2e_test`/`_e2e_user` 测试数据并自清理，
  撤销时避开当前登录会话，不破坏真实业务数据。
- 浏览器端 UI 复验：两页 200、表格真实数据、筛选/分页/详情弹层/各确认框正常，console 零报错。
- 同步文档：[`framework.md`](framework.md)（成员 E 新增文件附录）、[`architecture.md`](architecture.md)（第 3.2/3.3/3.4 层 + 新增第十节）、
  [`api.md`](api.md)（4.11/4.12 接口 + 数据表 + 未实现清单修正）、[`acceptance-checklist.md`](acceptance-checklist.md)（会话管理/对话管理转「已实现」）。

### 已知限制（待定，本次未改）

- `SystemSettingsRepository.set/set_many` 用 `INSERT OR REPLACE`，而 [`db.py`](../app/models/db.py) 方言层只翻译 `INSERT OR IGNORE` 与
  `datetime('now','localtime')`，**`DB_DRIVER=mysql` 下保存通知配置会失败**（SQLite 主链路不受影响）。待人类负责人确认后改用
  `ON DUPLICATE KEY UPDATE` 分支或补方言翻译。
- `/admin/notify` 页面按 `URL_NOTIFY` 菜单鉴权，但其两个配置接口仍按 `require_menu(URL_TASKS)` 鉴权；若某角色只分配了「通知配置」
  而未分配「定时任务」，会出现页面能进、保存报 403。本次未改动鉴权口径。

---

## [未发布] - 2026-11-09（成员 E：定时任务、消息通知、数据统计）

> 本段对应成员 E「数据仓库 / 定时任务 / 消息通知 / 会话管理」中尚需新建的三块：定时任务模块（周期调度 +
> 自动归档 + 日志清理）、定时任务结果推送（邮件 / QQ 通知封装）、面向成员 C 大屏/报表的数据统计接口。
> **未提交、未打 Tag、VERSION 未改动**，版本号与发布时机由人类负责人决定。所有改动保持既有接口向后兼容。

### 新增

- **定时任务调度核心**（[`scheduler_service.py`](../app/services/scheduler_service.py)、[`models/task.py`](../app/models/task.py)）：`scheduled_tasks`（周期任务配置）/
  `task_logs`（执行流水）两表 + Repository；调度引擎「APScheduler 优先、缺失显式降级 tornado」（IOLoop `call_at` + `run_in_executor`），
  `SCHEDULER_ENABLED=0` 时仅可手动触发；`execute_task` 写流水→按 `task_type` 派发内置处理→回写状态→依策略通知，`status()` 显式标注 engine/note 不静默降级。
- **自动归档 / 日志清理**（[`models/stats.py`](../app/models/stats.py) 的 `MessageArchiveRepository`、`db.py` `_seed_default_tasks`）：新增 `message_archives` 表，
  将超保留期的 `messages` 以「先查后删」跨库可移植方式迁移归档（`origin_id` 可追溯）；内置两条默认运维任务（每日日志清理 / 每日会话归档，间隔 86400s、仅失败通知）。
- **邮件 / QQ 通知封装**（[`notify_service.py`](../app/services/notify_service.py)）：全用标准库 `smtplib`/`ssl`/`urllib` 零新依赖；邮件 SMTP_SSL/STARTTLS，
  QQ 机器人 webhook 优先、回退 QQ 邮箱 SMTP；未配置渠道返回 `degraded` 不报错；凭据只从运行环境读取、日志不出口令。
- **定时任务后台管理**（[`controllers/tasks.py`](../app/controllers/tasks.py)、[`admin/tasks.html`](../app/templates/admin/tasks.html)、
  [`static/js/tasks.js`](../app/static/js/tasks.js)、[`static/css/tasks.css`](../app/static/css/tasks.css)）：`/admin/tasks` 页（调度器状态条 + 任务列表/弹层/日志）；
  任务 CRUD / 启停 toggle / 手动运行（线程池）/ 执行流水分页 / 调度器重载与重启 / 通知渠道测试 JSON API；`db.py` 幂等补种「系统运维 / 定时任务」菜单。
- **数据统计接口**（[`controllers/stats.py`](../app/controllers/stats.py)、`models/stats.py` 的 `StatsRepository`）：`/api/stats/overview|trend|by-source|by-risk|keywords|report`
  只读聚合，为成员 C 数智大屏 / 报表提供统一数据源；日期骨架 Python 侧生成 + `substr` 分组避免 MySQL 5.7 CTE，仅 `backend_required` 不绑定具体菜单。

### 变更

- [`application.py`](../app/application.py)：登记 `/admin/tasks`、`/api/admin/tasks*`、`/api/admin/scheduler`、`/api/admin/notify/test`、`/api/stats/*` 路由；
  `make_app()` 末尾拉起调度器（`scheduler_service.start()`，配置关闭时内部自动跳过，不阻塞启动）。
- [`config.py`](../app/config.py)、[`.env.example`](../.env.example)：新增定时任务与通知配置项 `SCHEDULER_ENABLED`/`SMTP_*`/`MAIL_*`/`QQ_*`（均非必填，缺失只影响通知渠道可用性）。
- [`db.py`](../app/models/db.py)：`init_db()` 幂等新建三表 + 索引；`LONG_TEXT_COLUMNS` 补 `result`/`detail`（MySQL MEDIUMTEXT）；`_seed_task_menu`/`_seed_default_tasks` 按 url/name 幂等补种。

### 修复

- `scheduler_service.reload_jobs()` 未声明 `global _started` 导致 CRUD 后 `UnboundLocalError`（任务配置保存接口 500）——已补 `global` 声明。

### 测试

- 新增 [`tests/smoke_tasks.py`](../tests/smoke_tasks.py)：**33/33** 全绿（normalize 纯函数 6 项 + 菜单/默认任务种子 + 任务 CRUD/toggle/重名/非法拦截 +
  手动运行与执行日志 + 调度器状态 + 通知降级 + 自动归档 + 统计接口）；SCHEDULER_ENABLED=0 走手动触发路径，全程临时库隔离。
- 同步文档：[`framework.md`](framework.md)（成员 E 新增文件附录）、[`architecture.md`](architecture.md)（第 3.2/3.3/3.4 层新增模块 + 第九节）、[`api.md`](api.md)（4.9/4.10 接口 + 数据表）。

---

## [未发布] - 2026-11-07（任务11～17，待人类负责人验收后定版本号）

> 本段对应成员 A「后端框架 & 权限/登录模块」的补齐工作，**未提交、未打 Tag、VERSION 未改动**，
> 版本号与发布时机由人类负责人决定。所有改动保持既有接口与 SSE 事件名兼容。

### 新增

- **配置中心**（[`config.py`](../app/config.py)、[`.env.example`](../.env.example)）：进程内唯一读取 `.env`；
  `COOKIE_SECRET`/端口/DEBUG/XSRF/数据库/会话/人脸/CORS/心跳全部可配，缺失或非法在启动期抛 `ConfigError`（中文提示）。
- **Token 会话与登录安全**（[`session.py`](../app/models/session.py)、[`db.py`](../app/models/db.py)）：
  `user_sessions` 只存 token 的 SHA256，支持过期/撤销/多端在线；`login_logs` 记录成功/失败/锁定/人脸/登出；
  `users` 补列 `last_login_at/failed_count/locked_until`；失败 5 次锁定 10 分钟（可配）。
- **统一鉴权中间件**（[`base.py`](../app/controllers/base.py)）：token 会话优先、旧 `username/role` cookie 兼容回退；
  `/api/*` 未登录统一 401 JSON（不再 302），页面 302 带 `next`；会话滑动续期。
- **人脸登录与人脸数据**（[`face.py`](../app/models/face.py)、[`face_service.py`](../app/services/face_service.py)、
  [`controllers/face.py`](../app/controllers/face.py)）：录入/状态/1:1 校验/删除、刷脸登录（1:1 与 1:N）、
  后台代录/启停/删除；特征 Fernet 加密入库、接口不回传向量；图片 ≤5MB 且仅 jpg/png/webp。
  真实引擎（onnxruntime + ArcFace ONNX）优先，缺失时 `auto` 显式降级并在响应/页面标注 `degraded/real/reason`。
- **双数据库适配**（[`db.py`](../app/models/db.py)）：统一 `Connection/Cursor/Row` 包装、`?`↔`%s` 占位符转换、
  DDL 自动翻译（AUTO_INCREMENT / VARCHAR / MEDIUMTEXT / CURRENT_TIMESTAMP / InnoDB / 索引先查后建）、
  异常归一 `db.Error/IntegrityError/OperationalError`；10 个 Repository 去掉 sqlite3 依赖。
- **统一异常与 CORS**（[`errors.py`](../app/controllers/errors.py)、[`error.html`](../app/templates/error.html)）：
  页面错误页 / 接口 JSON 双形态、`request_id` 贯穿日志与响应、500 固定文案不泄露堆栈、
  CORS 白名单精确匹配 + OPTIONS 预检 204 + 安全响应头。
- **SSE / WebSocket 基础封装**（[`sse.py`](../app/controllers/sse.py)、[`ws.py`](../app/controllers/ws.py)）：
  `SSEMixin`（统一头/事件编码/心跳/收尾）、`SSEBridge`（线程池→SSE）、`Heartbeat`；
  WebSocket 会话鉴权、Origin 白名单、统一协议、30s 心跳、连接注册表与踢下线。
- **健康检查与工程基线**（[`health.py`](../app/controllers/health.py)、[`requirements.txt`](../requirements.txt)）：
  `GET /healthz` 匿名可用（DB 故障 503、不泄露配置）；启动日志走 logging。
- **前台自助人脸录入入口（任务18）**（[`static/js/face.js`](../app/static/js/face.js)、
  [`static/css/face.css`](../app/static/css/face.css)、[`index.html`](../app/templates/index.html)）：
  登录后侧栏底部「人脸」按钮打开「人脸设置」弹层，可摄像头拍照或上传照片录入、查看/删除已录人脸、
  开关人脸登录；摄像头不可用（http 非 localhost / 无设备 / 拒绝授权）自动回退「上传照片」并给出中文提示；
  新增 `POST /api/face/toggle`（只改 `face_enabled`，不删特征）。

### 变更

- [`app.py`](../app.py)：端口/监听地址/DEBUG 改由配置中心读取，启动日志改为 logging。
- [`application.py`](../app/application.py)：`cookie_secret/xsrf_cookies/debug` 取自配置；新增
  `/healthz`、`/ws`、`/ws/notify`、`/api/face/*`、`/auth/face/login`、`/api/admin/users/<id>/faces*`、
  `/api/admin/users/<id>/logout`、`/api/admin/login-logs` 路由；未匹配路由统一走 `NotFoundHandler`。
- [`chat.py`](../app/controllers/chat.py)、[`model_engine.py`](../app/controllers/model_engine.py)、
  [`warehouse.py`](../app/controllers/warehouse.py)：SSE 端点改用统一封装（事件名与载荷不变）。
- [`admin.py`](../app/controllers/admin.py)：改密/改角色/改名/删除用户自动撤销会话；新增强制下线与登录审计接口。
- [`user.py`](../app/models/user.py)：`paginate` 随行返回 `face_enabled/face_count`；新增登录安全与人脸开关方法。
- [`message.py`](../app/models/message.py)：派生表补别名（MySQL 要求），清理无用导入。
- [`token_stats.py`](../app/models/token_stats.py)：日期骨架改 Python 生成（MySQL 5.7 不支持 CTE），
  排行查询满足 `ONLY_FULL_GROUP_BY`，字符串拼接按方言切换。
- [`warehouse.py`](../app/models/warehouse.py)：MySQL 走 `ON DUPLICATE KEY UPDATE`。
- [`login.html`](../app/templates/login.html)：新增「人脸登录」页签（摄像头取帧 → `/auth/face/login`，
  非安全上下文/无摄像头时给出降级提示）。
- [`admin/users.html`](../app/templates/admin/users.html) / [`admin.js`](../app/static/js/admin.js)：
  用户列表新增「人脸」列与「人脸」管理弹层（查看/代录/启停/删除，降级模式显式提示）。
- [`.gitignore`](../.gitignore)：排除 `.env`、人脸模型与运行期产物，保留 `.env.example`。

### 修复

- 未登录访问 `/api/*` 被 302 到登录页导致前端 JSON 解析失败（改为一律 401 JSON）。
- MySQL 下 `SUM()` 返回 `Decimal`、`DATETIME` 返回 `datetime` 对象导致 `json.dumps` 失败（连接层统一转 int/float/str）。
- MySQL 下派生表缺别名（`list_recent`）与 `TEXT DEFAULT` / `AUTOINCREMENT` / `MyISAM 1000 字节键长` 导致的建表失败。
- `debug=True` 时 500 会输出堆栈页（统一 `write_error` 后固定文案，堆栈只进日志）。

### 测试

`tests/smoke_config.py` 31/31、`smoke_auth.py` 35/35、`smoke_db.py` 64/64、`smoke_db_mysql.py` 44/44
（MySQL 5.7.26 实测）、`smoke_face.py` 41/41、`smoke_errors.py` 31/31、`smoke_stream.py` 27/27；
`tests/verify_face_ui.py` 25/25（任务18 前台人脸设置 Playwright 复验）；
既有 8 套 smoke 全绿；Playwright UI 复验 assistant/employees/models = 21/25/20 全绿。

---


## [v0.11.1] - 2026-11-07

> 修复：批量深度采集几乎全失败（实测「成功 1 / 失败 40」）。定位到三个叠加根因：
> ① **请求头错域**——信源 Request Headers 是为列表页（百度）配的，深采原样透传给异域详情页，`host: www.baidu.com` 请求 donews/ithome 直接返回 `403 Client Error: Forbidden`，带百度 `cookie`/`referer` 请求 autohome 被反爬返回 `418 Client Error: I'm a Teapot`；
> ② **Crawl4AI 从未真正生效**——Playwright 浏览器内核缺失（`ms-playwright` 目录为空），`AsyncWebCrawler` 每次启动即抛异常并被静默吞掉，全部降到裸 `requests` 抓取，而面板仍显示「引擎：Crawl4AI」，掩盖了真实原因；
> ③ **无正文/超短正文未判失败**——JS 渲染骨架页与反爬验证页（如「百度安全验证」）会被当成正文写入数仓。
> 修复后真实数据回归：41 条原数据**成功 34 / 失败 7**（成功率 2.4% → 82.9%），7 条失败全部为百家号「百度安全验证」滑块页（站点级反爬，无头浏览器无法绕过），且均给出明确提示、不入库。

### 修复

- **详情页请求头净化**（[`warehouse_service.py`](../app/services/warehouse_service.py)）：新增 `sanitize_headers()`，剔除与站点绑定的 `host`/`connection`/`content-type`/`accept-encoding`/`cache-control`/`upgrade-insecure-requests` 及 `sec-*` 系列头；`cookie`/`referer`/`origin` 仅同站（`_same_site` 按 hostname 父子域判定）保留，异域一律剔除（否则等于伪造身份）；无 UA 时兜底浏览器 UA，避免 `python-requests/x.y` 裸 UA 被普遍拦截。`crawl_page()` 与 `_fallback_crawl()` 统一走净化后的头。
- **Crawl4AI 三级浏览器兜底**：`_crawl_with_crawl4ai()` 依次尝试内置 chromium → 系统 Edge（`chrome_channel="msedge"`）→ 系统 Chrome，复用本机浏览器绕过内核未下载问题；浏览器实例显式指定浏览器 UA。
- **失败根因不再静默**：新增线程局部 `crawl4ai_error()` 记录最近一次 Crawl4AI 失败原因（内核缺失/浏览器启动失败/抓取未成功），回退引擎的报错自动拼接「（Crawl4AI 未生效：…）」，执行面板一眼可见真正原因，不会再被下游 403/418 误导。
- **渲染等待与正文阈值**：`CrawlerRunConfig` 增加 `delay_before_return_html=1.5`（仅 `domcontentloaded` 时部分站点只拿到骨架，实测同一页面 1.6KB → 38KB，autohome 正文 2538 → 4832 字）；新增 `MIN_CONTENT_CHARS=60` 最小正文阈值，骨架页/拦截页不再当作深采成功。
- **反爬验证页识别**：新增 `blocked_marker()`/`_reject_blocked()`，命中「百度安全验证」「请完成下方验证」「人机验证」「Just a moment」「Access Denied」「I'm a Teapot」等特征时按失败处理并落 `status=1` 错误信息，阻止验证页文案污染 `warehouse_data`。
- **数仓筛选下拉切换即刷新**（[`admin.js`](../app/static/js/admin.js)、[`warehouse.html`](../app/templates/admin/warehouse.html)）：此前「信源/状态」下拉只在点「搜索」时才读取，切换后列表纹丝不动。两个 `select` 补 `lay-filter`，新增 `bindFilter()` 同时监听 layui `select(...)` 事件与原生 `change`（未渲染时兜底）并按旧值去重，选中即从第 1 页重查。
- **下拉皮肤回填**：layui 皮肤是原生 `select` 的静态副本，异步填充信源选项后不重渲染则下拉里看不到信源，重渲染又不回填标题栏（首屏/重置后为空白）。新增通用 `renderSelect()`，统一「重渲染 + 按原生选中项回填标题文字与 `layui-this` 高亮」。Playwright 真实点击复验 11/11 通过（首屏回显、切换成功/失败/未深采、重置、按信源过滤均与接口真值一致）。

### 变更

- 深采失败提示具体化：原「页面无可抽取正文」改为「页面无可抽取正文（仅 N 字，多为 JS 渲染页或反爬拦截）」/「目标站点触发反爬安全验证（特征词），无法自动抓取正文」。
- 版本号升至 v0.11.1（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 清理

- 移除本次定位过程产生的临时诊断脚本（`tests/_diag_deep*.py`、`tests/_chk_filter.py`、`tests/_chk_ui_filter.py`、`tests/_chk_ui_dom.py`）。

---

## [v0.11.0] - 2026-11-06

> 任务10：数字助理选择——完成数字员工与前台用户侧的关联，在对话页输入区新增数字助理选择器。
> 任务9 把智能体配置抽进了 `digital_employees` 表，但前台对话仍固定用「默认数字员工」；本版补齐这条关联：用户在 composer 选定数字助理，选择按用户持久化到 `users.assistant_employee_id`（刷新/重新登录仍生效，`0` = 跟随系统默认）；对话按「本次显式选择 > 已保存助理 > 系统默认员工 > 首个启用员工 > 硬编码兜底」逐级解析，Agent 缓存按 `(user_id, employee_id)` 隔离互不串配置。
> 应答身份可追溯：SSE 新增 `assistant` 事件下发本轮实际应答助理（id/名称/头像/工具），气泡按发言人渲染署名与头像；`messages` 幂等补列 `employee_id`/`employee_name`，历史记录同样按助理身份回显。
> 前后端校验同源：选择与对话统一走 `pick_assistant`，避免「能选上但对话报错」；后台停用/删除助理时自动清零仍选定它的用户关联，前台带着失效助理提问被 400 拒接并气泡提示 + 清单自动刷新回退，对话链路永不报错。
> 冒烟测试 [`smoke_assistant.py`](../tests/smoke_assistant.py) 48/48 通过（底座补列/选择持久化/对话身份链路/解析优先级/装配与缓存隔离/后台联动/无可用助理边界）；Playwright 真实渲染复验 [`verify_assistant_ui.py`](../tests/verify_assistant_ui.py) 21/21 通过且无控制台报错；任务9/8/8.1、后台、信源、数仓、采集、用户七套回归全部通过（36/37/31/24/48/35）。

### 新增

- **关联底座（模型层）**
  - [`db.py`](../app/models/db.py) `init_db()` 幂等补列：`users.assistant_employee_id`（INTEGER NOT NULL DEFAULT 0，0=跟随系统默认）、`messages.employee_id`/`employee_name`（应答助理身份反范式存储，与采集表 `source_name` 同构，用户消息为 0/空串），存量库升级无需重建。
  - [`user.py`](../app/models/user.py) `UserRepository` 新增 `get_assistant_id`/`set_assistant_id`（写关联，非法入参拒绝、用户不存在返回 False）/`clear_assistant`（按 employee_id 批量清零，后台停用/删除联动用，幂等）。
  - [`message.py`](../app/models/message.py) `MessageRepository.save` 增加 `employee_id`/`employee_name` 可选参数（默认 0/空串，既有调用方零改动），`list_recent` 随行返回身份字段供历史按发言人渲染。
- **按助理装配与缓存隔离（服务层）**
  - [`agent_service.py`](../app/services/agent_service.py)：新增 `resolve_employee(user_id, employee_id=None)` 逐级解析（显式 > 已保存 > `get_default` > `get_first_enabled` > None 硬编码兜底，选中项停用/删除自动回退不抛异常）；Agent 缓存键由 `user_id` 改为 `(user_id, employee_id)` 元组，同用户切助理不串配置、同助理复用实例；`build_agent`/`get_agent`/`stream_answer` 增加 `employee` 可选参（不传仍按默认员工装配，任务9 行为完全兼容）。
- **前台选择接口（控制层）**
  - 新建 [`assistant.py`](../app/controllers/assistant.py)：`AssistantListApiHandler`（GET `/api/assistants`，仅启用助理清单 + `saved_id`/`selected_id` 当前生效项）、`AssistantSelectApiHandler`（POST `/api/assistants/select`，`employee_id=0` 恢复跟随默认）；共享 `pick_assistant`（存在性/启用态校验 + 关联落库，返回 (助理行, 错误文案)）与 `assistant_brief`（字段收敛，不下发 instructions 大正文）；仅 `@authenticated`，不校验后台菜单（前台用户侧接口）。
  - [`chat.py`](../app/controllers/chat.py)：请求体接受 `employee_id`，校验失败直接 400 JSON（不进 SSE）；应答开始前下发 `assistant` 事件声明本轮应答身份；`done` 落库携带助理 id/名称，用户消息固定 0/空串。
  - [`employees.py`](../app/controllers/employees.py)：新增 `_release_disabled_users`，停用/删除数字员工时同步清零仍选定它的用户关联（编辑未改启停不误清）。
  - [`application.py`](../app/application.py)：注册路由 `/api/assistants`、`/api/assistants/select`。
- **表现层（输入区数字助理选择器，零 layui）**
  - [`index.html`](../app/templates/index.html)：composer 内嵌 `#chatAsst` 选择器（当前助理按钮 + 向上弹出面板 + 计数/清单/底部提示）；侧栏人设卡改为由 `/api/assistants` 动态渲染，不再是硬编码文案。
  - [`base.css`](../app/static/css/base.css)：`.chat-asst-*` 选择器全套样式（面板/条目/徽章/选中勾/禁用态）、气泡署名 `.chat-bot-name`、轻量 `.chat-toast`，含窄屏适配。
  - [`chat.js`](../app/static/js/chat.js)：数字助理选择器模块（`loadAssistants`/`selectAssistant`/`paintCurrentAssistant` 按钮·侧栏·提示三处同步/`renderAssistantPanel` 含 iconClass 白名单与 escHtml 防 XSS/外部点击与 Esc 收起）；`handleFrame` 消费 `assistant` 事件回填本轮应答助理署名；`sendMessage` 携带 `employee_id`，400 时气泡展示 detail 并刷新清单；对话 400/切换失败均有 toast 反馈；初始化改为 `loadAssistants().then(loadHistory)` 保证历史气泡头像回查可用。
- **测试**：新增 [`tests/smoke_assistant.py`](../tests/smoke_assistant.py)——A 底座补列与清单接口（含未登录拦截/普通用户可访问/停用过滤/不下发大正文）、B 选择与持久化（含 0=跟随默认与各类非法入参 400）、C 对话链路（`stream_answer` 替身为假流，真实 HTTP 验证 assistant 事件与身份落库）、D 解析优先级五级回退、E Agent 装配与缓存隔离、F 后台停用/删除联动清零、G 无可用助理边界，共 48 项；新增 [`tests/verify_assistant_ui.py`](../tests/verify_assistant_ui.py)——自起临时库隔离服务 + Playwright 真实渲染复验（选择器渲染/面板开合/切换持久化/气泡署名/后台停用后真实 400 回退/历史身份），共 21 项；对话应答经 `page.route` 桩隔离本地大模型，选择/停用/回退均为真实后端行为。

### 变更

- `ADMIN_ROADMAP`（[`admin.py`](../app/controllers/admin.py)）增加「任务10 · 数字助理选择」已完成条目。
- 选择接口 `saved_id` 回显语义收敛：返回用户关联字段值（0=跟随系统默认）而非实际生效助理 id，与 `selected`（实际生效项）职责分离。
- 版本号升至 v0.11.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 修复

- 选择接口与对话接口校验规则不一致（可能出现「面板里能选上、对话时报 400」）：两处统一复用 `pick_assistant`，以 `/api/chat` 的解析规则为唯一基准（冒烟 B/C 组交叉断言）。
- 历史气泡头像回查时序问题：`loadHistory` 早于助理清单到达时按 id 回查 avatar 全部落空，初始化改为 `loadAssistants()` 完成后再拉历史。

---

## [v0.10.0] - 2026-11-06

> 任务9：数字员工模块——以 agentica 为基础的智能体管理模块 `/admin/employees`，把 `agent_service.py` 中硬编码的「旅行规划师」抽离到 `digital_employees` 表统一管理。
> 三大配置落地：① instructions 提示词（**零第三方依赖的手写 Markdown 可视化编辑器**，工具栏 + 编辑/分栏/预览三态，支持把 workspace 内多个 `.md` 文件关联注入提示词）；② 工具链路（`TOOL_REGISTRY` 动态勾选，工具管理模块落地后改为校验库表）；③ agentica 工作空间（workspace 目录真实浏览 + 防穿越校验）。
> 与模型引擎同为 layui 橱窗列表（**一行 4 列 / 12 条一页**），支持新增、删除、修改、启停开关、设为默认、搜索与状态过滤；RAG 知识库与模型绑定先落库字段与界面占位（依赖未实现的 RAG 管理模块）。
> 智能体装配改为读库：`build_agent` 取默认员工（其次首个启用）的提示词/关联文件/工具/工作空间/记忆开关，库内无启用员工时回退原硬编码兜底；任何配置变更 `reset_agents()` 即时生效，无需重启。
> 冒烟测试 [`smoke_employees.py`](../tests/smoke_employees.py) 36/36 通过；Playwright 真实渲染复验 [`verify_employees_ui.py`](../tests/verify_employees_ui.py) 25/25 通过且无控制台报错；任务8/8.1、后台、信源、数仓、采集五套回归全部通过（37/24/31/48/35）。

### 新增

- **数字员工底座（模型层）**
  - 新建 [`digital_employee.py`](../app/models/digital_employee.py)：`DigitalEmployeeRepository` 收拢 `digital_employees` 全部 SQL（全方法 `@staticmethod`）——`paginate`（12/页，关键字模糊 + 启停过滤，列表带大正文由控制层瘦身）、`get_all`/`get_by_id`/`get_default`（`is_default=1 AND enabled=1`）/`get_first_enabled`、`create`（首条自动为默认）、`update`（传 `None` 的字段保持原值，停用默认员工自动让位，刷新 `updated_at`）、`delete`、`set_default`（停用员工不可设默认）、`_promote_first`（事务内接力默认位）；`EMPLOYEE_PAGE_SIZE=12`、`AVATAR_ICONS` 8 项卡片头像（均为 FA5 有效类名）。
  - [`db.py`](../app/models/db.py) `init_db()` 新建 `digital_employees` 表（name UNIQUE、`instructions` 提示词正文、`link_files`/`tools`/`rag_kb_ids` JSON 文本、`workspace_path` 默认 `workspace`、`model_binding` 预留、`enable_long_term_memory`/`enable_experience_capture`、`enabled`/`is_default`、created_at/updated_at），`CREATE IF NOT EXISTS` 可重执。
  - `_seed_employee_menu` 幂等补种「智能体服务 / 数字员工」菜单（url `/admin/employees`，图标 `fas fa-user-astronaut` / `fas fa-users-cog`，分组为后续工具管理/RAG 管理预留）；`_seed_default_employee` 表空时把原硬编码「旅行规划师」（tools `weather/todo/task/memory`）入库为默认员工；`_backfill_menu_descriptions` 同步补简介。
- **智能体按库装配（服务层）**
  - [`agent_service.py`](../app/services/agent_service.py)：新增 `TOOL_REGISTRY`（`weather`→`WeatherTool`、`todo`→`BuiltinTodoTool`、`task`→`BuiltinTaskTool`、`memory`→`BuiltinMemoryTool`）；`_parse_json_list`/`_instruction_list`（按空行切段为 agentica instructions 数组）/`_linked_instruction_parts`（读 workspace 内关联 md，`Path.relative_to` 防穿越，缺失文件跳过不炸）/`_tools_for`；`build_agent(user_id)` 改为优先按库内默认员工装配（名称/提示词/关联文件/工具链路/工作空间路径/长期记忆与经验捕获开关全部来自库），`model_binding` 与 `rag_kb_ids` 留占位注释；库内无启用员工时回退 `_FALLBACK_INSTRUCTIONS` 硬编码旅行规划师兜底，保证前台对话永不断链。
- **控制层与接口**
  - 新建 [`employees.py`](../app/controllers/employees.py)：`WORKSPACE_ROOT` 与 `_safe_workspace_path`（拒绝绝对路径/盘符/越界）构成文件访问安全边界；`_public_row` 列表瘦身（JSON 列还原数组 + `instructions_preview` 压平截断，大正文只走详情接口）；`_norm_tools` 过滤非法工具 id、`_norm_link_files` 仅保留 workspace 内真实存在的 `.md` 且**保序去重**；`AdminEmployeesHandler` 页面壳（下发 `tool_options`/`avatar_icons`/`employee_page_size`）；`AdminEmployeesApiHandler`（GET 12/页分页 + 关键字 + on/off 过滤 / POST 新增，重名、提示词与关联文件全空、工作空间目录不存在均 400）、`AdminEmployeeItemHandler`（GET 详情含完整正文 / POST 更新 / DELETE）、`AdminEmployeeDefaultHandler`、`AdminEmployeeToggleHandler`（缺省参数按取反）、`AdminEmployeeFilesHandler`（GET `?path=` 返回 `dirs`/`mds`，越界 404）；所有变更 `reset_agents()`。沿用 `backend_required` + `require_menu('/admin/employees')`。
  - [`application.py`](../app/application.py)：注册页面 `/admin/employees` 与接口 `/api/admin/employees`、`/api/admin/employees/files`、`/api/admin/employees/(\\d+)`、`/api/admin/employees/(\\d+)/default`、`/api/admin/employees/(\\d+)/toggle`。
- **表现层（橱窗 + MD 编辑器 + 文件浏览）**
  - [`employees.html`](../app/templates/admin/employees.html)：功能区（搜索/状态过滤/重置/新增/计数）| `#empGrid` 橱窗区 | 分页区（提示「橱窗模式 · 每页 12 位数字员工」）。
  - [`employees.css`](../app/static/css/employees.css)：橱窗 4 列 grid 响应式（≤1400px 3 列、≤1100px 2 列、≤760px 1 列）、卡片头像圈/徽标/提示词预览/停用置灰、MD 编辑器工具栏与编辑·分栏·预览三态布局、文件浏览与工具 chip、RAG 预留位样式。
  - [`employees.js`](../app/static/js/employees.js)：`renderMarkdown`/`inlineMd` 手写渲染器（围栏代码/ATX 标题/无序有序列表/引用/hr/表格/段落 + 粗体斜体删除线行内码，先转义后拼装防 XSS）；`MdEditor`（11 键工具栏选区包裹 + 三态切换）；`Browse`（workspace 目录逐级下钻含「上级」与一键关联按钮）；`EmployeeModule`（橱窗加载/卡片模板/新增编辑弹层/头像图标选择/工具链路勾选/关联文件清单/启停/设默认/删除确认），请求统一带 `X-Xsrftoken`。
- **测试**：新增 [`tests/smoke_employees.py`](../tests/smoke_employees.py)——A 菜单与种子入库及列表瘦身、B CRUD 与重名/空配置/越界工作空间校验、C 关联文件去重与防穿越 + 文件浏览接口、D 12/页跨页与状态过滤及中文关键字搜索、E 默认唯一性与停用让位、F `build_agent` 读库装配（提示词/关联 md 注入/按勾选注入工具/无启用员工回退兜底）、G 删除与默认位幂等补齐、H 角色菜单鉴权 403 与授权放行，共 36 项；新增 [`tests/verify_employees_ui.py`](../tests/verify_employees_ui.py)——Playwright 真实渲染复验 4 列橱窗/卡片要素/开关真实 POST `/toggle`/弹层分区/MD 三态渲染/目录浏览关联/保存落库/设默认/删除恢复，共 25 项（含开机自清理残留数据，可重复执行）。

### 变更

- `ADMIN_ROADMAP`（[`admin.py`](../app/controllers/admin.py)）增加「任务9 · 数字员工」已完成条目。
- 版本号升至 v0.10.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 修复

- 卡片启停开关点击只切外观、不发消息（刷新后复原）：layui 源码中 `lay-skin="switch"` 派发的是 `switch(<lay-filter>)` 事件，`checkbox(<lay-filter>)` 只对 `lay-skin="primary"` 生效——原按 `checkbox(empToggle)` 注册导致回调永不命中，改为 `form.on("switch(empToggle)")`（Playwright B 组以真实 `POST /toggle` 响应取证）。
- 新增/编辑弹层点「保存」抛 `ReferenceError: currentIcon is not defined`：`var editor`/`var currentIcon` 声明在 layer 的 `success` 回调内却在 `yes` 回调中读取（同闭包 `self` 作用域陷阱），提升至 `openForm` 作用域后保存链路恢复。
- MD 编辑器切「预览」后渲染区空白：`preview-only` 状态下只隐藏了编辑区未显式打开预览区，补 `.emp-md-editor.preview-only .emp-md-preview{display:block}`（Playwright C4 作回归项）。
- 关联 md 文件重复项重复入库：`_norm_link_files` 改为按首次出现保序去重。
- 默认员工被停用/删除后库内无默认位，前台 `build_agent` 退化到硬编码兜底：`update`/`delete` 结尾无条件调用 `_promote_first`，保证任何变更后前台始终有默认员工。

---

## [v0.9.0] - 2026-11-06

> 任务7：数据仓库模块——采集管理原数据经「AI 模型引擎 + Crawl4AI」深度采集后的正文存储仓库 `/admin/warehouse`。
> 与信源/用户管理一致的 layui 后台三段式（功能区 | 列表区 | 分页区 20/页），支持更新/查看/删除/批量删除/搜索与信源·状态过滤。
> 深度采集分「单一深采」与「批量深采」（显式多选或按过滤条件全量未深采，单次最多 50 条），全过程经 SSE 执行面板实时呈现进度条、阶段日志与结果汇总。
> AI 模型引擎取功能模块「模型引擎管理」(任务8) 的默认模型（`ModelEngineRepository.get_default()`），大模型不可用时自动回退规则摘要；抓取 Crawl4AI 优先、内核缺失或异常时回退 requests + 启发式正文抽取，一条原数据 `UNIQUE(collect_item_id)` 对应一条深采结果，重复深采只 UPSERT 覆盖。
> 冒烟测试 [`smoke_warehouse.py`](../tests/smoke_warehouse.py) 48/48 通过（正文抽取/规则与 LLM 分析/服务链路/SSE 单一与批量深采/CRUD 分页/权限）；任务6 采集、任务5 信源、后台与用户回归全部通过；真实浏览器复验数仓页三段式、20/页分页、批量深采 SSE 面板、查看弹层、单一重采均正常。

### 新增

- **数据仓库底座（模型层）**
  - 新建 [`warehouse.py`](../app/models/warehouse.py)：`WarehouseRepository` 收拢 `warehouse_data` 全部 SQL（全方法 `@staticmethod`）——`save_deep`（按 `collect_item_id` UPSERT，成功置 `status=2`、失败置 `status=1` 并留存 `error`）、`paginate`（20/页，标题/关键词/摘要搜索 + 信源/状态过滤，列表不带正文大字段，成功优先再 id 倒序）、`get_by_id`/`get_by_collect_item`/`update_meta`/`delete`/`delete_many`/`count_all`/`count_by_status`；`PAGE_SIZE=20`、`STATUS_PENDING/FAILED/DONE`。
  - [`db.py`](../app/models/db.py) `init_db()` 新建 `warehouse_data` 表（`collect_item_id UNIQUE`、source/keyword/title/url、`content_md`/`content_text`/`word_count`、`ai_summary`/`ai_keywords`/`images`(JSON)、`engine`/`llm_used`/`error`/`status`/`username`/时间戳）+ 索引，`CREATE IF NOT EXISTS` 可重执；`_seed_warehouse_menu` 幂等补种「数据采集 / 数据仓库」菜单（url `/admin/warehouse`，图标 `fas fa-warehouse`）并回填简介。
  - [`collect.py`](../app/models/collect.py) 新增 `get_by_id`、`list_sources`（供深采按原数据回查与信源统计）。
- **深度采集编排（服务层）**
  - 新建 [`warehouse_service.py`](../app/services/warehouse_service.py)：`CRAWL4AI_AVAILABLE` 探测；抓取双路 `_crawl_with_crawl4ai`（`AsyncWebCrawler` + `CrawlerRunConfig` 旁路缓存）与 `_heuristic_main_content`（`article`/`.article-content` 等容器优先 + 最长文本退化 + 相对链接补全 + 图片收集，`_fetch_with_requests`/`crawl_page`）；`_default_engine` 取模型引擎管理默认模型、回退 `.env`；`ai_analyze`（`AsyncHTTPClient` POST `{api_url}/chat/completions`，`thinking` 下发 `enable_thinking`，稳健解析严格 JSON `{summary,keywords}`，失败 `used=False`）与 `heuristic_analyze`（规则摘要 + 2/3-gram 关键词）；编排 `deep_collect_one`（抓取→分析→`save_deep` 落库，按区间回报 `start/crawl/parsed/ai/rule_done/saved/error` 进度事件）与 `deep_collect_batch`（逐条均分进度、单条失败不中断、发 `batch_start/batch_done`）；`MAX_BATCH_ITEMS=50`。
- **控制层与 SSE 深采接口**
  - 新建 [`warehouse.py`](../app/controllers/warehouse.py)：`WarehousePageHandler` 页面壳；`WarehouseListApiHandler`（GET 20/页 + 过滤）、`WarehouseItemApiHandler`（POST 更新元信息 / DELETE）、`WarehouseDetailApiHandler`（GET 含正文，`ai_keywords`/`images` JSON 解析）、`WarehouseBatchApiHandler`（批量删除）、`WarehouseSourcesApiHandler`（信源选项，复用 `collect_service.parse_placeholders` 且不回传敏感 headers）、`WarehouseItemsApiHandler`（原数据列表，`only_undone=1` 排除已成功深采）；`DeepCollectOneApiHandler`/`DeepCollectBatchApiHandler` 深采 SSE；深采阻塞编排放入专用 `ThreadPoolExecutor`，`stream()` 经 `asyncio.Queue` 转 SSE 并含心跳（`HEARTBEAT_SECONDS=10`），`asyncio.wrap_future` 收尾下发 `result`。沿用 `backend_required` + `require_menu('/admin/warehouse')`。
  - [`application.py`](../app/application.py)：注册页面 `/admin/warehouse` 与接口 `/api/admin/warehouse(/batch/sources/(\d+)/(\d+)/detail)`、`/api/warehouse/items`、`/api/warehouse/deep/one`、`/api/warehouse/deep/batch`。
- **表现层（数仓页 + 执行面板）**
  - [`warehouse.html`](../app/templates/admin/warehouse.html)：功能区（搜索/信源/状态过滤 + 搜索/重置/批量删除/批量深采 + 计数）、列表区（全选 + 标题/信源/关键词/正文字数/深采状态/更新时间/操作 8 列）、分页区（每页 20 条）。
  - [`admin.js`](../app/static/js/admin.js) `WarehouseModule`：`load`/`loadSources`/`openForm`(编辑元信息)/`openView`(含正文查看弹层)/`del`/`batchDelete`/`deepOne`/`openBatchDeep`(AI 与 Crawl4AI 开关表单)/`openPanel`/`connectPanel`——`EventSource` 消费 `progress/batch_done/result/error` 渲染进度条、阶段日志与结果汇总，收尾主动 `es.close()` 防自动重连重复触发；`currentModule` 路由 `/admin/warehouse`。
  - [`admin.css`](../app/static/css/admin.css)：数仓与执行面板样式（`.wh-*`）。
- **测试**：新增 [`tests/smoke_warehouse.py`](../tests/smoke_warehouse.py)——E 组正文抽取纯函数、A 组规则/LLM 分析（含 LLM 成功解析与无配置回退）、L 组服务链路（单一/批量深采、UPSERT、Crawl4AI 回退、LLM 失败回退规则）、M/R 菜单与采集落库、S 单一深采 SSE、T 批量深采 SSE(all_pending)、U CRUD/分页/过滤/详情、V 删除、W 原数据 only_undone、X 权限 403/授权放行、Y 未登录跳转，共 48 项；新增 [`tests/preview_warehouse.py`](../tests/preview_warehouse.py) UI 预览引导（本地夹具 + 演示数据 + 应用）。

### 变更

- `ADMIN_ROADMAP`（[`admin.py`](../app/controllers/admin.py)）增加「任务7 · 数据仓库」已完成条目。
- 版本号升至 v0.9.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 修复

- 后台三段式列表页分页条被固定底栏遮挡：`.layui-layout-admin .admin-body` 默认 `bottom:0` 与 fixed `.layui-footer` 重叠，长列表滚到底后分页下半部命不中点击——补 `bottom:44px` 使滚动区停在底栏之上（真实浏览器复验原生点击页码即时生效）。
- 单一深采执行面板进度条停在 95%：末事件 `saved` 仅到 95%，批量靠 `batch_done` 补满而单一无——`connectPanel` 的 `result` 收尾统一 `setProg(100)`。

---

## [v0.8.0] - 2026-11-06

> 任务8.1：模型 Token 统计——在任务8 模型引擎管理基础上增加用量采集、聚合与图形化呈现。
> 每次真实调用模型（后台对话/向量/图片测试、前台智能体对话）成功后落一条 token 流水，上游未返回 `usage` 时按文本估算兜底（中文 ~1 token/字，其余 ~4 字符/token）。
> 两项交付：① token 直观反馈到模型列表卡片（累计用量大字 + 调用次数 + 按全库最大值折算的迷你比例条）；② 「Token 统计」弹层图形化呈现（汇总卡 + 近 N 日输入/输出堆叠柱趋势 + 模型用量排行条 + 最近调用明细，纯手写 DOM/CSS 零第三方图表库）。
> 冒烟测试 [`smoke_models.py`](../tests/smoke_models.py) 扩至 37/37 通过（新增 H 组 token 断言）；Playwright 真实渲染复验 [`verify_models_ui.py`](../tests/verify_models_ui.py) 扩至 20/20 通过（新增 K 组卡片反馈与图表断言）。

### 新增

- **Token 流水与聚合（模型层）**
  - 新建 [`token_stats.py`](../app/models/token_stats.py)：`TokenStatsRepository` 收拢 `model_token_logs` 全部 SQL（全方法 `@staticmethod`）——`record`（非负兜底、合计缺失取输入+输出、`sqlite3.Error` 静默不影响主链路）、`stats_by_engine`（按模型全时段聚合）、`summary`（全局汇总）、`daily_trend`（`WITH RECURSIVE` 生成连续日期序列补齐 0 值日，趋势图不缺列）、`model_ranking`（LEFT JOIN 兜底已删除模型）、`recent_logs`、`delete_by_engine`；`TOKEN_KINDS`（model_test=模型测试 / chat=智能体对话）。
  - [`model_engine.py`](../app/models/model_engine.py) `paginate` 关联子查询随行带出 `token_total`/`call_count`（零新增列）。
  - [`db.py`](../app/models/db.py) `init_db()` 新建 `model_token_logs` 表（engine_id/kind/prompt_tokens/completion_tokens/total_tokens/username/created_at）+ 索引 `idx_token_logs_engine`/`idx_token_logs_created`，`CREATE IF NOT EXISTS` 可重执。
- **双链路 usage 采集（服务层）**
  - [`model_service.py`](../app/services/model_service.py)：`estimate_tokens`/`_usage_from_texts`/`_record_usage`；`stream_chat_test` 累积 usage 与输出文本，收尾时上游无 usage 则估算并下发 `usage` 事件 + 落流水；`embedding_test` 有 usage 同步落库。
  - [`agent_service.py`](../app/services/agent_service.py)：`_record_chat_usage`，`stream_answer` 捕获 `resp.usage`（兼容 dict 与对象两种形态），收尾按 chat 类型落账。
- **统计接口与联动清理（控制层）**
  - [`model_engine.py`](../app/controllers/model_engine.py)：橱窗列表随行下发 `token_total`/`call_count` 并附全库最大值 `token_max` 与 `summary`；新增 `AdminModelStatsHandler`（GET `/api/admin/models/stats`，参数 days(1-90 默认14)/engine_id，返回 summary/trend/ranking/logs）；删除模型时 `TokenStatsRepository.delete_by_engine` 同步清理流水。
  - [`application.py`](../app/application.py)：注册路由 `/api/admin/models/stats`。
- **表现层（卡片反馈 + 图表弹层）**
  - [`models.html`](../app/templates/admin/models.html)：功能区新增「Token 统计」按钮 `#modelStats`。
  - [`models.css`](../app/static/css/models.css)：卡片 token 反馈样式（`.model-token`/`.model-token-num`/`.model-token-bar`）+ 统计弹层图表样式（`.mstats-chips` 汇总卡 / `.mstats-chart` 堆叠柱 / `.mstats-rank` 排行条 / `.mstats-table` 明细）+ 响应式。
  - [`models.js`](../app/static/js/models.js)：`fmtTokens`（k/M 友好显示）；卡片 token 行 + 迷你比例条（宽度按 `tokenMax` 折算）；`openStats`/`statsHtml` 统计弹层（layer 弹层，支持近 7/14/30 日切换重渲）；对话/向量测试收到 usage 后 `done` 即时刷新卡片。
- **测试**：[`smoke_models.py`](../tests/smoke_models.py) 新增 H 组（估算纯函数 / record 合计兜底 / 列表随行 token / stats 结构含 0 值日补齐 / 真实对话后 token 增长与 usage 事件 / 删除联动清理）；[`verify_models_ui.py`](../tests/verify_models_ui.py) 新增 K 组（卡片 token 非 0 / 调用次数 / 迷你比例条宽度 / 收尾无前端异常 / 四张汇总卡 / 14 日堆叠柱 / 排行条 / 明细表 / 近30日切换联动）。

### 变更

- `ADMIN_ROADMAP`（[`admin.py`](../app/controllers/admin.py)）增加「任务8.1 · 模型 Token 统计」已完成条目。
- 版本号升至 v0.8.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 修复

- 卡片迷你比例条渲染为 `width:NaN%`：`cardHtml` 方法体内未绑定 `self`，浏览器全局 `self` 指向 `window` 导致 `self.tokenMax` 为 `undefined`，改用 `ModelModule.tokenMax || 1`。
- 对话测试收尾抛 `TypeError: self.load is not a function`：`openTest` 缺 `var self = this`，SSE `done` 事件里的 `self.load(self.page)` 落到全局 `self`，补 `var self = this` 使卡片 token 实时刷新链路生效（Playwright K0 复验）。

---

## [v0.7.0] - 2026-11-06

> 任务8：模型引擎管理模块——大模型及服务接入管理 `/admin/models`（OpenAI 接口范式）。
> 橱窗列表一行 2 列、4 条/页，卡片含类型色饰条/徽标/脱敏配置/快捷操作；模型类型对齐主流 MaaS 分类（文本/多模态/图片/VL/嵌入）。
> 对话测试为 ChatGPT 式多轮流式会话（SSE），支持思维链开关（enable_thinking）并内置上游限制回退；预置默认文本模型（`http://127.0.0.1:11435/v1`，model_id `smart`）供新建与测试。
> 冒烟测试 31/31 通过，任务5 回归 31/31、任务6 回归 35/35、后台回归 24/24 通过；Playwright 真实渲染复验 11/11 通过（两列橱窗/思维开关皮肤/流式出字/思维链灰盒）。

### 新增

- **模型引擎管理模块（/admin/models）**
  - 模型层 [`model_engine.py`](../app/models/model_engine.py)：`ModelEngineRepository`（`paginate` 橱窗分页 4/页默认置顶+关键字/类型过滤、`get_all/get_by_id/get_default`、`create` 首模型自动默认、`update` api_key 空串视为保持不变、`delete` 删默认自动让位、`set_default` 唯一默认、停用默认时 `_promote_first` 接力）；`MODEL_TYPES` 五类约束（text/multimodal/image/vl/embedding）。
  - 服务层 [`model_service.py`](../app/services/model_service.py)：OpenAI 接口范式真异步测试通道——`stream_chat_test`（AsyncHTTPClient streaming_callback + asyncio.Queue 逐行解析 SSE，`enable_thinking`/`chat_template_kwargs` 双通道传参；上游限制 `enable_thinking` 只能为 True 返回 400 时自动去掉思维参数重试并发 `notice` 事件告知）、`embedding_test`（返回维度/预览/usage）、`image_test`（返回图片列表）。
  - 控制层 [`model_engine.py`](../app/controllers/model_engine.py)：`AdminModelsHandler` 页面壳；`AdminModelsApiHandler`（GET 分页 / POST 新增）、`AdminModelItemHandler`（POST 编辑 / DELETE 删除）、`AdminModelDefaultHandler`（设默认）、`AdminModelTestHandler`（POST SSE 测试，按类型分流对话/向量/图片）；`_mask_key` 服务端脱敏 api_key（前4后4），列表接口不回传明文密钥；所有变更后 `reset_agents()` 清智能体模型缓存；沿用 `backend_required` + `require_menu('/admin/models')` 菜单鉴权。
  - 表现层：[`models.html`](../app/templates/admin/models.html) 橱窗框架壳（功能区关键字/类型过滤/新增 + `#modelGrid` 橱窗区 + 分页）；[`models.css`](../app/static/css/models.css) 独立橱窗风格——2 列 grid 响应式（≤900px 单列）、卡片顶部类型色渐变饰条（文本蓝/多模态紫/图片橙/VL青绿/嵌入绿）、类型/默认/思维链徽标、悬浮升起、测试弹层气泡与思维链灰盒样式；[`models.js`](../app/static/js/models.js) 橱窗渲染/表单弹层/删除确认/设默认/测试弹层（text/multimodal/vl 走多轮流式对话 + 思维开关，vl/multimodal 支持附图片 URL；embedding/image 走单轮结果测试），SSE 消费 delta/reasoning/usage/notice/error/done 事件，请求携带 `X-Xsrftoken`。
  - 路由 [`application.py`](../app/application.py)：页面 `/admin/models`；接口 `/api/admin/models`、`/api/admin/models/(\\d+)`、`/api/admin/models/(\\d+)/default`、`/api/admin/models/(\\d+)/test`。
- **数据库与种子**（[`db.py`](../app/models/db.py) `init_db()`）
  - 新建 `model_engines` 表（name UNIQUE、api_url、api_key、model_id、type、thinking、enabled、is_default、description、created_at），`CREATE IF NOT EXISTS` 可重执。
  - `_seed_model_menu` 幂等补种「模型服务 / 模型引擎」菜单（url `/admin/models`，图标 `fas fa-microchip` / `fas fa-robot`）；`_seed_default_model_engine` 表空时预置默认文本模型「Smart 文本模型」；`_backfill_menu_descriptions` 同步补简介。
- **智能体接入默认模型引擎**（[`agent_service.py`](../app/services/agent_service.py)）：`_model_conf()` 优先取 `ModelEngineRepository.get_default()`（后台可切换），无记录回退 `.env` 的 `BASE_URL/API_KEY/MODEL_ID`；新增 `reset_agents()`，模型增删改/设默认后即时生效，无需重启。
- **测试**：新增 [`tests/smoke_models.py`](../tests/smoke_models.py)——种子/CRUD/重名与 URL 与类型校验/分页 4 条跨页/中文搜索/默认唯一性与停用·删除让位/菜单鉴权 403/真实 SSE 流式对话（思维开有 reasoning、思维关正常完成或 notice 回退、非法 messages 错误事件），共 31 项断言；新增 [`tests/verify_models_ui.py`](../tests/verify_models_ui.py)——Playwright 真实渲染复验（2 列橱窗/徽标/脱敏/新增并排卡/思维开关皮肤与点击同步/流式出字/思维链灰盒/删除恢复），共 11 项。

### 变更

- `ADMIN_ROADMAP` 增加「任务8 · 模型引擎管理」已完成条目。
- 版本号升至 v0.7.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

### 修复

- 测试弹层思维开关渲染为原生复选框（未出 layui 开关皮肤）：弹层内容缺 `.layui-form` 容器导致 `form.render` 失效，为 `.mtest` 补 `layui-form` + `lay-filter="mtestForm"` 并改用 `form.render(null, "mtestForm")`，Playwright 复验开关皮肤与点击同步通过。
- 上游模型服务限制 `enable_thinking` 只能为 True 时思维关测试 400：服务层捕获后去思维参数自动重试并发 `notice` 事件，前端渲染黄色提示告知已按模型默认行为继续。

---

## [v0.6.0] - 2026-11-06

> 任务7：数据仓库模块——深度采集正文仓库 `/admin/warehouse`（layui 后台页，规范与用户/信源管理一致）。
> 深采引擎 = Crawl4AI（playwright 内核前端渲染导出 markdown/media）+ AI 模型引擎（默认模型做摘要+关键词，失败回退规则分析）；单条与批量深采经 SSE 实时推送进度。
> 列表 20/页，支持搜索/信源/状态过滤、元信息编辑、详情查看与批量删除。
> 冒烟测试 [`smoke_warehouse.py`](../tests/smoke_warehouse.py) 49 项断言覆盖纯函数与真实 HTTP 全流程。
> （本条目为落地后补记：任务7 代码早已完成并入 roadmap，CHANGELOG 当时未及时同步。）

### 新增

- **数据仓库模块（/admin/warehouse）**
  - 模型层 [`warehouse.py`](../app/models/warehouse.py)：`WarehouseRepository`（`save_deep` 按 `collect_item_id UNIQUE` 落库、`get_by_id/get_by_collect_item`、`paginate` 20/页关键字/信源/状态过滤、`update_meta/delete/delete_many/count_all/count_by_status`），`PAGE_SIZE = 20`。
  - 服务层 [`warehouse_service.py`](../app/services/warehouse_service.py)：`crawl_page` 双引擎（优先 `_crawl_with_crawl4ai`，`CRAWL4AI_AVAILABLE` 可选导入缺失自动降级 `_fetch_with_requests` + `_heuristic_main_content` 规则提取正文）；`ai_analyze` 走默认模型引擎 OpenAI chat/completions（正文上限 `LLM_TEXT_LIMIT=6000`、超时 60s，输出严格 JSON 摘要+关键词），失败回退 `heuristic_analyze`（前 3 有效段落 ≤120 字）；`deep_collect_one/deep_collect_batch`（单批上限 `MAX_BATCH_ITEMS=50`）经 progress 回调发阶段事件；全部同步阻塞函数由控制层线程池调度。
  - 控制层 [`warehouse.py`](../app/controllers/warehouse.py)：`WarehousePageHandler` 页面壳；`WarehouseListApiHandler/WarehouseItemApiHandler/WarehouseDetailApiHandler/WarehouseBatchApiHandler/WarehouseSourcesApiHandler/WarehouseItemsApiHandler` 承载数仓 CRUD、原数据选择与信源选项（不回传敏感 headers）；`DeepCollectOneApiHandler/DeepCollectBatchApiHandler` 深采 SSE（EventSource 仅 GET，参数经 `?p=<URL 编码 JSON>` 传递；专用 `ThreadPoolExecutor(3)` 隔离阻塞调用，`asyncio.Queue` 转 SSE，10s 心跳保活，`all_pending=1` 按过滤条件全量深采）；沿用 `backend_required` + `require_menu('/admin/warehouse')` 菜单鉴权。
  - 表现层：[`warehouse.html`](../app/templates/admin/warehouse.html)「功能区 | 列表区 | 分页区」+ 深采执行面板；[`admin.js`](../app/static/js/admin.js) 新增 `WarehouseModule`（列表/过滤/编辑/详情/批量删除、单条与批量深采 EventSource 进度面板）。
  - 路由 [`application.py`](../app/application.py)：页面 `/admin/warehouse`；接口 `/api/admin/warehouse`、`/api/admin/warehouse/batch`、`/api/admin/warehouse/sources`、`/api/admin/warehouse/(\\d+)`、`/api/admin/warehouse/(\\d+)/detail`、`/api/warehouse/items`、`/api/warehouse/deep/one`、`/api/warehouse/deep/batch`。
- **数据库与菜单种子**（[`db.py`](../app/models/db.py) `init_db()`）
  - 新建 `warehouse_data` 表（`collect_item_id UNIQUE` 按原数据去重，content_md/content_text/word_count/ai_summary/ai_keywords/images/engine/llm_used/error/status/username 等，`status` 0 未深采/成功区分），`CREATE IF NOT EXISTS` 可重执，附 `idx_warehouse_data_source` 索引。
  - `_seed_warehouse_menu` 幂等补种「数据采集 / 数据仓库」菜单（url `/admin/warehouse`，图标 `fas fa-warehouse`）；`_backfill_menu_descriptions` 同步补简介。
- **测试**：新增 [`tests/smoke_warehouse.py`](../tests/smoke_warehouse.py)——正文提取/AI JSON 解析/回退规则分析纯函数用例 + 真实 HTTP 冒烟（数仓 CRUD/分页过滤/批量删除/菜单鉴权/深采 SSE），共 49 项断言。

### 变更

- `ADMIN_ROADMAP` 增加「任务7 · 数据仓库」已完成条目。
- 版本号升至 v0.6.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

---

## [v0.5.0] - 2026-11-06

> 任务6：采集管理模块——独立采集主页 `/collect`（不使用 layui，科技感风格）。
> 自上而下三区：关键词输入区 | 信源采集选择区（含可视化参数配置） | 采集数据橱窗列表区（1 行 3 列，12 条/页，封面+标题+时间）。
> 采集链路：信源 URL 占位符替换 → 按 Request Headers 抓取 → 大模型+智能体解析（失败自动回退规则解析）→ 按信源去重落库。
> 冒烟测试 35/35 通过，任务5 回归 31/31、任务4 回归 24/24 通过，真实浏览器全流程验证通过。

### 新增

- **采集管理模块（/collect 独立主页）**
  - 模型层 [`collect.py`](../app/models/collect.py)：`CollectRepository`（`save_items` 批量入库按 `UNIQUE(source_id, title)` 去重、`paginate` 橱窗分页 12/页支持标题/关键词搜索与信源过滤、`count_all`）。
  - 服务层 [`collect_service.py`](../app/services/collect_service.py)：`parse_placeholders` 识别 URL 规格占位符（含「关键字」→ 自动填充、含「分页」→ 步长 10 自动填充、其余 → 可视化配置参数）；`build_url` 关键词/参数 URL 编码替换、缺参抛 `CollectError`；`fetch_html` 按信源 Headers 抓取并纠正中文编码；**双引擎解析**——`extract_items_llm`（Agentica 专用「采集解析智能体」，页面 markdown 化后输出严格 JSON，60s 超时）失败自动回退 `extract_items_heuristic`（BeautifulSoup 新闻结果块 标题/链接/时间/封面 提取）；`collect` 单信源编排（参数替换→抓取→解析→去重落库），全部同步阻塞函数由控制层线程池调度。
  - 控制层 [`collect.py`](../app/controllers/collect.py)：`CollectPageHandler` 独立页面壳；`CollectSourcesApiHandler`（GET 启用信源+占位符元数据，不回传敏感 headers）、`CollectRunApiHandler`（POST 批量采集 ≤10 源，`run_in_executor` 线程池隔离阻塞调用，单源失败不中断）、`CollectItemsApiHandler`（GET 橱窗分页）；沿用 `backend_required` + `require_menu('/collect')` 菜单鉴权。
  - 表现层：[`collect.html`](../app/templates/collect.html) 独立全屏模板（不继承 base.html、零 layui）；[`collect.css`](../app/static/css/collect.css) 深空底色 + 霓虹青/紫渐变 + 网格光晕背景 + 玻璃拟态面板 + 扫描光线动画，橱窗 3 列响应式（≤1100px 2 列、≤720px 1 列）；[`collect.js`](../app/static/js/collect.js) 信源卡片多选、选中含自定义参数的信源展开参数配置面板、AI 解析开关、采集进度遮罩、封面加载失败降级占位封面、自定义分页/搜索过滤/轻提示（均非 layui 组件）。
  - 路由 [`application.py`](../app/application.py)：页面 `/collect`；接口 `/api/collect/sources`、`/api/collect/run`、`/api/collect/items`。
- **数据库与菜单种子**（[`db.py`](../app/models/db.py) `init_db()`）
  - 新建 `collect_items` 表（source_id、source_name、keyword、title、url、cover、summary、published_at、username、collected_at，`UNIQUE(source_id, title)` 按信源去重），`CREATE IF NOT EXISTS` 可重执，附 `idx_collect_items_source` 索引；为后续「数据仓库」模块提供原始数据底座。
  - `_seed_collect_menu` 幂等补种「数据采集 / 采集管理」菜单（url `/collect`，FA5 图标 `fas fa-satellite-dish`），后台侧边导航可直接跳转独立主页；`_backfill_menu_descriptions` 同步补简介。
- **测试**：新增 [`tests/smoke_collect.py`](../tests/smoke_collect.py)——占位符/URL 构建/LLM JSON 提取纯函数用例 + 启发式解析用例 + 本地夹具信源服务器真实 HTTP 冒烟（采集入库/去重/12 条分页/过滤/缺参拦截/LLM 失败回退/菜单鉴权 403 与授权放行/未登录 302），共 35 项断言；新增 [`tests/preview_collect.py`](../tests/preview_collect.py) 浏览器 UI 验证预览环境（临时库+夹具信源，`python tests/preview_collect.py` 启动后访问 10087 端口）。

### 变更

- `ADMIN_ROADMAP` 增加「任务6 · 采集管理」已完成条目。
- 版本号升至 v0.5.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

---

## [v0.4.0] - 2026-11-06

> 任务5：信源管理模块（URL 规格 + Request Headers 规则管理，不含采集任务，为后续「采集管理」预留采集源）。
> 界面风格对齐角色管理，分页 20/页；冒烟测试 31/31 通过，任务4 回归 24/24 通过，真实浏览器全流程验证通过。

### 新增

- **信源管理模块（/admin/sources）**
  - 模型层 [`source.py`](../app/models/source.py)：`SourceRepository`（`paginate` 名称/URL/简介模糊搜索分页、`get_all` 供后续采集管理选源、`create/update/delete`，name 唯一冲突拦截）；`parse_raw_headers` 支持两种 RAW 粘贴格式：DevTools「名称行/值行交替」与标准「Name: Value」，自动跳过请求行/状态行，同名后者覆盖。
  - 控制层 [`admin.py`](../app/controllers/admin.py)：`AdminSourcesHandler` 页面壳；`AdminSourcesApiHandler`（GET 列表分页 / POST 新增）、`AdminSourceItemHandler`（POST 编辑，`headers_raw` 传空串清空 / DELETE 删除）；校验：名称非空≤64、URL 须 http(s) 开头、非空 RAW 解析失败拒收；沿用 `backend_required` + `require_menu(URL_SOURCES)` 按菜单鉴权。
  - 表现层：[`sources.html`](../app/templates/admin/sources.html)「功能区 | 列表区 | 分页区」框架壳（静态表头）；[`admin.js`](../app/static/js/admin.js) 新增 `SourceModule`（列表/搜索/laypage 分页/新增编辑弹层/请求头查看弹层/删除确认），编辑时 headers JSON 还原为 RAW 回填；`openForm` 支持可选宽度（信源表单 640px）。
  - 路由 [`application.py`](../app/application.py)：页面 `/admin/sources`；接口 `/api/admin/sources`、`/api/admin/sources/(\\d+)`。
- **数据库与菜单种子**（[`db.py`](../app/models/db.py) `init_db()`）
  - 新建 `sources` 表（id、name UNIQUE、url、headers JSON 文本、description、enabled、created_at），`CREATE IF NOT EXISTS` 可重执。
  - `_seed_source_menu` 幂等补种「数据采集 / 信源管理」菜单（存量库 menus 已有数据不触发全量种子，按 url 存在性单独补种；分组为后续采集管理/数据仓库预留），图标均为 FA5 有效类名（`fas fa-database` / `fas fa-rss`）；`_backfill_menu_descriptions` 同步补简介。
- **测试**：新增 [`tests/smoke_sources.py`](../tests/smoke_sources.py)——RAW 解析纯函数用例（含任务5百度样例逐项比对）+ 真实 HTTP 冒烟（CRUD/重名与 URL 校验/25条跨页分页/搜索/菜单鉴权 403 与授权放行），共 31 项断言。

### 变更

- `ADMIN_ROADMAP` 增加「任务5 · 信源管理」已完成条目；`admin.js` 头部注释与 `currentModule()` 路径分发纳入 `/admin/sources`。
- [`admin.css`](../app/static/css/admin.css) 新增信源样式：URL 两行截断（title 悬停看全文）、请求头查看弹层等宽可滚动、RAW 输入框等宽字体。
- 版本号升至 v0.4.0（[`VERSION`](VERSION)）；git 提交与 tag 由人类决策后执行。

---

## [v0.3.0] - 2026-11-05

> 对应提交 `e1ff415`（`feat(qiuyanxi): v0.3.0 后台管理模块与AI对话链路完整版`），git tag `v0.3.0`。
> 本版本覆盖任务 1～4：登录/注册链路打通 → AI 对话页前端升级 → 工程资料同步 → 后台管理三模块。

### 新增

- **前台工作台管理员返回后台入口（2026-11-06 增量）**：[`index.html`](../app/templates/index.html) 侧栏底部在 `role == 'admin'` 时渲染"后台"按钮（`chat-admin-btn`，`fas fa-cog`，链接 `/admin`），普通用户不可见；[`base.css`](../app/static/css/base.css) 新增 `.chat-side-actions` / `.chat-admin-btn` 样式。已用真实浏览器验证 admin 可见可跳转、普通用户无此按钮。

- **后台管理模块（用户 / 角色 / 菜单）**
  - 控制层 [`admin.py`](../app/controllers/admin.py)：`AdminGuard` 统一承载权限（`role_code` / `allowed_ids` / `require_menu(url)` / `deny(status,msg)`），页面 Handler 叠加 `@authenticated` + `backend_required`；`AdminBaseHandler`（及 `AdminDashboardHandler / AdminUsersHandler / AdminRolesHandler / AdminMenusHandler`）渲染页面壳，侧边导航由 `build_nav(active_path, allowed_ids)` 注入；`AdminApiHandler` 及其子类承载 JSON CRUD，`ok()/fail()` 统一输出 `{ok:true}` / `{ok:false,error:...}`。
  - 模型层 [`role.py`](../app/models/role.py)、[`menu.py`](../app/models/menu.py)：`RoleRepository`（`code` 唯一、`home` 首页、内置 `admin` 角色与已被用户占用角色不可删、`set_menus`/`menu_ids_by_code` 维护角色授权、`is_backend_role`）、`MenuRepository`（两级树 `get_tree_all`、后台分页 `paginate_tree`、有子菜单不可删、`save_sort` 排序）。
  - **角色-菜单授权**：侧边导航按当前角色被授权的菜单渲染（`MenuRepository.get_nav_tree()` + `build_nav`），接口层以 `get_by_url(url)` 反查菜单做访问校验。
  - [`user.py`](../app/models/user.py) 扩展 `paginate / update_user / delete_users / get_user_by_id`，支持列表分页（每页 20）、用户名搜索与批量删除。
  - 表现层：`templates/admin/`（`base/index/users/roles/menus` 五个模板，静态表头 + JS 填充 `tbody`）、[`admin.css`](../app/static/css/admin.css)、[`admin.js`](../app/static/js/admin.js)（layui `laypage` 分页 + `layer` 弹层表单 + 批量删除，请求统一携带 `X-Xsrftoken`）。
  - 路由 [`application.py`](../app/application.py)：页面 `/admin`、`/admin/users|roles|menus`；接口 `/api/admin/{users,roles,menus}`、`/api/admin/{users,roles,menus}/(\\d+)`、`users/batch`、`roles/(\\d+)/menus`（授权）、`menus/sort`（排序）。
- **数据库结构与幂等迁移**（[`db.py`](../app/models/db.py) `init_db()`）
  - 新建 `roles`、`menus`、`role_menus` 三表，并幂等种子 `admin/user` 角色与导航菜单。
  - 新增 `_add_column_if_missing`（存量库补列）、`_seed_roles` / `_seed_menus`、`_fix_invalid_menu_icons`、`_backfill_menu_descriptions` 等迁移与回填函数，全部使用 `IF NOT EXISTS` / 存在性判断，可重复执行。
- **注册链路与角色分流**：`RegisterHandler` 落地（校验用户名 3-32、密码 ≥6、两次一致、重名拦截，`create_user` 只能建 `user` 角色）；`users` 表新增 `role` 列，登录后 `admin` 跳 `/admin`、普通用户跳 `/`。
- **AI 对话页前端**：[`chat.js`](../app/static/js/chat.js) 自写轻量 Markdown 渲染（标题/加粗/斜体/有序无序列表/围栏代码/行内码/链接/`---` 分隔线），SSE 事件消费按 `delta`（打字机）/ `tool` + `reasoning`（可折叠"执行过程"时间线）/ `error`（追加于正文下方）/ `done` 分类；支持 Enter 发送、快捷提问、清屏。
- **第三方静态资源入库**：`static/vendor/` 纳入 layui 与 fontawesome（本地 vendor，避免外网 CDN 依赖）。
- **测试**：新增 [`tests/smoke_admin.py`](../tests/smoke_admin.py)——后台线程起服务 + `requests.Session` 走真实 HTTP，覆盖登录态、三模块 CRUD、403 拦截、删除保护等 20 余项断言（脚本自打印"通过 n / m"汇总）。
- **工程资料**：入库 [`requirements.md`](requirements.md)、[`codingPrompt.md`](codingPrompt.md)（两者当前为 0 字节空文件，待人类补充）、[`agent_roles.md`](agent_roles.md)（协作与版本号规则）；重写 [`framework.md`](framework.md)（转为 UTF-8，消除原 GBK 乱码）。本版本又补充了 [`CHANGELOG.md`](CHANGELOG.md) 与 [`VERSION`](VERSION)。

### 变更

- 侧边导航由静态常量硬编码改为数据库 + 角色授权驱动（`MenuRepository.get_nav_tree()` + `build_nav`）；`templates/admin/base.html` 顶部注释仍写 `ADMIN_NAV`，属残留描述待清理。
- [`base.css`](../app/static/css/base.css) 扩充对话页全屏布局与后台样式；模板统一为 `base.html` 的 `content` / `scripts` 块结构。
- 用户/角色/菜单页面形态由"模板直出列表"改为"页面壳 + JSON 接口异步渲染"。

### 修复

- **登录 500**：`UserRepository.get_user_by_username` / `verify_user` 曾定义在模块层导致 `AttributeError`，已收拢进类并统一 `@staticmethod`。
- **对话落库致命约束**：存量库 `messages.username` 被误建为 `UNIQUE`，同一用户第二条消息即 500；`init_db()` 增加 `_repair_messages_unique_username` 幂等重建去 `UNIQUE`。
- **弹层保存全失效**：layui `layer` 回调中的 `layero` 是 jQuery 对象，直接调用 `querySelector` 抛错，改为 `layero.find(...)` / `[0]`。
- **图标空白**：本地 vendor 为 FontAwesome 5，误用 FA6 的类名会渲染为空白且无报错，已校正类名。
- **窄屏后台不可用**：侧栏在窄屏被 `display:none` 且汉堡按钮无效，改为 layui 抽屉，并同步 CSS/JS 断点。
- **第三方样式覆盖**：layui 抹掉列表标记，需在 `li` 层级恢复 `disc` / `decimal` 与 `::marker`。
- 模板 `extends` 路径、`index.html` 块名 `body` → `content`、非法表单嵌套等渲染层问题。

### 清理

- `.gitignore` 增补 `__pycache__/`、`*.pyc`、`workspace/`、`dist/`，并将 3 个已跟踪的 `.pyc` 移出版本库（`git rm --cached`）；`workspace/`（智能体运行产物）与 `dist/` 从此不再入库。
- 误建的占位文件 `app/static/js/新建 文本文档.txt` 由 `base.js` 取代（git 识别为重命名）。

---

## 基线（未编号，v0.x.0 之前）

| 提交 | 说明 |
| --- | --- |
| `a75ed27` | 分层框架（表现/控制/服务/模型四层）与 agentica 智能体接入 |
| `c234754` | 项目初始化：Tornado 脚手架、SQLite 建表、登录页与对话主链路雏形 |

> 说明：这两个提交早于版本号规则落地，未打 tag，作为 v0.3.0 的架构基线记录，不追溯编号。

---

## 当前待完善（下一版本候选项）

- `agent.run_stream` 阻塞时占用 Tornado 单线程 IOLoop，本地模型后端（`127.0.0.1:11435`）无响应会挂起整站；需将阻塞调用移出事件循环（如 `run_in_executor`）。详见 [`architecture.md`](architecture.md) 第六节。
- 历史对话上下文尚未接入智能体推理：`ChatHandler` 仅传本轮 `message`，`MessageRepository.list_recent` 组装上下文未实现。
- [`framework.md`](framework.md) 已同步到 v0.3.0 实际结构；[`architecture.md`](architecture.md) 第一节路由表与第三/六节仍未纳入后台管理模块（`roles/menus/role_menus` 表、角色授权与 admin API），其中"注册链路空缺"等描述已明显过时，需在下个任务节点对齐。
- 敏感信息：根目录 `.env` 已被 git 跟踪且含 `API_KEY`，建议移出版本库并轮换密钥（见 `agent_roles.md` 1.3.4）。
