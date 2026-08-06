import { Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
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
 *
 * 冻结必须是可自愈的：漏掉一次解冻，编辑器就会永久停在冻结态
 * （decoration 停更、规范化与光标保护全部罢工）。所以除了重试解冻，
 * 还有一道 keydown 安全阀 —— 只要 PM 已不在合成态，按键即解冻。
 */

/** PM 自己在 compositionend 后还要再等 ~20ms 才真正结束合成，重试覆盖这段窗口 */
const THAW_RETRY_MS = 25
const THAW_RETRIES = 8

/**
 * 合成态自愈：有些第三方输入法（实测：豆包拼音）上屏时不走
 * insertCompositionText + compositionend，而是直接发普通 insertText，
 * 之后 compositionend 永远不来 —— PM 的 view.composing 卡在 true，
 * 此后所有 keydown（包括回车）都被 PM 丢弃，编辑器看起来"死了"，
 * 直到用户点击一下（mousedown 会强制结束合成）。
 *
 * 修复：合成期间收到普通 insertText / insertReplacementText，等本次输入
 * 落地后若 PM 仍认为在合成中，就补发一个 compositionend，让 PM 走
 * 自己的正常收尾。规范的 IME 上屏用 insertFromComposition /
 * insertCompositionText，不会触发这条路径；即便误触发，补发前还会
 * 再查一次 view.composing，真正的 compositionend 到过就什么都不做。
 */
function scheduleForceEndComposition(view: EditorView): void {
  setTimeout(() => {
    if (view.isDestroyed || !view.composing) return
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    // PM 在 Safari 上会把 compositionend 之后 500ms 内的第一个 keydown 吞掉
    // （防日文 IME 回车上屏误拆段）。补发的结束事件不是用户上屏动作，
    // 清掉时间戳，否则修好之后的第一个回车仍会被吃。
    const input = (view as unknown as { input?: { compositionEndedAt?: number } }).input
    if (input && typeof input.compositionEndedAt === 'number') {
      input.compositionEndedAt = -2e8
    }
  }, 0)
}

function frozen(view: EditorView): boolean {
  return concealKey.getState(view.state)?.composing === true
}

function thaw(view: EditorView): void {
  const meta: ConcealMeta = { composing: false, refresh: true }
  view.dispatch(view.state.tr.setMeta(concealKey, meta))
}

function scheduleThaw(view: EditorView, attempt = 0): void {
  setTimeout(
    () => {
      if (view.isDestroyed) return
      if (view.composing) {
        if (attempt < THAW_RETRIES) scheduleThaw(view, attempt + 1)
        return
      }
      if (frozen(view)) thaw(view)
    },
    attempt === 0 ? 0 : THAW_RETRY_MS,
  )
}

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
          scheduleThaw(view)
          return false
        },
        keydown(view) {
          if (!view.composing && frozen(view)) thaw(view)
          return false
        },
        // beforeinput 与 input 都挂：不同引擎/输入法只保证其中之一。
        // 补发前会再查 view.composing，重复调度是无害的。
        beforeinput(view, event) {
          const it = (event as InputEvent).inputType
          if (view.composing && (it === 'insertText' || it === 'insertReplacementText')) {
            scheduleForceEndComposition(view)
          }
          return false
        },
        input(view, event) {
          const it = (event as InputEvent).inputType
          if (view.composing && (it === 'insertText' || it === 'insertReplacementText')) {
            scheduleForceEndComposition(view)
          }
          return false
        },
      },
    },
  })
}
