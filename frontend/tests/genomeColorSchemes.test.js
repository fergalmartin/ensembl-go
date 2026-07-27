import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRIMARY_GENOME_DEFAULT_COLOR,
  SECONDARY_GENOME_DEFAULT_COLOR,
  buildDefaultGenomeBrowserColors,
  getGenomeBrowserColor,
  normalizeGenomeBrowserColors,
} from '../src/genomeColorSchemes.js'

test('buildDefaultGenomeBrowserColors uses primary blue then secondary green', () => {
  const colors = buildDefaultGenomeBrowserColors()

  assert.equal(colors.length, 5)
  assert.equal(colors[0], PRIMARY_GENOME_DEFAULT_COLOR)
  assert.deepEqual(colors.slice(1), new Array(4).fill(SECONDARY_GENOME_DEFAULT_COLOR))
})

test('normalizeGenomeBrowserColors pads missing entries and keeps extra entries', () => {
  const colors = normalizeGenomeBrowserColors(['#112233', '#445566', '#778899', '#aabbcc', '#ddeeff', '#123456'])

  assert.equal(colors.length, 6)
  assert.equal(colors[0], '#112233')
  assert.equal(colors[5], '#123456')
})

test('getGenomeBrowserColor falls back to secondary green beyond configured range', () => {
  const colors = ['#112233', '#445566']

  assert.equal(getGenomeBrowserColor(colors, 0), '#112233')
  assert.equal(getGenomeBrowserColor(colors, 6), SECONDARY_GENOME_DEFAULT_COLOR)
})
