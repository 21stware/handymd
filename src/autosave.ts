/**
 * L4 持久化状态机：
 *
 *   Clean → Dirty        : tr.docChanged（markDirty，重置防抖计时器）
 *   Dirty → Saving       : 防抖到期(默认 800ms) / flush（blur、Mod-s、unmount）
 *   Saving → Clean       : 保存成功且期间无新输入
 *   Saving → Saving      : 保存期间又有输入 → 完成后立即再存
 *   Saving → Retrying    : 网络失败，指数退避
 *   Retrying → Saving    : 退避到期重试
 *   Retrying → Offline   : 连续失败超过 maxRetries
 *   Offline → Saving     : retryNow()（编辑器会挂 window 'online' 事件自动触发）
 *
 * 序列化免费：文档模型即源码，getSource() 就是按行拼接。
 */

export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'retrying' | 'offline'

export interface AutosaveOptions {
  save: (markdown: string) => Promise<unknown> | unknown
  /** 防抖时长，默认 800ms */
  debounceMs?: number
  /** 进入 Offline 前的最大重试次数，默认 5 */
  maxRetries?: number
  /** 退避基数，默认 500ms（500, 1000, 2000, ...，封顶 backoffMaxMs） */
  backoffBaseMs?: number
  backoffMaxMs?: number
  onStatusChange?: (status: SaveStatus, error?: unknown) => void
  /** 是否监听 window 'online' 自动从 Offline 恢复，默认 true */
  listenOnline?: boolean
}

interface Waiter {
  resolve: () => void
  reject: (err: unknown) => void
}

export class Autosave {
  private statusValue: SaveStatus = 'clean'
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private dirtyDuringSave = false
  private inFlight = false
  private destroyed = false
  private waiters: Waiter[] = []
  private lastError: unknown = null
  private readonly onlineHandler: (() => void) | null = null

  private readonly getSource: () => string
  private readonly opts: Required<Omit<AutosaveOptions, 'onStatusChange' | 'listenOnline'>> &
    Pick<AutosaveOptions, 'onStatusChange'>

  constructor(getSource: () => string, options: AutosaveOptions) {
    this.getSource = getSource
    this.opts = {
      save: options.save,
      debounceMs: options.debounceMs ?? 800,
      maxRetries: options.maxRetries ?? 5,
      backoffBaseMs: options.backoffBaseMs ?? 500,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      onStatusChange: options.onStatusChange,
    }
    if ((options.listenOnline ?? true) && typeof window !== 'undefined' && window.addEventListener) {
      this.onlineHandler = () => this.retryNow()
      window.addEventListener('online', this.onlineHandler)
    }
  }

  get status(): SaveStatus {
    return this.statusValue
  }

  get error(): unknown {
    return this.lastError
  }

  private setStatus(status: SaveStatus, error?: unknown): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.opts.onStatusChange?.(status, error)
  }

  /** tr.docChanged → 置脏并重置防抖计时器 */
  markDirty(): void {
    if (this.destroyed) return
    if (this.inFlight) {
      this.dirtyDuringSave = true
      return
    }
    if (this.statusValue === 'offline' || this.statusValue === 'retrying') {
      // 离线/重试中继续输入：内容会在下次尝试时一并带上
      this.dirtyDuringSave = true
      return
    }
    this.setStatus('dirty')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, this.opts.debounceMs)
  }

  /** 手动标记为已保存（例如冲突解决选择了远端版本之后） */
  markClean(): void {
    if (this.destroyed) return
    this.clearTimers()
    this.dirtyDuringSave = false
    this.attempts = 0
    this.setStatus('clean')
    this.settleWaiters(null)
  }

  /** 立即保存（blur / Mod-s / unmount flush）。resolve 于回到 Clean。 */
  flush(): Promise<void> {
    if (this.destroyed || this.statusValue === 'clean') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      if (!this.inFlight) void this.run()
    })
  }

  /** Offline/Retrying → 立即重试（网络恢复时） */
  retryNow(): void {
    if (this.destroyed || this.inFlight) return
    if (this.statusValue !== 'offline' && this.statusValue !== 'retrying') return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.attempts = 0
    void this.run()
  }

  destroy(): void {
    this.destroyed = true
    this.clearTimers()
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler)
    }
    this.settleWaiters(new Error('autosave destroyed'))
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = null
    this.retryTimer = null
  }

  private settleWaiters(err: unknown): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) (err == null ? w.resolve() : w.reject(err))
  }

  private async run(): Promise<void> {
    if (this.destroyed || this.inFlight) return
    this.inFlight = true
    this.dirtyDuringSave = false
    this.setStatus('saving')
    const text = this.getSource()
    try {
      await this.opts.save(text)
      this.inFlight = false
      this.attempts = 0
      this.lastError = null
      if (this.destroyed) return
      if (this.dirtyDuringSave) {
        // 保存期间又有输入 → 立即再存
        void this.run()
      } else {
        this.setStatus('clean')
        this.settleWaiters(null)
      }
    } catch (err) {
      this.inFlight = false
      this.lastError = err
      if (this.destroyed) return
      this.attempts += 1
      if (this.attempts > this.opts.maxRetries) {
        this.setStatus('offline', err)
        this.settleWaiters(err)
        return
      }
      this.setStatus('retrying', err)
      const delay = Math.min(
        this.opts.backoffBaseMs * 2 ** (this.attempts - 1),
        this.opts.backoffMaxMs,
      )
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.run()
      }, delay)
    }
  }
}
