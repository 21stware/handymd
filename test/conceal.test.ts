import { describe, expect, test } from 'bun:test'
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { markdownToDoc } from '../src/markdown'

/** 定位 needle 在 md 中的绝对文档位置（首个匹配） */
function posOf(md: string, needle: string): number {
  const lines = md.split('\n')
  let blockPos = 0
  for (const line of lines) {
    const idx = line.indexOf(needle)
    if (idx >= 0) return blockPos + 1 + idx
    blockPos += line.length + 2
  }
  throw new Error(`needle not found: ${needle}`)
}

function mkState(md: string): EditorState {
  return EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] })
}

function setCursor(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
}

type Spec = { hm: true; kind: string; role: string; concealed: boolean }

function findDecos(state: EditorState, pred: (spec: Spec) => boolean) {
  return concealKey.getState(state)!.set.find(undefined, undefined, (spec) => pred(spec as Spec))
}

const MD = '# Title\n\npara **bold** tail'

describe('conceal/reveal state machine (L3)', () => {
  test('heading badge only when focused; source "#" always concealed', () => {
    // 光标在标题内 → 源码隐藏 + 层级图标出现
    let state = mkState(MD)
    const markers = findDecos(state, (s) => s.kind === 'heading' && s.role === 'marker')
    expect(markers.length).toBeGreaterThan(0)
    expect(markers.every((d) => (d.spec as Spec).concealed)).toBe(true)
    expect(findDecos(state, (s) => s.kind === 'heading' && s.role === 'widget').length).toBe(1)

    // 光标离开标题 → 图标消失，源码仍隐藏
    state = setCursor(state, posOf(MD, 'para'))
    expect(findDecos(state, (s) => s.kind === 'heading' && s.role === 'widget').length).toBe(0)
    const markersAway = findDecos(state, (s) => s.kind === 'heading' && s.role === 'marker')
    expect(markersAway.every((d) => (d.spec as Spec).concealed)).toBe(true)
  })

  test('concealed prefixes keep a caret-pad so the cursor stays visible', () => {
    // 标题 / 引用 前缀末尾都有 caret-pad（含有内容时也需要，否则行首光标贴 font-size:0 消失）
    for (const md of ['# ', '# Title', '> quoted']) {
      const state = mkState(md)
      const pads = concealKey.getState(state)!.set.find(
        undefined,
        undefined,
        (spec) => (spec as Spec & { caretPad?: boolean }).caretPad === true,
      )
      expect(pads.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('cursor elsewhere conceals heading and strong', () => {
    let state = mkState(MD)
    state = setCursor(state, posOf(MD, 'para'))
    const heading = findDecos(state, (s) => s.kind === 'heading' && s.role === 'marker')[0]
    expect((heading.spec as Spec).concealed).toBe(true)
    const strong = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(strong.length).toBe(2)
    expect(strong.every((d) => (d.spec as Spec).concealed)).toBe(true)
    // 语义样式在 Concealed 态保留
    const content = findDecos(state, (s) => s.kind === 'strong' && s.role === 'content')
    expect(content.length).toBe(1)
  })

  test('[from-1, to+1] adjacency: cursor right before/after ** reveals', () => {
    let state = mkState(MD)
    const strongFrom = posOf(MD, '**bold**')
    const strongTo = strongFrom + '**bold**'.length

    state = setCursor(state, strongFrom) // 紧邻左外侧
    let strong = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(strong.every((d) => !(d.spec as Spec).concealed)).toBe(true)

    state = setCursor(state, strongTo) // 紧邻右外侧（从右退格进入不闪）
    strong = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(strong.every((d) => !(d.spec as Spec).concealed)).toBe(true)

    state = setCursor(state, strongTo + 2) // 离开扩一格区间
    strong = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(strong.every((d) => (d.spec as Spec).concealed)).toBe(true)
  })

  test('select-all reveals inline markers; heading source stays concealed but badge shows', () => {
    let state = mkState(MD)
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)))
    const inline = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(inline.length).toBe(2)
    expect(inline.every((d) => !(d.spec as Spec).concealed)).toBe(true)
    const heading = findDecos(state, (s) => s.kind === 'heading' && s.role === 'marker')
    expect(heading.every((d) => (d.spec as Spec).concealed)).toBe(true)
    expect(findDecos(state, (s) => s.kind === 'heading' && s.role === 'widget').length).toBe(1)
  })

  test('selection-only move with unchanged result reuses plugin state object', () => {
    let state = mkState(MD)
    state = setCursor(state, posOf(MD, 'para'))
    const before = concealKey.getState(state)!
    // 在同一块内移动一格，reveal 判定不变 → 不重建（引用相等）
    const after = setCursor(state, posOf(MD, 'para') + 1)
    expect(Object.is(concealKey.getState(after), before)).toBe(true)
  })

  test('readOnly forces all Concealed even with cursor inside', () => {
    let state = mkState(MD) // cursor 在 heading 内 → Revealed
    state = state.apply(state.tr.setMeta(concealKey, { readOnly: true }))
    const markers = findDecos(state, (s) => s.role === 'marker' && s.kind !== 'ordered')
    expect(markers.every((d) => (d.spec as Spec).concealed)).toBe(true)
  })

  test('IME freeze: no conceal/reveal transition while composing', () => {
    let state = mkState(MD)
    state = setCursor(state, posOf(MD, 'para')) // strong Concealed
    state = state.apply(state.tr.setMeta(concealKey, { composing: true }))
    const frozen = concealKey.getState(state)!

    // 拼音期间 selection 抖动进入 strong 范围 → 冻结，不迁移
    const strongFrom = posOf(MD, '**bold**')
    state = setCursor(state, strongFrom + 3)
    expect(Object.is(concealKey.getState(state)!.set, frozen.set)).toBe(true)

    // compositionend → 解冻并补一次重算 → Revealed
    state = state.apply(state.tr.setMeta(concealKey, { composing: false, refresh: true }))
    const strong = findDecos(state, (s) => s.kind === 'strong' && s.role === 'marker')
    expect(strong.every((d) => !(d.spec as Spec).concealed)).toBe(true)
  })

  test('Broken: deleting one * dissolves the element to plain text', () => {
    let state = mkState(MD)
    const strongFrom = posOf(MD, '**bold**')
    state = setCursor(state, strongFrom + 4)
    state = state.apply(state.tr.delete(strongFrom, strongFrom + 1)) // '**bold**' → '*bold**'
    expect(findDecos(state, (s) => s.kind === 'strong').length).toBe(0)
  })

  test('code fence: interior always source, fences reveal when cursor anywhere inside region', () => {
    const md = '```js\nconst a = **not bold**\n```\nafter'
    let state = mkState(md)
    state = setCursor(state, posOf(md, 'after'))

    // 代码块内部不解析行内元素
    expect(findDecos(state, (s) => s.kind === 'strong').length).toBe(0)
    // 光标在外 → 围栏行 Concealed
    let fences = findDecos(state, (s) => s.kind.startsWith('fence') && s.role === 'marker')
    expect(fences.every((d) => (d.spec as Spec).concealed)).toBe(true)

    // 光标进入代码行 → 两条围栏行都 Revealed
    state = setCursor(state, posOf(md, 'const'))
    fences = findDecos(state, (s) => s.kind.startsWith('fence') && s.role === 'marker')
    expect(fences.length).toBe(2)
    expect(fences.every((d) => !(d.spec as Spec).concealed)).toBe(true)
    // 代码行样式是 static 的
    expect(findDecos(state, (s) => s.kind === 'codeLine').length).toBe(1)
  })

  test('todo checkbox widget is permanent (cursor in block does not reveal source)', () => {
    const md = '- [x] done\n\ncursor here'
    let state = mkState(md)
    state = setCursor(state, posOf(md, 'cursor'))
    expect(findDecos(state, (s) => s.kind === 'todo' && s.role === 'widget').length).toBe(1)
    // 光标进入该行：widget 仍在，`- [x] ` 前缀仍然隐藏
    state = setCursor(state, posOf(md, 'done'))
    expect(findDecos(state, (s) => s.kind === 'todo' && s.role === 'widget').length).toBe(1)
    const markers = findDecos(state, (s) => s.kind === 'todo' && s.role === 'marker')
    expect(markers.every((d) => (d.spec as Spec).concealed)).toBe(true)
  })

  test('bullet / quote / hr are permanently rendered', () => {
    const md = '- task\n> quoted\n---'
    let state = mkState(md)
    // 光标逐个放进这三行，前缀都不回源码
    for (const needle of ['task', 'quoted']) {
      state = setCursor(state, posOf(md, needle))
      const markers = findDecos(state, (s) =>
        ['bullet', 'quote', 'hr'].includes(s.kind) && s.role === 'marker',
      )
      expect(markers.length).toBeGreaterThan(0)
      expect(markers.every((d) => (d.spec as Spec).concealed)).toBe(true)
    }
    // bullet 圆点与 hr 线是永久 widget
    expect(findDecos(state, (s) => s.kind === 'bullet' && s.role === 'widget').length).toBe(1)
    expect(findDecos(state, (s) => s.kind === 'hr' && s.role === 'widget').length).toBe(1)
  })

  test('doc edit reparses affected content', () => {
    let state = mkState('plain text here')
    expect(findDecos(state, (s) => s.kind === 'strong').length).toBe(0)
    const p = posOf('plain text here', 'text')
    state = state.apply(state.tr.insertText('**', p).insertText('**', p + 6))
    expect(findDecos(state, (s) => s.kind === 'strong').length).toBeGreaterThan(0)
  })
})
