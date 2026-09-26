// BED9 thick regions for features without blocks.
//
// thickStart..thickEnd is a feature's core and the rest its extension — a regulatory
// promoter's extended region, for one. UCSC and IGV draw the core full height and the
// rest as a thin bar. A thick region covering the whole feature is an ordinary box,
// and an empty one (thickStart == thickEnd) makes the whole feature thin, as UCSC does.
// Positions here are in whatever frame the caller holds the feature in; the browser
// holds BED features as [first base, last base + 1).

/** The feature's core as { start, end } clamped to it, or null when it is just a box. */
export function bedThickRegion(feature, start, end) {
    if (feature?.thick_start == null || feature?.thick_end == null) return null
    if (feature.thick_start === '' || feature.thick_end === '') return null
    const ts = Number(feature.thick_start)
    const te = Number(feature.thick_end)
    if (!Number.isFinite(ts) || !Number.isFinite(te)) return null
    const clampTo = (v) => Math.min(end, Math.max(start, v))
    const coreStart = clampTo(Math.min(ts, te))
    const coreEnd = clampTo(Math.max(ts, te))
    return coreStart > start || coreEnd < end ? { start: coreStart, end: coreEnd } : null
}

/**
 * The pieces to draw, left to right: thin, thick, thin — each only where it has length
 * and is in view. They do not overlap, so translucent fills and outlines do not double
 * up where they meet. `toX` maps a position to x.
 */
export function bedThickPieces(feature, toX, { left, right, viewStart, viewEnd, yMid, exonH }) {
    const thick = feature?._thick
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!thick) return []
    const thinH = Math.max(3, Math.round(exonH * 0.45))
    const spans = [
        { s: start, e: thick.start, h: thinH },
        { s: thick.start, e: thick.end, h: exonH },
        { s: thick.end, e: end, h: thinH },
    ]
    const pieces = []
    for (const span of spans) {
        if (!(span.e > span.s) || span.e <= viewStart || span.s >= viewEnd) continue
        const x1 = Math.max(left, toX(Math.max(viewStart, span.s)))
        const x2 = Math.min(right, toX(Math.min(viewEnd, span.e)))
        if (x2 < x1) continue
        pieces.push({ x: x1, y: yMid - span.h / 2, w: Math.max(1, x2 - x1), h: span.h, thick: span.h === exonH })
    }
    return pieces
}
