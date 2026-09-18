import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COLLAPSE_MIN_HIDDEN,
  buildDisplayLayout,
  collapseKeeps,
  subtractIntervals,
  columnAtCoord,
  coordAtColumn,
  coordIntervalsForRows,
  displayRow,
  displayRowsForRange,
  gapMarkerText,
  groupDigits,
  keepsWithFlank,
  mergeIntervals,
  rowAtCoord,
} from '../src/utils/sequenceViewDisplay.js'
import { BASES_PER_ROW } from '../src/utils/sequenceViewRows.js'

const W = BASES_PER_ROW

test('digits are grouped without asking the host what locale it is', () => {
  assert.equal(groupDigits(0), '0')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(1000), '1,000')
  assert.equal(groupDigits(12345), '12,345')
  assert.equal(groupDigits(248956422), '248,956,422')
})

test('intervals merge when they overlap and when they merely touch', () => {
  assert.deepEqual(mergeIntervals([{ s: 10, e: 20 }, { s: 15, e: 25 }]), [{ s: 10, e: 25 }])
  // Touching leaves no gap between them, so keeping them apart would invent one.
  assert.deepEqual(mergeIntervals([{ s: 10, e: 20 }, { s: 21, e: 30 }]), [{ s: 10, e: 30 }])
  assert.deepEqual(mergeIntervals([{ s: 10, e: 20 }, { s: 22, e: 30 }]),
    [{ s: 10, e: 20 }, { s: 22, e: 30 }])
  assert.deepEqual(mergeIntervals([{ s: 30, e: 40 }, { s: 1, e: 5 }]),
    [{ s: 1, e: 5 }, { s: 30, e: 40 }])
  assert.deepEqual(mergeIntervals([]), [])
})

test('the flank widens what is kept and is clipped to the region', () => {
  const region = { start: 1, end: 1000 }
  assert.deepEqual(keepsWithFlank([{ s: 500, e: 600 }], 25, region), [{ s: 475, e: 625 }])
  // Never outside the region, however wide the flank.
  assert.deepEqual(keepsWithFlank([{ s: 10, e: 20 }], 100, region), [{ s: 1, e: 120 }])
  assert.deepEqual(keepsWithFlank([{ s: 980, e: 990 }], 100, region), [{ s: 880, e: 1000 }])
  // Widening can make two stretches meet, and then they are one.
  assert.deepEqual(keepsWithFlank([{ s: 100, e: 110 }, { s: 150, e: 160 }], 25, region),
    [{ s: 75, e: 185 }])
})

test('full mode is one stretch covering the region, and no gaps', () => {
  const layout = buildDisplayLayout({ region: { start: 1001, end: 1600 } })
  assert.equal(layout.items.length, 1)
  assert.equal(layout.items[0].kind, 'seq')
  assert.equal(layout.totalCols, 600)
  assert.equal(layout.totalRows, 10)
  assert.equal(layout.hidden, 0)
  assert.equal(layout.gaps, 0)
})

test('full mode draws exactly the rows the plain arithmetic would', () => {
  const region = { start: 1001, end: 1630 }
  const layout = buildDisplayLayout({ region })
  assert.equal(layout.totalRows, Math.ceil(630 / W))
  const first = displayRow(layout, 0)
  assert.deepEqual(first.pieces, [{ at: 0, len: 60, s: 1001, e: 1060 }])
  assert.equal(first.firstCoord, 1001)
  assert.equal(first.lastCoord, 1060)
  // The last row is short whenever the region is not a multiple of sixty.
  const last = displayRow(layout, layout.totalRows - 1)
  assert.equal(last.length, 630 % W)
  assert.equal(last.lastCoord, 1630)
  assert.equal(displayRow(layout, layout.totalRows), null)
})

test('a collapse replaces the dull stretch with a marker and keeps the rest', () => {
  // Two exons of 100 with a 5,000 base intron between them.
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    flank: 0,
    collapse: true,
  })
  assert.deepEqual(layout.items.map((item) => item.kind), ['seq', 'gap', 'seq'])
  assert.equal(layout.hidden, 5000)
  assert.equal(layout.kept, 200)
  const gap = layout.items[1]
  assert.equal(gap.hidden, 5000)
  assert.match(gap.text, /^<-+ 5,000 bp -+>$/)
  assert.equal(gap.cols, gap.text.length)
  assert.equal(layout.totalCols, 200 + gap.cols)
})

test('the flank is what keeps a collapsed intron readable at its edges', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    flank: 25,
    collapse: true,
  })
  const [left, gap, right] = layout.items
  assert.deepEqual([left.s, left.e], [1, 125])
  assert.deepEqual([right.s, right.e], [5076, 5200])
  assert.equal(gap.hidden, 5200 - 125 - (5200 - 5076 + 1) - 100 + 100)
  assert.equal(gap.s, 126)
  assert.equal(gap.e, 5075)
  assert.equal(gap.hidden, 4950)
})

test('a stretch too short to be worth a marker is simply drawn', () => {
  const short = COLLAPSE_MIN_HIDDEN - 1
  const layout = buildDisplayLayout({
    region: { start: 1, end: 100 + short + 100 },
    keep: [{ s: 1, e: 100 }, { s: 101 + short, e: 100 + short + 100 }],
    collapse: true,
  })
  // One continuous stretch: collapsing would have made the row longer, not
  // shorter, and would have broken up a run of bases to save nothing.
  assert.equal(layout.gaps, 0)
  assert.equal(layout.items.length, 1)
  assert.equal(layout.hidden, 0)
  assert.equal(layout.totalCols, 100 + short + 100)
})

test('a gap label never straddles a row edge', () => {
  // Every starting column in a row, with a label long enough to be at risk.
  for (let col0 = 0; col0 < W; col0 += 1) {
    const text = gapMarkerText(123456, col0, W)
    const label = '123,456 bp'
    const at = text.indexOf(label)
    assert.ok(at > 0, `label missing for col0=${col0}`)
    const labelStart = col0 + at
    const labelEnd = labelStart + label.length - 1
    assert.equal(
      Math.floor(labelStart / W), Math.floor(labelEnd / W),
      `label split across rows for col0=${col0}: cols ${labelStart}-${labelEnd}`,
    )
  }
})

test('a label is pushed onto the next row by lengthening the dashes before it', () => {
  // Column 49 puts the label's first character at 55 with the usual dashes, so
  // the last five of its ten characters would fall into the next row.
  const text = gapMarkerText(123456, 49, W)
  const plain = gapMarkerText(123456, 0, W)
  assert.ok(text.length > plain.length, 'expected padding to have been added')
  // Padding goes on the left only: the dashes after the label stay as they were.
  assert.equal(text.split(' ').pop(), plain.split(' ').pop())
  // And the label now begins exactly where the next row does.
  assert.equal(49 + text.indexOf('123,456 bp'), W)
})

test('a gap marker reads as the shape it is meant to have', () => {
  assert.equal(gapMarkerText(12345, 0, W), '<---- 12,345 bp ---->')
})

test('a column maps to the coordinate it draws, and a marker maps to none', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    collapse: true,
  })
  assert.equal(coordAtColumn(layout, 0), 1)
  assert.equal(coordAtColumn(layout, 99), 100)
  assert.equal(coordAtColumn(layout, 100), null)
  const afterGap = layout.items[2].col0
  assert.equal(coordAtColumn(layout, afterGap), 5101)
  assert.equal(coordAtColumn(layout, layout.totalCols - 1), 5200)
  assert.equal(coordAtColumn(layout, layout.totalCols), null)
  assert.equal(coordAtColumn(layout, -1), null)
})

test('a coordinate maps back to the column that draws it', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    collapse: true,
  })
  for (const coord of [1, 50, 100, 5101, 5150, 5200]) {
    assert.equal(coordAtColumn(layout, columnAtCoord(layout, coord)), coord)
  }
})

test('a hidden coordinate answers with the nearest place it could be drawn', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    collapse: true,
  })
  // Inside the collapsed stretch: the start of the next stretch drawn.
  assert.equal(coordAtColumn(layout, columnAtCoord(layout, 3000)), 5101)
  // Before anything: the first base drawn.
  assert.equal(coordAtColumn(layout, columnAtCoord(layout, -500)), 1)
})

test('rows are found for coordinates on either side of a collapse', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 100000 },
    keep: [{ s: 1, e: 600 }, { s: 99401, e: 100000 }],
    collapse: true,
  })
  assert.equal(rowAtCoord(layout, 1), 0)
  assert.equal(rowAtCoord(layout, 61), 1)
  assert.equal(rowAtCoord(layout, 600), 9)
  // The second stretch begins in the row the marker ended in, not ten rows on.
  const at = rowAtCoord(layout, 99401)
  assert.ok(at >= 10 && at <= 11, `expected the row just after the marker, got ${at}`)
})

test('a reverse layout reads from the far end, and back again', () => {
  const layout = buildDisplayLayout({ region: { start: 1001, end: 1120 }, reverse: true })
  assert.equal(layout.totalRows, 2)
  const first = displayRow(layout, 0)
  assert.equal(first.firstCoord, 1120)
  assert.equal(first.lastCoord, 1061)
  assert.deepEqual(first.pieces, [{ at: 0, len: 60, s: 1061, e: 1120 }])
  assert.equal(coordAtColumn(layout, 0), 1120)
  assert.equal(coordAtColumn(layout, 59), 1061)
  assert.equal(coordAtColumn(layout, 60), 1060)
  for (const coord of [1001, 1060, 1061, 1120]) {
    assert.equal(coordAtColumn(layout, columnAtCoord(layout, coord)), coord)
  }
})

test('a reverse layout collapses from the far end too', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 5200 },
    keep: [{ s: 1, e: 100 }, { s: 5101, e: 5200 }],
    collapse: true,
    reverse: true,
  })
  // Read 5' to 3' on the minus strand: the high stretch is drawn first.
  assert.deepEqual(layout.items.map((item) => item.kind), ['seq', 'gap', 'seq'])
  assert.deepEqual([layout.items[0].s, layout.items[0].e], [5101, 5200])
  assert.equal(coordAtColumn(layout, 0), 5200)
  assert.equal(coordAtColumn(layout, 99), 5101)
  assert.equal(coordAtColumn(layout, layout.totalCols - 1), 1)
  for (const coord of [1, 100, 5101, 5200]) {
    assert.equal(coordAtColumn(layout, columnAtCoord(layout, coord)), coord)
  }
})

test('a row covers its columns exactly, between sequence and marker', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 95 }, { s: 8900, e: 9000 }],
    collapse: true,
  })
  for (let i = 0; i < layout.totalRows; i += 1) {
    const row = displayRow(layout, i)
    const covered = row.pieces.reduce((n, p) => n + p.len, 0)
      + row.marks.reduce((n, m) => n + m.len, 0)
    assert.equal(covered, row.length, `row ${i} covers ${covered} of ${row.length}`)
    // And nothing overlaps: every column is claimed exactly once.
    const claimed = new Set()
    for (const part of [...row.pieces, ...row.marks]) {
      for (let c = part.at; c < part.at + part.len; c += 1) {
        assert.ok(!claimed.has(c), `column ${c} claimed twice in row ${i}`)
        claimed.add(c)
      }
    }
  }
})

test('every drawn column of a collapsed layout maps to a distinct coordinate', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 95 }, { s: 4000, e: 4100 }, { s: 8900, e: 9000 }],
    collapse: true,
  })
  const seen = new Set()
  let previous = 0
  for (let c = 0; c < layout.totalCols; c += 1) {
    const coord = coordAtColumn(layout, c)
    if (coord === null) continue
    assert.ok(!seen.has(coord), `coordinate ${coord} drawn twice`)
    assert.ok(coord > previous, `coordinates went backwards at column ${c}`)
    seen.add(coord)
    previous = coord
  }
  assert.equal(seen.size, layout.kept)
})

test('a row knows the genomic stretches it needs sequence for', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 100000 },
    keep: [{ s: 1, e: 30 }, { s: 99971, e: 100000 }],
    collapse: true,
  })
  const rows = displayRowsForRange(layout, 0, layout.totalRows)
  const intervals = coordIntervalsForRows(rows)
  // Two stretches a hundred kilobases apart -- not one interval spanning both,
  // which is what asking for everything between them would fetch.
  assert.deepEqual(intervals, [{ s: 1, e: 30 }, { s: 99971, e: 100000 }])
})

test('the gutters are blank for a row that is nothing but a marker', () => {
  // A marker pushed hard enough to the right spills a whole row's worth of
  // dashes into the next row, which then draws no base at all.
  const layout = buildDisplayLayout({
    region: { start: 1, end: 1_000_000 },
    keep: [{ s: 1, e: 47 }],
    collapse: true,
  })
  assert.equal(displayRow(layout, 0).firstCoord, 1)
  const rows = displayRowsForRange(layout, 0, layout.totalRows)
  const markerOnly = rows.find((row) => row.pieces.length === 0)
  assert.ok(markerOnly, 'expected a row made only of marker')
  assert.equal(markerOnly.marks.length, 1)
  assert.equal(markerOnly.firstCoord, null)
  assert.equal(markerOnly.lastCoord, null)
})

test('nothing kept at all still leaves a layout that can be drawn', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 5000 }, keep: [], collapse: true })
  assert.equal(layout.items.length, 1)
  assert.equal(layout.items[0].kind, 'gap')
  assert.equal(layout.hidden, 5000)
  assert.equal(layout.kept, 0)
  assert.equal(rowAtCoord(layout, 2500), null)
})

test('a region that makes no sense has no layout', () => {
  assert.equal(buildDisplayLayout({ region: null }), null)
  assert.equal(buildDisplayLayout({ region: { start: 100, end: 1 } }), null)
  assert.equal(displayRow(null, 0), null)
  assert.deepEqual(displayRowsForRange(null, 0, 5), [])
})


// ---- the two kinds of collapse ---------------------------------------------
//
// The switches are separate, and each carries its own flank and its own floor.
// Everything below is the subtraction those two lists are put through:
// intergenic is the region minus the genes, intronic is the genes minus their
// exons, and what is kept is the region minus whatever survived both.

const GENES = [{ s: 1001, e: 3000 }]
const EXONS = [{ s: 1001, e: 1100 }, { s: 2901, e: 3000 }]
const REGION = { start: 1, end: 4000 }
const setting = (on, flank = 0, min = 1) => ({ on, flank, min })

test('subtraction leaves what the holes did not cover', () => {
  assert.deepEqual(subtractIntervals([{ s: 1, e: 100 }], [{ s: 30, e: 40 }]),
    [{ s: 1, e: 29 }, { s: 41, e: 100 }])
  assert.deepEqual(subtractIntervals([{ s: 1, e: 100 }], [{ s: 1, e: 100 }]), [])
  assert.deepEqual(subtractIntervals([{ s: 1, e: 100 }], []), [{ s: 1, e: 100 }])
  // A hole reaching past both ends takes the whole span with it.
  assert.deepEqual(subtractIntervals([{ s: 10, e: 20 }], [{ s: 1, e: 100 }]), [])
})

test('each kind can be collapsed without the other', () => {
  const between = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    settings: { intergenic: setting(true), intron: setting(false) },
  })
  assert.deepEqual(between.keep, [{ s: 1001, e: 3000 }], 'the genes, whole')
  assert.deepEqual(between.collapses, ['intergenic'])

  const inside = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    settings: { intergenic: setting(false), intron: setting(true) },
  })
  // Everything but the intron: the sequence outside the gene is still drawn.
  assert.deepEqual(inside.keep, [{ s: 1, e: 1100 }, { s: 2901, e: 4000 }])
  assert.deepEqual(inside.collapses, ['intron'])
})

test('both at once keeps the exons and nothing else', () => {
  const both = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    settings: { intergenic: setting(true), intron: setting(true) },
  })
  assert.deepEqual(both.keep, EXONS)
  assert.deepEqual(both.collapses, ['intergenic', 'intron'])
})

test('neither switched on keeps the whole region and says nothing was collapsed', () => {
  const none = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    settings: { intergenic: setting(false), intron: setting(false) },
  })
  assert.deepEqual(none.keep, [{ s: 1, e: 4000 }])
  assert.deepEqual(none.collapses, [])
})

test('a flank is kept at each end of what is hidden, kind by kind', () => {
  const answer = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    // Different flanks, so that one cannot be standing in for the other.
    settings: { intergenic: setting(true, 50), intron: setting(true, 100) },
  })
  // Intergenic runs 1-1000 and 3001-4000, each shrunk by 50; the intron runs
  // 1101-2900, shrunk by 100. What is kept is everything else.
  assert.deepEqual(answer.keep, [
    { s: 1, e: 50 },
    { s: 951, e: 1200 },
    { s: 2801, e: 3050 },
    { s: 3951, e: 4000 },
  ])
})

test('a stretch shorter than its own floor is left alone', () => {
  const answer = collapseKeeps({
    region: { start: 1, end: 4000 },
    genic: GENES,
    exonic: EXONS,
    // The intron is 1,800 bases and the intergenic stretches 1,000 each, so a
    // floor of 1,500 collapses the first and leaves the others drawn.
    settings: { intergenic: setting(true, 0, 1500), intron: setting(true, 0, 1500) },
  })
  assert.deepEqual(answer.keep, [{ s: 1, e: 1100 }, { s: 2901, e: 4000 }])
  assert.deepEqual(answer.collapses, ['intron'],
    'and it says only what it actually did')
})

test('a flank wider than the stretch collapses nothing there', () => {
  const answer = collapseKeeps({
    region: REGION,
    genic: GENES,
    exonic: EXONS,
    settings: { intergenic: setting(false), intron: setting(true, 2000) },
  })
  assert.deepEqual(answer.keep, [{ s: 1, e: 4000 }])
  assert.deepEqual(answer.collapses, [])
})

test('a region with no genes in it is intergenic throughout', () => {
  const answer = collapseKeeps({
    region: { start: 1, end: 4000 },
    genic: [],
    exonic: [],
    settings: { intergenic: setting(true), intron: setting(true) },
  })
  assert.deepEqual(answer.keep, [])
  assert.deepEqual(answer.collapses, ['intergenic'])
})
