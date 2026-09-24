import { Fragment, Slice } from 'prosemirror-model'
import { Plugin, type EditorState } from 'prosemirror-state'
import { schema } from './schema'
import { concealKey } from './conceal/plugin'

/**
 * 剪贴板：文档即源码，一行一个 block，所以进出剪贴板的纯文本都必须是
 * 按 `\n` 精确对应的源码行。ProseMirror 默认按 `\n\n` 拼接块（复制出去每行
 * 多一个空行）、按 `\n+` 切分粘贴文本（空行被吞掉），两者都要替换。
 *
 * 外部 HTML（网页 / 文档编辑器）转换成 Markdown 源码再插入；
 * 编辑器内部的复制粘贴（带 data-pm-slice）走 ProseMirror 默认路径。
 */

/** 多行源码 → 两端 open 的 Slice：首行并入光标所在行，末行接上光标后的内容 */
export function markdownToSlice(markdown: string): Slice {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks = lines.map((line) =>
    schema.nodes.block.create(null, line ? schema.text(line) : undefined),
  )
  return new Slice(Fragment.from(blocks), 1, 1)
}

const URL_RE = /^(https?:\/\/|mailto:)\S+$/i

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL',
])
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT'])

function isBlock(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName)
}

/** 把两侧空白挪到标记外，空内容不包裹（`** bold **` 不是合法强调） */
function wrap(inner: string, marker: string, closer = marker): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  if (!m[2]) return inner
  return `${m[1]}${marker}${m[2]}${closer}${m[3]}`
}

function styleOf(el: Element): string {
  return (el.getAttribute('style') ?? '').toLowerCase()
}

function inlineText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/[\s\u00a0]+/g, ' ')
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName
  if (SKIP_TAGS.has(tag)) return ''
  if (tag === 'BR') return '\n'
  if (tag === 'IMG') {
    const src = el.getAttribute('src') ?? ''
    return src ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
  }
  if (tag === 'INPUT') return ''
  const inner = Array.from(el.childNodes).map(inlineText).join('')
  const style = styleOf(el)
  switch (tag) {
    case 'STRONG':
      return wrap(inner, '**')
    case 'B':
      // Google Docs 把整段内容包在 <b style="font-weight:normal"> 里
      return /font-weight:\s*(normal|[1-5]00)/.test(style) ? inner : wrap(inner, '**')
    case 'EM':
    case 'I':
      return wrap(inner, '*')
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap(inner, '~~')
    case 'MARK':
      return wrap(inner, '==')
    case 'CODE':
    case 'KBD':
    case 'SAMP':
      return inner.trim() ? wrap(inner, '`') : inner
    case 'A': {
      const href = el.getAttribute('href') ?? ''
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return inner
      const text = inner.trim()
      return text ? wrap(inner, '[', `](${href})`) : href
    }
  }
  let out = inner
  if (/font-weight:\s*(bold|[6-9]00)/.test(style)) out = wrap(out, '**')
  if (/font-style:\s*italic/.test(style)) out = wrap(out, '*')
  if (/text-decoration[^;]*line-through/.test(style)) out = wrap(out, '~~')
  return out
}

function codeLang(pre: Element): string {
  const code = pre.querySelector('code')
  const cls = `${code?.getAttribute('class') ?? ''} ${pre.getAttribute('class') ?? ''}`
  return cls.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? ''
}

function tableLines(table: Element): string[] {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (!rows.length) return []
  const cells = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c) => inlineText(c).replace(/\n/g, ' ').trim().replace(/\|/g, '\\|')),
  )
  const cols = Math.max(1, ...cells.map((r) => r.length))
  const fmt = (r: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => r[i] || ' ').join(' | ')} |`
  return [fmt(cells[0]!), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...cells.slice(1).map(fmt)]
}

/**
 * 块级遍历。返回的每一组是一个"段"（段与段之间插空行）；
 * 列表项之间不插空行，所以一个列表整体是一组。
 */
function blockGroups(parent: Node, listIndent: string): string[][] {
  const groups: string[][] = []
  let inline = ''
  const flush = () => {
    const lines = inline
      .split('\n')
      .map((l) => l.trim())
      .filter((l, i, arr) => l || (i > 0 && i < arr.length - 1))
    if (lines.some((l) => l)) groups.push(lines)
    inline = ''
  }

  for (const child of Array.from(parent.childNodes)) {
    if (!isBlock(child)) {
      inline += inlineText(child)
      continue
    }
    flush()
    const el = child as Element
    const tag = el.tagName
    if (/^H[1-6]$/.test(tag)) {
      const text = inlineText(el).replace(/\n/g, ' ').trim()
      if (text) groups.push([`${'#'.repeat(Number(tag[1]))} ${text}`])
    } else if (tag === 'HR') {
      groups.push(['---'])
    } else if (tag === 'PRE') {
      const code = (el.textContent ?? '').replace(/\n$/, '')
      groups.push(['```' + codeLang(el), ...code.split('\n'), '```'])
    } else if (tag === 'TABLE') {
      const lines = tableLines(el)
      if (lines.length) groups.push(lines)
    } else if (tag === 'UL' || tag === 'OL') {
      groups.push(listLines(el, listIndent))
    } else if (tag === 'BLOCKQUOTE') {
      const inner = blockGroups(el, '')
      const lines: string[] = []
      inner.forEach((g, i) => {
        if (i) lines.push('>')
        for (const l of g) lines.push(l ? `> ${l}` : '>')
      })
      if (lines.length) groups.push(lines)
    } else {
      groups.push(...blockGroups(el, listIndent))
    }
  }
  flush()
  return groups
}

function listLines(list: Element, indent: string): string[] {
  const ordered = list.tagName === 'OL'
  let n = Number(list.getAttribute('start') ?? '1') || 1
  const out: string[] = []
  for (const li of Array.from(list.children)) {
    if (li.tagName !== 'LI') continue
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]')
    const marker = box
      ? `- [${(box as HTMLInputElement).checked || box.hasAttribute('checked') ? 'x' : ' '}] `
      : ordered
        ? `${n++}. `
        : '- '
    const groups = blockGroups(li, indent + '  ')
    const lines = groups.flat().filter((l) => l !== '')
    const nestedStart = (l: string) => l.startsWith(indent + '  ')
    if (!lines.length || nestedStart(lines[0]!)) out.push(indent + marker.trimEnd() + ' ')
    lines.forEach((l, i) => {
      if (i === 0 && !nestedStart(l)) out.push(indent + marker + l)
      else out.push(l)
    })
  }
  return out
}

/** 外部 HTML → Markdown 源码（段间一个空行，列表项之间不空行） */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const groups = blockGroups(doc.body, '')
  return groups.map((g) => g.join('\n')).join('\n\n')
}

/** 代码编辑器（VS Code 等）复制出的 HTML 只是着色，源码以纯文本为准 */
function looksLikeCodeClipboard(data: DataTransfer, html: string): boolean {
  if (Array.from(data.types).includes('vscode-editor-data')) return true
  return /white-space:\s*pre/i.test(html.slice(0, 2000))
}

function inCodeLine(state: EditorState): boolean {
  const st = concealKey.getState(state)
  const $from = state.selection.$from
  if (!st || $from.depth !== 1) return false
  const t = st.blocks.find((b) => b.pos === $from.before())?.line.t
  return t === 'code' || t === 'diagramLine' || t === 'fenceOpen' || t === 'diagramOpen'
}

export function clipboardPlugin(): Plugin {
  return new Plugin({
    props: {
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
      clipboardTextParser: (text) => markdownToSlice(text),
      handlePaste(view, event) {
        const data = event.clipboardData
        if (!data) return false
        const text = data.getData('text/plain')
        const { state } = view
        const sel = state.selection

        // 选中文字后粘贴网址 → [文字](url)
        if (!sel.empty && sel.$from.sameParent(sel.$to) && URL_RE.test(text.trim())) {
          const label = state.doc.textBetween(sel.from, sel.to)
          if (!label.includes('\n') && !inCodeLine(state)) {
            view.dispatch(state.tr.insertText(`[${label}](${text.trim()})`).scrollIntoView())
            return true
          }
        }

        const html = data.getData('text/html')
        if (!html || html.includes('data-pm-slice')) return false
        if (looksLikeCodeClipboard(data, html) || inCodeLine(state)) {
          if (!text) return false
          view.dispatch(state.tr.replaceSelection(markdownToSlice(text)).scrollIntoView())
          return true
        }
        const md = htmlToMarkdown(html)
        if (!md.trim()) return false
        view.dispatch(state.tr.replaceSelection(markdownToSlice(md)).scrollIntoView())
        return true
      },
    },
  })
}
