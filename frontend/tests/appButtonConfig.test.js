import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_BUTTON_META,
  DATA_VIEW_BUTTON_IDS,
  DEFAULT_ACTIVE_APP_BUTTONS,
  normalizeActiveAppButtons,
} from '../src/appButtonConfig.js'

test('Genome Selector uses the canonical genome_selector identifier', () => {
  assert.equal(DATA_VIEW_BUTTON_IDS.includes('genome_selector'), true)
  assert.equal(APP_BUTTON_META.genome_selector.viewId, 'genome_selector')
  assert.equal(APP_BUTTON_META.genome_selector.label, 'Genome Selector')
})

test('legacy species_selector button IDs migrate without changing their position', () => {
  const normalized = normalizeActiveAppButtons([
    'home',
    'species_selector',
    'genome_browser',
  ])
  assert.equal(normalized.includes('species_selector'), false)
  assert.equal(normalized.indexOf('genome_selector'), 1)
})

test('a stored selection keeps its omissions instead of being back-filled', () => {
  const normalized = normalizeActiveAppButtons(['home', 'configuration', 'theme_toggle'])
  assert.deepEqual(normalized, ['home', 'configuration', 'theme_toggle'])
})

test('an empty stored selection still keeps the Configuration button', () => {
  assert.deepEqual(normalizeActiveAppButtons([]), ['configuration'])
})

test('a missing setting falls back to every default button', () => {
  assert.deepEqual(normalizeActiveAppButtons(undefined), DEFAULT_ACTIVE_APP_BUTTONS)
})

test('the default bar is the curated set, in its curated order', () => {
  assert.deepEqual(DEFAULT_ACTIVE_APP_BUTTONS, [
    'home',
    'genome_selector',
    'genome_browser',
    'download',
    'sequence',
    'feature_explorer',
    'track_manager',
    'alignment',
    'alignment_explorer',
    'neighbourhood',
    'stats',
    'notes',
    'tutorials',
    'help',
    'configuration',
    'genome_playlist',
    'theme_toggle',
    'screenshot_toggle',
  ])
})

test('views left out of the default stay available to activate', () => {
  for (const id of ['structural_variation', 'homology']) {
    assert.equal(DEFAULT_ACTIVE_APP_BUTTONS.includes(id), false, `${id} should be off by default`)
    assert.equal(DATA_VIEW_BUTTON_IDS.includes(id), true, `${id} should still be offered`)
  }
})

test('a missing setting does not quietly switch the non-default views back on', () => {
  const normalized = normalizeActiveAppButtons(undefined)
  assert.equal(normalized.includes('structural_variation'), false)
  assert.equal(normalized.includes('homology'), false)
})

test('Sequence is a normal data view now that it ships switched on', () => {
  assert.equal(DEFAULT_ACTIVE_APP_BUTTONS.includes('sequence'), true)
  assert.equal(DATA_VIEW_BUTTON_IDS.includes('sequence'), true)
})

test("the backend's copy of the default matches this one", async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../backend/main.py', import.meta.url), 'utf8')
  const block = source.match(/"active_app_buttons": \[([\s\S]*?)\]/)
  assert.ok(block, 'backend DEFAULT_CONFIG should define active_app_buttons')
  const backendIds = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
  assert.deepEqual(backendIds, DEFAULT_ACTIVE_APP_BUTTONS)
})

test('rearranging means reordering the default buttons, not adding or removing views', async () => {
  const { isRearrangedFromDefault } = await import('../src/appButtonConfig.js')
  assert.equal(isRearrangedFromDefault(DEFAULT_ACTIVE_APP_BUTTONS), false)
  assert.equal(isRearrangedFromDefault(DEFAULT_ACTIVE_APP_BUTTONS.filter((id) => id !== 'stats')), false)
  const withAchievements = [...DEFAULT_ACTIVE_APP_BUTTONS]
  withAchievements.splice(15, 0, 'achievements')
  assert.equal(isRearrangedFromDefault(withAchievements), false)
  const swapped = [...DEFAULT_ACTIVE_APP_BUTTONS]
  ;[swapped[1], swapped[2]] = [swapped[2], swapped[1]]
  assert.equal(isRearrangedFromDefault(swapped), true)
})
