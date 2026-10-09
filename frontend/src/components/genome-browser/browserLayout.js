// The vertical layout of a Genome Browser panel: ruler, focus bar, gene and transcript
// rows, sequence and custom track bands, and the total height. Computed by the panel's
// layout memo from its current state.
import { GENE_INDEX_TRACK_HEIGHT } from '../../utils/geneIndexOverlay.js'
import { isGroupRowId } from '../../utils/trackGroups.js'
import {
    CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF,
    CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF_COMPACT,
    CUSTOM_TRACK_HEIGHT_STANDARD,
    CUSTOM_TRACK_HEIGHT_ZONED,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    GENE_LAYOUT_BUCKET_MIN_STEP,
    GENE_LAYOUT_BUFFER_MAX,
    GENE_LAYOUT_BUFFER_MIN,
    GENE_LAYOUT_COVERAGE_SHRINK_THRESHOLD,
    GENE_SUBTRACK_DISABLE_BP,
    GENE_SUBTRACK_ENABLE_BP,
    JOINED_GROUP_HEADER_HEIGHT,
    LHS_WIDTH,
    MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP,
    SPLICE_BLOCK_TRACK_HEIGHT,
    SPLICE_HEIGHT_BASE,
    SPLICE_HEIGHT_MAX,
    SPLICE_HEIGHT_MIN,
    bigBedLanePitch,
    isIntervalTrackType,
} from './browserConstants.js'
import { geneFooterTrackOverflow } from './genomeBrowserLabelLayout.js'
import { SEQUENCE_TRACK_HEIGHT } from './genomeBrowserViewportLayout.js'
import { clamp } from './trackData.js'
import {
    getBigBedTrackHeightForLanes,
    isVcfAdaptiveLikeMode,
    normalizeBigWigDisplayMode,
    normalizeBigWigSettings,
    normalizeVcfDisplayMode,
} from './trackSettings.js'

export function computeBrowserLayout(ctx) {
    const {
        bpPerPx,
        collectCachedGenesInRange,
        compactPanelHeight,
        customTrackData,
        customTrackLoading,
        customTracksById,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        effectiveTrackAlign,
        flattenTracks,
        focusBarHeight,
        geneLayoutPackCacheRef,
        geneRowShrinkBucketRef,
        geneRowStickyRef,
        geneSubtrackStateRef,
        genes,
        genomicViewRange,
        getDisplayTranscriptRows,
        getVcfBlockLevel,
        hiddenBiotypeClasses,
        hiddenGeneIdSet,
        hiddenStrands,
        hideInactiveTracks,
        holdGeneTrackHeight,
        isCompressedLayoutActive,
        isCustomTrackId,
        isGeneHiddenFromTracks,
        isLocationFocusVisible,
        isTranscriptCompressionActive,
        joinedRows,
        selectedChrom,
        selectedGene,
        selectedGeneHiddenByBiotype,
        showSequenceTrack,
        trackOrder,
        transcriptCache,
        transcriptLayoutMetrics,
        viewHeight,
        viewSpan,
        viewWidth,
    } = ctx
        const trackWidthPx = Math.max(1, viewWidth - LHS_WIDTH)
        const pxToBp = viewSpan / trackWidthPx
        const minGapBp = 0 // Fixed to 0 to prevent vertical jumping of tracks during zoom
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const bucketStep = Math.max(GENE_LAYOUT_BUCKET_MIN_STEP, viewSpan * 0.25)
        const layoutCenter = (layoutStart + layoutEnd) / 2
        const layoutBucket = Math.floor(layoutCenter / bucketStep)
        const zoomBucket = Math.round(Math.log2(Math.max(1e-9, pxToBp)) * 16) / 16

        let enableSubtracks = geneSubtrackStateRef.current
        if (flattenTracks) {
            enableSubtracks = true
        } else if (enableSubtracks) {
            if (viewSpan >= GENE_SUBTRACK_DISABLE_BP) enableSubtracks = false
        } else if (viewSpan <= GENE_SUBTRACK_ENABLE_BP) {
            enableSubtracks = true
        }
        geneSubtrackStateRef.current = enableSubtracks

        // Skipped outright when nothing is hidden: this runs over every gene in
        // the layout window on every frame of a zoom.
        const anythingHidden = hiddenBiotypeClasses.length > 0 || hiddenGeneIdSet.size > 0
        const biotypeFilter = anythingHidden
            ? (g) => !isGeneHiddenFromTracks(g)
            : () => true

        const geneOverlapsCurrentWindow = (gene) => {
            const start = Number(gene?.start)
            const end = Number(gene?.end)
            if (!Number.isFinite(start) || !Number.isFinite(end)) return false
            return Math.max(start, end) >= viewGStart && Math.min(start, end) <= viewGEnd
        }
        const displayGeneSource = flattenTracks
            ? genes.filter(geneOverlapsCurrentWindow)
            : genes

        const forwardGenes = effectiveHiddenStrands.forward
            ? []
            : displayGeneSource.filter(g => g.strand === '+').filter(biotypeFilter)
        const reverseGenes = effectiveHiddenStrands.reverse
            ? []
            : displayGeneSource.filter(g => g.strand === '-').filter(biotypeFilter)

        const layoutGenesResult = flattenTracks
            ? { genes: displayGeneSource, coverage: 1 }
            : (selectedChrom
                ? collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
                : { genes, coverage: 1 })
        const layoutCoverage = Number(layoutGenesResult?.coverage || 0)
        const layoutGenesAll = Array.isArray(layoutGenesResult?.genes) ? layoutGenesResult.genes : genes
        const forwardLayoutGenes = effectiveHiddenStrands.forward
            ? []
            : layoutGenesAll.filter(g => g.strand === '+').filter(biotypeFilter)
        const reverseLayoutGenes = effectiveHiddenStrands.reverse
            ? []
            : layoutGenesAll.filter(g => g.strand === '-').filter(biotypeFilter)

        // Rows are whatever gets drawn, including the hover ghost — that is what
        // makes previewing a hidden transcript push the rows below it down.
        // A gene with everything hidden still claims one row for its block glyph.
        const getGeneRowSpan = (gene) => Math.max(1, getDisplayTranscriptRows(gene).length || 1)

        const stabilizeRowCount = (strandKey, requiredRows) => {
            const safeRequired = Math.max(1, requiredRows)
            const prevSticky = Math.max(1, Number(geneRowStickyRef.current[strandKey] || 1))
            let nextSticky = safeRequired
            if (safeRequired > prevSticky) {
                nextSticky = safeRequired
                geneRowShrinkBucketRef.current[strandKey] = layoutBucket
            } else if (safeRequired < prevSticky) {
                if (layoutCoverage >= GENE_LAYOUT_COVERAGE_SHRINK_THRESHOLD) {
                    const lastShrinkBucket = geneRowShrinkBucketRef.current[strandKey]
                    if (lastShrinkBucket !== layoutBucket) {
                        nextSticky = Math.max(safeRequired, prevSticky - 1)
                        geneRowShrinkBucketRef.current[strandKey] = layoutBucket
                    } else {
                        nextSticky = prevSticky
                    }
                } else {
                    nextSticky = prevSticky
                }
            } else {
                nextSticky = prevSticky
            }
            geneRowStickyRef.current[strandKey] = nextSticky
            return nextSticky
        }

        const calculateRows = (strandKey, visibleStrandGenes, layoutStrandGenes) => {
            if (!enableSubtracks) {
                let maxRows = 1
                visibleStrandGenes.forEach(gene => {
                    gene._row = 0
                    maxRows = Math.max(maxRows, getGeneRowSpan(gene))
                })
                geneRowStickyRef.current[strandKey] = Math.max(1, maxRows)
                geneRowShrinkBucketRef.current[strandKey] = layoutBucket
                return maxRows
            }

            const sorted = [...layoutStrandGenes].sort((a, b) => {
                if (a.start !== b.start) return a.start - b.start
                if (a.end !== b.end) return a.end - b.end
                return String(a.id).localeCompare(String(b.id))
            })
            const filterHash = hiddenBiotypeClasses.slice().sort().join(',')
            // Row span is the packer's only transcript-derived input, so keying on
            // it is exact: expanding, hiding a transcript, or hovering a ghost all
            // move it and invalidate the cache, and nothing else needs to.
            const signature = sorted.map((gene) => {
                const txCount = transcriptCache[gene.id]?.length || 0
                return `${gene.id}:${gene.start}:${gene.end}:tx${txCount}:rows${getGeneRowSpan(gene)}`
            }).join('|')
            const packingKey = [
                selectedChrom || '',
                strandKey,
                String(layoutBucket),
                String(zoomBucket),
                enableSubtracks ? '1' : '0',
                isTranscriptCompressionActive ? 'compressed' : 'normal',
                flattenTracks ? 'flattened' : 'standard',
                filterHash,
                signature,
            ].join('|')

            const packedCache = geneLayoutPackCacheRef.current[strandKey]
            let rowMap
            let requiredRows
            if (packedCache && packedCache.key === packingKey) {
                rowMap = packedCache.rowMap
                requiredRows = packedCache.requiredRows
            } else {
                const rows = []
                rowMap = new Map()
                sorted.forEach(gene => {
                    const rowCount = getGeneRowSpan(gene)
                    let targetRow = 0
                    while (true) {
                        let allFree = true
                        for (let r = targetRow; r < targetRow + rowCount; r++) {
                            if (rows[r] !== undefined && gene.start < rows[r] + minGapBp) {
                                allFree = false
                                break
                            }
                        }
                        if (allFree) break
                        targetRow++
                    }

                    rowMap.set(gene.id, targetRow)
                    for (let r = targetRow; r < targetRow + rowCount; r++) {
                        rows[r] = Math.max(rows[r] || 0, gene.end)
                    }
                })
                requiredRows = Math.max(1, rows.length || 1)
                geneLayoutPackCacheRef.current[strandKey] = {
                    key: packingKey,
                    rowMap,
                    requiredRows,
                }
            }

            visibleStrandGenes.forEach((gene) => {
                gene._row = rowMap.get(gene.id) ?? 0
            })
            if (flattenTracks) {
                return requiredRows
            }
            return stabilizeRowCount(strandKey, requiredRows)
        }

        const maxRowForward = effectiveHiddenStrands.forward ? 0 : calculateRows('forward', forwardGenes, forwardLayoutGenes)
        const maxRowReverse = effectiveHiddenStrands.reverse ? 0 : calculateRows('reverse', reverseGenes, reverseLayoutGenes)

        const fwdPadding = effectiveHiddenStrands.forward ? 0 : transcriptLayoutMetrics.trackPadding
        const revPadding = effectiveHiddenStrands.reverse ? 0 : transcriptLayoutMetrics.trackPadding
        const forwardGeneHeight = maxRowForward * transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
        const reverseGeneHeight = maxRowReverse * transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
        // Flatten removes *unused* height, and the gene's label and its expand/collapse
        // control are not unused height — they are the only thing naming the gene once the
        // canvas label moves under it. Reserving their room here is what keeps them on
        // screen when the track shrinks to its content. Compressed layouts still drop it:
        // they have one or two pixels of padding to work with and no footer to place.
        const geneFooterOverflow = isCompressedLayoutActive
            ? 0
            : geneFooterTrackOverflow(transcriptLayoutMetrics, flattenTracks)

        // With no genes to lay out the tracks collapse to their minimum, which is
        // a sliver — too little to put a message in, and every track below would
        // jump down the moment the first genes arrived. While the index is being
        // built they hold a fixed height instead, so the panel the user pans and
        // zooms around is the same shape it will be when the genes land.
        const geneTrackFloor = holdGeneTrackHeight
            ? GENE_INDEX_TRACK_HEIGHT
            : transcriptLayoutMetrics.minTrackHeight

        const forwardBgHeight = effectiveHiddenStrands.forward
            ? (hideInactiveTracks ? 0 : 36)
            : Math.max(
                geneTrackFloor,
                fwdPadding
                    + (flattenTracks ? forwardGeneHeight : maxRowForward * transcriptLayoutMetrics.rowPitch)
                    + geneFooterOverflow
            )
        const reverseBgHeight = effectiveHiddenStrands.reverse
            ? (hideInactiveTracks ? 0 : 36)
            : Math.max(
                geneTrackFloor,
                revPadding
                    + (flattenTracks ? reverseGeneHeight : maxRowReverse * transcriptLayoutMetrics.rowPitch)
                    + geneFooterOverflow
            )
        const seqBgHeight = SEQUENCE_TRACK_HEIGHT

        const getTrackHeight = (trackId) => {
            if (trackId === 'forward') return forwardBgHeight
            if (trackId === 'reverse') return reverseBgHeight
            if (trackId === 'sequence') {
                if (!showSequenceTrack) return 0
                if (hideInactiveTracks && effectiveHiddenStrands.sequence) return 0
                return seqBgHeight
            }
            if (isCustomTrackId(trackId) && customTracksById.has(trackId)) {
                const t = customTracksById.get(trackId)
                if (t?.visible === false) return hideInactiveTracks ? 0 : 36
                const rawMode = t?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
                const mode = t?.type === 'bigwig'
                    ? normalizeBigWigDisplayMode(rawMode, normalizeBigWigSettings(t?.bigwigSettings || t?.bigwig_settings).data_type)
                    : t?.type === 'vcf'
                        ? normalizeVcfDisplayMode(rawMode)
                        : rawMode
                if (t?.type === 'splice_junctions') {
                    const data = customTrackData?.[trackId]
                    if (data?.mode === 'splice_blocks') {
                        return SPLICE_BLOCK_TRACK_HEIGHT
                    }
                    const suggested = Number(data?.layout?.recommended_height)
                    if (!Number.isFinite(suggested)) return SPLICE_HEIGHT_BASE
                    // Keep prior stable size while tile coverage is still sparse.
                    if (customTrackLoading?.[trackId] && Number(data?.coverage || 0) < 0.55) {
                        return SPLICE_HEIGHT_BASE
                    }
                    return Math.round(clamp(suggested, SPLICE_HEIGHT_MIN, SPLICE_HEIGHT_MAX))
                }
                if (isIntervalTrackType(t?.type) && t?.renderMode === 'density') {
                    return CUSTOM_TRACK_HEIGHT_ZONED
                }
                if (isIntervalTrackType(t?.type)) {
                    const data = customTrackData?.[trackId]
                    if (data?.mode === 'bigbed_detail') {
                        const laneCount = Math.max(1, Number(data?.lane_count || 1))
                        // Keep compact baseline while detail tiles are still sparse.
                        if (customTrackLoading?.[trackId] && Number(data?.tile_coverage || 0) < 0.6) {
                            return CUSTOM_TRACK_HEIGHT_STANDARD
                        }
                        return getBigBedTrackHeightForLanes(laneCount, bigBedLanePitch(data?.labelled))
                    }
                }
                if (mode === 'zoned_heatmap') return CUSTOM_TRACK_HEIGHT_ZONED
                if ((mode === 'ensembl' || isVcfAdaptiveLikeMode(mode)) && t?.type === 'vcf') {
                    if (isVcfAdaptiveLikeMode(mode)) {
                        const vcfData = customTrackData?.[trackId]
                        const vcfLevel = getVcfBlockLevel(bpPerPx)
                        const isDetailMode = vcfData?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
                        if (!isDetailMode) return CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF_COMPACT
                    }
                    return bpPerPx <= 0.5 ? 200 : CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF
                }
                return CUSTOM_TRACK_HEIGHT_STANDARD
            }
            if (isGroupRowId(trackId) && joinedRows.has(trackId)) {
                const row = joinedRows.get(trackId)
                if (row.hidden) return hideInactiveTracks ? 0 : 36
                return JOINED_GROUP_HEADER_HEIGHT + row.memberIds.reduce((sum, id) => sum + getTrackHeight(id), 0)
            }
            return 0
        }

        const activeTrackOrder = trackOrder.filter((trackId) => getTrackHeight(trackId) > 0)
        const totalTrackHeight = activeTrackOrder.reduce((sum, trackId) => sum + getTrackHeight(trackId), 0)

        // In bottom-aligned mode, selected-gene focus bar appears outside the canvas container
        // and shrinks container height; compensate so selecting/deselecting a gene does not
        // vertically shift all tracks.
        const selectedGeneHiddenForLayout = selectedGene && (
            (selectedGene.strand === '+' && hiddenStrands.forward) ||
            (selectedGene.strand === '-' && hiddenStrands.reverse) ||
            selectedGeneHiddenByBiotype
        )
        const visibleFocusBarHeight = (selectedGene && !selectedGeneHiddenForLayout) || isLocationFocusVisible
            ? (focusBarHeight || 30)
            : 0
        const alignTracksToBottom = effectiveTrackAlign === 'bottom' && !compactPanelHeight
        const focusBarCompensation = alignTracksToBottom ? visibleFocusBarHeight : 0
        const availableSpace = Math.max(160, viewHeight + focusBarCompensation)
        let RULER_Y = 0

        let startY = 0
        if (effectiveRulerPosition === 'top') {
            startY = effectiveRulerHeight
            if (alignTracksToBottom) {
                const bottomAlignedY = Math.max(effectiveRulerHeight, availableSpace - totalTrackHeight)
                startY = Math.min(bottomAlignedY, effectiveRulerHeight + MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP)
            }
        } else if (alignTracksToBottom) {
            const bottomAlignedY = Math.max(0, availableSpace - effectiveRulerHeight - totalTrackHeight)
            startY = Math.min(bottomAlignedY, MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP)
        }

        let FORWARD_Y = 0
        let REVERSE_Y = 0
        let SEQUENCE_Y = -999
        let currentY = startY
        const customTrackLayouts = {}
        const groupRowLayouts = {}
        const orderedTracks = []

        for (const trackId of activeTrackOrder) {
            const h = getTrackHeight(trackId)
            if (h <= 0) continue

            if (trackId === 'forward') FORWARD_Y = currentY
            else if (trackId === 'reverse') REVERSE_Y = currentY
            else if (trackId === 'sequence') SEQUENCE_Y = currentY
            else if (isCustomTrackId(trackId)) customTrackLayouts[trackId] = { y: currentY, height: h }
            else if (isGroupRowId(trackId)) {
                // One row for the group; each of its tracks is laid out in a band of it,
                // under a header naming the group, so everything that draws or hit-tests a
                // custom track finds them where they are.
                const row = joinedRows.get(trackId)
                groupRowLayouts[trackId] = { y: currentY, height: h, memberIds: row.memberIds, label: row.label, hidden: row.hidden }
                if (!row.hidden) {
                    let memberY = currentY + JOINED_GROUP_HEADER_HEIGHT
                    row.memberIds.forEach((memberId, index) => {
                        const memberHeight = getTrackHeight(memberId)
                        customTrackLayouts[memberId] = { y: memberY, height: memberHeight, joinedRowId: trackId, joinedIndex: index }
                        memberY += memberHeight
                    })
                }
            }

            orderedTracks.push({ id: trackId, y: currentY, height: h })
            currentY += h
        }

        const lastTrackY = orderedTracks.length
            ? Math.max(...orderedTracks.map((track) => track.y + track.height))
            : startY

        if (effectiveRulerPosition === 'bottom') {
            RULER_Y = compactPanelHeight
                ? lastTrackY
                : Math.max(lastTrackY, viewHeight - effectiveRulerHeight)
        }

        return {
            forwardGenes,
            reverseGenes,
            forwardBgHeight,
            reverseBgHeight,
            seqBgHeight,
            FORWARD_Y,
            REVERSE_Y,
            SEQUENCE_Y,
            RULER_Y,
            fwdPadding,
            revPadding,
            customTrackLayouts,
            groupRowLayouts,
            orderedTracks,
        }
    }
