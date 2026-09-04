import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEQUENCE_TRACK_HEIGHT,
  alignBandToBar,
  frameRangeWithRightInset,
  getAnchoredContentPageScrollDelta,
  getFeatureRowAnchor,
  getFeatureRowTargetY,
  getGenomeBrowserPanelSizing,
  rebalanceRangeForInsetChange,
  shouldRenderViewportTranscriptStructures,
} from '../src/components/genomeBrowserViewportLayout.js'

test('sequence track height is fixed', () => {
  assert.equal(SEQUENCE_TRACK_HEIGHT, 36)
})

test('a single non-adaptive browser fills its allocated viewport without a minimum band height', () => {
  assert.deepEqual(getGenomeBrowserPanelSizing(1, false), {
    usesContentHeight: false,
    fillsAvailableHeight: true,
    panelMinHeight: null,
  })
})

test('multi-browser and adaptive layouts retain their explicit sizing modes', () => {
  // Only a safety floor: the real uniform band height is negotiated at runtime
  // from the tallest panel's content, so this must stay well under a real panel.
  assert.equal(getGenomeBrowserPanelSizing(3, false).panelMinHeight, 200)
  assert.deepEqual(getGenomeBrowserPanelSizing(1, true), {
    usesContentHeight: true,
    fillsAvailableHeight: false,
    panelMinHeight: null,
  })
})

test('gene structures switch as one viewport only after every visible transcript result is ready', () => {
  const common = {
    viewSpan: 400_000,
    detailMaxSpan: 500_000,
    geneIds: ['gene-a', 'gene-b'],
  }

  assert.equal(shouldRenderViewportTranscriptStructures({
    ...common,
    transcriptCache: { 'gene-a': [{}] },
  }), false)

  assert.equal(shouldRenderViewportTranscriptStructures({
    ...common,
    transcriptCache: { 'gene-a': [{}], 'gene-b': [] },
  }), true)
})

test('all genes return to blocks together above the transcript-detail zoom threshold', () => {
  assert.equal(shouldRenderViewportTranscriptStructures({
    viewSpan: 500_001,
    detailMaxSpan: 500_000,
    geneIds: ['gene-a', 'gene-b'],
    transcriptCache: { 'gene-a': [{}], 'gene-b': [{}] },
  }), false)
})

test('the transcript subrow under the pointer is captured semantically', () => {
  assert.deepEqual(getFeatureRowAnchor({
    baseGeneY: 100,
    pointerY: 254,
    rowPitch: 20,
    midOffset: 10,
    transcriptIds: ['tx0', 'tx1', 'tx2', 'tx3', 'tx4', 'tx5', 'tx6', 'tx7'],
  }), {
    rowIndex: 7,
    transcriptId: 'tx7',
    rowOffset: 4,
  })
})

test('a transcript anchor follows the same transcript when row packing changes', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 36,
    rowPitch: 20,
    midOffset: 10,
    transcriptId: 'tx7',
    fallbackRowIndex: 7,
    rowOffset: 4,
    visibleTranscriptIds: ['tx2', 'tx4', 'tx7'],
  }), 90)
})

test('a disappearing transcript row maps to the collapsed gene row', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 36,
    rowPitch: 20,
    midOffset: 10,
    transcriptId: 'tx7',
    fallbackRowIndex: 7,
    rowOffset: 4,
    visibleTranscriptIds: [],
  }), 50)
})

test('a collapsed gene maps to the first corresponding row when detail appears', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 80,
    rowPitch: 20,
    midOffset: 10,
    fallbackRowIndex: 0,
    visibleTranscriptIds: ['canonical', 'alternative'],
  }), 90)
})

test('scroll anchoring keeps the resolved feature row under the pointer', () => {
  assert.equal(getAnchoredContentPageScrollDelta({
    containerTop: 100,
    contentY: 400,
    clientY: 450,
  }), 50)
})

// The focus drawer floats over the right edge of the track, so a gene framed
// across the full width would sit half-hidden behind it.
test('framing with no right inset leaves the range untouched', () => {
  assert.deepEqual(
    frameRangeWithRightInset({ start: 100, end: 200, trackWidthPx: 1000, rightInsetPx: 0 }),
    { start: 100, end: 200 }
  )
})

test('a right inset slides the window so the gene centres in the visible part', () => {
  const framed = frameRangeWithRightInset({
    start: 100, end: 200, trackWidthPx: 1000, rightInsetPx: 300,
  })
  const visibleWidth = 700
  const bpPerPx = (framed.end - framed.start) / 1000
  // The gene's centre must land halfway across the uncovered width.
  const centreOffsetPx = (150 - framed.start) / bpPerPx
  assert.ok(Math.abs(centreOffsetPx - visibleWidth / 2) < 1e-6)
})

test('a right inset keeps the gene filling the same share of the visible width', () => {
  const framed = frameRangeWithRightInset({
    start: 100, end: 200, trackWidthPx: 1000, rightInsetPx: 300,
  })
  const bpPerPx = (framed.end - framed.start) / 1000
  // The incoming 100bp window filled the full 1000px track; it should now fill
  // the 700px that remain visible.
  assert.ok(Math.abs((100 / bpPerPx) - 700) < 1e-6)
})

test('a flipped panel centres the gene on the same visible half', () => {
  const framed = frameRangeWithRightInset({
    start: 100, end: 200, trackWidthPx: 1000, rightInsetPx: 300, flipped: true,
  })
  const bpPerPx = (framed.end - framed.start) / 1000
  const centreOffsetPx = (framed.end - 150) / bpPerPx
  assert.ok(Math.abs(centreOffsetPx - 350) < 1e-6)
})

test('an inset wider than the track still returns a usable window', () => {
  const framed = frameRangeWithRightInset({
    start: 100, end: 200, trackWidthPx: 1000, rightInsetPx: 4000,
  })
  assert.ok(Number.isFinite(framed.start) && Number.isFinite(framed.end))
  assert.ok(framed.end > framed.start)
})

test('framing rejects a degenerate range', () => {
  assert.equal(
    frameRangeWithRightInset({ start: 200, end: 100, trackWidthPx: 1000, rightInsetPx: 300 }),
    null
  )
})

// ---------------------------------------------------------------------------
// Re-balancing when the drawer opens or closes
// ---------------------------------------------------------------------------

const TRACK = 1550
const OPEN = 300
const RAIL = 36

test('collapsing the drawer zooms in by the ratio of visible widths', () => {
  const next = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 1_050_000,
  })
  const ratio = (TRACK - OPEN) / (TRACK - RAIL)
  assert.ok(Math.abs((next.end - next.start) - (100_000 * ratio)) < 1e-6)
  // Zooming in, not out: the uncovered track has to be filled.
  assert.ok(next.end - next.start < 100_000)
})

test('the gene ends up centred in what the drawer leaves visible', () => {
  const next = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 1_050_000,
  })
  const bpPerPx = (next.end - next.start) / TRACK
  const centrePx = (1_050_000 - next.start) / bpPerPx
  assert.ok(Math.abs(centrePx - ((TRACK - RAIL) / 2)) < 1e-6)
})

test('re-opening the drawer undoes the span change exactly', () => {
  const collapsed = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 1_050_000,
  })
  const reopened = rebalanceRangeForInsetChange({
    start: collapsed.start, end: collapsed.end, trackWidthPx: TRACK,
    fromInsetPx: RAIL, toInsetPx: OPEN, focusCentre: 1_050_000,
  })
  assert.ok(Math.abs((reopened.end - reopened.start) - 100_000) < 1e-6)
})

test('the rescale is proportional, so a zoomed-out view is not hauled back in', () => {
  const near = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 1_050_000,
  })
  const far = rebalanceRangeForInsetChange({
    start: 0, end: 10_000_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 5_000_000,
  })
  const nearFactor = (near.end - near.start) / 100_000
  const farFactor = (far.end - far.start) / 10_000_000
  assert.ok(Math.abs(nearFactor - farFactor) < 1e-9)
})

test('an unchanged inset leaves the range alone', () => {
  const next = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: OPEN, focusCentre: 1_020_000,
  })
  assert.deepEqual(next, { start: 1_000_000, end: 1_100_000 })
})

test('a flipped panel centres the gene on the same side of the screen', () => {
  const next = rebalanceRangeForInsetChange({
    start: 1_000_000, end: 1_100_000, trackWidthPx: TRACK,
    fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 1_050_000, flipped: true,
  })
  const bpPerPx = (next.end - next.start) / TRACK
  // Flipped, screen-left is the high coordinate, so the visible centre is
  // measured back from the range end.
  const centrePx = (next.end - 1_050_000) / bpPerPx
  assert.ok(Math.abs(centrePx - ((TRACK - RAIL) / 2)) < 1e-6)
})

test('re-balancing rejects a degenerate range or a missing centre', () => {
  assert.equal(rebalanceRangeForInsetChange({
    start: 200, end: 100, trackWidthPx: TRACK, fromInsetPx: OPEN, toInsetPx: RAIL, focusCentre: 150,
  }), null)
  assert.equal(rebalanceRangeForInsetChange({
    start: 100, end: 200, trackWidthPx: TRACK, fromInsetPx: OPEN, toInsetPx: RAIL,
  }), null)
})

// ---------------------------------------------------------------------------
// Snapping the drawer's band to the gene-of-focus bar
// ---------------------------------------------------------------------------

test('the band ends exactly where the bar ends', () => {
  const { top, height } = alignBandToBar({ barTop: 100.5, barHeight: 52.5, hostTop: 0 })
  assert.equal(top + height, Math.round(100.5 + 52.5))
})

test('rounding the offset and the height apart is what pushed the band low', () => {
  // The pair that used to compound: round(0.5) + round(52.5) = 54, a pixel below
  // the bar's own rounded bottom of 53.
  const naive = Math.round(0.5) + Math.round(52.5)
  const { top, height } = alignBandToBar({ barTop: 0.5, barHeight: 52.5 })
  assert.equal(naive, 54)
  assert.equal(top + height, 53)
})

test('no fractional bar leaves the band even a pixel out', () => {
  for (let topTenths = 0; topTenths < 40; topTenths += 1) {
    for (let heightTenths = 0; heightTenths < 40; heightTenths += 1) {
      const barTop = 100 + (topTenths / 10)
      const barHeight = 40 + (heightTenths / 10)
      const { top, height } = alignBandToBar({ barTop, barHeight, hostTop: 12.3 })
      assert.equal(top + height, Math.round((barTop - 12.3) + barHeight))
      assert.equal(top, Math.round(barTop - 12.3))
    }
  }
})

test('a whole-pixel bar is passed through unchanged', () => {
  assert.deepEqual(alignBandToBar({ barTop: 322, barHeight: 52, hostTop: 222 }), { top: 100, height: 52 })
})

test('band snapping rejects nonsense input', () => {
  assert.equal(alignBandToBar({ barTop: NaN, barHeight: 52 }), null)
})

test("a locus around the focused gene clears the drawer that is over the track", () => {
  // The drawer is `absolute right-0` — it overlays the canvas rather than narrowing it, so
  // the window never shrank and a range centred across the full track puts the far end of
  // the gene underneath it. The tutorial's REG4 step is the case that showed it: its
  // declared window is symmetrical around the gene, which is exactly wrong once ~19% of
  // the right-hand side is covered.
  const REG4 = { start: 119_794_017, end: 119_811_580 }
  const declared = { start: 119_790_017, end: 119_815_580 }
  const trackWidth = 1550
  const drawer = 300
  const visible = trackWidth - drawer
  const pixelOf = (bp, range) => ((bp - range.start) / (range.end - range.start)) * trackWidth

  assert.ok(pixelOf(REG4.end, declared) > visible, 'the unframed window must hide the gene end')

  const framed = frameRangeWithRightInset({
    ...declared, trackWidthPx: trackWidth, rightInsetPx: drawer,
  })
  const left = pixelOf(REG4.start, framed)
  const right = pixelOf(REG4.end, framed)
  assert.ok(right <= visible, `the gene still runs under the drawer, to ${right}`)
  assert.ok(left > 0, 'and has not been pushed off the left edge')
  // Centred in what stays visible, rather than in the whole track.
  assert.ok(Math.abs(left - (visible - right)) < 1, 'the gene is not centred in the visible width')
})
