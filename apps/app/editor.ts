/**
 * Immersive editor host — file-handle persistence, no UI chrome.
 *
 * Ops (wired by main.ts):
 *   open / save / save-as / new / drag-drop / OS file_handlers
 */
import { TextSelection } from 'prosemirror-state'
import {
  createEditor,
  createMermaidRenderer,
  createShikiHighlighter,
  type HandyEditor,
} from '@21stware/handymd'
import '@21stware/handymd/style.css'

export type AppEditorApi = {
  editor: HandyEditor
  openMarkdown: (md: string, meta: { name: string; handle?: FileSystemFileHandle | null }) => void
  getMarkdown: () => string
  focus: () => void
  /** Place caret at end of document and focus (empty padding / bottom click). */
  focusEnd: () => void
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

  const dark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const editor = createEditor({
    mount,
    content: BLANK,
    highlight: createShikiHighlighter({ theme: dark ? 'github-dark' : 'github-light' }),
    // Follow system scheme so diagram strokes/labels stay readable.
    diagram: createMermaidRenderer({
      theme: dark ? 'dark' : 'neutral',
      config: {
        themeVariables: dark
          ? {
              background: '#1c1a17',
              primaryColor: '#2a2621',
              primaryTextColor: '#f2eee6',
              primaryBorderColor: '#8a8378',
              lineColor: '#c4bdb2',
              secondaryColor: '#24201c',
              tertiaryColor: '#1c1a17',
              fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
            }
          : {
              background: '#ebe7df',
              primaryColor: '#f7f4ee',
              primaryTextColor: '#1a1816',
              primaryBorderColor: '#6e6860',
              lineColor: '#5c564e',
              secondaryColor: '#e5e0d6',
              tertiaryColor: '#ebe7df',
              fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
            },
      },
    }),
    onChange: () => hooks.onSaveStatus?.('dirty'),
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
        hooks.onSaveStatus?.('saving')
        const writable = await (handle as WritableHandle).createWritable()
        await writable.write(md)
        await writable.close()
        publishName(handle.name, 'saved')
        hooks.onSaveStatus?.('clean')
        return true
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return false
      }
    }
    downloadMarkdown(md, fileName)
    publishName(fileName, 'downloaded')
    hooks.onSaveStatus?.('clean')
    return true
  }

  async function saveToHandle(): Promise<boolean> {
    const md = editor.getMarkdown()
    if (fileHandle && 'createWritable' in fileHandle) {
      hooks.onSaveStatus?.('saving')
      const writable = await (fileHandle as WritableHandle).createWritable()
      await writable.write(md)
      await writable.close()
      publishName(fileName, 'saved')
      hooks.onSaveStatus?.('clean')
      return true
    }
    // No handle yet → Save As
    return saveAs()
  }

  function focusEnd(): void {
    const view = editor.view
    if (!view) {
      editor.focus()
      return
    }
    const sel = TextSelection.atEnd(view.state.doc)
    view.dispatch(view.state.tr.setSelection(sel))
    view.focus()
  }

  return {
    editor,
    openMarkdown(md, meta) {
      fileHandle = meta.handle ?? null
      editor.setMarkdown(md)
      const label = fileHandle ? 'file' : 'draft'
      publishName(meta.name || DEFAULT_NAME, label)
      hooks.onSaveStatus?.('clean')
    },
    getMarkdown: () => editor.getMarkdown(),
    focus: () => editor.focus(),
    focusEnd,
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
      hooks.onSaveStatus?.('clean')
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
