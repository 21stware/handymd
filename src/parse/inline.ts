import type { RelElement, Span } from '../elements'

/**
 * 行内元素扫描器。输入单行文本（不含换行），输出相对坐标（base=0）的元素表。
 *
 * 解析优先级（CommonMark 精神，但为源码保真模型做了简化）：
 *   code span > image > link > strong > strike > mark > em > tag
 *
 * 用 taken 位图实现遮罩：code/link/image 独占整个范围；strong/strike/mark
 * 只独占标记符本身，因此嵌套仍可命中（`*outer **inner** outer*`）。
 */

const CODE_RE = /(?<!`)(`+)([^`\n]+)\1(?!`)/g
const IMAGE_RE = /!\[([^\[\]\n]*)\]\(([^)\n]*)\)/g
const LINK_RE = /(?<!!)\[([^\[\]\n]*)\]\(([^)\n]*)\)/g
const STRONG_RE = /(\*\*|__)(?!\s)([^\n]+?)(?<!\s)\1/g
const STRIKE_RE = /~~(?!\s)([^~\n]+?)(?<!\s)~~/g
const MARK_RE = /==(?!\s)([^=\n]+?)(?<!\s)==/g
const TAG_RE = /(?<=^|[\s(（【"'：:，,、。;；])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu

export function parseInline(text: string): RelElement[] {
  if (!text) return []
  const taken = new Uint8Array(text.length)
  const out: RelElement[] = []

  const isFree = (a: number, b: number): boolean => {
    for (let i = a; i < b; i++) if (taken[i]) return false
    return true
  }
  const take = (a: number, b: number): void => {
    for (let i = a; i < b; i++) taken[i] = 1
  }
  const span = (from: number, to: number): Span => ({ from, to })

  // 1. code spans —— 内部不再解析任何行内元素
  for (const m of text.matchAll(CODE_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, to)) continue
    const tick = m[1].length
    out.push({
      kind: 'code',
      scope: 'inline',
      from,
      to,
      markers: [span(from, from + tick), span(to - tick, to)],
      content: span(from + tick, to - tick),
    })
    take(from, to)
  }

  // 2. images（在 link 之前，否则 `![..](..)` 会被 link 抢走后半段）
  for (const m of text.matchAll(IMAGE_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, to)) continue
    const altStart = from + 2
    const altEnd = altStart + m[1].length
    out.push({
      kind: 'image',
      scope: 'inline',
      from,
      to,
      markers: [span(from, altStart), span(altEnd, to)],
      content: span(altStart, altEnd),
      attrs: { href: m[2], alt: m[1] },
    })
    take(from, to)
  }

  // 3. links
  for (const m of text.matchAll(LINK_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, to)) continue
    const textStart = from + 1
    const textEnd = textStart + m[1].length
    out.push({
      kind: 'link',
      scope: 'inline',
      from,
      to,
      markers: [span(from, textStart), span(textEnd, to)],
      content: span(textStart, textEnd),
      attrs: { href: m[2] },
    })
    take(from, to)
  }

  // 4. strong —— 只占用标记符，内容留给嵌套 em
  for (const m of text.matchAll(STRONG_RE)) {
    const from = m.index!
    const to = from + m[0].length
    const w = m[1].length
    if (!isFree(from, from + w) || !isFree(to - w, to)) continue
    out.push({
      kind: 'strong',
      scope: 'inline',
      from,
      to,
      markers: [span(from, from + w), span(to - w, to)],
      content: span(from + w, to - w),
    })
    take(from, from + w)
    take(to - w, to)
  }

  // 5. strike
  for (const m of text.matchAll(STRIKE_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, from + 2) || !isFree(to - 2, to)) continue
    out.push({
      kind: 'strike',
      scope: 'inline',
      from,
      to,
      markers: [span(from, from + 2), span(to - 2, to)],
      content: span(from + 2, to - 2),
    })
    take(from, from + 2)
    take(to - 2, to)
  }

  // 6. mark / highlight pen（==text==）
  for (const m of text.matchAll(MARK_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, from + 2) || !isFree(to - 2, to)) continue
    out.push({
      kind: 'mark',
      scope: 'inline',
      from,
      to,
      markers: [span(from, from + 2), span(to - 2, to)],
      content: span(from + 2, to - 2),
    })
    take(from, from + 2)
    take(to - 2, to)
  }

  // 7. em —— 不用 `[^*]+` 正则（会挡住 `*a **b** c*` 这种嵌套），
  // 改为扫描成对 `*` / `_`，只要求两端标记符空闲，内容可含已被 strong 占用的 `*`。
  parseEmphasis(text, '*', taken, out, take)
  parseEmphasis(text, '_', taken, out, take)

  // 8. tags（Bear 风格 #tag，永远以 pill 展示，不参与 conceal —— static）
  for (const m of text.matchAll(TAG_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (!isFree(from, to)) continue
    out.push({
      kind: 'tag',
      scope: 'inline',
      from,
      to,
      markers: [],
      content: span(from, to),
      static: true,
    })
    take(from, to)
  }

  out.sort((a, b) => a.from - b.from || a.to - b.to)
  return out
}

/**
 * 成对强调标记扫描。跳过已占用位置；要求：
 * - opener 左侧不是字母数字/同字符（避免 a*b* / 以及 ** 的一部分）
 * - opener 右侧不是空白或同字符
 * - closer 左侧不是空白
 * - closer 右侧不是字母数字/同字符
 * - 内容非空
 */
function parseEmphasis(
  text: string,
  ch: '*' | '_',
  taken: Uint8Array,
  out: RelElement[],
  take: (a: number, b: number) => void,
): void {
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c)
  let i = 0
  while (i < text.length) {
    if (taken[i] || text[i] !== ch) {
      i++
      continue
    }
    // 跳过作为 strong 的一部分（连续两个同字符且都空闲 —— 已被 strong 阶段吃掉；
    // 若仍空闲则是未配对的 **，也不应做 em opener）
    if (text[i + 1] === ch && !taken[i + 1]) {
      i += 2
      continue
    }
    const prev = i > 0 ? text[i - 1] : undefined
    const next = text[i + 1]
    if (prev === ch || next === ch || next === undefined || /\s/.test(next)) {
      i++
      continue
    }
    if (ch === '*' && isWord(prev)) {
      i++
      continue
    }
    if (ch === '_' && (isWord(prev) || prev === '_')) {
      i++
      continue
    }

    // 寻找 closer
    let j = i + 1
    let found = -1
    while (j < text.length) {
      if (taken[j] || text[j] !== ch) {
        j++
        continue
      }
      if (text[j + 1] === ch && !taken[j + 1]) {
        j += 2
        continue
      }
      const before = text[j - 1]
      const after = text[j + 1]
      if (before === undefined || /\s/.test(before)) {
        j++
        continue
      }
      if (after === ch) {
        j++
        continue
      }
      if (ch === '*' && isWord(after)) {
        j++
        continue
      }
      if (ch === '_' && (isWord(after) || after === '_')) {
        j++
        continue
      }
      if (j > i + 1) {
        found = j
        break
      }
      j++
    }

    if (found < 0) {
      i++
      continue
    }

    out.push({
      kind: 'em',
      scope: 'inline',
      from: i,
      to: found + 1,
      markers: [
        { from: i, to: i + 1 },
        { from: found, to: found + 1 },
      ],
      content: { from: i + 1, to: found },
    })
    take(i, i + 1)
    take(found, found + 1)
    i = found + 1
  }
}

/**
 * 行内解析缓存：key 为行文本。文档变更时全量重扫，但同文本的行（未被编辑的
 * 行占绝大多数）直接命中缓存，成本退化为 O(变更行数)。
 */
const cache = new Map<string, RelElement[]>()
const CACHE_MAX = 4096

export function parseInlineCached(text: string): RelElement[] {
  const hit = cache.get(text)
  if (hit) return hit
  const parsed = parseInline(text)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(text, parsed)
  return parsed
}
