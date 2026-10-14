import assert from 'node:assert/strict'
import test from 'node:test'
import { extract, graft } from '../src/components/gene-trees/subtreeOps.js'
import { forestTree } from '../src/components/gene-trees/workspace.js'
import { layerLinkRequests, leafLinkKey, localGenomeLinkKey, resolveLayerLinks } from '../src/components/gene-trees/leafLinks.js'

const source = { collectionId: 'original', treeId: 't' }
const old = { status: 'unresolved' }
const node = { id: 0, parent: -1, children: [], src: 4, srcTree: 'original:t',
  leaf: { label: 'human', species: 'Homo sapiens', gene_id: 'ENSG1' }, link: old }
const layer = { fragments: [{ id: 'F1', source, nodes: [node] }] }

test('restored layer uses live links without altering its saved nodes, ids or source', async () => {
  const saved = JSON.stringify(layer)
  const requests = layerLinkRequests([layer])
  const live = { status: 'linked', assembly: 'GCA_1', gene: { id: 'ENSG1' } }
  const { links } = await resolveLayerLinks(requests, async () => ({ links: { 0: live }, pending: false }))
  const resolve = (node, source) => links.get(leafLinkKey(node, source))
  const forest = forestTree(layer, resolve)
  assert.deepEqual(forest.links[1], live)
  assert.deepEqual(forest.fragmentOf.get(1), [0, 0])
  assert.equal(JSON.stringify(layer), saved)
  assert.deepEqual(extract(forest.nodes, [1])[0][0].leaf, node.leaf)
  links.set(requests[0][0], old)
  assert.equal(forestTree(layer, resolve).links[1].status, 'unresolved')
})

test('grafted leaves use their own collection and duplicate copies share a lookup', () => {
  const other = { ...node, srcTree: 'other:t', link: undefined }
  const joined = graft([node], [other], 0, { mode: 'child' })
  const requests = layerLinkRequests([{ fragments: [{ source, nodes: joined }, layer.fragments[0]] }])
  assert.deepEqual(new Set(requests.map(([, request]) => request.collection_id)), new Set(['original', 'other']))
  assert.equal(requests.length, 2)
  const legacy = { ...node, srcTree: null }
  assert.equal(JSON.parse(leafLinkKey(legacy, source)).collection_id, 'original')
})

test('large workspaces resolve in bounded batches and report pending protein maps', async () => {
  const requests = Array.from({ length: 1001 }, (_, i) => [`key${i}`, { leaf: { label: `gene${i}` } }])
  const sizes = []
  const controller = new AbortController()
  const result = await resolveLayerLinks(requests, async (path, body, signal) => {
    assert.equal(path, '/resolve-links')
    assert.equal(signal, controller.signal)
    sizes.push(body.leaves.length)
    return { links: Object.fromEntries(body.leaves.map((entry, i) => [i, { status: 'pending', label: entry.leaf.label }])), pending: true }
  }, controller.signal)
  assert.deepEqual(sizes, [1000, 1])
  assert.equal(result.links.get('key1000').label, 'gene1000')
  assert.equal(result.pending, true)
})

test('annotation changes invalidate links while top-bar selection and colours do not', () => {
  const genome = { assembly: 'GCA_1', species_key: 'Homo_sapiens', files: { gff3: 'genes.gff' } }
  const before = localGenomeLinkKey([genome], '/data')
  assert.equal(localGenomeLinkKey([{ ...genome, color: '#123456', enabled: false }], '/data'), before)
  assert.notEqual(localGenomeLinkKey([{ ...genome, files: { ...genome.files, index: 'genes.db' } }], '/data'), before)
  assert.notEqual(localGenomeLinkKey([], '/data'), before)
})
