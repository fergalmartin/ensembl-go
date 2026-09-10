import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_ABSENT_ATTEMPTS,
  classifyReadiness,
  readinessRetryDelay,
} from '../src/utils/browserReadiness.js'
import {
  GENE_INDEX_TRACK_HEIGHT,
  describeGeneIndexStatus,
  geneIndexOverlayBand,
  shouldHoldGeneTrackHeight,
} from '../src/utils/geneIndexOverlay.js'

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

test('a genome whose index is still building keeps the panel polling', () => {
  assert.equal(classifyReadiness({ status: 425, attempt: 40 }), 'pending')
})

test('a build that failed is reported rather than polled for ever', () => {
  // The backend remembers a failed build and answers 500 to every subsequent
  // request. Treating that as "still coming" left the panel spinning until the
  // process was restarted.
  assert.equal(classifyReadiness({ status: 500, attempt: 0 }), 'error')
  assert.equal(classifyReadiness({ status: 503, attempt: 0 }), 'error')
})

test('an unusable genome key is an error, not a wait', () => {
  assert.equal(classifyReadiness({ status: 400 }), 'error')
  assert.equal(classifyReadiness({ status: 409 }), 'error')
})

test('a genome that is not there yet is given a while to appear', () => {
  assert.equal(classifyReadiness({ status: 404, attempt: 0 }), 'pending')
  assert.equal(classifyReadiness({ status: 404, attempt: MAX_ABSENT_ATTEMPTS - 1 }), 'pending')
  assert.equal(classifyReadiness({ status: 404, attempt: MAX_ABSENT_ATTEMPTS }), 'error')
})

test('no response at all means the backend is restarting, so keep asking', () => {
  assert.equal(classifyReadiness({ status: 0, attempt: 99 }), 'pending')
})

test('regions in hand means ready; an empty list does not', () => {
  assert.equal(classifyReadiness({ ok: true, status: 200, regionCount: 24 }), 'ready')
  assert.equal(classifyReadiness({ ok: true, status: 200, regionCount: 0 }), 'pending')
})

test('polling backs off so a build lasting minutes is not asked thousands of times', () => {
  const delays = [0, 1, 2, 3, 4, 20].map(readinessRetryDelay)
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `delay went backwards at ${i}`)
  }
  assert.ok(delays[0] >= 500, 'the first retry is too eager')
  assert.equal(delays.at(-1), delays.at(-2), 'the backoff should settle at a cap')
})

// ---------------------------------------------------------------------------
// The gene track while its index builds
// ---------------------------------------------------------------------------

test('the gene tracks hold their height while genes are on the way', () => {
  for (const state of ['building', 'queued', 'absent']) {
    assert.equal(shouldHoldGeneTrackHeight({ state }), true, state)
  }
  // A failed build has a message to show in the same place.
  assert.equal(shouldHoldGeneTrackHeight({ state: 'failed' }), true)
})

test('a genome with genes, or with no annotation at all, lays its tracks out normally', () => {
  assert.equal(shouldHoldGeneTrackHeight({ state: 'ready' }), false)
  assert.equal(shouldHoldGeneTrackHeight({ state: 'none' }), false)
  assert.equal(shouldHoldGeneTrackHeight(null), false)
})

test('the held height is tall enough to put a message in', () => {
  assert.ok(GENE_INDEX_TRACK_HEIGHT >= 80)
})

test('the message is centred across both gene tracks', () => {
  const band = geneIndexOverlayBand({
    forwardY: 30,
    forwardHeight: 104,
    reverseY: 134,
    reverseHeight: 104,
  })
  assert.deepEqual(band, { top: 30, height: 208 })
})

test('hiding one strand moves the message onto the other, not off the panel', () => {
  assert.deepEqual(
    geneIndexOverlayBand({ forwardY: 30, forwardHeight: 0, reverseY: 30, reverseHeight: 104 }),
    { top: 30, height: 104 },
  )
  assert.deepEqual(
    geneIndexOverlayBand({ forwardY: 30, forwardHeight: 104, reverseY: 134, reverseHeight: 0 }),
    { top: 30, height: 104 },
  )
})

test('with both gene tracks hidden there is nothing to say', () => {
  assert.equal(geneIndexOverlayBand({ forwardHeight: 0, reverseHeight: 0 }), null)
})

// ---------------------------------------------------------------------------
// What the meter says
// ---------------------------------------------------------------------------

test('a running build shows its percentage and what it has found', () => {
  const described = describeGeneIndexStatus({
    state: 'building',
    stage: 'parsing',
    percent: 42.5,
    genes: 12345,
  })
  assert.equal(described.percent, 42.5)
  assert.match(described.title, /Reading the annotation/)
  assert.match(described.message, /12,345 genes/)
  assert.equal(described.showRetry, false)
})

test('a queued genome is told what it is waiting for', () => {
  // Indexing is serial by design, so the second genome really does wait. Saying
  // so is the difference between a queue and an apparent hang.
  const described = describeGeneIndexStatus({
    state: 'queued',
    queue_position: 2,
    queue_length: 2,
  })
  assert.match(described.message, /Waiting for another genome/)
  assert.match(described.message, /2 of 2/)
  assert.equal(described.percent, null)
})

test('a build with no percentage yet gets an indeterminate meter, not a zero', () => {
  // A ring pinned at 0% reads as stalled; the overlay draws a spinning arc for
  // a null instead.
  assert.equal(describeGeneIndexStatus({ state: 'building', genes: 0 }).percent, null)
  assert.equal(describeGeneIndexStatus({ state: 'absent' }).percent, null)
})

test('a percentage outside the meter is clamped rather than drawn off the ring', () => {
  assert.equal(describeGeneIndexStatus({ state: 'building', percent: 140 }).percent, 100)
  assert.equal(describeGeneIndexStatus({ state: 'building', percent: -3 }).percent, 0)
})

test('a failed build says why and offers a way out', () => {
  const described = describeGeneIndexStatus({
    state: 'failed',
    error: 'unexpected end of file on line 4102',
  })
  assert.equal(described.tone, 'error')
  assert.match(described.message, /unexpected end of file/)
  assert.equal(described.showRetry, true)
})
