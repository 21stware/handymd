/**
 * Lazy-loaded editor chunk. Intentionally does NOT import shiki —
 * keeps the playground bundle small for first interaction.
 * Mermaid is pulled via dynamic import inside createMermaidRenderer,
 * so it lands in a separate chunk after the playground mounts.
 */
// Import from the workspace package (shiki is only pulled if createShikiHighlighter
// is called — the landing playground never calls it, so shiki stays out of the graph).
import { createEditor, createMermaidRenderer, type HandyEditor } from '@21stware/handymd'
import '@21stware/handymd/style.css'
import { SAMPLE_MARKDOWN } from './sample'

export type PlaygroundApi = {
  editor: HandyEditor
  openMarkdown: (md: string, meta: { name: string; handle?: FileSystemFileHandle | null }) => void
  getMarkdown: () => string
  focus: () => void
  setReadOnly: (v: boolean) => void
  getReadOnly: () => boolean
  saveToHandle: () => Promise<boolean>
  setFileHandle: (handle: FileSystemFileHandle | null, name?: string) => void
  destroy: () => Promise<void>
}

export type PlaygroundHooks = {
  onSaveStatus?: (status: string) => void
  onFileName?: (name: string, meta: string) => void
  onReady?: () => void
}

type FileSystemWritableFileStream = {
  write: (data: string) => Promise<void>
  close: () => Promise<void>
}

type WritableHandle = FileSystemFileHandle & {
  createWritable: () => Promise<FileSystemWritableFileStream>
}

export async function mountPlayground(
  mount: HTMLElement,
  hooks: PlaygroundHooks = {},
): Promise<PlaygroundApi> {
  let fileHandle: FileSystemFileHandle | null = null
  let fileName = 'welcome.md'
  let readOnly = false

  const editor = createEditor({
    mount,
    content: SAMPLE_MARKDOWN,
    onChange: () => hooks.onSaveStatus?.('dirty'),
    // Promise-accepted: mermaid chunk loads after first paint of the playground
    diagram: createMermaidRenderer({ theme: 'neutral' }),
    onSaveStatusChange: (status) => hooks.onSaveStatus?.(status),
    onOpenLink: (href) => {
      window.open(href, '_blank', 'noopener,noreferrer')
    },
  })

  hooks.onFileName?.(fileName, '示例文稿 · 手动保存')
  hooks.onReady?.()

  return {
    editor,
    openMarkdown(md, meta) {
      fileHandle = meta.handle ?? null
      fileName = meta.name || 'untitled.md'
      editor.setMarkdown(md)
      const label = fileHandle ? '已关联本机文件' : '已打开（未关联句柄）'
      hooks.onFileName?.(fileName, label)
      hooks.onSaveStatus?.('clean')
    },
    getMarkdown: () => editor.getMarkdown(),
    focus: () => editor.focus(),
    setReadOnly(v) {
      readOnly = v
      editor.setReadOnly(v)
    },
    getReadOnly: () => readOnly,
    async saveToHandle() {
      const md = editor.getMarkdown()
      if (fileHandle && 'createWritable' in fileHandle) {
        hooks.onSaveStatus?.('saving')
        const writable = await (fileHandle as WritableHandle).createWritable()
        await writable.write(md)
        await writable.close()
        hooks.onFileName?.(fileName, '已保存到本机')
        hooks.onSaveStatus?.('clean')
        return true
      }
      // Fallback: download
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName.endsWith('.md') ? fileName : `${fileName}.md`
      a.click()
      URL.revokeObjectURL(url)
      hooks.onFileName?.(fileName, '已下载')
      hooks.onSaveStatus?.('clean')
      return true
    },
    setFileHandle(handle, name) {
      fileHandle = handle
      if (name) fileName = name
      hooks.onFileName?.(fileName, handle ? '已关联本机文件' : '未保存文稿')
    },
    destroy: () => editor.destroy(),
  }
}
