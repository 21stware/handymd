/**
 * Build the handymd documentation site (landing + docs) for GitHub Pages.
 *
 * Env:
 *   BASE_PATH  public path prefix (default `/handymd/` for project Pages)
 *   OUTDIR     output directory (default `dist`)
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { renderMarkdown } from './markdown'

const outdir = process.env.OUTDIR ?? 'dist'
const baseRaw = process.env.BASE_PATH ?? '/handymd/'
const base = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`

const DOCS_DIR = join('..', '..', 'packages', 'handymd', 'docs')

await rm(outdir, { recursive: true, force: true })
await mkdir(join(outdir, 'icons'), { recursive: true })
await mkdir(join(outdir, 'docs'), { recursive: true })

// ——— 1) Bundle landing JS with code-splitting (main + playground chunk) ———
const result = await Bun.build({
  entrypoints: ['main.ts'],
  outdir,
  target: 'browser',
  format: 'esm',
  sourcemap: 'none',
  minify: true,
  splitting: true,
  // Peers stay external; resolve at runtime via import map → CDN.
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
  console.error('site build: no main.js emitted', names)
  process.exit(1)
}

// CSS emitted from playground import of @21stware/handymd/style.css — keep as handymd.css
const cssOut = result.outputs.find((o) => o.path.endsWith('.css'))
if (cssOut) {
  await cp(cssOut.path, join(outdir, 'handymd.css'))
  if (basename(cssOut.path) !== 'handymd.css') {
    await rm(cssOut.path, { force: true }).catch(() => {})
  }
} else {
  await cp(join('..', '..', 'packages', 'handymd', 'src', 'style.css'), join(outdir, 'handymd.css'))
}
// Bun may leave an empty entry CSS next to main.js — remove clutter
for (const leftover of ['main.css']) {
  await rm(join(outdir, leftover), { force: true }).catch(() => {})
}

// ——— 2) Static assets ———
await cp('styles.css', join(outdir, 'styles.css'))
await cp('docs.css', join(outdir, 'docs.css'))
await cp('favicon.svg', join(outdir, 'favicon.svg'))
await cp('logo.svg', join(outdir, 'logo.svg'))
// Site is a documentation landing page — not an installable editor PWA.
// (The pure editor lives at ./app/ and carries the real webmanifest + file_handlers.)

// ——— 3) Icons / OG (checked-in assets) ———
await cp('icons/icon-192.png', join(outdir, 'icons/icon-192.png'))
await cp('icons/icon-512.png', join(outdir, 'icons/icon-512.png'))
await cp('icons/icon-512.png', join(outdir, 'og.png'))

// ——— 4) Landing HTML: inject base + module entry (editor CSS loads with playground) ———
const htmlTemplate = await readFile('index.html', 'utf8')

// Bare peer imports stay external; map to CDN at runtime.
const peerImportMap = `<script type="importmap">
    {
      "imports": {
        "mermaid": "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs",
        "shiki": "https://esm.sh/shiki@4.4.1"
      }
    }
    </script>`

let html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
    peerImportMap,
    `<link rel="modulepreload" href="${jsEntry}" />`,
    `<script type="module" src="${jsEntry}"></script>`,
  ].join('\n    '),
)

await writeFile(join(outdir, 'index.html'), html)
await writeFile(join(outdir, '404.html'), html)

// ——— 5) Docs: render packages/handymd/docs/*.md → dist/docs/*.html ———
// Reading order, not alphabetical: guide is the entry point. Unlisted docs keep
// their alphabetical position after these.
const DOC_ORDER = ['guide', 'api', 'architecture']
const docFiles = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort()
const orderOf = (slug: string): number => {
  const i = DOC_ORDER.indexOf(slug)
  return i === -1 ? DOC_ORDER.length : i
}

const docs = await Promise.all(
  docFiles.map(async (file) => {
    const slug = basename(file, '.md')
    const md = await readFile(join(DOCS_DIR, file), 'utf8')
    const { html: body, toc } = renderMarkdown(md)
    return { slug, title: extractTitle(md) ?? slug, href: `docs/${slug}.html`, body, toc }
  }),
)
docs.sort((a, b) => orderOf(a.slug) - orderOf(b.slug) || a.slug.localeCompare(b.slug))

// The sidebar lists every doc, so it has to be complete before any page renders.
const docMeta = docs.map(({ slug, title, href }) => ({ slug, title, href }))

for (const { slug, title, body, toc } of docs) {
  const page = renderDocPage({ title, slug, body, toc, base, docs: docMeta })
  await writeFile(join(outdir, 'docs', `${slug}.html`), page)
}

// Docs index redirect → guide. Hrefs are page-relative ("docs/x.html") and this
// file already lives in docs/, so it needs the bare file name.
if (docMeta.length) {
  const first = basename(docMeta[0]!.href)
  const indexHtml = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeAttr(first)}"><link rel="canonical" href="${escapeAttr(first)}"><title>handymd 文档</title>`
  await writeFile(join(outdir, 'docs', 'index.html'), indexHtml)
}

// ——— 5b) Service worker: precache the real bundle, not just the shell ———
// Entry/chunk names only exist after bundling. Note the site SW deliberately
// ignores ./app/* — that subtree has its own worker.
const siteChunks = names
  .filter((n) => n.endsWith('.js') && n !== jsEntry)
  .map((n) => `./chunks/${n}`)
const sitePrecache = [
  './',
  './index.html',
  './styles.css',
  './docs.css',
  './favicon.svg',
  './logo.svg',
  // lazily <link>ed when the playground mounts — offline it must already be there
  './handymd.css',
  `./${jsEntry}`,
  ...siteChunks,
  ...docMeta.map((d) => `./${d.href}`),
]

const siteHasher = new Bun.CryptoHasher('sha256')
for (const rel of sitePrecache) {
  const path = join(outdir, rel === './' ? 'index.html' : rel.replace(/^\.\//, ''))
  const file = Bun.file(path)
  if (await file.exists()) siteHasher.update(new Uint8Array(await file.arrayBuffer()))
}
const siteBuildId = siteHasher.digest('hex').slice(0, 12)

const siteSwSrc = await readFile('sw.js', 'utf8')
const siteSwOut = siteSwSrc
  .replace(/^const BUILD_ID = .*$/m, `const BUILD_ID = ${JSON.stringify(siteBuildId)}`)
  .replace(/^const PRECACHE = \[[\s\S]*?\]$/m, `const PRECACHE = ${JSON.stringify(sitePrecache)}`)
if (!siteSwOut.includes(siteBuildId) || !siteSwOut.includes(`./${jsEntry}`)) {
  console.error('site build: failed to inject precache into sw.js')
  process.exit(1)
}
await writeFile(join(outdir, 'sw.js'), siteSwOut)

// ——— 6) Embed pure editor PWA at ./app/ (same Pages artifact) ———
// BASE for the app is site base + "app/" e.g. /handymd/app/
const appBase = `${base}app/`
const appOutAbs = resolve(process.cwd(), outdir, 'app')
const appDir = resolve(import.meta.dir, '..', '..', 'app')
const appBuild = Bun.spawnSync(['bun', 'run', 'scripts/build.ts'], {
  cwd: appDir,
  env: {
    ...process.env,
    BASE: appBase,
    OUTDIR: appOutAbs,
  },
  stdout: 'inherit',
  stderr: 'inherit',
})
if (appBuild.exitCode !== 0) {
  console.error('site build: embedding apps/app failed')
  process.exit(appBuild.exitCode ?? 1)
}

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

console.log('site build ok →', outdir, `(base=${base})`)
console.log('  entry:', jsEntry)
console.log('  editor css: handymd.css (lazy with playground)')
console.log('  js chunks:', sizes.map((s) => `${s.name} ${s.kb}KB`).join(', '))
console.log('  total bundled JS+CSS:', `${totalKb} KB`)
console.log('  docs:', docMeta.map((d) => d.slug).join(', '))
console.log('  editor PWA:', `app/ (base=${appBase})`)

// ——— Docs page template ———
type DocPageInput = {
  title: string
  slug: string
  body: string
  toc: { id: string; text: string; level: number }[]
  base: string
  docs: { slug: string; title: string; href: string }[]
}

function renderDocPage(input: DocPageInput): string {
  const { title, slug, body, toc, base, docs } = input
  const sidebar = docs
    .map(
      (d) =>
        `<a href="${escapeAttr(d.href)}" class="${d.slug === slug ? 'is-active' : ''}">${escapeHtml(d.title)}</a>`,
    )
    .join('')
  const tocHtml = toc
    .map(
      (t) =>
        `<a href="#${escapeAttr(t.id)}" class="level-${t.level}">${escapeHtml(t.text)}</a>`,
    )
    .join('')
  const hasMermaid = body.includes('data-mermaid')
  const mermaidScript = hasMermaid
    ? `<script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: false, theme: "neutral", flowchart: { useMaxWidth: true } });
      document.querySelectorAll('[data-mermaid]').forEach((el) => {
        el.removeAttribute('data-mermaid');
        mermaid.run({ nodes: [el] }).catch(() => {});
      });
    </script>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <base href="${escapeAttr(base)}" />
    <title>${escapeHtml(title)} — handymd 文档</title>
    <meta name="description" content="@21stware/handymd ${escapeAttr(title)} 文档" />
    <meta name="theme-color" content="#f4f1ea" />
    <meta name="color-scheme" content="light" />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="canonical" href="https://21stware.github.io/handymd/docs/${escapeAttr(slug)}.html" />
    <style>
      :root {
        --paper: #f4f1ea; --paper-deep: #eae5da; --ink: #181715; --ink-soft: #625e56;
        --ink-faint: #938d82; --line: #d8d2c7; --accent: #c65335;
        --accent-soft: rgba(198,83,53,0.1); --card: #fbfaf6;
        --font: "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        --serif: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif CJK SC", Georgia, serif;
        --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      }
      html { scroll-behavior: smooth; }
      body {
        margin: 0; font-family: var(--font); color: var(--ink); line-height: 1.65;
        background: var(--paper);
        -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      }
    </style>
    <link rel="stylesheet" href="styles.css" />
    <link rel="stylesheet" href="docs.css" />
  </head>
  <body>
    <div class="docs-page">
      <header class="docs-nav">
        <!-- <base> is the site root, so these are base-relative, not page-relative -->
        <a class="brand" href="./"><img class="brand-mark" src="logo.svg" width="28" height="28" alt="" /><span>handymd</span></a>
        <nav class="nav-links">
          <a href="./#philosophy">理念</a>
          <a href="./#playground">试写</a>
          <a href="docs/guide.html" class="is-active">文档</a>
          <a href="app/">编辑器</a>
        </nav>
        <span class="nav-spacer"></span>
        <a class="github-link" href="https://github.com/21stware/handymd" target="_blank" rel="noopener noreferrer">GitHub</a>
      </header>
      <div class="docs-body">
        <aside class="docs-sidebar">
          <h3>Documentation</h3>
          ${sidebar}
        </aside>
        <article class="docs-article">
          ${body}
        </article>
        <aside class="docs-toc">
          <h3>On this page</h3>
          ${tocHtml}
        </aside>
      </div>
      <footer class="docs-footer">MIT · Built with ProseMirror · by 21stware</footer>
    </div>
    ${mermaidScript}
  </body>
</html>`
}

function extractTitle(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md)
  return m ? m[1]!.trim() : null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
