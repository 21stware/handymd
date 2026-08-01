/**
 * handymd app shell — PWA Markdown opener / editor.
 */
import { mountAppEditor, type AppEditorApi } from './editor'
import './styles.css'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

const stage = $('stage')
const editorMount = $('editor')
const skeleton = $('skeleton')
const empty = $('empty')
const saveDot = $('save-dot')
const fileNameEl = $('file-name')
const fileMetaEl = $('file-meta')
const fileInput = $('file-input') as HTMLInputElement | null
const dropOverlay = $('drop-overlay')
const btnSave = $('btn-save')
const btnSaveAs = $('btn-save-as')
const btnInstall = $('btn-install')

let app: AppEditorApi | null = null
let appPromise: Promise<AppEditorApi> | null = null
let deferredInstall: BeforeInstallPromptEvent | null = null

// ——— Toast ———
let toastEl: HTMLDivElement | null = null
function toast(msg: string) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.setAttribute('role', 'status')
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  toastEl.classList.add('is-on')
  window.clearTimeout((toastEl as HTMLDivElement & { _t?: number })._t)
  ;(toastEl as HTMLDivElement & { _t?: number })._t = window.setTimeout(() => {
    toastEl?.classList.remove('is-on')
  }, 2200)
}

// ——— Editor bootstrap ———
async function ensureEditor(): Promise<AppEditorApi> {
  if (app) return app
  if (appPromise) return appPromise

  appPromise = (async () => {
    skeleton?.remove()
    empty?.setAttribute('hidden', '')
    if (editorMount) editorMount.hidden = false
    if (!editorMount) throw new Error('editor mount missing')
    app = await mountAppEditor(editorMount, {
      onSaveStatus: (status) => {
        if (!saveDot) return
        const map: Record<string, string> = {
          clean: 'clean',
          dirty: 'dirty',
          saving: 'saving',
          retrying: 'saving',
          offline: 'dirty',
        }
        saveDot.dataset.status = map[status] ?? 'clean'
      },
      onFileName: (name, meta) => {
        if (fileNameEl) fileNameEl.textContent = name
        if (fileMetaEl) fileMetaEl.textContent = meta
      },
    })
    return app
  })()

  try {
    return await appPromise
  } catch (err) {
    appPromise = null
    console.error(err)
    toast('编辑器加载失败')
    throw err
  }
}

// Auto-load on first paint — the app is an editor, no need to wait.
void ensureEditor()

// ——— File open ———
async function openFile(file: File, handle?: FileSystemFileHandle | null) {
  const md = await file.text()
  const p = await ensureEditor()
  p.openMarkdown(md, { name: file.name, handle: handle ?? null })
  p.focus()
  toast(`已打开 ${file.name}`)
}

async function pickFile() {
  const w = window as Window & {
    showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>
  }
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [handle] = await w.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Markdown',
            accept: {
              'text/markdown': ['.md', '.markdown', '.mdown'],
              'text/plain': ['.md', '.txt'],
            },
          },
        ],
        excludeAcceptAllOption: false,
      })
      const file = await handle.getFile()
      await openFile(file, handle)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }
  fileInput?.click()
}

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  await openFile(file, null)
  fileInput.value = ''
})

for (const id of ['btn-open', 'btn-empty-open'] as const) {
  $(id)?.addEventListener('click', () => void pickFile())
}

// ——— New / Save / Save As ———
$('btn-new')?.addEventListener('click', async () => {
  const p = await ensureEditor()
  p.openMarkdown('# untitled.md\n\n', { name: 'untitled.md', handle: null })
  p.focus()
  toast('已新建文稿')
})

btnSave?.addEventListener('click', async () => {
  const p = await ensureEditor()
  await p.saveToHandle()
  toast('已保存')
})

btnSaveAs?.addEventListener('click', async () => {
  const p = await ensureEditor()
  const ok = await p.saveAs()
  if (ok) toast('已另存')
})

$('btn-readonly')?.addEventListener('click', async () => {
  const p = await ensureEditor()
  const next = !p.getReadOnly()
  p.setReadOnly(next)
  toast(next ? '已进入只读' : '已退出只读')
})

// ——— Drag & drop ———
let dragDepth = 0
function isFileDrag(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return
  e.preventDefault()
  dragDepth++
  dropOverlay?.removeAttribute('hidden')
  dropOverlay?.setAttribute('aria-hidden', 'false')
})
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return
  e.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    dropOverlay?.setAttribute('hidden', '')
    dropOverlay?.setAttribute('aria-hidden', 'true')
  }
})
window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return
  e.preventDefault()
  dragDepth = 0
  dropOverlay?.setAttribute('hidden', '')
  dropOverlay?.setAttribute('aria-hidden', 'true')
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const ok =
    /\.(md|markdown|mdown|txt)$/i.test(file.name) ||
    file.type === 'text/markdown' ||
    file.type === 'text/plain' ||
    file.type === ''
  if (!ok) {
    toast('请拖入 Markdown 文件')
    return
  }
  void openFile(file, null)
})

// ——— PWA file_handlers — open .md via OS "Open with" ———
type LaunchParams = { files?: FileSystemFileHandle[] }
const launchQueue = (
  window as Window & {
    launchQueue?: { setConsumer: (cb: (params: LaunchParams) => void) => void }
  }
).launchQueue

if (launchQueue && typeof launchQueue.setConsumer === 'function') {
  launchQueue.setConsumer(async (params) => {
    const handles = params.files ?? []
    if (!handles.length) return
    const handle = handles[0]
    try {
      const file = await handle.getFile()
      await openFile(file, handle)
    } catch (err) {
      console.error('launchQueue open failed', err)
      toast('无法打开系统传入的文件')
    }
  })
}

// ——— PWA install prompt ———
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstall = e as BeforeInstallPromptEvent
  btnInstall?.removeAttribute('hidden')
})

btnInstall?.addEventListener('click', async () => {
  if (!deferredInstall) {
    toast('请使用浏览器菜单「安装应用」')
    return
  }
  await deferredInstall.prompt()
  const choice = await deferredInstall.userChoice
  if (choice.outcome === 'accepted') toast('已安装 — 可用系统打开 .md')
  deferredInstall = null
  btnInstall?.setAttribute('hidden', '')
})

window.addEventListener('appinstalled', () => {
  deferredInstall = null
  btnInstall?.setAttribute('hidden', '')
  toast('安装成功')
})

// ——— Service worker ———
if ('serviceWorker' in navigator) {
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        /* dev servers without sw.js are fine */
      })
    })
  }
}

// Keep stage focusable for keyboard
stage?.addEventListener('click', (e) => {
  if (e.target === stage) app?.focus()
})
