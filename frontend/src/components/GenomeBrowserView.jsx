import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { flushSync } from 'react-dom'
import useTutorial from '../hooks/useTutorial'
import { registerBrowserNotes, describeBrowserViewport, browserViewportControls } from '../utils/browserTutorialControls'
import { linkedGeneFraming } from '../utils/linkedGeneFraming'
import GenomeBrowser from './GenomeBrowser'
import GenomeWheel from './GenomeWheel'
import { registerTutorialBrowserHost } from '../utils/tutorialBrowserScene.js'
import FocusGeneDrawer, { FOCUS_DRAWER_DETAIL_WIDTH, FOCUS_DRAWER_RAIL_WIDTH, FOCUS_DRAWER_WIDTH } from './FocusGeneDrawer'
import AssemblyInfoDrawer from './AssemblyInfoDrawer'
import { hasAssemblyMetadata } from '../utils/assemblyMetadataRows'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'

import { API_BASE } from '../backendRuntime'
import { classifyReadiness, readinessRetryDelay } from '../utils/browserReadiness'
import { genomeColorResolver } from '../genomeColorSchemes'
import useScreenshotTargets from '../hooks/useScreenshotTargets'
import { rasterizeSvgMarkup } from '../utils/screenshotExport'
import { getAssemblyGenomeKey, getGenomeKey, genomeKeysMatch } from '../utils/genomeIdentity'
import { cycleBottomSpacer } from '../utils/genomeWheel'
import { LOCKED_ICON_PATH, UNLOCKED_ICON_PATH } from '../utils/lockIcons'
import {
    DEFAULT_NOTE_SORT_MODE,
    buildGeneNoteTarget,
    normalizeNoteGenomeKey,
} from '../utils/geneNotes'
import useNoteStore from '../hooks/useNoteStore'
import { alignBandToBar, getGenomeBrowserPanelSizing } from './genomeBrowserViewportLayout'
import {
    DRAG_AXIS_THRESHOLD_PX,
    isTextEntryTarget,
    isWheelHandled,
    markWheelHandled,
    pickNearestPanel,
    readWheelEvent,
    resolveBrowsingControls,
    resolveDragAxis,
    resolveWheelAction,
    noteWheelGestureOrigin,
} from '../utils/browsingControls'

/** Shared empties, so a panel with no notes hands its children a stable prop. */
const EMPTY_NOTE_COUNTS = Object.freeze({})
const EMPTY_NOTE_LIST = Object.freeze([])

/**
 * Things a drag must not be stolen from: controls that expect a click, and text
 * a user may legitimately want to select.
 */
const DRAG_SCROLL_EXCLUDED_SELECTOR = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    'label',
    'summary',
    'option',
    '[role="button"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="slider"]',
    '[contenteditable="true"]',
    '[data-no-drag-scroll="true"]',
].join(',')

const IndexPreparingNotice = ({ isLight, state, detail, onRetry }) => {
    const isError = state === 'error'
    const title = isError ? 'Index Not Ready' : 'Building Index'
    const message = isError
        ? (detail || 'The index is not ready for display. Please finish indexing, then try again.')
        : 'Preparing regions for display. This view will refresh automatically when the index is ready.'

    return (
        <div className={`h-full w-full flex flex-col items-center justify-center p-6 ${isLight ? 'bg-blue-50/50' : 'bg-blue-900/10'}`}>
            {!isError ? (
                <div className={`w-8 h-8 border-4 border-t-transparent rounded-full animate-spin mb-3 ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
            ) : (
                <svg className={`w-12 h-12 mb-3 ${isLight ? 'text-amber-500' : 'text-amber-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
            )}
            <p className={`text-sm font-semibold ${isLight ? (isError ? 'text-amber-800' : 'text-blue-800') : (isError ? 'text-amber-300' : 'text-blue-300')}`}>
                {title}
            </p>
            <p className={`text-xs text-center max-w-sm mt-1 ${isLight ? (isError ? 'text-amber-700/80' : 'text-blue-700/80') : (isError ? 'text-amber-300/90' : 'text-blue-300/80')}`}>
                {message}
            </p>
            {/* A build that failed is remembered, so polling alone will never
                clear it — without a way to ask again the only way out was to
                restart the backend. */}
            {isError && onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className={`mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${isLight
                        ? 'border-amber-300 bg-white text-amber-800 hover:bg-amber-50'
                        : 'border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'}`}
                >
                    Build the index again
                </button>
            )}
        </div>
    )
}

function dirnameFromPath(filepath) {
    if (!filepath || typeof filepath !== 'string') return ''
    const normalized = filepath.replace(/\/+$/, '')
    const idx = normalized.lastIndexOf('/')
    if (idx <= 0) return ''
    return normalized.slice(0, idx)
}

function formatSpeciesForPill(species) {
    if (!species) return ''
    if (species.display_name) return species.display_name
    if (species.common_name) return species.common_name
    const name = species.scientific_name || ''
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length < 2) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function buildGenomePillLabel(species) {
    if (!species) return ''
    const name = formatSpeciesForPill(species)
    const assembly = species?.assembly_name || species?.assembly || ''
    return assembly ? `${name} — ${assembly}` : name
}

function speciesItemKey(species) {
    return getGenomeKey(species)
}

// The app's scroll container. `findPanelScroller` also insists the content
// already overflows, which is the wrong question for the alignment below: the
// whitespace under the last panel exists precisely to create that overflow.
function findScrollHost(from) {
    let node = from
    while (node && node !== document.body) {
        const overflowY = window.getComputedStyle(node).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') return node
        node = node.parentElement
    }
    return null
}

// How much of the top of the page the general control bar is covering. Zero
// while it is locked into the page; once unlocked it floats over the top of the
// scroller, and a genome has to be parked under it rather than behind it.
function stickyControlsInset(root) {
    const bar = root?.querySelector('[data-browser-global-controls="true"]')
    if (!bar || window.getComputedStyle(bar).position !== 'sticky') return 0
    return Math.round(bar.getBoundingClientRect().height)
}

// The control bar a genome is aligned by — the row carrying its pill, which is
// what the reader sees meet the app's top bar.
function panelAlignmentAnchor(host, panelKey) {
    const wrapper = panelKey
        ? host?.querySelector(`[data-focus-panel-wrapper="${CSS.escape(panelKey)}"]`)
        : [...(host?.querySelectorAll('[data-focus-panel-wrapper]') || [])].pop()
    return wrapper?.querySelector('[data-browser-toolbar="true"]') || wrapper || null
}

function dedupeSpeciesList(speciesList) {
    const out = []
    const seen = new Set()
    for (const species of Array.isArray(speciesList) ? speciesList : []) {
        if (!species) continue
        const key = speciesItemKey(species)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(species)
    }
    return out
}

function hasFiniteGeneCoords(gene) {
    return Boolean(gene) &&
        Number.isFinite(Number(gene.start)) &&
        Number.isFinite(Number(gene.end)) &&
        String(gene.chrom || '').trim().length > 0
}

function geneFivePrime(gene) {
    return gene?.strand === '+' ? Number(gene.start) : Number(gene.end)
}

function sameArrayMembers(a, b) {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

function samePanelPosition(a, b) {
    if (a === b) return true
    if (!a || !b) return false
    return (
        String(a.chrom || '') === String(b.chrom || '') &&
        Number(a.start) === Number(b.start) &&
        Number(a.end) === Number(b.end) &&
        String(a.targetTrack || '') === String(b.targetTrack || '') &&
        Number(a.anchorRatio) === Number(b.anchorRatio)
    )
}

function chromosomeTokenVariants(value) {
    const raw = String(value || '').trim()
    if (!raw) return new Set()
    const lower = raw.toLowerCase()
    const variants = new Set([lower])
    if (lower.startsWith('chr') && lower.length > 3) variants.add(lower.slice(3))
    else variants.add(`chr${lower}`)
    if (['m', 'mt', 'chrm', 'chrmt'].includes(lower)) {
        variants.add('m')
        variants.add('mt')
        variants.add('chrm')
        variants.add('chrmt')
    }
    return variants
}

function chromosomeTokensForRegion(region, fallbackChrom = '') {
    const tokens = new Set()
    for (const value of [fallbackChrom, region?.chrom, ...(Array.isArray(region?.synonyms) ? region.synonyms : [])]) {
        for (const token of chromosomeTokenVariants(value)) tokens.add(token)
    }
    return tokens
}

function regionMatchesTokens(region, tokens) {
    if (!region || !tokens?.size) return false
    for (const token of chromosomeTokensForRegion(region)) {
        if (tokens.has(token)) return true
    }
    return false
}

function resolveRegionByChromTokens(regions, chromOrTokens) {
    const tokens = chromOrTokens instanceof Set ? chromOrTokens : chromosomeTokenVariants(chromOrTokens)
    if (!tokens.size || !Array.isArray(regions)) return null
    return regions.find((region) => regionMatchesTokens(region, tokens)) || null
}

function clampWindowToRegion(chrom, start, end, region) {
    const requestedStart = Number(start)
    const requestedEnd = Number(end)
    if (!chrom || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd <= requestedStart) {
        return null
    }
    const minStart = Math.max(1, Math.floor(Number(region?.start) || 1))
    const maxEnd = Math.max(minStart + 1, Math.floor(Number(region?.end || region?.length) || requestedEnd))
    const requestedSpan = requestedEnd - requestedStart
    const maxSpan = maxEnd - minStart
    if (requestedSpan >= maxSpan) {
        return { chrom, start: minStart, end: maxEnd }
    }
    const nextStart = Math.min(Math.max(requestedStart, minStart), maxEnd - requestedSpan)
    return { chrom, start: nextStart, end: nextStart + requestedSpan }
}

export default function GenomeBrowserView({
    theme = 'dark',
    config,
    listedGenomes = [],
    onPromoteGenome = null,
    isActive = true,
    allowBackgroundPrep = false,
    onRefGeneSelect,
    onTgtGeneSelect,
    onRefViewportChange,
    refReloadKey = 0,
    tgtReloadKey = 0,
    alignmentOverlay,
    onClearAlignmentOverlay,
    externalRefGene = null,
    externalAlignmentLocus = null,
    externalTgtGene = null,
    externalFocusGenesByGenome = null,
    onGeneFocusByGenomeChange = null,
    onClearFocusedGenes = null,
    screenshotMode = false,
    onScreenshotModeChange = null,
    onScreenshotAvailabilityChange = null,
    screenshotToggleButtonRef = null,
}) {
    // Taken from the context rather than threaded as a prop, the way DownloadView does
    // it: the tutorial provider sits above App, so every view can reach the runtime
    // without anything in between having to pass it along.
    const { emitSignal: emitTutorialSignal, isRunning: tutorialRunning, browserTracksRequest } = useTutorial()
    const [lockPan, setLockPan] = useState(false)
    const [lockZoom, setLockZoom] = useState(false)

    const [globalTracksState, setGlobalTracksState] = useState('on')
    const [forceTracksVisibility, setForceTracksVisibility] = useState(undefined)
    const [hideInactiveMode, setHideInactiveMode] = useState(false)
    const [compressMode, setCompressMode] = useState(false)
    const [flattenMode, setFlattenMode] = useState(false)
    // null until the user presses the Adaptive button. Once they have, their choice
    // sticks for the rest of the session — including across multi -> single -> multi
    // — so we never re-enable something they deliberately turned off.
    const [adaptivePanelHeightOverride, setAdaptivePanelHeightOverride] = useState(null)
    const [panelContentHeights, setPanelContentHeights] = useState({})
    const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)

    const [biotypeFilter, setBiotypeFilter] = useState({
        proteinCoding: true,
        lncRNA: true,
        smallNonCoding: true,
        pseudogene: true,
    })
    const hiddenBiotypeClasses = Object.entries(biotypeFilter)
        .filter(([, v]) => !v)
        .map(([k]) => k)

    const [selectedGenes, setSelectedGenes] = useState({})
    const [navigateGenes, setNavigateGenes] = useState({})
    const [panelPositions, setPanelPositions] = useState({})
    const [linkedPanelKeys, setLinkedPanelKeys] = useState([])
    const [linkingGene, setLinkingGene] = useState(false)
    const [linkingRegion, setLinkingRegion] = useState(false)
    const [browserReadyState, setBrowserReadyState] = useState({})
    const [clearFocusEpoch, setClearFocusEpoch] = useState(0)

    // Focus-gene drawer. The view model lives here rather than in each browser
    // panel so one drawer can drive whichever panel the user last focused.
    const [focusTranscriptViews, setFocusTranscriptViews] = useState({})
    const [focusTranscriptData, setFocusTranscriptData] = useState({})
    const [focusPanelOrder, setFocusPanelOrder] = useState([])
    // Per panel, because every genome carries its own drawer now. Absent means
    // open: a gene that has just taken focus should present its transcripts.
    const [focusDrawerOpenByPanel, setFocusDrawerOpenByPanel] = useState({})

    const tracksStateRef = useRef({})
    const linkModelRef = useRef(null)
    const linkApplyTimerRef = useRef(null)
    const wasActiveRef = useRef(isActive)
    // Read by the gutter wheel router, which is attached to a container shared
    // with the other views.
    const isActiveRef = useRef(isActive)
    isActiveRef.current = isActive
    const browserReadyStateRef = useRef(browserReadyState)
    const previousPanelParamRef = useRef({})
    const previousReloadRef = useRef({ ref: refReloadKey, tgt: tgtReloadKey })
    const lockPanRef = useRef(false)
    const lockZoomRef = useRef(false)
    const panelActualPositionsRef = useRef({})
    const regionCacheRef = useRef(new Map())
    const syncSourcePanelKeyRef = useRef('')
    const screenshotPanelsRef = useRef(null)
    const screenshotOverlayRootRef = useRef(null)
    lockPanRef.current = lockPan
    lockZoomRef.current = lockZoom
    const {
        targets: screenshotTargets,
        upsertTarget: upsertScreenshotTarget,
        removeTarget: removeScreenshotTarget,
    } = useScreenshotTargets()

    const isLight = theme === 'light'
    const isOverlayActive = !!alignmentOverlay
    const effectiveLockPan = lockPan || isOverlayActive
    const effectiveLockZoom = lockZoom || isOverlayActive
    const linkedSet = useMemo(() => new Set(linkedPanelKeys), [linkedPanelKeys])

    const panelSpecies = useMemo(() => {
        return dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    }, [config?.active_species])

    // Panel colour follows the genome, not the panel's position, so promoting a
    // genome to the top no longer repaints every panel below it.
    const resolveGenomeColor = useMemo(() => genomeColorResolver(config), [config])

    const panels = useMemo(() => {
        const refGff = String(config?.ref_gff || '').trim()
        const targetGff = String(config?.target_gff || '').trim()
        return panelSpecies.map((species, index) => {
            const panelKey = speciesItemKey(species)
            const gffPath = String(species?.files?.gff3 || '').trim()
            const isPrimary = index === 0
            const useSecondaryPreset = index > 0
            const alignmentRole = gffPath && refGff && gffPath === refGff
                ? 'reference'
                : (gffPath && targetGff && gffPath === targetGff ? 'target' : '')
            const genomeParam = panelKey || (index === 0 ? 'reference' : (index === 1 ? 'target' : ''))
            return {
                index,
                key: panelKey,
                species,
                isPrimary,
                useSecondaryPreset,
                genomeParam,
                alignmentRole,
                label: isPrimary ? 'Primary' : 'Secondary',
                genomePillLabel: buildGenomePillLabel(species),
                customTrackBrowsePath: dirnameFromPath(species?.files?.gff3),
            }
        })
    }, [panelSpecies, config?.ref_gff, config?.target_gff])

    const panelCount = panels.length
    const hasPanels = panelCount > 0
    const anyGeneSelected = panels.some((panel) => Boolean(selectedGenes[panel.key]))

    // --- Focus drawer plumbing ------------------------------------------------

    // What the user set up for a gene outlives unfocusing it: the browser keeps
    // drawing that ordering and those hidden transcripts whether the gene holds
    // focus or not. State rather than a ref, because the panels render from it.
    // Keyed per panel so the same gene in two genomes stays independent.
    const [geneTranscriptViews, setGeneTranscriptViews] = useState({})

    const rememberGeneView = useCallback((panelKey, geneId, view) => {
        if (!panelKey || !geneId) return
        setGeneTranscriptViews((prev) => {
            const panelViews = prev[panelKey] || {}
            const next = {
                order: view?.order ?? null,
                hidden: view?.hidden ?? [],
                expanded: view?.expanded ?? null,
            }
            const current = panelViews[geneId]
            if (current && JSON.stringify(current) === JSON.stringify(next)) return prev
            return { ...prev, [panelKey]: { ...panelViews, [geneId]: next } }
        })
    }, [])

    const handlePanelGeneSelect = useCallback((panelKey, gene) => {
        setSelectedGenes((prev) => ({ ...prev, [panelKey]: gene || null }))
        const geneId = String(gene?.id || '').trim()
        setFocusTranscriptViews((prev) => {
            const current = prev[panelKey]
            if (!geneId) {
                if (!current) return prev
                const next = { ...prev }
                delete next[panelKey]
                return next
            }
            if (current?.geneId === geneId) return prev
            const remembered = geneTranscriptViews[panelKey]?.[geneId]
            return {
                ...prev,
                [panelKey]: {
                    geneId,
                    order: remembered?.order ?? null,
                    hidden: remembered?.hidden ?? [],
                    // null defers to whatever the panel already had expanded, so
                    // focusing an already-expanded gene does not collapse it.
                    expanded: remembered?.expanded ?? null,
                    ghostId: null,
                    hoverId: null,
                    pinnedId: null,
                },
            }
        })
        setFocusPanelOrder((prev) => {
            const without = prev.filter((key) => key !== panelKey)
            return geneId ? [panelKey, ...without] : without
        })
        // A fresh focus always presents that panel's drawer open, whatever the
        // user did with its collapse arrow last time.
        if (geneId) setFocusDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
        else setDetailTranscriptByPanel((prev) => ({ ...prev, [panelKey]: '' }))
    }, [geneTranscriptViews])

    // Addressed by gene id rather than "whatever is focused", so the canvas
    // controls can act on any gene. Keeps the live drawer view in step when the
    // gene being edited happens to be the focused one.
    const handleGeneTranscriptViewChange = useCallback((panelKey, geneId, patch) => {
        const id = String(geneId || '').trim()
        if (!id) return
        setGeneTranscriptViews((prev) => {
            const panelViews = prev[panelKey] || {}
            const current = panelViews[id] || { order: null, hidden: [], expanded: null }
            const next = { ...current, ...patch }
            if (JSON.stringify(current) === JSON.stringify(next)) return prev
            return { ...prev, [panelKey]: { ...panelViews, [id]: next } }
        })
        setFocusTranscriptViews((prev) => {
            const current = prev[panelKey]
            if (!current || current.geneId !== id) return prev
            return { ...prev, [panelKey]: { ...current, ...patch } }
        })
    }, [])

    // Where each panel says its pinned transcript's row sits, in panel-local
    // pixels. Kept per panel so switching focus genes does not align to a
    // reading taken from the panel the user just left.
    const [focusRowGeometry, setFocusRowGeometry] = useState({})

    const handleFocusRowGeometryChange = useCallback((panelKey, geometry) => {
        setFocusRowGeometry((prev) => {
            const current = prev[panelKey] || null
            if (!geometry) {
                if (!current) return prev
                const next = { ...prev }
                delete next[panelKey]
                return next
            }
            const unchanged = current
                && current.transcriptId === geometry.transcriptId
                && Math.abs(current.offsetTop - geometry.offsetTop) < 0.5
                && Math.abs(current.height - geometry.height) < 0.5
                && current.resolved === geometry.resolved
            if (unchanged) return prev
            return { ...prev, [panelKey]: geometry }
        })
    }, [])

    const handleFocusTranscriptsChange = useCallback((panelKey, payload) => {
        setFocusTranscriptData((prev) => {
            if (!payload) {
                if (!prev[panelKey]) return prev
                const next = { ...prev }
                delete next[panelKey]
                return next
            }
            return { ...prev, [panelKey]: payload }
        })
    }, [])

    const handleFocusTranscriptViewChange = useCallback((panelKey, patch) => {
        setFocusTranscriptViews((prev) => {
            // Taking a pin in one genome releases whatever another was holding:
            // alignment brings one row level with its identifier, and it cannot
            // do that for two genomes at once.
            if (patch.pinnedId) {
                for (const key of Object.keys(prev)) {
                    if (key === panelKey || !prev[key]?.pinnedId) continue
                    prev = { ...prev, [key]: { ...prev[key], pinnedId: null, ghostId: null, hoverId: null } }
                }
            }
            const current = prev[panelKey]
            if (!current) return prev
            const next = { ...current, ...patch }
            const unchanged = Object.keys(patch).every((key) => (
                Array.isArray(patch[key])
                    ? JSON.stringify(patch[key]) === JSON.stringify(current[key])
                    : patch[key] === current[key]
            ))
            if (unchanged) return prev
            rememberGeneView(panelKey, next.geneId, next)
            return { ...prev, [panelKey]: next }
        })
    }, [rememberGeneView])

    useEffect(() => {
        if (!clearFocusEpoch) return
        setFocusTranscriptViews({})
        setFocusTranscriptData({})
        setFocusPanelOrder([])
        // The next gene the user focuses should slide out open, not as a rail.
        setFocusDrawerOpenByPanel({})
        setDetailTranscriptByPanel({})
        setNotesPanelOpenByPanel({})
        setOpenNoteIdByPanel({})
    }, [clearFocusEpoch])

    // Panels the user has actually focused a gene in, most recent first.
    const focusDrawerEntries = useMemo(() => {
        const byKey = new Map(panels.map((panel) => [panel.key, panel]))
        const keys = [
            ...focusPanelOrder.filter((key) => byKey.has(key)),
            ...panels.map((panel) => panel.key).filter((key) => !focusPanelOrder.includes(key)),
        ]
        return keys
            .map((key) => {
                const panel = byKey.get(key)
                const data = focusTranscriptData[key]
                if (!panel || !data?.gene) return null
                return {
                    panelKey: key,
                    label: panel.label,
                    // The sequence endpoint is keyed by genome, not by panel.
                    genomeParam: panel.genomeParam,
                    pillLabel: panel.genomePillLabel || panel.label,
                    color: resolveGenomeColor(panel.species),
                    gene: data.gene,
                    transcripts: data.transcripts,
                    loading: data.loading,
                    // Fallback for a view that has not set `expanded` yet.
                    panelExpanded: Boolean(data.expanded),
                }
            })
            .filter(Boolean)
    }, [panels, focusPanelOrder, focusTranscriptData, resolveGenomeColor])

    const findPanelScroller = useCallback((from) => {
        let node = from
        while (node && node !== document.body) {
            const overflowY = window.getComputedStyle(node).overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
                return node
            }
            node = node.parentElement
        }
        return null
    }, [])

    // Unlocked — the default — has the general control bar follow the reader down
    // the page, so Cycle and the rest stay in reach however far they scroll.
    // Locked leaves it in the page, where it scrolls away like everything else.
    const [controlsFollowScroll, setControlsFollowScroll] = useState(true)

    // ── Cycling to a genome ──────────────────────────────────────────────────
    //
    // Whichever genome the Cycle wheel lands on is parked against the app's top
    // bar, so a jump between genomes always leaves the reader looking at the
    // same place on screen rather than wherever that genome happened to sit.
    const cycleScrollRef = useRef(null)
    const stopCycleScroll = useCallback(() => {
        const running = cycleScrollRef.current
        if (!running) return
        cancelAnimationFrame(running.frame)
        window.removeEventListener('wheel', running.abandon, true)
        window.removeEventListener('pointerdown', running.abandon, true)
        cycleScrollRef.current = null
    }, [])
    useEffect(() => stopCycleScroll, [stopCycleScroll])

    const alignPanelToTop = useCallback((panelKey) => {
        if (!panelKey) return
        stopCycleScroll()
        const abandon = () => stopCycleScroll()
        window.addEventListener('wheel', abandon, true)
        window.addEventListener('pointerdown', abandon, true)
        // A genome that has just been added is not on the page yet, and once it
        // is its tracks keep laying out for a while afterwards. So the target is
        // remeasured every frame instead of being resolved once: the follow
        // waits for the panel to appear and then keeps closing on its control
        // bar while the panel grows underneath it.
        const deadline = performance.now() + 3000
        let previous = performance.now()
        let arrived = null
        const step = (now) => {
            const host = screenshotPanelsRef.current
            const scroller = host ? findScrollHost(host) : null
            const anchor = panelAlignmentAnchor(host, panelKey)
            if (scroller && anchor) {
                const inset = stickyControlsInset(screenshotOverlayRootRef.current)
                const gap = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset
                const eased = gap * (1 - Math.exp(-Math.min(64, now - previous) / 70))
                // The last few pixels go in one move. `scrollTop` is quantised, so
                // a step under a pixel is rounded away and the easing stalls just
                // short — leaving the genome resting under the top bar for good.
                const travel = Math.abs(eased) < 1 ? gap : eased
                scroller.scrollTop = Math.max(0, Math.min(
                    scroller.scrollHeight - scroller.clientHeight,
                    scroller.scrollTop + travel,
                ))
                // Held briefly after arriving, so a panel that is still laying its
                // tracks out cannot walk the bar back off the top; then the page is
                // the reader's again, well before the deadline.
                arrived = Math.abs(gap) <= 1 ? (arrived ?? now) : null
                if (arrived !== null && now - arrived > 250) return stopCycleScroll()
            }
            previous = now
            if (now >= deadline) return stopCycleScroll()
            cycleScrollRef.current = { frame: requestAnimationFrame(step), abandon }
        }
        cycleScrollRef.current = { frame: requestAnimationFrame(step), abandon }
    }, [stopCycleScroll])

    const handleCyclePromote = useCallback(async (panelKey, action, source) => {
        if (onPromoteGenome) await onPromoteGenome(panelKey, action, source)
        // Also for a genome that was already active: 'add' cannot add it twice,
        // so the scroll is the whole of what the jump does.
        alignPanelToTop(panelKey)
    }, [onPromoteGenome, alignPanelToTop])

    // The last genome has nothing under it to scroll into, so it alone could
    // never reach the top bar. This is the missing distance, kept as empty page
    // beneath the final panel.
    const [panelsBottomSpacer, setPanelsBottomSpacer] = useState(0)
    useEffect(() => {
        const host = screenshotPanelsRef.current
        if (!host || !hasPanels || screenshotMode) {
            setPanelsBottomSpacer(0)
            return undefined
        }
        const measure = () => {
            const scroller = findScrollHost(host)
            const anchor = panelAlignmentAnchor(host, '')
            if (!scroller || !anchor) return
            const anchorOffset = anchor.getBoundingClientRect().top
                - scroller.getBoundingClientRect().top + scroller.scrollTop
            // An unlocked control bar eats the top of the viewport, so that much
            // less whitespace is needed under the last genome to reach it.
            const inset = stickyControlsInset(screenshotOverlayRootRef.current)
            setPanelsBottomSpacer((prev) => {
                const next = cycleBottomSpacer({
                    viewport: scroller.clientHeight - inset,
                    scrollHeight: scroller.scrollHeight,
                    anchorOffset,
                    spacer: prev,
                })
                // The spacer is part of what is being measured, so shrinking it
                // by a rounding wobble would keep the observer firing forever.
                // Growth is always taken: too little whitespace is the one error
                // that shows, as a genome that stops short of the top bar.
                return next > prev || prev - next > 1 ? next : prev
            })
        }
        measure()
        // Panels grow as their tracks lay out, which moves the last control bar.
        const observer = new ResizeObserver(measure)
        observer.observe(host)
        const scroller = findScrollHost(host)
        if (scroller) observer.observe(scroller)
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [panels, hasPanels, screenshotMode, isActive, controlsFollowScroll])

    // Which transcript has its metadata/sequence detail open, per panel.
    const [detailTranscriptByPanel, setDetailTranscriptByPanel] = useState({})
    // Each drawer's X clears only its own genome. The browser watches for the
    // epoch to change, so a per-panel counter added to the global one lets one
    // panel be cleared without disturbing the others.
    const [panelClearEpochs, setPanelClearEpochs] = useState({})

    const detailTranscriptRef = useRef({})
    detailTranscriptRef.current = detailTranscriptByPanel
    const detailScrollMemoryRef = useRef({})
    // How far the transcript list is lifted so the detail's own transcript sits at
    // the top of it. Cleared when the detail closes.
    const [detailListShiftByPanel, setDetailListShiftByPanel] = useState({})

    // Opening the detail should show it from the top. Left alone it opens
    // wherever the reader happened to be, which for a transcript low in the list
    // means landing in the middle of a sequence with no idea what it belongs to.
    // Closing it puts them back where they were, on the highlighted transcript.
    const handleDetailTranscriptChange = useCallback((panelKey, transcriptId) => {
        const wasOpen = Boolean(detailTranscriptRef.current[panelKey])
        const willOpen = Boolean(transcriptId)
        setDetailTranscriptByPanel((prev) => ({ ...prev, [panelKey]: transcriptId }))
        // The detail and the notes share one wide slot. If both were ever open
        // the drawer's own width and the coverage the assembly drawer clears
        // would disagree, and the two panels would sit on top of each other.
        if (willOpen) setNotesPanelOpenByPanel((prev) => (prev[panelKey] ? { ...prev, [panelKey]: false } : prev))
        if (willOpen === wasOpen) return

        const wrapper = screenshotOverlayRootRef.current?.querySelector(
            `[data-focus-panel-wrapper="${CSS.escape(panelKey)}"]`
        )
        const drawer = wrapper?.querySelector('[data-focus-drawer="true"]')
        const scroller = drawer ? findPanelScroller(drawer) : null
        if (!drawer || !scroller) return
        const scrollTo = (value) => {
            scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value))
        }

        if (willOpen) {
            detailScrollMemoryRef.current[panelKey] = scroller.scrollTop
            const above = drawer.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            // Only when its top has gone past — no need to move a detail that is
            // already showing from the beginning.
            if (above < 0) scrollTo(scroller.scrollTop + above)

            // Bring the transcript the detail is about to the top of the list, so
            // it is obvious which of twenty identifiers the panel is describing.
            // Deferred a frame: the drawer widens and the list offset drops as the
            // detail opens, and the row's position is only settled after that.
            requestAnimationFrame(() => {
                const row = wrapper.querySelector(
                    `[data-drawer-transcript-row="${CSS.escape(transcriptId)}"]`
                )
                const list = wrapper.querySelector('[data-focus-drawer-list="true"]')
                if (!row || !list) return
                const shift = Math.round(row.getBoundingClientRect().top - list.getBoundingClientRect().top)
                setDetailListShiftByPanel((prev) => ({ ...prev, [panelKey]: Math.max(0, shift) }))
            })
            return
        }

        setDetailListShiftByPanel((prev) => (prev[panelKey] ? { ...prev, [panelKey]: 0 } : prev))
        const remembered = detailScrollMemoryRef.current[panelKey]
        delete detailScrollMemoryRef.current[panelKey]
        if (Number.isFinite(remembered)) scrollTo(remembered)
    }, [findPanelScroller])

    const handleClearPanelFocus = useCallback((panelKey) => {
        setPanelClearEpochs((prev) => ({ ...prev, [panelKey]: (prev[panelKey] || 0) + 1 }))
        setDetailTranscriptByPanel((prev) => ({ ...prev, [panelKey]: '' }))
        handlePanelGeneSelect(panelKey, null)
    }, [handlePanelGeneSelect])

    // ── Gene notes ──────────────────────────────────────────────────────────
    //
    // The notes themselves live in the app-wide store (hooks/useNoteStore.jsx),
    // shared with the Notes view. What stays here is the drawer's own state:
    // which panel has the notes pane out, which note it is showing, how it is
    // sorted. Per panel, like every neighbouring map, so the same gene in two
    // genomes stays independent.

    const noteStore = useNoteStore()

    // panelKey -> bool. Shares the drawer's wide slot with the transcript detail.
    const [notesPanelOpenByPanel, setNotesPanelOpenByPanel] = useState({})
    const [openNoteIdByPanel, setOpenNoteIdByPanel] = useState({})
    const [noteSortByPanel, setNoteSortByPanel] = useState({})
    // panelKey -> the gene whose notes the reader has explicitly asked to see.
    // Set before that gene takes focus, so the focus change can tell "open the
    // notes on this gene" apart from "look at this gene".
    const notesOpenIntentRef = useRef({})
    // panelKey -> the gene id this panel was last showing, so a focus change is
    // something we can detect rather than infer.
    const focusedGeneIdRef = useRef({})

    /**
     * The assembly key a panel's notes are filed under.
     *
     * Taken from `panel.key` rather than `panel.genomeParam`: that falls back to
     * the positional 'reference'/'target', and notes filed under a slot would
     * silently re-attach themselves to whatever genome occupied it next.
     */
    const notesGenomeKeyFor = useCallback(
        (panel) => normalizeNoteGenomeKey(getAssemblyGenomeKey(panel?.key || '')),
        []
    )

    // Which gene each panel currently has focused, as a string the effects below
    // can depend on without re-firing whenever an unrelated gene field changes.
    const focusedGeneSignature = useMemo(
        () => panels.map((panel) => `${panel.key}:${selectedGenes[panel.key]?.id || ''}`).join('|'),
        [panels, selectedGenes]
    )

    const { notesForGene, geneNoteCountsForGenome: geneNoteCountsFor } = noteStore

    // Memoized rather than derived inside the render loop: the drawer memoizes
    // its sorted list and its summary rows on these arrays, and handing it a
    // fresh one every render would defeat both.
    const notesByPanel = useMemo(() => {
        const out = {}
        for (const panel of panels) {
            const geneId = String(selectedGenes[panel.key]?.id || '').trim()
            const genomeKey = notesGenomeKeyFor(panel)
            out[panel.key] = (geneId && genomeKey) ? notesForGene(genomeKey, geneId) : EMPTY_NOTE_LIST
        }
        return out
    }, [panels, selectedGenes, notesGenomeKeyFor, notesForGene])

    const noteCountsByPanel = useMemo(() => {
        const out = {}
        for (const panel of panels) {
            const genomeKey = notesGenomeKeyFor(panel)
            out[panel.key] = genomeKey ? geneNoteCountsFor(genomeKey) : EMPTY_NOTE_COUNTS
        }
        return out
    }, [panels, notesGenomeKeyFor, geneNoteCountsFor])

    // --- Panel plumbing ------------------------------------------------------

    const handleNoteCreate = useCallback((panelKey) => {
        const panel = panels.find((candidate) => candidate.key === panelKey)
        const genomeKey = notesGenomeKeyFor(panel)
        const gene = selectedGenes[panelKey]
        const geneId = String(gene?.id || '').trim()
        if (!genomeKey || !geneId) return

        const target = buildGeneNoteTarget({
            genomeKey,
            selectionKey: panel?.key || '',
            geneId,
            geneLabel: gene?.name || '',
        })
        // The id comes back on this tick, so the editor opens on the new note
        // straight away rather than after a round trip. `onIdAssigned` re-points
        // it once the server's id lands, and clears it if the create failed.
        const { tempId } = noteStore.createNote(target, {
            onIdAssigned: (fromId, toId) => {
                setOpenNoteIdByPanel((prev) => (prev[panelKey] === fromId ? { ...prev, [panelKey]: toId } : prev))
                // The tutorial waits on this rather than on the click, because the click
                // opens an editor and it is the note landing on the server that the step
                // is about — and because the id is what Back needs to remove it again.
                emitTutorialSignal('browser.noteCreated', { geneId, noteId: String(toId) })
            },
        })
        setOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: tempId }))
        setNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
        handleDetailTranscriptChange(panelKey, '')
        handleFocusTranscriptViewChange(panelKey, {
            pinnedId: null,
            ghostId: null,
            hoverId: null,
        })
        setFocusDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
    }, [panels, selectedGenes, notesGenomeKeyFor, handleDetailTranscriptChange, handleFocusTranscriptViewChange, noteStore, emitTutorialSignal])

    const handleNoteDelete = useCallback((panelKey, noteId) => {
        // Deleting is leaving the editor, not navigating to an empty editor
        // state. Return to the gene drawer's transcript list and note previews.
        setOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: '' }))
        setNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: false }))
        noteStore.deleteNote(noteId)
    }, [noteStore])

    // The browser's own controls, put back when a tutorial finishes with them.
    //
    // The tutorial sandbox is a *configuration* override, and none of these are
    // configuration: Detail, Flatten, the gene-class filter and the track master switch
    // all live in this component. So a tutorial that turned three gene classes off would
    // hand the session back with them still off, and the user would find their own
    // genomes missing half their genes with nothing on screen to explain why.
    //
    // Snapshot on the way in, restore on the way out. Same shape as the focused-gene
    // snapshot App keeps around the sandbox, and for the same reason.
    const preTutorialViewRef = useRef(null)
    const tutorialSceneActive = tutorialRunning || panels.some((p) => p.species.tutorial_dataset_id)
    useEffect(() => {
        if (tutorialSceneActive) {
            if (!preTutorialViewRef.current) {
                preTutorialViewRef.current = {
                    forceTracksVisibility,
                    lockPan, lockZoom, linkedPanelKeys, linkModel: linkModelRef.current, panelPositions, selectedGenes, navigateGenes,
                    hideInactiveMode,
                    compressMode,
                    flattenMode,
                    biotypeFilter,
                }
            }
            return
        }
        const snapshot = preTutorialViewRef.current
        if (!snapshot) return
        preTutorialViewRef.current = null
        setForceTracksVisibility(snapshot.forceTracksVisibility)
        setHideInactiveMode(snapshot.hideInactiveMode)
        setCompressMode(snapshot.compressMode)
        setFlattenMode(snapshot.flattenMode)
        setBiotypeFilter(snapshot.biotypeFilter)
        setLockPan(snapshot.lockPan); setLockZoom(snapshot.lockZoom)
        setLinkedPanelKeys(snapshot.linkedPanelKeys); linkModelRef.current = snapshot.linkModel
        setPanelPositions(snapshot.panelPositions); setSelectedGenes(snapshot.selectedGenes); setNavigateGenes(snapshot.navigateGenes)
        // Deliberately not in the dependency list: this has to read whatever the state was
        // at the moment the tutorial started and whatever it is when the tutorial ends,
        // and re-running it on every change of them would snapshot the tutorial's own
        // edits over the user's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tutorialSceneActive])

    // Published so a tutorial's Back can remove the note it took. It goes through the
    // store, so the drawer's note list and the gene's note bubble both update — deleting
    // server-side alone would leave both showing a note that is no longer there.
    useEffect(() => registerBrowserNotes({
        deleteNote: (noteId) => noteStore.deleteNote(noteId),
    }), [noteStore])

    const handleNotesPanelToggle = useCallback((panelKey) => {
        setNotesPanelOpenByPanel((prev) => {
            const opening = !prev[panelKey]
            if (opening) {
                // Routed through the detail handler rather than just clearing the
                // flag: that is what restores the remembered scroll position and
                // drops the list's lift, which a bare setState would leave behind.
                handleDetailTranscriptChange(panelKey, '')
            } else {
                const openId = openNoteIdByPanel[panelKey]
                if (openId) noteStore.saveNote(openId)
                setOpenNoteIdByPanel((all) => ({ ...all, [panelKey]: '' }))
            }
            return { ...prev, [panelKey]: opening }
        })
    }, [handleDetailTranscriptChange, noteStore, openNoteIdByPanel])

    const handleOpenNoteChange = useCallback((panelKey, noteId) => {
        setOpenNoteIdByPanel((prev) => {
            const previous = prev[panelKey]
            if (previous && previous !== noteId) noteStore.saveNote(previous)
            return { ...prev, [panelKey]: noteId }
        })
    }, [noteStore])

    /** The canvas bubble: focus already arrives via onGeneSelect, so only open. */
    const handleOpenGeneNotes = useCallback((panelKey, geneId = '') => {
        // Registered before the gene arrives, because focusing it is what
        // normally closes the notes panel — see the effect below.
        if (geneId) notesOpenIntentRef.current[panelKey] = String(geneId)
        setNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
        setOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: '' }))
        setFocusDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
        handleDetailTranscriptChange(panelKey, '')
    }, [handleDetailTranscriptChange])

    const saveNoteRef = useRef(noteStore.saveNote)
    useEffect(() => {
        saveNoteRef.current = noteStore.saveNote
    }, [noteStore.saveNote])

    /**
     * Focusing a different gene puts the drawer back to just the gene.
     *
     * The wide notes panel is something the reader asks for, not something the
     * next gene inherits because the last one had it open. Clicking a gene or one
     * of its transcripts is a request to look at that gene, not to read notes on
     * it — so the drawer opens at its normal width and the notes stay a click
     * away, under the notes control.
     *
     * The note bubble is the one exception: clicking it *is* the request, and it
     * says so in advance through `notesOpenIntentRef`.
     *
     * Saved on the way out, blanks discarded — the same thing closing the panel
     * does. Leaving a gene is leaving its note, and a note nobody typed into is
     * not worth keeping just because the reader left by a different door.
     */
    useEffect(() => {
        for (const panel of panels) {
            const key = panel.key
            const focusedId = String(selectedGenes[key]?.id || '').trim()
            if (focusedGeneIdRef.current[key] === focusedId) continue
            focusedGeneIdRef.current[key] = focusedId

            const openId = openNoteIdByPanel[key]
            if (openId) {
                saveNoteRef.current(openId)
                setOpenNoteIdByPanel((prev) => ({ ...prev, [key]: '' }))
            }

            if (focusedId && notesOpenIntentRef.current[key] === focusedId) {
                delete notesOpenIntentRef.current[key]
                continue
            }
            delete notesOpenIntentRef.current[key]
            setNotesPanelOpenByPanel((prev) => (prev[key] ? { ...prev, [key]: false } : prev))
        }
    }, [focusedGeneSignature, panels, selectedGenes, openNoteIdByPanel])


    const isFocusDrawerOpen = useCallback(
        (panelKey) => focusDrawerOpenByPanel[panelKey] !== false,
        [focusDrawerOpenByPanel]
    )

    // Only one transcript can be pinned at a time, across every panel. Alignment
    // scrolls the page to bring a row level with its identifier, and two rows in
    // different genomes cannot both be met at once — so a second pin replaces the
    // first rather than fighting it.
    const activePinPanelKey = useMemo(() => {
        for (const entry of focusDrawerEntries) {
            if (String(focusTranscriptViews[entry.panelKey]?.pinnedId || '')) return entry.panelKey
        }
        return ''
    }, [focusDrawerEntries, focusTranscriptViews])

    // The drawer hangs off its gene's focus bar rather than the top of the view,
    // so it reads as sliding out of that panel. Measured from the DOM because
    // the offset depends on every panel's rendered height above it.
    const [focusDrawerAlignByPanel, setFocusDrawerAlignByPanel] = useState({})
    // The scroll area is padded, and a sticky header offsets from inside that
    // padding — which left the band floating below the app's top bar instead of
    // sitting under it. Measured rather than assumed, so it tracks the layout.
    const [focusDrawerStickyInset, setFocusDrawerStickyInset] = useState(0)
    // The assembly drawer hangs off the toolbar its genome pill sits in, the
    // same way the focus drawer hangs off the gene-of-focus bar.
    const [assemblyDrawerAlignByPanel, setAssemblyDrawerAlignByPanel] = useState({})
    useEffect(() => {
        const host = screenshotOverlayRootRef.current
        if (!host) return undefined
        // Measured against the panel the drawer lives in, not the view: each
        // drawer is clamped to its own genome's box so it can never reach over
        // the track above or below it.
        const measureBands = (selector) => {
            const next = {}
            for (const bar of host.querySelectorAll(selector)) {
                const panelKey = bar.getAttribute('data-focus-panel-key')
                const wrapper = bar.closest('[data-focus-panel-wrapper]')
                if (!panelKey || !wrapper) continue
                const snapped = alignBandToBar({
                    barTop: bar.getBoundingClientRect().top,
                    barHeight: bar.getBoundingClientRect().height,
                    hostTop: wrapper.getBoundingClientRect().top,
                })
                if (snapped) next[panelKey] = snapped
            }
            return next
        }
        const keepIfSame = (prev, next) => {
            const sameKeys = Object.keys(prev).length === Object.keys(next).length
                && Object.keys(next).every((key) => prev[key]
                    && prev[key].top === next[key].top
                    && prev[key].height === next[key].height)
            return sameKeys ? prev : next
        }
        const measure = () => {
            const scroller = findPanelScroller(host)
            if (scroller) {
                const padding = Math.round(parseFloat(window.getComputedStyle(scroller).paddingTop) || 0)
                setFocusDrawerStickyInset((prev) => (prev === padding ? prev : padding))
            }
            const focusBands = measureBands('[data-focus-bar="true"][data-focus-panel-key]')
            const toolbarBands = measureBands('[data-browser-toolbar="true"][data-focus-panel-key]')
            setFocusDrawerAlignByPanel((prev) => keepIfSame(prev, focusBands))
            setAssemblyDrawerAlignByPanel((prev) => keepIfSame(prev, toolbarBands))
        }
        measure()
        // Panels grow and shrink as transcripts expand, which moves the bars.
        const observer = new ResizeObserver(measure)
        observer.observe(host)
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [focusDrawerEntries, focusTranscriptViews, findPanelScroller])

    // --- Assembly drawer ------------------------------------------------------
    //
    // The genome pill in a panel's toolbar toggles a drawer carrying what the
    // registry says about that assembly — the same fields the stats view lists.
    // The pill is a toggle and nothing else: it does not change colour or state,
    // so the drawer is the only thing that says whether it is out.
    const [assemblyDrawerOpenByPanel, setAssemblyDrawerOpenByPanel] = useState({})
    const [assemblyInfoByPanel, setAssemblyInfoByPanel] = useState({})

    const handleGenomePillClick = useCallback((panelKey) => {
        setAssemblyDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: !prev[panelKey] }))
    }, [])

    const closeAssemblyDrawer = useCallback((panelKey) => {
        setAssemblyDrawerOpenByPanel((prev) => (prev[panelKey] ? { ...prev, [panelKey]: false } : prev))
    }, [])

    // Read on demand rather than up front: this is a cache read for a genome
    // that has been analysed and a first computation for one that has not, and
    // most sessions never open the drawer at all. Held per panel once fetched,
    // so re-opening is instant.
    const openAssemblyPanelKeys = useMemo(
        () => panels.map((panel) => panel.key).filter((key) => assemblyDrawerOpenByPanel[key]),
        [panels, assemblyDrawerOpenByPanel],
    )

    // Which genomes have a read in flight or already answered. A ref rather than
    // state on purpose: recording the attempt must not re-run this effect, or it
    // tears down the request it just started before the response arrives.
    const assemblyRequestsRef = useRef(new Set())

    useEffect(() => {
        for (const panelKey of openAssemblyPanelKeys) {
            if (assemblyRequestsRef.current.has(panelKey)) continue
            const panel = panels.find((item) => item.key === panelKey)
            if (!panel?.species) continue
            assemblyRequestsRef.current.add(panelKey)
            const settle = (info) => {
                // A read that came back with nothing is worth trying again the
                // next time the drawer opens rather than cached for the session:
                // the report may simply not have been downloaded yet.
                if (!hasAssemblyMetadata(info)) assemblyRequestsRef.current.delete(panelKey)
                setAssemblyInfoByPanel((prev) => ({ ...prev, [panelKey]: { info, loading: false } }))
            }
            fetch(`${API_BASE}/api/stats/summary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ genomes: [panel.species], sections: ['assembly'] }),
            })
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => settle(((data?.records || [])[0] || {}).assembly_info || {}))
                .catch(() => settle({}))
        }
    }, [openAssemblyPanelKeys, panels])

    // --- Pinned transcript alignment -----------------------------------------
    //
    // Clicking a transcript in the drawer brings its row in the browser level
    // with its identifier. The drawer and the panels sit in the same scroller,
    // so scrolling moves both together and can never close the gap between them
    // on its own: the drawer's anchor has to shift by the gap as well. Shifting
    // the anchor and scrolling by the same amount makes the drawer look like it
    // is standing still while the browser travels up or down to meet it.
    const [focusDrawerPinOffset, setFocusDrawerPinOffset] = useState(0)
    const activePinnedId = String(focusTranscriptViews[activePinPanelKey]?.pinnedId || '')
    const activePinGeometry = focusRowGeometry[activePinPanelKey] || null

    // The drawer's anchor and the scroller have to move by the same amount on
    // the same frame, or the drawer visibly drifts before settling. React holds
    // the final anchor from the outset and a transform carries the drawer back
    // to where it was, decaying to nothing — so a re-render part-way through
    // cannot undo the move, which writing `top` every frame would risk.
    const pinAnimationRef = useRef(null)

    const stopPinAnimation = useCallback(() => {
        const running = pinAnimationRef.current
        if (!running) return
        cancelAnimationFrame(running.frame)
        // Snap to where the move was heading rather than clearing the property,
        // which would drop the offset until React next renders.
        if (running.drawer) running.drawer.style.transform = running.settled || ''
        pinAnimationRef.current = null
    }, [])

    useEffect(() => stopPinAnimation, [stopPinAnimation])

    // `scrollDistance` is deliberately separate from the offset. The offset is
    // fixed by the alignment — it is the gap between the two rows — but how far
    // the page scrolls decides where the aligned pair ends up on screen. Matching
    // them keeps the drawer looking still; scrolling less slides the pair down,
    // which is how a row hiding under the sticky band is brought out from it.
    const movePinAlignment = useCallback((panel, from, to, scrollDistance = null) => {
        stopPinAnimation()
        const distance = to - from
        const travel = scrollDistance === null ? distance : scrollDistance
        if (!distance && !travel) return

        const scroller = findPanelScroller(panel)
        const drawer = panel.closest('[data-focus-panel-wrapper]')
            ?.querySelector('[data-focus-drawer-body="true"]')
        const scrollTo = (value) => {
            if (!scroller) return
            scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value))
        }
        if (!scroller || !drawer) {
            setFocusDrawerPinOffset(to)
            if (scroller) scrollTo(scroller.scrollTop + travel)
            else window.scrollBy(0, travel)
            return
        }

        // Flushed, so the settled offset and the transform that walks back to the
        // starting position land in the same paint. Left to batch, React commits
        // the offset a frame early and the list jumps the whole distance before
        // sliding back.
        //
        // The offset itself is a margin now, so the transform is free to carry
        // the animation as a correction that decays to nothing.
        const settled = ''
        flushSync(() => setFocusDrawerPinOffset(to))
        drawer.style.transform = `translateY(${-distance}px)`

        const scrollFrom = scroller.scrollTop
        const duration = Math.min(520, Math.max(220, Math.max(Math.abs(distance), Math.abs(travel)) * 1.5))
        const started = performance.now()
        const step = (now) => {
            const t = Math.min(1, (now - started) / duration)
            const eased = 1 - ((1 - t) ** 3)
            scrollTo(scrollFrom + (travel * eased))
            if (t < 1) {
                drawer.style.transform = `translateY(${-distance * (1 - eased)}px)`
                pinAnimationRef.current = { frame: requestAnimationFrame(step), drawer, settled }
                return
            }
            drawer.style.transform = settled
            pinAnimationRef.current = null
        }
        pinAnimationRef.current = { frame: requestAnimationFrame(step), drawer, settled }
    }, [findPanelScroller, stopPinAnimation])

    // Letting the pin go — or switching panel, or collapsing the drawer — undoes
    // both halves together, so the drawer again looks still while the browser
    // returns to where it was.
    //
    // Keyed on the panel rather than the transcript: moving the pin to another
    // row in the same list must NOT unwind first. Doing that scrolled the
    // browser all the way back and then most of the way forward again for what
    // is usually a small net move, which reads as an overshoot and a correction.
    // The alignment below travels straight from wherever it is to where it needs
    // to be instead.
    // With the transcript detail open the alignment is dead weight: it holds the
    // list down to meet a track the detail is covering anyway, and all the reader
    // sees is the blank strip it leaves under the header. Stand it down while the
    // detail is up, and align again the moment it closes.
    const detailOpenOnPinnedPanel = Boolean(detailTranscriptByPanel[activePinPanelKey])
    // Compact rows and flattened tracks both rearrange the track vertically, so
    // a row in the list no longer answers to a row in the browser and aligning
    // the two says nothing. The pin survives; turning either mode off aligns it
    // again.
    const alignmentSuspended = detailOpenOnPinnedPanel || compressMode || flattenMode
    const pinSignature = (activePinnedId && isFocusDrawerOpen(activePinPanelKey) && !alignmentSuspended)
        ? activePinPanelKey
        : ''
    const appliedPinSignatureRef = useRef('')
    const pinOffsetRef = useRef(0)
    pinOffsetRef.current = focusDrawerPinOffset
    useEffect(() => {
        if (pinSignature === appliedPinSignatureRef.current) return
        appliedPinSignatureRef.current = pinSignature
        const offset = pinOffsetRef.current
        if (!offset) return
        const panel = screenshotOverlayRootRef.current?.querySelector('[data-browser-canvas-surface="true"]')
        // Opening the detail does its own scrolling — to the top of that panel —
        // so the unwind gives up the list offset without also moving the page,
        // which would drag the view back off the detail it just framed.
        if (panel) movePinAlignment(panel, offset, 0, detailOpenOnPinnedPanel ? 0 : null)
        else setFocusDrawerPinOffset(0)
    }, [pinSignature, detailOpenOnPinnedPanel, movePinAlignment])

    const focusDrawerAlignTopRef = useRef(0)
    focusDrawerAlignTopRef.current = focusDrawerAlignByPanel[activePinPanelKey]?.top || 0

    useEffect(() => {
        if (!activePinnedId || !isFocusDrawerOpen(activePinPanelKey)) return undefined
        if (alignmentSuspended) return undefined
        if (!activePinGeometry || activePinGeometry.transcriptId !== activePinnedId) return undefined
        // A gene still drawn as a block reports its block, not a row. Aligning to
        // that would haul the drawer to a position the re-framing is about to
        // invalidate, so wait until the panel is back at transcript zoom.
        if (!activePinGeometry.resolved) return undefined

        // Re-framing the gene animates the layout for the best part of a second,
        // reshaping the row geometry on every frame. Settling first means one
        // scroll at the end rather than a scroll per frame.
        let timer = null
        const attempt = () => {
            // Releasing the previous pin animates the drawer back to its anchor.
            // Measuring while that is still running reads a position the row is
            // about to leave, which is what left every pin after the first a few
            // pixels out.
            if (pinAnimationRef.current) {
                timer = setTimeout(attempt, 60)
                return
            }
            const host = screenshotOverlayRootRef.current
            const row = host?.querySelector(`[data-drawer-transcript-row="${CSS.escape(activePinnedId)}"]`)
            const panel = host?.querySelector(
                `[data-browser-canvas-surface="true"][data-focus-panel-key="${CSS.escape(activePinPanelKey)}"]`
            )
            if (!row || !panel) return

            const rowRect = row.getBoundingClientRect()
            const rowCentre = rowRect.top + (rowRect.height / 2)
            const transcriptCentre = panel.getBoundingClientRect().top
                + activePinGeometry.offsetTop
                + (activePinGeometry.height / 2)

            const residual = Math.round(transcriptCentre - rowCentre)
            if (Math.abs(residual) < 1) return
            // The drawer cannot be anchored above the top of the panels, and the
            // offset has to record what was actually applied — otherwise a clamped
            // shift keeps asking for more and never settles.
            const previous = pinOffsetRef.current
            const applied = Math.max(previous + residual, -focusDrawerAlignTopRef.current)

            // A row sitting under the sticky band would stay under it: matching
            // the scroll to the offset keeps the drawer visually still, obscured
            // row and all. Scrolling that much less instead slides the aligned
            // pair down until the row clears the band's bottom edge.
            const band = host?.querySelector(
                `[data-focus-panel-wrapper="${CSS.escape(activePinPanelKey)}"] [data-focus-drawer-band="true"]`
            )
            const bandBottom = band ? band.getBoundingClientRect().bottom : 0
            const obscured = Math.max(0, Math.round(bandBottom - rowRect.top))

            if (applied === previous && !obscured) return
            movePinAlignment(panel, previous, applied, (applied - previous) - obscured)
        }
        timer = setTimeout(attempt, 80)
        return () => { if (timer) clearTimeout(timer) }
    }, [activePinnedId, activePinGeometry, activePinPanelKey, isFocusDrawerOpen, alignmentSuspended, movePinAlignment])

    // How much of a panel's right edge the drawer covers, so gene framing can
    // aim for the middle of what stays visible. A panel that does not hold the
    // focus still frames for the open width, because clicking a gene there both
    // moves the drawer to it and opens it.
    const focusDrawerInsetFor = useCallback((panelKey) => {
        if (!focusDrawerEntries.some((entry) => entry.panelKey === panelKey)) return 0
        // Deliberately blind to the transcript detail. Someone reading metadata
        // is not reading the track, and re-framing the gene every time that
        // panel opens or closes would shuffle the browser under them for nothing.
        return isFocusDrawerOpen(panelKey) ? FOCUS_DRAWER_WIDTH : FOCUS_DRAWER_RAIL_WIDTH
    }, [focusDrawerEntries, isFocusDrawerOpen])

    const anyFocusedGene = useMemo(() => {
        if (anyGeneSelected) return true
        for (const gene of Object.values(externalFocusGenesByGenome || {})) {
            if (gene?.id || gene?.name) return true
        }
        return false
    }, [anyGeneSelected, externalFocusGenesByGenome])
    const browserActionButtonStyle = useCallback((enabled, active = false, options = {}) => {
        const working = Boolean(options.working)
        const disabledBg = isLight ? '#ffffff' : '#1E2938'
        const disabledText = isLight ? '#c0c0c0' : '#4b4b4b'
        const disabledBorder = isLight ? '#d1d5db' : '#4b5563'
        const inactiveBg = isLight ? '#ffffff' : '#1E2938'
        const inactiveText = isLight ? '#4b5563' : '#9ca3af'
        const inactiveBorder = isLight ? '#d1d5db' : '#4b5563'
        const activeBg = isLight ? '#0099ff' : '#0077cc'
        const showEmphasis = enabled && active
        return {
            backgroundColor: enabled
                ? (showEmphasis ? activeBg : inactiveBg)
                : disabledBg,
            color: enabled
                ? (showEmphasis ? '#ffffff' : inactiveText)
                : disabledText,
            border: `1px solid ${enabled ? (showEmphasis ? 'transparent' : inactiveBorder) : disabledBorder}`,
            cursor: enabled ? 'pointer' : 'default',
            opacity: working ? 0.6 : 1,
        }
    }, [isLight])

    const fallbackBrowseRoot = config?.output_dir ? `${config.output_dir.replace(/\/+$/, '')}/local_data` : (config?.working_dir || '.')
    const activePanelKeySet = useMemo(() => new Set(panels.map((panel) => panel.key)), [panels])

    const lastAlignmentLocus = useRef(null)
    useEffect(() => {
        if (!isActive || !externalAlignmentLocus || lastAlignmentLocus.current === externalAlignmentLocus.token) return
        const requested = Array.isArray(externalAlignmentLocus.loci) && externalAlignmentLocus.loci.length
            ? externalAlignmentLocus.loci
            : [externalAlignmentLocus]
        const positioned = requested.map((locus) => ({ locus, panel: panels.find((panel) => panel.key === locus.genomeKey) }))
        // Configuration and panel creation are asynchronous. Wait until every
        // selected genome has its panel before consuming the handoff token, or
        // an early existing panel would navigate while a newly activated one
        // permanently missed its locus.
        if (positioned.some(({ panel }) => !panel)) return
        lastAlignmentLocus.current = externalAlignmentLocus.token
        setNavigateGenes((prev) => {
            const next = { ...prev }
            for (const { locus, panel } of positioned) {
                const chrom = locus.chrom || locus.region
                const { start, end, strand } = locus
                next[panel.key] = { chrom, start, end, strand, windowStart: start, windowEnd: end, centerVertically: false }
            }
            return next
        })
    }, [externalAlignmentLocus, isActive, panels])

    const firstPanel = panels[0] || null
    const secondPanel = panels[1] || null

    useEffect(() => {
        setLinkedPanelKeys((prev) => prev.filter((key) => activePanelKeySet.has(key)))
        setSelectedGenes((prev) => {
            const next = {}
            for (const key of Object.keys(prev || {})) {
                if (activePanelKeySet.has(key)) next[key] = prev[key]
            }
            return next
        })
        setNavigateGenes((prev) => {
            const next = {}
            for (const key of Object.keys(prev || {})) {
                if (activePanelKeySet.has(key)) next[key] = prev[key]
            }
            return next
        })
        setPanelPositions((prev) => {
            const next = {}
            for (const key of Object.keys(prev || {})) {
                if (activePanelKeySet.has(key)) next[key] = prev[key]
            }
            return next
        })
        panelActualPositionsRef.current = Object.fromEntries(
            Object.entries(panelActualPositionsRef.current || {}).filter(([key]) => activePanelKeySet.has(key))
        )
        const currentLinkModel = linkModelRef.current
        if (currentLinkModel?.deltas) {
            const nextDeltas = Object.fromEntries(
                Object.entries(currentLinkModel.deltas).filter(([key]) => activePanelKeySet.has(key))
            )
            const nextKeys = Object.keys(nextDeltas)
            if (nextKeys.length >= 2) {
                linkModelRef.current = {
                    ...currentLinkModel,
                    anchorKey: activePanelKeySet.has(currentLinkModel.anchorKey) ? currentLinkModel.anchorKey : nextKeys[0],
                    deltas: nextDeltas,
                }
            } else {
                linkModelRef.current = null
            }
        } else if (currentLinkModel?.type === 'region' && currentLinkModel?.chroms) {
            const nextChroms = Object.fromEntries(
                Object.entries(currentLinkModel.chroms).filter(([key]) => activePanelKeySet.has(key))
            )
            const nextKeys = Object.keys(nextChroms)
            if (nextKeys.length >= 2) {
                linkModelRef.current = {
                    ...currentLinkModel,
                    anchorKey: activePanelKeySet.has(currentLinkModel.anchorKey) ? currentLinkModel.anchorKey : nextKeys[0],
                    chroms: nextChroms,
                }
            } else {
                linkModelRef.current = null
            }
        }
    }, [activePanelKeySet])

    useEffect(() => {
        if (!hasPanels) {
            onScreenshotModeChange?.(false)
            setSelectedScreenshotTarget(null)
        }
    }, [hasPanels, onScreenshotModeChange])

    useEffect(() => {
        onScreenshotAvailabilityChange?.('genome_browser', hasPanels)
        return () => onScreenshotAvailabilityChange?.('genome_browser', false)
    }, [hasPanels, onScreenshotAvailabilityChange])

    useEffect(() => {
        if (!(screenshotMode && hasPanels)) return undefined
        const previousBodyCursor = document.body.style.cursor
        const previousRootCursor = document.documentElement.style.cursor
        document.body.style.cursor = 'crosshair'
        document.documentElement.style.cursor = 'crosshair'
        return () => {
            document.body.style.cursor = previousBodyCursor
            document.documentElement.style.cursor = previousRootCursor
        }
    }, [hasPanels, screenshotMode])

    const defaultScreenshotDir = useMemo(() => {
        const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        return base ? `${base}/screenshots` : ''
    }, [config?.output_dir])

    const getScreenshotTargetAtPoint = useCallback((clientX, clientY) => {
        let bestTarget = null
        let bestArea = Number.POSITIVE_INFINITY
        for (const target of Array.isArray(screenshotTargets) ? screenshotTargets : []) {
            if (typeof target?.getVisibleRect !== 'function') continue
            const rect = target.getVisibleRect()
            if (!rect) continue
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
            const area = Math.max(1, rect.width * rect.height)
            if (area < bestArea) {
                bestArea = area
                bestTarget = target
            }
        }
        return bestTarget
    }, [screenshotTargets])

    useEffect(() => {
        if (!(screenshotMode && hasPanels)) return undefined

        const handlePointerDown = (event) => {
            if (event.target?.closest?.('[data-screenshot-selection-overlay="true"]')) return
            const screenshotButton = screenshotToggleButtonRef?.current
            if (screenshotButton && screenshotButton.contains(event.target)) return
            if (getScreenshotTargetAtPoint(event.clientX, event.clientY)) return
            onScreenshotModeChange?.(false)
            setSelectedScreenshotTarget(null)
        }

        window.addEventListener('pointerdown', handlePointerDown, true)
        return () => window.removeEventListener('pointerdown', handlePointerDown, true)
    }, [getScreenshotTargetAtPoint, hasPanels, onScreenshotModeChange, screenshotMode, screenshotToggleButtonRef])

    // Panels register themselves here so a wheel gesture that lands between them
    // can still be routed to one. Held in a ref, not state: it changes on mount
    // and unmount only, and must never trigger a re-render mid-gesture.
    const browsingTargetsRef = useRef({})
    const handleBrowsingTargetChange = useCallback((panelKey, descriptor) => {
        if (!panelKey) return
        if (!descriptor) {
            delete browsingTargetsRef.current[panelKey]
            return
        }
        browsingTargetsRef.current[panelKey] = descriptor
    }, [])

    const handleScreenshotTargetChange = useCallback((panelKey, descriptor) => {
        if (!panelKey) return
        if (!descriptor) {
            removeScreenshotTarget(panelKey)
            return
        }
        const nextTarget = {
            ...descriptor,
            id: panelKey,
        }
        upsertScreenshotTarget(nextTarget)
        setSelectedScreenshotTarget((prev) => (prev?.id === panelKey ? nextTarget : prev))
    }, [removeScreenshotTarget, upsertScreenshotTarget])

    const handleScreenshotSave = useCallback(async ({ filename, directory, format, scale, quality, target }) => {
        if (!target?.buildExportSnapshot) {
            return { ok: false, error: 'Screenshot target is no longer available.' }
        }

        try {
            const snapshot = await target.buildExportSnapshot()
            if (!snapshot?.svgMarkup) {
                return { ok: false, error: 'Failed to build screenshot export.' }
            }

            let payload
            if (format === 'svg') {
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: 'image/svg+xml',
                    encoding: 'utf8',
                    data: snapshot.svgMarkup,
                }
            } else {
                const raster = await rasterizeSvgMarkup({
                    svgMarkup: snapshot.svgMarkup,
                    width: snapshot.width,
                    height: snapshot.height,
                    format,
                    scale,
                    quality: format === 'jpeg' ? Math.max(0.7, Math.min(1, quality / 100)) : undefined,
                    backgroundColor: snapshot.backgroundColor || (isLight ? '#f8fafc' : '#111827'),
                })
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: raster.mimeType,
                    encoding: 'base64',
                    data: raster.base64,
                }
            }

            const response = await fetch(`${API_BASE}/api/exports/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) {
                return { ok: false, error: data?.detail || 'Failed to save screenshot.' }
            }
            return { ok: true, path: data?.path || '' }
        } catch (error) {
            return { ok: false, error: error?.message || 'Failed to export screenshot.' }
        }
    }, [isLight])

    const handleScreenshotModalClose = useCallback(() => {
        setSelectedScreenshotTarget(null)
    }, [])

    const clearPendingLinkApply = useCallback(() => {
        if (linkApplyTimerRef.current) {
            window.clearTimeout(linkApplyTimerRef.current)
            linkApplyTimerRef.current = null
        }
        syncSourcePanelKeyRef.current = ''
    }, [])

    useEffect(() => {
        return () => {
            clearPendingLinkApply()
        }
    }, [clearPendingLinkApply])

    const updateGlobalTracksState = useCallback(() => {
        const allTracks = []
        for (const panel of panels) {
            const state = tracksStateRef.current[panel.key]
            if (!state) continue
            allTracks.push(Boolean(state.forward), Boolean(state.reverse))
            if (state.sequence !== undefined) allTracks.push(Boolean(state.sequence))
        }
        if (allTracks.length === 0) return

        const allHidden = allTracks.every((isHidden) => isHidden === true)
        const allVisible = allTracks.every((isHidden) => isHidden === false)
        if (allHidden) {
            setGlobalTracksState('off')
        } else if (allVisible) {
            setGlobalTracksState('on')
        } else {
            setGlobalTracksState('mixed')
        }
    }, [panels])

    useEffect(() => {
        updateGlobalTracksState()
    }, [updateGlobalTracksState, panels.length])

    const handlePanelTrackVisibilityChange = useCallback((panelKey, hiddenStrands) => {
        tracksStateRef.current[panelKey] = hiddenStrands
        if (forceTracksVisibility !== undefined) setForceTracksVisibility(undefined)
        updateGlobalTracksState()
    }, [forceTracksVisibility, updateGlobalTracksState])

    const handleGlobalTracksToggle = useCallback(() => {
        if (globalTracksState === 'on' || globalTracksState === 'mixed') {
            setForceTracksVisibility('off')
            setGlobalTracksState('off')
        } else {
            setForceTracksVisibility('on')
            setGlobalTracksState('on')
        }
    }, [globalTracksState])

    useEffect(() => {
        browserReadyStateRef.current = browserReadyState
    }, [browserReadyState])

    useEffect(() => {
        setBrowserReadyState((prev) => {
            const next = {}
            for (const panel of panels) {
                next[panel.key] = prev?.[panel.key] || { state: 'idle', detail: '' }
            }
            return next
        })
    }, [panels])

    // One check per panel at a time. Two poll loops used to race here with no
    // guard between them, so a genome could have several readiness requests open
    // at once — every one of them re-reading the configuration on the backend.
    const readyCheckInFlightRef = useRef(new Map())
    const readyCheckAttemptsRef = useRef(new Map())

    const checkGenomeReady = useCallback((panel) => {
        const panelKey = panel.key
        const inFlight = readyCheckInFlightRef.current.get(panelKey)
        if (inFlight) return inFlight

        const updateState = (state, detail = '') => {
            setBrowserReadyState((prev) => {
                const current = prev?.[panelKey]
                if (current?.state === 'ready' && (state === 'checking' || state === 'pending')) {
                    return prev
                }
                if (current?.state === state && (current?.detail || '') === (detail || '')) {
                    // Nothing moved. Returning prev keeps a poll that is waiting
                    // out a long build from re-rendering every panel each time.
                    return prev
                }
                return {
                    ...prev,
                    [panelKey]: { state, detail },
                }
            })
        }

        // Counts consecutive "no such genome" answers only, not polls in
        // general: a genome that has just been added answers 404 until its files
        // land in the configuration, and that is the wait this budget is for.
        // Counting every poll would spend the budget waiting out a long index
        // build and then call the next blip fatal.
        const attemptKey = `${panelKey}|${panel.genomeParam}`
        const attempt = readyCheckAttemptsRef.current.get(attemptKey) || 0

        const run = (async () => {
            updateState('checking')
            let status = 0
            let ok = false
            let regionCount = 0
            let detail = ''
            try {
                const res = await fetch(`${API_BASE}/api/browse/regions?genome=${encodeURIComponent(panel.genomeParam)}`)
                status = res.status
                ok = res.ok
                if (ok) {
                    const data = await res.json()
                    regionCount = Array.isArray(data) ? data.length : 0
                } else {
                    try {
                        detail = (await res.json())?.detail || ''
                    } catch {
                        detail = ''
                    }
                }
            } catch {
                status = 0  // No response at all; treated as "try again".
            }

            if (status === 404) {
                readyCheckAttemptsRef.current.set(attemptKey, attempt + 1)
            } else {
                readyCheckAttemptsRef.current.delete(attemptKey)
            }

            const outcome = classifyReadiness({ ok, status, regionCount, attempt })
            updateState(outcome, outcome === 'ready' ? '' : detail)
            return outcome
        })()

        readyCheckInFlightRef.current.set(panelKey, run)
        run.finally(() => {
            if (readyCheckInFlightRef.current.get(panelKey) === run) {
                readyCheckInFlightRef.current.delete(panelKey)
            }
        })
        return run
    }, [])

    // Discard a failed index build and start another. Without this a build that
    // failed once holds the genome until the backend is restarted.
    const retryGenomeIndex = useCallback(async (panel) => {
        readyCheckAttemptsRef.current.delete(`${panel.key}|${panel.genomeParam}`)
        try {
            await fetch(`${API_BASE}/api/browse/index-retry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ genome: panel.genomeParam }),
            })
        } catch (error) {
            console.error('Failed to restart the index build:', error)
        }
        regionCacheRef.current.delete(String(panel.genomeParam || panel.key || '').trim())
        setBrowserReadyState((prev) => ({ ...prev, [panel.key]: { state: 'checking', detail: '' } }))
        checkGenomeReady(panel)
    }, [checkGenomeReady])

    const fetchRegionsForPanel = useCallback(async (panel) => {
        const cacheKey = String(panel?.genomeParam || panel?.key || '').trim()
        if (!cacheKey) return []
        if (regionCacheRef.current.has(cacheKey)) return regionCacheRef.current.get(cacheKey) || []
        const res = await fetch(`${API_BASE}/api/browse/regions?genome=${encodeURIComponent(panel.genomeParam)}`)
        if (!res.ok) return []
        const data = await res.json()
        const regions = Array.isArray(data) ? data : []
        regionCacheRef.current.set(cacheKey, regions)
        return regions
    }, [])

    const panelSignature = useMemo(() => {
        return panels.map((panel) => `${panel.key}:${panel.genomeParam}`).join('|')
    }, [panels])
    const canPrepareBrowser = isActive || allowBackgroundPrep

    useEffect(() => {
        regionCacheRef.current.clear()
    }, [panelSignature, refReloadKey, tgtReloadKey])

    useEffect(() => {
        if (!canPrepareBrowser) return undefined
        if (!hasPanels) return undefined
        let cancelled = false
        const timers = []
        const prevReload = previousReloadRef.current || { ref: 0, tgt: 0 }
        const refReloadChanged = refReloadKey !== prevReload.ref
        const tgtReloadChanged = tgtReloadKey !== prevReload.tgt
        previousReloadRef.current = { ref: refReloadKey, tgt: tgtReloadKey }
        const previousParams = previousPanelParamRef.current || {}
        const nextParams = {}

        // One chain per panel, and only one. What used to run alongside this was
        // a second interval that re-checked anything still pending; between them
        // a panel could have two requests open and a third queued behind it.
        const pollPanel = async (panel, round = 0) => {
            const status = await checkGenomeReady(panel)
            if (cancelled || status === 'ready' || status === 'error') return
            const timer = window.setTimeout(() => {
                pollPanel(panel, round + 1)
            }, readinessRetryDelay(round))
            timers.push(timer)
        }

        for (const panel of panels) {
            const key = panel.key
            nextParams[key] = panel.genomeParam
            const prevParam = previousParams[key]
            const state = browserReadyStateRef.current?.[key]?.state || ''
            const isNewPanel = !prevParam
            const paramChanged = !!prevParam && prevParam !== panel.genomeParam
            const forceReloadCheck = (panel.alignmentRole === 'reference' && refReloadChanged) || (panel.alignmentRole === 'target' && tgtReloadChanged)
            const needsRetry = state === 'pending' || state === 'error' || state === 'checking'
            // Recreating a tutorial workspace can clear readiness while reusing the
            // same genome key. A remembered parameter is not proof it is still ready.
            const shouldCheck = !state || isNewPanel || paramChanged || forceReloadCheck || needsRetry
            if (shouldCheck) {
                pollPanel(panel)
            }
        }
        previousPanelParamRef.current = nextParams

        return () => {
            cancelled = true
            for (const timer of timers) {
                window.clearTimeout(timer)
            }
        }
    }, [canPrepareBrowser, hasPanels, panels, panelSignature, refReloadKey, tgtReloadKey, checkGenomeReady])

    // Safety net for a panel whose chain was cancelled mid-flight — the effect
    // above tears its timers down whenever `panels` changes identity, and a
    // panel that was between polls at that moment would otherwise stop. Slow on
    // purpose: the chain above is the mechanism, this only notices a stall.
    // `checkGenomeReady` refuses to run twice for the same panel at once, so
    // this can never double up on a poll that is already in flight.
    useEffect(() => {
        if (!canPrepareBrowser) return undefined
        if (!hasPanels) return undefined
        const id = setInterval(() => {
            for (const panel of panels) {
                const state = browserReadyStateRef.current?.[panel.key]?.state
                if (state === 'pending') {
                    checkGenomeReady(panel)
                }
            }
        }, 15000)
        return () => clearInterval(id)
    }, [canPrepareBrowser, hasPanels, panels, checkGenomeReady])

    useEffect(() => {
        if (!isActive) return
        if (!onRefGeneSelect) return
        onRefGeneSelect(firstPanel ? (selectedGenes[firstPanel.key] || null) : null)
    }, [isActive, selectedGenes, firstPanel, onRefGeneSelect])

    useEffect(() => {
        if (!isActive) return
        if (!onTgtGeneSelect) return
        onTgtGeneSelect(secondPanel ? (selectedGenes[secondPanel.key] || null) : null)
    }, [isActive, selectedGenes, secondPanel, onTgtGeneSelect])

    useEffect(() => {
        if (!isActive) return
        if (!onGeneFocusByGenomeChange) return
        const next = {}
        for (const panel of panels) {
            const key = panel.key
            const gene = selectedGenes[key]
            if (gene && gene.id) {
                next[key] = gene
            }
        }
        onGeneFocusByGenomeChange(next)
    }, [isActive, selectedGenes, panels, onGeneFocusByGenomeChange])

    const externalFocusMap = useMemo(() => {
        const next = { ...(externalFocusGenesByGenome || {}) }
        if (firstPanel?.key && externalRefGene) next[firstPanel.key] = externalRefGene
        if (secondPanel?.key && externalTgtGene) next[secondPanel.key] = externalTgtGene
        return next
    }, [externalFocusGenesByGenome, firstPanel, externalRefGene, secondPanel, externalTgtGene])

    useEffect(() => {
        if (isActive) return
        if (!panels.length) return
        const nextNavigate = {}
        for (const panel of panels) {
            const externalGene = externalFocusMap?.[panel.key]
            if (!externalGene?.id) continue
            if (!hasFiniteGeneCoords(externalGene)) continue
            if (selectedGenes[panel.key]?.id === externalGene.id) continue
            nextNavigate[panel.key] = {
                id: externalGene.id,
                name: externalGene.name,
                chrom: externalGene.chrom,
                start: externalGene.start,
                end: externalGene.end,
                strand: externalGene.strand,
                centerVertically: true,
            }
        }
        if (!Object.keys(nextNavigate).length) return
        setNavigateGenes((prev) => ({ ...prev, ...nextNavigate }))
    }, [isActive, panels, externalFocusMap, selectedGenes])

    const applyLinkedGeneView = useCallback((genesByPanelKey, options = {}) => {
        const validPanels = panels.filter((panel) => hasFiniteGeneCoords(genesByPanelKey?.[panel.key]))
        if (validPanels.length < 2) return false

        const validKeys = validPanels.map((panel) => panel.key)
        const requestedAnchorKey = String(options.anchorKey || '').trim()
        const anchorKey = validKeys.includes(requestedAnchorKey) ? requestedAnchorKey : validKeys[0]
        const anchorGene = genesByPanelKey[anchorKey]

        const anchorFivePrime = geneFivePrime(anchorGene)
        if (!Number.isFinite(anchorFivePrime)) return false
        const { ratio: fivePrimeRatio, span } = linkedGeneFraming(validPanels.map((panel) => ({
            gene: genesByPanelKey[panel.key],
            bounds: describeBrowserViewport(panel.key)?.bounds,
            frameRange: browserViewportControls(panel.key)?.frameFocusedRange,
        })), anchorGene?.strand)

        const deltas = {}
        const nextNavigate = {}
        const nextPositions = {}
        for (const panel of validPanels) {
            const gene = genesByPanelKey[panel.key]
            const fivePrime = geneFivePrime(gene)
            if (!Number.isFinite(fivePrime)) continue
            const windowStart = fivePrime - (fivePrimeRatio * span)
            const windowEnd = windowStart + span
            deltas[panel.key] = {
                delta: fivePrime - anchorFivePrime,
                chrom: gene.chrom,
            }
            nextNavigate[panel.key] = {
                ...gene,
                windowStart,
                windowEnd,
                centerVertically: true,
            }
            nextPositions[panel.key] = {
                chrom: gene.chrom,
                // Navigation already accounts for the drawer. The linked position
                // must use the same framing or enabling Pan/Zoom undoes that work.
                ...(browserViewportControls(panel.key)?.frameFocusedRange?.(windowStart, windowEnd)
                    || { start: windowStart, end: windowEnd }),
            }
        }

        if (Object.keys(deltas).length < 2) return false

        if (lockPanRef.current) setLockPan(false)
        if (lockZoomRef.current) setLockZoom(false)
        clearPendingLinkApply()

        setPanelPositions((prev) => {
            const next = { ...prev }
            for (const key of validKeys) {
                delete next[key]
            }
            return next
        })
        setNavigateGenes((prev) => ({ ...prev, ...nextNavigate }))
        setLinkedPanelKeys(validKeys)
        linkModelRef.current = {
            type: 'gene',
            anchorKey,
            deltas,
        }

        linkApplyTimerRef.current = window.setTimeout(() => {
            linkApplyTimerRef.current = null
            setPanelPositions((prev) => ({ ...prev, ...nextPositions }))
            setLockPan(true)
            setLockZoom(true)
        }, 260)
        return true
    }, [panels, clearPendingLinkApply])

    useEffect(() => {
        const becameActive = isActive && !wasActiveRef.current
        wasActiveRef.current = isActive
        if (!becameActive) return
        if (!firstPanel || !secondPanel) return
        if (!externalRefGene?.id || !externalTgtGene?.id) return
        if (!hasFiniteGeneCoords(externalRefGene) || !hasFiniteGeneCoords(externalTgtGene)) return

        setSelectedGenes((prev) => ({
            ...prev,
            [firstPanel.key]: externalRefGene,
            [secondPanel.key]: externalTgtGene,
        }))
        applyLinkedGeneView({
            [firstPanel.key]: externalRefGene,
            [secondPanel.key]: externalTgtGene,
        }, { anchorKey: firstPanel.key })
    }, [isActive, firstPanel, secondPanel, externalRefGene, externalTgtGene, applyLinkedGeneView])

    useEffect(() => {
        if (refReloadKey <= 0) return
        clearPendingLinkApply()
    }, [refReloadKey, clearPendingLinkApply])

    useEffect(() => {
        if (tgtReloadKey <= 0) return
        clearPendingLinkApply()
    }, [tgtReloadKey, clearPendingLinkApply])

    const handleManualBrowserNavigate = useCallback(() => {
        clearPendingLinkApply()
    }, [clearPendingLinkApply])

    const flushPanelPositionChange = useCallback((panelKey, chrom, start, end, targetTrack, anchorRatio = null) => {
        if (firstPanel && panelKey === firstPanel.key && onRefViewportChange) {
            onRefViewportChange({ chrom, start, end, targetTrack: targetTrack || null })
        }
        // Keep the ref up-to-date with the source panel's actual position.
        panelActualPositionsRef.current[panelKey] = { chrom, start, end }
        syncSourcePanelKeyRef.current = panelKey
        if (!(lockPanRef.current || lockZoomRef.current || isOverlayActive)) return

        let recipients = []
        if (linkedSet.size >= 2) {
            recipients = panels
                .map((panel) => panel.key)
                .filter((key) => key !== panelKey && linkedSet.has(key))
        } else if (panels.length >= 2) {
            recipients = panels
                .map((panel) => panel.key)
                .filter((key) => key !== panelKey)
        }
        if (recipients.length === 0) return

        const model = linkModelRef.current
        const sourceDelta = model?.deltas?.[panelKey]?.delta
        const canApplyOffsets = Number.isFinite(sourceDelta) && recipients.every((key) => Number.isFinite(model?.deltas?.[key]?.delta))
        const canApplyRegionChroms = model?.type === 'region' && recipients.every((key) => String(model?.chroms?.[key] || '').trim())
        const isZoom = Number.isFinite(anchorRatio)
        const newSpan = Number(end) - Number(start)

        setPanelPositions((prev) => {
            const next = { ...prev }
            let changed = false
            const getRecipientChrom = (key) => (
                panelActualPositionsRef.current[key]?.chrom
                || prev[key]?.chrom
                || chrom
            )
            if (canApplyOffsets) {
                // Gene-link delta model: offset each recipient by its genomic delta.
                // Include anchorRatio so lockZoom applies the position directly instead
                // of falling back to the keep-own-center logic.
                const anchorStart = Number(start) - Number(sourceDelta)
                const anchorEnd = Number(end) - Number(sourceDelta)
                for (const key of recipients) {
                    const info = model.deltas[key]
                    const delta = Number(info.delta)
                    const nextPosition = {
                        chrom: info.chrom || chrom,
                        start: anchorStart + delta,
                        end: anchorEnd + delta,
                        targetTrack,
                        anchorRatio: isZoom ? anchorRatio : undefined,
                    }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            } else if (canApplyRegionChroms) {
                for (const key of recipients) {
                    const nextPosition = {
                        chrom: model.chroms[key] || chrom,
                        start,
                        end,
                        targetTrack,
                        anchorRatio: isZoom ? anchorRatio : undefined,
                    }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            } else if (isZoom && lockZoomRef.current && !lockPanRef.current) {
                // lockZoom zoom event without a delta model: apply the same screen-ratio
                // anchor to each recipient so they zoom in place at the same visual column.
                // Use panelActualPositionsRef so we always have the real current position,
                // not the stale panelPositions state value (which gets overwritten by pan
                // broadcasts and would otherwise cause a jump on the next zoom event).
                for (const key of recipients) {
                    const actualPos = panelActualPositionsRef.current[key]
                    const prevPos = actualPos || prev[key]
                    if (prevPos && Number.isFinite(prevPos.start) && Number.isFinite(prevPos.end)) {
                        const prevSpan = Number(prevPos.end) - Number(prevPos.start)
                        const anchor = Number(prevPos.start) + anchorRatio * prevSpan
                        const nextStart = anchor - anchorRatio * newSpan
                        const nextEnd = anchor + (1 - anchorRatio) * newSpan
                        // Update the ref so subsequent events also use the right position.
                        panelActualPositionsRef.current[key] = { chrom: prevPos.chrom || getRecipientChrom(key), start: nextStart, end: nextEnd }
                        const nextPosition = {
                            chrom: prevPos.chrom || getRecipientChrom(key),
                            start: nextStart,
                            end: nextEnd,
                            targetTrack,
                            anchorRatio,
                        }
                        if (!samePanelPosition(prev[key], nextPosition)) {
                            next[key] = nextPosition
                            changed = true
                        }
                    } else {
                        const nextPosition = { chrom: getRecipientChrom(key), start, end, targetTrack, anchorRatio }
                        if (!samePanelPosition(prev[key], nextPosition)) {
                            next[key] = nextPosition
                            changed = true
                        }
                    }
                }
            } else {
                for (const key of recipients) {
                    const nextPosition = { chrom: getRecipientChrom(key), start, end, targetTrack }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            }
            return changed ? next : prev
        })
    }, [firstPanel, onRefViewportChange, isOverlayActive, linkedSet, panels])

    // Broadcast to the linked panels synchronously. The source panel already
    // coalesces its own pan/zoom to one update per animation frame, so deferring
    // again here bought nothing and cost a frame: the dragged genome committed in
    // frame N while every panel linked to it committed in frame N+1, which is
    // exactly the "tracks drift out of step" wobble during a drag. Updating in the
    // same tick lets React batch source and recipients into one render and paint.
    const handlePanelPositionChange = useCallback((panelKey, chrom, start, end, targetTrack, anchorRatio = null) => {
        flushPanelPositionChange(panelKey, chrom, start, end, targetTrack, anchorRatio)
    }, [flushPanelPositionChange])

    const handleLinkRegion = useCallback(async () => {
        if (panelCount < 2 || !firstPanel || linkingRegion) return
        const primaryPosition = panelActualPositionsRef.current[firstPanel.key]
        if (
            !primaryPosition?.chrom ||
            !Number.isFinite(Number(primaryPosition.start)) ||
            !Number.isFinite(Number(primaryPosition.end)) ||
            Number(primaryPosition.end) <= Number(primaryPosition.start)
        ) {
            return
        }

        const requestEpoch = tutorialEpochRef.current
        setLinkingRegion(true)
        try {
            const primaryRegions = await fetchRegionsForPanel(firstPanel)
            const primaryRegion = resolveRegionByChromTokens(primaryRegions, primaryPosition.chrom)
            const sourceTokens = chromosomeTokensForRegion(primaryRegion, primaryPosition.chrom)
            if (!sourceTokens.size) return

            const linkedKeys = [firstPanel.key]
            const chroms = { [firstPanel.key]: String(primaryPosition.chrom) }
            const nextPositions = {}

            for (const panel of panels) {
                if (panel.key === firstPanel.key) continue
                const regions = await fetchRegionsForPanel(panel)
                const region = resolveRegionByChromTokens(regions, sourceTokens)
                if (!region?.chrom) continue
                const window = clampWindowToRegion(
                    String(region.chrom),
                    Number(primaryPosition.start),
                    Number(primaryPosition.end),
                    region,
                )
                if (!window) continue
                linkedKeys.push(panel.key)
                chroms[panel.key] = window.chrom
                nextPositions[panel.key] = window
                panelActualPositionsRef.current[panel.key] = window
            }

            if (requestEpoch !== tutorialEpochRef.current || linkedKeys.length < 2) return

            if (lockPanRef.current) setLockPan(false)
            if (lockZoomRef.current) setLockZoom(false)
            clearPendingLinkApply()
            linkModelRef.current = {
                type: 'region',
                anchorKey: firstPanel.key,
                chroms,
            }
            syncSourcePanelKeyRef.current = firstPanel.key
            setLinkedPanelKeys(linkedKeys)
            setPanelPositions((prev) => ({ ...prev, ...nextPositions }))
            setLockPan(true)
            setLockZoom(true)
        } catch (error) {
            console.error('Failed to link region:', error)
        } finally {
            setLinkingRegion(false)
        }
    }, [clearPendingLinkApply, fetchRegionsForPanel, firstPanel, linkingRegion, panelCount, panels])

    const handleLinkGene = useCallback(async () => {
        if (!hasPanels) return
        const selectedByPanel = {}
        for (const panel of panels) {
            const gene = hasFiniteGeneCoords(selectedGenes[panel.key])
                ? selectedGenes[panel.key]
                : externalFocusMap?.[panel.key]
            if (hasFiniteGeneCoords(gene)) {
                selectedByPanel[panel.key] = gene
            }
        }
        const selectedKeys = Object.keys(selectedByPanel)
        if (selectedKeys.length === 0) return

        const anchorKey = selectedKeys[0]
        const anchorGene = selectedByPanel[anchorKey]
        const queryToken = String(anchorGene?.name || anchorGene?.id || '').trim()
        const hasUnmatchedPanels = panels.some((panel) => !selectedByPanel[panel.key])
        if (!hasUnmatchedPanels || !queryToken) {
            if (selectedKeys.length >= 2) {
                setSelectedGenes((prev) => ({ ...prev, ...selectedByPanel }))
                applyLinkedGeneView(selectedByPanel, { anchorKey })
            }
            return
        }

        const requestEpoch = tutorialEpochRef.current
        setLinkingGene(true)
        try {
            const matched = { ...selectedByPanel }
            await Promise.all(panels.map(async (panel) => {
                if (matched[panel.key]) return
                try {
                    const res = await fetch(`${API_BASE}/api/browse/search_gene?genome=${encodeURIComponent(panel.genomeParam)}&query=${encodeURIComponent(queryToken)}`)
                    if (!res.ok) return
                    const gene = await res.json()
                    if (hasFiniteGeneCoords(gene)) {
                        matched[panel.key] = gene
                    }
                } catch {
                    // keep unmatched panels independent
                }
            }))

            if (requestEpoch !== tutorialEpochRef.current) return
            const matchedKeys = panels
                .map((panel) => panel.key)
                .filter((key) => hasFiniteGeneCoords(matched[key]))
            if (matchedKeys.length < 2) {
                setLinkedPanelKeys([])
                linkModelRef.current = null
                alert(`Gene "${queryToken}" was not found in at least two visible genomes.`)
                return
            }

            const effectiveAnchor = matched[anchorKey] ? anchorKey : matchedKeys[0]
            setSelectedGenes((prev) => ({ ...prev, ...matched }))
            applyLinkedGeneView(matched, { anchorKey: effectiveAnchor })
        } catch (e) {
            console.error('Failed to link gene:', e)
        } finally {
            setLinkingGene(false)
        }
    }, [hasPanels, panels, selectedGenes, externalFocusMap, applyLinkedGeneView])

    const handleClearFocusedGenes = useCallback(() => {
        clearPendingLinkApply()
        linkModelRef.current = null
        setLinkedPanelKeys([])
        setLockPan(false)
        setLockZoom(false)
        setSelectedGenes({})
        setNavigateGenes({})
        setPanelPositions({})
        setClearFocusEpoch((prev) => prev + 1)
        if (onClearFocusedGenes) {
            onClearFocusedGenes()
        }
    }, [clearPendingLinkApply, onClearFocusedGenes])

    const tutorialHostRef = useRef(null)
    const tutorialEpochRef = useRef(0)
    tutorialHostRef.current = {
        cancel: () => { tutorialEpochRef.current += 1; clearPendingLinkApply() },
        describe: () => ({
            active: panels.map((panel) => panel.species.tutorial_dataset_id).filter(Boolean),
            pan: lockPan, zoom: lockZoom, link: linkModelRef.current?.type || 'none', hideInactive: hideInactiveMode,
        }),
        apply: async (scene, current) => {
            const epoch = ++tutorialEpochRef.current
            const valid = () => current() && epoch === tutorialEpochRef.current
            if (scene.reset) {
                handleClearFocusedGenes()
                setForceTracksVisibility(null); setHideInactiveMode(false); setCompressMode(false); setFlattenMode(false)
                setBiotypeFilter({ proteinCoding: true, lncRNA: true, pseudogene: true, smallNonCoding: true })
            }
            if (scene.link === 'none' || scene.reset) {
                clearPendingLinkApply(); linkModelRef.current = null; setLinkedPanelKeys([])
                setLockPan(false); setLockZoom(false)
            }
            const genes = {}
            for (const [id, state] of Object.entries(scene.panels || {})) {
                const panel = panels.find((entry) => entry.species.tutorial_dataset_id === id)
                if (!panel || state.focus === undefined) continue
                if (!state.focus) { handlePanelGeneSelect(panel.key, null); continue }
                const response = await fetch(`${API_BASE}/api/browse/search_gene?genome=${encodeURIComponent(panel.genomeParam)}&query=${encodeURIComponent(state.focus)}`)
                if (!response.ok) throw new Error(`Could not find ${state.focus} in ${panel.label}.`)
                const gene = await response.json()
                if (!valid()) return
                genes[panel.key] = gene
                handlePanelGeneSelect(panel.key, gene)
            }
            if (valid() && Object.keys(genes).length) setNavigateGenes((previous) => ({ ...previous, ...genes }))
        },
        link: async (scene, current) => {
            if (!current()) return
            if (scene.link === 'region') await handleLinkRegion()
            if (scene.link === 'gene') await handleLinkGene()
            if (!current()) return
            // Gene linking enables both after its framing animation; wait for that
            // before applying the author's explicit independent Pan/Zoom settings.
            if (scene.link === 'gene') await new Promise((resolve) => setTimeout(resolve, 300))
            if (!current()) return
            if (scene.pan !== undefined) setLockPan(scene.pan)
            if (scene.zoom !== undefined) setLockZoom(scene.zoom)
            if (scene.hideInactive !== undefined) setHideInactiveMode(scene.hideInactive)
        },
    }
    useEffect(() => registerTutorialBrowserHost({
        describe: () => tutorialHostRef.current.describe(),
        apply: (...args) => tutorialHostRef.current.apply(...args),
        link: (...args) => tutorialHostRef.current.link(...args),
        cancel: () => tutorialHostRef.current.cancel(),
    }), [])

    const [allRegisteredTracks, setAllRegisteredTracks] = useState([])
    const refreshRegisteredTracks = useCallback(() => {
        fetch(`${API_BASE}/api/tracks`)
            .then((r) => (r.ok ? r.json() : { tracks: [] }))
            .then((data) => setAllRegisteredTracks(data.tracks || []))
            .catch(() => { })
    }, [])

    useEffect(() => {
        refreshRegisteredTracks()
    }, [refreshRegisteredTracks])

    useEffect(() => {
        if (!isActive) return
        refreshRegisteredTracks()
    }, [isActive, refreshRegisteredTracks])

    /* A tutorial that has just registered tracks has changed what is available, and this
     * view only ever asked on mount and on becoming active. Jumping straight into a browser
     * step therefore found the list it had fetched before the tutorial existed — empty —
     * so the panel had nothing to match the step's `browserTracks` arrival against and drew
     * no custom tracks at all. */
    useEffect(() => {
        if (!browserTracksRequest) return
        refreshRegisteredTracks()
    }, [browserTracksRequest, refreshRegisteredTracks])

    useEffect(() => {
        if (!isActive) return
        const handleVisible = () => {
            if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return
            refreshRegisteredTracks()
        }
        window.addEventListener('focus', handleVisible)
        document.addEventListener('visibilitychange', handleVisible)
        return () => {
            window.removeEventListener('focus', handleVisible)
            document.removeEventListener('visibilitychange', handleVisible)
        }
    }, [isActive, refreshRegisteredTracks])

    const availableTracksByPanel = useMemo(() => {
        const byPanel = {}
        for (const panel of panels) {
            byPanel[panel.key] = allRegisteredTracks.filter((track) => (
                !track.genome_key || genomeKeysMatch(track.genome_key, panel.species)
            ))
        }
        return byPanel
    }, [allRegisteredTracks, panels])

    // Stacking several genomes at a uniform band height leaves a lot of dead space
    // under the sparser ones, so multi-genome defaults to adaptive.
    const adaptivePanelHeight = adaptivePanelHeightOverride ?? (panelCount > 1)
    const panelSizing = getGenomeBrowserPanelSizing(panelCount, adaptivePanelHeight)
    const useAdaptivePanelHeight = panelSizing.usesContentHeight
    const fillSinglePanelHeight = panelSizing.fillsAvailableHeight
    const panelMinHeight = panelSizing.panelMinHeight
    // Panels stretch to fill the window but are never capped by it: taller content
    // grows the page so the app's own scrollbar is the single vertical scroller.
    const growingPanelStyle = { flex: '1 0 auto', minHeight: 0 }

    // With Adaptive off the panels keep a common height, but that height is the
    // tallest genome's own content rather than a fixed band — same aligned look,
    // without padding every panel out to a number nobody chose.
    const sharedCanvasHeight = useMemo(() => {
        if (useAdaptivePanelHeight || panelCount < 2) return 0
        let tallest = 0
        for (const panel of panels) {
            tallest = Math.max(tallest, Number(panelContentHeights[panel.key]) || 0)
        }
        return tallest
    }, [useAdaptivePanelHeight, panelCount, panels, panelContentHeights])

    const handlePanelContentHeight = useCallback((panelKey, height) => {
        setPanelContentHeights((prev) => (
            prev[panelKey] === height ? prev : { ...prev, [panelKey]: height }
        ))
    }, [])

    // Identity-stable: depend on the scheme id alone, and resolveBrowsingControls
    // caches per id, so this survives `config` churning on every autosave. A new
    // controls object mid-gesture would re-register the panel wheel listeners.
    const browsingSchemeId = config?.browsing_control_scheme
    const browsingControls = useMemo(
        () => resolveBrowsingControls({ browsing_control_scheme: browsingSchemeId }),
        [browsingSchemeId]
    )
    const browsingControlsRef = useRef(browsingControls)
    browsingControlsRef.current = browsingControls

    /**
     * Fallback wheel handler for gestures that land between panels — the page
     * padding either side, or the 2px divider — where no panel listener exists.
     *
     * Its first job is a bug fix independent of any control scheme: without it
     * a ctrl+wheel there reaches Chromium unprevented and zooms the whole
     * Electron window, which desyncs every canvas's backing-store DPR until the
     * app is restarted.
     */
    useEffect(() => {
        // Listen on the document, in the BUBBLE phase, so panel handlers always
        // run first and this stays a pure fallback.
        //
        // Not on a resolved ancestor: the app's scroll container only becomes
        // `overflow-y-auto` while this view is the active one, so resolving it
        // once at mount (when the view is hidden) finds nothing. Resolve the
        // content area per event instead, which also scopes the fallback to the
        // app's own padding and excludes the header and other chrome.
        const findContentHost = () => {
            let node = screenshotPanelsRef.current?.parentElement
            while (node && node !== document.body) {
                const overflowY = window.getComputedStyle(node).overflowY
                if (overflowY === 'auto' || overflowY === 'scroll') return node
                node = node.parentElement
            }
            return null
        }

        const handleGutterWheel = (e) => {
            // The document also carries the other views, so stand down unless the
            // genome browser is the one on screen and the gesture is inside it.
            if (!isActiveRef.current) return
            const host = findContentHost()
            if (!host || !host.contains(e.target)) return

            // Unconditionally, and before anything else can bail out. This is
            // what stops Chromium page-zooming the whole Electron window.
            if (e.ctrlKey || e.metaKey) e.preventDefault()

            // A panel marks every event it resolves, including ones it chose to
            // do nothing with. Propagation alone cannot tell those apart, since
            // page-scroll and no-op intents deliberately keep bubbling.
            if (isWheelHandled(e)) return

            // The control bars are chrome, not track surface. A gesture there is
            // the user scrolling the page past them, never a zoom.
            const target = e.target instanceof Element ? e.target : null
            if (target?.closest?.('[data-browser-controls="true"]')) return

            const rects = []
            for (const [panelKey, descriptor] of Object.entries(browsingTargetsRef.current)) {
                const rect = descriptor?.getRootRect?.()
                if (rect && rect.width > 0) {
                    rects.push({ panelKey, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
                }
            }
            if (!rects.length) return

            const wheel = readWheelEvent(e)
            const intent = resolveWheelAction(wheel, browsingControlsRef.current, {})
            if (intent.type !== 'zoom') return

            const nearest = pickNearestPanel(e.clientY, e.clientX, rects)
            // The page margins either side of the panels — where the scrollbar
            // lives — belong to the page scroller. Only gestures over a panel's
            // own width fall through to zoom.
            if (!nearest?.insideHorizontally) return
            const panel = browsingTargetsRef.current[nearest.panelKey]
            if (!panel) return

            e.preventDefault()
            markWheelHandled(e)
            panel.applyWheelIntent(intent, { clientX: e.clientX, clientY: e.clientY })
        }

        // Capture phase, so it records where a gesture began before any panel
        // gets a chance to act on it.
        const handleWheelOrigin = (e) => {
            if (!isActiveRef.current) return
            const target = e.target instanceof Element ? e.target : null
            const onTrackSurface = Boolean(target?.closest?.('[data-browser-canvas-surface="true"]'))
                && !target?.closest?.('[data-browser-controls="true"]')
            noteWheelGestureOrigin(e, !onTrackSurface)
        }

        document.addEventListener('wheel', handleWheelOrigin, { capture: true, passive: true })
        document.addEventListener('wheel', handleGutterWheel, { passive: false })
        return () => {
            document.removeEventListener('wheel', handleWheelOrigin, { capture: true })
            document.removeEventListener('wheel', handleGutterWheel)
        }
    }, [])

    /**
     * Drag-to-scroll everywhere the canvas does not already provide it.
     *
     * The canvas panels axis-lock their own drag, so up/down scrolls the page
     * there. Everywhere else in the view — the per-panel control bar, the
     * focused-gene info bar, the padding between panels — a drag did nothing but
     * awkwardly select text. Scoped exactly like the wheel router above.
     */
    useEffect(() => {
        const findContentHost = () => {
            let node = screenshotPanelsRef.current?.parentElement
            while (node && node !== document.body) {
                const overflowY = window.getComputedStyle(node).overflowY
                if (overflowY === 'auto' || overflowY === 'scroll') return node
                node = node.parentElement
            }
            return null
        }

        // Modals and popovers sit inside this subtree but float above it; a drag
        // there must not scroll the page underneath. Only `fixed` counts —
        // `sticky` elements scroll with the content, so a toolbar that sticks is
        // still a perfectly good place to grab.
        const insideFloatingLayer = (start, host) => {
            let node = start instanceof Element ? start : null
            while (node && node !== host) {
                if (window.getComputedStyle(node).position === 'fixed') return true
                node = node.parentElement
            }
            return false
        }

        let drag = null
        const bodyStyle = document.body.style

        const stopDrag = () => {
            if (!drag) return
            const wasDragging = drag.dragging
            if (wasDragging) {
                bodyStyle.userSelect = drag.priorUserSelect
                bodyStyle.cursor = drag.priorCursor
                // Swallow the click this drag would otherwise synthesise.
                window.addEventListener('click', (e) => {
                    e.stopPropagation()
                    e.preventDefault()
                }, { capture: true, once: true })
            }
            drag = null
            window.removeEventListener('mousemove', handleMove)
            window.removeEventListener('mouseup', stopDrag)
        }

        function handleMove(e) {
            if (!drag) return
            const dx = e.clientX - drag.startX
            const dy = e.clientY - drag.startY

            if (!drag.dragging) {
                if (Math.abs(dx) <= DRAG_AXIS_THRESHOLD_PX && Math.abs(dy) <= DRAG_AXIS_THRESHOLD_PX) return
                const axis = resolveDragAxis({ dx, dy, canScrollPage: true, currentAxis: null })
                // Nothing here pans, so a sideways drag is left alone entirely
                // rather than being swallowed.
                if (axis !== 'y') { stopDrag(); return }
                drag.dragging = true
                drag.priorUserSelect = bodyStyle.userSelect
                drag.priorCursor = bodyStyle.cursor
                bodyStyle.userSelect = 'none'
                bodyStyle.cursor = 'grabbing'
                // A selection may already have started before the threshold.
                window.getSelection?.()?.removeAllRanges?.()
            }

            e.preventDefault()
            // 1:1 grab-and-drag, matching the canvas: dragging down reveals what
            // is above.
            drag.host.scrollTop = drag.startScrollTop - dy
        }

        const handleMouseDown = (e) => {
            if (!isActiveRef.current || e.button !== 0 || drag) return
            const host = findContentHost()
            if (!host || !host.contains(e.target)) return
            if (host.scrollHeight <= host.clientHeight + 1) return

            const target = e.target instanceof Element ? e.target : null
            // The canvas owns its own axis-locked drag, including the vertical
            // half, so leave it alone.
            if (target?.closest?.('[data-browser-canvas-surface="true"]')) return
            if (isTextEntryTarget(target) || target?.closest?.(DRAG_SCROLL_EXCLUDED_SELECTOR)) return
            if (insideFloatingLayer(target, host)) return

            drag = {
                host,
                startX: e.clientX,
                startY: e.clientY,
                startScrollTop: host.scrollTop,
                dragging: false,
                priorUserSelect: '',
                priorCursor: '',
            }
            window.addEventListener('mousemove', handleMove)
            window.addEventListener('mouseup', stopDrag)
        }

        document.addEventListener('mousedown', handleMouseDown)
        return () => {
            document.removeEventListener('mousedown', handleMouseDown)
            stopDrag()
        }
    }, [])

    return (
        <div
            ref={screenshotOverlayRootRef}
            className="relative w-full flex flex-col"
            style={fillSinglePanelHeight ? { minHeight: '100%' } : undefined}
        >
            {isOverlayActive && (
                <div className={`flex-none w-full px-4 py-2 flex items-center justify-between shadow-sm border-b z-10 ${isLight ? 'bg-indigo-50 border-indigo-200 text-indigo-900' : 'bg-indigo-900/40 border-indigo-800/50 text-indigo-100'}`}>
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                        <span className="text-sm font-medium">Alignment View Active</span>
                        <span className="text-xs ml-2 opacity-80">Regions are synchronised based on the pairwise alignment. Gaps are shown in sequence and features.</span>
                    </div>
                    <button
                        onClick={onClearAlignmentOverlay}
                        className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${isLight ? 'bg-indigo-200 hover:bg-indigo-300 text-indigo-900' : 'bg-indigo-800 hover:bg-indigo-700 text-indigo-100'}`}
                    >
                        Exit Alignment View
                    </button>
                </div>
            )}

            <div
                data-browser-controls="true"
                data-browser-global-controls="true"
                data-tour-id="browser-global-controls"
                className="flex items-center justify-between px-4 py-2 border-b flex-none"
                style={{
                    backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
                    borderColor: isLight ? '#dee2e6' : '#373a40',
                    // Pulled up by the scroller's own padding, so the row comes to
                    // rest against the app's top bar rather than a padding below it.
                    ...(controlsFollowScroll
                        ? { position: 'sticky', top: -Math.max(0, focusDrawerStickyInset), zIndex: 30 }
                        : null),
                }}
            >
                <div className="flex items-center gap-2">
                    {hasPanels && (
                        <>
                            <button
                                data-tour-id="browser-tracks-toggle"
                                onClick={handleGlobalTracksToggle}
                                className="flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors hover:bg-gray-100 dark:hover:bg-[#373a40]"
                                style={{
                                    backgroundColor: isLight ? '#ffffff' : '#1E2938',
                                    color: isLight ? '#4b5563' : '#9ca3af',
                                    border: `1px solid ${isLight ? '#d1d5db' : '#4b5563'}`,
                                }}
                                title={globalTracksState === 'off' ? 'Show all tracks' : 'Hide all tracks'}
                            >
                                <svg width="14" height="26" viewBox="0 0 14 26" fill="none">
                                    <rect
                                        x="0" y="0" width="14" height="26" rx="7"
                                        fill={globalTracksState === 'off' ? (isLight ? '#ced4da' : '#373a40') : (globalTracksState === 'mixed' ? (isLight ? '#adb5bd' : '#5c5f66') : '#3366cc')}
                                        className="transition-colors duration-200"
                                    />
                                    <circle
                                        cx="7"
                                        cy={globalTracksState === 'off' ? '19' : (globalTracksState === 'mixed' ? '13' : '7')}
                                        r="5"
                                        fill="#ffffff"
                                        className="transition-all duration-200"
                                    />
                                </svg>
                                Tracks
                            </button>

                            <button
                                type="button"
                                onClick={() => setAdaptivePanelHeightOverride(!adaptivePanelHeight)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, useAdaptivePanelHeight)}
                                title="Let each browser shrink to exactly its track content instead of keeping a uniform band height"
                            >
                                Adaptive
                            </button>

                            <button
                                onClick={() => setHideInactiveMode((prev) => !prev)}
                                data-tour-id="browser-hide-inactive"
                                data-tutorial-engaged={hideInactiveMode ? 'true' : 'false'}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, hideInactiveMode)}
                                title={hideInactiveMode
                                    ? 'Show inactive tracks in browser'
                                    : 'Hide inactive tracks from view as they are turned off'}
                            >
                                Hide
                            </button>

                            <button
                                data-tour-id="browser-detail"
                                data-tutorial-engaged={compressMode ? 'true' : 'false'}
                                onClick={() => setCompressMode((prev) => !prev)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, compressMode, { emphasizeWhenEnabled: true })}
                                title={compressMode
                                    ? 'Return to normal transcript spacing'
                                    : 'Compact transcript rows at transcript-detail zoom'}
                            >
                                Detail
                            </button>

                            <button
                                data-tour-id="browser-flatten"
                                data-tutorial-engaged={flattenMode ? 'true' : 'false'}
                                onClick={() => setFlattenMode((prev) => !prev)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, flattenMode, { emphasizeWhenEnabled: true })}
                                title={flattenMode
                                    ? 'Return to normal track spacing'
                                    : 'Minimise empty vertical space in visible tracks'}
                            >
                                Flatten
                            </button>

                            {!isOverlayActive && (
                                <>
                                    <button
                                        data-tour-id="browser-unfocus"
                                        onClick={handleClearFocusedGenes}
                                        disabled={!anyFocusedGene}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(anyFocusedGene, anyFocusedGene, { emphasizeWhenEnabled: true })}
                                        title="Clear all focused genes across genomes"
                                    >
                                        Unfocus
                                    </button>

                                    <button
                                        data-tour-id="browser-pan"
                                        data-tutorial-engaged={lockPan ? 'true' : 'false'}
                                        onClick={() => {
                                            if (panelCount < 2) return
                                            const newPan = !lockPan
                                            if (!newPan && !lockZoom) {
                                                clearPendingLinkApply()
                                                linkModelRef.current = null
                                                setLinkedPanelKeys([])
                                            }
                                            setPanelPositions({})
                                            setLockPan(newPan)
                                        }}
                                        disabled={panelCount < 2}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, lockPan)}
                                        title={panelCount >= 2 ? 'Lock panning across linked genome panels' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        Pan
                                    </button>

                                    <button
                                        data-tour-id="browser-zoom"
                                        data-tutorial-engaged={lockZoom ? 'true' : 'false'}
                                        onClick={() => {
                                            if (panelCount < 2) return
                                            const newZoom = !lockZoom
                                            if (!newZoom && !lockPan) {
                                                clearPendingLinkApply()
                                                linkModelRef.current = null
                                                setLinkedPanelKeys([])
                                            }
                                            setPanelPositions({})
                                            setLockZoom(newZoom)
                                        }}
                                        disabled={panelCount < 2}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, lockZoom)}
                                        title={panelCount >= 2 ? 'Lock zoom across linked genome panels' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        Zoom
                                    </button>

                                    <button
                                        data-tour-id="browser-linkRegion"
                                        data-tutorial-engaged={linkModelRef.current?.type === 'region' ? 'true' : 'false'}
                                        onClick={handleLinkRegion}
                                        disabled={panelCount < 2 || linkingRegion}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, linkedPanelKeys.length >= 2 && linkModelRef.current?.type === 'region', { working: linkingRegion, emphasizeWhenEnabled: true })}
                                        title={panelCount >= 2 ? 'Link visible genome panels to the primary region and coordinates' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        {linkingRegion ? 'Linking...' : 'Region'}
                                    </button>

                                    <button
                                        data-tour-id="browser-linkGene"
                                        data-tutorial-engaged={linkModelRef.current?.type === 'gene' ? 'true' : 'false'}
                                        onClick={handleLinkGene}
                                        disabled={panelCount < 2 || !anyFocusedGene || linkingGene}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2 && anyFocusedGene, linkedPanelKeys.length >= 2, { working: linkingGene, emphasizeWhenEnabled: true })}
                                        title={
                                            panelCount < 2
                                                ? 'Requires at least two visible genome panels'
                                                : (anyFocusedGene ? 'Link focused genes across visible genomes' : 'Select a gene first')
                                        }
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        {linkingGene ? 'Linking...' : 'Gene'}
                                    </button>
                                </>
                            )}

                            {(() => {
                                const chkStyle = {
                                    accentColor: isLight ? '#0099ff' : '#0077cc',
                                    cursor: 'pointer',
                                    width: '11px',
                                    height: '11px',
                                    flexShrink: 0,
                                }
                                const labelStyle = {
                                    color: isLight ? '#4b5563' : '#9ca3af',
                                    userSelect: 'none',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                }
                                const toggle = (key) => setBiotypeFilter((prev) => ({ ...prev, [key]: !prev[key] }))
                                return (
                                    <>
                                        <div className="h-4 w-px flex-shrink-0 mx-1" style={{ backgroundColor: isLight ? '#dee2e6' : '#495057' }} />
                                        <div data-tour-id="browser-biotype-filter" className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'auto auto', fontSize: '10px', lineHeight: '1.35' }}>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-proteinCoding" type="checkbox" checked={biotypeFilter.proteinCoding} onChange={() => toggle('proteinCoding')} style={chkStyle} />
                                                Protein-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-lncRNA" type="checkbox" checked={biotypeFilter.lncRNA} onChange={() => toggle('lncRNA')} style={chkStyle} />
                                                Long non-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-pseudogene" type="checkbox" checked={biotypeFilter.pseudogene} onChange={() => toggle('pseudogene')} style={chkStyle} />
                                                Pseudogene
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-smallNonCoding" type="checkbox" checked={biotypeFilter.smallNonCoding} onChange={() => toggle('smallNonCoding')} style={chkStyle} />
                                                Small non-coding
                                            </label>
                                        </div>
                                    </>
                                )
                            })()}
                        </>
                    )}
                </div>
                <div className="flex items-stretch flex-shrink-0" style={{ marginRight: '34px' }}>
                    {onPromoteGenome && <GenomeWheel
                        species={listedGenomes}
                        activeSpecies={panelSpecies}
                        config={config}
                        panelRootRef={screenshotPanelsRef}
                        onPromote={handleCyclePromote}
                        isActive={isActive && !screenshotMode}
                        isLight={isLight}
                    />}
                    <button
                        type="button"
                        data-tour-id="browser-controls-lock"
                        onClick={() => setControlsFollowScroll((prev) => !prev)}
                        aria-pressed={controlsFollowScroll}
                        // Square, and exactly as tall as the Cycle button beside it:
                        // both are an 18px line boxed in the same 7px padding and
                        // 1px border, so the two stay matched without a fixed size.
                        className="flex-shrink-0 flex items-center justify-center transition-colors"
                        style={{ ...browserActionButtonStyle(true, controlsFollowScroll), padding: '7px', borderRadius: '6px', lineHeight: 0 }}
                        aria-label={controlsFollowScroll
                            ? 'Controls unlocked and following the page: lock them back into place'
                            : 'Controls locked in place: unlock them to follow the page down'}
                        title={controlsFollowScroll
                            ? 'Unlocked: these controls follow the page down. Click to lock them back into place.'
                            : 'Locked: these controls stay put and scroll away with the page. Click to unlock them so they follow you down.'}
                    >
                        {/* The padlock the Feature Explorer locks splice paths with. */}
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d={controlsFollowScroll ? UNLOCKED_ICON_PATH : LOCKED_ICON_PATH} />
                        </svg>
                    </button>
                </div>
            </div>

            <div
                ref={screenshotPanelsRef}
                className={`relative w-full flex flex-col ${fillSinglePanelHeight ? '' : 'min-h-[220px]'} ${!hasPanels ? (isLight ? 'bg-white opacity-95' : 'bg-[#1E2938]') : ''}`}
                style={fillSinglePanelHeight ? growingPanelStyle : undefined}
            >
                {!hasPanels ? (
                    <div className="flex-1 min-h-[320px] w-full flex flex-col items-center justify-center p-6 bg-transparent">
                        <img
                            src="ensembl-e-blue.svg"
                            alt="Ensembl"
                            className={`mb-4 ${isLight ? 'opacity-80' : 'opacity-60 grayscale-[10%]'}`}
                            style={{ width: '130px', height: '130px' }}
                        />
                        <h2 className={`text-xl font-semibold mb-2 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>No genomes selected</h2>
                        <p className={`text-sm text-center max-w-xl ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Select active genomes from the bar above or add/remove via the Genome Selector
                        </p>
                    </div>
                ) : (
                    panels.map((panel, idx) => {
                        const panelKey = panel.key
                        const trackBrowsePath = panel.customTrackBrowsePath || fallbackBrowseRoot
                        const useSecondaryPreset = panel.useSecondaryPreset
                        const panelReady = browserReadyState?.[panelKey]?.state || 'idle'
                        const panelDetail = browserReadyState?.[panelKey]?.detail || ''
                        // Only once the check has actually said so. Treating the
                        // initial 'idle' as ready mounted the browser before
                        // anything had been asked, so it fired a regions request
                        // of its own, took whatever error was going, and then
                        // unmounted when the first real check flipped to
                        // 'checking' — a wasted request and a visible flash.
                        const isReady = panelReady === 'ready'
                        const panelReloadKey = panel.alignmentRole === 'reference'
                            ? refReloadKey
                            : (panel.alignmentRole === 'target' ? tgtReloadKey : 0)

                        const drawerEntry = focusDrawerEntries.find((entry) => entry.panelKey === panelKey) || null
                        const drawerAlign = focusDrawerAlignByPanel[panelKey] || { top: 0, height: 0 }
                        const drawerPinOffset = activePinPanelKey === panelKey ? focusDrawerPinOffset : 0
                        // With a gene of focus the assembly drawer drops down onto
                        // the focus drawer's band line and takes its height, so the
                        // two headers read as one row across the panel. With no
                        // gene it goes back to the toolbar its pill sits in.
                        const assemblyAlign = (drawerEntry && drawerAlign.height)
                            ? drawerAlign
                            : (assemblyDrawerAlignByPanel[panelKey] || { top: 0, height: 0 })
                        const assemblyState = assemblyInfoByPanel[panelKey] || null
                        // Cleared past whatever the focus drawer is currently
                        // taking, so the two never sit on top of each other.
                        const focusDrawerCoverage = !drawerEntry
                            ? 0
                            : !isFocusDrawerOpen(panelKey)
                                ? FOCUS_DRAWER_RAIL_WIDTH
                                : ((detailTranscriptByPanel[panelKey] || notesPanelOpenByPanel[panelKey])
                                    ? FOCUS_DRAWER_DETAIL_WIDTH
                                    : FOCUS_DRAWER_WIDTH)

                        return (
                            <div
                                key={panelKey}
                                // The drawer for this genome is positioned against
                                // this box, so it can never reach over the panel
                                // above or below however tall its list grows.
                                data-focus-panel-wrapper={panelKey}
                                data-tutorial-genome={panel.species.tutorial_dataset_id || undefined}
                                className="relative w-full flex flex-col"
                                style={fillSinglePanelHeight ? growingPanelStyle : undefined}
                            >
                                {idx > 0 && (
                                    <div className="w-full flex-none" style={{ height: '2px', backgroundColor: isLight ? '#adb5bd' : '#373a40' }} />
                                )}
                                <div
                                    className="w-full flex flex-col overflow-visible"
                                    style={{
                                        ...growingPanelStyle,
                                        // A floor only. The browser inside lays its tracks out at
                                        // full height and overflows onto the page rather than into
                                        // a nested scroll area.
                                        minHeight: useAdaptivePanelHeight ? 0 : (panelMinHeight || 0),
                                        height: 'auto',
                                    }}
                                >
                                    {isReady ? (
                                        <GenomeBrowser
                                            key={panelKey}
                                            isActive={isActive}
                                            genome={panel.genomeParam}
                                            tutorialRecipeId={panel.species.tutorial_dataset_id || ''}
                                            tutorialActive={tutorialRunning}
                                            geneNoteCounts={noteCountsByPanel[panelKey] || EMPTY_NOTE_COUNTS}
                                            onOpenGeneNotes={(geneId) => handleOpenGeneNotes(panelKey, geneId)}
                                            alignmentRole={panel.alignmentRole}
                                            reloadEpoch={panelReloadKey}
                                            theme={theme}
                                            label={panel.label}
                                            genomePillLabel={panel.genomePillLabel}
                                            genomeColor={resolveGenomeColor(panel.species)}
                                            onGenomePillClick={() => handleGenomePillClick(panelKey)}
                                            genomePillExpanded={Boolean(assemblyDrawerOpenByPanel[panelKey])}
                                            toolbarPosition="top"
                                            rulerPosition="top"
                                            focusBarPosition="top"
                                            trackAlign="top"
                                            showSequenceTrack={true}
                                            sequenceTrackPosition="bottom"
                                            sequenceTrackLabel="SL"
                                            sequenceTrackTooltip={useSecondaryPreset
                                                ? 'Base level view of the secondary genome'
                                                : 'Base level view of the primary genome'}
                                            customTrackBrowsePath={trackBrowsePath}
                                            availableTracks={availableTracksByPanel[panelKey] || []}
                                            refreshAvailableTracks={refreshRegisteredTracks}
                                            tutorialTracksRequest={browserTracksRequest}
                                            onTutorialHideInactive={setHideInactiveMode}
                                            onTrackVisibilityChange={(hiddenStrands, meta) => handlePanelTrackVisibilityChange(panelKey, hiddenStrands, meta)}
                                            forceTracksVisibility={forceTracksVisibility}
                                            hideInactiveTracks={hideInactiveMode}
                                            compressTranscripts={compressMode}
                                            flattenTracks={flattenMode}
                                            adaptiveHeight={useAdaptivePanelHeight}
                                            hiddenBiotypeClasses={hiddenBiotypeClasses}
                                            dimNonSelectedGenes={config?.dim_non_selected_genes !== false}
                                            alignmentOverlay={panel.alignmentRole ? alignmentOverlay : null}
                                            onPositionChange={(chrom, start, end, targetTrack, anchorRatio) => handlePanelPositionChange(panelKey, chrom, start, end, targetTrack, anchorRatio)}
                                            onViewSync={(chrom, start, end) => { panelActualPositionsRef.current[panelKey] = { chrom, start, end } }}
                                            minCanvasHeight={sharedCanvasHeight}
                                            onContentHeightChange={(height) => handlePanelContentHeight(panelKey, height)}
                                            browsingControls={browsingControls}
                                            onBrowsingTargetChange={(descriptor) => handleBrowsingTargetChange(panelKey, descriptor)}
                                            externalPosition={
                                                (effectiveLockPan || effectiveLockZoom) && syncSourcePanelKeyRef.current !== panelKey
                                                    ? (panelPositions[panelKey] || null)
                                                    : null
                                            }
                                            lockPan={effectiveLockPan}
                                            lockZoom={effectiveLockZoom}
                                            onGeneSelect={(gene) => handlePanelGeneSelect(panelKey, gene)}
                                            focusTranscriptView={focusTranscriptViews[panelKey] || null}
                                            geneTranscriptViews={geneTranscriptViews[panelKey] || null}
                                            focusDrawerInset={focusDrawerInsetFor(panelKey)}
                                            focusDrawerInsetOnFocus={FOCUS_DRAWER_WIDTH}
                                            onFocusTranscriptsChange={(payload) => handleFocusTranscriptsChange(panelKey, payload)}
                                            onFocusTranscriptViewChange={(patch) => handleFocusTranscriptViewChange(panelKey, patch)}
                                            onFocusRowGeometryChange={(geometry) => handleFocusRowGeometryChange(panelKey, geometry)}
                                            onGeneTranscriptViewChange={(geneId, patch) => handleGeneTranscriptViewChange(panelKey, geneId, patch)}
                                            navigateToGene={navigateGenes[panelKey] || null}
                                            onManualNavigate={handleManualBrowserNavigate}
                                            clearFocusEpoch={clearFocusEpoch + (panelClearEpochs[panelKey] || 0)}
                                            screenshotTargetId={panelKey}
                                            onScreenshotTargetChange={(descriptor) => handleScreenshotTargetChange(panelKey, descriptor)}
                                        />
                                    ) : (
                                        <IndexPreparingNotice
                                            isLight={isLight}
                                            state={panelReady}
                                            detail={panelDetail}
                                            onRetry={() => retryGenomeIndex(panel)}
                                        />
                                    )}
                                </div>

                                {drawerEntry && (
                                    <FocusGeneDrawer
                                        theme={theme}
                                        open={isFocusDrawerOpen(panelKey)}
                                        onToggle={() => setFocusDrawerOpenByPanel((prev) => {
                                            const wasOpen = prev[panelKey] !== false
                                            // Collapsing hides the list the pin belongs to, so the
                                            // highlight it holds in the browser has nothing left to
                                            // point at. Let it go rather than stranding it.
                                            if (wasOpen) {
                                                setDetailTranscriptByPanel((all) => ({ ...all, [panelKey]: '' }))
                                                setNotesPanelOpenByPanel((all) => ({ ...all, [panelKey]: false }))
                                                handleFocusTranscriptViewChange(panelKey, {
                                                    pinnedId: null, hoverId: null, ghostId: null,
                                                })
                                            }
                                            return { ...prev, [panelKey]: !wasOpen }
                                        })}
                                        onDismiss={() => handleClearPanelFocus(panelKey)}
                                        entries={[drawerEntry]}
                                        activePanelKey={panelKey}
                                        view={focusTranscriptViews[panelKey] || null}
                                        onViewChange={(patch) => handleFocusTranscriptViewChange(panelKey, patch)}
                                        showPanelSwitcher={false}
                                        alignTop={drawerAlign.top}
                                        alignHeight={drawerAlign.height}
                                        pinOffset={drawerPinOffset}
                                        stickyTopInset={focusDrawerStickyInset}
                                        listShift={detailListShiftByPanel[panelKey] || 0}
                                        genome={panel.genomeParam}
                                            tutorialRecipeId={panel.species.tutorial_dataset_id || ''}
                                            tutorialActive={tutorialRunning}
                                        detailTranscriptId={detailTranscriptByPanel[panelKey] || ''}
                                        onDetailTranscriptChange={(id) => handleDetailTranscriptChange(panelKey, id)}
                                        notesEnabled={Boolean(notesGenomeKeyFor(panel))}
                                        // Selected out of the loaded store, so this
                                        // is always exactly this gene's notes — there
                                        // is no per-gene fetch left to lag behind.
                                        notes={notesByPanel[panelKey] || EMPTY_NOTE_LIST}
                                        notesStatus={noteStore.status}
                                        notesError={noteStore.error}
                                        notesPanelOpen={Boolean(notesPanelOpenByPanel[panelKey])}
                                        onNotesPanelToggle={() => handleNotesPanelToggle(panelKey)}
                                        openNoteId={openNoteIdByPanel[panelKey] || ''}
                                        onOpenNoteChange={(id) => handleOpenNoteChange(panelKey, id)}
                                        noteSortMode={noteSortByPanel[panelKey] || DEFAULT_NOTE_SORT_MODE}
                                        onNoteSortChange={(mode) => setNoteSortByPanel((prev) => ({ ...prev, [panelKey]: mode }))}
                                        noteSaveState={noteStore.saveStateFor(openNoteIdByPanel[panelKey] || '')}
                                        onNoteCreate={() => handleNoteCreate(panelKey)}
                                        onNoteFieldChange={(id, patch) => noteStore.updateNoteFields(id, patch)}
                                        onNoteSave={(id, options) => noteStore.saveNote(id, options)}
                                        onNoteDelete={(id) => handleNoteDelete(panelKey, id)}
                                        onNotesReload={(noteId) => noteStore.reload({ noteId })}
                                    />
                                )}

                                {assemblyDrawerOpenByPanel[panelKey] && (
                                    <AssemblyInfoDrawer
                                        theme={theme}
                                        open
                                        onClose={() => closeAssemblyDrawer(panelKey)}
                                        genome={panel.species}
                                        assemblyInfo={assemblyState?.info || null}
                                        loading={assemblyState?.loading !== false}
                                        accentColor={resolveGenomeColor(panel.species)}
                                        label={panel.genomePillLabel || panel.label}
                                        alignTop={assemblyAlign.top}
                                        alignHeight={assemblyAlign.height}
                                        stickyTopInset={focusDrawerStickyInset}
                                        rightInset={focusDrawerCoverage}
                                    />
                                )}
                            </div>
                        )
                    })
                )}

                {panelsBottomSpacer > 0 && (
                    // Empty page under the last genome, so it can be scrolled up
                    // to the top bar like any other. Not a gap between panels:
                    // it only exists past the end of the final one.
                    <div className="w-full flex-none" style={{ height: panelsBottomSpacer }} aria-hidden="true" />
                )}

            </div>

            <ScreenshotSelectionOverlay
                active={screenshotMode && hasPanels}
                theme={theme}
                containerRef={screenshotOverlayRootRef}
                scrollContainerRef={screenshotPanelsRef}
                exemptRefs={[screenshotToggleButtonRef]}
                useViewport={true}
                targets={screenshotTargets}
                onSelect={(target) => {
                    setSelectedScreenshotTarget(target)
                    onScreenshotModeChange?.(false)
                }}
                onCancel={() => {
                    onScreenshotModeChange?.(false)
                }}
            />

            <ScreenshotExportModal
                open={Boolean(selectedScreenshotTarget)}
                theme={theme}
                target={selectedScreenshotTarget}
                outputDir={defaultScreenshotDir}
                onSave={handleScreenshotSave}
                onClose={handleScreenshotModalClose}
            />


        </div>
    )
}
