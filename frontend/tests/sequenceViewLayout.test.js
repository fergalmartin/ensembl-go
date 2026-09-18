import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASES_PER_ROW,
  GUTTER_WIDTH,
  MAX_CELL_WIDTH,
  MIN_CELL_WIDTH,
  MIN_ROW_WIDTH,
  rowHeightFor,
  rowMetrics,
} from '../src/components/sequence-view/sequenceViewLayout.js'

test('every row is the same height, and a track adds to all of them', () => {
  // The rule the virtual scroller depends on: one height, not one per row.
  assert.equal(rowHeightFor({}), rowHeightFor({ protein: false }))
  assert.ok(rowHeightFor({ protein: true }) > rowHeightFor({}))
})

test('a row is made to fit the width it is given', () => {
  const wide = rowMetrics(1400)
  assert.ok(wide.fits)
  assert.ok(wide.rowWidth <= 1400)
  const narrow = rowMetrics(900)
  assert.ok(narrow.fits)
  assert.ok(narrow.rowWidth <= 900)
  assert.ok(narrow.cellWidth < wide.cellWidth, 'less room means smaller cells')
})

test('cells never grow past the point where a row stops reading as sequence', () => {
  assert.equal(rowMetrics(5000).cellWidth, MAX_CELL_WIDTH)
  assert.equal(rowMetrics(100_000).cellWidth, MAX_CELL_WIDTH)
})

test('cells never shrink past the point where a base stops being legible', () => {
  const cramped = rowMetrics(300)
  assert.equal(cramped.cellWidth, MIN_CELL_WIDTH)
  // Below that there is no width that works, and it says so rather than
  // pretending by making the sequence unreadable.
  assert.equal(cramped.fits, false)
})

test('the row width is always the gutters plus sixty cells', () => {
  for (const available of [700, 900, 1024, 1280, 1600, 2400]) {
    const m = rowMetrics(available)
    assert.equal(m.rowWidth, GUTTER_WIDTH * 2 + m.cellWidth * BASES_PER_ROW)
  }
})

test('room is left for the scrollbar, so fitting sideways does not cost a scrollbar', () => {
  // Without the allowance the row would be exactly as wide as the space, and the
  // vertical scrollbar would push it into a horizontal one.
  const m = rowMetrics(1000, 12)
  assert.ok(m.rowWidth <= 1000 - 12)
  assert.ok(rowMetrics(1000, 0).rowWidth >= m.rowWidth)
})

test('giving the panel width back grows the cells', () => {
  // What collapsing the drawer does: the same region, more room, bigger bases.
  const withPanel = rowMetrics(1100)
  const collapsed = rowMetrics(1100 + 300 - 36)
  assert.ok(collapsed.cellWidth >= withPanel.cellWidth)
  assert.ok(collapsed.rowWidth >= withPanel.rowWidth)
})

test('the letter stays inside the cell at every width', () => {
  // A monospace glyph advances about 0.6 of its em, so it is that -- not the
  // font size itself -- that has to fit the cell.
  const MONO_ADVANCE = 0.6
  for (const available of [700, 900, 1200, 2000]) {
    const m = rowMetrics(available)
    assert.ok(
      m.fontSize * MONO_ADVANCE <= m.cellWidth,
      `${m.fontSize}px advances ${(m.fontSize * MONO_ADVANCE).toFixed(1)}px, cell is ${m.cellWidth}px`,
    )
    assert.ok(m.fontSize >= 9, 'and stays legible')
  }
})

test('a width of nothing does not produce a broken row', () => {
  const m = rowMetrics(0)
  assert.equal(m.cellWidth, MIN_CELL_WIDTH)
  assert.equal(m.rowWidth, MIN_ROW_WIDTH)
  assert.equal(rowMetrics(undefined).cellWidth, MIN_CELL_WIDTH)
})
