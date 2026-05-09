#!/usr/bin/env node
// Sync discovered skills to Telegram BotFather command menu.
// Called by SessionStart hook. Injects companion instructions to stdout, syncs commands. Exit 0 always.

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const TELEGRAM_DIR = path.join(CLAUDE_DIR, 'channels', 'telegram');
const CACHE_DIR = path.join(CLAUDE_DIR, 'plugins', 'cache');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');

// --- Helpers ---

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// Parse YAML frontmatter from SKILL.md or command .md (simple parser, no deps)
function parseFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    // Extract name
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    // Extract description (handles inline, >-, >, |-, and | YAML scalars)
    let description = '';
    // Try block scalar first (>-, >, |-, |)
    const descBlockMatch = fm.match(/^description:\s*[>|]-?\s*\n([\s\S]*?)(?=\n[^\s]|\n?$)/m);
    if (descBlockMatch) {
      description = descBlockMatch[1]
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .join(' ');
    } else {
      // Inline value
      const descInlineMatch = fm.match(/^description:\s*(.+)$/m);
      if (descInlineMatch) {
        description = descInlineMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    return nameMatch ? { name: nameMatch[1].trim(), description } : null;
  } catch {
    return null;
  }
}

// List subdirectories of a path
function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

// List .md files in a directory (files only, not subdirs)
function mdFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.md'))
      .map(d => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// Get the latest version directory (sorts by name, picks last)
function latestVersionDir(pluginCacheDir) {
  const versions = subdirs(pluginCacheDir);
  if (versions.length === 0) return null;
  versions.sort();
  return path.join(pluginCacheDir, versions[versions.length - 1]);
}

// Derive origin label from plugin name: first segment before hyphen
function deriveOrigin(pluginName) {
  return pluginName.split('-')[0];
}

// Sanitize a skill name into a Telegram command: lowercase, replace non-alphanumeric with _, truncate to 32
function sanitizeCommand(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
}

// --- Skill & Command Discovery ---

function discoverSkills() {
  const settings = readJSON(path.join(CLAUDE_DIR, 'settings.json'));
  if (!settings) return [];

  const enabledPlugins = settings.enabledPlugins || {};
  const extraMarketplaces = settings.extraKnownMarketplaces || {};
  const skills = []; // { id, name, description, origin, source, pluginKey }
  const seenIds = new Set();

  function addSkill(skill) {
    if (seenIds.has(skill.id)) return;
    seenIds.add(skill.id);
    skills.push(skill);
  }

  // 1. Discover plugin skills and commands
  for (const [key, enabled] of Object.entries(enabledPlugins)) {
    if (!enabled) continue;
    const atIdx = key.lastIndexOf('@');
    if (atIdx < 1) continue;
    const pluginName = key.slice(0, atIdx);
    const marketplace = key.slice(atIdx + 1);

    // Determine if this is a directory-source marketplace
    const mktConfig = extraMarketplaces[marketplace];
    const isDirectory = mktConfig?.source?.source === 'directory';
    const dirPath = mktConfig?.source?.path;

    // Resolve plugin root (directory source preferred, cache as fallback)
    let pluginRoot = null;
    if (isDirectory && dirPath) {
      const candidate = path.join(dirPath, pluginName);
      try { if (fs.statSync(candidate).isDirectory()) pluginRoot = candidate; } catch {}
    }
    if (!pluginRoot) {
      pluginRoot = latestVersionDir(path.join(CACHE_DIR, marketplace, pluginName));
    }
    if (!pluginRoot) continue;

    const origin = deriveOrigin(pluginName);
    const usePrefix = !isDirectory;

    // Scan skills
    for (const skillDir of subdirs(path.join(pluginRoot, 'skills'))) {
      const fm = parseFrontmatter(path.join(pluginRoot, 'skills', skillDir, 'SKILL.md'));
      if (!fm) continue;
      const id = usePrefix ? `${pluginName}:${fm.name}` : fm.name;
      addSkill({
        id, name: fm.name, description: fm.description,
        origin, source: 'plugin', pluginKey: key,
      });
    }

    // Scan commands
    for (const f of mdFiles(path.join(pluginRoot, 'commands'))) {
      const fm = parseFrontmatter(f);
      const cmdName = (fm && fm.name) || path.basename(f, '.md');
      const desc = (fm && fm.description) || '';
      const id = usePrefix ? `${pluginName}:${cmdName}` : cmdName;
      addSkill({
        id, name: cmdName, description: desc,
        origin, source: 'plugin', pluginKey: key,
      });
    }
  }

  // 2. Discover user skills from ~/.claude/skills/*/SKILL.md
  for (const skillDir of subdirs(SKILLS_DIR)) {
    const f = path.join(SKILLS_DIR, skillDir, 'SKILL.md');
    const fm = parseFrontmatter(f);
    if (!fm) continue;
    addSkill({
      id: fm.name, name: fm.name, description: fm.description,
      origin: 'user', source: 'user', pluginKey: null,
    });
  }

  // 2b. Discover user commands from ~/.claude/commands/
  const userCmdsDir = path.join(CLAUDE_DIR, 'commands');
  for (const f of mdFiles(userCmdsDir)) {
    const fm = parseFrontmatter(f);
    const cmdName = (fm && fm.name) || path.basename(f, '.md');
    const desc = (fm && fm.description) || '';
    addSkill({
      id: cmdName, name: cmdName, description: desc,
      origin: 'user', source: 'user', pluginKey: null,
    });
  }
  for (const ns of subdirs(userCmdsDir)) {
    for (const f of mdFiles(path.join(userCmdsDir, ns))) {
      const fm = parseFrontmatter(f);
      const cmdName = (fm && fm.name) || path.basename(f, '.md');
      const id = `${ns}:${cmdName}`;
      const desc = (fm && fm.description) || '';
      addSkill({
        id, name: cmdName, description: desc,
        origin: ns, source: 'user', pluginKey: null,
      });
    }
  }

  // 3. Discover project-level skills from <cwd>/.claude/skills/*/SKILL.md
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills');
  for (const skillDir of subdirs(projectSkillsDir)) {
    const f = path.join(projectSkillsDir, skillDir, 'SKILL.md');
    const fm = parseFrontmatter(f);
    if (!fm) continue;
    addSkill({
      id: fm.name, name: fm.name, description: fm.description,
      origin: 'project', source: 'project', pluginKey: null,
    });
  }

  // 4. Discover project-level commands from <cwd>/.claude/commands/
  const projectCmdsDir = path.join(process.cwd(), '.claude', 'commands');
  for (const f of mdFiles(projectCmdsDir)) {
    const fm = parseFrontmatter(f);
    const cmdName = (fm && fm.name) || path.basename(f, '.md');
    const desc = (fm && fm.description) || '';
    addSkill({
      id: cmdName, name: cmdName, description: desc,
      origin: 'project', source: 'command', pluginKey: null,
    });
  }
  for (const ns of subdirs(projectCmdsDir)) {
    for (const f of mdFiles(path.join(projectCmdsDir, ns))) {
      const fm = parseFrontmatter(f);
      const cmdName = (fm && fm.name) || path.basename(f, '.md');
      const id = `${ns}:${cmdName}`;
      const desc = (fm && fm.description) || '';
      addSkill({
        id, name: cmdName, description: desc,
        origin: ns, source: 'command', pluginKey: null,
      });
    }
  }

  return skills;
}

// --- Filter, Map, and Build Command List ---

// Priority: lower number wins bare name on collision
const SCOPE_PRIORITY = { project: 0, command: 0, user: 1, plugin: 2 };

function configLookup(map, skill) {
  if (skill.id in map) return skill.id;
  if (skill.name !== skill.id && skill.name in map) return skill.name;
  return null;
}

function configHas(set, skill) {
  return set.has(skill.id) || (skill.name !== skill.id && set.has(skill.name));
}

function buildCommands(skills, config) {
  const cmds = config.commands || {};
  const exclude = cmds.exclude || {};
  const excludePlugins = new Set(exclude.plugins || []);
  const excludeSkills = new Set(exclude.skills || []);
  const aliases = cmds.aliases || {};
  const extra = cmds.extra || [];

  // Build candidates with priority
  const candidates = [];

  for (const skill of skills) {
    if (skill.pluginKey && excludePlugins.has(skill.pluginKey)) continue;

    // Alias takes priority over skill-level exclusion
    const aliasKey = configLookup(aliases, skill);
    if (aliasKey !== null) {
      const entry = aliases[aliasKey];
      candidates.push({
        command: entry.command,
        fallback: null,
        description: (entry.description || '').slice(0, 256),
        priority: -1,
      });
      continue;
    }

    if (configHas(excludeSkills, skill)) continue;

    // All items use bare name; prefix only on collision
    const command = sanitizeCommand(skill.name);
    const fallback = skill.id !== skill.name
      ? sanitizeCommand(skill.id)                          // plugin: use prefixed id
      : sanitizeCommand(skill.origin + '_' + skill.name);  // user/project: use origin_name
    const desc = skill.description
      ? `[${skill.origin}] ${skill.description}`
      : `[${skill.origin}] ${skill.name}`;

    candidates.push({
      command,
      fallback: (fallback && fallback !== command) ? fallback : null,
      description: desc.slice(0, 256),
      priority: SCOPE_PRIORITY[skill.source] ?? 2,
    });
  }

  // Sort by priority so higher-priority items claim names first
  candidates.sort((a, b) => a.priority - b.priority);

  const seen = new Set();
  const commands = [];

  for (const c of candidates) {
    const name = !seen.has(c.command) ? c.command
      : (c.fallback && !seen.has(c.fallback)) ? c.fallback
      : null;
    if (!name) continue;
    seen.add(name);
    commands.push({ command: name, description: c.description });
  }

  for (const entry of extra) {
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    commands.push({
      command: entry.command,
      description: (entry.description || '').slice(0, 256),
    });
  }

  // Sort alphabetically for a scannable menu
  commands.sort((a, b) => a.command.localeCompare(b.command));

  if (commands.length > 100) {
    process.stderr.write(
      `telegram-sync-commands: ${commands.length} commands exceed Telegram's 100-command limit, truncating\n`
    );
    commands.length = 100;
  }

  return commands;
}

// --- Telegram API ---

function setMyCommands(token, commands, scope) {
  return new Promise((resolve, reject) => {
    const body = { commands };
    if (scope) body.scope = scope;
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/setMyCommands`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 4000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) resolve(parsed);
          else reject(new Error(`Telegram API error: ${parsed.description}`));
        } catch (e) {
          reject(new Error(`Bad response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// --- Main ---

async function main() {
  // 1. Read token
  const token = readEnv(path.join(TELEGRAM_DIR, '.env'));
  if (!token) {
    process.stderr.write('telegram-sync-commands: no bot token found\n');
    return;
  }

  process.stdout.write([
    '[telegram-companion] Telegram behavioral rules:',
    '',
    'ROUTING',
    '- Reply via Telegram, not transcript. Match the communication channel.',
    '- For clarifying questions from a Telegram task: reply via Telegram with inline keyboard buttons instead of AskUserQuestion. Plain text for open-ended questions.',
    '',
    'FIRST ACTION',
    '- React with \u{1F440} on every incoming message (enables progress tracking).',
    '',
    'FORMATTING',
    '- Default format: "markdown" (auto-escapes to MarkdownV2 server-side). Use "markdownv2" only for spoilers, underline, or blockquotes, and load the telegram-markdownv2 skill first.',
    '- No tables, headers (#), or horizontal rules (---): Telegram does not render them. Use *bold text* for section labels, emoji-prefixed lines for lists.',
    '- Use language-tagged code blocks (```python) for syntax highlighting.',
    '- Use > blockquotes for quoting messages or referenced content.',
    '- Text messages: 4096 char limit (auto-chunked on paragraph boundaries, but write concisely).',
    '- Photo/file captions: 1024 char limit. Keep captions short; send details as a separate text message.',
    '',
    'BUTTONS',
    '- callback_data max 60 bytes. Use short values ("yes", "opt_1", not full sentences).',
    '- Tapping a button removes the keyboard and delivers the data as a new inbound message.',
    '',
    'MEDIA',
    '- Reply tool sends each file as a separate message. For photo albums (2-10 photos grouped), use sendMediaGroup via direct API call (see telegram-markdownv2 skill). Album captions: 1024 char limit.',
    '- Voice/audio messages (attachment_kind: voice/audio) have attachment_file_id. Use the download_attachment tool to fetch the file.',
    '',
    'STYLE',
    '- Emojis: sparingly and professionally (section headers, status indicators).',
  ].join('\n') + '\n');

  // 2. Read config (optional; use defaults if missing)
  const config = readJSON(path.join(TELEGRAM_DIR, 'command-config.json')) || {
    commands: { sync: true, exclude: { plugins: [], skills: [] }, aliases: {}, extra: [] },
    progress: { statusUpdates: true }
  };

  // 3. Check if command sync is enabled (default: true)
  const syncEnabled = (config.commands || {}).sync !== false;
  if (!syncEnabled) return;

  // 4. Discover skills
  const skills = discoverSkills();

  // 5. Build command list
  const commands = buildCommands(skills, config);

  // 6. Sync to Telegram
  // The official plugin sets commands at all_private_chats scope on bot start,
  // which overrides default scope. Use per-chat scope (highest priority) from
  // access.json allowlist so our commands can't be overridden.
  const access = readJSON(path.join(TELEGRAM_DIR, 'access.json'));
  const chatIds = (access && access.allowFrom) || [];
  for (const chatId of chatIds) {
    await setMyCommands(token, commands, { type: 'chat', chat_id: chatId });
  }
}

main().catch(err => {
  process.stderr.write(`telegram-sync-commands: ${err.message}\n`);
}).finally(() => {
  process.exit(0);
});
