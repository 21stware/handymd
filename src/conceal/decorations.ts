import { Decoration } from 'prosemirror-view'
import type { ElementRange, Span } from '../elements'
import type { BlockMeta } from '../parse/docparse'

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

function nodeDeco(block: BlockMeta, el: ElementRange, revealed: boolean, cls: string, out: Decoration[]): void {
  out.push(
    Decoration.node(block.pos, block.pos + block.size, { class: cls }, spec(el, 'node', !revealed)),
  )
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

export function buildBlockDecos(block: BlockMeta, revealed: readonly boolean[]): Decoration[] {
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
            `img:${el.from}:${href}`,
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
        // 空标题（只有前缀）保留末尾空格为 caret-pad，避免 font-size:0 导致光标消失。
        const level = el.attrs?.level ?? 1
        const empty = !el.content || el.content.from >= el.content.to
        nodeDeco(block, el, rev, `hm-heading hm-h${level}${empty ? ' hm-heading-empty' : ''}`, out)
        for (const m of el.markers) {
          if (m.from >= m.to) continue
          if (empty && m.to - m.from >= 2) {
            // 隐藏 `#`/`##`，保留末尾空格给光标落脚
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
              Decoration.inline(
                m.from,
                m.to,
                { class: 'hm-marker hm-concealed' },
                spec(el, 'marker', true),
              ),
            )
          }
        }
        if (rev) {
          const at = el.markers[0].to
          widget(
            el,
            at,
            `hb:${at}:${level}`,
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
        markerDecos(el, rev, out)
        break

      case 'todo': {
        const checked = el.attrs?.checked ?? false
        nodeDeco(block, el, rev, checked ? 'hm-todo hm-todo-checked' : 'hm-todo', out)
        markerDecos(el, rev, out)
        if (!rev) {
          const at = el.markers[0].from
          widget(
            el,
            at,
            `chk:${at}:${checked}`,
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
        markerDecos(el, rev, out)
        if (!rev) {
          const at = el.markers[0].from
          widget(
            el,
            at,
            `dot:${at}`,
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
            `hr:${el.from}`,
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

      case 'fenceOpen': {
        nodeDeco(block, el, rev, 'hm-fence-line hm-fence-open', out)
        markerDecos(el, rev, out)
        const info = el.attrs?.info
        if (!rev && info) {
          widget(
            el,
            el.markers[0].from,
            `lang:${el.from}:${info}`,
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
        break
      }

      case 'fenceClose':
        nodeDeco(block, el, rev, 'hm-fence-line hm-fence-close', out)
        markerDecos(el, rev, out)
        break

      case 'codeLine':
        nodeDeco(block, el, false, 'hm-code-line', out)
        break
    }
  })

  return out
}
