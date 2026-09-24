import type { Node as PMNode, Schema } from 'prosemirror-model'
import { schema as defaultSchema } from './schema'
import { classifyLines } from './parse/blocks'

/**
 * markdown 文本 ↔ ProseMirror doc。
 *
 * 因为文档模型就是源码（一行一个 block），这两个转换都是无损且 O(n) 的，
 * 不存在富文本 → markdown 的有损映射。
 */

export function markdownToDoc(markdown: string, schema: Schema = defaultSchema): PMNode {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks = lines.map((line) =>
    schema.nodes.block.create(null, line ? schema.text(line) : undefined),
  )
  return schema.nodes.doc.create(null, blocks)
}

export function docToMarkdown(doc: PMNode): string {
  const lines: string[] = []
  doc.forEach((block) => {
    lines.push(block.textContent)
  })
  return lines.join('\n')
}

export interface CommonMarkOptions {
  /**
   * 相邻两行普通文本在编辑器里是两行，CommonMark 里却是同一段的软换行（会被合并）。
   * `'hard'`（默认）：行尾补两个空格成为硬换行；`'paragraph'`：中间插空行拆成两段。
   */
  lineBreak?: 'hard' | 'paragraph'
}

const LIST_OR_QUOTE = new Set(['bullet', 'ordered', 'todo', 'quote'])
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/

/**
 * 编辑器源码 → 语义等价的 CommonMark / GFM。
 *
 * 编辑器按"一行一块"渲染，而 CommonMark 有段落续行、懒续行、setext 标题等跨行规则，
 * 同一份源码导出到其他渲染器会变样。这里只在行与行之间补空白，不改动行内容：
 *   - 普通文本行相邻：按 lineBreak 补硬换行或空行
 *   - 列表 / 引用后紧跟普通文本：插空行，避免成为懒续行
 *   - 普通文本后紧跟 `===` / `---` / 列表 / 表格：插空行，避免 setext 标题或无法打断段落
 * 代码块内部原样保留。
 */
export function toCommonMark(markdown: string, options: CommonMarkOptions = {}): string {
  const lineBreak = options.lineBreak ?? 'hard'
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const types = classifyLines(lines)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cur = types[i]!.t
    const prev = i > 0 ? types[i - 1]!.t : null
    if (prev === 'para') {
      if (cur === 'para' && SETEXT_UNDERLINE.test(line)) out.push('')
      else if (cur === 'para') {
        if (lineBreak === 'paragraph') out.push('')
        else if (!/( {2}|\\)$/.test(out[out.length - 1]!)) out[out.length - 1] += '  '
      } else if (cur === 'hr' || cur === 'tableHeader' || LIST_OR_QUOTE.has(cur)) {
        out.push('')
      }
    } else if (prev && LIST_OR_QUOTE.has(prev) && cur === 'para') {
      out.push('')
    }
    out.push(line)
  }
  return out.join('\n')
}
