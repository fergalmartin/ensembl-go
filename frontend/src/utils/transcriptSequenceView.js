// A transcript read in its own coordinates.
//
// Everywhere else in this subsystem a position is a genomic coordinate, 1-based
// inclusive on the forward strand. Here it is not: a *spliced position* counts
// from the transcript's first base, 5' to 3', with the introns already gone --
// so on the minus strand it rises as the genomic coordinate falls. That is the
// space `/transcript-sequence` answers in, and it is the only space in which a
// codon is three consecutive characters.
//
// The conversion between the two happens in `genomicAt` and `splicedRangeFor`,
// and nowhere else. Everything above them talks about spliced positions;
// everything below them talks about coordinates.
//
// The rows are the view's own: sixty to a line, a number down either margin.
// They are built here rather than borrowed from `sequenceViewDisplay` because a
// spliced sequence has nothing to collapse -- no introns are left in it, and
// nothing between genes -- so the layout is one uninterrupted stretch and the
// arithmetic is a divide. What is shared is `SequenceRow` itself, which takes
// equal-length strings and knows nothing about what a position means.
//
// **Nothing here translates.** There is one translation in this application, in
// `backend/translation.py`, and it is the only one that knows a mitochondrial
// contig uses a different genetic code, that a non-ATG initiation codon is
// rendered M, that a terminal stop is stripped and an internal one kept, and
// that a CDS beginning mid-codon starts with an X. A codon table here would get
// all four wrong in silence and would disagree with the protein the Feature
// Explorer already shows for the same transcript. What this module does with a
// protein is place it in rows and map its residues back to the chromosome.

import { BASES_PER_ROW } from './sequenceViewRows.js'
import { CLASS_CODES, CLASS_NONE } from './sequenceViewPalette.js'
import { STOP_AMINO } from './sequenceViewProtein.js'

export { BASES_PER_ROW }

/**
 * The four readings the bar over the sequence switches between.
 *
 * `genomic` is the view as it has always been -- the chromosome, introns and
 * all -- and it is first because it is where every reader starts and what every
 * other reading is a transformation of. The three after it are the transcript's
 * own, and they exist only where one is in focus.
 */
export const KIND_GENOMIC = 'genomic'
export const KIND_TRANSCRIPT = 'transcript'
export const KIND_CDS = 'cds'
export const KIND_PROTEIN = 'protein'

/** The three that are spliced, in the order a reader works down through them. */
export const KINDS = Object.freeze([KIND_TRANSCRIPT, KIND_CDS, KIND_PROTEIN])

/** All four, as the bar offers them. */
export const MODES = Object.freeze([KIND_GENOMIC, ...KINDS])

/** What each one is called. */
export const KIND_LABELS = Object.freeze({
    [KIND_GENOMIC]: 'Genomic',
    [KIND_TRANSCRIPT]: 'Transcript',
    [KIND_CDS]: 'CDS',
    [KIND_PROTEIN]: 'Protein',
})

/**
 * Each reading named inside a sentence.
 *
 * Not the label lower-cased: "CDS" is an acronym and stays one, which is the
 * rule `sequenceViewLabels` states for biotypes and which "Copy the whole cds"
 * breaks in the one place a reader is most likely to read it.
 */
export const KIND_NOUNS = Object.freeze({
    [KIND_GENOMIC]: 'genomic sequence',
    [KIND_TRANSCRIPT]: 'transcript sequence',
    [KIND_CDS]: 'CDS',
    [KIND_PROTEIN]: 'protein',
})

/**
 * What each one is, for a reader who has not met the distinction.
 *
 * Kept to one clause each. These are titles on a control, not documentation:
 * what earns a line here is the difference from the reading beside it, which is
 * exactly what somebody choosing between four buttons is trying to work out.
 */
export const KIND_HINTS = Object.freeze({
    [KIND_GENOMIC]: 'The chromosome as it is, introns and all',
    [KIND_TRANSCRIPT]: 'The exons spliced together, 5\u2032 to 3\u2032',
    [KIND_CDS]: 'The coding sequence only, from the start codon to the stop',
    [KIND_PROTEIN]: 'The amino acids the coding sequence spells',
})

/**
 * What each reading is counted in, where the number needs a name.
 *
 * Here rather than beside the surface that prints it, because three callers say
 * it -- the surface's tip, its selection bar, and the toast after a copy -- and
 * a reading counted in bases in one sentence and residues in the next is the
 * kind of disagreement nobody notices until they are counting.
 */
export const UNITS = Object.freeze({
    [KIND_GENOMIC]: { one: 'base', many: 'bases' },
    [KIND_TRANSCRIPT]: { one: 'base', many: 'bases' },
    [KIND_CDS]: { one: 'base', many: 'bases' },
    [KIND_PROTEIN]: { one: 'residue', many: 'residues' },
})

/** A count with its unit, pluralised. */
export function counted(count, kind) {
    const unit = UNITS[kind] || UNITS[KIND_TRANSCRIPT]
    const many = Math.floor(Number(count) || 0)
    return `${many.toLocaleString()} ${many === 1 ? unit.one : unit.many}`
}

/**
 * Which of a level's legend groups a reading actually puts on screen.
 *
 * A legend is a key to what is drawn, not a catalogue of what the view can draw
 * -- its own rule, stated where it is built. The spliced readings each drop
 * something: there are no introns or splice sites left in a spliced sequence,
 * and no soft-masking reported on one; a CDS is coding by definition, so naming
 * it is a swatch for every cell on screen; and a protein has no nucleotide class
 * at all beyond the two codons this view marks.
 *
 * `null` means every group the level has, which is the genomic reading.
 */
export function legendGroupsFor(kind) {
    if (kind === KIND_TRANSCRIPT) return ['cds', 'utr', 'noncoding', 'start_codon', 'stop_codon']
    if (kind === KIND_CDS) return ['cds', 'start_codon', 'stop_codon']
    if (kind === KIND_PROTEIN) return ['start_codon', 'stop_codon']
    return null
}

/** Whether a reading is spliced, and so drawn in the transcript's own space. */
export function isSpliced(kind) {
    return KINDS.includes(kind)
}

/**
 * Which readings are on offer, and why one is not.
 *
 * Genomic always. The other three need a transcript in focus, because a gene has
 * as many readings as it has isoforms and a location as many as it has genes --
 * the same reason the protein lane appears only where one reading frame is being
 * read.
 *
 * `coding` is what an answer has said about this transcript's CDS: `false` only
 * once one has come back saying there is none. Until then the two coding
 * readings stay on offer, because a transcript annotated protein coding whose
 * CDS is missing is a real thing and so is the other way round -- neither is
 * something to guess from a biotype.
 */
export function modeOffer(kind, { hasTranscript = false, coding = true } = {}) {
    if (kind === KIND_GENOMIC) return { on: true, why: '' }
    if (!hasTranscript) {
        return { on: false, why: 'Read into a transcript to see its own sequence' }
    }
    if (!coding && kind !== KIND_TRANSCRIPT) {
        return { on: false, why: 'This transcript has no coding sequence' }
    }
    return { on: true, why: '' }
}

/**
 * A spliced sequence as rows of sixty.
 *
 * `col0` is the 0-based column the row starts at, which is what `selectionMask`
 * measures a selection in; `first` and `last` are the same two positions
 * 1-based, which is what the gutters print. Both, rather than one and a note
 * about the other, because getting that off by one is the kind of mistake that
 * looks right on every row except the first.
 */
export function splicedRows(length, width = BASES_PER_ROW) {
    const total = Math.max(0, Math.floor(Number(length) || 0))
    const perRow = Math.max(1, Math.floor(Number(width) || BASES_PER_ROW))
    const count = Math.ceil(total / perRow)
    const rows = []
    for (let index = 0; index < count; index += 1) {
        const col0 = index * perRow
        const size = Math.min(perRow, total - col0)
        rows.push({ index, col0, length: size, first: col0 + 1, last: col0 + size })
    }
    return rows
}

/**
 * Which segment of the transcript a spliced position falls in.
 *
 * `segments` are `{s, e, gs, ge, exon}` ascending in spliced space, as
 * `/transcript-sequence` answers with. Binary searched rather than scanned: a
 * hover asks this on every pointer move, and a transcript can have a hundred
 * exons.
 */
export function segmentAt(segments, position) {
    const list = Array.isArray(segments) ? segments : []
    const at = Number(position)
    if (!Number.isFinite(at) || list.length === 0) return null
    let low = 0
    let high = list.length - 1
    while (low <= high) {
        const mid = (low + high) >> 1
        const segment = list[mid]
        if (at < segment.s) high = mid - 1
        else if (at > segment.e) low = mid + 1
        else return segment
    }
    return null
}

/**
 * The genomic coordinate a spliced position sits at, and the exon it is in.
 *
 * On the minus strand the coordinate falls as the position rises, which is the
 * one asymmetry between the strands here and the reason this is a function
 * rather than an addition at each call site.
 */
export function genomicAt(segments, position, strand = '+') {
    const segment = segmentAt(segments, position)
    if (!segment) return null
    const into = Number(position) - segment.s
    return {
        coord: strand === '-' ? segment.ge - into : segment.gs + into,
        exon: segment.exon || 0,
        segment,
    }
}

/**
 * Which bases of the CDS a residue is spelled by, 1-based inclusive.
 *
 * `residue` is 1-based, as the gutter prints it, and the answer is in the
 * *codon-aligned* CDS space the backend's translation layout uses -- where
 * residue n always occupies 3n-2 to 3n. A 5'-incomplete CDS is padded on the
 * left there precisely so that this stays arithmetic rather than becoming a
 * special case, and the padded positions map to no genomic base, which is the
 * honest answer for bases the annotation does not have.
 */
export function codonSpan(residue) {
    const index = Math.floor(Number(residue)) - 1
    if (!Number.isFinite(index) || index < 0) return null
    const start = index * 3 + 1
    return { s: start, e: start + 2 }
}

/**
 * Where on the chromosome a residue's codon lies.
 *
 * `segments` are the protein answer's own: codon-aligned CDS bases, ascending,
 * as `/transcript-sequence` returns them for `kind=protein`.
 *
 * All three positions are resolved and the ones that land are used, rather than
 * demanding all three. Two of them can fail to land, for two different reasons
 * that are both ordinary:
 *
 * - **A 5'-incomplete CDS** begins mid-codon, and its first codon's missing
 *   bases are the layout's left padding, which stands for no base at all.
 *   Refusing the residue would leave the first residue of every incomplete CDS
 *   with no coordinate, and that is the one a reader is most likely to ask
 *   about.
 * - **A codon across an exon junction** has its bases in two segments, hundreds
 *   of kilobases apart. Both land; what changes is that there is no single exon
 *   to name, so the pair is reported instead.
 *
 * The span is the lowest and highest coordinate the codon touches, which across
 * a junction is most of an intron. That is the truth about where it is, and the
 * exons say why it is that wide.
 */
export function codonPlace(segments, residue, strand = '+') {
    const codon = codonSpan(residue)
    if (!codon) return null
    const places = []
    for (let at = codon.s; at <= codon.e; at += 1) {
        const found = genomicAt(segments, at, strand)
        if (found) places.push(found)
    }
    if (!places.length) return null
    const coords = places.map((place) => place.coord)
    const exons = [...new Set(places.map((place) => place.exon).filter(Boolean))]
    return {
        s: Math.min(...coords),
        e: Math.max(...coords),
        // Named only where the whole codon is in one exon; where it is not,
        // which two it is split across is the more useful fact.
        exon: exons.length === 1 ? exons[0] : 0,
        spans: exons.length > 1 ? [exons[0], exons[exons.length - 1]] : null,
        // How many of its three bases the annotation actually has.
        bases: places.length,
    }
}

/**
 * A reading's positions for a stretch of chromosome.
 *
 * The inverse of `genomicRangeFor`, and the half of the pair that makes one
 * highlight survive a change of reading: a stretch is held once, as a genomic
 * range, and each reading works out for itself which of its own positions that
 * covers. Nothing is converted from one reading's positions straight into
 * another's, so there is no pair of readings that has to agree about anything.
 *
 * **Clipped, not refused, where the ends fall outside.** A genomic range whose
 * ends are intronic still covers exonic bases in the middle, and a reader who
 * highlighted across an intron and switched to the spliced transcript means the
 * bases that are still there. Null is for a range that covers none of this
 * reading at all -- a 5' UTR highlight looked at as CDS -- which is a real
 * answer and one the bar says in words.
 */
export function splicedRangeFor(segments, strand, range) {
    const list = Array.isArray(segments) ? segments : []
    const from = Math.min(Number(range?.start), Number(range?.end))
    const to = Math.max(Number(range?.start), Number(range?.end))
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null
    const reverse = strand === '-'
    let low = Infinity
    let high = -Infinity
    for (const segment of list) {
        const a = Math.max(from, segment.gs)
        const b = Math.min(to, segment.ge)
        if (b < a) continue
        // On the minus strand the position falls as the coordinate rises, so
        // the two ends swap over; taking the min and max of both covers it
        // without a second branch.
        const ends = reverse
            ? [segment.s + (segment.ge - b), segment.s + (segment.ge - a)]
            : [segment.s + (a - segment.gs), segment.s + (b - segment.gs)]
        low = Math.min(low, ends[0], ends[1])
        high = Math.max(high, ends[0], ends[1])
    }
    return high >= low ? { s: low, e: high } : null
}

/** Which residue a codon-aligned CDS position belongs to. */
export function residueAt(position) {
    const at = Math.floor(Number(position))
    return Number.isFinite(at) && at > 0 ? Math.ceil(at / 3) : null
}

/**
 * The positions a genomic stretch covers in whichever reading is on screen.
 *
 * For a protein the CDS positions are turned into residues **outward**: a codon
 * the stretch touches at all is a codon the reader meant. Rounding inward would
 * drop a residue at each end of most highlights, and the residue at the edge is
 * usually the interesting one.
 */
export function highlightFor(kind, answer, strand, range) {
    if (!range || !answer || answer.status !== 'ok') return null
    if (kind === KIND_GENOMIC) return null
    const bases = splicedRangeFor(answer.segments, strand, range)
    if (!bases) return null
    if (kind !== KIND_PROTEIN) return bases
    const s = residueAt(bases.s)
    const e = residueAt(bases.e)
    if (!s || !e) return null
    return { s: Math.min(s, e), e: Math.max(s, e) }
}

/**
 * The stretch of chromosome a reading's own positions stand for.
 *
 * A protein's residues go through their codons, which is why this is not simply
 * two calls to `genomicAt`: a residue is three bases that need not be together
 * and need not all exist.
 */
export function genomicRangeFor(kind, answer, strand, span) {
    if (!span || !answer || answer.status !== 'ok') return null
    const place = (position) => (kind === KIND_PROTEIN
        ? codonPlace(answer.segments, position, strand)
        : (() => {
            const found = genomicAt(answer.segments, position, strand)
            return found ? { s: found.coord, e: found.coord } : null
        })())
    const from = place(span.s)
    const to = place(span.e)
    if (!from || !to) return null
    return { start: Math.min(from.s, to.s), end: Math.max(from.e, to.e) }
}

/**
 * What is worth marking on a protein, as class runs.
 *
 * The residues carry no annotation of their own -- every class this view draws
 * describes a base -- so these are facts about the letters, which is why they
 * are worked out here rather than sent. Three of them:
 *
 * - **The initiator**, in the start codon's own colour, so that a reader who has
 *   learned the CDS tab reads this one without a second legend.
 * - **Every stop**, which on a protein from this application means an *internal*
 *   one: the terminal stop is stripped the way Ensembl's own pep file strips it,
 *   so a `*` left in the sequence is a readthrough, a frameshift or a
 *   mis-annotation, and it is the single most worth-seeing thing a protein can
 *   contain.
 * - **A leading X**, the codon that began outside an incomplete CDS. Marked as a
 *   stop rather than left plain would be wrong, so it takes no class and the
 *   panel says what it is in words instead.
 */
export function proteinRuns(protein) {
    const letters = String(protein || '')
    const runs = []
    if (letters.startsWith('M')) runs.push({ s: 1, e: 1, c: 'start_codon' })
    for (let index = 0; index < letters.length; index += 1) {
        if (letters[index] === STOP_AMINO) runs.push({ s: index + 1, e: index + 1, c: 'stop_codon' })
    }
    return runs
}

/**
 * One row's class codes, for a run list already in the row's own space.
 *
 * `buildRowClasses` does this for the main view and would do it here, but it
 * carries the CDS striping, the soft-mask layer and a `strand` it would have to
 * be told to ignore -- none of which mean anything in a spliced sequence, where
 * there is no soft-masking to report and the direction has already been applied.
 * What is left is short enough to state plainly.
 *
 * `allowed`, where it is given, is the set of codes the reader has switched on,
 * exactly as the main view's highlights work.
 */
export function rowClasses(row, runs = [], allowed = null) {
    const length = Math.max(0, Math.floor(Number(row?.length) || 0))
    if (!length) return ''
    const first = row.col0 + 1
    const last = row.col0 + length
    const out = new Array(length).fill(CLASS_NONE)
    for (const run of Array.isArray(runs) ? runs : []) {
        if (run.e < first || run.s > last) continue
        const code = CLASS_CODES[String(run.c || '')]
        if (!code) continue
        if (allowed && !allowed.has(code)) continue
        const from = Math.max(first, run.s)
        const to = Math.min(last, run.e)
        for (let position = from; position <= to; position += 1) out[position - first] = code
    }
    return out.join('')
}

/**
 * The CDS striped by codon, as runs in the sequence's own space.
 *
 * The main view stripes a codon at a time out of `cdsFrame`, which is a map from
 * genomic coordinate to spliced offset. Here the sequence *is* spliced, so a
 * codon is three consecutive positions and the stripe is arithmetic -- but it
 * has to come out as runs, because that is what `rowClasses` reads and because
 * the reader's highlight switches turn the two shades on and off by class code.
 *
 * `cds` is `{s, e}` in the sequence's own positions. A transcript's CDS starts
 * partway in; a CDS tab's starts at one.
 */
export function codonRuns(cds, offset = 0) {
    const from = Math.floor(Number(cds?.s))
    const to = Math.floor(Number(cds?.e))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
    const runs = []
    let position = from + (Number(offset) || 0)
    let index = 0
    while (position <= to) {
        const end = Math.min(to, position + 2)
        runs.push({ s: position, e: end, c: index % 2 === 0 ? 'cds' : 'cds1' })
        position = end + 1
        index += 1
    }
    return runs
}

/**
 * Two run lists as one, the first winning wherever they meet.
 *
 * The codon stripes have to sit under the start and stop codons rather than over
 * them -- those are what tell a reader where the reading begins and ends, and
 * they are drawn in the same order by the backend's own painter. Stated here
 * rather than by concatenating and hoping, because which list wins is the whole
 * of what this does.
 */
export function overlayRuns(over, under) {
    const top = (Array.isArray(over) ? over : []).filter((run) => run && run.e >= run.s)
    const bottom = (Array.isArray(under) ? under : []).filter((run) => run && run.e >= run.s)
    if (!top.length) return bottom.slice().sort((a, b) => a.s - b.s)
    const claimed = top.map((run) => [run.s, run.e]).sort((a, b) => a[0] - b[0])
    const out = top.slice()
    for (const run of bottom) {
        let pieces = [[run.s, run.e]]
        for (const [takenStart, takenEnd] of claimed) {
            const next = []
            for (const [pieceStart, pieceEnd] of pieces) {
                if (takenEnd < pieceStart || takenStart > pieceEnd) {
                    next.push([pieceStart, pieceEnd])
                    continue
                }
                if (takenStart > pieceStart) next.push([pieceStart, takenStart - 1])
                if (takenEnd < pieceEnd) next.push([takenEnd + 1, pieceEnd])
            }
            pieces = next
            if (!pieces.length) break
        }
        for (const [pieceStart, pieceEnd] of pieces) {
            out.push({ s: pieceStart, e: pieceEnd, c: run.c })
        }
    }
    return out.sort((a, b) => a.s - b.s)
}

/**
 * Where a selection is, said the way the reader would say it.
 *
 * `lo` and `hi` are 0-based columns, which is what the drag produces and what
 * `selectionMask` reads. A reader thinks in positions, so this is where the two
 * meet, and it is one place rather than four.
 */
export function selectionSpan(selection, length) {
    const lo = Number(selection?.lo)
    const hi = Number(selection?.hi)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
    const total = Math.max(0, Math.floor(Number(length) || 0))
    const from = Math.max(0, Math.min(lo, hi))
    const to = Math.min(total - 1, Math.max(lo, hi))
    if (to < from) return null
    return { s: from + 1, e: to + 1, length: to - from + 1 }
}

/** The sequence a selection covers, or the whole of it where there is none. */
export function selectedText(sequence, span) {
    const text = String(sequence || '')
    if (!span) return text
    return text.slice(span.s - 1, span.e)
}

/**
 * A reading, or a stretch of one, as a FASTA record.
 *
 * Built here rather than in the component because it is the one thing copying
 * and downloading must not do differently: a reader who copies a protein and a
 * reader who downloads it are entitled to the same bytes, and two call sites
 * assembling a header is how they stop being the same.
 *
 * **The header says what space the numbers are in.** A spliced sequence does not
 * match its own coordinate range -- the introns are gone -- so a record that
 * carried only a chromosome range would be a record whose sequence and whose
 * name disagree. It names the transcript, the reading, and where in that reading
 * the stretch is, which is what the gutters beside it were counting. The same
 * reason `/fasta` writes `spliced:N_segments` on a collapsed record.
 */
export function readingFasta({
    transcriptId = '',
    kind = KIND_TRANSCRIPT,
    chrom = '',
    strand = '+',
    sequence = '',
    span = null,
    width = BASES_PER_ROW,
} = {}) {
    const text = selectedText(sequence, span)
    if (!text) return null
    const unit = kind === KIND_PROTEIN ? 'aa' : 'bp'
    const name = `${transcriptId}${kind === KIND_TRANSCRIPT ? '' : `_${kind}`}`
        + (span ? `:${span.s}-${span.e}` : '')
    const header = `>${name} ${KIND_LABELS[kind]} ${text.length}${unit}`
        + (chrom ? ` ${chrom}(${strand})` : '')
    const lines = []
    for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width))
    return {
        name,
        length: text.length,
        // A filename a filesystem will take, from a name a reader will
        // recognise.
        file: `${name.replace(/[^\w.-]+/g, '_')}.fa`,
        text: `${header}\n${lines.join('\n')}\n`,
    }
}
