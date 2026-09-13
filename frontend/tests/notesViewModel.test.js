import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildNoteSections,
    groupNotesByGene,
    looksLikeFeatureId,
    matchNotes,
    sortGeneRows,
    summariseNotes,
} from '../src/utils/notesViewModel.js'

const HUMAN = 'ensembl::Homo_sapiens::GCA_000001405.29'
const MOUSE = 'ensembl::Mus_musculus::GCA_000001635.9'
const RAT = 'ensembl::Rattus_norvegicus::GCA_015227675.2'

function note(id, { genomeKey = HUMAN, geneId = 'ENSG1', label = 'TP53', updatedAt = '2026-08-01T00:00:00Z', ...rest } = {}) {
    return {
        id,
        title: '',
        body: `body ${id}`,
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt,
        target: { kind: 'gene', genome_key: genomeKey, id: geneId, label, genome_selection_key: '' },
        ...rest,
    }
}

const genome = (key, name) => ({ notesGenomeKey: key, name })

// ── Sections ────────────────────────────────────────────────────────────────

test('loaded genomes come first, in top-bar order, even with nothing written', () => {
    const notes = [note('a', { genomeKey: MOUSE }), note('b', { genomeKey: HUMAN })]
    const active = [genome(HUMAN, 'Human'), genome(MOUSE, 'Mouse'), genome('ensembl::Danio_rerio::GRCz11', 'Zebrafish')]

    const sections = buildNoteSections(notes, active)
    assert.deepEqual(sections.map((s) => s.genome.name), ['Human', 'Mouse', 'Zebrafish'])
    assert.deepEqual(sections.map((s) => s.noteCount), [1, 1, 0])
    assert.ok(sections.every((s) => s.inTopBar))
})

test('top-bar genome metadata and active state survive into the same ordered note sections', () => {
    const topBarGenomes = [
        { ...genome(MOUSE, 'Mouse'), active: false },
        { ...genome(HUMAN, 'Human'), active: true },
    ]

    const sections = buildNoteSections([note('human-note')], topBarGenomes)

    assert.deepEqual(sections.map((section) => section.genomeKey), [MOUSE, HUMAN])
    assert.deepEqual(sections.map((section) => section.genome.active), [false, true])
})

test('genomes only known from notes follow, most recently touched first', () => {
    const notes = [
        note('a', { genomeKey: HUMAN, updatedAt: '2026-08-01T00:00:00Z' }),
        note('b', { genomeKey: RAT, updatedAt: '2026-08-05T00:00:00Z' }),
        note('c', { genomeKey: MOUSE, updatedAt: '2026-08-09T00:00:00Z' }),
    ]
    const sections = buildNoteSections(notes, [genome(HUMAN, 'Human')])

    assert.deepEqual(sections.map((s) => s.genomeKey), [HUMAN, MOUSE, RAT])
    assert.deepEqual(sections.map((s) => s.inTopBar), [true, false, false])
    // A genome that is not loaded has no species record to render a pill from.
    assert.equal(sections[1].genome, null)
})

test('a note written under a dataset release lands in its assembly section', () => {
    const notes = [note('a', { genomeKey: `${HUMAN}::dataset::ensembl/2025_12` })]
    const sections = buildNoteSections(notes, [genome(`${HUMAN}::dataset::ensembl/2024_01`, 'Human')])

    assert.equal(sections.length, 1)
    assert.equal(sections[0].inTopBar, true)
    assert.equal(sections[0].noteCount, 1)
})

test('non-gene notes are left out of the gene sections', () => {
    const region = note('r', { geneId: 'chr1:1-2' })
    region.target.kind = 'region'
    const sections = buildNoteSections([region, note('a')], [genome(HUMAN, 'Human')])
    assert.equal(sections[0].noteCount, 1)
})

test('genome-level notes populate the general row without becoming genes', () => {
    const general = note('general')
    general.target.kind = 'genome'
    general.target.id = 'general'
    general.target.label = 'General notes'
    const sections = buildNoteSections([general, note('gene')], [genome(HUMAN, 'Human')])

    assert.equal(sections[0].noteCount, 2)
    assert.equal(sections[0].genes.length, 1)
    assert.deepEqual(sections[0].generalNotes.map((entry) => entry.id), ['general'])
    assert.equal(sections[0].generalActiveCount, 1)
    assert.equal(sections[0].generalArchivedCount, 0)
})

test('sections survive an empty store and a missing genome list', () => {
    assert.deepEqual(buildNoteSections([], []), [])
    assert.deepEqual(buildNoteSections(null, null), [])
    assert.equal(buildNoteSections([note('a')], null).length, 1)
})

// ── Gene rows ───────────────────────────────────────────────────────────────

test('notes collapse into one row per gene, labelled from the freshest note', () => {
    const rows = groupNotesByGene([
        note('a', { geneId: 'ENSG1', label: 'OLD', updatedAt: '2026-08-01T00:00:00Z' }),
        note('b', { geneId: 'ENSG1', label: 'BRCA2', updatedAt: '2026-08-09T00:00:00Z' }),
        note('c', { geneId: 'ENSG2', label: 'TP53', updatedAt: '2026-08-05T00:00:00Z' }),
    ])

    assert.deepEqual(rows.map((r) => r.geneId), ['ENSG1', 'ENSG2'])
    assert.equal(rows[0].label, 'BRCA2', 'the label should track the most recent note')
    assert.equal(rows[0].count, 2)
    assert.equal(rows[0].updatedAt, '2026-08-09T00:00:00Z')
})

test('gene and genome rows keep active and archived note totals separately', () => {
    const sections = buildNoteSections([
        note('active', { geneId: 'ENSG1' }),
        note('archived', { geneId: 'ENSG1', archived: true }),
        note('archived-only', { geneId: 'ENSG2', archived: true }),
    ], [genome(HUMAN, 'Human')])

    assert.equal(sections[0].activeNoteCount, 1)
    assert.equal(sections[0].archivedNoteCount, 2)
    assert.deepEqual(
        sections[0].genes.map((row) => [row.geneId, row.activeCount, row.archivedCount]),
        [['ENSG1', 1, 1], ['ENSG2', 0, 1]],
    )
})

test('an archive-only genome remains available for restoring its notes', () => {
    const sections = buildNoteSections([
        note('archived', { genomeKey: RAT, archived: true }),
    ], [genome(HUMAN, 'Human')])

    assert.deepEqual(sections.map((section) => section.genomeKey), [HUMAN, RAT])
    assert.equal(sections[1].activeNoteCount, 0)
    assert.equal(sections[1].archivedNoteCount, 1)
})

test('gene rows sort by each mode without mutating the input', () => {
    const rows = [
        { geneId: 'G1', label: 'Zeta', count: 1, updatedAt: '2026-08-03T00:00:00Z' },
        { geneId: 'G2', label: 'Alpha', count: 3, updatedAt: '2026-08-01T00:00:00Z' },
        { geneId: 'G3', label: 'Mid', count: 2, updatedAt: '2026-08-09T00:00:00Z' },
    ]
    const snapshot = rows.map((r) => r.geneId)

    assert.deepEqual(sortGeneRows(rows, 'recent_desc').map((r) => r.geneId), ['G3', 'G1', 'G2'])
    assert.deepEqual(sortGeneRows(rows, 'recent_asc').map((r) => r.geneId), ['G2', 'G1', 'G3'])
    assert.deepEqual(sortGeneRows(rows, 'symbol_asc').map((r) => r.geneId), ['G2', 'G3', 'G1'])
    assert.deepEqual(sortGeneRows(rows, 'count_desc').map((r) => r.geneId), ['G2', 'G3', 'G1'])
    assert.deepEqual(sortGeneRows(rows, 'nonsense').map((r) => r.geneId), ['G3', 'G1', 'G2'])
    assert.deepEqual(rows.map((r) => r.geneId), snapshot)
})

test('a gene with no symbol falls back to its id for sorting', () => {
    const rows = sortGeneRows([
        { geneId: 'ENSG9', label: '', count: 1, updatedAt: '' },
        { geneId: 'ENSG1', label: '', count: 1, updatedAt: '' },
    ], 'symbol_asc')
    assert.deepEqual(rows.map((r) => r.geneId), ['ENSG1', 'ENSG9'])
})

// ── Search ──────────────────────────────────────────────────────────────────

test('search covers symbol, stable id, title and body', () => {
    const notes = [
        note('a', { geneId: 'ENSG1', label: 'BRCA2', body: 'exon 11 boundary' }),
        note('b', { geneId: 'ENSG2', label: 'TP53', body: 'coverage drops here' }),
        note('c', { geneId: 'ENSG3', label: 'REG4', title: 'Splice check', body: 'nothing' }),
    ]
    assert.deepEqual(matchNotes(notes, 'brca').map((n) => n.id), ['a'])
    assert.deepEqual(matchNotes(notes, 'ENSG2').map((n) => n.id), ['b'])
    assert.deepEqual(matchNotes(notes, 'coverage').map((n) => n.id), ['b'])
    assert.deepEqual(matchNotes(notes, 'splice CHECK').map((n) => n.id), ['c'])
})

test('the same symbol in two genomes returns both', () => {
    const notes = [
        note('a', { genomeKey: HUMAN, label: 'BRCA2' }),
        note('b', { genomeKey: MOUSE, label: 'Brca2' }),
        note('c', { genomeKey: HUMAN, label: 'TP53' }),
    ]
    assert.deepEqual(matchNotes(notes, 'brca2').map((n) => n.id), ['a', 'b'])
})

test('an empty query passes everything through untouched', () => {
    const notes = [note('a'), note('b')]
    assert.equal(matchNotes(notes, ''), notes)
    assert.equal(matchNotes(notes, '   '), notes)
    assert.deepEqual(matchNotes(null, 'x'), [])
})

test('feature-shaped queries are recognised, prose is not', () => {
    assert.equal(looksLikeFeatureId('ENST00000380152'), true)
    assert.equal(looksLikeFeatureId('ENSG00000139618.17'), true)
    assert.equal(looksLikeFeatureId('BRCA2'), false)
    assert.equal(looksLikeFeatureId('coverage drops'), false)
    assert.equal(looksLikeFeatureId(''), false)
})

// ── Summary ─────────────────────────────────────────────────────────────────

test('the header counts only genomes that actually have notes', () => {
    const sections = buildNoteSections(
        [note('a', { geneId: 'ENSG1' }), note('b', { geneId: 'ENSG2' }), note('c', { genomeKey: MOUSE })],
        [genome(HUMAN, 'Human'), genome(MOUSE, 'Mouse'), genome(RAT, 'Rat')],
    )
    assert.deepEqual(summariseNotes(sections), { notes: 3, genes: 3, genomes: 2 })
    assert.deepEqual(summariseNotes([]), { notes: 0, genes: 0, genomes: 0 })
})

test('a genome section lists the locations written about, apart from its genes', () => {
    const locationNote = {
        ...note('loc', {}),
        target: {
            kind: 'location',
            genome_key: HUMAN,
            id: '1:1000000-1200000',
            label: 'Location: 1:1,000,000-1,200,000',
            genome_selection_key: '',
        },
    }
    const sections = buildNoteSections(
        [note('gene-note'), locationNote],
        [genome(HUMAN, 'Human')]
    )
    const human = sections[0]
    assert.deepEqual(human.genes.map((row) => row.geneId), ['ENSG1'])
    assert.deepEqual(human.locations.map((row) => row.geneId), ['1:1000000-1200000'])
    assert.equal(human.locations[0].label, 'Location: 1:1,000,000-1,200,000')
    // A location note counts towards the genome the way any other note does.
    assert.equal(human.noteCount, 2)
    assert.equal(human.activeNoteCount, 2)
})
