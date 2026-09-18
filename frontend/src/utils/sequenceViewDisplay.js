// What the rows actually show, once the dull parts have been taken out.
//
// The view has two modes. In full mode every base of the region is drawn, in
// order. In collapsed mode the stretches a reader is not looking at -- introns
// inside a transcript or a gene, intergenic sequence between genes -- are
// replaced by a marker saying how much was skipped:
//
//     AAATTTGGC<------- 12,345 bp ------->CCCTTTAAA
//
// Both are the same thing. A layout is an ordered list of items, each either a
// stretch of sequence to draw base by base or a gap marker to draw as text, and
// full mode is simply the layout with one item and no gaps. That is deliberate:
// the alternative is two row models -- one arithmetic, one segmented -- that
// have to agree about gutter numbers, hover coordinates, selection, which
// sequence to fetch and where a coordinate jump lands. They would drift. This
// way the collapsing code runs on every row the view has ever drawn.
//
// Positions along the layout are *columns*: column 0 is the first character
// drawn, and row N holds columns [N*60, N*60+59]. Coordinates are 1-based
// inclusive genomic, as everywhere else in the sequence view.
//
// Reverse display is baked into the layout rather than applied afterwards. A
// minus-strand transcript reads from its far end, so its items are enumerated
// from the highest coordinate down and columns within an item count backwards.
// Everything downstream then works in one direction and needs no reverse case.

import { BASES_PER_ROW } from './sequenceViewRows.js'

/** Dashes either side of a gap's label, before any padding to keep it whole. */
export const GAP_DASHES = 4

/**
 * The two kinds of dull sequence, each switched on its own.
 *
 * They are different questions. Intergenic sequence is what lies between genes,
 * and a reader hiding it is looking at a region with several genes in it;
 * intronic sequence is what lies inside one, and a reader hiding that is
 * reading a gene. At a location both are on offer and a reader routinely wants
 * one without the other -- the stretch between two genes is the thing they are
 * comparing, or it is the thing in the way.
 *
 * Each carries its own flank and its own floor, because what is worth keeping
 * differs: the ends of an intron are its splice sites and are worth reading,
 * the ends of a megabase of intergenic sequence are not especially.
 */
export const COLLAPSE_KINDS = Object.freeze(['intergenic', 'intron'])

// A hundred bases either side, and nothing under three hundred is collapsed.
// The flank is what keeps the edges of a collapse readable; the floor is what
// stops a view being broken into markers over stretches short enough to have
// simply been read. Both are what the reader types over.
export const DEFAULT_COLLAPSE = Object.freeze({
    intergenic: Object.freeze({ on: false, flank: 100, min: 300 }),
    intron: Object.freeze({ on: false, flank: 100, min: 300 }),
})

/**
 * The least a gap may hide before it is worth replacing with a marker.
 *
 * A marker costs about two dozen columns, so collapsing less than that would
 * make the sequence longer rather than shorter, and would break up a run of
 * bases to save nothing. Short introns are simply drawn.
 */
export const COLLAPSE_MIN_HIDDEN = 30

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** Digits grouped in threes, without asking the host what locale it is in. */
export function groupDigits(value) {
    return String(Math.abs(Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Ordered, non-overlapping, touching intervals joined. */
export function mergeIntervals(intervals) {
    const clean = []
    for (const item of intervals || []) {
        const s = num(item?.s ?? item?.start)
        const e = num(item?.e ?? item?.end)
        if (s === null || e === null) continue
        clean.push({ s: Math.round(Math.min(s, e)), e: Math.round(Math.max(s, e)) })
    }
    clean.sort((a, b) => a.s - b.s || a.e - b.e)
    const out = []
    for (const item of clean) {
        const last = out[out.length - 1]
        // Adjacent counts as overlapping: two intervals that touch have no gap
        // between them to collapse, so leaving them apart would invent one.
        if (last && item.s <= last.e + 1) last.e = Math.max(last.e, item.e)
        else out.push({ ...item })
    }
    return out
}

/**
 * The stretches to draw in full: what was asked for, widened by the flank and
 * clipped to the region.
 *
 * The flank is what keeps a collapse readable. An intron drawn as nothing but a
 * marker hides its own splice sites, which are the most interesting bases in
 * it; keeping a few dozen either side means the collapse still shows where the
 * exon stops and what it stops against.
 */
export function keepsWithFlank(keep, flank, region) {
    const low = num(region?.start)
    const high = num(region?.end)
    if (low === null || high === null) return []
    const pad = Math.max(0, Math.round(num(flank) ?? 0))
    const widened = []
    for (const item of keep || []) {
        const s = num(item?.s ?? item?.start)
        const e = num(item?.e ?? item?.end)
        if (s === null || e === null) continue
        const from = Math.max(low, Math.min(s, e) - pad)
        const to = Math.min(high, Math.max(s, e) + pad)
        if (to >= from) widened.push({ s: from, e: to })
    }
    return mergeIntervals(widened)
}

/** What is left of a set of intervals once the holes are taken out of it. */
export function subtractIntervals(from, holes) {
    const base = mergeIntervals(from)
    const cut = mergeIntervals(holes)
    if (cut.length === 0) return base
    const out = []
    for (const span of base) {
        let cursor = span.s
        for (const hole of cut) {
            if (hole.e < cursor) continue
            if (hole.s > span.e) break
            if (hole.s > cursor) out.push({ s: cursor, e: Math.min(span.e, hole.s - 1) })
            cursor = Math.max(cursor, hole.e + 1)
            if (cursor > span.e) break
        }
        if (cursor <= span.e) out.push({ s: cursor, e: span.e })
    }
    return out
}

/** An interval with `flank` bases kept at each end, or null where that leaves
 * nothing to hide. The flank is taken off the stretch being collapsed rather
 * than added to the stretch being kept; the two are the same arithmetic, and
 * doing it this way is what lets each kind carry its own. */
function shrunk(span, flank) {
    const pad = Math.max(0, Math.round(num(flank) ?? 0))
    const s = span.s + pad
    const e = span.e - pad
    return e >= s ? { s, e } : null
}

/**
 * The stretches to draw in full, given what the reader has switched on.
 *
 * `genic` is where the genes are and `exonic` is where their exons are, both in
 * genomic coordinates within the region. Everything else falls out of those
 * two: intergenic sequence is the region minus the genes, intronic sequence is
 * the genes minus their exons. Each kind is then shrunk by its own flank and
 * dropped if the stretch was shorter than its own floor, and what is kept is
 * the region minus whatever survived.
 *
 * Doing it here rather than on the backend is what makes both switches, both
 * flanks and both floors immediate: the two span lists describe the annotation
 * and do not change when a reader changes their mind about what to look at.
 */
export function collapseKeeps({ region = null, genic = [], exonic = [], settings = DEFAULT_COLLAPSE } = {}) {
    const low = num(region?.start)
    const high = num(region?.end)
    if (low === null || high === null || high < low) return { keep: [], collapses: [] }
    const whole = [{ s: Math.round(Math.min(low, high)), e: Math.round(Math.max(low, high)) }]

    const genes = clipIntervals(genic, whole[0])
    const exons = clipIntervals(exonic, whole[0])
    const sources = {
        intergenic: subtractIntervals(whole, genes),
        intron: subtractIntervals(genes, exons),
    }

    const hide = []
    const collapses = []
    for (const kind of COLLAPSE_KINDS) {
        const choice = settings?.[kind]
        if (!choice?.on) continue
        const floor = Math.max(0, Math.round(num(choice.min) ?? 0))
        let any = false
        for (const span of sources[kind]) {
            if (span.e - span.s + 1 < floor) continue
            const cut = shrunk(span, choice.flank)
            if (!cut) continue
            hide.push(cut)
            any = true
        }
        if (any) collapses.push(kind)
    }

    return { keep: hide.length ? subtractIntervals(whole, hide) : whole, collapses }
}

/** Intervals trimmed to a window, in order. */
function clipIntervals(list, window) {
    const out = []
    for (const item of list || []) {
        const s = num(item?.s ?? item?.start)
        const e = num(item?.e ?? item?.end)
        if (s === null || e === null) continue
        const from = Math.max(window.s, Math.min(s, e))
        const to = Math.min(window.e, Math.max(s, e))
        if (to >= from) out.push({ s: from, e: to })
    }
    return mergeIntervals(out)
}

/**
 * A gap marker's text, padded so its label never straddles a row edge.
 *
 * The label is the only part a reader has to read, and a number broken across
 * two rows is worse than no number. Rather than shrinking the marker or moving
 * the break, the dashes on the left grow until the label starts late enough to
 * fit in the row it lands in -- which is what pushes it onto the next row.
 * Growing terminates: one column of padding shifts the label one column, so
 * within a row's width it reaches a column where the whole label fits.
 */
export function gapMarkerText(hidden, col0, width = BASES_PER_ROW) {
    const label = `${groupDigits(hidden)} bp`
    const start = Math.max(0, Math.round(num(col0) ?? 0))
    const row = Math.max(1, Math.floor(width))
    let left = GAP_DASHES
    if (label.length <= row) {
        for (let tries = 0; tries <= row; tries += 1) {
            const labelStart = start + left + 2
            const labelEnd = labelStart + label.length - 1
            if (Math.floor(labelStart / row) === Math.floor(labelEnd / row)) break
            left += 1
        }
    }
    return `<${'-'.repeat(left)} ${label} ${'-'.repeat(GAP_DASHES)}>`
}

/**
 * The layout for a region.
 *
 * `keep` is the set of stretches worth drawing in full, in genomic coordinates
 * and before the flank is applied; it is ignored unless `collapse` is on. What
 * comes back is the item list, in display order, with each item's first column
 * and width, plus the totals the scroller needs.
 */
export function buildDisplayLayout({
    region = null,
    keep = [],
    flank = 0,
    collapse = false,
    reverse = false,
    width = BASES_PER_ROW,
} = {}) {
    const low = num(region?.start)
    const high = num(region?.end)
    if (low === null || high === null || high < low) return null
    const start = Math.round(Math.min(low, high))
    const end = Math.round(Math.max(low, high))
    const row = Math.max(1, Math.floor(width))

    // What to draw in full, and therefore what is left over to collapse.
    let kept = collapse ? keepsWithFlank(keep, flank, { start, end }) : [{ s: start, e: end }]
    if (kept.length === 0) kept = collapse ? [] : [{ s: start, e: end }]

    // Runs are built in genomic order first; a reverse layout is that list read
    // backwards, which keeps the arithmetic in one direction.
    const runs = []
    let cursor = start
    for (const piece of kept) {
        if (piece.s > cursor) runs.push({ kind: 'gap', s: cursor, e: piece.s - 1 })
        runs.push({ kind: 'seq', s: piece.s, e: piece.e })
        cursor = piece.e + 1
    }
    if (cursor <= end) runs.push({ kind: 'gap', s: cursor, e: end })

    // A gap too short to be worth a marker is drawn instead, which means joining
    // it to its neighbours. Done before columns are assigned, so the marker
    // widths below are computed against their final positions.
    const settled = []
    for (const item of runs) {
        const previous = settled[settled.length - 1]
        const hidden = item.e - item.s + 1
        const draw = item.kind === 'seq' || hidden < COLLAPSE_MIN_HIDDEN
        if (draw && previous && previous.kind === 'seq') previous.e = item.e
        else settled.push({ kind: draw ? 'seq' : 'gap', s: item.s, e: item.e })
    }

    const ordered = reverse ? [...settled].reverse() : settled
    const items = []
    let col = 0
    let hiddenTotal = 0
    let keptTotal = 0
    for (const item of ordered) {
        if (item.kind === 'seq') {
            const cols = item.e - item.s + 1
            items.push({ kind: 'seq', s: item.s, e: item.e, col0: col, cols })
            keptTotal += cols
            col += cols
        } else {
            const hidden = item.e - item.s + 1
            const text = gapMarkerText(hidden, col, row)
            items.push({ kind: 'gap', s: item.s, e: item.e, col0: col, cols: text.length, hidden, text })
            hiddenTotal += hidden
            col += text.length
        }
    }

    // A second list, ordered by coordinate whichever way the rows read, so that
    // finding the column for a coordinate stays a binary search on both strands.
    const byCoord = items.filter((item) => item.kind === 'seq')
    if (reverse) byCoord.reverse()

    return {
        region: { start, end },
        reverse: Boolean(reverse),
        collapsed: Boolean(collapse),
        width: row,
        items,
        byCoord,
        totalCols: col,
        totalRows: Math.max(1, Math.ceil(col / row)),
        hidden: hiddenTotal,
        kept: keptTotal,
        gaps: items.filter((item) => item.kind === 'gap').length,
    }
}

/** The item covering a column, by binary search on where items begin. */
function itemAtColumn(layout, column) {
    const items = layout?.items || []
    let lo = 0
    let hi = items.length - 1
    let found = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (items[mid].col0 <= column) {
            found = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    if (found < 0) return null
    const item = items[found]
    return column <= item.col0 + item.cols - 1 ? item : null
}

/**
 * The collapsed stretch a column's marker stands for, or null over a base.
 *
 * What the reader gets when they point at a marker: there is no coordinate
 * under it, but there is an answer -- how much is missing, and between which
 * two coordinates.
 */
export function gapAtColumn(layout, column) {
    const at = num(column)
    if (!layout || at === null || at < 0 || at >= layout.totalCols) return null
    const item = itemAtColumn(layout, Math.floor(at))
    return item && item.kind === 'gap' ? item : null
}

/** The coordinate a column shows, or null where it is part of a gap marker. */
export function coordAtColumn(layout, column) {
    const at = num(column)
    if (!layout || at === null || at < 0 || at >= layout.totalCols) return null
    const item = itemAtColumn(layout, Math.floor(at))
    if (!item || item.kind !== 'seq') return null
    const into = Math.floor(at) - item.col0
    return layout.reverse ? item.e - into : item.s + into
}

/**
 * The column a coordinate is drawn at.
 *
 * A coordinate inside a collapsed stretch is not drawn anywhere, so the answer
 * is the first column of the next stretch that is -- which is what a reader
 * jumping to a hidden base wants: the nearest place it could be.
 */
export function columnAtCoord(layout, coord) {
    const at = num(coord)
    if (!layout || at === null) return null
    const list = layout.byCoord
    if (!list?.length) return null
    const want = Math.round(at)
    let lo = 0
    let hi = list.length - 1
    let found = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].s <= want) {
            found = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    if (found < 0) {
        // Before everything drawn: the first stretch, read from its own start.
        const first = list[0]
        return layout.reverse ? first.col0 + first.cols - 1 : first.col0
    }
    const item = list[found]
    if (want <= item.e) {
        return layout.reverse ? item.e - want + item.col0 : item.col0 + (want - item.s)
    }
    // Inside a collapsed stretch, or past the end: the next one drawn.
    const next = list[found + 1]
    if (!next) return layout.reverse ? 0 : layout.totalCols - 1
    return layout.reverse ? next.col0 + next.cols - 1 : next.col0
}

/** Which row a coordinate is drawn in. */
export function rowAtCoord(layout, coord) {
    const column = columnAtCoord(layout, coord)
    if (column === null) return null
    return Math.floor(column / layout.width)
}

/**
 * One row, as the pieces it is made of.
 *
 * `pieces` are the contiguous genomic stretches the row draws, each with where
 * it sits in the row; `marks` are the gap-marker fragments, already sliced to
 * the row. Between them they cover the row exactly, which is what lets the
 * sequence, the classes and the masks be built stretch by stretch out of the
 * same functions the uncollapsed view uses.
 */
export function displayRow(layout, index) {
    if (!layout) return null
    const i = Math.floor(num(index) ?? -1)
    if (i < 0 || i >= layout.totalRows) return null
    const from = i * layout.width
    const to = Math.min(layout.totalCols - 1, from + layout.width - 1)
    if (to < from) return null

    const pieces = []
    const marks = []
    let column = from
    while (column <= to) {
        const item = itemAtColumn(layout, column)
        if (!item) break
        const last = Math.min(to, item.col0 + item.cols - 1)
        const len = last - column + 1
        const into = column - item.col0
        if (item.kind === 'seq') {
            // On a reverse layout the first column drawn is the highest
            // coordinate, so the piece runs back from there.
            const e = layout.reverse ? item.e - into : item.s + into + len - 1
            const s = e - len + 1
            pieces.push({ at: column - from, len, s, e })
        } else {
            marks.push({ at: column - from, len, text: item.text.slice(into, into + len) })
        }
        column = last + 1
    }

    const first = pieces[0] || null
    const final = pieces[pieces.length - 1] || null
    return {
        index: i,
        length: to - from + 1,
        col0: from,
        pieces,
        marks,
        // What the gutters print: the first and last coordinates this row
        // actually draws, in reading order. A row that is nothing but a marker
        // has neither, and prints nothing.
        firstCoord: first ? (layout.reverse ? first.e : first.s) : null,
        lastCoord: final ? (layout.reverse ? final.s : final.e) : null,
    }
}

/** A run of rows, for the slab the scroller has mounted. */
export function displayRowsForRange(layout, firstIndex, count) {
    if (!layout) return []
    const first = Math.max(0, Math.floor(num(firstIndex) ?? 0))
    const wanted = Math.max(0, Math.floor(num(count) ?? 0))
    const out = []
    for (let i = first; i < Math.min(layout.totalRows, first + wanted); i += 1) {
        const row = displayRow(layout, i)
        if (row) out.push(row)
    }
    return out
}

/**
 * The genomic stretches a set of rows draws.
 *
 * What the sequence and annotation buffers need. In full mode this is one
 * interval; collapsed it is one per piece, and they can be very far apart --
 * which is exactly why the buffers must not simply ask for everything between
 * the first and the last.
 */
export function coordIntervalsForRows(rows) {
    const out = []
    for (const row of rows || []) {
        for (const piece of row?.pieces || []) out.push({ s: piece.s, e: piece.e })
    }
    return mergeIntervals(out)
}
