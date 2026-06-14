import { test, expect, describe } from 'bun:test'
import { githubMdToTelegramMdV2, entitiesToMarkdown, type InboundEntity } from './markdown.ts'

describe('githubMdToTelegramMdV2', () => {
  test('escapes MarkdownV2 specials in plain text', () => {
    expect(githubMdToTelegramMdV2('a.b-c!')).toBe('a\\.b\\-c\\!')
  })

  test('bold / italic / strikethrough', () => {
    expect(githubMdToTelegramMdV2('**bold**')).toBe('*bold*')
    expect(githubMdToTelegramMdV2('_italic_')).toBe('_italic_')
    expect(githubMdToTelegramMdV2('~~gone~~')).toBe('~gone~')
  })

  test('inline code keeps content literal', () => {
    expect(githubMdToTelegramMdV2('`a.b-c`')).toBe('`a.b-c`')
  })

  test('links escape text but not the url', () => {
    expect(githubMdToTelegramMdV2('[my text](http://a.com/x)')).toBe('[my text](http://a.com/x)')
  })

  test('code fences are preserved, content unescaped', () => {
    expect(githubMdToTelegramMdV2('```js\nconst x = 1.5\n```')).toBe('```js\nconst x = 1.5\n```')
  })

  // New formatting

  test('spoiler', () => {
    expect(githubMdToTelegramMdV2('||secret||')).toBe('||secret||')
    expect(githubMdToTelegramMdV2('||a.b||')).toBe('||a\\.b||')
  })

  test('blockquote prefixes each line, no escaped >', () => {
    expect(githubMdToTelegramMdV2('> quoted')).toBe('>quoted')
    expect(githubMdToTelegramMdV2('> a\n> b')).toBe('>a\n>b')
  })

  test('expandable blockquote opens with **> and closes with ||', () => {
    expect(githubMdToTelegramMdV2('>! a\n> b')).toBe('**>a\n>b||')
    expect(githubMdToTelegramMdV2('>! only')).toBe('**>only||')
  })

  test('blockquote content still gets inline formatting', () => {
    expect(githubMdToTelegramMdV2('> **hi** there')).toBe('>*hi* there')
  })

  test('custom emoji passthrough', () => {
    expect(githubMdToTelegramMdV2('![👍](tg://emoji?id=123)')).toBe('![👍](tg://emoji?id=123)')
  })

  test('non-emoji image syntax is not treated as custom emoji (! escaped, link kept)', () => {
    // tg://emoji is required for custom emoji; a normal image degrades to an
    // escaped "!" followed by an ordinary link.
    expect(githubMdToTelegramMdV2('![alt](http://a.com/i.png)')).toBe('\\![alt](http://a.com/i.png)')
  })
})

describe('entitiesToMarkdown', () => {
  test('plain text passes through unchanged', () => {
    expect(entitiesToMarkdown('hello world', [])).toBe('hello world')
    expect(entitiesToMarkdown('hello world', undefined)).toBe('hello world')
  })

  const e = (type: string, offset: number, length: number, extra: Partial<InboundEntity> = {}): InboundEntity =>
    ({ type, offset, length, ...extra })

  test('bold / spoiler / code', () => {
    expect(entitiesToMarkdown('hello', [e('bold', 0, 5)])).toBe('**hello**')
    expect(entitiesToMarkdown('abc', [e('spoiler', 0, 3)])).toBe('||abc||')
    expect(entitiesToMarkdown('x', [e('code', 0, 1)])).toBe('`x`')
  })

  test('text_link', () => {
    expect(entitiesToMarkdown('click', [e('text_link', 0, 5, { url: 'http://x' })])).toBe('[click](http://x)')
  })

  test('blockquote prefixes every line', () => {
    expect(entitiesToMarkdown('line1\nline2', [e('blockquote', 0, 11)])).toBe('> line1\n> line2')
  })

  test('nested entities wrap correctly', () => {
    // bold over "abcd", italic over "bc"
    expect(entitiesToMarkdown('abcd', [e('bold', 0, 4), e('italic', 1, 2)])).toBe('**a_bc_d**')
  })

  test('custom emoji keeps its fallback glyph', () => {
    expect(entitiesToMarkdown('👍', [e('custom_emoji', 0, 2)])).toBe('👍')
  })

  test('unknown entity types pass through', () => {
    expect(entitiesToMarkdown('@name', [e('mention', 0, 5)])).toBe('@name')
  })
})
