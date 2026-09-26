import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeSelection, rangeBetween } from '../src/utils/fileSelection.js'

const rows = ['a.bw', 'b.bw', 'c.bw', 'd.bw', 'e.bw']

test('a range runs either way and includes both ends', () => {
  assert.deepEqual(rangeBetween(rows, 'b.bw', 'd.bw'), ['b.bw', 'c.bw', 'd.bw'])
  assert.deepEqual(rangeBetween(rows, 'd.bw', 'b.bw'), ['b.bw', 'c.bw', 'd.bw'])
  assert.deepEqual(rangeBetween(rows, 'c.bw', 'c.bw'), ['c.bw'])
  assert.deepEqual(rangeBetween(rows, 'x.bw', 'c.bw'), [])
})

test('adding a range keeps what was chosen first and never repeats a file', () => {
  assert.deepEqual(mergeSelection(['e.bw', 'b.bw'], ['b.bw', 'c.bw']), ['e.bw', 'b.bw', 'c.bw'])
  assert.deepEqual(mergeSelection(null, ['a.bw']), ['a.bw'])
})
