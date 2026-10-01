import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import {
  DRAG_AXIS_THRESHOLD_PX, beginWheelGesture, clamp, isTextEntryTarget, readKeyEvent, readWheelEvent,
  resolveKeyAction, resolveWheelAction,
} from '../../utils/browsingControls.js'
import { branchAt, branchMid, contentBounds, fragmentTagAt, fragmentTagBox, hitTest, LABEL_GAP, labelOffsetOf, paintTree, readableOn, selectionHit, toScreen } from './paintTree.js'
import { alignSnap, alignXOf, sideOf } from './treeLayout.js'
import { lockWheelAxis, newWheelAxis } from './wheelAxis.js'

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
const LAYER_TOOLS = new Set(['move', 'merge', 'graft', 'cut', 'remove', 'rename', 'compare'])
const LIFT_TOOLS = new Set(['move', 'merge', 'graft'])
const SCISSORS_CURSOR = svgCursor("<circle cx='6' cy='6' r='3'/><circle cx='6' cy='18' r='3'/><path d='M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12'/>", '%23edc263', '12 12')
const RENAME_CURSOR = svgCursor("<path d='M4 20h4L19 9l-4-4L4 16v4z'/><path d='M13.5 6.5l4 4'/>", '%2360a5fa', '4 20')
// Compare: picking the first subtree, then the second — the cursor carries which.
const compareCursor = step => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'>`
    + `<path d='M2 4v16M2 8h5M2 16h5M26 4v16M26 8h-5M26 16h-5' fill='none' stroke='%23101826' stroke-width='4' stroke-linecap='round'/>`
    + `<path d='M2 4v16M2 8h5M2 16h5M26 4v16M26 8h-5M26 16h-5' fill='none' stroke='%2360a5fa' stroke-width='2' stroke-linecap='round'/>`
    + `<circle cx='14' cy='12' r='7' fill='%2360a5fa' stroke='%23101826' stroke-width='1.5'/>`
    + `<text x='14' y='16' text-anchor='middle' font-family='sans-serif' font-size='11' font-weight='700' fill='%23101826'>${step}</text></svg>`
  return `url("data:image/svg+xml;utf8,${svg}") 14 12, pointer`
}
const COMPARE_CURSORS = { 1: compareCursor(1), 2: compareCursor(2) }
// The horizontal scale for row scale k: held at `kxFixed` while two subtrees face each other,
// otherwise k, but never below `kxFloor`.
const scaleAcross = (limits, k) => limits.kxFixed ?? Math.max(k, limits.kxFloor)
const REMOVE_CURSOR = svgCursor("<circle cx='12' cy='12' r='8'/><path d='M8.5 8.5l7 7M15.5 8.5l-7 7'/>", '%23fb7185', '12 12')

/**
 * The tree's drawing surface. It owns the pan/zoom transform (kept in a ref and
 * painted on the next frame, so a gesture never waits on React) and turns pointer
 * input into node events for the view to act on. Wheel and trackpad gestures go
 * through the shared browsing-control scheme, so the tree answers to the same
 * settings as the Genome Browser; since this surface is not a page, the scheme's
 * "scroll the page" is read as moving up and down the tree.
 */
/**
 * A subtree's name tag as a text box, for the Rename tool, with Apply and Cancel beside it.
 * Apply, Enter or leaving it keeps the name (an empty one goes back to the automatic name);
 * Cancel or Escape keeps the old one.
 */
function TagNameInput({ boxRef, initial, placeholder, color, onDone }) {
  const [draft, setDraft] = useState(initial)
  const done = useRef(false)
  const finish = save => {
    if (done.current) return
    done.current = true
    onDone(save ? draft.trim() : null)
  }
  // The buttons take the press without taking focus, so the box is not left (and the name
  // kept) before Cancel has had its say.
  const button = save => ({ type: 'button', onPointerDown: event => { event.preventDefault(); event.stopPropagation() },
    onMouseDown: event => event.preventDefault(), onClick: () => finish(save) })
  return (
    <span ref={boxRef} className="gt-tag-edit" onPointerDown={event => event.stopPropagation()}>
      <input className="gt-tag-input" autoFocus value={draft} placeholder={placeholder} aria-label="Subtree name"
        size={Math.max(8, (draft || placeholder).length + 1)} style={{ background: color, color: readableOn(color) }}
        onChange={event => setDraft(event.target.value)} onBlur={() => finish(true)}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') finish(true)
          else if (event.key === 'Escape') finish(false)
        }} />
      <button {...button(true)} className="gt-tag-act apply" title="Apply the name (Enter)" aria-label="Apply the name">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </button>
      <button {...button(false)} className="gt-tag-act" title="Cancel (Esc)" aria-label="Cancel">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </span>
  )
}

const TreeCanvas = forwardRef(function TreeCanvas({
  index, layout, links, focusId, focusIds = null, focusPath, selected, palette, topbarAssemblies, genomeColors, lit = null, controls, fitKey, focusRowId,
  onNodeClick, onHover, onColumnClick, ariaLabel,
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
  // A data column beside the leaves: `{paint, leaderEnd, hit}` (see `neighbourhoodColumn` in
  // paintTree.js), and optionally `wheel(env, event)` / `press(env, sx, sy)` for gestures of
  // its own. `columnKey` changes whenever what it draws does.
  column = null, columnKey = '',
  // The Rename tool's text box: `{fragmentId, initial, placeholder, color}` while a subtree's
  // name is being typed, laid over its tag; `onNamed(fragmentId, name)` ends it (name null:
  // cancelled).
  naming = null, onNamed,
  // Two subtrees being compared (compareTrees.js): the lines between them and what is in
  // conflict, for the painter, and `partnersOf(id)` → the ids to light while one is hovered.
  // `comparePick`: picking them, which one is next (1 or 2).
  compare = null, comparePick = 0,
}, ref) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const size = useRef({ width: 0, height: 0 })
  const t = useRef({ k: 1, x: PAD, y: PAD })
  const limits = useRef({ min: 0.05, kxFloor: 1 })
  // A transform for row scale k: the horizontal scale follows it down only as far as
  // fitting the tree's width, then holds.
  const withScale = (k, x, y) => ({ k, kx: scaleAcross(limits.current, k), x, y })
  const labelCache = useRef(new Map())
  const frame = useRef(0)
  const drag = useRef(null)
  const gesture = useRef(null)
  // Which way a wheel gesture goes (wheelAxis.js): a swipe that wanders a little off its
  // line still only pans sideways, or only zooms.
  const wheelAxis = useRef(newWheelAxis())
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
    props.current = { index, layout, links, focusId, focusIds, focusPath, selected, palette, topbarAssemblies, genomeColors, lit,
      picked, fragmentTags, tool, marks, cameras, canMerge, insetTop, column, naming, compare, comparePick }
  })
  const namingInput = useRef(null)
  // Keep the Rename tool's text box on its tag wherever the view has moved to.
  const placeNaming = () => {
    const input = namingInput.current
    const { layout: lay, naming: now } = props.current
    if (!input || !now) return
    const item = lay?.items?.find(i => i.node.fragRoot === now.fragmentId)
    if (!item) { input.style.visibility = 'hidden'; return }
    const { x, y } = fragmentTagBox(lay, t.current, item)
    input.style.visibility = ''
    // A mirrored subtree's tag ends at its root, on its right.
    input.style.transform = item.mirror
      ? `translate(${Math.round(x + 8)}px, ${Math.round(y)}px) translateX(-100%)`
      : `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  // A subtree layer's tools: the fragment being dragged (`lift`: its root, node ids, how
  // far it has moved on screen and what it is over), and the highlight of what a tool is
  // about to act on (`fx`, the painter's `emphasis`).
  const lift = useRef(null)
  const liftCanvas = useRef(null)
  const fx = useRef(null)
  const fxKey = useRef('')
  const columnHover = useRef('') // what the data column lights for the pointer (a gene family, say)

  // A tool's highlight is kept as what it is about (a subtree's box, a branch's junction) and
  // placed on screen at each paint, so it stays on its subtree while the view pans or zooms.
  const placeFx = current => (current && (typeof current.box === 'function' || typeof current.junction === 'function')
    ? { ...current, box: typeof current.box === 'function' ? current.box() : current.box,
      junction: typeof current.junction === 'function' ? current.junction() : current.junction }
    : current)

  const paint = useCallback(() => {
    frame.current = 0
    const node = canvas.current
    if (!node) return
    const ctx = node.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    placeNaming()
    const base = { ...props.current, t: t.current, width: size.current.width, height: size.current.height,
      hoverId: hover.current, labelCache: labelCache.current, planOut: plan, marquee: marquee.current, emphasis: placeFx(fx.current),
      columnHover: columnHover.current,
      compare: props.current.compare && { ...props.current.compare, lit: hover.current >= 0 ? props.current.compare.partnersOf(hover.current) : null } }
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
      if (held.snap) {
        // The column the two subtrees' tips now share, down both of them.
        const [gx, gy0] = toScreen(t.current, held.snap.column, held.snap.top)
        const gy1 = toScreen(t.current, held.snap.column, held.snap.bottom)[1]
        ctx.save()
        ctx.strokeStyle = props.current.palette?.isLight ? '#0099ff' : '#60a5fa'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.beginPath(); ctx.moveTo(gx, gy0 - 14); ctx.lineTo(gx, gy1 + 14); ctx.stroke()
        ctx.restore()
      }
      return
    }
    paintTree(ctx, base)
    // A data column that wants the plane moved (to keep its place across a switch).
    const pan = props.current.column?.takePan?.() || 0
    if (pan) {
      t.current = { ...t.current, x: t.current.x + pan }
      if (!frame.current) frame.current = requestAnimationFrame(paint)
    }
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
    // Two subtrees facing each other: the room between them was laid out for labels at one
    // horizontal scale (labels never shrink), and the pair fills the view's width at it, so
    // across it stays at that scale; zooming changes only the rows.
    limits.current.kxFixed = props.current.compare?.facing && !lay.radial ? props.current.compare.scaleX || 1 : null
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
    // Facing subtrees keep their own horizontal scale: rows fit the height alone.
    const fixed = limits.current.kxFixed
    const k = clamp(fixed ? Math.min(2, Math.max(room / bh, readable)) : Math.min(2, fitWidth, Math.max(fitAll, readable)), 1e-4, MAX_ZOOM)
    const kx = scaleAcross(limits.current, k)
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
    const kx = scaleAcross(limits.current, k)
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
    const kx = scaleAcross(limits.current, k)
    // The label sits past any aligned column, which starts at the furthest tip, not this one.
    const column = alignXOf(lay, item)
    const aligned = column !== undefined ? Math.abs(column - item.x) * kx : 0
    const label = aligned + LABEL_GAP + labelOffsetOf(lay, item) + (labelCache.current.get(id)?.width ?? 220) + 40
    const sx = sideOf(lay, item).flipHorizontal ? Math.max(width * 0.45, label) : Math.min(width * 0.55, width - label)
    animateTo({ k, x: sx - item.x * kx, y: midY - item.y * k })
    return true
  }, [animateTo, updateLimits])

  // Keep a node clear of whatever floats over the top `top` px of the view: glide it down
  // just far enough when it is under there, and leave the view alone when it is not.
  const reveal = useCallback((id, top) => {
    const item = props.current.layout?.byId?.get(id)
    if (!item) return
    const sy = toScreen(t.current, item.x, item.y)[1]
    const clear = top + Math.max(12, (props.current.layout.pitch * t.current.k) / 2 + 6)
    if (sy >= clear) return
    animateTo({ ...t.current, y: t.current.y + clear - sy })
  }, [animateTo])

  useImperativeHandle(ref, () => ({ fit, centreOn, recentre, reveal, zoomInto, canvas: () => canvas.current, repaint: schedule }), [fit, centreOn, recentre, reveal, zoomInto, schedule])

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
    t.current = { ...t.current, kx: scaleAcross(limits.current, t.current.k) }
    const held = anchor.current
    anchor.current = null
    if (held && layout?.byId?.has(held.id)) {
      const item = layout.byId.get(held.id)
      const [sx, sy] = toScreen(t.current, item.x, item.y)
      t.current = { ...t.current, x: t.current.x + held.sx - sx, y: t.current.y + held.sy - sy }
    }
    schedule()
  }, [layout, fitKey, focusRowId, fit, schedule, updateLimits, viewKey, layoutSig, cameras, saveCamera])

  useEffect(() => { schedule() }, [links, focusId, focusIds, focusPath, selected, palette, topbarAssemblies, genomeColors, lit, picked,
    fragmentTags, marks, column, columnKey, compare, schedule])
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

  // What a data column's gestures need: where the tree is and what the painter last planned.
  const columnEnv = useCallback(() => ({ layout: props.current.layout, t: t.current, plan: plan.current,
    width: size.current.width, height: size.current.height, insetTop: props.current.insetTop || 0 }), [])

  // Wheel: non-passive, so it can stop the page (and Chromium's page zoom) from reacting.
  useEffect(() => {
    const element = canvas.current
    if (!element) return undefined
    const onWheel = event => {
      const wheel = lockWheelAxis(wheelAxis.current, readWheelEvent(event))
      // Held back while the lock turns to a new gesture: still ours, so the page (or a
      // sideways swipe's back-navigation) never sees it.
      if (!wheel.dx && !wheel.dy) { event.preventDefault(); return }
      gesture.current = beginWheelGesture(gesture.current, wheel, wheel.ts)
      const intent = resolveWheelAction(wheel, controls, {
        // Never "at max zoom": the scheme would hand an outward zoom over to page scrolling,
        // which here means panning, and the tree would slide away once fully zoomed out.
        atMaxZoom: false, canScrollPage: true, gesture: gesture.current,
      })
      gesture.current.mode = intent.nextGestureMode || gesture.current.mode
      const [sx, sy] = point(event)
      // Inside a data column with a view of its own (an alignment's), the same gesture acts
      // on that: the scheme's zoom zooms along the alignment, a sideways pan moves along it.
      const own = props.current.column
      const taken = own?.wheel && intent.type !== 'none' ? own.wheel(columnEnv(), intent, wheel, sx, sy) : null
      if (taken) {
        event.preventDefault()
        markAdjusting()
        if (taken.panX) panBy(taken.panX, 0)
        else schedule()
        return
      }
      if (intent.type === 'none') { if (intent.preventDefault) event.preventDefault(); return }
      event.preventDefault()
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
  }, [controls, panBy, zoomAt, columnEnv, schedule, markAdjusting])

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
  // A fragment's box, as a highlight to place at paint time (see `placeFx`); none once the
  // fragment is gone from the layout.
  const boxFx = (rootId, color, dash = null) => () => {
    const lay = props.current.layout
    return lay?.byId?.has(rootId) ? { ...fragmentBox(lay, rootId), color, dash } : null
  }
  const fragmentBox = (lay, rootId) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of subtreeOf(lay, rootId)) {
      const item = lay.byId.get(id)
      const [sx, sy] = screenOf(item)
      const label = item.kind !== 'internal' ? LABEL_GAP + labelOffsetOf(lay, item) + (labelCache.current.get(id)?.width ?? 0) : 0
      const flip = sideOf(lay, item).flipHorizontal
      x0 = Math.min(x0, flip ? sx - label : sx); x1 = Math.max(x1, flip ? sx : sx + label)
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
  // Where every fragment is now (root x, top row) and how big it is drawn (see
  // placeFragments), so an edit can pin them all: arranging one fragment should never send
  // the others elsewhere.
  const sizeOf = (lay, fragmentId) => {
    const box = lay.fragmentBoxes?.get(fragmentId)
    return box ? { w: box.w, h: box.h } : {}
  }
  const places = lay => {
    const out = {}
    for (const rootId of childMap(lay).get(lay.items[0].id) || []) {
      let top = Infinity
      for (const id of subtreeOf(lay, rootId)) top = Math.min(top, lay.byId.get(id).y)
      const fragmentId = lay.byId.get(rootId).node.fragRoot
      out[fragmentId] = { x: lay.byId.get(rootId).x, y: top, ...sizeOf(lay, fragmentId) }
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
        return setFx({ box: boxFx(rootId, colour, verdict.ok ? null : [5, 4]),
          edges: [{ ids: subtreeOf(lay, rootId), color: colour, width: 2.5 }] }, `m${rootId}${verdict.ok}`)
      }
    } else if (p.tool === 'graft') {
      const id = layerNodeAt(sx, sy, skip)
      if (id >= 0) {
        const root = fragmentRootOf(lay, id) === id
        // Onto a root: the graft makes a new root, just outside the old one.
        held.target = { nodeId: id, root }
        const junction = () => {
          const now = props.current.layout
          if (!now?.byId?.has(id)) return null
          const [ix, iy] = screenOf(now.byId.get(id))
          const at = root ? [ix + (sideOf(now, now.byId.get(id)).flipHorizontal ? 18 : -18), iy] : branchMid(now, t.current, id)
          return at ? { at, color: gold } : null
        }
        return setFx({ edges: root ? [] : [{ ids: new Set([id]), color: gold, width: 4.5 }], rings: root ? [{ id, color: gold }] : [],
          junction }, `g${id}`)
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
      setFx({ box: boxFx(rootId, p.palette.muted, [4, 4]) }, `h${rootId}`)
      return 'grab'
    }
    if (tool === 'rename' || tool === 'compare') {
      const rootId = layerFragmentAt(sx, sy)
      if (rootId < 0) { setFx(null, ''); return tool === 'compare' ? COMPARE_CURSORS[p.comparePick || 1] : null }
      setFx({ box: boxFx(rootId, tool === 'compare' ? p.palette.edgeFocus : p.palette.muted, [4, 4]) }, `n${rootId}`)
      return tool === 'compare' ? COMPARE_CURSORS[p.comparePick || 1] : RENAME_CURSOR
    }
    if (tool === 'cut') {
      const id = layerNodeAt(sx, sy)
      if (id < 0 || fragmentRootOf(lay, id) === id) { setFx(null, ''); return null }
      setFx({ edges: [{ ids: new Set([id]), color: '#edc263', width: 4.5, dash: [5, 4] }],
        junction: () => (props.current.layout?.byId?.has(id) ? { at: branchMid(props.current.layout, t.current, id), color: '#edc263' } : null) }, `c${id}`)
      return SCISSORS_CURSOR
    }
    if (tool === 'remove') {
      const id = layerNodeAt(sx, sy)
      if (id < 0) { setFx(null, ''); return null }
      const root = fragmentRootOf(lay, id)
      const red = p.palette.focus
      setFx({ edges: [{ ids: subtreeOf(lay, id), color: red, width: 3 }], rings: [{ id, color: red }],
        box: id === root ? boxFx(root, red, [5, 4]) : null }, `r${id}`)
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
    const columnDrag = props.current.column?.press?.(columnEnv(), sx, sy)
    if (columnDrag) {
      drag.current = { kind: 'column', handler: columnDrag, startX: sx, startY: sy, lastX: sx, lastY: sy, moved: true, id: event.pointerId }
      canvas.current.setPointerCapture?.(event.pointerId)
      schedule()
      return
    }
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
    if (current?.kind === 'column') {
      // Along the column moves the alignment; up and down still moves the tree.
      const out = current.handler.move?.(sx, sy)
      if (out?.dy) panBy(0, out.dy)
      else schedule()
      onHover?.(null)
      return
    }
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
          // Moving with aligned leaves, it snaps level with a nearby subtree's tips (⌥: freely).
          const lay = props.current.layout
          lift.current.snap = props.current.tool === 'move' && !event.altKey
            ? alignSnap(lay, t.current, lay.byId.get(lift.current.rootId)?.lane, lift.current.dx, lift.current.dy) : null
          if (lift.current.snap) lift.current.dx = lift.current.snap.dx
          liftTarget(sx, sy)
          onLayerDrag?.({ phase: 'move', clientX: event.clientX, clientY: event.clientY, tool: props.current.tool,
            fragmentId: lift.current.fragmentId, target: lift.current.target, snapped: Boolean(lift.current.snap) })
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
    // Over something in the data column: its card, and whatever the column lights for it
    // (every copy of a gene down the Neighbourhood column, say).
    const columnHit = hit ? null : props.current.column?.hit?.(props.current.layout, t.current, sx, sy, plan.current) || null
    const lit = columnHit?.hoverKey ?? ''
    if (lit !== columnHover.current) { columnHover.current = lit; schedule() }
    if (columnHit) hit = { ...columnHit, fromColumn: true }
    const id = hit && !hit.fromColumn ? hit.item.id : -1
    const tool = props.current.tool
    const layerCursor = LAYER_TOOLS.has(tool) ? layerHover(sx, sy) : null
    canvas.current.style.cursor = pickedAt(sx, sy, hit) >= 0 ? 'grab'
      : layerCursor || (tool === 'select' ? 'crosshair'
        // Flip only acts on a node with branches to reverse.
        : tool === 'flip' ? (hit?.item.kind === 'internal' || fragmentTagAt(props.current.fragmentTags, sx, sy) ? 'pointer' : 'grab')
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
    if (current.kind === 'column') {
      current.handler.end?.(sx, sy)
      schedule()
      return
    }
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
          pos: { x: root.x + (held.snap ? held.snap.worldDx : held.dx / (t.current.kx ?? t.current.k)), y: top + held.dy / t.current.k, ...sizeOf(lay, held.fragmentId) } })
      } else if (tool === 'merge' && held.target) {
        onLayerAction?.({ type: 'merge', places: places(lay), fragmentId: held.fragmentId, into: held.target.fragmentId, ok: held.target.ok, why: held.target.why })
      } else if (tool === 'graft' && held.target) {
        onLayerAction?.({ type: 'graft', places: places(lay), fragmentId: held.fragmentId, nodeId: held.target.nodeId, root: held.target.root })
      }
      return
    }
    if (!current.moved && (props.current.tool === 'rename' || props.current.tool === 'compare') && props.current.layout?.forest) {
      const rootId = layerFragmentAt(sx, sy)
      if (rootId < 0) return
      setFx(null, '')
      onLayerAction?.({ type: props.current.tool === 'rename' ? 'rename' : 'compare-pick', fragmentId: props.current.layout.byId.get(rootId).node.fragRoot })
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
        const clear = sideOf(lay, lay.byId.get(rootId)).flipHorizontal ? (box.x0 - 40 - t.current.x) / kx : (box.x1 + 40 - t.current.x) / kx
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
      if (tagged) { onToolClick?.({ kind: 'fragment', fragmentId: tagged }, mods); return }
      // A click on the data column: what is there (the alignment's card shows only for one).
      const columnHit = props.current.column?.hit?.(props.current.layout, t.current, sx, sy, plan.current)
      if (columnHit) onColumnClick?.({ ...columnHit, fromColumn: true }, event.clientX, event.clientY)
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
    if (columnHover.current !== '') { columnHover.current = ''; schedule() }
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
      {naming ? (
        <TagNameInput key={naming.fragmentId} boxRef={node => { namingInput.current = node; if (node) placeNaming() }}
          initial={naming.initial} placeholder={naming.placeholder} color={naming.color}
          onDone={name => onNamed?.(naming.fragmentId, name)} />
      ) : null}
    </div>
  )
})

export default TreeCanvas
