/**
 * Minimal, focused Markdown → HTML renderer for the handymd docs site.
 *
 * Supports the subset used by docs/*.md:
 *   - ATX headings (# … ######) with slug ids
 *   - Fenced code blocks (```lang … ```), including ```mermaid (rendered at runtime via CDN)
 *   - GFM tables (with header separator row)
 *   - Blockquotes
 *   - Ordered / unordered lists (flat)
 *   - Horizontal rules (---)
 *   - Inline: `code`, **strong**, *em*, [text](href), <autolink>, escaping
 *
 * Not a general-purpose parser — tuned for the SDK's own docs.
 */

export type RenderResult = {
  html: string
  /** H2 headings in order, for the right-rail TOC. */
  toc: { id: string; text: string; level: number }[]
}

export function renderMarkdown(src: string): RenderResult {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const toc: { id: string; text: string; level: number }[] = []
  let i = 0
  const usedIds = new Set<string>()

  const slug = (text: string): string => {
    const base = text
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()
      .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
      .replace(/\s+/g, '-')
    let id = base || 'section'
    let n = 2
    while (usedIds.has(id)) id = `${base}-${n++}`
    usedIds.add(id)
    return id
  }

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!)
        i++
      }
      i++ // consume closing ```
      const codeText = code.join('\n')
      if (lang === 'mermaid') {
        out.push(
          `<div class="mermaid" data-mermaid>${escapeHtml(codeText)}</div>`,
        )
      } else {
        out.push(
          `<pre class="code-block"><code data-lang="${escapeAttr(lang)}">${escapeHtml(codeText)}</code></pre>`,
        )
      }
      continue
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]!.length
      const text = h[2]!.trim()
      const id = slug(stripInline(text))
      out.push(`<h${level} id="${escapeAttr(id)}">${inline(text)}</h${level}>`)
      if (level >= 2) toc.push({ id, text: stripInline(text), level })
      i++
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line) && !isInTable(lines, i)) {
      out.push('<hr />')
      i++
      continue
    }

    // Table (GFM): a header row followed by a separator row
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = parseTableRow(line)
      const aligns = parseTableSeparator(lines[i + 1]!)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!))
        i++
      }
      out.push(renderTable(header, aligns, rows))
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n')).html}</blockquote>`)
      continue
    }

    // List
    if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (
        i < lines.length &&
        (/^\s*([-*+])\s+/.test(lines[i]!) || /^\s*\d+\.\s+/.test(lines[i]!))
      ) {
        const item = lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, '')
        items.push(item)
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(
        `<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`,
      )
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph: gather consecutive non-blank, non-block lines
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !/^\s*([-*+])\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !(/^\s*([-*_])\1{2,}\s*$/.test(lines[i]!) && !isInTable(lines, i)) &&
      !(isTableRow(lines[i]!) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
    ) {
      para.push(lines[i]!)
      i++
    }
    if (para.length === 0) {
      // Defensive: nothing matched as a block and paragraph wouldn't advance —
      // emit as plain text and move on (avoids infinite loop on edge cases).
      out.push(`<p>${inline(line)}</p>`)
      i++
      continue
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }

  return { html: out.join('\n'), toc }
}

// ——— Inline ———
function inline(text: string): string {
  // Escape first, protect code spans with a linear scan (avoid ReDoS on nested `` ` `` runs),
  // then apply the remaining markers.
  const { text: withPlaceholders, codes } = protectCodeSpans(escapeHtml(text))
  let s = withPlaceholders

  // Strong: **...**
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
  // Em: *...*
  s = s.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  // Strikethrough: ~~...~~
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>')
  // Mark: ==...==
  s = s.replace(/==([^=]+?)==/g, '<mark>$1</mark>')
  // Links: [text](href)
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, txt, href) =>
      `<a href="${escapeAttr(href)}"${externalAttr(href)}>${txt}</a>`,
  )
  // Autolinks: <https://...>
  s = s.replace(
    /&lt;(https?:\/\/[^&\s]+)&gt;/g,
    (_m, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  )
  // Restore inline code (index placeholders)
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => {
    const code = codes[Number(idx)] ?? ''
    return `<code>${code}</code>`
  })

  return s
}

/**
 * CommonMark-ish code spans: N backticks … N backticks.
 * Linear scan — the previous `/(`+)([^`]+?)\1/` form ReDoS'd on docs that
 * mention fenced blocks with nested backticks (e.g. ```` ```mermaid ````).
 */
function protectCodeSpans(s: string): { text: string; codes: string[] } {
  const codes: string[] = []
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] !== '`') {
      out += s[i]!
      i++
      continue
    }
    let j = i
    while (j < s.length && s[j] === '`') j++
    const n = j - i
    // Find a closing run of exactly n backticks (not part of a longer run).
    let k = j
    let found = -1
    while (k < s.length) {
      if (s[k] !== '`') {
        k++
        continue
      }
      let m = k
      while (m < s.length && s[m] === '`') m++
      if (m - k === n) {
        found = k
        break
      }
      k = m
    }
    if (found < 0) {
      // Unclosed — emit the opening ticks as literal text.
      out += s.slice(i, j)
      i = j
      continue
    }
    const code = s.slice(j, found)
    const idx = codes.length
    codes.push(code)
    out += `\u0000CODE${idx}\u0000`
    i = found + n
  }
  return { text: out, codes }
}

function externalAttr(href: string): string {
  return /^https?:\/\//.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''
}

function stripInline(text: string): string {
  return text.replace(/[`*_~]/g, '').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
}

// ——— Tables ———
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:]*-+[\s:|-]*\|?\s*$/.test(line) && line.includes('-')
}

function isInTable(lines: string[], idx: number): boolean {
  // A line of --- right after a table row is a separator, not an hr.
  return idx > 0 && isTableRow(lines[idx - 1]!)
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function parseTableSeparator(line: string): ('left' | 'center' | 'right')[] {
  const cells = parseTableRow(line)
  return cells.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function renderTable(
  header: string[],
  aligns: ('left' | 'center' | 'right')[],
  rows: string[][],
): string {
  const th = header
    .map((c, i) => `<th style="text-align:${aligns[i] ?? 'left'}">${inline(c)}</th>`)
    .join('')
  const trs = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => `<td style="text-align:${aligns[i] ?? 'left'}">${inline(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`
}

// ——— Escaping ———
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
