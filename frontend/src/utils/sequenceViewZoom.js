// Reading the sequence from further away.
//
// At full size the view is what it has always been: sixty letters a row, a
// coordinate down each margin, every base its own element and every one of them
// clickable. That is the right thing for reading sequence and the wrong thing
// for seeing shape -- where the exons of a transcript fall, how much of a gene
// is intron, whether the thing being looked for is above or below. Answering
// that meant scrolling and remembering.
//
// Zooming out keeps the same rows and shrinks them. Sixty bases a row does not
// change -- it is what the view is -- so a smaller row is not more sequence per
// line but more lines on the screen, which is exactly the axis the question is
// asked along.
//
// Below full size the letters go. They are unreadable long before the row is
// small enough to be worth zooming out for, and drawing them is what makes the
// view expensive: a screenful at a quarter size is four times the rows and four
// times the elements, which is a slideshow. So anything short of full size is
// drawn as one canvas of coloured blocks instead -- no elements per base, no
// sequence to fetch, and the colours that carry the annotation kept exactly as
// they are. See components/sequence-view/SequenceOverview.jsx.

import {
    BASE_ROW_PX,
    BASES_PER_ROW,
    GUTTER_WIDTH,
    PROTEIN_LANE_PX,
} from '../components/sequence-view/sequenceViewLayout.js'

/** Full size: every base its own cell, with its letter. */
export const ZOOM_FULL = 1

/** As far out as it goes. Below this a row is under two pixels and a whole
 *  exon is a smudge, so there is nothing further to see. */
export const ZOOM_MIN = 0.1

/** What the slider moves in. */
export const ZOOM_STEP = 0.05

/** The sizes the buttons beside the slider jump between. */
export const ZOOM_STOPS = Object.freeze([0.1, 0.25, 0.5, 0.75, 1])

/** A number, or null for anything that is not one.
 *
 * `Number(null)` is 0 and `Number('')` is 0, and either would be read here as a
 * reader having asked for the smallest size when they have asked for nothing at
 * all -- the same trap `sequenceViewPrefs` guards against with the same words.
 */
function num(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

export function clampZoom(value) {
    const zoom = num(value)
    if (zoom === null) return ZOOM_FULL
    return Math.min(ZOOM_FULL, Math.max(ZOOM_MIN, zoom))
}

/** Whether this is the drawn-from-a-distance view rather than the readable one. */
export function isOverview(zoom) {
    return clampZoom(zoom) < ZOOM_FULL
}

/**
 * The geometry at a given zoom.
 *
 * `metrics` is what `rowMetrics` worked out for the full-size view -- the cell
 * width that makes sixty of them plus both gutters fit the window. Everything
 * scales from that together, so the row keeps its proportions and the gutters
 * keep their share of the width.
 *
 * The row height has a floor of one pixel: at the bottom of the range a row is
 * two or three pixels, and a row of zero would make the scroller's arithmetic
 * meaningless rather than the view merely small.
 */
export function zoomedGeometry(zoom, metrics, { protein = false } = {}) {
    const scale = clampZoom(zoom)
    const cellWidth = Math.max(0.5, (metrics?.cellWidth || 0) * scale)
    const gutterWidth = Math.max(0, Math.round(GUTTER_WIDTH * scale))
    // The lane is a reading of the bases, and there are no bases to read from
    // at this size. Dropping it also keeps every row the same height, which is
    // what lets the overview place a row with one multiply.
    const laneHeight = protein && scale === ZOOM_FULL ? PROTEIN_LANE_PX : 0
    return {
        scale,
        overview: scale < ZOOM_FULL,
        cellWidth,
        gutterWidth,
        laneHeight,
        rowHeight: Math.max(1, Math.round(BASE_ROW_PX * scale)),
        rowWidth: Math.round(gutterWidth * 2 + cellWidth * BASES_PER_ROW),
        // The bar drawn for a base, a shade under the cell so neighbouring runs
        // of one colour still read as one band rather than a hairline grid.
        fontSize: Math.max(7, Math.round((metrics?.fontSize || 11) * scale)),
    }
}

/**
 * How often a coordinate is worth printing down the margin.
 *
 * Every row at full size. Zoomed out the numbers would overlap each other long
 * before the rows became hard to count, so they thin out -- enough of them to
 * keep the reader placed, never so many that they smear into a grey column.
 */
export function gutterEvery(rowHeight, minimumPx = 13) {
    const height = Math.max(1, num(rowHeight) || 1)
    return Math.max(1, Math.ceil(minimumPx / height))
}

/**
 * What the margin can hold, given how wide it has ended up.
 *
 * A coordinate is eleven characters with its separators, and the margin scales
 * with everything else -- so a tenth of the way out it is nine pixels wide and
 * a number drawn into it is one digit and a half. A digit and a half is worse
 * than nothing: it looks like information and is not. So the margin says what
 * it has room to say, and where it has room for nothing it says nothing.
 */
export function gutterDetail(gutterWidth) {
    const width = Math.max(0, Number(gutterWidth) || 0)
    if (width >= 60) return 'full'
    if (width >= 30) return 'short'
    return 'none'
}

/**
 * A coordinate short enough for a narrow margin.
 *
 * Three significant figures and a unit, which is enough to know where on the
 * chromosome the eye is without being enough to look anything up -- which is
 * the right trade at a size where the sequence itself is not readable either.
 */
export function compactCoordinate(value) {
    const at = num(value)
    if (at === null) return ''
    if (Math.abs(at) >= 1_000_000) return `${(at / 1_000_000).toFixed(2)}M`
    if (Math.abs(at) >= 1_000) return `${(at / 1_000).toFixed(1)}k`
    return String(Math.round(at))
}

/** The coordinate a margin of this width should print, or '' for none. */
export function gutterLabel(value, gutterWidth) {
    const at = num(value)
    const detail = gutterDetail(gutterWidth)
    if (detail === 'none' || at === null) return ''
    return detail === 'full' ? at.toLocaleString() : compactCoordinate(at)
}

/**
 * Where along its travel the slider sits, from 0 at the far end to 1 at full
 * size.
 *
 * The track is painted from this rather than left to `accent-color`, which
 * fills only as far as the *centre* of the thumb -- so at full size a stub of
 * unfilled track was left showing past it, and the slider read as though there
 * were somewhere further to go.
 */
export function zoomFraction(zoom) {
    const span = ZOOM_FULL - ZOOM_MIN
    if (!(span > 0)) return 1
    // Rounded, because this ends up in a CSS `calc` and in the DOM: a track
    // ninety pixels wide cannot tell 0.5 from 0.5000000000000001, and only one
    // of them is worth reading in an inspector.
    return Math.round(((clampZoom(zoom) - ZOOM_MIN) / span) * 1e4) / 1e4
}

/** A zoom as the reader would say it. */
export function zoomLabel(zoom) {
    return `${Math.round(clampZoom(zoom) * 100)}%`
}

/** The next stop up or down from where the reader is. */
export function nextZoomStop(zoom, direction) {
    const current = clampZoom(zoom)
    if (direction < 0) {
        const below = ZOOM_STOPS.filter((stop) => stop < current - 1e-6)
        return below.length ? below[below.length - 1] : ZOOM_MIN
    }
    const above = ZOOM_STOPS.filter((stop) => stop > current + 1e-6)
    return above.length ? above[0] : ZOOM_FULL
}
