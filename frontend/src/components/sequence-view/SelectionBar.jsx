import { useLayoutEffect, useRef, useState } from 'react'

import {
    BrowserGlyph,
    CloseGlyph,
    CopyGlyph,
    DownloadGlyph,
    VerticalChevronGlyph,
} from '../focusDrawerChrome'
import { SELECTION_BAR_HEIGHT, barAlongRow, selectionActions } from '../../utils/sequenceViewSelect'

/**
 * What to do with a stretch that has been selected.
 *
 * **Where it is.** Over the top row of the selection, right-aligned with the
 * sequence, and held at the top of the screen once the reader has scrolled down
 * past that row -- so a selection longer than the screen keeps its bar the
 * whole way down instead of leaving it behind at the top. It is part of the
 * scrolling content rather than a box floating at the pointer: a selection is a
 * thing on the page, and its controls belong to it rather than to wherever the
 * mouse happens to be resting.
 *
 * **What is on it.** The region's name, and the actions as marks -- plus, for
 * a selection, one button that says in words what it does. Setting the location
 * is the one action here that changes what the whole view is reading, and the
 * app already spends its target-shaped icon on two different meanings -- jump
 * there, and focus on it -- so a third reading of the same mark would be a
 * guess, and it gets words instead. It is offered only where it is wanted: see
 * the note beside it. The marks are the same ones they are in the focus drawer,
 * doing the same things.
 *
 * **It serves the Find box's current match as well.** A match is a stretch of
 * sequence the reader has picked out, which is the same kind of thing a
 * selection is, and everything they might want to do with one they might want
 * to do with the other. So the bar is the bar, and what differs is the line
 * under the coordinates -- `caption` -- and what closing it means.
 */
export default function SelectionBar({
    selection,
    chrom,
    isLight,
    top,
    rowWidth,
    // What the stretch is, under its coordinates: how many bases were selected,
    // or which match of how many this is.
    caption = '',
    clearLabel = 'Clear the selection',
    // Stepping to the stretch either side of this one. Only the Find box's
    // bar has anywhere to step to; a selection is the only one of its kind.
    onPrev,
    onNext,
    // Where along the row the stretch is, in pixels, so the bar can point at
    // it. Two numbers rather than a pair, so they can be depended on: -1 is a
    // selection, which is usually rows long and has no one place along a row
    // that is where it is, so its bar stays at the end of one.
    alignLeft = -1,
    alignRight = -1,
    onFocusRegion,
    onCopy,
    onDownload,
    onBrowse,
    onClear,
}) {
    const { range, bases, canFocus, canCopy, canBrowse, copyRefusal } = selectionActions(selection)

    /**
     * Placing the bar along the row needs its width, and its width is whatever
     * its contents come to -- a coordinate pair and a count, both of which
     * change. So it is measured after it is laid out and placed before it is
     * painted, which is the one thing `useLayoutEffect` is for: done in an
     * ordinary effect the reader would see it at the end of the row for a
     * frame and then jump.
     */
    const bar = useRef(null)
    const [barWidth, setBarWidth] = useState(0)
    const aligned = alignLeft >= 0
    useLayoutEffect(() => {
        if (!aligned || !bar.current) return
        const measured = bar.current.offsetWidth
        setBarWidth((previous) => (previous === measured ? previous : measured))
    }, [aligned, caption, chrom, range?.start, range?.end, rowWidth])

    if (!range) return null

    const along = aligned && barWidth
        ? barAlongRow({ matchLeft: alignLeft, matchRight: alignRight, barWidth, rowWidth })
        : null

    return (
        <div
            className="sv-selection-track"
            style={{
                top: `${Math.round(top)}px`,
                width: `${rowWidth}px`,
                marginLeft: `${-rowWidth / 2}px`,
                height: `${SELECTION_BAR_HEIGHT}px`,
                // Until it has been measured it stays where a selection's bar
                // lives, at the end of the row. One frame, and never seen: the
                // measurement happens before the paint.
                ...(along === null ? null : { justifyContent: 'flex-start' }),
            }}
        >
            <div
                ref={bar}
                className={`sv-selection-bar ${isLight ? 'light' : ''}`}
                style={along === null ? undefined : { marginLeft: `${along}px` }}
                data-sequence-selection-bar="true"
                // The bar sits over the bases, and a press on it is a press on
                // the bar: without this the selection tool underneath would take
                // it as the start of a new drag.
                onPointerDown={(event) => event.stopPropagation()}
            >
                <span className="sv-selection-what">
                    <span className="sv-selection-where">
                        {chrom}:{range.start.toLocaleString()}&ndash;{range.end.toLocaleString()}
                    </span>
                    <span className="sv-selection-size">
                        {caption || `${bases.toLocaleString()} bp selected`}
                    </span>
                </span>

                {/* Beside the count they move, because that is what they
                    move: "match 3 of 903" is the thing these two change. A
                    reader stepping through matches should not have to go back
                    up to the find box to do it while its bar is under their
                    pointer. */}
                {onPrev || onNext ? (
                    <span className="sv-selection-step">
                        <Mark
                            label="Previous match"
                            title="Previous match"
                            disabled={!onPrev}
                            onClick={onPrev}
                        ><VerticalChevronGlyph size={14} /></Mark>
                        <Mark
                            label="Next match"
                            title="Next match"
                            disabled={!onNext}
                            onClick={onNext}
                        ><VerticalChevronGlyph size={14} pointsDown /></Mark>
                    </span>
                ) : null}

                {/* Only where somebody wants it. Reading a *selection* as the
                    location is the one action here that changes what the whole
                    view is reading, which is why it is the one said in words --
                    but a Find match is a handful of bases the reader is passing
                    through, and reframing the view around each one as they step
                    is almost never what they mean. */}
                {onFocusRegion ? (
                    <button
                        type="button"
                        className="sv-selection-set"
                        data-selection-action="Set as the location"
                        disabled={!canFocus}
                        onClick={onFocusRegion}
                        title="Read this region as the location in focus, in place of the current one"
                    >
                        Set as the location
                    </button>
                ) : null}

                <span className="sv-selection-acts">
                    <Mark
                        label="Copy as FASTA"
                        title={canCopy ? 'Copy this region as FASTA' : copyRefusal}
                        disabled={!canCopy}
                        onClick={onCopy}
                    ><CopyGlyph size={14} /></Mark>
                    <Mark
                        label="Download"
                        title="Download this region — choose the shape and the format"
                        onClick={onDownload}
                    ><DownloadGlyph size={14} /></Mark>
                    <Mark
                        label="Show in the genome browser"
                        title="Show this region in the genome browser"
                        disabled={!canBrowse}
                        onClick={onBrowse}
                    ><BrowserGlyph size={15} /></Mark>
                    <Mark
                        label={clearLabel}
                        title={clearLabel}
                        onClick={onClear}
                    ><CloseGlyph size={13} /></Mark>
                </span>
            </div>
        </div>
    )
}

function Mark({ label, title, disabled = false, onClick, children }) {
    return (
        <button
            type="button"
            className="sv-selection-mark"
            data-selection-action={label}
            aria-label={label}
            title={title || label}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </button>
    )
}
