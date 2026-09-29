/**
 * Subtree layers: the workspace the user builds trees in.
 *
 * Modelled on the Alignment Explorer's layers (alignment-explorer/layers.js). The tree
 * being browsed is the Original: never stored, never edited, shown as a pseudo-layer in
 * front of the user's own. A layer is a named, coloured set of fragments — small trees
 * copied out of any tree in the library (see subtreeOps.js) — so one layer can hold a
 * SAMD11 clade beside a BRCA2 clade.
 *
 * Only the layers and which one is showing are saved. Picks, the current tool and any
 * drag in progress are view state, kept elsewhere, and never saved or undone.
 */
import { BUILTIN_GENOME_COLOR_PALETTE } from '../../genomeColorSchemes.js'

export const WORKSPACE_VERSION = 1
export const MAX_LAYERS = 100
export const PALETTE = BUILTIN_GENOME_COLOR_PALETTE

let counter = 0
export const newId = prefix => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const emptyWorkspace = () => ({ version: WORKSPACE_VERSION, layers: [], active: '', original: true })

export function createLayer(name, index, fragments = []) {
  return { id: newId('L'), name, color: PALETTE[index % PALETTE.length], fragments }
}

/** One past the highest "Layer N", never the count: deleting Layer 2 does not bring it back. */
export function nextLayerName(layers, prefix = 'Layer') {
  const pattern = new RegExp(`^${prefix} (\\d+)$`)
  const top = layers.reduce((max, layer) => Math.max(max, Number(pattern.exec(layer.name)?.[1] || 0)), 0)
  return `${prefix} ${top + 1}`
}

export function createFragment(nodes, source, name = '', pos = null) {
  return { id: newId('F'), name, source, nodes, ...(pos ? { pos } : {}) }
}

export const activeLayer = ws => (ws.original ? null : ws.layers.find(l => l.id === ws.active) || null)

export function layerStats(layer) {
  let genes = 0, grafts = 0
  const species = new Set()
  const sources = new Set()
  for (const fragment of layer?.fragments || []) {
    sources.add(`${fragment.source?.collectionId}:${fragment.source?.treeId}`)
    for (const node of fragment.nodes) {
      if (node.leaf) {
        genes += 1
        species.add(node.leaf.species || node.leaf.label)
      }
      if (node.graft && node.parent !== -1) grafts += 1
    }
  }
  return { fragments: layer?.fragments?.length || 0, genes, species: species.size, grafts, sources: sources.size }
}

// ── transitions (each returns a new workspace) ──

export function addLayer(ws, fragments = [], name = null) {
  const layer = createLayer(name || nextLayerName(ws.layers), ws.layers.length, fragments)
  return { ws: { ...ws, layers: [...ws.layers, layer], active: layer.id, original: false }, layer }
}

export function updateLayer(ws, id, fn) {
  return { ...ws, layers: ws.layers.map(layer => (layer.id === id ? fn(layer) : layer)) }
}

export function addFragments(ws, id, fragments) {
  return updateLayer(ws, id, layer => ({ ...layer, fragments: [...layer.fragments, ...fragments] }))
}

export function removeLayer(ws, id) {
  const layers = ws.layers.filter(layer => layer.id !== id)
  const showingIt = !ws.original && ws.active === id
  return { ...ws, layers, active: showingIt ? (layers[0]?.id || '') : ws.active, original: ws.original || showingIt }
}

/** Drop layer `from` onto layer `to`: its fragments join `to`, and it goes. */
export function mergeLayers(ws, from, to) {
  const source = ws.layers.find(l => l.id === from)
  if (!source || from === to) return ws
  const merged = addFragments(ws, to, source.fragments)
  return { ...merged, layers: merged.layers.filter(l => l.id !== from), active: to, original: false }
}

export function duplicateLayer(ws, id) {
  const source = ws.layers.find(l => l.id === id)
  if (!source) return ws
  const copy = createLayer(`${source.name} copy`, ws.layers.length,
    source.fragments.map(f => ({ ...f, id: newId('F'), nodes: f.nodes.map(n => ({ ...n, children: [...n.children] })) })))
  return { ...ws, layers: [...ws.layers, copy], active: copy.id, original: false }
}

/** Replace one fragment with zero or more (the result of pruning or splitting it). */
export function replaceFragment(ws, layerId, fragmentId, nodesList) {
  return updateLayer(ws, layerId, layer => {
    const at = layer.fragments.findIndex(f => f.id === fragmentId)
    if (at < 0) return layer
    const old = layer.fragments[at]
    const plain = { ...old }
    delete plain.pos
    // The first piece is the fragment carrying on (its name and place); the rest are new.
    const next = nodesList.filter(Boolean).map((nodes, i) => (i === 0
      ? { ...old, nodes }
      : { ...plain, id: newId('F'), name: '', nodes }))
    return { ...layer, fragments: [...layer.fragments.slice(0, at), ...next, ...layer.fragments.slice(at + 1)] }
  })
}

// ── saved workspaces ──

function validFragment(fragment) {
  const nodes = fragment?.nodes
  if (!Array.isArray(nodes) || !nodes.length || nodes[0].parent !== -1) return false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node?.id !== i || !Array.isArray(node.children)) return false
    if (i > 0 && !(node.parent >= 0 && node.parent < nodes.length && nodes[node.parent].children.includes(i))) return false
    if (node.children.some(c => !(c > 0 && c < nodes.length && nodes[c].parent === i))) return false
  }
  return true
}

/** A saved workspace, checked: bad layers or fragments are dropped rather than trusted. */
export function validateWorkspace(saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.layers)) return emptyWorkspace()
  const layers = saved.layers
    .filter(layer => layer && typeof layer.id === 'string' && layer.id !== 'original' && typeof layer.name === 'string')
    .slice(0, MAX_LAYERS)
    .map((layer, i) => ({
      id: layer.id, name: layer.name.slice(0, 120),
      color: /^#[0-9a-f]{6}$/i.test(layer.color || '') ? layer.color : PALETTE[i % PALETTE.length],
      fragments: (Array.isArray(layer.fragments) ? layer.fragments : []).filter(validFragment).map(saved => {
        // Older saves could leave a graft mark on a root, where there is no join to mark.
        const fragment = saved.nodes[0]?.graft ? { ...saved, nodes: saved.nodes.map((n, i) => (i === 0 ? { ...n, graft: undefined } : n)) } : saved
        // Where the user put it, if they moved it: world units, finite, or not at all.
        const pos = fragment.pos
        const rest = { ...fragment }
        delete rest.pos
        return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { ...rest, pos: { x: pos.x, y: pos.y } } : rest
      }),
      ...(layer.overlay === false ? { overlay: false } : {}),
    }))
  const active = layers.some(l => l.id === saved.active) ? saved.active : (layers[0]?.id || '')
  return { version: WORKSPACE_VERSION, layers, active, original: !layers.length || saved.original !== false }
}

// ── drawing a layer ──

/**
 * A layer as one tree the existing layout and painter can draw: an invisible root
 * (`virtual: true`) holding each fragment. Node ids are renumbered; `fragmentOf` maps a
 * drawn node back to [fragment index, node id within the fragment], and `links` carries
 * each leaf's captured link to a local genome.
 */
export function forestTree(layer) {
  const nodes = [{ id: 0, parent: -1, children: [], virtual: true, branch_length: null, event: null, taxon: null, leaf: null }]
  const fragmentOf = new Map()
  const links = {}
  ;(layer?.fragments || []).forEach((fragment, f) => {
    const base = nodes.length
    for (const node of fragment.nodes) {
      const id = node.id + base
      nodes.push({
        ...node, id,
        parent: node.parent === -1 ? 0 : node.parent + base,
        children: node.children.map(c => c + base),
        fragRoot: node.parent === -1 ? fragment.id : undefined,
        fragPos: node.parent === -1 && fragment.pos ? fragment.pos : undefined,
      })
      fragmentOf.set(id, [f, node.id])
      if (node.link) links[id] = node.link
    }
    nodes[0].children.push(base)
  })
  return { nodes, links, fragmentOf, rooted: true, virtual: true }
}

/** Counts for a layer's forest, in the shape the drawer shows for a tree. */
export function forestStats(nodes) {
  const stats = { genes: 0, species: 0, speciation: 0, duplication: 0, dubious: 0, gene_split: 0, grafts: 0,
    has_branch_lengths: false }
  const species = new Set()
  for (const node of nodes) {
    if (node.virtual) continue
    if (node.leaf) {
      stats.genes += 1
      if (node.leaf.species) species.add(node.leaf.species)
    } else if (node.event && node.event in stats) stats[node.event] += 1
    if (node.graft && !node.fragRoot) stats.grafts += 1
    if (node.parent > 0 && node.branch_length) stats.has_branch_lengths = true
  }
  stats.species = species.size
  return stats
}
