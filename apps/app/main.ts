/**
 * handymd writing app — immersive shell.
 *
 * No toolbar / sidebar. Interaction model:
 *   • Type immediately on a blank page
 *   • ⌘/Ctrl+O  open
 *   • ⌘/Ctrl+S  save
 *   • ⌘/Ctrl+⇧+S  save as
 *   • ⌘/Ctrl+N  new
 *   • Drag & drop .md
 *   • OS “Open with” via file_handlers
 */
import { mountAppEditor, type AppEditorApi } from './editor'
import './styles.css'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

const editorMount = $('editor')
const statusEl = $('status')
const fileInput = $('file-input') as HTMLInputElement | null
const dropOverlay = $('drop-overlay')

let app: AppEditorApi | null = null
let statusTimer = 0

// ——— Status (ephemeral, top center) ———
function showStatus(text: string, tone: 'neutral' | 'dirty' | 'ok' = 'neutral', ms = 1800) {
  if (!statusEl) return
  statusEl.hidden = false
  statusEl.textContent = text
  statusEl.dataset.tone = tone === 'neutral' ? '' : tone
  // force reflow so re-show animates
  void statusEl.offsetWidth
  statusEl.classList.add('is-on')
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    statusEl.classList.remove('is-on')
    window.setTimeout(() => {
      if (!statusEl.classList.contains('is-on')) statusEl.hidden = true
    }, 280)
  }, ms)
}

// ——— Toast (rare) ———
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
  }, 2000)
}

// ——— Bootstrap ———
async function ensureEditor(): Promise<AppEditorApi> {
  if (app) return app
  if (!editorMount) throw new Error('editor mount missing')

  app = await mountAppEditor(editorMount, {
    onSaveStatus: (status) => {
      if (status === 'dirty') showStatus('•', 'dirty', 1200)
      else if (status === 'saving' || status === 'retrying') showStatus('saving…', 'neutral', 1200)
      else if (status === 'clean') showStatus('saved', 'ok', 1400)
      else if (status === 'offline') showStatus('offline draft', 'dirty', 2200)
    },
    onFileName: (name) => {
      // Title bar is the only persistent chrome (OS window title).
      document.title = name.replace(/\.md$/i, '') || 'Untitled'
    },
  })
  return app
}

void ensureEditor().catch((err) => {
  console.error(err)
  toast('Failed to start editor')
})

// ——— File open ———
async function openFile(file: File, handle?: FileSystemFileHandle | null) {
  const md = await file.text()
  const p = await ensureEditor()
  p.openMarkdown(md, { name: file.name, handle: handle ?? null })
  p.focus()
  showStatus(file.name, 'ok', 1600)
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

// ——— Keyboard (primary UI) ———
function isMod(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey
}

window.addEventListener('keydown', (e) => {
  if (!isMod(e)) return
  const key = e.key.toLowerCase()

  // ⌘S save · ⌘⇧S save as
  if (key === 's') {
    e.preventDefault()
    void (async () => {
      const p = await ensureEditor()
      if (e.shiftKey) {
        const ok = await p.saveAs()
        if (ok) showStatus(p.getFileName(), 'ok')
      } else {
        const ok = await p.saveToHandle()
        if (ok) showStatus(p.hasHandle() ? 'saved' : p.getFileName(), 'ok')
      }
    })()
    return
  }

  // ⌘O open
  if (key === 'o') {
    e.preventDefault()
    void pickFile()
    return
  }

  // ⌘N new
  if (key === 'n') {
    e.preventDefault()
    void (async () => {
      const p = await ensureEditor()
      p.newDocument()
      showStatus('Untitled', 'neutral')
    })()
    return
  }
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
    toast('Drop a Markdown file')
    return
  }
  void openFile(file, null)
})

// ——— PWA file_handlers ———
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
    const handle = handles[0]!
    try {
      const file = await handle.getFile()
      await openFile(file, handle)
    } catch (err) {
      console.error('launchQueue open failed', err)
      toast('Could not open file')
    }
  })
}

// Capture install prompt silently (browser menu / OS install UI).
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
})

// ——— Service worker ———
if ('serviceWorker' in navigator) {
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
    })
  }
}
