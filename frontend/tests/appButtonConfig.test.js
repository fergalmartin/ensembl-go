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
