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
import {
    DISPLAY_RICH,
    displayModeLabel,
    isPlainDisplay,
} from '../../utils/sequenceViewPlain'
import ColourTool from './ColourTool'
import DisplayTool from './DisplayTool'
import FindTool from './FindTool'
import FeatureTool from './FeatureTool'
import GenomeTool from './GenomeTool'
import SelectTool from './SelectTool'

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
    isLight = false,
    onSearch,
    searchError,
    // Something worth saying about a search that nevertheless worked -- a range
    // held inside the chromosome it named. It clears itself; see SequenceView.
    searchNote = '',
    onClearSearchError,
    searching,
    pending,
    indexBuilding,
    selectMode,
    onSelectModeChange,
    selectStyle,
    onSelectStyleChange,
    // How the sequence is drawn, and whether the plain displays ink their
    // letters. See utils/sequenceViewPlain.js and DisplayTool.jsx.
    display = DISPLAY_RICH,
    onDisplayChange,
    plainColour = true,
    onPlainColourChange,
    displayLocked = false,
    // Looking for something. See FindTool.jsx for the control and FindBar.jsx
    // for the band it opens under this one.
    findOpen = '',
    findQuery = '',
    findMatches = null,
    onFindOpen,
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

    const plain = isPlainDisplay(display)
    const hidden = layout?.hidden || 0
    const breaks = layout?.gaps || 0
    const anyCollapse = Boolean(collapse?.intergenic?.on || collapse?.intron?.on)

    // What the view has to say about what it is showing, in the order a reader
    // needs it: what went wrong first, then what is being waited for, then what
    // was done to the sequence that they did not ask for in so many words.
    const notes = []
    if (searchError) notes.push({ key: 'search', warn: true, text: searchError })
    else if (searching) notes.push({ key: 'searching', text: 'Searching…' })
    else if (searchNote) notes.push({ key: 'search-note', text: searchNote })
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

    // A setting that is on and is not being drawn has to say so somewhere, or it
    // reads as the setting being broken. The plain displays draw the bases and
    // nothing over them, so the protein lane is the one switch a reader can have
    // turned on and then not find.
    if (plain && protein) {
        notes.push({
            key: 'plain-display',
            text: `${displayModeLabel(display)} shows the bases and nothing over them, `
                + 'so the protein is not drawn. The interactive display has it.',
        })
    }

    return (
        // The tokens are on the view's root, not here: a menu is portalled into
        // that root and has to inherit them. See SequenceView and controls.css.
        <div>
            <div className="sv-bar">
                {/* The genome as it is worn everywhere else in the app, with
                    the others behind it. See GenomeTool.jsx. */}
                <GenomeTool
                    options={options}
                    genomeKey={genomeKey}
                    isLight={isLight}
                    root={root}
                    onChange={onGenomeChange}
                />

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

                {/* Display first, and Select after it. What the screen *is*
                    settles what can be done on it -- the plain displays hand
                    selecting to the browser and put this tool out of reach --
                    so the control that decides comes before the one that is
                    decided for. See DisplayTool.jsx. */}
                <DisplayTool
                    display={display}
                    colour={plainColour}
                    root={root}
                    disabled={displayLocked}
                    disabledReason="A transcript’s spliced readings are drawn one way only."
                    onDisplay={onDisplayChange}
                    onColour={onPlainColourChange}
                />

                {/* Turned on rather than always on, which is how a rectangle
                    works everywhere else in the app -- but said in words, since
                    there are now two ways of drawing one and a glyph cannot say
                    which. */}
                <SelectTool
                    armed={selectMode}
                    mode={selectStyle}
                    root={root}
                    // In the plain displays the gesture is the browser's: a drag
                    // highlights text, which is the whole reason to be in one. A
                    // second kind of selection on top of it would put two shapes
                    // on the screen saying different things.
                    disabled={plain}
                    disabledReason={`${displayModeLabel(display)} selects with the browser’s own `
                        + 'cursor — drag across the bases and copy with Ctrl-C.'}
                    onArm={onSelectModeChange}
                    onMode={onSelectStyleChange}
                />

                {/* Beside Select, because the two are the same question asked
                    the two ways a reader can ask it: one says where to look by
                    pointing, the other by describing. */}
                <FindTool
                    open={findOpen}
                    query={findQuery}
                    matches={findMatches}
                    disabled={displayLocked}
                    disabledReason="A transcript’s spliced readings are not searched from here."
                    onOpen={onFindOpen}
                />

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
                    <label
                        className={`sv-zoom-box ${plain ? 'sv-disabled' : ''}`}
                        title={plain
                            ? `${displayModeLabel(display)} is text, and text is read at its own size. `
                                + 'Zoom out in the interactive display.'
                            : 'Zoom out to see more of the region at once'}
                    >
                        <span className="sv-control-name">Zoom</span>
                        <input
                            type="range"
                            min={ZOOM_MIN}
                            max={ZOOM_FULL}
                            step={ZOOM_STEP}
                            value={zoom}
                            disabled={plain}
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
                    {zoom < ZOOM_FULL && !plain ? (
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

                {/* Something not being drawn has to be visible somewhere, or
                    it is a bug report waiting to happen. Only where there is
                    something: the far end of the bar is room for controls
                    otherwise, which is what it is short of.

                    The stretch on screen used to be reported here too. It was
                    the widest thing on the bar and it is written down the
                    margins of every row already -- the gutters carry the first
                    and last coordinate of each line, so a reader asking "where
                    am I now" is answered by the row their eye is on rather than
                    by a caption three hundred pixels away. */}
                {hiddenCount > 0 ? (
                    <div className="sv-bar-context sv-readout">
                        <span>
                            {hiddenCount} hidden
                            <button type="button" className="sv-link ml-1.5" onClick={onShowEverything}>
                                Show all
                            </button>
                        </span>
                    </div>
                ) : null}
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
