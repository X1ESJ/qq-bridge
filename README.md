# qq-bridge — Reasonix 桌面端事件 → QQ 官方机器人推送（exe，静默后台）

把桌面端跑任务时的状态直接推到你的 QQ（官方 QQ 开放平台机器人），**不依赖 Reasonix
内置 bot gateway**，由本程序直接调用 QQ 开放平台 OpenAPI。

## 🤖 QQ 聊天 = AI 助手（DeepSeek）

给机器人发**私聊消息**（或群里 @机器人）→ 走 **DeepSeek（deepseek-v4-flash）** 智能回复，
AI 可调用工具控制电脑：

| 工具 | 作用 | 示例说法 |
| --- | --- | --- |
| `arm_shutdown_after_tasks` | 设置「这次运行完关机」（一次性） | “这次运行完关机” |
| `disarm_shutdown` / `cancel_shutdown` | 解除自动关机 / 取消已调度关机 | “取消关机” |
| `shutdown_computer` | 立即延时关机 | “30 秒后关机” |
| `send_file` | 发文件到 QQ | “把 test-upload.txt 发给我”（自动分片上传） |
| `list_recent_files` | 列出最近修改的文件 | “刚才产出的文件有哪些” |
| `take_screenshot` | 截屏并发送到 QQ | “截个屏” |
| `type_to_reasonix` | 远程输入到 Reasonix 当前对话 | “让 Reasonix 跑一下测试” |
| `run_command` / `run_powershell` | 执行 cmd 命令 / PowerShell 代码 | “运行 ipconfig” / “执行这段 PowerShell” |
| `reboot_computer` / `lock_computer` | 重启 / 锁屏 | “重启电脑” / “锁屏” |
| `read_file` / `search_files` | 读文件内容 / 按名字找文件 | “读一下 xxx” / “找 apk 文件” |
| `get_disk_usage` / `get_system_info` | 磁盘空间 / 系统信息 | “磁盘还剩多少” |
| `set_reminder` | 定时提醒（到点发 QQ） | “10 分钟后提醒我喝水” |
| `wait_for_file` | 等文件出现（构建产物），出现后通知/发送 | “等 APK 构建出来发给我” |
| `open_url` / `open_path` | 打开网址 / 文件路径 | “打开百度” |
| `list_processes` / `kill_process` | 进程管理 | “结束 notepad” |
| `get_clipboard` / `set_clipboard` | 剪贴板读写 | “复制这段文字” |
| `get_system_info` / `get_status` | 系统与运行状态 | “电脑什么配置” |

密钥：`%APPDATA%\reasonix\.env` 的 `DEEPSEEK_API_KEY`；模型/开关/提示词可在设置页改。

| 场景 | 触发事件 | 消息 |
| --- | --- | --- |
| 需要审核（工具/记忆审批等） | `Notification` | 🔔 Reasonix 需要你处理 |
| 一轮对话结束 | `Stop` | ✅ 本轮对话结束（带 turn） |
| 工具执行报错 | `PostToolUse` | ⚠️ 已按需求**关闭**（config.json `notifyPostToolError=false`） |
| 会话结束（可选，默认关） | `SessionEnd` | 👋 会话已结束 |

消息会自动去掉 markdown 格式符号（`**`、`#`、`-`、`>`、`$`、`` ` `` 等），只保留文字；
每条消息带项目名，如 `✅ [project-a] 本轮对话结束（turn 2）`。

## 开机自启动 + 后台静默（已配置 ✅）

已写入注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`：

```
qq-bridge = "…\qq-bridge\bridge.exe" --daemon-bg
```

- **开机自动启动**，无窗口静默运行（exe 已改为 GUI 子系统，不弹黑窗）
- 日志写入 `qq-bridge\bridge.log`（exe 同目录），pid 写入 `bridge.pid`
- 双击 `bridge.exe` 与自启动行为一致（静默后台 + 写日志）

### 手动控制

| 操作 | 命令 |
| --- | --- |
| 启动后台守护 | `bridge.exe --daemon-bg`（或直接双击） |
| 停止后台守护 | `bridge.exe --stop`（读 bridge.pid） |
| 查看运行状态 | 看 `qq-bridge\bridge.log` 尾部 |

> 说明：守护进程只负责保持 QQ 在线连接 / 自动保存 openid / 记录日志。
> **推送本身不依赖守护进程** —— 桌面端每次发生事件时 hooks 会临时调用
> `bridge.exe --hook` 发送，守护进程不在也能推。

## 推送链路（无需任何窗口）

`%APPDATA%\reasonix\settings.json` 全局 hooks（桌面端所有窗口/项目生效）：
`Notification` / `Stop` / `PostToolUse` / `SessionEnd` / `UserPromptSubmit` → 调用 `bridge.exe --hook`
（读 stdin 事件 payload → **本地转发给守护进程**（`127.0.0.1:37915/api/hook`，毫秒级）→
守护进程统一发 QQ：token/endpoints 有内存+磁盘缓存，AI 缩句也在守护内异步做）。
守护进程未运行时，`--hook` 自动回退直连（走磁盘缓存，也比冷启动快）。
改动过代码后记得**重启桌面端**。

## 设置界面（UI）

**双击 `打开设置.lnk`**（无黑窗；或 `打开设置.bat`，会闪一下黑窗；或命令行 `bridge.exe --ui`）
→ 浏览器打开本地设置页
（`http://127.0.0.1:37914`，仅本机可访问，零依赖）：

- 🔌 **这次运行完关机**：开关 + 连续无活动分钟数（默认 5）+ 关机倒计时秒数（默认 60）
  - **默认不自动关机**；在 QQ 对机器人说「这次运行完关机」（或在这里打开开关）才启用，**一次性**（关机后自动解除）
  - 判定：任务每有事件（工具执行 / 对话结束 / 你的输入）自动刷新「最后活动」；
    守护进程检测到**连续 N 分钟无任何活动**（所有项目都停了）→ 先发 QQ 通知 → 执行
    `shutdown /s /t <秒>` 倒计时关机；任务重新活动则**自动取消**关机
  - 取消：设置页「取消关机」按钮 / 对机器人说“取消关机”，或命令行 `shutdown /a`
- 🔔 消息推送开关：工具报错推送、会话结束推送
- ℹ️ 状态：发送目标、关机调度、最后活动/事件/项目
- 按钮：保存设置、发送测试消息
- 页面 30 分钟无操作自动退出（防残留进程）

> 自动关机由**守护进程**执行（开机自启动已配置，每 30 秒检查一次）。
> 推送不依赖守护进程，但自动关机依赖；确保 `--daemon-bg` 在运行。

## 命令行

| 命令 | 作用 |
| --- | --- |
| `bridge.exe`（双击/无参数） | 静默后台守护：连接 QQ、写 bridge.log |
| `bridge.exe --daemon-bg` | 同上（自启动项用） |
| `bridge.exe --ui` | 打开设置页（浏览器） |
| `bridge.exe --stop` | 停止后台守护进程 |
| `bridge.exe --hook` | hook 模式（settings.json 的 hooks 调用） |
| `bridge.exe --dry-run` | 只打印将推送的内容，不发 |
| `bridge.exe send --text "…"` | 手动发一条测试消息 |
| `bridge.exe --ai-ping [问题]` | 测试 DeepSeek 连通（不发 QQ） |
| `bridge.exe --send-file <路径>` | 测试发一个文件到 QQ |
| `bridge.exe --tool-test <工具名> '<json参数>'` | 直接调用某个 AI 工具（如 `--tool-test get_system_info`） |
| `bridge.exe --status-check` | 查看 Reasonix 活跃会话数（自动关机判定用） |
| `bridge.exe --self-test` | 检查凭据/token/gateway/配置（加 `--send` 可真实发一条） |

## config.json（exe 旁）

```json
{
  "appId": "1905378872",
  "appSecret": "",              // 留空自动读 %APPDATA%\\reasonix\\.env 的 QQ_BOT_APP_SECRET
  "chatType": "user",           // user=私聊 / group=群聊
  "openid": "…",                // 发送目标；守护模式收到你的消息后自动写入
  "maxText": 500,
  "notifySessionEnd": false,    // 会话结束推送，默认关
  "notifyPostToolError": false, // 工具报错推送，已按需求关闭
  "autoShutdownOnDone": false, // 「这次运行完关机」，默认关；QQ 对机器人说「这次运行完关机」即开启（一次性）
  "idleMinutes": 5,             // 连续无活动多少分钟判定为完成
  "shutdownDelay": 60,          // 关机前倒计时秒数
  "shutdownMode": "all_done",  // all_done=所有项目结束（无活跃会话）才关机；idle=仅空闲
  "aiEnabled": true,            // QQ 消息走 AI 回复
  "aiModel": "deepseek-v4-flash",
  "aiSystem": ""               // 留空用内置默认提示词
}
```

## 已验证 ✅

- 凭据/token/gateway 获取、WebSocket 鉴权、真实发送到你 QQ 均成功
- 后台守护经任务计划程序（独立于终端）启动后**稳定常驻**，`--stop` 可正常停止
- 开机自启动注册表项已写入并验证
- markdown 清理（`**`/`#`/`-`/`>`/`$` 等）与项目名显示已验证
- 工具报错推送已关闭；`bridge.exe --hook` 端到端发送成功
- **自动关机**：空闲超时触发（dry 模式日志确认）、活动刷新自动取消、UI API 保存全部验证
- **UI**：设置页 GET/POST 配置、取消关机、测试消息 API 全部验证

## 安全与稳定性（本轮新增）

- **访问白名单**：默认只响应 config.json 里保存的 openid（你自己）；其他人给 bot 发消息会被忽略。
  如需放行更多 QQ，在 config.json 的 `allowedOpenids` 数组里加 openid（UI 不提供，避免误改）。
- **AI 回复长消息自动分段**（每段 ≤3800 字符，长回复完整送达）
- **对话历史持久化**（state.json，守护重启不丢；每对话保留最近 20 条）
- **日志轮转**（bridge.log 超过 2MB 自动备份为 bridge.log.old）
- DeepSeek 调用带重试；工具循环耗尽会返回已执行摘要而非空回复
- **AI 回复字数上限**（config `maxAiReply`，默认 400，UI 可调）：系统提示词直接约束 AI
  "每次回复控制在 N 字以内"，Stop 通知的精简也按此字数压缩（不是事后截断）
- **报错直接发 QQ**：AI 处理失败（如余额不足 402 / 超时）、推送失败，会把错误信息
  原样发到 QQ（⚠️ AI 处理出错：…），不会只写日志让你蒙在鼓里
- **DeepSeek 余额**：设置页状态卡片显示账号余额（官方 /user/balance 接口），
  QQ 里对机器人说"余额多少"（AI 工具 get_balance）、命令行 `bridge.exe --balance` 也能查
- **会话费用**：Reasonix 本地接口（127.0.0.1:37913）未运行，暂无法获取；
  若桌面端重启后 gateway 起来，状态卡片会自动显示

## 结束通知格式与后台对话（本轮新增）

- **结束通知**：`✅ [工作区] 本轮对话结束（turn N）`；**内容不直接发全文**：把 Reasonix 会话回复的**原文完整**交给 DeepSeek
  **缩句为 200 字以内**后发送（不删格式符号、不预截断）；可在设置页关掉
- **后台对话（不经 QQ）**：设置页新增「💬 后台对话」卡片——
  - 查看 AI 对话历史（含 QQ 对话与后台对话，按对话分组）
  - 输入框直接给 AI 发消息，回复显示在页面（走守护进程 `127.0.0.1:37915` 的 API，与 QQ 对话共享 AI 上下文）

## 暂未实现（按需再开）

- **图片理解**：你发图片给机器人 → AI 看图（需 DeepSeek 视觉模型，当前 deepseek-v4-flash 无视觉）
- **语音消息**转文字（需额外 ASR 服务）
- **AI 处理中可打断**（"停"中止当前 DeepSeek 调用，目前只能等它 2 分钟超时）
- **局域网/公网远程访问** UI（目前仅本机 127.0.0.1）
- **Reasonix 会话级联控**（暂停/恢复/查看历史，Reasonix 未提供相关接口）

## 文件

| 文件 | 说明 |
| --- | --- |
| `bridge.exe` | 主程序（GUI 子系统，静默后台） |
| `打开设置.lnk` / `打开设置.bat` | 双击打开设置页（lnk 无黑窗，bat 闪一下黑窗；vbs 被部分系统拦截已弃用） |
| `config.json` | 配置（exe 旁） |
| `bridge.js` | 源码（改完重打包） |
| `make-exe.py` | 打包后改 GUI 子系统 |
| `sea-config.json` | Node SEA 打包配置 |
| `state.json` / `bridge.log` / `bridge.pid` | 运行时生成：活动状态 / 日志 / 守护 pid |

## 重新打包 exe（改 bridge.js 后）

```sh
cd 到本目录
node --experimental-sea-config sea-config.json
copy /Y "C:\Program Files\nodejs\node.exe" bridge.exe
npx --yes postject bridge.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
```

打包后需把 exe 的 PE Subsystem 改为 2（GUI，静默无窗口）：
`python` 改 `e_lfanew + 4 + 20 + 68` 处的 2 字节为 `2`（原为 3），
或用本目录 `make-exe.py`。改完自检：`bridge.exe --self-test >nul 2>&1 && echo OK`。

> 未签名，Windows SmartScreen 首次运行可能提示"未知发布者"，点"仍要运行"即可。

## 常见问题

- **私聊收不到** → QQ 客户端给机器人资料卡打开「允许主动发送」；或改用群聊
  （把机器人拉进群，守护模式下在群里发一条消息，自动切为群目标）。
- **想恢复工具报错推送** → config.json `notifyPostToolError` 改回 `true`。
- **守护进程没起来** → 看 `bridge.log`；`--stop` 后再 `--daemon-bg` 重启。
- **报错码**：程序输出中文提示（40054013=用户拒收、40034105=无权限、4914=仅沙箱、4915=封禁）。

## 技术参考（QQ 开放平台文档 v2）

- access_token：`POST https://bots.qq.com/app/getAppAccessToken`（或 api.bot.qq.com）
- 发送单聊：`POST /v2/users/{user_openid}/messages`（msg_type=0, content）
- 发送群聊：`POST /v2/groups/{group_openid}/messages`
- 事件订阅：WebSocket `wss://api.sgroup.qq.com/websocket`，intents = 1<<25（GROUP_AND_C2C_EVENT）
- 鉴权头：`Authorization: QQBot <access_token>`
