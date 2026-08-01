import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { TextSelection } from 'prosemirror-state'
import { keymap } from 'prosemirror-keymap'
import type { Plugin } from 'prosemirror-state'
import { concealKey } from './conceal/plugin'
import { permanentPrefixAt } from './caret'
import type { LineInfo } from './parse/blocks'

/**
 * 源码模型下大部分 input rule 都是多余的 —— 输入 `## ` 本身就会被解析成标题。
 * 这里只保留真正需要"替用户打字/跳光标"的场景：列表续行、前缀退出、
 * 行内标记切换（Mod-b 等价于替你输入两对 `**`）、列表缩进。
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
    default:
      return null
  }
}

/**
 * Enter：列表/引用续行。空前缀行（只剩前缀没有内容）再回车 = 退出列表，
 * 与 Bear 一致。
 */
export const continueListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!$from.parent.isTextblock || $from.depth !== 1) return false

  const blockPos = $from.before()
  const line = lineInfoAt(state, blockPos)
  if (!line) return false
  const text = $from.parent.textContent
  const prefix = continuationPrefix(line, text)
  if (prefix === null) return false

  const prefixLen = (line as { prefixLen?: number }).prefixLen ?? 0
  const contentEmpty = text.slice(prefixLen).trim() === ''

  if (empty && contentEmpty) {
    // 前缀空行再回车 → 清空前缀，退出列表
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

  if (hit.el.kind === 'hr') {
    if (dispatch) {
      dispatch(state.tr.delete(hit.block.pos + 1, hit.block.pos + 1 + hit.block.text.length))
    }
    return true
  }
  if ($from.pos !== m.to) return false
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

const INDENT = '  '

export const indentListItem: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.depth !== 1) return false
  const line = lineInfoAt(state, $from.before())
  if (!line || !['bullet', 'ordered', 'todo'].includes(line.t)) return false
  if (dispatch) dispatch(state.tr.insertText(INDENT, $from.start()))
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

export function markdownKeymap(): Plugin {
  return keymap({
    Enter: continueListItem,
    Backspace: backspaceBlockFormat,
    ArrowLeft: arrowLeftSkipPrefix,
    'Mod-b': toggleInline('**'),
    'Mod-i': toggleInline('*'),
    'Mod-e': toggleInline('`'),
    'Mod-Shift-x': toggleInline('~~'),
    'Mod-Shift-h': toggleInline('=='),
    Tab: indentListItem,
    'Shift-Tab': dedentListItem,
  })
}
