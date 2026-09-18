// Turning the class runs the backend sends into the per-base codes a row draws,
// and flipping a row round when it is read on the reverse strand.
//
// The backend never sends a class per base. A megabase of intron would be a
// megabyte of the letter "i" for no information, so classes travel as runs —
// {s, e, c}, non-overlapping, ascending, with gaps where no class applies. This
// module is where a run list meets a row.
//
// Runs always arrive in forward genomic order, including for a gene on the
// reverse strand. Reverse reading is a display transform applied at the very
// end, by orientRowForDisplay, to the sequence and its classes together — so
// there is exactly one place where the two could fall out of step, and it is
// eight lines long.

import { complementBase } from './locationFocus.js'
import { PLACEHOLDER_BASE } from './sequenceViewChunks.js'
import { CLASS_CODES, CLASS_NONE } from './sequenceViewPalette.js'

/**
 * How much of a location a single annotation request covers.
 *
 * A location is asked about a tile at a time rather than whole, and the size is
 * not only about the weight of one request: the backend answers a window of
 * more than a hundred genes in a coarse genic/intergenic vocabulary instead of
 * the real classes, so a window small enough to stay under that is a window
 * that comes back in colour. Asking for five megabases in one go gets a
 * uniform blue-grey; asking for the same five megabases in tiles gets coding,
 * UTR, intron and the rest.
 *
 * Shared with the export for exactly that reason -- it used to ask in one go.
 */
export const ANNOTATION_TILE_BP = 240_000

/** The tiles a stretch of a location falls across. */
export function annotationTiles(start, end, size = ANNOTATION_TILE_BP) {
    const low = Math.max(1, Math.min(Number(start), Number(end)))
    const high = Math.max(Number(start), Number(end))
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return []
    const out = []
    for (let index = Math.floor((low - 1) / size); index * size + 1 <= high; index += 1) {
        const from = index * size + 1
        out.push({ index, start: Math.max(low, from), end: Math.min(high, from + size - 1) })
    }
    return out
}

/**
 * The index of the run covering a coordinate, or -1.
 *
 * Binary search rather than a scan: a location focus over a whole chromosome
 * can carry tens of thousands of runs, and this is called once per row.
 */
export function findRunIndex(runs, coord) {
    const list = Array.isArray(runs) ? runs : []
    const at = Number(coord)
    if (!Number.isFinite(at) || list.length === 0) return -1
    let low = 0
    let high = list.length - 1
    while (low <= high) {
        const mid = (low + high) >> 1
        const run = list[mid]
        if (at < run.s) high = mid - 1
        else if (at > run.e) low = mid + 1
        else return mid
    }
    return -1
}

/** The class name covering a coordinate, or null where none does. */
export function classAtCoord(runs, coord) {
    const index = findRunIndex(runs, coord)
    return index < 0 ? null : String(runs[index].c || '') || null
}

/**
 * Which of a CDS's two shades a base takes, or null if it is not in coding
 * sequence with a known frame.
 *
 * The offset is measured in spliced CDS space, which is the only space in which
 * codons are contiguous. Counting genomic bases from a start codon drifts by the
 * length of every intron in between; this does not.
 *
 * `cdsFrame` is ascending by coordinate like every other run list here, on both
 * strands. Its `o` values carry the 5' to 3' direction — on the minus strand
 * they fall as the coordinate rises — so the list never has to be reordered and
 * the lookup stays a binary search.
 */
export function cdsStripeAt(cdsFrame, coord, strand = '+') {
    const list = Array.isArray(cdsFrame) ? cdsFrame : []
    const at = Number(coord)
    if (!Number.isFinite(at) || list.length === 0) return null
    const index = findRunIndex(list, at)
    if (index < 0) return null
    const segment = list[index]
    const base = Number(segment.o)
    if (!Number.isFinite(base)) return null
    const offset = strand === '-' ? base + (segment.e - at) : base + (at - segment.s)
    if (offset < 0) return null
    return Math.floor(offset / 3) % 2
}

/**
 * One row's class codes, in forward genomic order.
 *
 * `allowed` is the set of codes the reader has switched on; anything else falls
 * back to no class, so toggling a highlight repaints without refetching or
 * moving the scroll position.
 *
 * Soft-masking is applied last and only where nothing else claimed the base. It
 * describes the sequence rather than the annotation, so it must never hide a
 * codon or a splice site.
 */
export function buildRowClasses({
    row,
    runs = [],
    cdsFrame = [],
    strand = '+',
    allowed = null,
    masked = [],
} = {}) {
    const start = Number(row?.start)
    const end = Number(row?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
    const length = end - start + 1
    const out = new Array(length).fill(CLASS_NONE)
    const permits = (code) => (allowed ? allowed.has(code) : true)

    const list = Array.isArray(runs) ? runs : []
    // Start at the first run that could reach this row, then walk forward.
    let index = findRunIndex(list, start)
    if (index < 0) {
        index = 0
        while (index < list.length && list[index].e < start) index += 1
    }
    for (; index < list.length; index += 1) {
        const run = list[index]
        if (run.s > end) break
        const name = String(run.c || '')
        const from = Math.max(start, run.s)
        const to = Math.min(end, run.e)
        if (to < from) continue

        if (name === 'cds') {
            for (let coord = from; coord <= to; coord += 1) {
                const stripe = cdsStripeAt(cdsFrame, coord, strand)
                const code = stripe === 1 ? CLASS_CODES.cds1 : CLASS_CODES.cds
                if (permits(code)) out[coord - start] = code
            }
            continue
        }

        const code = CLASS_CODES[name]
        if (!code || !permits(code)) continue
        for (let coord = from; coord <= to; coord += 1) out[coord - start] = code
    }

    if (permits(CLASS_CODES.softmask)) {
        const maskList = Array.isArray(masked) ? masked : []
        for (const span of maskList) {
            const from = Math.max(start, Number(span.s))
            const to = Math.min(end, Number(span.e))
            if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue
            for (let coord = from; coord <= to; coord += 1) {
                if (out[coord - start] === CLASS_NONE) out[coord - start] = CLASS_CODES.softmask
            }
        }
    }

    return out.join('')
}

/**
 * What the annotation's own shape says about each cell of a row, as a hex digit.
 *
 * Marks rather than classes, and a channel of their own, because these are
 * things about the *arrangement* of genes rather than about what a base is: a
 * boundary is a line between two bases, and an overlap is a fact about how many
 * genes claim one. Either must stay visible whatever colour the base is wearing,
 * so neither can be a class -- a class would have to displace one.
 *
 * A digit rather than a character per kind, because a base can be both: the
 * first base of a gene that begins inside another gene carries an edge and an
 * overlap at once.
 */
export const EDGE_GENE_START = 1
export const EDGE_GENE_END = 2
export const EDGE_OVERLAP = 4
// The one base a reader has asked about. In this channel rather than in the
// classes for the same reason as the others: it is true of a base whatever the
// base is, and must not displace the colour it is being asked about.
export const EDGE_MARKED = 8
// The feature the pointer is resting on in the list beside the sequence. Shown
// while the pointer is there and gone the moment it leaves, which is why it is a
// mark and not a class: it says "these bases", not "these bases are this".
export const EDGE_PREVIEW = 16

// Five marks in one character, so a row is still four equal-length strings and a
// memoised row still decides whether to repaint with four string compares. Base
// 32 rather than hex because 8 was the last bit hex could hold; the digits are
// the same for everything below ten, so nothing that reads a mark had to change.
const MARK_RADIX = 32

export function geneEdgeMaskForRow(row, genes, overlaps = null, marked = null, preview = null) {
    const start = Number(row?.start)
    const end = Number(row?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
    const length = end - start + 1
    const list = Array.isArray(genes) ? genes : []
    const layered = Array.isArray(overlaps) ? overlaps : []
    const asked = Number(marked)
    const marks = Number.isFinite(asked) && asked >= start && asked <= end ? asked : null
    const under = preview && Number.isFinite(Number(preview.s)) && Number.isFinite(Number(preview.e))
        ? { s: Number(preview.s), e: Number(preview.e) }
        : null
    const shown = under && under.e >= start && under.s <= end ? under : null
    if (list.length === 0 && layered.length === 0 && marks === null && !shown) {
        return '0'.repeat(length)
    }

    const bits = new Array(length).fill(0)
    for (const gene of list) {
        const from = Number(gene?.s)
        const to = Number(gene?.e)
        if (Number.isFinite(from) && from >= start && from <= end) {
            bits[from - start] |= EDGE_GENE_START
        }
        if (Number.isFinite(to) && to >= start && to <= end) {
            bits[to - start] |= EDGE_GENE_END
        }
    }
    for (const span of layered) {
        const from = Math.max(start, Number(span?.s))
        const to = Math.min(end, Number(span?.e))
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue
        for (let coord = from; coord <= to; coord += 1) bits[coord - start] |= EDGE_OVERLAP
    }
    if (marks !== null) bits[marks - start] |= EDGE_MARKED
    if (shown) {
        const from = Math.max(start, shown.s)
        const to = Math.min(end, shown.e)
        for (let coord = from; coord <= to; coord += 1) bits[coord - start] |= EDGE_PREVIEW
    }
    return bits.map((value) => value.toString(MARK_RADIX)).join('')
}

/**
 * A row as it is read on screen.
 *
 * On the forward strand this is the identity. On the reverse it complements the
 * bases and reverses everything, so that the sequence, its classes, its amino
 * acids and any selection stay aligned to each other. Bases whose chunk has not
 * arrived are left alone — a placeholder has no complement.
 */
export function orientRowForDisplay(
    { sequence = '', classes = '', mask = '', edges = '', amino = '' } = {},
    reverse = false,
) {
    if (!reverse) return { sequence, classes, mask, edges, amino }
    let bases = ''
    for (let i = sequence.length - 1; i >= 0; i -= 1) {
        const base = sequence[i]
        bases += base === PLACEHOLDER_BASE ? base : complementBase(base)
    }
    const flip = (text) => text.split('').reverse().join('')
    // A gene's start is still its start when the row is read backwards, but it is
    // now on the right of the screen, so the two edge bits swap as well as the
    // order. How many genes cover a base does not depend on which way it is
    // read, so that bit travels unchanged.
    const flipEdges = (text) => text.split('').reverse().map((mark) => {
        const bits = parseInt(mark, MARK_RADIX) || 0
        const swapped = (bits & ~(EDGE_GENE_START | EDGE_GENE_END))
            | ((bits & EDGE_GENE_START) ? EDGE_GENE_END : 0)
            | ((bits & EDGE_GENE_END) ? EDGE_GENE_START : 0)
        return swapped.toString(MARK_RADIX)
    }).join('')
    // The amino acids are flipped but not complemented: a letter stands on its
    // codon's middle base, and the middle of three is still the middle when the
    // three are read the other way round.
    return { sequence: bases, classes: flip(classes), mask: flip(mask), edges: flipEdges(edges), amino: flip(amino) }
}
