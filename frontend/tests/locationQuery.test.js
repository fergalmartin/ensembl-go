import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRangeAgainstBounds, parseLocationQuery } from '../src/utils/locationQuery.js'

test('ranges in the forms people type', () => {
  assert.deepEqual(parseLocationQuery('18:79,398,171-79,401,927'), { kind: 'range', chrom: '18', start: 79398171, end: 79401927, swapped: false })
  assert.deepEqual(parseLocationQuery(' chrX : 100 – 200 '), { kind: 'range', chrom: 'chrX', start: 100, end: 200, swapped: false })
  assert.deepEqual(parseLocationQuery('1:100..200'), { kind: 'range', chrom: '1', start: 100, end: 200, swapped: false })
  assert.deepEqual(parseLocationQuery('1:500-100'), { kind: 'range', chrom: '1', start: 100, end: 500, swapped: true })
})

test('a single position', () => {
  assert.deepEqual(parseLocationQuery('MT:1,234'), { kind: 'position', chrom: 'MT', position: 1234 })
})

test('text without a colon is a lookup', () => {
  assert.deepEqual(parseLocationQuery('BRCA2'), { kind: 'text', text: 'BRCA2' })
  assert.deepEqual(parseLocationQuery('ENSG00000139618'), { kind: 'text', text: 'ENSG00000139618' })
  assert.deepEqual(parseLocationQuery('   '), { kind: 'empty' })
})

test('something with a colon that is not a location says so', () => {
  for (const q of ['1:abc', '1:100-', '1:-200', ':100-200', '1:100-2x0', 'chr 1:100-200']) {
    const parsed = parseLocationQuery(q)
    assert.equal(parsed.kind, 'malformed', q)
    assert.match(parsed.message, /start-end/, q)
  }
})

const chr18 = { min: 1, max: 80373285, chrom: '18' }

test('a range inside the sequence passes without a warning', () => {
  assert.deepEqual(checkRangeAgainstBounds({ start: 100, end: 200 }, chr18), { start: 100, end: 200, outside: false, warning: null })
})

test('a range running off either end shows what there is, and says so', () => {
  const past = checkRangeAgainstBounds({ start: 80373000, end: 80400000 }, chr18)
  assert.equal(past.start, 80373000)
  assert.equal(past.end, 80373285)
  assert.match(past.warning, /runs past the end of 18 \(1-80,373,285\)\. Showing 18:80,373,000-80,373,285\./)
  const before = checkRangeAgainstBounds({ start: 0, end: 500 }, chr18)
  assert.deepEqual([before.start, before.end], [1, 500])
  assert.match(before.warning, /runs past the start/)
})

test('a range wholly off the end shows the nearest end', () => {
  const beyond = checkRangeAgainstBounds({ start: 300000000, end: 300001000 }, chr18)
  assert.equal(beyond.outside, true)
  assert.deepEqual([beyond.start, beyond.end], [80372285, 80373285])
  assert.match(beyond.warning, /is past the end of 18 .*Showing the end of 18\./)
})

test('a single position is named as one', () => {
  const beyond = checkRangeAgainstBounds({ start: 99999999, end: 99999999 }, { min: 1, max: 16569, chrom: 'MT' })
  assert.match(beyond.warning, /^MT:99,999,999 is past the end of MT \(1-16,569\)/)
})
