/**
 * 图片。
 *
 * 图片在源码里就是一行 `![alt](src)`，由 decorations 渲染成预览 widget。
 * 这里负责：
 *   - 插入：`insertImage({ src, alt })` command / `editor.insertImage()`、
 *     粘贴 / 拖放图片文件（imagePlugin）、`editor.insertImageFiles(files)`
 *   - 原子交互：图片永远不回到源码。单击 = 选中（选区覆盖整段源码），
 *     Backspace / Delete 先选中再删除，方向键把它当成一个字符跨过
 *
 * 文件先以 blob: URL 占位插入（立即可见），上传完成后把占位 URL 原位替换为
 * 最终地址；上传失败则移除占位。未提供上传函数时退化为 data: URL 内联
 * （不推荐：源码会被 base64 撑大 —— 用 upload 或 createLocalImageStore）。
 */

import type { Command, EditorState } from 'prosemirror-state'
import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { concealKey, findBlockAt } from './conceal/plugin'
import type { ElementRange } from './elements'

export interface InsertImageOptions {
  src: string
  alt?: string
}

/** 上传图片文件，返回可放进 Markdown 的地址 */
export type ImageUploader = (file: File) => Promise<string>

/**
 * 渲染时把 Markdown 里的图片地址解析成浏览器可加载的 URL。
 * 用于相对路径（`assets/a.png` → 相对当前文档）或自定义存储（IndexedDB / 私有桶签名）。
 */
export type ImageResolver = (src: string) => string | Promise<string>

export interface ImagePluginOptions {
  /** 缺省时图片以 data: URL 内联进源码 */
  upload?: ImageUploader
}

function escapeAlt(alt: string): string {
  return alt.replace(/[\[\]\r\n]/g, ' ').trim()
}

function escapeSrc(src: string): string {
  return src.trim().replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
}

export function imageMarkdown({ src, alt = '' }: InsertImageOptions): string {
  return `![${escapeAlt(alt)}](${escapeSrc(src)})`
}

function altFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * 把图片作为独立一行插入：
 *   - 当前行为空：就地变成图片行
 *   - 否则：插在当前行之后
 * 光标落到图片下一行行首（没有空行就补一个），图片保持渲染态。
 */
export function insertImage(options: InsertImageOptions): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    if ($from.depth !== 1 || !options.src) return false
    if (!dispatch) return true
    const md = imageMarkdown(options)
    dispatch(insertImageLines(state, [md]).scrollIntoView())
    return true
  }
}

function insertImageLines(state: EditorState, lines: string[]) {
  const { $from } = state.selection
  const block = $from.parent
  const blockPos = $from.before()
  let tr = state.tr
  let at: number
  if (block.content.size === 0) {
    tr = tr.delete(blockPos, blockPos + block.nodeSize)
    at = blockPos
  } else {
    at = blockPos + block.nodeSize
  }
  for (const line of lines) {
    const node = schema.nodes.block.create(null, schema.text(line))
    tr = tr.insert(at, node)
    at += node.nodeSize
  }
  const next = tr.doc.nodeAt(at)
  if (!next || next.content.size > 0) tr = tr.insert(at, schema.nodes.block.create())
  return tr.setSelection(TextSelection.create(tr.doc, at + 1))
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

let placeholderSeq = 0

function placeholderSrc(file: File): { src: string; revoke: () => void } {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const src = URL.createObjectURL(file)
      return { src, revoke: () => URL.revokeObjectURL(src) }
    } catch {
      // happy-dom 等环境可能不支持 Blob URL
    }
  }
  return { src: `uploading:${++placeholderSeq}`, revoke: () => {} }
}

/** 在文档里找占位 URL，替换成 replacement（null = 删除整段图片源码） */
function replacePlaceholder(view: EditorView, placeholder: string, replacement: string | null): void {
  const { doc } = view.state
  let found: { from: number; to: number; imgFrom: number; imgTo: number } | null = null
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found
    const text = node.text ?? ''
    const idx = text.indexOf(`](${placeholder})`)
    if (idx < 0) return false
    const imgFrom = text.lastIndexOf('![', idx)
    found = {
      from: pos + idx + 2,
      to: pos + idx + 2 + placeholder.length,
      imgFrom: pos + (imgFrom < 0 ? idx : imgFrom),
      imgTo: pos + idx + 3 + placeholder.length,
    }
    return false
  })
  if (!found) return
  const f = found as { from: number; to: number; imgFrom: number; imgTo: number }
  let tr = view.state.tr
  if (replacement === null) tr = tr.delete(f.imgFrom, f.imgTo)
  else tr = tr.insertText(escapeSrc(replacement), f.from, f.to)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

/**
 * 在当前选区插入图片文件：先插占位，再异步上传 / 内联并原位替换。
 * 返回的 Promise 在所有文件处理完成后 resolve。
 */
export async function insertImageFiles(
  view: EditorView,
  files: Iterable<File>,
  upload?: ImageUploader,
): Promise<void> {
  const images = Array.from(files).filter(isImageFile)
  if (!images.length) return
  const pending = images.map((file) => ({ file, ...placeholderSrc(file) }))
  const lines = pending.map(({ file, src }) => `![${escapeAlt(altFromFileName(file.name))}](${src})`)
  view.dispatch(insertImageLines(view.state, lines).scrollIntoView())

  await Promise.all(
    pending.map(async ({ file, src, revoke }) => {
      let url: string | null = null
      try {
        url = upload ? await upload(file) : await readAsDataURL(file)
      } catch (err) {
        console.error('[handymd] image upload failed', err)
      }
      if (!view.isDestroyed) replacePlaceholder(view, src, url)
      revoke()
    }),
  )
}

function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files ?? []).filter(isImageFile)
}

// ---------------------------------------------------------------------------
// 原子交互
// ---------------------------------------------------------------------------

/** 渲染态下 pos 所在块里满足 test 的图片元素 */
function findImage(
  state: EditorState,
  pos: number,
  test: (el: ElementRange) => boolean,
): ElementRange | null {
  const st = concealKey.getState(state)
  if (!st || st.source) return null
  const $pos = state.doc.resolve(pos)
  if ($pos.depth !== 1) return null
  const block = st.blocks[findBlockAt(st.blocks, $pos.before())]
  if (!block) return null
  return block.elements.find((el) => el.kind === 'image' && test(el)) ?? null
}

/** 选区是否恰好选中一张图片 */
export function selectedImage(state: EditorState): ElementRange | null {
  const { from, to } = state.selection
  if (from === to) return null
  return findImage(state, from, (el) => el.from === from && el.to === to)
}

function selectRange(view: EditorView, from: number, to: number): true {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
  return true
}

function imageFromDOM(view: EditorView, dom: HTMLElement): ElementRange | null {
  let pos: number
  try {
    pos = view.posAtDOM(dom, 0)
  } catch {
    return null
  }
  return findImage(view.state, pos, (el) => el.from === pos)
}

function handleImageKey(view: EditorView, e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  const { state } = view
  const sel = state.selection
  const picked = selectedImage(state)

  if (picked) {
    if (e.shiftKey) return false
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        return selectRange(view, picked.from, picked.from)
      case 'ArrowRight':
      case 'ArrowDown':
        return selectRange(view, picked.to, picked.to)
      case 'Enter': {
        // 默认的 splitBlock 会先删掉选区 —— 图片应留下，换行开在它后面
        const tr = state.tr.split(picked.to)
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, picked.to + 2)).scrollIntoView())
        return true
      }
    }
    return false
  }

  if (!sel.empty || e.shiftKey) return false
  const pos = sel.from
  let img: ElementRange | null = null
  if (e.key === 'Backspace' || e.key === 'ArrowLeft') img = findImage(state, pos, (el) => el.to === pos)
  else if (e.key === 'Delete' || e.key === 'ArrowRight') img = findImage(state, pos, (el) => el.from === pos)
  if (!img) return false
  return selectRange(view, img.from, img.to)
}

/**
 * 光标 / 选区端点落进图片源码内部（方向键上下、点击到隐藏字符）：
 * 折叠光标 → 选中整张图；范围选区 → 端点推到图片边界，保证不会只删掉半段源码。
 */
function snapSelectionToImages(state: EditorState) {
  const sel = state.selection
  if (!(sel instanceof TextSelection)) return null
  const st = concealKey.getState(state)
  if (!st || st.source || st.composing || st.readOnly) return null
  const inside = (pos: number) => findImage(state, pos, (el) => pos > el.from && pos < el.to)
  if (sel.empty) {
    const img = inside(sel.head)
    return img ? state.tr.setSelection(TextSelection.create(state.doc, img.from, img.to)) : null
  }
  const forward = sel.head >= sel.anchor
  const a = inside(sel.anchor)
  const h = inside(sel.head)
  if (!a && !h) return null
  const anchor = a ? (forward ? a.from : a.to) : sel.anchor
  const head = h ? (forward ? h.to : h.from) : sel.head
  return state.tr.setSelection(TextSelection.create(state.doc, anchor, head))
}

/** 粘贴 / 拖放图片文件 → 插入图片；图片的点击选中 / 键盘删除 */
export function imagePlugin(options: ImagePluginOptions = {}): Plugin {
  return new Plugin({
    appendTransaction: (_trs, _old, state) => snapSelectionToImages(state),
    props: {
      handleKeyDown: (view, event) => (view.editable ? handleImageKey(view, event) : false),
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target as HTMLElement | null
          if (!target?.classList?.contains('hm-image') || event.button !== 0) return false
          event.preventDefault()
          if (!view.editable) return true
          const img = imageFromDOM(view, target)
          if (!img) return true
          selectRange(view, img.from, img.to)
          view.focus()
          return true
        },
      },
      handlePaste(view, event) {
        const files = imageFilesOf(event.clipboardData)
        if (!files.length || !view.editable) return false
        event.preventDefault()
        void insertImageFiles(view, files, options.upload)
        return true
      },
      handleDrop(view, event) {
        const files = imageFilesOf(event.dataTransfer)
        if (!files.length || !view.editable) return false
        event.preventDefault()
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (coords) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, coords.pos)))
        }
        void insertImageFiles(view, files, options.upload)
        return true
      },
    },
  })
}
