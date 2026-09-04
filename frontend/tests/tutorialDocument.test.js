import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyseTutorialCompatibility,
  createTutorialDocument,
  legacyTutorialToDocument,
  materializeTutorialDocument,
  nextDraftStep,
  setTutorialDatasetActivation,
  tutorialDatasetStartsActive,
  validateTutorialDocument,
} from '../src/utils/tutorialDocument.js'

const firstStep = {
  id: 'search',
  section: 'Finding data',
  view: 'download',
  title: 'Search',
  body: 'Search for a genome.',
  spotlight: { target: { id: 'download.search', version: 1 } },
  interactionPolicy: {
    targets: [{ target: { id: 'download.search', version: 1 }, capabilities: ['input'] }],
  },
  cardPosition: { x: 0.1, y: 0.2 },
}

test('a new step starts from the previous step without replaying its action', () => {
  const document = createTutorialDocument({ id: 'test', steps: [firstStep] })
  const next = nextDraftStep(document)
  assert.equal(next.section, firstStep.section)
  assert.equal(next.view, firstStep.view)
  assert.deepEqual(next.cardPosition, firstStep.cardPosition)
  assert.equal(next.action.type, 'none')
  assert.equal(next.autoplay, undefined)
  assert.equal(next.advanceOn.type, 'manual')
  assert.notEqual(next.id, firstStep.id)
})

test('portable documents use target references and materialize to runtime anchors', () => {
  const document = createTutorialDocument({ id: 'test', steps: [firstStep] })
  assert.deepEqual(validateTutorialDocument(document), [])
  assert.equal(materializeTutorialDocument(document).steps[0].anchor, 'download-search')
})

test('large region targets carry their settled presentation policy into playback', () => {
  const document = createTutorialDocument({
    id: 'test',
    steps: [{
      id: 'genome-list',
      view: 'genome_selector',
      title: 'Genome list',
      body: 'Look at the available genomes.',
      spotlight: { target: { id: 'selector.genomeList', version: 1 } },
      advanceOn: { type: 'manual' },
    }],
  })
  const [runtimeStep] = materializeTutorialDocument(document).steps
  assert.equal(runtimeStep.anchor, 'selector-genome-list')
  assert.equal(runtimeStep.anchorScroll, 'center')
  assert.equal(runtimeStep.deferUntilReady, true)
})

test('multiple highlighted rows and all-click completion materialize together', () => {
  const row = (speciesKey) => ({ id: 'selector.genome', version: 1, params: { speciesKey } })
  const checkbox = (speciesKey) => ({ id: 'selector.checkbox', version: 1, params: { speciesKey } })
  const document = createTutorialDocument({
    id: 'turtles',
    steps: [{
      id: 'select-turtles',
      view: 'genome_selector',
      title: 'Select the turtles',
      body: 'Activate all four turtle genomes.',
      spotlight: { target: row('turtle-one') },
      reveals: ['turtle-two', 'turtle-three', 'turtle-four'].map((key) => ({ target: row(key), ring: true })),
      interactionPolicy: {
        targets: ['turtle-one', 'turtle-two', 'turtle-three', 'turtle-four'].map((key) => ({
          target: checkbox(key), capabilities: ['activate'],
        })),
      },
      advanceOn: {
        type: 'all-clicks',
        targets: ['turtle-one', 'turtle-two', 'turtle-three', 'turtle-four'].map(checkbox),
      },
      holdMs: 650,
    }],
  })
  assert.deepEqual(validateTutorialDocument(document), [])
  const [step] = materializeTutorialDocument(document).steps
  assert.equal(step.anchor, 'selector-genome-turtle-one')
  assert.deepEqual(step.reveals.map((reveal) => reveal.anchor), [
    'selector-genome-turtle-two', 'selector-genome-turtle-three', 'selector-genome-turtle-four',
  ])
  assert.ok(step.reveals.every((reveal) => reveal.ring))
  assert.deepEqual(step.advanceOn.anchors, [
    'selector-checkbox-turtle-one', 'selector-checkbox-turtle-two',
    'selector-checkbox-turtle-three', 'selector-checkbox-turtle-four',
  ])
  assert.equal(step.holdMs, 650)
})

test('a fixed Genome Selector list is framed without becoming highlighted or interactive', () => {
  const document = createTutorialDocument({
    id: 'fixed-selector',
    steps: [{
      id: 'select-turtles',
      view: 'genome_selector',
      title: 'Select the turtles',
      body: 'Activate all four turtle genomes.',
      arrive: {
        type: 'selectorList',
        target: { id: 'selector.genomeList', version: 1 },
        fitAllRows: true,
        preserveOrder: true,
        lockScroll: true,
        center: true,
      },
      advanceOn: { type: 'manual' },
    }],
  })
  assert.deepEqual(validateTutorialDocument(document), [])
  const [step] = materializeTutorialDocument(document).steps
  assert.deepEqual(step.arrive, {
    type: 'selectorList',
    anchor: 'selector-genome-list',
    fitAllRows: true,
    preserveOrder: true,
    lockScroll: true,
    center: true,
  })
  assert.equal(step.deferUntilReady, true)
  assert.equal(step.anchor, undefined)
  assert.equal(step.interactionPolicy, undefined)
})

test('a step can arrive with the tutorial genomes already selected', () => {
  const datasets = [
    { id: 'embedded:tmnt-leonardo-v1@1', recipeId: 'tmnt-leonardo-v1', embedded: true, autoActivate: false, label: 'Green sea turtle (Leonardo)' },
    { id: 'embedded:tmnt-raphael-v1@1', recipeId: 'tmnt-raphael-v1', embedded: true, autoActivate: false, label: 'Loggerhead turtle (Raphael)' },
  ]
  const step = {
    id: 'the-pills-bar',
    view: 'genome_selector',
    title: 'Your selected genomes',
    body: 'They appear in the strip at the top.',
    spotlight: { target: { id: 'app.genomePills', version: 1 } },
    arrive: { type: 'genomeSelection', genomes: ['tmnt-leonardo-v1', 'tmnt-raphael-v1'] },
    advanceOn: { type: 'manual' },
  }
  const document = createTutorialDocument({ id: 'pills', datasets, steps: [step] })
  assert.deepEqual(validateTutorialDocument(document), [])
  assert.equal(analyseTutorialCompatibility(document).compatible, true)

  // The arrival carries no target, so materializing must leave it exactly as authored.
  const [runtimeStep] = materializeTutorialDocument(document).steps
  assert.deepEqual(runtimeStep.arrive, step.arrive)

  // Detaching a genome the step selects is reported against that step rather than
  // silently selecting one genome fewer.
  const detached = createTutorialDocument({ id: 'pills', datasets: [datasets[0]], steps: [step] })
  const report = analyseTutorialCompatibility(detached)
  assert.equal(report.compatible, false)
  assert.ok(report.unavailableSteps['the-pills-bar'].some((reason) => reason.includes('tmnt-raphael-v1')))
})

test('an authored view position travels as a target and defers the card', () => {
  const document = createTutorialDocument({
    id: 'framed',
    steps: [{
      id: 'add-to-a-playlist',
      view: 'genome_selector',
      title: 'Add them to a playlist',
      body: 'Press the playlist button above the list.',
      spotlight: { target: { id: 'selector.addSelectedToPlaylist', version: 1 } },
      arrive: [
        { type: 'pageScroll', target: { id: 'selector.addSelectedToPlaylist', version: 1 }, offset: 214 },
      ],
      advanceOn: { type: 'manual' },
    }],
  })
  assert.deepEqual(validateTutorialDocument(document), [])
  assert.equal(analyseTutorialCompatibility(document).compatible, true)

  const [step] = materializeTutorialDocument(document).steps
  assert.deepEqual(step.arrive, [{ type: 'pageScroll', anchor: 'selector-playlist-selected', offset: 214 }])
  // The page is still moving when the step lands, so the spotlight must not be struck
  // around wherever its target happens to be passing.
  assert.equal(step.deferUntilReady, true)

  // A view position names a target, so removing that target has to report against the
  // step rather than leaving it framing nothing.
  const orphaned = createTutorialDocument({
    id: 'framed',
    steps: [{
      id: 'gone',
      view: 'genome_selector',
      title: 'Gone',
      body: 'B',
      arrive: [{ type: 'pageScroll', target: { id: 'selector.removed', version: 1 }, offset: 10 }],
      advanceOn: { type: 'manual' },
    }],
  })
  assert.equal(analyseTutorialCompatibility(orphaned).compatible, false)
})

test('a step can arrive with the playlist dialog open or closed', () => {
  const document = createTutorialDocument({
    id: 'dialog',
    steps: [
      {
        id: 'press-the-button',
        view: 'genome_selector',
        title: 'Press it',
        body: 'B',
        arrive: { type: 'dialog', dialog: 'none' },
        advanceOn: { type: 'manual' },
      },
      {
        id: 'the-dialog',
        view: 'genome_selector',
        title: 'The dialog',
        body: 'B',
        spotlight: { target: { id: 'selector.playlistDialog', version: 1 } },
        arrive: { type: 'dialog', dialog: 'playlistMembership' },
        advanceOn: { type: 'manual' },
      },
    ],
  })
  assert.deepEqual(validateTutorialDocument(document), [])
  assert.equal(analyseTutorialCompatibility(document).compatible, true)

  // No target to resolve, so materializing leaves both arrivals as authored — and the
  // dialog step is not deferred on account of a state change that moves nothing.
  const [opener, dialogStep] = materializeTutorialDocument(document).steps
  assert.deepEqual(opener.arrive, { type: 'dialog', dialog: 'none' })
  assert.deepEqual(dialogStep.arrive, { type: 'dialog', dialog: 'playlistMembership' })
  assert.equal(dialogStep.anchor, 'playlist-membership-dialog')
})

test('compatibility isolates missing targets to their steps', () => {
  const document = createTutorialDocument({
    id: 'test',
    steps: [firstStep, {
      ...firstStep,
      id: 'gone',
      spotlight: { target: { id: 'download.removed', version: 1 } },
    }],
  })
  const report = analyseTutorialCompatibility(document)
  assert.equal(report.runnable, true)
  assert.equal(report.runnableStepCount, 1)
  assert.ok(report.unavailableSteps.gone.some((reason) => reason.includes('not available') || reason.includes('Unknown')))
})

test('portable documents reject selectors and absolute local paths', () => {
  const document = createTutorialDocument({ id: 'test', steps: [{
    ...firstStep,
    selector: '#brittle',
    copy: '/Users/someone/private.fa',
  }] })
  const problems = validateTutorialDocument(document)
  assert.ok(problems.some((problem) => problem.includes('selector')))
  assert.ok(problems.some((problem) => problem.includes('absolute local path')))
  assert.equal(analyseTutorialCompatibility(document).runnable, false)
})

test('tutorial dataset startup activation supports all, none and individual genomes', () => {
  const datasets = [
    { id: 'embedded:leo@1', recipeId: 'leo', embedded: true },
    { id: 'embedded:mikey@1', recipeId: 'mikey', embedded: true, autoActivate: false },
    { id: 'builtin:demo@1', embedded: false },
  ]
  assert.equal(tutorialDatasetStartsActive(datasets[0]), true, 'omitted flag preserves the historic active default')
  assert.equal(tutorialDatasetStartsActive(datasets[1]), false)

  const none = setTutorialDatasetActivation(datasets, false)
  assert.deepEqual(none.map(tutorialDatasetStartsActive), [false, false, true])
  assert.equal(none[2], datasets[2], 'external datasets are not changed')

  const custom = setTutorialDatasetActivation(none, true, 'mikey')
  assert.deepEqual(custom.map(tutorialDatasetStartsActive), [false, true, true])
})

test('a card value can be authored to fill a field rather than the clipboard', () => {
  const document = createTutorialDocument({
    id: 'copying', title: 'Copying',
    steps: [{
      id: 'search', title: 'Search', body: 'Paste it in.', view: 'genome_browser',
      copy: '1:100-200',
      copyTarget: { id: 'browser.locationSearch', version: 1 },
      spotlight: { target: { id: 'browser.locationSearchField', version: 1 } },
    }],
  })
  const runtime = materializeTutorialDocument(document)
  assert.equal(runtime.steps[0].copyInto, 'browser-location-search')
  assert.equal(runtime.steps[0].copyTarget, undefined)
  assert.deepEqual(validateTutorialDocument(document), [])

  // And back, so the rollback definition and the document say the same thing.
  const { format: _format, schemaVersion: _schemaVersion, ...asLegacy } = runtime
  const roundTripped = legacyTutorialToDocument(asLegacy, {
    createdAt: document.createdAt, updatedAt: document.updatedAt,
  })
  assert.deepEqual(roundTripped.steps[0].copyTarget, { id: 'browser.locationSearch', version: 1 })
  assert.equal(roundTripped.steps[0].copyInto, undefined)
})

test('a legacy step lighting a region names the controls inside it', () => {
  // A region has no capability of its own, so deriving the policy from the spotlight
  // would call the step look-only and dim the button the reader is being asked to press.
  const converted = legacyTutorialToDocument({
    id: 'region', title: 'Region',
    steps: [{
      id: 'search', title: 'Search', body: 'Use it.', view: 'genome_browser',
      anchor: 'browser-location-search-field',
      allow: [
        { anchor: 'browser-location-search', capability: 'input' },
        { anchor: 'browser-location-search-go', capability: 'activate' },
      ],
    }],
  })
  assert.deepEqual(converted.steps[0].interactionPolicy.targets, [
    { target: { id: 'browser.locationSearch', version: 1 }, capabilities: ['input'] },
    { target: { id: 'browser.locationSearchGo', version: 1 }, capabilities: ['activate'] },
  ])
  assert.equal(converted.steps[0].allow, undefined)
  assert.deepEqual(analyseTutorialCompatibility(converted).fatal, [])
})
