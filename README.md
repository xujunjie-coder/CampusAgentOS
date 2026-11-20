# GovCheckDataAgentOS（某省数据瞭望系统 · GovAgentOS）

面向政务数据采集与舆情研判的一体化 Agent 平台：后台做信源管理、智能体批量采集、数据仓库与知识仓库（RAG），
前台做 AI 对话、3D 数字人交互、智能问数，并把采集结果交给大模型做风险分级与异常预警。

技术框架：**Tornado（Web 层） + Agentica（智能体层） + SQLite/MySQL（持久层） + 原生 layui/ECharts 前端**。

- 运行入口：[`app.py`](app.py)
- 默认地址：`http://127.0.0.1:10086`（后台 `/admin`，健康检查 `/healthz`）
- 版本基线：[`docs/VERSION`](docs/VERSION)

---

## 一、技术栈对照

| 要求 | 落地位置 |
| --- | --- |
| python3 | `venv`（Python 3.11） |
| tornado | `app/application.py`、`app/controllers/` |
| agentica | `app/services/agent_service.py` |
| sqlite / mysql | `app/models/db.py`（一套 Repository 兼容双驱动） |
| AHLLMProxy | `.env` 的 `BASE_URL`（OpenAI 兼容代理，默认 `127.0.0.1:11435/v1`） |
| SSE | `app/controllers/sse.py`（对话、模型测试、深采、大屏实时推送） |
| MCP | `app/controllers/mcp.py`（本地 MCP Server `/mcp/news`）+ `app/services/mcp_service.py`（客户端） |
| WebSocket | `app/controllers/ws.py`（`/ws`、`/ws/notify`、`/ws/admin/sentiment`） |
| layui / FontAwesome / Bootstrap / ECharts | `app/static/vendor/`（全部本地化，无外网 CDN 依赖） |

---

## 二、目录结构

```
app.py                  启动入口（读 .env → make_app → listen）
app/
  application.py        路由表 / 模板与静态目录 / 安全配置 / init_db
  config.py             .env 唯一读取入口（strict 校验，缺密钥拒绝启动）
  controllers/          控制层：每个业务域一个模块
  services/             服务层：智能体、采集、舆情、定时任务、通知、PDF 等
  models/               模型层：Repository 模式，SQLite/MySQL 双库
  templates/            Tornado 模板（admin/ 为后台壳，其余为前台页）
  static/               css / js / vendor / music / uploads
database/               SQLite 数据库（models/ 下为不入库的 ONNX 模型）
docs/                   架构、接口、框架、验收、部署、缺陷记录
tools/                  运维脚本（如 download_face_model.py 下载人脸模型）
tests/                  pytest 套件（tests/pytest）与冒烟脚本（截图落 tests/artifacts）
workspace/              数字员工运行时工作空间（按用户隔离）
venv/                   虚拟环境（不入库）
```

---

## 三、快速开始

```powershell
# 1) 创建/激活虚拟环境
python -m venv venv
.\venv\Scripts\Activate.ps1

# 2) 安装运行依赖（requirements.txt 为 UTF-8 BOM，Windows 下可直接解析）
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 3) 安装深度采集所需的浏览器内核（Crawl4AI 主引擎，约 150MB）
.\venv\Scripts\python.exe -m playwright install chromium

# 4) 准备配置：复制样例并至少填 COOKIE_SECRET
Copy-Item .env.example .env
python -c "import secrets;print(secrets.token_urlsafe(48))"

# 5) 启动
.\venv\Scripts\python.exe app.py
```

> 可选：要用人脸真实精度（而非 fallback）时，额外执行 `pip install onnxruntime` 后运行
> `.\venv\Scripts\python.exe tools\download_face_model.py` 下载模型（≈174MB；默认先走 hf-mirror 镜像，
> 失败自动切 HuggingFace 官方与 GitHub Release，每个源 30s 超时不会卡死）。

首次启动会自动建表（`init_db()` 幂等）。访问 `http://127.0.0.1:10086/auth/register` 注册第一个账号，
再把该账号的角色改为 `admin`（用户管理或直接改库 `users.role`），即可进入 `/admin`。

> 登录页路径是 `/auth/login`（`login_url` 同此），`/login` 不提供别名。

### 必需配置（`.env`）

在线音乐：在 `.env` 填写 `JAMENDO_CLIENT_ID=你的应用client_id` 并重启后端，`@音乐` 将优先搜索 Jamendo；未配置或上游故障时提示并回退本地示例。注册及使用说明见 [Jamendo 在线音乐配置](docs/jamendo-setup.md)。

| 键 | 说明 |
| --- | --- |
| `COOKIE_SECRET` | 必填，≥32 位随机串；缺省或示例值会拒绝启动 |
| `BASE_URL` / `API_KEY` / `MODEL_ID` | 大模型兜底配置（正式接入请在「模型引擎」后台维护） |
| `DB_DRIVER` | `sqlite`（默认）或 `mysql`；MySQL 需已装 `PyMySQL` 并可连通 |
| `FACE_ENGINE` | `auto`（默认）/ `onnx` / `fallback`，详见下文 |

其余键（会话有效期、登录锁定、SSE/WS 心跳、CORS、SMTP、QQ 通知）见 [`.env.example`](.env.example) 注释，
也可在后台「系统设置 / 通知配置」在线维护（DB 优先，`.env` 兜底）。

---

## 四、页面导航

**前台（普通用户）**

| 路径 | 功能 |
| --- | --- |
| `/` | AI 对话（SSE 流式、多轮、会话切换、@音乐、导出 PDF） |
| `/user` | 用户中心（资料、改密、本人会话、人脸录入/启停） |
| `/qa` | 智能问数（选数字员工 → 统计快照 → 模型报告） |
| `/avatar` | 3D 数字人（VRM 模型 + 口型 + 语音朗读） |

**后台（`/admin`）**

| 分组 | 页面 |
| --- | --- |
| 工作台 | `/admin` |
| 系统管理 | `/admin/users`、`/admin/roles`、`/admin/menus`、`/admin/sessions`、`/admin/messages`、`/admin/archives` |
| 数据采集 | `/admin/sources`、`/collect`、`/admin/warehouse`、`/admin/knowledge` |
| 智能体服务 | `/admin/employees`、`/admin/tools`、`/admin/sentiment` |
| 模型服务 | `/admin/models` |
| 运维与决策 | `/admin/tasks`、`/admin/notify`、`/admin/settings`、`/admin/dashboard`（全屏大屏）、`/admin/reports` |

接口清单见 [`docs/api.md`](docs/api.md)。

---

## 五、测试

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-test.txt
.\venv\Scripts\python.exe -m pytest -q        # pytest.ini 限定 testpaths=tests/pytest
# 需要交付 HTML 报告时（pytest-html）：
# .\venv\Scripts\python.exe -m pytest --html=logs/pytest-report.html --self-contained-html
```

- 用例全部跑在临时 SQLite 上，不触碰 `database/govagentos.db`；
- 不依赖外网与大模型：只验证参数校验、鉴权、分页、CRUD、页面渲染等本地可判定行为；
- `tests/` 仅保留 pytest 套件（`tests/pytest/`，160 项）；开发期手工冒烟/UI 复验脚本（`smoke_*.py` / `verify_*.py` 等）与验证截图属过程产物，已在交付前移除。

---

## 六、已知降级与依赖

| 能力 | 缺失时的行为 | 补齐方式 |
| --- | --- | --- |
| 定时任务 cron | 未装 `apscheduler` 时降级 tornado，只有间隔任务能自动排程 | 已在 `requirements.txt` 钉住 |
| 深度采集主引擎 | 缺浏览器内核时 Crawl4AI 不可用，回退 requests 抓取并在面板显式提示 | `python -m playwright install chromium` |
| 人脸真实精度 | 缺 `onnxruntime` 或模型文件时按 `FACE_ENGINE=auto` 降级 fallback（精度受限，会提示）。本机已就位：`engine=onnx, degraded=false` | `pip install onnxruntime`（代码不用 cv2），再执行 `python tools/download_face_model.py`（支持 `--proxy`）自动下载 `w600k_r50.onnx` |
| 大模型 | 模型服务不可用时对话报错、舆情分析保留待重试、问数走启发式兜底 | 启动 AHLLMProxy，或在「模型引擎」换可用模型 |

---

## 七、文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 分层架构、模块职责、数据流 |
| [`docs/framework.md`](docs/framework.md) | 框架与选型说明 |
| [`docs/api.md`](docs/api.md) | 全量接口清单与参数 |
| [`docs/deploy.md`](docs/deploy.md) | 部署、配置、MySQL 切换、排障 |
| [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md) | 任务一/二/三逐项验收证据 |
| [`docs/bug-log.md`](docs/bug-log.md) | 缺陷与修复记录 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 版本变更历史 |
| [`docs/codingPrompt.md`](docs/codingPrompt.md) | 编码约定与协作规范 |
