import assert from 'node:assert/strict'
import test from 'node:test'

import { bedThickPieces, bedThickRegion } from '../src/utils/bedThickRegion.js'

// ENSR18_BKQG9 as the browser holds it: BED positions + 1, so [first base, last base + 1).
// 18 79399033 79400402 ... thickStart 79399783 thickEnd 79400402
const promoter = { start: 79399034, end: 79400403, thick_start: 79399784, thick_end: 79400403 }

test('a promoter core is the thick region, its extension the rest', () => {
  assert.deepEqual(bedThickRegion(promoter, promoter.start, promoter.end), { start: 79399784, end: 79400403 })
})

test('a thick region covering the whole feature is an ordinary box', () => {
  assert.equal(bedThickRegion({ thick_start: 10, thick_end: 20 }, 10, 20), null)
  assert.equal(bedThickRegion({ thick_start: 5, thick_end: 25 }, 10, 20), null) // clamped to the feature
})

test('no thick columns, or empty ones, leave it a box', () => {
  assert.equal(bedThickRegion({}, 10, 20), null)
  assert.equal(bedThickRegion({ thick_start: null, thick_end: 15 }, 10, 20), null)
  assert.equal(bedThickRegion({ thick_start: '', thick_end: '' }, 10, 20), null)
})

test('an empty thick region makes the whole feature thin', () => {
  assert.deepEqual(bedThickRegion({ thick_start: 10, thick_end: 10 }, 10, 20), { start: 10, end: 10 })
})

const view = { left: 0, right: 1000, viewStart: 0, viewEnd: 100, yMid: 50, exonH: 10 }
const toX = (g) => g * 10

test('pieces are thin, thick, thin, without overlapping', () => {
  const pieces = bedThickPieces({ start: 10, end: 60, _thick: { start: 30, end: 40 } }, toX, view)
  assert.deepEqual(pieces.map((p) => [p.x, p.w, p.thick]), [[100, 200, false], [300, 100, true], [400, 200, false]])
  assert.equal(pieces[1].h, 10)
  assert.ok(pieces[0].h < pieces[1].h)
  assert.equal(pieces[0].y + pieces[0].h / 2, 50) // centred on the lane
})

test('a core at one end leaves one thin piece; an empty core leaves the feature thin', () => {
  const coreAtEnd = bedThickPieces({ start: 10, end: 60, _thick: { start: 40, end: 60 } }, toX, view)
  assert.deepEqual(coreAtEnd.map((p) => p.thick), [false, true])
  const allThin = bedThickPieces({ start: 10, end: 60, _thick: { start: 10, end: 10 } }, toX, view)
  assert.deepEqual(allThin.map((p) => [p.x, p.w, p.thick]), [[100, 500, false]])
})

test('pieces outside the view are dropped and those crossing it are clipped', () => {
  const pieces = bedThickPieces({ start: 10, end: 60, _thick: { start: 30, end: 40 } }, toX, { ...view, viewStart: 35, viewEnd: 100, left: 0 })
  assert.deepEqual(pieces.map((p) => [p.x, p.w, p.thick]), [[350, 50, true], [400, 200, false]])
})
