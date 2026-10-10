// Index variable row heights without allocating a record for every row.
// Protein-lane rows are inclusive {from, to} runs in document row space.
// Binary searches add the lane height only within those runs. Without runs,
// lookups reduce to ordinary multiplication and division.

function num(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

/** Runs cleaned up: ordered, inside the document, and touching ones joined. */
export function mergeRowRuns(runs, totalRows = Infinity) {
    const clean = []
    for (const run of runs || []) {
        const from = Math.max(0, Math.floor(num(run?.from, NaN)))
        const to = Math.min(totalRows - 1, Math.floor(num(run?.to, NaN)))
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue
        clean.push({ from, to })
    }
    clean.sort((a, b) => a.from - b.from || a.to - b.to)
    const out = []
    for (const run of clean) {
        const last = out[out.length - 1]
        // Adjacent runs are one run: two stretches of tall rows with nothing
        // between them have no short row to separate them.
        if (last && run.from <= last.to + 1) last.to = Math.max(last.to, run.to)
        else out.push({ ...run })
    }
    return out
}

/**
 * The row space as a list of stretches, each with one height.
 *
 * Alternating short and tall, with the offset each begins at. Two hundred-odd
 * entries at the very worst, so finding the row at a pixel -- or the pixel at a
 * row -- is a binary search over this and then one multiply.
 */
function buildSegments(totalRows, rowHeight, laneHeight, runs) {
    const segments = []
    let row = 0
    let offset = 0
    const push = (rows, height) => {
        if (rows <= 0) return
        segments.push({ from: row, rows, height, offset })
        row += rows
        offset += rows * height
    }
    for (const run of runs) {
        if (run.from > row) push(run.from - row, rowHeight)
        push(Math.min(totalRows, run.to + 1) - row, rowHeight + laneHeight)
    }
    push(totalRows - row, rowHeight)
    return segments
}

/** The segment holding a row, by binary search on where segments begin. */
function segmentAtRow(segments, row) {
    let lo = 0
    let hi = segments.length - 1
    let found = 0
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (segments[mid].from <= row) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return segments[found]
}

/** The segment holding a pixel offset, by binary search on where each begins. */
function segmentAtOffset(segments, offset) {
    let lo = 0
    let hi = segments.length - 1
    let found = 0
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (segments[mid].offset <= offset) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return segments[found]
}

/**
 * Everything that needs to know how tall a row is.
 *
 * `runs` are the rows carrying an extra lane, in document row space. With none,
 * `uniform` is true and the callers below are the arithmetic they always were.
 */
export function createHeightIndex({
    totalRows = 0,
    rowHeight = 0,
    laneHeight = 0,
    runs = null,
} = {}) {
    const rows = Math.max(0, Math.floor(num(totalRows)))
    const base = Math.max(1, num(rowHeight, 1))
    const lane = Math.max(0, num(laneHeight))
    const merged = lane > 0 ? mergeRowRuns(runs, rows) : []
    const uniform = merged.length === 0

    if (uniform) {
        return {
            totalRows: rows,
            rowHeight: base,
            laneHeight: lane,
            uniform: true,
            runs: merged,
            contentPx: rows * base,
            isTall: () => false,
            heightOfRow: () => base,
            offsetOfRow: (row) => Math.max(0, Math.min(rows, num(row))) * base,
            rowAtOffset: (offset) => Math.max(0, Math.min(rows, num(offset) / base)),
        }
    }

    const segments = buildSegments(rows, base, lane, merged)
    const contentPx = segments.reduce((total, item) => total + item.rows * item.height, 0)

    const isTall = (row) => {
        const at = Math.floor(num(row, -1))
        if (at < 0 || at >= rows) return false
        return segmentAtRow(segments, at).height > base
    }

    return {
        totalRows: rows,
        rowHeight: base,
        laneHeight: lane,
        uniform: false,
        runs: merged,
        contentPx,
        isTall,
        heightOfRow: (row) => (isTall(row) ? base + lane : base),
        /** Where a row begins, fractions included -- an anchor row is one. */
        offsetOfRow: (row) => {
            const at = Math.max(0, Math.min(rows, num(row)))
            if (at >= rows) return contentPx
            const segment = segmentAtRow(segments, Math.floor(at))
            return segment.offset + (at - segment.from) * segment.height
        },
        /** The row at a pixel offset, fractional for the same reason. */
        rowAtOffset: (offset) => {
            const px = Math.max(0, Math.min(contentPx, num(offset)))
            if (px >= contentPx) return rows
            const segment = segmentAtOffset(segments, px)
            return segment.from + (px - segment.offset) / segment.height
        },
    }
}
