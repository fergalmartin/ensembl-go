// Overlays a Genome Browser panel draws in HTML over its canvas: transcript
// footers under expanded genes and gene note bubbles.
import { EXPANDED_FOOTER_INLINE_GAP, EXPANDED_FOOTER_LABEL_TOP_OFFSET, LHS_WIDTH } from './browserConstants.js'
import { measureExpandedFooterLabelWidth } from './canvasText.js'
import { TRANSCRIPT_FOOTER_CONTROL_HEIGHT, getGeneFooterGeometry, getTranscriptFooterControlState, intersectsRuler } from './genomeBrowserLabelLayout.js'
import { resolveGeneTranscriptView } from './genomeBrowserTranscriptView.js'
import { clamp } from './trackData.js'
import { NOTE_BUBBLE_GAP, NOTE_BUBBLE_MIN_GENE_WIDTH, NOTE_BUBBLE_SIZE } from './browserConstants.js'

export function renderTranscriptFooterOverlay(ctx) {
    const {
        CONTROL_GAP_PX,
        compressTranscripts,
        dimNonSelectedGenes,
        effectiveHiddenStrands,
        effectiveRulerHeight,
        expandedFooterPlacementByGeneId,
        genes,
        genomicToScreen,
        getDisplayTranscriptRows,
        getEffectiveTranscriptLimit,
        getGeneTranscriptView,
        isGeneHiddenFromTracks,
        isViewportTranscriptExpandMode,
        layout,
        selectedGene,
        transcriptCache,
        transcriptLayoutMetrics,
        viewWidth,
    } = ctx
        const controls = []
        // Flatten is a *height* control, not a "hide the gene's own controls" one: a gene
        // whose transcripts are showing still needs the way back, and a tutorial step
        // pointing at that control found nothing there. Compressed and window-wide-expanded
        // layouts do drop it — the first has no room, and in the second every gene is
        // expanded already, so a per-gene pill would be saying something untrue.
        if (compressTranscripts || isViewportTranscriptExpandMode) {
            return { controls }
        }
        const { FORWARD_Y, REVERSE_Y, RULER_Y } = layout

        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue
            const isSelected = selectedGene && selectedGene.id === gene.id
            const isDimmed = dimNonSelectedGenes && !!selectedGene && !isSelected

            const txs = transcriptCache[gene.id]
            if (!txs || txs.length === 0) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const geneWidth = Math.abs(rawGx2 - rawGx1)
            if (geneWidth < 60) continue

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const displayRows = getDisplayTranscriptRows(gene)
            const footer = getGeneFooterGeometry({
                gene,
                txs,
                getEffectiveTranscriptLimit,
                visibleTranscriptCount: displayRows.length,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue
            const displayFooter = expandedFooterPlacementByGeneId.get(String(gene.id)) || footer

            // Transcripts the user has hidden aren't waiting to be revealed by
            // this pill, so they don't count towards its "+N".
            const geneView = getGeneTranscriptView(gene.id)
            const transcriptIds = new Set(txs.map((tx) => String(tx?.id || '')))
            const hiddenIds = (geneView?.hidden || [])
                .map((id) => String(id))
                .filter((id) => transcriptIds.has(id))
            const expandableCount = hiddenIds.length
                ? resolveGeneTranscriptView({
                    transcripts: txs,
                    limit: txs.length,
                    hidden: hiddenIds,
                }).visibleCount
                : txs.length
            const controlState = getTranscriptFooterControlState(
                expandableCount,
                displayRows.filter((row) => !row.ghost).length,
            )
            // A gene with everything hidden has no expand/collapse control left,
            // but still needs the way back — so neither control alone is required.
            if (!controlState && hiddenIds.length === 0) continue

            const controlWidth = controlState
                ? Math.max(TRANSCRIPT_FOOTER_CONTROL_HEIGHT, (controlState.label.length * 6) + 8)
                : 0
            const restoreLabel = hiddenIds.length
                ? `Show ${hiddenIds.length} hidden`
                : ''
            const restoreWidth = restoreLabel ? (restoreLabel.length * 5.6) + 10 : 0
            const totalWidth = controlWidth + (restoreWidth ? restoreWidth + CONTROL_GAP_PX : 0)
            const isExpandedControl = controlState?.action === 'collapse'
            const expandedLabelWidth = isExpandedControl && displayFooter.label
                ? measureExpandedFooterLabelWidth(displayFooter.label)
                : 0
            const expandedGroupWidth = expandedLabelWidth
                ? expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP + totalWidth
                : 0
            const overlayWidth = Math.max(totalWidth, expandedGroupWidth)
            const groupX = clamp(
                displayFooter.x,
                LHS_WIDTH + 6,
                Math.max(LHS_WIDTH + 6, viewWidth - overlayWidth - 6),
            )
            // The same rule the canvas labels follow: a track's own controls stay in their
            // track. Reaching into the ruler makes both unreadable, and a compact panel
            // leaves no margin between the two for an overflow to land in.
            const rowTop = isExpandedControl
                ? displayFooter.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET
                : displayFooter.controlY
            if (intersectsRuler(rowTop, rowTop + TRANSCRIPT_FOOTER_CONTROL_HEIGHT, RULER_Y, effectiveRulerHeight)) {
                continue
            }

            controls.push({
                id: gene.id,
                x: groupX,
                controlX: isExpandedControl
                    ? groupX + expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP
                    : groupX,
                y: displayFooter.controlY,
                width: controlWidth,
                ...(controlState || {}),
                hasPrimary: Boolean(controlState),
                restoreLabel,
                restoreWidth,
                hiddenCount: hiddenIds.length,
                isDimmed,
                isFocused: gene.id === selectedGene?.id,
                totalTranscripts: txs.length,
                geneLabel: displayFooter.label || '',
                geneLabelY: displayFooter.labelY,
                isExpandedControl,
                trackBackground: displayFooter.trackBackground || '',
            })
        }
        return { controls }
    }

export function renderGeneNoteOverlay(ctx) {
    const {
        dimNonSelectedGenes,
        effectiveHiddenStrands,
        geneNoteCounts,
        genes,
        genomicToScreen,
        getEffectiveTranscriptLimit,
        isGeneHiddenFromTracks,
        isTranscriptDetailZoomActive,
        layout,
        selectedGene,
        transcriptCache,
        transcriptLayoutMetrics,
        viewWidth,
    } = ctx
        const bubbles = []
        // Only once the track is drawing transcripts. Zoomed out, a gene is a
        // block or a tick and a mark on it would be pointing at nothing.
        if (!isTranscriptDetailZoomActive) return { bubbles }
        if (!geneNoteCounts) return { bubbles }
        const { FORWARD_Y, REVERSE_Y } = layout

        for (const gene of genes) {
            const count = Number(geneNoteCounts[String(gene.id)] || 0)
            if (!(count > 0)) continue
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2)) continue
            if (Math.abs(rawGx2 - rawGx1) < NOTE_BUBBLE_MIN_GENE_WIDTH) continue
            // Flip-safe: a flipped view reverses genomicToScreen, so gene.start
            // is not reliably the left edge.
            const gx1 = Math.min(rawGx1, rawGx2)

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const footer = getGeneFooterGeometry({
                gene,
                txs: transcriptCache[gene.id],
                getEffectiveTranscriptLimit,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue

            const top = footer.topY - NOTE_BUBBLE_SIZE - NOTE_BUBBLE_GAP
            // Compressed and flattened layouts leave 1-2px of track padding, so
            // there is simply nowhere to put the mark. Suppressed by the space
            // available rather than by naming the modes, which keeps it drawn
            // wherever it does fit.
            if (top < trackY + 1) continue

            bubbles.push({
                id: gene.id,
                gene,
                count,
                x: clamp(
                    gx1 - 1,
                    LHS_WIDTH + 2,
                    Math.max(LHS_WIDTH + 2, viewWidth - NOTE_BUBBLE_SIZE - 2),
                ),
                y: top,
                isDimmed: dimNonSelectedGenes && !!selectedGene && selectedGene.id !== gene.id,
            })
        }
        return { bubbles }
    }
