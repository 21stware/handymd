import { describe, expect, test } from 'bun:test'
import { markdownToDoc } from '../src/markdown'
import { parseDoc } from '../src/parse/docparse'

describe('parseDoc (absolute ranges)', () => {
  test('heading markers and content positions', () => {
    const doc = markdownToDoc('## Hello')
    const [block] = parseDoc(doc)
    const h = block.elements.find((e) => e.kind === 'heading')!
    expect(h.attrs?.level).toBe(2)
    expect(h.permanent).toBeUndefined()
    expect(doc.textBetween(h.markers[0].from, h.markers[0].to)).toBe('## ')
    expect(doc.textBetween(h.content!.from, h.content!.to)).toBe('Hello')
    // block-scoped hit covers the whole node
    expect(h.hitFrom).toBe(block.pos)
    expect(h.hitTo).toBe(block.pos + block.size)
  })

  test('inline elements get adjacency pad on hit range', () => {
    const doc = markdownToDoc('x **bold** y')
    const [block] = parseDoc(doc)
    const strong = block.elements.find((e) => e.kind === 'strong')!
    expect(strong.hitFrom).toBe(strong.from - 1)
    expect(strong.hitTo).toBe(strong.to + 1)
  })

  test('todo carries checkPos into source text', () => {
    const doc = markdownToDoc('- [x] done')
    const todo = parseDoc(doc)[0].elements.find((e) => e.kind === 'todo')!
    expect(todo.permanent).toBe(true)
    expect(todo.attrs?.checked).toBe(true)
    expect(doc.textBetween(todo.attrs!.checkPos!, todo.attrs!.checkPos! + 1)).toBe('x')
  })

  test('fence region shares hit range across open/code/close', () => {
    const doc = markdownToDoc('```js\ncode\n```\nafter')
    const blocks = parseDoc(doc)
    const open = blocks[0].elements.find((e) => e.kind === 'fenceOpen')!
    const code = blocks[1].elements.find((e) => e.kind === 'codeLine')!
    const close = blocks[2].elements.find((e) => e.kind === 'fenceClose')!
    expect(open.hitFrom).toBe(close.hitFrom)
    expect(open.hitTo).toBe(close.hitTo)
    expect(code.static).toBe(true)
    expect(blocks[1].elements.some((e) => e.kind === 'strong')).toBe(false)
  })

  test('quote / bullet / hr are permanent', () => {
    const doc = markdownToDoc('> q\n- b\n---')
    const kinds = parseDoc(doc).flatMap((b) => b.elements.map((e) => e.kind))
    expect(kinds).toEqual(['quote', 'bullet', 'hr'])
    for (const b of parseDoc(doc)) {
      for (const el of b.elements) expect(el.permanent).toBe(true)
    }
  })

  test('mark and nested em+strong appear together', () => {
    const doc = markdownToDoc('==hi== and *a **b** c*')
    const els = parseDoc(doc)[0].elements
    expect(els.map((e) => e.kind).sort()).toEqual(['em', 'mark', 'strong'])
  })
})
