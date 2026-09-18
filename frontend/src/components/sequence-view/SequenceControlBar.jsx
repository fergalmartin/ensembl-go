import { useState } from 'react'

import { formatDistance } from '../../utils/sequenceViewDistance'
import {
    ZOOM_FULL,
    ZOOM_MIN,
    ZOOM_STEP,
    clampZoom,
    zoomFraction,
    zoomLabel,
} from '../../utils/sequenceViewZoom'
import ColourTool from './ColourTool'
import FeatureTool from './FeatureTool'

function MagnifierGlyph() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

/** The way back to full size. */
function CloseGlyph() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

/** The rectangle every other view in the app arms a selection with. */
function SelectGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
            <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
        </svg>
    )
}

function SpinnerGlyph() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 3a9 9 0 1 0 9 9">
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 12 12"
                    to="360 12 12"
                    dur="0.8s"
                    repeatCount="indefinite"
                />
            </path>
        </svg>
    )
}

/**
 * The bar across the top: where to look, and how to look at it.
 *
 * Everything here changes what is on screen without changing what is in focus --
 * the focus panel on the right owns that. So this is where a control belongs
 * when it is about the reading rather than about the thing being read.
 *
 * It is drawn in the app's two existing control-bar idioms rather than in one of
 * its own: the bar is the genome browser's, and the controls on it are the
 * alignment explorer's -- a quiet label over the applied value, a chevron where
 * there is a menu behind it, and the menu drawn over the page and pinned to its
 * button. See `controls.css`.
 */
export default function SequenceControlBar({
    root = null,
    options,
    genomeKey,
    onGenomeChange,
    focus,
    region,
    viewport,
    onSearch,
    searchError,
    onClearSearchError,
    searching,
    pending,
    indexBuilding,
    selectMode,
    onSelectModeChange,
    zoom = 1,
    onZoomChange,
    collapse,
    flanks,
    reverse,
    protein,
    proteinAvailable,
    readingReverse,
    collapseOffers,
    collapseLimited,
    onFeatureApply,
    colours,
    palette,
    theme,
    onColourChange,
    onColourReset,
    layout,
    collapses,
    collapsePending,
    collapseError,
    collapseGeneCount,
    introsPriced,
    plainClasses = false,
    plainGeneCount = 0,
    hiddenCount = 0,
    onShowEverything,
}) {
    const [draft, setDraft] = useState('')

    const submit = (event) => {
        event.preventDefault()
        onSearch(draft)
    }

    const hidden = layout?.hidden || 0
    const breaks = layout?.gaps || 0
    const anyCollapse = Boolean(collapse?.intergenic?.on || collapse?.intron?.on)

    // What the view has to say about what it is showing, in the order a reader
    // needs it: what went wrong first, then what is being waited for, then what
    // was done to the sequence that they did not ask for in so many words.
    const notes = []
    if (searchError) notes.push({ key: 'search', warn: true, text: searchError })
    else if (searching) notes.push({ key: 'searching', text: 'Searching…' })
    else if (indexBuilding) {
        notes.push({
            key: 'index',
            text: 'Building this genome’s annotation index — sequence still reads.',
        })
    } else if (pending) notes.push({ key: 'pending', text: 'Loading…' })

    if (anyCollapse && collapseError) {
        notes.push({ key: 'collapse-error', warn: true, text: collapseError })
    } else if (anyCollapse) {
        notes.push({
            key: 'collapse',
            warn: introsPriced,
            text: collapsePending ? 'Working out what can be left out…'
                // Only where the answer said this is why. Reached from the mere
                // absence of a kind, it told a reader with twelve genes in front
                // of them that there were too many genes to read.
                : introsPriced ? (
                    `Too many genes here (${collapseGeneCount.toLocaleString()}) to collapse their introns, `
                    + `so only the sequence between genes is hidden — ${formatDistance(hidden)} `
                    + `in ${breaks.toLocaleString()} ${breaks === 1 ? 'break' : 'breaks'}. `
                    + 'Focus a gene to collapse its introns.'
                ) : breaks === 0 ? (
                    'Nothing here is long enough to be worth collapsing — every base is shown.'
                ) : (
                    `${describeCollapses(collapses)} hidden: ${formatDistance(hidden)} `
                    + `in ${breaks.toLocaleString()} ${breaks === 1 ? 'break' : 'breaks'}.`
                ),
        })
    }

    // Why the colours went coarse. A location is normally drawn in the same
    // classes a gene is; where the genes are too thick on the ground to read
    // every isoform, it says so rather than letting the reader think the
    // annotation itself changed.
    if (plainClasses) {
        notes.push({
            key: 'plain',
            text: `Too many genes here (${plainGeneCount.toLocaleString()}) to read every isoform, `
                + 'so this stretch is shown as genic and intergenic only. '
                + 'Focus a gene to see its coding sequence.',
        })
    }

    // Nothing to say until the first rows have been placed and measured.
    const screen = viewport?.screen?.end ? viewport.screen : null

    return (
        // The tokens are on the view's root, not here: a menu is portalled into
        // that root and has to inherit them. See SequenceView and controls.css.
        <div>
            <div className="sv-bar">
                <select
                    value={genomeKey}
                    onChange={(event) => onGenomeChange(event.target.value)}
                    aria-label="Genome"
                >
                    {options.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                </select>

                {/* The box and its button are one control: the browser's search
                    has both, and someone who prefers pressing a button to
                    trusting the return key should find the same thing here. */}
                <form onSubmit={submit} className="sv-find">
                    <input
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value)
                            if (searchError) onClearSearchError()
                        }}
                        placeholder="Location or gene symbol/ID"
                        title="A region such as 1:1,000-2,000, or a gene symbol, gene ID or transcript ID"
                        aria-label="Go to a location or a gene"
                    />
                    <button
                        type="submit"
                        className="sv-icon-button"
                        disabled={searching}
                        title="Go to this location or gene"
                        aria-label="Go to this location or gene"
                    >
                        {searching ? <SpinnerGlyph /> : <MagnifierGlyph />}
                    </button>
                </form>

                <div className="sv-divider" />

                {/* Armed rather than always on, which is how a rectangle works
                    everywhere else in the app. The inset ring is the browser's
                    way of showing a tool is in hand. */}
                <button
                    type="button"
                    className="sv-icon-button"
                    onClick={() => onSelectModeChange(!selectMode)}
                    aria-pressed={selectMode}
                    aria-label="Select bases"
                    title={selectMode
                        ? 'Selection tool in hand: drag a rectangle over the bases to select'
                        : 'Select bases by dragging a rectangle over them'}
                >
                    <SelectGlyph />
                </button>

                <FeatureTool
                    collapse={collapse}
                    flanks={flanks}
                    reverse={reverse}
                    protein={protein}
                    proteinAvailable={proteinAvailable}
                    readingReverse={readingReverse}
                    offers={collapseOffers}
                    limited={collapseLimited}
                    root={root}
                    onApply={onFeatureApply}
                />

                <ColourTool
                    colours={colours}
                    palette={palette}
                    theme={theme}
                    root={root}
                    onChange={onColourChange}
                    onReset={onColourReset}
                />

                {/* Zooming out keeps the rows and shrinks them, so a smaller
                    row is not more sequence per line -- sixty is what the view
                    is -- but more lines at once, which is the axis the question
                    "where does this fall" is asked along. The cross is the way
                    back, because the far view is not somewhere to stay. */}
                <div className="sv-zoom" data-sequence-zoom="true">
                    {/* Boxed like the controls either side of it, and its name
                        set in their type: it is one of the bar's controls and
                        should not read as a stray label with a slider after
                        it. The cross stands outside the box because it is an
                        action rather than part of the setting. */}
                    <label className="sv-zoom-box" title="Zoom out to see more of the region at once">
                        <span className="sv-control-name">Zoom</span>
                        <input
                            type="range"
                            min={ZOOM_MIN}
                            max={ZOOM_FULL}
                            step={ZOOM_STEP}
                            value={zoom}
                            data-sequence-zoom-slider="true"
                            // The track is painted from this rather than left to
                            // the browser, which fills to the middle of the
                            // thumb and leaves a stub of track past it at full
                            // size -- so the slider looked as though it had
                            // somewhere further to go.
                            style={{ '--sv-zoom-fill': zoomFraction(zoom) }}
                            onChange={(event) => onZoomChange?.(clampZoom(Number(event.target.value)))}
                            aria-label={`Zoom: ${zoomLabel(zoom)}`}
                        />
                        <span className="sv-zoom-value">{zoomLabel(zoom)}</span>
                    </label>
                    {zoom < ZOOM_FULL ? (
                        <button
                            type="button"
                            className="sv-icon-button"
                            data-sequence-zoom-reset="true"
                            onClick={() => onZoomChange?.(ZOOM_FULL)}
                            title="Back to full size, where the sequence is readable"
                            aria-label="Back to full size"
                        >
                            <CloseGlyph />
                        </button>
                    ) : null}
                </div>

                <div className="sv-divider" />

                <div className="sv-bar-context sv-readout">
                    {/* What is on the screen, not what is in focus.
                        The focus region is named twice over already -- in the
                        drawer's band, and again in the section it belongs to --
                        and it never changed as the reader scrolled, so the one
                        readout that could have answered "where am I now" was
                        answering a question nothing had asked.

                        The count is the sequence actually drawn rather than the
                        distance between the ends: collapsed, and in a
                        collection, the rows jump, and a screen showing two
                        hundred bases either side of an intron is not showing the
                        intron and should not say that it is. */}
                    {screen ? (
                        <span title={region
                            ? `On screen, within ${focus.chrom}:${region.start.toLocaleString()}\u2013${region.end.toLocaleString()}`
                            : 'On screen'}>
                            <strong>
                                {focus.chrom}:{screen.start.toLocaleString()}&ndash;{screen.end.toLocaleString()}
                            </strong>
                            {' '}
                            <strong>{screen.bases.toLocaleString()}</strong> bp
                            {screen.pieces > 1 ? ` in ${screen.pieces} parts` : ''}
                        </span>
                    ) : null}
                    {hiddenCount > 0 ? (
                        // Something not being drawn has to be visible somewhere,
                        // or it is a bug report waiting to happen.
                        <span>
                            {hiddenCount} hidden
                            <button type="button" className="sv-link ml-1.5" onClick={onShowEverything}>
                                Show all
                            </button>
                        </span>
                    ) : null}
                </div>
            </div>

            {notes.length ? (
                <div className="sv-notes">
                    {notes.map((note) => (
                        <span key={note.key} className={note.warn ? 'sv-note warn' : 'sv-note'}>
                            {note.text}
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function describeCollapses(collapses) {
    const list = Array.isArray(collapses) ? collapses : []
    const has = (name) => list.includes(name)
    if (has('intergenic') && has('intron')) return 'Introns and intergenic sequence'
    if (has('intergenic')) return 'Intergenic sequence'
    if (has('intron')) return 'Introns'
    return 'Sequence'
}
