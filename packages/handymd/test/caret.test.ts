import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { caretGuardPlugin } from '../src/caret'
import {
  backspaceBlockFormat,
  arrowLeftSkipPrefix,
  arrowUpToPrevContentEnd,
  deleteForwardStripPrefix,
  shiftArrowLeftSkipPrefix,
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

  test('backspace at non-empty heading content start removes the heading format', () => {
    let state = mkState('## Title')
    state = setCursor(state, 4)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('Title')
    expect(r.state.selection.from).toBe(1)
  })

  test('backspace at heading start eats the blank line above and keeps the heading', () => {
    let state = mkState('above\n\n## Title')
    // blocks: 'above' [0,7) · '' [7,9) · '## Title' starts at 9, content at 9+1+3 = 13
    state = setCursor(state, 13)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('above\n## Title')
    expect(r.state.selection.from).toBe(11)
  })

  test('backspace at nested bullet content start dedents first', () => {
    let state = mkState('- a\n  - b')
    state = setCursor(state, 5 + 1 + 4) // 第二块 pos 5，内容起点 +1 +'  - '.length
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('- a\n- b')
  })

  test('backspace at ordered item content start removes the number', () => {
    let state = mkState('1. a')
    state = setCursor(state, 4)
    const r = run(state, backspaceBlockFormat)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('a')
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

describe('range selections never cover a hidden prefix', () => {
  test('selecting from line start clamps the anchor to content start', () => {
    let state = mkState('- first\n- second')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 8)))
    expect(state.selection.from).toBe(3)
    state = state.apply(state.tr.insertText('R'))
    expect(docToMarkdown(state.doc)).toBe('- R\n- second')
  })

  test('select-to-line-start in a heading keeps the heading', () => {
    let state = mkState('# Title')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 8, 1)))
    state = state.apply(state.tr.insertText('New'))
    expect(docToMarkdown(state.doc)).toBe('# New')
  })

  test('shift-arrow-left at content start extends to the previous line end', () => {
    let state = mkState('above\n- task')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 12, 10)))
    const r = run(state, shiftArrowLeftSkipPrefix)
    expect(r.handled).toBe(true)
    expect(r.state.selection.anchor).toBe(12)
    expect(r.state.selection.head).toBe(6)
  })
})

describe('forward delete at line end', () => {
  test('joining a list line drops its hidden prefix', () => {
    let state = mkState('para\n- item')
    state = setCursor(state, 5)
    const r = run(state, deleteForwardStripPrefix)
    expect(r.handled).toBe(true)
    expect(docToMarkdown(r.state.doc)).toBe('paraitem')
  })

  test('joining a heading drops its prefix', () => {
    let state = mkState('para\n## Title')
    state = setCursor(state, 5)
    expect(docToMarkdown(run(state, deleteForwardStripPrefix).state.doc)).toBe('paraTitle')
  })

  test('next line hr is removed whole', () => {
    let state = mkState('para\n---\nafter')
    state = setCursor(state, 5)
    expect(docToMarkdown(run(state, deleteForwardStripPrefix).state.doc)).toBe('para\nafter')
  })

  test('plain next line falls through to default', () => {
    let state = mkState('para\nmore')
    state = setCursor(state, 5)
    expect(run(state, deleteForwardStripPrefix).handled).toBe(false)
  })
})

describe('source mode', () => {
  test('no decorations, no caret guard, no prefix-aware backspace', () => {
    let state = EditorState.create({
      doc: markdownToDoc('- task **b**'),
      plugins: [concealPlugin({ source: true }), caretGuardPlugin()],
    })
    expect(concealKey.getState(state)!.set.find().length).toBe(0)
    state = setCursor(state, 2)
    expect(state.selection.from).toBe(2)
    state = setCursor(state, 3)
    expect(run(state, backspaceBlockFormat).handled).toBe(false)
  })

  test('toggling back restores decorations', () => {
    let state = EditorState.create({
      doc: markdownToDoc('- task'),
      plugins: [concealPlugin({ source: true })],
    })
    state = state.apply(state.tr.setMeta(concealKey, { source: false }))
    expect(concealKey.getState(state)!.set.find().length).toBeGreaterThan(0)
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
