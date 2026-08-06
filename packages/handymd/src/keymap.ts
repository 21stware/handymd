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

/**
 * Enter：列表/引用续行；标题特殊处理。
 *
 * 标题：
 *   - 行首（内容起点、行非空）：上方插空行，`# Title` 整行保持标题
 *   - 行中/行末：split，下一行是普通段落（不继承 `#`）
 *   - 空标题再回车：退出标题格式
 *
 * 列表/引用：空前缀行再回车 = 退出块格式；否则续前缀。
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
    if (dispatch) {
      let tr = state.tr.deleteSelection()
      tr = tr.split(tr.selection.from)
      dispatch(tr.scrollIntoView())
    }
    return true
  }

  const prefix = continuationPrefix(line, text)
  if (prefix === null) return false

  if (empty && contentEmpty) {
    // 前缀空行再回车 → 清空前缀，退出块格式
    if (dispatch) {
      const start = blockPos + 1
      dispatch(state.tr.delete(start, start + text.length).scrollIntoView())
    }
    return true
  }

  if (dispatch) {
    let tr = state.tr.deleteSelection()
    tr = tr.split(tr.selection.from)
    tr = tr.insertText(prefix, tr.selection.from)
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
 * Backspace 在 permanent 前缀的内容起点：删除整个隐藏前缀（= 关闭该行格式，
 * 与 Bear 一致 —— 列表/引用/标题/待办退格一次变回普通段落）。
 * hr 行：整行删除（分隔线是一个对象，退格整体移除）。
 */
export const backspaceBlockFormat: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth !== 1) return false
  const hit = permanentPrefixAt(state, $from.before())
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

  // 标题：只有空标题才退格去格式。有内容时绝不能拆掉隐藏的 `# `——
  // Enter 后 ArrowUp 常落在内容起点，再按一次 Backspace 就会把标题变成普通文本，
  // 随后输入 `#中文`（没空格）还会被识别成标签，看起来像"再也变不回标题"。
  if (hit.el.kind === 'heading') {
    const prefixLen = m.to - (hit.block.pos + 1)
    if (hit.block.text.length > prefixLen) {
      if (hit.block.pos === 0) return true
      if (dispatch) {
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, hit.block.pos - 1)))
      }
      return true
    }
  }

  if (dispatch) dispatch(state.tr.delete(m.from, m.to))
  return true
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
      return continueTableRow(state, dispatch, view) || continueListItem(state, dispatch, view)
    },
    Backspace: backspaceBlockFormat,
    ArrowLeft: arrowLeftSkipPrefix,
    ArrowUp: arrowUpToPrevContentEnd,
    'Mod-Backspace': deleteToContentStart,
    'Mod-Delete': deleteToContentEnd,
    'Mod-b': toggleInline('**'),
    'Mod-i': toggleInline('*'),
    'Mod-e': toggleInline('`'),
    'Mod-Shift-x': toggleInline('~~'),
    'Mod-Shift-h': toggleInline('=='),
    Tab: (state, dispatch, view) =>
      goToNextTableCell(state, dispatch, view) || indentListItem(state, dispatch, view),
    'Shift-Tab': (state, dispatch, view) =>
      goToPrevTableCell(state, dispatch, view) || dedentListItem(state, dispatch, view),
  })
}
