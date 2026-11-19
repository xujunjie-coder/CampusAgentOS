# 版本验收核对表（acceptance-checklist.md）

> 版本基线：`docs/VERSION` = **v0.12.0** ｜ 核对日期：2026-11-11（当日二次复核，含依赖巡检） ｜ 维护：成员 F
> 口径：只按**代码里能跑起来的东西**判定，不按任务书设想判定。判定为「已实现」需能给出路由/表/页面证据；「部分」= 有基础能力但缺任务书要求的关键点；「未实现」= 全仓无对应代码。
> 用途：答辩前逐项自查，也用于说明「技术栈缺项扣分」的具体落点。
> 本轮（2026-11-11 二次）：补齐 `apscheduler`/`pytest`/Chromium 内核，重跑 160 个 pytest 用例全绿；按代码证据重判 MCP、多轮对话、
> 会话分组、`workspace/`、`requirements.md` 与成员 F 交付物；AHLLMProxy 与版本 tag 仍待人类口径。

## 1 技术栈核对（任务一：缺一项扣 10%，扣完为止）

任务书要求 12 项：`python3`、`agentica`、`tornado`、`sqlite`、`AHLLMProxy`、`SSE`、`MCP`、`WebSocket`、`layui`、`fontawesome`、`bootstrap`、`echarts`。

| # | 技术栈 | 判定 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | python3 | ✅ 满足 | `venv` 为 Python 3.11.9；`requirements.txt` | — |
| 2 | agentica | ✅ 满足 | `app/services/agent_service.py`（`from agentica import ...`）；已装 agentica 1.5.1 | — |
| 3 | tornado | ✅ 满足 | `app/application.py`、`app.py`；tornado 6.6 | — |
| 4 | sqlite | ✅ 满足 | `database/govagentos.db`，`app/models/db.py` | 同时支持 mysql（任务三加分项） |
| 5 | AHLLMProxy | ⚠️ 待确认 | `.env` `BASE_URL=http://127.0.0.1:11435/v1` | 全仓**无 "AHLLMProxy" 字样**；若 11435 就是课程要求的 AHLLMProxy，需在答辩里明确说明并出示该代理运行截图，否则按缺项计 |
| 6 | SSE | ✅ 满足 | `app/controllers/sse.py` 的 `SSEMixin`/`SSEBridge`；`/api/chat`、`/api/admin/models/{id}/test`、深采两端点 | — |
| 7 | MCP | ✅ 满足 | `app/controllers/mcp.py` 的 `NewsMcpHandler`（`POST /mcp/news`，JSON-RPC 2.0，protocol 2025-11-25，Bearer 令牌 + 仅回环 + 禁 Origin）；`app/services/mcp_service.py` 客户端；`TOOL_REGISTRY["mcp_search"]` 已可选进数字员工（员工 id=8 已选） | 自带 MCP Server（`search_public_news` 工具）+ 客户端完整握手（initialize → tools/list → tools/call → DELETE 会话）；答辩演示：员工「西华师范大学文案生成助手」提问互联网新闻即可触发 |
| 8 | WebSocket | ✅ 满足 | `/ws`、`/ws/notify`（`app/controllers/ws.py`，任务16） | 心跳、鉴权、踢下线齐全，但目前只有回显/推送演示，业务未迁到 WS |
| 9 | layui | ✅ 满足 | `app/static/vendor/layui`（`layui.js`、`layui.css`、`font/`） | — |
| 10 | fontawesome | ✅ 满足 | `app/static/vendor/fontawesome`（`css/all.min.css` + `webfonts/`） | — |
| 11 | bootstrap | ✅ 满足 | `app/static/vendor/bootstrap/bootstrap.min.css`（5.3.3，232 KB）+ `bootstrap-grid.min.css`（栅格/flex/间距工具类） | 后台壳只引 grid 版本（不含 Reboot，避免覆盖 layui 按钮/表单）；报表/大屏/设置页用 `.row/.col-*/.g-3` 栅格实际落地 |
| 12 | echarts | ✅ 满足 | `app/static/vendor/echarts/echarts.min.js`（5.5.1）+ `china.json`（省级地图）；统一封装 `static/js/chart-kit.js` | 已接 4 处真实数据：数智大屏（趋势/地图/风险饼/信源排行）、统计报表（双轴趋势/饼/堆叠柱/热词）、舆情（7 日风险走势）、模型 Token 统计弹层（原手绘图表已替换） |

**结论：按最严口径，仅 5（AHLLMProxy）1 项存在判缺风险，对应 -10%。**
MCP 已由「本地 MCP Server + 客户端 + 工具注册」三件套补齐并可由数字员工调用；bootstrap / echarts 已本地化并接入真实数据；
AHLLMProxy 属于「可能已有但没声明」，只需补口径（`config.BASE_URL → 11435/v1 → 模型`）与代理运行截图。

## 2 任务一（v1.0，40 分）功能清单核对

### 2.1 后台业务管理系统（`/admin`）

| 功能 | 判定 | 证据 / 缺口 |
| --- | --- | --- |
| 用户管理 | ✅ 已实现 | `/api/admin/users` CRUD + 批量删除 + 强制下线 + 登录审计 |
| 角色管理 | ✅ 已实现 | `/api/admin/roles` CRUD + 菜单分配；内置 admin 保护 |
| 菜单管理 | ✅ 已实现 | 两级菜单树、拖拽排序、启停 |
| 模型引擎 | ✅ 已实现 | `/api/admin/models` CRUD + 设默认 + SSE 测试 + token 统计 |
| 数字员工 | ✅ 已实现 | `/api/admin/employees` 橱窗 + 提示词/MD 关联/workspace 浏览 |
| 工具链路 | ✅ 已实现（只读矩阵） | **成员 C**：`/admin/tools` 页 + `GET /api/admin/tools`：展示 `TOOL_REGISTRY` 六工具（weather/todo/task/memory/warehouse/mcp_search）的类型/提供方/说明 + 数字员工绑定矩阵；工具注册仍由代码 `agent_service.py` 决定，页面不提供动态注册（避免与数字员工页双写） |
| 信源管理（≥3 个源，含百度新闻） | ✅ 达标 | `sources` 表 3 条：百度资讯搜索、中新网 RSS、Google 新闻 RSS（均带真实检索/订阅 URL，采集页可跑通） |
| 采集管理（大模型 + 智能体批量采集） | ✅ 已实现 | `/collect` 独立页 + `/api/collect/run`（线程池，双引擎解析） |
| 数据仓库 | ✅ 已实现 | `/api/admin/warehouse` + 深采 SSE |
| 知识仓库（RAG） | ✅ 已实现 | `/admin/knowledge` 页支持录入/上传 md、索引、删除；`intelligence_service.index_document()` 分块（800 字/680 步长）+ 向量入库，`retrieve()` 按余弦相似度召回；库内已导入 3 篇示例文档（`knowledge_documents=3`、`knowledge_chunks=7`，`docs/knowledge-samples/`）。无启用 embedding 模型时按 `local-lexical-v1` 词法向量降级，检索可命中；`rag_kb_ids` 已接入对话（`agent_service.py:270-276`：命中→作为 `knowledge` 注入 prompt，异常→显式 `notice` 告知未引用） |
| 会话管理 | ✅ 已实现 | **成员 E**：`/admin/sessions` 登录会话管理页（`state`=active/revoked/expired/all 筛选 + 三态统计 + 按 id 撤销 / 按用户批量下线 / 清理过期，撤销联动 `kick_user` 踢 WS）；「对话会话」维度（`messages.session_id` 聚合视图）仍未做 |
| 对话管理 | ✅ 已实现 | **成员 E**：`/admin/messages` 跨用户对话记录页（6 条件筛选 + 详情全文 + 单条/批量删除）+ `/admin/archives` 会话归档追溯页（含 `origin_id`）；普通用户仍只走 `/api/history` 隔离视图 |
| 工作空间 | ⚠️ 部分 | `/api/admin/employees/files` 可在 workspace 内浏览/关联 md；无独立工作空间管理页 |

### 2.2 前台用户应用系统（`/`）

| 功能 | 判定 | 证据 / 缺口 |
| --- | --- | --- |
| AI 对话（数据库/RAG/互联网数据） | ✅ 已实现 | `/api/chat` + agentica 工具链路；**RAG 已接线**（`rag_kb_ids` → `retrieve()` → prompt.knowledge），示例库 3 篇、已绑定「西华师范大学文案生成助手」（id=8）；本轮实测 `retrieve("舆情风险分级", [1,2,3])` 命中 2 条（最高 0.2209），模型服务 11435 在线（返回 deepseek-v4.1-flash-1017）。互联网侧由 `mcp_search` 工具承担，已接入 |
| 历史会话 | ✅ 已实现 | `GET /api/history` 默认返回当前账号最近 50 条裸数组；`?sessions=1` 返回按 `session_id` 聚合的会话列表（标题取首条消息），对话页左侧列表可切换/新建 |
| 智能问数（选数字人 → 分析 → 问数报告） | ✅ 已实现 | **成员 D**：`/qa` 页 + `/api/qa/ask|history|report/<id>`；`StatsRepository` 真实统计快照→模型结构化 JSON（`services/qa_service.py`），模型不可用时启发式兜底不报错；`qa_reports` 表按用户隔离历史；零依赖 canvas 手绘 bar/line 图表 |
| 多轮对话 | ✅ 已实现 | `stream_answer(message, user, employee, history=...)` 显式注入本会话历史（`agent_service.py:263-278`），仓储按 `session_id` 取上下文；前端可新建/切换会话（`chat.js` 的 `chatSessionList` + `GET /api/history?sessions=1`）；隔离分支要求 `history` 中 interrupted 回复可续写 |
| 数字人（助手）选择 | ✅ 已实现 | `/api/assistants`、`/api/assistants/select` + 输入区选择器 |

### 2.3 工程架构偏差（任务书目录树对照）

| 任务书要求 | 现状 | 偏差 |
| --- | --- | --- |
| `.env` / `app.py` / `app/` 四层 / `docs/` / `tests/` / `venv/` / `workspace/` / `database/` | 均在 | — |
| `dist/`（第三方模块） | 已删除（页面实际引用 `app/static/vendor/` 中的同名资源，`dist/` 仅为取包解压留存，`.gitignore` 已忽略） | 答辩一句话说明即可 |
| `workspace/`（agentica 用户级工作空间） | ✅ 已就绪（`workspace/users/` 为空，账号首次对话时框架自动创建） | `make_app()` 启动时 `os.makedirs(workspace, exist_ok=True)`；数字员工默认 `workspace_path` 校验、`/api/admin/employees/files` 根目录浏览均正常 |
| `docs/` 资料 | framework / codingPrompt / architecture / CHANGELOG / agent_roles / api / requirements / acceptance-checklist / **deploy（本轮新建）** / **bug-log（本轮新建）** / VERSION | `requirements.md` 已有正文；仓库根 **README.md 本轮已建** |
| `tests/` 只放测试脚本 | `tests/pytest/`（16 文件，160 项）；开发期手工冒烟/UI 复验脚本（`smoke_*` / `verify_*` / `preview_*`）与验证截图属过程产物，交付前已清理 | 自动化用例保留可复跑 |
| 版本号与 tag 一致 | `VERSION`=v0.12.0；现有 tag 最新为 v1.4.0（2026-11-05，前序体系） | 仍**无 v0.12.0 tag**；打 tag 属人类发布决策，已记入 `bug-log.md` TODO-001 |

## 3 任务二（v1.1，40 分）清单

| 功能 | 判定 | 缺口 |
| --- | --- | --- |
| 数智大屏（地图 + 报表、语音对话/播报） | ✅ 已实现 | **成员 C**：`/admin/dashboard` 独立全屏模板（脱离后台壳）+ `GET /api/stats/stream`（SSE：`bootstrap` 首帧 + `snapshot` 增量 + `heartbeat` 保活）+ `POST /api/dashboard/ask` 九类意图规则直答；6 KPI + 趋势折线 + 中国地图（`china.json` 省级着色）+ 风险饼 + 信源排行 + 预警流 + 最新采集滚动条 + 热词；TTS 用浏览器 `speechSynthesis` 播报、ASR 用 Web Speech，浏览器不支持时**显式提示**不静默；地图口径为「标题/摘要文本提及省份」，页面上有口径标注，不伪造采集地分布 |
| 统计报表（分类统计、自选图例、实时推送） | ✅ 已实现 | **成员 C**：`/admin/reports` + `GET /api/stats/snapshot`；7/14/30/90 日切换、6 KPI、趋势双 Y 轴（条数/Token 可勾选图例）、风险饼、信源排行/占比切换、7 日风险堆叠柱、热词 Top16、最新清单；每分区 PNG 导出（`chart-kit.exportPng`）+ SSE 开关 |
| 智能舆情（异常预警、实时跟进） | ✅ 已实现 | **成员 C**：`/admin/sentiment` 重建：首屏服务端渲染 + WebSocket `/ws/admin/sentiment` 3 秒推送全量 reviews；四等级 KPI、等级筛选、高风险高亮/提示音/桌面通知、断线自动重连、7 日风险走势图；「分析待处理条目」沿用成员 B 的 `review_pending()`（表单 POST + 303） |
| 定时任务（周期执行 + 邮件/QQ 通知） | ✅ 已实现 | **成员 E**：`services/scheduler_service.py`（APScheduler 优先、缺失降级 tornado、`SCHEDULER_ENABLED=0` 仅手动）+ `/admin/tasks` 管理页 + `/api/admin/tasks*`（CRUD/启停/手动 run/执行日志）+ `/api/admin/scheduler`（状态/重载）+ `/api/admin/notify/test` + `services/notify_service.py`（邮件 SMTP_SSL/STARTTLS、QQ webhook 优先回退邮箱 SMTP，未配置显式 `degraded` 不静默）+ **`/admin/notify` 通知配置在线化**（`system_settings` 表，DB 优先 `.env` 兜底，凭据脱敏不回传明文，无需改 `.env` 重启）；内置日志清理/会话归档两默认任务。本轮补装 `apscheduler 3.11.3` 并钉入 `requirements.txt`，`status()` 实测 `engine=apscheduler`、`apscheduler_available=true`、启用任务 2 个 |
| 人脸登录 | ✅ 已实现 | `/auth/face/login` + `/api/face/*`（ONNX 或 fallback 引擎） |
| 用户管理 → 人脸数据管理/录入 | ✅ 已实现 | `/api/admin/users/{id}/faces`（查看/代录/启停/删除，特征加密、不回传向量） |
| 用户中心 | ✅ 已实现 | **成员 D**：`/user` 页 + `/api/user/profile`（资料/统计，不回传哈希）/`password`（验旧密+改密后旧会话全失效重签当前）/`sessions`（本人活跃会话自查）；`users.nickname/avatar` 列幂等迁移 |
| 3D 数字人 | ✅ 已实现 | **成员 D**：`/avatar` 页虚拟主播：本地 vendor VRM 动漫模型（three-vrm-girl）+ GLTFLoader，morph 口型（a/i/u/e/o）+眨眼+joy 表情，骨骼 idle/视线跟随/垂手，浏览器原生 Web Speech API 逐句朗读可静音；复用 `/api/chat` SSE 实时字幕；降级链：模型失败→程序化低多边形人形，WebGL 不可用→提示+纯文本对话 |
| 导出对话 → PDF | ✅ 已实现 | **成员 D**：`GET /api/chat/export?session_id=` 服务端 reportlab 真 PDF（STSong-Light 离线中文，按用户隔离）；对话页头部导出按钮；`requirements.txt` 已钉 `reportlab==5.1.0` |
| AI 对话增强 @音乐 | ✅ 已实现 | **成员 D**：`music_tracks` 表 + 6 首离线合成内置曲库（音频随仓库提供，`music_tracks` 幂等种子）；`/api/music/search|play`；对话页 `@音乐 关键词` 拦截→气泡内 HTML5 audio 自动播放 |

## 4 任务三（v1.2，20 分）清单

| 功能 | 判定 | 缺口 |
| --- | --- | --- |
| 同时支持 mysql / sqlite，后台可切换，默认 sqlite | ✅ 已实现 | **成员 C**：`/admin/settings` 数据库卡 + `POST /api/admin/settings` 的 `db_test` / `db_switch`；`services/settings_service.py` 先探通再切、`config.reload(strict=True)` + `init_db()` 在目标库建表、任一步失败回滚原驱动并写回 `.env`（临时文件 + `os.replace`）。已知限制：历史数据不自动迁移、切换后需重新登录、`switch_database` 为进程内热切换（多进程部署需重启） |
| 动态配置系统名称、图标 | ✅ 已实现 | **成员 C**：`SystemSettingsRepository` + `BaseHandler.render` 统一注入 `site_name/site_subtitle/site_logo/site_favicon`；`base.html` 标题与 favicon、`admin/base.html` Logo/品牌名/foot 版本行、数智大屏标题均已改为动态；Logo/Favicon 上传校验真实字节（png/jpg/gif/webp/svg，≤64KB，随机文件名落 `static/uploads/brand/`） |
| 配置语音/人脸模型 | ✅ 已实现 | **成员 C**：设置页「语音与人脸模型」卡：TTS 语音（浏览器声音列表）/语速/自动播报、ASR 开关、人脸引擎（auto/onnx/fallback）与阈值；写 `system_settings` 并把 `FACE_ENGINE/FACE_THRESHOLD` 同步回 `.env` |
| 其他可配置项 | ✅ 已实现 | **成员 C**：水印开关、大屏刷新间隔（SSE 心跳口径 5~120s）、会话有效期、登录失败次数与锁定时长、审计保留天数；均带范围校验，非法值 400 而非 500 |

## 5 本轮已完成 / 仍待办（成员 F 职责）

| 职责 | 状态 |
| --- | --- |
| 接口文档 `docs/api.md` | ✅ 本轮新建（62 条路由逐条核对） |
| 技术栈核对表与整改建议 | ✅ 本文件 |
| pytest 单测套件 | ✅ 已建成：`tests/pytest/`（15 个用例文件 + `conftest.py`）+ 根 `pytest.ini`（限定 `testpaths`、禁用 cache）+ `requirements-test.txt`；本轮补装 `pytest 9.2.0` + `pytest-html 4.2.0` 并实跑：**160 个用例、0 失败、退出码 0**（全程临时 SQLite，不触碰 `database/govagentos.db`） |
| 部署文档 `docs/deploy.md` | ✅ 本轮新建（环境/配置全表/启动方式/反代/双库切换/冒烟/排障） |
| README | ✅ 本轮新建（仓库根 `README.md`：技术栈对照、目录、快速开始、页面导航、降级说明） |
| BUG 跟踪 `docs/bug-log.md` | ✅ 本轮新建（6 条已修、8 条已知限制、5 条待修） |
| Git 分支规范 / 版本 tag 计划 | ⬜ 待人类执行（tag 属发布决策，已记 `bug-log.md` TODO-001） |
| 演示 PPT / 答辩材料 / 录屏 | ⬜ 待办 |
| `docs/requirements.md` 需求说明 | ✅ 已有正文（功能 B-01~B-06 + 非功能六条） |

## 6 整改建议（按性价比排序）

0. ~~**建 `workspace/` 目录**~~ ✅ **已完成**：目录已存在，`make_app()` 启动时自动 `makedirs`，数字员工工作空间与文件浏览接口正常。
1. ~~**补 bootstrap / echarts**~~ ✅ **已完成（成员 C，2026-11-11）**：`vendor/bootstrap` + `vendor/echarts`（含 `china.json`）已落盘，`chart-kit.js` 统一封装，数智大屏/统计报表/舆情/模型 Token 统计四处接真实数据。
2. **AHLLMProxy 口径**（唯一剩余判缺风险，-10%）：确认 11435 是否为课程指定代理；是则在 README/答辩材料写明调用链（`config.BASE_URL` → AHLLMProxy → 模型），并保留运行截图。
3. ~~**MCP**~~ ✅ **已完成**：`/mcp/news` 本地 MCP Server + `mcp_service` 客户端 + 员工 `tools` 可选 `mcp_search`（员工 id=8 已选）；待做的是**答辩现场演示一次调用**。
4. ~~**信源补齐到 ≥3**~~ ✅ **已完成**：`sources` 表 3 条（百度资讯搜索、中新网 RSS、Google 新闻 RSS），均有真实可采集 URL。
5. **RAG / 工具链路**：✅ 已接线并实测命中（3 文档/7 分块，`retrieve` 返回 2 条）；提醒：若启用 embedding 模型需重新索引（见 `bug-log.md` LIM-004）。
6. ~~**任务二其余项（大屏/报表前端UI/舆情）**~~ ✅ **已完成（成员 C，2026-11-11）**：三页均已落地并通过 `test_14_dashboard_reports.py`；定时任务与统计后端聚合（成员 E）、用户中心/3D 数字人/PDF 导出/＠音乐（成员 D）此前已落地。
7. ~~**`requirements.md`、部署文档、README**~~ ✅ **已完成（成员 F）**：三份均已补齐；剩下的是**演示 PPT / 答辩材料 / 录屏**与**版本 tag**。
8. **环境依赖巡检（本轮）**：`apscheduler`、`pytest`、Chromium 内核、`onnxruntime` 已装并固化；人脸模型 `w600k_r50.onnx`（166.3 MiB，不入库）已下载并重启验证，`engine_info()` = `engine=onnx, real=true, degraded=false`（下载脚本 `tools/download_face_model.py`，见 `bug-log.md` BUG-008~010）。

## 7 复核方法（可复现）

```powershell
# 1) 进入工程并使用项目 venv
cd D:\UGit\701-grp-53c6ce9c086f\src\小组仓库\GovCheckDataAgentOS
.\venv\Scripts\Activate.ps1

# 2) 技术栈静态核对
Get-ChildItem app\static\vendor -Directory            # 应出现 bootstrap / echarts 才算补齐
Select-String -Path app\**\*.py -Pattern 'MCP','AHLLMProxy' -SimpleMatch

# 3) 接口与鉴权回归
python -m pytest -q                                   # pytest.ini 已限定 testpaths=tests/pytest（160 项）

# 4) 服务探活（另开窗口启动服务后）
python app.py
curl http://127.0.0.1:10086/healthz
```

## 8 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-07 | v0.11.1 | 首次成文：12 项技术栈核对、任务一/二/三清单、架构偏差、整改优先级 |
| 2026-11-09 | v0.11.1 | 成员 E 交付同步：定时任务转「✅ 已实现（后端）」、统计报表转「⚠️ 部分（后端已备，`/api/stats/*`）」，整改建议 6 相应收敛 |
| 2026-11-10 | v0.11.1 | 成员 E 交付同步：会话管理、对话管理转「✅ 已实现」（`/admin/sessions`、`/admin/messages`、`/admin/archives` 三页 + API，`tests/verify_messages_sessions.py` 52/52）；定时任务行补 `/admin/notify` 通知配置在线化。已知限制：`system_settings` 写用 `INSERT OR REPLACE`，`DB_DRIVER=mysql` 下保存通知配置会失败（SQLite 主链路不受影响）；`/admin/notify` 页面按 URL_NOTIFY 鉴权但其配置接口仍按 `/admin/tasks` 鉴权 |
| 2026-11-11 | v0.12.0 | 成员 C 交付同步：技术栈 11/12（bootstrap 5.3.3 + echarts 5.5.1 + china.json）转 ✅，判缺风险由 -40% 收敛到 -20%（仅剩 AHLLMProxy 口径与 MCP）；新增 `/admin/dashboard`、`/admin/reports`、`/admin/tools`、`/admin/settings` 四页并重建 `/admin/sentiment`；工具链路、信源 3 条、任务三系统管理四行转 ✅；新增 `tests/pytest/test_14_dashboard_reports.py`、`test_15_settings.py`（30 用例全绿）；真机冒烟（临时库副本）六页 200 + 快照/工具/设置三接口 200 + SSE 首帧正常，期间修掉舆情页模板 `LEVEL_LABELS` 未定义导致的 500 |
| 2026-11-11 | v0.12.0 | **依赖与环境二次复核**：补装 `apscheduler 3.11.3`（调度器实测 `engine=apscheduler`）、`pytest 9.2.0`（160 用例全绿）、Chromium 内核（Crawl4AI 深采可跑）、`onnxruntime 1.31.1`；两个 requirements 文件改为 UTF-8 BOM（修 pip GBK 解码崩溃）；新建根 `README.md`、`docs/deploy.md`、`docs/bug-log.md`；`tests/` 截图移入 `tests/artifacts/`；按代码证据重判 MCP ✅、多轮对话 ✅、历史会话 ✅、AI 对话 ✅、定时任务去「后端」限定；判缺风险收敛到 1 项（AHLLMProxy，-10%）；另补 `tools/download_face_model.py`（双源下载 ArcFace 模型 + onnxruntime 加载自检），`pytest --html` 生成 158KB 自包含报告；**人脸模型已下载就位并重启验证，`engine=onnx`、`degraded=false`** |
