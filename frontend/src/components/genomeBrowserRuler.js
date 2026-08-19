/**
 * Coordinate-ruler geometry for the genome browser, styled after the ruler on
 * www.ensembl.org.
 *
 * The Ensembl ruler is deliberately spare: no filled band, no minor ticks, and
 * no centred labels. It is a single hairline rule along the edge of the track
 * area, a 1px tick dropped at each round coordinate, and the coordinate set in
 * IBM Plex Mono immediately to the *right* of its tick. Measuring the live site
 * at 1x gives the numbers encoded below — a 16px band, 12px labels, a 4px gap
 * between a tick and its label, and a baseline 5px clear of the rule.
 *
 * Because labels sit beside their tick rather than straddling it, the tick
 * interval has to leave room for a whole label plus clearance; `rulerTicks`
 * works that out from the widest coordinate actually in view.
 */

/** Height of the ruler band, including its 1px rule. */
export const RULER_HEIGHT = 18

/** Label size, in px. */
export const RULER_FONT_SIZE = 12

/** Horizontal gap between a tick line and the left edge of its label. */
export const RULER_LABEL_GAP = 4

/** Distance from the rule to the label baseline (ruler along the top edge). */
export const RULER_LABEL_BASELINE_INSET = 5

/** Blank space kept after a label before the next tick may appear. */
export const RULER_LABEL_CLEARANCE = 12

/** Ticks are never closer together than this, however far the view is zoomed. */
export const MIN_TICK_INTERVAL_BP = 10

/**
 * Advance width of IBM Plex Mono as a fraction of the font size. Every glyph in
 * a monospaced face is this wide, so label widths can be measured without a
 * canvas — which keeps tick selection testable and keeps it working before the
 * webfont has loaded.
 */
export const MONO_ADVANCE_RATIO = 0.6

/** Defensive cap so a pathological span/width can never spin the tick loop. */
const MAX_TICKS = 512

/** `31532331` -> `31,532,331`, matching the site's Intl-formatted labels. */
export function formatRulerCoord(value) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return '—'
    return Math.round(numeric).toLocaleString('en-US')
}

/** Width in px of `text` set in IBM Plex Mono at `fontSize`. */
export function estimateMonoTextWidth(text, fontSize = RULER_FONT_SIZE) {
    const size = Number(fontSize)
    if (!Number.isFinite(size) || size <= 0) return 0
    return String(text ?? '').length * size * MONO_ADVANCE_RATIO
}

/** Round `value` up to the next 1, 2 or 5 times a power of ten. */
function roundUpToNiceStep(value) {
    if (!Number.isFinite(value) || value <= 0) return MIN_TICK_INTERVAL_BP
    const magnitude = 10 ** Math.floor(Math.log10(value))
    const normalized = value / magnitude
    if (normalized <= 1) return magnitude
    if (normalized <= 2) return magnitude * 2
    if (normalized <= 5) return magnitude * 5
    return magnitude * 10
}

/**
 * Smallest round interval whose labels still fit side by side.
 *
 * `maxCoord` is the largest coordinate that will be labelled; its formatted
 * width sets how much room each label needs.
 */
export function chooseRulerTickInterval({ spanBp, widthPx, fontSize = RULER_FONT_SIZE, maxCoord }) {
    const span = Number(spanBp)
    const width = Number(widthPx)
    if (!Number.isFinite(span) || span <= 0) return MIN_TICK_INTERVAL_BP
    if (!Number.isFinite(width) || width <= 0) return MIN_TICK_INTERVAL_BP

    const widest = Number.isFinite(Number(maxCoord)) ? Number(maxCoord) : span
    const labelWidth = estimateMonoTextWidth(formatRulerCoord(widest), fontSize)
    const minSpacingPx = labelWidth + RULER_LABEL_GAP + RULER_LABEL_CLEARANCE
    const minIntervalBp = span * (minSpacingPx / width)
    return Math.max(MIN_TICK_INTERVAL_BP, roundUpToNiceStep(minIntervalBp))
}

/**
 * Round coordinates to label across `[start, end]`.
 *
 * One tick before `start` is included: its line falls outside the view but the
 * label beside it bleeds in from the left, which is how the site keeps the
 * leading coordinate on screen instead of leaving a bald patch.
 */
export function rulerTicks({ start, end, widthPx, fontSize = RULER_FONT_SIZE }) {
    const from = Number(start)
    const to = Number(end)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return { interval: MIN_TICK_INTERVAL_BP, ticks: [] }
    }

    const interval = chooseRulerTickInterval({
        spanBp: to - from,
        widthPx,
        fontSize,
        maxCoord: to,
    })

    const ticks = []
    const first = (Math.ceil(from / interval) - 1) * interval
    for (let coord = first; coord <= to; coord += interval) {
        if (coord < 1) continue
        ticks.push(coord)
        if (ticks.length >= MAX_TICKS) break
    }
    return { interval, ticks }
}

/**
 * Vertical placement of the rule, ticks and label baseline.
 *
 * With the ruler along the top of the tracks the rule closes the band off at
 * the bottom and ticks hang down onto it; along the bottom the whole thing is
 * mirrored, so the rule opens the band and ticks drop away from it.
 */
export function rulerGeometry({ top = 0, height = RULER_HEIGHT, position = 'top' } = {}) {
    const bandTop = Number(top) || 0
    const bandHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : RULER_HEIGHT

    if (position === 'bottom') {
        const ruleY = bandTop
        return {
            bandTop,
            bandHeight,
            ruleY,
            tickStart: ruleY,
            tickEnd: bandTop + bandHeight,
            labelBaseline: ruleY + RULER_LABEL_BASELINE_INSET + Math.round(RULER_FONT_SIZE * 0.72),
        }
    }

    const ruleY = bandTop + bandHeight - 1
    return {
        bandTop,
        bandHeight,
        ruleY,
        tickStart: bandTop,
        tickEnd: ruleY,
        labelBaseline: ruleY - RULER_LABEL_BASELINE_INSET,
    }
}
