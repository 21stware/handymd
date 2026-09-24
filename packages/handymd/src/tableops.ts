/**
 * 表格结构操作（纯函数，作用于管道表格源码行）。
 *
 * 行操作尽量保持原行文本不变（只重排 / 增删行）；列操作必须重写每一行，
 * 分隔行按新的列数与对齐重新生成。表头行的单元格数总是补齐到列数 ——
 * GFM 要求表头与分隔行列数一致，否则整张表不再被识别。
 */

import {
  emptyCellText,
  formatSeparator,
  formatTableRow,
  parseTableAlign,
  parseTableRow,
  type TableAlign,
} from './parse/table'

export interface TableSource {
  /** 表头 + 表体行（不含分隔行），源码原文 */
  rows: string[]
  /** 分隔行原文 */
  sep: string
}

export function splitTableSource(src: string): TableSource {
  const lines = src.split('\n')
  return { rows: [lines[0] ?? '', ...lines.slice(2)], sep: lines[1] ?? '' }
}

export function joinTableSource(t: TableSource): string[] {
  return [t.rows[0] ?? '', t.sep, ...t.rows.slice(1)]
}

export function tableColCount(t: TableSource): number {
  const align = parseTableAlign(t.sep)
  return Math.max(1, align.length || parseTableRow(t.rows[0] ?? '').cells.length)
}

function cellsOf(line: string, colCount: number): string[] {
  const cells = parseTableRow(line).cells.map((c) => c.text)
  while (cells.length < colCount) cells.push(emptyCellText())
  return cells
}

function emptyRow(colCount: number): string {
  return formatTableRow(Array.from({ length: colCount }, () => emptyCellText()))
}

/** 表头行单元格不足时补齐（其余行保持原文） */
function withHeaderPadded(t: TableSource): TableSource {
  const cols = tableColCount(t)
  const header = t.rows[0] ?? ''
  if (parseTableRow(header).cells.length >= cols) return t
  return { ...t, rows: [formatTableRow(cellsOf(header, cols)), ...t.rows.slice(1)] }
}

const clampIndex = (i: number, n: number) => Math.max(0, Math.min(n, i))

// —— 行（下标含表头：0 = 表头） ——

export function insertTableRow(t: TableSource, at: number): TableSource {
  const rows = t.rows.slice()
  rows.splice(clampIndex(at, rows.length), 0, emptyRow(tableColCount(t)))
  return withHeaderPadded({ ...t, rows })
}

/** 删除一行；删到只剩分隔行时返回 null（= 删除整张表）。删表头则下一行升为表头 */
export function deleteTableRow(t: TableSource, index: number): TableSource | null {
  if (index < 0 || index >= t.rows.length) return t
  const rows = t.rows.slice()
  rows.splice(index, 1)
  if (!rows.length) return null
  return withHeaderPadded({ ...t, rows })
}

/** 把第 from 行移到第 to 行的位置（to 是移动后的下标） */
export function moveTableRow(t: TableSource, from: number, to: number): TableSource {
  const n = t.rows.length
  if (from < 0 || from >= n) return t
  to = Math.max(0, Math.min(n - 1, to))
  if (from === to) return t
  const rows = t.rows.slice()
  const [row] = rows.splice(from, 1)
  rows.splice(to, 0, row!)
  return withHeaderPadded({ ...t, rows })
}

// —— 列 ——

function alignsOf(t: TableSource, cols: number): TableAlign[] {
  const align = parseTableAlign(t.sep)
  while (align.length < cols) align.push('none')
  align.length = cols
  return align
}

/**
 * 对「对齐数组」与「每一行的单元格数组」施加同一个下标编辑，
 * 再重写所有行与分隔行。filler 是插入位置上的新元素。
 */
function rewriteColumns(
  t: TableSource,
  edit: <T>(arr: T[], filler: T) => void,
): TableSource {
  const cols = tableColCount(t)
  const align = alignsOf(t, cols)
  edit(align, 'none' as TableAlign)
  const rows = t.rows.map((line) => {
    const cells = cellsOf(line, cols).slice(0, cols)
    edit(cells, emptyCellText())
    return formatTableRow(cells)
  })
  return { rows, sep: formatSeparator(align.length, align) }
}

export function insertTableColumn(t: TableSource, at: number): TableSource {
  const i = clampIndex(at, tableColCount(t))
  return rewriteColumns(t, (arr, filler) => void arr.splice(i, 0, filler))
}

/** 删除一列；删掉最后一列时返回 null（= 删除整张表） */
export function deleteTableColumn(t: TableSource, index: number): TableSource | null {
  const cols = tableColCount(t)
  if (index < 0 || index >= cols) return t
  if (cols === 1) return null
  return rewriteColumns(t, (arr) => void arr.splice(index, 1))
}

export function moveTableColumn(t: TableSource, from: number, to: number): TableSource {
  const cols = tableColCount(t)
  if (from < 0 || from >= cols) return t
  to = Math.max(0, Math.min(cols - 1, to))
  if (from === to) return t
  return rewriteColumns(t, (arr) => {
    const [c] = arr.splice(from, 1)
    arr.splice(to, 0, c!)
  })
}

export function setTableColumnAlign(t: TableSource, index: number, value: TableAlign): TableSource {
  const cols = tableColCount(t)
  if (index < 0 || index >= cols) return t
  const align = alignsOf(t, cols)
  if (align[index] === value) return t
  align[index] = value
  return withHeaderPadded({ ...t, sep: formatSeparator(cols, align) })
}
