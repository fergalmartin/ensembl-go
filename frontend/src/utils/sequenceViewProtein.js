// The protein a coding stretch spells, placed over the bases that spell it.
//
// Translation happens here rather than on the backend because everything it
// needs is already on screen. `cdsFrame` gives each CDS segment's offset in
// *spliced* coding sequence -- the only space in which codons are contiguous --
// and the sequence buffer holds the bases. Asking the backend for a protein
// would be a second description of the same thing, arriving at a different time
// and able to disagree with the stripes the frame already draws.
//
// One letter per codon, on the codon's middle base. That is what puts it
// visually over its codon without needing a wider cell or a second row model:
// the letter is centred in a cell that is already the right width, and a codon
// split across a row edge still shows its letter as long as the middle base is
// on the row. Every row is therefore still sixty cells of the same width, and
// the protein is one more equal-length channel beside the bases, their classes
// and their marks.
//
// Coordinates are 1-based inclusive genomic on the forward strand, as
// everywhere else in this subsystem. A minus-strand transcript's codons are
// read from the high coordinate down and complemented, which is what
// `strand` decides here and nothing downstream has to know about.

import { complementBase } from './locationFocus.js'
import { PLACEHOLDER_BASE } from './sequenceViewChunks.js'
import { rowAtCoord } from './sequenceViewDisplay.js'

/** What a base reads as where the codon it belongs to cannot be translated. */
export const NO_AMINO = ' '

/** A codon nothing sensible can be made of -- an N, or a base not yet arrived. */
export const UNKNOWN_AMINO = 'X'

export const STOP_AMINO = '*'

// The standard genetic code, one letter per amino acid. Written out rather than
// built from a degeneracy table: it is read far more often than it is changed,
// and a table that has to be expanded before it can be consulted is a table
// nobody can check against a reference by eye.
const CODONS = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
    CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
    GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
    CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
    GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: STOP_AMINO, TAG: STOP_AMINO,
    CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
    GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: STOP_AMINO, TGG: 'W',
    CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
    GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
}

/** One codon's letter. Anything the table does not hold is unknown, not absent:
 * a codon with an N in it is still a codon, and blanking it would read as the
 * end of the coding sequence. */
export function translateCodon(codon) {
    const key = String(codon || '').toUpperCase()
    if (key.length !== 3) return UNKNOWN_AMINO
    return CODONS[key] || UNKNOWN_AMINO
}

/**
 * A CDS segment list indexed both ways, built once per list.
 *
 * `byCoord` is the list as it arrives, ascending by coordinate, for asking what
 * offset a coordinate is at. `byOffset` is the same segments ordered by their
 * spliced offset, for the opposite question -- which coordinate an offset is at
 * -- which is what walking a codon across an exon junction needs. On the minus
 * strand the two orders are reverses of each other; on the plus they are the
 * same list, and building both costs one sort either way.
 *
 * Cached on the array itself. The frame arrives with the class runs and keeps
 * its identity for as long as they do, so a row being repainted while the
 * reader scrolls re-uses the index rather than rebuilding it sixty times a
 * second.
 */
const INDEXED = new WeakMap()

export function spliceIndex(cdsFrame) {
    if (!Array.isArray(cdsFrame) || cdsFrame.length === 0) return null
    const held = INDEXED.get(cdsFrame)
    if (held) return held
    const segments = []
    for (const item of cdsFrame) {
        const s = Number(item?.s)
        const e = Number(item?.e)
        const o = Number(item?.o)
        if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(o) || e < s) continue
        segments.push({ s, e, o, len: e - s + 1 })
    }
    if (segments.length === 0) return null
    const byCoord = [...segments].sort((a, b) => a.s - b.s)
    const byOffset = [...segments].sort((a, b) => a.o - b.o)
    const index = { byCoord, byOffset }
    INDEXED.set(cdsFrame, index)
    return index
}

/** The spliced coding offset of a coordinate, or null where it is not in CDS. */
export function offsetAtCoord(index, coord, strand = '+') {
    const list = index?.byCoord
    const at = Number(coord)
    if (!list || !Number.isFinite(at)) return null
    let low = 0
    let high = list.length - 1
    while (low <= high) {
        const mid = (low + high) >> 1
        const segment = list[mid]
        if (at < segment.s) high = mid - 1
        else if (at > segment.e) low = mid + 1
        else return strand === '-' ? segment.o + (segment.e - at) : segment.o + (at - segment.s)
    }
    return null
}

/** The coordinate a spliced offset falls at, or null past the end of the CDS. */
export function coordAtOffset(index, offset, strand = '+') {
    const list = index?.byOffset
    const at = Number(offset)
    if (!list || !Number.isFinite(at) || at < 0) return null
    let low = 0
    let high = list.length - 1
    while (low <= high) {
        const mid = (low + high) >> 1
        const segment = list[mid]
        if (at < segment.o) high = mid - 1
        else if (at >= segment.o + segment.len) low = mid + 1
        else return strand === '-' ? segment.e - (at - segment.o) : segment.s + (at - segment.o)
    }
    return null
}

/**
 * One row's amino acids, in forward genomic order, one character per base.
 *
 * `readBase(coord)` returns the forward-strand base at a coordinate, or a
 * placeholder while its chunk is in flight. The three bases of a codon are
 * fetched by offset rather than by adding to a coordinate, so a codon spanning
 * an exon junction is translated correctly instead of being read through the
 * intron between its halves.
 *
 * Only the middle base of a codon carries a letter. The first and third carry
 * NO_AMINO, which is what centres the letter over its three cells.
 */
export function buildRowAminoAcids({ row, cdsFrame = [], strand = '+', readBase = () => null } = {}) {
    const start = Number(row?.start)
    const end = Number(row?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
    const length = end - start + 1
    const index = spliceIndex(cdsFrame)
    if (!index) return NO_AMINO.repeat(length)

    const out = new Array(length).fill(NO_AMINO)
    for (let coord = start; coord <= end; coord += 1) {
        const offset = offsetAtCoord(index, coord, strand)
        // The middle base of a codon, and nothing else. Two thirds of the row
        // therefore costs one binary search and no reads.
        if (offset === null || offset % 3 !== 1) continue
        const first = offset - 1
        let codon = ''
        for (let step = 0; step < 3; step += 1) {
            const at = coordAtOffset(index, first + step, strand)
            const base = at === null ? null : readBase(at)
            if (!base || base === PLACEHOLDER_BASE) { codon = ''; break }
            codon += strand === '-' ? complementBase(base) : base
        }
        // A codon whose bases have not all arrived is left blank rather than
        // drawn as unknown: it is a loading state, and an X there would read as
        // an annotation about the sequence.
        out[coord - start] = codon ? translateCodon(codon) : NO_AMINO
    }
    return out.join('')
}

/**
 * Which rows carry a letter, as runs of row indices.
 *
 * What decides a row's *height*, and therefore what the lane is drawn on. It is
 * worked out from the annotation rather than from the bases, because height has
 * to be settled before a single row can be placed and the sequence arrives
 * later -- a row that grew when its chunk landed would reflow the document
 * under the reader. A row whose bases are still in flight is therefore a tall
 * row with an empty lane, which is the right way round.
 *
 * Each CDS segment contributes the rows between its first and its last middle
 * base. Letters only ever sit on middle bases, so nothing outside that span can
 * carry one -- which is the property this has to have. Its ends are exact; a row
 * inside the span always holds a middle base, since any three consecutive bases
 * of a codon-aligned stretch hold exactly one.
 */
export function proteinRowRuns({ layout = null, cdsFrame = [], strand = '+' } = {}) {
    const index = spliceIndex(cdsFrame)
    if (!layout || !index) return []
    const runs = []
    for (const segment of index.byCoord) {
        // The first and last offsets in this segment that are a codon's middle.
        const first = segment.o + ((1 - segment.o % 3) + 3) % 3
        const last = segment.o + segment.len - 1
        if (first > last) continue
        const lastMiddle = last - ((last - first) % 3)
        const one = coordAtOffset(index, first, strand)
        const other = coordAtOffset(index, lastMiddle, strand)
        if (one === null || other === null) continue
        // Reverse layouts number their rows from the other end, so the two
        // coordinates can come back in either order.
        const a = rowAtCoord(layout, one)
        const b = rowAtCoord(layout, other)
        if (a === null || b === null) continue
        runs.push({ from: Math.min(a, b), to: Math.max(a, b) })
    }
    return runs
}
