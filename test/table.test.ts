import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { classifyLines } from '../src/parse/blocks'
import {
  buildTableMarkdown,
  insertTable,
  goToNextTableCell,
  continueTableRow,
} from '../src/table'
import { isTableSeparator, parseTableRow } from '../src/parse/table'
import { markdownToDoc } from '../src/markdown'
import { concealPlugin, concealKey } from '../src/conceal/plugin'
import { createEditor } from '../src/editor'
import { markdownKeymap } from '../src/keymap'

describe('parseTableRow / separator', () => {
  test('splits cells and pipes', () => {
    const parsed = parseTableRow('| a | b |')
    expect(parsed.cells.map((c) => c.text)).toEqual([' a ', ' b '])
    expect(parsed.pipes.length).toBe(3)
  })

  test('separator requires pipes (no conflict with hr)', () => {
    expect(isTableSeparator('| --- | --- |')).toBe(true)
    expect(isTableSeparator('| :--- | ---: |')).toBe(true)
    expect(isTableSeparator('---')).toBe(false)
    expect(isTableSeparator('| abc |')).toBe(false)
  })
})

describe('classifyLines tables', () => {
  test('recognizes header + sep + body', () => {
    const lines = classifyLines([
      '| H1 | H2 |',
      '| --- | --- |',
      '| a | b |',
      '| c | d |',
      '',
      'after',
    ])
    expect(lines.map((l) => l.t)).toEqual([
      'tableHeader',
      'tableSep',
      'tableRow',
      'tableRow',
      'blank',
      'para',
    ])
    expect(lines[0]).toMatchObject({ colCount: 2 })
  })

  test('bare pipes without separator stay para', () => {
    expect(classifyLines(['| not a table |'])[0].t).toBe('para')
  })

  test('hr still wins for ---', () => {
    expect(classifyLines(['---'])[0].t).toBe('hr')
  })
})

describe('buildTableMarkdown / insertTable', () => {
  test('buildTableMarkdown shape', () => {
    const md = buildTableMarkdown({ rows: 3, cols: 2, headers: ['A', 'B'] })
    expect(md).toBe(['| A | B |', '| --- | --- |', '|  |  |', '|  |  |'].join('\n'))
  })

  test('insertTable replaces empty block and places caret in first cell', () => {
    const state = EditorState.create({
      doc: markdownToDoc(''),
      plugins: [concealPlugin(), markdownKeymap()],
    })
    let next = state
    const ok = insertTable({ rows: 2, cols: 2 })(state, (tr) => {
      next = state.apply(tr)
    })
    expect(ok).toBe(true)
    expect(next.doc.textContent).toContain('|')
    const md = next.doc.textBetween(0, next.doc.content.size, '\n')
    // doc textBetween with block sep
    const lines: string[] = []
    next.doc.forEach((b) => lines.push(b.textContent))
    expect(lines).toEqual(['|  |  |', '| --- | --- |', '|  |  |'])
    const sel = next.selection.from
    // 落在首格左侧 padding 空格之后：`| ` 之后
    expect(sel).toBe(1 + 2)
  })

  test('HandyEditor.insertTable API', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor({ mount: el, content: '' })
    expect(ed.insertTable({ rows: 3, cols: 3 })).toBe(true)
    const lines = ed.getMarkdown().split('\n')
    expect(lines[0]).toBe('|  |  |  |')
    expect(lines[1]).toBe('| --- | --- | --- |')
    expect(lines.length).toBe(4)
    // decorations present
    const st = concealKey.getState(ed.view!.state)!
    const kinds = st.blocks.flatMap((b) => b.elements.map((e) => e.kind))
    expect(kinds).toContain('tableHeader')
    expect(kinds).toContain('tableSep')
    expect(kinds).toContain('tableRow')
    expect(kinds).toContain('tableCell')
    await ed.destroy()
  })
})

describe('table keymap', () => {
  test('Tab moves to next cell', () => {
    const md = '| A | B |\n| --- | --- |\n| c | d |'
    const state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin(), markdownKeymap()],
    })
    // caret in first header cell
    const parsed = parseTableRow('| A | B |')
    let cur = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1 + parsed.cells[0].from + 1)),
    )
    const ok = goToNextTableCell(cur, (tr) => {
      cur = cur.apply(tr)
    })
    expect(ok).toBe(true)
    // should be in second header cell
    expect(cur.selection.from).toBeGreaterThan(1 + parsed.cells[0].to)
  })

  test('Enter inserts a body row', () => {
    const md = '| A | B |\n| --- | --- |\n| c | d |'
    let state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin(), markdownKeymap()],
    })
    const st = concealKey.getState(state)!
    const body = st.blocks.find((b) => b.line.t === 'tableRow')!
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, body.pos + 3)),
    )
    const before = state.doc.childCount
    const ok = continueTableRow(state, (tr) => {
      state = state.apply(tr)
    })
    expect(ok).toBe(true)
    expect(state.doc.childCount).toBe(before + 1)
    const lines: string[] = []
    state.doc.forEach((b) => lines.push(b.textContent))
    expect(lines[lines.length - 1]).toBe('|  |  |')
  })
})

describe('table decorations', () => {
  test('pipes concealed; sep collapsed; cells styled', () => {
    const md = '| H |\n| --- |\n| x |'
    const state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin()],
    })
    const set = concealKey.getState(state)!.set
    const pipes = set.find(
      undefined,
      undefined,
      (spec) => (spec as { kind?: string; role?: string }).kind === 'tableHeader' && (spec as { role?: string }).role === 'marker',
    )
    expect(pipes.length).toBeGreaterThan(0)
    expect(pipes.every((d) => (d.spec as { concealed: boolean }).concealed)).toBe(true)

    const cells = set.find(
      undefined,
      undefined,
      (spec) => (spec as { kind?: string }).kind === 'tableCell',
    )
    expect(cells.length).toBe(2) // header + body

    const sep = set.find(
      undefined,
      undefined,
      (spec) => (spec as { kind?: string; role?: string }).kind === 'tableSep' && (spec as { role?: string }).role === 'node',
    )
    expect(sep.length).toBe(1)
  })
})
