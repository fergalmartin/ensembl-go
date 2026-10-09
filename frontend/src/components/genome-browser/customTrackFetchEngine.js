// The custom-track fetch engine of a Genome Browser panel: for every visible custom
// track, choose the level of detail for the current view, project what the tile caches
// already hold, and fetch what is missing (debounced, de-duplicated, stale results
// dropped by epoch). Runs as the panel's effect; returns its cleanup.
import { API_BASE } from '../../backendRuntime.js'
import { VCF_BLOCK_LEVELS, buildVcfOverviewWarmupKey, getVcfViewportIntent } from '../../utils/vcfTileStrategy.js'
import {
    BED_DENSITY_LEVELS,
    BIGBED_BLOCK_LEVELS,
    BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
    BIGBED_FEATURE_TILE_SPAN,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    LHS_WIDTH,
    SPLICE_BLOCK_LEVELS,
    TRACK_LOD_LEVELS,
    VCF_LOD_LEVELS,
    isGeneModelTrack,
    isIntervalTrackType,
} from './browserConstants.js'
import {
    getFetchErrorMessage,
    isTransientFetchError,
    isTransientFetchErrorMessage,
    normalizeBigBedFeatureForRender,
    shiftBedFeatureToBrowserFrame,
    shiftBedInterval,
} from './trackData.js'
import { isVcfAdaptiveLikeMode, normalizeSpliceTrackSettings, normalizeVcfDisplayMode } from './trackSettings.js'

export function runCustomTrackFetchEngine(ctx) {
    const {
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
    } = ctx
        if (!isActive) return
        if (!selectedChrom || customTracks.length === 0) return

        const epoch = ++fetchEpochRef.current
        const displayBins = Math.max(80, Math.min(1400, Math.floor(viewWidth - LHS_WIDTH - 44)))
        const visStart = Math.max(0, Math.floor(genomicViewRange.start))
        const visEnd = Math.max(visStart + 1, Math.ceil(genomicViewRange.end))
        const visSpan = visEnd - visStart
        const bpPerPx = visSpan / Math.max(1, viewWidth - LHS_WIDTH)
        const targetLevel = getBigWigLevel(bpPerPx)
        const center = (visStart + visEnd) / 2
        const nowMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
        const nextVcfViewportIntent = getVcfViewportIntent({
            previous: vcfViewportIntentRef.current,
            center,
            span: visSpan,
            nowMs,
        })
        vcfViewportIntentRef.current = nextVcfViewportIntent
        const vcfViewportIntent = nextVcfViewportIntent.intent
        // Buffer: 2× viewport on each side = 5× total covered
        const bufferSpan = visSpan * 2
        const bufferStart = Math.max(0, visStart - bufferSpan)
        const bufferEnd = visEnd + bufferSpan

        // ── Step 1: Immediately project from cache and update displayed data ──────────────────
        for (const track of customTracks) {
            if (!track?.path || !track.visible) continue
            const trackType = track.type || 'bigwig'

            if (trackType === 'vcf') {
                const vcfMode = normalizeVcfDisplayMode(track.renderMode)
                let projected
                if (isVcfAdaptiveLikeMode(vcfMode)) {
                    const vcfLevel = getVcfBlockLevel(bpPerPx)
                    if (vcfLevel.mode === 'detail') {
                        projected = projectVcfAdaptiveDetailLevel(track.id, selectedChrom, vcfLevel, visStart, visEnd)
                    } else {
                        projected = projectVcfBlockTilesCascadeToView(track.id, selectedChrom, vcfLevel, visStart, visEnd, displayBins)
                    }
                    const l0 = VCF_BLOCK_LEVELS[0]
                    const overviewWarmupKey = buildVcfOverviewWarmupKey({
                        trackId: track.id,
                        path: track.path,
                        chrom: selectedChrom,
                        chromLength,
                        level: l0,
                    })
                    const overviewWarmupPending = !!overviewWarmupKey && !vcfOverviewWarmupDoneRef.current.has(overviewWarmupKey)
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        // Don't clear a populated detail view with an empty one while tiles arrive
                        if (projected.mode === 'adp_detail') {
                            if (Array.isArray(prevData?.variants) && prevData.variants.length > 0 &&
                                projected.variants.length === 0 && Number(projected.tile_coverage) < 0.4) {
                                return prev
                            }
                        } else if (vcfMode === 'adaptive') {
                            const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                            const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                            if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                                return prev
                            }
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    const isLoading = Number(projected?.tile_coverage || 0) < 0.85 || (vcfLevel.id === 'L0' && overviewWarmupPending)
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: isLoading }))
                } else {
                    const vcfLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                    projected = projectVcfTilesToView(track.id, selectedChrom, vcfLevel, visStart, visEnd, displayBins)
                    setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                    const waitingForDetail = vcfLevel.mode === 'detail' && Number(projected?.detail_coverage || 0) < 0.95
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: projected.coverage < 0.85 || waitingForDetail }))
                }
            } else if (trackType === 'splice_junctions') {
                const spliceMode = getSpliceLodMode(track.id, bpPerPx, track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                if (spliceMode === 'blocks') {
                    const blockLevel = getSpliceBlockLevel(bpPerPx)
                    const projected = projectSpliceBlockTilesToView(
                        track.id,
                        selectedChrom,
                        blockLevel,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                        const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                        if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                } else {
                    const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevCount = Array.isArray(prevData?.junctions) ? prevData.junctions.length : 0
                        const nextCount = Array.isArray(projected?.junctions) ? projected.junctions.length : 0
                        const nextCoverage = Number(projected?.coverage || 0)
                        if (prevCount > 0 && nextCount === 0 && nextCoverage < 0.45) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    // Keep loading visible until cached coverage is reasonably complete.
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.coverage || 0) < 0.75 }))
                }
            } else if (isIntervalTrackType(trackType) && track.renderMode === 'density') {
                const densityLevel = getBedDensityLevel(bpPerPx)
                const projected = projectBedDensityTilesToView(track.id, selectedChrom, densityLevel, visStart, visEnd)
                setCustomTrackData((prev) => {
                    const prevData = prev[track.id]
                    const prevBins = prevData?.mode === 'bed_density' && Array.isArray(prevData?.density_bins) ? prevData.density_bins : []
                    if (prevBins.length > 0 && projected.density_bins.length === 0 && projected.tile_coverage < 0.4) {
                        return prev
                    }
                    return { ...prev, [track.id]: projected }
                })
                setCustomTrackLoading((prev) => ({ ...prev, [track.id]: projected.tile_coverage < 0.85 }))
            } else if (isIntervalTrackType(trackType)) {
                const bigBedMode = getBigBedLodMode(track.id, bpPerPx)
                if (bigBedMode === 'blocks') {
                    const blockLevel = getBigBedBlockLevel(bpPerPx)
                    const projected = projectBigBedBlockTilesToView(
                        track.id,
                        selectedChrom,
                        blockLevel,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                        const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                        if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                } else {
                    const projected = projectBigBedFeatureTilesToView(
                        track.id,
                        selectedChrom,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                        { labelled: isGeneModelTrack(track) },
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevCount = Array.isArray(prevData?.features) ? prevData.features.length : 0
                        const nextCount = Array.isArray(projected?.features) ? projected.features.length : 0
                        if (prevCount > 0 && nextCount === 0 && Number(projected?.tile_coverage || 0) < 0.4) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                }
            } else if (['bigwig', 'bam'].includes(trackType)) {
                // Signal tracks: always project from cache (uses coarse-to-fine fallback)
                const projected = projectBigWigTilesToView(track.id, selectedChrom, targetLevel, visStart, visEnd, displayBins)
                setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                // Only mark as loading if we have very little data
                setCustomTrackLoading((prev) => ({ ...prev, [track.id]: projected.coverage < 0.3 }))
            } else {
                // Discrete tracks: pull from feature cache if available
                const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                const cached = trackFeatureCacheRef.current.get(featureKey)
                if (cached) {
                    setCustomTrackData((prev) => ({ ...prev, [track.id]: cached }))
                }
            }
        }

        // ── Step 2: Determine what tiles need fetching ────────────────────────────────────────
        const fetchPlans = [] // { track, level, tileStart, tileEnd, priority }

        for (const track of customTracks) {
            if (!track?.path || !track.visible) continue
            const trackType = track.type || 'bigwig'
            const isSignalTrack = ['bigwig', 'bam', 'long_reads'].includes(trackType)

            if (trackType === 'vcf') {
                const vcfMode = normalizeVcfDisplayMode(track.renderMode)
                if (isVcfAdaptiveLikeMode(vcfMode)) {
                    // ── Adaptive mode: use new VCF_BLOCK_LEVELS + /api/browse/vcf/block_tiles ──
                    const targetLevel = getVcfBlockLevel(bpPerPx)
                    const targetIdx = VCF_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const isDetailLevel = targetLevel.mode === 'detail'
                    const isCoarseOverview = !isDetailLevel && bpPerPx >= 250
                    const isZoomingVcf = vcfViewportIntent === 'zooming'
                    const isPanningVcf = vcfViewportIntent === 'panning'
                    const vcfBufferFactor = isDetailLevel
                        ? (isZoomingVcf ? 0.35 : isPanningVcf ? 1.15 : 2.25)
                        : (isCoarseOverview ? 0.35 : isZoomingVcf ? 0.4 : isPanningVcf ? 1.1 : 1.8)
                    const vcfBufferSpan = visSpan * vcfBufferFactor
                    const vcfBufferStart = Math.max(0, visStart - vcfBufferSpan)
                    const vcfBufferEnd = visEnd + vcfBufferSpan
                    const levelsToFetch = [targetLevel]
                    if (!isDetailLevel && !isCoarseOverview && targetIdx > 0 && !isZoomingVcf) {
                        levelsToFetch.push(VCF_BLOCK_LEVELS[targetIdx - 1])
                    }
                    const plannedVcfKeys = new Set()
                    const addVcfPlan = (level, tileStart, isBackground, isOverviewWarmup = false) => {
                        const tileSpan = level.tileSpanBp
                        const isDetail = level.mode === 'detail'
                        const normalizedStart = Math.max(0, Math.floor(tileStart))
                        const tileEnd = normalizedStart + tileSpan
                        const key = isDetail
                            ? makeVcfAdpDetailKey(track.id, selectedChrom, normalizedStart, tileEnd)
                            : makeVcfBlockTileKey(track.id, selectedChrom, level.id, normalizedStart, tileEnd)
                        if (plannedVcfKeys.has(key)) return
                        plannedVcfKeys.add(key)
                        if (vcfBlockTileCacheRef.current.has(key)) return
                        if (vcfBlockTileFetchSetRef.current.has(key)) return
                        const distFromCenter = Math.abs((normalizedStart + tileSpan / 2) - center)
                        const levelBonus = level.id === targetLevel.id ? 0 : (visSpan * 4)
                        const backgroundBonus = isBackground ? (isOverviewWarmup ? (visSpan * 1.5) : (visSpan * 7)) : 0
                        fetchPlans.push({
                            track,
                            isVcfBlock: !isDetail,
                            isVcfAdpDetail: isDetail,
                            isBackground: !!isBackground,
                            isOverviewWarmup: !!isOverviewWarmup,
                            vcfBlockLevel: level,
                            tileStart: normalizedStart,
                            tileEnd,
                            key,
                            priority: distFromCenter + levelBonus + backgroundBonus,
                        })
                    }

                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const foregroundPad = level.mode === 'detail'
                            ? (isZoomingVcf ? 0 : visSpan * 0.2)
                            : (isZoomingVcf ? 0 : visSpan * 0.1)
                        const fgStart = Math.max(0, visStart - foregroundPad)
                        const fgEnd = visEnd + foregroundPad
                        const fgFirstTile = Math.floor(fgStart / tileSpan) * tileSpan
                        const fgLastTile = Math.floor((fgEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = fgFirstTile; tileStart <= fgLastTile; tileStart += tileSpan) {
                            addVcfPlan(level, tileStart, false)
                        }

                        const isFullChromOverview = false
                        const bgStart = vcfBufferStart
                        const bgEnd = vcfBufferEnd
                        const bgFirstTile = Math.floor(Math.max(0, bgStart) / tileSpan) * tileSpan
                        const bgLastTile = Math.floor((Math.max(bgFirstTile + 1, bgEnd) - 1) / tileSpan) * tileSpan
                        for (let tileStart = bgFirstTile; tileStart <= bgLastTile; tileStart += tileSpan) {
                            addVcfPlan(level, tileStart, true, isFullChromOverview)
                        }
                    }
                } else {
                    // ── Non-adaptive mode: original /api/browse/vcf/tiles flow ──────────────
                    const vcfTargetLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                    const vcfTargetIdx = Math.max(0, VCF_LOD_LEVELS.findIndex((l) => l.id === vcfTargetLevel.id))
                    const levelsToFetch = [vcfTargetLevel]
                    if (vcfTargetIdx > 0) levelsToFetch.push(VCF_LOD_LEVELS[vcfTargetIdx - 1])
                    if (vcfTargetIdx > 1) levelsToFetch.push(VCF_LOD_LEVELS[vcfTargetIdx - 2])

                    for (const level of levelsToFetch) {
                        const tileSpan = level.bpPerBin * level.binsPerTile
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeVcfTileKey(
                                track.id, selectedChrom, level.id, level.mode,
                                tileStart, tileEnd, 0, 0, 0.5, '',
                            )
                            if (vcfTileCacheRef.current.has(key)) continue
                            if (vcfTileFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === vcfTargetLevel.id ? 0 : 12000
                            fetchPlans.push({
                                track,
                                isVcf: true,
                                vcfLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                }
                continue
            }

            if (trackType === 'splice_junctions') {
                const spliceMode = getSpliceLodMode(track.id, bpPerPx, track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                if (spliceMode === 'blocks') {
                    const targetLevel = getSpliceBlockLevel(bpPerPx)
                    const targetIdx = SPLICE_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const levelsToFetch = [targetLevel]
                    if (targetIdx > 0) levelsToFetch.push(SPLICE_BLOCK_LEVELS[targetIdx - 1])

                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeSpliceBlockTileKey(track.id, selectedChrom, level.id, tileStart, tileEnd)
                            if (trackFeatureCacheRef.current.has(key)) continue
                            if (trackFeatureFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === targetLevel.id ? 0 : 9000
                            fetchPlans.push({
                                track,
                                isSpliceBlock: true,
                                spliceBlockLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                } else {
                    const tileSpan = getSpliceTileSpan(bpPerPx)
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const tileEnd = tileStart + tileSpan
                        const key = makeSpliceTileKey(track.id, selectedChrom, tileStart, tileEnd)
                        if (trackFeatureCacheRef.current.has(key)) continue
                        if (trackFeatureFetchSetRef.current.has(key)) continue
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        fetchPlans.push({
                            track,
                            isSplice: true,
                            tileStart,
                            tileEnd,
                            key,
                            priority: distFromCenter,
                        })
                    }
                }
                continue
            }

            if (isIntervalTrackType(trackType)) {
                // Tiles past the chromosome end hold nothing and would only use up the cap.
                const bedBufferEnd = chromLength > 0 ? Math.min(bufferEnd, chromLength) : bufferEnd
                if (track.renderMode === 'density') {
                    const targetLevel = getBedDensityLevel(bpPerPx)
                    const targetIdx = BED_DENSITY_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const levelsToFetch = [targetLevel]
                    if (targetIdx > 0) levelsToFetch.push(BED_DENSITY_LEVELS[targetIdx - 1])
                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bedBufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeBedDensityTileKey(track.id, selectedChrom, level.id, tileStart, tileEnd)
                            if (trackFeatureCacheRef.current.has(key)) continue
                            if (trackFeatureFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === targetLevel.id ? 0 : 9000
                            fetchPlans.push({
                                track,
                                isBedDensity: true,
                                bedDensityLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                    continue
                }
                const bigBedMode = getBigBedLodMode(track.id, bpPerPx)
                if (bigBedMode === 'blocks') {
                    const targetLevel = getBigBedBlockLevel(bpPerPx)
                    const targetIdx = BIGBED_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const levelsToFetch = [targetLevel]
                    if (targetIdx > 0) levelsToFetch.push(BIGBED_BLOCK_LEVELS[targetIdx - 1])
                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bedBufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeBigBedBlockTileKey(track.id, selectedChrom, level.id, tileStart, tileEnd)
                            if (trackFeatureCacheRef.current.has(key)) continue
                            if (trackFeatureFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === targetLevel.id ? 0 : 9000
                            fetchPlans.push({
                                track,
                                isBigBedBlock: true,
                                bigBedBlockLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                } else {
                    const tileSpan = BIGBED_FEATURE_TILE_SPAN
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bedBufferEnd - 1) / tileSpan) * tileSpan
                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const tileEnd = tileStart + tileSpan
                        const key = makeBigBedFeatureTileKey(track.id, selectedChrom, tileStart, tileEnd)
                        if (trackFeatureCacheRef.current.has(key)) continue
                        if (trackFeatureFetchSetRef.current.has(key)) continue
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        fetchPlans.push({
                            track,
                            isBigBedFeature: true,
                            tileStart,
                            tileEnd,
                            key,
                            priority: distFromCenter,
                        })
                    }
                }
                continue
            }

            // Pre-fetch L0 (overview) for stable chrom-wide scale if not already cached
            if (isSignalTrack) {
                const scaleKey = `${track.id}|${selectedChrom}`
                if (!trackChromScaleRef.current[scaleKey]) {
                    const l0 = TRACK_LOD_LEVELS[0] // L0 = 10000 bp/bin
                    const l0TileSpan = l0.bpPerBin * l0.binsPerTile
                    // Fetch 3 overview tiles centred on viewport
                    const l0Tiles = [-1, 0, 1].map(offset =>
                        Math.floor(center / l0TileSpan + offset) * l0TileSpan
                    )
                    for (const tileStart of l0Tiles) {
                        const key = makeBigWigTileKey(track.id, selectedChrom, l0.id, tileStart)
                        if (!trackTileCacheRef.current.has(key) && !trackTileFetchSetRef.current.has(key)) {
                            fetchPlans.push({ track, level: l0, tileStart, tileEnd: tileStart + l0TileSpan, priority: 100 })
                        }
                    }
                }
            }

            if (isSignalTrack) {
                // For signal tracks: fetch target level + one level up (fallback)
                const levelsToFetch = [targetLevel]
                const targetIdx = TRACK_LOD_LEVELS.indexOf(targetLevel)
                if (targetIdx > 0) levelsToFetch.push(TRACK_LOD_LEVELS[targetIdx - 1])

                for (const level of levelsToFetch) {
                    const tileSpan = level.bpPerBin * level.binsPerTile
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan

                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const key = makeBigWigTileKey(track.id, selectedChrom, level.id, tileStart)
                        if (trackTileCacheRef.current.has(key)) continue
                        if (trackTileFetchSetRef.current.has(key)) continue
                        // Priority: target level > coarser levels; closer to centre = higher priority
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        const levelBonus = level.id === targetLevel.id ? 0 : 10000
                        fetchPlans.push({ track, level, tileStart, tileEnd: tileStart + tileSpan, priority: distFromCenter + levelBonus })
                    }
                }
            } else {
                // Discrete tracks (VCF, BED, splice_junctions, long_reads by transcript):
                // Use a simpler region-based fetch covering the buffer zone
                const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                if (!trackFeatureCacheRef.current.has(featureKey) && !trackFeatureFetchSetRef.current.has(featureKey)) {
                    fetchPlans.push({ track, level: targetLevel, tileStart: bufferStart, tileEnd: bufferEnd, priority: 0, isDiscrete: true })
                }
            }
        }

        if (fetchPlans.length === 0) return

        // Sort by priority (lower = higher priority)
        fetchPlans.sort((a, b) => a.priority - b.priority)
        // Cap to prevent request storms
        const signalPlans = fetchPlans.filter((p) => !p.isDiscrete && !p.isVcf && !p.isVcfBlock && !p.isVcfAdpDetail && !p.isSplice && !p.isSpliceBlock && !p.isBigBedBlock && !p.isBigBedFeature && !p.isBedDensity).slice(0, 12)
        const discretePlans = fetchPlans.filter(p => p.isDiscrete)
        const splicePlans = fetchPlans.filter((p) => p.isSplice).slice(0, 14)
        const spliceBlockPlans = fetchPlans.filter((p) => p.isSpliceBlock).slice(0, 14)
        const allBigBedBlockPlans = fetchPlans.filter((p) => p.isBigBedBlock)
        const allBigBedFeaturePlans = fetchPlans.filter((p) => p.isBigBedFeature)
        const allBedDensityPlans = fetchPlans.filter((p) => p.isBedDensity)
        const bigBedBlockPlans = allBigBedBlockPlans.slice(0, 12)
        const bigBedFeaturePlans = allBigBedFeaturePlans.slice(0, 14)
        const bedDensityPlans = allBedDensityPlans.slice(0, 12)
        // The caps keep one round small, and the plans left over are the edges of the
        // buffer. Without asking again once a round lands they were only fetched on the
        // next pan, so a zoomed-out view stayed patchy until the reader moved it.
        const hasMoreBedPlans = (
            allBigBedBlockPlans.length > bigBedBlockPlans.length
            || allBigBedFeaturePlans.length > bigBedFeaturePlans.length
            || allBedDensityPlans.length > bedDensityPlans.length
        )
        const vcfPlans = fetchPlans.filter((p) => p.isVcf).slice(0, 10)
        const vcfBlockLevelForCap = getVcfBlockLevel(bpPerPx)
        const vcfBlockTileSpanForCap = Number(vcfBlockLevelForCap?.mode === 'detail'
            ? VCF_BLOCK_LEVELS[Math.max(0, VCF_BLOCK_LEVELS.findIndex((l) => l.id === vcfBlockLevelForCap.id) - 1)]?.tileSpanBp
            : vcfBlockLevelForCap?.tileSpanBp) || 5_000_000
        const vcfViewportTiles = Math.max(
            1,
            Math.floor((visEnd - 1) / vcfBlockTileSpanForCap) - Math.floor(visStart / vcfBlockTileSpanForCap) + 1,
        )
        const allVcfBlockPlans = fetchPlans.filter((p) => p.isVcfBlock)
        const vcfBlockForegroundPlans = allVcfBlockPlans.filter((p) => !p.isBackground)
        const vcfBlockBackgroundPlans = allVcfBlockPlans.filter((p) => p.isBackground)
        const vcfOverviewWarmupPlans = vcfBlockBackgroundPlans.filter((p) => p.isOverviewWarmup)
        const vcfOtherBlockBackgroundPlans = vcfBlockBackgroundPlans.filter((p) => !p.isOverviewWarmup)
        const vcfOverviewWarmupCap = vcfBlockLevelForCap?.id === 'L0' && vcfViewportIntent !== 'zooming'
            ? 18
            : (vcfViewportIntent === 'zooming' ? 1 : 3)
        const vcfBlockBackgroundCap = vcfViewportIntent === 'zooming' ? 1 : vcfViewportIntent === 'panning' ? 3 : 5
        const vcfBlockForegroundCap = Math.max(vcfViewportTiles, Math.min(18, vcfViewportTiles + 2))
        const vcfBlockPlans = [
            ...vcfBlockForegroundPlans.slice(0, vcfBlockForegroundCap),
            ...vcfOverviewWarmupPlans.slice(0, vcfOverviewWarmupCap),
            ...vcfOtherBlockBackgroundPlans.slice(0, vcfBlockBackgroundCap),
        ]

        const allVcfAdpDetailPlans = fetchPlans.filter((p) => p.isVcfAdpDetail)
        const vcfAdpDetailForegroundPlans = allVcfAdpDetailPlans.filter((p) => !p.isBackground)
        const vcfAdpDetailBackgroundPlans = allVcfAdpDetailPlans.filter((p) => p.isBackground)
        const vcfAdpDetailPlans = [
            ...vcfAdpDetailForegroundPlans.slice(0, 12),
            ...vcfAdpDetailBackgroundPlans.slice(0, vcfViewportIntent === 'zooming' ? 0 : 6),
        ]
        const hasMoreVcfBlockPlans = allVcfBlockPlans.length > vcfBlockPlans.length
        const hasMoreVcfAdpDetailPlans = allVcfAdpDetailPlans.length > vcfAdpDetailPlans.length
        const toFetch = [...signalPlans, ...discretePlans, ...splicePlans]

        // ── Step 3: Issue fetches after 50ms debounce ─────────────────────────────────────────
        // IMPORTANT: Only the timer is cancelled on cleanup — in-flight responses ALWAYS cache
        // their data because tiles are keyed by genomic coordinates, not screen position.
        const timer = setTimeout(() => {
            if (fetchEpochRef.current !== epoch) return  // viewport moved; skip dispatch but don't cancel existing fetches
            evictOldTilesIfNeeded()

            // ── Adaptive VCF block tiles → /api/browse/vcf/block_tiles ───────────────────────
            const vcfBlockGroups = new Map()
            for (const plan of vcfBlockPlans) {
                const { track, vcfBlockLevel, tileStart, tileEnd, key } = plan
                if (vcfBlockTileCacheRef.current.has(key) || vcfBlockTileFetchSetRef.current.has(key)) continue
                vcfBlockTileFetchSetRef.current.add(key)
                if (!vcfBlockGroups.has(track.id)) {
                    vcfBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: vcfBlockLevel.id,
                    block_bp: vcfBlockLevel.blockBp,
                    window_bp: vcfBlockLevel.windowBp,
                })
            }

            for (const { track, keys, tiles } of vcfBlockGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        coverage_threshold: 0.25,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L3')
                            const selectedKey = makeVcfBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfBlockLevel(bpPerPx)
                        const projected = projectVcfBlockTilesCascadeToView(track.id, selectedChrom, freshLevel, visStart, visEnd, displayBins)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const stillLoading = Number(projected?.tile_coverage || 0) < 0.85
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading || hasMoreVcfBlockPlans) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfBlockTileFetchSetRef.current.delete(k)
                    })
            }

            // ── Splice block tiles → /api/browse/splice_junctions/block_tiles ────────────────
            const spliceBlockGroups = new Map()
            for (const plan of spliceBlockPlans) {
                const { track, spliceBlockLevel, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!spliceBlockGroups.has(track.id)) {
                    spliceBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = spliceBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: spliceBlockLevel.id,
                    block_bp: spliceBlockLevel.blockBp,
                })
            }

            for (const { track, keys, tiles } of spliceBlockGroups.values()) {
                const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                const payload = {
                    path: track.path,
                    chrom: selectedChrom,
                    genome,
                    min_reads: 1,
                    min_support: spliceSettings.min_support,
                    canonical_mode: spliceSettings.canonical_mode,
                    annotated_mode: spliceSettings.annotated_mode,
                    max_junctions: spliceSettings.max_junctions,
                    tiles,
                }
                if (track?.registryTrackId) payload.track_id = String(track.registryTrackId)

                fetch(`${API_BASE}/api/browse/splice_junctions/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L0')
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'splice_blocks',
                                start: tStart,
                                end: tEnd,
                                block_spans: Array.isArray(tile?.block_spans) ? tile.block_spans : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            // Cache under requested chrom key (used by projection) and resolved key (for alias continuity).
                            const selectedKey = makeSpliceBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeSpliceBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getSpliceBlockLevel(bpPerPx)
                        const projected = projectSpliceBlockTilesToView(
                            track.id,
                            selectedChrom,
                            freshLevel,
                            visStart,
                            visEnd,
                            Math.max(1, viewWidth - LHS_WIDTH),
                        )
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'splice_blocks', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── BigBed summary block tiles → /api/browse/bigbed/block_tiles ──────────────────
            const bigBedBlockGroups = new Map()
            for (const plan of bigBedBlockPlans) {
                const { track, bigBedBlockLevel, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!bigBedBlockGroups.has(track.id)) {
                    bigBedBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = bigBedBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: bigBedBlockLevel.id,
                    block_bp: bigBedBlockLevel.blockBp,
                })
            }

            for (const { track, keys, tiles } of bigBedBlockGroups.values()) {
                fetch(`${API_BASE}/api/browse/bigbed/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        tiles,
                        feature_model: isGeneModelTrack(track) ? 'transcripts' : '',
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const [tileIndex, tile] of returned.entries()) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L0')
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'bigbed_blocks',
                                start: tStart,
                                end: tEnd,
                                block_spans: Array.isArray(tile?.block_spans) ? tile.block_spans.map(shiftBedInterval) : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            // Tiles come back in the order they were asked for. The requested key
                            // is the one the projection looks up; a tile the backend clipped at
                            // the chromosome end would otherwise never be found, and be fetched
                            // again on every pass.
                            const selectedKey = keys[tileIndex] || makeBigBedBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeBigBedBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        // A newer pass may have skipped these tiles as in flight; ask again
                        // so whatever it still lacks is planned.
                        if (hasMoreBedPlans || fetchEpochRef.current !== epoch) setCustomTrackFetchRevision((v) => v + 1)
                        const projected = projectBedTrackToCurrentViewport(track, selectedChrom)
                        if (!projected) return
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'bigbed_blocks', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── BigBed detail feature tiles → /api/browse/bigbed/feature_tiles ───────────────
            const bigBedFeatureGroups = new Map()
            for (const plan of bigBedFeaturePlans) {
                const { track, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!bigBedFeatureGroups.has(track.id)) {
                    bigBedFeatureGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = bigBedFeatureGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: 'detail',
                    max_features: BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
                })
            }

            for (const { track, keys, tiles } of bigBedFeatureGroups.values()) {
                fetch(`${API_BASE}/api/browse/bigbed/feature_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        max_features_per_tile: BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
                        tiles,
                        feature_model: isGeneModelTrack(track) ? 'transcripts' : '',
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const [tileIndex, tile] of returned.entries()) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'bigbed_detail',
                                start: tStart,
                                end: tEnd,
                                features: Array.isArray(tile?.features)
                                    ? tile.features.map((row) => normalizeBigBedFeatureForRender(shiftBedFeatureToBrowserFrame(row))).filter(Boolean)
                                    : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            const selectedKey = keys[tileIndex] || makeBigBedFeatureTileKey(track.id, selectedChrom, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeBigBedFeatureTileKey(track.id, returnedChrom, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        if (hasMoreBedPlans || fetchEpochRef.current !== epoch) setCustomTrackFetchRevision((v) => v + 1)
                        const projected = projectBedTrackToCurrentViewport(track, selectedChrom)
                        if (!projected) return
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'bigbed_detail', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── BED/BigBed density tiles → /api/browse/bigbed/block_tiles with counts ───────────
            const bedDensityGroups = new Map()
            for (const plan of bedDensityPlans) {
                const { track, bedDensityLevel, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!bedDensityGroups.has(track.id)) {
                    bedDensityGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = bedDensityGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: bedDensityLevel.id,
                    block_bp: bedDensityLevel.blockBp,
                })
            }

            for (const { track, keys, tiles } of bedDensityGroups.values()) {
                fetch(`${API_BASE}/api/browse/bigbed/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        tiles,
                        include_counts: true,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const [tileIndex, tile] of returned.entries()) {
                            const key = keys[tileIndex]
                            if (!key) continue
                            const levelId = String(tiles[tileIndex]?.level_id || tile?.level_id || '')
                            const counts = Array.isArray(tile?.counts) ? tile.counts : []
                            trackFeatureCacheRef.current.set(key, {
                                mode: 'bed_density',
                                start: Math.max(0, Math.floor(Number(tile?.start) || 0)),
                                end: Math.ceil(Number(tile?.end) || 0),
                                block_bp: Number(tile?.block_bp) || tiles[tileIndex]?.block_bp || 1,
                                counts,
                                has_data: tile?.has_data !== false,
                                error: '',
                            })
                            const scaleKey = `${track.id}|${selectedChrom}|${levelId}`
                            const scaleEntry = bedDensityScaleRef.current[scaleKey]
                                || (bedDensityScaleRef.current[scaleKey] = { values: [], n: 0, scale: 0, tiles: new Set() })
                            // A tile fetched again after eviction must not count twice.
                            if (!scaleEntry.tiles.has(key)) {
                                scaleEntry.tiles.add(key)
                                for (const c of counts) if (c > 0) scaleEntry.values.push(c)
                            }
                        }
                        if (hasMoreBedPlans || fetchEpochRef.current !== epoch) setCustomTrackFetchRevision((v) => v + 1)
                        const projected = projectBedTrackToCurrentViewport(track, selectedChrom)
                        if (!projected) return
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'bed_density', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── Adaptive VCF L4 detail tiles → /api/browse/vcf/tiles (individual variants) ──────
            const vcfAdpDetailGroups = new Map()
            for (const plan of vcfAdpDetailPlans) {
                const { track, tileStart, tileEnd, key } = plan
                if (vcfBlockTileCacheRef.current.has(key) || vcfBlockTileFetchSetRef.current.has(key)) continue
                vcfBlockTileFetchSetRef.current.add(key)
                if (!vcfAdpDetailGroups.has(track.id)) {
                    vcfAdpDetailGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfAdpDetailGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    lod: 'L4',
                    mode: 'detail',
                    bins: 1024,
                    max_variants: 5000,
                    block_mode: 'legacy',
                })
            }

            for (const { track, keys, tiles } of vcfAdpDetailGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        include_effects: true,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const selectedKey = makeVcfAdpDetailKey(track.id, selectedChrom, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfAdpDetailKey(track.id, returnedChrom, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfBlockLevel(bpPerPx)
                        if (freshLevel.mode !== 'detail') return
                        const projected = projectVcfAdaptiveDetailLevel(track.id, selectedChrom, freshLevel, visStart, visEnd)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const stillLoading = Number(projected?.tile_coverage || 0) < 0.85
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading || hasMoreVcfAdpDetailPlans) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfBlockTileFetchSetRef.current.delete(k)
                    })
            }

            // ── Non-adaptive VCF summary/detail tiles → /api/browse/vcf/tiles ────────────────
            const vcfGroups = new Map()
            for (const plan of vcfPlans) {
                const { track, vcfLevel, tileStart, tileEnd, key } = plan
                if (vcfTileCacheRef.current.has(key) || vcfTileFetchSetRef.current.has(key)) continue
                vcfTileFetchSetRef.current.add(key)
                if (!vcfGroups.has(track.id)) {
                    vcfGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    lod: vcfLevel.id,
                    mode: vcfLevel.mode,
                    bins: vcfLevel.binsPerTile,
                    max_variants: vcfLevel.mode === 'detail' ? 5000 : 250000,
                    block_mode: 'legacy',
                })
            }

            for (const { track, keys, tiles } of vcfGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        include_effects: true,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const lodId = String(tile.lod || 'L2')
                            const mode = String(tile.mode || 'summary')
                            const selectedKey = makeVcfTileKey(
                                track.id, selectedChrom,
                                lodId, mode,
                                tStart, tEnd, 0, 0, 0.5, '',
                            )
                            vcfTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfTileKey(
                                    track.id, returnedChrom,
                                    lodId, mode,
                                    tStart, tEnd, 0, 0, 0.5, '',
                                )
                                vcfTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                        const projected = projectVcfTilesToView(track.id, selectedChrom, freshLevel, visStart, visEnd, displayBins)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const waitingForDetail = freshLevel.mode === 'detail' && Number(projected?.detail_coverage || 0) < 0.95
                        const stillLoading = projected.coverage < 0.85 || waitingForDetail
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfTileFetchSetRef.current.delete(k)
                    })
            }

            for (const plan of toFetch) {
                const { track, level, tileStart, tileEnd, isDiscrete, isSplice, key } = plan

                if (isSplice) {
                    if (!key || trackFeatureFetchSetRef.current.has(key)) continue
                    trackFeatureFetchSetRef.current.add(key)
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)

                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, Math.floor(tileStart))),
                        end: String(Math.ceil(tileEnd)),
                        level: 'fine',
                        min_reads: '1',
                        min_support: String(spliceSettings.min_support),
                        canonical_mode: String(spliceSettings.canonical_mode),
                        annotated_mode: String(spliceSettings.annotated_mode),
                        max_junctions: String(spliceSettings.max_junctions),
                        bins: String(displayBins),
                    })
                    if (track?.registryTrackId) params.set('track_id', String(track.registryTrackId))

                    fetch(`${API_BASE}/api/browse/splice_junctions?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(data => {
                            const payload = {
                                ...(data || {}),
                                mode: 'splice_arcs',
                                start: Math.max(0, Math.floor(tileStart)),
                                end: Math.ceil(tileEnd),
                                junctions: Array.isArray(data?.junctions) ? data.junctions : [],
                                has_data: true,
                                error: '',
                            }
                            trackFeatureCacheRef.current.set(key, payload)
                            if (fetchEpochRef.current !== epoch) return
                            const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: projected }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: Number(projected?.coverage || 0) < 0.75 }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            const errorMessage = getFetchErrorMessage(e)
                            if (isTransientFetchErrorMessage(errorMessage)) {
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            trackFeatureCacheRef.current.set(key, {
                                mode: 'splice_arcs',
                                start: Math.max(0, Math.floor(tileStart)),
                                end: Math.ceil(tileEnd),
                                junctions: [],
                                has_data: false,
                                error: errorMessage,
                            })
                            const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...projected, error: errorMessage || projected.error } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackFeatureFetchSetRef.current.delete(key) })
                    continue
                }

                if (isDiscrete) {
                    // ── Discrete feature fetch ────────────────────────────────────────────────
                    const trackType = track.type
                    const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                    if (trackFeatureFetchSetRef.current.has(featureKey)) continue
                    trackFeatureFetchSetRef.current.add(featureKey)

                    const fetchLod = bpPerPx > 100 ? 'region' : bpPerPx > 10 ? 'gene' : 'fine'
                    let endpoint = ''
                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, tileStart)),
                        end: String(tileEnd),
                        level: fetchLod,
                        bins: String(displayBins),
                    })

                    if (trackType === 'vcf') endpoint = 'vcf'
                    else if (trackType === 'bed' || trackType === 'bigbed') endpoint = 'bed'
                    else if (trackType === 'splice_junctions') endpoint = 'splice_junctions'
                    else if (trackType === 'long_reads') { endpoint = 'long_reads'; params.set('collapse', 'true'); params.set('max_reads', '500') }
                    else continue

                    fetch(`${API_BASE}/api/browse/${endpoint}?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(data => {
                            // Always cache the result — tiles are valid regardless of viewport changes
                            trackFeatureCacheRef.current.set(featureKey, { ...data, has_data: true, error: '' })
                            if (fetchEpochRef.current !== epoch) return
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...data, has_data: true, error: '' } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            if (isTransientFetchError(e)) {
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            const errorMessage = getFetchErrorMessage(e)
                            trackFeatureCacheRef.current.set(featureKey, { has_data: false, error: errorMessage })
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { has_data: false, error: errorMessage } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackFeatureFetchSetRef.current.delete(featureKey) })

                } else {
                    // ── Signal tile fetch (BigWig / BAM coverage) ─────────────────────────────
                    const tileKey = makeBigWigTileKey(track.id, selectedChrom, level.id, tileStart)
                    if (trackTileFetchSetRef.current.has(tileKey)) continue
                    trackTileFetchSetRef.current.add(tileKey)

                    const isL0Prefetch = level.id === 'L0'
                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, tileStart)),
                        end: String(tileEnd),
                        bins: String(level.binsPerTile),
                    })

                    fetch(`${API_BASE}/api/browse/bigwig?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(payload => {
                            // Always cache — tiles are keyed by genomic coords, always valid
                            trackTileCacheRef.current.set(tileKey, {
                                start: payload?.start ?? tileStart,
                                end: payload?.end ?? tileEnd,
                                bpPerBin: level.bpPerBin,
                                bins: Array.isArray(payload?.bins) ? payload.bins : [],
                                has_data: !!payload?.has_data,
                                error: '',
                            })
                            if (fetchEpochRef.current !== epoch) return
                            // Use L0 result to set stable chrom-wide scale
                            if (isL0Prefetch && payload?.has_data) {
                                const scaleKey = `${track.id}|${selectedChrom}`
                                const validBins = (payload.bins || []).filter(v => typeof v === 'number' && Number.isFinite(v))
                                if (validBins.length > 0) {
                                    const existing = trackChromScaleRef.current[scaleKey]
                                    const newMax = Math.max(...validBins)
                                    trackChromScaleRef.current[scaleKey] = {
                                        min: 0,
                                        max: existing ? Math.max(existing.max, newMax) : newMax,
                                    }
                                }
                            }
                            // Re-project using the latest viewport refs so a late tile
                            // response from an older zoom/pan state cannot overwrite the
                            // current view with stale block geometry.
                            const projected = projectBigWigTrackToCurrentViewport(track.id)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: projected }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: projected.coverage < 0.3 }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            if (isTransientFetchError(e)) {
                                // Leave current cache/view intact and retry on the next viewport update.
                                trackTileCacheRef.current.delete(tileKey)
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            const errorMessage = getFetchErrorMessage(e)
                            trackTileCacheRef.current.set(tileKey, { start: tileStart, end: tileEnd, bpPerBin: level.bpPerBin, bins: [], has_data: false, error: errorMessage })
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...prev[track.id], error: errorMessage } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackTileFetchSetRef.current.delete(tileKey) })
                }
            }
        }, 50) // 50ms debounce — only delays network requests, not rendering

        return () => {
            // Only cancel the debounce timer — do NOT cancel in-flight responses!
            clearTimeout(timer)
        }
    }
