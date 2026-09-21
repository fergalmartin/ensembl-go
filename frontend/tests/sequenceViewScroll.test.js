import assert from 'node:assert/strict'
import test from 'node:test'

import {
  overscanRows,
  MAX_SCROLL_PX,
  createScrollModel,
  rowAtScrollTop,
  scrollTopForRow,
  visibleRowRange,
  wheelTargetRow,
} from '../src/utils/sequenceViewScroll.js'

const ROW_HEIGHT = 26
const VIEWPORT = 900

// A gene-sized region: well under the spacer cap, so nothing is compressed.
const gene = createScrollModel({ totalRows: 41_000, rowHeight: ROW_HEIGHT, viewportPx: VIEWPORT })
// Human chromosome 1, which is the case the cap exists for.
const chr1 = createScrollModel({ totalRows: 4_149_274, rowHeight: ROW_HEIGHT, viewportPx: VIEWPORT })

test('an ordinary region is not compressed at all', () => {
  assert.equal(gene.compression, 1)
  assert.equal(gene.spacerPx, 41_000 * ROW_HEIGHT)
  // With no compression the mapping is the plain one a normal list would use.
  assert.equal(scrollTopForRow(gene, 0), 0)
  assert.equal(scrollTopForRow(gene, 10), 10 * ROW_HEIGHT)
  assert.equal(scrollTopForRow(gene, 1234), 1234 * ROW_HEIGHT)
})

test('a chromosome is compressed, but the spacer stays inside what a browser allows', () => {
  assert.equal(chr1.spacerPx, MAX_SCROLL_PX)
  assert.ok(chr1.compression > 1, 'chr1 does not fit uncompressed')
  assert.ok(chr1.spacerPx <= MAX_SCROLL_PX)
})

test('a row survives the round trip through a scroll position', () => {
  for (const row of [0, 1, 0.5, 1000, 40_000, gene.maxAnchorRow]) {
    assert.ok(Math.abs(rowAtScrollTop(gene, scrollTopForRow(gene, row)) - row) < 1e-6)
  }
  // Under compression the round trip is still exact, because both directions
  // are expressed against the same pair of maxima.
  for (const row of [0, 1, 1234567.5, 4_000_000, chr1.maxAnchorRow]) {
    assert.ok(Math.abs(rowAtScrollTop(chr1, scrollTopForRow(chr1, row)) - row) < 1e-6)
  }
})

test('the end of the region is reachable, and nothing goes past it', () => {
  for (const model of [gene, chr1]) {
    const atBottom = rowAtScrollTop(model, model.maxScrollTop)
    assert.ok(Math.abs(atBottom - model.maxAnchorRow) < 1e-6)
    // The last row is on screen when the anchor is the last anchor row.
    assert.ok(model.maxAnchorRow + VIEWPORT / ROW_HEIGHT >= model.totalRows - 1e-6)
    // Overscrolling is clamped rather than extrapolated.
    assert.equal(rowAtScrollTop(model, model.maxScrollTop * 2), model.maxAnchorRow)
    assert.equal(rowAtScrollTop(model, -500), 0)
    assert.equal(scrollTopForRow(model, model.totalRows * 2), model.maxScrollTop)
    assert.equal(scrollTopForRow(model, -5), 0)
  }
})

test('the anchor row is fractional, so the sequence does not stick then jump', () => {
  const a = rowAtScrollTop(chr1, 1_000_000)
  const b = rowAtScrollTop(chr1, 1_000_001)
  assert.notEqual(a, b, 'one pixel of scrolling must move the anchor')
  assert.ok(!Number.isInteger(a) || !Number.isInteger(b))
})

test('a wheel notch moves the rows it would move with no compression', () => {
  // This is the whole point of intercepting the wheel: without it, a notch on
  // chr1 would jump the compression factor times as far.
  const from = 1_000_000
  const moved = wheelTargetRow(chr1, from, 100) - from
  assert.ok(Math.abs(moved - 100 / ROW_HEIGHT) < 1e-9)
  assert.ok(moved < 4, 'a notch is a few rows, not tens of them')

  assert.ok(Math.abs(wheelTargetRow(gene, 100, -260) - 90) < 1e-9, "scrolls back ten rows")
  assert.equal(wheelTargetRow(chr1, 0, -500), 0, 'clamped at the top')
  assert.equal(wheelTargetRow(chr1, chr1.maxAnchorRow, 5000), chr1.maxAnchorRow)
})

test('the mounted slab covers the viewport, with overscan either side', () => {
  const at = scrollTopForRow(gene, 100)
  const window = visibleRowRange(gene, at, 2)
  assert.equal(window.firstRow, 98)
  assert.ok(Math.abs(window.anchorRow - 100) < 1e-6)
  const onScreen = Math.ceil(VIEWPORT / ROW_HEIGHT) + 1
  assert.equal(window.count, onScreen + 4)
  // The slab is placed so that the anchor row lands at the top of the viewport.
  assert.ok(Math.abs(window.slabTopPx - (at - 2 * ROW_HEIGHT)) < 1e-6)
})

test('the slab does not run off either end of the region', () => {
  const top = visibleRowRange(gene, 0, 2)
  assert.equal(top.firstRow, 0)
  assert.equal(top.slabTopPx, 0)

  const bottom = visibleRowRange(gene, gene.maxScrollTop, 2)
  assert.equal(bottom.firstRow + bottom.count, gene.totalRows)
})

test('a region shorter than the viewport does not scroll', () => {
  const tiny = createScrollModel({ totalRows: 3, rowHeight: ROW_HEIGHT, viewportPx: VIEWPORT })
  assert.equal(tiny.maxScrollTop, 0)
  assert.equal(tiny.maxAnchorRow, 0)
  assert.equal(rowAtScrollTop(tiny, 500), 0)
  assert.equal(scrollTopForRow(tiny, 2), 0)
  const window = visibleRowRange(tiny, 0, 2)
  assert.equal(window.firstRow, 0)
  assert.equal(window.count, 3)
})

test('an empty region asks for no rows rather than failing', () => {
  const empty = createScrollModel({ totalRows: 0, rowHeight: ROW_HEIGHT, viewportPx: VIEWPORT })
  assert.deepEqual(visibleRowRange(empty, 0, 2), { firstRow: 0, count: 0, anchorRow: 0, slabTopPx: 0 })
  assert.equal(rowAtScrollTop(empty, 100), 0)
  assert.equal(createScrollModel().totalRows, 0)
})

test('a taller row changes the geometry without changing the mapping', () => {
  // What happens when the protein track is switched on: every row grows by the
  // same amount, so the scroller still only has to multiply.
  const withTrack = createScrollModel({ totalRows: 41_000, rowHeight: 44, viewportPx: VIEWPORT })
  assert.equal(withTrack.compression, 1)
  assert.equal(scrollTopForRow(withTrack, 10), 440)
  assert.ok(Math.abs(rowAtScrollTop(withTrack, scrollTopForRow(withTrack, 777)) - 777) < 1e-6)
})

test('the margin either side is a share of the screen, not a fixed few rows', () => {
  // It was three rows whatever the screen held: a third of a second of
  // unhurried scrolling at full size, and a fortieth of one zoomed out, where a
  // row is two pixels and a screen holds two hundred and fifty.
  assert.ok(overscanRows(30) > 3)
  assert.ok(overscanRows(60) > overscanRows(20))
  // A bigger share where the rows are cheap to draw -- the far view is
  // rectangles on a canvas rather than an element per base, and what is placed
  // is also what is asked for.
  assert.ok(overscanRows(250, { cheap: true }) > overscanRows(250))
})

test('the margin is bounded at both ends, however big or small the screen', () => {
  // Never nothing, so there is always a row placed past the edge.
  assert.ok(overscanRows(0) >= 3)
  assert.ok(overscanRows(1) >= 3)
  // Never so many that the readable view is placing hundreds of rows of
  // elements nobody can see.
  assert.ok(overscanRows(10_000) <= 12)
  assert.ok(overscanRows(10_000, { cheap: true }) <= 160)
  // Nonsense reads as an empty screen rather than as a negative margin.
  assert.ok(overscanRows(NaN) >= 3)
  assert.ok(overscanRows(-50) >= 3)
})
