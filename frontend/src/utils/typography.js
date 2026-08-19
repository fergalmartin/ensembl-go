/**
 * Ensembl brand typography, shared by CSS, canvas and SVG.
 *
 * The style guide names two typefaces:
 *   - Lato          — body copy, UI chrome, small text
 *   - IBM Plex Mono — sequences, numbers and any text inside a visualisation
 *
 * The stacks below are the ones www.ensembl.org itself ships, so text rendered
 * on a canvas lines up with text rendered by the DOM even before the webfonts
 * have finished loading. `index.css` feeds the same two strings to Tailwind as
 * `--font-sans` / `--font-mono`; anything drawing into a canvas (where there is
 * no cascade to inherit from) should build its `ctx.font` with the helpers here
 * rather than hardcoding a family.
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
