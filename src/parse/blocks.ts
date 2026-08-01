/**
 * 行级分类器：把每一行（= 一个 block 节点的 textContent）归入块级类型。
 * fence / table 是带跨行状态的结构，用小状态机处理；其余都是单行正则。
 */

import { isTableSeparator, looksLikeTableRow, parseTableRow } from './table'

export type LineInfo =
  | { t: 'blank' }
  | { t: 'para' }
  | { t: 'heading'; level: number; prefixLen: number }
  | { t: 'quote'; prefixLen: number }
  | { t: 'todo'; indent: number; checked: boolean; prefixLen: number; checkOffset: number }
  | { t: 'bullet'; indent: number; prefixLen: number }
  | { t: 'ordered'; indent: number; num: number; numLen: number; prefixLen: number }
  | { t: 'hr' }
  | { t: 'fenceOpen'; tickStart: number; tickLen: number; info: string }
  | { t: 'fenceClose'; tickStart: number; tickLen: number }
  | { t: 'code' }
  | { t: 'tableHeader'; colCount: number }
  | { t: 'tableSep'; colCount: number }
  | { t: 'tableRow'; colCount: number }

export type LineType = LineInfo['t']

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const HEADING_RE = /^(#{1,6}) /
const QUOTE_RE = /^ {0,3}> ?/
const TODO_RE = /^(\s*)([-*+]) \[( |x|X)\] /
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const BULLET_RE = /^(\s*)([-*+]) /
const ORDERED_RE = /^(\s*)(\d{1,9})[.)] /

export function classifyLines(lines: readonly string[]): LineInfo[] {
  const out: LineInfo[] = []
  let fence: { char: string; len: number } | null = null
  /** 表格状态：刚写出表头后等分隔行，或正在消费表体 */
  let table: null | { phase: 'sep' | 'body'; colCount: number } = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (fence) {
      const m = line.match(FENCE_RE)
      if (m && m[2][0] === fence.char && m[2].length >= fence.len && !m[3].trim()) {
        out.push({ t: 'fenceClose', tickStart: m[1].length, tickLen: m[2].length })
        fence = null
      } else {
        out.push({ t: 'code' })
      }
      continue
    }

    if (table?.phase === 'sep') {
      out.push({ t: 'tableSep', colCount: table.colCount })
      table = { phase: 'body', colCount: table.colCount }
      continue
    }

    if (table?.phase === 'body') {
      if (looksLikeTableRow(line) && !isTableSeparator(line)) {
        out.push({ t: 'tableRow', colCount: table.colCount })
        continue
      }
      table = null
      // 非表体行：落入下方常规分类
    }

    const open = line.match(FENCE_RE)
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      fence = { char: open[2][0], len: open[2].length }
      out.push({ t: 'fenceOpen', tickStart: open[1].length, tickLen: open[2].length, info: open[3].trim() })
      continue
    }

    // GFM 表格：表头行 + 下一行分隔符。多行结构无法靠"输入触发"，
    // 识别靠 look-ahead；创建请走 insertTable。
    if (
      looksLikeTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const colCount = Math.max(1, parseTableRow(lines[i + 1]).cells.length)
      out.push({ t: 'tableHeader', colCount })
      table = { phase: 'sep', colCount }
      continue
    }

    if (!line.trim()) {
      out.push({ t: 'blank' })
      continue
    }

    let m: RegExpMatchArray | null
    if ((m = line.match(HEADING_RE))) {
      out.push({ t: 'heading', level: m[1].length, prefixLen: m[1].length + 1 })
      continue
    }
    if ((m = line.match(TODO_RE))) {
      out.push({
        t: 'todo',
        indent: m[1].length,
        checked: m[3] !== ' ',
        prefixLen: m[0].length,
        checkOffset: m[1].length + 3,
      })
      continue
    }
    if ((m = line.match(HR_RE))) {
      out.push({ t: 'hr' })
      continue
    }
    if ((m = line.match(QUOTE_RE))) {
      out.push({ t: 'quote', prefixLen: m[0].length })
      continue
    }
    if ((m = line.match(BULLET_RE))) {
      out.push({ t: 'bullet', indent: m[1].length, prefixLen: m[0].length })
      continue
    }
    if ((m = line.match(ORDERED_RE))) {
      out.push({
        t: 'ordered',
        indent: m[1].length,
        num: Number(m[2]),
        numLen: m[2].length,
        prefixLen: m[0].length,
      })
      continue
    }
    out.push({ t: 'para' })
  }
  return out
}
