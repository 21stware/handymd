/**
 * Build the handymd documentation site (landing + docs) for GitHub Pages.
 *
 * Env:
 *   BASE_PATH  public path prefix (default `/handymd/` for project Pages)
 *   OUTDIR     output directory (default `dist`)
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
  // shiki: playground never calls createShikiHighlighter.
  // mermaid: peer of the SDK; keep it out of Bun.build (full package stalls minify)
  // and resolve at runtime via import map → esm CDN (see landing HTML injection).
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
await cp('sw.js', join(outdir, 'sw.js'))
await cp('manifest.webmanifest', join(outdir, 'manifest.webmanifest'))

// ——— 3) PWA / OG PNG icons (checked-in assets; avoid runtime PNG encode) ———
await cp('icons/icon-192.png', join(outdir, 'icons/icon-192.png'))
await cp('icons/icon-512.png', join(outdir, 'icons/icon-512.png'))
await cp('icons/icon-512.png', join(outdir, 'og.png'))

// ——— 4) Landing HTML: inject base + module entry (editor CSS loads with playground) ———
const htmlTemplate = await readFile('index.html', 'utf8')

// Bare `import('mermaid')` from createMermaidRenderer stays external; map it to CDN.
const mermaidImportMap = `<script type="importmap">
    {
      "imports": {
        "mermaid": "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"
      }
    }
    </script>`

let html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
    mermaidImportMap,
    `<link rel="modulepreload" href="${jsEntry}" />`,
    `<script type="module" src="${jsEntry}"></script>`,
  ].join('\n    '),
)

await writeFile(join(outdir, 'index.html'), html)
await writeFile(join(outdir, '404.html'), html)

// ——— 5) Docs: render packages/handymd/docs/*.md → dist/docs/*.html ———
const docFiles = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort()
const docMeta: { slug: string; title: string; href: string }[] = []

for (const file of docFiles) {
  const slug = basename(file, '.md')
  const md = await readFile(join(DOCS_DIR, file), 'utf8')
  const { html: body, toc } = renderMarkdown(md)
  const title = extractTitle(md) ?? slug
  docMeta.push({ slug, title, href: `docs/${slug}.html` })

  const page = renderDocPage({ title, slug, body, toc, base, docs: docMeta })
  await writeFile(join(outdir, 'docs', `${slug}.html`), page)
}

// Docs index redirect → guide (first doc)
if (docMeta.length) {
  const indexHtml = `<!doctype html><meta http-equiv="refresh" content="0; url=${escapeAttr(docMeta[0]!.href)}"><link rel="canonical" href="${escapeAttr(docMeta[0]!.href)}">`
  await writeFile(join(outdir, 'docs', 'index.html'), indexHtml)
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
    <meta name="theme-color" content="#f7f3eb" />
    <meta name="color-scheme" content="light" />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="canonical" href="https://21stware.github.io/handymd/docs/${escapeAttr(slug)}.html" />
    <style>
      :root {
        --paper: #f7f3eb; --paper-deep: #efe8db; --ink: #2c2823; --ink-soft: #6b645a;
        --ink-faint: #a89f92; --line: #e4dccf; --accent: #c9603c;
        --accent-soft: rgba(201,96,60,0.12); --card: #fffdf8;
        --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      }
      html { scroll-behavior: smooth; }
      body {
        margin: 0; font-family: var(--font); color: var(--ink); line-height: 1.65;
        background:
          radial-gradient(1200px 600px at 10% -10%, #fff8ec 0%, transparent 55%),
          radial-gradient(900px 500px at 100% 0%, #f3e7d8 0%, transparent 50%),
          var(--paper);
        -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      }
    </style>
    <link rel="stylesheet" href="styles.css" />
    <link rel="stylesheet" href="docs.css" />
  </head>
  <body>
    <div class="docs-page">
      <header class="docs-nav">
        <a class="brand" href="../"><span class="brand-mark" aria-hidden="true">h</span><span>handymd</span></a>
        <nav class="nav-links">
          <a href="../#features">特性</a>
          <a href="../#playground">试写</a>
          <a href="guide.html" class="is-active">文档</a>
          <a href="../#install">安装</a>
        </nav>
        <span class="nav-spacer"></span>
        <a class="github-link" href="https://github.com/21stware/handymd" target="_blank" rel="noopener noreferrer">GitHub</a>
      </header>
      <div class="docs-body">
        <aside class="docs-sidebar">
          <h3>文档</h3>
          ${sidebar}
        </aside>
        <article class="docs-article">
          ${body}
        </article>
        <aside class="docs-toc">
          <h3>本页</h3>
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
