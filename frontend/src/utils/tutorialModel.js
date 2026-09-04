// The rules a tutorial runs by, with no React and no DOM in sight.
//
// A tutorial is data: an ordered list of steps, each naming the app it belongs to, the
// thing on screen it is about, and what has to happen before it is done. This module
// decides everything — whether an event satisfies the current step, where the step
// pointer moves next, whether a definition is even coherent — so that the runtime in
// `hooks/useTutorial.jsx` is left holding nothing but wiring, and so the awkward cases
// can be tested under `node --test` without a renderer.
//
// See docs/TUTORIALS.md for how to write one.

export const STEP_PLACEMENTS = Object.freeze(['top', 'bottom', 'left', 'right', 'center'])

/** Where the card sits along the axis its placement does not offset it on.
 *
 *  `start` — the default — lines the card's leading edge up with the target's. `end`
 *  lines up the trailing edges: a card placed `left` with `align: 'end'` has its bottom
 *  level with the bottom of the control it points at.
 *
 *  Setting one also means the author has decided where the card goes, so the runtime
 *  stops moving it about to clear whatever else the step has lit up. That is the point:
 *  a card that clears a revealed area has to move when the revealed area does, and a
 *  card that repositions while you are reading it is worse than one slightly close to
 *  something. */
export const STEP_ALIGNMENTS = Object.freeze(['start', 'center', 'end'])

export function stepAlign(step) {
  return STEP_ALIGNMENTS.includes(step?.align) ? step.align : ''
}

/** A manually authored card position, expressed as a fraction of the viewport.
 *
 * Storing a 0–1 fraction rather than screen pixels means a position chosen on one display
 * still maps into the visible viewport when the app is resized or opened elsewhere. */
export function stepCardPosition(step) {
  if (!step?.cardPosition || typeof step.cardPosition !== 'object') return null
  const x = Number(step.cardPosition.x)
  const y = Number(step.cardPosition.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

/** Optional author-sized card dimensions in CSS pixels.
 *
 * Unlike position, dimensions are intentionally pixels: a readable line length should
 * not balloon just because the window is wider. The overlay still clamps these values to
 * the current viewport. A single edge may be authored without fixing the other one. */
export function stepCardSize(step) {
  if (!step?.cardSize || typeof step.cardSize !== 'object') return null
  const size = {}
  if (step.cardSize.width !== undefined) {
    const width = Number(step.cardSize.width)
    if (!Number.isFinite(width) || width <= 0) return null
    size.width = width
  }
  if (step.cardSize.height !== undefined) {
    const height = Number(step.cardSize.height)
    if (!Number.isFinite(height) || height <= 0) return null
    size.height = height
  }
  return Object.keys(size).length ? size : null
}

/** What the user may do to the genome browser while a step is up.
 *
 *  `all` is the default. `zoom-only` holds the view where it is and leaves zooming
 *  working, for a step that hands the track back but wants it to be about one thing —
 *  someone who pans away while learning to zoom has lost both the gene and the point. */
export const STEP_INTERACTIONS = Object.freeze(['all', 'zoom-only'])

export function stepInteraction(step) {
  return STEP_INTERACTIONS.includes(step?.interaction) ? step.interaction : 'all'
}

/** Whether the card and spotlight wait until the step's arrival work has settled.
 *
 *  Most cards can be read while their target is getting ready. A target inside a
 *  scrolling panel is different: showing its spotlight first makes the ring chase the
 *  control down the panel. Those steps opt into appearing only after preconditions,
 *  arrivals and the bounded scroll-into-view repair have all finished. */
export function stepDefersPresentation(step) {
  return step?.deferUntilReady === true
}

/** How a step decides it is finished.
 *
 *  - `manual`  the user presses Next. The default, and the right choice for a step that
 *              only explains something.
 *  - `view`    the named app becomes active. Used for "open the X app" steps.
 *  - `click`   the anchored element is clicked. Resolved by the runtime's single
 *              document-level listener, so it needs no per-component wiring.
 *  - `signal`  the app reports a state transition that no click can stand in for —
 *              a config save landing, a download finishing.
 *  - `dwell`   a fixed time passes. For "watch this happen" moments.
 *  - `input`   the anchored field holds an expected value. For a step whose whole task is
 *              "type this here", where waiting for a click would mean the user typing the
 *              right thing and then sitting there wondering what else is wanted.
 */
export const ADVANCE_TYPES = Object.freeze(['manual', 'view', 'click', 'all-clicks', 'signal', 'dwell', 'input'])

/** What a step can do on the user's behalf when they press Next.
 *
 *  A tutorial should never leave someone hunting for the thing it just described, so
 *  every step that needs an action declares it and the runtime performs it — pulsing the
 *  target first, so the click is visible rather than magical. Doing it by hand instead
 *  satisfies the step just the same.
 *
 *  - `none`         nothing to do; Next simply moves on.
 *  - `click`        click the anchored element. `anchors: [...]` clicks several in turn,
 *                   for a step whose one idea takes more than one press — unticking three
 *                   gene classes to leave only protein-coding is the case it exists for.
 *                   `skipIfFeatureFramed` leaves a recenter control alone when the user
 *                   has already framed that genomic feature themselves;
 *                   `skipIfEngaged` does the same for a control publishing
 *                   `data-tutorial-engaged="true"`. For `anchors: [...]`, `pauseMs`
 *                   sets the viewing pause between presses and `endPauseMs` holds the
 *                   final result before the action finishes.
 *  - `type`         type a value into the anchored field. Next does nothing at all when the
 *                   field already says what the step asked for: their own answer where
 *                   anything will do, or this exact value under `overwrite`, where only one
 *                   value works — searching the demo genome for a gene it does not contain
 *                   just fails, and the step sits there looking broken. `skipIfShowing`
 *                   names a locus: when the browser is already there the user has done the
 *                   step themselves, and Next simply moves on rather than typing over it.
 *  - `navigate`     switch to another app.
 *  - `browserView`  move the genome browser: `pan` in windows, `zoom` as a factor, or
 *                   `locus` as chr:start-end. `moves: [...]` performs several in turn —
 *                   zoom out, travel, zoom back in — which is how a tutorial shows where
 *                   somewhere *is* rather than teleporting to it. `pauseMs` holds the
 *                   result before the step moves on, and `skipIfMoved` leaves the view
 *                   alone when the user has already moved it themselves.
 *  - `browserControls`  put the browser's switches in a named state: `detail`, `flatten`
 *                   and `expanded` as booleans, `biotypes` as `'all'` or
 *                   `'protein-coding'`, `drawerTranscripts` as `'collapsed'` or
 *                   `'expanded'`, `transcriptDetail` and `noteEditor` as `'open'` or
 *                   `'closed'`, `transcriptSequence` as a feature key and `tutorialNote`
 *                   as `'none'`. Only the keys given are enforced.
 *
 *  `browserView` is the odd one out and is worth explaining. The browser has no zoom
 *  buttons and no slider — panning is a drag or the arrow keys, zooming is the wheel or
 *  `+`/`-` — so there is no control for a tutorial to click. Rather than inventing one
 *  nobody would otherwise use, the step stays interactive so the user can drag and scroll
 *  the real track, and Next drives the browser's own animated move on their behalf. */
export const ACTION_TYPES = Object.freeze([
  'none', 'click', 'type', 'navigate', 'browserView', 'browserControls',
])

/** The subset of actions a step may perform on *arrival* rather than on Next.
 *
 *  This is what makes a tutorial reversible. A step that describes what is on screen has
 *  to be able to put it there, or going Back lands on a card describing something the
 *  user is no longer looking at — and pressing Next again to "redo" the step does it a
 *  second time on top of the first. So a step declares the state it expects and the
 *  runtime establishes it every time the step is entered, from either direction.
 *
 *  Only idempotent things belong here. `arrive` runs on every visit, so an action that
 *  toggles rather than sets would flip back and forth as the user walked about. */
export const ARRIVE_TYPES = Object.freeze([
  'browserView', 'browserControls', 'selectorList', 'genomeSelection', 'pageScroll',
  'dialog', 'playlists',
])

/** Where a step wants the page scrolled to before its card is read.
 *
 *  A step is not only a highlight; it is a view of the app. The step after a selection
 *  points at a control near the bottom of a long page, and arriving with the page still
 *  where the previous step left it puts that control — and the card beside it — half off
 *  the screen. Centring it instead is no better, because the author is composing a
 *  picture, not framing one element.
 *
 *  So the position is authored as it was seen: a registered target, and how far its top
 *  sat below the top of the scrolling region when the author was happy with the shot.
 *  Expressing it against a target rather than as a raw `scrollTop` keeps it meaningful
 *  when the page above it grows — a pill strip appearing, a longer list — and means the
 *  same authored number frames the same picture at a different window height.
 *
 *  The runtime scrolls there smoothly on the way in, so the step reads as the view
 *  travelling to the next thing rather than the page jumping under the reader. */
export function arrivalScrollOffset(arrival) {
  const offset = Number(arrival?.offset)
  return Number.isFinite(offset) ? offset : 0
}

/** Which of a tutorial's embedded genomes a `genomeSelection` arrival selects.
 *
 *  Named by the document's own `recipeId`s, so the declaration travels with the package
 *  and does not depend on a species key the runtime happens to mint at install time. An
 *  empty list is a real instruction — "arrive here with nothing selected" — and is what
 *  makes the step *before* a selection step re-watchable. */
export function arrivalGenomeRecipeIds(arrival) {
  const raw = arrival?.genomes
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => String(entry?.recipeId || entry || '').trim()).filter(Boolean)
}

/** Which dialog or popover a step expects to find open.
 *
 *  A dialog is the one piece of app state a step cannot simply point at: it is not there
 *  until something opens it. That makes the step *after* "click Add selected genomes to
 *  playlists" unreachable except by performing the step before it — the same problem the
 *  pills strip had, one degree worse, because the spotlight has no element at all to draw
 *  around and the card describes a panel that is not on screen.
 *
 *  `none` is a real value and the one the step that opens the dialog should use. Without
 *  it, coming Back from the dialog step leaves the dialog sitting over the scene, hiding
 *  the very control the user is being asked to press.
 *
 *  Opening a dialog on arrival is idempotent in the way `arrive` requires: it names the
 *  resulting state, so re-entering the step finds it already open and does nothing. */
export const TUTORIAL_DIALOGS = Object.freeze(['none', 'playlistMembership', 'playlistPopover'])

export function arrivalDialog(arrival) {
  const dialog = String(arrival?.dialog || '').trim()
  return TUTORIAL_DIALOGS.includes(dialog) ? dialog : ''
}

/** What a dialog's own fields hold when the step opens.
 *
 *  A dialog the tutorial fills in over three steps — name it, describe it, save it — loses
 *  its text the moment the dialog is re-established, which is exactly what going Back does.
 *  The reader then lands on "press Add genomes" beside an empty form. So a step that
 *  expects text already typed says so, the same way it says which genomes are selected:
 *  the step that asks for the name arrives with the field empty, and the step after it
 *  arrives with the name already in place. */
export function arrivalDialogFields(arrival) {
  const fields = arrival?.fields
  if (!fields || typeof fields !== 'object') return null
  const name = String(fields.name || '')
  const description = String(fields.description || '')
  if (!name && !description) return null
  return { name, description }
}

/** The playlists a step expects to exist, and which of them is showing.
 *
 *  A tutorial that teaches playlists creates one, and everything after that step depends
 *  on it. Reached any other way — from Back, from the builder's step list — the playlist
 *  is not there and the card describes a row that does not exist. Worse than the pills
 *  case, because redoing the step then fails outright: the app refuses a second playlist
 *  with the same name.
 *
 *  So a step declares the playlists as they should be, named and described exactly as the
 *  tutorial asked the user to name them, with members given as embedded dataset recipe ids
 *  for the same reason `genomeSelection` uses them. Establishing them replaces the
 *  sandbox's playlist set outright, which is what makes it idempotent: the step before the
 *  one that creates a playlist declares `playlists: []`, and returning to it puts the
 *  scene back to before it existed.
 *
 *  `selected` names which playlist the app is filtered to, empty for all genomes. */
export function arrivalPlaylists(arrival) {
  const raw = arrival?.playlists
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      description: String(entry?.description || '').trim(),
      genomes: Array.isArray(entry?.genomes)
        ? entry.genomes.map((genome) => String(genome?.recipeId || genome || '').trim()).filter(Boolean)
        : [],
    }))
    .filter((entry) => entry.name)
}

export function arrivalSelectedPlaylist(arrival) {
  return String(arrival?.selected || '').trim()
}

/** How long to leave a step's result on screen once it is satisfied, before moving on.
 *
 *  Different from the hold the runtime already applies after the tutorial acts on the
 *  user's behalf, which deliberately does not apply to anything the *user* did — their own
 *  click needs no pause to be understood. That is right for a click, and wrong when the
 *  result is somewhere else on screen: pasting a region into the search box moves the
 *  whole track, and advancing the instant it lands means never seeing what was asked for.
 *  A step whose answer appears away from the control says how long to wait for it. */
export function stepHoldMs(step) {
  const ms = Number(step?.holdMs)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** A value the card offers to copy, for steps that ask the user to enter something too
 *  long to retype. Telling someone to type out a nineteen-character coordinate string is
 *  asking them to make a typo; a copy button beside it is what anyone would reach for. */
export function stepCopyValue(step) {
  const value = step?.copy
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** The field the card's value goes straight into, when the step names one.
 *
 *  A clipboard is a detour. The reader copies the region, moves to the box and then has to
 *  know how to paste into it — and the app's own right-click menu is not the browser's, so
 *  the obvious gesture does nothing and only the keyboard shortcut works. Naming the field
 *  turns the same chip into the shortcut it was pretending to be: pressing it puts the
 *  value where it was going. The value is still copied, for anyone who wanted it elsewhere.
 *
 *  Only meaningful beside a `copy` value, and only where one value works — which is the
 *  same condition `copy` already carries. */
export function stepCopyTarget(step) {
  if (!stepCopyValue(step)) return ''
  const anchor = step?.copyInto
  return typeof anchor === 'string' && anchor.trim() ? anchor.trim() : ''
}

/** What a step wants true before it is read, as a list. */
export function stepArrivals(step) {
  const raw = step?.arrive
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw]).filter((entry) => entry && typeof entry === 'object')
}

/** The whole arrival state for a step: the tutorial's defaults, then the step's own.
 *
 *  A tutorial can declare `defaultArrive` for the state every one of its steps assumes —
 *  for the browser tutorial that is the plain transcript layout, because a step that
 *  inherited an expanded one from three steps ago finds its anchors in different places
 *  and its spotlight around the wrong thing. Ordering does the overriding: the step's own
 *  entries run second, and `browserControls` only sets the keys it names. */
export function arrivalsFor(tutorial, step) {
  const defaults = tutorial?.defaultArrive
    ? (Array.isArray(tutorial.defaultArrive) ? tutorial.defaultArrive : [tutorial.defaultArrive])
    : []
  const inherited = defaults.filter((entry) => entry && typeof entry === 'object')
  const own = stepArrivals(step)

  // A step commonly overrides part of a default browser layout. Running both actions is
  // logically correct but visually wrong: `expanded: false` followed by `expanded: true`
  // briefly collapses a track on arrival, then grows it again while the reader is trying
  // to compare the result of the previous step. Coalesce those declarations into one set
  // operation. It stays in the default's position, so a default that deliberately prepares
  // the browser before a later view move keeps doing so.
  const inheritedControls = inherited.filter((entry) => entry.type === 'browserControls')
  const ownControls = own.filter((entry) => entry.type === 'browserControls')
  if (!inheritedControls.length || !ownControls.length) return [...inherited, ...own]

  const mergedControls = Object.assign({}, ...inheritedControls, ...ownControls)
  let controlsAdded = false
  const result = []
  for (const entry of inherited) {
    if (entry.type !== 'browserControls') {
      result.push(entry)
    } else if (!controlsAdded) {
      result.push(mergedControls)
      controlsAdded = true
    }
  }
  result.push(...own.filter((entry) => entry.type !== 'browserControls'))
  return result
}

/** What a step undoes when the user presses Back.
 *
 *  Most steps need nothing: going back a page in an explanation costs nothing. A step
 *  whose *point* was to cause something — activating a genome — is different. Left in
 *  place, the change means the step cannot be watched a second time: the checkbox is
 *  already ticked and clicking it now does the opposite. So such a step says how to put
 *  the world back, and Back does it on the way past.
 *
 *  - `none`                     nothing to undo.
 *  - `deactivate-demo-genome`   drop the demo genome from the tutorial's active set.
 *  - `deactivate-slice-genome`  the same for the browser tutorial's chromosome-1 slice.
 *  - `unfocus-gene`             clear the browser's focused gene and its search box.
 *
 *  Anything expressible as a state rather than as a reversal belongs in `arrive` instead,
 *  which runs on every visit and so covers Back without anyone having to pair steps up by
 *  hand. These two are here because neither is a state the runtime can simply set. */
export const UNDO_TYPES = Object.freeze([
  'none',
  'deactivate-demo-genome',
  'deactivate-slice-genome',
  'unfocus-gene',
])

/** Named states the runtime knows how to bring about before a step runs, so that
 *  skipping steps cannot strand a later one. See docs/TUTORIALS.md. */
export const PRECONDITIONS = Object.freeze([
  'demo-genome-installed',
  'demo-genome-active',
  'slice-genome-installed',
  'slice-genome-active',
  // The browser tutorial's later half is all about one gene. A user who skipped the
  // search step would otherwise arrive at the drawer with nothing in it.
  'reg4-gene-focused',
  // The app's own transient banner sits at the top right, over the top-bar buttons, above
  // the app but below the tutorial overlay — so it half-covers a highlight there and the
  // reader cannot click it away. A step pointing at something it lands on waits it out.
  'notifications-clear',
])

/** The three speeds autoplay runs at, slowest first.
 *
 *  The factor scales everything the tutorial does — how long the cursor takes to travel,
 *  how fast text is typed, how long a step is left on screen — because a "faster" setting
 *  that only shortened the pause between steps would still crawl through each one.
 *
 *  Rendered as three arrows, filled up to the chosen index, so the setting reads as a
 *  level rather than three unrelated buttons. */
export const AUTOPLAY_SPEEDS = Object.freeze([
  Object.freeze({ id: 'slow', label: 'Slower', factor: 1.3 }),
  Object.freeze({ id: 'normal', label: 'Normal speed', factor: 1 }),
  Object.freeze({ id: 'fast', label: 'Faster', factor: 1 / 1.2 }),
])

export const DEFAULT_SPEED_INDEX = 1

// A fixed dwell suits a fixed amount of text, and steps do not have one. These are the
// numbers behind stepDwellMs: a moment to take in that the step has changed, then reading
// time per word, bounded so a one-line step is not gone before it registers and a long one
// does not feel like a hostage situation.
const DWELL_BASE_MS = 2400
const DWELL_PER_WORD_MS = 240
const DWELL_MIN_MS = 4500
const DWELL_MAX_MS = 15000

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

/** How long autoplay should leave a step on screen, before the speed factor is applied.
 *
 *  `autoplayMs` on the step overrides it outright, for the steps where the wait is about
 *  something finishing rather than something being read. */
export function stepDwellMs(step) {
  const explicit = Number(step?.autoplayMs)
  if (explicit > 0) return explicit
  const words = wordCount(step?.title) + wordCount(step?.body)
  const ms = DWELL_BASE_MS + (words * DWELL_PER_WORD_MS)
  return Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, Math.round(ms)))
}

/** Clamp an index onto the speeds that exist, so a stored or stale value cannot break
 *  the timings. */
export function speedFactor(index) {
  const speed = AUTOPLAY_SPEEDS[Number.isInteger(index) ? index : DEFAULT_SPEED_INDEX]
    || AUTOPLAY_SPEEDS[DEFAULT_SPEED_INDEX]
  return speed.factor
}

export const TUTORIAL_STATUS = Object.freeze({
  running: 'running',
  completed: 'completed',
  exited: 'exited',
})

const DEFAULT_ADVANCE = Object.freeze({ type: 'manual' })

// ── Reading a definition ──────────────────────────────────────────────────────

export function stepCount(tutorial) {
  return Array.isArray(tutorial?.steps) ? tutorial.steps.length : 0
}

/** The narrative chapter a step belongs to.
 *
 *  Sections are optional for short tutorials. Once a tutorial uses them, every step is
 *  expected to name one: the overlay can then keep the chapter as its heading while the
 *  individual step title reads as a subheading, and the catalogue can expose the same
 *  structure when someone is jumping into the middle to test it. */
export function stepSection(step) {
  return typeof step?.section === 'string' ? step.section.trim() : ''
}

/** Consecutive runs of steps with the same section, preserving their absolute indexes. */
export function tutorialSections(tutorial) {
  const groups = []
  const steps = Array.isArray(tutorial?.steps) ? tutorial.steps : []
  steps.forEach((step, stepIndex) => {
    const title = stepSection(step)
    const previous = groups.at(-1)
    if (!previous || previous.title !== title) {
      groups.push({ title, steps: [{ step, stepIndex }] })
    } else {
      previous.steps.push({ step, stepIndex })
    }
  })
  return groups
}

export function stepAt(tutorial, index) {
  const steps = Array.isArray(tutorial?.steps) ? tutorial.steps : []
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return null
  return steps[index] || null
}

export function currentStep(tutorial, state) {
  return stepAt(tutorial, state?.stepIndex)
}

/** What a step will do when the user presses Next.
 *
 *  Defaults are chosen so most steps need not say anything: a step anchored on something
 *  clickable clicks it, a step with a prefill types it, a step that only explains does
 *  nothing. */
export function stepAction(step) {
  if (step?.action && typeof step.action === 'object') return step.action
  if (step?.prefill) return { type: 'type', anchor: step.prefill.anchor, value: step.prefill.value }
  const advance = stepAdvance(step)
  if (advance.type === 'click' && (advance.anchor || step?.anchor)) {
    return { type: 'click', anchor: advance.anchor || step.anchor }
  }
  if (advance.type === 'view' && advance.view) {
    // Pressing the app button is what a person would do, and it is something the
    // tutorial's cursor can be seen doing. The view is carried along so the runtime can
    // switch app directly when the button is not on screen to be clicked.
    if (step?.anchor) return { type: 'click', anchor: step.anchor, view: advance.view }
    return { type: 'navigate', view: advance.view }
  }
  return { type: 'none' }
}

/** Every element a click action presses, in order.
 *
 *  One anchor is the ordinary case. `anchors: [...]` is for a step whose single idea takes
 *  several presses; the runtime clicks them in turn with a pause between, so each one's
 *  effect is visible rather than the lot happening at once. */
export function actionAnchors(action) {
  if (Array.isArray(action?.anchors)) return action.anchors.filter(Boolean)
  return action?.anchor ? [action.anchor] : []
}

/** Whether the spotlit element may actually be used, as opposed to merely looked at.
 *
 *  Steps that are pointing something out rather than asking for it — the file-type chips,
 *  say — set `interactive: false` so a stray click cannot wander off the tutorial's path. */
export function stepIsInteractive(step) {
  return step?.interactive !== false
}

/** Whether to draw the ornamental ring around a step's cutout.
 *
 *  Full-width bars are already unmistakable when undimmed; a ring around one adds a
 *  heavy horizontal shadow across adjacent panels, so those steps can keep the cutout
 *  while opting out of the ring. */
export function stepShowsSpotlightRing(step) {
  return step?.spotlightRing !== false
}

/** Whether the spotlight ring carries its usual dark halo and drop shadow. */
export function stepShowsSpotlightRingShadow(step) {
  return step?.spotlightRingShadow !== false
}

export function stepUndo(step) {
  const undo = step?.undo
  if (!undo) return { type: 'none' }
  return typeof undo === 'string' ? { type: undo } : undo
}

export function stepPreconditions(step) {
  const raw = step?.ensure
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean)
}

/** Whether a field's current value satisfies an `input` advance. Trimmed and
 *  case-insensitive: someone who typed the right thing should not fail on a capital. */
export function isInputAdvanceSatisfied(advance, value) {
  if (!advance || advance.type !== 'input') return false
  const wanted = String(advance.value ?? '').trim().toLowerCase()
  if (!wanted) return false
  return String(value ?? '').trim().toLowerCase() === wanted
}

export function stepAdvance(step) {
  const advance = step?.advanceOn
  if (!advance || typeof advance !== 'object') return DEFAULT_ADVANCE
  return advance
}

/** The anchor a step points at, normalised to a CSS selector.
 *
 *  A string anchor is a `data-tour-id`, which is what new anchors should be. The
 *  `{ selector }` form exists so a step can reuse one of the data attributes the app
 *  already carries (`[data-focus-drawer]` and friends) rather than adding a duplicate. */
export function anchorSelector(anchor) {
  if (!anchor) return ''
  if (typeof anchor === 'string') {
    const id = anchor.trim()
    return id ? `[data-tour-id="${id}"]` : ''
  }
  if (typeof anchor === 'object' && typeof anchor.selector === 'string') {
    return anchor.selector.trim()
  }
  return ''
}

/** Every `data-tour-id` a tutorial depends on. Feeds both the definition tests and the
 *  anchor inventory in docs/TUTORIALS.md. */
export function tutorialAnchorIds(tutorial) {
  const ids = new Set()
  const collect = (anchor) => {
    if (typeof anchor === 'string' && anchor.trim()) ids.add(anchor.trim())
  }
  for (const step of Array.isArray(tutorial?.steps) ? tutorial.steps : []) {
    collect(step?.anchor)
    collect(step?.openSection)
    collect(step?.sectionContent)
    collect(step?.prefill?.anchor)
    collect(step?.reveal?.anchor)
    for (const reveal of step?.reveals || []) collect(reveal?.anchor)
    collect(step?.placeAgainst)
    collect(step?.copyInto)
    for (const entry of step?.interactionPolicy?.targets || []) collect(entry?.anchor)
    collect(step?.reveal?.whenTyped)
    actionAnchors(stepAction(step)).forEach(collect)
    collect(stepAction(step)?.anchor)
    if (step?.advanceOn?.type === 'click' || step?.advanceOn?.type === 'input') {
      collect(step.advanceOn.anchor)
    }
    if (step?.advanceOn?.type === 'all-clicks') {
      for (const anchor of step.advanceOn.anchors || []) collect(anchor)
    }
  }
  return Array.from(ids).sort()
}

/** Every app a tutorial visits, in first-visit order. Shown on the tutorial's card. */
export function tutorialViewIds(tutorial) {
  const seen = []
  for (const step of Array.isArray(tutorial?.steps) ? tutorial.steps : []) {
    const view = String(step?.view || '').trim()
    if (view && !seen.includes(view)) seen.push(view)
  }
  return seen
}

// ── Matching events against the current step ──────────────────────────────────

function payloadMatches(payload, match) {
  if (!match || typeof match !== 'object') return true
  if (!payload || typeof payload !== 'object') return false
  return Object.entries(match).every(([key, value]) => String(payload[key] ?? '') === String(value ?? ''))
}

/** Whether `event` is the thing `step` was waiting for.
 *
 *  Deliberately strict: an event that does not match simply leaves the step where it is.
 *  Soft gating means the user always has Next as a way out, so a missed match costs a
 *  click rather than trapping anyone. */
export function isAdvanceEventMatch(step, event) {
  if (!step || !event) return false
  const advance = stepAdvance(step)
  if (advance.type !== event.type) return false

  switch (advance.type) {
    case 'view':
      return String(advance.view || '') === String(event.view || '')
    case 'click': {
      // The step's own anchor is what the user is being pointed at, so it is the
      // default thing to wait for a click on.
      const expected = advance.anchor || step.anchor
      const expectedSelector = anchorSelector(expected)
      if (!expectedSelector) return false
      return anchorSelector(event.anchor) === expectedSelector
    }
    case 'all-clicks':
      return String(event.stepId || '') === String(step.id || '')
    case 'signal':
      if (String(advance.name || '') !== String(event.name || '')) return false
      return payloadMatches(event.payload, advance.match)
    case 'dwell':
      // Timers outlive the step that started them, so a dwell only counts for the step
      // that armed it.
      return String(event.stepId || '') === String(step.id || '')
    case 'input':
      // Same reasoning as dwell: the watcher is debounced, so its event has to name the
      // step it was armed for.
      if (String(event.stepId || '') !== String(step.id || '')) return false
      return isInputAdvanceSatisfied(advance, event.value)
    default:
      return false
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

export function initTutorialState(tutorial, options = {}) {
  const total = stepCount(tutorial)
  const requestedIndex = Number.isInteger(options.stepIndex) ? options.stepIndex : 0
  const bounded = total > 0 ? Math.min(total - 1, Math.max(0, requestedIndex)) : 0
  const firstAvailable = (tutorial?.steps || []).findIndex((step, index) => (
    index >= bounded && !step?.compatibilityUnavailable
  ))
  const fallbackAvailable = (tutorial?.steps || []).findIndex((step) => !step?.compatibilityUnavailable)
  const stepIndex = firstAvailable >= 0 ? firstAvailable : (fallbackAvailable >= 0 ? fallbackAvailable : bounded)
  return {
    tutorialId: String(tutorial?.id || ''),
    stepIndex,
    status: TUTORIAL_STATUS.running,
    startedAt: options.startedAt ?? null,
    // Which steps the user actually reached, so a resumed tutorial can tell the
    // difference between "not done yet" and "skipped past".
    visitedStepIds: total ? [String(stepAt(tutorial, stepIndex)?.id || '')] : [],
    compatibilitySkip: firstAvailable > bounded
      ? (tutorial?.steps || []).slice(bounded, firstAvailable).map((step) => String(step?.id || '')).filter(Boolean)
      : [],
  }
}

function withStepIndex(tutorial, state, nextIndex, direction = 1) {
  const total = stepCount(tutorial)
  if (total === 0) return { ...state, status: TUTORIAL_STATUS.completed }
  if (nextIndex >= total) {
    return { ...state, stepIndex: total - 1, status: TUTORIAL_STATUS.completed }
  }
  let index = Math.max(0, nextIndex)
  const compatibilitySkip = []
  while (index >= 0 && index < total && stepAt(tutorial, index)?.compatibilityUnavailable) {
    compatibilitySkip.push(String(stepAt(tutorial, index)?.id || ''))
    index += direction >= 0 ? 1 : -1
  }
  if (index >= total) return { ...state, stepIndex: total - 1, status: TUTORIAL_STATUS.completed }
  if (index < 0) index = state.stepIndex
  if (index === state.stepIndex) return state
  const id = String(stepAt(tutorial, index)?.id || '')
  const visited = state.visitedStepIds.includes(id)
    ? state.visitedStepIds
    : [...state.visitedStepIds, id]
  return { ...state, stepIndex: index, visitedStepIds: visited, compatibilitySkip }
}

/** Advance the tutorial in response to something happening.
 *
 *  Returns the same state object when nothing changed, so the runtime can bail out of a
 *  re-render cheaply — the DOM observer feeds this a lot of events that match nothing. */
export function reduceTutorial(tutorial, state, event) {
  if (!state || state.status !== TUTORIAL_STATUS.running) return state
  if (!event || typeof event !== 'object') return state

  switch (event.type) {
    case 'exit':
      return { ...state, status: TUTORIAL_STATUS.exited }
    case 'next':
    case 'skip':
      // Pressing Next performs the step's action, and that action can satisfy the step
      // on its own — navigating to an app is what a "view" step was waiting for. So the
      // request carries the step it was made from, and is ignored if the tutorial has
      // already moved on. Without this, Next advances twice and a step is skipped unseen.
      if (event.fromStepId && String(event.fromStepId) !== String(currentStep(tutorial, state)?.id || '')) {
        return state
      }
      return withStepIndex(tutorial, state, state.stepIndex + 1, 1)
    case 'back':
      return withStepIndex(tutorial, state, state.stepIndex - 1, -1)
    case 'goto':
      return withStepIndex(tutorial, state, event.index, 1)
    default: {
      const step = currentStep(tutorial, state)
      if (!isAdvanceEventMatch(step, event)) return state
      return withStepIndex(tutorial, state, state.stepIndex + 1, 1)
    }
  }
}

export function isLastStep(tutorial, state) {
  const total = stepCount(tutorial)
  return total > 0 && state?.stepIndex === total - 1
}

export function tutorialProgressLabel(tutorial, state) {
  const total = stepCount(tutorial)
  if (!total) return ''
  const position = Math.min(total, Math.max(1, (state?.stepIndex ?? 0) + 1))
  return `Step ${position} of ${total}`
}

// ── Validation ────────────────────────────────────────────────────────────────

/** The four gene classes the browser's filter grid offers, in the order it draws them. */
export const BIOTYPE_CLASSES = Object.freeze(['proteinCoding', 'lncRNA', 'pseudogene', 'smallNonCoding'])

/** Two shorthands, or an explicit list of the classes left showing. The list is what a
 *  step needs when it teaches the filter on a window that does not contain all four:
 *  unticking a class no gene in view belongs to demonstrates nothing. */
const BIOTYPE_STATES = Object.freeze(['all', 'protein-coding'])
const DRAWER_TRANSCRIPT_STATES = Object.freeze(['collapsed', 'expanded'])
const PANEL_STATES = Object.freeze(['open', 'closed'])
const TUTORIAL_NOTE_STATES = Object.freeze(['none'])
const PINNED_TRANSCRIPT_STATES = Object.freeze(['none'])

function browserViewProblems(move, where) {
  const problems = []
  const moves = Array.isArray(move.moves) ? move.moves : [move]
  if (moves.length === 0) problems.push(`${where}: a browserView needs at least one move.`)
  for (const one of moves) {
    const named = ['pan', 'zoom', 'locus'].filter((key) => one?.[key] !== undefined)
    if (named.length === 0) problems.push(`${where}: a browserView move needs a pan, zoom or locus.`)
    if (one?.locus !== undefined && !String(one.locus || '').trim()) {
      problems.push(`${where}: a browserView locus needs a chr:start-end.`)
    }
    for (const key of ['pan', 'zoom']) {
      if (one?.[key] !== undefined && !Number.isFinite(Number(one[key]))) {
        problems.push(`${where}: a browserView ${key} needs a number.`)
      }
    }
    if (one?.zoom !== undefined && Number(one.zoom) === 0) {
      problems.push(`${where}: a browserView zoom of 0 goes nowhere.`)
    }
  }
  if (move.pauseMs !== undefined && !(Number(move.pauseMs) >= 0)) {
    problems.push(`${where}: a browserView pauseMs needs a number of milliseconds.`)
  }
  return problems
}

function browserControlProblems(controls, where) {
  const problems = []
  const named = [
    'detail', 'flatten', 'expanded', 'biotypes', 'drawerTranscripts',
    'transcriptDetail', 'noteEditor', 'tutorialNote', 'pinnedTranscript',
    'geneTranscripts', 'hiddenTranscript',
  ].filter((key) => controls?.[key] !== undefined)
  if (named.length === 0) problems.push(`${where}: a browserControls action names no control to set.`)
  for (const key of ['detail', 'flatten', 'expanded']) {
    if (controls[key] !== undefined && typeof controls[key] !== 'boolean') {
      problems.push(`${where}: browserControls ${key} must be true or false.`)
    }
  }
  // One gene's own transcripts, named by gene id — a different control from `expanded`,
  // which is the window-wide one. Both keys are required: a gene with no state to put it
  // in, or a state with no gene, is a declaration that cannot be carried out.
  if (controls.geneTranscripts !== undefined) {
    const gene = String(controls.geneTranscripts?.gene || '').trim()
    if (!gene) problems.push(`${where}: browserControls geneTranscripts needs a gene id.`)
    if (typeof controls.geneTranscripts?.expanded !== 'boolean') {
      problems.push(`${where}: browserControls geneTranscripts expanded must be true or false.`)
    }
  }
  // One named transcript's hidden state, so a step about the "Show N hidden" label the
  // drawer leaves on the gene can be reached without walking through the step that hid it.
  if (controls.hiddenTranscript !== undefined) {
    if (!String(controls.hiddenTranscript?.transcript || '').trim()) {
      problems.push(`${where}: browserControls hiddenTranscript needs a transcript id.`)
    }
    if (typeof controls.hiddenTranscript?.hidden !== 'boolean') {
      problems.push(`${where}: browserControls hiddenTranscript hidden must be true or false.`)
    }
  }
  if (controls.biotypes !== undefined) {
    if (Array.isArray(controls.biotypes)) {
      const unknown = controls.biotypes.filter((key) => !BIOTYPE_CLASSES.includes(key))
      if (unknown.length) {
        problems.push(`${where}: browserControls biotypes names unknown gene ${unknown.length === 1 ? 'class' : 'classes'} ${unknown.join(', ')}.`)
      }
    } else if (!BIOTYPE_STATES.includes(controls.biotypes)) {
      problems.push(`${where}: browserControls biotypes must be one of ${BIOTYPE_STATES.join(', ')}, or a list of ${BIOTYPE_CLASSES.join(', ')}.`)
    }
  }
  for (const key of ['transcriptDetail', 'noteEditor']) {
    if (controls[key] !== undefined && !PANEL_STATES.includes(controls[key])) {
      problems.push(`${where}: browserControls ${key} must be one of ${PANEL_STATES.join(', ')}.`)
    }
  }
  if (controls.tutorialNote !== undefined && !TUTORIAL_NOTE_STATES.includes(controls.tutorialNote)) {
    problems.push(`${where}: browserControls tutorialNote must be one of ${TUTORIAL_NOTE_STATES.join(', ')}.`)
  }
  if (controls.pinnedTranscript !== undefined
    && !PINNED_TRANSCRIPT_STATES.includes(controls.pinnedTranscript)) {
    problems.push(`${where}: browserControls pinnedTranscript must be "none".`)
  }
  if (controls.drawerTranscripts !== undefined
    && !DRAWER_TRANSCRIPT_STATES.includes(controls.drawerTranscripts)) {
    problems.push(
      `${where}: browserControls drawerTranscripts must be one of ${DRAWER_TRANSCRIPT_STATES.join(', ')}.`
    )
  }
  return problems
}

/** Problems with a tutorial definition, as readable sentences. Empty means it is sound.
 *
 *  Every registered tutorial is run through this in the test suite, so a new tutorial
 *  gets its typos caught without anyone writing a test for it. */
export function validateTutorial(tutorial, options = {}) {
  const problems = []
  const knownViews = options.knownViews ? new Set(options.knownViews) : null
  const knownAnchors = options.knownAnchors ? new Set(options.knownAnchors) : null

  const label = String(tutorial?.id || '(no id)')
  if (!String(tutorial?.id || '').trim()) problems.push('Tutorial has no id.')
  if (!String(tutorial?.title || '').trim()) problems.push(`${label}: tutorial has no title.`)

  const steps = Array.isArray(tutorial?.steps) ? tutorial.steps : []
  if (steps.length === 0) {
    problems.push(`${label}: tutorial has no steps.`)
    return problems
  }

  const sectionedSteps = steps.filter((step) => step?.section !== undefined)
  if (sectionedSteps.length > 0 && sectionedSteps.length !== steps.length) {
    problems.push(`${label}: sections are used, but not every step has one.`)
  }
  const seenSections = new Set()
  let previousSection = ''
  for (const step of sectionedSteps) {
    const section = stepSection(step)
    if (!section || section === previousSection) continue
    if (seenSections.has(section)) {
      problems.push(`${label}: section "${section}" is split into separate runs.`)
      break
    }
    seenSections.add(section)
    previousSection = section
  }

  const checkAnchor = (anchor, where) => {
    if (!anchor) return
    if (!anchorSelector(anchor)) {
      problems.push(`${where}: anchor is neither a data-tour-id nor a { selector }.`)
      return
    }
    if (knownAnchors && typeof anchor === 'string' && !knownAnchors.has(anchor.trim())) {
      problems.push(`${where}: unknown anchor "${anchor}".`)
    }
  }

  const seenIds = new Set()
  steps.forEach((step, index) => {
    const stepId = String(step?.id || '').trim()
    const where = `${label} step ${index + 1}${stepId ? ` (${stepId})` : ''}`

    if (!stepId) problems.push(`${where}: step has no id.`)
    else if (seenIds.has(stepId)) problems.push(`${where}: duplicate step id.`)
    else seenIds.add(stepId)

    if (!String(step?.title || '').trim()) problems.push(`${where}: step has no title.`)
    if (!String(step?.body || '').trim()) problems.push(`${where}: step has no body.`)
    if (step?.section !== undefined && !stepSection(step)) {
      problems.push(`${where}: section needs a non-empty string.`)
    }
    if (step?.copy !== undefined && !stepCopyValue(step)) {
      problems.push(`${where}: copy needs a non-empty string.`)
    }
    if (step?.copyInto !== undefined) {
      if (!stepCopyValue(step)) {
        problems.push(`${where}: copyInto names a field to fill but the step offers no copy value.`)
      }
      checkAnchor(step.copyInto, `${where} copyInto`)
    }
    if (step?.holdMs !== undefined && !(Number(step.holdMs) >= 0)) {
      problems.push(`${where}: holdMs needs a number of milliseconds.`)
    }

    if (step?.placement && !STEP_PLACEMENTS.includes(step.placement)) {
      problems.push(`${where}: placement "${step.placement}" is not one of ${STEP_PLACEMENTS.join(', ')}.`)
    }
    if (step?.align !== undefined && !STEP_ALIGNMENTS.includes(step.align)) {
      problems.push(`${where}: align "${step.align}" is not one of ${STEP_ALIGNMENTS.join(', ')}.`)
    }
    if (step?.cardPosition !== undefined && !stepCardPosition(step)) {
      problems.push(`${where}: cardPosition needs numeric x and y values between 0 and 1.`)
    }
    if (step?.cardSize !== undefined && !stepCardSize(step)) {
      problems.push(`${where}: cardSize needs a positive numeric width and/or height.`)
    }
    if (step?.interaction !== undefined && !STEP_INTERACTIONS.includes(step.interaction)) {
      problems.push(`${where}: interaction "${step.interaction}" is not one of ${STEP_INTERACTIONS.join(', ')}.`)
    }
    if (step?.deferUntilReady !== undefined && typeof step.deferUntilReady !== 'boolean') {
      problems.push(`${where}: deferUntilReady must be true or false.`)
    }
    if (step?.spotlightRing !== undefined && typeof step.spotlightRing !== 'boolean') {
      problems.push(`${where}: spotlightRing must be true or false.`)
    }
    if (step?.spotlightRingShadow !== undefined && typeof step.spotlightRingShadow !== 'boolean') {
      problems.push(`${where}: spotlightRingShadow must be true or false.`)
    }
    checkAnchor(step?.placeAgainst, `${where} placeAgainst`)
    if (knownViews && step?.view && !knownViews.has(String(step.view))) {
      problems.push(`${where}: unknown view "${step.view}".`)
    }

    checkAnchor(step?.anchor, where)
    checkAnchor(step?.openSection, `${where} openSection`)
    checkAnchor(step?.sectionContent, `${where} sectionContent`)
    if (step?.sectionContent && !step?.openSection) {
      problems.push(`${where}: sectionContent says how to tell a section is closed, but no openSection says what opens it.`)
    }

    if (step?.prefill) {
      if (!anchorSelector(step.prefill.anchor)) {
        problems.push(`${where}: prefill needs an anchor to type into.`)
      } else {
        checkAnchor(step.prefill.anchor, `${where} prefill`)
      }
      if (typeof step.prefill.value !== 'string') {
        problems.push(`${where}: prefill needs a string value.`)
      }
    }

    const action = stepAction(step)
    if (!ACTION_TYPES.includes(action.type)) {
      problems.push(`${where}: action type "${action.type}" is not one of ${ACTION_TYPES.join(', ')}.`)
    } else if (action.type === 'click') {
      if (!anchorSelector(action.anchor) && !actionAnchors(action).length) {
        problems.push(`${where}: a click action needs an anchor.`)
      }
      if (action.skipIfFeatureFramed !== undefined && !String(action.skipIfFeatureFramed || '').trim()) {
        problems.push(`${where}: skipIfFeatureFramed needs a chr:start-end feature to compare against.`)
      }
      if (action.skipIfEngaged !== undefined && typeof action.skipIfEngaged !== 'boolean') {
        problems.push(`${where}: skipIfEngaged must be true or false.`)
      }
    } else if (action.type === 'browserView') {
      problems.push(...browserViewProblems(action, where))
    } else if (action.type === 'browserControls') {
      problems.push(...browserControlProblems(action, where))
    } else if (action.type === 'type') {
      if (!anchorSelector(action.anchor)) problems.push(`${where}: a type action needs an anchor.`)
      if (typeof action.value !== 'string') problems.push(`${where}: a type action needs a string value.`)
      if (action.skipIfShowing !== undefined && !String(action.skipIfShowing || '').trim()) {
        problems.push(`${where}: skipIfShowing needs a chr:start-end to compare against.`)
      }
    } else if (action.type === 'navigate') {
      if (!String(action.view || '').trim()) problems.push(`${where}: a navigate action needs a view.`)
      else if (knownViews && !knownViews.has(String(action.view))) {
        problems.push(`${where}: a navigate action names unknown view "${action.view}".`)
      }
    }
    if (action.type === 'click') actionAnchors(action).forEach((a) => checkAnchor(a, `${where} action`))
    else if (action.type === 'type') checkAnchor(action.anchor, `${where} action`)

    for (const arrival of stepArrivals(step)) {
      if (!ARRIVE_TYPES.includes(arrival.type)) {
        problems.push(`${where}: arrive type "${arrival.type}" is not one of ${ARRIVE_TYPES.join(', ')}.`)
      } else if (arrival.type === 'browserView') {
        problems.push(...browserViewProblems(arrival, `${where} arrive`))
      } else if (arrival.type === 'browserControls') {
        problems.push(...browserControlProblems(arrival, `${where} arrive`))
      } else if (arrival.type === 'genomeSelection') {
        if (!Array.isArray(arrival.genomes)) {
          problems.push(`${where} arrive: genomeSelection needs a genomes list, empty for "none selected".`)
        } else if (arrival.genomes.some((entry) => !String(entry?.recipeId || entry || '').trim())) {
          problems.push(`${where} arrive: every genomeSelection entry needs an embedded dataset recipe id.`)
        }
      } else if (arrival.type === 'pageScroll') {
        if (!anchorSelector(arrival.anchor)) {
          problems.push(`${where} arrive: pageScroll needs a registered target to position against.`)
        }
        if (arrival.offset !== undefined && !Number.isFinite(Number(arrival.offset))) {
          problems.push(`${where} arrive: pageScroll offset must be a number of pixels.`)
        }
      } else if (arrival.type === 'dialog') {
        if (!arrivalDialog(arrival)) {
          problems.push(`${where} arrive: dialog needs one of ${TUTORIAL_DIALOGS.join(', ')}.`)
        }
        if (arrival.fields !== undefined && (!arrival.fields || typeof arrival.fields !== 'object')) {
          problems.push(`${where} arrive: dialog fields must name what the dialog's own inputs hold.`)
        }
      } else if (arrival.type === 'playlists') {
        if (!Array.isArray(arrival.playlists)) {
          problems.push(`${where} arrive: playlists needs a list, empty for "no playlists yet".`)
        } else if (arrival.playlists.some((entry) => !String(entry?.name || '').trim())) {
          problems.push(`${where} arrive: every playlist needs the name the tutorial gives it.`)
        }
        const selected = arrivalSelectedPlaylist(arrival)
        if (selected && !arrivalPlaylists(arrival).some((entry) => entry.name === selected)) {
          problems.push(`${where} arrive: the selected playlist "${selected}" is not one of the playlists.`)
        }
      } else if (arrival.type === 'selectorList') {
        if (!anchorSelector(arrival.anchor)) {
          problems.push(`${where} arrive: selectorList needs a registered target.`)
        }
        for (const field of ['fitAllRows', 'preserveOrder', 'lockScroll', 'center']) {
          if (arrival[field] !== undefined && typeof arrival[field] !== 'boolean') {
            problems.push(`${where} arrive: selectorList ${field} must be true or false.`)
          }
        }
      }
    }

    const undo = stepUndo(step)
    if (!UNDO_TYPES.includes(undo.type)) {
      problems.push(`${where}: undo type "${undo.type}" is not one of ${UNDO_TYPES.join(', ')}.`)
    }

    for (const precondition of stepPreconditions(step)) {
      if (!PRECONDITIONS.includes(precondition)) {
        problems.push(`${where}: unknown precondition "${precondition}".`)
      }
    }

    const advance = stepAdvance(step)
    if (!ADVANCE_TYPES.includes(advance.type)) {
      problems.push(`${where}: advanceOn type "${advance.type}" is not one of ${ADVANCE_TYPES.join(', ')}.`)
      return
    }
    if (advance.type === 'view') {
      if (!String(advance.view || '').trim()) problems.push(`${where}: advanceOn view needs a view id.`)
      else if (knownViews && !knownViews.has(String(advance.view))) {
        problems.push(`${where}: advanceOn names unknown view "${advance.view}".`)
      }
    }
    if (advance.type === 'click') {
      // A click step with nothing to click can never finish on its own.
      if (!anchorSelector(advance.anchor || step?.anchor)) {
        problems.push(`${where}: advanceOn click needs an anchor, on the step or on advanceOn.`)
      }
      checkAnchor(advance.anchor, `${where} advanceOn`)
    }
    if (advance.type === 'all-clicks') {
      if (!Array.isArray(advance.anchors) || advance.anchors.length < 2) {
        problems.push(`${where}: advanceOn all-clicks needs at least two anchors.`)
      }
      for (const anchor of advance.anchors || []) checkAnchor(anchor, `${where} advanceOn`)
    }
    if (advance.type === 'signal' && !String(advance.name || '').trim()) {
      problems.push(`${where}: advanceOn signal needs a name.`)
    }
    if (advance.type === 'dwell' && !(Number(advance.ms) > 0)) {
      problems.push(`${where}: advanceOn dwell needs a positive ms.`)
    }
    if (advance.type === 'input') {
      if (!anchorSelector(advance.anchor || step.anchor)) {
        problems.push(`${where}: advanceOn input needs an anchor, on the step or on advanceOn.`)
      }
      if (!String(advance.value || '').trim()) {
        problems.push(`${where}: advanceOn input needs the value to wait for.`)
      }
      checkAnchor(advance.anchor, `${where} advanceOn`)
    }
  })

  return problems
}
