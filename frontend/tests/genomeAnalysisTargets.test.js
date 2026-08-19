// The overview's shape: one section per assembly, one per gene set, each with
// its own stored report, and an opening state that shows the active genomes
// without burying the reader under every genome's reports.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analysisKeyForRelease,
  buildGenomeAnalysisTargets,
  defaultExpandedAnalysisSections,
  sectionIdsForOpenGenome,
} from '../src/utils/genomeAnalysisTargets.js'

const ENSEMBL_KEY = 'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12'
const REFSEQ_KEY = 'ncbi::Homo_sapiens::GCF_000001405.40::dataset::ncbi/current'

const ensemblHuman = () => ({
  provider: 'ensembl',
  source_database: 'Ensembl',
  species_key: 'Homo_sapiens',
  assembly: 'GCA_000001405.29',
  assembly_name: 'GRCh38.p14',
  display_name: 'Human',
  selection_key: ENSEMBL_KEY,
  assembly_key: 'ensembl::Homo_sapiens::GCA_000001405.29',
  dataset_release_key: 'ensembl/2025_12',
  default_dataset_release_key: 'ensembl/2025_12',
  files: { fasta: '/data/human.fa.bgz', gff3: '/data/2025_12/human.gff3.gz' },
  dataset_releases: [
    { key: 'ensembl/2025_12', source: 'ensembl', date: '2025_12', short_label: '2025-12', files: { gff3: '/data/2025_12/human.gff3.gz' } },
    { key: 'ensembl/2024_11', source: 'ensembl', date: '2024_11', short_label: '2024-11', files: { gff3: '/data/2024_11/human.gff3.gz' } },
  ],
})

const refseqHuman = () => ({
  provider: 'ncbi',
  source_database: 'RefSeq',
  species_key: 'Homo_sapiens',
  assembly: 'GCF_000001405.40',
  assembly_name: 'GRCh38.p14',
  display_name: 'Homo Sapiens',
  selection_key: REFSEQ_KEY,
  assembly_key: 'ncbi::Homo_sapiens::GCF_000001405.40',
  dataset_release_key: 'ncbi/current',
  default_dataset_release_key: 'ncbi/current',
  files: { fasta: '/data/refseq.fna', gff3: '/data/current/refseq.gff' },
  dataset_releases: [
    { key: 'ncbi/current', source: 'ncbi', date: 'current', short_label: 'current', files: { gff3: '/data/current/refseq.gff' } },
  ],
})

test('each genome contributes its assembly and one section per gene set', () => {
  const [ensembl, refseq] = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()])

  assert.equal(ensembl.assembly_section.path, '/data/human.fa.bgz')
  assert.equal(ensembl.assembly_section.kind, 'genome')
  assert.deepEqual(ensembl.geneSets.map((g) => g.path), [
    '/data/2025_12/human.gff3.gz',
    '/data/2024_11/human.gff3.gz',
  ])
  assert.deepEqual(ensembl.geneSets.map((g) => g.isDefault), [true, false])
  assert.equal(refseq.geneSets.length, 1)
  assert.equal(refseq.geneSets[0].isDefault, true)
})

test('gene sets are named the way the genome pill names its dataset', () => {
  const [ensembl, refseq] = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()])
  assert.deepEqual(ensembl.geneSets.map((g) => g.label), ['2025-12', '2024-11'])
  // "current" says nothing; the provider does.
  assert.equal(refseq.geneSets[0].label, 'RefSeq')
})

test('gene sets that would share a name are told apart', () => {
  const genome = refseqHuman()
  genome.dataset_releases = [
    { key: 'ncbi/current', source: 'ncbi', date: 'current', files: { gff3: '/data/a.gff' } },
    { key: 'ncbi/2023', source: 'ncbi', date: '2023', files: { gff3: '/data/b.gff' } },
  ]
  const [target] = buildGenomeAnalysisTargets([genome])
  const labels = target.geneSets.map((g) => g.label)
  assert.equal(new Set(labels).size, labels.length, `labels collide: ${labels.join(', ')}`)
})

test("a gene set's report is stored under the key the genome selector uses", () => {
  // Otherwise an analysis run in the selector would not show up here, which is
  // the whole point of sharing the store.
  const genome = ensemblHuman()
  assert.equal(analysisKeyForRelease(genome, 'ensembl/2025_12'), ENSEMBL_KEY)
  assert.equal(
    analysisKeyForRelease(genome, 'ensembl/2024_11'),
    'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2024_11',
  )
})

test('a stored report is attached when it was run against these exact files', () => {
  const reports = {
    [ENSEMBL_KEY]: {
      fasta: { kind: 'genome', path: '/data/human.fa.bgz', fasta_path: '', analysed_at: 'then', report: { sequence_count: 706 } },
      gff3: { kind: 'annotation', path: '/data/2025_12/human.gff3.gz', fasta_path: '/data/human.fa.bgz', analysed_at: 'then', report: { genes: 1 } },
    },
  }
  const [target] = buildGenomeAnalysisTargets([ensemblHuman()], { analysisReports: reports })
  assert.equal(target.assembly_section.analysis.report.sequence_count, 706)
  assert.equal(target.geneSets[0].analysis.report.genes, 1)
  assert.equal(target.geneSets[1].analysis, null, 'the other release has not been analysed')
})

test('a report for a different file is not passed off as this one', () => {
  const reports = {
    [ENSEMBL_KEY]: {
      fasta: { kind: 'genome', path: '/data/some-other.fa', analysed_at: 'then', report: { sequence_count: 1 } },
    },
  }
  const [target] = buildGenomeAnalysisTargets([ensemblHuman()], { analysisReports: reports })
  assert.equal(target.assembly_section.analysis, null)
})

test('a file override is what gets analysed', () => {
  const [target] = buildGenomeAnalysisTargets([ensemblHuman()], {
    fileOverrides: { [ENSEMBL_KEY]: { fasta: '/elsewhere/patched.fa' } },
  })
  assert.equal(target.assembly_section.path, '/elsewhere/patched.fa')
  assert.equal(target.geneSets[0].files.fasta, '/elsewhere/patched.fa')
})

test('a genome with no annotation still offers its assembly', () => {
  const genome = ensemblHuman()
  genome.files = { fasta: '/data/human.fa.bgz' }
  genome.dataset_releases = []
  const [target] = buildGenomeAnalysisTargets([genome])
  assert.equal(target.geneSets.length, 0)
  assert.equal(target.assembly_section.path, '/data/human.fa.bgz')
})

test('a manually added genome gets its single gene set', () => {
  const [target] = buildGenomeAnalysisTargets([{
    is_manual: true,
    species_key: 'human_annevo',
    assembly: 'GCA_1234',
    selection_key: 'manual::human_annevo::GCA_1234',
    files: { fasta: '/data/human.fa.bgz', gff3: '/data/annevo.gff' },
  }])
  assert.equal(target.geneSets.length, 1)
  assert.equal(target.geneSets[0].path, '/data/annevo.gff')
  assert.equal(target.geneSets[0].analysisKey, 'manual::human_annevo::GCA_1234')
})

test('an active genome opens on its assembly metadata, and nothing heavier', () => {
  const targets = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()], {
    activeGenomeKeys: [ENSEMBL_KEY],
  })
  const open = defaultExpandedAnalysisSections(targets)

  assert.ok(open.has(ENSEMBL_KEY), 'an active genome should be open')
  assert.ok(open.has(targets[0].metadata_section.id), 'metadata should be open')
  assert.ok(!open.has(targets[0].assembly_section.id), 'the genome analysis stays shut')
  assert.ok(!open.has(targets[0].geneSets[0].id), 'gene sets stay shut')
})

test('a genome still in the list but deactivated stays shut', () => {
  const targets = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()], {
    activeGenomeKeys: [ENSEMBL_KEY],
  })
  assert.equal(targets[1].isActive, false)
  const open = defaultExpandedAnalysisSections(targets)
  assert.ok(!open.has(REFSEQ_KEY))
  assert.ok(!open.has(targets[1].metadata_section.id))
})

test('opening any genome reveals its assembly metadata', () => {
  const targets = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()], {
    activeGenomeKeys: [ENSEMBL_KEY],
  })
  assert.deepEqual(sectionIdsForOpenGenome(targets[1]), [targets[1].metadata_section.id])
})

test('colours are assigned by position among the active genomes', () => {
  // The same index the configuration view assigns genome colours by, so a pill
  // here matches the genome's tracks in the browser.
  const targets = buildGenomeAnalysisTargets([ensemblHuman(), refseqHuman()], {
    activeGenomeKeys: [REFSEQ_KEY, ENSEMBL_KEY],
  })
  assert.equal(targets[0].colorIndex, 1)
  assert.equal(targets[1].colorIndex, 0)
})

test('with no activation tracked, every genome counts as active', () => {
  const targets = buildGenomeAnalysisTargets([refseqHuman(), ensemblHuman()])
  assert.deepEqual(targets.map((t) => t.isActive), [true, true])
  assert.deepEqual(targets.map((t) => t.colorIndex), [0, 1])
})
