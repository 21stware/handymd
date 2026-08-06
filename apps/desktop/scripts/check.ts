/**
 * Behaviour checks for the desktop shell against the dev server (stubbed Tauri IPC).
 * Usage: bun run scripts/desktop-check.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.SHOT_URL ?? 'http://localhost:3000/'
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

const now = Math.floor(Date.now() / 1000)
const NOTES = [
  { id: 'a', title: 'Alpha', preview: 'alpha body', updated_at: now - 10, pinned: false },
  { id: 'b', title: 'Bravo', preview: 'bravo body', updated_at: now - 20, pinned: false },
  { id: 'c', title: 'Charlie', preview: 'charlie body', updated_at: now - 30, pinned: true },
]

async function boot(): Promise<Page> {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1080, height: 680 } })
  await page.addInitScript((notes) => {
    const w = window as unknown as Record<string, unknown>
    const calls: { cmd: string; args: Record<string, unknown> }[] = []
    w.__calls = calls
    const store = new Map<string, string>([
      ['a', '# Alpha\n\nalpha body'],
      ['b', '# Bravo\n\nbravo body'],
      ['c', '# Charlie\n\ncharlie body'],
    ])
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: unknown) => cb,
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args })
        switch (cmd) {
          case 'vault_info':
            return { path: '/tmp/vault.mdb', icloud: false }
          case 'list_notes':
            return notes
          case 'get_note':
            return { id: args.id, content: store.get(args.id as string) ?? '', updated_at: 0 }
          case 'create_note':
            return { id: 'new', title: '', preview: '', updated_at: Date.now() / 1000, pinned: false }
          case 'update_note':
            store.set(args.id as string, args.content as string)
            return Math.floor(Date.now() / 1000)
          // `confirm()` resolves by comparing the returned label to okLabel;
          // custom labels arrive as { OkCancelCustom: [ok, cancel] }.
          case 'plugin:dialog|message': {
            const b = args.buttons as { OkCancelCustom?: [string, string] } | string | undefined
            return typeof b === 'object' && b?.OkCancelCustom ? b.OkCancelCustom[0] : 'Ok'
          }
          // Native menus need a rid; Playwright can't show OS chrome, so stub.
          case 'plugin:menu|new':
          case 'plugin:menu|popup':
          case 'plugin:menu|create_default':
            return 1
          case 'plugin:menu|append':
          case 'plugin:menu|prepend':
          case 'plugin:resource|close':
            return null
          default:
            if (typeof cmd === 'string' && cmd.startsWith('plugin:menu|')) return 1
            return null
        }
      },
    }
  }, NOTES)
  await page.goto(BASE)
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(900)
  return page
}

const page = await boot()
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))

const calls = () =>
  page.evaluate(
    () => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [],
  )

// ── 1. Pinned notes are grouped, unpinned follow ───────────────────────────
const sections = await page.locator('.list-section').allTextContents()
check('pinned notes get their own section', sections.join('|') === '置顶|笔记', sections.join('|'))

// ── 2. Merely opening a note must not save it ──────────────────────────────
await page.locator('.note-item').filter({ hasText: 'Alpha' }).click()
await page.waitForTimeout(800)
const writesAfterOpen = (await calls()).filter((c) => c.cmd === 'update_note')
check('opening a note does not write to the vault', writesAfterOpen.length === 0, JSON.stringify(writesAfterOpen))

// ── 3. Switching notes must not write the previous note's text elsewhere ───
await page.click('.ProseMirror')
await page.keyboard.press('Control+End')
await page.keyboard.type('ZZZ')
await page.locator('.note-item').filter({ hasText: 'Bravo' }).click()
await page.waitForTimeout(900)

const writes = await page.evaluate(() =>
  ((window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [])
    .filter((c) => c.cmd === 'update_note')
    .map((c) => ({ id: c.args.id as string, hasZ: String(c.args.content).includes('ZZZ') })),
)
const strayWrite = writes.find((w) => w.hasZ && w.id !== 'a')
check('edited text is saved to its own note', !strayWrite, JSON.stringify(writes))
check('edit to note A was persisted', writes.some((w) => w.id === 'a' && w.hasZ), JSON.stringify(writes))

// Reopening Alpha must show the typed text (i.e. it really landed in the vault).
await page.locator('.note-item').filter({ hasText: 'Alpha' }).click()
await page.waitForTimeout(500)
const alphaText = await page.locator('.ProseMirror').textContent()
check('reopened note keeps the edit', (alphaText ?? '').includes('ZZZ'), alphaText?.slice(0, 60))

// ── 4. Search filters the list ─────────────────────────────────────────────
await page.fill('#search-input', 'brav')
await page.waitForTimeout(200)
const titles = await page.locator('.note-title').allTextContents()
check('search filters to matching notes', titles.join('|') === 'Bravo', titles.join('|'))
const foot = await page.locator('#foot-count').textContent()
check('footer shows filtered count', (foot ?? '').includes('1 / 3'), foot ?? '')

await page.fill('#search-input', 'zzzzzz')
await page.waitForTimeout(200)
const emptyVisible = await page.locator('#list-empty').isVisible()
check('empty search shows a hint', emptyVisible)

await page.fill('#search-input', '')
await page.waitForTimeout(200)

// ── 5. ⌘⌫ edits the line; it must never delete the note ───────────────────
const rowsBeforeKill = await page.locator('.note-item').count()
// Clicking the paper margin parks the caret at the very end — deterministic,
// unlike clicking into the text where the hit position decides the line.
await page.locator('#scroll-root').click({ position: { x: 12, y: 400 } })
await page.waitForTimeout(200)
await page.keyboard.press('Meta+Backspace')
await page.waitForTimeout(300)
const killed = (await page.locator('.ProseMirror').textContent()) ?? ''
check('⌘⌫ keeps the note', (await page.locator('.note-item').count()) === rowsBeforeKill)
check('⌘⌫ clears the line to its start', !killed.includes('alpha body'), killed.slice(0, 60))
check('⌘⌫ leaves the rest of the note alone', killed.includes('Alpha'), killed.slice(0, 60))

// ── 6. Delete removes the note and selects a neighbour ─────────────────────
const before = await page.locator('.note-item').count()
await page.click('#delete-btn')
await page.waitForTimeout(700)
const after = await page.locator('.note-item').count()
check(
  'delete removes one row',
  after === before - 1,
  `${before} → ${after}; cmds=${(await calls()).map((c) => c.cmd).join(',')}`,
)
const activeCount = await page.locator('.note-item.is-active').count()
check('a neighbouring note becomes active', activeCount === 1, String(activeCount))

await page.context().browser()?.close()
process.exit(failures > 0 ? 1 : 0)
