import { createEditor } from '../src/index'
import '../src/style.css'
import './demo.css'

const SAMPLE = `# handymd 演示

文档即 **Markdown 源码**，标记符按*光标位置*选择性隐藏。
把光标移进 \`**bold**\` 的紧邻外侧试试 —— 扩一格判定，退格进入不闪。

- [x] Concealed ⇄ Revealed 由 selection 驱动
- [ ] 单击 [链接](https://bear.app) 直接打开，Cmd+点击才进入编辑
- [ ] 中文输入法期间冻结状态迁移，拼音不闪烁

> 引用块、标题这类块级元素以"光标所在块"为触发粒度。

1. 有序列表自动重编号
2. 回车自动续行前缀
3. 空前缀行再回车退出列表

\`\`\`js
// 代码块内部永远是源码，只有围栏行参与 conceal
const doc = 'is the markdown source'
\`\`\`

标签走 pill 样式：#demo/handymd

---

保存是防抖自动的（看右上角状态），blur 与 ⌘S 会立即 flush。`

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
