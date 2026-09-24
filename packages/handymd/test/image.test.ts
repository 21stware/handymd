import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { markdownToDoc } from '../src/markdown'
import { concealPlugin } from '../src/conceal/plugin'
import { imageMarkdown, imagePlugin, insertImage, insertImageFiles, selectedImage } from '../src/image'
import { createLocalImageStore } from '../src/imagestore'
import { createEditor } from '../src/editor'

function lines(state: EditorState): string[] {
  const out: string[] = []
  state.doc.forEach((b) => out.push(b.textContent))
  return out
}

describe('imageMarkdown', () => {
  test('escapes alt brackets and src spaces / parens', () => {
    expect(imageMarkdown({ src: 'a b(1).png', alt: 'x [y]' })).toBe('![x  y](a%20b%281%29.png)')
  })
})

describe('insertImage', () => {
  test('empty line becomes the image line; caret moves below it', () => {
    let state = EditorState.create({ doc: markdownToDoc('intro\n'), plugins: [concealPlugin()] })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))
    insertImage({ src: 'https://x/y.png', alt: 'y' })(state, (tr) => (state = state.apply(tr)))
    expect(lines(state)).toEqual(['intro', '![y](https://x/y.png)', ''])
    expect(state.selection.$from.parent.textContent).toBe('')
  })

  test('non-empty line: image goes on the next line', () => {
    let state = EditorState.create({ doc: markdownToDoc('intro\nnext'), plugins: [concealPlugin()] })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
    insertImage({ src: 'p.png' })(state, (tr) => (state = state.apply(tr)))
    expect(lines(state)).toEqual(['intro', '![](p.png)', '', 'next'])
  })

  test('HandyEditor.insertImage API', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor({ mount: el, content: '' })
    expect(ed.insertImage({ src: 'a.png', alt: 'A' })).toBe(true)
    expect(ed.getMarkdown()).toBe('![A](a.png)\n')
    await ed.destroy()
    el.remove()
  })
})

describe('insertImageFiles', () => {
  function mount(md: string) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const view = new EditorView(el, {
      state: EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin()] }),
    })
    return { view, cleanup: () => (view.destroy(), el.remove()) }
  }

  test('placeholder is replaced by the uploaded URL', async () => {
    const { view, cleanup } = mount('')
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const done = insertImageFiles(view, [file], async () => 'https://cdn/shot.png')
    expect(lines(view.state)[0]).toMatch(/^!\[shot\]\(.+\)$/)
    await done
    expect(lines(view.state)).toEqual(['![shot](https://cdn/shot.png)', ''])
    cleanup()
  })

  test('failed upload removes the placeholder', async () => {
    const { view, cleanup } = mount('')
    const file = new File(['x'], 'bad.png', { type: 'image/png' })
    const orig = console.error
    console.error = () => {}
    await insertImageFiles(view, [file], async () => {
      throw new Error('nope')
    })
    console.error = orig
    expect(lines(view.state)).toEqual(['', ''])
    cleanup()
  })

  test('non-image files are ignored', async () => {
    const { view, cleanup } = mount('keep')
    await insertImageFiles(view, [new File(['x'], 'a.txt', { type: 'text/plain' })])
    expect(lines(view.state)).toEqual(['keep'])
    cleanup()
  })
})

describe('image as an atomic element', () => {
  const IMG = '![cat](c.png)'

  function mount(md: string, resolveImage?: (src: string) => string | Promise<string>) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const view = new EditorView(el, {
      state: EditorState.create({
        doc: markdownToDoc(md),
        plugins: [concealPlugin({ resolveImage }), imagePlugin()],
      }),
    })
    const caret = (from: number, to = from) =>
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    const key = (k: string) =>
      view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: k }))) ?? false
    return { view, el, caret, key, cleanup: () => (view.destroy(), el.remove()) }
  }

  test('never reveals its source; selection covering it paints the selected state', () => {
    const { view, el, caret, cleanup } = mount(`a\n${IMG}\nb`)
    const imgFrom = 4
    caret(imgFrom + 3)
    // caret inside the hidden source snaps to selecting the whole image
    expect(view.state.selection.from).toBe(imgFrom)
    expect(view.state.selection.to).toBe(imgFrom + IMG.length)
    expect(selectedImage(view.state)?.attrs?.href).toBe('c.png')
    expect(el.querySelector('img.hm-image.hm-image-selected')).not.toBeNull()
    expect(el.querySelector('.hm-image-alt')).toBeNull()
    expect(el.querySelectorAll('.hm-concealed').length).toBeGreaterThan(0)
    caret(1)
    expect(el.querySelector('img.hm-image-selected')).toBeNull()
    expect(el.querySelector('img.hm-image')).not.toBeNull()
    cleanup()
  })

  test('Backspace after an image selects it, the next Backspace-equivalent deletes it', () => {
    const { view, caret, key, cleanup } = mount(`a\n${IMG}\nb`)
    caret(4 + IMG.length)
    expect(key('Backspace')).toBe(true)
    expect(selectedImage(view.state)).not.toBeNull()
    view.dispatch(view.state.tr.deleteSelection())
    expect(lines(view.state)).toEqual(['a', '', 'b'])
    cleanup()
  })

  test('Delete before an image selects it; arrows step over it', () => {
    const { view, caret, key, cleanup } = mount(`x ${IMG} y`)
    caret(3)
    expect(key('Delete')).toBe(true)
    expect(view.state.selection.from).toBe(3)
    expect(view.state.selection.to).toBe(3 + IMG.length)
    expect(key('ArrowRight')).toBe(true)
    expect(view.state.selection.empty).toBe(true)
    expect(view.state.selection.from).toBe(3 + IMG.length)
    expect(key('ArrowLeft')).toBe(true)
    expect(selectedImage(view.state)).not.toBeNull()
    expect(key('ArrowLeft')).toBe(true)
    expect(view.state.selection.from).toBe(3)
    cleanup()
  })

  test('Enter on a selected image opens a line after it instead of deleting it', () => {
    const { view, caret, key, cleanup } = mount(IMG)
    caret(1, 1 + IMG.length)
    expect(key('Enter')).toBe(true)
    expect(lines(view.state)).toEqual([IMG, ''])
    expect(view.state.selection.$from.parent.textContent).toBe('')
    cleanup()
  })

  test('range selection never ends halfway into an image', () => {
    const { view, caret, cleanup } = mount(`ab ${IMG}`)
    caret(2, 4 + 5)
    expect(view.state.selection.from).toBe(2)
    expect(view.state.selection.to).toBe(4 + IMG.length)
    cleanup()
  })

  test('resolveImage maps the markdown src for rendering only', async () => {
    const { view, el, cleanup } = mount(`![x](assets/x.png)`, async (src) => `blob:${src}`)
    await new Promise((r) => setTimeout(r, 0))
    const img = el.querySelector('img.hm-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:assets/x.png')
    expect(lines(view.state)).toEqual(['![x](assets/x.png)'])
    cleanup()
  })
})

describe('createLocalImageStore', () => {
  test('stores files under a short assets/ path and resolves them back', async () => {
    const store = createLocalImageStore({ dbName: null })
    const file = new File(['hello'], 'My Shot (1).PNG', { type: 'image/png' })
    const path = await store.upload(file)
    expect(path).toMatch(/^assets\/My-Shot-1-[0-9a-f]+\.png$/)
    expect(await store.get(path)).toBe(file)
    const url = await store.resolve(path)
    expect(url).not.toBe(path)
    expect(await store.resolve('https://x/y.png')).toBe('https://x/y.png')
  })

  test('same content → same path', async () => {
    const store = createLocalImageStore({ dbName: null })
    const a = await store.upload(new File(['same'], 'a.png', { type: 'image/png' }))
    const b = await store.upload(new File(['same'], 'a.png', { type: 'image/png' }))
    expect(a).toBe(b)
  })
})
