import test from 'node:test'
import assert from 'node:assert/strict'

import { buildActiveDownloads, buildActiveTaskSections } from '../src/utils/activeDownloads.js'

const task = (overrides) => ({
    id: 'id',
    species_key: 'homo_sapiens',
    assembly: 'GCA_000001405.29',
    provider: 'ensembl',
    file_type: 'fasta',
    status: 'pending',
    progress: 0,
    ...overrides,
})

test('groups active files by genome and leaves finished ones out', () => {
    const result = buildActiveDownloads([
        task({ id: 'fa', status: 'downloading', progress: 0.4, scientific_name: 'Homo sapiens', common_name: 'Human', assembly_name: 'GRCh38' }),
        task({ id: 'gff', file_type: 'gff3' }),
        task({ id: 'done', file_type: 'homology', status: 'completed', progress: 1 }),
        task({ id: 'failed', file_type: 'cdna', status: 'failed' }),
        task({ id: 'mouse', species_key: 'mus_musculus', assembly: 'GCA_000001635.9' }),
    ])

    assert.equal(result.genomes.length, 2)
    const human = result.genomes[0]
    assert.equal(human.name, 'Human')
    assert.equal(human.scientificName, 'Homo sapiens')
    assert.equal(human.assemblyName, 'GRCh38')
    assert.equal(human.accession, 'GCA_000001405.29')
    assert.equal(human.source, 'Ensembl')
    assert.deepEqual(human.files.map((file) => file.id), ['fa', 'gff'])
    assert.equal(result.downloading, 1)
    assert.equal(result.queued, 2)
})

test('falls back to a name built from the species key', () => {
    const [genome] = buildActiveDownloads([task({ species_key: 'danio_rerio' })]).genomes
    assert.equal(genome.name, 'Danio rerio')
})

test('hides metadata files but still cancels them with their genome', () => {
    const result = buildActiveDownloads([
        task({ id: 'fa', status: 'downloading' }),
        task({ id: 'meta', file_type: 'metadata', status: 'downloading' }),
    ])
    assert.deepEqual(result.genomes[0].files.map((file) => file.id), ['fa'])
    assert.deepEqual(result.genomes[0].taskIds.sort(), ['fa', 'meta'])
    assert.equal(result.downloading, 1)
})

test('a genome with only metadata left is not listed', () => {
    const result = buildActiveDownloads([task({ id: 'meta', file_type: 'metadata' })])
    assert.equal(result.genomes.length, 0)
})

test('running files come first, then the queue in request order', () => {
    const [genome] = buildActiveDownloads([
        task({ id: 'q2', file_type: 'cdna', created_at: '2026-01-01T00:00:02Z' }),
        task({ id: 'q1', file_type: 'protein', created_at: '2026-01-01T00:00:01Z' }),
        task({ id: 'run', file_type: 'gff3', status: 'downloading', progress: 0.2 }),
    ]).genomes
    assert.deepEqual(genome.files.map((file) => file.id), ['run', 'q1', 'q2'])
})

test('genomes with a running file sit above ones that are only queued', () => {
    const result = buildActiveDownloads([
        task({ id: 'waiting', species_key: 'mus_musculus', assembly: 'GCA_2' }),
        task({ id: 'running', status: 'downloading' }),
    ])
    assert.deepEqual(result.genomes.map((genome) => genome.files[0].id), ['running', 'waiting'])
})

test('task sections list running files and count the queue', () => {
    const [section] = buildActiveTaskSections([
        task({ id: 'fa', status: 'downloading', progress: 0.5, assembly_name: 'GRCh38', scientific_name: 'Homo sapiens', common_name: 'Human' }),
        task({ id: 'gff', file_type: 'gff3' }),
    ])
    assert.equal(section.title, 'Downloads')
    assert.deepEqual(
        section.active.map((row) => [row.id, row.typeLabel, row.scientificName, row.genomeName, row.assemblyName]),
        [['fa', 'Genome', 'Homo sapiens', 'Human', 'GRCh38']],
    )
    assert.equal(section.queuedCount, 1)
    assert.equal(section.total, 2)
    assert.equal(section.progress, 0.25)
})

test('no sections when nothing is running', () => {
    assert.deepEqual(buildActiveTaskSections([task({ status: 'completed' })]), [])
})
