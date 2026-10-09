// Auxiliary data tracks of the structural-variation view: signal tiles across
// levels of detail, ribbon interval features and their cache, fair fetch planning,
// and the SVG paths and marks they draw. Pure functions.
import { SV_AUX_TRACK_CACHE_VERSION, SV_BIGBED_FEATURE_TILE_SPAN, SV_RIBBON_INTERVAL_MAX_FEATURES, SV_RIBBON_INTERVAL_MAX_MARKS, SV_RIBBON_INTERVAL_MAX_VIEW_SPAN, SV_RIBBON_MAX_CACHE_FEATURES, SV_RIBBON_MAX_CACHE_TILES, SV_SIGNAL_LOD_LEVELS } from './svConstants.js'
import { clamp } from './svFormat.js'

export function getSvDataTrackKey(track) {
  return String(track?.id || `${track?.side || ''}:${track?.type || ''}:${track?.path || ''}`).trim()
}

export function getSvDataTrackLabel(track) {
  const label = String(track?.label || '').trim()
  if (label) return label
  return 'SV intervals'
}

export function getSvDataTracksForSide(bufferData, side) {
  const tracks = bufferData?.tracks?.[side]
  if (!Array.isArray(tracks)) return []
  return tracks.filter((track) => {
    const type = String(track?.type || '').toLowerCase()
    return track?.path && type === 'bigbed'
  })
}

export function getSvSignalTracksForSide(bufferData, side) {
  const tracks = bufferData?.tracks?.[side]
  if (!Array.isArray(tracks)) return []
  return tracks.filter((track) => {
    const type = String(track?.type || '').toLowerCase()
    return track?.path && type === 'bigwig'
  })
}

export function svBigBedFeatureKey(feature) {
  const start = Number(feature?.start) || 0
  const end = Number(feature?.end) || 0
  const name = String(feature?.name || '')
  const strand = String(feature?.strand || '.')
  const score = String(feature?.score ?? '')
  const color = String(feature?.itemRgb || feature?.color || '')
  const blockCount = String(feature?.block_count ?? '')
  const blockSizes = String(feature?.block_sizes || '')
  const blockStarts = String(feature?.block_starts || '')
  const renderKind = String(feature?.render_kind || feature?._render_kind || '')
  return `${start}|${end}|${name}|${strand}|${score}|${color}|${blockCount}|${blockSizes}|${blockStarts}|${renderKind}`
}

export function svNormalizeBigBedFeature(feature) {
  if (!feature || typeof feature !== 'object') return null
  const start = Number(feature?.start)
  const end = Number(feature?.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const exonBlocks = Array.isArray(feature?.exon_blocks) ? feature.exon_blocks : []
  const cdsBlocks = Array.isArray(feature?.cds_blocks) ? feature.cds_blocks : []
  const renderKind = String(feature?.render_kind || '').trim().toLowerCase() || 'interval'
  return {
    ...feature,
    start,
    end,
    _key: svBigBedFeatureKey(feature),
    _render_kind: renderKind,
    _structure_valid: feature?.structure_valid === true,
    _exon_blocks: exonBlocks,
    _cds_blocks: cdsBlocks,
  }
}

export function svBigBedFeatureTileKey(trackId, chrom, tileStart, tileEnd) {
  return `${SV_AUX_TRACK_CACHE_VERSION}:svbbft:${trackId}|${chrom}|${tileStart}|${tileEnd}`
}

export function selectSvFetchPlansFairly(plans, maxTotal, maxPerGroup = maxTotal) {
  if (!Array.isArray(plans) || plans.length === 0 || maxTotal <= 0) return []
  const queues = new Map()
  for (const plan of plans) {
    const groupKey = String(plan?.trackKey || plan?.tileKey || '')
    if (!queues.has(groupKey)) queues.set(groupKey, [])
    queues.get(groupKey).push(plan)
  }

  const selected = []
  const selectedPerGroup = new Map()
  let madeProgress = true
  while (selected.length < maxTotal && madeProgress) {
    madeProgress = false
    for (const [groupKey, queue] of queues.entries()) {
      if (selected.length >= maxTotal) break
      const groupCount = selectedPerGroup.get(groupKey) || 0
      if (groupCount >= maxPerGroup || queue.length === 0) continue
      selected.push(queue.shift())
      selectedPerGroup.set(groupKey, groupCount + 1)
      madeProgress = true
    }
  }
  return selected
}

export function getSvSignalLevel(bpPerPx) {
  for (const level of SV_SIGNAL_LOD_LEVELS) {
    if (bpPerPx >= level.minBpPerPx) return level
  }
  return SV_SIGNAL_LOD_LEVELS[SV_SIGNAL_LOD_LEVELS.length - 1]
}

export function svSignalTileKey(trackId, chrom, levelId, tileStart) {
  return `${SV_AUX_TRACK_CACHE_VERSION}:svsig:${trackId}|${chrom}|${levelId}|${tileStart}`
}

export function projectSvSignalTiles(cache, trackId, chrom, level, visStart, visEnd, outBins) {
  const empty = { bins: Array(outBins).fill(null), populated: new Uint8Array(outBins), has_data: false, min: null, max: null, coverage: 0, error: '' }
  if (!chrom || visEnd <= visStart || outBins <= 0) return empty
  const visSpan = Math.max(1, visEnd - visStart)
  const tileSpan = level.bpPerBin * level.binsPerTile
  const firstTile = Math.floor(visStart / tileSpan) * tileSpan
  const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
  const out = Array(outBins).fill(null)
  const populated = new Uint8Array(outBins)
  let hasData = false
  let bestError = ''

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tile = cache.get(svSignalTileKey(trackId, chrom, level.id, tileStart))
    if (!tile) continue
    if (tile?.error && !bestError) bestError = String(tile.error)
    const bins = Array.isArray(tile?.bins) ? tile.bins : []
    const bpPerBin = Math.max(1, Number(tile?.bpPerBin || level.bpPerBin))
    for (let i = 0; i < bins.length; i += 1) {
      const gStart = Number(tile.start || tileStart) + i * bpPerBin
      const gEnd = gStart + bpPerBin
      if (gEnd < visStart || gStart > visEnd) continue
      let x1 = Math.floor(((gStart - visStart) / visSpan) * outBins)
      let x2 = Math.ceil(((gEnd - visStart) / visSpan) * outBins)
      x1 = Math.max(0, Math.min(outBins - 1, x1))
      x2 = Math.max(x1 + 1, Math.min(outBins, x2))
      for (let x = x1; x < x2; x += 1) populated[x] = 1
      const value = Number(bins[i])
      if (!Number.isFinite(value)) continue
      hasData = true
      for (let x = x1; x < x2; x += 1) {
        out[x] = out[x] === null ? value : Math.max(out[x], value)
      }
    }
  }

  let populatedCount = 0
  for (let i = 0; i < outBins; i += 1) if (populated[i]) populatedCount += 1
  const observed = out.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return {
    bins: out,
    populated,
    has_data: hasData,
    min: observed.length ? Math.min(...observed) : null,
    max: observed.length ? Math.max(...observed) : null,
    coverage: populatedCount / Math.max(1, outBins),
    error: bestError,
  }
}

export function projectSvSignalTilesCascade(cache, trackId, chrom, targetLevel, visStart, visEnd, outBins) {
  const targetIndex = Math.max(0, SV_SIGNAL_LOD_LEVELS.findIndex((level) => level.id === targetLevel.id))
  const fine = projectSvSignalTiles(cache, trackId, chrom, targetLevel, visStart, visEnd, outBins)
  if (fine.coverage >= 0.99 || targetIndex <= 0) return fine
  const mergedBins = [...fine.bins]
  const mergedPopulated = new Uint8Array(outBins)
  let popCount = 0
  for (let i = 0; i < outBins; i += 1) {
    mergedPopulated[i] = fine.populated[i] ? 1 : 0
    if (mergedPopulated[i]) popCount += 1
  }
  let bestError = fine.error
  for (let levelIndex = targetIndex - 1; levelIndex >= 0 && popCount < outBins; levelIndex -= 1) {
    const coarse = projectSvSignalTiles(cache, trackId, chrom, SV_SIGNAL_LOD_LEVELS[levelIndex], visStart, visEnd, outBins)
    if (!bestError && coarse.error) bestError = coarse.error
    for (let i = 0; i < outBins; i += 1) {
      if (mergedPopulated[i] || !coarse.populated[i]) continue
      mergedBins[i] = coarse.bins[i]
      mergedPopulated[i] = 1
      popCount += 1
    }
  }
  const observed = mergedBins.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return {
    bins: mergedBins,
    populated: mergedPopulated,
    has_data: observed.length > 0,
    min: observed.length ? Math.min(...observed) : null,
    max: observed.length ? Math.max(...observed) : null,
    coverage: popCount / Math.max(1, outBins),
    error: bestError,
  }
}

export function selectSvOrderStatistic(values, targetIndex) {
  let left = 0
  let right = values.length - 1
  const target = Math.max(0, Math.min(right, targetIndex))
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)]
    let low = left
    let high = right
    while (low <= high) {
      while (values[low] < pivot) low += 1
      while (values[high] > pivot) high -= 1
      if (low <= high) {
        const tmp = values[low]
        values[low] = values[high]
        values[high] = tmp
        low += 1
        high -= 1
      }
    }
    if (target <= high) right = high
    else if (target >= low) left = low
    else return values[target]
  }
  return values[target]
}

export function buildSvSignalPath(bins, width, height) {
  const values = (Array.isArray(bins) ? bins : []).filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!values.length || width <= 0 || height <= 0) return ''
  const working = [...values]
  const lo = Math.min(0, selectSvOrderStatistic(working, Math.floor(working.length * 0.02)) ?? values[0])
  let hi = selectSvOrderStatistic(working, Math.floor(working.length * 0.98)) ?? values[values.length - 1]
  if (!Number.isFinite(hi) || hi <= lo) hi = Math.max(...values) + 1
  const scale = Math.max(1e-9, hi - lo)
  const gamma = 0.55
  const baseY = height - 5
  let path = `M 0 ${baseY}`
  const binCount = Math.max(1, bins.length)
  bins.forEach((value, index) => {
    const x0 = (index / binCount) * width
    const x1 = ((index + 1) / binCount) * width
    const numeric = Number(value)
    const normalized = Number.isFinite(numeric) ? clamp((numeric - lo) / scale, 0, 1) : 0
    const boosted = Math.pow(normalized, gamma)
    const y = baseY - boosted * Math.max(6, height - 12)
    path += ` L ${x0.toFixed(2)} ${y.toFixed(2)} L ${x1.toFixed(2)} ${y.toFixed(2)}`
  })
  path += ` L ${width} ${baseY} Z`
  return path
}

export function projectSvRibbonFeatureTiles(cache, trackKey, chrom, visStart, visEnd) {
  const tileSpan = SV_BIGBED_FEATURE_TILE_SPAN
  const firstTile = Math.floor(visStart / tileSpan) * tileSpan
  const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
  const dedup = new Map()
  let expectedTiles = 0
  let fetchedTiles = 0

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tileEnd = tileStart + tileSpan
    expectedTiles += 1
    const tile = cache.get(svBigBedFeatureTileKey(trackKey, chrom, tileStart, tileEnd))
    if (!tile) continue
    fetchedTiles += 1
    const rows = Array.isArray(tile?.features) ? tile.features : []
    for (const row of rows) {
      const normalized = row?._key ? row : svNormalizeBigBedFeature(row)
      if (!normalized) continue
      if (normalized.end <= visStart || normalized.start >= visEnd) continue
      const key = normalized._key || svBigBedFeatureKey(normalized)
      if (dedup.has(key)) continue
      dedup.set(key, normalized)
    }
  }

  const features = Array.from(dedup.values()).sort((a, b) => (
    (a.start - b.start)
    || (a.end - b.end)
    || String(a?.name || '').localeCompare(String(b?.name || ''))
    || String(a?._key || '').localeCompare(String(b?._key || ''))
  ))
  return {
    mode: 'features',
    features: features.slice(0, SV_RIBBON_INTERVAL_MAX_FEATURES),
    tile_coverage: expectedTiles > 0 ? fetchedTiles / expectedTiles : 0,
    truncated: features.length > SV_RIBBON_INTERVAL_MAX_FEATURES,
  }
}

export function trimSvRibbonFeatureCache(cache) {
  if (!(cache instanceof Map) || !cache.size) return
  let featureCount = 0
  for (const tile of cache.values()) {
    featureCount += Array.isArray(tile?.features) ? tile.features.length : 0
  }
  while (cache.size > SV_RIBBON_MAX_CACHE_TILES || featureCount > SV_RIBBON_MAX_CACHE_FEATURES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    const oldestTile = cache.get(oldestKey)
    featureCount -= Array.isArray(oldestTile?.features) ? oldestTile.features.length : 0
    cache.delete(oldestKey)
  }
}

export function getSvRibbonIntervalMinWidth(viewSpan, plotWidth) {
  if (viewSpan <= 1000) return 1
  const sequenceFloorWidth = Math.max(1, plotWidth / 1000)
  const maxBoost = Math.max(sequenceFloorWidth, 6)
  const t = clamp((viewSpan - 1000) / Math.max(1, SV_RIBBON_INTERVAL_MAX_VIEW_SPAN - 1000), 0, 1)
  return 1 + (maxBoost - 1) * t
}

export function buildSvRibbonIntervalMarks(features, win, plotWidth, lodSpan = null) {
  const safeFeatures = Array.isArray(features) ? features : []
  if (!win?.chrom || !safeFeatures.length) return []
  const viewStart = Number(win.start)
  const viewEnd = Number(win.end)
  const span = Math.max(1, viewEnd - viewStart)
  const effectiveLodSpan = Number.isFinite(lodSpan) && lodSpan > 0 ? lodSpan : span
  const minWidth = getSvRibbonIntervalMinWidth(effectiveLodSpan, plotWidth * (effectiveLodSpan / span))
  const useActualWidth = effectiveLodSpan <= 1000
  const mergeGapPx = effectiveLodSpan > 500_000 ? 1.5 : effectiveLodSpan > 250_000 ? 0.75 : 0

  const items = []
  for (const feature of safeFeatures) {
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (end <= viewStart || start >= viewEnd) continue
    const x0 = ((start - viewStart) / span) * plotWidth
    const x1 = ((end - viewStart) / span) * plotWidth
    const actualX = clamp(x0, 0, plotWidth)
    const actualW = Math.max(1, clamp(x1, 0, plotWidth) - actualX)
    const drawW = useActualWidth ? actualW : Math.max(actualW, minWidth)
    const drawX = clamp(actualX - ((drawW - actualW) / 2), 0, Math.max(0, plotWidth - drawW))
    items.push({
      x: drawX,
      w: Math.min(drawW, plotWidth),
      actualX,
      actualW,
      start,
      end,
      features: [feature],
    })
  }

  if (mergeGapPx <= 0) return items.slice(0, SV_RIBBON_INTERVAL_MAX_MARKS)

  const merged = []
  for (const item of items) {
    const last = merged[merged.length - 1]
    if (last && item.x <= (last.x + last.w + mergeGapPx)) {
      const right = Math.max(last.x + last.w, item.x + item.w)
      last.x = Math.min(last.x, item.x)
      last.w = right - last.x
      last.start = Math.min(last.start, item.start)
      last.end = Math.max(last.end, item.end)
      last.features.push(...item.features)
    } else {
      merged.push({ ...item, features: [...item.features] })
    }
  }
  return merged.slice(0, SV_RIBBON_INTERVAL_MAX_MARKS)
}
