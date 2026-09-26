// Reading what was typed into the browser's search box, and saying plainly when it
// cannot be followed. The box used to try whatever it was given: an unknown sequence
// name was loaded as if it existed, a range off the end was clamped without a word, and
// a gene that did not exist left the view exactly as it was.

const formatBp = (value) => Math.round(Number(value) || 0).toLocaleString('en-US')

/**
 * What a search query is.
 *
 *   { kind: 'range', chrom, start, end, swapped }  chr:start-end (also .. and commas)
 *   { kind: 'position', chrom, position }          chr:position
 *   { kind: 'malformed', message }                 has a colon but is not a location
 *   { kind: 'text', text }                         a gene, ID or sequence name to look up
 *   { kind: 'empty' }
 */
export function parseLocationQuery(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return { kind: 'empty' }
    const normalized = text.replace(/[–—]/g, '-').replace(/\.\./g, '-')
    const colon = normalized.indexOf(':')
    if (colon < 0) return { kind: 'text', text }

    const chrom = normalized.slice(0, colon).trim()
    const coords = normalized.slice(colon + 1).trim()
    if (!chrom || /\s/.test(chrom)) {
        return { kind: 'malformed', message: `"${text}" is not a location. Use chromosome:start-end, for example 1:100,000-200,000.` }
    }
    const number = (token) => {
        const cleaned = String(token).replace(/[,\s]/g, '')
        return /^\d+$/.test(cleaned) ? Number.parseInt(cleaned, 10) : NaN
    }
    const rangeMatch = coords.match(/^([\d,\s]+)-([\d,\s]+)$/)
    if (rangeMatch) {
        const a = number(rangeMatch[1])
        const b = number(rangeMatch[2])
        if (Number.isFinite(a) && Number.isFinite(b)) {
            return { kind: 'range', chrom, start: Math.min(a, b), end: Math.max(a, b), swapped: a > b }
        }
    }
    const position = number(coords)
    if (coords && Number.isFinite(position)) return { kind: 'position', chrom, position }
    return {
        kind: 'malformed',
        message: `Could not read "${coords || text}" as a position on ${chrom}. Use ${chrom}:start-end, for example ${chrom}:100,000-200,000.`,
    }
}

/**
 * A requested 1-based range checked against a sequence's bounds.
 *
 * Returns the part that exists and, when that is not all of it, a warning to show:
 * partly off either end shows what there is; wholly off the end shows the nearest end.
 * `null` warning means the range was fine.
 */
export function checkRangeAgainstBounds({ start, end }, { min, max, chrom }) {
    const lo = Math.max(1, Math.floor(Number(min) || 1))
    const hi = Math.max(lo, Math.floor(Number(max) || lo))
    const s = Math.floor(Number(start))
    const e = Math.floor(Number(end))
    const name = String(chrom || 'this sequence')
    const extent = `${name} (${formatBp(lo)}-${formatBp(hi)})`
    const asked = s === e ? `${name}:${formatBp(s)}` : `${name}:${formatBp(s)}-${formatBp(e)}`
    if (s > hi) {
        return {
            start: Math.max(lo, hi - Math.max(1, e - s)), end: hi, outside: true,
            warning: `${asked} is past the end of ${extent}. Showing the end of ${name}.`,
        }
    }
    if (e < lo) {
        return {
            start: lo, end: Math.min(hi, lo + Math.max(1, e - s)), outside: true,
            warning: `${asked} is before the start of ${extent}. Showing the start of ${name}.`,
        }
    }
    const clippedStart = Math.max(lo, s)
    const clippedEnd = Math.min(hi, e)
    if (clippedStart !== s || clippedEnd !== e) {
        return {
            start: clippedStart, end: clippedEnd, outside: false,
            warning: `${asked} runs past ${clippedStart !== s ? 'the start' : 'the end'} of ${extent}. Showing ${name}:${formatBp(clippedStart)}-${formatBp(clippedEnd)}.`,
        }
    }
    return { start: s, end: e, outside: false, warning: null }
}
