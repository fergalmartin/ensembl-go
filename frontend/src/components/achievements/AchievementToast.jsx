import { useCallback, useEffect, useRef, useState } from 'react'
import AppButtonIcon from '../AppButtonIcon'
import AchievementMedal from './AchievementMedal'
import { ACHIEVEMENTS_BY_ID } from '../../achievements/catalogue.js'
import { subscribeAchievementNotices } from '../../achievements/tracker.js'

// The "Achievement unlocked" card in the corner.
//
// It stays up for a few seconds and then fades. Pointing at it holds it there, so it
// can be read or clicked however slowly; moving away starts the clock again. The close
// button dismisses it at once, and clicking anywhere else on it opens the Achievements
// view — at the achievement itself when there is one, at the top when there are several.
//
// Unlocks that arrive while it is showing join it rather than queueing behind it: one
// becomes "You've unlocked 2 achievements", and so on. Switching the view on for the
// first time announces everything unlocked so far the same way.

const SHOW_MS = 5000
const RESUME_MS = 2500
const FADE_MS = 600

export default function AchievementToastHost({ isLight, onOpen }) {
  const [ids, setIds] = useState([])
  const [phase, setPhase] = useState('hidden') // hidden | entering | shown | fading
  const timerRef = useRef(null)
  // Whether the pointer is over the toast is asked of the element itself, when it
  // matters, rather than kept in a flag. A flag set on mouseenter and cleared on
  // mouseleave goes stale whenever the toast disappears from under the pointer —
  // clicking it or its close button — because no mouseleave follows. Every later toast
  // then believed it was being hovered and never faded.
  const containerRef = useRef(null)
  const isHovered = () => Boolean(containerRef.current?.matches?.(':hover'))

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const dismiss = useCallback(() => {
    clearTimer()
    setPhase('hidden')
    setIds([])
  }, [])

  // While it is hovered it waits, checking again rather than relying on mouseleave, so
  // nothing that swallows that event can leave it on screen.
  const scheduleFade = useCallback((delay) => {
    clearTimer()
    timerRef.current = setTimeout(function fadeWhenFree() {
      if (isHovered()) {
        timerRef.current = setTimeout(fadeWhenFree, RESUME_MS)
        return
      }
      setPhase('fading')
      timerRef.current = setTimeout(dismiss, FADE_MS)
    }, delay)
  }, [dismiss])

  useEffect(() => subscribeAchievementNotices((batch) => {
    setIds((previous) => [...new Set([...previous, ...batch])].filter((id) => ACHIEVEMENTS_BY_ID.has(id)))
    setPhase((previous) => (previous === 'hidden' ? 'entering' : 'shown'))
    scheduleFade(SHOW_MS)
  }), [scheduleFade])

  // One frame at the start position, so the slide-in has somewhere to slide from.
  useEffect(() => {
    if (phase !== 'entering') return undefined
    const frame = requestAnimationFrame(() => setPhase('shown'))
    return () => cancelAnimationFrame(frame)
  }, [phase])

  useEffect(() => clearTimer, [])

  if (phase === 'hidden' || ids.length === 0) return null

  const single = ids.length === 1 ? ACHIEVEMENTS_BY_ID.get(ids[0]) : null
  const visible = phase === 'shown'

  const open = () => {
    dismiss()
    onOpen?.(single ? single.id : '')
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[9000]"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(12px)',
        transition: `opacity ${phase === 'fading' ? FADE_MS : 250}ms ease, transform 250ms ease`,
      }}
      ref={containerRef}
      onMouseEnter={() => {
        // Caught mid-fade: bring it back and start the wait again.
        if (phase === 'fading') {
          setPhase('shown')
          scheduleFade(RESUME_MS)
        }
      }}
      onMouseLeave={() => scheduleFade(RESUME_MS)}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open()
          }
        }}
        title="Open Achievements"
        className={`relative flex w-80 cursor-pointer items-center gap-3 rounded-xl border p-3 pr-9 text-left shadow-lg transition-colors ${
          isLight ? 'border-gray-200 bg-white hover:bg-gray-50' : 'border-gray-700 bg-gray-800 hover:bg-gray-700/60'
        }`}
      >
        {single ? (
          <AchievementMedal achievement={single} unlocked isLight={isLight} size={44} />
        ) : (
          <div className="relative shrink-0" aria-hidden="true">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#0099ff] text-white">
              <AppButtonIcon buttonId="achievements" isLight={isLight} />
            </div>
            <span
              className={`absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                isLight ? 'bg-[#0077cc] text-white ring-2 ring-white' : 'bg-white text-[#0077cc] ring-2 ring-gray-800'
              }`}
            >
              {ids.length}
            </span>
          </div>
        )}
        <div className="min-w-0">
          <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${isLight ? 'text-[#0077cc]' : 'text-blue-400'}`}>
            {single ? 'Achievement unlocked' : 'Achievements unlocked'}
          </div>
          <div className={`truncate text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
            {single ? single.name : `You've unlocked ${ids.length} achievements`}
          </div>
          <div className={`truncate text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
            {single ? `#${String(single.number).padStart(2, '0')} · Click to see it` : 'Click to see them'}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(event) => {
            event.stopPropagation()
            dismiss()
          }}
          className={`absolute right-2 top-2 rounded p-1 ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-gray-500 hover:bg-gray-700 hover:text-gray-200'}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
