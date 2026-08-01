/**
 * 表格行 Concealed 态的可视化 DOM。
 *
 * ProseMirror 会把重叠的 inline decoration 合并成平铺 span（而非嵌套），
 * 因此不能在源码 span 上用 flex 做列布局 —— 单元格内的链接/加粗会拆成多列。
 * 这里改为整行 widget：列容器是真实 DOM，行内样式按 parseInline 预览绘制。
 */

import { parseInlineCached } from '../parse/inline'
import { parseTableRow } from '../parse/table'
import type { BlockMeta } from '../parse/docparse'

function equalStyle(
  a: { kind: string; href?: string } | null,
  b: { kind: string; href?: string } | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.href === b.href
}

/** 把单元格源码画成预览 DOM：隐藏标记符，保留 link/strong 等语义 class */
export function renderCellPreview(raw: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  let text = raw
  // 与 insertTable 的两侧空格 padding 对齐：展示时去掉首尾单空格
  if (text.startsWith(' ')) text = text.slice(1)
  if (text.endsWith(' ')) text = text.slice(0, -1)
  if (!text) {
    frag.appendChild(document.createTextNode('\u00a0'))
    return frag
  }

  const els = parseInlineCached(text)
  const hide = new Array<boolean>(text.length).fill(false)
  for (const e of els) {
    for (const m of e.markers) {
      for (let i = m.from; i < m.to && i < text.length; i++) hide[i] = true
    }
  }
  const styleAt: ({ kind: string; href?: string } | null)[] = new Array(text.length).fill(null)
  for (const e of els) {
    if (!e.content) continue
    if (!['link', 'strong', 'em', 'code', 'strike', 'mark', 'tag'].includes(e.kind)) continue
    for (let i = e.content.from; i < e.content.to && i < text.length; i++) {
      styleAt[i] = { kind: e.kind, href: e.attrs?.href }
    }
  }

  let i = 0
  while (i < text.length) {
    if (hide[i]) {
      i++
      continue
    }
    const st = styleAt[i]
    let j = i + 1
    while (j < text.length && !hide[j] && equalStyle(styleAt[j], st)) j++
    const slice = text.slice(i, j)
    if (st) {
      const span = document.createElement('span')
      span.className =
        st.kind === 'link' ? 'hm-link' : st.kind === 'tag' ? 'hm-tag' : `hm-${st.kind}`
      if (st.href) span.setAttribute('data-href', st.href)
      span.textContent = slice
      frag.appendChild(span)
    } else {
      frag.appendChild(document.createTextNode(slice))
    }
    i = j
  }
  if (!frag.childNodes.length) frag.appendChild(document.createTextNode('\u00a0'))
  return frag
}

export function buildTableRowVisual(
  block: BlockMeta,
  kind: 'tableHeader' | 'tableRow',
): HTMLElement {
  const row = document.createElement('div')
  row.className =
    'hm-table-visual' + (kind === 'tableHeader' ? ' hm-table-visual-header' : '')
  row.contentEditable = 'false'
  row.setAttribute('aria-hidden', 'true')

  const parsed = parseTableRow(block.text)
  const colCount =
    block.line.t === 'tableHeader' || block.line.t === 'tableRow'
      ? block.line.colCount
      : Math.max(1, parsed.cells.length)

  for (let c = 0; c < colCount; c++) {
    const td = document.createElement('div')
    td.className = 'hm-table-cell'
    td.setAttribute('data-col', String(c))
    td.appendChild(renderCellPreview(parsed.cells[c]?.text ?? ''))
    row.appendChild(td)
  }
  return row
}
