// Hit-testing in a Genome Browser panel: which custom-track feature, or which
// transcript of the selected gene, lies under a point.
import { getVcfAltAlleleCount, getVcfDetailVariantLayout, localVcfType } from '../../utils/vcfDetailGeometry.js'
import {
    BIGBED_DETAIL_EXON_HEIGHT,
    BIGBED_DETAIL_LANE_TOP_PAD,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    LHS_WIDTH,
    bigBedLanePitch,
    isIntervalTrackType,
} from './browserConstants.js'
import {
    annotateSpliceSimilarityLift,
    computeSplicePeakY,
    cubicPointAt,
    getSpliceBezierControls,
    spliceJunctionKey,
} from './spliceGeometry.js'
import { bigBedFeatureKey, clamp } from './trackData.js'
import {
    getBigBedLaneCapacity,
    isVcfAdaptiveLikeMode,
    normalizeBigWigDisplayMode,
    normalizeBigWigSettings,
    normalizeVcfDisplayMode,
} from './trackSettings.js'
import { getFeatureRowAnchor } from './genomeBrowserViewportLayout.js'

export function findCustomTrackHover(ctx, mouseX, mouseY, clientX, clientY) {
    const {
        bpPerPx,
        customTrackData,
        customTracksById,
        formatSignalValueExact,
        getCustomTrackGeometry,
        getSpliceLodMode,
        layout,
        spliceArcLiftOffsets,
        viewEnd,
        viewStart,
        viewWidth,
    } = ctx
        const left = LHS_WIDTH + 2
        const right = viewWidth - 2
        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts)) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue
            const data = customTrackData[trackId]
            const trackType = track.type || 'bigwig'
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const { top, bottom, plotHeight } = getCustomTrackGeometry(trackLayout, renderMode, trackType, data)
            // For adp_detail tracks expand Y so indel markers that extend beyond the track bar are reachable
            const yExpand = (data?.mode === 'adp_detail' && bpPerPx <= 1) ? 80 : 0
            if (mouseX < left || mouseX > right || mouseY < top - yExpand || mouseY > bottom + yExpand) continue

            // ── Adaptive-like VCF (density/block) — hover highlight only, no tooltip ─────────────
            if (track.type === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                const plotHeight = bottom - top
                const curSpan = Math.max(1, viewEnd - viewStart)
                const genomicPos = viewStart + ((mouseX - left) / Math.max(1, right - left)) * curSpan
                const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, curSpan)) * (right - left)
                if (data?.mode === 'adp_detail') {
                    const barH = Math.max(5, Math.floor(plotHeight * 0.13))
                    const barY = top + Math.floor((plotHeight - barH) / 2)
                    const variants = Array.isArray(data?.variants) ? data.variants : []

                    // ── Check 1: bar hit (tight Y band) ──────────────────────────────
                    if (mouseY >= barY - 8 && mouseY <= barY + barH + 8) {
                        // Prefer narrowest match so SNVs win over large spanning deletions
                        let bestMatch = null
                        let bestSpan = Infinity
	                        for (const v of variants) {
	                            const lvtype = localVcfType(v)
	                            const layoutInfo = getVcfDetailVariantLayout(v, lvtype)
	                            const refStart = lvtype === 'del'
	                                ? layoutInfo.anchorStart
	                                : layoutInfo.refStart
	                            const refEnd = lvtype === 'del'
	                                ? Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
	                                : layoutInfo.refEnd
	                            if (genomicPos < refStart - 0.5 || genomicPos > refEnd + 0.5) continue
	                            // Pixel proximity — cursor must be near the rendered block
	                            const vx1 = blockGToX(refStart)
                            const vx2 = blockGToX(refEnd)
                            const pxMargin = Math.max(4, Math.min(10, 6 / Math.max(0.01, bpPerPx)))
                            if (mouseX < vx1 - pxMargin || mouseX > vx2 + pxMargin) continue
                            const span = refEnd - refStart
                            if (span < bestSpan) { bestSpan = span; bestMatch = v }
                        }
                        if (bestMatch) {
                            return { hoverBlock: { trackId, start: Number(bestMatch.pos), end: Number(bestMatch.end ?? bestMatch.pos), variant: bestMatch } }
                        }
                    }

                    // ── Check 2: indel dot / label hit ───────────────────────────────
                    if (bpPerPx <= 1) {
                        const lineBaseLen = bpPerPx <= 0.5 ? 29 : 22
                        const indelHits = []
                        const seenHit = new Set()
	                        for (const v of variants) {
	                            const vtype = localVcfType(v)
	                            if (vtype === 'snv') continue
	                            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                            const vpos = layoutInfo.vpos
	                            if (!Number.isFinite(vpos)) continue
	                            const key = `${vtype}:${vpos}`
	                            if (seenHit.has(key)) continue
	                            seenHit.add(key)
	                            const vend = Number(v?.end ?? v?.pos)
	                            const xGenomic = layoutInfo.markerXGenomic
	                            const x = blockGToX(Math.max(viewStart, xGenomic))
	                            const nBars = getVcfAltAlleleCount(v)
                            const primaryDir = vtype === 'ins' ? 'up' : 'down'
                            const altDir = primaryDir === 'up' ? 'down' : 'up'
                            let dir = primaryDir
                            let level = 0
                            if (bpPerPx <= 0.5) {
                                const MAX_LEVEL = 3
                                let lP = 0, lA = 0
                                for (const existing of indelHits) {
                                    const leftNBars = existing.x <= x ? existing.nBars : nBars
                                    const inProximity = Math.abs(existing.x - x) < Math.max(50, 7 + leftNBars * 14 + 5)
                                    if (inProximity) {
                                        if (existing.dir === primaryDir) lP = Math.max(lP, existing.level + 1)
                                        if (existing.dir === altDir)    lA = Math.max(lA, existing.level + 1)
                                    }
                                }
                                lP = Math.min(lP, MAX_LEVEL)
                                lA = Math.min(lA, MAX_LEVEL)
                                if (lA < lP) { dir = altDir; level = lA }
                                else          { dir = primaryDir; level = lP }
                            }
                            indelHits.push({ v, vpos, vend, x, dir, level, nBars })
                        }
                        for (const { v, vpos, vend, x, dir, level } of indelHits) {
                            const lineLen = lineBaseLen + level * 18
                            const dotY = dir === 'up' ? barY - lineLen : barY + barH + lineLen
                            const hitR = 10
                            if (mouseX >= x - hitR && mouseX <= x + hitR && mouseY >= dotY - hitR && mouseY <= dotY + hitR) {
                                return { hoverBlock: { trackId, start: vpos, end: vend, variant: v } }
                            }
                        }
                    }

                    return null
                }
                // Block mode (L0–L3) — gate on actual bar Y bounds
                const barH = Math.max(2, Math.floor(plotHeight * 0.12))
                const barY = top + Math.max(2, Math.floor((plotHeight - barH) * 0.2))
                if (mouseY < barY - 6 || mouseY > barY + barH + 6) return null
                const spans = Array.isArray(data?.block_spans) ? data.block_spans : []
                for (const span of spans) {
                    if (genomicPos >= span.start && genomicPos < span.end) {
                        return { hoverBlock: { trackId, start: span.start, end: span.end } }
                    }
                }
                return null
            }

            if (track.type === 'splice_junctions' && Array.isArray(data?.junctions)) {
                const curSpan = Math.max(1, viewEnd - viewStart)
                const genomicPos = viewStart + ((mouseX - left) / Math.max(1, right - left)) * curSpan
                const lodMode = getSpliceLodMode(trackId, bpPerPx, renderMode)
                if (lodMode === 'blocks') {
                    return null
                }

                const baselineY = bottom - 4
                const minTopY = top + 1
                const lanePitch = lodMode === 'detail' ? 10 : 8
                const capByHeight = Math.max(1, Math.floor((baselineY - minTopY) / lanePitch))
                const maxVisibleLanes = Math.max(1, Math.min(capByHeight, Number(data?.layout?.max_visible_lanes || capByHeight)))
                const spliceCandidates = []
                for (const j of data.junctions) {
                    const s = Number(j?.start)
                    const e = Number(j?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (genomicPos < s || genomicPos > e) continue
                    const lane = Math.max(0, Number(j?.lane || 0))
                    if (lane >= maxVisibleLanes) continue
                    const x1 = left + ((s - viewStart) / Math.max(1, curSpan)) * (right - left)
                    const x2 = left + ((e - viewStart) / Math.max(1, curSpan)) * (right - left)
                    const widthPx = Math.abs(x2 - x1)
                    if (widthPx < 1) continue
                    const key = spliceJunctionKey(j)
                    const mapKey = `${trackId}|${key}`
                    spliceCandidates.push({
                        ...j,
                        key,
                        x1,
                        x2,
                        widthPx,
                        manual_lift: Number(spliceArcLiftOffsets[mapKey] || 0),
                    })
                }
                const laidOut = annotateSpliceSimilarityLift(spliceCandidates, lodMode)
                let best = null
                let bestDist = Infinity
                for (const j of laidOut) {
                    const lane = Math.max(0, Number(j?.lane || 0))
                    const extraLift = Number(j?.manual_lift || 0) + Number(j?.similarity_lift || 0)
                    const peakY = computeSplicePeakY({
                        baselineY,
                        minTopY,
                        lane,
                        lanePitch,
                        widthPx: j.widthPx,
                        lodMode,
                        extraLift,
                    })
                    const controls = getSpliceBezierControls(j.x1, j.x2, peakY)
                    const t = clamp((mouseX - j.x1) / Math.max(1e-6, j.x2 - j.x1), 0, 1)
                    const yOnCurve = cubicPointAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                    const dist = Math.abs(mouseY - yOnCurve)
                    const threshold = 6 + Math.min(8, Math.log2(1 + (Number(j?.n_total ?? j?.reads ?? 0) || 0)))
                    if (dist <= threshold && dist < bestDist) {
                        bestDist = dist
                        best = {
                            ...j,
                            _hover_x: j.x1 + (j.x2 - j.x1) * 0.5,
                            _hover_y: yOnCurve,
                        }
                    }
                }
                if (best) {
                    return {
                        hoverSplice: {
                            trackId,
                            junction: best,
                            anchorCanvasX: best._hover_x,
                            anchorCanvasY: best._hover_y,
                        },
                    }
                }
                return null
            }

            if (isIntervalTrackType(track.type) && data?.mode === 'bigbed_detail' && Array.isArray(data?.features)) {
                const curSpan = Math.max(1, viewEnd - viewStart)
                const lanePitch = bigBedLanePitch(data?.labelled)
                const exonH = BIGBED_DETAIL_EXON_HEIGHT
                const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                const maxVisibleLanes = getBigBedLaneCapacity(plotHeight, lanePitch)
                let best = null
                let bestDist = Infinity
                let bestRank = Infinity
                for (const feature of data.features) {
                    const s = Number(feature?.start)
                    const e = Number(feature?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                    if (lane >= maxVisibleLanes) continue
                    const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                    const drawX1 = left + ((s - viewStart) / curSpan) * (right - left)
                    const drawX2 = left + ((e - viewStart) / curSpan) * (right - left)
                    const txLeft = Math.min(drawX1, drawX2)
                    const txRight = Math.max(drawX1, drawX2)
                    const key = bigBedFeatureKey(feature)

                    const isTranscript = feature?._render_kind === 'transcript'
                        && feature?._structure_valid === true
                        && Array.isArray(feature?._exon_blocks)
                        && feature._exon_blocks.length > 0

                    let candidate = null
                    if (isTranscript) {
                        if (mouseY >= (yMid - exonH / 2 - 3) && mouseY <= (yMid + exonH / 2 + 3)) {
                            for (const exon of feature._exon_blocks) {
                                const es = Number(exon?.start)
                                const ee = Number(exon?.end)
                                if (!Number.isFinite(es) || !Number.isFinite(ee) || ee <= es) continue
                                if (ee <= viewStart || es >= viewEnd) continue
                                const ex1 = left + ((es - viewStart) / curSpan) * (right - left)
                                const ex2 = left + ((ee - viewStart) / curSpan) * (right - left)
                                const exonLeft = Math.min(ex1, ex2)
                                const exonRight = Math.max(ex1, ex2)
                                if (mouseX < exonLeft - 2 || mouseX > exonRight + 2) continue
                                const centerX = (exonLeft + exonRight) / 2
                                const dist = Math.abs(mouseX - centerX)
                                candidate = {
                                    rank: 0,
                                    dist,
                                    anchorCanvasX: centerX,
                                    anchorCanvasY: yMid,
                                }
                                break
                            }
                        }
                        if (!candidate && mouseY >= yMid - 4 && mouseY <= yMid + 4 && mouseX >= txLeft - 2 && mouseX <= txRight + 2) {
                            candidate = {
                                rank: 1,
                                dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                                anchorCanvasX: (txLeft + txRight) / 2,
                                anchorCanvasY: yMid,
                            }
                        }
                    }

                    if (!candidate) {
                        if (mouseY < yMid - 6 || mouseY > yMid + 6) continue
                        if (mouseX < txLeft - 2 || mouseX > txRight + 2) continue
                        candidate = {
                            rank: 2,
                            dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                            anchorCanvasX: (txLeft + txRight) / 2,
                            anchorCanvasY: yMid,
                        }
                    }

                    if (!candidate) continue
                    if (candidate.rank < bestRank || (candidate.rank === bestRank && candidate.dist < bestDist)) {
                        bestRank = candidate.rank
                        bestDist = candidate.dist
                        best = {
                            feature,
                            key,
                            anchorCanvasX: candidate.anchorCanvasX,
                            anchorCanvasY: candidate.anchorCanvasY,
                        }
                    }
                }
                if (best) {
                    return {
                        hoverBigBed: {
                            trackId,
                            key: best.key,
                            feature: best.feature,
                            anchorCanvasX: best.anchorCanvasX,
                            anchorCanvasY: best.anchorCanvasY,
                        },
                    }
                }
                return null
            }

            // ── Signal / density bins ────────────────────────────────────────
            const bins = data?.bins
            if (!Array.isArray(bins) || bins.length === 0) return null

            const binWidth = (right - left) / bins.length
            const idx = clamp(Math.floor((mouseX - left) / Math.max(1e-9, binWidth)), 0, bins.length - 1)
            const value = bins[idx]
            return {
                x: clientX,
                y: clientY,
                hoverKey: `${trackId}|${idx}`,
                text: `${track.label || 'Custom track'}: ${formatSignalValueExact(value)}`,
            }
        }
        return null
    }

export function findSelectedGeneTranscriptHit(ctx, mouseX, mouseY) {
    const {
        genomicToScreen,
        getDisplayTranscriptRows,
        isTranscriptCompressionActive,
        layout,
        selectedGeneLayoutEntry,
        shouldForceGeneBlockView,
        transcriptCache,
        transcriptLayoutMetrics,
    } = ctx
        if (!selectedGeneLayoutEntry || shouldForceGeneBlockView) return null

        const gene = selectedGeneLayoutEntry
        const txs = transcriptCache[gene.id]
        const displayRows = getDisplayTranscriptRows(gene)
        if (!txs || txs.length === 0 || displayRows.length === 0) return null

        const isForward = gene.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
        const lineHitPadding = isTranscriptCompressionActive ? 4 : 5
        const exonHitPadding = isTranscriptCompressionActive ? 2.5 : 3

        // The row band is painted across the whole gene, so it has to be live
        // across the whole gene too. Keying the row hit off each transcript's own
        // span instead left the short ones with a hit area narrower than the
        // highlight the user could plainly see.
        const rawGeneX1 = genomicToScreen(gene.start)
        const rawGeneX2 = genomicToScreen(gene.end)
        const geneLeft = Math.min(rawGeneX1, rawGeneX2)
        const geneRight = Math.max(rawGeneX1, rawGeneX2)

        let best = null
        let bestRank = Infinity
        let bestDist = Infinity

        for (let txIdx = 0; txIdx < displayRows.length; txIdx += 1) {
            // Ghosts still occupy their row so the ones below stay correctly
            // offset, but they are a preview and must not be clickable.
            if (displayRows[txIdx].ghost) continue
            const tx = displayRows[txIdx].transcript
            const txY = baseGeneY + txIdx * transcriptLayoutMetrics.rowPitch
            const midY = txY + transcriptLayoutMetrics.midOffset
            const rawTxX1 = genomicToScreen(tx.start)
            const rawTxX2 = genomicToScreen(tx.end)
            const txLeft = Math.min(rawTxX1, rawTxX2)
            const txRight = Math.max(rawTxX1, rawTxX2)

            let candidate = null
            const exons = Array.isArray(tx?.exons) ? tx.exons : []
            const exonBandTop = midY - (transcriptLayoutMetrics.exonHeight / 2) - exonHitPadding
            const exonBandBottom = midY + (transcriptLayoutMetrics.exonHeight / 2) + exonHitPadding
            if (mouseY >= exonBandTop && mouseY <= exonBandBottom) {
                for (const exon of exons) {
                    const rawEx1 = genomicToScreen(exon.start)
                    const rawEx2 = genomicToScreen(exon.end)
                    const exonLeft = Math.min(rawEx1, rawEx2)
                    const exonRight = Math.max(rawEx1, rawEx2)
                    if (mouseX < exonLeft - 2 || mouseX > exonRight + 2) continue
                    const centerX = (exonLeft + exonRight) / 2
                    candidate = {
                        rank: 0,
                        dist: Math.abs(mouseX - centerX),
                        anchorCanvasX: centerX,
                        anchorCanvasY: midY,
                        transcript: tx,
                    }
                    break
                }
            }

            if (!candidate && mouseY >= midY - lineHitPadding && mouseY <= midY + lineHitPadding && mouseX >= txLeft - 2 && mouseX <= txRight + 2) {
                candidate = {
                    rank: 1,
                    dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                    anchorCanvasX: clamp(mouseX, txLeft, txRight),
                    anchorCanvasY: midY,
                    transcript: tx,
                }
            }

            // Anywhere in the row counts, not just the drawn structure. The band
            // is the one the highlight paints, so what lights up under the cursor
            // is exactly what responds to it. Ranked last, so an exon or the
            // intron line still wins where the bands overlap and the popup keeps
            // anchoring to the feature rather than to empty row.
            if (!candidate && mouseX >= geneLeft - 2 && mouseX <= geneRight + 2) {
                const rowTop = txY
                const rowBottom = txY + transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
                if (mouseY >= rowTop && mouseY <= rowBottom) {
                    candidate = {
                        rank: 2,
                        dist: Math.abs(mouseX - ((geneLeft + geneRight) / 2)),
                        // Anchor the popup on the transcript even when the pointer
                        // is out past its end, so the arrow never points at nothing.
                        anchorCanvasX: clamp(mouseX, txLeft, txRight),
                        anchorCanvasY: midY,
                        transcript: tx,
                    }
                }
            }

            if (!candidate) continue
            if (candidate.rank < bestRank || (candidate.rank === bestRank && candidate.dist < bestDist)) {
                bestRank = candidate.rank
                bestDist = candidate.dist
                best = {
                    gene,
                    transcript: candidate.transcript,
                    anchorCanvasX: candidate.anchorCanvasX,
                    anchorCanvasY: candidate.anchorCanvasY,
                }
            }
        }

        return best
    }

export function findGeneFeatureVerticalAnchor(ctx, mouseX, mouseY, trackId) {
    const {
        genomicToScreen,
        getDisplayTranscriptsForGene,
        getGeneTotalHeight,
        layout,
        transcriptLayoutMetrics,
    } = ctx
        const trackGenes = trackId === 'forward'
            ? layout.forwardGenes
            : trackId === 'reverse'
                ? layout.reverseGenes
                : []
        if (trackGenes.length === 0) return null

        const trackY = trackId === 'forward' ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = trackId === 'forward' ? layout.fwdPadding : layout.revPadding
        let best = null

        for (const gene of trackGenes) {
            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)
            if (mouseX < gx1 - 4 || mouseX > gx2 + 4) continue

            const geneWidth = Math.max(1, gx2 - gx1)
            const displayTxs = getDisplayTranscriptsForGene(gene, geneWidth)
            const rowCount = Math.max(1, displayTxs.length || 1)
            const baseGeneY = trackY
                + trackPadding
                + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const totalGeneHeight = getGeneTotalHeight(rowCount)
            if (mouseY < baseGeneY || mouseY > baseGeneY + totalGeneHeight) continue

            const rowAnchor = getFeatureRowAnchor({
                baseGeneY,
                pointerY: mouseY,
                rowPitch: transcriptLayoutMetrics.rowPitch,
                midOffset: transcriptLayoutMetrics.midOffset,
                rowCount,
                transcriptIds: displayTxs.map((tx) => tx?.id),
            })
            if (!rowAnchor) continue

            const rowMidY = baseGeneY
                + (rowAnchor.rowIndex * transcriptLayoutMetrics.rowPitch)
                + transcriptLayoutMetrics.midOffset
            const distance = Math.abs(mouseY - rowMidY)
            if (!best || distance < best.distance) {
                best = {
                    trackId,
                    geneId: String(gene.id),
                    transcriptId: rowAnchor.transcriptId,
                    fallbackRowIndex: rowAnchor.rowIndex,
                    rowOffset: rowAnchor.rowOffset,
                    distance,
                }
            }
        }

        if (!best) return null
        return {
            trackId: best.trackId,
            geneId: best.geneId,
            transcriptId: best.transcriptId,
            fallbackRowIndex: best.fallbackRowIndex,
            rowOffset: best.rowOffset,
        }
    }
