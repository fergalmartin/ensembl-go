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

/** A span, however the thing carrying it spells its ends. */
export function spanOf(thing) {
    if (!thing) return null
    const from = Number(thing.start ?? thing.s)
    const to = Number(thing.end ?? thing.e)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null
    return { start: Math.min(from, to), end: Math.max(from, to) }
}

/**
 * Whether something is still on screen's worth of the location being read.
 *
 * Overlap rather than containment: a gene wider than the window the reader has
 * jumped to is still the gene they are standing in, and dropping it because its
 * far end is off the page would be a stranger answer than keeping it.
 */
export function overlapsLocation(thing, location) {
    const span = spanOf(thing)
    const window = spanOf(location)
    if (!span || !window) return false
    return span.start <= window.end && span.end >= window.start
}

/**
 * Where to open a genome the reader has just switched to.
 *
 * Every view in the app keeps its own idea of where each genome is being read:
 * a region pinned in the browser, a gene picked out in one of the panels. A
 * reader switching genomes here has almost always been looking at that genome
 * somewhere else, and dropping them at its default starting locus instead
 * throws that away and makes them find it again.
 *
 * The gene wins where there is one, because it is the more particular answer,
 * and its own span stands in for the location when the region on record belongs
 * to another chromosome. With neither, there is nothing to say and the caller
 * falls back to asking the backend for a starting region.
 */
export function focusFromStart(genomeKey, point) {
    const gene = point?.gene || null
    const geneSpan = spanOf(gene)
    const geneChrom = String(gene?.chrom || '').trim()
    const location = point?.location || null
    const locationSpan = spanOf(location)
    const locationChrom = String(location?.chrom || '').trim()

    if (gene && geneSpan && geneChrom) {
        const sameChrom = locationChrom && locationChrom === geneChrom
        return {
            genomeKey,
            chrom: geneChrom,
            focus: {
                level: LEVEL_GENE,
                location: sameChrom && locationSpan ? locationSpan : geneSpan,
                gene: {
                    id: gene.id,
                    name: gene.name,
                    start: geneSpan.start,
                    end: geneSpan.end,
                    strand: gene.strand || '+',
                    biotype: gene.biotype || '',
                },
            },
        }
    }

    if (locationSpan && locationChrom) {
        return {
            genomeKey,
            chrom: locationChrom,
            focus: { level: LEVEL_LOCATION, location: locationSpan },
        }
    }

    return null
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
            const location = action.location || state.location
            // And on the same chromosome, a jump keeps only what it lands on.
            // The chain is the reader's way back to what they were reading; a
            // gene a megabase off the page is not that, and leaving it in the
            // drawer offers a way back to somewhere they have deliberately
            // left. Anything still under the window survives, so nudging the
            // ends of a location does not cost the reader their place.
            const keeps = (thing) => (!moved && overlapsLocation(thing, location) ? thing : null)
            return {
                ...state,
                chrom,
                level: LEVEL_LOCATION,
                location,
                gene: keeps(state.gene),
                transcript: keeps(state.transcript),
                feature: keeps(state.feature),
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
