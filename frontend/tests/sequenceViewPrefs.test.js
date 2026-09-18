import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultPrefs, normalisePrefs, readPrefs, writePrefs, PREFS_KEY } from '../src/utils/sequenceViewPrefs.js'
import { DEFAULT_COLLAPSE } from '../src/utils/sequenceViewDisplay.js'
import { DEFAULT_FLANKS } from '../src/utils/sequenceViewFocus.js'

test('the defaults are the ones the controls advertise', () => {
  const prefs = defaultPrefs()
  assert.deepEqual(prefs.collapse.intergenic, { on: false, flank: 100, min: 300 })
  assert.deepEqual(prefs.collapse.intron, { on: false, flank: 100, min: 300 })
  assert.deepEqual(prefs.flanks.gene, { five: 60, three: 60 })
  assert.deepEqual(prefs.flanks.transcript, { five: 60, three: 60 })
  assert.deepEqual(prefs.flanks.feature, { five: 10, three: 10 })
  assert.equal(prefs.reverse, false)
  assert.equal(prefs.protein, false)
})

test('nothing stored is the defaults, not an empty object', () => {
  assert.deepEqual(normalisePrefs(undefined), defaultPrefs())
  assert.deepEqual(normalisePrefs({}), defaultPrefs())
})

test('the older shape is read forward rather than thrown away', () => {
  // One switch for both kinds, one flank for both ends of every collapse, and
  // one number for both ends of a focus's own flank.
  const prefs = normalisePrefs({ collapse: true, collapseFlank: 25, flanks: { transcript: 40 } })
  assert.equal(prefs.collapse.intergenic.on, true)
  assert.equal(prefs.collapse.intron.on, true, 'the one switch meant both kinds')
  assert.equal(prefs.collapse.intergenic.flank, 25)
  assert.equal(prefs.collapse.intron.flank, 25)
  assert.equal(prefs.collapse.intron.min, DEFAULT_COLLAPSE.intron.min,
    'a setting that did not exist takes its default')
  assert.deepEqual(prefs.flanks.transcript, { five: 40, three: 40 })
  assert.deepEqual(prefs.flanks.feature, DEFAULT_FLANKS.feature, 'and the rest are untouched')
})

test('one end of one flank stored is enough, and the other keeps its default', () => {
  const prefs = normalisePrefs({ flanks: { gene: { five: 500 } } })
  assert.deepEqual(prefs.flanks.gene, { five: 500, three: 60 })
})

test('a switch added since the reader last visited is on where it should be', () => {
  // The reason this is field by field: a wholesale merge leaves a new highlight
  // off, which looks exactly like the new thing not working.
  const stored = { highlights: { transcript: { cds: false } } }
  const prefs = normalisePrefs(stored)
  assert.equal(prefs.highlights.transcript.cds, false, 'what they set')
  assert.equal(
    prefs.highlights.transcript.donor,
    defaultPrefs().highlights.transcript.donor,
    'and what they never saw',
  )
})

test('nonsense in storage does not reach the view', () => {
  const prefs = normalisePrefs({ collapse: { intron: { on: 'yes', flank: 'wide', min: -4 } } })
  assert.equal(prefs.collapse.intron.on, true)
  assert.equal(prefs.collapse.intron.flank, DEFAULT_COLLAPSE.intron.flank)
  assert.equal(prefs.collapse.intron.min, 1, 'a floor of zero would collapse everything')
})

test('a storage that throws leaves the reader with defaults rather than nothing', () => {
  const angry = {
    getItem() { throw new Error('private window') },
    setItem() { throw new Error('private window') },
  }
  assert.deepEqual(readPrefs(angry), defaultPrefs())
  assert.doesNotThrow(() => writePrefs(defaultPrefs(), angry))
})

test('what is written is what comes back', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  }
  const prefs = defaultPrefs()
  prefs.reverse = true
  prefs.collapse.intron = { on: true, flank: 12, min: 340 }
  writePrefs(prefs, storage)
  assert.ok(store.has(PREFS_KEY))
  assert.deepEqual(readPrefs(storage), prefs)
})
