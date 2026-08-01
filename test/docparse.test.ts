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

  test('diagram region shares hit range and open line carries the source', () => {
    const doc = markdownToDoc('```mermaid\ngraph TD\nA-->B\n```\nafter')
    const blocks = parseDoc(doc)
    const open = blocks[0].elements.find((e) => e.kind === 'diagramOpen')!
    const line = blocks[1].elements.find((e) => e.kind === 'diagramLine')!
    const close = blocks[3].elements.find((e) => e.kind === 'diagramClose')!

    // 整块区域共享 hit 区间：光标进入任意一行 → 全部 Revealed
    expect(open.hitFrom).toBe(close.hitFrom)
    expect(open.hitTo).toBe(close.hitTo)
    expect(line.hitFrom).toBe(open.hitFrom)
    expect(line.hitTo).toBe(open.hitTo)

    // diagram 行参与 reveal 判定（不像 codeLine 是 static）
    expect(open.static).toBeUndefined()
    expect(line.static).toBeUndefined()
    expect(close.static).toBeUndefined()
    expect(open.permanent).toBeUndefined()

    // open 行聚合源码
    expect(open.attrs?.lang).toBe('mermaid')
    expect(open.attrs?.code).toBe('graph TD\nA-->B')

    // 体内不做行内解析
    expect(blocks[2].elements.some((e) => e.kind !== 'diagramLine')).toBe(false)
  })

  test('unclosed / empty diagram regions', () => {
    const unclosed = parseDoc(markdownToDoc('```mermaid\ngraph TD'))
    const open = unclosed[0].elements.find((e) => e.kind === 'diagramOpen')!
    expect(open.attrs?.code).toBe('graph TD')
    expect(open.hitTo).toBe(unclosed[1].pos + unclosed[1].size)

    const empty = parseDoc(markdownToDoc('```mermaid\n```'))
    expect(empty[0].elements.find((e) => e.kind === 'diagramOpen')!.attrs?.code).toBe('')
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
