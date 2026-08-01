import type { Node as PMNode } from 'prosemirror-model'
import type { ElementRange, RelElement, Span } from '../elements'
import { classifyLines, type LineInfo } from './blocks'
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

export function parseDoc(doc: PMNode): BlockMeta[] {
  const texts: string[] = []
  const positions: { pos: number; size: number }[] = []
  doc.forEach((node, offset) => {
    texts.push(node.textContent)
    positions.push({ pos: offset, size: node.nodeSize })
  })

  const lines = classifyLines(texts)

  // fence / diagram 区域配对：open 行的 hit 区间覆盖整个围栏块（含 close 行），
  // 这样光标在块内部任意位置时整个区域都保持 Revealed。
  // diagram 额外在 open 行上聚合围栏体源码（渲染图表的输入）。
  const fenceRegion = new Map<number, { from: number; to: number }>()
  const diagramCode = new Map<number, string>()
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].t
    if (t !== 'fenceOpen' && t !== 'diagramOpen') continue
    const bodyT = t === 'fenceOpen' ? 'code' : 'diagramLine'
    const closeT = t === 'fenceOpen' ? 'fenceClose' : 'diagramClose'
    let j = i + 1
    while (j < lines.length && lines[j].t === bodyT) j++
    const last = j < lines.length && lines[j].t === closeT ? j : j - 1
    const region = {
      from: positions[i].pos,
      to: positions[last].pos + positions[last].size,
    }
    for (let k = i; k <= last; k++) fenceRegion.set(k, region)
    if (t === 'diagramOpen') diagramCode.set(i, texts.slice(i + 1, j).join('\n'))
  }

  // 表格区域：标记首/末行，供边框样式使用
  const tableEdge = new Map<number, 'first' | 'last' | 'only'>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t !== 'tableHeader') continue
    let j = i + 1
    while (j < lines.length && (lines[j].t === 'tableSep' || lines[j].t === 'tableRow')) j++
    const last = j - 1
    if (last === i) tableEdge.set(i, 'only')
    else {
      tableEdge.set(i, 'first')
      tableEdge.set(last, 'last')
    }
  }

  const blocks: BlockMeta[] = []
  for (let i = 0; i < texts.length; i++) {
    const { pos, size } = positions[i]
    const text = texts[i]
    const start = pos + 1 // 行内文本起点（绝对坐标）
    const blockHit = { hitFrom: pos, hitTo: pos + size }
    const li = lines[i]
    const els: ElementRange[] = []

    /** 对 prefix 之后的内容做行内解析 */
    const inline = (offset: number): void => {
      const sub = text.slice(offset)
      if (!sub) return
      for (const rel of parseInlineCached(sub)) els.push(abs(rel, start + offset))
    }

    switch (li.t) {
      case 'heading':
        // 不设 permanent：聚焦时展示层级图标（非源码）；`#`/`##` 在 decoration 层永远隐藏
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
        // 序号保持可见（隐藏数字会让人迷失），只做弱化样式 —— static
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
        // 代码块内部永远是源码：static 元素，只有底色样式，无 conceal
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

      // —— diagram block：与 code block 在结构化解析层就分开 ——
      // 三种行共享整块区域作为 hit 区间（都不 static / permanent）：
      // 光标在区域外 → 全部 Concealed（隐藏源码、渲染图表 widget）；
      // 光标进入区域 → 全部 Revealed（回到围栏源码编辑态）。
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
        // 表头/表体不 permanent：Concealed 用整行 widget 画列（避免 PM 合并
        // inline deco 拆列）；光标进入 Revealed 编辑源码。分隔行永久折叠。
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
            const cell = parsed.cells[c]
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

    blocks.push({ pos, size, text, line: li, elements: els })
  }
  return blocks
}
