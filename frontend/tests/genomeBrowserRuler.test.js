import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_TICK_INTERVAL_BP,
  MONO_ADVANCE_RATIO,
  RULER_FONT_SIZE,
  RULER_HEIGHT,
  RULER_LABEL_BASELINE_INSET,
  RULER_LABEL_CLEARANCE,
  RULER_LABEL_GAP,
  chooseRulerTickInterval,
  estimateMonoTextWidth,
  formatRulerCoord,
  rulerGeometry,
  rulerTicks,
} from '../src/components/genomeBrowserRuler.js'

// ---------------------------------------------------------------------------
// formatRulerCoord

test('formatRulerCoord groups thousands the way the site does', () => {
  assert.equal(formatRulerCoord(31532331), '31,532,331')
  assert.equal(formatRulerCoord(1000), '1,000')
  assert.equal(formatRulerCoord(42), '42')
})

test('formatRulerCoord rounds fractional coordinates', () => {
  assert.equal(formatRulerCoord(1000.4), '1,000')
  assert.equal(formatRulerCoord(1000.6), '1,001')
})

test('formatRulerCoord degrades to an em dash for non-numbers', () => {
  assert.equal(formatRulerCoord(Number.NaN), '—')
  assert.equal(formatRulerCoord(undefined), '—')
  assert.equal(formatRulerCoord('not a coordinate'), '—')
})

// ---------------------------------------------------------------------------
// estimateMonoTextWidth

test('estimateMonoTextWidth scales with character count and font size', () => {
  assert.equal(estimateMonoTextWidth('12345', 12), 5 * 12 * MONO_ADVANCE_RATIO)
  assert.equal(estimateMonoTextWidth('12345', 10), 5 * 10 * MONO_ADVANCE_RATIO)
  assert.equal(estimateMonoTextWidth('', 12), 0)
})

test('estimateMonoTextWidth is zero for a nonsensical size', () => {
  assert.equal(estimateMonoTextWidth('12345', 0), 0)
  assert.equal(estimateMonoTextWidth('12345', -4), 0)
  assert.equal(estimateMonoTextWidth('12345', Number.NaN), 0)
})

// ---------------------------------------------------------------------------
// chooseRulerTickInterval

test('chooseRulerTickInterval only ever returns 1, 2 or 5 times a power of ten', () => {
  for (let span = 100; span <= 1e8; span *= 1.7) {
    const interval = chooseRulerTickInterval({ spanBp: span, widthPx: 1200, maxCoord: span })
    const magnitude = 10 ** Math.floor(Math.log10(interval))
    assert.ok(
      [1, 2, 5].includes(Math.round(interval / magnitude)),
      `${interval} is not a round interval for span ${span}`,
    )
  }
})

test('chooseRulerTickInterval leaves room for a whole label between ticks', () => {
  const widthPx = 1200
  for (const spanBp of [1e3, 5e3, 3.5e4, 1e6, 2.4e7, 1e8]) {
    const maxCoord = 31532331
    const interval = chooseRulerTickInterval({ spanBp, widthPx, maxCoord })
    const spacingPx = (interval / spanBp) * widthPx
    const needed = estimateMonoTextWidth(formatRulerCoord(maxCoord), RULER_FONT_SIZE)
      + RULER_LABEL_GAP
      + RULER_LABEL_CLEARANCE
    assert.ok(
      spacingPx >= needed || interval === MIN_TICK_INTERVAL_BP,
      `span ${spanBp} gave ${spacingPx.toFixed(1)}px spacing, needs ${needed.toFixed(1)}px`,
    )
  }
})

test('chooseRulerTickInterval widens the interval for wider coordinates', () => {
  const narrow = chooseRulerTickInterval({ spanBp: 1e6, widthPx: 1200, maxCoord: 900 })
  const wide = chooseRulerTickInterval({ spanBp: 1e6, widthPx: 1200, maxCoord: 248956422 })
  assert.ok(wide >= narrow)
})

test('chooseRulerTickInterval tightens the interval as the viewport widens', () => {
  const cramped = chooseRulerTickInterval({ spanBp: 1e6, widthPx: 400, maxCoord: 31532331 })
  const roomy = chooseRulerTickInterval({ spanBp: 1e6, widthPx: 2400, maxCoord: 31532331 })
  assert.ok(roomy <= cramped)
})

test('chooseRulerTickInterval never goes below the base-pair floor', () => {
  assert.equal(chooseRulerTickInterval({ spanBp: 40, widthPx: 1200, maxCoord: 40 }), MIN_TICK_INTERVAL_BP)
  assert.equal(chooseRulerTickInterval({ spanBp: 1, widthPx: 1200, maxCoord: 1 }), MIN_TICK_INTERVAL_BP)
})

test('chooseRulerTickInterval survives degenerate inputs', () => {
  assert.equal(chooseRulerTickInterval({ spanBp: 0, widthPx: 1200 }), MIN_TICK_INTERVAL_BP)
  assert.equal(chooseRulerTickInterval({ spanBp: -10, widthPx: 1200 }), MIN_TICK_INTERVAL_BP)
  assert.equal(chooseRulerTickInterval({ spanBp: 1e6, widthPx: 0 }), MIN_TICK_INTERVAL_BP)
  assert.equal(chooseRulerTickInterval({ spanBp: Number.NaN, widthPx: Number.NaN }), MIN_TICK_INTERVAL_BP)
})

// ---------------------------------------------------------------------------
// rulerTicks

test('rulerTicks lands on multiples of the chosen interval', () => {
  const { interval, ticks } = rulerTicks({ start: 31515675, end: 31550653, widthPx: 1200 })
  assert.ok(ticks.length > 0)
  for (const tick of ticks) {
    assert.equal(tick % interval, 0, `${tick} is not a multiple of ${interval}`)
  }
})

test('rulerTicks includes one tick before the view so its label bleeds in', () => {
  const start = 31515675
  const { interval, ticks } = rulerTicks({ start, end: 31550653, widthPx: 1200 })
  assert.ok(ticks[0] < start, 'expected a leading off-screen tick')
  assert.ok(ticks[1] >= start, 'expected only one tick before the view')
  assert.equal(ticks[0] + interval, ticks[1])
})

test('rulerTicks covers the view without running past its end', () => {
  const end = 31550653
  const { interval, ticks } = rulerTicks({ start: 31515675, end, widthPx: 1200 })
  const last = ticks[ticks.length - 1]
  assert.ok(last <= end)
  assert.ok(last + interval > end)
})

test('rulerTicks drops coordinates before the start of the sequence', () => {
  const { ticks } = rulerTicks({ start: 1, end: 40000, widthPx: 1200 })
  assert.ok(ticks.every((tick) => tick >= 1))
})

test('rulerTicks returns nothing for an empty or inverted range', () => {
  assert.deepEqual(rulerTicks({ start: 100, end: 100, widthPx: 1200 }).ticks, [])
  assert.deepEqual(rulerTicks({ start: 500, end: 100, widthPx: 1200 }).ticks, [])
  assert.deepEqual(rulerTicks({ start: Number.NaN, end: 100, widthPx: 1200 }).ticks, [])
})

test('rulerTicks stays bounded on a whole-chromosome view', () => {
  const { ticks } = rulerTicks({ start: 1, end: 248956422, widthPx: 1200 })
  assert.ok(ticks.length > 0)
  assert.ok(ticks.length <= 512)
})

// ---------------------------------------------------------------------------
// rulerGeometry

test('rulerGeometry hangs ticks onto a closing rule when the ruler is on top', () => {
  const g = rulerGeometry({ top: 0, height: RULER_HEIGHT, position: 'top' })
  assert.equal(g.ruleY, RULER_HEIGHT - 1)
  assert.equal(g.tickStart, 0)
  assert.equal(g.tickEnd, g.ruleY)
  assert.equal(g.labelBaseline, g.ruleY - RULER_LABEL_BASELINE_INSET)
})

test('rulerGeometry mirrors the band when the ruler is on the bottom', () => {
  const top = 200
  const g = rulerGeometry({ top, height: RULER_HEIGHT, position: 'bottom' })
  assert.equal(g.ruleY, top)
  assert.equal(g.tickStart, top)
  assert.equal(g.tickEnd, top + RULER_HEIGHT)
  assert.ok(g.labelBaseline > g.ruleY)
  assert.ok(g.labelBaseline <= top + RULER_HEIGHT)
})

test('rulerGeometry keeps labels inside the band in both orientations', () => {
  for (const position of ['top', 'bottom']) {
    const g = rulerGeometry({ top: 50, height: RULER_HEIGHT, position })
    const ascenderTop = g.labelBaseline - RULER_FONT_SIZE
    assert.ok(ascenderTop >= 50 - 1, `${position} label overflows the top of the band`)
    assert.ok(g.labelBaseline <= 50 + RULER_HEIGHT, `${position} label overflows the bottom of the band`)
  }
})

test('rulerGeometry offsets everything by the band top', () => {
  const a = rulerGeometry({ top: 0, height: RULER_HEIGHT, position: 'top' })
  const b = rulerGeometry({ top: 120, height: RULER_HEIGHT, position: 'top' })
  assert.equal(b.ruleY - a.ruleY, 120)
  assert.equal(b.labelBaseline - a.labelBaseline, 120)
  assert.equal(b.tickStart - a.tickStart, 120)
})

test('rulerGeometry falls back to the default height for bad input', () => {
  const g = rulerGeometry({ top: 0, height: 0, position: 'top' })
  assert.equal(g.bandHeight, RULER_HEIGHT)
  assert.equal(rulerGeometry().bandHeight, RULER_HEIGHT)
})
