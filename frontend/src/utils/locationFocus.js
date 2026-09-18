// Everything the location drawer does that is not markup: how a region is cut
// into fetchable pieces, how its sequence is written out, and how the features
// inside it are ordered, filtered and paged.
//
// Kept apart from the drawer for the same reason the note helpers are: these
// are plain functions over plain objects, they are the part worth testing, and
// the panel beside the drawer needs several of them too.

// One request to /api/browse/sequence is capped at 100 kb by the backend, so a
// region is always fetched in chunks of this size.
export const SEQUENCE_CHUNK_BP = 100_000

// What the sequence panel holds on screen at once. A focused location can be a
// whole chromosome; a megabase is as much as a DOM text box can carry without
// the panel becoming the slowest thing in the app, so bigger regions are read
// one block at a time. Copying is not limited to a block — that walks the whole
// region however long it takes.
export const SEQUENCE_BLOCK_BP = 1_000_000

// FASTA line width, matching what the Feature Explorer's exports write.
export const FASTA_LINE_WIDTH = 60

// Features listed per page before the reader pages on. Ten rows is about what
// fits under the sequence section without the notes falling off the bottom.
export const FEATURE_PAGE_SIZE = 10

export const STRAND_OPTIONS = Object.freeze([
    { id: 'both', label: 'Both' },
    { id: 'forward', label: 'Forward' },
    { id: 'reverse', label: 'Reverse' },
])
export const DEFAULT_STRAND_OPTION = 'both'

const COMPLEMENT = {
    A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N',
    R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
    B: 'V', V: 'B', D: 'H', H: 'D',
}

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** The region a location covers, in whole bases, ordered and never empty. */
export function locationSpan(location) {
    const start = num(location?.start)
    const end = num(location?.end)
    if (start === null || end === null) return null
    const low = Math.round(Math.min(start, end))
    const high = Math.round(Math.max(start, end))
    return { start: low, end: Math.max(high, low + 1), length: Math.max(1, high - low) }
}

/**
 * The window of a location the sequence panel is showing, given which block the
 * reader has paged to.
 *
 * Blocks are cut from the start of the region, so block boundaries are stable:
 * paging forward and back lands on the same coordinates every time.
 */
export function sequenceBlock(location, blockIndex = 0, blockSize = SEQUENCE_BLOCK_BP) {
    const span = locationSpan(location)
    if (!span) return null
    const size = Math.max(1, Math.floor(blockSize))
    const count = Math.max(1, Math.ceil(span.length / size))
    const index = Math.min(Math.max(0, Math.floor(Number(blockIndex) || 0)), count - 1)
    const start = span.start + index * size
    const end = Math.min(span.end, start + size)
    return { index, count, start, end, length: end - start, isWhole: count === 1 }
}

/**
 * A range split into requests the sequence endpoint will accept.
 *
 * Half-open [start, end) throughout, which is what the endpoint takes: the
 * browser's own sequence track fetches the same way.
 */
export function sequenceChunks(start, end, chunkSize = SEQUENCE_CHUNK_BP) {
    const from = num(start)
    const to = num(end)
    if (from === null || to === null) return []
    const low = Math.round(Math.min(from, to))
    const high = Math.round(Math.max(from, to))
    if (high <= low) return []
    const size = Math.max(1, Math.floor(chunkSize))
    const chunks = []
    for (let cursor = low; cursor < high; cursor += size) {
        chunks.push({ start: cursor, end: Math.min(high, cursor + size) })
    }
    return chunks
}

/**
 * One base's complement, IUPAC-aware and case-preserving.
 *
 * Exported because the sequence view complements a row a character at a time —
 * it has to leave its not-yet-loaded placeholders alone — and a second copy of
 * this table would be a second thing to get wrong.
 */
export function complementBase(base) {
    const character = String(base || '')
    const upper = character.toUpperCase()
    const complement = COMPLEMENT[upper]
    if (!complement) return 'N'
    return character === upper ? complement : complement.toLowerCase()
}

export function reverseComplement(sequence) {
    const text = String(sequence || '')
    let out = ''
    for (let i = text.length - 1; i >= 0; i -= 1) {
        const base = text[i]
        const upper = base.toUpperCase()
        const complement = COMPLEMENT[upper] || 'N'
        out += base === upper ? complement : complement.toLowerCase()
    }
    return out
}

/** Wrapped to a fixed width, the way every sequence in the app is shown. */
export function wrapSequence(sequence, width = FASTA_LINE_WIDTH) {
    const text = String(sequence || '')
    const size = Math.max(1, Math.floor(width))
    if (!text) return ''
    const lines = []
    for (let i = 0; i < text.length; i += size) lines.push(text.slice(i, i + size))
    return lines.join('\n')
}

/**
 * The FASTA header for a slice of a location.
 *
 * Coordinates are written 1-based inclusive, as everywhere the user reads them,
 * even though they are fetched half-open — so a header pasted into a search box
 * comes back to the same region.
 */
export function locationFastaHeader({ chrom, start, end, reverse = false, genome = '' } = {}) {
    const region = String(chrom || '').trim()
    const from = num(start)
    const to = num(end)
    if (!region || from === null || to === null) return ''
    const label = `${region}:${Math.round(from) + 1}-${Math.round(to)}`
    const parts = [label, reverse ? 'strand:-' : 'strand:+']
    const genomeLabel = String(genome || '').trim()
    if (genomeLabel) parts.push(`genome:${genomeLabel}`)
    return `>${parts.join(' ')}`
}

export function locationFasta({ chrom, start, end, sequence, reverse = false, genome = '' } = {}) {
    const header = locationFastaHeader({ chrom, start, end, reverse, genome })
    const body = wrapSequence(sequence)
    if (!header) return body
    return body ? `${header}\n${body}` : header
}

/**
 * Features ordered 5' to 3' and filtered to the strands the reader asked for.
 *
 * "Most 5'" is read along the strand being listed: on the forward strand that is
 * the leftmost feature, on the reverse strand the rightmost. Listing both means
 * reading the region as it is drawn, left to right.
 */
export function orderFeaturesFiveToThree(features, strandOption = DEFAULT_STRAND_OPTION) {
    const list = (Array.isArray(features) ? features : []).filter(Boolean)
    const wanted = strandOption === 'forward'
        ? (feature) => String(feature?.strand || '+') === '+'
        : strandOption === 'reverse'
            ? (feature) => String(feature?.strand || '+') === '-'
            : () => true
    const filtered = list.filter(wanted)
    const byId = (a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))
    if (strandOption === 'reverse') {
        return filtered.sort((a, b) => (num(b?.end) ?? 0) - (num(a?.end) ?? 0) || byId(a, b))
    }
    return filtered.sort((a, b) => (num(a?.start) ?? 0) - (num(b?.start) ?? 0) || byId(a, b))
}

/** One page of a list, plus what the pager has to say about it. */
export function paginate(items, page = 0, pageSize = FEATURE_PAGE_SIZE) {
    const list = Array.isArray(items) ? items : []
    const size = Math.max(1, Math.floor(pageSize))
    const pageCount = Math.max(1, Math.ceil(list.length / size))
    const index = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pageCount - 1)
    const from = index * size
    return {
        page: index,
        pageCount,
        total: list.length,
        from: list.length === 0 ? 0 : from + 1,
        to: Math.min(list.length, from + size),
        items: list.slice(from, from + size),
    }
}

/** Which features a location's drawer lists, in the order it lists them. */
export function selectLocationFeatures(features, {
    strandOption = DEFAULT_STRAND_OPTION,
    isHiddenByClass = null,
    page = 0,
    pageSize = FEATURE_PAGE_SIZE,
} = {}) {
    const classFiltered = typeof isHiddenByClass === 'function'
        ? (Array.isArray(features) ? features : []).filter((feature) => !isHiddenByClass(feature))
        : (Array.isArray(features) ? features : [])
    const ordered = orderFeaturesFiveToThree(classFiltered, strandOption)
    return { ordered, ...paginate(ordered, page, pageSize) }
}
