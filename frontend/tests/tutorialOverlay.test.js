// Invariants that live inside the tutorial overlay and provider rather than in a pure
// module. The harness is bare `node --test` with no renderer, so these are checked by
// reading the source — the same approach as notesTransferModal.test.js. Cheap tripwires
// for the things that would be expensive to lose quietly.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTOPLAY_SPEEDS,
  DEFAULT_SPEED_INDEX,
  speedFactor,
  stepDwellMs,
} from '../src/utils/tutorialModel.js'
import { tutorialDimColor } from '../src/utils/overlayGeometry.js'
import { readFileSync } from 'node:fs'

const overlay = readFileSync(new URL('../src/components/TutorialOverlay.jsx', import.meta.url), 'utf8')
const provider = readFileSync(new URL('../src/hooks/useTutorial.jsx', import.meta.url), 'utf8')
const screenshot = readFileSync(new URL('../src/components/ScreenshotSelectionOverlay.jsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const backendDemo = readFileSync(new URL('../../backend/demo_genome.py', import.meta.url), 'utf8')
const backendMain = readFileSync(new URL('../../backend/main.py', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const builder = readFileSync(new URL('../src/components/TutorialBuilderOverlay.jsx', import.meta.url), 'utf8')

// The step overlay only, not the completion panel above it.
const stepOverlay = overlay.slice(overlay.lastIndexOf('return ('))

test('the spotlight is left clickable, which is the whole point', () => {
  // Four bands around the hole rather than one sheet with a hole drawn in it. If this
  // ever becomes a single full-screen catcher, every "click this button" step breaks.
  assert.match(overlay, /blockerRects/)
  assert.ok(
    !/inset-0[\s\S]{0,200}?pointerEvents: 'auto'/.test(stepOverlay),
    'nothing full-screen may swallow clicks while a step is showing'
  )
  assert.match(stepOverlay, /style=\{\{ pointerEvents: 'none' \}\}/, 'the overlay root must not catch clicks')
})

test('the dimming layer never catches clicks itself', () => {
  const svgBlock = overlay.slice(overlay.indexOf('<svg'), overlay.indexOf('</svg>'))
  assert.match(svgBlock, /pointerEvents: 'none'/)
})

test('both overlays share one geometry module rather than each keeping a copy', () => {
  assert.match(overlay, /from '\.\.\/utils\/overlayGeometry'/)
  assert.match(screenshot, /from '\.\.\/utils\/overlayGeometry'/)
  for (const helper of ['clipRectToContainer', 'cutoutPathD']) {
    assert.ok(!screenshot.includes(`function ${helper}`), `${helper} should come from the shared module`)
  }
})

test('the overlay gets its rules from the model rather than reimplementing them', () => {
  assert.match(overlay, /from '\.\.\/utils\/tutorialModel'/)
  for (const name of ['anchorSelector', 'stepAdvance']) {
    assert.ok(overlay.includes(name), `${name} should come from the model`)
  }
  assert.ok(!overlay.includes('advanceOn.type ==='), 'advance rules belong in the model')
})

test('a section is the card heading and the individual step is its subheading', () => {
  assert.match(overlay, /const sectionTitle = stepSection\(step\)/)
  assert.match(overlay, /data-tutorial-section-title="true"/)
  assert.match(overlay, /data-tutorial-step-title="true"/)
  // Read from the preview values rather than the step directly, so that a card being
  // dragged in edit mode shows the words currently in the draft — but the shape is the
  // same: section above, step title below it.
  assert.match(overlay, /<h2[\s\S]*?\{previewSection\}[\s\S]*?<h3[\s\S]*?\{previewTitle\}/)
  assert.match(overlay, /const previewTitle = editing \? \(draft\?\.title \?\? step\.title\) : step\.title/)
})

test('a card being dragged shows the box that will be saved, not the editing shell', () => {
  // Edit mode adds inputs, a Save row and a note line, so the shell is taller than the
  // card being authored. Clamping the drag to the shell put the bottom of the window out
  // of reach: there was a band there that no card could be placed in, and the position
  // that came back was the shell's, not the box's.
  assert.match(overlay, /const editingChrome = editing && !dragging/)
  // The true box is what the stored position means and what the window's edges bound.
  assert.match(overlay, /const maxTrueTop = Math\.max\(CARD_MARGIN, size\.height - trueCardHeight - CARD_MARGIN\)/)
  assert.match(overlay, /const maxCardTop = maxTrueTop/)
  assert.match(overlay, /top: trueCard \? trueCard\.top : card\.top/)
  // The shell then sits at the nearest fully visible place, which is a no-op when the two
  // heights agree — that is, whenever the card is not being edited.
  assert.match(overlay, /top: Math\.min\(trueTop, maxShellTop\)/)
  // And the saved height is only ever measured from a card that is not wearing the chrome.
  assert.match(overlay, /if \(!node\.hasAttribute\('data-tutorial-card-editing'\)\) trueCardHeightRef\.current = measured/)
  assert.match(overlay, /data-tutorial-card-true-outline="true"/)
})

test('editing a section heading renames every matching card in this tutorial', () => {
  assert.match(overlay, /data-tutorial-edit="section"/)
  assert.match(overlay, /\['section', draft\.section, stepSection\(step\)\]/)
  assert.match(provider, /if \(field === 'section'\)/)
  assert.match(provider, /stepSection\(effectiveStep\(candidate\)\) === oldHeading/)
  assert.match(provider, /affectedSteps: affected\.length/)
})

test('edit mode can drag a card and persists a resize-safe normalized position', () => {
  assert.match(overlay, /data-tutorial-card-drag-handle=\{editing \? 'true'/)
  assert.match(overlay, /authoredPosition\.x \* size\.width/)
  assert.match(overlay, /authoredPosition\.y \* size\.height/)
  assert.match(overlay, /await editStepPosition\(step\.id, dragPosition\)/)
  assert.match(provider, /savePortableStepLayout\(id, \{ cardPosition: normalized \}\)/)
  assert.match(provider, /saveStepPosition\(\{ tutorialId, stepId: id, position: normalized \}\)/)
  assert.match(provider, /cardPosition: result\.position/)
})

test('layout edits made while running a builder draft persist back to that draft', () => {
  assert.match(provider, /getRuntimeTutorialDocument\(tutorialId\)/)
  assert.match(provider, /saveTutorialDraft\(root, document\)/)
  assert.match(provider, /registerRuntimeTutorial\(saved\)/)
  assert.match(provider, /notifyTutorialDraftsChanged\(root\)/)
})

test('multiple highlighted rows are inset so consecutive rings stay distinct', () => {
  assert.match(overlay, /const MULTI_HIGHLIGHT_INSET = -2/)
  assert.match(overlay, /highlightedRectCount > 1 \? MULTI_HIGHLIGHT_INSET : HOLE_PADDING/)
  assert.match(overlay, /reveals\[index\]\?\.ring \? highlightPadding : HOLE_PADDING/)
})

test('edit mode exposes independent width, height, and corner resize handles', () => {
  for (const edge of ['right', 'bottom', 'corner']) {
    assert.match(overlay, new RegExp(`data-tutorial-card-resize="${edge}"`))
  }
  assert.match(overlay, /await editStepSize\(step\.id, resizeSize\)/)
  assert.match(overlay, /const authoredSize = \{ \.\.\.\(stepCardSize\(step\)/)
  assert.match(provider, /saveStepSize\(\{ tutorialId, stepId: id, size \}\)/)
  assert.match(provider, /cardSize: result\.size/)
})

test('layout edits are staged until Save and can be reset without closing', () => {
  const finishMove = overlay.slice(overlay.indexOf('const finishCardDrag'), overlay.indexOf('const cancelCardDrag'))
  const finishResize = overlay.slice(overlay.indexOf('const finishCardResize'), overlay.indexOf('const cancelCardResize'))
  assert.doesNotMatch(finishMove, /editStepPosition/)
  assert.doesNotMatch(finishResize, /editStepSize/)
  assert.match(overlay, /data-tutorial-edit-reset="true"/)
  assert.match(overlay, /editBaselineRef\.current/)
  assert.match(overlay, /setDraft\(\{ \.\.\.editBaselineRef\.current \}\)/)
  assert.match(overlay, /clearStagedLayout\(\)/)
})

test('autoplay traces the fixed card shell rather than a clipped scrolling edge', () => {
  assert.match(overlay, /data-tutorial-card-scroll="true"/)
  assert.match(overlay, /height: authoredCardHeight \? '100%' : undefined/)
  assert.match(overlay, /className="absolute inset-0 z-\[2\]"/)
  assert.match(overlay, /width="calc\(100% - 4px\)"/)
  assert.match(overlay, /height="calc\(100% - 4px\)"/)
  assert.doesNotMatch(overlay, /cardWidth - 4/, 'the inner SVG must not use the outer card width')
  assert.doesNotMatch(overlay, /layoutCardHeight - 4/, 'the inner SVG must not use the outer card height')
})

test('a moving panel target is presented only after its arrival scroll has settled', () => {
  assert.match(provider, /setReadyStepId\(step\.id\)[\s\S]*?setBusy\(''\)/)
  assert.match(overlay, /stepDefersPresentation\(step\) && !presentationReady/)
  assert.match(overlay, /data-tutorial-preparing=\{step\.id\}/)
})

test('large spotlight regions centre once and wait for native smooth scrolling to stop', () => {
  assert.match(provider, /async function waitForAnchorScrollToSettle/)
  assert.match(provider, /stableFrames >= 4/)
  assert.match(provider, /const centreOnArrival = forStep\?\.anchorScroll === 'center'/)
  assert.match(provider, /if \(centreOnArrival\)/)
  assert.match(provider, /if \(centreOnArrival\)[\s\S]*?await waitForAnchorScrollToSettle\(node\)[\s\S]*?return/)
  assert.doesNotMatch(provider, /scrollIntoView\([^\n]+\)[\s\S]{0,100}await sleep\(paced\(SETTLE_MS\)\)/)
})

test('soft gating: there is always a way forward and a way out', () => {
  assert.match(overlay, />\s*\{isLastStep \? 'Finish' : 'Next'\}/)
  // Wrapped, not gated: unsaved wording holds the move until the reader answers, and
  // every answer — including discarding — lets it through.
  assert.match(overlay, /guardLeaving\(skip, 'skip this step'\)/)
  assert.match(overlay, /guardLeaving\(exit, 'exit the tutorial'\)/)
  assert.match(overlay, /if \(!hasUnsavedEditsRef\.current\) \{\n {6}run\(\)/)
})

test('clicks are noticed once, at the document, not wired into every button', () => {
  assert.match(provider, /document\.addEventListener\('click', handleClick, true\)/)
  assert.match(provider, /closest\(selector\)/)
})

test('a dwell timer carries its step id, so a stale one cannot skip the next step', () => {
  assert.match(provider, /dispatch\(\{ type: 'dwell', stepId: step\.id \}\)/)
})

test('prefill goes through the native setter, or React will not see it', () => {
  assert.match(provider, /Object\.getOwnPropertyDescriptor\(prototype, 'value'\)\?\.set/)
  assert.match(provider, /new Event\('input', \{ bubbles: true \}\)/)
})

test('typing leaves what the user put in the field alone, unless the step insists', () => {
  // The default protects a user who typed something themselves. `overwrite` is the
  // exception for steps where only one value works at all — a gene name this genome does
  // not contain simply fails to resolve, and the step sits there looking broken.
  assert.match(provider, /if \(!existing\.trim\(\) \|\| \(action\.overwrite && existing\.trim\(\) !== String\(action\.value\)\)\)/)
  assert.match(provider, /const existing = String\(target\?\.value \|\| ''\)\.trim\(\)/)
})

test('Next waits for a signal it set in motion rather than running ahead of it', () => {
  // Advancing the instant a click lands arrives at the next step while the thing the
  // last step started is still in flight — and that step's preconditions then bring
  // about the same thing, so the two undo each other. The genome ticks on, then off.
  assert.match(provider, /\['signal', 'input'\]\.includes\(stepAdvance\(forStep \|\| \{\}\)\.type\)/)
  assert.match(provider, /SIGNAL_GRACE_MS/)
  assert.match(provider, /if \(String\(stepRef\.current\?\.id \|\| ''\) !== String\(forStep\.id\)\) return/)
})

test('a step can undo what it did when the user goes Back', () => {
  assert.match(provider, /const undo = stepUndo\(stepRef\.current\)/)
  assert.match(provider, /deactivate-demo-genome/)
  assert.match(provider, /unfocus-gene/)
})

test('going back to a typing step empties its field first', () => {
  // Otherwise its watcher matches the instant the step arrives and bounces the user
  // forward again, so Back appears not to work at all.
  assert.match(provider, /const returningTo = stepAt\(tutorial, \(state\?\.stepIndex \?\? 0\) - 1\)/)
  assert.match(provider, /if \(node && isInputAdvanceSatisfied\(advance, node\.value\)\) setNativeInputValue\(node, ''\)/)
})

test('a typed search is submitted, since these fields act on Enter', () => {
  // Without this the browser step fills the box and then sits there doing nothing.
  assert.match(provider, /new KeyboardEvent\('keydown', \{ key: 'Enter', bubbles: true \}\)/)
})

test('a collapsed section is opened only when the target cannot be found', () => {
  assert.match(provider, /if \(!cancelled && sectionNeedsOpening\(step\)\) \{\s+clickAsTutorial\(findAnchor\(step\.openSection\)\)/)
})

test('the dim behind a step is mild, and is the same one the builder previews', () => {
  // The app behind a highlight is still the reader's own app and they should be able to
  // see where they are in it: the highlight earns its attention by contrast, not by
  // blacking everything else out.
  for (const theme of ['light', 'dark']) {
    const alpha = Number(tutorialDimColor(theme).match(/([\d.]+)\)$/)[1])
    assert.ok(alpha > 0.15 && alpha < 0.5, `the ${theme} dim of ${alpha} is not a mild dim`)
  }
  // Three places dim for a step — playback, the preparing dim, and the builder's preview.
  // An author has to be able to trust that what they compose is what the reader sees, so
  // none of them may carry a colour of its own.
  assert.match(overlay, /backgroundColor: tutorialDimColor\(theme\)/)
  assert.match(overlay, /const dim = tutorialDimColor\(theme\)/)
  assert.match(builder, /const presentationDim = tutorialDimColor\(tutorial\.theme\)/)
  for (const [name, source] of [['the overlay', stepOverlay], ['the builder', builder]]) {
    assert.doesNotMatch(source, /rgba\(2, 6, 23, 0\.\d+\)/, `${name} still hard-codes a dim`)
  }
})

test('Next asks to be pressed only on a manual step, and only for a reader who is reading', () => {
  // The cue answers "nothing is going to happen until you press this". Autoplay is
  // already pressing it, and editing the wording or being asked about unsaved words is
  // not a stall, so any of those restarts the wait rather than nudging through it.
  assert.match(overlay, /stepAdvance\(step\)\.type === 'manual' \? step\.id : ''/)
  assert.match(overlay, /autoplay \|\| editing \|\| pendingNavigation \|\| busy/)
  assert.match(overlay, /setTimeout\(\(\) => setNudgeNext\(true\), NEXT_NUDGE_AFTER_MS\)/)
  // Reset on every change of step or of what is blocking it, or a cue earned on one step
  // would follow the reader onto the next.
  assert.match(overlay, /setNudgeNext\(false\)\n {4}if \(!nudgeStepId \|\| nudgeBlocked\) return undefined/)
})

test('the Next cue survives a reduced-motion preference', () => {
  // The overlay turns every animation off for that reader, so the animated halo alone
  // would leave them with no cue at all.
  assert.match(stepOverlay, /boxShadow: '0 0 0 3px rgba\(56, 189, 248, 0\.30\)'/)
  assert.match(stepOverlay, /animation: 'tutorial-next-nudge 2200ms ease-in-out infinite'/)
  assert.match(css, /@keyframes tutorial-next-nudge/)
  assert.match(css, /\[data-tutorial-overlay\] \* \{ animation: none !important; \}/)
})

test("a step can wait out the app's own notification before it is drawn", () => {
  // The banner is fixed over the top-bar buttons and sits above the app but below the
  // tutorial overlay, so it half-covers a highlight there and cannot be clicked away.
  assert.match(provider, /if \(requirement === 'notifications-clear'\) await waitForNotificationsToClear\(\)/)
  assert.match(provider, /document\.querySelector\('\[data-tutorial-notification="true"\]'\) && Date\.now\(\) < deadline/)
  // Capped: a banner that never leaves must not strand the tutorial on the step.
  assert.match(provider, /const deadline = Date\.now\(\) \+ NOTIFICATION_WAIT_MS/)
})

test('a step ringing a panel that stays mounted while shut says how to tell it is open', () => {
  // The step's own spotlight is the usual probe, but the Genome Playlists box is in the
  // DOM collapsed or not, so a step ringing the whole box would never open it.
  assert.match(provider, /return !findAnchor\(step\.sectionContent \|\| step\.anchor\)/)
})

test('Next does not retype a field that already says what the step asked for', () => {
  // Two rules, one check, made before the cursor moves so a step the reader has already
  // done does not first look like the tutorial is about to type over them.
  assert.match(provider, /const satisfied = action\.overwrite\n {8}\? existing === String\(action\.value \?\? ''\)\.trim\(\)\n {8}: Boolean\(existing\)/)
  assert.match(provider, /if \(satisfied && !forStep.completeWhen\) return false/)
})

test("a step's interaction policy governs the reader, not the tutorial's own presses", () => {
  // A look-only step still has to be able to open the section its target lives in, and
  // Next still has to be able to perform the step. Both are the tutorial acting.
  assert.match(provider, /const selfActingRef = useRef\(false\)/)
  assert.match(provider, /const guard = \(event\) => \{\n {6}if \(selfActingRef\.current\) return/)
  // One helper for all of it, so a keystroke is covered as well as a click.
  assert.match(provider, /const actAsTutorial = useCallback\(\(fn\) => \{\n {4}selfActingRef\.current = true/)
  assert.match(provider, /const clickAsTutorial = useCallback\(\(node\) => \{[\s\S]*?actAsTutorial\(\(\) => node\.click\(\)\)/)
})

test('nothing the tutorial does to the page is judged as if the reader did it', () => {
  // The failure this pins down: an arrival, an `ensure` or an `undo` runs while the step
  // it is preparing is already current, so a bare `.click()` or a synthetic keydown is
  // measured against *that* step's interaction policy and cancelled. It cost every step
  // needing the focused gene — a third of the browser tutorial — which arrived with no
  // gene focused, no drawer, and nothing for the spotlight to land on. Six branches of
  // `setBrowserControls` had it at once; the biotype branch beside them did not, which is
  // why reading one of them was never enough.
  const offenders = provider
    .split('\n')
    .map((line, index) => [index + 1, line.trim()])
    .filter(([, line]) => /\.click\(\)/.test(line))
    .filter(([, line]) => !/^\/\/|actAsTutorial|clickAsTutorial/.test(line))
  assert.deepEqual(offenders, [], `press these through clickAsTutorial: ${JSON.stringify(offenders)}`)
})

test('the precondition that focuses a gene acts as the tutorial', () => {
  // Typing is not a click, so it needs saying separately: this one sends a keydown, and
  // the guard cancels keydown unless the current step happens to allow input on that box.
  assert.match(provider, /actAsTutorial\(\(\) => \{\n {10}if \(typeof search\.focus === 'function'\) search\.focus\(\)/)
  assert.match(provider, /const unfocusGene = useCallback\(\(\) => \{\n {4}clickAsTutorial\(findAnchor\('browser-unfocus'\)\)/)
})

test('a direct jump waits for browser controls to mount before setting their state', () => {
  assert.match(provider, /const press = async \(anchor\) => \{[\s\S]*?await waitForAnchor\(anchor\)[\s\S]*?clickAsTutorial\(target\)/)
})

test('a tutorial is a sandbox: it publishes an override rather than writing config', () => {
  // The whole safety story rests on this. If a tutorial ever POSTs to /api/config, a
  // crash mid-run would leave the user's real setup altered.
  assert.match(provider, /configOverride/)
  assert.ok(!/\/api\/config/.test(provider), 'the tutorial runtime must never write the real config')
})

test('App runs on the override, so every view sees the sandbox', () => {
  assert.match(app, /const \[userConfig, setUserConfig\] = useState/)
  assert.match(app, /tutorialConfig \? \{ \.\.\.userConfig, \.\.\.tutorialConfig \} : userConfig/)
})

test('the real config is frozen for the duration, at a single choke point', () => {
  // Plenty of code reads the current config, edits a field and writes it back. During a
  // tutorial "the current config" is the sandbox, so every one of those would fold the
  // scratch directory into the user's real settings if the setter did not refuse.
  assert.match(app, /const setConfig = useCallback\(\(update\) => \{\s+if \(isTutorialSandboxActive\(\)\) return/)
})

test('re-reading config is suppressed while the sandbox is up', () => {
  // Otherwise it looks up the sidecar for the scratch directory and writes its empty
  // genome list over the user's real one.
  assert.match(app, /if \(isTutorialSandboxActive\(\)\) return null/)
})

test('leaving a tutorial re-derives the session from the untouched config', () => {
  assert.match(app, /tutorialSandboxWasUpRef/)
  assert.match(app, /if \(handedBack\) \{[\s\S]*?fetchConfig\(\)/)
})

test('the browser focus is put back the way the tutorial found it', () => {
  // The config override covers settings, not component state. A tutorial that focuses one
  // of the demo genome's invented genes otherwise hands the session back still focused on
  // it — a gene none of the user's genomes contain, which blanks the track when cleared.
  assert.match(app, /preTutorialBrowserFocusRef/)
  assert.match(app, /const tookOver = !tutorialSandboxWasUpRef\.current && sandboxUp/)
  for (const setter of ['setBrowserRefGene', 'setBrowserTgtGene', 'setBrowserFocusByGenome']) {
    assert.match(app, new RegExp(`${setter}\\(saved\\?\\.`), `${setter} should be restored, not cleared`)
  }
})

test('the backend refuses to store a config pointing at the tutorial workspace', () => {
  // The frontend guards are timing-dependent; this one is a data invariant.
  assert.match(backendMain, /_is_tutorial_workspace_path\(getattr\(config, "output_dir", ""\)\)/)
})

test('config edits and genome choices are intercepted while a tutorial sandbox is present', () => {
  assert.match(app, /if \(tutorialConfig\) \{[\s\S]*?updateSandboxConfig\(nextConfig\)/)
  assert.match(app, /if \(tutorialConfig\) \{[\s\S]*?toggleTutorialGenome\(species, desired\)/)
})

test('leaving restores the session with no questions asked', () => {
  // The tutorial changed nothing of the user's, so there is nothing to offer a choice
  // about — it just hands the session back.
  assert.match(provider, /const exit = useCallback\(\(\) => \{/)
  assert.ok(!/restore: true/.test(overlay), 'there should be no restore-or-not choice on the way out')
  assert.match(provider, /resetTutorialWorkspace/)
})

test('an interrupted tutorial is swept on the next launch', () => {
  assert.match(app, /sweptTutorialWorkspaceRef/)
  assert.match(app, /resetTutorialWorkspace\(outputDir\)/)
})

test('the tutorial scratch directory lives inside the user output directory', () => {
  assert.match(backendDemo, /TUTORIAL_WORKSPACE_DIR = "\.ensembl_go_tutorial"/)
  // And the delete is narrow enough that a wrong output_dir cannot widen it.
  assert.match(backendDemo, /Refusing to remove anything but the tutorial workspace/)
})

test('Next performs the step rather than only advancing past it', () => {
  assert.match(provider, /const next = useCallback\(async \(options = \{\}\) => \{[\s\S]*?await performAction\(forStep\)/)
  assert.match(provider, /setPulseAnchor\(action\.anchor\)/)
})

test('Next leaves an already engaged toggle-like target alone', () => {
  assert.match(provider, /if \(action\.skipIfEngaged\)/)
  assert.match(provider, /getAttribute\('data-tutorial-engaged'\) === 'true'/)
})

test('a step in another app brings the user there — unless arriving is the step', () => {
  // Otherwise "Open Configuration" completes itself before the user has read it.
  assert.match(provider, /const arrivingIsTheTask = stepAdvance\(step\)\.type === 'view'/)
  assert.match(provider, /!== currentView && !arrivingIsTheTask\) navigateToView\(step\.view\)/)
})

test('preconditions run on arrival, so skipping cannot strand a later step', () => {
  assert.match(provider, /satisfyPreconditions/)
  for (const name of ['demo-genome-installed', 'demo-genome-active']) {
    assert.ok(provider.includes(`'${name}'`), `${name} should be satisfiable`)
  }
})

test('a direct jump waits for the focused gene to exist, not merely for Return to be pressed', () => {
  assert.match(provider, /for \(let attempt = 0; attempt < 5; attempt \+= 1\)/)
  assert.match(provider, /if \(isFocused\(\)\) return true/)
})

test('a direct jump into the note editor can create the tutorial note it skipped', () => {
  assert.match(provider, /for \(let attempt = 0; attempt < 3 && !findAnchor\('focus-note-body'\); attempt \+= 1\)/)
  assert.match(provider, /else clickAsTutorial\(findAnchor\('focus-notes-add'\)\)/)
})

test('autoplay is Next on a timer, and stops when the tutorial does', () => {
  assert.match(provider, /if \(!isRunning \|\| !autoplay \|\| busy\)/)
  assert.match(provider, /setTimeout\(\(\) => \{ next\(\{ automatic: true \}\) \}, remaining\)/)
})

test('autoplay publishes how long the step has, so the card can show it', () => {
  // Without a countdown, autoplay is a series of jumps with no way to tell whether the
  // tutorial is waiting for you or about to move on.
  assert.match(provider, /setAutoplayRun\(\{\s*\n\s*token:/)
  assert.match(provider, /stepDwellMs\(step\)/)
  assert.match(overlay, /autoplayRun && \(/)
  assert.match(overlay, /animation: `tutorial-trace \$\{autoplayRun\.ms\}ms linear \$\{autoplayRun\.delayMs \|\| 0\}ms forwards`/)
})

test('the tutorial has a cursor, and it travels before it clicks', () => {
  // An action taken on the user's behalf with nothing on screen to attribute it to reads
  // as the app misbehaving rather than as a demonstration.
  assert.match(provider, /const moveCursorTo = useCallback/)
  assert.match(provider, /const pressCursor = useCallback/)
  assert.match(provider, /await moveCursorTo\(node\)/)
  assert.match(provider, /await pressCursor\(\)/)
  assert.match(overlay, /data-tutorial-cursor="true"/)
  // The travel has to be an animated transition, or the cursor teleports — and it has to
  // take exactly as long as the runtime waits, or the two drift apart at other speeds.
  assert.match(overlay, /transition: `left \$\{cursorTravelMs\}ms/)
})

test('the cursor leaves once it has acted, rather than sitting on what it pressed', () => {
  // What happens next is usually visible exactly where it clicked — a box ticking, a
  // download filling in, text appearing — so a parked cursor hides its own result.
  assert.match(provider, /const hideCursor = useCallback/)
  assert.match(provider, /await pressCursor\(\)\s*\n\s*setPulseAnchor\(null\)\s*\n\s*hideCursor\(\)/)
})

test('text is typed a character at a time, not pasted in', () => {
  assert.match(provider, /const typeInto = useCallback/)
  assert.match(provider, /setNativeInputValue\(node, text\.slice\(0, i\)\)/)
  assert.match(provider, /await typeInto\(node, action\.value\)/)
})

test('what the tutorial just did is held on screen before anything transitions', () => {
  assert.match(provider, /holdUntilRef/)
  assert.match(provider, /const dispatchAfterHold = useCallback/)
  // The incoming app events are the ones that must wait; Next's own advance already has.
  assert.match(provider, /dispatchAfterHold\(\{ type: 'signal'/)
  assert.match(provider, /dispatchAfterHold\(\{ type: 'view'/)
})

test('autoplay has three speeds, shown as a level', () => {
  assert.equal(AUTOPLAY_SPEEDS.length, 3)
  assert.deepEqual(AUTOPLAY_SPEEDS.map((s) => s.id), ['slow', 'normal', 'fast'])
  assert.equal(AUTOPLAY_SPEEDS[DEFAULT_SPEED_INDEX].factor, 1)
  // Slower is slower and faster is faster, whatever the numbers end up being.
  assert.ok(AUTOPLAY_SPEEDS[0].factor > 1)
  assert.ok(AUTOPLAY_SPEEDS[2].factor < 1)
  assert.equal(speedFactor(99), 1, 'a stale index falls back to normal rather than breaking')
  // Filled up to the chosen index, so it reads as a level rather than three buttons.
  assert.match(overlay, /index <= speedIndex/)
})

test('every paced delay follows the chosen speed', () => {
  // A "faster" setting that only shortened the gap between steps would still crawl
  // through each one.
  for (const constant of ['CURSOR_TRAVEL_MS', 'PULSE_MS', 'SETTLE_MS', 'TYPE_CHAR_MS', 'ACTION_PAUSE_MS']) {
    assert.match(provider, new RegExp(`paced\\(${constant}\\)`), `${constant} should be paced`)
  }
  assert.match(provider, /paced\(stepDwellMs\(step\)\)/)
})

test('changing speed carries the countdown on rather than restarting the step', () => {
  // Restarting would punish someone for adjusting the speed while reading.
  assert.match(provider, /autoplayProgressRef/)
  assert.match(provider, /delayMs: -Math\.round\(totalMs \* done\)/)
})

test('how long a step is left up follows how much there is to read', () => {
  const short = stepDwellMs({ title: 'Hi', body: 'Press Next.' })
  const long = stepDwellMs({
    title: 'The controls for this genome',
    body: new Array(60).fill('word').join(' '),
  })
  assert.ok(long > short, 'a long step gets longer than a short one')
  assert.ok(short >= 4500, 'but a one-liner is still up long enough to register')
  assert.ok(long <= 15000, 'and a long one is not a hostage situation')
  assert.equal(stepDwellMs({ title: 'x', body: 'y', autoplayMs: 9000 }), 9000,
    'a step that is waiting for something, not being read, says so outright')
})

test('a step the user must act on pulses, not just glows', () => {
  assert.match(overlay, /interactive\s*\?\s*'tutorial-attention/)
  // The halo alone was too easy to miss on a busy panel; the edge colour swings too.
  assert.match(overlay, /tutorial-attention-edge/)
})

test('the tutorial cursor is a disc, not an arrow', () => {
  // An arrow is what the user's own pointer looks like, so one moving by itself reads as
  // the mouse having been taken over rather than as a demonstration.
  assert.match(overlay, /borderRadius: '9999px'/)
  assert.match(overlay, /tutorial-cursor-idle/)
})

test('a step can light up something extra without opening it to clicks', () => {
  // The download search lights the list it filters, so the filtering is seen rather than
  // described — but the blockers still cover it, so a stray click cannot derail the step.
  assert.match(overlay, /const cutouts = nonOverlappingRects\(\[padded, \.\.\.revealed\]\)/)
  assert.match(overlay, /cutoutPathD\(size, cutouts\)/)
  assert.match(overlay, /bands = interactive/)
  assert.match(provider, /allowed\.some\(\(entry\) => permits\(entry, event\)\)/)
  // And the card clears everything lit, not only the step's own target.
  assert.match(overlay, /const keepClearOf = unionRect\(\[padded, \.\.\.revealed\]/)
})

test('an allowed scroll region passes input through without becoming another visual highlight', () => {
  assert.match(overlay, /const scrollInteractionRects = useSelectorRects/)
  assert.match(overlay, /const liveArea = unionRect\(\[padded, \.\.\.revealed, \.\.\.scrollInteractionRects\]/)
  assert.match(overlay, /const cutouts = nonOverlappingRects\(\[padded, \.\.\.revealed\]\)/)
  assert.match(provider, /caps\.includes\('scroll'\)/)
})

test('spotlight geometry snaps to scrolling targets instead of easing behind them', () => {
  assert.match(overlay, /document\.addEventListener\('scroll', repair, true\)/)
  assert.doesNotMatch(overlay, /transition: 'left 140ms ease, top 140ms ease/)
})

test('a look-only step covers its own spotlight', () => {
  assert.match(overlay, /const bands = interactive\s*\?\s*blockerRects\(size, liveArea, 0\)\s*:\s*blockerRects\(size, null\)/)
})

test('the card is placed from its measured height, not a guess', () => {
  // A card positioned as though it were short runs off the bottom and hides its buttons.
  assert.match(overlay, /useLayoutEffect/)
  assert.match(overlay, /node\.getBoundingClientRect\?\.\(\)\.height/)
  assert.match(overlay, /placeCard\(size, keepClearOf, cardBox, preferred\)/)
  // And falls back to clearing the target alone when nothing clears all of it.
  assert.match(overlay, /placeCard\(size, padded, cardBox, preferred\)/)
  assert.match(overlay, /new ResizeObserver\(measure\)/)
  assert.match(overlay, /size\.width - \(CARD_MARGIN \* 2\)/)
  assert.match(overlay, /maxHeight: cardMaxHeight/)
})

test('anchors are clipped by scrolling ancestors before spotlights are drawn', () => {
  assert.match(overlay, /visibleElementRect\(node, viewportRect\(\)\)/)
  assert.match(provider, /visibleElementRect\(node, viewportRect\(\)\)/)
  assert.match(provider, /window\.addEventListener\('resize', repair\)/)
  assert.match(provider, /visualViewport\?\.addEventListener\?\.\('resize', repair\)/)
})

test('the provider is mounted above App, so the overlay can cover every app', () => {
  assert.match(main, /<TutorialProvider>[\s\S]*<App \/>[\s\S]*<\/TutorialProvider>/)
})

test('the overlay sits above every other layer in the app', () => {
  // The highest z-index in use elsewhere is z-[240]; the overlay must beat it.
  assert.match(overlay, /z-\[300\]/)
})

test('finishing or leaving returns to the Tutorials view', () => {
  // Otherwise the user is dropped wherever the last step happened to end, with no
  // obvious way back to the list.
  const dismissBlock = provider.slice(provider.indexOf('const dismiss ='), provider.indexOf('// ── Preconditions'))
  assert.match(dismissBlock, /navigatorRef\.current\?\.\('tutorials'\)/)
  const exitBlock = provider.slice(provider.indexOf('const exit ='), provider.indexOf('const dismiss ='))
  assert.match(exitBlock, /navigatorRef\.current\?\.\('tutorials'\)/)
})

test('the sandbox hides the user\'s own genomes, not just their output directory', () => {
  // Otherwise their real genomes, manual entries and playlists sit alongside the demo
  // one throughout the tutorial.
  assert.match(provider, /SANDBOX_BLANK_FIELDS/)
  for (const field of [
    'active_species',
    'manual_species',
    'genome_playlists',
    'next_previous_session_genomes',
    'ref_fasta',
    'ref_gff',
    'target_fasta',
    'target_gff',
  ]) {
    assert.ok(provider.includes(`${field}:`), `${field} should be blanked for the sandbox`)
  }
  assert.match(app, /const extras = tutorialConfig\s+\? \(tutorialConfig.tutorial_selected_genomes \|\| \[\]\)/)
  assert.match(app, /if \(!configLoaded \|\| tutorialConfig\) return/)
})

test('tutorial-only top bar changes never reach either persistent config store', () => {
  assert.match(app, /if \(!nextConfig \|\| isTutorialSandboxActive\(\)\) return false/)
  const persistBlock = app.slice(
    app.indexOf('const persistConfigToBackend'),
    app.indexOf('const persistNextPreviousSessionGenomes'),
  )
  assert.ok(
    persistBlock.indexOf('isTutorialSandboxActive()') < persistBlock.indexOf('saveElectronConfig'),
    'the sandbox guard must run before the direct Electron write',
  )
  const browserConfigBlock = app.slice(
    app.indexOf('const handleBrowserConfigChange'),
    app.indexOf('const handleSpeciesPillToggle'),
  )
  assert.match(browserConfigBlock, /if \(isTutorialSandboxActive\(\)\) \{[\s\S]*?return[\s\S]*?saveElectronConfig/)
})

test('a step that is done drops its highlight rather than holding it through the pause', () => {
  // The pause exists so a result appearing somewhere else can be watched arriving. A ring
  // left on the control for those two seconds points at something there is nothing left to
  // do with — and the search box has emptied itself by then, so it points at nothing at all.
  assert.match(provider, /const \[settledStepId, setSettledStepId\] = useState\(''\)/)
  // Only the event that actually finishes this step; a signal it is not waiting on, or a
  // click elsewhere, leaves the step exactly as it was.
  assert.match(provider, /if \(isAdvanceEventMatch\(stepRef\.current, event\)\) \{\s*\n\s*setSettledStepId/)
  // And only while the pause is actually being waited out.
  const dispatch = provider.slice(provider.indexOf('const dispatchAfterHold'))
  assert.match(dispatch.slice(0, 900), /if \(wait <= 0\) \{\s*\n\s*dispatch\(event\)/)
  // Cleared on the way to the next step, and on the way out.
  assert.match(provider, /setSettledStepId\(\(current\) => \(current && current !== id \? '' : current\)\)/)
  assert.match(provider, /holdUntilRef\.current = 0\s*\n\s*setSettledStepId\(''\)/)
  // The card and the cutout stay where they are: a step that is ending must not move the
  // card it is still being read from.
  assert.match(overlay, /const showSpotlightRing = stepShowsSpotlightRing\(step\) && !settled/)
  assert.doesNotMatch(overlay, /const padded = [^\n]*settled/)
})

test('a gene\'s own transcripts are set from the pill, not toggled', () => {
  const browser = readFileSync(new URL('../src/components/GenomeBrowser.jsx', import.meta.url), 'utf8')
  // The pill is DOM over the canvas, so it can carry an anchor directly.
  assert.match(browser, /data-tour-id=\{`browser-gene-transcripts-\$\{control\.id\}`\}/)
  // And it publishes which side of itself the gene is on, which is what lets the arrival
  // set the state rather than flip whatever it finds.
  assert.match(browser, /data-tutorial-engaged=\{control\.action === 'collapse' \? 'true' : 'false'\}/)
  assert.match(provider, /if \(wanted\.geneTranscripts\?\.gene\)/)
  assert.match(provider, /if \(pill && engaged\(anchor\) !== wantExpanded\)/)
  // Applied after the window-wide switches, which change what the pill is showing.
  const controls = provider.slice(provider.indexOf('const setBrowserControls'))
  assert.ok(
    controls.indexOf("engaged('browser-flatten')") < controls.indexOf('wanted.geneTranscripts?.gene'),
    'the per-gene pill must be pressed after Flatten and expand-all have settled'
  )
})

test('Flatten shrinks a track without taking the gene\'s own controls with it', () => {
  const browser = readFileSync(new URL('../src/components/GenomeBrowser.jsx', import.meta.url), 'utf8')
  // Flatten is a height control. It used to drop the footer overlay, the expanded footer
  // and the canvas gene label as well, which left a flattened gene with no name on it and
  // no way back — and a tutorial step pointing at that control with nothing to point at.
  assert.match(browser, /if \(compressTranscripts \|\| isViewportTranscriptExpandMode\) \{\s*\n\s*return \{ controls \}/)
  assert.match(browser, /const expandedGeneFooters = useMemo\(\(\) => \{\s*\n\s*if \(compressTranscripts \|\| isViewportTranscriptExpandMode\) return \[\]/)
  assert.match(browser, /if \(labelText && !hasExpandedFooterOverlay\) \{/)
  assert.match(browser, /footerStyleEnabled: !isCompressedLayoutActive,/)
  // And the room they need survives the shrink, or they would be drawn outside the track —
  // derived from the layout's own metrics, because a flattened row pitch needs more of it.
  assert.match(browser, /const geneFooterOverflow = isCompressedLayoutActive\s*\n\s*\? 0\s*\n\s*: geneFooterTrackOverflow\(transcriptLayoutMetrics, flattenTracks\)/)
  // With the ruler guard behind it, since a compact panel leaves no margin to overflow into.
  assert.match(browser, /if \(intersectsRuler\(label\.y - LABEL_ASCENT_PX, label\.y \+ LABEL_DESCENT_PX, RULER_Y, effectiveRulerHeight\)\) continue/)
  assert.match(browser, /if \(intersectsRuler\(rowTop, rowTop \+ TRANSCRIPT_FOOTER_CONTROL_HEIGHT, RULER_Y, effectiveRulerHeight\)\) \{/)
  // Compressed layouts still drop it: one or two pixels of padding and no footer to place.
  assert.doesNotMatch(browser, /compressTranscripts \|\| isViewportTranscriptExpandMode \|\| flattenTracks/)
})

test('a control the reader may activate may also report that it was activated', () => {
  // `change` is not typing. A checkbox emits it *as* its activation, so gating it on the
  // input capability meant the click landed, the tutorial's own listener advanced the
  // step, and React never heard that the box was ticked — a step that advanced without
  // doing anything. The Genome Selector's boxes escaped it only by being readOnly and
  // driven from onClick.
  assert.match(provider, /if \(event\.type === 'change'\) return caps\.includes\('input'\) \|\| caps\.includes\('activate'\)/)
  assert.match(provider, /if \(\['input', 'beforeinput'\]\.includes\(event\.type\)\) return caps\.includes\('input'\)/)
})

test('an arrival sets the gene-class filter as the tutorial, not as the reader', () => {
  // The guard governs the reader. An arrival pressing the boxes with a plain click goes
  // through it and is refused for any box the step did not happen to allow, so a step
  // could not establish the filter state its own card describes.
  const biotypes = provider.slice(provider.indexOf('wanted.biotypes !== undefined'))
  const block = biotypes.slice(0, biotypes.indexOf('runBrowserView'))
  assert.match(block, /clickAsTutorial\(box\)/)
  assert.doesNotMatch(block, /\bbox\.click\(\)/)
  // And it takes an explicit set, for a window that does not hold all four classes.
  assert.match(block, /Array\.isArray\(wanted\.biotypes\)/)
})

test("a locus a tutorial asks for lands where the reader can see it", () => {
  const browser = readFileSync(new URL('../src/components/GenomeBrowser.jsx', import.meta.url), 'utf8')
  // The drawer overlays the canvas, so a step naming a window around the focused gene
  // centres that gene behind it. Every other "put this on screen" path already goes
  // through frameFocusRange; the tutorial's own goToLocus called animateToView raw.
  const from = browser.indexOf('goToLocus: (text, ms) =>')
  const body = browser.slice(from, browser.indexOf('return true', from) + 11)
  assert.match(body, /const framed = frameFocusRange\(start, end\)/)
  assert.match(body, /animateToView\(framed\.start, framed\.end, duration\(ms\)\)/)
  assert.doesNotMatch(body, /animateToView\(start, end/)

  // The two halves of this that were already right, kept honest.
  const view = readFileSync(new URL('../src/components/GenomeBrowserView.jsx', import.meta.url), 'utf8')
  // Blind to the transcript detail: re-framing every time that panel opens would shuffle
  // the browser under someone who is reading metadata rather than the track.
  assert.match(view, /return isFocusDrawerOpen\(panelKey\) \? FOCUS_DRAWER_WIDTH : FOCUS_DRAWER_RAIL_WIDTH/)
  // And collapsing the drawer gives the uncovered space back to the gene.
  assert.match(browser, /rebalanceRangeForInsetChange\(\{/)
})

test("a transcript's hidden state is set from the drawer's own eye button", () => {
  const browser = readFileSync(new URL('../src/components/GenomeBrowser.jsx', import.meta.url), 'utf8')
  assert.match(browser, /data-tour-id=\{`browser-gene-hidden-transcripts-\$\{control\.id\}`\}/)
  // aria-pressed is false exactly when the transcript is hidden, so the arrival sets the
  // state rather than toggling whatever it finds — and presses as the tutorial, since the
  // step's own interaction policy has no say in what an arrival does.
  assert.match(provider, /if \(wanted\.hiddenTranscript\?\.transcript\)/)
  assert.match(provider, /eye\.getAttribute\('aria-pressed'\) === 'false'\) !== wantHidden/)
  const block = provider.slice(provider.indexOf('wanted.hiddenTranscript?.transcript'))
  assert.match(block.slice(0, 500), /clickAsTutorial\(eye\)/)
  // Three branches whose order is load-bearing in both directions. The drawer's fold has
  // to run first: collapsed, the drawer lists one row, so a non-canonical transcript's
  // show/hide button does not exist and the wait for it spends its whole budget failing —
  // which is exactly how jumping to the step about the hidden transcript came to hide
  // nothing and leave the step with no label to point at. And both have to run before the
  // per-gene pill, since restoring a transcript changes how many rows the gene shows.
  const controls = provider.slice(provider.indexOf('const setBrowserControls'))
  const at = (key) => controls.indexOf(key)
  assert.ok(
    at('wanted.drawerTranscripts !== undefined') < at('wanted.hiddenTranscript?.transcript'),
    'the drawer must be unfolded before a transcript in it can be hidden',
  )
  assert.ok(
    at('wanted.hiddenTranscript?.transcript') < at('wanted.geneTranscripts?.gene'),
    'the hidden transcript must be settled before the row count is',
  )
})

test('Next does not redo something the reader has already done', () => {
  // `skipIfEngaged` read one attribute on one anchor, and the step it was written for has
  // neither. It presses two sequence buttons; the legacy definition named a wrapper around
  // the pair that reports `data-tutorial-engaged`, but the portable document keeps only the
  // controls actually pressed, and those are buttons reporting `aria-pressed`. So a reader
  // who had pressed CDS or protein themselves still had to watch the cursor press both
  // again — eleven seconds of the tutorial ignoring what they had just done.
  const block = provider.slice(provider.indexOf('if (action.skipIfEngaged)'))
  assert.match(block.slice(0, 1600), /actionAnchors\(action\)\.some/)
  assert.match(block.slice(0, 1600), /data-tutorial-engaged'\) === 'true'/)
  assert.match(block.slice(0, 1600), /aria-pressed'\) === 'true'/)
})

test("the drawer's fold is waited for, not just looked up", () => {
  // On a direct jump the drawer mounts only once the gene has taken focus. A plain
  // lookup here found nothing about half the time, skipped the fold without a word, and
  // left every branch under it with a one-row list to work on — so the step about the
  // hidden transcript hid nothing and had no label to point at, intermittently.
  assert.match(provider, /const chevron = await waitForAnchor\('focus-transcripts-expand'\)/)
})

test('hiding a transcript for the reader does not leave a pointer behind', () => {
  // The drawer marks the row it just hid as hovered and ghosts that transcript on the
  // track, because a reader presses the button with the pointer sitting there. An arrival
  // has no pointer, so it has to release what the click implied, or the row stays lit and
  // the transcript stays ghosted for the whole step — competing with the highlight the
  // step actually made. React derives onMouseLeave from `mouseout`, so `mouseleave` alone
  // does not clear it.
  const block = provider.slice(provider.indexOf('wanted.hiddenTranscript?.transcript'))
  assert.match(block.slice(0, 1400), /new MouseEvent\('mouseout', \{ bubbles: true, relatedTarget: document\.body \}\)/)
})
