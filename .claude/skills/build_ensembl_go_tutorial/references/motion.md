# Movement: panning, zooming and scrolling without jitter

A tutorial moves the app on the reader's behalf constantly — the browser travels to a
locus, the page scrolls to frame a control, a panel scrolls into view. **Motion is the part
of a tutorial that most decides whether it reads as a demonstration or as the screen
changing by itself**, and the failure modes are specific: overshooting and correcting,
jittering while a step is read, jumping where it should glide, and re-moving something the
reader already moved.

The good news is that almost all of it is already solved in the runtime. The job when
authoring is mostly **to go through the existing paths rather than around them**, and to
know which knobs exist.

## One path for every browser move

Every pan, zoom and locus change a tutorial makes goes through the panel's own
`animateToView` in `GenomeBrowser.jsx`, reached through the module registry in
`utils/browserTutorialControls.js` (`panByWindows`, `zoomBy`, `goToLocus`). Nothing in that
registry does any work of its own. That is deliberate: **a tutorial's pan travels at the
same speed and stops at the same edges as one the reader performs.**

`animateToView` is why the motion is well-behaved, and each property is worth knowing
because authoring against it is what keeps it that way:

- **It cannot overshoot.** The easing is `easeOutCubic` — monotonic and decelerating, with
  no spring or back-ease — interpolating start and end independently toward the final
  values. It approaches the target and stops.
- **It cannot run past the edges.** `clampView` is applied *every frame*, not once at the
  end, so a move toward a locus outside the browsable range decelerates into the boundary
  instead of flying past it and snapping back.
- **It cannot fight itself.** Any in-flight animation is cancelled (`cancelAnimationFrame`)
  and momentum velocity is zeroed before a new one starts. Two moves arriving together
  produce one movement, not a tug-of-war.
- **It does nothing at all when there is nothing to do.** A target within `1e-6` of the
  current view returns immediately, so a re-entered `arrive` re-asserting the same locus
  cannot produce a one-frame twitch.

**So: never set `viewStart`/`viewEnd` directly, and never add a bespoke animation.** If a
new kind of move is needed, publish it on the panel's registry entry and let it call
`animateToView` like the other three.

## Durations, and letting a move finish

| Constant | Value | What it paces |
| --- | --- | --- |
| `TUTORIAL_MOVE_MS` (`GenomeBrowser.jsx`) | 700 ms | A tutorial move with no `durationMs` |
| `BROWSER_MOVE_MS` (`useTutorial.jsx`) | — | The action path's default |
| `SETTLE_MS` | — | The gap after a move before anything else happens |

`runBrowserView` performs a `moves: [...]` sequence by waiting
`paced(durationMs) + paced(SETTLE_MS)` after each one, so **the next move starts from where
the last one ended rather than fighting it**. This is the mechanism to respect when
authoring a multi-move step: give each move a duration that suits its distance, and let the
sequence do the waiting.

Everything is multiplied by the speed factor through `paced()` — 1.3× slower, 1×, 1/1.2×
faster. **Wrap any new timing constant in `paced()`**; a "faster" that only shortened the
gap between steps would still crawl through each move. A test checks that each constant is.

Authoring guidance:

- **Match duration to distance.** The call sites in the browser range from 300 ms for a
  small nudge to 1000 ms for a full re-frame. A long journey at 300 ms is a jump; a short
  one at 1000 ms is a crawl.
- **Prefer one move to several.** `durationMs` controls one continuous move; `moves: [...]`
  is for genuinely distinct beats, not for breaking one journey into pieces. A step whose
  point is "the browser travels from here to there" should be one move.
- **Give the destination a beat.** `pauseMs` at the end of a sequence, or `holdMs` on the
  step — a move that arrives and immediately transitions is over before it registers as
  having gone anywhere.
- **Scroll the panel into view before moving it.** `revealPanel` does this with
  `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` and a 500 ms settle, which
  matters in a multi-genome tutorial where the panel being moved may be off screen.

## Frame the destination properly, or it will need a second move

A correcting move is the most visible kind of jitter, and the usual cause is a destination
computed without something that is on screen.

- **`goToLocus` goes through `frameFocusRange`.** The focus drawer is `absolute right-0`: it
  overlays the canvas rather than narrowing it, so roughly a fifth of the right-hand side is
  covered and the window never shrinks. A locus framed without that lands the subject behind
  the drawer — and then something has to move again. `frameFocusRange` is a no-op when no
  drawer is open, so it is always the right call.
- **A locus on another region is refused, not animated.** `goToLocus` returns false rather
  than trying to travel there; switching region is the search box's job. A step that needs a
  different region uses a search, not a move.
- **Reset the panel's scroll before measuring.** A step measures its anchors against the
  layout it expects, not whatever the last step left. But note the trap already found:
  `resetBrowserScroll` walks up to *whatever is actually scrolling*, which is the shared page
  scroller — it silently threw away authored `pageScroll` positions on Genome Selector steps.
- **Sticky rows must be released when a temporary layout ends.** Row stabilisation stops
  tracks jumping during ordinary panning, but keeping an expanded view's row count after
  Expand or Flatten is switched off leaves thousands of pixels of blank track.
  `shouldResetStickyGeneRows` clears it.

## Page scrolling

`applyPageScrollArrival` implements the `pageScroll` arrival, and its two rules are the
answer to "why did the page wander":

- **Smooth only for the first move.** A later correction is repairing something that just
  moved under the reader, and animating it reads as the page drifting. Subsequent
  corrections use `behavior: 'auto'`.
- **Held, not set once.** Getting there is easy; staying there is the problem — the Genome
  Selector rescans its assemblies as the tutorial's output directory takes effect, and while
  it loads the page is shorter than its own viewport, so the position clamps to zero and the
  framing is lost a few hundred milliseconds after it was established. The position is
  re-asserted until it has survived two checks in a row. It also gives up gracefully when the
  page genuinely cannot go where the author put it, rather than spending the step's whole
  preparation asking again.

Two supporting pieces:

- **`waitForAnchorScrollToSettle`** measures *the target's own rectangle* frame by frame and
  returns once it has been stable within 0.5px for four frames (minimum 160 ms, maximum
  1600 ms). A fixed timeout expires halfway through a native smooth scroll; measuring the
  target covers nested scrollers and late layout shifts without knowing which ancestor owns
  the scroll.
- **`bringAnchorIntoView`** is the *rescue*, not the framing: it centres, because a rescue
  has no better idea, and it is **skipped entirely for a step with a `pageScroll` arrival**
  so it cannot throw away the composition the author made.

The resize repair is debounced at 120 ms, because a dragged window emits a stream of resize
events and each repair may scroll smoothly.

## Do not move what the reader has already moved

Re-driving a step someone has done is the rudest kind of motion. Every `skipIf…` exists for
this, and the general rule is that **the check must be true of the state the reader can
reach, not of the shape the definition happens to be written in**:

| Guard | Leaves things alone when |
| --- | --- |
| `skipIfMoved` | The reader has changed the view at all |
| `skipIfShowing: '<locus>'` | The browser is already there |
| `skipIfSequenceVisible` | The base-level sequence lane is already rendered |
| `skipIfFeatureFramed` | The feature is fully on screen at a sensible scale |
| `skipIfEngaged` | The control already reports the state the action wants |
| `preserveView` (in `browserScene`) | A matching scene is already established — so a result card does not undo the reader's movement |

`sameBrowserViewport` compares **rounded**, because a view that has settled after an
animation is not bit-identical to the numbers it was asked for — without that, a step would
think the reader moved when they only watched the tutorial move.

Note also that `interaction: 'zoom-only'` is guarded at `panByPx`, which every gesture and
the momentum fling reach — but `animateToView` deliberately is not, so a step can still put
the view where it wants while the reader is held.

## Draw the highlight at rest

A ring struck around something still moving is the jitter readers actually notice.

- **The ring geometry has no CSS transition, on purpose.** The original overlay animated
  `left`/`top`/`width`/`height` over 140 ms, which made the ring *chase* the target after
  every scroll frame. Those transitions were removed. Geometry is now polled with
  `requestAnimationFrame`, measured immediately from a capture-phase `scroll` listener, and
  re-measured on window and `visualViewport` resize. **Do not reintroduce a geometry
  transition.**
- **`deferUntilReady` keeps the screen quietly dimmed** until preconditions, `arrive` and the
  scroll repair have settled, so card and spotlight appear together around a target at rest.
  Use it for any step whose arrival moves something. A `pageScroll` or centring `selectorList`
  arrival sets it automatically.
- **`selectorList` centres immediately, without a smooth-scroll animation** — the list is the
  scene, not a journey, and animating into it would put motion under a card about selection.
- **`align`, `placeAgainst` and `cardPosition` pin the card.** Without one, a card placed to
  clear a revealed area has to move whenever that area's rectangle changes — and for a browser
  step the revealed area is the track, whose rectangle changes as the view does. The card then
  repositions itself while it is being read, which is worse than sitting slightly close to
  something.

## What to check

The probe reports ring geometry per step, but jitter and overshoot are timing faults, so
**most of this has to be watched** — at all three autoplay speeds, since every duration is
scaled by the speed factor.

1. **Does any move overshoot and come back?** It should decelerate into its target. If
   something snaps back, suspect a destination computed without `frameFocusRange`, or a
   second mover (an `arrive` and an action both moving the same panel).
2. **Does anything move twice?** One journey, not a move plus a correction.
3. **Is the ring struck around a target at rest?** If a highlight visibly slides into place,
   the step wants `deferUntilReady`.
4. **Does the card stay still while it is read?** If it drifts, pin it.
5. **Does the page wander after arriving?** The held re-assertion should have stopped; a
   visible second scroll means something is still loading under it.
6. **Does the tutorial re-move something you moved yourself?** Do each move by hand, then
   press Next: the right `skipIf…` should make it a no-op.
7. **Does a multi-move sequence let each move finish?** Moves should read as separate beats,
   not blend into one blur.
8. **At the fast speed, is anything now too quick to follow?** At the slow speed, does
   anything crawl? Both ends are authored by the same durations.

## A control whose effect depends on the current view is not an arrival

The browser's **Focus this window** button focuses whatever the window happens to be showing.
An arrival that wanted a *named* region would therefore have to travel there, press it, and
then be moved back to the view the card describes — a journey and a correction, which is the
thing this document exists to prevent.

So the arrival goes through the panel's own handler, published on the
`browserTutorialControls` registry beside `goToLocus` (`setLocationFocus`). It changes the
state and leaves the view completely alone, which makes the step's own `browserView` arrival
the only thing that moves the browser: one journey.

The general rule: **if pressing the control would produce a different result depending on where
the reader happens to be, the arrival must not press it.** Press it in the *step* — that is the
lesson — and set the state from the registry everywhere else.

**When an arrival's effect re-frames the view, declare the framed window, not the raw one.**
Focusing a window keeps the region at `BOX_SELECT_FILL_FRACTION` of the view so its boundary
lines land inside the track. Every later step declares that padded window; declaring the region
itself would put the boundary lines off both edges. Measure the real number in the running app
rather than deriving it — the drawer inset is part of it.
