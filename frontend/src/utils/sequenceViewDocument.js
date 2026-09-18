// Several named stretches of sequence, one after another, as one scrollable
// thing.
//
// The view shows either a region or a collection: the genes a reader ticked off
// a location, the transcripts they ticked off a gene, the exons and introns they
// ticked off a transcript. Each of those is a *record* -- a name and a range --
// and the records are stacked, each headed by its name, the way a FASTA file
// stacks its entries.
//
// A plain region is the same thing with one record and no name, which is why
// there is no second code path for it. That is the same choice the layout module
// makes about full and collapsed sequence, for the same reason: two row models
// that had to agree about gutters, hover, selection and buffering would drift,
// and the one nobody exercised would be the broken one.
//
// Rows are counted across the whole document, so the scroller stays what it was:
// one row space and a proportional map from scroll position to row. A header
// costs a row like any other.
//
// A row's *height* is no longer part of that: a record can carry a protein lane
// over the rows that hold coding sequence, so each entry brings the rows of its
// own that want one and they are translated into document row space here, which
// is the only place that knows where a record's rows begin.

import { rowAtCoord } from './sequenceViewDisplay.js'
import { mergeRowRuns } from './sequenceViewHeights.js'

/** Rows a record's name takes before its sequence begins. */
export const HEADER_ROWS = 1

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/**
 * Place a list of records into one row space.
 *
 * Each entry is `{ key, record, layout }`. A null `record` is the plain view --
 * sequence with no name above it. Entries whose layout is not ready yet are left
 * out rather than guessed at, so the document never claims rows it cannot draw.
 */
export function buildDocument(entries) {
    const sections = []
    const laneRows = []
    let cursor = 0
    for (const entry of entries || []) {
        if (!entry?.layout?.totalRows) continue
        const headed = Boolean(entry.record)
        const firstRow = cursor + (headed ? HEADER_ROWS : 0)
        sections.push({
            key: entry.key,
            record: entry.record || null,
            layout: entry.layout,
            headerRow: headed ? cursor : null,
            firstRow,
            rows: entry.layout.totalRows,
        })
        // The record's own row numbers, shifted to where it sits in the
        // document. A header row never carries a lane, which falls out of the
        // shift rather than needing to be said.
        for (const run of entry.laneRows || []) {
            laneRows.push({ from: firstRow + run.from, to: firstRow + run.to })
        }
        cursor += (headed ? HEADER_ROWS : 0) + entry.layout.totalRows
    }
    return {
        sections,
        totalRows: cursor,
        // Ordered and joined, so the height index can binary search them.
        laneRows: mergeRowRuns(laneRows, cursor),
        // A collection is a different thing to read than a region, and several
        // things downstream -- what a drag may cross, what a copy produces --
        // turn on which one this is.
        named: sections.some((section) => section.record),
    }
}

/** The section a row belongs to, by binary search on where sections begin. */
export function sectionAtRow(document_, row) {
    const sections = document_?.sections || []
    const at = num(row)
    if (at === null || at < 0 || at >= (document_?.totalRows || 0)) return null
    let lo = 0
    let hi = sections.length - 1
    let found = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const start = sections[mid].headerRow ?? sections[mid].firstRow
        if (start <= at) {
            found = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    return found < 0 ? null : sections[found]
}

/**
 * What is drawn at a row: a record's name, or a row of its sequence.
 *
 * `local` is the row's index within its own record's layout, which is what the
 * layout functions take -- so everything below this point works on one record
 * at a time and never has to know it is in a collection.
 */
export function documentRow(document_, row) {
    const section = sectionAtRow(document_, row)
    if (!section) return null
    const at = Math.floor(num(row))
    if (section.headerRow !== null && at < section.firstRow) {
        return { kind: 'header', row: at, section }
    }
    const local = at - section.firstRow
    if (local < 0 || local >= section.rows) return null
    return { kind: 'sequence', row: at, local, section }
}

/** A run of rows, for the slab the scroller has mounted. */
export function documentRowsForRange(document_, firstRow, count) {
    const first = Math.max(0, Math.floor(num(firstRow) ?? 0))
    const wanted = Math.max(0, Math.floor(num(count) ?? 0))
    const out = []
    for (let i = first; i < Math.min(document_?.totalRows || 0, first + wanted); i += 1) {
        const entry = documentRow(document_, i)
        if (entry) out.push(entry)
    }
    return out
}

/** Where a record's sequence begins, for scrolling to it by name. */
export function rowOfRecord(document_, key) {
    const section = (document_?.sections || []).find((item) => item.key === key)
    return section ? (section.headerRow ?? section.firstRow) : null
}

/**
 * The record a coordinate belongs to, if any.
 *
 * Records can overlap -- two picked genes may share sequence -- so this answers
 * with the first that contains it, which is the one drawn first.
 */
export function sectionForCoord(document_, coord) {
    const at = num(coord)
    if (at === null) return null
    for (const section of document_?.sections || []) {
        const region = section.layout?.region
        if (region && at >= region.start && at <= region.end) return section
    }
    return null
}

/**
 * The document row a coordinate is drawn at.
 *
 * `preferKey` is the record the reader was last looking at, which matters when
 * records overlap: two picked genes can share sequence, and staying in the one
 * already on screen is what keeps a re-layout from jumping to the other.
 */
export function documentRowOfCoord(document_, coord, preferKey = '') {
    const at = num(coord)
    if (!document_ || at === null) return null
    const preferred = preferKey
        ? (document_.sections || []).find((item) => item.key === preferKey)
        : null
    const section = (preferred
        && at >= preferred.layout.region.start
        && at <= preferred.layout.region.end)
        ? preferred
        : sectionForCoord(document_, at)
    if (!section) return null
    const local = rowAtCoord(section.layout, at)
    return local === null ? null : section.firstRow + local
}
