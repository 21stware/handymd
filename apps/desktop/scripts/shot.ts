/**
 * Screenshot the desktop shell against the dev server with a stubbed Tauri IPC.
 * Usage: bun run scripts/shot.ts [outfile] [light|dark]
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/handymd-shot.png'
const SCHEME = (process.argv[3] ?? 'light') as 'light' | 'dark'
const BASE = process.env.SHOT_URL ?? 'http://localhost:3000/'

const now = Math.floor(Date.now() / 1000)
const NOTES = [
  { id: 'a', title: '产品周报 · 第 32 周', preview: '本周完成 PDF 导出的连续引用竖条修复，嵌套列表缩进改为 rem 计算。', updated_at: now - 300, pinned: true },
  { id: 'b', title: 'handymd 架构笔记', preview: '四层状态机：L1 生命周期 / L2 输入管线 / L3 元素渲染 / L4 持久化。', updated_at: now - 7200, pinned: false },
  { id: 'c', title: 'Reading list', preview: 'Bear 的 conceal 手感、Typora 的所见即所得、Obsidian 的双链。', updated_at: now - 200_000, pinned: false },
  { id: 'd', title: '会议纪要 · 导出对齐', preview: '导出必须与预览一致：引用竖线、嵌套缩进、高亮笔。', updated_at: now - 900_000, pinned: false },
  { id: 'e', title: '', preview: '', updated_at: now - 3_000_000, pinned: false },
]

/** `SHOT_CONTENT` points at a markdown file to render instead of the demo note —
 *  handy for diffing the editor against the same source exported to PDF. */
const CONTENT = process.env.SHOT_CONTENT
  ? await Bun.file(process.env.SHOT_CONTENT).text()
  : `# 产品周报 · 第 32 周

本周把 **PDF 导出** 与预览对齐，重点解决两个视觉不一致。

## 已完成

- [x] 引用块改为一条连续竖线
- [x] 嵌套列表缩进用 \`rem\` 计算
- [ ] 图片粘贴入库

> 编辑器与导出必须看起来是同一份文档。

1. 解析
2. 布局
3. 渲染

\`\`\`ts
export function conceal(doc: string): boolean {
  return doc.length > 0
}
\`\`\`

标签走 pill 样式：#weekly/2026

---

参考 [Bear](https://bear.app) 的排版节奏。
`

const [vw, vh] = (process.env.SHOT_VIEWPORT ?? '1080x680').split('x').map(Number)

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: vw, height: vh },
  deviceScaleFactor: 2,
  colorScheme: SCHEME,
})

await page.addInitScript(
  ({ notes, content }) => {
    const store = new Map<string, string>()
    store.set('a', content)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: (cb: unknown) => cb,
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        switch (cmd) {
          case 'vault_info':
            return { path: '/Users/you/Library/handymd/vault.mdb', icloud: true }
          case 'list_notes':
            return notes
          case 'get_note':
            return { id: args.id, content: store.get(args.id as string) ?? '', updated_at: 0 }
          case 'create_note':
            return { id: `new-${Math.random()}`, title: '', preview: '', updated_at: Date.now() / 1000, pinned: false }
          case 'update_note':
            return Math.floor(Date.now() / 1000)
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
  },
  { notes: NOTES, content: CONTENT },
)

await page.goto(BASE)
await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
await page.waitForTimeout(2200)

// Optional 4th arg stages a transient surface that a plain load never shows.
const stage = process.argv[4]
if (stage === 'menu') {
  await page.locator('.note-item').nth(1).click({ button: 'right' })
  await page.waitForTimeout(300)
} else if (stage === 'search') {
  await page.fill('#search-input', '导出')
  await page.waitForTimeout(300)
}

await page.screenshot({ path: OUT })
console.log('shot →', OUT)
await browser.close()
