// postMessage channel to the sandboxed Mol* viewer iframe.
//
// The viewer is six megabytes of third-party code that needs 'unsafe-eval', so
// it runs on the backend's origin under its own Content-Security-Policy rather
// than inside the renderer, which holds the Electron bridge and the API token.
// That boundary is the point of this module: every instruction to the viewer and
// every event out of it crosses it here, so there is one place that validates
// origins and one place that knows the protocol.

import { API_BASE, getApiToken } from '../backendRuntime'

const PARENT_SOURCE = 'ensembl-structure'
const VIEWER_SOURCE = 'ensembl-structure-viewer'
const DEFAULT_TIMEOUT_MS = 60000

export function structureViewerOrigin() {
  try {
    return new URL(API_BASE).origin
  } catch {
    return ''
  }
}

export function structureViewerUrl() {
  const token = getApiToken()
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${API_BASE}/structure/viewer${query}`
}

/** Resolve a model URL the backend handed us against the backend origin. */
export function structureModelUrl(modelUrl) {
  const raw = String(modelUrl || '')
  if (!raw) return ''
  try {
    return new URL(raw, API_BASE).toString()
  } catch {
    return ''
  }
}

/**
 * Drive one viewer iframe.
 *
 * Commands issued before the viewer signals `ready` are queued rather than
 * dropped: the iframe is several megabytes and the panel will always have a
 * structure to show before the bundle has finished parsing.
 */
export function createStructureViewerBridge({ onEvent } = {}) {
  const origin = structureViewerOrigin()

  let frame = null
  let ready = false
  let disposed = false
  let nextId = 1
  const pending = new Map()
  const queue = []

  function handleMessage(event) {
    // The one check that matters: only the backend origin may speak for the
    // viewer. Anything else on the message bus is ignored outright.
    if (!origin || event.origin !== origin) return
    if (frame && event.source !== frame.contentWindow) return

    const message = event.data
    if (!message || typeof message !== 'object' || message.source !== VIEWER_SOURCE) return

    if (message.type === 'result') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.payload || {})
      else entry.reject(new Error(message.error || 'The structure viewer reported an error.'))
      return
    }

    if (message.type === 'ready') {
      ready = true
      while (queue.length) queue.shift()()
    }

    if (typeof onEvent === 'function') {
      onEvent(message.type, message.payload || {})
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleMessage)
  }

  function post(type, payload, timeoutMs) {
    if (disposed) return Promise.reject(new Error('The structure viewer is no longer mounted.'))

    const id = `cmd-${nextId += 1}`
    return new Promise((resolve, reject) => {
      const send = () => {
        const target = frame?.contentWindow
        if (!target) {
          reject(new Error('The structure viewer is not available.'))
          return
        }
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The structure viewer did not respond to "${type}".`))
        }, timeoutMs || DEFAULT_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        target.postMessage({ source: PARENT_SOURCE, type, id, payload: payload || {} }, origin)
      }

      if (ready) send()
      else queue.push(send)
    })
  }

  return {
    /** Attach to (or detach from) the iframe element once React has mounted it. */
    attach(element) {
      if (frame !== element) ready = false
      frame = element || null
    },
    isReady: () => ready,
    load: (payload) => post('load', payload),
    colorSegments: (payload) => post('colorSegments', payload),
    clearColors: () => post('clearColors'),
    highlight: (payload) => post('highlight', payload),
    clearHighlight: () => post('clearHighlight'),
    focus: (payload) => post('focus', payload),
    setTheme: (theme) => post('setTheme', { theme }),
    spin: (on) => post('spin', { on }),
    reset: () => post('reset'),
    screenshot: () => post('screenshot', {}, 20000),
    dispose() {
      disposed = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleMessage)
      }
      pending.forEach((entry) => {
        clearTimeout(entry.timer)
        entry.reject(new Error('The structure viewer was closed.'))
      })
      pending.clear()
      queue.length = 0
      frame = null
    },
  }
}
