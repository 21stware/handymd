# @21stware/handymd

Bear 风格的**源码保真** Markdown 编辑器 SDK，基于 [ProseMirror](https://prosemirror.net)，工具链基于 [Bun](https://bun.sh)。

核心理念：**文档即 Markdown 源码 + 按光标位置选择性隐藏标记符**。没有富文本模型 —— 语义只存在于 decoration 层；每个元素在 `Concealed` / `Revealed` 之间由 selection 纯函数推导，不为元素存状态对象。

**Landing / 在线试写：** https://21stware.github.io/handymd/

本地开发：

```bash
bun run dev:site   # Landing Page（GitHub Pages 同源）
bun run dev        # 开发调试页 example/
```

```bash
bun add @21stware/handymd
# 或
npm install @21stware/handymd
```

## 快速开始

```ts
import { createEditor, createMermaidRenderer, createShikiHighlighter } from '@21stware/handymd'
import '@21stware/handymd/style.css'

const editor = createEditor({
  mount: document.getElementById('editor')!,
  load: () => fetch('/api/note/42').then((r) => r.text()),
  save: (markdown) => fetch('/api/note/42', { method: 'PUT', body: markdown }),
  autosave: { debounceMs: 800 },
  highlight: createShikiHighlighter({ theme: 'github-light' }), // 可选，需安装 shiki
  diagram: createMermaidRenderer(),                              // 可选，需安装 mermaid
  onPhaseChange: (phase) => console.log('L1:', phase),
  onSaveStatusChange: (status) => console.log('L4:', status),
})

editor.getMarkdown()
editor.setMarkdown('# 新内容')
editor.insertTable({ rows: 3, cols: 3 }) // GFM 表格请用编程式插入
editor.setReadOnly(true)
await editor.flush()
await editor.destroy()
```

更完整的用法见：

| 文档 | 内容 |
|---|---|
| [docs/guide.md](./docs/guide.md) | 安装、接入、主题、快捷键、协同冲突、常见场景 |
| [docs/api.md](./docs/api.md) | 完整 API 参考 |
| [docs/architecture.md](./docs/architecture.md) | 四层状态机与 ProseMirror 映射 |

## 手感一览

**行内（conceal ⇄ reveal）**

- `**bold**` / `*em*` / `` `code` `` / `~~strike~~` / `==mark==` / 链接 / 图片
- 扩一格判定：光标停在紧邻外侧即 Reveal
- 嵌套强调：`*outer **inner**.*` 两层都生效
- Concealed 链接单击打开；Cmd/Ctrl+点击进入编辑
- IME composition 期间冻结状态迁移

**块级（permanent：一旦渲染不回源码）**

- `- ` → bullet，`- [ ] ` / `- [x] ` → checkbox，`> ` → 引用，`---` → 分隔线
- 标题：源码 `#`/`##` 永远隐藏；**聚焦时**左侧 gutter 出层级图标
- GFM 表格：`editor.insertTable()` 编程式创建（多行结构，无输入触发）；Tab 移格、Enter 加行
- 行首 Backspace 去掉格式；空前缀行再 Enter 退出块

**Diagram block（```` ```mermaid ````，块级 Live Render）**

- 结构化解析层就与普通代码块分开（`diagramOpen` / `diagramLine` / `diagramClose`）
- 光标离开围栏区域 → 源码整块隐藏、渲染为图表；光标进入 / 点击图表 → 回到源码编辑
- 渲染只发生在 Concealed 态，编辑期间永远直面源码；结果按 `(lang, code)` 缓存

**其它**

- 序列化免费（`doc` 本身就是源码），roundtrip 无损
- 可选 shiki 代码高亮 / mermaid 图表渲染（peer dependency，动态 import）
- 防抖自动保存 + 指数退避 + 冲突提示

## 开发

```bash
bun install
bun test                 # 单元测试（happy-dom）
bun run typecheck
bun run build            # dist/（ESM + d.ts + style.css）
bun run dev              # example/ 演示
bun run e2e              # 29 项真实 Chromium 端到端（需先 bun run dev）
```

## 发布

```bash
bun run prepublishOnly   # typecheck + test + build
npm publish --access public
```
```

## License

MIT
