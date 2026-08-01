/** Default landing playground document — showcases conceal/reveal + blocks + diagram. */
export const SAMPLE_MARKDOWN = `# handymd

文档即 **Markdown 源码**。把光标移进 \`**粗体**\` 的紧邻外侧 —— 标记符按 selection 显现。

## 行内手感

*Your writing starts with **Lettera**.* 嵌套强调两层都生效；==高亮笔== 用双等号。

也可以写 [链接](https://bear.app)：单击打开，Cmd/Ctrl+点击才进入编辑。

## 块级（Bear：一旦渲染，不回源码）

- [x] 输入 \`- \` 立即变 bullet
- [ ] 补 \`[ ] \` 变 checkbox，单击切换
- [ ] 行首 Backspace 一次去掉格式

> 引用前缀永久隐藏；标题聚焦时左侧出现层级图标。

1. 有序列表自动重编号
2. 回车自动续行
3. 空前缀行再回车退出

\`\`\`ts
// 代码块内部永远是源码；高亮只是 decoration
export function conceal(doc: string, sel: [number, number]) {
  return sel[0] >= 0 && sel[1] <= doc.length
}
\`\`\`

## Diagram block（Live Render）

\`\`\`mermaid
flowchart LR
    A[源码 Markdown] -->|光标离开| B((渲染为图表))
    B -->|点击图表 / 光标进入| A
\`\`\`

↑ 光标离开 \`\`\`mermaid 围栏就渲染成图；点击图表（或键盘移入）立刻回到源码编辑。

标签走 pill：#demo/handymd

---

把本地 \`.md\` 拖进页面，或安装 PWA 后用系统「打开方式」。
`
