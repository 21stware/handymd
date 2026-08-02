import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { markdownToDoc, docToMarkdown } from '../src/markdown'
import {
  continueListItem,
  deleteToContentEnd,
  deleteToContentStart,
  toggleInline,
} from '../src/keymap'
import { normalizePlugin } from '../src/normalize'

function mkState(md: string, cursor?: number): EditorState {
  let state = EditorState.create({
    doc: markdownToDoc(md),
    plugins: [concealPlugin(), normalizePlugin()],
  })
  if (cursor !== undefined) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)))
  }
  return state
}

function run(state: EditorState, command: Command): EditorState {
  let out = state
  const handled = command(state, (tr) => {
    out = state.apply(tr)
  })
  expect(handled).toBe(true)
  return out
}

describe('markdown keymap', () => {
  test('Enter continues a todo list', () => {
    const md = '- [x] task'
    const state = mkState(md, 1 + md.length) // 行尾
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('- [x] task\n- [ ] ')
  })

  test('Enter on empty prefix line exits the list', () => {
    const md = '- [ ] '
    const state = mkState(md, 1 + md.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('')
  })

  test('Enter increments ordered list and renumbers following items', () => {
    const md = '1. a\n2. b'
    const state = mkState(md, 1 + '1. a'.length) // 第一行行尾
    const next = run(state, continueListItem)
    // split 出 "2. " 新行，normalizePlugin 把原来的 "2. b" 修成 "3. b"
    expect(docToMarkdown(next.doc)).toBe('1. a\n2. \n3. b')
  })

  test('Enter in plain paragraph is not handled', () => {
    const state = mkState('plain', 3)
    expect(continueListItem(state, () => {})).toBe(false)
  })

  test('Enter at heading content start keeps heading on the title line', () => {
    // `# |Title` → 上方空行，`# Title` 保持标题（不会变成纯文本 Title）
    const md = '# Title'
    const state = mkState(md, 3) // 内容起点（块首 1 + '# '.length）
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('\n# Title')
    expect(next.selection.from).toBe(1) // 新空行内
  })

  test('Enter mid-heading splits into two headings of the same level', () => {
    const md = '## HelloWorld'
    // 内容 "HelloWorld"，在 Hello|World 处回车
    const state = mkState(md, 1 + '## Hello'.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('## Hello\n## World')
  })

  test('Enter on empty heading exits heading format', () => {
    const md = '## '
    const state = mkState(md, 1 + md.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('')
  })

  test('Enter continues a quote and keeps both lines as quotes', () => {
    const md = '> hello'
    const state = mkState(md, 1 + md.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('> hello\n> ')
    const st = concealKey.getState(next)!
    const nodeDecos = st.set.find().filter((d) => (d.spec as { role?: string }).role === 'node')
    expect(nodeDecos).toHaveLength(2)
    expect(nodeDecos.map((d) => `${d.from}-${d.to}`).sort()).toEqual(['0-9', '9-13'])
  })

  test('Mod-Backspace clears todo content but keeps the checkbox prefix', () => {
    const md = '- [ ] keep me'
    const state = mkState(md, 1 + md.length)
    const next = run(state, deleteToContentStart)
    expect(docToMarkdown(next.doc)).toBe('- [ ] ')
  })

  test('Mod-Backspace clears quote / bullet / heading content only', () => {
    expect(docToMarkdown(run(mkState('> quoted', 1 + '> quoted'.length), deleteToContentStart).doc)).toBe(
      '> ',
    )
    expect(docToMarkdown(run(mkState('- item', 1 + '- item'.length), deleteToContentStart).doc)).toBe(
      '- ',
    )
    expect(docToMarkdown(run(mkState('## Title', 1 + '## Title'.length), deleteToContentStart).doc)).toBe(
      '## ',
    )
  })

  test('Mod-Delete clears from caret to end without touching the prefix', () => {
    const md = '- [ ] abcdef'
    // caret after "abc"
    const state = mkState(md, 1 + '- [ ] abc'.length)
    const next = run(state, deleteToContentEnd)
    expect(docToMarkdown(next.doc)).toBe('- [ ] abc')
  })

  test('Mod-b wraps then unwraps', () => {
    const md = 'a bold c'
    let state = mkState(md)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3, 7)), // "bold"
    )
    state = run(state, toggleInline('**'))
    expect(docToMarkdown(state.doc)).toBe('a **bold** c')
    // toggle 后 selection 仍套住 "bold"，再次执行 → 解包（紧邻标记路径）
    state = run(state, toggleInline('**'))
    expect(docToMarkdown(state.doc)).toBe('a bold c')
  })

  test('Mod-b with empty selection inserts pair, cursor in middle', () => {
    let state = mkState('x', 2)
    state = run(state, toggleInline('**'))
    expect(docToMarkdown(state.doc)).toBe('x****')
    expect(state.selection.from).toBe(4)
  })
})

describe('normalizePlugin (appendTransaction)', () => {
  test('renumbers ordered runs after any doc change', () => {
    let state = mkState('1. a\n7. b\n9. c', 1)
    state = state.apply(state.tr.insertText('x', state.doc.content.size - 1))
    expect(docToMarkdown(state.doc)).toBe('1. a\n2. b\n3. cx')
  })

  test('first item of a run keeps its user-chosen start value', () => {
    let state = mkState('para\n7. b\n9. c', 1)
    state = state.apply(state.tr.insertText('x', 1))
    expect(docToMarkdown(state.doc)).toBe('xpara\n7. b\n8. c')
  })

  test('blank line breaks the run', () => {
    let state = mkState('1. a\n\n5. b', 1)
    state = state.apply(state.tr.insertText('x', 2))
    expect(docToMarkdown(state.doc)).toBe('1x. a\n\n5. b')
  })
})
