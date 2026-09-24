/**
 * 端到端交互验证（真实 Chromium）。
 *
 * 用法：先启动示例（bun run dev:sdk），再 `bun run e2e`。
 * 依赖：`bunx playwright install chromium`
 *
 * 回归约定：交互 / L3 decoration / keymap 的 bug 修复后，优先补
 * `test/*.test.ts`（尤其 decoconsistency / keymap / conceal）；
 * 必须看见真 DOM 或真修饰键时，再在本文件加一条 check。
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.E2E_URL ?? 'http://localhost:3000/'
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

async function reset(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.hm-link')
  await page.waitForTimeout(400)
}

async function stubOpen(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    ;(window as unknown as { __opened: string[] }).__opened = []
    window.open = (...args: Parameters<typeof window.open>) => {
      ;(window as unknown as { __opened: string[] }).__opened.push(String(args[0]))
      return null
    }
  })
  return () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(BASE)
await page.waitForSelector('.ProseMirror')
await reset(page)
const opened = await stubOpen(page)

// ═══════════════════════════════════════════════════════════
// 1. 标题：源码隐藏 / 聚焦出图标 / 行首回车保格式 / 空行光标
// ═══════════════════════════════════════════════════════════
await page.locator('.hm-strong').first().click()
await page.waitForTimeout(80)
check('heading badge hidden when unfocused', (await page.locator('.hm-heading-badge').count()) === 0)

const h1 = page.locator('.hm-h1').first()
await h1.click()
await page.waitForTimeout(80)
check(
  'heading source stays concealed while focused',
  await page.evaluate(
    () => !document.querySelector('.hm-h1 .hm-marker:not(.hm-concealed):not(.hm-caret-pad)'),
  ),
)
check('heading badge shown when focused', (await page.locator('.hm-heading-badge').count()) === 1)

// 行首回车：上方空行，标题保持
await page.keyboard.press('Home')
await page.waitForTimeout(50)
await page.keyboard.press('Enter')
await page.waitForTimeout(100)
const afterHeadingEnter = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.hm-block')]
  const texts = blocks.slice(0, 3).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
  const stillH1 = !!document.querySelector('.hm-h1')
  const h1Text = document.querySelector('.hm-h1')?.textContent ?? ''
  return { texts, stillH1, keepsTitle: h1Text.includes('handymd') }
})
check('Enter at heading start keeps heading on title', afterHeadingEnter.stillH1 && afterHeadingEnter.keepsTitle)

// 空标题光标可见性：新建 `# `
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('# ')
await page.waitForTimeout(120)
check(
  'empty heading has caret-pad',
  (await page.locator('.hm-heading-empty .hm-caret-pad').count()) >= 1 ||
    (await page.locator('.hm-h1 .hm-caret-pad').count()) >= 1,
)
check(
  'empty heading shows badge while focused',
  (await page.locator('.hm-heading-badge').count()) >= 1,
)

await reset(page)
await stubOpen(page)

// ═══════════════════════════════════════════════════════════
// 2. 块级 permanent：bullet / checkbox / quote / hr
// ═══════════════════════════════════════════════════════════
// 把选区塌到文档末尾再开新行（比点 last block 更稳）
await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror') as HTMLElement
  pm.focus()
  const sel = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(pm)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
})
await page.keyboard.press('Enter')
const dotsBefore = await page.locator('.hm-bullet-dot').count()
const boxesBefore = await page.locator('input.hm-checkbox').count()
await page.keyboard.type('- ')
await page.waitForTimeout(150)
const dotsAfter = await page.locator('.hm-bullet-dot').count()
check('typing "- " renders bullet immediately', dotsAfter > dotsBefore, `${dotsBefore}→${dotsAfter}`)

await page.keyboard.type('[x] done')
await page.waitForTimeout(150)
const boxesAfter = await page.locator('input.hm-checkbox').count()
check('typing "[x] " upgrades to checked box', boxesAfter === boxesBefore + 1, `${boxesBefore}→${boxesAfter}`)
check(
  'new checkbox is checked',
  await page.evaluate(() => {
    const todos = [...document.querySelectorAll('.hm-todo')]
    const last = todos[todos.length - 1]
    const text = last?.textContent ?? ''
    const box = last?.querySelector('input.hm-checkbox') as HTMLInputElement | null
    return text.includes('- [x] done') && !!box?.checked
  }),
)
check(
  'todo prefix never reveals while editing',
  await page.evaluate(() => {
    const markers = [...document.querySelectorAll('.hm-todo .hm-marker:not(.hm-caret-pad)')]
    return markers.length > 0 && markers.every((m) => m.classList.contains('hm-concealed'))
  }),
)

// quote 行首光标
await page.locator('.hm-quote').first().click()
await page.keyboard.press('Home')
await page.waitForTimeout(80)
check('quote has caret-pad at prefix end', (await page.locator('.hm-quote .hm-caret-pad').count()) >= 1)
check(
  'caret rests in quote after Home',
  await page.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest('.hm-quote')),
)

// hr 立即渲染
check('hr widget rendered', (await page.locator('hr.hm-hr').count()) >= 1)

// ═══════════════════════════════════════════════════════════
// 3. 行内：嵌套强调 / 高亮笔 / 链接语义
// ═══════════════════════════════════════════════════════════
check(
  'nested em+strong both styled',
  await page.evaluate(() => {
    const strong = [...document.querySelectorAll('.hm-strong')].find((n) => n.textContent?.includes('Lettera'))
    return !!strong && strong.classList.contains('hm-em')
  }),
)
check(
  'highlight mark rendered',
  await page.evaluate(() => {
    const mark = document.querySelector('.hm-mark')
    return !!mark && (mark.textContent ?? '').includes('高亮')
  }),
)

await page.locator('.hm-h1').first().click()
await page.waitForTimeout(80)
const link = page.locator('.hm-link').first()
await link.scrollIntoViewIfNeeded()
const box = (await link.boundingBox())!
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2

await page.mouse.click(cx, cy)
await page.waitForTimeout(120)
check('concealed link click opens URL', (await opened()).length === 1, (await opened()).join(','))
check(
  'cursor did not enter link',
  !(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent?.startsWith('[') ?? false)),
)

await page.mouse.dblclick(cx, cy)
await page.waitForTimeout(120)
check('double-click opens only once more', (await opened()).length === 2, String((await opened()).length))

await page.locator('.hm-h1').first().click()
await page.waitForTimeout(80)
await page.keyboard.down('Control')
await page.mouse.click(cx, cy)
await page.keyboard.up('Control')
await page.waitForTimeout(120)
check('ctrl+click does not open', (await opened()).length === 2)
check(
  'ctrl+click reveals link markers',
  await page.evaluate(() => {
    const t = window.getSelection()?.anchorNode?.textContent ?? ''
    return t.includes('链接') || t.includes('[')
  }),
)

await page.mouse.click(cx, cy)
await page.waitForTimeout(100)
check('click on revealed link edits instead of opening', (await opened()).length === 2)

// ═══════════════════════════════════════════════════════════
// 4. checkbox 点击 / shiki / 只读 / 冲突
// ═══════════════════════════════════════════════════════════
await page.locator('.hm-h1').first().click()
await page.waitForTimeout(80)
const cb = page.locator('input.hm-checkbox').first()
const wasChecked = await cb.isChecked()
await cb.click()
await page.waitForTimeout(150)
check('checkbox toggles source text', (await page.locator('input.hm-checkbox').first().isChecked()) === !wasChecked)
check(
  'checkbox click keeps cursor away',
  await page.evaluate(() => (window.getSelection()?.anchorNode?.textContent ?? '').includes('handymd')),
)

await page.waitForSelector('.hm-code-line span[style*="color"]', { timeout: 10_000 }).catch(() => {})
check(
  'shiki highlights code tokens',
  (await page.locator('.hm-code-line span[style*="color"]').count()) > 0,
  String(await page.locator('.hm-code-line span[style*="color"]').count()),
)

// 只读
await page.locator('#toggle-readonly').click()
await page.waitForTimeout(80)
await page.locator('.hm-h1').first().click()
await page.keyboard.type('XXX')
await page.waitForTimeout(80)
check(
  'readOnly blocks typing',
  await page.evaluate(() => !(document.querySelector('.ProseMirror')?.textContent ?? '').includes('XXX')),
)
check(
  'readOnly keeps heading badge hidden',
  (await page.locator('.hm-heading-badge').count()) === 0,
)
await page.locator('#toggle-readonly').click()
await page.waitForTimeout(80)

// 冲突：先打字置脏，再模拟远端
await page.locator('.hm-strong').first().click()
await page.keyboard.type('!')
await page.waitForTimeout(50)
await page.locator('#simulate-remote').click()
await page.waitForTimeout(150)
check(
  'conflict banner appears when dirty + remote',
  await page.evaluate(() => {
    const el = document.getElementById('conflict')
    return !!el && !el.hidden
  }),
)
await page.locator('#keep-remote').click()
await page.waitForTimeout(150)
check(
  'resolve remote applies remote content',
  await page.evaluate(() => (document.querySelector('.ProseMirror')?.textContent ?? '').includes('远端追加')),
)
check(
  'phase returns to ready after resolve',
  await page.evaluate(() => document.getElementById('phase')?.textContent === 'ready'),
)

// ═══════════════════════════════════════════════════════════
// 5. diagram block：mermaid 渲染 / 点击回源码 / 编辑后重渲染 / 错误态
// ═══════════════════════════════════════════════════════════
await reset(page)

// Concealed：mermaid 渲染成 SVG，源码行折叠
await page.waitForSelector('.hm-diagram svg', { timeout: 15_000 }).catch(() => {})
check('mermaid diagram rendered as SVG', (await page.locator('.hm-diagram svg').count()) === 1)
check(
  'diagram source lines collapse to zero height',
  await page.evaluate(() => {
    const hidden = [...document.querySelectorAll('.hm-diagram-hidden')]
    return hidden.length > 0 && hidden.every((el) => (el as HTMLElement).offsetHeight === 0)
  }),
)

// 点击图表 → 整块回源码（fence 编辑态）
await page.locator('.hm-diagram').click()
await page.waitForTimeout(150)
check('clicking diagram reveals fenced source', (await page.locator('.hm-diagram').count()) === 0)
check(
  'revealed diagram looks like a code fence',
  await page.evaluate(() => {
    const open = [...document.querySelectorAll('.hm-fence-open')]
    return open.some((el) => (el.textContent ?? '').includes('mermaid'))
  }),
)

// 编辑源码，光标离开 → 用新源码重渲染
await page.keyboard.press('ArrowDown')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('    C[新节点] --> A')
await page.locator('.hm-h1').first().click()
await page.waitForSelector('.hm-diagram svg', { timeout: 15_000 }).catch(() => {})
check(
  'edited diagram re-renders with new source',
  await page.evaluate(() => {
    const svg = document.querySelector('.hm-diagram svg')
    return !!svg && (svg.textContent ?? '').includes('新节点')
  }),
)

// 语法错误 → 错误态（仍可点击进入修复）
await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror') as HTMLElement
  pm.focus()
  const sel = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(pm)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
})
await page.keyboard.press('Enter')
await page.keyboard.type('```mermaid')
await page.keyboard.press('Enter')
await page.keyboard.type('this is not a valid diagram !!!')
await page.keyboard.press('Enter')
await page.keyboard.type('```')
await page.locator('.hm-h1').first().click()
await page.waitForSelector('.hm-diagram-error', { timeout: 15_000 }).catch(() => {})
check('invalid mermaid shows error state', (await page.locator('.hm-diagram-error').count()) === 1)

// readOnly：图表保持渲染态，点击不进入编辑
await page.locator('#toggle-readonly').click()
await page.waitForTimeout(120)
check('readOnly keeps diagram rendered', (await page.locator('.hm-diagram svg').count()) === 1)
await page.locator('.hm-diagram').first().click()
await page.waitForTimeout(120)
check(
  'readOnly click does not reveal diagram source',
  (await page.locator('.hm-diagram svg').count()) === 1,
)
await page.locator('#toggle-readonly').click()

// ═══════════════════════════════════════════════════════════
// 6. 回归：Enter 续行保留上一行块样式；Mod-Backspace 只清内容
// ═══════════════════════════════════════════════════════════
await reset(page)

await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror') as HTMLElement
  pm.focus()
  const sel = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(pm)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
})
await page.keyboard.press('Enter')
await page.keyboard.type('> hello quote')
await page.waitForTimeout(120)
await page.keyboard.press('Enter')
await page.waitForTimeout(150)
const quoteAfterEnter = await page.evaluate(() => {
  const quotes = [...document.querySelectorAll('.hm-quote')]
  const texts = quotes.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
  return {
    count: quotes.length,
    keepsPrev: texts.some((t) => t.includes('hello quote')),
  }
})
check(
  'Enter on quote keeps previous line as quote',
  quoteAfterEnter.count >= 2 && quoteAfterEnter.keepsPrev,
  JSON.stringify(quoteAfterEnter),
)

await page.keyboard.press('Enter') // 空 quote 再回车 → 退出块格式
await page.waitForTimeout(80)
await page.keyboard.type('- [ ] keep prefix text')
await page.waitForTimeout(150)
// Mod = Meta on macOS, Control elsewhere (matches ProseMirror keymap)
await page.keyboard.press('ControlOrMeta+Backspace')
await page.waitForTimeout(150)
check(
  'Mod-Backspace keeps checkbox and clears content only',
  await page.evaluate(() => {
    const todos = [...document.querySelectorAll('.hm-todo')]
    const last = todos[todos.length - 1]
    if (!last?.querySelector('input.hm-checkbox')) return false
    const raw = last.textContent ?? ''
    return raw.includes('- [ ]') && !raw.includes('keep prefix text')
  }),
)

// ═══════════════════════════════════════════════════════════
// 7. 行首 / 选区 / 剪贴板 / Tab / Shift-Enter / 源码模式（需要真实浏览器行为）
// ═══════════════════════════════════════════════════════════
async function loadDoc(md: string): Promise<void> {
  await page.evaluate((m) => localStorage.setItem('handymd-demo', m), md)
  await page.reload()
  await page.waitForSelector('.ProseMirror[contenteditable=true]')
  await page.waitForTimeout(300)
}
async function savedDoc(): Promise<string | null> {
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(450)
  return page.evaluate(() => localStorage.getItem('handymd-demo'))
}
/** 把光标（或选区）放到第 line 行第 col 列（0 基，按源码字符计） */
async function setCaret(line: number, col: number, toCol?: number): Promise<void> {
  await page.evaluate(
    ([l, c, t]) => {
      const view = (window as unknown as { editor: { view: any } }).editor.view
      const doc = view.state.doc
      let pos = 0
      for (let i = 0; i < l; i++) pos += doc.child(i).nodeSize
      const Sel = view.state.selection.constructor
      view.dispatch(view.state.tr.setSelection(Sel.create(doc, pos + 1 + c, pos + 1 + (t ?? c))))
      view.focus()
    },
    [line, col, toCol] as const,
  )
  await page.waitForTimeout(50)
}
async function paste(data: Record<string, string>): Promise<void> {
  await page.evaluate((d) => {
    const dt = new DataTransfer()
    for (const [k, v] of Object.entries(d)) dt.setData(k, v)
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
  await page.waitForTimeout(100)
}

await loadDoc('- first\n- second')
await page.locator('.hm-block').nth(0).click({ clickCount: 3 })
await page.keyboard.type('R')
check('triple-click + type keeps the bullet', (await savedDoc()) === '- R\n- second')

await loadDoc('# Title\nbody')
await setCaret(0, 7)
await page.keyboard.press('Shift+ArrowLeft')
for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft')
await page.keyboard.type('New')
{ const got = await savedDoc(); check('select to line start + type keeps the heading', got === '# New\nbody', JSON.stringify(got)) }

await loadDoc('intro **bold** text\nmore')
await setCaret(1, 2)
await page.keyboard.press('ControlOrMeta+a')
await page.waitForTimeout(80)
check(
  'select-all keeps covered inline markers concealed',
  (await page.locator('.hm-strong ~ .hm-marker:not(.hm-concealed), .hm-marker:not(.hm-concealed)').count()) === 0,
)

await loadDoc('- item')
await setCaret(0, 6)
await page.keyboard.press('Shift+Enter')
await page.keyboard.type('X')
{ const got = await savedDoc(); check('Shift-Enter in a list opens a plain line', got === '- item\nX', JSON.stringify(got)) }

await loadDoc('para')
await setCaret(0, 4)
await page.keyboard.press('Tab')
await page.keyboard.type('Y')
{ const got = await savedDoc(); check('Tab in a paragraph stays in the editor', got === 'para\tY', JSON.stringify(got)) }

await loadDoc('```\ncode\n```')
await setCaret(1, 0)
await page.keyboard.press('Tab')
{ const got = await savedDoc(); check('Tab in a code block indents', got === '```\n  code\n```', JSON.stringify(got)) }

await loadDoc('')
await page.locator('.ProseMirror').click()
await paste({ 'text/plain': 'a\n\nb\n\n\nc' })
check('plain-text paste keeps blank lines', (await savedDoc()) === 'a\n\nb\n\n\nc')

await loadDoc('')
await page.locator('.ProseMirror').click()
await paste({
  'text/html': '<h2>Head</h2><ul><li>one</li></ul><p>x <strong>b</strong> <a href="https://a.b">l</a></p>',
  'text/plain': 'Head\none\nx b l',
})
check('HTML paste converts to markdown', (await savedDoc()) === '## Head\n\n- one\n\nx **b** [l](https://a.b)')

await loadDoc('see docs')
await setCaret(0, 4, 8)
await paste({ 'text/plain': 'https://example.com' })
check('pasting a URL over a selection makes a link', ((await savedDoc()) ?? '').includes('](https://example.com)'))

await loadDoc('l1\nl2\nl3')
await page.locator('.ProseMirror').click()
await page.keyboard.press('ControlOrMeta+a')
const copiedText = await page.evaluate(() => {
  const dt = new DataTransfer()
  document
    .querySelector('.ProseMirror')!
    .dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
  return dt.getData('text/plain')
})
check('copy keeps one newline per line', copiedText === 'l1\nl2\nl3', JSON.stringify(copiedText))

await loadDoc('- task **b**')
await page.locator('#toggle-source').click()
await page.waitForTimeout(100)
check(
  'source mode shows every marker',
  await page.evaluate(
    () => !document.querySelector('.hm-concealed, .hm-bullet-dot') && !!document.querySelector('.handymd.hm-source'),
  ),
)
await page.locator('#toggle-source').click()
await page.waitForTimeout(100)
check('leaving source mode renders again', (await page.locator('.hm-bullet-dot').count()) === 1)

// ═══════════════════════════════════════════════════════════
// 8. 表格：单一网格 / 单元格内编辑 / 键盘导航 / 离开表格
// ═══════════════════════════════════════════════════════════
await loadDoc('before\n\n| A | B |\n| --- | --- |\n| c | **d** |\n\nafter')
check('table renders as a single grid', (await page.locator('table.hm-table-grid').count()) === 1)
check(
  'table rows sit flush (no gaps between rows)',
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table.hm-table-grid tr')] as HTMLElement[]
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!.getBoundingClientRect()
      const cur = rows[i]!.getBoundingClientRect()
      if (Math.abs(cur.top - prev.bottom) > 0.5) return false
    }
    return rows.length === 2
  }),
)
await page.locator('.hm-table-cell', { hasText: 'd' }).click()
await page.waitForTimeout(80)
check(
  'clicked cell becomes an in-place editor with its source',
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el?.classList.contains('hm-table-cell-editing') && el.textContent === '**d**'
  }),
)
check('other rows stay rendered while editing', (await page.locator('table.hm-table-grid tr').count()) === 2)
await page.keyboard.press('End')
await page.keyboard.type('X')
await page.keyboard.press('Tab')
await page.keyboard.type('new')
{
  const got = await savedDoc()
  check(
    'typing in cells writes back to the pipe source',
    got === 'before\n\n| A | B |\n| --- | --- |\n| c | **d**X |\n| new |  |\n\nafter',
    JSON.stringify(got),
  )
}
await page.locator('.hm-table-cell', { hasText: 'new' }).click()
await page.keyboard.press('ArrowDown')
await page.keyboard.type('Z')
{
  const got = await savedDoc()
  check('ArrowDown on the last row leaves the table', got?.endsWith('|\nZ\nafter') ?? false, JSON.stringify(got))
}

// ═══════════════════════════════════════════════════════════
// 9. 图片：API 插入 / 粘贴图片文件
// ═══════════════════════════════════════════════════════════
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
await loadDoc('intro\n')
await setCaret(1, 0)
await page.evaluate(() => (window as any).editor.insertImage({ src: 'https://example.com/a.png', alt: 'A' }))
{
  const got = await savedDoc()
  check('insertImage adds an image line', got === 'intro\n![A](https://example.com/a.png)\n', JSON.stringify(got))
}
check('inserted image renders as a preview', (await page.locator('img.hm-image').count()) === 1)

await loadDoc('')
await page.locator('.ProseMirror').click()
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const dt = new DataTransfer()
  dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }))
  document
    .querySelector('.ProseMirror')!
    .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}, PNG)
await page.waitForTimeout(300)
{
  const got = (await savedDoc()) ?? ''
  check('pasting an image file stores it as an assets/ reference', /^!\[dot\]\(assets\/dot-[0-9a-f]+\.png\)/.test(got), got.slice(0, 60))
}
await page.waitForSelector('img.hm-image')
check(
  'stored image resolves to a loadable URL',
  await page.evaluate(() => (document.querySelector('img.hm-image') as HTMLImageElement).src.startsWith('blob:')),
)

await loadDoc('intro\n![A](https://example.com/a.png)\nafter')
await page.locator('img.hm-image').click()
await page.waitForTimeout(80)
check('clicking an image selects it', (await page.locator('img.hm-image-selected').count()) === 1)
check('clicking an image does not reveal its source', !(await page.evaluate(() => (document.querySelector('.ProseMirror')?.textContent ?? '').includes('![A]') && !!document.querySelector('.hm-image-alt'))))
await page.keyboard.press('Backspace')
{
  const got = await savedDoc()
  check('Backspace deletes the selected image', got === 'intro\n\nafter', JSON.stringify(got))
}
await loadDoc('intro\n![A](https://example.com/a.png)\nafter')
await setCaret(1, '![A](https://example.com/a.png)'.length)
await page.keyboard.press('Backspace')
await page.waitForTimeout(60)
check('Backspace after an image selects it first', (await page.locator('img.hm-image-selected').count()) === 1)

// ═══════════════════════════════════════════════════════════
// 10. 表格结构：行列把手 / 拖动排序 / 添加条 / 横向滚动
// ═══════════════════════════════════════════════════════════
await loadDoc('| A | B |\n| --- | --- |\n| r1 | x |\n| r2 | y |\n\nafter')
await page.locator('.hm-table-cell', { hasText: 'r1' }).hover()
await page.locator('.hm-table-handle-row').click()
await page.waitForTimeout(80)
check('row handle picks the whole row', (await page.locator('.hm-table-cell-picked').count()) === 2)
await page.keyboard.press('Alt+ArrowDown')
await page.waitForTimeout(80)
{
  const got = await savedDoc()
  check('Alt+ArrowDown moves the picked row', got === '| A | B |\n| --- | --- |\n| r2 | y |\n| r1 | x |\n\nafter', JSON.stringify(got))
}
await page.locator('.hm-table-cell', { hasText: 'B' }).hover()
const colGrip = (await page.locator('.hm-table-handle-col').boundingBox())!
const headA = (await page.locator('th.hm-table-cell', { hasText: 'A' }).boundingBox())!
await page.mouse.move(colGrip.x + colGrip.width / 2, colGrip.y + colGrip.height / 2)
await page.mouse.down()
await page.mouse.move(headA.x + 4, colGrip.y + colGrip.height / 2, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(80)
{
  const got = await savedDoc()
  check('dragging a column handle reorders columns', got?.startsWith('| B | A |\n| --- | --- |\n| y | r2 |') ?? false, JSON.stringify(got))
}
await page.keyboard.press('Delete')
await page.waitForTimeout(80)
{
  const got = await savedDoc()
  check('Delete removes the picked column', got?.startsWith('| A |\n| --- |\n| r2 |') ?? false, JSON.stringify(got))
}
await page.locator('.hm-table-wrap').hover()
await page.locator('.hm-table-add-col').click()
await page.keyboard.type('Z')
{
  const got = await savedDoc()
  check('add-column bar appends a column and edits its header', got?.startsWith('| A | Z |\n| --- | --- |') ?? false, JSON.stringify(got))
}
check(
  'table corners are not clipped (border lives on the table)',
  await page.evaluate(() => {
    const t = document.querySelector('table.hm-table-grid') as HTMLElement
    const s = getComputedStyle(t)
    return s.borderTopLeftRadius !== '0px' && s.borderTopWidth === '1px'
  }),
)
await loadDoc(`| ${Array.from({ length: 14 }, (_, i) => `Column ${i}`).join(' | ')} |\n|${' --- |'.repeat(14)}\n| ${Array.from({ length: 14 }, (_, i) => `v${i}`).join(' | ')} |`)
check(
  'wide tables scroll horizontally instead of squeezing cells',
  await page.evaluate(() => {
    const s = document.querySelector('.hm-table-scroll') as HTMLElement
    const cell = document.querySelector('.hm-table-cell') as HTMLElement
    return s.scrollWidth > s.clientWidth + 20 && cell.getBoundingClientRect().width >= 60
  }),
)
await page.locator('#toggle-readonly').click()
await page.waitForTimeout(80)
await page.locator('.hm-table-cell').first().hover()
check('readOnly hides table handles', (await page.locator('.hm-table-handle:visible').count()) === 0)
await page.locator('#toggle-readonly').click()

// ═══════════════════════════════════════════════════════════
// 11. 导出 PDF：渲染态克隆进打印 iframe
// ═══════════════════════════════════════════════════════════
await loadDoc('# Export me\n\nsome **bold** text\n\n- [x] done\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
await page.waitForSelector('.hm-diagram svg', { timeout: 15_000 }).catch(() => {})
await setCaret(2, 7) // 光标在 **bold** 内：导出时也必须是渲染态
const printed = await page.evaluate(async () => {
  let html = ''
  await (window as any).editor.exportToPDF({
    print: (w: Window) => {
      html = w.document.documentElement.outerHTML
    },
  })
  return html
})
check('export button exists in the demo bar', (await page.locator('#export-pdf').count()) === 1)
check('export uses the first heading as title', printed.includes('<title>Export me</title>'))
check('export renders the mermaid SVG', /class="hm-diagram[^"]*"[^>]*>\s*<svg/.test(printed))
check('export hides markers even under the caret', !/<span class="hm-marker">\*\*<\/span>/.test(printed))
check('export keeps checkbox state', /<input[^>]*checked/.test(printed))
check('export drops table handles', !/<div class="hm-table-ui/.test(printed))
check('export leaves no print frame behind', (await page.locator('iframe').count()) === 0)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
