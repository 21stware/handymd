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
  // Keep optional shiki out of the graph (playground never calls createShikiHighlighter).
  // Mermaid is a real site dependency and is code-split via dynamic import in createMermaidRenderer.
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

// ——— 3) Generate PWA PNG icons (no external deps, properly deflated) ———
await writeFile(join(outdir, 'icons/icon-192.png'), await encodeBrandIcon(192))
await writeFile(join(outdir, 'icons/icon-512.png'), await encodeBrandIcon(512))
await writeFile(join(outdir, 'og.png'), await encodeBrandIcon(512))

// ——— 4) Landing HTML: inject base + module entry (editor CSS loads with playground) ———
const htmlTemplate = await readFile('index.html', 'utf8')

let html = htmlTemplate.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  [
    `<base href="${base}" />`,
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

// ——— PNG helpers (deflated truecolor) ———
async function encodeBrandIcon(size: number): Promise<Uint8Array> {
  const rgba = new Uint8Array(size * size * 4)
  const cx = size / 2
  const cy = size / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = Math.abs(x + 0.5 - cx)
      const dy = Math.abs(y + 0.5 - cy)
      const r = size * 0.28
      const bx = size * 0.5 - r
      const by = size * 0.5 - r
      const ox = Math.max(dx - bx, 0)
      const oy = Math.max(dy - by, 0)
      const dist = Math.hypot(ox, oy)
      const inside = dist <= r

      if (!inside) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
        rgba[i + 3] = 0
        continue
      }

      const t = (x + y) / (size * 2)
      const r0 = 0xe8,
        g0 = 0xa0,
        b0 = 0x7a
      const r1 = 0xc9,
        g1 = 0x60,
        b1 = 0x3c
      const r2 = 0x8f,
        g2 = 0x3d,
        b2 = 0x28
      const mid = t < 0.55 ? t / 0.55 : 1
      const t2 = t < 0.55 ? 0 : (t - 0.55) / 0.45
      const R = t < 0.55 ? r0 + (r1 - r0) * mid : r1 + (r2 - r1) * t2
      const G = t < 0.55 ? g0 + (g1 - g0) * mid : g1 + (g2 - g1) * t2
      const B = t < 0.55 ? b0 + (b1 - b0) * mid : b1 + (b2 - b1) * t2

      const hl = Math.max(0, 1 - Math.hypot(x - size * 0.35, y - size * 0.3) / (size * 0.55))
      rgba[i] = Math.min(255, R + hl * 30)
      rgba[i + 1] = Math.min(255, G + hl * 20)
      rgba[i + 2] = Math.min(255, B + hl * 12)
      rgba[i + 3] = 255
    }
  }

  drawH(rgba, size)
  return encodePngRgba(size, size, rgba)
}

function drawH(rgba: Uint8Array, size: number) {
  const ink = { r: 255, g: 253, b: 248 }
  const thickness = Math.max(2, Math.round(size * 0.08))
  const left = Math.round(size * 0.34)
  const right = Math.round(size * 0.66)
  const top = Math.round(size * 0.28)
  const bottom = Math.round(size * 0.72)
  const midY = Math.round(size * 0.5)

  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    if (rgba[i + 3] < 128) return
    rgba[i] = ink.r
    rgba[i + 1] = ink.g
    rgba[i + 2] = ink.b
  }

  for (let y = top; y <= bottom; y++) {
    for (let t = 0; t < thickness; t++) {
      paint(left + t, y)
      paint(right - t, y)
    }
  }
  for (let x = left; x <= right; x++) {
    for (let t = 0; t < thickness; t++) {
      paint(x, midY + t - Math.floor(thickness / 2))
    }
  }
}

async function encodePngRgba(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1)
  }

  const compressed = await zlibDeflate(raw)

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))]
  const total = signature.length + chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  out.set(signature, 0)
  let off = signature.length
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(4 + 4 + data.length + 4)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcSrc = new Uint8Array(4 + data.length)
  crcSrc.set(typeBytes, 0)
  crcSrc.set(data, 4)
  dv.setUint32(8 + data.length, crc32(crcSrc))
  return out
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  // Bun.deflateSync is raw DEFLATE — wrap as zlib (CMF/FLG + adler32) for PNG IDAT.
  const bunDeflate = (Bun as unknown as { deflateSync?: (d: Uint8Array) => Uint8Array }).deflateSync
  if (typeof bunDeflate === 'function') {
    const raw = bunDeflate(data)
    const out = new Uint8Array(2 + raw.length + 4)
    out[0] = 0x78
    out[1] = 0x01
    out.set(raw, 2)
    const adler = adler32(data)
    const o = 2 + raw.length
    out[o] = (adler >>> 24) & 0xff
    out[o + 1] = (adler >>> 16) & 0xff
    out[o + 2] = (adler >>> 8) & 0xff
    out[o + 3] = adler & 0xff
    return out
  }
  return zlibStore(data)
}

function zlibStore(data: Uint8Array): Uint8Array {
  // zlib header 0x78 0x01 (stored) + deflate stored blocks + adler32
  const blocks: Uint8Array[] = []
  let offset = 0
  const max = 65535
  while (offset < data.length) {
    const end = Math.min(offset + max, data.length)
    const len = end - offset
    const last = end === data.length ? 1 : 0
    const block = new Uint8Array(5 + len)
    block[0] = last // BFINAL + BTYPE=00
    block[1] = len & 0xff
    block[2] = (len >> 8) & 0xff
    const nlen = (~len) & 0xffff
    block[3] = nlen & 0xff
    block[4] = (nlen >> 8) & 0xff
    block.set(data.subarray(offset, end), 5)
    blocks.push(block)
    offset = end
  }
  if (data.length === 0) {
    blocks.push(new Uint8Array([1, 0, 0, 0xff, 0xff]))
  }

  const bodyLen = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(2 + bodyLen + 4)
  out[0] = 0x78
  out[1] = 0x01
  let o = 2
  for (const b of blocks) {
    out.set(b, o)
    o += b.length
  }
  const adler = adler32(data)
  out[o] = (adler >>> 24) & 0xff
  out[o + 1] = (adler >>> 16) & 0xff
  out[o + 2] = (adler >>> 8) & 0xff
  out[o + 3] = adler & 0xff
  return out
}

function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return (c ^ 0xffffffff) >>> 0
}
