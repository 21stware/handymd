import type { EditorState, Transaction } from 'prosemirror-state'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { DiagramRenderCallback } from '../diagram'
import { parseDoc, parseDocIncremental, type BlockMeta } from '../parse/docparse'
import { lineInfoEqual } from '../parse/blocks'
import { isRevealed, revealSignature, type SelLike } from './hittest'
import { buildBlockDecos, type DecorationContext } from './decorations'
import { spansIntersect } from '../elements'

/**
 * L3 conceal/reveal 状态机的宿主插件，同时承担 L2 管线的 Reconciling 阶段：
 *
 *   Reparse   → parseDocIncremental（未改行 map 元素；脏行重解析 + 行内缓存）
 *   HitTest   → isRevealed(el, selection, readOnly) 纯函数
 *   Decorate  → 整篇 DecorationSet 只 map 一次，然后对「脏块」做 remove/add
 *
 * 关键架构决策：不为每个元素建状态对象。结果由
 * (doc, selection, composing, readOnly) 推导。
 *
 * 性能约束（决定了这里的写法）：DecorationSet.create() 的代价是
 * O(块数 × decoration 数)，在扁平的「一行一个 block」文档里就是 O(N²)。
 * 所以稳态路径（按键 / 移光标）绝不能重建整个 set —— 只能 map + 局部
 * remove/add，这两者的代价只跟脏块数量有关。create 仅用于首次构建与
 * 强制全量重算。
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
  const all: Decoration[] = []
  for (const block of blocks) {
    const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
    sigs.push(revealSignature(revealed))
    for (const d of buildBlockDecos(block, revealed, ctx)) all.push(d)
  }
  return {
    // 注意：DecorationSet.create 会就地把 all 的元素置 null，所以只能传自己的临时数组
    set: DecorationSet.create(doc, all),
    blocks,
    sigs,
    composing,
    stale: false,
    readOnly,
  }
}

/** 内容是否可复用（仅位置平移）—— 影响 decoration 的字段一致即可 map */
function contentReusable(a: BlockMeta, b: BlockMeta): boolean {
  if (a.text !== b.text) return false
  // 行类型携带的关键字段（heading level / fence info / ordered num…）
  if (!lineInfoEqual(a.line, b.line)) return false

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

/** 需要重建 decoration 的块 */
interface DirtyBlock {
  block: BlockMeta
  revealed: boolean[]
}

/**
 * 把脏块的 decoration 换掉，其余原样保留。
 *
 * DecorationSet.find 用的是闭区间判定，会把相邻块的 node decoration
 * （端点正好落在边界上）一起带出来，所以要收窄到真正落在本块内的那些，
 * 否则会误删邻居的块级样式。
 */
function patchBlocks(
  set: DecorationSet,
  doc: PMNode,
  dirty: DirtyBlock[],
  ctx: DecorationContext,
): DecorationSet {
  if (dirty.length === 0) return set
  const remove: Decoration[] = []
  const add: Decoration[] = []
  for (const { block, revealed } of dirty) {
    const end = block.pos + block.size
    for (const d of set.find(block.pos, end)) {
      if (d.to > block.pos && d.from < end) remove.push(d)
    }
    for (const d of buildBlockDecos(block, revealed, ctx)) add.push(d)
  }
  // remove/add 同样会就地改写传入的数组，这两个都是本函数的临时数组
  return set.remove(remove).add(doc, add)
}

/**
 * 文档变更：
 *   parse → parseDocIncremental（未改行跳过 parseInline）
 *   deco  → 整篇 map 一次，只有内容或签名变了的块才 remove/add
 */
function computeAfterDocChange(
  tr: Transaction,
  prev: ConcealState,
  nextDoc: PMNode,
  sel: SelLike,
  readOnly: boolean,
  composing: boolean,
  ctx: DecorationContext,
): ConcealState {
  const newBlocks = parseDocIncremental(nextDoc, prev.blocks, tr.mapping)
  const newToOld: (number | null)[] = new Array(newBlocks.length).fill(null)

  for (let j = 0; j < prev.blocks.length; j++) {
    const mapped = tr.mapping.mapResult(prev.blocks[j]!.pos, 1)
    if (mapped.deleted) continue
    const i = findBlockAt(newBlocks, mapped.pos)
    if (i < 0) continue
    if (newToOld[i] !== null) {
      // 映射冲突 → 全量 parse + decorate（最稳）
      return computeAll(nextDoc, sel, readOnly, composing, ctx)
    }
    newToOld[i] = j
  }

  const sigs: string[] = new Array(newBlocks.length)
  const dirty: DirtyBlock[] = []
  // 先 map：结构 split 时 node decoration 可能被丢弃（文本未变也会），
  // 下面要对「可复用」块做一次完整性检查。
  const mappedSet = prev.set.map(tr.mapping, nextDoc)

  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i]!
    const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
    const sig = revealSignature(revealed)
    sigs[i] = sig

    const j = newToOld[i]
    // 内容与签名都没变的块，decoration 跟着 map 平移即可，无需重建
    if (j !== null && prev.sigs[j] === sig && contentReusable(prev.blocks[j]!, block)) {
      // Enter 续行等 structure split：首行文本不变，但 node deco 会被 map 丢掉，
      // 表现为 quote/todo/列表上一行样式消失——缺则强制重建。
      if (blockNeedsNodeDeco(block) && !hasExactNodeDeco(mappedSet, block)) {
        dirty.push({ block, revealed })
      }
      continue
    }
    dirty.push({ block, revealed })
  }

  return {
    blocks: newBlocks,
    sigs,
    set: patchBlocks(mappedSet, nextDoc, dirty, ctx),
    composing,
    stale: false,
    readOnly,
  }
}

/** 块级样式依赖 Decoration.node；普通段落没有 */
function blockNeedsNodeDeco(block: BlockMeta): boolean {
  return block.elements.some((el) => el.scope === 'block')
}

function hasExactNodeDeco(set: DecorationSet, block: BlockMeta): boolean {
  const end = block.pos + block.size
  for (const d of set.find(block.pos, end)) {
    if (
      (d.spec as { role?: string } | null)?.role === 'node' &&
      d.from === block.pos &&
      d.to === end
    ) {
      return true
    }
  }
  return false
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
  const dirty: DirtyBlock[] = []
  let sigs: string[] | null = null

  for (let i = 0; i < prev.blocks.length; i++) {
    const block = prev.blocks[i]!
    if (
      !selTouchesBlock(block, oldSel) &&
      !selTouchesBlock(block, newSel) &&
      !sigHasReveal(prev.sigs[i]!)
    ) {
      continue
    }
    const revealed = block.elements.map((el) => isRevealed(el, newSel, readOnly))
    const sig = revealSignature(revealed)
    if (sig === prev.sigs[i]) continue
    if (!sigs) sigs = prev.sigs.slice()
    sigs[i] = sig
    dirty.push({ block, revealed })
  }

  if (!sigs) return prev

  return {
    ...prev,
    sigs,
    set: patchBlocks(prev.set, doc, dirty, ctx),
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
          return computeAfterDocChange(tr, prev, next.doc, next.selection, readOnly, composing, ctx)
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
