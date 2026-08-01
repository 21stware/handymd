/**
 * Build the handymd PWA app.
 *
 * Env:
 *   OUTDIR  output directory (default `dist`)
 *   BASE    public path prefix (default `/`)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const outdir = process.env.OUTDIR ?? 'dist'
const baseRaw = process.env.BASE ?? '/'
const base = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`

await rm(outdir, { recursive: true, force: true })
await mkdir(join(outdir, 'icons'), { recursive: true })

// ——— 1) Bundle app JS ———
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
await cp('manifest.webmanifest', join(outdir, 'manifest.webmanifest'))

// ——— 3) PWA PNG icons ———
await writeFile(join(outdir, 'icons/icon-192.png'), await encodeBrandIcon(192))
await writeFile(join(outdir, 'icons/icon-512.png'), await encodeBrandIcon(512))

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
      const r0 = 0xe8, g0 = 0xa0, b0 = 0x7a
      const r1 = 0xc9, g1 = 0x60, b1 = 0x3c
      const r2 = 0x8f, g2 = 0x3d, b2 = 0x28
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
  const blocks: Uint8Array[] = []
  let offset = 0
  const max = 65535
  while (offset < data.length) {
    const end = Math.min(offset + max, data.length)
    const len = end - offset
    const last = end === data.length ? 1 : 0
    const block = new Uint8Array(5 + len)
    block[0] = last
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
