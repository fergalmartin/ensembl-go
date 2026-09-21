// Finding a string or a pattern in sequence, wherever sequence is drawn.
//
// The alignment explorer has had this for a while under the name *motif*: an
// ordered list of patterns, each with a colour and a switch, the topmost winning
// where two of them cover the same base. That model is not about alignments at
// all -- it is about what a reader is looking for -- so it lives here now and
// the explorer and the sequence view share it rather than growing two of them
// that would disagree about what a regex means.
//
// What each view does with a match is its own business: the explorer paints
// tiles the server prepared, the sequence view underlines the run and steps
// between them. What they may not differ on is which runs matched, what happens
// where two patterns overlap, and what a reader's saved list is worth after an
// upgrade.
//
// One list per view, because the two are looking at different things: the
// patterns a reader wants over a protein alignment are not the ones they want
// over a chromosome. `loadPatterns` therefore takes the key to read.

import { BUILTIN_GENOME_COLOR_PALETTE, sanitizeHexColor } from '../genomeColorSchemes.js'

/** A pattern matched character for character. */
export const FIND_LITERAL = 'literal'

/** A pattern read as a regular expression. */
export const FIND_REGEX = 'regex'

/**
 * How many patterns a list may hold.
 *
 * Generous rather than meaningful: nobody reads a hundred colours off a screen,
 * but a reader building a list should not meet a limit in the middle of it. The
 * number is here so that a corrupt or hostile store cannot hand the view a
 * million of them.
 */
export const MAX_PATTERNS = 100

/** The longest a single pattern may be. */
export const MAX_PATTERN_LENGTH = 500

/**
 * A stored list, read against what this version understands.
 *
 * Field by field rather than merged wholesale, for the reason the view's other
 * preferences are: a field added after a reader last visited is missing from
 * what they stored, and a wholesale merge leaves it undefined -- which looks
 * exactly like the new thing not working.
 */
export function normalisePatterns(value) {
    const seen = new Set()
    return (Array.isArray(value) ? value : [])
        .filter((item) => item && typeof item.id === 'string'
            && item.id.length > 0 && item.id.length <= 100
            && !seen.has(item.id) && seen.add(item.id))
        .slice(0, MAX_PATTERNS)
        .map((item, index) => ({
            id: item.id,
            pattern: String(item.pattern || '').slice(0, MAX_PATTERN_LENGTH),
            kind: item.kind === FIND_REGEX ? FIND_REGEX : FIND_LITERAL,
            enabled: item.enabled !== false,
            colour: sanitizeHexColor(
                item.colour ?? item.color,
                BUILTIN_GENOME_COLOR_PALETTE[index % 10],
            ),
        }))
}

export function loadPatterns(key, storage) {
    try {
        return normalisePatterns(JSON.parse((storage ?? globalThis.localStorage).getItem(key)))
    } catch {
        // A private window can throw on the accessor itself, and a half-written
        // store parses to nonsense. Either way the reader gets an empty list
        // rather than a view that will not open.
        return []
    }
}

export function savePatterns(key, patterns, storage) {
    try {
        (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(patterns))
        return true
    } catch {
        return false
    }
}

/**
 * The colours a find is drawn in, before the reader chooses otherwise.
 *
 * Not the genome palette, whose first entry is the Ensembl blue. That blue is
 * a mid tone -- it sits close to the page on the dark theme -- and it is a
 * hair from the blue this view fills an exon with, so a match inside an exon
 * was a blue mark on a blue block. What a find needs is the opposite: a colour
 * this view never uses for annotation, bright enough to find at a glance on
 * either theme.
 *
 * None of these is in `sequenceViewPalette`'s vocabulary: not the exon blue,
 * the UTR violet, the intron slate, the splice orange, the start teal, the stop
 * fuchsia, nor the amber the selection and the overlap rule share.
 */
export const FIND_COLOURS = Object.freeze([
    '#22c55e', // green
    '#06b6d4', // cyan
    '#a855f7', // purple
    '#fb7185', // rose
    '#84cc16', // lime
])

/** What one pattern, asked for with no colour of its own, is drawn in. */
export const FIND_DEFAULT_COLOUR = FIND_COLOURS[0]

/** A new pattern, in a colour none of the others is already wearing. */
export function newPattern(patterns = [], palette = FIND_COLOURS) {
    const colours = palette.length ? palette : FIND_COLOURS
    const free = colours.find((colour) => !patterns.some((item) => item.colour === colour))
    return {
        id: (globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}${Math.random()}`),
        pattern: '',
        kind: FIND_LITERAL,
        enabled: true,
        colour: free || colours[patterns.length % colours.length],
    }
}

/** Move one pattern to where another sits, which is what a drag means. */
export function movePattern(patterns, id, target) {
    const from = patterns.findIndex((item) => item.id === id)
    const to = patterns.findIndex((item) => item.id === target)
    if (from < 0 || to < 0 || from === to) return patterns
    const next = [...patterns]
    next.splice(to, 0, ...next.splice(from, 1))
    return next
}

/** The patterns worth searching for: switched on, and with something in them. */
export function activePatterns(patterns) {
    return (patterns || []).filter((item) => item.enabled && item.pattern)
}

/**
 * What identifies a search, as against what identifies a picture of one.
 *
 * Colour, order and the enable switches are applied while drawing, so changing
 * one must not throw away matches that are still correct. Only what was searched
 * for enters the key, sorted, so dragging a row never starts a search.
 */
export function patternSearchKey(patterns) {
    return JSON.stringify(activePatterns(patterns)
        .map(({ id, pattern, kind }) => ({ id, pattern, kind }))
        .sort((a, b) => a.id.localeCompare(b.id)))
}

/**
 * Why a pattern cannot be searched for, or '' where it can.
 *
 * Only a regex can be wrong, and it is wrong in the reader's own words: the
 * engine's message is what says which bracket is unclosed, and a message of our
 * own would say less.
 */
export function patternError(pattern, kind) {
    const text = String(pattern ?? '')
    if (!text || kind !== FIND_REGEX) return ''
    try {
        RegExp(text)
        return ''
    } catch (error) {
        return String(error?.message || 'Not a valid regular expression')
    }
}

/** Every pattern's error, keyed by id, for an editor to draw against its row. */
export function patternErrors(patterns) {
    const out = {}
    for (const item of patterns || []) {
        const message = patternError(item.pattern, item.kind)
        if (message) out[item.id] = message
    }
    return out
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/** A pattern as a global, case-insensitive expression, or null where it is not one. */
export function compilePattern(pattern, kind) {
    const text = String(pattern ?? '')
    if (!text) return null
    try {
        // Case-insensitive because sequence is written in both: soft-masked
        // repeats are lower case and everything else is upper, and a reader
        // looking for ATG means the bases, not the typography.
        return new RegExp(kind === FIND_REGEX ? text : text.replace(ESCAPE, '\\$&'), 'gi')
    } catch {
        return null
    }
}

/**
 * Where a pattern matches in a piece of text, as `[start, end)` offsets.
 *
 * Overlapping matches are not reported: the scan resumes at the end of what it
 * found, which is what every find box in every editor does. An empty match --
 * which a regex like `A*` will happily return at every position -- is skipped
 * and the scan moved on, or it would never terminate.
 */
export function findMatches(text, pattern, kind, { offset = 0, limit = Infinity } = {}) {
    const expression = compilePattern(pattern, kind)
    const body = String(text ?? '')
    if (!expression || !body) return []
    const out = []
    for (let match = expression.exec(body); match; match = expression.exec(body)) {
        if (match[0].length === 0) {
            // A regex that can match nothing -- `A*` -- returns an empty match
            // at every position for ever unless the scan is moved on by hand.
            expression.lastIndex += 1
            if (expression.lastIndex > body.length) break
            continue
        }
        out.push([offset + match.index, offset + match.index + match[0].length])
        if (out.length >= limit) break
    }
    return out
}

/**
 * Resolve overlaps once per answer, never per cell drawn.
 *
 * `spans` is `{ [patternId]: [[start, end], ...] }`. The result is a sorted,
 * disjoint list of `[start, end, colour]` in which the pattern nearest the top
 * of the list has won every base two of them cover -- which is what makes the
 * list an order of priority rather than just an order.
 *
 * A sweep rather than a paint-over, because the answer is read by a binary
 * search while drawing and that needs the spans disjoint and sorted.
 */
export function resolvePatternSpans(patterns, spans) {
    const events = []
    ;(patterns || []).forEach((item, priority) => {
        if (!item.enabled || !item.pattern) return
        for (const [start, end] of spans?.[item.id] || []) {
            events.push([start, priority, 1], [end, priority, -1])
        }
    })
    events.sort((a, b) => a[0] - b[0])
    const active = new Map()
    const result = []
    let previous = events[0]?.[0]
    for (let i = 0; i < events.length;) {
        const position = events[i][0]
        if (position > previous && active.size) {
            const priority = Math.min(...active.keys())
            const colour = patterns[priority].colour
            const last = result.at(-1)
            // Two runs of one colour meeting at a point are one run. Without
            // this a pattern interrupted by a lower one it entirely covers
            // comes back in three pieces that draw as three.
            if (last && last[1] === previous && last[2] === colour) last[1] = position
            else result.push([previous, position, colour])
        }
        while (i < events.length && events[i][0] === position) {
            const [, priority, delta] = events[i]
            i += 1
            const count = (active.get(priority) || 0) + delta
            if (count) active.set(priority, count)
            else active.delete(priority)
        }
        previous = position
    }
    return result
}

/**
 * Put one span on top of a resolved set, whatever the priority said.
 *
 * The order decides who wins a base two patterns cover, which is right while
 * the reader is looking at all of them at once -- and wrong the moment they
 * step onto one of the losers. A match you have jumped to and cannot see is a
 * match you have not been shown, so the one in hand is drawn over the top of
 * whatever outranks it, and only for as long as it is the one in hand.
 *
 * Spans are `[start, end, value]`, inclusive, sorted and disjoint, and come
 * back the same way: whatever the raised span covers is cut out of its
 * neighbours, and a neighbour it lands in the middle of becomes two.
 */
export function raiseSpan(spans, raised) {
    const list = Array.isArray(spans) ? spans : []
    if (!raised) return list
    const [from, to] = raised
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return list

    const out = []
    for (const span of list) {
        const [start, end] = span
        if (end < from || start > to) { out.push(span); continue }
        // The parts of this span the raised one does not cover. Either, both
        // or neither may survive.
        if (start < from) out.push([start, from - 1, span[2]])
        if (end > to) out.push([to + 1, end, span[2]])
    }
    out.push(raised)
    out.sort((a, b) => a[0] - b[0])
    return out
}

/** The first span that could cover a position, by binary search. */
export function firstSpanAt(spans, position) {
    let low = 0
    let high = spans.length
    while (low < high) {
        const mid = (low + high) >>> 1
        if (spans[mid][1] <= position) low = mid + 1
        else high = mid
    }
    return low
}

/**
 * The match nearest a coordinate, by distance from the middle of each.
 *
 * Where a search starts. Starting at the first match in the region is starting
 * wherever the region happens to begin, which on a chromosome is a very long
 * way from wherever the reader is reading -- so a search answered by jumping
 * them somewhere else entirely, and stepping from there walked back towards
 * them one match at a time. Starting at the nearest one means the matches they
 * step through first are the ones around what they were already looking at.
 *
 * A linear scan. It runs once per search, and even a hundred thousand matches
 * is less work than the scan that found them.
 */
export function nearestMatch(matches, coord) {
    const list = Array.isArray(matches) ? matches : []
    const at = Number(coord)
    if (!list.length) return -1
    if (!Number.isFinite(at)) return 0
    let best = 0
    let bestGap = Infinity
    for (let i = 0; i < list.length; i += 1) {
        const [from, to] = list[i]
        // Zero inside the match, so one covering the coordinate always wins.
        const gap = at < from ? from - at : at > to ? at - to : 0
        if (gap < bestGap) {
            best = i
            bestGap = gap
            if (gap === 0) break
        }
    }
    return best
}

/**
 * Which match a step lands on, wrapping at both ends.
 *
 * Wrapping because a find box wraps: a reader at the last match pressing next
 * means the first one, not nothing. `-1` for no matches, so a caller can tell
 * "nowhere to go" from "at the beginning".
 */
export function stepMatch(index, total, delta) {
    const count = Math.max(0, Math.floor(Number(total) || 0))
    if (count <= 0) return -1
    const at = Number.isFinite(index) && index >= 0 ? Math.floor(index) : -1
    const move = Math.trunc(Number(delta) || 0)
    if (at < 0) return move < 0 ? count - 1 : 0
    return ((at + move) % count + count) % count
}

// ---- naming the saved patterns from the simple box ----------------------
//
// The simple box holds one of two things: something to look for, or a list of
// the saved patterns to look for. The second is written `[P1,P2,P3]` -- the
// patterns' places in the list, in the order they are to be tried, the first
// winning any base two of them cover.
//
// It exists so the two boxes are one control rather than two. Applying the full
// list writes the notation into the simple box, so what the reader ends up
// with is a simple search like any other -- countable, steppable, and editable
// without opening the list again. A reader who knows the notation can type it,
// reorder it, or drop a pattern from it without going near the list at all.

const REFS = /^\[\s*[Pp]\d+\s*(?:,\s*[Pp]\d+\s*)*\]$/
const REF = /[Pp](\d+)/g

/** The saved patterns a `[P1,P2]` names, as 1-based places, or null. */
export function parsePatternRefs(query) {
    const text = String(query ?? '').trim()
    if (!REFS.test(text)) return null
    const out = []
    for (const match of text.matchAll(REF)) {
        const at = Number(match[1])
        // `P0` is nobody: the list is written the way a reader counts it.
        if (Number.isFinite(at) && at >= 1) out.push(at)
    }
    return out.length ? out : null
}

/** How a set of saved patterns is written in the simple box. */
export function formatPatternRefs(places) {
    const list = (places || []).filter((at) => Number.isFinite(at) && at >= 1)
    return list.length ? `[${list.map((at) => `P${at}`).join(',')}]` : ''
}

/**
 * Everything the simple box is asking for, as patterns to search with.
 *
 * Three answers. An empty box asks for nothing. A `[P1,P2]` asks for those
 * saved patterns, in that order -- which is what makes the order a priority
 * and not just a list, so a reader can change who wins an overlap by typing.
 * Anything else is one pattern, read as a string or an expression according to
 * the switch beside the box.
 *
 * An ad-hoc search is given the colour of the saved pattern it happens to
 * match, where there is one, so that typing what is already in the list looks
 * the same as picking it from the list.
 */
export function resolveQuery(query, { kind = FIND_LITERAL, patterns = [], colour = '' } = {}) {
    const text = String(query ?? '').trim()
    if (!text) return []

    const places = parsePatternRefs(text)
    if (places) {
        const out = []
        const seen = new Set()
        for (const at of places) {
            const found = patterns[at - 1]
            // A place past the end of the list names nothing. Silently skipped
            // rather than refused: a reader pruning the list should not have
            // every search they saved stop working.
            if (!found || !found.pattern || seen.has(found.id)) continue
            seen.add(found.id)
            out.push({ ...found, enabled: true })
        }
        return out
    }

    const same = patterns.find((item) => item.pattern === text && item.kind === kind)
    return [{
        id: same?.id || 'q',
        pattern: text,
        kind,
        enabled: true,
        colour: same?.colour || colour || FIND_DEFAULT_COLOUR,
    }]
}

/** Whether what is in the box is one of the reader's saved patterns. */
export function savedPatternFor(query, kind, patterns) {
    const text = String(query ?? '').trim()
    if (!text || parsePatternRefs(text)) return null
    return (patterns || []).find((item) => item.pattern === text && item.kind === kind) || null
}

/**
 * A pattern short enough to sit on a control that must not change width.
 *
 * The bar's Find control reports what is being looked for, and what is being
 * looked for can be five hundred characters of regular expression. Shown whole
 * it made that control as wide as the pattern and shuffled every control after
 * it along on each keystroke. The whole of it is in the box, one press away.
 */
export function shortPattern(text, max = 8) {
    const body = String(text ?? '')
    const limit = Math.max(1, Math.floor(Number(max) || 0))
    return body.length <= limit ? body : `${body.slice(0, limit)}…`
}

/**
 * How a find box says where it is, in the words every find box uses.
 *
 * "No matches" rather than "0 of 0": the reader typed something that is not
 * there, and a pair of zeroes makes them work that out.
 */
export function matchLabel(index, total, { truncated = false } = {}) {
    const count = Math.max(0, Math.floor(Number(total) || 0))
    if (count === 0) return 'No matches'
    const shown = count.toLocaleString()
    const more = truncated ? '+' : ''
    if (index === null || index === undefined || index < 0) {
        return `${shown}${more} ${count === 1 ? 'match' : 'matches'}`
    }
    return `${(index + 1).toLocaleString()} of ${shown}${more}`
}
