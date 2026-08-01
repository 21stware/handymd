import { describe, expect, test } from 'bun:test'
import { EditorState } from 'prosemirror-state'
import { concealPlugin } from '../src/conceal/plugin'
import { highlightPlugin, highlightKey, type HighlightSpan } from '../src/highlight'
import { markdownToDoc } from '../src/markdown'

/** 假高亮器：给每个单词上色 */
const fake = (code: string): HighlightSpan[][] =>
  code.split('\n').map((line) =>
    line
      .split(/(\s+)/)
      .filter(Boolean)
      .map((text) => ({ text, color: /\s/.test(text) ? undefined : '#ff0000' })),
  )

function mkState(md: string): EditorState {
  return EditorState.create({
    doc: markdownToDoc(md),
    plugins: [concealPlugin(), highlightPlugin(fake)],
  })
}

describe('highlightPlugin', () => {
  test('sync highlighter decorates fence code lines', () => {
    const state = mkState('```js\nconst a = 1\n```')
    const set = highlightKey.getState(state)!
    const decos = set.find()
    expect(decos.length).toBe(4) // const / a / = / 1
    // 位置：代码行块首 pos 7，文本起点 8 → 'const' = [8, 13)
    expect(decos[0].from).toBe(8)
    expect(decos[0].to).toBe(13)
  })

  test('fence without info string is not highlighted', () => {
    const state = mkState('```\nplain\n```')
    expect(highlightKey.getState(state)!.find().length).toBe(0)
  })

  test('doc edit recomputes highlight', () => {
    let state = mkState('```js\nx\n```')
    const before = highlightKey.getState(state)!.find().length
    state = state.apply(state.tr.insertText(' + y', 9))
    const after = highlightKey.getState(state)!.find().length
    expect(before).toBe(1)
    expect(after).toBe(3) // x / + / y
  })
})
