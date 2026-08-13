import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPLEMENTABLE_FEATURE_KEYS,
  SEQUENCE_FEATURE_KEYS,
  getTranscriptFeatureAvailability,
  mergeTranscriptFeatureAvailability,
} from '../src/utils/transcriptSequenceFeatures.js'

// Two exons either side of a CDS that starts inside the first and ends inside
// the second, so both UTRs have to be inferred rather than read off.
const codingTranscript = {
  start: 100,
  end: 500,
  strand: '+',
  exons: [
    { start: 100, end: 200 },
    { start: 400, end: 500 },
  ],
  cds_list: [
    { start: 150, end: 200 },
    { start: 400, end: 450 },
  ],
  utrs: [],
}

const nonCodingTranscript = {
  start: 100,
  end: 500,
  strand: '+',
  exons: [{ start: 100, end: 200 }, { start: 400, end: 500 }],
  cds_list: [],
  utrs: [],
}

test('a coding transcript offers every feature type', () => {
  const available = getTranscriptFeatureAvailability(codingTranscript)
  for (const key of SEQUENCE_FEATURE_KEYS) {
    assert.equal(available[key], true, `${key} should be available`)
  }
})

test('a non-coding transcript offers no CDS, protein or UTRs', () => {
  const available = getTranscriptFeatureAvailability(nonCodingTranscript)
  assert.deepEqual(available, {
    genomic: true,
    transcript: true,
    cds: false,
    protein: false,
    utr5: false,
    utr3: false,
    utr: false,
    exons: true,
    introns: true,
  })
})

test('protein tracks CDS: there is nothing to translate without one', () => {
  assert.equal(getTranscriptFeatureAvailability({ exons: [{ start: 1, end: 9 }], cds_list: [] }).protein, false)
  assert.equal(getTranscriptFeatureAvailability({ exons: [{ start: 1, end: 9 }], cds_list: [{ start: 2, end: 8 }] }).protein, true)
})

test('a single-exon transcript has no introns', () => {
  const available = getTranscriptFeatureAvailability({
    start: 1, end: 90, strand: '+', exons: [{ start: 1, end: 90 }], cds_list: [], utrs: [],
  })
  assert.equal(available.exons, true)
  assert.equal(available.introns, false)
})

test('UTR sides swap on the reverse strand', () => {
  // Exon overhang below the CDS is the 5' end on the forward strand and the
  // 3' end on the reverse.
  const leadingOverhangOnly = {
    start: 100, end: 300, exons: [{ start: 100, end: 300 }], cds_list: [{ start: 150, end: 300 }], utrs: [],
  }
  const forward = getTranscriptFeatureAvailability({ ...leadingOverhangOnly, strand: '+' })
  const reverse = getTranscriptFeatureAvailability({ ...leadingOverhangOnly, strand: '-' })
  assert.deepEqual([forward.utr5, forward.utr3], [true, false])
  assert.deepEqual([reverse.utr5, reverse.utr3], [false, true])
})

test('explicit UTR annotation is honoured without inference', () => {
  const available = getTranscriptFeatureAvailability({
    start: 1, end: 90, strand: '+',
    exons: [{ start: 1, end: 90 }],
    cds_list: [],
    utrs: [{ feature_type: 'five_prime_UTR', start: 1, end: 20 }],
  })
  assert.equal(available.utr5, true)
  assert.equal(available.utr3, false)
})

test('a missing transcript reports nothing available rather than throwing', () => {
  const available = getTranscriptFeatureAvailability(null)
  assert.equal(Object.values(available).some(Boolean), false)
})

test('merging keeps a feature any one transcript can produce', () => {
  const merged = mergeTranscriptFeatureAvailability([nonCodingTranscript, codingTranscript])
  assert.equal(merged.cds, true)
  assert.equal(merged.protein, true)
  assert.equal(merged.utr5, true)
})

test('merging an empty set offers nothing', () => {
  const merged = mergeTranscriptFeatureAvailability([])
  assert.equal(Object.values(merged).some(Boolean), false)
})

test('the two UTR ends collapse into one offered entry', () => {
  // Either end alone is enough to be worth showing; the records come back
  // together, 5' first.
  const fivePrimeOnly = getTranscriptFeatureAvailability({
    start: 100, end: 300, strand: '+',
    exons: [{ start: 100, end: 300 }], cds_list: [{ start: 150, end: 300 }], utrs: [],
  })
  assert.deepEqual([fivePrimeOnly.utr5, fivePrimeOnly.utr3, fivePrimeOnly.utr], [true, false, true])
  assert.equal(getTranscriptFeatureAvailability(nonCodingTranscript).utr, false)
})

test('protein is excluded from the complementable types', () => {
  assert.equal(COMPLEMENTABLE_FEATURE_KEYS.includes('protein'), false)
  assert.equal(COMPLEMENTABLE_FEATURE_KEYS.includes('genomic'), true)
})
