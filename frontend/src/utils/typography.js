/**
 * Share font stacks across CSS, canvas and SVG.
 * Use Lato for interface text and IBM Plex Mono for sequence, numbers and
 * visualisations. index.css supplies the same stacks to Tailwind; canvas code
 * uses these helpers because it cannot inherit CSS font settings.
 */

export const FONT_SANS = 'Lato, "Helvetica Neue", Helvetica, Roboto, Arial, sans-serif'
export const FONT_MONO = '"IBM Plex Mono", "Liberation Mono", Courier, monospace'

const normalizeSize = (size) => {
    const value = Number(size)
    if (!Number.isFinite(value) || value <= 0) return null
    return `${value}px`
}

const normalizeWeight = (weight) => {
    if (weight === undefined || weight === null || weight === '') return ''
    if (typeof weight === 'number') {
        if (!Number.isFinite(weight)) return ''
        return `${Math.round(weight)} `
    }
    const text = String(weight).trim()
    return text ? `${text} ` : ''
}

const buildFont = (family, size, weight) => {
    const px = normalizeSize(size)
    if (!px) return null
    return `${normalizeWeight(weight)}${px} ${family}`
}

/** Canvas `ctx.font` shorthand for UI text: `sansFont(11)`, `sansFont(11, 700)`. */
export function sansFont(size, weight) {
    return buildFont(FONT_SANS, size, weight)
}

/** Canvas `ctx.font` shorthand for sequence/coordinate text. */
export function monoFont(size, weight) {
    return buildFont(FONT_MONO, size, weight)
}
