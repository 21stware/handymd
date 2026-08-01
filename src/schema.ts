import { Schema } from 'prosemirror-model'

/**
 * 源码保真 schema：doc → block+，块内是含标记符的纯文本。
 *
 * 刻意不定义 strong/em 等 marks —— 语义只存在于 decoration 层。
 * 文档模型即 Markdown 源码本身（一个 block = 一行），因此：
 *   - 序列化零成本（textContent 按行拼接）
 *   - "元素解散"（Broken）零成本（只是 decoration 消失）
 *   - undo/redo、协同 patch、粘贴天然正确
 */
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    block: {
      content: 'text*',
      parseDOM: [
        { tag: 'p' },
        { tag: 'div' },
        { tag: 'li' },
        { tag: 'h1' },
        { tag: 'h2' },
        { tag: 'h3' },
        { tag: 'h4' },
        { tag: 'h5' },
        { tag: 'h6' },
        { tag: 'blockquote' },
        { tag: 'pre' },
      ],
      toDOM: () => ['div', { class: 'hm-block' }, 0],
    },
    text: {},
  },
})

export type HandySchema = typeof schema
