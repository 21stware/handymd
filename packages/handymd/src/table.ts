/**
 * 表格的编程式创建与行内导航。
 *
 * GFM 表格是多行结构（表头 + 分隔行 + 表体），不适合靠"输入触发"生成；
 * 宿主应调用 `insertTable` / `editor.insertTable()`。源码仍是管道表格文本，
 * 由 classifyLines + decorations 渲染。
 */

import type { Command } from 'prosemirror-state'
import { TextSelection } from 'prosemirror-state'
import { schema } from './schema'
import { concealKey } from './conceal/plugin'
import {
  emptyCellText,
  formatSeparator,
  formatTableRow,
  parseTableRow,
} from './parse/table'

export interface InsertTableOptions {
  /** 总行数（含表头），默认 3 */
  rows?: number
  /** 列数，默认 3 */
  cols?: number
  /** 是否生成表头行，默认 true */
  withHeaderRow?: boolean
  /** 可选表头文案；长度不足时用空单元格补齐 */
  headers?: string[]
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** 生成 GFM 管道表格源码（不含首尾多余空行） */
export function buildTableMarkdown(options: InsertTableOptions = {}): string {
  const withHeaderRow = options.withHeaderRow !== false
  const cols = clamp(options.cols ?? options.headers?.length ?? 3, 1, 32)
  const totalRows = clamp(options.rows ?? 3, withHeaderRow ? 1 : 1, 64)

  const headerCells = Array.from({ length: cols }, (_, i) => {
    const h = options.headers?.[i]
    return h && h.length ? ` ${h} ` : emptyCellText()
  })

  const lines: string[] = []
  if (withHeaderRow) {
    lines.push(formatTableRow(headerCells))
    lines.push(formatSeparator(cols))
    const bodyCount = Math.max(0, totalRows - 1)
    for (let r = 0; r < bodyCount; r++) {
      lines.push(formatTableRow(Array.from({ length: cols }, () => emptyCellText())))
    }
  } else {
    // 无表头时仍写分隔行上方的空行作为"伪表头"，保证 GFM 可被识别
    lines.push(formatTableRow(Array.from({ length: cols }, () => emptyCellText())))
    lines.push(formatSeparator(cols))
    for (let r = 0; r < totalRows; r++) {
      lines.push(formatTableRow(Array.from({ length: cols }, () => emptyCellText())))
    }
  }
  return lines.join('\n')
}

function blocksFromLines(lines: readonly string[]) {
  return lines.map((line) => schema.nodes.block.create(null, line ? schema.text(line) : undefined))
}

/**
 * 在光标处插入一张 GFM 表格。
 * - 当前块为空：就地替换为表格
 * - 否则：在当前块后方插入
 * 光标落到第一行第一个单元格内容起点。
 */
export function insertTable(options: InsertTableOptions = {}): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    if ($from.depth !== 1) return false

    const md = buildTableMarkdown(options)
    const lines = md.split('\n')
    const nodes = blocksFromLines(lines)
    if (!nodes.length) return false

    const blockPos = $from.before()
    const block = $from.parent
    const empty = block.content.size === 0
    const firstLine = lines[0]
    const firstCell = parseTableRow(firstLine).cells[0]
    // 跳过左侧 padding 空格，与 Tab 导航落点一致
    let caretOffset = firstCell?.from ?? 1
    if (firstCell && firstLine[firstCell.from] === ' ') caretOffset = firstCell.from + 1

    if (!dispatch) return true

    let tr = state.tr
    let firstBlockPos: number

    if (empty) {
      tr = tr.replaceWith(blockPos, blockPos + block.nodeSize, nodes[0])
      firstBlockPos = blockPos
      let insertAt = blockPos + nodes[0].nodeSize
      for (let i = 1; i < nodes.length; i++) {
        tr = tr.insert(insertAt, nodes[i])
        insertAt += nodes[i].nodeSize
      }
    } else {
      firstBlockPos = blockPos + block.nodeSize
      let insertAt = firstBlockPos
      for (const n of nodes) {
        tr = tr.insert(insertAt, n)
        insertAt += n.nodeSize
      }
    }

    const caret = firstBlockPos + 1 + caretOffset
    tr = tr.setSelection(TextSelection.create(tr.doc, caret))
    dispatch(tr.scrollIntoView())
    return true
  }
}

function tableCellsInDoc(state: Parameters<Command>[0]): { from: number; to: number }[] {
  const st = concealKey.getState(state)
  if (!st) return []
  const cells: { from: number; to: number }[] = []
  for (const block of st.blocks) {
    for (const el of block.elements) {
      if (el.kind === 'tableCell') cells.push({ from: el.from, to: el.to })
    }
  }
  return cells
}

function caretInTableBlock(state: Parameters<Command>[0]): boolean {
  const st = concealKey.getState(state)
  const { $from } = state.selection
  if (!st || $from.depth !== 1) return false
  const block = st.blocks.find((b) => b.pos === $from.before())
  return !!block && (block.line.t === 'tableHeader' || block.line.t === 'tableRow' || block.line.t === 'tableSep')
}

function cellCaretPos(state: Parameters<Command>[0], target: { from: number; to: number }): number {
  let caret = target.from
  const $pos = state.doc.resolve(target.from)
  const text = $pos.parent.textContent
  const local = target.from - $pos.start()
  if (text[local] === ' ') caret = Math.min(target.to, target.from + 1)
  return caret
}

function moveTableCell(dir: 1 | -1): Command {
  return (state, dispatch) => {
    if (!caretInTableBlock(state)) return false
    const cells = tableCellsInDoc(state)
    if (!cells.length) return false
    const pos = state.selection.from
    let idx = cells.findIndex((c) => pos >= c.from && pos <= c.to)
    if (idx < 0) {
      // 管道符上：落到邻近单元格
      if (dir > 0) {
        idx = cells.findIndex((c) => c.from >= pos)
        if (idx < 0) return false
        if (dispatch) {
          dispatch(
            state.tr
              .setSelection(TextSelection.create(state.doc, cellCaretPos(state, cells[idx])))
              .scrollIntoView(),
          )
        }
        return true
      }
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].to <= pos) {
          idx = i
          break
        }
      }
      if (idx < 0) return false
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, cellCaretPos(state, cells[idx])))
            .scrollIntoView(),
        )
      }
      return true
    }
    const next = idx + dir
    if (next < 0 || next >= cells.length) return false
    if (dispatch) {
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, cellCaretPos(state, cells[next])))
          .scrollIntoView(),
      )
    }
    return true
  }
}

export const goToNextTableCell: Command = moveTableCell(1)
export const goToPrevTableCell: Command = moveTableCell(-1)

/**
 * 表格内 Enter：在当前行后插入同样列数的空表体行，光标进新行首格。
 * 分隔行上的 Enter 忽略（由默认 keymap 处理）。
 */
export const continueTableRow: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  const st = concealKey.getState(state)
  if (!st) return false

  const blockPos = $from.before()
  const block = st.blocks.find((b) => b.pos === blockPos)
  if (!block) return false
  const line = block.line
  if (line.t !== 'tableHeader' && line.t !== 'tableRow') return false

  const cols = line.colCount
  const newLine = formatTableRow(Array.from({ length: cols }, () => emptyCellText()))
  const insertPos = blockPos + block.size

  // 若在表头，插入点应在分隔行之后
  let at = insertPos
  if (line.t === 'tableHeader') {
    const sep = st.blocks.find((b) => b.pos === insertPos && b.line.t === 'tableSep')
    if (sep) at = sep.pos + sep.size
  }

  if (dispatch) {
    const node = schema.nodes.block.create(null, schema.text(newLine))
    let tr = state.tr.insert(at, node)
    const caretOffset = parseTableRow(newLine).cells[0]?.from ?? 1
    tr = tr.setSelection(TextSelection.create(tr.doc, at + 1 + caretOffset))
    dispatch(tr.scrollIntoView())
  }
  return true
}
