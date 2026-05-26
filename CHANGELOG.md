# Changelog

## v2.3.1

### Fixed

- Startup queue replay race condition: `queueReplayPending()` fired immediately after `mcp.connect()`, before Claude Code's channel notification handler was ready. Notifications were written to the stdio pipe (promise resolved, files moved to `delivered/`), but Claude never surfaced them. Added a 5-second delay to the initial replay so the notification handler has time to initialize.

## v2.0.0

Decoupled fork. The plugin now hosts its own Telegram MCP server and no longer depends on `telegram@claude-plugins-official`.

### Breaking

- Skill namespace: `/telegram:access` → `/claude-telegram-companion:access`. Same for `/telegram:configure`.
- Voice transcription via `transcribe` skill removed. Voice messages now flow through the embedded server's `attachment_kind: voice` meta.
- Disable `telegram@claude-plugins-official` to avoid two pollers competing for the bot token.

### Added (cherry-picked PRs from anthropics/claude-plugins-official)

| PR | Summary |
| --- | --- |
| #976 | Retry polling on transient network errors; fail fast on permanent (e.g. invalid token) |
| #1515 | Optional poll-loop heartbeat file (`TELEGRAM_PLUGIN_HEARTBEAT`) |
| #1374 | Atomic poll lock with follower mode for multi-session setups |
| #980 | Photo download hardening: empty-array guard, HTTP status check, size limit |
| #1322 | Persist inbound messages before notifying Claude; replay on restart |
| #1560 | 15s retry tick for pending notifications between sessions |
| #978 | Allowlist enforcement on `/start`, `/help`, `/status` |
| #1217 | `permissionApprovers` config to scope permission relays |
| #1570 | Plain-text fallback when MarkdownV2/HTML parse fails |
| #1410 | `format: "markdown"` with GFM auto-escape |
| #1285 | Reply-to message context in inbound meta |
| #1504 | `.ogg`/`.opus`/`.oga` routed as voice notes |
| #1003 | `channel_post` support for bot-to-bot communication |
| #1325 | Forum-supergroup topic round-trip via `message_thread_id` |
| #1491 | Inline keyboard buttons on `reply` tool with callback round-trip |
| #1179 | Wildcard `'*'` group policy |
| #1239 | Default Claude Code skills in bot command menu |

### Stability patches

- `process.stdout` error listener (prevents broken-pipe crashes)
- `mcp.onerror` handler (catches transport-level errors)
- `.catch()` on fire-and-forget `mcp.notification()` calls

### Companion changes

- New `skills/access/` and `skills/configure/` ported from upstream and namespaced
- Hook scripts updated to recognize `mcp__plugin_claude-telegram-companion_telegram__*` tool names

## v1.x

See git log on `main` for v1.0.0 → v1.1.0 history.

[#976]: https://github.com/anthropics/claude-plugins-official/pull/976
[#978]: https://github.com/anthropics/claude-plugins-official/pull/978
[#980]: https://github.com/anthropics/claude-plugins-official/pull/980
[#1003]: https://github.com/anthropics/claude-plugins-official/pull/1003
[#1179]: https://github.com/anthropics/claude-plugins-official/pull/1179
[#1217]: https://github.com/anthropics/claude-plugins-official/pull/1217
[#1239]: https://github.com/anthropics/claude-plugins-official/pull/1239
[#1285]: https://github.com/anthropics/claude-plugins-official/pull/1285
[#1322]: https://github.com/anthropics/claude-plugins-official/pull/1322
[#1325]: https://github.com/anthropics/claude-plugins-official/pull/1325
[#1374]: https://github.com/anthropics/claude-plugins-official/pull/1374
[#1410]: https://github.com/anthropics/claude-plugins-official/pull/1410
[#1491]: https://github.com/anthropics/claude-plugins-official/pull/1491
[#1504]: https://github.com/anthropics/claude-plugins-official/pull/1504
[#1515]: https://github.com/anthropics/claude-plugins-official/pull/1515
[#1560]: https://github.com/anthropics/claude-plugins-official/pull/1560
[#1570]: https://github.com/anthropics/claude-plugins-official/pull/1570
