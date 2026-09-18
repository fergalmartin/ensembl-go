// How the reader likes to read, and how to make sense of what they stored last
// time.
//
// Everything here is a per-viewer convenience kept in localStorage: which
// classes are highlighted, how much sequence sits around the thing in focus,
// what is collapsed, which way round the sequence reads and whether the protein
// is drawn over its codons. None of it describes the data, so none of it is
// worth a round trip, and a reader who clears their browser loses nothing but
// their own settings.
//
// Reading is done field by field rather than by merging wholesale. A switch
// added after a reader last visited is missing from what they stored, and a
// wholesale merge leaves it off -- which looks exactly like the new thing not
// working. The same rule is what lets an older shape be read forward: a flank
// stored as one number was symmetric, and a collapse stored as a boolean plus a
// single flank meant both kinds at once.

import { DEFAULT_COLOURS, normaliseColours } from './sequenceViewColours.js'
import { COLLAPSE_KINDS, DEFAULT_COLLAPSE } from './sequenceViewDisplay.js'
import { DEFAULT_FLANKS, flankPair } from './sequenceViewFocus.js'
import { LEVEL_GROUPS, defaultHighlights } from './sequenceViewPalette.js'

export const PREFS_KEY = 'ensemblGo.sequenceView.v1'

function count(value, fallback, { min = 0, max = 100_000 } = {}) {
    // Nothing stored is not zero stored. `Number(null)` is 0 and `Number('')`
    // is 0, and either would silently replace a default with a setting the
    // reader never made.
    if (value === null || value === undefined || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function defaultPrefs() {
    const highlights = {}
    for (const level of Object.keys(LEVEL_GROUPS)) highlights[level] = defaultHighlights(level)
    const flanks = {}
    for (const [level, pair] of Object.entries(DEFAULT_FLANKS)) flanks[level] = { ...pair }
    const collapse = {}
    for (const kind of COLLAPSE_KINDS) collapse[kind] = { ...DEFAULT_COLLAPSE[kind] }
    return { highlights, flanks, collapse, colours: { ...DEFAULT_COLOURS }, reverse: false, protein: false }
}

/** What was stored, read against the defaults as they are now. */
export function normalisePrefs(stored) {
    const base = defaultPrefs()

    const highlights = {}
    for (const [level, defaults] of Object.entries(base.highlights)) {
        highlights[level] = { ...defaults, ...(stored?.highlights?.[level] || {}) }
    }

    const flanks = {}
    for (const [level, pair] of Object.entries(base.flanks)) {
        flanks[level] = flankPair(stored?.flanks?.[level], pair)
    }

    // The older shape: one switch for both kinds, and one flank for both ends of
    // every collapse. A reader who had it on meant both kinds, since that is
    // what the one switch did.
    const legacyOn = typeof stored?.collapse === 'boolean' ? stored.collapse : null
    const legacyFlank = Number.isFinite(Number(stored?.collapseFlank))
        ? Number(stored.collapseFlank) : null

    const collapse = {}
    for (const kind of COLLAPSE_KINDS) {
        const held = legacyOn === null ? stored?.collapse?.[kind] : null
        collapse[kind] = {
            on: legacyOn === null ? Boolean(held?.on) : legacyOn,
            flank: count(held?.flank ?? legacyFlank, base.collapse[kind].flank),
            min: count(held?.min, base.collapse[kind].min, { min: 1 }),
        }
    }

    return {
        highlights,
        flanks,
        collapse,
        colours: normaliseColours(stored?.colours),
        reverse: Boolean(stored?.reverse),
        protein: Boolean(stored?.protein),
    }
}

export function readPrefs(storage = globalThis.localStorage) {
    // The accessor itself can throw in a private window, so a failure here means
    // defaults rather than a view that will not open.
    try {
        return normalisePrefs(JSON.parse(storage?.getItem(PREFS_KEY) || '{}') || {})
    } catch {
        return defaultPrefs()
    }
}

export function writePrefs(value, storage = globalThis.localStorage) {
    try {
        storage?.setItem(PREFS_KEY, JSON.stringify(value))
    } catch {
        // Nothing to do, and nothing worth telling the reader about.
    }
}
