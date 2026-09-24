import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { Plugin, TextSelection } from 'prosemirror-state'
import { keymap } from 'prosemirror-keymap'
import { schema } from './schema'
import { concealKey } from './conceal/plugin'
import { permanentPrefixAt } from './caret'
import type { LineInfo } from './parse/blocks'
import {
  continueTableRow,
  goToNextTableCell,
  goToPrevTableCell,
} from './table'

/**
 * 源码模型下大部分 input rule 都是多余的 —— 输入 `## ` 本身就会被解析成标题。
 * 这里只保留真正需要"替用户打字/跳光标"的场景：列表续行、标题行首回车、
 * 前缀退出、行内标记切换、列表缩进。
 */

function lineInfoAt(state: EditorState, blockPos: number): LineInfo | null {
  const st = concealKey.getState(state)
  if (!st) return null
  for (const block of st.blocks) {
    if (block.pos === blockPos) return block.line
  }
  return null
}

/** 由行类型重建下一行应携带的前缀；null 表示这不是可续行的块 */
function continuationPrefix(line: LineInfo, text: string): string | null {
  switch (line.t) {
    case 'todo': {
      const bullet = text[line.indent] ?? '-'
      return `${' '.repeat(line.indent)}${bullet} [ ] `
    }
    case 'bullet':
      return text.slice(0, line.prefixLen)
    case 'ordered': {
      const delim = text[line.indent + line.numLen] ?? '.'
      return `${' '.repeat(line.indent)}${line.num + 1}${delim} `
    }
    case 'quote':
      return text.slice(0, line.prefixLen)
    // 标题不续行：行中/行末 Enter 拆出普通段落（见 continueListItem）
    default:
      return null
  }
}

/** 行首插入时新行应带的"空"前缀：待办一律未勾选，有序列表沿用当前序号（normalize 再重排） */
function freshPrefix(line: LineInfo, text: string): string | null {
  switch (line.t) {
    case 'todo': {
      const bullet = text[line.indent] ?? '-'
      return `${' '.repeat(line.indent)}${bullet} [ ] `
    }
    case 'ordered':
      return text.slice(0, line.prefixLen)
    case 'bullet':
    case 'quote':
      return text.slice(0, line.prefixLen)
    default:
      return null
  }
}

const SPLITTABLE_INLINE = new Set(['strong', 'em', 'strike', 'mark', 'code'])

/**
 * 在行内标记中间回车：左半补闭合标记、右半补开启标记，两段都保持格式
 * （`**bo|ld**` → `**bo**` / `**ld**`）。光标紧贴标记内侧时把拆分点移到元素外侧，
 * 避免拆出空的 `****`。
 */
function inlineSplitAt(
  state: EditorState,
  blockPos: number,
  pos: number,
): { at: number; close: string; open: string } {
  const st = concealKey.getState(state)
  const block = st?.blocks.find((b) => b.pos === blockPos)
  const els = (block?.elements ?? [])
    .filter((el) => SPLITTABLE_INLINE.has(el.kind) && el.content && el.markers.length === 2)
    .sort((a, b) => a.from - b.from || b.to - a.to)
  let at = pos
  for (const el of els) {
    const c = el.content!
    if (at > el.from && at <= c.from) at = el.from
    else if (at >= c.to && at < el.to) at = el.to
  }
  const enclosing = els.filter((el) => el.content!.from < at && at < el.content!.to)
  const doc = state.doc
  const open = enclosing.map((el) => doc.textBetween(el.markers[0].from, el.markers[0].to)).join('')
  const close = enclosing
    .slice()
    .reverse()
    .map((el) => doc.textBetween(el.markers[1].from, el.markers[1].to))
    .join('')
  return { at, close, open }
}

/**
 * 拆行：可选续前缀 + 行内标记拆分。非空选区先删除（此时不做行内拆分）。
 * 光标落在新行内容里与原光标相对应的位置。
 */
function splitLine(state: EditorState, prefix: string): Transaction {
  const { empty, from } = state.selection
  let tr = state.tr
  let at: number
  let close = ''
  let open = ''
  let caretShift = 0
  if (empty) {
    const r = inlineSplitAt(state, state.selection.$from.before(), from)
    at = r.at
    close = r.close
    open = r.open
    caretShift = Math.max(0, from - at)
  } else {
    tr = tr.deleteSelection()
    at = tr.selection.from
  }
  if (close) tr = tr.insertText(close, at)
  at += close.length
  tr = tr.split(at)
  const lineStart = at + 2
  if (prefix || open) tr = tr.insertText(prefix + open, lineStart)
  tr = tr.setSelection(
    TextSelection.create(tr.doc, lineStart + prefix.length + open.length + caretShift),
  )
  return tr.scrollIntoView()
}

/** 行内拆分是否会改变默认 split 的结果（普通段落只有这时才需要接管 Enter） */
function needsInlineSplit(state: EditorState): boolean {
  const { empty, from, $from } = state.selection
  if (!empty) return false
  const r = inlineSplitAt(state, $from.before(), from)
  return r.at !== from || r.close !== ''
}

/**
 * Enter：列表/引用续行；标题特殊处理；行内标记中间回车两侧都补标记。
 *
 * 标题：
 *   - 行首（内容起点、行非空）：上方插空行，`# Title` 整行保持标题
 *   - 行中/行末：split，下一行是普通段落（不继承 `#`）
 *   - 空标题再回车：退出标题格式
 *
 * 列表/引用：
 *   - 空前缀行再回车：嵌套项先退一级缩进，顶层项退出块格式
 *   - 行首（内容起点、行非空）：上方插入空项，当前项（含勾选状态）原样下移
 *   - 其余：续前缀
 */
export const continueListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!$from.parent.isTextblock || $from.depth !== 1) return false

  const blockPos = $from.before()
  const line = lineInfoAt(state, blockPos)
  if (!line) return false
  const text = $from.parent.textContent

  const prefixLen = (line as { prefixLen?: number }).prefixLen ?? 0
  const contentEmpty = text.slice(prefixLen).trim() === ''
  const atContentStart = empty && $from.parentOffset === prefixLen

  // ——— 标题：不续 `#`，只做行首插空 / 行中拆段 / 空行退出 ———
  if (line.t === 'heading') {
    if (empty && contentEmpty) {
      if (dispatch) {
        const start = blockPos + 1
        dispatch(state.tr.delete(start, start + text.length).scrollIntoView())
      }
      return true
    }
    // 行首回车：上方插入空段落，当前行保持 `# Title`
    if (atContentStart) {
      if (dispatch) {
        const tr = state.tr.insert(blockPos, schema.nodes.block.create())
        tr.setSelection(TextSelection.create(tr.doc, blockPos + 1))
        dispatch(tr.scrollIntoView())
      }
      return true
    }
    // 行中/行末：split，下一行不带标题前缀
    if (dispatch) dispatch(splitLine(state, ''))
    return true
  }

  if (line.t === 'para') {
    if (!needsInlineSplit(state)) return false
    if (dispatch) dispatch(splitLine(state, ''))
    return true
  }

  const prefix = continuationPrefix(line, text)
  if (prefix === null) return false

  if (empty && contentEmpty) {
    const indent = (line as { indent?: number }).indent ?? 0
    if (indent > 0) return dedentListItem(state, dispatch)
    // 前缀空行再回车 → 清空前缀，退出块格式
    if (dispatch) {
      const start = blockPos + 1
      dispatch(state.tr.delete(start, start + text.length).scrollIntoView())
    }
    return true
  }

  if (atContentStart) {
    const above = freshPrefix(line, text)
    if (above !== null) {
      if (dispatch) {
        const node = schema.nodes.block.create(null, schema.text(above))
        const tr = state.tr.insert(blockPos, node)
        tr.setSelection(TextSelection.create(tr.doc, blockPos + node.nodeSize + 1 + prefixLen))
        dispatch(tr.scrollIntoView())
      }
      return true
    }
  }

  if (dispatch) dispatch(splitLine(state, prefix))
  return true
}

/**
 * Shift-Enter：拆行但不续前缀（列表/引用/标题里换到一行普通文本），
 * 行内标记拆分规则同 Enter。代码块与表格交给默认行为。
 */
export const splitWithoutPrefix: Command = (state, dispatch) => {
  const { $from } = state.selection
  if (!$from.parent.isTextblock || $from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line) return false
  if (!['para', 'heading', 'quote', 'bullet', 'ordered', 'todo', 'blank'].includes(line.t)) {
    return false
  }
  if (dispatch) dispatch(splitLine(state, ''))
  return true
}

const FENCE_OPENER_WITH_INFO = /^ {0,3}(`{3,}|~{3,})\S/

/**
 * 围栏开行末尾回车：若这个围栏没有闭合（或会错把后面另一个代码块的闭合行
 * 当成自己的），自动补上闭合行 —— 否则下面整篇文档都会变成代码块。
 */
export const closeFenceOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  const st = concealKey.getState(state)
  if (!st) return false
  const idx = st.blocks.findIndex((b) => b.pos === $from.before())
  if (idx < 0) return false
  const block = st.blocks[idx]!
  const line = block.line
  if (line.t !== 'fenceOpen' && line.t !== 'diagramOpen') return false
  if ($from.parentOffset !== block.text.length) return false

  const bodyT = line.t === 'fenceOpen' ? 'code' : 'diagramLine'
  const closeT = line.t === 'fenceOpen' ? 'fenceClose' : 'diagramClose'
  let j = idx + 1
  let stealsOtherFence = false
  while (j < st.blocks.length && st.blocks[j]!.line.t === bodyT) {
    if (FENCE_OPENER_WITH_INFO.test(st.blocks[j]!.text)) stealsOtherFence = true
    j++
  }
  const closed = j < st.blocks.length && st.blocks[j]!.line.t === closeT
  if (closed && !stealsOtherFence) return false

  if (dispatch) {
    const fence = block.text.slice(0, line.tickStart + line.tickLen)
    const after = block.pos + block.size
    const tr = state.tr.insert(after, [
      schema.nodes.block.create(),
      schema.nodes.block.create(null, schema.text(fence)),
    ])
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/**
 * 用一对标记符包裹/解包 selection（Mod-b / Mod-i / Mod-e / Mod-Shift-x）。
 * 空 selection 时插入一对并把光标放中间。
 */
export function toggleInline(marker: string): Command {
  return (state, dispatch) => {
    const { $from, $to, from, to, empty } = state.selection
    if (!$from.sameParent($to) || $from.depth !== 1) return false
    const len = marker.length

    if (empty) {
      if (dispatch) {
        let tr = state.tr.insertText(marker + marker, from)
        tr = tr.setSelection(TextSelection.create(tr.doc, from + len))
        dispatch(tr)
      }
      return true
    }

    const doc = state.doc
    const selText = doc.textBetween(from, to)
    const blockStart = $from.start()
    const blockEnd = $to.end()

    let tr: Transaction
    if (selText.startsWith(marker) && selText.endsWith(marker) && selText.length >= 2 * len) {
      // 选区自带标记 → 解包
      const inner = selText.slice(len, selText.length - len)
      tr = state.tr.insertText(inner, from, to)
      tr = tr.setSelection(TextSelection.create(tr.doc, from, from + inner.length))
    } else if (
      from - blockStart >= len &&
      blockEnd - to >= len &&
      doc.textBetween(from - len, from) === marker &&
      doc.textBetween(to, to + len) === marker
    ) {
      // 选区紧邻标记 → 删除外侧标记
      tr = state.tr.delete(to, to + len).delete(from - len, from)
      tr = tr.setSelection(TextSelection.create(tr.doc, from - len, to - len))
    } else {
      // 包裹
      tr = state.tr.insertText(marker + selText + marker, from, to)
      tr = tr.setSelection(TextSelection.create(tr.doc, from + len, from + len + selText.length))
    }
    if (dispatch) dispatch(tr)
    return true
  }
}

/** 有隐藏前缀的行：内容起点绝对位置；无前缀则 null（交给默认行为） */
function contentStartPos(state: EditorState, blockPos: number): number | null {
  const line = lineInfoAt(state, blockPos)
  if (!line) return null
  const prefixLen = (line as { prefixLen?: number }).prefixLen
  if (typeof prefixLen !== 'number' || prefixLen <= 0) return null
  return blockPos + 1 + prefixLen
}

/**
 * Mod-Backspace（macOS「删到行首」）：只清内容，保留 checkbox / 列表 / 引用 / 标题前缀。
 * 已在内容起点时吞掉按键，避免把前缀一并删掉。
 * 普通段落也自己处理 —— contenteditable 里浏览器的原生「删到行首」并不可靠。
 */
export const deleteToContentStart: Command = (state, dispatch) => {
  const { $from, empty, from, to } = state.selection
  if ($from.depth !== 1 || !$from.sameParent(state.selection.$to)) return false
  // 无隐藏前缀的行（普通段落）：整块都是内容，行首即块首。
  const contentStart = contentStartPos(state, $from.before()) ?? $from.start()

  if (!empty) {
    const a = Math.max(Math.min(from, to), contentStart)
    const b = Math.max(from, to)
    if (b <= contentStart) return true
    if (dispatch) dispatch(state.tr.delete(a, b).scrollIntoView())
    return true
  }

  if (from <= contentStart) return true
  if (dispatch) dispatch(state.tr.delete(contentStart, from).scrollIntoView())
  return true
}

/**
 * Mod-Delete：删到行尾，同样不碰隐藏前缀（前缀在光标左侧，天然不受影响）。
 */
export const deleteToContentEnd: Command = (state, dispatch) => {
  const { $from, empty, from, to } = state.selection
  if ($from.depth !== 1 || !$from.sameParent(state.selection.$to)) return false
  const end = $from.end()
  if (!empty) {
    if (dispatch) dispatch(state.tr.delete(Math.min(from, to), Math.max(from, to)).scrollIntoView())
    return true
  }
  if (from >= end) return true
  if (dispatch) dispatch(state.tr.delete(from, end).scrollIntoView())
  return true
}

/**
 * Backspace 在块前缀的内容起点：删除整个前缀（= 关闭该行格式，
 * 与 Bear 一致 —— 列表/引用/标题/待办退格一次变回普通段落）。
 *   - 嵌套列表项先退一级缩进，不把缩进空格露成正文
 *   - 有序列表序号可见但同样整体去掉
 *   - 标题上方是空行时先吃掉空行（标题保持）；否则去掉标题格式，
 *     可用 Mod-1…6 恢复
 *   - hr 行：整行删除（分隔线是一个对象，退格整体移除）
 */
export const backspaceBlockFormat: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  const blockPos = $from.before()

  const st = concealKey.getState(state)
  const line = lineInfoAt(state, blockPos)
  if (st && !st.source && line?.t === 'ordered') {
    if ($from.parentOffset !== line.prefixLen) return false
    if (line.indent > 0) return dedentListItem(state, dispatch)
    if (dispatch) dispatch(state.tr.delete(blockPos + 1, blockPos + 1 + line.prefixLen))
    return true
  }

  const hit = permanentPrefixAt(state, blockPos)
  if (!hit) return false
  const m = hit.el.markers[0]

  if (hit.el.kind === 'hr' || hit.el.kind === 'tableSep') {
    if (dispatch) {
      dispatch(state.tr.delete(hit.block.pos + 1, hit.block.pos + 1 + hit.block.text.length))
    }
    return true
  }
  // 表格行：管道不是可退格去掉的"前缀"，交给默认删除
  if (hit.el.kind === 'tableHeader' || hit.el.kind === 'tableRow') return false
  if ($from.pos !== m.to) return false

  if ((hit.el.attrs?.indent ?? 0) > 0) return dedentListItem(state, dispatch)

  if (hit.el.kind === 'heading' && hit.block.pos > 0) {
    const prev = state.doc.resolve(hit.block.pos).nodeBefore
    if (prev && prev.content.size === 0) {
      if (dispatch) dispatch(state.tr.delete(hit.block.pos - prev.nodeSize, hit.block.pos))
      return true
    }
  }

  if (dispatch) dispatch(state.tr.delete(m.from, m.to))
  return true
}

/**
 * Delete 在行尾：下一行带块前缀（列表/引用/标题/待办/有序）时，合并进来的只有内容，
 * 前缀随之丢弃 —— 否则隐藏的 `- ` 会变成本行里可见的正文。下一行是 hr 则整行删除。
 */
export const deleteForwardStripPrefix: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  const st = concealKey.getState(state)
  if (!st || st.source) return false
  const nextPos = $from.after()
  if (nextPos >= state.doc.content.size) return false
  const next = st.blocks.find((b) => b.pos === nextPos)
  if (!next) return false
  if (next.line.t === 'hr') {
    if (dispatch) dispatch(state.tr.delete(nextPos, nextPos + next.size))
    return true
  }
  if (!['heading', 'quote', 'bullet', 'ordered', 'todo'].includes(next.line.t)) return false
  const prefixLen = (next.line as { prefixLen: number }).prefixLen
  if (dispatch) dispatch(state.tr.delete($from.pos, nextPos + 1 + prefixLen))
  return true
}

const TABLE_LINE_TYPES = new Set(['tableHeader', 'tableSep', 'tableRow'])

/**
 * 紧贴表格的行首 Backspace / 行尾 Delete：不能把正文并进管道源码。
 * 空行直接删掉，否则光标移到表格边上（conceal 插件会把它换成单元格编辑框）。
 */
function joinTowardTable(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection
    if (!empty || $from.depth !== 1) return false
    const atEdge = dir < 0 ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size
    if (!atEdge) return false
    const st = concealKey.getState(state)
    if (!st || st.source) return false
    const blockPos = $from.before()
    const i = st.blocks.findIndex((b) => b.pos === blockPos)
    const neighbor = st.blocks[i + dir]
    if (i < 0 || !neighbor || !TABLE_LINE_TYPES.has(neighbor.line.t)) return false
    if (!dispatch) return true
    let tr = state.tr
    const size = $from.parent.nodeSize
    if ($from.parent.content.size === 0) tr = tr.delete(blockPos, blockPos + size)
    const target =
      dir < 0 ? neighbor.pos + 1 + neighbor.text.length : tr.mapping.map(neighbor.pos) + 1
    dispatch(tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView())
    return true
  }
}

export const backspaceIntoTable: Command = joinTowardTable(-1)
export const deleteIntoTable: Command = joinTowardTable(1)

const HEADING_PREFIX_RE = /^#{1,6} /
const BLOCK_PREFIX_TYPES = new Set(['quote', 'bullet', 'ordered', 'todo'])

/**
 * Mod-1…6：把当前行设为对应级别标题；已是同级标题则还原为普通段落。
 * 列表/引用行会先去掉原前缀。
 */
export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    if ($from.depth !== 1 || !$from.sameParent($to)) return false
    const blockPos = $from.before()
    const line = lineInfoAt(state, blockPos)
    if (!line) return false
    if (!['para', 'blank', 'heading', ...BLOCK_PREFIX_TYPES].includes(line.t)) return false
    const text = $from.parent.textContent
    let strip = 0
    if (line.t === 'heading') strip = text.match(HEADING_PREFIX_RE)?.[0].length ?? 0
    else if (BLOCK_PREFIX_TYPES.has(line.t)) strip = (line as { prefixLen: number }).prefixLen
    const same = line.t === 'heading' && line.level === level
    const insert = same ? '' : `${'#'.repeat(level)} `
    if (dispatch) {
      const start = blockPos + 1
      dispatch(state.tr.insertText(insert, start, start + strip).scrollIntoView())
    }
    return true
  }
}

/**
 * ArrowLeft 在 permanent 前缀的内容起点：跳到上一行行尾（隐藏前缀不可进入）。
 */
export const arrowLeftSkipPrefix: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  const hit = permanentPrefixAt(state, $from.before())
  if (!hit) return false
  const m = hit.el.markers[0]
  if ($from.pos !== m.to) return false
  if (hit.block.pos === 0) return true // 首行：原地不动，不进隐藏区
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, hit.block.pos - 1)))
  }
  return true
}

/**
 * Shift-ArrowLeft 在隐藏前缀的内容起点：选区 head 直接跨到上一行行尾。
 * 否则浏览器把 head 放进前缀、caret guard 又推回来，选区永远扩不过去。
 */
export const shiftArrowLeftSkipPrefix: Command = (state, dispatch) => {
  const sel = state.selection
  if (!(sel instanceof TextSelection)) return false
  const $head = sel.$head
  if ($head.depth !== 1) return false
  const hit = permanentPrefixAt(state, $head.before())
  if (!hit) return false
  if ($head.pos !== hit.el.markers[0].to) return false
  if (hit.block.pos === 0) return true
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.anchor, hit.block.pos - 1)))
  }
  return true
}

/**
 * ArrowUp 落在块首时：若上一行带隐藏前缀（标题/列表/引用…），把光标放到上一行
 * 行尾，而不是内容起点。
 *
 * 典型陷阱：标题行末 Enter → 下一空行 → ArrowUp。浏览器按 x=0 映射，光标会停在
 * 隐藏 `# ` 之后；再按 Backspace 就会误触去格式。
 */
export const arrowUpToPrevContentEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  if ($from.parentOffset !== 0) return false
  const blockPos = $from.before()
  if (blockPos === 0) return false
  const prev = state.doc.resolve(blockPos).nodeBefore
  if (!prev?.isTextblock) return false
  const prevPos = blockPos - prev.nodeSize
  const line = lineInfoAt(state, prevPos)
  if (!line || !('prefixLen' in line) || !line.prefixLen) return false
  if (concealKey.getState(state)?.source) return false
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, blockPos - 1)))
  }
  return true
}

const INDENT = '  '

export const indentListItem: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line || !['bullet', 'ordered', 'todo'].includes(line.t)) return false
  if (!dispatch) return true

  const start = $from.start()
  let tr = state.tr.insertText(INDENT, start)
  // Nested ordered run should start at 1; normalizePlugin then fixes siblings.
  if (line.t === 'ordered' && line.num !== 1) {
    const numFrom = start + INDENT.length + line.indent
    tr = tr.insertText('1', numFrom, numFrom + line.numLen)
  }
  dispatch(tr)
  return true
}

export const dedentListItem: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line || !['bullet', 'ordered', 'todo'].includes(line.t)) return false
  const text = $from.parent.textContent
  const remove = Math.min(text.length - text.trimStart().length, INDENT.length)
  if (remove === 0) return false
  if (dispatch) dispatch(state.tr.delete($from.start(), $from.start() + remove))
  return true
}

const CODE_LINE_TYPES = new Set(['code', 'diagramLine', 'fenceOpen', 'fenceClose', 'diagramOpen', 'diagramClose'])

/** 选区覆盖的所有块（按文档顺序） */
function blocksInSelection(state: EditorState): { pos: number; text: string }[] {
  const { from, to } = state.selection
  const out: { pos: number; text: string }[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    out.push({ pos, text: node.textContent })
    return false
  })
  return out
}

/**
 * Tab（非列表、非表格行）：代码块内插入两个空格，多行选区整体缩进；
 * 其余文本插入制表符。都吞掉按键，避免焦点跳出编辑器。
 */
export const insertTab: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if ($from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line) return false
  if (line.t === 'tableHeader' || line.t === 'tableRow' || line.t === 'tableSep') return true
  if (CODE_LINE_TYPES.has(line.t)) {
    if (!dispatch) return true
    if (empty) {
      dispatch(state.tr.insertText(INDENT).scrollIntoView())
      return true
    }
    let tr = state.tr
    for (const b of blocksInSelection(state).reverse()) tr = tr.insertText(INDENT, b.pos + 1)
    dispatch(tr.scrollIntoView())
    return true
  }
  if (dispatch) dispatch(state.tr.insertText('\t').scrollIntoView())
  return true
}

/** Shift-Tab（非列表、非表格行）：代码块内每行去掉至多两个前导空格；其余只吞掉按键 */
export const removeTab: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line) return false
  if (!CODE_LINE_TYPES.has(line.t)) return true
  if (!dispatch) return true
  let tr = state.tr
  for (const b of blocksInSelection(state).reverse()) {
    const n = Math.min(b.text.length - b.text.trimStart().length, INDENT.length)
    if (n > 0) tr = tr.delete(b.pos + 1, b.pos + 1 + n)
  }
  if (tr.docChanged) dispatch(tr.scrollIntoView())
  return true
}

/**
 * 空标题是 `# ` / `## ` …（带尾部空格）。此时再敲 `#` 应升为更高一级标题，
 * 而不是把 `#` 写进标题正文。
 */
export function headingInputPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '#' || from !== to) return false
        const $from = view.state.doc.resolve(from)
        if ($from.depth !== 1) return false
        const line = $from.parent.textContent
        const m = line.match(/^(#{1,6}) $/)
        if (!m || m[1].length >= 6) return false
        if (from !== $from.start() + m[0].length) return false
        const hashInsert = $from.start() + m[1].length
        let tr = view.state.tr.insertText('#', hashInsert)
        tr = tr.setSelection(TextSelection.create(tr.doc, hashInsert + 2))
        view.dispatch(tr)
        return true
      },
    },
  })
}

export function markdownKeymap(): Plugin {
  return keymap({
    // 输入法用 Enter 上屏时，绝不能顺带拆段——否则标题会在确认拼音时被劈成普通文本。
    // 只认 PM 的 view.composing：conceal 的 composing 只是渲染冻结标志，
    // 一旦漏掉解冻就会把回车永久吞掉（表现为「标题后换不了行」）。
    Enter: (state, dispatch, view) => {
      if (view?.composing) return true
      return (
        continueTableRow(state, dispatch, view) ||
        closeFenceOnEnter(state, dispatch, view) ||
        continueListItem(state, dispatch, view)
      )
    },
    'Shift-Enter': (state, dispatch, view) => {
      if (view?.composing) return true
      return splitWithoutPrefix(state, dispatch, view)
    },
    Backspace: (state, dispatch, view) =>
      backspaceBlockFormat(state, dispatch, view) || backspaceIntoTable(state, dispatch, view),
    Delete: (state, dispatch, view) =>
      deleteIntoTable(state, dispatch, view) || deleteForwardStripPrefix(state, dispatch, view),
    ArrowLeft: arrowLeftSkipPrefix,
    'Shift-ArrowLeft': shiftArrowLeftSkipPrefix,
    ArrowUp: arrowUpToPrevContentEnd,
    'Mod-Backspace': deleteToContentStart,
    'Mod-Delete': deleteToContentEnd,
    'Mod-b': toggleInline('**'),
    'Mod-i': toggleInline('*'),
    'Mod-e': toggleInline('`'),
    'Mod-Shift-x': toggleInline('~~'),
    'Mod-Shift-h': toggleInline('=='),
    ...headingKeys,
    Tab: (state, dispatch, view) =>
      goToNextTableCell(state, dispatch, view) ||
      indentListItem(state, dispatch, view) ||
      insertTab(state, dispatch, view),
    'Shift-Tab': (state, dispatch, view) =>
      goToPrevTableCell(state, dispatch, view) ||
      dedentListItem(state, dispatch, view) ||
      removeTab(state, dispatch, view),
  })
}

/** Mod-1…6（浏览器常占用 Cmd+数字切标签页，另绑 Mod-Alt-1…6） */
const headingKeys: Record<string, Command> = {}
for (let level = 1; level <= 6; level++) {
  headingKeys[`Mod-${level}`] = setHeading(level)
  headingKeys[`Mod-Alt-${level}`] = setHeading(level)
}
