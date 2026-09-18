// How far a gene is from the top of the window, and which way.
//
// The list in the focus panel is deliberately slow to change -- it is asked
// again only once the scrolling settles, and only redrawn when the answer is
// different. That leaves a question it cannot answer on its own: the reader can
// see ten genes but not where any of them is relative to what is on screen.
//
// This is that answer, and it is pure arithmetic on two numbers, so unlike the
// list it can be recomputed on every row scrolled without asking the backend
// anything.

/**
 * A distance written the way a reader says it, rounded to the significance the
 * number actually carries: nobody wants nine digits to be told a gene is a
 * little way down the chromosome.
 */
export function formatDistance(bases) {
    const n = Math.abs(Math.round(Number(bases) || 0))
    if (n < 1_000) return `${n} bp`
    if (n < 1_000_000) {
        const kb = n / 1_000
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kb`
    }
    const mb = n / 1_000_000
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} Mb`
}

/**
 * Where a gene lies relative to the coordinate at the top of the window.
 *
 * Measured to the nearer edge of the gene rather than to its start, because the
 * question being asked is "how far do I have to go to reach it" -- and for a
 * gene the reader is already inside, the honest answer is none at all.
 *
 * `upstream` and `downstream` are along the forward strand, which is the
 * direction the rows run at location level, and so also the direction the
 * reader scrolls. Strand does not enter into it: this is about travel through
 * the view, not about the gene's own reading direction.
 *
 * @returns {{direction: 'upstream'|'downstream'|'here', distance: number}|null}
 */
export function geneBearing(gene, anchorCoord) {
    // Coerced by hand rather than with Number(), which turns null and the empty
    // string into a perfectly finite zero -- and a missing coordinate read as
    // the start of the chromosome would point every arrow the same way.
    const number = (value) => (typeof value === 'number' && Number.isFinite(value)
        ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN))
    const anchor = number(anchorCoord)
    const start = number(gene?.s)
    const end = number(gene?.e)
    if (!Number.isFinite(anchor) || !Number.isFinite(start) || !Number.isFinite(end)) return null
    const low = Math.min(start, end)
    const high = Math.max(start, end)
    if (anchor >= low && anchor <= high) return { direction: 'here', distance: 0 }
    if (anchor > high) return { direction: 'upstream', distance: anchor - high }
    return { direction: 'downstream', distance: low - anchor }
}
