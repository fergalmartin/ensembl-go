import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { markWheelHandled } from '../utils/browsingControls'
import { orderTranscripts, reorderTranscriptIds } from './genomeBrowserTranscriptView'
import FocusTranscriptDetail, { FOCUS_DETAIL_WIDTH } from './FocusTranscriptDetail'

export const FOCUS_DRAWER_WIDTH = 300
export const FOCUS_DRAWER_RAIL_WIDTH = 36
// The detail opens beside the list rather than replacing it, so the reader keeps
// their place and can step from one transcript to the next.
export const FOCUS_DRAWER_DETAIL_WIDTH = FOCUS_DRAWER_WIDTH + FOCUS_DETAIL_WIDTH
const DRAWER_WIDTH = FOCUS_DRAWER_WIDTH
const RAIL_WIDTH = FOCUS_DRAWER_RAIL_WIDTH
// Long enough that sweeping the cursor down the list doesn't repack the track
// once per row, short enough that a deliberate hover still feels immediate.
const HOVER_INTENT_MS = 90

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

function MoreGlyph({ size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.9" />
            <circle cx="12" cy="12" r="1.9" />
            <circle cx="19" cy="12" r="1.9" />
        </svg>
    )
}

function GripGlyph({ size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
        </svg>
    )
}

function ChevronGlyph({ pointsRight, size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points={pointsRight ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} />
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

// The backend records canonical/MANE status both as a flag and as GFF tags, so
// read both. Matches how the Feature Explorer labels its transcript list.
function transcriptBadges(transcript) {
    const tags = (Array.isArray(transcript?.tags) ? transcript.tags : [])
        .map((tag) => String(tag).toLowerCase().replace(/[\s-]+/g, '_'))
    return {
        canonical: Boolean(transcript?.is_canonical) || tags.includes('ensembl_canonical'),
        maneSelect: tags.some((tag) => tag.includes('mane') && tag.includes('select')),
    }
}

export default function FocusGeneDrawer({
    theme = 'dark',
    open = false,
    onToggle = null,
    onDismiss = null,
    // [{ panelKey, label, pillLabel, color, gene, transcripts, loading }]
    entries = [],
    activePanelKey = '',
    onActivePanelChange = null,
    // { order, hidden, expanded, ghostId, hoverId, pinnedId } for the active panel
    view = null,
    onViewChange = null,
    showPanelSwitcher = false,
    alignTop = 0,
    alignHeight = 0,
    genome = 'reference',
    detailTranscriptId = '',
    onDetailTranscriptChange = null,
}) {
    const isLight = theme === 'light'
    const [copyFeedback, setCopyFeedback] = useState('')
    // The dragged id lives in a ref as well as state: dragover can fire in the
    // same tick as dragstart, before React has re-rendered with the new state.
    const [draggingId, setDraggingId] = useState(null)
    const draggingIdRef = useRef(null)
    const hoverTimerRef = useRef(null)
    const dragSnapshotRef = useRef(null)
    const rowRefs = useRef(new Map())

    const activeEntry = useMemo(
        () => entries.find((entry) => entry.panelKey === activePanelKey) || entries[0] || null,
        [entries, activePanelKey]
    )
    const otherEntries = useMemo(
        () => entries.filter((entry) => entry.panelKey !== activeEntry?.panelKey),
        [entries, activeEntry]
    )

    const gene = activeEntry?.gene || null
    const hasFocus = Boolean(gene)
    const transcripts = useMemo(
        () => (Array.isArray(activeEntry?.transcripts) ? activeEntry.transcripts : []),
        [activeEntry]
    )
    const hiddenIds = useMemo(() => new Set(view?.hidden || []), [view?.hidden])
    // Until the drawer takes its own view, follow whatever the panel is showing —
    // a gene expanded from the canvas stays expanded when it gains focus.
    const expanded = view?.expanded ?? Boolean(activeEntry?.panelExpanded)

    // The list mirrors the browser's own ordering, so what the user drags is
    // exactly what they see drawn.
    const ordered = useMemo(
        () => orderTranscripts(transcripts, view?.order),
        [transcripts, view?.order]
    )
    const orderedIds = useMemo(() => ordered.map((tx) => String(tx.id)), [ordered])
    const visibleTotal = ordered.filter((tx) => !hiddenIds.has(String(tx.id))).length
    const allHidden = ordered.length > 0 && visibleTotal === 0

    // Collapsed, the browser draws exactly one row: the first transcript still
    // showing, or the first one as an outline once everything is hidden. The
    // list has to say the same thing.
    const listed = useMemo(() => {
        if (expanded) return ordered
        if (ordered.length === 0) return []
        return [ordered.find((tx) => !hiddenIds.has(String(tx.id))) || ordered[0]]
    }, [expanded, ordered, hiddenIds])

    useEffect(() => {
        if (!copyFeedback) return undefined
        const timer = setTimeout(() => setCopyFeedback(''), 1400)
        return () => clearTimeout(timer)
    }, [copyFeedback])

    const clearHoverTimer = useCallback(() => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current)
            hoverTimerRef.current = null
        }
    }, [])

    useEffect(() => clearHoverTimer, [clearHoverTimer])

    const patchView = useCallback((patch) => {
        onViewChange?.(patch)
    }, [onViewChange])

    // A pinned row owns the browser's highlight and its vertical alignment, so
    // hovering must not take either off it. Hover behaviour returns untouched as
    // soon as the pin is released.
    const pinnedId = String(view?.pinnedId || '')

    const handleRowEnter = useCallback((transcriptId) => {
        if (draggingIdRef.current || pinnedId) return
        clearHoverTimer()
        const id = String(transcriptId)
        hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null
            patchView({ hoverId: id, ghostId: hiddenIds.has(id) ? id : null })
        }, HOVER_INTENT_MS)
    }, [clearHoverTimer, hiddenIds, patchView, pinnedId])

    const handleRowLeave = useCallback(() => {
        if (pinnedId) return
        clearHoverTimer()
        patchView({ hoverId: null, ghostId: null })
    }, [clearHoverTimer, patchView, pinnedId])

    const handleRowClick = useCallback((transcriptId) => {
        if (draggingIdRef.current) return
        clearHoverTimer()
        const id = String(transcriptId)
        if (pinnedId === id) {
            patchView({ pinnedId: null, ghostId: null, hoverId: null })
            return
        }
        // Pinning a hidden transcript keeps its ghost on screen: the outline is
        // the row being aligned to, so it has to stay drawn.
        patchView({ pinnedId: id, ghostId: hiddenIds.has(id) ? id : null, hoverId: null })
    }, [pinnedId, hiddenIds, clearHoverTimer, patchView])

    // Collapsing the list drops every row but the first, which can strand a pin
    // on a transcript that is no longer listed or drawn.
    useEffect(() => {
        if (!pinnedId) return
        if (listed.some((transcript) => String(transcript.id) === pinnedId)) return
        patchView({ pinnedId: null, ghostId: null })
    }, [pinnedId, listed, patchView])

    const setHiddenSet = useCallback((nextHidden, { hoverId = null } = {}) => {
        const hidden = Array.from(nextHidden)
        patchView({
            hidden,
            // A ghost only makes sense while its transcript is still hidden.
            ghostId: hoverId && hidden.includes(hoverId) ? hoverId : null,
            hoverId,
        })
    }, [patchView])

    const handleToggleAll = useCallback(() => {
        setHiddenSet(allHidden ? [] : orderedIds)
    }, [allHidden, orderedIds, setHiddenSet])

    const handleToggleHidden = useCallback((transcriptId) => {
        const id = String(transcriptId)
        // Collapsed there is only ever one row, so hiding it means hiding the
        // gene's transcripts rather than promoting the next one into its slot.
        if (!expanded) {
            setHiddenSet(allHidden ? [] : orderedIds, { hoverId: id })
            return
        }
        const next = new Set(hiddenIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setHiddenSet(next, { hoverId: id })
    }, [expanded, allHidden, orderedIds, hiddenIds, setHiddenSet])

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

    // --- Drag reorder (native HTML5, as used by the species pill bar) ---------

    const handleDragStart = useCallback((event, transcriptId) => {
        const id = String(transcriptId)
        dragSnapshotRef.current = orderedIds.slice()
        draggingIdRef.current = id
        setDraggingId(id)
        clearHoverTimer()
        patchView({ hoverId: id, ghostId: null })
        try {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', id)
        } catch {
            // Some browsers reject setData outside a real drag; ordering still works.
        }
    }, [orderedIds, clearHoverTimer, patchView])

    const handleDragOverRow = useCallback((event, targetId) => {
        const moving = draggingIdRef.current
        if (!moving) return
        event.preventDefault()
        if (String(targetId) === moving) return

        const node = rowRefs.current.get(String(targetId))
        if (!node) return
        const rect = node.getBoundingClientRect()
        const after = event.clientY > rect.top + (rect.height / 2)

        const current = orderedIds
        const targetIndex = current.indexOf(String(targetId))
        if (targetIndex === -1) return
        const movingIndex = current.indexOf(moving)

        // Where the target sits once the dragged row is lifted out; the dragged
        // row then lands immediately before or after it.
        const targetIndexWithoutMoving = targetIndex - (movingIndex < targetIndex ? 1 : 0)
        const next = reorderTranscriptIds(
            current,
            moving,
            after ? targetIndexWithoutMoving + 1 : targetIndexWithoutMoving,
        )
        if (next.join('|') === current.join('|')) return
        // Written straight through rather than held until drop, so the browser
        // reorders live under the cursor.
        patchView({ order: next })
    }, [orderedIds, patchView])

    const endDrag = useCallback((commit) => {
        const snapshot = dragSnapshotRef.current
        dragSnapshotRef.current = null
        draggingIdRef.current = null
        setDraggingId(null)
        if (!commit && snapshot) {
            patchView({ order: snapshot })
        }
    }, [patchView])

    useEffect(() => {
        if (!draggingId) return undefined
        const onKeyDown = (event) => {
            if (event.key === 'Escape') endDrag(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [draggingId, endDrag])

    // A wheel over the drawer belongs to the drawer's own scroller, never to the
    // browser's pan/zoom. Marking it handled stands the view's gutter router
    // down; native overscroll then chains to the page once this list bottoms out.
    const handleWheel = useCallback((event) => {
        markWheelHandled(event.nativeEvent || event)
        if (event.ctrlKey || event.metaKey) event.preventDefault()
    }, [])

    const rootRef = useRef(null)

    // --- Styling -------------------------------------------------------------

    const surfaceStyle = {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        borderColor: isLight ? '#dee2e6' : '#373a40',
    }
    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const accentColor = activeEntry?.color || (isLight ? '#0099ff' : '#0077cc')
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const highlightColor = isLight ? '#dbe4ff' : '#2b3a55'
    const barBorderColor = isLight ? '#b1c2ff' : '#1e293b'

    // Only a transcript that is actually listed can hold the detail open, so
    // collapsing the list or hiding its gene cannot strand an orphan panel.
    const detailTranscript = useMemo(() => {
        const id = String(detailTranscriptId || '')
        if (!id || !open) return null
        return listed.find((tx) => String(tx.id) === id) || null
    }, [detailTranscriptId, listed, open])

    useEffect(() => {
        if (!detailTranscriptId) return
        if (detailTranscript) return
        onDetailTranscriptChange?.('')
    }, [detailTranscriptId, detailTranscript, onDetailTranscriptChange])

    const width = hasFocus
        ? (open ? (detailTranscript ? FOCUS_DRAWER_DETAIL_WIDTH : DRAWER_WIDTH) : RAIL_WIDTH)
        : 0

    // Identical boxes for the two controls, each centring its own glyph. Sharing
    // the footprint is what lets the gene symbol and the gene id below it start
    // on the same left edge.
    const HEADER_BUTTON = { width: 26, height: 22 }

    // Tinted to match the focus bar it butts against, so the two read as one
    // band across the panel — collapsed as well as open. Only the left edge is
    // drawn, marking where the drawer meets the bar; an underline as well just
    // cut the band off from the panel below it.
    //
    // border-box, so the height stays exactly the bar's whatever the borders do.
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
            title={open ? 'Hide focus panel' : 'Show focus panel'}
            aria-expanded={open}
        >
            <ChevronGlyph pointsRight={open} size={20} />
        </button>
    )

    // Sits directly under the arrow in both states, in an identical box, so
    // collapsing the drawer does not move it sideways and the two read as a
    // pair rather than one being an afterthought.
    const dismissButton = (
        <button
            type="button"
            onClick={() => onDismiss?.()}
            className={`flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`}
            style={{ ...HEADER_BUTTON, color: accentColor }}
            title="Clear the gene of focus"
        >
            <CloseGlyph size={17} />
        </button>
    )

    return (
        <div
            ref={rootRef}
            data-no-drag-scroll="true"
            // The view animates this node's transform when it slides the browser
            // into alignment with a pinned transcript.
            data-focus-drawer="true"
            onWheel={handleWheel}
            // Overlaid rather than laid out in the row: the toolbars above the
            // focus bar stay full width, and the panel starts exactly on the
            // focus-bar line and runs to the bottom of the view.
            // A column: the header band spans the whole drawer, and the list and
            // the transcript detail sit side by side beneath it.
            className={`absolute right-0 z-20 flex flex-col overflow-hidden transition-[width] duration-200 ${width > 0 ? 'border-l' : ''}`}
            style={{
                ...surfaceStyle,
                width,
                top: Math.max(0, Math.round(alignTop)),
                bottom: 0,
            }}
            aria-hidden={!hasFocus}
        >
            {!hasFocus ? null : !open ? (
                // The same band as when open, so the two controls stay level with
                // the gene-of-focus bar however the drawer is sized.
                <div
                    className="flex-none w-full flex flex-col items-center justify-center gap-0.5 overflow-hidden"
                    style={{ ...bandStyle, height: alignHeight || undefined }}
                >
                    {toggleButton}
                    {dismissButton}
                </div>
            ) : (
                <>
                {/* Pinned, and spanning the whole drawer: the band reads as one
                    piece with the focus bar it butts against, whether or not the
                    transcript detail is open beneath it. */}
                <div className="flex-none">
                    {/* Sized and tinted to match the focus bar it butts against, so
                        the two read as one band across the panel. */}
                    <div
                        className="px-1.5 flex flex-col justify-center gap-0.5 overflow-hidden"
                        style={{ ...bandStyle, height: alignHeight || undefined }}
                    >
                        <div className="flex items-center gap-1 min-w-0">
                            {toggleButton}
                            <span className="text-xs font-semibold truncate">
                                {gene.name || gene.id}
                            </span>
                            {gene.name && (
                                <span className="text-[11px] truncate opacity-70">
                                    {gene.biotype || 'protein_coding'}
                                </span>
                            )}
                            {copyFeedback && (
                                <span className="ml-auto flex-none text-[10px] opacity-80">
                                    {copyFeedback}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1 min-w-0">
                            {dismissButton}
                            <span className="text-[11px] font-mono truncate opacity-70">{gene.id}</span>
                            <button
                                type="button"
                                onClick={() => handleCopy(gene.id)}
                                title="Copy gene ID"
                                className="flex-none p-0.5 rounded transition-colors opacity-85 hover:opacity-100"
                                style={{ color: accentColor }}
                            >
                                <CopyGlyph />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 flex">
                <div className="flex-none flex flex-col min-h-0" style={{ width: DRAWER_WIDTH }}>
                <div className="flex-none">
                    {showPanelSwitcher && (
                        <div className="px-3 pt-3 space-y-1.5">
                            <span
                                className="inline-flex items-center h-6 max-w-full px-2.5 text-[11px] font-medium truncate rounded-full"
                                style={{ backgroundColor: accentColor, color: '#ffffff' }}
                            >
                                <span className="truncate">{activeEntry?.pillLabel || activeEntry?.label}</span>
                            </span>
                            {otherEntries.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                    {otherEntries.map((entry) => (
                                        <button
                                            key={entry.panelKey}
                                            type="button"
                                            onClick={() => onActivePanelChange?.(entry.panelKey)}
                                            className={`inline-flex items-center h-6 max-w-full px-2.5 text-[11px] rounded-full border truncate transition-colors ${rowHoverClass} ${subTextClass}`}
                                            style={{ borderColor: surfaceStyle.borderColor }}
                                            title={`Show ${entry.gene?.name || entry.gene?.id} on ${entry.label}`}
                                        >
                                            <span className="truncate">
                                                {entry.gene?.name || entry.gene?.id} · {entry.pillLabel || entry.label}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar">
                    {activeEntry?.loading && transcripts.length === 0 ? (
                        <div className={`px-3 py-3 text-xs ${subTextClass}`}>Loading transcripts…</div>
                    ) : (
                        <div
                            className="py-1"
                            // Without a preventDefault on the container the drop
                            // never fires over gaps or over the dragged row itself.
                            onDragOver={(event) => { if (draggingIdRef.current) event.preventDefault() }}
                            onDrop={(event) => { event.preventDefault(); endDrag(true) }}
                        >
                            {ordered.length > 0 && (
                                <div className="flex items-center px-2 pb-0.5">
                                    <button
                                        type="button"
                                        onClick={handleToggleAll}
                                        title={allHidden ? 'Show all transcripts' : 'Hide all transcripts'}
                                        aria-pressed={!allHidden}
                                        className={`ml-auto flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                        style={{ color: allHidden ? (isLight ? '#adb5bd' : '#5c5f66') : accentColor }}
                                    >
                                        <EyeGlyph hidden={allHidden} />
                                    </button>
                                </div>
                            )}

                            {listed.map((transcript) => {
                                const id = String(transcript.id)
                                const isHidden = hiddenIds.has(id)
                                const isHovered = String(view?.hoverId || '') === id
                                const isPinned = pinnedId === id
                                const isDragging = draggingId === id
                                const badges = transcriptBadges(transcript)
                                const canDrag = expanded && listed.length > 1
                                return (
                                    <div
                                        key={id}
                                        ref={(node) => {
                                            if (node) rowRefs.current.set(id, node)
                                            else rowRefs.current.delete(id)
                                        }}
                                        draggable={canDrag}
                                        onDragStart={(event) => handleDragStart(event, id)}
                                        onDragOver={(event) => handleDragOverRow(event, id)}
                                        onDrop={(event) => { event.preventDefault(); endDrag(true) }}
                                        onDragEnd={() => endDrag(true)}
                                        onMouseEnter={() => handleRowEnter(id)}
                                        onMouseLeave={handleRowLeave}
                                        onClick={() => handleRowClick(id)}
                                        // The view reads this row's box to work out how
                                        // far the browser has to travel to meet it.
                                        data-drawer-transcript-row={id}
                                        title={isPinned ? 'Release this transcript' : 'Align the browser to this transcript'}
                                        className={`group flex items-start gap-1.5 px-2 py-1.5 text-[11px] transition-colors ${rowHoverClass}`}
                                        style={{
                                            backgroundColor: (isPinned || isHovered) && !isDragging ? highlightColor : undefined,
                                            // A pin outlasts the pointer, so it needs a mark
                                            // that a passing hover does not also carry.
                                            boxShadow: isPinned ? `inset 3px 0 0 0 ${accentColor}` : undefined,
                                            opacity: isDragging ? 0.45 : (isHidden ? 0.55 : 1),
                                            cursor: canDrag ? 'grab' : 'pointer',
                                        }}
                                    >
                                        {canDrag && (
                                            <span className={`flex-none ${subTextClass} opacity-0 group-hover:opacity-100 transition-opacity`}>
                                                <GripGlyph />
                                            </span>
                                        )}
                                        <span className="min-w-0 flex flex-col gap-0.5">
                                            <span className={`font-mono truncate ${textClass}`} title={id}>{id}</span>
                                            {/* MANE Select is canonical by definition, so the
                                                stronger label stands alone rather than being
                                                paired with one that adds nothing. */}
                                            {badges.maneSelect ? (
                                                <span className={`self-start text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/30 text-emerald-400'}`}>
                                                    MANE select
                                                </span>
                                            ) : badges.canonical ? (
                                                <span className={`self-start text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                                    canonical
                                                </span>
                                            ) : null}
                                        </span>
                                        <span
                                            className={`ml-auto flex-none truncate max-w-[100px] ${subTextClass}`}
                                            title={transcript.biotype || ''}
                                        >
                                            {transcript.biotype || ''}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation()
                                                const opening = detailTranscriptId !== id
                                                onDetailTranscriptChange?.(opening ? id : '')
                                                // Opening the detail also pins the row, so the
                                                // browser says which transcript the panel is about
                                                // rather than leaving the reader to match ids.
                                                if (opening && pinnedId !== id) handleRowClick(id)
                                            }}
                                            title={detailTranscriptId === id
                                                ? 'Hide transcript details'
                                                : 'Show transcript details and sequences'}
                                            aria-expanded={detailTranscriptId === id}
                                            className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                            style={{ color: accentColor }}
                                        >
                                            <MoreGlyph />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={(event) => { event.stopPropagation(); handleToggleHidden(id) }}
                                            title={isHidden ? 'Show this transcript' : 'Hide this transcript'}
                                            aria-pressed={!isHidden}
                                            className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                                            style={{ color: isHidden ? (isLight ? '#adb5bd' : '#5c5f66') : accentColor }}
                                        >
                                            <EyeGlyph hidden={isHidden} />
                                        </button>
                                    </div>
                                )
                            })}

                            {ordered.length > 1 && (
                                <div className="px-2 pt-1.5 pb-2">
                                    {expanded ? (
                                        <button
                                            type="button"
                                            onClick={() => patchView({ expanded: false, hoverId: null, ghostId: null })}
                                            title="Collapse transcript list"
                                            // Same control the browser draws under an
                                            // expanded gene, so the two read as one thing.
                                            className="inline-flex items-center justify-center font-semibold transition-opacity hover:opacity-85"
                                            style={{
                                                width: 16,
                                                height: 16,
                                                borderRadius: 1,
                                                backgroundColor: accentColor,
                                                color: '#ffffff',
                                                fontSize: '10px',
                                                lineHeight: '1',
                                            }}
                                        >
                                            X
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => patchView({ expanded: true, hoverId: null, ghostId: null })}
                                            title={`Show ${ordered.length} transcript${ordered.length === 1 ? '' : 's'}`}
                                            className="inline-flex items-center gap-1.5 h-6 px-2.5 text-[11px] font-semibold rounded-full transition-opacity hover:opacity-85"
                                            style={{ backgroundColor: accentColor, color: '#ffffff' }}
                                        >
                                            {/* Counts what the browser would gain by expanding, so
                                                this and the canvas pill always agree. */}
                                            {visibleTotal > 1
                                                ? `+${visibleTotal - 1} transcripts`
                                                : `Show all ${ordered.length}`}
                                        </button>
                                    )}

                                </div>
                            )}
                        </div>
                    )}
                </div>
                </div>
                {/* After the list, so it arrives from the screen edge rather than
                    wedging itself between the list and the browser. */}
                {detailTranscript && (
                    <FocusTranscriptDetail
                        theme={theme}
                        genome={genome}
                        gene={gene}
                        transcript={detailTranscript}
                        onClose={() => onDetailTranscriptChange?.('')}
                        onCopyFeedback={setCopyFeedback}
                    />
                )}
                </div>
                </>
            )}
        </div>
    )
}
