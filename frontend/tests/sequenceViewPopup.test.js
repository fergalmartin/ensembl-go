import assert from 'node:assert/strict'
import test from 'node:test'

import { POPUP_ARROW, POPUP_EDGE, placePopup } from '../src/utils/sequenceViewPopup.js'

// A base cell 13 px wide, half way down a 1000x800 window.
const BASE = { left: 500, right: 513, mid: 400 }
const W = 320
const WINDOW = { viewportWidth: 1000, viewportHeight: 800 }

const place = (anchor, extra = {}) => placePopup({
    anchor, panelWidth: W, panelHeight: 200, ...WINDOW, ...extra,
})

test('the box opens to the right of the base, touching it', () => {
  const at = place(BASE)
  assert.equal(at.side, 'right')
  // The arrow fills the standoff exactly, so its tip meets the cell's edge.
  assert.equal(at.left, BASE.right + POPUP_ARROW)
})

test('it flips to the left when the right has no room', () => {
  const at = place({ left: 900, right: 913, mid: 400 })
  assert.equal(at.side, 'left')
  assert.equal(at.left + W, 900 - POPUP_ARROW, 'its right edge meets the cell')
})

test('with room on neither side it stays right, pushed off the edge', () => {
  // Better a box pointing the right way from a little way off than half of one
  // off the screen.
  const at = place({ left: 200, right: 213, mid: 400 }, { viewportWidth: 500 })
  assert.equal(at.side, 'right')
  assert.equal(at.left, 500 - W - POPUP_EDGE)
  assert.ok(at.left + W <= 500)
})

test('a base at the very left still opens to the right', () => {
  const at = place({ left: 0, right: 13, mid: 400 })
  assert.equal(at.side, 'right')
  assert.equal(at.left, 13 + POPUP_ARROW)
})

test('the box is centred on the base when it fits', () => {
  const at = place(BASE)
  assert.equal(at.top, 400 - 100)
  assert.equal(at.arrow, 100, 'the arrow is level with the base')
})

test('a box too tall for the space is pushed in, and the arrow stays put', () => {
  // The case that matters: fifteen isoforms and a base near the bottom of the
  // screen. The box moves; the arrow must not, or it points at another row.
  const at = place({ left: 500, right: 513, mid: 760 }, { panelHeight: 400 })
  assert.equal(at.top, 800 - 400 - POPUP_EDGE)
  assert.equal(at.top + at.arrow, 760, 'still level with the base')
})

test('near the top it is pushed down, and the arrow follows the base up', () => {
  const at = place({ left: 500, right: 513, mid: 30 }, { panelHeight: 300 })
  assert.equal(at.top, POPUP_EDGE)
  assert.equal(at.top + at.arrow, 30)
})

test('the arrow never leaves the box, however far off the base is', () => {
  // A box taller than the window cannot point at a base above or below it, so
  // the arrow stops at the corner rather than being drawn outside.
  const high = place({ left: 500, right: 513, mid: 5 }, { panelHeight: 700 })
  assert.ok(high.arrow >= POPUP_ARROW)
  const low = place({ left: 500, right: 513, mid: 795 }, { panelHeight: 700 })
  assert.ok(low.arrow <= 700 - POPUP_ARROW)
})

test('an unmeasured box says so rather than pretending to be placed', () => {
  const at = placePopup({ anchor: BASE, panelWidth: W, ...WINDOW })
  assert.equal(at.measured, false)
  assert.equal(at.side, 'right', 'the side does not depend on the height')
})

test('nonsense in does not throw', () => {
  const at = placePopup({})
  assert.equal(typeof at.left, 'number')
  assert.equal(typeof at.top, 'number')
})
