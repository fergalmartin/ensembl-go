// How a focus region is cut into rows of sequence, and what the coordinate
// gutters either side of a row say.
//
// Every coordinate in this module — and in every other module named
// sequenceView* — is 1-based inclusive on both ends, on the forward genomic
// strand. That is one convention for the whole sequence view, chosen because it
// is what the annotation tables hold, what the gutters print and what a FASTA
// header carries. /api/browse/sequence is 0-based half-open; nothing here ever
// speaks that dialect, and the conversion happens once, on the backend.
//
// Reverse display is a presentation choice, not a second coordinate system. A
// region read on the reverse strand still has the same genomic extent; only the
// order the rows are read in changes, so `reverse` is a flag on the row lookup
// rather than a different region.

export const BASES_PER_ROW = 60

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** The extent a region covers, ordered, whole-based and never empty. */
export function regionSpan(region) {
    const start = num(region?.start)
    const end = num(region?.end)
    if (start === null || end === null) return null
    const low = Math.round(Math.min(start, end))
    const high = Math.round(Math.max(start, end))
    return { start: low, end: high, length: high - low + 1 }
}

/** How many rows of BASES_PER_ROW a region fills. A region always has one. */
export function totalRows(region) {
    const span = regionSpan(region)
    if (!span) return 0
    return Math.ceil(span.length / BASES_PER_ROW)
}

/**
 * The genomic extent of one row, clipped to the region.
 *
 * The last row is short whenever the region length is not a multiple of 60,
 * which is the usual case — a transcript plus its flank rarely lands on a
 * boundary. Callers must not assume 60.
 */
export function rowRange(region, index, reverse = false) {
    const span = regionSpan(region)
    if (!span) return null
    const count = Math.ceil(span.length / BASES_PER_ROW)
    const i = Math.floor(Number(index) || 0)
    if (i < 0 || i >= count) return null

    if (!reverse) {
        const start = span.start + i * BASES_PER_ROW
        const end = Math.min(span.end, start + BASES_PER_ROW - 1)
        return { index: i, start, end, length: end - start + 1 }
    }
    // Read from the far end back: row 0 is the region's last 60 bases.
    const end = span.end - i * BASES_PER_ROW
    const start = Math.max(span.start, end - BASES_PER_ROW + 1)
    return { index: i, start, end, length: end - start + 1 }
}

/** Which row a coordinate falls in, or null when it is outside the region. */
export function rowAtCoord(region, coord, reverse = false) {
    const span = regionSpan(region)
    const position = num(coord)
    if (!span || position === null) return null
    const at = Math.round(position)
    if (at < span.start || at > span.end) return null
    return reverse
        ? Math.floor((span.end - at) / BASES_PER_ROW)
        : Math.floor((at - span.start) / BASES_PER_ROW)
}

/** A run of rows, for the slab the scroller has mounted. */
export function rowsForRange(region, firstIndex, count, reverse = false) {
    const total = totalRows(region)
    if (!total) return []
    const first = Math.max(0, Math.floor(Number(firstIndex) || 0))
    const wanted = Math.max(0, Math.floor(Number(count) || 0))
    const rows = []
    for (let i = first; i < Math.min(total, first + wanted); i += 1) {
        const row = rowRange(region, i, reverse)
        if (row) rows.push(row)
    }
    return rows
}

/**
 * The numbers printed either side of a row.
 *
 * Left is the coordinate of the first base as it is read on screen, right the
 * last — so on the reverse strand they descend, which is what makes a reverse
 * reading legible. Both are genomic coordinates either way: a reader copying
 * one into the search box lands on the base they were looking at.
 */
export function rowGutterLabels(region, index, reverse = false) {
    const row = rowRange(region, index, reverse)
    if (!row) return null
    return reverse
        ? { left: row.end, right: row.start }
        : { left: row.start, right: row.end }
}

/**
 * The coordinate under a base cell, given how far along the row it sits.
 *
 * `offset` is the cell index from the left of the row as drawn, so this is the
 * inverse of the gutter labels and follows the same reading direction.
 */
export function coordAtRowOffset(region, index, offset, reverse = false) {
    const row = rowRange(region, index, reverse)
    if (!row) return null
    const at = Math.floor(Number(offset) || 0)
    if (at < 0 || at >= row.length) return null
    return reverse ? row.end - at : row.start + at
}
