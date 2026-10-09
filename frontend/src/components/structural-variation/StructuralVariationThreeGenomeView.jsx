import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { resolveGenomeColor } from '../../genomeColorSchemes.js'
import useDelayedFlag from '../../hooks/useDelayedFlag.js'
import { beginWheelGesture, findNearestScrollable, markWheelHandled, readWheelEvent, resolveDragAxis, resolveWheelAction } from '../../utils/browsingControls.js'
import { resolveSvFeatureTrackGenomeIds, resolveSvFeatureWindowChrom } from '../../utils/svFeatureTrackIdentity.js'
import { createSvRequestError, isRetryableSvRequestError, shouldStartSvRequest } from '../../utils/svRequestRetry.js'
import StructuralVariationFeatureBand from '../StructuralVariationFeatureBand'
import { buildBrowserGeneSeedKey, buildBrowserViewportSeedKey, resolveAnchorRegionSeed, shouldSeedFromBrowser, shouldSeedFromBrowserViewport } from '../svViewportSeeding.js'
import { StructuralVariationRibbonOverlay } from './StructuralVariationRibbonOverlay'
import { StructuralVariationSignalTracks } from './StructuralVariationSignalTracks'
import { ALIGNMENT_PANEL_COMPACT_HEIGHT, ALIGNMENT_PANEL_HEIGHT, BUFFER_MARGIN_RATIO, BUFFER_PAD_MIN, BUFFER_PAD_RATIO, PLOT_PAD_X, SV_AUX_TRACK_CACHE_VERSION, SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS, SV_TRANSIENT_RETRY_LIMIT, SV_TRIO_DEFAULT_REF_WINDOW, WHEEL_COMMIT_DEBOUNCE_MS } from './svConstants.js'
import { buildSvRuntimeEndpoint, clamp, formatBp, formatCoord, getSvLoadingMode, getSvRuntimeAssembly, getSvTransientRetryDelay, updateObjectSlot } from './svFormat.js'
import { CenterAlignmentIcon, SelectionZoomIcon } from './svIcons'
import { getSvDataTracksForSide, getSvSignalTracksForSide } from './svTracks.js'
import { buildCenteredTargetWindow, buildChromWindow, buildWindowForAnchorRegion, centerWindowOnRange, constrainWindowToZoomLimits, deriveAutoTargetWindowFromBuffer, getResolvedChromSize, getSvRegionKey, getWindowKey, normalizeSvChromToken, panWindowByPixels, quantizeCeil, quantizeFloor, svBlocksToFeatureBandAlignments, svBufferMatchesAlignment, svBufferMatchesRefWindow, transformOuterWindowFromReferenceChange, withWindowChrom, zoomWindowAround } from './svWindows.js'
import { useBrowsingControls } from './useSvBrowsingControls.js'

// ── Component ─────────────────────────────────────────────────────────────────
export function StructuralVariationThreeGenomeView({
  theme = 'dark',
  config,
  refSpecies,
  tgtSpecies,
  thirdSpecies,
  thirdGenomeId = '',
  refPillLabel = '',
  tgtPillLabel = '',
  thirdPillLabel = '',
  browserRefGene = null,
  browserRefViewport = null,
  selectedTopAlignmentId = '',
  selectedBottomAlignmentId = '',
  selectedAnchorRegion = null,
  outputDir = '',
  savedViewportRef = null,
}) {
  const isLight = theme === 'light'
  const svLoadingMode = useMemo(() => getSvLoadingMode(), [])

  // Restore saved viewport if assemblies still match (handles view-switch persistence; mismatched
  // assemblies mean a genome changed, in which case we fall back to normal seeding behaviour)
  const restoredViewport = (() => {
    const saved = savedViewportRef?.current
    if (!saved?.refWindow) return null
    if (getSvRuntimeAssembly(refSpecies) !== saved.refAssembly) return null
    if (getSvRuntimeAssembly(tgtSpecies) !== saved.topAssembly) return null
    return {
      refWindow: saved.refWindow,
      topWindow: saved.topWindow || null,
      bottomWindow: getSvRuntimeAssembly(thirdSpecies) === saved.bottomAssembly ? (saved.bottomWindow || null) : null,
      seededRegionKey: saved.seededRegionKey || '',
      seededBrowserKey: saved.seededBrowserKey || '',
      regionSeedBrowserKey: saved.regionSeedBrowserKey || '',
    }
  })()

  const bandSvgRef = useRef(null)
  const interactiveAreaRef = useRef(null)
  const upperAlignmentsRef = useRef(null)
  const lowerAlignmentsRef = useRef(null)
  const upperPanelRef = useRef(null)
  const lowerPanelRef = useRef(null)
  const topFeatureBandRef = useRef(null)
  const middleFeatureBandRef = useRef(null)
  const bottomFeatureBandRef = useRef(null)
  const wheelCommitTimerRef = useRef(null)
  const featureBandDragRef = useRef(null)
  const selectionDragRef = useRef(null)
  const upperFetchTokenRef = useRef(0)
  const lowerFetchTokenRef = useRef(0)
  const upperBufferDataRef = useRef(null)
  const lowerBufferDataRef = useRef(null)
  const upperAbortRef = useRef(null)
  const lowerAbortRef = useRef(null)
  const upperLastFetchKeyRef = useRef('')
  const lowerLastFetchKeyRef = useRef('')
  const upperInFlightFetchKeyRef = useRef('')
  const lowerInFlightFetchKeyRef = useRef('')
  const bufferRetryRef = useRef({
    top: { key: '', attempt: 0, timer: null },
    bottom: { key: '', attempt: 0, timer: null },
  })
  const seededAnchorRegionKeyRef = useRef(restoredViewport?.seededRegionKey || '')
  // What the genome browser last seeded this view with. Restored alongside the
  // viewport so a remount does not re-seed from an unchanged browser position.
  const seededBrowserKeyRef = useRef(restoredViewport?.seededBrowserKey || '')
  // The browser seed that was in force when the anchor region was last applied,
  // so the two can be told apart when they disagree.
  const regionSeedBrowserKeyRef = useRef(restoredViewport?.regionSeedBrowserKey || '')
  // Caps drift recovery at one attempt per region, so a chromosome name that
  // never compares equal cannot re-apply the region forever.
  const driftRecoveredRegionKeyRef = useRef('')
  // Whether this mount restored a viewport. Latched for the lifetime of the
  // mount: the browser's viewport must never override what the user was last
  // looking at here, however long they spent in the genome browser in between.
  const hadRestoredViewportRef = useRef(Boolean(restoredViewport?.refWindow))
  const featureTrackCacheRef = useRef({ reference: null, top: null, bottom: null })
  const featureTrackTokenRef = useRef({ reference: 0, top: 0, bottom: 0 })
  const featureTrackAbortRef = useRef({ reference: null, top: null, bottom: null })
  const featureTrackRetryRef = useRef({
    reference: { key: '', attempt: 0, timer: null },
    top: { key: '', attempt: 0, timer: null },
    bottom: { key: '', attempt: 0, timer: null },
  })
  const displayRefWindowRef = useRef(null)
  const displayTopWindowRef = useRef(null)
  const displayBottomWindowRef = useRef(null)
  const refChromSizeRef = useRef(null)
  const topChromSizeRef = useRef(null)
  const bottomChromSizeRef = useRef(null)
  const wheelSessionRef = useRef({ gesture: null })
  const browsingControls = useBrowsingControls(config)
  const browsingControlsRef = useRef(browsingControls)
  useEffect(() => { browsingControlsRef.current = browsingControls }, [browsingControls])
  const prevBottomAlignmentIdRef = useRef('')
  const previewFrameRef = useRef(null)
  const pendingPreviewRef = useRef({ ref: null, top: null, bottom: null })
  const externalViewportInteractionRef = useRef({ dragging: false, activeUntil: 0 })

  const [panelWidth, setPanelWidth] = useState(0)
  const [upperBufferData, setUpperBufferData] = useState(null)
  const [lowerBufferData, setLowerBufferData] = useState(null)
  const [upperBufferLoading, setUpperBufferLoading] = useState(false)
  const [lowerBufferLoading, setLowerBufferLoading] = useState(false)
  const [error, setError] = useState(null)
  const [statusText, setStatusText] = useState('')
  const [viewRefWindow, setViewRefWindow] = useState(restoredViewport?.refWindow || null)
  const [viewTopWindow, setViewTopWindow] = useState(restoredViewport?.topWindow || null)
  const [viewBottomWindow, setViewBottomWindow] = useState(restoredViewport?.bottomWindow || null)
  const [previewRefWindow, setPreviewRefWindow] = useState(null)
  const [previewTopWindow, setPreviewTopWindow] = useState(null)
  const [previewBottomWindow, setPreviewBottomWindow] = useState(null)
  const [featureTrackData, setFeatureTrackData] = useState({ reference: [], top: [], bottom: [] })
  const [featureTrackLoading, setFeatureTrackLoading] = useState({ reference: false, top: false, bottom: false })
  const [alignmentTrackLoading, setAlignmentTrackLoading] = useState({ top: false, bottom: false })
  // Panning and zooming refetch constantly, and most of those land in a few tens
  // of milliseconds — often for data outside the current window. Debounced so a
  // spinner only appears for work slow enough to be worth reporting.
  const showUpperAlignmentLoading = useDelayedFlag(upperBufferLoading || alignmentTrackLoading.top)
  const showLowerAlignmentLoading = useDelayedFlag(lowerBufferLoading || alignmentTrackLoading.bottom)
  const showTopGenesLoading = useDelayedFlag(featureTrackLoading.top)
  const showReferenceGenesLoading = useDelayedFlag(featureTrackLoading.reference)
  const showBottomGenesLoading = useDelayedFlag(featureTrackLoading.bottom)
  const [hideInactiveFeatureTracks, setHideInactiveFeatureTracks] = useState(Boolean(config?.sv_hide_inactive_tracks))
  const [compactTracks, setCompactTracks] = useState(false)
  const [showBigWigTracks, setShowBigWigTracks] = useState(false)
  const [showBigBedTracks, setShowBigBedTracks] = useState(false)
  const alignmentPanelHeight = compactTracks ? ALIGNMENT_PANEL_COMPACT_HEIGHT : ALIGNMENT_PANEL_HEIGHT
  const [isBoxSelectMode, setIsBoxSelectMode] = useState(false)
  const [isSelectingRect, setIsSelectingRect] = useState(false)
  const [selectionRect, setSelectionRect] = useState(null)

  useEffect(() => { upperBufferDataRef.current = upperBufferData }, [upperBufferData])
  useEffect(() => { lowerBufferDataRef.current = lowerBufferData }, [lowerBufferData])
  useEffect(() => () => {
    if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
    if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current)
    upperAbortRef.current?.abort?.()
    lowerAbortRef.current?.abort?.()
    if (bufferRetryRef.current.top.timer) clearTimeout(bufferRetryRef.current.top.timer)
    if (bufferRetryRef.current.bottom.timer) clearTimeout(bufferRetryRef.current.bottom.timer)
    featureTrackAbortRef.current.reference?.abort?.()
    featureTrackAbortRef.current.top?.abort?.()
    featureTrackAbortRef.current.bottom?.abort?.()
    if (featureTrackRetryRef.current.reference.timer) clearTimeout(featureTrackRetryRef.current.reference.timer)
    if (featureTrackRetryRef.current.top.timer) clearTimeout(featureTrackRetryRef.current.top.timer)
    if (featureTrackRetryRef.current.bottom.timer) clearTimeout(featureTrackRetryRef.current.bottom.timer)
    externalViewportInteractionRef.current = { dragging: false, activeUntil: 0 }
  }, [])

  const refAssembly = getSvRuntimeAssembly(refSpecies)
  const topAssembly = getSvRuntimeAssembly(tgtSpecies)
  const bottomAssembly = getSvRuntimeAssembly(thirdSpecies)
  const featureTrackGenomeIds = useMemo(() => resolveSvFeatureTrackGenomeIds({
    referenceSpecies: refSpecies,
    topSpecies: tgtSpecies,
    bottomSpecies: thirdSpecies,
    bottomGenomeId: thirdGenomeId,
  }), [refSpecies, tgtSpecies, thirdSpecies, thirdGenomeId])
  const referenceBrowseGenomeId = featureTrackGenomeIds.reference
  const topBrowseGenomeId = featureTrackGenomeIds.top
  const bottomBrowseGenomeId = featureTrackGenomeIds.bottom

  const themeClasses = {
    panel: isLight ? 'bg-white border border-gray-200 text-gray-900' : 'bg-[#1E2938] border border-gray-700 text-gray-100',
    muted: isLight ? 'text-gray-600' : 'text-gray-400',
  }

  // As in the pair view: colour follows the genome, not the row it sits in.
  const referenceGenomeColor = useMemo(() => resolveGenomeColor(config, refSpecies), [config, refSpecies])
  const topGenomeColor = useMemo(() => resolveGenomeColor(config, tgtSpecies), [config, tgtSpecies])
  const bottomGenomeColor = useMemo(() => resolveGenomeColor(config, thirdSpecies), [config, thirdSpecies])

  const runtimeOutputDir = outputDir || config?.output_dir || ''
  const upperEndpointsRef = useRef({
    alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedTopAlignmentId, runtimeOutputDir),
    variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedTopAlignmentId, runtimeOutputDir),
    genomeBrowser: '',
  })
  const upperEndpointsKeyRef = useRef(`${selectedTopAlignmentId}|${runtimeOutputDir}`)
  const lowerEndpointsRef = useRef({
    alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedBottomAlignmentId, runtimeOutputDir),
    variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedBottomAlignmentId, runtimeOutputDir),
    genomeBrowser: '',
  })
  const lowerEndpointsKeyRef = useRef(`${selectedBottomAlignmentId}|${runtimeOutputDir}`)
  const getUpperRuntimeEndpoints = useCallback(() => {
    const nextKey = `${selectedTopAlignmentId}|${runtimeOutputDir}`
    if (upperEndpointsKeyRef.current !== nextKey) {
      upperEndpointsKeyRef.current = nextKey
      upperEndpointsRef.current = {
        alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedTopAlignmentId, runtimeOutputDir),
        variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedTopAlignmentId, runtimeOutputDir),
        genomeBrowser: '',
      }
    }
    return upperEndpointsRef.current
  }, [selectedTopAlignmentId, runtimeOutputDir])
  const getLowerRuntimeEndpoints = useCallback(() => {
    const nextKey = `${selectedBottomAlignmentId}|${runtimeOutputDir}`
    if (lowerEndpointsKeyRef.current !== nextKey) {
      lowerEndpointsKeyRef.current = nextKey
      lowerEndpointsRef.current = {
        alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedBottomAlignmentId, runtimeOutputDir),
        variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedBottomAlignmentId, runtimeOutputDir),
        genomeBrowser: '',
      }
    }
    return lowerEndpointsRef.current
  }, [selectedBottomAlignmentId, runtimeOutputDir])
  useEffect(() => {
    getUpperRuntimeEndpoints()
  }, [getUpperRuntimeEndpoints])
  useEffect(() => {
    getLowerRuntimeEndpoints()
  }, [getLowerRuntimeEndpoints])

  useEffect(() => {
    setHideInactiveFeatureTracks(Boolean(config?.sv_hide_inactive_tracks))
  }, [config?.sv_hide_inactive_tracks])

  useEffect(() => {
    const node = bandSvgRef.current
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      const nextWidth = Math.max(760, Math.round(rect.width))
      setPanelWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (selectedAnchorRegion?.chrom) return
    if (viewRefWindow) return
    setStatusText('')
    setViewRefWindow(constrainWindowToZoomLimits(SV_TRIO_DEFAULT_REF_WINDOW))
  }, [viewRefWindow, selectedAnchorRegion?.chrom])

  useEffect(() => {
    if (!selectedAnchorRegion?.chrom) return
    const regionKey = `${selectedTopAlignmentId}|${getSvRegionKey(selectedAnchorRegion)}|${selectedAnchorRegion?.start || ''}-${selectedAnchorRegion?.end || ''}`

    // Normally this only runs when the selected region changes. It also re-runs
    // when the view has drifted onto a different chromosome from the one the
    // region selector is showing, which is otherwise an inescapable state: the
    // region is already "applied", so re-picking it does nothing, and the view
    // keeps reporting an error about a chromosome the user never chose.
    //
    // Deliberately NOT applied when the genome browser seeded the view after
    // the region was applied — navigating the browser to another locus and then
    // opening this view is meant to follow the browser.
    const seedReason = resolveAnchorRegionSeed({
      regionKey,
      seededRegionKey: seededAnchorRegionKeyRef.current,
      regionChrom: normalizeSvChromToken(selectedAnchorRegion.chrom),
      windowChrom: normalizeSvChromToken(viewRefWindow?.chrom),
      seededBrowserKey: seededBrowserKeyRef.current,
      regionSeedBrowserKey: regionSeedBrowserKeyRef.current,
      driftRecoveredKey: driftRecoveredRegionKeyRef.current,
    })
    if (!seedReason) return
    if (seedReason === 'drift') driftRecoveredRegionKeyRef.current = regionKey

    let cancelled = false
    const applyAnchorRegion = async () => {
      const next = await buildWindowForAnchorRegion(
        selectedAnchorRegion,
        upperBufferData?.ref_chrom_sizes || lowerBufferData?.ref_chrom_sizes || {},
        viewRefWindow,
        refChromSizeRef.current,
      )
      if (cancelled || !next) return
      seededAnchorRegionKeyRef.current = regionKey
      regionSeedBrowserKeyRef.current = seededBrowserKeyRef.current
      setStatusText('')
      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current)
        wheelCommitTimerRef.current = null
      }
      setViewRefWindow(next)
      setViewTopWindow(null)
      setViewBottomWindow(null)
      setPreviewRefWindow(null)
      setPreviewTopWindow(null)
      setPreviewBottomWindow(null)
    }
    applyAnchorRegion()
    return () => { cancelled = true }
  }, [
    selectedTopAlignmentId,
    selectedAnchorRegion,
    selectedAnchorRegion?.chrom,
    upperBufferData?.ref_chrom_sizes,
    lowerBufferData?.ref_chrom_sizes,
    viewRefWindow,
  ])

  // Seed from the genome browser's focused gene.
  //
  // Guarded by a key that SURVIVES REMOUNTS via savedViewportRef. Without that,
  // navigating away and back re-ran this effect and silently replaced the
  // restored region with wherever the genome browser happened to be — usually
  // chromosome 1 — while the region selector still displayed the old region.
  // The third genome then failed with "reference chromosome '1' is not aligned"
  // and never recovered, because the anchor-region seeder below considers the
  // region already applied.
  useEffect(() => {
    if (!browserRefGene?.chrom) return
    const key = buildBrowserGeneSeedKey(browserRefGene)
    if (!shouldSeedFromBrowser({ seededKey: seededBrowserKeyRef.current, candidateKey: key })) return
    seededBrowserKeyRef.current = key
    const geneSpan = Math.max(1, (browserRefGene.end || 0) - (browserRefGene.start || 0))
    const span = clamp(Math.round(geneSpan * 8), 120_000, 5_000_000)
    const center = Math.round(((browserRefGene.start || 0) + (browserRefGene.end || 0)) / 2)
    const next = centerWindowOnRange(browserRefGene.chrom, center, span, refChromSizeRef.current, 1)
    setViewRefWindow(next)
    setViewTopWindow(null)
    setViewBottomWindow(null)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [browserRefGene])

  // Seed from the genome browser's viewport. Same remount-surviving guard.
  useEffect(() => {
    if (browserRefGene?.chrom) return
    if (!browserRefViewport?.chrom || !Number.isFinite(browserRefViewport.start) || !Number.isFinite(browserRefViewport.end)) return
    if (browserRefViewport.end <= browserRefViewport.start) return
    const key = buildBrowserViewportSeedKey(browserRefViewport)
    if (!shouldSeedFromBrowserViewport({
      seededKey: seededBrowserKeyRef.current,
      candidateKey: key,
      hasRestoredViewport: hadRestoredViewportRef.current,
    })) return
    seededBrowserKeyRef.current = key
    const next = constrainWindowToZoomLimits({
      chrom: browserRefViewport.chrom,
      start: Math.max(1, Math.round(browserRefViewport.start)),
      end: Math.max(Math.max(1, Math.round(browserRefViewport.start)) + 1, Math.round(browserRefViewport.end)),
    }, refChromSizeRef.current)
    setViewRefWindow(next)
    setViewTopWindow(null)
    setViewBottomWindow(null)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [browserRefGene, browserRefViewport])

  const fetchPairBufferData = useCallback(async (slot, tgtAssemblyValue, refWindow, targetBrowseGenome = 'target', alignmentId = '') => {
    if (!refWindow?.chrom) return

    const refSpan = Math.max(1, refWindow.end - refWindow.start)
    const refPad = Math.max(BUFFER_PAD_MIN, Math.round(refSpan * BUFFER_PAD_RATIO))
    const refStep = Math.max(20_000, Math.round(refSpan * 0.12))
    const reqRefStart = Math.max(1, quantizeFloor(refWindow.start - refPad, refStep))
    const reqRefEnd = quantizeCeil(refWindow.end + refPad, refStep)

    const params = new URLSearchParams({
      ref_assembly: refAssembly,
      tgt_assembly: tgtAssemblyValue,
      ref_chrom: refWindow.chrom,
      ref_start: String(reqRefStart),
      ref_end: String(reqRefEnd),
      ref_browse_genome: referenceBrowseGenomeId,
      tgt_browse_genome: targetBrowseGenome || 'target',
      max_blocks: '200',
    })
    if (alignmentId) params.set('alignment_id', alignmentId)
    if (runtimeOutputDir) params.set('output_dir', runtimeOutputDir)

    const fetchKey = params.toString()
    const tokenRef = slot === 'top' ? upperFetchTokenRef : lowerFetchTokenRef
    const abortRef = slot === 'top' ? upperAbortRef : lowerAbortRef
    const lastFetchKeyRef = slot === 'top' ? upperLastFetchKeyRef : lowerLastFetchKeyRef
    const inFlightFetchKeyRef = slot === 'top' ? upperInFlightFetchKeyRef : lowerInFlightFetchKeyRef
    const retryState = bufferRetryRef.current[slot]
    const setLoadingState = slot === 'top' ? setUpperBufferLoading : setLowerBufferLoading
    const setDataState = slot === 'top' ? setUpperBufferData : setLowerBufferData

    if (retryState.key !== fetchKey) {
      if (retryState.timer) clearTimeout(retryState.timer)
      retryState.key = fetchKey
      retryState.attempt = 0
      retryState.timer = null
    }
    if (!shouldStartSvRequest({
      fetchKey,
      lastFetchKey: lastFetchKeyRef.current,
      inFlightFetchKey: inFlightFetchKeyRef.current,
      retryScheduled: Boolean(retryState.timer),
    })) return

    const token = ++tokenRef.current
    inFlightFetchKeyRef.current = fetchKey
    abortRef.current?.abort?.()
    const abortController = new AbortController()
    abortRef.current = abortController
    setLoadingState(true)

    try {
      const res = await fetch(`${API_BASE}/api/sv/view?${fetchKey}`, { signal: abortController.signal })
      const data = await res.json().catch(() => null)
      if (token !== tokenRef.current) return
      if (!res.ok) {
        throw createSvRequestError(data?.detail || `SV request failed (${res.status})`, {
          status: res.status,
        })
      }
      if (!data?.supported) {
        // The selected alignment came from the supported catalogue. A temporary
        // unsupported response can therefore be caused by startup/config refresh
        // timing and is worth retrying before declaring this ribbon unavailable.
        throw createSvRequestError(
          data?.detail || 'SV dataset not available for this genome pair.',
          { retryable: true },
        )
      }
      setDataState(data)
      lastFetchKeyRef.current = fetchKey
      retryState.attempt = 0
      if (retryState.timer) {
        clearTimeout(retryState.timer)
        retryState.timer = null
      }
      setError(null)
      const otherSlot = slot === 'top' ? 'bottom' : 'top'
      if (!bufferRetryRef.current[otherSlot].timer) setStatusText('')
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== tokenRef.current) return
      const currentDataRef = slot === 'top' ? upperBufferDataRef : lowerBufferDataRef
      if (isRetryableSvRequestError(e) && retryState.attempt < SV_TRANSIENT_RETRY_LIMIT) {
        const label = slot === 'bottom' ? 'third genome alignment' : 'second genome alignment'
        setStatusText(currentDataRef.current
          ? `The ${label} is temporarily unavailable; keeping the last loaded region and retrying.`
          : `The ${label} is taking longer than expected; retrying automatically.`)
        setError(null)
        if (!retryState.timer) {
          retryState.attempt += 1
          const delay = getSvTransientRetryDelay(retryState.attempt)
          retryState.timer = setTimeout(() => {
            retryState.timer = null
            if (retryState.key === fetchKey) {
              fetchPairBufferData(slot, tgtAssemblyValue, refWindow, targetBrowseGenome, alignmentId)
            }
          }, delay)
        }
        return
      }
      if (slot === 'bottom') {
        setDataState(null)
        lastFetchKeyRef.current = ''
        setStatusText(`The third genome alignment could not be loaded: ${e?.message || 'unknown error'}`)
        setError(null)
        return
      }
      setError(e?.message || 'Failed to load structural variation data.')
    } finally {
      if (inFlightFetchKeyRef.current === fetchKey) {
        inFlightFetchKeyRef.current = ''
      }
      if (abortRef.current === abortController) {
        abortRef.current = null
      }
      if (token === tokenRef.current) {
        setLoadingState(false)
      }
    }
  }, [refAssembly, runtimeOutputDir, referenceBrowseGenomeId])

  const bufferNeedsFetch = useCallback((data, refWindow, alignmentId = '') => {
    if (!refWindow?.chrom) return false
    if (!data) return true
    if (!svBufferMatchesAlignment(data, alignmentId)) return true
    if (!svBufferMatchesRefWindow(data, refWindow)) return true
    const bufferStart = Number(data.ref_start ?? NaN)
    const bufferEnd = Number(data.ref_end ?? NaN)
    if (!Number.isFinite(bufferStart) || !Number.isFinite(bufferEnd) || bufferEnd <= bufferStart) return true
    const margin = Math.max(25_000, Math.round((bufferEnd - bufferStart) * BUFFER_MARGIN_RATIO))
    return refWindow.start < (bufferStart + margin) || refWindow.end > (bufferEnd - margin)
  }, [])

  useEffect(() => {
    if (!viewRefWindow) return
    if (selectedTopAlignmentId && bufferNeedsFetch(upperBufferData, viewRefWindow, selectedTopAlignmentId)) {
      fetchPairBufferData('top', topAssembly, viewRefWindow, topBrowseGenomeId, selectedTopAlignmentId)
    }
    if (bottomBrowseGenomeId && selectedBottomAlignmentId && bufferNeedsFetch(lowerBufferData, viewRefWindow, selectedBottomAlignmentId)) {
      fetchPairBufferData('bottom', bottomAssembly, viewRefWindow, bottomBrowseGenomeId, selectedBottomAlignmentId)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    topAssembly,
    bottomAssembly,
    topBrowseGenomeId,
    bottomBrowseGenomeId,
    selectedTopAlignmentId,
    selectedBottomAlignmentId,
    upperBufferData,
    lowerBufferData,
    fetchPairBufferData,
    bufferNeedsFetch,
  ])

  const fallbackTopWindow = useMemo(
    () => svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
      ? { chrom: upperBufferData.tgt_chrom, start: upperBufferData.tgt_start, end: upperBufferData.tgt_end }
      : null,
    [upperBufferData, viewRefWindow],
  )
  const fallbackBottomWindow = useMemo(
    () => svBufferMatchesRefWindow(lowerBufferData, viewRefWindow)
      ? { chrom: lowerBufferData.tgt_chrom, start: lowerBufferData.tgt_start, end: lowerBufferData.tgt_end }
      : null,
    [lowerBufferData, viewRefWindow],
  )
  const autoTopWindow = useMemo(
    () => deriveAutoTargetWindowFromBuffer(upperBufferData, viewRefWindow, fallbackTopWindow),
    [upperBufferData, viewRefWindow, fallbackTopWindow],
  )
  const autoBottomWindow = useMemo(
    () => deriveAutoTargetWindowFromBuffer(lowerBufferData, viewRefWindow, fallbackBottomWindow),
    [lowerBufferData, viewRefWindow, fallbackBottomWindow],
  )
  const upperAnnotationAlignments = useMemo(
    () => svBlocksToFeatureBandAlignments(svBufferMatchesRefWindow(upperBufferData, viewRefWindow) ? (upperBufferData?.blocks || []) : []),
    [upperBufferData, viewRefWindow],
  )
  const lowerAnnotationAlignments = useMemo(
    () => svBlocksToFeatureBandAlignments(svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? (lowerBufferData?.blocks || []) : []),
    [lowerBufferData, viewRefWindow],
  )
  const referenceDataTracks = useMemo(
    () => getSvDataTracksForSide(
      svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
        ? upperBufferData
        : (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData : null),
      'reference',
    ),
    [upperBufferData, lowerBufferData, viewRefWindow],
  )
  const topDataTracks = useMemo(
    () => getSvDataTracksForSide(upperBufferData, 'target'),
    [upperBufferData],
  )
  const bottomDataTracks = useMemo(
    () => getSvDataTracksForSide(lowerBufferData, 'target'),
    [lowerBufferData],
  )
  const referenceSignalTracks = useMemo(
    () => getSvSignalTracksForSide(
      svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
        ? upperBufferData
        : (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData : null),
      'reference',
    ),
    [upperBufferData, lowerBufferData, viewRefWindow],
  )
  const topSignalTracks = useMemo(
    () => getSvSignalTracksForSide(upperBufferData, 'target'),
    [upperBufferData],
  )
  const bottomSignalTracks = useMemo(
    () => getSvSignalTracksForSide(lowerBufferData, 'target'),
    [lowerBufferData],
  )

  // The alignment web component can emit an initial alt viewport before its
  // region name is known. Never let that temporary chrom-less window mask the
  // chromosome resolved by the completed SV buffer response.
  const resolvedTopChrom = useMemo(
    () => resolveSvFeatureWindowChrom(upperBufferData?.tgt_chrom, viewTopWindow, autoTopWindow, fallbackTopWindow),
    [upperBufferData?.tgt_chrom, viewTopWindow?.chrom, autoTopWindow?.chrom, fallbackTopWindow?.chrom],
  )
  const resolvedBottomChrom = useMemo(
    () => resolveSvFeatureWindowChrom(lowerBufferData?.tgt_chrom, viewBottomWindow, autoBottomWindow, fallbackBottomWindow),
    [lowerBufferData?.tgt_chrom, viewBottomWindow?.chrom, autoBottomWindow?.chrom, fallbackBottomWindow?.chrom],
  )
  const normalizedViewTopWindow = useMemo(
    () => withWindowChrom(viewTopWindow, resolvedTopChrom),
    [viewTopWindow, resolvedTopChrom],
  )
  const normalizedViewBottomWindow = useMemo(
    () => withWindowChrom(viewBottomWindow, resolvedBottomChrom),
    [viewBottomWindow, resolvedBottomChrom],
  )
  const normalizedAutoTopWindow = useMemo(
    () => withWindowChrom(autoTopWindow, resolvedTopChrom),
    [autoTopWindow, resolvedTopChrom],
  )
  const normalizedAutoBottomWindow = useMemo(
    () => withWindowChrom(autoBottomWindow, resolvedBottomChrom),
    [autoBottomWindow, resolvedBottomChrom],
  )
  const normalizedFallbackTopWindow = useMemo(
    () => withWindowChrom(fallbackTopWindow, resolvedTopChrom),
    [fallbackTopWindow, resolvedTopChrom],
  )
  const normalizedFallbackBottomWindow = useMemo(
    () => withWindowChrom(fallbackBottomWindow, resolvedBottomChrom),
    [fallbackBottomWindow, resolvedBottomChrom],
  )

  useEffect(() => {
    if (!resolvedTopChrom) return
    setViewTopWindow((prev) => (prev && !prev.chrom ? { ...prev, chrom: resolvedTopChrom } : prev))
  }, [resolvedTopChrom])

  useEffect(() => {
    if (!resolvedBottomChrom) return
    setViewBottomWindow((prev) => (prev && !prev.chrom ? { ...prev, chrom: resolvedBottomChrom } : prev))
  }, [resolvedBottomChrom])

  const displayRefWindow = previewRefWindow || viewRefWindow
  const baseTopWindow = normalizedViewTopWindow || normalizedAutoTopWindow || normalizedFallbackTopWindow
  const baseBottomWindow = normalizedViewBottomWindow || normalizedAutoBottomWindow || normalizedFallbackBottomWindow
  const displayTopWindow = previewTopWindow || baseTopWindow
  const displayBottomWindow = previewBottomWindow || baseBottomWindow

  const refChromSize = useMemo(
    () => getResolvedChromSize(
      (svBufferMatchesRefWindow(upperBufferData, viewRefWindow) ? upperBufferData?.ref_chrom_sizes : null)
        || (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData?.ref_chrom_sizes : null),
      viewRefWindow?.chrom,
    ),
    [upperBufferData, lowerBufferData, viewRefWindow?.chrom],
  )
  const topChromSize = useMemo(
    () => getResolvedChromSize(upperBufferData?.tgt_chrom_sizes, baseTopWindow?.chrom),
    [upperBufferData, baseTopWindow?.chrom],
  )
  const bottomChromSize = useMemo(
    () => getResolvedChromSize(lowerBufferData?.tgt_chrom_sizes, baseBottomWindow?.chrom),
    [lowerBufferData, baseBottomWindow?.chrom],
  )
  const alignmentRegionLength = useMemo(
    () => refChromSize || 500_000_000,
    [refChromSize],
  )
  const topRegionLength = useMemo(
    () => topChromSize || 500_000_000,
    [topChromSize],
  )
  const bottomRegionLength = useMemo(
    () => bottomChromSize || 500_000_000,
    [bottomChromSize],
  )

  useEffect(() => { displayRefWindowRef.current = displayRefWindow }, [displayRefWindow])
  useEffect(() => { displayTopWindowRef.current = displayTopWindow }, [displayTopWindow])
  useEffect(() => { displayBottomWindowRef.current = displayBottomWindow }, [displayBottomWindow])
  useEffect(() => { refChromSizeRef.current = refChromSize }, [refChromSize])
  useEffect(() => { topChromSizeRef.current = topChromSize }, [topChromSize])
  useEffect(() => { bottomChromSizeRef.current = bottomChromSize }, [bottomChromSize])

  useEffect(() => {
    if (!savedViewportRef || !viewRefWindow) return
    savedViewportRef.current = {
      refWindow: viewRefWindow,
      topWindow: viewTopWindow,
      bottomWindow: viewBottomWindow,
      refAssembly,
      topAssembly,
      bottomAssembly,
      seededRegionKey: seededAnchorRegionKeyRef.current,
      seededBrowserKey: seededBrowserKeyRef.current,
      regionSeedBrowserKey: regionSeedBrowserKeyRef.current,
    }
  }, [viewRefWindow, viewTopWindow, viewBottomWindow, refAssembly, topAssembly, bottomAssembly]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prevBottomAlignmentId = prevBottomAlignmentIdRef.current
    prevBottomAlignmentIdRef.current = selectedBottomAlignmentId
    // Detect: third genome became the second (its alignment is now the top alignment)
    if (prevBottomAlignmentId && !selectedBottomAlignmentId && selectedTopAlignmentId === prevBottomAlignmentId) {
      setViewTopWindow(displayBottomWindowRef.current || null)
      setPreviewTopWindow(null)
      setViewBottomWindow(null)
      setPreviewBottomWindow(null)
      setFeatureTrackData((prev) => ({ reference: prev.reference, top: prev.bottom, bottom: [] }))
      setFeatureTrackLoading((prev) => ({ reference: prev.reference, top: false, bottom: false }))
      setUpperBufferData(lowerBufferDataRef.current)
      setLowerBufferData(null)
      featureTrackCacheRef.current = { reference: featureTrackCacheRef.current.reference, top: featureTrackCacheRef.current.bottom, bottom: null }
    }
  }, [selectedBottomAlignmentId, selectedTopAlignmentId])

  const requestCanonicalTrackData = useCallback(async (slotKey, genomeId, window) => {
    if (!window?.chrom || !genomeId || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) {
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, []))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      return
    }

    const genomeIdentity = slotKey === 'reference'
      ? (refAssembly || genomeId)
      : slotKey === 'top'
        ? (topAssembly || genomeId)
        : (bottomAssembly || genomeId)
    const chromSize = slotKey === 'reference'
      ? refChromSizeRef.current
      : slotKey === 'top'
        ? topChromSizeRef.current
        : bottomChromSizeRef.current
    const effectiveChromSize = chromSize || 500_000_000
    const requestWindow = svLoadingMode === 'eager'
      ? (buildChromWindow(window.chrom, effectiveChromSize, 1) || window)
      : window
    const cacheKey = `${SV_AUX_TRACK_CACHE_VERSION}:${svLoadingMode}:${slotKey}:${genomeIdentity}:${genomeId}:${getWindowKey(requestWindow)}`
    const retryState = featureTrackRetryRef.current[slotKey]
    if (retryState.key !== cacheKey) {
      if (retryState.timer) clearTimeout(retryState.timer)
      Object.assign(retryState, { key: cacheKey, attempt: 0, timer: null })
    }
    const cached = featureTrackCacheRef.current[slotKey]
    if (cached?.key === cacheKey) {
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, cached.entries))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      return
    }

    featureTrackTokenRef.current[slotKey] = (featureTrackTokenRef.current[slotKey] || 0) + 1
    const token = featureTrackTokenRef.current[slotKey]
    featureTrackAbortRef.current[slotKey]?.abort?.()
    const abortController = new AbortController()
    featureTrackAbortRef.current[slotKey] = abortController
    setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, true))

    try {
      const params = new URLSearchParams({
        genome: genomeId,
        chrom: requestWindow.chrom,
        start: String(requestWindow.start),
        end: String(requestWindow.end),
      })
      const res = await fetch(`${API_BASE}/api/browse/canonical_transcripts?${params.toString()}`, {
        signal: abortController.signal,
      })
      if (!res.ok) {
        throw new Error(`Canonical transcript request failed (${res.status})`)
      }
      const data = await res.json()
      if (token !== featureTrackTokenRef.current[slotKey]) return
      featureTrackCacheRef.current[slotKey] = {
        key: cacheKey,
        entries: Array.isArray(data) ? data : [],
      }
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, Array.isArray(data) ? data : []))
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== featureTrackTokenRef.current[slotKey]) return
      console.warn(`Failed to load ${genomeId} canonical transcripts`, e)
      if (!retryState.timer && retryState.attempt < SV_TRANSIENT_RETRY_LIMIT) {
        retryState.attempt += 1
        retryState.timer = setTimeout(() => {
          retryState.timer = null
          if (retryState.key === cacheKey) requestCanonicalTrackData(slotKey, genomeId, window)
        }, getSvTransientRetryDelay(retryState.attempt))
      }
    } finally {
      if (featureTrackAbortRef.current[slotKey] === abortController) {
        featureTrackAbortRef.current[slotKey] = null
      }
      if (token === featureTrackTokenRef.current[slotKey] && !retryState.timer) {
        setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      }
    }
  }, [svLoadingMode, refAssembly, topAssembly, bottomAssembly])

  useEffect(() => {
    if (viewRefWindow) {
      requestCanonicalTrackData('reference', referenceBrowseGenomeId, viewRefWindow)
    }
    if (baseTopWindow) {
      requestCanonicalTrackData('top', topBrowseGenomeId, baseTopWindow)
    }
    if (baseBottomWindow && bottomBrowseGenomeId) {
      requestCanonicalTrackData('bottom', bottomBrowseGenomeId, baseBottomWindow)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    baseTopWindow?.chrom,
    baseTopWindow?.start,
    baseTopWindow?.end,
    baseBottomWindow?.chrom,
    baseBottomWindow?.start,
    baseBottomWindow?.end,
    referenceBrowseGenomeId,
    topBrowseGenomeId,
    bottomBrowseGenomeId,
    topChromSize,
    bottomChromSize,
    requestCanonicalTrackData,
  ])

  const getCenteredOuterWindows = useCallback((nextRefWindow, topBaseWindow = null, bottomBaseWindow = null) => {
    if (!nextRefWindow) {
      return { top: topBaseWindow, bottom: bottomBaseWindow }
    }
    const currentTopBase = topBaseWindow || displayTopWindowRef.current || autoTopWindow || fallbackTopWindow
    const currentBottomBase = bottomBaseWindow || displayBottomWindowRef.current || autoBottomWindow || fallbackBottomWindow
    const upperAlignments = upperAlignmentsRef.current?.data?.alignments || []
    const lowerAlignments = lowerAlignmentsRef.current?.data?.alignments || []

    const nextTop = buildCenteredTargetWindow(
      nextRefWindow,
      currentTopBase,
      upperAlignments,
      topChromSizeRef.current,
    ) || currentTopBase
    const nextBottom = buildCenteredTargetWindow(
      nextRefWindow,
      currentBottomBase,
      lowerAlignments,
      bottomChromSizeRef.current,
    ) || currentBottomBase

    return { top: nextTop, bottom: nextBottom }
  }, [autoTopWindow, fallbackTopWindow, autoBottomWindow, fallbackBottomWindow])

  const syncUpperAlignmentViewport = useCallback((refWindow, topWindow) => {
    const el = upperAlignmentsRef.current
    if (!el || !refWindow) return
    el.endpoints = getUpperRuntimeEndpoints()
    el.referenceGenomeId = refAssembly
    el.altGenomeId = topAssembly
    el.imageHeight = alignmentPanelHeight
    el.loadingStrategy = svLoadingMode
    // The web component has no access to React config, so the resolved scheme
    // is handed to it as a property.
    el.browsingControls = browsingControls
    el.displayOrder = 'alt-top'
    el.linkedViewports = true
    el.regionName = refWindow.chrom
    el.altRegionName = topWindow?.chrom || ''
    el.regionLength = alignmentRegionLength
    el.start = refWindow.start
    el.end = refWindow.end
    el.altRegionLength = topRegionLength
    el.altStart = topWindow?.start ?? 0
    el.altEnd = topWindow?.end ?? 0
  }, [refAssembly, topAssembly, alignmentPanelHeight, svLoadingMode, alignmentRegionLength, topRegionLength, getUpperRuntimeEndpoints, browsingControls])

  const syncLowerAlignmentViewport = useCallback((refWindow, bottomWindow) => {
    const el = lowerAlignmentsRef.current
    if (!el || !refWindow) return
    el.endpoints = getLowerRuntimeEndpoints()
    el.referenceGenomeId = refAssembly
    el.altGenomeId = bottomAssembly
    el.imageHeight = alignmentPanelHeight
    el.loadingStrategy = svLoadingMode
    // The web component has no access to React config, so the resolved scheme
    // is handed to it as a property.
    el.browsingControls = browsingControls
    el.displayOrder = 'reference-top'
    el.linkedViewports = true
    el.regionName = refWindow.chrom
    el.altRegionName = bottomWindow?.chrom || ''
    el.regionLength = alignmentRegionLength
    el.start = refWindow.start
    el.end = refWindow.end
    el.altRegionLength = bottomRegionLength
    el.altStart = bottomWindow?.start ?? 0
    el.altEnd = bottomWindow?.end ?? 0
  }, [refAssembly, bottomAssembly, alignmentPanelHeight, svLoadingMode, alignmentRegionLength, bottomRegionLength, getLowerRuntimeEndpoints, browsingControls])

  useEffect(() => {
    syncUpperAlignmentViewport(viewRefWindow, baseTopWindow)
    const frame = requestAnimationFrame(() => syncUpperAlignmentViewport(viewRefWindow, baseTopWindow))
    return () => cancelAnimationFrame(frame)
  }, [syncUpperAlignmentViewport, viewRefWindow, baseTopWindow])

  useEffect(() => {
    syncLowerAlignmentViewport(viewRefWindow, baseBottomWindow)
    const frame = requestAnimationFrame(() => syncLowerAlignmentViewport(viewRefWindow, baseBottomWindow))
    return () => cancelAnimationFrame(frame)
  }, [syncLowerAlignmentViewport, viewRefWindow, baseBottomWindow])

  const clearPendingViewportCommit = useCallback(() => {
    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current)
      wheelCommitTimerRef.current = null
    }
  }, [])

  const pushPreviewViewport = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    displayRefWindowRef.current = nextRefWindow
    displayTopWindowRef.current = nextTopWindow
    displayBottomWindowRef.current = nextBottomWindow
    pendingPreviewRef.current = {
      ref: nextRefWindow,
      top: nextTopWindow,
      bottom: nextBottomWindow,
    }
    if (!previewFrameRef.current) {
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null
        const pending = pendingPreviewRef.current
        pendingPreviewRef.current = { ref: null, top: null, bottom: null }
        if (pending.ref) setPreviewRefWindow(pending.ref)
        if (pending.top) setPreviewTopWindow(pending.top)
        if (pending.bottom) setPreviewBottomWindow(pending.bottom)
        syncUpperAlignmentViewport(pending.ref, pending.top)
        syncLowerAlignmentViewport(pending.ref, pending.bottom)
      })
    }
  }, [syncUpperAlignmentViewport, syncLowerAlignmentViewport])

  const commitViewportChange = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    pendingPreviewRef.current = { ref: null, top: null, bottom: null }
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
    if (nextRefWindow) setViewRefWindow(nextRefWindow)
    if (nextTopWindow) setViewTopWindow(nextTopWindow)
    if (nextBottomWindow) setViewBottomWindow(nextBottomWindow)
  }, [])

  const scheduleViewportCommit = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    clearPendingViewportCommit()
    wheelCommitTimerRef.current = setTimeout(() => {
      wheelCommitTimerRef.current = null
      commitViewportChange(nextRefWindow, nextTopWindow, nextBottomWindow)
    }, WHEEL_COMMIT_DEBOUNCE_MS)
  }, [clearPendingViewportCommit, commitViewportChange])

  useEffect(() => {
    if (!viewRefWindow) return
    const topBase = displayTopWindowRef.current || autoTopWindow || fallbackTopWindow
    const bottomBase = displayBottomWindowRef.current || autoBottomWindow || fallbackBottomWindow
    if (!topBase || !bottomBase) return
    const next = getCenteredOuterWindows(viewRefWindow, topBase, bottomBase)
    if (!viewTopWindow && next.top) {
      setViewTopWindow(next.top)
    }
    if (!viewBottomWindow && next.bottom) {
      setViewBottomWindow(next.bottom)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    upperBufferData,
    lowerBufferData,
    alignmentTrackLoading.top,
    alignmentTrackLoading.bottom,
    autoTopWindow,
    fallbackTopWindow,
    autoBottomWindow,
    fallbackBottomWindow,
    getCenteredOuterWindows,
    viewTopWindow,
    viewBottomWindow,
  ])

  const handleFeatureBandWheel = useCallback((side, event, element = null) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    if (isBoxSelectMode || isSelectingRect) return

    const currentRefWindow = displayRefWindowRef.current
    const currentTopWindow = displayTopWindowRef.current
    const currentBottomWindow = displayBottomWindowRef.current
    if (side === 'reference' && !currentRefWindow) return
    if (side === 'top' && !currentTopWindow) return
    if (side === 'bottom' && !currentBottomWindow) return

    const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
    const session = wheelSessionRef.current
    const gesture = beginWheelGesture(session.gesture, wheel, wheel.ts || performance.now())
    const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
      canScrollPage: Boolean(findNearestScrollable(event.target || element)),
      gesture,
    })
    markWheelHandled(event)
    session.gesture = { ...gesture, mode: intent.nextGestureMode || gesture.mode }
    if (intent.preventDefault) event.preventDefault()
    if (intent.stopPropagation) {
      event.stopPropagation()
      event.stopImmediatePropagation?.()
    }
    if (intent.type !== 'zoom' && intent.type !== 'pan') return

    const targetElement = element || event.currentTarget || event.target
    if (!targetElement?.getBoundingClientRect) return
    const rect = targetElement.getBoundingClientRect()
    const anchorFraction = intent.anchor === 'center'
      ? 0.5
      : clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)

    let nextRefWindow = currentRefWindow
    let nextTopWindow = currentTopWindow
    let nextBottomWindow = currentBottomWindow
    if (intent.type === 'zoom') {
      if (currentRefWindow) {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
      }
      if (currentTopWindow) {
        nextTopWindow = zoomWindowAround(currentTopWindow, intent.factor, anchorFraction, 1, topChromSizeRef.current)
      }
      if (currentBottomWindow) {
        nextBottomWindow = zoomWindowAround(currentBottomWindow, intent.factor, anchorFraction, 1, bottomChromSizeRef.current)
      }
    } else {
      if (side === 'reference' && currentRefWindow) {
        nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
      } else if (side === 'top' && currentTopWindow) {
        nextTopWindow = panWindowByPixels(currentTopWindow, intent.dxPx, rect.width, 1, topChromSizeRef.current)
      } else if (side === 'bottom' && currentBottomWindow) {
        nextBottomWindow = panWindowByPixels(currentBottomWindow, intent.dxPx, rect.width, 1, bottomChromSizeRef.current)
      }
    }

    externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
    pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
    scheduleViewportCommit(nextRefWindow, nextTopWindow, nextBottomWindow)
  }, [pushPreviewViewport, scheduleViewportCommit, isBoxSelectMode, isSelectingRect])

  useEffect(() => {
    const interactiveArea = interactiveAreaRef.current
    if (!interactiveArea) return

    const handleWorkspaceWheel = (event) => {
      if (isBoxSelectMode || isSelectingRect) {
        event.preventDefault()
        return
      }
      const currentRefWindow = displayRefWindowRef.current
      const currentTopWindow = displayTopWindowRef.current
      const currentBottomWindow = displayBottomWindowRef.current
      if (!currentRefWindow) return

      const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
      const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
        canScrollPage: Boolean(findNearestScrollable(event.target || interactiveArea)),
      })
      markWheelHandled(event)
      if (intent.preventDefault) event.preventDefault()
      if (intent.stopPropagation) {
        event.stopPropagation()
        event.stopImmediatePropagation?.()
      }
      if (intent.type !== 'zoom' && intent.type !== 'pan') return

      const rect = interactiveArea.getBoundingClientRect()
      if (rect.width <= 0) return
      const anchorFraction = intent.anchor === 'center'
        ? 0.5
        : clamp((event.clientX - rect.left) / rect.width, 0, 1)

      let nextRefWindow = currentRefWindow
      let nextTopWindow = currentTopWindow
      let nextBottomWindow = currentBottomWindow
      if (intent.type === 'zoom') {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
        if (currentTopWindow) {
          nextTopWindow = zoomWindowAround(currentTopWindow, intent.factor, anchorFraction, 1, topChromSizeRef.current)
        }
        if (currentBottomWindow) {
          nextBottomWindow = zoomWindowAround(currentBottomWindow, intent.factor, anchorFraction, 1, bottomChromSizeRef.current)
        }
      } else {
        nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
        if (currentTopWindow) {
          nextTopWindow = panWindowByPixels(currentTopWindow, intent.dxPx, rect.width, 1, topChromSizeRef.current)
        }
        if (currentBottomWindow) {
          nextBottomWindow = panWindowByPixels(currentBottomWindow, intent.dxPx, rect.width, 1, bottomChromSizeRef.current)
        }
      }

      externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
      pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
      scheduleViewportCommit(nextRefWindow, nextTopWindow, nextBottomWindow)
    }

    interactiveArea.addEventListener('wheel', handleWorkspaceWheel, { passive: false, capture: true })
    return () => {
      interactiveArea.removeEventListener('wheel', handleWorkspaceWheel, true)
    }
  }, [isBoxSelectMode, isSelectingRect, pushPreviewViewport, scheduleViewportCommit, viewRefWindow])

  useEffect(() => {
    const topEl = topFeatureBandRef.current
    const midEl = middleFeatureBandRef.current
    const bottomEl = bottomFeatureBandRef.current
    const handleTop = (e) => handleFeatureBandWheel('top', e, topEl)
    const handleMid = (e) => handleFeatureBandWheel('reference', e, midEl)
    const handleBottom = (e) => handleFeatureBandWheel('bottom', e, bottomEl)
    if (topEl) topEl.addEventListener('wheel', handleTop, { passive: false })
    if (midEl) midEl.addEventListener('wheel', handleMid, { passive: false })
    if (bottomEl) bottomEl.addEventListener('wheel', handleBottom, { passive: false })
    return () => {
      if (topEl) topEl.removeEventListener('wheel', handleTop)
      if (midEl) midEl.removeEventListener('wheel', handleMid)
      if (bottomEl) bottomEl.removeEventListener('wheel', handleBottom)
    }
  }, [handleFeatureBandWheel, viewRefWindow])

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      const deltaX = event.clientX - dragState.startX
      const deltaY = event.clientY - dragState.startY

      // Axis-locked, exactly as in the Genome Browser: sideways pans the tracks,
      // up/down scrolls the page. Same 5px threshold and vertical bias, so the
      // two views feel identical under the hand.
      if (!dragState.axis) {
        const axis = resolveDragAxis({
          dx: deltaX,
          dy: deltaY,
          canScrollPage: Boolean(dragState.scroller),
          currentAxis: null,
        })
        if (!axis) return
        dragState.axis = axis
      }

      if (dragState.axis === 'y') {
        if (!dragState.scroller) return
        dragState.dragging = true
        event.preventDefault()
        // 1:1 grab-and-drag: the content follows the cursor, so dragging down
        // reveals what is above.
        dragState.scroller.scrollTop = dragState.startScrollTop - deltaY
        return
      }

      if (!deltaX) return
      dragState.dragging = true
      event.preventDefault()
      let nextRefWindow = dragState.startRefWindow
      let nextTopWindow = dragState.startTopWindow
      let nextBottomWindow = dragState.startBottomWindow
      if (dragState.side === 'reference' && dragState.startRefWindow) {
        nextRefWindow = panWindowByPixels(dragState.startRefWindow, -deltaX, dragState.width, 1, refChromSizeRef.current)
      } else if (dragState.side === 'top' && dragState.startTopWindow) {
        nextTopWindow = panWindowByPixels(dragState.startTopWindow, -deltaX, dragState.width, 1, topChromSizeRef.current)
      } else if (dragState.side === 'bottom' && dragState.startBottomWindow) {
        nextBottomWindow = panWindowByPixels(dragState.startBottomWindow, -deltaX, dragState.width, 1, bottomChromSizeRef.current)
      }
      dragState.currentRefWindow = nextRefWindow
      dragState.currentTopWindow = nextTopWindow
      dragState.currentBottomWindow = nextBottomWindow
      externalViewportInteractionRef.current.dragging = true
      pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
    }

    const finishDrag = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      // A vertical drag only scrolled the page — there is no viewport change to
      // commit, and committing one would broadcast a spurious external event.
      if (dragState.dragging && dragState.axis !== 'y') {
        commitViewportChange(dragState.currentRefWindow, dragState.currentTopWindow, dragState.currentBottomWindow)
      }
      externalViewportInteractionRef.current.dragging = false
      externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
      if (dragState.element && dragState.pointerId != null) {
        try {
          dragState.element.releasePointerCapture?.(dragState.pointerId)
        } catch {
          // ignored
        }
      }
      featureBandDragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [commitViewportChange, pushPreviewViewport])

  const handleFeatureBandPointerDown = useCallback((side, event) => {
    if (isBoxSelectMode || isSelectingRect) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.button !== 0) return
    const startRefWindow = displayRefWindowRef.current
    const startTopWindow = displayTopWindowRef.current
    const startBottomWindow = displayBottomWindowRef.current
    if (side === 'reference' && !startRefWindow) return
    if (side === 'top' && !startTopWindow) return
    if (side === 'bottom' && !startBottomWindow) return

    clearPendingViewportCommit()
    externalViewportInteractionRef.current.dragging = true
    const rect = event.currentTarget.getBoundingClientRect()
    const scroller = findNearestScrollable(event.currentTarget)
    featureBandDragRef.current = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      scroller,
      startScrollTop: scroller ? scroller.scrollTop : 0,
      width: Math.max(1, rect.width),
      startRefWindow,
      startTopWindow,
      startBottomWindow,
      currentRefWindow: startRefWindow,
      currentTopWindow: startTopWindow,
      currentBottomWindow: startBottomWindow,
      dragging: false,
      element: event.currentTarget,
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [clearPendingViewportCommit, isBoxSelectMode, isSelectingRect])

  useEffect(() => {
    const registerRibbon = (element, slot) => {
      if (!element) return () => {}
      const label = slot === 'top' ? 'second genome' : 'third genome'

      const windowsFromRibbonEvent = (detail) => {
        const { reference, alt } = detail ?? {}
        const currentRefWindow = displayRefWindowRef.current
        const nextRefWindow = reference && Number.isFinite(reference.start) && Number.isFinite(reference.end)
          ? {
            chrom: reference.regionName || currentRefWindow?.chrom || viewRefWindow?.chrom || '',
            start: reference.start,
            end: reference.end,
          }
          : currentRefWindow
        const currentAltWindow = slot === 'top'
          ? displayTopWindowRef.current
          : displayBottomWindowRef.current
        const nextAltWindow = alt && Number.isFinite(alt.start) && Number.isFinite(alt.end)
          ? {
            chrom: alt.regionName || currentAltWindow?.chrom || '',
            start: alt.start,
            end: alt.end,
          }
          : currentAltWindow

        if (slot === 'top') {
          const currentBottomWindow = displayBottomWindowRef.current
          const nextBottomWindow = transformOuterWindowFromReferenceChange(
            currentRefWindow,
            nextRefWindow,
            currentBottomWindow,
            bottomChromSizeRef.current,
          )
          return { ref: nextRefWindow, top: nextAltWindow, bottom: nextBottomWindow }
        }

        const currentTopWindow = displayTopWindowRef.current
        const nextTopWindow = transformOuterWindowFromReferenceChange(
          currentRefWindow,
          nextRefWindow,
          currentTopWindow,
          topChromSizeRef.current,
        )
        return { ref: nextRefWindow, top: nextTopWindow, bottom: nextAltWindow }
      }

      const handlePreview = (e) => {
        const externalInteraction = externalViewportInteractionRef.current
        if (externalInteraction.dragging || performance.now() < externalInteraction.activeUntil) return
        const next = windowsFromRibbonEvent(e.detail)
        pushPreviewViewport(next.ref, next.top, next.bottom)
      }

      const handleCommit = (e) => {
        const externalInteraction = externalViewportInteractionRef.current
        if (externalInteraction.dragging || performance.now() < externalInteraction.activeUntil) return
        const next = windowsFromRibbonEvent(e.detail)
        commitViewportChange(next.ref, next.top, next.bottom)
      }

      const handleLoadingChange = (event) => {
        setAlignmentTrackLoading((prev) => updateObjectSlot(prev, slot, Boolean(event.detail?.loading)))
      }

      const handleLoadingError = (event) => {
        setAlignmentTrackLoading((prev) => updateObjectSlot(prev, slot, false))
        setStatusText(`The ${label} alignment ribbon could not be loaded: ${event.detail?.message || 'unknown error'}`)
      }

      element.addEventListener('viewport-change', handlePreview)
      element.addEventListener('viewport-change-end', handleCommit)
      element.addEventListener('loading-change', handleLoadingChange)
      element.addEventListener('loading-error', handleLoadingError)
      return () => {
        element.removeEventListener('viewport-change', handlePreview)
        element.removeEventListener('viewport-change-end', handleCommit)
        element.removeEventListener('loading-change', handleLoadingChange)
        element.removeEventListener('loading-error', handleLoadingError)
      }
    }

    const cleanupUpper = registerRibbon(upperAlignmentsRef.current, 'top')
    const cleanupLower = registerRibbon(lowerAlignmentsRef.current, 'bottom')
    return () => {
      cleanupUpper()
      cleanupLower()
    }
  }, [
    pushPreviewViewport,
    commitViewportChange,
    viewRefWindow?.chrom,
    selectedTopAlignmentId,
    selectedBottomAlignmentId,
    baseTopWindow?.chrom,
    baseBottomWindow?.chrom,
  ])

  useEffect(() => {
    const updateSelectionRectFromEvent = (event) => {
      const drag = selectionDragRef.current
      const area = interactiveAreaRef.current
      if (!drag || !area || event.pointerId !== drag.pointerId) return
      const rect = area.getBoundingClientRect()
      const x = clamp(event.clientX - rect.left, 0, rect.width)
      const y = clamp(event.clientY - rect.top, 0, rect.height)
      setSelectionRect((prev) => (prev ? { ...prev, x2: x, y2: y } : prev))
    }

    const finishSelection = (event) => {
      const drag = selectionDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const finalRect = selectionRect
      selectionDragRef.current = null
      setIsSelectingRect(false)
      setIsBoxSelectMode(false)

      if (drag.element && drag.pointerId != null) {
        try {
          drag.element.releasePointerCapture?.(drag.pointerId)
        } catch {
          // ignored
        }
      }

      if (!finalRect || !displayRefWindowRef.current) {
        setSelectionRect(null)
        return
      }

      const plotLeft = PLOT_PAD_X
      const plotRight = Math.max(plotLeft + 400, panelWidth - PLOT_PAD_X)
      const plotWidth = Math.max(1, plotRight - plotLeft)
      const minX = clamp(Math.min(finalRect.x1, finalRect.x2), plotLeft, plotRight)
      const maxX = clamp(Math.max(finalRect.x1, finalRect.x2), plotLeft, plotRight)
      setSelectionRect(null)
      if ((maxX - minX) <= 2) return

      const currentRefWindow = displayRefWindowRef.current
      const currentRefSpan = Math.max(1, currentRefWindow.end - currentRefWindow.start)
      const nextRefStart = currentRefWindow.start + ((minX - plotLeft) / plotWidth) * currentRefSpan
      const nextRefEnd = currentRefWindow.start + ((maxX - plotLeft) / plotWidth) * currentRefSpan
      const nextRefWindow = constrainWindowToZoomLimits({
        chrom: currentRefWindow.chrom,
        start: Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))),
        end: Math.max(Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))) + 1, Math.round(Math.max(nextRefStart, nextRefEnd))),
      }, refChromSizeRef.current)
      const next = getCenteredOuterWindows(nextRefWindow)
      clearPendingViewportCommit()
      setPreviewRefWindow(null)
      setPreviewTopWindow(null)
      setPreviewBottomWindow(null)
      setViewRefWindow(nextRefWindow)
      if (next.top) setViewTopWindow(next.top)
      if (next.bottom) setViewBottomWindow(next.bottom)
    }

    window.addEventListener('pointermove', updateSelectionRectFromEvent, { passive: false })
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', finishSelection)
    return () => {
      window.removeEventListener('pointermove', updateSelectionRectFromEvent)
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', finishSelection)
    }
  }, [selectionRect, panelWidth, getCenteredOuterWindows, clearPendingViewportCommit])

  const handleSelectionOverlayPointerDown = useCallback((event) => {
    if (!isBoxSelectMode || event.button !== 0) return
    const area = interactiveAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)
    clearPendingViewportCommit()
    setIsSelectingRect(true)
    setSelectionRect({ x1: x, y1: y, x2: x, y2: y })
    selectionDragRef.current = { pointerId: event.pointerId, element: event.currentTarget }
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [isBoxSelectMode, clearPendingViewportCommit])

  const applyZoom = useCallback((factor) => {
    const currentRefWindow = displayRefWindowRef.current
    if (!currentRefWindow) return
    clearPendingViewportCommit()
    const nextRefWindow = zoomWindowAround(currentRefWindow, factor, 0.5, 1, refChromSizeRef.current)
    const next = getCenteredOuterWindows(nextRefWindow)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
    setViewRefWindow(nextRefWindow)
    if (next.top) setViewTopWindow(next.top)
    if (next.bottom) setViewBottomWindow(next.bottom)
  }, [clearPendingViewportCommit, getCenteredOuterWindows])

  const centerAlignment = useCallback(() => {
    const currentRefWindow = displayRefWindowRef.current
    if (!currentRefWindow) return
    const next = getCenteredOuterWindows(currentRefWindow)
    if (next.top) setViewTopWindow(next.top)
    if (next.bottom) setViewBottomWindow(next.bottom)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [getCenteredOuterWindows])

  const upperAlignmentKey = `${selectedTopAlignmentId}|${refAssembly}|${topAssembly}|${viewRefWindow?.chrom || ''}|upper`
  const lowerAlignmentKey = `${selectedBottomAlignmentId}|${refAssembly}|${bottomAssembly}|${viewRefWindow?.chrom || ''}|lower`

  // Wait for the target window before mounting a ribbon. Mounting it earlier
  // starts a reference-only full-chromosome request which is immediately replaced
  // when /api/sv/view supplies the target window.
  const canRenderUpperRibbon = Boolean(
    refSpecies
    && tgtSpecies
    && selectedTopAlignmentId
    && viewRefWindow
    && baseTopWindow?.chrom
  )
  const hasLowerSection = Boolean(selectedBottomAlignmentId)
  const canRenderLowerRibbon = Boolean(
    canRenderUpperRibbon
    && thirdSpecies
    && selectedBottomAlignmentId
    && baseBottomWindow?.chrom
  )
  const legendSectionClass = isLight ? 'border-gray-200 bg-gray-50/90 text-gray-700' : 'border-gray-700 bg-[#152033] text-gray-300'
  const legendTitleClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const legendItems = [
    {
      title: 'Alignment type',
      items: [
        { label: 'Match', swatch: 'rgba(73, 184, 255, 0.28)', border: 'rgba(73, 184, 255, 0.55)' },
        { label: 'No match', swatch: null, border: isLight ? '#cbd5e1' : '#64748b' },
        { label: 'Inverted match', swatch: 'rgba(248, 192, 65, 0.52)', border: 'rgba(248, 192, 65, 0.72)' },
      ],
    },
    {
      title: 'Haplotype variant type',
      items: [
        { label: 'Deletion or loss', swatch: '#ff595c' },
        { label: 'Gain or insertion', swatch: '#5f73e6' },
        { label: 'SNV', swatch: '#f472b6' },
      ],
    },
  ]

  return (
    <div
      className={`rounded-xl ${themeClasses.panel} overflow-visible flex flex-col`}
      style={{
        minHeight: refSpecies && tgtSpecies && thirdSpecies && viewRefWindow ? 'calc(100vh - 180px)' : undefined,
      }}
    >
      <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center gap-2`}>
        <div className={`w-[300px] max-w-[34vw] shrink-0 truncate text-xs ${themeClasses.muted}`}>
          {viewRefWindow
            ? `${displayRefWindow?.chrom || viewRefWindow.chrom}:${formatCoord(displayRefWindow?.start || viewRefWindow.start)}-${formatCoord(displayRefWindow?.end || viewRefWindow.end)} (${formatBp(Math.max(1, (displayRefWindow?.end || viewRefWindow.end) - (displayRefWindow?.start || viewRefWindow.start)))})`
            : 'Set a region to begin'}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => applyZoom(1.12)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom out"
          >-</button>
          <button
            type="button"
            onClick={() => applyZoom(0.89)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom in"
          >+</button>
          <button
            type="button"
            onClick={centerAlignment}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Center alignment between tracks"
            aria-label="Center alignment between tracks"
          >
            <span className="inline-flex h-3.5 w-3 items-center justify-center align-middle leading-none">
              <CenterAlignmentIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsBoxSelectMode((prev) => !prev)
              setIsSelectingRect(false)
              setSelectionRect(null)
              selectionDragRef.current = null
            }}
            className={`px-2 py-1 rounded text-xs border flex items-center justify-center ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100'}`}
            style={{
              boxShadow: isBoxSelectMode ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
            }}
            title={isBoxSelectMode ? 'Selection mode active: drag to zoom' : 'Activate selection zoom mode'}
            aria-label="Activate selection zoom mode"
          >
            <span className="inline-flex items-center justify-center align-middle leading-none" style={{ width: '18px', height: '18px' }}>
              <SelectionZoomIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCompactTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              compactTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
          >
            {compactTracks ? 'Expand' : 'Compress'}
          </button>
          <button
            type="button"
            onClick={() => setHideInactiveFeatureTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              hideInactiveFeatureTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
          >
            {hideInactiveFeatureTracks ? 'Show inactive' : 'Hide inactive'}
          </button>
          <button
            type="button"
            onClick={() => setShowBigWigTracks((prev) => !prev)}
            aria-pressed={showBigWigTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigWigTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigWigTracks ? 'Hide BigWig signal tracks' : 'Load and show BigWig signal tracks'}
          >
            BigWig
          </button>
          <button
            type="button"
            onClick={() => setShowBigBedTracks((prev) => !prev)}
            aria-pressed={showBigBedTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigBedTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigBedTracks ? 'Hide BigBed interval tracks' : 'Load and show BigBed interval tracks'}
          >
            BigBed
          </button>
        </div>
      </div>
      {statusText && (upperBufferData || lowerBufferData) && (
        <div className={`border-b px-3 py-1.5 text-xs ${
          isLight ? 'border-gray-200 bg-amber-50 text-amber-800' : 'border-gray-700 bg-amber-950/30 text-amber-200'
        }`}>
          {statusText}
        </div>
      )}

      <div ref={bandSvgRef} className="flex-none overflow-visible flex flex-col pb-5">
        {error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-400">Error: {error}</div>
        ) : statusText && !upperBufferData && !lowerBufferData ? (
          <div className={`flex-1 flex items-center justify-center text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>{statusText}</div>
        ) : !viewRefWindow ? (
          <div className="flex-1 flex items-center justify-center text-sm opacity-70">Loading…</div>
        ) : (
          <div ref={interactiveAreaRef} className="relative">
            <div ref={topFeatureBandRef} className="w-full flex-none touch-none" onPointerDown={(event) => handleFeatureBandPointerDown('top', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="top"
                width={Math.max(760, panelWidth)}
                label="Secondary"
                pillLabel={tgtPillLabel || 'Secondary genome'}
                pillColor={topGenomeColor}
                window={displayTopWindow}
                entries={featureTrackData.top}
                loading={showTopGenesLoading}
                genomeId={topBrowseGenomeId}
                sequenceGenomeId={topBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="target"
                referenceWindow={displayRefWindow}
                altWindow={displayTopWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={topAssembly}
                altBrowseGenomeId={topBrowseGenomeId}
                annotationAlignments={upperAnnotationAlignments}
                compact={compactTracks}
              />
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={baseTopWindow}
                displayWindow={displayTopWindow}
                genomeId={topBrowseGenomeId}
                tracks={topSignalTracks}
                genomeColor={topGenomeColor}
              />
            )}

            <div ref={upperPanelRef} className="flex-none overflow-hidden" style={{ background: isLight ? '#edf5ff' : '#0d1830', height: `${alignmentPanelHeight}px`, position: 'relative' }}>
              {canRenderUpperRibbon && (
                <ens-sv-alignments
                  key={upperAlignmentKey}
                  ref={upperAlignmentsRef}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
              {showBigBedTracks && (
                <StructuralVariationRibbonOverlay
                  theme={theme}
                  width={Math.max(760, panelWidth)}
                  height={alignmentPanelHeight}
                  referenceWindow={viewRefWindow}
                  targetWindow={baseTopWindow}
                  displayReferenceWindow={displayRefWindow}
                  displayTargetWindow={displayTopWindow}
                  referenceTracks={referenceDataTracks}
                  targetTracks={topDataTracks}
                  referenceGenomeId={referenceBrowseGenomeId}
                  targetGenomeId={topBrowseGenomeId}
                  displayOrder="alt-top"
                />
              )}
              {showUpperAlignmentLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
                    <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Loading upper alignment…</div>
                  </div>
                </div>
              )}
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={viewRefWindow}
                displayWindow={displayRefWindow}
                genomeId={referenceBrowseGenomeId}
                tracks={referenceSignalTracks}
                genomeColor={referenceGenomeColor}
              />
            )}

            <div ref={middleFeatureBandRef} className="w-full flex-none touch-none" onPointerDown={(event) => handleFeatureBandPointerDown('reference', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="top"
                width={Math.max(760, panelWidth)}
                label="Primary"
                pillLabel={refPillLabel || 'Primary genome'}
                pillColor={referenceGenomeColor}
                window={displayRefWindow}
                entries={featureTrackData.reference}
                loading={showReferenceGenesLoading}
                genomeId={referenceBrowseGenomeId}
                sequenceGenomeId={referenceBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="reference"
                referenceWindow={displayRefWindow}
                altWindow={displayTopWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={topAssembly}
                altBrowseGenomeId={topBrowseGenomeId}
                annotationAlignments={upperAnnotationAlignments}
                comparisonAltWindow={displayBottomWindow}
                comparisonAltGenomeId={bottomAssembly}
                comparisonAnnotationAlignments={lowerAnnotationAlignments}
                compact={compactTracks}
              />
            </div>

            {hasLowerSection && (
            <div ref={lowerPanelRef} className="flex-none overflow-hidden" style={{ background: isLight ? '#edf5ff' : '#0d1830', height: `${alignmentPanelHeight}px`, position: 'relative' }}>
              {canRenderLowerRibbon && (
                <ens-sv-alignments
                  key={lowerAlignmentKey}
                  ref={lowerAlignmentsRef}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
              {showBigBedTracks && (
                <StructuralVariationRibbonOverlay
                  theme={theme}
                  width={Math.max(760, panelWidth)}
                  height={alignmentPanelHeight}
                  referenceWindow={viewRefWindow}
                  targetWindow={baseBottomWindow}
                  displayReferenceWindow={displayRefWindow}
                  displayTargetWindow={displayBottomWindow}
                  referenceTracks={referenceDataTracks}
                  targetTracks={bottomDataTracks}
                  referenceGenomeId={referenceBrowseGenomeId}
                  targetGenomeId={bottomBrowseGenomeId}
                  displayOrder="reference-top"
                />
              )}
              {showLowerAlignmentLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
                    <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Loading lower alignment…</div>
                  </div>
                </div>
              )}
            </div>
            )}

            {hasLowerSection && showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={baseBottomWindow}
                displayWindow={displayBottomWindow}
                genomeId={bottomBrowseGenomeId}
                tracks={bottomSignalTracks}
                genomeColor={bottomGenomeColor}
              />
            )}

            {hasLowerSection && (
            <div ref={bottomFeatureBandRef} className="w-full flex-none touch-none mb-4" onPointerDown={(event) => handleFeatureBandPointerDown('bottom', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="bottom"
                width={Math.max(760, panelWidth)}
                label="Third"
                pillLabel={thirdPillLabel || 'Third genome'}
                pillColor={bottomGenomeColor}
                window={displayBottomWindow}
                entries={featureTrackData.bottom}
                loading={showBottomGenesLoading}
                genomeId={bottomBrowseGenomeId}
                sequenceGenomeId={bottomBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="target"
                referenceWindow={displayRefWindow}
                altWindow={displayBottomWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={bottomAssembly}
                altBrowseGenomeId={bottomBrowseGenomeId}
                annotationAlignments={lowerAnnotationAlignments}
                compact={compactTracks}
              />
            </div>
            )}

            {(isBoxSelectMode || isSelectingRect) && (
              <div
                className="absolute inset-0 z-20"
                style={{ cursor: 'crosshair' }}
                onPointerDown={handleSelectionOverlayPointerDown}
                onWheel={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
              >
                {selectionRect && (
                  <div
                    className="absolute"
                    style={{
                      left: Math.min(selectionRect.x1, selectionRect.x2),
                      top: Math.min(selectionRect.y1, selectionRect.y2),
                      width: Math.max(1, Math.abs(selectionRect.x2 - selectionRect.x1)),
                      height: Math.max(1, Math.abs(selectionRect.y2 - selectionRect.y1)),
                      border: `1.5px dashed ${referenceGenomeColor}`,
                      backgroundColor: isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`px-3 py-2 border-t ${legendSectionClass}`}>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-xs">
          {legendItems.map((section) => (
            <div key={section.title} className="flex flex-col gap-1.5">
              <div className={`text-[11px] font-semibold ${legendTitleClass}`}>{section.title}</div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {section.items.map((item) => (
                  <div key={item.label} className="flex items-center gap-2">
                    <span
                      className="inline-block h-3.5 w-3.5 shrink-0"
                      style={{
                        backgroundColor: item.swatch || 'transparent',
                        border: item.border ? `1px solid ${item.border}` : 'none',
                      }}
                    />
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`px-3 py-1.5 border-t ${isLight ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-gray-700 bg-[#152033] text-gray-300'} text-xs flex items-center gap-3`}>
        {(upperBufferLoading || lowerBufferLoading) && <span>Buffering structural variation context…</span>}
        {!upperBufferLoading && !lowerBufferLoading && statusText && <span>{statusText}</span>}
        {!upperBufferLoading && !lowerBufferLoading && <span className="opacity-70">Structural variation (three-genome test mode)</span>}
      </div>
    </div>
  )
}
