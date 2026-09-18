// The dim-and-cut-a-hole geometry behind the screenshot and tutorial overlays.
//
// These are the cases that are painful to check in the running app: a target scrolled
// half out of view, a hole flush against a container edge, a container with no area.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  areRectListsEqual,
  areRectsEqual,
  areSizesEqual,
  blockerRects,
  clipRectToContainer,
  cutoutPathD,
  expandRect,
  nonOverlappingRects,
  placeCard,
  rectClearOfOccluders,
  unionRect,
  visibleElementRect,
} from '../src/utils/overlayGeometry.js'

const container = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }

const viewportRectOf = ({ left, top, width, height }) => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

test('clipping rebases a viewport rect onto the container', () => {
  const clipped = clipRectToContainer(
    viewportRectOf({ left: 200, top: 150, width: 100, height: 40 }),
    container
  )
  assert.deepEqual(clipped, { left: 100, top: 100, width: 100, height: 40 })
})

test('a target hanging off the edge is clipped, not dropped', () => {
  const clipped = clipRectToContainer(
    viewportRectOf({ left: 850, top: 150, width: 200, height: 40 }),
    container
  )
  assert.deepEqual(clipped, { left: 750, top: 100, width: 50, height: 40 })
})

test('a target scrolled entirely out of view reads as not visible', () => {
  const above = clipRectToContainer(
    viewportRectOf({ left: 200, top: -100, width: 100, height: 40 }),
    container
  )
  const right = clipRectToContainer(
    viewportRectOf({ left: 1000, top: 150, width: 100, height: 40 }),
    container
  )
  assert.equal(above, null)
  assert.equal(right, null)
})

test('missing rects clip to nothing rather than throwing', () => {
  assert.equal(clipRectToContainer(null, container), null)
  assert.equal(clipRectToContainer(viewportRectOf({ left: 0, top: 0, width: 10, height: 10 }), null), null)
})

test('an anchor clipped above its scrolling ancestor has no visible ghost rectangle', () => {
  const scroller = {
    parentElement: null,
    getBoundingClientRect: () => viewportRectOf({ left: 500, top: 300, width: 400, height: 500 }),
  }
  const anchor = {
    parentElement: scroller,
    getBoundingClientRect: () => viewportRectOf({ left: 850, top: 120, width: 24, height: 24 }),
  }
  const readStyle = (node) => node === scroller
    ? { overflowX: 'hidden', overflowY: 'auto' }
    : { overflow: 'visible' }

  assert.equal(
    visibleElementRect(anchor, viewportRectOf({ left: 0, top: 0, width: 1400, height: 900 }), readStyle),
    null
  )
})

test('a partially clipped anchor is measured only where the user can see it', () => {
  const scroller = {
    parentElement: null,
    getBoundingClientRect: () => viewportRectOf({ left: 500, top: 300, width: 400, height: 500 }),
  }
  const anchor = {
    parentElement: scroller,
    getBoundingClientRect: () => viewportRectOf({ left: 850, top: 290, width: 24, height: 24 }),
  }
  const actual = visibleElementRect(
    anchor,
    viewportRectOf({ left: 0, top: 0, width: 1400, height: 900 }),
    () => ({ overflowX: 'hidden', overflowY: 'auto' })
  )
  assert.deepEqual(actual, { left: 850, top: 300, width: 24, height: 14 })
})

const elementAt = (rect, extra = {}) => ({
  getBoundingClientRect: () => rect,
  contains: () => false,
  ...extra,
})

test('a panel scrolled under the sticky control bar is measured from below it', () => {
  // The bar covers the panel rather than clipping it, so nothing in the ancestor walk
  // knows about it: without this the spotlight paints its ring across the bar and lights
  // up buttons the step is not talking about.
  const bar = elementAt(viewportRectOf({ left: 24, top: 188, width: 1334, height: 53 }))
  const panel = viewportRectOf({ left: 813, top: 174, width: 551, height: 594 })
  assert.deepEqual(rectClearOfOccluders(panel, null, [bar]), {
    left: 813, top: 241, right: 1364, bottom: 768, width: 551, height: 527,
  })
})

test('chrome trims only the edge it buries', () => {
  const footer = elementAt(viewportRectOf({ left: 0, top: 700, width: 1000, height: 60 }))
  const list = viewportRectOf({ left: 100, top: 300, width: 500, height: 420 })
  const trimmed = rectClearOfOccluders(list, null, [footer])
  assert.equal(trimmed.top, 300)
  assert.equal(trimmed.bottom, 700)
})

test('a target that is the chrome, or lives inside it, is left whole', () => {
  const barRect = viewportRectOf({ left: 24, top: 188, width: 1334, height: 53 })
  const bar = elementAt(barRect, { contains: (node) => node === 'inside' })
  assert.deepEqual(rectClearOfOccluders(barRect, bar, [bar]), {
    left: 24, top: 188, right: 1358, bottom: 241, width: 1334, height: 53,
  })
  const button = viewportRectOf({ left: 40, top: 196, width: 80, height: 32 })
  assert.equal(rectClearOfOccluders(button, 'inside', [bar]).top, 196)
})

test('chrome beside a target, or covering it completely, is handled', () => {
  const bar = elementAt(viewportRectOf({ left: 24, top: 188, width: 200, height: 53 }))
  const panel = viewportRectOf({ left: 813, top: 174, width: 551, height: 594 })
  // No horizontal overlap at all: the target keeps its own top.
  assert.equal(rectClearOfOccluders(panel, null, [bar]).top, 174)
  const blanket = elementAt(viewportRectOf({ left: 0, top: 0, width: 1400, height: 900 }))
  assert.equal(rectClearOfOccluders(panel, null, [blanket]), null)
})

test('a fixed dialog is not clipped by whatever scrolls behind it', () => {
  // The app's content region scrolls and starts below the header. A dialog centred over
  // the whole window is laid out against the viewport, not against that region, so
  // clipping it there took the top off the spotlight of every step about a dialog.
  const page = {
    parentElement: null,
    getBoundingClientRect: () => viewportRectOf({ left: 0, top: 200, width: 1440, height: 560 }),
  }
  const backdrop = {
    parentElement: page,
    getBoundingClientRect: () => viewportRectOf({ left: 0, top: 0, width: 1440, height: 760 }),
  }
  const dialog = {
    parentElement: backdrop,
    getBoundingClientRect: () => viewportRectOf({ left: 432, top: 143, width: 576, height: 472 }),
  }
  const readStyle = (node) => {
    if (node === page) return { overflowY: 'auto', position: 'static' }
    if (node === backdrop) return { overflow: 'visible', position: 'fixed' }
    return { overflow: 'visible', position: 'static' }
  }
  assert.deepEqual(
    visibleElementRect(dialog, viewportRectOf({ left: 0, top: 0, width: 1440, height: 760 }), readStyle),
    { left: 432, top: 143, width: 576, height: 472 },
  )

  // An ancestor that becomes the dialog's containing block does clip it again.
  const transformed = (node) => {
    if (node === page) return { overflowY: 'auto', position: 'static', transform: 'translateZ(0)' }
    if (node === backdrop) return { overflow: 'visible', position: 'fixed' }
    return { overflow: 'visible', position: 'static' }
  }
  const clipped = visibleElementRect(
    dialog,
    viewportRectOf({ left: 0, top: 0, width: 1440, height: 760 }),
    transformed,
  )
  assert.equal(clipped.top, 200)
})

test('rect and size comparisons drive the re-render guards', () => {
  assert.ok(areRectsEqual({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 4 }))
  assert.ok(!areRectsEqual({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 5 }))
  assert.ok(areRectsEqual(null, null))
  assert.ok(!areRectsEqual(null, { left: 1, top: 2, width: 3, height: 4 }))
  assert.ok(areSizesEqual({ width: 10, height: 20 }, { width: 10, height: 20 }))
  assert.ok(!areSizesEqual({ width: 10, height: 20 }, { width: 10, height: 21 }))
})

test('rect lists compare element-wise, and length matters', () => {
  const a = [{ left: 0, top: 0, width: 5, height: 5 }, { left: 1, top: 1, width: 5, height: 5 }]
  const b = [{ left: 0, top: 0, width: 5, height: 5 }, { left: 1, top: 1, width: 5, height: 5 }]
  assert.ok(areRectListsEqual(a, b))
  assert.ok(areRectListsEqual(a, a))
  assert.ok(!areRectListsEqual(a, a.slice(0, 1)))
  assert.ok(!areRectListsEqual(a, null))
})

test('expanding a rect stays inside the container', () => {
  const size = { width: 800, height: 600 }
  assert.deepEqual(
    expandRect({ left: 100, top: 100, width: 50, height: 20 }, 6, size),
    { left: 94, top: 94, width: 62, height: 32 }
  )
  // Flush against the top-left corner: the growth is clamped, not negative.
  assert.deepEqual(
    expandRect({ left: 0, top: 0, width: 50, height: 20 }, 10, size),
    { left: 0, top: 0, width: 60, height: 30 }
  )
})

test('the cutout path punches each rect out of the filled area', () => {
  const d = cutoutPathD({ width: 800, height: 600 }, [{ left: 10, top: 20, width: 30, height: 40 }])
  assert.equal(d, 'M0 0H800V600H0Z M10 20H40V60H10Z')
})

test('zero-area cutouts are skipped so they cannot leave a seam', () => {
  const d = cutoutPathD({ width: 100, height: 100 }, [
    { left: 10, top: 10, width: 0, height: 40 },
    null,
    { left: 10, top: 10, width: 20, height: 20 },
  ])
  assert.equal(d, 'M0 0H100V100H0Z M10 10H30V30H10Z')
})

test('overlapping cutouts become one undimmed union without a double-cut region', () => {
  const target = { left: 40, top: 40, width: 20, height: 20 }
  const revealedPanel = { left: 0, top: 20, width: 100, height: 80 }
  const rects = nonOverlappingRects([target, revealedPanel])

  const overlaps = (a, b) => !(
    a.left + a.width <= b.left || b.left + b.width <= a.left
    || a.top + a.height <= b.top || b.top + b.height <= a.top
  )
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.equal(overlaps(rects[i], rects[j]), false, `cutouts ${i} and ${j} overlap`)
    }
  }

  const area = rects.reduce((sum, rect) => sum + (rect.width * rect.height), 0)
  assert.equal(area, revealedPanel.width * revealedPanel.height)
  assert.ok(rects.some((rect) => rect.left === target.left && rect.top === target.top
    && rect.width === target.width && rect.height === target.height))
})

test('a hole in the middle is surrounded by four bands that do not overlap it', () => {
  const rects = blockerRects({ width: 800, height: 600 }, { left: 300, top: 200, width: 100, height: 50 })
  assert.deepEqual(rects, [
    { left: 0, top: 0, width: 800, height: 200 },
    { left: 0, top: 250, width: 800, height: 350 },
    { left: 0, top: 200, width: 300, height: 50 },
    { left: 400, top: 200, width: 400, height: 50 },
  ])
  // Nothing covers the hole, which is what keeps the spotlit control clickable.
  const covers = (r, x, y) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height
  assert.ok(!rects.some((r) => covers(r, 350, 225)))
  // And the bands together still cover a point outside it.
  assert.ok(rects.some((r) => covers(r, 50, 50)))
})

test('a hole flush against an edge drops the band that would have zero size', () => {
  const rects = blockerRects({ width: 800, height: 600 }, { left: 0, top: 0, width: 100, height: 50 })
  assert.deepEqual(rects, [
    { left: 0, top: 50, width: 800, height: 550 },
    { left: 100, top: 0, width: 700, height: 50 },
  ])
})

test('padding widens the hole', () => {
  const rects = blockerRects({ width: 800, height: 600 }, { left: 300, top: 200, width: 100, height: 50 }, 10)
  assert.deepEqual(rects[0], { left: 0, top: 0, width: 800, height: 190 })
  assert.deepEqual(rects[1], { left: 0, top: 260, width: 800, height: 340 })
})

test('no hole, or a degenerate one, dims everything', () => {
  const size = { width: 800, height: 600 }
  const whole = [{ left: 0, top: 0, width: 800, height: 600 }]
  assert.deepEqual(blockerRects(size, null), whole)
  assert.deepEqual(blockerRects(size, { left: 10, top: 10, width: 0, height: 0 }), whole)
  // A hole entirely off-container is degenerate once clamped.
  assert.deepEqual(blockerRects(size, { left: 900, top: 700, width: 50, height: 50 }), whole)
})

test('a container with no area produces nothing to draw', () => {
  assert.deepEqual(blockerRects({ width: 0, height: 0 }, { left: 1, top: 1, width: 2, height: 2 }), [])
  assert.deepEqual(blockerRects(null, null), [])
})

// ── card placement ────────────────────────────────────────────────────────────
//
// Two failures matter here and both were seen in the running app: a card sitting on top
// of the control it is describing, and a card running off the bottom so its own buttons
// are unreachable.

const screen = { width: 1400, height: 900 }
const card = { width: 380, height: 220 }
const overlaps = (pos, hole) => !(
  pos.left >= hole.left + hole.width || pos.left + card.width <= hole.left
  || pos.top >= hole.top + hole.height || pos.top + card.height <= hole.top
)
const onScreen = (pos) => pos.left >= 0 && pos.top >= 0
  && pos.left + card.width <= screen.width && pos.top + card.height <= screen.height

test('the card goes below a target near the top, as asked', () => {
  const hole = { left: 200, top: 60, width: 120, height: 40 }
  const pos = placeCard(screen, hole, card, 'bottom')
  assert.equal(pos.placement, 'bottom')
  assert.ok(pos.top > hole.top + hole.height)
  assert.ok(onScreen(pos) && !overlaps(pos, hole))
})

test('a target near the bottom pushes the card above it rather than off the screen', () => {
  const hole = { left: 200, top: 800, width: 120, height: 40 }
  const pos = placeCard(screen, hole, card, 'bottom')
  assert.ok(onScreen(pos), 'the card must stay fully on screen')
  assert.ok(!overlaps(pos, hole), 'and must not cover the target')
  assert.notEqual(pos.placement, 'bottom')
})

test('a target near the right edge does not push the card off to the right', () => {
  const hole = { left: 1330, top: 400, width: 50, height: 40 }
  const pos = placeCard(screen, hole, card, 'right')
  assert.ok(onScreen(pos))
  assert.ok(!overlaps(pos, hole))
})

test('a wide target in the middle still gets a card that clears it', () => {
  const hole = { left: 100, top: 380, width: 1200, height: 120 }
  const pos = placeCard(screen, hole, card, 'bottom')
  assert.ok(onScreen(pos))
  assert.ok(!overlaps(pos, hole))
})

test('a very tall card near the bottom is placed by its real height, not a guess', () => {
  // This is the step-9 bug: the card was positioned as though it were short, so its
  // buttons fell off the bottom edge.
  const tall = { width: 380, height: 520 }
  const hole = { left: 300, top: 700, width: 200, height: 60 }
  const pos = placeCard(screen, hole, tall, 'bottom')
  assert.ok(pos.top >= 0 && pos.top + tall.height <= screen.height,
    `card spans ${pos.top}..${pos.top + tall.height} in a ${screen.height} tall screen`)
})

test('a target filling the screen is overlapped, and says so', () => {
  const hole = { left: 0, top: 0, width: 1400, height: 900 }
  const pos = placeCard(screen, hole, card, 'bottom')
  assert.equal(pos.overlaps, true, 'nothing can clear it, and the caller may want to know')
  assert.ok(pos.left >= 0 && pos.top >= 0)
})

test('a centred step ignores the target entirely', () => {
  const pos = placeCard(screen, { left: 10, top: 10, width: 40, height: 40 }, card, 'center')
  assert.equal(pos.placement, 'center')
  assert.equal(pos.left, Math.round((screen.width - card.width) / 2))
})

test('with no target the card is centred', () => {
  assert.equal(placeCard(screen, null, card, 'bottom').placement, 'center')
})

test('a union covers every rect given, and ignores the degenerate ones', () => {
  assert.deepEqual(
    unionRect([
      { left: 100, top: 50, width: 40, height: 20 },
      { left: 60, top: 200, width: 300, height: 90 },
      { left: 0, top: 0, width: 0, height: 0 },
      null,
    ]),
    { left: 60, top: 50, width: 300, height: 240 }
  )
  assert.equal(unionRect([]), null)
  assert.equal(unionRect(null), null)
  assert.equal(unionRect([{ left: 5, top: 5, width: 0, height: 10 }]), null)
})
