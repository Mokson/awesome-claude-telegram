#!/usr/bin/env node
// Background daemon: typing indicator + progress display.
//
// Two display modes:
//   - message (default): edits one persistent progress message in place
//     (quiet HTML blockquote via editMessageText).
//   - draft: streams progress via sendRichMessageDraft/sendMessageDraft
//     (private chats, ephemeral 30s preview, auto-clears on the real reply).
//
// Reads completed steps from /tmp/telegram-progress.jsonl
// Reads current in-progress tool from /tmp/telegram-current-tool.txt
//
// Usage: node telegram-typing-daemon.js <chat_id> <message_id|"draft">
// Stop:  write /tmp/telegram-typing-stop, or delete telegram-active.json
// PID:   written to /tmp/telegram-typing-pid

const https = require('https');
const fs = require('fs');
const {
  PID_FILE, STOP_FILE, ACTIVE_FILE,
  readToken, readProgressLog, readCurrentTool,
  formatProgress, formatProgressMarkdown,
} = require('./telegram-shared.cjs');

const chatId = process.argv[2];
const messageArg = process.argv[3] || null;
if (!chatId) process.exit(1);

// "draft" sentinel → stream via sendRichMessageDraft (preferred) or
// sendMessageDraft (fallback). Otherwise it's a real message_id to edit.
const DRAFT_ID = 1;
let draftMode = messageArg === 'draft';
let richDraftAvailable = true;
let messageId = draftMode ? null : messageArg;

const token = readToken();
if (!token) process.exit(1);

fs.writeFileSync(PID_FILE, String(process.pid));

// Long enough to cover extended autonomous tasks; turn teardown normally
// stops the daemon much earlier via STOP_FILE or active-file removal.
const MAX_DURATION_MS = 30 * 60 * 1000;
const TYPING_INTERVAL_MS = 4000;
const PROGRESS_INTERVAL_MS = 3000;
const startedAt = Date.now();

let lastProgressText = '';
let lastEditAt = 0;

function shouldStop() {
  if (Date.now() - startedAt > MAX_DURATION_MS) return true;
  if (!fs.existsSync(ACTIVE_FILE)) return true;
  return fs.existsSync(STOP_FILE);
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(STOP_FILE); } catch {}
}

// --- Typing ---

function sendTyping() {
  if (shouldStop()) { cleanup(); process.exit(0); }
  telegramPost('sendChatAction', { chat_id: chatId, action: 'typing' });
}

// --- Progress ---

function updateProgress() {
  if (shouldStop()) { cleanup(); process.exit(0); }

  const entries = readProgressLog();
  const currentTool = readCurrentTool();
  if (entries.length === 0 && !currentTool) return;

  const text = formatProgress(entries, currentTool);
  if (!text) return;

  const elapsed = Date.now() - lastEditAt;
  if (text === lastProgressText) {
    // Message mode: an unchanged message needs no edit. Draft mode: re-send
    // before the ~30s draft TTL so a long single-tool step doesn't vanish.
    if (!draftMode || elapsed < 20000) return;
  } else if (elapsed < 2000) {
    return;
  }

  lastProgressText = text;
  lastEditAt = Date.now();

  if (draftMode) {
    // Try sendRichMessageDraft first (Bot API 10.1) — native markdown rendering.
    // Falls back to sendMessageDraft (HTML), then to message mode.
    if (richDraftAvailable) {
      const mdText = formatProgressMarkdown(entries, currentTool);
      if (mdText) {
        telegramPostResult('sendRichMessageDraft', {
          chat_id: Number(chatId),
          draft_id: DRAFT_ID,
          rich_message: { markdown: mdText },
        }, (ok) => {
          if (!ok) {
            richDraftAvailable = false;
            // Immediately retry with plain sendMessageDraft
            telegramPostResult('sendMessageDraft', {
              chat_id: Number(chatId),
              draft_id: DRAFT_ID,
              text,
              parse_mode: 'HTML',
            }, (ok2) => {
              if (!ok2) {
                draftMode = false;
                lastProgressText = '';
                lastEditAt = 0;
              }
            });
          }
        });
        return;
      }
    }
    // Fallback: plain sendMessageDraft with HTML
    telegramPostResult('sendMessageDraft', {
      chat_id: Number(chatId),
      draft_id: DRAFT_ID,
      text,
      parse_mode: 'HTML',
    }, (ok) => {
      if (!ok) {
        draftMode = false;
        lastProgressText = '';
        lastEditAt = 0;
      }
    });
    return;
  }

  if (messageId) {
    telegramPost('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      parse_mode: 'HTML',
    });
  } else {
    // Fell back from draft mode with no message yet — create one to edit.
    telegramPostResult('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: true,
    }, (ok, msgId) => {
      if (msgId) messageId = String(msgId);
    });
  }
}

// --- Telegram API ---

function telegramPost(method, body) {
  const postData = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: 3000,
  }, (res) => { res.resume(); });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(postData);
  req.end();
}

// Like telegramPost but parses the response so callers can detect failures
// (e.g. sendMessageDraft unsupported) and read a returned message_id.
function telegramPostResult(method, body, cb) {
  const postData = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: 3000,
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        cb(parsed.ok === true, (parsed.result && parsed.result.message_id) || null, parsed.description || '');
      } catch { cb(false, null, ''); }
    });
  });
  req.on('error', () => cb(false, null, ''));
  req.on('timeout', () => { req.destroy(); cb(false, null, ''); });
  req.write(postData);
  req.end();
}

// --- Main ---

sendTyping();
updateProgress(); // show something immediately rather than waiting a full tick
const typingInterval = setInterval(sendTyping, TYPING_INTERVAL_MS);
const progressInterval = setInterval(updateProgress, PROGRESS_INTERVAL_MS);

process.on('SIGTERM', () => {
  clearInterval(typingInterval);
  clearInterval(progressInterval);
  cleanup();
  process.exit(0);
});
