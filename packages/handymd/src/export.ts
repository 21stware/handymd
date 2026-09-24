/**
 * 导出 PDF：把「渲染态」文档交给浏览器打印（用户在打印对话框里选「存储为 PDF」）。
 *
 * 做法是克隆编辑器当前的渲染 DOM，而不是另写一套 Markdown → HTML：
 * 标记符隐藏、代码高亮、mermaid 图表、表格、图片都与屏幕上所见一致。
 *
 *   1. 临时把 conceal 切到只读渲染态（光标所在元素也收起源码；源码模式也按渲染态导出）
 *   2. 等待仍在渲染的图表 / 图片
 *   3. 克隆 DOM，去掉编辑态痕迹（表格把手、编辑中的格子、选中态）
 *   4. 写进隐藏 iframe（带上页面的样式表与 --hm-* 主题变量），调用 print()
 */

import type { EditorView } from 'prosemirror-view'
import { concealKey, type ConcealMeta } from './conceal/plugin'
import { renderCellPreview } from './conceal/tableview'
import { cellSourceFromInput } from './parse/table'

export interface ExportPDFOptions {
  /** 打印文档标题（多数浏览器用作默认 PDF 文件名）；缺省取第一个标题 */
  title?: string
  /** 追加的打印 CSS */
  css?: string
  /** 等待图表 / 图片 / 样式加载的上限（ms），默认 8000 */
  timeout?: number
  /**
   * 触发打印的方式，默认 `win.print()`。可替换为宿主自己的实现
   * （如桌面壳的原生打印接口），测试里也用它拦截。
   */
  print?: (win: Window) => void | Promise<void>
}

const PRINT_CSS = `
@page { margin: 16mm 14mm; }
html, body { margin: 0; padding: 0; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.hm-print .ProseMirror {
  padding: 0 !important; margin: 0 !important; min-height: 0 !important;
  height: auto !important; max-height: none !important; overflow: visible !important;
  outline: none !important;
}
.hm-print .hm-table-ui { display: none !important; }
.hm-print .hm-table-scroll { overflow: visible !important; margin: 0 !important; padding: 0 !important; }
.hm-print .hm-table-inner { width: auto !important; }
.hm-print .hm-table-grid .hm-table-cell { min-width: 0 !important; }
.hm-print .hm-diagram { cursor: default; overflow: visible; }
.hm-print tr, .hm-print img.hm-image, .hm-print .hm-diagram { break-inside: avoid; }
.hm-print .hm-heading { break-after: avoid; }
`

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitUntil(done: () => boolean, timeout: number): Promise<void> {
  const until = Date.now() + timeout
  while (!done() && Date.now() < until) await delay(50)
}

function firstHeading(view: EditorView): string {
  let title = ''
  view.state.doc.forEach((node) => {
    if (title) return
    const m = node.textContent.match(/^#{1,6}\s+(.+)$/)
    if (m) title = m[1]!.trim()
  })
  return title
}

/** 克隆渲染态 DOM 并去掉编辑态痕迹（导出为纯展示内容） */
export function printableClone(dom: HTMLElement): HTMLElement {
  const clone = dom.cloneNode(true) as HTMLElement
  // cloneNode 只复制 attribute，checkbox 的勾选状态是 property
  const boxes = dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  clone.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
    box.toggleAttribute('checked', !!boxes[i]?.checked)
  })
  for (const el of clone.querySelectorAll('.hm-table-ui, .ProseMirror-separator')) el.remove()
  for (const cell of clone.querySelectorAll<HTMLElement>('.hm-table-cell-editing')) {
    cell.replaceChildren(renderCellPreview(cellSourceFromInput(cell.textContent ?? '')))
  }
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('contenteditable')
    el.removeAttribute('tabindex')
    el.removeAttribute('spellcheck')
    el.classList.remove(
      'hm-table-cell-editing',
      'hm-table-cell-picked',
      'hm-table-picking',
      'hm-image-selected',
      'ProseMirror-focused',
    )
  }
  return clone
}

/** 页面样式表里出现过的 --hm-* 变量在编辑器挂载点上的取值（主题可能挂在祖先元素上） */
function themeVariables(mount: HTMLElement): string {
  const names = new Set<string>()
  const scan = (text: string) => {
    for (const m of text.matchAll(/--hm-[\w-]+/g)) names.add(m[0])
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) scan(rule.cssText)
    } catch {
      // 跨域样式表不可读
    }
  }
  const cs = getComputedStyle(mount)
  const out: string[] = []
  for (const name of names) {
    const v = cs.getPropertyValue(name).trim()
    if (v) out.push(`${name}: ${v}`)
  }
  return out.join('; ')
}

function pageBackground(el: HTMLElement | null): string {
  for (let n = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg
  }
  return '#fff'
}

const escapeHTML = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** 生成可直接打印的完整 HTML 文档（渲染态内容 + 页面样式） */
export function buildPrintDocument(view: EditorView, options: Pick<ExportPDFOptions, 'title' | 'css'> = {}): string {
  const mount = (view.dom.parentElement ?? view.dom) as HTMLElement
  const title = options.title ?? (firstHeading(view) || document.title || 'Untitled')
  const styles = Array.from(document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style'))
    .map((el) => {
      if (el instanceof HTMLLinkElement) return `<link rel="stylesheet" href="${escapeHTML(el.href)}">`
      return el.outerHTML
    })
    .join('\n')
  const classes = Array.from(mount.classList).filter((c) => c !== 'hm-source')
  if (!classes.includes('handymd')) classes.push('handymd')
  classes.push('hm-print')
  const bg = pageBackground(mount)
  return [
    '<!doctype html>',
    `<html class="${escapeHTML(document.documentElement.className)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<base href="${escapeHTML(document.baseURI)}">`,
    `<title>${escapeHTML(title)}</title>`,
    styles,
    `<style>${PRINT_CSS}\nhtml, body { background: ${bg}; }\n${options.css ?? ''}</style>`,
    '</head>',
    `<body class="${escapeHTML(document.body.className)}">`,
    `<div class="${escapeHTML(classes.join(' '))}" style="${escapeHTML(themeVariables(mount))}">`,
    printableClone(view.dom).outerHTML,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

async function settle(doc: Document, timeout: number): Promise<void> {
  const once = (el: EventTarget) =>
    new Promise<void>((r) => {
      el.addEventListener('load', () => r(), { once: true })
      el.addEventListener('error', () => r(), { once: true })
    })
  const waits: Promise<unknown>[] = []
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (!link.sheet) waits.push(once(link))
  }
  for (const img of doc.querySelectorAll('img')) if (!img.complete) waits.push(once(img))
  if (doc.fonts?.ready) waits.push(doc.fonts.ready)
  await Promise.race([Promise.all(waits), delay(timeout)])
}

/**
 * 打开系统打印对话框导出 PDF。返回的 Promise 在 print() 调用返回后 resolve。
 * 只读 / 源码模式都可以导出，且不改变编辑器的状态。
 */
export async function exportToPDF(view: EditorView, options: ExportPDFOptions = {}): Promise<void> {
  const timeout = options.timeout ?? 8000
  const st = concealKey.getState(view.state)
  let restore: ConcealMeta | null = null
  if (st && (!st.readOnly || st.source)) {
    restore = { readOnly: st.readOnly, source: st.source }
    view.dispatch(view.state.tr.setMeta(concealKey, { readOnly: true, source: false } satisfies ConcealMeta))
  }
  let html: string
  try {
    await waitUntil(
      () => !view.dom.querySelector('.hm-diagram-loading, img.hm-image-loading'),
      timeout,
    )
    html = buildPrintDocument(view, options)
  } finally {
    if (restore && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(concealKey, restore))
  }

  // 某些环境（打印被拦截 / 不派发 afterprint）会留下上一次的打印 frame
  for (const old of document.querySelectorAll('iframe[data-hm-print]')) old.remove()
  const iframe = document.createElement('iframe')
  iframe.dataset.hmPrint = ''
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const win = iframe.contentWindow
  const doc = iframe.contentDocument
  if (!win || !doc) {
    iframe.remove()
    throw new Error('[handymd] exportToPDF: cannot create print frame')
  }
  doc.open()
  doc.write(html)
  doc.close()
  await settle(doc, timeout)

  // 部分浏览器用顶层文档标题作为默认文件名
  const prevTitle = document.title
  document.title = doc.title
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    document.title = prevTitle
    iframe.remove()
  }
  win.addEventListener('afterprint', () => setTimeout(cleanup, 0), { once: true })
  try {
    win.focus()
    await (options.print ?? ((w: Window) => w.print()))(win)
  } finally {
    // 自定义 print 不会触发 afterprint；原生 print 在对话框关闭后才返回（Chromium / WebKit）
    if (options.print) cleanup()
  }
}
