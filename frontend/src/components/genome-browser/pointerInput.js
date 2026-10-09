// Pointer input on a Genome Browser panel's canvas: clicks (selecting genes,
// transcripts, variants and features) and hover.
import { trackAchievement } from '../../achievements/tracker.js'
import { getVcfDetailVariantLayout, localVcfType } from '../../utils/vcfDetailGeometry.js'
import { DEFAULT_CUSTOM_TRACK_RENDER_MODE, LHS_WIDTH } from './browserConstants.js'
import { getSelectedGeneCoordsForView } from './browserFormat.js'
import { bigBedFeatureKey } from './trackData.js'
import { normalizeBigWigDisplayMode, normalizeBigWigSettings, normalizeVcfDisplayMode } from './trackSettings.js'
import { resolveDragAxis } from '../../utils/browsingControls.js'
import { spliceJunctionKey } from './spliceGeometry.js'
import { clamp } from './trackData.js'

export function handleBrowserCanvasClick(ctx, e) {
    const {
        alignData,
        animateToView,
        canvasRef,
        clearTranscriptPopupDismissTimer,
        clickedBigBedFeature,
        clickedGeneTranscript,
        clickedSeqBase,
        clickedSpliceJunction,
        clickedVcfVariant,
        customTrackData,
        customTracksById,
        dismissClickedGeneTranscript,
        effectiveHiddenStrands,
        focusTranscriptView,
        frameFocusRange,
        genes,
        genomicToOverlay,
        genomicToScreen,
        getCustomTrackGeometry,
        getCustomTrackHover,
        getGeneRowCountForWidth,
        getGeneTotalHeight,
        getSelectedGeneTranscriptHit,
        getSeqBaseAtMouse,
        isAligned,
        isBoxSelectMode,
        isGeneHiddenFromTracks,
        isSelectingRect,
        layout,
        onFocusTranscriptViewChangeRef,
        pendingVerticalCenterGeneIdRef,
        selectedChrom,
        selectedGene,
        setClickedBigBedFeature,
        setClickedGeneTranscript,
        setClickedSeqBase,
        setClickedSpliceJunction,
        setClickedVcfVariant,
        setSelectedGene,
        suppressNextClickRef,
        transcriptLayoutMetrics,
        transcriptPopupHoverRef,
        viewEnd,
        viewStart,
        viewWidth,
    } = ctx
        if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false
            return
        }
        if (isBoxSelectMode || isSelectingRect) return
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const clickX = e.clientX - rect.left
        const clickY = e.clientY - rect.top

        // Intercept sidebar (handled in mousedown)
        if (clickX <= LHS_WIDTH) return

        const openSelectedTranscriptPopup = (hit) => {
            if (!hit?.transcript) return
            // With a transcript already pinned in the drawer, clicking another
            // row in the track moves the pin to it. Only then: with nothing
            // pinned, a click means what it always meant and just opens the
            // popup.
            const currentPin = String(focusTranscriptView?.pinnedId || '').trim()
            const clickedId = String(hit.transcript.id || '')
            if (currentPin && clickedId && currentPin !== clickedId) {
                onFocusTranscriptViewChangeRef.current?.({
                    pinnedId: clickedId,
                    hoverId: null,
                    ghostId: null,
                })
            }
            clearTranscriptPopupDismissTimer()
            transcriptPopupHoverRef.current = false
            setClickedGeneTranscript((prev) => {
                const nextGeneId = hit.gene?.id || ''
                const nextTranscriptId = String(hit.transcript.id || '')
                const isSameTranscript = String(prev?.geneId || '') === nextGeneId
                    && String(prev?.transcriptId || '') === nextTranscriptId
                if (isSameTranscript) return null
                return {
                    geneId: nextGeneId,
                    transcriptId: nextTranscriptId,
                    transcript: hit.transcript,
                    arrowTargetX: rect.left + hit.anchorCanvasX,
                    arrowTargetY: rect.top + hit.anchorCanvasY,
                }
            })
        }
        const selectedTranscriptHit = getSelectedGeneTranscriptHit(clickX, clickY)

        // Check if click is on a gene
        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            if (gene.strand === '+' && effectiveHiddenStrands.forward) continue
            if (gene.strand === '-' && effectiveHiddenStrands.reverse) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)

            if (clickX >= gx1 - 2 && clickX <= gx2 + 4) {
                const isForward = gene.strand === '+'
                const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y

                const geneWidth = gx2 - gx1
                const rowCount = getGeneRowCountForWidth(gene, geneWidth)

                const trackPadding = gene.strand === '+' ? layout.fwdPadding : layout.revPadding
                const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
                const totalGeneHeight = getGeneTotalHeight(rowCount)

                if (clickY >= baseGeneY && clickY <= baseGeneY + totalGeneHeight) {
                    const isSameGene = !!(selectedGene && selectedGene.id === gene.id)
                    if (isSameGene) {
                        if (selectedTranscriptHit?.gene?.id === gene.id) {
                            openSelectedTranscriptPopup(selectedTranscriptHit)
                            setClickedVcfVariant(null)
                            setClickedBigBedFeature(null)
                            setClickedSpliceJunction(null)
                            setClickedSeqBase(null)
                            return
                        }
                        dismissClickedGeneTranscript()
                        setSelectedGene(null)
                        return
                    }

                    dismissClickedGeneTranscript()
                    pendingVerticalCenterGeneIdRef.current = gene.id
                    setSelectedGene(gene)
                    trackAchievement('browser.geneFocus')

                    const selectedCoords = getSelectedGeneCoordsForView(gene, isAligned, alignData, genomicToOverlay)
                    if (selectedCoords) {
                        const framed = frameFocusRange(selectedCoords.start, selectedCoords.end, { gainingFocus: true })
                        animateToView(framed.start, framed.end, 700)
                    }
                    return
                }
            }
        }

        // Check if click is on a sequence track base
        const seqBaseHit = getSeqBaseAtMouse(clickX, clickY)
        if (seqBaseHit) {
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            const popupX = rect.left + (seqBaseHit.bxL + seqBaseHit.bxR) / 2
            const popupY = rect.top + seqBaseHit.seqBoxT + seqBaseHit.seqBoxH + 6
            setClickedSeqBase(prev =>
                prev?.bp === seqBaseHit.bp ? null : { ...seqBaseHit, popupX, popupY }
            )
            setClickedVcfVariant(null)
            setClickedSpliceJunction(null)
            dismissClickedGeneTranscript()
            return
        }

        const customHover = getCustomTrackHover(clickX, clickY, e.clientX, e.clientY)

        // Check if click is on an adaptive VCF variant (adp_detail mode)
        if (customHover?.hoverBlock?.variant) {
            // Toggle: clicking same variant again closes popup
            const v = customHover.hoverBlock.variant
            // Compute screen anchor for the popup arrow (left edge + vertical centre of feature)
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            const trackId = customHover.hoverBlock.trackId
            const trackLayout = layout.customTrackLayouts[trackId]
            const track = customTracksById.get(trackId)
            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const { top: tTop, bottom: tBot } = getCustomTrackGeometry(trackLayout, renderMode, trackType, customTrackData?.[trackId] || null)
            const tPlotH = tBot - tTop
            const tBarH = Math.max(5, Math.floor(tPlotH * 0.13))
            const tBarY = tTop + Math.floor((tPlotH - tBarH) / 2)
            const cLeft = LHS_WIDTH + 2
            const cRight = viewWidth - 2
            const curSpan = Math.max(1, viewEnd - viewStart)
            const blockGToX = (g) => cLeft + ((g - viewStart) / curSpan) * (cRight - cLeft)
            const vtype = localVcfType(v)
            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
            let arrowTargetX, arrowTargetY
            if (vtype !== 'snv') {
                // Circle marker: X from dot centre, Y approximated from click
                const dotCanvasX = blockGToX(layoutInfo.markerXGenomic)
                arrowTargetX = rect.left + dotCanvasX - 5   // left edge of dot (r ≈ 5)
                arrowTargetY = e.clientY
            } else {
                // SNV block: left pixel edge and vertical centre
                arrowTargetX = rect.left + blockGToX(layoutInfo.vpos)
                arrowTargetY = rect.top + tBarY + tBarH / 2
            }
            setClickedVcfVariant((prev) =>
                prev?.variant?.pos === v.pos && prev?.variant?.type === v.type ? null
                    : { variant: v, chrom: selectedChrom, arrowTargetX, arrowTargetY }
            )
            setClickedBigBedFeature(null)
            setClickedSpliceJunction(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        if (customHover?.hoverBigBed?.feature) {
            const hit = customHover.hoverBigBed
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            setClickedBigBedFeature((prev) => {
                if (prev?.trackId === hit.trackId && bigBedFeatureKey(prev.feature) === bigBedFeatureKey(hit.feature)) {
                    return null
                }
                return {
                    trackId: hit.trackId,
                    feature: hit.feature,
                    popupX: rect.left + hit.anchorCanvasX,
                    popupY: rect.top + hit.anchorCanvasY,
                }
            })
            setClickedVcfVariant(null)
            setClickedSpliceJunction(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        if (customHover?.hoverSplice?.junction) {
            const hit = customHover.hoverSplice
            setClickedSpliceJunction({ trackId: hit.trackId, junction: hit.junction, popupX: e.clientX, popupY: e.clientY })
            setClickedVcfVariant(null)
            setClickedBigBedFeature(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        // Click elsewhere — close any open popup
        if (clickedVcfVariant || clickedBigBedFeature || clickedSeqBase || clickedSpliceJunction || clickedGeneTranscript) {
            setClickedVcfVariant(null)
            setClickedBigBedFeature(null)
            setClickedSeqBase(null)
            setClickedSpliceJunction(null)
            dismissClickedGeneTranscript()
            return
        }

        // Any background click in the drawable browser region clears the focused gene.
        if (selectedGene) {
            dismissClickedGeneTranscript()
            setSelectedGene(null)
        }
    }

export function handleBrowserMouseMove(ctx, e) {
    const {
        canVerticallyScrollContainer,
        canvasRef,
        captureAdaptiveScrollAnchor,
        clearTranscriptPopupDismissTimer,
        clickedGeneTranscript,
        clickedSeqBase,
        dismissCustomTrackTooltip,
        dragAxisRef,
        dragScrollTopRef,
        dragStartXRef,
        dragStartYRef,
        dragViewStartRef,
        draggingTrack,
        focusTranscriptView,
        focusViewGeneId,
        getCustomTrackHover,
        getSelectedGeneTranscriptHit,
        getSeqBaseAtMouse,
        getTrackAtY,
        getTrackTooltip,
        hoveredBigBedRef,
        hoveredSeqBaseRef,
        hoveredSpliceRef,
        hoveredVcfBlockRef,
        isDraggingRef,
        isFlipped,
        isSelectingRect,
        lastPosRef,
        lastTimeRef,
        onFocusTranscriptViewChangeRef,
        panByPx,
        queueCustomTrackTooltip,
        scheduleTranscriptPopupDismiss,
        scrollTargetRef,
        setClickedSeqBase,
        setHoveredBigBedFeature,
        setHoveredSeqBase,
        setHoveredSpliceJunction,
        setHoveredVcfBlock,
        setSidebarTooltip,
        setSpliceArcLiftOffsets,
        spliceArcDragRef,
        suppressNextClickRef,
        transcriptPopupHoverRef,
        updateSelectionRectFromEvent,
        velocityRef,
        viewEndRef,
        viewStartRef,
        viewWidth,
    } = ctx
        const canvas = canvasRef.current

        if (canvas && isSelectingRect) {
            dismissCustomTrackTooltip()
            updateSelectionRectFromEvent(e)
            return
        }

        if (canvas && !isDraggingRef.current) {
            const rect = canvas.getBoundingClientRect()
            const mouseX = e.clientX - rect.left
            const mouseY = e.clientY - rect.top

            // Sidebar hovering tooltip
            if (mouseX <= 40) {
                const trackId = getTrackAtY(mouseY)
                const tooltip = trackId ? getTrackTooltip(trackId) : ''
                setSidebarTooltip(tooltip || null)
            } else {
                setSidebarTooltip(null)
            }

            // Hovering a transcript on the canvas highlights the same row in the
            // focus drawer, so the two lists point at each other both ways.
            if (focusViewGeneId) {
                const transcriptHit = getSelectedGeneTranscriptHit(mouseX, mouseY)
                const nextHoverId = String(transcriptHit?.transcript?.id || '')
                if (nextHoverId !== String(focusTranscriptView?.hoverId || '')) {
                    onFocusTranscriptViewChangeRef.current?.({ hoverId: nextHoverId || null })
                }
            }

            const customHover = getCustomTrackHover(mouseX, mouseY, e.clientX, e.clientY)
            // Strip internal hover fields before passing to tooltip state
            const { hoverBlock: nextBlock, hoverSplice: nextSplice, hoverBigBed: nextBigBed, ...tooltipOnly } = customHover || {}
            // Only show tooltip after cursor dwell on a plotted signal region.
            const tooltipPayload = customHover && tooltipOnly.text ? tooltipOnly : null
            if (draggingTrack) {
                dismissCustomTrackTooltip()
            } else {
                queueCustomTrackTooltip(tooltipPayload, mouseX, mouseY, e.clientX, e.clientY)
            }
            // Only call setState when the hovered block actually changes (avoids churn)
            const prev = hoveredVcfBlockRef.current
            const blockChanged = nextBlock?.trackId !== prev?.trackId || nextBlock?.start !== prev?.start
            if (blockChanged) {
                hoveredVcfBlockRef.current = nextBlock ?? null
                setHoveredVcfBlock(nextBlock ?? null)
            }
            const nextSpliceKey = nextSplice?.junction
                ? `${nextSplice.trackId}|${spliceJunctionKey(nextSplice.junction)}`
                : ''
            if (hoveredSpliceRef.current !== nextSpliceKey) {
                hoveredSpliceRef.current = nextSpliceKey
                setHoveredSpliceJunction(nextSplice?.junction ? {
                    trackId: nextSplice.trackId,
                    key: spliceJunctionKey(nextSplice.junction),
                    junction: nextSplice.junction,
                } : null)
            }
            const nextBigBedKey = nextBigBed?.key
                ? `${nextBigBed.trackId}|${nextBigBed.key}`
                : ''
            if (hoveredBigBedRef.current !== nextBigBedKey) {
                hoveredBigBedRef.current = nextBigBedKey
                setHoveredBigBedFeature(nextBigBed?.feature ? {
                    trackId: nextBigBed.trackId,
                    key: nextBigBed.key,
                    feature: nextBigBed.feature,
                    anchorCanvasX: nextBigBed.anchorCanvasX,
                    anchorCanvasY: nextBigBed.anchorCanvasY,
                } : null)
            }

            // Sequence track base hover
            const seqBase = getSeqBaseAtMouse(mouseX, mouseY)
            if (seqBase?.bp !== hoveredSeqBaseRef.current?.bp) {
                hoveredSeqBaseRef.current = seqBase
                setHoveredSeqBase(seqBase)
            }
            // Dismiss base popup when cursor leaves the clicked base
            if (clickedSeqBase && seqBase?.bp !== clickedSeqBase.bp) {
                setClickedSeqBase(null)
            }

            if (clickedGeneTranscript) {
                const transcriptHit = getSelectedGeneTranscriptHit(mouseX, mouseY)
                const isSameTranscript = Boolean(
                    transcriptHit?.transcript?.id
                    && transcriptHit.transcript.id === clickedGeneTranscript.transcriptId
                )
                if (isSameTranscript) {
                    clearTranscriptPopupDismissTimer()
                } else if (!transcriptPopupHoverRef.current) {
                    scheduleTranscriptPopupDismiss()
                }
            }
        }

        if (!isDraggingRef.current) return

        if (spliceArcDragRef.current) {
            const drag = spliceArcDragRef.current
            const mapKey = `${drag.trackId}|${drag.key}`
            const dy = drag.startClientY - e.clientY
            if (Math.abs(dy) > 2) {
                dragAxisRef.current = 'splice'
                suppressNextClickRef.current = true
            }
            const nextLift = clamp(Number(drag.initialLift || 0) + dy, -48, 210)
            setSpliceArcLiftOffsets((prev) => {
                const cur = Number(prev[mapKey] || 0)
                if (Math.abs(cur - nextLift) < 0.15) return prev
                return { ...prev, [mapKey]: nextLift }
            })
            velocityRef.current = 0
            return
        }

        dismissCustomTrackTooltip()
        if (hoveredSpliceRef.current) {
            hoveredSpliceRef.current = null
            setHoveredSpliceJunction(null)
        }
        if (hoveredBigBedRef.current) {
            hoveredBigBedRef.current = null
            setHoveredBigBedFeature(null)
        }
        const dx = dragStartXRef.current - e.clientX
        const dy = dragStartYRef.current - e.clientY

        // Lock to an axis once movement exceeds threshold
        if (!dragAxisRef.current) {
            const axis = resolveDragAxis({
                dx,
                dy,
                canScrollPage: canVerticallyScrollContainer(),
                currentAxis: null,
            })
            if (axis) {
                dragAxisRef.current = axis
                suppressNextClickRef.current = true
            }
        }

        if (dragAxisRef.current === 'x' || !dragAxisRef.current) {
            const bpDelta = viewStartRef.current - dragViewStartRef.current
            const currentSpan = viewEndRef.current - viewStartRef.current
            const currentPerPx = currentSpan / Math.max(1, viewWidth - LHS_WIDTH)
            const pxPanApplied = isFlipped ? -bpDelta / currentPerPx : bpDelta / currentPerPx
            captureAdaptiveScrollAnchor()
            panByPx(dx - pxPanApplied)
        }

        if (dragAxisRef.current === 'y' && scrollTargetRef.current) {
            // 1:1 grab-and-drag, matching the horizontal pan: the content follows
            // the cursor, so dragging down reveals what is above.
            scrollTargetRef.current.scrollTop = dragScrollTopRef.current + dy
        }

        // Track velocity (only for horizontal momentum). Smoothed over a couple of
        // samples and kept at true drag speed — amplifying it made the release
        // overshoot where the cursor actually stopped.
        const now = performance.now()
        const dt = now - lastTimeRef.current
        if (dt > 0 && dt < 100) {
            const samplePxPerFrame = ((lastPosRef.current - e.clientX) / dt) * 16
            velocityRef.current = (velocityRef.current * 0.4) + (samplePxPerFrame * 0.6)
        }
        lastPosRef.current = e.clientX
        lastTimeRef.current = now
    }
