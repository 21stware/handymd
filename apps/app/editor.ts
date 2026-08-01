/**
 * Immersive editor host — file-handle persistence, no UI chrome.
 *
 * Ops (wired by main.ts):
 *   open / save / save-as / new / drag-drop / OS file_handlers
 */
import { createEditor, type HandyEditor } from '@21stware/handymd'
import '@21stware/handymd/style.css'

export type AppEditorApi = {
  editor: HandyEditor
  openMarkdown: (md: string, meta: { name: string; handle?: FileSystemFileHandle | null }) => void
  getMarkdown: () => string
  focus: () => void
  setReadOnly: (v: boolean) => void
  getReadOnly: () => boolean
  saveToHandle: () => Promise<boolean>
  saveAs: () => Promise<boolean>
  hasHandle: () => boolean
  getFileName: () => string
  newDocument: () => void
  destroy: () => Promise<void>
}

export type AppEditorHooks = {
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

/** Bump when default doc semantics change so stale product drafts are not reused. */
const STORAGE_KEY = 'handymd-app-draft-v3'
const DEFAULT_NAME = 'Untitled.md'

/** Empty page — Typora/Bear open onto blank paper. */
const BLANK = ''

export async function mountAppEditor(
  mount: HTMLElement,
  hooks: AppEditorHooks = {},
): Promise<AppEditorApi> {
  let fileHandle: FileSystemFileHandle | null = null
  let fileName = DEFAULT_NAME
  let readOnly = false

  const editor = createEditor({
    mount,
    load: async () => {
      try {
        const draft = localStorage.getItem(STORAGE_KEY)
        // Prefer last local draft only if non-empty; otherwise blank paper.
        if (draft != null && draft.length > 0) return draft
        return BLANK
      } catch {
        return BLANK
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
        localStorage.setItem(STORAGE_KEY, md)
      } catch {
        /* quota / private mode */
      }
    },
    autosave: { debounceMs: 500 },
    onSaveStatusChange: (status) => hooks.onSaveStatus?.(status),
    onOpenLink: (href) => {
      window.open(href, '_blank', 'noopener,noreferrer')
    },
  })

  const publishName = (name: string, meta: string) => {
    fileName = name
    document.title = name.replace(/\.md$/i, '') || 'Untitled'
    hooks.onFileName?.(name, meta)
  }

  publishName(fileName, 'draft')
  hooks.onReady?.()

  // Focus for immediate typing (Bear/Typora open ready to write).
  queueMicrotask(() => editor.focus())

  async function saveAs(): Promise<boolean> {
    const md = editor.getMarkdown()
    const w = window as Window & {
      showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
    }
    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: fileName.endsWith('.md') ? fileName : `${fileName}.md`,
          types: [
            {
              description: 'Markdown',
              accept: {
                'text/markdown': ['.md', '.markdown'],
                'text/plain': ['.md', '.txt'],
              },
            },
          ],
        })
        fileHandle = handle
        const writable = await (handle as WritableHandle).createWritable()
        await writable.write(md)
        await writable.close()
        publishName(handle.name, 'saved')
        return true
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return false
      }
    }
    downloadMarkdown(md, fileName)
    publishName(fileName, 'downloaded')
    return true
  }

  async function saveToHandle(): Promise<boolean> {
    const md = editor.getMarkdown()
    if (fileHandle && 'createWritable' in fileHandle) {
      const writable = await (fileHandle as WritableHandle).createWritable()
      await writable.write(md)
      await writable.close()
      publishName(fileName, 'saved')
      return true
    }
    // No handle yet → Save As
    return saveAs()
  }

  return {
    editor,
    openMarkdown(md, meta) {
      fileHandle = meta.handle ?? null
      editor.setMarkdown(md)
      const label = fileHandle ? 'file' : 'draft'
      publishName(meta.name || DEFAULT_NAME, label)
      try {
        localStorage.setItem(STORAGE_KEY, md)
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
    hasHandle: () => !!fileHandle && 'createWritable' in fileHandle,
    getFileName: () => fileName,
    newDocument() {
      fileHandle = null
      editor.setMarkdown(BLANK)
      publishName(DEFAULT_NAME, 'draft')
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }
      editor.focus()
    },
    saveToHandle,
    saveAs,
    destroy: () => editor.destroy(),
  }
}

function downloadMarkdown(md: string, name: string): void {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name.endsWith('.md') ? name : `${name}.md`
  a.click()
  URL.revokeObjectURL(url)
}
