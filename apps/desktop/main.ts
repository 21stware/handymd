/**
 * Desktop shell — vault.mdb persistence via Tauri commands.
 *
 * Layout: sidebar (search + note list) + paper (topbar + editor).
 * Storage: SQLite vault.mdb at iCloud Drive container (fallback ~/Library/handymd).
 */
import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { confirm, save } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { mountDesktopEditor, type DesktopEditorApi } from './editor'

type Note = {
  id: string
  title: string
  preview: string
  updated_at: number
  pinned: boolean
}

type SaveState = 'clean' | 'dirty' | 'saving'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

const mainEl = document.querySelector<HTMLElement>('.main')
const scrollRoot = $('scroll-root')
const editorMount = $('editor')
const editorEmpty = $('editor-empty')
const noteListEl = $('note-list')
const listEmptyEl = $('list-empty')
const searchInput = $('search-input') as HTMLInputElement | null
const searchClear = $('search-clear') as HTMLButtonElement | null
const newBtn = $('new-btn') as HTMLButtonElement | null
const pinBtn = $('pin-btn') as HTMLButtonElement | null
const exportBtn = $('export-btn') as HTMLButtonElement | null
const deleteBtn = $('delete-btn') as HTMLButtonElement | null
const statusEl = $('status')
const saveDotEl = $('save-dot')
const footCountEl = $('foot-count')
const vaultBadgeEl = $('vault-badge')
const vaultLabelEl = $('vault-label')

let editor: DesktopEditorApi | null = null
let notes: Note[] = []
let visible: Note[] = []
let activeId: string | null = null
let query = ''
let statusTimer = 0

// ——— Toast ———

function showStatus(text: string, tone: 'neutral' | 'dirty' | 'ok' = 'neutral', ms = 1400) {
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
    }, 240)
  }, ms)
}

function setSaveState(state: SaveState) {
  if (saveDotEl) {
    saveDotEl.dataset.state = state
    saveDotEl.title = state === 'clean' ? '已保存' : state === 'saving' ? '保存中…' : '未保存'
  }
}

// ——— Markdown helpers ———

/** Strip block prefixes and inline markers so list/preview text reads as prose. */
function plainLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|==|`/g, '')
    .trim()
}

function deriveTitle(md: string): string {
  for (const line of md.split('\n')) {
    const t = plainLine(line)
    if (t) return t.slice(0, 80)
  }
  return ''
}

function previewFromMarkdown(md: string, title: string): string {
  const titleNorm = title.trim()
  const parts: string[] = []
  for (const line of md.split('\n')) {
    const t = plainLine(line)
    if (!t) continue
    if (parts.length === 0 && titleNorm && t === titleNorm) continue
    parts.push(t)
    if (parts.join(' ').length >= 100) break
  }
  const s = parts.join(' ')
  return s.length > 100 ? `${s.slice(0, 100)}…` : s
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= startOfToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (t >= startOfToday - 86_400_000) return '昨天'
  if (t >= startOfToday - 6 * 86_400_000) return d.toLocaleDateString('zh-CN', { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }
  return d.toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' })
}

function formatFullTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ——— Persistence (debounced, note-scoped) ———

// The pending job carries its own note id: a debounce that fires *after* the
// user switched notes must not write note A's text into note B.
let pending: { id: string; md: string } | null = null
let saveTimer = 0

function scheduleSave(md: string) {
  if (!activeId) return
  pending = { id: activeId, md }
  setSaveState('dirty')
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), 500)
}

async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer)
  const job = pending
  pending = null
  if (!job) return
  setSaveState('saving')
  const title = deriveTitle(job.md)
  try {
    await invoke('update_note', { id: job.id, content: job.md, title })
    const note = notes.find((n) => n.id === job.id)
    if (note) {
      note.title = title
      note.preview = previewFromMarkdown(job.md, title)
      note.updated_at = Math.floor(Date.now() / 1000)
      sortNotes()
      renderList()
      renderTopbar()
    }
    setSaveState('clean')
  } catch (err) {
    console.error('update_note failed', err)
    setSaveState('dirty')
    showStatus('保存失败', 'dirty', 1800)
  }
}

function sortNotes() {
  notes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at)
}

// ——— Rendering ———

function matchesQuery(n: Note): boolean {
  if (!query) return true
  const hay = `${n.title}\n${n.preview}`.toLowerCase()
  return hay.includes(query)
}

function sectionHeader(label: string): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'list-section'
  li.textContent = label
  return li
}

function renderList() {
  if (!noteListEl) return
  visible = notes.filter(matchesQuery)

  // Pinned notes get their own labelled group; a search result is a flat list.
  const grouped = !query && visible.some((n) => n.pinned) && visible.some((n) => !n.pinned)
  let section: 'pinned' | 'rest' | null = null

  noteListEl.replaceChildren()
  for (const n of visible) {
    if (grouped) {
      const want = n.pinned ? 'pinned' : 'rest'
      if (want !== section) {
        section = want
        noteListEl.appendChild(sectionHeader(want === 'pinned' ? '置顶' : '笔记'))
      }
    }
    const li = document.createElement('li')
    li.className = 'note-item'
    if (n.id === activeId) li.classList.add('is-active')
    if (n.pinned) li.classList.add('is-pinned')
    li.dataset.id = n.id

    const title = document.createElement('span')
    title.className = 'note-title'
    if (n.title) {
      title.textContent = n.title
    } else {
      title.textContent = '无标题'
      title.classList.add('is-untitled')
    }

    const meta = document.createElement('span')
    meta.className = 'note-meta'
    meta.title = formatFullTime(n.updated_at)
    meta.textContent = formatTime(n.updated_at)

    const preview = document.createElement('span')
    preview.className = 'note-preview'
    preview.textContent = n.preview || ''

    li.append(title, meta, preview)

    li.addEventListener('mousedown', (e) => {
      if (e.button === 0) void openNote(n.id)
    })
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      void openNote(n.id)
      openNoteMenu(n, e.clientX, e.clientY)
    })
    noteListEl.appendChild(li)
  }

  if (listEmptyEl) {
    if (visible.length > 0) {
      listEmptyEl.hidden = true
    } else {
      listEmptyEl.hidden = false
      listEmptyEl.textContent = query ? `没有匹配「${query}」的笔记` : '还没有笔记，⌘N 新建一篇'
    }
  }

  if (footCountEl) {
    footCountEl.textContent = query
      ? `${visible.length} / ${notes.length} 篇`
      : `${notes.length} 篇笔记`
  }
}

function renderTopbar() {
  const note = notes.find((n) => n.id === activeId) ?? null
  const has = note !== null
  for (const btn of [pinBtn, exportBtn, deleteBtn]) {
    if (btn) btn.disabled = !has
  }
  if (pinBtn) {
    pinBtn.dataset.on = note?.pinned ? 'true' : 'false'
    pinBtn.title = note?.pinned ? '取消置顶 ⌘⇧P' : '置顶 ⌘⇧P'
  }
  if (editorEmpty) editorEmpty.hidden = has
}

// ——— Note operations ———

async function refreshVaultInfo() {
  try {
    const info = await invoke<{ path: string; icloud: boolean }>('vault_info')
    if (vaultLabelEl) vaultLabelEl.textContent = info.icloud ? 'iCloud' : '本地'
    if (vaultBadgeEl) {
      vaultBadgeEl.dataset.icloud = info.icloud ? 'true' : 'false'
      vaultBadgeEl.title = info.path
    }
  } catch (err) {
    console.error('vault_info failed', err)
  }
}

async function loadNotes() {
  notes = await invoke<Note[]>('list_notes')
  sortNotes()
  renderList()
}

async function openNote(id: string) {
  if (id === activeId) return
  await flushSave()
  const note = await invoke<{ id: string; content: string; updated_at: number }>('get_note', { id })
  activeId = id
  const api = await ensureEditor()
  api.openMarkdown(note.content)
  setSaveState('clean')
  renderList()
  renderTopbar()
}

async function createNote() {
  await flushSave()
  const note = await invoke<Note>('create_note')
  notes.unshift(note)
  activeId = note.id
  const api = await ensureEditor()
  api.openMarkdown('')
  api.focus()
  setSaveState('clean')
  sortNotes()
  renderList()
  renderTopbar()
}

async function duplicateNote(source: Note) {
  await flushSave()
  const { content } = await invoke<{ content: string }>('get_note', { id: source.id })
  const copy = await invoke<Note>('create_note')
  const title = deriveTitle(content) || '无标题'
  await invoke('update_note', { id: copy.id, content, title })
  await loadNotes()
  activeId = copy.id
  const api = await ensureEditor()
  api.openMarkdown(content)
  renderList()
  renderTopbar()
  showStatus('已复制笔记', 'ok', 1200)
}

async function deleteNote(note: Note) {
  const label = note.title || '这篇无标题笔记'
  const ok = await confirm(`删除「${label}」？此操作无法撤销。`, {
    title: '删除笔记',
    kind: 'warning',
    okLabel: '删除',
    cancelLabel: '取消',
  })
  if (!ok) return

  // Drop any queued write for this note so the debounce can't resurrect it.
  if (pending?.id === note.id) pending = null
  await invoke('delete_note', { id: note.id })

  const idx = notes.findIndex((n) => n.id === note.id)
  notes = notes.filter((n) => n.id !== note.id)
  if (activeId === note.id) {
    activeId = null
    const next = notes[Math.min(idx, notes.length - 1)]
    renderList()
    if (next) {
      await openNote(next.id)
    } else {
      const api = await ensureEditor()
      api.openMarkdown('')
      renderTopbar()
    }
  } else {
    renderList()
  }
  renderTopbar()
  showStatus('已删除', 'neutral', 1200)
}

async function togglePin(note: Note) {
  const next = !note.pinned
  await invoke('set_note_pinned', { id: note.id, pinned: next })
  note.pinned = next
  sortNotes()
  renderList()
  renderTopbar()
  showStatus(next ? '已置顶' : '已取消置顶', 'neutral', 1100)
}

function activeNote(): Note | null {
  return notes.find((n) => n.id === activeId) ?? null
}

// ——— Export ———

function safeFileName(title: string): string {
  return (title || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

async function exportAs(format: 'pdf' | 'md') {
  const api = await ensureEditor()
  await flushSave()
  const md = api.getMarkdown()
  const title = deriveTitle(md)

  const path = await save({
    defaultPath: `${safeFileName(title)}.${format}`,
    filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }],
  })
  if (!path) return

  showStatus('导出中…', 'neutral', 2400)
  try {
    if (format === 'pdf') await invoke('export_pdf', { markdown: md, title, path })
    else await invoke('export_markdown', { markdown: md, path })
    showStatus(format === 'pdf' ? '已导出 PDF' : '已导出 Markdown', 'ok', 1600)
  } catch (err) {
    console.error('export failed', err)
    const msg = err instanceof Error ? err.message : String(err)
    showStatus(`导出失败：${msg.slice(0, 48)}`, 'dirty', 2800)
  }
}

// ——— Native context menus (Tauri / OS chrome) ———

type MenuEntry =
  | { label: string; accelerator?: string; run: () => void }
  | 'sep'

async function popupMenu(entries: MenuEntry[], x: number, y: number): Promise<void> {
  const items = await Promise.all(
    entries.map(async (entry) => {
      if (entry === 'sep') return PredefinedMenuItem.new({ item: 'Separator' })
      return MenuItem.new({
        text: entry.label,
        accelerator: entry.accelerator,
        action: () => entry.run(),
      })
    }),
  )
  const menu = await Menu.new({ items })
  await menu.popup(new LogicalPosition(x, y))
}

function openNoteMenu(note: Note, x: number, y: number) {
  void popupMenu(
    [
      {
        label: note.pinned ? '取消置顶' : '置顶',
        accelerator: 'CmdOrCtrl+Shift+P',
        run: () => void togglePin(note),
      },
      { label: '复制笔记', run: () => void duplicateNote(note) },
      'sep',
      {
        label: '导出 PDF…',
        accelerator: 'CmdOrCtrl+Shift+E',
        run: () => void exportAs('pdf'),
      },
      { label: '导出 Markdown…', run: () => void exportAs('md') },
      'sep',
      { label: '删除', run: () => void deleteNote(note) },
    ],
    x,
    y,
  ).catch((err) => console.error('menu failed', err))
}

// ——— Editor host ———

async function ensureEditor(): Promise<DesktopEditorApi> {
  if (editor) return editor
  if (!editorMount) throw new Error('editor mount missing')
  editor = await mountDesktopEditor(editorMount, {
    onChange: (md) => scheduleSave(md),
  })
  return editor
}

// expose external link opener for the editor host (kept out of editor.ts so
// the host stays Tauri-agnostic and reusable).
;(window as unknown as { __openExternal?: (href: string) => void }).__openExternal = (href) => {
  void openUrl(href).catch((err) => console.error('open external failed', err))
}

// ——— Wiring ———

newBtn?.addEventListener('click', () => void createNote())
deleteBtn?.addEventListener('click', () => {
  const n = activeNote()
  if (n) void deleteNote(n)
})
pinBtn?.addEventListener('click', () => {
  const n = activeNote()
  if (n) void togglePin(n)
})
exportBtn?.addEventListener('click', () => {
  const rect = exportBtn.getBoundingClientRect()
  void popupMenu(
    [
      {
        label: '导出 PDF…',
        accelerator: 'CmdOrCtrl+Shift+E',
        run: () => void exportAs('pdf'),
      },
      { label: '导出 Markdown…', run: () => void exportAs('md') },
    ],
    rect.left,
    rect.bottom + 4,
  ).catch((err) => console.error('menu failed', err))
})

searchInput?.addEventListener('input', () => {
  query = searchInput.value.trim().toLowerCase()
  if (searchClear) searchClear.hidden = query.length === 0
  renderList()
})
searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    clearSearch()
  }
})
searchClear?.addEventListener('click', () => clearSearch())

function clearSearch() {
  if (!searchInput) return
  searchInput.value = ''
  query = ''
  if (searchClear) searchClear.hidden = true
  renderList()
  void ensureEditor().then((api) => api.focus())
}

function step(delta: number) {
  if (visible.length === 0) return
  const i = visible.findIndex((n) => n.id === activeId)
  const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
  if (next && next.id !== activeId) void openNote(next.id)
}

// ⌘⌫ deliberately stays out of this list: it belongs to the editor (delete to
// line start), and deleting a note should take a deliberate click.
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const key = e.key.toLowerCase()

  if (key === 'n' && !e.shiftKey) {
    e.preventDefault()
    void createNote()
  } else if (key === 'f' && !e.shiftKey) {
    e.preventDefault()
    searchInput?.focus()
    searchInput?.select()
  } else if (key === 'e' && e.shiftKey) {
    e.preventDefault()
    void exportAs('pdf')
  } else if (key === 'p' && e.shiftKey) {
    e.preventDefault()
    const n = activeNote()
    if (n) void togglePin(n)
  } else if (key === 's' && !e.shiftKey) {
    e.preventDefault()
    void flushSave()
  } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    step(e.key === 'ArrowDown' ? 1 : -1)
  }
})

// Hairline under the topbar only once content scrolls beneath it.
scrollRoot?.addEventListener('scroll', () => {
  mainEl?.classList.toggle('is-scrolled', (scrollRoot.scrollTop ?? 0) > 2)
})

// Clicking the paper margin puts the caret at the end, like a real page.
scrollRoot?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (e.target instanceof Element && e.target.closest('.ProseMirror')) return
  e.preventDefault()
  void ensureEditor().then((api) => api.focusEnd())
})

// Flush before the window goes away so the last keystrokes survive.
window.addEventListener('beforeunload', () => void flushSave())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushSave()
})

void (async () => {
  await refreshVaultInfo()
  await loadNotes()
  await ensureEditor()
  if (notes.length > 0) {
    await openNote(notes[0].id)
  } else {
    await createNote()
  }
  renderTopbar()
})().catch((err) => {
  console.error(err)
  showStatus('启动失败', 'dirty', 2400)
})
