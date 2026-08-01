import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { concealPlugin } from '../src/conceal/plugin'
import { interactionsPlugin } from '../src/interactions'
import { createDiagramRenderCallback, type DiagramRenderer } from '../src/diagram'
import { markdownToDoc } from '../src/markdown'

const tick = () => new Promise((r) => setTimeout(r, 0))

function container(): HTMLElement {
  return document.createElement('div')
}

describe('createDiagramRenderCallback', () => {
  test('sync renderer fills immediately and caches', () => {
    let calls = 0
    const fill = createDiagramRenderCallback((code) => {
      calls++
      return `<svg data-code="${code}"></svg>`
    })
    const el = container()
    fill(el, 'graph TD', 'mermaid')
    expect(el.innerHTML).toContain('data-code="graph TD"')
    expect(el.classList.contains('hm-diagram-loading')).toBe(false)

    // 相同源码第二次渲染命中缓存，不再调用 renderer
    fill(container(), 'graph TD', 'mermaid')
    expect(calls).toBe(1)
  })

  test('async renderer shows loading placeholder then fills in place', async () => {
    const fill = createDiagramRenderCallback(async (code) => `<svg>${code}</svg>`)
    const el = container()
    fill(el, 'pie', 'mermaid')
    expect(el.classList.contains('hm-diagram-loading')).toBe(true)
    expect(el.textContent).toBe('mermaid')
    await tick()
    expect(el.innerHTML).toBe('<svg>pie</svg>')
    expect(el.classList.contains('hm-diagram-loading')).toBe(false)

    // 缓存命中：新容器同步填充
    const el2 = container()
    fill(el2, 'pie', 'mermaid')
    expect(el2.innerHTML).toBe('<svg>pie</svg>')
  })

  test('render failure shows error state and is cached', async () => {
    let calls = 0
    const fill = createDiagramRenderCallback(async () => {
      calls++
      throw new Error('Parse error on line 1')
    })
    const el = container()
    fill(el, 'bad code', 'mermaid')
    await tick()
    expect(el.classList.contains('hm-diagram-error')).toBe(true)
    expect(el.textContent).toBe('Parse error on line 1')

    const el2 = container()
    fill(el2, 'bad code', 'mermaid')
    expect(el2.classList.contains('hm-diagram-error')).toBe(true)
    expect(calls).toBe(1)
  })

  test('requests queue until the renderer promise resolves', async () => {
    let resolveRenderer!: (r: DiagramRenderer) => void
    const fill = createDiagramRenderCallback(
      new Promise<DiagramRenderer>((r) => {
        resolveRenderer = r
      }),
    )
    const el = container()
    fill(el, 'graph LR', 'mermaid')
    expect(el.classList.contains('hm-diagram-loading')).toBe(true)

    resolveRenderer((code) => `<svg>${code}</svg>`)
    await tick()
    expect(el.innerHTML).toBe('<svg>graph LR</svg>')
  })
})

function createView(md: string, cursor: number): EditorView {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let state = EditorState.create({
    doc: markdownToDoc(md),
    plugins: [
      concealPlugin({
        renderDiagram: createDiagramRenderCallback((code) => `<svg>${code}</svg>`),
      }),
      interactionsPlugin(),
    ],
  })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)))
  return new EditorView(el, { state })
}

describe('diagram block in the view (Live Render)', () => {
  const MD = '```mermaid\ngraph TD\nA-->B\n```\nafter'

  test('concealed diagram renders widget with SVG; source lines collapse', () => {
    const view = createView(MD, MD.length) // 光标在 after 行附近（区域外）
    const widget = view.dom.querySelector('.hm-diagram') as HTMLElement
    expect(widget).toBeTruthy()
    expect(widget.querySelector('svg')).toBeTruthy()
    expect(widget.textContent).toContain('graph TD')
    expect(view.dom.querySelectorAll('.hm-diagram-hidden').length).toBe(3) // 两行体 + close
    expect(view.dom.querySelectorAll('.hm-diagram-host').length).toBe(1)
    view.destroy()
  })

  test('cursor inside the region shows source instead of widget', () => {
    // 光标放进第一行体（```mermaid 行 nodeSize = 12 → 体行文本起点 = 13）
    const view = createView(MD, 14)
    expect(view.dom.querySelector('.hm-diagram')).toBeNull()
    expect(view.dom.querySelectorAll('.hm-code-line').length).toBe(2)
    expect(view.dom.querySelectorAll('.hm-fence-open').length).toBe(1)
    expect(view.dom.querySelectorAll('.hm-fence-close').length).toBe(1)
    view.destroy()
  })

  test('empty diagram keeps a clickable placeholder instead of vanishing', () => {
    const view = createView('```mermaid\n```\nafter', 20)
    const widget = view.dom.querySelector('.hm-diagram') as HTMLElement
    expect(widget).toBeTruthy()
    expect(widget.classList.contains('hm-diagram-empty')).toBe(true)
    view.destroy()
  })

  test('mousedown on the widget moves the caret into the fence (reveals source)', () => {
    const view = createView(MD, MD.length)
    const widget = view.dom.querySelector('.hm-diagram') as HTMLElement
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(evt, 'target', { value: widget })
    const handler = (
      interactionsPlugin().props as {
        handleDOMEvents: { mousedown: (v: EditorView, e: Event) => boolean }
      }
    ).handleDOMEvents.mousedown
    expect(handler(view, evt)).toBe(true)
    // 光标应落在 ```mermaid 行末尾（pos 1 + 'mermaid 行文本长度' 10 = 11）
    expect(view.state.selection.from).toBe(11)
    // 区域 Revealed：widget 消失，源码可见
    expect(view.dom.querySelector('.hm-diagram')).toBeNull()
    expect(view.dom.querySelectorAll('.hm-code-line').length).toBe(2)
    view.destroy()
  })
})
