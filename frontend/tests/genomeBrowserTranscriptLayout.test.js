import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldResetStickyGeneRows } from '../src/components/genomeBrowserTranscriptLayout.js'

test('leaving expanded or flattened transcript layouts resets their sticky track height', () => {
  assert.equal(
    shouldResetStickyGeneRows(
      { expanded: true, flatten: false },
      { expanded: false, flatten: false }
    ),
    true
  )
  assert.equal(
    shouldResetStickyGeneRows(
      { expanded: true, flatten: true },
      { expanded: true, flatten: false }
    ),
    true
  )
})

test('entering a layout mode and ordinary re-renders preserve row stabilisation', () => {
  assert.equal(
    shouldResetStickyGeneRows(
      { expanded: false, flatten: false },
      { expanded: true, flatten: false }
    ),
    false
  )
  assert.equal(
    shouldResetStickyGeneRows(
      { expanded: true, flatten: false },
      { expanded: true, flatten: false }
    ),
    false
  )
})
