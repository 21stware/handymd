/**
 * Desktop editor host — vault-backed persistence via Tauri commands.
 *
 * The SDK's own autosave (L4) is bypassed; we drive persistence from
 * onChange with our own debounce in main.ts so we control title derivation
 * and note-list reordering.
 */
import { TextSelection } from 'prosemirror-state'
import {
  createEditor,
  createShikiHighlighter,
  type HandyEditor,
} from '@21stware/handymd'
import '@21stware/handymd/style.css'

export type DesktopEditorApi = {
  editor: HandyEditor
  openMarkdown: (md: string) => void
  getMarkdown: () => string
  focus: () => void
  focusEnd: () => void
  destroy: () => Promise<void>
}

export type DesktopEditorHooks = {
  onChange?: (markdown: string) => void
  onReady?: () => void
}

export async function mountDesktopEditor(
  mount: HTMLElement,
  hooks: DesktopEditorHooks = {},
): Promise<DesktopEditorApi> {
  const dark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches

  // `setMarkdown` dispatches a doc-changing transaction, so the SDK reports it
  // as a change. Loading a note is not an edit: without this guard, merely
  // opening a note would save it and bump it to the top of the list.
  let programmatic = false

  const editor = createEditor({
    mount,
    content: '',
    highlight: createShikiHighlighter({ theme: dark ? 'github-dark' : 'github-light' }),
    onChange: (md) => {
      if (!programmatic) hooks.onChange?.(md)
    },
    onOpenLink: (href) => {
      const w = window as unknown as { __openExternal?: (href: string) => void }
      w.__openExternal?.(href)
    },
  })

  queueMicrotask(() => editor.focus())
  hooks.onReady?.()

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
    openMarkdown(md) {
      programmatic = true
      try {
        editor.setMarkdown(md)
      } finally {
        programmatic = false
      }
    },
    getMarkdown: () => editor.getMarkdown(),
    focus: () => editor.focus(),
    focusEnd,
    destroy: () => editor.destroy(),
  }
}
