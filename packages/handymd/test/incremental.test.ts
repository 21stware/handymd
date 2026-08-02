/**
 * Correctness for incremental parse + conceal paths.
 * (Performance numbers live in perf.test.ts.)
 */
import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { concealKey, concealPlugin } from '../src/conceal/plugin'
import { markdownToDoc } from '../src/markdown'
import { parseDoc, parseDocIncremental } from '../src/parse/docparse'

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

function simplifyBlocks(blocks: ReturnType<typeof parseDoc>) {
  return blocks.map((b) => ({
    pos: b.pos,
    size: b.size,
    text: b.text,
    line: b.line,
    elements: b.elements.map((e) => ({
      kind: e.kind,
      from: e.from,
      to: e.to,
      hitFrom: e.hitFrom,
      hitTo: e.hitTo,
      markers: e.markers,
      content: e.content,
      attrs: e.attrs,
      permanent: e.permanent,
      static: e.static,
      scope: e.scope,
    })),
  }))
}

describe('parseDocIncremental', () => {
  test('identity mapping (empty tr) matches parseDoc', () => {
    const md = [
      '# Title',
      '',
      'para **bold** and *em*',
      '- [ ] todo',
      '> quote',
      '```ts',
      'const x = 1',
      '```',
      '| A | B |',
      '| --- | --- |',
      '| [x](u) | y |',
      '```mermaid',
      'A-->B',
      '```',
    ].join('\n')
    const doc = markdownToDoc(md)
    const full = parseDoc(doc)
    // Empty mapping: map every pos to itself via a no-op tr
    const state = EditorState.create({ doc })
    const tr = state.tr // no steps
    const inc = parseDocIncremental(doc, full, tr.mapping)
    expect(simplifyBlocks(inc)).toEqual(simplifyBlocks(full))
  })

  test('single-char insert: distant lines map without re-parse structure drift', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i} has **x${i}** marks`)
    lines[0] = 'FIRST'
    const md = lines.join('\n')
    let state = EditorState.create({ doc: markdownToDoc(md) })
    const prev = parseDoc(state.doc)

    const tr = state.tr.insertText('Z', 1, 1)
    state = state.apply(tr)
    const inc = parseDocIncremental(state.doc, prev, tr.mapping)
    const full = parseDoc(state.doc)

    expect(simplifyBlocks(inc)).toEqual(simplifyBlocks(full))
    expect(inc[0]!.text.startsWith('Z')).toBe(true)
    // last line still has strong
    expect(inc[29]!.elements.some((e) => e.kind === 'strong')).toBe(true)
  })

  test('newline insert splits block and still matches full parse', () => {
    const md = 'aaa\nbbb\nccc'
    let state = EditorState.create({ doc: markdownToDoc(md) })
    const prev = parseDoc(state.doc)
    // insert newline after first char of first line → split "aaa" into "a" + "aa"
    const tr = state.tr.insertText('\n', 2, 2)
    // PM doc is block-based: insertText('\n') inserts newline character inside block, not new block
    // Real new block comes from enter keymap. Simulate replaceWith new structure via setMarkdown style:
    const nextDoc = markdownToDoc('a\naa\nbbb\nccc')
    // Build a tr that replaces whole doc
    const tr2 = state.tr.replaceWith(0, state.doc.content.size, nextDoc.content)
    state = state.apply(tr2)
    const inc = parseDocIncremental(state.doc, prev, tr2.mapping)
    const full = parseDoc(state.doc)
    expect(simplifyBlocks(inc)).toEqual(simplifyBlocks(full))
  })

  test('table edge shift after insert re-parses edges correctly', () => {
    const md = ['| H1 | H2 |', '| --- | --- |', '| a | b |'].join('\n')
    let state = EditorState.create({ doc: markdownToDoc(md) })
    const prev = parseDoc(state.doc)
    expect(
      prev[0]!.elements.find((e) => e.kind === 'tableHeader')?.attrs?.tableEdge,
    ).toBe('first')

    // Insert a new body row at end
    const next = markdownToDoc(['| H1 | H2 |', '| --- | --- |', '| a | b |', '| c | d |'].join('\n'))
    const tr = state.tr.replaceWith(0, state.doc.content.size, next.content)
    state = state.apply(tr)
    const inc = parseDocIncremental(state.doc, prev, tr.mapping)
    const full = parseDoc(state.doc)
    expect(simplifyBlocks(inc)).toEqual(simplifyBlocks(full))
    expect(inc[0]!.elements.find((e) => e.kind === 'tableHeader')?.attrs?.tableEdge).toBe('first')
    expect(inc[3]!.elements.find((e) => e.kind === 'tableRow')?.attrs?.tableEdge).toBe('last')
  })

  test('diagram body edit updates open-line code attr', () => {
    const md = '```mermaid\nA-->B\n```\nafter'
    let state = EditorState.create({ doc: markdownToDoc(md) })
    const prev = parseDoc(state.doc)
    expect(prev[0]!.elements.find((e) => e.kind === 'diagramOpen')?.attrs?.code).toBe('A-->B')

    const next = markdownToDoc('```mermaid\nA-->C\n```\nafter')
    const tr = state.tr.replaceWith(0, state.doc.content.size, next.content)
    state = state.apply(tr)
    const inc = parseDocIncremental(state.doc, prev, tr.mapping)
    expect(inc[0]!.elements.find((e) => e.kind === 'diagramOpen')?.attrs?.code).toBe('A-->C')
    expect(simplifyBlocks(inc)).toEqual(simplifyBlocks(parseDoc(state.doc)))
  })
})

describe('conceal selection locality', () => {
  test('selection move far from revealed regions reuses plugin state', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `plain line ${i}`)
    lines[5] = 'see **bold** here'
    const md = lines.join('\n')
    let state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin()],
    })
    // cursor on bold → revealed
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, posOf(md, '**bold**') + 3)),
    )
    // move within same strong → may or may not reuse; leave strong to plain line
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, posOf(md, 'plain line 10') + 2)),
    )
    const mid = concealKey.getState(state)!
    // move within plain line 10 — no reveal change
    const after = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, posOf(md, 'plain line 10') + 4)),
    )
    expect(Object.is(concealKey.getState(after), mid)).toBe(true)
  })

  test('moving onto strong rebuilds only that interaction correctly', () => {
    const md = 'aaa\n\nxxx **bold** yyy\n\nzzz'
    let state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin()],
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(md, 'aaa') + 1)))
    const markersConcealed = concealKey
      .getState(state)!
      .set.find(
        undefined,
        undefined,
        (s) => (s as { kind?: string; role?: string }).kind === 'strong' && (s as { role?: string }).role === 'marker',
      )
    expect(markersConcealed.every((d) => (d.spec as { concealed: boolean }).concealed)).toBe(true)

    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, posOf(md, '**bold**') + 3)),
    )
    const markersRevealed = concealKey
      .getState(state)!
      .set.find(
        undefined,
        undefined,
        (s) => (s as { kind?: string; role?: string }).kind === 'strong' && (s as { role?: string }).role === 'marker',
      )
    expect(markersRevealed.every((d) => !(d.spec as { concealed: boolean }).concealed)).toBe(true)
  })
})

describe('conceal doc-edit incremental vs full', () => {
  test('N keystrokes: incremental path stays consistent with fresh parseDoc', () => {
    const base = Array.from({ length: 25 }, (_, i) => `L${i} **m${i}**`).join('\n')
    let state = EditorState.create({
      doc: markdownToDoc(base),
      plugins: [concealPlugin()],
    })

    for (let k = 0; k < 12; k++) {
      // type at start of doc
      state = state.apply(state.tr.insertText(String(k % 10), 1, 1))
      const st = concealKey.getState(state)!
      const full = parseDoc(state.doc)
      expect(simplifyBlocks(st.blocks)).toEqual(simplifyBlocks(full))
    }
  })
})
