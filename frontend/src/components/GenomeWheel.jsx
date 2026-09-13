import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getGenomeKey } from '../utils/genomeIdentity'
import { genomeColorResolver, INACTIVE_GENOME_COLOR } from '../genomeColorSchemes'
import { clampWheelPosition, detentPosition, defaultCycleAction, cycleRailGeometry, cyclePointerIntent, cycleGenomeDetails, cyclePointerDragged, cycleActionLabel, cycleActionProgress, CYCLE_ACTION_OFFSET } from '../utils/genomeWheel'
import GenomeCyclePreview from './GenomeCyclePreview'
import { genomePillLabels } from './GenomePill'
import './GenomeWheel.css'

function capturePanel(root, key) {
  const source = [...(root?.querySelectorAll('[data-browser-canvas-surface]') || [])]
    .find(element => element.dataset.focusPanelKey === key)?.querySelector('canvas')
  if (!source?.width || !source?.height) return null
  const copy = document.createElement('canvas')
  copy.width = Math.min(1200, source.width)
  copy.height = Math.min(420, Math.round(source.height * copy.width / source.width))
  copy.getContext('2d').drawImage(source, 0, 0, source.width, copy.height * source.width / copy.width, 0, 0, copy.width, copy.height)
  return copy
}

export default function GenomeWheel({ species, activeSpecies, config, panelRootRef, onPromote, isActive, isLight }) {
  const promoteRef = useRef(onPromote)
  useEffect(() => { promoteRef.current = onPromote }, [onPromote])
  const button = useRef(null)
  const sessionRef = useRef(null)
  const [session, setSession] = useState(null)
  const [candidate, setCandidate] = useState(0)
  const [phase, setPhase] = useState('closed')
  const [action, setAction] = useState(null)
  // Set once a press has been released without travelling: the wheel stays open
  // and tracks the bare cursor until a second click confirms.
  const [sticky, setSticky] = useState(false)
  const stage = useRef(null)
  const finishRef = useRef(null)
  const activeKeys = new Set(activeSpecies.map(getGenomeKey))
  const enabled = species.some(item => item.files?.gff3)

  function start(event, keyboard = false) {
    if (!enabled || !isActive || sessionRef.current) return
    event.preventDefault()
    const resolveColor = genomeColorResolver(config)
    const entries = species.filter(item => item.files?.gff3).map(item => {
      const key = getGenomeKey(item)
      return { key, species: item, details: cycleGenomeDetails(item), badge: genomePillLabels(item), label: item.display_name || item.common_name || item.scientific_name || key,
        assembly: item.assembly_name || item.assembly || '', active: activeKeys.has(key) && Boolean(item.files?.gff3),
        color: activeKeys.has(key) ? resolveColor(item) : INACTIVE_GENOME_COLOR,
        preview: activeKeys.has(key) ? capturePanel(panelRootRef.current, key) : null }
    })
    if (!entries.length) return
    const initial = Math.max(0, entries.findIndex(entry => entry.key === getGenomeKey(activeSpecies[0])))
    const bounds = panelRootRef.current.getBoundingClientRect()
    const buttonBounds = button.current.getBoundingClientRect()
    const top = Math.max(0, Math.min(bounds.top, buttonBounds.bottom + 4))
    const rail = cycleRailGeometry(entries.length, buttonBounds, window.innerHeight)
    const defaultAction = defaultCycleAction(activeSpecies.length)
    const next = { entries, initial, raw: initial, position: initial, target: initial, keyboard,
      pointerId: event.pointerId, top, height: window.innerHeight - top, rail, defaultAction,
      action: keyboard ? defaultAction : null, signature: species.map(getGenomeKey).join('|'),
      activeSignature: activeSpecies.map(getGenomeKey).join('|'), finishing: false,
      origin: keyboard ? null : { x: event.clientX, y: event.clientY }, dragged: false, sticky: false }
    sessionRef.current = next
    setCandidate(initial)
    setAction(next.action)
    setSticky(false)
    setPhase('open')
    setSession(next)
    button.current.focus({ preventScroll: true })
    if (!keyboard) button.current.setPointerCapture(event.pointerId)
  }

  useEffect(() => {
    if (!session) return
    let frame, timer, disposed = false
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let previousTime = performance.now()
    function tick(now) {
      const fraction = 1 - Math.exp(-Math.min(64, now - previousTime) / 45)
      previousTime = now
      session.position += (session.target - session.position) * fraction
      stage.current?.style.setProperty('--wheel-position', String(session.position))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    function close() {
      if (disposed) return
      sessionRef.current = null
      setSession(null)
      setSticky(false)
      setPhase('closed')
      button.current?.focus({ preventScroll: true })
    }
    function finish(cancel = false) {
      if (session.finishing && (!cancel || session.committing)) return
      clearTimeout(timer)
      session.finishing = true
      cancel = cancel || !session.action
      const selected = cancel ? session.initial : Math.round(clampWheelPosition(session.target, session.entries.length))
      session.target = selected
      setCandidate(selected)
      setPhase(cancel ? 'cancelling' : 'settling')
      timer = setTimeout(async () => {
        try {
          if (!cancel) {
            session.committing = true
            await promoteRef.current(session.entries[selected].key, session.action, session.entries[selected].species)
          }
          if (disposed) return
          setPhase('leaving')
          timer = setTimeout(close, reduced ? 0 : 180)
        } catch {
          if (!disposed) { session.target = session.initial; setPhase('error'); timer = setTimeout(close, 1600) }
        }
      }, reduced ? 0 : 220)
    }
    finishRef.current = finish
    function choose(position, nextAction = session.action) {
      session.raw = clampWheelPosition(position, session.entries.length)
      session.target = detentPosition(session.raw)
      session.action = nextAction
      setCandidate(Math.round(session.raw))
      setAction(nextAction)
    }
    function move(event) {
      if (session.keyboard || session.finishing) return
      // Once the button has been let go the wheel follows whatever is moving, so
      // the pointer that opened it no longer has to be the one still down.
      if (!session.sticky && event.pointerId !== session.pointerId) return
      if (!session.sticky && !session.dragged && cyclePointerDragged(session.origin, event.clientX, event.clientY)) session.dragged = true
      const intent = cyclePointerIntent(event.clientX, event.clientY, session.rail, session.entries.length, session.defaultAction)
      choose(intent.action ? intent.position : session.raw, intent.action)
    }
    // A drag commits wherever it is released. A click that never travelled is
    // the other half of the same control: the wheel is left open, the cursor
    // moves with the button up, and a second click anywhere confirms.
    function release(event) {
      if (session.keyboard || session.finishing || session.sticky) return
      if (event.pointerId !== session.pointerId) return
      if (session.dragged) return finish()
      session.sticky = true
      setSticky(true)
    }
    function press(event) {
      if (!session.sticky || session.finishing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      finish(event.button !== 0)
    }
    function wheel(event) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (session.finishing) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1)
      choose(session.raw + delta / 160)
    }
    function key(event) {
      if (!['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Tab'].includes(event.key)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Tab' || (event.repeat && (event.key === 'Enter' || event.key === ' '))) return
      if (event.key === 'Escape') return finish(true)
      if (session.finishing) return
      if (event.key === 'Enter' || event.key === ' ') return finish()
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return choose(session.raw, event.key === 'ArrowLeft' ? 'focus' : 'add')
      const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      let index = event.key === 'Home' ? 0 : event.key === 'End' ? session.entries.length - 1 : Math.round(session.target) + direction
      if (index >= 0 && index < session.entries.length) choose(index, session.action || session.defaultAction)
    }
    const cancel = () => finish(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('wheel', wheel, { capture: true, passive: false })
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      finishRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('wheel', wheel, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
    }
  }, [session])

  useEffect(() => {
    if (session && (!isActive || session.signature !== species.map(getGenomeKey).join('|') || session.activeSignature !== activeSpecies.map(getGenomeKey).join('|'))) finishRef.current?.(true)
  }, [session, species, activeSpecies, isActive])

  const faceHeight = session ? Math.max(80, Math.min(300, session.height * 0.5)) : 0
  const step = session?.entries.length === 2 ? 180 : 360 / (session?.entries.length || 3)
  const radius = session?.entries.length <= 2 ? 0 : faceHeight / (2 * Math.tan(Math.PI / (session?.entries.length || 3)))
  // A genome that is already open cannot be added to the pool, so the right-hand
  // action becomes a jump to it. Either way the browser scrolls it to the top.
  const candidateActive = Boolean(session?.entries[candidate]?.active)
  const addLabel = cycleActionLabel('add', candidateActive)
  const chosenLabel = cycleActionLabel(action, candidateActive)
  return <>
    <button ref={button} type="button" className="genome-wheel-button" disabled={!enabled || !isActive}
      aria-label="Cycle genomes" aria-expanded={Boolean(session)} title="Drag down to choose a genome and release, or click once, move, and click again; left to Focus, right to Add or Jump. Keyboard: Enter, then arrow keys."
      onPointerDown={event => { if (event.button === 0) start(event) }}
      onPointerCancel={() => finishRef.current?.(true)}
      onLostPointerCapture={() => { const open = sessionRef.current; if (open && !open.finishing && !open.sticky) finishRef.current?.(true) }}
      onKeyDown={event => { if (!session && (event.key === 'Enter' || event.key === ' ')) start(event, true) }}>
      Cycle
    </button>
    {session && createPortal(<div className={`genome-wheel-overlay genome-wheel-overlay-genome ${isLight ? 'light' : ''} ${phase} ${sticky ? 'hovering' : ''}`} style={{ top: session.top }} data-browser-controls="true" onContextMenu={event => event.preventDefault()}>
      <div className="genome-wheel-scene" ref={stage} style={{ '--wheel-position': session.initial, '--face-step': `${step}deg`, '--radius': `${radius}px`, '--face-height': `${faceHeight}px` }}>
        <div className="genome-wheel-drum">{session.entries.map((entry, index) => <div key={entry.key} className={`genome-wheel-face ${index === candidate ? 'selected' : ''}`} style={{ '--face-index': index, '--accent': entry.color }}>
          <div className="genome-wheel-caption"><i style={{ background: entry.color }} />{entry.label}<small>{entry.assembly}</small></div>
          <GenomeCyclePreview entry={entry} nearby={Math.abs(index - candidate) <= 1} />
        </div>)}</div>
      </div>
      <div className="genome-wheel-rail" style={{ height: session.rail.height, left: session.rail.center - 26, top: session.rail.top }} role="slider" aria-orientation="vertical" aria-label="Genome to activate" aria-valuemin={1} aria-valuemax={session.entries.length} aria-valuenow={candidate + 1} aria-valuetext={`${session.entries[candidate]?.label}: ${chosenLabel || 'Cancel selected'}`}>
        <div className="genome-wheel-line" style={{ top: session.rail.padding, bottom: session.rail.padding }} />
        {session.entries.map((entry, index) => <span key={entry.key} className="genome-wheel-dot" style={{ top: session.rail.padding + index * session.rail.spacing, background: entry.color }} title={`${entry.label}${entry.active ? '' : ' (inactive)'}`} />)}
        <span className={`genome-wheel-indicator ${action ? '' : 'outside'}`} style={{ top: session.rail.padding + candidate * session.rail.spacing }} />
        <div className="genome-cycle-actions" style={{ top: session.rail.padding + candidate * session.rail.spacing }}>
          <span className={`genome-cycle-action ${action === 'focus' ? 'chosen' : ''}`} style={{ left: 26 - CYCLE_ACTION_OFFSET }} title="Focus: make this the sole active genome">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="10" cy="10" r="5"/><circle cx="10" cy="10" r="1.5"/><path d="M10 1v3m0 12v3M1 10h3m12 0h3"/></svg><small>Focus</small>
          </span>
          <span className={`genome-cycle-action ${action === 'add' ? 'chosen' : ''}`} style={{ left: 26 + CYCLE_ACTION_OFFSET }}
            title={candidateActive ? 'Jump: scroll this genome to the top of the browser' : 'Add: append to the active genomes'}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
              {candidateActive ? <path d="M3 3h14M10 17V7m-4 4 4-4 4 4"/> : <path d="M10 3v14M3 10h14"/>}
            </svg><small>{addLabel}</small>
          </span>
        </div>
      </div>
      <button type="button" className={`genome-cycle-cancel ${!action ? 'chosen' : ''}`}
        style={{ left: session.rail.center, top: session.rail.cancelTop, height: session.rail.cancelHeight }}
        aria-label="Cancel genome selection" aria-pressed={!action}
        onClick={() => finishRef.current?.(true)}>Cancel</button>
      <div className="genome-wheel-status" aria-live="polite">
        <strong>{phase === 'error' ? 'Unable to open genome' : session.entries[candidate]?.details.name}</strong>
        <div className="genome-cycle-identity">{[session.entries[candidate]?.species.scientific_name, session.entries[candidate]?.details.assembly, session.entries[candidate]?.details.accession, session.entries[candidate]?.badge.badgeTooltip].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ')}</div>
        {session.entries[candidate]?.details.label && <div className="genome-cycle-label">{session.entries[candidate].details.label}</div>}
        <span>{phase === 'cancelling' ? 'Cancelling…'
          : phase === 'settling' ? `${cycleActionProgress(action, candidateActive)} genome…`
          : action === 'focus' ? 'Focus — make this the only active genome'
          : action === 'add' ? (candidateActive ? 'Jump — scroll this genome to the top of the browser' : 'Add — keep the active pool and append this genome')
          : sticky ? 'Click to cancel' : 'Release to cancel'}</span>
        {sticky && <span>Move to choose · Click to confirm · Esc Cancel</span>}
        {session.keyboard && <span>↑ ↓ Genome · ← Focus · → Add · Enter Confirm · Esc Cancel</span>}
      </div>
    </div>, document.body)}
  </>
}
