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

## 源码模式

```ts
editor.setSourceMode(true)   // 或 createEditor({ sourceMode: true })
editor.sourceMode            // 当前状态
```

源码模式关闭全部 conceal / 渲染（mount 上加 `hm-source` class，等宽字体），块前缀可直接编辑；
列表续行等编辑行为保留。切换不影响文档内容与撤销历史。

## 剪贴板

- 复制出去的纯文本就是源码行，按单个 `\n` 拼接；粘贴纯文本按 `\n` 精确切行（空行保留）
- 外部 HTML（网页、文档编辑器）转换为 Markdown 后插入：标题、列表（含嵌套/待办）、引用、代码块、表格、粗斜体、链接、图片
- 从 VS Code 等代码编辑器复制、或粘贴到代码块里时，以纯文本为准
- 选中文字后粘贴网址 → `[文字](url)`
- 单独使用：`clipboardPlugin()`、`htmlToMarkdown(html)`、`markdownToSlice(md)`

## 导出为 CommonMark

编辑器按"一行一块"渲染：回车只写入一个 `\n`。按 CommonMark 规则，相邻文本行会合并成同一段，
`文字\n---` 会变成 setext 标题，列表后紧跟的文本会成为懒续行。导出到其他渲染器前可以转换：

```ts
import { toCommonMark } from '@21stware/handymd'

toCommonMark(editor.getMarkdown())                            // 相邻文本行 → 硬换行（行尾两空格）
toCommonMark(editor.getMarkdown(), { lineBreak: 'paragraph' }) // 相邻文本行 → 空行分段
```

只在行与行之间补空白，不改动行内容；代码块原样保留。

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
| `⌘/Ctrl+1…6`（或 `⌘/Ctrl+Alt+1…6`） | 设为对应级别标题；同级再按一次还原为段落 |
| `Enter` | 列表/引用续行；空前缀行退出（嵌套项先退一级）；**行首**在上方插入空行/空项，当前行原样保留；**标题行中/行末**拆出普通段落（不续 `#`）；在 `**粗体**` 等标记中间回车两段都补齐标记；未闭合的 ```` ``` ```` 开行末尾回车自动补闭合行 |
| `Shift+Enter` | 换行但不续列表/引用前缀 |
| `Backspace`（内容起点） | 去掉该行块级格式（含标题、有序列表）；嵌套列表先退一级；标题上方是空行时先删空行 |
| `Delete`（行尾） | 合并下一行时丢弃它的块前缀；下一行是分隔线则整行删除 |
| `ArrowLeft` / `Shift+ArrowLeft`（内容起点） | 光标 / 选区跨到上一行行尾（不进隐藏前缀） |
| `Tab` / `Shift+Tab` | 列表缩进 / 反缩进；代码块内缩进两格（支持多行）；其它文本插入制表符 |
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
| `![alt](url)` | 图片（始终显示预览，点击选中；见下方「图片」） |
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
| GFM 管道表格 | 见下方「表格」——编程式插入，单元格内编辑 |

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

整张表渲染为一个网格，**编辑直接在单元格内进行**：点击某一格（或用方向键从上下行
移进表格）后，这一格变成编辑框并展示它自己的源码（如 `**bold**`），其余格子保持渲染态；
每次输入立即写回该格对应的管道源码。单元格里的链接单击打开，Cmd/Ctrl+点击进入编辑。

单元格编辑框内的快捷键：

| 快捷键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 下一格 / 上一格；最后一格按 `Tab` 追加新行 |
| `Enter` | 下一行同列；最后一行按 `Enter` 追加新行 |
| `Shift+Enter` / `Mod+Enter` | 在当前行下方插入新行 |
| `↑` / `↓` | 上 / 下一行同列；越过首行 / 末行离开表格 |
| `←` / `→` | 在格首 / 格尾时跳到相邻格 |
| `Esc` | 离开表格（光标到表格下一行） |
| `Backspace` | 空行首格：删除该行；整表为空时删除表格 |
| `Mod+B` / `Mod+I` / `Mod+E` | 给选中文字加 / 去 `**` / `*` / `` ` `` |
| `Mod+Z` / `Mod+Shift+Z` | 撤销 / 重做 |
| `Alt+↑` / `Alt+↓` | 把当前行上移 / 下移 |

**行列操作**：鼠标悬停时，表格左侧与上沿出现行 / 列把手，右侧与下方出现「+」添加条。

- 点击把手 = 选中整行 / 整列，并弹出菜单：上方 / 下方（左侧 / 右侧）插入、上移 / 下移（左移 / 右移）、
  列对齐（居左 / 居中 / 居右）、删除
- 拖动把手 = 排序，蓝线标出落点；列拖到滚动区边缘会自动横向滚动
- 选中状态下：`Backspace` / `Delete` 删除，`Alt+方向键` 移动，方向键换选相邻行列，`Enter` / `Esc` 回到单元格编辑
- 删掉表头行时下一行升为表头；删到最后一行 / 一列即删除整张表。每次结构操作单独一步撤销

列很多时表格不会把每格挤成一两个字，而是保持最小列宽并在表格内横向滚动。

输入的 `|` 会自动转义为 `\|`，换行折为空格。源码仍是标准 GFM（`getMarkdown()` 无损）。
单元格编辑框里的按键不经过 ProseMirror keymap（`Mod-s` 保存除外），自定义快捷键插件对其不生效。

## 图片

```ts
editor.insertImage({ src: 'https://example.com/a.png', alt: '示意图' })
await editor.insertImageFiles(fileInput.files!)   // 宿主自己的文件选择器
```

粘贴 / 拖放图片文件同样会插入。文件先以本地 blob 预览占位（立即可见），随后经
`uploadImage` 上传并把占位地址替换为最终 URL；上传失败则移除占位。

Markdown 里应当只放图片的**地址**，而不是图片本身。未提供 `uploadImage` 时图片会以 `data:`
URL 内联进源码 —— 一张截图就是几百 KB 的 base64，源码不可读、diff 与同步都很痛苦，只适合演示。

```ts
// 有后端：上传后写回 URL
createEditor({
  mount,
  uploadImage: async (file) => {
    const res = await fetch('/upload', { method: 'POST', body: file })
    return (await res.json()).url
  },
})

// 没有后端（PWA / 本地草稿）：存进 IndexedDB，源码里只写 `assets/shot-3fa2c1.png`
const images = createLocalImageStore()
createEditor({ mount, uploadImage: images.upload, resolveImage: images.resolve })

// 地址需要换算才能加载（相对当前文件 / 私有桶签名）
createEditor({
  mount,
  resolveImage: (src) => (/^[a-z]+:|^\//i.test(src) ? src : new URL(src, docBaseUrl).href),
})
```

`resolveImage` 只影响渲染，`getMarkdown()` 里仍是原地址。

图片总是独立成行插入（当前行为空时就地替换），光标落到图片下一行。

图片是一个整体，点击不会把它变回 `![alt](src)` 源码：

| 操作 | 行为 |
|---|---|
| 单击图片 | 选中（描边高亮） |
| 选中后 `Backspace` / `Delete` / 输入 | 删除 / 替换整张图 |
| 图片后 `Backspace`、图片前 `Delete` | 先选中，再按一次删除 |
| `←` / `→` | 把图片当作一个字符跨过（经过时先选中） |
| 选中后 `Enter` | 在图片后开新行 |

要修改 alt 或地址，切到源码模式编辑。

## 导出 PDF

```ts
await editor.exportToPDF({ title: '周报' })
```

以渲染态打开浏览器打印对话框，选「存储为 PDF」即可：标记符隐藏、代码高亮、mermaid 图表、
表格、图片都与屏幕一致；光标所在元素也按渲染态导出，编辑器状态不受影响。可用 `css` 追加
`@page` 等打印样式，桌面壳可用 `print` 选项换成原生打印接口。详见 API 参考「导出 PDF」。

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
