/**
 * L3 状态机的"实例集合"数据结构。
 *
 * 每个 Markdown 元素解析为一个 ElementRange。注意：这里不存 Concealed/Revealed
 * 状态本身 —— 状态是每次事务后由 (doc, selection, composing, readOnly) 纯函数
 * 推导出来的（见 conceal/plugin.ts），ElementRange 只描述"范围与命中区间"。
 */

export interface Span {
  from: number
  to: number
}

export type InlineKind = 'strong' | 'em' | 'code' | 'strike' | 'link' | 'image' | 'tag'

export type BlockKind =
  | 'heading'
  | 'quote'
  | 'todo'
  | 'bullet'
  | 'ordered'
  | 'hr'
  | 'fenceOpen'
  | 'fenceClose'
  | 'codeLine'

export type ElementKind = InlineKind | BlockKind

export interface ElementAttrs {
  /** heading 级别 1-6 */
  level?: number
  /** todo 是否勾选 */
  checked?: boolean
  /** todo 勾选字符（` ` / `x`）在文档中的绝对位置 */
  checkPos?: number
  /** link / image 的目标 */
  href?: string
  /** image 的 alt 文本 */
  alt?: string
  /** 列表缩进（空格数） */
  indent?: number
  /** ordered 序号 */
  num?: number
  /** fence 的语言信息串 */
  info?: string
}

export interface ElementRange {
  kind: ElementKind
  /**
   * hitTest 粒度：inline 以字符范围相邻性触发，block 以光标所在块触发。
   */
  scope: 'inline' | 'block'
  /** 元素整体范围（绝对文档位置） */
  from: number
  to: number
  /**
   * cursorEnter/cursorLeave 的判定区间。
   * inline 元素为 [from-1, to+1]（扩一格判定，光标停在紧邻外侧即 reveal）；
   * block 元素为所在块的节点范围；fence 为整个代码块区域。
   */
  hitFrom: number
  hitTo: number
  /** 需要在 Concealed 态隐藏的标记符子范围 */
  markers: Span[]
  /** 语义内容范围（应用样式的部分） */
  content?: Span
  attrs?: ElementAttrs
  /**
   * static 元素的 decoration 与 conceal 状态无关（如 codeLine 的底色、
   * ordered 序号的弱化样式、#tag 的 pill），永远不参与 reveal 判定。
   */
  static?: boolean
  /**
   * permanent 元素永久 Concealed（Bear 的块级手感）：hr / bullet / quote /
   * todo / heading 一旦解析立即渲染，光标进入也不回到源码。标记符仍然
   * 存在于源码中（序列化无损），只是永远不显示。
   */
  permanent?: boolean
}

/** 相对坐标版本（供行内解析缓存复用，base=0），结构与 ElementRange 相同。 */
export type RelElement = Omit<ElementRange, 'hitFrom' | 'hitTo'>

export function spansIntersect(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && aTo >= bFrom
}
