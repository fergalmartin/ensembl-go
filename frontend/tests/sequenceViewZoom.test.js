import test from 'node:test'
import assert from 'node:assert/strict'

import {
    ZOOM_FULL,
    ZOOM_MIN,
    ZOOM_STOPS,
    clampZoom,
    compactCoordinate,
    gutterDetail,
    gutterEvery,
    gutterLabel,
    isOverview,
    nextZoomStop,
    zoomFraction,
    zoomLabel,
    zoomedGeometry,
} from '../src/utils/sequenceViewZoom.js'
import { BASE_ROW_PX, BASES_PER_ROW, GUTTER_WIDTH } from '../src/components/sequence-view/sequenceViewLayout.js'

const metrics = { cellWidth: 12, fontSize: 11 }

test('full size is the readable view and anything short of it is not', () => {
    assert.equal(isOverview(ZOOM_FULL), false)
    assert.equal(isOverview(0.99), true)
    assert.equal(isOverview(ZOOM_MIN), true)
    assert.equal(zoomedGeometry(ZOOM_FULL, metrics).overview, false)
    assert.equal(zoomedGeometry(0.5, metrics).overview, true)
})

test('a zoom outside the range is brought back into it', () => {
    assert.equal(clampZoom(5), ZOOM_FULL)
    assert.equal(clampZoom(0), ZOOM_MIN)
    assert.equal(clampZoom(-1), ZOOM_MIN)
    // Anything that is not a number reads as full size, which is the view the
    // reader had before they touched anything.
    assert.equal(clampZoom('nonsense'), ZOOM_FULL)
    assert.equal(clampZoom(null), ZOOM_FULL)
    assert.equal(clampZoom(undefined), ZOOM_FULL)
})

test('at full size the geometry is exactly what the view already had', () => {
    const at = zoomedGeometry(ZOOM_FULL, metrics, { protein: true })
    assert.equal(at.cellWidth, 12)
    assert.equal(at.gutterWidth, GUTTER_WIDTH)
    assert.equal(at.rowHeight, BASE_ROW_PX)
    assert.equal(at.rowWidth, GUTTER_WIDTH * 2 + 12 * BASES_PER_ROW)
    // The protein lane survives only at full size, where there are bases to
    // read it from.
    assert.ok(at.laneHeight > 0)
})

test('everything scales together, so the block keeps its proportions', () => {
    const half = zoomedGeometry(0.5, metrics)
    assert.equal(half.cellWidth, 6)
    assert.equal(half.gutterWidth, Math.round(GUTTER_WIDTH / 2))
    assert.equal(half.rowHeight, Math.round(BASE_ROW_PX / 2))
    assert.equal(half.laneHeight, 0, 'no lane without bases to read')
    // Sixty bases a row is what the view is, at every size.
    assert.equal(half.rowWidth, Math.round(half.gutterWidth * 2 + 6 * BASES_PER_ROW))
})

test('a row never shrinks to nothing, however far out the reader stands', () => {
    for (const zoom of [ZOOM_MIN, 0.02, 0]) {
        const at = zoomedGeometry(zoom, { cellWidth: 8, fontSize: 9 })
        assert.ok(at.rowHeight >= 1, `row height at ${zoom}`)
        assert.ok(at.cellWidth > 0, `cell width at ${zoom}`)
    }
})

test('shorter rows mean more of them on the screen, which is the point', () => {
    const viewport = 600
    const full = zoomedGeometry(ZOOM_FULL, metrics)
    const quarter = zoomedGeometry(0.25, metrics)
    const rowsAt = (geometry) => Math.floor(viewport / geometry.rowHeight)
    assert.ok(rowsAt(quarter) > rowsAt(full) * 3)
})

test('the margin says what it has room for, and nothing where it has none', () => {
    assert.equal(gutterDetail(GUTTER_WIDTH), 'full')
    assert.equal(gutterDetail(40), 'short')
    assert.equal(gutterDetail(9), 'none')
    assert.equal(gutterLabel(119_712_054, GUTTER_WIDTH), '119,712,054')
    assert.equal(gutterLabel(119_712_054, 40), '119.71M')
    // A digit and a half looks like information and is not, so a margin this
    // narrow prints nothing at all.
    assert.equal(gutterLabel(119_712_054, 9), '')
    assert.equal(gutterLabel(null, GUTTER_WIDTH), '')
})

test('a short coordinate keeps enough to place the eye', () => {
    assert.equal(compactCoordinate(119_712_054), '119.71M')
    assert.equal(compactCoordinate(45_600), '45.6k')
    assert.equal(compactCoordinate(940), '940')
    assert.equal(compactCoordinate(NaN), '')
})

test('coordinates thin out as the rows close up', () => {
    assert.equal(gutterEvery(BASE_ROW_PX), 1, 'every row at full size')
    assert.ok(gutterEvery(6) > 1)
    assert.ok(gutterEvery(2) > gutterEvery(6))
    // Never zero, which would be a division by nothing in the caller.
    assert.ok(gutterEvery(0) >= 1)
})

test('the stops step through the range and stop at its ends', () => {
    assert.equal(nextZoomStop(ZOOM_FULL, 1), ZOOM_FULL)
    assert.equal(nextZoomStop(ZOOM_MIN, -1), ZOOM_MIN)
    assert.equal(nextZoomStop(ZOOM_FULL, -1), ZOOM_STOPS[ZOOM_STOPS.length - 2])
    assert.equal(nextZoomStop(ZOOM_MIN, 1), ZOOM_STOPS[1])
    // A zoom between two stops goes to the next one in that direction rather
    // than snapping back to where it came from.
    assert.equal(nextZoomStop(0.4, 1), 0.5)
    assert.equal(nextZoomStop(0.4, -1), 0.25)
})

test('the slider is full at full size and empty at the far end', () => {
    // The track is painted from this. Left to the browser the fill stops at the
    // thumb's centre, which left a stub of empty track past it at full size --
    // a slider that looked as though it had somewhere further to go.
    assert.equal(zoomFraction(ZOOM_FULL), 1)
    assert.equal(zoomFraction(ZOOM_MIN), 0)
    assert.equal(zoomFraction(0.55), 0.5)
    // Off either end reads as that end rather than past it.
    assert.equal(zoomFraction(2), 1)
    assert.equal(zoomFraction(0), 0)
})

test('a zoom is said the way the slider shows it', () => {
    assert.equal(zoomLabel(1), '100%')
    assert.equal(zoomLabel(0.25), '25%')
    assert.equal(zoomLabel(0.1), '10%')
})
