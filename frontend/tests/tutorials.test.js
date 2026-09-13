// Guards for the tutorial definitions themselves.
//
// The valuable one is the last: every anchor a tutorial points at is checked against the
// data-tour-id attributes that actually exist in the components. A tutorial whose anchor
// has been renamed out from under it would otherwise fail silently at the one moment it
// matters — in front of a new user, on their first run.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { TUTORIALS, getTutorial } from '../src/tutorials/index.js'
import gettingStarted from '../src/tutorials/gettingStarted.js'
import browserInDepth from '../src/tutorials/browserInDepth.js'
import { TBX15 } from '../src/tutorials/sliceGenome.js'
import { DEMO_SPECIES_KEY } from '../src/tutorials/demoGenome.js'
import {
  SLICE_ASSEMBLY,
  SLICE_DISPLAY_NAME,
  SLICE_GENOME_ID,
  SLICE_SCIENTIFIC_NAME,
  SLICE_SPECIES_KEY,
  SLICE_WHOLE_REGION,
  REG4,
  TBX15_SEQUENCE_REGION,
} from '../src/tutorials/sliceGenome.js'
import { DATA_VIEW_BUTTON_IDS, APP_BUTTON_META } from '../src/appButtonConfig.js'
import {
  ACTION_TYPES,
  actionAnchors,
  stepAction,
  stepIsInteractive,
  stepPreconditions,
  arrivalsFor,
  arrivalScrollCenter,
  stepArrivals,
  stepCopyValue,
  stepUndo,
  tutorialAnchorIds,
  validateTutorial,
  TRACK_FILENAMES,
  stepAdvance,
  anchorSelector,
} from '../src/utils/tutorialModel.js'

const srcDir = new URL('../src/', import.meta.url)

function readAll(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) readAll(child, files)
    else if (/\.(jsx?|css)$/.test(entry.name)) files.push(readFileSync(child, 'utf8'))
  }
  return files
}

const sources = readAll(srcDir)
const allSource = sources.join('\n')

/** Every data-tour-id the app can actually render.
 *
 *  Two forms count. The attribute itself, where a template literal is reduced to its
 *  prefix so `app-button-${buttonId}` is understood as covering the whole family; and a
 *  `tourId` prop — or a qualified one such as `browseTourId` — which is how an anchor is
 *  threaded into a shared subcomponent that several callers anchor differently
 *  (PathInput, CollapsibleSection, ManualPathRow). */
function declaredAnchors() {
  const literals = new Set()
  const prefixes = []
  for (const match of allSource.matchAll(/data-tour-id=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    if (match[1]) literals.add(match[1])
    else prefixes.push(match[2].replace(/\$\{[^}]*\}.*$/, ''))
  }
  // An anchor bound only in one state is bound conditionally, and that condition is what
  // makes the anchor mean the state: `app-playlist-popover` exists only while the popover
  // is open, so a step naming it cannot ring one that is mounted but invisible. Those
  // bindings are ordinary expressions rather than a bare string, so the names quoted
  // inside one count as declared too.
  for (const match of allSource.matchAll(/data-tour-id=\{([^{}]*)\}/g)) {
    for (const quoted of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
      literals.add(quoted[1] || quoted[2])
    }
  }
  // `tourId`, and the qualified spellings a subcomponent needs when it anchors more than
  // one of its own elements — `analyseTourId`, `browseTourId` on the manual-add path rows,
  // where one component is rendered three times and each copy needs three distinct ids.
  // The property that matters is unchanged: every id is still a literal written at the
  // call site, which is what makes it visible here at all.
  for (const match of allSource.matchAll(/\b\w*[Tt]ourId="([^"]+)"/g)) literals.add(match[1])
  return { literals, prefixes }
}

const { literals, prefixes } = declaredAnchors()
const knownViews = DATA_VIEW_BUTTON_IDS.map((id) => APP_BUTTON_META[id].viewId)

const anchorExists = (anchor) => literals.has(anchor) || prefixes.some((p) => p && anchor.startsWith(p))

test('every registered tutorial has a unique id and is reachable by it', () => {
  const ids = TUTORIALS.map((tutorial) => tutorial.id)
  assert.equal(new Set(ids).size, ids.length, 'tutorial ids must be unique')
  for (const id of ids) assert.equal(getTutorial(id)?.id, id)
  assert.equal(getTutorial('no-such-tutorial'), null)
  assert.equal(getTutorial(''), null)
})

test('every registered tutorial is structurally sound', () => {
  for (const tutorial of TUTORIALS) {
    assert.deepEqual(validateTutorial(tutorial, { knownViews }), [], `${tutorial.id} has problems`)
  }
})

test('every anchor a tutorial points at exists in the components', () => {
  for (const tutorial of TUTORIALS) {
    for (const anchor of tutorialAnchorIds(tutorial)) {
      assert.ok(anchorExists(anchor), `${tutorial.id} points at "${anchor}", which nothing renders`)
    }
  }
})

test('every app button is anchored, so a step can point at any app', () => {
  assert.ok(
    /data-tour-id=\{`app-button-\$\{buttonId\}`\}/.test(allSource),
    'the app bar should anchor its buttons by id, covering every app in one place'
  )
})

test('Getting Started covers the four apps it promises, in order', () => {
  const views = []
  for (const step of gettingStarted.steps) {
    if (step.view && views[views.length - 1] !== step.view) views.push(step.view)
  }
  assert.deepEqual(views, ['configuration', 'download', 'genome_selector', 'genome_browser'])
})

test('Getting Started groups its workflow into task-oriented sections', () => {
  const runs = []
  for (const step of gettingStarted.steps) {
    if (runs.at(-1)?.title !== step.section) runs.push({ title: step.section, ids: [] })
    runs.at(-1).ids.push(step.id)
  }

  assert.deepEqual(runs.map((run) => run.title), [
    'Intro',
    'Download a genome',
    'Activate a genome',
    'The Genome Browser',
    'Find and inspect a gene',
  ])
  assert.deepEqual(runs.map((run) => run.ids[0]), [
    'welcome', 'open-download', 'open-selector', 'open-browser', 'browser-search',
  ])
})

test('Getting Started waits for real events rather than just asking nicely', () => {
  // A tutorial made entirely of Next buttons teaches nothing, so hold the line on the
  // steps that should register that the user (or the tutorial) actually did the thing.
  const byId = Object.fromEntries(gettingStarted.steps.map((step) => [step.id, step]))
  assert.equal(byId['download-start'].advanceOn.name, 'demoGenome.installed')
  assert.equal(byId['activate-demo'].advanceOn.name, 'genome.activated')
})

test('no step asks the user to save the configuration, because it saves itself', () => {
  // The app autosaves, and a tutorial cannot write to the real config anyway, so a step
  // waiting on a save would hang forever.
  for (const step of gettingStarted.steps) {
    assert.notEqual(step.advanceOn?.name, 'config.saved', `${step.id} waits on a save that never comes`)
  }
  assert.equal(gettingStarted.steps.some((step) => step.id === 'config-saving'), false)
})

test('steps that only point something out cannot be clicked through', () => {
  const byId = Object.fromEntries(gettingStarted.steps.map((step) => [step.id, step]))
  for (const id of ['output-dir', 'download-file-types', 'download-demo', 'browser-drawer']) {
    assert.equal(stepIsInteractive(byId[id]), false, `${id} should be look-only`)
  }
})

test('every step can be performed by the tutorial itself', () => {
  // Autoplay, and the promise that Next always does the thing, both rest on this.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      const action = stepAction(step)
      assert.ok(ACTION_TYPES.includes(action.type), `${tutorial.id}/${step.id} has an unusable action`)
      if (step.advanceOn?.type === 'view') {
        // An anchored step clicks its app button, so the tutorial's cursor can be seen
        // doing what the user would have done; the view rides along as the fallback for
        // when that button is not on screen to be clicked.
        assert.equal(action.type, step.anchor ? 'click' : 'navigate', `${tutorial.id}/${step.id} action`)
        assert.equal(action.view, step.advanceOn.view)
      }
    }
  }
})

test('every step the user must act on has something Next can do', () => {
  // The download step was silently exempt from this for a while: its advance is a signal,
  // which infers no action, so Next moved past it without ever pressing the button the
  // step was about. A step that points at something usable must be able to use it. The
  // same trap is waiting for any future advance type that infers nothing, which is why
  // this runs over every tutorial rather than the first one.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      if (!step.anchor || step.interactive === false || step.advanceOn?.type === 'manual') continue
      assert.notEqual(stepAction(step).type, 'none', `${tutorial.id}/${step.id} has nothing for Next to do`)
    }
  }
})

test('the steps that need a genome say so, so skipping cannot strand them', () => {
  const byId = Object.fromEntries(gettingStarted.steps.map((step) => [step.id, step]))
  assert.deepEqual(stepPreconditions(byId['open-browser']), ['demo-genome-installed', 'demo-genome-active'])
  assert.deepEqual(stepPreconditions(byId['browser-search']), ['demo-genome-installed', 'demo-genome-active'])
  assert.ok(stepPreconditions(byId['activate-demo']).includes('demo-genome-installed'))
})

test('every step after the download can stand on its own', () => {
  // If a user skips everything, each later step must still bring about what it needs.
  const steps = gettingStarted.steps
  const downloadIndex = steps.findIndex((step) => step.id === 'download-start')
  for (const step of steps.slice(downloadIndex + 1)) {
    if (step.view === 'genome_browser' || step.view === 'genome_selector') {
      assert.ok(
        stepPreconditions(step).length > 0,
        `${step.id} depends on the download but does not say so`
      )
    }
  }
})

test('every browser step names the genome it needs', () => {
  // Skip is always available, so a browser step can be the first one a user sees. Without
  // a precondition it would arrive at an empty browser and sit there.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      if (step.view !== 'genome_browser') continue
      // Three ways to say it, and a `customGenome` arrival is the third: a tutorial whose
      // genome the reader builds from files on disk has no precondition to name and no
      // recipe to list, so it says "this genome is registered and active" instead.
      assert.ok(
        stepPreconditions(step).length > 0
          || arrivalsFor(tutorial, step).some((a) => a.type === 'browserScene' && a.active?.length)
          || arrivalsFor(tutorial, step).some((a) => a.type === 'customGenome' && a.registered),
        `${tutorial.id}/${step.id} browses without saying which genome it needs`
      )
    }
  }
})

test('every step that changes the browser can put it back', () => {
  // Back is the first thing anyone presses when they miss something, and pressing Next
  // again has to redo the step rather than do it a second time on top of itself. So a
  // step that changes the browser must also declare the state it expects to find, which
  // the runtime establishes on every arrival — forwards or backwards.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      const action = stepAction(step)
      if (action.type !== 'browserControls' && action.type !== 'browserView') continue
      const arrivals = stepArrivals(step)
      assert.ok(
        arrivals.some((entry) => entry.type === action.type),
        `${tutorial.id}/${step.id} moves the browser but does not say where it starts`
      )
    }
  }
})

test('every browser step says which view it expects to find', () => {
  // Zooming and expanding transcripts change how tall the tracks are and where the panel
  // is scrolled, so a step that inherits whatever the last one left finds its anchors
  // somewhere else. The symptoms were memorable: a spotlight around most of the app, and
  // one around a patch of empty track where a button used to be. Every step naming its
  // own view is what makes Back and Next land in the same place every time.
  //
  // Only for a tutorial that actually moves the browser. Getting Started never does — its
  // genome is twenty-two kilobases and its browser steps look rather than travel — so
  // there is nothing for a step to inherit and nothing to declare.
  for (const tutorial of TUTORIALS) {
    const moves = tutorial.steps.some((step) => stepAction(step).type === 'browserView')
    if (!moves) continue
    for (const step of tutorial.steps) {
      if (step.view !== 'genome_browser' || step.id === 'open-browser') continue
      const arrivals = arrivalsFor(tutorial, step)
      assert.ok(
        arrivals.some((entry) => entry.type === 'browserView'),
        `${tutorial.id}/${step.id} inherits whatever view the step before it left`
      )
    }
  }
})

test('the browser tutorial resets the transcript layout on every step', () => {
  // The other half of the same problem: a step arriving with transcripts still expanded
  // is a step whose anchors are hundreds of pixels from where it expects them.
  const controls = arrivalsFor(browserInDepth, browserInDepth.steps[0])
    .find((entry) => entry.type === 'browserControls')
  assert.ok(controls, 'the tutorial declares no default layout')
  assert.equal(controls.expanded, false)
  assert.equal(controls.detail, false)
  assert.equal(controls.flatten, false)
})

test('the browser tutorial is divided into coherent narrative sections', () => {
  const runs = []
  for (const step of browserInDepth.steps) {
    if (runs.at(-1)?.title !== step.section) runs.push({ title: step.section, ids: [] })
    runs.at(-1).ids.push(step.id)
  }

  assert.deepEqual(runs.map((run) => run.title), [
    'Getting oriented',
    'General controls',
    'Moving through the genome',
    'Displaying transcripts',
    'Filtering gene types',
    'Focusing on a gene',
    'Browsing a gene in detail',
    'Adding notes',
    'Wrapping up',
  ])
  assert.deepEqual(runs.map((run) => run.ids[0]), [
    'welcome', 'global-controls', 'moving-about', 'deep-genes', 'gene-classes',
    'find-reg4', 'drawer', 'notes-section', 'finish',
  ])
})

test('a step that presses a browser switch says which way it expects to find it', () => {
  // Detail, Flatten and expand-all are toggles: clicking one that is already on turns it
  // off. Without an expected starting state, walking back into the middle of that section
  // and pressing Next does the opposite of what the card says.
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  for (const [id, expected] of [
    ['expand-transcripts', { detail: false, flatten: false, expanded: false }],
    ['detail', { detail: false, flatten: false, expanded: true }],
    ['detail-off', { detail: true, flatten: false, expanded: true }],
    ['layout-back', { detail: false, flatten: false, expanded: true }],
    // Flatten is taught a gene at a time now, on TBX15's own transcripts rather than on a
    // second gene of its own, so its before/after states live in that section.
    ['gene-transcripts-flatten', { detail: false, flatten: false, expanded: false }],
    ['gene-transcripts-collapse', { detail: false, flatten: true, expanded: false }],
  ]) {
    const controls = stepArrivals(byId[id]).find((entry) => entry.type === 'browserControls')
    assert.ok(controls, `${id} presses a switch without saying how it expects to find it`)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(controls[key], value, `${id} arrive.${key}`)
    }
  }
})

test('the transcript layout controls reveal the track and leave each result on screen', () => {
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  for (const id of ['expand-transcripts', 'expanded-transcripts', 'detail', 'detail-result',
    'detail-off', 'layout-back', 'gene-transcripts-expand', 'gene-transcripts-flatten',
    'gene-transcripts-collapse']) {
    assert.equal(
      byId[id]?.reveal?.anchor?.selector,
      '[data-browser-canvas-surface]',
      `${id} dims the track whose layout it is explaining`
    )
    assert.notEqual(byId[id]?.placement, 'bottom', `${id} puts its card over the track`)
  }
  assert.equal(byId['expanded-transcripts'].interactive, false)
  assert.equal(byId['expanded-transcripts'].placement, 'top')
  assert.deepEqual(byId['expanded-transcripts'].cardPosition, { x: 0.02, y: 0.02 })
  assert.equal(
    byId['expanded-transcripts'].placeAgainst?.selector,
    '[data-browser-canvas-surface]',
    'step 14 must place its card outside the expanded browser track'
  )
  assert.equal(byId['detail-result'].interactive, false)
  // The per-gene section's own two result steps, which are what Flatten is shown on now.
  assert.equal(byId['gene-transcripts-expanded'].interactive, false)
  assert.equal(byId['gene-transcripts-collapsed'].interactive, false)
})

test('late browser steps reveal the track whenever their result is drawn there', () => {
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  for (const id of ['gene-classes', 'only-protein-coding', 'protein-coding-result', 'find-reg4',
    'focus-bar', 'recentre', 'show-transcripts', 'hide-transcript', 'highlight-transcript',
    'note-icon']) {
    assert.equal(
      byId[id]?.reveal?.anchor?.selector,
      '[data-browser-canvas-surface]',
      `${id} dims the track whose result it describes`
    )
  }
  assert.equal(
    byId.unfocus?.reveal?.anchor?.selector,
    '[data-focus-drawer="true"]',
    'the close step should reveal the drawer containing its X'
  )
})

test('the tutorial clears focus using the drawer X, not the global Unfocus control', () => {
  const step = browserInDepth.steps.find((entry) => entry.id === 'unfocus')
  assert.equal(step?.anchor, 'focus-gene-dismiss')
  assert.equal(step?.action?.type, 'click')
  assert.equal(step?.action?.anchor, 'focus-gene-dismiss')
  assert.equal(step?.advanceOn?.type, 'click')
})

test('any note text proceeds with Next and is followed by its gene icon, not a Save step', () => {
  const writeIndex = browserInDepth.steps.findIndex((entry) => entry.id === 'write-note')
  const write = browserInDepth.steps[writeIndex]
  const result = browserInDepth.steps[writeIndex + 1]
  assert.equal(write?.advanceOn?.type, 'manual')
  assert.equal(write?.action?.type, 'type')
  assert.notEqual(write?.action?.overwrite, true)
  assert.equal(result?.id, 'note-icon')
  assert.equal(result?.anchor, `browser-gene-note-${REG4.id}`)
  assert.equal(result?.interactive, false)
  assert.equal(browserInDepth.steps.some((entry) => entry.id === 'save-note'), false)
})

test('the focus bar stays clear, and recentering finishes on the press it asks for', () => {
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  assert.equal(byId['focus-bar'].placeAgainst, undefined)
  assert.notEqual(byId['focus-bar'].spotlightRing, false)
  assert.equal(byId['focus-bar'].spotlightRingShadow, false)
  // Pressing the button is the whole step, so pressing it ends the step — whoever does it.
  assert.equal(byId.recentre.advanceOn.type, 'click')
  // Held long enough for the view to travel back to the gene and settle, so the result of
  // the press is watched rather than glimpsed on the way to the next card.
  assert.equal(byId.recentre.holdMs, 3000)
  assert.equal(byId.recentre.action.type, 'click')
  assert.equal(byId.recentre.action.anchor, 'browser-recenter')
  // And the reader may actually press it; the spotlight is the button, not a wrapper.
  assert.equal(byId.recentre.anchor, 'browser-recenter')
  assert.ok(byId.recentre.action.skipIfFeatureFramed, 'Next must not re-press an already framed view')
  assert.equal(byId.recentre.arrive.locus, SLICE_WHOLE_REGION)
})

test('pinning a transcript leaves the alignment visible until Next', () => {
  const step = browserInDepth.steps.find((entry) => entry.id === 'highlight-transcript')
  const controls = stepArrivals(step).find((entry) => entry.type === 'browserControls')
  assert.equal(controls.pinnedTranscript, 'none')
  assert.equal(step.advanceOn.type, 'manual')
  assert.equal(step.action.type, 'click')
  assert.equal(step.action.skipIfEngaged, true)
  assert.equal(step.holdMs, 3000)
})

test('the sequence step offers CDS and protein without advancing on either click', () => {
  const sequences = browserInDepth.steps.find((step) => step.id === 'sequences')
  assert.equal(sequences?.anchor, 'focus-sequence-coding-types')
  assert.deepEqual(sequences?.action?.anchors, ['focus-sequence-cds', 'focus-sequence-protein'])
  assert.equal(sequences?.action?.pauseMs, 4000)
  assert.equal(sequences?.action?.endPauseMs, 4000)
  assert.equal(sequences?.action?.skipIfEngaged, true)
  assert.equal(sequences?.advanceOn?.type, 'manual')
  assert.equal(sequences?.deferUntilReady, true)
  assert.equal(sequences?.reveal?.anchor?.selector, '[data-focus-transcript-detail]')
  assert.equal(sequences?.placeAgainst?.selector, '[data-focus-transcript-detail]')
})

test('the transcript detail is closed explicitly before the notes section', () => {
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  const closeIndex = browserInDepth.steps.findIndex((step) => step.id === 'close-transcript-detail')
  // The first step of the notes section, whichever it is: the panel has to be shut before
  // the drawer is talked about, and the step that does the shutting has to be the one
  // immediately before it.
  const notesIndex = browserInDepth.steps.findIndex((step) => step.section === 'Adding notes')
  const close = byId['close-transcript-detail']

  assert.equal(closeIndex + 1, notesIndex)
  assert.equal(close.anchor, 'focus-transcript-detail-close')
  assert.equal(close.action.anchor, 'focus-transcript-detail-close')
  assert.equal(close.advanceOn.type, 'click')
  // Every notes step that can be arrived at directly says so for itself, rather than
  // relying on the step before it having run.
  for (const id of ['notes-section', 'add-note']) {
    assert.equal(
      stepArrivals(byId[id]).find((entry) => entry.type === 'browserControls')?.transcriptDetail,
      'closed',
      `${id} should arrive with the transcript panel closed`,
    )
  }
})

test('the sequence-level zoom respects a manual result and animates in one move', () => {
  const zoom = browserInDepth.steps.find((step) => step.id === 'zoom-sequence')
  assert.equal(zoom?.action?.locus, TBX15_SEQUENCE_REGION)
  assert.equal(zoom?.action?.moves, undefined)
  assert.equal(zoom?.action?.skipIfSequenceVisible, true)
  assert.ok(zoom?.action?.durationMs > 1000)
})

test('the browser tutorial puts back everything it changes', () => {
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  assert.equal(stepUndo(byId['focus-bar']).type, 'unfocus-gene')
  // The note is put back by the arrival of the step that writes it, not undone by the
  // step after — so walking back into the middle of the note section finds the note still
  // there, and walking back past the start of it finds none.
  const creates = stepArrivals(byId['add-note']).find((e) => e.type === 'browserControls')
  assert.equal(creates?.tutorialNote, 'none', 'the step that creates the note must start from none')
  // The writing and result steps reopen the same note on the way back.
  for (const id of ['write-note', 'note-icon']) {
    const editor = stepArrivals(byId[id]).find((e) => e.type === 'browserControls')
    assert.equal(editor?.noteEditor, 'open', `${id} must reopen the editor on the way back`)
  }
  // The gene-class filter is put back by the arrival of the step that changes it, not by
  // an undo on the step after — one mechanism, and it works from either direction.
  const classes = stepArrivals(byId['only-protein-coding']).find((e) => e.type === 'browserControls')
  assert.equal(classes?.biotypes, 'all')
  // Whatever follows the unfocus must not ask for the focus back. A precondition that
  // undoes the step before it is the oldest trap in this system: the gene would re-focus
  // and the drawer would reopen on top of what had just been closed. Written against
  // position rather than a step id, so it still holds when the step there changes.
  const unfocusIndex = browserInDepth.steps.findIndex((step) => step.id === 'unfocus')
  const afterUnfocus = browserInDepth.steps[unfocusIndex + 1]
  assert.ok(afterUnfocus, 'the unfocus step should not be last')
  assert.ok(
    !stepPreconditions(afterUnfocus).includes('reg4-gene-focused'),
    `${afterUnfocus.id} would re-focus the gene the step before it released`
  )
})

test('a step that clicks several things waits for the last of them', () => {
  // Advancing on the first press ends the step while the rest are still queued, and they
  // then land on top of whatever the next step's arrival had just established — which is
  // how Flatten stayed on for the rest of the tutorial and the note mark had nowhere to
  // go. Cost an afternoon; hence the test.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      const anchors = actionAnchors(stepAction(step))
      if (anchors.length < 2) continue
      if (step.advanceOn?.type === 'manual') continue
      if (step.completeWhen && step.advanceOn?.type === 'signal') {
        assert.equal(step.advanceOn.name, 'browser.state')
        assert.ok(Object.keys(step.completeWhen.panels || {}).length >= anchors.length || step.completeWhen.active?.length >= anchors.length)
        continue
      }
      if (step.advanceOn?.type === 'all-clicks') {
        // The stronger form of the same rule, and the right one when the order the user
        // presses them in is their own: it waits for every press rather than for the last
        // to be queued. What it must not do is leave one of its own clicks unwaited for.
        //
        // Compared by selector rather than by identity: an anchor is a tour id *or* a
        // `{ selector }` object, and a target built from a `selectorTemplate` gives a fresh
        // object each time — so two anchors naming the same element were never the same Set
        // member, and a correct step failed.
        const waitedFor = new Set((step.advanceOn.anchors || []).map(anchorSelector))
        for (const anchor of anchors) {
          assert.ok(
            waitedFor.has(anchorSelector(anchor)),
            `${tutorial.id}/${step.id} clicks "${anchorSelector(anchor)}" but does not wait for it`
          )
        }
        continue
      }
      assert.equal(
        step.advanceOn?.type === 'click' ? step.advanceOn.anchor : null,
        anchors[anchors.length - 1],
        `${tutorial.id}/${step.id} advances before its own clicks have finished`
      )
    }
  }
})

test('a step that asks for a long value offers it to the clipboard', () => {
  // Anything much longer than a word is a typo waiting to happen, and nobody would retype
  // a coordinate string in earnest. The card carries a copy button instead.
  //
  // Only where the value is *required*, which `overwrite` already marks: it is set on the
  // steps where one value works and nothing else does. Where the value is illustrative —
  // the text of a note, a species name typed to watch a list filter — the user is meant
  // to put in their own, and offering the tutorial's to the clipboard says otherwise.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      const action = stepAction(step)
      if (action.type !== 'type' || !action.overwrite) continue
      if (String(action.value || '').length <= 12) continue
      assert.equal(
        stepCopyValue(step),
        action.value,
        `${tutorial.id}/${step.id} asks for a long value without offering it to the clipboard`
      )
    }
  }
})

test('editing a tutorial in place is behind one switch, and is not on in a build', () => {
  // A developer tool that rewrites the app's own source. It has to be removable without
  // an archaeology expedition, so everything it needs lives in tutorials/authoring.js and
  // backend/tutorial_authoring.py, and the UI asks the backend before offering it.
  const authoring = readFileSync(new URL('../src/tutorials/authoring.js', import.meta.url), 'utf8')
  assert.match(authoring, /export const TUTORIAL_AUTHORING = (true|false)/)

  const overlay = readFileSync(new URL('../src/components/TutorialOverlay.jsx', import.meta.url), 'utf8')
  assert.match(overlay, /authoringEnabled && \(/, 'the pencil must be gated on the backend saying yes')

  // The backend refuses outside a source checkout, so a packaged build has nothing to
  // edit even if the frontend flag were left on.
  const backend = readFileSync(new URL('../../backend/tutorial_authoring.py', import.meta.url), 'utf8')
  assert.match(backend, /def is_available/)
  assert.match(backend, /EDITABLE_FIELDS = \("section", "title", "body", "copy"\)/)
  assert.match(authoring, /\['section', 'title', 'body', 'copy'\]/)
})

test('no browser step waits on a value the search box will have thrown away', () => {
  // A successful search clears the field (jumpToRange calls setSearchInput('')), so an
  // `input` advance on it can never be satisfied and the step hangs forever.
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      if (step.advanceOn?.type !== 'input') continue
      const anchor = step.advanceOn.anchor || step.anchor
      assert.notEqual(anchor, 'browser-location-search', `${tutorial.id}/${step.id} would hang`)
    }
  }
})

test('every signal a tutorial waits on is emitted somewhere in the app', () => {
  for (const tutorial of TUTORIALS) {
    for (const step of tutorial.steps) {
      if (step.advanceOn?.type !== 'signal') continue
      assert.ok(
        allSource.includes(`emitSignal('${step.advanceOn.name}'`)
          || allSource.includes(`emitTutorialSignal('${step.advanceOn.name}'`),
        `nothing emits "${step.advanceOn.name}", so ${tutorial.id}/${step.id} would hang`
      )
    }
  }
})

test('the bundled genome identifiers agree with the backend', () => {
  // They are duplicated rather than derived — the frontend cannot import Python — so the
  // only thing keeping them honest is this. A mismatch is invisible until a tutorial
  // fails to install its genome at run time.
  const backend = readFileSync(new URL('../../backend/demo_genome.py', import.meta.url), 'utf8')
  for (const identifier of [
    DEMO_SPECIES_KEY,
    SLICE_SPECIES_KEY,
    SLICE_ASSEMBLY,
    SLICE_GENOME_ID,
    SLICE_SCIENTIFIC_NAME,
    SLICE_DISPLAY_NAME,
  ]) {
    assert.ok(backend.includes(`"${identifier}"`), `backend/demo_genome.py does not mention "${identifier}"`)
  }
})

test('the demo track filenames agree with the backend', () => {
  // Same argument as the genome identifiers above, and the same failure: the browser
  // matches a registered track to one of these by the end of its path, so a rename on
  // either side leaves a `browserTracks` arrival silently adding nothing at all.
  const backend = readFileSync(new URL('../../backend/demo_genome.py', import.meta.url), 'utf8')
  for (const filename of Object.values(TRACK_FILENAMES)) {
    assert.ok(backend.includes(`"${filename}"`), `backend/demo_genome.py does not mention "${filename}"`)
  }
  // And the keys are what the workspace installer writes them under.
  for (const key of Object.keys(TRACK_FILENAMES)) {
    assert.ok(backend.includes(`("${key}",`), `DEMO_TRACK_BUNDLE has no "${key}" entry`)
  }
})

test('steps that point inside a collapsible section say how to open it', () => {
  // Otherwise the step waits forever on an anchor that exists but is hidden.
  const byId = Object.fromEntries(gettingStarted.steps.map((step) => [step.id, step]))
  assert.equal(byId['output-dir'].openSection, 'config-section-outputs')
})

test('both searches light the whole control, so either way of submitting works', () => {
  // The box empties itself on a successful search, so neither step can wait on its
  // contents — and a card that offers Return *or* the button has to leave both usable.
  // The wrapper is the spotlight; a region carries no capability, so the two controls
  // inside it are named explicitly or the step converts to look-only.
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  for (const [id, signal] of [['search', 'browser.regionSearched'], ['find-reg4', 'browser.geneFocused']]) {
    const step = byId[id]
    assert.equal(step.anchor, 'browser-location-search-field', `${id} lights only the box`)
    assert.deepEqual(step.allow, [
      { anchor: 'browser-location-search', capability: 'input' },
      { anchor: 'browser-location-search-go', capability: 'activate' },
    ], `${id} does not allow both ways of submitting`)
    assert.equal(step.advanceOn.type, 'signal')
    assert.equal(step.advanceOn.name, signal)
  }
})

test('the search step ends when the search lands, not when Next is pressed', () => {
  // The box empties itself on a successful search, so it can never be waited on; and a
  // reader who pressed Return was left looking at the region they asked for beside a card
  // that still wanted something.
  const browser = TUTORIALS.find((tutorial) => tutorial.id === 'browser-in-depth')
  const step = browser.steps.find((candidate) => candidate.id === 'search')
  assert.deepEqual(step.advanceOn, { type: 'signal', name: 'browser.regionSearched' })
  assert.ok(step.holdMs > 0, 'the result appears away from the box, so it needs a beat')
  // The button that submits it is inside the highlight rather than dimmed beside it.
  assert.equal(step.anchor, 'browser-location-search-field')
  assert.equal(step.copyInto, 'browser-location-search')

  // And the search has somewhere to land: the step after it is about the result, which is
  // the beat most easily left out of a tutorial and the one that makes it feel like it
  // worked. Look-only, and declaring the region so it is true when jumped to directly.
  const after = browser.steps[browser.steps.indexOf(step) + 1]
  assert.equal(after.id, 'search-result')
  assert.equal(after.interactive, false)
  assert.deepEqual(after.arrive, { type: 'browserView', locus: step.copy })
})

test('a gene\'s own transcripts are taught on its pill, and put back afterwards', () => {
  // The pill is DOM over the canvas rather than painted on it, so it can be anchored
  // directly — unlike the track switches in the gutter, which need marker divs.
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  const pill = `browser-gene-transcripts-${TBX15.id}`
  assert.equal(byId['gene-transcripts-expand'].anchor, pill)
  assert.equal(byId['gene-transcripts-collapse'].anchor, pill)

  // Collapsed before the step that expands it, so returning shows the pill being pressed
  // rather than one already pressed — the same rule as an empty genome selection.
  // Merged, because a step may declare the layout and the gene's own transcripts as two
  // entries; the runtime coalesces them into one set operation.
  const controls = (id) => Object.assign(
    {},
    ...stepArrivals(byId[id]).filter((entry) => entry.type === 'browserControls')
  )
  assert.deepEqual(controls('gene-transcripts-expand').geneTranscripts, { gene: TBX15.id, expanded: false })
  assert.deepEqual(controls('gene-transcripts-expanded').geneTranscripts, { gene: TBX15.id, expanded: true })
  assert.deepEqual(controls('gene-transcripts-collapsed').geneTranscripts, { gene: TBX15.id, expanded: false })

  // Flatten is turned on here and never turned off by a step of its own, so the section
  // that follows has to be the thing that puts it back.
  assert.equal(controls('gene-transcripts-collapsed').flatten, true)
  // Through the tutorial-level default, which is what every step without its own layout
  // declaration inherits — so the section boundary is where Flatten actually goes back.
  const inherited = Object.assign(
    {},
    ...arrivalsFor(browserInDepth, byId['zoom-sequence']).filter((entry) => entry.type === 'browserControls')
  )
  assert.equal(inherited.flatten, false)

  // And nothing outside this section teaches Flatten any more.
  const flattenSteps = browserInDepth.steps.filter((step) => step.anchor === 'browser-flatten')
  assert.deepEqual(flattenSteps.map((step) => step.id), ['gene-transcripts-flatten'])
})

test('a step that asks the reader to do something lets them do it', () => {
  // The bug this exists for is silent and looks like nothing at all: the tutorial can
  // still perform the step, because Next goes through clickAsTutorial and the interaction
  // guard ignores it, so autoplay works and only a reader doing it by hand finds the
  // control dead. It arrives whenever a step spotlights a group, a row or a wrapper —
  // none of which carry a capability — while its action presses a control inside. The
  // remedy is `allow`, naming what the step actually asks for.
  for (const tutorial of TUTORIALS) {
    for (const [index, step] of tutorial.steps.entries()) {
      if (!step.interactionPolicy) continue
      const allowed = step.interactionPolicy.targets || []
      if (allowed.length) continue
      const asksForAClick = ['click', 'all-clicks', 'input'].includes(step.advanceOn?.type)
      const performsOne = step.action && !['none', 'navigate', 'browserView'].includes(step.action.type)
      assert.ok(
        !(asksForAClick || performsOne),
        `${tutorial.id} step ${index + 1} (${step.id}) asks for an action but permits none`,
      )
    }
  }
})

test('the gene-class step unticks a class the window actually contains', () => {
  // The window holds three protein-coding genes and three lncRNA ones, and nothing else.
  // Unticking pseudogenes or small non-coding there demonstrated nothing at all, and the
  // step after it described rows leaving a track they were never on.
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  const step = byId['only-protein-coding']
  assert.equal(step.action.anchor, 'browser-biotype-lncRNA')
  assert.equal(step.action.anchors, undefined, 'one box, so no multi-anchor advance trap')
  assert.deepEqual(step.advanceOn, { type: 'click', anchor: 'browser-biotype-lncRNA' })
  assert.deepEqual(step.allow, [{ anchor: 'browser-biotype-lncRNA', capability: 'activate' }])

  // And the step after it arrives in the state that one untick leaves behind, rather than
  // silently unticking two more boxes the reader never touched.
  const after = byId['protein-coding-result']
  const controls = stepArrivals(after).find((entry) => entry.type === 'browserControls')
  assert.deepEqual(controls.biotypes, ['proteinCoding', 'pseudogene', 'smallNonCoding'])
})

test("hiding a transcript is followed by the label that says so", () => {
  // The transcript leaves the track and the only thing left saying so is a small label
  // under the gene, which is also the way back. The step pointing at it declares the
  // hidden state rather than inheriting it, so it can be reached from the step list or
  // from Back and still have something to point at.
  const byId = Object.fromEntries(browserInDepth.steps.map((step) => [step.id, step]))
  const step = byId['hidden-transcript']
  assert.ok(step, 'the browser tutorial no longer shows what hiding a transcript did')
  assert.equal(step.anchor, `browser-gene-hidden-transcripts-${REG4.id}`)
  assert.equal(step.interactive, false, 'restoring it here would undo the step before it')

  const hiddenState = (id) => Object.assign(
    {},
    ...stepArrivals(byId[id]).filter((entry) => entry.type === 'browserControls')
  ).hiddenTranscript
  assert.deepEqual(hiddenState('hidden-transcript'), {
    transcript: REG4.hideableTranscript, hidden: true,
  })
  // And the step after it depends on the same thing, so it says so too.
  assert.deepEqual(hiddenState('highlight-transcript'), {
    transcript: REG4.hideableTranscript, hidden: true,
  })

  // It sits between the hide and the pin, not somewhere else in the section.
  const order = browserInDepth.steps.map((entry) => entry.id)
  assert.equal(order.indexOf('hidden-transcript'), order.indexOf('hide-transcript') + 1)
  assert.equal(order.indexOf('highlight-transcript'), order.indexOf('hidden-transcript') + 1)
})

test('the custom-genome tutorial types labels the backend will accept', () => {
  // The genome the reader builds is made browsable by `set_tutorial_session_genome`, which
  // only accepts a bundled species key. That key is derived from the *genome label the
  // reader types* — so the value the tutorial fills in is load-bearing, and a friendlier
  // label would leave the last four steps drawing an empty track. If this has to change,
  // change `BUNDLED_SPECIES_KEYS` in backend/demo_genome.py with it.
  const tutorial = getTutorial('custom-genome')
  assert.ok(tutorial, 'the custom-genome tutorial should be registered')

  const toSpeciesKey = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const labels = new Set()
  for (const step of tutorial.steps) {
    for (const arrival of arrivalsFor(tutorial, step)) {
      if (arrival.type === 'customGenome' && arrival.fields?.genomeLabel) labels.add(arrival.fields.genomeLabel)
    }
  }
  assert.equal(labels.size, 1, 'every step should name the same genome')
  assert.equal(toSpeciesKey([...labels][0]), DEMO_SPECIES_KEY)

  // Only one value works, so the step that types it must overwrite whatever is there and
  // must hand it over rather than asking the reader to retype it.
  const typing = tutorial.steps.find((step) => step.id === 'type-labels')
  assert.equal(stepCopyValue(typing), [...labels][0])
  const action = stepAction(typing)
  assert.equal(action.type, 'type')
  assert.equal(action.value, [...labels][0])
  assert.equal(action.overwrite, true, 'only this value works, so Next must replace what is there')
})

test('the custom-genome tutorial declares the form state every step describes', () => {
  // The whole tutorial is a form being filled in, and a step that inherits the form from
  // the step before it is a step that shows the wrong thing when reached with Back. The
  // sweeps prove this by driving the app; this keeps it true between sweeps.
  const tutorial = getTutorial('custom-genome')
  // The step that opens the app is about the app button, not the form.
  const selectorSteps = tutorial.steps.filter(
    (step) => step.view === 'genome_selector' && step.id !== 'open-selector'
  )
  for (const step of selectorSteps) {
    assert.ok(
      arrivalsFor(tutorial, step).some((arrival) => arrival.type === 'customGenome'),
      `${step.id} describes the form without declaring it`
    )
  }

  // The step that presses Add genome has to arrive with it not yet added, or coming back
  // to it finds the job done and the button does nothing its card describes.
  const adding = tutorial.steps.find((step) => step.id === 'add-genome')
  const before = arrivalsFor(tutorial, adding).find((arrival) => arrival.type === 'customGenome')
  assert.equal(before.registered, false, 'the add step must arrive with the genome not yet added')
})

test('the custom-genome tutorial centres the button that registers the genome', () => {
  // Add genome sits at the foot of a long page, and an offset authored in one window is
  // below the bottom edge of a shorter one: the step then draws its ring around the few
  // visible pixels of the control its card is telling the reader to press. Centring asks
  // for the button to be on screen rather than for a composition, which is what this step
  // actually needs.
  const tutorial = getTutorial('custom-genome')
  const adding = tutorial.steps.find((step) => step.id === 'add-genome')
  const scroll = arrivalsFor(tutorial, adding).find((arrival) => arrival.type === 'pageScroll')
  assert.ok(scroll, 'the add step should frame its own view')
  assert.equal(arrivalScrollCenter(scroll), true, 'the add step should centre its button')
  assert.equal(scroll.offset, undefined, 'centred and placed at an offset are different instructions')
})


test('every browser step of the track tutorial establishes the registry, not just the panel', () => {
  // Views unmount when they are not active, so a genome-browser step cannot inherit the
  // registry from the Track Manager steps that registered the tracks — walking backward or
  // jumping in found an empty registry, drew no custom tracks, and left every card in the
  // last three sections describing something that was not there.
  //
  // The order is a dependency order: a track cannot be added to a panel before it exists.
  const tutorial = getTutorial('track-manager')
  assert.ok(tutorial, 'the track-manager tutorial should be registered')

  for (const step of tutorial.steps) {
    if (step.view !== 'genome_browser') continue
    const arrivals = stepArrivals(step)
    const types = arrivals.map((arrival) => arrival.type)
    assert.ok(types.includes('trackRegistry'), `${step.id} does not establish the registry`)
    const panelAt = types.indexOf('browserTracks')
    if (panelAt >= 0) {
      assert.ok(types.indexOf('trackRegistry') < panelAt, `${step.id} adds tracks before registering them`)
    }
  }
})

test('the track tutorial associates every demo track with a genome', () => {
  // A track registered against nothing is registered and then never drawn, because the
  // browser only offers tracks belonging to the genome in front of you. The step that
  // presses Register must therefore arrive with the genome already chosen.
  const tutorial = getTutorial('track-manager')
  const byId = Object.fromEntries(tutorial.steps.map((step) => [step.id, step]))

  for (const id of ['register', 'register-atac']) {
    const registry = stepArrivals(byId[id]).find((arrival) => arrival.type === 'trackRegistry')
    assert.ok(registry, `${id} states no track registry`)
    assert.equal(registry.genome, 'slice', `${id} registers against no genome`)
  }
  // And the step that presses it declares the job not yet done, or coming Back finds it done.
  const before = stepArrivals(byId['register']).find((arrival) => arrival.type === 'trackRegistry')
  assert.deepEqual(before.registered, [], 'the first Register step must arrive with nothing registered')
})

test('the track tutorial never asserts a variant panel it cannot open', () => {
  // The VCF metadata panel opens on a canvas click, which no target contract can drive. The
  // step therefore invites the click rather than claiming the panel is open — a card may only
  // describe state its own `arrive` establishes.
  const tutorial = getTutorial('track-manager')
  const step = tutorial.steps.find((entry) => entry.id === 'vcf-click')
  assert.ok(step, 'the vcf-click step should exist')
  assert.equal(stepAdvance(step).type, 'manual', 'it is an invitation, so Next continues')
  assert.equal(stepAction(step).type, 'none', 'the tutorial must not click a variant for the reader')
})


test('a step that presses several controls and then a final one is two steps', () => {
  // One step ticked three picker rows *and* pressed Add, with the highlight over only the
  // rows — so a reader who ticked all three could not reach Add, and pressing Next re-ran
  // the whole action and unticked the rows it had just been given. The rows and the button
  // are now separate steps.
  const tutorial = getTutorial('track-manager')
  const byId = Object.fromEntries(tutorial.steps.map((step) => [step.id, step]))

  const ticking = byId['choose-three']
  const adding = byId['add-them']
  assert.ok(ticking && adding, 'ticking and adding should be separate steps')

  const tickAnchors = actionAnchors(stepAction(ticking)).map(anchorSelector)
  assert.equal(tickAnchors.length, 3, 'the ticking step presses only the rows')
  assert.ok(
    !tickAnchors.some((anchor) => anchor.includes('picker-add')),
    'the ticking step must not also press Add',
  )
  assert.equal(stepAdvance(ticking).type, 'all-clicks', 'it waits for every row')
  // A row the reader has already ticked is left alone.
  assert.equal(stepAction(ticking).desiredEngaged, true)

  assert.equal(actionAnchors(stepAction(adding)).length, 1, 'the adding step presses one button')
})

test('a step that asks the reader to switch tracks off leaves the ones already off alone', () => {
  // Pressing a switch that is already off turns it back on, which reads as the tutorial
  // undoing the reader's work and then moving on.
  const step = getTutorial('track-manager').steps.find((entry) => entry.id === 'switch-two-off')
  assert.ok(step)
  assert.equal(stepAdvance(step).type, 'all-clicks')
  assert.equal(stepAction(step).desiredEngaged, false)
})

test('every control a track-tutorial step asks the reader to use permits its own events', () => {
  // The guard maps capabilities to event types, and a mismatch is silent: Next goes through
  // `clickAsTutorial` and works, while the reader's own mousedown is cancelled. A `<select>`
  // needs `set-state` (which now covers mousedown/click/change); a button needs `activate`.
  const tutorial = getTutorial('track-manager')
  for (const step of tutorial.steps) {
    const action = stepAction(step)
    if (action.type === 'none') continue
    const allowed = (step.allow || []).map((entry) => entry.capability)
    if (!step.interactive || !allowed.length) continue
    if (action.type === 'select') {
      assert.ok(allowed.includes('set-state'), `${step.id} drives a drop-down without allowing set-state`)
    }
  }
})
