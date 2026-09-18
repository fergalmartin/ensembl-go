import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_HIDDEN,
  allHidden,
  hiddenParam,
  hideAll,
  isHidden,
  showAll,
  toggleHidden,
} from '../src/utils/sequenceViewHidden.js'

test('hiding and showing one thing', () => {
  const once = toggleHidden(EMPTY_HIDDEN, 'ENSG1')
  assert.ok(isHidden(once, 'ENSG1'))
  assert.equal(isHidden(once, 'ENSG2'), false)
  assert.equal(isHidden(toggleHidden(once, 'ENSG1'), 'ENSG1'), false)
})

test('a set is never changed in place', () => {
  // It is a React dependency; mutating it would repaint nothing.
  const before = toggleHidden(EMPTY_HIDDEN, 'A')
  const after = toggleHidden(before, 'B')
  assert.equal(before.size, 1)
  assert.equal(after.size, 2)
  assert.notEqual(before, after)
})

test('hide all leaves what was already hidden alone', () => {
  const some = toggleHidden(EMPTY_HIDDEN, 'X')
  const all = hideAll(some, ['A', 'B'])
  assert.deepEqual([...all].sort(), ['A', 'B', 'X'])
})

test('show all only shows what it was asked about', () => {
  const all = hideAll(EMPTY_HIDDEN, ['A', 'B', 'X'])
  assert.deepEqual([...showAll(all, ['A', 'B'])], ['X'])
})

test('all hidden is false for an empty list, not vacuously true', () => {
  // A section with nothing in it must not offer to show everything.
  assert.equal(allHidden(hideAll(EMPTY_HIDDEN, ['A']), []), false)
  assert.equal(allHidden(EMPTY_HIDDEN, ['A']), false)
  assert.equal(allHidden(hideAll(EMPTY_HIDDEN, ['A', 'B']), ['A', 'B']), true)
  assert.equal(allHidden(hideAll(EMPTY_HIDDEN, ['A']), ['A', 'B']), false)
})

test('the request parameter is sorted, so the same set is the same request', () => {
  // Two readers arriving at the same set by different routes must hit the same
  // cached tile rather than fetching it twice.
  const one = hideAll(EMPTY_HIDDEN, ['B', 'A', 'C'])
  const other = hideAll(hideAll(EMPTY_HIDDEN, ['C']), ['A', 'B'])
  assert.equal(hiddenParam(one), 'A,B,C')
  assert.equal(hiddenParam(one), hiddenParam(other))
})

test('nothing hidden sends nothing', () => {
  assert.equal(hiddenParam(EMPTY_HIDDEN), '')
  assert.equal(hiddenParam(null), '')
})

test('an empty identifier is not a feature', () => {
  assert.equal(toggleHidden(EMPTY_HIDDEN, '').size, 0)
  assert.equal(hideAll(EMPTY_HIDDEN, ['', null]).size, 0)
})
