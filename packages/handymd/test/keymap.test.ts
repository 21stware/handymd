import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { markdownToDoc, docToMarkdown } from '../src/markdown'
import {
  continueListItem,
  dedentListItem,
  deleteToContentEnd,
  deleteToContentStart,
  headingInputPlugin,
  indentListItem,
  insertTab,
  markdownKeymap,
  removeTab,
  setHeading,
  splitWithoutPrefix,
  closeFenceOnEnter,
  toggleInline,
} from '../src/keymap'
import { normalizePlugin } from '../src/normalize'

function mkState(md: string, cursor?: number): EditorState {
  let state = EditorState.create({
    doc: markdownToDoc(md),
    plugins: [concealPlugin(), headingInputPlugin(), normalizePlugin()],
  })
  if (cursor !== undefined) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)))
  }
  return state
}

/** Doc position `col` characters into line `row`（都是 0 基）—— 每行一个块，块首尾各占 1。 */
function at(md: string, row: number, col: number): number {
  const lines = md.split('\n')
  let pos = 1
  for (let i = 0; i < row; i++) pos += lines[i].length + 2
  return pos + col
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

  test('Enter mid-heading splits; next line is plain (no heading prefix)', () => {
    const md = '## HelloWorld'
    // 内容 "HelloWorld"，在 Hello|World 处回车 → `## Hello\nWorld`（不续 `## `）
    const state = mkState(md, 1 + '## Hello'.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('## Hello\nWorld')
  })

  test('Enter at end of heading opens a plain paragraph', () => {
    const md = '# Title'
    const state = mkState(md, 1 + md.length)
    const next = run(state, continueListItem)
    expect(docToMarkdown(next.doc)).toBe('# Title\n')
  })

  test('Enter still splits when the conceal freeze flag went stale', () => {
    // 漏掉一次 IME 解冻，渲染冻结标志会留在 true。回车绝不能因此被吞掉。
    let state = mkState('# Title', 1 + '# Title'.length)
    state = state.apply(state.tr.setMeta(concealKey, { composing: true }))
    expect(concealKey.getState(state)!.composing).toBe(true)

    const view = {
      get state() {
        return state
      },
      composing: false,
      dispatch: (tr: Parameters<typeof state.apply>[0]) => {
        state = state.apply(tr)
      },
    }
    const plugin = markdownKeymap()
    const handled = plugin.props.handleKeyDown!.call(
      plugin,
      view as never,
      new KeyboardEvent('keydown', { key: 'Enter' }),
    )
    expect(handled).toBe(true)
    expect(docToMarkdown(state.doc)).toBe('# Title\n')
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

  test('Mod-Backspace clears a plain paragraph, which has no prefix to keep', () => {
    const md = 'just a line'
    const state = mkState(md, 1 + md.length)
    expect(docToMarkdown(run(state, deleteToContentStart).doc)).toBe('')
  })

  test('Mod-Backspace only reaches back to the caret, not the whole document', () => {
    const md = 'first\n\nsecond line'
    const state = mkState(md, at(md, 2, 'second '.length))
    expect(docToMarkdown(run(state, deleteToContentStart).doc)).toBe('first\n\nline')
  })

  test('Mod-Delete clears a plain paragraph from the caret to the end', () => {
    const state = mkState('abcdef', 1 + 'abc'.length)
    expect(docToMarkdown(run(state, deleteToContentEnd).doc)).toBe('abc')
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

describe('list indent / dedent', () => {
  test('Tab on ordered item starts a nested run at 1 and renumbers parent siblings', () => {
    const md = '1. a\n2. b\n3. c'
    // cursor in "2. b"
    const state = mkState(md, 1 + '1. a\n'.length + 3)
    const next = run(state, indentListItem)
    expect(docToMarkdown(next.doc)).toBe('1. a\n  1. b\n2. c')
  })

  test('Tab into an existing nested ordered run continues that run', () => {
    const md = '1. a\n  1. b\n2. c'
    const state = mkState(md, 1 + '1. a\n  1. b\n'.length + 3)
    const next = run(state, indentListItem)
    expect(docToMarkdown(next.doc)).toBe('1. a\n  1. b\n  2. c')
  })

  test('Shift-Tab dedents ordered item back into the parent run', () => {
    const md = '1. a\n  1. b\n  2. c'
    const state = mkState(md, 1 + '1. a\n'.length + 5)
    const next = run(state, dedentListItem)
    expect(docToMarkdown(next.doc)).toBe('1. a\n2. b\n  1. c')
  })

  test('Tab indents a bullet by two spaces', () => {
    const md = '- a\n- b'
    const state = mkState(md, 1 + '- a\n'.length + 2)
    const next = run(state, indentListItem)
    expect(docToMarkdown(next.doc)).toBe('- a\n  - b')
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

  test('bare `#` stays plain text until a space turns it into a heading', () => {
    let state = mkState('', 1)
    state = state.apply(state.tr.insertText('#', 1))
    expect(docToMarkdown(state.doc)).toBe('#')
    state = state.apply(state.tr.insertText(' ', 2))
    expect(docToMarkdown(state.doc)).toBe('# ')
  })

  test('typing `#` on an empty heading promotes the level', () => {
    let state = mkState('# ', 3)
    const plugin = headingInputPlugin()
    const view = {
      state,
      dispatch(tr: Parameters<typeof state.apply>[0]) {
        state = state.apply(tr)
      },
    }
    const handle = plugin.props.handleTextInput!
    expect(handle.call(plugin, view as never, 3, 3, '#', () => state.tr)).toBe(true)
    expect(docToMarkdown(state.doc)).toBe('## ')
    expect(state.selection.from).toBe(4)
  })
})

describe('Enter edge cases', () => {
  test('Enter at content start of a checked todo inserts an empty item above and keeps the check', () => {
    const md = '- [x] task'
    const next = run(mkState(md, 7), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('- [ ] \n- [x] task')
    expect(next.selection.from).toBe(at(docToMarkdown(next.doc), 1, 6))
  })

  test('Enter at content start of an ordered item renumbers the moved item', () => {
    const next = run(mkState('1. a', 4), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('1. \n2. a')
  })

  test('Enter on an empty nested bullet dedents instead of clearing', () => {
    const md = '- a\n  - '
    const next = run(mkState(md, at(md, 1, 4)), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('- a\n- ')
  })

  test('Enter inside **bold** closes and reopens the marker on both halves', () => {
    const md = 'x **bold** y'
    const next = run(mkState(md, at(md, 0, 6)), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('x **bo**\n**ld** y')
    expect(next.selection.from).toBe(at('x **bo**\n**ld** y', 1, 2))
  })

  test('Enter inside nested emphasis in a list item keeps both levels and the bullet', () => {
    const md = '- *a **bc** d*'
    const next = run(mkState(md, at(md, 0, 8)), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('- *a **b***\n- ***c** d*')
  })

  test('Enter right after an opening marker moves the whole element down', () => {
    const md = 'x **bold**'
    const next = run(mkState(md, at(md, 0, 4)), continueListItem)
    expect(docToMarkdown(next.doc)).toBe('x \n**bold**')
    expect(next.selection.from).toBe(at('x \n**bold**', 1, 2))
  })

  test('Enter in a plain paragraph without markers stays with the default command', () => {
    expect(continueListItem(mkState('plain text', 4), () => {})).toBe(false)
  })

  test('Enter at the end of an unclosed fence opener inserts the closing fence', () => {
    const md = 'intro\n```js\n# not code'
    const next = run(mkState(md, at(md, 1, 5)), closeFenceOnEnter)
    expect(docToMarkdown(next.doc)).toBe('intro\n```js\n\n```\n# not code')
    expect(next.selection.from).toBe(at(docToMarkdown(next.doc), 2, 0))
  })

  test('Enter on a fence that would steal a later block closer also auto-closes', () => {
    const md = '```\n```py\nx\n```'
    const next = run(mkState(md, at(md, 0, 3)), closeFenceOnEnter)
    expect(docToMarkdown(next.doc)).toBe('```\n\n```\n```py\nx\n```')
  })

  test('Enter on an already closed fence opener falls through', () => {
    const md = '```js\ncode\n```'
    expect(closeFenceOnEnter(mkState(md, at(md, 0, 5)), () => {})).toBe(false)
  })

  test('Shift-Enter in a list splits without continuing the bullet', () => {
    const md = '- item'
    const next = run(mkState(md, at(md, 0, 6)), splitWithoutPrefix)
    expect(docToMarkdown(next.doc)).toBe('- item\n')
  })
})

describe('heading shortcuts', () => {
  test('Mod-2 turns a paragraph into ## and toggles back', () => {
    let state = mkState('Title', 3)
    state = run(state, setHeading(2))
    expect(docToMarkdown(state.doc)).toBe('## Title')
    state = run(state, setHeading(2))
    expect(docToMarkdown(state.doc)).toBe('Title')
  })

  test('Mod-1 changes the level of an existing heading', () => {
    const state = run(mkState('### Title', 6), setHeading(1))
    expect(docToMarkdown(state.doc)).toBe('# Title')
  })

  test('Mod-1 on a bullet replaces the list prefix', () => {
    const state = run(mkState('- item', 4), setHeading(1))
    expect(docToMarkdown(state.doc)).toBe('# item')
  })
})

describe('Tab outside lists', () => {
  test('Tab in a code block inserts two spaces', () => {
    const md = '```\ncode\n```'
    const state = run(mkState(md, at(md, 1, 0)), insertTab)
    expect(docToMarkdown(state.doc)).toBe('```\n  code\n```')
  })

  test('Tab over a multi-line code selection indents every line; Shift-Tab undoes it', () => {
    const md = '```\na\nb\n```'
    let state = mkState(md)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, at(md, 1, 0), at(md, 2, 1))),
    )
    state = run(state, insertTab)
    expect(docToMarkdown(state.doc)).toBe('```\n  a\n  b\n```')
    state = run(state, removeTab)
    expect(docToMarkdown(state.doc)).toBe('```\na\nb\n```')
  })

  test('Tab in a paragraph inserts a tab character instead of leaving the editor', () => {
    const state = run(mkState('ab', 2), insertTab)
    expect(docToMarkdown(state.doc)).toBe('a\tb')
  })
})
