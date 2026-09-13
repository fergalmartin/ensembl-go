import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import ChevronGlyph from './DrawerChevron'
import InfoGlyph from './InfoGlyph'
import NoteGlyph from './NoteGlyph'
import FocusNotesPanel from './FocusNotesPanel'
import LocationGeneDetail from './LocationGeneDetail'
import LocationSequencePanel from './LocationSequencePanel'
import { markWheelHandled } from '../utils/browsingControls'
import {
    DEFAULT_NOTE_SORT_MODE,
    NOTE_SAVE_STATES,
    noteDisplayTitle,
    noteTimestampLabel,
    sortNotes,
} from '../utils/geneNotes'
import {
    DEFAULT_STRAND_OPTION,
    FEATURE_PAGE_SIZE,
    STRAND_OPTIONS,
    locationSpan,
    selectLocationFeatures,
} from '../utils/locationFocus'
import { FOCUS_DRAWER_RAIL_WIDTH, FOCUS_DRAWER_WIDTH } from './FocusGeneDrawer'
import { FOCUS_DETAIL_WIDTH } from './FocusTranscriptDetail'

export const LOCATION_DRAWER_WIDTH = FOCUS_DRAWER_WIDTH
export const LOCATION_DRAWER_RAIL_WIDTH = FOCUS_DRAWER_RAIL_WIDTH
export const LOCATION_DRAWER_DETAIL_WIDTH = FOCUS_DRAWER_WIDTH + FOCUS_DETAIL_WIDTH

// As in the gene drawer: past this many the section is a list rather than a
// summary, and the panel beside it does lists better.
const NOTE_SUMMARY_ROWS = 4

// What the wide slot needs to be worth opening: the metadata block plus a
// sequence box deep enough to read. A panel showing two tracks is shorter than
// this, so the drawer asks its panel to grow rather than showing six lines.
const DETAIL_MIN_HEIGHT = 640

// Nothing may ask for more than this much extra panel, however long its list —
// a drawer taller than the window is a drawer nobody can see the bottom of.
const MAX_FIT_HEIGHT = 1200

// The feature types a location can list. Only genes for now, but the section
// machinery is the part that will be reused, so it is driven by this rather
// than written out once.
const FEATURE_SECTIONS = [
    { id: 'genes', label: 'Genes', empty: 'No genes in this location.' },
]

function CopyGlyph({ size = 13 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="5" width="14" height="16" rx="2.2" />
            <path d="M9 3h6v4H9z" />
        </svg>
    )
}

function EyeGlyph({ hidden = false, size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
            {hidden && <path d="M3 3l18 18" />}
        </svg>
    )
}

/** The browser's own re-centre mark, at list size: "put this on screen". */
function TargetGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="6.5" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <path d="M12 1.5v3.5M12 19v3.5M1.5 12h3.5M19 12h3.5" />
        </svg>
    )
}

function VerticalChevronGlyph({ pointsDown, size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points={pointsDown ? '6 9 12 15 18 9' : '18 15 12 9 6 15'} />
        </svg>
    )
}

function StepGlyph({ back = false, size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points={back ? '15 6 9 12 15 18' : '9 6 15 12 9 18'} />
        </svg>
    )
}

function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

function PlusGlyph({ size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

const formatNumber = (value) => (
    Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString() : '—'
)

const formatSpan = (length) => {
    const value = Number(length)
    if (!Number.isFinite(value)) return '—'
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}Mb`
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}kb`
    return `${Math.round(value)}bp`
}

/**
 * The drawer for the location of focus — the gene drawer's counterpart for a
 * stretch of the genome rather than a feature in it.
 *
 * Same shape deliberately: a band that continues the focus bar, sections down
 * the narrow pane, and one wide slot that opens beside it for whatever the
 * reader asked to see in detail. What differs is what it lists — the location
 * itself with its sequence, then the features inside it by type.
 */
export default function FocusLocationDrawer({
    theme = 'dark',
    open = false,
    onToggle = null,
    onDismiss = null,
    location = null,
    genome = 'reference',
    genomeLabel = '',
    accent = '',
    alignTop = 0,
    alignHeight = 0,
    stickyTopInset = 0,
    // { genes: [...], loading, error } — whatever the panel has read for this region.
    features = null,
    onFeaturesReload = null,
    // Classes the reader switched off in the control bar above the browser.
    isFeatureHiddenByClass = null,
    hiddenGeneIds = null,
    onToggleGeneHidden = null,
    onFocusGene = null,
    // How much taller this drawer needs its panel to be, reported as a delta to
    // apply to the panel's current height. Negative means it has room to spare.
    onHeightFitChange = null,
    // { kind: 'sequence' } | { kind: 'gene', geneId } | null
    detail = null,
    onDetailChange = null,
    // --- Notes ---------------------------------------------------------------
    notesEnabled = true,
    notes = [],
    notesStatus = 'idle',
    notesError = '',
    notesPanelOpen = false,
    onNotesPanelToggle = null,
    openNoteId = '',
    onOpenNoteChange = null,
    noteSortMode = DEFAULT_NOTE_SORT_MODE,
    onNoteSortChange = null,
    noteSaveState = NOTE_SAVE_STATES.IDLE,
    onNoteCreate = null,
    onNoteFieldChange = null,
    onNoteSave = null,
    onNoteDelete = null,
    onNotesReload = null,
}) {
    const isLight = theme === 'light'
    const [copyFeedback, setCopyFeedback] = useState('')
    const [strandOption, setStrandOption] = useState(DEFAULT_STRAND_OPTION)
    const [collapsedSections, setCollapsedSections] = useState({})
    const [pageBySection, setPageBySection] = useState({})
    const rootRef = useRef(null)
    const listRef = useRef(null)

    const span = useMemo(() => locationSpan(location), [location])
    const chrom = String(location?.chrom || '')
    const hasFocus = Boolean(location && span)
    const regionLabel = hasFocus
        ? `${chrom}:${formatNumber(span.start)}-${formatNumber(span.end)}`
        : ''

    const hiddenIds = useMemo(
        () => new Set((Array.isArray(hiddenGeneIds) ? hiddenGeneIds : []).map(String)),
        [hiddenGeneIds]
    )

    const geneSelection = useMemo(() => selectLocationFeatures(features?.genes, {
        strandOption,
        isHiddenByClass: isFeatureHiddenByClass,
        page: pageBySection.genes || 0,
        pageSize: FEATURE_PAGE_SIZE,
    }), [features?.genes, strandOption, isFeatureHiddenByClass, pageBySection.genes])

    const selectionsBySection = useMemo(() => ({ genes: geneSelection }), [geneSelection])

    // A narrower filter can leave the reader paged past the end of the list.
    useEffect(() => {
        const page = pageBySection.genes || 0
        if (page < geneSelection.pageCount) return
        setPageBySection((prev) => ({ ...prev, genes: geneSelection.pageCount - 1 }))
    }, [geneSelection.pageCount, pageBySection.genes])

    // A new location is a new list, read from its top.
    const locationKey = hasFocus ? `${chrom}:${span.start}-${span.end}` : ''
    useEffect(() => {
        setPageBySection({})
    }, [locationKey])

    useEffect(() => {
        if (!copyFeedback) return undefined
        const timer = setTimeout(() => setCopyFeedback(''), 1400)
        return () => clearTimeout(timer)
    }, [copyFeedback])

    const handleCopy = useCallback(async (value) => {
        const payload = String(value || '').trim()
        if (!payload) return
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload)
                setCopyFeedback('Copied')
            } else {
                setCopyFeedback('Clipboard unavailable')
            }
        } catch {
            setCopyFeedback('Copy failed')
        }
    }, [])

    const summaryNotes = useMemo(
        () => sortNotes(notes, DEFAULT_NOTE_SORT_MODE).slice(0, NOTE_SUMMARY_ROWS),
        [notes]
    )

    const openNote = useCallback((noteId) => {
        onOpenNoteChange?.(noteId)
        if (!notesPanelOpen) onNotesPanelToggle?.()
    }, [notesPanelOpen, onNotesPanelToggle, onOpenNoteChange])

    // A wheel over the drawer belongs to the drawer's scroller, never to the
    // browser's pan and zoom.
    const handleWheel = useCallback((event) => {
        markWheelHandled(event.nativeEvent || event)
        if (event.ctrlKey || event.metaKey) event.preventDefault()
    }, [])

    // --- Styling -------------------------------------------------------------

    const surfaceStyle = {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        borderColor: isLight ? '#dee2e6' : '#373a40',
    }
    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const accentColor = accent || (isLight ? '#0099ff' : '#0077cc')
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const highlightColor = isLight ? '#dbe4ff' : '#2b3a55'
    const barBorderColor = isLight ? '#b1c2ff' : '#1e293b'
    const dividerColor = isLight ? '#e5e7eb' : '#374151'

    const detailKind = String(detail?.kind || '')
    const detailGene = useMemo(() => {
        if (detailKind !== 'gene') return null
        const id = String(detail?.geneId || '')
        return (features?.genes || []).find((gene) => String(gene?.id) === id) || null
    }, [detailKind, detail?.geneId, features?.genes])

    // The gene the detail describes can leave the list — a strand filter, a new
    // region, a class switched off. Close rather than leave a stale panel open.
    useEffect(() => {
        if (detailKind !== 'gene') return
        if (detailGene) return
        onDetailChange?.(null)
    }, [detailKind, detailGene, onDetailChange])

    const notesPaneOpen = Boolean(notesPanelOpen && hasFocus && open && notesEnabled)
    const wideSlotOccupied = notesPaneOpen || detailKind === 'sequence' || Boolean(detailGene)

    const width = hasFocus
        ? (open ? (wideSlotOccupied ? LOCATION_DRAWER_DETAIL_WIDTH : LOCATION_DRAWER_WIDTH) : LOCATION_DRAWER_RAIL_WIDTH)
        : 0

    /* Ask the panel for the height this drawer actually needs.
     *
     * Reported as a delta against what it has now — the shortfall of the list
     * that is scrolling, or the floor the wide slot needs — because the panel is
     * what owns its own height and this is the only party that can see whether
     * the content fits. A delta rather than an absolute so the two converge in a
     * frame or two without either having to model the other's layout.
     *
     * The sequence box is deliberately not measured: it holds up to a megabase
     * and would ask for the whole screen, so the wide slot asks for a fixed floor
     * and scrolls inside it. */
    const reportFit = useCallback(() => {
        if (!onHeightFitChange) return
        const root = rootRef.current
        const list = listRef.current
        if (!root || !list || !open || !hasFocus) return

        const available = root.clientHeight
        if (available <= 0) return

        // The children's own heights rather than the scroller's scrollHeight,
        // which can never report less than the box it is in — and "this list has
        // room to spare" is exactly what the panel needs to hear to shrink back.
        let listContent = 0
        for (const child of list.children) listContent += child.offsetHeight
        const listShortfall = listContent - list.clientHeight
        const detailShortfall = wideSlotOccupied ? DETAIL_MIN_HEIGHT - available : -Infinity
        const wanted = Math.max(listShortfall, detailShortfall)

        // Nothing overflows: hand back the smaller of the two slacks, so the
        // panel shrinks to what is now needed rather than keeping the height the
        // longest list it ever held asked for.
        const delta = wanted > 0
            ? Math.min(wanted, MAX_FIT_HEIGHT)
            : Math.max(wanted, -MAX_FIT_HEIGHT)
        // Below this a correction is noise: rounding, a scrollbar, a font shift.
        if (Math.abs(delta) < 8) return
        onHeightFitChange(delta)
    }, [onHeightFitChange, open, hasFocus, wideSlotOccupied])

    useEffect(() => {
        reportFit()
        const root = rootRef.current
        const list = listRef.current
        if (!root || !list) return undefined
        // Content arriving (genes, notes, a detail panel opening) changes what
        // fits as much as the panel resizing does.
        const observer = new ResizeObserver(() => reportFit())
        observer.observe(root)
        observer.observe(list)
        for (const child of list.children) observer.observe(child)
        return () => observer.disconnect()
    })


    const HEADER_BUTTON = { width: 26, height: 22 }
    const stickyBandStyle = { position: 'sticky', top: -Math.max(0, stickyTopInset), zIndex: 2 }
    const bandStyle = {
        backgroundColor: highlightColor,
        color: isLight ? '#1e293b' : '#ffffff',
        borderLeft: `1px solid ${barBorderColor}`,
        boxSizing: 'border-box',
    }

    const toggleButton = (
        <button
            type="button"
            onClick={() => onToggle?.()}
            className={`flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`}
            style={{ ...HEADER_BUTTON, color: accentColor }}
            title={open ? 'Hide location panel' : 'Show location panel'}
            aria-expanded={open}
        >
            <ChevronGlyph pointsRight={open} size={20} />
        </button>
    )

    const dismissButton = (
        <button
            type="button"
            data-tour-id="focus-location-dismiss"
            onClick={() => onDismiss?.()}
            className={`flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`}
            style={{ ...HEADER_BUTTON, color: accentColor }}
            title="Clear the location of focus"
        >
            <CloseGlyph size={17} />
        </button>
    )

    const toggleSection = (sectionId) => setCollapsedSections((prev) => ({
        ...prev,
        [sectionId]: !prev[sectionId],
    }))

    const setPage = (sectionId, page) => setPageBySection((prev) => ({ ...prev, [sectionId]: page }))

    return (
        <div
            ref={rootRef}
            data-no-drag-scroll="true"
            data-focus-drawer="true"
            data-location-drawer="true"
            onWheel={handleWheel}
            className={`absolute right-0 z-20 flex flex-col transition-[width] duration-200 ${width > 0 ? 'border-l' : ''}`}
            style={{
                ...surfaceStyle,
                width,
                top: Math.max(0, Math.round(alignTop)),
                bottom: 0,
            }}
            aria-hidden={!hasFocus}
        >
            {!hasFocus ? null : !open ? (
                <div
                    className="flex-none w-full flex flex-col items-center justify-center gap-0.5 overflow-hidden"
                    style={{ ...bandStyle, ...stickyBandStyle, height: alignHeight || undefined }}
                >
                    {toggleButton}
                    {dismissButton}
                </div>
            ) : (
                <>
                <div className="flex-none" data-focus-drawer-band="true" style={stickyBandStyle}>
                    <div
                        className="px-1.5 flex flex-col justify-center gap-0.5 overflow-hidden"
                        style={{ ...bandStyle, height: alignHeight || undefined }}
                    >
                        <div className="flex items-center gap-1 min-w-0">
                            {toggleButton}
                            <span className="text-xs font-semibold truncate">Location</span>
                            <span className="text-[11px] truncate opacity-70">{formatSpan(span.length)}</span>
                            {copyFeedback && (
                                <span className="ml-auto flex-none text-[10px] opacity-80">{copyFeedback}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-1 min-w-0">
                            {dismissButton}
                            <span className="text-[11px] font-mono truncate opacity-70">{regionLabel}</span>
                            <button
                                type="button"
                                onClick={() => handleCopy(regionLabel)}
                                title="Copy these coordinates"
                                className="flex-none p-0.5 rounded transition-colors opacity-85 hover:opacity-100"
                                style={{ color: accentColor }}
                            >
                                <CopyGlyph />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 flex overflow-hidden" data-focus-drawer-body="true">
                    <div className="flex-none flex flex-col min-h-0" style={{ width: LOCATION_DRAWER_WIDTH }}>
                        <div
                            ref={listRef}
                            className="flex-1 min-h-0 overflow-y-auto themed-scrollbar"
                            data-focus-drawer-list="true"
                        >

                            {/* ── Location ─────────────────────────────────── */}
                            <div className="py-1">
                                <div className="flex items-center gap-2 px-2 pt-1 pb-0.5">
                                    <h3 className={`flex-none text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                                        Location
                                    </h3>
                                    <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                                    <button
                                        type="button"
                                        data-tour-id="location-info"
                                        onClick={() => onDetailChange?.(detailKind === 'sequence' ? null : { kind: 'sequence' })}
                                        title={detailKind === 'sequence'
                                            ? 'Hide the sequence for this location'
                                            : 'Show the sequence for this location'}
                                        aria-expanded={detailKind === 'sequence'}
                                        className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                        style={{ color: accentColor }}
                                    >
                                        <InfoGlyph size={14} strokeWidth={2.1} />
                                    </button>
                                </div>
                                <div className={`px-2 pb-1.5 flex flex-col gap-0.5 text-[11px] ${textClass}`}>
                                    <span className="font-mono truncate" title={regionLabel}>{regionLabel}</span>
                                    <span className={`text-[10px] ${subTextClass}`}>
                                        {formatNumber(span.length)} bp
                                        {genomeLabel ? ` · ${genomeLabel}` : ''}
                                    </span>
                                </div>
                            </div>

                            {/* ── Feature sections ─────────────────────────── */}
                            {FEATURE_SECTIONS.map((section) => {
                                // One selection per section, looked up rather than
                                // assumed, so the next feature type cannot silently
                                // render the gene list under its own heading.
                                const selection = selectionsBySection[section.id]
                                if (!selection) return null
                                const collapsed = Boolean(collapsedSections[section.id])
                                return (
                                    <div key={section.id} className="py-1 border-t" style={{ borderColor: dividerColor }}>
                                        <div className="flex items-center gap-2 px-2 pt-1 pb-0.5">
                                            <h3 className={`flex-none text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                                                {section.label}
                                            </h3>
                                            <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                                            <span className={`flex-none text-[11px] tabular-nums ${subTextClass}`}>
                                                ({features?.loading ? '…' : formatNumber(selection.total)})
                                            </span>
                                            <button
                                                type="button"
                                                data-tour-id={`location-section-${section.id}`}
                                                onClick={() => toggleSection(section.id)}
                                                title={collapsed ? `Show ${section.label.toLowerCase()}` : `Hide ${section.label.toLowerCase()}`}
                                                aria-expanded={!collapsed}
                                                className={`flex-none p-0.5 rounded transition-colors ${rowHoverClass}`}
                                                style={{ color: accentColor }}
                                            >
                                                <VerticalChevronGlyph pointsDown={collapsed} size={17} />
                                            </button>
                                        </div>

                                        {!collapsed && (
                                            <>
                                                <div className="flex items-center gap-1.5 px-2 pb-1" data-tour-id="location-strand">
                                                    <span className={`flex-none text-[10px] ${subTextClass}`}>Strand</span>
                                                    <div
                                                        role="group"
                                                        aria-label="Filter genes by strand"
                                                        className="flex min-w-0 overflow-hidden rounded border"
                                                        style={{ borderColor: dividerColor }}
                                                    >
                                                        {STRAND_OPTIONS.map((option, optionIndex) => (
                                                            <button
                                                                key={option.id}
                                                                type="button"
                                                                onClick={() => { setStrandOption(option.id); setPage(section.id, 0) }}
                                                                aria-pressed={strandOption === option.id}
                                                                title={`List ${option.id === 'both' ? 'features on both strands' : `the ${option.label.toLowerCase()} strand`}`}
                                                                className={`flex-1 px-2 py-0.5 text-[10px] transition-colors ${strandOption === option.id ? '' : rowHoverClass}`}
                                                                style={{
                                                                    borderLeft: optionIndex > 0 ? `1px solid ${dividerColor}` : undefined,
                                                                    backgroundColor: strandOption === option.id ? accentColor : undefined,
                                                                    color: strandOption === option.id ? '#ffffff' : undefined,
                                                                }}
                                                            >
                                                                {option.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>

                                                {features?.loading && selection.total === 0 && (
                                                    <div className={`px-2 py-1.5 text-[11px] ${subTextClass}`}>Loading genes…</div>
                                                )}
                                                {features?.error && (
                                                    <div className={`px-2 py-1.5 text-[11px] ${subTextClass}`}>
                                                        <span style={{ color: isLight ? '#dc2626' : '#f87171' }}>{features.error}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => onFeaturesReload?.()}
                                                            className="ml-1.5 underline underline-offset-2 hover:opacity-85"
                                                            style={{ color: accentColor }}
                                                        >
                                                            Retry
                                                        </button>
                                                    </div>
                                                )}
                                                {!features?.loading && !features?.error && selection.total === 0 && (
                                                    <div className={`px-2 py-1.5 text-[11px] ${subTextClass}`}>{section.empty}</div>
                                                )}

                                                {selection.items.map((gene) => {
                                                    const id = String(gene.id)
                                                    const isHidden = hiddenIds.has(id)
                                                    const isDetail = detailKind === 'gene' && String(detail?.geneId) === id
                                                    return (
                                                        <div
                                                            key={id}
                                                            data-drawer-location-gene-row={id}
                                                            className={`group flex items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors ${rowHoverClass}`}
                                                            style={{
                                                                backgroundColor: isDetail ? highlightColor : undefined,
                                                                opacity: isHidden ? 0.55 : 1,
                                                            }}
                                                        >
                                                            <span className="min-w-0 flex flex-col gap-0.5">
                                                                <span className={`truncate ${textClass}`} title={gene.name || id}>
                                                                    {gene.name || id}
                                                                </span>
                                                                <span className={`font-mono text-[10px] truncate ${subTextClass}`} title={id}>
                                                                    {id}
                                                                </span>
                                                            </span>
                                                            <button
                                                                type="button"
                                                                data-tour-id={`location-gene-info-${id}`}
                                                                className={`ml-auto flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                                                onClick={() => onDetailChange?.(isDetail ? null : { kind: 'gene', geneId: id })}
                                                                title={isDetail ? 'Hide gene details' : 'Show gene details and transcripts'}
                                                                aria-expanded={isDetail}
                                                                style={{ color: accentColor }}
                                                            >
                                                                <InfoGlyph size={14} strokeWidth={2.1} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                data-tour-id={`location-gene-focus-${id}`}
                                                                onClick={() => onFocusGene?.(gene)}
                                                                title="Jump to this gene and focus it"
                                                                className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                                                style={{ color: accentColor }}
                                                            >
                                                                <TargetGlyph />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                data-tour-id={`location-gene-hide-${id}`}
                                                                onClick={() => onToggleGeneHidden?.(id)}
                                                                title={isHidden ? 'Show this gene in the browser' : 'Hide this gene in the browser'}
                                                                aria-pressed={!isHidden}
                                                                className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                                                style={{ color: isHidden ? (isLight ? '#adb5bd' : '#5c5f66') : accentColor }}
                                                            >
                                                                <EyeGlyph hidden={isHidden} />
                                                            </button>
                                                        </div>
                                                    )
                                                })}

                                                {selection.pageCount > 1 && (
                                                    <div className="flex items-center gap-1.5 px-2 py-1">
                                                        <button
                                                            type="button"
                                                            data-tour-id={`location-page-prev-${section.id}`}
                                                            onClick={() => setPage(section.id, selection.page - 1)}
                                                            disabled={selection.page === 0}
                                                            title="Previous page"
                                                            className={`flex-none p-0.5 rounded transition-colors ${rowHoverClass} disabled:opacity-30`}
                                                            style={{ color: accentColor }}
                                                        >
                                                            <StepGlyph back />
                                                        </button>
                                                        <span className={`text-[10px] tabular-nums ${subTextClass}`}>
                                                            {formatNumber(selection.from)}–{formatNumber(selection.to)} of {formatNumber(selection.total)}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            data-tour-id={`location-page-next-${section.id}`}
                                                            onClick={() => setPage(section.id, selection.page + 1)}
                                                            disabled={selection.page >= selection.pageCount - 1}
                                                            title="Next page"
                                                            className={`flex-none p-0.5 rounded transition-colors ${rowHoverClass} disabled:opacity-30`}
                                                            style={{ color: accentColor }}
                                                        >
                                                            <StepGlyph />
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Outside the pager: a list short enough to need no
                                                    paging can still have genes hidden from it. */}
                                                {hiddenIds.size > 0 && (
                                                    <div className="px-2 pb-1">
                                                        <button
                                                            type="button"
                                                            data-tour-id="location-show-hidden"
                                                            onClick={() => onToggleGeneHidden?.(null)}
                                                            className="text-[10px] transition-opacity hover:opacity-85"
                                                            style={{ color: accentColor }}
                                                            title="Show every gene hidden from this location"
                                                        >
                                                            Show {hiddenIds.size} hidden {hiddenIds.size === 1 ? 'gene' : 'genes'}
                                                        </button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )
                            })}

                            {/* ── Notes ────────────────────────────────────── */}
                            <div
                                className="px-2 pt-2 pb-3 border-t"
                                style={{ borderColor: dividerColor }}
                                data-focus-drawer-notes="true"
                            >
                                <div className="flex items-center gap-2 pb-1">
                                    <h3 className={`flex-none inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                                        <NoteGlyph size={13} filled={notes.length > 0} knockout={surfaceStyle.backgroundColor} />
                                        Notes
                                    </h3>
                                    {notes.length > 0 && (
                                        <span className={`flex-none text-[10px] ${subTextClass}`}>{notes.length}</span>
                                    )}
                                    <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                                    {notesEnabled && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => onNotesPanelToggle?.()}
                                                title={notesPaneOpen ? 'Hide notes' : 'Open all notes'}
                                                aria-expanded={notesPaneOpen}
                                                className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                                style={{ color: accentColor }}
                                            >
                                                <ChevronGlyph pointsRight={notesPaneOpen} size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                data-tour-id="location-notes-add"
                                                onClick={() => onNoteCreate?.()}
                                                title="Add a note about this location"
                                                className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                                style={{ color: accentColor }}
                                            >
                                                <PlusGlyph size={14} />
                                            </button>
                                        </>
                                    )}
                                </div>

                                {!notesEnabled ? (
                                    <div className={`text-[11px] leading-[1.45] ${subTextClass}`}>
                                        Notes need a genome with an assembly accession.
                                    </div>
                                ) : notesStatus === 'loading' && notes.length === 0 ? (
                                    <div className={`text-[11px] ${subTextClass}`}>Loading notes…</div>
                                ) : notesStatus === 'error' ? (
                                    <div className={`text-[11px] ${subTextClass}`}>
                                        <span style={{ color: isLight ? '#dc2626' : '#f87171' }}>
                                            {notesError || "Couldn't load notes."}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => onNotesReload?.()}
                                            className="ml-1.5 underline underline-offset-2 hover:opacity-85"
                                            style={{ color: accentColor }}
                                        >
                                            Retry
                                        </button>
                                    </div>
                                ) : notes.length === 0 ? (
                                    <div className={`text-[11px] ${subTextClass}`}>No notes yet.</div>
                                ) : (
                                    <>
                                        {summaryNotes.map((note) => (
                                            <button
                                                key={note.id}
                                                type="button"
                                                data-tour-id={`location-note-row-${note.id}`}
                                                onClick={() => openNote(note.id)}
                                                title="Open this note"
                                                className={`w-full flex items-baseline gap-2 px-1 py-1 rounded text-left transition-colors ${rowHoverClass}`}
                                            >
                                                <span className={`min-w-0 flex-1 truncate text-[11px] ${textClass}`}>
                                                    {noteDisplayTitle(note, { max: 40 })}
                                                </span>
                                                <span className={`flex-none text-[10px] ${subTextClass}`}>
                                                    {noteTimestampLabel(note.updatedAt) || noteTimestampLabel(note.createdAt)}
                                                </span>
                                            </button>
                                        ))}
                                        {notes.length > NOTE_SUMMARY_ROWS && (
                                            <button
                                                type="button"
                                                onClick={() => onNotesPanelToggle?.()}
                                                className="w-full px-1 pt-1 text-left text-[11px] transition-opacity hover:opacity-85"
                                                style={{ color: accentColor }}
                                            >
                                                +{notes.length - NOTE_SUMMARY_ROWS} more
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    {detailKind === 'sequence' && !notesPaneOpen && (
                        <LocationSequencePanel
                            theme={theme}
                            genome={genome}
                            genomeLabel={genomeLabel}
                            location={{ chrom, start: span.start, end: span.end }}
                            onClose={() => onDetailChange?.(null)}
                            onCopyFeedback={setCopyFeedback}
                        />
                    )}
                    {detailGene && !notesPaneOpen && (
                        <LocationGeneDetail
                            theme={theme}
                            genome={genome}
                            gene={detailGene}
                            onClose={() => onDetailChange?.(null)}
                            onFocusGene={onFocusGene}
                            onCopyFeedback={setCopyFeedback}
                        />
                    )}
                    {notesPaneOpen && (
                        <FocusNotesPanel
                            theme={theme}
                            subjectLabel={regionLabel}
                            subjectNoun="location"
                            subjectKey={regionLabel}
                            notes={notes}
                            status={notesStatus}
                            error={notesError}
                            notesEnabled={notesEnabled}
                            openNoteId={openNoteId}
                            onOpenNoteChange={onOpenNoteChange}
                            sortMode={noteSortMode}
                            onSortChange={onNoteSortChange}
                            saveState={noteSaveState}
                            onCreate={onNoteCreate}
                            onFieldChange={onNoteFieldChange}
                            onSave={onNoteSave}
                            onDelete={onNoteDelete}
                            onRetryLoad={onNotesReload}
                            onClose={() => onNotesPanelToggle?.()}
                        />
                    )}
                </div>
                </>
            )}
        </div>
    )
}
