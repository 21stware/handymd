import type { EditorState, Transaction } from 'prosemirror-state'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { parseDoc, type BlockMeta } from '../parse/docparse'
import { isRevealed, revealSignature, type SelLike } from './hittest'
import { buildBlockDecos } from './decorations'

/**
 * L3 conceal/reveal 状态机的宿主插件，同时承担 L2 管线的 Reconciling 阶段：
 *
 *   Reparse   → parseDoc（行内解析带文本缓存，未编辑行 O(1) 命中）
 *   HitTest   → isRevealed(el, selection, readOnly) 纯函数
 *   Decorate  → buildBlockDecos，只重建 reveal 签名变化的块
 *
 * 关键架构决策：不为每个元素建状态对象。每次事务后由
 * (doc, selection, composing, readOnly) 四元组纯函数推导出全量结果，
 * undo/redo、协同 patch、粘贴等一切改动路径自动正确。
 *
 * IME 冻结：composing 期间 decoration 只做位置映射(map)，禁止重建、
 * 禁止 conceal/reveal 迁移；compositionend 后由 ime 插件补一次 meta
 * 事务触发全量重算。
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
  /** 每块缓存的 decoration 数组（签名不变时复用） */
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
): ConcealState {
  const blocks = parseDoc(doc)
  const sigs: string[] = []
  const decoLists: Decoration[][] = []
  const all: Decoration[] = []
  for (const block of blocks) {
    const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
    const decos = buildBlockDecos(block, revealed)
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

export interface ConcealOptions {
  readOnly?: boolean
}

export function concealPlugin(options: ConcealOptions = {}): Plugin<ConcealState> {
  return new Plugin<ConcealState>({
    key: concealKey,

    state: {
      init: (_config, state: EditorState) =>
        computeAll(state.doc, state.selection, options.readOnly ?? false, false),

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

        // —— 文档变化 / 解冻 / 配置变化：全量重算（行内解析有文本缓存兜底） ——
        if (tr.docChanged || prev.stale || refresh) {
          return computeAll(next.doc, next.selection, readOnly, composing)
        }

        // —— 纯 selection 移动：只有判定结果变化的块才重建 decoration ——
        if (!next.selection.eq(old.selection)) {
          const sel = next.selection
          const sigs: string[] = new Array(prev.blocks.length)
          const revs: (boolean[] | null)[] = new Array(prev.blocks.length)
          let changed = false
          for (let i = 0; i < prev.blocks.length; i++) {
            const block = prev.blocks[i]
            const revealed = block.elements.map((el) => isRevealed(el, sel, readOnly))
            const sig = revealSignature(revealed)
            sigs[i] = sig
            revs[i] = sig !== prev.sigs[i] ? revealed : null
            if (revs[i]) changed = true
          }
          if (!changed) return prev

          const decoLists: Decoration[][] = new Array(prev.blocks.length)
          const all: Decoration[] = []
          for (let i = 0; i < prev.blocks.length; i++) {
            const list = revs[i] ? buildBlockDecos(prev.blocks[i], revs[i]!) : prev.decoLists[i]
            decoLists[i] = list
            for (const d of list) all.push(d)
          }
          return {
            ...prev,
            sigs,
            decoLists,
            set: DecorationSet.create(next.doc, all),
          }
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
