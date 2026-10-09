import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { isHedgehogShh } from '../../achievements/geneFocus.js'
import { trackAchievement } from '../../achievements/tracker.js'
import useTutorial from '../../hooks/useTutorial'
import { registerBrowserNotes } from '../../utils/browserTutorialControls'
import { registerTutorialBrowserHost } from '../../utils/tutorialBrowserScene.js'
import { FOCUS_DRAWER_RAIL_WIDTH, FOCUS_DRAWER_WIDTH } from '../FocusGeneDrawer'
import { hasAssemblyMetadata } from '../../utils/assemblyMetadataRows'

import { API_BASE } from '../../backendRuntime'
import { readinessRetryDelay } from '../../utils/browserReadiness'
import { genomeColorResolver } from '../../genomeColorSchemes'
import useScreenshotTargets from '../../hooks/useScreenshotTargets'
import { rasterizeSvgMarkup } from '../../utils/screenshotExport'
import { getAssemblyGenomeKey, genomeKeysMatch, trackAssemblyKey } from '../../utils/genomeIdentity'
import { cycleBottomSpacer } from '../../utils/genomeWheel'
import { findScrollHost, stickyControlsInset, panelAlignmentAnchor } from '../../utils/browserScrollRail'
import { resolveBrowserGene } from '../../utils/browserGeneNavigation.js'
import {
    NOTE_TARGET_KIND_LOCATION,
    buildGeneNoteTarget,
    buildLocationNoteTarget,
    locationNoteTargetId,
    normalizeNoteGenomeKey,
} from '../../utils/geneNotes'
import { classifyBiotype } from '../../utils/geneBiotypes'
import { locationSpan } from '../../utils/locationFocus'
import useNoteStore from '../../hooks/useNoteStore'
import { alignBandToBar, getGenomeBrowserPanelSizing } from './genomeBrowserViewportLayout'
import { consumeRestoredSessionState, peekRestoredSessionState, registerSessionState } from '../../sessionResume.js'
import {
    DRAG_AXIS_THRESHOLD_PX,
    isTextEntryTarget,
    isWheelHandled,
    markWheelHandled,
    isWheelInsideIsolatedOverlay,
    pickNearestPanel,
    readWheelEvent,
    resolveBrowsingControls,
    resolveDragAxis,
    resolveWheelAction,
    noteWheelGestureOrigin,
} from '../../utils/browsingControls'
import { speciesItemKey } from '../../app/genomeLists.js'
import { hasFiniteGeneCoords } from '../../app/geneFocus.js'
import {
  DRAG_SCROLL_EXCLUDED_SELECTOR,
  EMPTY_FAR_PANELS,
  EMPTY_NOTE_COUNTS,
  EMPTY_NOTE_LIST,
  OFFSCREEN_LINK_INTERVAL_MS,
  buildGenomePillLabel,
  dedupeSpeciesList,
  dirnameFromPath,
} from './view/browserViewModel.js'
import { renderBrowserView } from './view/BrowserViewLayout.jsx'
import { flushLinkedPanelPositions } from './view/panelLinking.js'
import { applyLinkedGeneViewToPanels } from './view/panelLinking.js'
import { linkPanelsByGene } from './view/panelLinking.js'
import { linkPanelsByRegion } from './view/panelLinking.js'
import { checkGenomeReadiness } from './view/genomeReadiness.js'
import { movePinnedAlignment } from './view/panelFocus.js'
import { changeDetailTranscript } from './view/panelFocus.js'
import { alignPanelToTopOfView } from './view/panelFocus.js'
import { selectPanelGene } from './view/panelFocus.js'

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
    externalTgtGene = null,
    externalFocusGenesByGenome = null,
    // genomeKey -> { chrom, start, end } a location note asked the browser to
    // go to. Handed straight to the panel, which focuses it on arrival.
    externalFocusLocationsByGenome = null,
    incomingGene = null,
    onIncomingGeneConsumed = null,
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
    // The browser's own controls as they were before the page reloaded, if it did (see
    // sessionResume.js). Each panel puts back its own window and focus; this is the rest.
    const resumedRef = useRef(undefined)
    if (resumedRef.current === undefined) {
        const saved = peekRestoredSessionState('browser.view')
        resumedRef.current = saved && typeof saved === 'object' ? saved : null
    }
    const resumed = resumedRef.current
    const [lockPan, setLockPan] = useState(() => Boolean(resumed?.lockPan))
    const [lockZoom, setLockZoom] = useState(() => Boolean(resumed?.lockZoom))

    const [globalTracksState, setGlobalTracksState] = useState('on')
    const [forceTracksVisibility, setForceTracksVisibility] = useState(undefined)
    const [hideInactiveMode, setHideInactiveMode] = useState(() => Boolean(resumed?.hideInactiveMode))
    const [compressMode, setCompressMode] = useState(() => Boolean(resumed?.compressMode))
    const [flattenMode, setFlattenMode] = useState(() => Boolean(resumed?.flattenMode))
    // null until the user presses the Adaptive button. Once they have, their choice
    // sticks for the rest of the session — including across multi -> single -> multi
    // — so we never re-enable something they deliberately turned off.
    const [adaptivePanelHeightOverride, setAdaptivePanelHeightOverride] = useState(null)
    const [panelContentHeights, setPanelContentHeights] = useState({})
    const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)

    const [biotypeFilter, setBiotypeFilter] = useState(() => ({
        proteinCoding: true,
        lncRNA: true,
        smallNonCoding: true,
        pseudogene: true,
        ...(resumed?.biotypeFilter && typeof resumed.biotypeFilter === 'object' ? resumed.biotypeFilter : {}),
    }))
    const hiddenBiotypeClasses = useMemo(() => Object.entries(biotypeFilter)
        .filter(([, v]) => !v)
        .map(([k]) => k), [biotypeFilter])

    const [selectedGenes, setSelectedGenes] = useState({})
    // panelKey -> the location of focus that panel holds, mirrored up from the
    // panels so the view can hang a drawer off it and the toolbar can offer to
    // clear it.
    const [selectedLocations, setSelectedLocations] = useState({})
    // The location drawer's own view model, per panel: whether it is out, which
    // wide panel it has open, the genes it has read for the region, and which of
    // them the reader has hidden from the browser.
    const [locationDrawerOpenByPanel, setLocationDrawerOpenByPanel] = useState({})
    const [locationDetailByPanel, setLocationDetailByPanel] = useState({})
    const [locationFeaturesByPanel, setLocationFeaturesByPanel] = useState({})
    const [locationHiddenGenesByPanel, setLocationHiddenGenesByPanel] = useState({})
    const [locationFeaturesEpoch, setLocationFeaturesEpoch] = useState(0)
    const [locationNotesPanelOpenByPanel, setLocationNotesPanelOpenByPanel] = useState({})
    const [locationOpenNoteIdByPanel, setLocationOpenNoteIdByPanel] = useState({})
    const [locationNoteSortByPanel, setLocationNoteSortByPanel] = useState({})
    // Extra panel height the open location drawer has asked for, per panel, so a
    // list or a sequence view longer than the tracks is not cut off at the
    // bottom edge of a panel sized for two rows of genes.
    const [locationDrawerFitByPanel, setLocationDrawerFitByPanel] = useState({})
    const [navigateGenes, setNavigateGenes] = useState({})
    const [incomingGeneError, setIncomingGeneError] = useState(null)
    const [panelPositions, setPanelPositions] = useState({})
    const [linkedPanelKeys, setLinkedPanelKeys] = useState(() => (
        Array.isArray(resumed?.linkedPanelKeys) && resumed?.linkModel ? resumed.linkedPanelKeys : []
    ))
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
    const linkModelRef = useRef(resumed?.linkModel && Array.isArray(resumed?.linkedPanelKeys) ? resumed.linkModel : null)
    // Drawers the reader had collapsed. A focus arriving always opens its drawer, so these
    // are applied as each panel's restored focus arrives rather than up front.
    const resumeClosedDrawersRef = useRef({
        focus: new Set(Array.isArray(resumed?.closedFocusDrawers) ? resumed.closedFocusDrawers : []),
        location: new Set(Array.isArray(resumed?.closedLocationDrawers) ? resumed.closedLocationDrawers : []),
    })
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
    const anyLocationSelected = panels.some((panel) => Boolean(selectedLocations[panel.key]))

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

    /** Per-panel state that belongs to one location and dies with it. */
    const resetLocationPanelState = useCallback((panelKey) => {
        const drop = (setter) => setter((prev) => {
            if (!(panelKey in prev)) return prev
            const next = { ...prev }
            delete next[panelKey]
            return next
        })
        drop(setLocationDetailByPanel)
        drop(setLocationFeaturesByPanel)
        // Hiding a gene is scoped to the location that is in focus: clearing the
        // focus is what puts every hidden gene back on the track.
        drop(setLocationHiddenGenesByPanel)
        drop(setLocationNotesPanelOpenByPanel)
        drop(setLocationOpenNoteIdByPanel)
        // The panel goes back to its own content height; the next drawer asks
        // again for whatever it needs.
        drop(setLocationDrawerFitByPanel)
    }, [])

    const handlePanelLocationSelect = useCallback((panelKey, location) => {
        setSelectedLocations((prev) => {
            const current = prev[panelKey] || null
            if (!location) {
                if (!current) return prev
                const next = { ...prev }
                delete next[panelKey]
                return next
            }
            const same = current
                && current.chrom === location.chrom
                && current.start === location.start
                && current.end === location.end
            return same ? prev : { ...prev, [panelKey]: location }
        })
    }, [])

    /* A different region is a different subject: the genes read for the old one,
     * the genes hidden from it and whatever was open beside it all go with it.
     *
     * Done here rather than in the handler above because the location also
     * changes without one — a panel reporting its own focus cleared, a genome
     * leaving the top bar — and every route has to leave the same clean slate. */
    const lastLocationSignatureRef = useRef(new Map())
    const locationSignature = useMemo(() => panels.map((panel) => {
        const location = selectedLocations[panel.key]
        const span = locationSpan(location)
        return `${panel.key}=${span ? `${location.chrom}:${span.start}-${span.end}` : ''}`
    }).join('|'), [panels, selectedLocations])

    useEffect(() => {
        for (const entry of locationSignature.split('|')) {
            const separator = entry.indexOf('=')
            if (separator < 0) continue
            const panelKey = entry.slice(0, separator)
            const signature = entry.slice(separator + 1)
            if (lastLocationSignatureRef.current.get(panelKey) === signature) continue
            lastLocationSignatureRef.current.set(panelKey, signature)
            resetLocationPanelState(panelKey)
            // A fresh focus presents its drawer open, whatever the reader did
            // with the collapse arrow on the last one.
            if (signature) {
                const resumeClosed = resumeClosedDrawersRef.current.location.delete(panelKey)
                setLocationDrawerOpenByPanel((all) => ({ ...all, [panelKey]: !resumeClosed }))
            }
        }
    }, [locationSignature, resetLocationPanelState])

    const isLocationDrawerOpen = useCallback(
        (panelKey) => locationDrawerOpenByPanel[panelKey] !== false,
        [locationDrawerOpenByPanel]
    )

    /* The genes inside each focused location.
     *
     * Read straight from the region endpoint rather than from the panel's tile
     * cache: the drawer lists the whole location, and the tiles only cover what
     * the viewport has been near. Descriptions come with them, because the gene
     * detail beside the list is the only thing that shows them. */
    const locationFeatureRequestsRef = useRef(new Map())
    useEffect(() => {
        const wanted = new Map()
        for (const panel of panels) {
            const location = selectedLocations[panel.key]
            const span = locationSpan(location)
            if (!span) continue
            wanted.set(panel.key, {
                genome: panel.genomeParam,
                chrom: String(location.chrom || ''),
                start: span.start,
                end: span.end,
                key: `${locationFeaturesEpoch}|${panel.genomeParam}|${location.chrom}|${span.start}-${span.end}`,
            })
        }

        // Panels that no longer hold a location stop being tracked, so focusing
        // the same region again re-reads it rather than showing a stale list.
        for (const key of [...locationFeatureRequestsRef.current.keys()]) {
            if (!wanted.has(key)) locationFeatureRequestsRef.current.delete(key)
        }

        const controllers = []
        for (const [panelKey, request] of wanted) {
            if (locationFeatureRequestsRef.current.get(panelKey) === request.key) continue
            locationFeatureRequestsRef.current.set(panelKey, request.key)

            const controller = new AbortController()
            controllers.push(controller)
            setLocationFeaturesByPanel((prev) => ({
                ...prev,
                [panelKey]: { genes: prev[panelKey]?.genes || [], loading: true, error: '' },
            }))

            ;(async () => {
                try {
                    const params = new URLSearchParams({
                        genome: request.genome,
                        chrom: request.chrom,
                        start: String(request.start),
                        end: String(request.end),
                        include_description: 'true',
                    })
                    const res = await fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, {
                        signal: controller.signal,
                    })
                    const payload = await res.json().catch(() => ([]))
                    if (!res.ok) throw new Error(payload?.detail || 'Could not read the genes in this location.')
                    setLocationFeaturesByPanel((prev) => ({
                        ...prev,
                        [panelKey]: { genes: Array.isArray(payload) ? payload : [], loading: false, error: '' },
                    }))
                } catch (error) {
                    if (controller.signal.aborted) return
                    // Left retryable: the drawer offers the retry, which bumps
                    // the epoch and brings this effect back round.
                    locationFeatureRequestsRef.current.delete(panelKey)
                    setLocationFeaturesByPanel((prev) => ({
                        ...prev,
                        [panelKey]: {
                            genes: [],
                            loading: false,
                            error: error?.message || 'Could not read the genes in this location.',
                        },
                    }))
                }
            })()
        }

        return () => { for (const controller of controllers) controller.abort() }
    }, [panels, selectedLocations, locationFeaturesEpoch])

    /* The drawer reports how far its content overruns the panel; the panel grows
     * or shrinks by that much. A delta rather than an absolute, because only the
     * drawer can see what fits and only the panel knows how tall it is — each
     * correction is measured against the result of the last one, so the two
     * settle within a frame or two. */
    const MAX_LOCATION_DRAWER_FIT = 1200
    const handleLocationDrawerFit = useCallback((panelKey, delta) => {
        setLocationDrawerFitByPanel((prev) => {
            const current = prev[panelKey] || 0
            const next = Math.max(0, Math.min(MAX_LOCATION_DRAWER_FIT, current + delta))
            if (Math.abs(next - current) < 8) return prev
            return { ...prev, [panelKey]: next }
        })
    }, [])

    /** The class filter above the browser, as the drawer's list reads it. */
    const isFeatureHiddenByClass = useCallback((feature) => {
        if (hiddenBiotypeClasses.length === 0) return false
        const cls = classifyBiotype(feature?.biotype)
        return Boolean(cls && hiddenBiotypeClasses.includes(cls))
    }, [hiddenBiotypeClasses])

    const handleLocationDetailChange = useCallback((panelKey, detail) => {
        setLocationDetailByPanel((prev) => ({ ...prev, [panelKey]: detail || null }))
        // The wide slot holds one thing at a time, as in the gene drawer.
        if (detail) setLocationNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: false }))
    }, [])

    /** Hide one gene from the track, or put every hidden gene back. */
    const handleLocationGeneHiddenToggle = useCallback((panelKey, geneId) => {
        setLocationHiddenGenesByPanel((prev) => {
            if (!geneId) {
                if (!prev[panelKey]?.length) return prev
                return { ...prev, [panelKey]: [] }
            }
            const current = prev[panelKey] || []
            const id = String(geneId)
            return {
                ...prev,
                [panelKey]: current.includes(id)
                    ? current.filter((entry) => entry !== id)
                    : [...current, id],
            }
        })
    }, [])

    /* The drawer's focus target: jump to the gene and make it the gene of focus.
     *
     * Only the navigation is sent. The panel focuses whatever it navigates to
     * and reports that back up through onGeneSelect, and focusing a gene is what
     * clears the location — which is also what puts the hidden genes back. */
    const handleLocationFocusGene = useCallback((panelKey, gene) => {
        if (!gene?.id) return
        setNavigateGenes((prev) => ({
            ...prev,
            [panelKey]: {
                chrom: gene.chrom,
                start: gene.start,
                end: gene.end,
                strand: gene.strand,
                name: gene.name || '',
                id: gene.id,
                centerVertically: true,
            },
        }))
    }, [])

    const handlePanelGeneSelect = useCallback((...args) => selectPanelGene({
        geneTranscriptViews,
        resumeClosedDrawersRef,
        setDetailTranscriptByPanel,
        setFocusDrawerOpenByPanel,
        setFocusPanelOrder,
        setFocusTranscriptViews,
        setSelectedGenes,
    }, ...args), [geneTranscriptViews])

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

    const alignPanelToTop = useCallback((...args) => alignPanelToTopOfView({ cycleScrollRef, screenshotOverlayRootRef, screenshotPanelsRef, stopCycleScroll }, ...args), [stopCycleScroll])

    // What the Cycle wheel is currently offering, so the scroll rail can stay on
    // top of the wheel's overlay and light the genome standing at the front of the
    // drum. The wheel only publishes this when the answer changes, so it costs a
    // render per genome stepped through rather than one per pointer frame.
    const [cyclePreview, setCyclePreview] = useState(null)

    const handleCyclePromote = useCallback(async (panelKey, action, source) => {
        if (onPromoteGenome) await onPromoteGenome(panelKey, action, source)
        // Also for a genome that was already active: 'add' cannot add it twice,
        // so the scroll is the whole of what the jump does.
        alignPanelToTop(panelKey)
    }, [onPromoteGenome, alignPanelToTop])

    const incomingPanel = panels.find((panel) => panel.key === incomingGene?.genomeKey)
    const incomingPanelReady = browserReadyState?.[incomingPanel?.key]?.state === 'ready'

    useEffect(() => {
        if (!isActive || !incomingGene) return
        setIncomingGeneError(null)
        alignPanelToTop(incomingGene.genomeKey)
    }, [isActive, incomingGene, alignPanelToTop])

    useEffect(() => {
        if (!isActive) stopCycleScroll()
    }, [isActive, stopCycleScroll])

    useEffect(() => {
        if (!isActive || !incomingGene || !incomingPanel || !incomingPanelReady) return
        const controller = new AbortController()
        const openGene = async () => {
            try {
                const gene = await resolveBrowserGene({
                    apiBase: API_BASE,
                    genomeKey: incomingPanel.genomeParam,
                    gene: incomingGene.gene,
                    signal: controller.signal,
                })
                if (controller.signal.aborted) return
                handlePanelGeneSelect(incomingPanel.key, gene)
                // A fresh navigation object also re-centres a gene that was
                // already focused before the reader panned away from it.
                handleLocationFocusGene(incomingPanel.key, gene)
                alignPanelToTop(incomingPanel.key)
                onIncomingGeneConsumed?.(incomingGene)
            } catch (error) {
                if (controller.signal.aborted) return
                setIncomingGeneError({ genomeKey: incomingPanel.key, message: error.message })
                onIncomingGeneConsumed?.(incomingGene)
            }
        }
        openGene()
        return () => controller.abort()
    }, [isActive, incomingGene, incomingPanel, incomingPanelReady, handlePanelGeneSelect,
        handleLocationFocusGene, alignPanelToTop, onIncomingGeneConsumed])

    // What the left-hand scroll rail draws: one dot per genome actually on the
    // page, in page order. Genomes that are merely listed in the top bar are
    // left off — unlike the Cycle wheel, the rail is a map of what is there to
    // scroll through, not a way of choosing something else.
    const scrollRailStops = useMemo(() => panels.map((panel) => ({
        key: panel.key,
        label: panel.genomePillLabel || panel.label,
        color: resolveGenomeColor(panel.species),
        tourId: panel.species?.tutorial_dataset_id || panel.key,
    })), [panels, resolveGenomeColor])

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
    const handleDetailTranscriptChange = useCallback((...args) => changeDetailTranscript({
        detailScrollMemoryRef,
        detailTranscriptRef,
        findPanelScroller,
        screenshotOverlayRootRef,
        setDetailListShiftByPanel,
        setDetailTranscriptByPanel,
        setNotesPanelOpenByPanel,
    }, ...args), [findPanelScroller])

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

    const { notesForGene, notesForTarget, geneNoteCountsForGenome: geneNoteCountsFor } = noteStore

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

    const locationNotesByPanel = useMemo(() => {
        const out = {}
        for (const panel of panels) {
            const genomeKey = notesGenomeKeyFor(panel)
            const targetId = locationNoteTargetId(selectedLocations[panel.key])
            out[panel.key] = (genomeKey && targetId)
                ? notesForTarget(NOTE_TARGET_KIND_LOCATION, genomeKey, targetId)
                : EMPTY_NOTE_LIST
        }
        return out
    }, [panels, selectedLocations, notesGenomeKeyFor, notesForTarget])

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

    const handleLocationNoteCreate = useCallback((panelKey) => {
        const panel = panels.find((candidate) => candidate.key === panelKey)
        const genomeKey = notesGenomeKeyFor(panel)
        const location = selectedLocations[panelKey]
        if (!genomeKey || !locationNoteTargetId(location)) return

        const target = buildLocationNoteTarget({
            genomeKey,
            selectionKey: panel?.key || '',
            location,
        })
        const { tempId } = noteStore.createNote(target, {
            onIdAssigned: (fromId, toId) => {
                setLocationOpenNoteIdByPanel((prev) => (
                    prev[panelKey] === fromId ? { ...prev, [panelKey]: toId } : prev
                ))
            },
        })
        setLocationOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: tempId }))
        setLocationNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
        setLocationDetailByPanel((prev) => ({ ...prev, [panelKey]: null }))
        setLocationDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: true }))
    }, [panels, selectedLocations, notesGenomeKeyFor, noteStore])

    const handleLocationNoteDelete = useCallback((panelKey, noteId) => {
        setLocationOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: '' }))
        setLocationNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: false }))
        noteStore.deleteNote(noteId)
    }, [noteStore])

    const handleLocationNotesPanelToggle = useCallback((panelKey) => {
        const opening = !locationNotesPanelOpenByPanel[panelKey]
        setLocationNotesPanelOpenByPanel((prev) => ({ ...prev, [panelKey]: !prev[panelKey] }))
        // One wide slot: opening the notes puts away whatever detail is in it.
        if (opening) setLocationDetailByPanel((prev) => ({ ...prev, [panelKey]: null }))
    }, [locationNotesPanelOpenByPanel])

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
                // A drawer hangs down from its band, so one lined up with a toolbar
                // moved to the bottom of a flipped panel had nowhere to go but out of
                // the panel. It opens from the top instead, still the toolbar's height.
                if (snapped && bar.getAttribute('data-browser-toolbar-position') === 'bottom') {
                    snapped.top = 0
                }
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
    }, [focusDrawerEntries, focusTranscriptViews, selectedLocations, findPanelScroller])

    // --- Assembly drawer ------------------------------------------------------
    //
    // The genome pill in a panel's toolbar toggles a drawer carrying what the
    // registry says about that assembly — the same fields the stats view lists.
    // The pill is a toggle and nothing else: it does not change colour or state,
    // so the drawer is the only thing that says whether it is out.
    const [assemblyDrawerOpenByPanel, setAssemblyDrawerOpenByPanel] = useState(() => (
        Object.fromEntries((Array.isArray(resumed?.openAssemblyDrawers) ? resumed.openAssemblyDrawers : []).map((key) => [key, true]))
    ))
    const [assemblyInfoByPanel, setAssemblyInfoByPanel] = useState({})

    // Offered to the session snapshot, which reads it only when one is taken. Fields are
    // written into one long-lived object so a render allocates nothing for this.
    const sessionStateRef = useRef({})
    Object.assign(sessionStateRef.current, {
        lockPan, lockZoom, hideInactiveMode, compressMode, flattenMode, biotypeFilter, linkedPanelKeys,
        focusDrawerOpenByPanel, locationDrawerOpenByPanel, assemblyDrawerOpenByPanel, selectedGenes, selectedLocations,
    })
    useEffect(() => {
        consumeRestoredSessionState('browser.view')
        return registerSessionState('browser.view', () => {
            const state = sessionStateRef.current
            const keysWhere = (byPanel, wanted) => Object.keys(byPanel || {}).filter((key) => byPanel[key] === wanted)
            // Only drawers with a focus behind them: the focus comes back with its panel,
            // and that is when the collapse is applied.
            const focusedGeneKeys = keysWhere(state.focusDrawerOpenByPanel, false).filter((key) => state.selectedGenes?.[key]?.id)
            const focusedLocationKeys = keysWhere(state.locationDrawerOpenByPanel, false).filter((key) => state.selectedLocations?.[key])
            return {
                lockPan: state.lockPan,
                lockZoom: state.lockZoom,
                hideInactiveMode: state.hideInactiveMode,
                compressMode: state.compressMode,
                flattenMode: state.flattenMode,
                biotypeFilter: state.biotypeFilter,
                linkedPanelKeys: state.linkedPanelKeys,
                linkModel: linkModelRef.current,
                // Collapsed drawers whose restored focus has not arrived yet are still
                // collapsed as far as the reader is concerned.
                closedFocusDrawers: [...new Set([...focusedGeneKeys, ...resumeClosedDrawersRef.current.focus])],
                closedLocationDrawers: [...new Set([...focusedLocationKeys, ...resumeClosedDrawersRef.current.location])],
                openAssemblyDrawers: keysWhere(state.assemblyDrawerOpenByPanel, true),
            }
        })
    }, [])

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
    const movePinAlignment = useCallback((...args) => movePinnedAlignment({ findPanelScroller, pinAnimationRef, setFocusDrawerPinOffset, stopPinAnimation }, ...args), [findPanelScroller, stopPinAnimation])

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
        // Either drawer covers the same strip of the panel, and only one of them
        // is ever out — the two focuses are mutually exclusive.
        if (selectedLocations[panelKey]) {
            return isLocationDrawerOpen(panelKey) ? FOCUS_DRAWER_WIDTH : FOCUS_DRAWER_RAIL_WIDTH
        }
        if (!focusDrawerEntries.some((entry) => entry.panelKey === panelKey)) return 0
        // Deliberately blind to the transcript detail. Someone reading metadata
        // is not reading the track, and re-framing the gene every time that
        // panel opens or closes would shuffle the browser under them for nothing.
        return isFocusDrawerOpen(panelKey) ? FOCUS_DRAWER_WIDTH : FOCUS_DRAWER_RAIL_WIDTH
    }, [focusDrawerEntries, isFocusDrawerOpen, selectedLocations, isLocationDrawerOpen])

    const anyFocusedGene = useMemo(() => {
        if (anyGeneSelected) return true
        if (anyLocationSelected) return true
        for (const gene of Object.values(externalFocusGenesByGenome || {})) {
            if (gene?.id || gene?.name) return true
        }
        return false
    }, [anyGeneSelected, anyLocationSelected, externalFocusGenesByGenome])
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

    const clearPendingLinkApply = useCallback((resetSource = true) => {
        if (linkApplyTimerRef.current) {
            window.clearTimeout(linkApplyTimerRef.current)
            linkApplyTimerRef.current = null
        }
        if (resetSource) syncSourcePanelKeyRef.current = ''
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

    const checkGenomeReady = useCallback((...args) => checkGenomeReadiness({ readyCheckAttemptsRef, readyCheckInFlightRef, setBrowserReadyState }, ...args), [])

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
                if (isHedgehogShh(panel.species, gene)) trackAchievement('browser.sonic')
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

    const applyLinkedGeneView = useCallback((...args) => applyLinkedGeneViewToPanels({
        clearPendingLinkApply,
        linkApplyTimerRef,
        linkModelRef,
        lockPanRef,
        lockZoomRef,
        panels,
        setLinkedPanelKeys,
        setLockPan,
        setLockZoom,
        setNavigateGenes,
        setPanelPositions,
    }, ...args), [panels, clearPendingLinkApply])

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
        // Input arrives before the next animation-frame broadcast. Keep the last
        // source excluded until that broadcast establishes the new source; clearing
        // it here can feed an old linked position back into the actively panned panel.
        clearPendingLinkApply(false)
    }, [clearPendingLinkApply])

    const flushPanelPositionChange = useCallback((...args) => flushLinkedPanelPositions({
        firstPanel,
        isOverlayActive,
        linkModelRef,
        linkedSet,
        lockPanRef,
        lockZoomRef,
        onRefViewportChange,
        panelActualPositionsRef,
        panels,
        setPanelPositions,
        syncSourcePanelKeyRef,
    }, ...args), [firstPanel, onRefViewportChange, isOverlayActive, linkedSet, panels])

    // Broadcast to the linked panels synchronously. The source panel already
    // coalesces its own pan/zoom to one update per animation frame, so deferring
    // again here bought nothing and cost a frame: the dragged genome committed in
    // frame N while every panel linked to it committed in frame N+1, which is
    // exactly the "tracks drift out of step" wobble during a drag. Updating in the
    // same tick lets React batch source and recipients into one render and paint.
    const handlePanelPositionChange = useCallback((panelKey, chrom, start, end, targetTrack, anchorRatio = null) => {
        flushPanelPositionChange(panelKey, chrom, start, end, targetTrack, anchorRatio)
    }, [flushPanelPositionChange])

    const handleLinkRegion = useCallback((...args) => linkPanelsByRegion({
        clearPendingLinkApply,
        fetchRegionsForPanel,
        firstPanel,
        linkModelRef,
        linkingRegion,
        lockPanRef,
        lockZoomRef,
        panelActualPositionsRef,
        panelCount,
        panels,
        setLinkedPanelKeys,
        setLinkingRegion,
        setLockPan,
        setLockZoom,
        setPanelPositions,
        syncSourcePanelKeyRef,
        tutorialEpochRef,
    }, ...args), [clearPendingLinkApply, fetchRegionsForPanel, firstPanel, linkingRegion, panelCount, panels])

    const handleLinkGene = useCallback((...args) => linkPanelsByGene({
        applyLinkedGeneView,
        externalFocusMap,
        hasPanels,
        linkModelRef,
        panels,
        selectedGenes,
        setLinkedPanelKeys,
        setLinkingGene,
        setSelectedGenes,
        tutorialEpochRef,
    }, ...args), [hasPanels, panels, selectedGenes, externalFocusMap, applyLinkedGeneView])

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
    const [allTrackGroups, setAllTrackGroups] = useState([])
    const [registryLoaded, setRegistryLoaded] = useState(false)
    const refreshRegisteredTracks = useCallback(() => {
        fetch(`${API_BASE}/api/tracks`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
                setAllRegisteredTracks(data.tracks || [])
                setAllTrackGroups(Array.isArray(data.groups) ? data.groups : [])
                setRegistryLoaded(true)
            })
            .catch(() => { })
    }, [])

    /* The custom tracks and groups each genome had open, remembered between sessions
     * (Configuration → General, on unless switched off). Read once; each panel reopens its
     * genome's when it first has the registry too, and reports what it has open after
     * that, which is saved a moment later. Switched off, nothing is read or saved and what
     * was saved is forgotten. Nothing is remembered during a tutorial: it lays out its own. */
    const rememberBrowserTracks = config?.remember_browser_tracks !== false
    const [sessionTracksByGenome, setSessionTracksByGenome] = useState(null)
    const pendingSessionSavesRef = useRef(new Map())
    useEffect(() => {
        let cancelled = false
        if (!rememberBrowserTracks) {
            setSessionTracksByGenome({})
            fetch(`${API_BASE}/api/browser/session-tracks`, { method: 'DELETE' }).catch(() => { })
            return undefined
        }
        fetch(`${API_BASE}/api/browser/session-tracks`)
            .then((r) => (r.ok ? r.json() : { genomes: {} }))
            .then((data) => { if (!cancelled) setSessionTracksByGenome(data?.genomes && typeof data.genomes === 'object' ? data.genomes : {}) })
            .catch(() => { if (!cancelled) setSessionTracksByGenome({}) })
        return () => { cancelled = true }
    }, [rememberBrowserTracks])

    const sendSessionTracks = useCallback((genomeKey, entries, keepalive = false) => {
        fetch(`${API_BASE}/api/browser/session-tracks`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ genome_key: genomeKey, entries }),
            keepalive,
        }).catch(() => { })
    }, [])

    const saveSessionTracks = useCallback((genomeKey, entries) => {
        setSessionTracksByGenome((prev) => ({ ...(prev || {}), [genomeKey]: { entries } }))
        const pending = pendingSessionSavesRef.current
        const previous = pending.get(genomeKey)
        if (previous) clearTimeout(previous.timer)
        const timer = setTimeout(() => {
            pending.delete(genomeKey)
            sendSessionTracks(genomeKey, entries)
        }, 600)
        pending.set(genomeKey, { timer, entries })
    }, [sendSessionTracks])

    // Closing the app inside that moment still saves.
    useEffect(() => {
        const pending = pendingSessionSavesRef.current
        const flush = () => {
            for (const [genomeKey, { timer, entries }] of pending) {
                clearTimeout(timer)
                sendSessionTracks(genomeKey, entries, true)
            }
            pending.clear()
        }
        window.addEventListener('beforeunload', flush)
        return () => {
            window.removeEventListener('beforeunload', flush)
            flush()
        }
    }, [sendSessionTracks])

    const sessionActive = rememberBrowserTracks && !tutorialRunning
    const sessionReady = sessionActive && registryLoaded && sessionTracksByGenome !== null
    // One stable callback per genome, so a panel's effect does not rerun on every render.
    const sessionHandlersRef = useRef(new Map())
    const sessionHandlerFor = useCallback((genomeKey) => {
        const handlers = sessionHandlersRef.current
        if (!handlers.has(genomeKey)) handlers.set(genomeKey, (entries) => saveSessionTracks(genomeKey, entries))
        return handlers.get(genomeKey)
    }, [saveSessionTracks])

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
                // By assembly: a track registered against one annotation release still
                // fits a panel showing another release of the same assembly.
                !track.genome_key || genomeKeysMatch(trackAssemblyKey(track.genome_key), panel.species)
            ))
        }
        return byPanel
    }, [allRegisteredTracks, panels])

    // A group belongs to one genome; a panel lists the groups for its assembly.
    const availableGroupsByPanel = useMemo(() => {
        const byPanel = {}
        for (const panel of panels) {
            byPanel[panel.key] = allTrackGroups.filter((group) => (
                group.genome_key && genomeKeysMatch(trackAssemblyKey(group.genome_key), panel.species)
            ))
        }
        return byPanel
    }, [allTrackGroups, panels])

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

    // Linked panels well off screen do not paint, but re-rendering one to follow
    // every frame of a pan still costs most of what a visible panel does. While
    // pan-locked, such a panel is held at its last position and caught up at most
    // every OFFSCREEN_LINK_INTERVAL_MS, which keeps its data loading along the way.
    // It goes back to live positions as soon as it is within the margin
    // useNearViewport wakes it at, so it is current before it is on screen.
    // Zoom-only lock is left live: it zooms each panel from where that panel last
    // reported being, and a held panel would report a stale position.
    const [farPanelKeys, setFarPanelKeys] = useState(EMPTY_FAR_PANELS)
    const [heldPanelPositions, setHeldPanelPositions] = useState(null)
    const panelPositionsRef = useRef(panelPositions)
    panelPositionsRef.current = panelPositions
    const heldPositionsTimerRef = useRef(null)
    const holdFarPanels = effectiveLockPan && farPanelKeys.size > 0

    const handlePanelNearViewportChange = useCallback((panelKey, near) => {
        setFarPanelKeys((prev) => {
            if (prev.has(panelKey) === !near) return prev
            const next = new Set(prev)
            if (near) next.delete(panelKey)
            else next.add(panelKey)
            return next
        })
    }, [])

    useEffect(() => {
        setHeldPanelPositions((prev) => {
            if (!holdFarPanels) return null
            const next = {}
            for (const key of farPanelKeys) {
                next[key] = prev && key in prev ? prev[key] : (panelPositionsRef.current[key] || null)
            }
            return next
        })
    }, [holdFarPanels, farPanelKeys])

    useEffect(() => {
        if (!heldPanelPositions || heldPositionsTimerRef.current !== null) return
        const stale = Object.keys(heldPanelPositions)
            .some((key) => heldPanelPositions[key] !== (panelPositions[key] || null))
        if (!stale) return
        // A throttle, not a debounce: a continuous pan must still catch up.
        heldPositionsTimerRef.current = window.setTimeout(() => {
            heldPositionsTimerRef.current = null
            setHeldPanelPositions((prev) => prev && Object.fromEntries(
                Object.keys(prev).map((key) => [key, panelPositionsRef.current[key] || null]),
            ))
        }, OFFSCREEN_LINK_INTERVAL_MS)
    }, [heldPanelPositions, panelPositions])

    useEffect(() => () => window.clearTimeout(heldPositionsTimerRef.current), [])

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

            // A dialog over the tracks scrolls itself; leave its events alone.
            if (isWheelInsideIsolatedOverlay(e)) return

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

    // Stable props let an unchanged genome skip parent updates (including every
    // frame reported by the primary genome). Keep normal shallow comparison:
    // changing a callback or any visual prop must still reach the panel.
    const panelCallbacks = useMemo(() => Object.fromEntries(panels.map(({ key: panelKey }) => [panelKey, {
        onOpenGeneNotes: (geneId) => handleOpenGeneNotes(panelKey, geneId),
        onGenomePillClick: () => handleGenomePillClick(panelKey),
        onTrackVisibilityChange: (hiddenStrands, meta) => handlePanelTrackVisibilityChange(panelKey, hiddenStrands, meta),
        onPositionChange: (chrom, start, end, targetTrack, anchorRatio) => handlePanelPositionChange(panelKey, chrom, start, end, targetTrack, anchorRatio),
        onContentHeightChange: (height) => handlePanelContentHeight(panelKey, height),
        onBrowsingTargetChange: (descriptor) => handleBrowsingTargetChange(panelKey, descriptor),
        onGeneSelect: (gene) => handlePanelGeneSelect(panelKey, gene),
        onLocationSelect: (location) => handlePanelLocationSelect(panelKey, location),
        onFocusTranscriptsChange: (payload) => handleFocusTranscriptsChange(panelKey, payload),
        onFocusTranscriptViewChange: (patch) => handleFocusTranscriptViewChange(panelKey, patch),
        onFocusRowGeometryChange: (geometry) => handleFocusRowGeometryChange(panelKey, geometry),
        onGeneTranscriptViewChange: (geneId, patch) => handleGeneTranscriptViewChange(panelKey, geneId, patch),
        onScreenshotTargetChange: (descriptor) => handleScreenshotTargetChange(panelKey, descriptor),
        onViewSync: (chrom, start, end) => { panelActualPositionsRef.current[panelKey] = { chrom, start, end } },
        onNearViewportChange: (near) => handlePanelNearViewportChange(panelKey, near),
    }])), [panels, handlePanelNearViewportChange,
        handleOpenGeneNotes, handleGenomePillClick, handlePanelTrackVisibilityChange,
        handlePanelPositionChange, handlePanelContentHeight, handleBrowsingTargetChange,
        handlePanelGeneSelect, handlePanelLocationSelect, handleFocusTranscriptsChange,
        handleFocusTranscriptViewChange, handleFocusRowGeometryChange,
        handleGeneTranscriptViewChange, handleScreenshotTargetChange,
    ])

    return (
        renderBrowserView({
            activePinPanelKey,
            adaptivePanelHeight,
            alignPanelToTop,
            alignmentOverlay,
            anyFocusedGene,
            assemblyDrawerAlignByPanel,
            assemblyDrawerOpenByPanel,
            assemblyInfoByPanel,
            availableGroupsByPanel,
            availableTracksByPanel,
            biotypeFilter,
            browserActionButtonStyle,
            browserReadyState,
            browserTracksRequest,
            browsingControls,
            clearFocusEpoch,
            clearPendingLinkApply,
            closeAssemblyDrawer,
            compressMode,
            config,
            controlsFollowScroll,
            cyclePreview,
            defaultScreenshotDir,
            detailListShiftByPanel,
            detailTranscriptByPanel,
            effectiveLockPan,
            effectiveLockZoom,
            externalFocusLocationsByGenome,
            fallbackBrowseRoot,
            farPanelKeys,
            fillSinglePanelHeight,
            flattenMode,
            focusDrawerAlignByPanel,
            focusDrawerEntries,
            focusDrawerInsetFor,
            focusDrawerPinOffset,
            focusDrawerStickyInset,
            focusTranscriptViews,
            forceTracksVisibility,
            geneTranscriptViews,
            globalTracksState,
            growingPanelStyle,
            handleClearFocusedGenes,
            handleClearPanelFocus,
            handleCyclePromote,
            handleDetailTranscriptChange,
            handleFocusTranscriptViewChange,
            handleGlobalTracksToggle,
            handleLinkGene,
            handleLinkRegion,
            handleLocationDetailChange,
            handleLocationDrawerFit,
            handleLocationFocusGene,
            handleLocationGeneHiddenToggle,
            handleLocationNoteCreate,
            handleLocationNoteDelete,
            handleLocationNotesPanelToggle,
            handleManualBrowserNavigate,
            handleNoteCreate,
            handleNoteDelete,
            handleNotesPanelToggle,
            handleOpenNoteChange,
            handleScreenshotModalClose,
            handleScreenshotSave,
            hasPanels,
            heldPanelPositions,
            hiddenBiotypeClasses,
            hideInactiveMode,
            holdFarPanels,
            incomingGene,
            incomingGeneError,
            isActive,
            isFeatureHiddenByClass,
            isFocusDrawerOpen,
            isLight,
            isLocationDrawerOpen,
            isOverlayActive,
            linkModelRef,
            linkedPanelKeys,
            linkingGene,
            linkingRegion,
            listedGenomes,
            locationDetailByPanel,
            locationDrawerFitByPanel,
            locationFeaturesByPanel,
            locationHiddenGenesByPanel,
            locationNoteSortByPanel,
            locationNotesByPanel,
            locationNotesPanelOpenByPanel,
            locationOpenNoteIdByPanel,
            lockPan,
            lockZoom,
            navigateGenes,
            noteCountsByPanel,
            noteSortByPanel,
            noteStore,
            notesByPanel,
            notesGenomeKeyFor,
            notesPanelOpenByPanel,
            onClearAlignmentOverlay,
            onPromoteGenome,
            onScreenshotModeChange,
            openNoteIdByPanel,
            panelCallbacks,
            panelClearEpochs,
            panelContentHeights,
            panelCount,
            panelMinHeight,
            panelPositions,
            panelSpecies,
            panels,
            panelsBottomSpacer,
            refReloadKey,
            refreshRegisteredTracks,
            resolveGenomeColor,
            retryGenomeIndex,
            screenshotMode,
            screenshotOverlayRootRef,
            screenshotPanelsRef,
            screenshotTargets,
            screenshotToggleButtonRef,
            scrollRailStops,
            selectedLocations,
            selectedScreenshotTarget,
            sessionActive,
            sessionHandlerFor,
            sessionReady,
            sessionTracksByGenome,
            setAdaptivePanelHeightOverride,
            setBiotypeFilter,
            setCompressMode,
            setControlsFollowScroll,
            setCyclePreview,
            setDetailTranscriptByPanel,
            setFlattenMode,
            setFocusDrawerOpenByPanel,
            setHideInactiveMode,
            setIncomingGeneError,
            setLinkedPanelKeys,
            setLocationDetailByPanel,
            setLocationDrawerOpenByPanel,
            setLocationFeaturesEpoch,
            setLocationNoteSortByPanel,
            setLocationNotesPanelOpenByPanel,
            setLocationOpenNoteIdByPanel,
            setLockPan,
            setLockZoom,
            setNoteSortByPanel,
            setNotesPanelOpenByPanel,
            setPanelPositions,
            setSelectedScreenshotTarget,
            sharedCanvasHeight,
            syncSourcePanelKeyRef,
            tgtReloadKey,
            theme,
            tutorialRunning,
            useAdaptivePanelHeight,
        })
    )
}
