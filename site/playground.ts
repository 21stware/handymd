/**
 * Lazy-loaded editor chunk. Intentionally does NOT import shiki —
 * keeps the playground bundle small for first interaction.
 */
// Import editor entry only — never `src/index` (re-exports shiki helpers).
import { createEditor, type HandyEditor } from '../src/editor'
import '../src/style.css'
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

  const storageKey = 'handymd-landing-draft'

  const editor = createEditor({
    mount,
    load: async () => {
      try {
        const draft = localStorage.getItem(storageKey)
        return draft && draft.length > 0 ? draft : SAMPLE_MARKDOWN
      } catch {
        return SAMPLE_MARKDOWN
      }
    },
    save: async (md) => {
      if (fileHandle && 'createWritable' in fileHandle) {
        const writable = await (fileHandle as WritableHandle).createWritable()
        await writable.write(md)
        await writable.close()
        return
      }
      try {
        localStorage.setItem(storageKey, md)
      } catch {
        /* quota / private mode — ignore */
      }
    },
    autosave: { debounceMs: 600 },
    onSaveStatusChange: (status) => hooks.onSaveStatus?.(status),
    onOpenLink: (href) => {
      window.open(href, '_blank', 'noopener,noreferrer')
    },
  })

  hooks.onFileName?.(fileName, '本地草稿 / 示例')
  hooks.onReady?.()

  return {
    editor,
    openMarkdown(md, meta) {
      fileHandle = meta.handle ?? null
      fileName = meta.name || 'untitled.md'
      editor.setMarkdown(md)
      const label = fileHandle ? '已关联本机文件' : '已打开（未关联句柄）'
      hooks.onFileName?.(fileName, label)
      try {
        localStorage.setItem(storageKey, md)
      } catch {
        /* ignore */
      }
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
        const writable = await (fileHandle as WritableHandle).createWritable()
        await writable.write(md)
        await writable.close()
        hooks.onFileName?.(fileName, '已保存到本机')
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
      return true
    },
    setFileHandle(handle, name) {
      fileHandle = handle
      if (name) fileName = name
      hooks.onFileName?.(fileName, handle ? '已关联本机文件' : '本地草稿')
    },
    destroy: () => editor.destroy(),
  }
}
