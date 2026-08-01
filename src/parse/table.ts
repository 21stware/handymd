/**
 * GFM 管道表格行解析：切分 cell / pipe 的相对（行内）坐标。
 * 分类器与 decoration / insertTable 共用，保证列数与光标落点一致。
 */

import type { Span } from '../elements'

export interface TableCellSpan {
  from: number
  to: number
  text: string
}

export interface ParsedTableRow {
  cells: TableCellSpan[]
  pipes: Span[]
}

/** 行内所有 `|` 位置 */
export function findPipes(line: string): Span[] {
  const pipes: Span[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') pipes.push({ from: i, to: i + 1 })
  }
  return pipes
}

/**
 * 按 GFM 规则切分表格行。
 * 允许省略首尾 `|`；单元格文本保留两侧空格（编辑时可点进空白格）。
 */
export function parseTableRow(line: string): ParsedTableRow {
  const pipes = findPipes(line)
  let innerStart = 0
  let innerEnd = line.length
  const trimmedStart = line.trimStart()
  const leadingWs = line.length - trimmedStart.length
  if (trimmedStart.startsWith('|')) {
    innerStart = leadingWs + 1
  }
  const trimmedEnd = line.trimEnd()
  const trailingWs = line.length - trimmedEnd.length
  if (trimmedEnd.endsWith('|')) {
    innerEnd = line.length - trailingWs - 1
  }

  const cells: TableCellSpan[] = []
  if (innerStart > innerEnd) {
    return { cells, pipes }
  }

  let start = innerStart
  for (let i = innerStart; i <= innerEnd; i++) {
    if (i === innerEnd || line[i] === '|') {
      cells.push({ from: start, to: i, text: line.slice(start, i) })
      start = i + 1
    }
  }
  return { cells, pipes }
}

const SEP_CELL_RE = /^\s*:?-{3,}:?\s*$/

/** 分隔行：每个 cell 都是 `---` / `:---` / `---:` / `:---:`，且行内必须有 `|`（避免与 hr 冲突） */
export function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false
  const { cells } = parseTableRow(line)
  if (cells.length < 1) return false
  return cells.every((c) => SEP_CELL_RE.test(c.text))
}

/** 可能的表头/表体行：含 `|` 且非空白 */
export function looksLikeTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0
}

/** 生成空单元格文本（两侧各一空格，便于落光标） */
export function emptyCellText(): string {
  return '  '
}

export function formatTableRow(cells: readonly string[]): string {
  return `|${cells.map((c) => (c.length ? c : emptyCellText())).join('|')}|`
}

export function formatSeparator(cols: number, align: readonly ('left' | 'center' | 'right' | 'none')[] = []): string {
  const parts: string[] = []
  for (let i = 0; i < cols; i++) {
    const a = align[i] ?? 'none'
    if (a === 'left') parts.push(' :--- ')
    else if (a === 'right') parts.push(' ---: ')
    else if (a === 'center') parts.push(' :---: ')
    else parts.push(' --- ')
  }
  return `|${parts.join('|')}|`
}
