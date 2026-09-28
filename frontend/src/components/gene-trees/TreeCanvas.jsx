import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import {
  DRAG_AXIS_THRESHOLD_PX, beginWheelGesture, clamp, isTextEntryTarget, readKeyEvent, readWheelEvent,
  resolveKeyAction, resolveWheelAction,
} from '../../utils/browsingControls.js'
import { contentBounds, hitTest, paintTree, toScreen } from './paintTree.js'

const MAX_ZOOM = 4
const PAD = 28

/**
 * The tree's drawing surface. It owns the pan/zoom transform (kept in a ref and
 * painted on the next frame, so a gesture never waits on React) and turns pointer
 * input into node events for the view to act on. Wheel and trackpad gestures go
 * through the shared browsing-control scheme, so the tree answers to the same
 * settings as the Genome Browser; since this surface is not a page, the scheme's
 * "scroll the page" is read as moving up and down the tree.
 */
const TreeCanvas = forwardRef(function TreeCanvas({
  index, layout, links, focusId, focusPath, selected, palette, topbarAssemblies, genomeColors, controls, fitKey, focusRowId,
  onNodeClick, onNodeDoubleClick, onNodeContextMenu, onHover, ariaLabel,
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
  const adjusting = useRef(false)
  const settleTimer = useRef(0)
  const onHoverRef = useRef(onHover)
  useLayoutEffect(() => { onHoverRef.current = onHover })
  // Mirrored for the painter and the gesture handlers, which run outside render.
  // Declared first so every later layout effect sees this render's values.
  useLayoutEffect(() => {
    props.current = { index, layout, links, focusId, focusPath, selected, palette, topbarAssemblies, genomeColors }
  })

  const paint = useCallback(() => {
    frame.current = 0
    const node = canvas.current
    if (!node) return
    const ctx = node.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const p = props.current
    paintTree(ctx, { ...p, t: t.current, width: size.current.width, height: size.current.height,
      hoverId: hover.current, labelCache: labelCache.current, planOut: plan })
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
    const fitWidth = (width - PAD * 2) / bw
    const fitAll = Math.min(fitWidth, (height - PAD * 2) / bh)
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
    if (bh * k <= height - PAD * 2) y = PAD - b.minY * k + (height - PAD * 2 - bh * k) / 2
    else {
      const item = centreId >= 0 ? lay.byId.get(centreId) : null
      y = item ? height / 2 - item.y * k : PAD - b.minY * k
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

  useImperativeHandle(ref, () => ({ fit, centreOn, zoomInto, canvas: () => canvas.current }), [fit, centreOn, zoomInto])

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
  const lastFit = useRef(null)
  useLayoutEffect(() => {
    labelCache.current = new Map()
    if (fitKey !== lastFit.current) {
      lastFit.current = fitKey
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
  }, [layout, fitKey, focusRowId, fit, schedule, updateLimits])

  useEffect(() => { schedule() }, [links, focusId, focusPath, selected, palette, topbarAssemblies, genomeColors, schedule])
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

  const onPointerDown = event => {
    cancelAnimationFrame(animation.current)
    if (event.button !== 0) return
    canvas.current.focus({ preventScroll: true })
    const [sx, sy] = point(event)
    drag.current = { startX: sx, startY: sy, lastX: sx, lastY: sy, moved: false, id: event.pointerId }
    canvas.current.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = event => {
    const [sx, sy] = point(event)
    pointer.current = { sx, sy, clientX: event.clientX, clientY: event.clientY }
    const current = drag.current
    if (current) {
      if (!current.moved && Math.hypot(sx - current.startX, sy - current.startY) > DRAG_AXIS_THRESHOLD_PX) {
        current.moved = true
        onHover?.(null)
        hover.current = -1
      }
      if (current.moved) {
        panBy(sx - current.lastX, sy - current.lastY)
        current.lastX = sx
        current.lastY = sy
        canvas.current.style.cursor = 'grabbing'
        return
      }
    }
    // Mid-zoom (a trackpad fling, say) the pointer is only noted; the settle picks it up.
    if (adjusting.current) return
    const hit = hitTest(props.current.layout, t.current, sx, sy, labelCache.current, plan.current)
    const id = hit ? hit.item.id : -1
    canvas.current.style.cursor = hit ? 'pointer' : 'grab'
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
    canvas.current.style.cursor = 'grab'
    if (!current || current.moved) return
    const [sx, sy] = point(event)
    const hit = hitTest(props.current.layout, t.current, sx, sy, labelCache.current, plan.current)
    if (!hit) return
    if (hit.part === 'folded' && !event.altKey && !event.shiftKey) {
      hover.current = -1
      onHover?.(null)
      zoomInto(hit.item)
      return
    }
    holdNode(hit.item)
    onNodeClick?.(hit.item, { alt: event.altKey, shift: event.shiftKey, meta: event.metaKey || event.ctrlKey, part: hit.part })
  }
  const onDoubleClick = event => {
    const [sx, sy] = point(event)
    const hit = hitTest(props.current.layout, t.current, sx, sy, labelCache.current, plan.current)
    if (!hit) { fit(props.current.focusId ?? -1); return }
    if (hit.part === 'folded') return
    holdNode(hit.item)
    onNodeDoubleClick?.(hit.item)
  }
  const onContextMenu = event => {
    event.preventDefault()
    const [sx, sy] = point(event)
    const hit = hitTest(props.current.layout, t.current, sx, sy, labelCache.current, plan.current)
    if (hit) holdNode(hit.item)
    onNodeContextMenu?.(hit?.item || null, event.clientX, event.clientY)
  }
  const onPointerLeave = () => {
    pointer.current = null
    if (hover.current !== -1) { hover.current = -1; schedule() }
    onHover?.(null)
  }
  const onKeyDown = event => {
    if (isTextEntryTarget(event.target)) return
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
        onPointerCancel={() => { drag.current = null }}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
    </div>
  )
})

export default TreeCanvas
