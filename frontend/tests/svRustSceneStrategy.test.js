import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alignmentRequestWindow,
  alignedInitialTargetCandidate,
  shouldIncludeTranscriptExons,
  shouldLoadCanonicalTranscripts,
  shouldNormalizeInitialTargetWindow,
  transcriptRequestWindow,
} from '../src/utils/svRustSceneStrategy.js'

const reference = { chrom: '11', start: 49_573_169, end: 50_143_547 }

test('canonical transcripts load at every scale while exon detail remains gene-scale', () => {
  assert.equal(shouldLoadCanonicalTranscripts(reference), true)
  assert.equal(shouldLoadCanonicalTranscripts({ chrom: '11', start: 24_921_904, end: 74_921_904 }), true)
  assert.equal(shouldIncludeTranscriptExons(reference), true)
  assert.equal(shouldIncludeTranscriptExons({ chrom: '11', start: 24_921_904, end: 74_921_904 }), false)
})

test('alignment requests include the regular view halo and clamp to chromosome bounds', () => {
  assert.deepEqual(alignmentRequestWindow({ chrom: '11', start: 100_000, end: 200_000, chrom_length: 250_000 }), {
    chrom: '11', start: 1, end: 250_000, chrom_length: 250_000,
  })
  assert.deepEqual(alignmentRequestWindow({ chrom: '11', start: 1_000_000, end: 3_000_000 }), {
    chrom: '11', start: 1, end: 4_194_304,
  })
})

test('nearby pans reuse the same alignment coverage tile', () => {
  const first = alignmentRequestWindow({ chrom: '11', start: 10_000_000, end: 11_000_000 })
  const panned = alignmentRequestWindow({ chrom: '11', start: 10_010_000, end: 11_010_000 })
  assert.deepEqual(panned, first)
})

test('broad transcript requests use one stable chromosome cache window', () => {
  assert.deepEqual(transcriptRequestWindow({ chrom: '11', start: 20_000_000, end: 40_000_000, chrom_length: 135_086_622 }), {
    chrom: '11', start: 1, end: 135_086_622, chrom_length: 135_086_622,
  })
})

test('initial target normalization detects the pathological screenshot spans', () => {
  assert.equal(shouldNormalizeInitialTargetWindow(reference, {
    chrom: '11', start: 49_264_867, end: 51_609_295,
  }), true)
  assert.equal(shouldNormalizeInitialTargetWindow(reference, {
    chrom: '11', start: 24_921_904, end: 74_921_904,
  }), true)
  assert.equal(shouldNormalizeInitialTargetWindow(reference, {
    chrom: '11', start: 49_500_000, end: 50_100_000,
  }), false)
})

test('initial target normalization preserves reference scale and follows mapped blocks', () => {
  const target = { chrom: '11', start: 1, end: 50_000_001, chrom_length: 100_000_000 }
  const candidate = alignedInitialTargetCandidate({
    tgt_chrom: '11',
    tgt_chrom_length: 100_000_000,
    blocks: [
      { ref_start: 49_600_000, ref_end: 49_700_000, tgt_start: 30_000_000, tgt_end: 30_100_000 },
      { ref_start: 49_800_000, ref_end: 49_900_000, tgt_start: 30_200_000, tgt_end: 30_300_000 },
      { ref_start: 10, ref_end: 20, tgt_start: 90_000_000, tgt_end: 90_100_000 },
    ],
  }, reference, target)

  assert.equal(candidate.end - candidate.start, reference.end - reference.start)
  assert.equal((candidate.start + candidate.end) / 2, 30_150_000)
})
