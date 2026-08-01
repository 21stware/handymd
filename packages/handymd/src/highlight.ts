import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { concealKey } from './conceal/plugin'

/**
 * 代码块语法高亮。
 *
 * 与 conceal 层完全解耦：本插件只读取 conceal 状态里的 fence 区域，
 * 把 (code, lang) 交给外部 CodeHighlighter（推荐 shiki），拿到逐行
 * token 后铺 inline decoration（style="color:…"）。
 *
 * 高亮是异步的：结果按 (lang, code) 缓存；未命中时先渲染无高亮，
 * resolve 后补一次 meta 事务刷新。文档模型不变 —— 高亮永远只是 decoration。
 */

export interface HighlightSpan {
  text: string
  color?: string
}

/** 返回逐行 token（与输入 code 按 \n 切分后行数对应） */
export type CodeHighlighter = (
  code: string,
  lang: string,
) => HighlightSpan[][] | Promise<HighlightSpan[][]>

export const highlightKey = new PluginKey<DecorationSet>('handymd-highlight')

interface FenceRegion {
  lang: string
  code: string
  /** 每行代码的文本起点（绝对文档位置） */
  lineStarts: number[]
  lines: string[]
}

function collectRegions(state: EditorState): FenceRegion[] {
  const st = concealKey.getState(state)
  if (!st) return []
  const regions: FenceRegion[] = []
  for (let i = 0; i < st.blocks.length; i++) {
    const line = st.blocks[i].line
    if (line.t !== 'fenceOpen' || !line.info) continue
    const lang = line.info.split(/\s+/)[0]
    const lines: string[] = []
    const lineStarts: number[] = []
    for (let j = i + 1; j < st.blocks.length && st.blocks[j].line.t === 'code'; j++) {
      lines.push(st.blocks[j].text)
      lineStarts.push(st.blocks[j].pos + 1)
    }
    if (lines.length) regions.push({ lang, code: lines.join('\n'), lineStarts, lines })
  }
  return regions
}

function decosFor(region: FenceRegion, spans: HighlightSpan[][]): Decoration[] {
  const out: Decoration[] = []
  const n = Math.min(region.lineStarts.length, spans.length)
  for (let i = 0; i < n; i++) {
    const lineEnd = region.lineStarts[i] + region.lines[i].length
    let col = 0
    for (const span of spans[i]) {
      const from = region.lineStarts[i] + col
      const to = Math.min(from + span.text.length, lineEnd)
      col += span.text.length
      if (span.color && to > from) {
        out.push(Decoration.inline(from, to, { style: `color:${span.color}` }, { hmHl: true }))
      }
    }
  }
  return out
}

const CACHE_MAX = 128

export function highlightPlugin(
  highlighter: CodeHighlighter | Promise<CodeHighlighter>,
): Plugin<DecorationSet> {
  let resolved: CodeHighlighter | null = highlighter instanceof Promise ? null : highlighter
  const cache = new Map<string, HighlightSpan[][]>()
  const pending = new Set<string>()
  /** resolve 后需要一次 refresh 的回调，由 plugin view 挂接 */
  let requestRefresh: (() => void) | null = null

  const keyOf = (r: FenceRegion) => `${r.lang}\u0000${r.code}`

  function compute(state: EditorState): DecorationSet {
    const decos: Decoration[] = []
    for (const region of collectRegions(state)) {
      const k = keyOf(region)
      const hit = cache.get(k)
      if (hit) {
        decos.push(...decosFor(region, hit))
        continue
      }
      if (!resolved || pending.has(k)) continue
      const result = resolved(region.code, region.lang)
      if (result instanceof Promise) {
        pending.add(k)
        result
          .then((spans) => {
            if (cache.size >= CACHE_MAX) cache.clear()
            cache.set(k, spans)
          })
          .catch(() => {})
          .finally(() => {
            pending.delete(k)
            requestRefresh?.()
          })
      } else {
        if (cache.size >= CACHE_MAX) cache.clear()
        cache.set(k, result)
        decos.push(...decosFor(region, result))
      }
    }
    return DecorationSet.create(state.doc, decos)
  }

  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_config, state) => compute(state),
      apply: (tr, prev, _old, next) => {
        if (tr.docChanged || tr.getMeta(highlightKey) === 'refresh') return compute(next)
        return prev
      },
    },
    props: {
      decorations(state) {
        return highlightKey.getState(state)
      },
    },
    view(view) {
      requestRefresh = () => {
        if (!view.isDestroyed) {
          view.dispatch(view.state.tr.setMeta(highlightKey, 'refresh'))
        }
      }
      if (resolved === null && highlighter instanceof Promise) {
        highlighter.then((fn) => {
          resolved = fn
          requestRefresh?.()
        })
      }
      return {
        destroy() {
          requestRefresh = null
        },
      }
    },
  })
}

export interface ShikiHighlighterOptions {
  /** shiki 主题名，默认 'github-light' */
  theme?: string
  /** 预加载的语言，默认常用前端/脚本语言 */
  langs?: string[]
}

/**
 * shiki 适配器（shiki 为可选依赖，动态 import，未安装时不打进产物）。
 *
 *   const editor = createEditor({
 *     highlight: createShikiHighlighter({ theme: 'github-light' }),
 *   })
 */
export async function createShikiHighlighter(
  options: ShikiHighlighterOptions = {},
): Promise<CodeHighlighter> {
  const shiki = await import('shiki')
  const theme = options.theme ?? 'github-light'
  const langs = options.langs ?? [
    'javascript',
    'typescript',
    'jsx',
    'tsx',
    'json',
    'html',
    'css',
    'python',
    'bash',
    'markdown',
  ]
  const hl = await shiki.createHighlighter({ themes: [theme], langs })
  const loaded = new Set(hl.getLoadedLanguages())
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', py: 'python' }

  return (code, lang) => {
    const l = aliases[lang] ?? lang
    if (!loaded.has(l)) return code.split('\n').map((text) => [{ text }])
    const lines = hl.codeToTokensBase(code, { lang: l as never, theme: theme as never })
    return lines.map((line) => line.map((t) => ({ text: t.content, color: t.color })))
  }
}
