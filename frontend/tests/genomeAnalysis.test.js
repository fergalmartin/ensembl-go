import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getCurrentGenomeAnalysis,
  withGenomeAnalysis,
  withoutGenomeAnalysis,
} from '../src/utils/genomeAnalysis.js'

test('genome analysis cache is reused only for the same FASTA path', () => {
  const report = { sequence_count: 3 }
  const files = { fasta: '/data/genome.fa.gz' }
  const cache = withGenomeAnalysis({}, 'manual::mouse::v1', 'fasta', files, report, '2026-07-29T12:00:00Z')

  assert.equal(
    getCurrentGenomeAnalysis(cache, 'manual::mouse::v1', 'fasta', files)?.report,
    report,
  )
  assert.equal(
    getCurrentGenomeAnalysis(cache, 'manual::mouse::v1', 'fasta', { fasta: '/data/v2.fa.gz' }),
    null,
  )
})

test('annotation analysis cache includes the FASTA used for cross-checking', () => {
  const report = { counts: { genes: 42 } }
  const files = {
    fasta: '/data/genome.fa.gz',
    gff3: '/data/genes.gff3.gz',
  }
  const cache = withGenomeAnalysis({}, 'ensembl::mouse::GRCm39', 'gff3', files, report)

  assert.equal(
    getCurrentGenomeAnalysis(cache, 'ensembl::mouse::GRCm39', 'gff3', files)?.report,
    report,
  )
  assert.equal(
    getCurrentGenomeAnalysis(cache, 'ensembl::mouse::GRCm39', 'gff3', {
      ...files,
      fasta: '/data/replacement.fa.gz',
    }),
    null,
  )
})

test('removing the final cached report removes the genome cache entry', () => {
  const cache = withGenomeAnalysis(
    {},
    'manual::yeast::v1',
    'fasta',
    { fasta: '/data/yeast.fa' },
    { sequence_count: 16 },
  )

  assert.deepEqual(withoutGenomeAnalysis(cache, 'manual::yeast::v1', 'fasta'), {})
})
