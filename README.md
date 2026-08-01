# handymd

Bear 风格的**源码保真** Markdown 编辑器 SDK，基于 [ProseMirror](https://prosemirror.net)，工具链基于 [Bun](https://bun.sh)。

核心理念：**文档即 Markdown 源码 + 按光标位置选择性隐藏标记符**。没有富文本模型 —— 每个 Markdown 元素在 `Concealed`（渲染态，标记隐藏）与 `Revealed`（源码态，标记可见）之间切换，由 selection 驱动，纯函数推导，不为任何元素存状态对象。

```bash
bun add handymd
# 或
npm install handymd
```

## 快速开始

```ts
import { createEditor } from 'handymd'
import 'handymd/style.css'

const editor = createEditor({
  mount: document.getElementById('editor')!,

  // 内容来源：直接给字符串，或异步 load（进入 Loading → Ready/Error 生命周期）
  load: () => fetch('/api/note/42').then((r) => r.text()),

  // 提供 save 即启用防抖自动保存（L4 状态机）
  save: (markdown) => fetch('/api/note/42', { method: 'PUT', body: markdown }),
  autosave: { debounceMs: 800 },

  onPhaseChange: (phase) => console.log('L1:', phase),        // loading/ready/error/conflicted/destroyed
  onSaveStatusChange: (status) => console.log('L4:', status), // clean/dirty/saving/retrying/offline
  onChange: (markdown) => console.log('内容变化'),
  onOpenLink: (href) => window.open(href, '_blank'),
})

editor.getMarkdown()        // 序列化免费：doc 本身就是源码
editor.setMarkdown('# 新内容')
editor.setReadOnly(true)    // L3 全部强制 Concealed + filterTransaction 拒写
await editor.flush()        // 立即保存（blur / ⌘S / destroy 会自动 flush）
await editor.destroy()      // flush 未保存内容后销毁
```

### 协同 / 远端版本

```ts
// 远端版本变化时调用：
//   本地干净 → 直接吃掉远端
//   本地有未保存改动 → phase 变为 'conflicted'，编辑冻结
editor.notifyRemote(remoteMarkdown)

// 用户选择保留一侧
editor.resolveConflict('local')  // 保留本地并立即推送
editor.resolveConflict('remote') // 采用远端，标记 clean
```

## 体验细节（复刻 Bear 手感）

- **扩一格判定**：光标停在 `**bold**` 的紧邻外侧（`[from-1, to+1]`）即 Reveal，从右侧退格进入不闪。
- **IME 安全**：中文输入法 composition 期间冻结一切 conceal/reveal 迁移，decoration 只做位置映射；`compositionend` 后补一次全量重算。拼音过程不闪烁。
- **Concealed 链接单击是"打开"**：mousedown 拦截、不移动光标；Cmd/Ctrl+点击或键盘移入才进入编辑。
- **Broken 零成本解散**：Revealed 态删掉一个 `*`，元素立即降级为纯文本 —— 文档本来就是源码，"解散"只是 decoration 消失。
- **代码块例外**：内部永远是源码（不解析行内元素），只有 ``` 围栏行参与 conceal；光标在代码块内任意位置时两条围栏行都保持 Revealed。
- **checkbox / 图片 / 分隔线**：Concealed 态渲染为 `Decoration.widget` DOM 岛，checkbox 点击直接改写源码 `[ ]` ↔ `[x]`，不动光标。
- **标记隐藏用 `font-size: 0`** 而非 `display: none`，光标测量与点击定位保持正确。
- **有序列表自动重编号**：`appendTransaction` 规范化，run 首项保留用户起始值，之后逐一递增；不进 undo history。
- **回车续行**：列表/待办/引用自动携带前缀，空前缀行再回车退出列表。

## 四层状态机 → 代码映射

| 层 | 职责 | 实现 |
|---|---|---|
| L1 生命周期 | Loading/Ready/Error/Conflicted/Destroyed，ReadOnly 子状态 | `HandyEditor`（`src/editor.ts`） |
| L2 输入管线 | IME 冻结、filterTransaction 只读锁、appendTransaction 规范化、Reconciling | `imePlugin` + 只读锁 + `normalizePlugin` + `concealPlugin.apply` |
| L3 元素渲染 | 每个元素 Concealed ⇄ Revealed，selection 驱动 | `concealPlugin`（`src/conceal/`） |
| L4 持久化 | Clean/Dirty/Saving/Retrying/Offline，防抖 + 指数退避 | `Autosave`（`src/autosave.ts`） |

**L3 的关键架构决策**：状态不"存"在对象里。每次事务后由 `(doc, selection, composing, readOnly)` 四元组纯函数推导全量 conceal/reveal 结果：

1. **Reparse** — `parseDoc`：行级分类（fence 状态机）+ 行内扫描；行内解析按行文本缓存，未编辑的行 O(1) 命中，成本退化为 O(变更行数)。
2. **HitTest** — `isRevealed(el, selection, readOnly)`：inline 元素比 `[from-1, to+1]` 相交，块级元素比光标所在块，fence 比整个代码块区域。
3. **Decorate** — 每块计算 reveal 签名，**只有签名变化的块才重建 decoration**，其余复用缓存数组。

因此 undo/redo、协同 patch、粘贴等一切改动路径自动正确 —— 它们只是产生了一个新的四元组。decoration 不进 history，`prosemirror-history` 直接可用。

## ProseMirror 原语映射

| 设计概念 | 原语 |
|---|---|
| 文档模型 | 源码保真 schema：`doc → block+`（一行一块），块内纯文本，**无 marks** |
| 元素范围表 | `concealPlugin` 的 state：`{ blocks, sigs, decoLists, set }` |
| 隐藏标记符 | `Decoration.inline` + `.hm-concealed { font-size: 0 }` |
| 语义样式 | `Decoration.inline`（`hm-strong` / `hm-link`…）；块级用 `Decoration.node` |
| checkbox / 图片 / hr / 语言徽标 | `Decoration.widget` |
| cursorEnter/Leave | `apply(tr)` 中比较 selection 与 ranges，按块签名增量重建 |
| IME 冻结 | composing 期间 `apply` 只 map；`compositionend` 后补空事务重算 |
| 链接 Concealed 态点击打开 | `handleDOMEvents.mousedown` 命中即 `preventDefault` + open |
| 只读锁 | `filterTransaction` + `editable: () => false` |
| 撤销重做 | `prosemirror-history`（decoration 不进 history，天然正确） |

## 进阶：不用 `createEditor`，自己攒 EditorView

所有插件都可独立使用：

```ts
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import {
  schema, markdownToDoc, docToMarkdown,
  concealPlugin, imePlugin, interactionsPlugin,
  markdownKeymap, normalizePlugin,
} from 'handymd'

const state = EditorState.create({
  doc: markdownToDoc('# hello'),
  plugins: [
    concealPlugin(),
    imePlugin(),
    interactionsPlugin({ onOpenLink: console.log }),
    markdownKeymap(),
    normalizePlugin(),
    // 你自己的插件…
  ],
})
const view = new EditorView(mount, { state })
docToMarkdown(view.state.doc) // ← 永远是干净的 markdown
```

解析层同样可以单独调用：`parseInline` / `classifyLines` / `parseDoc`。

## 主题

默认主题是 Bear 风格暖色调，全部走 CSS 变量，覆盖 `.handymd` 上的变量即可换肤：

```css
.handymd {
  --hm-accent: #d23669;        /* 链接 / 光标 / 列表符号 */
  --hm-fg: #24292f;
  --hm-codeblock-bg: #f6f8fa;
  /* 完整变量列表见 src/style.css */
}
```

## 开发

```bash
bun install
bun test            # 48 个测试：解析 / L3 状态机 / L4 状态机 / L1 生命周期
bun run typecheck
bun run build       # dist/（ESM + d.ts + style.css）
bun run dev         # 启动 example/ 演示应用
```

## 支持的 Markdown 语法

行内：`**strong**`、`*em*`、`` `code` ``、`~~strike~~`、`[link](url)`、`![image](url)`、`#tag`（Bear 风格，永远 pill 展示）。

块级：`# 标题`（1-6 级）、`> 引用`、`- [ ] 待办`、`- 无序列表`、`1. 有序列表`、`---` 分隔线、``` 代码块围栏。

## License

MIT
