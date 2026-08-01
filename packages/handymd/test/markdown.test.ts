import { describe, expect, test } from 'bun:test'
import { markdownToDoc, docToMarkdown } from '../src/markdown'
import { schema } from '../src/schema'

describe('markdown ↔ doc roundtrip', () => {
  const samples = [
    '',
    'plain',
    '# Title',
    '## H2\n\npara **bold** and *em*',
    '- [x] done\n- [ ] open\n- bullet',
    '> quote\n> still',
    '```ts\nconst a = 1\n```',
    '1. a\n2. b\n\n---\n\nend',
    'see ==mark== and [link](https://a.b) #tag',
    '*outer **inner**.*',
    'line1\n\n\nline4',
  ]

  for (const md of samples) {
    test(`lossless: ${JSON.stringify(md).slice(0, 40)}`, () => {
      expect(docToMarkdown(markdownToDoc(md))).toBe(md)
    })
  }

  test('normalizes CRLF to LF on parse', () => {
    const doc = markdownToDoc('a\r\nb\rc')
    expect(docToMarkdown(doc)).toBe('a\nb\nc')
  })

  test('empty string yields a single empty block', () => {
    const doc = markdownToDoc('')
    expect(doc.childCount).toBe(1)
    expect(doc.firstChild!.textContent).toBe('')
  })

  test('uses default schema nodes', () => {
    const doc = markdownToDoc('# x')
    expect(doc.type).toBe(schema.nodes.doc)
    expect(doc.firstChild!.type).toBe(schema.nodes.block)
  })
})
