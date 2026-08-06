import { Plugin } from 'prosemirror-state'
import { concealKey } from './conceal/plugin'

/**
 * L2 管线的 Append 阶段：appendTransaction 规范化。
 *
 * 有序列表编号：按缩进层级维护独立 run。更深缩进的子项不会打断父级
 * 序号；回到父级缩进时继续累加。嵌套 run（indent > 0）一律从 1 起，
 * 顶层 run 仍保留首项用户写的起始值。
 *
 * composing 期间跳过（IME 冻结原则同样适用于规范化写入）。
 */
export function normalizePlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, newState) {
      if (!trs.some((tr) => tr.docChanged)) return null
      const st = concealKey.getState(newState)
      if (!st || st.composing) return null

      const fixes: { from: number; to: number; text: string }[] = []
      // indent ASC stack: [{ indent, nextExpected }]
      const stack: { indent: number; expected: number }[] = []

      for (const block of st.blocks) {
        const line = block.line
        if (line.t === 'ordered') {
          while (stack.length && stack[stack.length - 1].indent > line.indent) {
            stack.pop()
          }
          const top = stack[stack.length - 1]
          if (top && top.indent === line.indent) {
            if (line.num !== top.expected) {
              const numFrom = block.pos + 1 + line.indent
              fixes.push({ from: numFrom, to: numFrom + line.numLen, text: String(top.expected) })
            }
            top.expected += 1
          } else {
            // New run at this indent. Nested lists always start at 1.
            const start = line.indent > 0 ? 1 : line.num
            if (line.num !== start) {
              const numFrom = block.pos + 1 + line.indent
              fixes.push({ from: numFrom, to: numFrom + line.numLen, text: String(start) })
            }
            stack.push({ indent: line.indent, expected: start + 1 })
          }
        } else if (line.t === 'bullet' || line.t === 'todo') {
          // Sibling list markers at this indent close deeper ordered runs.
          const indent = line.indent
          while (stack.length && stack[stack.length - 1].indent >= indent) {
            stack.pop()
          }
        } else {
          // blank / para / heading / … reset all ordered runs
          stack.length = 0
        }
      }

      if (!fixes.length) return null
      const tr = newState.tr
      for (let i = fixes.length - 1; i >= 0; i--) {
        tr.insertText(fixes[i].text, fixes[i].from, fixes[i].to)
      }
      tr.setMeta('addToHistory', false)
      return tr
    },
  })
}
