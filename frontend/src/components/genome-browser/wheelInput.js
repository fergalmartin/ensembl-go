// Wheel input on a Genome Browser panel: the native, non-passive wheel listener
// (zoom, pan, page scroll by the user's browsing-control scheme), attached and
// removed by the panel's effect.
import {
    beginWheelGesture,
    isWheelGestureFromChrome,
    isWheelInsideIsolatedOverlay,
    markWheelHandled,
    readWheelEvent,
    resolveWheelAction,
} from '../../utils/browsingControls.js'
import { LHS_WIDTH } from './browserConstants.js'

export function attachWheelHandler(ctx) {
    const {
        MAX_VIEW_SPAN,
        adaptiveScrollAnchorFrameRef,
        adaptiveScrollAnchorRef,
        animationRef,
        browsingControlsRef,
        captureAdaptiveScrollAnchor,
        containerRef,
        dismissCustomTrackTooltip,
        findNearestScrollable,
        getGeneFeatureVerticalAnchor,
        getTrackAtY,
        panByPx,
        releaseScrollAnchors,
        velocityRef,
        verticalZoomTrackAnchorRef,
        viewEndRef,
        viewStartRef,
        viewWidthRef,
        wheelGestureRef,
        zoomAt,
    } = ctx
        const container = containerRef.current
        if (!container) return

        const handleWheel = (e) => {
            // A dialog over the tracks scrolls itself and never zooms them.
            if (isWheelInsideIsolatedOverlay(e)) return
            // A gesture that began on a control bar or in the page margins is a
            // page scroll. Scrolling slides this canvas under the cursor, so
            // without this the rest of the gesture would turn into a zoom.
            if (isWheelGestureFromChrome(e)) {
                markWheelHandled(e)
                return
            }
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }
            velocityRef.current = 0
            dismissCustomTrackTooltip()

            const rect = container.getBoundingClientRect()
            const cursorX = e.clientX - rect.left

            // Line/page deltas are normalised to pixels before any thresholding,
            // or Firefox and Linux mice (deltaMode 1) are ~30x weaker.
            const wheel = readWheelEvent(e, { pageHeight: rect.height || undefined })
            const gesture = beginWheelGesture(wheelGestureRef.current, wheel, e.timeStamp)

            const currentSpan = viewEndRef.current - viewStartRef.current
            const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
                atMaxZoom: currentSpan >= MAX_VIEW_SPAN - 1e-6,
                canScrollPage: Boolean(findNearestScrollable(container)),
                gesture,
            })

            wheelGestureRef.current = { ...gesture, mode: intent.nextGestureMode }
            // Tell the view-level fallback listener this panel has seen the
            // event, even when the outcome is "do nothing". Must happen before
            // any early return.
            markWheelHandled(e)

            if (intent.preventDefault) e.preventDefault()
            if (intent.stopPropagation) e.stopPropagation()
            if (intent.releaseScrollAnchors) releaseScrollAnchors()

            // 'page_scroll' is handled by doing nothing at all: the event was
            // not prevented, so the browser scrolls the ancestor scroller with
            // its own inertia.
            if (intent.type === 'page_scroll' || intent.type === 'none') return

            if (intent.type === 'pan') {
                verticalZoomTrackAnchorRef.current = null
                if (intent.captureScrollAnchor) captureAdaptiveScrollAnchor()
                panByPx(intent.dxPx)
                return
            }

            if (intent.type !== 'zoom') return

            const mouseY = e.clientY - rect.top + container.scrollTop
            const targetTrack = getTrackAtY(mouseY)

            const now = performance.now()
            const existingGeneAnchor = verticalZoomTrackAnchorRef.current
            const hasActiveGeneAnchor = Boolean(existingGeneAnchor && now <= existingGeneAnchor.expiresAt)
            if (hasActiveGeneAnchor) {
                // Layout changes can move the pointer over another track during
                // a rapid wheel gesture. Keep following the feature row where
                // the gesture began until wheel input pauses.
                existingGeneAnchor.expiresAt = now + 450
            } else {
                const featureAnchor = getGeneFeatureVerticalAnchor(cursorX, mouseY, targetTrack)
                verticalZoomTrackAnchorRef.current = featureAnchor
                    ? {
                        ...featureAnchor,
                        viewportY: e.clientY - rect.top,
                        clientY: e.clientY,
                        expiresAt: now + 450,
                    }
                    : null
            }

            if (verticalZoomTrackAnchorRef.current) {
                adaptiveScrollAnchorRef.current = null
                if (adaptiveScrollAnchorFrameRef.current !== null) {
                    cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
                    adaptiveScrollAnchorFrameRef.current = null
                }
            } else if (intent.captureScrollAnchor) {
                captureAdaptiveScrollAnchor()
            }

            const anchorX = intent.anchor === 'center' ? (LHS_WIDTH + viewWidthRef.current) / 2 : cursorX
            zoomAt(anchorX, intent.factor, targetTrack)
        }

        container.addEventListener('wheel', handleWheel, { passive: false })
        return () => container.removeEventListener('wheel', handleWheel)
    }
