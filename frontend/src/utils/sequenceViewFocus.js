// The level of focus, and how moving between levels works.
//
// Not a nested menu. The focus is a stack of identities -- a location, a gene on
// it, a transcript of that gene, an exon or intron of that transcript -- plus a
// pointer at whichever is currently being read. Going down sets the child and
// moves the pointer. Going up moves the pointer only, so the child is still
// there and coming back down is free and lands where the reader left off.
//
// An ad-hoc selection is not in that chain: it has no parent and no child, so it
// sits beside the chain rather than in it, and dismissing it returns the pointer
// to wherever it was.

export const LEVEL_LOCATION = 'location'
export const LEVEL_GENE = 'gene'
export const LEVEL_TRANSCRIPT = 'transcript'
export const LEVEL_FEATURE = 'feature'
export const LEVEL_CUSTOM = 'custom'

// The chain, outermost first. Position in this list is what "parent" and "child"
// mean, which is also the order the drawer stacks its sections in.
export const FOCUS_CHAIN = [LEVEL_LOCATION, LEVEL_GENE, LEVEL_TRANSCRIPT, LEVEL_FEATURE]

/**
 * How much sequence sits around the thing in focus, at each end.
 *
 * Two numbers rather than one, and named for the ends of the *feature* rather
 * than the ends of the screen: 5' is upstream of the thing being read, which on
 * the minus strand is the right-hand side of a forward-genomic window. A reader
 * asking for a promoter is asking for the 5' end whichever strand the gene is
 * on, and a single symmetric flank made them ask for twice as much sequence as
 * they wanted in order to get it.
 *
 * Sixty at a gene and a transcript: enough to see a promoter or the poly(A)
 * side, and short enough to still read as flanking rather than as context.
 * Ten at an exon or an intron, which shows both splice sites and is about what
 * someone copying one intron wants either side of it. A location has no flank:
 * it is already a stretch of chromosome the reader chose the ends of.
 */
export const DEFAULT_FLANKS = Object.freeze({
    [LEVEL_LOCATION]: Object.freeze({ five: 0, three: 0 }),
    [LEVEL_GENE]: Object.freeze({ five: 60, three: 60 }),
    [LEVEL_TRANSCRIPT]: Object.freeze({ five: 60, three: 60 }),
    [LEVEL_FEATURE]: Object.freeze({ five: 10, three: 10 }),
    [LEVEL_CUSTOM]: Object.freeze({ five: 0, three: 0 }),
})

/** The levels a flank is worth offering for, in the order they are read. */
export const FLANK_LEVELS = Object.freeze([LEVEL_GENE, LEVEL_TRANSCRIPT, LEVEL_FEATURE])

/** A flank pair, however little of one was stored. */
export function flankPair(value, fallback = { five: 0, three: 0 }) {
    // A number is what this setting used to be, and a reader who set one before
    // the two ends were separate meant it at both ends.
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { five: Math.max(0, Math.round(value)), three: Math.max(0, Math.round(value)) }
    }
    const five = Number(value?.five)
    const three = Number(value?.three)
    return {
        five: Number.isFinite(five) ? Math.max(0, Math.round(five)) : fallback.five,
        three: Number.isFinite(three) ? Math.max(0, Math.round(three)) : fallback.three,
    }
}

/**
 * A flank pair as the two ends of a forward-genomic window.
 *
 * The one place the strand is turned into a direction. Everything upstream of
 * here talks about 5' and 3', which is what a reader means; everything
 * downstream talks about low and high, which is what a coordinate is.
 */
export function flankSides(pair, strand = '+') {
    const { five, three } = flankPair(pair)
    return strand === '-' ? { low: three, high: five } : { low: five, high: three }
}

export function emptyFocus(genomeKey = '', chrom = '') {
    return {
        genomeKey,
        chrom,
        level: LEVEL_LOCATION,
        location: null,
        gene: null,
        transcript: null,
        feature: null,
        custom: null,
        previousLevel: LEVEL_LOCATION,
    }
}

/** Where the reader can go from here: the level above, and the level below. */
export function neighbours(focus) {
    if (!focus || focus.level === LEVEL_CUSTOM) {
        return { parent: focus?.previousLevel || LEVEL_LOCATION, child: null }
    }
    const index = FOCUS_CHAIN.indexOf(focus.level)
    return {
        parent: index > 0 ? FOCUS_CHAIN[index - 1] : null,
        child: index >= 0 && index < FOCUS_CHAIN.length - 1 ? FOCUS_CHAIN[index + 1] : null,
    }
}

/** Whether a level has something chosen, and so can be moved to. */
export function levelIsSet(focus, level) {
    if (!focus) return false
    if (level === LEVEL_LOCATION) return Boolean(focus.location)
    if (level === LEVEL_CUSTOM) return Boolean(focus.custom)
    return Boolean(focus[level])
}

/**
 * The stretch of genome a focus is looking at, before the contig is consulted.
 *
 * The backend clips this to the chromosome and sends back what it used, which
 * is what the view finally renders; this is the estimate that lets the first
 * rows be laid out before the reply arrives. The two differ only for a focus
 * within a flank's distance of the end of a contig.
 */
export function focusWindow(focus, flanks = DEFAULT_FLANKS) {
    if (!focus) return null
    const level = focus.level
    const target = level === LEVEL_LOCATION ? focus.location : focus[level]
    if (!target) return null
    const pad = flankSides(
        flanks?.[level] ?? DEFAULT_FLANKS[level],
        // An exon or an intron is read in its transcript's direction; it does
        // not carry a strand of its own in every list that offers one.
        strandOf(focus, level),
    )
    const start = Math.max(1, Math.min(target.start, target.end) - pad.low)
    const end = Math.max(target.start, target.end) + pad.high
    return { start, end }
}

/** Which way the thing in focus is read. */
export function strandOf(focus, level = focus?.level) {
    if (!focus) return '+'
    if (level === LEVEL_FEATURE) {
        return focus.feature?.strand || focus.transcript?.strand || focus.gene?.strand || '+'
    }
    if (level === LEVEL_TRANSCRIPT) return focus.transcript?.strand || focus.gene?.strand || '+'
    if (level === LEVEL_GENE) return focus.gene?.strand || '+'
    return '+'
}

export function focusReducer(state, action) {
    switch (action.type) {
        case 'reset':
            return { ...emptyFocus(action.genomeKey, action.chrom), ...action.focus }

        case 'enterLocation': {
            // A jump may cross chromosomes, and landing on the right
            // coordinates of the wrong one is worse than not moving at all.
            // Crossing invalidates the whole chain below.
            const chrom = action.chrom || state.chrom
            const moved = chrom !== state.chrom
            return {
                ...state,
                chrom,
                level: LEVEL_LOCATION,
                location: action.location || state.location,
                gene: moved ? null : state.gene,
                transcript: moved ? null : state.transcript,
                feature: moved ? null : state.feature,
                custom: null,
            }
        }

        case 'enterGene':
            // A different gene invalidates whatever was chosen below it. The same
            // gene does not, so going up to the gene and back down to its
            // transcript is free.
            if (state.gene?.id === action.gene?.id) {
                return { ...state, level: LEVEL_GENE, custom: null }
            }
            return {
                ...state,
                level: LEVEL_GENE,
                gene: action.gene,
                transcript: null,
                feature: null,
                custom: null,
            }

        case 'enterTranscript':
            if (state.transcript?.id === action.transcript?.id) {
                return { ...state, level: LEVEL_TRANSCRIPT, custom: null }
            }
            return {
                ...state,
                level: LEVEL_TRANSCRIPT,
                transcript: action.transcript,
                feature: null,
                custom: null,
            }

        case 'enterFeature':
            return { ...state, level: LEVEL_FEATURE, feature: action.feature, custom: null }

        case 'ascend': {
            const { parent } = neighbours(state)
            if (!parent || !levelIsSet(state, parent)) return state
            return { ...state, level: parent, custom: null }
        }

        case 'goTo':
            if (!levelIsSet(state, action.level)) return state
            return { ...state, level: action.level, custom: action.level === LEVEL_CUSTOM ? state.custom : null }

        case 'setCustom': {
            if (!action.custom) return state
            const start = Math.min(action.custom.start, action.custom.end)
            const end = Math.max(action.custom.start, action.custom.end)
            return {
                ...state,
                custom: { start, end },
                // Remembered so that dismissing the selection puts the reader
                // back where they were rather than at the top of the chain.
                previousLevel: state.level === LEVEL_CUSTOM ? state.previousLevel : state.level,
            }
        }

        case 'focusCustom':
            if (!state.custom) return state
            return { ...state, level: LEVEL_CUSTOM }

        case 'clearCustom':
            return {
                ...state,
                custom: null,
                level: state.level === LEVEL_CUSTOM ? state.previousLevel : state.level,
            }

        default:
            return state
    }
}
