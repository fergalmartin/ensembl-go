// Screenshot export of one Genome Browser panel: an SVG rendering of what the
// canvas shows (ruler, genes and transcripts, every custom track type, labels and
// overlays), built from the panel's current state. Called by the panel's
// buildPanelExportSnapshot, which passes that state in.
import { bedThickPieces } from '../../utils/bedThickRegion.js'
import { noteBubbleGlyphSvgMarkup } from '../../utils/noteBubbleGlyph.js'
import { getBaseColor } from '../../utils/nucleotideStyle.js'
import { powerGlyphSvgMarkup } from '../../utils/powerGlyph.js'
import { buildForeignObjectMarkup, buildSvgDocument, escapeXml } from '../../utils/screenshotExport.js'
import { isGroupRowId } from '../../utils/trackGroups.js'
import { monoFont, sansFont } from '../../utils/typography.js'
import { getVcfAltAlleleCount, getVcfDetailVariantLayout, localVcfType, shouldRenderActiveAnchorBase } from '../../utils/vcfDetailGeometry.js'
import { formatZoneLabel, zoneThresholdsFor, zonedSegments, zonedValueFraction } from '../../utils/zonedScale.js'
import {
    BIGBED_DETAIL_EXON_HEIGHT,
    BIGBED_DETAIL_LABEL_FONT_PX,
    BIGBED_DETAIL_LANE_TOP_PAD,
    BIGWIG_DATA_TYPE_DEFAULTS,
    COORD_FONT,
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    INTRON_HEIGHT,
    JOINED_GROUP_HEADER_HEIGHT,
    LABEL_FONT,
    LHS_WIDTH,
    NOTE_BUBBLE_SIZE,
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
import { formatSignalValueForTrack } from './browserFormat.js'
import { buildGeneLabelCandidate, placeNonOverlappingGeneLabels } from './genomeBrowserLabelLayout.js'
import {
    RULER_FONT_SIZE,
    RULER_LABEL_GAP,
    formatRulerCoord,
    rulerGeometry,
    rulerTicks,
} from './genomeBrowserRuler.js'
import { REV_COMP, bigBedFeatureKey, clamp } from './trackData.js'
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
    normalizeVcfDisplayMode,
    normalizeVcfSettings,
} from './trackSettings.js'

export async function renderPanelExportSnapshot(ctx) {
    const {
        ANCHOR_ICON_BODY,
        alignData,
        alignmentCoords,
        bigWigZoneScales,
        bpPerPx,
        canvasRef,
        clickedBigBedFeature,
        clickedVcfVariant,
        colors,
        customTrackData,
        customTracksById,
        dimNonSelectedGenes,
        effectiveFocusBarPosition,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        effectiveRulerPosition,
        effectiveToolbarPosition,
        flattenTracks,
        focusBarRef,
        geneNoteOverlayRef,
        genes,
        genomicToScreen,
        getBasePixelBounds,
        getCustomTrackIntervalPixelBounds,
        getCustomTrackToggleY,
        getEffectiveTranscriptLimit,
        getGeneRowCountForWidth,
        getVcfBlockLevel,
        hoveredBigBedFeature,
        hoveredSeqBase,
        hoveredVcfBlock,
        isAligned,
        isCompressedLayoutActive,
        isCustomTrackId,
        isFlipped,
        isLight,
        isLocationFocusVisible,
        isPrimaryPanel,
        isSelectedHidden,
        joinedRows,
        layout,
        overlayToGenomic,
        paintCanvasRef,
        panelPillColor,
        rootRef,
        selectedGene,
        seqRange,
        sequence,
        sequenceTrackLabel,
        showSequenceTrack,
        sidebarToggleIconColor,
        toolbarRef,
        trackOrder,
        trackWidth,
        transcriptCache,
        transcriptLayoutMetrics,
        viewEnd,
        viewHeight,
        viewSpan,
        viewStart,
        viewWidth,
    } = ctx
        const rootNode = rootRef.current
        const canvas = canvasRef.current
        if (!rootNode || !canvas) {
            throw new Error('Browser panel is not ready for export.')
        }
        // An off-screen panel may have skipped painting while its data and
        // coordinates advanced. Exports must always capture the latest state.
        paintCanvasRef.current?.()

        const width = Math.max(
            1,
            Math.round(rootNode.getBoundingClientRect().width || rootNode.clientWidth || viewWidth || 1)
        )
        const toolbarNode = toolbarRef.current
        const focusNode = (selectedGene && !isSelectedHidden) || isLocationFocusVisible ? focusBarRef.current : null
        const toolbarHeight = toolbarNode
            ? Math.max(1, Math.round(toolbarNode.getBoundingClientRect().height || toolbarNode.clientHeight || 0))
            : 0
        const focusHeight = focusNode
            ? Math.max(1, Math.round(focusNode.getBoundingClientRect().height || focusNode.clientHeight || 0))
            : 0
        const canvasHeight = Math.max(
            1,
            Math.round(canvas.clientHeight || (canvas.height / (window.devicePixelRatio || 1)) || viewHeight || 1)
        )
        const textMeasureCanvas = document.createElement('canvas')
        const textMeasureCtx = textMeasureCanvas.getContext('2d')
        const textDescriptors = []
        const textMaskRects = []
        const overlayMarkupSections = []
        const visibleTrackOrder = trackOrder.filter((trackId) => {
            if (trackId === 'sequence') return showSequenceTrack
            if (isCustomTrackId(trackId)) return customTracksById.has(trackId)
            return true
        })
        const getExportTrackBgColor = (trackId) => {
            // A joined group's tracks sit on their group's row.
            const index = visibleTrackOrder.indexOf(layout.customTrackLayouts?.[trackId]?.joinedRowId || trackId)
            if (index % 2 === 0) {
                return isLight ? '#ffffff' : '#1a1b1e'
            }
            return isLight ? '#f8f9fa' : '#212226'
        }
        const getSidebarBgColor = (trackId) => {
            const isHidden = (trackId === 'forward' && effectiveHiddenStrands.forward)
                || (trackId === 'reverse' && effectiveHiddenStrands.reverse)
                || (trackId === 'sequence' && effectiveHiddenStrands.sequence)
                || (isCustomTrackId(trackId) && !(customTracksById.get(trackId)?.visible))
                || (isGroupRowId(trackId) && Boolean(joinedRows.get(trackId)?.hidden))
            if (isHidden) return isLight ? '#e9ecef' : '#141517'
            return getExportTrackBgColor(trackId)
        }
        const buildTextMaskRect = ({ text, x, y, font, textAnchor = 'middle', dominantBaseline = 'alphabetic', paddingX = 4, paddingY = 2 }) => {
            if (!textMeasureCtx || !text) return null
            textMeasureCtx.font = font
            const width = textMeasureCtx.measureText(text).width
            const fontSizeMatch = /(\d+(?:\.\d+)?)px/.exec(font)
            const fontSize = fontSizeMatch ? Number(fontSizeMatch[1]) : 11
            const safeHeight = Math.max(10, fontSize * 1.2)
            let left = x
            if (textAnchor === 'middle') left -= width / 2
            else if (textAnchor === 'end') left -= width
            let top = y - (fontSize * 0.82)
            if (dominantBaseline === 'middle') top = y - (safeHeight / 2)
            else if (dominantBaseline === 'hanging' || dominantBaseline === 'text-before-edge') top = y - fontSize * 0.1
            return {
                x: Math.floor(left - paddingX),
                y: Math.floor(top - paddingY),
                width: Math.ceil(width + paddingX * 2),
                height: Math.ceil(safeHeight + paddingY * 2),
            }
        }
        const pushExportText = ({
            text,
            x,
            y,
            font,
            fill,
            bgFill,
            textAnchor = 'middle',
            dominantBaseline = 'alphabetic',
            paddingX = 4,
            paddingY = 2,
        }) => {
            if (!text) return
            const maskRect = buildTextMaskRect({ text, x, y, font, textAnchor, dominantBaseline, paddingX, paddingY })
            if (maskRect && bgFill) {
                textMaskRects.push({ ...maskRect, fill: bgFill })
            }
            textDescriptors.push({
                text,
                x,
                y,
                font,
                fill,
                textAnchor,
                dominantBaseline,
            })
        }
        const pushOverlayMarkup = (markup) => {
            if (markup) overlayMarkupSections.push(markup)
        }
        // The export's copy of the canvas mirror (beginCanvasMirror): custom-track
        // markup is written in genomic order, so a flipped panel reflects it about
        // the track area, turning each label back round about its own anchor.
        const mirrorCustomTrackMarkup = (markup) => {
            if (!markup || !isFlipped) return markup
            const axis = LHS_WIDTH + viewWidth
            const swapAnchor = { start: 'end', end: 'start', middle: 'middle' }
            const readable = markup.replace(
                /<text x="([^"]+)"([^>]*?)text-anchor="(start|end|middle)"/g,
                (_match, x, between, anchor) => {
                    const anchorX = Number(x)
                    return `<text x="${x}"${between}text-anchor="${swapAnchor[anchor]}" transform="translate(${anchorX} 0) scale(-1 1) translate(${-anchorX} 0)"`
                },
            )
            return `<g transform="matrix(-1 0 0 1 ${axis} 0)">${readable}</g>`
        }
        const buildCustomTrackLabelY = (trackLayout, track, data) => {
            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode

            if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                const vcfLevel = getVcfBlockLevel(bpPerPx)
                const isDetailMode = data?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
                const top = trackLayout.y + (isDetailMode ? 18 : 8)
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const barH = Math.max(3, Math.floor(plotHeight * (isDetailMode ? 0.13 : 0.18)))
                const barY = top + Math.floor((plotHeight - barH) / 2)
                return isDetailMode
                    ? (trackLayout.y + 10)
                    : Math.max(trackLayout.y + 10, barY - 8)
            }

            if (renderMode !== 'zoned_heatmap') {
                return trackLayout.y + 9
            }

            const labelBand = 14
            const topPad = 4
            const bottomPad = 6
            const labelBelow = isPrimaryPanel && !trackLayout.joinedRowId
            if (labelBelow) {
                return trackLayout.y + trackLayout.height - bottomPad - (labelBand / 2)
            }
            return trackLayout.y + topPad + (labelBand / 2)
        }
        const sidebarToggleDescriptors = []
        const pushSidebarToggleDescriptor = (trackId, centerY, isHidden) => {
            if (!(Number.isFinite(centerY))) return
            const active = !isHidden
            sidebarToggleDescriptors.push({
                trackId,
                x: LHS_WIDTH - 13,
                y: Math.round(centerY), // as drawToggle rounds it
                iconColor: sidebarToggleIconColor(active),
                // The rasterised glyph is painted over with the sidebar's own
                // background so the export can re-emit it as a crisp path.
                maskFill: getSidebarBgColor(trackId),
            })
        }
        const pushSidebarLabelDescriptor = (trackId, rawCenterY, text, isCustomTrack = false) => {
            if (!(Number.isFinite(rawCenterY)) || !text) return
            const centerY = Math.round(rawCenterY)
            // Placed exactly as drawToggle places them, since each masks the canvas copy.
            const showRc = isFlipped && (isCustomTrack || REVERSE_COMPLEMENTED_TRACK_IDS.has(trackId))
            const labelBaseline = centerY + 4 - (showRc ? SIDEBAR_RC_HALF_GAP : 0)
            const labelRightX = (LHS_WIDTH - 13) - (SIDEBAR_TOGGLE_ICON_SIZE / 2) - SIDEBAR_TOGGLE_LABEL_GAP
            let columnX = labelRightX
            if (showRc && textMeasureCtx) {
                textMeasureCtx.font = sansFont(11)
                columnX = labelRightX - textMeasureCtx.measureText('RC').width / 2
            }
            pushExportText({
                text,
                x: columnX,
                y: labelBaseline,
                font: sansFont(11),
                fill: isLight ? '#64748b' : '#cbd5e1',
                bgFill: getSidebarBgColor(trackId),
                textAnchor: showRc ? 'middle' : 'end',
                dominantBaseline: 'alphabetic',
                paddingX: 3,
                paddingY: 2,
            })
            if (showRc) {
                pushExportText({
                    text: 'RC',
                    x: columnX,
                    y: labelBaseline + SIDEBAR_RC_LINE_GAP,
                    font: sansFont(11),
                    fill: panelPillColor,
                    bgFill: getSidebarBgColor(trackId),
                    textAnchor: 'middle',
                    dominantBaseline: 'alphabetic',
                    paddingX: 3,
                    paddingY: 1,
                })
            }
        }

        if (effectiveRulerHeight > 0) {
            const geometry = rulerGeometry({
                top: layout.RULER_Y,
                height: effectiveRulerHeight,
                position: effectiveRulerPosition,
            })
            const { ticks } = rulerTicks({
                start: viewStart,
                end: viewEnd,
                widthPx: viewWidth,
                fontSize: RULER_FONT_SIZE,
            })
            for (const pos of ticks) {
                const x = isAligned
                    ? (isFlipped
                        ? LHS_WIDTH + (viewEnd - pos) / bpPerPx
                        : LHS_WIDTH + (pos - viewStart) / bpPerPx)
                    : genomicToScreen(pos)
                if (x < 0 || x > viewWidth) continue
                let labelPos = pos
                if (isAligned && alignmentCoords && alignData) {
                    labelPos = overlayToGenomic(pos)
                }
                if (pos > 1 || isAligned) {
                    pushExportText({
                        text: formatRulerCoord(labelPos),
                        x: x + RULER_LABEL_GAP,
                        y: geometry.labelBaseline,
                        font: COORD_FONT,
                        fill: colors.rulerText,
                        bgFill: colors.rulerBg,
                        textAnchor: 'start',
                        dominantBaseline: 'alphabetic',
                        paddingX: 2,
                        paddingY: 2,
                    })
                }
            }
        }

        const exportGeneLabelCandidates = []
        let exportGeneLabelOrder = 0
        const collectGeneLabelDescriptors = (genesToRender, trackId, trackOrder, trackY) => {
            for (const gene of genesToRender) {
                const isSelected = selectedGene && selectedGene.id === gene.id
                const shouldDim = dimNonSelectedGenes && !!selectedGene && !isSelected
                const geneLabelColor = shouldDim ? (isLight ? '#868e96' : '#8a8d93') : colors.geneLabelText
                const txs = transcriptCache[gene.id]
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
                    visibleTranscriptCount: getGeneRowCountForWidth(gene),
                    measureTextWidth: (text) => {
                        if (!textMeasureCtx) return 0
                        textMeasureCtx.font = LABEL_FONT
                        return textMeasureCtx.measureText(text).width
                    },
                    lhsWidth: LHS_WIDTH,
                    order: exportGeneLabelOrder++,
                    footerStyleEnabled: !isCompressedLayoutActive,
                })
                if (candidate) exportGeneLabelCandidates.push(candidate)
            }
        }

        if (!flattenTracks) {
            collectGeneLabelDescriptors(layout.forwardGenes, 'forward', 0, layout.FORWARD_Y)
            collectGeneLabelDescriptors(layout.reverseGenes, 'reverse', 1, layout.REVERSE_Y)
        }
        for (const label of placeNonOverlappingGeneLabels(exportGeneLabelCandidates)) {
            pushExportText({
                text: label.text,
                x: label.x,
                y: label.y,
                font: LABEL_FONT,
                fill: label.fill || colors.geneLabelText,
                bgFill: getExportTrackBgColor(label.trackId),
                textAnchor: label.textAlign === 'left' ? 'start' : 'middle',
                dominantBaseline: 'alphabetic',
                paddingX: 4,
                paddingY: 2,
            })
        }

        if (layout.forwardBgHeight > 0) {
            pushSidebarLabelDescriptor('forward', layout.FORWARD_Y + (layout.forwardBgHeight / 2), 'GF')
            pushSidebarToggleDescriptor(
                'forward',
                layout.FORWARD_Y + (layout.forwardBgHeight / 2),
                effectiveHiddenStrands.forward
            )
        }
        if (layout.reverseBgHeight > 0) {
            pushSidebarLabelDescriptor('reverse', layout.REVERSE_Y + (layout.reverseBgHeight / 2), 'GR')
            pushSidebarToggleDescriptor(
                'reverse',
                layout.REVERSE_Y + (layout.reverseBgHeight / 2),
                effectiveHiddenStrands.reverse
            )
        }
        if (showSequenceTrack && layout.SEQUENCE_Y >= 0) {
            pushSidebarLabelDescriptor('sequence', layout.SEQUENCE_Y + (layout.seqBgHeight / 2), sequenceTrackLabel)
            pushSidebarToggleDescriptor(
                'sequence',
                layout.SEQUENCE_Y + (layout.seqBgHeight / 2),
                effectiveHiddenStrands.sequence
            )
        }
        for (const [rowId, rowLayout] of Object.entries(layout.groupRowLayouts || {})) {
            pushExportText({
                text: joinedGroupHeaderText(rowLayout),
                x: LHS_WIDTH + 8,
                y: rowLayout.y + (rowLayout.hidden ? rowLayout.height / 2 : JOINED_GROUP_HEADER_HEIGHT / 2),
                font: sansFont(10, 600),
                fill: isLight ? '#4338ca' : '#a5b4fc',
                bgFill: getSidebarBgColor(rowId),
                textAnchor: 'start',
                dominantBaseline: 'middle',
                paddingX: 3,
                paddingY: 1,
            })
            pushSidebarLabelDescriptor(rowId, getCustomTrackToggleY(rowLayout), 'CG', true)
            pushSidebarToggleDescriptor(rowId, getCustomTrackToggleY(rowLayout), rowLayout.hidden)
        }
        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts || {})) {
            const track = customTracksById.get(trackId)
            if (track) {
                pushExportText({
                    text: track.label || 'Custom track',
                    x: LHS_WIDTH + 8,
                    y: buildCustomTrackLabelY(trackLayout, track, customTrackData[trackId]),
                    font: sansFont(11),
                    fill: isLight ? '#1e3a8a' : '#93c5fd',
                    bgFill: getExportTrackBgColor(trackId),
                    textAnchor: 'start',
                    dominantBaseline: 'middle',
                    paddingX: 3,
                    paddingY: 2,
                })
            }
            // A joined group has one toggle for its row, drawn below; a group's tracks
            // shown separately are CG, not CT.
            if (!trackLayout.joinedRowId) {
                pushSidebarLabelDescriptor(trackId, getCustomTrackToggleY(trackLayout), track?.group ? 'CG' : 'CT', true)
                pushSidebarToggleDescriptor(
                    trackId,
                    getCustomTrackToggleY(trackLayout),
                    !(customTracksById.get(trackId)?.visible)
                )
            }

            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const bigWigSettings = trackType === 'bigwig'
                ? normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings)
                : null
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, bigWigSettings?.data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const data = customTrackData[trackId]
            if (trackType === 'bigwig' && data?.has_data && Array.isArray(data.bins) && data.bins.length > 0 && data.bins.length <= 2048) {
                const values = data.bins
                const validValues = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
                if (validValues.length > 0) {
                    let top
                    let bottom
                    let plotHeight
                    if (renderMode !== 'zoned_heatmap') {
                        top = trackLayout.y + 18
                        bottom = trackLayout.y + trackLayout.height - 8
                        plotHeight = Math.max(8, bottom - top)
                    } else {
                        const labelBand = 14
                        const topPad = 4
                        const bottomPad = 6
                        const gap = 2
                        const labelBelow = isPrimaryPanel && !trackLayout.joinedRowId
                        if (labelBelow) {
                            top = trackLayout.y + topPad
                            bottom = trackLayout.y + trackLayout.height - (labelBand + bottomPad + gap)
                        } else {
                            top = trackLayout.y + labelBand + topPad
                            bottom = trackLayout.y + trackLayout.height - bottomPad
                        }
                        plotHeight = Math.max(8, bottom - top)
                    }
                    const left = LHS_WIDTH + 2
                    const right = viewWidth - 2
                    const plotWidth = Math.max(1, right - left)
                    const observedMin = Math.min(...validValues)
                    const observedMax = Math.max(...validValues)
                    const minVal = data.min ?? observedMin
                    const maxVal = data.max ?? observedMax
                    const safeMax = Math.max(maxVal, minVal + 1e-9)
                    const range = safeMax - minVal
                    const binWidth = plotWidth / values.length
                    const bigWigMarkup = []
                    // The value axis stays on the right however the data is drawn.
                    const bigWigAxisMarkup = []
                    textMaskRects.push({
                        x: left,
                        y: trackLayout.y,
                        width: viewWidth - left,
                        height: trackLayout.height,
                        fill: getExportTrackBgColor(trackId),
                    })

                    if (renderMode === 'zoned_heatmap') {
                        const colW = Math.max(1, Math.ceil(binWidth))
                        const zoneColors = bigWigSettings?.zoned_colors
                            || (isLight ? ZONED_ZONE_SOLID_COLORS.light : ZONED_ZONE_SOLID_COLORS.dark)
                        const zoneThresholds = zoneThresholdsFor(bigWigSettings?.zone_scale, bigWigZoneScales[track?.path], bigWigSettings?.custom_zones, bigWigSettings?.shared_zones)
                        const isSecondaryZoned = !isPrimaryPanel
                        const zoneYForValue = (value) => {
                            const frac = zonedValueFraction(value, zoneThresholds)
                            return isSecondaryZoned
                                ? (bottom - frac * plotHeight)
                                : (top + frac * plotHeight)
                        }
                        const baselineY = isSecondaryZoned ? (bottom + 0.5) : (top + 0.5)
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${baselineY}" x2="${right}" y2="${baselineY}" stroke="${escapeXml(isLight ? '#e8a534' : '#f0b44d')}" stroke-width="1" />`
                        )
                        const boundaryValues = zoneThresholds
                        for (const boundary of boundaryValues) {
                            const y = zoneYForValue(boundary)
                            bigWigMarkup.push(
                                `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${escapeXml(isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.32)')}" stroke-width="1" stroke-dasharray="4 3" />`
                            )
                        }
                        for (let i = 0; i < values.length; i += 1) {
                            const value = values[i]
                            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
                            const x = left + i * binWidth
                            let yOffset = 0
                            for (const segment of zonedSegments(value, zoneThresholds)) {
                                const segH = plotHeight * segment.height
                                if (!(segH > 0)) continue
                                const segY = isSecondaryZoned
                                    ? (bottom - yOffset - segH)
                                    : (top + yOffset)
                                bigWigMarkup.push(
                                    `<rect x="${x}" y="${segY}" width="${colW}" height="${segH}" fill="${escapeXml(zoneColors[segment.zone] || zoneColors[zoneColors.length - 1])}" />`
                                )
                                yOffset += segH
                            }
                        }
                        for (const boundary of boundaryValues) {
                            const y = zoneYForValue(boundary)
                            bigWigAxisMarkup.push(
                                `<text x="${viewWidth - 4}" y="${y}" fill="${escapeXml(isLight ? '#64748b' : '#94a3b8')}" text-anchor="end" dominant-baseline="middle" style="font:${escapeXml(sansFont(9))};">${escapeXml(formatZoneLabel(boundary))}</text>`
                            )
                        }
                    } else if (renderMode === 'signal_plot') {
                        const yMin = Math.min(0, observedMin)
                        const yMax = Math.max(0, observedMax)
                        const yRange = Math.max(1e-9, yMax - yMin)
                        const toY = (value) => bottom - ((value - yMin) / yRange) * plotHeight
                        const zeroY = clamp(toY(0), top, bottom)
                        const plotColor = normalizeBigWigHexColor(bigWigSettings?.plot_color, BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.plot_color)
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${zeroY}" x2="${right}" y2="${zeroY}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(148, 163, 184, 0.32)')}" stroke-width="1" />`
                        )
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${zeroY}" x2="${right}" y2="${zeroY}" stroke="${escapeXml(hexToRgba(plotColor, isLight ? 0.18 : 0.26))}" stroke-width="1" />`
                        )
                        const segments = []
                        const zeroBridges = []
                        let current = []
                        let gapStartX = null
                        let gapEndX = null
                        for (let i = 0; i < values.length; i += 1) {
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
                            current.push({
                                x: left + (i + 0.5) * binWidth,
                                y: clamp(toY(value), top, bottom),
                            })
                        }
                        if (current.length > 0) segments.push(current)
                        if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                            zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                        }
                        for (const segment of segments) {
                            if (segment.length === 0) continue
                            if (segment.length === 1) {
                                const p = segment[0]
                                bigWigMarkup.push(
                                    `<line x1="${p.x}" y1="${zeroY}" x2="${p.x}" y2="${p.y}" stroke="${escapeXml(hexToRgba(plotColor, 0.94))}" stroke-width="1.5" />`
                                )
                                continue
                            }
                            const areaPath = [`M ${segment[0].x} ${zeroY}`, `L ${segment[0].x} ${segment[0].y}`]
                            const strokePath = [`M ${segment[0].x} ${segment[0].y}`]
                            for (let i = 1; i < segment.length; i += 1) {
                                areaPath.push(`L ${segment[i].x} ${segment[i].y}`)
                                strokePath.push(`L ${segment[i].x} ${segment[i].y}`)
                            }
                            areaPath.push(`L ${segment[segment.length - 1].x} ${zeroY}`, 'Z')
                            bigWigMarkup.push(
                                `<path d="${escapeXml(areaPath.join(' '))}" fill="${escapeXml(hexToRgba(plotColor, 0.28))}" />`
                            )
                            bigWigMarkup.push(
                                `<path d="${escapeXml(strokePath.join(' '))}" fill="none" stroke="${escapeXml(hexToRgba(plotColor, 0.94))}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />`
                            )
                        }
                        for (const gap of zeroBridges) {
                            bigWigMarkup.push(
                                `<line x1="${gap.x1}" y1="${zeroY}" x2="${gap.x2}" y2="${zeroY}" stroke="${escapeXml(hexToRgba(plotColor, isLight ? 0.52 : 0.62))}" stroke-width="1" stroke-dasharray="4 3" />`
                            )
                        }
                        const axisX = viewWidth - 14
                        bigWigAxisMarkup.push(
                            `<line x1="${axisX}" y1="${top}" x2="${axisX}" y2="${bottom}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)')}" stroke-width="1" />`
                        )
                        const ticks = [
                            { y: top, value: yMax },
                            { y: top + plotHeight / 2, value: (yMin + yMax) / 2 },
                            { y: bottom, value: yMin },
                        ]
                        for (const tick of ticks) {
                            bigWigAxisMarkup.push(
                                `<line x1="${axisX - 4}" y1="${tick.y}" x2="${axisX}" y2="${tick.y}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)')}" stroke-width="1" />`
                            )
                            bigWigAxisMarkup.push(
                                `<text x="${viewWidth - 4}" y="${tick.y}" fill="${escapeXml(isLight ? '#64748b' : '#94a3b8')}" text-anchor="end" dominant-baseline="middle" style="font:${escapeXml(sansFont(9))};">${escapeXml(formatSignalValueForTrack(tick.value))}</text>`
                            )
                        }
                    }

                    if (bigWigMarkup.length > 0) {
                        pushOverlayMarkup(mirrorCustomTrackMarkup(bigWigMarkup.join('')) + bigWigAxisMarkup.join(''))
                    }
                }
            }

            if (isIntervalTrackType(trackType) && data?.mode === 'bed_density' && Array.isArray(data.density_bins) && data.density_bins.length > 0) {
                const left = LHS_WIDTH + 2
                const right = viewWidth - 2
                const plotWidth = Math.max(1, right - left)
                const top = trackLayout.y + 18
                const barBottom = trackLayout.y + trackLayout.height - 9
                const barArea = Math.max(4, barBottom - top - 2)
                const maxCount = Math.max(1, Number(data.max_count) || 1)
                const trackColors = bedTrackColors(track)
                const fill = hexToRgba(trackColors.chosen || trackColors.fallback || '#059669', isLight ? 0.78 : 0.84)
                const viewSpan = Math.max(1, viewEnd - viewStart)
                const columnCount = Math.max(1, Math.ceil(plotWidth))
                const columns = new Float32Array(columnCount)
                for (const bin of data.density_bins) {
                    const s = Number(bin?.start)
                    const e = Number(bin?.end)
                    const v = Number(bin?.count) || 0
                    if (!(v > 0) || !(e > viewStart) || !(s < viewEnd)) continue
                    const c0 = Math.max(0, Math.floor(((Math.max(s, viewStart) - viewStart) / viewSpan) * plotWidth))
                    const c1 = Math.min(columnCount - 1, Math.ceil(((Math.min(e, viewEnd) - viewStart) / viewSpan) * plotWidth) - 1)
                    for (let c = c0; c <= Math.max(c0, c1); c += 1) if (v > columns[c]) columns[c] = v
                }
                textMaskRects.push({
                    x: left,
                    y: trackLayout.y,
                    width: viewWidth - left,
                    height: trackLayout.height,
                    fill: getExportTrackBgColor(trackId),
                })
                const densityMarkup = []
                for (let c = 0; c < columnCount; c += 1) {
                    const v = columns[c]
                    if (!(v > 0)) continue
                    const h = Math.max(1, Math.round((Math.min(v, maxCount) / maxCount) * barArea))
                    densityMarkup.push(`<rect x="${left + c}" y="${barBottom - h}" width="1" height="${h}" fill="${escapeXml(fill)}" />`)
                }
                if (densityMarkup.length > 0) {
                    pushOverlayMarkup(mirrorCustomTrackMarkup(densityMarkup.join('')))
                }
            }

            if (isIntervalTrackType(trackType) && data?.mode === 'bigbed_blocks' && Array.isArray(data.block_spans) && data.block_spans.length > 0) {
                const left = LHS_WIDTH + 2
                const right = viewWidth - 2
                const plotWidth = Math.max(1, right - left)
                const top = trackLayout.y + 18
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                const blockY = top + Math.round((plotHeight - blockH) / 2)
                const bigBedMarkup = []
                const gToX = (g) => left + (((g - viewStart) / Math.max(1, viewEnd - viewStart)) * plotWidth)
                const trackColors = bedTrackColors(track)
                textMaskRects.push({
                    x: left,
                    y: trackLayout.y,
                    width: viewWidth - left,
                    height: trackLayout.height,
                    fill: getExportTrackBgColor(trackId),
                })
                for (const span of data.block_spans) {
                    const s = Number(span?.start)
                    const e = Number(span?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                    const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                    const drawW = x2 - x1
                    if (drawW <= 0) continue
                    const fill = bigBedBlockColor(span, isLight, trackColors)
                    const drawWidth = Math.max(1, drawW)
                    bigBedMarkup.push(
                        `<rect x="${x1}" y="${blockY}" width="${drawWidth}" height="${blockH}" fill="${escapeXml(fill)}" />`
                    )
                    if (drawWidth > 2) {
                        bigBedMarkup.push(
                            `<rect x="${x1 + 0.5}" y="${blockY + 0.5}" width="${Math.max(0.5, drawWidth - 1)}" height="${Math.max(0.5, blockH - 1)}" fill="none" stroke="${escapeXml(bigBedBlockStroke(isLight, trackColors))}" stroke-width="0.7" />`
                        )
                    }
                }
                if (bigBedMarkup.length > 0) {
                    pushOverlayMarkup(mirrorCustomTrackMarkup(bigBedMarkup.join('')))
                }
            }

            if (isIntervalTrackType(trackType) && data?.mode === 'bigbed_detail' && Array.isArray(data.features) && data.features.length > 0) {
                const left = LHS_WIDTH + 2
                const right = viewWidth - 2
                const plotWidth = Math.max(1, right - left)
                const top = trackLayout.y + 18
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const lanePitch = bigBedLanePitch(data?.labelled)
                const exonH = BIGBED_DETAIL_EXON_HEIGHT
                const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                const maxVisibleLanes = getBigBedLaneCapacity(plotHeight, lanePitch)
                const clickedKey = clickedBigBedFeature?.trackId === trackId
                    ? bigBedFeatureKey(clickedBigBedFeature.feature)
                    : ''
                const hoveredKey = clickedKey
                    ? ''
                    : (hoveredBigBedFeature?.trackId === trackId ? hoveredBigBedFeature.key : '')
                const gToX = (g) => left + (((g - viewStart) / Math.max(1, viewEnd - viewStart)) * plotWidth)
                const trackColors = bedTrackColors(track)
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
                const trackBgColor = getExportTrackBgColor(trackId)
                const bigBedMarkup = []
                let bigBedOverflowMarkup = ''
                textMaskRects.push({
                    x: left,
                    y: trackLayout.y,
                    width: viewWidth - left,
                    height: trackLayout.height,
                    fill: trackBgColor,
                })

                for (const feature of visibleFeatures) {
                    const s = Number(feature?.start)
                    const e = Number(feature?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                    const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                    const y = yMid - exonH / 2
                    if (y + exonH < top || y > bottom) continue

                    const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                    const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
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
                    const featureOpacity = dimmed ? 0.2 : (isFocused ? 1 : (isHovered ? 1 : 0.86))
                    const isTranscript = feature?._render_kind === 'transcript'
                        && feature?._structure_valid === true
                        && Array.isArray(feature?._exon_blocks)
                        && feature._exon_blocks.length > 0

                    if (isTranscript) {
                        const txBounds = getCustomTrackIntervalPixelBounds(s, e - 1, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                        const txX1 = txBounds ? Math.max(left, txBounds.x1) : Math.max(left, gToX(Math.max(viewStart, s)))
                        const txX2 = txBounds ? Math.min(right, txBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, e)))
                        const txDrawW = txX2 - txX1
                        if (txDrawW > 0) {
                            bigBedMarkup.push(
                                `<line x1="${txX1}" y1="${yMid + 0.5}" x2="${txX2}" y2="${yMid + 0.5}" stroke="${escapeXml(strokeColor)}" stroke-width="${INTRON_HEIGHT}" opacity="${featureOpacity}" />`
                            )
                        }

                        const strand = String(feature?.strand || '.')
                        if ((strand === '+' || strand === '-') && txDrawW >= 30) {
                            const visuallyForward = txX1 <= txX2 ? (strand === '+') : (strand === '-')
                            const chevronColor = isFocused
                                ? strokeColor
                                : (isLight ? 'rgba(51,65,85,0.58)' : 'rgba(203,213,225,0.52)')
                            const spacing = Math.max(20, txDrawW / 15)
                            for (let cx = txX1 + 10; cx <= txX2 - 10; cx += spacing) {
                                const chevDir = visuallyForward ? 3.4 : -3.4
                                bigBedMarkup.push(
                                    `<path d="M ${cx - chevDir} ${yMid - 3.3} L ${cx} ${yMid} L ${cx - chevDir} ${yMid + 3.3}" fill="none" stroke="${escapeXml(chevronColor)}" stroke-width="1" opacity="${featureOpacity}" />`
                                )
                            }
                        }

                        const exonStrokeWidth = isFocused ? 1.8 : (isHovered ? 1.45 : 1.2)
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
                                const sx1 = segBounds ? Math.max(left, segBounds.x1) : Math.max(left, gToX(Math.max(viewStart, seg.start)))
                                const sx2 = segBounds ? Math.min(right, segBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, seg.end)))
                                const segW = sx2 - sx1
                                if (segW <= 0) continue

                                const drawH = exonH
                                const segY = yMid - drawH / 2
                                const strokeInset = exonStrokeWidth / 2
                                const drawX = sx1 + strokeInset
                                const drawY = segY + strokeInset
                                const boxW = Math.max(0.5, segW - exonStrokeWidth)
                                const boxH = Math.max(0.5, drawH - exonStrokeWidth)

                                bigBedMarkup.push(
                                    `<rect x="${sx1}" y="${segY}" width="${segW}" height="${drawH}" fill="${escapeXml(trackBgColor)}" opacity="${featureOpacity}" />`
                                )
                                if (seg.coding) {
                                    bigBedMarkup.push(
                                        `<rect x="${drawX}" y="${drawY}" width="${boxW}" height="${boxH}" fill="${escapeXml(codingFillColor)}" opacity="${featureOpacity}" />`
                                    )
                                }
                                bigBedMarkup.push(
                                    `<rect x="${drawX}" y="${drawY}" width="${boxW}" height="${boxH}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${exonStrokeWidth}" opacity="${featureOpacity}" />`
                                )
                            }
                        }
                    } else if (feature?._thick) {
                        const strokeWidth = isFocused ? 2 : (isHovered ? 1.5 : 0.9)
                        for (const piece of bedThickPieces(feature, gToX, { left, right, viewStart, viewEnd, yMid, exonH })) {
                            bigBedMarkup.push(
                                `<rect x="${piece.x}" y="${piece.y}" width="${piece.w}" height="${piece.h}" fill="${escapeXml(color.fill)}" opacity="${featureOpacity}" />`
                            )
                            if (piece.w > 2) {
                                bigBedMarkup.push(
                                    `<rect x="${piece.x + 0.5}" y="${piece.y + 0.5}" width="${Math.max(0.5, piece.w - 1)}" height="${Math.max(0.5, piece.h - 1)}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${strokeWidth}" opacity="${featureOpacity}" />`
                                )
                            }
                        }
                    } else {
                        const drawWidth = Math.max(1, drawW)
                        bigBedMarkup.push(
                            `<rect x="${x1}" y="${y}" width="${drawWidth}" height="${exonH}" fill="${escapeXml(color.fill)}" opacity="${featureOpacity}" />`
                        )
                        if (drawWidth > 2) {
                            bigBedMarkup.push(
                                `<rect x="${x1 + 0.5}" y="${y + 0.5}" width="${Math.max(0.5, drawWidth - 1)}" height="${Math.max(0.5, exonH - 1)}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${isFocused ? 2 : (isHovered ? 1.5 : 0.9)}" opacity="${featureOpacity}" />`
                            )
                        }
                    }
                    if (data.labelled && feature?.name) {
                        // Mirrored markup reflects x and swaps the anchor, so a flipped
                        // panel anchors the name at the feature's end: it lands on the
                        // feature's left end on screen, as the canvas draws it.
                        bigBedMarkup.push(
                            `<text x="${isFlipped ? x2 : Math.max(left + 1, x1)}" y="${yMid + exonH / 2 + 1.5}" fill="${escapeXml(isFocused ? strokeColor : colors.geneLabelText)}" text-anchor="${isFlipped ? 'end' : 'start'}" dominant-baseline="hanging" opacity="${featureOpacity}" style="font:${escapeXml(sansFont(BIGBED_DETAIL_LABEL_FONT_PX))};">${escapeXml(String(feature.name))}</text>`
                        )
                    }
                }

                if (overflowCount > 0) {
                    bigBedOverflowMarkup = (
                        `<text x="${right - 3}" y="${bottom - 1}" fill="${escapeXml(isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)')}" text-anchor="end" dominant-baseline="text-after-edge" style="font:${escapeXml(sansFont(9))};">+${escapeXml(String(overflowCount))} overflow</text>`
                    )
                }

                if (bigBedMarkup.length > 0) {
                    pushOverlayMarkup(mirrorCustomTrackMarkup(bigBedMarkup.join('')) + bigBedOverflowMarkup)
                }
            }
        }

        if (showSequenceTrack && layout.SEQUENCE_Y >= 0 && !effectiveHiddenStrands.sequence) {
            const seqY = layout.SEQUENCE_Y
            const seqTrackViewH = layout.seqBgHeight
            const seqBoxT = Math.round(seqY + 6)
            const seqBoxH = 24
            const seqPxPerBp = trackWidth / viewSpan
            const seqTrackBg = getExportTrackBgColor('sequence')
            const sequenceMarkup = []

            if (isAligned && alignData && viewSpan <= 1000 && seqPxPerBp >= 2) {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                const seqFont = seqPxPerBp >= 10 ? monoFont(12) : monoFont(9)
                const startIdx = Math.floor(viewStart)
                const endIdx = Math.ceil(viewEnd)
                const alnLen = alignData.sequence.length
                for (let i = startIdx; i < endIdx; i += 1) {
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
                    // Trimmed to the track area: the view can start part-way through a base.
                    const baseBounds = getBasePixelBounds(i, seqPxPerBp)
                    const bxL = Math.max(baseBounds.bxL, LHS_WIDTH)
                    const bxR = Math.min(baseBounds.bxR, viewWidth)
                    const bxW = bxR - bxL
                    if (bxW <= 0) continue
                    const alignedBp = Math.round(overlayToGenomic(i))
                    sequenceMarkup.push(
                        `<rect x="${bxL}" y="${seqBoxT}" width="${bxW}" height="${seqBoxH}" fill="${escapeXml(getBaseColor(displayBase, colors))}" />`
                    )
                    if (seqPxPerBp >= 6 && bxW >= 2) {
                        const sepX = bxR - 0.5
                        sequenceMarkup.push(
                            `<line x1="${sepX}" y1="${seqBoxT + 0.5}" x2="${sepX}" y2="${seqBoxT + seqBoxH - 0.5}" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)')}" stroke-width="1" />`
                        )
                    }
                    if (hoveredSeqBase?.bp === alignedBp && bxW >= 2) {
                        sequenceMarkup.push(
                            `<rect x="${bxL + 1}" y="${seqBoxT + 1}" width="${Math.max(0, bxW - 2)}" height="${seqBoxH - 2}" fill="none" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')}" stroke-width="2" />`
                        )
                    }
                    if (seqPxPerBp >= 10) {
                        sequenceMarkup.push(
                            `<text x="${bxL + bxW / 2}" y="${seqBoxT + seqBoxH / 2}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" style="font:${escapeXml(seqFont)};">${escapeXml(displayBase.toUpperCase())}</text>`
                        )
                    }
                }
            } else if (sequence && seqRange && viewSpan <= 1000 && seqPxPerBp >= 2) {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                const seqFont = seqPxPerBp >= 10 ? monoFont(12) : monoFont(9)
                for (let i = 0; i < sequence.length; i += 1) {
                    const bp = seqRange.start + i
                    if (bp + 1 <= viewStart || bp >= viewEnd) continue
                    const base = sequence[i]
                    const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                    // Trimmed to the track area: the view can start part-way through a base.
                    const baseBounds = getBasePixelBounds(bp, seqPxPerBp)
                    const bxL = Math.max(baseBounds.bxL, LHS_WIDTH)
                    const bxR = Math.min(baseBounds.bxR, viewWidth)
                    const bxW = bxR - bxL
                    if (bxW <= 0) continue
                    sequenceMarkup.push(
                        `<rect x="${bxL}" y="${seqBoxT}" width="${bxW}" height="${seqBoxH}" fill="${escapeXml(getBaseColor(displayBase, colors))}" />`
                    )
                    if (seqPxPerBp >= 6 && bxW >= 2) {
                        const sepX = bxR - 0.5
                        sequenceMarkup.push(
                            `<line x1="${sepX}" y1="${seqBoxT + 0.5}" x2="${sepX}" y2="${seqBoxT + seqBoxH - 0.5}" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)')}" stroke-width="1" />`
                        )
                    }
                    if (hoveredSeqBase?.bp === bp && bxW >= 2) {
                        sequenceMarkup.push(
                            `<rect x="${bxL + 1}" y="${seqBoxT + 1}" width="${Math.max(0, bxW - 2)}" height="${seqBoxH - 2}" fill="none" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')}" stroke-width="2" />`
                        )
                    }
                    if (seqPxPerBp >= 10) {
                        sequenceMarkup.push(
                            `<text x="${bxL + bxW / 2}" y="${seqBoxT + seqBoxH / 2}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" style="font:${escapeXml(seqFont)};">${escapeXml(displayBase.toUpperCase())}</text>`
                        )
                    }
                }
            } else {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                sequenceMarkup.push(
                    `<text x="${LHS_WIDTH + (viewWidth - LHS_WIDTH) / 2}" y="${seqY + seqTrackViewH / 2 + 4}" fill="${escapeXml(isLight ? '#868e96' : '#5c5f66')}" text-anchor="middle" dominant-baseline="alphabetic" style="font:${escapeXml(sansFont(9))};">zoom in to see sequence</text>`
                )
            }

            pushOverlayMarkup(sequenceMarkup.join(''))
        }

        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts || {})) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue
            const trackType = track.type || 'bigwig'
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const data = customTrackData[trackId]
            if (!(trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode) && data?.mode === 'adp_detail')) continue

            const left = LHS_WIDTH + 2
            const right = viewWidth - 2
            const plotWidth = Math.max(1, right - left)
            const top = trackLayout.y + 18
            const bottom = trackLayout.y + trackLayout.height - 8
            const plotHeight = Math.max(8, bottom - top)
            const barH = Math.max(5, Math.floor(plotHeight * 0.13))
            const barY = top + Math.floor((plotHeight - barH) / 2)
            const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * plotWidth
            const variants = Array.isArray(data?.variants) ? data.variants : []
            const hb = hoveredVcfBlock
            const cvPos = clickedVcfVariant?.variant?.pos
            const cvType = clickedVcfVariant ? localVcfType(clickedVcfVariant.variant) : null
            const vcfSettings = normalizeVcfSettings(track?.vcfSettings || track?.vcf_settings)
            const vcfGenicColor = vcfSettings?.genic_color || VCF_SETTINGS_DEFAULTS.genic_color
            const vcfIntergenicColor = vcfSettings?.intergenic_color || VCF_SETTINGS_DEFAULTS.intergenic_color
            const VARIANT_FILL = {
                snv: isLight ? '#4a7cf5' : '#7ab4fc',
                ins: isLight ? '#16a34a' : '#4ade80',
                del: isLight ? '#d97706' : '#fbbf24',
                indel: isLight ? '#9333ea' : '#c084fc',
            }
            const VARIANT_STROKE = {
                snv: isLight ? 'rgba(30,60,160,0.75)' : 'rgba(120,170,255,0.65)',
                ins: isLight ? 'rgba(10,100,30,0.75)' : 'rgba(100,220,130,0.65)',
                del: isLight ? 'rgba(150,80,0,0.75)' : 'rgba(250,180,50,0.65)',
                indel: isLight ? 'rgba(100,20,160,0.75)' : 'rgba(190,100,250,0.65)',
            }
            const ANCHOR_FILL_ACTIVE = isLight ? '#3b82f6' : '#60a5fa'
            const ANCHOR_STROKE = isLight ? 'rgba(30,64,175,0.9)' : 'rgba(191,219,254,0.95)'
            const showIndelMarkers = bpPerPx <= 1
            const showIndelLabels = bpPerPx <= 0.5
            const viewGenicGenes = !isAligned
                ? genes.filter((g) => Number(g.end) >= viewStart && Number(g.start) <= viewEnd)
                : []
            const isPosiGenic = (pos) =>
                viewGenicGenes.some((g) => Number(g.start) <= pos && Number(g.end) >= pos)

            textMaskRects.push({
                x: left,
                y: trackLayout.y,
                width: plotWidth,
                height: trackLayout.height,
                fill: getExportTrackBgColor(trackId),
            })

            const vcfMarkup = []
            if (bpPerPx <= 1) {
                const occupiedPos = new Set(
                    variants
                        .filter((v) => localVcfType(v) === 'snv')
                        .map((v) => Number(v?.pos))
                        .filter(Number.isFinite)
                )
                for (let bp = Math.floor(viewStart); bp <= Math.ceil(viewEnd); bp += 1) {
                    if (occupiedPos.has(bp)) continue
                    const bxL = blockGToX(bp)
                    const bxR = blockGToX(bp + 1)
                    const drawL = Math.max(left, bxL)
                    const drawR = Math.min(right, bxR)
                    const drawW = drawR - drawL
                    if (drawW <= 0) continue
                    const regionColor = isPosiGenic(bp) ? vcfGenicColor : vcfIntergenicColor
                    vcfMarkup.push(
                        `<rect x="${drawL + 0.5}" y="${barY + 0.5}" width="${Math.max(0, drawW - 1)}" height="${barH - 1}" fill="none" stroke="${escapeXml(regionColor)}" stroke-width="1" />`
                    )
                }
            }

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
                    if (seenIndel.has(key)) continue
                    seenIndel.add(key)
                    const nBars = getVcfAltAlleleCount(v)
                    const xGenomic = layoutInfo.markerXGenomic
                    const x = blockGToX(Math.max(viewStart, xGenomic))
                    const primaryDir = vtype === 'ins' ? 'up' : 'down'
                    const altDir = primaryDir === 'up' ? 'down' : 'up'
                    let dir = primaryDir
                    let level = 0
                    if (showIndelLabels) {
                        const MAX_LEVEL = 3
                        let lP = 0
                        let lA = 0
                        for (const existing of indelItems) {
                            const leftNBars = existing.x <= x ? existing.nBars : nBars
                            const inProximity = Math.abs(existing.x - x) < Math.max(50, 7 + leftNBars * 14 + 5)
                            if (inProximity) {
                                if (existing.dir === primaryDir) lP = Math.max(lP, existing.level + 1)
                                if (existing.dir === altDir) lA = Math.max(lA, existing.level + 1)
                            }
                        }
                        lP = Math.min(lP, MAX_LEVEL)
                        lA = Math.min(lA, MAX_LEVEL)
                        if (lA < lP) {
                            dir = altDir
                            level = lA
                        } else {
                            dir = primaryDir
                            level = lP
                        }
                    }
                    indelItems.push({ v, vpos, x, dir, level, nBars })
                }
            }

            const drawSegmentMarkup = ({
                segStart,
                segEnd,
                fillColor,
                strokeColor,
                activeStroke = null,
                alpha = 0.9,
                strokeWidth = 1,
            }) => {
                if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return null
                const x1 = blockGToX(Math.max(viewStart, segStart))
                const x2 = blockGToX(Math.min(viewEnd, segEnd))
                const drawStart = Math.max(left, Math.min(x1, x2))
                const drawEnd = Math.min(right, Math.max(x1, x2))
                const drawW = drawEnd - drawStart
                if (drawW <= 0) return null
                vcfMarkup.push(
                    `<rect x="${drawStart}" y="${barY}" width="${Math.max(1, drawW)}" height="${barH}" style="fill:${fillColor};fill-opacity:${alpha};stroke:${escapeXml(activeStroke || strokeColor)};stroke-width:${strokeWidth};" />`
                )
                return { drawStart, drawW }
            }

            const drawVariantBlock = (variant, topPass) => {
                const vtype = localVcfType(variant)
                const layoutInfo = getVcfDetailVariantLayout(variant, vtype)
                const vpos = layoutInfo.vpos
                if (!Number.isFinite(vpos)) return
                const visibleStart = Math.min(layoutInfo.anchorStart, layoutInfo.refStart)
                const visibleEnd = Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
                if (visibleStart > viewEnd || visibleEnd < viewStart) return
                const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
                const isClicked = cvPos === vpos && cvType === vtype
                const active = isHovered || isClicked
                if (topPass !== active) return
                const activeStroke = isClicked
                    ? (isLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,1.0)')
                    : isHovered
                        ? (isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)')
                        : null
                const strokeWidth = isClicked ? 2.5 : isHovered ? 2 : 1

                if (vtype === 'ins' || vtype === 'del') {
                    if (vtype === 'del' && layoutInfo.hasDelSpan) {
                        drawSegmentMarkup({
                            segStart: layoutInfo.refStart,
                            segEnd: layoutInfo.refEnd,
                            fillColor: VARIANT_FILL.del,
                            strokeColor: VARIANT_STROKE.del,
                            activeStroke,
                            strokeWidth,
                        })
                    }
                    if (shouldRenderActiveAnchorBase(vtype, active)) {
                        const anchorSeg = drawSegmentMarkup({
                            segStart: layoutInfo.anchorStart,
                            segEnd: layoutInfo.anchorEnd,
                            fillColor: ANCHOR_FILL_ACTIVE,
                            strokeColor: ANCHOR_STROKE,
                            activeStroke,
                            alpha: 1,
                            strokeWidth,
                        })
                        if (anchorSeg && ANCHOR_ICON_BODY) {
                            const anchorCx = anchorSeg.drawStart + (anchorSeg.drawW / 2)
                            const margin = 0.5
                            const targetH = Math.max(4, barH - margin * 2)
                            const targetW = Math.max(4, Math.min(anchorSeg.drawW - margin * 2, targetH * 1.05))
                            const iH = Math.max(4, targetH * 0.9)
                            const iW = Math.max(4, targetW * 0.9)
                            const x = anchorCx - (iW / 2)
                            const y = (barY + barH / 2) - (iH / 2)
                            vcfMarkup.push(
                                `<g transform="translate(${x} ${y}) scale(${iW / 32} ${iH / 32})" fill="${escapeXml(isLight ? '#0f172a' : '#e2e8f0')}">${ANCHOR_ICON_BODY}</g>`
                            )
                        }
                    }
                    return
                }

                const seg = drawSegmentMarkup({
                    segStart: layoutInfo.refStart,
                    segEnd: layoutInfo.refEnd,
                    fillColor: vtype === 'snv'
                        ? (isPosiGenic(vpos) ? vcfGenicColor : vcfIntergenicColor)
                        : (VARIANT_FILL[vtype] || (isLight ? '#64748b' : '#94a3b8')),
                    strokeColor: vtype === 'snv'
                        ? (isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)')
                        : (VARIANT_STROKE[vtype] || (isLight ? 'rgba(60,60,60,0.6)' : 'rgba(200,200,200,0.5)')),
                    activeStroke,
                    strokeWidth,
                })
                if (!seg) return
                if (vtype === 'snv' && seg.drawW >= 14) {
                    vcfMarkup.push(
                        `<text x="${seg.drawStart + seg.drawW / 2}" y="${barY - 4}" fill="${escapeXml(active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#1e3a8a' : '#93c5fd'))}" text-anchor="middle" dominant-baseline="alphabetic" style="font:${escapeXml(sansFont(9))};">${escapeXml(variant.label || 'SNV')}</text>`
                    )
                }
            }

            for (const variant of variants) {
                if (localVcfType(variant) !== 'snv') drawVariantBlock(variant, false)
            }
            for (const variant of variants) {
                if (localVcfType(variant) === 'snv') drawVariantBlock(variant, false)
            }
            for (const variant of variants) {
                drawVariantBlock(variant, true)
            }

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
                    const dotY = dir === 'up' ? (barY - lineLen) : (barY + barH + lineLen)
                    const dotR = active ? 5 : 4
                    vcfMarkup.push(
                        `<line x1="${x}" y1="${dir === 'up' ? barY : barY + barH}" x2="${x}" y2="${dotY}" stroke="${escapeXml(isLight ? 'rgba(80,80,80,0.55)' : 'rgba(200,200,200,0.5)')}" stroke-width="${active ? 1.5 : 1}" stroke-dasharray="3 3" />`
                    )
                    vcfMarkup.push(
                        `<circle cx="${x}" cy="${dotY}" r="${dotR}" style="fill:${dotColor};stroke:${escapeXml(active ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)') : (isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)'))};stroke-width:${active ? 1.5 : 1};" />`
                    )
                    if (showIndelLabels) {
                        const abH = 3
                        const abLen = 12
                        const abGap = 2
                        const abStartX = x + dotR + 3
                        const abY = dir === 'up'
                            ? Math.min(dotY + dotR + 3, barY - abH - 5)
                            : Math.max(barY + barH + 5, dotY - dotR - abH - 3)
                        for (let i = 0; i < nBars; i += 1) {
                            vcfMarkup.push(
                                `<rect x="${abStartX + i * (abLen + abGap)}" y="${abY}" width="${abLen}" height="${abH}" fill="${escapeXml(dotColor)}" fill-opacity="${active ? 0.85 : 0.55}" />`
                            )
                        }
                        const label = vtype === 'ins' ? 'ins' : vtype === 'del' ? 'del' : 'indel'
                        vcfMarkup.push(
                            `<text x="${x + dotR + 3}" y="${dotY + 3}" fill="${escapeXml(active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#334155' : '#cbd5e1'))}" text-anchor="start" dominant-baseline="alphabetic" style="font:${escapeXml(active ? sansFont(9, 'bold') : sansFont(9))};">${escapeXml(label)}</text>`
                        )
                    }
                }
            }

            pushOverlayMarkup(mirrorCustomTrackMarkup(vcfMarkup.join('')))
        }

        // The note bubbles are DOM over the canvas, so the raster below has no
        // trace of them — an export would otherwise drop the one mark saying
        // this gene has been written about. Their coordinates are already
        // canvas-local, which is the space these sections are emitted in.
        const noteBubbles = geneNoteOverlayRef.current?.bubbles || []
        if (noteBubbles.length > 0) {
            const bubbleColor = escapeXml(panelPillColor)
            pushOverlayMarkup(noteBubbles.map((bubble) => noteBubbleGlyphSvgMarkup({
                x: bubble.x + (NOTE_BUBBLE_SIZE / 2),
                y: bubble.y + (NOTE_BUBBLE_SIZE / 2),
                size: NOTE_BUBBLE_SIZE,
                color: bubbleColor,
                fill: true,
                knockout: escapeXml(colors.bg),
            })).join(''))
        }

        let canvasImageHref = canvas.toDataURL('image/png')
        if (sidebarToggleDescriptors.length > 0 || textMaskRects.length > 0) {
            const exportCanvas = document.createElement('canvas')
            exportCanvas.width = canvas.width
            exportCanvas.height = canvas.height
            const exportCtx = exportCanvas.getContext('2d')
            if (exportCtx) {
                exportCtx.drawImage(canvas, 0, 0)
                const scaleX = exportCanvas.width / Math.max(1, canvas.clientWidth || width || 1)
                const scaleY = exportCanvas.height / Math.max(1, canvas.clientHeight || canvasHeight || 1)
                for (const maskRect of textMaskRects) {
                    exportCtx.fillStyle = maskRect.fill
                    exportCtx.fillRect(
                        maskRect.x * scaleX,
                        maskRect.y * scaleY,
                        maskRect.width * scaleX,
                        maskRect.height * scaleY
                    )
                }
                for (const descriptor of sidebarToggleDescriptors) {
                    const half = (SIDEBAR_TOGGLE_ICON_SIZE / 2) + 1
                    exportCtx.save()
                    exportCtx.translate(descriptor.x * scaleX, descriptor.y * scaleY)
                    exportCtx.scale(scaleX, scaleY)
                    exportCtx.fillStyle = descriptor.maskFill
                    exportCtx.fillRect(-half, -half, half * 2, half * 2)
                    exportCtx.restore()
                }
                canvasImageHref = exportCanvas.toDataURL('image/png')
            }
        }

        const sections = []
        let cursorY = 0
        const appendForeignObject = (node, height) => {
            if (!node || !(height > 0)) return
            const markup = buildForeignObjectMarkup(node, { width, height })
            if (!markup) return
            sections.push(
                `<foreignObject x="0" y="${cursorY}" width="${width}" height="${height}">${markup}</foreignObject>`
            )
            cursorY += height
        }

        if (effectiveToolbarPosition === 'top') appendForeignObject(toolbarNode, toolbarHeight)
        if (effectiveFocusBarPosition === 'top') appendForeignObject(focusNode, focusHeight)

        const canvasOffsetY = cursorY
        sections.push(
            `<image x="0" y="${cursorY}" width="${width}" height="${canvasHeight}" href="${escapeXml(canvasImageHref)}" preserveAspectRatio="none" />`
        )
        if (textDescriptors.length > 0) {
            sections.push(
                textDescriptors.map((descriptor) => (
                    `<text x="${descriptor.x}" y="${canvasOffsetY + descriptor.y}" fill="${escapeXml(descriptor.fill)}" text-anchor="${descriptor.textAnchor}" dominant-baseline="${descriptor.dominantBaseline}" style="font:${escapeXml(descriptor.font)};">${escapeXml(descriptor.text)}</text>`
                )).join('')
            )
        }
        if (overlayMarkupSections.length > 0) {
            sections.push(
                overlayMarkupSections.map((markup) => (
                    `<g data-export-overlay="detail-layer" transform="translate(0 ${canvasOffsetY})">${markup}</g>`
                )).join('')
            )
        }
        if (sidebarToggleDescriptors.length > 0) {
            sections.push(
                sidebarToggleDescriptors.map((descriptor) => (
                    `<g data-export-icon="sidebar-toggle">`
                    + powerGlyphSvgMarkup({
                        x: descriptor.x,
                        y: canvasOffsetY + descriptor.y,
                        size: SIDEBAR_TOGGLE_ICON_SIZE,
                        color: escapeXml(descriptor.iconColor),
                    })
                    + `</g>`
                )).join('')
            )
        }
        cursorY += canvasHeight

        if (effectiveFocusBarPosition === 'bottom') appendForeignObject(focusNode, focusHeight)
        if (effectiveToolbarPosition === 'bottom') appendForeignObject(toolbarNode, toolbarHeight)

        const svgMarkup = buildSvgDocument({
            width,
            height: cursorY,
            body: sections.join(''),
            backgroundColor: colors.bg,
        })

        return {
            width,
            height: cursorY,
            svgMarkup,
            backgroundColor: colors.bg,
        }
    }
