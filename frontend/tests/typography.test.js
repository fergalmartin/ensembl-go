import assert from 'node:assert/strict'
import test from 'node:test'

import { FONT_MONO, FONT_SANS, monoFont, sansFont } from '../src/utils/typography.js'

test('the stacks lead with the two Ensembl brand faces', () => {
  assert.ok(FONT_SANS.startsWith('Lato,'))
  assert.ok(FONT_MONO.startsWith('"IBM Plex Mono",'))
})

test('the stacks end in a generic family so text renders before the webfont loads', () => {
  assert.ok(FONT_SANS.endsWith('sans-serif'))
  assert.ok(FONT_MONO.endsWith('monospace'))
})

test('sansFont and monoFont build a canvas font shorthand', () => {
  assert.equal(sansFont(11), `11px ${FONT_SANS}`)
  assert.equal(monoFont(12), `12px ${FONT_MONO}`)
})

test('a weight is placed before the size, as the shorthand requires', () => {
  assert.equal(sansFont(9, 700), `700 9px ${FONT_SANS}`)
  assert.equal(sansFont(9, 'bold'), `bold 9px ${FONT_SANS}`)
  assert.equal(monoFont(32, 'bold'), `bold 32px ${FONT_MONO}`)
})

test('a fractional weight is rounded to a usable one', () => {
  assert.equal(sansFont(10, 600.4), `600 10px ${FONT_SANS}`)
})

test('an omitted weight leaves the shorthand at its default', () => {
  for (const weight of [undefined, null, '', Number.NaN]) {
    assert.equal(sansFont(10, weight), `10px ${FONT_SANS}`)
  }
})

test('a nonsensical size yields null rather than an invalid shorthand', () => {
  assert.equal(sansFont(0), null)
  assert.equal(sansFont(-3), null)
  assert.equal(sansFont(Number.NaN), null)
  assert.equal(monoFont(undefined), null)
})

test('a numeric string size is accepted', () => {
  assert.equal(sansFont('11'), `11px ${FONT_SANS}`)
})

test('canvas parses the generated shorthand', (t) => {
  // Only meaningful where a canvas exists; skipped under plain node.
  if (typeof document === 'undefined') return t.skip('no DOM')
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = sansFont(11, 700)
  assert.match(ctx.font, /Lato/)
})
