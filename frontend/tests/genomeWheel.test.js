import test from 'node:test'
import assert from 'node:assert/strict'
import { CYCLE_ACTION_OFFSET, clampWheelPosition, detentPosition, defaultCycleAction, cycleRailGeometry, cyclePointerIntent, cycleSelection, cycleGenomeDetails, cyclePointerDragged, cycleActionLabel, cycleActionProgress, cycleBottomSpacer } from '../src/utils/genomeWheel.js'
import { getGenomeKey } from '../src/utils/genomeIdentity.js'
const genomes = Array.from({ length: 4 }, (_, index) => ({ species_key: `species_${index}`, assembly: `GCA_00000000${index}.1`, files: { gff3: `/test/${index}.gff` } }))
const keys = items => items.map(getGenomeKey)

test('detents remain continuous and monotonic through a complete rotation', () => {
  let previous = -1
  for (let position = 0; position <= 12; position += 0.001) {
    const value = detentPosition(position)
    assert.ok(value >= previous)
    assert.ok(Math.abs(value - position) < 0.1)
    previous = value
  }
  assert.equal(detentPosition(3), 3)
})
test('default focuses with zero or one active genome and adds with multiple', () => {
  assert.equal(defaultCycleAction(0), 'focus')
  assert.equal(defaultCycleAction(1), 'focus')
  assert.equal(defaultCycleAction(2), 'add')
})
test('focus activates an inactive genome and retains the rest of the selected pool', () => {
  const result = cycleSelection(genomes.slice(0, 2), genomes, getGenomeKey(genomes[3]), 'focus')
  assert.deepEqual(keys(result.active), keys([genomes[3]]))
  assert.deepEqual(keys(result.inactive), keys(genomes.slice(0, 3)))
  assert.equal(genomes.length, 4)
})
test('add appends an inactive genome without changing primary or existing order', () => {
  const result = cycleSelection(genomes.slice(0, 2), genomes, getGenomeKey(genomes[3]), 'add')
  assert.deepEqual(keys(result.active), keys([genomes[0], genomes[1], genomes[3]]))
  assert.deepEqual(keys(result.inactive), keys([genomes[2]]))
  const duplicate = cycleSelection(result.active, genomes, getGenomeKey(genomes[0]), 'add')
  assert.deepEqual(keys(duplicate.active), keys(result.active))
})
test('empty pool can focus or add its first genome', () => {
  for (const action of ['focus', 'add']) {
    assert.deepEqual(keys(cycleSelection([], genomes, getGenomeKey(genomes[2]), action).active), keys([genomes[2]]))
  }
  assert.equal(cycleSelection([], genomes, 'unknown', 'focus'), null)
  assert.equal(cycleSelection([], genomes, getGenomeKey(genomes[0]), 'invalid'), null)
})
test('the action buttons and their captions clear the rail and the cancel button', () => {
  const rail = cycleRailGeometry(6, { left: 1100, right: 1160, bottom: 250 }, 800)
  const RAIL_HALF_WIDTH = 26
  const BUTTON_RADIUS = 16
  const CAPTION_DROP = 28
  assert.ok(CYCLE_ACTION_OFFSET - BUTTON_RADIUS > RAIL_HALF_WIDTH)
  // The lowest pair sits a padding above the rail's foot, and its caption hangs
  // below that — all of it above the cancel button.
  const lowestCaption = rail.top + rail.height - rail.padding + CAPTION_DROP
  assert.ok(lowestCaption < rail.cancelTop)
})
test('rail starts beneath button centre, grows then compresses inside viewport', () => {
  const button = { left: 1100, right: 1160, bottom: 250 }
  const small = cycleRailGeometry(3, button, 800)
  const many = cycleRailGeometry(40, button, 800)
  const short = cycleRailGeometry(40, button, 350)
  assert.equal(small.top, 258)
  assert.equal(small.center, 1130)
  assert.equal(many.height, 420)
  assert.ok(short.cancelTop + short.cancelHeight <= 350 - 12)
  assert.equal(short.cancelTop, short.top + short.height + 18)
  assert.ok(many.spacing < small.spacing)
  const one = cycleRailGeometry(1, button, 350)
  assert.equal(one.spacing, 0)
  assert.equal(clampWheelPosition(-4, 3), 0)
  assert.equal(clampWheelPosition(9, 3), 2)
})
test('cursor and dot positions agree, including side actions and outside cancellation', () => {
  const rail = cycleRailGeometry(6, { left: 1100, right: 1160, bottom: 250 }, 800)
  const y = rail.top + rail.padding + 3 * rail.spacing
  assert.deepEqual(cyclePointerIntent(rail.center, y, rail, 6, 'add'), { position: 3, face: 3, action: 'add' })
  assert.equal(cyclePointerIntent(rail.center - 40, y, rail, 6, 'add').action, 'focus')
  assert.equal(cyclePointerIntent(rail.center + 40, y, rail, 6, 'focus').action, 'add')
  assert.equal(cyclePointerIntent(rail.center + 100, y, rail, 6, 'add').action, null)
  assert.equal(cyclePointerIntent(rail.center, rail.top - 10, rail, 6, 'add').action, null)
  assert.equal(cyclePointerIntent(rail.center, rail.cancelTop + rail.cancelHeight / 2, rail, 6, 'add').action, null)
  assert.equal(cyclePointerIntent(rail.center - 100, y, rail, 6, 'add').action, null)
  assert.equal(cyclePointerIntent(rail.center, y, rail, 6, 'focus').action, 'focus')
})
test('details retain assembly accession and custom label', () => {
  assert.deepEqual(cycleGenomeDetails({ display_name: 'Human', assembly_name: 'GRCh38', assembly: 'GCF_000001405.40', custom_label: 'Reference' }), {
    name: 'Human', assembly: 'GRCh38', accession: 'GCF_000001405.40', label: 'Reference',
  })
})

test('a press that never travels is a click, and keeps the wheel open', () => {
  const origin = { x: 100, y: 100 }
  assert.equal(cyclePointerDragged(origin, 103, 102), false)
  assert.equal(cyclePointerDragged(origin, 100, 130), true)
  assert.equal(cyclePointerDragged(null, 400, 400), false)
})
test('add reads as jump for a genome that is already open', () => {
  assert.equal(cycleActionLabel('add', false), 'Add')
  assert.equal(cycleActionLabel('add', true), 'Jump')
  assert.equal(cycleActionLabel('focus', true), 'Focus')
  assert.equal(cycleActionLabel(null, true), '')
  assert.equal(cycleActionProgress('add', true), 'Jumping to')
  assert.equal(cycleActionProgress('add', false), 'Adding')
  assert.equal(cycleActionProgress('focus', true), 'Focusing')
  assert.equal(cycleActionProgress(null, true), '')
})
test('the last genome is given exactly the whitespace its alignment is short of', () => {
  // A control bar 900px down a page of 1000 leaves 100px under it, so 700 more
  // are needed before it can reach the top of an 800px viewport.
  assert.equal(cycleBottomSpacer({ viewport: 800, scrollHeight: 1000, anchorOffset: 900 }), 700)
  // Measured again with that whitespace in place, the answer must not grow.
  assert.equal(cycleBottomSpacer({ viewport: 800, scrollHeight: 1700, anchorOffset: 900, spacer: 700 }), 700)
  // Nothing to add once the panel under the bar already fills the viewport.
  assert.equal(cycleBottomSpacer({ viewport: 800, scrollHeight: 4000, anchorOffset: 900 }), 0)
  assert.equal(cycleBottomSpacer({ viewport: 0, scrollHeight: 1000, anchorOffset: 900 }), 0)
  assert.equal(cycleBottomSpacer({ viewport: 800, scrollHeight: 1000, anchorOffset: NaN }), 0)
})
