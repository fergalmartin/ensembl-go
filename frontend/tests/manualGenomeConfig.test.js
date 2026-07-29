import assert from 'node:assert/strict'
import test from 'node:test'

import {
    batchProgress,
    findDuplicateManualGenome,
    manualGenomesAreDuplicates,
    manualProgressText,
    mergeManualGenomePlaylistMemberships,
    normalizeManualPlaylistNames,
} from '../src/utils/manualGenomeConfig.js'

test('matching accessions are duplicates regardless of source labels', () => {
    assert.equal(
        manualGenomesAreDuplicates(
            { accession: 'gca_000001.1', species: 'One', assembly: 'A' },
            { gca: 'GCA_000001.1', scientific_name: 'Other', assembly_name: 'B' },
        ),
        true,
    )
})

test('entries without two accessions use normalized species and assembly labels', () => {
    const existing = { scientific_name: 'Homo sapiens', assembly_name: 'GRCh38' }
    const imported = { species: '  homo   sapiens ', assembly: 'grch38' }
    assert.equal(manualGenomesAreDuplicates(existing, imported), true)
    assert.equal(findDuplicateManualGenome(imported, [existing]), existing)
})

test('different explicit accessions are not duplicates', () => {
    assert.equal(
        manualGenomesAreDuplicates(
            { accession: 'GCA_1', species: 'Test', assembly: 'v1' },
            { accession: 'GCA_2', species: 'Test', assembly: 'v1' },
        ),
        false,
    )
})

test('two dataset releases of one assembly are not duplicates', () => {
    const older = { accession: 'GCA_1', species: 'Test', assembly: 'v1', dataset_release_key: 'ensembl/2023_03' }
    const newer = { accession: 'GCA_1', species: 'Test', assembly: 'v1', dataset_release_key: 'ensembl/2024_11' }
    assert.equal(manualGenomesAreDuplicates(older, newer), false)
    assert.equal(findDuplicateManualGenome(newer, [older]), null)
})

test('a release-tagged genome still matches an untagged one for the same assembly', () => {
    assert.equal(
        manualGenomesAreDuplicates(
            { accession: 'GCA_1', species: 'Test', assembly: 'v1' },
            { accession: 'GCA_1', species: 'Test', assembly: 'v1', dataset_release_key: 'ensembl/2024_11' },
        ),
        true,
    )
})

test('a bundle entry release key is read from its nested dataset_release', () => {
    assert.equal(
        manualGenomesAreDuplicates(
            { accession: 'GCA_1', dataset_release: { key: 'ensembl/2023_03' } },
            { accession: 'GCA_1', dataset_release_key: 'ensembl/2024_11' },
        ),
        false,
    )
})

test('playlist names normalize whitespace and deduplicate case-insensitively', () => {
    assert.deepEqual(
        normalizeManualPlaylistNames([' Comparative   set ', 'comparative set', '', 'QA']),
        ['Comparative set', 'QA'],
    )
})

test('playlist assignments reuse existing names and create missing playlists', () => {
    let nextId = 1
    const genome = { key: 'manual:test:v1', species: 'Test', assembly: 'v1' }
    const result = mergeManualGenomePlaylistMemberships(
        [{
            id: 'existing',
            name: 'Research',
            genomes: [],
        }],
        [{
            genome,
            playlists: [' research ', 'New cohort', 'NEW COHORT'],
        }],
        {
            createPlaylistId: () => `new-${nextId++}`,
            snapshotGenome: (item) => ({ key: item.key }),
            genomesMatch: (left, right) => left.key === right.key,
        },
    )
    assert.equal(result.length, 2)
    assert.deepEqual(result[0].genomes, [{ key: genome.key, active_by_default: true }])
    assert.equal(result[1].name, 'New cohort')
    assert.deepEqual(result[1].genomes, [{ key: genome.key, active_by_default: true }])
})

test('batch progress combines completed genomes with current work', () => {
    assert.equal(batchProgress(2, 50, 5), 50)
    assert.equal(
        manualProgressText({ stage: 'building_gene_models', message: 'Building gene models', counters: { features: 9000, genes: 1234 } }),
        'Building gene models — 1,234 genes',
    )
})
