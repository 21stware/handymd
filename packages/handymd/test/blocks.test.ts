import { describe, expect, test } from 'bun:test'
import { classifyLines } from '../src/parse/blocks'

describe('classifyLines', () => {
  test('basic block kinds', () => {
    const lines = classifyLines([
      '# Title',
      '',
      '> quoted',
      '- [ ] open todo',
      '- [x] done todo',
      '- bullet',
      '3. ordered',
      '---',
      'plain',
    ])
    expect(lines.map((l) => l.t)).toEqual([
      'heading',
      'blank',
      'quote',
      'todo',
      'todo',
      'bullet',
      'ordered',
      'hr',
      'para',
    ])
    expect(lines[0]).toMatchObject({ level: 1, prefixLen: 2 })
    expect(lines[3]).toMatchObject({ checked: false, prefixLen: 6, checkOffset: 3 })
    expect(lines[4]).toMatchObject({ checked: true })
    expect(lines[6]).toMatchObject({ num: 3, numLen: 1, prefixLen: 3 })
  })

  test('heading requires a space after hashes; bare # / #tag / #标题 stay plain', () => {
    const lines = classifyLines(['#标题', '##你好', '#tag', '# Tag', '#', '##', '## '])
    expect(lines[0]).toMatchObject({ t: 'para' })
    expect(lines[1]).toMatchObject({ t: 'para' })
    expect(lines[2]).toMatchObject({ t: 'para' })
    expect(lines[3]).toMatchObject({ t: 'heading', level: 1, prefixLen: 2 })
    expect(lines[4]).toMatchObject({ t: 'para' })
    expect(lines[5]).toMatchObject({ t: 'para' })
    expect(lines[6]).toMatchObject({ t: 'heading', level: 2, prefixLen: 3 })
  })

  test('fence state machine', () => {
    const lines = classifyLines(['```js', 'const a = 1', '# not a heading', '```', 'after'])
    expect(lines.map((l) => l.t)).toEqual(['fenceOpen', 'code', 'code', 'fenceClose', 'para'])
    expect(lines[0]).toMatchObject({ info: 'js', tickLen: 3 })
  })

  test('unclosed fence swallows the rest', () => {
    const lines = classifyLines(['```', 'a', 'b'])
    expect(lines.map((l) => l.t)).toEqual(['fenceOpen', 'code', 'code'])
  })

  test('mermaid fence splits into a diagram block at parse time', () => {
    const lines = classifyLines(['```mermaid', 'graph TD', 'A-->B', '```', 'after'])
    expect(lines.map((l) => l.t)).toEqual([
      'diagramOpen',
      'diagramLine',
      'diagramLine',
      'diagramClose',
      'para',
    ])
    expect(lines[0]).toMatchObject({ info: 'mermaid', lang: 'mermaid', tickLen: 3 })
  })

  test('diagram lang detection: first info token, case-insensitive, extra tokens ok', () => {
    expect(classifyLines(['```Mermaid theme=dark'])[0]).toMatchObject({
      t: 'diagramOpen',
      lang: 'mermaid',
      info: 'Mermaid theme=dark',
    })
    // 非图表语言仍是 code block
    expect(classifyLines(['```mermaidx'])[0].t).toBe('fenceOpen')
    expect(classifyLines(['```js'])[0].t).toBe('fenceOpen')
  })

  test('~~~ diagram fence and unclosed diagram', () => {
    const closed = classifyLines(['~~~mermaid', 'pie', '~~~'])
    expect(closed.map((l) => l.t)).toEqual(['diagramOpen', 'diagramLine', 'diagramClose'])
    const open = classifyLines(['```mermaid', 'graph TD'])
    expect(open.map((l) => l.t)).toEqual(['diagramOpen', 'diagramLine'])
  })

  test('hr beats bullet for ---', () => {
    expect(classifyLines(['---'])[0].t).toBe('hr')
    expect(classifyLines(['***'])[0].t).toBe('hr')
    expect(classifyLines(['- x'])[0].t).toBe('bullet')
  })

  test('indented todo', () => {
    const [line] = classifyLines(['  - [ ] nested'])
    expect(line).toMatchObject({ t: 'todo', indent: 2, prefixLen: 8, checkOffset: 5 })
  })
})
