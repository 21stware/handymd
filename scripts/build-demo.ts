/**
 * Build the interactive demo as a static site for GitHub Pages.
 *
 * Env:
 *   BASE_PATH  public path prefix (default `/handymd/` for project Pages)
 *   OUTDIR     output directory (default `example-dist`)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outdir = process.env.OUTDIR ?? 'example-dist'
const baseRaw = process.env.BASE_PATH ?? '/handymd/'
const base = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: ['example/main.ts'],
  outdir,
  target: 'browser',
  format: 'esm',
  sourcemap: 'none',
  minify: true,
  naming: '[name]-[hash].[ext]',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const names = result.outputs.map((o) => basename(o.path))
const jsFile = names.find((n) => n.endsWith('.js'))
if (!jsFile) {
  console.error('demo build: no JS entry emitted', names)
  process.exit(1)
}

const cssFromBundle = names.filter((n) => n.endsWith('.css'))

// Always ship source CSS as a stable fallback (imports may also emit hashed CSS)
await cp('src/style.css', join(outdir, 'style.css'))
await cp('example/demo.css', join(outdir, 'demo.css'))

const stylesheets = [
  ...cssFromBundle.map((n) => `<link rel="stylesheet" href="${n}" />`),
  // Ensure demo chrome styles are present even if bundle CSS omits them
  ...(cssFromBundle.length === 0
    ? [
        `<link rel="stylesheet" href="style.css" />`,
        `<link rel="stylesheet" href="demo.css" />`,
      ]
    : [`<link rel="stylesheet" href="demo.css" />`]),
]

const htmlTemplate = await readFile('example/index.html', 'utf8')
const html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
    ...stylesheets,
    `<script type="module" src="${jsFile}"></script>`,
  ].join('\n    '),
)

await writeFile(join(outdir, 'index.html'), html)
// Same document as 404 fallback for project Pages deep links
await writeFile(join(outdir, '404.html'), html)

console.log('demo build ok →', outdir, `(base=${base})`, names.join(', '))
