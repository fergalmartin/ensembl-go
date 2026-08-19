/**
 * The power symbol, redrawn as strokes.
 *
 * The shipped `icon_power.svg` is a filled outline: its ring and stem are both
 * 2.625 units wide in a 32-unit box, so at the ~15px the track toggles use them
 * they land on 1.2px and turn to mush — the stem inside the ring stops reading
 * as a stem. Stroking the same shape instead decouples the line weight from the
 * icon size, so the detail stays legible however small the glyph gets.
 *
 * The proportions below are measured off that asset, so the redrawn glyph is
 * recognisably the same mark:
 *   - ring centreline radius     10.71875 / 32
 *   - stem top                    1.399 radii above the ring centre
 *   - stem bottom                 0.163 radii above the ring centre
 *   - break in the ring          ±27.9° either side of vertical
 */

/** Stem reaches this many radii above the ring's centre. */
const STEM_TOP_RATIO = 1.3994

/** Stem stops this many radii above the ring's centre. */
const STEM_BOTTOM_RATIO = 0.1633

/** Half-width of the break at the top of the ring, in radians. */
const GAP_HALF_ANGLE = 0.4868

/**
 * Total ink height as a multiple of the radius, ignoring the stroke:
 * STEM_TOP_RATIO above the ring centre plus 1 radius below it.
 */
const INK_HEIGHT_RATIO = STEM_TOP_RATIO + 1

/** Stroke weight as a fraction of the box, and the range it is held within. */
const STROKE_RATIO = 0.115
const MIN_STROKE = 1.6
const MAX_STROKE = 2.4

const round = (value) => Math.round(value * 1000) / 1000

/**
 * Stroke weight and ring radius for a glyph drawn in a `size` × `size` box.
 *
 * The radius is whatever leaves the stroked ink exactly filling the box, so a
 * heavier stroke buys its weight from the ring rather than overflowing.
 */
export function powerGlyphMetrics(size) {
    const box = Number(size)
    if (!Number.isFinite(box) || box <= 0) return null

    const stroke = Math.min(MAX_STROKE, Math.max(MIN_STROKE, box * STROKE_RATIO))
    const radius = (box - stroke) / INK_HEIGHT_RATIO
    if (!(radius > 0)) return null

    // The ring sits below the box's centre, because the stem makes the mark
    // taller above the ring's centre than below it.
    const centerX = box / 2
    const ringCenterY = (box / 2) + (((INK_HEIGHT_RATIO - 2) / 2) * radius)

    return { size: box, stroke, radius, centerX, ringCenterY }
}

/**
 * SVG path data for the glyph, in a `size` × `size` box with its origin at the
 * top left. Both paths are meant to be stroked, never filled — same data for
 * the canvas (via Path2D), the DOM and the SVG export, so the three cannot
 * drift apart.
 */
export function powerGlyphPaths(size) {
    const metrics = powerGlyphMetrics(size)
    if (!metrics) return null
    const { stroke, radius, centerX, ringCenterY } = metrics

    // Sweep clockwise from just right of vertical, all the way round to just
    // left of it, leaving the break at the top for the stem.
    const startAngle = -(Math.PI / 2) + GAP_HALF_ANGLE
    const endAngle = (Math.PI * 1.5) - GAP_HALF_ANGLE
    const x0 = round(centerX + (radius * Math.cos(startAngle)))
    const y0 = round(ringCenterY + (radius * Math.sin(startAngle)))
    const x1 = round(centerX + (radius * Math.cos(endAngle)))
    const y1 = round(ringCenterY + (radius * Math.sin(endAngle)))
    const r = round(radius)

    return {
        stroke,
        // large-arc-flag 1 (the sweep is well over half a turn), sweep-flag 1.
        ring: `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`,
        stem: `M ${round(centerX)} ${round(ringCenterY - (STEM_TOP_RATIO * radius))}`
            + ` L ${round(centerX)} ${round(ringCenterY - (STEM_BOTTOM_RATIO * radius))}`,
    }
}

/**
 * Stroke the glyph onto a canvas, centred on (x, y).
 *
 * Returns false when the environment has no Path2D, so callers can fall back.
 */
export function drawPowerGlyph(ctx, x, y, { size, color }) {
    if (!ctx || typeof Path2D === 'undefined') return false
    const paths = powerGlyphPaths(size)
    if (!paths) return false

    ctx.save()
    ctx.translate(x - (size / 2), y - (size / 2))
    ctx.strokeStyle = color
    ctx.lineWidth = paths.stroke
    ctx.lineCap = 'round'
    ctx.stroke(new Path2D(paths.ring))
    ctx.stroke(new Path2D(paths.stem))
    ctx.restore()
    return true
}

/** The glyph as standalone SVG markup, centred on (x, y). */
export function powerGlyphSvgMarkup({ x, y, size, color }) {
    const paths = powerGlyphPaths(size)
    if (!paths) return ''
    const shared = `fill="none" stroke="${color}" stroke-width="${paths.stroke}" stroke-linecap="round"`
    return `<g transform="translate(${round(x - (size / 2))} ${round(y - (size / 2))})">`
        + `<path d="${paths.ring}" ${shared} />`
        + `<path d="${paths.stem}" ${shared} />`
        + `</g>`
}
