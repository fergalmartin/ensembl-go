import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scrollRailGeometry,
  railOffsetForScroll,
  scrollForRailOffset,
  placeScrollRailStops,
  activeScrollRailStop,
  stepScrollRailStop,
  SCROLL_RAIL_INSET,
} from '../src/utils/browserScrollRail.js'

const hostRect = { top: 200, left: 0, height: 800 }
// 26px of page padding sits above the first genome's control bar: real scroll,
// but not part of any genome, so the rail starts past it.
const geometry = scrollRailGeometry(hostRect, { maxScroll: 1200, minScroll: 26 })

test('the rail sits inside the scroll container with a cap at each end', () => {
  assert.equal(geometry.top, 210)
  assert.equal(geometry.height, 780)
  assert.equal(geometry.padding, SCROLL_RAIL_INSET)
  assert.equal(geometry.track, 780 - SCROLL_RAIL_INSET * 2)
})

test('a short rail keeps its padding proportional rather than swallowing the track', () => {
  const tiny = scrollRailGeometry({ top: 0, left: 0, height: 40 }, { maxScroll: 500 })
  assert.ok(tiny.track > 0)
  assert.equal(tiny.padding, 5)
})

test('the rail spans the first genome to the last, not the whole scrollable page', () => {
  assert.equal(geometry.minScroll, 26)
  assert.equal(geometry.maxScroll, 1200)
  assert.equal(geometry.span, 1174)
  assert.equal(railOffsetForScroll(26, geometry), geometry.padding)
  assert.equal(railOffsetForScroll(1200, geometry), geometry.padding + geometry.track)
})

test('the slack above the first control bar leaves the ring parked at the top', () => {
  for (const scrollTop of [0, 5, 25, 26]) {
    assert.equal(railOffsetForScroll(scrollTop, geometry), geometry.padding)
  }
  assert.ok(railOffsetForScroll(27, geometry) > geometry.padding)
})

test('scroll position and rail offset are inverses across the rail range', () => {
  for (const scrollTop of [26, 27, 250, 600, 1199, 1200]) {
    const offset = railOffsetForScroll(scrollTop, geometry)
    assert.ok(Math.abs(scrollForRailOffset(offset, geometry) - scrollTop) < 1e-6)
  }
})

test('positions beyond the rail are pinned to its ends', () => {
  assert.equal(railOffsetForScroll(-400, geometry), geometry.padding)
  assert.equal(railOffsetForScroll(9000, geometry), geometry.padding + geometry.track)
  // Dragging to the very top parks on the first genome, not in the slack above it.
  assert.equal(scrollForRailOffset(-50, geometry), 26)
  assert.equal(scrollForRailOffset(5000, geometry), 1200)
})

test('a page with no genome-to-genome travel parks the ring instead of dividing by zero', () => {
  const flat = scrollRailGeometry(hostRect, { maxScroll: 26, minScroll: 26 })
  assert.equal(flat.span, 0)
  assert.equal(railOffsetForScroll(0, flat), flat.padding)
  assert.equal(scrollForRailOffset(500, flat), 26)
})

test('a floor above the end of the page cannot invert the rail', () => {
  const upended = scrollRailGeometry(hostRect, { maxScroll: 100, minScroll: 900 })
  assert.equal(upended.minScroll, 100)
  assert.equal(upended.span, 0)
})

const stops = placeScrollRailStops([
  { key: 'human', scrollTop: 26 },
  { key: 'mouse', scrollTop: 400 },
  { key: 'rat', scrollTop: 1200 },
  { key: 'unmeasured', scrollTop: NaN },
], geometry)

test('a dot lands exactly where the scroll that aligns its genome would put the ring', () => {
  assert.deepEqual(stops.map((stop) => stop.key), ['human', 'mouse', 'rat'])
  for (const stop of stops) {
    assert.equal(stop.offset, railOffsetForScroll(stop.scrollTop, geometry))
  }
  // No gap above the first dot: the top of the rail is the first genome.
  assert.equal(stops[0].offset, geometry.padding)
  assert.equal(stops[2].offset, geometry.padding + geometry.track)
})

test('a genome measured outside the rail is clamped onto it', () => {
  const [late] = placeScrollRailStops([{ key: 'late', scrollTop: 5000 }], geometry)
  assert.equal(late.scrollTop, 1200)
  assert.equal(late.offset, geometry.padding + geometry.track)
  const [early] = placeScrollRailStops([{ key: 'early', scrollTop: -20 }], geometry)
  assert.equal(early.scrollTop, 26)
  assert.equal(early.offset, geometry.padding)
})

test('the current genome is the last one whose control bar has reached the top', () => {
  assert.equal(activeScrollRailStop(26, stops), 0)
  assert.equal(activeScrollRailStop(396, stops), 0)
  assert.equal(activeScrollRailStop(400, stops), 1)
  assert.equal(activeScrollRailStop(401, stops), 1)
  assert.equal(activeScrollRailStop(1200, stops), 2)
  // A smooth scroll settles a fraction short; the genome is still the one at the top.
  assert.equal(activeScrollRailStop(398.5, stops), 1)
  // Scrolled up into the slack above the first bar, it is still the first genome.
  assert.equal(activeScrollRailStop(0, stops), 0)
  assert.equal(activeScrollRailStop(0, []), -1)
})

test('stepping back from inside a genome returns to the top of that genome first', () => {
  assert.equal(stepScrollRailStop(700, stops, -1), 1)
  assert.equal(stepScrollRailStop(400, stops, -1), 0)
  assert.equal(stepScrollRailStop(26, stops, -1), 0)
  assert.equal(stepScrollRailStop(0, stops, -1), 0)
})

test('stepping forward always reaches the next genome down', () => {
  assert.equal(stepScrollRailStop(26, stops, 1), 1)
  assert.equal(stepScrollRailStop(400, stops, 1), 2)
  assert.equal(stepScrollRailStop(1200, stops, 1), 2)
  assert.equal(stepScrollRailStop(0, [], 1), -1)
})

test('a lone genome still gets a rail: its dot at the top, the ring free to travel', () => {
  const tall = scrollRailGeometry(hostRect, { maxScroll: 1200, minScroll: 26 })
  const single = placeScrollRailStops([{ key: 'human', scrollTop: 26 }], tall)
  assert.equal(single[0].offset, tall.padding)
  assert.equal(activeScrollRailStop(900, single), 0)
  assert.ok(railOffsetForScroll(900, tall) > single[0].offset)
})

test('the rail can be placed away from an inner scroll container, into the page padding', () => {
  const inner = scrollRailGeometry({ top: 300, left: 250, height: 600 }, { maxScroll: 900, left: 227 })
  assert.equal(inner.left, 227)
  assert.equal(inner.top, 310)
  assert.equal(scrollRailGeometry({ top: 0, left: 250, height: 600 }, { maxScroll: 900 }).left, 251)
})

// Balanced placement: every genome an equal share, which is what keeps the last
// genome from collapsing to a dot at the end of the rail.
const twoGeometry = scrollRailGeometry(hostRect, { maxScroll: 900, minScroll: 26 })
const balancedTwo = placeScrollRailStops([
  { key: 'human', scrollTop: 26 },
  // The last genome can only just reach the top: its park position is the end of the page.
  { key: 'mouse', scrollTop: 900 },
], twoGeometry, { balanced: true })

test('balanced: two genomes split the rail in half instead of one band and a dot', () => {
  assert.equal(balancedTwo[0].offset, twoGeometry.padding)
  assert.equal(balancedTwo[1].offset, twoGeometry.padding + twoGeometry.track / 2)
})

test('balanced: a dot is still exactly where aligning its genome puts the ring', () => {
  for (const stop of balancedTwo) {
    assert.equal(railOffsetForScroll(stop.scrollTop, twoGeometry, balancedTwo), stop.offset)
  }
})

test('balanced: the ring moves through each genome at that genome\'s own pace', () => {
  const halfway = railOffsetForScroll(463, twoGeometry, balancedTwo)
  assert.ok(Math.abs(halfway - (twoGeometry.padding + twoGeometry.track / 4)) < 1e-6)
})

test('balanced: dragging into the last genome\'s share parks that genome', () => {
  const end = twoGeometry.padding + twoGeometry.track
  assert.equal(scrollForRailOffset(end - 5, twoGeometry, balancedTwo), 900)
  assert.equal(scrollForRailOffset(end + 50, twoGeometry, balancedTwo), 900)
  assert.equal(scrollForRailOffset(-50, twoGeometry, balancedTwo), 26)
})

test('balanced: scroll and rail are inverses inside a genome that has travel', () => {
  const three = placeScrollRailStops([
    { key: 'human', scrollTop: 26 },
    { key: 'mouse', scrollTop: 300 },
    { key: 'rat', scrollTop: 700 },
  ], geometry, { balanced: true })
  for (const scrollTop of [26, 100, 300, 512, 700, 950, 1200]) {
    const offset = railOffsetForScroll(scrollTop, geometry, three)
    assert.ok(Math.abs(scrollForRailOffset(offset, geometry, three) - scrollTop) < 1e-6, `at ${scrollTop}`)
  }
  // Each of the three gets a third of the rail.
  assert.deepEqual(three.map((stop) => stop.offset), [0, 1, 2].map((i) => geometry.padding + geometry.track * (i / 3)))
})

test('balanced: genomes that share a park position never run the rail backwards', () => {
  const crowded = placeScrollRailStops([
    { key: 'human', scrollTop: 26 },
    { key: 'mouse', scrollTop: 1200 },
    { key: 'rat', scrollTop: 1200 },
  ], geometry, { balanced: true })
  let previous = -Infinity
  for (const scrollTop of [26, 300, 800, 1200]) {
    const offset = railOffsetForScroll(scrollTop, geometry, crowded)
    assert.ok(offset >= previous)
    previous = offset
  }
})

test('without balancing a lone genome keeps the plain proportional rail', () => {
  const lone = placeScrollRailStops([{ key: 'human', scrollTop: 26 }], geometry, { balanced: true })
  assert.equal(lone[0].balanced, undefined)
  assert.equal(railOffsetForScroll(1200, geometry, lone), geometry.padding + geometry.track)
})
