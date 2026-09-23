// The achievement tracker: one module-level instance, no React.
//
// Views call `trackAchievement('some.event')` from handlers that already run — a click,
// a commit, a successful fetch. That call has to cost nothing measurable, because it
// sits on paths people use constantly and achievements are an optional game:
//
// * It never touches React. Nothing re-renders because something was tracked; only the
//   Achievements view and the unlock toast subscribe, and only while mounted.
// * It returns at once for anything no locked achievement is listening to. The `live`
//   set holds the inputs some locked achievement still needs; once they are all
//   unlocked, every call on that input is a Set lookup and a return.
// * It never does I/O on the caller's time. Changes are batched and sent a few seconds
//   later, or when the window is hidden.
//
// A running tutorial is a sandbox: autoplay clicks through the browser on the reader's
// behalf, and even a reader doing it by hand is following instructions. Nothing done in
// one counts, except the tutorial achievements themselves (TUTORIAL_ALLOWED_EVENTS).
//
// Tracking always runs, whether or not achievements have been switched on, so that
// switching them on reveals what the user has already done. They are switched on once,
// with the Enable achievements button in the view (`enableAchievements`), and that is
// stored with the rest of the progress. Notifications only appear once they are on, and
// while the user has not turned notifications off. Whether the view has a button in the
// top bar makes no difference to any of this.

import { API_BASE } from '../backendRuntime.js'
import { isTutorialSandboxActive } from '../tutorials/sandbox.js'
import { ACTIVE_ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, TUTORIAL_ALLOWED_EVENTS } from './catalogue.js'
import { newlySatisfied, ruleInputs } from './rules.js'

const FLUSH_DELAY_MS = 4000
const NOTICE_BATCH_MS = 250
const CLOCK_TICK_MS = 30 * 1000
// Time only counts while someone is actually there: the window is visible and there
// has been input recently. Five minutes allows for reading without touching anything.
const IDLE_AFTER_MS = 5 * 60 * 1000
const LOAD_RETRY_MS = [1500, 3000, 6000, 12000, 30000]

// ── Index: which achievements listen to which input ─────────────────────────────

const INPUT_INDEX = new Map()
for (const achievement of ACTIVE_ACHIEVEMENTS) {
  for (const input of ruleInputs(achievement.rule)) {
    if (!INPUT_INDEX.has(input)) INPUT_INDEX.set(input, [])
    INPUT_INDEX.get(input).push(achievement)
  }
}
const META_ACHIEVEMENTS = INPUT_INDEX.get('meta') || []

// ── State ─────────────────────────────────────────────────────────────────────

function emptyFacts() {
  return { unlocked: {}, counters: {}, distinct: {}, durations: {}, lineage: new Set(), settings: {} }
}

function emptyPending() {
  return { unlocked: {}, counters: {}, distinct: {}, durations: {}, settings: {} }
}

let facts = emptyFacts()
let pending = emptyPending()
let live = new Set(INPUT_INDEX.keys())
let loaded = false
let loading = null
let readonly = false
let loadError = ''
let flushTimer = null
let flushing = false
let context = { currentView: '', screenshotMode: false }
let started = false
let lastInputAt = Date.now()
let lastTickAt = Date.now()
let clockTimer = null

const listeners = new Set()
const noticeListeners = new Set()
const reconcilers = new Set()
let noticeQueue = []
let noticeTimer = null
let snapshot = buildSnapshot()

function buildSnapshot() {
  return {
    loaded,
    readonly,
    loadError,
    facts,
    enabled: achievementsEnabled(),
    notificationsOn: facts.settings.notifications !== false,
  }
}

function emit() {
  snapshot = buildSnapshot()
  for (const listener of listeners) listener()
}

function recomputeLive() {
  const next = new Set()
  for (const [input, achievements] of INPUT_INDEX) {
    if (achievements.some((achievement) => !facts.unlocked[achievement.id])) next.add(input)
  }
  live = next
}

function trackingAllowed(event) {
  return !isTutorialSandboxActive() || TUTORIAL_ALLOWED_EVENTS.has(event)
}

/**
 * Whether the user has switched achievements on. Anyone who had already unlocked #1 did
 * so under the earlier rule (adding the view to the top bar) and counts as having done it.
 */
function achievementsEnabled() {
  return facts.settings.enabled === true || Boolean(facts.unlocked.achievements_unlocked)
}

function notificationsAllowed() {
  return (
    loaded &&
    achievementsEnabled() &&
    facts.settings.notifications !== false &&
    !context.screenshotMode &&
    !isTutorialSandboxActive()
  )
}

// ── Unlocking ─────────────────────────────────────────────────────────────────

function queueNotice(ids) {
  if (!ids.length || !notificationsAllowed()) return
  noticeQueue.push(...ids)
  if (noticeTimer) return
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    const batch = [...new Set(noticeQueue)]
    noticeQueue = []
    if (!batch.length || !notificationsAllowed()) return
    for (const listener of noticeListeners) listener(batch)
  }, NOTICE_BATCH_MS)
}

function unlock(ids) {
  const at = new Date().toISOString()
  for (const id of ids) {
    facts.unlocked[id] = { at }
    pending.unlocked[id] = at
  }
}

/** Unlock whatever among `candidates` is now satisfied, then any totals that follow. */
function evaluate(candidates) {
  if (!loaded || readonly) return false
  const unlockedNow = newlySatisfied(facts, candidates)
  if (!unlockedNow.length) return false
  unlock(unlockedNow)
  // Meta achievements count unlocks, so each round can make another one true.
  for (let round = 0; round < 10; round += 1) {
    const more = newlySatisfied(facts, META_ACHIEVEMENTS)
    if (!more.length) break
    unlock(more)
    unlockedNow.push(...more)
  }
  recomputeLive()
  queueNotice(unlockedNow)
  return true
}

function changed(input) {
  evaluate(INPUT_INDEX.get(input) || [])
  scheduleFlush()
  emit()
}

// ── Public: recording ─────────────────────────────────────────────────────────

/**
 * Record that something happened. With a `key`, it is one member of a set (a view
 * visited, a control used); without one, it counts once more.
 */
export function trackAchievement(event, key) {
  if (!trackingAllowed(event)) return
  if (key === undefined || key === null) {
    const input = `counter:${event}`
    if (!live.has(input)) return
    facts.counters[event] = (facts.counters[event] || 0) + 1
    pending.counters[event] = (pending.counters[event] || 0) + 1
    changed(input)
    return
  }
  const input = `set:${event}`
  if (!live.has(input)) return
  const member = String(key)
  const seen = facts.distinct[event] || (facts.distinct[event] = new Set())
  if (seen.has(member)) return
  seen.add(member)
  ;(pending.distinct[event] || (pending.distinct[event] = new Set())).add(member)
  changed(input)
}

/**
 * Raise a count to at least `value`, for totals read off existing state (how many notes
 * there are) rather than counted as they happen. Never lowers it: deleting a note does
 * not take a note back.
 */
export function raiseAchievementCount(event, value) {
  if (!trackingAllowed(event)) return
  const input = `counter:${event}`
  if (!live.has(input)) return
  const current = facts.counters[event] || 0
  const target = Math.floor(Number(value) || 0)
  if (target <= current) return
  facts.counters[event] = target
  pending.counters[event] = (pending.counters[event] || 0) + (target - current)
  changed(input)
}

/**
 * Something that restores achievements derived from existing state (notes, playlists,
 * colours…). Called after the store loads and after a reset, as well as whenever the
 * registering component decides its state has changed.
 */
export function registerAchievementReconciler(fn) {
  reconcilers.add(fn)
  if (loaded) {
    try { fn() } catch { /* a reconciler must never break its host */ }
  }
  return () => reconcilers.delete(fn)
}

function runReconcilers() {
  // Switched on is stored as a setting, so it survives a reset that clears #1: give it
  // back, as every other still-true achievement is.
  if (facts.settings.enabled === true) trackAchievement('achievements.enabled')
  for (const fn of reconcilers) {
    try { fn() } catch { /* as above */ }
  }
}

// ── Public: context from App ──────────────────────────────────────────────────

/** What App knows that the tracker needs: which view is showing, and screenshot mode. */
export function setAchievementsContext(next) {
  context = { ...context, ...next }
}

/**
 * The Enable achievements button. Switches achievements and their notifications on, and
 * announces everything already unlocked — once, since the switch is stored. The caller
 * records `achievements.enabled` straight after, which unlocks #1 into the same notice.
 */
export function enableAchievements() {
  if (achievementsEnabled() && facts.settings.enabled === true) return
  facts.settings = { ...facts.settings, enabled: true, notifications: true }
  pending.settings.enabled = true
  pending.settings.notifications = true
  scheduleFlush(500)
  emit()
  queueNotice(Object.keys(facts.unlocked).filter((id) => ACHIEVEMENTS_BY_ID.has(id)))
}

export function setAchievementNotifications(enabled) {
  const value = Boolean(enabled)
  if ((facts.settings.notifications !== false) === value) return
  facts.settings = { ...facts.settings, notifications: value }
  pending.settings.notifications = value
  scheduleFlush()
  emit()
}

// ── Public: subscription ──────────────────────────────────────────────────────

export function subscribeAchievements(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAchievementsSnapshot() {
  return snapshot
}

/** Called with an array of newly unlocked ids whenever a batch should be announced. */
export function subscribeAchievementNotices(listener) {
  noticeListeners.add(listener)
  return () => noticeListeners.delete(listener)
}

// ── Talking to the backend ────────────────────────────────────────────────────

function adoptServer(response) {
  const store = response?.store || {}
  const next = emptyFacts()
  for (const [id, record] of Object.entries(store.unlocked || {})) {
    next.unlocked[id] = { at: String(record?.at || '') }
  }
  for (const [id, record] of Object.entries(facts.unlocked)) {
    const existing = next.unlocked[id]
    if (!existing || (record.at && record.at < existing.at)) next.unlocked[id] = record
  }
  for (const [event, value] of Object.entries(store.counters || {})) next.counters[event] = Number(value) || 0
  for (const [event, value] of Object.entries(facts.counters)) {
    next.counters[event] = Math.max(next.counters[event] || 0, value)
  }
  for (const [set, keys] of Object.entries(store.distinct || {})) next.distinct[set] = new Set(keys)
  for (const [set, keys] of Object.entries(facts.distinct)) {
    const target = next.distinct[set] || (next.distinct[set] = new Set())
    for (const key of keys) target.add(key)
  }
  for (const [metric, value] of Object.entries(store.durations_ms || {})) next.durations[metric] = Number(value) || 0
  for (const [metric, value] of Object.entries(facts.durations)) {
    next.durations[metric] = Math.max(next.durations[metric] || 0, value)
  }
  next.lineage = new Set((response?.lineage_taxa || []).map(Number))
  next.settings = { ...(store.settings || {}), ...pending.settings }
  facts = next
  readonly = Boolean(response?.readonly)
}

function deltaPayload(batch) {
  const distinct = {}
  for (const [set, keys] of Object.entries(batch.distinct)) distinct[set] = [...keys]
  return {
    unlocked: batch.unlocked,
    counters: batch.counters,
    distinct,
    durations_ms: batch.durations,
    settings: batch.settings,
  }
}

function pendingIsEmpty() {
  return (
    !Object.keys(pending.unlocked).length &&
    !Object.keys(pending.counters).length &&
    !Object.keys(pending.distinct).length &&
    !Object.keys(pending.durations).length &&
    !Object.keys(pending.settings).length
  )
}

function mergeBack(batch) {
  Object.assign(pending.unlocked, { ...batch.unlocked, ...pending.unlocked })
  for (const [event, step] of Object.entries(batch.counters)) pending.counters[event] = (pending.counters[event] || 0) + step
  for (const [set, keys] of Object.entries(batch.distinct)) {
    const target = pending.distinct[set] || (pending.distinct[set] = new Set())
    for (const key of keys) target.add(key)
  }
  for (const [metric, step] of Object.entries(batch.durations)) pending.durations[metric] = (pending.durations[metric] || 0) + step
  pending.settings = { ...batch.settings, ...pending.settings }
}

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  if (flushTimer || typeof window === 'undefined') return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushAchievements()
  }, delay)
}

/** Send what has changed. `keepalive` for the last flush as the window goes away. */
export async function flushAchievements({ keepalive = false } = {}) {
  if (!loaded || readonly || flushing || pendingIsEmpty()) return
  const batch = pending
  pending = emptyPending()
  flushing = true
  try {
    const res = await fetch(`${API_BASE}/api/achievements/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta: deltaPayload(batch) }),
      keepalive,
    })
    if (!res.ok) throw new Error(`Sync failed (${res.status})`)
    adoptServer(await res.json())
    recomputeLive()
    evaluate(ACTIVE_ACHIEVEMENTS)
    emit()
  } catch {
    mergeBack(batch)
    scheduleFlush(FLUSH_DELAY_MS * 4)
  } finally {
    flushing = false
    if (!pendingIsEmpty()) scheduleFlush()
  }
}

async function fetchStore(attempt = 0) {
  try {
    const res = await fetch(`${API_BASE}/api/achievements`)
    if (!res.ok) throw new Error(`Load failed (${res.status})`)
    return await res.json()
  } catch (error) {
    if (attempt >= LOAD_RETRY_MS.length) throw error
    await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_MS[attempt]))
    return fetchStore(attempt + 1)
  }
}

/**
 * Load (or reload, after the output directory changes) the store from the backend.
 * Anything recorded before the load finished is kept and merged in.
 */
export function loadAchievements() {
  if (loading) return loading
  loading = (async () => {
    try {
      const response = await fetchStore()
      adoptServer(response)
      loaded = true
      loadError = ''
      recomputeLive()
      runReconcilers()
      evaluate(ACTIVE_ACHIEVEMENTS)
      if (!pendingIsEmpty()) scheduleFlush(500)
    } catch (error) {
      loadError = error?.message || 'Could not load achievements'
    } finally {
      loading = null
      emit()
    }
  })()
  return loading
}

/** Pick up progress the backend recorded by itself (a download finishing). */
export async function refreshAchievements() {
  if (!loaded) return
  await flushAchievements()
  if (!pendingIsEmpty()) return
  try {
    const res = await fetch(`${API_BASE}/api/achievements`)
    if (!res.ok) return
    adoptServer(await res.json())
    recomputeLive()
    evaluate(ACTIVE_ACHIEVEMENTS)
    if (!pendingIsEmpty()) scheduleFlush(500)
    emit()
  } catch {
    // Next time.
  }
}

/** Clear every achievement, then re-award whatever is still true. */
export async function resetAchievements() {
  await flushAchievements()
  const res = await fetch(`${API_BASE}/api/achievements/reset`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.detail || 'Could not reset achievements')
  facts = emptyFacts()
  pending = emptyPending()
  adoptServer(data)
  recomputeLive()
  runReconcilers()
  evaluate(ACTIVE_ACHIEVEMENTS)
  if (!pendingIsEmpty()) scheduleFlush(500)
  emit()
  return data
}

// ── Time ──────────────────────────────────────────────────────────────────────

function noteInput() {
  lastInputAt = Date.now()
}

function tick() {
  const now = Date.now()
  // Capped, so a machine waking from sleep does not claim the hours it was asleep.
  const elapsed = Math.min(now - lastTickAt, CLOCK_TICK_MS * 2)
  lastTickAt = now
  if (elapsed <= 0) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (now - lastInputAt > IDLE_AFTER_MS) return
  const metrics = ['app.active']
  if (context.currentView === 'achievements') metrics.push('view.achievements')
  let touched = false
  for (const metric of metrics) {
    if (!live.has(`duration:${metric}`)) continue
    facts.durations[metric] = (facts.durations[metric] || 0) + elapsed
    pending.durations[metric] = (pending.durations[metric] || 0) + elapsed
    evaluate(INPUT_INDEX.get(`duration:${metric}`) || [])
    touched = true
  }
  if (touched) {
    scheduleFlush()
    emit()
  }
}

/** Start the tracker. Idempotent; App calls it once on mount. */
export function startAchievements() {
  if (started || typeof window === 'undefined') return
  started = true
  const passive = { capture: true, passive: true }
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    window.addEventListener(type, noteInput, passive)
  }
  lastTickAt = Date.now()
  clockTimer = setInterval(tick, CLOCK_TICK_MS)
  const flushOnHide = () => {
    if (document.visibilityState === 'hidden') void flushAchievements({ keepalive: true })
  }
  document.addEventListener('visibilitychange', flushOnHide)
  window.addEventListener('pagehide', () => { void flushAchievements({ keepalive: true }) })
  void loadAchievements()
}

// For tests only: put the module back to a clean state.
export function __resetAchievementsForTests() {
  facts = emptyFacts()
  pending = emptyPending()
  live = new Set(INPUT_INDEX.keys())
  loaded = false
  loading = null
  readonly = false
  loadError = ''
  context = { currentView: '', screenshotMode: false }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = null
  noticeQueue = []
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = null
  started = false
  listeners.clear()
  noticeListeners.clear()
  reconcilers.clear()
  snapshot = buildSnapshot()
}
