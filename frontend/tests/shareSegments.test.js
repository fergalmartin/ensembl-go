// Part-to-whole figures: the arithmetic that decides what a segment is worth,
// and the ramp that decides what colour it wears.

import assert from 'node:assert/strict'
import test from 'node:test'

import { sequentialRamp, shareSegments } from '../src/utils/shareSegments.js'

test('shares are taken against the whole, not against what is listed', () => {
  // Ten chromosomes out of 706 sequences: their shares must be of the genome,
  // not of each other, or a bar of the ten would read as the whole assembly.
  const segments = shareSegments(
    [{ key: '1', label: '1', value: 25 }, { key: '2', label: '2', value: 25 }],
    100,
  )
  assert.equal(segments[0].share, 25)
  assert.equal(segments[1].share, 25)
})

test('everything not listed is folded into one other segment', () => {
  const segments = shareSegments(
    [{ key: '1', label: '1', value: 60 }, { key: '2', label: '2', value: 20 }],
    100,
    { otherLabel: 'other (696)' },
  )
  const other = segments[segments.length - 1]
  assert.equal(other.isOther, true)
  assert.equal(other.label, 'other (696)')
  assert.equal(other.value, 20)
  assert.equal(other.share, 20)
})

test('the segments always account for the whole', () => {
  const segments = shareSegments(
    [{ key: 'a', value: 3 }, { key: 'b', value: 4 }, { key: 'c', value: 1 }],
    20,
  )
  const summed = segments.reduce((sum, segment) => sum + segment.share, 0)
  assert.ok(Math.abs(summed - 100) < 1e-9, `shares summed to ${summed}`)
})

test('no other segment when the listed parts are the whole', () => {
  const segments = shareSegments([{ key: 'a', value: 30 }, { key: 'b', value: 70 }], 100)
  assert.equal(segments.length, 2)
  assert.ok(!segments.some((segment) => segment.isOther))
})

test('zero-valued parts are dropped rather than drawn as slivers', () => {
  const segments = shareSegments([{ key: 'a', value: 10 }, { key: 'b', value: 0 }], 10)
  assert.deepEqual(segments.map((s) => s.key), ['a'])
})

test('with no total given the listed parts are the whole', () => {
  const segments = shareSegments([{ key: 'a', value: 1 }, { key: 'b', value: 3 }])
  assert.equal(segments.length, 2)
  assert.equal(segments[0].share, 25)
  assert.equal(segments[1].share, 75)
})

test('the ramp gives one step per segment', () => {
  for (const count of [1, 2, 5, 10]) {
    assert.equal(sequentialRamp(count, true).length, count)
    assert.equal(sequentialRamp(count, false).length, count)
  }
})

test('the ramp runs away from the surface it sits on', () => {
  // The largest value must be the strongest mark in both themes: darkest on a
  // light surface, lightest on a dark one. Reading the green channel is enough
  // to tell which end of a blue ramp a step came from.
  const green = (hex) => parseInt(hex.slice(3, 5), 16)

  const light = sequentialRamp(10, true)
  assert.ok(green(light[0]) < green(light[9]), `light ramp not darkest-first: ${light[0]} → ${light[9]}`)

  const dark = sequentialRamp(10, false)
  assert.ok(green(dark[0]) > green(dark[9]), `dark ramp not lightest-first: ${dark[0]} → ${dark[9]}`)
})

test('a single segment takes the strongest step', () => {
  const [light] = sequentialRamp(1, true)
  const [dark] = sequentialRamp(1, false)
  assert.equal(light, sequentialRamp(10, true)[0], 'lone light step should be the darkest')
  assert.equal(dark, sequentialRamp(10, false)[0], 'lone dark step should be the lightest')
})
