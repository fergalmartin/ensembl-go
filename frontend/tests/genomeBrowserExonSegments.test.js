import assert from 'node:assert/strict'
import test from 'node:test'

import { getTranscriptExonSegments } from '../src/components/genomeBrowserExonSegments.js'

test('a plain non-coding exon draws as one outlined segment', () => {
  assert.deepEqual(
    getTranscriptExonSegments({ exonStart: 100, exonEnd: 200, cdsList: [] }),
    [{ start: 100, end: 200, coding: false }]
  )
})

test('a fully coding exon draws as one filled segment', () => {
  assert.deepEqual(
    getTranscriptExonSegments({
      exonStart: 119380705,
      exonEnd: 119380711,
      cdsList: [{ start: 119380705, end: 119380711 }],
    }),
    [{ start: 119380705, end: 119380711, coding: true }]
  )
})

// Segments are inclusive and must tile the exon exactly: no base may be dropped
// between segments, and no base may belong to two of them.
test('a partly coding exon splits into UTR and CDS segments that tile it exactly', () => {
  assert.deepEqual(
    getTranscriptExonSegments({ exonStart: 100, exonEnd: 300, cdsList: [{ start: 150, end: 250 }] }),
    [
      { start: 100, end: 149, coding: false },
      { start: 150, end: 250, coding: true },
      { start: 251, end: 300, coding: false },
    ]
  )
})

test('segments cover every base of the exon exactly once', () => {
  const cases = [
    { exonStart: 100, exonEnd: 300, cdsList: [{ start: 150, end: 250 }] },
    { exonStart: 100, exonEnd: 300, cdsList: [{ start: 100, end: 300 }] },
    { exonStart: 100, exonEnd: 300, cdsList: [{ start: 100, end: 150 }] },
    { exonStart: 100, exonEnd: 300, cdsList: [{ start: 250, end: 300 }] },
    { exonStart: 42, exonEnd: 42, cdsList: [] },
    { exonStart: 42, exonEnd: 42, cdsList: [{ start: 42, end: 42 }] },
  ]
  for (const c of cases) {
    const segments = getTranscriptExonSegments(c)
    const covered = []
    for (const seg of segments) {
      for (let bp = seg.start; bp <= seg.end; bp += 1) covered.push(bp)
    }
    const expected = []
    for (let bp = c.exonStart; bp <= c.exonEnd; bp += 1) expected.push(bp)
    assert.deepEqual(covered, expected, `exon ${c.exonStart}-${c.exonEnd} must tile exactly`)
  }
})

test('CDS blocks belonging to other exons are ignored', () => {
  assert.deepEqual(
    getTranscriptExonSegments({ exonStart: 100, exonEnd: 200, cdsList: [{ start: 5000, end: 6000 }] }),
    [{ start: 100, end: 200, coding: false }]
  )
})

// Regression: Helixer-style annotations open many transcripts with a 1bp 5' UTR
// exon. Coordinates are inclusive, so those arrive as start === end. Treating
// them as empty dropped the 5' exon entirely and left a bare intron line running
// to the transcript start.
test('a single-base non-coding exon still produces a drawable segment', () => {
  assert.deepEqual(
    getTranscriptExonSegments({ exonStart: 119362375, exonEnd: 119362375, cdsList: [] }),
    [{ start: 119362375, end: 119362375, coding: false }]
  )
})

test('a single-base coding exon is drawn as coding, not as UTR', () => {
  assert.deepEqual(
    getTranscriptExonSegments({
      exonStart: 119385299,
      exonEnd: 119385299,
      cdsList: [{ start: 119385299, end: 119385299 }],
    }),
    [{ start: 119385299, end: 119385299, coding: true }]
  )
})

test('single-base exons are kept whichever strand the transcript is on', () => {
  // Strand never reaches this helper: coordinates are always genomic ascending,
  // so a 1bp 5' exon on the reverse strand is the same shape as on the forward.
  const reverseFivePrime = getTranscriptExonSegments({ exonStart: 42, exonEnd: 42, cdsList: [] })
  assert.equal(reverseFivePrime.length, 1)
  assert.equal(reverseFivePrime[0].coding, false)
})

test('unusable exons are rejected', () => {
  assert.deepEqual(getTranscriptExonSegments({ exonStart: 200, exonEnd: 100, cdsList: [] }), [])
  assert.deepEqual(getTranscriptExonSegments({ exonStart: NaN, exonEnd: 100, cdsList: [] }), [])
  assert.deepEqual(getTranscriptExonSegments({ exonStart: 100, exonEnd: undefined, cdsList: [] }), [])
})

test('malformed CDS entries do not break segmentation', () => {
  assert.deepEqual(
    getTranscriptExonSegments({
      exonStart: 100,
      exonEnd: 300,
      cdsList: [null, { start: 'x', end: 5 }, { start: 150, end: 250 }],
    }),
    [
      { start: 100, end: 149, coding: false },
      { start: 150, end: 250, coding: true },
      { start: 251, end: 300, coding: false },
    ]
  )
})
