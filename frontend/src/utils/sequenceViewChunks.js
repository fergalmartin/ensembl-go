// Which pieces of sequence to ask for, in what order, and how a row's 60
// characters are assembled out of them.
//
// Chunks sit on a grid anchored at genomic coordinate 1, not at the start of the
// focus region. That way moving from a gene to one of its transcripts, or out to
// the location around it, reuses every chunk already fetched — the sequence has
// not changed, only the window onto it. A grid anchored at the region would
// throw the cache away on every focus change.
//
// The cost of the absolute grid is that a chunk boundary can fall inside a row,
// since the region start is not aligned to it. That is what `assembleRowSequence`
// is for. A row is 60 bases and a chunk is 12,000, so a row straddles at most two
// chunks and the stitch is a short loop.

import { BASES_PER_ROW } from './sequenceViewRows.js'

// 12 kb a request: small enough that the first rows appear promptly after a
// coordinate jump, large enough that one chunk is about five screenfuls of
// reading, and far under the 100 kb the endpoint will accept.
export const SEQUENCE_VIEW_CHUNK_BP = 12_000

// What a base reads as while its chunk is still in flight. Drawn at the same
// size as any other base so arrival never reflows the row.
export const PLACEHOLDER_BASE = '·'

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** The chunk a 1-based coordinate belongs to. */
export function chunkIndexForCoord(coord, chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const at = num(coord)
    if (at === null) return null
    const size = Math.max(1, Math.floor(chunkBp))
    return Math.floor((Math.round(at) - 1) / size)
}

/** The 1-based inclusive extent of a chunk. */
export function chunkRange(index, chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const i = num(index)
    if (i === null || i < 0) return null
    const size = Math.max(1, Math.floor(chunkBp))
    const start = Math.floor(i) * size + 1
    return { index: Math.floor(i), start, end: start + size - 1 }
}

/** The cache key for a chunk. Genome and chromosome, because both change. */
export function chunkKey(genomeKey, chrom, index) {
    return `seq:${String(genomeKey || '')}:${String(chrom || '')}:${index}`
}

/**
 * The chunks worth having, most urgent first.
 *
 * Priority 0 is the chunk under the top row — the one the reader is actually
 * looking at. 1 is the rest of what is on screen. 2 and 3 are a chunk either
 * side, the leading side first.
 *
 * Lookahead is only planned while the reader is moving. Asking for the next
 * chunk after every idle repaint would keep a worker busy for sequence nobody
 * has asked to see, and there is only one worker.
 */
export function planSequenceChunks({
    region,
    visibleStart,
    visibleEnd,
    anchorCoord = null,
    direction = 0,
    lookahead = true,
    chunkBp = SEQUENCE_VIEW_CHUNK_BP,
} = {}) {
    const low = num(region?.start)
    const high = num(region?.end)
    const from = num(visibleStart)
    const to = num(visibleEnd)
    if (low === null || high === null || from === null || to === null) return []

    const clampToRegion = (coord) => Math.min(high, Math.max(low, coord))
    const firstVisible = chunkIndexForCoord(clampToRegion(Math.min(from, to)), chunkBp)
    const lastVisible = chunkIndexForCoord(clampToRegion(Math.max(from, to)), chunkBp)
    const firstInRegion = chunkIndexForCoord(low, chunkBp)
    const lastInRegion = chunkIndexForCoord(high, chunkBp)

    const anchor = anchorCoord === null
        ? firstVisible
        : chunkIndexForCoord(clampToRegion(anchorCoord), chunkBp)

    const byIndex = new Map()
    const want = (index, priority) => {
        if (index < firstInRegion || index > lastInRegion) return
        const existing = byIndex.get(index)
        if (existing === undefined || priority < existing) byIndex.set(index, priority)
    }

    want(anchor, 0)
    for (let i = firstVisible; i <= lastVisible; i += 1) want(i, 1)

    if (lookahead && direction !== 0) {
        const leading = direction > 0 ? lastVisible + 1 : firstVisible - 1
        const trailing = direction > 0 ? firstVisible - 1 : lastVisible + 1
        want(leading, 2)
        want(trailing, 3)
    }

    return [...byIndex.entries()]
        .map(([index, priority]) => ({ index, priority, ...chunkRange(index, chunkBp) }))
        .sort((a, b) => a.priority - b.priority || a.index - b.index)
}

/**
 * The chunks a set of scattered stretches needs, most urgent first.
 *
 * The plain planner above walks from the first visible coordinate to the last,
 * which is right when the rows are contiguous. Collapsed, they are not: one row
 * can end inside one gene and begin the next half a megabase away, and asking
 * for everything in between would fetch the whole intron the reader has just
 * hidden. So the stretches are taken as given and each is mapped to its own
 * chunks.
 *
 * Priority is distance from the anchor stretch -- the one under the top row --
 * rather than a fixed rank, because there is no single direction of travel to
 * lead with when the stretches are scattered.
 */
export function planChunksForIntervals({
    intervals = [],
    anchorCoord = null,
    chunkBp = SEQUENCE_VIEW_CHUNK_BP,
    maxChunks = 24,
} = {}) {
    const byIndex = new Map()
    const anchorIndex = anchorCoord === null ? null : chunkIndexForCoord(anchorCoord, chunkBp)

    for (const interval of intervals || []) {
        const from = num(interval?.s ?? interval?.start)
        const to = num(interval?.e ?? interval?.end)
        if (from === null || to === null) continue
        const first = chunkIndexForCoord(Math.min(from, to), chunkBp)
        const last = chunkIndexForCoord(Math.max(from, to), chunkBp)
        for (let index = first; index <= last; index += 1) {
            const distance = anchorIndex === null ? 0 : Math.abs(index - anchorIndex)
            const priority = distance === 0 ? 0 : 1
            const existing = byIndex.get(index)
            if (existing === undefined || priority < existing.priority) {
                byIndex.set(index, { priority, distance })
            }
        }
    }

    return [...byIndex.entries()]
        .map(([index, rank]) => ({ index, ...rank, ...chunkRange(index, chunkBp) }))
        .sort((a, b) => a.priority - b.priority || a.distance - b.distance || a.index - b.index)
        // A bound, because a collapsed layout can put a great many small
        // stretches on screen at once and there is only one worker for them.
        .slice(0, Math.max(1, Math.floor(maxChunks)))
        .map(({ distance: _distance, ...chunk }) => chunk)
}

/**
 * One row's characters, taken from whatever chunks have arrived.
 *
 * `readChunk(index)` returns that chunk's sequence or a falsy value when it is
 * not here yet. Bases with no chunk behind them come back as PLACEHOLDER_BASE:
 * the returned string is always exactly the row's length, so a row never
 * changes size when sequence lands.
 */
export function assembleRowSequence(row, readChunk, chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const start = num(row?.start)
    const end = num(row?.end)
    if (start === null || end === null || end < start) return ''
    const length = end - start + 1
    const size = Math.max(1, Math.floor(chunkBp))

    let out = ''
    let cursor = start
    while (cursor <= end) {
        const index = chunkIndexForCoord(cursor, size)
        const range = chunkRange(index, size)
        const sliceEnd = Math.min(end, range.end)
        const wanted = sliceEnd - cursor + 1
        const chunk = readChunk(index)
        if (chunk) {
            const offset = cursor - range.start
            const piece = String(chunk).slice(offset, offset + wanted)
            out += piece.length === wanted ? piece : piece + PLACEHOLDER_BASE.repeat(wanted - piece.length)
        } else {
            out += PLACEHOLDER_BASE.repeat(wanted)
        }
        cursor = sliceEnd + 1
    }
    return out.length === length ? out : out.slice(0, length).padEnd(length, PLACEHOLDER_BASE)
}

/**
 * One base, from whatever chunks have arrived, or null.
 *
 * For readers that need a coordinate rather than a run of them -- the protein
 * track, whose codons are contiguous in spliced space and so scattered in
 * genomic space. A row's own bases still come through `assembleRowSequence`,
 * which stitches the two chunks a row can straddle in one pass.
 */
export function readBaseAt(coord, readChunk, chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const at = num(coord)
    if (at === null) return null
    const size = Math.max(1, Math.floor(chunkBp))
    const index = chunkIndexForCoord(at, size)
    const chunk = readChunk(index)
    if (!chunk) return null
    return String(chunk)[Math.round(at) - chunkRange(index, size).start] || null
}

/** Whether a row can be drawn from what has arrived. */
export function rowIsResolved(row, readChunk, chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const assembled = assembleRowSequence(row, readChunk, chunkBp)
    return assembled.length > 0 && !assembled.includes(PLACEHOLDER_BASE)
}

export { BASES_PER_ROW }
