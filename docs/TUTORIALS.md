# Tutorials

A tutorial is a guided walkthrough that runs inside the app itself: the screen dims, one
control is spotlit, and pressing Next performs the step. They can span several apps,
because every app is a `currentView` branch of the same React tree.

Two properties shape everything else, and both are worth keeping:

**A tutorial is a sandbox.** It never writes the user's configuration. It publishes a
`configOverride` — a scratch directory inside their output directory, and its own set of
active genomes — which App layers over the real one. So there is nothing to restore when
it ends, nothing to recover if the app is killed mid-run, and no dialogue asking the user
what they would like to keep. Leaving simply hands the session back.

**A tutorial can do the steps itself.** Every step declares an action, and Next performs
it — switching app, typing, clicking — after pulsing the target so the click is visible
rather than magical. Autoplay is the same thing on a timer. Doing it by hand works too.

**A tutorial runs backwards.** Back is the first thing anyone presses when they miss
something, so every step also declares the state it *expects to find*, and the runtime
establishes that on every arrival — forwards or backwards. Without it, a card describing
what is on screen describes whatever the user last looked at, and pressing Next to redo a
step does it a second time on top of the first. That is `arrive`, below, and it is the
part of the design most easily left out.

There are two. **Getting Started** walks through Configuration → Download → Genome
Selector → Genome Browser using a bundled demo genome, so a new user can complete the
whole loop without downloading a real assembly. **The Genome Browser** stays in one app
and goes through it properly — tracks, panning, zooming to the bases, transcript layout,
gene-class filters, the focus drawer, transcript sequences and notes — on a real slice of
human chromosome 1.

This document is for adding the next one.

## How a tutorial runs

Three pieces, and the split between them is the thing to preserve:

| Piece | File | Responsibility |
| --- | --- | --- |
| The rules | [`frontend/src/utils/tutorialModel.js`](../frontend/src/utils/tutorialModel.js) | What satisfies a step, where the pointer moves, whether a definition is coherent. Pure — no React, no DOM. |
| The wiring | [`frontend/src/hooks/useTutorial.jsx`](../frontend/src/hooks/useTutorial.jsx) | The sandbox, performing actions, finding the anchored element, keeping its rectangle fresh, noticing clicks. |
| The picture | [`frontend/src/components/TutorialOverlay.jsx`](../frontend/src/components/TutorialOverlay.jsx) | The dimming, the hole, the ring, the card. |

```
main.jsx
  └── TutorialProvider          ← above App, so the overlay covers every app
        ├── App                 ← reports currentView in, emits signals in
        └── TutorialOverlay     ← draws the current step
```

**All decision logic belongs in `tutorialModel.js`.** It is unit-tested under bare
`node --test`; the overlay is only checked by source-reading tripwires. A rule that drifts
into the component stops being tested. `tutorialOverlay.test.js` asserts, among other
things, that the overlay does not reimplement the advance rules.

The dimming is **four bands around the hole**, not one sheet with a hole drawn in it, so
the spotlit control has nothing on top of it and stays genuinely clickable. Geometry is
shared with the screenshot overlay in
[`utils/overlayGeometry.js`](../frontend/src/utils/overlayGeometry.js).

## Writing a tutorial

Definitions live in [`frontend/src/tutorials/`](../frontend/src/tutorials/) and are plain
data. Register the new one in [`tutorials/index.js`](../frontend/src/tutorials/index.js);
the Tutorials view and the validating tests both read from there, so registering is all
that is needed to make it appear and to get it checked.

**Which of the two files a built-in actually plays from** is `TUTORIAL_JSON_BUILTINS_ENABLED`
in [`authoring.js`](../frontend/src/tutorials/authoring.js). It is on, so Getting Started
and The Genome Browser run from `tutorials/documents/<name>.tutorial.json` and the `.js`
beside them is the rollback — kept, and asserted equivalent, until the document path has
proved itself. Edit them as a pair or through the card's pencil, which writes both. The
schema below describes the runtime shape both materialise into; the portable document
spells the same things with target references in place of anchors.

The one place they genuinely differ is **which controls a step leaves usable**. A document
lists them; the runtime shape has only its one spotlight and leaves everything inside the
cutout live. That is the same thing right up until the lit thing is a *region* holding more
than one control — the search box beside the button that submits it — where the region has
no capability of its own and the conversion would call the whole step look-only. Such a
step names them in `allow`:

```js
anchor: 'browser-location-search-field',
allow: [
  { anchor: 'browser-location-search', capability: 'input' },
  { anchor: 'browser-location-search-go', capability: 'activate' },
],
```

`allow` does nothing at runtime — the cutout is live either way — and exists so the
rollback can still say what the document says.

**`change` is not typing, and a checkbox needs to be allowed to report it.** The guard
gated `change` on the `input` capability, so a checkbox the step allowed the reader to
*activate* had its change event stopped in the capture phase, before React heard it. The
click still landed, the tutorial's own listener still advanced — so the step moved on
without the box ever ticking, and only by hand: `clickAsTutorial` bypasses the guard, so
Next and autoplay were fine. The Genome Selector's boxes escaped it entirely by being
`readOnly` and driven from `onClick`.

An arrival is the tutorial acting, too. The gene-class filter set its four boxes with a
plain `.click()`, which went through the guard and was refused for any box the step had
not happened to allow — so a step could not establish the filter state its own card
describes. Anything an arrival presses goes through `clickAsTutorial`.

**And so are `ensure` and `undo`, and this one is not only about clicks.** Fixing the
gene-class branch left six branches beside it, and the precondition that focuses REG4,
still pressing and typing as the reader. That precondition types into the search box and
sends Return — and the guard cancels a keydown unless the *current* step happens to allow
`input` on that box, which no step after the search does. So every step needing the focused
gene, fifteen of them, arrived with no gene focused, no drawer, no focus bar and nothing
for the spotlight to land on: a third of the browser tutorial, unreachable by jumping in or
by walking back, while walking forward was perfect. `actAsTutorial(fn)` now lifts the guard
around any synchronous block, `clickAsTutorial` is written in terms of it, and a test fails
on any bare `.click()` left in the runtime.

**A synthetic press has no pointer, and the app may assume it does.** Hiding a transcript
from the drawer deliberately marks that row hovered and ghosts the transcript on the track
— a reader presses that button with the pointer sitting there and wants to see what they
just removed. Nothing releases it but a real `mouseleave`, so when the tutorial pressed it
the row stayed lit and the transcript stayed ghosted through the whole step that followed,
reading as a second highlight competing with the step's own. The arrival now dispatches
`mouseout` on the row; note that React derives `onMouseLeave` from `mouseout`, so
dispatching `mouseleave` alone does nothing. **When an arrival presses something, ask what
the app infers from the pointer that was not there.**

**Arrival branches have an order, and it is a dependency order.** `browserControls` reads
as a set of independent settings, but the drawer's fold decides whether the rows beneath it
exist at all: collapsed, the drawer lists one transcript, so a non-canonical transcript's
show/hide button is not in the DOM and the wait for it burns its whole budget. The fold has
to run first, and both have to run before the per-gene pill, since restoring a transcript
changes how many rows the gene shows. A test pins both orderings with the reasons.

**And a branch that presses a control has to wait for it.** The fold looked its control up
with `findAnchor` rather than `waitForAnchor`, and on a direct jump the drawer mounts only
once the gene has taken focus — so perhaps half the time the fold was skipped in silence
and everything under it worked on a one-row list. Silence is the tell: none of these three
threw, logged, or failed a test.

The lesson is worth stating plainly, because this is the third time it has been found in
the same place: **whenever the runtime touches the page on the tutorial's behalf, ask which
step's policy is live at that moment.** For an arrival, an `ensure` or an `undo`, the live
policy belongs to the step being prepared — which is exactly the step that has not happened
yet, and whose allowances describe what the reader will be permitted to do, not what the
tutorial must do to get there. Keep the block synchronous: a flag held across an `await`
would let a reader's input through with it.

**This is the failure mode to know about, because it is silent and it looks like nothing.**
A step spotlighting a group, a row or a wrapper converts to an *explicit look-only* policy,
since none of those carry a capability of their own. The tutorial can then still perform
the step — Next goes through `clickAsTutorial`, which the interaction guard ignores — so
autoplay works perfectly and only a reader doing it by hand finds the control dead. Three
steps shipped that way when the built-ins moved to documents: ticking the demo genome in
Getting Started, unticking the three gene classes, and the CDS/protein sequence buttons.
`tutorials.test.js` now fails any step that asks for an action while permitting none. It goes when the rollback does.

```js
export default {
  id: 'my-tutorial',              // stable: it is the key for "completed" and for resume
  title: 'My Tutorial',
  blurb: 'One or two sentences for the catalogue card.',
  estimatedMinutes: 5,
  usesDemoGenome: false,          // shown on the card
  completionBody: 'Shown on the card at the end.',
  steps: [ /* … */ ],
}
```

### The step schema

```js
{
  id: 'open-config',              // unique within the tutorial
  view: 'configuration',          // which app this step belongs to
  anchor: 'app-button-configuration',
  placement: 'bottom',            // top | bottom | left | right | center
  align: 'end',                   // start | center | end — along the other axis
  section: 'General controls',    // chapter heading shared by a run of related steps
  title: 'Open Configuration',
  body: 'Every app reads from one configuration.',
  advanceOn: { type: 'view', view: 'configuration' },

  action: { type: 'click', anchor: 'x' },   // what Next does; usually inferred
  interactive: false,                        // spotlight it, but do not let it be used
  deferUntilReady: true,                     // scroll/settle first, then show this step
  spotlightRing: false,                      // keep the cutout, omit its ring and shadow
  spotlightRingShadow: false,                // keep the ring, omit only its dark shadow
  ensure: ['demo-genome-active'],            // what must be true before this step runs
  undo: 'deactivate-demo-genome',            // what Back puts back on the way out
  reveal: { anchor: 'x', whenTyped: 'y' },   // something else to un-dim, conditionally
  prefill: { anchor: 'download-search', value: 'Ensemblus' },
  openSection: 'config-section-outputs',
  arrive: { type: 'browserView', locus: '1:119,000-120,000' },  // the state this step expects
  autoplayMs: 9000,                          // how long autoplay lingers here
  settleMs: 8000,                            // how long Next waits for this step's signal
}
```

Only `id`, `title` and `body` are required. A step with no `anchor` is a plain card —
use `placement: 'center'`.

`deferUntilReady` is for a target inside a panel that has to open or scroll on arrival.
Normally the card remains visible while a step prepares, with Next temporarily disabled.
When this flag is true, the screen stays quietly dimmed until preconditions, `arrive` and
the anchor's scroll-into-view repair have settled; the card and spotlight then appear
together around the target at rest. Use it sparingly—a moving highlight is the signal
that this option is needed.

`section` gives a longer tutorial its narrative chapters. The overlay renders the section
as the card heading and the step's `title` as its subheading; the expandable step catalogue
uses the same labels to group its jump links. Choose boundaries by idea, not by size: “General
controls”, “Displaying transcripts” and “Browsing a gene in detail” may contain quite
different numbers of steps and still make the route easier to understand. Sections must be
contiguous. Once one step in a tutorial uses `section`, every step must name one so the
hierarchy does not disappear halfway through.

### `action` — what Next does

| Type | Shape | Effect |
| --- | --- | --- |
| `none` | `{ type: 'none' }` | Just advance. |
| `click` | `{ type: 'click', anchor }` | Pulse, then click it. `anchors: [...]` clicks several controls in order; `pauseMs` sets the viewing pause between them and `endPauseMs` holds the final result. `skipIfFeatureFramed` can name a genomic feature whose already-framed state means the user has done it themselves; `skipIfEngaged` skips a target already publishing `data-tutorial-engaged="true"`. |
| `type` | `{ type: 'type', anchor, value }` | Pulse, then type. Submits with Enter unless `submit: false`, because these fields act on Enter. Leaves what the user typed alone unless `overwrite: true`. `skipIfShowing: '<locus>'` does nothing at all when the browser is already there — the user has done the step themselves and typing over it would be rude. |
| `navigate` | `{ type: 'navigate', view }` | Switch app. |
| `browserView` | `{ type: 'browserView', pan }`, `{ …, zoom }`, `{ …, locus }` | Move the genome browser: `pan` in windows, `zoom` as a factor on the span, `locus` as `chr:start-end`. `durationMs` controls one continuous move; `moves: [...]` performs several distinct moves in turn; `pauseMs` holds the result. `skipIfMoved` leaves any manually changed view alone, while `skipIfSequenceVisible` specifically treats a rendered base-level sequence lane as completion. |
| `browserControls` | `{ type: 'browserControls', detail, flatten, expanded, biotypes, drawerTranscripts, transcriptSequence }` | Put the browser's switches in a named state. Sets rather than toggles. |

A `click` action may name several targets — `{ type: 'click', anchors: ['a', 'b', 'c'] }` —
which are pressed in turn with the usual pause between, or `pauseMs` when the result needs
longer to read. `endPauseMs` gives the last result the same consideration. It is for a step whose one idea
takes more than one press: unticking three gene classes to leave only protein-coding is
one step and three visible clicks, not three steps.

**A multi-anchor click that advances on a click must advance on the last of them**, with an explicit
`advanceOn: { type: 'click', anchor: <the last one> }`. The default advance watches the
step's own anchor, which is usually the first press — so the step ends while the other
presses are still queued, and they land *after* the next step's `arrive` has established
its state and switch it straight back. That is how Flatten stayed on for the second half
of the browser tutorial, which in turn squeezed the note mark off the track: two steps
later, a symptom with no visible connection to its cause. A manual-advance step is exempt:
Next waits for its whole action before advancing. A test enforces both cases.

**A declared locus is framed around the drawer.** The focus drawer is `absolute right-0`
— it overlays the canvas rather than narrowing it, so the window never shrinks and roughly
a fifth of the right-hand side is simply covered. Every "put this on screen" path in the
browser already re-frames for that; the tutorial's own `goToLocus` did not, so a step
naming a window around the focused gene centred that gene *behind* the drawer, with its far
end hidden. It now goes through the same `frameFocusRange`, which is a no-op whenever no
drawer is open. Two related behaviours were already right and are worth not breaking: the
inset deliberately ignores the transcript detail panel — someone reading metadata is not
reading the track, and re-framing every time it opens would shuffle the browser under them
— and collapsing the drawer rescales the view to use the space it gives back.

**`browserView` is the odd one out** and deserves its reasoning. The browser has no zoom
button and no slider: panning is a drag or the arrow keys, zooming is the wheel or
`+`/`-`. So there is no control for a tutorial to click, and adding one purely so the
tutorial could press it would teach a control nobody otherwise uses. Instead the step
stays **interactive**, so the hole over the canvas leaves the real track draggable and
scrollable, and Next drives the browser's own animated move on the user's behalf — unless
`skipIfMoved` is set and the user has already gone somewhere, in which case the tutorial
leaves them where they are. Those steps read the way the rest do — the action first, the
shortcut second:

> Drag the track sideways to travel along the chromosome, or use the arrow keys once you
> have clicked it — hold Shift for a bigger jump. Press Next and the tutorial will move it
> for you.

The plumbing is a module-level registry,
[`utils/browserTutorialControls.js`](../frontend/src/utils/browserTutorialControls.js):
each browser panel publishes `panByWindows` / `zoomBy` / `goToLocus`, all of which go
through the panel's own `animateToView`, so a tutorial's pan travels at the same speed and
stops at the same edges as one the user performs. The same module carries the one note
handler `undo` needs. Nothing is threaded as a prop — the tutorial reaches the app through
`document.querySelector` and this registry, and nothing in the component tree has to know
a tutorial exists.

Usually you do not write one. It is inferred: a step with a `prefill` types it, a step
whose `advanceOn` is a click clicks it, a step whose `advanceOn` is a view clicks its
anchor (the app button — so the tutorial's cursor can be seen pressing it) and falls back
to switching app directly when that button is not on screen, and anything else does
nothing.

**A `signal` advance infers nothing.** This is the one that bites: a step waiting on
`demoGenome.installed` looks complete, but Next will walk straight past it without ever
pressing the button the step is about, and the only symptom is that the thing never
happens. Spell the action out. A test in `tests/tutorials.test.js` enforces it for every
anchored, interactive step.

`overwrite: true` is for steps where only one value works at all. The browser search is
the case: this genome knows six gene names, so anything else simply fails to resolve and
the step sits there looking broken. Elsewhere leave it off — replacing what someone typed
is rude.

### `arrive` — the state a step expects to find

The counterpart to `action`. `action` is what Next *does*; `arrive` is what has to be true
before the card is read, and the runtime performs it every time the step is entered.

```js
arrive: { type: 'browserView', locus: '1:119,635,000-119,785,000' }
arrive: [
  { type: 'browserView', locus: '1:119,635,000-119,785,000' },
  { type: 'browserControls', detail: false, flatten: false, expanded: true },
]

arrive: {
  type: 'selectorList',
  target: { id: 'selector.genomeList', version: 1 },
  fitAllRows: true,
  preserveOrder: true,
  lockScroll: true,
  center: true,
}

arrive: { type: 'genomeSelection', genomes: ['tmnt-leonardo-v1', 'tmnt-raphael-v1'] }

arrive: [
  { type: 'dialog', dialog: 'playlistMembership', fields: { name: 'Turtles' } },
  { type: 'playlists', playlists: [{ name: 'Turtles', description: 'The four turtle genomes.', genomes: ['tmnt-leonardo-v1'] }] },
  { type: 'pageScroll', target: { id: 'selector.addSelectedToPlaylist', version: 1 }, offset: 214 },
]
```

Seven types, all idempotent by construction — they **set** rather than toggle, because
`arrive` runs on every visit and a toggle would flip back and forth as someone walked
about:

| Type | Sets |
| --- | --- |
| `browserView` | Where the browser is looking: `locus`, or `pan` / `zoom`. |
| `browserControls` | `detail`, `flatten`, `expanded` (booleans), `biotypes` (`'all'`, `'protein-coding'`, or a list of the classes left showing — `['proteinCoding', 'pseudogene', 'smallNonCoding']`), `drawerTranscripts` (`'collapsed'` or `'expanded'`), `geneTranscripts` (`{ gene, expanded }` — one named gene's own rows, which is a different control from `expanded`), `hiddenTranscript` (`{ transcript, hidden }`). Only the keys given are enforced. |
| `selectorList` | A stable Genome Selector teaching scene. A semantic list `target` can be centred without highlighting it; `fitAllRows`, `preserveOrder`, and `lockScroll` keep a small complete list visible and stationary while selections change. It also reserves the selected-genomes strip's place in the header from the moment the scene arrives — invisible while empty — so the first genome ticked fills a space that was already there rather than pushing every row down the page. |
| `genomeSelection` | Which of the tutorial's embedded genomes are selected, named by their `recipeId`s. The resulting set, not a list of clicks, so re-entering the step selects the same genomes rather than toggling them. `genomes: []` is a real instruction: arrive with nothing selected. |
| `pageScroll` | Where the page is scrolled: a `target`, and the `offset` in pixels between the top of the scrolling region and the top of that target. Applied last, after everything else that changes the page's height, and smoothly during playback. |
| `dialog` | Which dialog or popover is open: `'playlistMembership'`, `'playlistPopover'`, or `'none'` for closed. `fields` states what the dialog's own inputs hold. |
| `playlists` | Which playlists exist, named and described as the tutorial asks the user to name them, with members as embedded dataset recipe ids. `selected` names the one being shown. `playlists: []` is a real instruction: none created yet. |

`genomeSelection` is what lets a step talk about the *result* of a selection the user made
one step earlier. Selecting four genomes is the previous step's task, so a step whose card
points at the selected-genomes strip found it empty whenever it was reached any other way —
from Back, from a skipped step, or from the builder's step list. Declaring the selection
makes the step self-contained: the strip is populated before its card is read, however the
step was reached. Give the selection step itself `genomes: []` so returning to it shows the
selection being made rather than one already made.

Recipe ids, not species keys, because the recipe id is what the portable document knows.
Only the runtime knows what a dataset installed as, and the builder reports a step that
names a dataset no longer attached to the tutorial.

What gets selected is the genome **as the app's own catalogue lists it**, not as the
installer returned it. The two disagree about which dataset release the annotation belongs
to and therefore about the genome's identity, and selecting the installer's record leaves
a pill in the top bar whose own row, in the list below, still reads as unselected.

`pageScroll` is how a step is *framed*. A step is not only a highlight; it is a view of
the app, and a control near the bottom of a long page arrives half off the screen with its
card cut off beside it if the page is left where the previous step happened to leave it.
Centring the target instead is no better — an author composing a picture is choosing where
in the frame the subject sits, not asking for it to be put in the middle.

So the position is authored the way it was seen. The author scrolls the app until the step
looks right and presses **Use current position**; what is stored is a registered target and
how far below the top of the scrolling region it was sitting. Expressing it against a target
rather than as a raw `scrollTop` keeps it meaningful when the page above it grows — a pill
strip appearing, a longer list — and frames the same picture at a different window height.

A step with a `pageScroll` arrival does not also get the runtime's scroll-into-view repair.
That repair exists to rescue a target something has scrolled out of sight and it centres,
because a rescue has no better idea; running it after an authored position would only throw
the composition away. It also defers the step's presentation, so the spotlight is struck
around the target at rest rather than somewhere it was passing through.

`dialog` is the same argument one degree further. A dialog is the one thing a step
cannot arrive at by describing it: until something opens it there is no element for the
spotlight and no panel for the card to talk about, so the step after "press Add selected
genomes to playlists" is unreachable except by performing the step before it — including in
the builder. The step that opens the dialog should declare `dialog: 'none'`, exactly as the
step before a selection declares `genomes: []`: without it, coming Back leaves the dialog
sitting over the button the reader is being asked to press. Which genomes the dialog opens
for is not authored — it is always the selected set, which is what pressing the button by
hand would have done, and what the `genomeSelection` arrival on the same step establishes.

A step that types into a field is finished the moment the field says the right thing. Next
does nothing when the reader has already written their own answer, and nothing when the
field already holds the exact value a step insists on — so pressing Next after doing the
step by hand continues rather than replaying it. `overwrite` is what chooses between the two
readings of "the right thing", and the builder states it as *only this value will do*.

`fields` covers the rest of a dialog: a form the tutorial fills in over three steps — name
it, describe it, save it — loses its text the moment the dialog is re-established, which is
exactly what going Back does, leaving the reader on "press Add genomes" beside an empty
form. So the step that asks for the name arrives with the field empty, and the step after it
arrives with the name already in place. It fills what is empty rather than replacing what
is there, so a reader who wrote their own description keeps it.

`playlists` is the same idea again for the thing the tutorial *creates*. Everything after
the step that makes a playlist depends on it existing, and reached any other way the card
describes a row that is not there. Worse than the pills case, because redoing the creation
step then fails outright: the app refuses a second playlist with the same name. Declaring
the whole set — replaced, not merged — makes each step self-contained and the creation step
repeatable, and gives the step before it something true to say with `playlists: []`.

`selectorList` is presentation state, not permission. Its `target` must not be copied into
`spotlight`, `reveals`, or `interactionPolicy` unless the step independently needs one of
those behaviours. In particular, centring the whole list does not undim it, and locking its
scrolling does not affect which child controls may be clicked.

Three things this bought, each of which was a bug first:

A step with **no** `interactionPolicy` at all leaves everything inside its highlight live;
an **empty** one (`targets: []`) is the explicit "look only". The difference matters for a
step that describes a panel the reader is asked to use one step later — the dialog is the
case that found it — and the builder now says so rather than claiming look-only for both.
The policy governs the reader: the tutorial's own presses, including opening a collapsed
section to reach its target, are not subject to it.

- **A card can describe what is on screen.** "PHGDH has thirty-eight transcripts" used to
  be read while the browser was still showing a single exon, because the move happened on
  Next. Now the step arrives at PHGDH and the sentence is true when it is read.
- **Back works without pairing steps up by hand.** `undo` needs the step you are *leaving*
  to know what the step you are *returning to* wants. `arrive` needs neither to know about
  the other. The only `undo`s left are the two things that are not expressible as a state:
  clearing the focused gene, and deleting the note the tutorial wrote.
- **A step stops depending on how it was reached.** The focus drawer opens folded or
  unfolded depending on what the window-wide expand control was last set to, so the step
  whose task is to unfold it used to collapse it instead, roughly half the time.

Two traps, both of which cost real time:

**An arrival's own clicks must not finish the step.** `browserControls` works by pressing
the very controls the step is often about, and the runtime's click listener cannot tell
those from the user's. `arrivingRef` suppresses click-advance while an arrival runs; a
step that sets up by pressing its own target would otherwise complete the instant it
began.

**The card says nothing while a step gets ready.** Preconditions and arrivals both run
under a busy flag, which disables Next until the step has settled. It used to put
"Getting things ready…" on the card as well; a line of text that appears and disappears
resizes the card and shifts it while it is being read, which is a worse problem than the
one it solved. The flag survives as `data-tutorial-busy` on the card — for the disabled
Next, and for probes to wait on.

**Order matters where controls disable each other.** Detail disables the expand control
while it is on, so `browserControls` sets `expanded` first — turning Detail off around it
if it has to — and applies Detail afterwards. Setting them in the order written pressed a
dead button and the step arrived in a state it had not asked for.

### `align` — pinning the card

`placement` decides which side of the target the card goes; `align` decides where it sits
along the other axis. `start` (the default) lines the leading edges up, `end` the trailing
ones — so `placement: 'left'` with `align: 'end'` puts the card beside the control with
their bottom edges level.

Setting it also **pins** the card: the runtime places it against the step's own target,
clamps it onto the screen, and never relocates it to a different side. That is the reason to reach
for it. A card placed to clear a revealed area has to move whenever that area's rectangle
changes — and for a browser step the revealed area is the track, whose rectangle changes
as the view does. The card then repositions itself while it is being read, which is worse
than sitting slightly close to something.

### `placeAgainst` — a card placed relative to something else

```js
anchor: { selector: '[data-browser-canvas-surface]' },
placement: 'top',
placeAgainst: 'browser-track-gr-band',
```

Spotlight one thing, place the card against another. For the browser steps that light up
the whole track: there is nowhere for the card to go that is not over the genes being
described, so it is placed above the reverse track's top edge instead and sits clear of
everything on that strand.

Like `align`, setting it means the author has decided, so the runtime stops consulting the
revealed area. Which edge is the clear one depends on the gene — TBX15 is on the reverse
strand, so above the GR band is empty; for a forward-strand gene the same placement would
land straight on it.

`browser-track-gr-band` is an invisible, `pointer-events: none` marker over the reverse
track, the same trick as the gutter markers. Nothing points *at* it.

**Not everything over the canvas is painted on it.** The transcript footer pills — the
`+N` under a collapsed gene and the X under an expanded one — are real DOM positioned over
the drawing surface, because that buys hit-testing, hover and an accessible name for
nothing. So they take a `data-tour-id` directly and need none of the marker-div machinery
the track gutter does. The pill also publishes `data-tutorial-engaged`, which is what lets
`browserControls: { geneTranscripts: { gene, expanded } }` *set* a gene's rows rather than
toggle whatever it finds — the same trick as Detail and Flatten. It is applied after the
window-wide switches, because expand-all and Flatten both change what the pill is showing.

**A track's footer must fit inside the track**, and how much room that takes depends on
the layout: the offsets are absolute pixels tuned for the ordinary 42-pixel row pitch, and
a flattened track's pitch is 18. One fixed reserve was generous for the first and six
pixels short for the second — and Flatten makes the panel compact, which puts the ruler
immediately after the last track, so those six pixels landed on the ruler rather than in a
margin. `geneFooterTrackOverflow` derives it from the metrics instead. Behind that,
`intersectsRuler` drops any label or control that would still reach the ruler band: the
arithmetic has four inputs, and being wrong about one of them should cost a hidden label
rather than a ruler drawn through a gene symbol.

**Flatten used to take that pill away with it**, along with the gene's own name — it
dropped the footer overlay, the expanded footer and the canvas label together, so a
flattened gene had nothing identifying it and no way back, and the step pointing at the
control found nothing to point at. Flatten is a *height* control; the label and the pill
are content, not slack, so the track keeps the eight pixels they need
(`geneFooterOverflow`). Compressed layouts do still drop them, which is honest: they have a
pixel or two of padding and nowhere to put a footer. A tripwire in
`tutorialOverlay.test.js` asserts `flattenTracks` is not back in that condition.

That control is per gene. `expanded` in the same arrival is the window-wide one in the bar
above, and the two are genuinely different: the tutorial teaches the pill on TBX15's three
transcripts in *Moving through the genome*, and the bar on PHGDH's thirty-eight in
*Displaying transcripts*.

**A control the reader must submit needs its submit button inside the highlight.** The
search box and its go button are one control to a reader, and spotlighting only the field
leaves the button that finishes the job dimmed beside it — which bites here in particular,
because the field empties itself the moment it is used, so the reader is left with no
visible way to complete the step at all. `browser-location-search-field` is on the wrapper
for exactly that, with `browser-location-search-go` on the button so the click can be
allowed. Prefer this to two rings on two adjacent controls: at three pixels apart they read
as one smudged highlight, not two.

### `cardPosition` — a manually placed card

```js
cardPosition: { x: 0.02, y: 0.02 },
```

This overrides the automatic placement with the card's top-left position as fractions of
the viewport. It is deliberately not stored in pixels: a position chosen on one display
then remains meaningful after a resize or on a different resolution, and is clamped so
the complete card stays on screen.

The usual way to create it is the in-app authoring mode below. Open the pencil and drag
the dotted handle in the card header; releasing the card writes the normalized position
back to this property.

### `cardSize` — an authored width and/or height

```js
cardSize: { width: 440 },
cardSize: { width: 440, height: 280 },
```

Dimensions use CSS pixels rather than viewport fractions, keeping line lengths readable
on a larger display. Either edge can be saved independently; an omitted height remains
content-sized. The runtime limits width to a modest 300–620px range and always clamps the
height and width to the current viewport. If an authored height is shorter than its copy,
the card scrolls internally rather than hiding controls below the screen.

### `defaultArrive` — the state every step assumes

A tutorial-level `arrive`, run before each step's own. The browser tutorial declares the
plain transcript layout there, and every browser step names the view it expects, because
the alternative was steps inheriting whatever the last one left:

> almost the entire app was highlighted when I hit back … another time the general control
> bar was off screen, but the step was highlighting where a button should have been … it
> was highlighting some whitespace in the GF track which had grown large because of
> zooming in/out

Zooming and expanding transcripts change how tall the tracks are and where the panel is
scrolled, so an anchor ends up hundreds of pixels from where the step expects it. Three
things together make it deterministic: `defaultArrive` for the layout, a `browserView`
arrival on every browser step, and the runtime scrolling the panel back to the top before
it measures anything. A test enforces the middle one for any tutorial that moves the
browser.

When both `defaultArrive` and the step declare `browserControls`, the model coalesces them
into one set operation, with the step's keys winning. This matters for demonstrations: a
default `expanded: false` followed by a step's `expanded: true` used to collapse and then
re-expand the canvas during arrival, obscuring the before/after transition the previous
step had just produced.

Panels count too. A step whose target lives inside one an earlier step opened — the
transcript detail pane, the note editor — has to say so, or walking back to it finds
nothing to point at and the spotlight simply vanishes. `transcriptDetail`, `noteEditor`
and `tutorialNote` are the states for that. **Order within `arrive` matters**: opening the
detail pane narrows the track and the browser re-frames, so the panel goes first and the
view second.

### `interaction` — handing the track back, for one thing

```js
interaction: 'zoom-only',
```

`all` is the default. `zoom-only` holds the view where it is and leaves zooming working,
for a step whose point is that the browser is now the reader's to play with — but where
panning away would lose the gene the step is about and the point at the same time.

Guarded at `panByPx` in the panel rather than at each gesture, because dragging, the
wheel, the arrow keys and the momentum fling all arrive through that one function, and
`animateToView` deliberately does not — so a step can still put the view where it wants
it. The gutter is held too: a switch that blanks a track is not zooming, and someone told
they can only zoom should not be able to empty the screen by clicking slightly to the left
of it.

**Set on every arrival**, from `stepInteraction(step)`, so a limit one step wanted cannot
follow the reader into the next. Also reset on teardown, so the browser is handed back
working whatever the last step asked for.

### `copy` — a value the card hands over

```js
copy: '1:118,440,000-120,120,000',
```

Renders the value on the card with a copy button. For steps that ask the user to enter
something too long to retype: nineteen characters of coordinate is a typo waiting to
happen, and nobody would type one out in earnest either — they would copy it.

Only for values where **one value works and nothing else does**, which `overwrite: true`
on the action already marks. Where the value is illustrative — the text of a note, a
species name typed so the list can be watched filtering — the user is meant to supply
their own, and handing them the tutorial's says otherwise. A test enforces the pairing in
both directions.

Next still types it, character by character, so the demonstration is unchanged for anyone
watching rather than doing.

### `copyInto` — the field the value belongs in

```js
copy: '1:119,368,000-119,395,000',
copyInto: 'browser-location-search',   // portable: copyTarget
```

Names a field, and pressing the chip puts the value there instead of leaving it on the
clipboard for the reader to place. A clipboard is a detour, and here it is a broken one:
the app's right-click menu is not the browser's, so the gesture anyone would reach for
does nothing, only Command-V works, and nothing on screen says so. Naming the field turns
the chip into the shortcut it was already pretending to be — the icon changes to say where
the value is going, and the label reads *Filled in* rather than *Copied*.

The value still reaches the clipboard, for anyone who wanted it elsewhere. Filling leaves
the field focused and does **not** submit: pressing Return, or the button beside it, stays
the reader's move, because the step is about searching and doing it for them would remove
the step. It fills over whatever is there, which is safe for exactly the reason `copy` is
allowed at all — only that value works.

Authored in the builder under **Value offered on the card**, which offers only targets
that accept input.

### `reveal` — lighting something else up

A step spotlights one thing, but sometimes the point is what that thing *does* to
something else. `reveal` names a second element to cut out of the dimming — the download
search reveals the list it filters — optionally only once `whenTyped` names a field with
something in it, so the reveal lands at the moment the filtering starts.

Revealed is not the same as interactive: the blocker bands still cover it, so it is lit
but cannot be clicked by mistake. The card is placed clear of everything lit, not only the
step's own target, or it lands on top of the list it just asked the user to watch.
When the spotlight sits inside the revealed element — for example a drawer over the
browser canvas — their rectangles are unioned before drawing, so the overlap cannot be
cut out twice and become dim again.

### `undo` — what Back puts back

Most steps need nothing; going back a page in an explanation costs nothing. A step whose
*point* was to cause something is different. Leaving the genome activated means the step
before it cannot be watched again: the checkbox is already ticked, and clicking it now
does the opposite of what the step says. So the step after it carries
`undo: 'deactivate-demo-genome'`, and Back performs it before the step pointer moves. The
focused-gene step carries `undo: 'unfocus-gene'` for the same reason.

Note where it lives: on the step you are leaving, not the step you are returning to.

Most of what used to need an `undo` is now expressed as `arrive` on the step itself, which
covers Back without pairing steps up by hand. What is left is the two things that are not
a state the runtime can set: `unfocus-gene`, and `delete-tutorial-note` — which removes the
note the tutorial wrote, so the step that writes it adds one note however many times it is
watched.

**A precondition must never undo the step before it.** The last step of the browser
tutorial points at the note mark left on the gene, and the step before it unfocuses that
gene. Giving the last step `reg4-gene-focused` — which every other step in that section
carries — had the precondition quietly refocus the gene and reopen the drawer over the
very thing being pointed at. A test now asserts it does not.

### `holdMs` — letting the result be seen

```js
holdMs: 1800,
```

How long a step's result stays up once the step is satisfied, before the tutorial moves
on. Applied wherever the advance is dispatched, and again in `next` after an action, so it
is the same whether Next did it or autoplay did.

**Two paths reach it, and they disagree about who acted.** After Next has done something,
`next` waits only if `performAction` reports it actually did — someone who had already
pasted the region themselves has watched it land, and holding them there would be the
tutorial pausing over their own work. An advance arriving as an *event* is different:
`dispatchAfterHold` applies the hold whoever caused it, because the point of a hold is
that the result is somewhere other than the control, and that is as true when the reader
presses Return as when Next does.

**The step's highlight comes off the moment it is satisfied**, rather than at the end of
the hold. The task is done by then; a ring still sitting on the control says there is
something left to do with it, and for the search box there is not even that — it empties
itself on a successful search, so the ring spends the whole pause around an empty box
while the answer is on the track behind it. Only the ring goes. The cutout and the card
stay exactly where they were, because a step that is ending must not move the card it is
still being read from. `settledStepId` in `useTutorial.jsx` is the flag, set only for the
event that actually finishes the step — `isAdvanceEventMatch` decides, so a signal the
step is not waiting on leaves it alone — and cleared on the way to the next step.

This is not the same as the pause the runtime already applies after acting on the user's
behalf. That one deliberately does **not** apply to anything the user did: their own click
needs no pause to be understood, because the result is under the cursor. It is wrong when
the result is somewhere else entirely — pasting a region into the search box redraws the
whole track, and advancing the moment it lands means never seeing the thing you asked for.
Both region and gene searches carry one for that reason.

**`skipIfEngaged` reads every control the action would press, both ways round.** It used to
read one attribute on one anchor, and the step it was written for has neither: the sequence
step presses two buttons, its legacy definition named a wrapper around the pair that reports
`data-tutorial-engaged`, and the portable document keeps only the controls actually pressed
— which are buttons, reporting `aria-pressed`. A reader who had pressed CDS or protein
themselves still watched the cursor press both again, eleven seconds of the tutorial
ignoring what they had just done. This is the general shape of every `skipIf…`: the check
has to be true of the state the *reader* can reach, not of the shape the definition happened
to be written in.

### `settleMs` — waiting for a signal

Next performs the step's action and then, for a step advancing on a `signal`, waits up to
`settleMs` (default 2.5s) for that signal before advancing anyway. Raise it when the thing
takes longer — the download step allows eight seconds.

This is not just cosmetic. Advancing the instant a click lands arrives at the next step
while the last step's effect is still in flight, and that step's `ensure` then brings
about the very thing still coming — so the two undo each other. That is exactly how the
genome came to tick on and then straight back off.

### `interactive: false`

Spotlights the target without letting it be used — the hole is covered along with
everything else. For steps that are pointing something out rather than asking for it.
Without it, a user reading about the file-type chips can toggle one and derail the run.

### `ensure` — preconditions

Named states the runtime brings about on arrival, so skipping cannot strand a later step:

| Precondition | Does |
| --- | --- |
| `demo-genome-installed` | Installs the demo genome into the sandbox if it is not there. |
| `demo-genome-active` | Installs it if needed, then makes it the active genome. |
| `slice-genome-installed` | The same for the chromosome-1 slice the browser tutorial runs on. |
| `slice-genome-active` | The same. |
| `reg4-gene-focused` | Focuses REG4, so the drawer half of the browser tutorial is never reached empty. |

Any step that depends on an earlier one must declare this. A user who skips the download
still has to arrive at the browser with something to look at. A test enforces it.

### `advanceOn`

| Type | Shape | Finishes when |
| --- | --- | --- |
| `manual` | `{ type: 'manual' }` (the default) | The user presses Next. Right for a step that only explains something. |
| `view` | `{ type: 'view', view: 'download' }` | That app becomes active. For "open the X app" steps. |
| `click` | `{ type: 'click' }`, or `{ type: 'click', anchor: 'other' }` | The anchored element is clicked. Defaults to the step's own `anchor`. |
| `signal` | `{ type: 'signal', name: 'config.saved' }`, optionally `match: { key: 'value' }` | The app reports that state transition. |
| `dwell` | `{ type: 'dwell', ms: 3000 }` | That long passes. For "watch this" moments. |
| `input` | `{ type: 'input', anchor, value, ms: 500 }` | The anchored field holds `value` — trimmed, case-insensitive — for `ms`, or the user presses Return with it already right. For a step whose whole task is "type this here". |

Use `input` rather than `manual` whenever typing *is* the step. Someone who types the
right thing and stops should not be left looking for what else is wanted, and Return —
which they will reach for anyway — takes it immediately. Next still works, and if the box
holds the wrong thing Next's `overwrite` action corrects it and the same watcher then
advances.

Prefer `signal` over `click` when what matters is that something *happened* rather than
that a particular pixel was pressed — a click on Save does not mean the save succeeded.

### Pacing, and the cursor

Actions taken on the user's behalf are performed by a visible cursor — a coloured,
pulsing disc, deliberately not an arrow, because an arrow is what the user's own pointer
looks like and one moving by itself reads as the mouse having been taken over. It travels
onto the target, presses, and then **disappears**: what happens next is usually visible
exactly where it clicked — a box ticking, a download's progress filling in, text landing
in a field — so a parked cursor hides the result of the action it was demonstrating.

Three more rules of pacing, each of which was a complaint first:

- **Text is typed a character at a time** (`typeInto`), not assigned. A value that appears
  fully formed is over before it registers as typing at all.
- **Anything the tutorial just did is held on screen** for `ACTION_PAUSE_MS` before the
  app's own events are allowed to move the step on — `holdUntilRef` and
  `dispatchAfterHold`. A checkbox that ticks and transitions in the same instant is
  jarring even when it is exactly what you asked for. Events the user causes are never
  delayed; only the tutorial's own.
- **Everything is scaled by the chosen speed.** `AUTOPLAY_SPEEDS` in `tutorialModel.js`
  gives three: 30% slower, normal, 20% faster, shown in the card footer as three arrows
  filled up to the chosen one, so it reads as a level rather than three buttons. The
  factor multiplies cursor travel, the press, typing, the hold and the autoplay dwell —
  a "faster" that only shortened the gap between steps would still crawl through each
  one. Wrap any new delay in `paced()`; a test checks that each timing constant is.

Autoplay itself is Next on a timer. How long a step gets comes from **how much there is to
read on it** — `stepDwellMs` in `tutorialModel.js`, a base plus per-word reading time,
bounded at both ends — because a fixed dwell suits a fixed amount of text and steps do not
have one. `autoplayMs` on a step overrides that outright, for steps where the wait is
about something finishing rather than something being read: the download allows nine
seconds for a five-second download.

While autoplay runs the step card traces its own edge over the time remaining
(`tutorial-trace` in `index.css`), so "about to move on" is visible without a number
counting down. Changing speed mid-step does **not** restart it: the progress made is kept
as a fraction and handed to the new run as a negative `animation-delay`, so the ring picks
up where it was at the new rate. Restarting would punish someone for adjusting the speed
while reading — which is exactly when they would.

Spotlights on things the user may actually use pulse (`tutorial-attention`); look-only
spotlights do not. That difference is the only thing distinguishing the two at a glance.

### Writing the steps themselves

The schema is the easy half. What took the most iteration on the first tutorial was the
writing, and these are the rules that came out of it.

**Every step has two audiences at once.** Someone reading and pressing Next, and someone
doing it themselves. A step that only addresses one of them reads wrong to the other, and
"Next will type Ensemblus welcomus" was rewritten precisely because it told a person what
the button would do instead of what *they* could do. The shape that works is the action
first, the shortcut second:

> Tick the box to activate the genome — or press Next and the tutorial will tick it for you.

> Type ‘Welcome’ and press Return — or press Next and the tutorial will do it.

**Quote anything the user is meant to type**, with typographic quotes: ‘Welcome’,
‘Ensemblus welcomus’. It separates the value from the sentence and makes it findable at a
glance.

**Say what a thing is, then what it is for.** Not what it is called and where it sits —
they can see that, it is spotlit. "This is where you choose which of your genomes the
other apps operate on" earns its space; "this is the Genome Selector" does not.

**Mention what is about to happen that they could not predict.** The first open of a
genome in the browser indexes its annotation and shows a spinner; a step that does not
warn about that produces a bug report.

**Keep bodies to three or four lines.** The card is 380px wide, so roughly 48 characters a
line. This is not only taste: the card is placed relative to its target, and a step with
`placement: 'top'` on a target near the top of the window will not fit above it if the
body runs long — the download search step has about 210px of headroom and had to be cut
to fit. Autoplay's dwell is also derived from word count, so padding a step makes everyone
wait longer for no more information.

**Titles are short and concrete** — "Find a gene", "The track", "It has landed", "Put it
to work". Not "Step 4: Downloading" and not a sentence.

**Voice:** second person, present tense, British spelling, no exclamation marks. Match the
surrounding app, which is written the same way.

Where the app and British spelling disagree, **the app wins** — the card is read next to
the control it describes, and a card saying "re-centre" beside a button whose own tooltip
says "Re-center view on selected gene" reads as a mistake rather than as a house style. In
practice this is one word: every user-visible *centre* in the app is spelled the American
way, so the cards are too. Only the authoring-facing target labels in
`tutorialTargets/genomeBrowser.js` use *Centre*, and nobody reading a tutorial sees those.

### The shape of a section

Each app the first tutorial visits follows the same arc, and it is worth copying because
it answers the questions in the order people ask them:

1. **Open the app** — a `view` step anchored on the app button, so the cursor is seen
   pressing the same button they would.
2. **Orientation** — one `interactive: false` step on the main surface. What am I looking
   at?
3. **Controls, general before specific** — the browser does the window-wide bar first,
   then the per-genome bar, and says how the two relate.
4. **The one thing to do** — the interactive step. One per section; more than that and the
   section stops being a demonstration and becomes a form.
5. **What just happened** — a step on the *result*. The green tick after the download, the
   pill after activating a genome, the gene in the track after searching. This is the step
   people skip when writing a tutorial and the one that makes it feel like it worked.
6. **The detail** — the drawer, the panel, wherever the depth is.

### Choosing an `advanceOn`

| The step's task | Use |
| --- | --- |
| Typing a particular value | `input` |
| Opening another app | `view` |
| Something that has to *complete* — a download, a save | `signal` |
| Pressing one specific control, where the press is the point | `click` |
| Explaining or pointing something out | `manual` (the default) |

The mistake to avoid is `manual` on a step whose task is really an action. The user does
the thing, nothing happens, and they are left looking for what else is wanted.

### Dragging a card places the card, not the editor around it

Edit mode adds inputs, a Save/Reset row and a note line — about ninety pixels on a typical
step, measured. The card being dragged was that taller shell, and the drag was clamped to
it, so the bottom of the window was a boundary for the editing chrome rather than for the
card. The last ninety pixels were unreachable: no card could be placed there, and the
position that came back described the shell.

Two boxes, and everything follows from keeping them apart:

- **The true box** is the card as it will be once saved. It is what the author is placing,
  what the stored fraction means, and what the window's edges bound.
- **The shell** is what is on screen now. In edit mode it is taller; everywhere else the
  two are the same and none of this applies.

While a card is being dragged it drops its editing chrome and renders the step as it will
read once saved, from the draft's own words — so the author moves the thing they are
authoring, at its real size, rather than a taller stand-in they have to imagine away. On
release the chrome comes back and the shell settles at the nearest fully visible position,
which may not be where the true box is; a dashed outline then shows where the card will
actually sit. The stored position is always the true box's.

The saved height is measured only from a card that is not wearing the chrome —
`data-tutorial-card-editing` marks the difference, and the measurement skips it.

**The builder previews the same card and had the same fault from the other end.** It
assumed 420×260 for any step that authored no size, where the reader gets 380 wide and as
tall as its words need. So the box being dragged there was not the box being authored, and
the bottom edge was computed from an assumed height. It now uses the shared
`TUTORIAL_CARD_WIDTH`/`TUTORIAL_CARD_MARGIN` and measures its own height, and its drag is
bounded by the card's own edges rather than by the viewport corner. Verified by driving it:
the card reaches (12, 12) and (1588, 945) in a 1600×957 window — the margin exactly, in
both corners.

**A hook added to the builder must go above its early return and below `selectedStep`.**
Both halves bite, and both crash the whole view: further down gives "Rendered more hooks
than during the previous render" the moment the builder opens, further up gives "Cannot
access 'selectedStep' before initialization" on mount. This is the same trap already
recorded further down this document, and it caught the same person twice in one session.

## Editing the wording in place — a developer tool

**This is meant to be removed.** It is here because refining tutorial copy means reading
it in place: at the width the card actually is, next to the thing it describes, at the
moment the step arrives. Noticing an awkward sentence, finding it in a definition file,
changing it and coming back to look again is slow enough that awkward sentences survive
the process.

So a card carries a pencil in its top right. Pressing it turns the section heading, title,
body and `copy` value into fields, makes the dotted header a drag handle, and exposes
subtle handles on the right edge, bottom edge and lower-right corner. Save writes
wording, position and dimensions straight back into the files the wording ships from, and
the edit is in your working tree ready to commit. Movement and resizing stay provisional while the editor is
open: Save commits `cardPosition` and `cardSize` together with the wording, while Cancel
discards all three. The reset arrow beside Save restores every unsaved field and the
original card geometry without closing edit mode.

**There are two such files, and both are written.** A built-in plays from
`frontend/src/tutorials/documents/<name>.tutorial.json` and a promoted draft from
`generated/`; the old `frontend/src/tutorials/<name>.js` is the rollback the document path
was staged behind, and `tutorialTargets.test.js` asserts the pair stay equivalent. Writing
only the JavaScript — which is what this did for the fortnight after the documents arrived
— saves the sentence into a file nobody reads and reports that it saved: three rewritten
bodies and two dragged card positions went that way before the failing equivalence test
said so. A tutorial that exists only as a promoted document has no JavaScript half and is
written on its own, which is what makes a builder tutorial's words editable from its card
at all. A draft still in the output directory takes neither path: it is written into its
own document by `savePortableStepFields`, because the repository has no file for it yet.

A section heading belongs to the group rather than the individual card. Renaming it from
any card updates every step with that heading in the current tutorial, both immediately
in the running tutorial and in its source definition. The rewriter follows references
such as `SECTION.download` back to the local shared constant, so the source continues to
have one heading for the whole section rather than a copied string on every step.

| Piece | File |
| --- | --- |
| The switch, and the client | [`frontend/src/tutorials/authoring.js`](../frontend/src/tutorials/authoring.js) |
| The rewriter | [`backend/tutorial_authoring.py`](../backend/tutorial_authoring.py) |
| The endpoints | `GET /api/tutorial/authoring`, `POST /api/tutorial/authoring/step`, `POST /api/tutorial/authoring/step-position`, `POST /api/tutorial/authoring/step-size` |

**To turn it off:** set `TUTORIAL_AUTHORING = false` in `authoring.js`, or
`TUTORIAL_AUTHORING = False` in `main.py`. Either one is enough — the frontend asks the
backend before offering the pencil. To remove it: delete those two files, the two
endpoints, the `authoringEnabled` / `editStepText` / `editStepPosition` / `editStepSize` values in
`useTutorial.jsx`, and the
editing block in `TutorialOverlay.jsx`. A test asserts the switch is still a single
declaration.

An application that rewrites its own source deserves more suspicion than most features,
so the guards are the substance of it:

- Refused unless a source checkout is present, so a packaged build has nothing to edit.
- The text endpoint only accepts `section`, `title`, `body` and `copy`. The separate
  position endpoint accepts two finite 0–1 coordinates and can only insert or replace
  `cardPosition`; the size endpoint accepts positive width/height values and can only
  insert or replace `cardSize`. Anchors and behavioural placement rules remain inaccessible.
- The value is found by **walking string literals**, not by matching a pattern, so it
  cannot run past the end of a value and swallow the step around it. Values written as
  `'one ' + 'two'` and as template literals are both handled.
- What it is about to write is re-parsed with the same scanner before it replaces
  anything, and the write is atomic.
- A test rewrites *every* field of *every* step of the shipped definitions, so a value the
  scanner cannot walk fails the suite rather than a save.

Two things worth knowing:

**A field does not always hold its own words.** `copy: HAO2_REGION` names a constant in
another module, and there are two cases. If the constant is plain text, the
save follows it and edits it *there* — which is what someone editing the card meant, and
the card says so, because every other step reading that constant has changed too. If the
constant is **computed** — as the region string is, from the slice's real bounds — it is
refused, and the refusal names the constant, the expression behind it and the file to
open. Editing the words alone would have left the tutorial telling the user to paste a
region the genome no longer matches.

The first version of this said "field value is not a string literal", which is true and
useless. An error from a developer tool is read by someone in the middle of something
else; it has to say where to go.

**Interpolation does not survive.** A body built as `` `…${REG4.symbol}…` `` renders as
text and there is no way back to the expression, so an edit writes the value out
literally. The save reports it and the card says so — re-introduce the interpolation by
hand if it mattered.

**Saving does not reload the page.** Rewriting a module Vite is watching would normally
full-reload and end the tutorial you were reading, so the definition files call
`import.meta.hot.accept()`. The runtime also applies the edit in memory immediately, which
is what you see; the file is what lasts.

## The visual tutorial builder

The Tutorials view has an internal, source-checkout-only builder. It is intentionally
additive: the established JavaScript definitions, playback overlay and small in-card
wording editor still work. `TUTORIAL_BUILDER_ENABLED` in
`frontend/src/tutorials/authoring.js` is the single frontend switch for Create, drafts,
recording, import/export and promotion. Turning it off returns the app to the previous
authoring route without changing either built-in tutorial. The backend applies the same
source-checkout gate used by the older editor.

Published tutorials are listed first, followed by blue-accented draft cards. A dashed
empty-tutorial card is always last; its blue plus opens the choice to create a new draft or
import an `.egtutorial` package.

Drafts autosave below `<output directory>/tutorials/drafts/<tutorial id>/`. The builder
shows **Unsaved changes**, **Saving…**, **Saved**, or **Save failed** in its header. **Save**
writes immediately, while **Save & close** waits for that write to finish and refreshes the
Tutorials page before leaving. Undo and redo cover normal field changes, while one card
drag or resize is one undoable operation. A
named checkpoint is an in-session snapshot. Opening a saved draft edits that same ID;
opening a built-in clones it first. A newly inserted step begins as a copy of the previous
step's section, view, target, context and layout, but resets its action and advancement so
it cannot accidentally replay the preceding operation.

### Recording a workflow

**Record actions** lets the author use the app normally. The recorder translates only
registered semantic operations:

- changing app view becomes an activation of `app.viewButton`;
- entering or submitting a registered search/input becomes an `input` action;
- clicking a registered control becomes an `activate` action;
- a settled genome-browser pan or zoom becomes one before/after locus action, rather than
  dozens of wheel or pointer events.

Each recording is immediately an ordinary step in the navigator. Stop recording, select
those steps and write their section, title and information-box text. Output paths are
never retained, and note-like free text is marked for review before export. An element
without a target contract is not recorded and cannot silently turn into a CSS selector.

Target picking and recording use a full-app capture mode. The builder panel and preview
card move completely out of the way, leaving only a small click-through status strip. A
successful target pick restores the builder automatically; **Escape** cancels target
selection or stops recording and restores the builder for review. Pressing Escape while an
input is active first commits that pending recorded input.

The **Transparency** slider at the top of the builder fades the panel, its controls and the
preview card from 0% to 90% transparency. The transparency control has no separate opaque
background; its slider itself stays solid so the panel can always be restored. The setting
is remembered between builder sessions.

The builder's left edge is a horizontal resize handle. Drag it left for more authoring
space or right to reveal more of the app; the chosen width is remembered between builder
sessions. The original 470 px layout is retained when the panel is narrower, so controls
may be clipped rather than compressed past usability. At 720 px and above the header,
form fields and dataset choices use additional columns to reduce vertical scrolling.
Double-click the handle, or focus it and press Home, to return to the default width.

Recording is a convenience, not a macro system. It does not record arbitrary keystrokes,
network requests, filesystem access, transient hover state or executable code. An action
which is meaningful but unregistered needs a target contract or adapter before it can be
authored.

### Target contracts

`frontend/src/tutorialTargets/` is the stable catalogue. A contract has a stable ID,
contract version, human label, control kind, view, optional validated parameters,
capabilities and safety class. Selectors and `data-tour-id` values live only in this local
catalogue; a `TutorialDocument` stores references such as:

```json
{
  "id": "focus.sequenceType",
  "version": 1,
  "params": { "featureType": "protein" }
}
```

A step keeps three concerns separate: `spotlight` is the primary visual subject,
`reveals` are extra undimmed context, and `interactionPolicy.targets` is the exact set of
targets and capabilities which remain usable. This is what permits a whole panel to be
visible while only its zoom surface or one child button accepts input.

To make another view authorable:

1. Inventory its meaningful controls and major regions in a new catalogue module. Prefer
   existing semantic `data-tour-id` attributes; add one to the owning component when no
   stable hook exists.
2. Give dynamic rows a parameterised contract rather than one ID per row. Validate enum
   parameters where the values are bounded.
3. Expose only `read` or `sandbox-write` capabilities. A rich surface needs a small
   adapter for operations such as read state, set state, pan, zoom or set locus.
4. Add it to `tutorialTargets/index.js`, then extend the browser inventory states so every
   advertised target is mounted at more than one viewport size.
5. Run `frontend/tests/tutorialTargets.test.js`; a removed contract or capability should
   become a compatibility report, never a hanging spotlight.

### Documents, compatibility and packages

The portable format is `ensembl-go-tutorial` schema version 1. It is declarative JSON and
rejects selectors, absolute local paths, URLs, executable fields and unsupported target
capabilities. The compatibility analyser distinguishes an unusable document from an
individual unavailable step. Cards report unavailable-step counts; affected jump links
are disabled; sequential/manual and autoplay runs explicitly skip known-broken steps.
If a target was valid but unexpectedly fails to mount at runtime, playback offers Retry,
Skip and Exit rather than waiting forever.

`.egtutorial` is a ZIP archive with `manifest.json`, `tutorial.json`, per-file SHA-256
hashes and optional generated dataset assets. Import performs a read-only preview before
installation and rejects traversal paths, links, undeclared files, hash/size mismatches,
unsupported schemas and executable content. A package is limited to 100 MB.

**Create recipe from region** extracts real sequence and complete annotation at the
current coordinates. Partial genes may expand the boundary (the default), be omitted, or
cancel generation. Expanded real sequence is limited to 5 Mb. The recipe keeps true
coordinates, deterministic hashes, provenance, FASTA indexes and its assembly manifest.
The builder warns because a package made from a private/custom genome contains that real
sequence and annotation. At playback it installs only into the tutorial sandbox.

The builder's **Tutorial datasets** section also offers reusable synthetic fixtures. The
**Turtles & friends** set adds eight tiny genomes in one operation: four turtle species
with the Leonardo, Michelangelo, Donatello and Raphael assemblies, followed by Splinter
(brown rat), April (human), Rocksteady (black rhinoceros) and Bebop (common warthog).
Every assembly has a deterministic 36 kb synthetic chromosome, four small genes, FASTA
index, GFF3 and assembly report. Playback installs them with a tutorial-only `demo`
provider and manifest, so the selector shows **Demo** rather than treating their absence
from the Ensembl catalogue as **Retired upstream**. The builder adds all eight embedded
recipe references to the tutorial document. Under **Initially active genomes**, **All**
and **None** set the whole starting selection in one click, while the individual
checkboxes allow any custom
subset. An inactive genome remains installed and visible in the selector, which lets a
tutorial begin with no selection and teach the user to create playlists before activating
them. Preview/playback installs the genomes only in the tutorial workspace, while export
includes their assets in the `.egtutorial` package. Reopening the section shows
**Attached to tutorial** and `8/8 genomes` when the set is complete.
**Detach set** removes all eight references from the tutorial document in one operation;
generated region datasets have their own **Detach** action. Both changes participate in
the builder's normal Undo history.

Promotion is an internal workflow: validation must pass before a draft is copied into
the repository registry. Keep the old source definition until the promoted document has
completed Next, Back, direct-step and all-speed autoplay regression runs. This staged
handover, plus the independent builder flag, is the rollback path if visual authoring does
not prove dependable enough.

## Anchors

An anchor names something on screen. Add one by putting a `data-tour-id` on the element:

```jsx
<input data-tour-id="download-search" type="text" … />
```

Resolution is by `document.querySelector`, so **no props are threaded** and adding an
anchor to a four-thousand-line component is a one-line diff.

Two other forms:

- **Reusing an existing attribute.** Where the app already carries a usable hook, point at
  it rather than adding a duplicate: `anchor: { selector: '[data-focus-drawer]' }`.
- **Threading into a shared subcomponent.** Where one component is anchored differently by
  several callers, give it a `tourId` prop and spread it onto the element
  (`PathInput`, `CollapsibleSection`). The tests understand this form too.

### Current inventory

| Anchor | Where |
| --- | --- |
| `app-button-${buttonId}` | [App.jsx](../frontend/src/App.jsx) — one attribute, every app button |
| `config-section-outputs`, `config-section-configuration` | [ConfigurationView.jsx](../frontend/src/components/ConfigurationView.jsx) — section headers |
| `config-output-dir`, `config-save` | ConfigurationView.jsx |
| `download-search`, `download-file-types`, `download-species-list` | [DownloadView.jsx](../frontend/src/components/DownloadView.jsx) |
| `download-species-${species.key}`, `download-start-${item.species_key}` | DownloadView.jsx — per genome row |
| `selector-search`, `selector-genome-${species_key}`, `selector-checkbox-${species_key}` | [GenomeSelectorView.jsx](../frontend/src/components/GenomeSelectorView.jsx) |
| `browser-location-search`, `browser-location-search-field`, `browser-location-search-go`, `browser-region-select`, `browser-expand-transcripts`, `browser-coordinates`, `browser-recenter` | [GenomeBrowser.jsx](../frontend/src/components/GenomeBrowser.jsx) — the per-genome toolbar and the focus bar |
| `browser-track-gutter`, `browser-track-gf`, `browser-track-gr`, `browser-track-sl` | GenomeBrowser.jsx — markers over the canvas gutter, see below |
| `browser-gene-note-${bubble.id}` | GenomeBrowser.jsx — the mark drawn on a gene that has notes |
| `browser-gene-transcripts-${gene.id}` | GenomeBrowser.jsx — the `+N` / X pill under a gene |
| `browser-gene-hidden-transcripts-${gene.id}` | GenomeBrowser.jsx — the “Show N hidden” label under a gene |
| `browser-global-controls`, `browser-unfocus`, `browser-tracks-toggle`, `browser-detail`, `browser-flatten` | [GenomeBrowserView.jsx](../frontend/src/components/GenomeBrowserView.jsx) — the bar that applies to every active genome |
| `browser-biotype-filter`, `browser-biotype-${key}` | GenomeBrowserView.jsx — the gene-class grid and its four checkboxes |
| `focus-transcripts-expand`, `focus-transcript-info-${id}`, `focus-transcript-hide-${id}`, `focus-notes-add`, `[data-focus-drawer-notes]` | [FocusGeneDrawer.jsx](../frontend/src/components/FocusGeneDrawer.jsx) |
| `focus-sequence-types`, `focus-sequence-${feature.key}` | [FocusTranscriptDetail.jsx](../frontend/src/components/FocusTranscriptDetail.jsx) |
| `focus-note-title`, `focus-note-body`, `focus-note-save` | [FocusNotesPanel.jsx](../frontend/src/components/FocusNotesPanel.jsx) |
| `app-genome-pills` | [App.jsx](../frontend/src/App.jsx) — the complete selected-genomes strip |
| `genome-pill-${species_key}` | [SelectedSpeciesPillsBar.jsx](../frontend/src/components/SelectedSpeciesPillsBar.jsx) — the top-bar pills |
| `tutorial-card-${tutorial.id}` | [TutorialsView.jsx](../frontend/src/components/TutorialsView.jsx) |

Browser steps mostly reuse attributes that were already there, through the `{ selector }`
form: `[data-browser-canvas-surface]` for the drawing surface, `[data-browser-toolbar]`
for one genome's own control bar, `[data-focus-bar]` for the focused gene, and
`[data-focus-drawer]` for the drawer.

`tutorials.test.js` checks every anchor a tutorial names against what the components
actually render, so a renamed anchor fails the suite rather than a new user's first run.

That check is **plain text matching over the source**, not parsing. It sees
`data-tour-id="literal"`, `` data-tour-id={`prefix-${expr}`} `` and `tourId="literal"`, and
nothing else — an id that arrives in a variable is invisible to it. The three track-gutter
markers are written out one by one for exactly this reason; mapping over a list of
`[id, …]` tuples passed the eye and failed a user.

### Pointing at something drawn on the canvas

The 48px track gutter — the GF, GR and SL switches — is painted by `drawToggle` and
hit-tested by geometry, so there is no element to anchor on. The browser now carries three
`pointer-events: none` marker divs over those switches, positioned from the layout the
renderer already computes. They exist only to be measured: every click still reaches the
canvas exactly as before, the steps about them are look-only, and turning tracks on and
off is taught through the **Tracks** button in the bar above, which is real DOM. That is
the pattern to copy if another canvas-drawn thing ever needs spotlighting — cheaper than
the `getVisibleRect` registry, and it keeps one code path for the control itself.

## Signals

A signal is the app telling the tutorial that something real happened.

| Signal | Emitted from | Payload |
| --- | --- | --- |
| `config.saved` | `handleConfigSaved` in App.jsx | — |
| `genome.activated` | `toggleTutorialGenome` in useTutorial.jsx — the tutorial's own stand-in for a genome selection, since the real one is not allowed to reach the config | `{ speciesKey }` |
| `browser.geneFocused` | `handleRefGeneSelect` in App.jsx | `{ gene }` |
| `browser.noteCreated` | `handleNoteCreate` in GenomeBrowserView.jsx, once the server's id lands | `{ geneId, noteId }` |
| `browser.regionSearched` | `handleSearch` in GenomeBrowser.jsx, on a successful `chr:start-end` | `{ chrom, start, end }` |

**`browser.regionSearched` is what the search step waits on**, and the reasoning
generalises. The box empties itself on a successful search, so an `input` advance on it
can never be satisfied; and finishing on Next instead left anyone who pressed Return
looking at the region they had asked for beside a card that still wanted something, with
nothing on screen to say what. The signal ends the step when the thing it asked for
actually happened — typed by the reader, pressed on the go button, or done by Next — and
the step's `holdMs` is what keeps the new view on screen before it moves on, because the
result appears nowhere near the control that caused it. `skipIfShowing` still reads the
viewport directly, so Next does nothing at all when the reader has already arrived.

The builder offers these under **Manual completion** as *When the browser moves to a
searched region* and *When a gene has been found and focused*; `SIGNAL_COMPLETIONS` in
`TutorialBuilderOverlay.jsx` is the list, and adding another is one entry plus the emit at
the state transition it names. `config.saved` is still emitted and never waited on.
| `demoGenome.installed` | `handleDemoGenomeInstall` in DownloadView.jsx | — |

Signals do not always advance a step the instant they arrive: if the tutorial itself
caused the thing, the advance waits out `ACTION_PAUSE_MS` first, so the result is on
screen long enough to be seen. That is `dispatchAfterHold`; nothing an author writes has
to account for it, but it explains why a step does not change the moment its signal
fires.

Adding one is two lines. At the state transition:

```js
tutorialRuntime.emitSignal('my.thing.happened', { id })
```

and in the step:

```js
advanceOn: { type: 'signal', name: 'my.thing.happened', match: { id: 'expected' } }
```

Inside App, the runtime is already available as `tutorialRuntime`. Elsewhere, take it from
`useTutorial()`. `tutorials.test.js` fails if a tutorial waits on a signal nothing emits,
which would otherwise hang the step forever.

## What refining the first tutorial taught us

The first version worked and was still wrong in a dozen small ways. Each round of feedback
turned into a rule, and they are collected here because they are the ones that will apply
to the next tutorial too — the code-level traps are further down under
[Things that are not guessable from the code](#things-that-are-not-guessable-from-the-code).

**The tutorial must be watchable, not just correct.** Most of the refinement was pacing:
the cursor travels rather than teleports, text is typed rather than assigned, a click is
left on screen for a moment before the step transitions, and the cursor leaves once it has
acted so it does not cover the result. Individually these look cosmetic. Together they are
the difference between a demonstration and the screen changing by itself.

**Show the result of every action.** A checkbox that ticks and instantly transitions, a
download that completes with nothing said about the green tick — the user is left taking
it on trust. Give the outcome its own step or its own beat.

**Anything the tutorial changes must be undoable.** A step the user cannot go Back to is a
step they cannot re-watch, and Back is the first thing anyone presses when they miss
something. That is what `undo` exists for: activating a genome un-activates, focusing a
gene unfocuses, and a typing step's field is emptied automatically. It also means a
one-shot action like the demo download has to stay re-runnable (`replayable`).

**Nothing the user might click should be clickable unless the step is about it.**
`interactive: false` covers the hole as well as the surroundings. Most steps are
explanations and should have it.

**Distinguish "use this" from "look at this" visually.** They were both a white ring at
first, and nobody could tell. Interactive spotlights now pulse and swing their border
colour; look-only ones do not.

**Never let the tutorial's cursor be mistaken for the user's.** It is a coloured disc, not
an arrow, for exactly this reason.

**Let people do it themselves at every step.** Typing the value, clicking the control and
pressing Return all have to work and advance the step. The tutorial doing it is the
fallback, not the mechanism.

**Time on screen should follow how much there is to read.** A fixed dwell is wrong for a
one-line step and wrong for a five-line one. `stepDwellMs` derives it from word count.

**Adjusting the speed must not restart the step.** People change speed *while reading*, so
resetting the countdown punishes the very moment it is used.

**A tutorial's reach is wider than its config override.** This was the recurring surprise.
The override covers settings; it does not cover the backend's view of which genomes exist,
component state like the browser's focused gene, or anything else derived from them. Every
one of those had to be handled separately, and a new tutorial that touches something new
should assume the same.

## Things that are not guessable from the code

- **Views unmount when they are not active** — all of them except the genome browser,
  which is kept mounted and hidden. So an anchor for a step in another app does not exist
  yet. The runtime navigates there on arrival — except when arriving *is* the step — but a
  step whose anchor never appears will sit there indefinitely. Check the app is actually reachable.
- **Collapsible sections default closed.** An anchor inside one exists but has no
  rectangle. Give the step `openSection: '<the header anchor>'` (portable:
  `openSectionTarget`); the runtime clicks that header only when the real target cannot be
  found, so it will not fight a user who already opened it.
  - That test uses the step's own anchor, which is wrong for a panel whose wrapper stays
    mounted while it is shut — a step ringing the whole box would decide the section was
    already open and ring a collapsed header. Such a step adds
    `sectionContent: '<an anchor that only exists when it is open>'` (portable:
    `sectionContentTarget`), and that is what is looked for instead. Step 12 of the Genome
    Playlists tutorial rings `selector.playlistBar` and probes `selector.playlistList`.
- **Next asks to be pressed after a while.** A step with `advanceOn: manual` gives the
  reader no other sign it is waiting — nothing is highlighted to act on and everything else
  is dimmed. After seven seconds the Next button breathes faintly. It is suppressed during
  autoplay, while the card's editor is open, while the unsaved-words prompt is up, and
  while a step is still preparing; any of those restarts the wait. Nothing to author.
- **The app's own notifications sit over the top bar.** The green confirmation banner is
  fixed at the top right, above the app but below the tutorial overlay, so it half-covers
  anything highlighted there and the reader cannot click it away. It clears itself after a
  few seconds. A step landing under one declares `ensure: ['notifications-clear']` and is
  held back until it has gone — which only works if the step also defers its presentation,
  or the highlight is drawn during the wait rather than after it.
- **The genome browser draws to canvas.** Nothing inside the drawing surface has a DOM
  node, so a gene cannot be spotlit directly. Anchor browser steps on chrome — the search
  box, the drawer, the controls. If a step ever genuinely must point at something drawn,
  the extension path is the `getVisibleRect` registry pattern in
  [`useScreenshotTargets.js`](../frontend/src/hooks/useScreenshotTargets.js).
- **Gating is soft.** Next, Skip and Exit are always available, so the user can be anywhere
  by the time a step runs. Write each step so it stands on its own rather than assuming the
  previous step's side effect happened.
- **Nothing is restored on the way out, because nothing was changed.** There is no
  snapshot. The tutorial runs entirely on a config override layered over the real one, so
  leaving is a matter of dropping the override. A tutorial that genuinely needed to change
  something of the user's would break that guarantee — do not.
- **The genome browser resolves genomes server-side.** The override is a frontend fact,
  and `_resolve_browse_genome_context` reads the configuration on disk, where the demo
  genome does not appear — so every browse request comes back `400 Invalid genome` and the
  tracks stay blank. `POST /api/tutorial/session` is what closes that gap: it holds the
  demo genome in memory for the life of the process, and `_browsable_active_species` adds
  it to what the browser may resolve. It accepts only the demo genome, only with files
  inside a tutorial workspace, and is cleared when the tutorial ends. Anything else a
  tutorial adds that the backend resolves from configuration will hit the same wall.
- **Typing goes through the native value setter**, so React sees a real change rather than
  a silently-assigned `node.value`. By default it only fills an *empty* field, leaving
  anything the user typed alone; `overwrite: true` on the action is the opt-in for steps
  where only one value works at all.
- **A manifest's names can be overwritten by a fallback.** `_genome_key_display_metadata`
  always answers, dropping back to a title-cased species key when the configuration and
  the catalogue both know nothing — which is how a genome actually called *Ensemblus
  welcomus* came to be listed everywhere as *Ensemblus Welcomus*. `list_local_assemblies`
  now refuses that fallback when the manifest has a real name. Anything else bundling a
  genome with its own names should check the same thing.
- **The config override does not cover component state.** It keeps a tutorial out of the
  user's *settings*, which is a smaller claim than it sounds. The browser's focused gene
  lives in App state, so a tutorial that focused one of the demo genome's invented genes
  handed the session back still focused on it — a gene none of the user's genomes contain,
  which blanked the track when cleared. `preTutorialBrowserFocusRef` snapshots it on the
  way in and restores it on the way out, so a focus the user already had survives too.
  Any other piece of state a tutorial disturbs needs the same treatment; the override
  alone will not do it.
- **Anchors resolve to the first match.** `document.querySelector`, not `querySelectorAll`.
  Per-row anchors must include the row's key.
- **The browser panel is often taller than the window and scrolls inside itself.** Focusing
  a gene centres it vertically, which carries the focus bar and the drawer's rows off the
  top: the anchor is found, the element is real, and the spotlight has nothing to draw
  because the rectangle has been clipped to nothing. The runtime now scrolls a step's
  target into view on arrival — `bringAnchorIntoView`, retried a few times because the app
  is often still moving when the step lands, and held under "Getting things ready…" so
  Next stays disabled until the target has settled. A target taller than the window is
  left alone, or every step about the track would jump.
- **The location search box empties itself on a successful search.** `jumpToRange` calls
  `setSearchInput('')`, so an `input` advance on it can never be satisfied and the step
  hangs forever. Gene searches wait on `browser.geneFocused` and region searches on
  `browser.regionSearched` — which also means someone who types the region themselves and
  presses Return moves straight on, rather than watching the tutorial retype it with its
  own cursor. A test enforces it.
- **Expanding transcripts changes the height of everything below.** With expand-all on, a
  gene with thirty-eight transcripts makes the panel several windows tall and every later
  anchor scrolls out of sight. A step that turns it on must have a later step turn it off,
  and Detail has to be switched off first — while it is on it disables the expand control.
- **Sticky transcript rows must be reset when a temporary layout ends.** Row stabilisation
  prevents tracks jumping during ordinary panning, but retaining the expanded view's row
  count after Expand or Flatten is switched off leaves thousands of pixels of blank track.
  `shouldResetStickyGeneRows` clears that remembered height when either mode is left; the
  tutorial's filter section is the regression check, because it immediately follows the
  layout demonstration.
- **The note mark needs vertical room above the gene's first row.** It is drawn above the
  head of the gene and suppressed when there is nowhere to put it, which is deliberate for
  compressed and flattened layouts — they leave one or two pixels of track padding. The
  consequence is that any layout switch left on quietly removes the mark, several steps
  away from wherever it was switched on.
- **A genome can declare the part of a region worth looking at.** `browsable_range` in the
  manifest becomes `browsable_start` / `browsable_end` on the region, and the browser
  clamps both panning and typed jumps to it. Only the chromosome-1 slice declares one: it
  is a real chromosome coordinate space holding 1.68 Mb of real sequence, so without it
  you can pan out into a hundred megabases of padding, which reads as the browser being
  broken rather than as the edge of a slice. Every other genome is unaffected.
- **Notes are written through `load_config()`, not the config override.** So a note taken
  during a tutorial landed in the user's real notes file and outlived the tutorial.
  `main._notes_config` is the fix: while a tutorial session is registered, the notes
  endpoints resolve their store against the tutorial's workspace, and the global store is
  left out of the merge entirely. Anything else that reaches for `load_config()` rather
  than for the frontend's configuration is in the same category — assume it is until shown
  otherwise.

## The sandbox

A tutorial needs an output directory to exist before it can start, which the Tutorials
view enforces — no bad thing to insist on, since it is the setting the app cannot work
without, and the tutorial can then show it rather than ask for it.

Starting one creates `<output_dir>/.ensembl_go_tutorial`, and the override points there.
Everything the tutorial downloads, indexes and activates lives inside it. Leaving deletes
it; so does launching the app, in case the last run was interrupted.

The override also blanks the fields that decide which genomes the app knows about —
`SANDBOX_BLANK_FIELDS` in `useTutorial.jsx`: `active_species`, `manual_species`,
`genome_playlists`, `selected_genome_playlist_id`. Pointing the output directory at
scratch space is not enough on its own; without these the user's own genomes, manual
entries and playlists sit alongside the demo one all the way through. Add to that list
if a tutorial ever needs another kind of genome hidden.

What guards the user's real setup, in order of how much they can be relied on:

1. `setConfig` in App refuses while the sandbox is up (one choke point, many callers).
2. `fetchConfig` is suppressed, or it would read the sidecar for the scratch directory
   and write its empty genome list over the real one in state.
3. `apiFetch` refuses config writes outright (see `tutorials/sandbox.js`).
4. The backend will not store an `output_dir` naming a tutorial workspace.

The first three are timing-dependent; the fourth is not, and is the one that actually
guarantees it.

### What the sandbox does not cover

This is the part worth reading twice, because every round of refinement found another
example. The override is a *frontend configuration* fact. It does not reach:

- **The backend's idea of which genomes exist.** It resolves genomes from the
  configuration on disk, so the bundled genomes had to be registered separately with
  `POST /api/tutorial/session`.
- **Notes.** Every notes endpoint resolves its store from `load_config()` — the *real*
  configuration — so a note taken during a tutorial was written into the user's own notes
  file and stayed there. `main._notes_config` swaps in the tutorial's workspace while a
  session is registered, and the global store is dropped from the merge so the user's
  notes are not visible inside the tutorial either.
- **The browser's own controls.** Detail, Flatten, the gene-class filter and the track
  master switch all live in `GenomeBrowserView`'s state. A tutorial that unticked three
  gene classes handed the session back with them unticked, and the user would find their
  own genomes missing half their genes with nothing on screen to explain why. Snapshotted
  on the way in and restored on the way out, beside the focused-gene snapshot App keeps.
- **Component state.** The browser's focused gene lives in App, not in config, and had to
  be snapshotted and restored around the tutorial.
- **Anything derived from a focused gene.** Focusing one pushes its name into the
  comparison-view inputs, which then look it up against the user's reference genome.

The pattern for each is the same: snapshot and restore if it is the user's, or suppress
while the sandbox is up if it is meaningless during a tutorial. When adding a tutorial
that touches something new, assume it is in this category until shown otherwise.

## The bundled genomes

There are two, described as `BundledGenome` records in
[`backend/demo_genome.py`](../backend/demo_genome.py) and keyed by a genome id.
`GET /api/demo/genome` lists them and `POST /api/demo/genome/install` takes one;
`POST /api/tutorial/session` accepts either, and nothing else, still only with files
inside a tutorial workspace. Everything that used to be a module constant is now a field
on the record, with the old `DEMO_*` names kept pointing at the demo genome because the
first tutorial, the download view and a good deal of `main.py` refer to it by them.

### The demo genome

*Ensemblus welcomus* — twenty-two kilobases, two contigs, six genes named Welcome, To,
Ensembl, Go, Have and Fun. It exists so a tutorial can teach the download view without a
network or a spare gigabyte.

- Generated by [`backend/scripts/build_demo_genome.py`](../backend/scripts/build_demo_genome.py).
  Deterministic — re-run and commit rather than editing the files by hand. The coding
  sequences are real open reading frames, so translation and the feature explorer behave
  as they would on a downloaded genome.
- Installed by [`backend/demo_genome.py`](../backend/demo_genome.py) into the same
  `local_data` layout a download produces, with the same manifest and the same
  accession-prefixed filenames — which is what lets it be deleted again through the
  ordinary genome-removal UI.
- Shown in the download view only while a tutorial is running, and its download button
  routes to `/api/demo/genome/install` instead of a real download — paced over five
  seconds with real-looking progress, because a download that completes instantly teaches
  the wrong thing.
- Presented as a **demo** everywhere, which took three separate fixes: its annotation
  goes in a real dataset release (`datasets/demo/current/`) rather than loose in the
  assembly directory, or the scanner sweeps it into the `legacy/unknown` bucket and calls
  it "Legacy local files"; `retired_remote` is forced off, since it is not in any remote
  catalogue and never will be; and `_release_short_label` returns "Demo" for a demo
  source rather than the release date. If you add another synthetic genome, those are the
  three places that will otherwise mislabel it.

Identifiers are duplicated between
[`frontend/src/tutorials/demoGenome.js`](../frontend/src/tutorials/demoGenome.js) and
`backend/demo_genome.py`; a test asserts they agree.

### The chromosome-1 slice

*Human chr1 slice (demo)* — 1.68 megabases of real GRCh38 from 118,440,000 to 120,120,000,
with its real Ensembl annotation: fifty-eight genes across four gene classes, PHGDH with
thirty-eight transcripts, HAO2 with thirty-six, HMGCS2 with twenty-two, REG4 with five and
a MANE Select among them. It exists because the browser tutorial is about transcripts,
biotypes, sequence and zoom, and *Ensemblus welcomus* has one of each at most.

The window is wider than REG4 needs on purpose. A slice that began at 119.6 Mb left the
browser with nothing at all to the left of its first gene, so zooming out produced a
screenful of empty track — which reads as something being broken rather than as the edge
of a slice. A megabase of populated sequence in front of REG4 fixes that, and the
`browsable_range` declaration stops anyone reaching the padding beyond it.

- Generated by [`backend/scripts/build_grch38_slice.py`](../backend/scripts/build_grch38_slice.py)
  from a genome the app itself downloaded. Deterministic — re-run and commit. The source
  assembly is not in the repository; pass `--fasta` / `--gff` to point at your own copy.
- **The coordinates are real.** The FASTA record is chromosome `1` and the slice sits at
  its true offset with `N` in front of it, so REG4 answers at 1:119,794,017 exactly as it
  does on the Ensembl website. This is not decoration: there is no coordinate-offset layer
  anywhere in the browse path — `/api/browse/regions` takes the region length straight
  from the FASTA record — and adding one would touch some fifteen endpoints. Runs of `N`
  compress about a thousand to one once bgzipped, so a hundred and twenty megabases of
  padding costs about 450 KB and the whole bundle comes to 642 KB.
- **Slice the Ensembl GFF3, not a GENCODE GTF.** `create_gff_index` reads `biotype=` and
  does not read GENCODE's `gene_type=` / `transcript_type=`, so a GENCODE slice would index
  with empty biotypes and the tutorial's gene-class filter would have nothing to filter.
  GENCODE's GTF also writes a bare `UTR` feature type, which the indexer does not accept.
- **Genes are chosen on coordinates and everything else on descent from them.** Filtering
  line by line would keep exons whose gene fell outside the window and drop genes whose
  last exon fell over the edge. The source file's ordering is preserved too — the indexer
  is a single-pass reader that attaches a child to a parent it has already seen, so sorting
  by coordinate, which puts a gene's first exon ahead of the gene when they share a start,
  silently loses the lot. The build script asserts both.
- **It declares a browsable range**, `{"1": [118440000, 120120000]}`, which the manifest
  carries and `/api/browse/regions` publishes. Both `clampView` and `jumpToRange` honour
  it, so neither dragging, zooming, the keyboard's whole-chromosome reset nor a typed
  region can leave the populated part.
- Its accession is a made-up `GCA_000000000.2`. Claiming the real `GCA_000001405.29` would
  put it in the same directory as a genuinely downloaded human genome, and everything that
  resolves a genome by accession would conflate the two.

`backend/tests/test_grch38_slice.py` pins the coordinates, the gene and transcript counts
and the biotypes, so a re-slice that quietly moved the window fails a test rather than a
step. Identifiers are duplicated into
[`frontend/src/tutorials/sliceGenome.js`](../frontend/src/tutorials/sliceGenome.js), and a
test asserts those agree with the backend too.

### Simulating a download

The demo genome is copied off the local disk, so installing it is instantaneous — which
teaches the wrong thing. `handleDemoGenomeInstall` in
[`DownloadView.jsx`](../frontend/src/components/DownloadView.jsx) paces it over
`DEMO_DOWNLOAD_MS` and drives `demoProgress`, which the row's download button renders on
its own icon exactly as a real queued download would.

Three details there were each a bug first:

- **Progress goes on the button, never in the status banner.** That banner sits in the
  flow above the species table, so showing one pushes the whole list — including the
  button just clicked — down by its height.
- **The demo row stays downloadable after it has been downloaded** (`replayable`), and
  keeps a pointer cursor even on the green tick. A step the user cannot repeat is a step
  they cannot go Back to.
- **`cursor-pointer` is set explicitly.** It is not the browser default on a `<button>`,
  and a control a tutorial is asking someone to click should look like one.

## Testing a new tutorial

```bash
cd frontend && npm test          # model, geometry, overlay tripwires, definitions
cd backend  && python3 -m pytest tests/test_demo_genome.py tests/test_grch38_slice.py -q
```

Registering a tutorial in `tutorials/index.js` is enough for it to be validated — step
ids, placements, views, anchors, signals and prefills are all checked without writing a
new test.

Each card in the Tutorials view has a **Browse and jump to steps** disclosure. Expand it
and choose a title to start a fresh sandbox directly at that step. Later steps still run
their own `ensure` and `arrive` declarations, so this is both the fastest visual-debugging
route and a useful check that the step really is independently reachable.

For the real thing, drive the running app over the Chrome DevTools Protocol. Start it with
`./run_ensembl_go.sh`, then launch a *separate* headless Chrome so the user's Electron
window is left alone:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --remote-debugging-port=9333 \
  --window-size=1600,1100 --user-data-dir=/tmp/cdp-profile about:blank &
```

Take the page target's `webSocketDebuggerUrl` from `http://127.0.0.1:9333/json` and drive
`Page.navigate` / `Runtime.evaluate` over it — Node has a global `WebSocket`, so nothing
needs installing.

The overlay carries four attributes for exactly this: `data-tutorial-card` (valued with
the current step's id), `data-tutorial-ring` (`interactive` or `look`),
`data-tutorial-blocker` on each dimming band, and `data-tutorial-busy` while a step is
getting ready. Match on those rather than on inline styles.

**Instrument rather than reason** when a check fails for no visible reason. The note mark
went missing and none of zoom, filter, focus or the notes API explained it; a temporary
`data-tutorial-debug` attribute carrying the actual arithmetic — track padding, row pitch,
the computed top of the mark against the floor it had to clear — gave the answer in one
run, and pointed at a cause two steps upstream. Add the attribute, get the number, take it
out again.

**Wait on the app's state, not on the clock.** A step takes a moment to arrive — the
previous step's doing is held on screen first — and once it has arrived its target may
still be being scrolled into view. Sampling through either produces failures that belong
to the probe. The protocol that works is: press Next, wait until the step id *changes* and
`data-tutorial-busy` is gone, wait again to confirm it has stayed, and only then measure.
Every one of the last four "bugs" found while building the browser tutorial was this.

The checks worth making at each step:

```js
// the spotlight is on the right thing
const t = document.querySelector('[data-tour-id="…"]').getBoundingClientRect()
// the hole is genuinely clickable, i.e. not covered by the overlay
document.elementFromPoint(t.left + t.width/2, t.top + t.height/2)
// and a point away from it is covered
document.elementFromPoint(window.innerWidth - 20, window.innerHeight - 20)
```

This is worth doing rather than trusting the unit tests. Every bug that mattered in this
feature's development was invisible to both the test suite and the production build, and
showed up only here:

- a dependency array referencing a `useCallback` declared further down the component,
  which crashed the whole view on mount;
- Next advancing twice, silently skipping every other step;
- the sandbox leaking into the real configuration three separate ways — React running a
  child's effects before its parent's, `fetchConfig` reading the sandbox's sidecar, and a
  dozen callers spreading the current config back into state.

Walk the whole thing with Next, and check the configuration before and after.

A full walkthrough takes several minutes — the download alone is paced at five seconds and
each step's action runs at human speed. Run the probe in the background and wait on the
process rather than polling it, or you will spend the time watching a log file.

Two things about writing these probes, both of which cost time here: a `\n` inside a
Node template literal becomes a real newline in the expression you send to the browser,
so split text on the Node side rather than in the page; and hard-coding the step count in
the loop means the probe quietly stops short the moment a step is added.

A third, more embarrassing: **check the probe before believing it.** Several "failures"
in this feature's development were the probe, not the app — a check that sampled the
wrong moment, a cutout count that forgot `cutoutPathD` always emits the outer rectangle
first, an assertion that ran after a fix had legitimately changed the state it expected.
When a check fails, confirm the mechanism in the running app before changing code.

**Be careful what the probe is pointed at.** It loads the *real* app against the *real*
backend, so it sees and can write the user's configuration. Snapshot the config before and
compare after, delete the tutorial workspace when finished, and be aware that a stale page
left open can autosave over a change made elsewhere.

## Checklist for a new tutorial

1. Write the definition in `frontend/src/tutorials/<name>.js` and register it in
   `tutorials/index.js`. That alone gets it a card in the Tutorials view and full
   validation from the existing tests.
2. Walk each app it visits and list the anchors it needs. Reuse existing data attributes
   through the `{ selector }` form where they exist; add `data-tour-id` where they do not.
3. Follow the section arc — open, orient, controls, the one action, the result, the
   detail — and give each step an `advanceOn` from the table above.
4. Add `ensure` to every step that depends on an earlier one, so skipping cannot strand
   it, and `arrive` to every step that describes a state — which is most of them in the
   browser. Reserve `undo` for the few things `arrive` cannot express.
5. `npm test` and `python3 -m pytest tests/ -q`. The definition is validated for free;
   a failing anchor test means a `data-tour-id` you forgot.
6. Walk it in headless Chrome. Check the spotlight lands on the right rectangle, the card
   never covers what it describes, every step is reachable with Next alone, and the
   configuration is identical before and after.
7. Walk it *backwards*. Record each step's state on the way forward, press Back through
   the section, and assert it matches. Every reversibility bug in the browser tutorial was
   invisible going forwards.
8. Walk it again on autoplay, at all three speeds, watching rather than asserting. Pacing
   problems are not visible to a probe.
9. Update this document with anything the next person would otherwise rediscover.

A worked example, from the browser tutorial. The probe found eight problems on its first
run. Three were the probe sampling mid-transition, one was an assertion that fired on
steps with no anchor at all, and four were real: the panel scrolling its own focus bar out
of view, the drawer opening collapsed to one transcript so the row a step pointed at did
not exist, expand-all left on making everything below the track unreachable, and a
precondition on the last step undoing the step before it. That ratio is normal. Confirm
the mechanism in the running app before changing code.

## Multi-genome scenes and builder controls (September 2026)

**Multi-genome browsing** is the fourth shipped tutorial. Its portable document lives in
`frontend/src/tutorials/generated/multi-genome-browsing.tutorial.json`; four small real
annotation/sequence slices are bundled under `backend/data/tutorials/multi-genome-browsing`.
The human annotations share the final 1:880,000–1,075,000 window. Mouse covers
4:156,249,740–156,430,000; rat covers 5:172,030,000–172,180,000. Annotation extraction
retains ncRNA_gene roots as well as gene/pseudogene roots, complete parent graphs, and
chromosome aliases from the source assembly report.

The builder exposes the following capabilities for any tutorial, without requiring
manual JSON editing:

- **Tutorial datasets:** edit the pill labels, keep inactive dataset pills visible and copy the current genome
  palette into the tutorial. Each colour is editable. Dataset order determines colour slots.
- **Pick live targets:** browser controls, canvases, search fields, focus bars and track
  switches record the dataset they belong to, using an optional `recipeId` parameter.
  Existing unscoped targets retain their single-panel behaviour.
- **Multi-genome arrival state:** choose the active datasets; specify each panel's locus,
  gene focus and GF/GR/SL visibility; choose region/gene/no linking and independent Pan/Zoom
  settings. “Use current browser state” captures the scene as editable fields.
- **Browser state applied by Next:** the same editor can author an idempotent browser action.
- **Complete when the browser matches:** wait for actual panel state instead of a click.
  This is particularly useful for asynchronous gene linking and multi-button exercises.
- **Button state after Next:** activation actions can request on/off, skipping controls
  already in that state when a reader has partly completed an exercise.
- **Locked-bar message:** choose the brief message shown when a reader tries a genome
  toolbar held inactive by that step's interaction policy.

The portable scene vocabulary is `browserScene` in `arrive` or `action`. It contains
`active` (ordered recipe IDs), `pan`, `zoom`, `link` (`none`, `region`, `gene`), and a
`panels` map keyed by recipe ID. Each panel can name `locus`, `focus` (empty clears it),
and `tracks: { forward, reverse, sequence }` as visibility booleans. `reset` clears
previous focus/link state before restoration; `preserveView` preserves an already
established matching scene so result cards do not undo the reader's movement.

`completeWhen` uses the same state vocabulary. A step waits on the `browser.state`
signal, and Next reports an unfinished operation rather than silently advancing after
an unsuccessful search or link. Completion checks are scoped to the named datasets;
mouse's `Samd11` matches `SAMD11` without changing the source annotation.

The runtime bridge in `utils/tutorialBrowserScene.js` calls the browser's existing focus
and linking handlers. Panel movement and track state use the viewport registry. A new
arrival cancels older scene preparation and invalidates pending gene/region searches.
Broad highlights do not grant broad permissions: canvas pan/zoom steps block gene
selection and gutter controls, and actionable track-switch targets call the same track
state setter as the canvas switches.

Promotion now copies dataset assets into the backend bundle. Cloning a shipped tutorial
can resolve those content-addressed recipe IDs and copy them into the new draft; package
export then includes those assets. Tutorial-owned `settings.genomeColors` and
`settings.showInactivePills` survive materialisation, cloning, preview and playback.

Browser-canvas outlines use outside padding in both playback and builder previews, so
the ruler is not covered by the inset used for neighbouring list-row highlights.
For narrow slices, gene-link framing can centre the shared five-prime anchor when the
usual quarter-width placement would push a panel against its bounds.

### Autoplay demonstrations and inactive tracks

The builder's **Autoplay browser demonstration** editor stores `autoplayDemo` as a
`browserView` sequence. Each move chooses a dataset (`panelKey`), pan fraction or zoom
factor. The timer runs these movements before advancing; manual Next skips the demo.
Stopping autoplay or changing steps stops the remaining movements. Demonstrations scroll
the panel being moved into view and pause on the result.

Browser scenes and completion checks can set `hideInactive`. The general Hide button is
registered as `browser.hideInactive`. The multi-genome tutorial switches all four unused
strands off in one exercise, shows that result, then teaches Hide in a separate exercise.
Backward navigation restores both power settings and inactive-track visibility.

Focused arrivals omit a fixed locus when they want the browser's normal gene-centred
view. Gene-link synchronisation now uses the same drawer-aware window as gene navigation,
so enabling linked Pan/Zoom does not replace that window with unadjusted coordinates.
