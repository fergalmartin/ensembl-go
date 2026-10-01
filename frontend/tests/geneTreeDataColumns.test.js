import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arrivingView, carryView, composeColumns, laneViews, scopeView, viewScope, withFragmentViews,
} from '../src/components/gene-trees/dataColumns.js'
import { forestTree, validateWorkspace } from '../src/components/gene-trees/workspace.js'

const leaf = (id, parent) => ({ id, parent, children: [], leaf: { label: `g${id}` } })
const fragment = (id, extra = {}) => ({ id, name: '', source: {}, nodes: [{ id: 0, parent: -1, children: [1, 2] }, leaf(1, 0), leaf(2, 0)], ...extra })
const LAYER = { id: 'L', name: 'Layer', fragments: [fragment('A', { dataView: 'structure' }), fragment('B'), fragment('C', { dataView: 'neighbourhood' })] }

test('the Data view button acts on the subtrees the picks touch, else on all of them', () => {
  const forest = forestTree(LAYER)
  // Forest ids: 0 the invisible root, then A 1–3, B 4–6, C 7–9.
  assert.deepEqual(viewScope(LAYER, forest.fragmentOf, null), { ids: ['A', 'B', 'C'], selected: false })
  assert.deepEqual(viewScope(LAYER, forest.fragmentOf, new Set([5])), { ids: ['B'], selected: true }, 'a gene picked stands for its subtree')
  assert.deepEqual(viewScope(LAYER, forest.fragmentOf, new Set([2, 8, 9])), { ids: ['A', 'C'], selected: true })
  assert.deepEqual(viewScope(LAYER, forest.fragmentOf, new Set([0])), { ids: ['A', 'B', 'C'], selected: false }, 'the invisible root is no subtree')
})

test('what the button shows: the shared view, off, or mixed', () => {
  assert.equal(scopeView(LAYER, ['A']), 'structure')
  assert.equal(scopeView(LAYER, ['B']), 'off')
  assert.equal(scopeView(LAYER, ['A', 'C']), 'mixed')
  const set = withFragmentViews(LAYER, ['A', 'B'], 'sequence')
  assert.deepEqual(set.fragments.map(f => f.dataView), ['sequence', 'sequence', 'neighbourhood'])
  const cleared = withFragmentViews(set, ['A'], 'off')
  assert.equal('dataView' in cleared.fragments[0], false)
  assert.equal(cleared.fragments[1].dataView, 'sequence')
})

test('a subtree arriving in a layer takes the view every subtree there shares, or its own into an empty one', () => {
  assert.equal(arrivingView([], 'neighbourhood'), 'neighbourhood')
  assert.equal(arrivingView([], 'off'), undefined)
  assert.equal(arrivingView([{ dataView: 'structure' }, { dataView: 'structure' }], 'neighbourhood'), 'structure')
  assert.equal(arrivingView([{ dataView: 'structure' }, {}], 'structure'), undefined, 'the layer is mixed: no view')
  assert.equal(arrivingView([{}], 'structure'), undefined, 'the layer shows none')
  assert.deepEqual(carryView({ id: 'X' }, 'sequence'), { id: 'X', dataView: 'sequence' })
  assert.deepEqual(carryView({ id: 'X' }, undefined), { id: 'X' })
})

test('a saved subtree keeps its data view, and loses one this version does not know', () => {
  const saved = { layers: [{ id: 'L', name: 'L', fragments: [fragment('A', { dataView: 'sequence' }), fragment('B', { dataView: 'hologram' })] }] }
  const [a, b] = validateWorkspace(saved).layers[0].fragments
  assert.equal(a.dataView, 'sequence')
  assert.equal('dataView' in b, false)
})

test('a composite column hands each subtree’s rows to its own view', () => {
  // Three lanes: 0 structure, 1 none, 2 neighbourhood.
  const items = [
    { id: 1, lane: 0, kind: 'internal', node: { fragRoot: 'A' } }, { id: 2, lane: 0, kind: 'leaf', node: {} },
    { id: 4, lane: 1, kind: 'internal', node: { fragRoot: 'B' } }, { id: 5, lane: 1, kind: 'leaf', node: {} },
    { id: 7, lane: 2, kind: 'internal', node: { fragRoot: 'C' } }, { id: 8, lane: 2, kind: 'leaf', node: {} },
  ]
  const layout = { items, byId: new Map(items.map(i => [i.id, i])), laneOffsets: [100, 0, 50], labelOffset: 100 }
  const views = new Map(LAYER.fragments.map(f => [f.id, f.dataView]))
  assert.deepEqual(laneViews(layout, id => views.get(id)), ['structure', 'off', 'neighbourhood'])
  const drawn = { a: [], n: [] }
  const part = (key, width) => ({
    kind: key === 'a' ? 'alignment' : 'neighbourhood',
    paint(ctx, env) { drawn[key] = items.filter(i => env.shown(i.id)).map(i => i.id) },
    leaderEnd: () => key,
    hit: (lay, t, sx, sy, plan, inPass) => (inPass(8) ? { part: key } : null),
    ...(width ? { labelOffset: () => width } : {}),
  })
  const column = composeColumns([{ column: part('a', 240), lanes: new Set([0]) }, { column: part('n'), lanes: new Set([2]) }, { column: null, lanes: new Set([1]) }])
  column.paint(null, { layout, shown: id => id !== 1 })
  assert.deepEqual(drawn, { a: [2], n: [7, 8] }, 'each part draws its own lanes, within the pass')
  assert.equal(column.leaderEnd(layout, {}, items[1]), 'a')
  assert.equal(column.leaderEnd(layout, {}, items[3]), null, 'a subtree with no view has no column')
  assert.deepEqual(column.hit(layout, {}, 0, 0, null), { part: 'n' })
  // A stretching column widens its own lanes' labels only.
  column.placeLabels(layout)
  assert.deepEqual(layout.laneOffsets, [240, 0, 50])
  assert.equal(layout.labelOffset, 240)
})
