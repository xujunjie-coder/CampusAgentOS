# 部署文档（deploy.md）

> 适用版本：`docs/VERSION` = v0.12.0
> 目标读者：负责把本项目部署到一台机器（本机演示 / 答辩机 / 内网服务器）并保证可运行的人。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 或 Linux（x86_64） | 开发与验收均在 Windows 11 + PowerShell 下完成 |
| Python | 3.12.x（3.11/3.10 可用） | 依赖按本机 venv（3.12.9）固化，`requirements.txt` 已钉版本 |
| 磁盘 | ≥ 800MB | venv 约 400MB，Chromium 内核约 150MB，SQLite/上传/工作空间若干 |
| 内存 | ≥ 2GB | Crawl4AI 深采时 Chromium 会额外占用 300MB+ |
| 网络 | 可访问信源站点与大模型服务 | 大模型默认走本机 `127.0.0.1:11435`（AHLLMProxy） |

外部组件（不属于 pip 依赖）：

- **AHLLMProxy / OpenAI 兼容模型服务**：默认 `BASE_URL=http://127.0.0.1:11435/v1`，答辩前必须处于运行状态。
- **MySQL 5.7+ / 8.x（可选）**：仅当需要现场演示任务三「SQLite ⇄ MySQL 切换」时才需要。

---

## 2. 首次部署

### 2.1 Windows（PowerShell）

```powershell
cd <仓库根>
python -m venv venv
.\venv\Scripts\Activate.ps1

# 运行依赖（requirements.txt 为 UTF-8 BOM，可直接解析中文注释）
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 深度采集浏览器内核（Crawl4AI 主引擎）
# 国内网络建议先设镜像，否则官方 CDN 可能长时间无进度：
#   $env:PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.npmmirror.com/binaries/playwright"
.\venv\Scripts\python.exe -m playwright install chromium

# 测试依赖（仅需要跑 pytest 时）
.\venv\Scripts\python.exe -m pip install -r requirements-test.txt

# 配置
Copy-Item .env.example .env
```

### 2.2 Linux

```bash
cd <repo>
python3.12 -m venv venv
. venv/bin/activate
pip install -r requirements.txt
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
  python -m playwright install chromium
# 若提示缺系统库：python -m playwright install --with-deps chromium
cp .env.example .env
```

### 2.3 可选：人脸真实精度

```powershell
.\venv\Scripts\python.exe -m pip install onnxruntime
# 引擎只依赖 onnxruntime + Pillow/numpy（代码不用 cv2，无需 opencv-python）
# 一条命令下载模型（≈174MB，自动落到 database/models/face/）：
#   源顺序：hf-mirror.com 镜像 → HuggingFace 官方 → GitHub Release；每源 30s 超时自动切换
.\venv\Scripts\python.exe tools\download_face_model.py
# 也可手动把 w600k_r50.onnx / arcface_r50.onnx / insightface_r50.onnx 任一命名放入该目录
```

不装时请保持 `FACE_ENGINE=auto`：启动后按 fallback 引擎运行，页面上会显式提示"精度受限"，不会静默降级。
若把 `FACE_ENGINE` 设为 `onnx` 却没放模型，服务启动会直接报错（这是刻意设计，避免答辩时误以为在用真实精度）。

### 2.4 生成密钥

```powershell
python -c "import secrets;print(secrets.token_urlsafe(48))"
# 把输出写入 .env 的 COOKIE_SECRET
```

> `.env` 中 `COOKIE_SECRET` 缺失、仍是 `please-change-me` 等占位值、或长度 < 32，`make_app()` 会抛
> `ConfigError` 并列出修复方式，服务拒绝启动。

---

## 3. 配置说明（.env）

按功能分组，完整注释见 [`.env.example`](../.env.example)。后台「系统设置 / 通知配置」可在线覆盖部分项（DB 优先，`.env` 兜底）。

| 分组 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 大模型 | `BASE_URL` / `API_KEY` / `MODEL_ID` | `127.0.0.1:11435/v1` / 空 / `smart` | 无启用模型时的兜底；正式接入在「模型引擎」维护 |
| 应用 | `APP_HOST` / `APP_PORT` | `127.0.0.1` / `10086` | 对外服务时改 `0.0.0.0` |
| 应用 | `DEBUG` | `1` | 生产必须为 `0`（关闭调试页与自动重载） |
| 应用 | `COOKIE_SECRET` | 无 | 必填，≥32 位随机串 |
| 应用 | `XSRF_ENABLED` | `1` | 关闭仅用于本地排障 |
| 应用 | `LOG_LEVEL` | `INFO` | DEBUG/INFO/WARNING/ERROR/CRITICAL |
| 数据库 | `DB_DRIVER` | `sqlite` | `sqlite` 或 `mysql` |
| 数据库 | `DB_PATH` | `database/govagentos.db` | 仅 sqlite 生效 |
| 数据库 | `DB_HOST/PORT/USER/PASSWORD/NAME/CHARSET` | — | 仅 mysql 生效；字符集固定 utf8mb4 |
| 会话 | `SESSION_TTL_HOURS` | `12` | 登录会话有效期 |
| 会话 | `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | `5` / `10` | 连续失败锁定策略 |
| 人脸 | `FACE_ENGINE` | `auto` | `auto` / `onnx` / `fallback` |
| 人脸 | `FACE_THRESHOLD` | `0.35` | ArcFace 余弦阈值（fallback 引擎内部用更严口径） |
| 人脸 | `FACE_MODEL_DIR` | `database/models/face` | ONNX 模型目录（不入库） |
| 流式 | `SSE_HEARTBEAT_SECONDS` / `WS_HEARTBEAT_SECONDS` | `15` / `30` | 心跳保活 |
| 跨域 | `CORS_ALLOW_ORIGINS` | 空 | 逗号分隔完整 Origin；留空=仅同源 |
| 定时任务 | `SCHEDULER_ENABLED` | `1` | 0=只允许手动触发 |
| 通知 | `SMTP_*` / `MAIL_FROM` / `MAIL_TO` | 空 | 邮件通知；全空视为未配置，显式降级 |
| 通知 | `QQ_WEBHOOK_URL` / `QQ_SMTP_*` / `QQ_TO` | 空 | QQ 通知，webhook 优先、邮箱 SMTP 回退 |

---

## 4. 启动与停止

### 4.1 前台运行（开发/答辩）

```powershell
.\venv\Scripts\python.exe app.py
# 日志形如：服务器启动：http://127.0.0.1:10086  DB驱动=sqlite  DEBUG=0
```

### 4.2 Windows 后台常驻

```powershell
# 方式一：任务计划程序，触发器=登录时，操作=python.exe app.py，起始于=<仓库根>
# 方式二：临时后台（关窗口即结束）
Start-Process -FilePath ".\venv\Scripts\python.exe" -ArgumentList "app.py" -WorkingDirectory (Get-Location) -WindowStyle Hidden
# 停止
Get-NetTCPConnection -LocalPort 10086 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 4.3 Linux systemd

```ini
# /etc/systemd/system/govagentos.service
[Unit]
Description=GovCheckDataAgentOS
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/GovCheckDataAgentOS
ExecStart=/opt/GovCheckDataAgentOS/venv/bin/python app.py
Restart=on-failure
RestartSec=3
Environment=DEBUG=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now govagentos
journalctl -u govagentos -f
```

### 4.4 部署形态限制（重要）

- **必须单进程**运行。项目使用 tornado 单 IOLoop + 进程内状态（WebSocket 连接表、调度器、系统设置缓存），
  多进程会出现推送丢失、任务重复调度、设置不一致。
- 需要横向扩容时，先拆出独立的调度进程与消息通道（当前版本未提供）。
- 反向代理（Nginx）需为 SSE/WebSocket 关闭缓冲：

```nginx
location / {
    proxy_pass http://127.0.0.1:10086;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_buffering off;          # SSE 必须
    proxy_read_timeout 3600s;     # 长连接
}
```

---

## 5. 数据库

### 5.1 SQLite（默认）

- 文件：`database/govagentos.db`，启动时 `init_db()` 幂等建表 + 补列 + 种子菜单。
- 备份：

```powershell
Copy-Item database\govagentos.db "logs\govagentos-$(Get-Date -Format yyyyMMdd-HHmm).db.bak"
```

- 恢复：停服 → 覆盖文件 → 启动。

### 5.2 切换到 MySQL

**第 0 步：先在 MySQL 建空库**（设置页的「测试连接」只验证连通与库存在，不会代建库）：

```sql
CREATE DATABASE govagentos DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
```

两种入口，效果相同：

1. 后台 `/admin/settings` → 数据库卡 → 填参数 → 「测试连接」→「切换并重启生效」；
2. `POST /api/admin/settings`，`{"action": "db_switch", "driver": "mysql", ...}`。

行为与限制：

- 先探测连通（`SELECT VERSION()`），成功后 `config.reload(strict=True)` + 在目标库 `init_db()` 建表，任一步失败自动回滚原驱动；
- 切换会写回 `.env`（临时文件 + `os.replace`），因此**运行账号需要对仓库根有写权限**；
- **历史数据不迁移**：切到 MySQL 后是空库，需要重新采集/导入；切回 SQLite 原数据仍在；
- **新库没有管理员账号**：`init_db()` 不种用户，切换后先在前台注册一个账号，再在 MySQL 执行 `UPDATE users SET role='admin' WHERE username='你的账号';` 才能进后台；现场演示建议「SQLite 展示功能 → 切 MySQL 看 healthz/建表 → 切回 SQLite」；
- 切换后当前登录会话失效，需重新登录；
- 进程内热切换，多进程部署必须整组重启。

---

## 6. 部署后冒烟清单

```powershell
# 1) 进程探活
Invoke-WebRequest http://127.0.0.1:10086/healthz -UseBasicParsing
# 期望：{"ok": true, "db": "sqlite", "version": "v0.12.0"}

# 2) 页面（登录后）
#    前台：/ /user /qa /avatar
#    后台：/admin /admin/dashboard /admin/reports /admin/sentiment
#          /admin/tasks /admin/notify /admin/settings

# 3) 关键接口
#    GET /api/stats/snapshot        大屏/报表快照
#    GET /api/admin/scheduler       期望 engine=apscheduler
#    GET /api/admin/tools           六工具 + 员工绑定矩阵
#    GET /api/admin/settings        系统设置（凭据脱敏）

# 4) 自动用例（tests/pytest，160 项，跑在临时库上，不碰正式库）
.\venv\Scripts\python.exe -m pytest -q
```

---

## 7. 常见故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即 `ConfigError：COOKIE_SECRET 未配置…` | `.env` 缺密钥或用示例值 | 按提示生成 ≥32 位随机串 |
| `pip install -r requirements.txt` 报 `UnicodeDecodeError: 'gbk' codec…` | 文件被存成无 BOM 的 UTF-8 | 本项目已加 UTF-8 BOM；若被编辑器重写，另存为「UTF-8 带 BOM」或去中文注释 |
| 定时任务 `engine=tornado`、cron 任务不自动跑 | 缺 `apscheduler` | `pip install apscheduler`（已在 requirements 钉住）后重启 |
| 深度采集报「浏览器内核缺失」/ Crawl4AI 不可用 | 未装 Chromium | `python -m playwright install chromium` |
| 人脸页提示「精度受限」 | `FACE_ENGINE=auto` 且无模型/`onnxruntime` | 装 onnxruntime + 放模型，或接受 fallback 演示 |
| 对话报模型不可用 / 舆情一直待处理 | 11435 模型服务未启动或密钥错 | 启动 AHLLMProxy，或在「模型引擎」切换可用模型并设默认 |
| 登录后仍被踢回登录页 | `COOKIE_SECRET` 变更导致旧 Cookie 失效 | 重新登录即可 |
| 后台设置保存失败 | 仅 MySQL 模式下 `system_settings` 写入曾报错 | 已于 2026-11-12 修复（BUG-014），两种驱动均可保存 |
| 切换 MySQL 报「目标库不存在」 | 设置页只测连通不代建库 | 先按上方 5.2 第 0 步执行 `CREATE DATABASE`（也可用 `mysql -uroot -p` 建库后重试） |
| 端口被占用 | 残留进程 | `Get-NetTCPConnection -LocalPort 10086` 找到 PID 后结束 |

---

## 8. 升级与回滚

1. 备份 `database/`、`.env`、`workspace/`、`app/static/uploads/`；
2. 拉取代码后 `pip install -r requirements.txt`（依赖有变更时）；
3. 启动即自动补表/补列/补种子菜单，无需手工 SQL；
4. 回滚：恢复备份目录 + 切回上一个 git tag；
5. 升级记录写入 [`CHANGELOG.md`](CHANGELOG.md)，缺陷写入 [`bug-log.md`](bug-log.md)。
