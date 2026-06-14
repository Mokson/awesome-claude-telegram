---
name: telegram-markdownv2
description: >-
  This skill should be used when composing a reply to a Telegram message,
  calling the official plugin's reply or edit_message tools with format
  "markdownv2", when sending multiple photos as an album via "send media group",
  "send photos together", "send album", or when the user asks to "format for
  Telegram", "fix Telegram formatting", or "send formatted message". Provides
  MarkdownV2 escaping rules, syntax, and media group sending via direct Bot API
  calls. Not triggered by general markdown or HTML questions unrelated to
  Telegram.
---

# Telegram MarkdownV2 Formatting

Format all Telegram replies using the official plugin's `reply` tool with `format: "markdownv2"`. Use `edit_message` with `format: "markdownv2"` for interim progress updates.

## Escaping Rules

Outside of code spans and code blocks, escape these characters with a preceding `\`:

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

**Inside code blocks and inline code, do NOT escape special characters** (except `` ` `` and `\` themselves). The triple backticks that open and close code blocks are NOT escaped either.

**This is the primary source of formatting errors.** A single unescaped `.` or `-` in regular text causes the entire message to fail. But over-escaping inside code blocks also causes failures.

## Code Block Rules

Code blocks use unescaped triple backticks. Content inside is literal:

    ```python
    def hello():
        print("Hello!")
    ```

Do NOT write `\`\`\`` - that creates literal backtick characters, not a code block. Do NOT escape `(`, `)`, `-`, `.` or other characters inside the code block.

## Syntax Reference

| Format | Syntax |
|---|---|
| Bold | `*bold*` |
| Italic | `_italic_` |
| Underline | `__underline__` |
| Strikethrough | `~strikethrough~` |
| Spoiler | `\|\|spoiler\|\|` |
| Inline code | `` `code` `` |
| Code block | unescaped ` ``` ` with content as-is |
| Link | `[text](url)` |
| Block quote | `>line` (each line starts with `>`) |
| Expandable quote | first line `**>line`, every other line `>line`, last line ends with `\|\|` |
| Custom emoji | `![👍](tg://emoji?id=<id>)` — owner must have Telegram Premium; the inner glyph is the fallback |

## Auto-conversion with `format: "markdown"`

The `reply`/`edit_message` `format: "markdown"` mode accepts GitHub-flavored
markdown and handles all escaping for you, so prefer it when you don't need raw
control. It supports the same set: `**bold**`, `_italic_`, `~~strike~~`,
`` `code` ``, fenced code, `[links](url)`, `||spoilers||`, `> blockquotes`,
and custom emoji `![👍](tg://emoji?id=<id>)`. For an expandable (collapsed)
quote, start the first line of the quote with `>!`:

```
>! Summary line shown when collapsed
> more detail, hidden until expanded
```

Use raw `format: "markdownv2"` (this skill's escaping rules) only when you need
something the auto-converter doesn't express.

## Example Message

A correctly formatted message looks like this (shown as the raw string passed to `reply`):

    *Task Complete*\n\nUpdated `config\.json` with new settings\.\n\n```json\n{"key": "value"}\n```\n\n\- Status: *done*\n\- Files changed: `2`

Key points in this example:
- `\.` escapes the dot in `config\.json` (outside code) but NOT inside the code block
- `\-` escapes dashes for list items (outside code)
- The ````json` and closing ```` ``` ```` are NOT escaped
- `{"key": "value"}` inside the code block has no escaping

## Common Escaping Mistakes

- Numbers with decimals: `3\.5` not `3.5`
- List dashes: `\- item` not `- item`
- Exclamations: `Done\!` not `Done!`
- Parentheses in text: `\(optional\)` not `(optional)`
- Equals signs: `deficiency \= 40%` not `deficiency = 40%`
- Tildes (approximately): `\~60` not `~60` (unescaped `~` triggers strikethrough)
- URLs inside `[text](url)` do not need escaping
- Code block backticks: use ```` ``` ```` NOT `\`\`\``
- Content inside code blocks: no escaping needed

## What to Avoid

- Escaping characters inside code blocks (most common cause of failures)
- HTML tags (the MarkdownV2 parser ignores them)
- Nesting formatting across line boundaries
- Wrapping entire messages in code blocks for non-code content

## Sending Images

### Single image

Pass one file path in the `files` array of the `reply` tool:

```
reply(chat_id, text, format: "markdownv2", files: ["/path/to/image.jpg"])
```

The caption (text) supports MarkdownV2 formatting. Image renders inline with preview.

### Multiple images as album

The `reply` tool sends multiple files as separate messages. To send a photo album (grouped in one message), call the Telegram Bot API directly:

```bash
TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.claude/channels/telegram/.env | cut -d= -f2)

curl -s "https://api.telegram.org/bot${TOKEN}/sendMediaGroup" \
  -F "chat_id=<chat_id>" \
  -F 'media=[{"type":"photo","media":"attach://p1","caption":"<caption>","parse_mode":"MarkdownV2"},{"type":"photo","media":"attach://p2"},{"type":"photo","media":"attach://p3"}]' \
  -F "p1=@/path/photo1.jpg" \
  -F "p2=@/path/photo2.jpg" \
  -F "p3=@/path/photo3.jpg"
```

Rules for `sendMediaGroup`:
- 2-10 photos per album
- Only the first item's `caption` is displayed (applies to the whole album)
- Caption limit: **1024 characters** (not the 4096 of regular text messages)
- Set `parse_mode: "MarkdownV2"` on the caption item to use formatting
- Escape the caption string per MarkdownV2 rules (same as reply text)
- Because the caption is JSON inside a shell command, backslashes need **double escaping**: `\\` in JSON produces `\` for Telegram (e.g. `"4\\.8"` for `4.8`, `"\\(624\\)"` for `(624)`)
- Attach files using `attach://<label>` in media and `-F "<label>=@<path>"` in form data
- When the full text exceeds 1024 chars, send the album with a short caption (title + ratings), then send the full review via the plugin's `reply` tool as a separate message

### Documents and non-image files

Non-image files (PDF, CSV, etc.) are sent as documents with download link, not inline preview. Use the `reply` tool with `files` array as normal.

## Fallback

If formatting causes errors, retry with plain text by omitting the `format` parameter.
