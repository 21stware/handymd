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

/** 行内所有未转义的 `|` 位置（`\|` 是单元格内的字面竖线） */
export function findPipes(line: string): Span[] {
  const pipes: Span[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++
      continue
    }
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
  const leadingWs = line.length - line.trimStart().length
  const trailingWs = line.length - line.trimEnd().length
  if (pipes.length && pipes[0]!.from === leadingWs) innerStart = leadingWs + 1
  if (pipes.length && pipes[pipes.length - 1]!.from === line.length - trailingWs - 1) {
    innerEnd = line.length - trailingWs - 1
  }

  const cells: TableCellSpan[] = []
  if (innerStart > innerEnd) {
    return { cells, pipes }
  }

  let start = innerStart
  for (const p of pipes) {
    if (p.from < innerStart || p.from >= innerEnd) continue
    cells.push({ from: start, to: p.from, text: line.slice(start, p.from) })
    start = p.to
  }
  cells.push({ from: start, to: innerEnd, text: line.slice(start, innerEnd) })
  return { cells, pipes }
}

export type TableAlign = 'left' | 'center' | 'right' | 'none'

/** 分隔行每列的对齐方式 */
export function parseTableAlign(sepLine: string): TableAlign[] {
  return parseTableRow(sepLine).cells.map((c) => {
    const t = c.text.trim()
    const l = t.startsWith(':')
    const r = t.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : 'none'
  })
}

/** 单元格源码 → 编辑框里展示的文本：去掉两侧 padding 空格 */
export function cellDisplaySource(raw: string): string {
  let text = raw
  if (text.startsWith(' ')) text = text.slice(1)
  if (text.endsWith(' ')) text = text.slice(0, -1)
  return text
}

/** 编辑框文本 → 单元格源码：换行折成空格，裸 `|` 转义，两侧补 padding */
export function cellSourceFromInput(input: string): string {
  const flat = input.replace(/[\r\n]+/g, ' ').replace(/\u00a0/g, ' ')
  const escaped = flat.replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 ? m : `${bs}\\|`))
  return escaped ? ` ${escaped} ` : emptyCellText()
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
