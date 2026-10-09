import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import useDelayedFlag from '../../hooks/useDelayedFlag.js'
import { buildSvAuxTrackRenderWindow, getSvAuxTrackGeometryWidth, getSvAuxTrackMatrix, getSvAuxTrackTransform } from '../../utils/svAuxTrackTransform.js'
import { PLOT_PAD_X, SV_AUX_TRACK_CACHE_VERSION, SV_AUX_TRACK_RENDER_HALO_MAX_BP, SV_AUX_TRACK_RENDER_HALO_WINDOWS, SV_DATA_TRACK_FETCH_DEBOUNCE_MS, SV_SIGNAL_CONTROL_WIDTH, SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE, SV_SIGNAL_LOD_LEVELS, SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE, SV_SIGNAL_RENDER_MAX_BINS, SV_SIGNAL_TARGET_FETCH_BATCH_SIZE, SV_SIGNAL_TOGGLE_RADIUS, SV_SIGNAL_TRACK_GAP, SV_SIGNAL_TRACK_HEIGHT, SV_TRANSIENT_RETRY_LIMIT } from './svConstants.js'
import { getSvTransientRetryDelay } from './svFormat.js'
import { buildSvSignalPath, getSvDataTrackKey, getSvSignalLevel, projectSvSignalTilesCascade, selectSvFetchPlansFairly, svSignalTileKey } from './svTracks.js'

export function StructuralVariationSignalTracks({
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
