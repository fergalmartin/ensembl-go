import assert from 'node:assert/strict'
import test from 'node:test'

import {
    BUNDLE_CELL_MISSING,
    BUNDLE_CELL_PRESENT,
    bundleMissingFileReport,
    bundlePreviewModel,
    buildGenomeBundle,
    portableGenomeEntry,
    registrationBadgeLabel,
    registrationBadgeTooltip,
} from '../src/utils/genomeBundle.js'
import { canonicalBundleFiles, orderBundleFileTypes } from '../src/utils/genomeFileTypes.js'

const downloadedGenome = {
    scientific_name: 'Homo sapiens',
    species_key: 'Homo_sapiens',
    common_name: 'Human',
    display_name: 'Human',
    display_name_reason: 'common_name',
    assembly: 'GCA_000001405.29',
    assembly_name: 'GRCh38.p14',
    gca: 'GCA_000001405.29',
    equivalent_accessions: ['gcf_000001405.40', 'GCF_000001405.40'],
    provider: 'ensembl',
    source_database: 'Ensembl',
    dataset_release_key: 'ensembl/2024_11',
    dataset_release_source: 'ensembl',
    dataset_release_date: '2024_11',
    dataset_release_label: 'Ensembl 2024_11',
    dataset_release_short_label: 'E113',
}

test('a downloaded genome exports with its provider, release and every file type', () => {
    const record = portableGenomeEntry(downloadedGenome, {
        files: {
            fasta: '/data/human.fa.bgz',
            gff3: '/data/human.gff3.gz',
            homology: '/data/human.homology.tsv.gz',
            metadata: '/data/human.assembly_report.txt',
            cdna: '/data/human.cdna.fa.gz',
        },
        playlists: [' Primate references ', 'primate references'],
    })

    assert.equal(record.provider, 'ensembl')
    assert.equal(record.source_database, 'Ensembl')
    assert.equal(record.species, 'Homo sapiens')
    assert.equal(record.species_key, 'Homo_sapiens')
    assert.equal(record.assembly, 'GCA_000001405.29')
    assert.equal(record.assembly_name, 'GRCh38.p14')
    assert.equal(record.display_name_reason, 'common_name')
    assert.deepEqual(record.equivalent_accessions, ['GCF_000001405.40'])
    assert.deepEqual(record.dataset_release, {
        key: 'ensembl/2024_11',
        source: 'ensembl',
        date: '2024_11',
        label: 'Ensembl 2024_11',
        short_label: 'E113',
    })
    assert.deepEqual(record.playlists, ['Primate references'])
    assert.deepEqual(Object.keys(record.files), ['fasta', 'gff3', 'homology', 'metadata', 'cdna'])
})

test('a manually added genome exports without release or identity padding', () => {
    const record = portableGenomeEntry({
        scientific_name: 'Acomys cahirinus',
        assembly: 'test1234',
        provider: 'manual',
        source_database: 'Manual',
    }, { files: { fasta: '/data/spiny.fa' } })

    assert.deepEqual(record, {
        species: 'Acomys cahirinus',
        assembly: 'test1234',
        accession: '',
        files: { fasta: '/data/spiny.fa' },
        provider: 'manual',
        source_database: 'Manual',
    })
})

test('legacy annotation and homologies keys map onto the canonical ones', () => {
    assert.deepEqual(
        canonicalBundleFiles({ fasta: '/a.fa', annotation: '/a.gff3', homologies: '/h.tsv' }),
        { fasta: '/a.fa', gff3: '/a.gff3', homology: '/h.tsv' },
    )
    // A document carrying both spellings keeps the canonical one.
    assert.equal(
        canonicalBundleFiles({ gff3: '/canonical.gff3', annotation: '/legacy.gff3' }).gff3,
        '/canonical.gff3',
    )
})

test('a downloaded genome keeps every file type the local scan gave it', () => {
    // The backend merges assembly_files (fasta, metadata) into the release's
    // files, so a downloaded genome arrives with the full set.
    const record = portableGenomeEntry(downloadedGenome, {
        files: {
            fasta: '/d/h.fa.bgz',
            metadata: '/d/h.assembly_report.txt',
            gff3: '/d/h.gff3.gz',
            gff3_index: '/d/h.gff3.gz.tbi',
            homology: '/d/h.homology.tsv.gz',
            cdna: '/d/h.cdna.fa.gz',
            cdna_index: '/d/h.cdna.fa.gz.fai',
            protein: '/d/h.pep.fa.gz',
            protein_index: '/d/h.pep.fa.gz.fai',
            xref: '/d/h.xref.tsv.gz',
            index: '/d/h.index.db',
        },
    })
    assert.deepEqual(Object.keys(record.files), [
        'fasta', 'gff3', 'homology', 'index', 'metadata',
        'cdna', 'protein', 'xref', 'gff3_index', 'cdna_index', 'protein_index',
    ])
})

test('an unrecognised file type is carried rather than silently dropped', () => {
    const files = canonicalBundleFiles({
        fasta: '/a.fa',
        some_future_type: '/a.future',
        'not a key': '/ignored',
    })
    assert.equal(files.some_future_type, '/a.future')
    assert.equal(files['not a key'], undefined)
    // Known types stay canonical; extras follow.
    assert.deepEqual(Object.keys(files), ['fasta', 'some_future_type'])
    assert.deepEqual(
        orderBundleFileTypes(['zzz_custom', 'gff3', 'aaa_custom', 'fasta']),
        ['fasta', 'gff3', 'aaa_custom', 'zzz_custom'],
    )
})

test('the bundle only describes playlists something in it belongs to', () => {
    const bundle = buildGenomeBundle(
        [{
            genome: downloadedGenome,
            files: { fasta: '/data/human.fa' },
            playlists: ['Primate references'],
        }],
        {
            playlists: [
                { name: 'Primate references', description: 'Great apes' },
                { name: 'Unused playlist', description: 'Nothing here' },
            ],
        },
    )
    assert.equal(bundle.genomes.length, 1)
    assert.deepEqual(bundle.playlists, [{ name: 'Primate references', description: 'Great apes' }])
    assert.deepEqual(bundle.skipped, [])
})

test('a genome with no local FASTA is reported rather than exported silently', () => {
    const bundle = buildGenomeBundle([
        { genome: downloadedGenome, files: { gff3: '/data/human.gff3' } },
        { genome: { assembly: 'v1' }, files: { fasta: '/a.fa' } },
    ])
    assert.deepEqual(bundle.genomes, [])
    assert.deepEqual(bundle.skipped.map((item) => item.reason), [
        'No genome FASTA is available locally',
        'Missing species or assembly name',
    ])
})

// ---------------------------------------------------------------------------
// Review matrix
// ---------------------------------------------------------------------------

const parseResult = {
    path: '/data/genomes.json',
    format: 'ensembl-local-genomes',
    version: 2,
    playlists: [{ name: 'Primate references' }],
    entries: [
        {
            index: 0,
            valid: true,
            genome: {
                species: 'Homo sapiens',
                assembly_name: 'GRCh38.p14',
                accession: 'GCA_000001405.29',
                provider: 'ensembl',
                source_database: 'Ensembl',
                dataset_release: { short_label: 'E113' },
                playlists: ['Primate references'],
                files: { fasta: '/data/human.fa', gff3: '/data/human.gff3', metadata: '/data/human.txt' },
            },
            missing_files: [],
            diagnostics: [],
        },
        {
            index: 1,
            valid: true,
            genome: {
                species: 'Danio rerio',
                assembly_name: 'GRCz11',
                provider: 'manual',
                files: { fasta: '/data/zf.fa' },
            },
            missing_files: [{ field: 'files.gff3', path: '/data/zf.gff3', reason: 'not_found' }],
            diagnostics: [{ severity: 'warning', message: 'File not found: /data/zf.gff3' }],
        },
        {
            index: 2,
            valid: false,
            genome: { species: 'Rattus norvegicus', assembly_name: 'mRatBN7.2', files: {} },
            missing_files: [{ field: 'files.fasta', path: '/data/rat.fa', reason: 'not_found' }],
            diagnostics: [{ severity: 'error', message: 'File not found: /data/rat.fa' }],
        },
    ],
}

test('matrix columns are the union of mentioned file types in canonical order', () => {
    const model = bundlePreviewModel(parseResult)
    // fasta and gff3 precede metadata; homology is absent because nothing lists it.
    assert.deepEqual(model.columns, ['fasta', 'gff3', 'metadata'])
    assert.equal(model.totalCount, 3)
    assert.equal(model.validCount, 2)
    assert.deepEqual(model.importableIndexes, [0, 1])
})

test('cells distinguish present, listed-but-missing, and not listed', () => {
    const [human, zebrafish, rat] = bundlePreviewModel(parseResult).rows

    assert.equal(human.cells.fasta.state, BUNDLE_CELL_PRESENT)
    assert.equal(human.cells.fasta.path, '/data/human.fa')
    assert.equal(human.cells.metadata.state, BUNDLE_CELL_PRESENT)

    assert.equal(zebrafish.cells.fasta.state, BUNDLE_CELL_PRESENT)
    assert.equal(zebrafish.cells.gff3.state, BUNDLE_CELL_MISSING)
    assert.equal(zebrafish.cells.gff3.path, '/data/zf.gff3')
    assert.equal(zebrafish.cells.metadata, undefined)

    assert.equal(rat.valid, false)
    assert.equal(rat.cells.fasta.state, BUNDLE_CELL_MISSING)
    assert.match(rat.error, /rat\.fa/)
})

test('rows carry the labels the matrix shows beside each genome', () => {
    const [human, zebrafish] = bundlePreviewModel(parseResult).rows
    assert.equal(human.label, 'Homo sapiens (GRCh38.p14)')
    assert.equal(human.sourceDatabase, 'Ensembl')
    assert.equal(human.releaseLabel, 'E113')
    assert.deepEqual(human.playlists, ['Primate references'])
    // A hand-added genome has no source database, so the provider stands in.
    assert.equal(zebrafish.sourceDatabase, 'Manual')
})

test('the missing-file report can be narrowed to the imported subset', () => {
    assert.deepEqual(bundleMissingFileReport(parseResult), [
        { label: 'Danio rerio (GRCz11)', fileType: 'gff3', path: '/data/zf.gff3' },
        { label: 'Rattus norvegicus (mRatBN7.2)', fileType: 'fasta', path: '/data/rat.fa' },
    ])
    assert.deepEqual(bundleMissingFileReport(parseResult, { indexes: [0, 1] }), [
        { label: 'Danio rerio (GRCz11)', fileType: 'gff3', path: '/data/zf.gff3' },
    ])
})

test('the registration badge names the origin, not just "manual"', () => {
    assert.equal(registrationBadgeLabel({ is_manual: true, provider: 'manual' }), 'Manual')
    assert.equal(registrationBadgeLabel({ is_manual: true, provider: 'ensembl' }), 'From file')
    assert.equal(registrationBadgeLabel({ is_manual: false, provider: 'ensembl' }), '')
    assert.equal(
        registrationBadgeTooltip({ is_manual: true, provider: 'ensembl', source_database: 'Ensembl' }),
        'Registered from local files (Ensembl)',
    )
})
