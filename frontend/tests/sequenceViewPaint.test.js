import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SELECT_BOTTOM,
  SELECT_LEFT,
  SELECT_NONE,
  SELECT_RIGHT,
  SELECT_TOP,
  paintDisplayRow,
  selectionMask,
} from '../src/utils/sequenceViewPaint.js'
import { buildDisplayLayout, displayRow } from '../src/utils/sequenceViewDisplay.js'
import { BASES_PER_ROW as W } from '../src/utils/sequenceViewRows.js'
import { CLASS_CODES, CLASS_GAP, CLASS_NONE, classesForLevel } from '../src/utils/sequenceViewPalette.js'
import { PLACEHOLDER_BASE, SEQUENCE_VIEW_CHUNK_BP } from '../src/utils/sequenceViewChunks.js'

// A reader over one made-up chromosome, chunked exactly as the buffer chunks it.
function genomeReader(sequence) {
  return (index) => {
    const from = index * SEQUENCE_VIEW_CHUNK_BP
    if (from >= sequence.length) return null
    return sequence.slice(from, from + SEQUENCE_VIEW_CHUNK_BP)
  }
}

const CYCLE = 'ACGT'
const GENOME = CYCLE.repeat(3000)          // 12,000 bases: base N is CYCLE[(N-1) % 4]
const read = genomeReader(GENOME)
const baseAt = (coord) => CYCLE[(coord - 1) % 4]

// The switches a level draws with, all on -- what the view hands each record.
const allowedFor = (level) => new Set(classesForLevel(level).keys())

test('an uncollapsed row is the bases it covers, in order', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const painted = paintDisplayRow(displayRow(layout, 0), { readSequence: read })
  assert.equal(painted.sequence.length, 60)
  assert.equal(painted.sequence, Array.from({ length: 60 }, (_, i) => baseAt(i + 1)).join(''))
  assert.equal(painted.classes, CLASS_NONE.repeat(60))
  assert.equal(painted.mask, SELECT_NONE.repeat(60))
})

test('every string a row draws is exactly the row length', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 95 }, { s: 8900, e: 9000 }],
    collapse: true,
  })
  for (let i = 0; i < layout.totalRows; i += 1) {
    const row = displayRow(layout, i)
    const painted = paintDisplayRow(row, { readSequence: read })
    for (const key of ['sequence', 'classes', 'mask', 'edges']) {
      assert.equal(painted[key].length, row.length, `${key} on row ${i}`)
    }
  }
})

test('a collapsed row reads bases, then the marker, then bases again', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 10 }, { s: 8991, e: 9000 }],
    collapse: true,
  })
  const painted = paintDisplayRow(displayRow(layout, 0), { readSequence: read })
  const marker = layout.items[1].text
  assert.equal(painted.sequence.slice(0, 10), Array.from({ length: 10 }, (_, i) => baseAt(i + 1)).join(''))
  assert.equal(painted.sequence.slice(10, 10 + marker.length), marker)
  assert.equal(
    painted.sequence.slice(10 + marker.length, 10 + marker.length + 10),
    Array.from({ length: 10 }, (_, i) => baseAt(8991 + i)).join(''),
  )
  // The marker's cells are not annotation and must never be mistaken for it.
  assert.equal(painted.classes.slice(10, 10 + marker.length), CLASS_GAP.repeat(marker.length))
})

test('bases keep their classes across a collapse', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 10 }, { s: 8991, e: 9000 }],
    collapse: true,
  })
  const runs = [
    { s: 1, e: 10, c: 'utr5' },
    { s: 11, e: 8990, c: 'intron' },
    { s: 8991, e: 9000, c: 'utr3' },
  ]
  const painted = paintDisplayRow(displayRow(layout, 0), { readSequence: read, runs })
  assert.equal(painted.classes.slice(0, 10), CLASS_CODES.utr5.repeat(10))
  const after = layout.items[2].col0
  assert.equal(painted.classes.slice(after, after + 10), CLASS_CODES.utr3.repeat(10))
  // The intron is what was collapsed, so none of it is painted anywhere.
  assert.ok(!painted.classes.includes(CLASS_CODES.intron))
})

test('a base with no chunk behind it is a placeholder, not a short row', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const painted = paintDisplayRow(displayRow(layout, 0), { readSequence: () => null })
  assert.equal(painted.sequence, PLACEHOLDER_BASE.repeat(60))
  assert.equal(painted.sequence.length, 60)
})

test('a reverse row is complemented and read from the far end', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 120 }, reverse: true })
  const painted = paintDisplayRow(displayRow(layout, 0), { readSequence: read, reverse: true })
  const complement = { A: 'T', C: 'G', G: 'C', T: 'A' }
  assert.equal(painted.sequence[0], complement[baseAt(120)])
  assert.equal(painted.sequence[59], complement[baseAt(61)])
})

// -- what a dragged rectangle actually selects --------------------------------
//
// Written against selectionMask, which is where the shape is decided. `row` is
// only ever asked for its first column and how long it is.
const at = (col0, length = W) => ({ col0, length })
const selected = (mask) => [...mask].map((c) => (c === SELECT_NONE ? '.' : '#')).join('')

test('a selection inside one row covers the bases between the two points', () => {
  const mask = selectionMask(at(0), { lo: 10, hi: 19 }, W, W)
  assert.equal(selected(mask), `${'.'.repeat(10)}${'#'.repeat(10)}${'.'.repeat(40)}`)
})

test('dragging down takes the click base and the rest of its row', () => {
  // Row 0 is where the drag began, at column 20; row 1 is crossed entirely;
  // row 2 holds the release, at column 130 -- so 10 bases in.
  const first = selectionMask(at(0), { lo: 20, hi: 130 }, W, W)
  assert.equal(selected(first), `${'.'.repeat(20)}${'#'.repeat(40)}`)

  const middle = selectionMask(at(W), { lo: 20, hi: 130 }, W, W)
  assert.equal(selected(middle), '#'.repeat(W), 'a row dragged across is taken whole')

  const last = selectionMask(at(2 * W), { lo: 20, hi: 130 }, W, W)
  assert.equal(selected(last), `${'#'.repeat(11)}${'.'.repeat(49)}`,
    'the release base and everything before it on that row')
})

test('dragging up takes the click base and the start of its row', () => {
  // The same two points, whichever way round they were drawn: a range has no
  // memory of its direction, which is what makes dragging up the mirror image.
  const up = selectionMask(at(0), { lo: 130, hi: 20 }, W, W)
  const down = selectionMask(at(0), { lo: 20, hi: 130 }, W, W)
  assert.equal(up, down)

  // Released on row 0 at column 20 having begun on row 2 at column 130: row 2
  // keeps the click base and everything to its left.
  const anchorRow = selectionMask(at(2 * W), { lo: 130, hi: 20 }, W, W)
  assert.equal(selected(anchorRow), `${'#'.repeat(11)}${'.'.repeat(49)}`)
})

test('a row outside the selection is left alone', () => {
  assert.equal(selected(selectionMask(at(10 * W), { lo: 20, hi: 130 }, W, W)), '.'.repeat(W))
  assert.equal(selectionMask(at(0), null, W, W), SELECT_NONE.repeat(W))
})

test('the outline runs round the region, not round each row', () => {
  const sides = (mask, i) => (mask[i] === SELECT_NONE ? 0 : parseInt(mask[i], 16))
  const middle = selectionMask(at(W), { lo: 20, hi: 130 }, W, W)
  // Where the row above is selected too there is no horizontal rule, which is
  // what keeps a multi-row selection one shape rather than a stack of boxes.
  for (let i = 20; i < W; i += 1) {
    assert.equal(sides(middle, i) & SELECT_TOP, 0, `top edge inside the region at ${i}`)
  }
  // But the drag began at column 20, so the twenty columns before it on the row
  // above are not selected -- and the region's top runs along them. That step
  // is the staircase a reader expects of selected text.
  for (let i = 0; i < 20; i += 1) {
    assert.equal(sides(middle, i) & SELECT_TOP, SELECT_TOP, `missing step at ${i}`)
  }
  const first = selectionMask(at(0), { lo: 20, hi: 130 }, W, W)
  assert.equal(sides(first, 20) & SELECT_TOP, SELECT_TOP)
  assert.equal(sides(first, 20) & SELECT_LEFT, SELECT_LEFT, 'the drag started here')
  assert.equal(sides(first, 59) & SELECT_RIGHT, SELECT_RIGHT, 'a row always ends in an edge')
  assert.equal(sides(first, 59) & SELECT_BOTTOM, 0, 'the row below continues it')
})

test('both ends of every row carry an edge, because the region turns there', () => {
  const middle = selectionMask(at(W), { lo: 20, hi: 130 }, W, W)
  const sides = (i) => parseInt(middle[i], 16)
  assert.equal(sides(0) & SELECT_LEFT, SELECT_LEFT)
  assert.equal(sides(W - 1) & SELECT_RIGHT, SELECT_RIGHT)
  assert.equal(sides(30) & SELECT_LEFT, 0, 'nothing inside the run is an end')
  assert.equal(sides(30) & SELECT_RIGHT, 0)
})

test('a single-base selection is closed on all four sides', () => {
  const mask = selectionMask(at(0), { lo: 5, hi: 5 }, W, W)
  assert.equal(parseInt(mask[5], 16), SELECT_TOP | SELECT_RIGHT | SELECT_BOTTOM | SELECT_LEFT)
})

test('a short final row still ends in an edge', () => {
  // Twenty columns, and the selection runs past what the row holds.
  const mask = selectionMask(at(0, 20), { lo: 0, hi: 500 }, 20, W)
  assert.equal(parseInt(mask[19], 16) & SELECT_RIGHT, SELECT_RIGHT)
})

test('a selection that spans a collapse takes the marker with it', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 9000 },
    keep: [{ s: 1, e: 10 }, { s: 8991, e: 9000 }],
    collapse: true,
  })
  const row = displayRow(layout, 0)
  const marker = layout.items[1]
  // The marker's columns are inside the range, so they come along -- the reader
  // dragged across it, and breaking the highlight in two would read as two
  // selections rather than one that spans a collapse.
  const across = paintDisplayRow(row, {
    readSequence: read,
    selection: { lo: 4, hi: marker.col0 + marker.cols + 2 },
  })
  assert.equal(
    selected(across.mask.slice(marker.col0, marker.col0 + marker.cols)),
    '#'.repeat(marker.cols),
  )
  // Stopping before the gap leaves the marker alone.
  const upTo = paintDisplayRow(row, { readSequence: read, selection: { lo: 4, hi: 7 } })
  assert.equal(
    selected(upTo.mask.slice(marker.col0, marker.col0 + marker.cols)),
    '.'.repeat(marker.cols),
  )
})

test('a gene edge lands on the base it belongs to', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const painted = paintDisplayRow(displayRow(layout, 0), {
    readSequence: read,
    genes: [{ id: 'G', s: 5, e: 40 }],
  })
  assert.equal(painted.edges[4], '1', "the gene's first base")
  assert.equal(painted.edges[39], '2', 'its last')
  assert.equal(painted.edges.replace(/[12]/g, '').replace(/0/g, ''), '')
})

test('a class the reader has switched off is not painted', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const runs = [{ s: 1, e: 60, c: 'intron' }]
  const on = paintDisplayRow(displayRow(layout, 0), { readSequence: read, runs })
  assert.equal(on.classes, CLASS_CODES.intron.repeat(60))
  const off = paintDisplayRow(displayRow(layout, 0), {
    readSequence: read, runs, allowed: new Set(),
  })
  assert.equal(off.classes, CLASS_NONE.repeat(60))
})

test('a row made only of marker draws the marker and no bases', () => {
  const layout = buildDisplayLayout({
    region: { start: 1, end: 1_000_000 },
    keep: [{ s: 1, e: 47 }],
    collapse: true,
  })
  const row = [...Array(layout.totalRows).keys()]
    .map((i) => displayRow(layout, i))
    .find((candidate) => candidate.pieces.length === 0)
  assert.ok(row, 'expected a row made only of marker')
  const painted = paintDisplayRow(row, { readSequence: read })
  assert.equal(painted.classes, CLASS_GAP.repeat(row.length))
  assert.ok(!painted.sequence.includes(PLACEHOLDER_BASE))
})

test('a row with nothing in it paints nothing rather than throwing', () => {
  assert.deepEqual(
    paintDisplayRow(null, {}),
    { sequence: '', classes: '', mask: '', edges: '', amino: '' },
  )
})

test('a record is drawn through its own level’s switches, not the focus’s', () => {
  // The bug this pins: a record was painted with the switches of the level in
  // focus rather than its own. A transcript ticked off a gene says `cds` and
  // `utr5`, which the levels above have no word for, so every run was dropped
  // and the record read as bare sequence.
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const row = displayRow(layout, 0)
  // As the backend emits them: class names, resolved to codes while painting.
  const runs = [
    { s: 1, e: 30, c: 'cds' },
    { s: 31, e: 60, c: 'utr5' },
  ]
  const asTranscript = paintDisplayRow(row, {
    readSequence: read, runs, allowed: allowedFor('transcript'),
  })
  assert.equal(asTranscript.classes, CLASS_CODES.cds.repeat(30) + CLASS_CODES.utr5.repeat(30))

  const asLocation = paintDisplayRow(row, {
    readSequence: read, runs, allowed: allowedFor('location'),
  })
  assert.equal(asLocation.classes, CLASS_NONE.repeat(60), 'nothing a location can say')
})

test('the levels do not all speak the same vocabulary', () => {
  // Which is why the switches have to travel with the runs. A location and a
  // gene now share most of theirs -- that is the point of drawing a location in
  // the gene classes -- but a transcript's codons and splice sites exist at no
  // other level, and a location's coarse `genic` exists at no other.
  const codes = (level) => new Set(classesForLevel(level).keys())
  const location = codes('location')
  const gene = codes('gene')
  for (const code of gene) {
    assert.ok(location.has(code), `a location can say ${code}, as a gene does`)
  }
  const transcriptOnly = [...codes('transcript')].filter((code) => !gene.has(code))
  assert.ok(transcriptOnly.length > 0, 'a transcript says things a gene cannot')
  assert.equal(gene.has(CLASS_CODES.genic), false, 'genic is the location’s alone')
})

test('the base a box is about is ringed, and only that one', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const row = displayRow(layout, 0)
  const painted = paintDisplayRow(row, {
    readSequence: read,
    runs: [{ s: 1, e: 60, c: 'coding' }],
    marked: 12,
  })
  assert.equal(painted.classes, CLASS_CODES.coding.repeat(60), 'the colour is untouched')
  assert.equal(painted.edges[11], '8')
  assert.equal(painted.edges.replace(/[08]/g, ''), '')
  // A base on another row is not this row's business.
  assert.equal(paintDisplayRow(displayRow(layout, 1), { readSequence: read, marked: 12 }).edges,
    '0'.repeat(60))
})

test('a marked base keeps the other marks on it', () => {
  // A base can be the one asked about, the first base of a gene, and shared by
  // two genes at once. Bits, so none of the three displaces another.
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const painted = paintDisplayRow(displayRow(layout, 0), {
    readSequence: read,
    genes: [{ id: 'G', s: 12, e: 400 }],
    overlaps: [{ s: 10, e: 20, n: 2 }],
    marked: 12,
  })
  assert.equal(painted.edges[11], 'd', 'marked + overlap + gene start')
})

test('an overlap is drawn under the bases, not instead of their colour', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  const row = displayRow(layout, 0)
  const painted = paintDisplayRow(row, {
    readSequence: read,
    runs: [{ s: 1, e: 60, c: 'coding' }],
    overlaps: [{ s: 10, e: 20, n: 2 }],
  })
  // The class is untouched: two genes sharing a base does not make it less
  // coding.
  assert.equal(painted.classes, CLASS_CODES.coding.repeat(60))
  assert.equal(painted.edges.slice(9, 20), '4'.repeat(11))
  assert.equal(painted.edges[8], '0')
  assert.equal(painted.edges[20], '0')
})
