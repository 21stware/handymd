/**
 * Diagram block 渲染（如 mermaid）。
 *
 * 与 conceal 层的分工：解析层把 ```mermaid 围栏识别为 diagram block
 * （diagramOpen / diagramLine / diagramClose），conceal 层在 Concealed 态
 * 隐藏整块源码并放一个 `.hm-diagram` widget 容器 —— 本模块负责把
 * (code, lang) 异步渲染成 SVG 填进该容器。
 *
 * Live Render 时序上这天然契合 Bear 手感：渲染只发生在 Concealed 态
 * （光标离开围栏区域之后），编辑期间（Revealed）永远是源码，因此
 * 不存在"边打字边重渲染图表"的抖动；结果按 (lang, code) 缓存，
 * 光标反复进出同一图表时命中缓存同步回填，无闪烁。
 */

export interface DiagramRenderErrorInfo {
  message: string
}

/** 把图表源码渲染为 SVG/HTML 字符串（可异步）。抛错 = 图表语法错误。 */
export type DiagramRenderer = (code: string, lang: string) => string | Promise<string>

/**
 * conceal 层使用的同步回调：widget 创建时立即调用，容器先呈现
 * loading 占位，渲染 resolve 后原地替换（widget key 稳定，DOM 复用）。
 */
export type DiagramRenderCallback = (container: HTMLElement, code: string, lang: string) => void

const CACHE_MAX = 64

/**
 * 把（可能是 Promise 的）DiagramRenderer 包装成 conceal 层可用的同步回调：
 *   - 结果按 (lang, code) 缓存，命中时同步填充（无 loading 闪烁）
 *   - 渲染失败进入错误缓存，容器显示错误信息（点击仍可进入源码修复）
 *   - renderer 尚未 resolve 时先排队，resolve 后统一回填
 */
export function createDiagramRenderCallback(
  renderer: DiagramRenderer | Promise<DiagramRenderer>,
): DiagramRenderCallback {
  let resolved: DiagramRenderer | null = renderer instanceof Promise ? null : renderer
  const cache = new Map<string, string>()
  const failed = new Map<string, string>()
  const waiting: Array<[HTMLElement, string, string]> = []

  const keyOf = (code: string, lang: string) => `${lang}\u0000${code}`

  const applySvg = (el: HTMLElement, svg: string): void => {
    el.classList.remove('hm-diagram-loading', 'hm-diagram-error')
    el.innerHTML = svg
  }

  const applyError = (el: HTMLElement, message: string): void => {
    el.classList.remove('hm-diagram-loading')
    el.classList.add('hm-diagram-error')
    el.textContent = message
  }

  const remember = (map: Map<string, string>, k: string, v: string): void => {
    if (map.size >= CACHE_MAX) map.clear()
    map.set(k, v)
  }

  const fill = (el: HTMLElement, code: string, lang: string): void => {
    const k = keyOf(code, lang)
    el.dataset.hmDiagramKey = k

    const hit = cache.get(k)
    if (hit !== undefined) {
      applySvg(el, hit)
      return
    }
    const err = failed.get(k)
    if (err !== undefined) {
      applyError(el, err)
      return
    }

    if (!resolved) {
      el.classList.add('hm-diagram-loading')
      el.textContent = lang
      waiting.push([el, code, lang])
      return
    }

    let out: string | Promise<string>
    try {
      out = resolved(code, lang)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      remember(failed, k, message)
      applyError(el, message)
      return
    }

    if (typeof out === 'string') {
      remember(cache, k, out)
      applySvg(el, out)
      return
    }

    el.classList.add('hm-diagram-loading')
    el.textContent = lang
    out
      .then((svg) => {
        remember(cache, k, svg)
        // 容器可能已被复用/重建；只回填仍对应这份源码的容器
        if (el.dataset.hmDiagramKey === k) applySvg(el, svg)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        remember(failed, k, message)
        if (el.dataset.hmDiagramKey === k) applyError(el, message)
      })
  }

  if (renderer instanceof Promise) {
    void renderer.then((fn) => {
      resolved = fn
      const queue = waiting.splice(0, waiting.length)
      for (const [el, code, lang] of queue) fill(el, code, lang)
    })
  }

  return fill
}

export interface MermaidRendererOptions {
  /** mermaid 主题，默认 'neutral' */
  theme?: string
  /** 透传给 mermaid.initialize 的其余配置 */
  config?: Record<string, unknown>
}

interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}

/**
 * mermaid 适配器（mermaid 为可选依赖，动态 import，未安装时不打进产物）。
 *
 *   const editor = createEditor({
 *     diagram: createMermaidRenderer(),
 *   })
 */
export async function createMermaidRenderer(
  options: MermaidRendererOptions = {},
): Promise<DiagramRenderer> {
  const mod = (await import('mermaid')) as unknown as { default?: MermaidLike } & MermaidLike
  const mermaid = mod.default ?? mod
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: options.theme ?? 'neutral',
    ...options.config,
  })

  let seq = 0
  return async (code) => {
    const id = `hm-mermaid-${Date.now().toString(36)}-${++seq}`
    try {
      const { svg } = await mermaid.render(id, code)
      return svg
    } finally {
      // mermaid.render 失败时可能把临时容器留在 body 里
      if (typeof document !== 'undefined') document.getElementById(`d${id}`)?.remove()
    }
  }
}
