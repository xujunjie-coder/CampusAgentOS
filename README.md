# CampusAgentOS（西华师范大学智慧校园智能体平台）

面向**西华师范大学（CWNU）**打造的智慧校园一体化 Agent 平台：前台提供 AI 多轮对话、**3D 校宠「华小竹」数字辅导员**与智能问数工作台；后台整合校园与高校教育信源管理、智能体批量采集、数据仓库、知识仓库（RAG）、校园专属工具链、智能舆情风险预警与 **3D 地球 + 华凤/北湖双校区数智大屏**。

技术框架：**Tornado（Web / SSE / WebSocket） + Agentica（多智能体编排） + SQLite / MySQL（双驱动持久层） + Three.js r128 / ECharts 5 / Layui 本地全离线前端**。

- 运行入口：[`app.py`](app.py)
- 默认地址：`http://127.0.0.1:10086`（后台 `/admin`，大屏 `/admin/dashboard`，3D 华小竹 `/avatar`，健康检查 `/healthz`）
- 版本基线：[`docs/VERSION`](docs/VERSION)

---

## 一、核心亮点

1. **西华师大校园数字员工体系（3 位专属角色）**
   - **华师小助手**（默认）、**就业顾问**、**心理健康助手**（内置危机干预热线与安全红线），支持在 [`tools/seed_employees.py`](tools/seed_employees.py) 一键幂等预置，详见 [`docs/cwnu-employees.md`](docs/cwnu-employees.md)。
2. **校园专属工具链 + 可溯源混合 RAG**
   - [`app/services/campus_tools.py`](app/services/campus_tools.py)：全离线可用的 `campus_shuttle`（华凤/北湖两校区通勤校车）、`campus_calendar`（校历与考试周动态推算）、`campus_gpa`（4.0/5.0 制绩点测算与奖学金条件匹配）、`campus_directory`（校内办事黄页与心理热线）。
   - [`app/services/intelligence_service.py`](app/services/intelligence_service.py)：Markdown 标题/段落语义切片 + BM25 与向量混合检索，对话大厅（`/`）与数字人（`/avatar`）自动下发并渲染可折叠的**「参考来源」溯源卡片**。
   - [`app/services/mcp_service.py`](app/services/mcp_service.py)：`/mcp/news` MCP 新闻检索优先走国内直连可达的 Bing 中文新闻 RSS 源并兼容自定义 `MCP_RSS_URL`。
3. **3D 校宠「华小竹」交互舞台（`/avatar`）**
   - 基于本地 Three.js r128 程序化 PBR 建模的西华师大吉祥物 **「华小竹」**（学士帽、飘浮银杏叶流苏、校徽马甲、全息校园手册），可瞬时切换 VRM 虚拟主播。
   - 支持 **挥手 / 点头 / 托书 / 欢呼** 动作机、随选中数字员工自动切换光环氛围（综合/就业/心理）、Web Speech **语音提问麦克风 + 韵律口型**，以及桌面与移动端 `PointerEvent` 拖拽旋转视角。
4. **全屏指挥舱数智大屏（`/admin/dashboard`）**
   - 支持 **「3D 地球 / 2D 飞线 / 双校区」** 三态切换：Three.js 3D 地球配备全息后掠三角翼箭矢与彗星流光尾迹，点击省份/城市标签或三维信标可平滑聚焦并弹出**下钻详情抽屉**；「双校区」视图实时映射华凤校区与北湖校区 6 大业务专题态势。
   - 内置**语音/文字大屏智能问答**，支持通过自然语言直接驱动大屏（聚焦省份、切换双校区、高亮对应面板）。

---

## 二、技术栈对照

| 模块 | 落地位置 |
| --- | --- |
| Python Web 层（Tornado） | [`app/application.py`](app/application.py)、[`app/controllers/`](app/controllers/) |
| 智能体与校园工具链 | [`app/services/agent_service.py`](app/services/agent_service.py)、[`app/services/campus_tools.py`](app/services/campus_tools.py) |
| 混合检索与风险初筛 | [`app/services/intelligence_service.py`](app/services/intelligence_service.py) |
| 双驱动数据持久层（SQLite / MySQL） | [`app/models/db.py`](app/models/db.py)、[`app/models/`](app/models/) |
| 大模型接入代理（OpenAI 范式） | `.env` 的 `BASE_URL`（默认 `127.0.0.1:11435/v1`）与后台 `/admin/models` |
| SSE 实时推送 | [`app/controllers/sse.py`](app/controllers/sse.py)（对话、深采进度、大屏快照推送） |
| MCP Server / Client | [`app/controllers/mcp.py`](app/controllers/mcp.py)（`/mcp/news`） + [`app/services/mcp_service.py`](app/services/mcp_service.py) |
| WebSocket | [`app/controllers/ws.py`](app/controllers/ws.py)（`/ws`、`/ws/notify`、`/ws/admin/sentiment`） |
| 全离线前端框架与 3D 引擎 | [`app/static/vendor/`](app/static/vendor/)（Three.js r128、ECharts 5、Layui、Bootstrap Grid、FontAwesome） |

---

## 三、目录结构

```text
app.py                  启动入口（读 .env → make_app → listen）
app/
  application.py        路由表 / 模板与静态目录 / 安全配置 / init_db
  config.py             .env 唯一读取入口（strict 校验，缺密钥拒绝启动）
  controllers/          控制层：对话、大屏、MCP、数字员工、认证、后台管理
  services/             服务层：智能体、校园工具链、混合 RAG、深采、定时任务、通知、PDF
  models/               模型层：Repository 模式，SQLite / MySQL 双库
  templates/            Tornado 模板（admin/ 为后台与指挥大屏，其余为前台页）
  static/               css / js / vendor（全本地化）/ music / uploads
database/               SQLite 数据库（默认路径 database/govagentos.db，兼容存量库）
docs/                   校园数字员工手册、信源说明、知识库样例与架构/接口文档
tools/                  运维与初始化脚本（seed_employees.py、download_face_model.py 等）
tests/                  pytest 后端套件（tests/pytest/）与 Node 前端测试（tests/test_*.cjs）
workspace/              数字员工运行时工作空间（按用户隔离）
```

---

## 四、快速开始

```powershell
# 1) 创建/激活虚拟环境
python -m venv venv
.\venv\Scripts\Activate.ps1

# 2) 安装运行依赖（requirements.txt 为 UTF-8 BOM）
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 3) 安装深度采集所需的浏览器内核（Crawl4AI 主引擎，约 150MB）
.\venv\Scripts\python.exe -m playwright install chromium

# 4) 准备配置：复制样例并生成 COOKIE_SECRET
Copy-Item .env.example .env
python -c "import secrets;print(secrets.token_urlsafe(48))"

# 5) （可选）预置西华师大三位校园数字员工与默认配置
.\venv\Scripts\python.exe tools\seed_employees.py

# 6) 启动服务
.\venv\Scripts\python.exe app.py
```

> 首次启动会自动建表（`init_db()` 幂等，并预置默认「华师小助手」）。访问 `http://127.0.0.1:10086/auth/register` 注册第一个账号，将角色改为 `admin` 即可进入 `/admin` 与 `/admin/dashboard`。登录页路径为 `/auth/login`。

---

## 五、页面导航

**前台（师生用户）**

| 路径 | 功能 |
| --- | --- |
| `/` | AI 对话大厅（SSE 流式、参考来源折叠卡、多会话切换、`@音乐`、导出 PDF） |
| `/avatar` | 3D 校宠「华小竹」/ VRM 虚拟主播（语音提问与播报、动作互动、参考来源卡片） |
| `/qa` | 智能问数（选数字员工 → 真实统计快照 → 结构化报告与图表） |
| `/user` | 用户中心（个人资料、改密、登录会话、人脸录入/启停） |

**后台（`/admin`）**

| 分组 | 页面 |
| --- | --- |
| 指挥大屏 | `/admin/dashboard`（3D 地球 / 2D 飞线 / 华凤北湖双校区 + 下钻抽屉 + 问答联动） |
| 工作台与报表 | `/admin`、`/admin/reports`、`/admin/sentiment` |
| 数据与知识 | `/admin/sources`、`/collect`、`/admin/warehouse`、`/admin/knowledge` |
| 智能体服务 | `/admin/employees`、`/admin/tools`（含校园专属工具矩阵）、`/admin/models` |
| 系统与运维 | `/admin/users`、`/admin/roles`、`/admin/menus`、`/admin/tasks`、`/admin/notify`、`/admin/settings` |

完整接口清单见 [`docs/api.md`](docs/api.md)。

---

## 六、测试

### 后端 pytest 套件

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-test.txt
.\venv\Scripts\python.exe -m pytest -q
```

- 全部跑在临时 SQLite 上，不触碰 `database/govagentos.db`（存量库路径默认保留以向后兼容）；
- 不依赖外网与外部大模型，本地离线可完整校验参数、鉴权、CRUD、模板与统计口径。

### 前端离线 Node 回归测试

```powershell
node tests/test_panda_geometry.cjs
node tests/test_avatar_caption.cjs
node tests/test_avatar_playback.cjs
node tests/test_collect_cards.cjs
node tests/test_music_player.cjs
node tests/test_campus_interactions.cjs
```

---

## 七、已知降级与依赖

| 能力 | 缺失时的行为 | 补齐方式 |
| --- | --- | --- |
| 深度采集主引擎 | 缺浏览器内核时 Crawl4AI 自动回退 requests 抽取并显式提示 | `python -m playwright install chromium` |
| 人脸识别精度 | 缺 `onnxruntime` 或模型时按 `FACE_ENGINE=auto` 降级并提示 | `pip install onnxruntime` 后运行 `python tools/download_face_model.py` |
| 大模型与向量检索 | 无向量模型时 RAG 自动使用本地词法向量 + BM25 混合打分；无对话模型时问数走确定性快照兜底 | 在「模型引擎」后台配置可用模型 |
| 语音提问与播报 | 不支持 Web Speech 的浏览器明确提示转文字输入，不影响主链路 | 使用新版 Chrome / Edge |

---

## 八、文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/cwnu-employees.md`](docs/cwnu-employees.md) | 西华师范大学三大数字员工说明与知识库绑定指南 |
| [`docs/cwnu-sources.md`](docs/cwnu-sources.md) | 校园与教育政策信源配置参考 |
| [`docs/architecture.md`](docs/architecture.md) | 分层架构、模块职责与数据流 |
| [`docs/api.md`](docs/api.md) | 全量接口清单与参数 |
| [`docs/deploy.md`](docs/deploy.md) | 部署、配置、MySQL 切换与排障 |
| [`docs/bug-log.md`](docs/bug-log.md) | 缺陷与修复记录 |
