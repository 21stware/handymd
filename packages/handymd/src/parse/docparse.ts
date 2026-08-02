import type { Node as PMNode } from 'prosemirror-model'
import type { Mapping } from 'prosemirror-transform'
import type { ElementRange, RelElement, Span } from '../elements'
import { classifyLines, lineInfoEqual, type LineInfo } from './blocks'
import { parseInlineCached } from './inline'
import { parseTableRow } from './table'

/**
 * 元素范围表：每个 block（行）一条 BlockMeta，携带该行解析出的全部元素
 * （绝对文档坐标）。这是 L3 状态机实例集合的物理载体。
 */
export interface BlockMeta {
  /** block 节点自身位置 */
  pos: number
  /** block 节点 nodeSize（内容 = [pos+1, pos+size-1]） */
  size: number
  text: string
  line: LineInfo
  elements: ElementRange[]
}

function abs(rel: RelElement, base: number, hitPad = 1): ElementRange {
  const shift = (s: Span): Span => ({ from: s.from + base, to: s.to + base })
  return {
    ...rel,
    from: rel.from + base,
    to: rel.to + base,
    hitFrom: rel.static ? rel.from + base : rel.from + base - hitPad,
    hitTo: rel.static ? rel.to + base : rel.to + base + hitPad,
    markers: rel.markers.map(shift),
    content: rel.content ? shift(rel.content) : undefined,
  }
}

function mapSpan(s: Span, mapping: Mapping): Span | null {
  const fromR = mapping.mapResult(s.from, 1)
  const toR = mapping.mapResult(s.to, -1)
  if (fromR.deleted || toR.deleted) return null
  if (fromR.pos > toR.pos) return null
  return { from: fromR.pos, to: toR.pos }
}

/** 将旧元素绝对坐标 map 到新文档；任一子范围丢失则失败（调用方重解析该行）。 */
function mapElement(el: ElementRange, mapping: Mapping): ElementRange | null {
  const fromR = mapping.mapResult(el.from, 1)
  const toR = mapping.mapResult(el.to, -1)
  if (fromR.deleted || toR.deleted) return null
  if (fromR.pos > toR.pos) return null

  const hitFromR = mapping.mapResult(el.hitFrom, 1)
  const hitToR = mapping.mapResult(el.hitTo, -1)
  if (hitFromR.deleted || hitToR.deleted) return null

  const markers: Span[] = []
  for (const m of el.markers) {
    const mm = mapSpan(m, mapping)
    if (!mm) return null
    markers.push(mm)
  }

  let content: Span | undefined
  if (el.content) {
    const c = mapSpan(el.content, mapping)
    if (!c) return null
    content = c
  }

  let attrs = el.attrs
  if (attrs?.checkPos !== undefined) {
    const cp = mapping.mapResult(attrs.checkPos, 1)
    if (cp.deleted) return null
    attrs = { ...attrs, checkPos: cp.pos }
  }

  return {
    ...el,
    from: fromR.pos,
    to: toR.pos,
    hitFrom: hitFromR.pos,
    hitTo: hitToR.pos,
    markers,
    content,
    attrs,
  }
}

function mapElements(els: ElementRange[], mapping: Mapping): ElementRange[] | null {
  const out: ElementRange[] = []
  for (const el of els) {
    const m = mapElement(el, mapping)
    if (!m) return null
    out.push(m)
  }
  return out
}

type RegionMaps = {
  fenceRegion: Map<number, { from: number; to: number }>
  diagramCode: Map<number, string>
  tableEdge: Map<number, 'first' | 'last' | 'only'>
}

function collectLines(doc: PMNode): {
  texts: string[]
  positions: { pos: number; size: number }[]
} {
  const texts: string[] = []
  const positions: { pos: number; size: number }[] = []
  doc.forEach((node, offset) => {
    texts.push(node.textContent)
    positions.push({ pos: offset, size: node.nodeSize })
  })
  return { texts, positions }
}

function buildRegions(
  lines: LineInfo[],
  texts: string[],
  positions: { pos: number; size: number }[],
): RegionMaps {
  const fenceRegion = new Map<number, { from: number; to: number }>()
  const diagramCode = new Map<number, string>()
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.t
    if (t !== 'fenceOpen' && t !== 'diagramOpen') continue
    const bodyT = t === 'fenceOpen' ? 'code' : 'diagramLine'
    const closeT = t === 'fenceOpen' ? 'fenceClose' : 'diagramClose'
    let j = i + 1
    while (j < lines.length && lines[j]!.t === bodyT) j++
    const last = j < lines.length && lines[j]!.t === closeT ? j : j - 1
    const region = {
      from: positions[i]!.pos,
      to: positions[last]!.pos + positions[last]!.size,
    }
    for (let k = i; k <= last; k++) fenceRegion.set(k, region)
    if (t === 'diagramOpen') diagramCode.set(i, texts.slice(i + 1, j).join('\n'))
  }

  const tableEdge = new Map<number, 'first' | 'last' | 'only'>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.t !== 'tableHeader') continue
    let j = i + 1
    while (j < lines.length && (lines[j]!.t === 'tableSep' || lines[j]!.t === 'tableRow')) j++
    const last = j - 1
    if (last === i) tableEdge.set(i, 'only')
    else {
      tableEdge.set(i, 'first')
      tableEdge.set(last, 'last')
    }
  }

  return { fenceRegion, diagramCode, tableEdge }
}

/** 单行元素解析（绝对坐标）。 */
function buildLineElements(
  i: number,
  text: string,
  pos: number,
  size: number,
  li: LineInfo,
  regions: RegionMaps,
): ElementRange[] {
  const start = pos + 1
  const blockHit = { hitFrom: pos, hitTo: pos + size }
  const els: ElementRange[] = []
  const { fenceRegion, diagramCode, tableEdge } = regions

  const inline = (offset: number): void => {
    const sub = text.slice(offset)
    if (!sub) return
    for (const rel of parseInlineCached(sub)) els.push(abs(rel, start + offset))
  }

  switch (li.t) {
    case 'heading':
      els.push({
        kind: 'heading',
        scope: 'block',
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start, to: start + li.prefixLen }],
        content: { from: start + li.prefixLen, to: start + text.length },
        attrs: { level: li.level },
      })
      inline(li.prefixLen)
      break

    case 'quote':
      els.push({
        kind: 'quote',
        scope: 'block',
        permanent: true,
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start, to: start + li.prefixLen }],
        content: { from: start + li.prefixLen, to: start + text.length },
      })
      inline(li.prefixLen)
      break

    case 'todo':
      els.push({
        kind: 'todo',
        scope: 'block',
        permanent: true,
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start + li.indent, to: start + li.prefixLen }],
        content: { from: start + li.prefixLen, to: start + text.length },
        attrs: {
          checked: li.checked,
          checkPos: start + li.checkOffset,
          indent: li.indent,
        },
      })
      inline(li.prefixLen)
      break

    case 'bullet':
      els.push({
        kind: 'bullet',
        scope: 'block',
        permanent: true,
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start + li.indent, to: start + li.prefixLen }],
        content: { from: start + li.prefixLen, to: start + text.length },
        attrs: { indent: li.indent },
      })
      inline(li.prefixLen)
      break

    case 'ordered':
      els.push({
        kind: 'ordered',
        scope: 'block',
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start + li.indent, to: start + li.prefixLen }],
        content: { from: start + li.prefixLen, to: start + text.length },
        attrs: { indent: li.indent, num: li.num },
        static: true,
      })
      inline(li.prefixLen)
      break

    case 'hr':
      els.push({
        kind: 'hr',
        scope: 'block',
        permanent: true,
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [{ from: start, to: start + text.length }],
      })
      break

    case 'fenceOpen': {
      const region = fenceRegion.get(i)!
      els.push({
        kind: 'fenceOpen',
        scope: 'block',
        from: pos,
        to: pos + size,
        hitFrom: region.from,
        hitTo: region.to,
        markers: [{ from: start, to: start + text.length }],
        attrs: { info: li.info },
      })
      break
    }

    case 'fenceClose': {
      const region = fenceRegion.get(i) ?? { from: pos, to: pos + size }
      els.push({
        kind: 'fenceClose',
        scope: 'block',
        from: pos,
        to: pos + size,
        hitFrom: region.from,
        hitTo: region.to,
        markers: [{ from: start, to: start + text.length }],
      })
      break
    }

    case 'code':
      els.push({
        kind: 'codeLine',
        scope: 'block',
        from: pos,
        to: pos + size,
        ...blockHit,
        markers: [],
        static: true,
      })
      break

    case 'diagramOpen': {
      const region = fenceRegion.get(i)!
      els.push({
        kind: 'diagramOpen',
        scope: 'block',
        from: pos,
        to: pos + size,
        hitFrom: region.from,
        hitTo: region.to,
        markers: [{ from: start, to: start + text.length }],
        attrs: { info: li.info, lang: li.lang, code: diagramCode.get(i) ?? '' },
      })
      break
    }

    case 'diagramLine': {
      const region = fenceRegion.get(i) ?? { from: pos, to: pos + size }
      els.push({
        kind: 'diagramLine',
        scope: 'block',
        from: pos,
        to: pos + size,
        hitFrom: region.from,
        hitTo: region.to,
        markers: [{ from: start, to: start + text.length }],
      })
      break
    }

    case 'diagramClose': {
      const region = fenceRegion.get(i) ?? { from: pos, to: pos + size }
      els.push({
        kind: 'diagramClose',
        scope: 'block',
        from: pos,
        to: pos + size,
        hitFrom: region.from,
        hitTo: region.to,
        markers: [{ from: start, to: start + text.length }],
      })
      break
    }

    case 'tableHeader':
    case 'tableRow':
    case 'tableSep': {
      const colCount = li.colCount
      const edge = tableEdge.get(i)
      const parsed = parseTableRow(text)
      const kind = li.t
      els.push({
        kind,
        scope: 'block',
        permanent: kind === 'tableSep',
        from: pos,
        to: pos + size,
        ...blockHit,
        markers:
          kind === 'tableSep'
            ? [{ from: start, to: start + text.length }]
            : parsed.pipes.map((p) => ({ from: start + p.from, to: start + p.to })),
        attrs: { colCount, tableEdge: edge },
      })
      if (kind !== 'tableSep') {
        for (let c = 0; c < parsed.cells.length; c++) {
          const cell = parsed.cells[c]!
          const cFrom = start + cell.from
          const cTo = start + cell.to
          els.push({
            kind: 'tableCell',
            scope: 'inline',
            from: cFrom,
            to: cTo,
            hitFrom: cFrom,
            hitTo: cTo,
            markers: [],
            content: { from: cFrom, to: cTo },
            attrs: { col: c, colCount },
            static: true,
          })
          if (cell.text) {
            for (const rel of parseInlineCached(cell.text)) {
              els.push(abs(rel, cFrom))
            }
          }
        }
      }
      break
    }

    case 'para':
      inline(0)
      break

    case 'blank':
      break
  }

  return els
}

const REGION_HIT_KINDS = new Set([
  'fenceOpen',
  'fenceClose',
  'diagramOpen',
  'diagramClose',
  'diagramLine',
])

/**
 * map 后校正块级元素外框。ProseMirror structure split 会把旧块的 `to`/`hitTo`
 * 映射到新插入行的末尾，导致上一行仍“命中”光标（标题双 badge 等）。
 */
function clampMappedBlockBounds(
  els: ElementRange[],
  pos: number,
  size: number,
  region: { from: number; to: number } | undefined,
): ElementRange[] {
  const end = pos + size
  return els.map((el) => {
    if (el.scope !== 'block') return el
    if (REGION_HIT_KINDS.has(el.kind) && region) {
      return { ...el, from: pos, to: end, hitFrom: region.from, hitTo: region.to }
    }
    return { ...el, from: pos, to: end, hitFrom: pos, hitTo: end }
  })
}

/** 结构字段是否允许从旧行 map 元素（含 tableEdge / diagram code）。 */
function lineStructureEqual(
  old: BlockMeta,
  text: string,
  li: LineInfo,
  edge: 'first' | 'last' | 'only' | undefined,
  diagramCode: string | undefined,
): boolean {
  if (old.text !== text) return false
  if (!lineInfoEqual(old.line, li)) return false
  const oldEdge = old.elements.find(
    (e) => e.kind === 'tableHeader' || e.kind === 'tableRow' || e.kind === 'tableSep',
  )?.attrs?.tableEdge
  if (oldEdge !== edge) return false
  const oldCode = old.elements.find((e) => e.kind === 'diagramOpen')?.attrs?.code
  if ((oldCode ?? '') !== (diagramCode ?? '')) return false
  return true
}

export function parseDoc(doc: PMNode): BlockMeta[] {
  const { texts, positions } = collectLines(doc)
  const lines = classifyLines(texts)
  const regions = buildRegions(lines, texts, positions)
  const blocks: BlockMeta[] = []
  for (let i = 0; i < texts.length; i++) {
    const { pos, size } = positions[i]!
    const text = texts[i]!
    const li = lines[i]!
    blocks.push({
      pos,
      size,
      text,
      line: li,
      elements: buildLineElements(i, text, pos, size, li, regions),
    })
  }
  return blocks
}

/**
 * 增量 parse：全量 classify（fence/table 状态机需要），
 * 对「文本 + 行类型 + 结构 attrs 未变」的行 map 旧 elements，跳过 parseInline。
 */
export function parseDocIncremental(
  doc: PMNode,
  prevBlocks: BlockMeta[],
  mapping: Mapping,
): BlockMeta[] {
  const { texts, positions } = collectLines(doc)
  const lines = classifyLines(texts)
  const regions = buildRegions(lines, texts, positions)

  // old block index → new line index via mapped pos
  const newToOld: (number | null)[] = new Array(texts.length).fill(null)
  for (let j = 0; j < prevBlocks.length; j++) {
    const mapped = mapping.mapResult(prevBlocks[j]!.pos, 1)
    if (mapped.deleted) continue
    // find line with pos === mapped.pos
    let lo = 0
    let hi = positions.length - 1
    let i = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const p = positions[mid]!.pos
      if (p === mapped.pos) {
        i = mid
        break
      }
      if (p < mapped.pos) lo = mid + 1
      else hi = mid - 1
    }
    if (i < 0) continue
    if (newToOld[i] !== null) {
      // 冲突 → 全量
      return parseDoc(doc)
    }
    newToOld[i] = j
  }

  const blocks: BlockMeta[] = []
  for (let i = 0; i < texts.length; i++) {
    const { pos, size } = positions[i]!
    const text = texts[i]!
    const li = lines[i]!
    const edge = regions.tableEdge.get(i)
    const dcode = regions.diagramCode.get(i)

    const j = newToOld[i]
    if (j !== null) {
      const old = prevBlocks[j]!
      if (lineStructureEqual(old, text, li, edge, dcode)) {
        const mappedEls = mapElements(old.elements, mapping)
        if (mappedEls) {
          // structure split 时 map 会把块级 from/to/hit 拉到下一行；
          // markers/content 通常仍准，外框按新块（及 fence region）收紧。
          blocks.push({
            pos,
            size,
            text,
            line: li,
            elements: clampMappedBlockBounds(mappedEls, pos, size, regions.fenceRegion.get(i)),
          })
          continue
        }
      }
    }

    blocks.push({
      pos,
      size,
      text,
      line: li,
      elements: buildLineElements(i, text, pos, size, li, regions),
    })
  }
  return blocks
}
