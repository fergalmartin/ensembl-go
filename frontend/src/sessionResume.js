// Restore view state after a reload within the same app launch.
//
// Components register getters, called only on capture: hide, unload, sleep or
// screen lock. This adds no work to normal panning or rendering.
// Snapshots use sessionStorage and Electron's launch ID to prevent restoration
// after a relaunch. Each value can be consumed once; endSessionRestore discards
// anything left when the user starts a new action.

import { isTutorialSandboxActive } from './tutorials/sandbox.js'

const STORAGE_KEY = 'ensembl-go:session-resume'
const VERSION = 1

const providers = new Map()
const consumed = new Set()
let restored = readStoredSession()
let restoreOpen = restored !== null

function currentLaunchId() {
  if (typeof window === 'undefined') return ''
  try {
    return String(window.electronAPI?.getLaunchId?.() || '')
  } catch {
    return ''
  }
}

function getStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function readStoredSession() {
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) || 'null')
    if (!raw || raw.version !== VERSION || !raw.state || typeof raw.state !== 'object') return null
    if (String(raw.launchId || '') !== currentLaunchId()) return null
    return raw.state
  } catch {
    return null
  }
}

/** Offer a piece of state to the next capture. `getter` is only called at capture time
 *  and should return something JSON-serialisable, or undefined to leave it out.
 *  Returns the deregistration function. */
export function registerSessionState(key, getter) {
  const name = String(key || '').trim()
  if (!name || typeof getter !== 'function') return () => {}
  providers.set(name, getter)
  return () => {
    if (providers.get(name) === getter) providers.delete(name)
  }
}

/** What `key` held before the reload, while the restore is still open and nobody has
 *  taken it. Reading does not take it, so a component may read it during render. */
export function peekRestoredSessionState(key) {
  if (!restoreOpen || !restored || consumed.has(key)) return undefined
  return restored[key]
}

/** Mark `key` as restored, so a later mount of the same component starts fresh. */
export function consumeRestoredSessionState(key) {
  consumed.add(key)
}

/** Peek and consume in one go, for callers that apply the value immediately. */
export function takeRestoredSessionState(key) {
  const value = peekRestoredSessionState(key)
  consumeRestoredSessionState(key)
  return value
}

/** Whether this page load is resuming a session rather than starting one. */
export function isResumingSession() {
  return restored !== null
}

/** Close the restore window: anything nobody took by now is dropped. Called once the
 *  reader starts doing something new, such as switching app. */
export function endSessionRestore() {
  restoreOpen = false
}

/** Ask every registered part of the app where it is, and keep the answer. */
export function captureSessionState() {
  const storage = getStorage()
  if (!storage) return
  // A tutorial lays out a scene of its own over a sandboxed configuration; resuming
  // into the middle of one would be worse than starting on Home.
  if (isTutorialSandboxActive()) {
    try { storage.removeItem(STORAGE_KEY) } catch { /* nothing to clear */ }
    return
  }
  const state = {}
  // Whatever was waiting to be restored and has not been yet goes forward as it was,
  // so a second reload that lands before the first restore finished loses nothing.
  if (restoreOpen && restored) {
    for (const [key, value] of Object.entries(restored)) {
      if (!consumed.has(key)) state[key] = value
    }
  }
  for (const [key, getter] of providers) {
    try {
      const value = getter()
      if (value !== undefined) state[key] = value
    } catch (error) {
      console.warn(`[sessionResume] Could not capture "${key}"`, error)
    }
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: VERSION,
      launchId: currentLaunchId(),
      savedAt: Date.now(),
      state,
    }))
  } catch (error) {
    console.warn('[sessionResume] Could not store the session snapshot', error)
  }
}

let triggersInstalled = false

/** Capture at every moment a reload could follow. Installed once, at startup. */
export function installSessionResumeTriggers() {
  if (triggersInstalled || typeof window === 'undefined') return
  triggersInstalled = true
  // Fires for reloads as well as closes, including the dev client's own reload.
  window.addEventListener('pagehide', captureSessionState)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') captureSessionState()
  })
  // The page is not always hidden when the lid closes, so Electron says so itself.
  window.electronAPI?.onSystemSuspend?.(captureSessionState)
}
