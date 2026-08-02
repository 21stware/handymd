import type { EditorState, Transaction } from 'prosemirror-state'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Mapping } from 'prosemirror-transform'
import type { Node as PMNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { DiagramRenderCallback } from '../diagram'
import { parseDoc, type BlockMeta } from '../parse/docparse'
import { isRevealed, revealSignature, type SelLike } from './hittest'
import { buildBlockDecos, type DecorationContext } from './decorations'
import { spansIntersect } from '../elements'

/**
 * L3 conceal/reveal 状态机的宿主插件，同时承担 L2 管线的 Reconciling 阶段：
 *
 *   Reparse   → parseDoc（行内解析带文本缓存）
 *   HitTest   → isRevealed(el, selection, readOnly) 纯函数
 *   Decorate  → buildBlockDecos；选区路径只动签名变化的块；
 *               文档变更路径对「内容未变」的块 map 复用 decoration
 *
 * 关键架构决策：不为每个元素建状态对象。结果由
 * (doc, selection, composing, readOnly) 推导。
 *
 * IME 冻结：composing 期间 decoration 只 map，禁止重建与状态迁移。
 */

export interface ConcealMeta {
  composing?: boolean
  readOnly?: boolean
  /** 强制全量重算（compositionend / 外部主题切换等场景） */
  refresh?: boolean
}

export interface ConcealState {
  blocks: BlockMeta[]
  /** 每块的 reveal 签名 */
  sigs: string[]
  /** 每块缓存的 decoration 数组（签名/内容不变时复用或 map） */
  decoLists: Decoration[][]
  set: DecorationSet
  composing: boolean
  /** composing 期间发生过 docChanged，解冻后需要全量重算 */
  stale: boolean
  readOnly: boolean
}

export const concealKey = new PluginKey<ConcealState>('handymd-conceal')

function computeAll(
  doc: PMNode,
  sel: SelLike,
  readOnly: boolean,
  composing: boolean,
  ctx: DecorationContext,
): ConcealState {
  const blocks = parseDoc(doc)
  const sigs: string[] = []
  const decoLists: Decoration[][] = []
  const all: Decoration[] = []
  for (const block of blocks) {
    const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
    const decos = buildBlockDecos(block, revealed, ctx)
    sigs.push(revealSignature(revealed))
    decoLists.push(decos)
    for (const d of decos) all.push(d)
  }
  return {
    blocks,
    sigs,
    decoLists,
    set: DecorationSet.create(doc, all),
    composing,
    stale: false,
    readOnly,
  }
}

/** 内容是否可复用（仅位置平移）—— 影响 decoration 的字段一致即可 map */
function contentReusable(a: BlockMeta, b: BlockMeta): boolean {
  if (a.text !== b.text) return false
  if (a.line.t !== b.line.t) return false
  // 行类型携带的关键字段（heading level / fence info / ordered num…）
  if (JSON.stringify(a.line) !== JSON.stringify(b.line)) return false

  const edgeA = a.elements.find(
    (e) => e.kind === 'tableHeader' || e.kind === 'tableRow' || e.kind === 'tableSep',
  )?.attrs?.tableEdge
  const edgeB = b.elements.find(
    (e) => e.kind === 'tableHeader' || e.kind === 'tableRow' || e.kind === 'tableSep',
  )?.attrs?.tableEdge
  if (edgeA !== edgeB) return false

  const codeA = a.elements.find((e) => e.kind === 'diagramOpen')?.attrs?.code
  const codeB = b.elements.find((e) => e.kind === 'diagramOpen')?.attrs?.code
  if (codeA !== codeB) return false

  return true
}

function findBlockAt(blocks: BlockMeta[], pos: number): number {
  // blocks sorted by pos; binary search
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]!
    if (b.pos === pos) return mid
    if (b.pos < pos) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** Map a per-block deco list through a doc transaction; null = must rebuild. */
function mapDecoList(
  list: Decoration[],
  mapping: Mapping,
  oldDoc: PMNode,
  newDoc: PMNode,
): Decoration[] | null {
  if (list.length === 0) return []
  try {
    const set = DecorationSet.create(oldDoc, list)
    const mapped = set.map(mapping, newDoc)
    return mapped.find()
  } catch {
    return null
  }
}

function flattenDecos(decoLists: Decoration[][]): Decoration[] {
  const all: Decoration[] = []
  for (const list of decoLists) {
    for (const d of list) all.push(d)
  }
  return all
}

/**
 * 文档变更：parse 全量（分类依赖全局 fence/table 状态机），
 * decoration 对「映射后内容未变」的块 map 复用，仅重建脏块。
 */
function computeAfterDocChange(
  tr: Transaction,
  prev: ConcealState,
  oldDoc: PMNode,
  nextDoc: PMNode,
  sel: SelLike,
  readOnly: boolean,
  composing: boolean,
  ctx: DecorationContext,
): ConcealState {
  const newBlocks = parseDoc(nextDoc)
  const newToOld: (number | null)[] = new Array(newBlocks.length).fill(null)

  for (let j = 0; j < prev.blocks.length; j++) {
    const mapped = tr.mapping.mapResult(prev.blocks[j]!.pos, 1)
    if (mapped.deleted) continue
    const i = findBlockAt(newBlocks, mapped.pos)
    if (i < 0) continue
    if (newToOld[i] !== null) {
      // 映射冲突（复杂 replace/合并）→ 安全回退全量 decorate
      return computeAll(nextDoc, sel, readOnly, composing, ctx)
    }
    newToOld[i] = j
  }

  const sigs: string[] = new Array(newBlocks.length)
  const decoLists: Decoration[][] = new Array(newBlocks.length)

  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i]!
    const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
    const sig = revealSignature(revealed)
    sigs[i] = sig

    const j = newToOld[i]
    if (j !== null) {
      const oldBlock = prev.blocks[j]!
      if (contentReusable(oldBlock, block)) {
        if (prev.sigs[j] === sig) {
          const mapped = mapDecoList(prev.decoLists[j]!, tr.mapping, oldDoc, nextDoc)
          if (mapped) {
            decoLists[i] = mapped
            continue
          }
        } else {
          // 内容相同、仅 reveal 变化：按新绝对坐标重建
          decoLists[i] = buildBlockDecos(block, revealed, ctx)
          continue
        }
      }
    }
    decoLists[i] = buildBlockDecos(block, revealed, ctx)
  }

  return {
    blocks: newBlocks,
    sigs,
    decoLists,
    set: DecorationSet.create(nextDoc, flattenDecos(decoLists)),
    composing,
    stale: false,
    readOnly,
  }
}

function selTouchesBlock(block: BlockMeta, sel: SelLike): boolean {
  if (spansIntersect(sel.from, sel.to, block.pos, block.pos + block.size)) return true
  for (const el of block.elements) {
    if (spansIntersect(sel.from, sel.to, el.hitFrom, el.hitTo)) return true
  }
  return false
}

function sigHasReveal(sig: string): boolean {
  return sig.includes('1')
}

/**
 * 纯选区移动：只对「可能改变 reveal」的块做 hitTest。
 * 候选 = 旧选区触及 ∪ 新选区触及 ∪ 当前已 Revealed 的块。
 */
function computeAfterSelectionWithDoc(
  prev: ConcealState,
  doc: PMNode,
  oldSel: SelLike,
  newSel: SelLike,
  readOnly: boolean,
  ctx: DecorationContext,
): ConcealState {
  const candidates = new Set<number>()
  for (let i = 0; i < prev.blocks.length; i++) {
    const block = prev.blocks[i]!
    if (selTouchesBlock(block, oldSel) || selTouchesBlock(block, newSel)) {
      candidates.add(i)
      continue
    }
    if (sigHasReveal(prev.sigs[i]!)) candidates.add(i)
  }

  if (candidates.size === 0) return prev

  let changed = false
  const sigs = prev.sigs.slice()
  const decoLists = prev.decoLists.slice()

  for (const i of candidates) {
    const block = prev.blocks[i]!
    const revealed = block.elements.map((el) => isRevealed(el, newSel, readOnly))
    const sig = revealSignature(revealed)
    if (sig === prev.sigs[i]) continue
    changed = true
    sigs[i] = sig
    decoLists[i] = buildBlockDecos(block, revealed, ctx)
  }

  if (!changed) return prev

  return {
    ...prev,
    sigs,
    decoLists,
    set: DecorationSet.create(doc, flattenDecos(decoLists)),
  }
}

export interface ConcealOptions {
  readOnly?: boolean
  /**
   * diagram block（如 ```mermaid）在 Concealed 态的渲染回调
   * （见 diagram.ts 的 createDiagramRenderCallback）。缺省时 diagram
   * block 按普通 code block 呈现。
   */
  renderDiagram?: DiagramRenderCallback
}

export function concealPlugin(options: ConcealOptions = {}): Plugin<ConcealState> {
  const ctx: DecorationContext = { renderDiagram: options.renderDiagram }

  return new Plugin<ConcealState>({
    key: concealKey,

    state: {
      init: (_config, state: EditorState) =>
        computeAll(state.doc, state.selection, options.readOnly ?? false, false, ctx),

      apply: (tr: Transaction, prev: ConcealState, old: EditorState, next: EditorState) => {
        let { composing, readOnly } = prev
        let refresh = false

        const meta = tr.getMeta(concealKey) as ConcealMeta | undefined
        if (meta) {
          if (meta.composing !== undefined && meta.composing !== composing) {
            composing = meta.composing
            if (!composing) refresh = true // 解冻 → 补一次全量重算
          }
          if (meta.readOnly !== undefined && meta.readOnly !== readOnly) {
            readOnly = meta.readOnly
            refresh = true
          }
          if (meta.refresh) refresh = true
        }

        // —— IME 冻结：只 map，不 hitTest，不重建 ——
        if (composing) {
          return {
            ...prev,
            composing,
            readOnly,
            stale: prev.stale || tr.docChanged,
            set: tr.docChanged ? prev.set.map(tr.mapping, tr.doc) : prev.set,
          }
        }

        // —— 强制全量（解冻 / readOnly / refresh） ——
        if (refresh || prev.stale) {
          return computeAll(next.doc, next.selection, readOnly, composing, ctx)
        }

        // —— 文档变化：parse 全量 + decoration 增量 map/rebuild ——
        if (tr.docChanged) {
          return computeAfterDocChange(
            tr,
            prev,
            old.doc,
            next.doc,
            next.selection,
            readOnly,
            composing,
            ctx,
          )
        }

        // —— 纯 selection 移动：局部 hitTest ——
        if (!next.selection.eq(old.selection)) {
          return computeAfterSelectionWithDoc(
            prev,
            next.doc,
            old.selection,
            next.selection,
            readOnly,
            ctx,
          )
        }

        return prev
      },
    },

    props: {
      decorations(state) {
        return concealKey.getState(state)?.set
      },
    },
  })
}

/** 向 conceal 状态机投递配置迁移（readOnly / composing / 强制重算）。 */
export function setConcealMeta(tr: Transaction, meta: ConcealMeta): Transaction {
  return tr.setMeta(concealKey, meta)
}
