// Painting one Genome Browser panel onto its canvas: the ruler, genes and
// transcripts (with their layout modes), sequence, every custom track type (bigWig,
// VCF, BED/bigBed, splice junctions, long reads), selections, focus and alignment
// overlays. Called by the panel's paintCanvas, which passes its current state in.
// The backing store is resized only when its size changes (top of the function);
// the pause while the panel is off screen stays in the component's paint effect.
import { bedThickPieces } from '../../utils/bedThickRegion.js'
import { getBaseColor } from '../../utils/nucleotideStyle.js'
import { drawPowerGlyph } from '../../utils/powerGlyph.js'
import { monoFont, sansFont } from '../../utils/typography.js'
import { getVcfAltAlleleCount, getVcfDetailVariantLayout, localVcfType, shouldRenderActiveAnchorBase } from '../../utils/vcfDetailGeometry.js'
import { formatZoneLabel, zoneThresholdsFor, zonedSegments, zonedValueFraction } from '../../utils/zonedScale.js'
import { buildAlignedIntronChevronLayout } from '../featureExplorerTranscriptGeometry.js'
import {
    BED_DENSITY_LEVELS,
    BIGBED_DETAIL_EXON_HEIGHT,
    BIGBED_DETAIL_LABEL_FONT_PX,
    BIGBED_DETAIL_LANE_TOP_PAD,
    BIGWIG_DATA_TYPE_DEFAULTS,
    COORD_FONT,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    EXON_HEIGHT,
    INTRON_HEIGHT,
    JOINED_GROUP_HEADER_HEIGHT,
    LABEL_FONT,
    LHS_WIDTH,
    REVERSE_COMPLEMENTED_TRACK_IDS,
    SIDEBAR_RC_HALF_GAP,
    SIDEBAR_RC_LINE_GAP,
    SIDEBAR_TOGGLE_ICON_SIZE,
    SIDEBAR_TOGGLE_LABEL_GAP,
    VCF_SETTINGS_DEFAULTS,
    ZONED_ZONE_SOLID_COLORS,
    bigBedLanePitch,
    isIntervalTrackType,
    joinedGroupHeaderText,
} from './browserConstants.js'
import { getGeneCoordRange } from './browserFormat.js'
import { beginCanvasMirror, endCanvasMirror, fillScreenText } from './canvasText.js'
import { getTranscriptExonSegments } from './genomeBrowserExonSegments.js'
import {
    LABEL_ASCENT_PX,
    LABEL_DESCENT_PX,
    buildGeneLabelCandidate,
    getTranscriptBoundaryTrails,
    intersectsRuler,
    placeNonOverlappingGeneLabels,
} from './genomeBrowserLabelLayout.js'
import {
    RULER_FONT_SIZE,
    RULER_LABEL_GAP,
    formatRulerCoord,
    rulerGeometry,
    rulerTicks,
} from './genomeBrowserRuler.js'
import {
    annotateSpliceSimilarityLift,
    computeSplicePeakY,
    cubicDerivativeAt,
    cubicPointAt,
    getSpliceBezierControls,
    spliceJunctionKey,
    spliceSupportBandWeight,
    spliceSupportColor,
} from './spliceGeometry.js'
import { REV_COMP, bigBedFeatureKey, clamp, normalizeVcfDensityForHotspots } from './trackData.js'
import {
    bedTrackColors,
    bigBedBlockColor,
    bigBedBlockStroke,
    bigBedFeatureColor,
    getBigBedLaneCapacity,
    hexToRgba,
    isVcfAdaptiveLikeMode,
    normalizeBigWigDisplayMode,
    normalizeBigWigHexColor,
    normalizeBigWigSettings,
    normalizeSpliceTrackSettings,
    normalizeVcfDisplayMode,
    normalizeVcfSettings,
} from './trackSettings.js'

export function paintBrowserCanvas(panel) {
    const {
        alignData,
        alignmentCoords,
        anchorIconImgRef,
        bigWigZoneScales,
        bpPerPx,
        canvasRef,
        clickedBigBedFeature,
        clickedSpliceJunction,
        clickedVcfVariant,
        colors,
        compressTranscripts,
        customTrackData,
        customTrackLoading,
        customTracksById,
        dimNonSelectedGenes,
        draggingTrack,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        expandedFooterGeneIds,
        flattenTracks,
        focusLocationRange,
        focusTranscriptView,
        formatSignalValue,
        genes,
        genomicToScreen,
        getBasePixelBounds,
        getCustomTrackGeometry,
        getCustomTrackIntervalPixelBounds,
        getCustomTrackToggleY,
        getDisplayTranscriptRows,
        getEffectiveTranscriptLimit,
        getGenomicIntervalPixelBounds,
        getSpliceLodMode,
        hoveredBigBedFeature,
        hoveredSeqBase,
        hoveredSpliceJunction,
        hoveredTrack,
        hoveredVcfBlock,
        isAligned,
        isCompressedLayoutActive,
        isCustomTrackId,
        isFlipped,
        isLight,
        isLocationFocusVisible,
        isPrimaryPanel,
        isTranscriptCompressionActive,
        layout,
        minCanvasHeight,
        naturalCanvasHeight,
        overlayToGenomic,
        panelExonColor,
        panelPillColor,
        selectedGene,
        selectionRect,
        seqRange,
        sequence,
        sequenceTrackLabel,
        shouldForceGeneBlockView,
        showSequenceTrack,
        sidebarToggleIconColor,
        spliceArcLiftOffsets,
        trackOrder,
        trackWidth,
        transcriptCache,
        transcriptLayoutMetrics,
        viewEnd,
        viewSpan,
        viewStart,
        viewWidth,
    } = panel
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        endCanvasMirror(ctx)
        const dpr = window.devicePixelRatio || 1

        const { FORWARD_Y, REVERSE_Y, SEQUENCE_Y, RULER_Y, forwardBgHeight, reverseBgHeight, seqBgHeight, customTrackLayouts } = layout

        // Deliberately independent of the measured container height: the container
        // grows with the canvas, so feeding viewHeight back in would loop. The
        // shared band height keeps sibling genomes the same size when the panels
        // are not free to shrink to their own content.
        const canvasHeight = Math.max(naturalCanvasHeight, Number(minCanvasHeight) || 0)

        // Resize the backing store only when dimensions actually change. Assigning
        // canvas.width/height clears and reallocates the high-DPI buffer.
        const backingWidth = Math.max(1, Math.round(viewWidth * dpr))
        const backingHeight = Math.max(1, Math.round(canvasHeight * dpr))
        if (canvas.width !== backingWidth) canvas.width = backingWidth
        if (canvas.height !== backingHeight) canvas.height = backingHeight
        const cssWidth = `${viewWidth}px`
        const cssHeight = `${canvasHeight}px`
        if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth
        if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        // Clear
        ctx.fillStyle = colors.bg
        ctx.fillRect(0, 0, viewWidth, canvasHeight)

        let tickInterval = 10
        const span = viewEnd - viewStart
        if (effectiveRulerHeight > 0) {
            // ---- Coordinate Ruler ----
            // Styled after www.ensembl.org: no filled band and no minor ticks,
            // just a hairline rule closing off the band with a 1px tick at each
            // round coordinate and the coordinate set beside it in mono.
            const geometry = rulerGeometry({
                top: RULER_Y,
                height: effectiveRulerHeight,
                position: effectiveRulerPosition,
            })

            ctx.strokeStyle = colors.rulerLine
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(0, geometry.ruleY + 0.5)
            ctx.lineTo(viewWidth, geometry.ruleY + 0.5)
            ctx.stroke()

            const ticks = rulerTicks({
                start: viewStart,
                end: viewEnd,
                widthPx: viewWidth,
                fontSize: RULER_FONT_SIZE,
            })
            tickInterval = ticks.interval

            ctx.font = COORD_FONT
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            for (const pos of ticks.ticks) {
                const x = isAligned
                    ? (isFlipped
                        ? LHS_WIDTH + (viewEnd - pos) / bpPerPx
                        : LHS_WIDTH + (pos - viewStart) / bpPerPx)
                    : genomicToScreen(pos)
                if (x > viewWidth) continue

                // The leading tick sits just off the left edge so that its label
                // can bleed into view; only its line is skipped.
                if (x >= 0) {
                    ctx.strokeStyle = colors.tickMajor
                    ctx.beginPath()
                    ctx.moveTo(Math.round(x) + 0.5, geometry.tickStart)
                    ctx.lineTo(Math.round(x) + 0.5, geometry.tickEnd)
                    ctx.stroke()
                }

                let labelPos = pos
                if (isAligned && alignmentCoords && alignData) {
                    labelPos = overlayToGenomic(pos)
                }

                // Hide the label for the 1bp start of a sequence, unless aligned.
                if (pos > 1 || isAligned) {
                    ctx.fillStyle = colors.rulerText
                    ctx.fillText(formatRulerCoord(labelPos), x + RULER_LABEL_GAP, geometry.labelBaseline)
                }
            }
        }

        // ---- Track Backgrounds ----
        const getBgColor = (trackId) => {
            const visibleTrackOrder = trackOrder.filter((trackIdItem) => {
                if (trackIdItem === 'sequence') return showSequenceTrack
                if (isCustomTrackId(trackIdItem)) return customTracksById.has(trackIdItem)
                return true
            })
            const index = visibleTrackOrder.indexOf(trackId)
            if (index % 2 === 0) {
                return isLight ? '#ffffff' : '#1a1b1e'
            } else {
                return isLight ? '#f8f9fa' : '#212226'
            }
        }

        const drawTrackBg = (y, h, trackId, hidden) => {
            if (draggingTrack === trackId) {
                ctx.fillStyle = colors.selectedGene
            } else if (hoveredTrack === trackId && draggingTrack !== trackId) {
                ctx.fillStyle = isLight ? '#dbe4ff' : '#2A3141' // distinct hover grey/blue
            } else if (hidden) {
                ctx.fillStyle = isLight ? '#e9ecef' : '#141517'
            } else {
                ctx.fillStyle = getBgColor(trackId)
            }
            ctx.fillRect(0, y, viewWidth, h)
        }

        drawTrackBg(FORWARD_Y, forwardBgHeight, 'forward', effectiveHiddenStrands.forward)
        drawTrackBg(REVERSE_Y, reverseBgHeight, 'reverse', effectiveHiddenStrands.reverse)
        if (showSequenceTrack) {
            drawTrackBg(SEQUENCE_Y, seqBgHeight, 'sequence', effectiveHiddenStrands.sequence)
            ctx.save()
            ctx.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.24)'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(0, SEQUENCE_Y + seqBgHeight - 0.5)
            ctx.lineTo(viewWidth, SEQUENCE_Y + seqBgHeight - 0.5)
            ctx.stroke()
            ctx.restore()
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            if (trackLayout.joinedRowId) continue
            const track = customTracksById.get(trackId)
            drawTrackBg(trackLayout.y, trackLayout.height, trackId, track ? !track.visible : true)
        }
        // A joined track group: one background for the row, a header naming the group, and
        // its tracks on alternating bands with a hairline between them.
        for (const [rowId, rowLayout] of Object.entries(layout.groupRowLayouts || {})) {
            drawTrackBg(rowLayout.y, rowLayout.height, rowId, rowLayout.hidden)
            ctx.save()
            if (!rowLayout.hidden) {
                const bandShade = isLight ? 'rgba(15, 23, 42, 0.035)' : 'rgba(255, 255, 255, 0.035)'
                const hairline = isLight ? 'rgba(100, 116, 139, 0.28)' : 'rgba(148, 163, 184, 0.2)'
                ctx.fillStyle = isLight ? 'rgba(99, 102, 241, 0.07)' : 'rgba(129, 140, 248, 0.09)'
                ctx.fillRect(0, rowLayout.y, viewWidth, JOINED_GROUP_HEADER_HEIGHT)
                ctx.strokeStyle = hairline
                ctx.lineWidth = 1
                for (const memberId of rowLayout.memberIds) {
                    const band = customTrackLayouts[memberId]
                    if (!band) continue
                    if (band.joinedIndex % 2 === 1) {
                        ctx.fillStyle = bandShade
                        ctx.fillRect(LHS_WIDTH, band.y, viewWidth - LHS_WIDTH, band.height)
                    }
                    ctx.beginPath()
                    ctx.moveTo(LHS_WIDTH, band.y + 0.5)
                    ctx.lineTo(viewWidth, band.y + 0.5)
                    ctx.stroke()
                }
            }
            ctx.font = sansFont(10, 600)
            ctx.fillStyle = isLight ? '#4338ca' : '#a5b4fc'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillText(
                joinedGroupHeaderText(rowLayout),
                LHS_WIDTH + 8,
                rowLayout.y + (rowLayout.hidden ? rowLayout.height / 2 : JOINED_GROUP_HEADER_HEIGHT / 2),
            )
            ctx.restore()
        }

        // Background Directional Arrows
        const bgPatternColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)'
        ctx.fillStyle = bgPatternColor
        ctx.font = monoFont(32, 'bold')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const chevronSpacing = 150
        const chevronStartY = FORWARD_Y + forwardBgHeight / 2
        const reverseChevronStartY = REVERSE_Y + reverseBgHeight / 2

        // Static chevrons (no panning offset) to prevent dizzying visual effect.
        // They point the way each strand reads, which a flipped panel reverses.
        const forwardChevron = isFlipped ? '<' : '>'
        const reverseChevron = isFlipped ? '>' : '<'
        for (let bgX = LHS_WIDTH + chevronSpacing / 2; bgX <= viewWidth + chevronSpacing; bgX += chevronSpacing) {
            ctx.fillText(forwardChevron, bgX, chevronStartY + 2)
            ctx.fillText(reverseChevron, bgX, reverseChevronStartY + 2)
        }
        ctx.textBaseline = 'alphabetic' // Restore baseline

        const activeSpliceJunctions = []
        if (clickedSpliceJunction?.junction) {
            const clickedTrack = customTracksById.get(clickedSpliceJunction.trackId)
            activeSpliceJunctions.push({
                ...clickedSpliceJunction.junction,
                _source: 'click',
                _spliceSettings: normalizeSpliceTrackSettings(clickedTrack?.spliceSettings || clickedTrack?.splice_settings),
            })
        } else if (hoveredSpliceJunction?.junction) {
            const hoverTrack = customTracksById.get(hoveredSpliceJunction.trackId)
            activeSpliceJunctions.push({
                ...hoveredSpliceJunction.junction,
                _source: 'hover',
                _spliceSettings: normalizeSpliceTrackSettings(hoverTrack?.spliceSettings || hoverTrack?.splice_settings),
            })
        }
        const spliceBoundaryHighlights = new Map()
        if (activeSpliceJunctions.length > 0) {
            const registerBoundary = (coord, side, weight, source) => {
                if (!Number.isFinite(coord)) return
                const key = `${Math.round(coord)}|${side}`
                const prev = spliceBoundaryHighlights.get(key)
                if (prev) {
                    prev.weight = Math.max(prev.weight, weight)
                    if (source === 'click') prev.clicked = true
                    if (source === 'hover') prev.hovered = true
                    return
                }
                spliceBoundaryHighlights.set(key, {
                    weight,
                    clicked: source === 'click',
                    hovered: source === 'hover',
                })
            }
            for (const j of activeSpliceJunctions) {
                const jStart = Number(j?.start)
                const jEnd = Number(j?.end)
                if (!Number.isFinite(jStart) || !Number.isFinite(jEnd) || jEnd <= jStart) continue
                const support = Math.max(0, Number(j?.n_total ?? j?.reads ?? 0) || 0)
                const weight = spliceSupportBandWeight(support, j?._spliceSettings)
                registerBoundary(jStart - 1, 'right', weight, j._source)
                registerBoundary(jEnd + 1, 'left', weight, j._source)
            }
        }
        const getBoundaryHighlight = (coord, side) => {
            const key = `${Math.round(Number(coord) || 0)}|${side}`
            return spliceBoundaryHighlights.get(key) || null
        }

        // ---- Gene Rendering ----
        const geneLabelCandidates = []
        let geneLabelOrder = 0

        const renderGene = (gene, trackY, trackId, trackOrder) => {
            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)
            const geneWidth = Math.max(1, gx2 - gx1)
            const isForward = gene.strand === '+'

            // Skip if off screen
            if (gx2 < -50 || gx1 > viewWidth + 50) return

            const isSelected = selectedGene && selectedGene.id === gene.id
            const shouldDim = dimNonSelectedGenes && !!selectedGene && !isSelected

            const exonColor = shouldDim ? (isLight ? '#9ca3af' : '#6b7280') : panelExonColor
            const intronColor = shouldDim ? (isLight ? '#adb5bd' : '#495057') : colors.intronLine
            const chevronColor = shouldDim ? (isLight ? '#adb5bd' : '#5c5f66') : colors.strandChevron
            const geneLabelColor = shouldDim ? (isLight ? '#868e96' : '#8a8d93') : colors.geneLabelText

            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)

            // transcript logic
            const txs = transcriptCache[gene.id]
            const displayRows = getDisplayTranscriptRows(gene)
            const displayTxs = displayRows.map((row) => row.transcript)
            const rowCount = Math.max(1, displayRows.length || 1)
            const chevronSpacing = isTranscriptCompressionActive
                ? Math.max(12, geneWidth / 22)
                : Math.max(20, geneWidth / 15)
            const chevronSize = isTranscriptCompressionActive ? 2.6 : 4
            const chevronEdgePadding = isTranscriptCompressionActive ? 7 : 10
            const compressedGeneBlockHeight = compressTranscripts
                ? Math.max(6, transcriptLayoutMetrics.exonHeight + 1)
                : EXON_HEIGHT
            const transcriptChevronPositions = (txs && txs.length > 0 && geneWidth > 30)
                ? buildAlignedIntronChevronLayout(displayTxs, chevronSpacing, chevronEdgePadding, genomicToScreen)
                : []

            // Highlighting follows the pointer, not the focus: only the row the
            // user is over lights up, whether they are hovering the canvas or
            // the matching entry in the focus drawer. A pinned row outranks the
            // pointer — it is the row the panel has been aligned to.
            const highlightTranscriptId = isSelected
                ? String(focusTranscriptView?.pinnedId || focusTranscriptView?.hoverId || '').trim()
                : ''

            if (displayRows.length > 0 && !shouldForceGeneBlockView) {
                // Render with transcript detail (exon/intron structure)
                let txIdx = 0
                for (const { transcript: tx, ghost: isGhostRow } of displayRows) {
                    const txY = baseGeneY + txIdx * transcriptLayoutMetrics.rowPitch
                    const midY = txY + transcriptLayoutMetrics.midOffset
                    // Ghost rows highlight too: the band is what makes a faint
                    // dashed preview read as "this row, right here".
                    const isHighlightedRow = Boolean(
                        highlightTranscriptId && tx.id === highlightTranscriptId
                    )

                    if (isHighlightedRow) {
                        ctx.fillStyle = colors.selectedGene
                        ctx.fillRect(
                            gx1 - 2,
                            txY,
                            geneWidth + 4,
                            transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
                        )
                    }

                    // A ghost previews where a hidden transcript would land: real
                    // geometry in the real row, drawn dashed and faded so it reads
                    // as "not shown yet".
                    ctx.save()
                    if (isGhostRow) {
                        ctx.globalAlpha = 0.9
                        ctx.setLineDash([5, 3])
                    }

                    // Intron line (spans full transcript). Inclusive coordinates again:
                    // the line has to reach the far edge of the last base so it meets the
                    // terminal exon box instead of stopping one base short of it.
                    const txPxPerBp = 1 / Math.max(1e-9, bpPerPx)
                    const txBounds = getGenomicIntervalPixelBounds(
                        tx.start,
                        tx.end,
                        txPxPerBp,
                        viewSpan <= 1000 && txPxPerBp >= 2
                    )
                    const rawTxX1 = txBounds ? txBounds.x1 : genomicToScreen(tx.start)
                    const rawTxX2 = txBounds ? txBounds.x2 : genomicToScreen(tx.end)
                    const txX1 = Math.min(rawTxX1, rawTxX2)
                    const txX2 = Math.max(rawTxX1, rawTxX2)

                    ctx.strokeStyle = intronColor
                    ctx.lineWidth = isTranscriptCompressionActive ? 1 : INTRON_HEIGHT
                    ctx.beginPath()
                    ctx.moveTo(Math.max(0, txX1), midY)
                    ctx.lineTo(Math.min(viewWidth, txX2), midY)
                    ctx.stroke()

                    // Beta-style dotted continuation trails show the full gene
                    // extent whenever this transcript stops short of either
                    // boundary. Geometry is visual rather than strand-based, so
                    // forward, reverse, and flipped panels all align identically.
                    const boundaryTrails = getTranscriptBoundaryTrails(gene, tx, genomicToScreen)
                    if (boundaryTrails.length > 0) {
                        ctx.save()
                        ctx.strokeStyle = exonColor
                        ctx.globalAlpha = shouldDim ? 0.4 : 0.65
                        ctx.lineWidth = 1
                        ctx.setLineDash([2, 3])
                        for (const trail of boundaryTrails) {
                            const x1 = clamp(trail.x1, 0, viewWidth)
                            const x2 = clamp(trail.x2, 0, viewWidth)
                            if (Math.abs(x2 - x1) <= 1) continue
                            ctx.beginPath()
                            ctx.moveTo(x1, midY)
                            ctx.lineTo(x2, midY)
                            ctx.stroke()
                        }
                        ctx.restore()
                    }

                    // Strand chevrons on intron line
                    if (geneWidth > 30) {
                        ctx.strokeStyle = chevronColor
                        ctx.lineWidth = isTranscriptCompressionActive ? 1 : 1.5
                        const chevronPositions = transcriptChevronPositions[txIdx] || []
                        for (const cx of chevronPositions) {
                            if (cx < 0 || cx > viewWidth) continue
                            const visuallyForward = rawGx1 <= rawGx2 ? (gene.strand === '+') : (gene.strand === '-')
                            const chevDir = visuallyForward ? chevronSize : -chevronSize
                            ctx.beginPath()
                            ctx.moveTo(cx - chevDir, midY - chevronSize)
                            ctx.lineTo(cx, midY)
                            ctx.lineTo(cx - chevDir, midY + chevronSize)
                            ctx.stroke()
                        }
                    }

                    // Detailed transcript style:
                    // - uniform-height exon boxes
                    // - coding segments: filled
                    // - non-coding segments: outline only
                    const detailedExonY = midY - transcriptLayoutMetrics.exonHeight / 2
                    const cdsList = Array.isArray(tx.cds_list) ? tx.cds_list : []
                    const exons = Array.isArray(tx.exons) ? tx.exons : []
                    const exonMaskColor = isHighlightedRow ? colors.selectedGene : getBgColor(isForward ? 'forward' : 'reverse')
                    const baseExonStrokeWidth = isTranscriptCompressionActive ? 1 : 1.5
                    // Ghost exons are hollow, so they need a heavier outline than
                    // filled ones to carry the same visual weight.
                    const exonStrokeWidth = isGhostRow ? baseExonStrokeWidth + 0.5 : baseExonStrokeWidth

                    for (const exon of exons) {
                        const exonStart = Number(exon.start)
                        const exonEnd = Number(exon.end)
                        const segments = getTranscriptExonSegments({ exonStart, exonEnd, cdsList })
                        if (segments.length === 0) continue

                        // Exon coordinates are inclusive, so a segment has to cover its
                        // last base too — getGenomicIntervalPixelBounds maps start..end
                        // to [x(start), x(end + 1)). At base-level zoom it also snaps to
                        // the same base grid as the sequence track.
                        const segPxPerBp = 1 / Math.max(1e-9, bpPerPx)
                        const snapSegToBaseGrid = viewSpan <= 1000 && segPxPerBp >= 2

                        for (const seg of segments) {
                            const segBounds = getGenomicIntervalPixelBounds(seg.start, seg.end, segPxPerBp, snapSegToBaseGrid)
                            if (!segBounds) continue
                            const sx1 = segBounds.x1
                            const sx2 = segBounds.x2
                            const segW = Math.max(1, sx2 - sx1)
                            const strokeInset = exonStrokeWidth / 2
                            const drawX = sx1 + strokeInset
                            const drawY = detailedExonY + strokeInset
                            const drawW = Math.max(0.5, segW - exonStrokeWidth)
                            const drawH = Math.max(0.5, transcriptLayoutMetrics.exonHeight - exonStrokeWidth)

                            // Hide intron line beneath exon boxes so it only shows in intronic sequence.
                            ctx.fillStyle = exonMaskColor
                            ctx.fillRect(sx1, detailedExonY, segW, transcriptLayoutMetrics.exonHeight)

                            // Ghost exons stay hollow even where they code, so a
                            // preview never reads as a drawn transcript.
                            if (seg.coding && !isGhostRow) {
                                ctx.fillStyle = exonColor
                                ctx.fillRect(drawX, drawY, drawW, drawH)
                            }

                            // Outline both coding and non-coding with identical stroke geometry.
                            ctx.strokeStyle = exonColor
                            ctx.lineWidth = exonStrokeWidth
                            ctx.strokeRect(drawX, drawY, drawW, drawH)
                        }

                        const leftBoundaryHighlight = isGhostRow ? null : getBoundaryHighlight(exonStart, 'left')
                        const rightBoundaryHighlight = isGhostRow ? null : getBoundaryHighlight(exonEnd, 'right')
                        if (leftBoundaryHighlight || rightBoundaryHighlight) {
                            const lineTop = detailedExonY - 1
                            const lineBottom = detailedExonY + transcriptLayoutMetrics.exonHeight + 1
                            // Splice boundaries sit on the outer edges of the first and last
                            // bases, so the 3' line belongs at x(exonEnd + 1), not x(exonEnd).
                            // The highlight specs are keyed by genomic coordinate while x1/x2
                            // are visual, so swap them when the panel is flipped.
                            const exonBounds = getGenomicIntervalPixelBounds(exonStart, exonEnd, segPxPerBp, snapSegToBaseGrid)
                            const startEdgeX = isFlipped ? exonBounds?.x2 : exonBounds?.x1
                            const endEdgeX = isFlipped ? exonBounds?.x1 : exonBounds?.x2
                            const drawBoundaryLine = (x, spec) => {
                                if (!spec || !Number.isFinite(x)) return
                                if (x < LHS_WIDTH - 2 || x > viewWidth + 2) return
                                const alpha = clamp(
                                    0.45 + spec.weight * 0.28 + (spec.clicked ? 0.12 : 0) + (spec.hovered ? 0.05 : 0),
                                    0.3,
                                    0.95
                                )
                                ctx.strokeStyle = `rgba(255,255,255,${alpha})`
                                ctx.lineWidth = 1.0 + spec.weight * 0.7 + (spec.clicked ? 0.35 : 0) + (spec.hovered ? 0.2 : 0)
                                ctx.beginPath()
                                ctx.moveTo(x, lineTop)
                                ctx.lineTo(x, lineBottom)
                                ctx.stroke()
                            }
                            drawBoundaryLine(startEdgeX, leftBoundaryHighlight)
                            drawBoundaryLine(endEdgeX, rightBoundaryHighlight)
                        }
                    }

                    ctx.restore()
                    txIdx++
                }
            } else if (geneWidth > 3) {
                // Simple block rendering (no transcript detail available or gene is small)
                const midY = baseGeneY + transcriptLayoutMetrics.midOffset
                const blockH = compressedGeneBlockHeight

                // Drawn as a block there is no row to single out, so any hovered or
                // pinned transcript lights the whole gene: it is all the browser can
                // truthfully say about where that transcript lives.
                if (highlightTranscriptId) {
                    ctx.fillStyle = colors.selectedGene
                    ctx.fillRect(
                        gx1 - 2,
                        baseGeneY,
                        geneWidth + 4,
                        transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
                    )
                }

                ctx.fillStyle = exonColor
                // Arrow shape for strand direction
                if (geneWidth > 15) {
                    const arrowSize = compressTranscripts
                        ? Math.min(4, geneWidth * 0.12)
                        : Math.min(6, geneWidth * 0.15)
                    const visuallyForward = rawGx1 <= rawGx2 ? (gene.strand === '+') : (gene.strand === '-')
                    ctx.beginPath()
                    if (visuallyForward) {
                        ctx.moveTo(gx1, midY - blockH / 2)
                        ctx.lineTo(gx2 - arrowSize, midY - blockH / 2)
                        ctx.lineTo(gx2, midY)
                        ctx.lineTo(gx2 - arrowSize, midY + blockH / 2)
                        ctx.lineTo(gx1, midY + blockH / 2)
                    } else {
                        ctx.moveTo(gx1 + arrowSize, midY - blockH / 2)
                        ctx.lineTo(gx2, midY - blockH / 2)
                        ctx.lineTo(gx2, midY + blockH / 2)
                        ctx.lineTo(gx1 + arrowSize, midY + blockH / 2)
                        ctx.lineTo(gx1, midY)
                    }
                    ctx.closePath()
                    ctx.fill()
                } else {
                    ctx.fillRect(gx1, midY - blockH / 2, geneWidth, blockH)
                }
            } else {
                // Very tiny: just a tick mark
                const midY = baseGeneY + transcriptLayoutMetrics.midOffset
                ctx.fillStyle = exonColor
                ctx.fillRect(gx1, midY - compressedGeneBlockHeight / 2, Math.max(1, geneWidth), compressedGeneBlockHeight)
            }

            const labelText = gene.name || gene.id
            // Expanded labels are HTML so the label and its X remain one
            // horizontal unit both while following the viewport and after
            // settling beneath the final transcript.
            const hasExpandedFooterOverlay = expandedFooterGeneIds.has(String(gene.id))
            if (labelText && !hasExpandedFooterOverlay) {
                ctx.font = LABEL_FONT
                const candidate = buildGeneLabelCandidate({
                    gene,
                    trackId,
                    trackOrder,
                    trackY,
                    layout,
                    transcriptLayoutMetrics,
                    selectedGene,
                    dimNonSelectedGenes,
                    isLight,
                    colors,
                    geneLabelColor,
                    genomicToScreen,
                    viewWidth,
                    txs,
                    getEffectiveTranscriptLimit,
                    visibleTranscriptCount: rowCount,
                    measureTextWidth: (text) => ctx.measureText(text).width,
                    lhsWidth: LHS_WIDTH,
                    order: geneLabelOrder++,
                    footerStyleEnabled: !isCompressedLayoutActive && !flattenTracks,
                })
                if (candidate) geneLabelCandidates.push(candidate)
            }
        }

        // Render forward strand genes
        for (const gene of layout.forwardGenes) {
            renderGene(gene, FORWARD_Y, 'forward', 0)
        }

        // Render reverse strand genes
        for (const gene of layout.reverseGenes) {
            renderGene(gene, REVERSE_Y, 'reverse', 1)
        }

        ctx.font = LABEL_FONT
        ctx.textBaseline = 'alphabetic'
        for (const label of placeNonOverlappingGeneLabels(geneLabelCandidates)) {
            // A label belongs to its track. Drawn into the ruler it is unreadable over the
            // ticks and takes the ticks with it, which is what a compact panel makes
            // possible: the ruler sits immediately after the last track, so a few pixels of
            // overflow land on it rather than in a margin.
            if (intersectsRuler(label.y - LABEL_ASCENT_PX, label.y + LABEL_DESCENT_PX, RULER_Y, effectiveRulerHeight)) continue
            ctx.fillStyle = label.fill || colors.geneLabelText
            ctx.textAlign = label.textAlign || 'center'
            ctx.fillText(label.text, label.x, label.y)
        }
        ctx.textAlign = 'center'

        // ---- Selected Gene Focus Lines ----
        const drawFocusLine = (x) => {
            ctx.strokeStyle = colors.focusLine
            ctx.lineWidth = 1.5
            ctx.beginPath()
            if (effectiveRulerPosition === 'top') {
                ctx.moveTo(x, RULER_Y + effectiveRulerHeight)
                ctx.lineTo(x, canvasHeight)
            } else {
                ctx.moveTo(x, 0)
                ctx.lineTo(x, RULER_Y)
            }
            ctx.stroke()
        }

        ctx.setLineDash([6, 3])
        if (isAligned && alignData) {
            // In alignment mode, focus lines indicate alignment boundaries, not selected-gene bounds.
            const overlayToScreenEdge = (overlayPos) => {
                if (isFlipped) {
                    return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
                }
                return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
            }
            drawFocusLine(overlayToScreenEdge(0))
            drawFocusLine(overlayToScreenEdge(alignData.sequence.length))
        } else {
            const isSelectedGeneHidden = selectedGene && ((selectedGene.strand === '+' && effectiveHiddenStrands.forward) || (selectedGene.strand === '-' && effectiveHiddenStrands.reverse))
            const selectedCoords = getGeneCoordRange(selectedGene)
            if (selectedGene && selectedCoords && !isSelectedGeneHidden) {
                drawFocusLine(genomicToScreen(selectedCoords.start))
                drawFocusLine(genomicToScreen(selectedCoords.end))
            } else if (isLocationFocusVisible && focusLocationRange) {
                // The location of focus bounds itself, so it needs no strand or
                // biotype test — only its own edges.
                drawFocusLine(genomicToScreen(focusLocationRange.start))
                drawFocusLine(genomicToScreen(focusLocationRange.end))
            }
        }
        ctx.setLineDash([])

        // ---- LHS Standard Track Bar ----
        ctx.fillStyle = isLight ? '#f8f9fa' : '#1a1b1e' // Block out the underlying tracks
        if (effectiveRulerPosition === 'top') {
            ctx.fillRect(0, RULER_Y + effectiveRulerHeight, LHS_WIDTH, Math.max(0, canvasHeight - effectiveRulerHeight))
        } else {
            ctx.fillRect(0, 0, LHS_WIDTH, RULER_Y)
        }

        const drawSidebarHighlight = (y, h, trackId) => {
            // Base background
            const isHidden = (trackId === 'forward' && effectiveHiddenStrands.forward) ||
                (trackId === 'reverse' && effectiveHiddenStrands.reverse) ||
                (trackId === 'sequence' && effectiveHiddenStrands.sequence) ||
                (isCustomTrackId(trackId) && !(customTracksById.get(trackId)?.visible))

            if (isHidden) {
                ctx.fillStyle = isLight ? '#e9ecef' : '#141517'
                ctx.fillRect(0, y, LHS_WIDTH, h)
            } else {
                ctx.fillStyle = getBgColor(trackId)
                ctx.fillRect(0, y, LHS_WIDTH, h)
            }

            if (draggingTrack === trackId) {
                ctx.fillStyle = colors.selectedGene
                ctx.fillRect(0, y, LHS_WIDTH, h)
            } else if (hoveredTrack === trackId && draggingTrack !== trackId) {
                // High contrast highlight for hover drop targets
                ctx.fillStyle = isLight ? '#ced4da' : '#373a40'
                ctx.fillRect(0, y, LHS_WIDTH, h)
            }
        }

        drawSidebarHighlight(FORWARD_Y, forwardBgHeight, 'forward')
        drawSidebarHighlight(REVERSE_Y, reverseBgHeight, 'reverse')
        if (showSequenceTrack) {
            drawSidebarHighlight(SEQUENCE_Y, seqBgHeight, 'sequence')
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            if (trackLayout.joinedRowId) continue
            drawSidebarHighlight(trackLayout.y, trackLayout.height, trackId)
        }
        for (const [rowId, rowLayout] of Object.entries(layout.groupRowLayouts || {})) {
            drawSidebarHighlight(rowLayout.y, rowLayout.height, rowId)
        }
        ctx.strokeStyle = colors.gutterLine
        ctx.lineWidth = 1
        ctx.beginPath()
        if (effectiveRulerPosition === 'top') {
            ctx.moveTo(LHS_WIDTH, RULER_Y + effectiveRulerHeight)
            ctx.lineTo(LHS_WIDTH, canvasHeight)
        } else {
            ctx.moveTo(LHS_WIDTH, 0)
            ctx.lineTo(LHS_WIDTH, RULER_Y)
        }
        ctx.stroke()

        ctx.fillStyle = colors.trackLabel
        ctx.font = sansFont(11)
        ctx.textAlign = 'center'

        // Render circular power toggle with panel-specific active color.
        const drawToggle = (x, rawY, isHidden, label, trackId, isCustomTrack = false) => {
            // A track of odd height centres on a half pixel, which the label and the
            // glyph then round differently. One whole-pixel centre keeps them level.
            const y = Math.round(rawY)
            const active = !isHidden
            const iconColor = sidebarToggleIconColor(active)
            const labelColor = isLight ? '#64748b' : '#cbd5e1'

            // Draw label to the left of toggle.
            ctx.fillStyle = (draggingTrack === trackId) ? '#ffffff' : labelColor
            ctx.textAlign = 'right'
            const labelX = x - (SIDEBAR_TOGGLE_ICON_SIZE / 2) - SIDEBAR_TOGGLE_LABEL_GAP
            // Marked on the track itself, so a reverse-complemented strand is never
            // read as the usual one. The two lines are centred on the toggle as a pair.
            const showRc = isFlipped && (isCustomTrack || REVERSE_COMPLEMENTED_TRACK_IDS.has(trackId))
            const labelBaseline = y + 4 - (showRc ? SIDEBAR_RC_HALF_GAP : 0)
            if (showRc) {
                // Both lines centred on one column — RC's centre where it would sit
                // right-aligned — so a label narrower than "RC" (SL) sits over its middle.
                const columnX = labelX - ctx.measureText('RC').width / 2
                ctx.save()
                ctx.textAlign = 'center'
                ctx.fillText(label, columnX, labelBaseline)
                ctx.fillStyle = panelPillColor
                ctx.fillText('RC', columnX, labelBaseline + SIDEBAR_RC_LINE_GAP)
                ctx.restore()
            } else {
                ctx.fillText(label, labelX, labelBaseline)
            }
            ctx.textAlign = 'center'

            // Stroked, not filled, and with no disc behind it: the glyph's own
            // colour carries the on/off state, and its line weight is set
            // independently of its size so the stem stays legible.
            if (drawPowerGlyph(ctx, x, y, { size: SIDEBAR_TOGGLE_ICON_SIZE, color: iconColor })) return

            // Fallback where Path2D is unavailable.
            const ringRadius = (SIDEBAR_TOGGLE_ICON_SIZE / 2) - 1.7
            ctx.strokeStyle = iconColor
            ctx.lineWidth = 1.8
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.arc(x, y + 1.2, ringRadius, -Math.PI * 0.34, Math.PI * 1.34)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(x, y - ringRadius - 1.4)
            ctx.lineTo(x, y - 0.2)
            ctx.stroke()
        }

        // Fwd toggle — only when track is in layout (height > 0)
        if (forwardBgHeight > 0) {
            const fwdLabelY = FORWARD_Y + forwardBgHeight / 2
            drawToggle(LHS_WIDTH - 13, fwdLabelY, effectiveHiddenStrands.forward, 'GF', 'forward')
        }

        // Rev toggle — only when track is in layout (height > 0)
        if (reverseBgHeight > 0) {
            const revLabelY = REVERSE_Y + reverseBgHeight / 2
            drawToggle(LHS_WIDTH - 13, revLabelY, effectiveHiddenStrands.reverse, 'GR', 'reverse')
        }

        // Seq toggle — only when track is in layout (SEQUENCE_Y >= 0)
        if (showSequenceTrack && SEQUENCE_Y >= 0) {
            const seqLabelY = SEQUENCE_Y + seqBgHeight / 2
            drawToggle(LHS_WIDTH - 13, seqLabelY, effectiveHiddenStrands.sequence, sequenceTrackLabel, 'sequence')
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            if (trackLayout.joinedRowId) continue
            const track = customTracksById.get(trackId)
            const hidden = !(track?.visible)
            const labelY = getCustomTrackToggleY(trackLayout)
            // CG: one of a track group's tracks, shown on its own row.
            drawToggle(LHS_WIDTH - 13, labelY, hidden, track?.group ? 'CG' : 'CT', trackId, true)
        }
        for (const [rowId, rowLayout] of Object.entries(layout.groupRowLayouts || {})) {
            drawToggle(LHS_WIDTH - 13, getCustomTrackToggleY(rowLayout), rowLayout.hidden, 'CG', rowId, true)
        }

        // ---- Sequence Track ----
        if (showSequenceTrack && !effectiveHiddenStrands.sequence) {
            const seqY = SEQUENCE_Y
            const seqTrackViewH = seqBgHeight

            const pxPerBp = trackWidth / viewSpan
            // The view can start part-way through a base, so the first base is partly
            // off the left edge; keep it out of the label gutter.
            ctx.save()
            ctx.beginPath()
            ctx.rect(LHS_WIDTH, seqY, viewWidth - LHS_WIDTH, seqTrackViewH)
            ctx.clip()
            if (isAligned && alignData && viewSpan <= 1000) {
                if (pxPerBp >= 2) {
                    ctx.font = pxPerBp >= 10 ? monoFont(12) : monoFont(9)
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'

                    const startIdx = Math.floor(viewStart)
                    const endIdx = Math.ceil(viewEnd)
                    const alnLen = alignData.sequence.length

                    for (let i = startIdx; i < endIdx; i++) {
                        let base = null
                        if (i >= 0 && i < alnLen) {
                            base = alignData.sequence[i]
                        } else if (sequence && seqRange) {
                            const genomicBp = Math.round(overlayToGenomic(i))
                            const seqIdx = genomicBp - seqRange.start
                            if (seqIdx >= 0 && seqIdx < sequence.length) {
                                base = sequence[seqIdx]
                                if (alignData.strand === '-') {
                                    base = REV_COMP[base] || base
                                }
                            }
                        }
                        if (!base) continue

                        const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                        const { bxL, bxR, bxW } = getBasePixelBounds(i, pxPerBp)
                        const seqBoxT = Math.round(seqY + 6)
                        const seqBoxH = 24
                        const alignedBp = Math.round(overlayToGenomic(i))
                        ctx.fillStyle = displayBase === '-' ? '#95a5a6' : getBaseColor(displayBase, colors)
                        ctx.fillRect(bxL, seqBoxT, bxW, seqBoxH)
                        if (pxPerBp >= 6 && bxW >= 2) {
                            // 0.5 snap keeps 1px separators crisp on canvas.
                            const sepX = bxR - 0.5
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)'
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(sepX, seqBoxT + 0.5)
                            ctx.lineTo(sepX, seqBoxT + seqBoxH - 0.5)
                            ctx.stroke()
                        }
                        // Hover outline
                        if (hoveredSeqBase?.bp === alignedBp && bxW >= 2) {
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'
                            ctx.lineWidth = 2
                            ctx.strokeRect(bxL + 1, seqBoxT + 1, Math.max(0, bxW - 2), seqBoxH - 2)
                        }
                        if (pxPerBp >= 10) {
                            ctx.fillStyle = '#ffffff'
                            ctx.fillText(displayBase.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
                        }
                    }
                    ctx.textBaseline = 'alphabetic'
                }
            } else if (sequence && seqRange && viewSpan <= 1000) {
                if (pxPerBp >= 2) {
                    ctx.font = pxPerBp >= 10 ? monoFont(12) : monoFont(9)
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'
                    for (let i = 0; i < sequence.length; i++) {
                        const bp = seqRange.start + i
                        if (bp + 1 <= viewStart || bp >= viewEnd) continue
                        const base = sequence[i]
                        const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                        const { bxL, bxR, bxW } = getBasePixelBounds(bp, pxPerBp)
                        const seqBoxT = Math.round(seqY + 6)
                        const seqBoxH = 24
                        ctx.fillStyle = getBaseColor(displayBase, colors)
                        ctx.fillRect(bxL, seqBoxT, bxW, seqBoxH)
                        if (pxPerBp >= 6 && bxW >= 2) {
                            const sepX = bxR - 0.5
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)'
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(sepX, seqBoxT + 0.5)
                            ctx.lineTo(sepX, seqBoxT + seqBoxH - 0.5)
                            ctx.stroke()
                        }
                        // Hover outline
                        if (hoveredSeqBase?.bp === bp && bxW >= 2) {
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'
                            ctx.lineWidth = 2
                            ctx.strokeRect(bxL + 1, seqBoxT + 1, Math.max(0, bxW - 2), seqBoxH - 2)
                        }
                        if (pxPerBp >= 10) {
                            ctx.fillStyle = '#ffffff'
                            ctx.fillText(displayBase.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
                        }
                    }
                    ctx.textBaseline = 'alphabetic'
                }
            } else {
                // Not zoomed in enough — always show a hint so the track is never blank
                const trackW = viewWidth - LHS_WIDTH
                ctx.fillStyle = isLight ? '#868e96' : '#5c5f66'
                ctx.font = sansFont(9)
                ctx.textAlign = 'center'
                ctx.fillText('zoom in to see sequence', LHS_WIDTH + trackW / 2, seqY + seqTrackViewH / 2 + 4)
            }
            ctx.restore()
        }

        // ---- Custom BigWig Tracks ----
        // Drawn in genomic order and mirrored when the panel is flipped; see
        // beginCanvasMirror. screenX places panel furniture (the value axis) at a
        // fixed spot on screen from inside the mirror.
        const customMirrorAxis = LHS_WIDTH + viewWidth
        const screenX = (x) => (isFlipped ? customMirrorAxis - x : x)
        if (isFlipped) beginCanvasMirror(ctx, customMirrorAxis)
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue

            const left = LHS_WIDTH + 2
            const right = viewWidth - 2
            const width = Math.max(1, right - left)
            const trackType = track.type || 'bigwig'
            const bigWigSettings = trackType === 'bigwig'
                ? normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings)
                : null
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, bigWigSettings?.data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const vcfSettings = trackType === 'vcf'
                ? normalizeVcfSettings(track?.vcfSettings || track?.vcf_settings)
                : null
            const vcfGenicColor = vcfSettings?.genic_color || VCF_SETTINGS_DEFAULTS.genic_color
            const vcfIntergenicColor = vcfSettings?.intergenic_color || VCF_SETTINGS_DEFAULTS.intergenic_color
            const data = customTrackData[trackId]
            const { top, bottom, plotHeight, labelY } = getCustomTrackGeometry(trackLayout, renderMode, trackType, data)
            const isLoading = !!customTrackLoading[trackId]
            const coverage = typeof data?.coverage === 'number' ? data.coverage : 0

            // Persistent label near the track edge (above for secondary, below for primary zoned mode).
            const labelX = LHS_WIDTH + 8
            const labelText = track.label || 'Custom track'
            ctx.save()
            ctx.font = sansFont(11)
            ctx.fillStyle = isLight ? '#1e3a8a' : '#93c5fd'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            fillScreenText(ctx, customMirrorAxis, labelText, labelX, labelY)
            ctx.restore()

            const isDiscreteTrack = ['vcf', 'splice_junctions', 'long_reads'].includes(trackType) || isIntervalTrackType(trackType)

            if (isDiscreteTrack) {
                if (!data || (data.error && !data.has_data)) {
                    if (data?.error && !data?.has_data) {
                        ctx.fillStyle = isLight ? '#b91c1c' : '#fca5a5'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText(data.error.substring(0, 80), left + width / 2, top + plotHeight / 2 + 3)
                    } else if (isLoading) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight / 2 + 3)
                    }
                    continue
                }

                const dataStart = data.start ?? viewStart
                const dataEnd = data.end ?? viewEnd
                const dataSpan = Math.max(1, dataEnd - dataStart)

                // Helper: genomic coord → canvas x (absolute, not relative to left)
                const gToX = (g) => left + ((g - dataStart) / dataSpan) * width

                if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode) && data?.mode === 'adp_detail') {
                    // L4 individual variant rendering
                    const variants = Array.isArray(data?.variants) ? data.variants : []
                    const barH = Math.max(5, Math.floor(plotHeight * 0.13))
                    const barY = top + Math.floor((plotHeight - barH) / 2)
                    const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width
                    const hb = hoveredVcfBlock
                    // Colorblind-safe: blue (SNV), green (ins), amber (del)
                    const VARIANT_FILL = {
                        snv:   isLight ? '#4a7cf5' : '#7ab4fc',
                        ins:   isLight ? '#16a34a' : '#4ade80',
                        del:   isLight ? '#d97706' : '#fbbf24',
                        indel: isLight ? '#9333ea' : '#c084fc',
                    }
	                    const VARIANT_STROKE = {
	                        snv:   isLight ? 'rgba(30,60,160,0.75)'  : 'rgba(120,170,255,0.65)',
	                        ins:   isLight ? 'rgba(10,100,30,0.75)'  : 'rgba(100,220,130,0.65)',
	                        del:   isLight ? 'rgba(150,80,0,0.75)'   : 'rgba(250,180,50,0.65)',
	                        indel: isLight ? 'rgba(100,20,160,0.75)' : 'rgba(190,100,250,0.65)',
	                    }
	                    const ANCHOR_FILL_ACTIVE = isLight ? '#3b82f6' : '#60a5fa'
	                    const ANCHOR_STROKE = isLight ? 'rgba(30,64,175,0.9)' : 'rgba(191,219,254,0.95)'
	                    const drawAnchorIcon = (cx, cy, boxH, boxW) => {
	                        const img = anchorIconImgRef.current
	                        if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
	                        // Fill the anchor block with icon detail while leaving a tiny border.
	                        const margin = 0.5
	                        const targetH = Math.max(4, boxH - margin * 2)
	                        const targetW = Math.max(4, Math.min(boxW - margin * 2, targetH * 1.05))
	                        const iH = Math.max(4, targetH * 0.9)
	                        const iW = Math.max(4, targetW * 0.9)
	                        const x = cx - (iW / 2)
	                        const y = cy - (iH / 2)
	                        ctx.save()
	                        ctx.imageSmoothingEnabled = true
	                        ctx.drawImage(img, x, y, iW, iH)
	                        ctx.restore()
	                    }
	                    // Indel dashed markers: show at ≤1 bp/px; labels only when sequence boxes visible (≤0.5 bp/px)
	                    const showIndelMarkers = bpPerPx <= 1
	                    const showIndelLabels = bpPerPx <= 0.5
                    const cvPos = clickedVcfVariant?.variant?.pos
                    const cvType = clickedVcfVariant ? localVcfType(clickedVcfVariant.variant) : null

                    // Position-based genic check: consistent with L0-L3 block_spans coloring.
                    // Prefilter to genes visible in this view to keep the inner check cheap.
                    const viewGenicGenes = !isAligned
                        ? genes.filter(g => Number(g.end) >= viewStart && Number(g.start) <= viewEnd)
                        : []
                    const isPosiGenic = (pos) =>
                        viewGenicGenes.some(g => Number(g.start) <= pos && Number(g.end) >= pos)

                    ctx.save()

                    // ── Reference bases: unfilled outlined boxes for positions with no SNV variant ──
                    if (bpPerPx <= 1) {
                        const occupiedPos = new Set(
                            variants
                                .filter(v => localVcfType(v) === 'snv')
                                .map(v => Number(v?.pos))
                                .filter(Number.isFinite)
                        )
                        for (let bp = Math.floor(viewStart); bp <= Math.ceil(viewEnd); bp++) {
                            if (occupiedPos.has(bp)) continue
                            const bxL = blockGToX(bp)
                            const bxR = blockGToX(bp + 1)
                            const drawL = Math.max(left, bxL)
                            const drawR = Math.min(right, bxR)
                            const drawW = drawR - drawL
                            if (drawW <= 0) continue
                            const regionColor = isPosiGenic(bp)
                                ? vcfGenicColor : vcfIntergenicColor
                            ctx.strokeStyle = regionColor
                            ctx.lineWidth = 1
                            ctx.strokeRect(drawL + 0.5, barY + 0.5, Math.max(0, drawW - 1), barH - 1)
                        }
                    }

                    // ── Pass 1: build indelItems, deduplicating multi-allelic split rows ──
                    const indelItems = []
                    if (showIndelMarkers) {
                        const seenIndel = new Set()
                        for (const v of variants) {
                            const vtype = localVcfType(v)
                            if (vtype === 'snv') continue
	                            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                            const vpos = layoutInfo.vpos
	                            if (!Number.isFinite(vpos)) continue
	                            const key = `${vtype}:${vpos}`
	                            if (seenIndel.has(key)) continue  // already represented
	                            seenIndel.add(key)
	                            const vend = Number(v?.end ?? v?.pos)
                            const nBars = getVcfAltAlleleCount(v)
	                            // Marker placement is type-aware:
	                            // ins = right edge of anchor base, del = center of first deleted base.
	                            const xGenomic = layoutInfo.markerXGenomic
                            const x = blockGToX(Math.max(viewStart, xGenomic))
                            const primaryDir = vtype === 'ins' ? 'up' : 'down'
                            const altDir = primaryDir === 'up' ? 'down' : 'up'
                            let dir = primaryDir
                            let level = 0
                            if (showIndelLabels) {
                                // Bidirectional stagger: pick direction needing least displacement
                                // Proximity accounts for bar width (bars extend right from dot)
                                const MAX_LEVEL = 3
                                let lP = 0, lA = 0
                                for (const existing of indelItems) {
                                    // Right edge of existing's bars vs new dot, and vice versa
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
                            indelItems.push({ v, vpos, vend, x, dir, level, nBars })
                        }
                    }

	                    // ── Pass 2: draw variant blocks — non-active first, active on top ──
	                    const drawBlock = (v, topPass) => {
	                        const vtype = localVcfType(v)
	                        const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                        const vpos = layoutInfo.vpos
	                        if (!Number.isFinite(vpos)) return
	                        const visibleStart = Math.min(layoutInfo.anchorStart, layoutInfo.refStart)
	                        const visibleEnd = Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
	                        if (visibleStart > viewEnd || visibleEnd < viewStart) return
	                        const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
	                        const isClicked = cvPos === vpos && cvType === vtype
	                        const active = isHovered || isClicked
	                        if (topPass !== active) return  // each block drawn in exactly one pass
	                        const activeStroke = isClicked
	                            ? (isLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,1.0)')
	                            : isHovered
	                                ? (isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)')
	                                : null
	                        const drawSegment = (segStart, segEnd, fillColor, strokeColor, alpha = 0.9) => {
	                            if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return null
	                            const x1 = blockGToX(Math.max(viewStart, segStart))
	                            const x2 = blockGToX(Math.min(viewEnd, segEnd))
	                            const drawStart = Math.max(left, Math.min(x1, x2))
	                            const drawEnd = Math.min(right, Math.max(x1, x2))
	                            const drawW = drawEnd - drawStart
	                            if (drawW <= 0) return null
	                            ctx.fillStyle = fillColor
	                            ctx.globalAlpha = alpha
	                            ctx.fillRect(drawStart, barY, Math.max(1, drawW), barH)
	                            ctx.globalAlpha = 1
	                            ctx.strokeStyle = activeStroke || strokeColor
	                            ctx.lineWidth = isClicked ? 2.5 : isHovered ? 2 : 1
	                            ctx.strokeRect(drawStart + 0.5, barY + 0.5, Math.max(0.5, drawW - 1), barH - 1)
	                            return { drawStart, drawW }
	                        }

	                        if (vtype === 'ins' || vtype === 'del') {
	                            if (vtype === 'del' && layoutInfo.hasDelSpan) {
	                                drawSegment(
	                                    layoutInfo.refStart,
	                                    layoutInfo.refEnd,
	                                    VARIANT_FILL.del,
	                                    VARIANT_STROKE.del
	                                )
	                            }
                            // Anchor base is only visible for hovered/clicked INS/DEL.
                            if (shouldRenderActiveAnchorBase(vtype, active)) {
                                const anchorSeg = drawSegment(
                                    layoutInfo.anchorStart,
                                    layoutInfo.anchorEnd,
                                    ANCHOR_FILL_ACTIVE,
	                                    ANCHOR_STROKE,
	                                    1
	                                )
	                                if (anchorSeg) {
	                                    const anchorCx = anchorSeg.drawStart + (anchorSeg.drawW / 2)
	                                    drawAnchorIcon(anchorCx, barY + barH / 2, barH, anchorSeg.drawW)
	                                }
	                            }
	                            return
	                        }

	                        // SNV/indel blocks represent REF sequence span on genome.
	                        const seg = drawSegment(
	                            layoutInfo.refStart,
	                            layoutInfo.refEnd,
	                            vtype === 'snv'
	                                ? (isPosiGenic(vpos) ? vcfGenicColor : vcfIntergenicColor)
	                                : (VARIANT_FILL[vtype] || (isLight ? '#64748b' : '#94a3b8')),
	                            vtype === 'snv'
	                                ? (isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)')
	                                : (VARIANT_STROKE[vtype] || (isLight ? 'rgba(60,60,60,0.6)' : 'rgba(200,200,200,0.5)'))
	                        )
	                        if (!seg) return

	                        // SNV label above block — omit ins/del labels (dashed markers do that job)
	                        if (vtype === 'snv' && seg.drawW >= 14) {
	                            ctx.font = sansFont(9)
	                            ctx.textAlign = 'center'
	                            ctx.fillStyle = active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#1e3a8a' : '#93c5fd')
	                            ctx.fillText(v.label || 'SNV', seg.drawStart + seg.drawW / 2, barY - 4)
	                        }
	                    }
                    // Base pass: del/indel first, then SNVs so SNVs paint over by default
                    for (const v of variants) if (localVcfType(v) !== 'snv') drawBlock(v, false)
                    for (const v of variants) if (localVcfType(v) === 'snv') drawBlock(v, false)
                    for (const v of variants) drawBlock(v, true)   // top pass (hovered/clicked on top)

                    // ── Pass 3: draw indel dashed-line markers ────────────────────────
                    if (showIndelMarkers) {
                        for (const { v, vpos, x, dir, level, nBars } of indelItems) {
                            if (vpos > viewEnd || vpos < viewStart) continue
                            const vtype = localVcfType(v)
                            const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
                            const isClicked = cvPos === vpos && cvType === vtype
                            const active = isHovered || isClicked
                            const dotColor = VARIANT_FILL[vtype] || '#888'
                            const lineBaseLen = showIndelLabels ? 29 : 22
                            const lineLen = lineBaseLen + level * 18

                            ctx.save()

                            // Dashed vertical line
                            ctx.setLineDash([3, 3])
                            ctx.strokeStyle = isLight ? 'rgba(80,80,80,0.55)' : 'rgba(200,200,200,0.5)'
                            ctx.lineWidth = active ? 1.5 : 1
                            ctx.beginPath()
                            if (dir === 'up') { ctx.moveTo(x, barY); ctx.lineTo(x, barY - lineLen) }
                            else { ctx.moveTo(x, barY + barH); ctx.lineTo(x, barY + barH + lineLen) }
                            ctx.stroke()
                            ctx.setLineDash([])

                            // Dot
                            const dotY = dir === 'up' ? barY - lineLen : barY + barH + lineLen
                            const dotR = active ? 5 : 4
                            ctx.fillStyle = dotColor
                            ctx.beginPath()
                            ctx.arc(x, dotY, dotR, 0, Math.PI * 2)
                            ctx.fill()
                            ctx.strokeStyle = active
                                ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)')
                                : (isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)')
                            ctx.lineWidth = active ? 1.5 : 1
                            ctx.stroke()

                            // Allele-count bars + label — only when fully zoomed in
                            if (showIndelLabels) {
                                const abH = 3        // bar height px
                                const abLen = 12     // bar length px
                                const abGap = 2      // horizontal gap between bars
                                const abStartX = x + dotR + 3
                                const abY = dir === 'up'
                                    ? Math.min(dotY + dotR + 3, barY - abH - 5)
                                    : Math.max(barY + barH + 5, dotY - dotR - abH - 3)
                                ctx.globalAlpha = active ? 0.85 : 0.55
                                ctx.fillStyle = dotColor
                                for (let i = 0; i < nBars; i++) {
                                    ctx.fillRect(abStartX + i * (abLen + abGap), abY, abLen, abH)
                                }
                                ctx.globalAlpha = 1

                                const label = vtype === 'ins' ? 'ins' : vtype === 'del' ? 'del' : 'indel'
                                ctx.fillStyle = active
                                    ? (isLight ? '#111827' : '#f9fafb')
                                    : (isLight ? '#374151' : '#d1d5db')
                                ctx.font = active ? sansFont(9, 'bold') : sansFont(9)
                                ctx.textAlign = 'left'
                                ctx.fillText(label, x + dotR + 3, dotY + 3)
                            }

                            ctx.restore()
                        }
                    }

                    if (isLoading && variants.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                    const spans = Array.isArray(data?.block_spans) ? data.block_spans : []
                    if (renderMode === 'adaptive') {
                        const barH = Math.max(3, Math.floor(plotHeight * 0.18))
                        const barY = top + Math.floor((plotHeight - barH) / 2)

                        // Always map block genomic coords to the CURRENT viewport (viewStart/viewEnd),
                        // not data.start/data.end — prevents blocks sticking during pan.
                        const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width

                        // Show outlines when zoomed in enough that individual blocks are wide
                        const showOutlines = bpPerPx < 2

                        ctx.save()
                        ctx.strokeStyle = isLight ? 'rgba(120, 135, 155, 0.3)' : 'rgba(133, 151, 170, 0.26)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, barY + barH / 2)
                        ctx.lineTo(right, barY + barH / 2)
                        ctx.stroke()

                        const hb = hoveredVcfBlock
                        for (const rawSpan of spans) {
                            const s = Number(rawSpan?.start)
                            const e = Number(rawSpan?.end)
                            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                            if (e <= viewStart || s >= viewEnd) continue
                            const x1 = blockGToX(Math.max(viewStart, s))
                            const x2 = blockGToX(Math.min(viewEnd, e))
                            const drawStart = Math.max(left, Math.min(x1, x2))
                            const drawEnd = Math.min(right, Math.max(x1, x2))
                            const drawW = drawEnd - drawStart
                            if (drawW <= 0) continue
                            const cls = rawSpan?.class_name === 'genic' ? 'genic' : 'intergenic'
                            const isHovered = hb?.trackId === trackId && hb?.start === s && hb?.end === e
                            ctx.fillStyle = cls === 'genic' ? vcfGenicColor : vcfIntergenicColor
                            ctx.fillRect(drawStart, barY, Math.max(1, drawW), barH)
                            if (isHovered || (showOutlines && drawW > 2)) {
                                ctx.strokeStyle = isHovered
                                    ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)')
                                    : (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.2)')
                                ctx.lineWidth = isHovered ? 2 : 0.5
                                ctx.strokeRect(drawStart + 0.5, barY + 0.5, Math.max(0, drawW - 1), barH - 1)
                            }
                        }
                        ctx.restore()

                        if (isLoading && spans.length === 0) {
                            ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                            ctx.font = sansFont(10)
                            ctx.textAlign = 'center'
                            ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                        }
                        continue
                    }

                    // Density-Lollipop coarse mode: enrichment profile with genic/intergenic coloring.
                    const densityBins = Array.isArray(data?.density_bins) ? data.density_bins : []
                    const densityClasses = Array.isArray(data?.density_classes) ? data.density_classes : []
                    const binCount = Math.max(0, Math.min(densityBins.length, densityClasses.length))
                    const hasDensitySignal = densityBins.some((v) => Number(v) > 0)
                    const densityHotspots = normalizeVcfDensityForHotspots(densityBins)
                    const baseY = bottom - 2
                    const peakY = top + 8
                    const amp = Math.max(6, baseY - peakY)
                    const bw = width / Math.max(1, binCount || 1)

                    ctx.save()
                    ctx.strokeStyle = isLight ? 'rgba(120, 135, 155, 0.25)' : 'rgba(133, 151, 170, 0.2)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, baseY + 0.5)
                    ctx.lineTo(right, baseY + 0.5)
                    ctx.stroke()

                    const runs = []
                    let current = null
                    for (let i = 0; i < binCount; i++) {
                        const rawV = Number(densityHotspots[i])
                        const v = Number.isFinite(rawV) ? Math.max(0, Math.min(1, rawV)) : 0
                        const cls = densityClasses[i] === 'genic' ? 'genic' : 'intergenic'
                        const x = left + (i + 0.5) * bw
                        const y = baseY - Math.max(0, v * amp)
                        if (!current || current.cls !== cls) {
                            if (current && current.points.length > 0) runs.push(current)
                            current = { cls, points: [] }
                        }
                        current.points.push({ x, y })
                    }
                    if (current && current.points.length > 0) runs.push(current)

                    for (const run of runs) {
                        const pts = run.points
                        if (!Array.isArray(pts) || pts.length === 0) continue
                        const color = run.cls === 'genic' ? vcfGenicColor : vcfIntergenicColor
                        const xLeft = Math.max(left, pts[0].x - (bw / 2))
                        const xRight = Math.min(right, pts[pts.length - 1].x + (bw / 2))
                        if (xRight <= xLeft) continue

                        ctx.fillStyle = hexToRgba(color, isLight ? 0.8 : 0.72)
                        if (pts.length === 1) {
                            const barH = Math.max(0, baseY - pts[0].y)
                            if (barH <= 0) continue
                            ctx.fillRect(xLeft, pts[0].y, Math.max(1, xRight - xLeft), barH)
                            ctx.strokeStyle = hexToRgba(color, isLight ? 0.95 : 0.9)
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(xLeft, pts[0].y)
                            ctx.lineTo(xRight, pts[0].y)
                            ctx.stroke()
                            continue
                        }
                        ctx.beginPath()
                        ctx.moveTo(xLeft, baseY)
                        for (let i = 0; i < pts.length; i++) {
                            ctx.lineTo(pts[i].x, pts[i].y)
                        }
                        ctx.lineTo(xRight, baseY)
                        ctx.closePath()
                        ctx.fill()

                        ctx.strokeStyle = hexToRgba(color, isLight ? 0.95 : 0.9)
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(pts[0].x, pts[0].y)
                        for (let i = 1; i < pts.length; i++) {
                            ctx.lineTo(pts[i].x, pts[i].y)
                        }
                        ctx.stroke()
                    }
                    ctx.restore()

                    if (isLoading && !hasDensitySignal) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                // ── Density bins (coarse LOD for any discrete type) ────────────────
                if (Array.isArray(data.bins) && data.bins.length > 0) {
                    // Ensembl-style: continuous teal bar with opacity proportional to density
                    if (renderMode === 'ensembl' && trackType === 'vcf') {
                        const maxCount = data.max_count || Math.max(...data.bins.filter(Number.isFinite)) || 1
                        const bw = width / data.bins.length
                        const barY = top + 2
                        const barH = Math.min(10, plotHeight * 0.3)
                        ctx.save()
                        // Thin baseline
                        ctx.strokeStyle = isLight ? 'rgba(115, 184, 178, 0.3)' : 'rgba(115, 184, 178, 0.2)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, barY + barH / 2 + 0.5)
                        ctx.lineTo(right, barY + barH / 2 + 0.5)
                        ctx.stroke()

                        for (let i = 0; i < data.bins.length; i++) {
                            const v = data.bins[i]
                            if (!v || !Number.isFinite(v)) continue
                            const alpha = Math.min(0.85, 0.15 + (v / maxCount) * 0.7)
                            ctx.fillStyle = isLight
                                ? `rgba(91, 167, 161, ${alpha})`
                                : `rgba(115, 200, 193, ${alpha})`
                            const x = left + i * bw
                            const w = Math.max(1, bw)
                            ctx.fillRect(x, barY, w, barH)
                        }
                        ctx.restore()
                        continue
                    }
                    // Default density bars for non-Ensembl discrete tracks
                    const maxCount = data.max_count || Math.max(...data.bins.filter(Number.isFinite)) || 1
                    const bw = width / data.bins.length
                    const barColor = isLight ? 'rgba(245,158,11,0.7)' : 'rgba(251,191,36,0.55)'
                    ctx.save()
                    ctx.fillStyle = barColor
                    for (let i = 0; i < data.bins.length; i++) {
                        const v = data.bins[i]
                        if (!v || !Number.isFinite(v)) continue
                        const barH = (v / maxCount) * plotHeight
                        ctx.fillRect(left + i * bw, bottom - barH, Math.max(1, bw - 0.5), barH)
                    }
                    ctx.restore()
                    continue
                }

                // ── Fine VCF variants ─────────────────────────────────────────────
                if (trackType === 'vcf' && Array.isArray(data.variants)) {
                    if (renderMode === 'ensembl') {
                        // ─── Ensembl-style VCF rendering ──────────────────────────
                        const tealFill = isLight ? 'rgba(91, 167, 161, 0.7)' : 'rgba(115, 200, 193, 0.55)'
                        const tealStroke = isLight ? 'rgba(70, 140, 134, 0.5)' : 'rgba(90, 170, 163, 0.4)'
                        const insFill = isLight ? 'rgba(59, 130, 246, 0.65)' : 'rgba(96, 165, 250, 0.5)'
                        const delFill = isLight ? 'rgba(239, 68, 68, 0.6)' : 'rgba(248, 113, 113, 0.5)'

                        // Variant block sizing
                        const pxPerBp = width / Math.max(1, dataSpan)
                        const minBlockW = 4
                        const blockH = 8
                        const rowGap = 2
                        const showLabels = pxPerBp > 0.3
                        const labelRowH = showLabels ? 12 : 0
                        const rowH = blockH + rowGap + labelRowH

                        // Rows live entirely inside top→bottom; the ctx.clip below
                        // enforces this even if many rows overflow.
                        const bumpTop = top + 2
                        const bumpBot = bottom

                        // Hard-clip to this track so labels/blocks can never bleed into neighbours
                        ctx.save()
                        ctx.beginPath()
                        ctx.rect(left, top, width, plotHeight)
                        ctx.clip()

                        // Draw thin baseline
                        ctx.strokeStyle = isLight ? 'rgba(115, 184, 178, 0.3)' : 'rgba(115, 184, 178, 0.2)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, bumpTop + blockH / 2 + 0.5)
                        ctx.lineTo(right, bumpTop + blockH / 2 + 0.5)
                        ctx.stroke()

                        // Sort variants by position for bump allocation
                        const sorted = [...data.variants].sort((a, b) => a.pos - b.pos)
                        const blocks = sorted.map(v => {
                            const refLen = v.ref?.length || 1
                            const blockW = Math.max(minBlockW, refLen * pxPerBp)
                            // Insertions land at the RIGHT EDGE of v.pos (boundary to next base)
                            const x = v.type === 'ins' ? gToX(v.pos + 1) : gToX(v.pos)
                            return { v, x, w: blockW, right: x + blockW }
                        }).filter(b => b.right >= left - 2 && b.x <= right + 2)

                        // Greedy bump
                        const maxRows = Math.max(1, Math.floor((bumpBot - bumpTop) / rowH))
                        const rowEnds = new Array(maxRows).fill(-Infinity)
                        const blockRows = blocks.map(b => {
                            for (let r = 0; r < maxRows; r++) {
                                if (b.x > rowEnds[r] + 2) {
                                    rowEnds[r] = b.right
                                    return r
                                }
                            }
                            return 0
                        })

                        // Draw blocks (all clipped to track bounds by ctx.clip above)
                        for (let i = 0; i < blocks.length; i++) {
                            const { v, x, w } = blocks[i]
                            const row = blockRows[i]
                            const bx = Math.max(left, x)
                            const bw = Math.min(right, x + w) - bx
                            if (bw <= 0) continue

                            // Pick colour by type
                            if (v.type === 'ins') ctx.fillStyle = insFill
                            else if (v.type === 'del') ctx.fillStyle = delFill
                            else ctx.fillStyle = tealFill

                            const by = bumpTop + row * rowH
                            // Rounded rectangle
                            const radius = Math.min(2, bw / 2)
                            ctx.beginPath()
                            ctx.moveTo(bx + radius, by)
                            ctx.lineTo(bx + bw - radius, by)
                            ctx.arcTo(bx + bw, by, bx + bw, by + blockH, radius)
                            ctx.lineTo(bx + bw, by + blockH - radius)
                            ctx.arcTo(bx + bw, by + blockH, bx + bw - radius, by + blockH, radius)
                            ctx.lineTo(bx + radius, by + blockH)
                            ctx.arcTo(bx, by + blockH, bx, by + blockH - radius, radius)
                            ctx.lineTo(bx, by + radius)
                            ctx.arcTo(bx, by, bx + radius, by, radius)
                            ctx.fill()

                            // Subtle border
                            ctx.strokeStyle = tealStroke
                            ctx.lineWidth = 0.5
                            ctx.stroke()

                            // Label below block — skip if it would land outside track
                            const labelY = by + blockH + 1
                            if (showLabels && bw > 20 && labelY + labelRowH <= bottom) {
                                const typeLabel = v.type === 'snp' ? 'SNV'
                                    : v.type === 'snv' ? 'SNV'
                                        : v.type === 'ins' ? 'INS'
                                            : v.type === 'del' ? 'DEL'
                                                : v.type?.toUpperCase() || ''
                                ctx.fillStyle = isLight ? '#4b7c78' : '#9ec5c1'
                                ctx.font = sansFont(9)
                                ctx.textAlign = 'center'
                                ctx.textBaseline = 'top'
                                ctx.fillText(typeLabel, bx + bw / 2, labelY)
                            }
                        }
                        ctx.restore()  // removes clip
                        continue
                    }

                    // ── Default lollipop rendering (non-Ensembl VCF) ──────────────
                    const stickColor = isLight ? '#d97706' : '#fbbf24'
                    const headColor = isLight ? '#92400e' : '#fde68a'
                    ctx.save()
                    for (const v of data.variants) {
                        const x = gToX(v.pos)
                        if (x < left - 2 || x > right + 2) continue
                        ctx.strokeStyle = stickColor
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(x, bottom)
                        ctx.lineTo(x, top + 4)
                        ctx.stroke()
                        ctx.fillStyle = headColor
                        ctx.beginPath()
                        ctx.arc(x, top + 4, 3, 0, Math.PI * 2)
                        ctx.fill()
                    }
                    ctx.restore()
                    continue
                }

                if (isIntervalTrackType(trackType) && data?.mode === 'bigbed_blocks' && Array.isArray(data.block_spans)) {
                    const spans = data.block_spans
                    // Spans are genomic and were clipped to the view they were projected
                    // for; placing them against the current view keeps them still while
                    // the next tiles load, rather than stretched to the old one.
                    const viewGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width
                    const trackColors = bedTrackColors(track)
                    const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                    const blockY = top + Math.round((plotHeight - blockH) / 2)

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    for (const span of spans) {
                        const s = Number(span?.start)
                        const e = Number(span?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const x1 = Math.max(left, viewGToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, viewGToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        ctx.fillStyle = bigBedBlockColor(span, isLight, trackColors)
                        ctx.strokeStyle = bigBedBlockStroke(isLight, trackColors)
                        const drawWidth = Math.max(1, drawW)
                        ctx.fillRect(x1, blockY, drawWidth, blockH)
                        if (drawWidth > 2) {
                            ctx.lineWidth = 0.7
                            ctx.strokeRect(x1 + 0.5, blockY + 0.5, Math.max(0.5, drawWidth - 1), Math.max(0.5, blockH - 1))
                        }
                    }
                    ctx.restore()

                    if (isLoading && spans.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                if (isIntervalTrackType(trackType) && data?.mode === 'bigbed_detail' && Array.isArray(data.features)) {
                    const viewGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width
                    const trackColors = bedTrackColors(track)
                    const lanePitch = bigBedLanePitch(data?.labelled)
                    const exonH = BIGBED_DETAIL_EXON_HEIGHT
                    const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                    const maxVisibleLanes = getBigBedLaneCapacity(plotHeight, lanePitch)
                    const hoveredKey = hoveredBigBedFeature?.trackId === trackId ? hoveredBigBedFeature.key : ''
                    const clickedKey = clickedBigBedFeature?.trackId === trackId
                        ? bigBedFeatureKey(clickedBigBedFeature.feature)
                        : ''

                    const visibleFeatures = []
                    let overflowCount = 0
                    for (const feature of data.features) {
                        const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                        if (lane >= maxVisibleLanes) {
                            overflowCount += 1
                            continue
                        }
                        visibleFeatures.push(feature)
                    }
                    visibleFeatures.sort((a, b) =>
                        (Number(a?._lane ?? a?.lane ?? 0) - Number(b?._lane ?? b?.lane ?? 0))
                        || (Number(a?.start || 0) - Number(b?.start || 0))
                        || (Number(a?.end || 0) - Number(b?.end || 0))
                        || bigBedFeatureKey(a).localeCompare(bigBedFeatureKey(b))
                    )

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()
                    const trackBgColor = getBgColor(trackId)

                    for (const feature of visibleFeatures) {
                        const s = Number(feature?.start)
                        const e = Number(feature?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                        const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                        const y = yMid - exonH / 2
                        if (y + exonH < top || y > bottom) continue

                        const x1 = Math.max(left, viewGToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, viewGToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        const key = bigBedFeatureKey(feature)
                        const isFocused = !!clickedKey && key === clickedKey
                        const isHovered = !clickedKey && key === hoveredKey
                        const dimmed = !!clickedKey && !isFocused
                        const color = bigBedFeatureColor(feature, isLight, trackColors)
                        const strokeColor = isFocused
                            ? (isLight ? 'rgba(0,0,0,0.92)' : 'rgba(255,255,255,0.96)')
                            : isHovered
                                ? (isLight ? 'rgba(0,0,0,0.74)' : 'rgba(255,255,255,0.84)')
                                : color.stroke
                        const codingFillColor = isFocused ? color.stroke : color.fill
                        const isTranscript = feature?._render_kind === 'transcript'
                            && feature?._structure_valid === true
                            && Array.isArray(feature?._exon_blocks)
                            && feature._exon_blocks.length > 0

                        ctx.save()
                        ctx.globalAlpha = dimmed ? 0.2 : (isFocused ? 1 : (isHovered ? 1 : 0.86))

                        if (isTranscript) {
                            const txBounds = getCustomTrackIntervalPixelBounds(s, e - 1, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                            const txX1 = txBounds ? Math.max(left, txBounds.x1) : Math.max(left, viewGToX(Math.max(viewStart, s)))
                            const txX2 = txBounds ? Math.min(right, txBounds.x2) : Math.min(right, viewGToX(Math.min(viewEnd, e)))
                            const txDrawW = txX2 - txX1
                            if (txDrawW > 0) {
                                ctx.strokeStyle = strokeColor
                                ctx.lineWidth = INTRON_HEIGHT
                                ctx.beginPath()
                                ctx.moveTo(txX1, yMid + 0.5)
                                ctx.lineTo(txX2, yMid + 0.5)
                                ctx.stroke()
                            }

                            const strand = String(feature?.strand || '.')
                            if ((strand === '+' || strand === '-') && txDrawW >= 30) {
                                const visuallyForward = txX1 <= txX2 ? (strand === '+') : (strand === '-')
                                const chevronColor = isFocused
                                    ? strokeColor
                                    : (isLight ? 'rgba(51,65,85,0.58)' : 'rgba(203,213,225,0.52)')
                                ctx.strokeStyle = chevronColor
                                ctx.lineWidth = 1
                                const spacing = Math.max(20, txDrawW / 15)
                                for (let cx = txX1 + 10; cx <= txX2 - 10; cx += spacing) {
                                    const chevDir = visuallyForward ? 3.4 : -3.4
                                    ctx.beginPath()
                                    ctx.moveTo(cx - chevDir, yMid - 3.3)
                                    ctx.lineTo(cx, yMid)
                                    ctx.lineTo(cx - chevDir, yMid + 3.3)
                                    ctx.stroke()
                                }
                            }

                            ctx.fillStyle = codingFillColor
                            ctx.strokeStyle = strokeColor
                            const exonStrokeWidth = isFocused ? 1.8 : (isHovered ? 1.45 : 1.2)
                            ctx.lineWidth = exonStrokeWidth
                            const exons = Array.isArray(feature?._exon_blocks) ? feature._exon_blocks : []
                            const cdsBlocks = Array.isArray(feature?._cds_blocks) ? feature._cds_blocks : []
                            for (const exon of exons) {
                                const es = Number(exon?.start)
                                // Blocks end exclusively; these renderers and getGenomicIntervalPixelBounds work in
                                // inclusive last bases (as the gene track does), or every exon ran one base long.
                                const ee = Number(exon?.end) - 1
                                if (!Number.isFinite(es) || !Number.isFinite(ee) || ee < es) continue
                                if (ee < viewStart || es >= viewEnd) continue

                                const overlaps = cdsBlocks
                                    .map((cds) => {
                                        const cdsStart = Number(cds?.start)
                                        const cdsEnd = Number(cds?.end) - 1
                                        if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd) || cdsEnd < cdsStart) return null
                                        const overlapStart = Math.max(es, cdsStart)
                                        const overlapEnd = Math.min(ee, cdsEnd)
                                        return overlapEnd >= overlapStart
                                            ? { start: overlapStart, end: overlapEnd }
                                            : null
                                    })
                                    .filter(Boolean)
                                    .sort((a, b) => a.start - b.start)

                                const segments = []
                                let cursor = es
                                for (const coding of overlaps) {
                                    if (coding.start > cursor) {
                                        segments.push({ start: cursor, end: coding.start - 1, coding: false })
                                    }
                                    segments.push({ start: coding.start, end: coding.end, coding: true })
                                    cursor = Math.max(cursor, coding.end + 1)
                                }
                                if (cursor <= ee) {
                                    segments.push({ start: cursor, end: ee, coding: false })
                                }
                                if (segments.length === 0) {
                                    segments.push({ start: es, end: ee, coding: false })
                                }

                                for (const seg of segments) {
                                    const segBounds = getCustomTrackIntervalPixelBounds(seg.start, seg.end, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                                    const sx1 = segBounds ? Math.max(left, segBounds.x1) : Math.max(left, viewGToX(Math.max(viewStart, seg.start)))
                                    const sx2 = segBounds ? Math.min(right, segBounds.x2) : Math.min(right, viewGToX(Math.min(viewEnd, seg.end)))
                                    const segW = sx2 - sx1
                                    if (segW <= 0) continue

                                    const drawH = exonH
                                    const segY = yMid - drawH / 2
                                    const strokeInset = exonStrokeWidth / 2
                                    const drawX = sx1 + strokeInset
                                    const drawY = segY + strokeInset
                                    const boxW = Math.max(0.5, segW - exonStrokeWidth)
                                    const boxH = Math.max(0.5, drawH - exonStrokeWidth)

                                    ctx.fillStyle = trackBgColor
                                    ctx.fillRect(sx1, segY, segW, drawH)
                                    if (seg.coding) {
                                        ctx.fillStyle = codingFillColor
                                        ctx.fillRect(drawX, drawY, boxW, boxH)
                                    }
                                    ctx.strokeStyle = strokeColor
                                    ctx.lineWidth = exonStrokeWidth
                                    ctx.strokeRect(drawX, drawY, boxW, boxH)
                                }
                            }
                        } else if (feature?._thick) {
                            ctx.fillStyle = color.fill
                            ctx.strokeStyle = strokeColor
                            ctx.lineWidth = isFocused ? 2 : (isHovered ? 1.5 : 0.9)
                            for (const piece of bedThickPieces(feature, viewGToX, { left, right, viewStart, viewEnd, yMid, exonH })) {
                                ctx.fillRect(piece.x, piece.y, piece.w, piece.h)
                                if (piece.w > 2) {
                                    ctx.strokeRect(piece.x + 0.5, piece.y + 0.5, Math.max(0.5, piece.w - 1), Math.max(0.5, piece.h - 1))
                                }
                            }
                        } else {
                            ctx.fillStyle = color.fill
                            ctx.strokeStyle = strokeColor
                            ctx.lineWidth = isFocused ? 2 : (isHovered ? 1.5 : 0.9)
                            const drawWidth = Math.max(1, drawW)
                            ctx.fillRect(x1, y, drawWidth, exonH)
                            if (drawWidth > 2) {
                                ctx.strokeRect(
                                    x1 + 0.5,
                                    y + 0.5,
                                    Math.max(0.5, drawWidth - 1),
                                    Math.max(0.5, exonH - 1)
                                )
                            }
                        }
                        // Gene models are named under their structure, as the gene track
                        // names its transcripts; lanes were packed with room for it.
                        if (data.labelled && feature?.name) {
                            ctx.font = sansFont(BIGBED_DETAIL_LABEL_FONT_PX)
                            ctx.fillStyle = isFocused ? strokeColor : colors.geneLabelText
                            ctx.textAlign = 'left'
                            ctx.textBaseline = 'top'
                            // fillScreenText takes a screen position. Flipped, the feature's
                            // left end on screen is its genomic end, reflected — where the
                            // gene track puts its names too.
                            const labelScreenX = isFlipped ? (customMirrorAxis - x2) : x1
                            fillScreenText(ctx, customMirrorAxis, String(feature.name), Math.max(left + 1, labelScreenX), yMid + exonH / 2 + 1.5)
                        }
                        ctx.restore()
                    }

                    if (overflowCount > 0) {
                        ctx.fillStyle = isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)'
                        ctx.font = sansFont(9)
                        ctx.textAlign = 'right'
                        ctx.textBaseline = 'bottom'
                        fillScreenText(ctx, customMirrorAxis, `+${overflowCount} overflow`, right - 3, bottom - 1)
                    }
                    ctx.restore()

                    if (isLoading && visibleFeatures.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight / 2 + 3)
                    }
                    continue
                }

                // ── BED/BigBed density: features per bin as a histogram ───────────
                if (isIntervalTrackType(trackType) && data?.mode === 'bed_density' && Array.isArray(data.density_bins)) {
                    const bins = data.density_bins
                    const maxCount = Math.max(1, Number(data.max_count) || 1)
                    const trackColors = bedTrackColors(track)
                    const baseColor = trackColors.chosen || trackColors.fallback || '#059669'
                    const barBottom = bottom - 1
                    const barArea = Math.max(4, barBottom - top - 2)
                    const viewSpan = Math.max(1, viewEnd - viewStart)
                    // One column per pixel holding the highest bin under it, so bins
                    // narrower than a pixel do not pile translucent fills on each other.
                    const columnCount = Math.max(1, Math.ceil(width))
                    const columns = new Float32Array(columnCount)
                    for (const bin of bins) {
                        const s = Number(bin?.start)
                        const e = Number(bin?.end)
                        const v = Number(bin?.count) || 0
                        if (!(v > 0) || !(e > viewStart) || !(s < viewEnd)) continue
                        const c0 = Math.max(0, Math.floor(((Math.max(s, viewStart) - viewStart) / viewSpan) * width))
                        const c1 = Math.min(columnCount - 1, Math.ceil(((Math.min(e, viewEnd) - viewStart) / viewSpan) * width) - 1)
                        for (let c = c0; c <= Math.max(c0, c1); c += 1) {
                            if (v > columns[c]) columns[c] = v
                        }
                    }

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()
                    ctx.strokeStyle = isLight ? 'rgba(100,116,139,0.28)' : 'rgba(148,163,184,0.28)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, barBottom + 0.5)
                    ctx.lineTo(right, barBottom + 0.5)
                    ctx.stroke()
                    const barFill = hexToRgba(baseColor, isLight ? 0.78 : 0.84)
                    ctx.fillStyle = barFill
                    let c = 0
                    while (c < columnCount) {
                        const v = columns[c]
                        if (!(v > 0)) { c += 1; continue }
                        const h = Math.max(1, Math.round((Math.min(v, maxCount) / maxCount) * barArea))
                        let runEnd = c + 1
                        while (runEnd < columnCount && Math.max(1, Math.round((Math.min(columns[runEnd], maxCount) / maxCount) * barArea)) === h && columns[runEnd] > 0) {
                            runEnd += 1
                        }
                        ctx.fillRect(left + c, barBottom - h, runEnd - c, h)
                        c = runEnd
                    }
                    // Bins above the scale are drawn full height with a darker cap, so the
                    // busiest regions still read as the busiest.
                    ctx.fillStyle = hexToRgba(baseColor, 1)
                    for (let col = 0; col < columnCount; col += 1) {
                        if (columns[col] > maxCount) ctx.fillRect(left + col, barBottom - barArea, 1, 2)
                    }
                    ctx.restore()

                    ctx.save()
                    ctx.font = sansFont(9)
                    ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                    ctx.textAlign = 'right'
                    ctx.textBaseline = 'top'
                    const binBp = BED_DENSITY_LEVELS.find((l) => l.id === data.level)?.blockBp || 0
                    const binLabel = binBp >= 1000 ? `${Math.round(binBp / 100) / 10} kb` : `${binBp} bp`
                    fillScreenText(ctx, customMirrorAxis, `0–${Math.round(maxCount)} features per ${binLabel}`, right - 3, top - 12)
                    ctx.restore()

                    if (isLoading && bins.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight / 2 + 3)
                    }
                    continue
                }

                if (trackType === 'splice_junctions' && data?.mode === 'splice_blocks' && Array.isArray(data.block_spans)) {
                    const spans = data.block_spans
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                    const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                    const blockY = top + Math.round((plotHeight - blockH) / 2)
                    const radius = Math.max(1, Math.min(3, blockH / 3))

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    ctx.strokeStyle = isLight ? 'rgba(139,92,246,0.22)' : 'rgba(196,181,253,0.24)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, blockY + blockH / 2 + 0.5)
                    ctx.lineTo(right, blockY + blockH / 2 + 0.5)
                    ctx.stroke()

                    for (const span of spans) {
                        const s = Number(span?.start)
                        const e = Number(span?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        const support = Math.max(0, Number(span?.max_support || 0))
                        const weight = spliceSupportBandWeight(support, spliceSettings)
                        const [r, g, b] = spliceSupportColor(weight, isLight)
                        const fillAlpha = 0.3 + weight * 0.6
                        const strokeAlpha = 0.35 + weight * 0.45
                        ctx.fillStyle = `rgba(${r},${g},${b},${fillAlpha})`
                        ctx.strokeStyle = `rgba(${r},${g},${b},${strokeAlpha})`
                        if (drawW <= 2) {
                            ctx.fillRect(x1, blockY, Math.max(1, drawW), blockH)
                            continue
                        }
                        ctx.beginPath()
                        ctx.moveTo(x1 + radius, blockY)
                        ctx.lineTo(x2 - radius, blockY)
                        ctx.arcTo(x2, blockY, x2, blockY + radius, radius)
                        ctx.lineTo(x2, blockY + blockH - radius)
                        ctx.arcTo(x2, blockY + blockH, x2 - radius, blockY + blockH, radius)
                        ctx.lineTo(x1 + radius, blockY + blockH)
                        ctx.arcTo(x1, blockY + blockH, x1, blockY + blockH - radius, radius)
                        ctx.lineTo(x1, blockY + radius)
                        ctx.arcTo(x1, blockY, x1 + radius, blockY, radius)
                        ctx.closePath()
                        ctx.fill()
                        ctx.lineWidth = 0.6
                        ctx.stroke()
                    }
                    ctx.restore()

                    if (isLoading && spans.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                // ── Splice junctions — arcs ───────────────────────────────────────
                if (trackType === 'splice_junctions' && Array.isArray(data.junctions)) {
                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    const baselineY = bottom - 4
                    const minTopY = top + 1
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                    const lodMode = getSpliceLodMode(trackId, bpPerPx, renderMode)
                    const lanePitch = lodMode === 'detail' ? 10 : 8
                    const maxLanesByHeight = Math.max(1, Math.floor((baselineY - minTopY) / lanePitch))
                    const maxVisibleLanes = Math.max(
                        1,
                        Math.min(maxLanesByHeight, Number(data?.layout?.max_visible_lanes || maxLanesByHeight))
                    )
                    const focusedKey = clickedSpliceJunction?.trackId === trackId
                        ? spliceJunctionKey(clickedSpliceJunction.junction)
                        : ''
                    const hoveredKey = focusedKey
                        ? ''
                        : (hoveredSpliceJunction?.trackId === trackId
                        ? hoveredSpliceJunction.key
                        : '')

                    const source = data.junctions
                        .map((raw) => {
                            const start = Number(raw?.start)
                            const end = Number(raw?.end)
                            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
                            if (end < viewStart || start > viewEnd) return null
                            const rawX1 = gToX(start)
                            const rawX2 = gToX(end)
                            const minX = Math.min(rawX1, rawX2)
                            const maxX = Math.max(rawX1, rawX2)
                            if (maxX < left - 2 || minX > right + 2) return null
                            const visibleLeft = Math.max(left, minX)
                            const visibleRight = Math.min(right, maxX)
                            const visibleWidth = visibleRight - visibleLeft
                            if (visibleWidth < 1.0) return null
                            const count = Number(raw?.n_total ?? raw?.reads ?? 0)
                            const key = raw?.key || spliceJunctionKey(raw)
                            const mapKey = `${trackId}|${key}`
                            return {
                                key,
                                start,
                                end,
                                strand: String(raw?.strand || '.'),
                                n_total: Number.isFinite(count) ? count : 0,
                                motif: String(raw?.motif || ''),
                                annotated: raw?.annotated === true,
                                canonical: raw?.canonical === true,
                                lane: Math.max(0, Number(raw?.lane || 0)),
                                x1: rawX1,
                                x2: rawX2,
                                widthPx: Math.abs(rawX2 - rawX1),
                                visibleWidthPx: visibleWidth,
                                manual_lift: Number(spliceArcLiftOffsets[mapKey] || 0),
                            }
                        })
                        .filter(Boolean)

                    if (source.length === 0) {
                        ctx.restore()
                        continue
                    }

                    if (lodMode === 'blocks') {
                        ctx.restore()
                        continue
                    }

                    const drawCap = Math.max(500, Math.min(spliceSettings.max_junctions, lodMode === 'detail' ? 9000 : 4500))
                    const drawSet = annotateSpliceSimilarityLift(source
                        .sort((a, b) =>
                            (a.lane - b.lane)
                            || (b.n_total - a.n_total)
                            || ((a.end - a.start) - (b.end - b.start))
                            || (a.start - b.start)
                            || (a.end - b.end)
                            || a.strand.localeCompare(b.strand)
                        )
                        .slice(0, drawCap), lodMode)

                    ctx.lineCap = 'butt'
                    ctx.lineJoin = 'round'

                    // Track baseline
                    ctx.strokeStyle = isLight ? 'rgba(139,92,246,0.25)' : 'rgba(196,181,253,0.28)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, baselineY + 0.5)
                    ctx.lineTo(right, baselineY + 0.5)
                    ctx.stroke()

                    let overflow = drawSet.filter((j) => Number(j.lane || 0) >= maxVisibleLanes)
                    const visible = drawSet.filter((j) => Number(j.lane || 0) < maxVisibleLanes)
                    if (focusedKey) {
                        const focusedHidden = overflow.find((j) => j.key === focusedKey)
                        if (focusedHidden && !visible.some((j) => j.key === focusedKey)) {
                            visible.push(focusedHidden)
                            overflow = overflow.filter((j) => j.key !== focusedKey)
                        }
                    }

                    if (overflow.length > 0) {
                        const bins = Math.max(60, Math.min(220, Math.floor(width / 3)))
                        const overflowCounts = Array(bins).fill(0)
                        const overflowMaxSupport = Array(bins).fill(0)
                        for (const j of overflow) {
                            const mid = (j.start + j.end) / 2
                            const idx = clamp(Math.floor(((mid - viewStart) / Math.max(1, viewEnd - viewStart)) * bins), 0, bins - 1)
                            overflowCounts[idx] += Math.max(1, j.n_total || 0)
                            overflowMaxSupport[idx] = Math.max(overflowMaxSupport[idx], Math.max(0, Number(j.n_total || 0)))
                        }
                        const bandTop = Math.max(top + 1, baselineY + 1)
                        const bandBottom = Math.min(bottom - 1, bandTop + 8)
                        const bw = width / bins
                        for (let i = 0; i < bins; i++) {
                            const v = overflowCounts[i]
                            if (v <= 0) continue
                            const supportWeight = spliceSupportBandWeight(overflowMaxSupport[i], spliceSettings)
                            const [r, g, b] = spliceSupportColor(supportWeight, isLight)
                            const alpha = 0.12 + supportWeight * 0.25
                            ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
                            ctx.fillRect(left + i * bw, bandTop, Math.max(1, bw - 0.5), bandBottom - bandTop)
                        }
                    }

                    const nonFocused = []
                    const hovered = []
                    const focused = []
                    for (const j of visible) {
                        if (focusedKey && j.key === focusedKey) focused.push(j)
                        else if (hoveredKey && j.key === hoveredKey) hovered.push(j)
                        else nonFocused.push(j)
                    }
                    nonFocused.sort((a, b) =>
                        (a.lane - b.lane)
                        || (a.n_total - b.n_total)
                        || (a.start - b.start)
                        || (a.end - b.end)
                    )

                    const drawOrdered = [...nonFocused, ...hovered, ...focused]
                    for (const j of drawOrdered) {
                        const lane = Math.max(0, Number(j.lane || 0))
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
                        const weight = spliceSupportBandWeight(j.n_total, spliceSettings)
                        const [r, g, b] = spliceSupportColor(weight, isLight)
                        const isFocused = !!focusedKey && j.key === focusedKey
                        const isHovered = !!hoveredKey && j.key === hoveredKey
                        const dimFactor = focusedKey && !isFocused ? 0.2 : 1
                        const strokeAlpha = Math.max(0.08, Math.min(0.98, (0.2 + weight * 0.72) * dimFactor + (isHovered ? 0.14 : 0)))
                        const lw = (1.2 + weight * (lodMode === 'detail' ? 3.0 : 2.2)) + (isFocused ? 1.3 : (isHovered ? 0.9 : 0))

                        ctx.strokeStyle = `rgba(${r},${g},${b},${strokeAlpha})`
                        ctx.lineWidth = lw
                        if (j.canonical !== true) ctx.setLineDash([4, 3])
                        else ctx.setLineDash([])
                        ctx.beginPath()
                        ctx.moveTo(j.x1, baselineY)
                        ctx.bezierCurveTo(controls.c1x, controls.c1y, controls.c2x, controls.c2y, j.x2, baselineY)
                        ctx.stroke()
                        ctx.setLineDash([])

                        if (spliceSettings.show_arrows && j.visibleWidthPx >= (lodMode === 'detail' ? 34 : 65)) {
                            const arrowCount = j.widthPx >= 140 ? 2 : 1
                            const dirSign = j.strand === '-' ? -1 : 1
                            const arrowTs = arrowCount === 2 ? [0.35, 0.65] : [0.5]
                            const arrowLen = Math.max(4, Math.min(7, lw + 2))
                            const arrowWing = Math.max(2.5, arrowLen * 0.55)
                            ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.98, strokeAlpha + 0.12)})`
                            ctx.lineWidth = Math.max(1, lw * 0.8)
                            for (const t of arrowTs) {
                                const px = cubicPointAt(j.x1, controls.c1x, controls.c2x, j.x2, t)
                                const py = cubicPointAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                                let tx = cubicDerivativeAt(j.x1, controls.c1x, controls.c2x, j.x2, t)
                                let ty = cubicDerivativeAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                                if (dirSign < 0) {
                                    tx *= -1
                                    ty *= -1
                                }
                                const norm = Math.hypot(tx, ty) || 1
                                const ux = tx / norm
                                const uy = ty / norm
                                const bx = px - ux * arrowLen
                                const by = py - uy * arrowLen
                                const nx = -uy
                                const ny = ux
                                ctx.beginPath()
                                ctx.moveTo(px, py)
                                ctx.lineTo(bx + nx * arrowWing, by + ny * arrowWing)
                                ctx.moveTo(px, py)
                                ctx.lineTo(bx - nx * arrowWing, by - ny * arrowWing)
                                ctx.stroke()
                            }
                        }
                    }
                    if (overflow.length > 0) {
                        const hiddenN = Number(data?.layout?.overflow_count || overflow.length)
                        ctx.fillStyle = isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)'
                        ctx.font = sansFont(9)
                        ctx.textAlign = 'right'
                        ctx.textBaseline = 'bottom'
                        fillScreenText(ctx, customMirrorAxis, `+${hiddenN} overflow`, right - 3, bottom - 1)
                    }
                    ctx.restore()
                    continue
                }

                // Unknown discrete format — skip
                continue
            }

            // ── Signal track (BigWig / BAM coverage) — always draw available data ─

            if (data?.error && !data?.has_data) {
                ctx.fillStyle = isLight ? '#b91c1c' : '#fca5a5'
                ctx.font = sansFont(10)
                ctx.textAlign = 'center'
                ctx.fillText(data.error, left + width / 2, top + plotHeight / 2 + 3)
                continue
            }

            if (!data || !data.has_data || !Array.isArray(data.bins) || data.bins.length === 0) {
                continue
            }

            const values = data.bins
            const validValues = values.filter((v) => typeof v === 'number')
            if (validValues.length === 0) {
                continue
            }

            const observedMin = Math.min(...validValues)
            const observedMax = Math.max(...validValues)
            const minVal = data.min ?? observedMin
            const maxVal = data.max ?? observedMax
            const safeMax = Math.max(maxVal, minVal + 1e-9)
            const range = safeMax - minVal
            const binWidth = width / values.length

            if (renderMode === 'zoned_heatmap') {
                const colW = Math.max(1, Math.ceil(binWidth))
                const zoneColors = (trackType === 'bigwig' && bigWigSettings)
                    ? bigWigSettings.zoned_colors
                    : (isLight ? ZONED_ZONE_SOLID_COLORS.light : ZONED_ZONE_SOLID_COLORS.dark)
                // The fixed zones (100 / 1k / 10k / 100k) suit read coverage; a track scaled
                // to its file uses that file's peak heights once they have been measured.
                const zoneThresholds = zoneThresholdsFor(bigWigSettings?.zone_scale, bigWigZoneScales[track?.path], bigWigSettings?.custom_zones, bigWigSettings?.shared_zones)
                const isSecondaryZoned = !isPrimaryPanel
                const zoneYForValue = (value) => {
                    const frac = zonedValueFraction(value, zoneThresholds)
                    return isSecondaryZoned
                        ? (bottom - frac * plotHeight)
                        : (top + frac * plotHeight)
                }

                // Top baseline and zone guides, one at each zone edge.
                ctx.save()
                ctx.strokeStyle = isLight ? '#e8a534' : '#f0b44d'
                ctx.lineWidth = 1
                ctx.beginPath()
                const baselineY = isSecondaryZoned ? bottom + 0.5 : top + 0.5
                ctx.moveTo(left, baselineY)
                ctx.lineTo(right, baselineY)
                ctx.stroke()

                const boundaryValues = zoneThresholds
                ctx.setLineDash([4, 3])
                ctx.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.32)'
                for (const boundary of boundaryValues) {
                    const y = zoneYForValue(boundary)
                    ctx.beginPath()
                    ctx.moveTo(left, y)
                    ctx.lineTo(right, y)
                    ctx.stroke()
                }
                ctx.restore()

                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
                    const x = left + i * binWidth
                    let yOffset = 0
                    for (const segment of zonedSegments(value, zoneThresholds)) {
                        const segH = plotHeight * segment.height
                        if (!(segH > 0)) continue
                        ctx.fillStyle = zoneColors[segment.zone] || zoneColors[zoneColors.length - 1]
                        const segY = isSecondaryZoned
                            ? (bottom - yOffset - segH)
                            : (top + yOffset)
                        ctx.fillRect(x, segY, colW, segH)
                        yOffset += segH
                    }
                }

                // Fixed right-side zone labels.
                ctx.save()
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const boundary of boundaryValues) {
                    const y = zoneYForValue(boundary)
                    fillScreenText(ctx, customMirrorAxis, formatZoneLabel(boundary), viewWidth - 4, y)
                }
                ctx.restore()
            } else if (trackType === 'bigwig' && renderMode === 'signal_plot') {
                const yMin = Math.min(0, observedMin)
                const yMax = Math.max(0, observedMax)
                const yRange = Math.max(1e-9, yMax - yMin)
                const toY = (value) => bottom - ((value - yMin) / yRange) * plotHeight
                const zeroY = clamp(toY(0), top, bottom)
                const plotColor = normalizeBigWigHexColor(bigWigSettings?.plot_color, BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.plot_color)

                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(148, 163, 184, 0.32)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(left, zeroY)
                ctx.lineTo(right, zeroY)
                ctx.stroke()
                // Color-tinted zero baseline keeps sparse/no-data spans readable.
                ctx.strokeStyle = hexToRgba(plotColor, isLight ? 0.18 : 0.26)
                ctx.beginPath()
                ctx.moveTo(left, zeroY)
                ctx.lineTo(right, zeroY)
                ctx.stroke()

                const segments = []
                const zeroBridges = []
                let current = []
                let gapStartX = null
                let gapEndX = null
                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    const binLeft = left + i * binWidth
                    const binRight = left + (i + 1) * binWidth
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        if (current.length > 0) segments.push(current)
                        current = []
                        if (gapStartX === null) gapStartX = binLeft
                        gapEndX = binRight
                        continue
                    }
                    if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                        zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                        gapStartX = null
                        gapEndX = null
                    }
                    const x = left + (i + 0.5) * binWidth
                    const y = clamp(toY(value), top, bottom)
                    current.push({ x, y })
                }
                if (current.length > 0) segments.push(current)
                if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                    zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                }

                ctx.fillStyle = hexToRgba(plotColor, 0.28)
                ctx.strokeStyle = hexToRgba(plotColor, 0.94)
                ctx.lineWidth = 1.5

                for (const segment of segments) {
                    if (segment.length === 0) continue
                    if (segment.length === 1) {
                        const p = segment[0]
                        ctx.beginPath()
                        ctx.moveTo(p.x, zeroY)
                        ctx.lineTo(p.x, p.y)
                        ctx.stroke()
                        continue
                    }
                    ctx.beginPath()
                    ctx.moveTo(segment[0].x, zeroY)
                    ctx.lineTo(segment[0].x, segment[0].y)
                    for (let i = 1; i < segment.length; i++) {
                        ctx.lineTo(segment[i].x, segment[i].y)
                    }
                    ctx.lineTo(segment[segment.length - 1].x, zeroY)
                    ctx.closePath()
                    ctx.fill()

                    ctx.beginPath()
                    ctx.moveTo(segment[0].x, segment[0].y)
                    for (let i = 1; i < segment.length; i++) {
                        ctx.lineTo(segment[i].x, segment[i].y)
                    }
                    ctx.stroke()
                }

                if (zeroBridges.length > 0) {
                    ctx.save()
                    ctx.strokeStyle = hexToRgba(plotColor, isLight ? 0.52 : 0.62)
                    ctx.lineWidth = 1
                    ctx.setLineDash([4, 3])
                    for (const gap of zeroBridges) {
                        ctx.beginPath()
                        ctx.moveTo(gap.x1, zeroY)
                        ctx.lineTo(gap.x2, zeroY)
                        ctx.stroke()
                    }
                    ctx.restore()
                }

                const axisX = screenX(viewWidth - 14)
                ctx.save()
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(axisX, top)
                ctx.lineTo(axisX, bottom)
                ctx.stroke()
                const ticks = [
                    { y: top, value: yMax },
                    { y: top + plotHeight / 2, value: (yMin + yMax) / 2 },
                    { y: bottom, value: yMin },
                ]
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const tick of ticks) {
                    ctx.beginPath()
                    ctx.moveTo(screenX(viewWidth - 18), tick.y)
                    ctx.lineTo(axisX, tick.y)
                    ctx.stroke()
                    fillScreenText(ctx, customMirrorAxis, formatSignalValue(tick.value), viewWidth - 4, tick.y)
                }
                ctx.restore()
            } else {
                // Baseline
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.2)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(left, bottom)
                ctx.lineTo(right, bottom)
                ctx.stroke()

                // Column renderer (one column per screen bin) for stable panning/zoom behavior.
                const fillColor = isLight ? 'rgba(0, 153, 255, 0.55)' : 'rgba(110, 168, 255, 0.62)'
                ctx.fillStyle = fillColor
                const colW = Math.max(1, Math.ceil(binWidth))
                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    if (typeof value !== 'number') continue
                    const x = left + i * binWidth
                    const y = bottom - ((value - minVal) / range) * plotHeight
                    const h = Math.max(1, bottom - y)
                    ctx.fillRect(x, y, colW, h)
                }

                // Right-side y-axis reference markers.
                const axisX = screenX(viewWidth - 14)
                ctx.save()
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(axisX, top)
                ctx.lineTo(axisX, bottom)
                ctx.stroke()

                const ticks = [
                    { y: top, value: safeMax },
                    { y: top + plotHeight / 2, value: minVal + (range / 2) },
                    { y: bottom, value: minVal },
                ]
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const tick of ticks) {
                    ctx.beginPath()
                    ctx.moveTo(screenX(viewWidth - 18), tick.y)
                    ctx.lineTo(axisX, tick.y)
                    ctx.stroke()
                    fillScreenText(ctx, customMirrorAxis, formatSignalValue(tick.value), viewWidth - 4, tick.y)
                }
                ctx.restore()
            }
        }
        endCanvasMirror(ctx)

        // ---- Box Selection Overlay ----
        if (selectionRect) {
            const x = Math.min(selectionRect.x1, selectionRect.x2)
            const y = Math.min(selectionRect.y1, selectionRect.y2)
            const w = Math.abs(selectionRect.x2 - selectionRect.x1)
            const h = Math.abs(selectionRect.y2 - selectionRect.y1)
            if (w > 0 && h > 0) {
                ctx.save()
                ctx.strokeStyle = panelExonColor
                ctx.fillStyle = isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)'
                ctx.lineWidth = 1.5
                ctx.setLineDash([6, 4])
                ctx.fillRect(x, y, w, h)
                ctx.strokeRect(x, y, w, h)
                ctx.restore()
            }
        }

    }
