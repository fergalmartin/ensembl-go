import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENE_FOOTER_CONTROL_TOP_OFFSET,
  GENE_FOOTER_LABEL_BASELINE_OFFSET,
  geneFooterTrackOverflow,
  intersectsRuler,
  TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
  buildGeneLabelCandidate,
  getGeneFooterGeometry,
  getTranscriptBoundaryTrails,
  getTranscriptFooterControlState,
  placeGeneFooterWithinViewport,
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
  // trackY 36 + padding 16 + midOffset 13 = 65, the mid-line of the only row.
  assert.equal(candidate.y, 65 + GENE_FOOTER_LABEL_BASELINE_OFFSET)
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
  // baseGeneY 20 + 2 pitches of 42 + midOffset 13 = 117, the third row's mid-line.
  assert.equal(footer.labelY, 117 + GENE_FOOTER_LABEL_BASELINE_OFFSET)
  assert.equal(footer.controlY, 117 + GENE_FOOTER_CONTROL_TOP_OFFSET)
})

// The label is drawn with an alphabetic baseline, so its capitals reach
// GENE_FOOTER_LABEL_CAP_ASCENT_PX above that baseline. The exon block on the
// row's mid-line reaches EXON_HEIGHT / 2 below it. Those two must not meet.
test('the gene symbol clears the bottom of the exon block above it', () => {
  const EXON_HALF_HEIGHT = 6
  const CAP_ASCENT = 8 // 11px Lato capitals, measured on a canvas

  const footer = getGeneFooterGeometry({
    gene: { id: 'gene-1', start: 100, end: 500, strand: '+' },
    txs: [{ id: 'tx-1' }],
    getEffectiveTranscriptLimit: () => 1,
    genomicToScreen: (pos) => pos,
    baseGeneY: 20,
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
    lhsWidth: 48,
    viewWidth: 800,
  })

  const rowMidY = 20 + 13
  const blockBottom = rowMidY + EXON_HALF_HEIGHT
  const labelCapTop = footer.labelY - CAP_ASCENT
  assert.ok(
    labelCapTop >= blockBottom + 1,
    `label caps start at ${labelCapTop}, block ends at ${blockBottom}`,
  )

  // ...and the descenders still clear the transcript-count control below.
  const LABEL_DESCENT = 3
  assert.ok(footer.labelY + LABEL_DESCENT <= footer.controlY)
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
  assert.equal(withOneHidden.controlY, 75 + GENE_FOOTER_CONTROL_TOP_OFFSET)

  // A ghost row pushes the footer down by one pitch, past the previewed row.
  const withGhost = getGeneFooterGeometry({ ...args, visibleTranscriptCount: 4 })
  assert.equal(withGhost.controlY, 159 + GENE_FOOTER_CONTROL_TOP_OFFSET)

  // Nonsense overrides fall back to the limit rather than collapsing the footer.
  for (const bad of [0, -2, null, undefined, NaN]) {
    assert.equal(
      getGeneFooterGeometry({ ...args, visibleTranscriptCount: bad }).visibleTranscriptCount,
      3
    )
  }
})

// The footer hangs off the last drawn row, so every offset it reports moves as
// rows are shown or hidden. The head of the gene does not — anything marking it
// (the note bubble does) has to stay put while the rows behind it change.
test('the top of the gene is where row zero starts, whatever the rows below do', () => {
  const args = {
    gene: { id: 'gene-1', start: 100, end: 500, strand: '+' },
    txs: [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }],
    getEffectiveTranscriptLimit: () => 3,
    genomicToScreen: (pos) => pos,
    baseGeneY: 20,
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13, exonHeight: 12 },
    lhsWidth: 48,
    viewWidth: 800,
  }

  const footer = getGeneFooterGeometry(args)
  // baseGeneY 20 + midOffset 13 = 33, the first row's mid-line; the block above
  // it reaches half an exon height further up.
  assert.equal(footer.firstTranscriptMidY, 33)
  assert.equal(footer.topY, 33 - 6)

  for (const visibleTranscriptCount of [1, 2, 3, 5]) {
    const other = getGeneFooterGeometry({ ...args, visibleTranscriptCount })
    assert.equal(other.topY, footer.topY, `topY moved at ${visibleTranscriptCount} rows`)
    assert.equal(other.firstTranscriptMidY, footer.firstTranscriptMidY)
  }

  // The footer, by contrast, is expected to travel.
  assert.ok(getGeneFooterGeometry({ ...args, visibleTranscriptCount: 5 }).controlY > footer.controlY)
})

test('a gene laid out without an exon height still reports a usable top', () => {
  const footer = getGeneFooterGeometry({
    gene: { id: 'gene-1', start: 100, end: 500, strand: '+' },
    txs: [{ id: 'tx-1' }],
    getEffectiveTranscriptLimit: () => 1,
    genomicToScreen: (pos) => pos,
    baseGeneY: 20,
    transcriptLayoutMetrics: { rowPitch: 42, midOffset: 13 },
    lhsWidth: 48,
    viewWidth: 800,
  })

  assert.equal(footer.topY, 33)
  assert.ok(Number.isFinite(footer.topY))
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

test('an expanded gene footer follows the visible bottom until its natural position arrives', () => {
  const footer = {
    topY: 40,
    labelY: 296,
    controlY: 300,
  }

  const firstViewport = placeGeneFooterWithinViewport(footer, { top: 0, bottom: 150 })
  assert.equal(firstViewport.controlY, 122)
  assert.equal(firstViewport.labelY, 118)
  assert.equal(firstViewport.naturalControlY, 300)
  assert.equal(firstViewport.isViewportPinned, true)

  const scrolledViewport = placeGeneFooterWithinViewport(footer, { top: 100, bottom: 250 })
  assert.equal(scrolledViewport.controlY, 222)
  assert.equal(scrolledViewport.labelY, 218)
  assert.equal(scrolledViewport.isViewportPinned, true)

  const footerReached = placeGeneFooterWithinViewport(footer, { top: 200, bottom: 400 })
  assert.equal(footerReached, footer)
})

test('an expanded footer does not appear before its first transcript enters the viewport', () => {
  const footer = {
    topY: 200,
    labelY: 496,
    controlY: 500,
  }

  assert.equal(
    placeGeneFooterWithinViewport(footer, { top: 0, bottom: 180 }),
    footer,
  )
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

test('an expanded gene\'s label and X clear the transcript they sit under', () => {
  // The expanded footer is one row — the gene symbol, then the control — placed by
  // subtracting EXPANDED_FOOTER_LABEL_TOP_OFFSET from the label baseline. At ten that put
  // its top exactly on the bottom of the last exon block, so the row sat flush against the
  // transcript it belongs to; six leaves a visible gap without moving it off the gene.
  const EXON_HALF_HEIGHT = 6
  const EXPANDED_FOOTER_LABEL_TOP_OFFSET = 6 // GenomeBrowser.jsx
  const metrics = { rowPitch: 32, rowGap: 2, midOffset: 8, exonHeight: 12 }

  const footer = getGeneFooterGeometry({
    gene: { id: 'gene-1', start: 100, end: 900, strand: '-' },
    txs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    visibleTranscriptCount: 3,
    genomicToScreen: (pos) => pos,
    baseGeneY: 40,
    transcriptLayoutMetrics: metrics,
    lhsWidth: 48,
    viewWidth: 800,
  })

  const blockBottom = footer.lastTranscriptMidY + EXON_HALF_HEIGHT
  const rowTop = footer.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET
  assert.ok(rowTop > blockBottom, `the footer row starts at ${rowTop}, the block ends at ${blockBottom}`)
  assert.ok(rowTop - blockBottom <= 6, 'a slight gap, not a step away from the gene')

  // And the row still fits in the height the track reserves for it, or Flatten would clip
  // the very controls it now keeps.
  const lastRowBottom = 40 + (3 * metrics.rowPitch) - metrics.rowGap
  assert.ok(
    rowTop + TRANSCRIPT_FOOTER_CONTROL_HEIGHT <= lastRowBottom + geneFooterTrackOverflow(metrics, true),
    'the footer row overflows the room the track reserves below the last transcript',
  )
})

test('a track reserves the room its footer actually needs, in either layout', () => {
  // The offsets are absolute pixels tuned for the ordinary 42px row pitch. A flattened
  // track's pitch is 18, so one fixed reserve cannot be right for both — twelve was
  // generous for the first and six short for the second, and a compact panel puts the
  // ruler flush against the last track, so those six pixels landed on it.
  const normal = { rowPitch: 42, rowGap: 2, exonHeight: 12, trackPadding: 16, midOffset: 13 }
  const flattened = { rowPitch: 18, rowGap: 2, exonHeight: 12, trackPadding: 2, midOffset: 8 }

  for (const [metrics, flat] of [[normal, false], [flattened, true]]) {
    const reserve = geneFooterTrackOverflow(metrics, flat)
    for (const rows of [1, 3, 5]) {
      const footer = getGeneFooterGeometry({
        gene: { id: 'g', start: 100, end: 900, strand: '+' },
        txs: Array.from({ length: rows + 1 }, (_, index) => ({ id: `t${index}` })),
        visibleTranscriptCount: rows,
        genomicToScreen: (pos) => pos,
        baseGeneY: metrics.trackPadding,
        transcriptLayoutMetrics: metrics,
        lhsWidth: 0,
        viewWidth: 800,
      })
      const geneHeight = flat ? (rows * metrics.rowPitch) - metrics.rowGap : rows * metrics.rowPitch
      const trackBottom = metrics.trackPadding + geneHeight + reserve
      // The collapsed control is the deeper of the footer's two forms.
      const footerBottom = footer.controlY + TRANSCRIPT_FOOTER_CONTROL_HEIGHT
      assert.ok(
        footerBottom <= trackBottom,
        `${flat ? 'flattened' : 'normal'} ${rows}-row footer ends at ${footerBottom}, track at ${trackBottom}`,
      )
    }
  }
})

test('nothing belonging to a track is drawn into the ruler band', () => {
  // The backstop for the arithmetic above. It has several inputs, and being wrong about
  // one of them should cost a hidden label rather than a ruler drawn through a gene symbol.
  assert.equal(intersectsRuler(100, 116, 120, 24), false, 'clear above the ruler')
  assert.equal(intersectsRuler(150, 166, 120, 24), false, 'clear below the ruler')
  assert.equal(intersectsRuler(118, 134, 120, 24), true, 'overlapping its top edge')
  assert.equal(intersectsRuler(130, 146, 120, 24), true, 'starting inside it')
  // Touching the edge is not overlapping it.
  assert.equal(intersectsRuler(104, 120, 120, 24), false)
  assert.equal(intersectsRuler(144, 160, 120, 24), false)
  // A collapsed ruler has no band to intrude on.
  assert.equal(intersectsRuler(118, 134, 120, 0), false)
})
