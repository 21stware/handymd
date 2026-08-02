import { describe, expect, test } from 'bun:test'
import { createEditor } from '../src/editor'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('HandyEditor lifecycle (L1)', () => {
  test('sync content → ready, markdown roundtrip is lossless', async () => {
    const md = '# Hi\n\nhello **bold** [a](b)\n\n```js\ncode\n```'
    const ed = createEditor({ mount: mount(), content: md })
    expect(ed.phase).toBe('ready')
    expect(ed.getMarkdown()).toBe(md)
    await ed.destroy()
    expect(ed.phase).toBe('destroyed')
  })

  test('Loading → Error → retry → Ready', async () => {
    let fail = true
    const ed = createEditor({
      mount: mount(),
      load: async () => {
        if (fail) throw new Error('boom')
        return 'loaded'
      },
    })
    expect(ed.phase).toBe('loading')
    await sleep(5)
    expect(ed.phase).toBe('error')
    fail = false
    ed.retry()
    await sleep(5)
    expect(ed.phase).toBe('ready')
    expect(ed.getMarkdown()).toBe('loaded')
    await ed.destroy()
  })

  test('async load leaves the view editable without any further transaction', async () => {
    // The view is constructed while the phase is still 'loading'; ProseMirror
    // caches `editable` until the next update, so a freshly loaded editor used
    // to stay contenteditable=false until something else dispatched.
    const ed = createEditor({ mount: mount(), load: async () => '# hi' })
    await sleep(5)
    expect(ed.phase).toBe('ready')
    expect(ed.view!.editable).toBe(true)
    expect(ed.view!.dom.getAttribute('contenteditable')).toBe('true')
    await ed.destroy()
  })

  test('sync content is editable too, and readOnly still wins', async () => {
    const ed = createEditor({ mount: mount(), content: '# hi' })
    expect(ed.view!.editable).toBe(true)
    ed.setReadOnly(true)
    expect(ed.view!.editable).toBe(false)
    ed.setReadOnly(false)
    expect(ed.view!.editable).toBe(true)
    await ed.destroy()
  })

  test('editing marks dirty and autosaves; onChange fires', async () => {
    const saved: string[] = []
    const changes: string[] = []
    const ed = createEditor({
      mount: mount(),
      content: 'hello',
      save: async (md) => {
        saved.push(md)
      },
      autosave: { debounceMs: 10, listenOnline: false },
      onChange: (md) => changes.push(md),
    })
    const view = ed.view!
    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1))
    expect(ed.getMarkdown()).toBe('hello!')
    expect(ed.saveStatus).toBe('dirty')
    expect(changes).toEqual(['hello!'])
    await sleep(40)
    expect(saved).toEqual(['hello!'])
    expect(ed.saveStatus).toBe('clean')
    await ed.destroy()
  })

  test('readOnly blocks write transactions but allows programmatic setMarkdown', async () => {
    const ed = createEditor({ mount: mount(), content: 'locked', readOnly: true })
    const view = ed.view!
    view.dispatch(view.state.tr.insertText('x', 1))
    expect(ed.getMarkdown()).toBe('locked') // filterTransaction 拒写
    ed.setMarkdown('replaced')
    expect(ed.getMarkdown()).toBe('replaced')
    ed.setReadOnly(false)
    view.dispatch(view.state.tr.insertText('x', 1))
    expect(ed.getMarkdown()).toBe('xreplaced')
    await ed.destroy()
  })

  test('conflict: remote change with local dirty → Conflicted → resolve', async () => {
    const ed = createEditor({
      mount: mount(),
      content: 'base',
      save: async () => {},
      autosave: { debounceMs: 60_000, listenOnline: false }, // 保持 dirty
    })
    const view = ed.view!
    view.dispatch(view.state.tr.insertText('local-', 1))
    expect(ed.saveStatus).toBe('dirty')

    ed.notifyRemote('remote version')
    expect(ed.phase).toBe('conflicted')
    expect(ed.readOnly).toBe(true) // 冲突期间冻结编辑
    expect(ed.remoteConflict).toBe('remote version')

    ed.resolveConflict('remote')
    expect(ed.phase).toBe('ready')
    expect(ed.readOnly).toBe(false)
    expect(ed.getMarkdown()).toBe('remote version')
    expect(ed.saveStatus).toBe('clean')
    await ed.destroy()
  })

  test('clean local + remote change → applied silently', async () => {
    const ed = createEditor({ mount: mount(), content: 'base' })
    ed.notifyRemote('remote')
    expect(ed.phase).toBe('ready')
    expect(ed.getMarkdown()).toBe('remote')
    await ed.destroy()
  })

  test('destroy flushes pending content', async () => {
    const saved: string[] = []
    const ed = createEditor({
      mount: mount(),
      content: 'a',
      save: async (md) => {
        saved.push(md)
      },
      autosave: { debounceMs: 60_000, listenOnline: false },
    })
    const view = ed.view!
    view.dispatch(view.state.tr.insertText('b', 1))
    await ed.destroy()
    expect(saved).toEqual(['ba'])
  })
})
