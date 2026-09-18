// What a reader means by what they typed into the search box.
//
// Three things can be typed, and they ask for different things:
//
//   - **A range** -- `1:1-5,000,000`, or `1000-2000` on the chromosome already
//     open. The reader has named both ends, so that is the region shown. This is
//     the whole of it: a range is never interpreted as anything softer.
//   - **A bare coordinate** -- `119,711,874`. Not a region but a destination.
//     Somewhere inside what is already open it moves the page there and leaves
//     the region alone, because narrowing a chromosome to a screenful around one
//     base would throw away what the reader was reading. Outside it, there is
//     nothing to stay within, so a screenful is framed around it.
//   - **Anything else** is a name, and a question for the annotation.
//
// Pulled out of the view because the difference between the first two is
// genuinely subtle and was got wrong: the containment shortcut was applied to
// ranges as well as to coordinates, so opening a chromosome and then asking for
// a few megabases of it did nothing whatever -- the new range was inside the old
// one, so it was treated as a jump to a base that was already on screen. Every
// narrower range after that was inside the first, and there was no way back out
// except through a gene name.
//
// Coordinates are 1-based inclusive, as everywhere else in this subsystem.

/** How much sequence is framed around a bare coordinate, either side. */
export const COORDINATE_WINDOW = 600

const RANGE = /^(?:([^:\s]+)\s*:\s*)?(\d+)\s*-\s*(\d+)$/
const COORDINATE = /^(?:([^:\s]+)\s*:\s*)?(\d+)$/

/**
 * What was typed, as something to act on, or null for an empty box.
 *
 * `chrom` falls back to the one already open, so a reader need not repeat it to
 * move about the chromosome they are on.
 */
export function parseSearchQuery(text, fallbackChrom = '') {
    const query = String(text ?? '').trim()
    if (!query) return null
    // Thousands separators are how the gutters print coordinates, so they are
    // what a reader copies back in.
    const cleaned = query.replace(/,/g, '')

    const ranged = cleaned.match(RANGE)
    if (ranged) {
        const [, where, from, to] = ranged
        // Either way round. A reader who types the high end first has said
        // exactly which stretch they mean, and refusing them on a detail of
        // order would be pedantry.
        const low = Math.min(Number(from), Number(to))
        const high = Math.max(Number(from), Number(to))
        return {
            kind: 'range',
            query,
            chrom: where || fallbackChrom,
            start: Math.max(1, low),
            end: Math.max(1, high),
        }
    }

    const single = cleaned.match(COORDINATE)
    if (single) {
        const [, where, from] = single
        const at = Number(from)
        return {
            kind: 'coordinate',
            query,
            chrom: where || fallbackChrom,
            at,
            start: Math.max(1, at - COORDINATE_WINDOW),
            end: at + COORDINATE_WINDOW,
        }
    }

    return { kind: 'name', query }
}

/**
 * Whether a coordinate's screenful lies inside the region already open.
 *
 * Only ever true of a coordinate. A range says what to show and is shown.
 *
 * Takes the chromosome and the region rather than the whole focus, so a caller
 * can depend on those two and not on the focus object -- which in this view
 * changes on every frame of a drag.
 */
export function withinOpenRegion(parsed, chrom, location) {
    if (parsed?.kind !== 'coordinate') return false
    if (!location || parsed.chrom !== chrom) return false
    return parsed.start >= location.start && parsed.end <= location.end
}
