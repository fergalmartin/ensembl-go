import assert from 'node:assert/strict'
import test from 'node:test'

import { createHeightIndex, mergeRowRuns } from '../src/utils/sequenceViewHeights.js'
import {
  createScrollModel,
  rowAtScrollTop,
  rowHasLane,
  rowHeightAt,
  scrollTopForRow,
  visibleRowRange,
  wheelTargetRow,
} from '../src/utils/sequenceViewScroll.js'

const BASE = 26
const LANE = 18

test('runs come back ordered, clipped and joined', () => {
  assert.deepEqual(mergeRowRuns([{ from: 5, to: 7 }, { from: 1, to: 2 }], 100),
    [{ from: 1, to: 2 }, { from: 5, to: 7 }])
  // Adjacent runs are one run: there is no short row between them.
  assert.deepEqual(mergeRowRuns([{ from: 1, to: 3 }, { from: 4, to: 6 }], 100),
    [{ from: 1, to: 6 }])
  assert.deepEqual(mergeRowRuns([{ from: 1, to: 3 }, { from: 2, to: 9 }], 100),
    [{ from: 1, to: 9 }])
  assert.deepEqual(mergeRowRuns([{ from: 8, to: 40 }], 10), [{ from: 8, to: 9 }],
    'and never past the end of the document')
  assert.deepEqual(mergeRowRuns([{ from: 4, to: 1 }], 100), [], 'a backwards run is not a run')
})

// ---- the uniform case is the same arithmetic it always was -----------------

test('with no lanes the index is a multiply and a divide', () => {
  const index = createHeightIndex({ totalRows: 100, rowHeight: BASE, laneHeight: LANE })
  assert.equal(index.uniform, true)
  assert.equal(index.contentPx, 100 * BASE)
  for (const row of [0, 1, 17, 99.5]) {
    assert.equal(index.offsetOfRow(row), row * BASE)
    assert.equal(index.rowAtOffset(row * BASE), row)
  }
  assert.equal(index.heightOfRow(3), BASE)
  assert.equal(index.isTall(3), false)
})

test('laneHeight of zero is no lanes at all, whatever the runs say', () => {
  const index = createHeightIndex({
    totalRows: 10, rowHeight: BASE, laneHeight: 0, runs: [{ from: 2, to: 4 }],
  })
  assert.equal(index.uniform, true)
  assert.equal(index.contentPx, 10 * BASE)
})

// ---- and with lanes --------------------------------------------------------

test('only the rows in a run are taller', () => {
  const index = createHeightIndex({
    totalRows: 10, rowHeight: BASE, laneHeight: LANE, runs: [{ from: 2, to: 3 }],
  })
  assert.equal(index.uniform, false)
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => index.isTall(r)), [false, false, true, true, false])
  assert.equal(index.heightOfRow(2), BASE + LANE)
  assert.equal(index.heightOfRow(4), BASE)
  assert.equal(index.contentPx, 10 * BASE + 2 * LANE)
})

test('a row begins where the rows above it end', () => {
  const index = createHeightIndex({
    totalRows: 10, rowHeight: BASE, laneHeight: LANE, runs: [{ from: 2, to: 3 }],
  })
  assert.equal(index.offsetOfRow(0), 0)
  assert.equal(index.offsetOfRow(2), 2 * BASE)
  assert.equal(index.offsetOfRow(3), 2 * BASE + (BASE + LANE))
  assert.equal(index.offsetOfRow(4), 2 * BASE + 2 * (BASE + LANE))
  assert.equal(index.offsetOfRow(10), index.contentPx)
  // Half way down a tall row is half of the tall height, not half of the base.
  assert.equal(index.offsetOfRow(2.5), 2 * BASE + (BASE + LANE) / 2)
})

test('a row survives the round trip through a pixel offset', () => {
  const index = createHeightIndex({
    totalRows: 40, rowHeight: BASE, laneHeight: LANE,
    runs: [{ from: 3, to: 5 }, { from: 20, to: 20 }, { from: 30, to: 39 }],
  })
  for (const row of [0, 2.5, 3, 4.25, 6, 19.75, 20, 21, 30, 39.5]) {
    const back = index.rowAtOffset(index.offsetOfRow(row))
    assert.ok(Math.abs(back - row) < 1e-9, `${row} came back as ${back}`)
  }
})

test('the offsets only ever rise', () => {
  const index = createHeightIndex({
    totalRows: 30, rowHeight: BASE, laneHeight: LANE,
    runs: [{ from: 4, to: 6 }, { from: 11, to: 12 }],
  })
  let previous = -1
  for (let row = 0; row <= 30; row += 0.25) {
    const offset = index.offsetOfRow(row)
    assert.ok(offset > previous, `row ${row} did not move forward`)
    previous = offset
  }
})

// ---- what the scroller makes of it ----------------------------------------

test('the scroll model is unchanged where there are no lanes', () => {
  const plain = createScrollModel({ totalRows: 500, rowHeight: BASE, viewportPx: 600 })
  const withLanes = createScrollModel({
    totalRows: 500, rowHeight: BASE, viewportPx: 600, laneHeight: LANE, laneRows: [],
  })
  for (const model of [plain, withLanes]) {
    assert.equal(model.contentPx, 500 * BASE)
    assert.equal(model.maxAnchorRow, 500 - 600 / BASE)
    assert.equal(rowAtScrollTop(model, 260), 10)
    assert.equal(scrollTopForRow(model, 10), 260)
    assert.equal(rowHeightAt(model, 4), BASE)
    assert.equal(rowHasLane(model, 4), false)
  }
})

test('a compressed chromosome answers exactly as it did before lanes existed', () => {
  // The formula this replaced, kept here as the thing to agree with: the
  // compressed path is the one case where the arithmetic is a proportion rather
  // than a division, and it must not have moved.
  const rows = 4_149_274
  const model = createScrollModel({ totalRows: rows, rowHeight: BASE, viewportPx: 800 })
  assert.ok(model.compression > 1, 'a whole chromosome is compressed')
  for (const at of [0, 1, 1000, model.maxScrollTop / 2, model.maxScrollTop]) {
    const expected = (at / model.maxScrollTop) * model.maxAnchorRow
    assert.ok(Math.abs(rowAtScrollTop(model, at) - expected) < 1e-6)
  }
  for (const row of [0, 1000, model.maxAnchorRow]) {
    const expected = (row / model.maxAnchorRow) * model.maxScrollTop
    assert.ok(Math.abs(scrollTopForRow(model, row) - expected) < 1e-3)
  }
})

test('a lane changes where a row sits, and the last row stays reachable', () => {
  const model = createScrollModel({
    totalRows: 100, rowHeight: BASE, viewportPx: 200,
    laneHeight: LANE, laneRows: [{ from: 0, to: 9 }],
  })
  assert.equal(model.contentPx, 100 * BASE + 10 * LANE)
  // Row 10 sits below ten tall rows rather than ten short ones.
  assert.equal(scrollTopForRow(model, 10), 10 * (BASE + LANE))
  assert.equal(rowHeightAt(model, 0), BASE + LANE)
  assert.equal(rowHeightAt(model, 10), BASE)
  assert.equal(rowHasLane(model, 0), true)
  // The bottom of the document is exactly one viewport past the anchor.
  assert.ok(Math.abs(
    scrollTopForRow(model, model.maxAnchorRow) + model.viewportPx - model.contentPx,
  ) < 1e-6)
})

test('the slab is placed in pixels, not in rows of one height', () => {
  const model = createScrollModel({
    totalRows: 100, rowHeight: BASE, viewportPx: 200,
    laneHeight: LANE, laneRows: [{ from: 0, to: 19 }],
  })
  const at = scrollTopForRow(model, 12)
  const window_ = visibleRowRange(model, at, 3)
  assert.equal(window_.firstRow, 9)
  // The slab starts three tall rows above the anchor, which is 3 * (26 + 18).
  assert.ok(Math.abs(window_.slabTopPx - (at - 3 * (BASE + LANE))) < 1e-6)
})

test('a wheel notch moves the content the distance it was given', () => {
  const model = createScrollModel({
    totalRows: 100, rowHeight: BASE, viewportPx: 200,
    laneHeight: LANE, laneRows: [{ from: 0, to: 49 }],
  })
  // Over tall rows a 100 px notch is fewer rows than over short ones, which is
  // the point: the reader asked for a distance, not for a row count.
  const overTall = wheelTargetRow(model, 0, 100)
  assert.ok(Math.abs(overTall - 100 / (BASE + LANE)) < 1e-9)
  const overShort = wheelTargetRow(model, 60, 100)
  assert.ok(Math.abs(overShort - (60 + 100 / BASE)) < 1e-9)
})
