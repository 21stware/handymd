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

  test('fence state machine', () => {
    const lines = classifyLines(['```js', 'const a = 1', '# not a heading', '```', 'after'])
    expect(lines.map((l) => l.t)).toEqual(['fenceOpen', 'code', 'code', 'fenceClose', 'para'])
    expect(lines[0]).toMatchObject({ info: 'js', tickLen: 3 })
  })

  test('unclosed fence swallows the rest', () => {
    const lines = classifyLines(['```', 'a', 'b'])
    expect(lines.map((l) => l.t)).toEqual(['fenceOpen', 'code', 'code'])
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
