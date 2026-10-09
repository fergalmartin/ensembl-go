import { getScrollerMetrics, getScrollerVisibleTop, scrollScrollerTo } from './canvasText.js'
import { clamp } from './trackData.js'

// Animated moves of a Genome Browser panel's view (tutorials, recentring, aligning
// a gene to the top).

export function animateBrowserToView(ctx, targetStart, targetEnd, durationMs = 1000) {
    const {
        animationRef,
        clampView,
        onPositionChange,
        selectedChrom,
        setViewEnd,
        setViewStart,
        velocityRef,
        viewEndRef,
        viewStartRef,
    } = ctx
        const [finalStart, finalEnd] = clampView(targetStart, targetEnd)
        const initialStart = viewStartRef.current
        const initialEnd = viewEndRef.current

        if (Math.abs(finalStart - initialStart) < 1e-6 && Math.abs(finalEnd - initialEnd) < 1e-6) {
            return
        }

        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }
        velocityRef.current = 0

        const startTime = performance.now()
        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

        const tick = (now) => {
            const rawT = Math.min(1, (now - startTime) / durationMs)
            const t = easeOutCubic(rawT)

            let nextStart = initialStart + (finalStart - initialStart) * t
            let nextEnd = initialEnd + (finalEnd - initialEnd) * t
                ;[nextStart, nextEnd] = clampView(nextStart, nextEnd)

            viewStartRef.current = nextStart
            viewEndRef.current = nextEnd
            setViewStart(nextStart)
            setViewEnd(nextEnd)

            if (onPositionChange) {
                onPositionChange(selectedChrom, nextStart, nextEnd)
            }

            if (rawT < 1) {
                animationRef.current = requestAnimationFrame(tick)
            } else {
                animationRef.current = null
            }
        }

        animationRef.current = requestAnimationFrame(tick)
    }

export function alignGeneToTopOfView(ctx, geneForFocus, marginPx = 18, options = {}) {
    const {
        containerRef,
        findNearestScrollable,
        genomicToScreen,
        getGeneRowCountForWidth,
        getGeneTotalHeight,
        layout,
        rootRef,
        transcriptLayoutMetrics,
    } = ctx
        if (!geneForFocus || !containerRef.current) return false

        const isForward = geneForFocus.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(geneForFocus.start)
        const rawGx2 = genomicToScreen(geneForFocus.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const rowCount = getGeneRowCountForWidth(geneForFocus, geneWidth)
        const totalGeneHeight = getGeneTotalHeight(rowCount)
        const baseGeneY = trackY + trackPadding + ((geneForFocus._row || 0) * transcriptLayoutMetrics.rowPitch)

        const container = containerRef.current
        const containerRect = container.getBoundingClientRect()
        const scroller = findNearestScrollable(rootRef.current)
        const scrollerMetrics = getScrollerMetrics(scroller)

        const topMarginPx = Math.max(0, Number(options.topMarginPx ?? marginPx))
        const bottomMarginPx = Math.max(0, Number(options.bottomMarginPx ?? marginPx))

        // The gene's position in client space. The panel itself never scrolls, so
        // this only moves when the surrounding page scroller moves.
        const geneTopClientY = containerRect.top + baseGeneY
        const geneBottomClientY = geneTopClientY + totalGeneHeight

        // Park the gene just under whichever edge is lower: the panel's own top or
        // the visible top of the scroll viewport, below a control bar floating there.
        const visibleTop = getScrollerVisibleTop(scroller, scrollerMetrics)
        const topAlignDelta = geneTopClientY - (Math.max(containerRect.top, visibleTop) + topMarginPx)
        const bottomFitDelta = Math.max(
            0,
            geneBottomClientY + bottomMarginPx - Math.min(containerRect.bottom, scrollerMetrics.bottom)
        )
        const rawScrollTop = scrollerMetrics.scrollTop
            + (Boolean(options.preferBottomVisible) ? bottomFitDelta : topAlignDelta)

        // Layout may still be growing (transcripts expanding); let the caller retry.
        const needsMoreScrollableHeight = Boolean(options.preferBottomVisible)
            && (rawScrollTop > (scrollerMetrics.maxScrollTop + 1))
        if (needsMoreScrollableHeight) {
            return false
        }

        scrollScrollerTo(scroller, scrollerMetrics, clamp(rawScrollTop, 0, scrollerMetrics.maxScrollTop))
        return true
    }
