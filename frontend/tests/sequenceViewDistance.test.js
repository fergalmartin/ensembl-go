import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDistance, geneBearing } from '../src/utils/sequenceViewDistance.js'

test('a distance is written at the significance the number carries', () => {
  assert.equal(formatDistance(0), '0 bp')
  assert.equal(formatDistance(1), '1 bp')
  assert.equal(formatDistance(999), '999 bp')
  // The first kilobase reads with one decimal, because 1.2 kb and 1.9 kb are
  // different answers to someone deciding whether to scroll.
  assert.equal(formatDistance(1_000), '1.0 kb')
  assert.equal(formatDistance(5_240), '5.2 kb')
  assert.equal(formatDistance(9_949), '9.9 kb')
  // Past ten the decimal stops carrying anything, so it goes.
  assert.equal(formatDistance(10_400), '10 kb')
  assert.equal(formatDistance(436_000), '436 kb')
  assert.equal(formatDistance(1_000_000), '1.0 Mb')
  assert.equal(formatDistance(2_470_000), '2.5 Mb')
  assert.equal(formatDistance(64_000_000), '64 Mb')
})

test('a distance is unsigned -- the arrow carries the direction', () => {
  assert.equal(formatDistance(-5_240), '5.2 kb')
})

test('a distance survives being handed nothing', () => {
  assert.equal(formatDistance(null), '0 bp')
  assert.equal(formatDistance(undefined), '0 bp')
  assert.equal(formatDistance('nonsense'), '0 bp')
})

const gene = { id: 'G1', s: 1_000, e: 2_000 }

test('a gene below the top of the window is downstream, measured to its near edge', () => {
  assert.deepEqual(geneBearing(gene, 500), { direction: 'downstream', distance: 500 })
  assert.deepEqual(geneBearing(gene, 999), { direction: 'downstream', distance: 1 })
})

test('a gene above the top of the window is upstream, measured to its near edge', () => {
  assert.deepEqual(geneBearing(gene, 2_001), { direction: 'upstream', distance: 1 })
  assert.deepEqual(geneBearing(gene, 12_000), { direction: 'upstream', distance: 10_000 })
})

test('a gene the window opens inside is here, with no distance to travel', () => {
  assert.deepEqual(geneBearing(gene, 1_000), { direction: 'here', distance: 0 })
  assert.deepEqual(geneBearing(gene, 1_500), { direction: 'here', distance: 0 })
  assert.deepEqual(geneBearing(gene, 2_000), { direction: 'here', distance: 0 })
})

test('direction is along the forward strand, not the gene’s own reading direction', () => {
  // The rows run forward at location level, so which way the reader scrolls to
  // reach a gene does not depend on which strand the gene is transcribed from.
  const minus = { id: 'G2', s: 1_000, e: 2_000, strand: '-' }
  assert.deepEqual(geneBearing(minus, 500), { direction: 'downstream', distance: 500 })
  assert.deepEqual(geneBearing(minus, 3_000), { direction: 'upstream', distance: 1_000 })
})

test('a gene handed back to front is still measured from its true edges', () => {
  assert.deepEqual(geneBearing({ id: 'G3', s: 2_000, e: 1_000 }, 500),
    { direction: 'downstream', distance: 500 })
})

test('there is no bearing without both a gene and a coordinate', () => {
  assert.equal(geneBearing(null, 100), null)
  assert.equal(geneBearing(gene, null), null)
  assert.equal(geneBearing(gene, undefined), null)
  assert.equal(geneBearing({ id: 'G4' }, 100), null)
})
