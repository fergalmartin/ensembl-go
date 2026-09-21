import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOKAHEAD_CHUNKS,
  PLACEHOLDER_BASE,
  SEQUENCE_VIEW_CHUNK_BP,
  assembleRowSequence,
  chunkIndexForCoord,
  chunkKey,
  chunkRange,
  planChunksForIntervals,
  planSequenceChunks,
  rowIsResolved,
} from '../src/utils/sequenceViewChunks.js'
import { rowRange } from '../src/utils/sequenceViewRows.js'

// A chunk whose every base says which chunk it came from, so that a stitched
// row shows plainly where its pieces came from.
const fakeChunk = (index, letter) => letter.repeat(SEQUENCE_VIEW_CHUNK_BP)

test('the chunk grid is anchored at coordinate 1, not at the region', () => {
  assert.equal(chunkIndexForCoord(1), 0)
  assert.equal(chunkIndexForCoord(SEQUENCE_VIEW_CHUNK_BP), 0)
  assert.equal(chunkIndexForCoord(SEQUENCE_VIEW_CHUNK_BP + 1), 1)
  assert.deepEqual(chunkRange(0), { index: 0, start: 1, end: SEQUENCE_VIEW_CHUNK_BP })
  assert.deepEqual(chunkRange(1), {
    index: 1,
    start: SEQUENCE_VIEW_CHUNK_BP + 1,
    end: SEQUENCE_VIEW_CHUNK_BP * 2,
  })
  assert.equal(chunkIndexForCoord('x'), null)
  assert.equal(chunkRange(-1), null)
})

test('a chunk key separates genomes and chromosomes', () => {
  assert.notEqual(chunkKey('a', '1', 0), chunkKey('b', '1', 0))
  assert.notEqual(chunkKey('a', '1', 0), chunkKey('a', '2', 0))
  assert.equal(chunkKey('a', '1', 7), chunkKey('a', '1', 7))
})

test('the chunk under the anchor row is wanted before anything else', () => {
  const region = { start: 1, end: 200_000 }
  const plan = planSequenceChunks({
    region,
    visibleStart: 30_000,
    visibleEnd: 32_000,
    anchorCoord: 30_000,
  })
  assert.equal(plan[0].priority, 0)
  assert.equal(plan[0].index, chunkIndexForCoord(30_000))
  // Sorted most urgent first, so a scheduler can take them as they come.
  for (let i = 1; i < plan.length; i += 1) assert.ok(plan[i].priority >= plan[i - 1].priority)
})

test('everything on screen is wanted, and nothing outside the region is', () => {
  const region = { start: 20_000, end: 40_000 } // chunks 1..3
  const plan = planSequenceChunks({
    region,
    visibleStart: 20_000,
    visibleEnd: 40_000,
    anchorCoord: 20_000,
    direction: 1,
  })
  const indexes = plan.map((chunk) => chunk.index).sort((a, b) => a - b)
  assert.deepEqual(indexes, [1, 2, 3], 'no chunk before or after the region')
  assert.ok(plan.every((chunk) => chunk.priority <= 1), 'all of it is on screen')
})

test('lookahead follows the direction of travel, and only while moving', () => {
  const region = { start: 1, end: 500_000 }
  const scrollingDown = planSequenceChunks({
    region,
    visibleStart: 100_001,
    visibleEnd: 102_000,
    anchorCoord: 100_001,
    direction: 1,
  })
  const here = chunkIndexForCoord(100_001)
  const ahead = scrollingDown.find((chunk) => chunk.index === here + 1)
  const further = scrollingDown.find((chunk) => chunk.index === here + 2)
  const behind = scrollingDown.find((chunk) => chunk.index === here - 1)
  assert.equal(ahead.priority, 2, 'the leading side comes first')
  // Two ahead rather than one, in order, so a reader who outruns the first
  // chunk finds the second already asked for. Each is behind the one before it,
  // so the deeper lookahead costs nothing until the nearer one has landed.
  assert.equal(further.priority, 3, 'and then the one beyond it')
  assert.ok(ahead.priority < further.priority)
  assert.ok(further.priority < behind.priority, 'the way back comes last of all')
  assert.equal(behind.priority, 2 + LOOKAHEAD_CHUNKS)

  const scrollingUp = planSequenceChunks({
    region,
    visibleStart: 100_001,
    visibleEnd: 102_000,
    anchorCoord: 100_001,
    direction: -1,
  })
  assert.equal(scrollingUp.find((chunk) => chunk.index === here - 1).priority, 2)
  assert.equal(scrollingUp.find((chunk) => chunk.index === here - 2).priority, 3)

  const still = planSequenceChunks({
    region,
    visibleStart: 100_001,
    visibleEnd: 102_000,
    anchorCoord: 100_001,
    direction: 0,
  })
  assert.ok(still.every((chunk) => chunk.priority <= 1), 'idle asks for nothing extra')
})

test('a row is assembled whole, or padded — never short', () => {
  const region = { start: 1, end: 600 }
  const row = rowRange(region, 0)
  const chunks = new Map([[0, fakeChunk(0, 'A')]])
  const sequence = assembleRowSequence(row, (i) => chunks.get(i))
  assert.equal(sequence.length, 60)
  assert.equal(sequence, 'A'.repeat(60))
  assert.ok(rowIsResolved(row, (i) => chunks.get(i)))
})

test('a row with no chunk yet is placeholders at full width', () => {
  const row = rowRange({ start: 1, end: 600 }, 0)
  const sequence = assembleRowSequence(row, () => null)
  assert.equal(sequence.length, 60, 'the row never changes size when sequence lands')
  assert.equal(sequence, PLACEHOLDER_BASE.repeat(60))
  assert.equal(rowIsResolved(row, () => null), false)
})

test('a row straddling a chunk boundary is stitched from both', () => {
  // The grid is absolute and a region rarely starts on it, so this is the
  // ordinary case rather than an edge one.
  const boundary = SEQUENCE_VIEW_CHUNK_BP
  const region = { start: boundary - 29, end: boundary + 600 }
  const row = rowRange(region, 0)
  assert.ok(row.start <= boundary && row.end > boundary, 'the row does span the boundary')

  const chunks = new Map([[0, fakeChunk(0, 'A')], [1, fakeChunk(1, 'B')]])
  const sequence = assembleRowSequence(row, (i) => chunks.get(i))
  assert.equal(sequence.length, 60)
  assert.equal(sequence, 'A'.repeat(30) + 'B'.repeat(30))

  // With only the first half here, the rest is placeholders in the right place.
  const half = assembleRowSequence(row, (i) => (i === 0 ? fakeChunk(0, 'A') : null))
  assert.equal(half, 'A'.repeat(30) + PLACEHOLDER_BASE.repeat(30))
  assert.equal(half.length, 60)
})

test('a short last row assembles to its own length', () => {
  const region = { start: 1, end: 100 }
  const row = rowRange(region, 1)
  assert.equal(row.length, 40)
  const sequence = assembleRowSequence(row, () => fakeChunk(0, 'A'))
  assert.equal(sequence.length, 40)
})

test('a truncated chunk is padded rather than trusted', () => {
  const row = rowRange({ start: 1, end: 600 }, 0)
  const sequence = assembleRowSequence(row, () => 'ACGT')
  assert.equal(sequence.length, 60)
  assert.equal(sequence.slice(0, 4), 'ACGT')
  assert.equal(sequence.slice(4), PLACEHOLDER_BASE.repeat(56))
})

test('a malformed row yields nothing rather than a wrong string', () => {
  assert.equal(assembleRowSequence(null, () => 'A'), '')
  assert.equal(assembleRowSequence({ start: 10, end: 5 }, () => 'A'), '')
  assert.deepEqual(planSequenceChunks({ region: null, visibleStart: 1, visibleEnd: 2 }), [])
})

// -- scattered stretches, which is what a collapsed layout asks for ----------

test('scattered stretches are fetched as themselves, not as the span across them', () => {
  // Two exons half a megabase apart. The whole point: the chunks between them
  // are the intron the reader has just collapsed, and must not be fetched.
  const plan = planChunksForIntervals({
    intervals: [{ s: 1, e: 200 }, { s: 500_001, e: 500_200 }],
    anchorCoord: 1,
  })
  assert.deepEqual(plan.map((chunk) => chunk.index), [0, 41])
  assert.equal(plan.length, 2)
})

test('the stretch under the top row is fetched first', () => {
  const plan = planChunksForIntervals({
    intervals: [{ s: 1, e: 200 }, { s: 500_001, e: 500_200 }],
    anchorCoord: 500_001,
  })
  assert.equal(plan[0].index, 41)
  assert.equal(plan[0].priority, 0)
})

test('nearer stretches come before further ones', () => {
  const plan = planChunksForIntervals({
    intervals: [{ s: 1, e: 10 }, { s: 240_001, e: 240_010 }, { s: 264_001, e: 264_010 }],
    anchorCoord: 240_001,
  })
  // The anchor's own chunk, then the one two along, then the one twenty back.
  assert.deepEqual(plan.map((chunk) => chunk.index), [20, 22, 0])
})

test('stretches equally far either side are ordered by position, not by chance', () => {
  const plan = planChunksForIntervals({
    intervals: [{ s: 1, e: 10 }, { s: 240_001, e: 240_010 }, { s: 480_001, e: 480_010 }],
    anchorCoord: 240_001,
  })
  assert.deepEqual(plan.map((chunk) => chunk.index), [20, 0, 40])
})

test('a stretch spanning a chunk boundary asks for both chunks', () => {
  const plan = planChunksForIntervals({
    intervals: [{ s: 11_900, e: 12_100 }],
    anchorCoord: 11_900,
  })
  assert.deepEqual(plan.map((chunk) => chunk.index), [0, 1])
})

test('the same chunk wanted by two stretches is asked for once', () => {
  const plan = planChunksForIntervals({
    intervals: [{ s: 100, e: 200 }, { s: 300, e: 400 }],
    anchorCoord: 100,
  })
  assert.equal(plan.length, 1)
})

test('a great many small stretches are bounded, because there is one worker', () => {
  const intervals = []
  for (let i = 0; i < 200; i += 1) intervals.push({ s: i * 12_000 + 1, e: i * 12_000 + 10 })
  const plan = planChunksForIntervals({ intervals, anchorCoord: 1, maxChunks: 24 })
  assert.equal(plan.length, 24)
})

test('every planned chunk carries the range it covers', () => {
  const [chunk] = planChunksForIntervals({ intervals: [{ s: 1, e: 10 }], anchorCoord: 1 })
  assert.deepEqual([chunk.start, chunk.end], [1, SEQUENCE_VIEW_CHUNK_BP])
})

test('nothing wanted plans nothing', () => {
  assert.deepEqual(planChunksForIntervals({ intervals: [] }), [])
  assert.deepEqual(planChunksForIntervals({ intervals: [{ s: null, e: 10 }] }), [])
})
