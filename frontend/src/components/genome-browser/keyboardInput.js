// Keyboard input on a Genome Browser panel: arrows to pan, +/- to zoom, Home/End,
// fit-to-chromosome and focus shortcuts.
import { isTextEntryTarget, readKeyEvent, resolveKeyAction } from '../../utils/browsingControls.js'
import { LHS_WIDTH } from './browserConstants.js'

export function handleBrowserKeyDown(ctx, e) {
    const {
        animateToView,
        captureAdaptiveScrollAnchor,
        chromLength,
        clampView,
        containerRef,
        handleRecenterSelectedGene,
        handleRecenterSelectedLocation,
        onManualNavigate,
        panByPx,
        selectedGene,
        selectedLocation,
        setSelectedGene,
        setSelectedLocation,
        viewEndRef,
        viewStartRef,
        viewWidth,
        zoomAt,
    } = ctx
        if (e.defaultPrevented) return
        // The panel contains a search box and a track-label dialog whose keydowns
        // bubble up to this container.
        if (isTextEntryTarget(e.target)) return

        const intent = resolveKeyAction(readKeyEvent(e))
        if (intent.type === 'none') return
        if (intent.preventDefault) e.preventDefault()

        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const span = Math.max(1, currentEnd - currentStart)
        const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)

        if (intent.type === 'pan') {
            // At base-level zoom a "fine" step should be exactly one base,
            // otherwise a percentage of the span.
            const stepPx = (intent.fineStep && span <= 1000)
                ? Math.sign(intent.dxFraction) * (trackWidth / span)
                : intent.dxFraction * trackWidth
            captureAdaptiveScrollAnchor()
            panByPx(stepPx)
            return
        }

        if (intent.type === 'zoom') {
            zoomAt(LHS_WIDTH + trackWidth / 2, intent.factor, null)
            return
        }

        if (intent.type === 'jump') {
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            const [nextStart, nextEnd] = intent.edge === 'start'
                ? clampView(1, 1 + span)
                : clampView(maxEnd - span, maxEnd)
            animateToView(nextStart, nextEnd, 400)
            return
        }

        if (intent.type === 'reset') {
            if (intent.scope === 'gene') {
                // "Reset to what is focused": whichever kind of focus the panel holds.
                if (selectedGene) handleRecenterSelectedGene()
                else handleRecenterSelectedLocation()
                return
            }
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            animateToView(1, maxEnd, 500)
            return
        }

        if (intent.type === 'dismiss') {
            if (selectedGene) {
                setSelectedGene(null)
                return
            }
            if (selectedLocation) {
                setSelectedLocation(null)
                return
            }
            containerRef.current?.blur()
        }
    }
