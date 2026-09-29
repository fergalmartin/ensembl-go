import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  extract, graft, leafDistances, mergeAsOriginal, mergeWithGrafts, pickClade, prune, reroot, splitAt, toNewick,
} from '../src/components/gene-trees/subtreeOps.js'

// ((A:1,B:2)AB:1,((C:1,D:1)CD:1,E:3)CDE:0.5)root — ids in pre-order.
function node(id, parent, children, bl, label) {
  return { id, parent, children, branch_length: bl, event: children.length ? 'speciation' : null,
    taxon: children.length ? { name: `n${id}` } : null, leaf: children.length ? null : { label, gene_id: `G${label}` } }
}
const TREE = [
  node(0, -1, [1, 4], null),
  node(1, 0, [2, 3], 1),
  node(2, 1, [], 1, 'A'),
  node(3, 1, [], 2, 'B'),
  node(4, 0, [5, 8], 0.5),
  node(5, 4, [6, 7], 1),
  node(6, 5, [], 1, 'C'),
  node(7, 5, [], 1, 'D'),
  node(8, 4, [], 3, 'E'),
]
const labels = fragment => fragment.filter(n => n.leaf).map(n => n.leaf.label).sort()

// Distances in the full tree, keyed by source id, to compare fragments against.
const FULL = leafDistances(TREE.map(n => ({ ...n, src: n.id })))
function assertExact(fragment) {
  for (const [key, d] of leafDistances(fragment)) {
    assert.ok(FULL.has(key), `unexpected pair ${key}`)
    assert.ok(Math.abs(FULL.get(key) - d) < 1e-9, `${key}: ${d} vs ${FULL.get(key)}`)
  }
}

test('extract keeps touched nodes as connected pieces, tidied, with exact distances', () => {
  // Touch A, the AB node, and C, D, E but not their parents: three pieces.
  const pieces = extract(TREE, [1, 2, 6, 7, 8])
  assert.deepEqual(pieces.map(labels), [['A'], ['C'], ['D'], ['E']])
  // AB with only A beneath it dissolves into A, carrying AB's branch as A's stem.
  assert.equal(pieces[0].length, 1)
  assert.equal(pieces[0][0].branch_length, 2)
  assert.equal(pieces[0][0].src, 2)
})

test('extract of a connected selection is one fragment with exact distances', () => {
  const [piece] = extract(TREE, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(labels(piece), ['A', 'B', 'C'])
  // CD and CDE each had one child left: dissolved.
  assert.equal(piece.filter(n => !n.leaf).length, 2)
  assertExact(piece)
})

test('whole clades and folded nodes bring everything beneath them', () => {
  assert.deepEqual(labels(extract(TREE, [4], { wholeClades: true })[0]), ['C', 'D', 'E'])
  assert.deepEqual(labels(extract(TREE, [0, 5], { folded: [5] })[0]), ['C', 'D'])
  assert.deepEqual(labels(pickClade(TREE, 1)[0]), ['A', 'B'])
})

test('links and source are carried on copied leaves', () => {
  const [piece] = pickClade(TREE, 1, { srcTree: 'c:t', links: { 2: { status: 'linked', assembly: 'GCA_1' } } })
  const a = piece.find(n => n.leaf?.label === 'A')
  assert.equal(a.link.assembly, 'GCA_1')
  assert.equal(a.srcTree, 'c:t')
})

test('prune removes clades and keeps the rest exact', () => {
  const [all] = pickClade(TREE, 0)
  const withoutC = prune(all, [all.find(n => n.leaf?.label === 'C').id])
  assert.deepEqual(labels(withoutC), ['A', 'B', 'D', 'E'])
  assertExact(withoutC)
  const cd = all.find(n => n.src === 5).id
  const withoutCD = prune(all, [cd])
  assert.deepEqual(labels(withoutCD), ['A', 'B', 'E'])
  assertExact(withoutCD)
  assert.equal(prune(all, [0]), null)
})

test('split then merge as in the original gives the original back', () => {
  const [all] = pickClade(TREE, 0, { srcTree: 'x' })
  const [rest, clade] = splitAt(all, all.find(n => n.src === 5).id)
  assert.deepEqual(labels(rest), ['A', 'B', 'E'])
  assert.deepEqual(labels(clade), ['C', 'D'])
  assertExact(rest)
  assertExact(clade)
  const { fragment, skipped } = mergeAsOriginal(TREE, [rest, clade], 'x')
  assert.equal(skipped, 0)
  assert.equal(fragment.length, TREE.length)
  assert.equal(toNewick(fragment), toNewick(all))
})

test('merging two distant pieces rebuilds only what connects them', () => {
  const [a] = pickClade(TREE, 2)
  const [c] = pickClade(TREE, 6)
  const { fragment } = mergeAsOriginal(TREE, [a, c])
  assert.deepEqual(labels(fragment), ['A', 'C'])
  assert.equal(fragment[0].src, 0, 'joined at their common ancestor')
  assertExact(fragment)
  assert.equal(fragment[0].taxon.name, 'n0', 'the connecting node keeps its source taxon')
})

test('graft attaches a fragment on a node or halfway along a branch, and says so', () => {
  const [ab] = pickClade(TREE, 1)
  const [cd] = pickClade(TREE, 5)
  const onNode = graft(cd, ab, 0)
  assert.deepEqual(labels(onNode), ['A', 'B', 'C', 'D'])
  assert.equal(onNode[0].children.length, 3)
  assert.equal(onNode.filter(n => n.graft).length, 1)
  const a = ab.find(n => n.leaf?.label === 'A').id
  const onBranch = graft(cd, ab, a, { onBranch: true })
  const junction = onBranch.find(n => !n.leaf && n.children.length === 2 && n.src === null)
  assert.ok(junction, 'a new node splits the branch')
  const leafA = onBranch.find(n => n.leaf?.label === 'A')
  assert.equal(leafA.branch_length + junction.branch_length, 1, 'the split branch keeps its length')
  assert.match(toNewick(onBranch, { nhx: true }), /GRAFT=Y/)
})

test('reroot keeps every leaf distance', () => {
  const [all] = pickClade(TREE, 0)
  const e = all.find(n => n.leaf?.label === 'E').id
  const rerooted = reroot(all, e)
  assert.deepEqual(labels(rerooted), ['A', 'B', 'C', 'D', 'E'])
  assert.ok(rerooted[0].children.some(c => rerooted[c].leaf?.label === 'E'), 'E hangs off the new root')
  assertExact(rerooted)
})

test('on a real Compara tree, pieces and merges stay exact', () => {
  const doc = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/gene_trees/brca2_ensembl.json', import.meta.url)))
  const nodes = []
  const stack = [[doc.tree, -1]]
  while (stack.length) {
    const [source, parent] = stack.pop()
    const id = nodes.length
    nodes.push({ id, parent, children: [], branch_length: source.branch_length ?? null, event: source.events?.type ?? null,
      taxon: source.taxonomy && source.children ? { name: source.taxonomy.scientific_name } : null,
      leaf: source.children ? null : { label: source.id.accession, gene_id: source.id.accession } })
    if (parent >= 0) nodes[parent].children.push(id)
    for (const child of [...(source.children || [])].reverse()) stack.push([child, id])
  }
  const full = leafDistances(nodes.map(n => ({ ...n, src: n.id })))
  const exact = fragment => {
    for (const [key, d] of leafDistances(fragment)) assert.ok(Math.abs(full.get(key) - d) < 1e-6, key)
  }
  // A scattered selection: every fifth node.
  const pieces = extract(nodes, nodes.filter(n => n.id % 5 === 0).map(n => n.id))
  assert.ok(pieces.length > 1)
  pieces.forEach(exact)
  const { fragment, skipped } = mergeAsOriginal(nodes, pieces)
  assert.equal(skipped, 0)
  exact(fragment)
  const leafCount = pieces.reduce((n, p) => n + p.filter(x => x.leaf).length, 0)
  assert.equal(fragment.filter(n => n.leaf).length, leafCount)
})

test('merge keeps what was grafted on, re-grafting it where it hung', () => {
  const stamped = TREE.map(n => ({ ...n, src: n.id, srcTree: 'T' }))
  const [ab] = extract(stamped, [1, 2, 3], { srcTree: 'T' })
  const [cd] = extract(stamped, [5, 6, 7], { srcTree: 'T' })
  // A gene from another tree grafted onto the branch above B, and one onto C's parent.
  const other = [{ id: 0, parent: -1, children: [], branch_length: 0.7, leaf: { label: 'X' }, src: 0, srcTree: 'U' }]
  const other2 = [{ id: 0, parent: -1, children: [], branch_length: 0.4, leaf: { label: 'Y' }, src: 0, srcTree: 'U' }]
  const bInAb = ab.findIndex(n => n.leaf?.label === 'B')
  const withX = graft(other, ab, bInAb, { onBranch: true })
  const withY = graft(other2, cd, 0)
  const { fragment, leftovers, lost } = mergeWithGrafts(stamped, [withX, withY], 'T')
  assert.equal(lost, 0)
  assert.equal(leftovers.length, 0)
  assert.deepEqual(labels(fragment), ['A', 'B', 'C', 'D', 'X', 'Y'])
  // Without the grafts, what is left is exactly the original's induced tree.
  const bare = prune(fragment, fragment.filter(n => n.graft).map(n => n.id))
  assertExact(bare)
  // X still hangs on B's branch (a junction whose other child is B); Y still under CD.
  const x = fragment.find(n => n.leaf?.label === 'X')
  const junction = fragment[x.parent]
  assert.equal(junction.src, null)
  assert.ok(junction.children.map(c => fragment[c]).some(n => n.leaf?.label === 'B'))
  const y = fragment.find(n => n.leaf?.label === 'Y')
  assert.equal(fragment[y.parent].src, 5)
  assert.ok(x.graft && y.graft)
  // The result is new: nothing in it is one of the inputs' node objects.
  for (const n of fragment) assert.ok(!withX.includes(n) && !withY.includes(n))
})

test('merge sets aside a graft whose anchor was pruned away', () => {
  const stamped = TREE.map(n => ({ ...n, src: n.id, srcTree: 'T' }))
  const [ab] = extract(stamped, [1, 2, 3], { srcTree: 'T' })
  const [e] = extract(stamped, [8], { srcTree: 'T' })
  const x = [{ id: 0, parent: -1, children: [], branch_length: 0.2, leaf: { label: 'X' }, src: 0, srcTree: 'U' }]
  // Grafted onto A's branch, then A pruned away: X's anchor is gone.
  let withX = graft(x, ab, ab.findIndex(n => n.leaf?.label === 'A'), { onBranch: true })
  withX = prune(withX, [withX.findIndex(n => n.leaf?.label === 'A')])
  const { fragment, leftovers } = mergeWithGrafts(stamped, [withX, e], 'T')
  assert.deepEqual(labels(fragment), ['B', 'E'])
  assert.deepEqual(leftovers.map(labels), [['X']])
})

test('a root is never a graft: cutting or pruning down to a grafted piece clears its mark', () => {
  const stamped = TREE.map(n => ({ ...n, src: n.id, srcTree: 'T' }))
  const [ab] = extract(stamped, [1, 2, 3], { srcTree: 'T' })
  const x = [{ id: 0, parent: -1, children: [1, 2], branch_length: 0.7, leaf: null, srcTree: 'U', src: 0 },
    { id: 1, parent: 0, children: [], branch_length: 0.1, leaf: { label: 'X1' }, srcTree: 'U', src: 1 },
    { id: 2, parent: 0, children: [], branch_length: 0.1, leaf: { label: 'X2' }, srcTree: 'U', src: 2 }]
  const joined = graft(x, ab, ab.findIndex(n => n.leaf?.label === 'B'), { onBranch: true })
  const piece = joined.findIndex(n => n.srcTree === 'U' && !n.leaf)
  assert.equal(joined[piece].graft, true)
  const [, cut] = splitAt(joined, piece)
  assert.ok(!cut.some(n => n.graft))
  const left = prune(joined, [joined.findIndex(n => n.leaf?.label === 'A'), joined.findIndex(n => n.leaf?.label === 'B')])
  assert.ok(!left.some(n => n.graft))
})

test('merge puts a piece grafted from the same tree back where the tree has it', () => {
  const stamped = TREE.map(n => ({ ...n, src: n.id, srcTree: 'T' }))
  const [ab] = extract(stamped, [1, 2, 3], { srcTree: 'T' })
  const [e] = extract(stamped, [8], { srcTree: 'T' })
  // E grafted by hand onto A's branch: a graft, but E has a true place in T.
  const joined = graft(e, ab, ab.findIndex(n => n.leaf?.label === 'A'), { onBranch: true })
  const { fragment, leftovers } = mergeWithGrafts(stamped, [joined], 'T')
  assert.equal(leftovers.length, 0)
  assert.ok(!fragment.some(n => n.graft))
  assertExact(fragment)
})
