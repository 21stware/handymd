import { describe, expect, test } from 'bun:test'
import { TextSelection } from 'prosemirror-state'
import { createEditor } from '../src/editor'
import { focusTableCell } from '../src/conceal/tableview'
import { concealKey } from '../src/conceal/plugin'
import { buildPrintDocument, printableClone } from '../src/export'

async function mount(md: string) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor({ mount: el, content: md })
  await new Promise((r) => setTimeout(r, 0))
  return { editor, el, cleanup: async () => (await editor.destroy(), el.remove()) }
}

describe('export to PDF', () => {
  test('printable clone drops editing chrome and keeps checkbox state', async () => {
    const { editor, cleanup } = await mount('- [x] done\n\n| A | B |\n| --- | --- |\n| **c** | d |')
    const view = editor.view!
    const headerPos = concealKey.getState(view.state)!.blocks.find((b) => b.line.t === 'tableHeader')!.pos
    focusTableCell(view, headerPos, { row: 1, col: 0 })
    const clone = printableClone(view.dom)
    expect(clone.querySelector('.hm-table-ui')).toBeNull()
    expect(clone.querySelector('[contenteditable]')).toBeNull()
    expect(clone.querySelector('.hm-table-cell-editing')).toBeNull()
    // 编辑中的格子导出为预览（隐藏 `**`）
    const cell = clone.querySelector('[data-row="1"][data-col="0"]')!
    expect(cell.textContent).toBe('c')
    expect(cell.querySelector('.hm-strong')).not.toBeNull()
    expect(clone.querySelector('input.hm-checkbox')!.hasAttribute('checked')).toBe(true)
    await cleanup()
  })

  test('print document carries the title and a print wrapper', async () => {
    const { editor, cleanup } = await mount('# My Doc\n\nbody')
    const html = buildPrintDocument(editor.view!)
    expect(html).toContain('<title>My Doc</title>')
    expect(html).toContain('class="handymd hm-print"')
    expect(html).toContain('body')
    await cleanup()
  })

  test('exportToPDF prints the rendered state and restores the editor', async () => {
    const { editor, cleanup } = await mount('# T\n\nsee **bold** here')
    const view = editor.view!
    // 光标放进 **bold**，源码 reveal
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)))
    let printed = ''
    await editor.exportToPDF({
      title: 'x',
      timeout: 50,
      print: (w) => {
        printed = w.document.body.innerHTML
      },
    })
    expect(printed).toContain('hm-print')
    expect(printed).not.toMatch(/class="hm-marker"(?! hm-concealed)/)
    expect(concealKey.getState(view.state)!.readOnly).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
    await cleanup()
  })
})
