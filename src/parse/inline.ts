import type { RelElement, Span } from '../elements'

/**
 * 行内元素扫描器。输入单行文本（不含换行），输出相对坐标（base=0）的元素表。
 *
 * 解析优先级（CommonMark 精神，但为源码保真模型做了简化）：
 *   code span > image > link > strong > strike > em > tag
 *
 * 用 taken 位图实现遮罩：code/link/image 独占整个范围；strong/strike 只独占
 * 标记符本身，因此 `**bold *em* bold**` 里嵌套的 em 仍然可以命中。
 */

const CODE_RE = /(?<!`)(`+)([^`\n]+)\1(?!`)/g
const IMAGE_RE = /!\[([^\[\]\n]*)\]\(([^)\n]*)\)/g
const LINK_RE = /(?<!!)\[([^\[\]\n]*)\]\(([^)\n]*)\)/g
const STRONG_RE = /(\*\*|__)(?!\s)([^\n]+?)(?<!\s)\1/g
const STRIKE_RE = /~~(?!\s)([^~\n]+?)(?<!\s)~~/g
const EM_STAR_RE = /(?<![A-Za-z0-9*\\])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![A-Za-z0-9*])/g
const EM_UNDER_RE = /(?<![A-Za-z0-9_\\])_(?![\s_])([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/g
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

  // 6. em
  for (const re of [EM_STAR_RE, EM_UNDER_RE]) {
    for (const m of text.matchAll(re)) {
      const from = m.index!
      const to = from + m[0].length
      if (!isFree(from, from + 1) || !isFree(to - 1, to)) continue
      out.push({
        kind: 'em',
        scope: 'inline',
        from,
        to,
        markers: [span(from, from + 1), span(to - 1, to)],
        content: span(from + 1, to - 1),
      })
      take(from, from + 1)
      take(to - 1, to)
    }
  }

  // 7. tags（Bear 风格 #tag，永远以 pill 展示，不参与 conceal —— static）
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
