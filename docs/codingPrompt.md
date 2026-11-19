【开发任务】
任务1：
- 参考dist/系统登录页.html，将dist下的组件：bootstrap-5.3.8-dist.zip、fontawesome-free-5.15.4-web.zip、做为需要的依赖组件自行拷贝到static/下用于开发，你需要实现真实的登录、注册功能的更新和对接。
- 预留登录角色，用户（user）/管理员（admin），用户进入到http://host:port/，管理员进入到http://host:port/admin



任务2：
- 参考dist/AI对话页.html 实现template/index.html页面的升级和改造
- 参考任务1的要求完成升级。

任务3：
 
- 通过layui搭建后台admin管理系统的管理界面框架。
- layui官网API文档（https://layui.dev/docs/2/）。
- 采用layui框体组件完成后台管理系统的界面开发。
- 开发模式参考用户侧的模板规则：/template/base.html、index.html等等


任务4：
完成后台管理模块的开发任务。
 
- 1、用户管理：实现用户列表[最后一列为操作列]+新增/删除/更新/分页（20/页）
- 2、角色管理：默认为系统管理员（主要有后台管理权限:http://host:port/admin）+普通用户（主要有前台使用权限:http://host:port/），允许新增、修改（默认管理角色不允许修改）、删除（默认管理角色不允许删除）、列表、分页（20/页）。角色支持与菜单管理中的功能进行关联，实现不同角色不同后台权限访问。
- 3、菜单管理：动态管理系统中的功能模块，包括列表、新增、删除、修改、排序、分页，采用树形菜单管理方式，支持拖动排序。功能列表需要图片、名称、路由、简介等信息。
开发限制：
- 1、界面布局：自上而下：功能区（搜索+批量操作）|列表区|分页区
- 2、选用layui组件完成开发
- 3、参考已有功能代码分层分模块完成开发





任务5：
完成信源管理模块的开发：信源管理指的是通过网络可信的URL+RequestHeaders实现数据的采集和分析，该功能模块只对数据源及规则进行管理，不设计采集任务。采集任务由采集管理模块完成。
 
- 1、实现信源管理的增删改查分页等功能，列表式呈现。
​
- 2、界面风格和效果参考角色管理完成
- 3、分页20/页
- 4、以下为某数据源的规则，供你分析实现
```
URL规格：
https://www.baidu.com/s?ie=utf-8&bsst=1&rsv_dl=news_b_pn&tn=news&cl=2&medium=0&rtt=1&wd={关键字}&pn={分页步长pn=0=第一页，pn=10=第二页}


Request Headers:

accept
text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
accept-encoding
gzip, deflate, br, zstd
accept-language
zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6
cache-control
max-age=0
connection
keep-alive
cookie
__bid_n=193250ddeaa11523f4598e; BDUSS=3BsYXUzVjFaVkwwZlhUQk1MSk1ZMkZUTlhMaGZvbFpDdVMyNFNMWlFIeloxYU5wSVFBQUFBJCQAAAAAAQAAAAEAAAAhas2QZGF2aWRhbmRsdWN5MQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANlIfGnZSHxpV; BDUSS_BFESS=3BsYXUzVjFaVkwwZlhUQk1MSk1ZMkZUTlhMaGZvbFpDdVMyNFNMWlFIeloxYU5wSVFBQUFBJCQAAAAAAQAAAAEAAAAhas2QZGF2aWRhbmRsdWN5MQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANlIfGnZSHxpV; BAIDUID_BFESS=EF233FB1FCD97F556C2A3AF8110205BA:FG=1; BIDUPSID=EF233FB1FCD97F556C2A3AF8110205BA; PSTM=1793929070; BDRCVFR[BIVAaPonX6T]=-_EV5wtlMr0mh-8uz4WUvY; H_PS_PSSID=63145_74786_74972_75971_76062_76209_76235_76333_76280_76396_76435_76515_76512_76488_76559_76552_76476_76461_76338_76575_76570_76610_76612_76616_76618_76622_76624_76605_76602_76598_76631_76729_76726_76723_76765_76777; BD_UPN=12314753; BA_HECTOR=0gaka5a58l8g24agakah0184a4a4251leqbqf28; ZFY=VLrV4yF65by1bhEqkFF379KnHz56RDeB:Bgp0mdu:AMXU:C; H_WISE_SIDS=63145_74786_74972_75971_76062_76209_76235_76333_76280_76396_76435_76515_76512_76488_76559_76552_76476_76461_76338_76575_76570_76610_76612_76616_76618_76622_76624_76605_76602_76598_76631_76729_76726_76723_76765_76777; delPer=0; BD_CK_SAM=1; PSINO=7; arialoadData=false; BDRCVFR[C0p6oIjvx-c]=mk3SLVN4HKm; BDSVRTM=1016
host
www.baidu.com
referer
https://www.baidu.com/s?ie=utf-8&bsst=1&rsv_dl=news_b_pn&tn=news&cl=2&medium=0&rtt=1&wd=%E5%9B%9B%E5%B7%9D&pn=10
sec-ch-ua
"Not:A-Brand";v="8", "Chromium";v="156", "Microsoft Edge";v="156"
sec-ch-ua-mobile
?0
sec-ch-ua-platform
"Windows"
sec-fetch-dest
document
sec-fetch-mode
navigate
sec-fetch-site
same-origin
sec-fetch-user
?1
upgrade-insecure-requests
1
user-agent
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0


```
- 5、基于前面的数据+URL规则实现信源管理，在新增和编辑时，针对Request Headers 支持RAW解析入库。
​
- 6、该信源是用于后续模块**采集管理**时，作为采集源实现数据的动态采集（该需求在后续任务中实现，本次任务只理解）


任务 6：
完成采集管理，该模块是一个特定的单独设计的采集主页，页面规格如下：

1. 页面为独立主页，与当前系统整合，不采用 layui 组件实现。
2. 页面自上页下分为：关键词输入区、信源采集选择区（如果信源涉及参数配置，该区需要同步出现可视化的参数配置功能）、采集数据列表区（以橱窗列表模式呈现，1 行 / 3 列，12 条 / 页，橱窗列表封面 + 标题 + 时间组成）
3. 风格要求炫酷、体现科技感



任务7：
完成数据仓库模块的开发：该模块为采集管理采集到的原数据存储仓库，数据入库到sqlite相关表中（无表则创建）。需要实现以下功能：
 
- 1、与信源管理一致，实现数据的更新/查看/删除/分页等操作。
- 2、开发深度采集功能，分为单一采集(深采)和批量深采，允许指定原数据的深度数据采集和批量的多条数据采集。
- 3、采集过程中，不管是单一还是批量，需要有一个采集过程执行面板，可以实时直观的查看采集进度、分析过程、采集结果等信息。
- 4、深度采集需要通过AI模型引擎+Crawl4AI完成。其中AI模型引擎为功能模块模型引擎管理模块中的默认模型，如果需要用到AI大模型服务，则调用该模块中的默认模型完成。
- 5、深度采集需要采集详细的正文，并入库到数据为指定表。
- 6、分页：20/页。其他规范与用户管理等模块相同。


任务8：
完成模型引擎管理模块：该模块为大模型及服务管理模块，需要实现以下功能：
 
- 1、实现模型的新增/修改/删除/对话测试（类似chatgpl对话测试，含思维开关测试）。
- 2、模型列表采用橱窗列表模式，一行2列，4条页。
- 3、模型服务支持openai接口范式接入管理。
- 4、模型类型支持文本类、多模态类、图片类、VL类、嵌入模型类。（对齐主流模型Maas服务分类）
- 5、橱窗列表需要单独设计显示风格和效果，快捷操作方便，列表显示大气简约。
- 6、以下为文本类模型，供你新建默认模型和测试：
```
api_url:http://127.0.0.1:11435/v1
api_key:ahk_cded9ad42e3b38d800a7bbb426d47bac8a62b3298bf4c4f6
model_id:smart

```
任务8.1：
 
- 1、模型管理需要增加模型token统计功能，图形化呈现。
- 2、token需要直观反馈到模型列表的卡片中。


任务9：
开发数字员工模块，该模块是以agentica为基础的，智能体管理模块，需要将agent_service.py中的 旅行规划师 抽离到数据库中统一管理，需要支持智能体的几大配置：instructions的配置（提示词配置）、工具链路配置（tools）、agentica工作空间配置与管理（workspace目录下的所有内容及解析）
 
- 1、该模块需要实现新增、删除、修改、启停开关、分页等功能。
- 2、列表采用橱窗列表模式，一行4列，参考模型引擎模块的列表实现。
- 3、分页1页12条数据。
- 4、采用layui组件实现。
- 5、数字员的工具链路配置为动态配置（从工具管理模块获得，当前未实现，预留即可，后续任务实现。）
- 6、数字员工需要配置Rag知识库(需要从RAG管理模块中获得，当前未实现，)
- 7、数字员工的instructions的配置需要实现markdown可视化编辑（富文本编辑器/markdown编辑器支持），允许将多个md文件关联给instructions。

 
任务10：
完成数字员工与前台用户侧的关联，新增数字助理的选择功能，在输入区实现。


================================================================================
成员 A：后端框架 & 权限 / 登录模块 —— 待完成任务（盘点基准 v0.11.1）
================================================================================
盘点说明：任务1～10 已由各成员落地（见 docs/CHANGELOG.md、docs/architecture.md）。
本段只登记「成员 A 负责范围内仍未完成 / 只做了一半」的部分，任务编号顺延自 任务11。
状态：**待人类负责人确认后再执行**；确认前不得改动业务代码，执行时遵守 docs/agent_roles.md
（人类决策发布、测试放 tests/、不 push/commit）。
依赖基线：app/controllers/base.py、app/controllers/auth.py、app/models/user.py、app/models/db.py。
建议执行顺序：任务13（配置中心，其余任务的开关都从这里取）→ 任务11（会话）→ 任务14（双库底座）
→ 任务12（人脸，新表一开始就双库兼容）→ 任务15（异常/CORS）→ 任务16（SSE/WS）→ 任务17（工程收尾，可裁剪）。

已确认决策（人类负责人 2026-11-07）：
- 人脸识别后端：**采用真实精度后端**（InsightFace 系模型特征 + onnxruntime 推理），
  内置降级算法仅作为环境不可用时的兜底，且必须在响应与页面显式标注「降级模式、精度受限」。
- 兼容策略：**保留** 旧 username/role 签名 cookie 的兼容回退期，token 会话上线不打断存量登录态。
- 多库运行策略：**默认仍以 SQLite 运行**（DB_DRIVER=sqlite，database/govagentos.db），
  MySQL 仅作为双库适配的联调验证目标，不改变默认启动方式。
  MySQL 联调实例已由人类提供：phpstudy_pro 启动的本机 **MySQL 5.7.26**（127.0.0.1:3306，
  账号口令由人类口头提供，**严禁写入 docs / 代码 / .env 仓库**，只允许写进本机 .env 或测试时环境变量）。
  该实例已有 bookstore_db / demo8_db / student / testdb 等他人库，**不得读写或删除**，
  联调只使用专用库 `govagentos`（不存在时由初始化脚本 CREATE DATABASE 创建）。


--------------------------------------------------------------------------------
任务11：鉴权会话升级（Token 会话 + 统一鉴权中间件 + 登录安全）
--------------------------------------------------------------------------------
问题现状（已核对代码）：
- base.py 的 get_current_user/get_current_role 只读签名 cookie，登录态无法主动失效；
- 接口鉴权散落：页面用 @tornado.web.authenticated，/api 由各 Handler 手写 current_user 判断，
  未登录的 /api/admin/* 会被 302 重定向到 /auth/login，前端 fetch 拿到 HTML 导致 JSON 解析报错；
- 无会话过期、无多端管理、无登录失败锁定与登录审计。

开发要求：
1. 新增 app/models/session.py（SessionRepository），建表 user_sessions（init_db 幂等建表）：
   token_hash（唯一）、username、role、client_ip、user_agent、created_at、last_seen_at、
   expires_at、revoked。**只存 token 的 SHA256 哈希，明文不得入库、不得写日志。**
2. 登录成功签发会话 token（secrets.token_urlsafe(32)），写入签名 cookie（HttpOnly、SameSite=Lax、
   path=/），有效期由 .env 配置（SESSION_TTL_HOURS，默认 12）；访问时滑动续期 last_seen_at。
3. BaseHandler 改造：
   - get_current_user()/get_current_role() 改为「token 会话优先，旧 username/role cookie 兼容回退」，
     存量登录态不被打断；
   - 新增 get_session()；prepare() 统一做会话校验、过期清理与续期；
   - 新增 session_required 装饰器：页面未登录 → 302 /auth/login?next=<原路径>；
     /api/* 未登录 → 401 JSON {"ok": false, "error": "未登录"}，**不得重定向**；
   - 保留 admin_required / backend_required 现有语义与报错文案（现有测试不许回归）。
4. 登出：LogoutHandler 撤销会话（revoked=1）并清除 cookie；保持 POST（防 CSRF）。
5. 登录安全：
   - users 幂等补列 last_login_at、failed_count、locked_until；
   - 连续失败 N 次（.env LOGIN_MAX_FAILS，默认 5）锁定 M 分钟（LOGIN_LOCK_MINUTES，默认 10），
     成功后清零；锁定期间登录统一返回「账号或密码错误，请稍后再试」（不暴露账号存在性）；
   - 新增 login_logs 表记录 username/ip/UA/结果/时间，后台可查（仅超管或用户管理权限）。
6. 后台联动：新增 POST /api/admin/users/(\d+)/logout（强制下线该用户全部会话）；
   修改密码或变更角色时自动撤销该用户全部会话；用户删除时清理其会话。

交付物：app/models/session.py、login_logs 表、base.py/auth.py/admin.py 改造、
tests/smoke_auth.py。

验收（tests/smoke_auth.py 必须覆盖）：
token 签发→访问→登出→失效；会话过期；强制下线；多端登录互不影响；
/api 未登录 401 JSON 且 Content-Type 为 application/json；页面未登录 302；
旧 username/role cookie 兼容；连续失败锁定与解锁；改密后旧会话失效；
越权 403 回归。现有 8 套 smoke_*.py 全部通过。

限制/说明：不引入 Redis，会话落库（任务14 双库需兼容）；token 明文只在响应侧存在一次。
人类已确认**保留**旧 username/role cookie 兼容回退期：新会话优先，旧 cookie 仍可用，
兼容期长度在 docs 记录，后续版本再决定是否移除。


--------------------------------------------------------------------------------
任务12：人脸登录与人脸数据管理接口
--------------------------------------------------------------------------------
问题现状：全仓库无任何人脸相关代码、数据表或依赖（已检索 face/人脸/opencv/dlib 零命中）。

开发要求：
1. 数据模型（init_db 幂等建表/补列）：
   - users 补列 face_enabled INTEGER NOT NULL DEFAULT 0；
   - 新增 user_faces（id、username、face_label、feature TEXT、feature_algo、quality REAL、
     enabled、created_at、updated_at，UNIQUE(username, face_label)）。
   - 特征向量按需加密存储（venv 已含 cryptography），接口一律不返回原始特征。
2. 新增 app/services/face_service.py，抽象 FaceEngine：
   - extract(image_bytes) -> {vector, quality, engine}；compare(vec_a, vec_b) -> 0~1 相似度；
   - **默认后端为真实精度后端（人类已确认）**：onnxruntime 推理 InsightFace 系 ONNX 模型
     （SCRFD 人脸检测 + 5 点对齐 + ArcFace 512 维特征，余弦相似度），模型文件放
     database/models/face/（gitignore，不入库），启动时校验模型存在与校验和；
   - 为规避 insightface 包在 Windows + Python 3.12 下的 C++ 编译风险，**以 onnxruntime +
     opencv-python 直接推理 ONNX 模型为准**（两者在 py3.12 均有现成 wheel，已实测可安装）；
     如人类坚持使用 insightface pip 包，需先确认本机具备 MSVC 编译环境，并允许安装；
   - FACE_ENGINE=onnx|fallback|auto（默认 onnx）：onnx 后端不可用时 auto 才回退 fallback，
     回退时接口返回 engine="fallback" 且前端明确提示精度受限，**不得静默降级**；
   - 阈值走 .env FACE_THRESHOLD（ArcFace 余弦相似度默认 0.35，按模型实测调整并在文档记录）。
3. 内置降级后端（仅兜底，不参与默认链路，只用 venv 已有的 Pillow + numpy）：
   Pillow 解码 → 中心人脸区域裁剪 → 灰度归一化 → 多尺度灰度直方图 + 梯度方向特征 → 余弦相似度。
   **必须在代码注释与 docs 中明确标注局限性**：仅供演示，强光/遮挡/多人/侧脸场景不可靠，
   不能用于真实身份认证。
4. 输入校验：支持 multipart（img/file）与 base64 dataURL；仅 jpg/png/webp；≤ 5MB；
   服务端用 Pillow verify + 重新编码，拒绝伪造扩展名与超大图（防解码炸弹）；
   临时文件只落内存或系统临时目录，不进入 static/。
5. 前台接口（登录后，@session_required）：
   - GET  /api/face/status        本账号人脸录入状态与张数；
   - POST /api/face/enroll        录入/追加人脸（face_label 可空，默认 default）；
   - POST /api/face/verify        1:1 校验（本人已登录场景）；
   - DELETE /api/face/(\d+)       删除本人指定人脸记录（仅本人）。
6. 匿名登录接口：POST /auth/face/login
   - 入参 username + image（携带 username 走 1:1；username 为空走 1:N 识别）；
   - 阈值通过后签发与密码登录**同一套 token 会话**（复用任务11），角色分流规则一致（admin→/admin，user→/ 或 next）；
   - 必须校验 XSRF；识别失败复用任务11 的失败计数与锁定；未启用 face_enabled 的账号直接拒绝。
7. 后台接口与页面（权限沿用用户管理菜单 URL_USERS，@authenticated + @backend_required + require_menu）：
   - GET/POST/DELETE /api/admin/users/(\d+)/faces：查看录入情况、代录、清空；
   - 用户管理列表新增「人脸」列（未录入 / 已录入 n 张 / 已启用 / 已停用）+ 操作「录入 / 重置 / 启停」；
   - 停用或删除用户、重置密码时同步清理/停用人脸数据。
8. 登录页新增「人脸登录」入口：浏览器 getUserMedia 取流 + canvas 截帧转 base64 提交；
   非安全上下文（非 localhost/HTTPS）或无摄像头时给出明确提示并回落密码登录，
   不得让页面白屏或抛未捕获异常。

交付物：app/services/face_service.py、app/models/face.py、app/controllers/face.py、
login.html / admin/users.html / admin.js 改造、tests/smoke_face.py（可选 tests/verify_face_ui.py）。

验收：录入→1:1 通过/低于阈值拒绝→1:N 命中→启停→删除→未登录 401→无权限 403→
非法格式/超大图拒绝→失败锁定联动→接口响应中不含特征向量与图片；密码登录链路回归通过。

限制/说明：人类已确认采用真实精度后端；实施前需安装 onnxruntime + opencv-python 并下载
InsightFace 系 ONNX 模型（SCRFD + ArcFace），模型与特征数据均不入库、不进 static/；
内置降级算法只做兜底并显式标注。人脸数据属敏感个人信息，需在 docs 注明采集范围与删除途径。


--------------------------------------------------------------------------------
任务13：.env 配置中心化（统一配置读取）
--------------------------------------------------------------------------------
问题现状：只有 services（agent_service / collect_service / warehouse_service）各自
load_dotenv()；application.py 里 cookie_secret 写死 "govagentos-secret-key"、debug=True 写死；
app.py 端口 10086 写死；.env 仅 3 个模型键，无 DB/会话/人脸/CORS 等配置项，也无 .env.example。

开发要求：
1. 新增 app/config.py：进程内只 load_dotenv() 一次，集中读取并做类型转换，暴露只读常量/函数：
   APP_HOST、APP_PORT、DEBUG、COOKIE_SECRET、XSRF_ENABLED、LOG_LEVEL、
   DB_DRIVER、DB_PATH、DB_HOST、DB_PORT、DB_USER、DB_PASSWORD、DB_NAME、DB_CHARSET、
   SESSION_TTL_HOURS、LOGIN_MAX_FAILS、LOGIN_LOCK_MINUTES、
   FACE_ENGINE、FACE_THRESHOLD、CORS_ALLOW_ORIGINS。
2. 去掉硬编码：
   - application.py：cookie_secret 必须来自 COOKIE_SECRET；缺失或为默认示例值时启动即报错并给出中文修复提示；
   - app.py：端口改读 APP_PORT，debug/cookie_secret/xsrf 全部走 config；
   - 三个 service 的 load_dotenv() 改为 import app.config，不再各自加载、不再各自 os.getenv 散读。
3. 提供仓库根 .env.example（不含任何密钥，可入库）：逐项中文注释默认值与取值范围；
   .gitignore 增加 !.env.example（保持 .env 仍不入库）。
4. 启动期校验：必填项缺失/非法（端口非数字、DB_DRIVER 非 sqlite|mysql、阈值越界）时抛出
   可读的中文错误，禁止带病启动；非必填项给默认值。
5. 文档同步：architecture.md 环境依赖段、framework.md 目录说明补 config.py 与 .env.example。

交付物：app/config.py、.env.example、app.py / application.py / services 改动、tests/smoke_config.py。

验收：默认值生效；.env 覆盖生效；删除必填项启动失败且提示可读；
COOKIE_SECRET 生效（更换后旧 cookie 失效）；APP_PORT 生效；现有 smoke 全部通过。


--------------------------------------------------------------------------------
任务14：多数据库适配（SQLite / MySQL 切换，一套 model 兼容双库）
--------------------------------------------------------------------------------
问题现状：10 个 Repository（user/role/menu/message/source/collect/warehouse/
model_engine/digital_employee/token_stats）全部 import sqlite3；db.py 使用 PRAGMA table_info、
datetime('now','localtime')、INSERT OR IGNORE、AUTOINCREMENT 等 SQLite 专属写法，
上层 Models 还直接捕获 sqlite3.IntegrityError，无法切换到 MySQL。

开发要求：
1. app/models/db.py 重构为连接层抽象（保持 get_connection() 对外名字不变）：
   - DB_DRIVER=sqlite|mysql 决定方言；返回统一 Connection 包装，提供
     execute / executemany / fetchone / fetchall / commit / rollback / close / 上下文管理器；
   - 占位符：Repository 继续写 ?，由包装层按方言转成 %s（只转换 SQL 文本中的占位符，
     不触碰字符串字面量；现有 SQL 已全参数化，不得改成字符串拼接）；
   - 行对象统一 dict-like：row["col"]、dict(row)、row[0] 三种用法都要兼容
     （SQLite 用 sqlite3.Row，MySQL 用 pymysql DictCursor + 轻量包装）；
   - 方言能力函数：insert_or_ignore(sql)、now_sql()、table_columns(table)、last_insert_id(cur)；
   - 统一异常：导出 db.IntegrityError / db.OperationalError，把 sqlite3 与 pymysql 的异常归一，
     各 Repository 改为捕获统一异常（去掉 import sqlite3），对外行为不变。
2. DDL 双库化：init_db() 拆出 schema_sqlite / schema_mysql（或统一 DDL + 方言转换）。
   **已实测联调实例为 MySQL 5.7.26，以下约束按 5.7 落地（不得按 8.0 假设）：**
   - INTEGER PRIMARY KEY AUTOINCREMENT → INT PRIMARY KEY AUTO_INCREMENT；
   - **5.7 的 TEXT/BLOB 列不允许 DEFAULT**：现有 `TEXT NOT NULL DEFAULT ''` 一律改为
     `VARCHAR(255|512) NOT NULL DEFAULT ''`（长正文列如 content_md/content_text/instructions
     改为 `TEXT NULL` 或 `MEDIUMTEXT NULL`，并在 Repository 写入时用 `or ""` 兜底），
     `feature` 等 JSON 字段用 `TEXT NULL`；
   - 服务端默认字符集是 utf8：建库必须 `CREATE DATABASE govagentos DEFAULT CHARSET utf8mb4
     COLLATE utf8mb4_general_ci`，连接必须 `charset=utf8mb4`（否则四字节字符/emoji 报
     Incorrect string value）；实例 `row_format=dynamic`、`innodb_large_prefix=1`，
     utf8mb4 唯一索引 3072 字节内可用（username 等 UNIQUE 列长度需核算）；
   - INSERT OR IGNORE → MySQL INSERT IGNORE；NOW() 替代 datetime('now','localtime')；
   - CREATE INDEX IF NOT EXISTS（MySQL 全版本不支持）改为先查 information_schema.statistics 再建；
   - 补列：PRAGMA table_info → information_schema.columns，保持幂等；
   - `lower_case_table_names=1`：表名统一小写，避免大小写差异引发的问题；
   - sql_mode 含 ONLY_FULL_GROUP_BY 与 STRICT_TRANS_TABLES：token 统计等聚合 SQL 的
     GROUP BY 需完整；超长/非法值会直接报错（不要指望静默截断），参数校验要前置；
   - 种子数据（角色/菜单/默认模型/默认数字员工）双库幂等，不得重复插入。
3. 连接配置：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/DB_CHARSET（默认 utf8mb4）；
   MySQL 连接失败、库不存在时给出明确中文提示；autocommit=False 语义与 SQLite 保持一致；
   不在请求线程间共享连接（沿用现有「每次取连接」策略）。
4. 依赖：新增 requirements.txt，列出运行期依赖并标注 pymysql 为多库可选依赖；
   DB_DRIVER=mysql 且未安装 pymysql 时，启动直接报错并提示安装命令，**不得静默回退 SQLite**。
5. 逐条校验方言差异点：分页 LIMIT ? OFFSET ?、ORDER BY、COUNT(*)、UNIQUE 约束冲突、
   批量 executemany、warehouse 的 UPSERT（改用 MySQL ON DUPLICATE KEY UPDATE）、
   menu 的拖动排序批量更新、token 统计聚合（含日期函数按方言处理）。
6. `_repair_messages_unique_username` 等 SQLite 修复逻辑仅 SQLite 生效；
   测试里直接写 PRAGMA 的诊断代码改为调用 db.table_columns()。

交付物：db.py 重构（含 sqlite/mysql 方言实现）、10 个 Repository 适配、requirements.txt、
init_db 双库 DDL、tests/smoke_db.py、tests/smoke_db_mysql.py。

验收：
- 同一套 Repository 用例在 SQLite 上全部通过，现有 8 套 smoke_*.py 与 UI 复验零回归；
- 方言单测：占位符转换、now_sql、insert_or_ignore、table_columns、异常归一、last_insert_id；
- 检测到本机可用 MySQL（phpstudy_pro 5.7.26，3306）时，smoke_db_mysql.py 在专用库 `govagentos`
  上完成建库→建表→种子→CRUD→分页→UPSERT→聚合统计全链路，且**不得触碰同实例上的其他数据库**；
  连接不可用（服务未启动/凭据缺失）时打印 SKIP 原因并以 0 退出（不阻塞日常 SQLite 回归）。

限制/说明：不引入 ORM（保持 Repository + 原生 SQL 的既有风格）。
运行期默认仍是 SQLite（DB_DRIVER=sqlite，database/govagentos.db 保持不变，不要求日常开启 MySQL）；
MySQL 只用于验证「一套 model 兼容双库」的适配正确性，联调实例为 phpstudy_pro 启动的
MySQL 5.7.26（127.0.0.1:3306，凭据只进本机 .env / 测试环境变量，不入库不入文档）。
mysql 联调前需确认 phpstudy_pro 的 MySQL 已启动；测试脚本对既有库（bookstore_db 等）零操作。


--------------------------------------------------------------------------------
任务15：统一异常处理 + 跨域（CORS）与安全响应头
--------------------------------------------------------------------------------
问题现状：全仓库无 write_error / log_exception；Repository 异常直接冒泡成 Tornado 500 HTML
（前端 fetch 解析 JSON 失败）；无任何 CORS 配置；无安全响应头。

开发要求：
1. 新增 app/controllers/errors.py：
   - APIError(status, code, message) 业务异常；
   - BaseHandler.write_error 统一出口：页面请求渲染 templates/error.html（状态码 + 中文文案 + 返回按钮），
     /api/* 或 Accept: application/json 的请求返回 JSON
     {"ok": false, "error": "...", "code": "...", "request_id": "..."}；
   - 已知异常映射：IntegrityError→409、参数/校验→400、鉴权→401、越权→403、NotFound→404、
     超时→504、其余→500；500 文案固定，**不得泄露 SQL、文件路径、堆栈、密钥**；
   - log_exception：记录 request_id、方法、路径、用户名、状态码、耗时；DEBUG=True 时额外打印 traceback。
2. request_id：prepare() 生成（优先复用请求头 X-Request-Id），写入响应头与错误体，贯穿日志。
3. 存量收敛策略（避免大改）：先让 BaseHandler.write_error 兜住全部异常；再把
   controllers 里已有的 try/except 逐模块改为抛 APIError / 调用 fail()；
   Repository/Service 抛业务异常时统一由 Controllers 转换，Model 层不 import tornado。
4. CORS（.env CORS_ALLOW_ORIGINS，逗号分隔，默认空 = 不放开）：
   - 命中白名单时回精确 Origin（禁止 "*" 与 allow-credentials 同时出现）+ Vary: Origin；
   - Access-Control-Allow-Methods / Allow-Headers（含 X-Xsrftoken、Content-Type、X-Request-Id）、Max-Age；
   - OPTIONS 预检由 BaseHandler.options() 统一 204 结束，不被 XSRF 拦截；
   - 未命中白名单不下发任何 CORS 头（浏览器侧自然拦截）。
5. 安全响应头（set_default_headers）：X-Content-Type-Options: nosniff、
   X-Frame-Options: SAMEORIGIN、Referrer-Policy: same-origin。
6. 404/405 也要走统一出口（JSON/页面两种形态），保持 layui 后台与前台体验一致。

交付物：app/controllers/errors.py、base.py 改造、templates/error.html、tests/smoke_errors.py。

验收：访问不存在路径（页面/接口两种）返回 404 且形态正确；未授权 XSRF 请求 400/403 可读；
白名单内 Origin 正常、名单外无 CORS 头；OPTIONS 预检 204；request_id 往返一致；
故意触发 500 时响应不含 traceback / 绝对路径；现有 smoke 全部通过。


--------------------------------------------------------------------------------
任务16：SSE 基础封装 + WebSocket 基础通道封装
--------------------------------------------------------------------------------
问题现状：base.py 只有 sse(event, data) 拼字符串；SSE 响应头、逐块 flush、异常收尾、
客户端断连处理在 chat.py / model_engine.py / warehouse.py 各写一遍且写法不一致
（warehouse 用 asyncio.Queue 桥接线程池，其他两处直接 async for）；
全仓库无 WebSocket 任何实现。

开发要求：
1. SSE：新增 app/controllers/sse.py，提供 SSEHandler / SSEMixin：
   - start_sse()：统一写 text/event-stream、Cache-Control: no-cache、Connection: keep-alive、
     X-Accel-Buffering: no；
   - send_event(event, data)：JSON 序列化 + 换行转义（防止事件被注入换行截断）；
   - heartbeat()：每 N 秒（.env SSE_HEARTBEAT_SECONDS，默认 15）发送 ": ping"；
   - close_sse()：幂等结束；客户端断开（stream closed / CancelledError）时静默清理，不写日志噪音；
   - bridge：run_in_executor + asyncio.Queue 的通用「线程池进度 → SSE」桥接工具（抽取 warehouse 现有模式），
     统一处理超时、取消、异常转 error 事件后补 done。
2. 改造现有 SSE 端点复用封装：chat.py、model_engine.py、warehouse.py（collect 若适用一并收拢）。
   **事件名与载荷必须完全兼容**：assistant/delta/tool/reasoning/done/error、progress/result/batch_done 不变，
   现有前端（index.html / models.js / warehouse.html / admin.js）零改动即可工作。
3. WebSocket：新增 app/controllers/ws.py → BaseWebSocketHandler(tornado.websocket.WebSocketHandler)：
   - 握手鉴权复用任务11 会话（未登录 close(4401)，禁止匿名连接）；
   - check_origin 白名单校验（复用 CORS 白名单/同源），跨站 Origin 拒绝；
   - 统一协议：客户端 {"type": ..., "id": ..., "payload": ...}，
     服务端 {"type": ..., "id": ..., "ok": true, "data": ...} / {"ok": false, "error": ...}；
   - 心跳：服务端定期 ping + 客户端 pong，30s 无响应断开并清理；
   - 连接注册表（username → set[连接]），提供 push_to_user / broadcast / kick_user（与任务11 强制下线联动）；
   - 断开/异常统一清理，避免连接泄漏。
4. 预留通道端点：
   - /ws：握手 + 心跳 + 回显（echo）演示；
   - /ws/notify：服务端事件推送通道，供后续后台长任务进度迁移；
   本次只做「基础通道 + 演示端点」，不替换现有 SSE 业务链路。
5. 路由登记到 application.py，并在 architecture.md 路由表与 framework.md 目录树补记。

交付物：app/controllers/sse.py、app/controllers/ws.py、三个 SSE 端点改造、tests/smoke_stream.py。

验收：SSE 响应头正确、事件名回归、心跳可观测、断连后无异常堆积；
WS 未登录拒绝、Origin 非白名单拒绝、协议往返、心跳超时断开、多连接广播、kick_user 生效；
chat / models / warehouse 三套冒烟与 UI 复验全部通过。


--------------------------------------------------------------------------------
任务17（建议，可裁剪）：工程基线补强
--------------------------------------------------------------------------------
问题现状：无 requirements.txt；无健康检查端点；app.py 仅 print 启动信息，无日志配置；
debug=True 常开导致生产暴露调试页。

开发要求：
1. requirements.txt：按 venv 实际版本固化（tornado/agentica/python-dotenv/requests/beautifulsoup4/
   crawl4ai/playwright/pillow/numpy 等），pymysql、insightface 标注为可选并写明用途。
2. 新增 GET /healthz：返回 {"ok": true, "db": "sqlite|mysql", "version": <docs/VERSION 内容>}，
   不要求登录、不泄露配置；DB 探活失败返回 503。
3. app.py：按 .env DEBUG 决定 debug 与自动重载；启动日志用 logging（级别 LOG_LEVEL），
   打印监听地址、DB 驱动、版本号，不再用裸 print。
4. 启动脚本/说明：README 或 docs 补「venv 创建 → 安装依赖 → 配置 .env → 启动 → 跑测试」最短路径。

验收：/healthz 可用；缺依赖时有可读报错；DEBUG=0 时调试页不可用；
启动日志包含端口/驱动/版本；docs 步骤可被新成员一次跑通。

--------------------------------------------------------------------------------
任务18：登录后自助人脸录入入口（前台「人脸设置」）
--------------------------------------------------------------------------------
问题现状：人脸录入入口只有两处 —— ① 后台「用户管理」→「人脸」代录（需用户管理权限）；
② 登录页只有「人脸登录」页签（用于登录，不能录入）。普通用户登录后在前台（index.html）
找不到任何注册人脸的地方，只能让管理员代录，与「用户自助录入」的产品预期不符。

开发要求：
1. 前台侧栏底部新增「人脸」按钮（所有登录用户可见，与「后台」「退出」同排），
   点击打开「人脸设置」弹层；不跳转页面、不中断当前对话、不丢草稿。
2. 弹层功能：
   - 摄像头预览（getUserMedia，user 前置优先）；非安全上下文（http 且非 localhost）/无设备/
     拒绝授权时给出**明确文案**并自动切到「上传本地照片」通道，不允许静默失败；
   - 拍照 / 重拍 / 上传照片（≤5MB，仅 jpg/png/webp），录入前显示取景提示（正脸居中、光线均匀）；
   - 录入结果：质量分、引擎名、是否降级（real/degraded/reason/threshold），与后台代录口径一致；
   - 已录入列表：编号、标签、质量、引擎、录入时间、启用状态，支持单张删除；
   - 「人脸登录」总开关：本人开启/关闭，**只改开关不删数据**；
   - 降级模式醒目提示（精度受限、仅供演示），真实引擎时显示引擎与阈值。
3. 新增 POST /api/face/toggle：本人开启/关闭人脸登录；无已启用记录时拒绝开启并提示先录入；
   关闭后保留特征数据，随时可再开。
4. 复用既有接口：GET /api/face/status、POST /api/face/enroll、DELETE /api/face/<id>；
   图片仅在内存中提取特征、不入 static/、接口绝不回传特征向量；写操作必须带 X-Xsrftoken；
   未登录/会话失效统一走任务15 的 401 JSON 流程（不返回登录页 HTML）。
5. 样式沿用 layui + 现有 css 变量风格；1280×720 与 375 宽下弹层不溢出；
   键盘可达（Esc 关闭、按钮可 Tab 聚焦、焦点可见）。

交付物：app/static/js/face.js、app/static/css/face.css、templates/index.html（入口 + 弹层）、
app/controllers/face.py（FaceToggleApiHandler）、app/application.py（路由）、
tests/smoke_face.py 增补、tests/verify_face_ui.py（Playwright UI 复验）。

验收：登录后在当前页完成「打开弹层 → 拍照/上传 → 录入成功 → 列表出现 → 关闭开关 → 删除」闭环；
降级模式有醒目提示且不误导；普通用户（无后台权限）也能自助录入；
smoke_face 原有点位不回归，UI 复验通过。

================================================================================
说明：以上任务 11～18 为成员 A 范围内的待完成项登记，需求取舍与优先级由人类负责人确认；
      确认后按 agent_roles.md 工作流执行（阅读资料 → 计划 → 确认 → 编码 → tests 自测 → 汇报）。

================================================================================
执行记录（2026-11-07，任务11～18 已按顺序落地，未提交/未打 Tag，等待人类负责人验收）
================================================================================
13 配置中心     完成  app/config.py + .env.example + .gitignore + app.py/application.py/services 改造
                      tests/smoke_config.py 31/31
11 Token 会话   完成  models/session.py + users 补列 + user_sessions/login_logs + base.py 中间件
                      + auth.py 登录/登出 + 强制下线/登录审计接口；tests/smoke_auth.py 35/35
14 多库适配     完成  db.py 连接层抽象（双方言 + 自动 DDL 翻译 + 异常归一）+ 10 个 Repository 去 sqlite3
                      + requirements.txt；tests/smoke_db.py 64/64、tests/smoke_db_mysql.py 44/44（MySQL 5.7.26 实测）
12 人脸登录     完成  models/face.py + services/face_service.py + controllers/face.py + 登录页摄像头入口
                      + 用户管理「人脸」列与弹层；tests/smoke_face.py 32/32
                      （真实引擎需 onnxruntime + ArcFace ONNX 模型；缺失时 auto 显式降级并标注）
15 异常/CORS    完成  controllers/errors.py + base.py（write_error/安全头/options）+ templates/error.html
                      tests/smoke_errors.py 31/31
16 SSE/WS       完成  controllers/sse.py（SSEMixin/SSEBridge/Heartbeat）+ controllers/ws.py
                      + chat/model_engine/warehouse 三端改造（事件名不变）；tests/smoke_stream.py 27/27
17 工程基线     完成  requirements.txt + controllers/health.py（/healthz）+ app.py 日志；
                      healthz 用例并入 tests/smoke_stream.py
18 前台人脸入口   完成  static/js/face.js + static/css/face.css + templates/index.html（侧栏「人脸」+ 设置弹层）
                      + controllers/face.py（FaceToggleApiHandler：只改开关不删特征）+ application.py 路由
                      tests/smoke_face.py 41/41（新增 J1～J9 九项）、tests/verify_face_ui.py 25/25（Playwright）
回归            既有 8 套 smoke 全绿；Playwright UI 复验 assistant/employees/models = 21/25/20 全绿

遗留（需人类决策/后续增强）：
- 人脸真实引擎未接 SCRFD 检测器（多人/侧脸场景）；兜底算法精度有限且已显式提示。
- 旧 username/role cookie 兼容期无截止时间，后续版本决定是否移除。
- `.env` 仍被 git 跟踪（历史遗留，含 API Key），建议 `git rm --cached .env` 后再发布。
- MySQL 联调实例为 phpstudy 5.7.26（默认 MyISAM），DDL 已强制 InnoDB；换实例需重跑 smoke_db_mysql.py。

================================================================================
成员 E：数据仓库 / 定时任务 / 消息通知 / 会话管理 —— 本轮交付（盘点基准 v0.11.1）
================================================================================
盘点说明：成员 E 六项职责中，「数据仓库（采集入库 / 表设计 / 持久化 / message 会话消息模型）」
与会话管理 / 对话记录 / 历史查询、数据清洗 / 采集结果入库 / 采集任务状态管理已由既有任务（任务2/6/7/10）落地。
本段只登记其中尚需新建、且属成员 E 独有职责的三块，任务编号顺延自 任务19。
状态：**已按 agent_roles.md 工作流执行完毕**（阅读资料 → 计划 → 确认 → 编码 → tests 自测 → 汇报）；
未提交 / 未打 Tag / VERSION 未改动，版本号与发布时机由人类负责人决定。执行前三项关键决策已由人类确认：
- 调度引擎：**APScheduler 优先、缺失显式降级**为 tornado 事件循环调度（间隔自动排程、cron 仅手动触发）。
- 消息通知：**SMTP 标准库 + 未配置显式降级**——邮件用 smtplib，QQ 用 webhook / QQ 邮箱 SMTP；凭据只从运行环境读取，不入库不入文档。
- 交付范围：**三块全做**——定时任务模块 + 通知封装 + 统一数据统计接口，配套 task/log/archive 表、后台管理页、tests 冒烟用例、docs 同步。

--------------------------------------------------------------------------------
任务19：定时任务模块（周期调度 + 自动归档 + 日志清理 + 结果通知）
--------------------------------------------------------------------------------
开发要求：
1. 数据模型（init_db 幂等建表 + 双库兼容）：`scheduled_tasks`（周期任务配置：调度方式 interval/cron、
   启停、通知策略与渠道、上次/下次运行、上次结果）、`task_logs`（执行流水：触发方式、状态、起止时间、耗时、结果与详情）、
   `message_archives`（历史会话归档，origin_id 可追溯）；`result`/`detail` 归入 MySQL MEDIUMTEXT 长文本列。
2. `models/task.py`：ScheduledTaskRepository（CRUD + set_enabled + mark_run + paginate + normalize 字段收敛）
   与 TaskLogRepository（start/finish/paginate/latest/purge_before）；内置类型 log_cleanup/auto_archive。
3. `services/scheduler_service.py`：detect_engine/start/stop/reload_jobs/status；execute_task 写流水→按类型
   派发内置处理（日志清理、会话归档）→回写状态→依策略通知。APScheduler 用 BackgroundScheduler 独立线程；
   降级引擎用 IOLoop call_at + run_in_executor（仅 interval 自动排程）。status 显式标注 engine/note，不静默降级。
4. `services/notify_service.py`：邮件/QQ 通知封装（标准库），渠道可用性 email_available/qq_available/channels_status，
   notify 统一 dispatch，build_task_report 生成通知标题正文；未配置渠道返回 degraded 不报错。
5. `controllers/tasks.py` + `templates/admin/tasks.html` + `static/js/tasks.js` + `static/css/tasks.css`：
   /admin/tasks 页面壳（调度器状态条 + 列表/弹层/日志）+ 任务 CRUD/toggle/run/task-logs/scheduler/notify-test JSON API；
   手动触发经 run_in_executor 放线程池不卡 IOLoop；权限沿用 backend_required + require_menu('/admin/tasks')；
   db.py 幂等补种「系统运维 / 定时任务」菜单 + 预置两条内置运维任务（每日日志清理 / 每日会话归档）。
6. 配置：config.py + .env.example 新增 SCHEDULER_ENABLED/SMTP_*/MAIL_*/QQ_*（均非必填）。

交付物：models/task.py、models/stats.py、services/scheduler_service.py、services/notify_service.py、
controllers/tasks.py、templates/admin/tasks.html、static/js/tasks.js、static/css/tasks.css、db.py/config.py/application.py/.env.example 改造。

--------------------------------------------------------------------------------
任务20：数据统计接口（为数智大屏 / 统计报表提供统计数据）
--------------------------------------------------------------------------------
开发要求：
1. `models/stats.py` StatsRepository：只读聚合 overview / daily_trend / by_source / by_risk / top_keywords；
   日期骨架在 Python 侧生成、聚合用 substr 分组，避免 MySQL 5.7 不支持 CTE / ONLY_FULL_GROUP_BY 约束。
2. `controllers/stats.py`：/api/stats/overview|trend|by-source|by-risk|keywords|report，只读无副作用，
   仅需 backend_required（大屏/报表属后台可视化，与工作台同为仅需后台身份、不绑定具体菜单）；
   report 一次返回总览+趋势+信源+风险+热词，供成员 C 大屏减少多次拉取。

交付物：models/stats.py（StatsRepository + MessageArchiveRepository）、controllers/stats.py、application.py 路由登记。

================================================================================
执行记录（2026-11-09，任务19～20 已落地，未提交 / 未打 Tag，等待人类负责人验收）
================================================================================
19 定时任务模块   完成  models/task.py + services/scheduler_service.py + services/notify_service.py +
                        controllers/tasks.py + admin/tasks.html + tasks.js + tasks.css + db.py 建表/菜单与默认任务种子
                        + config.py/.env.example 通知与调度配置 + application.py 路由登记并启动调度器
20 数据统计接口   完成  models/stats.py（StatsRepository/MessageArchiveRepository）+ controllers/stats.py + /api/stats/*
修复              reload_jobs() 未声明 global _started 导致 CRUD 后 UnboundLocalError（保存接口 500）——已修
回归              tests/smoke_tasks.py 33/33（normalize 纯函数 + 菜单/默认任务种子 + CRUD/toggle/重名/非法拦截 +
                        手动运行与执行日志 + 调度器状态 + 通知降级 + 自动归档 + 统计接口），SCHEDULER_ENABLED=0 走手动触发路径
文档同步          framework.md（成员 E 新增文件附录）、architecture.md（3.2/3.3/3.4 层 + 第九节）、api.md（4.9/4.10 + 数据表）、
                        CHANGELOG.md（[未发布] 成员 E 段）、acceptance-checklist.md（定时任务转已实现）

遗留（需人类决策 / 后续增强）：
- APScheduler 未随 venv 安装，默认走 tornado 降级引擎（仅间隔自动排程）；需 cron 自动排程请 `pip install apscheduler` 并重启。
- 邮件 / QQ 通知需在本机 .env 配置 SMTP/QQ 凭据方可真实投递；未配置时接口显式降级（degraded），不影响任务执行主链路。
- 数智大屏 / 统计报表前端页（地图、语音播报）属成员 C，消费本模块 /api/stats/* 接口；本版仅提供后端聚合。

================================================================================
成员 E：通知配置在线化 + 会话管理界面 —— 本轮交付（盘点基准 v0.11.1）
================================================================================
盘点说明：任务19/20 已交付定时任务、通知封装与统计接口后端，但通知凭据只能改 `.env` 重启生效，
且成员 E 职责中的「会话管理」当时只有 Repository 能力、无后台界面。本段登记尚需新建的两块，
任务编号顺延自 任务21。状态：**已按 agent_roles.md 工作流执行完毕**（阅读资料 → 计划 → 确认 → 编码 → tests 自测 → 汇报）；
VERSION 未改动、未打 Tag，发布时机由人类负责人决定。

--------------------------------------------------------------------------------
任务21：通知配置在线化（邮件 SMTP / QQ 机器人后台可配）
--------------------------------------------------------------------------------
开发要求：
1. 数据底座：`system_settings`（key 主键 + value + updated_at）key-value 通用配置表，init_db 幂等建表；
   新建 `models/settings.py` SystemSettingsRepository（get/get_many/get_all/set/set_many/delete，全 @staticmethod），
   控制器不直接写 SQL；通知项统一 `notify_` 前缀以免与其他系统配置冲突。
2. 读取策略：**数据库优先、`.env` 兜底**——notify_service 先读 SystemSettingsRepository，缺失项回退 config；
   后台清空某项即回退运行环境值；未配置渠道仍返回 degraded 不报错（语义与任务19 一致，不得改变）。
3. 凭据安全：真实口令不回传明文——GET /api/admin/notify/config 按字段元数据（NOTIFY_FIELDS 的 sensitive 标记）脱敏输出，
   保存时空值视为「不修改 / 清空回退」，日志仍不出口令。
4. 页面：`controllers/tasks.py` 新增 AdminNotifyPageHandler（/admin/notify）+ AdminNotifyConfigHandler（读）
   + AdminNotifyConfigSaveHandler（写）；`templates/admin/notify.html` + `static/js/notify.js` + `static/css/notify.css`
   按「渠道可用性状态条 + 邮件/QQ 分组表单 + 保存与测试」渲染，字段由 JS 依后端 fields 元数据动态生成。
5. 菜单：db.py 幂等补种「系统运维 / 通知配置」（url=/admin/notify，icon=fas fa-bell，sort=2）。

交付物：models/settings.py、controllers/tasks.py 扩展、templates/admin/notify.html、static/js/notify.js、
static/css/notify.css、services/notify_service.py 读取改造、db.py 建表与菜单种子、application.py 路由登记。

--------------------------------------------------------------------------------
任务22：会话管理三页（归档追溯 / 对话记录 / 登录会话）
--------------------------------------------------------------------------------
术语前提（不得混用，页面与文档均需明写）：
- **会话** = 登录凭证，表 `user_sessions`（库里只存 token 的 SHA256，不存明文）；
- **对话会话** = 消息分组维度，字段 `messages.session_id`；
- **会话归档** = 超保留期迁移的历史消息，表 `message_archives`。

开发要求：
1. 分层沿用后台规范：templates/admin/*.html 出「状态条 | 功能区（筛选）| 列表区 | 分页区」框架壳，
   列表/操作由 static/js/*.js 走 JSON API；控制器不写 SQL，数据一律走 models 层 Repository。
2. 会话归档页 `/admin/archives`：扩展 `MessageArchiveRepository.paginate` 支持 username/session_id 模糊、
   role 精准、keyword（content LIKE）、start_at/end_at（按 origin_created_at 闭区间）多条件筛选；
   新建 controllers/archives.py（AdminArchivesHandler + AdminArchivesApiHandler）。
3. 对话记录页 `/admin/messages`：`MessageRepository` 新增 `admin_paginate`/`admin_get`/`admin_delete`/
   `admin_delete_batch`/`admin_count` 与 `_admin_where` 辅助；本模块有意**不按 username 隔离**（后台跳用户审计），
   但必须保留前台 `/api/history` 的隔离视图不变；列表不携正文大字段、详情才取全文；
   新建 controllers/messages.py（页面 + 列表/批量删除 + 详情/单条删除两个 Handler）。
4. 临时会话页 `/admin/sessions`：`SessionRepository` 新增 `admin_paginate`（state ∈ active/revoked/expired/all，非法回退 active）、
   `admin_stats`（三态计数）、`revoke_by_id`（按 id 撤销，**不依赖 token 明文**）；写操作三种：revoke /
   revoke_username / purge_expired；撤销必须联动 `ws.kick_user` 踢下 WebSocket（与用户管理强制下线同一约定），
   联动异常静默不阻断主流程；新建 controllers/sessions.py。
5. 鉴权：三页均 backend_required + require_menu(各自菜单 url)，接口同口径；每页 20 条（PAGE_SIZE）。
6. 菜单：db.py 新增 `_ensure_ops_group`（获取或创建「系统运维」分组）+ `_seed_archive_menu`/`_seed_messages_menu`/
   `_seed_sessions_menu` 三个按 url 幂等种子（icon 分别 fas fa-archive / fas fa-comments / fas fa-user-clock，sort 3/4/5）。
7. 模板约定（踩过的坑，不得再犯）：本项目用 Tornado 原生模板，**对 dict 上下文取値必须用方括号**
   `{{ stats["active"] }}`，写成 `{{ stats.active }}` 会抛 AttributeError 导致页面 500（不回退 `__getitem__`，与 Jinja2 不同）；
   admin 子模板继承必须写 `{% extends "base.html" %}`（同目录解析），带目录前缀会 FileNotFoundError 转 400/404。
8. 前端约定：表格行选择框用原生 `<input type="checkbox">`（与既有 user-row-check/wh-row-check 一致），
   layui 皮肤只用于表单/卡片里的 `lay-skin="switch"` 开关；POST 必须携 X-Xsrftoken。

交付物：controllers/{archives,messages,sessions}.py、templates/admin/{archives,messages,sessions}.html、
static/js/{archives,messages,sessions}.js、static/css/{archives,messages,sessions}.css、
models/message.py 与 models/session.py 与 models/stats.py 扩展、db.py 菜单种子、application.py 路由登记。

================================================================================
执行记录（2026-11-10，任务21～22 已落地，按人类明确指令 commit，未打 Tag，等待人类负责人验收发布）
================================================================================
21 通知配置在线化  完成  models/settings.py（system_settings + SystemSettingsRepository）+
                          controllers/tasks.py 新增 AdminNotifyPageHandler/ConfigHandler/ConfigSaveHandler +
                          admin/notify.html + notify.js + notify.css + notify_service.py 改 DB 优先读 + db.py 建表与菜单种子
22 会话管理三页      完成  controllers/{archives,messages,sessions}.py + 三套 templates/js/css +
                          models/message.py（admin_* 5 方法 + _admin_where）、models/session.py（admin_paginate/admin_stats/revoke_by_id）、
                          models/stats.py（paginate 多条件扩展）+ db.py `_ensure_ops_group` 与三个菜单种子 + application.py 登记 9 条路由
修复                    1) admin/sessions.html 对 dict 用 `{{ stats.active }}` 点号访问致 /admin/sessions 报 500——改方括号；
                        2) messages.js 详情弹层无助理时输出冗余 `— (id=0)`——改为仅 `—`；
                        3) sessions.py 早期误用 `__import__` 内联取连接——改为顶部 `from app.models.db import get_connection`。
回归                    tests/verify_messages_sessions.py **52/52**（两页渲染 + 全筛选维度 + 分页越界 + 详情 +
                        单条/批量删除 + 会话撤销/批量下线/清理 + 参数校验 + 菜单注册）；写操作只针对自建
                        `_e2e_test`/`_e2e_user` 测试数据并自清理，撤销避开当前登录会话；浏览器 UI 复验 console 零报错。
文档同步              framework.md（成员 E 新增文件附录）、architecture.md（3.2/3.4 层 + settings.py 条目）、
                        api.md（新增 4.11/4.12 + 数据表 + 第 8 节缺项修正）、CHANGELOG.md（[未发布] 2026-11-10 段）、
                        acceptance-checklist.md（会话管理/对话管理转已实现）

遗留（需人类决策 / 后续增强）：
- `SystemSettingsRepository.set/set_many` 用 `INSERT OR REPLACE`，而 db.py 方言层只翻译 `INSERT OR IGNORE` 与
  `datetime('now','localtime')`，**`DB_DRIVER=mysql` 下保存通知配置会失败**（SQLite 主链路不受影响）；
  需人类确认后改用 ON DUPLICATE KEY UPDATE 分支或补方言翻译。
- `/admin/notify` 页面按 URL_NOTIFY 鉴权，但其两个配置接口与 notify/test 仍按 `require_menu(URL_TASKS)` 鉴权；
  若某角色只分配「通知配置」而未分配「定时任务」，会出现页面能进、保存 403。本次未改动鉴权口径。
- 临时会话页只做登录会话（user_sessions）管理；「对话会话」（messages.session_id 维度）的会话粒度聚合视图未做。
- `.env` 与 `database/govagentos.db` 仍为已跟踪但含本机真实密钥 / 运行期数据，本次提交未纳入（与任务19/20 口径一致）。

