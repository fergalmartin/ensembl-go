import assert from 'node:assert/strict'
import test from 'node:test'

import {
  powerGlyphMetrics,
  powerGlyphPaths,
  powerGlyphSvgMarkup,
} from '../src/utils/powerGlyph.js'

const numbersIn = (d) => d.match(/-?\d+(?:\.\d+)?/g).map(Number)

// ---------------------------------------------------------------------------
// powerGlyphMetrics

test('the stroked ink fills the box exactly at any size', () => {
  for (const size of [12, 14, 16, 20, 24, 32]) {
    const { stroke, radius, ringCenterY } = powerGlyphMetrics(size)
    const inkTop = ringCenterY - (1.3994 * radius) - (stroke / 2)
    const inkBottom = ringCenterY + radius + (stroke / 2)
    assert.ok(Math.abs(inkTop) < 0.01, `size ${size}: ink starts at ${inkTop}, not 0`)
    assert.ok(Math.abs(inkBottom - size) < 0.01, `size ${size}: ink ends at ${inkBottom}, not ${size}`)
  }
})

test('the ring stays inside the box horizontally', () => {
  for (const size of [12, 16, 24]) {
    const { stroke, radius, centerX } = powerGlyphMetrics(size)
    assert.ok(centerX - radius - (stroke / 2) >= -0.01)
    assert.ok(centerX + radius + (stroke / 2) <= size + 0.01)
  }
})

// The whole point of stroking rather than filling: the line weight no longer
// shrinks with the glyph, so the stem inside the ring keeps reading.
test('the stroke is held to a legible weight as the glyph shrinks', () => {
  assert.ok(powerGlyphMetrics(10).stroke >= 1.6)
  assert.ok(powerGlyphMetrics(8).stroke >= 1.6)
  assert.ok(powerGlyphMetrics(48).stroke <= 2.4)
})

test('the redrawn glyph is heavier than the filled asset it replaces', () => {
  // The asset's ring and stem are both 2.625 units wide in a 32-unit box.
  const assetStrokeAt = (size) => (2.625 / 32) * size
  for (const size of [14, 15, 16, 18]) {
    assert.ok(
      powerGlyphMetrics(size).stroke > assetStrokeAt(size) * 1.3,
      `size ${size} is not appreciably heavier than the asset`,
    )
  }
})

test('powerGlyphMetrics rejects a nonsensical size', () => {
  for (const bad of [0, -4, Number.NaN, undefined, null, 'big']) {
    assert.equal(powerGlyphMetrics(bad), null)
  }
})

// ---------------------------------------------------------------------------
// powerGlyphPaths

test('the ring is an arc and the stem a vertical line', () => {
  const { ring, stem } = powerGlyphPaths(16)
  assert.match(ring, /^M [\d.]+ [\d.]+ A [\d.]+ [\d.]+ 0 1 1 [\d.]+ [\d.]+$/)
  assert.match(stem, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/)

  const [x0, , x1] = numbersIn(stem)
  assert.equal(x0, x1, 'stem is not vertical')
})

test('the break in the ring sits at the top, centred on the stem', () => {
  const { centerX, ringCenterY } = powerGlyphMetrics(16)
  const [x0, y0, , , , , , x1, y1] = numbersIn(powerGlyphPaths(16).ring)

  // The two ends of the arc straddle the stem and sit above the ring's centre.
  assert.ok(y0 < ringCenterY && y1 < ringCenterY, 'arc does not break at the top')
  assert.ok(x0 > centerX && x1 < centerX, 'arc ends do not straddle the stem')
  assert.ok(Math.abs((x0 - centerX) - (centerX - x1)) < 0.01, 'break is not symmetric')
})

test('the stem overlaps the break rather than stopping at the ring', () => {
  const { radius, ringCenterY } = powerGlyphMetrics(16)
  const [, stemTop, , stemBottom] = numbersIn(powerGlyphPaths(16).stem)

  assert.ok(stemTop < ringCenterY - radius, 'stem should reach above the ring')
  assert.ok(stemBottom > ringCenterY - radius, 'stem should reach inside the ring')
  assert.ok(stemBottom < ringCenterY, 'stem should stop above the ring centre')
})

test('the paths scale with the box', () => {
  const small = numbersIn(powerGlyphPaths(16).ring)
  const large = numbersIn(powerGlyphPaths(32).ring)
  assert.equal(small.length, large.length)
  // Not an exact doubling — the stroke is clamped — but every point must grow.
  for (let i = 0; i < small.length; i += 1) {
    if (small[i] === 0 || small[i] === 1) continue
    assert.ok(large[i] > small[i], `coordinate ${i} did not grow`)
  }
})

test('powerGlyphPaths passes a bad size through as null', () => {
  assert.equal(powerGlyphPaths(0), null)
  assert.equal(powerGlyphPaths(Number.NaN), null)
})

// ---------------------------------------------------------------------------
// powerGlyphSvgMarkup

test('the SVG markup strokes both paths and never fills them', () => {
  const markup = powerGlyphSvgMarkup({ x: 40, y: 20, size: 16, color: '#3366cc' })
  assert.equal(markup.match(/<path /g).length, 2)
  assert.equal(markup.match(/fill="none"/g).length, 2)
  assert.ok(!markup.includes('fill="#'), 'glyph must be stroked, not filled')
  assert.ok(markup.includes('stroke="#3366cc"'))
  assert.ok(markup.includes('stroke-linecap="round"'))
})

test('the SVG markup centres the glyph on the given point', () => {
  const markup = powerGlyphSvgMarkup({ x: 40, y: 20, size: 16, color: '#000' })
  assert.ok(markup.includes('translate(32 12)'), markup.slice(0, 80))
})

test('powerGlyphSvgMarkup yields nothing for a bad size', () => {
  assert.equal(powerGlyphSvgMarkup({ x: 0, y: 0, size: 0, color: '#000' }), '')
})
