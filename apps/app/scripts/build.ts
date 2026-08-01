/**
 * Build the handymd PWA app (pure Markdown editor).
 *
 * Env:
 *   OUTDIR  output directory (default `dist`)
 *   BASE    public path prefix (default `/`; Pages nested deploy uses `/handymd/app/`)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outdir = process.env.OUTDIR ?? 'dist'
const baseRaw = process.env.BASE ?? '/'
const base = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`

await rm(outdir, { recursive: true, force: true })
await mkdir(join(outdir, 'icons'), { recursive: true })
await mkdir(join(outdir, 'chunks'), { recursive: true })

// ——— 1) Bundle app JS ———
const result = await Bun.build({
  entrypoints: ['main.ts'],
  outdir,
  target: 'browser',
  format: 'esm',
  sourcemap: 'none',
  minify: true,
  splitting: true,
  // Optional SDK peers — app doesn't wire them; keep them out of the bundle.
  external: ['shiki', 'mermaid'],
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
  console.error('app build: no main.js emitted', names)
  process.exit(1)
}

// CSS emitted from editor import of @21stware/handymd/style.css — keep as handymd.css
const cssOut = result.outputs.find((o) => o.path.endsWith('.css'))
if (cssOut) {
  await cp(cssOut.path, join(outdir, 'handymd.css'))
  if (basename(cssOut.path) !== 'handymd.css') {
    await rm(cssOut.path, { force: true }).catch(() => {})
  }
}
for (const leftover of ['main.css']) {
  await rm(join(outdir, leftover), { force: true }).catch(() => {})
}

// ——— 2) Static assets ———
await cp('styles.css', join(outdir, 'styles.css'))
await cp('favicon.svg', join(outdir, 'favicon.svg'))
await cp('sw.js', join(outdir, 'sw.js'))

// Manifest: pin id/start_url/scope to the deploy BASE so nested Pages paths work.
const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8')) as {
  id?: string
  start_url?: string
  scope?: string
  file_handlers?: { action: string; accept: Record<string, string[]>; launch_type?: string }[]
  [key: string]: unknown
}
manifest.id = base
manifest.start_url = './'
manifest.scope = './'
if (Array.isArray(manifest.file_handlers)) {
  for (const h of manifest.file_handlers) h.action = './'
}
await writeFile(join(outdir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`)

// ——— 3) PWA PNG icons (checked-in assets) ———
await cp('icons/icon-192.png', join(outdir, 'icons/icon-192.png'))
await cp('icons/icon-512.png', join(outdir, 'icons/icon-512.png'))

// ——— 4) HTML: inject base + module entry ———
const htmlTemplate = await readFile('index.html', 'utf8')

const html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
    `<link rel="stylesheet" href="handymd.css" />`,
    `<link rel="modulepreload" href="${jsEntry}" />`,
    `<script type="module" src="${jsEntry}"></script>`,
  ].join('\n    '),
)

await writeFile(join(outdir, 'index.html'), html)

// Size report
const sizes = await Promise.all(
  result.outputs.map(async (o) => {
    const file = Bun.file(o.path)
    return { name: basename(o.path), kb: (file.size / 1024).toFixed(1) }
  }),
)
const totalKb = (
  result.outputs.reduce((n, o) => n + Bun.file(o.path).size, 0) / 1024
).toFixed(1)

console.log('app build ok →', outdir, `(base=${base})`)
console.log('  entry:', jsEntry)
console.log('  js chunks:', sizes.map((s) => `${s.name} ${s.kb}KB`).join(', '))
console.log('  total bundled JS+CSS:', `${totalKb} KB`)
