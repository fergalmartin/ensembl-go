// Selecting several files in a list the way file managers do: Shift-click for a range,
// Cmd/Ctrl-click for one more, click-and-drag across rows. Pure, so the list component
// only has to say which rows were involved.

/** The paths from row `a` to row `b` inclusive, either way round, in list order. */
export function rangeBetween(paths, a, b) {
    const list = Array.isArray(paths) ? paths : []
    const i = list.indexOf(a)
    const j = list.indexOf(b)
    if (i < 0 || j < 0) return []
    const [lo, hi] = i <= j ? [i, j] : [j, i]
    return list.slice(lo, hi + 1)
}

/** `base` with `added` appended, keeping the order things were chosen in, without repeats. */
export function mergeSelection(base, added) {
    const out = Array.isArray(base) ? base.slice() : []
    for (const path of Array.isArray(added) ? added : []) if (!out.includes(path)) out.push(path)
    return out
}
