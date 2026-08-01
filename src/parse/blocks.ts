/**
 * 行级分类器：把每一行（= 一个 block 节点的 textContent）归入块级类型。
 * fence 是唯一带跨行状态的结构，在这里用一个小状态机处理；其余都是单行正则。
 *
 * 围栏块在结构化解析阶段就分成两类：
 *   - code block    → fenceOpen / code / fenceClose
 *   - diagram block → diagramOpen / diagramLine / diagramClose
 * 判据是 info string 的首个 token 是否为图表语言（如 ```mermaid）。
 * 两者共享同一套围栏状态机，仅产出的行类型不同。
 */

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
  | { t: 'diagramOpen'; tickStart: number; tickLen: number; info: string; lang: string }
  | { t: 'diagramClose'; tickStart: number; tickLen: number }
  | { t: 'diagramLine' }

export type LineType = LineInfo['t']

/** 视为 diagram block 的围栏语言（info string 首个 token，小写比较） */
const DIAGRAM_LANGS = new Set(['mermaid'])

/** info string → 图表语言；非图表围栏返回 null */
export function diagramLangOf(info: string): string | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return DIAGRAM_LANGS.has(lang) ? lang : null
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const HEADING_RE = /^(#{1,6}) /
const QUOTE_RE = /^ {0,3}> ?/
const TODO_RE = /^(\s*)([-*+]) \[( |x|X)\] /
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const BULLET_RE = /^(\s*)([-*+]) /
const ORDERED_RE = /^(\s*)(\d{1,9})[.)] /

export function classifyLines(lines: readonly string[]): LineInfo[] {
  const out: LineInfo[] = []
  let fence: { char: string; len: number; diagram: boolean } | null = null

  for (const line of lines) {
    if (fence) {
      const m = line.match(FENCE_RE)
      if (m && m[2][0] === fence.char && m[2].length >= fence.len && !m[3].trim()) {
        out.push(
          fence.diagram
            ? { t: 'diagramClose', tickStart: m[1].length, tickLen: m[2].length }
            : { t: 'fenceClose', tickStart: m[1].length, tickLen: m[2].length },
        )
        fence = null
      } else {
        out.push(fence.diagram ? { t: 'diagramLine' } : { t: 'code' })
      }
      continue
    }

    const open = line.match(FENCE_RE)
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      const info = open[3].trim()
      const lang = diagramLangOf(info)
      fence = { char: open[2][0], len: open[2].length, diagram: lang !== null }
      out.push(
        lang !== null
          ? { t: 'diagramOpen', tickStart: open[1].length, tickLen: open[2].length, info, lang }
          : { t: 'fenceOpen', tickStart: open[1].length, tickLen: open[2].length, info },
      )
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
