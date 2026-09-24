/**
 * 表格的可视化与单元格内编辑。
 *
 * 整张表在表头行渲染为一个 `<table>` widget，其余源码行（分隔行 / 表体）折叠为零高。
 * 源码仍是管道表格文本 —— widget 只是它的投影：
 *
 *   - 单元格平时画预览（隐藏 `**` / `[]()` 等标记符）
 *   - 点击（或光标经由键盘进入表格行）后该格变为独立的 plaintext 编辑框，
 *     展示这一格的源码；每次输入立刻把这一格写回对应行的源码区间
 *   - 写回会让 widget 以新源码重建，重建后把焦点 / 光标还原到同一格
 *
 * 编辑框位于 contenteditable=false 的 widget 里，stopEvent 让 ProseMirror 完全
 * 不接管其中的事件与 DOM 变更；键盘导航 / 撤销 / IME 都在这里自行处理。
 */

import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection, type Transaction } from 'prosemirror-state'
import { closeHistory, redo, undo } from 'prosemirror-history'
import { parseInlineCached } from '../parse/inline'
import {
  cellDisplaySource,
  cellSourceFromInput,
  emptyCellText,
  formatTableRow,
  isTableSeparator,
  looksLikeTableRow,
  parseTableAlign,
  parseTableRow,
  type TableAlign,
} from '../parse/table'
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
} from '../tableops'

function equalStyle(
  a: { kind: string; href?: string } | null,
  b: { kind: string; href?: string } | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.href === b.href
}

interface CellAnalysis {
  text: string
  hide: boolean[]
  styleAt: ({ kind: string; href?: string } | null)[]
}

function analyzeCell(raw: string): CellAnalysis {
  const text = cellDisplaySource(raw)
  const els = parseInlineCached(text)
  const hide = new Array<boolean>(text.length).fill(false)
  for (const e of els) {
    for (const m of e.markers) {
      for (let i = m.from; i < m.to && i < text.length; i++) hide[i] = true
    }
  }
  const styleAt: CellAnalysis['styleAt'] = new Array(text.length).fill(null)
  for (const e of els) {
    if (!e.content) continue
    if (!['link', 'strong', 'em', 'code', 'strike', 'mark', 'tag'].includes(e.kind)) continue
    for (let i = e.content.from; i < e.content.to && i < text.length; i++) {
      styleAt[i] = { kind: e.kind, href: e.attrs?.href }
    }
  }
  return { text, hide, styleAt }
}

/** 把单元格源码画成预览 DOM：隐藏标记符，保留 link/strong 等语义 class */
export function renderCellPreview(raw: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const { text, hide, styleAt } = analyzeCell(raw)
  let i = 0
  while (i < text.length) {
    if (hide[i]) {
      i++
      continue
    }
    const st = styleAt[i]
    let j = i + 1
    while (j < text.length && !hide[j] && equalStyle(styleAt[j], st)) j++
    const slice = text.slice(i, j)
    if (st) {
      const span = document.createElement('span')
      span.className =
        st.kind === 'link' ? 'hm-link' : st.kind === 'tag' ? 'hm-tag' : `hm-${st.kind}`
      if (st.href) span.setAttribute('data-href', st.href)
      span.textContent = slice
      frag.appendChild(span)
    } else {
      frag.appendChild(document.createTextNode(slice))
    }
    i = j
  }
  return frag
}

/** 预览里的第 n 个可见字符 → 编辑框源码偏移 */
function previewOffsetToSource(raw: string, visible: number): number {
  const { text, hide } = analyzeCell(raw)
  let seen = 0
  let lastEnd = 0
  for (let i = 0; i < text.length; i++) {
    if (hide[i]) continue
    if (seen === visible) return i
    seen++
    lastEnd = i + 1
  }
  return visible === 0 ? 0 : lastEnd
}

// ---------------------------------------------------------------------------
// 表格源码模型
// ---------------------------------------------------------------------------

export interface TableModel {
  /** 每行的单元格源码（含 padding）；第 0 行是表头，不含分隔行 */
  rows: string[][]
  align: TableAlign[]
  colCount: number
}

export function parseTableModel(src: string): TableModel {
  const lines = src.split('\n')
  const header = parseTableRow(lines[0] ?? '').cells.map((c) => c.text)
  const align = lines[1] !== undefined ? parseTableAlign(lines[1]) : []
  const colCount = Math.max(1, align.length || header.length)
  const rows = [header, ...lines.slice(2).map((l) => parseTableRow(l).cells.map((c) => c.text))]
  return { rows, align, colCount }
}

/** 模型行号 → 源码行号（跳过分隔行） */
function lineIndexOfRow(row: number): number {
  return row === 0 ? 0 : row + 1
}

/** 从表头块起逐行收集整张表的块位置（与 classifyLines 的表格状态机一致） */
export function tableLinePositions(doc: PMNode, headerPos: number): number[] {
  const out: number[] = []
  let pos = headerPos
  let idx = 0
  while (pos < doc.content.size) {
    const node = doc.nodeAt(pos)
    if (!node) break
    const text = node.textContent
    if (idx === 0) {
      if (!looksLikeTableRow(text)) break
    } else if (idx === 1) {
      if (!isTableSeparator(text)) break
    } else if (!looksLikeTableRow(text) || isTableSeparator(text)) {
      break
    }
    out.push(pos)
    pos += node.nodeSize
    idx++
  }
  return out
}

// ---------------------------------------------------------------------------
// 编辑会话
// ---------------------------------------------------------------------------

export interface TableViewOptions {
  onOpenLink?: (href: string) => void
}

interface Target {
  row: number
  col: number
}

type Caret = number | 'start' | 'end'

/** 写回 / 撤销导致 widget 重建时，旧编辑框的 blur 不能当作「离开编辑」 */
let rebuilding = false

const CONTROLLER = Symbol('hm-table')

type WrapEl = HTMLElement & { [CONTROLLER]?: TableController }

function supportsPlaintextOnly(el: HTMLElement): boolean {
  el.contentEditable = 'plaintext-only'
  return el.contentEditable === 'plaintext-only'
}

function caretOffsetIn(el: HTMLElement): number {
  const sel = el.ownerDocument.getSelection()
  if (!sel || !sel.rangeCount || !el.contains(sel.focusNode)) return (el.textContent ?? '').length
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  range.setEnd(sel.focusNode!, sel.focusOffset)
  return range.toString().length
}

function selectionOffsetsIn(el: HTMLElement): { from: number; to: number } {
  const sel = el.ownerDocument.getSelection()
  const len = (el.textContent ?? '').length
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) {
    return { from: len, to: len }
  }
  const r = sel.getRangeAt(0)
  const pre = el.ownerDocument.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(r.startContainer, r.startOffset)
  const from = pre.toString().length
  return { from, to: from + r.toString().length }
}

function setCaretIn(el: HTMLElement, from: number, to = from): void {
  const doc = el.ownerDocument
  const sel = doc.getSelection()
  if (!sel) return
  const text = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null
  const range = doc.createRange()
  if (text) {
    const len = text.textContent?.length ?? 0
    range.setStart(text, Math.max(0, Math.min(from, len)))
    range.setEnd(text, Math.max(0, Math.min(to, len)))
  } else {
    range.setStart(el, 0)
    range.collapse(true)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

/** `|` 转义后编辑框前缀长度会变长：按转义结果重新计算光标 */
function escapedLength(input: string): number {
  return cellDisplaySource(cellSourceFromInput(input)).length
}

function caretFromPoint(cell: HTMLElement, x: number, y: number): number {
  const doc = cell.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  let node: Node | null = null
  let offset = 0
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) {
    node = pos.offsetNode
    offset = pos.offset
  } else {
    const r = doc.caretRangeFromPoint?.(x, y)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  }
  if (!node || !cell.contains(node)) return -1
  const range = doc.createRange()
  range.selectNodeContents(cell)
  range.setEnd(node, offset)
  return range.toString().length
}

/** 整行 / 整列被选中（点击边缘把手） */
export interface TablePick {
  kind: 'row' | 'col'
  index: number
}

const GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">' +
  [3, 8, 13].map((y) => `<circle cx="3" cy="${y}" r="1.3"/><circle cx="7" cy="${y}" r="1.3"/>`).join('') +
  '</svg>'

class TableController {
  readonly wrap: WrapEl
  private readonly scroller: HTMLElement
  private readonly inner: HTMLElement
  private readonly table: HTMLTableElement
  private readonly rowHandle: HTMLElement
  private readonly colHandle: HTMLElement
  private readonly dropLine: HTMLElement
  private menu: HTMLElement | null = null
  private editing: { cell: HTMLElement; target: Target } | null = null
  private composing = false
  private hover: Target | null = null
  private picked: TablePick | null = null
  private dragging = false

  constructor(
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly model: TableModel,
    private readonly opts: TableViewOptions,
  ) {
    this.wrap = document.createElement('div') as WrapEl
    this.wrap.className = 'hm-table-wrap'
    this.wrap.contentEditable = 'false'
    this.wrap.tabIndex = -1
    this.wrap[CONTROLLER] = this

    // 横向溢出在 scroller 内滚动；把手 / 添加条放在 inner 上，跟着表格一起滚
    this.scroller = document.createElement('div')
    this.scroller.className = 'hm-table-scroll'
    this.inner = document.createElement('div')
    this.inner.className = 'hm-table-inner'
    this.table = this.renderTable()
    this.inner.appendChild(this.table)
    this.scroller.appendChild(this.inner)
    this.wrap.appendChild(this.scroller)

    this.colHandle = this.chrome('hm-table-handle hm-table-handle-col', '选择列（拖动排序）', this.inner)
    this.rowHandle = this.chrome('hm-table-handle hm-table-handle-row', '选择行（拖动排序）', this.wrap)
    this.colHandle.innerHTML = GRIP_SVG
    this.rowHandle.innerHTML = GRIP_SVG
    this.dropLine = this.chrome('hm-table-drop', '', this.inner)
    const addRow = this.chrome('hm-table-add hm-table-add-row', '添加行', this.inner)
    const addCol = this.chrome('hm-table-add hm-table-add-col', '添加列', this.inner)
    addRow.textContent = '+'
    addCol.textContent = '+'
    addRow.addEventListener('click', () => this.appendRow())
    addCol.addEventListener('click', () => this.appendColumn())
    this.rowHandle.addEventListener('pointerdown', (e) => this.onHandleDown(e, 'row'))
    this.colHandle.addEventListener('pointerdown', (e) => this.onHandleDown(e, 'col'))

    this.wrap.addEventListener('mousedown', (e) => this.onMouseDown(e))
    this.wrap.addEventListener('mousemove', (e) => this.onHover(e))
    this.wrap.addEventListener('mouseleave', () => {
      this.hover = null
      this.positionChrome()
    })
    this.scroller.addEventListener('scroll', () => this.positionChrome())
    this.wrap.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.wrap.addEventListener('input', (e) => this.onInput(e as InputEvent))
    this.wrap.addEventListener('compositionstart', () => (this.composing = true))
    this.wrap.addEventListener('compositionend', () => {
      this.composing = false
      this.commit()
    })
    this.wrap.addEventListener('paste', (e) => this.onPaste(e))
    this.wrap.addEventListener('focusout', (e) => this.onFocusOut(e))
  }

  private chrome(cls: string, title: string, parent: HTMLElement): HTMLElement {
    const el = document.createElement('div')
    el.className = `hm-table-ui ${cls}`
    if (title) {
      el.title = title
      el.setAttribute('aria-label', title)
    }
    parent.appendChild(el)
    return el
  }

  private renderTable(): HTMLTableElement {
    const { rows, align, colCount } = this.model
    const table = document.createElement('table')
    table.className = 'hm-table-grid'
    const thead = document.createElement('thead')
    const tbody = document.createElement('tbody')
    rows.forEach((cells, r) => {
      const tr = document.createElement('tr')
      for (let c = 0; c < colCount; c++) {
        const td = document.createElement(r === 0 ? 'th' : 'td')
        td.className = 'hm-table-cell'
        td.dataset.row = String(r)
        td.dataset.col = String(c)
        const a = align[c]
        if (a && a !== 'none') td.style.textAlign = a
        td.appendChild(renderCellPreview(cells[c] ?? ''))
        tr.appendChild(td)
      }
      ;(r === 0 ? thead : tbody).appendChild(tr)
    })
    table.appendChild(thead)
    if (rows.length > 1) table.appendChild(tbody)
    return table
  }

  private cellEl(t: Target): HTMLElement | null {
    return this.wrap.querySelector(`[data-row="${t.row}"][data-col="${t.col}"]`)
  }

  private rawAt(t: Target): string {
    return this.model.rows[t.row]?.[t.col] ?? ''
  }

  private headerPos(): number | null {
    const p = this.getPos()
    return p === undefined ? null : p - 1
  }

  get rowCount(): number {
    return this.model.rows.length
  }

  get colCount(): number {
    return this.model.colCount
  }

  // —— 进入 / 离开编辑 ——

  beginEdit(t: Target, caret: Caret = 'end', selectTo?: number): boolean {
    const cell = this.cellEl(t)
    if (!cell || !this.view.editable) return false
    if (this.picked) this.pick(null)
    if (this.editing && this.editing.cell !== cell) this.endEdit()
    const source = cellDisplaySource(this.rawAt(t))
    if (this.editing?.cell !== cell) {
      this.freezeColumns()
      cell.textContent = source
      if (!supportsPlaintextOnly(cell)) cell.contentEditable = 'true'
      cell.spellcheck = false
      cell.classList.add('hm-table-cell-editing')
      this.editing = { cell, target: t }
    }
    cell.focus({ preventScroll: true })
    const len = (cell.textContent ?? '').length
    const at = caret === 'start' ? 0 : caret === 'end' ? len : caret
    setCaretIn(cell, at, selectTo ?? at)
    cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return true
  }

  private endEdit(): void {
    const ed = this.editing
    if (!ed) return
    this.editing = null
    const raw = cellSourceFromInput(ed.cell.textContent ?? '')
    ed.cell.removeAttribute('contenteditable')
    ed.cell.classList.remove('hm-table-cell-editing')
    ed.cell.replaceChildren(renderCellPreview(raw))
  }

  private onFocusOut(e: FocusEvent): void {
    if (rebuilding || this.composing) return
    if (e.relatedTarget instanceof Node && this.wrap.contains(e.relatedTarget)) return
    this.endEdit()
    this.unfreezeColumns()
    if (this.picked && !this.dragging) this.pick(null)
  }

  /**
   * 编辑框展示源码（比预览长），自动列宽会随输入跳动。编辑期间按预览态
   * 的列宽锁定；写回重建出的新 widget 先以预览态渲染，所以量到的宽度一致。
   */
  private freezeColumns(): void {
    const table = this.wrap.querySelector('table')
    if (!table || table.querySelector('colgroup')) return
    const head = table.querySelectorAll<HTMLElement>('thead .hm-table-cell')
    const total = table.getBoundingClientRect().width
    if (!total || !head.length) return
    const colgroup = document.createElement('colgroup')
    head.forEach((th) => {
      const col = document.createElement('col')
      col.style.width = `${(th.getBoundingClientRect().width / total) * 100}%`
      colgroup.appendChild(col)
    })
    table.insertBefore(colgroup, table.firstChild)
    table.style.tableLayout = 'fixed'
  }

  private unfreezeColumns(): void {
    const table = this.wrap.querySelector('table')
    table?.querySelector('colgroup')?.remove()
    table?.style.removeProperty('table-layout')
  }

  // —— 写回源码 ——

  private onInput(e: InputEvent): void {
    if (this.composing || e.isComposing) return
    this.commit()
  }

  private commit(caretOverride?: number): void {
    const ed = this.editing
    if (!ed) return
    const input = ed.cell.textContent ?? ''
    const caret = caretOverride ?? caretOffsetIn(ed.cell)
    const newRaw = cellSourceFromInput(input)
    if (newRaw === cellSourceFromInput(cellDisplaySource(this.rawAt(ed.target)))) return
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const tr = setCellTransaction(this.view, headerPos, ed.target, newRaw, this.model.colCount)
    if (!tr) return
    const nextCaret = escapedLength(input.slice(0, caret))
    this.dispatchAndRestore(tr, headerPos, ed.target, nextCaret)
  }

  private dispatchAndRestore(
    tr: Transaction,
    headerPos: number,
    target: Target,
    caret: Caret,
  ): void {
    const view = this.view
    rebuilding = true
    try {
      view.dispatch(tr)
    } finally {
      rebuilding = false
    }
    focusTableCell(view, headerPos, target, caret)
  }

  private onPaste(e: ClipboardEvent): void {
    const ed = this.editing
    if (!ed) return
    e.preventDefault()
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ')
    const { from, to } = selectionOffsetsIn(ed.cell)
    const cur = ed.cell.textContent ?? ''
    ed.cell.textContent = cur.slice(0, from) + text + cur.slice(to)
    setCaretIn(ed.cell, from + text.length)
    this.commit(from + text.length)
  }

  // —— 鼠标 ——

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement
    if (target.closest?.('.hm-table-ui')) {
      e.preventDefault() // 把手 / 菜单：不抢焦点，交给各自的 pointer / click 处理
      return
    }
    const cell = target.closest?.('.hm-table-cell') as HTMLElement | null
    if (cell && this.editing?.cell === cell) return // 编辑框内：原生光标定位
    const link = target.closest?.('.hm-link') as HTMLElement | null
    const href = link?.getAttribute('data-href')
    if (href && !e.metaKey && !e.ctrlKey && e.button === 0) {
      e.preventDefault()
      if (e.detail <= 1) {
        const open =
          this.opts.onOpenLink ??
          ((h: string) => window.open(h, '_blank', 'noopener,noreferrer'))
        open(href)
      }
      return
    }
    e.preventDefault()
    if (!cell || e.button !== 0) return
    const t = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
    const visible = caretFromPoint(cell, e.clientX, e.clientY)
    const caret = visible < 0 ? 'end' : previewOffsetToSource(this.rawAt(t), visible)
    this.beginEdit(t, caret)
  }

  // —— 键盘 ——

  private onKeyDown(e: KeyboardEvent): void {
    if (this.picked && e.target === this.wrap) {
      this.onPickKey(e)
      return
    }
    const ed = this.editing
    if (!ed || e.target !== ed.cell) return
    if (e.isComposing || this.composing || e.keyCode === 229) return
    const { row, col } = ed.target
    const mod = e.metaKey || e.ctrlKey
    const text = ed.cell.textContent ?? ''
    const sel = selectionOffsetsIn(ed.cell)
    const collapsed = sel.from === sel.to
    const lastRow = this.rowCount - 1
    const lastCol = this.colCount - 1
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }

    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      handled()
      const cmd = e.key === 'y' || e.shiftKey ? redo : undo
      const headerPos = this.headerPos()
      rebuilding = true
      try {
        cmd(this.view.state, this.view.dispatch)
      } finally {
        rebuilding = false
      }
      if (headerPos !== null) focusTableCell(this.view, headerPos, ed.target, 'end')
      return
    }
    if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      handled()
      const to = row + (e.key === 'ArrowUp' ? -1 : 1)
      if (to < 0 || to > lastRow) return
      const caret = sel.to
      const headerPos = this.headerPos()
      this.structural((s) => moveTableRow(s, row, to))
      if (headerPos !== null) focusTableCell(this.view, headerPos, { row: to, col }, caret)
      return
    }
    if (mod && !e.altKey && !e.shiftKey && ['b', 'i', 'e'].includes(e.key)) {
      handled()
      this.toggleWrap(e.key === 'b' ? '**' : e.key === 'i' ? '*' : '`')
      return
    }

    switch (e.key) {
      case 'Tab': {
        handled()
        if (e.shiftKey) {
          if (col > 0) this.beginEdit({ row, col: col - 1 }, 'end')
          else if (row > 0) this.beginEdit({ row: row - 1, col: lastCol }, 'end')
          return
        }
        if (col < lastCol) this.beginEdit({ row, col: col + 1 }, 'end')
        else if (row < lastRow) this.beginEdit({ row: row + 1, col: 0 }, 'end')
        else this.insertRowAfter(row, 0)
        return
      }
      case 'Enter': {
        handled()
        if (e.shiftKey || mod) {
          this.insertRowAfter(row, col)
          return
        }
        if (row < lastRow) this.beginEdit({ row: row + 1, col }, 'end')
        else this.insertRowAfter(row, col)
        return
      }
      case 'Escape':
        handled()
        this.exit('after')
        return
      case 'ArrowUp':
        if (e.shiftKey) return
        handled()
        if (row > 0) this.beginEdit({ row: row - 1, col }, 'end')
        else this.exit('before')
        return
      case 'ArrowDown':
        if (e.shiftKey) return
        handled()
        if (row < lastRow) this.beginEdit({ row: row + 1, col }, 'end')
        else this.exit('after')
        return
      case 'ArrowLeft':
        if (e.shiftKey || !collapsed || sel.from > 0 || mod || e.altKey) return
        handled()
        if (col > 0) this.beginEdit({ row, col: col - 1 }, 'end')
        else if (row > 0) this.beginEdit({ row: row - 1, col: lastCol }, 'end')
        else this.exit('before')
        return
      case 'ArrowRight':
        if (e.shiftKey || !collapsed || sel.to < text.length || mod || e.altKey) return
        handled()
        if (col < lastCol) this.beginEdit({ row, col: col + 1 }, 'start')
        else if (row < lastRow) this.beginEdit({ row: row + 1, col: 0 }, 'start')
        else this.exit('after')
        return
      case 'Backspace': {
        if (!collapsed || sel.from > 0 || text.length > 0 || col !== 0) return
        const rowEmpty = (r: number) =>
          (this.model.rows[r] ?? []).every((c) => !cellDisplaySource(c).trim())
        if (row > 0 && rowEmpty(row)) {
          handled()
          this.deleteRow(row)
          return
        }
        if (row === 0 && this.model.rows.every((_, r) => rowEmpty(r))) {
          handled()
          this.deleteTable()
        }
        return
      }
    }
  }

  private toggleWrap(marker: string): void {
    const ed = this.editing
    if (!ed) return
    const text = ed.cell.textContent ?? ''
    const { from, to } = selectionOffsetsIn(ed.cell)
    const n = marker.length
    const wrapped =
      from >= n && text.slice(from - n, from) === marker && text.slice(to, to + n) === marker
    let next: string
    let a: number
    let b: number
    if (wrapped) {
      next = text.slice(0, from - n) + text.slice(from, to) + text.slice(to + n)
      a = from - n
      b = to - n
    } else {
      next = text.slice(0, from) + marker + text.slice(from, to) + marker + text.slice(to)
      a = from + n
      b = to + n
    }
    ed.cell.textContent = next
    setCaretIn(ed.cell, a, b)
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const tr = setCellTransaction(this.view, headerPos, ed.target, cellSourceFromInput(next), this.colCount)
    if (!tr) return
    rebuilding = true
    try {
      this.view.dispatch(tr)
    } finally {
      rebuilding = false
    }
    const ctl = tableControllerAt(this.view, headerPos)
    ctl?.beginEdit(ed.target, a, b)
  }

  // —— 结构操作 ——

  private insertRowAfter(row: number, focusCol: number): void {
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const lines = tableLinePositions(this.view.state.doc, headerPos)
    const lineIdx = Math.max(1, lineIndexOfRow(row)) // 表头后插入 = 分隔行之后
    const linePos = lines[lineIdx]
    if (linePos === undefined) return
    const node = this.view.state.doc.nodeAt(linePos)!
    const at = linePos + node.nodeSize
    const text = formatTableRow(Array.from({ length: this.colCount }, () => emptyCellText()))
    const { schema } = this.view.state
    const tr = this.view.state.tr.insert(at, schema.nodes.block!.create(null, schema.text(text)))
    this.dispatchAndRestore(tr, headerPos, { row: row + 1, col: focusCol }, 'start')
  }

  private deleteRow(row: number): void {
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const lines = tableLinePositions(this.view.state.doc, headerPos)
    const linePos = lines[lineIndexOfRow(row)]
    if (linePos === undefined) return
    const node = this.view.state.doc.nodeAt(linePos)!
    const tr = this.view.state.tr.delete(linePos, linePos + node.nodeSize)
    this.dispatchAndRestore(tr, headerPos, { row: row - 1, col: this.colCount - 1 }, 'end')
  }

  private deleteTable(): void {
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const doc = this.view.state.doc
    const lines = tableLinePositions(doc, headerPos)
    const lastPos = lines[lines.length - 1]!
    const end = lastPos + doc.nodeAt(lastPos)!.nodeSize
    const { schema } = this.view.state
    let tr = this.view.state.tr.replaceWith(headerPos, end, schema.nodes.block!.create())
    tr = tr.setSelection(TextSelection.create(tr.doc, headerPos + 1))
    this.editing = null
    this.view.dispatch(tr.scrollIntoView())
    this.view.focus()
  }

  // —— 行列把手 / 选中 / 菜单 ——

  private onHover(e: MouseEvent): void {
    if (this.dragging || !this.view.editable) return
    const cell = (e.target as HTMLElement).closest?.('.hm-table-cell') as HTMLElement | null
    if (!cell || !this.table.contains(cell)) return
    const t = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
    if (this.hover?.row === t.row && this.hover.col === t.col) return
    this.hover = t
    this.positionChrome()
  }

  /** 把手跟随悬停（或已选中）的行列；菜单贴着选中的行列 */
  private positionChrome(): void {
    const show = this.view.editable
    const row = this.picked?.kind === 'row' ? this.picked.index : this.hover?.row
    const col = this.picked?.kind === 'col' ? this.picked.index : this.hover?.col
    const wrapRect = this.wrap.getBoundingClientRect()
    const innerRect = this.inner.getBoundingClientRect()
    const tr = row === undefined ? null : this.table.rows[row]
    if (show && tr) {
      const r = tr.getBoundingClientRect()
      this.rowHandle.style.top = `${r.top - wrapRect.top + r.height / 2}px`
      this.rowHandle.dataset.index = String(row)
      this.rowHandle.classList.add('hm-table-handle-on')
    } else {
      this.rowHandle.classList.remove('hm-table-handle-on')
    }
    const th = col === undefined ? null : this.cellEl({ row: 0, col })
    if (show && th) {
      const r = th.getBoundingClientRect()
      this.colHandle.style.left = `${r.left - innerRect.left + r.width / 2}px`
      this.colHandle.dataset.index = String(col)
      this.colHandle.classList.add('hm-table-handle-on')
    } else {
      this.colHandle.classList.remove('hm-table-handle-on')
    }
    this.rowHandle.classList.toggle('hm-table-handle-picked', this.picked?.kind === 'row')
    this.colHandle.classList.toggle('hm-table-handle-picked', this.picked?.kind === 'col')
    this.positionMenu()
  }

  get pickedRange(): TablePick | null {
    return this.picked
  }

  /** 选中整行 / 整列（null = 取消）。选中期间键盘焦点在表格容器上 */
  pick(p: TablePick | null, focus = true): void {
    if (p) {
      const max = p.kind === 'row' ? this.rowCount : this.colCount
      if (p.index < 0 || p.index >= max) p = null
    }
    this.picked = p
    for (const cell of this.table.querySelectorAll<HTMLElement>('.hm-table-cell')) {
      const on =
        !!p && Number(p.kind === 'row' ? cell.dataset.row : cell.dataset.col) === p.index
      cell.classList.toggle('hm-table-cell-picked', on)
    }
    this.wrap.classList.toggle('hm-table-picking', !!p)
    if (p) {
      if (this.editing) {
        this.endEdit()
        this.unfreezeColumns()
      }
      this.showMenu(p)
      if (focus) this.wrap.focus({ preventScroll: true })
    } else {
      this.menu?.remove()
      this.menu = null
    }
    this.positionChrome()
  }

  private showMenu(p: TablePick): void {
    this.menu?.remove()
    const menu = document.createElement('div')
    menu.className = 'hm-table-ui hm-table-menu'
    menu.setAttribute('role', 'toolbar')
    const { index } = p
    const last = (p.kind === 'row' ? this.rowCount : this.colCount) - 1
    type Item = [label: string, run: () => void, disabled?: boolean, active?: boolean] | 'sep'
    const items: Item[] =
      p.kind === 'row'
        ? [
            ['上方插入', () => this.structural((s) => insertTableRow(s, index), { edit: { row: index, col: 0 } })],
            ['下方插入', () => this.structural((s) => insertTableRow(s, index + 1), { edit: { row: index + 1, col: 0 } })],
            'sep',
            ['上移', () => this.moveRow(index, index - 1), index === 0],
            ['下移', () => this.moveRow(index, index + 1), index === last],
            'sep',
            ['删除行', () => this.deletePicked()],
          ]
        : [
            ['左侧插入', () => this.structural((s) => insertTableColumn(s, index), { edit: { row: 0, col: index } })],
            ['右侧插入', () => this.structural((s) => insertTableColumn(s, index + 1), { edit: { row: 0, col: index + 1 } })],
            'sep',
            ['左移', () => this.moveCol(index, index - 1), index === 0],
            ['右移', () => this.moveCol(index, index + 1), index === last],
            'sep',
            ...(['left', 'center', 'right'] as const).map((a): Item => {
              const cur = this.model.align[index] ?? 'none'
              const label = a === 'left' ? '居左' : a === 'center' ? '居中' : '居右'
              return [
                label,
                () =>
                  this.structural((s) => setTableColumnAlign(s, index, cur === a ? 'none' : a), {
                    pick: { kind: 'col', index },
                  }),
                false,
                cur === a,
              ]
            }),
            'sep',
            ['删除列', () => this.deletePicked()],
          ]
    for (const item of items) {
      if (item === 'sep') {
        const s = document.createElement('span')
        s.className = 'hm-table-menu-sep'
        menu.appendChild(s)
        continue
      }
      const [label, run, disabled, active] = item
      const b = document.createElement('button')
      b.type = 'button'
      b.tabIndex = -1
      b.textContent = label
      b.disabled = !!disabled
      if (active) b.classList.add('hm-table-menu-active')
      if (label.startsWith('删除')) b.classList.add('hm-table-menu-danger')
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.preventDefault()
        run()
      })
      menu.appendChild(b)
    }
    this.wrap.appendChild(menu)
    this.menu = menu
  }

  private positionMenu(): void {
    const menu = this.menu
    const p = this.picked
    if (!menu || !p) return
    const wrapRect = this.wrap.getBoundingClientRect()
    if (p.kind === 'row') {
      const r = this.table.rows[p.index]?.getBoundingClientRect()
      if (!r) return
      menu.style.left = '0px'
      menu.style.top = `${r.bottom - wrapRect.top + 6}px`
    } else {
      const r = this.cellEl({ row: 0, col: p.index })?.getBoundingClientRect()
      if (!r) return
      const max = Math.max(0, wrapRect.width - menu.offsetWidth)
      menu.style.left = `${Math.min(max, Math.max(0, r.left - wrapRect.left))}px`
      menu.style.top = `${-menu.offsetHeight - 14}px`
    }
  }

  private onPickKey(e: KeyboardEvent): void {
    const p = this.picked!
    const mod = e.metaKey || e.ctrlKey
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const back = p.kind === 'row' ? 'ArrowUp' : 'ArrowLeft'
    const fwd = p.kind === 'row' ? 'ArrowDown' : 'ArrowRight'
    const first: Target = p.kind === 'row' ? { row: p.index, col: 0 } : { row: 0, col: p.index }

    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      handled()
      const cmd = e.key === 'y' || e.shiftKey ? redo : undo
      this.pick(null, false)
      cmd(this.view.state, this.view.dispatch)
      this.view.focus()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      handled()
      this.deletePicked()
      return
    }
    if (e.key === back || e.key === fwd) {
      handled()
      const to = p.index + (e.key === back ? -1 : 1)
      if (e.altKey) {
        if (p.kind === 'row') this.moveRow(p.index, to)
        else this.moveCol(p.index, to)
      } else {
        this.pick({ kind: p.kind, index: to })
      }
      return
    }
    if (e.key === 'Enter' || e.key === 'Escape') {
      handled()
      this.beginEdit(first, 'end')
      return
    }
    if (e.key === 'Tab') handled()
  }

  // —— 拖动把手排序 ——

  private onHandleDown(e: PointerEvent, kind: 'row' | 'col'): void {
    if (e.button !== 0 || !this.view.editable) return
    const handle = e.currentTarget as HTMLElement
    const index = Number(handle.dataset.index)
    if (!Number.isFinite(index)) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    try {
      handle.setPointerCapture?.(e.pointerId)
    } catch {
      // 合成事件（测试）没有活动指针
    }

    const onMove = (ev: PointerEvent): void => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      if (!moved) {
        moved = true
        this.dragging = true
        this.wrap.classList.add('hm-table-dragging')
        this.pick({ kind, index })
      }
      if (kind === 'col') this.autoScroll(ev.clientX)
      this.showDrop(kind, this.dropBoundary(kind, ev))
    }
    const onUp = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      if (!moved) {
        const same = this.picked?.kind === kind && this.picked.index === index
        this.pick(same ? null : { kind, index })
        if (same) this.view.focus()
        return
      }
      const boundary = this.dropBoundary(kind, ev)
      this.dragging = false
      this.wrap.classList.remove('hm-table-dragging')
      this.dropLine.classList.remove('hm-table-drop-on')
      if (ev.type === 'pointercancel') return
      const to = boundary > index ? boundary - 1 : boundary
      if (kind === 'row') this.moveRow(index, to)
      else this.moveCol(index, to)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  /** 指针位置对应的插入边界（0…n：插到第 n 行 / 列之前） */
  private dropBoundary(kind: 'row' | 'col', ev: { clientX: number; clientY: number }): number {
    const rects =
      kind === 'row'
        ? Array.from(this.table.rows, (tr) => tr.getBoundingClientRect())
        : Array.from({ length: this.colCount }, (_, c) =>
            this.cellEl({ row: 0, col: c })!.getBoundingClientRect(),
          )
    let b = 0
    for (const r of rects) {
      const mid = kind === 'row' ? r.top + r.height / 2 : r.left + r.width / 2
      if ((kind === 'row' ? ev.clientY : ev.clientX) > mid) b++
    }
    return b
  }

  private showDrop(kind: 'row' | 'col', boundary: number): void {
    const innerRect = this.inner.getBoundingClientRect()
    const line = this.dropLine
    line.classList.add('hm-table-drop-on')
    line.classList.toggle('hm-table-drop-col', kind === 'col')
    if (kind === 'row') {
      const rows = this.table.rows
      const r = (rows[boundary] ?? rows[rows.length - 1]!).getBoundingClientRect()
      const y = boundary < rows.length ? r.top : r.bottom
      line.style.top = `${y - innerRect.top}px`
      line.style.left = '0px'
    } else {
      const cell = this.cellEl({ row: 0, col: Math.min(boundary, this.colCount - 1) })!
      const r = cell.getBoundingClientRect()
      const x = boundary < this.colCount ? r.left : r.right
      line.style.left = `${x - innerRect.left}px`
      line.style.top = '0px'
    }
  }

  private autoScroll(clientX: number): void {
    const r = this.scroller.getBoundingClientRect()
    const edge = 32
    if (clientX > r.right - edge) this.scroller.scrollLeft += 12
    else if (clientX < r.left + edge) this.scroller.scrollLeft -= 12
  }

  // —— 结构操作（整表重写） ——

  private currentSource(): TableSource | null {
    const headerPos = this.headerPos()
    if (headerPos === null) return null
    const doc = this.view.state.doc
    const lines = tableLinePositions(doc, headerPos).map((p) => doc.nodeAt(p)!.textContent)
    if (lines.length < 2) return null
    return splitTableSource(lines.join('\n'))
  }

  /**
   * 用 op 改写整张表的源码（一次事务，可撤销）。重建出的新 widget 恢复
   * 选中的行列或进入某一格编辑。op 返回 null = 删除整张表。
   */
  structural(
    op: (src: TableSource) => TableSource | null,
    after: { pick?: TablePick; edit?: Target } = {},
  ): void {
    const src = this.currentSource()
    const headerPos = this.headerPos()
    if (!src || headerPos === null || !this.view.editable) return
    const next = op(src)
    if (!next) {
      this.deleteTable()
      return
    }
    const doc = this.view.state.doc
    const positions = tableLinePositions(doc, headerPos)
    const lastPos = positions[positions.length - 1]!
    const end = lastPos + doc.nodeAt(lastPos)!.nodeSize
    const { schema } = this.view.state
    const nodes = joinTableSource(next).map((l) =>
      schema.nodes.block!.create(null, l ? schema.text(l) : undefined),
    )
    // 每次结构操作单独成一步撤销（连续快速操作不被合并）
    const tr = closeHistory(this.view.state.tr.replaceWith(headerPos, end, nodes))
    rebuilding = true
    try {
      this.view.dispatch(tr)
    } finally {
      rebuilding = false
    }
    const ctl = tableControllerAt(this.view, headerPos)
    if (!ctl) return
    if (after.pick) ctl.pick(after.pick)
    else if (after.edit) focusTableCell(this.view, headerPos, after.edit, 'end')
  }

  private moveRow(from: number, to: number): void {
    if (to < 0 || to >= this.rowCount || to === from) return
    this.structural((s) => moveTableRow(s, from, to), { pick: { kind: 'row', index: to } })
  }

  private moveCol(from: number, to: number): void {
    if (to < 0 || to >= this.colCount || to === from) return
    this.structural((s) => moveTableColumn(s, from, to), { pick: { kind: 'col', index: to } })
  }

  private deletePicked(): void {
    const p = this.picked
    if (!p) return
    const remaining = (p.kind === 'row' ? this.rowCount : this.colCount) - 1
    const next = remaining > 0 ? { kind: p.kind, index: Math.min(p.index, remaining - 1) } : undefined
    this.structural(
      (s) => (p.kind === 'row' ? deleteTableRow(s, p.index) : deleteTableColumn(s, p.index)),
      { pick: next },
    )
  }

  private appendRow(): void {
    const row = this.rowCount
    this.structural((s) => insertTableRow(s, row), { edit: { row, col: 0 } })
  }

  private appendColumn(): void {
    const col = this.colCount
    this.structural((s) => insertTableColumn(s, col), { edit: { row: 0, col } })
  }

  /** 离开表格：光标回到表格前一行行尾 / 后一行行首（没有就补一个空行） */
  exit(dir: 'before' | 'after'): void {
    const headerPos = this.headerPos()
    if (headerPos === null) return
    const view = this.view
    const doc = view.state.doc
    let tr = view.state.tr
    let caret: number
    if (dir === 'before') {
      if (headerPos === 0) {
        tr = tr.insert(0, view.state.schema.nodes.block!.create())
        caret = 1
      } else {
        caret = headerPos - 1
      }
    } else {
      const lines = tableLinePositions(doc, headerPos)
      const lastPos = lines[lines.length - 1] ?? headerPos
      const end = lastPos + doc.nodeAt(lastPos)!.nodeSize
      if (end >= doc.content.size) {
        tr = tr.insert(end, view.state.schema.nodes.block!.create())
      }
      caret = end + 1
    }
    tr = tr.setSelection(TextSelection.create(tr.doc, caret))
    this.endEdit()
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }
}

/** 构造「替换一格源码」的事务；该行单元格不足时补齐空格子 */
function setCellTransaction(
  view: EditorView,
  headerPos: number,
  t: Target,
  newRaw: string,
  colCount: number,
) {
  const { state } = view
  const lines = tableLinePositions(state.doc, headerPos)
  const linePos = lines[lineIndexOfRow(t.row)]
  if (linePos === undefined) return null
  const node = state.doc.nodeAt(linePos)!
  const text = node.textContent
  const parsed = parseTableRow(text)
  const start = linePos + 1
  const cell = parsed.cells[t.col]
  if (cell) return state.tr.insertText(newRaw, start + cell.from, start + cell.to)
  const cells = parsed.cells.map((c) => c.text)
  while (cells.length < Math.max(colCount, t.col + 1)) cells.push(emptyCellText())
  cells[t.col] = newRaw
  return state.tr.insertText(formatTableRow(cells), start, start + text.length)
}

export function tableControllerAt(view: EditorView, headerPos: number): TableController | null {
  let dom: Node | null = null
  try {
    dom = view.nodeDOM(headerPos)
  } catch {
    return null
  }
  const wrap = (dom as HTMLElement | null)?.querySelector?.('.hm-table-wrap') as WrapEl | null
  return wrap?.[CONTROLLER] ?? null
}

/** 让表格的某一格进入编辑（格子不存在时退到最近的一格） */
export function focusTableCell(
  view: EditorView,
  headerPos: number,
  target: Target,
  caret: Caret = 'end',
): boolean {
  const ctl = tableControllerAt(view, headerPos)
  if (!ctl) return false
  const row = Math.max(0, Math.min(target.row, ctl.rowCount - 1))
  const col = Math.max(0, Math.min(target.col, ctl.colCount - 1))
  return ctl.beginEdit({ row, col }, caret)
}

export function buildTableWidget(
  view: EditorView,
  getPos: () => number | undefined,
  src: string,
  opts: TableViewOptions,
): HTMLElement {
  return new TableController(view, getPos, parseTableModel(src), opts).wrap
}

/**
 * ProseMirror 选区落进表格源码行时（键盘上下移动、insertTable、撤销），
 * 把它换成对应单元格的编辑框。返回是否接管。
 */
export function redirectSelectionIntoTable(view: EditorView): boolean {
  const sel = view.state.selection
  if (!sel.empty) return false
  const $pos = sel.$from
  if ($pos.depth !== 1 || !$pos.parent.textContent.includes('|')) return false
  const doc = view.state.doc
  const blockPos = $pos.before()
  // 向上找表头：当前行及其上方连续的表格行
  let headerPos: number | null = null
  let lineIdx = -1
  let pos = blockPos
  for (let steps = 0; steps < 10_000; steps++) {
    const lines = tableLinePositions(doc, pos)
    if (lines.length >= 2) {
      const idx = lines.indexOf(blockPos)
      if (idx >= 0) {
        headerPos = pos
        lineIdx = idx
      }
      break
    }
    if (pos === 0) break
    const prev = doc.resolve(pos).nodeBefore
    if (!prev || !prev.textContent.includes('|')) break
    pos -= prev.nodeSize
  }
  if (headerPos === null) return false
  const row = lineIdx <= 1 ? 0 : lineIdx - 1
  const text = $pos.parent.textContent
  const offset = $pos.parentOffset
  const cells = parseTableRow(text).cells
  let col = cells.findIndex((c) => offset >= c.from && offset <= c.to)
  if (col < 0) col = offset <= (cells[0]?.from ?? 0) ? 0 : Math.max(0, cells.length - 1)
  const cell = cells[col]
  let caret: Caret = 'end'
  if (cell && lineIdx !== 1) {
    const lead = cell.text.startsWith(' ') ? 1 : 0
    const len = cellDisplaySource(cell.text).length
    caret = Math.max(0, Math.min(len, offset - cell.from - lead))
  }
  return focusTableCell(view, headerPos, { row, col }, caret)
}
