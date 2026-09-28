import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeExonCoverage,
  exonCoverageProfile,
  mergeInclusiveIntervals,
} from '../src/utils/exonCoverage.js'

const tx = (id, start, end, exons, cds = []) => ({
  id,
  start,
  end,
  exons: exons.map(([s, e]) => ({ start: s, end: e })),
  cds_list: cds.map(([s, e]) => ({ start: s, end: e })),
})

test('runs tile the active span and count transcripts per base', () => {
  const { runs, stats } = computeExonCoverage([
    tx('a', 100, 400, [[100, 199], [300, 400]]),
    tx('b', 150, 400, [[150, 199], [350, 400]]),
  ], 3)

  assert.deepEqual(runs.map(({ start, end, count }) => [start, end, count]), [
    [100, 149, 1],
    [150, 199, 2],
    [200, 299, 0],
    [300, 349, 1],
    [350, 400, 2],
  ])
  assert.equal(stats.activeCount, 2)
  assert.equal(stats.totalCount, 3)
  assert.equal(stats.spanLength, 301)
  assert.equal(stats.coveredBases, 201)
  assert.equal(stats.uncoveredBases, 100)
  assert.equal(stats.exonicBlocks, 2)
  assert.equal(stats.maxCount, 2)
  assert.equal(stats.constitutiveBases, 101)
  assert.equal(stats.uniqueBases, 100)
  // (100*1 + 101*2) / 201 transcripts per covered base
  assert.equal(stats.meanTranscriptsPerCoveredBase, 302 / 201)
  assert.equal(stats.meanCoverageFraction, 302 / (201 * 2))
})

test('abutting exons in different transcripts form one exonic block', () => {
  const { runs, stats } = computeExonCoverage([
    tx('a', 1, 10, [[1, 5]]),
    tx('b', 1, 10, [[6, 10]]),
  ])
  assert.deepEqual(runs.map(({ start, end, count }) => [start, end, count]), [[1, 10, 1]])
  assert.equal(stats.exonicBlocks, 1)
  assert.equal(stats.uncoveredBases, 0)
})

test('overlapping exons within one transcript count that transcript once', () => {
  const { runs } = computeExonCoverage([tx('a', 1, 20, [[1, 10], [5, 20]])])
  assert.deepEqual(runs.map(({ count }) => count), [1])
})

test('the profile slices the span and scores each slice by its exonic bases', () => {
  const coverage = computeExonCoverage([
    tx('a', 1, 40, [[1, 10], [31, 40]]),
    tx('b', 1, 40, [[1, 5], [31, 40]]),
  ], 2)
  const forward = exonCoverageProfile(coverage, '+', 4)
  assert.deepEqual(forward.map(({ start, end }) => [start, end]), [[1, 10], [11, 20], [21, 30], [31, 40]])
  assert.deepEqual(forward.map((bin) => bin.exonicBases), [10, 0, 0, 10])
  // Bases 1-5 are in both transcripts, 6-10 in one: (5*2 + 5*1) / (10 * 2)
  assert.deepEqual(forward.map((bin) => bin.meanCoverageFraction), [0.75, null, null, 1])

  const reverse = exonCoverageProfile(coverage, '-', 4)
  assert.deepEqual(reverse.map(({ start }) => start), [31, 21, 11, 1])
})

test('profile slices of an uneven span tile it exactly, one base at most per slice', () => {
  const coverage = computeExonCoverage([tx('a', 1, 10, [[1, 10]])])
  const bins = exonCoverageProfile(coverage, '+', 4)
  assert.deepEqual(bins.map(({ start, end }) => [start, end]), [[1, 2], [3, 5], [6, 7], [8, 10]])
  assert.equal(exonCoverageProfile(coverage, '+', 80).length, 10)
  assert.deepEqual(exonCoverageProfile(computeExonCoverage([]), '+', 4), [])
})

test('coding bases are the union of CDS across transcripts', () => {
  const { stats } = computeExonCoverage([
    tx('a', 1, 100, [[1, 100]], [[10, 50]]),
    tx('b', 1, 100, [[1, 100]], [[40, 60]]),
  ])
  assert.equal(stats.codingBases, 51)
})

test('no active transcripts gives no runs', () => {
  const { runs, stats } = computeExonCoverage([], 4)
  assert.deepEqual(runs, [])
  assert.equal(stats.activeCount, 0)
  assert.equal(stats.totalCount, 4)
})

test('mergeInclusiveIntervals joins touching intervals', () => {
  assert.deepEqual(mergeInclusiveIntervals([{ start: 5, end: 9 }, { start: 1, end: 4 }, { start: 20, end: 30 }]), [
    { start: 1, end: 9 },
    { start: 20, end: 30 },
  ])
})
