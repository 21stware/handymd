/**
 * Performance metrics for conceal / parse hot paths.
 *
 * Run:
 *   bun test test/perf.test.ts
 *   # or from monorepo root:
 *   bun run bench
 *
 * ## Metrics (printed on each run)
 *
 * | Metric | Meaning |
 * |--------|---------|
 * | parseDoc_N | Full parse of N-line doc (ms, median of R runs) |
 * | parseInc_edit_N | Incremental parse after 1-char insert at doc start (ms) |
 * | parseInc_speedup | parseDoc / parseInc (higher = incremental wins more) |
 * | keystroke_N_K | K inserts at end of N-line doc through conceal plugin (ms total / per-key) |
 * | selection_N_K | K caret moves on N-line doc (ms total / per-move) |
 * | select_noop_N | Selection move that should reuse plugin state (ms) |
 *
 * ## Soft budgets (CI-safe)
 *
 * Thresholds are intentionally loose (machines vary). They catch regressions
 * that are 10×+ worse, not micro-optimizations. Tighten locally if needed.
 *
 * | Metric | Soft max |
 * |--------|----------|
 * | parseDoc 2k lines | ≤ 200 ms |
 * | parseInc after edit 2k | ≤ 200 ms (absolute; speedup is informational) |
 * | keystroke 1k lines × 30 | ≤ 3000 ms total (~100 ms/key) |
 * | selection 1k × 50 | ≤ 500 ms total |
 * | select_noop reuse | must reuse plugin state object |
 *
 * Note: on tiny absolute times (sub-ms parse), map overhead can make
 * incremental *slower* than full parse — that is expected. Gains show up
 * when lines carry heavy inline markup / when decoration map reuses DOM.
 */

import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { concealPlugin, concealKey } from '../src/conceal/plugin'
import { markdownToDoc } from '../src/markdown'
import { parseDoc, parseDocIncremental } from '../src/parse/docparse'

// ——— helpers ———

function linesDoc(n: number, richEvery = 5): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    if (i % richEvery === 0) out.push(`# H ${i} and **bold${i}** with [l](https://e.x/${i})`)
    else out.push(`plain line ${i} filler words for length`)
  }
  return out.join('\n')
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2
}

function timeMs(fn: () => void, runs = 5, warmup = 1): number {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function report(rows: { metric: string; value: string; budget?: string; ok?: boolean }[]) {
  // Readable table for local / CI logs
  console.log('\n—— handymd perf metrics ——')
  for (const r of rows) {
    const flag = r.ok === undefined ? '' : r.ok ? ' ✓' : ' ✗'
    const budget = r.budget ? `  (budget ${r.budget})` : ''
    console.log(`  ${r.metric.padEnd(28)} ${r.value.padStart(12)}${budget}${flag}`)
  }
  console.log('—— end perf metrics ——\n')
}

function endPos(state: EditorState): number {
  return state.doc.content.size
}

// ——— suite ———

describe('perf metrics (soft budgets)', () => {
  test('parseDoc vs parseDocIncremental on large doc', () => {
    const N = 2000
    const md = linesDoc(N)
    const doc = markdownToDoc(md)
    const prev = parseDoc(doc)

    const fullMs = timeMs(() => {
      parseDoc(doc)
    }, 7, 2)

    // Simulate edit at start without mutating the shared doc object repeatedly:
    // build edited doc once, measure incremental parse with a real mapping.
    let state = EditorState.create({ doc })
    const tr = state.tr.insertText('X', 1, 1)
    const nextDoc = tr.doc

    const incMs = timeMs(() => {
      parseDocIncremental(nextDoc, prev, tr.mapping)
    }, 7, 2)

    const fullEditMs = timeMs(() => {
      parseDoc(nextDoc)
    }, 7, 2)

    const speedup = fullEditMs / Math.max(incMs, 0.001)

    const budgetFull = 200
    const budgetInc = 200
    const okFull = fullMs <= budgetFull
    const okInc = incMs <= budgetInc
    // Only enforce speedup when full parse is expensive enough that map cost is noise
    const okSpeed = fullEditMs < 10 ? true : speedup >= 1.0

    report([
      { metric: `parseDoc_${N}`, value: `${fullMs.toFixed(2)} ms`, budget: `≤ ${budgetFull} ms`, ok: okFull },
      { metric: `parseDoc_edit_${N}`, value: `${fullEditMs.toFixed(2)} ms` },
      {
        metric: `parseInc_edit_${N}`,
        value: `${incMs.toFixed(2)} ms`,
        budget: `≤ ${budgetInc} ms`,
        ok: okInc,
      },
      {
        metric: 'parseInc_speedup',
        value: `${speedup.toFixed(2)}×`,
        budget: fullEditMs < 10 ? 'info only' : '≥ 1.0×',
        ok: okSpeed,
      },
    ])

    expect(okFull).toBe(true)
    expect(okInc).toBe(true)
    expect(okSpeed).toBe(true)
    // Correctness smoke: incremental equals full on this edit
    expect(parseDocIncremental(nextDoc, prev, tr.mapping).map((b) => b.text)).toEqual(
      parseDoc(nextDoc).map((b) => b.text),
    )
  })

  test('keystroke throughput through conceal plugin', () => {
    const N = 1000
    const K = 30
    const md = linesDoc(N)
    let state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin()],
    })
    // caret at end
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, endPos(state) - 1)))

    const t0 = performance.now()
    for (let i = 0; i < K; i++) {
      const pos = endPos(state) - 1
      state = state.apply(state.tr.insertText('x', pos, pos))
    }
    const total = performance.now() - t0
    const perKey = total / K

    const budgetTotal = 3000
    const ok = total <= budgetTotal

    report([
      {
        metric: `keystroke_${N}x${K}`,
        value: `${total.toFixed(1)} ms`,
        budget: `≤ ${budgetTotal} ms`,
        ok,
      },
      { metric: 'keystroke_per_key', value: `${perKey.toFixed(2)} ms` },
      {
        metric: 'keystroke_blocks',
        value: String(concealKey.getState(state)!.blocks.length),
      },
    ])

    expect(ok).toBe(true)
    expect(concealKey.getState(state)!.blocks.length).toBe(N)
  })

  test('selection-move throughput through conceal plugin', () => {
    const N = 1000
    const K = 50
    const md = linesDoc(N)
    let state = EditorState.create({
      doc: markdownToDoc(md),
      plugins: [concealPlugin()],
    })

    // Build a list of positions: walk through every 20th line start
    const positions: number[] = []
    let pos = 0
    state.doc.forEach((node, offset) => {
      if (positions.length >= K) return
      if (positions.length % 1 === 0) positions.push(offset + 1)
      pos = offset
    })
    while (positions.length < K) positions.push(1)

    const t0 = performance.now()
    for (let i = 0; i < K; i++) {
      const p = Math.min(positions[i % positions.length]!, state.doc.content.size)
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p)))
    }
    const total = performance.now() - t0
    const per = total / K
    const budgetTotal = 500
    const ok = total <= budgetTotal

    // No-op selection within same plain area
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    const before = concealKey.getState(state)!
    const t1 = performance.now()
    const afterState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
    const noopMs = performance.now() - t1
    const reused = Object.is(concealKey.getState(afterState), before)

    report([
      {
        metric: `selection_${N}x${K}`,
        value: `${total.toFixed(1)} ms`,
        budget: `≤ ${budgetTotal} ms`,
        ok,
      },
      { metric: 'selection_per_move', value: `${per.toFixed(2)} ms` },
      {
        metric: 'select_noop_reuse',
        value: reused ? 'yes' : 'no',
        budget: 'yes',
        ok: reused,
      },
      { metric: 'select_noop_ms', value: `${noopMs.toFixed(3)} ms` },
    ])

    expect(ok).toBe(true)
    expect(reused).toBe(true)
  })

  test('mixed workload snapshot (doc for dashboards)', () => {
    // Single combined print for CI log grepping / trend tracking
    const sizes = [200, 1000]
    const rows: { metric: string; value: string }[] = []

    for (const N of sizes) {
      const md = linesDoc(N)
      const doc = markdownToDoc(md)
      const parseMs = timeMs(() => parseDoc(doc), 5, 1)

      let state = EditorState.create({ doc, plugins: [concealPlugin()] })
      const t0 = performance.now()
      for (let i = 0; i < 10; i++) {
        const p = Math.max(1, endPos(state) - 1)
        state = state.apply(state.tr.insertText('.', p, p))
      }
      const keyMs = performance.now() - t0

      rows.push({ metric: `snapshot_parse_${N}`, value: `${parseMs.toFixed(2)} ms` })
      rows.push({ metric: `snapshot_10keys_${N}`, value: `${keyMs.toFixed(2)} ms` })
      rows.push({
        metric: `snapshot_10keys_${N}_avg`,
        value: `${(keyMs / 10).toFixed(2)} ms/key`,
      })
    }

    report(rows.map((r) => ({ ...r })))
    // Always pass — this test is a metrics export
    expect(rows.length).toBeGreaterThan(0)
  })
})
