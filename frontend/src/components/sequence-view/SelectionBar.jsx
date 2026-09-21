import { BrowserGlyph, CloseGlyph, CopyGlyph, DownloadGlyph } from '../focusDrawerChrome'
import { SELECTION_BAR_HEIGHT, selectionActions } from '../../utils/sequenceViewSelect'

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
 * **What is on it.** The region's name, one button that says in words what it
 * does, and the rest as marks. Setting the location is the one action here that
 * changes what the whole view is reading, and the app already spends its
 * target-shaped icon on two different meanings -- jump there, and focus on it
 * -- so a third reading of the same mark would be a guess. The others are the
 * same marks they are in the focus drawer, doing the same things.
 */
export default function SelectionBar({
    selection,
    chrom,
    isLight,
    top,
    rowWidth,
    onFocusRegion,
    onCopy,
    onDownload,
    onBrowse,
    onClear,
}) {
    const { range, bases, canFocus, canCopy, canBrowse, copyRefusal } = selectionActions(selection)
    if (!range) return null

    return (
        <div
            className="sv-selection-track"
            style={{
                top: `${Math.round(top)}px`,
                width: `${rowWidth}px`,
                marginLeft: `${-rowWidth / 2}px`,
                height: `${SELECTION_BAR_HEIGHT}px`,
            }}
        >
            <div
                className={`sv-selection-bar ${isLight ? 'light' : ''}`}
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
                    <span className="sv-selection-size">{bases.toLocaleString()} bp selected</span>
                </span>

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
                        label="Clear the selection"
                        title="Clear the selection"
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
