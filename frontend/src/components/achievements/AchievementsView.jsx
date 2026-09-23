import { useEffect, useMemo, useRef, useState } from 'react'
import AchievementMedal from './AchievementMedal'
import useAchievements from '../../achievements/useAchievements.js'
import { ACTIVE_ACHIEVEMENTS, ACHIEVEMENTS } from '../../achievements/catalogue.js'
import { hasProgressBar, ruleProgress, unlockedCount } from '../../achievements/rules.js'
import AppButtonIcon from '../AppButtonIcon'
import { enableAchievements, resetAchievements, setAchievementNotifications, trackAchievement } from '../../achievements/tracker.js'

// The trophy cabinet. Everything shown is derived from the tracker's snapshot on each
// render; there is no state here beyond the filter and the reset confirmation.
//
// Until the user presses Enable achievements the cabinet is shown switched off: greyed,
// not interactive, and empty, so that switching on is what reveals what they have
// already done (progress is recorded all along; see tracker.js).

const EMPTY_FACTS = Object.freeze({
  unlocked: {}, counters: {}, distinct: {}, durations: {}, lineage: new Set(), settings: {},
})

// Ranks follow the meta achievements, so the title in the header is always one the user
// has actually earned.
const RANKS = [
  { id: null, label: 'Newcomer', target: 0 },
  { id: 'achievement_novice', label: 'Novice', target: 5 },
  { id: 'achievement_intermediate', label: 'Intermediate', target: 10 },
  { id: 'achievement_elite', label: 'Elite', target: 25 },
  { id: 'achievement_master', label: 'Master', target: 50 },
  { id: 'achievement_grandmaster', label: 'Grandmaster', target: 100 },
]

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'complete', label: 'Complete' },
  { id: 'locked', label: 'Locked' },
  { id: 'progress', label: 'In progress' },
]

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatProgress(rule, { value, target }) {
  if (rule.type === 'duration') {
    const minute = 60 * 1000
    if (target >= 60 * minute) {
      const hours = (ms) => (ms / (60 * minute)).toFixed(ms >= 10 * 60 * minute ? 0 : 1).replace(/\.0$/, '')
      return `${hours(value)} / ${hours(target)} h`
    }
    return `${Math.floor(value / minute)} / ${Math.round(target / minute)} min`
  }
  return `${value} / ${target}`
}

function ProgressRing({ fraction, isLight, size = 132 }) {
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, fraction))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={isLight ? '#e5e7eb' : '#374151'} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#0099ff"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 600ms ease-out' }}
      />
    </svg>
  )
}

function ProgressBar({ fraction, isLight }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`}>
      <div
        className="h-full rounded-full bg-[#0099ff]"
        style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, transition: 'width 400ms ease-out' }}
      />
    </div>
  )
}

function AchievementCard({ achievement, facts, isLight, highlighted, cardRef }) {
  const record = facts.unlocked[achievement.id]
  const unlocked = Boolean(record)
  const concealed = !unlocked && achievement.hidden
  const progress = ruleProgress(achievement.rule, facts)
  const showBar = !unlocked && !concealed && hasProgressBar(achievement.rule)

  const cardClass = unlocked
    ? (isLight ? 'bg-white border-[#0099ff]/50 shadow-sm' : 'bg-gray-800 border-[#0099ff]/50')
    : (isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/50 border-gray-700/70')
  const muted = isLight ? 'text-gray-500' : 'text-gray-400'

  return (
    <article
      ref={cardRef}
      data-achievement-id={achievement.id}
      className={`relative flex gap-3.5 rounded-xl border p-4 ${cardClass} ${highlighted ? 'achievement-card-highlight' : ''}`}
    >
      <AchievementMedal achievement={achievement} unlocked={unlocked} concealed={concealed} isLight={isLight} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`font-mono text-[11px] font-semibold tracking-wide ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
            #{String(achievement.number).padStart(2, '0')}
          </span>
          {(unlocked || concealed) && (
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider ${
                unlocked ? (isLight ? 'text-[#0077cc]' : 'text-blue-400') : muted
              }`}
            >
              {unlocked ? 'Complete' : 'Hidden'}
            </span>
          )}
        </div>
        <h3
          className={`mt-0.5 text-sm font-semibold leading-snug ${
            unlocked
              ? (isLight ? 'text-gray-900' : 'text-gray-100')
              : (isLight ? 'text-gray-600' : 'text-gray-300')
          }`}
        >
          {concealed ? 'Hidden achievement' : achievement.name}
        </h3>
        <p className={`mt-1 text-xs leading-relaxed ${muted} ${concealed ? 'italic' : ''}`}>
          {concealed ? 'Keep exploring to reveal this one.' : achievement.description}
        </p>
        {showBar && (
          <div className="mt-2.5 flex items-center gap-2">
            <ProgressBar fraction={progress.target ? progress.value / progress.target : 0} isLight={isLight} />
            <span className={`shrink-0 font-mono text-[11px] ${muted}`}>{formatProgress(achievement.rule, progress)}</span>
          </div>
        )}
        {unlocked && <div className={`mt-2 text-[11px] ${muted}`}>Unlocked {formatDate(record.at)}</div>}
      </div>
    </article>
  )
}

export default function AchievementsView({ theme = 'dark', focusId = '', onFocusHandled = null }) {
  const isLight = theme === 'light'
  const snapshot = useAchievements()
  const { loaded, readonly, loadError, notificationsOn, enabled } = snapshot
  const facts = enabled ? snapshot.facts : EMPTY_FACTS
  const [filter, setFilter] = useState('all')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetState, setResetState] = useState({ busy: false, message: '', error: '' })
  const [highlightId, setHighlightId] = useState('')
  const cardRefs = useRef(new Map())

  const summary = useMemo(() => {
    const total = ACTIVE_ACHIEVEMENTS.length
    const unlocked = unlockedCount(facts)
    const hiddenRemaining = ACTIVE_ACHIEVEMENTS.filter((a) => a.hidden && !facts.unlocked[a.id]).length
    const rankIndex = RANKS.reduce((best, rank, index) => (rank.id && facts.unlocked[rank.id] ? index : best), 0)
    const recent = ACHIEVEMENTS
      .filter((a) => facts.unlocked[a.id])
      .sort((a, b) => String(facts.unlocked[b.id].at).localeCompare(String(facts.unlocked[a.id].at)))
      .slice(0, 3)
    return { total, unlocked, hiddenRemaining, rank: RANKS[rankIndex], nextRank: RANKS[rankIndex + 1] || null, recent }
    // `snapshot` changes whenever anything inside `facts` does, and says whether they are on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])

  const switchOn = () => {
    enableAchievements()
    trackAchievement('achievements.enabled')
  }
  const offClass = enabled ? '' : 'pointer-events-none select-none opacity-45'

  const visible = useMemo(() => ACHIEVEMENTS.filter((achievement) => {
    if (achievement.retired && !facts.unlocked[achievement.id]) return false
    const done = Boolean(facts.unlocked[achievement.id])
    if (filter === 'complete') return done
    if (filter === 'locked') return !done
    if (filter === 'progress') {
      if (done || achievement.hidden || !hasProgressBar(achievement.rule)) return false
      return ruleProgress(achievement.rule, facts).value > 0
    }
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [snapshot, filter])

  const scrollToCard = (id) => {
    const node = cardRefs.current.get(id)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(id)
  }

  // Arriving from an unlock notification: show that achievement. Consumed inside the
  // frame rather than straight away: clearing it re-runs this effect, and a cleanup that
  // cancelled the frame would lose the scroll.
  useEffect(() => {
    if (!focusId || !loaded) return
    setFilter('all')
    requestAnimationFrame(() => {
      scrollToCard(focusId)
      onFocusHandled?.()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, loaded])

  useEffect(() => {
    if (!highlightId) return undefined
    const timer = setTimeout(() => setHighlightId(''), 2200)
    return () => clearTimeout(timer)
  }, [highlightId])

  const runReset = async () => {
    setResetState({ busy: true, message: '', error: '' })
    try {
      const result = await resetAchievements()
      const kept = Object.keys(result?.store?.unlocked || {}).length
      setResetState({
        busy: false,
        error: '',
        message: kept
          ? 'Achievements reset. Some were awarded again straight away because they are still true.'
          : 'Achievements reset.',
      })
      setConfirmingReset(false)
    } catch (error) {
      setResetState({ busy: false, message: '', error: error?.message || 'Reset failed' })
    }
  }

  const fraction = summary.total ? summary.unlocked / summary.total : 0
  const muted = isLight ? 'text-gray-500' : 'text-gray-400'
  const panel = isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'
  const chipBase = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors'
  const chip = (active) => (active
    ? (isLight ? 'border-[#0099ff] bg-[#e1f4ff] text-[#0077cc]' : 'border-[#0099ff] bg-[#0099ff]/15 text-blue-200')
    : (isLight ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50' : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'))

  return (
    <div className="h-full overflow-y-auto themed-scrollbar" data-screenshot-capture="view">
      <style>{`
        @keyframes achievement-card-pulse {
          0% { box-shadow: 0 0 0 0 rgba(0, 153, 255, 0.6); }
          100% { box-shadow: 0 0 0 14px rgba(0, 153, 255, 0); }
        }
        .achievement-card-highlight { animation: achievement-card-pulse 1.1s ease-out 2; }
        .achievement-enable { animation: achievement-card-pulse 1.8s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .achievement-card-highlight { animation: none; outline: 2px solid #0099ff; }
          .achievement-enable { animation: none; }
        }
      `}</style>
      <div className="max-w-6xl px-6 py-8">
        {/* ── Switching on ───────────────────────────────────────────────── */}
        {!enabled && loaded && (
          <div className="mb-5 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={switchOn}
              disabled={readonly}
              className="achievement-enable inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#0099ff] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#0099ff]/30 transition-colors hover:bg-[#0088ee] disabled:opacity-50"
            >
              <AppButtonIcon buttonId="achievements" isLight={isLight} compact />
              Enable achievements
            </button>
            {/* The same words as the Achievements card on Home. */}
            <p className={`text-sm ${muted}`}>
              Switch on achievements and unlock them by exploring the less obvious corners of Ensembl Go
            </p>
          </div>
        )}

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <section className={`rounded-2xl border p-6 ${panel} ${offClass}`} aria-disabled={!enabled}>
          <div className="flex flex-wrap items-center gap-6">
            <div className="relative shrink-0">
              <ProgressRing fraction={fraction} isLight={isLight} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-3xl font-bold tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-50'}`}>
                  {Math.floor(fraction * 100)}%
                </span>
                <span className={`text-[11px] ${muted}`}>complete</span>
              </div>
            </div>

            <div className="min-w-[16rem] flex-1">
              <div className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${isLight ? 'text-[#0077cc]' : 'text-blue-400'}`}>
                {summary.rank.label}
              </div>
              <h1 className={`mt-1 text-2xl font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Achievements</h1>
              <p className={`mt-1 text-sm ${muted}`}>
                <span className={`font-semibold ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>{summary.unlocked}</span> of {summary.total} complete
                {summary.hiddenRemaining > 0 && <> · {summary.hiddenRemaining} hidden still to find</>}
              </p>
              {summary.nextRank && (
                <div className="mt-3 max-w-sm">
                  <div className={`mb-1 flex justify-between text-[11px] ${muted}`}>
                    <span>Next rank: {summary.nextRank.label}</span>
                    <span className="font-mono">{Math.min(summary.unlocked, summary.nextRank.target)} / {summary.nextRank.target}</span>
                  </div>
                  <ProgressBar fraction={summary.unlocked / summary.nextRank.target} isLight={isLight} />
                </div>
              )}
            </div>
          </div>

          {summary.recent.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>Recently</span>
              {summary.recent.map((achievement) => (
                <button
                  key={achievement.id}
                  type="button"
                  onClick={() => scrollToCard(achievement.id)}
                  className={`${chipBase} ${chip(false)}`}
                >
                  <span className="font-mono opacity-60">#{String(achievement.number).padStart(2, '0')}</span>
                  {achievement.name}
                </button>
              ))}
            </div>
          )}
        </section>

        {(readonly || loadError) && (
          <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${isLight ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}`}>
            {readonly
              ? 'Your achievements were saved by a newer version of Ensembl Go. They are shown here, but nothing new will be recorded until you update.'
              : `Achievements could not be loaded (${loadError}). Anything you unlock now will be saved once the backend is reachable.`}
          </div>
        )}

        {/* ── Controls ───────────────────────────────────────────────────── */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className={`flex flex-wrap gap-1.5 ${offClass}`}>
            {FILTERS.map((entry) => (
              <button key={entry.id} type="button" disabled={!enabled} onClick={() => setFilter(entry.id)} className={`${chipBase} ${chip(filter === entry.id)}`}>
                {entry.label}
              </button>
            ))}
          </div>
          <div className="flex items-center">
            <label className={`flex select-none items-center gap-2 text-xs ${muted} ${enabled ? 'cursor-pointer' : 'opacity-45'}`}>
              <span>Enable notifications</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled && notificationsOn}
                disabled={!enabled}
                onClick={() => setAchievementNotifications(!notificationsOn)}
                className={`relative h-5 w-9 rounded-full transition-colors ${enabled && notificationsOn ? 'bg-[#0099ff]' : (isLight ? 'bg-gray-300' : 'bg-gray-600')}`}
              >
                <span
                  className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
                  style={{ left: 2, transform: enabled && notificationsOn ? 'translateX(16px)' : 'translateX(0)' }}
                />
              </button>
            </label>
          </div>
        </div>

        {/* ── The cabinet ────────────────────────────────────────────────── */}
        {!loaded && !loadError ? (
          <p className={`mt-8 text-sm ${muted}`}>Loading achievements…</p>
        ) : (
          <div className={`mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 ${offClass}`} aria-disabled={!enabled}>
            {visible.map((achievement) => (
              <AchievementCard
                key={achievement.id}
                achievement={achievement}
                facts={facts}
                isLight={isLight}
                highlighted={highlightId === achievement.id}
                cardRef={(node) => {
                  if (node) cardRefs.current.set(achievement.id, node)
                  else cardRefs.current.delete(achievement.id)
                }}
              />
            ))}
            {visible.length === 0 && (
              <p className={`col-span-full py-10 text-center text-sm ${muted}`}>Nothing here yet.</p>
            )}
          </div>
        )}

        {/* ── Reset ──────────────────────────────────────────────────────── */}
        {enabled && <div className={`mt-10 border-t pt-5 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
          {!confirmingReset ? (
            <button
              type="button"
              onClick={() => { setConfirmingReset(true); setResetState({ busy: false, message: '', error: '' }) }}
              disabled={readonly || !loaded}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${isLight ? 'border-gray-300 text-gray-600 hover:bg-gray-100' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}
            >
              Reset achievements…
            </button>
          ) : (
            <div className={`max-w-2xl rounded-lg border p-4 text-sm ${isLight ? 'border-red-200 bg-red-50 text-red-900' : 'border-red-500/30 bg-red-500/10 text-red-100'}`}>
              <p className="font-semibold">Reset every achievement?</p>
              <p className="mt-1 text-xs leading-relaxed opacity-90">
                This clears all of your achievements and the progress towards them, including
                time spent in the app. It cannot be undone from here, although a backup of the
                current file is kept beside it in your output directory. Anything that is still
                true — genomes you have downloaded, notes you have written, playlists you have
                made — will be awarded again straight away.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={runReset}
                  disabled={resetState.busy}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {resetState.busy ? 'Resetting…' : 'Reset achievements'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  disabled={resetState.busy}
                  className="rounded-md border border-current/30 px-3 py-1.5 text-xs font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {resetState.message && <p className={`mt-2 text-xs ${muted}`}>{resetState.message}</p>}
          {resetState.error && <p className={`mt-2 text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>{resetState.error}</p>}
        </div>}
      </div>
    </div>
  )
}
