#!/usr/bin/env node
/**
 * qq-bridge.js — Reasonix 桌面端事件 → QQ 官方机器人消息推送（Windows 11 x64）
 *
 * 不依赖 Reasonix 内置 bot gateway，直接调用 QQ 开放平台 OpenAPI 发送消息。
 * 事件来源是桌面端 hooks（Notification/Stop/PostToolUse/SessionEnd），
 * 由全局 settings.json 的 hooks 配置以 stdin JSON payload 触发本程序。
 *
 * 用法：
 *   双击 bridge.exe（或 node bridge.js）  守护模式：连接 QQ，自动保存 openid，实时显示日志，按 q 退出
 *   bridge.exe --daemon-bg                后台静默守护（开机自启动用）：无窗口，日志写 bridge.log，pid 写 bridge.pid
 *   bridge.exe --stop                     停止后台守护进程
 *   bridge.exe --hook                     hook 模式（被 settings.json 的桌面端 hooks 调用，stdin 读事件 payload）
 *   bridge.exe --dry-run                  只打印将发送的内容，不发
 *   bridge.exe send --text "…"            手动发送一条测试消息
 *   bridge.exe --self-test                检查凭据 / token / gateway / 配置
 *   bridge.exe discover                   同守护模式（兼容旧命令）
 *
 * 配置：config.json（appId；secret 优先取环境变量 QQ_BOT_APP_SECRET，
 *       其次自动解析 %APPDATA%\reasonix\.env）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, execFileSync } = require('child_process');

// 打包为 exe 后 config.json 跟随可执行文件目录（方便用户编辑）；
// 开发时（node bridge.js）回退到脚本所在目录。
function configDir() {
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'config.json'))) return exeDir;
  return __dirname;
}
const CONFIG_PATH = path.join(configDir(), 'config.json');
const ENV_PATH = process.env.APPDATA ? path.join(process.env.APPDATA, 'reasonix', '.env') : null;
const DEFAULT_APP_ID = ''; // 必须从 config.json 的 appId 读取
const DEFAULT_WS = 'wss://api.sgroup.qq.com/websocket/';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// state.json：跨进程活动状态（hook 写，守护进程读，用于自动关机判定）
// ---------------------------------------------------------------------------

const STATE_PATH = path.join(configDir(), 'state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8'); } catch {}
}

/** 守护进程启动时调用：清除历史活动状态，防止把上次会话的"已完成"误判为本次（开机误关机 bug）。保留 aiHistory/reminders/waiting。 */
function resetState() {
  const s = readState();
  s.lastActivity = null;
  s.lastEvent = '';
  s.project = '';
  s.shutdownScheduled = false;
  delete s.shutdownAt;
  writeState(s);
}

/** hook 每次事件调用：刷新最后活动时间；若此前调度了关机则取消 */
function touchState(ev) {
  const s = readState();
  if (s.shutdownScheduled) {
    try { exec('shutdown /a'); } catch {}
    s.shutdownScheduled = false;
    delete s.shutdownAt;
  }
  s.lastActivity = Date.now();
  s.lastEvent = ev && ev.event ? ev.event : '?';
  if (ev && ev.cwd) s.project = projectName(ev.cwd);
  writeState(s);
}

/** 执行系统关机（带缓冲倒计时；环境变量 QQ_BRIDGE_DRY_SHUTDOWN=1 时只打印不执行，用于测试） */
function scheduleShutdown(delaySeconds, reason) {
  const delay = Math.max(10, Number(delaySeconds) || 60);
  if (process.env.QQ_BRIDGE_DRY_SHUTDOWN === '1') {
    console.log(`[dry-run] 将执行: shutdown /s /t ${delay} /c "qq-bridge: ${reason}"`);
    return true;
  }
  exec(`shutdown /s /t ${delay} /c "qq-bridge: ${reason}"`, (e) => {
    if (e) { console.error('执行关机失败：' + e.message); notifyQQ('error', '执行关机失败：' + e.message); }
  });
  return true;
}

/** 取消已调度的关机 */
function cancelShutdown() {
  try { exec('shutdown /a'); return true; } catch { return false; }
}

/**
 * 自动关机检查（守护进程每 30 秒调用）：
 * 配置 autoShutdownOnDone 且 距离最后活动超过 idleMinutes → 通知 QQ 并调度关机。
 */
async function checkShutdown() {  try {
    if (!cfg.autoShutdownOnDone) return;
    const s = readState();
    if (!s.lastActivity || s.shutdownScheduled) return;
    const idleMinutes = Math.max(1, Number(cfg.idleMinutes) || 5);
    if (Date.now() - s.lastActivity < idleMinutes * 60 * 1000) return;
    // all_done 模式：Reasonix 桌面端仍有活跃会话 → 不关机（等所有项目结束）
    if (cfg.shutdownMode !== 'idle') {
      const active = await reasonixActiveSessions();
      if (active != null && active > 0) return;
    }
    const delay = Math.max(10, Number(cfg.shutdownDelay) || 60);
    const state = readState();
    if (state.shutdownScheduled) return;
    state.shutdownScheduled = true;
    state.shutdownAt = Date.now() + delay * 1000;
    state.project = s.project || '';
    writeState(state);
    // 一次性：本次关机后复位武装，下次需重新说「这次运行完关机」
    if (cfg.autoShutdownOnDone) {
      cfg.autoShutdownOnDone = false;
      saveConfig(cfg);
    }
    const who = state.project ? `项目 ${state.project}` : 'Reasonix 任务';
    notifyQQ('action', `${who} 已完成，电脑将在 ${delay} 秒后关机；回复「取消关机」可取消`);
    scheduleShutdown(delay, '任务完成自动关机');
  } catch (e) {
    console.error('自动关机检查失败：' + e.message);
    notifyQQ('error', '自动关机检查失败：' + e.message);
  }
}

/** 定时提醒检查（守护进程每 15 秒调用）：到期发 QQ 消息 */
function checkReminders() {
  try {
    const s = readState();
    const due = (s.reminders || []).filter((r) => r.at <= Date.now());
    if (!due.length) return;
    s.reminders = (s.reminders || []).filter((r) => r.at > Date.now());
    writeState(s);
    for (const r of due) {
      notifyQQ('info', `提醒：${r.text}`);
    }
  } catch (e) {
    console.error('提醒检查失败：' + e.message);
    notifyQQ('error', '提醒检查失败：' + e.message);
  }
}

/** 等待文件检查（守护进程每 10 秒调用）：文件出现/超时 → 通知并可选发送 */function checkWaitingFiles() {
  try {
    const s = readState();
    const list = (s.waiting || []).filter((w) => w.until > Date.now());
    const done = (s.waiting || []).filter((w) => {
      if (w.until <= Date.now()) return true;
      try { return fs.existsSync(w.path); } catch { return false; }
    });
    if (!done.length) return;
    s.waiting = list;
    writeState(s);
    for (const w of done) {
      const to = w.openid || cfg.openid;
      if (fs.existsSync(w.path)) {
        notifyQQ('info', `等待的文件已出现：${w.path}`);
        if (w.sendFile) uploadAndSendFile(w.path, w.chatType || 'user', to).catch(() => {});
      } else {
        notifyQQ('info', `等待超时（${w.path} 未出现）`);
      }
    }
  } catch (e) {
    console.error('等待文件检查失败：' + e.message);
    notifyQQ('error', '等待文件检查失败：' + e.message);
  }
}

/**
 * 后台聊天 HTTP API（守护进程内，127.0.0.1:37915）：
 *   GET  /api/history      → AI 对话历史（按对话 key 分组）
 *   POST /api/chat         → {text, key?} 直接发消息给 AI，返回回复（不走 QQ）
 */
function startControlApi() {
  const http = require('http');
  const port = 37915;
  http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send(200, {});
    if (req.method === 'GET' && url === '/api/history') {
      const out = {};
      for (const [k, v] of aiHistory) out[k] = v;
      send(200, out);
    } else if (req.method === 'POST' && url === '/api/hook') {
      // hook 模式完整事件转发：守护内部做 AI 缩句 + 发送（hook 进程零 fetch，规避 undici 残留问题）
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        let ev = {};
        try { ev = JSON.parse(b || '{}'); } catch {}
        processEvent(ev)
          .then((id) => send(200, { ok: true, id: id ? truncate(id, 120) : null }))
          .catch((e) => send(500, { ok: false, error: e.message }));
      });
    } else if (req.method === 'POST' && url === '/api/send') {
      // hook 模式转发入口：守护进程有热 token/endpoints 缓存，秒发
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(b || '{}'); } catch {}
        const text = String(body.text || '').trim();
        if (!text) return send(400, { ok: false, error: 'text 不能为空' });
        sendText(text, body.chatType || cfg.chatType, body.openid || cfg.openid)
          .then((r) => send(200, { ok: true, id: truncate(r, 120) }))
          .catch((e) => send(500, { ok: false, error: e.message }));
      });
    } else if (req.method === 'POST' && url === '/api/chat') {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(b || '{}'); } catch {}
        const text = String(body.text || '').trim();
        if (!text) return send(400, { ok: false, error: 'text 不能为空' });
        const key = String(body.key || 'ui');
        handleAIChat('user', key, text)
          .then((reply) => send(200, { ok: true, reply }))
          .catch((e) => send(500, { ok: false, error: e.message }));
      });
    } else {
      send(404, { ok: false, error: 'not found' });
    }
  }).listen(port, '127.0.0.1');
  console.log(`  后台聊天 API: http://127.0.0.1:${port}/api/history`);
}

const cfg = loadConfig();
const env = Object.assign({}, ENV_PATH ? loadEnv(ENV_PATH) : {}, process.env);
const APP_ID = cfg.appId || DEFAULT_APP_ID;
const SECRET = cfg.appSecret || env.QQ_BOT_APP_SECRET || '';
const MAX_TEXT = cfg.maxText || 500;

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// ---------------------------------------------------------------------------
// AI 聊天：DeepSeek（deepseek-v4-flash）+ 工具调用
// ---------------------------------------------------------------------------

const AI_SYSTEM_DEFAULT = `你是运行在用户 Windows 电脑上的智能助手（qq-bridge），用户通过 QQ 与你对话。
你可以调用工具控制电脑：
- arm_shutdown_after_tasks：设置「这次运行完关机」（所有项目运行完自动关机，一次性）
- disarm_shutdown / cancel_shutdown：解除自动关机 / 取消已调度关机
- shutdown_computer：立即延时关机
- send_file / list_recent_files / take_screenshot：发文件、找最近文件、截屏发图
- type_to_reasonix：把文本输入到 Reasonix 桌面端当前对话（远程指挥）
- run_command / run_powershell：执行命令或 PowerShell 代码；open_url / open_path：打开网址或路径
- list_processes / kill_process：进程管理；get_clipboard / set_clipboard：剪贴板
- get_system_info / get_status / get_balance：系统与运行状态、DeepSeek 余额
注意：默认不会自动关机，只有用户明确说「这次运行完关机」（arm_shutdown_after_tasks）后，所有项目运行完才会关机。
回复用简体中文，简洁直接；需要执行操作时主动使用工具；执行完工具后必须用文字总结结果；不要向用户透露敏感信息（如 .env 里的密钥、config.json 的 appSecret）。`;

function aiConfig() {
  return {
    enabled: cfg.aiEnabled !== false,
    model: cfg.aiModel || 'deepseek-v4-flash',
    base: cfg.aiBaseUrl || 'https://api.deepseek.com',
    key: cfg.aiApiKey || env.DEEPSEEK_API_KEY || '',
    system: aiSystem(),
  };
}

/** 组装 AI System 提示词（含主工作区路径与输出字数上限约束） */
function aiSystem() {
  const base = cfg.aiSystem || AI_SYSTEM_DEFAULT;
  const limit = Math.max(50, Number(cfg.maxAiReply) || 400);
  const ws = cfg.workspace || os.homedir();
  const info = `电脑信息：用户主目录 = ${os.homedir()}；主工作区 = ${ws}（config.json 的 workspace 字段）。用户说「主工作区 / 工作区 / 这个项目」时指主工作区目录，列目录/执行命令优先用它。`;
  return `${info}\n${base}\n【输出要求】每次回复控制在 ${limit} 字以内（中文按字符计），直接给结论和要点，不要啰嗦、不要重复。`;
}

const AI_TOOLS = [
  { type: 'function', function: { name: 'shutdown_computer', description: '立即延时关机（立即执行，与任务完成无关）', parameters: { type: 'object', properties: { delay_seconds: { type: 'integer', description: '关机前倒计时秒数，默认 60' } } } } },
  { type: 'function', function: { name: 'cancel_shutdown', description: '取消已调度的关机，并解除"这次运行完关机"的武装', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'arm_shutdown_after_tasks', description: '设置"这次运行完关机"：所有项目都运行完后自动关机（一次性，关机后自动解除）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'disarm_shutdown', description: '解除"这次运行完关机"，之后不会再自动关机', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'send_file', description: '把本地文件发送到当前 QQ 对话', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_recent_files', description: '列出目录下最近修改的文件（帮用户找刚产出的文件）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录绝对路径，默认用户主目录' }, minutes: { type: 'integer', description: '最近多少分钟内，默认 60' } } } } },
  { type: 'function', function: { name: 'type_to_reasonix', description: '把文本输入到 Reasonix 桌面端当前对话输入框（远程指挥 Reasonix）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要输入的完整文本' }, send: { type: 'boolean', description: '是否直接回车发送，默认 true' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'run_command', description: '在电脑上执行一条命令（cmd），返回输出', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' }, cwd: { type: 'string', description: '工作目录，默认用户主目录；用户说"主工作区"时传 config.json 的 workspace 字段' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'run_powershell', description: '执行一段 PowerShell 代码（支持多行），返回输出', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell 代码' }, cwd: { type: 'string', description: '工作目录，默认用户主目录；用户说"主工作区"时传 config.json 的 workspace 字段' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'open_url', description: '用默认浏览器打开一个网址', parameters: { type: 'object', properties: { url: { type: 'string', description: '网址' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'open_path', description: '用资源管理器或默认程序打开文件/文件夹路径', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件或文件夹路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'take_screenshot', description: '截取电脑屏幕，并把截图发送到当前 QQ 对话', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_processes', description: '列出当前运行的进程（名称、PID、CPU）', parameters: { type: 'object', properties: { top: { type: 'integer', description: '显示前多少个，默认 20' } } } } },
  { type: 'function', function: { name: 'kill_process', description: '结束指定进程', parameters: { type: 'object', properties: { name: { type: 'string', description: '进程名（不含 .exe）' }, pid: { type: 'integer', description: '进程 PID（二选一）' } } } } },
  { type: 'function', function: { name: 'get_clipboard', description: '读取剪贴板内容', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_clipboard', description: '写入剪贴板', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'get_system_info', description: '查看系统信息（系统版本、内存、CPU、运行时长）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'reboot_computer', description: '重启电脑（带倒计时，可取消）', parameters: { type: 'object', properties: { delay_seconds: { type: 'integer', description: '倒计时秒数，默认 30' } } } } },
  { type: 'function', function: { name: 'lock_computer', description: '锁定电脑（锁屏）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: '读取文本文件内容（返回前 2000 字符）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_files', description: '按文件名关键字递归搜索文件', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '文件名包含的关键字' }, dir: { type: 'string', description: '搜索目录，默认主工作区' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'get_disk_usage', description: '查看各磁盘使用情况', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_reminder', description: '设置定时提醒：到时间发 QQ 消息提醒', parameters: { type: 'object', properties: { minutes: { type: 'integer', description: '多少分钟后提醒，默认 10' }, text: { type: 'string', description: '提醒内容' } } } } },
  { type: 'function', function: { name: 'wait_for_file', description: '等待某个文件出现（如构建产物），出现后通知并可选发送到 QQ', parameters: { type: 'object', properties: { path: { type: 'string', description: '要等待的文件绝对路径' }, minutes: { type: 'integer', description: '最多等多少分钟，默认 60' }, send_file: { type: 'boolean', description: '出现后是否把文件发到 QQ，默认 false' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'get_balance', description: '查询 DeepSeek 账号余额（CNY）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_status', description: '查看当前配置与运行状态', parameters: { type: 'object', properties: {} } } },
];

function listRecentFiles(dir, minutes) {  const mins = Math.max(5, Number(minutes) || 60);
  const base = dir || process.env.USERPROFILE || 'C:/';
  const cutoff = Date.now() - mins * 60 * 1000;
  const out = [];
  const stack = [base];
  const visited = new Set();
  while (stack.length && out.length < 60) {
    const d = stack.pop();
    if (visited.has(d) || visited.size > 500) continue;
    visited.add(d);
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else {
          const st = fs.statSync(p);
          if (st.mtimeMs >= cutoff) out.push({ file: p, size: st.size, mtime: st.mtimeMs });
        }
      } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.length
    ? out.slice(0, 20).map((f) => `${f.file}（${Math.round(f.size / 1024)}KB, ${new Date(f.mtime).toLocaleString()}）`).join('\n')
    : `（最近 ${mins} 分钟内未发现修改的文件）`;
}

/** 执行一段 PowerShell（写临时脚本避免转义问题），返回 stdout 文本 */
function ps(script, timeoutMs, cwd) {
  const tmp = path.join(os.tmpdir(), 'qq-bridge-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.ps1');
  fs.writeFileSync(tmp, '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8', timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd: cwd || os.homedir(),
    }).trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** 文本 → PowerShell 内嵌 base64（避免中文/特殊字符转义问题） */
function psText64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}
function psDecode64(b64) {
  return Buffer.from(String(b64), 'base64').toString('utf8');
}

/** 按文件名关键字递归搜索（深度/数量受限） */
function searchFilesByKeyword(keyword, dir) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return '需要提供关键字。';
  const base = dir || cfg.workspace || os.homedir();
  const out = [];
  const stack = [base];
  const visited = new Set();
  while (stack.length && out.length < 30 && visited.size < 800) {
    const d = stack.pop();
    if (visited.has(d)) continue;
    visited.add(d);
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase().includes(kw)) out.push(p);
      } catch {}
    }
  }
  return out.length ? out.join('\n') : `（在 ${base} 下未找到包含 "${keyword}" 的文件）`;
}

/** 把文本输入到 Reasonix 桌面端当前对话（剪贴板 + 模拟按键） */
function typeToReasonix(text, send) {
  const b64 = psText64(text);
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    "$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*Reasonix*' -or $_.ProcessName -like '*reasonix*' } | Select-Object -First 1",
    "if (-not $p) { Write-Output 'NO_WINDOW'; exit 1 }",
    "$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64 + "'))",
    "Set-Clipboard -Value $t",
    "$null = $ws.AppActivate($p.Id)",
    "Start-Sleep -Milliseconds 400",
    "$ws.SendKeys('^v')",
    "Start-Sleep -Milliseconds 200",
    send ? "$ws.SendKeys('{ENTER}')" : '',
    "Write-Output 'OK'",
  ].join('\n');
  try {
    const out = ps(script, 15000);
    if (out === 'NO_WINDOW') return '未找到 Reasonix 窗口，无法输入（请先打开 Reasonix 桌面端）';
    return '已输入到 Reasonix 对话' + (send ? '并发送' : '');
  } catch (e) {
    return '输入失败：' + e.message;
  }
}

/** 截屏并保存到临时 png，返回路径 */
function takeScreenshotToFile() {
  const png = path.join(os.tmpdir(), 'qq-bridge-shot-' + Date.now() + '.png');
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${png.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
    "Write-Output 'OK'",
  ].join('\n');
  ps(script, 20000);
  return png;
}

async function runTool(name, args, ctx) {
  switch (name) {
    case 'shutdown_computer': {
      const delay = Math.max(10, Number(args.delay_seconds) || 60);
      scheduleShutdown(delay, 'QQ AI 指令关机');
      return `已执行：电脑将在 ${delay} 秒后关机（可用 cancel_shutdown 取消）。`;
    }
    case 'cancel_shutdown': {
      const ok = cancelShutdown();
      const s = readState();
      s.shutdownScheduled = false;
      delete s.shutdownAt;
      writeState(s);
      if (cfg.autoShutdownOnDone) {
        cfg.autoShutdownOnDone = false;
        saveConfig(cfg);
      }
      return ok ? '已取消关机，并解除"这次运行完关机"。' : '没有正在进行的关机（或取消失败）。';
    }
    case 'arm_shutdown_after_tasks': {
      cfg.autoShutdownOnDone = true;
      saveConfig(cfg);
      return '已设置「这次运行完关机」：等所有项目都运行完（连续无活动）后自动关机，本次有效，关机后自动解除。';
    }
    case 'disarm_shutdown': {
      cfg.autoShutdownOnDone = false;
      saveConfig(cfg);
      return '已解除「这次运行完关机」，之后不会再自动关机。';
    }
    case 'send_file': {
      await uploadAndSendFile(String(args.path), ctx.chatType, ctx.openid);
      return `文件已发送到 QQ：${args.path}`;
    }
    case 'list_recent_files': {
      return listRecentFiles(args.dir, args.minutes);
    }
    case 'type_to_reasonix': {
      return typeToReasonix(String(args.text), args.send !== false);
    }
    case 'run_command': {
      try {
        const out = execFileSync('cmd.exe', ['/c', String(args.command)], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd: args.cwd || os.homedir() });
        return '执行结果：\n' + truncate(String(out || ''), 2000);
      } catch (e) {
        return '执行失败：' + truncate(String(e.stdout || e.message || ''), 1500);
      }
    }
    case 'run_powershell': {
      try {
        const out = ps(String(args.command), 30000, args.cwd);
        return '执行结果：\n' + truncate(out, 2000);
      } catch (e) {
        return '执行失败：' + truncate(String(e.stdout || e.message || ''), 1500);
      }
    }
    case 'open_url': {
      execFileSync('cmd.exe', ['/c', 'start', '', String(args.url)], { windowsHide: true });
      return `已打开：${args.url}`;
    }
    case 'open_path': {
      try {
        execFileSync('cmd.exe', ['/c', 'start', '', String(args.path)], { windowsHide: true });
        return `已打开：${args.path}`;
      } catch (e) {
        return '打开失败：' + e.message;
      }
    }
    case 'take_screenshot': {
      try {
        const png = takeScreenshotToFile();
        await uploadAndSendFile(png, ctx.chatType, ctx.openid);
        try { fs.unlinkSync(png); } catch {}
        return '截图已发送到 QQ。';
      } catch (e) {
        return '截屏失败：' + e.message;
      }
    }
    case 'list_processes': {
      try {
        const top = Math.max(5, Math.min(50, Number(args.top) || 20));
        const out = ps("Get-Process | Sort-Object CPU -Descending | Select-Object -First " + top + " Name,Id,CPU | ConvertTo-Json -Compress", 20000);
        const arr = JSON.parse(out || '[]');
        const rows = Array.isArray(arr) ? arr : [arr];
        return rows.map((p) => `${p.Name}（PID ${p.Id}${p.CPU != null ? ', CPU ' + Math.round(p.CPU) + 's' : ''}）`).join('\n');
      } catch (e) {
        return '获取进程失败：' + e.message;
      }
    }
    case 'kill_process': {
      try {
        if (args.pid) { ps("Stop-Process -Id " + Number(args.pid) + " -Force -ErrorAction Stop"); return `已结束进程 PID ${args.pid}。`; }
        if (args.name) { ps("Stop-Process -Name '" + String(args.name).replace(/'/g, "''") + "' -Force -ErrorAction Stop"); return `已结束进程 ${args.name}。`; }
        return '需要提供 name 或 pid。';
      } catch (e) {
        return '结束进程失败：' + e.message;
      }
    }
    case 'get_clipboard': {
      try {
        const out = ps("$t = Get-Clipboard -Raw; if ($null -eq $t -or $t -eq '') { Write-Output 'EMPTY' } else { [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)) }", 10000);
        if (out === 'EMPTY') return '（剪贴板为空）';
        return truncate(psDecode64(out), 1500);
      } catch (e) {
        return '读取剪贴板失败：' + e.message;
      }
    }
    case 'set_clipboard': {
      try {
        const b64 = psText64(args.text);
        ps("Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64 + "')))", 10000);
        return '已写入剪贴板。';
      } catch (e) {
        return '写入剪贴板失败：' + e.message;
      }
    }
    case 'get_system_info': {
      try {
        const out = ps([
          "$os = Get-CimInstance Win32_OperatingSystem",
          "$cs = Get-CimInstance Win32_ComputerSystem",
          "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
          "$uptime = (Get-Date) - $os.LastBootUpTime",
          "Write-Output ('OS: ' + $os.Caption + ' ' + $os.Version)",
          "Write-Output ('Memory: ' + [math]::Round($cs.TotalPhysicalMemory/1GB,1) + ' GB')",
          "Write-Output ('CPU: ' + $cpu.Name)",
          "Write-Output ('Uptime: ' + [math]::Floor($uptime.TotalHours) + ' hours')",
          "Write-Output ('Host: ' + $cs.Manufacturer + ' ' + $cs.Model)",
        ].join('\n'), 25000);
        return out || '（无信息）';
      } catch (e) {
        return '获取系统信息失败：' + e.message;
      }
    }
    case 'reboot_computer': {
      const delay = Math.max(10, Number(args.delay_seconds) || 30);
      if (process.env.QQ_BRIDGE_DRY_SHUTDOWN === '1') {
        return `[dry-run] 将执行: shutdown /r /t ${delay}（电脑将在 ${delay} 秒后重启）`;
      }
      exec(`shutdown /r /t ${delay} /c "qq-bridge: QQ AI 指令重启"`, (e) => { if (e) console.error('重启失败：' + e.message); });
      return `已执行：电脑将在 ${delay} 秒后重启（可用 cancel_shutdown 取消）。`;
    }
    case 'lock_computer': {
      try {
        execFileSync('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
        return '已锁定电脑。';
      } catch (e) {
        return '锁定失败：' + e.message;
      }
    }
    case 'read_file': {
      try {
        const p = String(args.path);
        const buf = fs.readFileSync(p, 'utf8');
        return truncate(buf, 2000);
      } catch (e) {
        return '读取失败：' + e.message;
      }
    }
    case 'search_files': {
      return searchFilesByKeyword(args.keyword, args.dir);
    }
    case 'get_disk_usage': {
      try {
        const out = ps("Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -HideTableHeaders", 20000);
        return out || '（无信息）';
      } catch (e) {
        return '获取磁盘信息失败：' + e.message;
      }
    }
    case 'set_reminder': {
      const minutes = Math.max(1, Number(args.minutes) || 10);
      const text = String(args.text || '提醒');
      const s = readState();
      const list = s.reminders || [];
      list.push({ at: Date.now() + minutes * 60000, text, chatType: ctx.chatType, openid: ctx.openid });
      s.reminders = list;
      writeState(s);
      return `已设置：${minutes} 分钟后提醒「${text}」。`;
    }
    case 'wait_for_file': {
      const file = String(args.path);
      const minutes = Math.max(1, Number(args.minutes) || 60);
      const s = readState();
      const list = s.waiting || [];
      list.push({ path: file, until: Date.now() + minutes * 60000, sendFile: !!args.send_file, chatType: ctx.chatType, openid: ctx.openid });
      s.waiting = list;
      writeState(s);
      return `已开始等待文件：${file}（最多 ${minutes} 分钟），出现后会通知你${args.send_file ? '并发送文件' : ''}。`;
    }
    case 'get_balance': {
      try {
        return await getDeepSeekBalance();
      } catch (e) {
        return '余额查询失败：' + e.message;
      }
    }
    case 'get_status': {
      const s = readState();
      return JSON.stringify({
        aiModel: aiConfig().model,
        chatType: ctx.chatType,
        openid: ctx.openid,
        workspace: cfg.workspace || os.homedir(),
        allowedOpenids: cfg.allowedOpenids || [],
        autoShutdownOnDone: !!cfg.autoShutdownOnDone,
        shutdownMode: cfg.shutdownMode || 'all_done',
        shutdownScheduled: !!s.shutdownScheduled,
        reminders: (s.reminders || []).map((r) => ({ at: new Date(r.at).toLocaleString(), text: r.text })),
        waitingFiles: (s.waiting || []).map((w) => w.path),
        lastActivity: s.lastActivity ? new Date(s.lastActivity).toLocaleString() : null,
      }, null, 2);
    }
    default:
      return `未知工具：${name}`;
  }
}

async function callDeepSeek(messages, tools) {
  const ai = aiConfig();
  if (!ai.key) throw new Error('缺少 DEEPSEEK_API_KEY（%APPDATA%\\reasonix\\.env）');
  const body = { model: ai.model, messages, max_tokens: 2048 };
  if (tools) body.tools = tools;
  const res = await fetchWithRetry(`${ai.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });  const txt = await res.text();
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${truncate(txt, 300)}`);
  return JSON.parse(txt);
}

// 对话历史（持久化到 state.json 的 aiHistory 字段，重启不丢；每对话最多 20 条）
const aiHistory = new Map();
function chatKey(chatType, openid) { return `${chatType}:${openid}`; }
function saveHistory() {
  const s = readState();
  s.aiHistory = Object.fromEntries(aiHistory);
  writeState(s);
}
function loadHistory() {
  const s = readState();
  if (s.aiHistory && typeof s.aiHistory === 'object') {
    for (const [k, v] of Object.entries(s.aiHistory)) aiHistory.set(k, v);
  }
}

/** 处理一条用户消息：DeepSeek 工具循环，返回最终回复文本 */
async function handleAIChat(chatType, openid, userText) {
  const ai = aiConfig();
  if (!ai.enabled) return null;
  const k = chatKey(chatType, openid);
  const history = (aiHistory.get(k) || []).slice(-20);
  history.push({ role: 'user', content: userText });
  aiHistory.set(k, history);

  const messages = [{ role: 'system', content: ai.system }, ...history];
  let reply = '';
  const executed = [];
  for (let i = 0; i < 5; i++) {
    const resp = await callDeepSeek(messages, AI_TOOLS);
    const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) { reply = '（无回复）'; break; }
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          result = await runTool(tc.function.name, args, { chatType, openid });
        } catch (e) {
          result = '工具执行失败：' + e.message;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        executed.push(`${tc.function.name}${tc.function.arguments && tc.function.arguments !== '{}' ? '(' + truncate(tc.function.arguments, 60) + ')' : ''}`);
        console.log(`[AI] 工具 ${tc.function.name} → ${truncate(result, 100)}`);
      }
      continue;
    }
    reply = msg.content || '';
    break;
  }
  if (!reply) {
    reply = executed.length
      ? '（本轮我执行了以下操作，但还没有生成总结，请再说一遍需求）\n已执行：' + executed.join('、')
      : '（AI 未能生成回复，请重试）';
  }
  history.push({ role: 'assistant', content: reply });
  aiHistory.set(k, history.slice(-20));
  saveHistory();
  return reply;
}

/** 查询 Reasonix 桌面端活跃会话数（[bot.control] /status）；null 表示无法判断 */
async function reasonixActiveSessions() {
  const token = env.REASONIX_BOT_CONTROL_TOKEN;
  if (!token) return null;
  try {
    const res = await fetchWithRetry('http://127.0.0.1:37913/status', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    }, 1);
    if (!res.ok) return null;
    const j = await res.json();
    // 宽容解析：递归找会话/活跃计数
    function scan(node) {
      if (node == null) return null;
      if (Array.isArray(node)) return node.length > 0 ? node.length : null;
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          const kk = k.toLowerCase();
          if (typeof v === 'number' && (kk.includes('active') || kk.includes('session') || kk.includes('turn'))) return v;
          const r = scan(v);
          if (r != null) return r;
        }
      }
      return null;
    }
    const n = scan(j);
    return n == null ? null : n;
  } catch { return null; }
}

/** 同一对话的消息串行处理（避免并发错乱），AI 回复发回该对话 */
const chatLocks = new Map();
function enqueueChat(chatType, openid, content) {
  // 白名单：默认只响应 config 中保存的目标 openid；可配置 allowedOpenids 扩展
  const allow = cfg.allowedOpenids;
  if (Array.isArray(allow) && allow.length ? !allow.includes(openid) : openid !== cfg.openid) {
    console.log(`[AI] 忽略非白名单消息（${openid}）：${truncate(content, 60)}`);
    return;
  }
  const k = chatKey(chatType, openid);
  const prev = chatLocks.get(k) || Promise.resolve();
  const next = prev
    .then(() => handleAIChat(chatType, openid, content))
    .then((reply) => { if (reply) return sendText(reply, chatType, openid); })
    .catch((e) => {
      console.error('[AI] 处理失败：' + e.message);
      // 报错（如余额不足/超时）直接发到 QQ，让用户知道
      notifyQQ('error', 'AI 处理出错：' + e.message);
    });
  chatLocks.set(k, next);
  next.finally(() => { if (chatLocks.get(k) === next) chatLocks.delete(k); });
}

// ---------------------------------------------------------------------------
// QQ OpenAPI
// ---------------------------------------------------------------------------

let tokenCache = { token: '', expiresAt: 0 };

/** 带重试的 fetch（网络抖动时自动重试，指数退避） */
async function fetchWithRetry(url, opts, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getAccessToken(force) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - 60 * 1000) return tokenCache.token;
  // 磁盘缓存：hook 每次都是独立进程，从 state.json 恢复上次的 token，避免每次都等鉴权请求
  if (!force && !tokenCache.token) {
    try {
      const s = readState();
      if (s.tokenCache && s.tokenCache.token && Date.now() < s.tokenCache.expiresAt - 60 * 1000) {
        tokenCache = { token: s.tokenCache.token, expiresAt: s.tokenCache.expiresAt };
        return tokenCache.token;
      }
    } catch {}
  }
  if (!SECRET) {
    throw new Error('缺少 appSecret：请在 config.json 填 appSecret，或确保 %APPDATA%\\reasonix\\.env 有 QQ_BOT_APP_SECRET');
  }
  const body = JSON.stringify({ appId: APP_ID, clientSecret: SECRET });
  let lastErr = null;
  for (const url of ['https://bots.qq.com/app/getAppAccessToken', 'https://api.bot.qq.com/app/getAppAccessToken']) {
    try {
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const txt = await res.text();
      if (!res.ok) {
        // 凭据/状态问题，换域名也无济于事
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          throw new Error(`getAppAccessToken ${res.status}: ${truncate(txt, 200)}`);
        }
        lastErr = new Error(`getAppAccessToken ${res.status}: ${truncate(txt, 200)}`);
        continue;
      }
      const j = JSON.parse(txt);
      tokenCache = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 7200) * 1000 };
      // 持久化，供后续 hook 进程直接复用
      try {
        const s = readState();
        s.tokenCache = tokenCache;
        writeState(s);
      } catch {}
      return tokenCache.token;
    } catch (e) {
      if (e instanceof Error && /getAppAccessToken \d+/.test(e.message)) throw e; // 凭据错误直接抛
      lastErr = e;
    }
  }
  throw lastErr || new Error('获取 access_token 失败');
}

/** 从 /gateway 拿 WSS 地址并推导 API 域名；失败时退回默认 */
let ENDPOINT_CACHE = { at: 0, ws: '', api: '' };

/** 从 /gateway 拿 WSS 地址并推导 API 域名；失败时退回默认。结果缓存 10 分钟 + 磁盘持久化（每次发送都请求 gateway 是浪费） */
async function getEndpoints(force) {
  if (!force && ENDPOINT_CACHE.at && Date.now() - ENDPOINT_CACHE.at < 10 * 60 * 1000) {
    return { ws: ENDPOINT_CACHE.ws, api: ENDPOINT_CACHE.api };
  }
  if (!force && !ENDPOINT_CACHE.at) {
    try {
      const s = readState();
      if (s.endpointCache && s.endpointCache.at && Date.now() - s.endpointCache.at < 10 * 60 * 1000) {
        ENDPOINT_CACHE = { at: s.endpointCache.at, ws: s.endpointCache.ws, api: s.endpointCache.api };
        return { ws: s.endpointCache.ws, api: s.endpointCache.api };
      }
    } catch {}
  }
  try {
    const token = await getAccessToken();
    const res = await fetchWithRetry('https://api.sgroup.qq.com/gateway', {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const j = await res.json();
      const m = String(j.url || '').match(/^wss:\/\/([^/]+)/);
      if (m) {
        ENDPOINT_CACHE.at = Date.now();
        ENDPOINT_CACHE.ws = j.url;
        ENDPOINT_CACHE.api = 'https://' + m[1];
        try {
          const s = readState();
          s.endpointCache = { at: ENDPOINT_CACHE.at, ws: ENDPOINT_CACHE.ws, api: ENDPOINT_CACHE.api };
          writeState(s);
        } catch {}
        return { ws: j.url, api: 'https://' + m[1] };
      }
    }
  } catch {}
  return { ws: DEFAULT_WS, api: 'https://api.sgroup.qq.com' };
}

const ERR_HINTS = {
  '40054004': '无好友关系，请先与 bot 建立好友/会话',
  '40054006': '验证好友关系失败，请重试',
  '40054007': '消息长度超限',
  '40054013': '用户已拒收主动消息：请在 QQ 客户端里给 bot 打开「允许主动发送」',
  '40054016': '机器人已下线，请检查机器人状态',
  '40034100': '主动消息超过频控限制',
  '40034105': '主动消息无权限，请检查机器人权限/发布状态',
  '40034006': '消息内容违规',
  '304103': '消息 ID 已过期',
};

/** 按最大长度分段（尽量在换行处断开） */
function splitLong(text, max) {
  const parts = [];
  let s = String(text == null ? '' : text);
  while (s.length > max) {
    let cut = s.slice(0, max);
    const nl = cut.lastIndexOf('\n');
    if (nl > max * 0.5) cut = s.slice(0, nl);
    parts.push(cut);
    s = s.slice(cut.length);
  }
  if (s.length) parts.push(s);
  return parts;
}

/** 发一条文本（单条，≤max 字符） */
async function sendTextOnce(text, chatType, openid) {
  if (!openid) {
    throw new Error('config.json 未配置 openid：请先运行 `node bridge.js discover`，然后给 bot 发一条消息（或把 bot 拉进群发一条），openid 会自动写入');
  }
  const token = await getAccessToken();
  const { api } = await getEndpoints();
  const oid = encodeURIComponent(openid);
  const url = chatType === 'group'
    ? `${api}/v2/groups/${oid}/messages`
    : `${api}/v2/users/${oid}/messages`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 0, content: text }),
    signal: AbortSignal.timeout(15000),
  });
  const txt = await res.text();
  if (!res.ok) {
    let hint = '';
    for (const [code, h] of Object.entries(ERR_HINTS)) if (txt.includes(code)) hint = `（${h}）`;
    throw new Error(`发送失败 ${res.status}: ${truncate(txt, 300)}${hint}`);
  }
  return txt;
}

/** 发文本（自动按 3800 字符分段，长回复也能完整送达） */
async function sendText(text, chatType, openid) {
  let last;
  for (const part of splitLong(text, 3800)) {
    last = await sendTextOnce(part, chatType, openid);
  }
  return last;
}

/** 发文本（默认发送目标） */
function sendMessage(text) {
  return sendText(text, cfg.chatType, cfg.openid);
}

// ---------------------------------------------------------------------------
// 分级通知：除工具报错外，任何报错都发 QQ
//   level: 'info'（提示） | 'action'（需操作） | 'error'（报错）
// ---------------------------------------------------------------------------

const NOTIFY_LEVELS = { info: ['ℹ️', '提示'], action: ['⚠️', '需操作'], error: ['❌', '报错'] };
const notifyThrottle = {};

/** 发分级通知到 QQ（带 5 分钟同内容节流，防错误刷屏；通知本身失败静默） */
function notifyQQ(level, message) {
  const [icon, name] = NOTIFY_LEVELS[level] || NOTIFY_LEVELS.info;
  const key = level + ':' + String(message).slice(0, 30);
  const now = Date.now();
  if (notifyThrottle[key] && now - notifyThrottle[key] < 5 * 60 * 1000) return;
  notifyThrottle[key] = now;
  const text = `${icon} [${name}] ${message}`;
  console.log(`[${name}] ${message}`);
  sendMessage(text).catch(() => {}); // 通知发送失败静默，避免递归
}

// ---------------------------------------------------------------------------
// QQ 文件上传（分片）并发送（msg_type=7）
// ---------------------------------------------------------------------------

const crypto = require('crypto');

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function guessFileType(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 1; // 图片
  if (ext === 'mp4') return 2;                                              // 视频
  if (['silk', 'mp3', 'wav', 'ogg'].includes(ext)) return 3;                // 语音
  return 4;                                                                 // 文件
}

/** 分片上传本地文件到 QQ，返回 file_info；然后发送媒体消息 */
async function uploadAndSendFile(filePath, chatType, openid) {
  if (!openid) throw new Error('未配置 openid');
  const fs2 = fs; // fs 已引入
  let stat;
  try { stat = fs2.statSync(filePath); } catch { throw new Error(`文件不存在：${filePath}`); }
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  const fileSize = stat.size;
  if (fileSize > 200 * 1024 * 1024) throw new Error('文件超过 200MB 上限');

  const token = await getAccessToken();
  const { api } = await getEndpoints();
  const oid = encodeURIComponent(openid);
  const scene = chatType === 'group' ? 'groups' : 'users';
  const fileName = path.basename(filePath);
  const fileType = guessFileType(fileName);

  // 预上传
  const fullBuf = fs2.readFileSync(filePath);
  const md5Whole = md5(fullBuf);
  const md510 = md5(fullBuf.subarray(0, 10002432));
  const sha1Whole = sha1(fullBuf);
  const prepareRes = await fetchWithRetry(`${api}/v2/${scene}/${oid}/upload_prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify({ file_type: fileType, file_size: String(fileSize), file_name: fileName, md5: md5Whole, sha1: sha1Whole, md5_10m: md510 }),
    signal: AbortSignal.timeout(20000),
  });
  const prepareTxt = await prepareRes.text();
  if (!prepareRes.ok) throw new Error(`预上传失败 ${prepareRes.status}: ${truncate(prepareTxt, 200)}`);
  const prep = JSON.parse(prepareTxt);
  const { upload_id: uploadId, parts } = prep;

  // 逐片 PUT + part_finish（用累计偏移，避免依赖 index 起始值）
  let offset = 0;
  for (const part of parts || []) {
    const size = Number(part.block_size);
    const chunk = fullBuf.subarray(offset, offset + size);
    offset += size;
    const putRes = await fetchWithRetry(part.presigned_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
      signal: AbortSignal.timeout(120000),
    }, 1); // 大文件分片重试=浪费时间：只试 1 次，失败快速返回
    if (!putRes.ok) throw new Error(`分片 ${part.index} PUT 失败 ${putRes.status}（文件较大或网络较慢时上传可能超时）`);
    const finishRes = await fetchWithRetry(`${api}/v2/${scene}/${oid}/upload_part_finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      body: JSON.stringify({ upload_id: uploadId, part_index: part.index, block_size: String(size), md5: md5(chunk) }),
      signal: AbortSignal.timeout(20000),
    });
    const finishTxt = await finishRes.text();
    if (!finishRes.ok) throw new Error(`分片 ${part.index} 完成确认失败 ${finishRes.status}: ${truncate(finishTxt, 300)}`);
  }

  // 合并获取 file_info
  const mergeRes = await fetchWithRetry(`${api}/v2/${scene}/${oid}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify({ upload_id: uploadId }),
    signal: AbortSignal.timeout(20000),
  });
  const mergeTxt = await mergeRes.text();
  if (!mergeRes.ok) throw new Error(`合并上传失败 ${mergeRes.status}: ${truncate(mergeTxt, 200)}`);
  const fileInfo = JSON.parse(mergeTxt).file_info;
  if (!fileInfo) throw new Error('上传成功但未返回 file_info');

  // 发送媒体消息
  const msgRes = await fetchWithRetry(`${api}/v2/${scene}/${oid}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo } }),
    signal: AbortSignal.timeout(20000),
  });
  const msgTxt = await msgRes.text();
  if (!msgRes.ok) throw new Error(`发送文件消息失败 ${msgRes.status}: ${truncate(msgTxt, 200)}`);
  return msgTxt;
}

// ---------------------------------------------------------------------------
// hooks 消息构造
// ---------------------------------------------------------------------------

const STRONG_ERR = /(\b(error|failed|failure|exception|fatal|panic|denied|timeout|timed out|refused|unreachable)\b|exit status \d+|exit code \d+|stderr|报错|失败|异常|拒绝|无法|超时|找不到|不存在)/i;
const FALSE_POS = /(no error|errors?:?\s*0|0 errors?|no failures|success|成功|通过|已修复|正常运行|无错误)/i;

function projectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 去掉推送文本里的 markdown 格式符号（保留文字内容） */
function cleanMd(s) {
  return String(s == null ? '' : s)
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')      // 代码块：去围栏，保留内容
    .replace(/`([^`\n]+)`/g, '$1')                      // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')           // 图片 ![alt](url) → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // 链接 [text](url) → text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')                // **粗体**
    .replace(/__([^_\n]+)__/g, '$1')                    // __粗体__
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')    // *斜体*
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')      // _斜体_
    .replace(/~~([^~\n]+)~~/g, '$1')                    // ~~删除线~~
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')                 // 行首 # 标题
    .replace(/^\s{0,3}>\s?/gm, '')                      // 行首 > 引用
    .replace(/^\s*[-*+]\s+/gm, '')                      // 行首 -/*/+ 列表
    .replace(/^\s*\d+[.)]\s+/gm, '')                    // 行首 1. 有序列表
    .replace(/(^|\s)\$([^$\n]*)\$(?=\s|$)/gm, '$1$2')   // $...$ 成对美元符
    .replace(/^\s*\$+\s*/gm, '')                        // 行首 $（shell 提示符）
    .replace(/^\s*[-=*_]{3,}\s*$/gm, '')                // 分隔线
    .replace(/[ \t]+$/gm, '')                           // 行尾空白
    .replace(/\n{3,}/g, '\n\n')                         // 压缩多余空行
    .trim();
}

/** DeepSeek 账号余额（官方 /user/balance 接口） */
async function getDeepSeekBalance() {
  const ai = aiConfig();
  if (!ai.key) throw new Error('缺少 DEEPSEEK_API_KEY');
  const res = await fetchWithRetry(`${ai.base}/user/balance`, {
    headers: { Authorization: `Bearer ${ai.key}` },
    signal: AbortSignal.timeout(15000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`余额查询失败 ${res.status}: ${truncate(txt, 200)}`);
  const j = JSON.parse(txt);
  const infos = (j.balance_infos || []).map((b) =>
    `${b.currency} 总余额 ${b.total_balance}（充值 ${b.topped_up_balance || 0} / 赠送 ${b.granted_balance || 0}）`
  );
  return infos.length ? infos.join('；') : '（无余额信息）';
}

/** 尝试从 Reasonix 本地接口获取会话费用/token；不可用返回 null */
async function getReasonixCost() {
  const token = env.REASONIX_BOT_CONTROL_TOKEN;
  if (!token) return null;
  for (const url of ['http://127.0.0.1:37913/status', 'http://127.0.0.1:37913/metrics']) {
    try {
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }, 1);
      if (!res.ok) continue;
      const j = await res.json();
      // 宽容解析：找 cost / tokens / usage 字段
      function scan(node, pathStr) {
        if (node == null) return null;
        if (Array.isArray(node)) { for (const it of node) { const r = scan(it, pathStr); if (r) return r; } return null; }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            const kk = k.toLowerCase();
            if (typeof v === 'number' && (kk.includes('cost') || kk.includes('token') || kk.includes('usage'))) return { key: pathStr + '.' + k, value: v };
            const r = scan(v, pathStr + '.' + k);
            if (r) return r;
          }
        }
        return null;
      }
      const hit = scan(j, '');
      if (hit) return hit;
    } catch {}
  }
  return null;
}

/** 生成 Stop 推送标题：✅ [项目文件夹名] 本轮对话结束（turn N）｜MM-DD HH:mm（UTC+8） */
function stopTitle(ev) {
  const proj = projectName(ev.cwd); // cwd 最后一段 = 当前项目文件夹名
  const tag = proj ? `[${proj}]` : '';
  // 真实轮数：从 Reasonix 会话 JSONL 读取（排除系统注入的 user 消息）；失败回退 payload.turn
  const realTurn = getRealTurn(ev.cwd) || ev.turn;
  const turn = realTurn != null ? `（turn ${realTurn}）` : '';
  // UTC+8 时间（不依赖系统时区）
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  return `✅ ${tag} 本轮对话结束${turn} ｜ ${ts}`.replace(/\s+/g, ' ').trim();
}

/**
 * 从 Reasonix 本地会话文件读取"真实用户轮数"：
 * 1. desktop-tabs.json → 当前标签页 sessionPath
 * 2. 读会话 JSONL，统计真正的用户输入（排除 capability-route / reasoning-language 等系统注入）
 * 只读，不改动任何 Reasonix 文件。
 */
function getRealTurn(cwd) {
  try {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const tabsFile = path.join(appdata, 'reasonix', 'desktop-tabs.json');
    if (!fs.existsSync(tabsFile)) return null;
    const tabs = JSON.parse(fs.readFileSync(tabsFile, 'utf8')).tabs || [];
    if (!tabs.length) return null;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    let tab = null;
    if (cwd) tab = tabs.find((t) => norm(t.workspaceRoot) === norm(cwd));
    if (!tab) tab = tabs.find((t) => t.sessionPath);
    if (!tab || !tab.sessionPath || !fs.existsSync(tab.sessionPath)) return null;
    const sysMarkers = ['<capability-route', '<reasoning-language', '<response-language'];
    let turn = 0;
    for (const line of fs.readFileSync(tab.sessionPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.role === 'user' && !sysMarkers.some((m) => String(o.content || '').startsWith(m))) turn++;
      } catch {}
    }
    return turn || null;
  } catch {
    return null;
  }
}

/** 用 DeepSeek 把 Stop 会话回复原文缩句为 200 字以内要点；失败时降级为截断原文 */
async function summarizeByAI(text) {
  const ai = aiConfig();
  const raw = String(text || '').trim();
  if (!ai.key || !raw) return truncate(text || '', 240);
  // 短文本直接返回，不调 AI（省一次 DeepSeek 调用，推送更快）
  if (raw.length <= 240) return truncate(cleanMd(raw), 240);
  try {
    // 原文完整交给 AI（不删格式符号、不预截断），要求缩句 200 字以内
    const prompt = `下面是一段 Reasonix 会话回复的原文，请把它缩句/总结为 200 字以内的中文要点，保留关键结论、数据、文件名，不要添加原文没有的内容：\n\n${text}`;
    const resp = await callDeepSeek([{ role: 'user', content: prompt }]);
    const r = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    return r ? truncate(r, 240) : truncate(text, 240);
  } catch (e) {
    console.error('[qq-bridge] AI 缩句失败，降级为截断原文：' + e.message);
    return truncate(text, 240);
  }
}

function buildMessage(ev) {
  const event = ev.event;
  const proj = projectName(ev.cwd);
  const tag = proj ? `[${proj}] ` : '';
  if (event === 'Notification') {
    return `🔔 ${tag}Reasonix 需要你处理\n${truncate(cleanMd(ev.message || '(无内容)'), MAX_TEXT)}`;
  }
  if (event === 'Stop') {
    const turn = ev.turn != null ? `（turn ${ev.turn}）` : '';
    return `✅ ${tag}本轮对话结束${turn}\n${truncate(cleanMd(ev.lastAssistantText || ''), MAX_TEXT)}`;
  }
  if (event === 'PostToolUse' && cfg.notifyPostToolError !== false) {
    const r = String(ev.toolResult || '');
    if (!STRONG_ERR.test(r) || FALSE_POS.test(r)) return null;
    const tool = ev.toolName || '?';
    let args = '';
    if (ev.toolArgs && typeof ev.toolArgs === 'object') {
      args = ev.toolArgs.command ? truncate(ev.toolArgs.command, 120) : truncate(JSON.stringify(ev.toolArgs), 120);
    }
    return `⚠️ ${tag}工具执行报错：${tool}${args ? `\n命令/参数：${args}` : ''}\n${truncate(cleanMd(r), MAX_TEXT)}`;
  }
  if (event === 'SessionEnd' && cfg.notifySessionEnd) {
    return '👋 Reasonix 会话已结束';
  }
  return null;
}

// ---------------------------------------------------------------------------
// daemon：双击/守护模式 —— WebSocket 常驻，自动保存 openid，实时显示日志
// ---------------------------------------------------------------------------

function daemon() {
  resetState(); // 启动时清除历史状态，防止开机误关机
  loadHistory(); // 恢复 AI 对话历史（跨重启）
  console.log('==============================================================');
  console.log('  qq-bridge · Reasonix 事件 → QQ 消息推送（Windows）');
  console.log('==============================================================');
  console.log(`  AppID: ${APP_ID}`);
  console.log(`  secret: ${SECRET ? '已配置' : '缺失（检查 .env 的 QQ_BOT_APP_SECRET）'}`);
  if (cfg.openid) {
    console.log(`  发送目标: ${cfg.chatType === 'group' ? '群聊' : '私聊'} ${cfg.openid.slice(0, 10)}…（config.json 已配置）`);
  } else {
    console.log('  发送目标: 未配置 → 请在下面提示后给机器人发一条消息自动保存');
  }
  console.log('--------------------------------------------------------------');
  console.log('  运行中… 按 q 或 Ctrl+C 退出');
  console.log('--------------------------------------------------------------');
  let t0 = Date.now();
  const statusTimer = setInterval(() => {
    const mins = Math.floor((Date.now() - t0) / 60000);
    console.log(`  [运行 ${mins} 分钟] 持续监听 QQ 事件中…`);
  }, 60000);
  // 自动关机检查：每 30 秒
  const shutdownTimer = setInterval(checkShutdown, 30000);
  checkShutdown();
  // 定时提醒：每 15 秒
  const reminderTimer = setInterval(checkReminders, 15000);
  // 等待文件：每 10 秒
  const waitingTimer = setInterval(checkWaitingFiles, 10000);
  checkWaitingFiles();
  // 后台聊天 API（历史 + 直接发消息给 AI）
  startControlApi();

  // 自动重连循环：断线/失败后指数退避（5s→…→60s）无限重试，进程不退出
  let stopping = false;
  let heartbeat = null;
  let lastS = null;
  let firstConnect = true;
  let reconnectAttempt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function connectLoop() {
    while (!stopping) {
      try {
        const token = await getAccessToken();
        const { ws: wsUrl } = await getEndpoints();
        await startWs(token, wsUrl); // 连接断开时 resolve，循环继续
        reconnectAttempt = 0;
      } catch (e) {
        if (stopping) break;
        const delay = Math.min(60, 5 * Math.pow(2, reconnectAttempt)) * 1000;
        reconnectAttempt++;
        notifyQQ('error', `QQ 连接失败，${Math.round(delay / 1000)} 秒后自动重连：${e.message}`);
        await sleep(delay);
      }
    }
  }
  connectLoop();

  function startWs(token, wsUrl) {
    return new Promise((resolve) => {
      console.log(`  连接 ${wsUrl} …`);
      const ws = new WebSocket(wsUrl);

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(String(e.data)); } catch { return; }
        if (msg.op === 10) { // HELLO
          const interval = (msg.d && msg.d.heartbeat_interval) || 45000;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: lastS }));
          }, interval);
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: 1 << 25, // GROUP_AND_C2C_EVENT
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'qq-bridge', $device: 'pc' },
            },
          }));
        } else if (msg.op === 0) { // Dispatch
          if (msg.s != null) lastS = msg.s;
          if (msg.t === 'READY') {
            console.log('  ✅ 已连接 QQ。');
            if (firstConnect) { firstConnect = false; }
            else { notifyQQ('info', 'QQ 已重新连接'); }
            if (!cfg.openid) console.log('     请在 QQ 里给机器人发一条私聊消息（或拉进群发 @机器人），openid 会自动保存。');
          } else if (msg.t === 'C2C_MESSAGE_CREATE') {
            const author = msg.d && msg.d.author;
            if (author && author.bot) return; // 忽略机器人自己
            const openid = author && author.user_openid;
            const content = String(msg.d.content || '').trim();
            if (openid) {
              cfg.chatType = 'user';
              cfg.openid = openid;
              saveConfig(cfg);
              if (!cfg.aiSeenOpenid) { console.log(`  ✅ 已保存私聊目标 user_openid=${openid}`); cfg.aiSeenOpenid = true; }
              console.log(`  📩 收到消息：${truncate(content, 80)}`);
              if (content) enqueueChat('user', openid, content);
            }
          } else if (msg.t === 'GROUP_AT_MESSAGE_CREATE' || msg.t === 'GROUP_MESSAGE_CREATE') {
            const author = msg.d && msg.d.author;
            if (author && author.bot) return;
            const gid = msg.d && msg.d.group_openid;
            const content = String(msg.d.content || '').replace(/@[^\s@]{1,64}/g, '').trim();
            if (gid) {
              cfg.chatType = 'group';
              cfg.openid = gid;
              saveConfig(cfg);
              if (!cfg.aiSeenGroup) { console.log(`  ✅ 已保存群聊目标 group_openid=${gid}`); cfg.aiSeenGroup = true; }
              if (content) enqueueChat('group', gid, content);
            }
          }
        } else if (msg.op === 7) {
          console.log('  服务端要求重连（Reconnect）');
          notifyQQ('action', 'QQ 连接需要重连（Reconnect）');
          ws.close(); // 主动断开，交给重连循环
        } else if (msg.op === 9) {
          console.error('  ❌ Invalid Session：token 无效或 intents 无权限（需在开放平台申请单聊/群聊消息权限）');
          notifyQQ('error', 'QQ 鉴权失败（Invalid Session）：token 无效或消息权限未开通');
          ws.close(); // 交给重连循环（重新获取 token 后再连）
        }
      };
      ws.onerror = () => {}; // 错误统一由 onclose 处理
      ws.onclose = (e) => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        if (stopping) { resolve(); return; }
        console.error(`  ❌ 连接关闭 code=${e.code}${e.reason ? ` reason=${e.reason}` : ''}`);
        notifyQQ('error', `QQ 连接已断开（code=${e.code}${e.reason ? '，' + e.reason : ''}），正在自动重连…`);
        resolve(); // 让 connectLoop 继续重连
      };
    });
  }
  // 手动退出（Ctrl+C / q）
  function manualExit() {
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    clearInterval(statusTimer);
    clearInterval(shutdownTimer);
    clearInterval(reminderTimer);
    clearInterval(waitingTimer);
    console.log('\n  已退出');
    process.exit(0);
  }
  process.on('SIGINT', manualExit);
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      if (String(d).trim().toLowerCase() === 'q') manualExit();
    });
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

async function selfTest() {
  console.log('qq-bridge self-test');
  console.log(`  appId: ${APP_ID}`);
  console.log(`  secret: ${SECRET ? '已配置（来自 ' + (cfg.appSecret ? 'config.json' : '环境变量/.env') + '）' : '缺失'}`);
  console.log(`  chatType: ${cfg.chatType || '(未设置)'}`);
  console.log(`  openid: ${cfg.openid || '(未设置 → 运行 node bridge.js discover)'}`);
  if (!SECRET) { console.error('无法继续：缺少 secret'); return; }
  try {
    const t = await getAccessToken(true);
    console.log(`  ✅ access_token 获取成功（有效期 2 小时，前 12 位 ${t.slice(0, 12)}…）`);
  } catch (e) {
    console.error(`  ❌ access_token 获取失败：${e.message}`);
    return;
  }
  try {
    const ep = await getEndpoints();
    console.log(`  ✅ gateway: ${ep.ws}`);
    console.log(`  ✅ api 域名: ${ep.api}`);
  } catch (e) {
    console.error(`  ❌ gateway 获取失败：${e.message}`);
  }
  if (args.includes('--send')) {
    try {
      const r = await sendMessage('🤖 qq-bridge 自检：Reasonix 通知桥已就绪');
      console.log(`  ✅ 测试消息已发送：${truncate(r, 120)}`);
    } catch (e) {
      console.error(`  ❌ 测试发送失败：${e.message}`);
    }
  } else {
    console.log('  （未发测试消息；加 --send 参数可真实发送一条）');
  }
}

/** 守护进程内处理一个事件（/api/hook 端点 & 本地回退共用）：刷新活动 + AI 缩句 + 发送 */
async function processEvent(ev) {
  touchState(ev); // 刷新活动时间 / 取消已调度关机（自动关机判定用）
  if (ev.event === 'Stop' && ev.lastAssistantText && cfg.summarizeStop !== false) {
    const content = await summarizeByAI(ev.lastAssistantText);
    return sendText(stopTitle(ev) + '\n' + content, cfg.chatType, cfg.openid);
  }
  const text = buildMessage(ev);
  if (!text) return null;
  return sendText(text, cfg.chatType, cfg.openid);
}

/** hook 模式事件转发到守护进程（/api/hook）：守护有热缓存，AI 缩句也在守护里做 */
function forwardToDaemon(ev) {
  const http = require('http');
  const body = JSON.stringify({ event: ev });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 37915, path: '/api/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000, // AI 缩句可能耗时，放宽到 60s
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error('本地转发失败：' + data.slice(0, 200)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('本地转发超时')));
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/** 守护未运行时的本地回退：直连 QQ 发送（hook 进程内，走磁盘缓存的 token/endpoints） */
function handleLocalEvent(ev) {
  processEvent(ev)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[qq-bridge]', e.message);
      notifyQQ('error', '推送失败：' + e.message);
      setTimeout(() => process.exit(0), 500);
    });
}

function hookMode() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let ev;
    try { ev = JSON.parse(raw.trim() || '{}'); } catch { process.exit(0); }
    forwardToDaemon(ev)
      .then(() => process.exit(0))
      .catch((e) => {
        console.log('[qq-bridge] 守护转发失败（' + e.message + '），本地直连处理');
        handleLocalEvent(ev);
      });
  });
  process.stdin.on('error', () => process.exit(0));
}

function dryRun() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let ev;
    try { ev = JSON.parse(raw.trim() || '{}'); } catch { console.error('payload 解析失败'); process.exit(0); }
    const text = buildMessage(ev);
    if (!text) { console.log('（此事件不会推送）'); process.exit(0); }
    console.log('将推送：\n' + text);
    process.exit(0);
  });
}

async function sendCmd() {
  const i = args.indexOf('send');
  const text = args[i + 1] === '--text' ? args[i + 2] : args[i + 1];
  if (!text) { console.error('用法：node bridge.js send --text "消息内容"'); process.exit(1); }
  try {
    const r = await sendMessage(text);
    console.log('已发送：' + truncate(r, 120));
  } catch (e) {
    console.error('发送失败：' + e.message);
    process.exit(1);
  }
}

/** 测试 DeepSeek 连通性（不发 QQ） */
async function aiPingCmd() {
  const i = args.indexOf('--ai-ping');
  const text = args[i + 1] || '你好，请用一句话自我介绍';
  try {
    const resp = await callDeepSeek([{ role: 'user', content: text }]);
    const r = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    console.log('AI 回复：' + (r || '（无回复）'));
  } catch (e) {
    console.error('AI 调用失败：' + e.message);
    process.exit(1);
  }
}

/** 发送本地文件到默认 QQ 目标（测试上传链路） */
async function sendFileCmd() {
  const i = args.indexOf('--send-file');
  const file = args[i + 1];
  if (!file) { console.error('用法：bridge.exe --send-file <文件路径>'); process.exit(1); }
  try {
    const r = await uploadAndSendFile(file, cfg.chatType, cfg.openid);
    console.log('文件已发送：' + truncate(r, 120));
  } catch (e) {
    console.error('发送文件失败：' + e.message);
    process.exit(1);
  }
}

if (args.includes('--self-test')) selfTest();
else if (args.includes('--hook')) hookMode();
else if (args.includes('--dry-run')) dryRun();
else if (args.includes('send')) sendCmd();
else if (args.includes('--stop')) stopDaemon();
else if (args.includes('--ui')) uiServer();
else if (args.includes('--ai-ping')) aiPingCmd();
else if (args.includes('--balance')) {
  Promise.allSettled([getDeepSeekBalance(), getReasonixCost()]).then(([b, c]) => {
    console.log('DeepSeek 余额：' + (b.status === 'fulfilled' ? b.value : '查询失败：' + b.reason.message));
    console.log('Reasonix 会话费用：' + (c.status === 'fulfilled' && c.value ? `${c.value.key}=${c.value.value}` : '无法获取（桌面端 bot gateway 未运行）'));
    process.exit(0);
  });
}
else if (args.includes('--send-file')) sendFileCmd();
else if (args.includes('--tool-test')) {
  const i = args.indexOf('--tool-test');
  const name = args[i + 1];
  let a = {};
  try { a = JSON.parse(args[i + 2] || '{}'); } catch {}
  runTool(name, a, { chatType: cfg.chatType, openid: cfg.openid })
    .then((r) => { console.log('结果：\n' + r); setTimeout(() => process.exit(0), 500); })
    .catch((e) => { console.error('失败：' + e.message); setTimeout(() => process.exit(1), 500); });
}
else if (args.includes('--status-check')) {
  reasonixActiveSessions().then((n) => {
    console.log('Reasonix 活跃会话数：' + (n == null ? '无法获取（null）' : n));
    process.exit(0);
  });
}
else if (args.includes('--turn-check')) {
  const i = args.indexOf('--turn-check');
  const cwd = args[i + 1] || '';
  const real = getRealTurn(cwd);
  console.log('真实轮数（会话 JSONL）：' + (real == null ? '无法读取' : real));
  console.log('匹配 cwd：' + (cwd || '(未提供，取第一个标签页)'));
  process.exit(0);
}
else if (args.includes('--daemon-bg')) { setupBgLog(); daemon(); }
else if (args.includes('discover') || args.includes('--daemon')) daemon();
else { setupBgLog(); daemon(); } // 双击 / 无参数 → 静默后台守护（日志写 bridge.log）

/** 后台静默模式：日志写 bridge.log，pid 写 bridge.pid，无窗口无交互 */
function setupBgLog() {
  // 日志轮转：超过 2MB 备份为 bridge.log.old
  try {
    const logPath = path.join(configDir(), 'bridge.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch {}
  const logFile = fs.createWriteStream(path.join(configDir(), 'bridge.log'), { flags: 'a' });
  const ts = () => '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ';
  console.log = (...a) => logFile.write(ts() + a.map(String).join(' ') + '\n');
  console.error = console.log;
  try { fs.writeFileSync(path.join(configDir(), 'bridge.pid'), String(process.pid)); } catch {}
  console.log('qq-bridge 后台守护启动 pid=' + process.pid);
}

/** 停止后台守护进程（读 bridge.pid） */
function stopDaemon() {
  const pidFile = path.join(configDir(), 'bridge.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
  if (!pid) { console.error('未找到 bridge.pid（守护进程可能未运行）'); process.exit(1); }
  try {
    process.kill(pid);
    console.log('已停止守护进程 PID ' + pid);
  } catch (e) {
    console.error('停止失败（' + e.message + '）。可尝试：taskkill /F /PID ' + pid);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// --ui：本地设置页面（浏览器打开，零依赖）
// ---------------------------------------------------------------------------

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qq-bridge 设置</title>
<style>
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#f2f4f7;margin:0;padding:20px;color:#1f2329}
  .wrap{max-width:560px;margin:0 auto}
  h1{font-size:20px}
  .card{background:#fff;border-radius:10px;padding:16px 18px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .card h2{font-size:15px;margin:0 0 12px;color:#3370ff}
  .row{display:flex;align-items:center;justify-content:space-between;margin:10px 0;gap:10px}
  .row label{flex:1}
  .row input[type=number]{width:90px;padding:6px 8px;border:1px solid #d0d5dd;border-radius:6px}
  .row input[type=checkbox]{width:18px;height:18px}
  .desc{font-size:12px;color:#8a919f;margin-top:2px}
  .btn{background:#3370ff;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;margin:6px 6px 0 0}
  .btn.gray{background:#e8ebf0;color:#1f2329}
  .btn.red{background:#f53f3f}
  .status{font-size:13px;background:#f7f8fa;border-radius:6px;padding:10px 12px;margin-top:8px;line-height:1.8}
  .status b{color:#3370ff}
  .tag{display:inline-block;background:#e8f1ff;color:#3370ff;border-radius:4px;padding:1px 8px;font-size:12px;margin-left:6px}
  .ok{color:#00b42a}
  .warn{color:#f53f3f}
  .chatbox{background:#f7f8fa;border:1px solid #e5e8ef;border-radius:8px;max-height:300px;overflow-y:auto;padding:10px;font-size:12px;line-height:1.7}
  .chatbox .msg{margin:4px 0;padding:6px 8px;border-radius:6px;white-space:pre-wrap;word-break:break-word}
  .chatbox .msg.user{background:#e8f1ff}
  .chatbox .msg.ai{background:#fff}
  .chatbox .msg .who{font-weight:bold;margin-right:6px;color:#3370ff}
  .chatbox .msg .who.ai{color:#00b42a}
  #toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 18px;border-radius:6px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>qq-bridge 设置 <span class="tag">Reasonix → QQ</span></h1>

  <div class="card">
    <h2>🔌 自动关机</h2>
    <div class="row">
      <label>这次运行完关机<div class="desc">在 QQ 对机器人说「这次运行完关机」即可开启（一次性，关完自动解除）</div></label>
      <input type="checkbox" id="autoShutdown">
    </div>
    <div class="row">
      <label>连续无活动判定为完成（分钟）<div class="desc">任务停止活动超过该时长，视为已完成</div></label>
      <input type="number" id="idleMinutes" min="1" max="120">
    </div>
    <div class="row">
      <label>关机前倒计时（秒）<div class="desc">留时间给你取消，也保证消息先送达</div></label>
      <input type="number" id="shutdownDelay" min="10" max="600">
    </div>
    <div class="row">
      <label>关机条件</label>
      <span style="font-size:13px">
        <label style="margin-right:10px"><input type="radio" name="shutdownMode" value="all_done"> 所有项目结束</label>
        <label><input type="radio" name="shutdownMode" value="idle"> 仅空闲</label>
      </span>
    </div>
    <div class="desc">「所有项目结束」= 连续无活动 + Reasonix 无活跃会话才关机（默认）；「仅空闲」= 只看空闲时间</div>
    <button class="btn" onclick="save()">保存设置</button>
    <button class="btn red" onclick="cancelShutdown()">取消关机</button>
  </div>

  <div class="card">
    <h2>🤖 AI 聊天（QQ → DeepSeek）</h2>
    <div class="row">
      <label>启用 AI 回复<div class="desc">给机器人发消息 → 走 DeepSeek 智能回复（可控制电脑）</div></label>
      <input type="checkbox" id="aiEnabled">
    </div>
    <div class="row">
      <label>模型</label>
      <input type="text" id="aiModel" style="width:200px">
    </div>
    <div class="row">
      <label>回复字数上限<div class="desc">AI 输出压缩到该字数内（QQ 单条消息友好），默认 400</div></label>
      <input type="number" id="maxAiReply" min="50" max="3000" style="width:90px">
    </div>
    <div class="row">
      <label>System 提示词<div class="desc">定义 AI 角色与可用工具（关机/取消/发文件/远程输入 Reasonix）</div></label>
    </div>
    <textarea id="aiSystem" style="width:100%;box-sizing:border-box;height:100px;padding:8px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px"></textarea>
    <button class="btn" onclick="save()">保存设置</button>
    <button class="btn gray" onclick="aiPing()">测试 AI 连接</button>
  </div>

  <div class="card">
    <h2>🔔 消息推送</h2>
    <div class="row">
      <label>结束通知内容用 AI 缩句<div class="desc">不直接发全文，由 DeepSeek 缩句为 200 字以内</div></label>
      <input type="checkbox" id="summarizeStop">
    </div>
    <div class="row">
      <label>工具执行报错推送</label>
      <input type="checkbox" id="toolError">
    </div>
    <div class="row">
      <label>会话结束推送</label>
      <input type="checkbox" id="sessionEnd">
    </div>
    <button class="btn" onclick="save()">保存设置</button>
    <button class="btn gray" onclick="testMsg()">发送测试消息</button>
  </div>

  <div class="card">
    <h2>💬 后台对话（不经 QQ）</h2>
    <div class="desc" style="margin-bottom:8px">直接给 AI 发消息、查看对话历史（需后台守护运行中）</div>
    <div id="chatHistory" class="chatbox"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input type="text" id="chatInput" placeholder="给 AI 发消息…" style="flex:1;padding:8px;border:1px solid #d0d5dd;border-radius:6px">
      <button class="btn" onclick="sendToAI()">发送</button>
    </div>
    <div class="desc" style="margin-top:6px">发消息前按 Enter 也可发送</div>
  </div>

  <div class="card">
    <h2>ℹ️ 状态</h2>
    <div class="status">
      发送目标：<b id="openid">-</b>（<span id="chatType">-</span>）<br>
      关机调度：<span id="shutdownState">无</span><br>
      最后活动：<span id="lastActivity">-</span>（<span id="lastEvent">-</span>）<br>
      项目：<span id="project">-</span><br>
      DeepSeek 余额：<span id="balance">-</span><br>
      会话费用：<span id="cost">-</span>
    </div>
    <div class="desc" style="margin-top:8px">守护进程（bridge.exe --daemon-bg）常驻时自动关机检查每 30 秒执行一次；推送由桌面端 hooks 调用，不依赖本页面。</div>
  </div>
</div>
<div id="toast"></div>
<script>
function toast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg; t.style.opacity='1';
  setTimeout(function(){t.style.opacity='0';},2000);
}
async function load(){
  try{
    var c=await (await fetch('/api/config')).json();
    var s=await (await fetch('/api/state')).json();
    document.getElementById('autoShutdown').checked=!!c.autoShutdownOnDone;
    document.getElementById('idleMinutes').value=c.idleMinutes||5;
    document.getElementById('shutdownDelay').value=c.shutdownDelay||60;
    var sm=c.shutdownMode||'all_done';
    var smRadio=document.querySelector('input[name="shutdownMode"][value="'+sm+'"]');
    if(smRadio) smRadio.checked=true;
    document.getElementById('aiEnabled').checked=c.aiEnabled!==false;
    document.getElementById('aiModel').value=c.aiModel||'deepseek-v4-flash';
    document.getElementById('maxAiReply').value=c.maxAiReply||400;
    document.getElementById('aiSystem').value=c.aiSystem||'';
    document.getElementById('summarizeStop').checked=c.summarizeStop!==false;
    document.getElementById('toolError').checked=!!c.notifyPostToolError;
    document.getElementById('sessionEnd').checked=!!c.notifySessionEnd;
    document.getElementById('openid').textContent=c.openid||'未设置';
    document.getElementById('chatType').textContent=(c.chatType==='group')?'群聊':'私聊';
    if(s.shutdownScheduled){
      var t=s.shutdownAt?new Date(s.shutdownAt).toLocaleTimeString():'';
      document.getElementById('shutdownState').innerHTML='<span class="warn">已调度 '+t+'</span>';
    }else{
      document.getElementById('shutdownState').textContent='无';
    }
    document.getElementById('lastActivity').textContent=s.lastActivity?new Date(s.lastActivity).toLocaleString():'-';
    document.getElementById('lastEvent').textContent=s.lastEvent||'-';
    document.getElementById('project').textContent=s.project||'-';
    // 余额与费用
    fetch('/api/balance').then(function(r){return r.json();}).then(function(j){
      document.getElementById('balance').textContent=j.balance||'-';
      document.getElementById('cost').textContent=j.cost||'无法获取（桌面端 bot gateway 未运行）';
    }).catch(function(){ document.getElementById('balance').textContent='查询失败'; });
  }catch(e){ toast('加载失败: '+e.message); }
}
async function save(){
  var sm='all_done';
  var sel=document.querySelector('input[name="shutdownMode"]:checked');
  if(sel) sm=sel.value;
  var body={
    autoShutdownOnDone:document.getElementById('autoShutdown').checked,
    idleMinutes:parseInt(document.getElementById('idleMinutes').value)||5,
    shutdownDelay:parseInt(document.getElementById('shutdownDelay').value)||60,
    shutdownMode:sm,
    aiEnabled:document.getElementById('aiEnabled').checked,
    aiModel:document.getElementById('aiModel').value.trim()||'deepseek-v4-flash',
    maxAiReply:parseInt(document.getElementById('maxAiReply').value)||400,
    aiSystem:document.getElementById('aiSystem').value,
    summarizeStop:document.getElementById('summarizeStop').checked,
    notifyPostToolError:document.getElementById('toolError').checked,
    notifySessionEnd:document.getElementById('sessionEnd').checked
  };
  try{
    var r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var j=await r.json();
    toast(j.ok?'✅ 已保存':'保存失败: '+(j.error||''));
    load();
  }catch(e){ toast('保存失败: '+e.message); }
}
async function cancelShutdown(){
  try{
    var r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'cancel_shutdown'})});
    var j=await r.json();
    toast(j.ok?'已取消关机':'取消失败');
    load();
  }catch(e){ toast('取消失败: '+e.message); }
}
async function testMsg(){
  try{
    var r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'test_msg'})});
    var j=await r.json();
    toast(j.ok?'测试消息已发送':'发送失败: '+(j.error||''));
  }catch(e){ toast('发送失败: '+e.message); }
}
async function aiPing(){
  toast('正在测试 AI 连接…');
  try{
    var r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'ai_ping'})});
    var j=await r.json();
    toast(j.ok?('AI 正常：'+(j.msg||'')):('AI 测试失败: '+(j.error||'')));
  }catch(e){ toast('AI 测试失败: '+e.message); }
}
var DAEMON_BASE='http://127.0.0.1:37915';
var currentKey='ui';
async function loadHistory(){
  var box=document.getElementById('chatHistory');
  try{
    var r=await fetch(DAEMON_BASE+'/api/history');
    if(!r.ok) throw new Error('HTTP '+r.status);
    var h=await r.json();
    if(Object.keys(h).length===0){
      box.innerHTML='<div class="desc">暂无历史记录，发一条消息开始吧</div>';
      return;
    }
    // 显示最后活动的对话（或当前 key），并在顶部列出所有 key
    var keys=Object.keys(h);
    var active=keys.includes(currentKey)?currentKey:keys[keys.length-1];
    currentKey=active;
    renderChat(h[active]||[]);
  }catch(e){
    box.innerHTML='<div class="desc">后台守护未运行（127.0.0.1:37915 不可达），无法查看/发送。请先启动 bridge.exe --daemon-bg。</div>';
  }
}
function renderChat(msgs){
  var box=document.getElementById('chatHistory');
  if(!msgs||!msgs.length){ box.innerHTML='<div class="desc">（该对话暂无消息）</div>'; return; }
  box.innerHTML=msgs.map(function(m){
    var who=(m.role==='user')?'你':'AI';
    var cls=(m.role==='user')?'user':'ai';
    return '<div class="msg '+cls+'"><span class="who '+cls+'">'+who+'</span>'+escapeHtml(m.content||'')+'</div>';
  }).join('');
  box.scrollTop=box.scrollHeight;
}
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
async function sendToAI(){
  var input=document.getElementById('chatInput');
  var text=input.value.trim();
  if(!text) return;
  input.value='';
  var box=document.getElementById('chatHistory');
  box.innerHTML+='<div class="msg user"><span class="who user">你</span>'+escapeHtml(text)+'</div>';
  box.scrollTop=box.scrollHeight;
  try{
    var r=await fetch(DAEMON_BASE+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text,key:currentKey})});
    var j=await r.json();
    if(j.ok){
      box.innerHTML+='<div class="msg ai"><span class="who ai">AI</span>'+escapeHtml(j.reply||'')+'</div>';
      toast('已回复');
    }else{
      box.innerHTML+='<div class="msg ai"><span class="who ai">AI</span>出错：'+escapeHtml(j.error||'')+'</div>';
    }
    box.scrollTop=box.scrollHeight;
    loadHistory();
  }catch(e){
    box.innerHTML+='<div class="msg ai"><span class="who ai">AI</span>守护不可达：'+escapeHtml(e.message)+'</div>';
  }
}
document.addEventListener('DOMContentLoaded',function(){
  var inp=document.getElementById('chatInput');
  inp.addEventListener('keydown',function(e){ if(e.key==='Enter') sendToAI(); });
});
load();
</script>
</body>
</html>`;

function uiServer() {
  const http = require('http');
  const port = 37914;
  const lastReq = { t: Date.now() };

  const server = http.createServer((req, res) => {
    lastReq.t = Date.now();
    const url = (req.url || '').split('?')[0];
    const send = (code, obj) => {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const readBody = () => new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => resolve(b));
    });

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
    } else if (req.method === 'GET' && url === '/api/config') {
      send(200, cfg);
    } else if (req.method === 'GET' && url === '/api/balance') {
      Promise.allSettled([getDeepSeekBalance(), getReasonixCost()]).then(([b, c]) => {
        send(200, {
          balance: b.status === 'fulfilled' ? b.value : ('查询失败：' + b.reason.message),
          cost: c.status === 'fulfilled' && c.value ? `${c.value.key}=${c.value.value}` : null,
        });
      });
    } else if (req.method === 'GET' && url === '/api/state') {
      send(200, readState());
    } else if (req.method === 'POST' && url === '/api/config') {
      readBody().then((body) => {
        try {
          const patch = JSON.parse(body || '{}');
          for (const k of ['chatType', 'maxText', 'notifySessionEnd', 'notifyPostToolError', 'autoShutdownOnDone', 'idleMinutes', 'shutdownDelay', 'aiEnabled', 'aiModel', 'aiSystem', 'shutdownMode', 'summarizeStop', 'maxAiReply']) {
            if (patch[k] !== undefined) cfg[k] = patch[k];
          }
          saveConfig(cfg);
          send(200, { ok: true, config: cfg });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
    } else if (req.method === 'POST' && url === '/api/action') {
      readBody().then(async (body) => {
        try {
          const act = JSON.parse(body || '{}');
          if (act.type === 'cancel_shutdown') {
            const ok = cancelShutdown();
            const s = readState();
            s.shutdownScheduled = false;
            delete s.shutdownAt;
            writeState(s);
            send(200, { ok, msg: ok ? '已取消关机' : '取消失败' });
          } else if (act.type === 'test_msg') {
            try {
              await sendMessage('🤖 设置页测试消息');
              send(200, { ok: true, msg: '已发送' });
            } catch (e) { send(500, { ok: false, error: e.message }); }
          } else if (act.type === 'ai_ping') {
            try {
              const ai = aiConfig();
              if (!ai.key) throw new Error('缺少 DEEPSEEK_API_KEY（%APPDATA%\\reasonix\\.env）');
              const resp = await callDeepSeek([{ role: 'user', content: '请只回复四个字：AI 连接正常' }]);
              const r = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
              send(200, { ok: true, msg: r || '（无回复）' });
            } catch (e) { send(500, { ok: false, error: e.message }); }
          } else {
            send(400, { ok: false, error: '未知操作' });
          }
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
    } else {
      send(404, { ok: false, error: 'not found' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port;
    console.log('UI 已启动: ' + url);
    execFile('cmd.exe', ['/c', 'start', '', url], () => {});
  });

  // 空闲自动退出：30 分钟无请求则关闭（防残留进程）
  setInterval(() => {
    if (Date.now() - lastReq.t > 30 * 60 * 1000) {
      console.log('UI 空闲自动退出');
      server.close();
      process.exit(0);
    }
  }, 60000);
}
