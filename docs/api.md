# 接口文档（api.md）

## 2026-11-24 增量接口与页面行为

| 路径 | 当前契约 |
| --- | --- |
| `GET /api/admin/sources` | 信源列表增加 `source_type`（`web` / `qq_channel`）与 `channel_id` |
| `POST /api/admin/sources`、`POST /api/admin/sources/{id}` | QQ 频道传 `source_type=qq_channel`、`channel_id`、`name`、`description`、`enabled`，服务端生成频道 URL，无需传请求头 |
| `GET /api/collect/qq/sources` | 返回已启用频道的 `id`、`name`、`channel`；沿用后台与采集菜单鉴权，不返回请求头 |
| `GET /api/collect/sources` | 普通网页选源不包含 QQ 频道；网页批量采集拒绝 QQ 信源并指向专用入口 |
| `GET /api/collect/qq/runs/{run}/items/{item}/comments` | 返回 `post_content`、`post_is_excerpt`、`post_images` 和评论/回复列表；图片为 URL 数组 |
| `POST /api/collect/qq/runs/{run}/items/{item}/comments` | 按需读取当前帖；已完成但尚无图片字段的旧记录重新读取补采 |
| `GET /admin/knowledge?page=N` | 每页 15 篇，总数不受旧版 100 条显示上限影响，页码越界时回退到有效页 |

知识仓库与 RAG 已在知识页面、数字员工绑定和对话检索链路实现。下文版本号及“未闭合项”记录的是 2026-11-07 基线，不能据此认定后续功能仍未实现；当前行为以代码和上述增量说明为准。

> 版本：v0.11.1 ｜ 更新日期：2026-11-07 ｜ 维护：成员 F（测试/文档）
> 依据：`app/application.py` 路由表 + `app/controllers/*` 实现逐条核对，不含任务书设想、只写代码里真实存在的接口。
> 代码改动后请同步本文件；与代码冲突时以代码为准。

## 0 通用约定

### 0.1 基地址与端口

- 默认 `http://127.0.0.1:<APP_PORT>`，`APP_PORT` 默认 **10086**（`app/config.py`）。
- 页面与接口同源部署，静态资源在 `/static/...`。

### 0.2 认证方式

- 登录成功后签发 **token 会话**：cookie 名 `session_token`（HttpOnly + SameSite=Lax + path=/），库表 `user_sessions` 只存 token 的 SHA256。
- 兼容期同时写旧签名 cookie `username` / `role`；**携带了 token 但已失效时不再回落旧 cookie**（保证登出/强制下线真的生效）。
- 未登录访问 `/api/*` → **401 JSON**（不再 302 跳登录页）：

```json
{"ok": false, "error": "未登录", "code": "UNAUTHORIZED", "request_id": "…"}
```

- 未登录访问页面 → 302 到 `/auth/login?next=<原路径>`。
- 后台接口还要求：角色是「后台角色」（`admin` 或已被分配后台菜单的角色），且拥有对应菜单权限，否则 403。

### 0.3 响应信封

| 场景 | 形状 |
| --- | --- |
| 成功（后台/业务 JSON） | `{"ok": true, ...业务字段}` |
| 失败（后台/业务 JSON） | `{"ok": false, "error": "中文原因"}` |
| 框架层错误（404/405/500 等） | `{"ok": false, "error": "...", "code": "UNAUTHORIZED 等", "request_id": "..."}` |
| 例外：`/api/history` | 返回**裸数组**（历史消息列表），不是信封 |
| 例外：`/api/chat` 参数错误 | `{"detail": "..."}`（历史遗留写法） |

`code` 取值来自 `app/controllers/errors.py`：`BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `METHOD_NOT_ALLOWED` / `CONFLICT` / `PAYLOAD_TOO_LARGE` / `TOO_MANY_REQUESTS` / `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` / `GATEWAY_TIMEOUT`。

### 0.4 通用请求/响应头

- 每个响应带 `X-Request-Id`（透传请求头或自动生成）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: same-origin`。
- CORS 仅对 `CORS_ALLOW_ORIGINS` 白名单回显精确 Origin（默认空 = 不下发）。
- XSRF：`XSRF_ENABLED` 默认开，改动类请求需带 `X-Xsrftoken` 头（模板表单自带隐藏域）。接口测试可临时设 `XSRF_ENABLED=0`。
- 所有 `OPTIONS` 预检统一 204。

### 0.5 分页与时间

- 页码 `page` 从 1 开始；`keyword` 为模糊搜索词。
- 每页条数因模块而异：后台通用 **20/页**；模型引擎 **4/页**；数字员工 **12/页**；采集数据 **12/页**；数据仓库 **20/页**；数字助理橱窗 12/页。
- 时间统一文本 `YYYY-MM-DD HH:MM:SS`。

## 1 认证与会话

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/auth/login` | 匿名 | 登录页 |
| POST | `/auth/login` | 匿名 | 表单登录：`username`、`password`、可选 `next`；成功 302（admin → `/admin`，普通用户 → `next` 或 `/`）；失败 401 回登录页，连续失败 5 次锁 10 分钟（`LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES`） |
| GET | `/auth/register` | 匿名 | 注册页 |
| POST | `/auth/register` | 匿名 | 表单 `username`（3–32 位字母/数字/中文）、`password`（≥6）、`confirm`；只能创建 `user` 角色；失败 400 |
| POST | `/auth/logout` | 登录 | 撤销当前会话（`revoked=1`）并清 cookie，302 回登录页 |
| POST | `/auth/face/login` | 匿名 | 刷脸登录：图片走 multipart（`img`/`file`/`image`）或 JSON `image`（base64/dataURL）；带 `username` 走 1:1，不带走 1:N；通过后签发同一套 token 会话，失败 401 回登录页 |

### 1.1 登录审计与强制下线

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/login-logs` | 用户管理菜单 | 参数 `page`、`keyword`（用户名模糊）、`result`（`success`/`fail`/`locked`/`logout`/`face_success`/`face_fail`/`face_enroll`）；返回 `{"ok":true,"total":n,"list":[...]}` |
| POST | `/api/admin/users/<id>/logout` | 用户管理菜单 | 撤销该用户全部有效会话；返回 `{"ok":true,"username":"...","revoked":n}` |

## 2 前台（用户侧）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 登录 | 对话主页（左侧栏 + 消息区 + 输入区数字助理选择器） |
| POST | `/api/chat` | 登录 | 流式对话，见 2.1 |
| GET | `/api/history` | 登录 | 当前账号最近消息，参数 `limit`（默认 50），返回**裸数组**；元素含 `role`/`content`/`created_at`/`employee_id`/`employee_name` |
| GET | `/api/assistants` | 登录 | 可选数字助理（仅启用态）与当前选择：`{"ok":true,"list":[...],"saved_id":n,"selected_id":n,"selected":{...},"total":n}` |
| POST | `/api/assistants/select` | 登录 | body `{"employee_id": n}`（`0` = 跟随系统默认）；返回 `{"ok":true,"saved_id":n,"selected":{...}}` |
| GET | `/user` | 登录 | 个人中心页（成员 D） |
| GET/POST | `/api/user/profile` | 登录 | 资料+概览统计 / 改昵称头像，见 2.3 |
| POST | `/api/user/password` | 登录 | 本人改密（验证旧密；改后旧会话全部失效、当前会话重签发） |
| GET | `/api/user/sessions` | 登录 | 本人活跃会话列表（只回 IP/设备/时间，不回 token） |
| GET | `/api/chat/export` | 登录 | 导出当前会话真 PDF 附件，见 2.4 |
| GET | `/api/music/search` | 登录 | 曲库关键词检索（空词=热门），见 2.5 |
| POST | `/api/music/play` | 登录 | `{"id":n}` 取播放地址并 play_count+1 |
| GET | `/qa` | 登录 | 智能问数页（成员 D） |
| POST | `/api/qa/ask` | 登录 | 问数出报告并落库，见 2.6 |
| GET | `/api/qa/history` | 登录 | 本人问数历史（用户隔离） |
| GET | `/api/qa/report/<id>` | 登录 | 取单条完整报告；别人的 id 视为不存在 404 |
| GET | `/avatar` | 登录 | 3D 数字人交互页（虚拟主播：本地 vendor VRM 模型 + GLTFLoader，浏览器原生 TTS 朗读，复用 `/api/chat` SSE） |

### 2.1 POST /api/chat（SSE）

请求体：

```json
{"message": "用户问题", "employee_id": 3}
```

- `message` 必填；`employee_id` 可选（不传则按「已保存助理 > 系统默认 > 第一个启用员工」解析）。
- 响应 `Content-Type: text/event-stream`，事件顺序如下：

| 事件 | data | 说明 |
| --- | --- | --- |
| `assistant` | `{id,name,description,avatar,tools,workspace_path,is_default,enabled}` | 本轮实际应答助理 |
| `delta` | 纯文本串 | 逐字增量 |
| `tool` | `{name,arguments}` | 工具调用时间线 |
| `reasoning` | `{text}` | 推理过程（模型支持时） |
| `done` | `{}` | 正常结束 |
| `error` | `{message}` | 异常结束 |

注意：SSE 的 `data` 是 JSON 编码后的字符串；`delta` 取出后需要再当字符串用。

### 2.2 人脸（本人）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/face/status` | 登录 | `{"ok":true,"enabled":0/1,"count":n,"faces":[...],"engine":"onnx/fallback","real":bool,"degraded":bool,"threshold":0.35,"reason":"..."}` |
| POST | `/api/face/enroll` | 登录 | 录入/覆盖一张人脸（multipart `img`/`file`/`image` 或 JSON `image`，可选 `label`）；成功自动开启本人人脸登录；质量过低/无有效纹理 400 |
| POST | `/api/face/verify` | 登录 | 与本人已录入人脸 1:1 比对；返回 `matched`、`score`、`threshold`；未录入 404 |
| DELETE | `/api/face/<id>` | 登录 | 删除本人某张人脸，删空后自动关闭人脸登录 |

安全约定：图片只在内存处理、不落 `static/`；接口**不返回特征向量**。

### 2.3 用户中心（成员 D）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/user/profile` | `{"ok":true,"profile":{id,username,nickname,avatar,role,created_at,last_login_at,face_enabled,assistant_employee_id,stats:{messages,sessions,faces}}}`；绝不回传密码哈希/盐值 |
| POST | `/api/user/profile` | body `{"nickname"?:str≤32,"avatar"?:str}`；头像仅允 `fas fa-xxx` 白名单（非法 400）；两字段均缺 400；成功回新 profile |
| POST | `/api/user/password` | body `{"old_password","new_password"}`；旧密错 403、新密 <6 位或与旧密相同 400；成功后 `revoke_username` 全部旧会话并为当前浏览器重签 cookie |
| GET | `/api/user/sessions` | `{"ok":true,"list":[{client_ip,user_agent,created_at,last_seen_at,expires_at}]}` |

### 2.4 GET /api/chat/export（导出对话 PDF，成员 D）

- 参数 `session_id`（默认 `default`，非法格式 400 JSON）；取本人该会话最近 500 条消息，服务端 reportlab 渲染（内置 CID 字体 STSong-Light，全离线）。
- 成功回 `Content-Type: application/pdf` + `Content-Disposition: attachment`（RFC 5987 中文文件名）；空会话回「无消息」占位 PDF。
- 用户隔离：只按当前登录用户取消息，不会导出他人会话内容。前台入口：对话页头部「导出PDF」按钮。

### 2.5 @音乐 曲库（成员 D）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/music/search?q=&limit=` | 多词空格分词取交集（标题/歌手/风格/标签）；空词按 play_count 热门；`{"ok":true,"list":[{id,title,artist,style,tags,file,duration,play_count}]}` |
| POST | `/api/music/play` | `{"id":n}` → `{"ok":true,"track":{...}}` 并计数+1；非法 id 400、不存在 404 |

`file` 指向本地示例音频 `/static/music/*.wav`（由 `tests/gen_music_wavs.py` 离线合成，种子见 `music_tracks` 表）；前台入口：对话页输入 `@音乐 轻音乐` 前缀拦截，气泡内 HTML5 audio 卡片自动播放首曲。

### 2.6 智能问数（成员 D）

POST `/api/qa/ask`，body `{"question": str≤500, "employee_id"?: int}`（助理校验与 `/api/chat` 同源 `pick_assistant`）。
链路：`StatsRepository` 真实统计快照 → 选定数字员工绑定模型出结构化 JSON 分析；模型不可用/输出非法时降级为统计直出报告，**接口永不因模型报错**。响应：

```json
{"ok": true, "id": 1, "report": {
  "title": "…", "summary": "…",
  "metrics": [{"name": "采集总量", "value": "128", "unit": "条"}],
  "chart": {"type": "bar|line", "labels": ["…"], "values": [1, 2], "name": "…"},
  "insights": ["…"], "advice": "…",
  "source": "model|heuristic", "model": "…", "generated_at": "…"}}
```

历史回放：GET `/api/qa/history` 列表（id/question/source/created_at）；GET `/api/qa/report/<id>` 回 `{"ok":true,"report":{…, "report": {契约对象}}}`，严格按 username 隔离。

## 3 后台页面

全部要求登录 + 后台角色，且拥有对应菜单权限：

| 路径 | 菜单权限 |
| --- | --- |
| `/admin` | 仅需后台角色（工作台，无菜单校验） |
| `/admin/users` | `/admin/users` |
| `/admin/roles` | `/admin/roles` |
| `/admin/menus` | `/admin/menus` |
| `/admin/sources` | `/admin/sources` |
| `/admin/warehouse` | `/admin/warehouse` |
| `/admin/models` | `/admin/models` |
| `/admin/employees` | `/admin/employees` |
| `/admin/tasks` | `/admin/tasks` |
| `/admin/notify` | `/admin/notify` |
| `/admin/archives` | `/admin/archives` |
| `/admin/messages` | `/admin/messages` |
| `/admin/sessions` | `/admin/sessions` |
| `/admin/dashboard` | `/admin/dashboard`（大屏独立全屏模板，不继承后台壳） |
| `/admin/reports` | `/admin/reports` |
| `/admin/sentiment` | `/admin/sentiment`（WebSocket `/ws/admin/sentiment` 推增量） |
| `/admin/tools` | `/admin/tools` |
| `/admin/settings` | `/admin/settings` + **超管强校验**（`role_code()=="admin"`，普通后台角色 403） |
| `/collect` | `/collect` |

## 4 后台数据接口

### 4.1 用户管理

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | `page`、`keyword`、`role` | `{"ok":true,"total":n,"list":[...]}` |
| POST | `/api/admin/users` | `{username, password, role}` | 校验：用户名 3–32、密码 ≥6、角色必须存在；重复用户名报「用户名已存在」 |
| POST | `/api/admin/users/<id>` | 同名字段可选；`password` 传空表示不改 | 改密/改角色/改名后该用户既有 session 立即失效 |
| DELETE | `/api/admin/users/<id>` | — | 不能删当前登录账号；删除后撤销其全部会话 |
| POST | `/api/admin/users/batch` | `{"ids":[1,2]}` | 自动排除当前账号；空 ids 报「没有可删除的项（当前登录账号已排除）」 |

### 4.2 角色管理

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/roles` | `page`、`keyword`；`all=1` 返回全量下拉（仅需后台身份） | `{"ok":true,"total":n,"list":[...]}` 或 `{"ok":true,"list":[...]}` |
| POST | `/api/admin/roles` | `{code, name, description, home}` | `code`/`name` 必填；编码重复报「角色编码已存在」 |
| POST | `/api/admin/roles/<id>` | `name`/`description`/`home` 可选 | 默认管理员（`code=admin`）不可改 |
| DELETE | `/api/admin/roles/<id>` | — | 内置 admin 不可删；角色下仍有用户不可删 |
| GET | `/api/admin/roles/<id>/menus` | — | `{"ok":true,"role":{...},"tree":[...],"assigned":[menu_id...]}` |
| POST | `/api/admin/roles/<id>/menus` | `{"menu_ids":[...]}` | 返回 `assigned`；对 admin 角色报「默认管理员拥有全部权限，无需分配」 |

### 4.3 菜单管理

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/menus` | `tree=1` 全树（仅需后台身份）；`roots=1` 一级下拉；否则 `page`、`keyword` 分页 | `{"ok":true,"list":[...]}` 或 `{"ok":true,"total":n,"list":[...]}` |
| POST | `/api/admin/menus` | `{parent_id,name,icon,url,description,sort,enabled}` | `name` 必填 |
| POST | `/api/admin/menus/<id>` | 同上字段可选 | — |
| DELETE | `/api/admin/menus/<id>` | — | 有子菜单时不可删 |
| POST | `/api/admin/menus/sort` | `{"items":[{"id","parent_id","sort"}]}` | `{"ok":true,"saved":n}` |

### 4.4 信源管理

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/sources` | `page`、`keyword` | `{"ok":true,"total":n,"list":[...]}`（`headers` 不在列表下发） |
| POST | `/api/admin/sources` | `{name,url,headers_raw,description,enabled}` | 名称 ≤64 字；`url` 须 `http(s)://` 开头；`headers_raw` 支持 DevTools RAW/标准格式，非空解析失败 → 400；重名 → 「信源名称已存在」 |
| POST | `/api/admin/sources/<id>` | 同上可选；`headers_raw` 传空串表示清空 | — |
| DELETE | `/api/admin/sources/<id>` | — | — |

### 4.5 模型引擎

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/models` | `page`、`keyword`、`type` | `{"ok":true,"total":n,"list":[...],"token_max":n,"summary":{...}}`；`api_key` 只回脱敏串（前4后4） |
| POST | `/api/admin/models` | `{name,api_url,model_id,type,api_key,thinking,enabled,description}` | 名称 1–64、地址 `http(s)://`、`model_id` 必填、`type` 合法；成功返回 `id` |
| POST | `/api/admin/models/<id>` | 同上可选；`api_key` 留空保持不变 | — |
| DELETE | `/api/admin/models/<id>` | — | 默认模型自动让位；同步清理该模型 token 流水 |
| POST | `/api/admin/models/<id>/default` | — | 须启用态 |
| GET | `/api/admin/models/stats` | `days`（1–90，默认 14）、`engine_id` 可选 | `{"ok":true,"days":n,"summary":{},"trend":[],"ranking":[],"logs":[]}`（trend 补 0 值日、ranking 前 8、logs 最近 12） |
| POST | `/api/admin/models/<id>/test` | 见下 | SSE |

模型测试按类型分流（SSE）：

| 模型类型 | 请求体 | 事件 |
| --- | --- | --- |
| `text` / `multimodal` / `vl` | `{"messages":[{"role","content"}],"thinking":0/1}`；messages 须以一条 `user` 结尾，最多取最近 40 条 | `delta`（纯文本）、`reasoning`、`usage`、`notice`、`error`、`done` |
| `embedding` | `{"text":"..."}` | `result`（向量维度与预览）、`done` |
| `image` | `{"prompt":"..."}` | `image`（URL 或 base64）、`done` |

模型停用时直接报「模型已停用，请先启用再测试」。

### 4.6 数字员工

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/employees` | `page`、`keyword`、`status`（只接受 `on`/`off`，其他值 400） | `{"ok":true,"total":n,"list":[...]}`；列表行含 `instructions_preview`，不下发完整正文 |
| POST | `/api/admin/employees` | `{name,instructions,link_files,tools,workspace_path,description,avatar,model_binding,rag_kb_ids,enabled,...}` | 名称 1–64；instructions 与关联 md 至少一项；workspace 目录必须存在；成功返回 `id` |
| GET | `/api/admin/employees/<id>` | — | `{"ok":true,"row":{...},"instructions":"完整正文"}` |
| POST | `/api/admin/employees/<id>` | 同上字段可选 | 停用后同步把选择该助理的用户关联清零 |
| DELETE | `/api/admin/employees/<id>` | — | 默认员工自动让位 |
| POST | `/api/admin/employees/<id>/default` | — | 须启用态 |
| POST | `/api/admin/employees/<id>/toggle` | `{"enabled":0/1}`（缺省取反） | `{"ok":true,"enabled":0/1}` |
| GET | `/api/admin/employees/files` | `path`（相对 workspace 根） | `{"ok":true,"path":"","dirs":[...],"mds":[{"path","name","size"}]}`；越界 404「目录不存在或不在 workspace 范围内」 |

`tools` 只保留 `TOOL_REGISTRY` 内的合法 id；`link_files` 必须是 workspace 内的 `.md` 文件，非法项静默过滤。

### 4.7 采集管理（`/collect` 独立页）

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/collect/sources` | — | `{"ok":true,"list":[{"id","name","description","host","placeholders"}]}`（不返回 headers） |
| POST | `/api/collect/run` | `{"keyword","source_ids":[...],"params":{"<信源id>":{"占位符":"值"}},"page_index","use_llm"}` | `{"ok":true,"results":[...],"new_total":n}`；单源失败不影响其余；关键词 ≤64 字、单次 ≤10 个信源 |
| GET | `/api/collect/items` | `page`、`keyword`、`source_id` | `{"ok":true,"total":n,"page":n,"page_size":12,"list":[...]}` |

### 4.8 数据仓库

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/warehouse` | `page`、`keyword`、`source_id`、`status` | `{"ok":true,"total":n,"list":[...],"page":n,"page_size":20,"done":n,"failed":n,"pending":n}` |
| GET | `/api/admin/warehouse/<id>` | — | `{"ok":true,"data":{...}}`，`ai_keywords`/`images` 已解析为数组 |
| POST | `/api/admin/warehouse/<id>` | `{title,ai_summary,keyword}` | 只改元信息，正文不回改 |
| DELETE | `/api/admin/warehouse/<id>` | — | — |
| POST | `/api/admin/warehouse/batch` | `{"ids":[...]}` | `{"ok":true,"deleted":n}` |
| GET | `/api/admin/warehouse/sources` | — | `{"ok":true,"list":[...],"collected":[...]}` |
| GET | `/api/warehouse/items` | `page`、`keyword`、`source_id`、`only_undone=1` | `{"ok":true,"total":n,"list":[...],"page":n,"page_size":20}` |

深采（SSE，**GET**，参数经 `p` 传 URL 编码 JSON）：

| 路径 | `p` 参数 | 事件 |
| --- | --- | --- |
| `/api/warehouse/deep/one` | `{"item_id":n,"use_ai":true,"use_crawl4ai":true}` | `progress`（阶段/百分比）、`result`、`heartbeat` |
| `/api/warehouse/deep/batch` | `{"ids":[...]}` 或 `{"all_pending":1,"keyword","source_id"}`，另有 `use_ai`/`use_crawl4ai` | `progress`、`batch_start`、`batch_done`、`result`、`heartbeat` |

批量上限见 `warehouse_service.MAX_BATCH_ITEMS`；无符合条件数据时报「没有符合条件的未深采原数据」。

### 4.9 定时任务（成员 E：周期调度 / 自动归档 / 日志清理 / 结果通知）

页面与接口均按 `/admin/tasks` 菜单鉴权；调度引擎「APScheduler 优先、缺失降级 tornado」，`SCHEDULER_ENABLED=0` 时仅可手动触发。

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/tasks` | `page`、`keyword`、`status`（`on`/`off`） | `{"ok":true,"total":n,"list":[...],"scheduler":{...}}` |
| POST | `/api/admin/tasks` | `{name,task_type,description,schedule_type,interval_seconds,cron_expr,notify_on,notify_channel,params,enabled}` | 名称 ≤64 且唯一；`task_type` ∈ {log_cleanup,auto_archive}；cron 须填表达式；成功返回 `id` 并重载调度器 |
| GET | `/api/admin/tasks/<id>` | — | `{"ok":true,"row":{...,"params":对象}}`；无则 404 |
| POST | `/api/admin/tasks/<id>` | 同新增字段 | 重名为他人 → 400；成功后重载调度器 |
| DELETE | `/api/admin/tasks/<id>` | — | 删除配置，执行流水保留；无该任务 → 404 |
| POST | `/api/admin/tasks/<id>/toggle` | `{"enabled":0/1}`（缺省取反） | `{"ok":true,"enabled":0/1}`；重载调度器 |
| POST | `/api/admin/tasks/<id>/run` | — | 线程池执行一次，`{"ok":true,"result":{"ok","status","result","log_id","notify"}}` |
| GET | `/api/admin/task-logs` | `page`、`task_id`、`status` | `{"ok":true,"total":n,"list":[...]}`（流水分页） |
| GET | `/api/admin/scheduler` | — | `{"ok":true,"scheduler":{"engine","apscheduler_available","started","enabled_tasks","notify","note"}}` |
| POST | `/api/admin/scheduler` | `{"action":"reload"/"restart"}` | 重载 / 重启调度器，回 `scheduler` |
| POST | `/api/admin/notify/test` | `{"channel":"email"/"qq"/"both"}` | `{"ok":true,"result":{"channel","results":[...],"ok","degraded"},"status":{...}}`；未配置渠道 → `degraded:true` 不报错 |

内置任务：`log_cleanup`（清理登录审计 / 过期会话 / 任务流水）、`auto_archive`（过期 `messages` 迁移到 `message_archives`）。

### 4.10 数据统计接口（成员 E：为成员 C 的数智大屏 / 报表提供只读聚合）

只读、无副作用；仅需后台身份（不绑定具体菜单）。

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/stats/overview` | — | `{"ok":true,"data":{"users","active_sessions","messages","collect_total","collect_today","warehouse","token","risk","tasks_enabled"}}` |
| GET | `/api/stats/trend` | `days`（1–90，默认 14） | `{"ok":true,"days":n,"trend":[{"date","collect","messages","tokens"}]}`（含 0 值日补齐） |
| GET | `/api/stats/by-source` | `limit`（默认 10） | `{"ok":true,"list":[{"source_id","source_name","count"}]}` |
| GET | `/api/stats/by-risk` | — | `{"ok":true,"list":[{"level","label","count"}]}`（固定四类，缺失补 0） |
| GET | `/api/stats/keywords` | `limit`（默认 12） | `{"ok":true,"list":[{"keyword","count"}]}` |
| GET | `/api/stats/report` | `days`（1–90，默认 14） | `{"ok":true,"days","overview","trend","by_source","by_risk","keywords"}`（大屏一次拉取） |

### 4.11 通知配置（成员 E：邮件 SMTP / QQ 机器人在线配置）

配置存 `system_settings` 表（key 前缀 `notify_`），**数据库优先、`.env` 兜底**；清空某项即回退到运行环境值。
页面按 `/admin/notify` 菜单鉴权；下列两个接口与 `/api/admin/notify/test` 当前仍按 `require_menu('/admin/tasks')` 鉴权。

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/notify/config` | — | `{"ok":true,"config":{key:value,"…"},"fields":[{"key","label","sensitive"}],"status":[…]}`；`sensitive` 字段脱敏不回传明文 |
| POST | `/api/admin/notify/config/save` | `{"config":{"notify_smtp_host":"…", …}}` | 只写入已知字段、忽略未知 key；空值视为清空并回退 `.env`；返回保存后最新 `config` 与 `status` |

### 4.12 会话管理三页（成员 E：归档追溯 / 对话记录 / 登录会话）

术语区分：**会话** = 登录凭证（`user_sessions`）；**对话会话** = 消息分组（`messages.session_id`）；**会话归档** = 迁移后的历史消息（`message_archives`）。三页均 20/页。

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/archives` | `page`、`username`、`session_id`、`role`、`keyword`、`start_at`、`end_at`（按 `origin_created_at` 闭区间） | `{"ok":true,"total","list","total_all",…}`（`message_archives`，含 `origin_id` 可追溯） |
| GET | `/api/admin/messages` | `page`、`username`、`session_id`、`role`、`keyword`（正文 LIKE）、`start_at`、`end_at` | `{"ok":true,"total","list","total_all","page","page_size"}`；**跨用户**（不隔离 username） |
| POST | `/api/admin/messages` | `{"action":"delete_batch","ids":[…]}` | `{"ok":true,"deleted":n}`；空 `ids` 幂等返回 0 |
| GET | `/api/admin/messages/<id>` | — | `{"ok":true,"data":{…,"content"全文}}`；无则 404 `ok:false` |
| DELETE | `/api/admin/messages/<id>` | — | `{"ok":true,"deleted":0/1}` |
| GET | `/api/admin/sessions` | `page`、`username`、`client_ip`、`state`（`active`/`revoked`/`expired`/`all`，非法回退 `active`） | `{"ok":true,"total","list","page","page_size","state","stats":{"active","revoked","expired"}}` |
| POST | `/api/admin/sessions` | `{"action":"revoke","id":n}` | `{"ok":true,"revoked":0/1}`；按 `id` 撤销（不依赖 token 明文），并联动 `kick_user` 踢 WebSocket |
| POST | `/api/admin/sessions` | `{"action":"revoke_username","username":"…"}` | `{"ok":true,"revoked":n,"username":"…"}`；缺 username → 400 |
| POST | `/api/admin/sessions` | `{"action":"purge_expired"}` | `{"ok":true,"removed":n}`；物理删除已撤销与已过期记录 |

安全提示：`/api/admin/messages` 能读到其他用户的对话正文，因此仅后台可用且逐页校菜单权限；普通用户仍只能走 `/api/history` 的 username 隔离视图。

### 4.13 大屏 / 报表 / 预警 / 系统设置（成员 C）

页面：`/admin/dashboard`、`/admin/reports`、`/admin/sentiment`、`/admin/tools`、`/admin/settings`。除 settings 外均走菜单鉴权；settings 另加超管强校验。

| 方法 | 路径 | 参数 / body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/stats/snapshot` | `days`（1–90，默认 14，越界收敛） | `{"ok":true,"snapshot":{generated_at,days,overview,trend,by_source,by_risk,keywords,by_region,risk_trend,latest_risks,high_risks,recent_items}}`——大屏/报表/预警台共用一份聚合；`by_region` 为 `{list:[{name,value}],matched,scanned,max,empty}`（**文本提及口径**，非采集地分布） |
| GET | `/api/stats/stream` | `interval`（5–120 秒，默认 10）、`days` | **SSE**：首帧 `event: bootstrap`，之后每 `interval` 秒 `event: snapshot`（同结构），空闲 `event: heartbeat`；客户端断开退出循环 |
| POST | `/api/dashboard/ask` | `{"question":"最新数据情况"}` | `{"ok":true,"question","intent","answer","chips":[{"label","value","unit"}],"speak","generated_at","suggest"}`；九类意图（news/risk/source/keywords/trend/region/user/token/collect）+ 兜底，**确定性规则直答，不依赖外部大模型**；空问题 400 |
| GET | `/api/admin/tools` | — | `{"ok":true,"tools":[{"id","name","kind","provider","desc","bound_count","bound":[{"id","name"}]}],"employees":[{"id","name","enabled","is_default","tools"}],"total_tools","bound_total"}`；工具来自 `agent_service.TOOL_REGISTRY`，只读 |
| GET | `/api/admin/settings` | — | `{"ok":true,"values","defaults","groups","database"{driver,label,target,ok,error},"mysql"{host,port,user,password(掩码),name,charset,has_password},"drivers","face_engines","env_path"}` |
| POST | `/api/admin/settings` | `{"action":"save","group":"brand\|voice\|security","values":{…}}` | 逐键校验（名称 1–48 字、刷新 5–120 秒、阈值 0.2–0.9 等），返回保存后值；非法 400 中文原因 |
| POST | `/api/admin/settings` | `{"action":"brand","kind":"logo\|favicon","data_uri":"data:image/png;base64,…"}` | `{"ok":true,"url","kind","size","ext"}`；只认真实字节（png/jpg/gif/webp/svg）、≤64 KB、随机文件名落 `static/uploads/brand/`，非图片 400 |
| POST | `/api/admin/settings` | `{"action":"db_test","driver":"sqlite\|mysql","params":{…}}` | `{"ok":true,"driver","version","detail"}`；sqlite 校验目录可写，mysql 真实建连取版本；密码传 `******` 或留空时回退 `.env` 现值 |
| POST | `/api/admin/settings` | `{"action":"db_switch","driver":"sqlite\|mysql","params":{…}}` | 先 `db_test` 再切：更新环境变量 → `config.reload(strict=True)` → `init_db()` 目标库建表 → 写回 `.env`；任一步失败回滚并 400。同驱动切 sqlite 直接 400；目标库为空、历史数据不迁移、切换后需重新登录 |

安全提示：`/api/admin/settings` 能改数据库连接与品牌，故 GET/POST 都要求 `role_code()=="admin"`；图标上传只以真实字节判格式，不信任客户端 MIME/文件名，避免落盘可执行文件。

## 5 WebSocket

| 路径 | 用途 |
| --- | --- |
| `/ws` | 基础通道：心跳 + 回显 + 服务端推送 |
| `/ws/notify` | 服务端事件推送通道（订阅后先收一条 `已订阅通知通道`） |
| `/ws/admin/sentiment` | 舆情预警台：每 3 秒推送 `{"reviews":[{id,title,url,source_name,level,reason,evidence,reviewed_at}]}`（**全量替换**，数据无变化时不推），前端按 level 筛选 |

握手鉴权：`session_token` cookie（或兼容期旧 username cookie），未登录 `close(4401)`；`check_origin` 只放行同源与 CORS 白名单，跨源 `close(4403)`。

协议：

```json
// 客户端 → 服务端
{"type": "ping | pong | echo | notify", "id": "可选", "payload": {}}
// 服务端 → 客户端
{"type": "ready | pong | echo | response | notify | ping", "id": "…", "ok": true, "data": {}}
```

- 心跳：服务端每 `WS_HEARTBEAT_SECONDS`（默认 30s）发 `ping`；超过 2 个周期无 `pong` → `close(4408)`。
- 后台强制下线/改密后，`kick_user` 会以 `close(4409)` 断开该用户全部连接。
- 单条消息上限 256KB，超限 `close(4408, 消息过大)`。
- 非 JSON / 非对象消息回 `{"ok":false,"error":"消息必须是 JSON"}` 等。

## 6 健康检查

`GET /healthz`（匿名，不泄露配置）：

```json
{"ok": true, "db": "sqlite", "version": "v0.12.0"}
```

数据库探活失败：HTTP 503，`ok=false`，`error="数据库不可用"`；详细原因只进服务端日志。

## 7 数据表（接口涉及）

`users`（含 `assistant_employee_id`、`last_login_at`、`failed_count`、`locked_until`、`face_enabled`，成员 D 扩展 `nickname`/`avatar`）、`user_sessions`（`token_hash` 等）、`login_logs`、`user_faces`（`feature` 加密存储）、`messages`（含 `employee_id`/`employee_name`）、`digital_employees`、`model_engines`、`model_token_logs`、`sources`、`collect_items`、`warehouse_data`、`roles`、`menus`、`role_menus`、`scheduled_tasks`（周期任务配置）、`task_logs`（任务执行流水）、`message_archives`（历史会话归档）、`system_settings`（key-value 系统配置，通知参数属成员 E）、`music_tracks`（成员 D 内置曲库，`UNIQUE(title,artist)`）、`qa_reports`（成员 D 问数报告历史，report 存 JSON 串，按用户隔离查询）。

## 8 代码中未实现的接口（任务书要求但当前没有）

以下能力**没有对应路由或实现**，验收时不能按「已实现」口径陈述：

- 任务一：知识仓库 / RAG 检索接口（`digital_employees.rag_kb_ids` 仅预留字段）、工作空间会话管理接口。
  （「工具链路」已由成员 C 补只读页 `/admin/tools` + `/api/admin/tools`：工具注册仍由代码决定，不提供动态注册；「会话管理页」「后台对话管理界面」由成员 E 补齐：`/admin/sessions` + `/admin/messages` + `/admin/archives`。）
- 任务二：**已完成**。数智大屏 `/admin/dashboard`、统计报表 `/admin/reports`、智能舆情 `/admin/sentiment` 由成员 C 交付（配 `/api/stats/snapshot|stream`、`/api/dashboard/ask`、`/ws/admin/sentiment`）；定时任务 / 通知 / 统计聚合由成员 E 交付；用户中心 / 3D 数字人 / 导出 PDF / @音乐 / 智能问数由成员 D 交付。
  唯一未闭合项：地图**真实地理维度**——`collect_items` / `warehouse_data` 无 `region` 字段，当前按「标题/摘要文本提及省份」聚合（页面已标注口径），待采集侧补字段后替换，前端契约不变。
- 任务三：**已完成**。`/admin/settings` + `/api/admin/settings` 支持动态名称/图标、语音与人脸配置、安全参数、`db_test`/`db_switch` 库切换（先测后切、失败回滚）。
  已知限制：切换为进程内热切换（多进程部署需重启）、目标库为空不自动迁移数据、切换后当前会话需重新登录；`system_settings` 在 MySQL 下沿用 `INSERT OR REPLACE` 写法（SQLite 主链路不受影响）。
- 技术栈缺项对应的能力：MCP 接入方式与演示仍待确认（`mcp_search` 工具已在工具页展示，但需确认对应 MCP Server 可跑）、AHLLMProxy 需在答辩材料中明确调用链与证据；**bootstrap / echarts 已由成员 C 本地化并接入真实数据**。

## 9 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-11 | v0.12.0 | 成员 C：新增 4.13（`/api/stats/snapshot\|stream`、`/api/dashboard/ask`、`/api/admin/tools`、`/api/admin/settings` 的 save/brand/db_test/db_switch）；后台页面表补 `/admin/dashboard|reports|sentiment|tools|settings` 五行；WebSocket 表补 `/ws/admin/sentiment`；healthz 版本示例同步 v0.12.0；第 8 节：任务二/任务三移出缺项、任务一移除「工具链路」缺项，剩余为 RAG 与地图 region 字段 |
| 2026-11-10 | 未发布 | 成员 D：3D 数字人页升级为虚拟主播形态——本地 vendor 新增 `GLTFLoader.js` 与 pixiv `three-vrm-girl.glb`（动漫风 VRM，口型 morph + humanoid 骨骼），语音改浏览器原生 Web Speech API（零依赖）；新增 `test_13_avatar_vtuber.py` 资源契约用例；接口路由无变化 |
| 2026-11-10 | 未发布 | 成员 D：前台用户端增强——新增 2.3 用户中心（`/user` + `/api/user/profile\|password\|sessions`）、2.4 导出对话 PDF（`/api/chat/export`，reportlab）、2.5 @音乐（`/api/music/search\|play` + 内置曲库）、2.6 智能问数（`/qa` + `/api/qa/*`）、3D 数字人页（`/avatar`，three.js vendor）；数据表补 `music_tracks`/`qa_reports` 与 `users.nickname/avatar`；第 8 节移除已交付的 4 项缺项 |
| 2026-11-10 | 未发布 | 成员 E：新增通知配置接口（4.11：config 读取/保存）、会话管理三页接口（4.12：archives / messages / sessions）；后台页面表补 4 行；数据表加 `system_settings`；第 8 节移除已交付的「会话管理页」缺项 |
| 2026-11-09 | 未发布 | 成员 E：新增定时任务与通知接口（4.9：任务 CRUD / toggle / run / task-logs / scheduler / notify-test）、数据统计接口（4.10：overview / trend / by-source / by-risk / keywords / report）；数据表补 scheduled_tasks / task_logs / message_archives |
| 2026-11-07 | v0.11.1 | 首次成文：按当前 62 条路由逐条核对；覆盖任务 1–17 已实现接口、Token 会话/人脸/SSE/WS/健康检查；标注 8 类未实现能力 |
