import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASES_PER_ROW,
  coordAtRowOffset,
  regionSpan,
  rowAtCoord,
  rowGutterLabels,
  rowRange,
  rowsForRange,
  totalRows,
} from '../src/utils/sequenceViewRows.js'

test('a region span is ordered, inclusive of both ends and never empty', () => {
  assert.deepEqual(regionSpan({ start: 101, end: 200 }), { start: 101, end: 200, length: 100 })
  assert.deepEqual(regionSpan({ start: 200, end: 101 }), { start: 101, end: 200, length: 100 })
  assert.deepEqual(regionSpan({ start: 50, end: 50 }), { start: 50, end: 50, length: 1 })
  assert.equal(regionSpan({ start: 'x', end: 1 }), null)
  assert.equal(regionSpan(null), null)
})

test('a region always fills at least one row, and a partial row counts', () => {
  assert.equal(totalRows({ start: 1, end: 60 }), 1)
  assert.equal(totalRows({ start: 1, end: 61 }), 2)
  assert.equal(totalRows({ start: 1, end: 1 }), 1)
  assert.equal(totalRows({ start: 1, end: 600 }), 10)
  assert.equal(totalRows(null), 0)
})

test('the last row is clipped to the region rather than padded out to 60', () => {
  const region = { start: 1000, end: 1100 } // 101 bases: one full row, then 41
  assert.deepEqual(rowRange(region, 0), { index: 0, start: 1000, end: 1059, length: 60 })
  assert.deepEqual(rowRange(region, 1), { index: 1, start: 1060, end: 1100, length: 41 })
  assert.equal(rowRange(region, 2), null)
  assert.equal(rowRange(region, -1), null)
})

test('a single-base region is one row of one base', () => {
  const region = { start: 7, end: 7 }
  assert.deepEqual(rowRange(region, 0), { index: 0, start: 7, end: 7, length: 1 })
  assert.deepEqual(rowGutterLabels(region, 0), { left: 7, right: 7 })
})

test('reverse reading starts at the far end of the region', () => {
  const region = { start: 1000, end: 1100 }
  // Row 0 is the last 60 bases; the short row falls at the other end.
  assert.deepEqual(rowRange(region, 0, true), { index: 0, start: 1041, end: 1100, length: 60 })
  assert.deepEqual(rowRange(region, 1, true), { index: 1, start: 1000, end: 1040, length: 41 })
  assert.equal(rowRange(region, 2, true), null)
})

test('gutter numbers follow the reading direction but stay genomic', () => {
  const region = { start: 1000, end: 1100 }
  assert.deepEqual(rowGutterLabels(region, 0), { left: 1000, right: 1059 })
  assert.deepEqual(rowGutterLabels(region, 0, true), { left: 1100, right: 1041 })
  assert.deepEqual(rowGutterLabels(region, 1, true), { left: 1040, right: 1000 })
})

test('a coordinate maps to the row that holds it, either direction', () => {
  const region = { start: 1000, end: 1100 }
  assert.equal(rowAtCoord(region, 1000), 0)
  assert.equal(rowAtCoord(region, 1059), 0)
  assert.equal(rowAtCoord(region, 1060), 1)
  assert.equal(rowAtCoord(region, 1100, true), 0)
  assert.equal(rowAtCoord(region, 1040, true), 1)
  assert.equal(rowAtCoord(region, 999), null)
  assert.equal(rowAtCoord(region, 1101), null)
})

test('a base cell maps back to its exact coordinate', () => {
  const region = { start: 1000, end: 1100 }
  assert.equal(coordAtRowOffset(region, 0, 0), 1000)
  assert.equal(coordAtRowOffset(region, 0, 59), 1059)
  assert.equal(coordAtRowOffset(region, 1, 40), 1100)
  assert.equal(coordAtRowOffset(region, 1, 41), null, 'past the short last row')
  // Reading backwards, the leftmost cell is the highest coordinate.
  assert.equal(coordAtRowOffset(region, 0, 0, true), 1100)
  assert.equal(coordAtRowOffset(region, 0, 59, true), 1041)
})

test('a slab of rows stops at the end of the region', () => {
  const region = { start: 1, end: 300 } // 5 rows
  assert.equal(rowsForRange(region, 0, 3).length, 3)
  assert.equal(rowsForRange(region, 3, 10).length, 2, 'clipped, not padded')
  assert.deepEqual(rowsForRange(region, 0, 0), [])
  assert.deepEqual(rowsForRange(null, 0, 5), [])
})

test('every row but the last is exactly BASES_PER_ROW', () => {
  const region = { start: 5, end: 5 + BASES_PER_ROW * 4 } // one over four rows
  const rows = rowsForRange(region, 0, 99)
  assert.equal(rows.length, 5)
  for (const row of rows.slice(0, -1)) assert.equal(row.length, BASES_PER_ROW)
  assert.equal(rows.at(-1).length, 1)
  // The rows tile the region exactly, with no gap and no overlap.
  assert.equal(rows[0].start, region.start)
  assert.equal(rows.at(-1).end, region.end)
  for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].start, rows[i - 1].end + 1)
})
