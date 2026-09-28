import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTranscriptSegments, intronFlankRanges } from '../src/components/featureExplorerTranscriptGeometry.js'

const bases = (segments) => segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0)
const exonBases = (exons) => exons.reduce((sum, [s, e]) => sum + (e - s) + 1, 0)
const tx = (exons, cds = []) => ({
  exons: exons.map(([start, end]) => ({ start, end })),
  cds_list: cds.map(([start, end]) => ({ start, end })),
})

test('a non-coding exon is one half-open segment covering every base', () => {
  const segments = buildTranscriptSegments(tx([[100, 199]]))
  assert.deepEqual(segments.map(({ start, end, coding }) => [start, end, coding]), [[100, 200, false]])
  assert.equal(bases(segments), 100)
})

test('coding splits meet exactly and keep every base', () => {
  const exons = [[100, 199], [300, 399]]
  const segments = buildTranscriptSegments(tx(exons, [[150, 199], [300, 349]]))
  assert.deepEqual(segments.map(({ start, end, coding }) => [start, end, coding]), [
    [100, 150, false],
    [150, 200, true],
    [300, 350, true],
    [350, 400, false],
  ])
  assert.equal(bases(segments), exonBases(exons))
})

test('single-base exons and single-base CDS overlaps are kept', () => {
  const segments = buildTranscriptSegments(tx([[10, 10], [20, 30]], [[30, 40]]))
  assert.deepEqual(segments.map(({ start, end, coding }) => [start, end, coding]), [
    [10, 11, false],
    [20, 30, false],
    [30, 31, true],
  ])
})

test('segments keep the exon bounds inclusive', () => {
  const [segment] = buildTranscriptSegments(tx([[5, 9]]))
  assert.equal(segment.exonStart, 5)
  assert.equal(segment.exonEnd, 9)
})

test('intron flanks are the bases either side of each internal boundary', () => {
  assert.deepEqual(intronFlankRanges([{ start: 300, end: 399 }, { start: 100, end: 199 }], 10), [
    { start: 200, end: 209 },
    { start: 290, end: 299 },
  ])
})

test('a short intron is flanked whole, and abutting exons leave no flank', () => {
  assert.deepEqual(intronFlankRanges([{ start: 1, end: 10 }, { start: 26, end: 40 }, { start: 41, end: 50 }], 10), [
    { start: 11, end: 25 },
  ])
  assert.deepEqual(intronFlankRanges([{ start: 1, end: 10 }], 10), [])
})
