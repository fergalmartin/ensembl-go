import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  cladeLabel, cladeTitle, defaultView, emptyViewState, expandAll, expandEvents, expandSubtree, findLeaves, focusOn,
  indexTree, lca, leavesUnder, showSubtree, toggleCollapsed, toggleFlipped, visibleRows,
} from '../src/components/gene-trees/treeModel.js'
import { labelAnchorX, layoutTree, terminalRows } from '../src/components/gene-trees/treeLayout.js'
import { FOLD_PX, foldPlan, labelPlan } from '../src/components/gene-trees/paintTree.js'

// ((A:1,B:2)AB:1,((C:1,D:1)CD:1,E:3)CDE:0.5)root — ids in pre-order.
function node(id, parent, children, extra = {}) {
  return { id, parent, children, branch_length: extra.bl ?? 1, event: extra.event ?? null,
    taxon: extra.taxon ? { name: extra.taxon } : null, leaf: children.length ? null : { label: extra.label, gene_id: extra.gene } }
}
const TREE = { nodes: [
  node(0, -1, [1, 4], { taxon: 'Root', event: 'speciation' }),
  node(1, 0, [2, 3], { taxon: 'Mammals', event: 'duplication' }),
  node(2, 1, [], { label: 'A', gene: 'ENSG00000000001.4', bl: 1 }),
  node(3, 1, [], { label: 'B', gene: 'ENSG00000000002', bl: 2 }),
  node(4, 0, [5, 8], { taxon: 'Mammals', event: 'speciation', bl: 0.5 }),
  node(5, 4, [6, 7], { taxon: 'Primates' }),
  node(6, 5, [], { label: 'C' }),
  node(7, 5, [], { label: 'D' }),
  node(8, 4, [], { label: 'E', bl: 3 }),
] }

test('index counts leaves, depth and distance', () => {
  const index = indexTree(TREE)
  assert.deepEqual([...index.leafCount], [5, 2, 1, 1, 3, 2, 1, 1, 1])
  assert.equal(index.depth[6], 3)
  assert.equal(index.dist[8], 3.5)
  assert.deepEqual(leavesUnder(index, 4).sort(), [6, 7, 8])
  assert.equal(lca(index, [6, 8]), 4)
  assert.equal(lca(index, [2, 7]), 0)
})

test('collapse, expand subtree and focus are pure transitions', () => {
  const index = indexTree(TREE)
  const start = emptyViewState()
  const collapsed = toggleCollapsed(index, toggleCollapsed(index, start, 4), 5)
  assert.equal(start.collapsed.size, 0)
  assert.deepEqual(visibleRows(index, collapsed), [2, 3, 4])
  assert.deepEqual(visibleRows(index, expandSubtree(index, collapsed, 4)), [2, 3, 6, 7, 8])
  assert.deepEqual(visibleRows(index, focusOn(index, start, 6)), [1, 6, 7, 8])
  assert.deepEqual(visibleRows(index, expandAll(collapsed)), [2, 3, 6, 7, 8])
  assert.equal(toggleCollapsed(index, start, 2), start, 'a leaf cannot collapse')
})

test('flip reverses children, subtree view restricts rows', () => {
  const index = indexTree(TREE)
  const flipped = toggleFlipped(index, emptyViewState(), 0)
  assert.deepEqual(visibleRows(index, flipped), [6, 7, 8, 2, 3])
  assert.deepEqual(visibleRows(index, showSubtree(emptyViewState(), 5)), [6, 7])
})

test('default view keeps the focus path open and folds its neighbours', () => {
  const index = indexTree(TREE)
  assert.deepEqual(visibleRows(index, defaultView(index, 2)), [2, 3, 4])
  assert.deepEqual(visibleRows(index, defaultView(index, -1, 3)), [2, 3, 4])
  assert.deepEqual(visibleRows(index, defaultView(index, -1, 10)), [2, 3, 6, 7, 8])
})

test('expanding events opens the path to every duplication', () => {
  const index = indexTree(TREE)
  const all = { ...emptyViewState(), collapsed: new Set([0, 1, 4, 5]) }
  const opened = expandEvents(index, all)
  assert.ok(!opened.collapsed.has(0) && !opened.collapsed.has(1))
  assert.ok(opened.collapsed.has(4))
})

test('clade labels mark a repeated taxon under a duplication', () => {
  const index = indexTree({ nodes: [
    node(0, -1, [1, 2], { taxon: 'Mus musculus', event: 'duplication' }),
    node(1, 0, [3, 4], { taxon: 'Mus musculus' }),
    node(2, 0, [5, 6], { taxon: 'Mus musculus' }),
    node(3, 1, [], { label: 'a' }), node(4, 1, [], { label: 'b' }), node(5, 2, [], { label: 'c' }), node(6, 2, [], { label: 'd' }),
  ] })
  assert.equal(cladeLabel(index, 1), 'Mus musculus (paralog copy)')
  assert.equal(cladeLabel(indexTree(TREE), 5), 'Primates')
  assert.equal(cladeLabel(indexTree(TREE), 4), 'Mammals')
})

test('a clade with no name says what it holds instead', () => {
  const index = indexTree({ nodes: [
    node(0, -1, [1, 2]),
    node(1, 0, [], { label: 'a' }), node(2, 0, [], { label: 'b' }),
  ] })
  index.nodes[1].leaf.species = 'Homo sapiens'
  index.nodes[2].leaf.species = 'Homo sapiens'
  assert.equal(cladeTitle(index, 0), '2 genes · 1 species')
  assert.equal(cladeTitle(indexTree(TREE), 5), 'Primates')
})

test('leaves are found by versionless gene id', () => {
  const index = indexTree(TREE)
  assert.deepEqual(findLeaves(index, ['ENSG00000000001']), [2])
  assert.deepEqual(findLeaves(index, ['ENSG00000000002.9']), [3])
})

test('layout: one row per terminal, parents between their children', () => {
  const index = indexTree(TREE)
  const result = layoutTree(index, emptyViewState(), { rowPitch: 10, levelWidth: 20 })
  assert.equal(result.rows, 5)
  assert.deepEqual(terminalRows(result).map(i => i.id), [2, 3, 6, 7, 8])
  const at = id => result.byId.get(id)
  assert.equal(at(1).y, 5)
  assert.equal(at(0).x, 0)
  assert.equal(at(6).x, 60)
  assert.equal(at(8).x, 40)
  assert.equal(result.edges.length, 8)
  assert.equal(result.edges[0].points[1][0], 'C')
})

test('layout: aligned leaves end together, phylogram follows branch length, flips mirror', () => {
  const index = indexTree(TREE)
  const aligned = layoutTree(index, emptyViewState(), { levelWidth: 20, alignLeaves: true })
  assert.equal(new Set(terminalRows(aligned).map(i => i.x)).size, 1)
  const phylo = layoutTree(index, emptyViewState(), { levelWidth: 20, phylogram: true })
  // Widest distance (E at 3.5) spans the cladogram width of 3 levels.
  assert.equal(phylo.byId.get(8).x, 60)
  assert.ok(Math.abs(phylo.byId.get(2).x - (2 / 3.5) * 60) < 1e-9)
  const plain = layoutTree(index, emptyViewState(), { rowPitch: 10, levelWidth: 20 })
  const flipped = layoutTree(index, emptyViewState(), { rowPitch: 10, levelWidth: 20, flipHorizontal: true, flipVertical: true })
  for (const item of plain.items) {
    assert.equal(flipped.byId.get(item.id).x, plain.width - item.x)
    assert.equal(flipped.byId.get(item.id).y, plain.height - item.y)
  }
  const elbows = layoutTree(index, emptyViewState(), { layout: 'rectangular' })
  assert.deepEqual(elbows.edges[0].points.map(p => p[0]), ['M', 'L', 'L'])
})

test('layout handles a real Compara tree without overlapping rows', () => {
  const doc = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/gene_trees/brca2_ensembl.json', import.meta.url)))
  // Flatten the nested REST document the way the backend does.
  const nodes = []
  const stack = [[doc.tree, -1]]
  while (stack.length) {
    const [source, parent] = stack.pop()
    const id = nodes.length
    nodes.push({ id, parent, children: [], branch_length: source.branch_length, event: source.events?.type ?? null,
      taxon: source.taxonomy ? { name: source.taxonomy.scientific_name } : null,
      leaf: source.children ? null : { label: source.id.accession, gene_id: source.id.accession } })
    if (parent >= 0) nodes[parent].children.push(id)
    for (const child of [...(source.children || [])].reverse()) stack.push([child, id])
  }
  const index = indexTree({ nodes })
  const human = findLeaves(index, ['ENSG00000139618'])[0]
  const result = layoutTree(index, defaultView(index, human))
  const ys = terminalRows(result).map(i => i.y)
  assert.equal(new Set(ys).size, ys.length)
  assert.ok(result.rows < 60, `focused view should be compact, got ${result.rows} rows`)
  const full = layoutTree(index, expandAll(defaultView(index, human)))
  assert.equal(full.rows, 175)
})

// A balanced tree of 2^depth leaves, for zooming right out.
function balanced(depth) {
  const nodes = []
  const make = (parent, level) => {
    const id = nodes.length
    nodes.push({ id, parent, children: [], branch_length: 1, event: null, taxon: level < depth ? { name: `clade${id}` } : null,
      leaf: level === depth ? { label: `L${id}`, gene_id: `G${id}`, species: `S${id % 7}` } : null })
    if (parent >= 0) nodes[parent].children.push(id)
    if (level < depth) { make(id, level + 1); make(id, level + 1) }
    return id
  }
  make(-1, 0)
  return indexTree({ nodes })
}

test('zoomed far out, small clades fold into wedges but never the focus path', () => {
  const index = balanced(9) // 512 leaves
  const layout = layoutTree(index, emptyViewState(), { rowPitch: 26 })
  const focus = index.nodes.find(n => n.leaf).id
  const path = new Set()
  for (let n = focus; n >= 0; n = index.parent[n]) path.add(n)
  assert.equal(foldPlan(layout, { k: 1, x: 0, y: 0 }, path), null, 'nothing folds at full size')
  const far = { k: 0.01, x: 0, y: 0 }
  const folds = foldPlan(layout, far, path)
  assert.ok(folds.folded.size > 0)
  for (const id of folds.folded) {
    assert.ok(!path.has(id))
    const item = layout.byId.get(id)
    assert.ok((item.y1 - item.y0) * far.k < FOLD_PX)
  }
  assert.ok(!folds.hidden.has(focus))
})

test('thinned labels keep the focus gene and account for every hidden gene once', () => {
  const index = balanced(8) // 256 leaves
  const layout = layoutTree(index, emptyViewState(), { rowPitch: 26 })
  const focus = index.nodes.filter(n => n.leaf)[100].id
  const path = new Set()
  for (let n = focus; n >= 0; n = index.parent[n]) path.add(n)
  assert.equal(labelPlan(layout, index, { k: 1, x: 0, y: 0 }, {}, new Set(), focus, path).full, true)
  const plan = labelPlan(layout, index, { k: 0.08, x: 0, y: 0 }, {}, new Set(), focus, path)
  assert.equal(plan.full, false)
  assert.ok(plan.labelled.has(focus))
  // Labelled rows plus the genes they stand for add up to the whole tree.
  const genes = id => index.leafCount[id]
  const counted = [...plan.labelled].reduce((sum, id) => sum + genes(id) + (plan.extra.get(id) || 0), 0)
  assert.equal(counted, 256)
})

test('aligned leaves in a phylogram keep branch lengths and share one label column', () => {
  const index = indexTree(TREE)
  const layout = layoutTree(index, emptyViewState(), { levelWidth: 20, phylogram: true, alignLeaves: true })
  const tips = terminalRows(layout)
  assert.ok(new Set(tips.map(i => i.x)).size > 1, 'tips stay where their branch lengths put them')
  assert.equal(layout.alignX, Math.max(...tips.map(i => i.x)))
  assert.equal(new Set(tips.map(i => labelAnchorX(layout, i))).size, 1)
  const flipped = layoutTree(index, emptyViewState(), { levelWidth: 20, phylogram: true, alignLeaves: true, flipHorizontal: true })
  assert.equal(flipped.alignX, Math.min(...terminalRows(flipped).map(i => i.x)))
  assert.equal(layoutTree(index, emptyViewState(), {}).alignX, undefined)
})

test('radial: tips go round the circle in row order, a row pitch apart at the rim', () => {
  const index = balanced(6) // 64 leaves
  const layout = layoutTree(index, emptyViewState(), { shape: 'radial', rowPitch: 26 })
  assert.equal(layout.radial, true)
  const tips = terminalRows({ items: layout.items.map(i => ({ ...i, y: i.lpos })) })
  const angles = tips.map(t => t.angle)
  for (let i = 1; i < angles.length; i++) {
    assert.ok(angles[i] > angles[i - 1])
    assert.ok((angles[i] - angles[i - 1]) * layout.outer >= 26 - 1e-6)
  }
  for (const item of layout.items) {
    assert.ok(Math.abs(item.x - item.r * Math.cos(item.angle)) < 1e-9)
    assert.ok(Math.abs(item.y - item.r * Math.sin(item.angle)) < 1e-9)
  }
  assert.equal(layout.byId.get(0).r, 0, 'the root is at the centre')
})

test('radial: aligned tips share the outer circle, phylogram radius follows branch length, mirrors reflect', () => {
  const index = indexTree(TREE)
  const aligned = layoutTree(index, emptyViewState(), { shape: 'radial', alignLeaves: true })
  for (const tip of aligned.items.filter(i => i.kind !== 'internal')) assert.ok(Math.abs(tip.r - aligned.outer) < 1e-9)
  assert.equal(aligned.alignR, aligned.outer)
  const phylo = layoutTree(index, emptyViewState(), { shape: 'radial', phylogram: true })
  assert.ok(Math.abs(phylo.byId.get(8).r - phylo.outer) < 1e-9, 'the most distant tip is on the rim')
  assert.ok(Math.abs(phylo.byId.get(2).r / phylo.outer - 2 / 3.5) < 1e-9)
  const plain = layoutTree(index, emptyViewState(), { shape: 'radial' })
  const mirrored = layoutTree(index, emptyViewState(), { shape: 'radial', flipHorizontal: true })
  for (const item of plain.items) {
    const other = mirrored.byId.get(item.id)
    assert.ok(Math.abs(other.x + item.x) < 1e-9 && Math.abs(other.y - item.y) < 1e-9)
  }
  const elbows = layoutTree(index, emptyViewState(), { shape: 'radial', layout: 'rectangular' })
  assert.deepEqual(elbows.edges[0].points.map(p => p[0]), ['M', 'A', 'L'])
})

test('radial: far out, folding and label thinning keep the focus gene and count every gene once', () => {
  const index = balanced(8)
  const layout = layoutTree(index, emptyViewState(), { shape: 'radial', rowPitch: 26 })
  const focus = index.nodes.filter(n => n.leaf)[40].id
  const path = new Set()
  for (let n = focus; n >= 0; n = index.parent[n]) path.add(n)
  const plan = labelPlan(layout, index, { k: 0.05, kx: 0.05, x: 0, y: 0 }, {}, new Set(), focus, path)
  assert.equal(plan.full, false)
  assert.ok(plan.folds.folded.size > 0)
  assert.ok(plan.labelled.has(focus))
  const counted = [...plan.labelled].reduce((sum, id) => sum + index.leafCount[id] + (plan.extra.get(id) || 0), 0)
  assert.equal(counted, 256)
})
