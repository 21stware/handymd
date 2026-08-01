import { describe, expect, test } from 'bun:test'
import { Autosave, type SaveStatus } from '../src/autosave'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Autosave (L4)', () => {
  test('Clean → Dirty → Saving → Clean via debounce', async () => {
    const calls: string[] = []
    const statuses: SaveStatus[] = []
    let src = 'v1'
    const as = new Autosave(() => src, {
      save: async (md) => {
        calls.push(md)
      },
      debounceMs: 10,
      listenOnline: false,
      onStatusChange: (s) => statuses.push(s),
    })
    expect(as.status).toBe('clean')
    as.markDirty()
    expect(as.status).toBe('dirty')
    src = 'v2'
    as.markDirty() // 重置防抖计时器
    await sleep(40)
    expect(calls).toEqual(['v2'])
    expect(as.status).toBe('clean')
    expect(statuses).toEqual(['dirty', 'saving', 'clean'])
    as.destroy()
  })

  test('input during save → save again immediately after', async () => {
    let resolveFirst!: () => void
    const calls: string[] = []
    let src = 'a'
    let first = true
    const as = new Autosave(() => src, {
      save: (md) => {
        calls.push(md)
        if (first) {
          first = false
          return new Promise<void>((r) => (resolveFirst = r))
        }
        return Promise.resolve()
      },
      debounceMs: 5,
      listenOnline: false,
    })
    as.markDirty()
    await sleep(15)
    expect(as.status).toBe('saving')
    src = 'b'
    as.markDirty() // 保存期间的输入
    resolveFirst()
    await sleep(15)
    expect(calls).toEqual(['a', 'b'])
    expect(as.status).toBe('clean')
    as.destroy()
  })

  test('failure → Retrying with backoff → Clean on success', async () => {
    let fails = 2
    const calls: string[] = []
    const statuses: SaveStatus[] = []
    const as = new Autosave(() => 'x', {
      save: async (md) => {
        calls.push(md)
        if (fails-- > 0) throw new Error('net down')
      },
      debounceMs: 5,
      backoffBaseMs: 5,
      maxRetries: 5,
      listenOnline: false,
      onStatusChange: (s) => statuses.push(s),
    })
    as.markDirty()
    await sleep(80)
    expect(calls.length).toBe(3)
    expect(as.status).toBe('clean')
    expect(statuses).toEqual(['dirty', 'saving', 'retrying', 'saving', 'retrying', 'saving', 'clean'])
    as.destroy()
  })

  test('exhausted retries → Offline; retryNow() recovers', async () => {
    let down = true
    const as = new Autosave(() => 'x', {
      save: async () => {
        if (down) throw new Error('offline')
      },
      debounceMs: 5,
      backoffBaseMs: 5,
      maxRetries: 1,
      listenOnline: false,
    })
    as.markDirty()
    await sleep(60)
    expect(as.status).toBe('offline')
    down = false
    as.retryNow()
    await sleep(20)
    expect(as.status).toBe('clean')
    as.destroy()
  })

  test('flush saves immediately without waiting for debounce', async () => {
    const calls: string[] = []
    const as = new Autosave(() => 'now', {
      save: async (md) => {
        calls.push(md)
      },
      debounceMs: 60_000,
      listenOnline: false,
    })
    as.markDirty()
    await as.flush()
    expect(calls).toEqual(['now'])
    expect(as.status).toBe('clean')
    as.destroy()
  })

  test('flush on clean resolves immediately', async () => {
    const as = new Autosave(() => '', { save: async () => {}, listenOnline: false })
    await as.flush()
    expect(as.status).toBe('clean')
    as.destroy()
  })
})
