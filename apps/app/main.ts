/**
 * handymd writing app — immersive shell.
 *
 *   • Type on blank paper
 *   • ⌘/Ctrl+O open · ⌘/Ctrl+S save · ⌘/Ctrl+⇧+S save as · ⌘/Ctrl+N new
 *   • ⌘/Ctrl+, preferences
 *   • Drag & drop .md · OS file_handlers
 *   • Click empty lower area → caret at end
 */
import { mountAppEditor, type AppEditorApi } from './editor'
import {
  applySettings,
  loadSettings,
  saveSettings,
  type AppSettings,
  type FontId,
  type ThemeId,
} from './settings'
import './styles.css'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

const scrollRoot = $('scroll-root')
const editorMount = $('editor')
const statusEl = $('status')
const fileInput = $('file-input') as HTMLInputElement | null
const dropOverlay = $('drop-overlay')
const settingsBtn = $('settings-btn') as HTMLButtonElement | null
const settingsPanel = $('settings-panel')
const settingsBackdrop = $('settings-backdrop')
const setTheme = $('set-theme') as HTMLSelectElement | null
const setFont = $('set-font') as HTMLSelectElement | null
const setSize = $('set-size') as HTMLInputElement | null
const setLeading = $('set-leading') as HTMLInputElement | null
const setWidth = $('set-width') as HTMLInputElement | null
const setSizeVal = $('set-size-val')
const setLeadingVal = $('set-leading-val')
const setWidthVal = $('set-width-val')

let app: AppEditorApi | null = null
let statusTimer = 0
let settings: AppSettings = loadSettings()

// Apply prefs before first paint of the editor
applySettings(settings)
syncSettingsForm()

// ——— Status ———
function showStatus(text: string, tone: 'neutral' | 'dirty' | 'ok' = 'neutral', ms = 1800) {
  if (!statusEl) return
  statusEl.hidden = false
  statusEl.textContent = text
  statusEl.dataset.tone = tone === 'neutral' ? '' : tone
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

// ——— Settings UI ———
function syncSettingsForm() {
  if (setTheme) setTheme.value = settings.theme
  if (setFont) setFont.value = settings.font
  if (setSize) setSize.value = String(settings.fontSize)
  if (setLeading) setLeading.value = String(settings.lineHeight)
  if (setWidth) setWidth.value = String(settings.contentWidth)
  if (setSizeVal) setSizeVal.textContent = String(settings.fontSize)
  if (setLeadingVal) setLeadingVal.textContent = settings.lineHeight.toFixed(2)
  if (setWidthVal) setWidthVal.textContent = String(settings.contentWidth)
}

let settingsSaveTimer = 0
function commitSettings(next: AppSettings, opts: { persist?: boolean } = {}) {
  settings = next
  applySettings(settings)
  syncSettingsForm()
  // Persist debounced — sliders fire many input events
  if (opts.persist === false) return
  window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => saveSettings(settings), 120)
}

function openSettings() {
  syncSettingsForm()
  settingsPanel?.removeAttribute('hidden')
  settingsBackdrop?.removeAttribute('hidden')
  settingsBtn?.setAttribute('aria-expanded', 'true')
  setTheme?.focus()
}

function closeSettings() {
  settingsPanel?.setAttribute('hidden', '')
  settingsBackdrop?.setAttribute('hidden', '')
  settingsBtn?.setAttribute('aria-expanded', 'false')
}

function toggleSettings() {
  if (settingsPanel?.hasAttribute('hidden')) openSettings()
  else closeSettings()
}

settingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleSettings()
})
settingsBackdrop?.addEventListener('click', () => closeSettings())

setTheme?.addEventListener('change', () => {
  commitSettings({ ...settings, theme: setTheme.value as ThemeId })
})
setFont?.addEventListener('change', () => {
  commitSettings({ ...settings, font: setFont.value as FontId })
})
setSize?.addEventListener('input', () => {
  const fontSize = Number(setSize.value)
  if (setSizeVal) setSizeVal.textContent = String(fontSize)
  commitSettings({ ...settings, fontSize })
})
setLeading?.addEventListener('input', () => {
  const lineHeight = Number(setLeading.value)
  if (setLeadingVal) setLeadingVal.textContent = lineHeight.toFixed(2)
  commitSettings({ ...settings, lineHeight })
})
setWidth?.addEventListener('input', () => {
  const contentWidth = Number(setWidth.value)
  if (setWidthVal) setWidthVal.textContent = String(contentWidth)
  commitSettings({ ...settings, contentWidth })
})
// Flush prefs when the panel closes / page hides
window.addEventListener('pagehide', () => saveSettings(settings))

// ——— Bootstrap editor ———
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
      document.title = name.replace(/\.md$/i, '') || 'Untitled'
    },
  })
  return app
}

void ensureEditor().catch((err) => {
  console.error(err)
  toast('Failed to start editor')
})

// ——— Click empty lower / side of page → caret at end ———
function isInsideProseMirror(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest('.ProseMirror')
}

function isChromeClick(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  return !!(
    el.closest('.settings-panel') ||
    el.closest('.settings-btn') ||
    el.closest('.settings-backdrop') ||
    el.closest('.drop-overlay') ||
    el.closest('.status')
  )
}

scrollRoot?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (isChromeClick(e.target)) return
  // Clicks on text / widgets inside PM keep default PM positioning.
  if (isInsideProseMirror(e.target)) return

  // Empty padding under the column, or gutters of the scroll surface.
  e.preventDefault()
  void ensureEditor().then((p) => p.focusEnd())
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

// ——— Keyboard ———
function isMod(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey
}

window.addEventListener('keydown', (e) => {
  // Escape closes settings
  if (e.key === 'Escape' && settingsPanel && !settingsPanel.hasAttribute('hidden')) {
    e.preventDefault()
    closeSettings()
    return
  }

  if (!isMod(e)) return
  const key = e.key.toLowerCase()

  // ⌘, preferences
  if (key === ',' || e.code === 'Comma') {
    e.preventDefault()
    toggleSettings()
    return
  }

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

  if (key === 'o') {
    e.preventDefault()
    void pickFile()
    return
  }

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

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
})

if ('serviceWorker' in navigator) {
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
    })
  }
}

