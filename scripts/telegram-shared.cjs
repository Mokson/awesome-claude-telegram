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
const ACTIVE_FILE = path.join(tmpDir, 'telegram-active.json');
const ENV_FILE = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');

const MAX_VISIBLE_STEPS = 15;
const MAX_FINAL_STEPS = 100;

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

function writeProgressLog(entries) {
  try {
    fs.writeFileSync(LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch {}
}

function readCurrentTool() {
  try {
    const label = fs.readFileSync(CURRENT_TOOL_FILE, 'utf8').trim();
    return label || null;
  } catch { return null; }
}

function countSuffix(entry) {
  return entry.count && entry.count > 1 ? ` ×${entry.count}` : '';
}

function stepCount(entries) {
  return entries.reduce((n, e) => n + (e.count || 1), 0);
}

function formatDuration(sec) {
  if (!(sec > 0)) return '';
  if (sec < 90) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// Live progress as HTML — the primary rendering. HTML blockquotes preserve
// newlines reliably (rich-markdown paragraphs soft-wrap ✓ lines together)
// and read quieter than task-list checkboxes.
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
    lines.push(`✓ ${escapeHtml((entry.label || 'Working').slice(0, 80))}${countSuffix(entry)}`);
  }
  if (currentTool && !doneLabels.has(currentTool)) {
    lines.push(`▸ ${escapeHtml(currentTool.slice(0, 80))}…`);
  }
  return '<blockquote>' + lines.join('\n') + '</blockquote>';
}

// Live progress as quoted markdown (draft streaming mode).
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
    lines.push(`✓ ${(entry.label || 'Working').slice(0, 80)}${countSuffix(entry)}`);
  }
  if (currentTool && !doneLabels.has(currentTool)) {
    lines.push(`▸ **${currentTool.slice(0, 80)}**…`);
  }
  return lines.map(l => '> ' + l).join('\n');
}

// Final collapsed history: an expandable blockquote so the tool-call history
// persists in chat without dominating it.
function formatProgressFinalHtml(entries, elapsedSec) {
  if (entries.length === 0) return null;
  const steps = stepCount(entries);
  const dur = formatDuration(elapsedSec);
  const head = `Ran ${steps} step${steps === 1 ? '' : 's'}${dur ? ` · ${dur}` : ''}`;
  const lines = entries.slice(-MAX_FINAL_STEPS)
    .map(e => `✓ ${escapeHtml((e.label || 'Working').slice(0, 80))}${countSuffix(e)}`);
  return `<blockquote expandable>${head}\n${lines.join('\n')}</blockquote>`;
}

module.exports = {
  LOG_FILE, PID_FILE, STOP_FILE, CURRENT_TOOL_FILE, ACTIVE_FILE,
  readToken, escapeHtml,
  readProgressLog, writeProgressLog, readCurrentTool,
  formatProgress, formatProgressMarkdown, formatProgressFinalHtml,
};
