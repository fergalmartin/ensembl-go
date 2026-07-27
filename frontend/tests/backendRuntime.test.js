import test from 'node:test'
import assert from 'node:assert/strict'
import {
  API_TOKEN_HEADER,
  apiFetch,
  DEFAULT_API_BASE,
  normalizeBackendRuntime,
  resolveApiBase,
  resolveApiToken,
} from '../src/backendRuntime.js'

test('resolveApiBase prefers Electron runtime info over env override', () => {
  const apiBase = resolveApiBase({
    electronApiBase: 'http://127.0.0.1:9000',
    envApiBase: 'http://127.0.0.1:7000',
  })

  assert.equal(apiBase, 'http://127.0.0.1:9000')
})

test('resolveApiBase falls back to env override before default', () => {
  assert.equal(resolveApiBase({ envApiBase: 'http://localhost:8100' }), 'http://localhost:8100')
  assert.equal(resolveApiBase({}), DEFAULT_API_BASE)
})

test('normalizeBackendRuntime returns a safe browser fallback outside Electron', () => {
  const runtime = normalizeBackendRuntime(null)

  assert.equal(runtime.isElectron, false)
  assert.equal(runtime.ready, true)
  assert.equal(runtime.apiBase, DEFAULT_API_BASE)
  assert.equal(runtime.status, 'ready')
})

test('resolveApiToken prefers Electron token over env override', () => {
  assert.equal(resolveApiToken({ electronApiToken: 'electron-token', envApiToken: 'env-token' }), 'electron-token')
  assert.equal(resolveApiToken({ envApiToken: 'env-token' }), 'env-token')
})

test('apiFetch attaches local API token to backend API requests', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  let captured = null

  globalThis.window = {
    electronAPI: {
      getApiToken: () => 'local-token',
    },
  }
  globalThis.fetch = async (input, options = {}) => {
    captured = { input, options }
    return { ok: true }
  }

  try {
    await apiFetch(`${DEFAULT_API_BASE}/api/config`, { headers: { Accept: 'application/json' } })
    assert.equal(captured.input, `${DEFAULT_API_BASE}/api/config`)
    assert.equal(captured.options.headers.get(API_TOKEN_HEADER), 'local-token')
    assert.equal(captured.options.headers.get('Accept'), 'application/json')
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})
