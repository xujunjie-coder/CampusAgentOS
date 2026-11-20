# Jamendo 在线音乐配置

1. 访问 https://devportal.jamendo.com/ ，注册开发者账号并创建自己的应用，按真实用途填写应用说明，取得 `client_id`。
2. 在项目根目录 `.env` 中添加 `JAMENDO_CLIENT_ID=你的应用client_id`，重启后端进程。不要把 `.env` 提交到版本库。
3. 在对话中输入 `@音乐`，应看到「Jamendo 在线曲库」、完整时长、音乐人和作品链接。也可输入 `@音乐 钢琴`，或选择「自习专注」等场景；自由搜索支持歌曲、音乐人和标签，曲库以独立音乐为主。

播放器默认「Jamendo 优先」：未配置、超时、上游失败时显示原因并回退本地示例。选择「Jamendo 在线」可以直接检查连接错误，不会静默回退。在线搜索无结果会保留空结果，不会伪装为本地命中。

服务端复用现有 Tornado 异步 HTTP 客户端，无新增第三方依赖。请求只发往官方 `https://api.jamendo.com/v3.0/tracks/`，设置连接及请求超时；API 解析层校验 Jamendo 的 JSON 状态和音频域名。浏览器直接串流播放提供商音频，不经本项目下载、落盘或提供离线曲库。

每首在线曲目显示音乐人、Jamendo 来源、作品原页面和 Creative Commons 许可链接。API 免费非商业使用并不代替各歌曲的许可要求，商用前须另行核实授权。用户播放时会连接 Jamendo 的音频和封面服务。

官方资料：

- https://developer.jamendo.com/v3.0/authentication
- https://developer.jamendo.com/v3.0/tracks
- https://devportal.jamendo.com/api_terms_of_use

官方公开测试 client_id 仅可用于临时读取接口测试，不作为部署默认值。未配置自己的应用凭据时，不能认为在线音乐已经启用。

验证：`node tests/test_music_player.cjs`；`venv\Scripts\python.exe -m pytest tests/pytest/test_11_music.py tests/pytest/test_11_jamendo.py -q`。自动化测试模拟 Jamendo 上游，不消耗实际 API 配额。
