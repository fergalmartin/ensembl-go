// What the sequence view can hand over as a file: what may be downloaded, how
// it is shaped, and the row model every format is written from.
//
// The view already knows how to decide what a base looks like. Rather than
// describe that a second time for a file, an export walks the *same* layout
// through the *same* painter the canvas uses -- `buildDisplayLayout`,
// `displayRow`, `paintDisplayRow` -- with a reader over downloaded sequence
// standing in for the scroll buffer. So a coloured export cannot drift from the
// screen: there is one description of what a row is, and a file is that
// description written out instead of drawn.
//
// Three things vary, and they are the three questions the panel asks:
//
//   - **What.** The thing in focus, anywhere along the chain from the location
//     down to one exon, or the records a reader has ticked. Both modes are the
//     same list of *entries* here, which is why nothing below this point has to
//     know which one it is in.
//   - **Shape.** As shown -- collapsed stretches left out, read in the view's
//     direction, the reader's flank included -- or the whole span, forward.
//   - **Format.** FASTA and plain text are bases. RTF and HTML carry the
//     colours, which is the whole point of having them.
//
// Coordinates are 1-based inclusive on the forward strand, as everywhere else
// in this subsystem.

import {
    DEFAULT_COLLAPSE,
    buildDisplayLayout,
    collapseKeeps,
    coordIntervalsForRows,
    displayRow,
} from './sequenceViewDisplay.js'
import {
    DEFAULT_FLANKS,
    FLANK_LEVELS,
    FOCUS_CHAIN,
    LEVEL_CUSTOM,
    LEVEL_FEATURE,
    LEVEL_GENE,
    LEVEL_LOCATION,
    LEVEL_TRANSCRIPT,
    flankPair,
    flankSides,
    focusWindow,
    levelIsSet,
    strandOf,
} from './sequenceViewFocus.js'
import { CLASS_CODES, CLASS_GAP, CLASS_NONE } from './sequenceViewPalette.js'
import { EDGE_OVERLAP, annotationTiles } from './sequenceViewClasses.js'
import { DEFAULT_PALETTE, textOnColour } from './sequenceViewColours.js'
import { paintDisplayRow } from './sequenceViewPaint.js'
import { NO_AMINO } from './sequenceViewProtein.js'
import {
    PLACEHOLDER_BASE,
    SEQUENCE_VIEW_CHUNK_BP,
    chunkIndexForCoord,
    chunkRange,
} from './sequenceViewChunks.js'
import { BASES_PER_ROW } from './sequenceViewRows.js'
import { aminoRow, rowClasses, splicedRows } from './transcriptSequenceView.js'
import { fastaHeaderLine } from './sequenceViewPlain.js'

/** As shown on screen -- collapsed stretches left out -- or every base of it. */
export const SHAPE_SHOWN = 'shown'
export const SHAPE_FULL = 'full'

/**
 * Which way round the sequence is written.
 *
 * Kept apart from the shape, because they are different questions and were
 * tangled: asking for the whole span used to force the forward strand, so there
 * was no way to download a complete gene the way it is actually read.
 *
 * `view` is each record in its own direction -- a gene on the minus strand
 * reverse-complemented, a location forward -- with the reader's own flip on
 * top, which is exactly what the view is doing. The other two force the
 * question, and are the answer for a set of records whose strands disagree.
 */
export const ORIENTATION_VIEW = 'view'
export const ORIENTATION_FORWARD = 'forward'
export const ORIENTATION_REVERSE = 'reverse'

/** Whether a record is read from its far end when nothing is asked of it. */
export function naturallyReverse(entry, strand = '') {
    return (strand || entry?.strand || '+') === '-' && entry?.level !== LEVEL_LOCATION
}

/** Which way a record will actually be read, given what was asked. */
export function readsReverse(entry, { orientation = ORIENTATION_VIEW, flip = false, strand = '' } = {}) {
    if (orientation === ORIENTATION_FORWARD) return false
    if (orientation === ORIENTATION_REVERSE) return true
    return naturallyReverse(entry, strand) !== Boolean(flip)
}

/**
 * What a coloured export costs, and where it stops being a good idea.
 *
 * There is no hard ceiling here any more. A coloured file used to be refused
 * past a megabase, which was a number picked out of caution rather than
 * measured: the writer is streamed, so a record is painted and written a block
 * of rows at a time and neither the painted rows nor the sequence behind them
 * is ever held whole.
 *
 * Three things are genuinely true, and the panel says so rather than deciding
 * for the reader:
 *
 *   - **Measured density is about three bytes of RTF per base**, runs of one
 *     colour having already been joined. A gene is a hundred kilobytes; a
 *     chromosome is several hundred megabytes.
 *   - **A single JavaScript string cannot exceed about 512 MB.** This is why
 *     the file is assembled as a list of pieces and handed to a Blob rather
 *     than joined -- past chromosome 15 or so, joining would simply throw.
 *   - **Word processors give out long before the browser does.** That is the
 *     real limit, and it is theirs, not ours.
 */
export const RTF_BYTES_PER_BASE = 2.9
/** Past this, the panel says what the file will cost before writing it.
 *
 * Measured rather than guessed: forty-seven megabases -- chromosome 21 -- comes
 * out in ten seconds as ninety-six megabytes of valid RTF. Writing is not the
 * problem at any size worth having; what will open the result is. */
export const COLOURED_EXPORT_WARN_BP = 5_000_000

/** A rough size for a coloured export, for warning a reader in advance. */
export function estimateColouredBytes(bases) {
    return Math.max(0, Math.round((Number(bases) || 0) * RTF_BYTES_PER_BASE))
}

/** A file size a reader can weigh a wait against. */
export function formatBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0)
    if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`
    if (size >= 1e6) return `${Math.round(size / 1e6)} MB`
    if (size >= 1e3) return `${Math.round(size / 1e3)} kB`
    return `${size} bytes`
}

/** How many rows are painted, written and thrown away at a time.
 *
 * Two thousand rows is 120 kb of sequence and a few hundred kilobytes of
 * output: small enough that memory stays flat over a chromosome, large enough
 * that the per-block overhead disappears. */
export const EXPORT_ROW_BLOCK = 2000

export const EXPORT_FORMATS = Object.freeze([
    {
        id: 'rtf',
        label: 'Rich text (.rtf)',
        extension: 'rtf',
        mime: 'application/rtf',
        coloured: true,
        hint: 'Colours, for Word or Pages.',
    },
    {
        id: 'html',
        label: 'Web page (.html)',
        extension: 'html',
        mime: 'text/html',
        coloured: true,
        hint: 'Colours, for a browser or a document.',
    },
    {
        id: 'fasta',
        label: 'FASTA (.fa)',
        extension: 'fa',
        mime: 'text/plain',
        coloured: false,
        hint: 'Bases, sixty to a line. No size limit.',
    },
    {
        id: 'text',
        label: 'Plain text (.txt)',
        extension: 'txt',
        mime: 'text/plain',
        coloured: false,
        hint: 'Bases only, no header.',
    },
])

export const EXPORT_FORMAT_IDS = Object.freeze(EXPORT_FORMATS.map((item) => item.id))

export function exportFormat(id) {
    return EXPORT_FORMATS.find((item) => item.id === id) || EXPORT_FORMATS[0]
}

export function formatIsColoured(id) {
    return Boolean(exportFormat(id).coloured)
}

const LEVEL_LABEL = {
    [LEVEL_LOCATION]: 'Location',
    [LEVEL_GENE]: 'Gene',
    [LEVEL_TRANSCRIPT]: 'Transcript',
    [LEVEL_FEATURE]: 'Feature',
    [LEVEL_CUSTOM]: 'Selection',
}

function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** A window for a level that is not necessarily the one in focus. */
function windowForLevel(focus, level, flanks) {
    if (!levelIsSet(focus, level)) return null
    if (level === LEVEL_CUSTOM) {
        const start = num(focus.custom?.start)
        const end = num(focus.custom?.end)
        if (start === null || end === null) return null
        return { start: Math.min(start, end), end: Math.max(start, end) }
    }
    // `focusWindow` reads `focus[level]` and the flank stored against that
    // level, so asking it about a level the reader is not on is exactly the
    // question it already answers -- it only ever looked at `focus.level`
    // because that was all anyone had asked it for.
    //
    // An exon arrives from the feature list spelt `s`/`e` and from the focus
    // reducer's own tests spelt `start`/`end`. Both are in the wild, so the
    // target is normalised here rather than being read one way and silently
    // coming out as NaN the other.
    const target = focus[level]
    if (!target) return null
    const start = num(target.start ?? target.s)
    const end = num(target.end ?? target.e)
    if (start === null || end === null) return null
    return focusWindow({ ...focus, level, [level]: { ...target, start, end } }, flanks)
}

function levelName(focus, level) {
    if (level === LEVEL_GENE) return focus.gene?.name || focus.gene?.id || ''
    if (level === LEVEL_TRANSCRIPT) return focus.transcript?.id || ''
    if (level === LEVEL_FEATURE) {
        const feature = focus.feature
        return feature ? `${feature.kind || 'feature'} ${feature.index ?? ''}`.trim() : ''
    }
    return ''
}

/** One downloadable stretch: a record, or a level of the focus. */
function levelEntry(focus, level) {
    // Bare, with no flank on it. The flank is a control in the panel now, so
    // baking one in here would be a number the reader could not see or change.
    const window = windowForLevel(focus, level, ZERO_FLANKS)
    if (!window || !focus.chrom) return null
    return {
        key: `level:${level}`,
        label: levelName(focus, level) || LEVEL_LABEL[level],
        detail: level === LEVEL_CUSTOM ? 'Dragged on the sequence' : LEVEL_LABEL[level],
        // A selection is a stretch of chromosome with nothing describing it, so
        // it is drawn -- and exported -- in the location's vocabulary.
        level: level === LEVEL_CUSTOM ? LEVEL_LOCATION : level,
        chrom: focus.chrom,
        start: window.start,
        end: window.end,
        strand: strandOf(focus, level),
        flankable: FLANK_LEVELS.includes(level),
        geneId: level === LEVEL_GENE ? (focus.gene?.id || '') : '',
        transcriptId: (level === LEVEL_TRANSCRIPT || level === LEVEL_FEATURE)
            ? (focus.transcript?.id || '')
            : '',
    }
}

/** No flank at all, for the bare extent of a thing. */
const ZERO_FLANKS = Object.freeze(Object.fromEntries(
    Object.keys(DEFAULT_FLANKS).map((level) => [level, Object.freeze({ five: 0, three: 0 })]),
))

function entryBases(entry) {
    return Math.max(0, (num(entry?.end) ?? 0) - (num(entry?.start) ?? 0) + 1)
}

/**
 * How much sequence a target comes to.
 *
 * Off its entries' coordinates, because a stretch of chromosome is its
 * coordinates. A spliced reading has none -- it is a transcript's own sequence,
 * whose length is a fact about the transcript rather than about a span -- so it
 * carries the count itself and that is taken instead.
 */
export function targetBases(target) {
    if (target?.kind === 'reading') return Math.max(0, Number(target.bases) || 0)
    return (target?.entries || []).reduce((total, entry) => total + entryBases(entry), 0)
}

/**
 * The readings a transcript has, as things to download.
 *
 * A transcript's own sequence is not a stretch of chromosome, and the level
 * targets below are all stretches of chromosome: downloading "Transcript"
 * there gives the genomic span, introns and all, which is the right answer to
 * a different question. A reader looking at a spliced reading and pressing
 * download means *that*, so the panel offers it by name.
 *
 * `readings` is which of the three exist, which the bar already knows, and
 * `answers` is what has come back for them -- which gives the panel a length
 * to print beside each. A reading not yet fetched has none, and prints none:
 * a nought would say the transcript has no sequence.
 */
export function readingTargets({ focus = null, readings = [], answers = {} } = {}) {
    const transcript = focus?.transcript
    if (!transcript?.id || !Array.isArray(readings) || !readings.length) return []
    return readings.map((kind) => {
        const answer = answers?.[kind]
        const length = answer?.status === 'ok' ? Number(answer.length) || 0 : 0
        return {
        id: `reading:${kind}`,
        kind: 'reading',
        reading: kind,
        label: READING_LABEL[kind] || kind,
        detail: transcript.id,
        fileStem: `${transcript.id}_${kind}`,
        level: LEVEL_TRANSCRIPT,
        // What the file will hold, and in what: a protein is counted in
        // residues, and calling them bases would be a different molecule.
        bases: length,
        unit: kind === 'protein' ? 'aa' : 'bp',
        // A spliced sequence has no flanks: there is no sequence either side of
        // it in its own coordinates, and adding genomic flank to it would be
        // gluing a stretch of chromosome onto something that is not one.
        flankable: false,
        transcriptId: transcript.id,
        entries: [{
            key: `reading:${kind}`,
            label: transcript.id,
            named: true,
            detail: READING_DETAIL[kind] || kind,
            level: LEVEL_TRANSCRIPT,
            reading: kind,
            transcriptId: transcript.id,
            chrom: focus.chrom,
            strand: transcript.strand || '+',
        }],
        }
    })
}

/**
 * What each reading is called in the panel, and in a file.
 *
 * Two names for the transcript, because the panel has to tell it from the
 * transcript's *stretch of chromosome* listed beside it and a file does not:
 * inside `>ENST1 Transcript sequence` there is nothing to confuse it with.
 */
const READING_LABEL = {
    transcript: 'Transcript (sequence)',
    cds: 'CDS',
    protein: 'Protein',
}

const READING_DETAIL = {
    transcript: 'Transcript sequence',
    cds: 'CDS',
    protein: 'Protein',
}

/**
 * The two lists as one, in the order a reader goes down them.
 *
 * The readings belong *with* the transcript rather than above everything:
 * location, gene, the transcript's stretch of chromosome, and then that
 * transcript read three ways. They were first, which put a protein above the
 * location it is in and broke the ladder the drawer stacks the focus in.
 *
 * Where both are listed the transcript appears twice -- its span with the
 * introns in it, and its own spliced sequence -- and neither is simply "the
 * transcript", so both say which they are. Only where both are listed: with no
 * readings to tell it from, `Transcript` is the whole of what it is.
 */
export function orderTargets(levels = [], readings = []) {
    if (!readings.length) return levels
    const at = levels.findIndex((target) => target.id === `level:${LEVEL_TRANSCRIPT}`)
    // No transcript level to sit under -- which the focus should not allow,
    // since both are built from the same transcript -- so they go last rather
    // than jumping the ladder.
    if (at < 0) return [...levels, ...readings]
    return [
        ...levels.slice(0, at),
        { ...levels[at], label: 'Transcript (genomic)' },
        ...readings,
        ...levels.slice(at + 1),
    ]
}

/**
 * Everything else the reader could download from where they are standing.
 *
 * The ticked records first when there are any -- in record mode that is almost
 * always what is meant -- and then the focus chain from the top down, in the
 * order the drawer stacks it, so the panel reads as the same ladder.
 */
export function exportTargets({ focus = null, records = [] } = {}) {
    if (!focus?.chrom) return []
    const out = []
    const ticked = Array.isArray(records) ? records.filter(Boolean) : []
    if (ticked.length) {
        out.push({
            id: 'records',
            kind: 'records',
            label: ticked.length === 1 ? ticked[0].label : `${ticked.length} selected records`,
            detail: ticked.length === 1
                ? (ticked[0].detail || LEVEL_LABEL[ticked[0].level] || '')
                : 'In the order they were selected',
            // What the file is called by default. Not the label: how many were
            // selected is worth saying in the panel, where the reader is
            // choosing, and not worth carrying in a file name afterwards.
            fileStem: ticked.length === 1 ? ticked[0].label : 'selected records',
            level: ticked[0].level,
            flankable: FLANK_LEVELS.includes(ticked[0].level),
            entries: ticked.map((record) => ({
                key: record.key,
                label: record.label,
                // A FASTA header's `genome:` field names what the sequence came
                // from. A ticked record is a named thing and says its own name
                // there, as it always has; a level of the focus is a window on
                // the assembly, so the assembly is what belongs in it.
                named: true,
                detail: record.detail || '',
                level: record.level,
                chrom: record.chrom,
                start: record.start,
                end: record.end,
                strand: record.strand || '+',
                flankable: FLANK_LEVELS.includes(record.level),
                geneId: record.geneId || '',
                transcriptId: record.transcriptId || '',
            })),
        })
    }
    for (const level of [...FOCUS_CHAIN, LEVEL_CUSTOM]) {
        const entry = levelEntry(focus, level)
        if (!entry) continue
        out.push({
            id: `level:${level}`,
            kind: 'level',
            label: LEVEL_LABEL[level],
            detail: levelName(focus, level),
            level: entry.level,
            flankable: Boolean(entry.flankable),
            entries: [entry],
        })
    }
    return out.map((target) => ({ ...target, bases: targetBases(target) }))
}

/**
 * The same target with a flank on each of its records.
 *
 * Applied here rather than when the targets are built, so the panel can offer
 * it and the count beside the button can answer for it. 5' and 3' become low
 * and high according to each record's own strand, which is what makes one
 * setting mean the same thing for a gene on either strand.
 */
export function withFlank(target, pair) {
    const flank = flankPair(pair, { five: 0, three: 0 })
    if (!target || !target.flankable || (!flank.five && !flank.three)) return target
    const entries = target.entries.map((entry) => {
        const sides = flankSides(flank, entry.strand)
        return {
            ...entry,
            start: Math.max(1, entry.start - sides.low),
            end: entry.end + sides.high,
            flank,
        }
    })
    return { ...target, entries, bases: entries.reduce((total, entry) => total + entryBases(entry), 0) }
}

/** The flank a level is read with by default, for seeding the panel. */
export function defaultFlankFor(level, flanks = DEFAULT_FLANKS) {
    return flankPair(flanks?.[level], DEFAULT_FLANKS[level] || { five: 0, three: 0 })
}

/**
 * What has to be asked of the backend before an entry can be written.
 *
 * The same questions `useRecordViews` asks of a record, widened to cover a
 * location -- which no record can be, but the chain can. Written as a list of
 * requests rather than performed here so the module stays pure and the runner
 * can queue, count and report them.
 */
export function entryRequests(entry, { collapse = DEFAULT_COLLAPSE, hide = '', shape = SHAPE_SHOWN } = {}) {
    if (!entry?.chrom) return []
    const level = entry.level
    const classes = { genome: entry.genome || '', chrom: entry.chrom, level }
    if (level === LEVEL_LOCATION) {
        classes.start = entry.start
        classes.end = entry.end
        if (hide) classes.hide = hide
    } else if (level === LEVEL_GENE) {
        if (!entry.geneId) return []
        classes.gene_id = entry.geneId
        classes.flank = 0
        // A gene is described by every isoform at once, so silencing one changes
        // the answer. A transcript or a single exon has only itself to go on.
        if (hide) classes.hide = hide
    } else {
        if (!entry.transcriptId) return []
        classes.transcript_id = entry.transcriptId
        classes.flank = 0
        if (level === LEVEL_FEATURE) {
            classes.start = entry.start
            classes.end = entry.end
        }
    }
    // A location is asked about a tile at a time, exactly as the view asks.
    // Not for the weight of one request: past a hundred genes the backend
    // answers a window in a coarse genic/intergenic vocabulary instead of the
    // real classes, so a five-megabase region asked for in one go came back as
    // one blue-grey block -- while the same region on screen, asked in tiles,
    // is coding, UTR, intron and the rest. The export looked nothing like the
    // view for exactly as long as it asked differently.
    const out = level === LEVEL_LOCATION
        ? annotationTiles(entry.start, entry.end).map((tile) => ({
            kind: 'classes',
            path: '/classes',
            params: { ...classes, start: tile.start, end: tile.end },
        }))
        : [{ kind: 'classes', path: '/classes', params: classes }]
    // Only "as shown" can collapse, and only then is the shape of the record
    // worth asking about.
    if (shape === SHAPE_SHOWN && anyCollapseOn(collapse)) {
        out.push({
            kind: 'spans',
            path: '/spans',
            params: {
                genome: entry.genome || '',
                chrom: entry.chrom,
                start: entry.start,
                end: entry.end,
                level,
                ...(entry.geneId ? { gene_id: entry.geneId } : {}),
                ...(entry.transcriptId ? { transcript_id: entry.transcriptId } : {}),
            },
        })
    }
    return out
}

/**
 * Several tiles' worth of annotation as one answer.
 *
 * Sorted by coordinate and otherwise left alone, which is what the view does
 * with the same lists: the runs within a tile are already non-overlapping and
 * ascending, and tiles do not overlap each other.
 */
export function mergeClassAnswers(answers) {
    const list = (answers || []).filter(Boolean)
    if (!list.length) return { runs: [], cdsFrame: [], overlaps: [], strand: '+', detail: '' }
    const runs = list.flatMap((answer) => answer.runs || []).sort((a, b) => a.s - b.s)
    const overlaps = list.flatMap((answer) => answer.overlaps || []).sort((a, b) => a.s - b.s)
    return {
        runs,
        overlaps,
        cdsFrame: list[0].cdsFrame || [],
        strand: list[0].strand || '+',
        // "plain" when any tile fell back, since that is the part a reader
        // would otherwise misread -- the same rule the view follows.
        detail: list.some((answer) => answer.detail === 'plain') ? 'plain' : (list[0].detail || ''),
    }
}

export function anyCollapseOn(collapse) {
    return Object.values(collapse || {}).some((choice) => choice?.on)
}

/** The reader's collapse choices, less whatever this stretch cannot answer. */
function settledCollapse(collapse, offers) {
    const out = {}
    for (const [kind, choice] of Object.entries(collapse || DEFAULT_COLLAPSE)) {
        out[kind] = { ...choice, on: Boolean(choice?.on) && (offers || []).includes(kind) }
    }
    return out
}

/**
 * How an entry is laid out for export.
 *
 * `shape` is the whole of the difference between the two options the panel
 * offers: as shown is the view's own layout -- collapsed where the reader has
 * collapsed it, read the way they are reading it -- and full span is the plain
 * one, forward, with nothing left out.
 */
export function entryLayout({
    entry,
    spans = null,
    collapse = DEFAULT_COLLAPSE,
    flip = false,
    shape = SHAPE_SHOWN,
    orientation = ORIENTATION_VIEW,
    strand = '',
} = {}) {
    if (!entry) return null
    // Which way it reads is the reader's, whichever shape they asked for. The
    // two used to be tangled -- the whole span was always written forward -- so
    // a complete gene could not be had the way it is actually read.
    const reverse = readsReverse(entry, { orientation, flip, strand })
    if (shape !== SHAPE_SHOWN) {
        return buildDisplayLayout({
            region: { start: entry.start, end: entry.end },
            collapse: false,
            reverse,
        })
    }
    const settled = settledCollapse(collapse, spans?.offers || [])
    const plan = spans
        ? collapseKeeps({
            region: { start: entry.start, end: entry.end },
            genic: spans.genic || [],
            exonic: spans.exonic || [],
            settings: settled,
        })
        : null
    const collapsed = Boolean(plan && plan.collapses.length)
    return buildDisplayLayout({
        region: { start: entry.start, end: entry.end },
        keep: collapsed ? plan.keep : [],
        flank: 0,
        collapse: collapsed,
        reverse,
    })
}

/**
 * A reader over downloaded sequence, in the shape the scroll buffer publishes.
 *
 * Chunks on the same absolute 12 kb grid the view fetches on, so
 * `assembleRowSequence` and the protein's `readBaseAt` work against an export
 * exactly as they do against the screen, and neither had to learn a second way
 * of finding a base.
 */
export function sequenceStore(chunkBp = SEQUENCE_VIEW_CHUNK_BP) {
    const chunks = new Map()
    const masked = []
    return {
        /**
         * One read, sliced onto the grid.
         *
         * A read is whatever size was worth asking for -- eight chunks at a
         * time, rather than eighty-four separate requests for a megabase -- and
         * it is cut up here so that everything downstream still sees the 12 kb
         * grid it expects.
         */
        put({ start, sequence = '', masked: spans = [] } = {}) {
            const from = num(start)
            if (from === null || !sequence) return
            let cursor = from
            while (cursor <= from + sequence.length - 1) {
                const index = chunkIndexForCoord(cursor, chunkBp)
                const range = chunkRange(index, chunkBp)
                const stop = Math.min(from + sequence.length - 1, range.end)
                const piece = sequence.slice(cursor - from, stop - from + 1)
                const held = chunks.get(index)
                    || PLACEHOLDER_BASE.repeat(range.end - range.start + 1)
                chunks.set(
                    index,
                    held.slice(0, cursor - range.start) + piece + held.slice(stop - range.start + 1),
                )
                cursor = stop + 1
            }
            for (const span of spans || []) masked.push(span)
        },
        readSequence: (index) => chunks.get(index) || null,
        maskedForRow(row) {
            if (!row || !masked.length) return []
            return masked.filter((span) => span.e >= row.start && span.s <= row.end)
        },
    }
}

/** The chunks an export has to have before it can write a layout. */
/**
 * The reads an export has to make before it can write a layout.
 *
 * Adjacent chunks are asked for together, up to `perRead`, because a megabase
 * is eighty-four chunks and eighty-four round trips through the one annotation
 * worker is most of the wait. The grid is still the view's, so what comes back
 * slices onto it exactly; only the number of questions changes.
 *
 * A collapsed layout's kept stretches can be far apart, which is why this walks
 * the layout's own items rather than the span between its ends.
 */
export function readsForLayout(layout, { chunkBp = SEQUENCE_VIEW_CHUNK_BP, perRead = 8 } = {}) {
    const wanted = new Set()
    for (const item of layout?.items || []) {
        if (item.kind !== 'seq') continue
        const first = chunkIndexForCoord(item.s, chunkBp)
        const last = chunkIndexForCoord(item.e, chunkBp)
        for (let index = first; index <= last; index += 1) wanted.add(index)
    }
    return groupChunks([...wanted].sort((a, b) => a - b), chunkBp, perRead)
}

/** Consecutive chunk indices gathered into the reads that fetch them. */
function groupChunks(indices, chunkBp, perRead) {
    const out = []
    let run = null
    for (const index of indices) {
        if (run && index === run.last + 1 && run.count < perRead) {
            run.last = index
            run.count += 1
            continue
        }
        if (run) out.push(run)
        run = { first: index, last: index, count: 1 }
    }
    if (run) out.push(run)
    return out.map(({ first, last }) => ({
        start: chunkRange(first, chunkBp).start,
        end: chunkRange(last, chunkBp).end,
    }))
}

/**
 * One entry as rows, with every cell's appearance settled.
 *
 * Format-independent on purpose: RTF and HTML differ in how they say "this
 * letter, on this background" and in nothing else, so the decision about what
 * colour a base is happens once, here, and neither writer repeats it.
 */
export function paintRows({
    layout,
    from = 0,
    count = 0,
    store,
    runs = [],
    cdsFrame = [],
    strand = '+',
    allowed = null,
    overlaps = [],
    palette = DEFAULT_PALETTE,
    protein = false,
    gutters = true,
    plainInk = '#334155',
    gapInk = '#94a3b8',
} = {}) {
    if (!layout) return []
    const rows = []
    const translating = Boolean(protein) && Array.isArray(cdsFrame) && cdsFrame.length > 0
    const last = Math.min(layout.totalRows, from + count)
    for (let index = from; index < last; index += 1) {
        const line = displayRow(layout, index)
        if (!line) continue
        const painted = paintDisplayRow(line, {
            readSequence: store.readSequence,
            maskedFor: store.maskedForRow,
            runs,
            cdsFrame,
            strand,
            allowed,
            // Where more than one gene covers the sequence. A rule under the
            // bases rather than a colour over them, because a base two genes
            // share is still coding or still intronic -- so it travels in the
            // marks channel and is drawn on top of whatever the base wears.
            overlaps,
            protein: translating,
            reverse: Boolean(layout.reverse),
            width: layout.width,
        })
        const cells = []
        for (let i = 0; i < painted.sequence.length; i += 1) {
            const code = painted.classes[i] || CLASS_NONE
            const marks = painted.edges ? (parseInt(painted.edges[i], 32) || 0) : 0
            const gap = code === CLASS_GAP
            const style = code === CLASS_NONE || gap ? null : palette.style(code)
            const outline = Boolean(style?.outline)
            const character = painted.sequence[i] || ' '
            cells.push({
                // A marker cell stands for sequence that is not on screen. It
                // is a note about what is missing, so it is written as the
                // dashes and the count it draws rather than as a coloured base.
                ch: gap && character === '-' ? '-' : character,
                gap,
                pending: character === PLACEHOLDER_BASE,
                // Outlined classes have no fill on screen either: the outline
                // says "sequence of this kind, not the feature itself", and a
                // file that filled them would be saying something else.
                bg: style && !outline ? style.bg : null,
                outline: outline ? style.bg : null,
                underline: (marks & EDGE_OVERLAP) && !gap ? palette.overlap : null,
                fg: gap ? gapInk : (style && !outline ? textOnColour(style.bg) : plainInk),
            })
        }
        rows.push({
            index,
            left: gutters ? line.firstCoord : null,
            right: gutters ? line.lastCoord : null,
            amino: translating ? painted.amino : '',
            cells,
        })
    }
    return rows
}

/**
 * The same rows, for a transcript read in its own coordinates.
 *
 * A spliced reading is not a stretch of chromosome, so none of the machinery
 * above applies to it: there is no layout to lay out, no coordinates to read
 * sequence at, and no collapse to plan. The sequence arrives whole from
 * `/transcript-sequence`, and what is left is the same handful of strings every
 * row is made of -- which is exactly what the writers already take, so a
 * spliced reading writes to RTF and HTML through the same path a region does.
 *
 * `runs` is `splicedRunsFor`'s answer, the same list the surface colours with,
 * so a downloaded file and the screen cannot disagree about what a base is.
 */
export function splicedExportRows({
    sequence = '',
    runs = [],
    cds = null,
    palette = DEFAULT_PALETTE,
    protein = false,
    gutters = true,
    plainInk = '#334155',
} = {}) {
    const text = String(sequence || '')
    const translating = Boolean(protein) && Boolean(cds)
    return splicedRows(text.length).map((row) => {
        const codes = rowClasses(row, runs)
        const amino = translating ? aminoRow(row, text, cds) : ''
        const cells = []
        for (let i = 0; i < row.length; i += 1) {
            const code = codes[i] || CLASS_NONE
            const style = code === CLASS_NONE ? null : palette.style(code)
            const outline = Boolean(style?.outline)
            cells.push({
                ch: text[row.col0 + i] || ' ',
                gap: false,
                pending: false,
                // Outlined classes have no fill on screen either: the outline
                // says "sequence of this kind, not the feature itself", and a
                // file that filled them would be saying something else.
                bg: style && !outline ? style.bg : null,
                outline: outline ? style.bg : null,
                underline: null,
                fg: style && !outline ? textOnColour(style.bg) : plainInk,
            })
        }
        return {
            index: row.index,
            left: gutters ? row.first : null,
            right: gutters ? row.last : null,
            amino,
            cells,
        }
    })
}

/** Everything a record's heading says, which is known before a row is painted. */
export function documentMeta(entry, layout, strand = '+') {
    return {
        key: entry.key,
        label: entry.label,
        detail: entry.detail || '',
        chrom: entry.chrom,
        start: entry.start,
        end: entry.end,
        strand,
        reverse: Boolean(layout?.reverse),
        collapsed: Boolean(layout?.collapsed && layout?.hidden),
        hidden: layout?.hidden || 0,
        kept: layout?.kept || 0,
        rows: layout?.totalRows || 0,
    }
}

/**
 * A whole record in one go: its heading and every row.
 *
 * The streaming path does not use this -- it paints a block at a time and
 * throws each away -- but a small export, and every test, is clearer for
 * having it.
 */
export function entryDocument(options = {}) {
    const { entry, layout } = options
    if (!layout) return null
    return {
        ...documentMeta(entry, layout, options.strand || '+'),
        rows: paintRows({ ...options, from: 0, count: layout.totalRows }),
    }
}

/** The genomic stretches a block of rows draws, for fetching just those. */
export function intervalsForRows(layout, from, count) {
    const rows = []
    const last = Math.min(layout?.totalRows || 0, from + count)
    for (let index = from; index < last; index += 1) {
        const line = displayRow(layout, index)
        if (line) rows.push(line)
    }
    return coordIntervalsForRows(rows)
}

/** The reads a set of intervals needs, on the view's own chunk grid. */
export function readsForIntervals(intervals, { chunkBp = SEQUENCE_VIEW_CHUNK_BP, perRead = 8 } = {}) {
    const wanted = new Set()
    for (const interval of intervals || []) {
        const first = chunkIndexForCoord(Math.min(interval.s, interval.e), chunkBp)
        const last = chunkIndexForCoord(Math.max(interval.s, interval.e), chunkBp)
        for (let index = first; index <= last; index += 1) wanted.add(index)
    }
    return groupChunks([...wanted].sort((a, b) => a - b), chunkBp, perRead)
}

/**
 * Every colour a coloured export could possibly use, in a fixed order.
 *
 * RTF writes its colour table in the header, before a single base -- so a
 * streamed export cannot wait to see which colours turned up. Enumerated from
 * the palette instead, which is a couple of dozen entries and costs nothing to
 * declare in full.
 */
export function paletteColours(palette = DEFAULT_PALETTE, { plainInk = '#334155', gapInk = '#94a3b8' } = {}) {
    const out = [plainInk, gapInk]
    for (const code of Object.values(CLASS_CODES)) {
        const style = palette.style(code)
        if (!style?.bg) continue
        out.push(style.bg)
        if (!style.outline) out.push(textOnColour(style.bg))
    }
    return [...new Set(out)]
}

/** Every base of a document, in reading order, with the markers left out. */
export function documentBases(document_) {
    let out = ''
    for (const row of document_?.rows || []) {
        for (const cell of row.cells) {
            if (!cell.gap) out += cell.ch
        }
    }
    return out
}

/**
 * The line a FASTA record is headed by, in the backend's own wording.
 *
 * Written by `fastaHeaderLine`, which the FASTA display on screen writes its own
 * header with: a reader who copies a region off the screen and downloads the
 * same region should not be handed two different names for one thing.
 */
export function documentHeader(document_) {
    return fastaHeaderLine({
        name: document_.label || document_.chrom,
        chrom: document_.chrom,
        start: document_.start,
        end: document_.end,
        strand: document_.strand,
        hidden: document_.collapsed ? document_.hidden : 0,
    })
}

export function fastaText(documents, width = BASES_PER_ROW) {
    const parts = []
    for (const document_ of documents || []) {
        const bases = documentBases(document_)
        const lines = []
        for (let at = 0; at < bases.length; at += width) lines.push(bases.slice(at, at + width))
        parts.push(`${documentHeader(document_)}\n${lines.join('\n')}\n`)
    }
    return parts.join('')
}

export function plainText(documents, width = BASES_PER_ROW) {
    const parts = []
    for (const document_ of documents || []) {
        const bases = documentBases(document_)
        const lines = []
        for (let at = 0; at < bases.length; at += width) lines.push(bases.slice(at, at + width))
        parts.push(`${lines.join('\n')}\n`)
    }
    return parts.join('')
}

/** Whether a document draws a protein lane anywhere, for the writers. */
export function documentHasProtein(document_) {
    return (document_?.rows || []).some((row) => row.amino && row.amino.trim() !== '')
}

export { NO_AMINO }

const SAFE = /[^A-Za-z0-9._-]+/g

/**
 * A name safe to write to a disk, from whatever the reader typed or we chose.
 *
 * Leading dots go as well as the obviously unsafe characters: a path typed into
 * the box -- `../../somewhere` -- otherwise survives as `.._.._somewhere`,
 * which is not dangerous but is not a name anybody meant either.
 */
export function safeFileStem(text, fallback = 'sequence') {
    return String(text ?? '')
        .replace(SAFE, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '')
        || fallback
}

/** What the file is called by default: what was downloaded. */
export function exportFileName({ target = null, format = 'fasta', chrom = '' } = {}) {
    const extension = exportFormat(format).extension
    const stem = target?.fileStem
        || target?.entries?.[0]?.label
        || target?.label
        || chrom
        || 'sequence'
    return `${safeFileStem(stem)}.${extension}`
}

/**
 * A name the reader typed, made safe and given the right extension.
 *
 * The extension is the format's, always: a reader who clears the box or types
 * `notes.txt` over an RTF would otherwise end up with a file nothing opens.
 */
export function resolveFileName(typed, format, fallback = 'sequence') {
    const extension = exportFormat(format).extension
    const trimmed = String(typed ?? '').trim()
    const withoutExtension = trimmed.replace(new RegExp(`\\.${extension}$`, 'i'), '')
    return `${safeFileStem(withoutExtension, safeFileStem(fallback))}.${extension}`
}
