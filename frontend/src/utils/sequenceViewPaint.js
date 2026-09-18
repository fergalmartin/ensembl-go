// Turning one laid-out row into the strings a row component draws.
//
// A row's whole appearance is a handful of equal-length strings -- the
// characters, their classes, the selection mask, the gene-edge marks and, when
// the protein track is on, the amino acid over each codon. That is what lets the
// memoised row decide whether to repaint with a few string compares, and it is
// why the collapsed view had to fit into the same shape rather than growing a
// per-cell object.
//
// A row is built stretch by stretch. Each contiguous genomic piece goes through
// exactly the same functions the uncollapsed view uses, is oriented for reading
// direction, and is then placed at its column; the gap markers fill the columns
// between. So collapsing adds no second way of deciding what colour a base is.

import { BASES_PER_ROW } from './sequenceViewRows.js'
import { PLACEHOLDER_BASE, assembleRowSequence, readBaseAt } from './sequenceViewChunks.js'
import { NO_AMINO, buildRowAminoAcids } from './sequenceViewProtein.js'
import { CLASS_GAP, CLASS_NONE } from './sequenceViewPalette.js'
import {
    buildRowClasses,
    geneEdgeMaskForRow,
    orientRowForDisplay,
} from './sequenceViewClasses.js'

/**
 * A selected cell's mask character: which of its four sides the region's edge
 * runs along, as a hex digit. '.' is a cell outside the selection.
 *
 * An edge is drawn on a side where the neighbour is not also selected, which is
 * what turns a set of cells into one outlined region rather than a stack of
 * boxes with rules between them. A selection runs on across the end of a row, so
 * the sides of the rows themselves always carry an edge -- which is what gives a
 * multi-row selection the staircase a reader expects of selected text.
 */
export const SELECT_NONE = '.'
export const SELECT_TOP = 1
export const SELECT_RIGHT = 2
export const SELECT_BOTTOM = 4
export const SELECT_LEFT = 8

/**
 * One row, ready to draw.
 *
 * `readSequence(chunkIndex)` is the buffer's reader; `maskedFor({start, end})`
 * returns the soft-masked stretches overlapping a piece. Everything else is the
 * annotation and the reader's choices, exactly as the uncollapsed view passes
 * them.
 *
 * `overlaps` is where more than one gene covers the sequence, `marked` is the one
 * base a reader has asked about, and `preview` is the feature under the pointer
 * in the list beside the sequence. Both are drawn in the marks channel rather
 * than the classes, because a base two genes share is still coding or still
 * intronic and saying so is the point of the colour.
 */
export function paintDisplayRow(row, {
    readSequence = () => null,
    maskedFor = () => [],
    runs = [],
    cdsFrame = [],
    strand = '+',
    allowed = null,
    selection = null,
    genes = [],
    overlaps = [],
    marked = null,
    preview = null,
    protein = false,
    reverse = false,
    width = BASES_PER_ROW,
} = {}) {
    const length = Math.max(0, Math.floor(Number(row?.length) || 0))
    if (!length) return { sequence: '', classes: '', mask: '', edges: '', amino: '' }

    // Filled rather than concatenated: pieces and markers arrive in column
    // order, but a row that ends mid-marker has columns nothing claims, and a
    // short final row must still be exactly its own length.
    const sequence = new Array(length).fill(' ')
    const classes = new Array(length).fill(CLASS_NONE)
    const edges = new Array(length).fill('0')
    // Blank unless the reader asked for it. The lane is drawn on every row when
    // it is on -- present everywhere, empty where there is no coding sequence --
    // so that the row height is one number and not a per-row decision.
    const amino = new Array(length).fill(NO_AMINO)
    const translating = Boolean(protein) && Array.isArray(cdsFrame) && cdsFrame.length > 0

    // The selection is held as a range of display columns rather than of
    // coordinates. That is what makes it the shape a reader drew: the columns
    // between two points already run to the end of one row, across the rows
    // between, and up to the point on the last -- and a collapsed stretch's
    // marker, having columns of its own inside the range, comes along with it.
    const mask = selectionMask(row, selection, length, Math.max(1, Math.floor(width)))

    for (const piece of row.pieces || []) {
        const range = { start: piece.s, end: piece.e }
        const painted = orientRowForDisplay({
            sequence: assembleRowSequence(range, readSequence),
            classes: buildRowClasses({
                row: range, runs, cdsFrame, strand, allowed, masked: maskedFor(range),
            }),
            edges: geneEdgeMaskForRow(range, genes, overlaps, marked, preview),
            // A codon can straddle an exon junction, so its three bases are
            // gathered by spliced offset rather than read out of this row --
            // which is why the whole buffer is handed over and not just the
            // stretch being drawn.
            amino: translating
                ? buildRowAminoAcids({
                    row: range, cdsFrame, strand, readBase: (coord) => readBaseAt(coord, readSequence),
                })
                : '',
        }, reverse)

        for (let i = 0; i < piece.len; i += 1) {
            const at = piece.at + i
            if (at >= length) break
            sequence[at] = painted.sequence[i] || PLACEHOLDER_BASE
            classes[at] = painted.classes[i] || CLASS_NONE
            edges[at] = painted.edges[i] || '0'
            if (translating) amino[at] = painted.amino[i] || NO_AMINO
        }
    }

    for (const marker of row.marks || []) {
        for (let i = 0; i < marker.len; i += 1) {
            const at = marker.at + i
            if (at >= length) break
            sequence[at] = marker.text[i] || '-'
            classes[at] = CLASS_GAP
        }
    }

    return {
        sequence: sequence.join(''),
        classes: classes.join(''),
        mask,
        edges: edges.join(''),
        // Empty rather than blank when the track is off, so a row that is not
        // drawing a protein lane can say so with one falsy check.
        amino: translating ? amino.join('') : '',
    }
}

/**
 * Which of a row's columns a selection covers, and where its edge runs.
 *
 * `selection` is `{lo, hi}` in display columns, inclusive. Sides are decided by
 * looking at the neighbour: the cell above and below are one row's width away
 * in column space, so a full row between two full rows carries no horizontal
 * edge at all and the region reads as one shape.
 */
export function selectionMask(row, selection, length, width) {
    const blank = SELECT_NONE.repeat(length)
    const lo = Number(selection?.lo)
    const hi = Number(selection?.hi)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return blank
    const from = Math.min(lo, hi)
    const to = Math.max(lo, hi)
    const base = Number(row?.col0) || 0
    if (base + length - 1 < from || base > to) return blank

    const covers = (column) => column >= from && column <= to
    const out = new Array(length).fill(SELECT_NONE)
    for (let i = 0; i < length; i += 1) {
        const column = base + i
        if (!covers(column)) continue
        let bits = 0
        if (!covers(column - width)) bits |= SELECT_TOP
        if (!covers(column + width)) bits |= SELECT_BOTTOM
        // The ends of a row are always an edge: the selection continues on the
        // next line, not off the side of this one.
        if (i === 0 || !covers(column - 1)) bits |= SELECT_LEFT
        if (i === length - 1 || !covers(column + 1)) bits |= SELECT_RIGHT
        out[i] = bits.toString(16)
    }
    return out.join('')
}
