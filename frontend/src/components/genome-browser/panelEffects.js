// Effects of a Genome Browser panel that react to its own state: focusing a
// transcript pill once its gene is laid out, and keeping the expanded-footer
// viewport in step with the canvas.

export function applyPendingTranscriptPillFocus(ctx) {
    const {
        centerGeneVertically,
        genes,
        pendingVerticalCenterGeneIdRef,
    } = ctx
        const pendingGeneId = pendingVerticalCenterGeneIdRef.current
        if (!pendingGeneId) return

        const geneForCenter = genes.find((gene) => gene.id === pendingGeneId)
        if (!geneForCenter) return

        if (centerGeneVertically(geneForCenter)) {
            pendingVerticalCenterGeneIdRef.current = null
        }
    }

export function measureExpandedFooterViewport(ctx) {
    const {
        canvasRef,
        findNearestScrollable,
        hasExpandedGeneFooters,
        setExpandedFooterViewport,
    } = ctx
        const canvas = canvasRef.current
        if (!canvas || !hasExpandedGeneFooters) {
            setExpandedFooterViewport((prev) => (prev === null ? prev : null))
            return undefined
        }

        const scrollElement = findNearestScrollable(canvas)
        let frameId = null

        const updateViewport = () => {
            frameId = null
            const canvasRect = canvas.getBoundingClientRect()
            const scrollRect = scrollElement?.getBoundingClientRect?.() || null
            const visibleTopClient = Math.max(
                0,
                canvasRect.top,
                Number.isFinite(scrollRect?.top) ? scrollRect.top : 0,
            )
            const visibleBottomClient = Math.min(
                window.innerHeight,
                canvasRect.bottom,
                Number.isFinite(scrollRect?.bottom) ? scrollRect.bottom : window.innerHeight,
            )
            const next = visibleBottomClient > visibleTopClient
                ? {
                    top: Math.max(0, visibleTopClient - canvasRect.top),
                    bottom: Math.max(0, visibleBottomClient - canvasRect.top),
                }
                : null

            setExpandedFooterViewport((prev) => {
                if (prev === null || next === null) return prev === next ? prev : next
                if (Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.bottom - next.bottom) < 0.5) return prev
                return next
            })
        }

        const scheduleViewportUpdate = () => {
            if (frameId !== null) return
            frameId = window.requestAnimationFrame(updateViewport)
        }

        updateViewport()
        scrollElement?.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
        window.addEventListener('scroll', scheduleViewportUpdate, { passive: true, capture: true })
        window.addEventListener('resize', scheduleViewportUpdate, { passive: true })

        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(scheduleViewportUpdate)
            : null
        resizeObserver?.observe(canvas)
        if (scrollElement) resizeObserver?.observe(scrollElement)

        return () => {
            if (frameId !== null) window.cancelAnimationFrame(frameId)
            scrollElement?.removeEventListener('scroll', scheduleViewportUpdate)
            window.removeEventListener('scroll', scheduleViewportUpdate, { capture: true })
            window.removeEventListener('resize', scheduleViewportUpdate)
            resizeObserver?.disconnect()
        }
    }
