import type { ElementRange } from '../elements'
import { spansIntersect } from '../elements'

export interface SelLike {
  from: number
  to: number
}

/**
 * L3 状态机的转移条件，编码为纯函数：
 *
 *   Concealed --cursorEnter--> Revealed : selection 与 [hitFrom, hitTo] 相交
 *   Revealed --cursorLeave--> Concealed : selection 完全离开（且非 composition 中，
 *                                          composition 冻结在 plugin.apply 层实现）
 *
 * inline 元素的 hit 区间是 [from-1, to+1]（扩一格判定）；fence 是整个代码块
 * 区域；static / permanent 元素永远不 reveal（块级前缀一旦渲染就不再回到
 * 源码 —— Bear 的手感）；readOnly 强制全部 Concealed。
 */
export function isRevealed(el: ElementRange, sel: SelLike, readOnly: boolean): boolean {
  if (el.static || el.permanent) return false
  if (readOnly) return false
  return spansIntersect(sel.from, sel.to, el.hitFrom, el.hitTo)
}

/** 一个块的 reveal 签名：只有签名变化的块才需要重建 decoration。 */
export function revealSignature(revealed: readonly boolean[]): string {
  let sig = ''
  for (const r of revealed) sig += r ? '1' : '0'
  return sig
}
