import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FIXED_ZONE_THRESHOLDS,
  checkCustomZones,
  initialCustomZones,
  loadRememberedCustomZones,
  rememberCustomZones,
  formatZoneLabel,
  zonedSegments,
  zonedValueFraction,
  zoneThresholdsFor,
} from '../src/utils/zonedScale.js'

// The adrenal ATAC file's peaks: 50th/90th/99th/99.9th percentile of 50 kb bin maxima.
const atac = [3.13, 6.75, 7.96, 8.55]

test('fixed zones stay the default, and file zones are used only when known and sound', () => {
  assert.equal(zoneThresholdsFor('fixed', atac), FIXED_ZONE_THRESHOLDS)
  assert.equal(zoneThresholdsFor('file', atac), atac)
  assert.equal(zoneThresholdsFor('file', null), FIXED_ZONE_THRESHOLDS)
  assert.equal(zoneThresholdsFor('file', [1, 1, 2, 3]), FIXED_ZONE_THRESHOLDS)
  assert.equal(zoneThresholdsFor('file', [1, 2, 3]), FIXED_ZONE_THRESHOLDS)
})

test('an ATAC peak is invisible on fixed zones and fills the track on its own', () => {
  // The user's report: a peak of 8 reached 3% of the height.
  assert.ok(zonedValueFraction(8, FIXED_ZONE_THRESHOLDS) < 0.04)
  assert.ok(zonedValueFraction(8, atac) > 0.8)
  assert.ok(zonedValueFraction(3, atac) > 0.35)
})

test('values are placed within their zone and capped at the last edge', () => {
  assert.equal(zonedValueFraction(0, atac), 0)
  assert.equal(zonedValueFraction(3.13, atac), 0.4)
  assert.equal(zonedValueFraction(6.75, atac), 0.6000000000000001)
  assert.equal(zonedValueFraction(1000, atac), 1)
  assert.equal(zonedValueFraction(50, FIXED_ZONE_THRESHOLDS), 0.2)
})

test('segments stack to the same height as the fraction', () => {
  for (const v of [0.5, 3.13, 5, 8, 9, 100]) {
    const total = zonedSegments(v, atac).reduce((sum, s) => sum + s.height, 0)
    assert.ok(Math.abs(total - zonedValueFraction(v, atac)) < 1e-9, String(v))
  }
  assert.deepEqual(zonedSegments(5, atac).map((s) => s.zone), [0, 1])
})

test('labels read naturally at either scale', () => {
  assert.deepEqual(FIXED_ZONE_THRESHOLDS.map(formatZoneLabel), ['>100', '>1,000', '>10,000', '>100,000'])
  assert.deepEqual(atac.map(formatZoneLabel), ['>3.1', '>6.8', '>8', '>8.6'])
  assert.equal(formatZoneLabel(19132), '>19,132')
  assert.equal(formatZoneLabel(0.0421), '>0.042')
})

const memoryStorage = () => {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) }
}

test('custom zones are used when chosen and sound', () => {
  assert.deepEqual(zoneThresholdsFor('custom', atac, [1, 2, 5, 10]), [1, 2, 5, 10])
  assert.equal(zoneThresholdsFor('custom', atac, [1, 2, 2, 10]), FIXED_ZONE_THRESHOLDS)
  assert.equal(zoneThresholdsFor('file', atac, [1, 2, 5, 10]), atac)
})

test('typed zones are checked and the problem named', () => {
  assert.deepEqual(checkCustomZones(['1', '2.5', '1,000', 5000]), { ok: true, zones: [1, 2.5, 1000, 5000], message: '' })
  assert.equal(checkCustomZones(['1', '', '3', '4']).message, 'Enter a number for zone 2.')
  assert.equal(checkCustomZones(['0', '2', '3', '4']).message, 'Zone 1 must be above 0.')
  assert.equal(checkCustomZones(['1', '5', '3', '4']).message, 'Zone 3 must be higher than zone 2.')
  assert.equal(checkCustomZones(['1', 'x', '3', '4']).ok, false)
})

test('the last saved zones are remembered and offered first', () => {
  const storage = memoryStorage()
  assert.equal(loadRememberedCustomZones(storage), null)
  assert.deepEqual(initialCustomZones(null, storage), FIXED_ZONE_THRESHOLDS)
  assert.equal(rememberCustomZones([1, 2, 5, 10], storage), true)
  assert.deepEqual(initialCustomZones(null, storage), [1, 2, 5, 10])
  // A track's own zones win over the remembered ones.
  assert.deepEqual(initialCustomZones([0.5, 1, 2, 4], storage), [0.5, 1, 2, 4])
  // Unsound zones are never remembered, and broken storage is quiet.
  assert.equal(rememberCustomZones([3, 2, 1, 0], storage), false)
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(loadRememberedCustomZones(broken), null)
  assert.equal(rememberCustomZones([1, 2, 3, 4], broken), false)
})

test('files registered together draw with their shared edges, else their own peaks', () => {
  const shared = [2, 5, 9, 12]
  assert.equal(zoneThresholdsFor('files', atac, null, shared), shared)
  assert.equal(zoneThresholdsFor('files', atac, null, null), atac)
  assert.equal(zoneThresholdsFor('files', null, null, null), FIXED_ZONE_THRESHOLDS)
})
