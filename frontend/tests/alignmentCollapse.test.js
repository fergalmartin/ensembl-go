import test from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../src/components/alignment-explorer/collapse.js')
const geometry = () => import('../src/components/alignment-explorer/layers.js')

// One block of 100 columns with two stretches nobody on screen has a base in.
const fragment = (collapsed = [[10, 30], [60, 70]]) =>
  ({ id: 'f1', sourceBlock: 1, start: 0, end: 100, x: 0, y: 0, rowIds: ['a', 'b'], collapsed })

test('a fragment with nothing collapsed takes the identity path', async () => {
  const { keptRuns, displaySpan, displayColumn, sourceColumn, columnPieces, collapseJoins } = await load()
  const plain = fragment(null)
  assert.equal(keptRuns(plain), null)
  assert.equal(displaySpan(plain), 100)
  assert.equal(displayColumn(plain, 42), 42)
  assert.equal(sourceColumn(plain, 42), 42)
  assert.deepEqual(columnPieces(plain, 5, 9), [{ start: 5, end: 9, hidden: 0 }])
  assert.deepEqual(collapseJoins(plain), [])
})

test('the drawn panel is narrower by exactly what was collapsed', async () => {
  const { displaySpan, collapsedColumns } = await load()
  assert.equal(displaySpan(fragment()), 70)
  assert.equal(collapsedColumns(fragment()), 30)
})

test('columns map to the panel and back again', async () => {
  const { displayColumn, sourceColumn } = await load()
  const f = fragment()
  for (const column of [0, 9, 30, 45, 59, 70, 99]) {
    assert.equal(sourceColumn(f, displayColumn(f, column)), column, `column ${column}`)
  }
  // The columns either side of a collapse are neighbours on the panel.
  assert.equal(displayColumn(f, 30) - displayColumn(f, 9), 1)
  // A collapsed column has no place of its own and answers with its join.
  assert.equal(displayColumn(f, 20), displayColumn(f, 10))
})

test('a source interval is cut into the pieces actually drawn', async () => {
  const { columnPieces } = await load()
  const f = fragment()
  assert.deepEqual(columnPieces(f, 5, 65), [
    { start: 5, end: 10, hidden: 0 },
    { start: 30, end: 60, hidden: 20 },
  ])
  // An interval wholly inside a collapsed run draws nothing at all.
  assert.deepEqual(columnPieces(f, 12, 18), [])
  // Each piece's own origin places its columns where the map says they go.
  const { displayColumn } = await load()
  for (const piece of columnPieces(f, 0, 100)) {
    assert.equal(piece.start - piece.hidden - f.start, displayColumn(f, piece.start))
  }
})

test('every join says how many columns went and which they were', async () => {
  const { collapseJoins } = await load()
  assert.deepEqual(collapseJoins(fragment()), [
    { offset: 10, columns: 20, start: 10, end: 30 },
    { offset: 40, columns: 10, start: 60, end: 70 },
  ])
})

test('runs are trimmed to the fragment rather than dropped', async () => {
  const { clipRuns } = await load()
  // A run arriving for the whole block overhangs a chunk of it at both ends.
  assert.deepEqual(clipRuns([[0, 40], [90, 200]], 20, 100), [[20, 40], [90, 100]])
  assert.deepEqual(clipRuns([[0, 10]], 20, 100), [])
})

test('collapsing the whole fragment is refused rather than drawn empty', async () => {
  const { keptRuns, displaySpan } = await load()
  const f = fragment([[0, 100]])
  assert.equal(keptRuns(f), null)
  assert.equal(displaySpan(f), 100)
})

test('the painter and the hit test agree about where a column is', async () => {
  const { panelRect, layerXToColumn, columnToLayerX } = await geometry()
  const { displayColumn } = await load()
  const { MARGIN_X } = await import('../src/components/alignment-explorer/layout.js')
  const f = fragment()
  const camera = { x: 0, y: 0, scale: 4, plane: 1 }
  const r = panelRect(f, camera)
  // The panel is drawn at the collapsed width, not the block's.
  assert.ok(Math.abs(r.width - 70 * r.scale) < 1e-9)
  for (const column of [0, 9, 30, 59, 70, 99]) {
    const layoutX = columnToLayerX(f, camera, column)
    // Round trip: the position a column is drawn at reads back as that column.
    assert.equal(Math.round(layerXToColumn(f, camera, layoutX)), column)
    // And that position is the one the painter uses, which is the whole point
    // of there being a single map: a hit test disagreeing with the painter is
    // how a collapse would silently pick the wrong columns.
    const onCanvas = MARGIN_X + (layoutX - camera.x) * camera.scale
    assert.ok(Math.abs(onCanvas - (r.x + displayColumn(f, column) * r.scale)) < 1e-9, `column ${column}`)
  }
})

test('a cohort too large to answer about is not asked about', async () => {
  const { collapseRequests } = await import('../src/components/alignment-explorer/collapsePlan.js')
  const rows = n => Array.from({ length: n }, (_, i) => `r${i}`)
  // Over the cell budget: 40 rows of a four-million-column block is 160M cells.
  const wide = { id: 'w', sourceBlock: 1, start: 0, end: 4_000_000, rowIds: rows(40) }
  // Over the row budget, whatever its width.
  const crowded = { id: 'c', sourceBlock: 2, start: 0, end: 100, rowIds: rows(900) }
  // The size an ordinary working layer actually is: thirty-three sequences over
  // a 421,559-column block, 14M cells, which the server answers in about 150ms.
  // This was refused by the first budget, which is what made the control claim
  // to be hiding gaps on a sheet it had never looked at.
  const ordinary = { id: 'o', sourceBlock: 3, start: 0, end: 421_559, rowIds: rows(33) }
  const requests = collapseRequests([wide, crowded, ordinary], 10)
  assert.deepEqual([...requests.values()].map(r => r.block), [3])
  assert.equal([...requests.values()][0].min_run, 10)
  assert.equal([...requests.values()][0].ids.length, 33)
})

test('chunks of one block sharing a cohort ask the question once', async () => {
  const { collapseRequests, collapseKey } = await import('../src/components/alignment-explorer/collapsePlan.js')
  const a = { id: 'a', sourceBlock: 1, start: 0, end: 100, rowIds: ['x', 'y'] }
  const b = { id: 'b', sourceBlock: 1, start: 0, end: 100, rowIds: ['y', 'x'] }
  const other = { id: 'c', sourceBlock: 1, start: 0, end: 100, rowIds: ['x'] }
  assert.equal(collapseKey(a), collapseKey(b))
  assert.equal(collapseRequests([a, b]).size, 1)
  // A different cohort over the same columns is a different question.
  assert.equal(collapseRequests([a, other]).size, 2)
  // Aggregated block groups have no columns of their own to collapse.
  assert.equal(collapseRequests([{ ...a, aggregate: { count: 4 } }]).size, 0)
})

test('pieces are found, not scanned to, when a block is cut into many runs', async () => {
  const { columnPieces, displayColumn, sourceColumn } = await load()
  // 2,000 collapsed runs: every other hundred columns is gone.
  const collapsed = Array.from({ length: 2000 }, (_, i) => [i * 100 + 50, i * 100 + 100])
  const f = { id: 'big', sourceBlock: 1, start: 0, end: 200000, x: 0, y: 0, rowIds: ['a'], collapsed }
  const pieces = columnPieces(f, 150000, 150120)
  assert.deepEqual(pieces, [
    { start: 150000, end: 150050, hidden: 75000 },
    { start: 150100, end: 150120, hidden: 75050 },
  ])
  // Half the block is gone, and the map still round-trips deep inside it.
  assert.equal(sourceColumn(f, displayColumn(f, 150120)), 150120)
})

test('packing closes the space a collapse frees and says how far each block moved', async () => {
  const { packCollapsed } = await load()
  // Three 100-column blocks, 20 columns apart. The first loses 30 columns, the
  // second 10, the third none.
  const blocks = [
    { id: 'a', sourceBlock: 1, start: 0, end: 100, x: 0, y: 0, rowIds: ['r'], collapsed: [[10, 40]] },
    { id: 'b', sourceBlock: 2, start: 0, end: 100, x: 120, y: 0, rowIds: ['r'], collapsed: [[50, 60]] },
    { id: 'c', sourceBlock: 3, start: 0, end: 100, x: 240, y: 0, rowIds: ['r'], collapsed: null },
  ]
  const packed = packCollapsed(blocks)
  assert.deepEqual(packed.map(f => f.x), [0, 90, 200])
  assert.deepEqual(packed.map(f => f.packShift || 0), [0, 30, 40])
  // Every channel keeps exactly the width it had.
  const { displaySpan } = await load()
  for (let i = 1; i < packed.length; i++) {
    const gap = packed[i].x - (packed[i - 1].x + displaySpan(packed[i - 1]))
    assert.equal(gap, 20)
  }
})

test('packing leaves a sheet with nothing collapsed exactly as it was', async () => {
  const { packCollapsed } = await load()
  const blocks = [{ id: 'a', sourceBlock: 1, start: 0, end: 100, x: 0, y: 0, rowIds: ['r'], collapsed: null }]
  assert.equal(packCollapsed(blocks), blocks)
})

test('a collapsed stretch takes no width, so an interval spans one unbroken rectangle', async () => {
  const { displayColumn } = await load()
  const f = fragment()
  // What the painter relies on for a selection or a gap box to stay one shape:
  // the drawn width of an interval is its kept columns, with no hole to bridge.
  const width = displayColumn(f, 65) - displayColumn(f, 5)
  assert.equal(width, 35) // 5-10 and 30-60 kept out of 5-65
})

test('the gap menu answers show or hide, and Apply lights up for the choice itself', async () => {
  const { gapDirty, gapValue, gapMinimum } = await import('../src/components/alignment-explorer/gapSettings.js')
  const applied = { closed: true, marks: true, min: 1, percent: 100 }
  // The reason the choice is in the menu at all: turning gaps off from where
  // the reader is standing, with an Apply that says so.
  assert.equal(gapDirty({ closed: false, marks: true, min: '1' }, applied), true)
  assert.equal(gapDirty({ closed: true, marks: true, min: '1' }, applied), false)
  // Settings belong to hiding. With Show chosen they are not part of the answer
  // and must not light Apply up for a change Apply would not publish.
  assert.equal(gapDirty({ closed: false, marks: false, min: '40' }, { ...applied, closed: false }), false)
  assert.equal(gapDirty({ closed: true, marks: false, min: '1' }, applied), true)
  assert.equal(gapDirty({ closed: true, marks: true, min: '40' }, applied), true)
  // Choosing Hide while gaps are shown is a change even with untouched settings.
  assert.equal(gapDirty({ closed: true, marks: true, min: '1' }, { ...applied, closed: false }), true)
  // The share counts too, and only while hiding is the chosen answer.
  assert.equal(gapDirty({ closed: true, marks: true, min: '1', percent: 50 }, applied), true)
  assert.equal(gapDirty({ closed: false, marks: true, min: '1', percent: 50 }, { ...applied, closed: false }), false)
  // A workspace saved before there was a threshold means the whole cohort, so
  // opening its menu and pressing nothing must not light Apply up.
  assert.equal(gapDirty({ closed: true, marks: true, min: '1' }, { closed: true, marks: true, min: 1 }), false)
  // A threshold is a count of columns; anything else is one column.
  assert.equal(gapMinimum(''), 1)
  assert.equal(gapMinimum('0'), 1)
  assert.equal(gapMinimum('7'), 7)
  assert.equal(gapMinimum('999999'), 100000)
  // The face reports what happened, and tells a zoomed-out sheet apart from one
  // too large to ask about - only one of those has a way out.
  assert.equal(gapValue(false, { columns: 0 }), 'Shown')
  assert.equal(gapValue(true, { pending: true }), 'Working…')
  assert.equal(gapValue(true, { unavailable: true }), 'Zoom in')
  assert.equal(gapValue(true, { skipped: true }), 'Too big')
  assert.equal(gapValue(true, { columns: 12 }), 'Hidden')
  assert.equal(gapValue(true, { columns: 0 }), 'None here')
})

test('a share of the cohort is read in whole sequences, and says when it hides bases', async () => {
  const { gapRowsNeeded, gapHidesBases, gapShare } = await import('../src/components/alignment-explorer/gapSettings.js')
  // The same arithmetic the store does, so the menu can say what the slider
  // means before anything is fetched: half of five sequences is three.
  assert.equal(gapRowsNeeded(5, 50), 3)
  assert.equal(gapRowsNeeded(4, 50), 2)
  assert.equal(gapRowsNeeded(44, 90), 40)
  assert.equal(gapRowsNeeded(5, 100), 5)
  assert.equal(gapRowsNeeded(0, 50), 0)
  // Only the top of the range hides nothing a reader could be looking at.
  assert.equal(gapHidesBases(100), false)
  assert.equal(gapHidesBases(95), true)
  assert.equal(gapShare(undefined), 100)
  assert.equal(gapShare(0), 100)
  assert.equal(gapShare(140), 100)
  assert.equal(gapShare('50'), 50)
})

test('the slider fills to its handle, and the handle reaches both ends', async () => {
  const { gapSliderFill, GAP_MIN_SHARE } = await import('../src/components/alignment-explorer/gapSettings.js')
  // The browser's own range widget leaves the handle short of each end, so the
  // track is drawn here instead and the fill has to be measured against the
  // range the handle actually travels - not against a hundred, which left the
  // paint ahead of the handle at the bottom and behind it at the top.
  assert.equal(gapSliderFill(GAP_MIN_SHARE), 0)
  assert.equal(gapSliderFill(100), 100)
  assert.equal(gapSliderFill(50), 47)
  // A value from a workspace saved before the slider existed is the top of it.
  assert.equal(gapSliderFill(undefined), 100)
})

test('the threshold is part of the key, so changing it asks a new question', async () => {
  const { collapseTaskKey, collapseRequests } = await import('../src/components/alignment-explorer/collapsePlan.js')
  const f = { id: 'a', sourceBlock: 1, start: 0, end: 100, rowIds: ['x'] }
  const [key] = [...collapseRequests([f], 1).keys()]
  // Two thresholds over the same cohort are two different questions. Sharing a
  // key served one of them the other's answer; clearing the cache instead left
  // the scheduler with nothing asked for and nothing ever requested again.
  assert.notEqual(collapseTaskKey('d', 1, key), collapseTaskKey('d', 50, key))
  assert.equal(collapseTaskKey('d', 1, key), collapseTaskKey('d', 1, key))
  // And the threshold reaches the request itself, not only the key.
  assert.equal([...collapseRequests([f], 50).values()][0].min_run, 50)
})

test('the header says what is collapsed in words, and drops it before the range', async () => {
  const { blockHeaderPlan } = await import('../src/components/alignment-explorer/headerPlan.js')
  const measure = text => text.length * 6
  const args = { actionsWidth: 115, sourceBlock: 3, interval: '1–449,948', note: '330,980 columns collapsed', measure }
  // Wide enough for both: the note rides on the interval line.
  const roomy = blockHeaderPlan({ ...args, room: 400 })
  assert.equal(roomy.note, true)
  assert.equal(roomy.line, '1–449,948 · 330,980 columns collapsed')
  // Narrower: the note is the first thing to go, and the range survives.
  const tight = blockHeaderPlan({ ...args, room: 240 })
  assert.ok(!tight.note)
  assert.equal(tight.line, '1–449,948')
  // Narrower still: the range goes too, rather than either being abbreviated
  // into a number whose meaning the reader would have to guess.
  assert.equal(blockHeaderPlan({ ...args, room: 160 }).line, '')
  // With nothing collapsed the plans are exactly what they always were.
  assert.equal(blockHeaderPlan({ ...args, note: '', room: 400 }).line, '1–449,948')
})

test('runs nearer than the tolerance are drawn as one, and the drift stays under it', async () => {
  const { columnPieces, drawnRuns, keptRuns, displayColumn } = await load()
  // Two hundred short runs, so every join hides ten columns of a thousand.
  const collapsed = Array.from({ length: 200 }, (_, i) => [i * 1000 + 500, i * 1000 + 510])
  const f = { id: 'many', sourceBlock: 1, start: 0, end: 200000, x: 0, y: 0, rowIds: ['a'], collapsed }
  assert.equal(keptRuns(f).length, 201)
  // A tolerance under one join's worth changes nothing at all.
  assert.equal(drawnRuns(f, 9), keptRuns(f), 'too fine to merge is the exact map')
  assert.equal(drawnRuns(f, 0), keptRuns(f), 'no tolerance is the exact map')
  // A tolerance of 95 columns swallows nine joins at a time, not all two hundred.
  const runs = drawnRuns(f, 95)
  assert.ok(runs.length > 1 && runs.length < 30, `merged to ${runs.length} runs`)
  // Drift is measured from each group's first run, so no column is ever drawn
  // further than the tolerance from where the exact map puts it.
  for (const run of runs) {
    for (const column of [run.a, Math.floor((run.a + run.z) / 2), run.z - 1]) {
      const drawn = column - run.hidden - f.start
      assert.ok(drawn - displayColumn(f, column) <= 95, `column ${column} drifted too far`)
      assert.ok(drawn >= displayColumn(f, column), 'a merged run never draws a column early')
    }
  }
  // The pieces a painter gets follow the simplified map, and the whole panel is
  // still covered by them.
  const pieces = columnPieces(f, 0, 200000, 95)
  assert.equal(pieces.length, runs.length)
  assert.equal(pieces[0].start, 0)
  assert.equal(pieces.at(-1).end, 200000)
  // Cached per tolerance, so a repaint at the same zoom rebuilds nothing.
  assert.equal(drawnRuns(f, 95), runs)
})

test('a fragment with nothing collapsed ignores the tolerance entirely', async () => {
  const { columnPieces, drawnRuns } = await load()
  const plain = fragment(null)
  assert.equal(drawnRuns(plain, 5000), null)
  assert.deepEqual(columnPieces(plain, 5, 9, 5000), [{ start: 5, end: 9, hidden: 0 }])
})
