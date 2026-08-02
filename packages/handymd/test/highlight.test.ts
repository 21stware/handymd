import { describe, expect, test } from 'bun:test'
import { EditorState } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
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

  /**
   * Editing outside a fence must not rebuild the whole DecorationSet (that is
   * O(blocks × decorations)); the plugin maps instead. These lock in that the
   * mapped result is still what a full recompute would produce.
   */
  test('typing above a fence shifts highlight decorations', () => {
    let state = mkState('lead\n```js\nconst a = 1\n```')
    const before = highlightKey.getState(state)!.find()
    state = state.apply(state.tr.insertText('XY', 1, 1))
    const after = highlightKey.getState(state)!.find()

    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.from).toBe(before[i]!.from + 2)
      expect(after[i]!.to).toBe(before[i]!.to + 2)
    }
    // …and matches a from-scratch build on the same doc
    const fresh = EditorState.create({
      doc: state.doc,
      plugins: [concealPlugin(), highlightPlugin(fake)],
    })
    expect(after.map((d) => `${d.from}-${d.to}`)).toEqual(
      highlightKey
        .getState(fresh)!
        .find()
        .map((d) => `${d.from}-${d.to}`),
    )
  })

  test('adding a line above a fence keeps highlight aligned to the code', () => {
    let state = mkState('lead\n```js\nconst a = 1\n```')
    // insert a whole new block before the fence
    const first = state.doc.firstChild!
    state = state.apply(
      state.tr.insert(0, first.type.create(null, state.schema.text('new first line'))),
    )
    const fresh = EditorState.create({
      doc: state.doc,
      plugins: [concealPlugin(), highlightPlugin(fake)],
    })
    expect(
      highlightKey
        .getState(state)!
        .find()
        .map((d) => `${d.from}-${d.to}`),
    ).toEqual(
      highlightKey
        .getState(fresh)!
        .find()
        .map((d) => `${d.from}-${d.to}`),
    )
  })

  /**
   * During IME composition the conceal plugin freezes its block table, so the
   * absolute positions it reports are stale. Recomputing from them would put
   * decorations at the wrong offsets — the plugin must map through instead.
   */
  test('IME composition does not misplace highlight decorations', () => {
    let state = mkState('lead\n```js\nconst a = 1\n```')
    state = state.apply(state.tr.setMeta(concealKey, { composing: true }))
    state = state.apply(state.tr.insertText('\u4f60\u597d', 1, 1))
    state = state.apply(state.tr.setMeta(concealKey, { composing: false }))

    const fresh = EditorState.create({
      doc: state.doc,
      plugins: [concealPlugin(), highlightPlugin(fake)],
    })
    expect(
      highlightKey
        .getState(state)!
        .find()
        .map((d) => `${d.from}-${d.to}`),
    ).toEqual(
      highlightKey
        .getState(fresh)!
        .find()
        .map((d) => `${d.from}-${d.to}`),
    )
  })
})
