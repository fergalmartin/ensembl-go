import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildGeneLabelCandidate,
  getGeneFooterGeometry,
  getTranscriptBoundaryTrails,
  getTranscriptFooterControlState,
  placeNonOverlappingGeneLabels,
} from '../src/components/genomeBrowserLabelLayout.js'

test('placeNonOverlappingGeneLabels suppresses colliding labels', () => {
  const placed = placeNonOverlappingGeneLabels([
    { text: 'A', x: 100, y: 20, left: 80, right: 120, top: 10, bottom: 25, order: 0 },
    { text: 'B', x: 110, y: 20, left: 90, right: 130, top: 10, bottom: 25, order: 1 },
    { text: 'C', x: 170, y: 20, left: 150, right: 190, top: 10, bottom: 25, order: 2 },
  ])

  assert.deepEqual(placed.map((label) => label.text), ['A', 'C'])
})

test('placeNonOverlappingGeneLabels lets a selected label win a collision', () => {
  const placed = placeNonOverlappingGeneLabels([
    { text: 'first', x: 100, y: 20, left: 80, right: 120, top: 10, bottom: 25, order: 0, priority: 0 },
    { text: 'selected', x: 108, y: 20, left: 88, right: 128, top: 10, bottom: 25, order: 1, priority: 1 },
  ])

  assert.deepEqual(placed.map((label) => label.text), ['selected'])
})

test('buildGeneLabelCandidate left-aligns the name beneath the visible transcript set', () => {
  const gene = { id: 'gene-1', name: 'GENE1', start: 100, end: 300, strand: '+', _row: 0 }
  const txs = [
    { id: 'tx-1', start: 100, end: 300 },
    { id: 'tx-2', start: 140, end: 180, is_canonical: true },
  ]

  const candidate = buildGeneLabelCandidate({
    gene,
    trackId: 'forward',
    trackY: 36,
    layout: { fwdPadding: 16, revPadding: 16 },
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
    selectedGene: null,
    dimNonSelectedGenes: true,
    isLight: false,
    colors: { geneLabelText: '#c1c2c5' },
    genomicToScreen: (pos) => pos,
    viewWidth: 500,
    txs,
    getEffectiveTranscriptLimit: () => 1,
    measureTextWidth: (text) => text.length * 6,
    lhsWidth: 48,
    order: 0,
  })

  assert.equal(candidate.text, 'GENE1')
  assert.equal(candidate.x, 100)
  assert.equal(candidate.y, 79)
  assert.equal(candidate.textAlign, 'left')
})

test('gene footer moves beneath the last visible transcript when expanded', () => {
  const gene = { id: 'gene-1', start: 100, end: 500, strand: '-' }
  const txs = [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }]
  const footer = getGeneFooterGeometry({
    gene,
    txs,
    getEffectiveTranscriptLimit: () => 3,
    genomicToScreen: (pos) => pos,
    baseGeneY: 20,
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
    lhsWidth: 48,
    viewWidth: 800,
  })

  assert.equal(footer.x, 100)
  assert.equal(footer.visibleTranscriptCount, 3)
  assert.equal(footer.labelY, 131)
  assert.equal(footer.controlY, 135)
})

// Hiding transcripts and hover ghosts change how many rows are actually drawn,
// which the transcript limit alone can't express. The caller passes the real
// count so the footer stays pinned under the last drawn row.
test('an explicit visible count overrides the one derived from the transcript limit', () => {
  const args = {
    gene: { id: 'gene-1', start: 100, end: 500, strand: '+' },
    txs: [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }],
    getEffectiveTranscriptLimit: () => 3,
    genomicToScreen: (pos) => pos,
    baseGeneY: 20,
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
    lhsWidth: 48,
    viewWidth: 800,
  }

  const withOneHidden = getGeneFooterGeometry({ ...args, visibleTranscriptCount: 2 })
  assert.equal(withOneHidden.visibleTranscriptCount, 2)
  assert.equal(withOneHidden.controlY, 93)

  // A ghost row pushes the footer down by one pitch, past the previewed row.
  const withGhost = getGeneFooterGeometry({ ...args, visibleTranscriptCount: 4 })
  assert.equal(withGhost.controlY, 177)

  // Nonsense overrides fall back to the limit rather than collapsing the footer.
  for (const bad of [0, -2, null, undefined, NaN]) {
    assert.equal(
      getGeneFooterGeometry({ ...args, visibleTranscriptCount: bad }).visibleTranscriptCount,
      3
    )
  }
})

test('gene footer uses the visual left edge for either strand and flipped views', () => {
  for (const strand of ['+', '-']) {
    const normal = getGeneFooterGeometry({
      gene: { id: 'gene-1', start: 100, end: 500, strand },
      txs: [{ id: 'tx-1' }],
      getEffectiveTranscriptLimit: () => 1,
      genomicToScreen: (pos) => pos * 2,
      baseGeneY: 0,
      transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
      lhsWidth: 48,
      viewWidth: 1200,
    })
    const flipped = getGeneFooterGeometry({
      gene: { id: 'gene-1', start: 100, end: 500, strand },
      txs: [{ id: 'tx-1' }],
      getEffectiveTranscriptLimit: () => 1,
      genomicToScreen: (pos) => 600 - pos,
      baseGeneY: 0,
      transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
      lhsWidth: 48,
      viewWidth: 1200,
    })

    assert.equal(normal.x, 200)
    assert.equal(flipped.x, 100)
  }
})

test('transcript footer control expands all transcripts and closes with X', () => {
  assert.deepEqual(getTranscriptFooterControlState(8, 1), {
    action: 'expandAll',
    label: '+7',
    title: 'Show 7 additional transcripts',
  })
  assert.deepEqual(getTranscriptFooterControlState(8, 8), {
    action: 'collapse',
    label: 'X',
    title: 'Collapse transcript list',
  })
  assert.equal(getTranscriptFooterControlState(1, 1), null)
})

test('transcript boundary trails cover both missing gene-edge spans', () => {
  const gene = { start: 100, end: 500 }
  const transcript = { start: 150, end: 400 }

  assert.deepEqual(getTranscriptBoundaryTrails(gene, transcript, (pos) => pos), [
    { x1: 100, x2: 150, boundaryX: 100 },
    { x1: 400, x2: 500, boundaryX: 500 },
  ])
  assert.deepEqual(getTranscriptBoundaryTrails(gene, transcript, (pos) => 600 - pos), [
    { x1: 100, x2: 200, boundaryX: 100 },
    { x1: 450, x2: 500, boundaryX: 500 },
  ])
})
