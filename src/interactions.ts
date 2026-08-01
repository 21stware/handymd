import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { concealKey, type ConcealState } from './conceal/plugin'
import type { ElementRange } from './elements'
import { spansIntersect } from './elements'

/**
 * L3 Concealed 态的 Interactive 子状态：
 *
 * - 链接在 Concealed 态单击是"打开"（mousedown 拦截，不移动光标）；
 *   要进入编辑必须用键盘移入，或 Cmd/Ctrl+点击。这是 Bear 区别于普通编辑器的手感。
 * - checkbox widget 点击切换 `[ ]` ↔ `[x]`（直接改源码文本，不动 selection）。
 *   readOnly 下该写事务会被 L1 的 filterTransaction 拒绝，展示仍然工作。
 */

export interface InteractionOptions {
  /** 默认 window.open(href, '_blank') */
  onOpenLink?: (href: string) => void
}

function findLinkAt(st: ConcealState, pos: number): ElementRange | null {
  for (const block of st.blocks) {
    if (pos < block.pos || pos > block.pos + block.size) continue
    for (const el of block.elements) {
      if (el.kind === 'link' && pos >= el.from && pos <= el.to) return el
    }
  }
  return null
}

function toggleTodoAt(view: EditorView, dom: Node): boolean {
  const st = concealKey.getState(view.state)
  if (!st) return false
  let pos: number
  try {
    pos = view.posAtDOM(dom, 0)
  } catch {
    return false
  }
  for (const block of st.blocks) {
    if (pos < block.pos || pos > block.pos + block.size) continue
    for (const el of block.elements) {
      if (el.kind !== 'todo' || el.attrs?.checkPos === undefined) continue
      const checkPos = el.attrs.checkPos
      const current = view.state.doc.textBetween(checkPos, checkPos + 1)
      if (current !== ' ' && current.toLowerCase() !== 'x') return false
      const next = current === ' ' ? 'x' : ' '
      view.dispatch(view.state.tr.insertText(next, checkPos, checkPos + 1))
      return true
    }
  }
  return false
}

export function interactionsPlugin(options: InteractionOptions = {}): Plugin {
  const openLink =
    options.onOpenLink ??
    ((href: string) => {
      if (typeof window !== 'undefined') window.open(href, '_blank', 'noopener,noreferrer')
    })

  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target as HTMLElement | null

          // checkbox：拦截 mousedown，切换勾选，不移动光标
          if (target?.classList?.contains('hm-checkbox')) {
            event.preventDefault()
            return toggleTodoAt(view, target)
          }

          if (event.button !== 0) return false

          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (!coords) return false
          const st = concealKey.getState(view.state)
          if (!st) return false

          const el = findLinkAt(st, coords.pos)
          const href = el?.attrs?.href
          if (!el || !href) return false

          // 只有 Concealed 态的链接需要特殊处理；Revealed 态点击 = 正常编辑
          const sel = view.state.selection
          const concealed =
            st.readOnly || !spansIntersect(sel.from, sel.to, el.hitFrom, el.hitTo)
          if (!concealed) return false

          if (event.metaKey || event.ctrlKey) {
            // Cmd/Ctrl+点击 = 进入编辑：显式把文本光标放到点击处。
            // 不能走默认路径 —— 非 Mac 下 ctrl+click 是 PM 的 node-selection。
            event.preventDefault()
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, coords.pos)),
            )
            view.focus()
            return true
          }

          event.preventDefault()
          // 双击/三击的后续 mousedown（detail > 1）只拦截、不再重复打开
          if (event.detail <= 1) openLink(href)
          return true
        },
      },
    },
  })
}
