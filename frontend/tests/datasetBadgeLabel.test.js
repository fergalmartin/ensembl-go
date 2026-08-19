// The badge over a genome pill has room for one short fact. For Ensembl that is
// the release, which is dated and worth comparing. For everyone else the release
// is a constant — every RefSeq genome says "current" — so the badge names the
// provider instead, and the release moves to the tooltip.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DATASET_BADGE_MAX_CHARS,
  formatDatasetBadgeLabel,
  truncateBadgeLabel,
} from '../src/utils/genomeIdentity.js'

const ensemblHuman = {
  provider: 'ensembl',
  source_database: 'Ensembl',
  assembly: 'GCA_000001405.29',
  dataset_release_key: 'ensembl/2025_12',
  dataset_release_source: 'ensembl',
  dataset_release_date: '2025_12',
  dataset_release_short_label: '2025-12',
}

const refseqHuman = {
  provider: 'ncbi',
  source_database: 'RefSeq',
  assembly: 'GCF_000001405.40',
  dataset_release_key: 'ncbi/current',
  dataset_release_source: 'ncbi',
  dataset_release_date: 'current',
  dataset_release_short_label: 'current',
}

test('an Ensembl genome keeps its dated release on the badge', () => {
  assert.equal(formatDatasetBadgeLabel(ensemblHuman), '2025-12')
})

test('a RefSeq genome shows the provider instead of "current"', () => {
  assert.equal(formatDatasetBadgeLabel(refseqHuman), 'RefSeq')
})

test('the provider is derived when the record does not carry one', () => {
  const { source_database: _ignored, ...withoutSourceDatabase } = refseqHuman
  assert.equal(formatDatasetBadgeLabel(withoutSourceDatabase), 'RefSeq')
  assert.equal(
    formatDatasetBadgeLabel({ ...withoutSourceDatabase, assembly: 'GCA_000001405.29' }),
    'GenBank',
  )
})

test('a manually added genome names its provider too', () => {
  assert.equal(
    formatDatasetBadgeLabel({ is_manual: true, dataset_release_short_label: 'unknown' }),
    'Manual',
  )
})

test('a long provider name is cut short rather than overflowing the badge', () => {
  const label = formatDatasetBadgeLabel({
    provider: 'some_very_long_provider_name',
    dataset_release_short_label: 'current',
  })
  assert.ok(label.length <= DATASET_BADGE_MAX_CHARS, `badge label too long: ${label}`)
  assert.ok(label.endsWith('…'), `expected an elision marker, got: ${label}`)
  assert.ok(label.startsWith('Some Very'), `expected the start of the name, got: ${label}`)
})

test('a name that fits is left alone', () => {
  assert.equal(truncateBadgeLabel('RefSeq'), 'RefSeq')
  assert.equal(truncateBadgeLabel(''), '')
})

test('an Ensembl genome with a custom annotation still shows the custom release', () => {
  // The provider describes where the assembly came from, so an imported
  // annotation on an Ensembl genome must not be relabelled "Ensembl".
  assert.equal(
    formatDatasetBadgeLabel({
      provider: 'ensembl',
      dataset_release_source: 'custom',
      dataset_release_label: 'custom 2026-03',
      dataset_release_short_label: '',
    }),
    'custom 2026-03',
  )
})
