import { Plugin } from 'prosemirror-state'
import { concealKey, type ConcealMeta } from './conceal/plugin'

/**
 * L2 输入管线的 Composing 分支：IME（中文输入法）安全。
 *
 * compositionstart → 向 conceal 状态机投递 composing=true，冻结所有
 * conceal/reveal 迁移（decoration 只做位置 map），否则拼音过程中
 * selection 抖动会导致标记符闪烁。
 *
 * compositionend → 延迟到 ProseMirror 自身处理完合并事务之后，
 * 投递 composing=false（触发一次全量重算，把冻结期间积累的 stale 补上）。
 */
export function imePlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          const meta: ConcealMeta = { composing: true }
          view.dispatch(view.state.tr.setMeta(concealKey, meta))
          return false
        },
        compositionend(view) {
          setTimeout(() => {
            if (view.isDestroyed || view.composing) return
            const meta: ConcealMeta = { composing: false, refresh: true }
            view.dispatch(view.state.tr.setMeta(concealKey, meta))
          }, 0)
          return false
        },
      },
    },
  })
}
