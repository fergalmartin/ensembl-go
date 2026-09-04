import { isBlockedDuringTutorial } from './tutorials/sandbox.js'

export const DEFAULT_API_BASE = 'http://127.0.0.1:8000'
export const API_TOKEN_HEADER = 'X-Ensembl-Local-Token'

let nativeFetch = null

function getElectronBridge() {
  if (typeof window === 'undefined') return null
  return window.electronAPI || null
}

export function resolveApiBase({ electronApiBase = '', envApiBase = '' } = {}) {
  const preferredElectronBase = String(electronApiBase || '').trim()
  if (preferredElectronBase) return preferredElectronBase

  const preferredEnvBase = String(envApiBase || '').trim()
  if (preferredEnvBase) return preferredEnvBase

  return DEFAULT_API_BASE
}

export function getApiBase() {
  const bridge = getElectronBridge()
  const electronApiBase = typeof bridge?.getApiBase === 'function' ? bridge.getApiBase() : ''
  const envApiBase = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_API_BASE || import.meta.env?.VITE_BACKEND_URL || '') : ''
  return resolveApiBase({ electronApiBase, envApiBase })
}

export const API_BASE = getApiBase()

export function resolveApiToken({ electronApiToken = '', envApiToken = '' } = {}) {
  const preferredElectronToken = String(electronApiToken || '').trim()
  if (preferredElectronToken) return preferredElectronToken

  const preferredEnvToken = String(envApiToken || '').trim()
  if (preferredEnvToken) return preferredEnvToken

  return ''
}

export function getApiToken() {
  const bridge = getElectronBridge()
  const electronApiToken = typeof bridge?.getApiToken === 'function' ? bridge.getApiToken() : ''
  const envApiToken = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_ENSEMBL_LOCAL_API_TOKEN || '') : ''
  return resolveApiToken({ electronApiToken, envApiToken })
}

function resolveFetchUrl(input) {
  if (typeof input === 'string' && input.startsWith('/')) {
    return new URL(input, API_BASE).toString()
  }
  return input
}

function shouldAttachToken(input) {
  try {
    const apiOrigin = new URL(API_BASE).origin
    const targetUrl = typeof input === 'string'
      ? new URL(input, API_BASE)
      : new URL(input?.url || '', API_BASE)
    return targetUrl.origin === apiOrigin && targetUrl.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

export async function apiFetch(input, options = {}) {
  const fetchImpl = nativeFetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available')
  }

  const resolvedInput = resolveFetchUrl(input)

  // A tutorial runs on a configuration overlay of its own and must not be able to write
  // the user's real one — from anywhere, including paths added later. Refused here rather
  // than at each of the dozen-odd call sites, and answered as a success so callers carry
  // on normally. See tutorials/sandbox.js.
  {
    const requestUrl = typeof resolvedInput === 'string' ? resolvedInput : resolvedInput?.url || ''
    const method = options.method
      || (typeof Request !== 'undefined' && resolvedInput instanceof Request ? resolvedInput.method : 'GET')
    if (isBlockedDuringTutorial(requestUrl, method)) {
      return new Response(JSON.stringify({ ok: true, skipped: 'tutorial-sandbox' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
  const isRequest = typeof Request !== 'undefined' && resolvedInput instanceof Request
  const headers = new Headers(options.headers || (isRequest ? resolvedInput.headers : undefined))
  const token = getApiToken()
  if (token && shouldAttachToken(resolvedInput) && !headers.has(API_TOKEN_HEADER)) {
    headers.set(API_TOKEN_HEADER, token)
  }

  return fetchImpl(resolvedInput, {
    ...options,
    headers,
  })
}

export function installApiFetchShim() {
  if (typeof globalThis === 'undefined' || typeof globalThis.fetch !== 'function') {
    return
  }
  if (!nativeFetch) {
    nativeFetch = globalThis.fetch.bind(globalThis)
  }
  globalThis.fetch = (input, options) => apiFetch(input, options)
}

export function normalizeBackendRuntime(raw) {
  const bridge = getElectronBridge()
  const isElectron = Boolean(bridge?.isElectron)
  const fallbackApiBase = getApiBase()
  if (!isElectron) {
    return {
      isElectron: false,
      platform: 'web',
      mode: 'http',
      status: 'ready',
      ready: true,
      attached: true,
    launchedByElectron: false,
    apiBase: fallbackApiBase,
    apiToken: getApiToken(),
    lastError: '',
      diagnostics: null,
      setupCommands: {},
      timestamp: Date.now(),
    }
  }

  return {
    isElectron: true,
    platform: raw?.platform || 'unknown',
    mode: raw?.mode || 'native',
    status: raw?.status || 'checking',
    ready: Boolean(raw?.ready),
    attached: Boolean(raw?.attached),
    launchedByElectron: Boolean(raw?.launchedByElectron),
    apiBase: raw?.apiBase || fallbackApiBase,
    apiToken: String(raw?.apiToken || getApiToken() || ''),
    lastError: String(raw?.lastError || ''),
    diagnostics: raw?.diagnostics || null,
    setupCommands: raw?.setupCommands || {},
    timestamp: Number(raw?.timestamp || Date.now()),
  }
}

export function getInitialBackendRuntime() {
  const bridge = getElectronBridge()
  if (!bridge?.isElectron) {
    return normalizeBackendRuntime(null)
  }

  const snapshot = typeof bridge.getBackendRuntimeSnapshot === 'function'
    ? bridge.getBackendRuntimeSnapshot()
    : null
  return normalizeBackendRuntime(snapshot)
}

export async function fetchBackendRuntimeStatus() {
  const bridge = getElectronBridge()
  if (!bridge?.isElectron || typeof bridge.getBackendRuntimeStatus !== 'function') {
    return normalizeBackendRuntime(null)
  }
  return normalizeBackendRuntime(await bridge.getBackendRuntimeStatus())
}

export function subscribeToBackendRuntime(callback) {
  const bridge = getElectronBridge()
  if (!bridge?.isElectron || typeof bridge.onBackendRuntimeStatus !== 'function') {
    return () => {}
  }
  return bridge.onBackendRuntimeStatus((payload) => {
    callback(normalizeBackendRuntime(payload))
  })
}

export async function retryBackendCheck() {
  const bridge = getElectronBridge()
  if (!bridge?.isElectron || typeof bridge.retryBackendCheck !== 'function') {
    return normalizeBackendRuntime(null)
  }
  return normalizeBackendRuntime(await bridge.retryBackendCheck())
}

export async function retryBackendLaunch() {
  const bridge = getElectronBridge()
  if (!bridge?.isElectron || typeof bridge.retryBackendLaunch !== 'function') {
    return normalizeBackendRuntime(null)
  }
  return normalizeBackendRuntime(await bridge.retryBackendLaunch())
}
