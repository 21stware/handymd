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
await cp('logo.svg', join(outdir, 'logo.svg'))

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

const mermaidImportMap = `<script type="importmap">
    {
      "imports": {
        "mermaid": "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"
      }
    }
    </script>`

const html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
    mermaidImportMap,
    // Theme tokens must load after SDK CSS so .editor-mount.handymd wins cascade.
    `<link rel="stylesheet" href="handymd.css" />`,
    `<link rel="stylesheet" href="styles.css" />`,
    `<link rel="modulepreload" href="${jsEntry}" />`,
    `<script type="module" src="${jsEntry}"></script>`,
  ].join('\n    '),
)

await writeFile(join(outdir, 'index.html'), html)

// ——— 5) Service worker: precache the real bundle, not just the shell ———
// Bundle/chunk names are only known here, and a shell-only precache makes
// offline support depend on the browser HTTP cache rather than the SW.
const chunkNames = names
  .filter((n) => n.endsWith('.js') && n !== jsEntry)
  .map((n) => `chunks/${n}`)
const precache = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './favicon.svg',
  './logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  `./${jsEntry}`,
  ...(cssOut ? ['./handymd.css'] : []),
  ...chunkNames.map((c) => `./${c}`),
]

// Build id = hash of everything we precache, so a changed asset both busts the
// cache name and lets `activate` evict the previous one.
const hasher = new Bun.CryptoHasher('sha256')
for (const rel of precache) {
  const file = Bun.file(join(outdir, rel === './' ? 'index.html' : rel.replace(/^\.\//, '')))
  if (await file.exists()) hasher.update(new Uint8Array(await file.arrayBuffer()))
}
const buildId = hasher.digest('hex').slice(0, 12)

const swSrc = await readFile('sw.js', 'utf8')
const swOut = swSrc
  .replace(/^const BUILD_ID = .*$/m, `const BUILD_ID = ${JSON.stringify(buildId)}`)
  .replace(/^const PRECACHE = \[[\s\S]*?\]$/m, `const PRECACHE = ${JSON.stringify(precache)}`)
if (!swOut.includes(buildId) || !swOut.includes(`./${jsEntry}`)) {
  console.error('app build: failed to inject precache into sw.js')
  process.exit(1)
}
await writeFile(join(outdir, 'sw.js'), swOut)

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
