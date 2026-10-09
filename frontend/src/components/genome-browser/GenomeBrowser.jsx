import { trackAchievement } from '../../achievements/tracker.js'
import {
  memo,
  useRef,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
} from 'react'
import iconResetRaw from '../../assets/icons/icon_reset.svg?raw'
import iconAnchorRaw from '../../assets/icons/icon_anchor.svg?raw'
import {
    geneFooterTrackOverflow,
    intersectsRuler,
    getGeneFooterGeometry,
    getTranscriptFooterControlState,
    placeGeneFooterWithinViewport,
    TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
} from './genomeBrowserLabelLayout'
// Pure data: which file each of the tutorial's demo tracks is, so a `browserTracks`
// arrival can name them without carrying registry ids it cannot know.
import { TRACK_FILENAMES } from '../../utils/tutorialModel'
import {
    VCF_BLOCK_LEVELS,
    buildVcfOverviewWarmupKey,
    buildVcfOverviewWarmupTiles,
    getVcfBlockLevel as selectVcfBlockLevel,
} from '../../utils/vcfTileStrategy'
import { buildDefaultScreenshotName } from '../../utils/screenshotExport'
import { buildGeneIntervalIndex, sameGeneRange } from '../../utils/geneIntervalIndex'
import { registerBrowserViewport } from '../../utils/browserTutorialControls'
import useTutorial from '../../hooks/useTutorial'
import useNearViewport from '../../hooks/useNearViewport'
import { resolveGeneTranscriptView } from './genomeBrowserTranscriptView'
import { shouldResetStickyGeneRows } from './genomeBrowserTranscriptLayout'
import {
    DEFAULT_BROWSING_CONTROLS,
    beginWheelGesture,
    describeBrowsingControls,
    isTextEntryTarget,
    markWheelHandled,
    readKeyEvent,
    readWheelEvent,
    resolveKeyAction,
    resolveWheelAction,
    isWheelGestureFromChrome,
    isWheelInsideIsolatedOverlay,
} from '../../utils/browsingControls'
import { effectiveMemberTrack, gatherRows, groupRowIdFor, isGroupRowId } from '../../utils/trackGroups'
import { describeSessionTracks, planSessionRestore } from '../../utils/sessionTracks'
import { classifyBiotype } from '../../utils/geneBiotypes'
import {
    BOX_SELECT_FILL_FRACTION,
    FOCUS_RANGE_FILL_FRACTION,
    getAnchoredContentPageScrollDelta,
    getFocusLocationRange,
    isSameChromToken,
    getFeatureRowAnchor,
    getFeatureRowTargetY,
    frameRangeWithRightInset,
    rebalanceRangeForInsetChange,
    shouldRenderViewportTranscriptStructures,
} from './genomeBrowserViewportLayout'
import { RULER_HEIGHT } from './genomeBrowserRuler'
import { FONT_MONO } from '../../utils/typography'

import { API_BASE } from '../../backendRuntime'
import { geneIndexOverlayBand, shouldHoldGeneTrackHeight } from '../../utils/geneIndexOverlay'
import { INDEX_BUILDING_STATUS } from '../../utils/browserReadiness'
import { consumeRestoredSessionState, peekRestoredSessionState, registerSessionState } from '../../sessionResume.js'
import {
    BED_DENSITY_LEVELS,
    BIGBED_BLOCK_LEVELS,
    COLORS,
    CUSTOM_TRACK_TOOLTIP_DWELL_MS,
    CUSTOM_TRACK_TOOLTIP_MOVE_TOL_PX,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    EMPTY_LIST,
    EXPANDED_FOOTER_INLINE_GAP,
    EXPANDED_FOOTER_LABEL_TOP_OFFSET,
    GENE_CHROM_CACHE_ENTER_SPAN,
    GENE_INDEX_POLL_INTERVAL_MS,
    GENE_LAYOUT_BUFFER_MAX,
    GENE_LAYOUT_BUFFER_MIN,
    GENE_SUBTRACK_ENABLE_BP,
    LHS_WIDTH,
    MAX_GENE_TILE_CACHE_TILES,
    MAX_TRANSCRIPT_CACHE_GENES,
    MAX_TRANSCRIPT_PREFETCH_GENES,
    NOTE_BUBBLE_GAP,
    NOTE_BUBBLE_MIN_GENE_WIDTH,
    NOTE_BUBBLE_SIZE,
    SIDEBAR_TOGGLE_HIT_RADIUS,
    SPLICE_BLOCK_LEVELS,
    SPLICE_BLOCK_MERGE_GAP_PX,
    SPLICE_FINE_BP_PER_PX,
    SPLICE_TILE_SPAN_COARSE,
    SPLICE_TILE_SPAN_FINE,
    SPLICE_TRANSCRIPT_BP_PER_PX,
    TRACK_LOD_LEVELS,
    TRACK_PICKER_GROUP_PREFIX,
    TRANSCRIPT_DETAIL_VIEWSPAN_BP,
    TUTORIAL_MOVE_MS,
    VCF_LOD_LEVELS,
    VCF_SETTINGS_DEFAULTS,
    isGeneModelTrack,
    isIntervalTrackType,
} from './browserConstants.js'
import {
    REV_COMP,
    TILE_SIZE,
    clamp,
    collectGenesFromList,
    getChromGeneCacheKey,
    getFetchErrorMessage,
    getTileKey,
    isTransientFetchErrorMessage,
    snapToTile,
} from './trackData.js'
import {
    isVcfAdaptiveLikeMode,
    normalizeBedSettings,
    normalizeBigWigDisplayMode,
    normalizeBigWigSettings,
    normalizeSpliceTrackSettings,
    normalizeVcfDisplayMode,
    normalizeVcfSettings,
} from './trackSettings.js'
import { spliceJunctionKey } from './spliceGeometry.js'
import {
    formatBp,
    formatCoord,
    formatGeneStrand,
    formatRegionCoord,
    formatSignalValueForTooltip,
    formatSignalValueForTrack,
    getFeatureCoordsForView,
    getGeneCoordRange,
    getSelectedGeneCoordsForView,
    getTranscriptLayoutMetrics,
    getTranscriptPopupMetadata,
    hasGeneCoords,
} from './browserFormat.js'
import {
    getScrollerMetrics,
    getScrollerVisibleTop,
    measureExpandedFooterLabelWidth,
    scrollScrollerTo,
} from './canvasText.js'
import { renderPanelExportSnapshot } from './exportSnapshot.js'
import { paintBrowserCanvas } from './paintCanvas.js'
import { runCustomTrackFetchEngine } from './customTrackFetchEngine.js'
import { computeBrowserLayout } from './browserLayout.js'
import { findCustomTrackHover } from './hitTesting.js'
import { findSelectedGeneTranscriptHit } from './hitTesting.js'
import { projectBigBedFeatureTiles } from './trackProjection.js'
import { projectVcfBlockTiles } from './trackProjection.js'
import { projectSpliceTiles } from './trackProjection.js'
import { projectVcfSummary } from './trackProjection.js'
import { projectVcfBlockSpans } from './trackProjection.js'
import { projectBedDensityTiles } from './trackProjection.js'
import { projectBigBedBlockTiles } from './trackProjection.js'
import { runBrowserSearch } from './browserSearch.js'
import { handleBrowserCanvasClick } from './pointerInput.js'
import { handleBrowserMouseMove } from './pointerInput.js'
import { renderBrowserToolbar } from './BrowserToolbar.jsx'
import { renderBrowserPanel } from './BrowserPanel.jsx'

/* The track picker adds and removes; switching a track on and off is the gutter's job.
 * Each row has one button, Add or Remove, for what it will be once applied, and rows that
 * are (or will be) on the panel are highlighted. Nothing changes until Apply. */
function PickerRowButton({ willShow, onClick, isLight, disabled = false, tourId }) {
    return (
        <button
            type="button"
            data-tour-id={tourId}
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onClick() }}
            className={`shrink-0 min-w-[4.5rem] px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${willShow
                ? isLight ? 'border border-gray-300 bg-white text-gray-700 hover:border-red-300 hover:text-red-700' : 'border border-gray-600 bg-gray-900 text-gray-200 hover:border-red-500/70 hover:text-red-300'
                : 'bg-blue-600 text-white hover:bg-blue-700'}`}
        >
            {willShow ? 'Remove' : 'Add'}
        </button>
    )
}

const extractPathData = (svgRaw) => {
    if (typeof svgRaw !== 'string') return ''
    const m = svgRaw.match(/<path[^>]*\sd=(['"])(.*?)\1/i)
    return m?.[2] || ''
}
const extractSvgBody = (svgRaw) => {
    if (typeof svgRaw !== 'string') return ''
    return svgRaw
        .replace(/^[\s\S]*?<svg[^>]*>/i, '')
        .replace(/<\/svg>[\s\S]*$/i, '')
        .trim()
}
const RESET_ICON_PATH_D = extractPathData(iconResetRaw)
const ANCHOR_ICON_BODY = extractSvgBody(iconAnchorRaw)

function TranscriptInfoPopup({
    popup,
    selectedChrom,
    onMouseEnter,
    onMouseLeave,
}) {
    const [copyFeedback, setCopyFeedback] = useState('')

    useEffect(() => {
        if (!copyFeedback) return undefined
        const timer = setTimeout(() => setCopyFeedback(''), 1400)
        return () => clearTimeout(timer)
    }, [copyFeedback])

    if (!popup?.transcript) return null

    const { transcript, arrowTargetX, arrowTargetY } = popup
    const metadata = getTranscriptPopupMetadata(transcript)
    const popupW = 318
    const arrowSize = 8
    const gap = 4
    const spaceLeft = arrowTargetX - arrowSize - gap
    const goLeft = spaceLeft >= popupW
    const popupLeft = goLeft
        ? arrowTargetX - popupW - arrowSize - gap
        : arrowTargetX + arrowSize + gap
    const handleCopyId = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        const payload = String(metadata.stableId || '').trim()
        if (!payload || payload === '—') return
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
    }

    return (
        <div
            data-transcript-popup="true"
            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
                left: popupLeft,
                top: arrowTargetY,
                transform: 'translateY(-50%)',
                width: popupW,
                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                color: '#f1f5f9',
                padding: '10px 14px',
                border: '1px solid rgba(255,255,255,0.1)',
                pointerEvents: 'auto',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
            }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div style={{
                position: 'absolute',
                top: '50%',
                transform: 'translateY(-50%)',
                [goLeft ? 'right' : 'left']: -arrowSize,
                width: 0,
                height: 0,
                borderTop: `${arrowSize}px solid transparent`,
                borderBottom: `${arrowSize}px solid transparent`,
                [goLeft ? 'borderLeft' : 'borderRight']: `${arrowSize}px solid rgba(17,24,39,0.97)`,
            }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Transcript</div>
                {copyFeedback ? <div style={{ fontSize: 11, color: '#93c5fd' }}>{copyFeedback}</div> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginBottom: 4 }}>
                <span style={{ opacity: 0.74 }}>Stable ID:</span>
                <span style={{ fontWeight: 700, fontFamily: FONT_MONO, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {metadata.stableId}
                </span>
                <button
                    type="button"
                    title="Copy transcript ID"
                    onClick={handleCopyId}
                    style={{
                        marginLeft: 'auto',
                        flex: '0 0 auto',
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(37, 99, 235, 0.22)',
                        color: '#dbeafe',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="5" y="5" width="14" height="16" rx="2.2" />
                        <path d="M9 3h6v4H9z" />
                    </svg>
                </button>
            </div>
            <div>Biotype: <span style={{ fontWeight: 700 }}>{metadata.biotype}</span></div>
            <div>Genomic span: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.genomicSpanBp)} bp</span></div>
            <div>Transcript length: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.transcriptLength)} bp</span></div>
            <div>Exons: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.exonCount)}</span></div>
            {metadata.hasCds && (
                <>
                    <div>CDS exons: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.cdsExonCount)}</span></div>
                    <div>CDS length: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.cdsLength)} bp</span></div>
                </>
            )}
        </div>
    )
}

// ============ GenomeBrowser Component ============

function GenomeBrowser({
    isActive = true,
    genome = 'reference',
    tutorialRecipeId = '',
    tutorialActive = false,   // a tutorial is running, whatever this panel's genome came from
    onTutorialHideInactive = null,  // Hide lives in the bar above, so the request is passed up
    alignmentRole = '',
    reloadEpoch = 0,
    theme = 'dark',
    alignmentOverlay = null,
    onPositionChange,
    onViewState,
    externalPosition,
    lockPan = false,
    lockZoom = false,
    onTrackVisibilityChange,
    forceTracksVisibility,
    label = 'Primary',
    genomePillLabel = '',
    genomeColor = '',
    onGenomePillClick = null,
    // Whether the assembly drawer the pill toggles is currently out. The pill
    // deliberately looks the same either way — this is for assistive tech only.
    genomePillExpanded = false,
    toolbarPosition = 'top',
    rulerPosition = 'top',
    focusBarPosition = 'top',
    trackAlign = 'top',
    showSequenceTrack = false,
    sequenceTrackPosition = 'bottom',
    sequenceTrackLabel = 'SR',
    sequenceTrackTooltip = 'Base level view of the reference',
    customTrackBrowsePath = '.',
    availableTracks = EMPTY_LIST,  // all registered tracks from Track Manager API
    availableGroups = EMPTY_LIST,  // track groups for this panel's genome, from the same API
    // What this genome had open last session, and where to report what it has open now.
    // `sessionReady` says the registry and the saved session have both been read; null
    // `onSessionTracksChange` means nothing is being remembered (switched off, or a tutorial).
    sessionTracks = null,
    sessionReady = false,
    onSessionTracksChange = null,
    refreshAvailableTracks = null,  // callback to re-fetch registered tracks
    tutorialTracksRequest = null,  // a tutorial's `browserTracks` arrival, reconciled below
    dimNonSelectedGenes = true,
    hideInactiveTracks = false,
    compressTranscripts = false,
    flattenTracks = false,
    adaptiveHeight = false,
    hiddenBiotypeClasses = EMPTY_LIST,
    onGeneSelect,
    // Genes the location drawer has hidden from the track. Scoped to the
    // location of focus by the view, which drops the set when that focus goes —
    // so nothing here has to remember to put them back.
    hiddenGeneIds = null,
    // The location of focus, reported upward the way the gene of focus is. There
    // is no drawer behind it — the view only needs to know a panel holds one, so
    // the Unfocus control can offer to clear it.
    onLocationSelect = null,
    // Focus-gene drawer: the parent owns the view model (ordering, hidden
    // transcripts, expand state, hover/ghost) and this panel renders it.
    focusTranscriptView = null,
    // geneId -> { order, hidden } for every gene the user has customised in this
    // panel, focused or not, so their choices survive unfocusing the gene.
    geneTranscriptViews = null,
    onFocusTranscriptsChange = null,
    onFocusTranscriptViewChange = null,
    // Where the pinned transcript's row sits inside this panel, in container-local
    // pixels. Reported rather than resolved here because only the view knows the
    // drawer row it has to meet.
    onFocusRowGeometryChange = null,
    // Edits addressed at a gene by id, so the canvas controls can act on genes
    // that are not the one currently in focus.
    onGeneTranscriptViewChange = null,
    // Width of the focus drawer overlaying this panel's right edge, so gene
    // framing centres on the track left visible rather than behind the drawer.
    // Two values because focusing a gene also opens the drawer: at click time
    // the overlay is not there yet, so framing has to anticipate it.
    focusDrawerInset = 0,
    focusDrawerInsetOnFocus = 0,
    navigateToGene,
    // A region asked for from outside the browser — a location note offering to
    // take the reader back. Focused on arrival, the way a typed region is.
    navigateToLocation = null,
    onManualNavigate,
    clearFocusEpoch = 0,
    screenshotTargetId = '',
    onScreenshotTargetChange = null,
    onViewSync = null,
    // Told when the panel moves out of (false) or back into (true) painting range,
    // so the view can stop driving an off-screen panel's viewport every frame.
    onNearViewportChange = null,
    // Shared band height for multi-genome layouts: the parent raises every panel
    // to the tallest genome's natural height so the rows stay aligned.
    minCanvasHeight = 0,
    onContentHeightChange = null,
    // Resolved gesture map from the user's "Genome Browser Controls" setting.
    browsingControls = DEFAULT_BROWSING_CONTROLS,
    onBrowsingTargetChange = null,
    // { [geneId]: count } for this panel's genome. Counts only — the bubble
    // needs to know a gene has notes, never what they say.
    geneNoteCounts = null,
    onOpenGeneNotes = null,
}) {
    // Refs
    const rootRef = useRef(null)
    const nearViewport = useNearViewport(rootRef, isActive)
    const paintCanvasRef = useRef(null)
    const canvasRef = useRef(null)
    const overlayRef = useRef(null)
    const containerRef = useRef(null)
    const toolbarRef = useRef(null)
    const animationRef = useRef(null)
    const velocityRef = useRef(0)
    const lastPosRef = useRef(0)
    const lastTimeRef = useRef(0)
    const adaptiveScrollAnchorRef = useRef(null)
    const adaptiveScrollAnchorFrameRef = useRef(null)
    const verticalZoomTrackAnchorRef = useRef(null)

    // State
    const [viewWidth, setViewWidth] = useState(800)
    const [viewHeight, setViewHeight] = useState(160)
    const [viewStart, setViewStart] = useState(0)        // Genomic coordinate of left edge
    const [viewEnd, setViewEnd] = useState(100000)        // Genomic coordinate of right edge
    const [expandedFooterViewport, setExpandedFooterViewport] = useState(null)
    // `isDragging` state only drives the cursor and listener wiring. The move
    // handler reads the refs instead, so the first mousemove after mousedown pans
    // immediately rather than being dropped while React commits the state.
    const [isDragging, setIsDragging] = useState(false)
    const isDraggingRef = useRef(false)
    const dragStartXRef = useRef(0)
    const dragViewStartRef = useRef(0)
    // 'all', or 'zoom-only' while a tutorial step asks for it. A ref because it is read
    // inside gesture handlers and must not make the panel re-render to take effect.
    const interactionModeRef = useRef('all')

    // Reached through the context, the way GenomeBrowserView does it: the tutorial
    // provider sits above App, so a view can report to it without anything in between
    // having to pass it along.
    const { emitSignal: emitTutorialSignal } = useTutorial()

    // Data state
    const [regions, setRegions] = useState([])
    const [selectedChrom, setSelectedChrom] = useState('')
    const [chromLength, setChromLength] = useState(0)
    const [expandedGenes, setExpandedGenes] = useState({})
    const [isViewportTranscriptExpandMode, setIsViewportTranscriptExpandMode] = useState(false)
    const [transcriptCache, setTranscriptCache] = useState({})  // gene_id -> transcripts[]
    const [selectedGene, setSelectedGene] = useState(null)
    // The location of focus: the same idea as the gene of focus, for a plain
    // stretch of the genome. { chrom, start, end } in 1-based genomic
    // coordinates. No drawer hangs off it — it is a focus bar, two boundary
    // lines and a re-centre target, nothing more.
    const [selectedLocation, setSelectedLocation] = useState(null)
    const [hiddenStrands, setHiddenStrands] = useState({ forward: false, reverse: false, sequence: false })
    const [sidebarTooltip, setSidebarTooltip] = useState(null)
    const [sequence, setSequence] = useState(null)
    const [seqRange, setSeqRange] = useState(null)          // {start, end} of fetched sequence
    const [isFlipped, setIsFlipped] = useState(false) // Standalone flip state
    const [isVerticalLayoutFlipped, setIsVerticalLayoutFlipped] = useState(false)
    const [isRulerCollapsed, setIsRulerCollapsed] = useState(false)
    const [isBoxSelectMode, setIsBoxSelectMode] = useState(false)
    const [isSelectingRect, setIsSelectingRect] = useState(false)
    const [selectionRect, setSelectionRect] = useState(null) // {x1,y1,x2,y2} in canvas CSS px
    const suppressNextClickRef = useRef(false)
    const [customTracks, setCustomTracks] = useState([]) // [{id, path, label, visible, renderMode, type}]
    const [customTrackData, setCustomTrackData] = useState({}) // id -> rendered data for current viewport
    const [customTrackLoading, setCustomTrackLoading] = useState({}) // id -> bool
    const [isCustomTrackBrowserOpen, setIsCustomTrackBrowserOpen] = useState(false)
    const [isCustomTrackLabelModalOpen, setIsCustomTrackLabelModalOpen] = useState(false)
    const [isTrackPickerOpen, setIsTrackPickerOpen] = useState(false) // new Track Picker Modal
    const [selectedTrackPickerIds, setSelectedTrackPickerIds] = useState([])
    // What the picker will take off the panel when applied: registry ids and 'group:<id>'.
    const [pendingPickerRemovals, setPendingPickerRemovals] = useState([])
    const [pendingCustomTrackPath, setPendingCustomTrackPath] = useState('')
    const [customTrackLabelInput, setCustomTrackLabelInput] = useState('Custom track')
    const [customTrackRenderModeInput, setCustomTrackRenderModeInput] = useState(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
    const [customTrackHoverTooltip, setCustomTrackHoverTooltip] = useState(null)
    const customTrackTooltipTimerRef = useRef(null)
    const customTrackTooltipPendingRef = useRef(null)
    const [hoveredVcfBlock, setHoveredVcfBlock] = useState(null) // { trackId, start, end } | null
    const hoveredVcfBlockRef = useRef(null) // shadow ref to avoid stale closure comparisons
    const [hoveredBigBedFeature, setHoveredBigBedFeature] = useState(null) // { trackId, key, feature, anchorCanvasX, anchorCanvasY } | null
    const hoveredBigBedRef = useRef(null)
    const [hoveredSpliceJunction, setHoveredSpliceJunction] = useState(null) // { trackId, key, junction } | null
    const hoveredSpliceRef = useRef(null)
    const [clickedVcfVariant, setClickedVcfVariant] = useState(null) // { variant, chrom, clientX, clientY } | null
    const [clickedBigBedFeature, setClickedBigBedFeature] = useState(null) // { trackId, feature, popupX, popupY } | null
    const [clickedSpliceJunction, setClickedSpliceJunction] = useState(null) // { trackId, junction, popupX, popupY } | null
    const [spliceArcLiftOffsets, setSpliceArcLiftOffsets] = useState({}) // `${trackId}|${junctionKey}` -> px
    const spliceArcDragRef = useRef(null) // { trackId, key, startClientY, initialLift }
    const [hoveredSeqBase, setHoveredSeqBase] = useState(null) // { bp, base, bxL, bxR, seqBoxT, seqBoxH } | null
    const hoveredSeqBaseRef = useRef(null)
    const [clickedSeqBase, setClickedSeqBase] = useState(null) // { bp, base, bxL, bxR, seqBoxT, seqBoxH, popupX, popupY } | null
    const [clickedGeneTranscript, setClickedGeneTranscript] = useState(null) // { geneId, transcriptId, transcript, arrowTargetX, arrowTargetY }
    const transcriptPopupHoverRef = useRef(false)
    const transcriptPopupDismissTimerRef = useRef(null)
    const focusBarRef = useRef(null)
    const [focusBarHeight, setFocusBarHeight] = useState(0)
    const pendingVerticalCenterGeneIdRef = useRef(null)
    const pendingTranscriptPillFocusRef = useRef(null)
    const anchorIconImgRef = useRef(null)
    const [anchorIconReady, setAnchorIconReady] = useState(false)
    const selectedChromRef = useRef(selectedChrom)
    // Where this panel was before the page reloaded, if it was there, until the regions
    // load and the panel can go back to it. See the session snapshot further down.
    const sessionPanelKey = `browser.panel:${String(screenshotTargetId || genome || '')}`
    const resumeViewRef = useRef(undefined)
    if (resumeViewRef.current === undefined) {
        const saved = peekRestoredSessionState(sessionPanelKey)
        resumeViewRef.current = (saved?.chrom && Number(saved.end) > Number(saved.start)) ? saved : null
    }
    const viewWidthRef = useRef(viewWidth)
    const onTrackVisibilityChangeRef = useRef(onTrackVisibilityChange)
    const onGeneSelectRef = useRef(onGeneSelect)
    const onFocusTranscriptsChangeRef = useRef(onFocusTranscriptsChange)
    const onFocusTranscriptViewChangeRef = useRef(onFocusTranscriptViewChange)
    const onGeneTranscriptViewChangeRef = useRef(onGeneTranscriptViewChange)
    const onFocusRowGeometryChangeRef = useRef(onFocusRowGeometryChange)
    const onScreenshotTargetChangeRef = useRef(onScreenshotTargetChange)
    const onViewSyncRef = useRef(onViewSync)
    const onViewStateRef = useRef(onViewState)
    const onContentHeightChangeRef = useRef(onContentHeightChange)
    onContentHeightChangeRef.current = onContentHeightChange
    // Mirrored into a ref and deliberately kept OUT of the wheel effect's
    // dependency list, so changing the scheme never re-registers the listener
    // (which mid-gesture would drop the rest of a trackpad fling).
    const browsingControlsRef = useRef(browsingControls)
    browsingControlsRef.current = browsingControls
    const wheelGestureRef = useRef(null)
    const onBrowsingTargetChangeRef = useRef(onBrowsingTargetChange)
    onBrowsingTargetChangeRef.current = onBrowsingTargetChange
    selectedChromRef.current = selectedChrom
    viewWidthRef.current = viewWidth
    onTrackVisibilityChangeRef.current = onTrackVisibilityChange
    onGeneSelectRef.current = onGeneSelect
    onFocusTranscriptsChangeRef.current = onFocusTranscriptsChange
    onFocusTranscriptViewChangeRef.current = onFocusTranscriptViewChange
    onGeneTranscriptViewChangeRef.current = onGeneTranscriptViewChange
    onFocusRowGeometryChangeRef.current = onFocusRowGeometryChange
    const onOpenGeneNotesRef = useRef(onOpenGeneNotes)
    onOpenGeneNotesRef.current = onOpenGeneNotes
    onScreenshotTargetChangeRef.current = onScreenshotTargetChange
    onViewSyncRef.current = onViewSync
    onViewStateRef.current = onViewState

    useEffect(() => {
        if (!iconAnchorRaw) {
            anchorIconImgRef.current = null
            setAnchorIconReady(false)
            return undefined
        }

        // Load the anchor icon from an in-memory data URL so drawing it never taints the browser canvas.
        const img = new Image()
        img.decoding = 'async'
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconAnchorRaw)}`
        const onLoad = () => {
            anchorIconImgRef.current = img
            setAnchorIconReady(true)
        }
        const onError = () => {
            anchorIconImgRef.current = null
            setAnchorIconReady(false)
        }
        if (img.complete && img.naturalWidth > 0) onLoad()
        else {
            img.addEventListener('load', onLoad)
            img.addEventListener('error', onError)
        }
        return () => {
            img.removeEventListener('load', onLoad)
            img.removeEventListener('error', onError)
        }
    }, [])

    const clearCustomTrackTooltipDelay = useCallback(() => {
        if (customTrackTooltipTimerRef.current) {
            clearTimeout(customTrackTooltipTimerRef.current)
            customTrackTooltipTimerRef.current = null
        }
    }, [])

    const dismissCustomTrackTooltip = useCallback(() => {
        clearCustomTrackTooltipDelay()
        customTrackTooltipPendingRef.current = null
        setCustomTrackHoverTooltip(null)
    }, [clearCustomTrackTooltipDelay])

    const queueCustomTrackTooltip = useCallback((payload, mouseX, mouseY, clientX, clientY) => {
        if (!payload?.text) {
            dismissCustomTrackTooltip()
            return
        }
        const hoverKey = String(payload.hoverKey || payload.text || '')
        const pending = customTrackTooltipPendingRef.current
        const distance = pending ? Math.hypot(mouseX - pending.mouseX, mouseY - pending.mouseY) : Infinity
        const sameTarget = !!pending && pending.hoverKey === hoverKey && distance <= CUSTOM_TRACK_TOOLTIP_MOVE_TOL_PX
        if (!sameTarget) {
            clearCustomTrackTooltipDelay()
            setCustomTrackHoverTooltip(null)
            customTrackTooltipPendingRef.current = {
                hoverKey,
                text: payload.text,
                mouseX,
                mouseY,
                clientX,
                clientY,
            }
            customTrackTooltipTimerRef.current = setTimeout(() => {
                const current = customTrackTooltipPendingRef.current
                if (!current || current.hoverKey !== hoverKey) return
                setCustomTrackHoverTooltip({
                    text: current.text,
                    x: current.clientX,
                    y: current.clientY,
                })
                customTrackTooltipTimerRef.current = null
            }, CUSTOM_TRACK_TOOLTIP_DWELL_MS)
            return
        }
        customTrackTooltipPendingRef.current = {
            ...pending,
            text: payload.text,
            mouseX,
            mouseY,
            clientX,
            clientY,
        }
    }, [clearCustomTrackTooltipDelay, dismissCustomTrackTooltip])

    useEffect(() => () => {
        clearCustomTrackTooltipDelay()
    }, [clearCustomTrackTooltipDelay])

    useEffect(() => {
        setClickedSpliceJunction(null)
    }, [selectedChrom])

    // Alignment Overlay Computations
    const isAligned = !!alignmentOverlay
    const isPrimary = alignmentRole ? alignmentRole === 'reference' : genome === 'reference'
    const alignData = isPrimary ? alignmentOverlay?.reference : alignmentOverlay?.target

    const alignmentCoords = useMemo(() => {
        if (!isAligned || !alignData) return null
        const genomicToAlign = new Map() // genomic pos -> align pos
        const alignToGenomic = [] // align pos -> genomic pos

        let genomicPos = alignData.strand === '+' ? alignData.genomic_start : alignData.genomic_end
        const step = alignData.strand === '+' ? 1 : -1

        for (let alignPos = 0; alignPos < alignData.sequence.length; alignPos++) {
            const char = alignData.sequence[alignPos]
            alignToGenomic.push(genomicPos)
            if (char !== '-') {
                genomicToAlign.set(genomicPos, alignPos)
                genomicPos += step
            }
        }

        return {
            genomicToAlign,
            alignToGenomic,
            length: alignData.sequence.length,
            strand: alignData.strand
        }
    }, [isAligned, alignData])

    // Overlay coordinate (alignment columns, with virtual extension outside bounds) -> genomic
    const overlayToGenomic = useCallback((overlayPos) => {
        if (!isAligned || !alignmentCoords || !alignData) return overlayPos
        const length = alignmentCoords.length
        if (length <= 0) return overlayPos
        const step = alignmentCoords.strand === '+' ? 1 : -1
        const leftG = alignmentCoords.alignToGenomic[0] ?? alignData.genomic_start
        const rightG = alignmentCoords.alignToGenomic[length - 1] ?? alignData.genomic_end

        if (overlayPos < 0) {
            return leftG + overlayPos * step
        }
        if (overlayPos > (length - 1)) {
            return rightG + (overlayPos - (length - 1)) * step
        }

        const idx = Math.max(0, Math.min(length - 1, Math.round(overlayPos)))
        const mapped = alignmentCoords.alignToGenomic[idx]
        if (mapped !== undefined) return mapped

        // Fallback interpolation for rare unmapped holes
        return leftG + overlayPos * step
    }, [isAligned, alignmentCoords, alignData])

    // Genomic -> overlay coordinate, including linear extension beyond alignment edges
    const genomicToOverlay = useCallback((genomicPos) => {
        if (!isAligned || !alignmentCoords || !alignData) return genomicPos
        const length = alignmentCoords.length
        if (length <= 0) return genomicPos
        const step = alignmentCoords.strand === '+' ? 1 : -1
        const leftG = alignmentCoords.alignToGenomic[0] ?? alignData.genomic_start
        const rightG = alignmentCoords.alignToGenomic[length - 1] ?? alignData.genomic_end

        const rounded = Math.round(genomicPos)
        const exact = alignmentCoords.genomicToAlign.get(rounded)
        if (exact !== undefined) return exact

        // Convert positions outside alignment bounds
        const fromLeft = (genomicPos - leftG) / step
        if (fromLeft < 0) return fromLeft
        const fromRight = ((genomicPos - rightG) / step) + (length - 1)
        if (fromRight > (length - 1)) return fromRight

        // Inside alignment but fell on a gap-only projection: search nearest mapped genomic base
        for (let dist = 1; dist < 2000; dist++) {
            const left = alignmentCoords.genomicToAlign.get(rounded - dist)
            if (left !== undefined) return left
            const right = alignmentCoords.genomicToAlign.get(rounded + dist)
            if (right !== undefined) return right
        }

        return fromLeft
    }, [isAligned, alignmentCoords, alignData])

    // Effect to snap view into alignment bounds when entering overlay
    useEffect(() => {
        if (isAligned && alignData) {
            const newStart = 0
            const newEnd = alignData.sequence.length
            setViewStart(newStart)
            setViewEnd(newEnd)
            if (onPositionChange) {
                onPositionChange(selectedChrom, newStart, newEnd)
            }
        } else if (!isAligned && alignmentCoords) {
            // Restore to normal genomic bounds when exiting
            // But we don't know exactly what to restore to unless we cached it...
            // the parent likely triggers a reload anyway or we just stay at the genomic pos
            setViewStart(Math.min(...Array.from(alignmentCoords.genomicToAlign.keys())))
            setViewEnd(Math.max(...Array.from(alignmentCoords.genomicToAlign.keys())))
        }
    }, [isAligned]) // Only trigger on enter/exit

    // Override hiddenStrands when aligned so we only see the relevant strand
    const effectiveHiddenStrands = useMemo(() => {
        if (!isAligned || !alignData) return hiddenStrands;
        return {
            ...hiddenStrands,
            forward: hiddenStrands.forward || alignData.strand !== '+',
            reverse: hiddenStrands.reverse || alignData.strand !== '-'
        }
    }, [isAligned, alignData, hiddenStrands])

    // Genomic view range for backend fetching
    const genomicViewRange = useMemo(() => {
        if (isAligned && alignmentCoords && alignData) {
            const g1 = overlayToGenomic(Math.floor(viewStart))
            const g2 = overlayToGenomic(Math.ceil(viewEnd))
            return {
                start: Math.min(g1, g2),
                end: Math.max(g1, g2)
            }
        }
        return { start: viewStart, end: viewEnd }
    }, [viewStart, viewEnd, isAligned, alignmentCoords, alignData, overlayToGenomic])
    const genomicViewRangeRef = useRef(genomicViewRange)
    genomicViewRangeRef.current = genomicViewRange

    // Sync hiddenStrands when the global force tracks command changes
    useEffect(() => {
        if (forceTracksVisibility === 'off') {
            setHiddenStrands({ forward: true, reverse: true, sequence: true })
        } else if (forceTracksVisibility === 'on') {
            setHiddenStrands({ forward: false, reverse: false, sequence: false })
        }
    }, [forceTracksVisibility])

    // Report effective visibility to parent
    useEffect(() => {
        if (onTrackVisibilityChangeRef.current) {
            onTrackVisibilityChangeRef.current(effectiveHiddenStrands, {
                customInactive: customTracks.some((track) => track?.visible === false),
                customTotal: customTracks.length,
            })
        }
    }, [effectiveHiddenStrands, customTracks])

    const swapVerticalPlacement = useCallback((value) => {
        if (value === 'top') return 'bottom'
        if (value === 'bottom') return 'top'
        return value
    }, [])

    const effectiveToolbarPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(toolbarPosition) : toolbarPosition
    const effectiveRulerPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(rulerPosition) : rulerPosition
    // Not swapped with the rest. The focus drawer hangs down from this bar, so at the
    // bottom of a flipped panel it ran out past the panel and was cut off by the next.
    const effectiveFocusBarPosition = focusBarPosition
    const effectiveTrackAlign = isVerticalLayoutFlipped ? swapVerticalPlacement(trackAlign) : trackAlign
    const effectiveRulerHeight = isRulerCollapsed ? 0 : RULER_HEIGHT
    const effectiveSequenceTrackPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(sequenceTrackPosition) : sequenceTrackPosition
    // Panels never scroll internally: the page-level scroller in GenomeBrowserView
    // owns all vertical movement, so tracks always lay out at their natural height
    // and grow the page rather than a nested scrollbar. "Adaptive"/"Flatten"
    // therefore no longer affect scrolling — they only decide whether a panel may
    // shrink below the uniform multi-genome band height, and how much trailing
    // padding is drawn under the last track.
    const compactPanelHeight = flattenTracks || adaptiveHeight

    // Drag-and-drop reordering
    const composeTrackOrder = useCallback((seqPosition, customIds, strandOrder = ['forward', 'reverse']) => {
        const orderedCustom = Array.isArray(customIds) ? customIds : []
        if (seqPosition === 'top') {
            return ['sequence', ...orderedCustom, ...strandOrder]
        }
        return [...strandOrder, ...orderedCustom, 'sequence']
    }, [])

    const [trackOrder, setTrackOrder] = useState(() => composeTrackOrder(sequenceTrackPosition, []))

    // Flipping to 3'→5' puts GR on top, where the strand that now reads left to
    // right belongs, and flipping back restores it. Swapped in place, so any
    // order the user dragged the tracks into survives the round trip.
    const toggleFlipped = useCallback(() => {
        setIsFlipped((prev) => !prev)
        // Their popups were placed on screen at the feature, which the flip moves.
        setClickedVcfVariant(null)
        setClickedBigBedFeature(null)
        setClickedSpliceJunction(null)
        setClickedSeqBase(null)
        setClickedGeneTranscript(null)
        setTrackOrder((prev) => {
            const forwardIdx = prev.indexOf('forward')
            const reverseIdx = prev.indexOf('reverse')
            if (forwardIdx === -1 || reverseIdx === -1) return prev
            const next = [...prev]
            next[forwardIdx] = 'reverse'
            next[reverseIdx] = 'forward'
            return next
        })
    }, [])
    const [draggingTrack, setDraggingTrack] = useState(null)
    const [hoveredTrack, setHoveredTrack] = useState(null)
    const isCustomTrackId = useCallback((trackId) => trackId.startsWith('ct_'), [])
    // Groups switched on (or re-laid out) since the order was last synced: their tracks are
    // gathered into group order where the first of them sits.
    const pendingGroupOrderRef = useRef(new Set())

    // Keep track order in sync with current custom tracks. A track group shown joined is
    // one row (`cg_…`) in the order; its tracks are laid out inside that row instead.
    useEffect(() => {
        const rowIds = []
        const seenRows = new Set()
        for (const track of customTracks) {
            const rowId = track.joinedRowId || track.id
            if (seenRows.has(rowId)) continue
            seenRows.add(rowId)
            rowIds.push(rowId)
        }
        const regroup = pendingGroupOrderRef.current
        pendingGroupOrderRef.current = new Set()
        const groupRowOrder = (groupId) => customTracks
            .filter((track) => track.group?.id === groupId && !track.joinedRowId)
            .sort((a, b) => a.group.index - b.group.index)
            .map((track) => track.id)
        setTrackOrder((prev) => {
            const existingCustomOrder = prev.filter((trackId) => (isCustomTrackId(trackId) || isGroupRowId(trackId)) && seenRows.has(trackId))
            const existingCustomSet = new Set(existingCustomOrder)
            const newCustomIds = rowIds.filter((trackId) => !existingCustomSet.has(trackId))
            let nextCustomOrder = [...existingCustomOrder, ...newCustomIds]
            for (const groupId of regroup) nextCustomOrder = gatherRows(nextCustomOrder, groupRowOrder(groupId))
            // Keep whichever strand is on top: a flipped panel puts GR first.
            const strandOrder = prev.indexOf('reverse') < prev.indexOf('forward')
                ? ['reverse', 'forward']
                : ['forward', 'reverse']
            const nextOrder = composeTrackOrder(effectiveSequenceTrackPosition, nextCustomOrder, strandOrder)
            if (nextOrder.length === prev.length && nextOrder.every((trackId, idx) => trackId === prev[idx])) {
                return prev
            }
            return nextOrder
        })
    }, [customTracks, effectiveSequenceTrackPosition, isCustomTrackId, composeTrackOrder])

    // Region filter
    const [showFeatureless, setShowFeatureless] = useState(false)
    const [searchInput, setSearchInput] = useState('')
    // What the search box could not follow, or had to adjust: { tone: 'error' | 'warning', text }.
    // Errors stay until the query is edited or dismissed; warnings clear themselves.
    const [searchFeedback, setSearchFeedback] = useState(null)
    const searchFeedbackTimerRef = useRef(null)
    const showSearchFeedback = useCallback((tone, text) => {
        if (searchFeedbackTimerRef.current) clearTimeout(searchFeedbackTimerRef.current)
        searchFeedbackTimerRef.current = null
        setSearchFeedback(text ? { tone, text } : null)
        if (text && tone === 'warning') {
            searchFeedbackTimerRef.current = setTimeout(() => setSearchFeedback(null), 7000)
        }
    }, [])
    useEffect(() => () => {
        if (searchFeedbackTimerRef.current) clearTimeout(searchFeedbackTimerRef.current)
    }, [])

    // Loading states
    const [loadingRegions, setLoadingRegions] = useState(false)
    const [loadingGenes, setLoadingGenes] = useState(false)
    const [hasInitialViewportData, setHasInitialViewportData] = useState(false)
    const transcriptCacheRef = useRef(transcriptCache)
    const transcriptCacheUsageRef = useRef(new Map())
    const transcriptCacheTouchCounterRef = useRef(0)
    const protectedTranscriptCacheIdsRef = useRef(new Set())
    const fetchingTranscriptIdsRef = useRef(new Map())
    const transcriptRequestGenerationRef = useRef(0)
    const identityRequestControllersRef = useRef(new Set())

    // Tile cache: Map of `chrom:tileStart` -> gene[] (stored in ref to avoid re-renders)
    const tileCacheRef = useRef(new Map())
    // Track in-flight tile fetches to avoid duplicate requests
    const fetchingTilesRef = useRef(new Map())
    const activeGeneRequestGenerationRef = useRef(0)
    // Resident simplified genes for each chromosome. These are kept for the
    // component session so zoomed-out panning does not cycle gene windows.
    const chromGeneCacheRef = useRef(new Map())
    const fetchingChromGenesRef = useRef(new Map())
    const chromGeneGenerationRef = useRef(0)
    // Derived visible genes from cache (state so canvas re-renders)
    const [genes, setGenes] = useState([])
    const geneSubtrackStateRef = useRef((viewEnd - viewStart) <= GENE_SUBTRACK_ENABLE_BP)
    const geneRowStickyRef = useRef({ forward: 1, reverse: 1 })
    const geneRowShrinkBucketRef = useRef({ forward: null, reverse: null })
    const geneLayoutPackCacheRef = useRef({
        forward: { key: '', rowMap: new Map(), requiredRows: 1 },
        reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
    })
    const previousStickyLayoutModeRef = useRef({
        expanded: isViewportTranscriptExpandMode,
        flatten: flattenTracks,
    })
    const [stickyLayoutResetEpoch, setStickyLayoutResetEpoch] = useState(0)
    const colors = COLORS[theme] || COLORS.dark
    const isLight = theme === 'light'

    useEffect(() => {
        geneSubtrackStateRef.current = true
        geneRowStickyRef.current = { forward: 1, reverse: 1 }
        geneRowShrinkBucketRef.current = { forward: null, reverse: null }
        geneLayoutPackCacheRef.current = {
            forward: { key: '', rowMap: new Map(), requiredRows: 1 },
            reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
        }
    }, [genome, selectedChrom])

    // Expanded transcript views deliberately make the canvas very tall, and Flatten
    // deliberately removes that height. The ordinary panning stabiliser must not carry
    // either temporary shape back into the plain layout: after collapsing the transcripts
    // it used to leave two thousand pixels of blank track below them. Reset synchronously
    // and invalidate the layout memo before the next frame is painted.
    useLayoutEffect(() => {
        const next = { expanded: isViewportTranscriptExpandMode, flatten: flattenTracks }
        const previous = previousStickyLayoutModeRef.current
        previousStickyLayoutModeRef.current = next
        if (!shouldResetStickyGeneRows(previous, next)) return
        geneRowStickyRef.current = { forward: 1, reverse: 1 }
        geneRowShrinkBucketRef.current = { forward: null, reverse: null }
        geneLayoutPackCacheRef.current = {
            forward: { key: '', rowMap: new Map(), requiredRows: 1 },
            reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
        }
        setStickyLayoutResetEpoch((epoch) => epoch + 1)
    }, [isViewportTranscriptExpandMode, flattenTracks])

    // ============ Gene index readiness ============

    // The assembly is browsable long before the genes are. Regions, the ruler
    // and the sequence track all come from the FASTA, which is ready at once,
    // while indexing a large annotation takes minutes — and indexing is serial,
    // so a second genome waits for the first. Rather than hold the panel behind
    // a spinner for all of that, the browser opens on the assembly and watches
    // this endpoint to fill the gene track in when the index lands.
    const [geneIndexStatus, setGeneIndexStatus] = useState(null)
    const [geneIndexEpoch, setGeneIndexEpoch] = useState(0)
    const geneIndexReadyRef = useRef(false)
    const sawPendingRef = useRef(false)

    useEffect(() => {
        geneIndexReadyRef.current = false
        sawPendingRef.current = false
        setGeneIndexStatus(null)
    }, [genome, reloadEpoch])

    useEffect(() => {
        if (!isActive) return undefined
        let cancelled = false
        let timer = null
        const controller = new AbortController()

        const poll = async () => {
            try {
                const res = await fetch(
                    `${API_BASE}/api/browse/index-status?genome=${encodeURIComponent(genome)}`,
                    { signal: controller.signal },
                )
                if (!res.ok) {
                    // A genome this backend does not recognise will never start
                    // recognising it. Only a server-side fault is worth waiting
                    // out — that is a restart, and it comes back.
                    if (res.status >= 400 && res.status < 500) return
                    throw new Error(`index status ${res.status}`)
                }
                const data = await res.json()
                if (cancelled) return
                setGeneIndexStatus(data)

                if (data?.state === 'ready') {
                    // Genes that were not there when the panel opened are there
                    // now. Bumping the epoch drops the empty tiles the browser
                    // cached while it waited and asks for them again. Only worth
                    // doing if we actually waited: an index that was ready all
                    // along would otherwise throw away a good cache on mount.
                    if (sawPendingRef.current && !geneIndexReadyRef.current) {
                        geneIndexReadyRef.current = true
                        setGeneIndexEpoch((epoch) => epoch + 1)
                    }
                    return
                }
                sawPendingRef.current = true
                // 'none' means the genome has no annotation at all. There is
                // nothing to wait for, so stop asking.
                if (data?.state === 'none' || data?.state === 'failed') return
            } catch (error) {
                if (error?.name === 'AbortError' || cancelled) return
                // Backend restarting, most likely. Keep watching.
            }
            if (!cancelled) {
                timer = window.setTimeout(poll, GENE_INDEX_POLL_INTERVAL_MS)
            }
        }

        poll()
        return () => {
            cancelled = true
            controller.abort()
            if (timer) window.clearTimeout(timer)
        }
    }, [genome, isActive, reloadEpoch, geneIndexEpoch])

    const retryGeneIndex = useCallback(async () => {
        try {
            await fetch(`${API_BASE}/api/browse/index-retry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ genome }),
            })
        } catch (error) {
            console.error(`[GenomeBrowser:${genome}] Failed to restart the index build:`, error)
        }
        setGeneIndexStatus((prev) => ({ ...(prev || {}), state: 'queued' }))
        setGeneIndexEpoch((epoch) => epoch + 1)
    }, [genome])

    const holdGeneTrackHeight = shouldHoldGeneTrackHeight(geneIndexStatus)
    // No gene tiles are coming: the index is being built, or the build failed.
    // A genome that simply has no annotation is not this — its gene endpoints
    // answer normally with nothing in them, which the browser already handles.
    const geneTilesBlocked = holdGeneTrackHeight

    // Read from the fetch paths, which must not be rebuilt every time the meter
    // moves. Asking for genes while the index is being built only produces a
    // stream of "not yet" replies — one per tile, per pan, for the whole build.
    const geneTilesBlockedRef = useRef(false)
    useEffect(() => {
        geneTilesBlockedRef.current = geneTilesBlocked
    }, [geneTilesBlocked])

    // Everything that was keyed on the reload epoch is keyed on this instead, so
    // an index that lands after the panel opened clears the same caches a manual
    // reload would.
    const dataEpoch = reloadEpoch + geneIndexEpoch

    useEffect(() => {
        setHasInitialViewportData(false)
        setGenes([])
        tileCacheRef.current.clear()
        fetchingTilesRef.current.clear()
        chromGeneGenerationRef.current += 1
        chromGeneCacheRef.current.clear()
        fetchingChromGenesRef.current.clear()
    }, [genome, dataEpoch])

    useEffect(() => {
        activeGeneRequestGenerationRef.current += 1
        return () => {
            for (const controller of identityRequestControllersRef.current) controller.abort()
            identityRequestControllersRef.current.clear()
            fetchingTilesRef.current.clear()
            fetchingChromGenesRef.current.clear()
            fetchingTranscriptIdsRef.current.clear()
        }
    }, [genome, dataEpoch, selectedChrom])

    // Whether this panel should carry the tutorial's invisible gutter buttons. Either the
    // panel's genome came from an embedded recipe, or a tutorial is simply running on it.
    const tutorialAnchorsActive = Boolean(tutorialRecipeId) || Boolean(tutorialActive)

    const customTracksById = useMemo(() => {
        const map = new Map()
        for (const t of customTracks) map.set(t.id, t)
        return map
    }, [customTracks])

    // Joined track groups on this panel: row id -> the group and its tracks in group order.
    const joinedRows = useMemo(() => {
        const map = new Map()
        for (const t of customTracks) {
            if (!t.joinedRowId) continue
            if (!map.has(t.joinedRowId)) {
                map.set(t.joinedRowId, { rowId: t.joinedRowId, groupId: t.group?.id, label: t.group?.label || 'Track group', tracks: [] })
            }
            map.get(t.joinedRowId).tracks.push(t)
        }
        for (const row of map.values()) {
            row.tracks.sort((a, b) => (a.group?.index ?? 0) - (b.group?.index ?? 0))
            row.memberIds = row.tracks.map((t) => t.id)
            row.hidden = row.tracks.every((t) => t.visible === false)
        }
        return map
    }, [customTracks])

    // Keep browser track config synced with Track Manager registry updates.
    // This avoids stale renderMode/settings when users edit a registered track.
    useEffect(() => {
        if (!Array.isArray(availableTracks) || availableTracks.length === 0 || !Array.isArray(customTracks) || customTracks.length === 0) return
        const byRegistryId = new Map()
        const byPath = new Map()
        for (const registered of availableTracks) {
            if (!registered) continue
            if (registered.id !== undefined && registered.id !== null) {
                byRegistryId.set(String(registered.id), registered)
            }
            if (registered.path) byPath.set(String(registered.path), registered)
        }
        const groupsById = new Map((Array.isArray(availableGroups) ? availableGroups : []).map((g) => [String(g.id), g]))

        const fullRefreshIds = new Set()
        let localChanged = false
        const nextCustomTracks = customTracks.map((track) => {
            const registryId = track?.registryTrackId ? String(track.registryTrackId) : ''
            let registered = null
            if (registryId && byRegistryId.has(registryId)) {
                registered = byRegistryId.get(registryId)
            } else if (track?.path && byPath.has(String(track.path))) {
                registered = byPath.get(String(track.path))
            }
            if (!registered) return track

            // One of a group's tracks shows with the group's own settings for it, and follows
            // the group's name and layout. A group that is gone leaves a plain custom track.
            let groupInfo = track.group
            let joinedRowId = track.joinedRowId
            if (track.group) {
                const group = groupsById.get(String(track.group.id))
                if (!group) {
                    groupInfo = undefined
                    joinedRowId = undefined
                } else {
                    const memberIndex = (group.members || []).findIndex((m) => String(m.track_id) === String(registered.id))
                    if (memberIndex >= 0) registered = effectiveMemberTrack(registered, group.members[memberIndex])
                    groupInfo = {
                        id: group.id,
                        label: group.label,
                        layout: group.layout,
                        index: memberIndex >= 0 ? memberIndex : track.group.index,
                    }
                    joinedRowId = group.layout === 'joined' ? groupRowIdFor(group.id) : undefined
                }
                if (joinedRowId !== track.joinedRowId || groupInfo?.index !== track.group.index) {
                    if (groupInfo) pendingGroupOrderRef.current.add(groupInfo.id)
                }
            }

            const registeredType = registered.type || track.type || 'bigwig'
            const synced = {
                ...track,
                group: groupInfo,
                joinedRowId,
                registryTrackId: registered.id,
                type: registeredType,
                label: registered.label || track.label,
                path: registered.path || track.path,
            }

            if (registeredType === 'bigwig') {
                const mergedSettings = normalizeBigWigSettings(
                    registered.bigwig_settings,
                    track?.bigwigSettings || track?.bigwig_settings,
                )
                synced.bigwigSettings = mergedSettings
                synced.renderMode = normalizeBigWigDisplayMode(registered.display_mode, mergedSettings.data_type)
            } else if (registeredType === 'vcf') {
                synced.vcfSettings = normalizeVcfSettings(
                    registered.vcf_settings,
                    track?.vcfSettings || track?.vcf_settings,
                )
                synced.renderMode = normalizeVcfDisplayMode(registered.display_mode)
            } else if (registeredType === 'splice_junctions') {
                synced.spliceSettings = normalizeSpliceTrackSettings(registered.splice_settings)
                synced.renderMode = 'arcs'
            } else if (registered.display_mode) {
                synced.renderMode = registered.display_mode
            }
            if (isIntervalTrackType(registeredType)) {
                synced.bedSettings = normalizeBedSettings(registered.bed_settings)
            }

            const prevBigwig = track?.bigwigSettings || track?.bigwig_settings
            const nextBigwig = synced?.bigwigSettings || synced?.bigwig_settings
            const settingsChanged = JSON.stringify(prevBigwig || null) !== JSON.stringify(nextBigwig || null)
            const vcfSettingsChanged = JSON.stringify(track?.vcfSettings || track?.vcf_settings || null) !== JSON.stringify(synced?.vcfSettings || synced?.vcf_settings || null)
            const spliceChanged = JSON.stringify(track?.spliceSettings || track?.splice_settings || null) !== JSON.stringify(synced?.spliceSettings || synced?.splice_settings || null)
            const bedSettingsChanged = JSON.stringify(track?.bedSettings || null) !== JSON.stringify(synced?.bedSettings || null)
            const requiresFullRefresh = (
                String(synced.path || '') !== String(track.path || '')
                || String(synced.renderMode || '') !== String(track.renderMode || '')
                || String(synced.type || '') !== String(track.type || '')
            )
            if (requiresFullRefresh && track?.id) {
                fullRefreshIds.add(String(track.id))
            }
            if (
                synced.renderMode !== track.renderMode
                || synced.label !== track.label
                || synced.type !== track.type
                || synced.path !== track.path
                || String(synced.registryTrackId || '') !== String(track.registryTrackId || '')
                || JSON.stringify(synced.group || null) !== JSON.stringify(track.group || null)
                || synced.joinedRowId !== track.joinedRowId
                || settingsChanged
                || vcfSettingsChanged
                || spliceChanged
                || bedSettingsChanged
            ) {
                localChanged = true
            }
            return synced
        })

        if (localChanged) {
            setCustomTracks(nextCustomTracks)
        }
        if (!localChanged || fullRefreshIds.size === 0) return

        const shouldDropTrack = (rawKey) => {
            const normalized = String(rawKey || '').replace(/^(sjblk:|sj:|vcfblk:|adpdet:|bbblk:|bbft:|bddn:)/, '')
            const trackId = normalized.split('|', 1)[0]
            return fullRefreshIds.has(trackId)
        }

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackFeatureFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfBlockTileFetchSetRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = String(key).split('|', 1)[0]
            if (fullRefreshIds.has(trackId)) delete trackChromScaleRef.current[key]
        }
        for (const key of Object.keys(bedDensityScaleRef.current)) {
            const trackId = String(key).split('|', 1)[0]
            if (fullRefreshIds.has(trackId)) delete bedDensityScaleRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) delete next[trackId]
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) next[trackId] = true
            return next
        })
    }, [availableTracks, availableGroups, customTracks])

    useEffect(() => {
        if (!clickedSpliceJunction) return
        if (!customTracksById.has(clickedSpliceJunction.trackId)) {
            setClickedSpliceJunction(null)
        }
    }, [clickedSpliceJunction, customTracksById])
    useEffect(() => {
        if (!clickedBigBedFeature) return
        if (!customTracksById.has(clickedBigBedFeature.trackId)) {
            setClickedBigBedFeature(null)
        }
    }, [clickedBigBedFeature, customTracksById])
    useEffect(() => {
        if (clickedSpliceJunction) {
            const data = customTrackData?.[clickedSpliceJunction.trackId]
            if (data?.mode === 'splice_blocks') {
                setClickedSpliceJunction(null)
            }
        }
        if (hoveredSpliceJunction) {
            const data = customTrackData?.[hoveredSpliceJunction.trackId]
            if (data?.mode === 'splice_blocks') {
                hoveredSpliceRef.current = null
                setHoveredSpliceJunction(null)
            }
        }
        if (clickedBigBedFeature) {
            const data = customTrackData?.[clickedBigBedFeature.trackId]
            if (data?.mode !== 'bigbed_detail') {
                setClickedBigBedFeature(null)
            }
        }
        if (hoveredBigBedFeature) {
            const data = customTrackData?.[hoveredBigBedFeature.trackId]
            if (data?.mode !== 'bigbed_detail') {
                hoveredBigBedRef.current = null
                setHoveredBigBedFeature(null)
            }
        }
    }, [clickedSpliceJunction, hoveredSpliceJunction, clickedBigBedFeature, hoveredBigBedFeature, customTrackData])

    const isGeneHiddenByBiotype = useCallback((gene) => {
        if (!gene || hiddenBiotypeClasses.length === 0) return false
        const cls = classifyBiotype(gene.biotype)
        return Boolean(cls && hiddenBiotypeClasses.includes(cls))
    }, [hiddenBiotypeClasses])

    /* What the track leaves out: classes the reader filtered, and genes they hid
     * one at a time from the location drawer. Every path that draws, labels,
     * hit-tests or counts a gene goes through this, so a hidden gene is hidden
     * from the canvas rather than merely invisible. */
    const hiddenGeneIdSet = useMemo(
        () => new Set((Array.isArray(hiddenGeneIds) ? hiddenGeneIds : []).map(String)),
        [hiddenGeneIds]
    )
    const isGeneHiddenFromTracks = useCallback((gene) => {
        if (!gene) return false
        if (hiddenGeneIdSet.size > 0 && hiddenGeneIdSet.has(String(gene.id))) return true
        return isGeneHiddenByBiotype(gene)
    }, [hiddenGeneIdSet, isGeneHiddenByBiotype])

    const selectedGeneForVisibility = useMemo(() => {
        if (!selectedGene) return null
        if (selectedGene.biotype) return selectedGene
        return genes.find((gene) => gene?.id === selectedGene.id) || selectedGene
    }, [genes, selectedGene])

    const selectedGeneHiddenByBiotype = selectedGeneForVisibility
        ? isGeneHiddenByBiotype(selectedGeneForVisibility)
        : false

    const isSelectedHidden = selectedGene && (
        (selectedGene.strand === '+' && hiddenStrands.forward) ||
        (selectedGene.strand === '-' && hiddenStrands.reverse) ||
        selectedGeneHiddenByBiotype
    )

    const focusLocationRange = useMemo(() => getFocusLocationRange(selectedLocation), [selectedLocation])

    // A location only means anything on its own chromosome: switching region
    // leaves the focus in place but stops drawing it, the same way a hidden
    // strand stops drawing the gene of focus.
    const isLocationFocusVisible = Boolean(
        focusLocationRange && isSameChromToken(focusLocationRange.chrom, selectedChrom)
    )

    /* A panel focuses one thing at a time. Gene and location are separate states
     * because they carry different information and will be joined by other focus
     * kinds, so each new focus clears the others here rather than at every call
     * site that sets one. */
    const focusLocation = useCallback((location) => {
        const range = getFocusLocationRange(location)
        if (!range) {
            setSelectedLocation(null)
            return
        }
        setSelectedGene(null)
        setSelectedLocation(range)
    }, [])

    useEffect(() => {
        if (selectedGene) setSelectedLocation(null)
    }, [selectedGene])
    // ── Unified track tile cache (all signal tracks: BigWig, BAM coverage, etc.) ──────────────
    // Key: `${trackId}|${chrom}|${levelId}|${tileStart}`
    // Value: { start, end, bpPerBin, bins, has_data, error, min, max }
    const trackTileCacheRef = useRef(new Map())
    const trackTileFetchSetRef = useRef(new Set())

    // Per-track chromosome-wide scale: `${trackId}|${chrom}` -> {min, max}
    // Populated from L0 overview fetch on track activation — stable, no EMA drift
    const trackChromScaleRef = useRef({})

    // Discrete feature caches (VCF, BED-fine, splice junctions, long reads)
    // Key: `${trackId}|${chrom}|${lodLevel}|${tileStart}`
    const trackFeatureCacheRef = useRef(new Map())
    const trackFeatureFetchSetRef = useRef(new Set())
    const vcfTileCacheRef = useRef(new Map()) // key -> VCF summary/detail tile (non-adaptive)
    const vcfTileFetchSetRef = useRef(new Set())
    const vcfLevelStateRef = useRef({}) // trackId -> last selected LOD id (for hysteresis)
    const spliceLodStateRef = useRef({}) // trackId -> detail | mid | blocks
    const bigBedLodStateRef = useRef({}) // trackId -> detail | blocks
    const bigBedLayoutStateRef = useRef({}) // trackId -> stable buffered lane layout key/range
    // Zone edges for zoned heatmaps scaled to their file, by path: [t1, t2, t3, t4].
    const [bigWigZoneScales, setBigWigZoneScales] = useState({})
    const bigWigZoneScaleFetchesRef = useRef(new Set())
    const bedDensityScaleRef = useRef({}) // trackId|chrom|level -> { values, n, scale }: every non-zero bin fetched
    const vcfBlockTileCacheRef = useRef(new Map()) // key -> VCF block tile (adaptive mode)
    const vcfBlockTileFetchSetRef = useRef(new Set())
    const vcfOverviewWarmupDoneRef = useRef(new Set())
    const vcfOverviewWarmupActiveRef = useRef(new Set())
    const [customTrackFetchRevision, setCustomTrackFetchRevision] = useState(0)

    // ── Helper: select best LOD level for current bp/px ──────────────────────────────────────
    const getBigWigLevel = useCallback((bpPerPx) => {
        for (const level of TRACK_LOD_LEVELS) {
            if (bpPerPx >= level.minBpPerPx) return level
        }
        return TRACK_LOD_LEVELS[TRACK_LOD_LEVELS.length - 1]
    }, [])

    const makeBigWigTileKey = useCallback((trackId, chrom, levelId, tileStart) => {
        return `${trackId}|${chrom}|${levelId}|${tileStart}`
    }, [])

    const getVcfLevelByBpPerPx = useCallback((bpPerPx, trackId, lodLevels = VCF_LOD_LEVELS) => {
        let idx = lodLevels.length - 1
        for (let i = 0; i < lodLevels.length; i++) {
            if (bpPerPx >= lodLevels[i].minBpPerPx) {
                idx = i
                break
            }
        }
        const raw = lodLevels[idx]
        if (!trackId) return raw

        const prevId = vcfLevelStateRef.current[trackId]
        if (!prevId) {
            vcfLevelStateRef.current[trackId] = raw.id
            return raw
        }
        const prevIdx = Math.max(0, lodLevels.findIndex((l) => l.id === prevId))
        if (Math.abs(prevIdx - idx) > 1) {
            vcfLevelStateRef.current[trackId] = raw.id
            return raw
        }
        if (prevIdx === idx) {
            return raw
        }

        // Hysteresis around adjacent level boundaries to reduce render flicker.
        const threshold = lodLevels[Math.max(prevIdx, idx)].minBpPerPx
        const lower = threshold * 0.85
        const upper = threshold * 1.15
        if (bpPerPx >= lower && bpPerPx <= upper) {
            return lodLevels[prevIdx]
        }

        vcfLevelStateRef.current[trackId] = raw.id
        return raw
    }, [])

    const makeVcfTileKey = useCallback((trackId, chrom, levelId, mode, tileStart, tileEnd, blockWindowBp = 0, blockStrideBp = 0, blockCoverageThreshold = 0.5, blockMode = '') => {
        return `${trackId}|${chrom}|${levelId}|${mode}|${tileStart}|${tileEnd}|w${blockWindowBp}|s${blockStrideBp}|c${blockCoverageThreshold}|bm${blockMode}`
    }, [])

    // ── Block-tile helpers (adaptive VCF mode) ────────────────────────────────────────────────

    const makeVcfBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `vcfblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeVcfAdpDetailKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `adpdet:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const getVcfBlockLevel = useCallback((bpPerPx) => selectVcfBlockLevel(bpPerPx), [])

    const makeSpliceTileKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `sj:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const makeSpliceBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `sjblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeBigBedBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `bbblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeBigBedFeatureTileKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `bbft:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const makeBedDensityTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `bddn:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const getSpliceTileSpan = useCallback((bpPerPx) => {
        if (bpPerPx > SPLICE_FINE_BP_PER_PX) return SPLICE_TILE_SPAN_COARSE
        if (bpPerPx > 30) return 250_000
        return SPLICE_TILE_SPAN_FINE
    }, [])

    const getSpliceBlockLevel = useCallback((bpPerPx) => {
        for (let i = 0; i < SPLICE_BLOCK_LEVELS.length; i++) {
            if (bpPerPx >= SPLICE_BLOCK_LEVELS[i].minBpPerPx) return SPLICE_BLOCK_LEVELS[i]
        }
        return SPLICE_BLOCK_LEVELS[SPLICE_BLOCK_LEVELS.length - 1]
    }, [])

    const getBigBedBlockLevel = useCallback((bpPerPx) => {
        for (let i = 0; i < BIGBED_BLOCK_LEVELS.length; i++) {
            if (bpPerPx >= BIGBED_BLOCK_LEVELS[i].minBpPerPx) return BIGBED_BLOCK_LEVELS[i]
        }
        return BIGBED_BLOCK_LEVELS[BIGBED_BLOCK_LEVELS.length - 1]
    }, [])

    const getBedDensityLevel = useCallback((bpPerPx) => {
        for (let i = 0; i < BED_DENSITY_LEVELS.length; i++) {
            if (bpPerPx >= BED_DENSITY_LEVELS[i].minBpPerPx) return BED_DENSITY_LEVELS[i]
        }
        return BED_DENSITY_LEVELS[BED_DENSITY_LEVELS.length - 1]
    }, [])

    const bigBedDetailEntryBpPerPx = useMemo(
        () => TRANSCRIPT_DETAIL_VIEWSPAN_BP / Math.max(1, viewWidth - LHS_WIDTH),
        [viewWidth]
    )

    const getBigBedLodMode = useCallback((trackId, bpPerPx) => {
        const prev = bigBedLodStateRef.current[trackId]
        let next = bpPerPx <= bigBedDetailEntryBpPerPx ? 'detail' : 'blocks'
        if (prev === 'detail') {
            next = bpPerPx <= (bigBedDetailEntryBpPerPx * 1.2) ? 'detail' : 'blocks'
        } else if (prev === 'blocks') {
            next = bpPerPx < (bigBedDetailEntryBpPerPx * 0.9) ? 'detail' : 'blocks'
        }
        bigBedLodStateRef.current[trackId] = next
        return next
    }, [bigBedDetailEntryBpPerPx])

    const spliceArcEntryBpPerPx = useMemo(
        () => TRANSCRIPT_DETAIL_VIEWSPAN_BP / Math.max(1, viewWidth - LHS_WIDTH),
        [viewWidth]
    )

    const getSpliceLodMode = useCallback((trackId, bpPerPx, renderMode) => {
        if (renderMode === 'density') {
            spliceLodStateRef.current[trackId] = 'blocks'
            return 'blocks'
        }
        const prev = spliceLodStateRef.current[trackId]
        let next = 'mid'
        if (bpPerPx >= spliceArcEntryBpPerPx) next = 'blocks'
        else if (bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX) next = 'detail'
        if (prev === 'detail' && bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX * 1.2) next = 'detail'
        if (prev === 'blocks' && bpPerPx >= spliceArcEntryBpPerPx * 0.85) next = 'blocks'
        if (prev === 'mid') {
            if (bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX * 0.85) next = 'detail'
            else if (bpPerPx >= spliceArcEntryBpPerPx * 1.15) next = 'blocks'
        }
        spliceLodStateRef.current[trackId] = next
        return next
    }, [spliceArcEntryBpPerPx])

    // Project cached block tiles into the current view, with coarse-level fallback.
    const projectVcfBlockTilesToView = useCallback((...args) => projectVcfBlockTiles({ makeVcfBlockTileKey, vcfBlockTileCacheRef }, ...args), [makeVcfBlockTileKey])

    const projectVcfBlockTilesCascadeToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins = 800) => {
        const targetIdx = Math.max(0, VCF_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id))
        const fine = projectVcfBlockTilesToView(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (Number(fine?.tile_coverage || 0) >= 0.92 || targetIdx <= 0) {
            return fine
        }

        let mergedBins = Array.isArray(fine?.density_bins) ? [...fine.density_bins] : Array(Math.max(1, outBins)).fill(0)
        let mergedClasses = Array.isArray(fine?.density_classes)
            ? [...fine.density_classes]
            : Array(mergedBins.length).fill('intergenic')
        let mergedPop = fine?.density_populated instanceof Uint8Array
            ? new Uint8Array(fine.density_populated)
            : new Uint8Array(mergedBins.length)
        let mergedCoverage = Number(fine?.coverage || 0)
        let coarseUsed = false

        for (let i = targetIdx - 1; i >= 0; i--) {
            const coarse = projectVcfBlockTilesToView(trackId, chrom, VCF_BLOCK_LEVELS[i], visStart, visEnd, outBins)
            if (!coarse?.has_data) continue
            const coarseBins = Array.isArray(coarse?.density_bins) ? coarse.density_bins : []
            const coarseClasses = Array.isArray(coarse?.density_classes) ? coarse.density_classes : []
            const coarsePop = coarse?.density_populated instanceof Uint8Array
                ? coarse.density_populated
                : new Uint8Array(mergedBins.length)
            const limit = Math.min(mergedBins.length, coarseBins.length, coarseClasses.length, coarsePop.length)
            if (limit <= 0) continue
            coarseUsed = true
            for (let x = 0; x < limit; x++) {
                if (mergedPop[x]) continue
                if (!coarsePop[x]) continue
                mergedPop[x] = 1
                mergedBins[x] = Number.isFinite(Number(coarseBins[x])) ? Number(coarseBins[x]) : 0
                mergedClasses[x] = coarseClasses[x] === 'genic' ? 'genic' : 'intergenic'
            }
            let popCount = 0
            for (let x = 0; x < mergedPop.length; x++) {
                if (mergedPop[x]) popCount += 1
            }
            mergedCoverage = Math.max(mergedCoverage, popCount / Math.max(1, mergedPop.length))
            if (mergedCoverage >= 0.95) break
        }

        if (!coarseUsed) return fine

        const hasDensity = mergedBins.some((v) => Number(v) > 0)
        return {
            ...fine,
            density_bins: mergedBins,
            density_classes: mergedClasses,
            density_populated: mergedPop,
            has_data: fine.has_data || hasDensity,
            coverage: Math.max(Number(fine?.coverage || 0), mergedCoverage),
            detail: Number(fine?.tile_coverage || 0) < 0.95 ? 'Loading higher-resolution density…' : '',
        }
    }, [projectVcfBlockTilesToView])

    // Project L4 detail tiles (individual variant positions) into the current view.
    const projectVcfAdaptiveDetailLevel = useCallback((trackId, chrom, level, visStart, visEnd) => {
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const variants = []
        let expectedTiles = 0
        let fetchedTiles = 0

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeVcfAdpDetailKey(trackId, chrom, tileStart, tileEnd)
            const tile = vcfBlockTileCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1
            if (!Array.isArray(tile.variants)) continue
            for (const v of tile.variants) {
                const pos = Number(v?.pos)
                if (!Number.isFinite(pos)) continue
                if (pos > visEnd || (Number(v?.end) < visStart)) continue
                variants.push(v)
            }
        }

        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'adp_detail',
            level: level.id,
            start: visStart,
            end: visEnd,
            variants,
            has_data: variants.length > 0,
            tile_coverage: tileCoverage,
        }
    }, [makeVcfAdpDetailKey])

    const projectVcfSummaryLevel = useCallback((...args) => projectVcfSummary({ makeVcfTileKey, vcfTileCacheRef }, ...args), [makeVcfTileKey])

    const projectVcfBlockSpansToView = useCallback((...args) => projectVcfBlockSpans({ makeVcfTileKey, vcfTileCacheRef }, ...args), [makeVcfTileKey])

    const projectVcfDetailLevel = useCallback((trackId, chrom, level, visStart, visEnd) => {
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const variants = []
        const seen = new Set()
        let anyTile = false
        let truncated = false

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            const key = makeVcfTileKey(
                trackId,
                chrom,
                level.id,
                level.mode,
                tileStart,
                tileEnd,
                level.blockWindowBp || 0,
                level.blockStrideBp || 0,
                level.blockCoverageThreshold ?? 0.5,
                level.blockMode || '',
            )
            const tile = vcfTileCacheRef.current.get(key)
            if (!tile || tile.mode !== 'detail' || !Array.isArray(tile.variants)) continue
            anyTile = true
            truncated = truncated || !!tile.truncated
            for (const v of tile.variants) {
                const pos = Number(v.pos)
                if (!Number.isFinite(pos) || pos < visStart || pos > visEnd) continue
                const uniq = `${pos}|${v.ref || ''}|${v.alt || ''}|${v.id || ''}|${v.type || ''}`
                if (seen.has(uniq)) continue
                seen.add(uniq)
                variants.push(v)
            }
        }
        variants.sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
        return {
            mode: 'detail',
            level: level.id,
            variants,
            has_data: anyTile && variants.length > 0,
            coverage: anyTile ? 1 : 0,
            truncated,
        }
    }, [makeVcfTileKey])

    const projectVcfTilesToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins) => {
        const targetIdx = Math.max(0, VCF_LOD_LEVELS.findIndex((l) => l.id === targetLevel.id))
        if (targetLevel.mode === 'detail') {
            const detail = projectVcfDetailLevel(trackId, chrom, targetLevel, visStart, visEnd)
            let summary = null
            for (let i = targetIdx - 1; i >= 0; i--) {
                const candidate = projectVcfSummaryLevel(trackId, chrom, VCF_LOD_LEVELS[i], visStart, visEnd, outBins)
                if (candidate.coverage > 0) {
                    summary = candidate
                    if (candidate.coverage >= 0.85) break
                }
            }
            const showSummaryBackdrop = detail.coverage < 0.95
            return {
                ...detail,
                start: visStart,
                end: visEnd,
                bins: showSummaryBackdrop ? (summary?.bins || []) : [],
                occupancy: showSummaryBackdrop ? (summary?.occupancy || []) : [],
                dominant_effect_bins: showSummaryBackdrop ? (summary?.dominant_effect_bins || []) : [],
                type_counts_bins: showSummaryBackdrop ? (summary?.type_counts_bins || []) : [],
                max_count: showSummaryBackdrop ? (summary?.max_count || 0) : 0,
                coverage: detail.coverage > 0 ? detail.coverage : (summary ? summary.coverage : 0),
                detail_coverage: detail.coverage,
                has_data: detail.has_data || !!summary?.has_data,
                detail: detail.coverage < 0.95
                    ? ((summary && summary.coverage < 0.75) ? 'Loading VCF summary tiles…' : 'Loading VCF detail tiles…')
                    : '',
                truncated: detail.truncated || !!summary?.truncated,
            }
        }

        let best = projectVcfSummaryLevel(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (best.coverage >= 0.9) {
            return { ...best, start: visStart, end: visEnd, detail: '' }
        }
        for (let i = targetIdx - 1; i >= 0; i--) {
            const coarse = projectVcfSummaryLevel(trackId, chrom, VCF_LOD_LEVELS[i], visStart, visEnd, outBins)
            if (!coarse.has_data) continue
            const mergedBins = best.bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.bins[idx]))
            const mergedOcc = best.occupancy.map((v, idx) => (v ? 1 : (coarse.occupancy[idx] ? 1 : 0)))
            const mergedDom = best.dominant_effect_bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.dominant_effect_bins[idx]))
            const mergedType = best.type_counts_bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.type_counts_bins[idx]))
            const mergedMax = mergedBins.length ? Math.max(...mergedBins) : 0
            const mergedCoverage = mergedOcc.reduce((acc, v) => acc + (v ? 1 : 0), 0) / Math.max(1, outBins)
            best = {
                ...best,
                bins: mergedBins,
                occupancy: mergedOcc,
                dominant_effect_bins: mergedDom,
                type_counts_bins: mergedType,
                max_count: mergedMax,
                has_data: mergedMax > 0,
                coverage: mergedCoverage,
                truncated: best.truncated || coarse.truncated,
            }
            if (best.coverage >= 0.9) break
        }
        return {
            ...best,
            start: visStart,
            end: visEnd,
            detail: best.coverage < 0.75 ? 'Loading higher resolution VCF tiles…' : '',
        }
    }, [projectVcfBlockSpansToView, projectVcfDetailLevel, projectVcfSummaryLevel])

    // ── Project tiles at a single level → screen bins ────────────────────────────────────────
    const projectLevelToView = useCallback((trackId, chrom, level, visStart, visEnd, outBins) => {
        const empty = { bins: Array(outBins).fill(null), populated: new Uint8Array(outBins), has_data: false, min: null, max: null, coverage: 0, error: '' }
        if (visEnd <= visStart || outBins <= 0) return empty

        const visSpan = visEnd - visStart
        const out = Array(outBins).fill(null)
        // Track which screen bins were actually mapped from a cached tile (even if value is 0)
        const populated = new Uint8Array(outBins)
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        let anySourceData = false
        let bestError = ''

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const key = makeBigWigTileKey(trackId, chrom, level.id, tileStart)
            const tile = trackTileCacheRef.current.get(key)
            if (!tile) continue
            if (tile.error) bestError = tile.error

            const bins = tile.bins || []
            for (let i = 0; i < bins.length; i++) {
                const gStart = tile.start + i * level.bpPerBin
                const gEnd = gStart + level.bpPerBin
                if (gEnd < visStart || gStart > visEnd) continue

                let x1 = Math.floor(((gStart - visStart) / visSpan) * outBins)
                let x2 = Math.ceil(((gEnd - visStart) / visSpan) * outBins)
                x1 = Math.max(0, Math.min(outBins - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(outBins, x2))
                for (let x = x1; x < x2; x++) {
                    populated[x] = 1
                }

                const v = bins[i]
                if (typeof v !== 'number' || !Number.isFinite(v)) continue
                anySourceData = true
                for (let x = x1; x < x2; x++) {
                    out[x] = out[x] === null ? v : Math.max(out[x], v)
                }
            }
        }

        // Coverage = fraction of screen bins that mapped to actual tile data
        let populatedCount = 0
        for (let i = 0; i < outBins; i++) if (populated[i]) populatedCount++
        const observed = out.filter(v => typeof v === 'number')
        return {
            bins: out,
            populated,
            has_data: anySourceData,
            min: observed.length ? Math.min(...observed) : null,
            max: observed.length ? Math.max(...observed) : null,
            coverage: populatedCount / Math.max(1, outBins),
            error: bestError,
        }
    }, [makeBigWigTileKey])

    // ── Coarse-to-fine projection: draw best available cached level ───────────────────────────
    // Always renders something — never shows blank while waiting for finer tiles
    const projectBigWigTilesToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins) => {
        const empty = { bins: Array(outBins).fill(null), has_data: false, min: null, max: null, coverage: 0, detail: '', error: '' }

        // Try from target level upward (finer → coarser) for best coverage
        const targetIdx = TRACK_LOD_LEVELS.indexOf(targetLevel)

        // First pass: try target level
        const fine = projectLevelToView(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (fine.coverage >= 0.9) {
            // Nearly full coverage from target level — use it, apply stable chrom scale
            const scaleKey = `${trackId}|${chrom}`
            const chromScale = trackChromScaleRef.current[scaleKey]
            const safeMin = chromScale?.min ?? fine.min ?? 0
            const safeMax = chromScale?.max ?? fine.max ?? (safeMin + 1e-6)
            return { ...fine, min: safeMin, max: safeMax, detail: '', coverage: fine.coverage }
        }

        // Fallback: overlay only the immediately coarser level under fine data.
        // Allowing detailed views to fall back all the way to L0/L1 can create
        // long flat phantom blocks from stale overview tiles as screen-bin
        // alignment shifts during pan/zoom.
        let bestResult = fine
        const fallbackLevels = targetIdx > 0
            ? [TRACK_LOD_LEVELS[targetIdx - 1]]
            : []
        for (const coarseLevel of fallbackLevels) {
            const coarse = projectLevelToView(trackId, chrom, coarseLevel, visStart, visEnd, outBins)
            if (!coarse.has_data) continue
            // Merge: use fine where it actually has tile coverage (populated), else coarse
            const merged = fine.bins.map((v, idx) =>
                fine.populated[idx] ? v : coarse.bins[idx]
            )
            const mergedPopulated = new Uint8Array(outBins)
            let mergedPopCount = 0
            for (let idx = 0; idx < outBins; idx++) {
                mergedPopulated[idx] = fine.populated[idx] || coarse.populated[idx] ? 1 : 0
                if (mergedPopulated[idx]) mergedPopCount++
            }
            const mergedObserved = merged.filter(v => typeof v === 'number')
            bestResult = {
                bins: merged,
                populated: mergedPopulated,
                has_data: mergedObserved.length > 0,
                min: mergedObserved.length ? Math.min(...mergedObserved) : null,
                max: mergedObserved.length ? Math.max(...mergedObserved) : null,
                coverage: mergedPopCount / Math.max(1, outBins),
                detail: fine.coverage < 0.5 ? '↓ Loading higher resolution…' : '',
                error: fine.error || coarse.error,
            }
        }

        // Apply stable chromosome-wide scale
        const scaleKey = `${trackId}|${chrom}`
        const chromScale = trackChromScaleRef.current[scaleKey]
        if (chromScale) {
            bestResult = { ...bestResult, min: chromScale.min, max: chromScale.max }
        }
        return bestResult
    }, [projectLevelToView])

    const projectBigWigTrackToCurrentViewport = useCallback((trackId) => {
        const currentChrom = String(selectedChromRef.current || '').trim()
        if (!trackId || !currentChrom) {
            return { bins: [], has_data: false, min: null, max: null, coverage: 0, detail: '', error: '' }
        }
        const currentRange = genomicViewRangeRef.current || {}
        const curStart = Math.max(0, Math.floor(Number(currentRange.start) || 0))
        const curEnd = Math.max(curStart + 1, Math.ceil(Number(currentRange.end) || (curStart + 1)))
        const currentWidth = Math.max(1, Number(viewWidthRef.current) || 1)
        const curBpPerPx = (curEnd - curStart) / Math.max(1, currentWidth - LHS_WIDTH)
        const curLevel = getBigWigLevel(curBpPerPx)
        const curBins = Math.max(80, Math.min(1400, Math.floor(currentWidth - LHS_WIDTH - 44)))
        return projectBigWigTilesToView(trackId, currentChrom, curLevel, curStart, curEnd, curBins)
    }, [getBigWigLevel, projectBigWigTilesToView])

    const projectSpliceTilesToView = useCallback((...args) => projectSpliceTiles({ trackFeatureCacheRef }, ...args), [])

    const projectSpliceBlockTilesToView = useCallback((trackId, chrom, level, visStart, visEnd, innerWidthPx) => {
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        let expectedTiles = 0
        let fetchedTiles = 0
        let bestError = ''

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeSpliceBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
            const tile = trackFeatureCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1
            if (tile?.error && !bestError) bestError = String(tile.error)
            const rows = Array.isArray(tile?.block_spans) ? tile.block_spans : []
            for (const row of rows) {
                const s = Number(row?.start)
                const e = Number(row?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= visStart || s >= visEnd) continue
                spans.push({
                    start: Math.max(visStart, s),
                    end: Math.min(visEnd, e),
                    max_support: Math.max(0, Number(row?.max_support || 0)),
                })
            }
        }

        spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const merged = []
        const viewSpan = Math.max(1, visEnd - visStart)
        const gapBp = SPLICE_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx))
        for (const span of spans) {
            const last = merged[merged.length - 1]
            if (last && span.start <= (last.end + gapBp)) {
                last.end = Math.max(last.end, span.end)
                last.max_support = Math.max(last.max_support, span.max_support)
            } else {
                merged.push({ ...span })
            }
        }

        let coveredBp = 0
        for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'splice_blocks',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            has_data: merged.length > 0,
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            error: bestError,
        }
    }, [makeSpliceBlockTileKey])

    const projectBigBedBlockTilesToView = useCallback((...args) => projectBigBedBlockTiles({ makeBigBedBlockTileKey, trackFeatureCacheRef }, ...args), [makeBigBedBlockTileKey])

    const projectBigBedFeatureTilesToView = useCallback((...args) => projectBigBedFeatureTiles({ bigBedLayoutStateRef, makeBigBedFeatureTileKey, trackFeatureCacheRef }, ...args), [makeBigBedFeatureTileKey])

    // Feature counts per bin for the density view. A tile not yet fetched at this level is
    // filled from a coarser level already in the cache, its counts rescaled to this level's
    // bin size, so zooming in sharpens the histogram rather than blanking it.
    const projectBedDensityTilesToView = useCallback((...args) => projectBedDensityTiles({ bedDensityScaleRef, makeBedDensityTileKey, trackFeatureCacheRef }, ...args), [makeBedDensityTileKey])

    // Re-project a BED/BigBed track against the viewport as it is now, for a tile response
    // that lands after the view has moved on. Returning early instead left the answer in
    // the cache but off screen: the newer pass had skipped those tiles as in flight, so
    // nothing drew them until the reader panned again.
    const projectBedTrackToCurrentViewport = useCallback((track, chrom) => {
        const currentChrom = String(selectedChromRef.current || '').trim()
        if (!track?.id || !currentChrom || currentChrom !== chrom) return null
        const range = genomicViewRangeRef.current || {}
        const curStart = Math.max(0, Math.floor(Number(range.start) || 0))
        const curEnd = Math.max(curStart + 1, Math.ceil(Number(range.end) || (curStart + 1)))
        const innerWidth = Math.max(1, (Number(viewWidthRef.current) || 1) - LHS_WIDTH)
        const curBpPerPx = (curEnd - curStart) / innerWidth
        if (track.renderMode === 'density') {
            return projectBedDensityTilesToView(track.id, currentChrom, getBedDensityLevel(curBpPerPx), curStart, curEnd)
        }
        if (getBigBedLodMode(track.id, curBpPerPx) === 'blocks') {
            return projectBigBedBlockTilesToView(track.id, currentChrom, getBigBedBlockLevel(curBpPerPx), curStart, curEnd, innerWidth)
        }
        return projectBigBedFeatureTilesToView(track.id, currentChrom, curStart, curEnd, innerWidth, { labelled: isGeneModelTrack(track) })
    }, [
        getBedDensityLevel,
        getBigBedBlockLevel,
        getBigBedLodMode,
        projectBedDensityTilesToView,
        projectBigBedBlockTilesToView,
        projectBigBedFeatureTilesToView,
    ])

    // ── LRU eviction — keep ≤2000 tiles per track in memory ──────────────────────────────────
    const evictOldTilesIfNeeded = useCallback(() => {
        const MAX_TILES = 2000
        const cache = trackTileCacheRef.current
        if (cache.size > MAX_TILES * 1.3) {
            // Delete oldest 30% (Maps maintain insertion order)
            const toDelete = Math.floor(cache.size - MAX_TILES)
            let removed = 0
            for (const key of cache.keys()) {
                if (removed >= toDelete) break
                cache.delete(key)
                removed++
            }
        }

        const MAX_VCF_TILES = 2800
        const vcfCache = vcfTileCacheRef.current
        if (vcfCache.size > MAX_VCF_TILES * 1.25) {
            const toDelete = Math.floor(vcfCache.size - MAX_VCF_TILES)
            let removed = 0
            for (const key of vcfCache.keys()) {
                if (removed >= toDelete) break
                vcfCache.delete(key)
                removed++
            }
        }

        const MAX_FEATURE_TILES = 3000
        const featureCache = trackFeatureCacheRef.current
        if (featureCache.size > MAX_FEATURE_TILES * 1.25) {
            const toDelete = Math.floor(featureCache.size - MAX_FEATURE_TILES)
            let removed = 0
            for (const key of featureCache.keys()) {
                if (removed >= toDelete) break
                featureCache.delete(key)
                removed++
            }
        }

        const MAX_VCF_BLOCK_TILES = 2400
        const vcfBlockCache = vcfBlockTileCacheRef.current
        if (vcfBlockCache.size > MAX_VCF_BLOCK_TILES * 1.25) {
            const toDelete = Math.floor(vcfBlockCache.size - MAX_VCF_BLOCK_TILES)
            let removed = 0
            for (const key of vcfBlockCache.keys()) {
                if (removed >= toDelete) break
                vcfBlockCache.delete(key)
                removed++
            }
        }
    }, [])

    // ── Clean up caches when tracks are removed ───────────────────────────────────────────────
    useEffect(() => {
        const keepIds = new Set(customTracks.map((track) => track.id))
        const visibleIds = new Set(customTracks.filter((track) => track.visible !== false).map((track) => track.id))

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            const withoutPrefix = key
                .replace(/^sjblk:/, '')
                .replace(/^sj:/, '')
                .replace(/^bbblk:/, '')
                .replace(/^bbft:/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            // keys are "vcfblk:${trackId}|..." or "adpdet:${trackId}|..."
            const withoutPrefix = key.replace(/^(vcfblk|adpdet):/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) delete trackChromScaleRef.current[key]
        }
        for (const key of Object.keys(vcfLevelStateRef.current)) {
            if (!keepIds.has(key)) delete vcfLevelStateRef.current[key]
        }
        for (const key of Object.keys(spliceLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete spliceLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLayoutStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLayoutStateRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
    }, [customTracks])

    useEffect(() => {
        bigBedLayoutStateRef.current = {}
    }, [selectedChrom])

    const formatSignalValue = useCallback((value) => {
        return formatSignalValueForTrack(value)
    }, [])

    const formatSignalValueExact = useCallback((value) => {
        return formatSignalValueForTooltip(value)
    }, [])

    useEffect(() => {
        transcriptCacheRef.current = transcriptCache
    }, [transcriptCache])

    const touchTranscriptCacheEntry = useCallback((geneId) => {
        const key = String(geneId || '').trim()
        if (!key) return
        transcriptCacheTouchCounterRef.current += 1
        transcriptCacheUsageRef.current.set(key, transcriptCacheTouchCounterRef.current)
    }, [])

    const pruneTranscriptCacheIfNeeded = useCallback((nextCache) => {
        const keys = Object.keys(nextCache || {})
        if (keys.length <= MAX_TRANSCRIPT_CACHE_GENES) return nextCache

        const protectedIds = protectedTranscriptCacheIdsRef.current || new Set()
        const evictionCandidates = keys
            .filter((key) => !protectedIds.has(key))
            .sort((a, b) => {
                const aTouch = Number(transcriptCacheUsageRef.current.get(a) || 0)
                const bTouch = Number(transcriptCacheUsageRef.current.get(b) || 0)
                return aTouch - bTouch
            })

        const overflow = Math.max(0, keys.length - MAX_TRANSCRIPT_CACHE_GENES)
        if (overflow <= 0 || evictionCandidates.length === 0) return nextCache

        const pruned = { ...nextCache }
        for (const geneId of evictionCandidates.slice(0, overflow)) {
            delete pruned[geneId]
            transcriptCacheUsageRef.current.delete(geneId)
        }
        return pruned
    }, [])

    useEffect(() => {
        transcriptRequestGenerationRef.current += 1
        transcriptCacheRef.current = {}
        transcriptCacheUsageRef.current.clear()
        fetchingTranscriptIdsRef.current.clear()
        setTranscriptCache({})
    }, [genome, dataEpoch, selectedChrom])

    useEffect(() => {
        return () => {
            if (transcriptPopupDismissTimerRef.current) {
                clearTimeout(transcriptPopupDismissTimerRef.current)
                transcriptPopupDismissTimerRef.current = null
            }
        }
    }, [])

    // ============ Tile Cache Helpers ============

    const preloadChromGenes = useCallback((chrom) => {
        const chromName = String(chrom || '').trim()
        if (!isActive || !chromName) return null
        if (geneTilesBlockedRef.current) return null

        const cacheKey = getChromGeneCacheKey(genome, chromName)
        const cached = chromGeneCacheRef.current.get(cacheKey)
        if (Array.isArray(cached)) return cached
        if (fetchingChromGenesRef.current.has(cacheKey)) return null

        const generation = chromGeneGenerationRef.current
        const requestGeneration = activeGeneRequestGenerationRef.current
        const requestToken = Symbol(cacheKey)
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingChromGenesRef.current.set(cacheKey, requestToken)
        const params = new URLSearchParams({
            genome,
            chrom: chromName,
        })

        fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, { signal: controller.signal })
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!Array.isArray(data)) return
                if (generation !== chromGeneGenerationRef.current) return
                if (requestGeneration !== activeGeneRequestGenerationRef.current) return
                buildGeneIntervalIndex(data)
                chromGeneCacheRef.current.set(cacheKey, data)
                const tilePrefix = `${chromName}:`
                for (const tileKey of tileCacheRef.current.keys()) {
                    if (tileKey.startsWith(tilePrefix)) tileCacheRef.current.delete(tileKey)
                }
                if (getChromGeneCacheKey(genome, selectedChromRef.current) !== cacheKey) return
                const range = genomicViewRangeRef.current || {}
                const visible = collectGenesFromList(data, range.start, range.end)
                setGenes((prev) => sameGeneRange(prev, visible) ? prev : visible)
                setHasInitialViewportData(true)
            })
            .catch((e) => {
                if (e?.name !== 'AbortError') {
                    console.warn(`[GenomeBrowser:${genome}] Failed to preload genes for ${chromName}`, e)
                }
            })
            .finally(() => {
                identityRequestControllersRef.current.delete(controller)
                if (fetchingChromGenesRef.current.get(cacheKey) === requestToken) {
                    fetchingChromGenesRef.current.delete(cacheKey)
                }
            })

        return null
    }, [genome, isActive])

    // Collect genes from cache over a genomic range, with optional tile padding.
    const collectCachedGenesInRange = useCallback((chrom, start, end, tilePad = 1) => {
        if (!chrom) {
            return { genes: [], coverage: 0, expectedTiles: 0, fetchedTiles: 0 }
        }
        const chromGenes = chromGeneCacheRef.current.get(getChromGeneCacheKey(genome, chrom))
        if (Array.isArray(chromGenes)) {
            return {
                genes: collectGenesFromList(chromGenes, start, end),
                coverage: 1,
                expectedTiles: 1,
                fetchedTiles: 1,
                source: 'chrom',
            }
        }

        const cache = tileCacheRef.current
        const rangeStart = Math.max(0, Math.floor(start))
        const rangeEnd = Math.max(rangeStart + 1, Math.ceil(end))
        const coreFirstTile = snapToTile(rangeStart)
        const coreLastTile = snapToTile(Math.max(rangeStart, rangeEnd - 1))
        let expectedTiles = 0
        let fetchedTiles = 0
        for (let t = coreFirstTile; t <= coreLastTile; t += TILE_SIZE) {
            expectedTiles += 1
            if (cache.has(getTileKey(chrom, t))) fetchedTiles += 1
        }

        const firstTile = snapToTile(Math.max(0, rangeStart - tilePad * TILE_SIZE))
        const lastTile = snapToTile(rangeEnd + tilePad * TILE_SIZE)
        const collected = []
        const seen = new Set()
        for (let t = firstTile; t <= lastTile; t += TILE_SIZE) {
            const key = getTileKey(chrom, t)
            const tileGenes = cache.get(key)
            if (!tileGenes) continue
            for (const g of tileGenes) {
                if (!seen.has(g.id) && g.end >= rangeStart && g.start <= rangeEnd) {
                    seen.add(g.id)
                    collected.push(g)
                }
            }
        }

        return {
            genes: collected,
            coverage: expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 1,
            expectedTiles,
            fetchedTiles,
            source: 'tiles',
        }
    }, [genome])

    const evictOldGeneTilesIfNeeded = useCallback(() => {
        const cache = tileCacheRef.current
        if (cache.size <= MAX_GENE_TILE_CACHE_TILES) return
        const overflow = cache.size - MAX_GENE_TILE_CACHE_TILES
        let removed = 0
        for (const key of cache.keys()) {
            if (removed >= overflow) break
            cache.delete(key)
            removed += 1
        }
    }, [])

    // Collect all genes from cache that overlap the current view
    const updateVisibleGenes = useCallback((chrom, start, end) => {
        const { genes: visible, fetchedTiles } = collectCachedGenesInRange(chrom, start, end, 1)
        setGenes((prev) => {
            if (!(fetchedTiles > 0 || visible.length > 0 || prev.length === 0)) return prev
            return sameGeneRange(prev, visible) ? prev : visible
        })
        if (fetchedTiles > 0) {
            setHasInitialViewportData(true)
        }
    }, [collectCachedGenesInRange])

    // Fetch a single tile and store in cache
    const fetchTile = useCallback(async (chrom, tileStart, currentChrom, currentStart, currentEnd) => {
        if (!isActive) return
        if (geneTilesBlockedRef.current) return
        const key = getTileKey(chrom, tileStart)
        if (tileCacheRef.current.has(key) || fetchingTilesRef.current.has(key)) return
        const requestToken = Symbol(key)
        const requestGeneration = activeGeneRequestGenerationRef.current
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingTilesRef.current.set(key, requestToken)
        const tileEnd = tileStart + TILE_SIZE
        try {
            const params = new URLSearchParams({
                genome,
                chrom,
                start: String(tileStart),
                end: String(tileEnd),
            })
            const res = await fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, { signal: controller.signal })
            if (res.ok) {
                const data = await res.json()
                if (requestGeneration !== activeGeneRequestGenerationRef.current) return
                if (chromGeneCacheRef.current.has(getChromGeneCacheKey(genome, chrom))) return
                tileCacheRef.current.set(key, data)
                evictOldGeneTilesIfNeeded()
                if (chrom === currentChrom && chrom === selectedChromRef.current) {
                    updateVisibleGenes(chrom, currentStart, currentEnd)
                }
            } else {
                console.error(`[GenomeBrowser:${genome}] Tile ${key} fetch failed: ${res.status}`)
            }
        } catch (e) {
            if (e?.name !== 'AbortError') {
                console.error(`[GenomeBrowser:${genome}] Failed to fetch tile:`, e)
            }
        } finally {
            identityRequestControllersRef.current.delete(controller)
            if (fetchingTilesRef.current.get(key) === requestToken) {
                fetchingTilesRef.current.delete(key)
            }
        }
    }, [evictOldGeneTilesIfNeeded, genome, isActive, updateVisibleGenes])

    // ============ Data Fetching ============

    const regionsRetryTimerRef = useRef(null)
    const geneNavigationRef = useRef(navigateToGene)
    geneNavigationRef.current = navigateToGene

    // Fetch available regions on mount
    useEffect(() => {
        if (!isActive) return
        const controller = new AbortController()
        const fetchRegions = async () => {
            const shouldShowLoading = regions.length === 0 || !selectedChrom
            if (shouldShowLoading) setLoadingRegions(true)
            try {
                const params = new URLSearchParams({ genome })
                const res = await fetch(`${API_BASE}/api/browse/regions?${params.toString()}`, { signal: controller.signal })
                if (res.ok) {
                    const data = await res.json()
                    if (controller.signal.aborted) return
                    setRegions(data)
                    // The whole assembly's size, for the two size achievements. Only
                    // when every region came from the FASTA (and so starts at 1):
                    // without one the extents are the genes', which would make any
                    // genome look small.
                    if (Array.isArray(data) && data.length && data.every((region) => Number(region?.start) === 1)) {
                        const totalBp = data.reduce((sum, region) => sum + Math.max(0, Number(region?.end) || 0), 0)
                        if (totalBp > 0 && totalBp < 5e6) trackAchievement('browser.tinyGenome')
                        else if (totalBp > 5e9) trackAchievement('browser.hugeGenome')
                    }
                    // Auto-select informative default locus for initial view —
                    // unless the panel was opened on a region someone asked for,
                    // which is about to frame itself and must not be overruled.
                    if (data.length > 0 && !selectedChrom && !pendingLocationNavigateRef.current && !geneNavigationRef.current) {
                        let initialized = false

                        // Back where the reader was before the page reloaded: the same
                        // window, and the same gene or location in focus. Exactly that
                        // window, not one re-framed around the focus, since the reader
                        // may have moved off it.
                        const resume = resumeViewRef.current
                        resumeViewRef.current = null
                        consumeRestoredSessionState(sessionPanelKey)
                        const resumeRegion = resume
                            ? data.find((region) => isSameChromToken(region.chrom, resume.chrom)) || null
                            : null
                        if (resumeRegion) {
                            const regionEnd = Math.max(2, Number(resumeRegion.end) || 0)
                            const span = Math.max(1, Math.min(regionEnd - 1, Number(resume.end) - Number(resume.start)))
                            const start = Math.min(Math.max(1, Number(resume.start)), Math.max(1, regionEnd - span))
                            setSelectedChrom(resumeRegion.chrom)
                            setChromLength(resumeRegion.end)
                            setViewStart(start)
                            setViewEnd(start + span)
                            const gene = resume.gene
                            const location = getFocusLocationRange(resume.location)
                            if (gene?.id && isSameChromToken(gene.chrom, resumeRegion.chrom)
                                && Number.isFinite(Number(gene.start)) && Number.isFinite(Number(gene.end))) {
                                setSelectedGene({ ...gene, chrom: resumeRegion.chrom })
                            } else if (location && isSameChromToken(location.chrom, resumeRegion.chrom)) {
                                setSelectedLocation({ ...location, chrom: resumeRegion.chrom })
                            }
                            initialized = true
                        }

                        if (!initialized) {
                            try {
                                const prefRes = await fetch(`${API_BASE}/api/browse/default_locus?${params.toString()}`, { signal: controller.signal })
                                if (prefRes.ok) {
                                    const pref = await prefRes.json()
                                    if (controller.signal.aborted) return
                                    if (pref?.chrom && !geneNavigationRef.current) {
                                        setSelectedChrom(pref.chrom)
                                        setChromLength(pref.chrom_length || pref.end || 0)
                                        setViewStart(pref.start)
                                        setViewEnd(pref.end)
                                        initialized = true
                                    }
                                }
                            } catch (e) {
                                if (e?.name !== 'AbortError') {
                                    console.warn(`[GenomeBrowser:${genome}] Default locus fetch failed, using fallback.`, e)
                                }
                            }
                        }

                        if (!initialized && !geneNavigationRef.current) {
                            const candidates = data.filter((r) => r.gene_count > 0)
                            const best = (candidates.length ? candidates : data)
                                .slice()
                                .sort((a, b) => (b.length - a.length) || (b.gene_count - a.gene_count))[0]
                            const span = Math.min(500000, Math.max(200000, best.length || 500000))
                            const center = (best.start + best.end) / 2
                            const start = Math.max(best.start, Math.floor(center - span / 2))
                            const end = Math.min(best.end, Math.ceil(center + span / 2))
                            setSelectedChrom(best.chrom)
                            setChromLength(best.end)
                            setViewStart(start)
                            setViewEnd(Math.max(start + 1, end))
                        }
                    }
                } else if (res.status === INDEX_BUILDING_STATUS) {
                    // Only reachable for a genome with no FASTA to draw regions
                    // from — everything else is served off the assembly while its
                    // index builds. Retry rather than settling on an empty view.
                    if (!controller.signal.aborted) {
                        regionsRetryTimerRef.current = window.setTimeout(fetchRegions, 2000)
                    }
                } else {
                    console.error(`[GenomeBrowser:${genome}] Regions fetch failed: ${res.status}`)
                }
            } catch (e) {
                if (e?.name !== 'AbortError') {
                    console.error(`[GenomeBrowser:${genome}] Failed to fetch regions:`, e)
                }
            }
            if (shouldShowLoading && !controller.signal.aborted) setLoadingRegions(false)
        }
        fetchRegions()
        return () => {
            controller.abort()
            if (regionsRetryTimerRef.current) {
                window.clearTimeout(regionsRetryTimerRef.current)
                regionsRetryTimerRef.current = null
            }
        }
    }, [genome, isActive, dataEpoch])

    // Tile management: fetch tiles for current view + prefetch neighbours
    useEffect(() => {
        if (!isActive) return
        if (!selectedChrom) {
            return
        }

        const chrom = selectedChrom
        const { start: gStart, end: gEnd } = genomicViewRange
        const viewGeneSpan = Math.max(1, gEnd - gStart)
        const chromGeneCacheKey = getChromGeneCacheKey(genome, chrom)
        const cachedChromGenes = preloadChromGenes(chrom)

        // Update visible genes from cache immediately (instant if already cached)
        updateVisibleGenes(chrom, gStart, gEnd)
        if (Array.isArray(cachedChromGenes)) {
            return
        }
        if (viewGeneSpan >= GENE_CHROM_CACHE_ENTER_SPAN && fetchingChromGenesRef.current.has(chromGeneCacheKey)) {
            return
        }

        // Fetch buffered layout tiles so row packing can stay stable while panning.
        const layoutBuffer = clamp(viewGeneSpan * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const bufferedStart = Math.max(0, gStart - layoutBuffer)
        const bufferedEnd = gEnd + layoutBuffer
        const coreFirstTile = snapToTile(gStart)
        const coreLastTile = snapToTile(Math.max(gStart, gEnd - 1))
        const firstTile = snapToTile(bufferedStart)
        const lastTile = snapToTile(Math.max(bufferedStart, bufferedEnd - 1))
        const viewCenter = (gStart + gEnd) / 2
        const coreTiles = []
        const bufferTiles = []
        for (let t = firstTile; t <= lastTile; t += TILE_SIZE) {
            if (t >= coreFirstTile && t <= coreLastTile) coreTiles.push(t)
            else bufferTiles.push(t)
        }
        coreTiles.sort((a, b) => Math.abs((a + TILE_SIZE / 2) - viewCenter) - Math.abs((b + TILE_SIZE / 2) - viewCenter))
        for (const t of [...coreTiles, ...bufferTiles]) {
            fetchTile(chrom, t, chrom, gStart, gEnd)
        }

    }, [isActive, genome, selectedChrom, genomicViewRange, dataEpoch, fetchTile, updateVisibleGenes, preloadChromGenes])

    // Sequence buffer: fetch a wider region and serve pans from cache
    const seqBufferRef = useRef({ chrom: '', start: 0, end: 0, sequence: '' })
    const fetchingSeqRef = useRef(false)
    const pendingSeqTargetRef = useRef(null) // { genome, chrom, visStart, visEnd }
    const seqFetchEpochRef = useRef(0)

    const serveSequenceFromBuffer = useCallback((chrom, visStart, visEnd) => {
        const buf = seqBufferRef.current
        if (!(buf.chrom === chrom && buf.start <= visStart - 1 && buf.end >= visEnd && buf.sequence)) {
            return false
        }
        const offset = visStart - 1 - buf.start
        const len = Math.max(1, visEnd - visStart)
        setSequence(buf.sequence.slice(offset, offset + len))
        setSeqRange({ start: visStart, end: visEnd })
        return true
    }, [])

    useEffect(() => {
        if (!isActive) return
        const epoch = ++seqFetchEpochRef.current
        const viewSpan = viewEnd - viewStart
        if (viewSpan > 1000 || !selectedChrom) {
            pendingSeqTargetRef.current = null
            setSequence(null)
            setSeqRange(null)
            return
        }

        const { start: gStart, end: gEnd } = genomicViewRange
        const visStart = Math.max(0, Math.floor(gStart))
        const visEnd = Math.ceil(gEnd)
        pendingSeqTargetRef.current = { genome, chrom: selectedChrom, visStart, visEnd }

        // Fast path: already covered by buffer.
        if (serveSequenceFromBuffer(selectedChrom, visStart, visEnd)) {
            return
        }

        // Buffer miss — chase the latest viewport target. If panning continues while
        // a request is in-flight, we fetch the newest target immediately afterwards.
        const fetchSeq = async () => {
            if (fetchingSeqRef.current) return
            fetchingSeqRef.current = true
            try {
                while (true) {
                    if (epoch !== seqFetchEpochRef.current) return
                    const target = pendingSeqTargetRef.current
                    if (!target) return

                    if (serveSequenceFromBuffer(target.chrom, target.visStart, target.visEnd)) {
                        const latest = pendingSeqTargetRef.current
                        if (
                            latest
                            && latest.genome === target.genome
                            && latest.chrom === target.chrom
                            && latest.visStart === target.visStart
                            && latest.visEnd === target.visEnd
                        ) {
                            pendingSeqTargetRef.current = null
                        }
                        continue
                    }

                    const gSpan = Math.max(1, target.visEnd - target.visStart)
                    const bufferSize = Math.min(Math.max(gSpan * 10, 2000), 50000)
                    const center = (target.visStart + target.visEnd) / 2
                    const fetchStart = Math.max(0, Math.floor(center - bufferSize / 2))
                    const fetchEnd = Math.ceil(center + bufferSize / 2)
                    const res = await fetch(
                        `${API_BASE}/api/browse/sequence?genome=${target.genome}&chrom=${target.chrom}&start=${fetchStart}&end=${fetchEnd}`
                    )
                    if (!res.ok) return
                    const data = await res.json()
                    seqBufferRef.current = {
                        chrom: target.chrom,
                        start: data.start,
                        end: data.end,
                        sequence: data.sequence,
                    }
                }
            } catch (e) {
                console.error('Failed to fetch sequence:', e)
            } finally {
                fetchingSeqRef.current = false
            }
        }

        const timer = setTimeout(fetchSeq, 10)
        return () => clearTimeout(timer)
    }, [genome, isActive, selectedChrom, viewEnd, viewStart, genomicViewRange, serveSequenceFromBuffer])

    useEffect(() => {
        if (!isActive || !selectedChrom || !Number(chromLength || 0)) return
        const l0 = VCF_BLOCK_LEVELS[0]
        const chromEnd = Number(chromLength || 0)
        const vcfTracks = customTracks.filter((track) => (
            track?.path
            && track.visible
            && (track.type || 'bigwig') === 'vcf'
            && isVcfAdaptiveLikeMode(normalizeVcfDisplayMode(track.renderMode))
        ))
        if (vcfTracks.length === 0) return

        let cancelled = false
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const hasForegroundVcfFetch = () => {
            for (const key of vcfBlockTileFetchSetRef.current.values()) {
                const token = String(key || '')
                if (token.startsWith('adpdet:')) return true
                if (token.startsWith('vcfblk:') && !token.includes('|L0|')) return true
            }
            return false
        }

        const warmTrack = async (track) => {
            const warmupKey = buildVcfOverviewWarmupKey({
                trackId: track.id,
                path: track.path,
                chrom: selectedChrom,
                chromLength: chromEnd,
                level: l0,
            })
            if (vcfOverviewWarmupDoneRef.current.has(warmupKey)) return
            if (vcfOverviewWarmupActiveRef.current.has(warmupKey)) return
            vcfOverviewWarmupActiveRef.current.add(warmupKey)
            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))

            try {
                const tiles = buildVcfOverviewWarmupTiles({ chromLength: chromEnd, level: l0 })
                    .map((tileSpec) => {
                        const tileStart = tileSpec.tileStart
                        const tileEnd = tileSpec.tileEnd
                        const key = makeVcfBlockTileKey(track.id, selectedChrom, l0.id, tileStart, tileEnd)
                        return { ...tileSpec, key }
                    })
                    .filter((tile) => !vcfBlockTileCacheRef.current.has(tile.key))

                if (tiles.length === 0) {
                    vcfOverviewWarmupDoneRef.current.add(warmupKey)
                    return
                }

                for (const tile of tiles) {
                    if (cancelled) return
                    while (!cancelled && hasForegroundVcfFetch()) {
                        await delay(80)
                    }
                    if (cancelled) return
                    if (vcfBlockTileCacheRef.current.has(tile.key)) continue
                    if (vcfBlockTileFetchSetRef.current.has(tile.key)) continue

                    vcfBlockTileFetchSetRef.current.add(tile.key)
                    try {
                        const response = await fetch(`${API_BASE}/api/browse/vcf/block_tiles`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                path: track.path,
                                chrom: selectedChrom,
                                genome,
                                coverage_threshold: 0.25,
                                tiles: [{
                                    start: tile.start,
                                    end: tile.end,
                                    level_id: tile.level_id,
                                    block_bp: tile.block_bp,
                                    window_bp: tile.window_bp,
                                }],
                            }),
                        })
                        const payload = response.ok
                            ? await response.json()
                            : await response.json().then((e) => { throw new Error(e?.detail || `HTTP ${response.status}`) })
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const returnedTile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(returnedTile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(returnedTile.end) || 1))
                            const levelId = String(returnedTile.level_id || l0.id)
                            const selectedKey = makeVcfBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, returnedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, returnedTile)
                            }
                        }
                        setCustomTrackFetchRevision((v) => v + 1)
                    } catch (e) {
                        const errorMessage = getFetchErrorMessage(e)
                        if (!isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackData((prev) => ({
                                ...prev,
                                [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                            }))
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                            return
                        }
                    } finally {
                        vcfBlockTileFetchSetRef.current.delete(tile.key)
                    }
                    await delay(20)
                }

                vcfOverviewWarmupDoneRef.current.add(warmupKey)
                setCustomTrackFetchRevision((v) => v + 1)
            } finally {
                vcfOverviewWarmupActiveRef.current.delete(warmupKey)
            }
        }

        for (const track of vcfTracks) {
            warmTrack(track)
        }

        return () => {
            cancelled = true
        }
    }, [
        chromLength,
        customTracks,
        genome,
        isActive,
        makeVcfBlockTileKey,
        selectedChrom,
    ])

    // Zone edges for zoned heatmaps scaled to their file, fetched once per file. Until they
    // arrive the fixed zones are drawn, so the track is never blank while it waits.
    useEffect(() => {
        for (const track of customTracks) {
            if (!track?.path || (track.type || 'bigwig') !== 'bigwig') continue
            if (normalizeBigWigDisplayMode(track.renderMode, track?.bigwigSettings?.data_type) !== 'zoned_heatmap') continue
            const zoneSettings = normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings)
            const needsOwnPeaks = zoneSettings.zone_scale === 'file'
                || (zoneSettings.zone_scale === 'files' && !(Array.isArray(zoneSettings.shared_zones) && zoneSettings.shared_zones.length === 4))
            if (!needsOwnPeaks) continue
            const path = String(track.path)
            if (bigWigZoneScales[path] || bigWigZoneScaleFetchesRef.current.has(path)) continue
            bigWigZoneScaleFetchesRef.current.add(path)
            fetch(`${API_BASE}/api/browse/bigwig/zone_scale?path=${encodeURIComponent(path)}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((data) => {
                    const thresholds = Array.isArray(data?.thresholds) ? data.thresholds.map(Number) : []
                    if (thresholds.length === 4) {
                        setBigWigZoneScales((prev) => ({ ...prev, [path]: thresholds }))
                    }
                })
                .catch(() => {})
                .finally(() => bigWigZoneScaleFetchesRef.current.delete(path))
        }
    }, [customTracks, bigWigZoneScales])

    // ── Unified custom track LOD fetch engine ─────────────────────────────────────────────────
    // Runs on every viewport change. Immediately projects from cache (no debounce on rendering),
    // then issues new fetch requests with a 50ms debounce to avoid request storms during panning.
    // IMPORTANT: In-flight responses are NEVER cancelled — tiles are viewport-independent.
    //            Only the debounce timer is cancelled on viewport changes.
    const fetchEpochRef = useRef(0)
    const vcfViewportIntentRef = useRef({ center: 0, span: 0, changedAt: 0, intent: 'settled' })
    useEffect((...args) => runCustomTrackFetchEngine({
        bedDensityScaleRef,
        chromLength,
        customTracks,
        evictOldTilesIfNeeded,
        fetchEpochRef,
        genome,
        genomicViewRange,
        getBedDensityLevel,
        getBigBedBlockLevel,
        getBigBedLodMode,
        getBigWigLevel,
        getSpliceBlockLevel,
        getSpliceLodMode,
        getSpliceTileSpan,
        getVcfBlockLevel,
        getVcfLevelByBpPerPx,
        isActive,
        makeBedDensityTileKey,
        makeBigBedBlockTileKey,
        makeBigBedFeatureTileKey,
        makeBigWigTileKey,
        makeSpliceBlockTileKey,
        makeSpliceTileKey,
        makeVcfAdpDetailKey,
        makeVcfBlockTileKey,
        makeVcfTileKey,
        projectBedDensityTilesToView,
        projectBedTrackToCurrentViewport,
        projectBigBedBlockTilesToView,
        projectBigBedFeatureTilesToView,
        projectBigWigTilesToView,
        projectBigWigTrackToCurrentViewport,
        projectSpliceBlockTilesToView,
        projectSpliceTilesToView,
        projectVcfAdaptiveDetailLevel,
        projectVcfBlockTilesCascadeToView,
        projectVcfTilesToView,
        selectedChrom,
        setCustomTrackData,
        setCustomTrackFetchRevision,
        setCustomTrackLoading,
        trackChromScaleRef,
        trackFeatureCacheRef,
        trackFeatureFetchSetRef,
        trackTileCacheRef,
        trackTileFetchSetRef,
        vcfBlockTileCacheRef,
        vcfBlockTileFetchSetRef,
        vcfOverviewWarmupDoneRef,
        vcfTileCacheRef,
        vcfTileFetchSetRef,
        vcfViewportIntentRef,
        viewWidth,
    }, ...args), [
        customTracks,
        customTrackFetchRevision,
        chromLength,
        isActive,
        selectedChrom,
        genome,
        genomicViewRange,
        viewWidth,
        getBigWigLevel,
        getVcfLevelByBpPerPx,
        getVcfBlockLevel,
        getSpliceBlockLevel,
        getSpliceLodMode,
        getSpliceTileSpan,
        getBigBedBlockLevel,
        getBigBedLodMode,
        getBedDensityLevel,
        makeBigWigTileKey,
        makeVcfTileKey,
        makeVcfBlockTileKey,
        makeVcfAdpDetailKey,
        makeSpliceTileKey,
        makeSpliceBlockTileKey,
        makeBigBedBlockTileKey,
        makeBigBedFeatureTileKey,
        makeBedDensityTileKey,
        projectBigWigTilesToView,
        projectBigWigTrackToCurrentViewport,
        projectSpliceTilesToView,
        projectSpliceBlockTilesToView,
        projectBigBedBlockTilesToView,
        projectBigBedFeatureTilesToView,
        projectBedDensityTilesToView,
        projectBedTrackToCurrentViewport,
        projectVcfTilesToView,
        projectVcfBlockTilesCascadeToView,
        projectVcfAdaptiveDetailLevel,
        evictOldTilesIfNeeded,
    ])

    const handleCustomTrackFilePicked = useCallback((path) => {
        setPendingCustomTrackPath(path)
        setCustomTrackLabelInput('Custom track')
        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
        setIsCustomTrackLabelModalOpen(true)
    }, [])

    const handleConfirmAddCustomTrack = useCallback(() => {
        if (!pendingCustomTrackPath) return
        const trimmedLabel = customTrackLabelInput.trim()
        if (!trimmedLabel) return
        const bigWigSettings = normalizeBigWigSettings({ data_type: 'rna_seq' })
        const id = `ct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        setCustomTracks((prev) => [...prev, {
            id,
            path: pendingCustomTrackPath,
            label: trimmedLabel,
            visible: true,
            type: 'bigwig',
            renderMode: normalizeBigWigDisplayMode(customTrackRenderModeInput, bigWigSettings.data_type),
            bigwigSettings: bigWigSettings,
        }])
        setIsCustomTrackLabelModalOpen(false)
        setPendingCustomTrackPath('')
        setCustomTrackLabelInput('Custom track')
        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
    }, [pendingCustomTrackPath, customTrackLabelInput, customTrackRenderModeInput])

    // Fetch transcripts for expanded genes
    const fetchTranscripts = useCallback(async (geneId) => {
        if (transcriptCacheRef.current[geneId]) {
            touchTranscriptCacheEntry(geneId)
            return
        }
        if (fetchingTranscriptIdsRef.current.has(geneId)) return
        const requestToken = Symbol(String(geneId))
        const requestGeneration = transcriptRequestGenerationRef.current
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingTranscriptIdsRef.current.set(geneId, requestToken)
        try {
            const params = new URLSearchParams({ genome, gene_id: String(geneId) })
            const res = await fetch(`${API_BASE}/api/browse/transcripts?${params.toString()}`, { signal: controller.signal })
            if (res.ok) {
                const data = await res.json()
                if (requestGeneration !== transcriptRequestGenerationRef.current) return
                setTranscriptCache(prev => {
                    if (prev[geneId]) {
                        touchTranscriptCacheEntry(geneId)
                        return prev
                    }
                    touchTranscriptCacheEntry(geneId)
                    const next = pruneTranscriptCacheIfNeeded({ ...prev, [geneId]: data })
                    transcriptCacheRef.current = next
                    return next
                })
            }
        } catch (e) {
            if (e?.name !== 'AbortError') console.error('Failed to fetch transcripts:', e)
        } finally {
            identityRequestControllersRef.current.delete(controller)
            if (fetchingTranscriptIdsRef.current.get(geneId) === requestToken) {
                fetchingTranscriptIdsRef.current.delete(geneId)
            }
        }
    }, [genome, pruneTranscriptCacheIfNeeded, touchTranscriptCacheEntry])

    const requestTranscriptPillFocus = useCallback((geneId, options = {}) => {
        if (!geneId) return
        pendingTranscriptPillFocusRef.current = {
            geneId,
            waitForTranscripts: Boolean(options.waitForTranscripts),
            limit: Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : null,
            preferBottomVisible: Boolean(options.preferBottomVisible),
            preserveHorizontalViewport: Boolean(options.preserveHorizontalViewport),
            skipVerticalAlign: Boolean(options.skipVerticalAlign),
            animated: false,
        }
    }, [])

    // Notify parent when the location of focus changes
    const onLocationSelectRef = useRef(onLocationSelect)
    onLocationSelectRef.current = onLocationSelect
    useEffect(() => {
        onLocationSelectRef.current?.(focusLocationRange)
    }, [focusLocationRange])

    // Notify parent when selected gene changes
    const lastSelectedGeneSignatureRef = useRef('')
    useEffect(() => {
        if (!onGeneSelectRef.current) return
        const signature = selectedGene ? [
            String(selectedGene.id || '').trim(),
            String(selectedGene.name || '').trim(),
            String(selectedGene.chrom || '').trim(),
            Number.isFinite(Number(selectedGene.start)) ? Number(selectedGene.start) : '',
            Number.isFinite(Number(selectedGene.end)) ? Number(selectedGene.end) : '',
            String(selectedGene.strand || '').trim(),
        ].join('|') : ''
        if (signature === lastSelectedGeneSignatureRef.current) return
        lastSelectedGeneSignatureRef.current = signature
        onGeneSelectRef.current(selectedGene)
    }, [selectedGene])

    // The drawer needs the focused gene's transcripts whatever the zoom level,
    // but the viewport prefetch below only runs once transcript detail is in
    // range. Ask for them directly so focusing from a wide view still fills it.
    //
    // Keyed on the cache as well as the gene, so this heals itself. The cache is
    // emptied wholesale whenever the genome, chromosome or reload epoch changes;
    // watching the gene id alone meant a wipe that left the same gene focused
    // never re-fetched, and the drawer listed no transcripts from then on.
    useEffect(() => {
        if (!selectedGene?.id) return
        if (transcriptCache[selectedGene.id]) return
        fetchTranscripts(selectedGene.id)
    }, [selectedGene?.id, transcriptCache, fetchTranscripts])

    // Navigate to a gene from external trigger
    const lastNavigateRef = useRef(null)
    useEffect(() => {
        if (!navigateToGene || navigateToGene === lastNavigateRef.current) return
        // A newly activated panel still has to load its regions. Keep the
        // request pending so its initial locus cannot replace the gene view.
        if (!regions.length) return
        lastNavigateRef.current = navigateToGene
        const {
            chrom,
            start,
            end,
            strand,
            name,
            id,
            windowStart,
            windowEnd,
            centerVertically,
        } = navigateToGene
        const chromName = String(chrom || '').trim()
        const numericStart = Number(start)
        const numericEnd = Number(end)
        if (!chromName || !Number.isFinite(numericStart) || !Number.isFinite(numericEnd)) {
            // Ignore partial focus payloads (e.g. id/symbol only) until resolved coordinates are available.
            return
        }
        const geneStart = Math.min(numericStart, numericEnd)
        const geneEnd = Math.max(numericStart, numericEnd)

        const regionForChrom = regions.find((r) => r.chrom === chromName) || null
        // Switch region if needed
        if (chromName !== selectedChrom) {
            setSelectedChrom(chromName)
            if (regionForChrom) setChromLength(regionForChrom.end)
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
        }

        // This panel's own focus coming back after a reload, relayed by the view while
        // the browser was hidden: go back to exactly the window the reader had, rather
        // than re-framing and re-centring on the gene as a fresh focus would.
        const resume = resumeViewRef.current
        if (resume) {
            resumeViewRef.current = null
            consumeRestoredSessionState(sessionPanelKey)
            if (String(resume.gene?.id || '') === String(id || '') && isSameChromToken(resume.chrom, chromName)) {
                setViewStart(Number(resume.start))
                setViewEnd(Number(resume.end))
                setSelectedGene({ chrom: chromName, start: geneStart, end: geneEnd, strand, name, id })
                return
            }
        }

        let nextStart
        let nextEnd
        if (Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowEnd > windowStart) {
            nextStart = windowStart
            nextEnd = windowEnd
        } else {
            const padding = Math.max(100, (geneEnd - geneStart) * 0.5)
            nextStart = geneStart - padding
            nextEnd = geneEnd + padding
        }

        // Navigating here focuses the gene, which slides the drawer over this
        // panel's right edge — so aim for the middle of what stays visible.
        const framedNav = frameRangeWithRightInset({
            start: nextStart,
            end: nextEnd,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            rightInsetPx: focusDrawerInsetOnFocus,
            flipped: isFlipped,
        })
        if (framedNav) {
            nextStart = framedNav.start
            nextEnd = framedNav.end
        }

        if (!isAligned) {
            const maxEnd = Math.max(2, regionForChrom?.end || chromLength || 1e9)
            const minStart = 1
            let span = Math.max(1, nextEnd - nextStart)
            if (span >= (maxEnd - minStart)) {
                nextStart = minStart
                nextEnd = maxEnd
            } else {
                nextStart = Math.max(minStart, nextStart)
                nextEnd = nextStart + span
                if (nextEnd > maxEnd) {
                    nextEnd = maxEnd
                    nextStart = Math.max(minStart, nextEnd - span)
                }
            }
        }

        pendingVerticalCenterGeneIdRef.current = centerVertically ? id : null
        setViewStart(nextStart)
        setViewEnd(nextEnd)
        setSelectedGene({ chrom: chromName, start: geneStart, end: geneEnd, strand, name, id })
    }, [navigateToGene, selectedChrom, regions, isAligned, chromLength, focusDrawerInsetOnFocus, isFlipped])

    /* An outside request to go to a region and focus it.
     *
     * Compared by identity rather than by coordinates, so asking for the same
     * region twice still moves the browser — the caller mints a new object each
     * time, exactly as the gene path above does. */
    const lastNavigateLocationRef = useRef(null)
    // Read by the regions fetch below, which otherwise drops the panel on this
    // genome's default locus the moment it lands — after this effect has already
    // framed the region the reader asked for.
    const pendingLocationNavigateRef = useRef(false)
    pendingLocationNavigateRef.current = Boolean(
        navigateToLocation && navigateToLocation !== lastNavigateLocationRef.current
    )
    useEffect(() => {
        if (!navigateToLocation || navigateToLocation === lastNavigateLocationRef.current) return
        // Held, not dropped: without the region list there is no chromosome to
        // resolve against or clamp to, so this runs again when the regions land.
        if (regions.length === 0) return
        lastNavigateLocationRef.current = navigateToLocation
        // Somewhere new was asked for, so the window from before a reload is moot.
        if (resumeViewRef.current) {
            resumeViewRef.current = null
            consumeRestoredSessionState(sessionPanelKey)
        }
        pendingLocationNavigateRef.current = false
        const range = getFocusLocationRange(navigateToLocation)
        if (!range) return

        if (!isSameChromToken(range.chrom, selectedChrom)) {
            const regionForChrom = regions.find((region) => isSameChromToken(region.chrom, range.chrom)) || null
            setSelectedChrom(regionForChrom?.chrom || range.chrom)
            if (regionForChrom) setChromLength(regionForChrom.end)
            setGenes([])
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
        }

        // Framed like every other focus, so the boundary lines land inside the
        // view. Clamped against the region the way the gene path above does,
        // rather than through clampView, which is not declared until later.
        const span = Math.max(1, range.end - range.start)
        const flank = Math.max(1, (span / FOCUS_RANGE_FILL_FRACTION - span) / 2)
        const region = regions.find((candidate) => isSameChromToken(candidate.chrom, range.chrom)) || null
        const maxEnd = Math.max(2, region?.end || chromLength || range.end + flank)
        const unframedStart = range.start - flank
        const unframedEnd = range.end + flank
        // External location requests can arrive before the drawer exists, so
        // focusDrawerInset is still zero. Anticipate the primary drawer exactly
        // as gene focus does; the secondary detail/notes panes deliberately do
        // not contribute to this inset.
        const framed = frameRangeWithRightInset({
            start: unframedStart,
            end: unframedEnd,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            // If a primary drawer is already present, frame for its current
            // open/rail state and let the inset-change effect handle any toggle.
            // With no drawer yet, anticipate the one this focus will open.
            rightInsetPx: focusDrawerInset || focusDrawerInsetOnFocus,
            flipped: isFlipped,
        })
        const nextStart = Math.max(1, framed?.start ?? unframedStart)
        let nextEnd = Math.min(maxEnd, framed?.end ?? unframedEnd)
        if (nextEnd <= nextStart) nextEnd = nextStart + 1
        setViewStart(nextStart)
        setViewEnd(nextEnd)
        focusLocation(range)
        if (onManualNavigate) onManualNavigate()
    }, [navigateToLocation, selectedChrom, regions, chromLength, focusLocation, onManualNavigate, focusDrawerInset, focusDrawerInsetOnFocus, isFlipped])

    useEffect(() => {
        if (clearFocusEpoch <= 0) return
        setSelectedGene(null)
        setSelectedLocation(null)
    }, [clearFocusEpoch])

    // ============ Coordinate Helpers ============

    const viewSpan = viewEnd - viewStart
    const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)
    const bpPerPx = viewSpan / trackWidth
    const isTranscriptDetailZoomActive = viewSpan <= TRANSCRIPT_DETAIL_VIEWSPAN_BP
    const visibleTranscriptGeneIds = useMemo(() => {
        const ids = []
        const seen = new Set()
        for (const gene of genes) {
            if (!gene?.id || isGeneHiddenFromTracks(gene)) continue
            if (gene.strand === '+' && effectiveHiddenStrands.forward) continue
            if (gene.strand === '-' && effectiveHiddenStrands.reverse) continue
            const id = String(gene.id)
            if (seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
        return ids
    }, [genes, isGeneHiddenFromTracks, effectiveHiddenStrands])
    const shouldRenderTranscriptStructures = useMemo(() => (
        shouldRenderViewportTranscriptStructures({
            viewSpan,
            detailMaxSpan: TRANSCRIPT_DETAIL_VIEWSPAN_BP,
            geneIds: visibleTranscriptGeneIds,
            transcriptCache,
        })
    ), [viewSpan, visibleTranscriptGeneIds, transcriptCache])
    const isTranscriptCompressionActive = compressTranscripts && isTranscriptDetailZoomActive
    const shouldForceGeneBlockView = !shouldRenderTranscriptStructures
    const isCompressedLayoutActive = compressTranscripts
    const transcriptLayoutMetrics = useMemo(
        () => getTranscriptLayoutMetrics(isCompressedLayoutActive, flattenTracks),
        [isCompressedLayoutActive, flattenTracks]
    )

    const bufferedTranscriptExpandGenes = useMemo(() => {
        if (!isViewportTranscriptExpandMode || !selectedChrom) {
            return EMPTY_LIST
        }
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const result = collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
        const candidatesById = new Map()
        for (const gene of [...(Array.isArray(result?.genes) ? result.genes : []), ...genes]) {
            const geneId = String(gene?.id || '').trim()
            if (geneId && !candidatesById.has(geneId)) candidatesById.set(geneId, gene)
        }
        const candidates = Array.from(candidatesById.values())
        if (candidates.length <= MAX_TRANSCRIPT_PREFETCH_GENES) {
            return candidates
        }
        const viewCenter = (viewGStart + viewGEnd) / 2
        return candidates
            .slice()
            .sort((a, b) => {
                const aCenter = (Number(a?.start || 0) + Number(a?.end || 0)) / 2
                const bCenter = (Number(b?.start || 0) + Number(b?.end || 0)) / 2
                return Math.abs(aCenter - viewCenter) - Math.abs(bCenter - viewCenter)
            })
            .slice(0, MAX_TRANSCRIPT_PREFETCH_GENES)
    }, [isViewportTranscriptExpandMode, selectedChrom, genomicViewRange, collectCachedGenesInRange, genes])

    const bufferedTranscriptExpandGeneIds = useMemo(() => {
        const ids = new Set()
        for (const gene of bufferedTranscriptExpandGenes) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) ids.add(geneId)
        }
        return ids
    }, [bufferedTranscriptExpandGenes])

    // Ordering and hidden transcripts belong to the gene, not to the act of
    // focusing it: what the user set up stays on screen after they unfocus. Only
    // the transient bits — the hover highlight and its ghost — are focus-only.
    const focusViewGeneId = String(focusTranscriptView?.geneId || '').trim()
    const getGeneTranscriptView = useCallback((geneId) => {
        const id = String(geneId || '').trim()
        if (!id) return null
        const stored = geneTranscriptViews?.[id] || null
        if (id !== focusViewGeneId) return stored
        return { ...(stored || {}), ...(focusTranscriptView || {}) }
    }, [geneTranscriptViews, focusTranscriptView, focusViewGeneId])

    const getFocusViewForGene = useCallback((geneId) => {
        if (!focusViewGeneId) return null
        return String(geneId || '').trim() === focusViewGeneId ? focusTranscriptView : null
    }, [focusTranscriptView, focusViewGeneId])

    const getEffectiveTranscriptLimit = useCallback((geneId, txs) => {
        if (!txs || txs.length === 0) return 1
        if (isTranscriptCompressionActive) return txs.length
        if (shouldForceGeneBlockView) return 1
        // `expanded: null` means the drawer has not taken a view yet — a gene the
        // user expanded from the canvas keeps that expansion when it gains focus.
        const focusView = getFocusViewForGene(geneId)
        if (focusView && focusView.expanded != null) return focusView.expanded ? txs.length : 1
        if (isViewportTranscriptExpandMode && bufferedTranscriptExpandGeneIds.has(String(geneId))) {
            return txs.length
        }
        return expandedGenes[geneId] || 1
    }, [expandedGenes, isTranscriptCompressionActive, shouldForceGeneBlockView, isViewportTranscriptExpandMode, bufferedTranscriptExpandGeneIds, getFocusViewForGene])

    // The single seam every visual consumer shares: row packing, drawing,
    // hit-testing and footer geometry all read their rows from here, so they
    // cannot disagree about how many rows a gene occupies or what is in them.
    const getDisplayTranscriptRows = useMemo(() => {
        // Row packing, painting, hit testing and footer controls all ask for the
        // same rows. Resolve once per gene until the data or display policy changes.
        const rowsByGene = new Map()
        return (gene) => {
            const txs = transcriptCache[gene.id]
            if (shouldForceGeneBlockView || !txs || txs.length === 0) return EMPTY_LIST
            if (rowsByGene.has(gene.id)) return rowsByGene.get(gene.id)
            const geneView = getGeneTranscriptView(gene.id)
            const rows = resolveGeneTranscriptView({
                transcripts: txs,
                limit: getEffectiveTranscriptLimit(gene.id, txs),
                order: geneView?.order,
                hidden: geneView?.hidden,
                ghostId: geneView?.ghostId,
            }).rows
            rowsByGene.set(gene.id, rows)
            return rows
        }
    }, [transcriptCache, shouldForceGeneBlockView, getEffectiveTranscriptLimit, getGeneTranscriptView])

    // Ghost rows are a hover preview, not content: anything that reasons about
    // what the gene actually shows (viewport fitting, chevron alignment) uses
    // this instead.
    const getDisplayTranscriptsForGene = useCallback((gene) => (
        getDisplayTranscriptRows(gene).filter((row) => !row.ghost).map((row) => row.transcript)
    ), [getDisplayTranscriptRows])

    const getGeneRowCountForWidth = useCallback((gene) => (
        Math.max(1, getDisplayTranscriptRows(gene).length || 1)
    ), [getDisplayTranscriptRows])

    // Derive the payload first: when no gene is focused this stays null while
    // the viewport moves, so panning cannot enqueue a parent state update per frame.
    const focusTranscriptsPayload = useMemo(() => {
        if (!selectedGene?.id) return null
        const cached = transcriptCache[selectedGene.id]
        return {
            gene: selectedGeneForVisibility || selectedGene,
            transcripts: Array.isArray(cached) ? cached : EMPTY_LIST,
            loading: !cached,
            expanded: Boolean(cached) && getEffectiveTranscriptLimit(selectedGene.id, cached) > 1,
        }
    }, [selectedGene, selectedGeneForVisibility, transcriptCache, getEffectiveTranscriptLimit])
    useEffect(() => {
        onFocusTranscriptsChangeRef.current?.(focusTranscriptsPayload)
    }, [focusTranscriptsPayload])

    // Once the drawer takes an explicit view, mirror it into the panel's own
    // expand map so unfocusing the gene leaves it as the user last had it.
    const lastDrawerExpandRef = useRef(null)
    useEffect(() => {
        const geneId = focusViewGeneId
        const expanded = focusTranscriptView?.expanded
        if (!geneId || expanded == null) {
            lastDrawerExpandRef.current = null
            return
        }
        const txs = transcriptCacheRef.current[geneId]
        const limit = expanded ? Math.max(1, txs?.length || 1) : 1
        setExpandedGenes((prev) => (prev[geneId] === limit ? prev : { ...prev, [geneId]: limit }))

        // Expanding from the drawer should bring the gene into view exactly as
        // the canvas pill does, rather than leaving the new rows off-screen.
        const signature = `${geneId}:${expanded}`
        if (lastDrawerExpandRef.current === signature) return
        const isFirstSight = lastDrawerExpandRef.current === null
        lastDrawerExpandRef.current = signature
        if (isFirstSight || !expanded) return
        requestTranscriptPillFocus(geneId, {
            limit: Math.max(1, txs?.length || 1),
            waitForTranscripts: !txs,
            preferBottomVisible: false,
            preserveHorizontalViewport: true,
        })
    }, [focusViewGeneId, focusTranscriptView?.expanded, transcriptCache, requestTranscriptPillFocus])

    const getGeneTotalHeight = useCallback((rowCount) => {
        const footerOverflow = isCompressedLayoutActive
            ? 0
            : geneFooterTrackOverflow(transcriptLayoutMetrics, flattenTracks)
        return (
            rowCount * transcriptLayoutMetrics.rowPitch
            - transcriptLayoutMetrics.rowGap
            + footerOverflow
        )
    }, [transcriptLayoutMetrics, isCompressedLayoutActive, flattenTracks])

    const clearTranscriptPopupDismissTimer = useCallback(() => {
        if (transcriptPopupDismissTimerRef.current) {
            clearTimeout(transcriptPopupDismissTimerRef.current)
            transcriptPopupDismissTimerRef.current = null
        }
    }, [])

    const dismissClickedGeneTranscript = useCallback(() => {
        clearTranscriptPopupDismissTimer()
        transcriptPopupHoverRef.current = false
        setClickedGeneTranscript(null)
    }, [clearTranscriptPopupDismissTimer])

    const scheduleTranscriptPopupDismiss = useCallback((delayMs = 140) => {
        clearTranscriptPopupDismissTimer()
        transcriptPopupDismissTimerRef.current = setTimeout(() => {
            transcriptPopupDismissTimerRef.current = null
            if (!transcriptPopupHoverRef.current) {
                setClickedGeneTranscript(null)
            }
        }, delayMs)
    }, [clearTranscriptPopupDismissTimer])

    useEffect(() => {
        if (!selectedGene || !selectedGeneHiddenByBiotype) return
        dismissClickedGeneTranscript()
        setSelectedGene(null)
    }, [selectedGene, selectedGeneHiddenByBiotype, dismissClickedGeneTranscript])

    useEffect(() => {
        if (!selectedGene?.id) {
            dismissClickedGeneTranscript()
            return
        }
        setClickedGeneTranscript((prev) => {
            if (!prev) return prev
            return prev.geneId === selectedGene.id ? prev : null
        })
    }, [selectedGene, dismissClickedGeneTranscript])

    const genomicToScreen = useCallback((genomicPos) => {
        const overlayPos = genomicToOverlay(genomicPos)

        if (isFlipped) {
            return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
        }
        return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
    }, [viewStart, viewEnd, bpPerPx, genomicToOverlay, isFlipped])

    const screenToGenomic = useCallback((screenX) => {
        const overlayPos = isFlipped
            ? viewEnd - (screenX - LHS_WIDTH) * bpPerPx
            : viewStart + (screenX - LHS_WIDTH) * bpPerPx

        return overlayToGenomic(overlayPos)
    }, [viewStart, viewEnd, bpPerPx, isFlipped, overlayToGenomic])

    const overlayToScreen = useCallback((overlayPos) => {
        if (isFlipped) {
            return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
        }
        return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
    }, [viewEnd, viewStart, bpPerPx, isFlipped])

    const selectedGeneLayoutEntry = useMemo(() => {
        if (!selectedGene?.id || selectedGeneHiddenByBiotype) return null
        return genes.find((gene) => gene?.id === selectedGene.id) || null
    }, [genes, selectedGene, selectedGeneHiddenByBiotype])

    // Compute shared, rounded base-cell boundaries so adjacent bases always
    // share edges exactly (prevents tiny scrolling gaps from float drift).
    const getBasePixelBounds = useCallback((overlayBaseStart, pxPerBpValue) => {
        // The exact scale every other track draws with. Rounding it to whole pixels (and
        // the view start to whole bases) was meant to give a hard base grid, but it put the
        // sequence up to a base away from the ruler and the custom tracks, and made every
        // zoom step near base level jump by whole pixels per base: the jitter seen when
        // zooming in. Only the edges are rounded, so boxes stay crisp and abut exactly.
        const px = Number.isFinite(pxPerBpValue) && pxPerBpValue > 0 ? pxPerBpValue : (1 / Math.max(1e-9, bpPerPx))
        let x1
        let x2
        if (isFlipped) {
            x1 = LHS_WIDTH + (viewEnd - (overlayBaseStart + 1)) * px
            x2 = LHS_WIDTH + (viewEnd - overlayBaseStart) * px
        } else {
            x1 = LHS_WIDTH + (overlayBaseStart - viewStart) * px
            x2 = LHS_WIDTH + ((overlayBaseStart + 1) - viewStart) * px
        }
        const bxL = Math.round(Math.min(x1, x2))
        const bxR = Math.round(Math.max(x1, x2))
        return { bxL, bxR, bxW: Math.max(1, bxR - bxL) }
    }, [bpPerPx, isFlipped, viewEnd, viewStart])

    const getGenomicIntervalPixelBounds = useCallback((genomicStart, genomicEnd, pxPerBpValue, snapToBaseGrid = false) => {
        const start = Math.round(Number(genomicStart))
        const end = Math.round(Number(genomicEnd))
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null
        const lo = Math.min(start, end)
        const hi = Math.max(start, end)
        if (hi < lo) return null

        if (snapToBaseGrid) {
            const startBounds = getBasePixelBounds(genomicToOverlay(lo), pxPerBpValue)
            const endBounds = getBasePixelBounds(genomicToOverlay(hi), pxPerBpValue)
            const x1 = Math.min(startBounds.bxL, endBounds.bxL)
            const x2 = Math.max(startBounds.bxR, endBounds.bxR)
            return { x1, x2, width: Math.max(1, x2 - x1) }
        }

        const overlayStart = genomicToOverlay(lo)
        const overlayEndExclusive = genomicToOverlay(hi) + 1
        const x1 = overlayToScreen(overlayStart)
        const x2 = overlayToScreen(overlayEndExclusive)
        const left = Math.min(x1, x2)
        const right = Math.max(x1, x2)
        return { x1: left, x2: right, width: Math.max(0, right - left) }
    }, [getBasePixelBounds, genomicToOverlay, overlayToScreen])

    // The same bounds for a custom track, which is drawn unflipped and mirrored as a whole
    // when the panel is flipped. The bounds above already follow the flip, so drawn inside
    // that mirror they were flipped twice: a flipped panel showed its gene models the
    // usual way round. Reflecting them back about the mirror's axis leaves the mirror to
    // flip them once — onto exactly the pixels the gene track uses.
    const getCustomTrackIntervalPixelBounds = useCallback((genomicStart, genomicEnd, pxPerBpValue, snapToBaseGrid = false) => {
        const bounds = getGenomicIntervalPixelBounds(genomicStart, genomicEnd, pxPerBpValue, snapToBaseGrid)
        if (!bounds || !isFlipped) return bounds
        const axis = LHS_WIDTH + viewWidth
        return { x1: axis - bounds.x2, x2: axis - bounds.x1, width: bounds.width }
    }, [getGenomicIntervalPixelBounds, isFlipped, viewWidth])

    // ============ Resize Observer ============

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setViewWidth(entry.contentRect.width)
                setViewHeight(Math.max(160, entry.contentRect.height))
            }
        })
        ro.observe(container)
        return () => ro.disconnect()
    }, [])

    // ============ Zoom & Pan Handlers ============

    const MIN_VIEW_SPAN = 50      // Minimum bp visible (max zoom in)
    const MAX_VIEW_SPAN = 50000000 // Maximum bp visible (max zoom out)

    // Momentum is a short flick, not a glide: at 0.95 the view kept travelling for
    // roughly a second after release, which reads as the tracks lagging the cursor.
    const MOMENTUM_FRICTION = 0.86
    const MIN_VELOCITY = 0.5
    // Ignore stale velocity: releasing after the cursor has settled must not fling.
    const MOMENTUM_MAX_IDLE_MS = 60

    // Use refs to avoid stale closures
    const viewStartRef = useRef(viewStart)
    const viewEndRef = useRef(viewEnd)
    const pendingInteractiveViewportRef = useRef(null)
    const interactiveViewportFrameRef = useRef(null)
    viewStartRef.current = pendingInteractiveViewportRef.current?.start ?? viewStart
    viewEndRef.current = pendingInteractiveViewportRef.current?.end ?? viewEnd

    // Where this panel is, offered to the session snapshot (sessionResume.js) so a
    // reload can put it back. Read from refs only when a snapshot is taken — never as
    // the reader pans — and while the panel is still waiting to put back what it had,
    // that is what it reports.
    const selectedGeneRef = useRef(selectedGene)
    selectedGeneRef.current = selectedGene
    const selectedLocationRef = useRef(selectedLocation)
    selectedLocationRef.current = selectedLocation
    useEffect(() => registerSessionState(sessionPanelKey, () => {
        if (resumeViewRef.current) return resumeViewRef.current
        const chrom = selectedChromRef.current
        const start = Math.round(viewStartRef.current)
        const end = Math.round(viewEndRef.current)
        if (!chrom || !(end > start)) return undefined
        const gene = selectedGeneRef.current
        const location = getFocusLocationRange(selectedLocationRef.current)
        return {
            chrom,
            start,
            end,
            gene: gene?.id ? {
                id: gene.id,
                name: gene.name,
                chrom: gene.chrom,
                start: gene.start,
                end: gene.end,
                strand: gene.strand,
            } : null,
            location: location ? { chrom: location.chrom, start: location.start, end: location.end } : null,
        }
    }), [sessionPanelKey])

    // What the genome says is worth looking at on this region, if it says anything.
    const browsableRange = useMemo(() => {
        const region = regions.find((candidate) => candidate.chrom === selectedChrom)
        const start = Number(region?.browsable_start)
        const end = Number(region?.browsable_end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
        return { start, end }
    }, [regions, selectedChrom])

    const clampView = useCallback((start, end) => {
        let span = end - start

        if (isAligned && alignData) {
            span = Math.max(1, span);
            // In alignment mode, allow panning beyond the aligned block to inspect
            // surrounding genomic context. Coordinates are mapped via overlay helpers.
            return [start, start + span]
        }

        // Clamp to chromosome bounds — or, where the genome declares one, to the part of
        // the region worth looking at. Only the tutorial's chromosome-1 slice does: it is
        // a real chromosome coordinate space holding a small window of real sequence, and
        // without this you can pan and zoom out into a hundred megabases of padding,
        // which reads as the browser being broken rather than as the edge of a slice.
        const minStart = Math.max(1, browsableRange?.start || 1);
        const maxEnd = Math.max(minStart + 1, browsableRange?.end || chromLength || 1e9);
        span = Math.max(1, span);

        if (span >= (maxEnd - minStart)) return [minStart, maxEnd];

        start = Math.max(minStart, start);
        end = start + span;
        if (end > maxEnd) {
            end = maxEnd;
            start = end - span;
        }
        return [Math.max(minStart, start), Math.min(maxEnd, end)]
    }, [browsableRange, chromLength, isAligned, alignData])

    // Reconcile a changed linked command before React commits the old viewport.
    // Doing this in a layout effect creates a nested commit for every pan frame;
    // continuous linked input can keep that chain alive until React's depth limit.
    // Only this component's state is adjusted, and only when an input changes.
    const externalSyncInputs = [lockPan, lockZoom, externalPosition, clampView, selectedChrom, regions]
    const [lastExternalSyncInputs, setLastExternalSyncInputs] = useState(null)
    if (!lastExternalSyncInputs || externalSyncInputs.some((value, index) => !Object.is(value, lastExternalSyncInputs[index]))) {
        setLastExternalSyncInputs(externalSyncInputs)
        const applyExternalPosition = () => {
            if (!externalPosition) return
            const extChrom = String(externalPosition.chrom || '').trim()
            if (extChrom && extChrom !== selectedChrom) {
                const region = regions.find((r) => r.chrom === extChrom)
                if (region) {
                    setSelectedChrom(extChrom)
                    if (region?.end) setChromLength(region.end)
                    setGenes([])
                    // Requests are retired by the chromosome-change effect; tiles are
                    // already keyed by chromosome. Re-render with the new bounds.
                    return
                }
                if (regions.length > 0) {
                    console.warn(`[GenomeBrowser:${genome}] Ignoring linked viewport chromosome ${extChrom}; it is not present in this genome.`)
                }
            }
            if (lockPan) {
                // Pan lock: sync both start and end (position + zoom)
                let [nextStart, nextEnd] = clampView(externalPosition.start, externalPosition.end)
                if (Math.abs(nextStart - viewStart) > 1e-6 || Math.abs(nextEnd - viewEnd) > 1e-6) {
                    setViewStart(nextStart)
                    setViewEnd(nextEnd)
                }
            } else if (lockZoom) {
                if (Number.isFinite(externalPosition.anchorRatio)) {
                    // Zoom event: the parent pre-computed our ratio-anchored position — apply directly.
                    let [nextStart, nextEnd] = clampView(externalPosition.start, externalPosition.end)
                    if (Math.abs(nextStart - viewStart) > 1e-6 || Math.abs(nextEnd - viewEnd) > 1e-6) {
                        setViewStart(nextStart)
                        setViewEnd(nextEnd)
                    }
                } else {
                    // Pan event: keep our own center, just match the span.
                    const extSpan = externalPosition.end - externalPosition.start
                    const myCenter = (viewStart + viewEnd) / 2
                    let [nextStart, nextEnd] = clampView(myCenter - extSpan / 2, myCenter + extSpan / 2)
                    if (Math.abs(nextStart - viewStart) > 1e-6 || Math.abs(nextEnd - viewEnd) > 1e-6) {
                        setViewStart(nextStart)
                        setViewEnd(nextEnd)
                    }
                }
            }
        }
        applyExternalPosition()
    }

    const scheduleInteractiveViewport = useCallback((start, end, targetTrack = undefined, anchorRatio = undefined) => {
        // Update refs immediately so multiple input events in one frame accumulate
        // from the latest viewport rather than the last committed React render.
        viewStartRef.current = start
        viewEndRef.current = end
        pendingInteractiveViewportRef.current = { start, end, targetTrack, anchorRatio }
        if (interactiveViewportFrameRef.current !== null) return
        interactiveViewportFrameRef.current = requestAnimationFrame(() => {
            interactiveViewportFrameRef.current = null
            const pending = pendingInteractiveViewportRef.current
            pendingInteractiveViewportRef.current = null
            if (!pending) return
            setViewStart(pending.start)
            setViewEnd(pending.end)
            if (onPositionChange) {
                onPositionChange(
                    selectedChrom,
                    pending.start,
                    pending.end,
                    pending.targetTrack,
                    pending.anchorRatio,
                )
            }
        })
    }, [onPositionChange, selectedChrom])

    useEffect(() => () => {
        if (interactiveViewportFrameRef.current !== null) {
            cancelAnimationFrame(interactiveViewportFrameRef.current)
            interactiveViewportFrameRef.current = null
        }
        pendingInteractiveViewportRef.current = null
    }, [])

    const getGeneDisplayBounds = useCallback((gene, options = {}) => {
        if (!gene) return null
        const fallbackRange = getGeneCoordRange(gene)
        const txs = transcriptCacheRef.current[gene.id]
        const effectiveLimit = getEffectiveTranscriptLimit(gene.id, txs)
        const limit = Math.max(1, Number(options.limit ?? effectiveLimit ?? 1))
        const geneView = getGeneTranscriptView(gene.id)
        // No ghost here: the viewport must never fit itself to a hover preview.
        const displayTxs = resolveGeneTranscriptView({
            transcripts: txs,
            limit,
            order: geneView?.order,
            hidden: geneView?.hidden,
        }).transcripts

        if (displayTxs.length === 0) {
            if (!fallbackRange) return null
            return { ...fallbackRange, displayTxs: [], limit }
        }

        let minStart = Number.POSITIVE_INFINITY
        let maxEnd = Number.NEGATIVE_INFINITY
        for (const tx of displayTxs) {
            const txStart = Number(tx?.start)
            const txEnd = Number(tx?.end)
            if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) continue
            minStart = Math.min(minStart, txStart, txEnd)
            maxEnd = Math.max(maxEnd, txStart, txEnd)
        }

        if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
            if (!fallbackRange) return null
            return { ...fallbackRange, displayTxs, limit }
        }

        return { start: minStart, end: maxEnd, displayTxs, limit }
    }, [getEffectiveTranscriptLimit, getGeneTranscriptView])

    // Every "put this gene on screen" path runs through here, so the drawer only
    // has to be accounted for once.
    const frameFocusRange = useCallback((start, end, options = {}) => {
        const framed = frameRangeWithRightInset({
            start,
            end,
            trackWidthPx: Math.max(1, viewWidth - LHS_WIDTH),
            rightInsetPx: options.gainingFocus ? focusDrawerInsetOnFocus : focusDrawerInset,
            flipped: isFlipped,
        })
        return framed || { start, end }
    }, [viewWidth, focusDrawerInset, focusDrawerInsetOnFocus, isFlipped])

    const getGeneFocusViewport = useCallback((gene, options = {}) => {
        const bounds = getGeneDisplayBounds(gene, options)
        if (!bounds) return null

        const coordsForView = getFeatureCoordsForView(bounds.start, bounds.end, isAligned, alignData, genomicToOverlay)
        if (!coordsForView) return null

        const featureSpan = Math.max(1, coordsForView.end - coordsForView.start)
        const paddedSpan = Math.max(1, featureSpan / 0.8)
        const midpoint = (coordsForView.start + coordsForView.end) / 2
        const framed = frameFocusRange(midpoint - paddedSpan / 2, midpoint + paddedSpan / 2)
        return { start: framed.start, end: framed.end, bounds }
    }, [getGeneDisplayBounds, isAligned, alignData, genomicToOverlay, frameFocusRange])

    // Pan by pixel delta
    const panByPx = useCallback((dx) => {
        // A tutorial step can hold the view still while leaving zooming alone. Guarded
        // here rather than at each gesture because dragging, the wheel, the arrow keys and
        // the momentum fling all arrive through this one function — and `animateToView`
        // deliberately does not, so a step can still put the view where it wants it.
        if (interactionModeRef.current === 'zoom-only') return
        if (onManualNavigate) onManualNavigate()
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const currentSpan = currentEnd - currentStart
        const currentTrackWidth = Math.max(1, viewWidth - LHS_WIDTH)
        const currentPerPx = currentSpan / currentTrackWidth
        const dBp = isFlipped ? -dx * currentPerPx : dx * currentPerPx
        // Not snapped to whole bases: every track draws with the same exact scale, so
        // they align at any start, and snapping made the view jump under the cursor.
        const [newStart, newEnd] = clampView(currentStart + dBp, currentEnd + dBp)

        scheduleInteractiveViewport(newStart, newEnd)
    }, [viewWidth, clampView, isFlipped, onManualNavigate, scheduleInteractiveViewport])

    // Momentum animation
    const startMomentum = useCallback(() => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current)
        const idleMs = performance.now() - lastTimeRef.current
        let vel = idleMs > MOMENTUM_MAX_IDLE_MS ? 0 : velocityRef.current
        velocityRef.current = 0

        const animate = () => {
            if (Math.abs(vel) < MIN_VELOCITY) {
                animationRef.current = null
                return
            }
            panByPx(vel)
            vel *= MOMENTUM_FRICTION
            animationRef.current = requestAnimationFrame(animate)
        }

        if (Math.abs(vel) > MIN_VELOCITY) {
            animationRef.current = requestAnimationFrame(animate)
        }
    }, [panByPx])

    // Smoothly transition the viewport to a target range in fixed time.
    const animateToView = useCallback((targetStart, targetEnd, durationMs = 1000) => {
        const [finalStart, finalEnd] = clampView(targetStart, targetEnd)
        const initialStart = viewStartRef.current
        const initialEnd = viewEndRef.current

        if (Math.abs(finalStart - initialStart) < 1e-6 && Math.abs(finalEnd - initialEnd) < 1e-6) {
            return
        }

        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }
        velocityRef.current = 0

        const startTime = performance.now()
        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

        const tick = (now) => {
            const rawT = Math.min(1, (now - startTime) / durationMs)
            const t = easeOutCubic(rawT)

            let nextStart = initialStart + (finalStart - initialStart) * t
            let nextEnd = initialEnd + (finalEnd - initialEnd) * t
                ;[nextStart, nextEnd] = clampView(nextStart, nextEnd)

            viewStartRef.current = nextStart
            viewEndRef.current = nextEnd
            setViewStart(nextStart)
            setViewEnd(nextEnd)

            if (onPositionChange) {
                onPositionChange(selectedChrom, nextStart, nextEnd)
            }

            if (rawT < 1) {
                animationRef.current = requestAnimationFrame(tick)
            } else {
                animationRef.current = null
            }
        }

        animationRef.current = requestAnimationFrame(tick)
    }, [clampView, onPositionChange, selectedChrom])

    const screenToViewCoord = useCallback((screenX) => {
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const currentSpan = currentEnd - currentStart
        const trackW = Math.max(1, viewWidth - LHS_WIDTH)
        const clampedX = Math.max(LHS_WIDTH, Math.min(viewWidth, screenX))
        const ratio = Math.max(0, Math.min(1, (clampedX - LHS_WIDTH) / trackW))
        return isFlipped
            ? currentEnd - ratio * currentSpan
            : currentStart + ratio * currentSpan
    }, [viewWidth, isFlipped])

    // ============ Layout computation ============
    const layout = useMemo((...args) => computeBrowserLayout({
        bpPerPx,
        collectCachedGenesInRange,
        compactPanelHeight,
        customTrackData,
        customTrackLoading,
        customTracksById,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        effectiveTrackAlign,
        flattenTracks,
        focusBarHeight,
        geneLayoutPackCacheRef,
        geneRowShrinkBucketRef,
        geneRowStickyRef,
        geneSubtrackStateRef,
        genes,
        genomicViewRange,
        getDisplayTranscriptRows,
        getVcfBlockLevel,
        hiddenBiotypeClasses,
        hiddenGeneIdSet,
        hiddenStrands,
        hideInactiveTracks,
        holdGeneTrackHeight,
        isCompressedLayoutActive,
        isCustomTrackId,
        isGeneHiddenFromTracks,
        isLocationFocusVisible,
        isTranscriptCompressionActive,
        joinedRows,
        selectedChrom,
        selectedGene,
        selectedGeneHiddenByBiotype,
        showSequenceTrack,
        trackOrder,
        transcriptCache,
        transcriptLayoutMetrics,
        viewHeight,
        viewSpan,
        viewWidth,
    }, ...args), [genes, viewSpan, viewWidth, viewHeight, transcriptCache, effectiveHiddenStrands, trackOrder, effectiveRulerPosition, effectiveTrackAlign, showSequenceTrack, customTracksById, joinedRows, customTrackData, customTrackLoading, isCustomTrackId, selectedGene, isLocationFocusVisible, hiddenStrands, selectedGeneHiddenByBiotype, isGeneHiddenFromTracks, hiddenGeneIdSet, focusBarHeight, hideInactiveTracks, hiddenBiotypeClasses, selectedChrom, genomicViewRange, collectCachedGenesInRange, getVcfBlockLevel, bpPerPx, isTranscriptCompressionActive, isCompressedLayoutActive, transcriptLayoutMetrics, getDisplayTranscriptRows, flattenTracks, compactPanelHeight, effectiveRulerHeight, stickyLayoutResetEpoch, holdGeneTrackHeight])

    // Where the note about the gene index goes: the forward and reverse tracks
    // taken together, minus whichever of them the user has hidden. Null when
    // both are off — there is nothing on screen for the message to be about.
    const geneIndexOverlayGeometry = useMemo(() => {
        if (!holdGeneTrackHeight) return null
        return geneIndexOverlayBand({
            forwardY: layout.FORWARD_Y,
            forwardHeight: layout.forwardBgHeight,
            reverseY: layout.REVERSE_Y,
            reverseHeight: layout.reverseBgHeight,
        })
    }, [holdGeneTrackHeight, layout.FORWARD_Y, layout.forwardBgHeight, layout.REVERSE_Y, layout.reverseBgHeight])

    const getSelectedGeneTranscriptHit = useCallback((...args) => findSelectedGeneTranscriptHit({
        genomicToScreen,
        getDisplayTranscriptRows,
        isTranscriptCompressionActive,
        layout,
        selectedGeneLayoutEntry,
        shouldForceGeneBlockView,
        transcriptCache,
        transcriptLayoutMetrics,
    }, ...args), [
        selectedGeneLayoutEntry,
        shouldForceGeneBlockView,
        genomicToScreen,
        transcriptCache,
        getDisplayTranscriptRows,
        layout,
        transcriptLayoutMetrics,
        isTranscriptCompressionActive,
    ])

    const alignGeneToTop = useCallback((geneForFocus, marginPx = 18, options = {}) => {
        if (!geneForFocus || !containerRef.current) return false

        const isForward = geneForFocus.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(geneForFocus.start)
        const rawGx2 = genomicToScreen(geneForFocus.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const rowCount = getGeneRowCountForWidth(geneForFocus, geneWidth)
        const totalGeneHeight = getGeneTotalHeight(rowCount)
        const baseGeneY = trackY + trackPadding + ((geneForFocus._row || 0) * transcriptLayoutMetrics.rowPitch)

        const container = containerRef.current
        const containerRect = container.getBoundingClientRect()
        const scroller = findNearestScrollable(rootRef.current)
        const scrollerMetrics = getScrollerMetrics(scroller)

        const topMarginPx = Math.max(0, Number(options.topMarginPx ?? marginPx))
        const bottomMarginPx = Math.max(0, Number(options.bottomMarginPx ?? marginPx))

        // The gene's position in client space. The panel itself never scrolls, so
        // this only moves when the surrounding page scroller moves.
        const geneTopClientY = containerRect.top + baseGeneY
        const geneBottomClientY = geneTopClientY + totalGeneHeight

        // Park the gene just under whichever edge is lower: the panel's own top or
        // the visible top of the scroll viewport, below a control bar floating there.
        const visibleTop = getScrollerVisibleTop(scroller, scrollerMetrics)
        const topAlignDelta = geneTopClientY - (Math.max(containerRect.top, visibleTop) + topMarginPx)
        const bottomFitDelta = Math.max(
            0,
            geneBottomClientY + bottomMarginPx - Math.min(containerRect.bottom, scrollerMetrics.bottom)
        )
        const rawScrollTop = scrollerMetrics.scrollTop
            + (Boolean(options.preferBottomVisible) ? bottomFitDelta : topAlignDelta)

        // Layout may still be growing (transcripts expanding); let the caller retry.
        const needsMoreScrollableHeight = Boolean(options.preferBottomVisible)
            && (rawScrollTop > (scrollerMetrics.maxScrollTop + 1))
        if (needsMoreScrollableHeight) {
            return false
        }

        scrollScrollerTo(scroller, scrollerMetrics, clamp(rawScrollTop, 0, scrollerMetrics.maxScrollTop))
        return true
    }, [layout, transcriptLayoutMetrics, genomicToScreen, getGeneRowCountForWidth, getGeneTotalHeight])

    useEffect(() => {
        if (!focusBarRef.current) return
        const node = focusBarRef.current
        const updateHeight = () => {
            const h = Math.ceil(node.getBoundingClientRect().height)
            if (h > 0) setFocusBarHeight(h)
        }
        updateHeight()
        const ro = new ResizeObserver(updateHeight)
        ro.observe(node)
        return () => ro.disconnect()
    }, [selectedGene, isSelectedHidden, isLocationFocusVisible, effectiveFocusBarPosition, theme])

    const getCustomTrackToggleY = useCallback((trackLayout) => {
        return trackLayout.y + Math.max(18, (trackLayout.height * 0.45))
    }, [])

    const getTrackAtY = useCallback((y) => {
        for (const track of layout.orderedTracks) {
            if (y >= track.y && y <= track.y + track.height) {
                return track.id
            }
        }
        return null
    }, [layout])

    const getGeneFeatureVerticalAnchor = useCallback((mouseX, mouseY, trackId) => {
        const trackGenes = trackId === 'forward'
            ? layout.forwardGenes
            : trackId === 'reverse'
                ? layout.reverseGenes
                : []
        if (trackGenes.length === 0) return null

        const trackY = trackId === 'forward' ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = trackId === 'forward' ? layout.fwdPadding : layout.revPadding
        let best = null

        for (const gene of trackGenes) {
            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)
            if (mouseX < gx1 - 4 || mouseX > gx2 + 4) continue

            const geneWidth = Math.max(1, gx2 - gx1)
            const displayTxs = getDisplayTranscriptsForGene(gene, geneWidth)
            const rowCount = Math.max(1, displayTxs.length || 1)
            const baseGeneY = trackY
                + trackPadding
                + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const totalGeneHeight = getGeneTotalHeight(rowCount)
            if (mouseY < baseGeneY || mouseY > baseGeneY + totalGeneHeight) continue

            const rowAnchor = getFeatureRowAnchor({
                baseGeneY,
                pointerY: mouseY,
                rowPitch: transcriptLayoutMetrics.rowPitch,
                midOffset: transcriptLayoutMetrics.midOffset,
                rowCount,
                transcriptIds: displayTxs.map((tx) => tx?.id),
            })
            if (!rowAnchor) continue

            const rowMidY = baseGeneY
                + (rowAnchor.rowIndex * transcriptLayoutMetrics.rowPitch)
                + transcriptLayoutMetrics.midOffset
            const distance = Math.abs(mouseY - rowMidY)
            if (!best || distance < best.distance) {
                best = {
                    trackId,
                    geneId: String(gene.id),
                    transcriptId: rowAnchor.transcriptId,
                    fallbackRowIndex: rowAnchor.rowIndex,
                    rowOffset: rowAnchor.rowOffset,
                    distance,
                }
            }
        }

        if (!best) return null
        return {
            trackId: best.trackId,
            geneId: best.geneId,
            transcriptId: best.transcriptId,
            fallbackRowIndex: best.fallbackRowIndex,
            rowOffset: best.rowOffset,
        }
    }, [
        layout,
        genomicToScreen,
        getDisplayTranscriptsForGene,
        getGeneTotalHeight,
        transcriptLayoutMetrics,
    ])

    const getGeneFeatureVerticalTargetY = useCallback((anchor) => {
        if (!anchor?.geneId) return null
        const trackGenes = anchor.trackId === 'forward'
            ? layout.forwardGenes
            : anchor.trackId === 'reverse'
                ? layout.reverseGenes
                : []
        const gene = trackGenes.find((candidate) => String(candidate?.id) === String(anchor.geneId))
        if (!gene) return null

        const trackY = anchor.trackId === 'forward' ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = anchor.trackId === 'forward' ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(gene.start)
        const rawGx2 = genomicToScreen(gene.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const displayTxs = getDisplayTranscriptsForGene(gene, geneWidth)
        const baseGeneY = trackY
            + trackPadding
            + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)

        return getFeatureRowTargetY({
            baseGeneY,
            rowPitch: transcriptLayoutMetrics.rowPitch,
            midOffset: transcriptLayoutMetrics.midOffset,
            transcriptId: anchor.transcriptId,
            fallbackRowIndex: anchor.fallbackRowIndex,
            rowOffset: anchor.rowOffset,
            visibleTranscriptIds: displayTxs.map((tx) => tx?.id),
        })
    }, [layout, genomicToScreen, getDisplayTranscriptsForGene, transcriptLayoutMetrics])

    const getTrackTooltip = useCallback((trackId) => {
        if (isFlipped && trackId) return 'Reverse complement mode is active, track is reversed'
        if (trackId === 'forward') return 'Genes on the forward strand'
        if (trackId === 'reverse') return 'Genes on the reverse strand'
        if (trackId === 'sequence') return sequenceTrackTooltip
        if (isGroupRowId(trackId)) {
            const row = joinedRows.get(trackId)
            return row ? `Track group ${row.label}: ${row.memberIds.length} track${row.memberIds.length === 1 ? '' : 's'} in one row` : 'Track group'
        }
        if (isCustomTrackId(trackId)) {
            const group = customTracksById.get(trackId)?.group
            return group ? `Custom track in the group ${group.label}` : 'Custom track'
        }
        return ''
    }, [sequenceTrackTooltip, isCustomTrackId, isFlipped, joinedRows, customTracksById])

    const isPrimaryPanel = useMemo(() => {
        const lowerLabel = String(label || '').toLowerCase()
        return alignmentRole === 'reference' || genome === 'reference' || lowerLabel.includes('primary')
    }, [alignmentRole, genome, label])

    const resolvedGenomeColor = useMemo(() => {
        return String(genomeColor || '').trim() || (isPrimaryPanel ? colors.exonProteinCoding : VCF_SETTINGS_DEFAULTS.genic_color)
    }, [genomeColor, isPrimaryPanel, colors.exonProteinCoding])

    const panelExonColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    const panelPillColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    const controlAccentColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    // On: the genome's own colour, so the sidebar reads as part of this panel.
    // Off: a muted grey that still reads as a control rather than a disabled one.
    const sidebarToggleIconColor = useCallback((active) => (
        active ? panelPillColor : (isLight ? '#94a3b8' : '#6b7280')
    ), [panelPillColor, isLight])

    const buildPanelExportSnapshot = useCallback((...args) => renderPanelExportSnapshot({
        ANCHOR_ICON_BODY,
        alignData,
        alignmentCoords,
        bigWigZoneScales,
        bpPerPx,
        canvasRef,
        clickedBigBedFeature,
        clickedVcfVariant,
        colors,
        customTrackData,
        customTracksById,
        dimNonSelectedGenes,
        effectiveFocusBarPosition,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        effectiveToolbarPosition,
        flattenTracks,
        focusBarRef,
        geneNoteOverlayRef,
        genes,
        genomicToScreen,
        getBasePixelBounds,
        getCustomTrackIntervalPixelBounds,
        getCustomTrackToggleY,
        getEffectiveTranscriptLimit,
        getGeneRowCountForWidth,
        getVcfBlockLevel,
        hoveredBigBedFeature,
        hoveredSeqBase,
        hoveredVcfBlock,
        isAligned,
        isCompressedLayoutActive,
        isCustomTrackId,
        isFlipped,
        isLight,
        isLocationFocusVisible,
        isPrimaryPanel,
        isSelectedHidden,
        joinedRows,
        layout,
        overlayToGenomic,
        paintCanvasRef,
        panelPillColor,
        rootRef,
        selectedGene,
        seqRange,
        sequence,
        sequenceTrackLabel,
        showSequenceTrack,
        sidebarToggleIconColor,
        toolbarRef,
        trackOrder,
        trackWidth,
        transcriptCache,
        transcriptLayoutMetrics,
        viewEnd,
        viewHeight,
        viewSpan,
        viewStart,
        viewWidth,
    }, ...args), [ANCHOR_ICON_BODY, joinedRows, REV_COMP, alignData, alignmentCoords, bpPerPx, clickedBigBedFeature, clickedVcfVariant, colors, colors.bg, colors.geneLabelText, colors.rulerBg, colors.rulerText, customTrackData, customTracksById, dimNonSelectedGenes, effectiveFocusBarPosition, effectiveHiddenStrands, effectiveRulerHeight, effectiveRulerPosition, effectiveToolbarPosition, expandedGenes, flattenTracks, genes, genomicToScreen, getBasePixelBounds, getGenomicIntervalPixelBounds, getCustomTrackIntervalPixelBounds, bigWigZoneScales, getCustomTrackToggleY, getEffectiveTranscriptLimit, getGeneRowCountForWidth, getVcfBlockLevel, hoveredBigBedFeature, hoveredSeqBase, hoveredVcfBlock, isAligned, isLight, isPrimaryPanel, isFlipped, isSelectedHidden, isLocationFocusVisible, isTranscriptCompressionActive, isCompressedLayoutActive, isCustomTrackId, layout, overlayToGenomic, panelPillColor, sidebarToggleIconColor, selectedGene, seqRange, sequence, sequenceTrackLabel, showSequenceTrack, shouldForceGeneBlockView, trackOrder, trackWidth, transcriptCache, transcriptLayoutMetrics, viewEnd, viewHeight, viewSpan, viewStart, viewWidth])

    const buildPanelExportSnapshotRef = useRef(buildPanelExportSnapshot)
    useEffect(() => {
        buildPanelExportSnapshotRef.current = buildPanelExportSnapshot
    }, [buildPanelExportSnapshot])

    const screenshotTargetDescriptor = useMemo(() => {
        if (!screenshotTargetId) return null
        return {
            id: screenshotTargetId,
            label: genomePillLabel || label || 'Genome browser panel',
            buildDefaultFilename: () => buildDefaultScreenshotName(),
            getVisibleRect: () => rootRef.current?.getBoundingClientRect() || null,
            getScrollElement: () => findNearestScrollable(containerRef.current) || containerRef.current || null,
            buildExportSnapshot: () => buildPanelExportSnapshotRef.current?.(),
        }
    }, [genomePillLabel, label, screenshotTargetId])

    useEffect(() => {
        if (typeof onScreenshotTargetChangeRef.current !== 'function') return undefined
        onScreenshotTargetChangeRef.current(screenshotTargetDescriptor)
        return () => {
            if (typeof onScreenshotTargetChangeRef.current === 'function') {
                onScreenshotTargetChangeRef.current(null)
            }
        }
    }, [screenshotTargetDescriptor])

    const getCustomTrackGeometry = useCallback((trackLayout, renderMode, trackType = '', data = null) => {
        if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
            const vcfLevel = getVcfBlockLevel(bpPerPx)
            const isDetailMode = data?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
            const top = trackLayout.y + (isDetailMode ? 18 : 8)
            const bottom = trackLayout.y + trackLayout.height - 8
            const plotHeight = Math.max(8, bottom - top)
            const barH = Math.max(3, Math.floor(plotHeight * (isDetailMode ? 0.13 : 0.18)))
            const barY = top + Math.floor((plotHeight - barH) / 2)
            return {
                top,
                bottom,
                plotHeight,
                labelY: isDetailMode
                    ? (trackLayout.y + 10)
                    : Math.max(trackLayout.y + 10, barY - 8),
                variantBarY: barY,
                variantBarH: barH,
                bumpAreaTop: top,
                bumpAreaBottom: bottom,
            }
        }

        if (renderMode !== 'zoned_heatmap') {
            const top = trackLayout.y + 18
            const bottom = trackLayout.y + trackLayout.height - 8
            return {
                top,
                bottom,
                plotHeight: Math.max(8, bottom - top),
                labelY: trackLayout.y + 9,
                // For ensembl VCF: allocate vertical subzones
                variantBarY: trackLayout.y + 18,
                variantBarH: 8,
                bumpAreaTop: trackLayout.y + 30,
                bumpAreaBottom: trackLayout.y + trackLayout.height - 8,
            }
        }

        const labelBand = 14
        const topPad = 4
        const bottomPad = 6
        const gap = 2
        // In a joined group every track is named above its band, so a heatmap's name
        // under it would read as the name of the track below.
        const labelBelow = isPrimaryPanel && !trackLayout.joinedRowId
        if (labelBelow) {
            const top = trackLayout.y + topPad
            const bottom = trackLayout.y + trackLayout.height - (labelBand + bottomPad + gap)
            return {
                top,
                bottom,
                plotHeight: Math.max(8, bottom - top),
                labelY: trackLayout.y + trackLayout.height - bottomPad - (labelBand / 2),
            }
        }

        const top = trackLayout.y + labelBand + topPad
        const bottom = trackLayout.y + trackLayout.height - bottomPad
        return {
            top,
            bottom,
            plotHeight: Math.max(8, bottom - top),
            labelY: trackLayout.y + topPad + (labelBand / 2),
        }
    }, [isPrimaryPanel, getVcfBlockLevel, bpPerPx])

    const getCustomTrackHoverInTrackFrame = useCallback((...args) => findCustomTrackHover({
        bpPerPx,
        customTrackData,
        customTracksById,
        formatSignalValueExact,
        getCustomTrackGeometry,
        getSpliceLodMode,
        layout,
        spliceArcLiftOffsets,
        viewEnd,
        viewStart,
        viewWidth,
    }, ...args), [layout, customTracksById, customTrackData, viewWidth, viewStart, viewEnd, bpPerPx, formatSignalValueExact, getCustomTrackGeometry, getSpliceLodMode, spliceArcLiftOffsets])

    // Custom tracks are drawn in genomic order and mirrored when the panel is flipped
    // (see beginCanvasMirror), so hit-testing runs in that same unmirrored frame: the
    // pointer goes in reflected, and the anchors popups hang from come out reflected back.
    const getCustomTrackHover = useCallback((mouseX, mouseY, clientX, clientY) => {
        if (!isFlipped) return getCustomTrackHoverInTrackFrame(mouseX, mouseY, clientX, clientY)
        const mirrorAxis = LHS_WIDTH + viewWidth
        const hit = getCustomTrackHoverInTrackFrame(mirrorAxis - mouseX, mouseY, clientX, clientY)
        if (!hit) return hit
        const toScreen = (entry) => (
            entry && Number.isFinite(entry.anchorCanvasX)
                ? { ...entry, anchorCanvasX: mirrorAxis - entry.anchorCanvasX }
                : entry
        )
        return {
            ...hit,
            ...(hit.hoverSplice ? { hoverSplice: toScreen(hit.hoverSplice) } : null),
            ...(hit.hoverBigBed ? { hoverBigBed: toScreen(hit.hoverBigBed) } : null),
        }
    }, [isFlipped, viewWidth, getCustomTrackHoverInTrackFrame])

    // Notify parent of our actual current view position so it can use the real
    // value for ratio-anchored zoom (avoids stale panelPositions state jumps).
    useEffect(() => {
        if (onViewSyncRef.current) onViewSyncRef.current(selectedChrom, viewStart, viewEnd)
    }, [viewStart, viewEnd, selectedChrom])

    // Zoom centered on a screen position
    const zoomAt = useCallback((screenX, factor, targetTrack) => {
        if (onManualNavigate) onManualNavigate()
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        let currentSpan = currentEnd - currentStart
        let newSpan = currentSpan * factor
        newSpan = Math.max(MIN_VIEW_SPAN, Math.min(MAX_VIEW_SPAN, newSpan))

        const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)
        const clampedX = Math.max(LHS_WIDTH, Math.min(viewWidth, screenX))
        const ratio = Math.max(0, Math.min(1, (clampedX - LHS_WIDTH) / trackWidth))
        const anchor = isFlipped
            ? currentEnd - ratio * currentSpan
            : currentStart + ratio * currentSpan
        const startRatio = isFlipped ? (1 - ratio) : ratio

        const newStart = anchor - newSpan * startRatio
        const newEnd = newStart + newSpan
        // Not snapped to whole bases, which moved the base under the cursor by up to half
        // a base on every step: tens of pixels near base level, back and forth.
        const [clampedStart, clampedEnd] = clampView(newStart, newEnd)

        // Pass ratio so linked panels apply the same screen-position anchor.
        scheduleInteractiveViewport(clampedStart, clampedEnd, targetTrack, ratio)
    }, [viewWidth, clampView, isFlipped, onManualNavigate, scheduleInteractiveViewport])

    // Mouse handlers
    const dragStartYRef = useRef(0)
    const dragScrollTopRef = useRef(0)
    const dragAxisRef = useRef(null) // null = undecided, 'x' = horizontal pan, 'y' = vertical scroll
    const scrollTargetRef = useRef(null) // the nearest scrollable ancestor at drag start
    const findNearestScrollable = (el) => {
        let current = el
        while (current && current !== document.body) {
            const overflowY = window.getComputedStyle(current).overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 1) {
                return current
            }
            current = current.parentElement
        }
        return null
    }
    const readAnchorScrollTop = (scrollElement) => (
        scrollElement && scrollElement !== document.documentElement && scrollElement !== document.body
            ? scrollElement.scrollTop
            : (window.scrollY || document.documentElement?.scrollTop || 0)
    )

    const expandedGeneFooters = useMemo(() => {
        if (compressTranscripts || isViewportTranscriptExpandMode) return []

        const footers = []
        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            const txs = transcriptCache[gene.id]
            if (!Array.isArray(txs) || txs.length < 2) continue

            const displayRows = getDisplayTranscriptRows(gene)
            const visibleRows = displayRows.filter((row) => !row.ghost)
            if (visibleRows.length < 2) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2) || Math.abs(rawGx2 - rawGx1) < 60) {
                continue
            }

            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue

            const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const footer = getGeneFooterGeometry({
                gene,
                txs,
                getEffectiveTranscriptLimit,
                visibleTranscriptCount: displayRows.length,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue

            footers.push({
                ...footer,
                // An expanded footer is one horizontal unit: label, then X.
                controlY: footer.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET,
                geneId: String(gene.id),
                label: String(gene.name || gene.id || '').trim(),
                trackBackground: isForward ? colors.forwardStrandBg : colors.reverseStrandBg,
            })
        }
        return footers
    }, [genes, compressTranscripts, isViewportTranscriptExpandMode, flattenTracks, isGeneHiddenFromTracks,
        transcriptCache, getDisplayTranscriptRows, genomicToScreen, effectiveHiddenStrands, layout,
        transcriptLayoutMetrics, getEffectiveTranscriptLimit, viewWidth, colors.forwardStrandBg,
        colors.reverseStrandBg])

    const hasExpandedGeneFooters = expandedGeneFooters.length > 0
    useLayoutEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !hasExpandedGeneFooters) {
            setExpandedFooterViewport((prev) => (prev === null ? prev : null))
            return undefined
        }

        const scrollElement = findNearestScrollable(canvas)
        let frameId = null

        const updateViewport = () => {
            frameId = null
            const canvasRect = canvas.getBoundingClientRect()
            const scrollRect = scrollElement?.getBoundingClientRect?.() || null
            const visibleTopClient = Math.max(
                0,
                canvasRect.top,
                Number.isFinite(scrollRect?.top) ? scrollRect.top : 0,
            )
            const visibleBottomClient = Math.min(
                window.innerHeight,
                canvasRect.bottom,
                Number.isFinite(scrollRect?.bottom) ? scrollRect.bottom : window.innerHeight,
            )
            const next = visibleBottomClient > visibleTopClient
                ? {
                    top: Math.max(0, visibleTopClient - canvasRect.top),
                    bottom: Math.max(0, visibleBottomClient - canvasRect.top),
                }
                : null

            setExpandedFooterViewport((prev) => {
                if (prev === null || next === null) return prev === next ? prev : next
                if (Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.bottom - next.bottom) < 0.5) return prev
                return next
            })
        }

        const scheduleViewportUpdate = () => {
            if (frameId !== null) return
            frameId = window.requestAnimationFrame(updateViewport)
        }

        updateViewport()
        scrollElement?.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
        window.addEventListener('scroll', scheduleViewportUpdate, { passive: true, capture: true })
        window.addEventListener('resize', scheduleViewportUpdate, { passive: true })

        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(scheduleViewportUpdate)
            : null
        resizeObserver?.observe(canvas)
        if (scrollElement) resizeObserver?.observe(scrollElement)

        return () => {
            if (frameId !== null) window.cancelAnimationFrame(frameId)
            scrollElement?.removeEventListener('scroll', scheduleViewportUpdate)
            window.removeEventListener('scroll', scheduleViewportUpdate, { capture: true })
            window.removeEventListener('resize', scheduleViewportUpdate)
            resizeObserver?.disconnect()
        }
    }, [hasExpandedGeneFooters])

    const expandedFooterPlacementByGeneId = useMemo(() => {
        const placements = new Map()
        for (const footer of expandedGeneFooters) {
            placements.set(footer.geneId, {
                ...placeGeneFooterWithinViewport(footer, expandedFooterViewport),
                geneId: footer.geneId,
                label: footer.label,
                trackBackground: footer.trackBackground,
            })
        }
        return placements
    }, [expandedGeneFooters, expandedFooterViewport])
    const expandedFooterGeneIds = useMemo(
        () => new Set(expandedGeneFooters.map((footer) => footer.geneId)),
        [expandedGeneFooters],
    )

    const applyAdaptiveScrollAnchor = useCallback(() => {
        const anchor = adaptiveScrollAnchorRef.current
        const root = rootRef.current
        if (!anchor || !root) {
            adaptiveScrollAnchorRef.current = null
            return false
        }
        if (performance.now() > anchor.expiresAt) {
            adaptiveScrollAnchorRef.current = null
            return false
        }

        // If anything other than this anchor moved the page — the user grabbing the
        // scrollbar, a wheel over the margin — release it rather than fight them.
        const scrollTopNow = readAnchorScrollTop(anchor.scrollElement)
        if (anchor.lastScrollTop != null && Math.abs(scrollTopNow - anchor.lastScrollTop) > 0.5) {
            adaptiveScrollAnchorRef.current = null
            return false
        }

        const currentTop = root.getBoundingClientRect().top
        const deltaY = currentTop - anchor.rootTop
        if (Math.abs(deltaY) > 0.5) {
            if (anchor.scrollElement && anchor.scrollElement !== document.documentElement && anchor.scrollElement !== document.body) {
                anchor.scrollElement.scrollTop += deltaY
            } else {
                window.scrollBy(0, deltaY)
            }
            anchor.rootTop = root.getBoundingClientRect().top
        }
        anchor.lastScrollTop = readAnchorScrollTop(anchor.scrollElement)
        return true
    }, [])

    const scheduleAdaptiveScrollAnchor = useCallback(() => {
        if (adaptiveScrollAnchorFrameRef.current !== null) return
        const tick = () => {
            adaptiveScrollAnchorFrameRef.current = null
            if (applyAdaptiveScrollAnchor()) {
                adaptiveScrollAnchorFrameRef.current = requestAnimationFrame(tick)
            }
        }
        adaptiveScrollAnchorFrameRef.current = requestAnimationFrame(tick)
    }, [applyAdaptiveScrollAnchor])

    /**
     * Drop both imperative scroll anchors immediately.
     *
     * The adaptive panel anchor pins the panel's top for 700ms on a rAF loop,
     * and the transcript-row zoom anchor scrolls the page to keep the hovered
     * row under the cursor. Either one left running while the page scrolls
     * natively spends a frame or two fighting it, which reads as judder — and
     * in the scroll-first schemes that happens on every single wheel event.
     */
    const releaseScrollAnchors = useCallback(() => {
        adaptiveScrollAnchorRef.current = null
        verticalZoomTrackAnchorRef.current = null
        if (adaptiveScrollAnchorFrameRef.current !== null) {
            cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
            adaptiveScrollAnchorFrameRef.current = null
        }
    }, [])

    const captureAdaptiveScrollAnchor = useCallback(() => {
        if (!rootRef.current) return
        const scrollElement = findNearestScrollable(rootRef.current) || document.scrollingElement || document.documentElement
        adaptiveScrollAnchorRef.current = {
            rootTop: rootRef.current.getBoundingClientRect().top,
            scrollElement,
            lastScrollTop: readAnchorScrollTop(scrollElement),
            expiresAt: performance.now() + 700,
        }
        scheduleAdaptiveScrollAnchor()
    }, [scheduleAdaptiveScrollAnchor])

    useEffect(() => {
        return () => {
            if (adaptiveScrollAnchorFrameRef.current !== null) {
                cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
                adaptiveScrollAnchorFrameRef.current = null
            }
        }
    }, [])

    const canVerticallyScrollContainer = useCallback(() => {
        return scrollTargetRef.current !== null
    }, [])

    const handleMouseDown = (e) => {
        e.preventDefault() // Prevent browser text-selection on drag
        // preventDefault also suppresses the default focus, so take it
        // explicitly or keyboard navigation never reaches the clicked panel.
        // preventScroll matters: without it the page jumps and fights the
        // adaptive scroll anchor.
        containerRef.current?.focus({ preventScroll: true })
        setSidebarTooltip(null)
        dismissCustomTrackTooltip()
        hoveredSpliceRef.current = null
        setHoveredSpliceJunction(null)
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }

        const canvas = canvasRef.current
        if (canvas) {
            const rect = canvas.getBoundingClientRect()
            const clickX = e.clientX - rect.left
            const clickY = e.clientY - rect.top

            // One-shot rectangular selection mode for box-zoom.
            if (isBoxSelectMode) {
                if (clickX <= LHS_WIDTH) return
                suppressNextClickRef.current = true
                setIsSelectingRect(true)
                setSelectionRect({ x1: clickX, y1: clickY, x2: clickX, y2: clickY })
                return
            }

            // Intercept sidebar toggling or dragging
            if (clickX <= LHS_WIDTH) {
                // A step that limits the browser to zooming means it: the gutter switches
                // a track off and its handle reorders the stack, and neither is zooming.
                // The user who was told they could only zoom should not be able to blank
                // the track by clicking a little to the left of it.
                if (interactionModeRef.current !== 'all') return
                const trackId = getTrackAtY(clickY)

                // Circular hit test around the toggle glyph. The radius is
                // deliberately larger than the glyph so shrinking it did not make
                // the control harder to hit.
                const toggleCenterX = LHS_WIDTH - 13
                const hitRadiusSq = SIDEBAR_TOGGLE_HIT_RADIUS * SIDEBAR_TOGGLE_HIT_RADIUS
                const dxSq = (clickX - toggleCenterX) ** 2
                const hitsToggle = (centerY) => dxSq + (clickY - centerY) ** 2 <= hitRadiusSq

                let toggleTrackId = null
                if (layout.forwardBgHeight > 0 && hitsToggle(layout.FORWARD_Y + layout.forwardBgHeight / 2)) {
                    toggleTrackId = 'forward'
                } else if (layout.reverseBgHeight > 0 && hitsToggle(layout.REVERSE_Y + layout.reverseBgHeight / 2)) {
                    toggleTrackId = 'reverse'
                } else if (showSequenceTrack && layout.SEQUENCE_Y >= 0 && hitsToggle(layout.SEQUENCE_Y + layout.seqBgHeight / 2)) {
                    toggleTrackId = 'sequence'
                } else if (layout.customTrackLayouts) {
                    for (const [tid, tLayout] of Object.entries(layout.customTrackLayouts)) {
                        if (tLayout.joinedRowId) continue
                        if (hitsToggle(getCustomTrackToggleY(tLayout))) { toggleTrackId = tid; break }
                    }
                    for (const [rid, rLayout] of Object.entries(layout.groupRowLayouts || {})) {
                        if (toggleTrackId) break
                        if (hitsToggle(getCustomTrackToggleY(rLayout))) toggleTrackId = rid
                    }
                }

                if (toggleTrackId === 'forward') {
                    setHiddenStrands(prev => ({ ...prev, forward: !prev.forward }))
                    return
                } else if (toggleTrackId === 'reverse') {
                    setHiddenStrands(prev => ({ ...prev, reverse: !prev.reverse }))
                    return
                } else if (toggleTrackId === 'sequence') {
                    setHiddenStrands(prev => ({ ...prev, sequence: !prev.sequence }))
                    return
                } else if (toggleTrackId && isCustomTrackId(toggleTrackId)) {
                    setCustomTracks((prev) =>
                        prev.map((track) =>
                            track.id === toggleTrackId
                                ? { ...track, visible: !track.visible }
                                : track
                        )
                    )
                    return
                } else if (toggleTrackId && isGroupRowId(toggleTrackId)) {
                    // A joined group turns on and off as one.
                    const turnOn = Boolean(joinedRows.get(toggleTrackId)?.hidden)
                    setCustomTracks((prev) => prev.map((track) => (
                        track.joinedRowId === toggleTrackId ? { ...track, visible: turnOn } : track
                    )))
                    return
                }

                // If not a toggle, initiate drag-and-drop
                if (trackId) {
                    setDraggingTrack(trackId)
                }

                return // Handled LHS interaction
            }

            // Start splice-arc vertical drag mode (separate from viewport pan).
            const customHover = getCustomTrackHover(clickX, clickY, e.clientX, e.clientY)
            if (customHover?.hoverSplice?.junction) {
                const hit = customHover.hoverSplice
                const junctionKey = spliceJunctionKey(hit.junction)
                const mapKey = `${hit.trackId}|${junctionKey}`
                spliceArcDragRef.current = {
                    trackId: hit.trackId,
                    key: junctionKey,
                    startClientY: e.clientY,
                    initialLift: Number(spliceArcLiftOffsets[mapKey] || 0),
                }
            } else {
                spliceArcDragRef.current = null
            }
        }

        setIsDragging(true)
        isDraggingRef.current = true
        dragStartXRef.current = e.clientX
        // Anchor on the live viewport, not the last committed render: a pan that
        // starts mid-flight would otherwise measure its progress from a stale start.
        dragViewStartRef.current = viewStartRef.current
        dragStartYRef.current = e.clientY
        dragAxisRef.current = null
        const scrollTarget = findNearestScrollable(containerRef.current)
        scrollTargetRef.current = scrollTarget
        dragScrollTopRef.current = scrollTarget ? scrollTarget.scrollTop : 0
        lastPosRef.current = e.clientX
        lastTimeRef.current = performance.now()
        velocityRef.current = 0
    }

    const updateSelectionRectFromEvent = useCallback((e) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = Math.max(LHS_WIDTH, Math.min(viewWidth, e.clientX - rect.left))
        // Keep y unclamped so dragging off-canvas (e.g. onto secondary browser) continues naturally.
        const y = e.clientY - rect.top
        setSelectionRect(prev => prev ? { ...prev, x2: x, y2: y } : prev)
    }, [viewWidth])

    // Returns info about the sequence base under canvas coords (mouseX, mouseY), or null.
    const getSeqBaseAtMouse = useCallback((mouseX, mouseY) => {
        if (!showSequenceTrack || effectiveHiddenStrands.sequence) return null
        const { SEQUENCE_Y } = layout
        const seqBoxT = Math.round(SEQUENCE_Y + 6)
        const seqBoxH = 24
        if (mouseY < seqBoxT || mouseY > seqBoxT + seqBoxH) return null
        const trackW = viewWidth - LHS_WIDTH
        const pxPerBp = trackW / Math.max(1, viewEnd - viewStart)
        if (pxPerBp < 2) return null

        if (isAligned && alignData && viewSpan <= 1000) {
            const overlayPos = isFlipped
                ? viewEnd - (mouseX - LHS_WIDTH) / pxPerBp
                : viewStart + (mouseX - LHS_WIDTH) / pxPerBp
            const i = Math.floor(overlayPos)
            const alnLen = alignData.sequence.length
            let base = null
            if (i >= 0 && i < alnLen) {
                base = alignData.sequence[i]
            } else if (sequence && seqRange) {
                const genomicBp = Math.round(overlayToGenomic(i))
                const seqIdx = genomicBp - seqRange.start
                if (seqIdx >= 0 && seqIdx < sequence.length) {
                    base = sequence[seqIdx]
                    if (alignData.strand === '-') base = REV_COMP[base] || base
                }
            }
            if (!base || base === '-') return null
            const displayBase = isFlipped ? (REV_COMP[base] || base) : base
            const { bxL, bxR } = getBasePixelBounds(i, pxPerBp)
            const bp = Math.round(overlayToGenomic(i))
            return { bp, base: displayBase.toUpperCase(), bxL, bxR, seqBoxT, seqBoxH }
        } else if (sequence && seqRange && viewSpan <= 1000) {
            const overlayPos = isFlipped
                ? viewEnd - (mouseX - LHS_WIDTH) / pxPerBp
                : viewStart + (mouseX - LHS_WIDTH) / pxPerBp
            const bp = Math.floor(overlayPos)
            const seqIdx = bp - seqRange.start
            if (seqIdx < 0 || seqIdx >= sequence.length) return null
            const base = sequence[seqIdx]
            if (!base) return null
            const displayBase = isFlipped ? (REV_COMP[base] || base) : base
            const { bxL, bxR } = getBasePixelBounds(bp, pxPerBp)
            return { bp, base: displayBase.toUpperCase(), bxL, bxR, seqBoxT, seqBoxH }
        }
        return null
    }, [showSequenceTrack, effectiveHiddenStrands, layout, viewWidth, viewEnd, viewStart, viewSpan,
        isAligned, alignData, sequence, seqRange, isFlipped, overlayToGenomic, getBasePixelBounds])

    const handleMouseMove = useCallback((...args) => handleBrowserMouseMove({
        canVerticallyScrollContainer,
        canvasRef,
        captureAdaptiveScrollAnchor,
        clearTranscriptPopupDismissTimer,
        clickedGeneTranscript,
        clickedSeqBase,
        dismissCustomTrackTooltip,
        dragAxisRef,
        dragScrollTopRef,
        dragStartXRef,
        dragStartYRef,
        dragViewStartRef,
        draggingTrack,
        focusTranscriptView,
        focusViewGeneId,
        getCustomTrackHover,
        getSelectedGeneTranscriptHit,
        getSeqBaseAtMouse,
        getTrackAtY,
        getTrackTooltip,
        hoveredBigBedRef,
        hoveredSeqBaseRef,
        hoveredSpliceRef,
        hoveredVcfBlockRef,
        isDraggingRef,
        isFlipped,
        isSelectingRect,
        lastPosRef,
        lastTimeRef,
        onFocusTranscriptViewChangeRef,
        panByPx,
        queueCustomTrackTooltip,
        scheduleTranscriptPopupDismiss,
        scrollTargetRef,
        setClickedSeqBase,
        setHoveredBigBedFeature,
        setHoveredSeqBase,
        setHoveredSpliceJunction,
        setHoveredVcfBlock,
        setSidebarTooltip,
        setSpliceArcLiftOffsets,
        spliceArcDragRef,
        suppressNextClickRef,
        transcriptPopupHoverRef,
        updateSelectionRectFromEvent,
        velocityRef,
        viewEndRef,
        viewStartRef,
        viewWidth,
    }, ...args), [viewWidth, panByPx, layout, isFlipped, isSelectingRect, updateSelectionRectFromEvent, getTrackAtY, getTrackTooltip, getCustomTrackHover, getSeqBaseAtMouse, clickedSeqBase, dismissCustomTrackTooltip, queueCustomTrackTooltip, draggingTrack, clickedGeneTranscript, getSelectedGeneTranscriptHit, focusViewGeneId, focusTranscriptView?.hoverId, clearTranscriptPopupDismissTimer, scheduleTranscriptPopupDismiss, canVerticallyScrollContainer, captureAdaptiveScrollAnchor])

    const handleMouseUp = useCallback(() => {
        if (isSelectingRect) {
            const rect = selectionRect
            setIsSelectingRect(false)
            setSelectionRect(null)
            setIsBoxSelectMode(false) // one-shot mode

            if (!rect) return

            const minX = Math.max(LHS_WIDTH, Math.min(rect.x1, rect.x2))
            const maxX = Math.max(LHS_WIDTH, Math.max(rect.x1, rect.x2))
            const minY = Math.min(rect.y1, rect.y2)
            const maxY = Math.max(rect.y1, rect.y2)

            const hitsAnyTrack = layout.orderedTracks.some((track) => (
                maxY >= track.y && minY <= (track.y + track.height)
            ))

            if (hitsAnyTrack && (maxX - minX) > 2) {
                const v1 = screenToViewCoord(minX)
                const v2 = screenToViewCoord(maxX)
                let nextStart = Math.min(v1, v2)
                let nextEnd = Math.max(v1, v2)
                if (nextEnd <= nextStart) nextEnd = nextStart + 1

                // What the user dragged out is now the location of focus. Zoomed to
                // slightly wider than the box so its boundary lines land inside the
                // view instead of on its edges, and framed clear of the drawer that
                // taking focus slides over this panel's right edge.
                const selectedSpan = nextEnd - nextStart
                const flank = (selectedSpan / BOX_SELECT_FILL_FRACTION - selectedSpan) / 2
                focusLocation({
                    chrom: selectedChrom,
                    start: Math.round(isAligned ? overlayToGenomic(nextStart) : nextStart),
                    end: Math.round(isAligned ? overlayToGenomic(nextEnd) : nextEnd),
                })
                const framedBox = frameFocusRange(nextStart - flank, nextEnd + flank, { gainingFocus: true })
                animateToView(framedBox.start, framedBox.end, 300)
            }
            return
        }

        if (!isDraggingRef.current) return
        isDraggingRef.current = false
        if (spliceArcDragRef.current) {
            spliceArcDragRef.current = null
            setIsDragging(false)
            dragAxisRef.current = null
            velocityRef.current = 0
            return
        }
        const wasVertical = dragAxisRef.current === 'y'
        setIsDragging(false)
        dragAxisRef.current = null
        if (!wasVertical) startMomentum()
    }, [startMomentum, isSelectingRect, selectionRect, layout, showSequenceTrack, screenToViewCoord, animateToView, focusLocation, frameFocusRange, selectedChrom, isAligned, overlayToGenomic])

    // While box-selecting, keep tracking even if cursor leaves this browser.
    useEffect(() => {
        if (!isSelectingRect) return
        const handleGlobalMove = (e) => updateSelectionRectFromEvent(e)
        const handleGlobalUp = () => handleMouseUp()
        window.addEventListener('mousemove', handleGlobalMove)
        window.addEventListener('mouseup', handleGlobalUp)
        return () => {
            window.removeEventListener('mousemove', handleGlobalMove)
            window.removeEventListener('mouseup', handleGlobalUp)
        }
    }, [isSelectingRect, updateSelectionRectFromEvent, handleMouseUp])

    useEffect(() => {
        if (!isDragging || isSelectingRect || draggingTrack) return
        const handleGlobalDragMove = (e) => handleMouseMove(e)
        const handleGlobalDragUp = () => handleMouseUp()
        window.addEventListener('mousemove', handleGlobalDragMove)
        window.addEventListener('mouseup', handleGlobalDragUp)
        return () => {
            window.removeEventListener('mousemove', handleGlobalDragMove)
            window.removeEventListener('mouseup', handleGlobalDragUp)
        }
    }, [isDragging, isSelectingRect, draggingTrack, handleMouseMove, handleMouseUp])

    const handleContainerMouseLeave = useCallback(() => {
        // Do not auto-release while box-selecting; release is handled by global mouseup.
        if (isSelectingRect) return
        // Read the ref, not the state: leaving the panel in the first frame of a
        // drag must not tear the drag down before the global listeners attach.
        if (isDraggingRef.current) return
        setSidebarTooltip(null)
        dismissCustomTrackTooltip()
        if (hoveredVcfBlockRef.current) {
            hoveredVcfBlockRef.current = null
            setHoveredVcfBlock(null)
        }
        if (hoveredSeqBaseRef.current) {
            hoveredSeqBaseRef.current = null
            setHoveredSeqBase(null)
        }
        if (hoveredSpliceRef.current) {
            hoveredSpliceRef.current = null
            setHoveredSpliceJunction(null)
        }
        if (hoveredBigBedRef.current) {
            hoveredBigBedRef.current = null
            setHoveredBigBedFeature(null)
        }
        scheduleTranscriptPopupDismiss(80)
        handleMouseUp()
    }, [isSelectingRect, handleMouseUp, dismissCustomTrackTooltip, scheduleTranscriptPopupDismiss])

    useEffect(() => {
        if (draggingTrack || isDragging || isSelectingRect) {
            dismissCustomTrackTooltip()
        }
    }, [draggingTrack, isDragging, isSelectingRect, dismissCustomTrackTooltip])

    useEffect(() => {
        if (!draggingTrack) return

        const handleGlobalMouseMove = (e) => {
            const canvas = canvasRef.current
            if (!canvas) return
            const rect = canvas.getBoundingClientRect()
            const mouseY = e.clientY - rect.top
            setHoveredTrack(getTrackAtY(mouseY))
        }

        const handleGlobalMouseUp = () => {
            if (hoveredTrack && hoveredTrack !== draggingTrack) {
                setTrackOrder(prev => {
                    const newOrder = [...prev]
                    const fromIdx = newOrder.indexOf(draggingTrack)
                    const toIdx = newOrder.indexOf(hoveredTrack)
                    if (fromIdx === -1 || toIdx === -1) return prev
                    newOrder.splice(fromIdx, 1)
                    newOrder.splice(toIdx, 0, draggingTrack)
                    return newOrder
                })
            }
            setDraggingTrack(null)
            setHoveredTrack(null)
        }

        window.addEventListener('mousemove', handleGlobalMouseMove)
        window.addEventListener('mouseup', handleGlobalMouseUp)

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove)
            window.removeEventListener('mouseup', handleGlobalMouseUp)
        }
    }, [draggingTrack, hoveredTrack, layout, getTrackAtY])

    // Wheel handler
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const handleWheel = (e) => {
            // A dialog over the tracks scrolls itself and never zooms them.
            if (isWheelInsideIsolatedOverlay(e)) return
            // A gesture that began on a control bar or in the page margins is a
            // page scroll. Scrolling slides this canvas under the cursor, so
            // without this the rest of the gesture would turn into a zoom.
            if (isWheelGestureFromChrome(e)) {
                markWheelHandled(e)
                return
            }
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }
            velocityRef.current = 0
            dismissCustomTrackTooltip()

            const rect = container.getBoundingClientRect()
            const cursorX = e.clientX - rect.left

            // Line/page deltas are normalised to pixels before any thresholding,
            // or Firefox and Linux mice (deltaMode 1) are ~30x weaker.
            const wheel = readWheelEvent(e, { pageHeight: rect.height || undefined })
            const gesture = beginWheelGesture(wheelGestureRef.current, wheel, e.timeStamp)

            const currentSpan = viewEndRef.current - viewStartRef.current
            const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
                atMaxZoom: currentSpan >= MAX_VIEW_SPAN - 1e-6,
                canScrollPage: Boolean(findNearestScrollable(container)),
                gesture,
            })

            wheelGestureRef.current = { ...gesture, mode: intent.nextGestureMode }
            // Tell the view-level fallback listener this panel has seen the
            // event, even when the outcome is "do nothing". Must happen before
            // any early return.
            markWheelHandled(e)

            if (intent.preventDefault) e.preventDefault()
            if (intent.stopPropagation) e.stopPropagation()
            if (intent.releaseScrollAnchors) releaseScrollAnchors()

            // 'page_scroll' is handled by doing nothing at all: the event was
            // not prevented, so the browser scrolls the ancestor scroller with
            // its own inertia.
            if (intent.type === 'page_scroll' || intent.type === 'none') return

            if (intent.type === 'pan') {
                verticalZoomTrackAnchorRef.current = null
                if (intent.captureScrollAnchor) captureAdaptiveScrollAnchor()
                panByPx(intent.dxPx)
                return
            }

            if (intent.type !== 'zoom') return

            const mouseY = e.clientY - rect.top + container.scrollTop
            const targetTrack = getTrackAtY(mouseY)

            const now = performance.now()
            const existingGeneAnchor = verticalZoomTrackAnchorRef.current
            const hasActiveGeneAnchor = Boolean(existingGeneAnchor && now <= existingGeneAnchor.expiresAt)
            if (hasActiveGeneAnchor) {
                // Layout changes can move the pointer over another track during
                // a rapid wheel gesture. Keep following the feature row where
                // the gesture began until wheel input pauses.
                existingGeneAnchor.expiresAt = now + 450
            } else {
                const featureAnchor = getGeneFeatureVerticalAnchor(cursorX, mouseY, targetTrack)
                verticalZoomTrackAnchorRef.current = featureAnchor
                    ? {
                        ...featureAnchor,
                        viewportY: e.clientY - rect.top,
                        clientY: e.clientY,
                        expiresAt: now + 450,
                    }
                    : null
            }

            if (verticalZoomTrackAnchorRef.current) {
                adaptiveScrollAnchorRef.current = null
                if (adaptiveScrollAnchorFrameRef.current !== null) {
                    cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
                    adaptiveScrollAnchorFrameRef.current = null
                }
            } else if (intent.captureScrollAnchor) {
                captureAdaptiveScrollAnchor()
            }

            const anchorX = intent.anchor === 'center' ? (LHS_WIDTH + viewWidthRef.current) / 2 : cursorX
            zoomAt(anchorX, intent.factor, targetTrack)
        }

        container.addEventListener('wheel', handleWheel, { passive: false })
        return () => container.removeEventListener('wheel', handleWheel)
    }, [zoomAt, panByPx, getTrackAtY, getGeneFeatureVerticalAnchor, dismissCustomTrackTooltip, captureAdaptiveScrollAnchor, releaseScrollAnchors])

    // ============ Click Handler (gene selection & pill expansion) ============

    // ============ Click Handler (gene selection & pill expansion) ============

    const handleCanvasClick = useCallback((...args) => handleBrowserCanvasClick({
        alignData,
        animateToView,
        canvasRef,
        clearTranscriptPopupDismissTimer,
        clickedBigBedFeature,
        clickedGeneTranscript,
        clickedSeqBase,
        clickedSpliceJunction,
        clickedVcfVariant,
        customTrackData,
        customTracksById,
        dismissClickedGeneTranscript,
        effectiveHiddenStrands,
        focusTranscriptView,
        frameFocusRange,
        genes,
        genomicToOverlay,
        genomicToScreen,
        getCustomTrackGeometry,
        getCustomTrackHover,
        getGeneRowCountForWidth,
        getGeneTotalHeight,
        getSelectedGeneTranscriptHit,
        getSeqBaseAtMouse,
        isAligned,
        isBoxSelectMode,
        isGeneHiddenFromTracks,
        isSelectingRect,
        layout,
        onFocusTranscriptViewChangeRef,
        pendingVerticalCenterGeneIdRef,
        selectedChrom,
        selectedGene,
        setClickedBigBedFeature,
        setClickedGeneTranscript,
        setClickedSeqBase,
        setClickedSpliceJunction,
        setClickedVcfVariant,
        setSelectedGene,
        suppressNextClickRef,
        transcriptLayoutMetrics,
        transcriptPopupHoverRef,
        viewEnd,
        viewStart,
        viewWidth,
    }, ...args), [
        genes,
        layout,
        genomicToScreen,
        isBoxSelectMode,
        isSelectingRect,
        getTrackAtY,
        selectedGene,
        isAligned,
        alignData,
        genomicToOverlay,
        animateToView,
        frameFocusRange,
        getCustomTrackHover,
        getCustomTrackGeometry,
        customTracksById,
        viewStart,
        viewEnd,
        viewWidth,
        selectedChrom,
        clickedVcfVariant,
        clickedBigBedFeature,
        clickedSpliceJunction,
        clickedSeqBase,
        clickedGeneTranscript,
        getSeqBaseAtMouse,
        getGeneRowCountForWidth,
        getGeneTotalHeight,
        transcriptLayoutMetrics,
        getSelectedGeneTranscriptHit,
        clearTranscriptPopupDismissTimer,
        dismissClickedGeneTranscript,
        isGeneHiddenFromTracks,
        effectiveHiddenStrands,
    ])

    // ============ Canvas Rendering ============

    // The height this panel needs for its own tracks, independent of any shared
    // band height handed down from the parent — so reporting it upward cannot feed
    // back into itself. Quantised so a pan that nudges a row by a pixel does not
    // renegotiate the shared height every frame.
    const naturalCanvasHeight = useMemo(() => {
        const { FORWARD_Y, REVERSE_Y, forwardBgHeight, reverseBgHeight, orderedTracks } = layout
        const lastTrackY = orderedTracks.length
            ? Math.max(...orderedTracks.map((track) => track.y + track.height))
            : Math.max(FORWARD_Y + forwardBgHeight, REVERSE_Y + reverseBgHeight)
        const alignTracksToBottom = effectiveTrackAlign === 'bottom' && !compactPanelHeight
        // Use +10 padding unless flush alignment is requested
        const bottomPadding = (alignTracksToBottom || compactPanelHeight) ? 0 : 10
        const totalHeight = lastTrackY
            + (effectiveRulerPosition === 'top' ? bottomPadding : effectiveRulerHeight + bottomPadding)
        return Math.max(1, Math.ceil(totalHeight / 8) * 8)
    }, [layout, effectiveTrackAlign, compactPanelHeight, effectiveRulerPosition, effectiveRulerHeight])

    useEffect(() => {
        onContentHeightChangeRef.current?.(naturalCanvasHeight)
    }, [naturalCanvasHeight])

    // Preserve page geometry even when the bitmap is not being repainted.
    // Scroll/cycle targets and shared panel heights still follow current data.
    useLayoutEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.style.width = `${viewWidth}px`
        canvas.style.height = `${Math.max(naturalCanvasHeight, Number(minCanvasHeight) || 0)}px`
    }, [viewWidth, naturalCanvasHeight, minCanvasHeight])

    const paintCanvas = useCallback((...args) => paintBrowserCanvas({
        alignData,
        alignmentCoords,
        anchorIconImgRef,
        bigWigZoneScales,
        bpPerPx,
        canvasRef,
        clickedBigBedFeature,
        clickedSpliceJunction,
        clickedVcfVariant,
        colors,
        compressTranscripts,
        customTrackData,
        customTrackLoading,
        customTracksById,
        dimNonSelectedGenes,
        draggingTrack,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        expandedFooterGeneIds,
        flattenTracks,
        focusLocationRange,
        focusTranscriptView,
        formatSignalValue,
        genes,
        genomicToScreen,
        getBasePixelBounds,
        getCustomTrackGeometry,
        getCustomTrackIntervalPixelBounds,
        getCustomTrackToggleY,
        getDisplayTranscriptRows,
        getEffectiveTranscriptLimit,
        getGenomicIntervalPixelBounds,
        getSpliceLodMode,
        hoveredBigBedFeature,
        hoveredSeqBase,
        hoveredSpliceJunction,
        hoveredTrack,
        hoveredVcfBlock,
        isAligned,
        isCompressedLayoutActive,
        isCustomTrackId,
        isFlipped,
        isLight,
        isLocationFocusVisible,
        isPrimaryPanel,
        isTranscriptCompressionActive,
        layout,
        minCanvasHeight,
        naturalCanvasHeight,
        overlayToGenomic,
        panelExonColor,
        panelPillColor,
        selectedGene,
        selectionRect,
        seqRange,
        sequence,
        sequenceTrackLabel,
        shouldForceGeneBlockView,
        showSequenceTrack,
        sidebarToggleIconColor,
        spliceArcLiftOffsets,
        trackOrder,
        trackWidth,
        transcriptCache,
        transcriptLayoutMetrics,
        viewEnd,
        viewSpan,
        viewStart,
        viewWidth,
    }, ...args), [viewStart, viewEnd, viewWidth, genes, selectedGene, focusLocationRange, isLocationFocusVisible, expandedGenes, transcriptCache, sequence, seqRange, theme, colors, genomicToScreen, showSequenceTrack, sequenceTrackLabel, layout, effectiveHiddenStrands, draggingTrack, hoveredTrack, isAligned, alignData, bpPerPx, selectionRect, customTracksById, customTrackData, customTrackLoading, isCustomTrackId, formatSignalValue, getCustomTrackGeometry, getSpliceLodMode, isPrimaryPanel, panelExonColor, panelPillColor, sidebarToggleIconColor, hoveredVcfBlock, hoveredSpliceJunction, hoveredBigBedFeature, clickedVcfVariant, clickedSpliceJunction, clickedBigBedFeature, hoveredSeqBase, overlayToGenomic, getBasePixelBounds, getGenomicIntervalPixelBounds, getCustomTrackIntervalPixelBounds, bigWigZoneScales, spliceArcLiftOffsets, anchorIconReady, getDisplayTranscriptsForGene, getDisplayTranscriptRows, focusTranscriptView, getEffectiveTranscriptLimit, getGeneTotalHeight, transcriptLayoutMetrics, isTranscriptCompressionActive, isCompressedLayoutActive, flattenTracks, compactPanelHeight, effectiveTrackAlign, effectiveRulerPosition, effectiveRulerHeight, naturalCanvasHeight, minCanvasHeight, expandedFooterGeneIds,
        // Read by the painter but missing before it became a callback. An effect
        // re-reads them whenever it runs; a memoized painter called on scroll-in or
        // export would otherwise draw with whatever they were at its last change.
        alignmentCoords, compressTranscripts, dimNonSelectedGenes, getCustomTrackToggleY, isFlipped, isLight,
        shouldForceGeneBlockView, trackOrder, trackWidth, viewSpan])

    useLayoutEffect(() => {
        paintCanvasRef.current = paintCanvas
    }, [paintCanvas])

    useEffect(() => {
        if (isActive && nearViewport) paintCanvas()
    }, [isActive, nearViewport, paintCanvas])

    useEffect(() => {
        onNearViewportChange?.(nearViewport)
    }, [nearViewport, onNearViewportChange])

    useLayoutEffect(() => {
        const anchor = verticalZoomTrackAnchorRef.current
        const container = containerRef.current
        if (!anchor || !container) return
        if (performance.now() > anchor.expiresAt) {
            verticalZoomTrackAnchorRef.current = null
            return
        }

        const contentY = getGeneFeatureVerticalTargetY(anchor)
        if (!Number.isFinite(contentY)) {
            verticalZoomTrackAnchorRef.current = null
            return
        }

        const deltaY = getAnchoredContentPageScrollDelta({
            containerTop: container.getBoundingClientRect().top,
            contentY,
            clientY: anchor.clientY,
        })
        if (Number.isFinite(deltaY) && Math.abs(deltaY) > 0.5) {
            const scrollElement = findNearestScrollable(rootRef.current)
                || document.scrollingElement
                || document.documentElement
            if (scrollElement && scrollElement !== document.documentElement && scrollElement !== document.body) {
                scrollElement.scrollTop += deltaY
            } else {
                window.scrollBy(0, deltaY)
            }
        }
    }, [getGeneFeatureVerticalTargetY, viewStart, viewEnd])

    // Expose view state upward for shared sequence strip
    useEffect(() => {
        if (onViewStateRef.current) {
            onViewStateRef.current({ sequence, seqRange, viewStart, viewEnd, viewWidth, genomicToScreen, colors })
        }
    }, [sequence, seqRange, viewStart, viewEnd, viewWidth, genomicToScreen, colors])

    // ============ Transcript footer controls (HTML overlay) ============

    const CONTROL_GAP_PX = 4

    const transcriptFooterOverlay = useMemo(() => {
        const controls = []
        // Flatten is a *height* control, not a "hide the gene's own controls" one: a gene
        // whose transcripts are showing still needs the way back, and a tutorial step
        // pointing at that control found nothing there. Compressed and window-wide-expanded
        // layouts do drop it — the first has no room, and in the second every gene is
        // expanded already, so a per-gene pill would be saying something untrue.
        if (compressTranscripts || isViewportTranscriptExpandMode) {
            return { controls }
        }
        const { FORWARD_Y, REVERSE_Y, RULER_Y } = layout

        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue
            const isSelected = selectedGene && selectedGene.id === gene.id
            const isDimmed = dimNonSelectedGenes && !!selectedGene && !isSelected

            const txs = transcriptCache[gene.id]
            if (!txs || txs.length === 0) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const geneWidth = Math.abs(rawGx2 - rawGx1)
            if (geneWidth < 60) continue

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const displayRows = getDisplayTranscriptRows(gene)
            const footer = getGeneFooterGeometry({
                gene,
                txs,
                getEffectiveTranscriptLimit,
                visibleTranscriptCount: displayRows.length,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue
            const displayFooter = expandedFooterPlacementByGeneId.get(String(gene.id)) || footer

            // Transcripts the user has hidden aren't waiting to be revealed by
            // this pill, so they don't count towards its "+N".
            const geneView = getGeneTranscriptView(gene.id)
            const transcriptIds = new Set(txs.map((tx) => String(tx?.id || '')))
            const hiddenIds = (geneView?.hidden || [])
                .map((id) => String(id))
                .filter((id) => transcriptIds.has(id))
            const expandableCount = hiddenIds.length
                ? resolveGeneTranscriptView({
                    transcripts: txs,
                    limit: txs.length,
                    hidden: hiddenIds,
                }).visibleCount
                : txs.length
            const controlState = getTranscriptFooterControlState(
                expandableCount,
                displayRows.filter((row) => !row.ghost).length,
            )
            // A gene with everything hidden has no expand/collapse control left,
            // but still needs the way back — so neither control alone is required.
            if (!controlState && hiddenIds.length === 0) continue

            const controlWidth = controlState
                ? Math.max(TRANSCRIPT_FOOTER_CONTROL_HEIGHT, (controlState.label.length * 6) + 8)
                : 0
            const restoreLabel = hiddenIds.length
                ? `Show ${hiddenIds.length} hidden`
                : ''
            const restoreWidth = restoreLabel ? (restoreLabel.length * 5.6) + 10 : 0
            const totalWidth = controlWidth + (restoreWidth ? restoreWidth + CONTROL_GAP_PX : 0)
            const isExpandedControl = controlState?.action === 'collapse'
            const expandedLabelWidth = isExpandedControl && displayFooter.label
                ? measureExpandedFooterLabelWidth(displayFooter.label)
                : 0
            const expandedGroupWidth = expandedLabelWidth
                ? expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP + totalWidth
                : 0
            const overlayWidth = Math.max(totalWidth, expandedGroupWidth)
            const groupX = clamp(
                displayFooter.x,
                LHS_WIDTH + 6,
                Math.max(LHS_WIDTH + 6, viewWidth - overlayWidth - 6),
            )
            // The same rule the canvas labels follow: a track's own controls stay in their
            // track. Reaching into the ruler makes both unreadable, and a compact panel
            // leaves no margin between the two for an overflow to land in.
            const rowTop = isExpandedControl
                ? displayFooter.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET
                : displayFooter.controlY
            if (intersectsRuler(rowTop, rowTop + TRANSCRIPT_FOOTER_CONTROL_HEIGHT, RULER_Y, effectiveRulerHeight)) {
                continue
            }

            controls.push({
                id: gene.id,
                x: groupX,
                controlX: isExpandedControl
                    ? groupX + expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP
                    : groupX,
                y: displayFooter.controlY,
                width: controlWidth,
                ...(controlState || {}),
                hasPrimary: Boolean(controlState),
                restoreLabel,
                restoreWidth,
                hiddenCount: hiddenIds.length,
                isDimmed,
                isFocused: gene.id === selectedGene?.id,
                totalTranscripts: txs.length,
                geneLabel: displayFooter.label || '',
                geneLabelY: displayFooter.labelY,
                isExpandedControl,
                trackBackground: displayFooter.trackBackground || '',
            })
        }
        return { controls }
    }, [genes, isGeneHiddenFromTracks, transcriptCache, getEffectiveTranscriptLimit, getDisplayTranscriptRows, getGeneTranscriptView, genomicToScreen, viewWidth, layout, effectiveHiddenStrands, selectedGene, dimNonSelectedGenes, compressTranscripts, isViewportTranscriptExpandMode, flattenTracks, transcriptLayoutMetrics, expandedFooterPlacementByGeneId, effectiveRulerHeight])

    /**
     * A speech bubble at the head of every gene the user has written about.
     *
     * DOM over the canvas, like the transcript footer pills above: that buys
     * hit-testing, hover, the tooltip and an accessible name for nothing, and
     * keeps this out of the draw effect entirely.
     */
    const geneNoteOverlay = useMemo(() => {
        const bubbles = []
        // Only once the track is drawing transcripts. Zoomed out, a gene is a
        // block or a tick and a mark on it would be pointing at nothing.
        if (!isTranscriptDetailZoomActive) return { bubbles }
        if (!geneNoteCounts) return { bubbles }
        const { FORWARD_Y, REVERSE_Y } = layout

        for (const gene of genes) {
            const count = Number(geneNoteCounts[String(gene.id)] || 0)
            if (!(count > 0)) continue
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2)) continue
            if (Math.abs(rawGx2 - rawGx1) < NOTE_BUBBLE_MIN_GENE_WIDTH) continue
            // Flip-safe: a flipped view reverses genomicToScreen, so gene.start
            // is not reliably the left edge.
            const gx1 = Math.min(rawGx1, rawGx2)

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const footer = getGeneFooterGeometry({
                gene,
                txs: transcriptCache[gene.id],
                getEffectiveTranscriptLimit,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue

            const top = footer.topY - NOTE_BUBBLE_SIZE - NOTE_BUBBLE_GAP
            // Compressed and flattened layouts leave 1-2px of track padding, so
            // there is simply nowhere to put the mark. Suppressed by the space
            // available rather than by naming the modes, which keeps it drawn
            // wherever it does fit.
            if (top < trackY + 1) continue

            bubbles.push({
                id: gene.id,
                gene,
                count,
                x: clamp(
                    gx1 - 1,
                    LHS_WIDTH + 2,
                    Math.max(LHS_WIDTH + 2, viewWidth - NOTE_BUBBLE_SIZE - 2),
                ),
                y: top,
                isDimmed: dimNonSelectedGenes && !!selectedGene && selectedGene.id !== gene.id,
            })
        }
        return { bubbles }
    }, [genes, geneNoteCounts, isTranscriptDetailZoomActive, genomicToScreen, viewWidth, layout,
        transcriptLayoutMetrics, transcriptCache, getEffectiveTranscriptLimit, effectiveHiddenStrands,
        isGeneHiddenFromTracks, selectedGene, dimNonSelectedGenes])

    // The SVG export builder is a callback and cannot read the memo directly.
    const geneNoteOverlayRef = useRef(geneNoteOverlay)
    geneNoteOverlayRef.current = geneNoteOverlay

    const transcriptPrefetchGenes = useMemo(() => {
        if (!isTranscriptDetailZoomActive || !selectedChrom) {
            return []
        }
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const result = collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
        const candidatesById = new Map()
        for (const gene of [...(Array.isArray(result?.genes) ? result.genes : []), ...genes]) {
            const geneId = String(gene?.id || '').trim()
            if (geneId && !candidatesById.has(geneId)) candidatesById.set(geneId, gene)
        }
        const candidates = Array.from(candidatesById.values())
        if (candidates.length <= MAX_TRANSCRIPT_PREFETCH_GENES) {
            return candidates
        }
        const viewCenter = (viewGStart + viewGEnd) / 2
        return candidates
            .slice()
            .sort((a, b) => {
                const aCenter = (Number(a?.start || 0) + Number(a?.end || 0)) / 2
                const bCenter = (Number(b?.start || 0) + Number(b?.end || 0)) / 2
                return Math.abs(aCenter - viewCenter) - Math.abs(bCenter - viewCenter)
            })
            .slice(0, MAX_TRANSCRIPT_PREFETCH_GENES)
    }, [isTranscriptDetailZoomActive, selectedChrom, genomicViewRange, collectCachedGenesInRange, genes])

    useEffect(() => {
        const nextProtectedIds = new Set()
        for (const gene of genes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        for (const gene of transcriptPrefetchGenes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        for (const gene of bufferedTranscriptExpandGenes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        if (selectedGene?.id) {
            nextProtectedIds.add(String(selectedGene.id))
        }
        for (const [geneId, limit] of Object.entries(expandedGenes || {})) {
            if (Number(limit) > 1) nextProtectedIds.add(String(geneId))
        }
        protectedTranscriptCacheIdsRef.current = nextProtectedIds
    }, [transcriptPrefetchGenes, bufferedTranscriptExpandGenes, expandedGenes, genes, selectedGene?.id])

    // Also fetch transcripts for visible genes at appropriate zoom
    useEffect(() => {
        if (viewSpan > TRANSCRIPT_DETAIL_VIEWSPAN_BP) return
        const genesToPrefetch = isViewportTranscriptExpandMode
            ? bufferedTranscriptExpandGenes
            : transcriptPrefetchGenes
        for (const gene of genesToPrefetch) {
            if (!transcriptCache[gene.id]) {
                fetchTranscripts(gene.id)
            }
        }
    }, [viewSpan, transcriptCache, fetchTranscripts, transcriptPrefetchGenes, isViewportTranscriptExpandMode, bufferedTranscriptExpandGenes])

    // ============ Search & Navigation ============

    const handleSearch = useCallback((...args) => runBrowserSearch({
        emitTutorialSignal,
        fetchingTilesRef,
        focusDrawerInsetOnFocus,
        focusLocation,
        frameFocusRange,
        genes,
        genome,
        genomePillLabel,
        isFlipped,
        onManualNavigate,
        onPositionChange,
        pendingVerticalCenterGeneIdRef,
        regions,
        searchInput,
        selectedChrom,
        setChromLength,
        setGenes,
        setSearchInput,
        setSelectedChrom,
        setSelectedGene,
        setViewEnd,
        setViewStart,
        showSearchFeedback,
        tileCacheRef,
        viewWidthRef,
    }, ...args), [searchInput, regions, selectedChrom, genome, genes, onManualNavigate, onPositionChange, focusDrawerInsetOnFocus, isFlipped, emitTutorialSignal, focusLocation, frameFocusRange, genomePillLabel, showSearchFeedback])

    const handleRegionChange = useCallback((chrom) => {
        setSelectedChrom(chrom)
        const region = regions.find(r => r.chrom === chrom)
        if (region) {
            setChromLength(region.end)
            setGenes([])
            // Clear tile cache on chrom switch
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
            // Set initial view — tile management effect will fetch genes
            const nextStart = region.start
            const nextEnd = Math.min(region.start + 500000, region.end)
            setViewStart(nextStart)
            setViewEnd(nextEnd)
            if (onPositionChange) {
                onPositionChange(chrom, nextStart, nextEnd)
            }
        }
        setSelectedGene(null)
        setExpandedGenes({})
        if (onManualNavigate) onManualNavigate()
    }, [regions, onManualNavigate, onPositionChange])

    const centerGeneVertically = useCallback((geneForCenter) => {
        if (!geneForCenter || !containerRef.current) return false

        const isForward = geneForCenter.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(geneForCenter.start)
        const rawGx2 = genomicToScreen(geneForCenter.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const rowCount = getGeneRowCountForWidth(geneForCenter, geneWidth)

        const baseGeneY = trackY + trackPadding + ((geneForCenter._row || 0) * transcriptLayoutMetrics.rowPitch)
        const totalGeneHeight = getGeneTotalHeight(rowCount)
        const geneCenterY = baseGeneY + (totalGeneHeight / 2)

        const container = containerRef.current
        const scroller = findNearestScrollable(rootRef.current)
        const scrollerMetrics = getScrollerMetrics(scroller)
        const geneCenterClientY = container.getBoundingClientRect().top + geneCenterY
        const viewportCenterClientY = (getScrollerVisibleTop(scroller, scrollerMetrics) + scrollerMetrics.bottom) / 2
        const targetScrollTop = clamp(
            scrollerMetrics.scrollTop + (geneCenterClientY - viewportCenterClientY),
            0,
            scrollerMetrics.maxScrollTop
        )
        scrollScrollerTo(scroller, scrollerMetrics, targetScrollTop)
        return true
    }, [layout, genomicToScreen, getGeneRowCountForWidth, getGeneTotalHeight, transcriptLayoutMetrics])

    useEffect(() => {
        const pendingGeneId = pendingVerticalCenterGeneIdRef.current
        if (!pendingGeneId) return

        const geneForCenter = genes.find((gene) => gene.id === pendingGeneId)
        if (!geneForCenter) return

        if (centerGeneVertically(geneForCenter)) {
            pendingVerticalCenterGeneIdRef.current = null
        }
    }, [genes, layout, centerGeneVertically])

    useEffect(() => {
        const pending = pendingTranscriptPillFocusRef.current
        if (!pending?.geneId) return

        const geneForFocus = genes.find((gene) => gene.id === pending.geneId)
        if (!geneForFocus) return

        if (pending.waitForTranscripts && !transcriptCache[pending.geneId]) {
            return
        }

        if (!pending.preserveHorizontalViewport) {
            const focusViewport = getGeneFocusViewport(geneForFocus, { limit: pending.limit })
            if (!focusViewport) {
                pendingTranscriptPillFocusRef.current = null
                return
            }

            const [targetStart, targetEnd] = clampView(focusViewport.start, focusViewport.end)
            if (!pending.animated) {
                pendingTranscriptPillFocusRef.current = {
                    ...pending,
                    animated: true,
                    waitForTranscripts: false,
                    targetStart,
                    targetEnd,
                }
                animateToView(targetStart, targetEnd, 700)
                return
            }

            const currentStart = viewStartRef.current
            const currentEnd = viewEndRef.current
            const isCloseToTarget = Math.abs(currentStart - targetStart) < 2 && Math.abs(currentEnd - targetEnd) < 2
            if (!isCloseToTarget) return
        } else if (!pending.animated) {
            // Expanding/collapsing transcript rows is a vertical layout operation.
            // Keep the user's genomic window untouched so the next wheel zoom does
            // not start from an unexpectedly re-centred or re-scaled viewport.
            pendingTranscriptPillFocusRef.current = {
                ...pending,
                animated: true,
                waitForTranscripts: false,
                targetStart: viewStartRef.current,
                targetEnd: viewEndRef.current,
            }
        }

        // The pinned-transcript path does its own vertical work: the drawer moves
        // the browser to meet the identifier it is level with. Parking the gene
        // at the top of the window as well would jump the view one way before
        // the alignment slid it back the other.
        if (pending.skipVerticalAlign) {
            pendingTranscriptPillFocusRef.current = null
            return
        }

        let attemptsRemaining = 6
        const tryVerticalAlign = () => {
            const didAlign = alignGeneToTop(geneForFocus, 18, {
                preferBottomVisible: pending.preferBottomVisible,
                bottomMarginPx: 16,
            })
            if (didAlign) {
                pendingTranscriptPillFocusRef.current = null
                return
            }
            attemptsRemaining -= 1
            if (attemptsRemaining <= 0) {
                pendingTranscriptPillFocusRef.current = null
                return
            }
            requestAnimationFrame(tryVerticalAlign)
        }
        requestAnimationFrame(tryVerticalAlign)
    }, [genes, transcriptCache, expandedGenes, getGeneFocusViewport, clampView, animateToView, alignGeneToTop, viewStart, viewEnd])

    // ---- Pinned transcript ---------------------------------------------------
    //
    // Clicking a transcript in the drawer pins it: the panel returns to the
    // framing the gene had when it took focus, and the view then slides the
    // drawer so the pinned row and its identifier meet. Hovering does none of
    // this — it must never move the viewport out from under the pointer.

    const pinnedTranscriptId = String(focusTranscriptView?.pinnedId || '').trim()

    // Reported in container-local pixels. Page scrolling moves the panel and the
    // drawer together, so a client-space reading taken here would be stale the
    // moment the user scrolled; the view adds the panel's live position instead.
    const focusRowGeometry = useMemo(() => {
        const geneForPin = pinnedTranscriptId && selectedGene
            ? genes.find((gene) => gene.id === selectedGene.id)
            : null
        if (!geneForPin) return null

        const isForward = geneForPin.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const baseGeneY = trackY + trackPadding + ((geneForPin._row || 0) * transcriptLayoutMetrics.rowPitch)

        const rows = getDisplayTranscriptRows(geneForPin)
        const rowIndex = rows.findIndex((row) => String(row.transcript?.id) === pinnedTranscriptId)

        return {
            transcriptId: pinnedTranscriptId,
            // A gene drawn as a block has no row of its own to meet, so the block
            // stands in for it until the panel is back at transcript zoom.
            offsetTop: baseGeneY + (rowIndex > 0 ? rowIndex * transcriptLayoutMetrics.rowPitch : 0),
            height: transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
            resolved: rowIndex >= 0,
        }
    }, [pinnedTranscriptId, selectedGene, genes, layout, transcriptLayoutMetrics, getDisplayTranscriptRows])
    useEffect(() => {
        onFocusRowGeometryChangeRef.current?.(focusRowGeometry)
    }, [focusRowGeometry])

    // Restore the focus framing on pin, but only when the view has actually
    // drifted from it. Re-framing unconditionally would re-run the whole focus
    // animation on every click, including the ones that change nothing.
    const lastPinFramingRef = useRef('')
    useEffect(() => {
        const geneId = focusViewGeneId
        if (!pinnedTranscriptId || !geneId) {
            lastPinFramingRef.current = ''
            return
        }
        const signature = `${geneId}::${pinnedTranscriptId}`
        if (lastPinFramingRef.current === signature) return
        lastPinFramingRef.current = signature

        const txs = transcriptCacheRef.current[geneId]
        const limit = getEffectiveTranscriptLimit(geneId, txs)
        const geneForPin = genes.find((gene) => gene.id === geneId)
        const focusViewport = geneForPin ? getGeneFocusViewport(geneForPin, { limit }) : null
        // Without a viewport to compare against there is no evidence the view has
        // drifted, and re-framing on a guess moves the browser for nothing.
        if (!focusViewport) return
        const tolerance = Math.max(1, Math.abs(focusViewport.end - focusViewport.start) * 0.01)
        const alreadyFramed = Math.abs(viewStartRef.current - focusViewport.start) <= tolerance
            && Math.abs(viewEndRef.current - focusViewport.end) <= tolerance
        if (alreadyFramed) return

        requestTranscriptPillFocus(geneId, {
            limit,
            waitForTranscripts: !txs,
            preferBottomVisible: false,
            skipVerticalAlign: true,
        })
    }, [pinnedTranscriptId, focusViewGeneId, genes, getEffectiveTranscriptLimit, getGeneFocusViewport, requestTranscriptPillFocus])

    const handleRecenterSelectedGene = useCallback(() => {
        if (!selectedGene) return
        const selectedCoords = getSelectedGeneCoordsForView(selectedGene, isAligned, alignData, genomicToOverlay)
        if (!selectedCoords) return

        const framed = frameFocusRange(selectedCoords.start, selectedCoords.end)
        animateToView(framed.start, framed.end, 1000)
        requestAnimationFrame(() => {
            centerGeneVertically(selectedGene)
        })
    }, [selectedGene, isAligned, alignData, genomicToOverlay, animateToView, centerGeneVertically, frameFocusRange])

    /* "Make what I am looking at the focus."
     *
     * The window itself becomes the location, then the view re-frames a little
     * wider than it — otherwise the focus boundary lines land exactly on the
     * edges of the view, where they cannot be seen, and the drawer that slides
     * out covers the region's right end. */
    const focusCurrentWindow = useCallback(() => {
        if (!selectedChrom) return
        const start = viewStartRef.current
        const end = viewEndRef.current
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

        focusLocation({
            chrom: selectedChrom,
            start: Math.round(isAligned ? overlayToGenomic(start) : start),
            end: Math.round(isAligned ? overlayToGenomic(end) : end),
        })
        const span = end - start
        const flank = (span / BOX_SELECT_FILL_FRACTION - span) / 2
        const framed = frameFocusRange(start - flank, end + flank, { gainingFocus: true })
        animateToView(framed.start, framed.end, 300)
        if (onManualNavigate) onManualNavigate()
    }, [selectedChrom, isAligned, overlayToGenomic, focusLocation, frameFocusRange, animateToView, onManualNavigate])

    /* The location of focus re-frames horizontally only: there is no row to bring
     * into view, so unlike the gene target this leaves the vertical scroll alone. */
    const handleRecenterSelectedLocation = useCallback(() => {
        if (!focusLocationRange) return
        const coords = getFeatureCoordsForView(
            focusLocationRange.start,
            focusLocationRange.end,
            isAligned,
            alignData,
            genomicToOverlay
        )
        if (!coords) return

        const span = Math.max(1, coords.end - coords.start)
        const paddedSpan = span / FOCUS_RANGE_FILL_FRACTION
        const midpoint = (coords.start + coords.end) / 2
        const framed = frameFocusRange(midpoint - paddedSpan / 2, midpoint + paddedSpan / 2)
        animateToView(framed.start, framed.end, 1000)
    }, [focusLocationRange, isAligned, alignData, genomicToOverlay, frameFocusRange, animateToView])

    // Collapsing the drawer uncovers part of the track; opening it covers that
    // part again. Rescale the window by the change in visible width and recentre
    // whichever primary focus the panel holds, so a gene or location keeps the
    // same share of what can actually be seen. Secondary drawer layers are not
    // part of focusDrawerInset and therefore never move the genomic window.
    const lastFocusDrawerInsetRef = useRef(null)
    const lastLocationFocusCentreRef = useRef(null)
    useEffect(() => {
        const previous = lastFocusDrawerInsetRef.current
        lastFocusDrawerInsetRef.current = focusDrawerInset
        const locationCoords = focusLocationRange
            ? getFeatureCoordsForView(focusLocationRange.start, focusLocationRange.end, isAligned, alignData, genomicToOverlay)
            : null
        if (selectedGene) lastLocationFocusCentreRef.current = null
        else if (locationCoords) lastLocationFocusCentreRef.current = (locationCoords.start + locationCoords.end) / 2
        if (previous === null || previous === focusDrawerInset) return

        // A newly focused range was already framed in the action that created
        // it. Non-zero changes are the primary drawer opening/collapsing. A
        // disappearing location drawer is also balanced once around its last
        // centre, so dismissing it gives the recovered track width back.
        if (!previous) return
        const closingLocation = !focusDrawerInset && !selectedGene && !focusLocationRange
            && Number.isFinite(lastLocationFocusCentreRef.current)
        if (!focusDrawerInset && !closingLocation) return

        const selectedCoords = selectedGene
            ? getSelectedGeneCoordsForView(selectedGene, isAligned, alignData, genomicToOverlay)
            : locationCoords
                ? locationCoords
                : closingLocation
                    ? {start:lastLocationFocusCentreRef.current,end:lastLocationFocusCentreRef.current}
                    : null
        if (!selectedCoords) return

        const next = rebalanceRangeForInsetChange({
            start: viewStartRef.current,
            end: viewEndRef.current,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            fromInsetPx: previous,
            toInsetPx: focusDrawerInset,
            focusCentre: (selectedCoords.start + selectedCoords.end) / 2,
            flipped: isFlipped,
        })
        if (!next) return

        const [targetStart, targetEnd] = clampView(next.start, next.end)
        animateToView(targetStart, targetEnd, 320)
        if (closingLocation) lastLocationFocusCentreRef.current = null
    }, [focusDrawerInset, selectedGene, focusLocationRange, isAligned, alignData, genomicToOverlay, isFlipped, clampView, animateToView])

    // ============ Keyboard navigation ============
    //
    // Bound to the panel element rather than the window, so keys can only act on
    // the panel that actually has focus. A window-level binding (as in
    // AlignmentPanel) fires while the view is off-screen or a modal is open.
    //
    // The key map is deliberately the same in every control scheme: schemes
    // change pointer behaviour only. Making the keyboard scheme-dependent would
    // leave Default users with no keyboard access at all.
    const handleKeyDown = useCallback((e) => {
        if (e.defaultPrevented) return
        // The panel contains a search box and a track-label dialog whose keydowns
        // bubble up to this container.
        if (isTextEntryTarget(e.target)) return

        const intent = resolveKeyAction(readKeyEvent(e))
        if (intent.type === 'none') return
        if (intent.preventDefault) e.preventDefault()

        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const span = Math.max(1, currentEnd - currentStart)
        const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)

        if (intent.type === 'pan') {
            // At base-level zoom a "fine" step should be exactly one base,
            // otherwise a percentage of the span.
            const stepPx = (intent.fineStep && span <= 1000)
                ? Math.sign(intent.dxFraction) * (trackWidth / span)
                : intent.dxFraction * trackWidth
            captureAdaptiveScrollAnchor()
            panByPx(stepPx)
            return
        }

        if (intent.type === 'zoom') {
            zoomAt(LHS_WIDTH + trackWidth / 2, intent.factor, null)
            return
        }

        if (intent.type === 'jump') {
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            const [nextStart, nextEnd] = intent.edge === 'start'
                ? clampView(1, 1 + span)
                : clampView(maxEnd - span, maxEnd)
            animateToView(nextStart, nextEnd, 400)
            return
        }

        if (intent.type === 'reset') {
            if (intent.scope === 'gene') {
                // "Reset to what is focused": whichever kind of focus the panel holds.
                if (selectedGene) handleRecenterSelectedGene()
                else handleRecenterSelectedLocation()
                return
            }
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            animateToView(1, maxEnd, 500)
            return
        }

        if (intent.type === 'dismiss') {
            if (selectedGene) {
                setSelectedGene(null)
                return
            }
            if (selectedLocation) {
                setSelectedLocation(null)
                return
            }
            containerRef.current?.blur()
        }
    }, [
        viewWidth, chromLength, selectedGene, selectedLocation, panByPx, zoomAt, animateToView, clampView,
        onManualNavigate, captureAdaptiveScrollAnchor, handleRecenterSelectedGene, handleRecenterSelectedLocation,
    ])

    // Published upward so GenomeBrowserView can route a wheel gesture that landed
    // between panels (page padding, or the divider) to the nearest one. Follows
    // the same descriptor-registration pattern as screenshotTargetDescriptor,
    // which avoids forwardRef/useImperativeHandle entirely.
    const browsingTargetDescriptor = useMemo(() => ({
        containsNode: (node) => Boolean(node && rootRef.current?.contains(node)),
        getRootRect: () => rootRef.current?.getBoundingClientRect() || null,
        applyWheelIntent: (intent, point) => {
            const container = containerRef.current
            if (!container || intent?.type !== 'zoom') return
            const rect = container.getBoundingClientRect()
            const trackWidth = Math.max(1, rect.width - LHS_WIDTH)
            // Anchoring on a cursor that is outside the panel horizontally would
            // silently zoom about the far edge of the tracks, so centre instead.
            const insideHorizontally = Number.isFinite(point?.clientX)
                && point.clientX >= rect.left && point.clientX <= rect.right
            const anchorX = (intent.anchor === 'cursor' && insideHorizontally)
                ? point.clientX - rect.left
                : LHS_WIDTH + trackWidth / 2
            const targetTrack = Number.isFinite(point?.clientY)
                ? getTrackAtY(point.clientY - rect.top + container.scrollTop)
                : null
            captureAdaptiveScrollAnchor()
            zoomAt(anchorX, intent.factor, targetTrack)
        },
    }), [zoomAt, getTrackAtY, captureAdaptiveScrollAnchor])

    useEffect(() => {
        const notify = onBrowsingTargetChangeRef.current
        if (typeof notify !== 'function') return undefined
        notify(browsingTargetDescriptor)
        return () => {
            if (typeof onBrowsingTargetChangeRef.current === 'function') {
                onBrowsingTargetChangeRef.current(null)
            }
        }
    }, [browsingTargetDescriptor])

    // ============ Region sorting ============
    // Sort: numeric chroms first (chr1, 1, chr2...), then named sex/special (X, Y, MT) by length desc then alpha,
    // then accession-style scaffolds by length desc.
    const sortedRegions = useMemo(() => {
        const withFeatures = regions.filter(r => r.gene_count > 0)
        const featureless = regions.filter(r => r.gene_count === 0)

        const chromNum = (name) => {
            const m = name.match(/^(?:chr)?0*(\d+)$/i)
            return m ? parseInt(m[1], 10) : null
        }
        const isSpecial = (name) => /^(?:chr)?(X|Y|MT|M|W|Z)$/i.test(name)
        const isAccession = (name) => /^[A-Z]{1,4}[_0-9]{3,}/i.test(name) && chromNum(name) === null && !isSpecial(name)
        // Use display_name (e.g. "1") when available for sort categorization so that
        // accession-named regions (NC_000001.11) sort with their numeric peers.
        const sortName = (r) => r.display_name || r.chrom

        const sortGroup = (arr) => {
            const numeric = arr.filter(r => chromNum(sortName(r)) !== null).sort((a, b) => chromNum(sortName(a)) - chromNum(sortName(b)))
            const special = arr.filter(r => isSpecial(sortName(r))).sort((a, b) => b.length - a.length || sortName(a).localeCompare(sortName(b)))
            const accessions = arr.filter(r => isAccession(sortName(r))).sort((a, b) => b.length - a.length)
            const other = arr.filter(r => !chromNum(sortName(r)) && !isSpecial(sortName(r)) && !isAccession(sortName(r))).sort((a, b) => b.length - a.length || sortName(a).localeCompare(sortName(b)))
            return [...numeric, ...special, ...other, ...accessions]
        }

        return { withFeatures: sortGroup(withFeatures), featureless: sortGroup(featureless) }
    }, [regions])

    // Map chrom identifiers (e.g. NC_000001.11) to human-readable display names (e.g. "1").
    const chromDisplayMap = useMemo(() => {
        const map = {}
        for (const r of regions) {
            if (r.display_name) map[r.chrom] = r.display_name
        }
        return map
    }, [regions])
    const chromLabel = (c) => chromDisplayMap[c] || c

    // Reset showFeatureless each time regions are loaded
    useEffect(() => { setShowFeatureless(false) }, [regions])

    // ============ Viewport control, published for the tutorial ============
    // The browser has no zoom button and no slider — panning is a drag or the arrow keys,
    // zooming is the wheel or +/- — so a tutorial demonstrating either has nothing to
    // click on the user's behalf. Rather than adding controls that exist only for the
    // tutorial to press, the panel publishes the moves it can make and the tutorial calls
    // them. Everything goes through animateToView, so a move the tutorial makes travels at
    // the same speed and stops at the same edges as one the user makes.
    const tutorialSequenceVisibleRef = useRef(false)
    tutorialSequenceVisibleRef.current = Boolean(
        showSequenceTrack
        && !effectiveHiddenStrands.sequence
        && sequence
        && seqRange
        && viewSpan <= 1000
    )

    useEffect(() => {
        const panelKey = String(screenshotTargetId || genome || '')
        if (!panelKey) return undefined
        const span = () => Math.max(1, viewEndRef.current - viewStartRef.current)
        const duration = (ms) => (Number(ms) > 0 ? Number(ms) : TUTORIAL_MOVE_MS)
        const bare = (name) => String(name || '').trim().toLowerCase().replace(/^chr/, '')

        return registerBrowserViewport(panelKey, {
            recipeId: tutorialRecipeId,
            frameFocusedRange: (start, end) => frameFocusRange(start, end, { gainingFocus: true }),
            setTracks: (tracks) => setHiddenStrands((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(tracks).map(([key, visible]) => [key, !visible])) })),
            setInteraction: (mode) => { interactionModeRef.current = mode },
            resetScroll: () => {
                // The panel lives inside the view's scroller, not its own, so this walks
                // up to whatever is actually scrolling.
                let node = rootRef.current
                while (node && node !== document.body) {
                    if (node.scrollHeight > node.clientHeight + 1) { node.scrollTop = 0; return }
                    node = node.parentElement
                }
            },
            describe: () => ({
                chrom: selectedChrom,
                start: viewStartRef.current,
                end: viewEndRef.current,
                sequenceVisible: tutorialSequenceVisibleRef.current,
                bounds: browsableRange,
                tracks: Object.fromEntries(Object.entries(hiddenStrands).map(([key, hidden]) => [key, !hidden])),
                focus: selectedGene?.name || selectedGene?.id || '',
                // The location of focus, so an arrival can tell "already right" from
                // "needs setting" rather than re-focusing on every visit to a step.
                locationFocus: isLocationFocusVisible && focusLocationRange
                    ? { ...focusLocationRange }
                    : null,
                ready: Boolean(selectedChrom && regions.length),
            }),
            // The location of focus, set the way the gene of focus is: through the panel's
            // own handler rather than behind it, so the drawer, the focus bar, the boundary
            // lines and the gene that gives way to it all stay in step.
            //
            // Deliberately not "press the Focus this window button": that control focuses
            // whatever the window happens to be showing, so a step wanting a particular
            // region would have to travel there first and then be moved back — a journey
            // and a correction, which is exactly what docs/TUTORIALS.md says a tutorial
            // must not do. This leaves the view alone; the step's own `browserView`
            // arrival puts it where the card describes, in one move.
            setLocationFocus: (range) => {
                if (!range) {
                    if (!selectedLocation) return false
                    focusLocation(null)
                    return true
                }
                const wanted = getFocusLocationRange(range)
                if (!wanted) return false
                if (!isSameChromToken(wanted.chrom, selectedChrom)) return false
                const current = focusLocationRange
                if (current
                    && isSameChromToken(current.chrom, wanted.chrom)
                    && Math.round(current.start) === Math.round(wanted.start)
                    && Math.round(current.end) === Math.round(wanted.end)) return false
                focusLocation(wanted)
                return true
            },
            panByWindows: (fraction, ms) => {
                const shift = span() * (Number(fraction) || 0)
                if (!shift) return false
                animateToView(viewStartRef.current + shift, viewEndRef.current + shift, duration(ms))
                return true
            },
            zoomBy: (factor, ms) => {
                const value = Number(factor)
                if (!(value > 0)) return false
                const centre = viewStartRef.current + (span() / 2)
                const next = Math.max(2, span() * value)
                animateToView(centre - (next / 2), centre + (next / 2), duration(ms))
                return true
            },
            goToLocus: (text, ms) => {
                const parsed = String(text || '').match(/^\s*([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)\s*$/)
                if (!parsed) return false
                const start = parseInt(parsed[2].replace(/[,\s]/g, ''), 10)
                const end = parseInt(parsed[3].replace(/[,\s]/g, ''), 10)
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
                // A locus on some other region is not a move, it is a navigation — leave
                // that to the search box, which knows how to switch region.
                const showing = chromDisplayMap[selectedChrom] || selectedChrom
                if (bare(parsed[1]) !== bare(showing) && bare(parsed[1]) !== bare(selectedChrom)) return false
                // Through the same framing every other "put this on screen" path uses, so
                // a locus a tutorial asks for lands in the part of the track the reader can
                // actually see. Without it a step that names a region around the focused
                // gene centres that gene behind the drawer — the drawer overlays the canvas
                // rather than narrowing it, so the window itself never shrank. A no-op
                // whenever no drawer is open, since the inset is then zero.
                const framed = frameFocusRange(start, end)
                animateToView(framed.start, framed.end, duration(ms))
                return true
            },
        })
    }, [animateToView, browsableRange, chromDisplayMap, frameFocusRange, genome, screenshotTargetId, selectedChrom, tutorialRecipeId, hiddenStrands, selectedGene, regions.length, focusLocation, focusLocationRange, isLocationFocusVisible, selectedLocation])

    // ============ Render ============

    // The foot of the last track drawn, which is where the gutter marker stops. Zero until
    // the tracks have been laid out, which is the signal not to render it yet.
    const gutterMarkerHeight = (() => {
        const foot = showSequenceTrack && layout.SEQUENCE_Y >= 0
            ? layout.SEQUENCE_Y + layout.seqBgHeight
            : layout.REVERSE_Y + layout.reverseBgHeight
        return foot > LHS_WIDTH ? Math.round(foot + 4) : 0
    })()

    const toolbarColumnWidths = {
        genome: 180,
        region: 220,
        search: 220,
        iconGroup: 226,
        coordinates: 230,
    }

    const toolbar = (
        renderBrowserToolbar({
            RESET_ICON_PATH_D,
            chromLabel,
            colors,
            controlAccentColor,
            effectiveToolbarPosition,
            focusCurrentWindow,
            genes,
            genome,
            genomePillExpanded,
            genomePillLabel,
            handleRegionChange,
            handleSearch,
            isBoxSelectMode,
            isFlipped,
            isLight,
            isLocationFocusVisible,
            isPrimaryPanel,
            isRulerCollapsed,
            isTranscriptCompressionActive,
            isVerticalLayoutFlipped,
            isViewportTranscriptExpandMode,
            onGenomePillClick,
            panelPillColor,
            refreshAvailableTracks,
            screenshotTargetId,
            searchFeedback,
            searchInput,
            selectedChrom,
            selectedGene,
            setExpandedGenes,
            setIsBoxSelectMode,
            setIsRulerCollapsed,
            setIsSelectingRect,
            setIsTrackPickerOpen,
            setIsVerticalLayoutFlipped,
            setIsViewportTranscriptExpandMode,
            setSearchInput,
            setSelectedTrackPickerIds,
            setSelectionRect,
            setShowFeatureless,
            showFeatureless,
            showSearchFeedback,
            sortedRegions,
            toggleFlipped,
            toolbarColumnWidths,
            toolbarRef,
            viewEnd,
            viewStart,
        })
    )

    /* Shared by every focus bar, so a new kind of focus is a row of content rather
     * than another copy of the bar. Only one focus is ever live in a panel, so
     * they can all share `focusBarRef` and the layout compensation that measures it. */
    const renderFocusBar = (kind, children) => (
        <div
            ref={focusBarRef}
            // The focus drawer aligns its header to this bar and scrolls it into
            // view when the user switches between panels' focus genes.
            data-focus-bar="true"
            data-focus-kind={kind}
            // Written out rather than derived from `data-focus-kind`, so the bar the
            // location tutorial points at is a single attribute a target contract can
            // name — a compound selector is invisible to the binding test.
            data-location-focus-bar={kind === 'location' ? 'true' : undefined}
            data-browser-controls="true"
            data-focus-panel-key={screenshotTargetId || genome}
            className="flex items-center gap-4 px-3 py-1.5 flex-none text-xs"
            style={{
                backgroundColor: colors.selectedGene,
                borderTop: effectiveFocusBarPosition === 'bottom' ? `1px solid ${isLight ? '#b1c2ff' : '#1e293b'}` : 'none',
                borderBottom: effectiveFocusBarPosition === 'top' ? `1px solid ${isLight ? '#b1c2ff' : '#1e293b'}` : 'none',
                color: isLight ? '#1e293b' : '#ffffff',
            }}
        >
            {children}
        </div>
    )

    // The anchor is spelled out per kind rather than passed in, so every tour id the
    // focus bar can render is written literally in the component that renders it.
    const renderFocusTargetButton = (kind, onClick, title, disabled = false) => (
        <button
            data-tour-id={kind === 'location' ? 'browser-recenter-location' : 'browser-recenter'}
            onClick={() => {
                trackAchievement('browser.recenter')
                onClick()
            }}
            disabled={disabled}
            className="shrink-0 p-1.5 rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
            title={title}
        >
            <svg width="27" height="27" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d={RESET_ICON_PATH_D} fill={controlAccentColor} />
            </svg>
        </button>
    )

    const selectedLocationInfoBar = isLocationFocusVisible && focusLocationRange && renderFocusBar('location', (
        <>
            {renderFocusTargetButton(
                'location',
                handleRecenterSelectedLocation,
                'Re-center view on location of focus'
            )}
            <span className="font-semibold">
                {formatRegionCoord(
                    chromLabel(focusLocationRange.chrom),
                    focusLocationRange.start,
                    focusLocationRange.end
                )}
            </span>
            <span className="opacity-70">Location</span>
            <span className="opacity-70">{formatBp(focusLocationRange.end - focusLocationRange.start)}</span>
            <button
                onClick={() => setSelectedLocation(null)}
                className="ml-auto opacity-50 hover:opacity-100"
                style={{ color: colors.infoText }}
                title="Clear the location of focus"
            >
                ✕
            </button>
        </>
    ))

    const selectedGeneInfoBar = selectedGene && !isSelectedHidden && renderFocusBar('gene', (
        <>
            {renderFocusTargetButton(
                'gene',
                handleRecenterSelectedGene,
                'Re-center view on selected gene',
                !hasGeneCoords(selectedGene)
            )}
            <span className="font-semibold">{selectedGene.name || selectedGene.id}</span>
            <span className="opacity-70">{selectedGene.id}</span>
            <span className="opacity-70">{selectedGene.biotype || 'protein_coding'}</span>
            <span className="opacity-70">{formatGeneStrand(selectedGene.strand)}</span>
            {hasGeneCoords(selectedGene) && (
                <span className="opacity-70">
                    {formatRegionCoord(selectedGene.chrom, selectedGene.start, selectedGene.end)}
                </span>
            )}
            <button
                onClick={() => setSelectedGene(null)}
                className="ml-auto opacity-50 hover:opacity-100"
                style={{ color: colors.infoText }}
            >
                ✕
            </button>
        </>
    ))

    const canConfirmCustomTrack = customTrackLabelInput.trim().length > 0

    const closeTrackPicker = useCallback(() => {
        setIsTrackPickerOpen(false)
        setSelectedTrackPickerIds([])
        setPendingPickerRemovals([])
    }, [])

    // A row's button stages its change: an add for something not on the panel (or a
    // group's missing tracks), a removal for something that is. Pressing it again undoes it.
    const togglePickerChange = useCallback((pickerId, isOnPanel) => {
        const flip = (prev) => (prev.includes(pickerId) ? prev.filter((id) => id !== pickerId) : [...prev, pickerId])
        if (isOnPanel) setPendingPickerRemovals(flip)
        else setSelectedTrackPickerIds(flip)
    }, [])

    const buildCustomTrackFromRegistered = useCallback((registeredTrack) => {
        const id = `ct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        const trackType = registeredTrack.type || 'bigwig'
        const nextTrack = {
            id,
            path: registeredTrack.path,
            label: registeredTrack.label,
            visible: true,
            renderMode: trackType === 'vcf'
                ? normalizeVcfDisplayMode(registeredTrack.display_mode || 'density_lollipop')
                : (registeredTrack.display_mode || DEFAULT_CUSTOM_TRACK_RENDER_MODE),
            type: trackType,
            registryTrackId: registeredTrack.id,
            spliceSettings: normalizeSpliceTrackSettings(registeredTrack.splice_settings),
            vcfSettings: normalizeVcfSettings(registeredTrack.vcf_settings),
            bedSettings: normalizeBedSettings(registeredTrack.bed_settings),
        }
        if (trackType === 'bigwig') {
            const bigWigSettings = normalizeBigWigSettings(registeredTrack.bigwig_settings)
            nextTrack.bigwigSettings = bigWigSettings
            nextTrack.renderMode = normalizeBigWigDisplayMode(registeredTrack.display_mode, bigWigSettings.data_type)
        } else if (trackType === 'splice_junctions') {
            nextTrack.renderMode = 'arcs'
        } else if (trackType === 'vcf') {
            nextTrack.renderMode = normalizeVcfDisplayMode(registeredTrack.display_mode)
        }
        return nextTrack
    }, [])

    const seededTrackPickerRequestRef = useRef(null)

    /* A tutorial's `browserTracks` arrival, reconciled against this panel.
     *
     * Set, never toggled, because an arrival runs on every entry to a step — walking back
     * into a step that shows three tracks must show the same three, not add them again.
     *
     * Registry ids are minted when a track is registered, so a portable document cannot
     * name one. The arrival names the demo tracks by key and they are matched here by the
     * end of their path, which is stable and is what the tutorial actually laid down. */
    useEffect(() => {
        if (!tutorialTracksRequest) return
        const wanted = Array.isArray(tutorialTracksRequest.added) ? tutorialTracksRequest.added : []
        const registered = Array.isArray(availableTracks) ? availableTracks : []
        const matching = (key) => registered.find((track) =>
            String(track?.path || '').endsWith(TRACK_FILENAMES[key] || '\u0000')
        )
        // Which of them are switched on. Absent means all, so a step that is not about
        // visibility need not say — and the section that *is* about it can put two tracks
        // off and leave the third on, on every entry, however the step was reached.
        const shown = Array.isArray(tutorialTracksRequest.visible)
            ? tutorialTracksRequest.visible
            : wanted
        const shouldShow = (key) => shown.includes(key)

        setCustomTracks((prev) => {
            const keep = wanted.map((key) => {
                const registeredTrack = matching(key)
                if (!registeredTrack) return null
                const existing = prev.find((ct) => !ct.group && (
                    String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                    || String(ct.path || '') === String(registeredTrack.path || '')
                ))
                const base = existing || buildCustomTrackFromRegistered(registeredTrack)
                return base.visible === shouldShow(key) ? base : { ...base, visible: shouldShow(key) }
            }).filter(Boolean)
            // A group's tracks are the group arrival's business, below.
            keep.push(...prev.filter((ct) => ct.group))
            const same = keep.length === prev.length
                && keep.every((track, index) => track === prev[index])
            return same ? prev : keep
        })

    }, [tutorialTracksRequest, availableTracks, buildCustomTrackFromRegistered])

    // A registry refresh can change availableTracks while the reader is using the picker.
    // Apply the tutorial's open/closed state only when the request itself changes.
    useEffect(() => {
        if (!tutorialTracksRequest) return
        seededTrackPickerRequestRef.current = null
        setSelectedTrackPickerIds([])
        setIsTrackPickerOpen(String(tutorialTracksRequest.picker || 'closed') === 'open')
        onTutorialHideInactive?.(Boolean(tutorialTracksRequest.hideInactive))
    }, [tutorialTracksRequest, onTutorialHideInactive])

    // The registry may arrive after the request. Seed its chosen rows once all are
    // available, without reselecting rows after a later refresh or user click.
    useEffect(() => {
        if (!tutorialTracksRequest || seededTrackPickerRequestRef.current === tutorialTracksRequest) return
        const chosen = Array.isArray(tutorialTracksRequest.chosen) ? tutorialTracksRequest.chosen : []
        const matching = (key) => (Array.isArray(availableTracks) ? availableTracks : []).find((track) =>
            String(track?.path || '').endsWith(TRACK_FILENAMES[key] || '\u0000')
        )
        const selected = chosen.map(matching)
        if (selected.some((track) => !track)) return
        const chosenGroups = (Array.isArray(tutorialTracksRequest.groupsChosen) ? tutorialTracksRequest.groupsChosen : [])
            .map((name) => (Array.isArray(availableGroups) ? availableGroups : []).find((group) => group.label === name))
        if (chosenGroups.some((group) => !group)) return
        seededTrackPickerRequestRef.current = tutorialTracksRequest
        setSelectedTrackPickerIds([
            ...selected.map((track) => String(track.id || '')),
            ...chosenGroups.map((group) => `${TRACK_PICKER_GROUP_PREFIX}${group.id}`),
        ])
    }, [tutorialTracksRequest, availableTracks, availableGroups])

    /* Track groups on this panel.
     *
     * A group's tracks are ordinary custom tracks that carry `group` (and, shown joined,
     * the row they share), so they load, draw and hit-test as any other. Switched on, a
     * group puts back any of its tracks that were removed, turns them all on and gathers
     * them into group order; switched off, whatever of it is here is turned off. */
    const registryTracksById = useMemo(
        () => new Map((Array.isArray(availableTracks) ? availableTracks : []).map((t) => [String(t.id), t])),
        [availableTracks]
    )

    const buildGroupMemberTrack = useCallback((group, member, index) => {
        const registered = registryTracksById.get(String(member?.track_id || ''))
        if (!registered) return null
        const built = buildCustomTrackFromRegistered(effectiveMemberTrack(registered, member))
        return {
            ...built,
            group: { id: group.id, label: group.label, layout: group.layout, index },
            joinedRowId: group.layout === 'joined' ? groupRowIdFor(group.id) : undefined,
        }
    }, [registryTracksById, buildCustomTrackFromRegistered])

    /* A tutorial's groups on this panel, by name: exactly those, each with all its tracks,
     * switched on. Waits for the registry to list them, since the arrival makes the group
     * a moment before the panel hears about it. */
    useEffect(() => {
        if (!tutorialTracksRequest) return
        const names = Array.isArray(tutorialTracksRequest.groupsAdded) ? tutorialTracksRequest.groupsAdded : []
        const groups = names.map((name) => (Array.isArray(availableGroups) ? availableGroups : []).find((group) => group.label === name))
        if (groups.some((group) => !group)) return
        const wantedIds = new Set(groups.map((group) => group.id))
        setCustomTracks((prev) => {
            let next = prev.filter((ct) => !ct.group || wantedIds.has(ct.group.id))
            for (const group of groups) {
                const present = new Set(next.filter((ct) => ct.group?.id === group.id).map((ct) => String(ct.registryTrackId || '')))
                ;(group.members || []).forEach((member, index) => {
                    if (present.has(String(member.track_id))) return
                    const built = buildGroupMemberTrack(group, member, index)
                    if (built) next.push(built)
                })
            }
            next = next.map((ct) => (ct.group && !ct.visible ? { ...ct, visible: true } : ct))
            const same = next.length === prev.length && next.every((track, index) => track === prev[index])
            return same ? prev : next
        })
    }, [tutorialTracksRequest, availableGroups, buildGroupMemberTrack])

    const showTrackGroup = useCallback((group) => {
        if (!group?.id) return
        pendingGroupOrderRef.current.add(group.id)
        setCustomTracks((prev) => {
            const present = new Set(prev.filter((t) => t.group?.id === group.id).map((t) => String(t.registryTrackId || '')))
            const next = prev.map((t) => (t.group?.id === group.id && !t.visible ? { ...t, visible: true } : t))
            ;(group.members || []).forEach((member, index) => {
                if (present.has(String(member.track_id))) return
                const built = buildGroupMemberTrack(group, member, index)
                if (built) next.push(built)
            })
            return next
        })
    }, [buildGroupMemberTrack])

    // ── Reopening last session's tracks ──
    // Once, when the panel first has both the registry and the saved session, and only onto
    // a panel with nothing open yet. Until then nothing is reported, so the empty panel of
    // a fresh start never overwrites what was saved.
    const sessionRestoredRef = useRef(false)
    const sessionRestoringRef = useRef(false)
    const lastReportedSessionRef = useRef(null)
    useEffect(() => {
        if (sessionRestoredRef.current || !sessionReady || tutorialTracksRequest) return
        sessionRestoredRef.current = true
        const entries = Array.isArray(sessionTracks) ? sessionTracks : []
        if (!entries.length) return
        const groupsById = new Map((Array.isArray(availableGroups) ? availableGroups : []).map((g) => [String(g.id), g]))
        const plan = planSessionRestore(entries, { tracksById: registryTracksById, groupsById })
        const restored = []
        for (const item of plan) {
            if (item.kind === 'track') {
                restored.push({ ...buildCustomTrackFromRegistered(item.track), visible: item.visible })
            } else if (item.kind === 'group_track') {
                const built = buildGroupMemberTrack(item.group, item.member, item.index)
                if (built) restored.push({ ...built, visible: item.visible })
            } else {
                ;(item.group.members || []).forEach((member, index) => {
                    const built = buildGroupMemberTrack(item.group, member, index)
                    if (built) restored.push({ ...built, visible: item.visible })
                })
            }
        }
        if (!restored.length) return
        sessionRestoringRef.current = true
        setCustomTracks((prev) => (prev.length ? prev : restored))
    }, [sessionReady, sessionTracks, tutorialTracksRequest, availableGroups, registryTracksById, buildCustomTrackFromRegistered, buildGroupMemberTrack])

    useEffect(() => {
        if (!sessionRestoredRef.current || !onSessionTracksChange || tutorialTracksRequest) return
        // Not between renders: while reopened tracks have not landed, or the order has not
        // caught up with the tracks, what is open is not yet what will be.
        if (sessionRestoringRef.current && !customTracks.length) return
        const orderIds = new Set(trackOrder)
        if (customTracks.some((t) => !orderIds.has(t.joinedRowId || t.id))) return
        sessionRestoringRef.current = false
        const entries = describeSessionTracks(customTracks, trackOrder)
        const signature = JSON.stringify(entries)
        if (lastReportedSessionRef.current === null) {
            // The first look after reopening: what was saved is what is open, unless some of
            // it could not be reopened.
            lastReportedSessionRef.current = JSON.stringify(Array.isArray(sessionTracks) ? sessionTracks : [])
        }
        if (signature === lastReportedSessionRef.current) return
        lastReportedSessionRef.current = signature
        onSessionTracksChange(entries)
    }, [customTracks, trackOrder, onSessionTracksChange, tutorialTracksRequest, sessionTracks])

    const pickerHasChanges = selectedTrackPickerIds.length > 0 || pendingPickerRemovals.length > 0

    const applyTrackPickerChanges = useCallback(() => {
        const removals = new Set(pendingPickerRemovals.map(String))
        if (removals.size) {
            setCustomTracks((prev) => prev.filter((ct) => {
                if (ct.group) return !removals.has(`${TRACK_PICKER_GROUP_PREFIX}${ct.group.id}`)
                return !removals.has(String(ct.registryTrackId || ''))
            }))
        }
        if (!Array.isArray(selectedTrackPickerIds) || selectedTrackPickerIds.length === 0) {
            closeTrackPicker()
            return
        }
        const selectedIdSet = new Set(selectedTrackPickerIds.map((id) => String(id)))
        const tracksToAdd = (Array.isArray(availableTracks) ? availableTracks : []).filter((track) =>
            selectedIdSet.has(String(track?.id || ''))
        )
        const groupsToAdd = (Array.isArray(availableGroups) ? availableGroups : []).filter((group) =>
            selectedIdSet.has(`${TRACK_PICKER_GROUP_PREFIX}${group.id}`)
        )
        if (tracksToAdd.length === 0 && groupsToAdd.length === 0) {
            closeTrackPicker()
            return
        }
        if (tracksToAdd.length) {
            setCustomTracks((prev) => {
                const next = [...prev]
                for (const registeredTrack of tracksToAdd) {
                    // A group's copy of a track is its own; this looks for the track on its own.
                    const duplicate = next.some((ct) => !ct.group && (
                        String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                        || (
                            String(ct.path || '') === String(registeredTrack.path || '')
                            && String(ct.type || 'bigwig') === String(registeredTrack.type || 'bigwig')
                        )
                    ))
                    if (duplicate) continue
                    next.push(buildCustomTrackFromRegistered(registeredTrack))
                }
                return next
            })
        }
        for (const group of groupsToAdd) showTrackGroup(group)
        closeTrackPicker()
    }, [selectedTrackPickerIds, pendingPickerRemovals, availableTracks, availableGroups, closeTrackPicker, buildCustomTrackFromRegistered, showTrackGroup])

    useEffect(() => {
        if (!isTrackPickerOpen) return
        const valid = new Set((Array.isArray(availableTracks) ? availableTracks : []).map((track) => String(track?.id || '')))
        for (const group of Array.isArray(availableGroups) ? availableGroups : []) valid.add(`${TRACK_PICKER_GROUP_PREFIX}${group.id}`)
        setSelectedTrackPickerIds((prev) => {
            if (!Array.isArray(prev) || prev.length === 0) return prev
            const next = prev.filter((id) => valid.has(String(id)))
            if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev
            return next
        })
        setPendingPickerRemovals((prev) => {
            if (!prev.length) return prev
            const next = prev.filter((id) => valid.has(String(id)))
            return next.length === prev.length ? prev : next
        })
    }, [availableTracks, availableGroups, isTrackPickerOpen])

    // The panel is as loaded as it is going to get once the regions are in. What
    // it would otherwise still be waiting on is the first gene tile, and while
    // the index is being built there is no gene tile coming — leaving this up
    // would put a full-panel spinner over the very browser the build was made
    // non-blocking so the user could use.
    const showInitialLoadingOverlay = loadingRegions
        || (Boolean(selectedChrom) && !hasInitialViewportData && !geneTilesBlocked)

    // Screen-reader description of the active controls, generated from the same
    // source as the settings cheat sheet so the two cannot drift apart.
    const keyboardHintId = `${useId()}-browsing-controls`
    const keyboardHintText = useMemo(() => (
        describeBrowsingControls(browsingControls)
            .map((row) => `${row.gesture}: ${row.action}.`)
            .join(' ')
    ), [browsingControls])

    return (
        renderBrowserPanel({
            CONTROL_GAP_PX,
            PickerRowButton,
            TranscriptInfoPopup,
            applyTrackPickerChanges,
            availableGroups,
            availableTracks,
            canConfirmCustomTrack,
            canvasRef,
            chromLabel,
            clearTranscriptPopupDismissTimer,
            clickedBigBedFeature,
            clickedGeneTranscript,
            clickedSeqBase,
            clickedSpliceJunction,
            clickedVcfVariant,
            closeTrackPicker,
            colors,
            containerRef,
            customTrackHoverTooltip,
            customTrackLabelInput,
            customTrackRenderModeInput,
            customTracks,
            customTracksById,
            effectiveFocusBarPosition,
            effectiveToolbarPosition,
            fetchTranscripts,
            geneIndexOverlayGeometry,
            geneIndexStatus,
            geneNoteOverlay,
            genome,
            genomePillLabel,
            getCustomTrackToggleY,
            gutterMarkerHeight,
            handleCanvasClick,
            handleConfirmAddCustomTrack,
            handleContainerMouseLeave,
            handleKeyDown,
            handleMouseDown,
            handleMouseMove,
            handleMouseUp,
            hiddenStrands,
            isBoxSelectMode,
            isCustomTrackLabelModalOpen,
            isDragging,
            isLight,
            isSelectingRect,
            isTrackPickerOpen,
            keyboardHintId,
            keyboardHintText,
            label,
            layout,
            loadingGenes,
            onFocusTranscriptViewChangeRef,
            onGeneTranscriptViewChangeRef,
            onOpenGeneNotesRef,
            panelPillColor,
            pendingPickerRemovals,
            pickerHasChanges,
            registryTracksById,
            requestTranscriptPillFocus,
            retryGeneIndex,
            rootRef,
            scheduleTranscriptPopupDismiss,
            screenshotTargetId,
            selectedChrom,
            selectedGeneInfoBar,
            selectedLocationInfoBar,
            selectedTrackPickerIds,
            setCustomTrackLabelInput,
            setCustomTrackRenderModeInput,
            setCustomTracks,
            setExpandedGenes,
            setHiddenStrands,
            setIsCustomTrackLabelModalOpen,
            setPendingCustomTrackPath,
            setSelectedGene,
            showInitialLoadingOverlay,
            showSequenceTrack,
            sidebarTooltip,
            togglePickerChange,
            toolbar,
            transcriptCache,
            transcriptFooterOverlay,
            transcriptPopupHoverRef,
            tutorialAnchorsActive,
            viewWidth,
        })
    )
}

export default memo(GenomeBrowser)
