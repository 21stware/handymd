/**
 * Landing page shell — intentionally tiny.
 * Editor SDK is dynamic-imported only when the playground is needed.
 */

type PlaygroundApi = import('./playground').PlaygroundApi

const SNIPPETS: Record<string, string> = {
  bun: 'bun add @21stware/handymd\nbun add mermaid   # 可选：mermaid 图表',
  npm: 'npm install @21stware/handymd\nnpm install mermaid   # optional: diagrams',
  code: `import { createEditor, createMermaidRenderer } from '@21stware/handymd'
import '@21stware/handymd/style.css'

const editor = createEditor({
  mount: document.getElementById('editor')!,
  content: '# Hello handymd\\n',
  diagram: createMermaidRenderer(), // 可选
})`,
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

const nav = $('nav')
const dropOverlay = $('drop-overlay')
const fileInput = $('file-input') as HTMLInputElement | null
const editorStage = $('editor-stage')
const editorMount = $('editor')
const saveDot = $('save-dot')
const fileNameEl = $('file-name')
const fileMetaEl = $('file-meta')
const codeContent = $('code-content')

let playground: PlaygroundApi | null = null
let playgroundPromise: Promise<PlaygroundApi> | null = null

// ——— Tiny toast ———
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

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

// ——— Nav scroll state ———
function onScroll() {
  if (!nav) return
  nav.classList.toggle('is-scrolled', window.scrollY > 8)
}
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

// ——— Install chip copy ———
$('copy-install')?.addEventListener('click', async (e) => {
  const el = e.currentTarget as HTMLElement
  const ok = await copyText('bun add @21stware/handymd')
  if (ok) {
    el.classList.add('is-copied')
    el.innerHTML = '<span>✓</span> 安装命令已复制 <span class="copy-mark">完成</span>'
    toast('安装命令已复制')
    setTimeout(() => {
      el.classList.remove('is-copied')
      el.innerHTML =
        '<span>$</span> bun add @21stware/handymd <span class="copy-mark">复制</span>'
    }, 1600)
  }
})

// ——— Code tabs ———
const codeTabs = document.querySelectorAll<HTMLButtonElement>('.code-tab')
codeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const key = tab.dataset.tab ?? 'bun'
    codeTabs.forEach((t) => {
      const on = t === tab
      t.classList.toggle('is-active', on)
      t.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    if (codeContent) codeContent.textContent = SNIPPETS[key] ?? SNIPPETS.bun
  })
})
$('btn-copy-code')?.addEventListener('click', async () => {
  const text = codeContent?.textContent ?? ''
  if (await copyText(text)) toast('代码已复制')
})

// ——— Lazy playground ———
async function ensurePlayground(): Promise<PlaygroundApi> {
  if (playground) return playground
  if (playgroundPromise) return playgroundPromise

  playgroundPromise = (async () => {
    editorStage?.classList.add('is-loading')
    // Editor theme only when playground is needed (~3–5 KB)
    if (!document.querySelector('link[data-hm-style]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = './handymd.css'
      link.dataset.hmStyle = '1'
      document.head.appendChild(link)
    }
    const { mountPlayground } = await import('./playground')
    if (!editorMount) throw new Error('editor mount missing')
    editorMount.hidden = false

    const api = await mountPlayground(editorMount, {
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
      onReady: () => {
        editorStage?.classList.add('is-ready')
        editorStage?.classList.remove('is-loading')
      },
    })
    playground = api
    return api
  })()

  try {
    return await playgroundPromise
  } catch (err) {
    playgroundPromise = null
    console.error(err)
    toast('编辑器加载失败')
    throw err
  }
}

function scrollToPlayground() {
  $('playground')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// Load when playground enters viewport (or hash/CTA)
const io =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            void ensurePlayground()
            io?.disconnect()
          }
        },
        { rootMargin: '120px', threshold: 0.05 },
      )
    : null

if (editorStage && io) io.observe(editorStage)
else void ensurePlayground()

if (location.hash === '#playground') {
  void ensurePlayground()
}

$('btn-try')?.addEventListener('click', () => {
  void ensurePlayground().then((p) => {
    scrollToPlayground()
    requestAnimationFrame(() => p.focus())
  })
})
$('btn-focus-editor')?.addEventListener('click', () => {
  void ensurePlayground().then((p) => p.focus())
})
$('btn-readonly')?.addEventListener('click', async () => {
  const p = await ensurePlayground()
  const next = !p.getReadOnly()
  p.setReadOnly(next)
  toast(next ? '已进入只读' : '已退出只读')
})
$('btn-new')?.addEventListener('click', async () => {
  const p = await ensurePlayground()
  p.openMarkdown('# Untitled\n\n', { name: 'untitled.md', handle: null })
  p.focus()
  toast('已新建文稿')
})
$('btn-save')?.addEventListener('click', async () => {
  const p = await ensurePlayground()
  await p.saveToHandle()
  toast('已保存')
})

window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
  event.preventDefault()
  void ensurePlayground().then(async (p) => {
    await p.saveToHandle()
    toast('已保存')
  })
})

// ——— File open (picker / drag / PWA launchQueue) ———
async function readFileAsText(file: File): Promise<string> {
  return file.text()
}

async function openFile(file: File, handle?: FileSystemFileHandle | null) {
  const md = await readFileAsText(file)
  scrollToPlayground()
  const p = await ensurePlayground()
  p.openMarkdown(md, { name: file.name, handle: handle ?? null })
  p.focus()
  toast(`已打开 ${file.name}`)
}

async function pickFile() {
  // File System Access API (Chromium) — keeps a handle for true save
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
      // user cancel
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

for (const id of ['btn-open', 'btn-open-hero', 'btn-open-2'] as const) {
  $(id)?.addEventListener('click', () => {
    void pickFile()
  })
}

// Drag & drop anywhere on the page
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

// PWA file_handlers — open .md via OS "Open with"
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

// Landing is not installable as an editor PWA (that lives at ./app/).
// Optional site SW: offline shell for docs only; must not claim /app/*.
if ('serviceWorker' in navigator) {
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        /* dev servers without sw.js are fine */
      })
    })
  }
}

// Prefetch playground chunk on idle after first paint
const ric =
  window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 800) as unknown as number)
ric(() => {
  void import('./playground')
})
