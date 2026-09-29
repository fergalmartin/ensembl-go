/**
 * Pruning and grafting: the operations a subtree layer is built with.
 *
 * A fragment is a small tree in the same node shape the view draws (id, parent,
 * children, branch_length, event, taxon, leaf), stored in pre-order with its root at
 * index 0. Every node that came from a source tree keeps `src`, its id there, and
 * `srcTree`, which tree that was; nodes this module invents have `src: null`.
 *
 * Branch lengths are kept exact wherever the source tree allows. Removing nodes leaves
 * single-child nodes behind, and those are dissolved with their branch lengths added
 * together, so the distance between any two remaining leaves is what it was. Merging
 * "as in the original" rebuilds the connecting part of the source tree, which is also
 * exact. Only a graft invents structure; it is flagged (`graft: true`) so it can be
 * drawn and exported as such.
 *
 * Everything here is pure and iterative: trees from Compara are deep enough to exhaust
 * the call stack.
 */

const plainNode = node => ({
  id: node.id, parent: node.parent, children: [...(node.children || [])],
  name: node.name ?? null, branch_length: node.branch_length ?? null, support: node.support ?? null,
  event: node.event ?? null, event_inferred: node.event_inferred ?? undefined, taxon: node.taxon ?? null,
  leaf: node.leaf ?? null, src: node.src ?? null, srcTree: node.srcTree ?? null, graft: node.graft || undefined,
  link: node.link ?? undefined,
})

/** A working copy: id -> node, with a root id. */
const toWork = (nodes, rootId = 0) => ({ map: new Map(nodes.map(n => [n.id, plainNode(n)])), root: rootId })

/** Pre-order, renumbered from 0; the root keeps its stem length (its branch to its old parent). */
function compact(work) {
  const order = []
  const stack = [work.root]
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    const children = work.map.get(id).children
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  const remap = new Map(order.map((old, i) => [old, i]))
  return order.map((old, i) => {
    const node = work.map.get(old)
    // A root hangs from nothing, so it cannot be a graft: whatever it was grafted onto is gone.
    return { ...node, id: i, parent: i === 0 ? -1 : remap.get(node.parent), children: node.children.map(c => remap.get(c)),
      graft: i === 0 ? undefined : node.graft }
  })
}

const addLengths = (a, b) => (a === null || a === undefined) && (b === null || b === undefined) ? null : (a || 0) + (b || 0)

/**
 * Dissolve every internal node left with one child (adding its branch length to the
 * child's), and drop internal nodes left with none (they hold no gene). The root too:
 * a root with one child hands the tree, and its own stem, to that child.
 */
function tidy(work) {
  const post = []
  const stack = [work.root]
  while (stack.length) {
    const id = stack.pop()
    post.push(id)
    stack.push(...work.map.get(id).children)
  }
  post.reverse()
  for (const id of post) {
    const node = work.map.get(id)
    if (!node) continue
    const isLeaf = Boolean(node.leaf)
    if (!isLeaf && node.children.length === 0) {
      detach(work, id)
      continue
    }
    if (!isLeaf && node.children.length === 1) {
      const child = work.map.get(node.children[0])
      child.branch_length = addLengths(node.branch_length, child.branch_length)
      if (node.graft) child.graft = true
      replace(work, id, child.id)
    }
  }
  return work
}

function detach(work, id) {
  const node = work.map.get(id)
  if (node.parent !== -1 && work.map.has(node.parent)) {
    const parent = work.map.get(node.parent)
    parent.children = parent.children.filter(c => c !== id)
  }
  if (work.root === id) work.root = null
  work.map.delete(id)
}

function replace(work, id, withId) {
  const node = work.map.get(id)
  const child = work.map.get(withId)
  child.parent = node.parent
  if (node.parent !== -1 && work.map.has(node.parent)) {
    const parent = work.map.get(node.parent)
    parent.children = parent.children.map(c => (c === id ? withId : c))
  }
  if (work.root === id) {
    work.root = withId
    child.parent = -1
  }
  work.map.delete(id)
}

function descendantsOf(map, id) {
  const out = []
  const stack = [...(map.get(id)?.children || [])]
  while (stack.length) {
    const next = stack.pop()
    out.push(next)
    stack.push(...(map.get(next)?.children || []))
  }
  return out
}

/** Mark nodes copied out of a source tree with where they came from. */
function stamp(nodes, srcTree, links) {
  return nodes.map(node => ({
    ...node,
    src: node.src ?? node.id,
    srcTree: node.srcTree ?? srcTree ?? null,
    link: node.link ?? (links && links[node.id]) ?? undefined,
  }))
}

/**
 * Copy what is touched out of a tree, as connected fragments.
 *
 * `ids` are the touched nodes. Each maximal connected piece of them becomes a fragment,
 * tidied. With `wholeClades`, every touched node first brings everything beneath it;
 * `folded` nodes (collapsed pills, zoomed-out wedges) always do, since they stand for
 * their clade.
 */
export function extract(sourceNodes, ids, { wholeClades = false, folded = [], srcTree = null, links = null } = {}) {
  const nodes = stamp(sourceNodes, srcTree, links)
  const map = new Map(nodes.map(n => [n.id, n]))
  const chosen = new Set([...ids].filter(id => map.has(id)))
  const expandFrom = wholeClades ? [...chosen] : [...chosen].filter(id => folded.includes?.(id) || folded.has?.(id))
  for (const id of expandFrom) for (const d of descendantsOf(map, id)) chosen.add(d)
  const roots = [...chosen].filter(id => !chosen.has(map.get(id).parent)).sort((a, b) => a - b)
  const fragments = []
  for (const root of roots) {
    const work = { map: new Map(), root }
    const stack = [root]
    while (stack.length) {
      const id = stack.pop()
      const node = plainNode(map.get(id))
      node.children = node.children.filter(c => chosen.has(c))
      if (id === root) node.parent = -1
      work.map.set(id, node)
      stack.push(...node.children)
    }
    tidy(work)
    if (work.root !== null && work.map.size) fragments.push(compact(work))
  }
  return fragments
}

/** The whole clade under a node. */
export function pickClade(sourceNodes, id, options = {}) {
  const map = new Map(sourceNodes.map(n => [n.id, n]))
  if (!map.has(id)) return []
  return extract(sourceNodes, [id, ...descendantsOf(map, id)], options)
}

/** Remove the clades under `ids` (a leaf is its own clade). Returns the fragment left, or null. */
export function prune(fragment, ids) {
  const work = toWork(fragment)
  for (const id of ids) {
    if (!work.map.has(id)) continue
    for (const d of descendantsOf(work.map, id)) work.map.delete(d)
    if (id === work.root) return null
    detach(work, id)
  }
  tidy(work)
  return work.root === null ? null : compact(work)
}

/** Cut the clade at `id` off into a fragment of its own: [what is left, the clade]. */
export function splitAt(fragment, id) {
  if (id === 0 || !fragment[id]) return [fragment]
  const work = toWork(fragment)
  const clade = { map: new Map(), root: id }
  for (const nodeId of [id, ...descendantsOf(work.map, id)]) clade.map.set(nodeId, { ...work.map.get(nodeId) })
  for (const nodeId of clade.map.keys()) if (nodeId !== id) work.map.delete(nodeId)
  // Unhook it from its parent first: detaching reads the parent it still points at.
  detach(work, id)
  clade.map.get(id).parent = -1
  tidy(work)
  const out = []
  if (work.root !== null) out.push(compact(work))
  out.push(compact(clade))
  return out
}

/**
 * Join fragments that came from one source tree the way they are joined there.
 *
 * The result is the part of the source tree that connects every node the fragments
 * hold: the paths up to their common ancestor, with the connecting internal nodes
 * (event, taxon) taken from the source and single-child nodes dissolved. Branch lengths
 * are the source's, so this is exact. Nodes with no place in the source (grafts,
 * invented nodes, or nodes from another tree) cannot be placed and are reported in
 * `skipped`; leaf details captured in the fragments (links) are kept.
 */
export function mergeAsOriginal(sourceNodes, fragments, srcTree = null) {
  const source = new Map(sourceNodes.map(n => [n.id, n]))
  const keep = new Set()
  const carried = new Map()
  let skipped = 0
  for (const fragment of fragments) {
    for (const node of fragment) {
      // A piece grafted from this same tree has a true place in it too: it goes back there.
      const placeable = node.src !== null && node.src !== undefined && source.has(node.src)
        && (!srcTree || !node.srcTree || node.srcTree === srcTree)
      if (!placeable) { if (node.leaf || node.src === null) skipped += 1; continue }
      keep.add(node.src)
      carried.set(node.src, node)
    }
  }
  if (!keep.size) return { fragment: null, skipped }
  // Every path from a kept node up to the root; the common ancestor is where they meet.
  const onPath = new Map()
  for (const id of keep) {
    for (let up = id; up !== -1 && up !== undefined; up = source.get(up)?.parent ?? -1) {
      onPath.set(up, (onPath.get(up) || 0) + 1)
    }
  }
  const total = keep.size
  let lca = [...keep][0]
  for (let up = lca; up !== -1 && up !== undefined; up = source.get(up)?.parent ?? -1) {
    if (onPath.get(up) === total) { lca = up; break }
  }
  const include = new Set()
  for (const id of keep) {
    for (let up = id; ; up = source.get(up).parent) {
      include.add(up)
      if (up === lca) break
    }
  }
  const work = { map: new Map(), root: lca }
  for (const id of include) {
    const original = source.get(id)
    const node = plainNode({ ...original, src: id, srcTree })
    const had = carried.get(id)
    if (had) {
      node.link = had.link
      node.leaf = had.leaf ?? node.leaf
    }
    node.children = (original.children || []).filter(c => include.has(c))
    if (id === lca) node.parent = -1
    work.map.set(id, node)
  }
  // A kept internal node whose kept descendants all went (pruned) is not a gene: tidy drops it.
  tidy(work)
  return { fragment: work.root === null ? null : compact(work), skipped }
}

/**
 * Attach one fragment to another. `targetId` in `target`: onto that node (it gains a
 * child), or with `onBranch`, onto the branch above it, which is halved by a new node.
 * The moving fragment keeps its own stem length (its root's branch to where it came
 * from, if known) and is marked a graft.
 */
export function graft(moving, target, targetId, { onBranch = false } = {}) {
  const work = toWork(target)
  if (!work.map.has(targetId)) return target
  const base = target.length
  const incoming = moving.map(node => ({
    ...plainNode(node),
    id: node.id + base,
    parent: node.parent === -1 ? -1 : node.parent + base,
    children: node.children.map(c => c + base),
  }))
  for (const node of incoming) work.map.set(node.id, node)
  const movingRoot = work.map.get(base)
  movingRoot.graft = true
  let anchor = targetId
  const targetNode = work.map.get(targetId)
  if (onBranch || targetNode.leaf) {
    // A new node halfway along the branch above the target.
    const junction = plainNode({ id: base + moving.length, parent: targetNode.parent, children: [targetId],
      branch_length: targetNode.branch_length === null ? null : targetNode.branch_length / 2, src: null, srcTree: null })
    junction.graft = undefined
    if (targetNode.branch_length !== null && targetNode.branch_length !== undefined) targetNode.branch_length /= 2
    if (targetNode.parent === -1) {
      work.root = junction.id
      junction.parent = -1
      junction.branch_length = targetNode.branch_length
    } else {
      const parent = work.map.get(targetNode.parent)
      parent.children = parent.children.map(c => (c === targetId ? junction.id : c))
    }
    targetNode.parent = junction.id
    work.map.set(junction.id, junction)
    anchor = junction.id
  }
  work.map.get(anchor).children.push(base)
  movingRoot.parent = anchor
  return compact(work)
}

/**
 * Re-root a fragment on the branch above `id` (outgroup rooting). The branch is split in
 * half by the new root; the path back to the old root is reversed, and the old root, if
 * it is left with one child, dissolves. Taxon labels along the reversed path no longer
 * describe their clades and are cleared.
 */
export function reroot(fragment, id) {
  if (id === 0 || !fragment[id]) return fragment
  const work = toWork(fragment)
  const target = work.map.get(id)
  const path = []
  for (let up = target.parent; up !== -1; up = work.map.get(up).parent) path.push(up)
  const rootId = Math.max(...work.map.keys()) + 1
  const half = target.branch_length === null || target.branch_length === undefined ? null : target.branch_length / 2
  const newRoot = plainNode({ id: rootId, parent: -1, children: [id], branch_length: null, src: null, srcTree: null })
  // Reverse the path: each node on it becomes the child of the one below it.
  let below = id
  let belowLength = half
  for (const up of path) {
    const node = work.map.get(up)
    const nextLength = node.branch_length
    node.children = node.children.filter(c => c !== below)
    const was = node.parent
    node.parent = below === id ? rootId : below
    if (below !== id) work.map.get(below).children.push(up)
    node.branch_length = belowLength
    if (node.taxon) node.taxon = null
    below = up
    belowLength = nextLength
    if (was === -1) break
  }
  target.parent = rootId
  target.branch_length = half
  newRoot.children = [id, path[0]]
  work.map.set(rootId, newRoot)
  work.root = rootId
  tidy(work)
  return compact(work)
}

/** Newick (or NHX) for a fragment; grafted stems carry `GRAFT=Y`. */
export function toNewick(fragment, { nhx = false } = {}) {
  const parts = []
  const stack = [[0, 0, 0]]
  const label = node => {
    const raw = node.leaf ? (node.leaf.label || node.leaf.gene_id || '') : (node.taxon?.name || '')
    return /[\s(),:;[\]']/.test(raw) ? `'${raw.replace(/'/g, "''")}'` : raw
  }
  const tags = node => {
    if (!nhx) return ''
    const out = []
    if (node.children.length) {
      if (node.event === 'duplication' || node.event === 'dubious') out.push('D=Y')
      else if (node.event) out.push('D=N')
      if (node.taxon?.name) out.push(`S=${node.taxon.name.replace(/[\s:=[\]]+/g, '_')}`)
      if (node.taxon?.id) out.push(`T=${node.taxon.id}`)
    } else if (node.leaf) {
      if (node.leaf.species) out.push(`S=${node.leaf.species.replace(/[\s:=[\]]+/g, '_')}`)
      if (node.leaf.gene_id) out.push(`G=${node.leaf.gene_id}`)
    }
    if (node.graft) out.push('GRAFT=Y')
    return out.length ? `[&&NHX:${out.join(':')}]` : ''
  }
  while (stack.length) {
    const [id, stage, index] = stack.pop()
    const node = fragment[id]
    if (stage === 0 && node.children.length) {
      parts.push('(')
      stack.push([id, 1, 0], [node.children[0], 0, 0])
      continue
    }
    if (stage === 1 && index + 1 < node.children.length) {
      parts.push(',')
      stack.push([id, 1, index + 1], [node.children[index + 1], 0, 0])
      continue
    }
    if (stage === 1) parts.push(')')
    parts.push(nhx && node.children.length ? '' : label(node))
    if (id !== 0 && node.branch_length !== null && node.branch_length !== undefined) parts.push(`:${Number(node.branch_length.toPrecision(6))}`)
    parts.push(tags(node))
  }
  return parts.join('') + ';'
}

/** Distance between every pair of leaves, keyed "srcA|srcB" (src order), for checking exactness. */
export function leafDistances(fragment) {
  const depth = new Map([[0, 0]])
  const order = []
  const stack = [0]
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    for (const c of fragment[id].children) {
      depth.set(c, depth.get(id) + (Number(fragment[c].branch_length) || 0))
      stack.push(c)
    }
  }
  const ancestors = id => {
    const out = []
    for (let up = id; up !== -1; up = fragment[up].parent) out.push(up)
    return out
  }
  const leaves = order.filter(id => fragment[id].leaf)
  const out = new Map()
  for (let i = 0; i < leaves.length; i++) {
    const up = new Set(ancestors(leaves[i]))
    for (let j = i + 1; j < leaves.length; j++) {
      const meet = ancestors(leaves[j]).find(a => up.has(a))
      const d = depth.get(leaves[i]) + depth.get(leaves[j]) - 2 * depth.get(meet)
      const a = fragment[leaves[i]].src ?? leaves[i], b = fragment[leaves[j]].src ?? leaves[j]
      out.set(a < b ? `${a}|${b}` : `${b}|${a}`, d)
    }
  }
  return out
}

export const fragmentLeaves = fragment => fragment.filter(node => node.leaf).length
export const fragmentGrafts = fragment => fragment.filter(node => node.graft && node.parent !== -1).length

/**
 * Merge fragments as their source tree joins them, keeping what was grafted onto them.
 *
 * `mergeAsOriginal` can only place nodes the source tree has, so a fragment that carries
 * a graft from elsewhere would lose it. Here each grafted piece (a node marked `graft`, or
 * one from another tree, with everything beneath it) is set aside first, remembering the
 * node of the source tree it hung from — or, for a graft onto a branch, the node below the
 * join. What remains of every fragment is rebuilt exactly from the source, and each piece
 * is grafted back at its anchor, onto the branch if it was on one. A piece whose anchor is
 * no longer there (pruned away) comes back as a fragment of its own, in `leftovers`.
 *
 * The result is new: it shares no nodes with the fragments it was made from.
 * Returns `{ fragment, leftovers, lost, duplicates }`: `lost` counts genes with no place at
 * all, `duplicates` genes both fragments held (they appear once).
 */
export function mergeWithGrafts(sourceNodes, fragments, srcTree = null) {
  // Foreign: from another tree, or grafted from nowhere known. A graft from this tree is not:
  // the source places it exactly, so the merge puts it back where it belongs.
  const foreign = node => (node.srcTree ? Boolean(srcTree) && node.srcTree !== srcTree : Boolean(node.graft))
  const cores = []
  const pieces = []
  const leftovers = []
  for (const fragment of fragments) {
    let nodes = fragment
    for (let guard = 0; guard < 10000; guard++) {
      const root = nodes.find(n => foreign(n) && (n.parent === -1 || !foreign(nodes[n.parent])))
      if (!root) break
      if (root.parent === -1) { leftovers.push(nodes); nodes = null; break }
      const anchor = graftAnchor(nodes, root, foreign)
      const [rest, clade] = splitAt(nodes, root.id)
      pieces.push({ anchor, nodes: clade })
      nodes = rest
    }
    if (nodes) cores.push(nodes)
  }
  if (!cores.length) return { fragment: null, leftovers: [...leftovers, ...pieces.map(p => p.nodes)], lost: 0, duplicates: 0 }
  const { fragment } = mergeAsOriginal(sourceNodes, cores, srcTree)
  // A gene held by both fragments appears once in the merge: a duplicate, not a loss.
  const leaves = cores.flatMap(nodes => nodes.filter(x => x.leaf))
  const distinct = new Set(leaves.map(x => (x.src !== null && x.src !== undefined ? `s${x.src}` : x))).size
  const lost = distinct - (fragment ? fragment.filter(x => x.leaf).length : 0)
  const duplicates = leaves.length - distinct
  let merged = fragment
  for (const piece of pieces) {
    const at = merged && piece.anchor
      ? merged.find(n => n.src === piece.anchor.src && !n.graft && (!n.srcTree || !srcTree || n.srcTree === srcTree))
      : null
    if (at) merged = graft(piece.nodes, merged, at.id, { onBranch: piece.anchor.onBranch })
    else leftovers.push(piece.nodes)
  }
  return { fragment: merged, leftovers, lost, duplicates }
}

/** Where a grafted piece hangs in its source tree: `{src, onBranch}`, or null. */
function graftAnchor(nodes, root, foreign) {
  const parent = nodes[root.parent]
  if (!parent) return null
  if (parent.src !== null && parent.src !== undefined && !foreign(parent)) return { src: parent.src, onBranch: false }
  // A junction a graft made on a branch: the join sits above the node on the other side.
  let below = parent.children.map(c => nodes[c]).find(c => c && c.id !== root.id && !foreign(c))
  while (below && (below.src === null || below.src === undefined)) {
    below = below.children.map(c => nodes[c]).find(c => c && !foreign(c))
  }
  return below ? { src: below.src, onBranch: true } : null
}
