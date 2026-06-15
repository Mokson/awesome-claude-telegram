# claude-telegram-companion

Standalone Telegram channel for [Claude Code](https://claude.com/code). Self-hosted MCP server with built-in access control, live progress tracking, and reliability hardening.

<img src="assets/progress.gif" width="320" alt="Live progress tracking" />

## Features

- Self-hosted MCP server (no dependency on `telegram@claude-plugins-official`)
- Pairing-based access control with allowlists, group, and channel policies
- Atomic poll lock with follower mode for multi-session setups
- Persistent inbound queue with replay on restart
- Auto-escaping markdown via `format: "markdown"` — bold, italic, strike, code, links, spoilers, blockquotes (incl. expandable via `>!`), and custom emoji
- Inbound formatting preserved: user spoilers, quotes, code, and links are reconstructed from Telegram entities before reaching Claude
- Inline keyboards (with optional Bot API 9.4 background colors / custom emoji), reply-to context, forum supergroup topics, channel posts
- Voice notes (`.ogg`/`.opus`/`.oga`) routed via `sendVoice`
- Live progress UX: native flicker-free streaming via `sendMessageDraft` (Bot API 9.5+) in private chats, per-chat command menus, typing keepalive, tool checklists
- MarkdownV2 reference skill for manual formatting

## Install

```bash
/plugin marketplace add Mokson/claude-telegram-companion
/plugin install claude-telegram-companion@claude-telegram-companion
```

Disable the official plugin if previously enabled:

```bash
/config
# set telegram@claude-plugins-official to disabled
```

## Setup

Create a bot via [@BotFather](https://t.me/BotFather) and store its token:

```bash
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=123456:AAH...' > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
```

Pair your Telegram account:

1. DM the bot — you receive a 6-character code.
2. In Claude Code, run `/claude-telegram-companion:access pair <code>`.
3. Send a message. Claude replies.

## Configuration

State lives in `~/.claude/channels/telegram/access.json`. Manage via the `access` skill:

| Command | Purpose |
| --- | --- |
| `/claude-telegram-companion:access pair <code>` | Approve a pending pairing |
| `/claude-telegram-companion:access add <user-id>` | Add a user to the allowlist |
| `/claude-telegram-companion:access group add <chat-id>` | Enable a group |
| `/claude-telegram-companion:access set ackReaction 👀` | Set ack reaction emoji |

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_STATE_DIR` | Override `~/.claude/channels/telegram/` |
| `TELEGRAM_PLUGIN_HEARTBEAT` | Path to write a unix-timestamp heartbeat for external watchdogs |
| `TELEGRAM_ACCESS_MODE=static` | Snapshot access at boot (no runtime mutation) |

## License

Apache-2.0. The MCP server is forked from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) under Apache-2.0; companion skills, hooks, and scripts inherit the same license for consistency.
