import assert from 'node:assert/strict'
import test from 'node:test'
import { resultsScrollPlan } from '../src/components/homology/scroll.js'

const position = { outerTop: 200, outerMax: 800, rowsTop: 300, innerTop: 0, innerMax: 1200 }

test('partially visible results consume downward scrolling in the page first', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, delta: 120 }), { outerTop: 320, innerTop: 0 })
})

test('a gesture crossing the reveal boundary spends only its remainder on rows', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, delta: 450 }), { outerTop: 500, innerTop: 150 })
})

test('the page keeps moving after result tabs reach the top, until column headers arrive', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, outerTop: 578, outerMax: 900, rowsTop: 156, delta: 100 }), { outerTop: 678, innerTop: 0 })
    assert.deepEqual(resultsScrollPlan({ ...position, outerTop: 678, outerMax: 900, rowsTop: 56, delta: 100 }), { outerTop: 734, innerTop: 44 })
})

test('column headers at the top scroll rows while the page stays still', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, rowsTop: 0, outerTop: 500, innerTop: 80, delta: 120 }), { outerTop: 500, innerTop: 200 })
})

test('upward scrolling traverses rows before returning to the search controls', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, rowsTop: 0, outerTop: 500, innerTop: 80, delta: -50 }), { outerTop: 500, innerTop: 30 })
    assert.deepEqual(resultsScrollPlan({ ...position, rowsTop: 0, outerTop: 500, innerTop: 80, delta: -120 }), { outerTop: 460, innerTop: 0 })
})

test('row boundaries and short tables allow excess movement back to the page', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, rowsTop: 0, innerTop: 1190, delta: 50 }), { outerTop: 240, innerTop: 1200 })
    assert.deepEqual(resultsScrollPlan({ ...position, innerMax: 0, delta: 450 }), { outerTop: 650, innerTop: 0 })
})

test('large gestures stop at both scroll limits', () => {
    assert.deepEqual(resultsScrollPlan({ ...position, delta: 10000 }), { outerTop: 800, innerTop: 1200 })
    assert.deepEqual(resultsScrollPlan({ ...position, innerTop: 300, delta: -10000 }), { outerTop: 0, innerTop: 0 })
})
