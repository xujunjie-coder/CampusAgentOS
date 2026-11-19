# 成员 C 工作分析（后台管理端 /admin 前端 + ECharts 大屏与报表）

> 基线：`docs/VERSION` = v0.11.1 ｜ 核对日期：2026-11-11 ｜ 核对方式：逐文件读代码 + 查 `database/govagentos.db` 实际数据，只认代码里跑得起来的东西。
> 本文只做分析，不含实现；实现阶段的进度由本文的「批次」小节持续维护。

## 0 一句话结论

后台 15 个页面里 **11 个已由 A/B/D/E 交付**（用户、角色、菜单、信源、采集、数仓、知识仓库、模型引擎、数字员工、会话、对话、定时任务、通知配置），真正压在成员 C 身上的只有四块：
**① 数智大屏（地图 + 语音）② 统计报表（含自选图例 + 实时推送）③ 舆情预警页面从"裸表格"升级为预警台 ④ 系统管理配置页（任务三）**，
外加两项**直接决定扣分**的公共基建：**本地化 bootstrap + echarts（各缺一项 -10%，现共 -20%）**，以及后台整体视觉/交互的"去 AI 化"统一。

## 1 仓库现状盘点（有证据的结论）

### 1.1 技术栈 12 项

| 项 | 状态 | 证据 |
| --- | --- | --- |
| python3 / tornado / sqlite | ✅ | `app.py`、`app/application.py`、`database/govagentos.db` |
| agentica | ✅ | `app/services/agent_service.py`（`TOOL_REGISTRY` 在 61 行） |
| AHLLMProxy | ⚠️ 待口径 | `.env` `BASE_URL=http://127.0.0.1:11435/v1`，仓内无 "AHLLMProxy" 字样，答辩需出示代理截图 |
| SSE | ✅ | `app/controllers/sse.py`（`SSEMixin` / `SSEBridge` / `Heartbeat`），`/api/chat`、深采两端点在用 |
| MCP | ✅（成员 B 已接） | 内置 `/mcp/news`（`app/controllers/mcp.py`），`agent_service` 内 `mcp` 工具 |
| WebSocket | ✅ | `/ws`、`/ws/notify`、`/ws/admin/sentiment`（`app/controllers/ws.py`） |
| layui | ✅ | `app/static/vendor/layui/`（页脚标注 v2.13.9） |
| fontawesome | ✅ | `app/static/vendor/fontawesome/`（FA5） |
| **bootstrap** | ❌ **缺** | `vendor/` 下只有 fontawesome / layui / three；`base.html` 未引 bootstrap |
| **echarts** | ❌ **缺** | `vendor/` 无 echarts；`models.js` 的 token 统计是手绘 canvas |

> 结论：**bootstrap / echarts 是当前最便宜的 -20%**，且都在前端，天然落在成员 C。

### 1.2 后台页面现状（`app/templates/admin/`）

| 页面 | 路由 | 现状 | 归属 |
| --- | --- | --- | --- |
| 工作台 | `/admin` | 4 指标卡 + 最近注册 + 建设进度 | 成员 A |
| 用户管理 | `/admin/users` | CRUD/批量/强制下线，**含"人脸"列 + 人脸弹层（录入/启停/删除）** | A + 成员 B（人脸接口） |
| 角色 / 菜单 | `/admin/roles`、`/admin/menus` | CRUD + 菜单分配 + 拖拽排序 | A |
| 信源管理 | `/admin/sources` | CRUD，DB 已种 3 个源：百度新闻 / 中新网 RSS / Google 新闻 RSS（`models/db.py:879-881`） | A |
| 采集管理 | `/collect` | **独立全屏页，明确"不使用 layui"**（`templates/collect.html` 头注释），后台菜单直接跳出去 | A |
| 数据仓库 | `/admin/warehouse` | 列表 + 深采 SSE 进度 | A |
| 模型引擎 | `/admin/models` | CRUD + 设默认 + SSE 测试 + token 统计（**手绘图表，未用 echarts**） | A |
| 数字员工 | `/admin/employees` | 橱窗 + 提示词 + md 关联 + 工具勾选 | A/B |
| 知识仓库 | `/admin/knowledge` | 服务端表单式入库/删除，**`knowledge_documents` 当前 0 条** | 成员 B |
| 智能舆情 | `/admin/sentiment` | **1.4KB 裸表格** + 1.6KB WS 追加，无预警台、无图表 | 成员 B（后端）/ **UI 待 C 升级** |
| 定时任务 | `/admin/tasks` | 4.9KB 模板 + 27KB JS，CRUD/启停/手动跑/日志 | 成员 E ✅ |
| 通知配置 | `/admin/notify` | 邮件 SMTP / QQ 机器人，凭据脱敏 | 成员 E ✅ |
| 会话归档 / 对话记录 / 临时会话 | `/admin/archives`、`/admin/messages`、`/admin/sessions` | 三页齐备 | 成员 E ✅ |
| **数智大屏** | — | **不存在**（无路由、无模板、无地图数据、无语音） | **C** |
| **统计报表** | — | **不存在**（后端 `/api/stats/*` 已备，前端零实现） | **C** |
| **工具链路** | — | **不存在**（`agent_service.TOOL_REGISTRY` 有 weather/todo/task/memory + warehouse + mcp，无管理页） | **C（需后端接口）** |
| **系统管理配置** | — | **不存在**（`system_settings` 表已在，配置项仍散在 `.env`） | **C（需后端接口）** |

### 1.3 已备好的后端能力（我可以直接消费，不必重造）

- **统计数据**：`/api/stats/overview|trend|by-source|by-risk|keywords|report`（`app/controllers/stats.py` + `app/models/stats.py`），只读、仅需后台身份、不绑菜单。`report` 一次返回 `overview + trend + by_source + by_risk + keywords`，就是给大屏用的。
- **实时通道**：`/ws/admin/sentiment` 推 `{reviews:[...]}`；`sse.py` 提供 `SSEMixin`，任意 Handler 可直接吐 SSE。
- **系统设置**：`SystemSettingsRepository`（`app/models/settings.py`，key-value + `INSERT OR REPLACE`），`config.reload()` / `db.reload_settings()` 已在，`DB_DRIVER` 支持 `sqlite|mysql`。
- **库内真实数据量**（`database/govagentos.db`）：`collect_items` 75、`warehouse_data` 75、`risk_reviews` 75、`messages` 63、`users` 7、`sources` 3、`menus` 21、`scheduled_tasks` 2、`qa_reports` 1、**`knowledge_documents` 0**。

### 1.4 现有前端约定（我必须沿用，不能自创一套）

1. 模板：Tornado 语法（`{{ }}` / `{% %}`），后台子页 `{% extends "base.html" %}` + `{% block admin_content %}`，公共 JS 走 `{% block admin_scripts %}`。
2. 页面基类：`AdminBaseHandler` 三属性 `template_name / page_name / nav_url`，页面与接口都按菜单 url 鉴权（超管绕过）。
3. **导航是 DB 驱动**：`menus` 表 21 行，`MenuRepository.get_nav_tree()` 渲染；新增页面必须在 `models/db.py` 里加**幂等 seed**，否则菜单里看不到。
4. JS：IIFE + `esc()` 转义 + `api()`（自动带 `X-Xsrftoken`、401 跳登录）+ 失败统一 `{ok:false,error}` 弹 layer。
5. `admin.js` 是单体分模块文件（1174 行），末尾 `currentModule()` 按 `location.pathname` 分发（users/roles/menus/sources/warehouse）；深采 SSE 前端范式已在里面。

## 2 我不必再做的（避免重复劳动）

- 定时任务页、通知配置页（成员 E 已交付，含邮件/QQ 通知与执行日志）——我只做**视觉与交互一致性核对**，不改业务。
- 用户人脸数据管理/录入（用户管理弹层已实现）。
- 前台用户中心、3D 数字人、PDF 导出、@音乐（成员 D 已交付）。
- 会话管理/对话管理（成员 E 三页已交付）。
- 采集管理、数仓、模型引擎、数字员工、知识仓库的业务逻辑（A/B 已交付，我只补 UI 缺口）。

## 3 我真正要交付的（逐页任务卡）

### 3.1 数智大屏（任务二，权重最高）

- 路由：`/admin/dashboard`，`AdminBaseHandler` 子类，`nav_url="/admin/dashboard"`，**全屏模板**（不复用五段式后台壳，参照 `/collect` 的全屏范式，但配色回到政务深色，不用"光晕科技感"）。
- 布局：左（信源排行 + 热词云）｜中（中国地图 + 指标条）｜右（风险分布 + 最新预警流）｜底部（24 小时采集/消息/token 三线趋势）。
- 图表：全部 ECharts（`bar / line / pie / scatter / map / wordCloud`，wordCloud 用 scatter+label 或官方扩展，避免额外依赖）。
- 语音：拖音输入（`webkitSpeechRecognition`）+ 播报（复用 `avatar.js:358-400` 的 Web Speech 方案）+ 文本兜底输入框；播报文案由 `/api/stats/report` 模板化生成，避免依赖模型可用性。
- 实时：`EventSource` 订阅新增的 GET SSE 端点，增量刷新 KPI 与趋势，断线重连 + "最后更新时间"角标。

### 3.2 统计报表（任务二）

- 路由：`/admin/reports`。四个分区：总量指标 / 分类统计 / 趋势对比 / 明细排行。
- **自选图例**：每个卡片可切换图表类型（柱/折线/面积/饼/环），图例可点选隐藏，选择存 `localStorage` 记忆。
- 实时推送：SSE 增量（与 3.1 共用一条流，避免双连接）。
- 导出：ECharts `getDataURL` 导出 PNG，附口径说明（时间范围、数据源、生成时间）。

### 3.3 智能舆情 → 预警台（任务二）

- 保留成员 B 的 `/admin/sentiment` 后端（WS + `risk_reviews` + 复核表单），**重建前台 UI**：
  - 顶部四档风险计数卡（高/关注/常规/待重试，取 `/api/stats/by-risk`）；
  - 中部实时流（WS 已有），命中"问题/安全/隐患/事故/通报"等词的行**高亮 + 分级色条**；
  - 右侧 mini 趋势（近 7 天风险数）+ 最新高风险列表（点击看原文证据）；
  - 提醒：页面内 toast + 浏览器 `Notification`（首次需用户授权），可选提示音。
- 明确口径写进页面：模型输出为"风险线索"，未经人工复核不作为结论（沿用成员 B 的表述）。

### 3.4 系统管理配置页（任务三）

- 路由：`/admin/settings`，**仅超管**（`role_code == "admin"` 强校验，不能只靠菜单）。
- 四个分区：
  1. **系统标识**：系统名称 / 副标题 / Logo / favicon，落 `system_settings`（如 `sys_name`、`sys_logo`），模板与页面 `<title>` 动态读取（当前是硬编码）。
  2. **数据库**：显示当前驱动与连接状态；切换 SQLite↔MySQL、填连接参数、**"测试连接"按钮**；切换后提示需重建/迁移表并执行 `init_db()`。默认 SQLite。
  3. **语音 / 视觉模型**：TTS（音色、语速、是否自动播报）、ASR 开关、人脸引擎（`auto|onnx|fallback`）与阈值、模型目录；未配置时显式"降级"提示，不静默。
  4. **其他**：会话 TTL、登录失败锁定阈值、登录审计保留天数、页面水印开关、大屏刷新间隔。
- 凭据一律**脱敏回传**（沿用 `/admin/notify` 的做法），保存走 `set_many` 幂等写。

### 3.5 公共基建（决定扣分，优先级最高）

1. `app/static/vendor/echarts/echarts.min.js`（+ `china.json` 地图）+ `app/static/vendor/bootstrap/bootstrap.min.css`（建议自定义构建，只留栅格与 utilities，避免压掉 layui 组件样式）。
2. `base.html` 引入顺序：`layui.css` → `bootstrap.min.css` → `base.css` → 子页 `styles`；bootstrap **只给 admin 与大屏用**，前台不动。
3. 把 `models.js` 里手绘的 token 统计换成 ECharts（顺手给"任务一统计图表"一个真实数据落点）。
4. 导航分组重排：当前 `知识仓库`(id 25)、`智能舆情`(id 26) 是 `sort=0` 的顶级菜单，和"数据采集/模型服务/智能体服务/系统运维"四个分组并列，观感散。建议归位：
   - 数据看板：数智大屏 / 统计报表
   - 数据采集：信源 / 采集 / 数据仓库 / 知识仓库
   - 智能体：数字员工 / 工具链路 / 智能舆情
   - 系统运维：定时任务 / 通知配置 / 会话归档 / 对话记录 / 临时会话
   - 系统管理：用户 / 角色 / 菜单 / **系统设置**
5. 视觉"去 AI 化"统一：`admin.css` 收一套 design token（主色、圆角、阴影、字号阶），去掉"科技感光晕"；`/collect` 至少加"返回后台"入口并统一主色，最好纳入后台壳（需和成员 A 商量，动的是他的页面）。

## 4 需要别人补的后端契约（不等就动不了的地方）

| 需求 | 建议接口 | 谁 | 阻塞程度 |
| --- | --- | --- | --- |
| 大屏/报表实时推送 | `GET /api/stats/stream`（SSE，`event: snapshot`，周期推 `report` 摘要） | 成员 E（他已有 `SSEMixin` 与 stats 聚合） | **高**，否则只能轮询，直接丢"实时推送"得分点 |
| 大屏语音问答 | `POST /api/dashboard/ask`（入参 `question`，返回 `{answer, cards}`；内部用 `StatsRepository` 模板 + 可选模型润色） | 成员 E 或 A | 中，可先用纯模板话术撑住 |
| 地图地理维度 | `collect_items` / `warehouse_data` 增 `region`（省级归一），采集时由 LLM 抽取 | 成员 A/B（采集侧） | **高**，直接影响"地图大屏"是否成立 |
| 系统配置读写 | `GET/POST /api/admin/settings`（分组读写 + DB 连接测试 + 生效） | 成员 A/D | **高**，任务三全部功能都挂在它上面 |
| 工具链路 | `GET /api/admin/tools`（注册表 + 描述 + 绑定员工 + 启停/调用统计） | 成员 A | 中 |
| 系统名称/图标落地 | `<title>`、Logo 读 `system_settings`，不再硬编码 | 成员 A（模板层）或我改模板 + 他确认 | 中 |
| 知识仓库演示数据 | 导入 2–3 篇真实 md（当前 0 条，RAG 演示会空场） | 成员 B | 中，属演示风险不是功能缺失 |

> 约定做法：先把**接口契约写成一页纸**发给对应成员（字段名、HTTP 方法、返回信封 `{ok,data}`、鉴权口径），我按契约先上 Mock 数据把页面跑通，接口到位后只换数据层。
>
> **回填（2026-11-11）**：上表 7 项里，SSE、`/api/dashboard/ask`、`/api/admin/settings`、`/api/admin/tools`、系统名称/图标落地 5 项**已由我自行实现**（后端不再等 E/A/D）；仍依赖他人的只剩「地图 `region` 字段」（A/B 采集侧）与「知识仓库演示数据」（B），现状与替换方式见 §11。

## 5 关键方案决策（先定，免得返工）

1. **大屏与后台壳的关系**：大屏 `/admin/dashboard` 用全屏模板（脱离五段式），后台其余页留在壳内；大屏顶栏放"返回后台/全屏/刷新频率"三个控件。
2. **地图数据口径**：有 `region` 就按省级着色；没有就**不伪造地理分布**，改为"信源覆盖态势"（地图只作底图 + 信源点位散点），页面标注口径。前者优先级高于后者。
3. **实时通道只选一条**：报表与大屏共用一条 SSE；舆情继续用已有 WS（已有业务在跑，不迁移），避免双通道各自心跳、各自断线重连。
4. **bootstrap 与 layui 共存**：bootstrap 用自定义构建（只留 `grid` + `utilities` + `d-flex` 类），引入在 layui 之后、`base.css` 之前；按钮/表单/弹层一律用 layui，禁止混用两套组件。
5. **ECharts 统一封装**：新建 `app/static/js/chart-kit.js`（主题、`resize` 自适应、空数据占位、加载态、`dispose` 回收），所有图表走这一层，避免每个页面各写一遍 `setOption`。
6. **语音兜底链**：ASR 不可用（无麦克风/无网络/非 Chrome）→ 自动切文本输入；TTS 不可用 → 只出文字播报；页面显式显示"语音不可用"，不静默。
7. **菜单入库方式**：在 `models/db.py` 的 `init_db()` 里按 url 幂等插入（参照 `db.py:544` 的写法），**不手改 DB 文件**，保证别人拉代码即生效。
8. **权限**：所有新页面走 `nav_url` 菜单鉴权；`/admin/settings` 额外加超管强校验；新接口沿用 `AdminApiHandler` 的信封与 401/403 语义。

## 6 风险与扣分点（按严重度）

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| 1 | bootstrap / echarts 仍缺 | 技术栈 -20%，且"统计图表"无实现载体 | 第一批就补，先接一处真实数据（模型 token 趋势） |
| 2 | 地图无地理数据 | 大屏核心"地图 + 报表"站不住 | 推动采集侧加 `region`；同期做信源态势版，页面标口径 |
| 3 | 统计只有 GET 轮询 | "实时推送显示"判缺 | 推动 `/api/stats/stream`；无果则先实现前端 SSE 消费 + 后端最简推送 |
| 4 | 系统配置无后端接口 | 任务三（20 分）整体悬空 | 契约先行，前端可用 Mock 全量跑通，接口到位即联调 |
| 5 | `knowledge_documents` 0 条 | RAG 现场演示空场，观感扣分 | 让成员 B 导 2–3 篇真实文档；同时我的页面做空态引导（"去知识仓库导入"） |
| 6 | `/collect` 跳出后台壳、风格自成一派 | "系统风格"与"产品化成熟度"扣分 | 统一主色 + 加返回入口；条件允许纳入后台壳 |
| 7 | 无 `venv/`、`dist/`（.gitignore 忽略，本机不存在） | 工程架构偏差（>30% 等比扣分规则） | 本机 `python -m venv venv` 后按 `.env` 跑；`dist/` 放前端第三方或补一份说明（与 F 的架构偏差表对齐口径） |
| 8 | layui `table.render` 在本仓已有失败先例 | 页面白屏/无数据 | 沿用现有手写渲染范式，不引入 `table.render` 动态列；异常时降级原生渲染 |
| 9 | `.env` 含真实 API_KEY 已入库 | 安全评分风险 | 不新增任何密钥进代码/文档/日志；发现泄露路径报给 F 记录 |

## 7 执行顺序（四批，每批可独立验收）

**第一批 · 基建（消 -20%）**
- 落 `vendor/echarts` + `vendor/bootstrap`；`base.html` 引入顺序；`chart-kit.js` 封装；`models.js` token 统计换 ECharts。
- 验收：`Get-ChildItem app\static\vendor -Directory` 出现 `bootstrap`、`echarts`；模型引擎页图表渲染出真实 trend。

**第二批 · 统计报表**
- `/admin/reports` 页 + 菜单 seed + 四分区 + 自选图例 + PNG 导出；数据走 `/api/stats/report`。
- 验收：切 7/14/30 天，四类图切换、图例点选、刷新后选择保持。

**第三批 · 数智大屏**
- `/admin/dashboard` 全屏页 + `china.json` 注册地图 + 三线趋势 + 风险饼 + 热词 + 指标条 + 语音问答/播报 + SSE 增量。
- 验收：断网重连不崩、语音不可用有降级提示、地图口径标注清楚。

**第四批 · 舆情预警台 + 系统管理**
- `/admin/sentiment` UI 重建（复用 WS）；`/admin/settings` + 菜单 seed + 超管校验；导航分组重排 + 视觉统一。
- 验收：高风险条目 5 秒内进流并高亮；配置改动对前台生效（系统名称/图标可见）；非超管访问 403。

## 8 改动文件预估（供评审对照，最终以提交为准）

新增：
`app/templates/admin/dashboard.html`、`reports.html`、`settings.html`、`tools.html`
`app/static/js/chart-kit.js`、`dashboard.js`、`reports.js`、`settings.js`、`tools.js`、`sentiment.js`（重写）
`app/static/css/admin-console.css`（大屏/报表专用）、`app/static/vendor/echarts/*`、`app/static/vendor/bootstrap/*`、`app/static/vendor/echarts/china.json`
`app/controllers/dashboard.py`（页面 + SSE/问答，取决于成员 E 是否接手后端）

修改：
`app/application.py`（路由）、`app/models/db.py`（菜单幂等 seed）、`app/templates/base.html`（引入顺序）、`app/static/css/admin.css`（design token）、`app/templates/admin/sentiment.html`、`app/static/js/admin.js`（如需并入分模块）、`docs/framework.md`、`docs/acceptance-checklist.md`、`docs/CHANGELOG.md`、`docs/VERSION`
测试：`tests/pytest/test_14_dashboard_reports.py`、`test_15_settings.py`（沿用 `tests/pytest/conftest.py`）

## 9 本地运行现状（开工前须知）

- 本机 `F:\workspace\701-grp-53c6ce9c086f\src\小组仓库\GovCheckDataAgentOS` **没有 `venv/`、没有 `dist/`**（被 `.gitignore` 忽略）。启动前需 `python -m venv venv` 并装 `requirements.txt`，否则 `app.py` 起不来。
- `.env`：`APP_HOST=127.0.0.1`、`APP_PORT=10086`、`DB_DRIVER=sqlite`、`DEBUG=1`；模型走 `http://127.0.0.1:11435/v1`（AHLLMProxy 口径待答辩确认）。
- 当前 git 工作区有未提交改动：`database/govagentos.db`（M）、`server.err.log` / `server.out.log`（未跟踪）。开工前先确认这两项是否别人的在途工作，不要覆盖。

## 10 需要我确认的三个开放问题

1. 大屏的"语音问答"是纯模板话术（稳定、零依赖）还是接大模型润色（自然、但依赖 11435 代理可用）？
2. 系统管理里的"数据库切换"是否允许重启生效（安全）还是要求热切换（`reload_settings` + 连接测试，风险高）？
3. `/collect` 是否纳入后台五段式壳内（风格统一但动成员 A 的页面），还是保留独立页只做配色统一？

## 11 执行结果（2026-11-11，v0.12.0）

> 结论：§3 五项任务与 §7 四批全部落地，§4 七项依赖中 5 项转为自实现；§5 八条方案决策按原定口径实现，**无一条被推翻**。版本 `v0.12.0`，测试 **30 例全绿**（`test_14_dashboard_reports.py` 17 例 + `test_15_settings.py` 13 例），8 个 JS 文件 `node --check` 全部通过。

**真机冒烟（临时库副本 + 独立端口 10987，不碰 `database/govagentos.db`）**：登录 302 → `/admin`、`/admin/dashboard`、`/admin/reports`、`/admin/sentiment`、`/admin/tools`、`/admin/settings` **全部 200**；`/api/stats/snapshot`、`/api/admin/tools`、`/api/admin/settings` 均 200；问答返回「累计采集 75 条，今日新增 0 条，已入数仓正文 34 篇」；SSE 首帧 `event: bootstrap` 正常。过程中查出并修掉一个真实缺陷：舆情页模板 `{% set LEVEL_LABELS %}` 在块内取不到 → 整页 500，已改为块内条件输出并补三页首屏回归用例（测试由 27 → 30 例）。

| §7 批次 | 交付物 | 状态 | 验收证据 |
| --- | --- | --- | --- |
| 第一批 基建 | `vendor/echarts/echarts.min.js`（5.5.1，1030855 B）、`vendor/echarts/china.json`（61248 B）、`vendor/bootstrap/bootstrap.min.css`（232803 B）、`vendor/bootstrap/bootstrap-grid.min.css`（51795 B）、`js/chart-kit.js`、`js/console-common.js`、`css/console.css` | ✅ | 技术栈 12/12 项齐；`china.json` 34 个省级名与 `PROVINCES` 集合相等（单测断言）；`models.js` Token 统计已换 ECharts |
| 第二批 统计报表 | `/admin/reports` + `js/reports.js` + `GET /api/stats/snapshot` | ✅ | 7/14/30/90 日切换、6 KPI、双 Y 轴三系列自选图例、信源排行/占比切换、风险堆叠柱、热词、最新清单、分区 PNG 导出、SSE 开关 |
| 第三批 数智大屏 | `/admin/dashboard`（独立全屏模板）+ `js/dashboard.js` + `GET /api/stats/stream`（SSE）+ `POST /api/dashboard/ask` | ✅ | SSE 首帧 `bootstrap`、增量 `snapshot`、`heartbeat` 保活；9 类意图规则直答，实测「最新数据情况」返回采集 75 条 / 数仓正文 34 篇；TTS 播报、ASR 不可用显式提示；地图口径标注 |
| 第四批 舆情 + 系统管理 | `/admin/sentiment` 重建（WS 3 秒全量推送）+ `/admin/settings` + `/admin/tools` | ✅ | 高风险高亮/提示音/桌面通知/退避重连；设置四卡保存即时生效；非超管 403（单测覆盖）；菜单幂等种子入库 |

**与 §8 预估的偏差（评审可能问，先说明）**

| 预估 | 实际 | 原因 |
| --- | --- | --- |
| `app/controllers/dashboard.py` | `app/controllers/console.py`（9 个 Handler 合一） | 四页同属后台控制台、共享 `TOOL_META`/问答规则/快照逻辑，拆四文件会产生重复导入与循环依赖 |
| `app/static/css/admin-console.css` | `app/static/css/console.css` | 与大屏暗色 `.ckb-*` 同源，单文件更利于主题统一 |
| 数据走 `/api/stats/report` | 新增 `/api/stats/snapshot`（结构更全）；`/api/stats/report` 保留不动 | 大屏要 `by_region`/`risk_trend`/`latest_risks`，原 `report` 无这些键；不改造 E 的接口，避免影响既有调用方 |

**仍待他人/待决策（已写入 `acceptance-checklist.md` 与 `CHANGELOG.md`）**

1. `region` 字段：`collect_items`/`warehouse_data` 均无，地图按「标题/摘要文本提及省份」聚合，页面已标注口径；A/B 补字段后替换 `ConsoleStatsRepository.by_region()` 的取数 SQL，前端契约不变。
2. `knowledge_documents` = 0：RAG 演示空场，需 B 导 2–3 篇 md；不属于我的页面，但大屏/报表的「知识库」口径会受影响。
3. MCP / AHLLMProxy：技术栈仅剩这两项口径待确认（详见验收表第 5、7 行）。
4. 真机验证程度：已做 **HTTP 级冒烟**（上段，六页 200 / 三个接口 200 / SSE 首帧 / 问答真实数字）；**未做浏览器视觉与交互点击**——图表实际渲染效果、TTS 播报、麦克风授权、Logo 上传文件对话框、layui 表单在窄屏下的换行仍需人工过一遍。首次 `python app.py` 会触发 `init_db()` 把「数据看板 / 工具链路 / 系统设置」菜单种进真实库。
   全量 pytest 现状：**159 passed / 1 failed**，失败项为成员 F 的 `test_07_chat_assistant.py::test_chat_requires_message`（断言找英文 `message`，而接口现返回中文「请输入 1 至 8000 字的消息」），与成员 C 改动无关，未替他人改测试。
   本页图标上传用例已改为写临时目录（`settings_service.BRAND_DIR` 在 `setUp` 中重定向），不再把测试图片落进仓库 `app/static/uploads/brand/`。
5. `workspace/` 目录仍缺（成员 F 的整改建议 0），影响数字员工默认工作空间校验，非我职责但会连带工具链路页的演示。
