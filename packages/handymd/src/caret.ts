import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { concealKey } from './conceal/plugin'
import type { ElementRange } from './elements'
import type { BlockMeta } from './parse/docparse'

/**
 * 隐藏前缀的光标保护。
 *
 * 块级前缀（`- ` / `- [ ] ` / `> ` / `# ` / hr 整行）隐藏后，光标不应停留
 * 在这些不可见字符里 —— 点击行首、Home、跨行 ArrowRight 等都可能把 caret
 * 放进隐藏区。本插件用 appendTransaction 把落入隐藏前缀的折叠光标推到
 * 内容起点（hr 推到行尾），保证"看不见的字符也走不进去"。
 *
 * 标题虽然不 permanent（聚焦时要展示层级图标），但 `#`/`##` 源码永远隐藏，
 * 同样纳入保护。
 *
 * 方向性移动（ArrowLeft 跨过前缀、Backspace 去格式）在 keymap 里处理。
 */

function isProtectedPrefix(el: ElementRange): boolean {
  if (el.scope !== 'block' || !el.markers.length) return false
  return el.permanent === true || el.kind === 'heading'
}

export function permanentPrefixAt(
  state: EditorState,
  blockPos: number,
): { block: BlockMeta; el: ElementRange } | null {
  const st = concealKey.getState(state)
  if (!st) return null
  for (const block of st.blocks) {
    if (block.pos !== blockPos) continue
    for (const el of block.elements) {
      // 表格管道是离散 marker，不是单一前缀；仍返回元素供 Backspace 等使用
      if (isProtectedPrefix(el)) return { block, el }
    }
    return null
  }
  return null
}

/** 光标落在任一受保护 marker 内时，推到该 marker 之后（表格管道 / 前缀 / hr） */
function escapeProtectedMarker(
  state: EditorState,
  blockPos: number,
  pos: number,
): number | null {
  const st = concealKey.getState(state)
  if (!st) return null
  for (const block of st.blocks) {
    if (block.pos !== blockPos) continue
    for (const el of block.elements) {
      if (!isProtectedPrefix(el)) continue
      for (const m of el.markers) {
        if (pos >= m.from && pos < m.to) return m.to
      }
    }
    return null
  }
  return null
}

export function caretGuardPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_trs, _old, newState) {
      const sel = newState.selection
      if (!(sel instanceof TextSelection) || !sel.empty) return null
      const st = concealKey.getState(newState)
      if (!st || st.composing) return null
      const $head = sel.$head
      if ($head.depth !== 1) return null

      const next = escapeProtectedMarker(newState, $head.before(), sel.from)
      if (next === null || next === sel.from) return null
      return newState.tr.setSelection(TextSelection.create(newState.doc, next))
    },
  })
}
