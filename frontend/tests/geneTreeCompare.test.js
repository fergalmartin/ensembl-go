import assert from 'node:assert/strict'
import test from 'node:test'

import { agreement, compareLinks, currentCrossings, matchKeys, untangle } from '../src/components/gene-trees/compareTrees.js'
import { emptyViewState, indexTree } from '../src/components/gene-trees/treeModel.js'
import { forestTree } from '../src/components/gene-trees/workspace.js'

// A fragment from a Newick-ish nested array: a string is a leaf (its species, symbol and
// gene are derived from it), an array a clade.
function fragment(id, shape, leafOf = name => ({ species: name, symbol: name.toUpperCase(), gene_id: `ENSG000000${name}.1`, label: name })) {
  const nodes = []
  const stack = [[shape, -1]]
  while (stack.length) {
    const [item, parent] = stack.pop()
    const node = { id: nodes.length, parent, children: [], branch_length: 1, leaf: typeof item === 'string' ? leafOf(item) : null }
    nodes.push(node)
    if (parent >= 0) nodes[parent].children.push(node.id)
    if (Array.isArray(item)) for (let i = item.length - 1; i >= 0; i--) stack.push([item[i], node.id])
  }
  // Children were pushed in reverse; restore left-to-right.
  for (const node of nodes) node.children.sort((a, b) => a - b)
  return { id, name: '', source: {}, nodes }
}

function pair(shapeA, shapeB, leafOf) {
  const layer = { fragments: [fragment('A', shapeA, leafOf), fragment('B', shapeB, leafOf)] }
  const forest = forestTree(layer)
  const index = indexTree(forest)
  const [rootA, rootB] = forest.nodes[0].children
  return { index, rootA, rootB }
}
const names = (index, ids) => ids.map(id => index.nodes[id].leaf.label)

test('match keys: species spelt either way, symbols by case, IDs without versions', () => {
  assert.deepEqual(matchKeys({ species: 'Homo_sapiens' }, 'species'), matchKeys({ species: 'homo sapiens' }, 'species'))
  assert.deepEqual(matchKeys({ symbol: 'Brca2' }, 'symbol'), ['BRCA2'])
  assert.deepEqual(matchKeys({ symbol: '' }, 'symbol'), [])
  assert.deepEqual(matchKeys({ gene_id: 'ENSG00000139618.17', protein_id: 'ENSP00000369497.3' }, 'id'), ['ENSG00000139618', 'ENSP00000369497'])
})

test('links: one-to-one where each leaf has one partner, every copy to every copy otherwise', () => {
  // Species: two human genes on the left, one on the right; mouse once each; fish only left.
  const leafOf = name => ({ species: name.replace(/\d$/, ''), label: name })
  const { index, rootA, rootB } = pair([['human1', 'human2'], ['mouse', 'fish']], ['human', 'mouse'], leafOf)
  const { links, onlyA, onlyB } = compareLinks(index, rootA, rootB, 'species')
  const shown = links.map(l => `${index.nodes[l.a].leaf.label}-${index.nodes[l.b].leaf.label}${l.oneToOne ? '' : '*'}`).sort()
  assert.deepEqual(shown, ['human1-human*', 'human2-human*', 'mouse-mouse'])
  assert.deepEqual(names(index, onlyA), ['fish'])
  assert.deepEqual(onlyB, [])
})

test('agreement: the same tree shares every clade, however it is rooted', () => {
  const same = pair([[['a', 'b'], 'c'], ['d', 'e']], [[['a', 'b'], 'c'], ['d', 'e']])
  const sameLinks = compareLinks(same.index, same.rootA, same.rootB, 'species').links
  const result = agreement(same.index, same.rootA, same.rootB, sameLinks)
  assert.equal(result.conflict.size, 0)
  assert.equal(result.stats.shared, result.stats.cladesA)
  assert.equal(result.unsettled.size, 0)
  // Rerooted on d: (d,(e,(c,(a,b)))) has the same unrooted splits.
  const rerooted = pair([[['a', 'b'], 'c'], ['d', 'e']], ['d', ['e', ['c', ['a', 'b']]]])
  const rerootedLinks = compareLinks(rerooted.index, rerooted.rootA, rerooted.rootB, 'species').links
  assert.equal(agreement(rerooted.index, rerooted.rootA, rerooted.rootB, rerootedLinks).conflict.size, 0)
})

test('agreement: one leaf moved conflicts only on the branches along its way', () => {
  // Left: ((a,b),(c,(d,e)),f); right: e moved next to a.
  const { index, rootA, rootB } = pair([['a', 'b'], ['c', ['d', 'e']], 'f'], [[['a', 'e'], 'b'], ['c', 'd'], 'f'])
  const { links } = compareLinks(index, rootA, rootB, 'species')
  const result = agreement(index, rootA, rootB, links)
  assert.ok(result.conflict.size > 0)
  assert.ok(result.stats.shared < result.stats.cladesA)
  // f is in no conflicting clade on either side.
  const f = links.find(l => index.nodes[l.a].leaf.label === 'f')
  assert.ok(!result.unsettled.has(f.a))
  const e = links.find(l => index.nodes[l.a].leaf.label === 'e')
  assert.ok(result.unsettled.has(e.a) && result.unsettled.has(e.b))
})

test('agreement: shared clades colour their lines by group', () => {
  const { index, rootA, rootB } = pair([['a', 'b'], ['c', 'd'], ['e', 'f']], [['a', 'b'], ['c', 'd'], ['e', 'f']])
  const { links } = compareLinks(index, rootA, rootB, 'species')
  const { groups, groupCount } = agreement(index, rootA, rootB, links)
  assert.equal(groupCount, 3)
  for (const link of links) assert.equal(groups.get(link.a), groups.get(link.b))
  const of = label => groups.get(links.find(l => index.nodes[l.a].leaf.label === label).a)
  assert.equal(of('a'), of('b'))
  assert.notEqual(of('a'), of('c'))
})

test('untangle: a flipped copy is put back with no lines crossing', () => {
  const { index, rootA, rootB } = pair([['a', 'b'], [['c', 'd'], 'e']], [[['d', 'c'], 'e'], ['b', 'a']])
  const { links, partners } = compareLinks(index, rootA, rootB, 'species')
  const view = emptyViewState()
  assert.ok(currentCrossings(index, view, rootA, rootB, links) > 0)
  const result = untangle(index, view, rootA, rootB, links, partners)
  assert.equal(result.after, 0)
  assert.equal(currentCrossings(index, result.view, rootA, rootB, links), 0)
})

test('layout: a mirrored subtree points back the other way, its root on the right', async () => {
  const { layoutTree, sideOf } = await import('../src/components/gene-trees/treeLayout.js')
  const layer = { fragments: [fragment('A', [['a', 'b'], 'c']), fragment('B', [['a', 'b'], 'c'])] }
  const forest = forestTree(layer)
  const index = indexTree(forest)
  const plain = layoutTree(index, emptyViewState(), {})
  const lay = layoutTree(index, emptyViewState(), { mirrorFragments: new Set(['B']) })
  const [rootA, rootB] = forest.nodes[0].children
  const tipsOf = (layout, root) => layout.items.filter(item => item.kind === 'leaf' && item.lane === layout.byId.get(root).lane)
  // A is as it was; B's tips are left of its root by as much as they were right of it.
  for (const item of tipsOf(lay, rootA)) assert.equal(item.x, plain.byId.get(item.id).x)
  const root = lay.byId.get(rootB).x
  for (const item of tipsOf(lay, rootB)) {
    assert.ok(item.x < root)
    assert.equal(root - item.x, plain.byId.get(item.id).x - plain.byId.get(rootB).x)
    assert.equal(sideOf(lay, item).flipHorizontal, true)
  }
  assert.equal(sideOf(lay, lay.byId.get(rootA)).flipHorizontal, false)
  // Its clades reach towards its tips, leftwards.
  assert.ok(lay.byId.get(rootB).reach < root)
})

test('a saved comparison is kept only while both its subtrees are', async () => {
  const { validateWorkspace } = await import('../src/components/gene-trees/workspace.js')
  const frag = id => ({ ...fragment(id, ['a', 'b']) })
  const saved = { layers: [{ id: 'L1', name: 'One', color: '#112233', fragments: [frag('F1'), frag('F2')],
    compare: { a: 'F1', b: 'F2', by: 'symbol', facing: true, saved: { F1: { x: 1, y: 2 }, F2: null, gone: { x: 0, y: 0 } } } },
  { id: 'L2', name: 'Two', color: '#112233', fragments: [frag('F3')], compare: { a: 'F3', b: 'F9' } }], active: 'L1', original: false }
  const ws = validateWorkspace(saved)
  assert.deepEqual(ws.layers[0].compare, { a: 'F1', b: 'F2', by: 'symbol', facing: true, scaleX: 1, disagreement: true, saved: { F1: { x: 1, y: 2 }, F2: null } })
  assert.equal(ws.layers[1].compare, undefined)
})

test('crossings: counted as pairs of lines in opposite orders, ends shared never crossing', async () => {
  const { crossings } = await import('../src/components/gene-trees/compareTrees.js')
  const brute = (links, rank) => {
    let n = 0
    for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
      if ((rank.get(links[i].a) - rank.get(links[j].a)) * (rank.get(links[i].b) - rank.get(links[j].b)) < 0) n += 1
    }
    return n
  }
  let seed = 7
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let trial = 0; trial < 30; trial++) {
    const links = Array.from({ length: 1 + rand(60) }, () => ({ a: `a${rand(20)}`, b: `b${rand(20)}` }))
    const rank = new Map()
    for (let i = 0; i < 20; i++) { rank.set(`a${i}`, rand(20)); rank.set(`b${i}`, rand(20)) }
    assert.equal(crossings(links, rank), brute(links, rank))
  }
})
