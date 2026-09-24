# API 参考

包名：`@21stware/handymd`

```ts
import {
  createEditor, HandyEditor,
  createShikiHighlighter,
  // …见下方完整导出
} from '@21stware/handymd'
import '@21stware/handymd/style.css'
```

---

## `createEditor(options) → HandyEditor`

工厂函数，等价于 `new HandyEditor(options)`。

### `HandyEditorOptions`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mount` | `HTMLElement` | — | 挂载点（会被加上 `handymd` class） |
| `content` | `string` | `''` | 初始 markdown；与 `load` 同时给时 `load` 优先 |
| `load` | `() => string \| Promise<string>` | — | 异步拉取；失败 → `phase=error` |
| `save` | `(md: string) => unknown \| Promise<unknown>` | — | 提供后启用 L4 自动保存 |
| `autosave` | `Omit<AutosaveOptions, 'save' \| 'onStatusChange'>` | 见下 | 防抖/退避等 |
| `readOnly` | `boolean` | `false` | 初始只读 |
| `sourceMode` | `boolean` | `false` | 以源码模式启动 |
| `highlight` | `CodeHighlighter \| Promise<CodeHighlighter>` | — | 代码高亮 |
| `diagram` | `DiagramRenderer \| Promise<DiagramRenderer>` | — | diagram block（如 ```` ```mermaid ````）渲染器；缺省时按普通代码块呈现 |
| `onOpenLink` | `(href: string) => void` | `window.open` | Concealed 链接单击 |
| `onChange` | `(md: string) => void` | — | 每次 `docChanged` |
| `onPhaseChange` | `(phase: EditorPhase) => void` | — | L1 阶段变化 |
| `onSaveStatusChange` | `(status: SaveStatus, error?: unknown) => void` | — | L4 状态变化 |
| `plugins` | `Plugin[]` | `[]` | 追加自定义 ProseMirror 插件 |
| `history` | `boolean` | `true` | 是否启用撤销重做 |
| `normalizeOrderedLists` | `boolean` | `true` | 有序列表自动重编号 |
| `uploadImage` | `(file: File) => Promise<string>` | — | 粘贴 / 拖放 / `insertImageFiles` 的图片上传，返回写进 Markdown 的地址；缺省内联为 `data:` URL（不推荐，见 `createLocalImageStore`） |
| `resolveImage` | `(src: string) => string \| Promise<string>` | — | 渲染前把 Markdown 里的图片地址解析成可加载的 URL（相对路径 / 本地存储 / 私有签名）；源码不变 |

### `HandyEditor` 实例

| 成员 | 类型 | 说明 |
|---|---|---|
| `view` | `EditorView \| null` | 底层 ProseMirror 视图；`loading/error/destroyed` 时可能为 `null` |
| `autosave` | `Autosave \| null` | 未提供 `save` 时为 `null` |
| `phase` | `EditorPhase` | `loading \| ready \| error \| conflicted \| destroyed` |
| `saveStatus` | `SaveStatus` | `clean \| dirty \| saving \| retrying \| offline` |
| `readOnly` | `boolean` | 当前只读态 |
| `sourceMode` | `boolean` | 当前是否源码模式 |
| `loadError` | `unknown` | 最近一次加载错误 |
| `remoteConflict` | `string \| null` | 冲突中的远端文本 |
| `getMarkdown()` | `() => string` | 序列化（无损） |
| `setMarkdown(md, opts?)` | `(string, { addToHistory?: boolean }) => void` | 编程式替换 |
| `insertTable(opts?)` | `(InsertTableOptions) => boolean` | 编程式插入 GFM 表格 |
| `insertImage(opts)` | `({ src, alt? }) => boolean` | 独立成行插入 `![alt](src)` |
| `insertImageFiles(files)` | `(Iterable<File> \| FileList) => Promise<void>` | 插入图片文件（占位 → 上传 → 替换） |
| `exportToPDF(opts?)` | `(ExportPDFOptions) => Promise<void>` | 以渲染态打开系统打印对话框（存储为 PDF），见「导出 PDF」 |
| `setReadOnly(v)` | `(boolean) => void` | 切换只读 |
| `setSourceMode(v)` | `(boolean) => void` | 源码模式 ⇄ 渲染模式 |
| `focus()` | `() => void` | 聚焦 |
| `retry()` | `() => void` | `error → loading` 重试加载 |
| `notifyRemote(md)` | `(string) => void` | 通知远端版本变化 |
| `resolveConflict(choice)` | `('local' \| 'remote') => void` | 解决冲突 |
| `flush()` | `() => Promise<void>` | 立即保存 |
| `destroy()` | `() => Promise<void>` | flush 后销毁 |
| `on(event, handler)` | 见下 | 事件订阅，返回取消函数 |

### 事件

```ts
editor.on('phase', (phase: EditorPhase) => {})
editor.on('change', (markdown: string) => {})
editor.on('saveStatus', (status: SaveStatus) => {})
```

---

## L4：`Autosave`

```ts
import { Autosave, type AutosaveOptions, type SaveStatus } from '@21stware/handymd'

const as = new Autosave(() => markdown, {
  save: async (md) => { /* PUT */ },
  debounceMs: 800,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  listenOnline: true,
  onStatusChange: (status, error) => {},
})

as.markDirty()
as.markClean()
await as.flush()
as.retryNow()
as.destroy()
as.status  // SaveStatus
as.error
```

状态转移：`clean → dirty → saving → clean | retrying → offline`；保存期间再输入会在完成后立即再存。

---

## L3：conceal 插件

```ts
import {
  concealPlugin, concealKey, setConcealMeta,
  isRevealed, revealSignature, buildBlockDecos,
  type ConcealState, type ConcealMeta, type ConcealOptions,
} from '@21stware/handymd'

const plugin = concealPlugin({
  readOnly: false,
  // 可选：diagram block 的渲染回调（见"图表渲染"一节）
  renderDiagram: createDiagramRenderCallback(createMermaidRenderer()),
})

// 投递配置迁移
view.dispatch(setConcealMeta(view.state.tr, { readOnly: true }))
view.dispatch(setConcealMeta(view.state.tr, { composing: true }))
view.dispatch(setConcealMeta(view.state.tr, { refresh: true }))

const st = concealKey.getState(view.state)
// st.blocks / st.set / st.composing / st.readOnly
```

`isRevealed(el, selection, readOnly)`：pure hitTest。  
`buildBlockDecos(block, revealed[], ctx?)`：由元素+reveal 位生成 decoration；`ctx.renderDiagram` 控制 diagram block 的渲染。

---

## L2：输入管线插件

```ts
import {
  imePlugin,                 // composition 冻结
  interactionsPlugin,        // 链接打开 / checkbox
  caretGuardPlugin,          // 隐藏前缀光标 / 选区保护
  clipboardPlugin,           // 源码行级复制粘贴、HTML → Markdown、粘贴网址成链接
  normalizePlugin,           // 有序列表重编号
  markdownKeymap,            // Enter / Backspace / Mod-b…
  continueListItem,          // Enter
  splitWithoutPrefix,        // Shift-Enter
  closeFenceOnEnter,         // 未闭合围栏自动补闭合行
  toggleInline,
  setHeading,                // setHeading(1…6)
  indentListItem,
  dedentListItem,
  insertTab,
  removeTab,
  backspaceBlockFormat,
  deleteForwardStripPrefix,  // Delete
  arrowLeftSkipPrefix,
  shiftArrowLeftSkipPrefix,
  htmlToMarkdown,
  markdownToSlice,
} from '@21stware/handymd'

interactionsPlugin({ onOpenLink: (href) => location.assign(href) })
toggleInline('**')  // Command
```

---

## 表格（编程式）

GFM 表格无输入触发；请用 `editor.insertTable()` 或 `insertTable` command。

```ts
import {
  insertTable, buildTableMarkdown,
  goToNextTableCell, goToPrevTableCell, continueTableRow,
  parseTableRow, isTableSeparator,
  type InsertTableOptions,
} from '@21stware/handymd'

editor.insertTable({ rows: 3, cols: 3, headers: ['A', 'B', 'C'] })
buildTableMarkdown({ rows: 2, cols: 2 })
// => "|  |  |\n| --- | --- |\n|  |  |"

insertTable({ rows: 3, cols: 3 })(view.state, view.dispatch)
```

`InsertTableOptions`：`rows?`（含表头，默认 3）、`cols?`（默认 3）、`withHeaderRow?`（默认 true）、`headers?`。

表格在表头行渲染为单个网格 widget，单元格内编辑（见使用指南「表格」）。相关导出：

```ts
import {
  focusTableCell,   // (view, headerPos, { row, col }, caret?) → 让某格进入编辑
  parseTableModel,  // 整表源码 → { rows, align, colCount }
  renderCellPreview,
  parseTableAlign,
  backspaceIntoTable, deleteIntoTable, // 表格前后行的 Backspace / Delete 不并入管道源码
  tableControllerAt, // (view, headerPos) → 控制器；.pick({ kind: 'row' | 'col', index }) 选中整行 / 整列
} from '@21stware/handymd'
```

`goToNextTableCell` / `goToPrevTableCell` / `continueTableRow` 作用于 ProseMirror 选区，仅在源码模式下生效。

结构操作是作用于管道源码的纯函数（widget 的行列菜单 / 拖动排序也用它们）。行下标含表头（0 = 表头）；
行操作保留未改动行的原文，列操作重写每一行与分隔行。返回 `null` 表示整张表被删空：

```ts
import {
  splitTableSource, joinTableSource,       // 整表源码 ⇄ { rows, sep }
  insertTableRow, deleteTableRow, moveTableRow,
  insertTableColumn, deleteTableColumn, moveTableColumn,
  setTableColumnAlign,                     // 'left' | 'center' | 'right' | 'none'
} from '@21stware/handymd'

const t = splitTableSource('| A | B |\n| --- | --- |\n| 1 | 2 |')
joinTableSource(moveTableColumn(t, 0, 1)).join('\n') // '| B | A |\n| --- | --- |\n| 2 | 1 |'
```

---

## 图片

```ts
import {
  insertImage, insertImageFiles, imageMarkdown, imagePlugin, selectedImage,
  createLocalImageStore,
} from '@21stware/handymd'

insertImage({ src: 'a.png', alt: 'A' })(view.state, view.dispatch)
await insertImageFiles(view, files, async (file) => uploadAndGetUrl(file))
imagePlugin({ upload })   // 粘贴 / 拖放图片文件 + 图片的点击选中 / 键盘删除
imageMarkdown({ src: 'a b.png', alt: 'x' }) // => "![x](a%20b.png)"
selectedImage(state)      // 选区恰好选中一张图片时返回该元素，否则 null
```

图片是原子元素：渲染态下永远不回到 `![alt](src)` 源码。单击 = 选中（选区覆盖整段源码，画
`.hm-image-selected`），`Backspace` / `Delete` 先选中再删除，方向键把它当作一个字符跨过，
选中时 `Enter` 在图片后开新行。改 alt / 地址请用源码模式。

`createLocalImageStore(opts?)` → `{ upload, resolve, get }`：没有后端时代替 `data:` 内联。
文件存进 IndexedDB（不可用时退化为内存），Markdown 里只写短路径 `assets/<name>-<hash>.<ext>`
（内容哈希去重），渲染时由 `resolve` 换回 `blob:` URL。

| 选项 | 默认 | 说明 |
|---|---|---|
| `prefix` | `'assets/'` | 写进 Markdown 的路径前缀；`resolve` 只处理这个前缀下的地址 |
| `dbName` | `'handymd-images'` | IndexedDB 库名；`null` = 只存内存 |

---

## 导出 PDF

```ts
import { exportToPDF, buildPrintDocument, printableClone } from '@21stware/handymd'

await editor.exportToPDF({ title: '周报' })   // 或 exportToPDF(view, opts)
```

克隆编辑器的渲染 DOM 写进隐藏 iframe 后调用 `print()`，用户在打印对话框里选「存储为 PDF」。
导出前临时切到只读渲染态（光标下的元素也收起源码；源码模式同样按渲染态导出），完成后还原；
会等待仍在渲染的图表与图片。页面样式表与 `--hm-*` 主题变量一并带入。

| 选项 | 默认 | 说明 |
|---|---|---|
| `title` | 第一个标题 | 打印文档标题（多数浏览器用作默认 PDF 文件名） |
| `css` | — | 追加的打印 CSS（如 `@page { size: A4 landscape }`） |
| `timeout` | `8000` | 等待图表 / 图片 / 样式的上限（ms） |
| `print` | `win => win.print()` | 替换触发打印的方式（桌面壳的原生打印 / 测试拦截） |

`buildPrintDocument(view, { title?, css? })` 返回完整 HTML 字符串，可自行交给服务端渲染 PDF；
`printableClone(dom)` 只做 DOM 清理（去掉表格把手、编辑中的格子、选中态）。

---

## 代码高亮

```ts
import {
  highlightPlugin, highlightKey, createShikiHighlighter,
  type CodeHighlighter, type HighlightSpan, type ShikiHighlighterOptions,
} from '@21stware/handymd'

type HighlightSpan = { text: string; color?: string }
type CodeHighlighter = (code: string, lang: string) => HighlightSpan[][] | Promise<HighlightSpan[][]>

const hl = await createShikiHighlighter({
  theme: 'github-light',
  langs: ['javascript', 'typescript', 'python', 'bash', 'json', 'html', 'css', 'markdown'],
})
highlightPlugin(hl)
// 或 highlightPlugin(createShikiHighlighter()) — 接受 Promise
```

---

## 图表渲染（diagram block）

```` ```mermaid ```` 围栏在**结构化解析层**就与普通代码块分开（`diagramOpen` / `diagramLine` / `diagramClose`），并遵循块级 Live Render 语义：光标离开围栏区域 → 源码整块隐藏、渲染为图表；光标进入（或点击图表）→ 回到围栏源码编辑，视觉与普通代码块一致。

```ts
import {
  createMermaidRenderer, createDiagramRenderCallback,
  type DiagramRenderer, type DiagramRenderCallback, type MermaidRendererOptions,
} from '@21stware/handymd'

// 渲染器契约：源码 → SVG/HTML 字符串（可异步；抛错 = 图表语法错误）
type DiagramRenderer = (code: string, lang: string) => string | Promise<string>

// 用 HandyEditor：直接传 diagram 选项（mermaid 为可选依赖，动态 import）
createEditor({ mount, diagram: createMermaidRenderer({ theme: 'neutral' }) })

// 自建 EditorView：包一层缓存回调再交给 concealPlugin
concealPlugin({ renderDiagram: createDiagramRenderCallback(createMermaidRenderer()) })
```

行为细节：

- 渲染只发生在 Concealed 态（光标离开之后），编辑期间永远是源码 —— 不存在"边打字边重渲染"的抖动；
- 结果按 `(lang, code)` 缓存，光标反复进出同一图表命中缓存、无闪烁；
- 渲染失败显示错误信息（`.hm-diagram-error`），点击仍可进入源码修复；
- 空围栏显示占位（`.hm-diagram-empty`），不会让块"消失"；
- 未配置渲染器时 diagram block 退化为普通代码块呈现（解析层仍然分类为 diagram）。

---

## 文档模型与解析

```ts
import {
  schema,
  markdownToDoc, docToMarkdown, toCommonMark,
  parseInline, parseInlineCached,
  classifyLines, parseDoc,
  type LineInfo, type LineType, type BlockMeta,
  type ElementRange, type ElementKind, type ElementAttrs,
  type InlineKind, type BlockKind, type RelElement, type Span,
} from '@21stware/handymd'

markdownToDoc('# hi')           // Node
docToMarkdown(doc)              // string，无损
toCommonMark(md, { lineBreak: 'hard' })  // 导出为语义等价的 CommonMark（见 guide）
parseInline('**a** ==b==')      // RelElement[]（相对坐标）
classifyLines(['# a', '```', 'x', '```'])
parseDoc(doc)                   // BlockMeta[]（绝对坐标 + 元素表）
```

### `ElementRange` 要点

| 字段 | 说明 |
|---|---|
| `kind` | `strong \| em \| code \| strike \| mark \| link \| image \| tag \| heading \| quote \| todo \| bullet \| ordered \| hr \| fenceOpen \| fenceClose \| codeLine \| diagramOpen \| diagramClose \| diagramLine \| tableHeader \| tableSep \| tableRow \| tableCell` |
| `scope` | `inline`（扩一格命中）/ `block`（块命中） |
| `from` / `to` | 元素整体范围 |
| `hitFrom` / `hitTo` | cursorEnter/Leave 判定区间 |
| `markers` | 需隐藏的标记符子范围 |
| `content` | 语义内容范围 |
| `static` | 永不参与 reveal（tag / codeLine / ordered 序号样式） |
| `permanent` | 永久 Concealed（quote / bullet / todo / hr） |
| `attrs` | `level` / `checked` / `checkPos` / `href` / `alt` / `indent` / `num` / `info` / `lang` / `code` / `colCount` / `col` / `tableEdge` / `tableSrc` |

> 标题**不**设 `permanent`：源码 `#` 在 decoration 层永远隐藏，但聚焦时要展示层级图标，因此参与 reveal 判定。

---

## CSS 入口

```ts
import '@21stware/handymd/style.css'
// 或
import '@21stware/handymd/style.css' // package exports: "./style.css"
```

挂载点 class：`handymd`。关键类名：

| class | 用途 |
|---|---|
| `.hm-concealed` | `font-size:0` 隐藏标记 |
| `.hm-caret-pad` | 透明空格，保证行首光标可见 |
| `.hm-marker` | 可见（弱化）标记 |
| `.hm-strong` / `.hm-em` / `.hm-code` / `.hm-strike` / `.hm-mark` / `.hm-link` / `.hm-tag` | 行内语义 |
| `.hm-heading` / `.hm-h1`… / `.hm-heading-badge` | 标题与层级图标 |
| `.hm-quote` / `.hm-todo` / `.hm-bullet` / `.hm-ordered` | 块级 |
| `.hm-checkbox` / `.hm-bullet-dot` / `.hm-hr` / `.hm-image` | widgets |
| `.hm-code-line` / `.hm-fence-line` / `.hm-code-lang` | 代码块 |
| `.hm-diagram` / `.hm-diagram-host` / `.hm-diagram-hidden` / `.hm-diagram-loading` / `.hm-diagram-empty` / `.hm-diagram-error` | diagram block |
| `.hm-table-wrap` / `table.hm-table-grid` / `.hm-table-cell` / `.hm-table-cell-editing` | 表格网格 widget / 单元格 / 编辑中的单元格 |
| `.hm-table-scroll` / `.hm-table-cell-picked` | 表格横向滚动容器 / 被选中整行整列的单元格 |
| `.hm-table-handle-row` / `.hm-table-handle-col` / `.hm-table-add-row` / `.hm-table-add-col` / `.hm-table-menu` | 行列把手 / 添加条 / 行列菜单（只读态隐藏） |
| `img.hm-image` / `.hm-image-selected` | 图片预览 / 选中态 |
| `.hm-table-host` / `.hm-table-hidden` | 表头源码行（承载网格） / 折叠的分隔行与表体源码行 |
