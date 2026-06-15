// Telegram MarkdownV2 helpers, factored out of server.ts so they can be unit
// tested without starting the bot.
//
//  - githubMdToTelegramMdV2: outbound. GitHub-flavored markdown → Telegram
//    MarkdownV2 with correct escaping, so callers pass natural markdown without
//    worrying about MarkdownV2 escape rules.
//  - entitiesToMarkdown: inbound. Telegram message entities → markdown-ish text
//    so Claude sees the user's formatting instead of a flattened string.

const MDV2_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!\\]/g
export function escapeMdV2Text(s: string): string {
  return s.replace(MDV2_SPECIALS, '\\$&')
}
export function escapeMdV2Code(s: string): string {
  return s.replace(/[`\\]/g, '\\$&')
}
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

// Render a single line's inline markdown to MarkdownV2: bold, italic,
// underline-as-bold, strikethrough, spoiler, inline code, links, and custom
// emoji. Operates per line so formatting never accidentally spans line breaks
// (Telegram doesn't render cross-line entities anyway).
function renderInlineMdV2(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1)
      if (end !== -1) {
        out += '`' + escapeMdV2Code(s.slice(i + 1, end)) + '`'
        i = end + 1
        continue
      }
    }
    // Custom emoji: ![fallback](tg://emoji?id=123). Requires the bot owner to
    // have Telegram Premium; the fallback emoji shows for everyone else.
    if (s[i] === '!' && s[i + 1] === '[') {
      const closeBracket = s.indexOf(']', i + 2)
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const label = s.slice(i + 2, closeBracket)
          const url = s.slice(closeBracket + 2, closeParen)
          if (/^tg:\/\/emoji\?id=\d+$/.test(url)) {
            out += '![' + escapeMdV2Text(label) + '](' + url + ')'
            i = closeParen + 1
            continue
          }
        }
      }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end !== -1) {
        out += '*' + escapeMdV2Text(s.slice(i + 2, end)) + '*'
        i = end + 2
        continue
      }
    }
    // Spoiler: ||hidden||
    if (s[i] === '|' && s[i + 1] === '|') {
      const end = s.indexOf('||', i + 2)
      if (end !== -1) {
        out += '||' + escapeMdV2Text(s.slice(i + 2, end)) + '||'
        i = end + 2
        continue
      }
    }
    if (s[i] === '_' && s[i + 1] === '_' && !isWordChar(s[i - 1]) && isWordChar(s[i + 2])) {
      let j = i + 2
      let matched = false
      while ((j = s.indexOf('__', j)) !== -1) {
        if (isWordChar(s[j - 1]) && !isWordChar(s[j + 2])) {
          out += '*' + escapeMdV2Text(s.slice(i + 2, j)) + '*'
          i = j + 2
          matched = true
          break
        }
        j++
      }
      if (matched) continue
    }
    if (s[i] === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2)
      if (end !== -1) {
        out += '~' + escapeMdV2Text(s.slice(i + 2, end)) + '~'
        i = end + 2
        continue
      }
    }
    if (s[i] === '_' && !isWordChar(s[i - 1]) && isWordChar(s[i + 1])) {
      let j = i + 1
      let matched = false
      while ((j = s.indexOf('_', j)) !== -1) {
        if (isWordChar(s[j - 1]) && !isWordChar(s[j + 1])) {
          out += '_' + escapeMdV2Text(s.slice(i + 1, j)) + '_'
          i = j + 1
          matched = true
          break
        }
        j++
      }
      if (matched) continue
    }
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1)
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const linkText = s.slice(i + 1, closeBracket)
          const url = s.slice(closeBracket + 2, closeParen)
          out += '[' + escapeMdV2Text(linkText) + '](' + url.replace(/[)\\]/g, '\\$&') + ')'
          i = closeParen + 1
          continue
        }
      }
    }
    const ch = s[i]
    out += /[_*\[\]()~`>#+\-=|{}.!\\]/.test(ch) ? '\\' + ch : ch
    i++
  }
  return out
}

// Render a non-fenced markdown block. Handles GitHub-style blockquotes
// (lines beginning with `>`) as native Telegram blockquotes; a quote whose
// first line opens with `>!` becomes an expandable (collapsed-by-default)
// blockquote. Everything else is rendered inline, line by line.
function renderTextBlock(s: string): string {
  const lines = s.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (/^>/.test(lines[i])) {
      const block: string[] = []
      let expandable = false
      while (i < lines.length && /^>/.test(lines[i])) {
        let content = lines[i].replace(/^>\s?/, '')
        if (block.length === 0 && content.startsWith('!')) {
          expandable = true
          content = content.slice(1).replace(/^\s/, '')
        }
        block.push(renderInlineMdV2(content))
        i++
      }
      const last = block.length - 1
      out.push(
        block
          .map((line, idx) => {
            const prefix = expandable && idx === 0 ? '**>' : '>'
            const suffix = expandable && idx === last ? '||' : ''
            return prefix + line + suffix
          })
          .join('\n'),
      )
    } else {
      out.push(renderInlineMdV2(lines[i]))
      i++
    }
  }
  return out.join('\n')
}

export function githubMdToTelegramMdV2(input: string): string {
  const parts: { kind: 'fence' | 'text', body: string, lang?: string }[] = []
  const fenceRe = /```([a-zA-Z0-9_.+-]*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(input)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', body: input.slice(last, m.index) })
    parts.push({ kind: 'fence', lang: m[1], body: m[2] })
    last = m.index + m[0].length
  }
  if (last < input.length) parts.push({ kind: 'text', body: input.slice(last) })

  return parts.map(p => {
    if (p.kind === 'fence') {
      const lang = p.lang ?? ''
      return '```' + lang + '\n' + escapeMdV2Code(p.body.replace(/\n$/, '')) + '\n```'
    }
    return renderTextBlock(p.body)
  }).join('')
}

// Inbound rich text: Telegram delivers formatting out-of-band as message
// entities (offset/length over UTF-16 code units, which line up with JS string
// indices). Reconstruct a markdown-ish view so Claude sees the user's bold,
// quotes, spoilers, code, links, and custom-emoji placeholders instead of a
// flattened plain string. Best-effort: unknown entity types and plain messages
// pass through unchanged.
export type InboundEntity = {
  type: string
  offset: number
  length: number
  url?: string
  language?: string
}
function inlineWrapFor(e: InboundEntity): { open: string; close: string } | null {
  switch (e.type) {
    case 'bold': return { open: '**', close: '**' }
    case 'italic': return { open: '_', close: '_' }
    case 'underline': return { open: '__', close: '__' }
    case 'strikethrough': return { open: '~~', close: '~~' }
    case 'spoiler': return { open: '||', close: '||' }
    case 'code': return { open: '`', close: '`' }
    case 'pre': return { open: '```' + (e.language ?? '') + '\n', close: '\n```' }
    case 'text_link': return { open: '[', close: '](' + (e.url ?? '') + ')' }
    // mention, url, custom_emoji, hashtag, bot_command, etc. keep their literal
    // text (custom emoji already carries a fallback emoji in the text).
    default: return null
  }
}
export function entitiesToMarkdown(text: string, entities: InboundEntity[] | undefined): string {
  if (!entities || entities.length === 0) return text
  const opens: Record<number, string[]> = {}
  const closes: Record<number, string[]> = {}
  const quote = new Array<boolean>(text.length + 1).fill(false)
  const quoteStart = new Set<number>()
  // Outer (longer) entities open first / close last at a shared boundary.
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length)
  for (const e of sorted) {
    if (e.type === 'blockquote' || e.type === 'expandable_blockquote') {
      quoteStart.add(e.offset)
      for (let k = e.offset; k < e.offset + e.length && k < text.length; k++) quote[k] = true
      continue
    }
    const w = inlineWrapFor(e)
    if (!w) continue
    ;(opens[e.offset] ??= []).push(w.open)
    ;(closes[e.offset + e.length] ??= []).unshift(w.close)
  }
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (closes[i]) out += closes[i]!.join('')
    if (quoteStart.has(i)) out += '> '
    if (opens[i]) out += opens[i]!.join('')
    const ch = text[i]
    out += ch
    if (ch === '\n' && quote[i + 1]) out += '> '
  }
  if (closes[text.length]) out += closes[text.length]!.join('')
  return out
}
