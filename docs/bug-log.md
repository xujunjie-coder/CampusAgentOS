# 缺陷跟踪（bug-log.md）

> 维护：成员 F ｜ 基线：v0.12.0 ｜ 最近更新：2026-11-12
> 记录口径：只记**可复现、能给出证据**的问题；历史批量修复见 [`CHANGELOG.md`](CHANGELOG.md) 的「修复」小节，这里只留索引与当前未决项。
> 状态：`已修复` / `已知限制`（有明确 workaround，不改代码）/ `待修`（影响评分或稳定性）

---

## 1. 本轮修复（2026-11-11 依赖与环境巡检）

| 编号 | 模块 | 现象 | 根因 | 处理 | 状态 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | 工程 / requirements | 新机器执行 `pip install -r requirements.txt` 直接崩：`UnicodeDecodeError: 'gbk' codec can't decode byte 0xa7` | 两个 requirements 文件是 UTF-8 **无 BOM** 且含中文注释，pip 在中文 Windows 上按 cp936 解码 | `requirements.txt` / `requirements-test.txt` 另存为 **UTF-8 with BOM**（pip 的 `auto_decode` 优先识别 BOM），注释保留 | 已修复 |
| BUG-002 | 定时任务（成员 E） | `/api/admin/scheduler` 返回 `engine=tornado`、`apscheduler_available=false`，cron 任务不自动排程 | venv 未安装 `apscheduler`，且未写入 `requirements.txt` | 安装 `apscheduler==3.11.3`，并在 `requirements.txt` 钉版本（`tzdata`/`tzlocal` 随依赖自动装） | 已修复 |
| BUG-003 | 深度采集（成员 B/E） | 仓库深采面板提示「浏览器内核缺失」，Crawl4AI 主引擎不可用，只能回退 requests | 未执行 `playwright install chromium`，`%LOCALAPPDATA%\ms-playwright` 下无 chromium-* | 已执行安装（国内网络需设 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`，否则官方 CDN 会长时间无进度） | 已修复 |
| BUG-004 | 测试（成员 F） | `python -m pytest` 报 `ModuleNotFoundError: No module named 'pytest'`，15 个用例文件一条都跑不了 | venv 只装了运行依赖，`requirements-test.txt` 从未安装 | 安装 `pytest 9.2.0` + `pytest-html 4.2.0`（含 `pluggy`/`iniconfig`/`pytest-metadata`） | 已修复 |
| BUG-005 | 测试 / 对话 | `test_07_chat_assistant.py::test_chat_requires_message` 断言失败：期望 `detail` 含 `message`，实际是「请输入 1 至 8000 字的消息」 | 接口错误文案早前改为中文，用例未同步 | 断言改为匹配「消息」，跑通后 160 个用例全绿 | 已修复 |
| BUG-006 | 文档 / 验收 | `docs/acceptance-checklist.md` 多项判定过期：MCP 标「缺」但已实现、多轮对话标「待验证」但已注入 history、`workspace/` 标「不存在」、`requirements.md` 标「0 字节」 | 验收表最后整体复核停在 11-07/11-10，后续成员 B/C/D 交付未回写 | 按代码证据重判并补「本轮复核」记录 | 已修复 |
| BUG-007 | 测试目录 | `tests/` 根 26 个脚本与 16 张校验截图混放，看不出哪个是产物 | 早期自测脚本直接 `page.screenshot(path="tests/...")` | 新建 `tests/artifacts/` 归档全部 png，`verify_models_ui.py` 的 `SHOT_DIR` 改指该目录 | 已修复 |
| BUG-008 | 人脸 / 工具脚本 | 模型下载跑到 100%（166/166 MB）后报 `[WinError 17] 系统无法将文件移到不同的磁盘驱动器`，两个源全部失败 | 脚本用 `tempfile.mkstemp()` 把临时文件建在系统 `%TEMP%`（C:），目标在 D:，Windows 下 `os.replace` 不允许跨卷原子移动 | 临时文件改到 `FACE_MODEL_DIR` 同卷（`.download-*.part`）；并改为**先 `_verify` 再 `os.replace`**，避免校验失败污染目标文件 | 已修复 |
| BUG-009 | 人脸 / 工具脚本 | 首选源 `monster-lib/insightface` 返回 `HTTP Error 401: Unauthorized`（官方归档已失效/转私有） | 脚本初版引用的 HF 社区 repo 名称失效 | 换成两个公开镜像 repo（`Aitrepreneur/insightface`、`lyphanthuc/buffalo_l`，均 174MB 同名文件）+ GitHub release `buffalo_l.zip` 兜底；实测下载 166.3 MiB 并通过 onnxruntime 自检（`input.1`，`['None', 3, 112, 112]`） | 已修复 |
| BUG-010 | 人脸真实精度 | `engine_info()` 返回 `engine=fallback, degraded=true` | 已装 `onnxruntime` 但缺 `w600k_r50.onnx` | 模型已落到 `database/models/face/`（174,383,860 字节），重启服务后 `engine_info()` = `{"engine": "onnx", "real": true, "degraded": false, "threshold": 0.35}` | 已修复 |
| BUG-011 | 数据库（任务三 双库） | 切 MySQL 时 `init_db()` 报 `OperationalError: not enough arguments for format string`，目标库建表中断 | 种子信源的 SQL 含字面量 `LIKE 'https://%.baidu.com/%'`；pymysql 参数化执行会对整段 SQL 做 `%` 格式化，未转义的 `%` 被当格式符 | [`db.py`](../app/models/db.py) `to_placeholders()`：MySQL 分支先 `sql.replace("%", "%%")` 再生成 `%s` 占位符（顺序不能反） | 已修复 |
| BUG-012 | 数据库（任务三 双库） | 切 MySQL 建表报 `1064 ... near 'trigger VARCHAR(255) ...'`；`system_settings` 同样因 `key` 列失败 | `trigger` / `key` 是 MySQL 保留字，SQLite 允许裸列名 | DDL 列名统一加反引号（`_translate_column` 产出 `` `name` ``）；`task.py` 的 `trigger`、`settings.py` 的 `key` 在 DML 中同步加反引号（SQLite 同样接受） | 已修复 |
| BUG-013 | 数据库（任务三 双库） | 切 MySQL 建 `collect_items` 报 `1064 ... near 'title)) ENGINE=InnoDB ...'` | 表级约束 `UNIQUE(source_id, title)` 含空格，被按「列名 + 类型」拆成 `` `UNIQUE(source_id,` title) ``；改为整段前缀判定后又误把 `keyword` 列当成 `KEY` 约束 | `_translate_column` 新增 `_is_table_constraint()`：约束关键字需后跟括号（区分 `key` 列与 `KEY(...)`），列名统一反引号 | 已修复 |
| BUG-014 | 系统设置（成员 E） | `DB_DRIVER=mysql` 时通知配置/系统设置保存失败（LIM-003 根因） | `SystemSettingsRepository` 使用 SQLite 专属 `INSERT OR REPLACE`；连接层只翻译了 `INSERT OR IGNORE` | [`db.py`](../app/models/db.py) `_prepare()` 增加 `INSERT OR REPLACE` → `REPLACE INTO`；配合 `key` 反引号后 MySQL 下写入/覆盖/删除均正常 | 已修复 |

复现与验证命令：

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt --dry-run   # 不再报解码错误
.\venv\Scripts\python.exe -c "import apscheduler;print(apscheduler.version)"   # 3.11.3
.\venv\Scripts\python.exe -m pytest -q --tb=no                            # 退出码 0
.\venv\Scripts\python.exe -c "from app.services import face_service;print(face_service.engine_info())"  # engine=onnx / degraded=False
```

---

## 2. 已知限制（不改代码，答辩需口径说明）

| 编号 | 模块 | 现象 | 原因 / 影响 | Workaround |
| --- | --- | --- | --- | --- |
| LIM-001 | 部署形态 | 只能单进程运行 | WebSocket 连接表、调度器、系统设置缓存都是进程内状态；多进程会出现推送丢失、任务重复执行 | 用 systemd/任务计划保活单进程；扩容需先拆调度进程（未提供） |
| LIM-002 | 数据库（任务三） | 切到 MySQL 后是空库 | `db_switch` 只切驱动并建表，**不做历史数据迁移** | 答辩时说明「切回 SQLite 原数据仍在」；需要迁移则先导出 CSV 再导入 |
| LIM-003 | 系统设置（已解除） | 2026-11-12 实测 MySQL 下 `SystemSettingsRepository.set/get/delete` 均正常（含重复覆盖） | 原因为 `INSERT OR REPLACE` 未翻译 + `key` 保留字，已由 BUG-012/BUG-014 修复 | 无需再规避，两种驱动都可演示通知配置 | 已解除 |
| LIM-004 | 知识仓库 RAG | 切换/启用 embedding 模型后，旧文档检索命中数为 0 | 分块向量按 `knowledge_documents.model`（模型指纹）过滤，换模型后指纹不匹配，旧向量不会被命中，且无提示 | 换模型后在该页**重新索引**文档；答辩前保持 `local-lexical-v1`（无启用 embedding）即稳定命中 |
| LIM-005 | 智能体链路 | 本地模型服务无响应时，`/api/chat` 可能长时间挂起，期间其它请求也变慢 | `agent.run_stream()` 在上游无响应时占用 IOLoop（`docs/architecture.md` 第六节已记录） | 保证 `11435` 在线；需要根治则将阻塞调用移入 `run_in_executor` 并做队列桥接（改动面较大，未排期） |
| LIM-006 | 人脸（已解除） | 2026-11-11 已下载 `w600k_r50.onnx`（166.3 MiB）并重启，`engine_info()` = `engine=onnx, real=true, degraded=false` | 原因为缺模型文件；现已补齐，不再走 fallback | 无需操作；换机重建时执行 `python tools/download_face_model.py`（默认镜像优先，有本地代理可加 `--proxy`） | 已解除 |
| LIM-007 | 登录入口 | `GET /login` 返回 404 | 登录页实际路由为 `/auth/login`，`login_url` 同此 | 文档与演示统一用 `/auth/login`；若评分点明确要求 `/login`，加一条别名路由即可 |
| LIM-008 | 安全 | `.env` 已被 git 跟踪且含真实 `API_KEY`；`system_settings` 中 SMTP 授权码为明文存储 | 早期为便于换机保留 `.env` 入库 | 提交/外发前改用 `.env.local` 覆盖，或轮换密钥；DB 导出前脱敏 |

---

## 3. 待修（按性价比排序）

| 编号 | 事项 | 影响 | 建议 |
| --- | --- | --- | --- |
| TODO-001 | `VERSION`(v0.12.0) 与 git tag（最新 v1.4.0，2026-11-05）不一致 | 版本验收「版本号与 tag 一致」项无证据 | 由人类负责人确认发布后打 `v0.12.0`；旧 tag 属于前序仓库体系，不删除 |
| TODO-002 | WebSocket 仅承载回显/通知/舆情推送，AI 对话仍全走 SSE | 任务书「WebSocket 对话交互 + SSE 流式输出」只演示了 SSE | 补一个 `/ws/chat` 薄封装转发同一 `stream_answer()`，或在答辩材料中明确「WS 用于实时推送、SSE 用于流式生成」的分工 |
| TODO-003 | 演示 PPT / 答辩材料 / 录屏未产出 | 最终演示环节缺材料 | 按验收表第 1 节技术栈 12 项 + 任务一二三清单逐条准备 |
| TODO-004 | AHLLMProxy 无字面证据 | 技术栈可能被判缺（-10%） | 答辩材料写明调用链 `config.BASE_URL → AHLLMProxy(11435/v1) → 模型`，并附代理运行截图 |

---

## 4. 历史缺陷索引

| 日期 | 模块 | 问题 | 去向 |
| --- | --- | --- | --- |
| 2026-11-11 | 后台壳 | 上传 256px 系统图标撑破顶栏 logo 区 | CHANGELOG「修复」 |
| 2026-11-11 | 舆情页 | 模板 `LEVEL_LABELS` 未定义导致 500 | CHANGELOG「修复」 |
| 2026-11-11 | 大屏问答 | `overview()["warehouse"]` 是字典而非整数，KPI 显示 0 | CHANGELOG「修复」 |
| 2026-11-10 | 模型 Token 统计 | 手绘柱状图样式与数据不同步 | CHANGELOG「变更」改为 ECharts |
| 2026-11-09 | 配置 | `.env` 键名拼写 `BASE_UEL` 导致 BASE_URL 读不到 | CHANGELOG / architecture.md |
| 2026-11-07 | 采集 / 舆情 | 模型服务未启动时分析失败无任何提示 | CHANGELOG「修复」补显式红色说明条 |

---

## 5. 记录模板

```markdown
| BUG-xxx | 模块 | 用户可见现象（含报错原文） | 根因（代码级） | 处理（改了哪个文件/装了什么） | 状态 |
```

要求：现象必须能复现；根因必须落到文件/函数；处理必须能回滚；修复后补一条回归命令或用例编号。
