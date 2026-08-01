/**
 * App editor host — wraps the handymd SDK with file-handle persistence.
 *
 * Supports:
 *   - open .md (File System Access API handle or plain File)
 *   - read / edit
 *   - save (write back to the same handle)
 *   - save-as (pick a new handle via showSaveFilePicker)
 *   - new (blank draft)
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

const STORAGE_KEY = 'handymd-app-draft'
const DEFAULT_NAME = 'welcome.md'

const WELCOME = `# welcome.md

这是 **handymd** —— Bear 风格的源码保真 Markdown 编辑器。

## 试一试

- 行内标记符按*光标位置*选择性隐藏：把光标移进 \`**粗体**\` 紧邻外侧
- 单击 [链接](https://21stware.github.io/handymd/) 直接打开，Cmd/Ctrl+点击进入编辑
- \`- [ ] \` 变 checkbox，\`> \` 变引用，\`---\` 变分隔线

> 安装为应用后，可在系统「打开方式」里用 handymd 打开 .md 文件。

\`\`\`ts
const editor = createEditor({ mount, save: (md) => fs.write(md) })
\`\`\`

---

点击「打开」选择本地文件，或直接拖放进来。「另存为」可写到新位置。
`

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
        return draft && draft.length > 0 ? draft : WELCOME
      } catch {
        return WELCOME
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
        /* quota / private mode — ignore */
      }
    },
    autosave: { debounceMs: 600 },
    onSaveStatusChange: (status) => hooks.onSaveStatus?.(status),
    onOpenLink: (href) => {
      window.open(href, '_blank', 'noopener,noreferrer')
    },
  })

  hooks.onFileName?.(fileName, '本地草稿')
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
      downloadMarkdown(md, fileName)
      hooks.onFileName?.(fileName, '已下载')
      return true
    },
    async saveAs() {
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
          fileName = handle.name
          const writable = await (handle as WritableHandle).createWritable()
          await writable.write(md)
          await writable.close()
          hooks.onFileName?.(fileName, '已另存到本机')
          return true
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return false
          // fall through to download
        }
      }
      downloadMarkdown(md, fileName)
      hooks.onFileName?.(fileName, '已下载')
      return true
    },
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
