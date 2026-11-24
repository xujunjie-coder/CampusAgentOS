# 2026-11-24 提交前验证

本记录对应本批频道信源、帖子阅读与图片、知识分页、地图校正、聊天协作、人脸设置和大屏改动。下列结果来自本次实际执行，不代表全仓库所有测试或线上验收。

## 后端回归：通过

```powershell
.\venv\Scripts\python.exe -m pytest tests/pytest/test_qq_sources.py tests/pytest/test_qq_channel.py tests/pytest/test_qq_sentiment.py tests/pytest/test_campus_map.py tests/pytest/test_knowledge_retrieval.py tests/pytest/test_chat_collaboration.py tests/pytest/test_14_dashboard_reports.py -q -p no:cacheprovider
```

覆盖频道信源增改停用删除及访问控制、搜索范围、图片元数据、按帖读取、舆情接入、地图资源与鉴权、混合检索、协作预算/超时和大屏统计。使用测试数据库；模拟模型和采集页面的用例不能证明真实模型或腾讯网站行为。

Windows 受限环境中曾在创建 asyncio socketpair 时阻塞，允许本机回环后执行通过。新增接口测试的临时 SQLite 连接关闭问题已修正并重跑通过。

## 前端 DOM 回归：通过

```powershell
node tests/test_qq_channel_ui.cjs
node tests/test_campus_map_labels.cjs
```

验证选中帖子才请求详情、全文替换摘要、评论树、单一整帖审核、图片 URL 去重与加载失败提示，以及地图标注、比例尺与平面距离。

## 浏览器交互回归：通过

```powershell
.\venv\Scripts\python.exe tests/test_chat_collaboration_ui.py
.\venv\Scripts\python.exe tests/test_face_settings_ui.py
.\venv\Scripts\python.exe tests/test_dashboard_feed_ui.py
```

验证协作状态与安全展示、桌面/手机布局、人脸设置的拍摄/重拍/上传及关闭资源清理、大屏明细滚动及刷新位置。这些脚本使用模拟接口与本地静态资源，不代表真实摄像头识别成功率或实时业务数据验收。

## 知识仓库分页：通过

对实际分页函数使用临时内存 SQLite 数据验证：空列表、每页 15 条、106 条跨页完整覆盖、页码越界和删除最后一页唯一记录后的回退。Python 语法及知识页面模板编译通过。

## 实际页面核对

- QQ 频道信源列表能选中新增频道；后台存在新增/编辑入口及“前往采集”链接。
- 帖子正文/评论双栏、回复缩进和整帖审核折叠已在页面观察。
- 地图中理科楼 A/B/C 搜索与 A 栋详情、聚焦已观察。

## 未在本批重新验收

- 全仓库测试、MySQL 实机切换、生产压测、远程部署和浏览器兼容性矩阵。
- 当前真实模型的回答质量与延迟；`tests/verify_collaboration_latency.py` 为主动连接已配置模型的可选脚本，本批未运行。
- 真实摄像头识别与活体效果、外部帖子原图的完整可用性、频道全量历史覆盖和邮件收件箱到达。
