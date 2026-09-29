import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import {
  DRAG_AXIS_THRESHOLD_PX, beginWheelGesture, clamp, isTextEntryTarget, readKeyEvent, readWheelEvent,
  resolveKeyAction, resolveWheelAction,
} from '../../utils/browsingControls.js'
import { branchAt, branchMid, contentBounds, fragmentTagAt, hitTest, LABEL_GAP, neighbourHit, paintTree, selectionHit, toScreen } from './paintTree.js'

const MAX_ZOOM = 4
const PAD = 28

// Cursors for the layer tools: scissors over a branch Cut can take, and a remove mark over
// what Remove would delete. Drawn twice (dark, then colour) so they read on either theme.
const svgCursor = (paths, colour, hotspot) => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>`
    + `<g stroke='%23101826' stroke-width='4'>${paths}</g><g stroke='${colour}' stroke-width='2'>${paths}</g></svg>`
  return `url("data:image/svg+xml;utf8,${svg}") ${hotspot}, crosshair`
}
// A subtree layer's tools, and those of them that take hold of a whole fragment.
const LAYER_TOOLS = new Set(['move', 'merge', 'graft', 'cut', 'remove'])
const LIFT_TOOLS = new Set(['move', 'merge', 'graft'])
const SCISSORS_CURSOR = svgCursor("<circle cx='6' cy='6' r='3'/><circle cx='6' cy='18' r='3'/><path d='M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12'/>", '%23edc263', '12 12')
const REMOVE_CURSOR = svgCursor("<circle cx='12' cy='12' r='8'/><path d='M8.5 8.5l7 7M15.5 8.5l-7 7'/>", '%23fb7185', '12 12')

/**
 * The tree's drawing surface. It owns the pan/zoom transform (kept in a ref and
 * painted on the next frame, so a gesture never waits on React) and turns pointer
 * input into node events for the view to act on. Wheel and trackpad gestures go
 * through the shared browsing-control scheme, so the tree answers to the same
 * settings as the Genome Browser; since this surface is not a page, the scheme's
 * "scroll the page" is read as moving up and down the tree.
 */
const TreeCanvas = forwardRef(function TreeCanvas({
  index, layout, links, focusId, focusIds = null, focusPath, selected, palette, topbarAssemblies, genomeColors, controls, fitKey, focusRowId,
  onNodeClick, onHover, ariaLabel,
  // Subtree layers: the active tool, what is picked, fragment name tags, a subtree lifted
  // by the Connect tool, and the callbacks the tools report through.
  tool = 'explore', picked = null, fragmentTags = null, onMarquee, onToolClick, onDragOut, onUnpick,
  // A subtree layer's own tools (move, merge, graft, cut, remove): what they do is reported
  // through `onLayerAction`, a drag in progress through `onLayerDrag`, and whether one
  // fragment may merge into another is asked of `canMerge(from, into)` → {ok, why}.
  onLayerAction, onLayerDrag, canMerge,
  // Colours of the layers each Original node has been copied into (ticks beside it).
  marks = null,
  // Which thing is shown, the layout it is drawn in, and where to keep each one's camera.
  viewKey = '', layoutSig = '', cameras = null,
  // Pixels at the top of the canvas a fit keeps clear (something floats over them).
  insetTop = 0,
  // A data column's contents: `{byLeafId, pending, colours}` (the Neighbourhood view).
  neighbours = null,
}, ref) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const size = useRef({ width: 0, height: 0 })
  const t = useRef({ k: 1, x: PAD, y: PAD })
  const limits = useRef({ min: 0.05, kxFloor: 1 })
  // A transform for row scale k: the horizontal scale follows it down only as far as
  // fitting the tree's width, then holds.
  const withScale = (k, x, y) => ({ k, kx: Math.max(k, limits.current.kxFloor), x, y })
  const labelCache = useRef(new Map())
  const frame = useRef(0)
  const drag = useRef(null)
  const gesture = useRef(null)
  const anchor = useRef(null)
  const hover = useRef(-1)
  const props = useRef({})
  const plan = useRef(null) // the painter's last label/fold plan, so a click hits what is drawn
  const animation = useRef(0)
  // While the view is moving (wheel, drag, keys, a glide into a clade) no details card may
  // appear; once it has been still for a moment, whatever is under the resting pointer is
  // offered again, so the card's wait starts from when the view settled.
  const pointer = useRef(null)
  const marquee = useRef(null)
  const adjusting = useRef(false)
  const settleTimer = useRef(0)
  const onHoverRef = useRef(onHover)
  useLayoutEffect(() => { onHoverRef.current = onHover })
  // Mirrored for the painter and the gesture handlers, which run outside render.
  // Declared first so every later layout effect sees this render's values.
  useLayoutEffect(() => {
    props.current = { index, layout, links, focusId, focusIds, focusPath, selected, palette, topbarAssemblies, genomeColors,
      picked, fragmentTags, tool, marks, cameras, canMerge, insetTop, neighbours }
  })

  // A subtree layer's tools: the fragment being dragged (`lift`: its root, node ids, how
  // far it has moved on screen and what it is over), and the highlight of what a tool is
  // about to act on (`fx`, the painter's `emphasis`).
  const lift = useRef(null)
  const liftCanvas = useRef(null)
  const fx = useRef(null)
  const fxKey = useRef('')
  const neighbourHover = useRef('') // the symbol of the data-column gene under the pointer

  const paint = useCallback(() => {
    frame.current = 0
    const node = canvas.current
    if (!node) return
    const ctx = node.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const base = { ...props.current, t: t.current, width: size.current.width, height: size.current.height,
      hoverId: hover.current, labelCache: labelCache.current, planOut: plan, marquee: marquee.current, emphasis: fx.current,
      neighbourHover: neighbourHover.current }
    const held = lift.current
    if (held?.moved) {
      // The fragment in hand is drawn apart from the rest, where the pointer has taken it.
      // Merging or grafting, it is see-through, so the target it is over shows beneath it.
      paintTree(ctx, { ...base, except: held.ids })
      const off = liftCanvas.current || (liftCanvas.current = document.createElement('canvas'))
      if (off.width !== node.width || off.height !== node.height) { off.width = node.width; off.height = node.height }
      const g = off.getContext('2d')
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, off.width, off.height)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.translate(held.dx, held.dy)
      paintTree(g, { ...base, planOut: null, only: held.ids, noClear: true, emphasis: null, marquee: null, hoverId: -1 })
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = props.current.tool === 'move' ? 0.94 : 0.5
      ctx.drawImage(off, 0, 0)
      ctx.restore()
      return
    }
    paintTree(ctx, base)
  }, [])
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(paint) }, [paint])

  // How far out the user may zoom: past the whole tree (as it is laid out now, however
  // much has been expanded since it was first fitted), so even a huge tree can be seen
  // entire, with clades folding into wedges as they shrink.
  const updateLimits = useCallback(() => {
    const { index: idx, layout: lay } = props.current
    const node = canvas.current
    if (!node || !lay?.items?.length) return
    const b = contentBounds(node.getContext('2d'), idx, lay, labelCache.current)
    const { width, height } = size.current
    const fitRows = (height - PAD * 2) / Math.max(1, b.maxY - b.minY)
    limits.current.min = Math.max(1e-4, Math.min(0.5, fitRows * 0.6))
    // Room for the widest labels a zoomed-out view keeps (a clade name and its count).
    // A radial tree zooms uniformly: squeezing one axis of a circle only distorts it.
    limits.current.kxFloor = lay.radial ? 0 : Math.min(1, Math.max(0.02, (width - PAD * 2 - 300) / Math.max(1, lay.width)))
  }, [])

  const fit = useCallback((centreId = -1) => {
    const { index: idx, layout: lay } = props.current
    const node = canvas.current
    if (!node || !lay?.items?.length) return
    const ctx = node.getContext('2d')
    const b = contentBounds(ctx, idx, lay, labelCache.current)
    const { width, height } = size.current
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY)
    // Room kept clear at the top for anything floating there (a layer's tool bar).
    const top = PAD + (props.current.insetTop || 0)
    const room = height - top - PAD
    const fitWidth = (width - PAD * 2) / bw
    const fitAll = Math.min(fitWidth, room / bh)
    // Fit the whole tree when that keeps rows readable; otherwise fit its width
    // and let the user move down it, rather than shrinking labels into a smear.
    const readable = 14 / lay.pitch
    updateLimits()
    if (lay.radial) {
      // The whole circle, centred: labels thin out and clades fold until zoomed into.
      const kr = clamp(Math.min(2, fitAll), 1e-4, MAX_ZOOM)
      t.current = withScale(kr, width / 2 - ((b.minX + b.maxX) / 2) * kr, height / 2 - ((b.minY + b.maxY) / 2) * kr)
      schedule()
      return
    }
    const k = clamp(Math.min(2, fitWidth, Math.max(fitAll, readable)), 1e-4, MAX_ZOOM)
    const kx = Math.max(k, limits.current.kxFloor)
    const x = PAD - b.minX * kx + Math.max(0, (width - PAD * 2 - bw * kx) / 2)
    let y
    if (bh * k <= room) y = top - b.minY * k + (room - bh * k) / 2
    else {
      const item = centreId >= 0 ? lay.byId.get(centreId) : null
      y = item ? height / 2 - item.y * k : top - b.minY * k
    }
    t.current = withScale(k, x, y)
    schedule()
  }, [schedule, updateLimits])

  const rehover = useCallback(() => {
    const at = pointer.current
    if (!at || drag.current) return
    const hit = hitTest(props.current.layout, t.current, at.sx, at.sy, labelCache.current, plan.current)
    const id = hit ? hit.item.id : -1
    if (id !== hover.current) { hover.current = id; schedule() }
    onHoverRef.current?.(hit, at.clientX, at.clientY)
  }, [schedule])

  const markAdjusting = useCallback(() => {
    if (!adjusting.current) {
      adjusting.current = true
      onHoverRef.current?.(null)
    }
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      adjusting.current = false
      rehover()
    }, 220)
  }, [rehover])

  const zoomAt = useCallback((factor, sx, sy) => {
    markAdjusting()
    const cur = t.current
    const k = clamp(cur.k * factor, limits.current.min, MAX_ZOOM)
    const next = withScale(k, 0, 0)
    const kxOld = cur.kx ?? cur.k
    t.current = { ...next, x: sx - (sx - cur.x) * (next.kx / kxOld), y: sy - (sy - cur.y) * (k / cur.k) }
    schedule()
  }, [schedule, markAdjusting])

  const panBy = useCallback((dx, dy) => {
    markAdjusting()
    t.current = { ...t.current, x: t.current.x + dx, y: t.current.y + dy }
    schedule()
  }, [schedule, markAdjusting])

  /** Glide to a transform, for a click that opens a folded clade by zooming into it. */
  const animateTo = useCallback(target => {
    cancelAnimationFrame(animation.current)
    const from = { ...t.current }
    const started = performance.now()
    const step = now => {
      const f = Math.min(1, (now - started) / 320)
      const e = 1 - Math.pow(1 - f, 3)
      // Interpolate the scale geometrically so the zoom feels even.
      const k = from.k * Math.pow(target.k / from.k, e)
      t.current = withScale(k, from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e)
      markAdjusting()
      paint()
      if (f < 1) animation.current = requestAnimationFrame(step)
    }
    animation.current = requestAnimationFrame(step)
  }, [paint, markAdjusting])

  const zoomInto = useCallback(item => {
    const { width, height } = size.current
    if (props.current.layout?.radial) {
      // The slice's bounding box: its node and the arc its leaves span.
      const points = [[item.x, item.y]]
      for (let i = 0; i <= 8; i++) {
        const a = item.a0 + ((item.a1 - item.a0) * i) / 8
        points.push([item.reach * Math.cos(a), item.reach * Math.sin(a)])
      }
      const xs = points.map(p => p[0]), ys = points.map(p => p[1])
      const bw = Math.max(1, Math.max(...xs) - Math.min(...xs)), bh = Math.max(1, Math.max(...ys) - Math.min(...ys))
      const k = clamp(Math.min((width - PAD * 8) / bw, (height - PAD * 8) / bh, 1.25), t.current.k * 1.5, MAX_ZOOM)
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2
      animateTo({ k, x: width / 2 - cx * k, y: height / 2 - cy * k })
      return
    }
    const span = Math.max(props.current.layout.pitch, item.y1 - item.y0)
    const x0 = Math.min(item.x, item.reach)
    // Enough that the clade's rows are readable, but never past what fits the view.
    const k = clamp(Math.min((height - PAD * 4) / span, 1.25), t.current.k * 1.5, MAX_ZOOM)
    const kx = Math.max(k, limits.current.kxFloor)
    animateTo({ k, x: Math.min(width * 0.2 - x0 * kx, PAD - Math.min(item.x, item.reach) * kx + width * 0.1), y: height / 2 - ((item.y0 + item.y1) / 2) * k })
  }, [animateTo])

  const centreOn = useCallback(id => {
    const item = props.current.layout?.byId?.get(id)
    if (!item) return
    const [sx, sy] = toScreen(t.current, item.x, item.y)
    panBy(size.current.width / 3 - sx, size.current.height / 2 - sy)
  }, [panBy])

  // The focus bar's re-centre: glide to a node at a readable zoom (rows at their full
  // pitch, every label showing), with room round it for the clades it sits among. A leaf
  // sits a little right of centre with its label clear of the edge, so what joins it to
  // the rest of the tree is on screen to its left.
  const recentre = useCallback(id => {
    const lay = props.current.layout
    const item = lay?.byId?.get(id)
    if (!item) return false
    const { width, height } = size.current
    // The middle of what is not covered: a bar floating over the top takes its share.
    const inset = props.current.insetTop || 0
    const midY = inset + (height - inset) / 2
    updateLimits()
    const k = clamp(1, limits.current.min, MAX_ZOOM)
    if (lay.radial) {
      animateTo({ k, x: width / 2 - item.x * k, y: midY - item.y * k })
      return true
    }
    const kx = Math.max(k, limits.current.kxFloor)
    const label = LABEL_GAP + (lay.labelOffset || 0) + (labelCache.current.get(id)?.width ?? 220) + 40
    const sx = lay.flipHorizontal ? Math.max(width * 0.45, label) : Math.min(width * 0.55, width - label)
    animateTo({ k, x: sx - item.x * kx, y: midY - item.y * k })
    return true
  }, [animateTo, updateLimits])

  useImperativeHandle(ref, () => ({ fit, centreOn, recentre, zoomInto, canvas: () => canvas.current, repaint: schedule }), [fit, centreOn, recentre, zoomInto, schedule])

  // Size and DPR.
  useLayoutEffect(() => {
    const element = wrap.current
    if (!element) return undefined
    const resize = () => {
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) }
      const node = canvas.current
      node.width = Math.round(size.current.width * dpr)
      node.height = Math.round(size.current.height * dpr)
      node.style.width = `${size.current.width}px`
      node.style.height = `${size.current.height}px`
      paint()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [paint])

  // A new tree (or an explicit reset) fits; anything else keeps the view where it is,
  // holding a clicked node still while the tree reflows around it.
  //
  // Each thing shown (the Original of a tree, each layer) keeps its own camera in
  // `cameras`: leaving one records where the user was, and coming back puts them there
  // again rather than refitting — unless the view asked for a fit at the same moment (new
  // content copied in), or the camera was taken under another layout (shape, branches,
  // phylogram), where the same numbers would point somewhere else entirely.
  const lastFit = useRef(null)
  const lastView = useRef(null)
  const lastSig = useRef(null)
  const saveCamera = useCallback(() => {
    if (lastView.current !== null && props.current.cameras) {
      props.current.cameras.set(lastView.current, { t: { ...t.current }, sig: lastSig.current })
    }
  }, [])
  useEffect(() => () => saveCamera(), [saveCamera])
  useLayoutEffect(() => {
    labelCache.current = new Map()
    const switched = viewKey !== lastView.current
    const fitAsked = fitKey !== lastFit.current
    const mounting = lastView.current === null
    if (switched) saveCamera()
    lastView.current = viewKey
    lastFit.current = fitKey
    lastSig.current = layoutSig
    const saved = switched && (mounting || !fitAsked) ? cameras?.get(viewKey) : null
    if (saved && saved.sig === layoutSig) {
      anchor.current = null
      updateLimits()
      t.current = { ...saved.t }
      schedule()
      return
    }
    if (fitAsked || switched) {
      anchor.current = null
      fit(focusRowId ?? -1)
      return
    }
    updateLimits()
    t.current = { ...t.current, kx: Math.max(t.current.k, limits.current.kxFloor) }
    const held = anchor.current
    anchor.current = null
    if (held && layout?.byId?.has(held.id)) {
      const item = layout.byId.get(held.id)
      const [sx, sy] = toScreen(t.current, item.x, item.y)
      t.current = { ...t.current, x: t.current.x + held.sx - sx, y: t.current.y + held.sy - sy }
    }
    schedule()
  }, [layout, fitKey, focusRowId, fit, schedule, updateLimits, viewKey, layoutSig, cameras, saveCamera])

  useEffect(() => { schedule() }, [links, focusId, focusIds, focusPath, selected, palette, topbarAssemblies, genomeColors, picked,
    fragmentTags, marks, neighbours, schedule])
  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    cancelAnimationFrame(animation.current)
    clearTimeout(settleTimer.current)
  }, [])

  const point = event => {
    const rect = canvas.current.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }
  const holdNode = item => {
    const [sx, sy] = toScreen(t.current, item.x, item.y)
    anchor.current = { id: item.id, sx, sy }
  }

  // Wheel: non-passive, so it can stop the page (and Chromium's page zoom) from reacting.
  useEffect(() => {
    const element = canvas.current
    if (!element) return undefined
    const onWheel = event => {
      const wheel = readWheelEvent(event)
      gesture.current = beginWheelGesture(gesture.current, wheel, wheel.ts)
      const intent = resolveWheelAction(wheel, controls, {
        // Never "at max zoom": the scheme would hand an outward zoom over to page scrolling,
        // which here means panning, and the tree would slide away once fully zoomed out.
        atMaxZoom: false, canScrollPage: true, gesture: gesture.current,
      })
      gesture.current.mode = intent.nextGestureMode || gesture.current.mode
      if (intent.type === 'none') { if (intent.preventDefault) event.preventDefault(); return }
      event.preventDefault()
      const [sx, sy] = point(event)
      if (intent.type === 'zoom') {
        const cx = intent.anchor === 'center' ? size.current.width / 2 : sx
        const cy = intent.anchor === 'center' ? size.current.height / 2 : sy
        zoomAt(1 / intent.factor, cx, cy)
      } else if (intent.type === 'pan') {
        const vertical = Math.abs(wheel.dy) > Math.abs(wheel.dx)
        panBy(vertical ? 0 : -intent.dxPx, vertical ? -intent.dxPx : 0)
      } else if (intent.type === 'page_scroll') {
        panBy(-wheel.dx, -wheel.dy)
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [controls, panBy, zoomAt])

  const hitAt = (sx, sy) => hitTest(props.current.layout, t.current, sx, sy, labelCache.current, plan.current)
  // The picked node under a point, or -1: its glyph, its label or pill, or the gold branch
  // into it (a few pixels either side, so a branch is easy to take hold of).
  const pickedAt = (sx, sy, hit = hitAt(sx, sy)) => {
    const picked = props.current.picked
    if (!picked?.size) return -1
    if (hit) return picked.has(hit.item.id) ? hit.item.id : -1
    const reach = 5
    const near = selectionHit(props.current.layout, t.current, { x0: sx - reach, y0: sy - reach, x1: sx + reach, y1: sy + reach },
      labelCache.current, plan.current)
    for (const id of near) if (picked.has(id)) return id
    return -1
  }
  // A picked node that stands for a clade — a folded pill, or a wedge when zoomed out —
  // is deselected with everything beneath it: the clade is what the user sees there.
  const standsForClade = (id, hit) => {
    const item = props.current.layout?.byId?.get(id)
    return item?.kind === 'collapsed' || hit?.part === 'folded' || Boolean(plan.current?.folds?.folded?.has(id))
  }

  // ── a subtree layer's tools ──
  const childMap = lay => lay.children || (lay.children = (() => {
    const map = new Map()
    for (const item of lay.items) if (item.parent >= 0) {
      if (!map.has(item.parent)) map.set(item.parent, [])
      map.get(item.parent).push(item.id)
    }
    return map
  })())
  const subtreeOf = (lay, id) => {
    const out = new Set([id])
    const stack = [id]
    while (stack.length) for (const child of childMap(lay).get(stack.pop()) || []) { out.add(child); stack.push(child) }
    return out
  }
  // The root of the fragment a drawn node belongs to (the child of the invisible root).
  const fragmentRootOf = (lay, id) => {
    for (let at = id; ;) {
      const item = lay.byId.get(at)
      const parent = item && lay.byId.get(item.parent)
      if (!parent) return -1
      if (parent.node.virtual) return at
      at = item.parent
    }
  }
  const screenOf = item => toScreen(t.current, item.x, item.y)
  // A fragment's outline on screen: its nodes, their labels, and its name tag above.
  const fragmentBox = (lay, rootId) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of subtreeOf(lay, rootId)) {
      const item = lay.byId.get(id)
      const [sx, sy] = screenOf(item)
      const label = item.kind !== 'internal' ? LABEL_GAP + (lay.labelOffset || 0) + (labelCache.current.get(id)?.width ?? 0) : 0
      x0 = Math.min(x0, lay.flipHorizontal ? sx - label : sx); x1 = Math.max(x1, lay.flipHorizontal ? sx : sx + label)
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy)
    }
    return { x0: x0 - 14, y0: y0 - 36, x1: x1 + 10, y1: y1 + 14 }
  }
  // What a layer tool is pointing at: a fragment's name tag (drawn over everything, so it
  // wins), else a node's glyph or label, else the branch into a node. `skip(id)` rules
  // nodes out (the fragment being dragged).
  const layerNodeAt = (sx, sy, skip = null) => {
    const lay = props.current.layout
    if (!lay?.forest) return -1
    const tagged = fragmentTagAt(props.current.fragmentTags, sx, sy)
    if (tagged) {
      const item = lay.items.find(i => i.node.fragRoot === tagged)
      if (item && !skip?.(item.id)) return item.id
    }
    const hit = hitAt(sx, sy)
    if (hit && !hit.item.node.virtual && !skip?.(hit.item.id)) return hit.item.id
    const branch = branchAt(lay, t.current, sx, sy, { skip, plan: plan.current })
    return branch ? branch.id : -1
  }
  // The fragment under a point: whatever of it is pointed at, else the outline it sits in.
  const layerFragmentAt = (sx, sy, skip = null) => {
    const lay = props.current.layout
    const id = layerNodeAt(sx, sy, skip)
    if (id >= 0) return fragmentRootOf(lay, id)
    let best = -1, area = Infinity
    for (const rootId of childMap(lay).get(lay.items[0].id) || []) {
      if (skip?.(rootId)) continue
      const box = fragmentBox(lay, rootId)
      if (sx < box.x0 || sx > box.x1 || sy < box.y0 || sy > box.y1) continue
      const size = (box.x1 - box.x0) * (box.y1 - box.y0)
      if (size < area) { area = size; best = rootId }
    }
    return best
  }
  // Where a fragment would sit (root x, top row) with `removed` taken out of it: so what
  // is left after a cut or a removal stays where it was on screen.
  const restPlace = (lay, rootId, removed) => {
    const parent = childMap(lay).get(rootId) || []
    const survivors = parent.filter(c => !removed.has(c))
    const newRoot = survivors.length === 1 ? survivors[0] : rootId
    let top = Infinity
    for (const id of subtreeOf(lay, rootId)) if (!removed.has(id) && lay.byId.get(id).kind !== 'internal') top = Math.min(top, lay.byId.get(id).y)
    return Number.isFinite(top) ? { x: lay.byId.get(newRoot).x, y: top } : null
  }
  // Where every fragment is now (root x, top row), so the first move can pin them all:
  // arranging one fragment should never send the others elsewhere.
  const places = lay => {
    const out = {}
    for (const rootId of childMap(lay).get(lay.items[0].id) || []) {
      let top = Infinity
      for (const id of subtreeOf(lay, rootId)) top = Math.min(top, lay.byId.get(id).y)
      out[lay.byId.get(rootId).node.fragRoot] = { x: lay.byId.get(rootId).x, y: top }
    }
    return out
  }
  const setFx = (next, key) => {
    if (key === fxKey.current) return
    fxKey.current = key
    fx.current = next
    schedule()
  }
  // A drag in hand: what it is over, and how that is shown.
  const liftTarget = (sx, sy) => {
    const held = lift.current
    const p = props.current
    const lay = p.layout
    const skip = id => held.ids.has(id)
    const gold = '#edc263'
    held.target = null
    if (p.tool === 'merge') {
      const rootId = layerFragmentAt(sx, sy, skip)
      if (rootId >= 0) {
        const fragmentId = lay.byId.get(rootId).node.fragRoot
        const verdict = p.canMerge?.(held.fragmentId, fragmentId) || { ok: true }
        held.target = { rootId, fragmentId, ok: verdict.ok, why: verdict.why || '' }
        const colour = verdict.ok ? gold : p.palette.focus
        return setFx({ box: { ...fragmentBox(lay, rootId), color: colour, dash: verdict.ok ? null : [5, 4] },
          edges: [{ ids: subtreeOf(lay, rootId), color: colour, width: 2.5 }] }, `m${rootId}${verdict.ok}`)
      }
    } else if (p.tool === 'graft') {
      const id = layerNodeAt(sx, sy, skip)
      if (id >= 0) {
        const root = fragmentRootOf(lay, id) === id
        const item = lay.byId.get(id)
        const [ix, iy] = screenOf(item)
        // Onto a root: the graft makes a new root, just outside the old one.
        const at = root ? [ix + (lay.flipHorizontal ? 18 : -18), iy] : branchMid(lay, t.current, id)
        held.target = { nodeId: id, root }
        return setFx({ edges: root ? [] : [{ ids: new Set([id]), color: gold, width: 4.5 }], rings: root ? [{ id, color: gold }] : [],
          junction: at ? { at, color: gold } : null }, `g${id}`)
      }
    }
    setFx(null, '')
  }
  // Hovering with a layer tool: what a click (or a press and drag) would take.
  const layerHover = (sx, sy) => {
    const p = props.current
    const lay = p.layout
    if (!lay?.forest) { setFx(null, ''); return null }
    const tool = p.tool
    if (tool === 'move' || tool === 'merge' || tool === 'graft') {
      if (tool === 'move' && lay.radial) { setFx(null, ''); return null }
      const rootId = layerFragmentAt(sx, sy)
      if (rootId < 0) { setFx(null, ''); return null }
      setFx({ box: { ...fragmentBox(lay, rootId), color: p.palette.muted, dash: [4, 4] } }, `h${rootId}`)
      return 'grab'
    }
    if (tool === 'cut') {
      const id = layerNodeAt(sx, sy)
      if (id < 0 || fragmentRootOf(lay, id) === id) { setFx(null, ''); return null }
      setFx({ edges: [{ ids: new Set([id]), color: '#edc263', width: 4.5, dash: [5, 4] }],
        junction: { at: branchMid(lay, t.current, id), color: '#edc263' } }, `c${id}`)
      return SCISSORS_CURSOR
    }
    if (tool === 'remove') {
      const id = layerNodeAt(sx, sy)
      if (id < 0) { setFx(null, ''); return null }
      const root = fragmentRootOf(lay, id)
      const red = p.palette.focus
      setFx({ edges: [{ ids: subtreeOf(lay, id), color: red, width: 3 }], rings: [{ id, color: red }],
        box: id === root ? { ...fragmentBox(lay, root), color: red, dash: [5, 4] } : null }, `r${id}`)
      return REMOVE_CURSOR
    }
    setFx(null, '')
    return null
  }

  // The picked subtree as a picture, for the drag to carry: the tree painted again with
  // nothing but the picks, cropped to what was drawn. Screen-sized at most, so it is cheap.
  const snapshotPicked = () => {
    const element = canvas.current
    const { width, height } = size.current
    if (!element || !width || !height) return null
    const dpr = window.devicePixelRatio || 1
    const full = document.createElement('canvas')
    full.width = Math.ceil(width * dpr)
    full.height = Math.ceil(height * dpr)
    const ctx = full.getContext('2d', { willReadFrequently: true })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintTree(ctx, { ...props.current, t: t.current, width, height, hoverId: -1, labelCache: labelCache.current, onlyPicked: true })
    const pixels = new Uint32Array(ctx.getImageData(0, 0, full.width, full.height).data.buffer)
    let x0 = full.width, y0 = full.height, x1 = -1, y1 = -1
    for (let y = 0; y < full.height; y++) {
      const row = y * full.width
      for (let x = 0; x < full.width; x++) {
        if ((pixels[row + x] >>> 24) < 16) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
    if (x1 < 0) return null
    const pad = Math.ceil(3 * dpr)
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad)
    x1 = Math.min(full.width - 1, x1 + pad); y1 = Math.min(full.height - 1, y1 + pad)
    const crop = document.createElement('canvas')
    crop.width = x1 - x0 + 1
    crop.height = y1 - y0 + 1
    crop.getContext('2d').drawImage(full, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height)
    const rect = element.getBoundingClientRect()
    return { url: crop.toDataURL(), left: rect.left + x0 / dpr, top: rect.top + y0 / dpr, width: crop.width / dpr, height: crop.height / dpr }
  }

  const onPointerDown = event => {
    cancelAnimationFrame(animation.current)
    if (event.button !== 0) return
    canvas.current.focus({ preventScroll: true })
    const [sx, sy] = point(event)
    const hit = hitAt(sx, sy)
    // Which gesture this press starts: a drag of the selection out to a layer (pressing on
    // anything picked, whatever the tool — the selection is what is under the pointer), a
    // selection box (Select, or ⇧ with any tool, which also adds to what is picked), or
    // moving the view.
    const current = props.current
    let kind = 'pan'
    let held = null
    const pickedId = event.shiftKey ? -1 : pickedAt(sx, sy, hit)
    const lay = current.layout
    if (pickedId >= 0) kind = 'transfer'
    else if (event.shiftKey || current.tool === 'select') kind = 'marquee'
    else if (LIFT_TOOLS.has(current.tool) && lay?.forest && !(current.tool === 'move' && lay.radial)) {
      // Move, Merge and Graft take hold of a whole fragment, wherever it is pressed.
      const rootId = layerFragmentAt(sx, sy)
      if (rootId >= 0) {
        kind = 'lift'
        held = { rootId, fragmentId: lay.byId.get(rootId).node.fragRoot, ids: subtreeOf(lay, rootId) }
      }
    }
    drag.current = { kind, startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false, id: event.pointerId, shift: event.shiftKey,
      pickedId, clade: pickedId >= 0 && standsForClade(pickedId, hit), pressX: event.clientX, pressY: event.clientY, held }
    canvas.current.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = event => {
    const [sx, sy] = point(event)
    pointer.current = { sx, sy, clientX: event.clientX, clientY: event.clientY }
    const current = drag.current
    if (current) {
      const threshold = current.kind === 'transfer' || current.kind === 'lift' ? 2 : DRAG_AXIS_THRESHOLD_PX
      if (!current.moved && Math.hypot(sx - current.startX, sy - current.startY) > threshold) {
        current.moved = true
        onHover?.(null)
        hover.current = -1
      }
      if (current.moved) {
        if (current.kind === 'marquee') {
          marquee.current = { x0: current.startX, y0: current.startY, x1: sx, y1: sy }
          schedule()
        } else if (current.kind === 'lift') {
          // The fragment follows the pointer; what it is over lights up.
          if (!lift.current) lift.current = { ...current.held, moved: true, dx: 0, dy: 0, target: null }
          lift.current.dx = sx - current.startX
          lift.current.dy = sy - current.startY
          liftTarget(sx, sy)
          onLayerDrag?.({ phase: 'move', clientX: event.clientX, clientY: event.clientY, tool: props.current.tool,
            fragmentId: lift.current.fragmentId, target: lift.current.target })
          canvas.current.style.cursor = 'grabbing'
          schedule()
        } else if (current.kind === 'transfer') {
          // The first move lifts the picked subtree off the tree: the view carries its
          // picture under the pointer, held where it was taken hold of.
          let image
          if (!current.lifted) {
            current.lifted = true
            const snap = snapshotPicked()
            if (snap) image = { ...snap, grabX: current.pressX - snap.left, grabY: current.pressY - snap.top }
          }
          onDragOut?.({ phase: 'move', clientX: event.clientX, clientY: event.clientY, image })
          canvas.current.style.cursor = 'grabbing'
        } else {
          panBy(sx - current.lastX, sy - current.lastY)
          canvas.current.style.cursor = 'grabbing'
        }
        current.lastX = sx
        current.lastY = sy
        return
      }
    }
    // Mid-zoom (a trackpad fling, say) the pointer is only noted; the settle picks it up.
    if (adjusting.current) return
    let hit = hitAt(sx, sy)
    // Over a gene in the data column: its card, and every copy of it down the column lit.
    const neighbour = hit ? null : neighbourHit(props.current.layout, t.current, sx, sy, props.current.neighbours, plan.current)
    const symbol = neighbour ? String(neighbour.gene.name || '').trim().toLowerCase() : ''
    if (symbol !== neighbourHover.current) { neighbourHover.current = symbol; schedule() }
    if (neighbour) hit = { item: neighbour.item, part: 'neighbour', gene: neighbour.gene, entry: neighbour.entry }
    const id = hit && hit.part !== 'neighbour' ? hit.item.id : -1
    const tool = props.current.tool
    const layerCursor = LAYER_TOOLS.has(tool) ? layerHover(sx, sy) : null
    canvas.current.style.cursor = pickedAt(sx, sy, hit) >= 0 ? 'grab'
      : layerCursor || (tool === 'select' ? 'crosshair'
        : hit || fragmentTagAt(props.current.fragmentTags, sx, sy) ? 'pointer' : 'grab')
    if (id !== hover.current) {
      hover.current = id
      schedule()
    }
    onHover?.(hit, event.clientX, event.clientY)
  }
  const onPointerUp = event => {
    const current = drag.current
    drag.current = null
    canvas.current.releasePointerCapture?.(event.pointerId)
    canvas.current.style.cursor = props.current.tool === 'select' ? 'crosshair' : 'grab'
    if (!current) return
    const [sx, sy] = point(event)
    if (current.kind === 'lift') {
      const held = lift.current
      lift.current = null
      setFx(null, '')
      schedule()
      if (!held) return
      onLayerDrag?.({ phase: 'end' })
      const lay = props.current.layout
      const tool = props.current.tool
      if (tool === 'move') {
        // Where it was put: its root's x and its top row, in world units.
        let top = Infinity
        for (const id of held.ids) top = Math.min(top, lay.byId.get(id).y)
        const root = lay.byId.get(held.rootId)
        onLayerAction?.({ type: 'move', fragmentId: held.fragmentId, places: places(lay),
          pos: { x: root.x + held.dx / (t.current.kx ?? t.current.k), y: top + held.dy / t.current.k } })
      } else if (tool === 'merge' && held.target) {
        onLayerAction?.({ type: 'merge', places: places(lay), fragmentId: held.fragmentId, into: held.target.fragmentId, ok: held.target.ok, why: held.target.why })
      } else if (tool === 'graft' && held.target) {
        onLayerAction?.({ type: 'graft', places: places(lay), fragmentId: held.fragmentId, nodeId: held.target.nodeId, root: held.target.root })
      }
      return
    }
    if (!current.moved && (props.current.tool === 'cut' || props.current.tool === 'remove') && props.current.layout?.forest) {
      const lay = props.current.layout
      const id = layerNodeAt(sx, sy)
      if (id < 0) return
      const rootId = fragmentRootOf(lay, id)
      setFx(null, '')
      if (props.current.tool === 'cut') {
        if (id === rootId) return
        const clade = subtreeOf(lay, id)
        let top = Infinity
        for (const n of clade) top = Math.min(top, lay.byId.get(n).y)
        // The piece cut off comes away sideways, clear of what is left, at the height it was:
        // left in place, it would sit on top of the rest as that closes up.
        const box = fragmentBox(lay, rootId)
        const kx = t.current.kx ?? t.current.k
        const clear = lay.flipHorizontal ? (box.x0 - 40 - t.current.x) / kx : (box.x1 + 40 - t.current.x) / kx
        onLayerAction?.({ type: 'cut', nodeId: id, places: places(lay), cladePos: { x: clear, y: top }, restPos: restPlace(lay, rootId, clade) })
      } else {
        onLayerAction?.({ type: 'remove', nodeId: id, whole: id === rootId, places: places(lay), restPos: id === rootId ? null : restPlace(lay, rootId, subtreeOf(lay, id)) })
      }
      return
    }
    if (current.moved) {
      if (current.kind === 'marquee') {
        const rect = marquee.current
        marquee.current = null
        schedule()
        if (rect) onMarquee?.(selectionHit(props.current.layout, t.current, rect, labelCache.current, plan.current), { shift: current.shift })
      } else if (current.kind === 'transfer') {
        onDragOut?.({ phase: 'drop', clientX: event.clientX, clientY: event.clientY })
      }
      return
    }
    // A click on something picked, with any tool, deselects it — not the tool's usual click
    // (fold, focus, pick): the likeliest reason to click a pick is that it was taken by
    // mistake. ⌥-click takes everything picked beneath it too.
    if (current.kind === 'transfer' && current.pickedId >= 0) {
      onUnpick?.({ id: current.pickedId, clade: current.clade || event.altKey })
      return
    }
    const tool = props.current.tool
    const hit = hitAt(sx, sy)
    const tagged = fragmentTagAt(props.current.fragmentTags, sx, sy)
    const mods = { alt: event.altKey, shift: event.shiftKey, meta: event.metaKey || event.ctrlKey, part: hit?.part }
    if (tool !== 'explore') {
      // The tools act on what was clicked: a node, a subtree's name tag, or nothing.
      onToolClick?.(hit ? { kind: 'node', item: hit.item, part: hit.part } : tagged ? { kind: 'fragment', fragmentId: tagged } : { kind: 'empty' }, mods)
      return
    }
    if (!hit) {
      if (tagged) onToolClick?.({ kind: 'fragment', fragmentId: tagged }, mods)
      return
    }
    if (hit.part === 'folded' && !event.altKey && !event.shiftKey) {
      hover.current = -1
      onHover?.(null)
      zoomInto(hit.item)
      return
    }
    holdNode(hit.item)
    onNodeClick?.(hit.item, mods)
  }
  const cancelDrag = () => {
    const current = drag.current
    drag.current = null
    if (marquee.current) { marquee.current = null; schedule() }
    if (current?.kind === 'transfer' && current.moved) onDragOut?.({ phase: 'cancel' })
    if (lift.current) {
      // The fragment goes back where it was.
      lift.current = null
      setFx(null, '')
      schedule()
      onLayerDrag?.({ phase: 'end' })
    }
  }
  const onPointerLeave = () => {
    pointer.current = null
    if (neighbourHover.current) { neighbourHover.current = ''; schedule() }
    if (!drag.current) setFx(null, '')
    if (hover.current !== -1) { hover.current = -1; schedule() }
    onHover?.(null)
  }
  const onKeyDown = event => {
    if (isTextEntryTarget(event.target)) return
    if (event.key === 'Escape' && drag.current) { cancelDrag(); return }
    const key = readKeyEvent(event)
    if (key.key === 'ArrowUp' || key.key === 'ArrowDown') {
      event.preventDefault()
      panBy(0, (key.key === 'ArrowUp' ? 1 : -1) * size.current.height * (key.shift ? 0.5 : 0.1))
      return
    }
    if (key.key === '0' || key.key.toLowerCase() === 'f') { event.preventDefault(); fit(props.current.focusId ?? -1); return }
    const action = resolveKeyAction(key)
    if (action.type === 'pan') { event.preventDefault(); panBy(-action.dxFraction * size.current.width, 0) }
    else if (action.type === 'zoom') { event.preventDefault(); zoomAt(1 / action.factor, size.current.width / 2, size.current.height / 2) }
  }

  return (
    <div ref={wrap} className="gt-canvas-wrap">
      <canvas
        ref={canvas}
        className="gt-canvas"
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelDrag}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      />
    </div>
  )
})

export default TreeCanvas
