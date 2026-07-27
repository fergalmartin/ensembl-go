import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import GenomeBrowser from './GenomeBrowser'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'

import { API_BASE } from '../backendRuntime'
import { getGenomeBrowserColor, normalizeGenomeBrowserColors } from '../genomeColorSchemes'
import useScreenshotTargets from '../hooks/useScreenshotTargets'
import { rasterizeSvgMarkup } from '../utils/screenshotExport'
import { getGenomeKey, genomeKeysMatch } from '../utils/genomeIdentity'
import { getGenomeBrowserPanelSizing } from './genomeBrowserViewportLayout'

const IndexPreparingNotice = ({ isLight, state, detail }) => {
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
    isActive = true,
    allowBackgroundPrep = false,
    onToggleSpecies,
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
    onGeneFocusByGenomeChange = null,
    onClearFocusedGenes = null,
    screenshotMode = false,
    onScreenshotModeChange = null,
    onScreenshotAvailabilityChange = null,
    screenshotToggleButtonRef = null,
}) {
    const [lockPan, setLockPan] = useState(false)
    const [lockZoom, setLockZoom] = useState(false)

    const [globalTracksState, setGlobalTracksState] = useState('on')
    const [forceTracksVisibility, setForceTracksVisibility] = useState(undefined)
    const [hideInactiveMode, setHideInactiveMode] = useState(false)
    const [compressMode, setCompressMode] = useState(false)
    const [flattenMode, setFlattenMode] = useState(false)
    const [adaptivePanelHeight, setAdaptivePanelHeight] = useState(false)
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

    const tracksStateRef = useRef({})
    const linkModelRef = useRef(null)
    const linkApplyTimerRef = useRef(null)
    const wasActiveRef = useRef(isActive)
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

    const genomeBrowserColors = useMemo(
        () => normalizeGenomeBrowserColors(config?.genome_browser_colors),
        [config?.genome_browser_colors]
    )

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

    const checkGenomeReady = useCallback(async (panel) => {
        const panelKey = panel.key
        const updateState = (state, detail = '') => {
            setBrowserReadyState((prev) => {
                const current = prev?.[panelKey]
                if (current?.state === 'ready' && (state === 'checking' || state === 'pending')) {
                    return prev
                }
                return {
                    ...prev,
                    [panelKey]: { state, detail },
                }
            })
        }

        updateState('checking')
        try {
            const res = await fetch(`${API_BASE}/api/browse/regions?genome=${encodeURIComponent(panel.genomeParam)}`)
            if (res.ok) {
                const data = await res.json()
                if (Array.isArray(data) && data.length > 0) {
                    updateState('ready')
                    return 'ready'
                }
                updateState('pending')
                return 'pending'
            }

            let detail = ''
            try {
                const err = await res.json()
                detail = err?.detail || ''
            } catch {
                detail = ''
            }

            if (res.status === 409) {
                updateState('error', detail)
                return 'error'
            }

            if (res.status === 404) {
                updateState('pending')
                return 'pending'
            }

            updateState('pending', detail)
            return 'pending'
        } catch {
            updateState('pending')
            return 'pending'
        }
    }, [])

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

        const pollPanel = async (panel) => {
            const status = await checkGenomeReady(panel)
            if (cancelled || status === 'ready' || status === 'error') return
            const timer = window.setTimeout(() => {
                pollPanel(panel)
            }, 1500)
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
            const shouldCheck = isNewPanel || paramChanged || forceReloadCheck || needsRetry
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

    // Fallback: when any panel is still 'pending', re-poll every 5s regardless of other triggers.
    // Guards against the case where the main mechanism (refReloadKey change) is missed.
    useEffect(() => {
        if (!canPrepareBrowser) return undefined
        if (!hasPanels) return undefined
        const id = setInterval(() => {
            for (const panel of panels) {
                const state = browserReadyStateRef.current?.[panel.key]?.state
                if (state === 'pending' || state === 'checking') {
                    checkGenomeReady(panel)
                }
            }
        }, 5000)
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
        const fivePrimeRatio = anchorGene?.strand === '-' ? 0.75 : 0.25

        const spanForGene = (gene) => {
            const start = Number(gene.start)
            const end = Number(gene.end)
            const len = Math.max(1, Math.abs(end - start))
            const roomFraction = gene?.strand === '+' ? (1 - fivePrimeRatio) : fivePrimeRatio
            return len / Math.max(0.1, roomFraction)
        }

        let requiredSpan = 0
        for (const panel of validPanels) {
            requiredSpan = Math.max(requiredSpan, spanForGene(genesByPanelKey[panel.key]))
        }
        const span = Math.max(2000, requiredSpan * 1.12)

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
                start: windowStart,
                end: windowEnd,
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
        if (!(lockPanRef.current || lockZoomRef.current || isOverlayActive)) return

        // Keep the ref up-to-date with the source panel's actual position.
        panelActualPositionsRef.current[panelKey] = { chrom, start, end }
        syncSourcePanelKeyRef.current = panelKey

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

    const pendingPanelPositionChangeRef = useRef(null)
    const panelPositionFrameRef = useRef(null)
    const handlePanelPositionChange = useCallback((panelKey, chrom, start, end, targetTrack, anchorRatio = null) => {
        pendingPanelPositionChangeRef.current = [panelKey, chrom, start, end, targetTrack, anchorRatio]
        if (panelPositionFrameRef.current !== null) return
        panelPositionFrameRef.current = requestAnimationFrame(() => {
            panelPositionFrameRef.current = null
            const pending = pendingPanelPositionChangeRef.current
            pendingPanelPositionChangeRef.current = null
            if (pending) flushPanelPositionChange(...pending)
        })
    }, [flushPanelPositionChange])

    useEffect(() => () => {
        if (panelPositionFrameRef.current !== null) {
            cancelAnimationFrame(panelPositionFrameRef.current)
            panelPositionFrameRef.current = null
        }
        pendingPanelPositionChangeRef.current = null
    }, [])

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

            if (linkedKeys.length < 2) return

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

    const panelSizing = getGenomeBrowserPanelSizing(panelCount, adaptivePanelHeight)
    const useAdaptivePanelHeight = panelSizing.usesContentHeight
    const fillSinglePanelHeight = panelSizing.fillsAvailableHeight
    const panelHeight = panelSizing.fixedPanelHeight

    return (
        <div
            ref={screenshotOverlayRootRef}
            className={`relative w-full flex flex-col ${fillSinglePanelHeight ? 'h-full min-h-0' : ''}`}
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
                className="flex items-center justify-between px-4 py-2 border-b flex-none"
                style={{
                    backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
                    borderColor: isLight ? '#dee2e6' : '#373a40',
                }}
            >
                <div className="flex items-center gap-2">
                    {hasPanels && (
                        <>
                            <button
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
                                onClick={() => setAdaptivePanelHeight((prev) => !prev)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, useAdaptivePanelHeight)}
                                title="Toggles adaptive browser track height for multi-genome browsing"
                            >
                                Adaptive
                            </button>

                            <button
                                onClick={() => setHideInactiveMode((prev) => !prev)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, hideInactiveMode)}
                                title={hideInactiveMode
                                    ? 'Show inactive tracks in browser'
                                    : 'Hide inactive tracks from view as they are turned off'}
                            >
                                Hide
                            </button>

                            <button
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
                                        onClick={handleClearFocusedGenes}
                                        disabled={!anyFocusedGene}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(anyFocusedGene, anyFocusedGene, { emphasizeWhenEnabled: true })}
                                        title="Clear all focused genes across genomes"
                                    >
                                        Unfocus
                                    </button>

                                    <button
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
                                        <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'auto auto', fontSize: '10px', lineHeight: '1.35' }}>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input type="checkbox" checked={biotypeFilter.proteinCoding} onChange={() => toggle('proteinCoding')} style={chkStyle} />
                                                Protein-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input type="checkbox" checked={biotypeFilter.lncRNA} onChange={() => toggle('lncRNA')} style={chkStyle} />
                                                Long non-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input type="checkbox" checked={biotypeFilter.pseudogene} onChange={() => toggle('pseudogene')} style={chkStyle} />
                                                Pseudogene
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input type="checkbox" checked={biotypeFilter.smallNonCoding} onChange={() => toggle('smallNonCoding')} style={chkStyle} />
                                                Small non-coding
                                            </label>
                                        </div>
                                    </>
                                )
                            })()}
                        </>
                    )}
                </div>
            </div>

            <div
                ref={screenshotPanelsRef}
                className={`relative w-full flex flex-col ${fillSinglePanelHeight ? 'flex-1 min-h-0' : 'min-h-[220px]'} ${!hasPanels ? (isLight ? 'bg-white opacity-95' : 'bg-[#1E2938]') : ''}`}
            >
                {!hasPanels ? (
                    <div className="h-full w-full flex flex-col items-center justify-center p-6 bg-transparent">
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
                        const isReady = panelReady === 'ready' || panelReady === 'idle'
                        const panelReloadKey = panel.alignmentRole === 'reference'
                            ? refReloadKey
                            : (panel.alignmentRole === 'target' ? tgtReloadKey : 0)

                        return (
                            <div
                                key={panelKey}
                                className={`w-full flex flex-col ${fillSinglePanelHeight ? 'flex-1 min-h-0' : ''}`}
                            >
                                {idx > 0 && (
                                    <div className="w-full flex-none" style={{ height: '2px', backgroundColor: isLight ? '#adb5bd' : '#373a40' }} />
                                )}
                                <div
                                    className={`w-full flex flex-col ${useAdaptivePanelHeight ? 'overflow-visible' : 'overflow-hidden'}`}
                                    style={useAdaptivePanelHeight
                                        ? {
                                            minHeight: 0,
                                            height: 'auto',
                                        }
                                        : {
                                            minHeight: fillSinglePanelHeight ? 0 : (panelHeight || 220),
                                            height: fillSinglePanelHeight ? '100%' : (panelHeight || '100%'),
                                        }}
                                >
                                    {isReady ? (
                                        <GenomeBrowser
                                            key={panelKey}
                                            isActive={isActive}
                                            genome={panel.genomeParam}
                                            alignmentRole={panel.alignmentRole}
                                            reloadEpoch={panelReloadKey}
                                            theme={theme}
                                            label={panel.label}
                                            genomePillLabel={panel.genomePillLabel}
                                            genomeColor={getGenomeBrowserColor(genomeBrowserColors, panel.index)}
                                            onGenomePillClick={onToggleSpecies ? () => onToggleSpecies(panel.species) : null}
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
                                            externalPosition={
                                                (effectiveLockPan || effectiveLockZoom) && syncSourcePanelKeyRef.current !== panelKey
                                                    ? (panelPositions[panelKey] || null)
                                                    : null
                                            }
                                            lockPan={effectiveLockPan}
                                            lockZoom={effectiveLockZoom}
                                            onGeneSelect={(gene) => setSelectedGenes((prev) => ({ ...prev, [panelKey]: gene || null }))}
                                            navigateToGene={navigateGenes[panelKey] || null}
                                            onManualNavigate={handleManualBrowserNavigate}
                                            clearFocusEpoch={clearFocusEpoch}
                                            screenshotTargetId={panelKey}
                                            onScreenshotTargetChange={(descriptor) => handleScreenshotTargetChange(panelKey, descriptor)}
                                        />
                                    ) : (
                                        <IndexPreparingNotice
                                            isLight={isLight}
                                            state={panelReady}
                                            detail={panelDetail}
                                        />
                                    )}
                                </div>
                            </div>
                        )
                    })
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
