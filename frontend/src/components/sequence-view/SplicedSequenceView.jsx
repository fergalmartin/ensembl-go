import { useCallback, useMemo, useRef, useState } from 'react'

import { DEFAULT_PALETTE } from '../../utils/sequenceViewColours'
import { SELECT_NONE, selectionMask } from '../../utils/sequenceViewPaint'
import { columnAtX, gapToBand } from '../../utils/sequenceViewSelect'
import {
    KIND_PROTEIN,
    codonPlace,
    codonRuns,
    genomicAt,
    overlayRuns,
    proteinRuns,
    rowClasses,
    splicedRows,
} from '../../utils/transcriptSequenceView'
import SequenceHoverTip from './SequenceHoverTip'
import SequenceRow from './SequenceRow'
import {
    BASE_ROW_PX,
    BASES_PER_ROW,
    SPLICED_GUTTER_WIDTH,
    rowMetrics,
} from './sequenceViewLayout'

// Rows are drawn as the reader scrolls rather than all at once. A spliced
// transcript is small next to a chromosome -- the longest human one is about
// 109 kb, which is under two thousand rows -- so the whole scroll model the
// genomic view needs is a multiply here, and the only thing worth keeping is not
// putting a hundred thousand cells in the document.
const OVERSCAN_ROWS = 4

// No lane over the bases: the protein is its own reading here rather than a
// track above the codons, so every row is the same height and the height index
// the genomic view needs has nothing to do.
const ROW_HEIGHT = BASE_ROW_PX

// Neither the marks channel nor the mask is ever anything but blank on a row
// outside a selection, so both are cut once and shared. `SequenceRow` is
// memoised on identity, and a fresh string per row per render would repaint the
// whole slab on every pointer move.
const NO_EDGES = '0'.repeat(BASES_PER_ROW)
const BLANK_MASK = SELECT_NONE.repeat(BASES_PER_ROW)

/**
 * The contig kinds that carry their own genetic code, as adjectives.
 *
 * The backend answers with the organelle's name, which is what it is; a sentence
 * about the code needs the adjective. Anything not listed prints as it came, so
 * a molecule this does not know about still reads.
 */
const MOLECULE_WORD = { mitochondrion: 'mitochondrial', plastid: 'plastid' }

/**
 * A transcript read in its own coordinates, where the genomic reading sits.
 *
 * The same surface, not something that resembles it: sixty to a row, a number
 * down either margin, the annotation in the same colours from the same palette,
 * a drag to select, a bar over the selection and a tip under the pointer. It
 * draws with `SequenceRow`, the component the genomic view draws with, which
 * takes a handful of equal-length strings and knows nothing about what a
 * position means. A second way of showing sequence in one application would be a
 * second set of answers to every one of those questions.
 *
 * What it does not borrow is the scroll model, the buffering or the collapsing.
 * A spliced sequence has no introns left to hide, arrives in one piece, and is
 * short enough that every row is placed with a multiply.
 *
 * **It is mounted under a key of the transcript and the reading**, so moving to
 * either throws this away and builds it again. That is what resets the
 * selection, the pointer and the scroll position, and it is the right answer
 * rather than a lazy one: residue 40 is not base 40, so none of those three mean
 * anything in the next reading, and code that cleared them one at a time would
 * be three chances to forget the fourth.
 *
 * The answer itself comes from above, from `useTranscriptReadings`, because the
 * bar over this surface prints the same lengths and must not fetch them twice.
 */
export default function SplicedSequenceView({
    kind,
    answer,
    error = '',
    loading = false,
    transcript,
    chrom = '',
    palette = DEFAULT_PALETTE,
    isLight = false,
    // The highlight in this reading's own positions, worked out above from the
    // one stretch of chromosome every reading shares. Drawing it rather than
    // owning it is what lets it survive a change of reading.
    span = null,
    onHighlight,
}) {
    const [width, setWidth] = useState(0)
    const [viewportPx, setViewportPx] = useState(0)
    const [scrollTop, setScrollTop] = useState(0)
    const [hover, setHover] = useState(null)

    const scrollerRef = useRef(null)
    const dragRef = useRef(null)
    const strand = transcript?.strand || '+'

    const sequence = answer?.status === 'ok' ? (answer.sequence || '') : ''
    const length = sequence.length

    const runs = useMemo(() => {
        if (!answer || answer.status !== 'ok') return []
        if (kind === KIND_PROTEIN) return proteinRuns(sequence)
        // The codon stripes go under the annotation's own runs: the start and
        // stop codons say where the reading begins and ends, and a stripe over
        // them would hide the first thing a reader looks for.
        return overlayRuns(answer.runs, codonRuns(answer.cds, 0))
    }, [answer, kind, sequence])

    const rows = useMemo(() => splicedRows(length), [length])
    const metrics = useMemo(() => rowMetrics(width, 12, SPLICED_GUTTER_WIDTH), [width])
    // `selectionMask` measures in 0-based columns; the highlight arrives as
    // 1-based positions, because that is what the gutters print and what the bar
    // says. This is the one place the two meet.
    const selection = span ? { lo: span.s - 1, hi: span.e - 1 } : null
    const selecting = Boolean(span) && span.e > span.s

    const viewportRows = Math.max(1, Math.ceil(viewportPx / ROW_HEIGHT))
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS)
    const last = Math.min(rows.length, first + viewportRows + OVERSCAN_ROWS * 2)

    // ---- measuring -------------------------------------------------------

    // A callback ref rather than an effect, for the reason the genomic view's
    // scroller uses one: this renders nothing at all while an answer is in
    // flight, so the element is replaced, and an effect with no dependencies
    // would keep measuring the one that went.
    const attachScroller = useCallback((element) => {
        scrollerRef.current = element
        if (!element || typeof ResizeObserver === 'undefined') return
        const measure = () => {
            setWidth(element.clientWidth)
            setViewportPx(element.clientHeight)
        }
        measure()
        new ResizeObserver(measure).observe(element)
    }, [])

    // ---- the pointer -----------------------------------------------------

    /** The column a pointer event is over, or the nearest one it meant. */
    const columnAt = useCallback((event) => {
        const scroller = scrollerRef.current
        if (!scroller) return null
        let cell = event.target?.closest?.('[data-offset]')
        let line = event.target?.closest?.('[data-row-index]')
        if (!cell || !line) {
            // A press between two rows, or out on a margin, is a press that
            // meant the nearest base: selecting is a gesture over a stretch, not
            // a click on one cell, and leaving it unhandled hands it to the
            // browser, which drags a text highlight across the numbers.
            let best = null
            let bestGap = Infinity
            for (const candidate of scroller.querySelectorAll('[data-row-index]')) {
                const box = candidate.getBoundingClientRect()
                const gap = gapToBand(event.clientY, box.top, box.bottom)
                if (gap < bestGap) {
                    best = candidate
                    bestGap = gap
                    if (gap === 0) break
                }
            }
            if (!best) return null
            const cells = best.querySelectorAll('[data-offset]')
            if (!cells.length) return null
            const at = columnAtX(event.clientX, {
                left: cells[0].getBoundingClientRect().left,
                right: cells[cells.length - 1].getBoundingClientRect().right,
                count: cells.length,
            })
            if (at === null) return null
            cell = cells[at]
            line = best
        }
        const offset = Number(cell.dataset.offset)
        const index = Number(line.dataset.rowIndex)
        if (!Number.isFinite(offset) || !Number.isFinite(index)) return null
        const column = index * BASES_PER_ROW + offset
        return column < length ? column : null
    }, [length])

    /** Report a stretch of this reading upward, in 1-based positions. */
    const mark = useCallback((from, to) => {
        if (from === null || to === null) { onHighlight?.(null); return }
        onHighlight?.({ s: Math.min(from, to) + 1, e: Math.max(from, to) + 1 })
    }, [onHighlight])

    const handlePointerDown = useCallback((event) => {
        if (event.button !== 0) return
        const column = columnAt(event)
        if (column === null) return
        // Taken over from the browser, which would otherwise start a text
        // selection across the cells and the numbers between them.
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        dragRef.current = { anchor: column, moved: false }
        mark(column, column)
    }, [columnAt, mark])

    const handlePointerMove = useCallback((event) => {
        const column = columnAt(event)
        if (column === null) return
        if (dragRef.current) {
            dragRef.current.moved = dragRef.current.moved || column !== dragRef.current.anchor
            mark(dragRef.current.anchor, column)
        }
        setHover({ column, x: event.clientX, y: event.clientY })
    }, [columnAt, mark])

    const handlePointerUp = useCallback((event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        const drag = dragRef.current
        dragRef.current = null
        // A press that never moved is a click, and a click clears rather than
        // marks one cell: a one-base highlight is not what anyone drags for, and
        // leaving it would make every stray click look like a mark the reader
        // had made.
        if (drag && !drag.moved) mark(null, null)
    }, [mark])

    // ---- where this is on the chromosome ---------------------------------

    /** The genomic stretch a position in this reading stands for. */
    const genomicFor = useCallback((position) => {
        if (!answer || answer.status !== 'ok') return null
        if (kind !== KIND_PROTEIN) {
            const found = genomicAt(answer.segments, position, strand)
            return found ? { s: found.coord, e: found.coord, exon: found.exon } : null
        }
        // A residue stands for three bases that need not be together, and need
        // not all exist. See `codonPlace`, where that arithmetic lives and is
        // tested.
        return codonPlace(answer.segments, position, strand)
    }, [answer, kind, strand])

    // ---- what the answer knows that the letters do not --------------------

    const notes = useMemo(() => {
        if (kind !== KIND_PROTEIN || answer?.status !== 'ok') return []
        const lines = []
        if (answer.pad) {
            lines.push(
                'This CDS is incomplete at its 5′ end, so its first codon began outside '
                + 'the annotation and is shown as X.',
            )
        } else if (!answer.startVerified) {
            lines.push(
                'This CDS does not begin with ATG on the assembly. The reading frame is the '
                + 'annotation’s rather than one this view could check.',
            )
        }
        if (answer.droppedTrailing) {
            lines.push(
                `The last ${answer.droppedTrailing === 1 ? 'base' : `${answer.droppedTrailing} bases`} `
                + 'of the CDS do not make a whole codon and are not translated.',
            )
        }
        if (answer.internalStops) {
            lines.push(
                `${answer.internalStops === 1 ? 'One residue is' : `${answer.internalStops} residues are`} `
                + 'a stop inside the reading frame, marked in the sequence.',
            )
        }
        if (answer.molecule && answer.molecule !== 'nuclear') {
            lines.push(
                `Translated with the ${MOLECULE_WORD[answer.molecule] || answer.molecule} `
                + `genetic code (NCBI table ${answer.table}).`,
            )
        }
        return lines
    }, [kind, answer])

    // ---- drawing ----------------------------------------------------------

    const muted = isLight ? 'text-gray-500' : 'text-gray-400'

    if (error) return <p className="px-6 py-4 text-sm text-amber-500">{error}</p>
    if (answer?.status === 'no_cds') {
        return (
            <p className={`px-6 py-4 text-sm ${muted}`}>
                This transcript has no coding sequence, so it has no CDS and no protein.
            </p>
        )
    }
    if (answer?.status === 'error') {
        return (
            <p className={`px-6 py-4 text-sm ${muted}`}>
                This transcript’s exons could not be read as one sequence.
            </p>
        )
    }
    if (!answer) {
        return <p className={`px-6 py-4 text-sm ${muted}`}>{loading ? 'Reading…' : ''}</p>
    }

    const tip = hover === null ? null : (() => {
        const position = hover.column + 1
        const place = genomicFor(position)
        return {
            x: hover.x,
            y: hover.y,
            at: position.toLocaleString(),
            base: sequence[hover.column] || '',
            code: rowClasses({ col0: hover.column, length: 1 }, runs) || '',
            where: place
                ? `${chrom}:${place.s === place.e
                    ? place.s.toLocaleString()
                    : `${place.s.toLocaleString()}–${place.e.toLocaleString()}`}`
                : '',
            // Its own fact rather than tacked onto the coordinate: a residue
            // whose codon straddles a junction is in two exons, and that is
            // worth reading as a thing rather than as a footnote to a number.
            exon: place?.exon
                ? `exon ${place.exon}`
                : place?.spans ? `exons ${place.spans[0]}–${place.spans[1]}` : '',
        }
    })()

    return (
        <div className="flex h-full min-h-0 flex-col" data-spliced-sequence-view="true">
            {notes.length ? (
                // Sentences, so a row of their own under the bar rather than an
                // item on it -- the same place, and for the same reason, as what
                // the control bar has to say about what it is drawing.
                <div className={`flex-none px-4 pb-1.5 text-[11px] ${muted}`} data-spliced-notes="true">
                    {notes.map((line) => <p key={line}>{line}</p>)}
                </div>
            ) : null}

            <div
                ref={attachScroller}
                className={`relative min-h-0 flex-1 overflow-y-auto ${metrics.fits ? 'overflow-x-hidden' : 'overflow-x-auto'}`}
                data-transcript-sequence-scroller="true"
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                // Both, and not one or the other. Preventing the pointer event
                // stops this element's own default; the browser starts a text
                // selection off the *mouse* event, and a compatibility mouse
                // event is dispatched whether or not the pointer one was
                // prevented. Without this a drag pulls a document selection
                // along behind the one being drawn, and it does not stop at the
                // sequence -- it reaches up and highlights the toolbar.
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onPointerLeave={() => setHover(null)}
                // The pointer says a stretch can be taken from here; the rest
                // says the browser must not be the one taking it. Without
                // `userSelect` a drag runs a document text selection along
                // behind the one being drawn, and it does not stop at the
                // sequence -- it reaches up and highlights the toolbar.
                style={{ cursor: 'text', touchAction: 'none', userSelect: 'none' }}
            >
                <div
                    className="relative"
                    style={{
                        height: `${rows.length * ROW_HEIGHT}px`,
                        width: `${metrics.rowWidth}px`,
                        margin: '0 auto',
                    }}
                >
                    <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
                        {rows.slice(first, last).map((row) => (
                            <SequenceRow
                                key={row.index}
                                row={row}
                                sequence={sequence.slice(row.col0, row.col0 + row.length)}
                                classes={rowClasses(row, runs)}
                                mask={selecting
                                    ? selectionMask(row, selection, row.length, BASES_PER_ROW)
                                    : BLANK_MASK.slice(0, row.length)}
                                edges={NO_EDGES.slice(0, row.length)}
                                labels={{ left: row.first, right: row.last }}
                                palette={palette}
                                rowHeight={ROW_HEIGHT}
                                cellWidth={metrics.cellWidth}
                                fontSize={metrics.fontSize}
                                gutterWidth={SPLICED_GUTTER_WIDTH}
                                isLight={isLight}
                                selecting={selecting}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <SequenceHoverTip hover={tip} isLight={isLight} chrom={chrom} palette={palette} />
        </div>
    )
}
