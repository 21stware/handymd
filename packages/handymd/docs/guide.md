# 使用指南

包名：`@21stware/handymd`

## 安装

```bash
bun add @21stware/handymd
# 可选：代码高亮
bun add shiki
# 可选：mermaid 图表渲染
bun add mermaid
```

```ts
import { createEditor } from '@21stware/handymd'
import '@21stware/handymd/style.css'
```

样式走独立入口 `@21stware/handymd/style.css`（或在打包器里 `import '@21stware/handymd/style.css'`）。

## 最小接入

```ts
const editor = createEditor({
  mount: document.querySelector('#editor')!,
  content: '# Hello\n\nStart writing.',
})
```

销毁时务必调用：

```ts
await editor.destroy() // 会先 flush 未保存内容
```

## 异步加载与自动保存

```ts
const editor = createEditor({
  mount,
  load: async () => {
    const res = await fetch(`/api/notes/${id}`)
    if (!res.ok) throw new Error('load failed')
    return res.text()
  },
  save: async (markdown) => {
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: markdown,
    })
    if (!res.ok) throw new Error('save failed')
  },
  autosave: {
    debounceMs: 800,       // 默认 800
    maxRetries: 5,         // 进入 offline 前的重试次数
    backoffBaseMs: 500,
    listenOnline: true,    // 监听 window online 自动恢复
  },
  onPhaseChange: (phase) => {
    // loading | ready | error | conflicted | destroyed
    statusEl.dataset.phase = phase
  },
  onSaveStatusChange: (status, error) => {
    // clean | dirty | saving | retrying | offline
    statusEl.dataset.save = status
    if (status === 'offline') toast.error(String(error))
  },
  onChange: (markdown) => {
    // 每次 docChanged（可用于字数统计等）
  },
})
```

加载失败时 `phase === 'error'`，调用 `editor.retry()` 重试。

手动保存：

```ts
await editor.flush()          // 立即保存（不等防抖）
// 或用户按 ⌘/Ctrl+S（内置绑定）
```

## 只读模式

```ts
editor.setReadOnly(true)
```

只读时：

- `filterTransaction` 拒绝一切写事务（`setMarkdown` 等带 programmatic meta 的除外）
- 全部元素强制 Concealed（标题图标也不出现）
- 链接点击打开、checkbox **展示**仍工作（勾选写入会被拒）

## 协同 / 远端版本冲突

当服务端推来新版本时：

```ts
editor.notifyRemote(remoteMarkdown)
```

- 本地 `saveStatus === 'clean'` → 静默采用远端
- 本地有未保存改动 → `phase` 变为 `conflicted`，编辑冻结

```ts
editor.resolveConflict('local')   // 保留本地并立即推送
editor.resolveConflict('remote')  // 采用远端，标记 clean
```

`editor.remoteConflict` 可读到远端文本，用于 UI 展示 diff。

## 代码高亮（shiki）

`shiki` 是**可选 peer 依赖**，动态 import，不装不进产物。

```ts
import { createEditor, createShikiHighlighter } from '@21stware/handymd'

createEditor({
  mount,
  content,
  highlight: createShikiHighlighter({
    theme: 'github-light',
    langs: ['typescript', 'python', 'bash'],
  }),
})
```

也可以接任意高亮器：

```ts
import type { CodeHighlighter } from '@21stware/handymd'

const highlight: CodeHighlighter = (code, lang) => {
  // 返回逐行 token：HighlightSpan[][]
  return code.split('\n').map((line) => [{ text: line, color: lang === 'ts' ? '#c7254e' : undefined }])
}

createEditor({ mount, content, highlight })
```

高亮永远只是 decoration，不改文档；结果按 `(lang, code)` 缓存。

## 图表渲染（mermaid）

`mermaid` 同样是**可选 peer 依赖**，动态 import，不装不进产物。

```ts
import { createEditor, createMermaidRenderer } from '@21stware/handymd'

createEditor({
  mount,
  content,
  diagram: createMermaidRenderer({ theme: 'neutral' }),
})
```

```` ```mermaid ```` 围栏是 **diagram block**，在结构化解析层就与普通代码块分开，并遵循块级 Live Render 语义（与 Bear 的"渲染物 ⇄ 源码"手感一致）：

- 光标离开围栏区域 → 整块源码隐藏，原地渲染为图表；
- 光标进入区域（键盘移入）或**点击图表** → 立即回到围栏源码，样式与普通代码块一致；
- 编辑期间永远是源码，渲染只在光标离开后发生，不会边打字边重渲染；
- 图表语法错误显示错误信息，空围栏显示占位，两者点击都能进入源码修复；
- 未配置 `diagram` 时，```` ```mermaid ```` 按普通代码块呈现。

也可以接任意渲染器（返回 SVG/HTML 字符串，可异步）：

```ts
import type { DiagramRenderer } from '@21stware/handymd'

const diagram: DiagramRenderer = async (code, lang) => `<svg>…</svg>`
createEditor({ mount, content, diagram })
```

## 主题 / CSS 变量

在 `.handymd` 上覆盖变量即可：

```css
.handymd {
  --hm-font: "Georgia", serif;
  --hm-mono: "JetBrains Mono", monospace;
  --hm-fg: #24292f;
  --hm-fg-dim: #6e7781;
  --hm-marker: #afb8c1;
  --hm-accent: #0969da;
  --hm-code-fg: #cf222e;
  --hm-code-bg: rgba(175, 184, 193, 0.2);
  --hm-codeblock-bg: #f6f8fa;
  --hm-quote-border: #d0d7de;
  --hm-quote-fg: #656d76;
  --hm-tag-bg: #ddf4ff;
  --hm-tag-fg: #0550ae;
  --hm-hr: #d0d7de;
  --hm-table-border: #d0d7de;
  --hm-table-header-bg: rgba(175, 184, 193, 0.2);
  --hm-selection: rgba(9, 105, 218, 0.2);
}
```

完整默认值见 `src/style.css`。编辑器会给 `mount` 元素加上 `handymd` class。

## 快捷键

| 快捷键 | 行为 |
|---|---|
| `⌘/Ctrl+B` | 切换 `**strong**` |
| `⌘/Ctrl+I` | 切换 `*em*` |
| `⌘/Ctrl+E` | 切换 `` `code` `` |
| `⌘/Ctrl+Shift+X` | 切换 `~~strike~~` |
| `⌘/Ctrl+Shift+H` | 切换 `==mark==` |
| `Enter` | 列表/引用续行；空前缀行退出；**标题行首**在上方插空行并保持标题；**标题行中/行末**拆出普通段落（不续 `#`） |
| `Backspace`（内容起点） | 去掉该行块级格式 |
| `ArrowLeft`（内容起点） | 跳到上一行行尾（不进隐藏前缀） |
| `Tab` / `Shift+Tab` | 列表缩进 / 反缩进 |
| `⌘/Ctrl+Z` / `⌘/Ctrl+Shift+Z` | 撤销 / 重做 |
| `⌘/Ctrl+S` | `flush()` |

## 支持的 Markdown

**行内（conceal ⇄ reveal）**

| 语法 | 说明 |
|---|---|
| `**bold**` / `__bold__` | 粗体 |
| `*em*` / `_em_` | 斜体（可嵌套 strong） |
| `` `code` `` | 行内代码 |
| `~~strike~~` | 删除线 |
| `==mark==` | 高亮笔 |
| `[text](url)` | 链接（Concealed 单击打开） |
| `![alt](url)` | 图片（Concealed 显示预览） |
| `#tag` / `#tag/nested` | Bear 风格标签（永远 pill） |

**块级（permanent，标题除外）**

| 语法 | 说明 |
|---|---|
| `#` … `######` | 标题；源码隐藏；聚焦时 gutter 层级图标 |
| `> quote` | 引用 |
| `- item` / `* item` | 无序列表 |
| `- [ ]` / `- [x]` | 待办 |
| `1. item` | 有序列表（自动重编号） |
| `---` / `***` | 分隔线 |
| \`\`\`lang | 代码块（可选 shiki） |
| \`\`\`mermaid | diagram block（可选 mermaid；光标离开渲染为图，点击回源码） |
| GFM 管道表格 | 见下方「表格」——请用编程式插入 |

## 表格

GFM 表格是多行结构（表头 + `| --- |` 分隔行 + 表体），不适合靠打字触发。
请用编程式 API 创建；已存在的管道表格源码会被识别并渲染。

```ts
// 推荐：HandyEditor 实例方法
editor.insertTable({ rows: 3, cols: 3 })
editor.insertTable({ rows: 4, cols: 2, headers: ['Name', 'Note'] })

// 或 ProseMirror Command（自建 EditorView 时）
import { insertTable, buildTableMarkdown } from '@21stware/handymd'
insertTable({ rows: 3, cols: 3 })(view.state, view.dispatch)
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `rows` | `3` | 总行数（含表头） |
| `cols` | `3` | 列数 |
| `withHeaderRow` | `true` | 是否生成表头行 |
| `headers` | — | 可选表头文案 |

快捷键（光标在表格内时）：

| 快捷键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 下一格 / 上一格 |
| `Enter` | 在下方插入空表体行 |

源码仍是标准 GFM（`getMarkdown()` 无损）。分隔行在视图中折叠，由表头加粗底边表达。

## 自建 EditorView（不用 createEditor）

所有插件可独立组装：

```ts
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history } from 'prosemirror-history'
import {
  markdownToDoc, docToMarkdown,
  concealPlugin, imePlugin, interactionsPlugin,
  caretGuardPlugin, markdownKeymap, normalizePlugin,
  highlightPlugin, createShikiHighlighter,
} from '@21stware/handymd'
import '@21stware/handymd/style.css'

const state = EditorState.create({
  doc: markdownToDoc('# hi'),
  plugins: [
    concealPlugin(),
    imePlugin(),
    interactionsPlugin(),
    caretGuardPlugin(),
    markdownKeymap(),
    normalizePlugin(),
    history(),
    highlightPlugin(await createShikiHighlighter()),
  ],
})
const view = new EditorView(mount, { state })
console.log(docToMarkdown(view.state.doc))
```

## 事件订阅

除构造选项回调外，也可用 `on`：

```ts
const off = editor.on('phase', (phase) => {})
editor.on('change', (md) => {})
editor.on('saveStatus', (status) => {})
off() // 取消订阅
```

## 常见问题

**中文输入法拼音时标记闪烁？**  
不应发生：composition 期间 decoration 只做位置映射。若仍闪烁，确认没有自行在 `dispatchTransaction` 里强制重建插件状态。

**为什么删掉一个 `*` 元素就没了？**  
文档本身是源码，"解散"只是 decoration 消失，这是零成本且符合预期的 Broken 出口。

**如何拿到纯文本？**  
`editor.getMarkdown()` 即源码；若只要可见文本，可自行去掉标记或遍历 `editor.view.state.doc`。

**SSR？**  
需要 DOM（`EditorView` / decorations）。在客户端 `onMount` 后再 `createEditor`。
