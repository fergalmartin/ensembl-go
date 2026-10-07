import test from 'node:test'
import assert from 'node:assert/strict'
import { setTutorialSandboxActive } from '../src/tutorials/sandbox.js'

const STORAGE_KEY = 'ensembl-go:session-resume'

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    has: (key) => data.has(key),
  }
}

// The module reads the stored snapshot once, when it loads, so each case loads its own
// copy against a window set up for it.
let loadCount = 0
async function loadWith({ launchId = 'launch-a', stored = null } = {}) {
  const storage = fakeStorage(stored ? { [STORAGE_KEY]: JSON.stringify(stored) } : {})
  globalThis.window = {
    sessionStorage: storage,
    electronAPI: { getLaunchId: () => launchId },
    addEventListener() {},
  }
  const module = await import(`../src/sessionResume.js?case=${++loadCount}`)
  return { module, storage }
}

const snapshot = (state, launchId = 'launch-a') => ({ version: 1, launchId, savedAt: 1, state })

test.afterEach(() => {
  setTutorialSandboxActive(false)
  delete globalThis.window
})

test('a reload within the same launch resumes what was captured', async () => {
  const { module } = await loadWith({ stored: snapshot({ 'app.view': 'homology' }) })
  assert.equal(module.isResumingSession(), true)
  assert.equal(module.peekRestoredSessionState('app.view'), 'homology')
})

test('a relaunch starts fresh even if the window kept its storage', async () => {
  const { module } = await loadWith({ launchId: 'launch-b', stored: snapshot({ 'app.view': 'homology' }, 'launch-a') })
  assert.equal(module.isResumingSession(), false)
  assert.equal(module.peekRestoredSessionState('app.view'), undefined)
})

test('a value is offered until taken, and not after', async () => {
  const { module } = await loadWith({ stored: snapshot({ 'app.view': 'stats' }) })
  assert.equal(module.takeRestoredSessionState('app.view'), 'stats')
  assert.equal(module.peekRestoredSessionState('app.view'), undefined)
})

test('closing the restore window drops what nobody took', async () => {
  const { module } = await loadWith({ stored: snapshot({ 'notes.query': 'kinase' }) })
  module.endSessionRestore()
  assert.equal(module.peekRestoredSessionState('notes.query'), undefined)
})

test('capture asks each provider only at capture time and stores the launch', async () => {
  const { module, storage } = await loadWith()
  let calls = 0
  module.registerSessionState('app.view', () => { calls += 1; return 'genome_browser' })
  assert.equal(calls, 0)
  module.captureSessionState()
  assert.equal(calls, 1)
  const saved = JSON.parse(storage.getItem(STORAGE_KEY))
  assert.equal(saved.launchId, 'launch-a')
  assert.deepEqual(saved.state, { 'app.view': 'genome_browser' })
})

test('a provider that throws or has nothing to say is left out without losing the rest', async () => {
  const { module, storage } = await loadWith()
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    module.registerSessionState('broken', () => { throw new Error('nope') })
    module.registerSessionState('empty', () => undefined)
    module.registerSessionState('app.view', () => 'notes')
    module.captureSessionState()
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).state, { 'app.view': 'notes' })
})

test('what has not been restored yet survives a second reload', async () => {
  const { module, storage } = await loadWith({ stored: snapshot({ 'browser.panel:human': { chrom: '13', start: 1, end: 9 }, 'app.view': 'stats' }) })
  // The view was put back and now reports itself; the hidden browser panel has not
  // loaded yet, so it has nothing to report.
  module.consumeRestoredSessionState('app.view')
  module.registerSessionState('app.view', () => 'stats')
  module.captureSessionState()
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).state, {
    'browser.panel:human': { chrom: '13', start: 1, end: 9 },
    'app.view': 'stats',
  })
})

test('deregistering stops a provider being asked', async () => {
  const { module, storage } = await loadWith()
  const unregister = module.registerSessionState('app.view', () => 'help')
  unregister()
  module.captureSessionState()
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).state, {})
})

test('nothing is kept while a tutorial has the app', async () => {
  const { module, storage } = await loadWith({ stored: snapshot({ 'app.view': 'notes' }) })
  module.registerSessionState('app.view', () => 'tutorials')
  setTutorialSandboxActive(true)
  module.captureSessionState()
  assert.equal(storage.has(STORAGE_KEY), false)
})
