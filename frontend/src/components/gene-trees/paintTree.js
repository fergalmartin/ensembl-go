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
import { labelAnchorX } from './treeLayout.js'
import { cladeTitle, leafGeneLabel, leafSpeciesLabel } from './treeModel.js'

export const LABEL_SIZE = 13
const SPECIES_PILL_PAD = 7
export const SMALL_LABEL_SIZE = 12
export const NODE_RADIUS = 5
export const HIT_RADIUS = 10
const LABEL_GAP = 10
const PILL_HEIGHT = 20
const MIN_LABEL_PITCH = 12

export const PALETTES = {
  light: {
    edge: '#8193a8', edgeFocus: '#0b7fd6', text: '#1d2b3a', muted: '#5d6f84', gene: '#0b7fd6',
    speciation: '#0099ff', duplication: '#1d2b3a', dubious: '#9aa6b4', split: '#e0245e',
    pill: '#1d2b3a', pillText: '#ffffff', focus: '#e0245e', hover: 'rgba(0,153,255,0.12)',
    linked: '#0099ff', genome: '#d08a00', unresolved: '#9aa6b4', selection: 'rgba(0,153,255,0.10)', halo: '#ffffff',
    wedge: 'rgba(129,147,168,0.28)', bg: '#f6f8fb', isLight: true,
  },
  dark: {
    edge: '#6d7f96', edgeFocus: '#60a5fa', text: '#e3eaf4', muted: '#9aaac0', gene: '#7cb8ff',
    speciation: '#60a5fa', duplication: '#e3eaf4', dubious: '#7b8898', split: '#fb7185',
    pill: '#dbe5f1', pillText: '#152032', focus: '#fb7185', hover: 'rgba(96,165,250,0.16)',
    linked: '#60a5fa', genome: '#f5b942', unresolved: '#7b8898', selection: 'rgba(96,165,250,0.12)', halo: '#152032',
    wedge: 'rgba(109,127,150,0.30)', bg: '#152032', isLight: false,
  },
}

// `k` scales rows (vertical); `kx` the tree's depth (horizontal). They are equal until the
// user zooms out past the point where the tree's width fits the view: from there on only
// the rows compress, so a huge tree stays a readable shape instead of shrinking to a sliver.
export const toScreen = (t, x, y) => [x * (t.kx ?? t.k) + t.x, y * t.k + t.y]
export const toWorld = (t, sx, sy) => [(sx - t.x) / (t.kx ?? t.k), (sy - t.y) / t.k]

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
    if (item.kind === 'internal') continue
    const { width } = measureTerminal(ctx, index, item, cache)
    const anchor = labelAnchorX(layout, item)
    if (layout.flipHorizontal) minX = Math.min(minX, anchor - LABEL_GAP - width)
    else maxX = Math.max(maxX, anchor + LABEL_GAP + width)
  }
  return { minX, maxX, minY: minY - PILL_HEIGHT, maxY: maxY + PILL_HEIGHT }
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
    if (item.span * t.k < FOLD_PX && !focusPath?.has(id)) {
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

export function labelPlan(layout, index, t, links, topbarAssemblies, focusId, focusPath = null) {
  const pitch = layout.pitch * t.k
  // Recomputing for every frame of a drag is wasted: the plan only changes with the zoom step.
  const step = Math.round(Math.log2(Math.max(pitch, 1e-6)) * 8)
  const cached = layout.lodCache
  if (cached && cached.step === step && cached.links === links && cached.focusId === focusId && cached.topbar === topbarAssemblies
      && cached.focusPath === focusPath) return cached.plan
  const folds = foldPlan(layout, t, focusPath)
  if (pitch >= MIN_LABEL_PITCH && !folds) {
    const plan = { full: true, labelled: null, extra: null, folds: null }
    layout.lodCache = { step, links, focusId, topbar: topbarAssemblies, focusPath, plan }
    return plan
  }
  // A folded clade stands in for its rows, at the middle of its span.
  const rows = layout.items
    .filter(item => (folds?.folded.has(item.id) || item.kind !== 'internal') && !folds?.hidden.has(item.id))
    .map(item => (folds?.folded.has(item.id) ? { id: item.id, lpos: item.lmid, kind: 'folded' } : item))
    .sort((a, b) => a.lpos - b.lpos)
  const priority = item => {
    if (item.id === focusId) return 0
    if (item.kind === 'leaf') {
      const status = linkStatus(links[item.id], topbarAssemblies)
      if (status === 'topbar') return 1
      if (status === 'local') return 2
      return 4
    }
    return 3
  }
  const order = rows.map((item, i) => ({ item, i, p: priority(item), size: index.leafCount[item.id] }))
    .sort((a, b) => a.p - b.p || b.size - a.size || a.i - b.i)
  // Spacing in screen pixels, not rows: a folded clade is one row standing for hundreds.
  const taken = [] // screen y of accepted labels, kept sorted
  const clear = y => {
    let lo = 0, hi = taken.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (taken[mid] < y) lo = mid + 1; else hi = mid }
    return (lo >= taken.length || taken[lo] - y >= LABEL_SPACING) && (lo === 0 || y - taken[lo - 1] >= LABEL_SPACING) ? lo : -1
  }
  const labelled = new Set()
  for (const { item } of order) {
    const y = item.lpos * t.k
    const at = clear(y)
    if (at < 0 && item.id !== focusId) continue
    labelled.add(item.id)
    if (at >= 0) taken.splice(at, 0, y)
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
  layout.lodCache = { step, links, focusId, topbar: topbarAssemblies, focusPath, plan }
  return plan
}

export function paintTree(ctx, state) {
  const { layout, index, t, width, height, palette, links = {}, focusId = -1, focusPath, hoverId = -1,
    selected = new Set(), labelCache, topbarAssemblies, genomeColors } = state
  ctx.clearRect(0, 0, width, height)
  if (!layout?.items?.length) return
  const pitch = layout.pitch * t.k
  const plan = labelPlan(layout, index, t, links, topbarAssemblies, focusId, focusPath)
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
  const onFocusPath = edge => focusPath?.has(edge.to)
  drawEdges(edge => !onFocusPath(edge) && !hidden?.has(edge.to), palette.edge, pitch < 4 ? 1.25 : 1.75)
  if (focusPath?.size) drawEdges(onFocusPath, palette.edgeFocus, 3)

  // Hover and selection washes under terminals.
  for (const item of layout.items) {
    if ((item.id !== hoverId && !selected.has(item.id)) || hidden?.has(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    ctx.fillStyle = item.id === hoverId ? palette.hover : palette.selection
    ctx.beginPath()
    ctx.arc(sx, sy, HIT_RADIUS + 3, 0, Math.PI * 2)
    ctx.fill()
  }

  const labelled = id => plan.full || plan.labelled.has(id)
  // Labels last, so no glyph is drawn over one.
  const labels = []
  for (const item of layout.items) {
    if (hidden?.has(item.id)) continue
    const [sx, sy] = toScreen(t, item.x, item.y)
    const focus = item.id === focusId
    if (folded?.has(item.id)) {
      if (layout.radial) drawRadialWedge(ctx, item, t, palette)
      else {
        const top = toScreen(t, item.reach, item.y0)[1], bottom = toScreen(t, item.reach, item.y1)[1]
        if (bottom < -margin || top > height + margin) continue
        drawWedge(ctx, item, t, palette)
      }
      if (labelled(item.id)) labels.push([item, sx, sy])
      continue
    }
    if (!visible(sx, sy)) continue
    if (item.kind === 'internal') drawInternal(ctx, item, sx, sy, palette, focusPath, scale)
    else if (item.kind === 'collapsed') {
      if (labelled(item.id)) labels.push([item, sx, sy])
      else drawDot(ctx, sx, sy, palette.pill, 3 * scale + 1)
    } else {
      const status = linkStatus(links[item.id], topbarAssemblies)
      drawLeafGlyph(ctx, sx, sy, palette, status, focus, focus ? 1 : scale, genomeColor(links[item.id], genomeColors))
      if (labelled(item.id)) labels.push([item, sx, sy])
    }
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
      const ax = toScreen(t, layout.alignX, item.y)[0]
      const start = sx + (layout.flipHorizontal ? -7 : 7)
      if (Math.abs(ax - sx) < 10) continue
      ctx.moveTo(start, sy)
      ctx.lineTo(ax, sy)
    }
    ctx.stroke()
    ctx.restore()
  }
  for (const [item, sx, sy] of labels) {
    const more = plan.full ? 0 : plan.extra.get(item.id) || 0
    if (layout.radial) {
      drawRadialLabel(ctx, index, item, t, palette, layout, labelCache, { more, folded: folded?.has(item.id), focus: item.id === focusId,
        pill: labelPill(links[item.id], topbarAssemblies, genomeColors, palette) })
      continue
    }
    const ax = layout.alignX !== undefined ? toScreen(t, labelAnchorX(layout, item), item.y)[0] : sx
    if (folded?.has(item.id)) drawWedgeLabel(ctx, index, item, t, palette, layout, more)
    else if (item.kind === 'collapsed') drawCollapsed(ctx, index, item, ax, sy, palette, layout, labelCache, more)
    else {
      const link = links[item.id]
      const status = linkStatus(link, topbarAssemblies)
      const color = genomeColor(link, genomeColors)
      const pill = color && (status === 'topbar' || status === 'local')
        ? genomePillColors(color, { isLight: palette.isLight, state: status === 'topbar' ? 'active' : 'inactive' }) : null
      drawLeafLabel(ctx, index, item, ax, sy, palette, layout, labelCache, item.id === focusId, more, pill)
    }
  }
}

const polarXY = (r, a) => [r * Math.cos(a), r * Math.sin(a)]

function labelPill(link, topbarAssemblies, genomeColors, palette) {
  const status = linkStatus(link, topbarAssemblies)
  const color = genomeColor(link, genomeColors)
  return color && (status === 'topbar' || status === 'local')
    ? genomePillColors(color, { isLight: palette.isLight, state: status === 'topbar' ? 'active' : 'inactive' }) : null
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
function drawRadialLabel(ctx, index, item, t, palette, layout, cache, { more, folded, focus, pill }) {
  const { r, a } = radialLabelStart(layout, item, folded)
  const [sx, sy] = toScreen(t, ...polarXY(r, a))
  const left = Math.cos(a) < 0
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate(left ? a + Math.PI : a)
  const frame = { flipHorizontal: left }
  if (folded) {
    const genes = index.leafCount[item.id] + more
    drawParts(ctx, [[cladeTitle(index, item.id), `italic ${sansFont(LABEL_SIZE, 600)}`, palette.text],
      [`${genes.toLocaleString()} gene${genes === 1 ? '' : 's'}`, sansFont(SMALL_LABEL_SIZE, 400), palette.muted]], 0, 0, left, palette)
  } else if (item.kind === 'collapsed') {
    drawCollapsed(ctx, index, item, 0, 0, palette, frame, cache, more)
  } else {
    drawLeafLabel(ctx, index, item, 0, 0, palette, frame, cache, focus, more, pill)
  }
  ctx.restore()
}

/** A folded radial clade: a slice from its node out to the arc its leaves span. */
function drawRadialWedge(ctx, item, t, palette) {
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
  ctx.strokeStyle = palette.edge
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawWedge(ctx, item, t, palette) {
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
  ctx.strokeStyle = palette.edge
  ctx.lineWidth = 1
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
        ctx.strokeStyle = pill.borderColor
        ctx.lineWidth = 1.5
        ctx.stroke()
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
    `${text}\u0001${font}\u0001${color}\u0001${pill ? `${pill.backgroundColor}${pill.textColor}${pill.borderColor}` : ''}`).join('\u0002')
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

function drawWedgeLabel(ctx, index, item, t, palette, layout, more = 0) {
  const [ex, top] = toScreen(t, layout.alignX ?? item.reach, item.y0)
  const bottom = toScreen(t, item.reach, item.y1)[1]
  const genes = index.leafCount[item.id] + more
  drawParts(ctx, [[cladeTitle(index, item.id), `italic ${sansFont(LABEL_SIZE, 600)}`, palette.text],
    [`${genes.toLocaleString()} gene${genes === 1 ? '' : 's'}`, sansFont(SMALL_LABEL_SIZE, 400), palette.muted]],
  ex, (top + bottom) / 2, layout.flipHorizontal, palette)
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

function drawCollapsed(ctx, index, item, sx, sy, palette, layout, cache, more = 0) {
  const measured = measureTerminal(ctx, index, item, cache)
  const pill = measured.pill - 8
  const left = layout.flipHorizontal ? sx - pill : sx
  ctx.fillStyle = palette.pill
  roundRect(ctx, left, sy - PILL_HEIGHT / 2, pill, PILL_HEIGHT, PILL_HEIGHT / 2)
  ctx.fill()
  ctx.fillStyle = palette.pillText
  ctx.font = sansFont(SMALL_LABEL_SIZE, 700)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index.leafCount[item.id]), left + pill / 2, sy + 0.5)
  const [label] = terminalText(index, item)
  const parts = [[label, `italic ${sansFont(LABEL_SIZE, 400)}`, palette.muted]]
  if (more) parts.push([moreText(more), sansFont(SMALL_LABEL_SIZE, 400), palette.muted])
  drawParts(ctx, parts, layout.flipHorizontal ? left - 8 + LABEL_GAP : left + pill + 8 - LABEL_GAP, sy, layout.flipHorizontal, palette)
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
    ctx.strokeStyle = status === 'local' ? own : status === 'genome' ? palette.genome : palette.unresolved
    ctx.lineWidth = status === 'local' || status === 'genome' ? 2.5 : 1.5
    ctx.beginPath(); ctx.arc(sx, sy, r - 0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    if (status === 'local') drawDot(ctx, sx, sy, own, 2)
  }
}

function drawLeafLabel(ctx, index, item, sx, sy, palette, layout, cache, focus, more = 0, pill = null) {
  const [primary, secondary] = terminalText(index, item)
  const parts = [[primary, sansFont(LABEL_SIZE, pill ? 700 : 600), focus ? palette.focus : palette.text, pill]]
  if (secondary) parts.push([secondary, sansFont(SMALL_LABEL_SIZE, pill ? 600 : 400), palette.gene])
  if (more) parts.push([moreText(more), sansFont(SMALL_LABEL_SIZE, 400), palette.muted])
  drawParts(ctx, parts, sx, sy, layout.flipHorizontal, palette)
  if (focus && pill) {
    // The focus gene keeps its genome's pill; a red underline says it is the focus.
    ctx.font = parts[0][1]
    const w = ctx.measureText(primary).width + SPECIES_PILL_PAD * 2
    const x = layout.flipHorizontal ? sx - LABEL_GAP - w : sx + LABEL_GAP
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
  let best = null
  let bestDistance = HIT_RADIUS * HIT_RADIUS
  for (const item of layout.items) {
    if (hidden?.has(item.id)) continue
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
    const [ix, iy] = toScreen(t, labelAnchorX(layout, item), item.y)
    if (Math.abs(iy - sy) > half) continue
    const width = labelCache?.get(item.id)?.width ?? 120
    const inside = layout.flipHorizontal ? sx <= ix && sx >= ix - LABEL_GAP - width : sx >= ix && sx <= ix + LABEL_GAP + width
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
