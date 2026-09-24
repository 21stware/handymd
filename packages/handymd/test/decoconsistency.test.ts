/**
 * Differential test for the incremental decoration path.
 *
 * The conceal plugin never rebuilds the whole DecorationSet on a keystroke or
 * a caret move — it maps the previous set and then remove/adds only the dirty
 * blocks (see conceal/plugin.ts). That optimisation is only safe if the result
 * is byte-for-byte what a from-scratch build would have produced, so every
 * step below is compared against a freshly initialised plugin on the same
 * (doc, selection).
 */
import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { DecorationSet } from 'prosemirror-view'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { createDiagramRenderCallback } from '../src/diagram'
import {
  backspaceBlockFormat,
  closeFenceOnEnter,
  continueListItem,
  deleteForwardStripPrefix,
  setHeading,
} from '../src/keymap'
import { markdownToDoc } from '../src/markdown'
import { schema } from '../src/schema'

/** Order-independent, structural snapshot of a decoration set. */
function snapshot(set: DecorationSet): string[] {
  return set
    .find()
    .map((d) => `${d.from}-${d.to} ${JSON.stringify(d.spec)}`)
    .sort()
}

const renderDiagram = createDiagramRenderCallback(() => '<svg></svg>')

function freshAt(state: EditorState): string[] {
  // A brand-new plugin instance computes everything via the full path.
  // readOnly lives in plugin state, so it has to be re-seeded as an option.
  const rebuilt = EditorState.create({
    doc: state.doc,
    selection: state.selection,
    plugins: [
      concealPlugin({ renderDiagram, readOnly: concealKey.getState(state)!.readOnly }),
    ],
  })
  return snapshot(concealKey.getState(rebuilt)!.set)
}

function expectConsistent(state: EditorState, label: string): void {
  const incremental = snapshot(concealKey.getState(state)!.set)
  expect(incremental, label).toEqual(freshAt(state))
}

const DOC = [
  '# Title',
  '',
  'para with **bold** and *em* and `code`',
  '- bullet one',
  '- [ ] todo item',
  '- [x] done item',
  '> a quote line',
  '1. ordered item',
  '---',
  'text with [link](https://example.com) inside',
  '```ts',
  'const x = 1',
  '```',
  '| A | B |',
  '| --- | --- |',
  '| a | b |',
  '```mermaid',
  'A-->B',
  '```',
  'tail paragraph',
].join('\n')

function start(md = DOC): EditorState {
  return EditorState.create({
    doc: markdownToDoc(md),
    plugins: [concealPlugin({ renderDiagram })],
  })
}

/** Move the caret, snapping to the nearest position that can hold a text selection. */
function caret(state: EditorState, pos: number): EditorState {
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size))
  const $pos = state.doc.resolve(clamped)
  if (!$pos.parent.inlineContent) return state
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, clamped)))
}

describe('incremental decorations match a full rebuild', () => {
  test('caret sweep across every position', () => {
    let state = start()
    for (let pos = 1; pos < state.doc.content.size; pos += 1) {
      state = caret(state, pos)
      expectConsistent(state, `caret at ${pos}`)
    }
  })

  test('typing inside a paragraph', () => {
    let state = start()
    const target = 'para with'
    let pos = 0
    state.doc.forEach((node, offset) => {
      if (node.textContent.startsWith(target)) pos = offset + 1 + target.length
    })
    state = caret(state, pos)
    for (const ch of 'XYZ 123') {
      const at = state.selection.from
      state = state.apply(state.tr.insertText(ch, at, at))
      expectConsistent(state, `after typing ${JSON.stringify(ch)}`)
    }
  })

  test('typing that creates and destroys block structure', () => {
    // A plain line becomes a heading, then a bullet, then plain again.
    let state = start('plain line\nsecond line\nthird line')
    const steps: string[] = ['#', ' ']
    for (const ch of steps) {
      state = state.apply(state.tr.insertText(ch, 1, 1))
      expectConsistent(state, `after inserting ${JSON.stringify(ch)} at doc start`)
    }
    // remove the "# " again
    state = state.apply(state.tr.delete(1, 3))
    expectConsistent(state, 'after removing heading prefix')

    // turn it into a bullet
    state = state.apply(state.tr.insertText('- ', 1, 1))
    expectConsistent(state, 'after inserting bullet prefix')
  })

  test('opening and closing a fence reclassifies following lines', () => {
    // Typing a fence changes the classification of *later* lines, which is the
    // case where a block's decorations must change without its own text changing.
    let state = start('alpha\nbravo\ncharlie')
    state = state.apply(state.tr.insertText('```', 1, 1))
    expectConsistent(state, 'after opening a fence on line 1')

    state = state.apply(state.tr.delete(1, 4))
    expectConsistent(state, 'after removing the fence again')
  })

  test('splitting and joining blocks', () => {
    let state = start('alpha **bold** omega\nsecond line\nthird line')
    state = caret(state, 7)
    state = state.apply(state.tr.split(7))
    expectConsistent(state, 'after split')

    // the boundary between the two halves the split just produced
    state = state.apply(state.tr.join(state.doc.firstChild!.nodeSize))
    expectConsistent(state, 'after join')
  })

  test('Enter continuing quote/todo keeps node decorations on both lines', () => {
    for (const md of ['> hello', '- [ ] task', '- item', '## Title']) {
      let state = start(md)
      state = caret(state, 1 + md.length)
      continueListItem(state, (tr) => {
        state = state.apply(tr)
      })
      expectConsistent(state, `after Enter on ${JSON.stringify(md)}`)
    }
  })

  test('deleting a whole block', () => {
    let state = start()
    const first = state.doc.firstChild!
    state = state.apply(state.tr.delete(0, first.nodeSize))
    expectConsistent(state, 'after deleting the first block')
  })

  test('appending a new block at the end', () => {
    let state = start()
    const end = state.doc.content.size
    state = state.apply(
      state.tr.insert(end, schema.nodes.block.create(null, schema.text('## appended'))),
    )
    expectConsistent(state, 'after appending a block')
  })

  test('editing inside a diagram fence updates the rendered widget', () => {
    let state = start()
    let bodyPos = 0
    state.doc.forEach((node, offset) => {
      if (node.textContent === 'A-->B') bodyPos = offset + 1
    })
    expect(bodyPos).toBeGreaterThan(0)

    // caret outside the fence → concealed + rendered
    state = caret(state, 1)
    expectConsistent(state, 'diagram concealed')

    // change the diagram source; the open line's cached code attr must follow
    state = state.apply(state.tr.insertText('C', bodyPos + 4, bodyPos + 5))
    state = caret(state, 1)
    expectConsistent(state, 'after editing diagram body')
  })

  test('editing a table row', () => {
    let state = start()
    let rowPos = 0
    state.doc.forEach((node, offset) => {
      if (node.textContent === '| a | b |') rowPos = offset + 1
    })
    expect(rowPos).toBeGreaterThan(0)
    state = state.apply(state.tr.insertText('Z', rowPos + 3, rowPos + 3))
    state = caret(state, 1)
    expectConsistent(state, 'after editing a table cell')
  })

  test('readOnly and IME thaw force a consistent full recompute', () => {
    let state = start()
    state = caret(state, 3)
    state = state.apply(state.tr.setMeta(concealKey, { readOnly: true }))
    expectConsistent(state, 'after switching to readOnly')

    state = state.apply(state.tr.setMeta(concealKey, { readOnly: false }))
    expectConsistent(state, 'after leaving readOnly')

    state = state.apply(state.tr.setMeta(concealKey, { composing: true }))
    const at = state.selection.from
    state = state.apply(state.tr.insertText('ime', at, at))
    state = state.apply(state.tr.setMeta(concealKey, { composing: false }))
    expectConsistent(state, 'after IME composition ends')
  })

  test('long randomised edit + caret session stays consistent', () => {
    let seed = 0x2f6e2b1
    const rnd = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed) / 0x7fffffff
    }
    const alphabet = ['a', 'Z', ' ', '*', '#', '-', '`', '|', '>', '[', ']', '(', ')']

    let state = start()
    for (let step = 0; step < 300; step++) {
      const size = state.doc.content.size
      const roll = rnd()
      if (roll < 0.45) {
        const pos = 1 + Math.floor(rnd() * Math.max(1, size - 2))
        const ch = alphabet[Math.floor(rnd() * alphabet.length)]!
        state = state.apply(state.tr.insertText(ch, pos, pos))
      } else if (roll < 0.7) {
        const pos = 1 + Math.floor(rnd() * Math.max(1, size - 3))
        const $pos = state.doc.resolve(pos)
        // only delete inside a text block, so the step stays a plain text edit
        if ($pos.parent.isTextblock && $pos.parentOffset < $pos.parent.content.size) {
          state = state.apply(state.tr.delete(pos, pos + 1))
        }
      } else {
        state = caret(state, 1 + Math.floor(rnd() * Math.max(1, size - 2)))
      }
      expectConsistent(state, `random step ${step}`)
    }
  })
})

describe('incremental decorations after the new editing commands', () => {
  function posIn(md: string, needle: string, offset = 0): number {
    const lines = md.split('\n')
    let pos = 0
    for (const line of lines) {
      const i = line.indexOf(needle)
      if (i >= 0) return pos + 1 + i + offset
      pos += line.length + 2
    }
    throw new Error(needle)
  }
  function apply(state: EditorState, cmd: typeof continueListItem): EditorState {
    let out = state
    expect(cmd(state, (tr) => (out = state.apply(tr)))).toBe(true)
    return out
  }

  test('Enter at todo content start (insert above)', () => {
    let state = caret(start(), posIn(DOC, 'done item'))
    state = apply(state, continueListItem)
    expectConsistent(state, 'todo insert above')
  })

  test('Enter mid-bold (close/reopen markers)', () => {
    let state = caret(start(), posIn(DOC, 'bold', 2))
    state = apply(state, continueListItem)
    expectConsistent(state, 'inline split')
  })

  test('fence auto-close, heading shortcut, forward delete, backspace dedent', () => {
    const md = 'intro\n```js\npara\n- a\n  - b\nend'
    let state = caret(start(md), posIn(md, '```js', 5))
    state = apply(state, closeFenceOnEnter)
    expectConsistent(state, 'fence close')
    state = caret(state, posIn(docText(state), 'intro', 2))
    state = apply(state, setHeading(2))
    expectConsistent(state, 'set heading')
    state = caret(state, posIn(docText(state), 'para', 4))
    state = apply(state, deleteForwardStripPrefix)
    expectConsistent(state, 'forward delete')
    state = caret(state, posIn(docText(state), '  - b', 4))
    state = apply(state, backspaceBlockFormat)
    expectConsistent(state, 'backspace dedent')
  })
})

function docText(state: EditorState): string {
  const lines: string[] = []
  state.doc.forEach((b) => lines.push(b.textContent))
  return lines.join('\n')
}
