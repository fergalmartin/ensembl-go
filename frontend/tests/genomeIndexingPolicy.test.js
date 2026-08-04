import assert from 'node:assert/strict'
import test from 'node:test'

import {
  primaryGenomeForIndex,
  shouldAutoEnsurePrimaryIndex,
} from '../src/utils/genomeIndexingPolicy.js'

const genome = (name, gff3 = `/data/${name}.gff3`) => ({
  species_key: name,
  files: { gff3 },
})

test('startup and management views never auto-build indexes', () => {
  for (const view of ['home', 'download', 'genome_selector', 'configuration', 'help', 'track_manager']) {
    assert.equal(shouldAutoEnsurePrimaryIndex(view), false, view)
  }
})

test('annotation-driven views may ensure the primary index', () => {
  for (const view of ['genome_browser', 'feature_explorer', 'neighbourhood', 'alignment']) {
    assert.equal(shouldAutoEnsurePrimaryIndex(view), true, view)
  }
})

test('only the configured primary genome is selected for automatic indexing', () => {
  const first = genome('first')
  const primary = genome('primary')
  const secondary = genome('secondary')

  assert.equal(
    primaryGenomeForIndex([first, primary, secondary], primary.files.gff3),
    primary,
  )
})

test('primary selection falls back to the first annotated genome', () => {
  const withoutAnnotation = { species_key: 'fasta_only', files: { fasta: '/data/a.fa' } }
  const firstAnnotated = genome('first_annotated')
  const secondAnnotated = genome('second_annotated')

  assert.equal(
    primaryGenomeForIndex([withoutAnnotation, firstAnnotated, secondAnnotated], '/missing.gff3'),
    firstAnnotated,
  )
  assert.equal(primaryGenomeForIndex([withoutAnnotation], ''), null)
})
