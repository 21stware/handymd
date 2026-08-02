/** Default landing playground document — showcases conceal/reveal + blocks + diagram. */
export const SAMPLE_MARKDOWN = `# 一张安静的纸

写作不该从选择格式开始。handymd 让 **Markdown 源码** 保持完整，只把不需要的标记暂时收起。

## 光标就是界面

把光标移到 **粗体** 或 *斜体* 附近，标记会自然显现。离开后，文字重新安静下来。

==重要的想法值得被看见==，但文档始终只是可以随处打开的纯文本。

> 工具应该理解你的注意力，而不是争夺它。

## 今天

- [x] 保存最初的想法
- [x] 让中文输入保持稳定
- [ ] 写完这一页

\`\`\`ts
const editor = createEditor({
  mount,
  content: '# Your words, your source.'
})
\`\`\`

## 从源码到纸面

\`\`\`mermaid
flowchart LR
    A[Markdown source] --> B[Selection-aware view]
    B --> C[Quiet writing]
\`\`\`

点击图表即可回到源码。文档没有第二份副本，也没有转换损耗。

---

把本地 \`.md\` 拖进这里，继续你的文字。
`
