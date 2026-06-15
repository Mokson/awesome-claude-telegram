// Shared constants and utilities for telegram-typing-keepalive.js
// and telegram-typing-daemon.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = os.tmpdir();
const LOG_FILE = path.join(tmpDir, 'telegram-progress.jsonl');
const PID_FILE = path.join(tmpDir, 'telegram-typing-pid');
const STOP_FILE = path.join(tmpDir, 'telegram-typing-stop');
const CURRENT_TOOL_FILE = path.join(tmpDir, 'telegram-current-tool.txt');
const ENV_FILE = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');

const MAX_VISIBLE_STEPS = 15;

function readToken() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readProgressLog() {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function readCurrentTool() {
  try {
    const label = fs.readFileSync(CURRENT_TOOL_FILE, 'utf8').trim();
    return label || null;
  } catch { return null; }
}

function formatProgress(entries, currentTool) {
  if (entries.length === 0 && !currentTool) return null;
  const visible = entries.length > MAX_VISIBLE_STEPS
    ? entries.slice(-MAX_VISIBLE_STEPS) : entries;
  const truncated = entries.length > MAX_VISIBLE_STEPS
    ? entries.length - MAX_VISIBLE_STEPS : 0;
  const doneLabels = new Set(entries.map(e => e.label));
  const lines = [];
  if (truncated > 0) lines.push(`<i>... ${truncated} earlier steps</i>`);
  for (const entry of visible) {
    lines.push(`\u2713 ${escapeHtml(entry.label || 'Working').slice(0, 80)}`);
  }
  if (currentTool && !doneLabels.has(currentTool)) {
    lines.push(`\u25B8 ${escapeHtml(currentTool).slice(0, 80)}\u2026`);
  }
  return '<blockquote>' + lines.join('\n') + '</blockquote>';
}

function formatProgressMarkdown(entries, currentTool) {
  if (entries.length === 0 && !currentTool) return null;
  const visible = entries.length > MAX_VISIBLE_STEPS
    ? entries.slice(-MAX_VISIBLE_STEPS) : entries;
  const truncated = entries.length > MAX_VISIBLE_STEPS
    ? entries.length - MAX_VISIBLE_STEPS : 0;
  const doneLabels = new Set(entries.map(e => e.label));
  const lines = [];
  if (truncated > 0) lines.push(`*... ${truncated} earlier steps*`);
  for (const entry of visible) {
    lines.push(`\u2713 ${(entry.label || 'Working').slice(0, 80)}`);
  }
  if (currentTool && !doneLabels.has(currentTool)) {
    lines.push(`\u25B8 **${currentTool.slice(0, 80)}**\u2026`);
  }
  return lines.map(l => '> ' + l).join('\n');
}

module.exports = {
  LOG_FILE, PID_FILE, STOP_FILE, CURRENT_TOOL_FILE,
  readToken, escapeHtml,
  readProgressLog, readCurrentTool, formatProgress, formatProgressMarkdown,
};
