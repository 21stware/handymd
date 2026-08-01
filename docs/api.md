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
| `highlight` | `CodeHighlighter \| Promise<CodeHighlighter>` | — | 代码高亮 |
| `diagram` | `DiagramRenderer \| Promise<DiagramRenderer>` | — | diagram block（如 ```` ```mermaid ````）渲染器；缺省时按普通代码块呈现 |
| `onOpenLink` | `(href: string) => void` | `window.open` | Concealed 链接单击 |
| `onChange` | `(md: string) => void` | — | 每次 `docChanged` |
| `onPhaseChange` | `(phase: EditorPhase) => void` | — | L1 阶段变化 |
| `onSaveStatusChange` | `(status: SaveStatus, error?: unknown) => void` | — | L4 状态变化 |
| `plugins` | `Plugin[]` | `[]` | 追加自定义 ProseMirror 插件 |
| `history` | `boolean` | `true` | 是否启用撤销重做 |
| `normalizeOrderedLists` | `boolean` | `true` | 有序列表自动重编号 |

### `HandyEditor` 实例

| 成员 | 类型 | 说明 |
|---|---|---|
| `view` | `EditorView \| null` | 底层 ProseMirror 视图；`loading/error/destroyed` 时可能为 `null` |
| `autosave` | `Autosave \| null` | 未提供 `save` 时为 `null` |
| `phase` | `EditorPhase` | `loading \| ready \| error \| conflicted \| destroyed` |
| `saveStatus` | `SaveStatus` | `clean \| dirty \| saving \| retrying \| offline` |
| `readOnly` | `boolean` | 当前只读态 |
| `loadError` | `unknown` | 最近一次加载错误 |
| `remoteConflict` | `string \| null` | 冲突中的远端文本 |
| `getMarkdown()` | `() => string` | 序列化（无损） |
| `setMarkdown(md, opts?)` | `(string, { addToHistory?: boolean }) => void` | 编程式替换 |
| `setReadOnly(v)` | `(boolean) => void` | 切换只读 |
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
  caretGuardPlugin,          // 隐藏前缀光标保护
  normalizePlugin,           // 有序列表重编号
  markdownKeymap,            // Enter / Backspace / Mod-b…
  continueListItem,
  toggleInline,
  indentListItem,
  dedentListItem,
  backspaceBlockFormat,
  arrowLeftSkipPrefix,
} from '@21stware/handymd'

interactionsPlugin({ onOpenLink: (href) => location.assign(href) })
toggleInline('**')  // Command
```

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
  markdownToDoc, docToMarkdown,
  parseInline, parseInlineCached,
  classifyLines, parseDoc,
  type LineInfo, type LineType, type BlockMeta,
  type ElementRange, type ElementKind, type ElementAttrs,
  type InlineKind, type BlockKind, type RelElement, type Span,
} from '@21stware/handymd'

markdownToDoc('# hi')           // Node
docToMarkdown(doc)              // string，无损
parseInline('**a** ==b==')      // RelElement[]（相对坐标）
classifyLines(['# a', '```', 'x', '```'])
parseDoc(doc)                   // BlockMeta[]（绝对坐标 + 元素表）
```

### `ElementRange` 要点

| 字段 | 说明 |
|---|---|
| `kind` | `strong \| em \| code \| strike \| mark \| link \| image \| tag \| heading \| quote \| todo \| bullet \| ordered \| hr \| fenceOpen \| fenceClose \| codeLine \| diagramOpen \| diagramClose \| diagramLine` |
| `scope` | `inline`（扩一格命中）/ `block`（块命中） |
| `from` / `to` | 元素整体范围 |
| `hitFrom` / `hitTo` | cursorEnter/Leave 判定区间 |
| `markers` | 需隐藏的标记符子范围 |
| `content` | 语义内容范围 |
| `static` | 永不参与 reveal（tag / codeLine / ordered 序号样式） |
| `permanent` | 永久 Concealed（quote / bullet / todo / hr） |
| `attrs` | `level` / `checked` / `checkPos` / `href` / `alt` / `indent` / `num` / `info` / `lang` / `code` |

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
