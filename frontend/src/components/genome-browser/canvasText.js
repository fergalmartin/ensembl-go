// Canvas text and page scrolling for the Genome Browser: measuring footer labels,
// text that stays readable on a mirrored (reverse-complemented) canvas, and reading
// or moving the scroller that contains the browser. Browser-only (canvas/DOM).
import { overlayOccluders } from '../../utils/overlayGeometry.js'
import { LABEL_FONT, MIRRORED_TEXT_ALIGN } from './browserConstants.js'

export let expandedFooterTextMeasureContext = null

export function measureExpandedFooterLabelWidth(text) {
    const fallbackWidth = String(text || '').length * 6
    if (typeof document === 'undefined') return fallbackWidth + 4
    if (!expandedFooterTextMeasureContext) {
        expandedFooterTextMeasureContext = document.createElement('canvas').getContext('2d')
    }
    if (!expandedFooterTextMeasureContext) return fallbackWidth + 4
    expandedFooterTextMeasureContext.font = LABEL_FONT
    return Math.ceil(expandedFooterTextMeasureContext.measureText(String(text || '')).width) + 4
}

// ============ Page-level vertical scrolling ============
// Browser panels never scroll internally, so bringing a track feature into view
// means moving whichever ancestor owns the page scroll (falling back to the
// window when the app is not inside its own scroll container).

export function getScrollerMetrics(scroller) {
    const isWindowScroller = !scroller
        || scroller === document.documentElement
        || scroller === document.body
    if (isWindowScroller) {
        const doc = document.documentElement
        const viewportHeight = window.innerHeight || doc?.clientHeight || 0
        return {
            isWindowScroller: true,
            top: 0,
            bottom: viewportHeight,
            scrollTop: window.scrollY || doc?.scrollTop || 0,
            maxScrollTop: Math.max(0, (doc?.scrollHeight || 0) - viewportHeight),
        }
    }
    const rect = scroller.getBoundingClientRect()
    return {
        isWindowScroller: false,
        top: rect.top,
        bottom: rect.bottom,
        scrollTop: scroller.scrollTop,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    }
}

// Where the scroller's content can actually be seen from, in client space: its top
// edge, pushed down by chrome floating over it — the browser's control bar when it
// is set to follow the scroll. A sticky bar is taken at the place it comes to rest,
// not where it is now: one still in the flow above the panels sticks as soon as the
// scroll carries it to the edge, and then covers whatever was parked there.
export function getScrollerVisibleTop(scroller, metrics) {
    let visibleTop = metrics.top
    const scope = metrics.isWindowScroller ? document : scroller
    for (const node of overlayOccluders(scope)) {
        const rect = node.getBoundingClientRect()
        if (!(rect.height > 0)) continue
        const style = window.getComputedStyle(node)
        let bottom = rect.bottom
        if (style.position === 'sticky') {
            const padTop = metrics.isWindowScroller
                ? 0
                : (parseFloat(window.getComputedStyle(scroller).paddingTop) || 0)
            bottom = metrics.top + padTop + (parseFloat(style.top) || 0) + rect.height
        }
        visibleTop = Math.max(visibleTop, bottom)
    }
    return visibleTop
}

export function scrollScrollerTo(scroller, metrics, top, behavior = 'smooth') {
    if (metrics.isWindowScroller) window.scrollTo({ top, behavior })
    else scroller.scrollTo({ top, behavior })
}

// ============ Mirrored drawing for a flipped (3'→5') panel ============
// Custom tracks are laid out left to right in genomic order by a dozen renderers.
// A flipped panel draws them through a mirror about the track area instead of
// teaching each renderer to run backwards — exact, because the flipped
// genomicToScreen is the unflipped one reflected about that same axis
// (LHS_WIDTH + viewWidth). Text is un-mirrored where it is drawn, keeping its
// anchor, so a label beside a feature stays beside it and still reads.

export const nativeFillText = typeof CanvasRenderingContext2D === 'undefined'
    ? null
    : CanvasRenderingContext2D.prototype.fillText

export function callNativeFillText(ctx, text, x, y, maxWidth) {
    // An explicit undefined maxWidth reads as NaN, which draws nothing.
    if (maxWidth === undefined) nativeFillText.call(ctx, text, x, y)
    else nativeFillText.call(ctx, text, x, y, maxWidth)
}

export function beginCanvasMirror(ctx, axis) {
    ctx.save()
    ctx.translate(axis, 0)
    ctx.scale(-1, 1)
    ctx.fillText = function mirroredFillText(text, x, y, maxWidth) {
        this.save()
        this.textAlign = MIRRORED_TEXT_ALIGN[this.textAlign] || this.textAlign
        this.translate(x, 0)
        this.scale(-1, 1)
        this.translate(-x, 0)
        callNativeFillText(this, text, x, y, maxWidth)
        this.restore()
    }
}

// Safe to call when no mirror is open, so a draw can clear one left behind by a
// frame that threw part way through.
export function endCanvasMirror(ctx) {
    if (!Object.prototype.hasOwnProperty.call(ctx, 'fillText')) return
    delete ctx.fillText
    ctx.restore()
}

// Text that belongs to the panel rather than the data — a track's name, its value
// axis — drawn where it is given on screen whether or not a mirror is open.
export function fillScreenText(ctx, mirrorAxis, text, x, y) {
    if (!Object.prototype.hasOwnProperty.call(ctx, 'fillText')) {
        ctx.fillText(text, x, y)
        return
    }
    ctx.save()
    ctx.translate(mirrorAxis, 0)
    ctx.scale(-1, 1)
    callNativeFillText(ctx, text, x, y)
    ctx.restore()
}
