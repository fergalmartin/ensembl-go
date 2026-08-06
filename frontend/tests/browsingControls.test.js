import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSING_CONTROL_SCHEMES,
  BROWSING_CONTROL_SCHEME_IDS,
  DEFAULT_BROWSING_CONTROL_SCHEME_ID,
  WHEEL_LINE_HEIGHT_PX,
  WHEEL_ZOOM_MAX_EXPONENT,
  beginWheelGesture,
  describeBrowsingControls,
  isTextEntryTarget,
  isWheelHandled,
  markWheelHandled,
  normalizeBrowsingControlSchemeId,
  normalizeWheelDelta,
  pickNearestPanel,
  readWheelEvent,
  resolveBrowsingControls,
  resolveDragAxis,
  resolveKeyAction,
  resolveWheelAction,
  wheelZoomFactor,
} from '../src/utils/browsingControls.js'

const controlsFor = (id) => resolveBrowsingControls({ browsing_control_scheme: id })
const wheel = (over = {}) => ({ dx: 0, dy: 0, ctrl: false, shift: false, alt: false, ts: 0, ...over })

// ---------------------------------------------------------------------------
// normalizeWheelDelta
// ---------------------------------------------------------------------------

test('pixel-mode wheel deltas pass through unchanged', () => {
  assert.deepEqual(
    normalizeWheelDelta({ deltaMode: 0, deltaX: 12, deltaY: -100 }),
    { dx: 12, dy: -100 }
  )
})

test('line-mode wheel deltas scale to pixels', () => {
  // Firefox / some Linux mice: deltaMode 1 with deltaY around 3.
  assert.deepEqual(
    normalizeWheelDelta({ deltaMode: 1, deltaX: 0, deltaY: 3 }),
    { dx: 0, dy: 3 * WHEEL_LINE_HEIGHT_PX }
  )
})

test('page-mode wheel deltas scale by the supplied viewport height', () => {
  assert.deepEqual(
    normalizeWheelDelta({ deltaMode: 2, deltaX: 0, deltaY: 1 }, { pageHeight: 800 }),
    { dx: 0, dy: 800 }
  )
})

test('a missing deltaMode is treated as pixels', () => {
  assert.deepEqual(normalizeWheelDelta({ deltaX: 5, deltaY: 5 }), { dx: 5, dy: 5 })
})

test('non-finite or absent deltas normalise to zero rather than NaN', () => {
  assert.deepEqual(normalizeWheelDelta({}), { dx: 0, dy: 0 })
  assert.deepEqual(normalizeWheelDelta({ deltaX: NaN, deltaY: undefined }), { dx: 0, dy: 0 })
  assert.deepEqual(normalizeWheelDelta(null), { dx: 0, dy: 0 })
})

// ---------------------------------------------------------------------------
// wheelZoomFactor
// ---------------------------------------------------------------------------

test('zoom factor is always positive, whatever the delta', () => {
  // Regression: `1 + deltaY * 0.01` went negative for a real mouse wheel
  // (deltaY ~ -120 per notch), and the negative span was silently absorbed by
  // the MIN_VIEW_SPAN clamp, slamming the view to 50bp in a single notch.
  for (const delta of [-10000, -240, -120, -1, 0, 1, 120, 240, 10000]) {
    for (const sensitivity of [0.005, 0.01]) {
      const factor = wheelZoomFactor(delta, sensitivity)
      assert.ok(factor > 0, `factor for delta ${delta} @ ${sensitivity} must be > 0, got ${factor}`)
      assert.ok(Number.isFinite(factor), `factor for delta ${delta} must be finite`)
    }
  }
})

test('zoom direction is preserved: scrolling down widens the span', () => {
  assert.ok(wheelZoomFactor(100, 0.005) > 1)
  assert.ok(wheelZoomFactor(-100, 0.005) < 1)
  assert.equal(wheelZoomFactor(0, 0.005), 1)
})

test('a single event cannot exceed the per-event exponent cap', () => {
  const cap = Math.exp(WHEEL_ZOOM_MAX_EXPONENT)
  assert.equal(wheelZoomFactor(1e6, 0.01), cap)
  assert.equal(wheelZoomFactor(-1e6, 0.01), 1 / cap)
})

test('zooming in then out by the same delta returns to the original span', () => {
  // The old linear form failed this: 1.1 * 0.9 = 0.99, so a wheel wobble
  // drifted the zoom level.
  for (const delta of [5, 20, 60, 100]) {
    const round = wheelZoomFactor(delta, 0.005) * wheelZoomFactor(-delta, 0.005)
    assert.ok(Math.abs(round - 1) < 1e-9, `delta ${delta} round-trips to ${round}`)
  }
})

test('trackpad-sized deltas still feel like the previous linear response', () => {
  // The contract for the Default scheme: this change must not be perceptible
  // on a trackpad. Deltas there are small; a mouse notch (~120) is where the
  // exponential deliberately diverges, and where the old form was broken.
  const relativeError = (delta) => {
    const linear = 1 + delta * 0.005
    return Math.abs(wheelZoomFactor(delta, 0.005) - linear) / linear
  }
  // Measured bounds, not aspirational ones: exp(x) - (1 + x) grows as x^2/2,
  // and the relative error is worse for negative deltas because the linear
  // denominator shrinks.
  for (let delta = -20; delta <= 20; delta += 1) {
    assert.ok(relativeError(delta) < 0.006, `delta ${delta} drifted ${relativeError(delta)}`)
  }
  for (let delta = -40; delta <= 40; delta += 1) {
    assert.ok(relativeError(delta) < 0.024, `delta ${delta} drifted ${relativeError(delta)}`)
  }
})

test('a ctrl+wheel mouse notch no longer slams to maximum zoom', () => {
  // deltaY ~ -120 at the ctrl sensitivity of 0.01 previously gave -0.2, which
  // the MIN_VIEW_SPAN clamp turned into an instant jump to 50bp.
  const factor = wheelZoomFactor(-120, 0.01)
  assert.ok(factor > 0.5 && factor < 1, `expected a sane zoom-in step, got ${factor}`)
})

test('a zero or non-finite sensitivity is a no-op rather than NaN', () => {
  assert.equal(wheelZoomFactor(100, 0), 1)
  assert.equal(wheelZoomFactor(100, NaN), 1)
  assert.equal(wheelZoomFactor(NaN, 0.005), 1)
})

// ---------------------------------------------------------------------------
// Scheme normalisation and identity stability
// ---------------------------------------------------------------------------

test('unknown, missing or malformed scheme ids fall back to default', () => {
  for (const bad of [undefined, null, '', 'nope', 42, [], {}, ' ']) {
    assert.equal(normalizeBrowsingControlSchemeId(bad), DEFAULT_BROWSING_CONTROL_SCHEME_ID)
  }
})

test('every advertised scheme id resolves to itself', () => {
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    assert.equal(normalizeBrowsingControlSchemeId(id), id)
  }
})

test('resolving never throws on junk config shapes', () => {
  for (const bad of [null, undefined, 'x', [], 7, { browsing_control_scheme: {} }]) {
    const controls = resolveBrowsingControls(bad)
    assert.equal(controls.schemeId, DEFAULT_BROWSING_CONTROL_SCHEME_ID)
  }
})

test('structurally equal configs resolve to the SAME object', () => {
  // Load-bearing: `config` gets a fresh identity on every autosave, including
  // autosaves from unrelated edits. A new controls object each time would land
  // in the wheel listener's dependency array and re-register it mid-gesture.
  const a = resolveBrowsingControls({ browsing_control_scheme: 'wheel_scrolls' })
  const b = resolveBrowsingControls({ browsing_control_scheme: 'wheel_scrolls', other: 1 })
  assert.equal(a, b)
  assert.equal(resolveBrowsingControls(null), resolveBrowsingControls({}))
})

test('resolved controls are frozen', () => {
  const controls = controlsFor('default')
  assert.throws(() => { controls.zoomSensitivity = 99 }, TypeError)
  assert.throws(() => { controls.wheel.plain_vertical = 'none' }, TypeError)
})

test('every scheme carries a label and a description for the settings UI', () => {
  assert.equal(BROWSING_CONTROL_SCHEMES.length, 3)
  for (const scheme of BROWSING_CONTROL_SCHEMES) {
    assert.ok(scheme.label.length > 0, `${scheme.id} needs a label`)
    assert.ok(scheme.description.length > 40, `${scheme.id} needs a real description`)
  }
})

// ---------------------------------------------------------------------------
// readWheelEvent
// ---------------------------------------------------------------------------

test('meta is folded into ctrl so macOS pinch and Firefox behave alike', () => {
  assert.equal(readWheelEvent({ deltaY: 1, metaKey: true }).ctrl, true)
  assert.equal(readWheelEvent({ deltaY: 1, ctrlKey: true }).ctrl, true)
  assert.equal(readWheelEvent({ deltaY: 1 }).ctrl, false)
})

// ---------------------------------------------------------------------------
// The wheel truth table
// ---------------------------------------------------------------------------

test('default scheme: plain wheel zooms, sideways pans', () => {
  const c = controlsFor('default')
  assert.equal(resolveWheelAction(wheel({ dy: 40 }), c, {}).type, 'zoom')
  assert.equal(resolveWheelAction(wheel({ dx: 40 }), c, {}).type, 'pan')
})

test('wheel_scrolls scheme: plain wheel scrolls the page, ctrl zooms, shift pans', () => {
  const c = controlsFor('wheel_scrolls')
  assert.equal(resolveWheelAction(wheel({ dy: 40 }), c, {}).type, 'page_scroll')
  assert.equal(resolveWheelAction(wheel({ dy: 40, ctrl: true }), c, {}).type, 'zoom')
  assert.equal(resolveWheelAction(wheel({ dy: 40, shift: true }), c, {}).type, 'pan')
  assert.equal(resolveWheelAction(wheel({ dx: 40 }), c, {}).type, 'pan')
})

test('wheel_pans scheme: plain wheel pans, ctrl zooms, shift scrolls the page', () => {
  const c = controlsFor('wheel_pans')
  assert.equal(resolveWheelAction(wheel({ dy: 40 }), c, {}).type, 'pan')
  assert.equal(resolveWheelAction(wheel({ dy: 40, ctrl: true }), c, {}).type, 'zoom')
  assert.equal(resolveWheelAction(wheel({ dy: 40, shift: true }), c, {}).type, 'page_scroll')
})

test('every scheme offers some pointer zoom gesture', () => {
  // Which gesture zooms differs by scheme — plain wheel in Default, ctrl/pinch
  // in the others — but a scheme with no pointer zoom at all would be unusable.
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    const c = controlsFor(id)
    const zooms = [
      resolveWheelAction(wheel({ dy: 40 }), c, {}),
      resolveWheelAction(wheel({ dy: 40, ctrl: true }), c, {}),
      resolveWheelAction(wheel({ dy: 40, shift: true }), c, {}),
    ].some((i) => i.type === 'zoom')
    assert.ok(zooms, `${id} has no pointer zoom gesture`)
  }
})

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('ctrl+wheel ALWAYS prevents default, in every scheme and every branch', () => {
  // Otherwise Chromium applies page zoom to the whole Electron window, which
  // desyncs the canvas backing-store DPR until the app restarts.
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    const c = controlsFor(id)
    for (const w of [
      wheel({ dy: 40, ctrl: true }),
      wheel({ dx: 40, ctrl: true }),
      wheel({ dy: 0.1, ctrl: true }),   // inside the dead zone
      wheel({ dy: 0, dx: 0, ctrl: true }),
    ]) {
      assert.equal(resolveWheelAction(w, c, {}).preventDefault, true, `${id} leaked a ctrl+wheel`)
    }
  }
})

test('a scheme that binds ctrl to nothing still prevents browser page zoom', () => {
  const rogue = { ...controlsFor('default'), wheel: { ...controlsFor('default').wheel, ctrl_vertical: 'none' } }
  const intent = resolveWheelAction(wheel({ dy: 40, ctrl: true }), rogue, {})
  assert.equal(intent.type, 'none')
  assert.equal(intent.preventDefault, true)
})

test('page_scroll never prevents default and never stops propagation', () => {
  // Preventing would stop the page scrolling at all; stopping propagation would
  // hide the event from the ancestor fallback listener.
  const intent = resolveWheelAction(wheel({ dy: 40 }), controlsFor('wheel_scrolls'), {})
  assert.equal(intent.type, 'page_scroll')
  assert.equal(intent.preventDefault, false)
  assert.equal(intent.stopPropagation, false)
  assert.equal(intent.releaseScrollAnchors, true)
})

test('tiny deltas are ignored as noise', () => {
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    assert.equal(resolveWheelAction(wheel({ dy: 0.4 }), controlsFor(id), {}).type, 'none')
    assert.equal(resolveWheelAction(wheel({ dy: 0.5 }), controlsFor(id), {}).type, 'none')
  }
})

test('page_scroll degrades to a no-op when there is nothing to scroll', () => {
  const intent = resolveWheelAction(wheel({ dy: 40 }), controlsFor('wheel_scrolls'), { canScrollPage: false })
  assert.equal(intent.type, 'none')
  assert.equal(intent.preventDefault, false)
})

test('pan intents carry a ready-to-use pixel delta', () => {
  const intent = resolveWheelAction(wheel({ dx: 30 }), controlsFor('default'), {})
  assert.equal(intent.type, 'pan')
  assert.equal(intent.dxPx, 60)   // amplification already applied
  assert.equal(intent.preventDefault, true)
})

// ---------------------------------------------------------------------------
// At-extent hand-off
// ---------------------------------------------------------------------------

test('zooming out at the maximum span hands off to page scrolling', () => {
  const intent = resolveWheelAction(wheel({ dy: 40 }), controlsFor('default'), { atMaxZoom: true })
  assert.equal(intent.type, 'page_scroll')
})

test('zooming IN at the maximum span still zooms', () => {
  const intent = resolveWheelAction(wheel({ dy: -40 }), controlsFor('default'), { atMaxZoom: true })
  assert.equal(intent.type, 'zoom')
})

test('the hand-off does not fire when there is nowhere to scroll', () => {
  const intent = resolveWheelAction(wheel({ dy: 40 }), controlsFor('default'), { atMaxZoom: true, canScrollPage: false })
  assert.equal(intent.type, 'zoom')
})

test('an explicit ctrl+wheel zoom never hands off', () => {
  // Holding ctrl is an explicit request to zoom; silently scrolling instead
  // would be surprising.
  const intent = resolveWheelAction(wheel({ dy: 40, ctrl: true }), controlsFor('wheel_scrolls'), { atMaxZoom: true })
  assert.equal(intent.type, 'zoom')
})

test('a latched hand-off keeps scrolling for the rest of the fling', () => {
  const intent = resolveWheelAction(
    wheel({ dy: 40 }),
    controlsFor('default'),
    { atMaxZoom: false, gesture: { mode: 'scroll' } }
  )
  assert.equal(intent.type, 'page_scroll')
})

// ---------------------------------------------------------------------------
// Gesture latch
// ---------------------------------------------------------------------------

test('a gesture continues while kind, direction and timing all agree', () => {
  const first = beginWheelGesture(null, wheel({ dy: 40 }), 1000)
  first.mode = 'scroll'
  const next = beginWheelGesture(first, wheel({ dy: 30 }), 1100)
  assert.equal(next.mode, 'scroll')
})

test('reversing direction restarts the gesture', () => {
  const first = { kind: 'vertical', direction: 1, mode: 'scroll', lastTs: 1000 }
  assert.equal(beginWheelGesture(first, wheel({ dy: -30 }), 1050).mode, '')
})

test('a pause longer than the idle window restarts the gesture', () => {
  const first = { kind: 'vertical', direction: 1, mode: 'scroll', lastTs: 1000 }
  assert.equal(beginWheelGesture(first, wheel({ dy: 30 }), 1400).mode, '')
})

test('switching axis restarts the gesture', () => {
  const first = { kind: 'vertical', direction: 1, mode: 'zoom', lastTs: 1000 }
  assert.equal(beginWheelGesture(first, wheel({ dx: 30 }), 1050).mode, '')
})

// ---------------------------------------------------------------------------
// Drag axis
// ---------------------------------------------------------------------------

test('drag does nothing until it clears the threshold', () => {
  assert.equal(resolveDragAxis({ dx: 3, dy: 3, canScrollPage: true }), null)
  assert.equal(resolveDragAxis({ dx: 5, dy: 5, canScrollPage: true }), null)
  assert.ok(resolveDragAxis({ dx: 6, dy: 0, canScrollPage: true }))
})

test('an already-locked axis is never revisited mid-drag', () => {
  assert.equal(resolveDragAxis({ dx: 100, dy: 0, canScrollPage: true, currentAxis: 'y' }), 'y')
  assert.equal(resolveDragAxis({ dx: 0, dy: 100, canScrollPage: true, currentAxis: 'x' }), 'x')
})

test('drag is biased towards scrolling when the page can scroll', () => {
  // ~37 degrees from vertical still scrolls, so moving between genomes is easy.
  assert.equal(resolveDragAxis({ dx: 10, dy: 8, canScrollPage: true }), 'y')
  assert.equal(resolveDragAxis({ dx: 10, dy: 8, canScrollPage: false }), 'x')
})

test('without a page scroller the drag falls back to plain axis dominance', () => {
  assert.equal(resolveDragAxis({ dx: 20, dy: 10, canScrollPage: false }), 'x')
  assert.equal(resolveDragAxis({ dx: 10, dy: 20, canScrollPage: false }), 'y')
})

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

test('arrow keys pan, with a bigger step on shift and a fine step on alt', () => {
  assert.deepEqual(resolveKeyAction({ key: 'ArrowRight' }).dxFraction, 0.1)
  assert.deepEqual(resolveKeyAction({ key: 'ArrowLeft' }).dxFraction, -0.1)
  assert.equal(resolveKeyAction({ key: 'ArrowRight', shift: true }).dxFraction, 0.5)
  assert.equal(resolveKeyAction({ key: 'ArrowRight', alt: true }).fineStep, true)
})

test('plus and minus zoom, and shift doubles the step', () => {
  assert.ok(resolveKeyAction({ key: '+' }).factor < 1)
  assert.ok(resolveKeyAction({ key: '-' }).factor > 1)
  assert.equal(resolveKeyAction({ key: '=' }).factor, resolveKeyAction({ key: '+' }).factor)
  assert.equal(resolveKeyAction({ key: '-', shift: true }).factor, 2)
})

test('up and down arrows are deliberately unbound so the page scrolls', () => {
  for (const key of ['ArrowUp', 'ArrowDown']) {
    const intent = resolveKeyAction({ key })
    assert.equal(intent.type, 'none')
    assert.equal(intent.preventDefault, false, 'must not swallow native page scrolling')
  }
})

test('meta-modified keys are left to the OS and the app', () => {
  assert.equal(resolveKeyAction({ key: 'ArrowRight', meta: true }).type, 'none')
  assert.equal(resolveKeyAction({ key: '+', meta: true }).type, 'none')
})

test('navigation and framing keys resolve as expected', () => {
  assert.deepEqual(resolveKeyAction({ key: 'Home' }), { type: 'jump', edge: 'start', preventDefault: true })
  assert.deepEqual(resolveKeyAction({ key: 'End' }), { type: 'jump', edge: 'end', preventDefault: true })
  assert.equal(resolveKeyAction({ key: 'PageDown' }).dxFraction, 1)
  assert.equal(resolveKeyAction({ key: '0' }).scope, 'chromosome')
  assert.equal(resolveKeyAction({ key: 'f' }).scope, 'gene')
  assert.equal(resolveKeyAction({ key: 'Escape' }).type, 'dismiss')
})

test('unrecognised keys are ignored without swallowing them', () => {
  const intent = resolveKeyAction({ key: 'q' })
  assert.equal(intent.type, 'none')
  assert.equal(intent.preventDefault, false)
})

// ---------------------------------------------------------------------------
// Text entry guard
// ---------------------------------------------------------------------------

test('text entry targets are detected without a DOM', () => {
  assert.equal(isTextEntryTarget({ tagName: 'INPUT' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'textarea' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTextEntryTarget({ tagName: 'DIV' }), false)
  assert.equal(isTextEntryTarget(null), false)
})

// ---------------------------------------------------------------------------
// Handled-event marking
// ---------------------------------------------------------------------------

test('an event can be marked handled so an ancestor listener can stand down', () => {
  const event = { deltaY: 1 }
  assert.equal(isWheelHandled(event), false)
  markWheelHandled(event)
  assert.equal(isWheelHandled(event), true)
  assert.equal(isWheelHandled({ deltaY: 1 }), false)
  markWheelHandled(null)   // must not throw
})

// ---------------------------------------------------------------------------
// Nearest panel
// ---------------------------------------------------------------------------

const RECTS = [
  { panelKey: 'a', top: 100, bottom: 200, left: 50, right: 500 },
  { panelKey: 'b', top: 202, bottom: 300, left: 50, right: 500 },
]

test('a point inside a panel picks that panel', () => {
  assert.deepEqual(pickNearestPanel(150, 100, RECTS), { panelKey: 'a', insideVertically: true, insideHorizontally: true })
  assert.equal(pickNearestPanel(250, 100, RECTS).panelKey, 'b')
})

test('the divider between two panels resolves deterministically', () => {
  // 201 is 1px from both. Ties go to the earlier panel, every time.
  assert.equal(pickNearestPanel(201, 100, RECTS).panelKey, 'a')
  assert.equal(pickNearestPanel(201, 100, RECTS).panelKey, 'a')
})

test('a point in the page padding picks the nearest panel', () => {
  assert.equal(pickNearestPanel(10, 100, RECTS).panelKey, 'a')
  assert.equal(pickNearestPanel(900, 100, RECTS).panelKey, 'b')
  assert.equal(pickNearestPanel(10, 100, RECTS).insideVertically, false)
})

test('a point outside horizontally is reported so the caller can centre the zoom', () => {
  assert.equal(pickNearestPanel(150, 900, RECTS).insideHorizontally, false)
  assert.equal(pickNearestPanel(150, 300, RECTS).insideHorizontally, true)
})

test('nearest panel copes with an empty or malformed list', () => {
  assert.equal(pickNearestPanel(150, 100, []), null)
  assert.equal(pickNearestPanel(150, 100, null), null)
  assert.equal(pickNearestPanel(NaN, 100, RECTS), null)
  assert.equal(pickNearestPanel(150, 100, [null, { panelKey: 'x' }]), null)
})

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

test('the cheat sheet describes the selected scheme and never drifts', () => {
  const rows = describeBrowsingControls(controlsFor('wheel_scrolls'))
  assert.equal(rows.find((r) => r.gesture === 'Wheel up/down').action, 'Scroll the page up and down')
  assert.equal(
    rows.find((r) => r.gesture.startsWith('Ctrl')).action,
    'Zoom on the position under the cursor'
  )
  assert.ok(rows.every((r) => r.gesture && r.action))
})

test('the trackpad cheat sheet describes the same mapping in trackpad language', () => {
  // A pinch arrives as ctrl+wheel, so the mapping is identical and only the
  // wording changes. Both tabs must therefore agree action-for-action.
  const mouse = describeBrowsingControls(controlsFor('wheel_scrolls'), 'mouse')
  const pad = describeBrowsingControls(controlsFor('wheel_scrolls'), 'trackpad')

  assert.equal(pad.find((r) => r.gesture === 'Two-finger swipe up/down').action, 'Scroll the page up and down')
  assert.equal(
    pad.find((r) => r.gesture.startsWith('Pinch')).action,
    'Zoom on the position under the cursor'
  )
  const padActions = pad.map((r) => r.action)
  const mouseActions = mouse.map((r) => r.action)
  assert.deepEqual(padActions, mouseActions.slice(0, padActions.length))
})

test('keyboard rows appear only under the tab that names the keyboard', () => {
  const mouse = describeBrowsingControls(controlsFor('default'), 'mouse')
  const pad = describeBrowsingControls(controlsFor('default'), 'trackpad')
  assert.ok(mouse.some((r) => r.gesture === '+ / -'))
  assert.ok(!pad.some((r) => r.gesture === '+ / -'))
})

test('an unknown device falls back to the mouse wording', () => {
  assert.deepEqual(
    describeBrowsingControls(controlsFor('default'), 'nonsense'),
    describeBrowsingControls(controlsFor('default'), 'mouse')
  )
})

test('the renamed scheme still resolves from its old saved id', () => {
  // Anyone who selected this before the rename must not silently fall back to
  // Default on their next launch.
  assert.equal(normalizeBrowsingControlSchemeId('mouse_keyboard'), 'wheel_scrolls')
  assert.equal(
    resolveBrowsingControls({ browsing_control_scheme: 'mouse_keyboard' }),
    resolveBrowsingControls({ browsing_control_scheme: 'wheel_scrolls' })
  )
})

test('a modifier that does nothing extra is not listed as its own control', () => {
  // Default binds plain, ctrl and shift vertical wheel all to zoom. Listing all
  // three is three ways of describing one control, so only the simplest survives.
  const rows = describeBrowsingControls(controlsFor('default'), 'mouse')
  const gestures = rows.map((r) => r.gesture)
  assert.ok(gestures.includes('Wheel up/down'))
  assert.ok(!gestures.some((g) => g.startsWith('Ctrl')), 'ctrl row should be collapsed away')
  assert.ok(!gestures.some((g) => g.startsWith('Shift')), 'shift row should be collapsed away')
  assert.ok(!gestures.some((g) => g.startsWith('Alt')), 'alt row should be collapsed away')
})

test('a modifier that changes the action is still listed', () => {
  const rows = describeBrowsingControls(controlsFor('wheel_scrolls'), 'mouse')
  const by = Object.fromEntries(rows.map((r) => [r.gesture, r.action]))
  assert.equal(by['Wheel up/down'], 'Scroll the page up and down')
  assert.equal(by['Ctrl (or ⌘) + wheel up/down'], 'Zoom on the position under the cursor')
  assert.equal(by['Shift + wheel up/down'], 'Move along the chromosome')
})

test('distinct controls that share an action are both kept', () => {
  // Wheel sideways and drag sideways both pan, but they are different controls,
  // not one control described twice — a user needs to know about each.
  const rows = describeBrowsingControls(controlsFor('default'), 'mouse')
  const panning = rows.filter((r) => r.action === 'Move along the chromosome').map((r) => r.gesture)
  assert.ok(panning.includes('Wheel sideways'))
  assert.ok(panning.includes('Drag sideways'))
})

test('Default leaves pinch unbound so two-finger swipe is the only zoom gesture', () => {
  const rows = describeBrowsingControls(controlsFor('default'), 'trackpad')
  const gestures = rows.map((r) => r.gesture)
  assert.ok(gestures.includes('Two-finger swipe up/down'))
  assert.ok(!gestures.some((g) => g.startsWith('Pinch')), 'pinch must not be offered here')
  assert.ok(!gestures.some((g) => g.startsWith('Shift')), 'shift+swipe adds nothing here')
})

test('an unbound pinch still suppresses the browser page zoom', () => {
  // Leaving ctrl unbound must never mean "let it through": an unprevented
  // ctrl+wheel page-zooms the whole Electron window and breaks canvas DPR.
  const intent = resolveWheelAction(wheel({ dy: 40, ctrl: true }), controlsFor('default'), {})
  assert.equal(intent.type, 'none')
  assert.equal(intent.preventDefault, true)
})

test('schemes whose wheel is not zoom keep pinch as their pointer zoom', () => {
  for (const id of ['wheel_scrolls', 'wheel_pans']) {
    const gestures = describeBrowsingControls(controlsFor(id), 'trackpad').map((r) => r.gesture)
    assert.ok(gestures.some((g) => g.startsWith('Pinch')), `${id} needs a pointer zoom gesture`)
  }
})

test('unbound gestures are omitted rather than listed as doing nothing', () => {
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    for (const device of ['mouse', 'trackpad']) {
      const actions = describeBrowsingControls(controlsFor(id), device).map((r) => r.action)
      assert.ok(!actions.includes('Nothing'), `${id}/${device} lists a do-nothing row`)
    }
  }
})

test('no scheme lists the same gesture wording twice', () => {
  for (const id of BROWSING_CONTROL_SCHEME_IDS) {
    for (const device of ['mouse', 'trackpad']) {
      const gestures = describeBrowsingControls(controlsFor(id), device).map((r) => r.gesture)
      assert.equal(new Set(gestures).size, gestures.length, `${id}/${device} has duplicate rows`)
    }
  }
})

test('the default scheme cheat sheet reports zooming on the plain wheel', () => {
  const rows = describeBrowsingControls(controlsFor('default'))
  assert.equal(rows.find((r) => r.gesture === 'Wheel up/down').action, 'Zoom on the position under the cursor')
})

// ---------------------------------------------------------------------------
// Per-view tuning overrides
// ---------------------------------------------------------------------------

test('tuning overrides change the rate without changing the mapping', () => {
    const base = controlsFor('default')
    const gentle = resolveBrowsingControls(
        { browsing_control_scheme: 'default' },
        { zoomSensitivity: 0.00195, panAmplification: 1 }
    )
    assert.deepEqual(gentle.wheel, base.wheel, 'the gesture mapping is the user\'s choice, not the view\'s')
    assert.equal(gentle.zoomSensitivity, 0.00195)
    assert.equal(gentle.panAmplification, 1)
    assert.equal(gentle.pinchSensitivity, base.pinchSensitivity, 'unspecified keys keep the default')

    const strong = resolveWheelAction(wheel({ dy: 100 }), base, {}).factor
    const weak = resolveWheelAction(wheel({ dy: 100 }), gentle, {}).factor
    assert.ok(weak < strong, 'a lower sensitivity must zoom less per event')
})

test('tuned controls stay identity-stable across calls', () => {
    // Views pass a frozen module-level tuning object on every render; a fresh
    // controls object each time would re-register their wheel listener.
    const tuning = { zoomSensitivity: 0.0012, panAmplification: 1.6 }
    const first = resolveBrowsingControls({ browsing_control_scheme: 'wheel_pans' }, tuning)
    const second = resolveBrowsingControls({ browsing_control_scheme: 'wheel_pans' }, { ...tuning })
    assert.equal(first, second)
    assert.notEqual(first, controlsFor('wheel_pans'), 'untuned controls are a different object')
})

test('junk tuning values are ignored rather than throwing', () => {
    const base = controlsFor('default')
    for (const junk of [null, 'x', [], { zoomSensitivity: 'fast' }, { panAmplification: -3 }, { panAmplification: 0 }]) {
        const resolved = resolveBrowsingControls({ browsing_control_scheme: 'default' }, junk)
        assert.equal(resolved.zoomSensitivity, base.zoomSensitivity)
        assert.equal(resolved.panAmplification, base.panAmplification)
    }
})

// ---------------------------------------------------------------------------
// Surface capabilities
// ---------------------------------------------------------------------------

test('a surface that cannot zoom pans instead', () => {
    // The neighbourhood track has no zoom. Degrading to pan keeps every scheme
    // usable there rather than leaving the wheel dead under Default.
    const intent = resolveWheelAction(wheel({ dy: 60 }), controlsFor('default'), { canZoom: false })
    assert.equal(intent.type, 'pan')
    assert.equal(intent.preventDefault, true)
})

test('canZoom false does not turn a page_scroll binding into a pan', () => {
    const intent = resolveWheelAction(
        wheel({ dy: 60 }),
        controlsFor('wheel_scrolls'),
        { canZoom: false, canScrollPage: true }
    )
    assert.equal(intent.type, 'page_scroll')
})

test('the three schemes give a plain vertical wheel three different meanings', () => {
    // This is the whole point of the setting. A surface that reports
    // canScrollPage incorrectly collapses wheel_scrolls into one of the others,
    // which is exactly the bug this guards.
    const seen = new Map()
    for (const id of BROWSING_CONTROL_SCHEME_IDS) {
        const intent = resolveWheelAction(wheel({ dy: 60 }), controlsFor(id), { canScrollPage: true })
        seen.set(id, intent.type)
    }
    assert.deepEqual(
        [seen.get('default'), seen.get('wheel_scrolls'), seen.get('wheel_pans')],
        ['zoom', 'page_scroll', 'pan']
    )
})

// ---------------------------------------------------------------------------
// Gesture continuity
// ---------------------------------------------------------------------------

test('beginWheelGesture reports whether it continued the previous gesture', () => {
    const first = beginWheelGesture(null, wheel({ dy: 20 }), 1000)
    assert.equal(first.continues, false)
    const second = beginWheelGesture(first, wheel({ dy: 20 }), 1050)
    assert.equal(second.continues, true)
    const reversed = beginWheelGesture(second, wheel({ dy: -20 }), 1080)
    assert.equal(reversed.continues, false)
    const late = beginWheelGesture(second, wheel({ dy: 20 }), 1400)
    assert.equal(late.continues, false)
})

// ---------------------------------------------------------------------------
// The magnification model used by the alignment panels
// ---------------------------------------------------------------------------

test('wheelZoomFactor is safe to divide by for a magnification-based view', () => {
    // AlignmentPanel/MultiAlignmentPanel track `zoomLevel` (a magnification),
    // not a genomic span, so they apply the factor as `zoom / factor`. That is
    // only correct if the factor is strictly positive and sign-symmetric — the
    // old `1 - deltaY * sensitivity` was neither, and one ctrl+wheel notch
    // (deltaY 120, sensitivity 0.01) gave -0.2.
    assert.equal(1 - 120 * 0.01 < 0, true, 'the old formula really did go negative')

    for (const delta of [-10000, -240, -120, -3, 3, 120, 240, 10000]) {
        for (const sensitivity of [0.005, 0.01]) {
            const factor = wheelZoomFactor(delta, sensitivity)
            assert.ok(factor > 0, `factor must stay positive (delta ${delta})`)
            assert.ok(Number.isFinite(1 / factor), `1/factor must be usable (delta ${delta})`)
        }
    }

    // Scrolling down (positive delta) must reduce magnification, i.e. zoom out,
    // which is the same direction the span-based views zoom.
    const zoom = 1
    assert.ok(zoom / wheelZoomFactor(120, 0.005) < zoom, 'wheel down zooms out')
    assert.ok(zoom / wheelZoomFactor(-120, 0.005) > zoom, 'wheel up zooms in')

    // Zoom in then back out returns to where it started.
    const roundTrip = (zoom / wheelZoomFactor(60, 0.005)) / wheelZoomFactor(-60, 0.005)
    assert.ok(Math.abs(roundTrip - zoom) < 1e-9, 'zooming in and out is lossless')
})
