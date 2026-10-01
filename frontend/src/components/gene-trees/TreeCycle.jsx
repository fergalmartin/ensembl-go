import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cycleRailGeometry, cycleRailPosition, cyclePointerDragged, detentPosition } from '../../utils/genomeWheel'
import '../GenomeWheel.css'

const PREVIEW = { width: 1100, height: 280 }
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

/** One face of the drum: the layer's tree, drawn by the view (`paint(ctx, id, w, h)`). */
function TreePreview({ entry, paint }) {
  const canvas = useRef(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (ctx) paint(ctx, entry.id, PREVIEW.width, PREVIEW.height)
  }, [entry, paint])
  return (
    <div className="genome-wheel-preview">
      <canvas ref={canvas} width={PREVIEW.width} height={PREVIEW.height} aria-label={`Tree preview: ${entry.name}`} />
    </div>
  )
}

/**
 * Cycle through the layers: the Alignment Explorer's LayerCycle, for trees. The same
 * oblique rotating drum and the same press–drag–release: drag down the rail to preview
 * each layer and let go to choose; a press that does not travel leaves the wheel open,
 * following the cursor, until a click confirms. The Original is the first face.
 */
export default function TreeCycle({ entries, active, onChoose, paint, isLight }) {
  const [session, setSession] = useState(null)
  const sessionRef = useRef(null)
  const update = value => { sessionRef.current = value; setSession(value) }
  const close = () => update(null)
  const choose = () => {
    const s = sessionRef.current
    if (s) { onChoose(entries[Math.round(s.position)].id); close() }
  }
  const move = y => {
    const s = sessionRef.current
    if (s) update({ ...s, position: cycleRailPosition(y, s.rail, entries.length) })
  }
  const open = event => {
    if (entries.length < 2) return
    const rail = cycleRailGeometry(entries.length, event.currentTarget.getBoundingClientRect(), window.innerHeight)
    event.currentTarget.setPointerCapture(event.pointerId)
    update({ position: Math.max(0, entries.findIndex(e => e.id === active)), rail, pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY }, dragged: false, sticky: false })
  }
  useEffect(() => {
    if (!session) return undefined
    const moved = event => {
      const s = sessionRef.current
      if (!s) return
      if (!s.sticky && event.pointerId !== s.pointerId) return
      if (!s.sticky && !s.dragged && cyclePointerDragged(s.origin, event.clientX, event.clientY)) s.dragged = true
      move(event.clientY)
    }
    const up = event => {
      const s = sessionRef.current
      if (!s || s.sticky || event.pointerId !== s.pointerId) return
      if (s.dragged) { choose(); return }
      update({ ...s, sticky: true })
    }
    const click = event => {
      const s = sessionRef.current
      if (!s || !s.sticky) return
      event.preventDefault()
      event.stopPropagation()
      if (event.button === 0) choose()
      else close()
    }
    const key = event => {
      const s = sessionRef.current
      if (!s) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        update({ ...s, position: event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
          : clamp(Math.round(s.position) + (event.key === 'ArrowUp' ? -1 : 1), 0, entries.length - 1) })
      }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose() }
    }
    window.addEventListener('pointermove', moved)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointerdown', click, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', moved)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointerdown', click, true)
      window.removeEventListener('keydown', key)
    }
  }, [Boolean(session), entries, onChoose]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = entries.find(e => e.id === active)
  const selected = session ? Math.round(session.position) : 0
  const step = entries.length > 1 ? 360 / entries.length : 360
  const radius = entries.length > 2 ? 322 / (2 * Math.tan(Math.PI / entries.length)) : 0
  return (
    <>
      <button type="button" className={`gt-cycle${session ? ' menu-open' : ''}`} disabled={entries.length < 2} aria-expanded={Boolean(session)}
        aria-label={`Cycle layers: ${current?.name || 'Original'}`}
        title={`Layer: ${current?.name || 'Original'}. Drag to preview the layers and release to choose, or click once to leave the wheel following the cursor.`}
        onPointerDown={open}>
        <span className="gt-cycle-mark" aria-hidden="true">◈</span>Cycle
      </button>
      {session ? createPortal(
        <div className={`genome-wheel-overlay gt-wheel${isLight ? ' light' : ''}${session.sticky ? ' sticky' : ''}`}
          onWheel={event => { const s = sessionRef.current; update({ ...s, position: clamp(s.position + event.deltaY / 160, 0, entries.length - 1) }) }}>
          <div className="genome-wheel-scene">
            <div className="genome-wheel-drum" style={{ '--face-height': '322px', '--radius': `${radius}px`, '--face-step': `${step}deg`, '--wheel-position': detentPosition(session.position) }}>
              {entries.map((entry, i) => (
                <div key={entry.id} className="genome-wheel-face" style={{ '--face-index': i }}>
                  {Math.min(Math.abs(i - selected), entries.length - Math.abs(i - selected)) <= 1
                    ? <TreePreview entry={entry} paint={paint} />
                    : <div className="genome-wheel-preview">{entry.name}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="genome-wheel-rail" role="slider" tabIndex={0} aria-label="Layer preview" aria-valuemin={1}
            aria-valuemax={entries.length} aria-valuenow={selected + 1} aria-valuetext={entries[selected].name}
            style={{ left: session.rail.center - 26, top: session.rail.top, height: session.rail.height }}>
            <div className="genome-wheel-line" style={{ top: session.rail.padding, bottom: session.rail.padding }} />
            {entries.map((entry, i) => <i key={entry.id} className="genome-wheel-dot" style={{ top: session.rail.padding + i * session.rail.spacing, '--dot': entry.color }} title={entry.name} />)}
            {/* As the genome browser's: the ring sits on the layer that would be chosen, jumping dot to dot. */}
            <span className="genome-wheel-indicator" style={{ top: session.rail.padding + selected * session.rail.spacing }} />
          </div>
          <button type="button" className="genome-cycle-cancel" style={{ left: session.rail.center, top: session.rail.cancelTop, height: session.rail.cancelHeight }}
            onPointerDown={event => { event.stopPropagation(); close() }}>Cancel</button>
          <div className="genome-wheel-status">
            <strong>{entries[selected].name}</strong>
            <span>{session.sticky ? 'Move to choose · click to confirm · Esc to cancel' : 'Release to choose'}</span>
          </div>
        </div>, document.body) : null}
    </>
  )
}
