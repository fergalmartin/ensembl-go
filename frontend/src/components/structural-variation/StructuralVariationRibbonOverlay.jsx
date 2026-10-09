import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { buildSvAuxTrackRenderWindow, getSvAuxTrackGeometryWidth, getSvAuxTrackMatrix, getSvAuxTrackTransform } from '../../utils/svAuxTrackTransform.js'
import { ALIGNMENT_PANEL_HEIGHT, SV_AUX_TRACK_CACHE_VERSION, SV_AUX_TRACK_RENDER_HALO_MAX_BP, SV_AUX_TRACK_RENDER_HALO_WINDOWS, SV_BIGBED_DETAIL_FETCH_BATCH_SIZE, SV_BIGBED_DETAIL_FETCH_PER_TRACK, SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE, SV_BIGBED_DETAIL_PREFETCH_MIN_TILES, SV_BIGBED_DETAIL_PREFETCH_RATIO, SV_BIGBED_FEATURE_TILE_SPAN, SV_DATA_TRACK_FETCH_DEBOUNCE_MS, SV_RIBBON_INTERVAL_MAX_VIEW_SPAN } from './svConstants.js'
import { abbreviateMetadataValue, buildCuratedSvIntervalRows, clamp } from './svFormat.js'
import { CopyGlyph } from './svIcons'
import { buildSvRibbonIntervalMarks, getSvDataTrackKey, getSvDataTrackLabel, projectSvRibbonFeatureTiles, selectSvFetchPlansFairly, svBigBedFeatureTileKey, svNormalizeBigBedFeature, trimSvRibbonFeatureCache } from './svTracks.js'

export function StructuralVariationRibbonOverlay({
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
