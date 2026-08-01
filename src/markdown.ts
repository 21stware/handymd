import type { Node as PMNode, Schema } from 'prosemirror-model'
import { schema as defaultSchema } from './schema'

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
