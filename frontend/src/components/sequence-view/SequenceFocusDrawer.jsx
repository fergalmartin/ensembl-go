import { useMemo, useState } from 'react'

import DrawerChevron from '../DrawerChevron'
import {
    BrowserGlyph,
    CloseGlyph,
    CogGlyph,
    CopyGlyph,
    DownloadGlyph,
    DrawerIconButton,
    DrawerSectionHeading,
    EyeGlyph,
    LockGlyph,
    TargetGlyph,
    VerticalChevronGlyph,
} from '../focusDrawerChrome'
import { focusDrawerPalette } from '../focusDrawerStyle'
import { biotypeText, strandMark } from '../../utils/sequenceViewLabels'
import { formatDistance, geneBearing } from '../../utils/sequenceViewDistance'
import { featureRecord, geneRecord, transcriptRecord } from '../../utils/sequenceViewPicks'
import useFocusChildren from './useFocusChildren'
import {
    LEVEL_CUSTOM,
    LEVEL_FEATURE,
    LEVEL_GENE,
    LEVEL_LOCATION,
    LEVEL_TRANSCRIPT,
    levelIsSet,
} from '../../utils/sequenceViewFocus'

// The colour the browser's drawers give an eye that is switched off, so that
// "this one is hidden" looks the same wherever a reader meets it.
const MUTED_EYE = (isLight) => (isLight ? '#adb5bd' : '#5c5f66')


// The padding DrawerSectionHeading carries and the rows do not (`px-2`).
const HEADING_INSET = 8

/**
 * What a transcript row says about itself.
 *
 * "coding" only where the biotype has not already said so: a protein coding
 * transcript reading "protein coding coding 3 exons" is the sort of thing that
 * happens when each fact is added by someone who cannot see the others.
 */
function transcriptFacts(transcript) {
    const biotype = biotypeText(transcript.biotype) || 'transcript'
    return [
        biotype,
        transcript.is_canonical ? 'canonical' : null,
        transcript.has_cds && !biotype.includes('coding') ? 'coding' : null,
        `${transcript.exon_count} ${transcript.exon_count === 1 ? 'exon' : 'exons'}`,
    ].filter(Boolean)
}


const bp = (value) => Number(value || 0).toLocaleString()

function spanOf(range) {
    if (!range) return 0
    return Math.abs(range.end - range.start) + 1
}

function formatSpan(length) {
    const n = Number(length || 0)
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} Mb`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)} kb`
    return `${n} bp`
}

/**
 * Which way to go to reach a gene: back along the sequence, or on down it.
 *
 * Left and right rather than up and down, because the reader is being told
 * where the gene is along the chromosome, not which way to push the scrollbar.
 */
function BearingArrow({ direction, size = 13 }) {
    if (direction === 'here') {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="3.5" />
            </svg>
        )
    }
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={direction === 'downstream' ? { transform: 'scaleX(-1)' } : undefined}
        >
            <line x1="20" y1="12" x2="5" y2="12" />
            <polyline points="11 6 5 12 11 18" />
        </svg>
    )
}

/**
 * How far this gene is from the top of the window, and which way.
 *
 * Recomputed on every row scrolled, which the list itself deliberately is not:
 * this is two subtractions on numbers already in hand, so it can follow the
 * scroll exactly while the rows below it stay where the reader left them.
 */
function GeneBearing({ gene, anchor, subTextClass }) {
    const bearing = geneBearing(gene, anchor)
    if (!bearing) return null
    const name = gene.name || gene.id
    return (
        <span
            className={`flex-none flex w-10 flex-col items-center gap-0.5 leading-none ${subTextClass}`}
            title={bearing.direction === 'here'
                ? `${name} covers the top of the window`
                : `${name} starts ${formatDistance(bearing.distance)} ${bearing.direction} of the top of the window`}
        >
            <span className="text-[9px] tabular-nums">
                {bearing.direction === 'here' ? 'here' : formatDistance(bearing.distance)}
            </span>
            <BearingArrow direction={bearing.direction} />
        </span>
    )
}

// Outermost first: position in the drawer is what parent and child mean.
const CHAIN = [
    { id: LEVEL_LOCATION, label: 'Location' },
    { id: LEVEL_GENE, label: 'Gene' },
    { id: LEVEL_TRANSCRIPT, label: 'Transcript' },
    { id: LEVEL_FEATURE, label: 'Exon / intron' },
]

/**
 * The stack of focus levels, in the shape the browser's focus drawers use.
 *
 * Collapses to the same 36 px rail they do, and carries the same accent band, so
 * that a reader moving between the browser and this view is working the same
 * panel. What differs is what the stack means: here each section is a level of
 * focus, exactly one is open, and the list inside the open one is what can be
 * drilled into. Stepping up is clicking a section above.
 */
export default function SequenceFocusDrawer({
    focus,
    isLight,
    accent,
    open,
    onToggle,
    region,
    viewport,
    width,
    bodyWidth,
    pickedKeys,
    onTogglePick,
    onClearPicks,
    onGoTo,
    onEnterGene,
    onEnterTranscript,
    onEnterFeature,
    onJumpToCoord,
    hidden,
    onPreview,
    previewLock,
    onTogglePreviewLock,
    onHiddenChange,
    onToggleHidden,
    onHideAll,
    onShowAll,
    onSettings,
    onCopy,
    onDownload,
    onJumpToBrowser,
    onClearCustom,
    // Which panel the wide slot is showing, if any -- 'settings' or 'download'.
    // One slot rather than two, because there is one place for it to hang and
    // two open at once would have nowhere to go.
    wideSlot = null,
    widePanel = null,
    wideWidth = 0,
    annotationState,
    copyFeedback,
}) {
    const children = useFocusChildren(focus, viewport)
    const palette = focusDrawerPalette(isLight, accent)

    /**
     * Whether the section being read is folded away.
     *
     * One flag rather than a set, because only one section can be open at a
     * time: position in this drawer *is* level -- the list you drill into lives
     * inside the section you are already in -- so the open one is always the one
     * in focus. Folding it hides its list and leaves the focus alone; the band
     * at the top still says where the reader is.
     *
     * The chevrons used to do what the row under them does, which is move the
     * focus. That made the one on the open section a dead click: it pointed up,
     * which everywhere else means "fold this away", and did nothing at all.
     * Now they mean what they look like.
     *
     * It lasts while the reader stays put and no longer. Moving to another
     * level opens it again, however the reader got there -- a chevron here, a
     * row, the base box, a search -- because arriving somewhere and being shown
     * nothing is a drawer that has silently stopped working. Keeping it against
     * the level it was made at was not enough: folding a gene, stepping up to
     * the location and coming back brought the fold back with it, so the
     * chevron that says "expand" did not.
     *
     * Reset while rendering rather than from an effect. This is state derived
     * from a prop, and React's own answer to that is to adjust it on the spot;
     * an effect would commit the stale fold first and then correct it, which is
     * a second render for every move the reader makes.
     *
     * Declared above the two early returns below, because a hook cannot be
     * reached conditionally.
     */
    const reading = focus?.level
    const [fold, setFold] = useState({ level: reading, folded: false })
    if (fold.level !== reading) setFold({ level: reading, folded: false })
    const folded = fold.level === reading && fold.folded
    const setFolded = (next) => setFold({ level: reading, folded: next })
    const chrom = focus?.chrom || ''

    const titles = useMemo(() => ({
        [LEVEL_LOCATION]: focus?.location
            ? `${chrom}:${bp(focus.location.start)}-${bp(focus.location.end)}` : '—',
        [LEVEL_GENE]: focus?.gene ? (focus.gene.name || focus.gene.id) : '—',
        [LEVEL_TRANSCRIPT]: focus?.transcript?.id || '—',
        [LEVEL_FEATURE]: focus?.feature ? `${focus.feature.kind} ${focus.feature.index}` : '—',
        [LEVEL_CUSTOM]: focus?.custom
            ? `${chrom}:${bp(focus.custom.start)}-${bp(focus.custom.end)}` : '—',
    }), [focus, chrom])

    // A line of detail under each level's value, where there is something worth
    // saying that the heading has not already said.
    const subtitles = useMemo(() => ({
        [LEVEL_LOCATION]: '',
        [LEVEL_GENE]: focus?.gene ? biotypeText(focus.gene.biotype) : '',
        [LEVEL_TRANSCRIPT]: focus?.transcript ? biotypeText(focus.transcript.biotype) : '',
        [LEVEL_FEATURE]: focus?.feature && focus?.transcript ? `of ${focus.transcript.id}` : '',
        [LEVEL_CUSTOM]: 'Dragged on the sequence',
    }), [focus])

    // The sign beside the name. A location has no strand of its own; the three
    // below it are read in one direction and say so.
    const marks = useMemo(() => ({
        [LEVEL_LOCATION]: '',
        [LEVEL_GENE]: strandMark(focus?.gene?.strand),
        [LEVEL_TRANSCRIPT]: strandMark(focus?.transcript?.strand),
        [LEVEL_FEATURE]: strandMark(focus?.feature?.strand || focus?.transcript?.strand),
        [LEVEL_CUSTOM]: '',
    }), [focus])

    const spans = useMemo(() => ({
        [LEVEL_LOCATION]: spanOf(focus?.location),
        [LEVEL_GENE]: spanOf(focus?.gene),
        [LEVEL_TRANSCRIPT]: spanOf(focus?.transcript),
        [LEVEL_FEATURE]: focus?.feature ? Math.abs(focus.feature.e - focus.feature.s) + 1 : 0,
        [LEVEL_CUSTOM]: spanOf(focus?.custom),
    }), [focus])

    const toggleButton = (
        <DrawerIconButton
            onClick={() => onToggle?.()}
            title={open ? 'Hide the focus panel' : 'Show the focus panel'}
            accent={palette.accent}
            rowHoverClass={palette.rowHoverClass}
            expanded={open}
        >
            <DrawerChevron pointsRight={open} size={20} />
        </DrawerIconButton>
    )

    if (!focus) return null

    // Collapsed: the same narrow rail the browser's drawers leave behind, so the
    // sequence has the width back and the way to bring the panel out again is
    // where a reader already expects it.
    if (!open) {
        return (
            <div
                data-sequence-focus-drawer="true"
                data-focus-drawer="true"
                className="flex-none flex flex-col border-l transition-[width] duration-200"
                style={{ ...palette.surface, width }}
            >
                <div
                    className="flex-none w-full flex flex-col items-center justify-center gap-0.5 overflow-hidden py-1"
                    style={palette.band}
                >
                    {toggleButton}
                </div>
            </div>
        )
    }

    const level = focus.level

    /** What the chevron on a section does, and what to call it. */
    const foldAction = (id, available) => {
        if (level === id) {
            return {
                onClick: () => setFolded(!folded),
                title: folded ? 'Expand this section' : 'Collapse this section',
            }
        }
        if (!available) return { onClick: null, title: 'Nothing chosen yet' }
        // A section that is not the one being read cannot be expanded on its
        // own: its list is the list of what is inside it, and reading into it is
        // what makes that list mean anything.
        return { onClick: () => onGoTo(id), title: 'Expand this section and read it' }
    }
    const actionsFor = (id) => (
        <span className="ml-auto flex flex-none items-center gap-0.5">
            <DrawerIconButton
                onClick={onSettings}
                title="Highlights and flanking sequence"
                accent={palette.accent}
                rowHoverClass={palette.rowHoverClass}
                expanded={wideSlot === 'settings'}
                compact
            ><CogGlyph size={17} /></DrawerIconButton>
            <DrawerIconButton
                onClick={onCopy}
                title="Copy as FASTA"
                accent={palette.accent}
                rowHoverClass={palette.rowHoverClass}
                compact
            ><CopyGlyph size={16} /></DrawerIconButton>
            <DrawerIconButton
                onClick={onDownload}
                title="Download this — choose what, in what shape and in what format"
                accent={palette.accent}
                rowHoverClass={palette.rowHoverClass}
                expanded={wideSlot === 'download'}
                compact
            ><DownloadGlyph size={14} /></DrawerIconButton>
            <DrawerIconButton
                onClick={onJumpToBrowser}
                title="Show this region in the genome browser"
                accent={palette.accent}
                rowHoverClass={palette.rowHoverClass}
                compact
            ><BrowserGlyph size={17} /></DrawerIconButton>
            {id === LEVEL_CUSTOM ? (
                <DrawerIconButton
                    onClick={onClearCustom}
                    title="Clear this selection"
                    accent={palette.accent}
                    rowHoverClass={palette.rowHoverClass}
                    compact
                ><CloseGlyph size={16} /></DrawerIconButton>
            ) : null}
        </span>
    )

    const sectionRow = ({ id, label }) => {
        const available = levelIsSet(focus, id)
        // What is being read, which is not the same as what is unfolded: folding
        // the active section hides its list without moving the focus, and the
        // ring below is then the only thing left in the list saying which level
        // the reader is on.
        const isCurrent = level === id
        const isOpen = isCurrent && !folded
        const fold = foldAction(id, available)
        return (
            <div
                key={id}
                data-sequence-focus-section={id}
                className="py-1 border-t"
                style={{ borderColor: palette.divider }}
            >
                {/* The heading of the level being read is ringed in the accent
                    the chevrons are drawn in. Four sections stacked look alike
                    at a glance, and which one the reader is inside was said only
                    by the band at the top and by which one had a list under it
                    -- neither of which is where the eye is while it is going
                    down the stack.

                    An inset shadow rather than a border, so that nothing moves
                    when it appears; the margin and padding add up to the eight
                    pixels the label sat at before, so the ring is drawn around
                    where the text already was rather than pushing it in. */}
                <div
                    className="flex items-center gap-2 mx-1 px-1 pt-1 pb-0.5 rounded"
                    style={isCurrent ? { boxShadow: `inset 0 0 0 1px ${palette.accent}` } : null}
                >
                    <h3
                        className="flex-none text-[11px] font-semibold tracking-wide uppercase"
                        style={isCurrent ? { color: palette.accent } : null}
                    >
                        <span className={isCurrent ? '' : palette.subTextClass}>{label}</span>
                    </h3>
                    <div className="flex-1 h-px" style={{ backgroundColor: palette.divider }} />
                    {spans[id] ? (
                        <span className={`flex-none text-[11px] tabular-nums ${palette.subTextClass}`}>
                            {formatSpan(spans[id])}
                        </span>
                    ) : null}
                    <DrawerIconButton
                        onClick={() => fold.onClick?.()}
                        title={fold.title}
                        accent={fold.onClick ? palette.accent : palette.divider}
                        rowHoverClass={fold.onClick ? palette.rowHoverClass : ''}
                        expanded={isOpen}
                        compact
                    ><VerticalChevronGlyph pointsDown={!isOpen} size={17} /></DrawerIconButton>
                </div>

                <button
                    type="button"
                    disabled={!available}
                    // Reading into it, as it always was -- and where that is
                    // already where the reader is, unfolding it, since a press
                    // on the name of a folded section means "show me this".
                    onClick={() => (level === id ? setFolded(false) : onGoTo(id))}
                    className={`w-full px-2 pb-1 text-left ${available ? palette.rowHoverClass : 'cursor-default'}`}
                >
                    <span className="flex items-baseline gap-1.5">
                        <span className={`min-w-0 truncate text-sm ${available ? palette.textClass : palette.subTextClass}`}>
                            {titles[id]}
                        </span>
                        {available && marks[id] ? (
                            <span className={`flex-none text-sm ${available ? palette.textClass : palette.subTextClass}`}>
                                {marks[id]}
                            </span>
                        ) : null}
                    </span>
                    {available && subtitles[id] ? (
                        <span className={`block truncate text-[11px] ${palette.subTextClass}`}>
                            {subtitles[id]}
                        </span>
                    ) : null}
                </button>

                {isOpen ? <div className="px-2 pb-1">{childrenFor(id)}</div> : null}
            </div>
        )
    }

    /**
     * One thing that can be read into, or collected.
     *
     * The tick and the row mean two different things, deliberately: ticking adds
     * it to the collection the view draws as records, clicking reads into it so
     * that what is below it can be listed in turn. The same pair at every level,
     * so a transcript is to a gene what a gene is to a location.
     */
    const listRow = ({
        key, record, title, mark = '', facts = [], onClick, selected,
        trailing = null, muted = false, span = null,
    }) => {
    // While something is locked, the pointer marks nothing: the lock is a
    // request for the screen to hold still, and a row that lit up under the
    // pointer on the way past would be the one thing it cannot do.
    const holding = Boolean(previewLock) && previewLock.key !== key
    return (
        // Pointing at a row underlines that feature's bases in the sequence, for
        // as long as the pointer is there. It is the quickest answer to "which
        // of these bases are that one?", and the only one that does not involve
        // reading a coordinate off a gutter and counting.
        <li
            key={key}
            className={`flex items-center gap-1 ${muted ? 'opacity-45' : ''}`}
            onMouseEnter={span && !holding ? () => onPreview?.(span) : undefined}
            onMouseLeave={span && !holding ? () => onPreview?.(null) : undefined}
        >
            {record ? (
                <input
                    type="checkbox"
                    // A checkbox brings its own margins, which put it a few
                    // pixels right of where the section heading above it starts.
                    // Cleared, so the column of ticks lines up with the "G" of
                    // GENES rather than floating between it and the drawer edge.
                    style={{ margin: 0 }}
                    checked={pickedKeys.has(record.key)}
                    onChange={() => onTogglePick(record)}
                    title={`Collect ${title} as a record`}
                    aria-label={`Collect ${title} as a record`}
                />
            ) : null}
            {/* The one this level is reading is ringed in the accent, the way
                its section heading is. It used to be a filled box, which is the
                same mark the pointer leaves as it goes down the list -- two
                pixels of difference between `#2b3a55` and `#273449` -- so "this
                is the gene the section below is about" and "your cursor is here"
                looked alike. They are different questions and now they are
                different marks: a ring for what is chosen, a fill for where the
                pointer is, and a chosen row still takes the fill while the
                pointer is on it, because both can be true at once. */}
            <button
                type="button"
                onClick={onClick}
                aria-current={selected ? 'true' : undefined}
                className={`min-w-0 flex-1 rounded px-1.5 py-1 text-left ${holding ? '' : palette.rowHoverClass}`}
                style={selected ? { boxShadow: `inset 0 0 0 1px ${palette.accent}` } : undefined}
            >
                {/* The sign beside the name, in the name's own type. Under it,
                    as "+ strand", it spent a line and a word on one character --
                    and a reader looking down a list for the gene on the minus
                    strand had to read the second line of every row to find it. */}
                <span className="flex items-baseline gap-1.5">
                    <span className={`min-w-0 truncate text-xs ${palette.textClass}`}>{title}</span>
                    {mark ? (
                        <span className={`flex-none text-xs ${palette.textClass}`}>{mark}</span>
                    ) : null}
                </span>
                {/* Facts side by side with a gap between them rather than a
                    string with dots in it: the gap says "and another thing"
                    without spending a character on saying it. */}
                {facts.length ? (
                    <span className={`flex gap-2 truncate text-[11px] ${palette.subTextClass}`}>
                        {facts.map((fact) => (
                            <span key={fact} className="flex-none">{fact}</span>
                        ))}
                    </span>
                ) : null}
            </button>
            {trailing}
        </li>
    )
    }

    /**
     * Go to where a feature begins.
     *
     * Reading runs 5' to 3', so the start of anything on the minus strand is its
     * higher coordinate. The genes in a location have had this since the
     * beginning; a transcript in its gene, and an exon or an intron in its
     * transcript, are the same question asked one level down, and were the only
     * lists a reader could not get out of without scrolling for the thing
     * themselves.
     *
     * Without the bearing the gene rows carry beside it -- the arrow and the
     * distance answer "where is this relative to the window", which matters in a
     * location a reader is panning around and not in a structure they have
     * already opened.
     */
    const jumpTo = (strand, start, end, name) => (
        <DrawerIconButton
            onClick={() => onJumpToCoord(strand === '-' ? end : start)}
            title={`Go to the start of ${name}`}
            accent={palette.accent}
            rowHoverClass={palette.rowHoverClass}
            compact
        ><TargetGlyph size={15} /></DrawerIconButton>
    )

    /**
     * Hold the highlight on one feature.
     *
     * Pointing at a row marks its bases for as long as the pointer is there,
     * which is no time at all if the reader wants to look at what it marked --
     * the moment they move towards the sequence the marking goes. Locked, it
     * stays, and the rest of the list stops answering the pointer until it is
     * let go: the whole point is that nothing else changes what is on screen.
     *
     * The same padlock the Feature Explorer locks a splice path with, because
     * it is the same gesture.
     */
    const lockFor = (id, span, name) => {
        const locked = previewLock?.key === id
        return (
            <DrawerIconButton
                onClick={() => onTogglePreviewLock?.(locked ? null : { key: id, span })}
                title={locked
                    ? `Release the highlight on ${name}`
                    : `Keep the highlight on ${name} while you read it`}
                accent={locked ? palette.accent : palette.divider}
                rowHoverClass={palette.rowHoverClass}
                expanded={locked}
                compact
            ><LockGlyph locked={locked} size={14} /></DrawerIconButton>
        )
    }

    /** The lock and the jump, which every feature row carries in that order. */
    const rowActions = (id, strand, start, end, name) => (
        <>
            {lockFor(id, { s: start, e: end }, name)}
            {jumpTo(strand, start, end, name)}
        </>
    )

    /**
     * Silence one feature, or bring it back.
     *
     * Not a drawing switch: a hidden gene casts no vote, so the sequence it
     * shared with its neighbour stops being "mixed" and reads as whatever the
     * neighbour says it is. Which is the point -- turning things off until what
     * is left is unambiguous.
     */
    const eyeFor = (id, what, withGene = '') => {
        const off = hidden?.has(id)
        const click = () => {
            if (off && withGene) onHiddenChange?.({ show: [id, withGene] })
            else onToggleHidden?.(id)
        }
        return (
            <DrawerIconButton
                onClick={click}
                title={off ? `Show ${what} in the sequence` : `Hide ${what} from the sequence`}
                accent={off ? MUTED_EYE(isLight) : palette.accent}
                rowHoverClass={palette.rowHoverClass}
                compact
            ><EyeGlyph hidden={off} size={14} /></DrawerIconButton>
        )
    }

    /**
     * The same for everything a section lists, as one act.
     *
     * Pulled right by the heading's own padding, which the rows below do not
     * have, so that it lands in the same column as the eye on every row it
     * governs -- one column of eyes, with the one at the top meaning all of them.
     */
    const eyeForAll = (ids, what, withGene = '') => {
        if (!ids.length) return null
        const off = ids.every((id) => hidden?.has(id))
        const click = () => {
            if (!off) onHideAll?.(ids)
            else if (withGene) onHiddenChange?.({ show: [...ids, withGene] })
            else onShowAll?.(ids)
        }
        return (
            <span className="flex-none" style={{ marginRight: -HEADING_INSET }}>
                <DrawerIconButton
                    onClick={click}
                    title={off ? `Show all ${what}` : `Hide all ${what}`}
                    accent={off ? MUTED_EYE(isLight) : palette.accent}
                    rowHoverClass={palette.rowHoverClass}
                    compact
                ><EyeGlyph hidden={off} size={14} /></DrawerIconButton>
            </span>
        )
    }

    /**
     * What the view is showing instead of this level's own sequence.
     *
     * The collection replaces the plain view while anything is ticked, so there
     * has to be a way back to it that does not mean unticking things one at a
     * time.
     */
    const collectionNote = (what) => (pickedKeys.size > 0 ? (
        <div
            className="mb-1 flex items-center gap-2 rounded px-1.5 py-1"
            style={{ backgroundColor: palette.selectedRow }}
        >
            <span className={`min-w-0 flex-1 text-[11px] ${palette.textClass}`}>
                Showing {pickedKeys.size} {pickedKeys.size === 1 ? 'record' : 'records'}
            </span>
            <button
                type="button"
                onClick={onClearPicks}
                className={`flex-none rounded px-1.5 py-0.5 text-[11px] underline ${palette.rowHoverClass} ${palette.subTextClass}`}
            >
                Back to the {what}
            </button>
        </div>
    ) : null)

    function childrenFor(id) {
        if (id === LEVEL_LOCATION) {
            if (annotationState === 'absent') {
                return (
                    <p className={`px-1 py-1 text-[11px] ${palette.subTextClass}`}>
                        This genome has no annotation loaded, so there are no genes to list.
                        The sequence still reads.
                    </p>
                )
            }
            return (
                <>
                    {collectionNote('whole location')}
                    {/* The count is of the whole region; the list is of what is
                        on screen. Two different questions, so the heading answers
                        the first and says which one the rows are answering. */}
                    <DrawerSectionHeading
                        label="Location genes"
                        count={children.loading ? '…' : (children.total ?? children.items.length)}
                        divider={palette.divider}
                        subTextClass={palette.subTextClass}
                    >
                        {/* Of what is listed, which is what is on screen -- not
                            of every gene in the region, which could be
                            thousands and none of them in view. */}
                        {eyeForAll(children.items.map((gene) => gene.id), 'these genes')}
                    </DrawerSectionHeading>
                    <p className={`px-1 pb-1 text-[10px] ${palette.subTextClass}`}>
                        {children.loading
                            ? 'Looking…'
                            : children.inWindow
                                ? `${children.inWindow} here${children.items.length > children.inWindow ? ', and the nearest others' : ''}`
                                : 'None on screen — the nearest are below'}
                    </p>
                    {!children.loading && children.items.length === 0 ? (
                        <p className={`px-1 text-[11px] ${palette.subTextClass}`}>No genes in this region.</p>
                    ) : null}
                    <ul className="space-y-0.5">
                        {children.items.map((gene) => listRow({
                            key: gene.id,
                            record: geneRecord(gene, chrom),
                            title: gene.name || gene.id,
                            mark: strandMark(gene.strand),
                            facts: [
                                biotypeText(gene.biotype),
                                formatSpan(gene.e - gene.s + 1),
                            ].filter(Boolean),
                            onClick: () => onEnterGene(gene),
                            selected: focus.gene?.id === gene.id,
                            span: { s: gene.s, e: gene.e },
                            muted: hidden?.has(gene.id),
                            trailing: (
                                <>
                                    <GeneBearing
                                        gene={gene}
                                        // Coordinates are 1-based, so a zero here
                                        // is the viewport before it has been
                                        // measured rather than the chromosome's
                                        // start.
                                        anchor={viewport?.anchor || null}
                                        subTextClass={palette.subTextClass}
                                    />
                                    {rowActions(gene.id, gene.strand, gene.s, gene.e, gene.name || gene.id)}
                                    {eyeFor(gene.id, gene.name || gene.id)}
                                </>
                            ),
                        }))}
                    </ul>
                </>
            )
        }

        if (id === LEVEL_GENE) {
            return (
                <>
                    {collectionNote('whole gene')}
                    <DrawerSectionHeading
                        label="Transcripts"
                        count={children.loading ? '…' : children.items.length}
                        divider={palette.divider}
                        subTextClass={palette.subTextClass}
                    >
                        {eyeForAll(children.items.map((t) => t.id), 'these transcripts', focus.gene?.id || '')}
                    </DrawerSectionHeading>
                    <ul className="space-y-0.5">
                        {children.items.map((transcript) => listRow({
                            key: transcript.id,
                            record: transcriptRecord(transcript, chrom, focus.gene?.id || ''),
                            title: transcript.id,
                            mark: strandMark(transcript.strand || focus.gene?.strand),
                            facts: transcriptFacts(transcript),
                            onClick: () => onEnterTranscript(transcript),
                            selected: focus.transcript?.id === transcript.id,
                            span: { s: transcript.s, e: transcript.e },
                            muted: hidden?.has(transcript.id),
                            trailing: (
                                <>
                                    {rowActions(
                                        transcript.id,
                                        transcript.strand || focus.gene?.strand,
                                        transcript.s,
                                        transcript.e,
                                        transcript.id,
                                    )}
                                    {/* Showing an isoform shows its gene as well.
                                        A gene is silenced whole, whatever its
                                        isoforms say, so turning one back on under
                                        a hidden gene would otherwise do nothing a
                                        reader could see. */}
                                    {eyeFor(transcript.id, transcript.id, focus.gene?.id || '')}
                                </>
                            ),
                        }))}
                    </ul>
                </>
            )
        }

        if (id === LEVEL_TRANSCRIPT) {
            // No eyes on this list. Hiding silences a *voter* -- a gene, or one
            // of its isoforms -- so that what is left reads plainly. An exon is
            // not a voter: it is part of what its transcript says, and a
            // transcript without its third exon is not an annotation of
            // anything. Turning off exons as a class of sequence is what the
            // highlight switches are for, and they already do it.
            //
            // Two lists rather than one interleaved by number: exon 3 and
            // intron 3 are different things, and a reader after all the exons
            // should not have to step over the introns between them.
            const kinds = [
                ['exon', 'Exons'],
                ['intron', 'Introns'],
            ]
            const transcriptId = focus.transcript?.id || ''
            return (
                <>
                    {collectionNote('whole transcript')}
                    {kinds.map(([kind, label]) => {
                        const items = children.items.filter((feature) => feature.kind === kind)
                        return (
                            <div key={kind}>
                                <DrawerSectionHeading
                                    label={label}
                                    count={children.loading ? '…' : items.length}
                                    divider={palette.divider}
                                    subTextClass={palette.subTextClass}
                                />
                                <ul className="space-y-0.5">
                                    {items.map((feature) => listRow({
                                        key: `${feature.kind}-${feature.index}`,
                                        record: featureRecord(
                                            { ...feature, strand: focus.transcript?.strand },
                                            chrom,
                                            transcriptId,
                                        ),
                                        title: `${feature.kind} ${feature.index}`,
                                        facts: [formatSpan(feature.e - feature.s + 1)],
                                        trailing: rowActions(
                                            `${feature.kind}-${feature.index}`,
                                            focus.transcript?.strand,
                                            feature.s,
                                            feature.e,
                                            `${feature.kind} ${feature.index}`,
                                        ),
                                        onClick: () => onEnterFeature(feature),
                                        selected: focus.feature?.kind === feature.kind
                                            && focus.feature?.index === feature.index,
                                        span: { s: feature.s, e: feature.e },
                                    }))}
                                </ul>
                            </div>
                        )
                    })}
                </>
            )
        }

        return (
            <p className={`px-1 text-[11px] ${palette.subTextClass}`}>
                Use the cog to change the flanking sequence, then copy it or open it
                in the browser.
            </p>
        )
    }

    return (
        <div
            data-sequence-focus-drawer="true"
            data-focus-drawer="true"
            // Two boxes rather than one. This is the placeholder the row lays
            // out against, and it is always just the drawer's own width; the
            // surface below is anchored to its right-hand edge and grows
            // leftwards when the wide slot opens.
            //
            // That is what lets the panel slide out from the right, pushing the
            // list across, without the sequence beside it re-laying-out: the
            // rows used to narrow, their gutters move and the whole reading
            // shift every time a panel opened. A reader setting up a download is
            // not reading the sequence at that moment, so covering it costs them
            // nothing -- while moving it costs them their place.
            className="relative flex-none"
            style={{ width }}
        >
        <div
            className="absolute inset-y-0 right-0 flex flex-col border-l transition-[width] duration-200"
            style={{
                ...palette.surface,
                width: wideSlot && widePanel ? `calc(${width}px + ${wideWidth}px)` : '100%',
                // Never wider than there is room for, however wide the panel
                // would like to be.
                maxWidth: '85vw',
                ...(wideSlot && widePanel ? { zIndex: 20, boxShadow: '-12px 0 28px rgba(0,0,0,.35)' } : null),
            }}
        >
            {/* The band names what is being read, not what the view is called:
                it is the one line that has to answer "where am I" at a glance. */}
            <div className="flex-none" data-focus-drawer-band="true" style={palette.band}>
                <div className="px-1.5 py-1 flex flex-col justify-center gap-0.5 overflow-hidden">
                    <div className="flex items-center gap-1 min-w-0">
                        {toggleButton}
                        <span className="text-xs font-semibold truncate">
                            {(CHAIN.find((section) => section.id === level) || { label: 'Selection' }).label}
                        </span>
                        {level !== LEVEL_LOCATION && level !== LEVEL_CUSTOM ? (
                            <span className="text-xs truncate opacity-90">{titles[level]}</span>
                        ) : null}
                        <span className="flex-none text-[11px] opacity-70">{formatSpan(spans[level])}</span>
                        {copyFeedback ? (
                            <span className="ml-auto flex-none text-[10px] opacity-80">{copyFeedback}</span>
                        ) : null}
                    </div>
                    {/* The coordinates of what is actually on screen, flank and
                        all -- the one line that answers "where am I", and the
                        same thing in the same place as the browser's drawers. */}
                    <div className="flex items-center gap-1 min-w-0">
                        <span className="text-[11px] font-mono truncate opacity-70">
                            {region ? `${chrom}:${bp(region.start)}-${bp(region.end)}` : titles[level]}
                        </span>
                        {actionsFor(level)}
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 flex overflow-hidden" data-focus-drawer-body="true">
                {/* The list keeps its own width and is pushed left by the panel
                    beside it, which is how every other secondary drawer in the
                    app behaves. */}
                <div
                    className="flex-none flex flex-col min-h-0 overflow-y-auto themed-scrollbar"
                    style={{ width: bodyWidth }}
                    data-focus-drawer-list="true"
                >
                    {CHAIN.map(sectionRow)}

                    {/* Not part of the chain: a selection has no parent and no
                        child, so it is pinned below rather than inserted. */}
                    {focus.custom ? sectionRow({ id: LEVEL_CUSTOM, label: 'Selection' }) : null}
                </div>

                {wideSlot && widePanel ? (
                    <div
                        data-focus-drawer-wide="true"
                        className="flex-1 min-w-0 min-h-0 border-l"
                        style={{ borderColor: palette.divider }}
                    >
                        {widePanel}
                    </div>
                ) : null}
            </div>
        </div>
        </div>
    )
}
