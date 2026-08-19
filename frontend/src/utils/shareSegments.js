// The arithmetic and the colour ramp behind a part-to-whole figure.
//
// Kept apart from the component that draws it: these are plain functions over
// numbers, they are what is worth testing, and anything else that needs to show
// a share can use them without pulling in the markup.

export const OTHER_SEGMENT_COLOR = { light: '#9ca3af', dark: '#6b7280' }

/** Sequential blue, light → dark: the ramp for ranked magnitude. */
const SEQUENTIAL_LIGHT = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b']
const SEQUENTIAL_DARK = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab']

/**
 * `count` steps of the sequential ramp, strongest first.
 *
 * More-is-darker on a light surface and more-is-lighter on a dark one: what the
 * ramp encodes is distance from the surface, so on a dark panel the deepest
 * step is the one that disappears, and running it the light-surface way would
 * make the largest sequence the faintest mark on the bar.
 *
 * Both ends stay inside the band that still separates from the surface behind
 * them: on light the palest step stops at 250, on dark the deepest stops at 600.
 */
export function sequentialRamp(count, isLight) {
    const ramp = isLight ? SEQUENTIAL_LIGHT : [...SEQUENTIAL_DARK].reverse()
    const total = Math.max(1, count)
    return Array.from({ length: total }, (_, index) => {
        if (total === 1) return ramp[ramp.length - 1]
        const position = (total - 1 - index) / (total - 1)
        return ramp[Math.round(position * (ramp.length - 1))]
    })
}

/**
 * Turn values into parts of a whole, folding anything not listed into "other".
 *
 * `total` is the true whole, which for a genome is every sequence in it — so a
 * bar built from the ten longest is honest about the 696 it is not showing
 * rather than implying the ten are everything.
 */
export function shareSegments(items, total, { otherKey = '__other__', otherLabel = 'other' } = {}) {
    const whole = Number(total) || items.reduce((sum, item) => sum + Number(item.value || 0), 0)
    const listed = items
        .map((item) => ({ ...item, value: Number(item.value || 0) }))
        .filter((item) => item.value > 0)
        .map((item) => ({ ...item, share: whole ? (item.value / whole) * 100 : 0 }))
    const remainder = whole - listed.reduce((sum, item) => sum + item.value, 0)
    if (remainder <= 0) return listed
    return [...listed, {
        key: otherKey,
        label: otherLabel,
        value: remainder,
        share: whole ? (remainder / whole) * 100 : 0,
        isOther: true,
    }]
}
