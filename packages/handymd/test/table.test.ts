import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { classifyLines } from '../src/parse/blocks'
import {
  buildTableMarkdown,
  insertTable,
  goToNextTableCell,
  continueTableRow,
} from '../src/table'
import { history as pmHistory, undo } from 'prosemirror-history'
import { cellSourceFromInput, isTableSeparator, parseTableRow } from '../src/parse/table'
import { markdownToDoc } from '../src/markdown'
import { concealPlugin, concealKey } from '../src/conceal/plugin'
import { focusTableCell, parseTableModel, tableControllerAt } from '../src/conceal/tableview'
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  joinTableSource,
  moveTableColumn,
  moveTableRow,
  setTableColumnAlign,
  splitTableSource,
  type TableSource,
} from '../src/tableops'
import { createEditor } from '../src/editor'
import { backspaceIntoTable, markdownKeymap } from '../src/keymap'

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

function mountView(md: string, plugins = [concealPlugin(), markdownKeymap()]) {
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  mount.classList.add('handymd')
  const view = new EditorView(mount, {
    state: EditorState.create({ doc: markdownToDoc(md), plugins: [...plugins, pmHistory()] }),
  })
  const lines = () => {
    const out: string[] = []
    view.state.doc.forEach((b) => out.push(b.textContent))
    return out
  }
  const cleanup = () => {
    view.destroy()
    mount.remove()
  }
  return { view, mount, lines, cleanup }
}

function typeInto(cell: HTMLElement, text: string): void {
  cell.textContent = text
  cell.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
}

function key(cell: HTMLElement, k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })
  cell.dispatchEvent(e)
  return e
}

function editingCell(mount: HTMLElement): HTMLElement {
  return mount.querySelector('.hm-table-cell-editing') as HTMLElement
}

describe('table decorations', () => {
  test('whole table is one grid widget on the header line; other lines collapse', () => {
    const md = '| H |\n| --- |\n| x |\n\nafter'
    const state = EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] })
    const set = concealKey.getState(state)!.set
    const find = (kind: string, role: string) =>
      set.find(undefined, undefined, (spec) => {
        const s = spec as { kind?: string; role?: string }
        return s.kind === kind && s.role === role
      })
    expect(find('tableHeader', 'widget').length).toBe(1)
    expect(find('tableRow', 'widget').length).toBe(0)
    expect(find('tableSep', 'node').length).toBe(1)
    expect(find('tableRow', 'node').length).toBe(1)
  })

  test('grid renders every row with aligned columns and inline previews', () => {
    const { mount, cleanup } = mountView(
      [
        '更完整的用法见：',
        '',
        '| 文档 | 内容 |',
        '|---|:---:|',
        '| [docs/api.md](./docs/api.md) | 完整 API 参考 |',
        '| [docs/architecture.md](./docs/architecture.md) | **四层**状态机 |',
      ].join('\n'),
    )
    const tables = mount.querySelectorAll('table.hm-table-grid')
    expect(tables.length).toBe(1)
    const rows = [...tables[0]!.querySelectorAll('tr')]
    expect(rows.length).toBe(3)
    for (const tr of rows) expect(tr.querySelectorAll('.hm-table-cell').length).toBe(2)
    expect(rows[0]!.querySelectorAll('th').length).toBe(2)
    expect(rows[1]!.querySelector('.hm-link')?.textContent).toBe('docs/api.md')
    expect(rows[2]!.textContent).not.toContain('**')
    expect((rows[1]!.children[1] as HTMLElement).style.textAlign).toBe('center')
    cleanup()
  })

  test('table lines never reveal to pipe source, even with the caret inside', () => {
    const md = '| A | B |\n| --- | --- |\n| c | d |'
    let state = EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] })
    const body = concealKey.getState(state)!.blocks.find((b) => b.line.t === 'tableRow')!
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, body.pos + 3)))
    const widgets = concealKey
      .getState(state)!
      .set.find(undefined, undefined, (s) => (s as { kind?: string }).kind === 'tableHeader' && (s as { role?: string }).role === 'widget')
    expect(widgets.length).toBe(1)
  })
})

describe('in-cell editing', () => {
  const MD = '| A | B |\n| --- | --- |\n| c | **d** |\n\nafter'

  test('editing a cell shows its source and writes back only that cell', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    expect(focusTableCell(view, 0, { row: 1, col: 1 })).toBe(true)
    let cell = editingCell(mount)
    expect(cell.textContent).toBe('**d**')
    typeInto(cell, '**d2**')
    expect(lines()[2]).toBe('| c | **d2** |')
    // widget 重建后焦点与编辑态还原到同一格
    cell = editingCell(mount)
    expect(cell?.dataset.row).toBe('1')
    expect(cell?.dataset.col).toBe('1')
    expect(document.activeElement).toBe(cell)
    cleanup()
  })

  test('pipes typed into a cell are escaped', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    focusTableCell(view, 0, { row: 0, col: 0 })
    typeInto(editingCell(mount), 'a|b')
    expect(lines()[0]).toBe('| a\\|b | B |')
    expect(parseTableRow(lines()[0]!).cells.length).toBe(2)
    cleanup()
  })

  test('Tab / Enter navigate; Tab on the last cell appends a row', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    focusTableCell(view, 0, { row: 0, col: 1 })
    key(editingCell(mount), 'Tab')
    expect(editingCell(mount).dataset.row).toBe('1')
    expect(editingCell(mount).dataset.col).toBe('0')
    key(editingCell(mount), 'Tab')
    key(editingCell(mount), 'Tab')
    expect(lines()).toEqual(['| A | B |', '| --- | --- |', '| c | **d** |', '|  |  |', '', 'after'])
    expect(editingCell(mount).dataset.row).toBe('2')
    key(editingCell(mount), 'Enter', { shiftKey: false })
    expect(lines().length).toBe(7)
    cleanup()
  })

  test('Backspace in the first cell of an empty row deletes the row', () => {
    const { view, mount, lines, cleanup } = mountView('| A | B |\n| --- | --- |\n|  |  |')
    focusTableCell(view, 0, { row: 1, col: 0 })
    key(editingCell(mount), 'Backspace')
    expect(lines()).toEqual(['| A | B |', '| --- | --- |'])
    expect(editingCell(mount).dataset.row).toBe('0')
    cleanup()
  })

  test('missing cells are padded when edited', () => {
    const { view, mount, lines, cleanup } = mountView('| A | B |\n| --- | --- |\n| c |')
    focusTableCell(view, 0, { row: 1, col: 1 })
    typeInto(editingCell(mount), 'z')
    expect(lines()[2]).toBe('| c | z |')
    cleanup()
  })

  test('undo inside a cell reverts the source and keeps editing', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    focusTableCell(view, 0, { row: 1, col: 0 })
    typeInto(editingCell(mount), 'cc')
    expect(lines()[2]).toBe('| cc | **d** |')
    key(editingCell(mount), 'z', { metaKey: true })
    expect(lines()[2]).toBe('| c | **d** |')
    expect(editingCell(mount)?.textContent).toBe('c')
    cleanup()
  })

  test('ArrowDown on the last row leaves the table', () => {
    const { view, mount, cleanup } = mountView(MD)
    focusTableCell(view, 0, { row: 1, col: 0 })
    key(editingCell(mount), 'ArrowDown')
    expect(editingCell(mount)).toBeNull()
    const $pos = view.state.selection.$from
    expect($pos.parent.textContent).toBe('')
    expect($pos.before()).toBeGreaterThan(0)
    cleanup()
  })
})

describe('join guards next to a table', () => {
  test('Backspace at the start of the line after a table does not merge into it', () => {
    const md = '| A |\n| --- |\n| c |\nafter'
    let state = EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] })
    const after = concealKey.getState(state)!.blocks.at(-1)!
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, after.pos + 1)))
    expect(backspaceIntoTable(state, (tr) => (state = state.apply(tr)))).toBe(true)
    const lines: string[] = []
    state.doc.forEach((b) => lines.push(b.textContent))
    expect(lines).toEqual(['| A |', '| --- |', '| c |', 'after'])
  })

  test('Backspace on an empty line after a table removes the line', () => {
    const md = '| A |\n| --- |\n| c |\n'
    let state = EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] })
    const last = concealKey.getState(state)!.blocks.at(-1)!
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, last.pos + 1)))
    expect(backspaceIntoTable(state, (tr) => (state = state.apply(tr)))).toBe(true)
    expect(state.doc.childCount).toBe(3)
  })
})

describe('table source helpers', () => {
  test('escaped pipes stay inside a cell', () => {
    expect(parseTableRow('| a \\| b | c |').cells.map((c) => c.text)).toEqual([' a \\| b ', ' c '])
  })

  test('cellSourceFromInput pads, flattens newlines and escapes bare pipes', () => {
    expect(cellSourceFromInput('')).toBe('  ')
    expect(cellSourceFromInput('x')).toBe(' x ')
    expect(cellSourceFromInput('a\nb')).toBe(' a b ')
    expect(cellSourceFromInput('a|b')).toBe(' a\\|b ')
    expect(cellSourceFromInput('a\\|b')).toBe(' a\\|b ')
  })

  test('parseTableModel reads alignment and rows', () => {
    const m = parseTableModel('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 |')
    expect(m.align).toEqual(['left', 'center', 'right'])
    expect(m.colCount).toBe(3)
    expect(m.rows.length).toBe(2)
  })
})

describe('table structure ops (source level)', () => {
  const SRC = '| A | B | C |\n| :--- | :---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'
  const t = () => splitTableSource(SRC)
  const text = (s: TableSource | null) => (s ? joinTableSource(s).join('\n') : null)

  test('row insert / move / delete keep untouched lines verbatim', () => {
    expect(text(insertTableRow(t(), 2))).toBe(
      '| A | B | C |\n| :--- | :---: | --- |\n| 1 | 2 | 3 |\n|  |  |  |\n| 4 | 5 | 6 |',
    )
    expect(text(moveTableRow(t(), 2, 1))).toBe(
      '| A | B | C |\n| :--- | :---: | --- |\n| 4 | 5 | 6 |\n| 1 | 2 | 3 |',
    )
    expect(text(deleteTableRow(t(), 1))).toBe('| A | B | C |\n| :--- | :---: | --- |\n| 4 | 5 | 6 |')
  })

  test('deleting the header promotes the next row; deleting the last row drops the table', () => {
    expect(text(deleteTableRow(t(), 0))).toBe('| 1 | 2 | 3 |\n| :--- | :---: | --- |\n| 4 | 5 | 6 |')
    const one = splitTableSource('| A |\n| --- |')
    expect(deleteTableRow(one, 0)).toBeNull()
  })

  test('a short row moved into the header is padded to the column count', () => {
    const s = splitTableSource('| A | B |\n| --- | --- |\n| x |')
    expect(text(moveTableRow(s, 1, 0))).toBe('| x |  |\n| --- | --- |\n| A | B |')
  })

  test('column insert / move / delete rewrite every row and the alignment row', () => {
    expect(text(insertTableColumn(t(), 1))).toBe(
      '| A |  | B | C |\n| :--- | --- | :---: | --- |\n| 1 |  | 2 | 3 |\n| 4 |  | 5 | 6 |',
    )
    expect(text(moveTableColumn(t(), 0, 2))).toBe(
      '| B | C | A |\n| :---: | --- | :--- |\n| 2 | 3 | 1 |\n| 5 | 6 | 4 |',
    )
    expect(text(deleteTableColumn(t(), 1))).toBe('| A | C |\n| :--- | --- |\n| 1 | 3 |\n| 4 | 6 |')
    expect(deleteTableColumn(splitTableSource('| A |\n| --- |\n| x |'), 0)).toBeNull()
  })

  test('column alignment rewrites only the separator', () => {
    expect(text(setTableColumnAlign(t(), 2, 'right'))).toBe(
      '| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |',
    )
  })
})

describe('table widget: pick rows / columns', () => {
  const MD = 'before\n\n| A | B |\n| --- | --- |\n| c | d |\n| e | f |\n\nafter'
  const headerPos = (view: EditorView) => concealKey.getState(view.state)!.blocks.find((b) => b.line.t === 'tableHeader')!.pos

  test('picking a row highlights it; Alt+ArrowUp moves it and keeps it picked', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    tableControllerAt(view, headerPos(view))!.pick({ kind: 'row', index: 2 })
    expect([...mount.querySelectorAll('.hm-table-cell-picked')].map((c) => c.textContent)).toEqual(['e', 'f'])
    expect(mount.querySelector('.hm-table-menu')).not.toBeNull()
    const wrap = mount.querySelector('.hm-table-wrap') as HTMLElement
    key(wrap, 'ArrowUp', { altKey: true })
    expect(lines().slice(2, 6)).toEqual(['| A | B |', '| --- | --- |', '| e | f |', '| c | d |'])
    expect([...mount.querySelectorAll('.hm-table-cell-picked')].map((c) => c.textContent)).toEqual(['e', 'f'])
    cleanup()
  })

  test('Backspace deletes the picked column; undo restores it', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    tableControllerAt(view, headerPos(view))!.pick({ kind: 'col', index: 0 })
    const wrap = mount.querySelector('.hm-table-wrap') as HTMLElement
    key(wrap, 'Backspace')
    expect(lines().slice(2, 6)).toEqual(['| B |', '| --- |', '| d |', '| f |'])
    undo(view.state, view.dispatch)
    expect(lines().slice(2, 6)).toEqual(['| A | B |', '| --- | --- |', '| c | d |', '| e | f |'])
    cleanup()
  })

  test('menu buttons insert a row below and start editing it', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    tableControllerAt(view, headerPos(view))!.pick({ kind: 'row', index: 1 })
    const btn = [...mount.querySelectorAll<HTMLButtonElement>('.hm-table-menu button')].find(
      (b) => b.textContent === '下方插入',
    )!
    btn.click()
    expect(lines().slice(4, 7)).toEqual(['| c | d |', '|  |  |', '| e | f |'])
    expect(editingCell(mount)?.dataset.row).toBe('2')
    cleanup()
  })

  test('Alt+ArrowDown while editing a cell moves its row', () => {
    const { view, mount, lines, cleanup } = mountView(MD)
    focusTableCell(view, headerPos(view), { row: 1, col: 1 })
    key(editingCell(mount), 'ArrowDown', { altKey: true })
    expect(lines().slice(4, 6)).toEqual(['| e | f |', '| c | d |'])
    expect(editingCell(mount)?.dataset.row).toBe('2')
    expect(editingCell(mount)?.textContent).toBe('d')
    cleanup()
  })
})
