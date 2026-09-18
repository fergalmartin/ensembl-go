// The tutorial state machine: what satisfies a step, where the pointer goes next, and
// which definitions are incoherent enough to reject before anyone runs them.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TUTORIAL_STATUS,
  anchorSelector,
  arrivalGenomeRecipeIds,
  arrivalDialog,
  arrivalPlaylists,
  arrivalScrollOffset,
  arrivalScrollCenter,
  arrivalSelectedPlaylist,
  arrivalsFor,
  currentStep,
  initTutorialState,
  isAdvanceEventMatch,
  isLastStep,
  reduceTutorial,
  stepAt,
  stepCardPosition,
  stepCardSize,
  stepDefersPresentation,
  stepSection,
  tutorialAnchorIds,
  tutorialProgressLabel,
  tutorialSections,
  sectionCount,
  tutorialViewIds,
  stepCopyTarget,
  validateTutorial,
  tutorialNeedsDemoTracks,
} from '../src/utils/tutorialModel.js'

const tutorial = {
  id: 'demo',
  title: 'Demo',
  steps: [
    { id: 'intro', title: 'Hello', body: 'Welcome.', placement: 'center' },
    {
      id: 'open-config',
      view: 'configuration',
      anchor: 'app-button-configuration',
      title: 'Open Configuration',
      body: 'Click it.',
      advanceOn: { type: 'view', view: 'configuration' },
    },
    {
      id: 'save',
      view: 'configuration',
      anchor: 'config-save',
      title: 'Save',
      body: 'Press save.',
      advanceOn: { type: 'signal', name: 'config.saved' },
    },
    {
      id: 'drawer',
      view: 'genome_browser',
      anchor: { selector: '[data-focus-drawer]' },
      title: 'The drawer',
      body: 'Look right.',
    },
  ],
}

const run = (state, ...events) => events.reduce((acc, event) => reduceTutorial(tutorial, acc, event), state)

// ── anchors ───────────────────────────────────────────────────────────────────

test('a string anchor is a data-tour-id, an object anchor is a raw selector', () => {
  assert.equal(anchorSelector('config-save'), '[data-tour-id="config-save"]')
  assert.equal(anchorSelector({ selector: '[data-focus-drawer]' }), '[data-focus-drawer]')
  assert.equal(anchorSelector('  spaced  '), '[data-tour-id="spaced"]')
  assert.equal(anchorSelector(''), '')
  assert.equal(anchorSelector(null), '')
  assert.equal(anchorSelector({ nope: 1 }), '')
})

test('the anchor inventory covers every place a step can name one', () => {
  const wide = {
    steps: [
      { anchor: 'a', openSection: 'b', prefill: { anchor: 'c', value: 'x' } },
      { advanceOn: { type: 'click', anchor: 'd' } },
      { anchor: { selector: '[data-focus-drawer]' } },  // selector form is not an id
      { anchor: 'a' },                                   // deduplicated
    ],
  }
  assert.deepEqual(tutorialAnchorIds(wide), ['a', 'b', 'c', 'd'])
})

test('the apps a tutorial visits are listed in first-visit order, without repeats', () => {
  assert.deepEqual(tutorialViewIds(tutorial), ['configuration', 'genome_browser'])
})

test('a step only defers its presentation when explicitly requested', () => {
  assert.equal(stepDefersPresentation({ deferUntilReady: true }), true)
  assert.equal(stepDefersPresentation({ deferUntilReady: false }), false)
  assert.equal(stepDefersPresentation({}), false)
})

test('narrative sections group consecutive steps without losing their absolute indexes', () => {
  const sectioned = {
    steps: [
      { id: 'a', section: 'First' },
      { id: 'b', section: 'First' },
      { id: 'c', section: 'Second' },
    ],
  }
  assert.equal(stepSection(sectioned.steps[0]), 'First')
  assert.deepEqual(tutorialSections(sectioned), [
    { title: 'First', steps: [{ step: sectioned.steps[0], stepIndex: 0 }, { step: sectioned.steps[1], stepIndex: 1 }] },
    { title: 'Second', steps: [{ step: sectioned.steps[2], stepIndex: 2 }] },
  ])
})

test('the catalogue counts named chapters, not the steps or the unsectioned remainder', () => {
  const sectioned = {
    steps: [
      { id: 'a', section: 'First' },
      { id: 'b', section: 'First' },
      { id: 'c', section: 'Second' },
    ],
  }
  assert.equal(sectionCount(sectioned), 2)
  assert.equal(sectionCount({ steps: [{ id: 'a' }, { id: 'b' }] }), 0)
  assert.equal(sectionCount({}), 0)
})

test('a step override and its default browser controls are applied as one state change', () => {
  const tutorialWithLayout = {
    defaultArrive: { type: 'browserControls', detail: false, flatten: false, expanded: false },
  }
  const step = {
    arrive: [
      { type: 'browserView', locus: '1:100-200' },
      { type: 'browserControls', expanded: true },
    ],
  }
  assert.deepEqual(arrivalsFor(tutorialWithLayout, step), [
    { type: 'browserControls', detail: false, flatten: false, expanded: true },
    { type: 'browserView', locus: '1:100-200' },
  ])
})

// ── matching ──────────────────────────────────────────────────────────────────

test('a step with no advanceOn waits for Next and nothing else', () => {
  const step = stepAt(tutorial, 0)
  assert.ok(!isAdvanceEventMatch(step, { type: 'view', view: 'configuration' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'signal', name: 'config.saved' }))
})

test('a view step matches only its own view', () => {
  const step = stepAt(tutorial, 1)
  assert.ok(isAdvanceEventMatch(step, { type: 'view', view: 'configuration' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'view', view: 'download' }))
})

test('a click step falls back to the anchor the user is being pointed at', () => {
  const step = { id: 's', anchor: 'config-save', advanceOn: { type: 'click' } }
  assert.ok(isAdvanceEventMatch(step, { type: 'click', anchor: 'config-save' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'click', anchor: 'config-load' }))
})

test('a click step can wait on an anchor other than the one it highlights', () => {
  const step = { id: 's', anchor: 'config-section-outputs', advanceOn: { type: 'click', anchor: 'config-save' } }
  assert.ok(isAdvanceEventMatch(step, { type: 'click', anchor: 'config-save' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'click', anchor: 'config-section-outputs' }))
})

test('a click step with no anchor anywhere matches nothing', () => {
  assert.ok(!isAdvanceEventMatch({ id: 's', advanceOn: { type: 'click' } }, { type: 'click', anchor: 'x' }))
})

test('an all-clicks completion event is scoped to the step that collected the clicks', () => {
  const step = {
    id: 'four-turtles',
    advanceOn: { type: 'all-clicks', anchors: ['turtle-1', 'turtle-2', 'turtle-3', 'turtle-4'] },
  }
  assert.ok(isAdvanceEventMatch(step, { type: 'all-clicks', stepId: 'four-turtles' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'all-clicks', stepId: 'earlier-step' }))
})

test('a signal step matches on name, and on payload when it asks to', () => {
  const plain = stepAt(tutorial, 2)
  assert.ok(isAdvanceEventMatch(plain, { type: 'signal', name: 'config.saved' }))
  assert.ok(!isAdvanceEventMatch(plain, { type: 'signal', name: 'config.loaded' }))

  const fussy = { id: 's', advanceOn: { type: 'signal', name: 'genome.activated', match: { genomeKey: 'demo::1' } } }
  assert.ok(isAdvanceEventMatch(fussy, { type: 'signal', name: 'genome.activated', payload: { genomeKey: 'demo::1' } }))
  assert.ok(!isAdvanceEventMatch(fussy, { type: 'signal', name: 'genome.activated', payload: { genomeKey: 'other' } }))
  assert.ok(!isAdvanceEventMatch(fussy, { type: 'signal', name: 'genome.activated' }))
})

test('a dwell only counts for the step that armed it, so a stale timer cannot skip ahead', () => {
  const step = { id: 'watch', advanceOn: { type: 'dwell', ms: 2000 } }
  assert.ok(isAdvanceEventMatch(step, { type: 'dwell', stepId: 'watch' }))
  assert.ok(!isAdvanceEventMatch(step, { type: 'dwell', stepId: 'some-earlier-step' }))
})

// ── transitions ───────────────────────────────────────────────────────────────

test('a fresh state sits on the first step and records having reached it', () => {
  const state = initTutorialState(tutorial)
  assert.equal(state.tutorialId, 'demo')
  assert.equal(state.stepIndex, 0)
  assert.equal(state.status, TUTORIAL_STATUS.running)
  assert.deepEqual(state.visitedStepIds, ['intro'])
})

test('a fresh state can start directly at a requested step for testing and review', () => {
  const state = initTutorialState(tutorial, { stepIndex: 2 })
  assert.equal(state.stepIndex, 2)
  assert.equal(currentStep(tutorial, state).id, 'save')
  assert.deepEqual(state.visitedStepIds, ['save'])
  assert.equal(initTutorialState(tutorial, { stepIndex: 99 }).stepIndex, 3)
  assert.equal(initTutorialState(tutorial, { stepIndex: -5 }).stepIndex, 0)
})

test('Next walks forward and records each step reached', () => {
  const state = run(initTutorialState(tutorial), { type: 'next' }, { type: 'next' })
  assert.equal(state.stepIndex, 2)
  assert.deepEqual(state.visitedStepIds, ['intro', 'open-config', 'save'])
})

test('known-incompatible steps are skipped explicitly in either direction', () => {
  const withUnavailable = {
    ...tutorial,
    steps: tutorial.steps.map((step, index) => index === 1
      ? { ...step, compatibilityUnavailable: ['Target no longer exists.'] }
      : step),
  }
  const forward = reduceTutorial(withUnavailable, initTutorialState(withUnavailable), { type: 'next' })
  assert.equal(currentStep(withUnavailable, forward).id, 'save')
  assert.deepEqual(forward.compatibilitySkip, ['open-config'])
  const backward = reduceTutorial(withUnavailable, forward, { type: 'back' })
  assert.equal(currentStep(withUnavailable, backward).id, 'intro')
  assert.deepEqual(backward.compatibilitySkip, ['open-config'])
})

test('a matching event advances exactly like Next', () => {
  const start = run(initTutorialState(tutorial), { type: 'next' })
  const advanced = reduceTutorial(tutorial, start, { type: 'view', view: 'configuration' })
  assert.equal(advanced.stepIndex, 2)
  assert.equal(currentStep(tutorial, advanced).id, 'save')
})

test('an event that matches nothing returns the very same state object', () => {
  const state = initTutorialState(tutorial)
  assert.equal(reduceTutorial(tutorial, state, { type: 'signal', name: 'nothing.happened' }), state)
  assert.equal(reduceTutorial(tutorial, state, { type: 'click', anchor: 'stray' }), state)
})

test('Back walks in and does not run off the front', () => {
  const state = run(initTutorialState(tutorial), { type: 'next' }, { type: 'back' }, { type: 'back' })
  assert.equal(state.stepIndex, 0)
})

test('Back does not un-record a step that was reached', () => {
  const state = run(initTutorialState(tutorial), { type: 'next' }, { type: 'back' })
  assert.deepEqual(state.visitedStepIds, ['intro', 'open-config'])
})

test('advancing past the last step completes, staying parked on the last step', () => {
  let state = initTutorialState(tutorial)
  for (let i = 0; i < 4; i += 1) state = reduceTutorial(tutorial, state, { type: 'next' })
  assert.equal(state.status, TUTORIAL_STATUS.completed)
  assert.equal(state.stepIndex, 3)
})

test('a completed or exited tutorial ignores everything', () => {
  const exited = reduceTutorial(tutorial, initTutorialState(tutorial), { type: 'exit' })
  assert.equal(exited.status, TUTORIAL_STATUS.exited)
  assert.equal(reduceTutorial(tutorial, exited, { type: 'next' }), exited)
  assert.equal(reduceTutorial(tutorial, exited, { type: 'view', view: 'configuration' }), exited)
})

test('Skip moves on like Next — the difference is only what we call it', () => {
  const skipped = reduceTutorial(tutorial, initTutorialState(tutorial), { type: 'skip' })
  assert.equal(skipped.stepIndex, 1)
})

test('goto is clamped at both ends', () => {
  const state = initTutorialState(tutorial)
  assert.equal(reduceTutorial(tutorial, state, { type: 'goto', index: -5 }).stepIndex, 0)
  assert.equal(reduceTutorial(tutorial, state, { type: 'goto', index: 99 }).status, TUTORIAL_STATUS.completed)
})

test('progress reads the way a human counts', () => {
  assert.equal(tutorialProgressLabel(tutorial, { stepIndex: 0 }), 'Step 1 of 4')
  assert.equal(tutorialProgressLabel(tutorial, { stepIndex: 3 }), 'Step 4 of 4')
  assert.ok(isLastStep(tutorial, { stepIndex: 3 }))
  assert.ok(!isLastStep(tutorial, { stepIndex: 2 }))
})

// ── validation ────────────────────────────────────────────────────────────────

test('a sound tutorial has nothing to report', () => {
  assert.deepEqual(
    validateTutorial(tutorial, {
      knownViews: ['configuration', 'genome_browser'],
      knownAnchors: ['app-button-configuration', 'config-save'],
    }),
    []
  )
})

test('unknown views and anchors are caught, because they are typos', () => {
  const broken = {
    id: 't', title: 'T',
    steps: [{ id: 'a', title: 'A', body: 'B', view: 'gnome_browser', anchor: 'config-saev' }],
  }
  const problems = validateTutorial(broken, { knownViews: ['genome_browser'], knownAnchors: ['config-save'] })
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => p.includes('unknown view "gnome_browser"')))
  assert.ok(problems.some((p) => p.includes('unknown anchor "config-saev"')))
})

test('a selector-form anchor is exempt from the known-anchor list', () => {
  const reusing = {
    id: 't', title: 'T',
    steps: [{ id: 'a', title: 'A', body: 'B', anchor: { selector: '[data-focus-drawer]' } }],
  }
  assert.deepEqual(validateTutorial(reusing, { knownAnchors: [] }), [])
})

test('duplicate step ids are caught, since they break resume', () => {
  const dupes = {
    id: 't', title: 'T',
    steps: [{ id: 'a', title: 'A', body: 'B' }, { id: 'a', title: 'C', body: 'D' }],
  }
  assert.ok(validateTutorial(dupes).some((p) => p.includes('duplicate step id')))
})

test('a step that can never finish on its own is caught', () => {
  const stuck = {
    id: 't', title: 'T',
    steps: [{ id: 'a', title: 'A', body: 'B', advanceOn: { type: 'click' } }],
  }
  assert.ok(validateTutorial(stuck).some((p) => p.includes('advanceOn click needs an anchor')))
})

test('malformed advanceOn payloads are caught', () => {
  const bad = {
    id: 't', title: 'T',
    steps: [
      { id: 'a', title: 'A', body: 'B', advanceOn: { type: 'view' } },
      { id: 'b', title: 'B', body: 'B', advanceOn: { type: 'signal' } },
      { id: 'c', title: 'C', body: 'B', advanceOn: { type: 'dwell', ms: 0 } },
      { id: 'd', title: 'D', body: 'B', advanceOn: { type: 'telepathy' } },
    ],
  }
  const problems = validateTutorial(bad)
  assert.ok(problems.some((p) => p.includes('advanceOn view needs a view id')))
  assert.ok(problems.some((p) => p.includes('advanceOn signal needs a name')))
  assert.ok(problems.some((p) => p.includes('advanceOn dwell needs a positive ms')))
  assert.ok(problems.some((p) => p.includes('"telepathy" is not one of')))
})

test('a prefill without somewhere to type, or without text, is caught', () => {
  const bad = {
    id: 't', title: 'T',
    steps: [
      { id: 'a', title: 'A', body: 'B', prefill: { value: 'Welcome' } },
      { id: 'b', title: 'B', body: 'B', prefill: { anchor: 'search', value: 42 } },
    ],
  }
  const problems = validateTutorial(bad)
  assert.ok(problems.some((p) => p.includes('prefill needs an anchor')))
  assert.ok(problems.some((p) => p.includes('prefill needs a string value')))
})

test('an empty or titleless tutorial is rejected outright', () => {
  assert.ok(validateTutorial({ id: 'x', title: 'X', steps: [] }).some((p) => p.includes('no steps')))
  assert.ok(validateTutorial({ steps: [{ id: 'a', title: 'A', body: 'B' }] }).some((p) => p.includes('no id')))
})

test('sections are complete and non-empty once a tutorial starts using them', () => {
  const incomplete = {
    id: 'x', title: 'X', steps: [
      { id: 'a', section: 'One', title: 'A', body: 'B' },
      { id: 'b', title: 'B', body: 'B' },
    ],
  }
  assert.ok(validateTutorial(incomplete).some((problem) => problem.includes('not every step')))

  const blank = {
    id: 'x', title: 'X', steps: [{ id: 'a', section: ' ', title: 'A', body: 'B' }],
  }
  assert.ok(validateTutorial(blank).some((problem) => problem.includes('section needs')))

  const split = {
    id: 'x', title: 'X', steps: [
      { id: 'a', section: 'One', title: 'A', body: 'B' },
      { id: 'b', section: 'Two', title: 'B', body: 'B' },
      { id: 'c', section: 'One', title: 'C', body: 'B' },
    ],
  }
  assert.ok(validateTutorial(split).some((problem) => problem.includes('split into separate runs')))
})

test('deferUntilReady is a boolean structural option', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', deferUntilReady: 'eventually' }],
  }
  assert.ok(validateTutorial(malformed).some((problem) => problem.includes('deferUntilReady')))
})

test('selector list arrivals require a target and boolean layout options', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [{
      id: 'a', title: 'A', body: 'B',
      arrive: { type: 'selectorList', fitAllRows: 'yes' },
    }],
  }
  const problems = validateTutorial(malformed)
  assert.ok(problems.some((problem) => problem.includes('selectorList needs a registered target')))
  assert.ok(problems.some((problem) => problem.includes('fitAllRows must be true or false')))
  const sound = {
    id: 'x', title: 'X',
    steps: [{
      id: 'a', title: 'A', body: 'B',
      arrive: {
        type: 'selectorList', anchor: 'selector-genome-list',
        fitAllRows: true, preserveOrder: true, lockScroll: true, center: true,
      },
    }],
  }
  assert.deepEqual(validateTutorial(sound), [])
})

test('genome selection arrivals name embedded datasets, and an empty set is a real one', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [
      { id: 'a', title: 'A', body: 'B', arrive: { type: 'genomeSelection' } },
      { id: 'b', title: 'B', body: 'B', arrive: { type: 'genomeSelection', genomes: ['ok', ' '] } },
    ],
  }
  const problems = validateTutorial(malformed)
  assert.ok(problems.some((problem) => problem.includes('genomeSelection needs a genomes list')))
  assert.ok(problems.some((problem) => problem.includes('needs an embedded dataset recipe id')))

  // "Arrive with nothing selected" is what makes the step before a selection step
  // watchable a second time, so it must validate rather than read as an omission.
  const cleared = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', arrive: { type: 'genomeSelection', genomes: [] } }],
  }
  assert.deepEqual(validateTutorial(cleared), [])
  assert.deepEqual(arrivalGenomeRecipeIds({ genomes: [] }), [])
  assert.deepEqual(
    arrivalGenomeRecipeIds({ genomes: ['tmnt-leonardo-v1', { recipeId: 'tmnt-raphael-v1' }] }),
    ['tmnt-leonardo-v1', 'tmnt-raphael-v1'],
  )
  assert.deepEqual(arrivalGenomeRecipeIds({ type: 'selectorList' }), [])
})

test('an authored view position needs a target to be measured against', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [
      { id: 'a', title: 'A', body: 'B', arrive: { type: 'pageScroll', offset: 200 } },
      { id: 'b', title: 'B', body: 'B', arrive: { type: 'pageScroll', anchor: 'selector-playlist-selected', offset: 'down a bit' } },
    ],
  }
  const problems = validateTutorial(malformed)
  assert.ok(problems.some((problem) => problem.includes('pageScroll needs a registered target')))
  assert.ok(problems.some((problem) => problem.includes('pageScroll offset must be a number')))

  // Zero is a real offset — "with this target against the top of the page area" — so it
  // must survive rather than be read as an absent value.
  const framed = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', arrive: { type: 'pageScroll', anchor: 'selector-playlist-selected', offset: 0 } }],
  }
  assert.deepEqual(validateTutorial(framed), [])
  assert.equal(arrivalScrollOffset({ offset: 0 }), 0)
  assert.equal(arrivalScrollOffset({ offset: 214 }), 214)
  assert.equal(arrivalScrollOffset({}), 0)
  assert.equal(arrivalScrollOffset({ offset: 'nope' }), 0)
})

test('a centred view position is a different instruction from an offset one', () => {
  // Centring is for a control that has to be pressed; an offset composes a picture. A step
  // asking for both has not decided which it wants, and the runtime would have to pick.
  const centred = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', arrive: { type: 'pageScroll', anchor: 'manual-add-genome', center: true } }],
  }
  assert.deepEqual(validateTutorial(centred), [])

  const confused = {
    id: 'x', title: 'X',
    steps: [
      { id: 'a', title: 'A', body: 'B', arrive: { type: 'pageScroll', anchor: 'manual-add-genome', center: true, offset: 620 } },
      { id: 'b', title: 'B', body: 'B', arrive: { type: 'pageScroll', anchor: 'manual-add-genome', center: 'yes' } },
    ],
  }
  const problems = validateTutorial(confused)
  assert.ok(problems.some((problem) => problem.includes('centred or placed at an offset')))
  assert.ok(problems.some((problem) => problem.includes('pageScroll center must be true or false')))

  assert.equal(arrivalScrollCenter({ center: true }), true)
  assert.equal(arrivalScrollCenter({ center: false }), false)
  assert.equal(arrivalScrollCenter({ offset: 620 }), false)
  assert.equal(arrivalScrollCenter({}), false)
})

test('a dialog arrival names a known dialog, and closing it is one of them', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [
      { id: 'a', title: 'A', body: 'B', arrive: { type: 'dialog' } },
      { id: 'b', title: 'B', body: 'B', arrive: { type: 'dialog', dialog: 'somethingElse' } },
    ],
  }
  const problems = validateTutorial(malformed)
  assert.equal(problems.filter((problem) => problem.includes('dialog needs one of')).length, 2)

  // The step that opens a dialog has to be able to say "closed", or coming Back to it
  // leaves the dialog over the control the reader is being asked to press.
  const closed = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', arrive: { type: 'dialog', dialog: 'none' } }],
  }
  assert.deepEqual(validateTutorial(closed), [])
  assert.equal(arrivalDialog({ dialog: 'playlistMembership' }), 'playlistMembership')
  assert.equal(arrivalDialog({ dialog: 'playlistPopover' }), 'playlistPopover')
  assert.equal(arrivalDialog({ dialog: 'none' }), 'none')
  assert.equal(arrivalDialog({ dialog: '' }), '')
})

test('a playlists arrival names the playlists the tutorial itself created', () => {
  const malformed = {
    id: 'x', title: 'X',
    steps: [
      { id: 'a', title: 'A', body: 'B', arrive: { type: 'playlists' } },
      { id: 'b', title: 'B', body: 'B', arrive: { type: 'playlists', playlists: [{ description: 'no name' }] } },
      {
        id: 'c', title: 'C', body: 'B',
        arrive: { type: 'playlists', playlists: [{ name: 'Turtles' }], selected: 'Not turtles' },
      },
    ],
  }
  const problems = validateTutorial(malformed)
  assert.ok(problems.some((problem) => problem.includes('playlists needs a list')))
  assert.ok(problems.some((problem) => problem.includes('every playlist needs the name')))
  assert.ok(problems.some((problem) => problem.includes('"Not turtles" is not one of the playlists')))

  // Empty is the real instruction that makes the step before a creation step re-watchable:
  // going Back genuinely returns to before the playlist existed.
  const before = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', arrive: { type: 'playlists', playlists: [] } }],
  }
  assert.deepEqual(validateTutorial(before), [])

  assert.deepEqual(
    arrivalPlaylists({ playlists: [{ name: ' Turtles ', description: ' Four ', genomes: ['tmnt-leonardo-v1', { recipeId: 'tmnt-raphael-v1' }, ' '] }] }),
    [{ name: 'Turtles', description: 'Four', genomes: ['tmnt-leonardo-v1', 'tmnt-raphael-v1'] }],
  )
  assert.deepEqual(arrivalPlaylists({ playlists: [{ description: 'unnamed' }] }), [])
  assert.equal(arrivalSelectedPlaylist({ selected: ' Turtles ' }), 'Turtles')
  assert.equal(arrivalSelectedPlaylist({}), '')
})

test('manual card positions are normalized so they survive viewport changes', () => {
  assert.deepEqual(stepCardPosition({ cardPosition: { x: 0.25, y: 0.8 } }), { x: 0.25, y: 0.8 })
  assert.equal(stepCardPosition({ cardPosition: { x: 30, y: -4 } }), null)
  const malformed = {
    id: 'x', title: 'X',
    steps: [{ id: 'a', title: 'A', body: 'B', cardPosition: { x: 2, y: 0.5 } }],
  }
  assert.ok(validateTutorial(malformed).some((problem) => problem.includes('cardPosition')))
})

test('manual card dimensions may fix either edge without requiring both', () => {
  assert.deepEqual(stepCardSize({ cardSize: { width: 440 } }), { width: 440 })
  assert.deepEqual(stepCardSize({ cardSize: { height: 260 } }), { height: 260 })
  assert.deepEqual(stepCardSize({ cardSize: { width: 440, height: 260 } }), { width: 440, height: 260 })
  assert.equal(stepCardSize({ cardSize: { width: -1 } }), null)
})

test('Next cannot advance twice when the action it performed already advanced the step', () => {
  // Pressing Next on "open Configuration" navigates, which is what that step was waiting
  // for. The follow-up must be ignored, or the step after it is skipped unseen.
  const start = run(initTutorialState(tutorial), { type: 'next' })
  assert.equal(currentStep(tutorial, start).id, 'open-config')

  const afterNavigate = reduceTutorial(tutorial, start, { type: 'view', view: 'configuration' })
  assert.equal(currentStep(tutorial, afterNavigate).id, 'save')

  const stale = reduceTutorial(tutorial, afterNavigate, { type: 'next', fromStepId: 'open-config' })
  assert.equal(stale, afterNavigate, 'a Next from a step we have left is ignored')
})

test('an untagged Next still advances, and a matching one advances once', () => {
  const state = initTutorialState(tutorial)
  assert.equal(reduceTutorial(tutorial, state, { type: 'next' }).stepIndex, 1)
  assert.equal(reduceTutorial(tutorial, state, { type: 'next', fromStepId: 'intro' }).stepIndex, 1)
})

test('a card value can name the field it belongs in', () => {
  const step = { id: 's', title: 'T', body: 'B', copy: '1:100-200', copyInto: 'browser-location-search' }
  assert.equal(stepCopyTarget(step), 'browser-location-search')
  // Only alongside a value: there is nothing to put anywhere without one.
  assert.equal(stepCopyTarget({ ...step, copy: '' }), '')
  assert.equal(stepCopyTarget({ id: 's' }), '')
  // The plain clipboard chip is unchanged.
  assert.equal(stepCopyTarget({ ...step, copyInto: undefined }), '')
})

test('a field to fill has to exist, and has to have something to fill it with', () => {
  const known = { knownViews: ['genome_browser'], knownAnchors: ['browser-location-search'] }
  const withValue = {
    id: 't', title: 'T', steps: [{
      id: 's', title: 'T', body: 'B', view: 'genome_browser',
      copy: '1:100-200', copyInto: 'browser-location-serch',
    }],
  }
  assert.ok(validateTutorial(withValue, known).some((p) => p.includes('unknown anchor "browser-location-serch"')))

  const withoutValue = {
    id: 't', title: 'T', steps: [{
      id: 's', title: 'T', body: 'B', view: 'genome_browser',
      copyInto: 'browser-location-search',
    }],
  }
  assert.ok(validateTutorial(withoutValue, known).some((p) => p.includes('offers no copy value')))
})

test('one gene\'s transcripts are a different control from the window-wide expand', () => {
  const known = { knownViews: ['genome_browser'], knownAnchors: [] }
  const step = (geneTranscripts) => ({
    id: 't', title: 'T', steps: [{
      id: 's', title: 'T', body: 'B', view: 'genome_browser',
      arrive: { type: 'browserControls', geneTranscripts },
    }],
  })
  assert.deepEqual(validateTutorial(step({ gene: 'ENSG1', expanded: true }), known), [])
  assert.ok(validateTutorial(step({ expanded: true }), known).some((p) => p.includes('needs a gene id')))
  assert.ok(validateTutorial(step({ gene: 'ENSG1' }), known).some((p) => p.includes('must be true or false')))
  // And it counts as naming a control, so a step setting only this is not "names nothing".
  assert.deepEqual(
    validateTutorial(step({ gene: 'ENSG1', expanded: false }), known).filter((p) => p.includes('names no control')),
    []
  )
})

test('the gene-class filter takes a shorthand or an explicit set', () => {
  const known = { knownViews: ['genome_browser'], knownAnchors: [] }
  const withBiotypes = (biotypes) => ({
    id: 't', title: 'T', steps: [{
      id: 's', title: 'T', body: 'B', view: 'genome_browser',
      arrive: { type: 'browserControls', biotypes },
    }],
  })
  assert.deepEqual(validateTutorial(withBiotypes('all'), known), [])
  assert.deepEqual(validateTutorial(withBiotypes('protein-coding'), known), [])
  // The set a step leaves behind when the window holds only two of the four classes.
  assert.deepEqual(validateTutorial(withBiotypes(['proteinCoding', 'pseudogene']), known), [])
  assert.deepEqual(validateTutorial(withBiotypes([]), known), [])
  assert.ok(validateTutorial(withBiotypes(['proteinCoding', 'lncRNAs']), known)
    .some((p) => p.includes('unknown gene class lncRNAs')))
  assert.ok(validateTutorial(withBiotypes('coding-only'), known)
    .some((p) => p.includes('must be one of')))
})

test("a hidden transcript is a state a step can arrive in", () => {
  const known = { knownViews: ['genome_browser'], knownAnchors: [] }
  const step = (hiddenTranscript) => ({
    id: 't', title: 'T', steps: [{
      id: 's', title: 'T', body: 'B', view: 'genome_browser',
      arrive: { type: 'browserControls', hiddenTranscript },
    }],
  })
  assert.deepEqual(validateTutorial(step({ transcript: 'ENST1', hidden: true }), known), [])
  assert.deepEqual(validateTutorial(step({ transcript: 'ENST1', hidden: false }), known), [])
  assert.ok(validateTutorial(step({ hidden: true }), known).some((p) => p.includes('needs a transcript id')))
  assert.ok(validateTutorial(step({ transcript: 'ENST1' }), known).some((p) => p.includes('must be true or false')))
})


test('the Track Manager is a state a step can arrive in', () => {
  const known = { knownViews: ['track_manager'], knownAnchors: [] }
  const step = (arrive) => ({
    id: 't', title: 'T', steps: [{ id: 's', title: 'T', body: 'B', view: 'track_manager', arrive }],
  })

  // The shape the tutorial actually authors.
  assert.deepEqual(validateTutorial(step({
    type: 'trackRegistry', registered: ['expression'], wizard: 'details',
    file: 'demo:atac', fields: { label: 'ATAC-seq peaks' }, dataType: 'atac_seq', genome: 'slice',
  }), known), [])

  // Nothing registered yet is a real instruction, not an omission.
  assert.deepEqual(validateTutorial(step({ type: 'trackRegistry', registered: [] }), known), [])

  // A path from the author's machine is the mistake worth naming.
  assert.ok(validateTutorial(step({ type: 'trackRegistry', file: '/Users/me/atac.bw', wizard: 'details' }), known)
    .some((p) => p.includes('not a path from this machine')))
  assert.ok(validateTutorial(step({ type: 'trackRegistry', registered: ['methylation'] }), known)
    .some((p) => p.includes('does not know the track "methylation"')))
  assert.ok(validateTutorial(step({ type: 'trackRegistry', wizard: 'details', dataType: 'rna_seq' }), known)
    .some((p) => p.includes('names no file to describe')))
  assert.ok(validateTutorial(step({ type: 'trackRegistry', wizard: 'closed', file: 'demo:expression' }), known)
    .some((p) => p.includes('wizard fields while the wizard is closed')))
})

test('which custom tracks a panel shows is a state a step can arrive in', () => {
  const known = { knownViews: ['genome_browser'], knownAnchors: [] }
  const step = (arrive) => ({
    id: 't', title: 'T', steps: [{ id: 's', title: 'T', body: 'B', view: 'genome_browser', arrive }],
  })

  assert.deepEqual(validateTutorial(step({
    type: 'browserTracks', picker: 'closed', added: ['expression', 'atac', 'variants'],
  }), known), [])
  assert.deepEqual(validateTutorial(step({ type: 'browserTracks', picker: 'open', chosen: [] }), known), [])

  assert.ok(validateTutorial(step({ type: 'browserTracks', added: ['coverage'] }), known)
    .some((p) => p.includes('does not know the track "coverage"')))
  // Choosing happens inside the picker, so a shut picker holding a selection describes
  // something nobody can see.
  assert.ok(validateTutorial(step({ type: 'browserTracks', picker: 'closed', chosen: ['atac'] }), known)
    .some((p) => p.includes('chooses tracks while the picker is closed')))
})

test('a tutorial that states the Track Manager needs the demo tracks laid down', () => {
  const withArrive = (arrive) => ({ id: 't', title: 'T', steps: [{ id: 's', title: 'T', body: 'B', arrive }] })

  assert.equal(tutorialNeedsDemoTracks(withArrive({ type: 'trackRegistry', registered: [] })), true)
  assert.equal(tutorialNeedsDemoTracks(withArrive({ type: 'browserTracks', added: ['atac'] })), true)
  // Every other tutorial copies nothing.
  assert.equal(tutorialNeedsDemoTracks(withArrive({ type: 'browserView', locus: '1:1-2' })), false)
  assert.equal(tutorialNeedsDemoTracks({ id: 't', title: 'T', steps: [] }), false)
})
