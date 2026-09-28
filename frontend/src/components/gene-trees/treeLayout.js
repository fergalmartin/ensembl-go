/**
 * Where every visible node goes, in world units (screen pixels at zoom 1).
 *
 * Two shapes, linear (root on the left, one row per visible terminal — leaf or
 * collapsed clade) and radial (root in the middle, one spoke per terminal), each
 * drawn with either kind of branch:
 *  - `curved`: the default, the XD's smooth S-shaped branches;
 *  - `rectangular`: straight elbows (in a radial tree, an arc then a spoke).
 * Horizontally a node sits by its depth (cladogram), by its distance from the root
 * (`phylogram`), or — with `alignLeaves` — so every terminal ends at the same x,
 * which is what a data track beside the tree needs. Flips are applied last, as a
 * mirror of the finished drawing.
 */
import { isLeaf, orderedChildren } from './treeModel.js'

export const LAYOUTS = ['curved', 'rectangular']
export const DEFAULT_ROW_PITCH = 26
export const DEFAULT_LEVEL_WIDTH = 34
export const SHAPES = ['linear', 'radial']
// The radial tree leaves a small gap where the circle would close, so the first and
// last leaves are not drawn side by side as if they were neighbours.
const RADIAL_GAP = Math.PI * 0.12

export function layoutTree(index, view, options = {}) {
  const layout = LAYOUTS.includes(options.layout) ? options.layout : 'curved'
  const pitch = options.rowPitch || DEFAULT_ROW_PITCH
  const levelWidth = options.levelWidth || DEFAULT_LEVEL_WIDTH
  const root = view.root ?? 0
  const items = []
  const byId = new Map()
  if (!index.nodes.length || !index.nodes[root]) return { items, byId, edges: [], width: 0, height: 0, rows: 0, layout }

  // Pre-order walk of the visible tree, recording each node's visible children.
  const visibleChildren = new Map()
  const order = []
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    const terminal = isLeaf(index, id) || view.collapsed.has(id)
    const children = terminal ? [] : orderedChildren(index, view, id)
    visibleChildren.set(id, children)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }

  // Rows: terminals in pre-order.
  let row = 0
  const y = new Map()
  for (const id of order) {
    if (!visibleChildren.get(id).length) y.set(id, row++ * pitch)
  }
  // Internal nodes: midway between their first and last child, bottom-up.
  const height = new Map()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const children = visibleChildren.get(id)
    if (!children.length) { height.set(id, 0); continue }
    y.set(id, (y.get(children[0]) + y.get(children[children.length - 1])) / 2)
    height.set(id, 1 + Math.max(...children.map(c => height.get(c))))
  }

  const rootDepth = index.depth[root]
  const rootDist = index.dist[root]
  const maxHeight = height.get(root)
  let maxDist = 0
  for (const id of order) maxDist = Math.max(maxDist, index.dist[id] - rootDist)
  if (options.shape === 'radial') {
    return radialLayout(index, view, options, { order, visibleChildren, y, height, rows: row, root, rootDepth, rootDist,
      maxHeight, maxDist, pitch, levelWidth, layout })
  }
  const cladogramWidth = Math.max(1, maxHeight) * levelWidth
  const phylogram = Boolean(options.phylogram) && maxDist > 0
  const x = new Map()
  for (const id of order) {
    let value
    if (phylogram) value = ((index.dist[id] - rootDist) / maxDist) * cladogramWidth
    else if (options.alignLeaves) value = (maxHeight - height.get(id)) * levelWidth
    else value = (index.depth[id] - rootDepth) * levelWidth
    x.set(id, value)
  }

  const rows = row
  const totalHeight = Math.max(0, rows - 1) * pitch
  let width = 0
  for (const id of order) width = Math.max(width, x.get(id))
  const mirrorX = value => (options.flipHorizontal ? width - value : value)
  const mirrorY = value => (options.flipVertical ? totalHeight - value : value)

  for (const id of order) {
    const node = index.nodes[id]
    const kind = isLeaf(index, id) ? 'leaf' : (view.collapsed.has(id) ? 'collapsed' : 'internal')
    const item = { id, kind, x: mirrorX(x.get(id)), y: mirrorY(y.get(id)), parent: id === root ? -1 : index.parent[id], node }
    items.push(item)
    byId.set(id, item)
  }
  // Each node's extent: the rows it spans (y0..y1) and the furthest x beneath it (reach),
  // which is what the painter needs to draw a clade as one wedge when zoomed far out.
  for (let i = order.length - 1; i >= 0; i--) {
    const item = byId.get(order[i])
    const children = visibleChildren.get(order[i]).map(c => byId.get(c))
    if (!children.length) { item.y0 = item.y1 = item.y; item.reach = item.x; continue }
    item.y0 = Math.min(...children.map(c => c.y0))
    item.y1 = Math.max(...children.map(c => c.y1))
    const reaches = children.map(c => c.reach)
    item.reach = options.flipHorizontal ? Math.min(...reaches) : Math.max(...reaches)
  }

  for (const item of items) {
    item.lpos = item.y
    item.span = item.y1 - item.y0
    item.lmid = (item.y0 + item.y1) / 2
  }
  const edges = []
  for (const item of items) {
    if (item.parent < 0) continue
    const from = byId.get(item.parent)
    edges.push({ from: item.parent, to: item.id, points: edgePoints(layout, from, item) })
  }
  // Aligned leaves: every terminal's label sits in one column at the tips' edge. In a
  // cladogram the tips already end together; in a phylogram they end where their branch
  // lengths take them and a dotted leader runs out to the column.
  let alignX
  if (options.alignLeaves) {
    const tips = items.filter(item => item.kind !== 'internal').map(item => item.x)
    alignX = options.flipHorizontal ? Math.min(...tips) : Math.max(...tips)
  }
  return { items, byId, edges, width, height: totalHeight, rows, layout, pitch, levelWidth,
    flipHorizontal: Boolean(options.flipHorizontal), alignX }
}

/**
 * A branch as drawing commands: `M` then `L`/`C` segments, in world units.
 * Curved branches leave the parent horizontally and arrive at the child
 * horizontally, which is what makes the XD's sweeping look.
 */
export function edgePoints(layout, from, to) {
  if (layout === 'rectangular') {
    return [['M', from.x, from.y], ['L', from.x, to.y], ['L', to.x, to.y]]
  }
  const mid = from.x + (to.x - from.x) * 0.5
  return [['M', from.x, from.y], ['C', mid, from.y, mid, to.y, to.x, to.y]]
}

/**
 * The radial tree. Terminals are spread around the circle in the same order as the
 * linear tree's rows; a node's radius is its depth, its distance from the root
 * (phylogram) or — aligned — its height, so every tip ends on the outer circle.
 * The circle is made big enough that neighbouring tips at the rim sit a row pitch
 * apart, which keeps the label spacing and semantic-zoom rules of the linear trees.
 *
 * Positions are world x/y about the origin, so everything that only needs a point —
 * glyphs, hit-testing, the focus path — works unchanged. What else the painter needs
 * is recorded on each item: `angle`, `r`, the angular span of its terminals (`a0`,
 * `a1`) and the furthest radius beneath it (`reach`). Flips mirror the angles.
 */
function radialLayout(index, view, options, t) {
  const { order, visibleChildren, y, height, rows, root, rootDepth, rootDist, maxHeight, maxDist, pitch, levelWidth, layout } = t
  const sweep = Math.PI * 2 - RADIAL_GAP
  const start = -Math.PI / 2 + RADIAL_GAP / 2
  // Row index -> angle; internal nodes sit between their first and last child, as in rows.
  const theta = new Map()
  for (const id of order) theta.set(id, start + ((y.get(id) / pitch + 0.5) / Math.max(1, rows)) * sweep)
  let maxDepth = 0
  for (const id of order) maxDepth = Math.max(maxDepth, index.depth[id] - rootDepth)
  const levels = Math.max(1, options.alignLeaves ? maxHeight : maxDepth)
  const outer = Math.max(levels * levelWidth * 1.4, (rows * pitch) / sweep)
  const phylogram = Boolean(options.phylogram) && maxDist > 0
  const radius = id => {
    if (phylogram) return ((index.dist[id] - rootDist) / maxDist) * outer
    if (options.alignLeaves) return ((maxHeight - height.get(id)) / Math.max(1, maxHeight)) * outer
    return ((index.depth[id] - rootDepth) / levels) * outer
  }
  const flip = a => {
    let out = a
    if (options.flipHorizontal) out = Math.PI - out
    if (options.flipVertical) out = -out
    return out
  }
  const reversed = Boolean(options.flipHorizontal) !== Boolean(options.flipVertical)
  const items = []
  const byId = new Map()
  for (const id of order) {
    const node = index.nodes[id]
    const kind = isLeaf(index, id) ? 'leaf' : (view.collapsed.has(id) ? 'collapsed' : 'internal')
    const r = radius(id)
    const angle = flip(theta.get(id))
    const item = { id, kind, r, angle, x: r * Math.cos(angle), y: r * Math.sin(angle), parent: id === root ? -1 : index.parent[id], node,
      lpos: theta.get(id) * outer }
    items.push(item)
    byId.set(id, item)
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const item = byId.get(order[i])
    const children = visibleChildren.get(order[i]).map(c => byId.get(c))
    const own = theta.get(order[i])
    if (!children.length) { item.t0 = item.t1 = own; item.reach = item.r } else {
      item.t0 = Math.min(...children.map(c => c.t0))
      item.t1 = Math.max(...children.map(c => c.t1))
      item.reach = Math.max(...children.map(c => c.reach))
    }
    // Screen-facing extents, as the linear layout records them: the arc the clade
    // spans at its rim (what decides whether it folds) and its middle along the rim.
    item.span = (item.t1 - item.t0) * item.reach
    item.lmid = ((item.t0 + item.t1) / 2) * outer
    item.a0 = flip(item.t0)
    item.a1 = flip(item.t1)
  }
  const edges = []
  for (const item of items) {
    if (item.parent < 0) continue
    const from = byId.get(item.parent)
    edges.push({ from: item.parent, to: item.id, points: radialEdgePoints(layout, from, item) })
  }
  return { items, byId, edges, width: outer * 2, height: outer * 2, rows, layout, pitch, levelWidth, radial: true, outer,
    reversed, flipHorizontal: false, alignR: options.alignLeaves ? outer : undefined, alignX: undefined }
}

const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)]

/**
 * A radial branch. Rectangular: an arc at the parent's radius, then straight out along
 * the child's spoke. Curved: the linear tree's S-curve bent round the circle — the
 * radius grows steadily while the angle eases in and out (smoothstep), so the branch
 * leaves the parent and arrives at the child along their spokes and sweeps round in
 * between. It is a polar sweep (`P`), drawn as a polyline: a Bézier between the two
 * ends would cut a chord across the circle whenever they are far apart in angle, as
 * they are all along a Compara tree's caterpillar spine.
 */
export function radialEdgePoints(layout, from, to) {
  if (layout === 'rectangular') {
    return [['M', ...polar(from.r, from.angle)], ['A', from.r, from.angle, to.angle], ['L', ...polar(to.r, to.angle)]]
  }
  // One polar sweep, tessellated by the painter at a density set by its size on screen:
  // precomputing points here would draw a 10px branch in 48 segments when zoomed out.
  return [['M', from.x, from.y], ['P', from.r, from.angle, to.r, to.angle]]
}

/** Where a terminal's label starts: the aligned column when there is one, else the tip. */
export const labelAnchorX = (layout, item) => (layout.alignX ?? item.x)

/** Terminal rows in drawing order, with their y — the rows a data track lines up with. */
export function terminalRows(layoutResult) {
  return layoutResult.items.filter(item => item.kind !== 'internal').sort((a, b) => a.y - b.y)
}
