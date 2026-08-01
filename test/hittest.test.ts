import { describe, expect, test } from 'bun:test'
import { isRevealed, revealSignature } from '../src/conceal/hittest'
import type { ElementRange } from '../src/elements'

function el(partial: Partial<ElementRange> & Pick<ElementRange, 'kind' | 'from' | 'to'>): ElementRange {
  return {
    scope: 'inline',
    hitFrom: partial.from - 1,
    hitTo: partial.to + 1,
    markers: [],
    ...partial,
  }
}

describe('isRevealed', () => {
  test('inline adjacency pad: cursor just outside still reveals', () => {
    const strong = el({ kind: 'strong', from: 5, to: 13, hitFrom: 4, hitTo: 14 })
    expect(isRevealed(strong, { from: 4, to: 4 }, false)).toBe(true)
    expect(isRevealed(strong, { from: 14, to: 14 }, false)).toBe(true)
    expect(isRevealed(strong, { from: 3, to: 3 }, false)).toBe(false)
    expect(isRevealed(strong, { from: 15, to: 15 }, false)).toBe(false)
  })

  test('permanent and static never reveal', () => {
    const bullet = el({ kind: 'bullet', scope: 'block', from: 0, to: 10, hitFrom: 0, hitTo: 10, permanent: true })
    const tag = el({ kind: 'tag', from: 0, to: 5, hitFrom: 0, hitTo: 5, static: true })
    expect(isRevealed(bullet, { from: 2, to: 2 }, false)).toBe(false)
    expect(isRevealed(tag, { from: 2, to: 2 }, false)).toBe(false)
  })

  test('readOnly forces conceal even when selection hits', () => {
    const strong = el({ kind: 'strong', from: 5, to: 13, hitFrom: 4, hitTo: 14 })
    expect(isRevealed(strong, { from: 8, to: 8 }, true)).toBe(false)
  })

  test('selection range intersecting element reveals', () => {
    const strong = el({ kind: 'strong', from: 5, to: 13, hitFrom: 4, hitTo: 14 })
    expect(isRevealed(strong, { from: 0, to: 100 }, false)).toBe(true)
    expect(isRevealed(strong, { from: 0, to: 3 }, false)).toBe(false)
  })
})

describe('revealSignature', () => {
  test('encodes boolean array stably', () => {
    expect(revealSignature([true, false, true])).toBe('101')
    expect(revealSignature([])).toBe('')
  })
})
