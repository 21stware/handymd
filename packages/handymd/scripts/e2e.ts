/**
 * 端到端交互验证（真实 Chromium）。
 *
 * 用法：先启动示例（bun run dev），再 `bun run e2e`。
 * 依赖：`bunx playwright install chromium`
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

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
