import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { markWheelHandled } from '../../utils/browsingControls'
import { paintDisplayRow } from '../../utils/sequenceViewPaint'
import {
    columnAtCoord,
    coordAtColumn,
    displayRow,
    gapAtColumn,
    mergeIntervals,
} from '../../utils/sequenceViewDisplay'
import {
    documentRow,
    documentRowsForRange,
    documentRowOfCoord,
    rowOfRecord,
    sectionForCoord,
} from '../../utils/sequenceViewDocument'
import SequenceRecordHeading from './SequenceRecordHeading'
import {
    createScrollModel,
    overscanRows,
    rowAtScrollTop,
    rowHasLane,
    rowHeightAt,
    scrollTopForRow,
    visibleRowRange,
    wheelTargetRow,
} from '../../utils/sequenceViewScroll'
import SequenceHoverTip from './SequenceHoverTip'
import {
    SELECTION_BAR_HEIGHT,
    SELECT_DRAG,
    SELECT_ENDS,
    columnAtX,
    gapToBand,
    selectionBarPlacement,
    selectionRange,
    selectionTopGap,
} from '../../utils/sequenceViewSelect'
import SelectionBar from './SelectionBar'
import { zoomedGeometry } from '../../utils/sequenceViewZoom'
import SequenceOverview from './SequenceOverview'
import SequenceRow from './SequenceRow'
import { rowMetrics } from './sequenceViewLayout'


// How the view keeps scrolling while a selection drag is held past the edge.
//
// Past the edge, not near it: a drag that began within a few dozen pixels of the
// top or bottom used to start scrolling the moment it was pressed, which moved
// the sequence out from under the pointer before the reader had drawn anything.
// The pointer has to actually leave the sequence for this to start.
//
// It keeps going while it is held there, at a pace set by how far past the edge
// the pointer is, whether or not the pointer is still moving -- held still just
// outside, a drag should go on gathering rows rather than stalling.
const AUTOSCROLL_FULL_SPEED_PX = 120
const AUTOSCROLL_MIN_ROWS_PER_FRAME = 0.5
const AUTOSCROLL_MAX_ROWS_PER_FRAME = 3

// How far a pointer may travel and still be a click rather than a drag. A
// reader steadying their hand on a cell should not be told they meant something
// else.
const CLICK_SLOP_PX = 4

// The edge marks are drawn for the feature under the pointer in the list, and
// for nothing else: they say where one thing begins and ends, which is only ever
// asked about one thing at a time.
const EMPTY_GENES = Object.freeze([])

/** How many genes cover a coordinate, or 0 where fewer than two do. */
function overlapDepthAt(overlaps, coord) {
    for (const span of overlaps || []) {
        if (coord >= span.s && coord <= span.e) return span.n
    }
    return 0
}

/**
 * The sequence itself: sixty columns a row, coordinates down both margins.
 *
 * It draws a *document*: one or more records, each with its own layout, stacked
 * and headed by name. A plain region is a document of one unnamed record, which
 * is why there is no second code path for it -- the same choice the layout
 * module makes about full and collapsed sequence, and for the same reason.
 *
 * What a column holds comes from its record's layout, not from arithmetic on the
 * row number. In full mode the two are the same thing; collapsed, a column may
 * be part of a marker standing in for sequence that is not drawn. Everything
 * here -- the gutters, the hover coordinate, the drag, which sequence to fetch
 * -- asks the layout rather than adding to a row start.
 *
 * The scroll container holds an empty spacer of the layout's height and one
 * absolutely positioned slab of the rows actually on screen. The slab has to
 * carry `scrollTop` in its own offset because the spacer is capped for very
 * large regions, so its position is not derivable from the spacer the way an
 * ordinary virtual list's would be. See utils/sequenceViewScroll.js.
 */
export default function SequenceCanvas({
    doc,
    viewFor,
    chrom,
    rowHeight,
    laneHeight = 0,
    // How far out the reader is standing. At full size everything below
    // behaves as it always has; short of it the rows are drawn as one canvas
    // instead. See utils/sequenceViewZoom.js.
    zoom = 1,
    palette,
    isLight,
    buffer,
    selection,
    selectMode = false,
    // How a selection is drawn: dragged from end to end, or clicked at each
    // end. See utils/sequenceViewSelect.js.
    selectStyle = SELECT_DRAG,
    onSelectionDone,
    // What the bar over a finished selection offers. See SelectionBar.jsx.
    onSelectionFocus,
    onSelectionCopy,
    onSelectionDownload,
    onSelectionBrowse,
    onSelectionClear,
    // Whether this view draws the bar over a finished selection. It does
    // everywhere it is the only thing on screen; at a transcript the bar above
    // the sequence carries the same controls, and two bars would be the same
    // four buttons twice.
    showSelectionBar = true,
    markedCoord = null,
    preview = null,
    scrollTo,
    onSelectionChange,
    onViewportChange,
    onBaseClick,
}) {
    const scrollerRef = useRef(null)
    const [scrollTop, setScrollTop] = useState(0)
    const [viewportPx, setViewportPx] = useState(0)
    const [availablePx, setAvailablePx] = useState(0)
    const [hover, setHover] = useState(null)
    // How far the pointer is past the top or bottom of the sequence, negative
    // above and positive below, and where it is. Held together because the
    // scrolling has to go on from the last known position when the pointer
    // stops moving, and has to keep extending the selection while it does.
    const [edgeHold, setEdgeHold] = useState(0)
    const pointerRef = useRef(null)

    // The coordinate at the top of the screen, not the scroll position, is what
    // the view is actually looking at. Everything that changes the geometry --
    // a track appearing, a resize, a new focus, a collapse -- restores this
    // rather than a pixel offset, which would mean something different
    // afterwards. Collapsing is the sharpest case: the same coordinate is in a
    // completely different row once the introns are gone.
    const anchorCoordRef = useRef(null)
    const dragRef = useRef(null)
    // The first of the two clicks, while the second is still to come. Held in
    // state rather than a ref because the cursor and the half-made selection
    // are both drawn from it.
    const [pendingEnd, setPendingEnd] = useState(null)
    const [dragging, setDragging] = useState(false)
    // A press that has not moved yet. Kept out of state: it changes on every
    // pointer event and nothing is drawn from it.
    const pressRef = useRef(null)

    const full = useMemo(() => rowMetrics(availablePx), [availablePx])
    // Everything the zoom decides, worked out from the width actually measured
    // here. Zoomed out the whole block -- cells, gutters and all -- shrinks
    // together, and the row height that comes back is what the scroll model is
    // built on, so the virtualiser follows without being told about zoom.
    const geometry = useMemo(
        () => zoomedGeometry(zoom, full, { protein: laneHeight > 0 }),
        [zoom, full, laneHeight],
    )
    const overview = geometry.overview
    const metrics = useMemo(() => (overview
        ? { ...full, cellWidth: geometry.cellWidth, rowWidth: geometry.rowWidth, fits: true }
        : full), [full, geometry, overview])

    const totalRows = doc?.totalRows || 0
    const drawnRowHeight = overview ? geometry.rowHeight : rowHeight
    const drawnLaneHeight = overview ? 0 : laneHeight
    const model = useMemo(
        () => createScrollModel({
            totalRows,
            rowHeight: drawnRowHeight,
            viewportPx,
            laneHeight: drawnLaneHeight,
            laneRows: doc.laneRows,
        }),
        [totalRows, drawnRowHeight, viewportPx, drawnLaneHeight, doc.laneRows],
    )

    // Attached by callback ref rather than by an effect, because this component
    // renders nothing at all while a focus is resolving. That unmounts the
    // scroller, and an effect that ran once on mount would never see the
    // replacement -- leaving both measurements frozen at whatever they were, so
    // the cells would stop resizing and the viewport would keep the row count it
    // had. A callback ref is handed every element, including the null on the way
    // out.
    //
    // Width as well as height: collapsing the focus panel gives this element the
    // room back, and the cells grow into it without the view having to be told
    // that is what happened.
    const observerRef = useRef(null)
    const attachScroller = useCallback((element) => {
        if (observerRef.current) {
            observerRef.current.disconnect()
            observerRef.current = null
        }
        scrollerRef.current = element
        if (!element || typeof ResizeObserver === 'undefined') return
        const measure = () => {
            setViewportPx((previous) => (previous === element.clientHeight ? previous : element.clientHeight))
            setAvailablePx((previous) => (previous === element.clientWidth ? previous : element.clientWidth))
        }
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        observerRef.current = observer
        measure()
    }, [])

    // A share of the screen rather than a fixed three rows -- and a bigger
    // share in the far view, where a row is a handful of rectangles rather than
    // sixty elements. What is placed is also what is asked for, so this is most
    // of what keeps a fast scroll supplied.
    const overscan = useMemo(
        () => overscanRows(drawnRowHeight > 0 ? viewportPx / drawnRowHeight : 0, { cheap: overview }),
        [viewportPx, drawnRowHeight, overview],
    )

    const window_ = useMemo(
        () => visibleRowRange(model, scrollTop, overscan),
        [model, scrollTop, overscan],
    )

    const rows = useMemo(
        () => documentRowsForRange(doc, window_.firstRow, window_.count),
        [doc, window_.firstRow, window_.count],
    )

    // The same question without the overscan: which rows the reader can see,
    // and therefore which stretch of the chromosome the bar should name. Asked
    // separately rather than trimmed off `rows`, because how many rows the
    // overscan covers at each end depends on where the scroll happens to sit.
    const onScreen = useMemo(() => {
        const range = visibleRowRange(model, scrollTop, 0)
        const pieces = []
        for (const entry of documentRowsForRange(doc, range.firstRow, range.count)) {
            if (entry.kind !== 'sequence') continue
            const line = displayRow(entry.section.layout, entry.local)
            for (const piece of line?.pieces || []) pieces.push({ s: piece.s, e: piece.e })
        }
        const intervals = mergeIntervals(pieces)
        return {
            start: intervals.length ? intervals[0].s : 0,
            end: intervals.length ? intervals[intervals.length - 1].e : 0,
            // How much sequence is on the screen, which is not the distance
            // between its ends: collapsed, and in a collection, the rows jump.
            bases: intervals.reduce((total, piece) => total + (piece.e - piece.s + 1), 0),
            pieces: intervals.length,
        }
    }, [doc, model, scrollTop])

    // A selection lives inside one record. Two records can be far apart or
    // overlap, so a range of coordinates means nothing across them -- and
    // columnAtCoord would happily clamp a coordinate from one record into the
    // nearest column of another, painting a highlight where nobody dragged.
    const selectionSection = useMemo(
        () => (selection ? sectionForCoord(doc, selection.start) : null),
        [doc, selection],
    )
    const selectionIn = useCallback((section) => {
        if (!selection || !selectionSection || section.key !== selectionSection.key) return null
        const from = columnAtCoord(section.layout, selection.start)
        const to = columnAtCoord(section.layout, selection.end)
        if (from === null || to === null) return null
        return { lo: Math.min(from, to), hi: Math.max(from, to) }
    }, [selection, selectionSection])

    /**
     * Where the selection begins and ends in the document, and where its bar
     * therefore goes.
     *
     * The rows are placed inside the scroller rather than on the screen, so
     * everything here is in the scroller's own coordinates: `slabTopPx` is
     * where the mounted rows start, and a row's own offset is measured from
     * there. That is the space the bar is positioned in too, which is what
     * makes it travel with the sequence rather than having to be moved on
     * every scroll.
     */
    const selectionRows = useMemo(() => {
        const range = selectionRange(selection)
        if (!range || !selectionSection) return null
        const first = documentRowOfCoord(doc, range.start, selectionSection.key)
        const last = documentRowOfCoord(doc, range.end, selectionSection.key)
        if (first === null || last === null) return null
        return { first: Math.min(first, last), last: Math.max(first, last) }
    }, [doc, selection, selectionSection])

    // A region is a region once the reader has let go of it. Until then the
    // second end is still following their hand, and a bar that appeared over
    // the first row would be a bar offering to act on something that is still
    // being decided -- and, in the two-click mode, on a single base.
    const settled = Boolean(selection) && !dragging && !pendingEnd

    // Room above the first row for the bar, where the selection starts at the
    // very top of the document and there is no row above it to sit over. Only
    // once there is a bar to make room for: the sequence shifting under a drag
    // that has not finished would move the very bases being dragged over.
    const topGap = settled && selectionRows ? selectionTopGap(selectionRows.first) : 0

    const selectionBar = useMemo(() => {
        if (!showSelectionBar || !settled || !selectionRows || !model?.heights) return null
        const offsetOf = (row) => model.heights.offsetOfRow(row)
        const base = window_.slabTopPx + topGap - offsetOf(window_.firstRow)
        const placed = selectionBarPlacement({
            firstRowTop: base + offsetOf(selectionRows.first),
            lastRowBottom: base + offsetOf(selectionRows.last) + rowHeightAt(model, selectionRows.last),
            // The top of the screen in the same coordinates: the gap, where
            // there is one, is above the rows and below this, which is what
            // leaves the bar somewhere to sit at the very top of a document.
            scrollTop,
            viewportPx,
        })
        return placed?.visible ? placed : null
    }, [showSelectionBar, settled, selectionRows, model, window_.slabTopPx, window_.firstRow,
        topGap, scrollTop, viewportPx])

    // What each row is, before anything is painted onto it.
    //
    // Kept apart from the painting because the viewport report below is derived
    // from it, and the painting depends on the sequence buffer -- an object
    // rebuilt on every render. Deriving the report from the painting made the
    // report a new object every render too, which set the viewport, which
    // painted again: a loop that React stops by throwing.
    const lines = useMemo(() => rows.map((entry) => {
        if (entry.kind === 'header') {
            return { key: `h:${entry.section.key}`, kind: 'header', row: entry.row, section: entry.section }
        }
        const line = displayRow(entry.section.layout, entry.local)
        if (!line) return null
        return {
            key: `${entry.section.key}:${entry.local}`,
            kind: 'sequence',
            row: entry.row,
            section: entry.section,
            line,
        }
    }).filter(Boolean), [rows])

    // ---- what each row draws -------------------------------------------
    //
    // Resolved per row rather than per document, because each record carries its
    // own layout and its own annotation. A header row draws a name and nothing
    // else, and costs a row like any other so that the scroller stays one
    // multiply.
    const painted = useMemo(() => (overview ? [] : lines.map((entry) => {
        if (entry.kind === 'header') return entry
        const section = entry.section
        const view = viewFor?.(section.key) || {}
        const line = entry.line
        const reverse = Boolean(section.layout.reverse)
        const lane = rowHasLane(model, entry.row)
        return {
            ...entry,
            reverse,
            lane,
            height: rowHeightAt(model, entry.row),
            ...paintDisplayRow(line, {
                readSequence: buffer.readSequence,
                maskedFor: buffer.maskedForRow,
                runs: view.runs || [],
                cdsFrame: view.cdsFrame || [],
                strand: view.strand || '+',
                // The record's own switches, which arrive with its runs: a
                // gene ticked off a location is drawn with the gene switches,
                // because those are the classes its runs are written in.
                allowed: view.allowed || null,
                // A selection lives inside one record: two records can be far
                // apart, or overlap, so a range of coordinates means nothing
                // across them.
                selection: selectionIn(section),
                // Where more than one gene covers the sequence, drawn as a rule
                // under the bases rather than as a colour over them.
                overlaps: view.overlaps || EMPTY_GENES,
                // The base a popup is open about, ringed so that the box and
                // the base it describes are visibly one thing.
                marked: markedCoord,
                // The feature the pointer is resting on in the list: its bases
                // underlined, and its first and last marked by the same amber
                // edge the annotation's own boundaries use -- which is the part
                // a reader is usually pointing at it to find.
                preview,
                genes: preview ? [{ id: 'preview', s: preview.s, e: preview.e }] : EMPTY_GENES,
                // Only the rows that carry a lane are translated, and those are
                // exactly the rows the height index made room for. One answer,
                // so a letter can never land on a row with nowhere to draw it.
                protein: lane,
                reverse,
                width: section.layout.width,
            }),
        }
    })), [overview, lines, viewFor, buffer, selectionIn, markedCoord, preview, model])

    // What the reader is looking at, reported up so the buffers know what to
    // fetch. `intervals` is the part that matters: the rows on screen can
    // straddle records half a chromosome apart, and asking for everything
    // between them would fetch all of it.
    const visible = useMemo(() => {
        const pieces = []
        const sequenceLines = lines.filter((item) => item.kind === 'sequence')
        for (const item of sequenceLines) {
            for (const piece of item.line.pieces) pieces.push({ s: piece.s, e: piece.e })
        }
        const intervals = mergeIntervals(pieces)
        const anchorItem = sequenceLines[Math.min(overscan, sequenceLines.length - 1)] || null
        const anchor = anchorItem?.line?.firstCoord ?? intervals[0]?.s ?? 0
        return {
            start: intervals.length ? intervals[0].s : 0,
            end: intervals.length ? intervals[intervals.length - 1].e : 0,
            anchor,
            anchorKey: anchorItem?.section?.key || '',
            intervals,
            // What is literally on the screen, which is not what the buffers
            // want: those are asked about the rows either side as well, so they
            // have the next screenful before the reader gets to it. A readout
            // fed the buffered range would name three rows the reader cannot
            // see, and would name them differently at the top and the bottom of
            // the same page.
            screen: onScreen,
        }
    }, [lines, onScreen, overscan])

    anchorCoordRef.current = visible.anchor
        ? { coord: visible.anchor, key: visible.anchorKey }
        : null

    useEffect(() => {
        onViewportChange?.(visible)
    }, [visible, onViewportChange])

    // Arriving somewhere new starts at the first row. Anything else would leave
    // the reader somewhere arbitrary in sequence they have just arrived at.
    // Keyed on what is being read rather than on the layout, so switching
    // between full and collapsed, or ticking another record onto the end, keeps
    // the reader's place -- that is what the anchor below is for.
    const documentKey = `${chrom}:${doc?.sections?.[0]?.key || ''}:${doc?.named ? 'records' : 'region'}`
    useEffect(() => {
        if (!selectMode) setPendingEnd(null)
    }, [selectMode])

    useLayoutEffect(() => {
        const element = scrollerRef.current
        if (element) element.scrollTop = 0
        setScrollTop(0)
        anchorCoordRef.current = null
        // The readout describes a base that is no longer under the pointer, and
        // would otherwise sit there naming the old coordinate against the new
        // chromosome until the pointer moved.
        setHover(null)
    }, [documentKey])

    // A taller row, a collapse, or another record above this one means the same
    // coordinate is at a different pixel offset. Put the reader back where they
    // were rather than where the number says.
    useLayoutEffect(() => {
        const element = scrollerRef.current
        const held = anchorCoordRef.current
        if (!element || !held || !doc || model.maxScrollTop <= 0) return
        const row = documentRowOfCoord(doc, held.coord, held.key)
        if (row === null) return
        const target = scrollTopForRow(model, row)
        if (Math.abs(element.scrollTop - target) > 1) {
            element.scrollTop = target
            setScrollTop(target)
        }
        // Only when the geometry changes, never when the scroll position does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowHeight, laneHeight, viewportPx, totalRows, doc])

    // Put a coordinate at the top of the screen, when something outside asks --
    // a gene picked from the list, a search that matched. Keyed on a nonce
    // rather than the coordinate, so asking for the same place twice still
    // moves, which is what someone clicking the same gene again expects.
    useEffect(() => {
        const element = scrollerRef.current
        if (!element || !doc) return
        const row = scrollTo?.recordKey
            ? rowOfRecord(doc, scrollTo.recordKey)
            : documentRowOfCoord(doc, Number(scrollTo?.coord))
        if (row === null) return
        const target = scrollTopForRow(model, row)
        element.scrollTop = target
        setScrollTop(target)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scrollTo?.nonce])

    const handleScroll = useCallback((event) => {
        setScrollTop(event.currentTarget.scrollTop)
    }, [])

    // A wheel notch is a distance the reader expects the sequence to move. For a
    // very large region the spacer is compressed, so handing the delta to the
    // scroll position would multiply it -- on a whole chromosome a single notch
    // would jump some two kilobases. Translate it into rows instead.
    const handleWheel = useCallback((event) => {
        const element = scrollerRef.current
        if (!element || model.compression <= 1 || event.ctrlKey) return
        event.preventDefault()
        markWheelHandled(event.nativeEvent)
        const from = rowAtScrollTop(model, element.scrollTop)
        const target = scrollTopForRow(model, wheelTargetRow(model, from, event.deltaY))
        element.scrollTop = target
        setScrollTop(target)
    }, [model])

    // ---- pointer -------------------------------------------------------

    /**
     * Which cell the pointer is over.
     *
     * Found by where the pointer is rather than by what the event hit, because
     * a drag holds pointer capture on the scroller and a captured pointer
     * retargets its events there. Reading `event.target` during a drag
     * therefore finds the scroller and never a cell, which left a selection
     * stuck at the one base it started on.
     *
     * These are pointer events rather than mouse events for the same reason:
     * a captured pointer's compatibility mouse events are not delivered at all,
     * so a `mousemove` handler simply stops being called once the drag begins.
     */
    const cellAt = useCallback((event) => {
        let cell = event.target?.closest?.('[data-offset]')
        let line = event.target?.closest?.('[data-row-index]')
        if (!cell || !line) {
            const under = typeof document !== 'undefined'
                ? document.elementFromPoint(event.clientX, event.clientY)
                : null
            cell = under?.closest?.('[data-offset]') || null
            line = under?.closest?.('[data-row-index]') || null
        }
        if (!cell || !line) return null
        const offset = Number(cell.dataset.offset)
        const index = Number(line.dataset.rowIndex)
        if (!Number.isFinite(offset) || !Number.isFinite(index)) return null
        return { offset, index }
    }, [])

    /**
     * The cell a press meant, rather than the one it hit.
     *
     * Selecting is a gesture over a region, not a click on one base, and asking
     * a reader to start it exactly on a cell is asking more than the gesture
     * needs. A row is 26 px of which the bases are about 20, so a press a
     * couple of pixels high lands in the space between two rows; a press near
     * the ends of a row lands on the coordinate margin. Both used to do nothing
     * at all -- and doing nothing left the press to the browser, which took it
     * as the start of a text selection and dragged a highlight across the
     * numbers.
     *
     * So a press that missed is placed: the nearest row by how far outside it
     * the press was, and within that row the base the press is level with,
     * clamped to its ends. Only for the tool's own gestures -- what the readout
     * says under the pointer, and which base a plain click asks about, are still
     * answered by what was actually under it.
     */
    const nearestCell = useCallback((event) => {
        const exact = cellAt(event)
        if (exact) return exact
        const scroller = scrollerRef.current
        if (!scroller) return null
        let best = null
        let bestGap = Infinity
        for (const line of scroller.querySelectorAll('[data-row-index]')) {
            const box = line.getBoundingClientRect()
            const gap = gapToBand(event.clientY, box.top, box.bottom)
            if (gap < bestGap) {
                best = line
                bestGap = gap
                if (gap === 0) break
            }
        }
        const index = Number(best?.dataset.rowIndex)
        const cells = best ? best.querySelectorAll('[data-offset]') : []
        if (!Number.isFinite(index) || cells.length === 0) return null
        const first = cells[0].getBoundingClientRect()
        const last = cells[cells.length - 1].getBoundingClientRect()
        const column = columnAtX(event.clientX, {
            left: first.left, right: last.right, count: cells.length,
        })
        if (column === null) return null
        const offset = Number(cells[column].dataset.offset)
        return Number.isFinite(offset) ? { offset, index } : null
    }, [cellAt])

    /** The record and column a document row and cell offset land in. */
    const placeAt = useCallback((index, offset) => {
        const entry = documentRow(doc, index)
        if (!entry || entry.kind !== 'sequence') return null
        const { layout } = entry.section
        return { section: entry.section, layout, column: entry.local * layout.width + offset }
    }, [doc])

    /**
     * Carry the live end of a drag to wherever the pointer has reached.
     *
     * A drag only ever moves between bases: a marker stands for sequence that
     * is not on screen, so passing over it leaves the head where it was and the
     * selection jumps the collapse in one step. It also stays in the record it
     * began in, because a range running from one record into another describes
     * neither of them.
     */
    const extendDrag = useCallback((at) => {
        if (!dragRef.current || !at) return
        const place = placeAt(at.index, at.offset)
        const coord = place ? coordAtColumn(place.layout, place.column) : null
        if (coord === null || place.section.key !== dragRef.current.sectionKey) return
        dragRef.current.head = coord
        onSelectionChange?.({ start: dragRef.current.anchor, end: coord })
    }, [placeAt, onSelectionChange])

    /**
     * Carry the loose end of a half-made two-click selection to the pointer.
     *
     * Between the two clicks the reader is holding nothing, but they are still
     * drawing: the end follows them, the region outlines as it grows and the
     * rest of the page stays dim, so what the second click is about to take is
     * on the screen before it is taken rather than after. The anchor is left
     * alone -- only the far end moves -- and, as with a drag, a pointer that
     * has wandered into another record is not somewhere this selection can go.
     */
    const extendPending = useCallback((at) => {
        if (!pendingEnd || !at) return
        const place = placeAt(at.index, at.offset)
        const coord = place ? coordAtColumn(place.layout, place.column) : null
        if (coord === null || place.section.key !== pendingEnd.sectionKey) return
        onSelectionChange?.({ start: pendingEnd.coord, end: coord })
    }, [pendingEnd, placeAt, onSelectionChange])

    const handleHover = useCallback((event) => {
        const press = pressRef.current
        if (press && !press.moved) {
            const travelled = Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y)
            if (travelled > CLICK_SLOP_PX) press.moved = true
        }
        const at = cellAt(event)
        if (!at) {
            setHover(null)
            // Nothing under the pointer to describe, but a gesture in hand
            // still has somewhere to be: over a margin or between two rows it
            // keeps going from the base it is level with.
            const near = dragRef.current || pendingEnd ? nearestCell(event) : null
            if (dragRef.current) extendDrag(near)
            else extendPending(near)
            return
        }
        const { index, offset } = at
        const entry = painted.find((item) => item.kind === 'sequence' && item.row === index)
        const place = placeAt(index, offset)
        const coord = place ? coordAtColumn(place.layout, place.column) : null
        setHover({
            coord,
            // Over a marker there is no base to describe, so the readout
            // describes the stretch the marker stands for instead.
            gap: coord === null && place ? gapAtColumn(place.layout, place.column) : null,
            x: event.clientX,
            y: event.clientY,
            base: entry?.sequence?.[offset] || '',
            code: entry?.classes?.[offset] || '',
            // The colour can only say the bases are contested; the count says by
            // how many, which is the question a reader has once they see the
            // rule under them.
            genes: coord === null ? 0 : overlapDepthAt(
                viewFor?.(place?.section?.key)?.overlaps, coord,
            ),
        })
        extendDrag(at)
        extendPending(at)
    }, [cellAt, nearestCell, extendDrag, extendPending, pendingEnd, placeAt, painted, viewFor])

    /** How far past the top or bottom of the sequence a point is, in pixels. */
    const edgeAt = useCallback((y) => {
        const element = scrollerRef.current
        if (!element) return 0
        const bounds = element.getBoundingClientRect()
        if (y < bounds.top) return y - bounds.top
        if (y > bounds.bottom) return y - bounds.bottom
        return 0
    }, [])

    // Every pointer move during a drag, including the ones over no cell at all:
    // outside the sequence there is nothing to hover, but there is still a
    // distance past the edge to scroll by.
    const trackPointer = useCallback((event) => {
        if (!dragRef.current) return
        pointerRef.current = { x: event.clientX, y: event.clientY }
        const edge = edgeAt(event.clientY)
        setEdgeHold((previous) => (previous === edge ? previous : edge))
    }, [edgeAt])

    const handleLeave = useCallback(() => setHover(null), [])

    /**
     * Put a finished selection where its bar can be read.
     *
     * The bar's top against the top of the screen, and the selection's first
     * row immediately under it. Wherever the reader was when they let go --
     * three screens down a long drag, or at the far end of a two-click
     * selection -- the region and the controls over it arrive in one place
     * together, rather than the bar being somewhere off the top of the screen
     * with the reader left to go looking for it.
     *
     * Where the selection starts at the very top of the document there is a gap
     * above the rows for the bar to sit in, so the scroll is simply to the top.
     */
    const revealSelection = useCallback((from, to, sectionKey) => {
        const element = scrollerRef.current
        if (!element || !model?.heights) return
        const low = Math.min(from, to)
        const row = documentRowOfCoord(doc, low, sectionKey)
        if (row === null) return
        const height = rowHeightAt(model, row) || model.rowHeight || 1
        // In rows rather than in pixels, because a scroll position is not a
        // distance once the spacer is compressed -- see sequenceViewScroll.js.
        const back = selectionTopGap(row) ? 0 : SELECTION_BAR_HEIGHT / height
        const target = scrollTopForRow(model, Math.max(0, row - back))
        element.scrollTop = target
        setScrollTop(target)
    }, [doc, model])

    const handlePointerDown = useCallback((event) => {
        if (event.button !== 0) return
        // Where the press began, so that a release in the same place can be told
        // from a drag. A click is a press that did not move: the reader asking
        // about one base, rather than gathering a run of them.
        pressRef.current = { x: event.clientX, y: event.clientY, moved: false }
        // Selecting is only with the tool in hand. Everywhere else in the app a
        // rectangle is something you arm first, and a drag that silently
        // selected would take the gesture away from whatever else might want it.
        if (!selectMode) return
        const at = nearestCell(event)
        if (!at) return
        const place = placeAt(at.index, at.offset)
        const coord = place ? coordAtColumn(place.layout, place.column) : null
        if (coord === null) return
        event.preventDefault()

        // Two clicks: the first marks an end and nothing is captured, so the
        // page is the reader's between them -- which is the point of this mode,
        // since a selection longer than a screen cannot be dragged without
        // holding the button while the page moves under it.
        if (selectStyle === SELECT_ENDS) {
            // Both clicks belong to the tool, so neither is also a question
            // about the base under it. The second one especially: it puts the
            // tool down, and the release that follows would otherwise arrive
            // with the tool already down and read as an ordinary click,
            // opening the base box over the selection just drawn.
            pressRef.current.consumed = true
            if (!pendingEnd || pendingEnd.sectionKey !== place.section.key) {
                setPendingEnd({ coord, sectionKey: place.section.key })
                onSelectionChange?.({ start: coord, end: coord })
                return
            }
            setPendingEnd(null)
            onSelectionChange?.({ start: pendingEnd.coord, end: coord })
            onSelectionDone?.()
            revealSelection(pendingEnd.coord, coord, place.section.key)
            return
        }
        // Captured on the scroller rather than the cell, so the drag survives
        // leaving the row it began on -- which it does immediately, since
        // selecting more than sixty bases means crossing into the next row.
        scrollerRef.current?.setPointerCapture?.(event.pointerId)
        dragRef.current = {
            anchor: coord, head: coord, at, pointerId: event.pointerId,
            sectionKey: place.section.key,
        }
        pointerRef.current = { x: event.clientX, y: event.clientY }
        setEdgeHold(0)
        setDragging(true)
        onSelectionChange?.({ start: coord, end: coord })
    }, [selectMode, selectStyle, pendingEnd, nearestCell, placeAt, onSelectionChange, onSelectionDone, revealSelection])

    const endDrag = useCallback((event) => {
        // A press released where it began is a question about that base. Not
        // while the select tool is armed: there the gesture belongs to the tool,
        // and a box opening mid-selection would be in the way.
        const press = pressRef.current
        pressRef.current = null
        if (press && !press.moved && !press.consumed && !selectMode && onBaseClick && event) {
            const at = cellAt(event)
            const place = at ? placeAt(at.index, at.offset) : null
            const coord = place ? coordAtColumn(place.layout, place.column) : null
            if (coord !== null) {
                const cell = document.elementFromPoint(event.clientX, event.clientY)
                const box = cell?.getBoundingClientRect?.()
                onBaseClick({
                    coord,
                    // The cell's own edges, not the pointer's position: the box
                    // hangs off the side of the base and its arrow meets that
                    // side, which it cannot do from a point inside the cell.
                    anchor: box ? {
                        left: box.left,
                        right: box.right,
                        mid: box.top + box.height / 2,
                    } : {
                        left: event.clientX, right: event.clientX, mid: event.clientY,
                    },
                })
            }
        }
        if (!dragRef.current) return
        scrollerRef.current?.releasePointerCapture?.(dragRef.current.pointerId ?? event?.pointerId)
        const { anchor, head, sectionKey } = dragRef.current
        const drew = head !== anchor
        dragRef.current = null
        pointerRef.current = null
        setEdgeHold(0)
        setDragging(false)
        // The tool is put down as soon as it has been used. Leaving it armed
        // meant the next click anywhere threw the selection away and started a
        // new one of a single base, which is never what the click was for.
        if (drew) {
            onSelectionDone?.()
            revealSelection(anchor, head, sectionKey)
        }
    }, [selectMode, onBaseClick, cellAt, placeAt, onSelectionDone, revealSelection])

    // Held past the top or bottom edge, the view keeps going, so a selection can
    // reach past what is on screen. It runs until the pointer comes back inside
    // or the drag ends -- not until the pointer next moves, which is what made
    // it scroll a little and then stop.
    useEffect(() => {
        if (!edgeHold || !dragRef.current) return undefined
        const element = scrollerRef.current
        if (!element) return undefined

        const direction = edgeHold < 0 ? -1 : 1
        const past = Math.min(Math.abs(edgeHold), AUTOSCROLL_FULL_SPEED_PX)
        const rows = AUTOSCROLL_MIN_ROWS_PER_FRAME
            + (past / AUTOSCROLL_FULL_SPEED_PX) * (AUTOSCROLL_MAX_ROWS_PER_FRAME - AUTOSCROLL_MIN_ROWS_PER_FRAME)

        let frame = null
        const step = () => {
            const next = scrollTopForRow(model, rowAtScrollTop(model, element.scrollTop) + direction * rows)
            if (next !== element.scrollTop) {
                element.scrollTop = next
                setScrollTop(next)
                // The rows have moved under a pointer that has not, so what is
                // under it now is a different base -- and that is the whole
                // point of scrolling: to go on gathering bases while held.
                const held = pointerRef.current
                if (held && dragRef.current) {
                    const under = document.elementFromPoint(held.x, Math.min(
                        element.getBoundingClientRect().bottom - 2,
                        Math.max(element.getBoundingClientRect().top + 2, held.y),
                    ))
                    const cell = under?.closest?.('[data-offset]')
                    const line = under?.closest?.('[data-row-index]')
                    if (cell && line) {
                        const place = placeAt(
                            Number(line.dataset.rowIndex), Number(cell.dataset.offset),
                        )
                        const coord = place ? coordAtColumn(place.layout, place.column) : null
                        if (coord !== null && place.section.key === dragRef.current.sectionKey) {
                            dragRef.current.head = coord
                            onSelectionChange?.({ start: dragRef.current.anchor, end: coord })
                        }
                    }
                }
            }
            frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => { if (frame != null) cancelAnimationFrame(frame) }
    }, [edgeHold, model, placeAt, onSelectionChange])

    // Putting the tool down ends whatever it was doing.
    useEffect(() => {
        if (selectMode) return
        dragRef.current = null
        pointerRef.current = null
        setEdgeHold(0)
    }, [selectMode])

    if (!doc?.totalRows) return null

    return (
        <div
            ref={attachScroller}
            onScroll={handleScroll}
            onWheel={handleWheel}
            onPointerMove={(event) => { trackPointer(event); handleHover(event) }}
            onPointerLeave={handleLeave}
            onPointerDown={handlePointerDown}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`relative h-full overflow-y-auto ${metrics.fits ? 'overflow-x-hidden' : 'overflow-x-auto'}`}
            style={selectMode ? { cursor: 'crosshair', userSelect: 'none' } : undefined}
            data-sequence-view-scroller="true"
        >
            <div style={{ height: `${model.spacerPx + topGap}px`, width: `${metrics.rowWidth}px`, margin: '0 auto' }} />

            {/* Inside the scroller, so it travels with the rows it belongs to
                rather than having to be chased across the screen on every
                scroll. Before the slab in the markup and above it by z-index,
                since while the reader is scrolling through a long selection it
                sits over the rows at the top of the screen. */}
            {selectionBar ? (
                <SelectionBar
                    selection={selection}
                    chrom={chrom}
                    isLight={isLight}
                    top={selectionBar.top}
                    rowWidth={metrics.rowWidth}
                    onFocusRegion={onSelectionFocus}
                    onCopy={onSelectionCopy}
                    onDownload={onSelectionDownload}
                    onBrowse={onSelectionBrowse}
                    onClear={onSelectionClear}
                />
            ) : null}
            <div
                className="absolute top-0"
                style={{
                    transform: `translateY(${window_.slabTopPx + topGap}px)`,
                    width: `${metrics.rowWidth}px`,
                    // Centred in whatever the panel has left, rather than pinned
                    // to the left edge with the spare room all on one side.
                    left: '50%',
                    marginLeft: `${-metrics.rowWidth / 2}px`,
                }}
            >
                {overview ? (
                    <SequenceOverview
                        doc={doc}
                        rows={rows}
                        viewFor={viewFor}
                        geometry={geometry}
                        model={model}
                        palette={palette}
                        isLight={isLight}
                        preview={preview}
                        width={metrics.rowWidth}
                        height={Math.max(1, (rows.length + 1) * geometry.rowHeight)}
                        offsetPx={0}
                    />
                ) : painted.map((item) => (item.kind === 'header' ? (
                    <SequenceRecordHeading
                        key={item.key}
                        record={item.section.record}
                        layout={item.section.layout}
                        rowHeight={rowHeight}
                        width={metrics.rowWidth}
                        isLight={isLight}
                    />
                ) : (
                    <SequenceRow
                        key={item.key}
                        // The document row, not the record's own: everything
                        // that reads this attribute back -- hover, drag -- asks
                        // the document which record a row belongs to, and the
                        // spread carries an `index` of its own that would
                        // silently answer with the wrong one.
                        row={{ ...item.line, index: item.row }}
                        sequence={item.sequence}
                        classes={item.classes}
                        mask={item.mask}
                        edges={item.edges}
                        amino={item.amino}
                        lane={item.lane}
                        labels={{ left: item.line.firstCoord, right: item.line.lastCoord }}
                        rowHeight={item.height}
                        palette={palette}
                        cellWidth={metrics.cellWidth}
                        fontSize={metrics.fontSize}
                        isLight={isLight}
                        // Whether anything is being pointed at in the list
                        // beside the sequence. The row dims whatever is not
                        // part of it, which is what makes the stretch itself
                        // legible at a glance.
                        previewing={Boolean(preview)}
                        // A selection dims what is outside it, the way the
                        // pointer's feature does -- from the first move of the
                        // gesture rather than once it is let go. The dimming is
                        // what shows the reader the stretch they are gathering:
                        // waiting until the end meant dragging across an
                        // unchanged page and only then seeing what had been
                        // taken. It is the same while a two-click selection is
                        // half made, where the second end follows the pointer.
                        selecting={Boolean(selection)}
                    />
                )))}
            </div>
            <SequenceHoverTip hover={hover} isLight={isLight} chrom={chrom} palette={palette} />
        </div>
    )
}
