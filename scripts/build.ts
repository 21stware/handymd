import { $ } from 'bun'
import { rm, cp } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  target: 'browser',
  format: 'esm',
  sourcemap: 'external',
  external: [
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-transform',
    'prosemirror-keymap',
    'prosemirror-commands',
    'prosemirror-history',
    'shiki',
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await cp('src/style.css', 'dist/style.css')

// 类型声明
await $`bunx tsc -p tsconfig.build.json`

console.log('build ok →', result.outputs.map((o) => o.path).join(', '))
