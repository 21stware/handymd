import { createEditor, createShikiHighlighter } from '../src/index'
import '../src/style.css'
import './demo.css'

const SAMPLE = `# handymd 演示

## 行内元素

文档即 **Markdown 源码**，行内标记符按*光标位置*选择性隐藏。
把光标移进 \`**bold**\` 的紧邻外侧试试 —— 扩一格判定，退格进入不闪。
*Your writing starts with **Lettera**.* 嵌套强调两层都生效；==高亮笔== 用双等号。

## 块级元素（Bear 手感：一旦渲染，不回源码）

- [x] 输入 "- " 立即变 bullet，再补 "[ ] " 变 checkbox
- [ ] 单击 [链接](https://bear.app) 直接打开，Cmd+点击才进入编辑
- [ ] 行首 Backspace 一次去掉格式，变回普通段落

> 引用前缀永久隐藏；标题源码隐藏，聚焦时左侧出现层级图标。

1. 有序列表自动重编号
2. 回车自动续行前缀
3. 空前缀行再回车退出列表

\`\`\`ts
// shiki 语法高亮：代码内容仍是源码，高亮只是 decoration
export function conceal(doc: string, selection: [number, number]): boolean {
  return selection[0] > doc.length
}
\`\`\`

标签走 pill 样式：#demo/handymd

---

分隔线立即渲染，退格整体删除。保存是防抖自动的（看右上角状态），blur 与 ⌘S 会立即 flush。`

const KEY = 'handymd-demo'
const phaseEl = document.getElementById('phase')!
const saveEl = document.getElementById('save')!
const conflictEl = document.getElementById('conflict')!

const editor = createEditor({
  mount: document.getElementById('editor')!,
  load: async () => {
    await new Promise((r) => setTimeout(r, 200)) // 模拟网络
    return localStorage.getItem(KEY) ?? SAMPLE
  },
  save: async (md) => {
    await new Promise((r) => setTimeout(r, 250))
    localStorage.setItem(KEY, md)
  },
  autosave: { debounceMs: 800 },
  highlight: createShikiHighlighter({ theme: 'github-light' }),
  onPhaseChange: (phase) => {
    phaseEl.textContent = phase
    phaseEl.className = `pill pill-${phase}`
    conflictEl.hidden = phase !== 'conflicted'
  },
  onSaveStatusChange: (status) => {
    saveEl.textContent = status
    saveEl.className = `pill pill-${status}`
  },
})

document.getElementById('toggle-readonly')!.addEventListener('click', () => {
  editor.setReadOnly(!editor.readOnly)
})
document.getElementById('flush')!.addEventListener('click', () => {
  void editor.flush()
})
document.getElementById('simulate-remote')!.addEventListener('click', () => {
  editor.notifyRemote(editor.getMarkdown() + '\n\n> （远端追加的一行 @' + new Date().toLocaleTimeString() + '）')
})
document.getElementById('keep-local')!.addEventListener('click', () => editor.resolveConflict('local'))
document.getElementById('keep-remote')!.addEventListener('click', () => editor.resolveConflict('remote'))
