const clamp = (value, maximum) => Math.min(Math.max(0, value), Math.max(0, maximum))

// Move the page until the row viewport's column headers reach its top edge.
// Only then spend downward movement on the rows underneath those sticky headers.
// On the way back, return through the rows before moving up to the search controls.
export function resultsScrollPlan({ delta, outerTop, outerMax, rowsTop, innerTop, innerMax }) {
    let outer = clamp(outerTop, outerMax)
    let inner = clamp(innerTop, innerMax)
    if (delta > 0) {
        const reveal = Math.min(delta, Math.max(0, rowsTop), outerMax - outer)
        outer += reveal
        const throughRows = Math.min(delta - reveal, innerMax - inner)
        inner += throughRows
        outer = clamp(outer + delta - reveal - throughRows, outerMax)
    } else {
        const throughRows = Math.min(-delta, inner)
        inner -= throughRows
        outer = clamp(outer + delta + throughRows, outerMax)
    }
    return { outerTop: outer, innerTop: inner }
}
