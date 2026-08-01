import { describe, expect, test } from 'bun:test'
import { parseInline } from '../src/parse/inline'

describe('parseInline', () => {
  test('strong with ** and __', () => {
    const els = parseInline('a **bold** and __also__')
    const strongs = els.filter((e) => e.kind === 'strong')
    expect(strongs.length).toBe(2)
    expect(strongs[0].from).toBe(2)
    expect(strongs[0].to).toBe(10)
    expect(strongs[0].markers).toEqual([
      { from: 2, to: 4 },
      { from: 8, to: 10 },
    ])
    expect(strongs[0].content).toEqual({ from: 4, to: 8 })
  })

  test('em nested inside strong still parses', () => {
    const els = parseInline('**bold *em* tail**')
    expect(els.map((e) => e.kind).sort()).toEqual(['em', 'strong'])
    const em = els.find((e) => e.kind === 'em')!
    expect(em.from).toBe(7)
    expect(em.to).toBe(11)
  })

  test('code span shields inner markers', () => {
    const els = parseInline('`**x**`')
    expect(els.length).toBe(1)
    expect(els[0].kind).toBe('code')
    expect(els[0].content).toEqual({ from: 1, to: 6 })
  })

  test('link with href', () => {
    const els = parseInline('see [bear](https://bear.app) app')
    const link = els.find((e) => e.kind === 'link')!
    expect(link.attrs?.href).toBe('https://bear.app')
    expect(link.content).toEqual({ from: 5, to: 9 })
  })

  test('image parsed before link', () => {
    const els = parseInline('![alt](pic.png)')
    expect(els.length).toBe(1)
    expect(els[0].kind).toBe('image')
    expect(els[0].attrs?.href).toBe('pic.png')
    expect(els[0].attrs?.alt).toBe('alt')
  })

  test('strike', () => {
    const els = parseInline('~~gone~~')
    expect(els[0].kind).toBe('strike')
    expect(els[0].content).toEqual({ from: 2, to: 6 })
  })

  test('highlight mark ==text==', () => {
    const els = parseInline('see ==Markdown editor== now')
    const mark = els.find((e) => e.kind === 'mark')!
    expect(mark.from).toBe(4)
    expect(mark.to).toBe(23)
    expect(mark.content).toEqual({ from: 6, to: 21 })
    expect(mark.markers).toEqual([
      { from: 4, to: 6 },
      { from: 21, to: 23 },
    ])
  })

  test('em wrapping strong nests both', () => {
    const src = '*Your writing starts with **Lettera**.*'
    const els = parseInline(src)
    expect(els.map((e) => e.kind).sort()).toEqual(['em', 'strong'])
    const em = els.find((e) => e.kind === 'em')!
    const strong = els.find((e) => e.kind === 'strong')!
    expect(em.from).toBe(0)
    expect(em.to).toBe(src.length)
    expect(src.slice(strong.from, strong.to)).toBe('**Lettera**')
    expect(src.slice(em.content!.from, em.content!.to)).toBe('Your writing starts with **Lettera**.')
  })

  test('bear-style tag is static', () => {
    const els = parseInline('note #work/deep 结束')
    const tag = els.find((e) => e.kind === 'tag')!
    expect(tag.static).toBe(true)
    expect(tag.from).toBe(5)
    expect(tag.to).toBe(15)
  })

  test('tag after CJK punctuation', () => {
    const els = parseInline('样式：#demo/handymd')
    expect(els.filter((e) => e.kind === 'tag').length).toBe(1)
  })

  test('multiplication is not emphasis', () => {
    expect(parseInline('2*3*4')).toEqual([])
  })

  test('snake_case is not emphasis', () => {
    expect(parseInline('foo_bar_baz')).toEqual([])
  })

  test('broken marker dissolves element', () => {
    // Revealed 态删掉一个 * → 元素解散为纯文本（零成本：无元素即无 decoration）
    expect(parseInline('**bold*').filter((e) => e.kind === 'strong')).toEqual([])
  })
})
