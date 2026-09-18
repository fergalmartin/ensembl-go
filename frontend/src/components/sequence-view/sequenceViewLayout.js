// The view's geometry: how tall a row is, and how wide a base cell has to be for
// sixty of them plus both coordinate gutters to fit the space available.
//
// Rows are all `BASE_ROW_PX` tall, except the ones carrying an extra lane: a row
// over coding sequence is taller by `PROTEIN_LANE_PX` while the protein is being
// drawn. That was one height for a long time, because it is what lets the
// scroller turn a scroll position into a row with one multiply -- and it still
// is, wherever there are no lanes. Where there are, the scroller asks a height
// index instead (utils/sequenceViewHeights.js), which is a binary search over
// the handful of runs the CDS segments make rather than a table with an entry
// per row. See its own note for why the two cannot both be expensive at once.
//
// Width is the opposite: it is not fixed, because sixty bases a row is the point
// of this view and a reader should never have to scroll sideways to finish a
// line. So the cell width is whatever makes a row fit, and the row is centred in
// what is left of the window. Collapsing the panel gives the width back and the
// cells grow into it.

export const BASE_ROW_PX = 26
export const BASES_PER_ROW = 60

// The lane the protein is drawn in, above the bases. Tall enough for a letter at
// the size the gutters use, and no taller: it is added to every row at once, so
// a pixel here is a pixel off how much sequence fits on the screen.
export const PROTEIN_LANE_PX = 18

// Wide enough for a nine-figure coordinate with thousands separators at 11px,
// which is the longest thing a gutter has to hold.
export const GUTTER_WIDTH = 92

// A cell narrower than this cannot hold a legible letter; wider than this and
// the row starts to read as a table rather than as sequence.
export const MIN_CELL_WIDTH = 8
export const MAX_CELL_WIDTH = 16

// What a comfortable row costs, for callers that need a floor before measuring.
export const MIN_ROW_WIDTH = GUTTER_WIDTH * 2 + MIN_CELL_WIDTH * BASES_PER_ROW

/** How tall a row is, given which extra tracks it carries.
 *
 * A row's own tracks, not the view's: the protein lane is drawn on the rows that
 * have coding sequence under them and nowhere else, so this answers per row
 * rather than per document. `rowHeightFor({})` is the base every row starts at.
 */
export function rowHeightFor(tracks = {}) {
    return BASE_ROW_PX + (tracks.protein ? PROTEIN_LANE_PX : 0)
}

/**
 * How wide to draw a base, and therefore a row, in the space available.
 *
 * `available` is the inside width of the scroller. A little is held back for the
 * scrollbar, which the scroller always has: without that the row would be
 * exactly as wide as the space and the scrollbar would push it into a horizontal
 * one.
 *
 * Below `MIN_ROW_WIDTH` there is no width that works, so the cells stay at their
 * minimum and the row is allowed to overflow -- a narrow window is a worse
 * answer than a sideways scrollbar, but it is not worth making the sequence
 * illegible to avoid one.
 */
export function rowMetrics(available, scrollbarPx = 12) {
    const usable = Math.max(0, Math.floor(Number(available) || 0) - Math.max(0, scrollbarPx))
    const forCells = usable - GUTTER_WIDTH * 2
    const fitted = Math.floor(forCells / BASES_PER_ROW)
    const cellWidth = Math.min(MAX_CELL_WIDTH, Math.max(MIN_CELL_WIDTH, fitted))
    const rowWidth = GUTTER_WIDTH * 2 + cellWidth * BASES_PER_ROW
    return {
        cellWidth,
        rowWidth,
        // The letter has to sit inside the cell whatever width it ended up.
        fontSize: Math.min(13, Math.max(9, cellWidth - 2)),
        fits: rowWidth <= usable,
    }
}
