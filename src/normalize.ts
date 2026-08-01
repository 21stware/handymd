import { Plugin } from 'prosemirror-state'
import { concealKey } from './conceal/plugin'

/**
 * L2 管线的 Append 阶段：appendTransaction 规范化。
 *
 * 当前实现：修复有序列表编号 —— 同一缩进层级上连续的有序项，序号必须
 * 从首项开始逐一递增（保留首项的起始值）。首项本身永远不动，所以用户
 * 有意改首项序号时不会被"打回去"。
 *
 * composing 期间跳过（IME 冻结原则同样适用于规范化写入）。
 */
export function normalizePlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, newState) {
      if (!trs.some((tr) => tr.docChanged)) return null
      const st = concealKey.getState(newState)
      if (!st || st.composing) return null

      // 自底向上收集需要改写的序号，避免位置映射
      const fixes: { from: number; to: number; text: string }[] = []
      let expected: number | null = null
      let runIndent = -1

      for (const block of st.blocks) {
        const line = block.line
        if (line.t === 'ordered') {
          if (expected !== null && line.indent === runIndent) {
            if (line.num !== expected) {
              const numFrom = block.pos + 1 + line.indent
              fixes.push({ from: numFrom, to: numFrom + line.numLen, text: String(expected) })
            }
            expected += 1
          } else {
            // run 的首项保留用户写的起始值，之后逐一递增
            runIndent = line.indent
            expected = line.num + 1
          }
        } else {
          // 任何非有序行（含空行）都打断 run，之后重新计数
          expected = null
          runIndent = -1
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
