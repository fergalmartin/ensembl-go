import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addAlignmentRangeMatches,
  buildAlignmentRangeIndex,
} from '../src/lib/ensembl-sv/alignments/alignment-range-index.js'

test('alignment range index reports the same matches as a direct range scan', () => {
  const xValues = new Float64Array([5, 10, 20, 20, 40, 75, 90])
  const yValues = new Float64Array([100, 15, 80, 25, 60, 30, 95])
  const index = buildAlignmentRangeIndex(xValues, yValues)

  for (const [maxX, minY] of [[0, 0], [20, 25], [50, 50], [100, 90], [100, 101]]) {
    const actual = new Set()
    addAlignmentRangeMatches(index, maxX, minY, actual)
    const expected = xValues.reduce((matches, x, sourceIndex) => {
      if (x <= maxX && yValues[sourceIndex] >= minY) matches.push(sourceIndex)
      return matches
    }, [])
    assert.deepEqual([...actual].sort((a, b) => a - b), expected)
  }
})

test('the four range queries preserve the original alignment polygon culling rule', () => {
  const refStarts = new Float64Array([0, 100, 300, 600, 900, 1200])
  const refEnds = new Float64Array([50, 180, 360, 660, 960, 1260])
  const altStarts = new Float64Array([0, 700, 320, 100, 920, 1500])
  const altEnds = new Float64Array([50, 760, 380, 160, 980, 1560])
  const indexes = {
    refOverlap: buildAlignmentRangeIndex(refStarts, refEnds),
    altOverlap: buildAlignmentRangeIndex(altStarts, altEnds),
    altStartRefEnd: buildAlignmentRangeIndex(altStarts, refEnds),
    refStartAltEnd: buildAlignmentRangeIndex(refStarts, altEnds),
  }
  const viewStart = 250
  const viewEnd = 500
  const altViewStart = 250
  const altViewEnd = 500
  const actual = new Set()
  addAlignmentRangeMatches(indexes.refOverlap, viewEnd, viewStart, actual)
  addAlignmentRangeMatches(indexes.altOverlap, altViewEnd, altViewStart, actual)
  addAlignmentRangeMatches(indexes.altStartRefEnd, altViewEnd, viewStart, actual)
  addAlignmentRangeMatches(indexes.refStartAltEnd, viewEnd, altViewStart, actual)

  const expected = []
  for (let index = 0; index < refStarts.length; index += 1) {
    if (
      (refEnds[index] >= viewStart || altEnds[index] >= altViewStart)
      && (refStarts[index] <= viewEnd || altStarts[index] <= altViewEnd)
    ) {
      expected.push(index)
    }
  }
  assert.deepEqual([...actual].sort((a, b) => a - b), expected)
})
