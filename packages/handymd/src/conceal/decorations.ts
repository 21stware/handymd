import { Decoration } from 'prosemirror-view'
import type { DiagramRenderCallback } from '../diagram'
import type { ElementRange, Span } from '../elements'
import type { BlockMeta } from '../parse/docparse'
import { buildTableRowVisual } from './tableview'

/**
 * 由 (元素, 是否 Revealed) 生成 decoration —— L3 状态的"渲染输出"。
 *
 * 三类原语的分工（与设计文档的映射表一致）：
 *   - Decoration.inline + .hm-concealed（font-size:0，对光标测量友好）→ 隐藏标记符
 *   - Decoration.inline + 语义 class（hm-strong / hm-link…）→ 语义样式
 *   - Decoration.node → 块级样式（heading / quote / code-line…）
 *   - Decoration.widget → 不可编辑 DOM 岛（checkbox / hr / 图片预览 / 语言徽标）
 *
 * 所有 decoration 的 spec 都带 { hm, kind, role, concealed }，供测试与调试断言。
 */

interface HmSpec {
  hm: true
  kind: ElementRange['kind']
  role: 'marker' | 'content' | 'node' | 'widget'
  concealed: boolean
  [key: string]: unknown
}

function spec(el: ElementRange, role: HmSpec['role'], concealed: boolean, extra?: Record<string, unknown>): HmSpec {
  return { hm: true, kind: el.kind, role, concealed, ...extra }
}

function markerDecos(el: ElementRange, revealed: boolean, out: Decoration[]): void {
  const cls = revealed ? 'hm-marker' : 'hm-marker hm-concealed'
  for (const m of el.markers) {
    if (m.from >= m.to) continue
    out.push(Decoration.inline(m.from, m.to, { class: cls }, spec(el, 'marker', !revealed)))
  }
}

/**
 * 块级前缀隐藏：保留末尾一格为 caret-pad（透明、正常字号）。
 * 光标落在内容起点时若紧挨 font-size:0 会看不见；垫一格透明空格可修复。
 * 仅用于 heading / quote / bullet / todo，不用于行内 `**`。
 */
function concealMarkersWithCaretPad(el: ElementRange, out: Decoration[]): void {
  for (const m of el.markers) {
    if (m.from >= m.to) continue
    if (m.to - m.from >= 2) {
      out.push(
        Decoration.inline(
          m.from,
          m.to - 1,
          { class: 'hm-marker hm-concealed' },
          spec(el, 'marker', true),
        ),
      )
      out.push(
        Decoration.inline(
          m.to - 1,
          m.to,
          { class: 'hm-marker hm-caret-pad' },
          spec(el, 'marker', true, { caretPad: true }),
        ),
      )
    } else {
      out.push(
        Decoration.inline(m.from, m.to, { class: 'hm-marker hm-concealed' }, spec(el, 'marker', true)),
      )
    }
  }
}

function contentDeco(
  el: ElementRange,
  revealed: boolean,
  cls: string,
  out: Decoration[],
  attrs?: Record<string, string>,
): void {
  const c = el.content
  if (!c || c.from >= c.to) return
  out.push(Decoration.inline(c.from, c.to, { class: cls, ...attrs }, spec(el, 'content', !revealed)))
}

function nodeDeco(
  block: BlockMeta,
  el: ElementRange,
  revealed: boolean,
  cls: string,
  out: Decoration[],
  attrs?: Record<string, string>,
): void {
  out.push(
    Decoration.node(
      block.pos,
      block.pos + block.size,
      { class: cls, ...attrs },
      spec(el, 'node', !revealed),
    ),
  )
}

/**
 * Nest indent: turn leading spaces into a fixed-width inline spacer.
 * Avoids block `padding-left` (selection paints at old x, then jumps).
 */
function decorateListIndent(block: BlockMeta, el: ElementRange, out: Decoration[]): void {
  const spaces = el.attrs?.indent ?? 0
  if (spaces <= 0) return
  const from = block.pos + 1
  const to = from + spaces
  if (to <= from) return
  // Use rem — `em` would collapse to 0 under `.hm-list-indent { font-size: 0 }`.
  const level = spaces / 2
  out.push(
    Decoration.inline(
      from,
      to,
      { class: 'hm-list-indent', style: `width: ${level * 1.35}rem` },
      spec(el, 'marker', true, { indentPad: true }),
    ),
  )
}

/** Widget keys must ignore leading indent so Tab/Shift-Tab does not remount. */
function listWidgetKey(kind: string, block: BlockMeta, el: ElementRange, extra = ''): string {
  const indent = el.attrs?.indent ?? 0
  const rest = block.text.slice(indent)
  return extra ? `${kind}:${extra}:${rest}` : `${kind}:${rest}`
}

function widget(
  el: ElementRange,
  pos: number,
  key: string,
  toDOM: () => HTMLElement,
  out: Decoration[],
  side = 0,
): void {
  out.push(
    Decoration.widget(pos, toDOM, {
      key,
      side,
      ignoreSelection: true,
      ...spec(el, 'widget', true),
    }),
  )
}

function concealSpan(el: ElementRange, s: Span, out: Decoration[]): void {
  if (s.from >= s.to) return
  out.push(
    Decoration.inline(s.from, s.to, { class: 'hm-marker hm-concealed' }, spec(el, 'marker', true)),
  )
}

/** fence 围栏开行：面板样式 + 弱化标记；Concealed 时展示语言徽标 */
function fenceOpenDecos(block: BlockMeta, el: ElementRange, rev: boolean, out: Decoration[]): void {
  nodeDeco(block, el, rev, 'hm-fence-line hm-fence-open', out)
  markerDecos(el, rev, out)
  const info = el.attrs?.info
  if (!rev && info) {
    widget(
      el,
      el.markers[0].from,
      // content key — no absolute pos (survives map/rebuild when only positions shift)
      `lang:${info}`,
      () => {
        const badge = document.createElement('span')
        badge.className = 'hm-code-lang'
        badge.textContent = info
        return badge
      },
      out,
      -1,
    )
  }
}

function fenceCloseDecos(block: BlockMeta, el: ElementRange, rev: boolean, out: Decoration[]): void {
  nodeDeco(block, el, rev, 'hm-fence-line hm-fence-close', out)
  markerDecos(el, rev, out)
}

/**
 * decoration 生成的环境依赖。renderDiagram 缺省时 diagram block 退化为
 * 普通 code block 呈现（结构化解析仍然分类为 diagram，只是不渲染图表）。
 */
export interface DecorationContext {
  renderDiagram?: DiagramRenderCallback
}

export function buildBlockDecos(
  block: BlockMeta,
  revealed: readonly boolean[],
  ctx?: DecorationContext,
): Decoration[] {
  const out: Decoration[] = []

  block.elements.forEach((el, i) => {
    const rev = revealed[i]

    switch (el.kind) {
      case 'strong':
        contentDeco(el, rev, 'hm-strong', out)
        markerDecos(el, rev, out)
        break
      case 'em':
        contentDeco(el, rev, 'hm-em', out)
        markerDecos(el, rev, out)
        break
      case 'strike':
        contentDeco(el, rev, 'hm-strike', out)
        markerDecos(el, rev, out)
        break
      case 'mark':
        contentDeco(el, rev, 'hm-mark', out)
        markerDecos(el, rev, out)
        break
      case 'code':
        contentDeco(el, rev, 'hm-code', out)
        markerDecos(el, rev, out)
        break

      case 'link':
        contentDeco(el, rev, 'hm-link', out, el.attrs?.href ? { 'data-href': el.attrs.href } : undefined)
        markerDecos(el, rev, out)
        break

      case 'image':
        if (rev) {
          contentDeco(el, rev, 'hm-image-alt', out)
          markerDecos(el, rev, out)
        } else {
          // Concealed：整段源码隐藏，替换为图片预览 widget
          concealSpan(el, { from: el.from, to: el.to }, out)
          const href = el.attrs?.href ?? ''
          const alt = el.attrs?.alt ?? ''
          widget(
            el,
            el.from,
            `img:${href}\0${alt}`,
            () => {
              const img = document.createElement('img')
              img.className = 'hm-image'
              img.src = href
              img.alt = alt
              return img
            },
            out,
            -1,
          )
        }
        break

      case 'tag':
        contentDeco(el, false, 'hm-tag', out)
        break

      case 'heading': {
        // `#`/`##` 源码永远隐藏；聚焦（rev）时在 gutter 展示层级图标（非源码）。
        // 仅空标题保留末尾空格作 caret-pad；有内容时整段前缀 font-size:0，避免标题前多一格空白。
        const level = el.attrs?.level ?? 1
        const empty = !el.content || el.content.from >= el.content.to
        nodeDeco(block, el, rev, `hm-heading hm-h${level}${empty ? ' hm-heading-empty' : ''}`, out)
        if (empty) concealMarkersWithCaretPad(el, out)
        else markerDecos(el, false, out)
        if (rev) {
          const at = el.markers[0].to
          widget(
            el,
            at,
            `hb:${level}`,
            () => {
              const badge = document.createElement('span')
              badge.className = 'hm-heading-badge'
              badge.setAttribute('aria-hidden', 'true')
              badge.innerHTML =
                `<svg viewBox="0 0 18 18" width="18" height="18">` +
                `<rect x="1" y="3" width="16" height="2.4" rx="1.2" fill="currentColor"/>` +
                `<rect x="1" y="8" width="7" height="2.4" rx="1.2" fill="currentColor"/>` +
                `<rect x="1" y="13" width="7" height="2.4" rx="1.2" fill="currentColor"/>` +
                `<text x="11" y="16" font-size="9.5" font-weight="700" fill="currentColor">${level}</text>` +
                `</svg>`
              return badge
            },
            out,
            -1,
          )
        }
        break
      }

      case 'quote':
        nodeDeco(block, el, rev, 'hm-quote', out)
        concealMarkersWithCaretPad(el, out)
        break

      case 'todo': {
        const checked = el.attrs?.checked ?? false
        nodeDeco(block, el, rev, checked ? 'hm-todo hm-todo-checked' : 'hm-todo', out)
        decorateListIndent(block, el, out)
        concealMarkersWithCaretPad(el, out)
        if (!rev) {
          const at = el.markers[0].from
          widget(
            el,
            at,
            listWidgetKey('chk', block, el, checked ? '1' : '0'),
            () => {
              const input = document.createElement('input')
              input.type = 'checkbox'
              input.className = 'hm-checkbox'
              input.checked = checked
              input.tabIndex = -1
              return input
            },
            out,
            -1,
          )
        }
        break
      }

      case 'bullet':
        nodeDeco(block, el, rev, 'hm-bullet', out)
        decorateListIndent(block, el, out)
        concealMarkersWithCaretPad(el, out)
        if (!rev) {
          const at = el.markers[0].from
          widget(
            el,
            at,
            listWidgetKey('dot', block, el),
            () => {
              const dot = document.createElement('span')
              dot.className = 'hm-bullet-dot'
              dot.textContent = '\u2022'
              return dot
            },
            out,
            -1,
          )
        }
        break

      case 'ordered': {
        // static：序号永远可见，只做弱化着色
        nodeDeco(block, el, false, 'hm-ordered', out)
        decorateListIndent(block, el, out)
        const m = el.markers[0]
        if (m && m.from < m.to) {
          out.push(
            Decoration.inline(m.from, m.to, { class: 'hm-list-num' }, spec(el, 'marker', false)),
          )
        }
        break
      }

      case 'hr':
        nodeDeco(block, el, rev, 'hm-hr-line', out)
        if (rev) {
          markerDecos(el, rev, out)
        } else {
          markerDecos(el, rev, out)
          widget(
            el,
            el.markers[0].from,
            `hr:${block.text}`,
            () => {
              const hr = document.createElement('hr')
              hr.className = 'hm-hr'
              return hr
            },
            out,
            -1,
          )
        }
        break

      case 'fenceOpen':
        fenceOpenDecos(block, el, rev, out)
        break

      case 'fenceClose':
        fenceCloseDecos(block, el, rev, out)
        break

      case 'codeLine':
        nodeDeco(block, el, false, 'hm-code-line', out)
        break

      // —— diagram block（Bear 的 Live Render 手感搬到块级） ——
      // Revealed（光标在围栏区域内）：与普通代码块一致 —— 源码 + 面板底色，
      //   编辑期间永远直面源码，不做"边打字边渲染"。
      // Concealed（光标离开区域）：整块源码隐藏（开行折叠成 widget 宿主，
      //   体行/闭行折叠为零高），在开行处渲染图表 widget；点击图表进入编辑
      //   （interactions 层把光标送回围栏行 → 立即 Revealed 回源码）。
      case 'diagramOpen': {
        if (!ctx?.renderDiagram) {
          fenceOpenDecos(block, el, rev, out)
          break
        }
        if (rev) {
          fenceOpenDecos(block, el, true, out)
          break
        }
        nodeDeco(block, el, false, 'hm-diagram-host', out)
        concealSpan(el, el.markers[0], out)
        const code = el.attrs?.code ?? ''
        const lang = el.attrs?.lang ?? ''
        const renderDiagram = ctx.renderDiagram
        widget(
          el,
          el.markers[0].from,
          `dg:${lang}\0${code}`,
          () => {
            const container = document.createElement('div')
            container.className = 'hm-diagram'
            container.setAttribute('data-lang', lang)
            if (!code.trim()) {
              container.classList.add('hm-diagram-empty')
              container.textContent = lang
            } else {
              renderDiagram(container, code, lang)
            }
            return container
          },
          out,
          -1,
        )
        break
      }

      case 'diagramLine':
        if (!ctx?.renderDiagram) {
          nodeDeco(block, el, false, 'hm-code-line', out)
        } else if (rev) {
          nodeDeco(block, el, true, 'hm-code-line', out)
        } else {
          nodeDeco(block, el, false, 'hm-diagram-hidden', out)
          concealSpan(el, el.markers[0], out)
        }
        break

      case 'diagramClose':
        if (!ctx?.renderDiagram || rev) {
          fenceCloseDecos(block, el, rev, out)
        } else {
          nodeDeco(block, el, false, 'hm-diagram-hidden', out)
          concealSpan(el, el.markers[0], out)
        }
        break

      case 'tableHeader':
      case 'tableRow': {
        const edge = el.attrs?.tableEdge
        const edgeCls =
          edge === 'first' ? ' hm-table-first' : edge === 'last' ? ' hm-table-last' : edge === 'only' ? ' hm-table-only' : ''
        const roleCls = el.kind === 'tableHeader' ? 'hm-table-header' : 'hm-table-row'
        if (rev) {
          // 源码态：显示管道表格文本，管道符弱化
          nodeDeco(block, el, true, `hm-table hm-table-source ${roleCls}${edgeCls}`, out)
          markerDecos(el, true, out)
        } else {
          // 渲染态：整行源码隐藏，用 widget 画真实列（可正确容纳链接等行内样式）
          nodeDeco(block, el, false, `hm-table hm-table-rendered ${roleCls}${edgeCls}`, out)
          const lineFrom = block.pos + 1
          const lineTo = block.pos + 1 + block.text.length
          concealSpan(el, { from: lineFrom, to: lineTo }, out)
          widget(
            el,
            lineFrom,
            `tr:${el.kind}\0${block.text}`,
            () => buildTableRowVisual(block, el.kind as 'tableHeader' | 'tableRow'),
            out,
            -1,
          )
        }
        break
      }

      case 'tableSep':
        // 分隔行整行隐藏，视觉上由表头加粗底边承担
        nodeDeco(block, el, rev, 'hm-table hm-table-sep', out)
        markerDecos(el, false, out)
        break

      case 'tableCell':
        // 列布局由 widget 承担；源码态无需再给 cell 套 flex class（会与 link deco 冲突）
        break
    }
  })

  return out
}
