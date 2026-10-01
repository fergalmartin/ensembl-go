import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CDS, GAP, INTRON, INTRON_CAP_BP, NONE, SPLICE, UTR, boundaryShares, buildTrack, genomicAt, rowClasses, rowRuns,
} from '../src/components/gene-trees/alignmentColumn.js'
import { alignmentGenes } from '../src/components/gene-trees/alignmentGenes.js'
import { alignedCodonStripes, rowCodingColumns } from '../src/utils/codonStripes.js'

// --ACGTAC-GTACGT-- : residues at columns 2–7 and 9–14; a gap at 8 inside the row.
const ROW = {
  aligned: '--ACGTAC-GTACGT--',
  features: [
    { type: 'exon', start: 2, end: 10 },
    { type: 'intron', start: 11, end: 14 },
    { type: 'utr5', start: 2, end: 3 },
    { type: 'cds', start: 4, end: 10 },
    { type: 'donor', start: 11, end: 12 },
    { type: 'intron_cut', start: 12, end: 13, removed_bp: 500 },
  ],
  chrom: '7',
  region: { strand: '+', segments: [{ start: 100, end: 110, offset: 0, length: 11, kind: 'exon' }, { start: 700, end: 709, offset: 11, length: 10, kind: 'intron_edge' }] },
}

test('each column of a row gets its most specific class', () => {
  const { classes, first, last } = rowClasses(ROW, 17)
  assert.equal(first, 2)
  assert.equal(last, 14)
  assert.deepEqual([...classes], [NONE, NONE, UTR, UTR, CDS, CDS, CDS, CDS, GAP, CDS, CDS, SPLICE, SPLICE, INTRON, INTRON, NONE, NONE])
})

test('left-out introns get room in the track: to scale, then capped', () => {
  const short = { ...ROW, features: [...ROW.features.filter(f => f.type !== 'intron_cut'), { type: 'intron_cut', start: 12, end: 13, removed_bp: 120 }] }
  const long = { ...ROW, aligned: ROW.aligned, features: [...ROW.features.filter(f => f.type !== 'intron_cut'), { type: 'intron_cut', start: 11, end: 13, removed_bp: 9000 }] }
  const track = buildTrack([short, long], 17, { intronEdge: 10 })
  // Cuts one column apart share a gap, as wide as the longer one's left-out bases, capped.
  assert.equal(track.sites.length, 1)
  assert.equal(track.sites[0].col, 13)
  assert.equal(track.sites[0].width, INTRON_CAP_BP)
  assert.equal(track.total, 17 + INTRON_CAP_BP)
  assert.equal(track.dispOf(12), 12)
  assert.equal(track.dispOf(13), 13 + INTRON_CAP_BP)
  assert.deepEqual(track.locate(13 + 20), { site: 0, col: 13 })
  assert.deepEqual(track.locate(13 + INTRON_CAP_BP + 1.5), { site: -1, col: 14 })
  assert.equal(track.fromCol(track.toCol(5.5)), 5.5)
  // In Sequence every gap is the same few columns.
  assert.equal(buildTrack([short], 17, { mode: 'sequence' }).sites[0].width, 10)
  assert.equal(buildTrack([short], 17).sites[0].width, 120)
})

test('a row runs along the track as exon pieces, gaps, introns, flanks and its left-out intron', () => {
  const row = { aligned: 'AAAC-CGTTTAGGG', features: [
    { type: 'exon', start: 2, end: 5 }, { type: 'cds', start: 3, end: 5 }, { type: 'utr5', start: 2, end: 2 },
    { type: 'intron', start: 6, end: 9 }, { type: 'intron_cut', start: 7, end: 8, removed_bp: 700 },
    { type: 'exon', start: 10, end: 13 }, { type: 'cds', start: 10, end: 13 },
  ] }
  const track = buildTrack([row], 14)
  const { runs, exons } = rowRuns(row, track, 14)
  assert.deepEqual(runs.map(r => r.kind), ['flank', 'nc', 'cds', 'gap', 'cds', 'intron', 'cut', 'intron', 'cds'])
  assert.equal(exons.length, 2)
  const cut = runs.find(r => r.kind === 'cut')
  assert.equal(cut.d1 - cut.d0, INTRON_CAP_BP)
  assert.equal(cut.cut.bp, 700)
  // The gap inside the first exon belongs to it (hovering it is hovering the exon).
  assert.equal(runs[3].exon, 0)
  assert.equal(runs.find(r => r.kind === 'cds' && r.d0 > cut.d0).d0, 10 + INTRON_CAP_BP)
})

test('splice boundaries are shared when they sit on the same aligned column, give or take', () => {
  const exons = (...spans) => spans.map(([start, end], index) => ({ start, end, index }))
  const a = {}, b = {}, c = {}
  const shares = boundaryShares([
    { row: a, exons: exons([0, 10], [30, 40], [60, 70]) },
    { row: b, exons: exons([2, 11], [31, 45], [60, 70]) },
    { row: c, exons: exons([5, 20], [50, 55]) },
  ])
  // a's first exon ends at 10: b's at 11 counts, c's at 20 does not. Transcript ends never count.
  assert.deepEqual(shares.get(a).end, [1, 0, 0])
  assert.deepEqual(shares.get(a).start, [0, 1, 1])
  assert.deepEqual(shares.get(c).start, [0, 0])
})

test('a column’s genomic position follows the region’s segments, and a gap has none', () => {
  assert.deepEqual(genomicAt(ROW, 2), { chrom: '7', position: 100, kind: 'exon', base: 'A' })
  assert.equal(genomicAt(ROW, 8), null)
  // Column 13 holds residue 10, the last of the first segment; column 14 the first of the second.
  assert.equal(genomicAt(ROW, 13).position, 110)
  assert.equal(genomicAt(ROW, 14).position, 700)
  const minus = { ...ROW, region: { ...ROW.region, strand: '-' } }
  assert.equal(genomicAt(minus, 2).position, 110)
})

test('only leaves linked to a local gene become rows', () => {
  const nodes = [{ id: 0, leaf: null }, { id: 1, leaf: {} }, { id: 2, leaf: {} }, { id: 3, leaf: {} }]
  const links = {
    1: { status: 'linked', assembly: 'GCA_1', gene: { id: 'g1' }, transcript_id: 't1' },
    2: { status: 'genome', assembly: 'GCA_1' },
    3: { status: 'linked', assembly: 'GCA_2', gene: { id: 'g3' } },
  }
  assert.deepEqual([...alignmentGenes(nodes, links)], [
    [1, { assembly: 'GCA_1', gene_id: 'g1', transcript_id: 't1' }],
    [3, { assembly: 'GCA_2', gene_id: 'g3', transcript_id: null }],
  ])
})

test('aligned codons share a shade whatever indels come before them', () => {
  // Row A starts its CDS three bases (one codon) earlier than B: counted per row, A's
  // second codon and B's first — the same columns — would take different shades.
  const a = { sequence: 'ATGAAACCCGGG', coding: Uint8Array.from({ length: 12 }, () => 1), anchor: 0 }
  const b = { sequence: '---ATGCCCGGG', coding: Uint8Array.from({ length: 12 }, (_, i) => (i >= 3 ? 1 : 0)), anchor: 3 }
  const stripes = alignedCodonStripes([a, b, { ...a }], 12)
  assert.deepEqual([...stripes], [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1])
  // A base one row has and the others lack (an out-of-frame insertion) leaves the others'
  // codons whole: each still spans three columns in one shade, alternating.
  const all = Uint8Array.from({ length: 10 }, () => 1)
  const x = { sequence: 'ATG-AAACCC', coding: all, anchor: 0 }
  const ins = { sequence: 'ATGTAAACCC', coding: all, anchor: 0 }
  const s = [...alignedCodonStripes([x, { ...x }, ins], 10)]
  assert.equal(new Set(s.slice(0, 3)).size, 1)
  assert.equal(new Set(s.slice(4, 7)).size, 1)
  assert.equal(new Set(s.slice(7, 10)).size, 1)
  assert.notEqual(s[4], s[7])
})

test('a row\'s coding columns and reading frame come from its features', () => {
  const cds = rowCodingColumns([{ type: 'cds', start: 2, end: 7 }, { type: 'start_codon', start: 2, end: 4 }], 'CCATGAAA', 8)
  assert.deepEqual([...cds.coding], [0, 0, 1, 1, 1, 1, 1, 1])
  assert.equal(cds.anchor, 2)
  assert.equal(rowCodingColumns([{ type: 'exon', start: 0, end: 3 }], 'AAAA', 4), null)
})

test('conservation: each base by how many genes share it, not one colour a column', async () => {
  const { columnConservation, conservationRamp, heatStep, HEAT_STEPS } = await import('../src/components/gene-trees/alignmentColumn.js')
  // Column 0: five A and a G. Column 1: all C. Column 2: a lone base and gaps.
  const rows = ['ACT', 'ACC', 'AC-', 'AC-', 'Ac-', 'GC-'].map(aligned => ({ aligned }))
  const cons = columnConservation(rows, 3)
  assert.equal(cons.shareAt(rows[0], 0), 5 / 6, 'an A agreeing with four others')
  assert.equal(cons.shareAt(rows[5], 0), 1 / 6, 'the G, the odd one out')
  assert.deepEqual(cons.baseAt(rows[5], 0), { count: 1, present: 6 })
  assert.equal(cons.shareAt(rows[4], 1), 1, 'either case counts as the same base')
  // Column 2: two genes, disagreeing; the others have nothing there to count.
  assert.equal(cons.shareAt(rows[0], 2), 0.5)
  assert.equal(cons.shareAt(rows[2], 2), null, 'a gap is not a base')
  assert.equal(columnConservation([{ aligned: 'A' }, { aligned: '-' }], 1).shareAt({ aligned: 'A' }, 0), null, 'one base compares with nothing')
  // A stretch of a row is its bases' mean, so the gene that differs reads cooler.
  assert.equal(cons.rowShare(rows[0], 0, 3), (5 / 6 + 1 + 0.5) / 3)
  assert.equal(cons.rowShare(rows[5], 0, 3), (1 / 6 + 1) / 2)
  assert.equal(cons.rowShare(rows[2], 2, 3), null)
  // The column-wide figure: the commonest base's share.
  assert.equal(cons.identity(0, 1), 5 / 6)
  // A fixed scale: a colour always means the same share.
  assert.equal(heatStep(1), HEAT_STEPS - 1)
  assert.equal(heatStep(0), 0)
  assert.ok(heatStep(5 / 6) > heatStep(0.5) && heatStep(0.5) > heatStep(1 / 6))
  const ramp = conservationRamp()
  assert.equal(ramp.length, HEAT_STEPS)
  assert.equal(ramp[0], '#3b82f6', 'the exon coverage heatmap\u2019s blue')
  assert.equal(ramp[HEAT_STEPS - 1], '#ef4444', '…through to its red')
})

test('zooming out over the strip, once it shows the whole alignment, is handed on to the tree', async () => {
  const { alignmentColumn } = await import('../src/components/gene-trees/alignmentColumn.js')
  const column = alignmentColumn({ data: { id: 'a', length: ROW.aligned.length, consensus: '', rows: new Map([[1, ROW]]), params: {} },
    view: {}, widthPx: 300, isLight: false })
  const env = { layout: { alignX: 0, flipHorizontal: false }, t: { k: 1, x: 0, y: 0 }, width: 1200, insetTop: 0 }
  const over = [150, 50] // on the strip, which starts at the tips' column
  const zoom = factor => column.wheel(env, { type: 'zoom', factor, anchor: 'cursor' }, {}, ...over)
  // At its opening width (the whole alignment), zooming out is not the column's: the tree takes it.
  assert.equal(zoom(1.2), null)
  // Zooming in stretches the strip; zooming back out shrinks it until it is whole again…
  assert.ok(zoom(1 / 1.5))
  assert.ok(zoom(1.2))
  let steps = 0
  while (zoom(1.2) && steps < 50) steps++
  // …and then hands on again.
  assert.equal(zoom(1.2), null)
  // Zoomed in as far as it goes, zooming in stops there rather than zooming the tree.
  for (let i = 0; i < 200; i++) zoom(1 / 1.5)
  assert.deepEqual(zoom(1 / 1.5), { panX: 0 })
})
