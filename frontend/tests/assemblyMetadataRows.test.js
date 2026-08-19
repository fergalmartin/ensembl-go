import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAssemblyMetadataRows,
  equivalentAccessionNote,
  formatMetadataBases,
  formatMetadataInt,
  hasAssemblyMetadata,
} from '../src/utils/assemblyMetadataRows.js'

const labelsOf = (rows) => rows.map((row) => row.label)
const valueOf = (rows, label) => rows.find((row) => row.label === label)?.value

test('registry fields win over the genome record they fall back to', () => {
  const rows = buildAssemblyMetadataRows({
    genome: { assembly: 'GCA_000001405.29', assembly_name: 'GRCh38.p14', scientific_name: 'Homo sapiens' },
    assemblyInfo: {
      ena: {
        status: 'ready',
        data: {
          assembly_name: 'GRCh38.p14 (registry)',
          accession: 'GCA_000001405.29',
          scientific_name: 'Homo sapiens (registry)',
        },
      },
    },
  })
  assert.equal(valueOf(rows, 'Assembly'), 'GRCh38.p14 (registry)')
  assert.equal(valueOf(rows, 'Species'), 'Homo sapiens (registry)')
})

test('the genome record fills in what the registry does not carry', () => {
  const rows = buildAssemblyMetadataRows({
    genome: { assembly: 'GCA_000001405.29', assembly_name: 'GRCh38.p14', scientific_name: 'Homo sapiens' },
    assemblyInfo: { ena: { status: 'ready', data: {} } },
  })
  assert.equal(valueOf(rows, 'Assembly'), 'GRCh38.p14')
  assert.equal(valueOf(rows, 'Accession'), 'GCA_000001405.29')
  assert.equal(valueOf(rows, 'Species'), 'Homo sapiens')
})

test('accession falls back to the GCA when no assembly is recorded', () => {
  const rows = buildAssemblyMetadataRows({ genome: { gca: 'GCA_009914755.4' }, assemblyInfo: {} })
  assert.equal(valueOf(rows, 'Accession'), 'GCA_009914755.4')
})

test('fasta measurements are preferred over the registry sequence counts', () => {
  const rows = buildAssemblyMetadataRows({
    genome: {},
    assemblyInfo: {
      ena: { status: 'ready', data: { contig_count: 5, sequence_length: 1000 } },
      fasta: { contig_count: 24, total_bases: 3_100_000_000, n50: 145_000_000, l50: 8 },
    },
  })
  assert.equal(valueOf(rows, 'Sequences'), (24).toLocaleString())
  assert.equal(valueOf(rows, 'Total bases'), '3.10 Gb')
  assert.equal(valueOf(rows, 'N50'), '145.00 Mb')
  assert.equal(valueOf(rows, 'L50'), (8).toLocaleString())
})

test('fields with nothing behind them are dropped, not blanked', () => {
  const rows = buildAssemblyMetadataRows({ genome: {}, assemblyInfo: {} })
  assert.ok(!labelsOf(rows).includes('Level'))
  assert.ok(!labelsOf(rows).includes('Submitter'))
  assert.ok(!labelsOf(rows).includes('Chromosomes'))
  assert.ok(!labelsOf(rows).includes('L50'))
  assert.ok(!labelsOf(rows).includes('Last updated'))
})

test('a measurement that was looked for and missing still reports as an em dash', () => {
  const rows = buildAssemblyMetadataRows({ genome: {}, assemblyInfo: {} })
  assert.equal(valueOf(rows, 'Total bases'), '—')
  assert.equal(valueOf(rows, 'Sequences'), '—')
})

test('rows keep the order the stats view lists them in', () => {
  const rows = buildAssemblyMetadataRows({
    genome: { assembly: 'GCA_1', assembly_name: 'A1', scientific_name: 'Species one' },
    assemblyInfo: {
      ena: { status: 'ready', data: { assembly_level: 'chromosome', tax_id: 9606 } },
      fasta: { contig_count: 3 },
    },
  })
  const labels = labelsOf(rows)
  assert.deepEqual(
    labels.filter((label) => ['Assembly', 'Accession', 'Level', 'Species', 'Taxonomy ID'].includes(label)),
    ['Assembly', 'Accession', 'Level', 'Species', 'Taxonomy ID'],
  )
})

test('values are strings, so the drawer never has to coerce them', () => {
  const rows = buildAssemblyMetadataRows({
    genome: {},
    assemblyInfo: { ena: { status: 'ready', data: { tax_id: 9606 } } },
  })
  assert.equal(valueOf(rows, 'Taxonomy ID'), '9606')
})

test('metadata is available once either the registry or the fasta has answered', () => {
  assert.equal(hasAssemblyMetadata(null), false)
  assert.equal(hasAssemblyMetadata({ ena: { status: 'missing' }, fasta: {} }), false)
  assert.equal(hasAssemblyMetadata({ ena: { status: 'ready' } }), true)
  assert.equal(hasAssemblyMetadata({ ena: { status: 'missing' }, fasta: { n50: 1 } }), true)
})

test('the equivalent-accession note only appears when the registry answered about another assembly', () => {
  assert.equal(equivalentAccessionNote({ ena: { accession: 'GCA_1' } }, 'GCA_1'), '')
  assert.equal(equivalentAccessionNote({ ena: {} }, 'GCA_1'), '')
  assert.match(equivalentAccessionNote({ ena: { accession: 'GCF_2' } }, 'GCA_1'), /GCF_2/)
})

test('base formatting steps through the units', () => {
  assert.equal(formatMetadataBases(0), '—')
  assert.equal(formatMetadataBases(-5), '—')
  assert.equal(formatMetadataBases(900), '900 bp')
  assert.equal(formatMetadataBases(1500), '1.5 kb')
  assert.equal(formatMetadataBases(2_500_000), '2.50 Mb')
  assert.equal(formatMetadataInt('not a number'), '—')
})
