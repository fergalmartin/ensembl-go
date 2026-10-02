import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSvConfigSummary, svConfigValidationFeedback } from '../src/utils/svConfigSummary.js'

const config = {
  genomes: {
    ref: { accession: 'GCA_1', assembly_name: 'Reference' },
    alt: { accession: 'GCA_2', assembly_name: 'Target', tracks: [{ path: '/tracks/shared.bw' }] },
  },
  pairs: [{ alignments: [{
    id: 'first', label: 'First comparison', reference: 'ref', target: 'alt', chain: '/chains/first.bb',
    legacy_mappings: { target_mapping: '/maps/target.tsv' },
    tracks: { alt: [{ path: '/tracks/shared.bw' }, { path: '/tracks/calls.bb' }] },
  }, {
    id: 'second', label: 'Second comparison', reference: 'alt', target: 'ref', chain: '/chains/second.bb',
  }] }],
}
const path = '/config/alignments.cfg'
const catalog = { alignments: [{
  id: 'first', config_path: path, supported: true,
  reference_genome: { accession: 'GCA_1' }, target_genome: { accession: 'GCA_2' },
}] }

test('summaries count directed alignments and distinct genomes and tracks', () => {
  const summary = buildSvConfigSummary(config, { filesChecked: true })
  assert.equal(summary.alignmentCount, 2)
  assert.equal(summary.genomeCount, 2)
  assert.equal(summary.rows[0].trackCount, 2)
  assert.equal(summary.rows[0].reference, 'Reference')
  assert.equal(summary.rows[1].reference, 'Target')
  assert.equal(summary.rows[0].status, 'Files found')
  assert.equal(summary.readyCount, 0)
})

test('catalog readiness reflects local genomes without requiring them to be selected', () => {
  const summary = buildSvConfigSummary(config, {
    catalog, configPath: path, inactiveSpecies: [{ assembly: 'GCA_1' }, { assembly: 'GCA_2' }],
  })
  assert.equal(summary.rows[0].status, 'Ready to select')
  assert.equal(summary.readyCount, 1)
})

test('missing tracks and mapping files override otherwise ready catalog rows', () => {
  const summary = buildSvConfigSummary(config, {
    catalog, configPath: path, activeSpecies: [{ assembly: 'GCA_1' }, { assembly: 'GCA_2' }],
    missingFiles: ['/tracks/calls.bb', '/maps/target.tsv', '/maps/target.tsv'],
  })
  assert.equal(summary.rows[0].status, 'Missing files')
  assert.deepEqual(summary.rows[0].missingFiles, ['/maps/target.tsv', '/tracks/calls.bb'])
  assert.equal(summary.readyCount, 0)
})

test('an alignment from another file does not establish readiness', () => {
  const summary = buildSvConfigSummary(config, {
    catalog, configPath: '/other.cfg', activeSpecies: [{ assembly: 'GCA_1' }, { assembly: 'GCA_2' }],
  })
  assert.equal(summary.rows[0].status, 'Not checked')
})

test('missing genomes are described without claiming the alignment is ready', () => {
  const summary = buildSvConfigSummary(config, { catalog, configPath: path })
  assert.equal(summary.rows[0].status, 'Genomes unavailable')
  assert.equal(summary.readyCount, 0)
})

test('empty configurations have a zero count', () => {
  assert.deepEqual(buildSvConfigSummary(null), { rows: [], alignmentCount: 0, genomeCount: 0, readyCount: 0 })
})

test('validation distinguishes success, missing files and invalid configurations', () => {
  assert.deepEqual(svConfigValidationFeedback({ ok: true, alignment_count: 1, missing_files: [] }), {
    tone: 'success', message: 'Validation passed: 1 alignment. All referenced files were found.',
  })
  assert.deepEqual(svConfigValidationFeedback({ ok: true, alignment_count: 2, missing_files: ['/a', '/a'] }), {
    tone: 'warning', message: 'Validation passed: 2 alignments. 1 referenced file is missing.',
  })
  assert.equal(svConfigValidationFeedback({ ok: false }).tone, 'error')
})
