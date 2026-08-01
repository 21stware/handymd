import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { concealPlugin, concealKey } from '../src/conceal/plugin'
import { interactionsPlugin } from '../src/interactions'
import { caretGuardPlugin } from '../src/caret'
import { markdownToDoc, docToMarkdown } from '../src/markdown'

function createView(md: string, cursor: number, onOpenLink?: (h: string) => void): EditorView {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let state = EditorState.create({
    doc: markdownToDoc(md),
    plugins: [
      concealPlugin(),
      caretGuardPlugin(),
      interactionsPlugin(onOpenLink ? { onOpenLink } : undefined),
    ],
  })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)))
  return new EditorView(el, { state })
}

describe('interactionsPlugin', () => {
  test('checkbox mousedown toggles source and keeps selection', () => {
    const md = '- [ ] task\n\nother'
    // cursor on last line
    const view = createView(md, md.length) // approximate; guard/plugins will clamp
    const beforeSel = view.state.selection.from
    const box = view.dom.querySelector('input.hm-checkbox') as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.checked).toBe(false)

    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    const handled = (
      interactionsPlugin().props as {
        handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean }
      }
    ).handleDOMEvents.mousedown(view, evt)

    // Directly invoke with target set
    Object.defineProperty(evt, 'target', { value: box })
    const plugin = interactionsPlugin()
    const handler = (
      plugin.props as { handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean } }
    ).handleDOMEvents.mousedown
    expect(handler(view, evt)).toBe(true)
    expect(docToMarkdown(view.state.doc)).toBe('- [x] task\n\nother')
    expect(view.state.selection.from).toBe(beforeSel)
    void handled
    view.destroy()
  })

  test('checkbox toggles checked back to unchecked', () => {
    const view = createView('- [x] done', 1)
    const box = view.dom.querySelector('input.hm-checkbox') as HTMLInputElement
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(evt, 'target', { value: box })
    const handler = (
      interactionsPlugin().props as {
        handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean }
      }
    ).handleDOMEvents.mousedown
    expect(handler(view, evt)).toBe(true)
    expect(docToMarkdown(view.state.doc)).toBe('- [ ] done')
    view.destroy()
  })

  test('concealed link opens; revealed link does not', () => {
    const opened: string[] = []
    const md = 'see [bear](https://bear.app) end'
    // cursor at start → link concealed
    const view = createView(md, 1, (h) => opened.push(h))
    const st = concealKey.getState(view.state)!
    const link = st.blocks[0].elements.find((e) => e.kind === 'link')!
    const linkMid = Math.floor((link.from + link.to) / 2)

    const mkEvt = () => {
      const evt = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      })
      return evt
    }

    const handler = (
      interactionsPlugin({ onOpenLink: (h) => opened.push(h) }).props as {
        handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean }
      }
    ).handleDOMEvents.mousedown

    // stub posAtCoords → inside concealed link
    const stub = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(view), 'posAtCoords')
    Object.defineProperty(view, 'posAtCoords', {
      configurable: true,
      value: () => ({ pos: linkMid, inside: linkMid }),
    })

    expect(handler(view, mkEvt())).toBe(true)
    expect(opened).toEqual(['https://bear.app'])

    // move cursor into link → revealed; click should NOT open
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linkMid)))
    opened.length = 0
    expect(handler(view, mkEvt())).toBe(false)
    expect(opened).toEqual([])

    void stub
    view.destroy()
  })

  test('ctrl/meta click on concealed link enters edit instead of opening', () => {
    const opened: string[] = []
    // 光标放在链接外，保证 Concealed
    const md = 'see [bear](https://bear.app) end'
    const view = createView(md, 1, (h) => opened.push(h))
    const link = concealKey.getState(view.state)!.blocks[0].elements.find((e) => e.kind === 'link')!
    const enterPos = link.from + 2
    Object.defineProperty(view, 'posAtCoords', {
      configurable: true,
      value: () => ({ pos: enterPos, inside: enterPos }),
    })
    const evt = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    })
    const handler = (
      interactionsPlugin({ onOpenLink: (h) => opened.push(h) }).props as {
        handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean }
      }
    ).handleDOMEvents.mousedown
    expect(handler(view, evt)).toBe(true)
    expect(opened).toEqual([])
    expect(view.state.selection.from).toBe(enterPos)
    view.destroy()
  })
})
