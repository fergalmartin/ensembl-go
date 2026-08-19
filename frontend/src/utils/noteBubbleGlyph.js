/**
 * A speech bubble: the one mark in the browser that means "someone wrote
 * something about this".
 *
 * Deliberately not the InfoGlyph. That mark already carries "there is more to
 * read about this here", and it is spent on the transcript rows and the genome
 * pill — offers the app makes about data it fetched. A note is the user's own
 * writing, and it needs a mark they can pick out of a track at a glance without
 * first asking which of two circles this one is.
 *
 * The geometry lives here rather than in the component because the same bubble
 * is drawn three ways: as DOM in the drawer, as a positioned overlay on the
 * canvas, and as markup in the SVG export. One source of path data, so the
 * three cannot drift apart. Same arrangement as `powerGlyph.js`.
 *
 * Proportions, in a 24-unit box:
 *   - body            a 20 × 15 rounded rect, inset 2 from the left and top
 *   - corner radius   3.5
 *   - tail            drops from the lower left, 4 wide and 4 deep
 */

/** Reference box the path data is authored in. */
const VIEW_BOX = 24

const BODY = { x: 2, y: 3, width: 20, height: 14, radius: 3.5 }

/** Where the tail leaves the body, and how far it drops below it. */
const TAIL_LEFT = 6.5
const TAIL_RIGHT = 11.5
const TAIL_TIP_X = 6.5
const TAIL_DEPTH = 4

/** Stroke weight as a fraction of the box, and the range it is held within. */
const STROKE_RATIO = 0.09
const MIN_STROKE = 1.5
const MAX_STROKE = 2.2

const round = (value) => Math.round(value * 1000) / 1000

/**
 * Stroke weight and scale for a bubble drawn in a `size` × `size` box.
 *
 * The stroke is clamped for the same reason the power glyph's is: at the 14px
 * the canvas overlay uses, a weight that scaled freely would land near 1px and
 * the tail would stop reading as a tail.
 */
export function noteBubbleGlyphMetrics(size) {
    const box = Number(size)
    if (!Number.isFinite(box) || box <= 0) return null
    const stroke = Math.min(MAX_STROKE, Math.max(MIN_STROKE, box * STROKE_RATIO))
    return { size: box, stroke, scale: box / VIEW_BOX }
}

/**
 * SVG path data for the bubble, in a `size` × `size` box with its origin at the
 * top left.
 *
 * `body` is one closed path — rounded rect plus tail — so a filled bubble reads
 * as a single silhouette rather than a box with a triangle stuck to it. `lines`
 * is the two rules inside it, always stroked, which is what makes the shape read
 * as writing rather than as a blank callout.
 */
export function noteBubbleGlyphPaths(size) {
    const metrics = noteBubbleGlyphMetrics(size)
    if (!metrics) return null
    const { stroke, scale } = metrics
    const s = (value) => round(value * scale)

    const { x, y, width, height, radius: r } = BODY
    const right = x + width
    const bottom = y + height

    const body = [
        `M ${s(x + r)} ${s(y)}`,
        `H ${s(right - r)}`,
        `A ${s(r)} ${s(r)} 0 0 1 ${s(right)} ${s(y + r)}`,
        `V ${s(bottom - r)}`,
        `A ${s(r)} ${s(r)} 0 0 1 ${s(right - r)} ${s(bottom)}`,
        // Out along the bottom edge, down to the tip, back up to the body.
        `H ${s(TAIL_RIGHT)}`,
        `L ${s(TAIL_TIP_X)} ${s(bottom + TAIL_DEPTH)}`,
        `L ${s(TAIL_LEFT)} ${s(bottom)}`,
        `H ${s(x + r)}`,
        `A ${s(r)} ${s(r)} 0 0 1 ${s(x)} ${s(bottom - r)}`,
        `V ${s(y + r)}`,
        `A ${s(r)} ${s(r)} 0 0 1 ${s(x + r)} ${s(y)}`,
        'Z',
    ].join(' ')

    const lines = [
        `M ${s(6.5)} ${s(8)} H ${s(17.5)}`,
        `M ${s(6.5)} ${s(12)} H ${s(13.5)}`,
    ]

    return { stroke, body, lines }
}

/**
 * Draw the bubble onto a canvas, centred on (x, y).
 *
 * `filled` paints the body solid and knocks the rules out of it, which is what
 * a gene that actually has notes gets — an outline alone is too quiet to find
 * while scanning a track.
 *
 * Returns false when the environment has no Path2D, so callers can fall back.
 */
export function drawNoteBubbleGlyph(ctx, x, y, { size, color, fill = false, knockout = null }) {
    if (!ctx || typeof Path2D === 'undefined') return false
    const paths = noteBubbleGlyphPaths(size)
    if (!paths) return false

    ctx.save()
    ctx.translate(x - (size / 2), y - (size / 2))
    ctx.lineWidth = paths.stroke
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const body = new Path2D(paths.body)
    if (fill) {
        ctx.fillStyle = color
        ctx.fill(body)
    }
    ctx.strokeStyle = color
    ctx.stroke(body)

    ctx.strokeStyle = fill ? (knockout || '#ffffff') : color
    for (const line of paths.lines) ctx.stroke(new Path2D(line))

    ctx.restore()
    return true
}

/** The bubble as standalone SVG markup, centred on (x, y). */
export function noteBubbleGlyphSvgMarkup({ x, y, size, color, fill = false, knockout = '#ffffff' }) {
    const paths = noteBubbleGlyphPaths(size)
    if (!paths) return ''
    const shared = `stroke-width="${paths.stroke}" stroke-linecap="round" stroke-linejoin="round"`
    const lineColor = fill ? knockout : color
    return `<g transform="translate(${round(x - (size / 2))} ${round(y - (size / 2))})">`
        + `<path d="${paths.body}" fill="${fill ? color : 'none'}" stroke="${color}" ${shared} />`
        + paths.lines.map((line) => `<path d="${line}" fill="none" stroke="${lineColor}" ${shared} />`).join('')
        + `</g>`
}
