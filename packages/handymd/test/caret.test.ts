import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { concealPlugin } from '../src/conceal/plugin'
import { caretGuardPlugin } from '../src/caret'
import {
  backspaceBlockFormat,
  arrowLeftSkipPrefix,
  arrowUpToPrevContentEnd,
} from '../src/keymap'
import { markdownToDoc, docToMarkdown } from '../src/markdown'

function mkState(md: string): EditorState {
  return EditorState.create({
    doc: markdownToDoc(md),
    plugins: [concealPlugin(), caretGuardPlugin()],
  })
}

function setCursor(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
}

function run(state: EditorState, command: Command): { handled: boolean; state: EditorState } {
  let out = state
  const handled = command(state, (tr) => {
    out = state.apply(tr)
  })
  return { handled, state: out }
}

describe('caret guard for permanent prefixes', () => {
  test('caret landing inside hidden todo prefix is pushed to content start', () => {
    // '- [ ] task'：内容起点是 pos 7（块首 1 + 前缀 6）
    let state = mkState('- [ ] task')
    state = setCursor(state, 2) // 落进隐藏的 "- [ ] "
    expect(state.selection.from).toBe(7)
  })

  test('caret at line start of quote is pushed past "> "', () => {
    let state = mkState('> quoted')
    state = setCursor(state, 1)
    expect(state.selection.from).toBe(3)
  })

  test('caret on hr line rests at line end', () => {
    let state = mkState('para\n---')
    state = setCursor(state, 8) // hr 块内（块首 7 + 1）
    expect(state.selection.from).toBe(10) // '---' 之后
  })
})

describe('backspace removes block format', () => {
  test('backspace at bullet content start strips "- "', () => {
    let state = mkState('- task')
    state = setCursor(state, 3) // 内容起点
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('task')
  })

  test('backspace at non-empty heading content start keeps the heading prefix', () => {
    // Enter 后再 ArrowUp 常停在这里；拆掉 `## ` 会把标题变成普通文本。
    let state = mkState('## Title')
    state = setCursor(state, 4)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('## Title')
    expect(r.state.selection.from).toBe(4) // 首行：吞掉按键，光标不动
  })

  test('backspace at non-empty heading content start jumps to previous line end', () => {
    let state = mkState('above\n## Title')
    // 'above' = 5 chars → block0 size 7; block1 starts at 7; content after `## ` at 7+1+3 = 11
    state = setCursor(state, 11)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('above\n## Title')
    expect(r.state.selection.from).toBe(6) // 'above' 行尾
  })

  test('backspace on empty heading strips the prefix', () => {
    let state = mkState('## ')
    state = setCursor(state, 4)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('')
  })

  test('backspace on hr deletes the whole divider', () => {
    let state = mkState('para\n---')
    state = setCursor(state, 10)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('para\n')
  })

  test('backspace mid-content falls through to default', () => {
    let state = mkState('- task')
    state = setCursor(state, 5)
    expect(run(state, backspaceBlockFormat).handled).toBe(false)
  })
})

describe('arrow-left skips hidden prefix', () => {
  test('at content start jumps to previous line end', () => {
    let state = mkState('above\n- task')
    state = setCursor(state, 10) // 第二行内容起点（7 + 1 + 2）
    const r = run(state, arrowLeftSkipPrefix)
    expect(r.handled).toBe(true)
    expect(r.state.selection.from).toBe(6) // 'above' 行尾
  })

  test('first line stays put instead of entering hidden prefix', () => {
    let state = mkState('- task')
    state = setCursor(state, 3)
    const r = run(state, arrowLeftSkipPrefix)
    expect(r.handled).toBe(true)
    expect(r.state.selection.from).toBe(3)
  })
})

describe('arrow-up into prefixed line', () => {
  test('from the line below a heading lands at the heading end', () => {
    // `# Title\n` → 空行块首。ArrowUp 应到标题行尾，而不是 `# ` 后的内容起点。
    let state = mkState('# Title\n')
    state = setCursor(state, 10) // 第二块内
    const r = run(state, arrowUpToPrevContentEnd)
    expect(r.handled).toBe(true)
    expect(r.state.selection.from).toBe(8) // '# Title' 行尾
  })

  test('from mid-line falls through', () => {
    let state = mkState('# Title\nbody')
    state = setCursor(state, 12) // 'body' 中
    expect(run(state, arrowUpToPrevContentEnd).handled).toBe(false)
  })
})
