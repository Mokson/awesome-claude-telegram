#!/usr/bin/env node
// Pre/PostToolUse hook: Telegram progress indicators.
//
// Reads config from ~/.claude/channels/telegram/command-config.json:
//   progress.statusUpdates: bool (default: true) - show tool progress in Telegram
//   progress.streamMode: "draft" | "edit" (default: "draft") - private chats
//     stream a flicker-free draft via sendMessageDraft (Bot API 9.5+) that
//     auto-clears on the real reply; "edit" forces the legacy edit-a-message
//     behavior. Groups always use edit mode.
//
// PreToolUse mode (argv[2] === 'pre'):
//   Writes current tool label to /tmp/telegram-current-tool.txt
//   so the daemon can show it as in-progress.
//
// PostToolUse mode (default):
//   Lifecycle:
//    1. react → establish Telegram context (chat_id)
//    2. First non-telegram tool → begin progress display, spawn daemon
//    3. Subsequent tools → append to progress log (daemon streams/edits)
//    4. Tool error before progress shown → send error directly to Telegram
//    5. Claude's reply/send → clear draft / delete progress message, clean up

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const {
  LOG_FILE, PID_FILE, STOP_FILE, CURRENT_TOOL_FILE,
  readToken, escapeHtml,
  readProgressLog, readCurrentTool, formatProgress,
} = require('./telegram-shared.cjs');

const MODE = process.argv[2] || 'post';

function isTelegramTool(name) {
  return name.startsWith('mcp__plugin_claude-telegram-companion_telegram__')
    || name.startsWith('mcp__plugin_claude_telegram_companion_telegram__');
}
function getTelegramAction(name) {
  const parts = name.split('__');
  return parts[parts.length - 1] || '';
}
const DAEMON_SCRIPT = path.join(__dirname, 'telegram-typing-daemon.cjs');

const tmpDir = os.tmpdir();
const ACTIVE_FILE = path.join(tmpDir, 'telegram-active.json');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'channels', 'telegram', 'command-config.json');

// Lazy-loaded config (only read when Telegram context is active)
let _statusUpdates = null;
function statusUpdatesEnabled() {
  if (_statusUpdates !== null) return _statusUpdates;
  _statusUpdates = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (raw.progress && typeof raw.progress.statusUpdates === 'boolean')
      _statusUpdates = raw.progress.statusUpdates;
  } catch {}
  return _statusUpdates;
}

// "draft" (default) streams progress via sendMessageDraft; "edit" forces the
// legacy edit-a-real-message behavior. Drafts are a private-chat feature, so
// group chats (negative chat_id) always fall back to edit mode.
let _streamMode = null;
function streamMode() {
  if (_streamMode !== null) return _streamMode;
  _streamMode = 'draft';
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (raw.progress && raw.progress.streamMode === 'edit')
      _streamMode = 'edit';
  } catch {}
  return _streamMode;
}
function useDraftFor(chatId) {
  return streamMode() === 'draft' && Number(chatId) > 0;
}

// Begin showing progress. In draft mode no persistent message is created — the
// daemon streams a draft that auto-clears when the bot's real reply lands. In
// edit mode a real message is sent first, then the daemon edits it.
function beginProgress(ctx, initialText) {
  try { fs.unlinkSync(STOP_FILE); } catch {}
  if (useDraftFor(ctx.chat_id)) {
    ctx.progress_msg_id = 'draft';
    ctx.timestamp = now();
    writeActive(ctx);
    spawnDaemon(ctx.chat_id, 'draft');
    process.exit(0);
  }
  telegramPostSync('sendMessage', {
    chat_id: ctx.chat_id,
    text: initialText,
    parse_mode: 'HTML',
  }, (msgId) => {
    if (msgId) {
      ctx.progress_msg_id = String(msgId);
      ctx.timestamp = now();
      writeActive(ctx);
      spawnDaemon(ctx.chat_id, ctx.progress_msg_id);
    }
  });
}

let _token = null;
function getToken() {
  if (_token !== null) return _token;
  _token = readToken();
  return _token;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const sessionId = data.session_id || '';

    if (MODE === 'pre') {
      handlePreToolUse(toolName, toolInput, sessionId);
    } else {
      handlePostToolUse(data, toolName, toolInput);
    }
  } catch {
    process.exit(0);
  }
});

// --- PreToolUse: write current tool to file for daemon ---

function handlePreToolUse(toolName, toolInput, sessionId) {
  // Cheap checks first to avoid file I/O for hidden/telegram tools
  if (isTelegramTool(toolName)) process.exit(0);
  const label = formatToolLabel(toolName, toolInput);
  if (!label) process.exit(0);

  const ctx = readActive();
  if (!ctx || !ctx.chat_id || isStale(ctx)) process.exit(0);
  if (ctx.session_id && ctx.session_id !== sessionId) process.exit(0);
  if (!statusUpdatesEnabled()) process.exit(0);

  try { fs.writeFileSync(CURRENT_TOOL_FILE, label); } catch {}

  // First visible tool: begin progress display and spawn daemon eagerly
  // so long-running tools appear in-progress immediately
  if (!ctx.progress_msg_id && getToken()) {
    beginProgress(ctx, formatProgress([], label));
    return;
  }

  process.exit(0);
}

// --- PostToolUse: progress tracking and daemon management ---

function handlePostToolUse(data, toolName, toolInput) {
  const sessionId = data.session_id || '';
  const toolOutput = data.tool_output || '';

  if (isTelegramTool(toolName)) {
    const chatId = toolInput.chat_id;
    if (!chatId) process.exit(0);

    const action = getTelegramAction(toolName);

    // react → always establish fresh context for this message
    if (action === 'react') {
      // Kill any existing daemon from a previous message
      killDaemon();
      try { fs.unlinkSync(LOG_FILE); } catch {}
      try { fs.unlinkSync(CURRENT_TOOL_FILE); } catch {}
      writeActive({ chat_id: chatId, session_id: sessionId, timestamp: now() });
      process.exit(0);
    }

    // reply/send → final message. Clean up. A streamed draft auto-clears when
    // the real reply arrives; only a real edit-mode message needs deleting.
    if (action === 'reply' || action === 'send') {
      const ctx = readActive();
      if (ctx && ctx.progress_msg_id && ctx.progress_msg_id !== 'draft') {
        telegramPostFireForget('deleteMessage', {
          chat_id: ctx.chat_id,
          message_id: Number(ctx.progress_msg_id),
        });
      }
      cleanup();
      process.exit(0);
    }

    // edit/edit_message → clean up
    if (action === 'edit_message' || action === 'edit') {
      cleanup();
      process.exit(0);
    }

    process.exit(0);
  }

  // --- Non-Telegram tool ---
  // Skip hidden tools before any file I/O
  if (HIDDEN_TOOLS.has(toolName)) process.exit(0);
  if (!statusUpdatesEnabled()) process.exit(0);

  const ctx = readActive();
  if (!ctx || !ctx.chat_id || isStale(ctx)) process.exit(0);
  // Only the originating session contributes to progress
  if (ctx.session_id && ctx.session_id !== sessionId) process.exit(0);

  // Error handling: no progress message sent yet + tool failed
  // Send error directly to Telegram (don't rely on Claude following additionalContext)
  if (!ctx.progress_msg_id && looksLikeError(toolOutput) && getToken()) {
    const errorText = typeof toolOutput === 'string'
      ? toolOutput.slice(0, 200)
      : JSON.stringify(toolOutput).slice(0, 200);
    telegramPostSync('sendMessage', {
      chat_id: ctx.chat_id,
      text: `<b>Failed:</b> ${escapeHtml(errorText)}`,
      parse_mode: 'HTML',
    }, () => { cleanup(); });
    return;
  }

  // Build progress entry
  const label = formatToolLabel(toolName, toolInput);
  if (!label) process.exit(0);

  // Deduplicate: exact label match against existing entries
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8').trim();
    if (raw) {
      const needle = `"label":${JSON.stringify(label)},`;
      if (raw.includes(needle)) {
        ctx.timestamp = now();
        writeActive(ctx);
        process.exit(0);
      }
    }
  } catch {}

  fs.appendFileSync(LOG_FILE, JSON.stringify({
    label, time: now(), status: 'done',
  }) + '\n');

  // Begin progress display if none exists yet
  if (!ctx.progress_msg_id && getToken()) {
    beginProgress(ctx, `<blockquote>\u2713 ${escapeHtml(label)}</blockquote>`);
    return;
  }

  ctx.timestamp = now();
  writeActive(ctx);

  // If daemon died, refresh progress immediately and respawn. (Drafts can't be
  // edited out-of-band, so only nudge real edit-mode messages here.)
  if (ctx.progress_msg_id && !isDaemonAlive()) {
    if (ctx.progress_msg_id !== 'draft') editProgress(ctx);
    try { fs.unlinkSync(STOP_FILE); } catch {}
    spawnDaemon(ctx.chat_id, ctx.progress_msg_id);
  }

  process.exit(0);
}

// --- Helpers ---

function now() { return Math.floor(Date.now() / 1000); }
function isStale(ctx) { return ctx.timestamp && (now() - ctx.timestamp) > 120; }
function readActive() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')); } catch { return null; }
}
function writeActive(ctx) {
  try { fs.writeFileSync(ACTIVE_FILE, JSON.stringify(ctx)); } catch {}
}
function cleanup() {
  killDaemon();
  try { fs.unlinkSync(ACTIVE_FILE); } catch {}
  try { fs.unlinkSync(LOG_FILE); } catch {}
  try { fs.unlinkSync(CURRENT_TOOL_FILE); } catch {}
}

function looksLikeError(output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output || '');
  return /\b(error:|Error:|ERROR|failed:|Failed|rate limit|timed out|exception:)/i.test(text);
}

// --- Telegram API ---

function telegramPostSync(method, body, cb) {
  if (!getToken()) { cb(null); process.exit(0); return; }
  const postData = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${getToken()}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: 2500,
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        cb(parsed.result && parsed.result.message_id || null);
      } catch { cb(null); }
      process.exit(0);
    });
  });
  req.on('error', () => { cb(null); process.exit(0); });
  req.on('timeout', () => { req.destroy(); cb(null); process.exit(0); });
  req.write(postData);
  req.end();
}

function telegramPostFireForget(method, body) {
  if (!getToken()) return;
  const postData = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${getToken()}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: 2000,
  }, (res) => { res.resume(); });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(postData);
  req.end();
}

// --- Daemon ---

function killDaemon() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  try { fs.writeFileSync(STOP_FILE, '1'); } catch {}
}

function isDaemonAlive() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function spawnDaemon(chatId, messageId) {
  try {
    const args = [DAEMON_SCRIPT, chatId];
    if (messageId) args.push(messageId);
    const child = spawn('node', args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

// --- Progress editing ---

function editProgress(ctx) {
  if (!ctx.progress_msg_id || !getToken()) return;
  const entries = readProgressLog();
  const currentTool = readCurrentTool();
  const text = formatProgress(entries, currentTool);
  if (!text) return;
  telegramPostFireForget('editMessageText', {
    chat_id: ctx.chat_id,
    message_id: Number(ctx.progress_msg_id),
    text,
    parse_mode: 'HTML',
  });
}

// --- Tool labels ---

// Internal tools that shouldn't appear in progress
const HIDDEN_TOOLS = new Set([
  'Read', 'Glob', 'ToolSearch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
]);

function formatToolLabel(toolName, toolInput) {
  if (HIDDEN_TOOLS.has(toolName)) return null;

  if (toolName === 'Agent') return `Agent(${toolInput.description || 'processing'})`;
  if (toolName === 'Skill') {
    const skill = toolInput.skill || '';
    const name = skill.includes(':') ? skill.split(':').pop() : skill;
    return name ? `Skill(${name})` : null;
  }
  if (toolName === 'Bash') {
    const desc = toolInput.description
      || toolInput.command?.slice(0, 60).replace(/\n.*/s, '').trim()
      || 'command';
    return `Bash(${desc})`;
  }
  if (toolName === 'Write') {
    const name = path.basename(toolInput.file_path || '') || 'file';
    return `Write(${name})`;
  }
  if (toolName === 'Edit') {
    const name = path.basename(toolInput.file_path || '') || 'file';
    return `Edit(${name})`;
  }
  if (toolName === 'Grep') return 'Searched for patterns';
  if (toolName === 'WebSearch') {
    const query = toolInput.query || '';
    return query ? `Search(${query.slice(0, 50)})` : 'Web search';
  }
  if (toolName === 'WebFetch') {
    const url = toolInput.url || '';
    const short = url.replace(/^https?:\/\//, '').slice(0, 50);
    return short ? `Fetch(${short})` : 'Web fetch';
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const service = parts[1] || '';
    const cap = service.charAt(0).toUpperCase() + service.slice(1);
    const op = (parts.slice(2).join('-') || '').replace(/-/g, ' ');
    return `${cap}: ${op}`.slice(0, 50);
  }
  return toolName;
}
