/**
 * Canvas drawing and hit-testing for a laid-out tree.
 *
 * Geometry scales with zoom; text and strokes do not. A label is drawn at a fixed,
 * readable size whatever the zoom (the XD's hairlines and 8px type were the one
 * thing not to copy), and leaf labels only drop out once rows are packed too close
 * to read. Everything is computed in screen pixels from the world layout and a
 * `{k, x, y}` transform, so stroke widths stay constant.
 */
import { sansFont } from '../../utils/typography.js'
import { genomePillColors } from '../../utils/genomePillColors.js'
import { alignXOf, labelAnchorX, sideOf } from './treeLayout.js'
import { cladeTitle, leafGeneLabel, leafSpeciesLabel } from './treeModel.js'

export const LABEL_SIZE = 13
// The Alignment Explorer's selection look (alignment-explorer/paintLayer.js): anything
// picked is drawn in gold — its name in gold, a thin gold edge round a pill or a node —
// and everything else dims. No wash behind text: on neighbouring rows washes run together
// into a cloud. (On the light theme names take a deeper gold, to stay readable on white.)
const PICKED = '#edc263'
const MARQUEE_WASH = 'rgba(237,194,99,0.13)'
const DIM_ALPHA = 0.36
// Highlight local: what is off the branching to the user's genomes fades further than an
// unpicked node, so the lit paths read as the tree.
const UNLIT_ALPHA = 0.22
// Comparing two subtrees: a leaf with no partner in the other tree.
const UNMATCHED_ALPHA = 0.5
const SPECIES_PILL_PAD = 7
export const SMALL_LABEL_SIZE = 12
export const NODE_RADIUS = 5
export const HIT_RADIUS = 10
export const LABEL_GAP = 10
const PILL_HEIGHT = 20
const MIN_LABEL_PITCH = 12

export const PALETTES = {
  light: {
    edge: '#8193a8', edgeFocus: '#0b7fd6', text: '#1d2b3a', muted: '#5d6f84', gene: '#0b7fd6',
    speciation: '#0099ff', duplication: '#1d2b3a', dubious: '#9aa6b4', split: '#e0245e',
    pill: '#1d2b3a', pillText: '#ffffff', focus: '#e0245e', hover: 'rgba(0,153,255,0.12)',
    linked: '#0099ff', genome: '#d08a00', unresolved: '#9aa6b4', selection: 'rgba(0,153,255,0.10)', halo: '#ffffff',
    wedge: 'rgba(129,147,168,0.28)', bg: '#f6f8fb', isLight: true, graft: '#d08a00', pickedText: '#a8741a',
  },
  dark: {
    edge: '#6d7f96', edgeFocus: '#60a5fa', text: '#e3eaf4', muted: '#9aaac0', gene: '#7cb8ff',
    speciation: '#60a5fa', duplication: '#e3eaf4', dubious: '#7b8898', split: '#fb7185',
    pill: '#dbe5f1', pillText: '#152032', focus: '#fb7185', hover: 'rgba(96,165,250,0.16)',
    linked: '#60a5fa', genome: '#f5b942', unresolved: '#7b8898', selection: 'rgba(96,165,250,0.12)', halo: '#152032',
    wedge: 'rgba(109,127,150,0.30)', bg: '#152032', isLight: false, graft: '#f5b942', pickedText: PICKED,
  },
}

// `k` scales rows (vertical); `kx` the tree's depth (horizontal). They are equal until the
// user zooms out past the point where the tree's width fits the view: from there on only
// the rows compress, so a huge tree stays a readable shape instead of shrinking to a sliver.
export const toScreen = (t, x, y) => [x * (t.kx ?? t.k) + t.x, y * t.k + t.y]
export const toWorld = (t, sx, sy) => [(sx - t.x) / (t.kx ?? t.k), (sy - t.y) / t.k]

/**
 * How wide the data column before a terminal's label is, on screen. In a subtree layer each
 * subtree can show its own data view (or none), so it is by lane (`laneOffsets`); otherwise
 * one width for the whole tree (`labelOffset`, which in a layer is the widest lane's).
 */
export const labelOffsetOf = (layout, item) => (layout.laneOffsets && item?.lane !== undefined
  ? layout.laneOffsets[item.lane] || 0
  : layout.labelOffset || 0)
/** How far a data column pushes a terminal's label along, on screen (towards the labels' side). */
export const labelShift = (layout, item) => {
  const offset = labelOffsetOf(layout, item)
  return offset ? (sideOf(layout, item).flipHorizontal ? -offset : offset) : 0
}
/** Where a terminal's label is anchored on screen: its tip, or the aligned column, then past any data column. */
export const labelScreenX = (layout, t, item) => toScreen(t, labelAnchorX(layout, item), item.y)[0] + labelShift(layout, item)

/** The text drawn beside a terminal: [primary, secondary]. */
export function terminalText(index, item) {
  if (item.kind === 'collapsed') return [cladeTitle(index, item.id), '']
  const leaf = item.node.leaf || {}
  const species = leafSpeciesLabel(leaf)
  const gene = leaf.symbol && leaf.gene_id ? `${leaf.symbol} · ${leaf.gene_id}` : leafGeneLabel(leaf)
  return species ? [species, gene] : [gene, '']
}

export function measureTerminal(ctx, index, item, cache) {
  const cached = cache?.get(item.id)
  if (cached) return cached
  const [primary, secondary] = terminalText(index, item)
  ctx.font = sansFont(LABEL_SIZE, item.kind === 'collapsed' ? 400 : 600)
  let width = ctx.measureText(primary).width
  if (secondary) {
    ctx.font = sansFont(SMALL_LABEL_SIZE, 400)
    width += 8 + ctx.measureText(secondary).width
  }
  const pill = item.kind === 'collapsed' ? pillWidth(ctx, index, item) + 8 : 0
  // Room for the genome-coloured pill a local gene's species name is drawn in.
  const measured = { width: width + pill + (item.kind === 'leaf' ? SPECIES_PILL_PAD * 2 : 0), pill }
  cache?.set(item.id, measured)
  return measured
}

function pillWidth(ctx, index, item) {
  ctx.font = sansFont(SMALL_LABEL_SIZE, 700)
  return Math.max(PILL_HEIGHT + 6, ctx.measureText(String(index.leafCount[item.id])).width + 16)
}

export function linkStatus(link, topbarAssemblies) {
  if (!link) return 'none'
  if (link.status === 'linked') {
    const candidates = (link.candidates || []).map(c => c.assembly)
    return candidates.some(a => topbarAssemblies?.has(a)) || topbarAssemblies?.has(link.assembly) ? 'topbar' : 'local'
  }
  return link.status
}

const NO_GENOMES = []

/**
 * The top-bar and local genomes a clade holds, and how many of its genes are in each:
 * `[{ assembly, status, count, link }]`, top-bar genomes first, then the most genes. So a
 * folded clade can say which of the user's genomes are inside it, as a leaf does. Worked
 * out for every node in one pass up the tree, and kept on the index until the links change.
 */
export function cladeGenomes(index, id, links, topbarAssemblies) {
  let memo = index.cladeGenomes
  if (!memo || memo.links !== links || memo.topbar !== topbarAssemblies) {
    const byNode = new Array(index.nodes.length)
    for (let i = index.preorder.length - 1; i >= 0; i--) {
      const node = index.preorder[i]
      const children = index.nodes[node].children
      if (!children.length) {
        const link = links?.[node]
        const status = linkStatus(link, topbarAssemblies)
        const assembly = link?.assembly || link?.candidates?.[0]?.assembly
        if ((status === 'topbar' || status === 'local') && assembly) byNode[node] = new Map([[assembly, { assembly, status, count: 1, link }]])
        continue
      }
      // A chain of single-child-with-genomes nodes shares one map; merge only where two meet.
      let merged = null, shared = true
      for (const child of children) {
        const own = byNode[child]
        if (!own) continue
        if (!merged) { merged = own; continue }
        if (shared) { merged = new Map([...merged].map(([k, v]) => [k, { ...v }])); shared = false }
        for (const [assembly, entry] of own) {
          const into = merged.get(assembly)
          if (into) into.count += entry.count
          else merged.set(assembly, { ...entry })
        }
      }
      if (merged) byNode[node] = merged
    }
    memo = index.cladeGenomes = { links, topbar: topbarAssemblies, byNode, lists: new Map() }
  }
  let list = memo.lists.get(id)
  if (!list) {
    list = memo.byNode[id]
      ? [...memo.byNode[id].values()].sort((a, b) => (a.status === 'topbar' ? 0 : 1) - (b.status === 'topbar' ? 0 : 1) || b.count - a.count)
      : NO_GENOMES
    memo.lists.set(id, list)
  }
  return list
}

/**
 * The ring a folded clade takes: blue if it holds a gene in a top-bar genome, else amber if
 * it holds one in another local genome, else none.
 */
function cladeRing(index, id, links, topbarAssemblies, palette) {
  const first = cladeGenomes(index, id, links, topbarAssemblies)[0]
  return !first ? '' : first.status === 'topbar' ? palette.linked : palette.genome
}

/** World-space bounds including labels, for fitting the tree to the view. */
export function contentBounds(ctx, index, layout, cache) {
  if (layout.radial) {
    // Every tip's label runs outward along its spoke: the bounds are where they end.
    let minX = 0, maxX = 0, minY = 0, maxY = 0
    for (const item of layout.items) {
      let [x, y] = [item.x, item.y]
      if (item.kind !== 'internal') {
        const { width } = measureTerminal(ctx, index, item, cache)
        const r = (layout.alignR ?? item.r) + LABEL_GAP + width
        x = r * Math.cos(item.angle)
        y = r * Math.sin(item.angle)
      }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    return { minX, maxX, minY, maxY }
  }
  let minX = 0, maxX = layout.width, minY = 0, maxY = layout.height
  for (const item of layout.items) {
    // A subtree layer's fragments can be put anywhere, above or left of the origin too.
    if (layout.forest && !item.node.virtual) {
      minX = Math.min(minX, item.x); minY = Math.min(minY, item.y)
      maxX = Math.max(maxX, item.x); maxY = Math.max(maxY, item.y)
    }
    if (item.kind === 'internal') continue
    const { width } = measureTerminal(ctx, index, item, cache)
    const anchor = labelAnchorX(layout, item)
    const column = labelOffsetOf(layout, item)
    if (sideOf(layout, item).flipHorizontal) minX = Math.min(minX, anchor - column - LABEL_GAP - width)
    else maxX = Math.max(maxX, anchor + column + LABEL_GAP + width)
  }
  // A layer's fragments carry a name tag above them.
  return { minX, maxX, minY: minY - PILL_HEIGHT - (layout.forest ? 24 : 0), maxY: maxY + PILL_HEIGHT }
}

/**
 * Which terminal rows keep a label at this zoom, and how many genes each stands for.
 *
 * Rows closer than LABEL_SPACING on screen cannot all be read, so labels are handed
 * out by priority — the focus gene always, then genes in top-bar genomes, then other
 * local genes, then the biggest folded clades, then the rest — each claiming the rows
 * around it. A row that loses out is counted against the nearest label that won,
 * which then reads "… +12 genes". Zoomed in far enough, every row is labelled and
 * the plan is just `{ full: true }`.
 */
const LABEL_SPACING = 16
// A clade whose rows span less than this on screen is drawn as one wedge until zoomed into.
export const FOLD_PX = 10

/**
 * Semantic zoom: the clades too small on screen to read, drawn as single wedges.
 * Purely a drawing decision — the user's own folds are untouched, and a wedge opens
 * again by itself as soon as zooming in makes it big enough. The focus gene's path
 * never folds.
 */
export function foldPlan(layout, t, focusPath) {
  const root = layout.items[0]
  if (!root || root.span * t.k >= FOLD_PX * 4 && layout.pitch * t.k >= FOLD_PX) return null
  const folded = new Set()
  const hidden = new Set()
  const children = layout.children || (layout.children = (() => {
    const map = new Map()
    for (const item of layout.items) if (item.parent >= 0) {
      if (!map.has(item.parent)) map.set(item.parent, [])
      map.get(item.parent).push(item.id)
    }
    return map
  })())
  const stack = [root.id]
  while (stack.length) {
    const id = stack.pop()
    const item = layout.byId.get(id)
    const kids = children.get(id) || []
    if (!kids.length) continue
    if (item.span * t.k < FOLD_PX && !focusPath?.has(id) && !item.node.virtual) {
      folded.add(id)
      const inner = [...kids]
      while (inner.length) {
        const child = inner.pop()
        hidden.add(child)
        inner.push(...(children.get(child) || []))
      }
      continue
    }
    stack.push(...kids)
  }
  return folded.size ? { folded, hidden } : null
}

// `focusIds`: other copies of the focus gene (a layer can hold one gene in several
// fragments). Each is labelled and drawn as the focus is.
export function labelPlan(layout, index, t, links, topbarAssemblies, focusId, focusPath = null, focusIds = null) {
  const isFocus = id => id === focusId || Boolean(focusIds?.has(id))
  const pitch = layout.pitch * t.k
  // Recomputing for every frame of a drag is wasted: the plan only changes with the zoom step.
  const step = Math.round(Math.log2(Math.max(pitch, 1e-6)) * 8)
  const cached = layout.lodCache
  if (cached && cached.step === step && cached.links === links && cached.focusId === focusId && cached.focusIds === focusIds && cached.topbar === topbarAssemblies
      && cached.focusPath === focusPath) return cached.plan
  const folds = foldPlan(layout, t, focusPath)
  if (pitch >= MIN_LABEL_PITCH && !folds) {
    const plan = { full: true, labelled: null, extra: null, folds: null }
    layout.lodCache = { step, links, focusId, focusIds, topbar: topbarAssemblies, focusPath, plan }
    return plan
  }
  // A folded clade stands in for its rows, at the middle of its span.
  const rows = layout.items
    .filter(item => (folds?.folded.has(item.id) || item.kind !== 'internal') && !folds?.hidden.has(item.id))
    .map(item => (folds?.folded.has(item.id) ? { id: item.id, lpos: item.lmid, kind: 'folded' } : item))
    .sort((a, b) => a.lpos - b.lpos)
  const priority = item => {
    if (isFocus(item.id)) return 0
    if (item.kind === 'leaf') {
      const status = linkStatus(links[item.id], topbarAssemblies)
      if (status === 'topbar') return 1
      if (status === 'local') return 2
      return 4
    }
    // A folded clade holding the user's genomes, ahead of one that holds none.
    const genomes = cladeGenomes(index, item.id, links, topbarAssemblies)
    return genomes.length ? (genomes[0].status === 'topbar' ? 2.5 : 2.75) : 3
  }
  const order = rows.map((item, i) => ({ item, i, p: priority(item), size: index.leafCount[item.id] }))
    .sort((a, b) => a.p - b.p || b.size - a.size || a.i - b.i)
  // Spacing in screen pixels, not rows: a folded clade is one row standing for hundreds.
  // One lane per fragment of a subtree layer: fragments side by side share rows, not labels.
  const lanes = new Map()
  const laneOf = item => layout.byId.get(item.id)?.lane ?? 0
  const clear = (y, lane) => {
    if (!lanes.has(lane)) lanes.set(lane, [])
    const taken = lanes.get(lane) // screen y of accepted labels, kept sorted
    let lo = 0, hi = taken.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (taken[mid] < y) lo = mid + 1; else hi = mid }
    return (lo >= taken.length || taken[lo] - y >= LABEL_SPACING) && (lo === 0 || y - taken[lo - 1] >= LABEL_SPACING) ? lo : -1
  }
  const labelled = new Set()
  for (const { item } of order) {
    const y = item.lpos * t.k
    const lane = laneOf(item)
    const at = clear(y, lane)
    if (at < 0 && !isFocus(item.id)) continue
    labelled.add(item.id)
    if (at >= 0) lanes.get(lane).splice(at, 0, y)
  }
  // Each unlabelled row belongs to the nearest labelled one above or below it.
  const extra = new Map()
  let above = -1
  const next = new Int32Array(rows.length).fill(-1)
  for (let i = rows.length - 1, seen = -1; i >= 0; i--) { next[i] = seen; if (labelled.has(rows[i].id)) seen = i }
  rows.forEach((item, i) => {
    if (labelled.has(item.id)) { above = i; return }
    const below = next[i]
    const owner = above < 0 ? below : below < 0 ? above : (item.lpos - rows[above].lpos <= rows[below].lpos - item.lpos ? above : below)
    if (owner < 0) return
    const ownerId = rows[owner].id
    extra.set(ownerId, (extra.get(ownerId) || 0) + index.leafCount[item.id])
  })
  const plan = { full: false, labelled, extra, folds }
  layout.lodCache = { step, links, focusId, focusIds, topbar: topbarAssemblies, focusPath, plan }
  return plan
}

export function paintTree(ctx, state) {
  const { layout, index, t, width, height, palette, links = {}, focusId = -1, focusPath, hoverId = -1,
    selected = new Set(), labelCache, topbarAssemblies, genomeColors, picked = null, marquee = null,
    fragmentTags = null, column = null } = state
  // `onlyPicked`: the picks alone, on a clear background — the picture a drag carries.
  // `only` / `except`: draw just these nodes (and the branches into them), or all but
  // them — how a subtree being dragged round a layer is drawn apart from the rest.
  const onlyPicked = Boolean(state.onlyPicked && picked?.size)
  const only = onlyPicked ? picked : state.only || null
  const except = state.except || null
  const shown = id => (!only || only.has(id)) && (!except || !except.has(id))
  if (!state.noClear) ctx.clearRect(0, 0, width, height)
  if (!layout?.items?.length) return
  // A data column that stretches as it is zoomed (an alignment's) says how far the labels
  // now sit past the tips — subtree by subtree, when the subtrees show different views.
  if (column?.placeLabels && layout.labelOffset) column.placeLabels(layout)
  else if (column?.labelOffset && layout.labelOffset) layout.labelOffset = column.labelOffset()
  const pitch = layout.pitch * t.k
  const focusIds = state.focusIds || null
  const isFocus = id => id === focusId || Boolean(focusIds?.has(id))
  const plan = labelPlan(layout, index, t, links, topbarAssemblies, focusId, focusPath, focusIds)
  if (state.planOut) state.planOut.current = plan
  const hidden = plan.folds?.hidden
  const folded = plan.folds?.folded
  // Glyphs shrink with the rows once rows are tighter than a glyph, so a zoomed-out tree
  // reads as its shape rather than a smear of dots.
  const scale = Math.max(0.35, Math.min(1, pitch / 14))
  const margin = 40
  const visible = (sx, sy) => sy > -margin && sy < height + margin && sx > -2000 && sx < width + margin

  // Branches: one path per style.
  ctx.lineCap = 'round'
  // Radial branches are many gentle bends: mitred joins look the same there and cost less.
  ctx.lineJoin = layout.radial ? 'miter' : 'round'
  const drawEdges = (predicate, color, lineWidth) => {
    ctx.beginPath()
    for (const edge of layout.edges) {
      if (!predicate(edge)) continue
      const [op0, x0, y0] = edge.points[0]
      const [sx0, sy0] = toScreen(t, x0, y0)
      const last = edge.points[edge.points.length - 1]
      const sye = last[0] === 'P'
        ? toScreen(t, last[3] * Math.cos(last[4]), last[3] * Math.sin(last[4]))[1]
        : toScreen(t, last[last.length - 2], last[last.length - 1])[1]
      if ((sy0 < -margin && sye < -margin) || (sy0 > height + margin && sye > height + margin)) continue
      if (op0 === 'M') ctx.moveTo(sx0, sy0)
      for (const point of edge.points.slice(1)) {
        if (point[0] === 'L') ctx.lineTo(...toScreen(t, point[1], point[2]))
        else if (point[0] === 'P') {
          // A curved radial branch: radius grows steadily while the angle eases in and
          // out. As many segments as its length on screen needs, and no more.
          const [, r0, a0, r1, a1] = point
          const [cx, cy] = toScreen(t, 0, 0)
          const k = t.k
          const steps = Math.max(2, Math.min(48, Math.ceil((Math.abs(a1 - a0) * Math.max(r0, r1) * k) / 5)))
          for (let i = 1; i <= steps; i++) {
            const f = i / steps
            const eased = f * f * (3 - 2 * f)
            const r = (r0 + (r1 - r0) * f) * k
            const a = a0 + (a1 - a0) * eased
            ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
          }
        } else if (point[0] === 'A') {
          // A radial elbow's arc, about the tree's centre (radial zoom is uniform).
          const [cx, cy] = toScreen(t, 0, 0)
          ctx.arc(cx, cy, point[1] * t.k, point[2], point[3], point[3] < point[2])
        } else ctx.bezierCurveTo(...toScreen(t, point[1], point[2]), ...toScreen(t, point[3], point[4]), ...toScreen(t, point[5], point[6]))
      }
    }
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }
  // A subtree layer's invisible root is never drawn, nor its branches to each fragment.
  const virtualId = layout.forest ? layout.items[0].id : -1
  const anyPicked = Boolean(picked?.size)
  const isPicked = id => anyPicked && picked.has(id)
  // `lit`: the nodes to keep at full strength (Highlight local); everything else is faded.
  // A pick takes over from it: the picks are what is being worked on.
  const lit = !anyPicked && state.lit?.size ? state.lit : null
  // Comparing two subtrees: leaves joined to nothing in the other tree are faded a little.
  const unmatched = state.compare?.faded || null
  const alphaOf = id => (anyPicked ? (isPicked(id) ? 1 : DIM_ALPHA) : lit && !lit.has(id) ? UNLIT_ALPHA : unmatched?.has(id) ? UNMATCHED_ALPHA : 1)
  const onFocusPath = edge => focusPath?.has(edge.to)
  const grafted = edge => Boolean(layout.byId.get(edge.to)?.node?.graft)
  const drawable = edge => edge.from !== virtualId && !hidden?.has(edge.to) && shown(edge.to)
  // Picked content is gold and everything else is dimmed, as the Alignment Explorer does.
  // Lit, the faded branches go down first and the lit ones over them.
  const passes = lit ? [[edge => !lit.has(edge.to), UNLIT_ALPHA], [edge => lit.has(edge.to), 1]] : [[() => true, anyPicked ? DIM_ALPHA : 1]]
  for (const [pass, alpha] of passes) {
    const inPass = edge => drawable(edge) && pass(edge) && !isPicked(edge.to)
    ctx.globalAlpha = alpha
    drawEdges(edge => inPass(edge) && !onFocusPath(edge) && !grafted(edge), palette.edge, pitch < 4 ? 1.25 : 1.75)
    if (focusPath?.size) drawEdges(edge => inPass(edge) && onFocusPath(edge), palette.edgeFocus, 3)
    // Grafted stems are dashed: the join is the user's, not the source tree's.
    ctx.save()
    ctx.setLineDash([6, 4])
    drawEdges(edge => inPass(edge) && grafted(edge), palette.graft, 2)
    ctx.restore()
    ctx.globalAlpha = 1
  }
  if (anyPicked) drawEdges(edge => drawable(edge) && isPicked(edge.to), PICKED, 2.75)
  // Comparing two subtrees: the branches into clades the other tree does not have, dashed.
  if (state.compare?.conflict?.size && !onlyPicked) {
    ctx.save()
    ctx.setLineDash([6, 4])
    drawEdges(edge => drawable(edge) && state.compare.conflict.has(edge.to), state.compare.conflictColor, 2.5)
    ctx.restore()
  }
  // What a layer tool is about to act on, over the branches (see `emphasis` below).
  const emphasis = state.emphasis || null
  for (const mark of emphasis?.edges || []) {
    ctx.save()
    if (mark.dash) ctx.setLineDash(mark.dash)
    drawEdges(edge => drawable(edge) && mark.ids.has(edge.to), mark.color, mark.width || 3)
    ctx.restore()
  }

  const labelled = id => plan.full || plan.labelled.has(id)
  // Hover and selection washes under terminals: a circle round a node, and round a folded
  // clade's count pill a pill of the same proportions.
  for (const item of layout.items) {
    if (onlyPicked || !shown(item.id) || (item.id !== hoverId && !selected.has(item.id)) || hidden?.has(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    ctx.fillStyle = item.id === hoverId ? palette.hover : palette.selection
    if (item.kind === 'collapsed' && !folded?.has(item.id) && labelled(item.id)) {
      washCollapsed(ctx, index, item, t, layout, labelCache, sx, sy)
      continue
    }
    ctx.beginPath()
    ctx.arc(sx, sy, HIT_RADIUS + 3, 0, Math.PI * 2)
    ctx.fill()
  }

  // Labels last, so no glyph is drawn over one.
  const labels = []
  for (const item of layout.items) {
    if (hidden?.has(item.id) || item.id === virtualId || !shown(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    const focus = isFocus(item.id)
    ctx.globalAlpha = alphaOf(item.id)
    if (folded?.has(item.id)) {
      // A wedge holding the user's genomes is edged as a folded clade's pill is ringed.
      const edge = cladeRing(index, item.id, links, topbarAssemblies, palette)
      if (layout.radial) drawRadialWedge(ctx, item, t, palette, isPicked(item.id), edge)
      else {
        const top = toScreen(t, item.reach, item.y0)[1], bottom = toScreen(t, item.reach, item.y1)[1]
        if (bottom < -margin || top > height + margin) continue
        drawWedge(ctx, item, t, palette, isPicked(item.id), edge)
      }
      if (labelled(item.id)) labels.push([item, sx, sy])
      continue
    }
    // A terminal's label can be on screen when its tip is not: far along a stretched data
    // column, the tip is off to the left while the label is in view. Culled by the tip alone,
    // labels vanished mid-screen as the plane was panned.
    if (!visible(sx, sy) && !(item.kind !== 'internal' && layout.alignX !== undefined && !layout.radial
      && labelled(item.id) && visible(labelScreenX(layout, t, item), sy))) continue
    // A picked node: a thin gold ring, as the Alignment Explorer rings a picked sequence.
    // (A folded pill gets its gold edge where it is drawn, with its label.)
    if (isPicked(item.id) && item.kind !== 'collapsed') {
      ctx.strokeStyle = PICKED
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(sx, sy, NODE_RADIUS + 3, 0, Math.PI * 2); ctx.stroke()
    }
    if (item.kind === 'internal') drawInternal(ctx, item, sx, sy, palette, focusPath, scale)
    else if (item.kind === 'collapsed') {
      if (labelled(item.id)) labels.push([item, sx, sy])
      else {
        drawDot(ctx, sx, sy, palette.pill, 3 * scale + 1)
        const color = cladeRing(index, item.id, links, topbarAssemblies, palette)
        if (color) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 3 * scale + 3.5, 0, Math.PI * 2); ctx.stroke() }
      }
    } else {
      const status = linkStatus(links[item.id], topbarAssemblies)
      drawLeafGlyph(ctx, sx, sy, palette, status, focus, focus ? 1 : scale, genomeColor(links[item.id], genomeColors))
      if (labelled(item.id)) labels.push([item, sx, sy])
    }
  }
  // A data column beside the leaves (see `neighbourhoodColumn`, alignmentColumn.js).
  if (column && layout.labelOffset && !layout.radial) {
    // `shown`: the rows of this pass only — a subtree being dragged is painted apart from the
    // rest (`only` / `except`), and its data goes with it, not the others'. `lifted`: this is
    // that picture of it, not the view itself.
    column.paint(ctx, { layout, t, hidden, folded, palette, width, height, anyPicked, isPicked, isFocus, shown,
      lifted: Boolean(only), hover: state.columnHover ?? '', insetTop: state.insetTop || 0 })
  }
  if (state.compare?.links?.length && !onlyPicked && !layout.radial) {
    drawCompareLinks(ctx, { layout, index, t, height, hidden, labelled, labelCache, compare: state.compare, shown, palette })
  }
  // Aligned leaves: a dotted leader from each labelled tip out to the label column (or,
  // radial, out along its spoke to the outer circle).
  if (layout.radial && layout.alignR !== undefined) {
    ctx.save()
    ctx.setLineDash([2, 4])
    ctx.strokeStyle = palette.edge
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const [item] of labels) {
      if (folded?.has(item.id) || (layout.alignR - item.r) * t.k < 10) continue
      ctx.moveTo(...toScreen(t, ...polarXY(item.r + 7 / t.k, item.angle)))
      ctx.lineTo(...toScreen(t, ...polarXY(layout.alignR, item.angle)))
    }
    ctx.stroke()
    ctx.restore()
  } else if (layout.alignX !== undefined) {
    ctx.save()
    ctx.setLineDash([2, 4])
    ctx.strokeStyle = palette.edge
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const [item, sx, sy] of labels) {
      if (folded?.has(item.id)) continue
      // To where the data column's row starts, else on to the label.
      const ax = column?.leaderEnd?.(layout, t, item) ?? toScreen(t, alignXOf(layout, item), item.y)[0] + labelShift(layout, item)
      const start = sx + (sideOf(layout, item).flipHorizontal ? -7 : 7)
      if (Math.abs(ax - sx) < 10) continue
      ctx.moveTo(start, sy)
      ctx.lineTo(ax, sy)
    }
    ctx.stroke()
    ctx.restore()
  }
  for (const [item, sx, sy] of labels) {
    const more = plan.full ? 0 : plan.extra.get(item.id) || 0
    const pickedLabel = isPicked(item.id)
    ctx.globalAlpha = alphaOf(item.id)
    const ring = item.kind === 'collapsed' ? cladeRing(index, item.id, links, topbarAssemblies, palette) : ''
    if (layout.radial) {
      drawRadialLabel(ctx, index, item, t, palette, layout, labelCache, { more, folded: folded?.has(item.id), focus: isFocus(item.id),
        pill: labelPill(links[item.id], topbarAssemblies, genomeColors, palette), picked: pickedLabel, ring })
      continue
    }
    const ax = layout.alignX !== undefined ? labelScreenX(layout, t, item) : sx
    if (folded?.has(item.id)) drawWedgeLabel(ctx, index, item, t, palette, layout, more, pickedLabel)
    else if (item.kind === 'collapsed') drawCollapsed(ctx, index, item, ax, sy, palette, layout, labelCache, more, pickedLabel, ring)
    else {
      drawLeafLabel(ctx, index, item, ax, sy, palette, layout, labelCache, isFocus(item.id), more,
        labelPill(links[item.id], topbarAssemblies, genomeColors, palette), pickedLabel)
    }
  }
  ctx.globalAlpha = 1
  if (onlyPicked) return
  if (fragmentTags?.size) drawFragmentTags(ctx, layout, t, index, fragmentTags, shown)
  // `emphasis`, the rest of it: rings round nodes, the point where a graft will join a
  // branch, and a box round a whole fragment (a merge's target).
  for (const ring of emphasis?.rings || []) {
    const item = layout.byId.get(ring.id)
    if (!item || !shown(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    ctx.save()
    ctx.strokeStyle = ring.color
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(sx, sy, NODE_RADIUS + 4, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
  if (emphasis?.junction) {
    const [sx, sy] = emphasis.junction.at
    ctx.save()
    ctx.fillStyle = emphasis.junction.color
    ctx.strokeStyle = palette.bg
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(sx, sy, NODE_RADIUS + 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.restore()
  }
  if (emphasis?.box) {
    const { x0, y0, x1, y1, color, dash } = emphasis.box
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    if (dash) ctx.setLineDash(dash)
    roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 10)
    ctx.stroke()
    ctx.restore()
  }
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1)
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0)
    ctx.save()
    ctx.fillStyle = MARQUEE_WASH
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = PICKED
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    ctx.restore()
  }
}

/**
 * The lines between two subtrees being compared (compareTrees.js), from the end of each
 * label to the start of its partner's. A leaf inside a fold is joined at the fold, and
 * lines that end up joining the same two folds are drawn once, thicker for each. A line
 * whose leaf has more than one partner (paralogues, matched by species) is thin and dashed.
 * While a node is hovered (`compare.lit`), its lines are drawn bold and the rest faded.
 *
 * `compare.links`: `{a, b, oneToOne, color}`.
 */
function drawCompareLinks(ctx, { layout, index, t, height, hidden, labelled, labelCache, compare, shown }) {
  // Where a leaf shows: itself, or the fold (or folded wedge) it is hidden in.
  const anchors = new Map()
  const anchorOf = id => {
    if (anchors.has(id)) return anchors.get(id)
    let at = id
    while (at >= 0 && (!layout.byId.has(at) || hidden?.has(at))) at = index.parent[at]
    const item = at >= 0 ? layout.byId.get(at) : null
    const found = item && !item.node.virtual && shown(item.id) ? item : null
    anchors.set(id, found)
    return found
  }
  // The label's two ends on screen (just the tip for a terminal without a label at this zoom).
  const ends = item => {
    const sy = toScreen(t, 0, item.y)[1]
    if (item.kind === 'internal') {
      const sx = toScreen(t, item.reach ?? item.x, item.y)[0]
      return { from: sx, to: sx, sy }
    }
    const ax = layout.alignX !== undefined || layout.laneAlign ? labelScreenX(layout, t, item) : toScreen(t, item.x, item.y)[0]
    const width = labelled(item.id) ? LABEL_GAP + (labelCache?.get(item.id)?.width ?? 0) + 4 : 6
    return sideOf(layout, item).flipHorizontal ? { from: ax - width, to: ax, sy } : { from: ax, to: ax + width, sy }
  }
  const lit = compare.lit?.size ? compare.lit : null
  const merged = new Map()
  for (const link of compare.links) {
    const a = anchorOf(link.a), b = anchorOf(link.b)
    if (!a || !b) continue
    const key = `${a.id}:${b.id}`
    const entry = merged.get(key)
    if (entry) {
      entry.count += 1
      entry.lit ||= Boolean(lit && (lit.has(link.a) || lit.has(link.b)))
      continue
    }
    merged.set(key, { a, b, link, count: 1, lit: Boolean(lit && (lit.has(link.a) || lit.has(link.b))) })
  }
  ctx.save()
  ctx.lineCap = 'round'
  for (const { a, b, link, count, lit: on } of merged.values()) {
    const ea = ends(a), eb = ends(b)
    if ((ea.sy < -20 && eb.sy < -20) || (ea.sy > height + 20 && eb.sy > height + 20)) continue
    // From the end of each label that faces the other.
    const leftFirst = (ea.from + ea.to) / 2 <= (eb.from + eb.to) / 2
    const x0 = leftFirst ? ea.to : ea.from, x1 = leftFirst ? eb.from : eb.to
    const bend = Math.max(24, Math.abs(x1 - x0) * 0.45) * (leftFirst ? 1 : -1)
    ctx.globalAlpha = lit ? (on ? 1 : 0.18) : link.oneToOne ? 0.85 : 0.55
    ctx.strokeStyle = link.oneToOne ? link.color : compare.ambiguousColor
    ctx.lineWidth = (link.oneToOne ? 1.6 : 1) + Math.min(3, Math.log2(count)) + (on ? 1 : 0)
    ctx.setLineDash(link.oneToOne ? [] : [4, 4])
    ctx.beginPath()
    ctx.moveTo(x0, ea.sy)
    ctx.bezierCurveTo(x0 + bend, ea.sy, x1 - bend, eb.sy, x1, eb.sy)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Each fragment of a subtree layer gets a name tag in the layer's colour, in the blank
 * row the layout leaves above it (linear) or beside its root (radial). The Connect tool
 * picks a fragment up by its tag.
 */
export function fragmentTagBox(layout, t, item) {
  const [sx, sy] = toScreen(t, item.x, item.y)
  if (layout.radial) return { x: sx + 8, y: sy - 11 }
  const top = toScreen(t, item.x, item.y0 - layout.pitch)[1]
  return { x: sx - 4, y: Math.min(sy - 22, top - 11) }
}

function drawFragmentTags(ctx, layout, t, index, tags, shown = () => true) {
  for (const item of layout.items) {
    const tag = item.node.fragRoot && tags.get(item.node.fragRoot)
    if (!tag || !shown(item.id)) continue
    // Being renamed: the canvas lays a text box over where the tag would be instead.
    if (tag.editing) { tag.box = null; continue }
    const at = fragmentTagBox(layout, t, item)
    const y = at.y
    if (y < -30 || y > 5000) continue
    ctx.font = sansFont(SMALL_LABEL_SIZE, 700)
    const width = ctx.measureText(tag.label).width + 16
    // A mirrored fragment's root is on its right: its tag ends there rather than starts.
    const x = item.mirror ? at.x + 8 - width : at.x
    if (tag.picked && !tag.lifted) {
      // The whole subtree is picked: a ring in the picked colour just outside the tag.
      roundRect(ctx, x - 3, y - 3, width + 6, 28, 14)
      ctx.strokeStyle = PICKED
      ctx.lineWidth = 2.5
      ctx.stroke()
    }
    roundRect(ctx, x, y, width, 22, 11)
    ctx.fillStyle = tag.color
    ctx.fill()
    if (tag.lifted) {
      ctx.strokeStyle = PICKED
      ctx.lineWidth = 2.5
      ctx.stroke()
    }
    ctx.fillStyle = readableOn(tag.color)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(tag.label, x + 8, y + 11.5)
    tag.box = { x, y, width, height: 22 }
  }
}

export function readableOn(hex) {
  const value = String(hex || '').replace('#', '')
  if (value.length !== 6) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#111827' : '#ffffff'
}

// ── selection ──

const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1

/** Does the segment (x0,y0)-(x1,y1) touch the rectangle? (Liang–Barsky clipping.) */
function segmentTouches(r, x0, y0, x1, y1) {
  if (inRect(r, x0, y0) || inRect(r, x1, y1)) return true
  const dx = x1 - x0, dy = y1 - y0
  let lo = 0, hi = 1
  for (const [p, q] of [[-dx, x0 - r.x0], [dx, r.x1 - x0], [-dy, y0 - r.y0], [dy, r.y1 - y0]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const f = q / p
    if (p < 0) { if (f > hi) return false; if (f > lo) lo = f } else { if (f < lo) return false; if (f < hi) hi = f }
  }
  return lo <= hi
}

/** A branch as screen points, sampled along the shape the painter draws. */
function edgeScreenPoints(edge, t) {
  const out = []
  for (const point of edge.points) {
    if (point[0] === 'M' || point[0] === 'L') out.push(toScreen(t, point[1], point[2]))
    else if (point[0] === 'C') {
      const [x0, y0] = out.length ? toWorld(t, ...out[out.length - 1]) : [0, 0]
      for (let i = 1; i <= 8; i++) {
        const f = i / 8, g = 1 - f
        const x = g * g * g * x0 + 3 * g * g * f * point[1] + 3 * g * f * f * point[3] + f * f * f * point[5]
        const y = g * g * g * y0 + 3 * g * g * f * point[2] + 3 * g * f * f * point[4] + f * f * f * point[6]
        out.push(toScreen(t, x, y))
      }
    } else if (point[0] === 'P') {
      const [, r0, a0, r1, a1] = point
      for (let i = 1; i <= 12; i++) {
        const f = i / 12, e = f * f * (3 - 2 * f)
        const r = r0 + (r1 - r0) * f, a = a0 + (a1 - a0) * e
        out.push(toScreen(t, r * Math.cos(a), r * Math.sin(a)))
      }
    } else if (point[0] === 'A') {
      for (let i = 0; i <= 12; i++) {
        const a = point[2] + ((point[3] - point[2]) * i) / 12
        out.push(toScreen(t, point[1] * Math.cos(a), point[1] * Math.sin(a)))
      }
    }
  }
  return out
}

/**
 * The branch nearest a screen point, within `reach` pixels: `{id, dist, mid}` where `id`
 * is the node the branch leads to and `mid` the screen point halfway along it (where a
 * graft onto that branch will join), or null. `skip(id)` rules branches out.
 */
export function branchAt(layout, t, sx, sy, { reach = 9, skip = null, plan = null } = {}) {
  if (!layout?.edges) return null
  const hidden = plan?.folds?.hidden
  const virtualId = layout.forest ? layout.items[0].id : -1
  let best = null
  for (const edge of layout.edges) {
    if (edge.from === virtualId || hidden?.has(edge.to) || skip?.(edge.to)) continue
    const points = edgeScreenPoints(edge, t)
    let xs0 = Infinity, xs1 = -Infinity, ys0 = Infinity, ys1 = -Infinity
    for (const [x, y] of points) { xs0 = Math.min(xs0, x); xs1 = Math.max(xs1, x); ys0 = Math.min(ys0, y); ys1 = Math.max(ys1, y) }
    if (sx < xs0 - reach || sx > xs1 + reach || sy < ys0 - reach || sy > ys1 + reach) continue
    for (let i = 1; i < points.length; i++) {
      const d = segmentDistance(sx, sy, ...points[i - 1], ...points[i])
      if (d <= reach && (!best || d < best.dist)) best = { id: edge.to, dist: d, points }
    }
  }
  if (!best) return null
  return { id: best.id, dist: best.dist, mid: pointAlong(best.points, 0.5) }
}

/** The screen point halfway along the branch into `id`, or null (a root has none drawn). */
export function branchMid(layout, t, id) {
  if (!layout.edgeTo) layout.edgeTo = new Map(layout.edges.map(e => [e.to, e]))
  const edge = layout.edgeTo.get(id)
  const virtualId = layout.forest ? layout.items[0].id : -1
  if (!edge || edge.from === virtualId) return null
  return pointAlong(edgeScreenPoints(edge, t), 0.5)
}

function segmentDistance(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0
  const len = dx * dx + dy * dy
  const f = len ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len)) : 0
  return Math.hypot(px - (x0 + f * dx), py - (y0 + f * dy))
}

/** The point a fraction of the way along a polyline, by length. */
function pointAlong(points, fraction) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  let goal = total * fraction
  for (let i = 1; i < points.length; i++) {
    const step = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    if (step >= goal && step > 0) {
      const f = goal / step
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f]
    }
    goal -= step
  }
  return points[points.length - 1]
}

/**
 * Everything a marquee touches: a node whose glyph lies inside it, whose label overlaps
 * it, or whose branch in from its parent crosses it. A folded clade that is touched
 * brings every node it stands for. Screen space, so it serves both shapes.
 */
export function selectionHit(layout, t, rect, labelCache, plan = null) {
  const r = { x0: Math.min(rect.x0, rect.x1), x1: Math.max(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), y1: Math.max(rect.y0, rect.y1) }
  const hidden = plan?.folds?.hidden
  const folded = plan?.folds?.folded
  const virtualId = layout.forest ? layout.items[0].id : -1
  if (!layout.edgeTo) layout.edgeTo = new Map(layout.edges.map(e => [e.to, e]))
  const hits = new Set()
  const children = new Map()
  for (const item of layout.items) if (item.parent >= 0) {
    if (!children.has(item.parent)) children.set(item.parent, [])
    children.get(item.parent).push(item.id)
  }
  const withClade = id => {
    const stack = [id]
    while (stack.length) {
      const next = stack.pop()
      hits.add(next)
      stack.push(...(children.get(next) || []))
    }
  }
  for (const item of layout.items) {
    if (item.id === virtualId || hidden?.has(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    let touched = inRect(r, sx, sy)
    if (!touched && item.kind !== 'internal' && (!plan || plan.full || plan.labelled?.has(item.id))) {
      const width = (labelCache?.get(item.id)?.width ?? 100) + LABEL_GAP
      if (layout.radial) {
        const start = layout.alignR ?? item.r
        for (let i = 0; i <= 4 && !touched; i++) {
          const rr = start + (width / t.k) * (i / 4)
          const [px, py] = toScreen(t, rr * Math.cos(item.angle), rr * Math.sin(item.angle))
          touched = inRect(r, px, py)
        }
      } else {
        const ax = labelScreenX(layout, t, item)
        const left = sideOf(layout, item).flipHorizontal ? ax - width : ax, right = sideOf(layout, item).flipHorizontal ? ax : ax + width
        touched = right >= r.x0 && left <= r.x1 && sy + 9 >= r.y0 && sy - 9 <= r.y1
      }
    }
    if (!touched && item.parent >= 0 && item.parent !== virtualId) {
      const edge = layout.edgeTo.get(item.id)
      const points = edge ? edgeScreenPoints(edge, t) : []
      for (let i = 1; i < points.length && !touched; i++) touched = segmentTouches(r, ...points[i - 1], ...points[i])
    }
    if (!touched) continue
    if (folded?.has(item.id) || item.kind === 'collapsed') withClade(item.id)
    else hits.add(item.id)
  }
  hits.delete(virtualId)
  return hits
}

/** The fragment whose name tag is under a screen point (tags record where they were drawn). */
export function fragmentTagAt(tags, sx, sy) {
  for (const [fragmentId, tag] of tags || []) {
    const b = tag.box
    if (b && sx >= b.x && sx <= b.x + b.width && sy >= b.y && sy <= b.y + b.height) return fragmentId
  }
  return null
}

const polarXY = (r, a) => [r * Math.cos(a), r * Math.sin(a)]

function labelPill(link, topbarAssemblies, genomeColors, palette) {
  const status = linkStatus(link, topbarAssemblies)
  const color = genomeColor(link, genomeColors)
  if (!color || (status !== 'topbar' && status !== 'local')) return null
  // As everywhere else in the app: solid in the top bar; local but not there, a wash with a
  // dashed edge.
  return status === 'topbar'
    ? genomePillColors(color, { isLight: palette.isLight, state: 'active' })
    : { ...genomePillColors(color, { isLight: palette.isLight, state: 'inactive' }), dashed: true }
}

/** Where a radial terminal's label starts: out from its tip (or the outer circle, aligned). */
function radialLabelStart(layout, item, folded) {
  if (folded) return { r: item.reach, a: (item.a0 + item.a1) / 2 }
  return { r: layout.alignR ?? item.r, a: item.angle }
}

/**
 * A radial label: laid along its spoke, and on the left half turned round so it still
 * reads left to right. Everything else — pills, halos, "+N genes" — is the linear
 * label drawn in the rotated frame.
 */
function drawRadialLabel(ctx, index, item, t, palette, layout, cache, { more, folded, focus, pill, picked = false, ring = '' }) {
  const { r, a } = radialLabelStart(layout, item, folded)
  const [sx, sy] = toScreen(t, ...polarXY(r, a))
  const left = Math.cos(a) < 0
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate(left ? a + Math.PI : a)
  const frame = { flipHorizontal: left }
  if (folded) {
    const genes = index.leafCount[item.id] + more
    drawParts(ctx, [[cladeTitle(index, item.id), `italic ${sansFont(LABEL_SIZE, 600)}`, picked ? palette.pickedText : palette.text],
      [`${genes.toLocaleString()} gene${genes === 1 ? '' : 's'}`, sansFont(SMALL_LABEL_SIZE, 400), palette.muted]], 0, 0, left, palette)
  } else if (item.kind === 'collapsed') {
    drawCollapsed(ctx, index, item, 0, 0, palette, frame, cache, more, picked, ring)
  } else {
    drawLeafLabel(ctx, index, item, 0, 0, palette, frame, cache, focus, more, pill, picked)
  }
  ctx.restore()
}

/** A folded radial clade: a slice from its node out to the arc its leaves span. */
function drawRadialWedge(ctx, item, t, palette, picked = false, edge = '') {
  const [cx, cy] = toScreen(t, 0, 0)
  const [sx, sy] = toScreen(t, item.x, item.y)
  const minArc = 1.5 / Math.max(1e-6, item.reach * t.k)
  let a0 = item.a0, a1 = item.a1
  if (Math.abs(a1 - a0) < minArc) { const mid = (a0 + a1) / 2; a0 = mid - minArc; a1 = mid + minArc }
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.arc(cx, cy, item.reach * t.k, a0, a1, a1 < a0)
  ctx.closePath()
  ctx.fillStyle = palette.wedge
  ctx.fill()
  ctx.strokeStyle = picked ? PICKED : edge || palette.edge
  ctx.lineWidth = picked || edge ? 1.5 : 1
  ctx.stroke()
}

function drawWedge(ctx, item, t, palette, picked = false, edge = '') {
  const [sx, sy] = toScreen(t, item.x, item.y)
  const [ex, top] = toScreen(t, item.reach, item.y0)
  const bottom = toScreen(t, item.reach, item.y1)[1]
  const half = Math.max(1.5, (bottom - top) / 2)
  const mid = (top + bottom) / 2
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(ex, mid - half)
  ctx.lineTo(ex, mid + half)
  ctx.closePath()
  ctx.fillStyle = palette.wedge
  ctx.fill()
  ctx.strokeStyle = picked ? PICKED : edge || palette.edge
  ctx.lineWidth = picked || edge ? 1.5 : 1
  ctx.stroke()
}

/** A genome's colour for a linked leaf: the one its top-bar pill is drawn in. */
function genomeColor(link, genomeColors) {
  if (!link || link.status !== 'linked' || !genomeColors) return ''
  return genomeColors.get(link.assembly) || (link.candidates || []).map(c => genomeColors.get(c.assembly)).find(Boolean) || ''
}

/** Text with a halo in the background colour, so a branch or a dot never cuts through it. */
function haloText(ctx, text, x, y, palette) {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineWidth = 4
  ctx.strokeStyle = palette.bg
  ctx.strokeText(text, x, y)
  ctx.restore()
  ctx.fillText(text, x, y)
}

/**
 * A row of label parts laid out left to right from the anchor (or ending at it when the
 * tree is flipped): [text, font, colour, pill?] where a pill is drawn behind its text.
 */
// Rendered labels, reused frame to frame. Text is by far the dearest thing on the
// canvas — rotated text (every radial label) and the halo's stroked pass most of all —
// but a label is the same size at every zoom, so it is drawn once into a small bitmap
// at device resolution and blitted after that. Keyed on everything that changes its
// pixels; least recently used first out.
const SPRITES = new Map()
const SPRITE_LIMIT = 900
const SPRITE_PAD = 4
const SPRITE_HEIGHT = 26
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  // Anything drawn before the webfont arrived was drawn in the fallback face.
  document.fonts.addEventListener('loadingdone', () => SPRITES.clear())
}

function renderParts(ctx, parts, widths, x, y, palette) {
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  parts.forEach(([text, font, color, pill], i) => {
    ctx.font = font
    if (pill) {
      roundRect(ctx, x, y - 10, widths[i], 20, 10)
      ctx.fillStyle = pill.backgroundColor
      ctx.fill()
      if (pill.borderColor && pill.borderColor !== 'transparent') {
        ctx.setLineDash(pill.dashed ? [3, 2.5] : [])
        ctx.strokeStyle = pill.borderColor
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.fillStyle = pill.textColor
      ctx.fillText(text, x + SPECIES_PILL_PAD, y + 0.5)
    } else {
      ctx.fillStyle = color
      haloText(ctx, text, x, y + 0.5, palette)
    }
    x += widths[i] + 8
  })
}

function labelSprite(ctx, parts, palette) {
  const dpr = globalThis.devicePixelRatio || 1
  const key = `${dpr}|${palette.bg}|` + parts.map(([text, font, color, pill]) =>
    `${text}\u0001${font}\u0001${color}\u0001${pill ? `${pill.backgroundColor}${pill.textColor}${pill.borderColor}${pill.dashed ? 'd' : ''}` : ''}`).join('\u0002')
  const cached = SPRITES.get(key)
  if (cached) {
    SPRITES.delete(key)
    SPRITES.set(key, cached)
    return cached
  }
  const widths = parts.map(([text, font, , pill]) => {
    ctx.font = font
    return ctx.measureText(text).width + (pill ? SPECIES_PILL_PAD * 2 : 0)
  })
  const total = widths.reduce((a, b) => a + b, 0) + 8 * (parts.length - 1)
  const w = Math.ceil(total + SPRITE_PAD * 2)
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(Math.ceil(w * dpr), Math.ceil(SPRITE_HEIGHT * dpr))
    : Object.assign(document.createElement('canvas'), { width: Math.ceil(w * dpr), height: Math.ceil(SPRITE_HEIGHT * dpr) })
  const g = canvas.getContext('2d')
  g.scale(dpr, dpr)
  renderParts(g, parts, widths, SPRITE_PAD, SPRITE_HEIGHT / 2, palette)
  const sprite = { canvas, w, total }
  SPRITES.set(key, sprite)
  if (SPRITES.size > SPRITE_LIMIT) SPRITES.delete(SPRITES.keys().next().value)
  return sprite
}

/**
 * A row of label parts laid out left to right from the anchor (or ending at it when the
 * tree is flipped): [text, font, colour, pill?] where a pill is drawn behind its text.
 */
function drawParts(ctx, parts, anchor, y, flip, palette) {
  const sprite = labelSprite(ctx, parts, palette)
  let x = (flip ? anchor - LABEL_GAP - sprite.total : anchor + LABEL_GAP) - SPRITE_PAD
  let top = y - SPRITE_HEIGHT / 2
  const m = ctx.getTransform()
  if (m.b === 0 && m.c === 0) {
    // Upright: land on whole device pixels so the text stays as crisp as drawn text.
    x = Math.round(x * m.a) / m.a
    top = Math.round(top * m.d) / m.d
  }
  ctx.drawImage(sprite.canvas, x, top, sprite.w, SPRITE_HEIGHT)
  return sprite.total
}

function drawWedgeLabel(ctx, index, item, t, palette, layout, more = 0, picked = false) {
  const [wx, top] = toScreen(t, alignXOf(layout, item) ?? item.reach, item.y0)
  const ex = wx + labelShift(layout, item)
  const bottom = toScreen(t, item.reach, item.y1)[1]
  const genes = index.leafCount[item.id] + more
  drawParts(ctx, [[cladeTitle(index, item.id), `italic ${sansFont(LABEL_SIZE, 600)}`, picked ? palette.pickedText : palette.text],
    [`${genes.toLocaleString()} gene${genes === 1 ? '' : 's'}`, sansFont(SMALL_LABEL_SIZE, 400), palette.muted]],
  ex, (top + bottom) / 2, sideOf(layout, item).flipHorizontal, palette)
}

function drawDot(ctx, sx, sy, color, r) {
  ctx.fillStyle = color
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
}

function drawInternal(ctx, item, sx, sy, palette, focusPath, scale = 1) {
  const event = item.node.event
  const onPath = focusPath?.has(item.id)
  if (event === 'duplication') {
    ctx.fillStyle = palette.duplication
    const r = Math.max(1.6, 3.2 * scale)
    for (const dy of [-r - 0.3, r + 0.3]) { ctx.beginPath(); ctx.arc(sx, sy + dy, r, 0, Math.PI * 2); ctx.fill() }
    return
  }
  if (event === 'gene_split') {
    ctx.strokeStyle = palette.split
    ctx.lineWidth = 2
    ctx.fillStyle = palette.halo
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(2.5, NODE_RADIUS * scale), 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    return
  }
  // Plain speciation nodes are the first thing to go when zoomed out: the branches show them.
  if (scale < 0.6 && !onPath) return
  ctx.fillStyle = event === 'dubious' ? palette.dubious : palette.speciation
  ctx.beginPath()
  ctx.arc(sx, sy, (onPath ? NODE_RADIUS : NODE_RADIUS - 1) * (onPath ? 1 : scale), 0, Math.PI * 2)
  ctx.fill()
}

function moreText(more) {
  return more ? `+${more.toLocaleString()} gene${more === 1 ? '' : 's'}` : ''
}

/** The hover or selection wash round a folded clade's count pill, wherever `drawCollapsed` puts it. */
function washCollapsed(ctx, index, item, t, layout, cache, sx, sy) {
  const pill = measureTerminal(ctx, index, item, cache).pill - 8
  const pad = 5
  ctx.save()
  let anchor = sx, y = sy, flip = sideOf(layout, item).flipHorizontal
  if (layout.radial) {
    const { r, a } = radialLabelStart(layout, item, false)
    flip = Math.cos(a) < 0
    ctx.translate(...toScreen(t, ...polarXY(r, a)))
    ctx.rotate(flip ? a + Math.PI : a)
    anchor = 0; y = 0
  } else if (layout.alignX !== undefined) anchor = labelScreenX(layout, t, item)
  const left = flip ? anchor - pill : anchor
  roundRect(ctx, left - pad, y - PILL_HEIGHT / 2 - pad, pill + pad * 2, PILL_HEIGHT + pad * 2, PILL_HEIGHT / 2 + pad)
  ctx.fill()
  ctx.restore()
}

function drawCollapsed(ctx, index, item, sx, sy, palette, layout, cache, more = 0, picked = false, ring = '') {
  const measured = measureTerminal(ctx, index, item, cache)
  const pill = measured.pill - 8
  const left = sideOf(layout, item).flipHorizontal ? sx - pill : sx
  ctx.fillStyle = palette.pill
  roundRect(ctx, left, sy - PILL_HEIGHT / 2, pill, PILL_HEIGHT, PILL_HEIGHT / 2)
  ctx.fill()
  if (ring) {
    // The clade holds genes in the user's genomes: blue for a top-bar genome, amber for a
    // local one only, as a leaf's glyph says it.
    roundRect(ctx, left - 2, sy - PILL_HEIGHT / 2 - 2, pill + 4, PILL_HEIGHT + 4, PILL_HEIGHT / 2 + 2)
    ctx.strokeStyle = ring
    ctx.lineWidth = 2
    ctx.stroke()
  }
  if (picked) {
    // A picked clade's pill gets the gold edge, as a picked pill does in the Alignment Explorer
    // (outside the genome ring, when it has one).
    const out = ring ? 4.5 : 2
    roundRect(ctx, left - out, sy - PILL_HEIGHT / 2 - out, pill + out * 2, PILL_HEIGHT + out * 2, PILL_HEIGHT / 2 + out)
    ctx.strokeStyle = PICKED
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.fillStyle = palette.pillText
  ctx.font = sansFont(SMALL_LABEL_SIZE, 700)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index.leafCount[item.id]), left + pill / 2, sy + 0.5)
  const [label] = terminalText(index, item)
  const parts = [[label, `italic ${sansFont(LABEL_SIZE, 400)}`, picked ? palette.pickedText : palette.muted]]
  if (more) parts.push([moreText(more), sansFont(SMALL_LABEL_SIZE, 400), palette.muted])
  drawParts(ctx, parts, sideOf(layout, item).flipHorizontal ? left - 8 + LABEL_GAP : left + pill + 8 - LABEL_GAP, sy, sideOf(layout, item).flipHorizontal, palette)
}

function drawLeafGlyph(ctx, sx, sy, palette, status, focus, scale = 1, color = '') {
  const r = NODE_RADIUS * scale
  const own = color || palette.linked
  if (focus) {
    drawDot(ctx, sx, sy, palette.focus, NODE_RADIUS + 1.5)
    if (color) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, NODE_RADIUS + 4, 0, Math.PI * 2); ctx.stroke() }
  } else if (status === 'topbar') {
    drawDot(ctx, sx, sy, own, Math.max(2.5, r + 1))
  } else if (scale < 0.6) {
    // Far out: a coloured point says "local" without the ring detail.
    if (status === 'local') drawDot(ctx, sx, sy, own, Math.max(2, r))
    else if (status === 'genome') drawDot(ctx, sx, sy, palette.genome, Math.max(1.8, r))
  } else {
    ctx.fillStyle = palette.halo
    ctx.strokeStyle = status === 'local' ? own : status === 'genome' || status === 'no_index' ? palette.genome : palette.unresolved
    ctx.lineWidth = status === 'local' || status === 'genome' ? 2.5 : status === 'no_index' ? 2 : 1.5
    // Local species, annotation not indexed: the same amber, broken — nothing was looked for yet.
    if (status === 'no_index') ctx.setLineDash([2.2, 2.2])
    ctx.beginPath(); ctx.arc(sx, sy, r - 0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.setLineDash([])
    if (status === 'local') drawDot(ctx, sx, sy, own, 2)
  }
}

function drawLeafLabel(ctx, index, item, sx, sy, palette, layout, cache, focus, more = 0, pill = null, picked = false) {
  const [primary, secondary] = terminalText(index, item)
  // Picked: the name turns gold, or — a genome pill — the pill takes a gold edge.
  const ownPill = pill && picked ? { ...pill, borderColor: PICKED } : pill
  const nameColor = picked ? palette.pickedText : focus ? palette.focus : palette.text
  const parts = [[primary, sansFont(LABEL_SIZE, pill ? 700 : 600), nameColor, ownPill]]
  if (secondary) parts.push([secondary, sansFont(SMALL_LABEL_SIZE, pill ? 600 : 400), palette.gene])
  if (more) parts.push([moreText(more), sansFont(SMALL_LABEL_SIZE, 400), palette.muted])
  drawParts(ctx, parts, sx, sy, sideOf(layout, item).flipHorizontal, palette)
  if (focus && pill) {
    // The focus gene keeps its genome's pill; a red underline says it is the focus.
    ctx.font = parts[0][1]
    const w = ctx.measureText(primary).width + SPECIES_PILL_PAD * 2
    const x = sideOf(layout, item).flipHorizontal ? sx - LABEL_GAP - w : sx + LABEL_GAP
    ctx.fillStyle = palette.focus
    ctx.fillRect(x + 4, sy + 11, w - 8, 2.5)
  }
  measureTerminal(ctx, index, item, cache)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * What is under a screen point: a node glyph first (within HIT_RADIUS), then a
 * terminal's label. Returns `{item, part}` or null.
 */
export function hitTest(layout, t, sx, sy, labelCache, plan = null) {
  if (!layout?.items?.length) return null
  const hidden = plan?.folds?.hidden
  const folded = plan?.folds?.folded
  const virtualId = layout.forest ? layout.items[0].id : -1
  let best = null
  let bestDistance = HIT_RADIUS * HIT_RADIUS
  for (const item of layout.items) {
    if (hidden?.has(item.id) || item.id === virtualId) continue
    const [ix, iy] = toScreen(t, item.x, item.y)
    const dx = ix - sx, dy = iy - sy
    const distance = dx * dx + dy * dy
    if (distance <= bestDistance) { best = item; bestDistance = distance }
  }
  if (best) return { item: best, part: folded?.has(best.id) ? 'folded' : 'node' }
  if (layout.radial) return hitRadial(layout, t, sx, sy, labelCache, plan)
  // Anywhere inside a folded clade's wedge, or on its label, opens it.
  if (folded) {
    for (const id of folded) {
      const item = layout.byId.get(id)
      const [x0] = toScreen(t, item.x, item.y)
      const [x1, top] = toScreen(t, item.reach, item.y0)
      const bottom = toScreen(t, item.reach, item.y1)[1]
      const left = Math.min(x0, x1), right = Math.max(x0, x1) + (plan.labelled?.has(id) ? 220 : 0)
      if (sx >= left && sx <= right && sy >= Math.min(top, bottom) - 6 && sy <= Math.max(top, bottom) + 6) return { item, part: 'folded' }
    }
  }
  const half = Math.max(8, Math.min(PILL_HEIGHT / 2 + 1, layout.pitch * t.k / 2))
  for (const item of layout.items) {
    if (item.kind === 'internal') continue
    if (plan && !plan.full && !plan.labelled.has(item.id)) continue
    if (hidden?.has(item.id) || folded?.has(item.id)) continue
    const ix = labelScreenX(layout, t, item)
    const iy = toScreen(t, 0, item.y)[1]
    if (Math.abs(iy - sy) > half) continue
    const width = labelCache?.get(item.id)?.width ?? 120
    const inside = sideOf(layout, item).flipHorizontal ? sx <= ix && sx >= ix - LABEL_GAP - width : sx >= ix && sx <= ix + LABEL_GAP + width
    if (inside) return { item, part: 'label' }
  }
  return null
}

const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a))

/** Radial hit-testing past the glyphs: inside a folded slice, or along a label's spoke. */
function hitRadial(layout, t, sx, sy, labelCache, plan) {
  const hidden = plan?.folds?.hidden
  const folded = plan?.folds?.folded
  const [wx, wy] = toWorld(t, sx, sy)
  const r = Math.hypot(wx, wy)
  const a = Math.atan2(wy, wx)
  if (folded) {
    for (const id of folded) {
      const item = layout.byId.get(id)
      const mid = (item.a0 + item.a1) / 2
      const half = Math.abs(item.a1 - item.a0) / 2 + 4 / Math.max(1, item.reach * t.k)
      const labelRoom = plan.labelled?.has(id) ? 220 / t.k : 0
      if (Math.abs(wrapAngle(a - mid)) <= half && r >= item.r * 0.9 && r <= item.reach + labelRoom) return { item, part: 'folded' }
    }
  }
  const half = Math.max(8, Math.min(PILL_HEIGHT / 2 + 1, layout.pitch * t.k / 2))
  for (const item of layout.items) {
    if (item.kind === 'internal' || hidden?.has(item.id) || folded?.has(item.id)) continue
    if (plan && !plan.full && !plan.labelled.has(item.id)) continue
    const start = layout.alignR ?? item.r
    const [ax, ay] = toScreen(t, start * Math.cos(item.angle), start * Math.sin(item.angle))
    const dx = sx - ax, dy = sy - ay
    const along = dx * Math.cos(item.angle) + dy * Math.sin(item.angle)
    const across = -dx * Math.sin(item.angle) + dy * Math.cos(item.angle)
    const width = labelCache?.get(item.id)?.width ?? 120
    if (along >= 0 && along <= LABEL_GAP + width && Math.abs(across) <= half) return { item, part: 'label' }
  }
  return null
}

// ── the Neighbourhood data column ──

// A slot per gene (the flank, the gene, the flank), each a fixed width on screen as labels
// are, wide enough for a ten-letter symbol inside its arrow.
const NEIGHBOUR_SLOT = 76
const NEIGHBOUR_PAD = 12
const NEIGHBOUR_GENE_H = 16   // an arrow's height with room to spare, as the Neighbourhood view's
const NEIGHBOUR_FULL_PX = 26   // row pitch on screen from which arrows carry their names
const NEIGHBOUR_ARROW_PX = 9   // …and from which they are arrows at all; below, bars
const NEIGHBOUR_LINK_GAP = 4   // the least room between rows' arrows worth drawing links in
/** Row pitch (world units) while the column is on: roomier than the tree's own, for the links. */
export const NEIGHBOUR_ROW_PITCH = 38
/** The column's width on screen for `flank` genes each side: a layout's `dataColumn`. */
export const neighbourColumnPx = flank => (flank * 2 + 1) * NEIGHBOUR_SLOT + NEIGHBOUR_PAD * 2
// The Neighbourhood view's own colours: genes blue, the tree gene orange, outlined.
const CENTRE_FILL = { light: '#f97316', dark: '#fb923c' }
const PLAIN_FILL = { light: '#0099ff', dark: '#3b82f6' }
const GENE_STROKE = { light: '#1f2937', dark: '#e5e7eb' }
const LINK_STROKE = { light: '#374151', dark: '#d1d5db' }

const slotsOf = neighbours => (neighbours?.flank ?? 4) * 2 + 1

/** Where a row's strip starts on screen, and how wide it is. */
function stripBox(layout, t, item, neighbours) {
  const column = toScreen(t, alignXOf(layout, item), item.y)[0]
  const width = slotsOf(neighbours) * NEIGHBOUR_SLOT
  return { left: sideOf(layout, item).flipHorizontal ? column - NEIGHBOUR_PAD - width : column + NEIGHBOUR_PAD, width }
}

/** Each gene's slot in a row's strip (the gene in the middle): `[{gene, index, x}]`. */
function stripGeometry(layout, t, item, entry, neighbours) {
  const { left, width } = stripBox(layout, t, item, neighbours)
  const centre = Math.max(0, entry.genes.findIndex(g => g.id === entry.center))
  const middle = (slotsOf(neighbours) - 1) / 2
  return entry.genes.map((gene, index) => ({ gene, index, x: left + (middle + index - centre) * NEIGHBOUR_SLOT }))
    .filter(slot => slot.x >= left - 0.5 && slot.x < left + width - 0.5)
}

function arrowPath(ctx, x, y, width, height, strand) {
  const point = Math.min(width * 0.4, 10, height)
  ctx.beginPath()
  if (strand === '-') {
    ctx.moveTo(x + point, y); ctx.lineTo(x + width, y); ctx.lineTo(x + width, y + height); ctx.lineTo(x + point, y + height); ctx.lineTo(x, y + height / 2)
  } else {
    ctx.moveTo(x, y); ctx.lineTo(x + width - point, y); ctx.lineTo(x + width, y + height / 2); ctx.lineTo(x + width - point, y + height); ctx.lineTo(x, y + height)
  }
  ctx.closePath()
}

// Names cut to fit their arrow, by measurement: `font|room|name` → shown text.
const fitted = new Map()
function fitName(ctx, name, room) {
  const key = `${ctx.font}|${room}|${name}`
  let out = fitted.get(key)
  if (out === undefined) {
    out = name
    if (ctx.measureText(out).width > room) {
      let n = name.length - 1
      while (n > 1 && ctx.measureText(`${name.slice(0, n)}…`).width > room) n--
      out = `${name.slice(0, n)}…`
    }
    if (fitted.size > 5000) fitted.clear()
    fitted.set(key, out)
  }
  return out
}

/**
 * Each linked leaf's neighbourhood, beside it, drawn as the Neighbourhood view draws a
 * row: a dashed baseline, outlined strand arrows in blue, the tree gene orange, names in
 * the arrows. Optionally the most shared families (or every shared one) in colour, and
 * links between each row and the next row down that has one: solid for the same gene
 * family, dashed for the same symbol. Names show when rows are roomy; arrows alone at
 * medium zoom; far out, a thin bar per gene.
 */
/**
 * Which neighbourhood rows are linked: each row with genes to the next one down with genes
 * in the same tree — in a subtree layer, the same fragment (`item.lane`), since rows of two
 * trees are not neighbours in either. `rows` are sorted top to bottom (`sy`); pairs wholly
 * above or below a view `height` tall are left out, one running across it is kept.
 */
export function neighbourRowPairs(rows, height, margin = 20) {
  const above = new Map() // lane → the last row with genes seen in it
  const out = []
  for (const row of rows) {
    if (!row.entry?.genes) continue
    const upper = above.get(row.item.lane)
    above.set(row.item.lane, row)
    if (upper && row.sy >= -margin && upper.sy <= height + margin) out.push([upper, row])
  }
  return out
}

function drawNeighbourhoods(ctx, layout, t, { neighbours, hidden, folded, shown: inPass = null, palette, height, anyPicked, isPicked, isFocus, hoverGroup }) {
  const pitch = layout.pitch * t.k
  const theme = palette.isLight ? 'light' : 'dark'
  const colours = neighbours.colours || new Map()
  const matcher = neighbours.matcher
  const width = NEIGHBOUR_SLOT - 8
  const full = pitch >= NEIGHBOUR_FULL_PX
  const arrows = pitch >= NEIGHBOUR_ARROW_PX
  const h = full ? NEIGHBOUR_GENE_H : arrows ? Math.max(5, Math.min(NEIGHBOUR_GENE_H, pitch * 0.5)) : Math.max(1.5, Math.min(4, pitch * 0.6))
  const dim = id => anyPicked && !isPicked(id) && !isFocus(id)
  const inGroup = gene => Boolean(hoverGroup) && matcher?.keys(gene).includes(hoverGroup)
  const fillOf = (gene, entry) => (gene.id === entry.center ? CENTRE_FILL[theme] : colours.get(matcher?.group(gene)) || PLAIN_FILL[theme])

  // The rows on show, top to bottom, with one past each edge so links run in from off screen.
  const rows = []
  for (const item of layout.items) {
    if (item.kind !== 'leaf' || hidden?.has(item.id) || folded?.has(item.id) || (inPass && !inPass(item.id))) continue
    rows.push({ item, sy: toScreen(t, 0, item.y)[1], entry: neighbours.byLeafId.get(item.id) })
  }
  rows.sort((a, b) => a.sy - b.sy)
  let first = rows.findIndex(r => r.sy >= -20)
  if (first < 0) first = rows.length
  let last = rows.findIndex(r => r.sy > height + 20)
  if (last < 0) last = rows.length
  const shown = rows.slice(first, last)
  const strips = new Map()
  const stripOf = row => {
    let s = strips.get(row.item.id)
    if (!s) { s = stripGeometry(layout, t, row.item, row.entry, neighbours); strips.set(row.item.id, s) }
    return s
  }

  ctx.save()
  // Links first, under the genes: each row that has genes to the next one down that has, in
  // the same tree. In a subtree layer that is the same fragment (`lane`): once a tree is cut
  // in two, or two are set side by side, rows of different trees are not neighbours in any
  // tree, so nothing links them.
  if (neighbours.links && matcher && arrows && pitch - h >= NEIGHBOUR_LINK_GAP) {
    const lit = []
    ctx.lineWidth = 1.5
    for (const [upper, lower] of neighbourRowPairs(rows, height)) {
      const pairs = neighbours.pairsFor(upper.item.id, lower.item.id, upper.entry, lower.entry)
      if (!pairs.length) continue
      const us = stripOf(upper), ls = stripOf(lower)
      const at = (strip, index) => strip.find(s => s.index === index)
      ctx.globalAlpha = dim(upper.item.id) && dim(lower.item.id) ? DIM_ALPHA * 0.6 : 0.6
      const alpha = ctx.globalAlpha
      for (const { a, b, via } of pairs) {
        const sa = at(us, a), sb = at(ls, b)
        if (!sa || !sb) continue
        const x1 = sa.x + 4 + width / 2, y1 = upper.sy + h / 2
        const x2 = sb.x + 4 + width / 2, y2 = lower.sy - h / 2
        const ga = upper.entry.genes[a]
        if (inGroup(ga)) { lit.push([x1, y1, x2, y2, via]); continue }
        const colour = ga.id === upper.entry.center ? null : colours.get(matcher.group(ga))
        ctx.strokeStyle = colour || LINK_STROKE[theme]
        ctx.globalAlpha = colour ? Math.min(1, alpha + 0.2) : alpha
        ctx.setLineDash(via === 'symbol' ? [4, 3] : [])
        linkPath(ctx, x1, y1, x2, y2)
        ctx.stroke()
      }
    }
    // The hovered family's links on top, lit.
    ctx.globalAlpha = 1
    ctx.strokeStyle = PICKED
    ctx.lineWidth = 2
    for (const [x1, y1, x2, y2, via] of lit) {
      ctx.setLineDash(via === 'symbol' ? [4, 3] : [])
      linkPath(ctx, x1, y1, x2, y2)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  ctx.font = sansFont(10, 600)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const row of shown) {
    const { item, sy, entry } = row
    ctx.globalAlpha = dim(item.id) ? DIM_ALPHA : 1
    if (!entry) {
      if (neighbours.pending?.has(item.id) && arrows) {
        // Still coming: a faint dashed placeholder where the strip will be.
        const { left, width: w } = stripBox(layout, t, item, neighbours)
        ctx.save()
        ctx.setLineDash([3, 4])
        ctx.strokeStyle = palette.muted
        ctx.globalAlpha *= 0.5
        ctx.beginPath(); ctx.moveTo(left, sy); ctx.lineTo(left + w, sy); ctx.stroke()
        ctx.restore()
      }
      continue
    }
    if (!entry.genes) {
      if (full) {
        const column = toScreen(t, alignXOf(layout, item), item.y)[0]
        ctx.fillStyle = palette.muted
        ctx.fillText('—', column + (sideOf(layout, item).flipHorizontal ? -NEIGHBOUR_PAD - 8 : NEIGHBOUR_PAD + 8), sy)
      }
      continue
    }
    const strip = stripOf(row)
    if (arrows && strip.length) {
      // The row's baseline, as in the Neighbourhood view: dashed, from its first gene to its last.
      ctx.save()
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = palette.muted
      ctx.globalAlpha *= 0.55
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(strip[0].x + 4, sy); ctx.lineTo(strip[strip.length - 1].x + 4 + width, sy); ctx.stroke()
      ctx.restore()
    }
    for (const { gene, x } of strip) {
      const fill = fillOf(gene, entry)
      const gx = x + 4
      if (!arrows) {
        ctx.fillStyle = fill
        ctx.fillRect(gx, sy - h / 2, width, h)
        continue
      }
      arrowPath(ctx, gx, sy - h / 2, width, h, gene.strand)
      ctx.fillStyle = fill
      ctx.fill()
      if (inGroup(gene)) {
        ctx.strokeStyle = PICKED
        ctx.lineWidth = 2.5
        ctx.stroke()
      } else if (full) {
        ctx.strokeStyle = GENE_STROKE[theme]
        ctx.lineWidth = 1
        ctx.stroke()
      }
      if (full) {
        const point = Math.min(width * 0.4, 10, h)
        ctx.fillStyle = readableOn(fill)
        ctx.fillText(fitName(ctx, gene.name || gene.id, width - point - 6), gx + width / 2 + (gene.strand === '-' ? point / 2 : -point / 2), sy + 0.5)
      }
    }
  }
  ctx.restore()
}

function linkPath(ctx, x1, y1, x2, y2) {
  const mid = (y1 + y2) / 2
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  if (Math.abs(x1 - x2) <= 0.5) ctx.lineTo(x2, y2)
  else ctx.bezierCurveTo(x1, mid, x2, mid, x2, y2)
}

/**
 * The Neighbourhood data column, as the painter and canvas take any data column:
 * `paint(ctx, env)`, `leaderEnd(layout, t, item)` (where a leaf's dotted leader stops, or
 * null for the label) and `hit(layout, t, sx, sy, plan)` → `{item, part, hoverKey, …}`.
 * `hoverKey` is what the column lights while the pointer is on it (here, a gene family).
 */
export function neighbourhoodColumn(neighbours) {
  return {
    kind: 'neighbourhood',
    paint(ctx, env) {
      drawNeighbourhoods(ctx, env.layout, env.t, { neighbours, hidden: env.hidden, folded: env.folded, shown: env.shown, palette: env.palette,
        height: env.height, anyPicked: env.anyPicked, isPicked: env.isPicked, isFocus: env.isFocus, hoverGroup: env.hover || '' })
    },
    leaderEnd(layout, t, item) {
      // To the first gene of the row's strip (a gene near a chromosome end leaves slots
      // empty), to the column's start while it loads, else on to the label.
      const entry = neighbours.byLeafId?.get(item.id)
      const slots = entry?.genes ? stripGeometry(layout, t, item, entry, neighbours) : null
      if (slots?.length) return sideOf(layout, item).flipHorizontal ? slots[slots.length - 1].x + NEIGHBOUR_SLOT - 4 : slots[0].x + 4
      return neighbours.pending?.has(item.id) ? toScreen(t, alignXOf(layout, item), item.y)[0] : null
    },
    hit(layout, t, sx, sy, plan, inPass = null) {
      const found = neighbourHit(layout, t, sx, sy, neighbours, plan, inPass)
      return found ? { item: found.item, part: 'neighbour', gene: found.gene, entry: found.entry,
        hoverKey: neighbours.matcher?.group(found.gene) || '' } : null
    },
  }
}

/** The neighbour gene under a screen point: `{item, gene, entry}` or null. */
export function neighbourHit(layout, t, sx, sy, neighbours, plan = null, inPass = null) {
  if (!neighbours || !layout?.labelOffset || layout.radial || layout.alignX === undefined) return null
  const pitch = layout.pitch * t.k
  if (pitch < NEIGHBOUR_ARROW_PX) return null
  const half = Math.min(pitch / 2, NEIGHBOUR_GENE_H / 2 + 2)
  const hidden = plan?.folds?.hidden
  const folded = plan?.folds?.folded
  for (const item of layout.items) {
    if (item.kind !== 'leaf' || hidden?.has(item.id) || folded?.has(item.id) || (inPass && !inPass(item.id))) continue
    const iy = toScreen(t, 0, item.y)[1]
    if (Math.abs(iy - sy) > half) continue
    const entry = neighbours.byLeafId.get(item.id)
    if (!entry?.genes) continue
    for (const { gene, x } of stripGeometry(layout, t, item, entry, neighbours)) {
      if (sx >= x + 4 && sx <= x + NEIGHBOUR_SLOT - 4) return { item, gene, entry }
    }
  }
  return null
}
