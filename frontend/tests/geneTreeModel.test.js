import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  applyNodeMode, cladeLabel, cladeTitle, collapseAll, collapseTo, defaultView, emptyViewState, expandAll, expandSubtree, expandTo, findLeaves, focusOn,
  indexTree, lca, leavesUnder, pathsTo, showSubtree, toggleCollapsed, toggleFlipped, visibleRows,
} from '../src/components/gene-trees/treeModel.js'
import { labelAnchorX, layoutTree, terminalRows } from '../src/components/gene-trees/treeLayout.js'
import { FOLD_PX, cladeGenomes, foldPlan, labelPlan, neighbourRowPairs } from '../src/components/gene-trees/paintTree.js'

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

test('a clade knows which top-bar and local genomes it holds, and how many genes in each', () => {
  const index = indexTree(TREE)
  const links = {
    2: { status: 'linked', assembly: 'GCA_LOCAL' },
    6: { status: 'linked', assembly: 'GCA_TOP' },
    7: { status: 'linked', assembly: 'GCA_TOP' },
    8: { status: 'no_index', assembly: 'GCA_OTHER' },
  }
  const topbar = new Set(['GCA_TOP'])
  const summary = id => cladeGenomes(index, id, links, topbar).map(g => [g.assembly, g.status, g.count])
  // Top-bar genomes first, then local ones; a leaf not linked to a local gene counts for nothing.
  assert.deepEqual(summary(0), [['GCA_TOP', 'topbar', 2], ['GCA_LOCAL', 'local', 1]])
  assert.deepEqual(summary(4), [['GCA_TOP', 'topbar', 2]])
  assert.deepEqual(summary(1), [['GCA_LOCAL', 'local', 1]])
  assert.deepEqual(summary(8), [])
  // Merging children never changes a child's own counts.
  assert.deepEqual(summary(5), [['GCA_TOP', 'topbar', 2]])
  // New links (or a new top bar) are worked out afresh.
  assert.deepEqual(cladeGenomes(index, 4, links, new Set()).map(g => g.status), ['local'])
})

test('folding the whole tree, and folding or opening around the local genes', () => {
  const index = indexTree(TREE)
  const view = emptyViewState()
  const rows = v => visibleRows(index, v).map(r => r.id ?? r)
  // Collapse all folds every clade, each on its own, so opening one shows the next level.
  const all = collapseAll(index, view)
  assert.deepEqual([...all.collapsed].sort(), [1, 4, 5])
  assert.deepEqual([...collapseAll(index, showSubtree(view, 4)).collapsed].sort(), [5])
  assert.equal(expandAll(all).collapsed.size, 0)
  // D (7) is local: its way from the root is 7, 5, 4, 0.
  const paths = pathsTo(index, [7])
  assert.deepEqual([...paths].sort(), [0, 4, 5, 7])
  // Collapse to local folds everything off that way; Expand to local opens only what hides it.
  assert.deepEqual([...collapseTo(index, view, paths).collapsed], [1])
  assert.deepEqual([...expandTo(all, paths).collapsed], [1])
  assert.equal(expandTo(toggleCollapsed(index, view, 1), paths).collapsed.has(1), true)
  assert.ok(rows(collapseTo(index, view, paths)).length > 0)
  // A subtree layer's invisible root is never folded.
  const forest = indexTree({ nodes: TREE.nodes.map(n => (n.id === 4 ? { ...n, virtual: true } : n)) })
  assert.equal(collapseAll(forest, view).collapsed.has(4), false)
})

test('each Nodes state folds the view its own way; the local ones need local genes', () => {
  const index = indexTree(TREE)
  const folded = toggleCollapsed(index, toggleCollapsed(index, emptyViewState(), 5), 1)
  const paths = pathsTo(index, [7])
  const collapsed = mode => [...applyNodeMode(index, folded, mode, paths).collapsed].sort()
  assert.deepEqual(collapsed('expand-all'), [])
  assert.deepEqual(collapsed('collapse-all'), [1, 4, 5])
  assert.deepEqual(collapsed('expand-local'), [1])
  assert.deepEqual(collapsed('highlight-local'), [1])
  assert.deepEqual(collapsed('select-local'), [1])
  assert.deepEqual(collapsed('collapse-local'), [1])
  assert.equal(applyNodeMode(index, folded, 'collapse-local', null), folded)
})

test('neighbourhood links join rows of the same tree only, never across subtrees', () => {
  const row = (id, lane, sy, genes = true) => ({ item: { id, lane }, sy, entry: genes ? { genes: [] } : {} })
  const ids = pairs => pairs.map(([a, b]) => [a.item.id, b.item.id])
  // One tree: each row with genes to the next with genes, skipping a row without.
  assert.deepEqual(ids(neighbourRowPairs([row(1, undefined, 0), row(2, undefined, 20, false), row(3, undefined, 40)], 500)), [[1, 3]])
  // A tree cut in two, stacked: no link over the cut.
  assert.deepEqual(ids(neighbourRowPairs([row(1, 0, 0), row(2, 0, 20), row(3, 1, 60), row(4, 1, 80)], 500)), [[1, 2], [3, 4]])
  // Two subtrees moved side by side, rows interleaved on screen: each still links within itself.
  assert.deepEqual(ids(neighbourRowPairs([row(1, 0, 0), row(2, 1, 10), row(3, 0, 20), row(4, 1, 30)], 500)), [[1, 3], [2, 4]])
  // Wholly off screen is skipped; running across the view is kept.
  assert.deepEqual(ids(neighbourRowPairs([row(1, 0, -300), row(2, 0, -200), row(3, 0, 900)], 500)), [[2, 3]])
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

test('folding to a node keeps the way to it open, folds what is off it, and opens its clade', async () => {
  const { foldTo } = await import('../src/components/gene-trees/treeModel.js')
  const index = indexTree(TREE)
  // Folding to Primates (5): the root and Mammals (4) open, AB (1) folded, Primates' own leaves showing.
  const view = foldTo(index, { ...emptyViewState(), collapsed: new Set([5]) }, 5)
  assert.deepEqual(visibleRows(index, view), [1, 6, 7, 8])
  // Folding to a gene is folding to the focus: only its path open.
  assert.deepEqual(visibleRows(index, foldTo(index, emptyViewState(), 2)), [2, 3, 4])
})

test('flipping a clade mirrors everything below it, and flipping again restores it', async () => {
  const { mirrorClade } = await import('../src/components/gene-trees/treeModel.js')
  const index = indexTree(TREE)
  const start = emptyViewState()
  const before = visibleRows(index, start)
  const mirrored = mirrorClade(index, start, 0)
  // The whole tree read bottom to top, not just its first split swapped.
  assert.deepEqual(visibleRows(index, mirrored), [...before].reverse())
  assert.deepEqual(visibleRows(index, mirrorClade(index, mirrored, 0)), before)
  // A clade inside the tree mirrors on its own; a leaf has nothing to flip.
  const inner = mirrorClade(index, start, 5)
  assert.deepEqual(visibleRows(index, inner), before.map(id => (id === 6 ? 7 : id === 7 ? 6 : id)))
  assert.equal(mirrorClade(index, start, 2), start)
})

test('default view keeps the focus path open and folds its neighbours', () => {
  const index = indexTree(TREE)
  assert.deepEqual(visibleRows(index, defaultView(index, 2)), [2, 3, 4])
  assert.deepEqual(visibleRows(index, defaultView(index, -1, 3)), [2, 3, 4])
  assert.deepEqual(visibleRows(index, defaultView(index, -1, 10)), [2, 3, 6, 7, 8])
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

test('curved phylogram branches bend within one level of the parent, then run straight', () => {
  const index = indexTree(TREE)
  const layout = layoutTree(index, emptyViewState(), { levelWidth: 20, phylogram: true })
  // E (bl 3) is the longest branch: its bend ends where its sibling Primates' clade begins
  // (closer than a level), and a straight run reaches E.
  const long = layout.edges.find(e => e.to === 8)
  const parent = layout.byId.get(4), leaf = layout.byId.get(8), sibling = layout.byId.get(5)
  assert.ok(sibling.x - parent.x < 20)
  assert.equal(long.points[1][0], 'C')
  assert.ok(Math.abs(long.points[1][5] - sibling.x) < 1e-9)
  assert.deepEqual(long.points[2], ['L', leaf.x, leaf.y])
  // No bend is ever squeezed below a third of a level by a very short sibling.
  const root = layout.byId.get(0)
  for (const edge of layout.edges.filter(e => e.from === 0)) {
    const to = layout.byId.get(edge.to)
    assert.ok(Math.abs(edge.points[1][5] - root.x) >= Math.min(20 / 3, Math.abs(to.x - root.x)) - 1e-9)
  }
  // A branch shorter than a level is one curve, as before.
  const short = layout.edges.find(e => e.to === 4)
  assert.equal(short.points.length, 2)
  assert.equal(short.points[1][5], layout.byId.get(4).x)
  // Flipped, the bend goes the other way.
  const flipped = layoutTree(index, emptyViewState(), { levelWidth: 20, phylogram: true, flipHorizontal: true })
  const back = flipped.edges.find(e => e.to === 8)
  assert.ok(Math.abs(back.points[1][5] - flipped.byId.get(5).x) < 1e-9)
  assert.ok(back.points[1][5] < flipped.byId.get(4).x)
  // Radial: the sweep reaches one level out, then a straight run along the spoke.
  const radial = layoutTree(index, emptyViewState(), { shape: 'radial', phylogram: true, levelWidth: 20 })
  const spoke = radial.edges.find(e => e.to === 8)
  assert.equal(spoke.points[1][0], 'P')
  assert.ok(spoke.points[1][3] < radial.byId.get(8).r)
  assert.equal(spoke.points[2][0], 'L')
})

test('a subtree layer: moved fragments stay put, the rest stack below them, each in its own lane', async () => {
  const { forestTree } = await import('../src/components/gene-trees/workspace.js')
  const leafNode = (id, parent, label) => ({ id, parent, children: [], branch_length: 1, leaf: { label } })
  const pair = (a, b) => [{ id: 0, parent: -1, children: [1, 2], branch_length: null, leaf: null }, leafNode(1, 0, a), leafNode(2, 0, b)]
  const layer = { fragments: [
    { id: 'F1', source: {}, nodes: pair('A', 'B') },
    { id: 'F2', source: {}, nodes: pair('C', 'D'), pos: { x: 400, y: 10 } },
    { id: 'F3', source: {}, nodes: pair('E', 'F') },
  ] }
  const index = indexTree(forestTree(layer))
  const layout = layoutTree(index, emptyViewState(), { rowPitch: 20, levelWidth: 30 })
  const rootOf = id => layout.items.find(i => i.node.fragRoot === id)
  const members = id => { const r = rootOf(id); return layout.items.filter(i => i.lane === r.lane) }
  // F2 sits where it was put: its root at x 400, its top row at y 10.
  assert.equal(rootOf('F2').x, 400)
  assert.equal(Math.min(...members('F2').map(i => i.y)), 10)
  // F1 and F3 were never moved: they stack below everything that was, in order, a blank row apart.
  const f2Bottom = Math.max(...members('F2').map(i => i.y))
  const f1Top = Math.min(...members('F1').map(i => i.y))
  const f3Top = Math.min(...members('F3').map(i => i.y))
  assert.ok(f1Top > f2Bottom)
  assert.equal(f3Top - Math.max(...members('F1').map(i => i.y)), 40)
  // Three lanes, so labels in F1 and F2 never compete for the same rows.
  assert.equal(new Set(layout.items.filter(i => !i.node.virtual).map(i => i.lane)).size, 3)
  // With nothing moved, the layout is the plain stack.
  const plain = layoutTree(indexTree(forestTree({ fragments: layer.fragments.map(f => ({ ...f, pos: undefined })) })), emptyViewState(), { rowPitch: 20, levelWidth: 30 })
  assert.deepEqual(plain.items.filter(i => i.kind === 'leaf').map(i => i.y), [20, 40, 80, 100, 140, 160])
})

test('a subtree layer: an arranged subtree that grows keeps the gaps to its neighbours', async () => {
  const { forestTree } = await import('../src/components/gene-trees/workspace.js')
  const leafNode = (id, parent, label) => ({ id, parent, children: [], branch_length: 1, leaf: { label } })
  const pair = (a, b) => [{ id: 0, parent: -1, children: [1, 2], branch_length: null, leaf: null }, leafNode(1, 0, a), leafNode(2, 0, b)]
  // Put down at row pitch 20 with no data column: each is 20 tall and reaches 30 past its root.
  // F2 sits 40 below F1; F3 sits beside F1, 70 clear of its tips.
  const layer = { fragments: [
    { id: 'F1', source: {}, nodes: pair('A', 'B'), pos: { x: 0, y: 0, w: 30, h: 20 } },
    { id: 'F2', source: {}, nodes: pair('C', 'D'), pos: { x: 0, y: 60, w: 30, h: 20 } },
    { id: 'F3', source: {}, nodes: pair('E', 'F'), pos: { x: 100, y: 0, w: 30, h: 20 } },
  ] }
  const index = indexTree(forestTree(layer))
  const place = options => {
    const layout = layoutTree(index, emptyViewState(), { levelWidth: 30, ...options })
    const at = id => {
      const root = layout.items.find(i => i.node.fragRoot === id)
      return { x: root.x, top: Math.min(...layout.items.filter(i => i.lane === root.lane).map(i => i.y)) }
    }
    return { F1: at('F1'), F2: at('F2'), F3: at('F3'), boxes: layout.fragmentBoxes }
  }
  // As put down: nothing moves, and each box is what was recorded.
  const same = place({ rowPitch: 20 })
  assert.deepEqual([same.F2.top, same.F3.x], [60, 100])
  assert.deepEqual(same.boxes.get('F1'), { x: 0, y: 0, w: 30, h: 20 })
  // Roomier rows make every subtree taller: F2 moves down by what F1 grew, keeping its gap;
  // F3, beside F1 and not below it, stays level.
  const tall = place({ rowPitch: 40 })
  assert.deepEqual([tall.F2.top, tall.F3.top, tall.F3.x], [80, 0, 100])
  // A column past F1's tips pushes F3, beside it, along by its width; F2, below, stays put.
  const wide = place({ rowPitch: 20, fragmentExtra: id => (id === 'F1' ? 50 : 0) })
  assert.deepEqual([wide.F3.x, wide.F2.x, wide.F2.top], [150, 0, 60])
  // A subtree with no size recorded is taken as unchanged.
  const unsized = indexTree(forestTree({ fragments: layer.fragments.map(f => ({ ...f, pos: { x: f.pos.x, y: f.pos.y } })) }))
  const plain = layoutTree(unsized, emptyViewState(), { levelWidth: 30, rowPitch: 40 })
  assert.equal(Math.min(...plain.items.filter(i => i.lane === 1).map(i => i.y)), 60)
})

test('picks in a layer follow its edits, and go with the nodes an edit changed', async () => {
  const { carryPicks } = await import('../src/components/gene-trees/workspace.js')
  const nodes = () => [{ id: 0, parent: -1, children: [1, 2] }, { id: 1, parent: 0, children: [] }, { id: 2, parent: 0, children: [] }]
  const a = { id: 'A', nodes: nodes() }, b = { id: 'B', nodes: nodes() }
  const before = [a, b]
  // In the forest, A is drawn as 1–3 and B as 4–6.
  const picks = new Set([2, 4, 5])
  assert.equal(carryPicks(picks, before, before), picks)
  // A moved or renamed keeps its nodes, and its picks.
  assert.deepEqual([...carryPicks(picks, before, [{ ...a, name: 'x' }, b])], [2, 4, 5])
  // A removed: B's picks are renumbered to where B is drawn now; A's are gone.
  assert.deepEqual([...carryPicks(picks, before, [b])], [1, 2])
  // B edited (a removal inside it): its picks go with it.
  assert.deepEqual([...carryPicks(picks, before, [a, { ...b, nodes: nodes() }])], [2])
  assert.equal(carryPicks(new Set([4]), before, [a]).size, 0)
})

test('a subtree layer: aligned leaves line up within each subtree, and a carried subtree snaps level with a nearby one', async () => {
  const { forestTree } = await import('../src/components/gene-trees/workspace.js')
  const { alignSnap, alignXOf } = await import('../src/components/gene-trees/treeLayout.js')
  const leafNode = (id, parent, label) => ({ id, parent, children: [], branch_length: 1, leaf: { label } })
  const inner = (id, parent, children) => ({ id, parent, children, branch_length: 1, leaf: null })
  // F1 is two levels deep, F2 one: aligned across the layer, F2's tips used to be pushed out to F1's.
  const deep = [inner(0, -1, [1, 2]), leafNode(1, 0, 'A'), inner(2, 0, [3, 4]), leafNode(3, 2, 'B'), leafNode(4, 2, 'C')]
  const shallow = [inner(0, -1, [1, 2]), leafNode(1, 0, 'D'), leafNode(2, 0, 'E')]
  const layer = { fragments: [{ id: 'F1', source: {}, nodes: deep }, { id: 'F2', source: {}, nodes: shallow }] }
  const layout = layoutTree(indexTree(forestTree(layer)), emptyViewState(), { rowPitch: 20, levelWidth: 30, alignLeaves: true })
  const leavesOf = id => { const lane = layout.items.find(i => i.node.fragRoot === id).lane; return layout.items.filter(i => i.lane === lane && i.kind === 'leaf') }
  // Each subtree's tips share one x, its own: F1's two levels out, F2's one.
  assert.deepEqual([...new Set(leavesOf('F1').map(i => i.x))], [90])
  assert.deepEqual([...new Set(leavesOf('F2').map(i => i.x))], [60])
  assert.deepEqual([...new Set(leavesOf('F2').map(i => alignXOf(layout, i)))], [60])
  const f2Lane = leavesOf('F2')[0].lane
  const t = { k: 1, kx: 2, x: 0, y: 0 }
  // Carried 55px right on screen (27.5 world units at kx 2): 5px short of F1's column (30 world = 60px), so it snaps.
  const snap = alignSnap(layout, t, f2Lane, 55, 0)
  assert.equal(snap.worldDx, 30)
  assert.equal(snap.dx, 60)
  assert.equal(snap.column, 90)
  // Too far off the column, or too far away down the page: no snap.
  assert.equal(alignSnap(layout, t, f2Lane, 30, 0), null)
  assert.equal(alignSnap(layout, t, f2Lane, 60, 20 * 10), null)
  // Without aligned leaves there is nothing to line up.
  const unaligned = layoutTree(indexTree(forestTree(layer)), emptyViewState(), { rowPitch: 20, levelWidth: 30 })
  assert.equal(alignSnap(unaligned, t, f2Lane, 60, 0), null)
})

test('every copy of the focus gene keeps its label when zoomed out', () => {
  const index = indexTree(TREE)
  const layout = layoutTree(index, emptyViewState(), { rowPitch: 20, levelWidth: 20 })
  // So far out that only a label or two fits: the focus (A) and its copy (E) both keep one.
  const t = { k: 0.05, kx: 1, x: 0, y: 0 }
  // As the view passes it: the paths to both copies, which never fold.
  const plan = labelPlan(layout, index, t, {}, new Set(), 2, new Set([2, 1, 0, 8, 4]), new Set([8]))
  assert.ok(!plan.full)
  assert.ok(plan.labelled.has(2) && plan.labelled.has(8))
  const without = labelPlan(layoutTree(index, emptyViewState(), { rowPitch: 20, levelWidth: 20 }), index, t, {}, new Set(), 2, new Set([2, 1, 0]), null)
  assert.ok(!without.labelled.has(8))
})

test('neighbourhood: genes match by family, borrow a family through their symbol, else match by symbol', async () => {
  const { buildMatcher, sharedGroups, groupColours, linkedLeaves, FAMILY_PALETTE } = await import('../src/components/gene-trees/neighbourhoodMatch.js')
  const g = (id, name, families) => ({ id, name, families })
  const rows = new Map([
    // Ensembl rows: every gene in a library tree.
    [1, { center: 'h2', genes: [g('h1', 'NOC2L', [7]), g('h2', 'SAMD11', [1]), g('h3', 'KLHL17', [9]), g('h4', 'OR4F16', [30])] }],
    [2, { center: 'm2', genes: [g('m1', 'Noc2l', [7]), g('m2', 'Samd11', [1]), g('m3', 'Klhl17', [9]), g('m4', 'Vmn2r129', [31])] }],
    // A RefSeq row: in no tree, so its genes join their namesakes' families.
    [3, { center: 'r2', genes: [g('r1', 'NOC2L', []), g('r2', 'SAMD11', []), g('r3', 'PLEKHN1', [])] }],
    [4, { error: 'not indexed' }],
  ])
  const byFamily = buildMatcher(rows, 'family')
  assert.equal(byFamily.group(rows.get(3).genes[0]), 'f:7')
  assert.equal(byFamily.related(rows.get(1).genes[0], rows.get(2).genes[0]), 'family')
  assert.equal(byFamily.related(rows.get(1).genes[0], rows.get(3).genes[0]), 'symbol')
  assert.equal(byFamily.related(rows.get(1).genes[3], rows.get(2).genes[3]), null)
  const { rows: counts, order } = sharedGroups(rows, byFamily)
  // NOC2L's family is beside the gene in three rows, KLHL17's in two; the rows' own gene
  // (SAMD11) and one-offs are not shared.
  assert.deepEqual(order, ['f:7', 'f:9'])
  assert.equal(counts.get('f:7'), 3)
  // 'Most shared' colours the first few only, from the family palette, never cycling.
  const top = groupColours(order, 'top', true)
  assert.deepEqual([...top], [['f:7', FAMILY_PALETTE.light[0]], ['f:9', FAMILY_PALETTE.light[1]]])
  assert.equal(groupColours(order, 'plain').size, 0)
  // By symbol alone, families are ignored.
  const bySymbol = buildMatcher(rows, 'symbol')
  assert.equal(bySymbol.group(rows.get(1).genes[0]), 's:noc2l')
  assert.equal(bySymbol.related(rows.get(1).genes[0], rows.get(2).genes[0]), 'symbol')
  // Only linked leaves are asked about.
  const nodes = [{ id: 0 }, { id: 1, leaf: {} }, { id: 2, leaf: {} }]
  const links = { 1: { status: 'linked', assembly: 'GCA_1', gene: { id: 'G1' } }, 2: { status: 'no_index', assembly: 'GCA_2' } }
  assert.deepEqual([...linkedLeaves(nodes, links)], [[1, 'GCA_1:G1']])
})

test('neighbourhood: rows link each gene once, tandem copies to the copy in the same place', async () => {
  const { buildMatcher, pairRows } = await import('../src/components/gene-trees/neighbourhoodMatch.js')
  const g = (id, name, families = [5]) => ({ id, name, families })
  // Upper: A A' C  (two copies of family 5 before the tree gene); lower: X C A (one copy, after it).
  const upper = { center: 'u3', genes: [g('u1', 'A'), g('u2', 'A'), g('u3', 'C', [1])] }
  const lower = { center: 'l2', genes: [g('l1', 'X', [8]), g('l2', 'C', [1]), g('l3', 'A')] }
  const matcher = buildMatcher(new Map([[1, upper], [2, lower]]), 'family')
  const pairs = pairRows(upper, lower, matcher)
  // C to C; lower's single A to the upper copy nearest its place (one before the gene, not two).
  assert.deepEqual(pairs.map(({ a, b, via }) => [a, b, via]), [[2, 1, 'family'], [1, 2, 'family']])
})

test('neighbourhood: a data column aligns the column at the tips and pushes every label past it', async () => {
  const { labelScreenX } = await import('../src/components/gene-trees/paintTree.js')
  const index = indexTree(TREE)
  const plain = layoutTree(index, emptyViewState(), { levelWidth: 20 })
  const withData = layoutTree(index, emptyViewState(), { levelWidth: 20, dataColumn: 300 })
  assert.equal(plain.alignX, undefined)
  const tips = withData.items.filter(i => i.kind === 'leaf')
  assert.equal(withData.alignX, Math.max(...tips.map(i => i.x)))
  const t = { k: 1, kx: 1, x: 0, y: 0 }
  // Every label starts at one x, the column's width past the furthest tip.
  const starts = new Set(tips.map(i => labelScreenX(withData, t, i)))
  assert.deepEqual([...starts], [withData.alignX + 300])
  const flipped = layoutTree(index, emptyViewState(), { levelWidth: 20, dataColumn: 300, flipHorizontal: true })
  assert.deepEqual([...new Set(flipped.items.filter(i => i.kind === 'leaf').map(i => labelScreenX(flipped, t, i)))], [flipped.alignX - 300])
})
