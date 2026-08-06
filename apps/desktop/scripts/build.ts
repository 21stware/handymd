/**
 * Bundle the desktop frontend for Tauri.
 * Output: dist/ (index.html + main.js + handymd.css + styles.css)
 *
 * Tauri's dev server serves index.html directly (with HMR via bun --hot),
 * so this script only runs for production builds.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outdir = process.env.OUTDIR ?? 'dist'

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: ['main.ts'],
  outdir,
  target: 'browser',
  format: 'esm',
  sourcemap: 'none',
  minify: true,
  splitting: true,
  external: ['shiki'],
  naming: {
    entry: '[name].[ext]',
    chunk: 'chunks/[name]-[hash].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const names = result.outputs.map((o) => basename(o.path))
const jsEntry = names.find((n) => n === 'main.js') ?? names.find((n) => n.endsWith('.js'))
if (!jsEntry) {
  console.error('desktop build: no main.js emitted', names)
  process.exit(1)
}

const cssOut = result.outputs.find((o) => o.path.endsWith('.css'))
if (cssOut) {
  await cp(cssOut.path, join(outdir, 'handymd.css'))
  if (basename(cssOut.path) !== 'handymd.css') {
    await rm(cssOut.path, { force: true }).catch(() => {})
  }
}

await cp('styles.css', join(outdir, 'styles.css'))

// Rewrite index.html: inject the bundled SDK CSS (handymd.css) before the app
// styles.css so the app's `--app-hm-*` token overrides win the cascade. In dev,
// the SDK CSS is injected at runtime by bun --hot from the editor.ts import, so
// no link is present in the source HTML.
const html = (await Bun.file('index.html').text())
  .replace(
    /<link rel="stylesheet" href="styles\.css" \/>/,
    `<link rel="stylesheet" href="handymd.css" />\n    <link rel="stylesheet" href="styles.css" />`,
  )
  .replace(/<script type="module" src="\.\/main\.ts"><\/script>/, `<script type="module" src="./${jsEntry}"></script>`)

await Bun.write(join(outdir, 'index.html'), html)

console.log('desktop build ok →', outdir, `(entry=${jsEntry})`)
