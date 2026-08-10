# qq-bridge

把你的 **Windows 电脑** 接入 **QQ 机器人**：Reasonix 桌面事件实时推送、DeepSeek AI 聊天、远程控制电脑（关机 / 发文件 / 截屏 / 执行命令 / 指挥 Reasonix…）。

无需自己搭建服务器，机器人直接通过 **QQ 开放平台官方 API** 收发消息，本机常驻守护进程。

> 本项目最初为解决「Reasonix 内置 IM Bot 无法连通」而写，现已扩展为通用的 QQ 远程控制助手。

---

## ✨ 功能

| 类别 | 能力 |
| --- | --- |
| 📨 事件推送 | Reasonix 桌面端审批 / 对话结束 / 报错 实时推到 QQ（所有窗口/项目生效） |
| 🤖 AI 聊天 | QQ 里给机器人发消息 → DeepSeek（deepseek-v4-flash）智能回复，支持多轮上下文 |
| 🧰 电脑控制 | 关机 / 重启 / 锁屏 / 截屏发图 / 发文件 / 找文件 / 执行 cmd & PowerShell / 开网址 / 进程管理 / 剪贴板 / 系统信息 / DeepSeek 余额 |
| 🎮 指挥 Reasonix | 把文本输入到 Reasonix 桌面端当前对话（剪贴板 + 模拟按键） |
| 🔌 自动关机 | 说「这次运行完关机」→ 所有项目运行完自动关机（一次性，可取消） |
| ⏰ 定时提醒 / 等文件 | 「10 分钟后提醒我」「等 APK 构建出来发给我」 |
| 🖥️ 设置 UI | 浏览器本地设置页：配置、后台聊天、历史记录、余额 |

---

## 📋 前置要求

- **Windows 10 / 11**（依赖 PowerShell 与 cmd）
- **Node.js 18+**（推荐 20+；开发运行 `node bridge.js`，打包 exe 无需 Node）
- **QQ 开放平台机器人**：到 [q.qq.com](https://q.qq.com) 创建机器人，获得 `AppID` 与 `AppSecret`（个人用户即可，无需企业认证）
- **DeepSeek API Key**：[platform.deepseek.com](https://platform.deepseek.com) 申请，模型 `deepseek-v4-flash`（如你的账号没有该模型可换 `deepseek-chat`）
- （可选）**Reasonix 桌面端**：接收审批/对话结束推送、远程指挥

---

## 🚀 快速开始（首次配置约 10 分钟）

### 1. 下载与准备

```bash
git clone https://github.com/<你的用户名>/qq-bridge.git
cd qq-bridge
```

### 2. 创建配置文件

```bash
copy config.example.json config.json
```

编辑 `config.json`，填入必填项（其余保持默认即可）：

```jsonc
{
  "appId": "你的QQ机器人AppID",        // 必填
  "appSecret": "你的QQ机器人AppSecret", // 必填（或删掉此项，改用环境变量 QQ_BOT_APP_SECRET）
  "workspace": "C:/你的主工作区路径",    // 可选：AI 认为的"主工作区"
  "aiModel": "deepseek-v4-flash"       // 可选：DeepSeek 模型
}
```

DeepSeek 密钥两种方式二选一：
- 在 `config.json` 加 `"aiApiKey": "sk-..."`；或
- 设置环境变量 `DEEPSEEK_API_KEY=sk-...`

### 3. 启动守护进程

```bash
node bridge.js --daemon-bg
```

> 无窗口后台运行；日志写在同目录 `bridge.log`，可用 `node bridge.js --stop` 停止。
> 想让**开机自启**：把 `bridge.js` 打成 exe（见「构建 exe」），然后将
> `bridge.exe --daemon-bg` 加入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。

### 4. 建立 QQ 会话（自动获取你的 openid）

```bash
node bridge.js
```

保持窗口运行，然后**在 QQ 里给你的机器人发一条消息**。控制台会打印：

```
✅ 已保存私聊目标 user_openid=xxxxxxxxxxxxxxxxxxxx
```

你的 openid 已自动写入 `config.json`（安全白名单：默认只有这个 openid 能指挥 AI）。

> 想用群聊：把机器人拉进群，在群里 @它 发一条消息，会自动切换为群目标。

### 5. 测试

```bash
node bridge.js send --text "🤖 你好，qq-bridge 已就绪"
node bridge.js --ai-ping "你好"          # 测试 DeepSeek 连通
node bridge.js --balance                 # 查看 DeepSeek 余额
```

QQ 收到消息即全部打通。

### 6. 打开设置页（可选）

```bash
node bridge.js --ui
```

浏览器打开本地设置页：配置推送/自动关机/AI、后台直接给 AI 发消息、查看历史与余额。

---

## ⚙️ 配置详解（config.json）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | — | QQ 机器人凭据（必填） |
| `aiApiKey` / `aiModel` / `aiBaseUrl` | env / `deepseek-v4-flash` / `https://api.deepseek.com` | DeepSeek 配置 |
| `workspace` | 用户主目录 | AI 的"主工作区"，`search_files` 等默认目录 |
| `chatType` | `user` | `user`=私聊 / `group`=群聊 |
| `openid` | — | 发送目标，首次收消息自动写入 |
| `allowedOpenids` | `[]` | 访问白名单；为空时仅 `openid` 可指挥 AI |
| `summarizeStop` | `true` | 结束通知内容由 AI 缩句（200 字以内）后发送 |
| `maxAiReply` | `400` | AI 回复字数上限（提示词直接约束） |
| `autoShutdownOnDone` | `false` | 「这次运行完关机」，说一句话即开启（一次性） |
| `shutdownMode` | `all_done` | `all_done`=所有项目结束才关 / `idle`=仅空闲 |
| `idleMinutes` / `shutdownDelay` | `5` / `60` | 空闲判定分钟数 / 关机倒计时秒数 |
| `notifySessionEnd` / `notifyPostToolError` | `false` / `false` | 会话结束 / 工具报错推送开关 |
| `aiSystem` | 内置提示词 | 自定义 AI System 提示词 |

> Reasonix 集成（可选）：程序会读 `%APPDATA%\reasonix\.env` 的
> `REASONIX_BOT_CONTROL_TOKEN` 来查询活跃会话（`all_done` 关机判定），并读取
> `%APPDATA%\reasonix\settings.json` 的全局 hooks 实现事件推送。不用 Reasonix 也能跑 AI 聊天与远程控制。

---

## 🤖 AI 工具（QQ 里对机器人说）

| 你说 | AI 执行 |
| --- | --- |
| 这次运行完关机 / 取消关机 / 30 秒后关机 / 重启 / 锁屏 | 自动关机武装 / 取消 / 延时关机 / 重启 / 锁屏 |
| 把 xxx 文件发给我 / 刚才产出的文件有哪些 | 发送文件 / 列出最近修改文件 |
| 截个屏 / 找 apk 文件 / 读一下 xxx | 截屏发图 / 按名字搜文件 / 读文件内容 |
| 运行 ipconfig / 执行这段 PowerShell | cmd / PowerShell 执行 |
| 打开百度 / 结束 notepad / 磁盘还剩多少 | 开网址 / 杀进程 / 磁盘用量 |
| 让 Reasonix 跑一下测试 | 把文本输入到 Reasonix 当前对话并回车 |
| 10 分钟后提醒我 / 等 APK 构建出来发给我 | 定时提醒 / 等待文件出现后通知 |
| 余额多少 / 什么状态 | DeepSeek 余额 / 运行状态 |

所有工具结果都会用中文总结回复；任何 AI 错误（如余额不足）会**原样发到 QQ**。

---

## 🔐 安全说明

- **密钥不入库**：`config.json`、`state.json`、`*.log` 均被 `.gitignore` 排除，只提交 `config.example.json`
- **访问白名单**：默认仅你自己的 openid 可指挥 AI，其他 QQ 用户发消息会被忽略
- **敏感指令确认**：System 提示词要求 AI 不透露密钥，执行危险操作前先与用户确认
- **仅本机监听**：UI 与后台聊天 API 只绑定 `127.0.0.1`，不对外暴露

---

## 🏗️ 构建 exe（可选，免 Node 运行）

使用 Node 官方 SEA（Single Executable Application）打包：

```bash
node --experimental-sea-config sea-config.json
copy /Y "C:\Program Files\nodejs\node.exe" bridge.exe
npx --yes postject bridge.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
python make-exe.py   # 把 exe 改为 GUI 子系统（静默无窗口）
```

> exe 未签名，Windows SmartScreen 首次运行可能提示"未知发布者"，点"仍要运行"。

---

## ❓ 常见问题

- **机器人收不到/发不出消息**：确认 AppID/AppSecret 正确、机器人已发布（非仅沙箱）、
  在 QQ 客户端给机器人打开「允许主动发送」
- **openid 未写入**：先跑 `node bridge.js`（守护）再给机器人发消息
- **开机误关机**：守护启动会自动清空历史活动状态，只有收到新的任务事件后才开始计时
- **收不到 Reasonix 推送**：确认桌面端 hooks 配置指向 `bridge.js --hook`（见上）
- **exe 打不开**：用 `打开设置.bat`（自动回退 `node bridge.js --ui`）

---

## 📄 技术参考

- QQ 开放平台 v2 API：access_token `POST /app/getAppAccessToken`；消息 `POST /v2/users/{openid}/messages`（群聊 `groups`）；文件分片上传；WebSocket `wss://api.sgroup.qq.com/websocket`，intents `1<<25`
- DeepSeek API：`POST /chat/completions`、`GET /user/balance`

## 免责声明

本项目仅供个人学习与自动化使用。远程执行命令、关机、截屏等能力请谨慎授权，使用风险自负。
