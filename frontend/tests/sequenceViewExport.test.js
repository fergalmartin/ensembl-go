import test from 'node:test'
import assert from 'node:assert/strict'

import {
    COLOURED_EXPORT_WARN_BP,
    EXPORT_ROW_BLOCK,
    EXPORT_FORMATS,
    ORIENTATION_FORWARD,
    ORIENTATION_REVERSE,
    ORIENTATION_VIEW,
    SHAPE_FULL,
    SHAPE_SHOWN,
    defaultFlankFor,
    documentBases,
    documentHeader,
    entryDocument,
    entryLayout,
    entryRequests,
    exportFileName,
    exportFormat,
    exportTargets,
    estimateColouredBytes,
    fastaText,
    formatBytes,
    formatIsColoured,
    intervalsForRows,
    mergeClassAnswers,
    paintRows,
    paletteColours,
    orderTargets,
    plainText,
    readingTargets,
    readsForIntervals,
    readsForLayout,
    readsReverse,
    resolveFileName,
    sequenceStore,
    targetBases,
    withFlank,
} from '../src/utils/sequenceViewExport.js'
import { DEFAULT_PALETTE } from '../src/utils/sequenceViewColours.js'
import { CLASS_CODES } from '../src/utils/sequenceViewPalette.js'
import { ANNOTATION_TILE_BP, EDGE_OVERLAP } from '../src/utils/sequenceViewClasses.js'
import { SEQUENCE_VIEW_CHUNK_BP } from '../src/utils/sequenceViewChunks.js'

const focus = {
    genomeKey: 'human',
    chrom: '1',
    level: 'transcript',
    location: { start: 1000, end: 4000 },
    gene: { id: 'ENSG1', name: 'ACE2', start: 1500, end: 3000, strand: '+' },
    transcript: { id: 'ENST1', start: 1600, end: 2800, strand: '+' },
    feature: { kind: 'exon', index: 2, s: 1700, e: 1800, strand: '+' },
    custom: null,
}
test('the panel is offered every level of the chain that is actually set', () => {
    const targets = exportTargets({ focus, records: [] })
    assert.deepEqual(targets.map((item) => item.id), [
        'level:location', 'level:gene', 'level:transcript', 'level:feature',
    ])
    assert.deepEqual(targets.map((item) => item.label), ['Location', 'Gene', 'Transcript', 'Feature'])
    // The exon in focus is downloadable on its own, which is the bottom of the
    // ladder the panel exists to offer.
    const exon = targets.at(-1)
    assert.equal(exon.entries[0].start, 1700)
    assert.equal(exon.entries[0].end, 1800)
    assert.equal(exon.entries[0].transcriptId, 'ENST1')
})

test('levels that are not set are not offered', () => {
    const bare = { genomeKey: 'human', chrom: '1', level: 'location', location: { start: 1, end: 500 } }
    const targets = exportTargets({ focus: bare, records: [] })
    assert.deepEqual(targets.map((item) => item.id), ['level:location'])
})

test('a level is offered bare, with the flank left to the panel', () => {
    const [, gene] = exportTargets({ focus, records: [] })
    assert.equal(gene.entries[0].start, 1500)
    assert.equal(gene.entries[0].end, 3000)
    // A gene, a transcript and an exon can be extended; a location is a window
    // the reader already drew, and a selection likewise.
    const byId = Object.fromEntries(exportTargets({ focus, records: [] }).map((t) => [t.id, t]))
    assert.equal(byId['level:gene'].flankable, true)
    assert.equal(byId['level:transcript'].flankable, true)
    assert.equal(byId['level:feature'].flankable, true)
    assert.equal(byId['level:location'].flankable, false)
})

test("a flank goes on the 5' and 3' ends, which depend on the strand", () => {
    const [, gene] = exportTargets({ focus, records: [] })
    const plus = withFlank(gene, { five: 100, three: 50 })
    assert.equal(plus.entries[0].start, 1400)
    assert.equal(plus.entries[0].end, 3050)
    assert.equal(plus.bases, 1501 + 150)

    // The same setting on a minus-strand gene extends the other way round: 5'
    // is the high coordinate there, which is what makes one number mean the
    // same thing to a reader on either strand.
    const minus = withFlank(
        { ...gene, entries: [{ ...gene.entries[0], strand: '-' }] },
        { five: 100, three: 50 },
    )
    assert.equal(minus.entries[0].start, 1450)
    assert.equal(minus.entries[0].end, 3100)
})

test('a flank never reaches before the first base, and no flank changes nothing', () => {
    const target = {
        flankable: true,
        entries: [{ key: 'a', level: 'gene', chrom: '1', start: 20, end: 100, strand: '+' }],
    }
    assert.equal(withFlank(target, { five: 500, three: 0 }).entries[0].start, 1)
    assert.equal(withFlank(target, { five: 0, three: 0 }), target)
    // A location cannot be extended however much is asked of it.
    assert.equal(withFlank({ ...target, flankable: false }, { five: 100, three: 100 }).entries[0].start, 20)
})

test('the flank offered is the one the reader reads that level with', () => {
    const flanks = { gene: { five: 100, three: 50 }, transcript: { five: 5, three: 5 } }
    assert.deepEqual(defaultFlankFor('gene', flanks), { five: 100, three: 50 })
    assert.deepEqual(defaultFlankFor('transcript', flanks), { five: 5, three: 5 })
    // A level they have not set falls back to what the app ships.
    assert.deepEqual(defaultFlankFor('feature', flanks), { five: 10, three: 10 })
    assert.deepEqual(defaultFlankFor('location', flanks), { five: 0, three: 0 })
})

test('which way a record is read is asked for, not implied by its shape', () => {
    const gene = { key: 'g', level: 'gene', chrom: '1', start: 1, end: 100, strand: '-' }
    const location = { key: 'l', level: 'location', chrom: '1', start: 1, end: 100, strand: '+' }
    // Left alone, a minus-strand gene reads from its far end and a location
    // forward -- which is what the view does.
    assert.equal(readsReverse(gene, {}), true)
    assert.equal(readsReverse(location, {}), false)
    // The reader's own flip, on top, as the view applies it.
    assert.equal(readsReverse(gene, { flip: true }), false)
    // And said outright, which is the answer for records that disagree.
    assert.equal(readsReverse(gene, { orientation: ORIENTATION_FORWARD }), false)
    assert.equal(readsReverse(location, { orientation: ORIENTATION_REVERSE }), true)
    assert.equal(readsReverse(gene, { orientation: ORIENTATION_FORWARD, flip: true }), false)
})

test('the whole span can be read either way round, which it could not before', () => {
    const minus = { ...entry, strand: '-' }
    // It used to be forced forward, so a complete gene could not be had the way
    // it is actually read.
    assert.equal(entryLayout({ entry: minus, shape: SHAPE_FULL, orientation: ORIENTATION_VIEW, strand: '-' }).reverse, true)
    assert.equal(entryLayout({ entry: minus, shape: SHAPE_FULL, orientation: ORIENTATION_FORWARD }).reverse, false)
    assert.equal(entryLayout({ entry, shape: SHAPE_FULL, orientation: ORIENTATION_REVERSE }).reverse, true)
    // And the shown shape answers to the same control.
    assert.equal(entryLayout({ entry, shape: SHAPE_SHOWN, orientation: ORIENTATION_REVERSE }).reverse, true)
    assert.equal(entryLayout({ entry: minus, shape: SHAPE_SHOWN, orientation: ORIENTATION_FORWARD, strand: '-' }).reverse, false)
})

test('a dragged selection is offered, and is read in the location vocabulary', () => {
    const targets = exportTargets({
        focus: { ...focus, custom: { start: 2000, end: 2100 } },
        records: [],
    })
    const selection = targets.at(-1)
    assert.equal(selection.id, 'level:custom')
    // Nothing describes an ad-hoc stretch, so it is classed as a location is.
    assert.equal(selection.entries[0].level, 'location')
    assert.equal(selection.bases, 101)
})

test('selected records come first, as one target of several entries', () => {
    const records = [
        { key: 'tx:A', label: 'A', level: 'transcript', chrom: '1', start: 10, end: 19, strand: '+', transcriptId: 'A' },
        { key: 'tx:B', label: 'B', level: 'transcript', chrom: '1', start: 30, end: 49, strand: '-', transcriptId: 'B' },
    ]
    const targets = exportTargets({ focus, records })
    assert.equal(targets[0].id, 'records')
    assert.equal(targets[0].label, '2 selected records')
    // Named for what it is rather than for how many: the count belongs in the
    // panel, where the reader is choosing, not in the file afterwards.
    assert.equal(targets[0].fileStem, 'selected records')
    assert.equal(exportFileName({ target: targets[0], format: 'rtf' }), 'selected_records.rtf')
    assert.equal(targets[0].entries.length, 2)
    assert.equal(targetBases(targets[0]), 10 + 20)
    // The chain is still there underneath: record mode does not take the levels
    // away, it only adds what was selected.
    assert.ok(targets.some((item) => item.id === 'level:gene'))
})

test('one selected record is named after itself rather than counted', () => {
    const records = [{ key: 'gene:G', label: 'ACE2', detail: 'ENSG1', level: 'gene', chrom: '1', start: 5, end: 9, geneId: 'G' }]
    const [first] = exportTargets({ focus, records })
    assert.equal(first.label, 'ACE2')
    assert.equal(first.detail, 'ENSG1')
    assert.equal(exportFileName({ target: first, format: 'fasta' }), 'ACE2.fa')
})

test('a location asks for its own window; a gene asks by identifier', () => {
    const location = entryRequests(
        { chrom: '1', level: 'location', start: 100, end: 200, genome: 'human' },
        { collapse: {}, hide: 'X' },
    )
    assert.equal(location.length, 1)
    assert.deepEqual(location[0].params, {
        genome: 'human', chrom: '1', level: 'location', start: 100, end: 200, hide: 'X',
    })

    const gene = entryRequests(
        { chrom: '1', level: 'gene', start: 100, end: 200, geneId: 'G', genome: 'human' },
        { collapse: {}, hide: 'X' },
    )
    assert.deepEqual(gene[0].params, {
        genome: 'human', chrom: '1', level: 'gene', gene_id: 'G', flank: 0, hide: 'X',
    })
})

test('a transcript is never asked with the hidden set, having only itself to go on', () => {
    const [classes] = entryRequests(
        { chrom: '1', level: 'transcript', start: 1, end: 9, transcriptId: 'T', genome: 'human' },
        { collapse: {}, hide: 'X' },
    )
    assert.equal(classes.params.hide, undefined)
    assert.equal(classes.params.transcript_id, 'T')
})

test('a feature carries its own window as well as its transcript', () => {
    const [classes] = entryRequests(
        { chrom: '1', level: 'feature', start: 40, end: 60, transcriptId: 'T', genome: 'human' },
        { collapse: {} },
    )
    assert.equal(classes.params.start, 40)
    assert.equal(classes.params.end, 60)
    assert.equal(classes.params.transcript_id, 'T')
})

test('the collapse spans are asked for only when something is collapsed and shown', () => {
    const entry = { chrom: '1', level: 'gene', start: 1, end: 9, geneId: 'G', genome: 'human' }
    const on = { intron: { on: true, flank: 10, min: 30 } }
    assert.deepEqual(
        entryRequests(entry, { collapse: on, shape: SHAPE_SHOWN }).map((item) => item.kind),
        ['classes', 'spans'],
    )
    // Nothing is left out of a whole span, so its shape is not worth asking.
    assert.deepEqual(
        entryRequests(entry, { collapse: on, shape: SHAPE_FULL }).map((item) => item.kind),
        ['classes'],
    )
    assert.deepEqual(
        entryRequests(entry, { collapse: { intron: { on: false } }, shape: SHAPE_SHOWN }).map((item) => item.kind),
        ['classes'],
    )
})

test('a location is asked about a tile at a time, as the view asks', () => {
    // Past a hundred genes the backend answers a window in a coarse
    // genic/intergenic vocabulary instead of the real classes. A five-megabase
    // region asked for in one go therefore came back as one blue-grey block,
    // while the same region on screen -- asked in tiles -- is coding, UTR,
    // intron and the rest. The export looked nothing like the view for exactly
    // as long as it asked differently.
    const wide = { chrom: '1', level: 'location', start: 1, end: 5_000_000, genome: 'human' }
    const requests = entryRequests(wide, { collapse: {} })
    assert.equal(requests.length, Math.ceil(5_000_000 / ANNOTATION_TILE_BP))
    assert.ok(requests.every((item) => item.kind === 'classes'))
    // Each tile is small enough to come back in detail, and together they cover
    // the region exactly once, with no gap and no overlap.
    let cursor = 1
    for (const request of requests) {
        assert.ok(request.params.end - request.params.start + 1 <= ANNOTATION_TILE_BP)
        assert.equal(request.params.start, cursor)
        cursor = request.params.end + 1
    }
    assert.equal(cursor - 1, 5_000_000)
})

test('a region inside one tile is still exactly one request', () => {
    const small = { chrom: '1', level: 'location', start: 1000, end: 2000, genome: 'human' }
    const requests = entryRequests(small, { collapse: {} })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].params.start, 1000)
    assert.equal(requests[0].params.end, 2000)
})

test('a gene or a transcript describes itself, so it is never tiled', () => {
    for (const entry of [
        { chrom: '1', level: 'gene', start: 1, end: 5_000_000, geneId: 'G', genome: 'human' },
        { chrom: '1', level: 'transcript', start: 1, end: 5_000_000, transcriptId: 'T', genome: 'human' },
    ]) {
        assert.equal(entryRequests(entry, { collapse: {} }).length, 1)
    }
})

test('several tiles of annotation merge into one answer, in coordinate order', () => {
    const merged = mergeClassAnswers([
        { runs: [{ s: 100, e: 200, c: 'intron' }], overlaps: [{ s: 150, e: 160, n: 2 }], strand: '+', detail: 'genes', cdsFrame: [{ s: 1, e: 9, o: 0 }] },
        { runs: [{ s: 1, e: 99, c: 'coding' }], overlaps: [{ s: 10, e: 20, n: 3 }], strand: '+', detail: 'genes' },
    ])
    assert.deepEqual(merged.runs.map((run) => run.s), [1, 100])
    assert.deepEqual(merged.overlaps.map((run) => run.s), [10, 150])
    assert.equal(merged.detail, 'genes')
    assert.deepEqual(merged.cdsFrame, [{ s: 1, e: 9, o: 0 }])
})

test('one tile falling back to the coarse vocabulary is reported for the whole', () => {
    const merged = mergeClassAnswers([
        { runs: [], detail: 'genes' },
        { runs: [], detail: 'plain' },
    ])
    assert.equal(merged.detail, 'plain')
    assert.deepEqual(mergeClassAnswers([]).runs, [])
    assert.deepEqual(mergeClassAnswers(null).overlaps, [])
})

test('an entry with no identifier cannot be asked about at all', () => {
    assert.deepEqual(entryRequests({ chrom: '1', level: 'gene', start: 1, end: 9 }, {}), [])
    assert.deepEqual(entryRequests({ chrom: '1', level: 'transcript', start: 1, end: 9 }, {}), [])
    assert.deepEqual(entryRequests(null, {}), [])
})

const entry = { key: 'e', label: 'ENST1', level: 'transcript', chrom: '1', start: 1, end: 120, strand: '+' }

test('the whole-span shape is forward and uncollapsed however the view reads', () => {
    const layout = entryLayout({ entry, shape: SHAPE_FULL, flip: true, strand: '-' })
    assert.equal(layout.reverse, false)
    assert.equal(layout.collapsed, false)
    assert.equal(layout.totalCols, 120)
})

test('the shown shape follows the strand, and the reader flips whatever that came to', () => {
    assert.equal(entryLayout({ entry, shape: SHAPE_SHOWN, strand: '-' }).reverse, true)
    assert.equal(entryLayout({ entry, shape: SHAPE_SHOWN, strand: '+' }).reverse, false)
    assert.equal(entryLayout({ entry, shape: SHAPE_SHOWN, strand: '-', flip: true }).reverse, false)
    // A location is a stretch of chromosome, read forward whatever lies on it.
    const location = { ...entry, level: 'location' }
    assert.equal(entryLayout({ entry: location, shape: SHAPE_SHOWN, strand: '-' }).reverse, false)
})

test('reads cover every kept stretch, and gather adjacent chunks into one ask', () => {
    const big = { ...entry, end: SEQUENCE_VIEW_CHUNK_BP * 5 }
    const reads = readsForLayout(entryLayout({ entry: big, shape: SHAPE_FULL }), { perRead: 2 })
    assert.equal(reads.length, 3)
    assert.equal(reads[0].start, 1)
    assert.equal(reads[0].end, SEQUENCE_VIEW_CHUNK_BP * 2)
    assert.equal(reads.at(-1).end >= big.end, true)
})

test('a collapsed layout reads only its kept stretches, not the span between them', () => {
    const far = { ...entry, start: 1, end: SEQUENCE_VIEW_CHUNK_BP * 10 }
    const layout = entryLayout({
        entry: far,
        shape: SHAPE_SHOWN,
        spans: {
            offers: ['intron'],
            genic: [{ s: 1, e: SEQUENCE_VIEW_CHUNK_BP * 10 }],
            exonic: [{ s: 1, e: 100 }, { s: SEQUENCE_VIEW_CHUNK_BP * 9, e: SEQUENCE_VIEW_CHUNK_BP * 9 + 100 }],
        },
        collapse: { intron: { on: true, flank: 0, min: 30 } },
    })
    assert.ok(layout.collapsed)
    const reads = readsForLayout(layout, { perRead: 8 })
    const covered = reads.reduce((total, read) => total + (read.end - read.start + 1), 0)
    assert.ok(covered < SEQUENCE_VIEW_CHUNK_BP * 10)
})

test('a store puts a read onto the view own chunk grid, whatever size it was', () => {
    const store = sequenceStore()
    const span = 'ACGT'.repeat(6000) // 24_000 bases: two whole chunks
    store.put({ start: 1, sequence: span, masked: [{ s: 5, e: 9 }] })
    assert.equal(store.readSequence(0).length, SEQUENCE_VIEW_CHUNK_BP)
    assert.equal(store.readSequence(1).length, SEQUENCE_VIEW_CHUNK_BP)
    assert.equal(store.readSequence(0).slice(0, 4), 'ACGT')
    assert.deepEqual(store.maskedForRow({ start: 1, end: 60 }), [{ s: 5, e: 9 }])
    assert.deepEqual(store.maskedForRow({ start: 100, end: 160 }), [])
})

/** A store holding one stretch of sequence from coordinate 1. */
function storedFrom(sequence) {
    const store = sequenceStore()
    store.put({ start: 1, sequence })
    return store
}

test('a document is rows of cells wearing the palette the view is wearing', () => {
    const bases = 'ACGT'.repeat(30) // 120 bases, two rows
    const document_ = entryDocument({
        entry,
        layout: entryLayout({ entry, shape: SHAPE_FULL }),
        store: storedFrom(bases),
        runs: [{ s: 1, e: 60, c: 'intron' }],
        strand: '+',
        palette: DEFAULT_PALETTE,
    })
    assert.equal(document_.rows.length, 2)
    assert.equal(document_.rows[0].cells.length, 60)
    assert.equal(document_.rows[0].left, 1)
    assert.equal(document_.rows[0].right, 60)
    const intronic = document_.rows[0].cells[0]
    assert.equal(intronic.ch, 'A')
    assert.equal(intronic.bg, DEFAULT_PALETTE.style(CLASS_CODES.intron).bg)
    assert.ok(intronic.fg)
    // Nothing describes the second row, so it is bare sequence.
    assert.equal(document_.rows[1].cells[0].bg, null)
})

test('an outlined class is an outline in the file too, never a fill', () => {
    const document_ = entryDocument({
        entry: { ...entry, end: 60 },
        layout: entryLayout({ entry: { ...entry, end: 60 }, shape: SHAPE_FULL }),
        store: storedFrom('A'.repeat(60)),
        runs: [{ s: 1, e: 60, c: 'intergenic' }],
        palette: DEFAULT_PALETTE,
    })
    const cell = document_.rows[0].cells[0]
    assert.equal(cell.bg, null)
    assert.equal(cell.outline, DEFAULT_PALETTE.style(CLASS_CODES.intergenic).bg)
})

test('a switched-off class is left uncoloured, as it is on screen', () => {
    const shared = {
        entry: { ...entry, end: 60 },
        layout: entryLayout({ entry: { ...entry, end: 60 }, shape: SHAPE_FULL }),
        store: storedFrom('A'.repeat(60)),
        runs: [{ s: 1, e: 60, c: 'intron' }],
        palette: DEFAULT_PALETTE,
    }
    const on = entryDocument({ ...shared, allowed: new Set([CLASS_CODES.intron]) })
    const off = entryDocument({ ...shared, allowed: new Set() })
    assert.ok(on.rows[0].cells[0].bg)
    assert.equal(off.rows[0].cells[0].bg, null)
})

test('a base more than one gene covers carries a rule, over whatever it wears', () => {
    const short = { ...entry, end: 60 }
    const shared = {
        entry: short,
        layout: entryLayout({ entry: short, shape: SHAPE_FULL }),
        store: storedFrom('A'.repeat(60)),
        runs: [{ s: 1, e: 60, c: 'intron' }],
        palette: DEFAULT_PALETTE,
    }
    const plain = entryDocument({ ...shared })
    const ruled = entryDocument({ ...shared, overlaps: [{ s: 10, e: 20, n: 2 }] })
    assert.equal(plain.rows[0].cells[12].underline, null)
    assert.equal(ruled.rows[0].cells[12].underline, DEFAULT_PALETTE.overlap)
    // The rule goes on top: the base is still intronic and still says so.
    assert.equal(ruled.rows[0].cells[12].bg, DEFAULT_PALETTE.style(CLASS_CODES.intron).bg)
    // And only where the genes actually lie on one another.
    assert.equal(ruled.rows[0].cells[0].underline, null)
    assert.equal(ruled.rows[0].cells[30].underline, null)
    assert.ok(EDGE_OVERLAP > 0)
})

test('gutters can be left off without changing a single cell', () => {
    const shared = {
        entry: { ...entry, end: 60 },
        layout: entryLayout({ entry: { ...entry, end: 60 }, shape: SHAPE_FULL }),
        store: storedFrom('A'.repeat(60)),
        palette: DEFAULT_PALETTE,
    }
    const with_ = entryDocument({ ...shared, gutters: true })
    const without = entryDocument({ ...shared, gutters: false })
    assert.equal(without.rows[0].left, null)
    assert.equal(without.rows[0].right, null)
    assert.deepEqual(without.rows[0].cells, with_.rows[0].cells)
})

test('a collapsed document writes the markers as markers and leaves them out of the bases', () => {
    const far = { ...entry, start: 1, end: 400 }
    const layout = entryLayout({
        entry: far,
        shape: SHAPE_SHOWN,
        spans: { offers: ['intron'], genic: [{ s: 1, e: 400 }], exonic: [{ s: 1, e: 60 }, { s: 341, e: 400 }] },
        collapse: { intron: { on: true, flank: 0, min: 30 } },
    })
    const document_ = entryDocument({
        entry: far,
        layout,
        store: storedFrom('A'.repeat(400)),
        palette: DEFAULT_PALETTE,
    })
    assert.ok(document_.collapsed)
    assert.ok(document_.hidden > 0)
    const cells = document_.rows.flatMap((row) => row.cells)
    assert.ok(cells.some((cell) => cell.gap))
    // The bases of a collapsed record are what is drawn, with the markers left
    // out -- which is exactly what the backend writes when asked with `seg`.
    assert.equal(documentBases(document_), 'A'.repeat(120))
})

test('FASTA and plain text are the same bases, one with a header and one without', () => {
    const document_ = entryDocument({
        entry: { ...entry, end: 90 },
        layout: entryLayout({ entry: { ...entry, end: 90 }, shape: SHAPE_FULL }),
        store: storedFrom('ACGTACGTAC'.repeat(9)),
        palette: DEFAULT_PALETTE,
    })
    const fasta = fastaText([document_])
    assert.ok(fasta.startsWith('>ENST1 1:1-90(+)'))
    assert.equal(fasta.split('\n')[1].length, 60)
    assert.equal(fasta.split('\n')[2].length, 30)
    const plain = plainText([document_])
    assert.ok(!plain.includes('>'))
    assert.equal(plain.replace(/\n/g, ''), documentBases(document_))
})

test('a spliced record says so in its header, so a pasted sequence can be told apart', () => {
    assert.match(
        documentHeader({ label: 'X', chrom: '1', start: 1, end: 400, strand: '+', collapsed: true, hidden: 280 }),
        /spliced -280bp/,
    )
    assert.match(
        documentHeader({ label: 'X', chrom: '1', start: 1, end: 9, strand: '-', collapsed: false }),
        /1:1-9\(-\)$/,
    )
})

test('the coloured formats are the two that carry the palette', () => {
    assert.deepEqual(
        EXPORT_FORMATS.filter((item) => item.coloured).map((item) => item.id),
        ['rtf', 'html'],
    )
    assert.equal(formatIsColoured('rtf'), true)
    assert.equal(formatIsColoured('fasta'), false)
    // An unknown format is the first one rather than a crash.
    assert.equal(exportFormat('nonsense').id, EXPORT_FORMATS[0].id)
})

test('a coloured export is costed rather than refused', () => {
    assert.ok(COLOURED_EXPORT_WARN_BP > 0)
    // Measured at about three bytes of RTF a base, runs already joined.
    assert.equal(estimateColouredBytes(0), 0)
    assert.ok(estimateColouredBytes(1_000_000) > 2_000_000)
    assert.ok(estimateColouredBytes(1_000_000) < 4_000_000)
    // A chromosome is hundreds of megabytes, which is past what one JavaScript
    // string can hold -- the reason the writer streams into pieces.
    assert.ok(estimateColouredBytes(248_956_422) > 536_870_888)
    assert.equal(estimateColouredBytes(null), 0)
})

test('rows are painted in blocks, and a block asks only for what it draws', () => {
    assert.ok(EXPORT_ROW_BLOCK > 0)
    const long = { ...entry, end: 120_000 }
    const layout = entryLayout({ entry: long, shape: SHAPE_FULL })
    assert.equal(layout.totalRows, 2000)
    const first = intervalsForRows(layout, 0, 10)
    assert.deepEqual(first, [{ s: 1, e: 600 }])
    const later = intervalsForRows(layout, 1000, 10)
    assert.deepEqual(later, [{ s: 60_001, e: 60_600 }])
    // Which is one short read, not the whole record.
    assert.deepEqual(readsForIntervals(later), [{ start: 60_001, end: 72_000 }])
})

test('painting a block gives exactly that block, wherever it starts', () => {
    const long = { ...entry, end: 600 }
    const layout = entryLayout({ entry: long, shape: SHAPE_FULL })
    const store = storedFrom('A'.repeat(600))
    const shared = { layout, store, palette: DEFAULT_PALETTE }
    const all = paintRows({ ...shared, from: 0, count: 10 })
    const middle = paintRows({ ...shared, from: 4, count: 2 })
    assert.equal(all.length, 10)
    assert.equal(middle.length, 2)
    assert.deepEqual(middle[0], all[4])
    assert.deepEqual(middle[1], all[5])
    // Asking past the end stops at the end rather than inventing rows.
    assert.equal(paintRows({ ...shared, from: 8, count: 500 }).length, 2)
    assert.equal(paintRows({ ...shared, from: 99, count: 10 }).length, 0)
})

test('the colour table is declared from the palette, since a stream cannot look ahead', () => {
    const colours = paletteColours(DEFAULT_PALETTE)
    // Every fill a class can wear, and the ink that goes on it.
    assert.ok(colours.includes(DEFAULT_PALETTE.style(CLASS_CODES.intron).bg))
    assert.ok(colours.includes(DEFAULT_PALETTE.style(CLASS_CODES.cds).bg))
    assert.ok(colours.includes(DEFAULT_PALETTE.style(CLASS_CODES.cds1).bg))
    // The plain ink and the marker ink, which belong to no class.
    assert.ok(colours.includes('#334155'))
    assert.ok(colours.includes('#94a3b8'))
    assert.equal(colours.length, new Set(colours).size, 'no colour is declared twice')
})

test('the file is named after what was downloaded, safely', () => {
    assert.equal(
        exportFileName({ target: { label: 'x', entries: [{ label: 'ENST00000001.1' }] }, format: 'rtf' }),
        'ENST00000001.1.rtf',
    )
    assert.equal(
        exportFileName({ target: { fileStem: 'selected records', entries: [{}, {}, {}] }, format: 'fasta' }),
        'selected_records.fa',
    )
    assert.equal(
        exportFileName({ target: { label: 'exon 2/3', entries: [{ label: 'exon 2/3' }] }, format: 'html' }),
        'exon_2_3.html',
    )
    assert.equal(exportFileName({ format: 'text', chrom: '1' }), '1.txt')
})

test('what the reader types is made safe and keeps the format extension', () => {
    // Typed without one, or with the right one, or with somebody else's.
    assert.equal(resolveFileName('my exon', 'rtf'), 'my_exon.rtf')
    assert.equal(resolveFileName('my exon.rtf', 'rtf'), 'my_exon.rtf')
    assert.equal(resolveFileName('MY EXON.RTF', 'rtf'), 'MY_EXON.rtf')
    // A name that would escape the folder, or name nothing at all.
    assert.equal(resolveFileName('../../etc/passwd', 'fasta'), 'etc_passwd.fa')
    assert.equal(resolveFileName('   ', 'html', 'ENST1'), 'ENST1.html')
    assert.equal(resolveFileName('', 'text'), 'sequence.txt')
    assert.equal(resolveFileName(null, 'rtf', 'chr 1'), 'chr_1.rtf')
})

test('a file size is said the way a reader would say it', () => {
    assert.equal(formatBytes(0), '0 bytes')
    assert.equal(formatBytes(940), '940 bytes')
    assert.equal(formatBytes(96_000), '96 kB')
    assert.equal(formatBytes(96_024_796), '96 MB')
    assert.equal(formatBytes(722_000_000), '722 MB')
    assert.equal(formatBytes(1_200_000_000), '1.2 GB')
    assert.equal(formatBytes(-5), '0 bytes')
})

test('a transcript offers its own readings, with what each holds', () => {
    const focus = {
        chrom: 'chr1',
        transcript: { id: 'ENST1', strand: '-' },
    }
    const answers = {
        transcript: { status: 'ok', length: 2618 },
        protein: { status: 'ok', length: 305 },
        // Asked for and not back yet: a length is not known, which is not the
        // same as being nought.
        cds: null,
    }
    const targets = readingTargets({
        focus,
        readings: ['transcript', 'cds', 'protein'],
        answers,
    })
    assert.deepEqual(targets.map((one) => one.id), [
        'reading:transcript', 'reading:cds', 'reading:protein',
    ])
    assert.deepEqual(targets.map((one) => one.bases), [2618, 0, 305])
    assert.deepEqual(targets.map((one) => one.unit), ['bp', 'bp', 'aa'])
    assert.deepEqual(targets.map((one) => one.label), [
        'Transcript (sequence)', 'CDS', 'Protein',
    ])
    // In a file there is nothing to tell it from, so it is named plainly.
    assert.equal(targets[0].entries[0].detail, 'Transcript sequence')
    // No flank: there is no sequence either side of a spliced transcript in
    // its own coordinates.
    assert.equal(targets.every((one) => one.flankable === false), true)
    // Named for the transcript and the reading, so two of them do not collide.
    assert.equal(exportFileName({ target: targets[2], format: 'fasta' }), 'ENST1_protein.fa')

    // Counted off the reading's own length rather than its entries, which
    // have no span to count.
    assert.equal(targetBases(targets[0]), 2618)
    assert.equal(targetBases(targets[1]), 0)

    // Nothing to offer where there is no transcript, or no reading fetched.
    assert.deepEqual(readingTargets({ focus: { chrom: 'chr1' }, readings: ['transcript'] }), [])
    assert.deepEqual(readingTargets({ focus, readings: [] }), [])
})

test('the readings are listed under the transcript they are readings of', () => {
    const levels = [
        { id: 'records', label: '2 selected records' },
        { id: 'level:location', label: 'Location' },
        { id: 'level:gene', label: 'Gene' },
        { id: 'level:transcript', label: 'Transcript' },
        { id: 'level:feature', label: 'Feature' },
    ]
    const readings = [
        { id: 'reading:transcript', label: 'Transcript (sequence)' },
        { id: 'reading:cds', label: 'CDS' },
        { id: 'reading:protein', label: 'Protein' },
    ]
    assert.deepEqual(orderTargets(levels, readings).map((one) => [one.id, one.label]), [
        ['records', '2 selected records'],
        ['level:location', 'Location'],
        ['level:gene', 'Gene'],
        // The transcript twice: its stretch of chromosome, then its own
        // sequence read three ways.
        ['level:transcript', 'Transcript (genomic)'],
        ['reading:transcript', 'Transcript (sequence)'],
        ['reading:cds', 'CDS'],
        ['reading:protein', 'Protein'],
        ['level:feature', 'Feature'],
    ])

    // With nothing to tell it from, the transcript level keeps its own name.
    assert.deepEqual(orderTargets(levels, []), levels)
    // And with no transcript level to sit under, the readings do not jump the
    // ladder.
    const without = levels.filter((one) => one.id !== 'level:transcript')
    assert.deepEqual(
        orderTargets(without, readings).map((one) => one.id),
        [...without.map((one) => one.id), ...readings.map((one) => one.id)],
    )
})
