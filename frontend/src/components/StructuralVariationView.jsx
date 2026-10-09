import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'
import { resolveGenomeColor } from '../genomeColorSchemes'
import {
  beginWheelGesture,
  findNearestScrollable,
  markWheelHandled,
  readWheelEvent,
  resolveBrowsingControls,
  resolveDragAxis,
  resolveWheelAction,
} from '../utils/browsingControls'
import {
  buildSvAuxTrackRenderWindow,
  getSvAuxTrackGeometryWidth,
  getSvAuxTrackMatrix,
  getSvAuxTrackTransform,
} from '../utils/svAuxTrackTransform'
import { resolveSvFeatureTrackGenomeIds, resolveSvFeatureWindowChrom } from '../utils/svFeatureTrackIdentity'
import useDelayedFlag from '../hooks/useDelayedFlag'
import {
  buildBrowserGeneSeedKey,
  buildBrowserViewportSeedKey,
  resolveAnchorRegionSeed,
  shouldSeedFromBrowser,
  shouldSeedFromBrowserViewport,
} from './svViewportSeeding'
import {
  buildAvailableSvAlignmentRows,
  buildSvGenomeOptions,
  catalogGenomeMatchesSpecies,
  formatSvGenomeOptionLabel,
  getOutgoingSvAlignments,
  getSvAlignmentsForPair,
  speciesGenomeKey,
} from '../utils/svCatalog'
import {
  createSvRequestError,
  isRetryableSvRequestError,
  shouldStartSvRequest,
} from '../utils/svRequestRetry'
import { buildSvConfigSummary, svConfigValidationFeedback } from '../utils/svConfigSummary'
import FileBrowserModal from './FileBrowserModal'
import StructuralVariationFeatureBand from './StructuralVariationFeatureBand'

// Register the Beta web component (ens-sv-alignments + ens-sv-alignments-image)
import '../lib/ensembl-sv/alignments/variant-alignments.js'
import {
  ALIGNMENT_PANEL_COMPACT_HEIGHT,
  ALIGNMENT_PANEL_HEIGHT,
  BUFFER_MARGIN_RATIO,
  BUFFER_PAD_MIN,
  BUFFER_PAD_RATIO,
  PLOT_PAD_X,
  SV_AUX_TRACK_CACHE_VERSION,
  SV_AUX_TRACK_RENDER_HALO_MAX_BP,
  SV_AUX_TRACK_RENDER_HALO_WINDOWS,
  SV_BIGBED_DETAIL_FETCH_BATCH_SIZE,
  SV_BIGBED_DETAIL_FETCH_PER_TRACK,
  SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
  SV_BIGBED_DETAIL_PREFETCH_MIN_TILES,
  SV_BIGBED_DETAIL_PREFETCH_RATIO,
  SV_BIGBED_FEATURE_TILE_SPAN,
  SV_BROWSING_TUNING,
  SV_DATA_TRACK_FETCH_DEBOUNCE_MS,
  SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS,
  SV_FILE_BROWSER_EXTENSIONS,
  SV_GENOME_GROUP_LABELS,
  SV_RIBBON_INTERVAL_MAX_VIEW_SPAN,
  SV_SIGNAL_CONTROL_WIDTH,
  SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE,
  SV_SIGNAL_LOD_LEVELS,
  SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE,
  SV_SIGNAL_RENDER_MAX_BINS,
  SV_SIGNAL_TARGET_FETCH_BATCH_SIZE,
  SV_SIGNAL_TOGGLE_RADIUS,
  SV_SIGNAL_TRACK_GAP,
  SV_SIGNAL_TRACK_HEIGHT,
  SV_TRANSIENT_RETRY_LIMIT,
  SV_TRIO_DEFAULT_REF_WINDOW,
  WHEEL_COMMIT_DEBOUNCE_MS,
} from './structural-variation/svConstants.js'
import {
  abbreviateMetadataValue,
  buildCuratedSvIntervalRows,
  buildSvGenomePayload,
  buildSvRuntimeEndpoint,
  clamp,
  dedupeSvSpeciesList,
  formatBp,
  formatCoord,
  getSpeciesDisplayName,
  getSvCatalogGenomeDisplayName,
  getSvGenomeAccessionLabel,
  getSvLoadingMode,
  getSvOptionTooltip,
  getSvRuntimeAssembly,
  getSvTransientRetryDelay,
  svGenomeOptionNaming,
  svSpeciesSelectionKey,
  updateObjectSlot,
} from './structural-variation/svFormat.js'
import {
  alignmentSupportsAnchorRegion,
  buildCenteredTargetWindow,
  buildChromWindow,
  buildSvAnchorRegionOptions,
  buildWindowForAnchorRegion,
  centerWindowOnRange,
  constrainWindowToZoomLimits,
  deriveAutoTargetWindowFromBuffer,
  formatSvRegionAvailabilityLabel,
  getResolvedChromSize,
  getSvRegionKey,
  getSvRegionLength,
  getWindowKey,
  normalizeSvChromToken,
  panWindowByPixels,
  parseRegionInput,
  quantizeCeil,
  quantizeFloor,
  svBlocksToFeatureBandAlignments,
  svBufferMatchesAlignment,
  svBufferMatchesRefWindow,
  svRegionsMatch,
  transformOuterWindowFromReferenceChange,
  withWindowChrom,
  zoomWindowAround,
} from './structural-variation/svWindows.js'
import {
  buildSvRibbonIntervalMarks,
  buildSvSignalPath,
  getSvDataTrackKey,
  getSvDataTrackLabel,
  getSvDataTracksForSide,
  getSvSignalLevel,
  getSvSignalTracksForSide,
  projectSvRibbonFeatureTiles,
  projectSvSignalTilesCascade,
  selectSvFetchPlansFairly,
  svBigBedFeatureTileKey,
  svNormalizeBigBedFeature,
  svSignalTileKey,
  trimSvRibbonFeatureCache,
} from './structural-variation/svTracks.js'

/**
 * Depends on the scheme id alone, never on `config` — that object gets a fresh
 * identity on every 250ms autosave, and a new controls object would re-register
 * the wheel listeners mid-gesture.
 */
function useBrowsingControls(config) {
  const schemeId = config?.browsing_control_scheme
  return useMemo(
    () => resolveBrowsingControls({ browsing_control_scheme: schemeId }, SV_BROWSING_TUNING),
    [schemeId]
  )
}

const IconUpDown = ({ open, size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

function CopyGlyph({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="14" height="16" rx="2.2" />
      <path d="M9 3h6v4H9z" />
    </svg>
  )
}

function CenterAlignmentIcon({ className = '' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <path d="M1.6 1.6h12.8" />
      <path d="M1.6 3.7h12.8" />
      <path d="M1.6 5.8h12.8" />
      <path d="M1.6 8h12.8" />
      <path d="M1.6 10.2h12.8" />
      <path d="M1.6 12.3h12.8" />
      <path d="M1.6 14.4h12.8" />
    </svg>
  )
}

function SelectionZoomIcon({ className = '' }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
      <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
    </svg>
  )
}

function StructuralVariationSignalTracks({
  theme = 'dark',
  width = 760,
  window: viewWindow,
  displayWindow = null,
  genomeId = 'target',
  tracks = [],
  genomeColor = '',
}) {
  const isLight = theme === 'light'
  const [hiddenTracks, setHiddenTracks] = useState({})
  const [fetchRevision, setFetchRevision] = useState(0)
  const [cache] = useState(() => new Map())
  const [fetchSet] = useState(() => new Set())
  const retryRef = useRef({ context: '', attempt: 0, timer: null })
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
    }
  }, [])

  const activeTracks = useMemo(
    () => (tracks || []).filter((track) => {
      const type = String(track?.type || '').toLowerCase()
      return track?.path && type === 'bigwig'
    }),
    [tracks],
  )
  const plotWidth = Math.max(1, Math.round(width || 760))
  const renderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(viewWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [viewWindow],
  )
  const geometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(viewWindow, renderWindow, plotWidth),
    [viewWindow, renderWindow, plotWidth],
  )
  const displayBins = Math.max(200, Math.min(SV_SIGNAL_RENDER_MAX_BINS, Math.floor(geometryWidth)))
  const trackHeight = SV_SIGNAL_TRACK_HEIGHT
  const totalHeight = activeTracks.length
    ? (activeTracks.length * trackHeight) + ((activeTracks.length - 1) * SV_SIGNAL_TRACK_GAP)
    : 0

  const { trackData, plans: signalFetchPlans, chrom: signalChrom } = useMemo(() => {
    void fetchRevision
    if (!activeTracks.length || !renderWindow?.chrom || !Number.isFinite(renderWindow?.start) || !Number.isFinite(renderWindow?.end)) {
      return { trackData: {}, plans: [], chrom: '' }
    }

    const chrom = String(renderWindow.chrom || '')
    const visStart = Math.max(0, Math.floor(Number(renderWindow.start) || 0))
    const visEnd = Math.max(visStart + 1, Math.ceil(Number(renderWindow.end) || (visStart + 1)))
    const span = Math.max(1, visEnd - visStart)
    const bpPerPx = span / Math.max(1, geometryWidth)
    const targetLevel = getSvSignalLevel(bpPerPx)
    const projected = {}
    const plans = []
    const center = (visStart + visEnd) / 2
    const committedSpan = Math.max(1, Number(viewWindow?.end) - Number(viewWindow?.start))
    const bufferSpan = committedSpan * 0.75
    const bufferStart = Math.max(0, visStart - bufferSpan)
    const bufferEnd = visEnd + bufferSpan

    for (const track of activeTracks) {
      const dataKey = getSvDataTrackKey(track)
      const trackKey = `${SV_AUX_TRACK_CACHE_VERSION}:${dataKey}:${track.path}`
      projected[dataKey] = projectSvSignalTilesCascade(cache, trackKey, chrom, targetLevel, visStart, visEnd, displayBins)
      const targetIndex = SV_SIGNAL_LOD_LEVELS.findIndex((level) => level.id === targetLevel.id)
      const levelsToFetch = [{ level: targetLevel, role: 'target' }]
      if (targetIndex > 0) {
        levelsToFetch.push({ level: SV_SIGNAL_LOD_LEVELS[targetIndex - 1], role: 'fallback' })
      }
      if (targetIndex > 1) {
        levelsToFetch.push({ level: SV_SIGNAL_LOD_LEVELS[0], role: 'overview' })
      }
      for (const { level, role } of levelsToFetch) {
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
          const tileKey = svSignalTileKey(trackKey, chrom, level.id, tileStart)
          if (cache.has(tileKey)) continue
          const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
          const visibleRank = tileStart < visEnd && (tileStart + tileSpan) > visStart ? 0 : 1
          plans.push({ track, trackKey, level, role, tileStart, tileEnd: tileStart + tileSpan, tileKey, visibleRank, priority: distFromCenter })
        }
      }
    }

    plans.sort((a, b) => (a.visibleRank - b.visibleRank) || (a.priority - b.priority))
    const targetPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'target'),
      targetLevel.id === SV_SIGNAL_LOD_LEVELS[0].id
        ? SV_SIGNAL_TARGET_FETCH_BATCH_SIZE + SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE + SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE
        : SV_SIGNAL_TARGET_FETCH_BATCH_SIZE,
    )
    const fallbackPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'fallback'),
      SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE,
    )
    const overviewPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'overview'),
      SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE,
    )
    return { trackData: projected, plans: [...targetPlans, ...fallbackPlans, ...overviewPlans], chrom }
  }, [
    activeTracks,
    cache,
    renderWindow,
    viewWindow,
    geometryWidth,
    displayBins,
    fetchRevision,
  ])
  // Debounced like the alignment and gene overlays: a bigwig refetch on every
  // pan is usually too quick to be worth announcing.
  const loading = useDelayedFlag(signalFetchPlans.length > 0)
  const viewportTransform = useMemo(
    () => getSvAuxTrackTransform(renderWindow, displayWindow || viewWindow, plotWidth, geometryWidth),
    [renderWindow, displayWindow, viewWindow, plotWidth, geometryWidth],
  )

  useEffect(() => {
    if (!signalFetchPlans.length || !signalChrom) {
      return undefined
    }

    const retryContext = `${signalChrom}|${genomeId}|${activeTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`
    if (retryRef.current.context !== retryContext) {
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
      retryRef.current = { context: retryContext, attempt: 0, timer: null }
    }
    const resetRetry = () => {
      retryRef.current.attempt = 0
      if (retryRef.current.timer) {
        clearTimeout(retryRef.current.timer)
        retryRef.current.timer = null
      }
    }
    const scheduleRetry = () => {
      if (!mountedRef.current || retryRef.current.timer || retryRef.current.attempt >= SV_TRANSIENT_RETRY_LIMIT) return
      retryRef.current.attempt += 1
      const delay = getSvTransientRetryDelay(retryRef.current.attempt)
      retryRef.current.timer = setTimeout(() => {
        retryRef.current.timer = null
        if (mountedRef.current) setFetchRevision((value) => value + 1)
      }, delay)
    }
    const timer = setTimeout(() => {
      const groups = new Map()
      let cacheSatisfiedPlan = false
      for (const plan of signalFetchPlans) {
        if (cache.has(plan.tileKey)) {
          cacheSatisfiedPlan = true
          continue
        }
        if (fetchSet.has(plan.tileKey)) continue
        fetchSet.add(plan.tileKey)
        const groupKey = `${plan.trackKey}|${plan.track.path}`
        if (!groups.has(groupKey)) groups.set(groupKey, { track: plan.track, plans: [] })
        groups.get(groupKey).plans.push(plan)
      }

      if (!groups.size) {
        if (mountedRef.current && cacheSatisfiedPlan) setFetchRevision((value) => value + 1)
        return
      }

      const requests = []
      for (const group of groups.values()) {
        const request = fetch(`${API_BASE}/api/browse/bigwig_batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: genomeId,
            path: group.track.path,
            chrom: signalChrom,
            tiles: group.plans.map((plan) => ({
              start: Math.max(0, Math.floor(plan.tileStart)),
              end: Math.ceil(plan.tileEnd),
              bins: plan.level.binsPerTile,
            })),
          }),
        })
          .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
          .then((payload) => {
            const tiles = Array.isArray(payload?.tiles) ? payload.tiles : []
            group.plans.forEach((plan, index) => {
              const tile = tiles[index] || {}
              cache.set(plan.tileKey, {
                start: tile?.start ?? plan.tileStart,
                end: tile?.end ?? plan.tileEnd,
                levelId: plan.level.id,
                bpPerBin: plan.level.bpPerBin,
                bins: Array.isArray(tile?.bins) ? tile.bins : [],
                has_data: !!tile?.has_data,
                error: String(tile?.error || ''),
              })
            })
            resetRetry()
            return true
          })
          .catch(() => {
            scheduleRetry()
            return false
          })
          .finally(() => {
            for (const plan of group.plans) fetchSet.delete(plan.tileKey)
          })
        requests.push(request)
      }
      Promise.all(requests).then((results) => {
        if (cache.size > 2000) {
          const toDelete = cache.size - 1600
          let removed = 0
          const detailedKeys = []
          const overviewKeys = []
          for (const [cacheKey, tile] of cache.entries()) {
            if (tile?.levelId === SV_SIGNAL_LOD_LEVELS[0].id) overviewKeys.push(cacheKey)
            else detailedKeys.push(cacheKey)
          }
          for (const cacheKey of [...detailedKeys, ...overviewKeys]) {
            if (removed >= toDelete) break
            cache.delete(cacheKey)
            removed += 1
          }
        }
        if (mountedRef.current) {
          if (results.some(Boolean)) setFetchRevision((value) => value + 1)
        }
      })
    }, SV_DATA_TRACK_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [signalFetchPlans, signalChrom, genomeId, activeTracks, cache, fetchSet])

  const signalPaths = useMemo(() => {
    const paths = {}
    for (const track of activeTracks) {
      const key = getSvDataTrackKey(track)
      paths[key] = hiddenTracks[key]
        ? ''
        : buildSvSignalPath(trackData[key]?.bins || [], geometryWidth, trackHeight)
    }
    return paths
  }, [activeTracks, hiddenTracks, trackData, geometryWidth, trackHeight])

  if (!activeTracks.length || !viewWindow) return null

  const muted = isLight ? '#5f738a' : '#8ba0b8'
  const fill = isLight ? 'rgba(37, 99, 235, 0.52)' : 'rgba(96, 165, 250, 0.58)'
  const stroke = isLight ? 'rgba(29, 78, 216, 0.9)' : 'rgba(147, 197, 253, 0.95)'
  const trackBg = isLight ? '#f8f9fa' : '#212226'
  const activeControlColor = String(genomeColor || '').trim() || (isLight ? '#2563eb' : '#3b82f6')
  const toggleX = PLOT_PAD_X + SV_SIGNAL_CONTROL_WIDTH - SV_SIGNAL_TOGGLE_RADIUS - 2

  return (
    <div
      className="w-full flex-none"
      style={{
        height: totalHeight,
        background: 'transparent',
        position: 'relative',
      }}
    >
      <svg width={plotWidth} height={totalHeight} style={{ display: 'block' }}>
        {activeTracks.map((track, index) => {
          const y = index * (trackHeight + SV_SIGNAL_TRACK_GAP)
          const key = getSvDataTrackKey(track)
          const hidden = Boolean(hiddenTracks[key])
          const path = signalPaths[key] || ''
          const controlBg = isLight ? '#e2ecfa' : '#0c172c'
          const controlText = isLight ? '#53759a' : '#9eb8d6'
          const offControl = isLight ? '#cbd5e1' : '#334155'
          return (
            <g key={key}>
              <rect x="0" y={y} width={plotWidth} height={trackHeight} fill={trackBg} />
              <line x1="0" x2={plotWidth} y1={y + trackHeight - 5} y2={y + trackHeight - 5} stroke={isLight ? 'rgba(96,125,159,0.35)' : 'rgba(139,160,184,0.24)'} strokeWidth="1" />
              {path && viewportTransform.canTransform && (
                <path
                  d={path}
                  transform={getSvAuxTrackMatrix(viewportTransform, y)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {!path && !hidden && (
                <text x={plotWidth / 2} y={y + trackHeight / 2 + 3} textAnchor="middle" fontSize="10" fill={muted}>
                  {loading ? 'Loading...' : 'No BW data'}
                </text>
              )}
              <rect x="0" y={y} width={PLOT_PAD_X + SV_SIGNAL_CONTROL_WIDTH} height={trackHeight} fill={controlBg} />
              <text x={PLOT_PAD_X + 4} y={y + trackHeight / 2} dominantBaseline="middle" fontSize="10" fontWeight="600" fill={controlText}>BW</text>
              <g
                role="button"
                tabIndex="0"
                style={{ cursor: 'pointer' }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setHiddenTracks((prev) => ({ ...prev, [key]: !prev[key] }))
                }}
              >
                <circle cx={toggleX} cy={y + trackHeight / 2} r={SV_SIGNAL_TOGGLE_RADIUS} fill={hidden ? offControl : activeControlColor} />
                <path
                  d="M 0 -7 L 0 -1 M -4.7 -3.6 A 6.2 6.2 0 1 0 4.7 -3.6"
                  transform={`translate(${toggleX} ${y + trackHeight / 2})`}
                  fill="none"
                  stroke={hidden ? (isLight ? '#475569' : '#e2e8f0') : '#ffffff'}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </g>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function StructuralVariationRibbonOverlay({
  theme = 'dark',
  width = 760,
  height = ALIGNMENT_PANEL_HEIGHT,
  referenceWindow = null,
  targetWindow = null,
  displayReferenceWindow = null,
  displayTargetWindow = null,
  referenceTracks = [],
  targetTracks = [],
  referenceGenomeId = 'reference',
  targetGenomeId = 'target',
  displayOrder = 'reference-top',
}) {
  const isLight = theme === 'light'
  const [clickedFeature, setClickedFeature] = useState(null)
  const [copyToast, setCopyToast] = useState('')
  const [fetchRevision, setFetchRevision] = useState(0)
  const [cache] = useState(() => new Map())
  const [fetchSet] = useState(() => new Set())
  const popupCloseTimerRef = useRef(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refTracks = useMemo(
    () => (referenceTracks || []).filter((track) => String(track?.type || '').toLowerCase() === 'bigbed' && track?.path),
    [referenceTracks],
  )
  const tgtTracks = useMemo(
    () => (targetTracks || []).filter((track) => String(track?.type || '').toLowerCase() === 'bigbed' && track?.path),
    [targetTracks],
  )
  const refSignature = useMemo(() => `${SV_AUX_TRACK_CACHE_VERSION}|${refTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`, [refTracks])
  const tgtSignature = useMemo(() => `${SV_AUX_TRACK_CACHE_VERSION}|${tgtTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`, [tgtTracks])
  const plotWidth = Math.max(1, Math.round(width || 760))
  const safeHeight = Math.max(72, Math.round(height || ALIGNMENT_PANEL_HEIGHT))
  const referenceRenderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(referenceWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [referenceWindow],
  )
  const targetRenderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(targetWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [targetWindow],
  )
  const referenceGeometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(referenceWindow, referenceRenderWindow, plotWidth),
    [referenceWindow, referenceRenderWindow, plotWidth],
  )
  const targetGeometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(targetWindow, targetRenderWindow, plotWidth),
    [targetWindow, targetRenderWindow, plotWidth],
  )

  const { trackData, plans: ribbonFetchPlans } = useMemo(() => {
    void fetchRevision
    const sides = [
      { side: 'reference', genomeId: referenceGenomeId, window: referenceRenderWindow, viewWindow: referenceWindow, tracks: refTracks },
      { side: 'target', genomeId: targetGenomeId, window: targetRenderWindow, viewWindow: targetWindow, tracks: tgtTracks },
    ]
    const projected = {}
    const plans = []

    for (const sideInfo of sides) {
      const win = sideInfo.window
      if (!win?.chrom || !Number.isFinite(win?.start) || !Number.isFinite(win?.end)) continue
      const visStart = Math.max(0, Math.floor(Number(win.start) || 0))
      const visEnd = Math.max(visStart + 1, Math.ceil(Number(win.end) || (visStart + 1)))
      const viewSpan = Math.max(1, Number(sideInfo.viewWindow?.end) - Number(sideInfo.viewWindow?.start))
      if (viewSpan > SV_RIBBON_INTERVAL_MAX_VIEW_SPAN) continue
      const chrom = String(win.chrom || '')
      const center = (visStart + visEnd) / 2
      const bufferSpan = Math.max(
        viewSpan * SV_BIGBED_DETAIL_PREFETCH_RATIO,
        SV_BIGBED_FEATURE_TILE_SPAN * SV_BIGBED_DETAIL_PREFETCH_MIN_TILES,
      )
      const bufferStart = Math.max(0, visStart - bufferSpan)
      const bufferEnd = visEnd + bufferSpan

      for (const track of sideInfo.tracks) {
        const trackKey = `${SV_AUX_TRACK_CACHE_VERSION}:${sideInfo.side}:${getSvDataTrackKey(track)}:${track.path}`
        projected[trackKey] = {
          ...projectSvRibbonFeatureTiles(cache, trackKey, chrom, visStart, visEnd),
          side: sideInfo.side,
          track,
          chrom,
        }
        const firstTile = Math.floor(bufferStart / SV_BIGBED_FEATURE_TILE_SPAN) * SV_BIGBED_FEATURE_TILE_SPAN
        const lastTile = Math.floor((bufferEnd - 1) / SV_BIGBED_FEATURE_TILE_SPAN) * SV_BIGBED_FEATURE_TILE_SPAN
        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += SV_BIGBED_FEATURE_TILE_SPAN) {
          const tileEnd = tileStart + SV_BIGBED_FEATURE_TILE_SPAN
          const tileKey = svBigBedFeatureTileKey(trackKey, chrom, tileStart, tileEnd)
          if (cache.has(tileKey)) continue
          const distFromCenter = Math.abs((tileStart + SV_BIGBED_FEATURE_TILE_SPAN / 2) - center)
          plans.push({ ...sideInfo, track, trackKey, chrom, tileStart, tileEnd, tileKey, priority: distFromCenter })
        }
      }
    }

    plans.sort((a, b) => a.priority - b.priority)
    return {
      trackData: projected,
      plans: selectSvFetchPlansFairly(
        plans,
        SV_BIGBED_DETAIL_FETCH_BATCH_SIZE,
        SV_BIGBED_DETAIL_FETCH_PER_TRACK,
      ),
    }
  }, [
    refTracks,
    tgtTracks,
    cache,
    referenceWindow,
    targetWindow,
    referenceRenderWindow,
    targetRenderWindow,
    referenceGenomeId,
    targetGenomeId,
    fetchRevision,
  ])

  useEffect(() => {
    setClickedFeature(null)
  }, [
    referenceWindow?.chrom,
    referenceWindow?.start,
    referenceWindow?.end,
    targetWindow?.chrom,
    targetWindow?.start,
    targetWindow?.end,
    displayReferenceWindow?.chrom,
    displayReferenceWindow?.start,
    displayReferenceWindow?.end,
    displayTargetWindow?.chrom,
    displayTargetWindow?.start,
    displayTargetWindow?.end,
    refSignature,
    tgtSignature,
  ])

  useEffect(() => {
    if (!ribbonFetchPlans.length) return undefined
    const timer = setTimeout(() => {
      const groups = new Map()
      let cacheSatisfiedPlan = false
      for (const plan of ribbonFetchPlans) {
        if (cache.has(plan.tileKey)) {
          cacheSatisfiedPlan = true
          continue
        }
        if (fetchSet.has(plan.tileKey)) continue
        fetchSet.add(plan.tileKey)
        const groupKey = `${plan.trackKey}|${plan.chrom}`
        if (!groups.has(groupKey)) groups.set(groupKey, { plan, keys: [], tiles: [] })
        const group = groups.get(groupKey)
        group.keys.push(plan.tileKey)
        group.tiles.push({
          start: Math.max(0, Math.floor(plan.tileStart)),
          end: Math.ceil(plan.tileEnd),
          level_id: 'detail',
          max_features: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
        })
      }

      if (!groups.size) {
        if (mountedRef.current && cacheSatisfiedPlan) setFetchRevision((value) => value + 1)
        return
      }

      const requests = []
      for (const { plan, keys, tiles } of groups.values()) {
        const request = fetch(`${API_BASE}/api/browse/bigbed/feature_tiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: plan.genomeId,
            path: plan.track.path,
            chrom: plan.chrom,
            max_features_per_tile: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
            tiles,
          }),
        })
          .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
          .then((payload) => {
            const returnedChrom = payload?.chrom || plan.chrom
            const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
            for (const tile of returned) {
              const tileStart = Math.max(0, Math.floor(Number(tile?.start) || 0))
              const tileEnd = Math.max(tileStart + 1, Math.ceil(Number(tile?.end) || 1))
              const cachedTile = {
                ...(tile || {}),
                mode: 'bigbed_detail',
                start: tileStart,
                end: tileEnd,
                features: Array.isArray(tile?.features) ? tile.features.map(svNormalizeBigBedFeature).filter(Boolean) : [],
                has_data: tile?.has_data !== false,
                error: '',
              }
              cache.set(svBigBedFeatureTileKey(plan.trackKey, plan.chrom, tileStart, tileEnd), cachedTile)
              if (returnedChrom !== plan.chrom) {
                cache.set(svBigBedFeatureTileKey(plan.trackKey, returnedChrom, tileStart, tileEnd), cachedTile)
              }
            }
            return true
          })
          .catch(() => false)
          .finally(() => {
            for (const key of keys) fetchSet.delete(key)
          })
        requests.push(request)
      }
      if (requests.length) {
        Promise.all(requests).then((results) => {
          trimSvRibbonFeatureCache(cache)
          if (mountedRef.current && results.some(Boolean)) {
            setFetchRevision((value) => value + 1)
          }
        })
      }
    }, SV_DATA_TRACK_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ribbonFetchPlans, cache, fetchSet])

  const clearPopupCloseTimer = useCallback(() => {
    if (popupCloseTimerRef.current) {
      clearTimeout(popupCloseTimerRef.current)
      popupCloseTimerRef.current = null
    }
  }, [])

  const schedulePopupClose = useCallback((delay = 140) => {
    clearPopupCloseTimer()
    popupCloseTimerRef.current = setTimeout(() => {
      popupCloseTimerRef.current = null
      setClickedFeature(null)
    }, delay)
  }, [clearPopupCloseTimer])

  useEffect(() => {
    if (!clickedFeature) {
      clearPopupCloseTimer()
      return undefined
    }
    const clearIfAway = (event) => {
      const target = event.target
      if (target?.closest?.('[data-sv-ribbon-interval="true"]') || target?.closest?.('[data-sv-metadata-popup="true"]')) {
        clearPopupCloseTimer()
        return
      }
      if (event.type === 'pointerdown') {
        clearPopupCloseTimer()
        setClickedFeature(null)
        return
      }
      schedulePopupClose()
    }
    window.addEventListener('pointerdown', clearIfAway, true)
    window.addEventListener('mousemove', clearIfAway, true)
    return () => {
      window.removeEventListener('pointerdown', clearIfAway, true)
      window.removeEventListener('mousemove', clearIfAway, true)
      clearPopupCloseTimer()
    }
  }, [clickedFeature, clearPopupCloseTimer, schedulePopupClose])

  useEffect(() => {
    if (!copyToast) return undefined
    const timer = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(timer)
  }, [copyToast])

  const copyToClipboard = useCallback(async (text, label = 'value') => {
    const payload = String(text || '').trim()
    if (!payload) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload)
        setCopyToast(`Copied ${label}`)
      } else {
        setCopyToast('Clipboard unavailable')
      }
    } catch {
      setCopyToast('Copy failed')
    }
  }, [])

  const topSide = displayOrder === 'alt-top' ? 'target' : 'reference'
  const markerHeight = Math.max(4, Math.min(6, Math.round(safeHeight * 6 / 159)))
  const rulerHeight = Math.max(10, Math.min(12, Math.round(safeHeight * 12 / 159)))
  const topY = rulerHeight + markerHeight + 2
  const bottomY = safeHeight - rulerHeight - (markerHeight * 2) - 2
  const referenceFill = isLight ? 'rgba(20, 184, 166, 0.78)' : 'rgba(45, 212, 191, 0.74)'
  const targetFill = isLight ? 'rgba(16, 185, 129, 0.76)' : 'rgba(52, 211, 153, 0.72)'
  const referenceStroke = isLight ? 'rgba(15, 118, 110, 0.95)' : 'rgba(153, 246, 228, 0.95)'
  const targetStroke = isLight ? 'rgba(4, 120, 87, 0.95)' : 'rgba(167, 243, 208, 0.95)'

  const renderSide = useCallback((side, win, geometryWidth, lodSpan) => {
    if (!win?.chrom) return []
    if (lodSpan > SV_RIBBON_INTERVAL_MAX_VIEW_SPAN) return []
    const y = side === topSide ? topY : bottomY
    const fill = side === 'reference' ? referenceFill : targetFill
    const stroke = side === 'reference' ? referenceStroke : targetStroke
    const rects = []
    for (const [trackKey, data] of Object.entries(trackData)) {
      if (data?.side !== side || !Array.isArray(data?.features)) continue
      const marks = buildSvRibbonIntervalMarks(data.features, win, geometryWidth, lodSpan)
      const mergedPath = []
      const clickableRects = []
      for (const [index, mark] of marks.entries()) {
        const feature = mark.features.length === 1 ? mark.features[0] : null
        const start = Number(feature?.start ?? mark.start)
        const end = Number(feature?.end ?? mark.end)
        const featureKey = `${trackKey}|${start}|${end}|${index}|${mark.features.length}`
        if (!feature) {
          const markWidth = Math.max(1, mark.w)
          mergedPath.push(`M ${mark.x} ${y} h ${markWidth} v ${markerHeight} h ${-markWidth} Z`)
          continue
        }
        clickableRects.push(
          <rect
            key={featureKey}
            data-sv-ribbon-interval="true"
            x={mark.x}
            y={y}
            width={Math.max(1, mark.w)}
            height={markerHeight}
            rx="1"
            fill={fill}
            stroke={stroke}
            strokeWidth="0.75"
            opacity="0.9"
            style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setClickedFeature({
                trackLabel: getSvDataTrackLabel(data.track),
                side,
                chrom: win.chrom,
                feature,
                popupX: event.clientX,
                popupY: event.clientY,
              })
            }}
          />,
        )
      }
      if (mergedPath.length) {
        rects.push(
          <path
            key={`${trackKey}|merged`}
            d={mergedPath.join(' ')}
            fill={fill}
            stroke={stroke}
            strokeWidth="0.75"
            opacity="0.62"
            style={{ pointerEvents: 'none' }}
          />,
        )
      }
      rects.push(...clickableRects)
    }
    return rects
  }, [bottomY, markerHeight, referenceFill, referenceStroke, targetFill, targetStroke, topSide, topY, trackData])

  const referenceIntervalRects = useMemo(
    () => renderSide(
      'reference',
      referenceRenderWindow,
      referenceGeometryWidth,
      Math.max(1, Number(referenceWindow?.end) - Number(referenceWindow?.start)),
    ),
    [referenceWindow, referenceRenderWindow, referenceGeometryWidth, renderSide],
  )
  const targetIntervalRects = useMemo(
    () => renderSide(
      'target',
      targetRenderWindow,
      targetGeometryWidth,
      Math.max(1, Number(targetWindow?.end) - Number(targetWindow?.start)),
    ),
    [targetWindow, targetRenderWindow, targetGeometryWidth, renderSide],
  )
  const referenceTransform = useMemo(
    () => getSvAuxTrackTransform(referenceRenderWindow, displayReferenceWindow || referenceWindow, plotWidth, referenceGeometryWidth),
    [referenceRenderWindow, displayReferenceWindow, referenceWindow, plotWidth, referenceGeometryWidth],
  )
  const targetTransform = useMemo(
    () => getSvAuxTrackTransform(targetRenderWindow, displayTargetWindow || targetWindow, plotWidth, targetGeometryWidth),
    [targetRenderWindow, displayTargetWindow, targetWindow, plotWidth, targetGeometryWidth],
  )
  if (!referenceIntervalRects.length && !targetIntervalRects.length && !clickedFeature) return null

  return (
    <>
      <svg
        width={plotWidth}
        height={safeHeight}
        className="absolute inset-0 z-10"
        style={{ display: 'block', pointerEvents: 'none' }}
      >
        {referenceTransform.canTransform && (
          <g transform={getSvAuxTrackMatrix(referenceTransform)}>{referenceIntervalRects}</g>
        )}
        {targetTransform.canTransform && (
          <g transform={getSvAuxTrackMatrix(targetTransform)}>{targetIntervalRects}</g>
        )}
      </svg>
      {clickedFeature && (() => {
        const f = clickedFeature.feature || {}
        const popupW = 280
        const arrowSize = 8
        const gap = 4
        const popupX = clamp(clickedFeature.popupX || 0, popupW / 2 + 8, (typeof window !== 'undefined' ? window.innerWidth : popupW + 16) - popupW / 2 - 8)
        const popupY = Math.max(8, (clickedFeature.popupY || 0) - arrowSize - gap)
        const rows = buildCuratedSvIntervalRows(f, {
          trackLabel: clickedFeature.trackLabel,
          side: clickedFeature.side,
          chrom: clickedFeature.chrom,
        })
          .map(([name, value]) => [name, abbreviateMetadataValue(value)])
        return (
          <div
            data-sv-metadata-popup="true"
            className="fixed z-50 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
              left: popupX,
              top: popupY,
              transform: 'translate(-50%, -100%)',
              width: popupW,
              backgroundColor: 'rgba(17, 24, 39, 0.97)',
              color: '#f1f5f9',
              padding: '10px 14px',
              border: '1px solid rgba(255,255,255,0.1)',
              pointerEvents: 'auto',
              overflowWrap: 'break-word',
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={clearPopupCloseTimer}
            onMouseMove={(event) => {
              event.stopPropagation()
              clearPopupCloseTimer()
            }}
            onMouseLeave={() => {
              clearPopupCloseTimer()
              setClickedFeature(null)
            }}
          >
            <div
              style={{
                position: 'absolute',
                bottom: -arrowSize,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                borderLeft: `${arrowSize}px solid transparent`,
                borderRight: `${arrowSize}px solid transparent`,
              }}
            />
            {rows.map(([name, value]) => (
              <div key={name} className="flex min-w-0 items-start gap-1.5">
                <span className="shrink-0" style={{ color: '#93c5fd', fontWeight: 700 }}>{name}: </span>
                <span className="min-w-0 flex-1 break-all">{value.display}</span>
                {value.abbreviated && (
                  <button
                    type="button"
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-500/70 text-slate-100 hover:bg-slate-700"
                    title={`Copy full ${String(name || 'value').toLowerCase()}`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      copyToClipboard(value.full, String(name || 'value').toLowerCase())
                    }}
                  >
                    <CopyGlyph />
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })()}
      {copyToast && (
        <div className="fixed bottom-6 left-1/2 z-[150] -translate-x-1/2 rounded-lg border border-sky-500/70 bg-gray-800 px-3 py-1.5 text-xs font-semibold text-sky-200 shadow-xl">
          {copyToast}
        </div>
      )}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────
function StructuralVariationThreeGenomeView({
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

/** Render genome options grouped by whether they can be used.
 *
 * Genomes with no local data are listed rather than hidden, so a config naming a
 * genome that has not been downloaded explains itself instead of quietly producing
 * a shorter list than the file suggests.
 */
function renderSvGenomeOptionGroups(options, slot) {
  return ['selected', 'add', 'missing'].map((state) => {
    const group = (options || []).filter((option) => option.state === state)
    if (!group.length) return null
    return (
      <optgroup key={`${slot}-${state}`} label={SV_GENOME_GROUP_LABELS[state]}>
        {group.map((option) => (
          <option
            key={`${slot}-${option.value}`}
            value={option.value}
            disabled={option.disabled}
            title={getSvOptionTooltip(option)}
          >
            {formatSvGenomeOptionLabel(option)}
          </option>
        ))}
      </optgroup>
    )
  })
}

function StructuralVariationChooser({
  theme,
  catalog,
  catalogLoading,
  catalogError,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  selectedSecondAlignment,
  selectedThirdAlignment,
  anchorRegionOptions = [],
  selectedAnchorRegionId = '',
  regionExplicitlySelected = false,
  onAnchorRegionChange = null,
  onAnchorRegionSearch = null,
  onGenomeOrderChange,
  onOpenGenomeSelector,
  onRegisteredAlignment,
  onRemoveAlignment,
  outputDir,
}) {
  const isLight = theme === 'light'
  const [locationInput, setLocationInput] = useState('')
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])

  const activeKeys = useMemo(() => new Set(activeSpecies.map((species) => svSpeciesSelectionKey(species))), [activeSpecies])
  const selectedKeys = useMemo(() => new Set(
    dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies]).map((species) => svSpeciesSelectionKey(species)),
  ), [activeSpecies, inactiveSpecies])
  const anchorOptions = useMemo(() => {
    // Every genome that anchors at least one usable alignment, whether or not it is
    // in the top bar. Restricting this to the top bar meant loading a config
    // appeared to do nothing: its genomes were known but could not be chosen.
    const seen = new Set()
    const anchorGenomes = []
    for (const alignment of catalog?.alignments || []) {
      if (!alignment?.supported) continue
      const genome = alignment.reference_genome
      const id = String(genome?.id || '')
      if (!genome || (id && seen.has(id))) continue
      if (id) seen.add(id)
      anchorGenomes.push(genome)
    }
    return buildSvGenomeOptions(anchorGenomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming)
  }, [catalog, knownSpecies, selectedKeys, activeKeys])

  const outgoingAlignments = useMemo(() => getOutgoingSvAlignments(catalog, anchorSpecies), [catalog, anchorSpecies])
  const hasSelectedAnchorRegion = Boolean(selectedAnchorRegionId && regionExplicitlySelected)
  const selectedAnchorRegionOption = useMemo(() => {
    return (anchorRegionOptions || []).find((region) => getSvRegionKey(region) === selectedAnchorRegionId) || null
  }, [anchorRegionOptions, selectedAnchorRegionId])
  const targetOptions = useMemo(() => {
    if (!hasSelectedAnchorRegion) return []
    const seen = new Set()
    const genomes = []
    const alignmentByGenomeId = new Map()
    for (const alignment of outgoingAlignments) {
      const genome = alignment?.target_genome
      if (!genome?.id || seen.has(genome.id)) continue
      // A genome that is not downloaded has no sequence names to intersect, so its
      // alignments list no regions and the region filter would drop it silently.
      // Keep it: the option is disabled anyway, and a config's genome explaining
      // why it cannot be used beats it simply not being there.
      const regionUnknowable = !genome.local
      if (selectedAnchorRegionId && !regionUnknowable && !alignmentSupportsAnchorRegion(alignment, selectedAnchorRegionId)) continue
      seen.add(genome.id)
      genomes.push(genome)
      alignmentByGenomeId.set(genome.id, alignment)
    }
    return buildSvGenomeOptions(genomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming).map((option) => {
      const alignment = alignmentByGenomeId.get(String(option.genome?.id || '')) || null
      const supported = Boolean(alignment?.supported)
      return {
        ...option,
        alignment,
        supported,
        disabled: option.disabled || !supported,
      }
    })
  }, [outgoingAlignments, knownSpecies, activeKeys, selectedKeys, selectedAnchorRegionId, hasSelectedAnchorRegion])

  const optionByValue = useMemo(() => {
    const map = new Map()
    for (const option of [...anchorOptions, ...targetOptions]) {
      map.set(option.value, option)
    }
    return map
  }, [anchorOptions, targetOptions])

  const selectedAnchorValue = anchorSpecies ? `species:${svSpeciesSelectionKey(anchorSpecies)}` : ''
  const selectedSecondValue = secondSpecies ? `species:${svSpeciesSelectionKey(secondSpecies)}` : ''
  const selectedThirdValue = thirdSpecies ? `species:${svSpeciesSelectionKey(thirdSpecies)}` : ''
  const selectedAnchorOption = optionByValue.get(selectedAnchorValue)
  const selectedSecondOption = optionByValue.get(selectedSecondValue)
  const selectedThirdOption = optionByValue.get(selectedThirdValue)

  const promoteOrder = useCallback((nextAnchor, nextSecond, nextThird, options = {}) => {
    const ordered = dedupeSvSpeciesList([nextAnchor, nextSecond, nextThird])
    const slotOptions = {
      anchorKey: nextAnchor ? svSpeciesSelectionKey(nextAnchor) : '',
      secondKey: nextSecond ? svSpeciesSelectionKey(nextSecond) : '',
      thirdKey: nextThird ? svSpeciesSelectionKey(nextThird) : '',
      regionId: selectedAnchorRegionId,
      regionExplicitlySelected: hasSelectedAnchorRegion,
      ...options,
    }
    onGenomeOrderChange?.(ordered, slotOptions)
  }, [hasSelectedAnchorRegion, onGenomeOrderChange, selectedAnchorRegionId])

  const handleAnchorChange = useCallback((value) => {
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    const nextAnchor = option.species
    promoteOrder(nextAnchor, null, null, {
      deactivateSpecies: anchorSpecies ? [anchorSpecies] : [],
      anchorKey: svSpeciesSelectionKey(nextAnchor),
      secondKey: '',
      thirdKey: '',
      clearRegion: true,
    })
  }, [anchorSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleTargetChange = useCallback((slot, value) => {
    if (!value) {
      if (slot === 'second') {
        const promotedThird = thirdSpecies || null
        promoteOrder(
          anchorSpecies,
          promotedThird,
          null,
          {
            deactivateSpecies: secondSpecies ? [secondSpecies] : [],
            secondKey: promotedThird ? svSpeciesSelectionKey(promotedThird) : '',
            thirdKey: '',
          },
        )
      } else {
        promoteOrder(
          anchorSpecies,
          secondSpecies,
          null,
          {
            deactivateSpecies: thirdSpecies ? [thirdSpecies] : [],
            thirdKey: '',
          },
        )
      }
      return
    }
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    if (slot === 'second') {
      const nextThird = thirdSpecies && svSpeciesSelectionKey(thirdSpecies) !== svSpeciesSelectionKey(option.species) ? thirdSpecies : null
      promoteOrder(anchorSpecies, option.species, nextThird)
    } else {
      promoteOrder(anchorSpecies, secondSpecies, option.species)
    }
  }, [anchorSpecies, secondSpecies, thirdSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleAvailableAlignmentAction = useCallback((row, action) => {
    if (!row) return
    if (action === 'download_reference' || action === 'download_target') {
      onOpenGenomeSelector?.()
      return
    }
    if (action === 'remove') {
      onRemoveAlignment?.(row)
      return
    }
    if (action === 'add_reference_inactive' || action === 'add_target_inactive') {
      const species = action === 'add_reference_inactive'
        ? row.reference?.species
        : row.target?.species
      if (!species) return
      promoteOrder(null, null, null, {
        allowEmpty: true,
        deactivateSpecies: [species],
        anchorKey: anchorSpecies ? svSpeciesSelectionKey(anchorSpecies) : '',
        secondKey: secondSpecies ? svSpeciesSelectionKey(secondSpecies) : '',
        thirdKey: thirdSpecies ? svSpeciesSelectionKey(thirdSpecies) : '',
        regionId: selectedAnchorRegionId,
        regionExplicitlySelected: hasSelectedAnchorRegion,
      })
      return
    }

    const referenceSpecies = row.reference?.species || null
    const targetSpecies = row.target?.species || null
    if (!referenceSpecies || !targetSpecies || action !== 'use') return
    const regions = Array.isArray(row.alignment?.reference_regions) ? row.alignment.reference_regions : []
    const largestRegion = regions.reduce((best, region) => {
      if (!best) return region
      return getSvRegionLength(region) > getSvRegionLength(best) ? region : best
    }, null)
    const largestRegionId = getSvRegionKey(largestRegion)

    promoteOrder(referenceSpecies, targetSpecies || null, null, {
      anchorKey: svSpeciesSelectionKey(referenceSpecies),
      secondKey: targetSpecies ? svSpeciesSelectionKey(targetSpecies) : '',
      thirdKey: '',
      regionId: largestRegionId || selectedAnchorRegionId,
      regionExplicitlySelected: Boolean(largestRegionId) || hasSelectedAnchorRegion,
    })
  }, [anchorSpecies, hasSelectedAnchorRegion, onOpenGenomeSelector, onRemoveAlignment, promoteOrder, secondSpecies, selectedAnchorRegionId, thirdSpecies])

  useEffect(() => {
    if (catalogLoading || !anchorSpecies) return
    if (!hasSelectedAnchorRegion) {
      if (secondSpecies || thirdSpecies) {
        promoteOrder(anchorSpecies, null, null, { secondKey: '', thirdKey: '' })
      }
      return
    }
    const activeOrder = new Map((activeSpecies || []).map((species, index) => [svSpeciesSelectionKey(species), index]))
    const validTargetOptions = targetOptions
      .filter((option) => option.species && option.isSelected && !option.disabled)
      .sort((a, b) => {
        const aOrder = activeOrder.has(svSpeciesSelectionKey(a.species)) ? activeOrder.get(svSpeciesSelectionKey(a.species)) : 999
        const bOrder = activeOrder.has(svSpeciesSelectionKey(b.species)) ? activeOrder.get(svSpeciesSelectionKey(b.species)) : 999
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.label.localeCompare(b.label)
      })
    const secondIsValid = secondSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, secondSpecies))
    const thirdIsValid = thirdSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, thirdSpecies))
    let nextSecond = secondIsValid ? secondSpecies : null
    let nextThird = thirdIsValid ? thirdSpecies : null
    if (!nextSecond && nextThird) {
      nextSecond = nextThird
      nextThird = null
    }
    if (nextSecond && nextThird && svSpeciesSelectionKey(nextSecond) === svSpeciesSelectionKey(nextThird)) {
      nextThird = null
    }
    const nextSecondKey = svSpeciesSelectionKey(nextSecond)
    const nextThirdKey = svSpeciesSelectionKey(nextThird)
    if (svSpeciesSelectionKey(secondSpecies) === nextSecondKey && svSpeciesSelectionKey(thirdSpecies) === nextThirdKey) return
    promoteOrder(anchorSpecies, nextSecond, nextThird)
  }, [
    anchorSpecies,
    secondSpecies,
    thirdSpecies,
    selectedAnchorRegionId,
    hasSelectedAnchorRegion,
    targetOptions,
    activeSpecies,
    promoteOrder,
    catalogLoading,
  ])

  const handleLocationSubmit = useCallback((event) => {
    event?.preventDefault?.()
    const query = String(locationInput || '').trim()
    if (!query) return
    const ok = onAnchorRegionSearch?.(query)
    if (ok === false) {
      setLocationInput('')
    }
  }, [locationInput, onAnchorRegionSearch])

  const unavailableSelected = [
    selectedSecondAlignment && !selectedSecondAlignment.supported ? selectedSecondAlignment : null,
    selectedThirdAlignment && !selectedThirdAlignment.supported ? selectedThirdAlignment : null,
  ].filter(Boolean)
  const missingCatalogRows = (catalog?.alignments || []).filter((alignment) => !alignment?.supported)
  const bandClass = isLight ? 'border-gray-200 bg-gray-50 text-gray-900' : 'border-gray-700 bg-[#152033] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = `h-4 text-xs font-semibold leading-4 ${mutedClass}`
  const controlBaseClass = 'h-8 min-w-[220px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border py-0 pl-2 pr-8 text-sm leading-tight'
  const selectClass = `${controlBaseClass} ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const disabledSelectClass = `${controlBaseClass} opacity-65 cursor-not-allowed ${
    isLight ? 'border-gray-200 bg-gray-100 text-gray-500' : 'border-gray-700 bg-slate-800 text-gray-500'
  }`
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const thirdTargetOptions = targetOptions.filter((option) => option.value !== selectedSecondValue)
  const secondSelectDisabled = !anchorSpecies || !hasSelectedAnchorRegion
  const thirdSelectDisabled = secondSelectDisabled || !selectedSecondValue || (!selectedThirdValue && !thirdTargetOptions.some((option) => !option.disabled))

  return (
    <div className={`border ${bandClass} px-3 py-2`}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(220px,260px)_minmax(220px,260px)_minmax(260px,360px)_minmax(300px,1fr)] md:items-end">
        <label className={`${fieldClass} md:col-start-1 md:row-start-1`}>
          <span className={fieldLabelClass}>Anchor</span>
          <select className={selectClass} value={selectedAnchorValue} title={getSvOptionTooltip(selectedAnchorOption)} onChange={(event) => handleAnchorChange(event.target.value)}>
            {!selectedAnchorValue && <option value="">Select anchor</option>}
            {renderSvGenomeOptionGroups(anchorOptions, 'anchor')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-1`}>
          <span className={fieldLabelClass}>Region</span>
          <select
            className={selectClass}
            value={hasSelectedAnchorRegion ? selectedAnchorRegionId : ''}
            title={selectedAnchorRegionOption ? `Anchor region ${selectedAnchorRegionOption.label || selectedAnchorRegionOption.chrom}` : ''}
            onChange={(event) => onAnchorRegionChange?.(event.target.value)}
            disabled={!anchorRegionOptions.length}
          >
            {anchorRegionOptions.length > 0 && <option value="">Select</option>}
            {!anchorRegionOptions.length && <option value="">No aligned regions</option>}
            {hasSelectedAnchorRegion && selectedAnchorRegionId && !selectedAnchorRegionOption && (
              <option value={selectedAnchorRegionId}>{selectedAnchorRegionId}</option>
            )}
            {anchorRegionOptions.map((region) => {
              const key = getSvRegionKey(region)
              const availabilityLabel = formatSvRegionAvailabilityLabel(region, outgoingAlignments)
              return (
                <option key={key} value={key}>
                  {region.label || region.chrom || key}{availabilityLabel ? ` (${availabilityLabel})` : ''}
                </option>
              )
            })}
          </select>
        </label>

        <form className={`${fieldClass} md:col-start-3 md:row-start-1`} onSubmit={handleLocationSubmit}>
          <span className={fieldLabelClass}>Location</span>
          <div className="flex h-8 gap-2">
            <input
              className={`h-8 min-w-0 flex-1 rounded border px-2 text-sm leading-tight ${
                isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
              }`}
              value={locationInput}
              placeholder=""
              onChange={(event) => setLocationInput(event.target.value)}
            />
            <button type="submit" className={buttonClass}>
              Go
            </button>
          </div>
        </form>

        <label className={`${fieldClass} md:col-start-1 md:row-start-2`}>
          <span className={fieldLabelClass}>Second</span>
          <select className={secondSelectDisabled ? disabledSelectClass : selectClass} value={selectedSecondValue} title={getSvOptionTooltip(selectedSecondOption)} onChange={(event) => handleTargetChange('second', event.target.value)} disabled={secondSelectDisabled}>
            <option value="">{selectedSecondValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(targetOptions, 'second')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-2`}>
          <span className={fieldLabelClass}>Third</span>
          <select className={thirdSelectDisabled ? disabledSelectClass : selectClass} value={selectedThirdValue} title={getSvOptionTooltip(selectedThirdOption)} onChange={(event) => handleTargetChange('third', event.target.value)} disabled={thirdSelectDisabled}>
            <option value="">{selectedThirdValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(thirdTargetOptions, 'third')}
          </select>
        </label>

        <StructuralVariationRegistrationForm
          className="md:col-start-3 md:col-span-2 md:row-start-2"
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={hasSelectedAnchorRegion}
          outputDir={outputDir}
          onRegistered={onRegisteredAlignment}
          onAvailableAlignmentAction={handleAvailableAlignmentAction}
          onOpenGenomeSelector={onOpenGenomeSelector}
        />
      </div>

      {catalogError && (
        <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${mutedClass}`}>
          <span className={isLight ? 'text-red-600' : 'text-red-300'}>{catalogError}</span>
        </div>
      )}

      {targetOptions.some((option) => !option.species && option.genome?.downloadable) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {targetOptions.filter((option) => !option.species && option.genome?.downloadable).map((option) => (
            <button key={`download-${option.value}`} type="button" className={buttonClass} onClick={() => onOpenGenomeSelector?.()}>
              Download {option.label}
            </button>
          ))}
        </div>
      )}

      {(unavailableSelected.length > 0 || missingCatalogRows.length > 0) && (
        <div className={`mt-2 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
          {unavailableSelected.length > 0
            ? unavailableSelected.map((alignment) => `${alignment.label || alignment.id}: ${(alignment.missing_files || []).join(', ')}`).join(' | ')
            : `${missingCatalogRows.length} alignment${missingCatalogRows.length === 1 ? '' : 's'} have missing BigChain or mapping files.`}
        </div>
      )}
    </div>
  )
}

function AvailableSvAlignmentsPanel({
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  onAction,
}) {
  const isLight = theme === 'light'
  const [expandedRows, setExpandedRows] = useState({})
  const rows = useMemo(
    () => buildAvailableSvAlignmentRows(catalog, activeSpecies, inactiveSpecies),
    [catalog, activeSpecies, inactiveSpecies],
  )
  const fullyActiveKeys = useMemo(() => {
    const keys = []
    if (anchorSpecies) keys.push(svSpeciesSelectionKey(anchorSpecies))
    if (regionExplicitlySelected && secondSpecies) keys.push(svSpeciesSelectionKey(secondSpecies))
    if (regionExplicitlySelected && thirdSpecies) keys.push(svSpeciesSelectionKey(thirdSpecies))
    return new Set(keys.filter(Boolean))
  }, [anchorSpecies, regionExplicitlySelected, secondSpecies, thirdSpecies])

  const panelClass = isLight
    ? 'border-gray-200 bg-white text-gray-900'
    : 'border-gray-700 bg-[#111827] text-gray-100'
  const tableGridClass = 'md:grid-cols-[28px_minmax(360px,3fr)_minmax(220px,1.6fr)_88px_110px_150px]'
  const rowClass = `grid gap-2 border-b px-3 py-2 text-xs transition-colors ${tableGridClass} md:items-center ${
    isLight
      ? 'border-gray-100 hover:bg-gray-50'
      : 'border-gray-700/70 hover:bg-slate-800/70'
  }`
  const detailClass = isLight ? 'border-gray-100 bg-gray-50 text-gray-700' : 'border-gray-700 bg-slate-900/70 text-gray-300'
  const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const strongClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const buttonClass = `inline-flex h-7 items-center justify-center rounded border px-2 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700 disabled:bg-slate-800 disabled:text-gray-500'
  }`
  const statusClass = (status) => {
    if (status === 'usable') return isLight ? 'text-emerald-700' : 'text-emerald-300'
    if (status === 'downloadable') return isLight ? 'text-blue-700' : 'text-blue-300'
    if (status === 'missing_files') return isLight ? 'text-amber-700' : 'text-amber-300'
    return isLight ? 'text-gray-500' : 'text-gray-400'
  }
  const formatGenome = (state) => state.species
    ? getSpeciesDisplayName(state.species)
    : getSvCatalogGenomeDisplayName(state.genome)
  const formatGenomeTooltip = (state) => {
    const genome = state.genome || state.species || {}
    const label = formatGenome(state)
    const accession = getSvGenomeAccessionLabel(genome)
    const aliases = Array.isArray(genome.aliases) ? genome.aliases : []
    return [label, accession, ...aliases.slice(0, 6)].filter(Boolean).join(' | ')
  }
  const getMiniPillStyle = (state) => {
    const isFullyActive = Boolean(state.speciesKey && fullyActiveKeys.has(state.speciesKey))
    if (isFullyActive) {
      return {
        backgroundColor: isLight ? '#0099ff' : '#0077cc',
        color: '#ffffff',
        borderColor: 'transparent',
        borderStyle: 'solid',
      }
    }
    if (state.isActive) {
      return {
        backgroundColor: isLight ? '#ffffff' : 'transparent',
        color: isLight ? '#1d4ed8' : '#93c5fd',
        borderColor: isLight ? '#60a5fa' : '#3b82f6',
        borderStyle: 'solid',
      }
    }
    if (state.isSelected) {
      return {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        color: isLight ? '#4b5563' : '#9ca3af',
        borderColor: isLight ? '#d1d5db' : '#4b5563',
        borderStyle: 'solid',
      }
    }
    return {
      backgroundColor: isLight ? '#ffffff' : 'transparent',
      color: isLight ? '#6b7280' : '#9ca3af',
      borderColor: isLight ? '#d1d5db' : '#4b5563',
      borderStyle: 'dashed',
    }
  }
  const renderMiniGenomePill = (row, side) => {
    const state = side === 'reference' ? row.reference : row.target
    const canAddInactive = Boolean(state.isLocal && !state.isSelected)
    const action = side === 'reference' ? 'add_reference_inactive' : 'add_target_inactive'
    return (
      <span className="group/align-pill relative min-w-0 max-w-[48%]">
        <span
          className="inline-flex max-w-full min-w-[92px] items-center rounded-full border px-2.5 py-1 text-[11px] font-medium"
          style={getMiniPillStyle(state)}
          title={formatGenomeTooltip(state)}
        >
          <span className="truncate">{formatGenome(state)}</span>
        </span>
        {canAddInactive && (
          <button
            type="button"
            className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 transition-opacity group-hover/align-pill:opacity-100 ${
              isLight
                ? 'border-gray-300 bg-white text-gray-500 hover:border-blue-400 hover:text-blue-600'
                : 'border-gray-500 bg-gray-800 text-gray-300 hover:border-blue-400 hover:text-blue-300'
            }`}
            title="Add genome to list"
            aria-label="Add genome to list"
            onClick={(event) => {
              event.stopPropagation()
              onAction?.(row, action)
            }}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <line x1="5" y1="2" x2="5" y2="8" />
              <line x1="2" y1="5" x2="8" y2="5" />
            </svg>
          </button>
        )}
      </span>
    )
  }
  const formatStatus = (row) => {
    if (row.status === 'usable') return 'Usable'
    if (row.status === 'downloadable') return 'Downloadable'
    if (row.status === 'missing_files') return 'Missing files'
    return 'Unavailable'
  }
  const renderActionButtons = (row) => {
    const buttons = []
    if (row.supported && row.canUse) {
      buttons.push(
        <button key="use" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'use') }}>
          Use alignment
        </button>,
      )
    }
    if (row.supported && row.canDownloadReference) {
      buttons.push(
        <button key="download-ref" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_reference') }}>
          Download reference
        </button>,
      )
    }
    if (row.supported && row.canDownloadTarget) {
      buttons.push(
        <button key="download-target" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_target') }}>
          Download target
        </button>,
      )
    }
    // Offered whatever the state: an entry with missing files is exactly the one
    // most likely to need its paths corrected or to be removed outright.
    buttons.push(
      <button key="remove" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'remove') }}>
        Remove
      </button>,
    )
    return <div className="flex flex-wrap items-center gap-1.5">{buttons}</div>
  }
  const renderFileDetail = (label, file) => {
    const path = String(file?.path || '').trim()
    const ok = Boolean(file?.exists)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{label}</div>
        <div className={`truncate font-mono text-[11px] ${path ? mutedClass : statusClass('missing_files')}`} title={path}>
          {path || 'Not set'}{path ? (ok ? ' (found)' : ' (missing)') : ''}
        </div>
      </div>
    )
  }
  const renderGenomeDetail = (title, state, aliases) => {
    const genome = state.genome || {}
    const accession = getSvGenomeAccessionLabel(genome)
    const aliasList = Array.from(new Set([...(aliases || []), ...(genome.aliases || [])])).filter(Boolean)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{title}</div>
        <div className="truncate" title={formatGenome(state)}>{formatGenome(state)}</div>
        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={accession}>{accession || 'No accession'}</div>
        <div className={`truncate text-[11px] ${mutedClass}`} title={aliasList.join(', ')}>
          {aliasList.length ? `Aliases: ${aliasList.slice(0, 8).join(', ')}${aliasList.length > 8 ? '...' : ''}` : 'No aliases'}
        </div>
      </div>
    )
  }

  return (
    <div className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex items-center justify-between border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Available alignments</span>
        <span className={mutedClass}>{rows.length} registered</span>
      </div>
      {rows.length === 0 ? (
        <div className={`px-3 py-3 text-sm ${mutedClass}`}>No SV alignments are registered.</div>
      ) : (
        <div>
          <div className={`hidden border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide md:grid ${tableGridClass} md:gap-2 ${isLight ? 'border-gray-100 text-gray-500' : 'border-gray-700 text-gray-400'}`}>
            <span />
            <span>Direction</span>
            <span>Label</span>
            <span>Regions</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {rows.map((row) => {
            const expanded = Boolean(expandedRows[row.id])
            const alignment = row.alignment || {}
            const sourceLabel = alignment.label || row.id
            const regions = Array.isArray(alignment.reference_regions) ? alignment.reference_regions : []
            return (
              <div key={row.id}>
                <div className={`w-full text-left ${rowClass}`}>
                  <span className="flex items-center">
                    <button
                      type="button"
                      className={`inline-flex h-6 w-6 items-center justify-center rounded border ${isLight ? 'border-gray-300 bg-white text-gray-500 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-300 hover:bg-slate-700'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedRows((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
                      }}
                      title={expanded ? 'Collapse alignment details' : 'Expand alignment details'}
                    >
                      <IconUpDown open={expanded} size={13} />
                    </button>
                  </span>
                  <span
                    className="flex min-w-0 items-center gap-2"
                    title={`${formatGenomeTooltip(row.reference)} -> ${formatGenomeTooltip(row.target)}`}
                  >
                    {renderMiniGenomePill(row, 'reference')}
                    <span className={`shrink-0 text-xs font-semibold ${mutedClass}`}>-&gt;</span>
                    {renderMiniGenomePill(row, 'target')}
                  </span>
                  <span className="truncate" title={sourceLabel}>{sourceLabel}</span>
                  <span>{row.regionCount} {row.regionCount === 1 ? 'region' : 'regions'}</span>
                  <span className={statusClass(row.status)}>{formatStatus(row)}</span>
                  <span>{renderActionButtons(row)}</span>
                </div>
                {expanded && (
                  <div className={`border-b px-3 py-3 text-xs ${detailClass}`}>
                    {alignment.description && (
                      <div className={`mb-3 ${mutedClass}`}>{alignment.description}</div>
                    )}
                    <div className="grid gap-3 md:grid-cols-3">
                      {renderFileDetail('BigChain', alignment.files?.bigchain)}
                      <div>
                        <div className={`font-semibold ${strongClass}`}>Indexed side</div>
                        <div>{alignment.indexed_side || 'target'}</div>
                      </div>
                      <div className="min-w-0">
                        <div className={`font-semibold ${strongClass}`}>Defined in</div>
                        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={alignment.config_path || ''}>
                          {alignment.config_path || (alignment.source === 'scanned' ? 'Scanned bundle' : 'This installation')}
                        </div>
                      </div>
                      {/* Only shown for records migrated from before sequence names
                          were derived from the assemblies. */}
                      {alignment.files?.reference_mapping?.path && renderFileDetail('Reference mapping TSV (legacy)', alignment.files.reference_mapping)}
                      {alignment.files?.target_mapping?.path && renderFileDetail('Target mapping TSV (legacy)', alignment.files.target_mapping)}
                      {renderGenomeDetail('Reference genome', row.reference, alignment.ref_aliases)}
                      {renderGenomeDetail('Target genome', row.target, alignment.tgt_aliases)}
                    </div>
                    {row.missingFiles.length > 0 && (
                      <div className={`mt-3 ${statusClass('missing_files')}`}>
                        Missing: {row.missingFiles.join(', ')}
                      </div>
                    )}
                    <div className="mt-3">
                      <div className={`font-semibold ${strongClass}`}>Reference regions</div>
                      <div className={`mt-1 flex flex-wrap gap-1 ${mutedClass}`}>
                        {regions.length === 0 ? (
                          <span>No regions listed</span>
                        ) : (
                          <>
                            {regions.slice(0, 20).map((region) => {
                              const key = getSvRegionKey(region)
                              return (
                                <span key={key} className={`rounded border px-1.5 py-0.5 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-slate-950'}`}>
                                  {region.label || region.chrom || key}
                                </span>
                              )
                            })}
                            {regions.length > 20 && <span>+{regions.length - 20} more</span>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Loading makes alignments available; text editing is an explicit secondary action. */
function StructuralVariationConfigPanel({ theme, catalog, outputDir, activeSpecies, inactiveSpecies, onChanged, onLoaded, onClose }) {
  const isLight = theme === 'light'
  const [selectedPath, setSelectedPath] = useState('')
  const [text, setText] = useState('')
  const [loadedText, setLoadedText] = useState('')
  const [configDocument, setConfigDocument] = useState(null)
  const [missingFiles, setMissingFiles] = useState([])
  const [filesChecked, setFilesChecked] = useState(false)
  const [diagnostics, setDiagnostics] = useState([])
  const [feedback, setFeedback] = useState(null)
  const [operation, setOperation] = useState('')
  const [editing, setEditing] = useState(false)
  const [browserMode, setBrowserMode] = useState('')
  const textareaRef = useRef(null)
  const initialPathRef = useRef((catalog?.configs || []).at(-1)?.path || '')

  const configs = useMemo(() => (Array.isArray(catalog?.configs) ? catalog.configs : []), [catalog])
  const registryPath = String(catalog?.registry_path || '')
  const isDirty = text !== loadedText
  const busy = Boolean(operation)
  const summary = useMemo(() => buildSvConfigSummary(configDocument, {
    missingFiles, filesChecked, catalog, configPath: selectedPath, activeSpecies, inactiveSpecies,
  }), [configDocument, missingFiles, filesChecked, catalog, selectedPath, activeSpecies, inactiveSpecies])

  const panelClass = isLight ? 'border-gray-200 bg-white text-gray-900' : 'border-gray-700 bg-[#0f172a] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const selectClass = `h-8 min-w-0 max-w-full rounded border py-0 pl-2 pr-8 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const feedbackClass = feedback?.tone === 'error'
    ? (isLight ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-800 bg-red-950/40 text-red-200')
    : feedback?.tone === 'warning'
      ? (isLight ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-amber-800 bg-amber-950/40 text-amber-200')
      : (isLight ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-sky-800 bg-sky-950/40 text-sky-200')

  const checkText = useCallback(async (value, path) => {
    const res = await fetch(`${API_BASE}/api/sv/config/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, base_dir: path ? path.replace(/[^/\\]+$/, '') : '' }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) throw new Error(data?.detail || `Validation failed (${res.status})`)
    return data
  }, [])

  const load = useCallback(async (path, action = 'Loaded') => {
    setOperation('load')
    setFeedback({ tone: 'info', message: 'Loading alignment configuration…' })
    try {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (outputDir) params.set('output_dir', outputDir)
      const res = await fetch(`${API_BASE}/api/sv/config?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Could not read the configuration (${res.status})`)
      const actualPath = String(data.path || path || '')
      setText(data.text || '')
      setLoadedText(data.text || '')
      setConfigDocument(data.config || null)
      setSelectedPath(actualPath)
      setDiagnostics(data.diagnostics || [])
      setMissingFiles([])
      setFilesChecked(false)
      setEditing(false)
      const result = await checkText(data.text || '', actualPath)
      setDiagnostics(result.diagnostics || [])
      setMissingFiles(result.missing_files || [])
      setFilesChecked(Boolean(result.ok))
      const validationFeedback = svConfigValidationFeedback(result)
      const count = result.alignment_count || 0
      setFeedback(action && result.ok
        ? { tone: validationFeedback.tone, message: `${action} ${count} alignment${count === 1 ? '' : 's'}. ${result.missing_files?.length ? 'Some referenced files are missing; see the summary below.' : 'The alignments are available in the dropdowns above.'}` }
        : validationFeedback)
      return { path: actualPath, action, alignmentCount: count, missingFiles: result.missing_files || [], ok: result.ok }
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not read the configuration.' })
      return null
    } finally {
      setOperation('')
    }
  }, [outputDir, checkText])

  useEffect(() => { load(initialPathRef.current) }, [load])

  const validate = useCallback(async () => {
    setOperation('validate')
    setFeedback({ tone: 'info', message: 'Validating configuration…' })
    try {
      const result = await checkText(text, selectedPath)
      setDiagnostics(result.diagnostics || [])
      if (!isDirty) {
        setMissingFiles(result.missing_files || [])
        setFilesChecked(Boolean(result.ok))
      }
      const nextFeedback = svConfigValidationFeedback(result)
      setFeedback({
        ...nextFeedback,
        message: isDirty && result.ok
          ? `${nextFeedback.message} Save your changes to make them available.`
          : nextFeedback.message,
        checkedAt: Date.now(),
      })
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Validation failed.' })
    } finally {
      setOperation('')
    }
  }, [text, selectedPath, isDirty, checkText])

  const save = useCallback(async (path, attachFile) => {
    const destination = String(path || selectedPath || '')
    if (!destination) {
      setFeedback({ tone: 'error', message: 'Choose where to save first.' })
      return
    }
    setOperation('save')
    setFeedback({ tone: 'info', message: 'Saving configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destination, text, mode: 'replace', attach: Boolean(attachFile) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Save failed (${res.status})`)
      if (!data.ok) {
        setDiagnostics(data.diagnostics || [])
        setFeedback({ tone: 'error', message: 'The configuration has errors, so nothing was written.' })
        return
      }
      await onChanged?.()
      const result = await load(data.path || destination, 'Saved')
      if (result?.ok) onLoaded?.(result)
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Save failed.' })
    } finally {
      setOperation('')
    }
  }, [text, selectedPath, onChanged, onLoaded, load])

  const attach = useCallback(async (path) => {
    setOperation('load')
    setFeedback({ tone: 'info', message: 'Loading alignment configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Could not load the configuration (${res.status})`)
      if (!data.ok) {
        setDiagnostics(data.diagnostics || [])
        setFeedback({ tone: 'error', message: 'That configuration has errors, so it was not loaded.' })
        return
      }
      await onChanged?.()
      const result = await load(data.path || path, 'Loaded')
      if (result?.ok) onLoaded?.(result)
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not load the configuration.' })
    } finally {
      setOperation('')
    }
  }, [load, onChanged, onLoaded])

  const detach = useCallback(async (path) => {
    setOperation('detach')
    setFeedback({ tone: 'info', message: 'Stopping use of this configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/detach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.detail || 'Could not stop using the configuration.')
      await onChanged?.()
      await load('')
      setFeedback({ tone: 'info', message: 'Stopped using that configuration. The file itself is untouched.' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not stop using the configuration.' })
    } finally {
      setOperation('')
    }
  }, [load, onChanged])

  const focusLine = useCallback((line) => {
    setEditing(true)
    // Wait for the explicitly opened editor to mount before focusing the line.
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element || !line) return
      const lines = text.split('\n')
      const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0)
      element.focus()
      element.setSelectionRange(offset, offset + (lines[line - 1] || '').length)
      element.scrollTop = Math.max(0, (line - 3) * (element.scrollHeight / Math.max(1, lines.length)))
    })
  }, [text])

  return (
    <section aria-label="Alignment configuration" aria-busy={busy} className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Alignment configuration</span>
        <select aria-label="Alignment configuration file" className={selectClass} value={selectedPath} onChange={(event) => load(event.target.value)} disabled={busy}>
          <option value={registryPath}>This installation{registryPath ? '' : ' (no output directory)'}</option>
          {selectedPath && selectedPath !== registryPath && !configs.some((item) => item.path === selectedPath) && <option value={selectedPath}>{selectedPath}</option>}
          {configs.map((item) => <option key={item.path} value={item.path}>{item.label || item.path}{item.exists ? '' : ' (file missing)'}</option>)}
        </select>
        <button type="button" className={buttonClass} onClick={() => setBrowserMode('load')} disabled={busy}>Load file</button>
        {selectedPath && selectedPath !== registryPath && <button type="button" className={buttonClass} onClick={() => detach(selectedPath)} disabled={busy}>Stop using</button>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} onClick={validate} disabled={busy || !text}>{operation === 'validate' ? 'Validating…' : 'Validate'}</button>
          <button type="button" className={buttonClass} onClick={() => setEditing((prev) => !prev)} disabled={busy}>{editing ? 'Show summary' : 'Edit configuration'}</button>
          {editing && <>
            <button type="button" className={buttonClass} onClick={() => save(selectedPath, false)} disabled={busy || !isDirty}>{isDirty ? 'Save' : 'Saved'}</button>
            <button type="button" className={buttonClass} onClick={() => setBrowserMode('save')} disabled={busy}>Save as</button>
          </>}
          <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>Close summary</button>
        </span>
      </div>

      {feedback && <div role="status" aria-live="polite" aria-atomic="true" className={`m-3 rounded border px-3 py-2 text-sm ${feedbackClass}`}>
        {feedback.message}
        {feedback.checkedAt && <span className="ml-2 text-xs">Checked at {new Date(feedback.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.</span>}
      </div>}
      {diagnostics.length > 0 && <div className="px-3 pb-3 text-xs">
        {diagnostics.map((item, index) => <button key={`${item.pointer}-${index}`} type="button" className={`mt-1 block w-full text-left ${item.severity === 'error' ? (isLight ? 'text-red-600' : 'text-red-300') : (isLight ? 'text-amber-700' : 'text-amber-300')}`} onClick={() => focusLine(item.line)} title={item.pointer ? `at ${item.pointer}` : ''}>
          {item.line ? `Line ${item.line}: ` : ''}{item.message}
        </button>)}
      </div>}

      {!editing && configDocument && <div className="px-3 pb-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Loaded alignments</h3>
          <span className={`text-xs ${mutedClass}`}>{summary.alignmentCount} alignment{summary.alignmentCount === 1 ? '' : 's'} · {summary.genomeCount} genome{summary.genomeCount === 1 ? '' : 's'} · {summary.readyCount} ready to select</span>
        </div>
        <p className={`mb-3 text-sm ${mutedClass}`}>
          You can close this summary and choose an Anchor, a Region, and a Second genome from the dropdowns above. Add a Third genome for a three-genome comparison.
        </p>
        {isDirty && <p className={`mb-3 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>You have unsaved edits. This summary shows the currently loaded alignments; save your configuration to apply the changes.</p>}
        {summary.rows.length === 0 ? <p className={`py-2 text-sm ${mutedClass}`}>No alignments in this configuration. Load a file or register an alignment to get started.</p> : <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={mutedClass}><tr><th className="px-2 py-2">Alignment</th><th className="px-2 py-2">Reference → target</th><th className="px-2 py-2">Tracks</th><th className="px-2 py-2">Availability</th></tr></thead>
            <tbody>{summary.rows.map((row, index) => <tr key={`${row.id}-${index}`} className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <td className="px-2 py-2 font-medium">{row.label}</td>
              <td className="px-2 py-2">{row.reference} → {row.target}</td>
              <td className="px-2 py-2">{row.trackCount}</td>
              <td className={`px-2 py-2 ${row.status === 'Ready to select' ? (isLight ? 'text-emerald-700' : 'text-emerald-300') : row.status === 'Missing files' || row.status === 'Download genomes' || row.status === 'Genomes unavailable' ? (isLight ? 'text-amber-700' : 'text-amber-300') : mutedClass}`}>
                {row.status}{row.missingFiles.length > 0 && <div className="mt-1 break-all text-[11px]">Missing: {row.missingFiles.join(', ')}</div>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
        {summary.rows.some((row) => row.status === 'Download genomes' || row.status === 'Genomes unavailable') && <p className={`mt-3 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>Some genomes need local data before their alignments can be selected. Use Download or Genome Selector to prepare them.</p>}
      </div>}

      {editing && <>
        <p className={`px-3 pb-2 text-xs ${mutedClass}`}>Use key = value fields with --- between alignments, or JSON. Validate checks your edits; Save applies them.</p>
        <textarea ref={textareaRef} aria-label="Configuration text" className={`h-80 w-full resize-y px-3 py-2 font-mono text-[12px] leading-5 outline-none ${isLight ? 'bg-white text-gray-900' : 'bg-[#0b1220] text-gray-100'}`} spellCheck={false} value={text} onChange={(event) => {
          setText(event.target.value)
          setFeedback(null)
          setDiagnostics([])
        }} />
      </>}

      <FileBrowserModal isOpen={Boolean(browserMode)} onClose={() => setBrowserMode('')} onSelect={(path) => {
        const mode = browserMode
        setBrowserMode('')
        if (mode === 'load') attach(path)
        else save(path, true)
      }} initialPath={outputDir || ''} mode={browserMode === 'save' ? 'save' : 'file'} defaultFileName="sv-alignments.cfg" theme={theme} extensions={['.json', '.cfg']} />
    </section>
  )
}

function StructuralVariationRegistrationForm({
  className = '',
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  outputDir,
  onRegistered,
  onAvailableAlignmentAction,
  onOpenGenomeSelector,
}) {
  const isLight = theme === 'light'
  const [activeTool, setActiveTool] = useState('')
  const [browserField, setBrowserField] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const isRegistrationOpen = activeTool === 'register'
  const isAvailableOpen = activeTool === 'available'
  const isConfigOpen = activeTool === 'config'
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])
  const [form, setForm] = useState({
    label: '',
    description: '',
    chain_path: '',
    reference_bigwig_path: '',
    reference_bigbed_path: '',
    target_bigwig_path: '',
    target_bigbed_path: '',
    // Empty means "work it out from the file name"; getting this wrong is the
    // usual cause of an alignment that saves but draws nothing.
    indexed_side: '',
    reference_key: '',
    target_key: '',
    save_to: 'registry',
    config_path: '',
  })
  const speciesByKey = useMemo(() => new Map(knownSpecies.map((species) => [speciesGenomeKey(species), species])), [knownSpecies])

  // Start from whatever the view is already showing. The genomes were passed in
  // all along but the form ignored them, so every registration meant re-picking
  // the pair that was on screen.
  useEffect(() => {
    if (!isRegistrationOpen) return
    setForm((prev) => {
      if (prev.reference_key || prev.target_key) return prev
      const anchorKey = anchorSpecies ? speciesGenomeKey(anchorSpecies) : ''
      const secondKey = secondSpecies ? speciesGenomeKey(secondSpecies) : ''
      if (!anchorKey && !secondKey) return prev
      return { ...prev, reference_key: anchorKey, target_key: secondKey }
    })
  }, [isRegistrationOpen, anchorSpecies, secondSpecies])
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = isLight
    ? 'h-4 text-xs font-semibold leading-4 text-gray-600'
    : 'h-4 text-xs font-semibold leading-4 text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const chooserButtonBaseClass = 'inline-flex h-8 items-center justify-center rounded border px-3 text-xs leading-none transition-colors whitespace-nowrap'
  const chooserButtonClass = (active) => `${chooserButtonBaseClass} ${active
    ? (isLight
      ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'
      : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700')
    : (isLight
      ? 'border-sky-600 bg-sky-600 text-white hover:bg-sky-700'
      : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
  }`
  const inputClass = `h-8 w-full rounded border px-2 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const labelTextClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const hintClass = `mt-0.5 block text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault()
    if (form.reference_key && form.reference_key === form.target_key) {
      setMessage('The reference and target must be different genomes.')
      return
    }
    if (form.save_to !== 'registry' && !form.config_path.trim()) {
      setMessage('Choose a configuration file to save into.')
      return
    }
    setSubmitting(true)
    setMessage('')
    try {
      const referenceSpecies = speciesByKey.get(form.reference_key) || null
      const targetSpecies = speciesByKey.get(form.target_key) || null
      const payload = {
        output_dir: outputDir || '',
        label: form.label,
        description: form.description,
        chain_path: form.chain_path,
        reference_bigwig_path: form.reference_bigwig_path,
        reference_bigbed_path: form.reference_bigbed_path,
        target_bigwig_path: form.target_bigwig_path,
        target_bigbed_path: form.target_bigbed_path,
        indexed_side: form.indexed_side,
        reference_genome: buildSvGenomePayload(referenceSpecies),
        target_genome: buildSvGenomePayload(targetSpecies),
        target: form.save_to === 'registry'
          ? { kind: 'registry' }
          : { kind: 'config', path: form.config_path.trim(), mode: 'merge' },
      }
      const res = await fetch(`${API_BASE}/api/sv/alignments/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Registration failed (${res.status})`)

      // A config the user saved into is only useful once the view reads from it.
      if (form.save_to !== 'registry' && data?.config_path) {
        await fetch(`${API_BASE}/api/sv/config/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: data.config_path }),
        }).catch(() => null)
      }
      setMessage(form.save_to === 'registry'
        ? 'Alignment registered.'
        : `Alignment saved to ${data?.config_path || form.config_path}.`)
      setActiveTool('')
      onRegistered?.()
    } catch (error) {
      setMessage(error?.message || 'Failed to register alignment.')
    } finally {
      setSubmitting(false)
    }
  }, [form, outputDir, speciesByKey, onRegistered])

  return (
    <>
      <div className={`${fieldClass} ${className}`}>
        <span className={fieldLabelClass}>Alignments</span>
        <div className="flex h-8 flex-nowrap items-center gap-2">
          <button type="button" className={chooserButtonClass(isRegistrationOpen)} onClick={() => setActiveTool((prev) => (prev === 'register' ? '' : 'register'))}>
            {isRegistrationOpen ? 'Close registration' : 'Register alignment'}
          </button>
          <button type="button" className={chooserButtonClass(isAvailableOpen)} onClick={() => setActiveTool((prev) => (prev === 'available' ? '' : 'available'))}>
            {isAvailableOpen ? 'Close alignments' : 'Available alignments'}
          </button>
          <button type="button" className={chooserButtonClass(isConfigOpen)} onClick={() => setActiveTool((prev) => (prev === 'config' ? '' : 'config'))}>
            {isConfigOpen ? 'Close summary' : 'Configuration'}
          </button>
        </div>
      </div>
      {message && !isConfigOpen && (
        <div className={`md:col-span-full text-xs ${message.includes('failed') || message.includes('Failed') ? (isLight ? 'text-red-600' : 'text-red-300') : (isLight ? 'text-gray-600' : 'text-gray-300')}`}>
          {message}
        </div>
      )}

      {isAvailableOpen && (
        <AvailableSvAlignmentsPanel
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={regionExplicitlySelected}
          onAction={onAvailableAlignmentAction}
        />
      )}

      {isConfigOpen && (
        <StructuralVariationConfigPanel
          theme={theme}
          catalog={catalog}
          outputDir={outputDir}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          onChanged={onRegistered}
          onLoaded={({ action, alignmentCount, missingFiles }) => setMessage(`${action} ${alignmentCount} alignment${alignmentCount === 1 ? '' : 's'}. ${missingFiles.length ? 'Some referenced files are missing; check the summary.' : 'Select genomes and an anchor region from the dropdowns above to start browsing.'}`)}
          onClose={() => setActiveTool('')}
        />
      )}

      {isRegistrationOpen && (
        <form className="mt-1 grid gap-2 md:col-span-full md:grid-cols-2" onSubmit={handleSubmit}>
          <label className="text-xs">
            <span className={labelTextClass}>Label</span>
            <input
              className={inputClass}
              value={form.label}
              placeholder="GRCh38 to HG00438.pat"
              onChange={(event) => updateField('label', event.target.value)}
              required
            />
            <span className={hintClass}>Identifies this alignment. Must be unique.</span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Description (optional)</span>
            <input
              className={inputClass}
              value={form.description}
              placeholder="Cactus chain, HPRC year 1"
              onChange={(event) => updateField('description', event.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Reference genome</span>
            <select className={inputClass} value={form.reference_key} onChange={(event) => updateField('reference_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`ref-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Target genome</span>
            <select className={inputClass} value={form.target_key} onChange={(event) => updateField('target_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`tgt-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs md:col-span-2">
            <span className={labelTextClass}>BigChain file</span>
            <div className="flex gap-2">
              <input className={inputClass} value={form.chain_path} onChange={(event) => updateField('chain_path', event.target.value)} required />
              <button type="button" className={buttonClass} onClick={() => setBrowserField('chain_path')}>
                Browse
              </button>
            </div>
            <span className={hintClass}>
              Indexed BigBed chain file, conventionally *.bigChain.bb. Sequence names come from
              the assemblies, so no mapping files are needed.
            </span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Indexed side</span>
            <select className={inputClass} value={form.indexed_side} onChange={(event) => updateField('indexed_side', event.target.value)}>
              <option value="">Detect from file name</option>
              <option value="target">Target</option>
              <option value="reference">Reference</option>
            </select>
            <span className={hintClass}>Which genome the chain file is indexed on.</span>
          </label>
          <div className="text-xs">
            <span className={labelTextClass}>Save to</span>
            <select className={inputClass} value={form.save_to} onChange={(event) => updateField('save_to', event.target.value)}>
              <option value="registry">This installation</option>
              <option value="config">A configuration file</option>
            </select>
            {form.save_to === 'config' && (
              <div className="mt-1 flex gap-2">
                <input
                  className={inputClass}
                  value={form.config_path}
                  placeholder="alignments.json"
                  onChange={(event) => updateField('config_path', event.target.value)}
                />
                <button type="button" className={buttonClass} onClick={() => setBrowserField('config_path')}>
                  Browse
                </button>
              </div>
            )}
          </div>
          {[
            ['reference_bigwig_path', 'Reference BigWig (optional)'],
            ['reference_bigbed_path', 'Reference BigBed (optional)'],
            ['target_bigwig_path', 'Target BigWig (optional)'],
            ['target_bigbed_path', 'Target BigBed (optional)'],
          ].map(([field, label]) => (
            <label key={field} className="text-xs">
              <span className={labelTextClass}>{label}</span>
              <div className="flex gap-2">
                <input className={inputClass} value={form[field]} onChange={(event) => updateField(field, event.target.value)} />
                <button type="button" className={buttonClass} onClick={() => setBrowserField(field)}>
                  Browse
                </button>
              </div>
            </label>
          ))}
          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <button type="submit" className={buttonClass} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save alignment'}
            </button>
          </div>
        </form>
      )}

      <FileBrowserModal
        isOpen={Boolean(browserField)}
        onClose={() => setBrowserField('')}
        onSelect={(path) => {
          updateField(browserField, path)
          setBrowserField('')
        }}
        initialPath={outputDir || ''}
        mode="file"
        theme={theme}
        extensions={SV_FILE_BROWSER_EXTENSIONS[browserField] || []}
      />
    </>
  )
}

function StructuralVariationView(props) {
  const {
    theme = 'dark',
    config,
    refSpecies,
    tgtSpecies,
    thirdSpecies,
    activeSpecies = config?.active_species || [],
    inactiveSpecies = [],
    onGenomeOrderChange = null,
    onAlignmentAvailabilityChange = null,
    selectedAnchorRegionId: controlledSelectedAnchorRegionId = null,
    regionExplicitlySelected = false,
    onSelectedAnchorRegionIdChange = null,
    onOpenGenomeSelector = null,
  } = props
  const outputDir = config?.output_dir || ''
  const [catalog, setCatalog] = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [localSelectedAnchorRegionId, setLocalSelectedAnchorRegionId] = useState('')
  const [anchorLocationRegion, setAnchorLocationRegion] = useState(null)
  const selectedAnchorRegionId = controlledSelectedAnchorRegionId ?? localSelectedAnchorRegionId
  const setSelectedAnchorRegionId = useCallback((nextRegionId, options = {}) => {
    const next = String(nextRegionId || '')
    if (controlledSelectedAnchorRegionId === null) {
      setLocalSelectedAnchorRegionId(next)
    }
    onSelectedAnchorRegionIdChange?.(next, options)
  }, [controlledSelectedAnchorRegionId, onSelectedAnchorRegionIdChange])
  const handleAnchorRegionChange = useCallback((nextRegionId) => {
    setAnchorLocationRegion(null)
    setSelectedAnchorRegionId(nextRegionId, { explicit: Boolean(nextRegionId) })
  }, [setSelectedAnchorRegionId])

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const params = new URLSearchParams()
      if (outputDir) params.set('output_dir', outputDir)
      const res = await fetch(`${API_BASE}/api/sv/catalog?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Catalog request failed (${res.status})`)
      setCatalog(data || { alignments: [], genomes: [], edges: [] })
    } catch (error) {
      setCatalogError(error?.message || 'Failed to load SV alignment catalog.')
      setCatalog({ alignments: [], genomes: [], edges: [] })
    } finally {
      setCatalogLoading(false)
    }
  }, [outputDir])

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  const handleRemoveAlignment = useCallback(async (row) => {
    const alignment = row?.alignment || {}
    const id = String(alignment.id || row?.id || '')
    if (!id) return
    const label = alignment.label || id
    // Removal edits a file on disk, and for an attached config that file may be
    // shared, so it is worth one confirmation.
    if (!window.confirm(`Remove "${label}" from the configuration? The alignment files themselves are not deleted.`)) {
      return
    }
    try {
      const res = await fetch(`${API_BASE}/api/sv/alignments/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output_dir: outputDir || '', config_path: alignment.config_path || '' }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Could not remove the alignment (${res.status})`)
      await loadCatalog()
    } catch (error) {
      setCatalogError(error?.message || 'Could not remove the alignment.')
    }
  }, [loadCatalog, outputDir])

  const effectiveSelectedAnchorRegionId = anchorLocationRegion ? getSvRegionKey(anchorLocationRegion) : selectedAnchorRegionId
  const hasExplicitAnchorRegion = Boolean(effectiveSelectedAnchorRegionId && regionExplicitlySelected)

  // Genome and region selection determine the alignment, using the first
  // applicable catalog record when more than one covers the same comparison.
  const selectedSecondAlignment = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, tgtSpecies)
        .find((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId)) || null
      : null),
    [catalog, refSpecies, tgtSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
  )
  const selectedThirdAlignment = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, thirdSpecies)
        .find((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId)) || null
      : null),
    [catalog, refSpecies, thirdSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
  )
  const outgoingAlignments = useMemo(() => getOutgoingSvAlignments(catalog, refSpecies), [catalog, refSpecies])
  const anchorRegionOptions = useMemo(
    () => buildSvAnchorRegionOptions(outgoingAlignments),
    [outgoingAlignments],
  )
  const selectedAnchorRegion = useMemo(() => {
    if (anchorLocationRegion) return anchorLocationRegion
    return anchorRegionOptions.find((region) => getSvRegionKey(region) === selectedAnchorRegionId) || null
  }, [anchorLocationRegion, anchorRegionOptions, selectedAnchorRegionId])

  const handleAnchorRegionSearch = useCallback((query) => {
    const parsed = parseRegionInput(query)
    if (!parsed?.chrom) return false
    const matchingRegion = anchorRegionOptions.find((region) => (
      svRegionsMatch(getSvRegionKey(region), parsed.chrom)
      || svRegionsMatch(region?.chrom, parsed.chrom)
      || svRegionsMatch(region?.label, parsed.chrom)
    ))
    const key = matchingRegion ? getSvRegionKey(matchingRegion) : parsed.chrom
    setAnchorLocationRegion({
      ...(matchingRegion || {}),
      id: key,
      chrom: matchingRegion?.chrom || parsed.chrom,
      label: String(query || '').trim() || matchingRegion?.label || parsed.chrom,
      start: Number.isFinite(parsed.start) ? parsed.start : undefined,
      end: Number.isFinite(parsed.end) ? parsed.end : undefined,
    })
    setSelectedAnchorRegionId(key, { explicit: true })
    return true
  }, [anchorRegionOptions, setSelectedAnchorRegionId])

  const pairAlignmentId = selectedSecondAlignment?.supported ? selectedSecondAlignment.id : ''
  const thirdAlignmentId = selectedThirdAlignment?.supported ? selectedThirdAlignment.id : ''
  const readyForPairRender = Boolean(refSpecies && tgtSpecies && pairAlignmentId && selectedAnchorRegion)
  const chooserPlaceholder = !refSpecies
    ? 'Select an anchor genome to browse structural variation alignments.'
    : (!hasExplicitAnchorRegion
      ? 'Select a region or enter a location to choose aligned genomes.'
      : (!tgtSpecies
        ? 'Select a second genome to load an alignment.'
        : (!pairAlignmentId ? 'No registered alignment is available for the current anchor, region, and second genome.' : '')))

  useEffect(() => {
    if (!onAlignmentAvailabilityChange || catalogLoading) return
    const availableSpeciesKeys = []
    if (refSpecies) availableSpeciesKeys.push(svSpeciesSelectionKey(refSpecies))
    if (hasExplicitAnchorRegion && tgtSpecies && selectedSecondAlignment?.supported) {
      availableSpeciesKeys.push(svSpeciesSelectionKey(tgtSpecies))
    }
    if (hasExplicitAnchorRegion && thirdSpecies && selectedThirdAlignment?.supported) {
      availableSpeciesKeys.push(svSpeciesSelectionKey(thirdSpecies))
    }
    onAlignmentAvailabilityChange(availableSpeciesKeys)
  }, [
    catalogLoading,
    onAlignmentAvailabilityChange,
    refSpecies,
    tgtSpecies,
    thirdSpecies,
    selectedSecondAlignment?.supported,
    selectedThirdAlignment?.supported,
    hasExplicitAnchorRegion,
  ])

  return (
    <div className="flex flex-col gap-0">
      <StructuralVariationChooser
        theme={theme}
        catalog={catalog}
        catalogLoading={catalogLoading}
        catalogError={catalogError}
        activeSpecies={activeSpecies}
        inactiveSpecies={inactiveSpecies}
        anchorSpecies={refSpecies}
        secondSpecies={tgtSpecies}
        thirdSpecies={thirdSpecies}
        selectedSecondAlignment={selectedSecondAlignment}
        selectedThirdAlignment={selectedThirdAlignment}
        anchorRegionOptions={anchorRegionOptions}
        selectedAnchorRegionId={effectiveSelectedAnchorRegionId}
        regionExplicitlySelected={hasExplicitAnchorRegion}
        onAnchorRegionChange={handleAnchorRegionChange}
        onAnchorRegionSearch={handleAnchorRegionSearch}
        onGenomeOrderChange={onGenomeOrderChange}
        onOpenGenomeSelector={onOpenGenomeSelector}
        onRegisteredAlignment={loadCatalog}
        onRemoveAlignment={handleRemoveAlignment}
        outputDir={outputDir}
      />
      {!readyForPairRender ? (
        <div className={`border border-t-0 px-4 py-10 text-sm ${
          theme === 'light'
            ? 'border-gray-200 bg-white text-gray-600'
            : 'border-gray-700 bg-[#111827] text-gray-300'
        }`}>
          {chooserPlaceholder}
        </div>
      ) : (
        <StructuralVariationThreeGenomeView
          key={`javascript|${pairAlignmentId}|${getSvRegionKey(selectedAnchorRegion)}`}
          {...props}
          selectedTopAlignmentId={pairAlignmentId}
          selectedBottomAlignmentId={thirdAlignmentId}
          selectedAnchorRegion={selectedAnchorRegion}
          outputDir={outputDir}
        />
      )}
    </div>
  )
}

export default StructuralVariationView
