// Projecting cached custom-track tiles onto the current view of a Genome Browser
// panel (VCF summary/blocks/spans, splice junctions, BED density, bigBed blocks and
// features). Each is called by the panel's projection callback with its caches.
import { BIGBED_BLOCK_MERGE_GAP_PX, BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD, BIGBED_FEATURE_TILE_SPAN } from './browserConstants.js'
import { bigBedFeatureKey, clamp, normalizeBigBedFeatureForRender } from './trackData.js'
import { smoothVcfDensityBins, smoothVcfDensityClasses } from './trackData.js'
import { SPLICE_HEIGHT_BASE, SPLICE_HEIGHT_MAX, SPLICE_HEIGHT_MIN, SPLICE_HEIGHT_STEP } from './browserConstants.js'
import { spliceJunctionKey } from './spliceGeometry.js'
import { BED_DENSITY_LEVELS } from './browserConstants.js'
import { BED_TO_BROWSER_OFFSET } from './trackData.js'

export function projectBigBedFeatureTiles(ctx, trackId, chrom, visStart, visEnd, innerWidthPx, options = {}) {
    const {
        bigBedLayoutStateRef,
        makeBigBedFeatureTileKey,
        trackFeatureCacheRef,
    } = ctx
        const labelled = Boolean(options?.labelled)
        const tileSpan = BIGBED_FEATURE_TILE_SPAN
        const viewSpan = Math.max(1, visEnd - visStart)
        const layoutBuffer = clamp(viewSpan * 0.5, 80_000, 500_000)
        const bucketStep = Math.max(25_000, Math.floor(viewSpan * 0.25))
        const center = (visStart + visEnd) / 2
        const centerBucket = Math.floor(center / bucketStep)
        const spanBucket = Math.max(1, Math.round(Math.log2(Math.max(1, viewSpan)) * 8))
        const priorLayout = bigBedLayoutStateRef.current[trackId]
        let layoutStart
        let layoutEnd
        if (
            priorLayout
            && priorLayout.chrom === chrom
            && priorLayout.centerBucket === centerBucket
            && priorLayout.spanBucket === spanBucket
        ) {
            layoutStart = Number(priorLayout.layoutStart)
            layoutEnd = Number(priorLayout.layoutEnd)
        } else {
            const bucketCenter = centerBucket * bucketStep + (bucketStep / 2)
            const half = (viewSpan / 2) + layoutBuffer
            layoutStart = Math.max(0, Math.floor(bucketCenter - half))
            layoutEnd = Math.max(layoutStart + 1, Math.ceil(bucketCenter + half))
            bigBedLayoutStateRef.current[trackId] = {
                chrom,
                centerBucket,
                spanBucket,
                layoutStart,
                layoutEnd,
            }
        }

        const firstTile = Math.floor(layoutStart / tileSpan) * tileSpan
        const lastTile = Math.floor((layoutEnd - 1) / tileSpan) * tileSpan
        const dedup = new Map()
        let expectedTiles = 0
        let fetchedTiles = 0
        let bestError = ''
        const coverageSpans = []

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeBigBedFeatureTileKey(trackId, chrom, tileStart, tileEnd)
            const tile = trackFeatureCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1
            if (tile?.error && !bestError) bestError = String(tile.error)
            const tStart = Number(tile?.start)
            const tEnd = Number(tile?.end)
            if (Number.isFinite(tStart) && Number.isFinite(tEnd) && tEnd > tStart) {
                coverageSpans.push([Math.max(visStart, tStart), Math.min(visEnd, tEnd)])
            }
            const rows = Array.isArray(tile?.features) ? tile.features : []
            for (const row of rows) {
                const normalizedRow = row?._render_kind ? row : normalizeBigBedFeatureForRender(row)
                if (!normalizedRow) continue
                const s = Number(normalizedRow?.start)
                const e = Number(normalizedRow?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= layoutStart || s >= layoutEnd) continue
                const keyId = bigBedFeatureKey(normalizedRow)
                if (dedup.has(keyId)) continue
                dedup.set(keyId, {
                    ...normalizedRow,
                    start: s,
                    end: e,
                    _key: keyId,
                })
            }
        }

        const features = Array.from(dedup.values()).sort((a, b) => {
            if (a.start !== b.start) return a.start - b.start
            if (a.end !== b.end) return a.end - b.end
            const aName = String(a?.name || '')
            const bName = String(b?.name || '')
            if (aName !== bName) return aName.localeCompare(bName)
            return String(a?._key || '').localeCompare(String(b?._key || ''))
        })
        const visibleSource = features.filter((feature) => feature.end > visStart && feature.start < visEnd)
        const transcriptFeatureCount = features.reduce((acc, feature) => {
            const isTranscript = feature?._render_kind === 'transcript'
                && feature?._structure_valid === true
                && Array.isArray(feature?._exon_blocks)
                && feature._exon_blocks.length > 0
            return acc + (isTranscript ? 1 : 0)
        }, 0)
        const shouldDenseFallback = (
            visibleSource.length > BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD
            && transcriptFeatureCount === 0
            && viewSpan > 100_000
        )
        if (shouldDenseFallback) {
            const denseSpans = visibleSource.map((feature) => ({
                start: Math.max(visStart, Number(feature?.start) || 0),
                end: Math.min(visEnd, Number(feature?.end) || 0),
                feature_count: 1,
                max_score: Math.max(0, Number(feature?.score || 0)),
                color_hint: String(feature?.itemRgb || feature?.color || ''),
            })).filter((span) => span.end > span.start)
            denseSpans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
            const merged = []
            const gapBp = BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx || 1))
            for (const span of denseSpans) {
                const last = merged[merged.length - 1]
                if (last && span.start <= (last.end + gapBp)) {
                    last.end = Math.max(last.end, span.end)
                    last.feature_count += 1
                    if (span.max_score >= last.max_score) {
                        last.max_score = span.max_score
                        if (span.color_hint) last.color_hint = span.color_hint
                    }
                } else {
                    merged.push({ ...span })
                }
            }
            let coveredBp = 0
            for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
            const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
            return {
                mode: 'bigbed_blocks',
                level: 'dense_fallback',
                start: visStart,
                end: visEnd,
                block_spans: merged,
                has_data: merged.length > 0,
                coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
                tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
                error: bestError,
                dense_fallback: true,
            }
        }

        const laneEnds = []
        const visibleFeatures = []
        // A labelled lane also holds each name, which can run past a short feature.
        const labelBpPerPx = viewSpan / Math.max(1, innerWidthPx || 1)
        for (const feature of features) {
            const reservedEnd = labelled
                ? Math.max(feature.end, feature.start + (String(feature?.name || '').length * 5.4 + 8) * labelBpPerPx)
                : feature.end
            let lane = 0
            while (lane < laneEnds.length && feature.start <= laneEnds[lane]) lane += 1
            if (lane >= laneEnds.length) laneEnds.push(reservedEnd)
            else laneEnds[lane] = reservedEnd
            feature._lane = lane
            if (feature.end > visStart && feature.start < visEnd) visibleFeatures.push(feature)
        }

        coverageSpans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
        let coveredBp = 0
        if (coverageSpans.length > 0) {
            let [curS, curE] = coverageSpans[0]
            for (let i = 1; i < coverageSpans.length; i++) {
                const [s, e] = coverageSpans[i]
                if (s <= curE) curE = Math.max(curE, e)
                else {
                    coveredBp += Math.max(0, curE - curS)
                    curS = s
                    curE = e
                }
            }
            coveredBp += Math.max(0, curE - curS)
        }
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'bigbed_detail',
            start: visStart,
            end: visEnd,
            labelled,
            features: visibleFeatures,
            has_data: visibleFeatures.length > 0,
            lane_count: Math.max(1, laneEnds.length),
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            error: bestError,
        }
    }

export function projectVcfBlockTiles(ctx, trackId, chrom, level, visStart, visEnd, outBins = 800) {
    const {
        makeVcfBlockTileKey,
        vcfBlockTileCacheRef,
    } = ctx
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        const densityValues = Array(Math.max(1, outBins)).fill(0)
        const densityValueSums = Array(Math.max(1, outBins)).fill(0)
        const densityValueWeights = Array(Math.max(1, outBins)).fill(0)
        const densityGenicVotes = Array(Math.max(1, outBins)).fill(0.0)
        const densityIntergenicVotes = Array(Math.max(1, outBins)).fill(0.0)
        const densityPopulated = new Uint8Array(Math.max(1, outBins))
        let expectedTiles = 0
        let fetchedTiles = 0
        let coveredBp = 0

        const viewSpan = Math.max(1, visEnd - visStart)
        const densityBinBp = viewSpan / Math.max(1, densityValues.length)

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeVcfBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
            const tile = vcfBlockTileCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1

            const tileBlockSpans = Array.isArray(tile?.block_spans) ? tile.block_spans : []
            for (const spanItem of tileBlockSpans) {
                const s = Number(spanItem?.start)
                const e = Number(spanItem?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= visStart || s >= visEnd) continue
                const cs = Math.max(visStart, s)
                const ce = Math.min(visEnd, e)
                if (ce <= cs) continue
                coveredBp += (ce - cs)
                spans.push({ start: cs, end: ce, class_name: spanItem?.class_name || 'intergenic' })
            }

            const tileDensity = Array.isArray(tile?.density_bins) ? tile.density_bins : []
            const tileClasses = Array.isArray(tile?.density_classes) ? tile.density_classes : []
            const densityCount = Math.min(tileDensity.length, tileClasses.length)
            if (densityCount <= 0) continue
            const strideBp = Math.max(1, Number(tile?.density_stride_bp || level?.blockBp || 100))
            const tileBaseStart = Number.isFinite(Number(tile?.start)) ? Number(tile.start) : tileStart
            const tileBaseEnd = Number.isFinite(Number(tile?.end)) ? Number(tile.end) : tileEnd

            for (let i = 0; i < densityCount; i++) {
                const rawVal = Number(tileDensity[i])
                if (!Number.isFinite(rawVal)) continue
                const cls = tileClasses[i] === 'genic' ? 'genic' : 'intergenic'
                const segmentStart = tileBaseStart + i * strideBp
                const segmentEnd = Math.min(tileBaseEnd, segmentStart + strideBp)
                if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) continue
                if (segmentEnd <= visStart || segmentStart >= visEnd) continue

                const cs = Math.max(visStart, segmentStart)
                const ce = Math.min(visEnd, segmentEnd)
                if (ce <= cs) continue

                let x1 = Math.floor(((cs - visStart) / viewSpan) * densityValues.length)
                let x2 = Math.ceil(((ce - visStart) / viewSpan) * densityValues.length)
                x1 = Math.max(0, Math.min(densityValues.length - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(densityValues.length, x2))

                const normalized = Math.max(0, rawVal)
                for (let x = x1; x < x2; x++) {
                    const binStart = visStart + x * densityBinBp
                    const binEnd = binStart + densityBinBp
                    const ovBp = Math.max(0, Math.min(ce, binEnd) - Math.max(cs, binStart))
                    if (ovBp <= 0) continue
                    densityPopulated[x] = 1
                    densityValueSums[x] += normalized * ovBp
                    densityValueWeights[x] += ovBp
                    if (cls === 'genic') densityGenicVotes[x] += ovBp
                    else densityIntergenicVotes[x] += ovBp
                }
            }
        }

        for (let i = 0; i < densityValues.length; i++) {
            const w = Number(densityValueWeights[i] || 0)
            densityValues[i] = w > 0 ? (Number(densityValueSums[i] || 0) / w) : 0
        }
        const smoothingRadius = level?.id === 'L1' ? 2 : level?.id === 'L2' ? 1 : 0
        const smoothedDensityValues = smoothingRadius > 0
            ? smoothVcfDensityBins(densityValues, densityPopulated, smoothingRadius)
            : densityValues

        // Merge adjacent spans of the same class
        spans.sort((a, b) => a.start - b.start)
        const merged = []
        for (const s of spans) {
            const last = merged[merged.length - 1]
            if (last && s.start <= last.end && s.class_name === last.class_name) {
                last.end = Math.max(last.end, s.end)
            } else {
                merged.push({ ...s })
            }
        }

        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        const rawDensityClasses = smoothedDensityValues.map((_, i) =>
            densityGenicVotes[i] >= densityIntergenicVotes[i] ? 'genic' : 'intergenic'
        )
        const classSmoothingRadius = level?.id === 'L1' ? 2 : level?.id === 'L2' ? 1 : 0
        const densityClasses = classSmoothingRadius > 0
            ? smoothVcfDensityClasses(rawDensityClasses, densityPopulated, classSmoothingRadius)
            : rawDensityClasses
        const densityPopulatedCount = densityPopulated.reduce((acc, v) => acc + (v ? 1 : 0), 0)
        const densityCoverage = densityPopulatedCount / Math.max(1, smoothedDensityValues.length)
        const hasDensity = smoothedDensityValues.some((v) => Number(v) > 0)

        return {
            mode: 'block',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            density_bins: smoothedDensityValues,
            density_classes: densityClasses,
            density_populated: densityPopulated,
            density_stride_bp: Number(level?.blockBp || 100),
            has_data: merged.length > 0 || hasDensity,
            coverage: Math.max(0, Math.min(1, Math.max(coveredBp / viewSpan, densityCoverage))),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
        }
    }

export function projectSpliceTiles(ctx, trackId, chrom, visStart, visEnd) {
    const {
        trackFeatureCacheRef,
    } = ctx
        const prefix = `sj:${trackId}|${chrom}|`
        const dedup = new Map() // `${start}|${end}|${strand}` -> junction
        const coverageSpans = []
        let bestError = ''

        for (const [key, tile] of trackFeatureCacheRef.current.entries()) {
            if (!key.startsWith(prefix)) continue
            const tStart = Number(tile?.start)
            const tEnd = Number(tile?.end)
            if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) continue
            if (tEnd <= visStart || tStart >= visEnd) continue
            coverageSpans.push([Math.max(visStart, tStart), Math.min(visEnd, tEnd)])
            if (tile?.error && !bestError) bestError = String(tile.error)

            const rows = Array.isArray(tile?.junctions) ? tile.junctions : []
            for (const raw of rows) {
                const s = Number(raw?.start)
                const e = Number(raw?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e < visStart || s > visEnd) continue
                const strand = String(raw?.strand || '.')
                const keyId = `${s}|${e}|${strand}`
                const count = Number(raw?.n_total ?? raw?.reads ?? 0)
                const normalized = Number.isFinite(count) ? count : 0
                const prev = dedup.get(keyId)
                if (!prev || normalized > Number(prev?.n_total ?? prev?.reads ?? 0)) {
                    dedup.set(keyId, {
                        ...raw,
                        start: s,
                        end: e,
                        strand,
                        n_total: normalized,
                        reads: normalized,
                        canonical: raw?.canonical === true,
                        key: keyId,
                    })
                }
            }
        }

        coverageSpans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
        let coveredBp = 0
        if (coverageSpans.length > 0) {
            let [curS, curE] = coverageSpans[0]
            for (let i = 1; i < coverageSpans.length; i++) {
                const [s, e] = coverageSpans[i]
                if (s <= curE) curE = Math.max(curE, e)
                else {
                    coveredBp += Math.max(0, curE - curS)
                    curS = s
                    curE = e
                }
            }
            coveredBp += Math.max(0, curE - curS)
        }
        const viewSpan = Math.max(1, visEnd - visStart)
        const coverage = Math.max(0, Math.min(1, coveredBp / viewSpan))
        const sortedByCoord = Array.from(dedup.values()).sort((a, b) => {
            const as = Number(a?.start) || 0
            const bs = Number(b?.start) || 0
            if (as !== bs) return as - bs
            const ae = Number(a?.end) || 0
            const be = Number(b?.end) || 0
            if (ae !== be) return ae - be
            const ac = Number(a?.n_total ?? a?.reads ?? 0)
            const bc = Number(b?.n_total ?? b?.reads ?? 0)
            if (ac !== bc) return bc - ac
            return String(a?.strand || '.').localeCompare(String(b?.strand || '.'))
        })
        const laneEnds = []
        const laneByKey = new Map()
        for (const j of sortedByCoord) {
            const s = Number(j?.start) || 0
            const e = Number(j?.end) || 0
            let lane = 0
            while (lane < laneEnds.length && s <= laneEnds[lane]) lane += 1
            if (lane >= laneEnds.length) laneEnds.push(e)
            else laneEnds[lane] = e
            laneByKey.set(j.key || spliceJunctionKey(j), lane)
        }
        const laneCount = Math.max(1, laneEnds.length)
        const recommendedHeight = clamp(
            SPLICE_HEIGHT_BASE + laneCount * SPLICE_HEIGHT_STEP,
            SPLICE_HEIGHT_MIN,
            SPLICE_HEIGHT_MAX
        )
        const maxVisibleLanes = Math.max(1, Math.floor((recommendedHeight - SPLICE_HEIGHT_BASE) / SPLICE_HEIGHT_STEP))
        const junctions = sortedByCoord.map((j) => {
            const key = j.key || spliceJunctionKey(j)
            return { ...j, key, lane: laneByKey.get(key) || 0 }
        })
        const overflowCount = junctions.reduce((acc, j) => acc + (Number(j?.lane || 0) >= maxVisibleLanes ? 1 : 0), 0)

        return {
            mode: 'splice_arcs',
            start: visStart,
            end: visEnd,
            junctions,
            has_data: junctions.length > 0,
            coverage,
            error: bestError,
            layout: {
                lane_count: laneCount,
                max_visible_lanes: maxVisibleLanes,
                overflow_count: overflowCount,
                recommended_height: recommendedHeight,
            },
        }
    }

export function projectVcfSummary(ctx, trackId, chrom, level, visStart, visEnd, outBins) {
    const {
        makeVcfTileKey,
        vcfTileCacheRef,
    } = ctx
        const outCounts = Array(outBins).fill(0)
        const outOccupancy = Array(outBins).fill(0)
        const outDominant = Array(outBins).fill('other')
        const outTypeCounts = Array.from({ length: outBins }, () => ({ snv: 0, ins: 0, del: 0, other: 0 }))
        const populated = new Uint8Array(outBins)

        const visSpan = Math.max(1, visEnd - visStart)
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
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
            if (!tile || tile.mode !== 'summary' || !Array.isArray(tile.bins) || tile.bins.length === 0) continue
            anyTile = true
            truncated = truncated || !!tile.truncated
            const sourceBins = tile.bins.length
            const sourceBpPerBin = Math.max(1, (tile.end - tile.start) / Math.max(1, sourceBins))

            for (let i = 0; i < sourceBins; i++) {
                const count = Number(tile.bins[i]) || 0
                const occupied = Number(tile.occupancy?.[i] || 0) > 0 || count > 0
                const srcStart = tile.start + i * sourceBpPerBin
                const srcEnd = srcStart + sourceBpPerBin
                if (srcEnd < visStart || srcStart > visEnd) continue

                let x1 = Math.floor(((srcStart - visStart) / visSpan) * outBins)
                let x2 = Math.ceil(((srcEnd - visStart) / visSpan) * outBins)
                x1 = Math.max(0, Math.min(outBins - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(outBins, x2))

                for (let x = x1; x < x2; x++) {
                    populated[x] = 1
                    if (count >= outCounts[x]) {
                        outCounts[x] = count
                        outDominant[x] = tile.dominant_effect_bins?.[i] || 'other'
                    }
                    if (occupied) outOccupancy[x] = 1

                    const t = tile.type_counts_bins?.[i]
                    if (t) {
                        outTypeCounts[x].snv = Math.max(outTypeCounts[x].snv, Number(t.snv) || 0)
                        outTypeCounts[x].ins = Math.max(outTypeCounts[x].ins, Number(t.ins) || 0)
                        outTypeCounts[x].del = Math.max(outTypeCounts[x].del, Number(t.del) || 0)
                        outTypeCounts[x].other = Math.max(outTypeCounts[x].other, Number(t.other) || 0)
                    }
                }
            }
        }

        let popCount = 0
        for (let i = 0; i < outBins; i++) {
            if (populated[i]) popCount++
        }
        const maxCount = outCounts.length ? Math.max(...outCounts) : 0
        return {
            mode: 'summary',
            level: level.id,
            bins: outCounts,
            occupancy: outOccupancy,
            dominant_effect_bins: outDominant,
            type_counts_bins: outTypeCounts,
            max_count: maxCount,
            has_data: anyTile && maxCount > 0,
            coverage: popCount / Math.max(1, outBins),
            truncated,
        }
    }

export function projectVcfBlockSpans(ctx, trackId, chrom, level, visStart, visEnd) {
    const {
        makeVcfTileKey,
        vcfTileCacheRef,
    } = ctx
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        let coveredBp = 0
        let truncated = false
        let expectedTiles = 0
        let fetchedTiles = 0

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
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
            if (!tile || tile.mode !== 'summary') continue
            fetchedTiles += 1
            truncated = truncated || !!tile.truncated
            if (!Array.isArray(tile.block_spans)) continue
            for (const spanItem of tile.block_spans) {
                const s = Number(spanItem?.start)
                const e = Number(spanItem?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= visStart || s >= visEnd) continue
                const cs = Math.max(visStart, s)
                const ce = Math.min(visEnd, e)
                if (ce <= cs) continue
                coveredBp += (ce - cs)
                spans.push({
                    start: cs,
                    end: ce,
                    class_name: spanItem?.class_name === 'transcript' ? 'transcript' : 'intergenic',
                    coverage_fraction: Number(spanItem?.coverage_fraction) || 0,
                })
            }
        }

        spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const merged = []
        for (const s of spans) {
            const last = merged[merged.length - 1]
            if (!last) {
                merged.push({ ...s })
                continue
            }
            if (s.start <= last.end && s.class_name === last.class_name) {
                const prevLen = Math.max(1, last.end - last.start)
                const curLen = Math.max(1, s.end - s.start)
                last.end = Math.max(last.end, s.end)
                last.coverage_fraction = ((last.coverage_fraction * prevLen) + (s.coverage_fraction * curLen)) / (prevLen + curLen)
            } else {
                merged.push({ ...s })
            }
        }
        const viewSpan = Math.max(1, visEnd - visStart)
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'summary',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            has_data: merged.length > 0,
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            truncated,
            detail: merged.length === 0 ? 'Loading block spans…' : '',
            block_window_bp: level.blockWindowBp || 0,
            block_stride_bp: level.blockStrideBp || 0,
            block_coverage_threshold: level.blockCoverageThreshold ?? 0.5,
        }
    }

export function projectBedDensityTiles(ctx, trackId, chrom, level, visStart, visEnd) {
    const {
        bedDensityScaleRef,
        makeBedDensityTileKey,
        trackFeatureCacheRef,
    } = ctx
        const levelIdx = Math.max(0, BED_DENSITY_LEVELS.findIndex((l) => l.id === level.id))
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(Math.max(0, visStart - BED_TO_BROWSER_OFFSET) / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const bins = []
        let expectedTiles = 0
        let fetchedTiles = 0
        let bestError = ''

        const pushTileBins = (tile, from, to, scale) => {
            const counts = Array.isArray(tile?.counts) ? tile.counts : []
            const blockBp = Math.max(1, Number(tile?.block_bp) || 1)
            const tStart = Number(tile?.start) || 0
            const i0 = Math.max(0, Math.floor((from - BED_TO_BROWSER_OFFSET - tStart) / blockBp))
            const i1 = Math.min(counts.length - 1, Math.floor((to - 1 - BED_TO_BROWSER_OFFSET - tStart) / blockBp))
            for (let i = i0; i <= i1; i += 1) {
                const count = Number(counts[i]) || 0
                if (count <= 0) continue
                const s = tStart + i * blockBp + BED_TO_BROWSER_OFFSET
                bins.push({ start: s, end: s + blockBp, count: count * scale })
            }
        }

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const from = Math.max(visStart, tileStart + BED_TO_BROWSER_OFFSET)
            const to = Math.min(visEnd, tileEnd + BED_TO_BROWSER_OFFSET)
            const tile = trackFeatureCacheRef.current.get(makeBedDensityTileKey(trackId, chrom, level.id, tileStart, tileEnd))
            if (tile) {
                fetchedTiles += 1
                if (tile?.error && !bestError) bestError = String(tile.error)
                pushTileBins(tile, from, to, 1)
                continue
            }
            for (let i = levelIdx - 1; i >= 0; i -= 1) {
                const coarse = BED_DENSITY_LEVELS[i]
                const cStart = Math.floor(tileStart / coarse.tileSpanBp) * coarse.tileSpanBp
                const coarseTile = trackFeatureCacheRef.current.get(
                    makeBedDensityTileKey(trackId, chrom, coarse.id, cStart, cStart + coarse.tileSpanBp),
                )
                if (!coarseTile) continue
                pushTileBins(coarseTile, from, to, level.blockBp / Math.max(1, coarse.blockBp))
                break
            }
        }

        // The scale is the 98th percentile of every non-zero bin fetched at this level on
        // this chromosome, not the single busiest bin: one hotspot used to flatten the rest
        // of the histogram to a few pixels. Taken over everything fetched rather than just
        // this view, so panning does not rescale the bars under the reader.
        let viewMax = 0
        for (const bin of bins) if (bin.count > viewMax) viewMax = bin.count
        const scaleEntry = bedDensityScaleRef.current[`${trackId}|${chrom}|${level.id}`]
        let stableScale = 0
        if (scaleEntry && scaleEntry.values.length > 0) {
            if (scaleEntry.n !== scaleEntry.values.length) {
                const sorted = Float64Array.from(scaleEntry.values).sort()
                scaleEntry.scale = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]
                scaleEntry.n = scaleEntry.values.length
            }
            stableScale = scaleEntry.scale
        }
        return {
            mode: 'bed_density',
            level: level.id,
            start: visStart,
            end: visEnd,
            // Not `bins`: the generic discrete-track branch draws any numeric `bins` array.
            density_bins: bins,
            max_count: stableScale > 0 ? stableScale : Math.max(1, viewMax),
            has_data: bins.length > 0,
            tile_coverage: expectedTiles > 0 ? fetchedTiles / expectedTiles : 0,
            error: bestError,
        }
    }

export function projectBigBedBlockTiles(ctx, trackId, chrom, level, visStart, visEnd, innerWidthPx) {
    const {
        makeBigBedBlockTileKey,
        trackFeatureCacheRef,
    } = ctx
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(Math.max(0, visStart - BED_TO_BROWSER_OFFSET) / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        let expectedTiles = 0
        let fetchedTiles = 0
        let bestError = ''

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeBigBedBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
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
                    feature_count: Math.max(0, Number(row?.feature_count || 0)),
                    max_score: Math.max(0, Number(row?.max_score || 0)),
                    color_hint: String(row?.color_hint || ''),
                })
            }
        }

        spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const merged = []
        const viewSpan = Math.max(1, visEnd - visStart)
        const gapBp = BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx))
        for (const span of spans) {
            const last = merged[merged.length - 1]
            if (last && span.start <= (last.end + gapBp)) {
                last.end = Math.max(last.end, span.end)
                last.feature_count = Math.max(last.feature_count, span.feature_count)
                if (span.max_score >= last.max_score) {
                    last.max_score = span.max_score
                    if (span.color_hint) last.color_hint = span.color_hint
                }
            } else {
                merged.push({ ...span })
            }
        }

        let coveredBp = 0
        for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'bigbed_blocks',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            has_data: merged.length > 0,
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            error: bestError,
        }
    }
