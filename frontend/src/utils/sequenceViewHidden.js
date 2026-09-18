// What the reader has silenced.
//
// Hiding is not a drawing switch. A hidden gene casts no vote, so the stretch it
// shared with its neighbour stops being "mixed" and reads as what the neighbour
// says it is; a hidden isoform stops contesting its gene's bases. That is the
// point of it -- turning things off until what is left is unambiguous -- and it
// is why the set travels to the backend rather than being applied to the answer
// after it arrives. The classes are computed once, over the features that are
// still speaking.
//
// One set for the whole view rather than one per level. Gene and transcript
// identifiers do not collide, so a gene hidden at a location is still hidden
// when the reader opens the gene above it, which is what they meant.

const EMPTY = Object.freeze([])

export const EMPTY_HIDDEN = Object.freeze(new Set())

/** Hide or show one feature. Returns a new set; the old one is untouched. */
export function toggleHidden(hidden, id) {
    const key = String(id || '')
    if (!key) return hidden || EMPTY_HIDDEN
    const next = new Set(hidden || EMPTY)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
}

/** Hide every one of these, leaving anything already hidden alone. */
export function hideAll(hidden, ids) {
    const next = new Set(hidden || EMPTY)
    for (const id of ids || EMPTY) {
        const key = String(id || '')
        if (key) next.add(key)
    }
    return next
}

/** Show these again, leaving the rest of the set alone. */
export function showAll(hidden, ids) {
    const next = new Set(hidden || EMPTY)
    for (const id of ids || EMPTY) next.delete(String(id || ''))
    return next
}

export function isHidden(hidden, id) {
    return Boolean(hidden && hidden.has(String(id || '')))
}

/** True when every one of these is hidden, and there is at least one. */
export function allHidden(hidden, ids) {
    const list = Array.isArray(ids) ? ids : [...(ids || EMPTY)]
    if (list.length === 0) return false
    return list.every((id) => isHidden(hidden, id))
}

/**
 * The set as a request parameter.
 *
 * Sorted, so that the same set hidden in a different order is the same request
 * and hits the same cached tile rather than fetching it again. That matters more
 * than it looks: every toggle re-asks for every tile on screen, and toggling one
 * gene off and on again should cost nothing the second time.
 */
export function hiddenParam(hidden) {
    if (!hidden || hidden.size === 0) return ''
    return [...hidden].sort().join(',')
}
