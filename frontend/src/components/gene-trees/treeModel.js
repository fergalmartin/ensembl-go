/**
 * The gene tree and what the user has done to it, kept apart.
 *
 * `indexTree` turns the backend's flat node list into lookups computed once per
 * tree: leaves under each node, depth, distance from the root. A view state —
 * which nodes are collapsed, which are flipped, which node is the root being
 * shown — is plain data layered on top, and every function here returns a new one
 * rather than editing it, so undo and persistence are trivial and React sees the
 * change. Nothing recurses: a caterpillar-shaped Compara tree can be deeper than
 * the call stack.
 */

export const EVENT_KINDS = ['speciation', 'duplication', 'dubious', 'gene_split']

export function indexTree(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : []
  const count = nodes.length
  const parent = new Int32Array(count).fill(-1)
  const depth = new Int32Array(count)
  const leafCount = new Int32Array(count)
  const dist = new Float64Array(count)
  const order = []
  const stack = count ? [0] : []
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    const node = nodes[id]
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]
      parent[child] = id
      depth[child] = depth[id] + 1
      dist[child] = dist[id] + Math.max(0, Number(nodes[child].branch_length) || 0)
      stack.push(child)
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const node = nodes[id]
    leafCount[id] = node.children.length ? node.children.reduce((sum, c) => sum + leafCount[c], 0) : 1
  }
  return { nodes, parent, depth, leafCount, dist, preorder: order, root: 0 }
}

export const emptyViewState = (root = 0) => ({ collapsed: new Set(), flipped: new Set(), root })

export function isLeaf(index, id) {
  return !index.nodes[id]?.children?.length
}

/** Children in drawing order, honouring a flip at this node. */
export function orderedChildren(index, view, id) {
  const children = index.nodes[id]?.children || []
  return view.flipped.has(id) ? [...children].reverse() : children
}

export function isCollapsed(index, view, id) {
  return !isLeaf(index, id) && view.collapsed.has(id)
}

export function descendants(index, id) {
  const out = []
  const stack = [...(index.nodes[id]?.children || [])]
  while (stack.length) {
    const node = stack.pop()
    out.push(node)
    stack.push(...index.nodes[node].children)
  }
  return out
}

export function leavesUnder(index, id) {
  if (isLeaf(index, id)) return [id]
  return descendants(index, id).filter(node => isLeaf(index, node))
}

export function pathToRoot(index, id) {
  const path = []
  for (let node = id; node >= 0; node = index.parent[node]) path.push(node)
  return path
}

export function isAncestor(index, ancestor, id) {
  for (let node = index.parent[id]; node >= 0; node = index.parent[node]) if (node === ancestor) return true
  return false
}

export function lca(index, ids) {
  const list = [...ids].filter(id => id >= 0 && id < index.nodes.length)
  if (!list.length) return -1
  let path = pathToRoot(index, list[0]).reverse()
  for (const id of list.slice(1)) {
    const other = new Set(pathToRoot(index, id))
    let cut = path.length
    for (let i = 0; i < path.length; i++) if (!other.has(path[i])) { cut = i; break }
    path = path.slice(0, cut)
  }
  return path.length ? path[path.length - 1] : -1
}

// ── view-state transitions ──

export function toggleCollapsed(index, view, id) {
  if (isLeaf(index, id)) return view
  const collapsed = new Set(view.collapsed)
  if (collapsed.has(id)) collapsed.delete(id)
  else collapsed.add(id)
  return { ...view, collapsed }
}

/** Open this node and everything beneath it, in one step. */
export function expandSubtree(index, view, id) {
  const collapsed = new Set(view.collapsed)
  collapsed.delete(id)
  for (const node of descendants(index, id)) collapsed.delete(node)
  return { ...view, collapsed }
}

/** Collapse every node off the path to `id`, and open the path itself. */
export function focusOn(index, view, id) {
  const collapsed = new Set(view.collapsed)
  const path = new Set(pathToRoot(index, id))
  for (const node of path) collapsed.delete(node)
  for (const node of path) {
    for (const child of index.nodes[node].children) {
      if (!path.has(child) && !isLeaf(index, child)) collapsed.add(child)
    }
  }
  return { ...view, collapsed }
}

/**
 * Fold the tree down to one node: the path from the root to it open, every clade off that
 * path folded, and the node's own clade fully open. On a leaf, that is `focusOn`.
 */
export function foldTo(index, view, id) {
  const collapsed = new Set(view.collapsed)
  const path = pathToRoot(index, id)
  const onPath = new Set(path)
  for (const node of path) collapsed.delete(node)
  for (const node of path) {
    if (node === id) continue
    for (const child of index.nodes[node].children) {
      if (!onPath.has(child) && !isLeaf(index, child)) collapsed.add(child)
    }
  }
  for (const node of descendants(index, id)) collapsed.delete(node)
  return { ...view, collapsed }
}

export function expandAll(view) {
  return { ...view, collapsed: new Set() }
}

/** `ids` and every node above them: the branching that leads to them from the root. */
export function pathsTo(index, ids) {
  const out = new Set()
  for (const id of ids) {
    for (let at = id; at >= 0 && !out.has(at); at = index.parent[at]) out.add(at)
  }
  return out
}

/**
 * Every clade in the part of the tree being shown folded, except those in `keepOpen`. Each
 * folds on its own, so opening a clade shows its clades folded in turn (⌥-click opens it all).
 * A subtree layer's invisible root is never folded, and folds outside the shown clade stay.
 */
function foldAllBut(index, view, keepOpen = null) {
  const root = view.root ?? 0
  const below = new Set(descendants(index, root))
  const collapsed = new Set([...view.collapsed].filter(id => !below.has(id)))
  for (const id of below) {
    if (!isLeaf(index, id) && !index.nodes[id].virtual && !keepOpen?.has(id)) collapsed.add(id)
  }
  return { ...view, collapsed }
}

export function collapseAll(index, view) {
  return foldAllBut(index, view)
}

/** Opens whatever folds hide the genes on `paths` (see `pathsTo`); every other fold stays. */
export function expandTo(view, paths) {
  return { ...view, collapsed: new Set([...view.collapsed].filter(id => !paths.has(id))) }
}

/** Folds everything but the branching on `paths`: those genes shown, the rest as folded clades. */
export function collapseTo(index, view, paths) {
  return foldAllBut(index, view, paths)
}

/**
 * A Nodes state (tools.js NODE_MODES) applied to a view. The local states need `paths` (see
 * `pathsTo`); with none — no gene in a local genome — they leave the view as it is.
 */
export function applyNodeMode(index, view, mode, paths) {
  if (mode === 'expand-all') return expandAll(view)
  if (mode === 'collapse-all') return collapseAll(index, view)
  if (!paths) return view
  return mode === 'collapse-local' ? collapseTo(index, view, paths) : expandTo(view, paths)
}

export function toggleFlipped(index, view, id) {
  if (isLeaf(index, id)) return view
  const flipped = new Set(view.flipped)
  if (flipped.has(id)) flipped.delete(id)
  else flipped.add(id)
  return { ...view, flipped }
}

/**
 * Mirror the clade under `id`: every node in it, `id` included, has its branches reversed,
 * so the whole clade reads upside down, down to its leaves. Mirroring again restores it.
 */
export function mirrorClade(index, view, id) {
  if (isLeaf(index, id)) return view
  const flipped = new Set(view.flipped)
  for (const node of [id, ...descendants(index, id)]) {
    if (isLeaf(index, node)) continue
    if (flipped.has(node)) flipped.delete(node)
    else flipped.add(node)
  }
  return { ...view, flipped }
}

/** Show only the subtree under `id` ("make a tree from this node"); -1 or the root restores it. */
export function showSubtree(view, id) {
  return { ...view, root: id >= 0 ? id : 0 }
}

/**
 * The first view of a tree. With a focus leaf: the path to it open, every clade
 * beside that path folded into a pill (the XD's default). Without one: open level
 * by level from the root while the visible rows stay under `maxRows`.
 */
export function defaultView(index, focusLeaf = -1, maxRows = 40) {
  const view = emptyViewState()
  if (!index.nodes.length) return view
  if (focusLeaf >= 0 && focusLeaf < index.nodes.length) return focusOn(index, view, focusLeaf)
  if (index.leafCount[0] <= maxRows) return view
  // Breadth-first: open a node only if the rows it adds keep the total in budget.
  const collapsed = new Set(index.nodes.filter(n => n.children.length).map(n => n.id))
  let rows = 1
  const queue = [0]
  while (queue.length) {
    const id = queue.shift()
    const children = index.nodes[id].children
    if (rows - 1 + children.length > maxRows) continue
    collapsed.delete(id)
    rows += children.length - 1
    for (const child of children) if (index.nodes[child].children.length) queue.push(child)
  }
  return { ...view, collapsed }
}

/** Visible terminal rows (leaves and collapsed pills) under the shown root, top to bottom. */
export function visibleRows(index, view) {
  const rows = []
  if (!index.nodes.length) return rows
  const stack = [view.root ?? 0]
  while (stack.length) {
    const id = stack.pop()
    if (isLeaf(index, id) || view.collapsed.has(id)) {
      rows.push(id)
      continue
    }
    const children = orderedChildren(index, view, id)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return rows
}

// ── labels ──

/** A clade's name, with a note when an ancestor already carries the same one (a paralog copy). */
export function cladeLabel(index, id) {
  const node = index.nodes[id]
  const name = node?.taxon?.name || node?.taxon?.common_name || ''
  if (!name) return ''
  for (let up = index.parent[id]; up >= 0; up = index.parent[up]) {
    const upper = index.nodes[up]
    if (upper.taxon?.name === node.taxon.name) {
      return upper.event === 'duplication' || upper.event === 'dubious' ? `${name} (paralog copy)` : name
    }
    if (upper.taxon?.name) break
  }
  return name
}

/** How many species sit under a node (memoised on the index; a tree's leaves never change). */
export function speciesCount(index, id) {
  if (!index.speciesCounts) index.speciesCounts = new Map()
  const cached = index.speciesCounts.get(id)
  if (cached !== undefined) return cached
  const species = new Set()
  for (const leaf of leavesUnder(index, id)) {
    const info = index.nodes[leaf].leaf
    species.add(info?.species || info?.taxid || info?.label)
  }
  index.speciesCounts.set(id, species.size)
  return species.size
}

/** A clade's name, or — when neither the file nor the taxonomy gives it one — what it holds. */
export function cladeTitle(index, id) {
  const name = cladeLabel(index, id)
  if (name) return name
  const genes = index.leafCount[id]
  const species = speciesCount(index, id)
  return `${genes.toLocaleString()} gene${genes === 1 ? '' : 's'} · ${species.toLocaleString()} species`
}

export function leafSpeciesLabel(leaf) {
  return leaf?.common_name || leaf?.species || ''
}

export function leafGeneLabel(leaf) {
  return leaf?.gene_id || leaf?.protein_id || leaf?.transcript_id || leaf?.other_id || leaf?.label || ''
}

/** Leaves carrying `geneIds` (versionless comparison), best first. */
export function findLeaves(index, geneIds) {
  const bare = value => String(value || '').replace(/^(.+?\d{5,})\.\d+$/, '$1').toUpperCase()
  const wanted = new Set([...(geneIds || [])].filter(Boolean).map(bare))
  if (!wanted.size) return []
  return index.nodes.filter(node => {
    const leaf = node.leaf
    if (!leaf) return false
    return [leaf.gene_id, leaf.protein_id, leaf.transcript_id, leaf.other_id, leaf.label, leaf.symbol]
      .some(value => value && wanted.has(bare(value)))
  }).map(node => node.id)
}
