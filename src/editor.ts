import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'

import { schema } from './schema'
import { docToMarkdown, markdownToDoc } from './markdown'
import { concealKey, concealPlugin, type ConcealMeta } from './conceal/plugin'
import { imePlugin } from './ime'
import { interactionsPlugin } from './interactions'
import { markdownKeymap } from './keymap'
import { normalizePlugin } from './normalize'
import { caretGuardPlugin } from './caret'
import { highlightPlugin, type CodeHighlighter } from './highlight'
import { Autosave, type AutosaveOptions, type SaveStatus } from './autosave'

/**
 * L1 编辑器生命周期状态机：
 *
 *   Loading → Ready        : load() 拿到 markdown 源文本，parse → doc，创建 EditorView
 *   Loading → Error        : 加载失败；Error → Loading : retry()
 *   Ready(Editable ⇄ ReadOnly) : setReadOnly()。ReadOnly 下 L3 全部强制 Concealed，
 *                                filterTransaction 拒绝写事务，链接/checkbox 展示仍工作
 *   Ready → Conflicted     : notifyRemote() 时本地有未保存改动
 *   Conflicted → Ready     : resolveConflict('local' | 'remote')
 *   Ready → Destroyed      : destroy()（flush 未保存内容后销毁 view）
 */

export type EditorPhase = 'loading' | 'ready' | 'error' | 'conflicted' | 'destroyed'

export interface HandyEditorOptions {
  /** 编辑器挂载点 */
  mount: HTMLElement
  /** 初始 markdown（与 load 二选一；都给时 load 优先） */
  content?: string
  /** 异步拉取 markdown 源文本 */
  load?: () => Promise<string> | string
  /** 提供后启用 L4 自动保存 */
  save?: (markdown: string) => Promise<unknown> | unknown
  /** L4 参数（防抖/退避等） */
  autosave?: Omit<AutosaveOptions, 'save' | 'onStatusChange'>
  readOnly?: boolean
  /** Concealed 链接被点击时的回调，默认 window.open */
  onOpenLink?: (href: string) => void
  onChange?: (markdown: string) => void
  onPhaseChange?: (phase: EditorPhase) => void
  onSaveStatusChange?: (status: SaveStatus, error?: unknown) => void
  /** 追加自定义 ProseMirror 插件 */
  plugins?: Plugin[]
  /** 是否启用 undo/redo，默认 true */
  history?: boolean
  /** 是否启用有序列表自动重编号，默认 true */
  normalizeOrderedLists?: boolean
  /**
   * 代码块语法高亮器（推荐 `createShikiHighlighter()`，接受 Promise，
   * resolve 前先渲染无高亮版本）
   */
  highlight?: CodeHighlighter | Promise<CodeHighlighter>
}

type EventMap = {
  phase: EditorPhase
  change: string
  saveStatus: SaveStatus
}

export class HandyEditor {
  view: EditorView | null = null
  autosave: Autosave | null = null

  private phaseValue: EditorPhase = 'loading'
  private readOnlyValue: boolean
  private readOnlyBeforeConflict = false
  private remoteMarkdown: string | null = null
  private lastLoadError: unknown = null
  private readonly opts: HandyEditorOptions
  private readonly listeners = new Map<keyof EventMap, Set<(payload: never) => void>>()

  constructor(options: HandyEditorOptions) {
    this.opts = options
    this.readOnlyValue = options.readOnly ?? false
    void this.init()
  }

  // ---- L1 phase ----

  get phase(): EditorPhase {
    return this.phaseValue
  }

  get loadError(): unknown {
    return this.lastLoadError
  }

  get saveStatus(): SaveStatus {
    return this.autosave?.status ?? 'clean'
  }

  get readOnly(): boolean {
    return this.readOnlyValue
  }

  private setPhase(phase: EditorPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    this.opts.onPhaseChange?.(phase)
    this.emit('phase', phase)
  }

  private async init(): Promise<void> {
    let content = this.opts.content ?? ''
    if (this.opts.load) {
      this.setPhase('loading')
      try {
        content = await this.opts.load()
      } catch (err) {
        this.lastLoadError = err
        this.setPhase('error')
        return
      }
    }
    if (this.phaseValue === 'destroyed') return
    this.createView(content)
    this.setPhase('ready')
  }

  /** Error → Loading：重试加载 */
  retry(): void {
    if (this.phaseValue !== 'error') return
    this.lastLoadError = null
    void this.init()
  }

  // ---- view ----

  private createView(content: string): void {
    const doc = markdownToDoc(content)

    const plugins: Plugin[] = [
      concealPlugin({ readOnly: this.readOnlyValue }),
      imePlugin(),
      interactionsPlugin({ onOpenLink: this.opts.onOpenLink }),
      caretGuardPlugin(),
      markdownKeymap(),
    ]
    if (this.opts.highlight) plugins.push(highlightPlugin(this.opts.highlight))
    if (this.opts.history !== false) {
      plugins.push(history())
      plugins.push(
        keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      )
    }
    plugins.push(
      keymap({
        'Mod-s': () => {
          void this.flush()
          return true
        },
      }),
    )
    plugins.push(keymap(baseKeymap))
    if (this.opts.normalizeOrderedLists !== false) plugins.push(normalizePlugin())
    // 只读锁：L2 的 filterTransaction 在只读态拒绝一切写事务
    // （编程式替换如 setMarkdown / 冲突解决带 programmatic meta，放行）
    plugins.push(
      new Plugin({
        filterTransaction: (tr) =>
          !tr.docChanged || !this.readOnlyValue || tr.getMeta('handymd-programmatic') === true,
      }),
    )
    if (this.opts.plugins) plugins.push(...this.opts.plugins)

    const state = EditorState.create({ doc, plugins })

    this.opts.mount.classList.add('handymd')
    this.view = new EditorView(this.opts.mount, {
      state,
      editable: () => !this.readOnlyValue && this.phaseValue === 'ready',
      dispatchTransaction: (tr) => {
        const view = this.view
        if (!view) return
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          this.autosave?.markDirty()
          if (this.opts.onChange || this.listeners.get('change')?.size) {
            const md = docToMarkdown(newState.doc)
            this.opts.onChange?.(md)
            this.emit('change', md)
          }
        }
      },
      handleDOMEvents: {
        blur: () => {
          this.autosave?.flush().catch(() => {})
          return false
        },
      },
    })

    if (this.opts.save) {
      this.autosave = new Autosave(() => this.getMarkdown(), {
        save: this.opts.save,
        ...this.opts.autosave,
        onStatusChange: (status, error) => {
          this.opts.onSaveStatusChange?.(status, error)
          this.emit('saveStatus', status)
        },
      })
    }
  }

  // ---- content ----

  getMarkdown(): string {
    return this.view ? docToMarkdown(this.view.state.doc) : (this.opts.content ?? '')
  }

  setMarkdown(markdown: string, options: { addToHistory?: boolean } = {}): void {
    const view = this.view
    if (!view) return
    const doc = markdownToDoc(markdown)
    let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    tr = tr.setSelection(TextSelection.atStart(tr.doc))
    if (options.addToHistory === false) tr.setMeta('addToHistory', false)
    // 绕过只读锁（编程式替换不算用户写入）
    tr.setMeta('handymd-programmatic', true)
    view.dispatch(tr)
  }

  focus(): void {
    this.view?.focus()
  }

  // ---- readOnly ----

  setReadOnly(readOnly: boolean): void {
    if (this.readOnlyValue === readOnly || !this.view) {
      this.readOnlyValue = readOnly
      return
    }
    this.readOnlyValue = readOnly
    const meta: ConcealMeta = { readOnly }
    this.view.dispatch(this.view.state.tr.setMeta(concealKey, meta))
  }

  // ---- conflict ----

  /**
   * 远端版本变化时调用。本地干净 → 直接吃掉远端；本地有未保存改动 → Conflicted，
   * 编辑冻结，等 resolveConflict。
   */
  notifyRemote(remoteMarkdown: string): void {
    if (this.phaseValue !== 'ready' || !this.view) return
    if (remoteMarkdown === this.getMarkdown()) return
    if (this.saveStatus === 'clean') {
      this.setMarkdown(remoteMarkdown, { addToHistory: false })
      return
    }
    this.remoteMarkdown = remoteMarkdown
    this.readOnlyBeforeConflict = this.readOnlyValue
    this.setReadOnly(true)
    this.setPhase('conflicted')
  }

  get remoteConflict(): string | null {
    return this.remoteMarkdown
  }

  resolveConflict(choice: 'local' | 'remote'): void {
    if (this.phaseValue !== 'conflicted') return
    const remote = this.remoteMarkdown
    this.remoteMarkdown = null
    this.setPhase('ready')
    this.setReadOnly(this.readOnlyBeforeConflict)
    if (choice === 'remote' && remote !== null) {
      this.setMarkdown(remote, { addToHistory: false })
      this.autosave?.markClean()
    } else {
      // 保留本地 → 立即把本地版本推上去
      this.autosave?.markDirty()
      this.autosave?.flush().catch(() => {})
    }
  }

  // ---- persistence ----

  flush(): Promise<void> {
    return this.autosave?.flush() ?? Promise.resolve()
  }

  // ---- events ----

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler as (payload: never) => void)
    return () => set!.delete(handler as (payload: never) => void)
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as (p: EventMap[K]) => void)(payload))
  }

  // ---- teardown ----

  /** unmount：flush 未保存内容后 destroy */
  async destroy(): Promise<void> {
    if (this.phaseValue === 'destroyed') return
    try {
      await this.flush()
    } catch {
      // 离线时也要完成销毁；内容可由调用方在 destroy 前自行 getMarkdown 兜底
    }
    this.autosave?.destroy()
    this.autosave = null
    this.view?.destroy()
    this.view = null
    this.setPhase('destroyed')
  }
}

export function createEditor(options: HandyEditorOptions): HandyEditor {
  return new HandyEditor(options)
}
