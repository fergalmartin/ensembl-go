import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime'
import { api } from './data.js'
import { emptyWorkspace, validateWorkspace } from './workspace.js'

const LOCAL_KEY = 'gene-trees:workspace'
const SAVE_DELAY_MS = 600
const HISTORY_LIMIT = 50

/**
 * The subtree-layer workspace: loaded from the library, saved back as it changes, and
 * undoable. `commit` is for edits (they enter the history); `patch` is for view-only
 * changes such as which layer is showing (they do not) — the Alignment Explorer's split.
 *
 * The backend copy is the real one. A copy in localStorage is kept as well, stamped with
 * the time, and only used if it is newer than the backend's (a crash before a save landed).
 */
export default function useWorkspace() {
  const [ws, setWs] = useState(emptyWorkspace)
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState('idle')
  const wsRef = useRef(ws)
  const history = useRef({ past: [], future: [] })
  const dirty = useRef(false)
  const timer = useRef(0)
  const [depth, setDepth] = useState({ past: 0, future: 0 })
  const syncDepth = () => setDepth({ past: history.current.past.length, future: history.current.future.length })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let remote = null
      try { remote = await api('/workspace') } catch { /* no backend yet: start empty */ }
      let local = null
      try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null') } catch { local = null }
      const useLocal = local?.workspace && (!remote?.updated || (local.saved || 0) > remote.updated * 1000 + 2000)
      const chosen = useLocal ? local.workspace : remote?.workspace
      if (!cancelled) {
        const next = validateWorkspace(chosen)
        wsRef.current = next
        setWs(next)
        setLoaded(true)
        if (useLocal) dirty.current = true
      }
    })()
    return () => { cancelled = true }
  }, [])

  const save = useCallback(async ({ keepalive = false } = {}) => {
    if (!dirty.current) return
    dirty.current = false
    const body = JSON.stringify(wsRef.current)
    setSaveState('saving')
    try {
      const response = await fetch(`${API_BASE}/api/gene-trees/workspace`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive,
      })
      setSaveState(response.ok ? 'saved' : 'error')
    } catch {
      dirty.current = true
      setSaveState('error')
    }
  }, [])

  const schedule = useCallback(next => {
    dirty.current = true
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ saved: Date.now(), workspace: next })) } catch { /* full or private */ }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => save(), SAVE_DELAY_MS)
  }, [save])

  useEffect(() => {
    const flush = () => save({ keepalive: true })
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); clearTimeout(timer.current); flush() }
  }, [save])

  const apply = useCallback((next, record) => {
    const prev = wsRef.current
    if (next === prev) return prev
    if (record) {
      history.current.past = [...history.current.past, prev].slice(-HISTORY_LIMIT)
      history.current.future = []
    }
    wsRef.current = next
    setWs(next)
    schedule(next)
    if (record) syncDepth()
    return next
  }, [schedule])

  /** An edit: recorded for undo. */
  const commit = useCallback(fn => apply(typeof fn === 'function' ? fn(wsRef.current) : fn, true), [apply])
  /** A view change (which layer is showing): saved, but not undoable. */
  const patch = useCallback(fn => apply(typeof fn === 'function' ? fn(wsRef.current) : fn, false), [apply])

  const undo = useCallback((redo = false) => {
    const from = redo ? history.current.future : history.current.past
    const to = redo ? history.current.past : history.current.future
    if (!from.length) return false
    to.push(wsRef.current)
    const next = from.pop()
    wsRef.current = next
    setWs(next)
    schedule(next)
    syncDepth()
    return true
  }, [schedule])

  return { ws, loaded, commit, patch, undo, saveState, canUndo: depth.past > 0, canRedo: depth.future > 0 }
}
