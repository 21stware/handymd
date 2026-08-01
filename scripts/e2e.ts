/**
 * 端到端交互验证（真实 Chromium）：链接点击语义、conceal/reveal、checkbox。
 *
 * 用法：先启动示例（bun example/index.html），再 `bun run e2e`。
 * 依赖：`bunx playwright install chromium`
 */
import { chromium } from 'playwright'

const BASE = process.env.E2E_URL ?? 'http://localhost:3000/'
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(BASE)
await page.waitForSelector('.ProseMirror')
await page.waitForTimeout(600)

// 清掉 demo 的 localStorage 缓存，保证内容固定
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.waitForSelector('.hm-link')
await page.waitForTimeout(400)

await page.evaluate(() => {
  ;(window as unknown as { __opened: string[] }).__opened = []
  window.open = (...args: Parameters<typeof window.open>) => {
    ;(window as unknown as { __opened: string[] }).__opened.push(String(args[0]))
    return null
  }
})
const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
const domAnchor = () =>
  page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? 'none')

const link = page.locator('.hm-link').first()
const box = (await link.boundingBox())!
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2

// —— 1. 标题 conceal/reveal ——
const h1 = page.locator('.hm-h1').first()
await h1.click()
await page.waitForTimeout(100)
const headingRevealed = await page.evaluate(
  () => !!document.querySelector('.hm-h1 .hm-marker:not(.hm-concealed)'),
)
check('cursor in heading reveals "# "', headingRevealed)

// —— 2. Concealed 链接单击 = 打开且不移动光标 ——
await page.mouse.click(cx, cy)
await page.waitForTimeout(150)
check('concealed link click opens URL', (await opened()).length === 1, (await opened()).join(','))
check('cursor did not enter link', !(await domAnchor()).startsWith('['), await domAnchor())

// —— 3. 双击不重复打开 ——
await page.mouse.dblclick(cx, cy)
await page.waitForTimeout(150)
check('double-click opens only once more', (await opened()).length === 2, String((await opened()).length))

// —— 4. Cmd/Ctrl+点击 = 光标进入链接（Revealed），不打开 ——
await h1.click()
await page.waitForTimeout(100)
await page.keyboard.down('Control')
await page.mouse.click(cx, cy)
await page.keyboard.up('Control')
await page.waitForTimeout(150)
check('ctrl+click does not open', (await opened()).length === 2)
check('ctrl+click reveals link markers (cursor inside)', (await domAnchor()).includes('链接') || (await domAnchor()).includes('['), await domAnchor())

// —— 5. Revealed 态单击 = 正常编辑，不打开 ——
await page.mouse.click(cx, cy)
await page.waitForTimeout(150)
check('click on revealed link edits instead of opening', (await opened()).length === 2)

// —— 6. checkbox 点击切换且不移动光标 ——
await h1.click()
await page.waitForTimeout(100)
const cb = page.locator('input.hm-checkbox').first()
const wasChecked = await cb.isChecked()
await cb.click()
await page.waitForTimeout(200)
const nowChecked = await page.locator('input.hm-checkbox').first().isChecked()
check('checkbox toggles source text', nowChecked === !wasChecked)
check('checkbox click keeps cursor away', (await domAnchor()).includes('handymd'), await domAnchor())

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
