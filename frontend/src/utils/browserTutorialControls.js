// The handles a tutorial needs into the genome browser, without threading a single prop.
//
// The browser has no zoom buttons and no slider. Panning is a drag or the arrow keys and
// zooming is the wheel or `+`/`-`, which is fine for a person and leaves a tutorial with
// nothing to click on the user's behalf. Adding buttons purely so the tutorial could
// press them would teach a control nobody otherwise uses.
//
// So each browser panel publishes the three moves it can make, and the tutorial runtime
// calls them. Deliberately a module-level registry rather than context or a ref chain:
// the tutorial overlay sits above App and reaches everything else through
// `document.querySelector`, and this keeps that property — nothing in the component tree
// has to know a tutorial exists.
//
// Nothing here does any work of its own. Moving goes through the panel's own
// `animateToView`, so a tutorial's pan travels at the same speed and stops at the same
// edges as one the user performs; deleting a note goes through the same handler the
// note UI uses, so the store and the drawer stay in step rather than the tutorial
// deleting server-side and leaving a ghost on screen.

const panels = new Map()

/** Publish a panel's viewport controls. Returns the deregistration function.
 *
 *  `controls` is `{ panByWindows(fraction), zoomBy(factor), goToLocus(text), describe() }`.
 */
export function registerBrowserViewport(panelKey, controls) {
  const key = String(panelKey || '').trim()
  if (!key || !controls) return () => {}
  panels.set(key, controls)
  return () => {
    if (panels.get(key) === controls) panels.delete(key)
  }
}

/** The named panel's controls, or — when nothing is named — the only one there is.
 *
 *  A tutorial runs on one genome, so "the first panel" is the right default. Naming one
 *  matters only if a tutorial ever activates two. */
export function browserViewportControls(panelKey) {
  const key = String(panelKey || '').trim()
  if (key) return panels.get(key) || null
  const first = panels.values().next()
  return first.done ? null : first.value
}

/** Perform one move. Returns false when there is no browser panel to move, so a caller
 *  can decide whether that is worth reporting. */
export function moveBrowserViewport(move = {}) {
  const controls = browserViewportControls(move.panelKey)
  if (!controls) return false
  if (move.locus !== undefined) return Boolean(controls.goToLocus?.(String(move.locus), move.durationMs))
  if (move.zoom !== undefined) return Boolean(controls.zoomBy?.(Number(move.zoom), move.durationMs))
  if (move.pan !== undefined) return Boolean(controls.panByWindows?.(Number(move.pan), move.durationMs))
  return false
}

/** Whether two viewport descriptions are the same place.
 *
 *  Rounded, because a view that has settled after an animation is not bit-identical to
 *  the numbers it was asked for, and a step must not think the user moved when they only
 *  watched the tutorial move. */
export function sameBrowserViewport(a, b) {
  if (!a || !b) return false
  if (String(a.chrom || '') !== String(b.chrom || '')) return false
  const near = (x, y) => Math.abs(Number(x) - Number(y)) <= Math.max(2, Math.abs(Number(y)) * 0.001)
  return near(a.start, b.start) && near(a.end, b.end)
}

/** Put the panel's own scroll back to the top, so a step measures its anchors against
 *  the layout it expects rather than whatever the last one left behind. */
export function resetBrowserScroll(panelKey) {
  const controls = browserViewportControls(panelKey)
  if (!controls?.resetScroll) return false
  controls.resetScroll()
  return true
}

/** Limit what the user may do to the browser, for a step that hands the track back but
 *  wants it to be about one thing. `'all'` puts it back as it was. */
export function setBrowserInteraction(mode, panelKey) {
  const controls = browserViewportControls(panelKey)
  if (!controls?.setInteraction) return false
  controls.setInteraction(mode === 'zoom-only' ? 'zoom-only' : 'all')
  return true
}

/** `chr:start-end` as numbers, or null when it is not one. */
export function parseLocus(text) {
  const parsed = String(text || '').match(/^\s*([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)\s*$/)
  if (!parsed) return null
  const start = parseInt(parsed[2].replace(/[,\s]/g, ''), 10)
  const end = parseInt(parsed[3].replace(/[,\s]/g, ''), 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { chrom: parsed[1], start, end }
}

/** Whether a panel is already showing this locus. Used by a step to tell "the user has
 *  done this themselves" from "this still needs doing". */
export function browserIsShowing(locus, panelKey) {
  const wanted = parseLocus(locus)
  const showing = describeBrowserViewport(panelKey)
  if (!wanted || !showing) return false
  const bare = (name) => String(name || '').trim().toLowerCase().replace(/^chr/, '')
  return bare(showing.chrom) === bare(wanted.chrom)
    && sameBrowserViewport({ ...showing, chrom: wanted.chrom }, wanted)
}

/** Whether the sequence lane is currently drawing bases rather than its zoom hint.
 *
 *  Kept as a semantic flag published by the browser instead of duplicating its span,
 *  visibility and loading rules in the tutorial runtime. A sequence-level tutorial can
 *  therefore recognise that the user has already completed the task and leave their
 *  viewport untouched when they press Next. */
export function browserIsShowingSequence(panelKey) {
  return browserViewportControls(panelKey)?.describe?.()?.sequenceVisible === true
}

/** Whether a feature is fully visible at the sort of scale a "recenter on feature"
 *  control produces.
 *
 *  The exact viewport depends on the drawer width, so comparing against one fixed locus
 *  is brittle. This semantic check instead requires the feature to be fully on screen
 *  and to occupy a meaningful share of it. A whole-chromosome view therefore does not
 *  count merely because it happens to contain the gene. */
export function browserIsFeatureFramed(locus, panelKey) {
  const feature = parseLocus(locus)
  const showing = describeBrowserViewport(panelKey)
  if (!feature || !showing) return false
  const bare = (name) => String(name || '').trim().toLowerCase().replace(/^chr/, '')
  if (bare(showing.chrom) !== bare(feature.chrom)) return false

  const viewStart = Number(showing.start)
  const viewEnd = Number(showing.end)
  if (!Number.isFinite(viewStart) || !Number.isFinite(viewEnd) || viewEnd <= viewStart) return false
  const featureSpan = feature.end - feature.start
  const viewSpan = viewEnd - viewStart
  const tolerance = Math.max(2, featureSpan * 0.01)
  const fullyVisible = feature.start >= viewStart - tolerance && feature.end <= viewEnd + tolerance
  return fullyVisible && viewSpan <= featureSpan * 3
}

/** What a panel is currently showing, for a step that wants to put it back. */
export function describeBrowserViewport(panelKey) {
  return browserViewportControls(panelKey)?.describe?.() || null
}

// Testing seam: the registry is module state, so a test that registers a fake panel needs
// a way to leave the module as it found it.
export function clearBrowserViewports() {
  panels.clear()
}


// ── Notes ────────────────────────────────────────────────────────────────────
//
// Only deletion, and only so Back can remove the note the tutorial took. Taking one is
// something the tutorial does by clicking the real "+", like a user would; putting it
// back is not, because there is no undo button in the notes UI to press.

let noteControls = null

/** Publish the browser view's note handlers. Returns the deregistration function. */
export function registerBrowserNotes(controls) {
  noteControls = controls || null
  return () => {
    if (noteControls === controls) noteControls = null
  }
}

/** Remove a note through the app rather than behind its back. False when there is no
 *  browser mounted to do it. */
export function deleteBrowserNote(noteId) {
  const id = String(noteId || '').trim()
  if (!id || !noteControls?.deleteNote) return false
  noteControls.deleteNote(id)
  return true
}
