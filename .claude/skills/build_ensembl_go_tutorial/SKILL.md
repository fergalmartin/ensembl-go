---
name: build_ensembl_go_tutorial
description: Build a new in-app guided tutorial for Ensembl Go from a written brief — plan the steps, author the portable tutorial document so the visual builder can open it, verify it forwards, backwards, by direct jump and on autoplay, then promote it and update the docs. Use when asked to add, build, write, rebuild or repair an Ensembl Go tutorial, or when handed a tutorial description/plan document to turn into a tutorial.
---

# Building an Ensembl Go tutorial

A tutorial is a guided walkthrough that runs inside the app: the screen dims, one control
is spotlit, and Next performs the step. This skill is the end-to-end procedure for adding
one. Work through the phases in order. **Do not skip the verification phase** — every
serious defect ever found in this stack was found by driving the running app, never by the
test suite.

## Phase 0 — Read in (always, before anything else)

Read these, in this order. They are long; read them properly rather than grepping, because
almost every rule in them was a bug first.

1. `docs/TUTORIALS.md` — the spec. Architecture, the step schema, `arrive`/`action`/`undo`,
   card placement, signals, the sandbox, and "Things that are not guessable from the code".
2. `docs/tutorial-builder-genome-playlists-handoff.md` — the handoff. §0 is the current
   state; §4–§8 are the traps; §11 is the verification route and commands; §12 is the
   working-tree cautions. **Honour §12: no `git reset --hard`, no `git clean`.**
3. Any other `docs/*-handoff.md` or `docs/*-plan.md` naming a tutorial.
4. The shipped tutorials themselves, as data, not as prose:
   - `frontend/src/tutorials/documents/getting-started.tutorial.json` (20 steps)
   - `frontend/src/tutorials/documents/browser-in-depth.tutorial.json` (46)
   - `frontend/src/tutorials/generated/tutorial-mt8m7a4h.tutorial.json` — Genome Playlists (28)
   - `frontend/src/tutorials/generated/multi-genome-browsing.tutorial.json` (32)

   Read at least one complete document end to end. The browser one is the reference for
   pacing and wording; the multi-genome one is the reference for `browserScene` and for
   scoping targets to one genome panel.
5. `references/writing-style.md` in this skill — the info-box voice, distilled with real
   examples. **Read it before drafting a single card.** Matching the existing voice is an
   explicit requirement, not a nicety.

Then check the working tree: `git status`, and read anything uncommitted that touches
`frontend/src/tutorials/`, `frontend/src/tutorialTargets/`, `frontend/src/hooks/useTutorial.jsx`
or the overlay. The author edits card wording and drags cards in their own running app, so a
definition on disk may be newer than any document describes.

## Phase 1 — Read the brief

The user supplies a document or a block of text describing the tutorial they want.
`docs/multi-genome-tutorial-plan.md` is a worked example of the genre: scope, the data it
runs on, a card-by-card walkthrough table, suggested wording, and the runtime work needed.

If no brief has been given, **ask for it** before designing anything — this skill builds
what was asked for, and a tutorial invented from the app's feature list is not that.

From the brief, extract and write down explicitly:

- **The genomes it runs on**, and whether they exist yet. A tutorial that needs data which
  is not bundled needs that data generated first (see Phase 3).
- **Every reader action** it asks for, in order.
- **Every claim the cards will make** about what is on screen — transcript counts, gene
  names, coordinates, how many genes a window holds. Verify each against the actual
  annotation before writing it into a card. The browser tutorial's counts were all checked
  with a short script over the bundled GFF3; do the same.
- **What the brief does not say.** You are expected to add what is obviously missing — an
  intro, an outro, result beats, a section that reads as a chapter. Say what you added and
  why in your summary.

## Phase 2 — Plan the steps before writing any JSON

Produce a step table — id, section, title, what it teaches, what the reader does, what
`arrive` state it needs — and check it against the rules below. This is far cheaper to fix
here than after the cards are written.

### The tutorial needs an intro and an outro

**Intro:** a `placement: 'center'` card, no spotlight (or the widest relevant region), that
says what the tutorial covers and what the reader will be able to do by the end. Getting
Started puts it in a section literally called `Intro`. Mention that Next advances the step
for anyone reading rather than doing.

**Outro:** a review card that names the things taught, in the order taught, before the
tutorial ends — see `review` in the multi-genome document. This is separate from
`completionBody`, which is the sentence on the catalogue card afterwards. Write both.

### The context → action → result formula

This is the shape every section follows, and the result beat is the one people leave out.

1. **Context.** What this thing is and what it is for — not what it is called and where it
   sits; the reader can see that, it is spotlit.
2. **Action.** One per section. The reader clicks, types, or moves something.
3. **Result.** A step on what the action produced.

**When a result step is required:** whenever the result appears somewhere other than the
control that caused it. Pressing Analyse and having results appear elsewhere on the page is
the canonical case.

**When to skip it:** when the result *is* the control's own local feedback, or is the
obvious place the reader now finds themselves. Pressing the Genome Browser app button lands
you in the genome browser; a step explaining that you are now in the genome browser is
padding. A checkbox that ticks under the cursor needs a beat, not a card.

**The whole-then-parts rule.** When an action reveals a *region* containing several things
the tutorial will explain — a results panel, a drawer, a dialog, a newly drawn browser panel
— the first step after the action highlights the **whole region** and says what it is.
Only the step after that drills into the first part. Jumping straight from "press Analyse"
to a ring around one sub-panel loses the reader: they never saw the shape of what arrived.
The browser tutorial does exactly this for the transcript detail panel and for the drawer's
notes section, and both were added after a reader got lost without them.

### Section arc

Each app or major surface the tutorial visits follows: open it → orient (one look-only step
on the main surface) → controls, general before specific → the one thing to do → what just
happened → the detail. Sections must be contiguous, and once one step names a `section`,
every step must.

### Every step must stand on its own

Write each step so that arriving at it cold — from Back, from a skipped step, from the
builder's step list — produces exactly the picture its card describes. This is the single
highest-value rule in the whole exercise, it is what makes Back work, and it is the rule the
step table should be checked against line by line:

> For each step, what state does its card assert? Is all of that declared in its `arrive`?

If a step's card says "the four genomes now appear as pills", the step declares the
selection. If it says "PHGDH has thirty-eight transcripts", the step declares the locus. A
step that inherits state from the step before it is a step that breaks when reversed.

Reserve `undo` for the two things `arrive` cannot express as a state: clearing a focused
gene, and deleting a note the tutorial wrote.

## Phase 3 — Targets, data, and builder support

Before authoring, confirm every control the plan touches is reachable.

**Targets.** `frontend/src/tutorialTargets/` is the catalogue: `app.js`, `configuration.js`,
`download.js`, `genomeSelector.js`, `genomeBrowser.js`, wired in `index.js`. A portable
document stores references (`{ id, version, params }`), never selectors — `selector`,
`selectorTemplate`, `script`, `url` and absolute paths are rejected outright by
`validateTutorialDocument`.

For each planned step, find the contract that covers its control. Where none exists, add
one — see `references/builder.md` for the procedure, including how to add a `data-tour-id`,
how to parameterise a per-row target, and the genome-browser `recipeId` scoping that
`tutorialTargets/index.js` adds automatically.

**Data — reuse first, generate small, store centrally.** Full procedure in
`references/demo-data.md`; the short form:

1. **Take the inventory before generating anything.** `ls backend/data/tutorials/*/datasets/`
   plus the two bundled genomes. `install_recipe` resolves a recipe id across *every*
   tutorial's bundle, so an existing recipe is reusable by id with no bytes duplicated — and
   a reader who already knows those genomes is learning one new thing rather than two.
2. **Generate only what the existing sets genuinely cannot carry.** Prefer a **synthetic
   fixture** (`generate_fixture_pack`, 36 kb chromosomes) wherever the sequence is scenery
   and the tutorial is really about genomes as objects; use a **region recipe** (**Create
   recipe from region**) only when the lesson is about real annotation. Region recipes must
   declare a `browsable_range`, or the reader can pan out into empty padding.
3. **Keep the footprint small — it ships in the repository.** Budget ~50 K per synthetic
   genome and ~100 K per small real slice; take the smallest window that supports the lesson,
   keep sequence as `.fa.bgz` and annotation as `.gff3.gz`, and treat a tutorial's data
   passing ~2 MB as a reason to cut the window. Measure with `du -sh` and put the figure in
   the handoff.
4. **Store it centrally, with the rest.** The only homes are `backend/data/demo_genome/`,
   `backend/data/grch38_reg4/` and `backend/data/tutorials/<id>/datasets/`. Promotion copies
   a draft's `datasets/` into the third — **verify it landed**, because a document referencing
   recipes that are only in the author's draft plays perfectly for the author and fails on
   every other machine with "Tutorial dataset … is unavailable". `references/demo-data.md`
   has the check, and names a shipped tutorial that is currently in exactly that state.
5. Everything is deterministic: regenerate and commit rather than hand-editing files.

Real Ensembl/RefSeq genomes for extraction live where `local-genome-data-for-validation` in
memory records.

**Builder support.** The requirement is that the finished tutorial can be *opened and
edited in the visual builder*, not merely that it plays. Anything the plan needs that the
builder cannot author is a gap to close in `TutorialBuilderOverlay.jsx`, within reason:
prefer one new editor section over a field only hand-written JSON can produce. Every such
extension must also be reflected in the builder documentation (Phase 7). See
`references/builder.md`.

## Phase 4 — Author the document

Author the **portable document** (schema `ensembl-go-tutorial`, version 1) — that is what
plays, what the builder opens, and what promotion ships.
`references/step-schema.md` is the field-by-field reference; the shipped documents are the
worked examples.

Two routes, and both end in the same file:

- **Through the builder**, for anything with a visual component — card placement, target
  picking, browser scenes, view positions. This is the route that proves the builder can
  build it.
- **Writing the draft JSON directly** at
  `<output_dir>/tutorials/drafts/<tutorial id>/tutorial.json`, which is the same document
  the builder edits. Faster for bulk step authoring. **Reload the builder before and after**
  — an open builder will overwrite a direct write on its next autosave. Take a backup
  beside it (`tutorial.json.before-<what>`) as the playlists work did.

Non-negotiables while authoring — each of these has shipped broken at least once:

- **Every step that asks for an action must permit it.** A step spotlighting a group, a row
  or a wrapper converts to *explicit look-only*, and then only a reader doing it by hand
  finds the control dead — autoplay works perfectly. Name the controls in
  `interactionPolicy.targets` with their capability. `tutorials.test.js` fails this now.
- **No `interactionPolicy` at all** leaves everything in the cutout live; an **empty** one
  (`targets: []`) is the explicit look-only. They are different; choose deliberately.
- **A `signal` advance infers no action.** Spell the action out or Next walks straight past.
- **A multi-anchor click that advances on a click must advance on the last of them.**
- **Steps that create state declare the state before it** as empty: `genomes: []`,
  `playlists: []`, `dialog: 'none'`, a field's value cleared. That is what makes the step
  watchable a second time.
- **Order inside `arrive` is a dependency order.** Panels before the views they reframe;
  the drawer's fold before the rows inside it; window-wide switches before per-gene ones.
- **Anything the tutorial presses on the reader's behalf** goes through `clickAsTutorial` /
  `actAsTutorial`, and you must ask what the app infers from a pointer that was not there.

### Highlighting, and the card

- Spotlight the whole control a reader must submit — the search wrapper, not just the field,
  so the go button is inside the light. Two rings three pixels apart read as one smudge.
- `reveal` lights a second thing without making it clickable; the card is placed clear of
  everything lit.
- **Card placement.** Prefer `placement` + `align` (+ `placeAgainst` where the subject is a
  whole track). Reach for an authored `cardPosition` only when nothing automatic works, and
  place it by dragging in the running app at a real working size so the stored fraction
  means something.
- **The card must not cover what the step is about.** Where overlap is unavoidable, push the
  card to the *periphery* of the subject: overlap an edge, never the centre of attention,
  and keep the overlapped area as small as you can. Measure it — the probe in
  `scripts/tutorial_probe.mjs` reports card-versus-ring overlap per step, including how far
  the ring's centre is from the card. Four steps of the browser tutorial shipped with the
  ring centre under the card; that is the failure to avoid.
- Keep bodies to three or four lines (~48 characters a line at 380px). Long bodies both
  overflow a `placement: 'top'` card and lengthen autoplay's dwell, which is derived from
  word count.

### Movement — smooth, once, and never past the target

Any step that pans, zooms or scrolls on the reader's behalf has to do it in one unhurried
movement that decelerates into its target. Overshooting and correcting, jittering while the
card is read, jumping where it should glide, or re-moving something the reader already moved
all read as the tutorial being broken. Full detail in `references/motion.md`; the rules that
matter while authoring:

- **Go through the existing path.** Every browser move routes through the panel's own
  `animateToView` via the `browserTutorialControls` registry, which eases out cubically,
  clamps to the browsable range *every frame*, cancels any in-flight animation, and does
  nothing at all when the target is already the current view. That is what makes overshoot,
  edge-snapping and twitch impossible. Never set the view directly or add a bespoke animation.
- **One journey, not a move plus a correction.** Compute the destination properly the first
  time — `goToLocus` goes through `frameFocusRange` because the focus drawer overlays the
  canvas, and a locus framed without it lands the subject behind the drawer and needs a second
  move. Use `durationMs` for one continuous move and reserve `moves: [...]` for genuinely
  distinct beats.
- **Match duration to distance** (300 ms for a nudge, ~700 ms default, 1000 ms for a full
  re-frame) and give the destination a beat with `pauseMs` or `holdMs` — a move that arrives
  and instantly transitions is over before it registers.
- **Wrap every new timing constant in `paced()`**, or the three speeds will not scale it.
- **Do not move what the reader has already moved.** `skipIfMoved`, `skipIfShowing`,
  `skipIfSequenceVisible`, `skipIfFeatureFramed`, `skipIfEngaged`, and `preserveView` on a
  result card's scene.
- **Draw the highlight at rest.** `deferUntilReady` on any step whose arrival moves something;
  pin the card with `align` / `placeAgainst` / `cardPosition` so it does not reposition while
  it is being read. Never reintroduce a CSS geometry transition on the ring — it was removed
  precisely because it made the ring chase its target after every scroll frame.

### Autoplay

Autoplay is Next on a timer, and it must be authored, not assumed:

- Dwell comes from word count (`stepDwellMs`). Override with `autoplayMs` only where the
  wait is about something *finishing* rather than something being read.
- `holdMs` keeps a result on screen after the step is satisfied. Any step whose result
  appears away from the control needs one.
- `settleMs` is how long Next waits for a `signal` before advancing anyway. Raise it for
  anything slow.
- A browser demonstration during autoplay is `autoplayDemo`, a `browserView` move sequence.
- Wrap any new timing constant in `paced()` so the three speeds scale it.

### The tutorial must start self-contained and hand the session back

Read `references/sandbox-lifecycle.md` before touching anything that writes. The two
properties to preserve:

- **It starts in its own state, every time.** `resetTutorialWorkspace` clears anything a
  previous run left, the datasets install into `<output_dir>/.ensembl_go_tutorial`, and
  `SANDBOX_BLANK_FIELDS` blanks the user's active genomes, manual entries and playlists so
  the scene is the tutorial's rather than theirs with extras in it. A tutorial that needs
  another kind of the user's data hidden adds to that list.
- **Leaving hands the session back.** There is no snapshot to roll back because nothing of
  the user's was changed — so nothing the tutorial touches may fall outside that guarantee.

The override is a *frontend configuration* fact and does not reach the backend's idea of
which genomes exist, notes, the browser's own switches, the focused gene, or anything else
resolved through `load_config()`. Each of those leaked once and now has its own snapshot or
suppression. **Assume any new surface your tutorial touches is in that category until shown
otherwise**, and give it a guard at the backend rather than only in the UI — the backend
refusal is the only one that is not timing-dependent.

## Phase 5 — Verify (this phase is the work)

Run these in order. Do not report the tutorial finished until all of them have been done
and their results stated.

**1. The suites.**

```bash
npm --prefix frontend test
npm --prefix frontend run lint -- --quiet
npm --prefix frontend run build
cd backend && python3 -m pytest tests/ -q
git diff --check
```

`frontend/tests/tutorials.test.js` validates every registered tutorial for free: unique ids,
structural soundness, every anchor existing in the components, every signal being emitted
somewhere, actionable steps permitting their action. Note that many of its tests are written
against *specific* shipped tutorials — a new tutorial gets only the generic ones, so consider
adding the invariants your tutorial depends on as tests of its own. The anchor check is plain
text matching over source, so an id that arrives in a variable is invisible to it: write
`data-tour-id` values out literally.

**2. Drive the running app.** The Vite dev server is a plain HTTP origin, so it can be
opened in headless Chrome and driven over CDP without disturbing the user's Electron window.
`scripts/tutorial_probe.mjs` in this skill does the three sweeps; `references/verification.md`
has the full recipe, the DOM hooks worth reading, and the harness gotchas.

> **Warn the user before the first run.** Starting a tutorial calls `resetTutorialWorkspace`,
> which removes `<output_dir>/.ensembl_go_tutorial` and reinstalls the tutorial datasets. A
> builder open in the user's own window will need **Reset scene** afterwards.

The three sweeps, all of which must come back clean:

- **Forward** — every step reachable with Next alone.
- **Backward** — from the last step, Back through every step. Assert each step's recorded
  state matches what it was on the way forward. *Every* reversibility bug in the browser
  tutorial was invisible going forwards.
- **Jump-in** — start at each step directly from the card's **Browse and jump to steps**
  list. A step with nothing to point at is the tell, and the count of such steps is the
  number to drive to zero.

**3. Watch autoplay**, at all three speeds, watching rather than asserting. This is the one
item on the checklist a probe cannot do — pacing has to be seen. Check that no step moves on
before its result is legible, and that no step sits idle after it.

**4. Watch the movement.** Jitter and overshoot are timing faults, so a probe cannot find
them — watch at all three speeds, since every duration is scaled by the speed factor. Does
any move overshoot and come back? Does anything move twice where one journey would do? Is
each ring struck around a target at rest, or does it slide into place? Does the card stay
still while it is read? Does the page wander after arriving? Do each move by hand and then
press Next — the right `skipIf…` should make it a no-op. `references/motion.md` has the full
checklist.

**5. Measure the highlights and the cards.** For each step: does a ring exist, is it around
the right element, and where does the card sit relative to it? The probe reports all three.

**6. Check the session is handed back cleanly.** The configuration byte-identical before
and after; no tutorial genomes, playlists or notes in the user's own lists; nothing left on
disk but `.ensembl_go_tutorial`, and that gone on exit. Check **all three exits** — Finish,
Exit, and navigating away mid-run — because a tutorial that only cleans up on Finish leaves
the sandbox standing for most readers. Then run it twice in a row without restarting, and
once after killing the app mid-run. `references/sandbox-lifecycle.md` has the full list.

**7. Check the data bundled.** Every embedded recipe the document names must resolve under
`backend/data/tutorials/*/datasets/`, not only in the author's draft directory. The check is
in `references/demo-data.md`.

### Robustness to future app changes

The tutorial must degrade legibly rather than break silently when the app moves on. Build
this in, then confirm it:

- **Reference registered targets, never selectors.** A removed contract or capability then
  becomes a *compatibility report* — `analyseTutorialCompatibility` marks the affected steps
  unavailable, the card shows the count, the jump links disable, and sequential and autoplay
  runs skip them. A raw selector just points at nothing.
- **Rings follow their element live.** Geometry is polled per frame and clipped by
  `visibleElementRect`, so a control moving or resizing slightly keeps its ring. This holds
  only for targets resolved through the catalogue.
- **Prefer the region over the pixel.** Spotlight the wrapper a control lives in where the
  step is about the control's job rather than its exact box; a button that grows by six
  pixels then changes nothing.
- **Avoid hand-tuned geometry that encodes today's layout.** Round `pageScroll` offsets and
  blind `cardPosition` nudges are the two that rot. Measure them with **Use current
  position** and by dragging, at a real window size.
- **Confirm the failure path works**: temporarily break one step's target reference, check
  the Tutorials card reports the unavailable step and that playback offers Retry / Skip /
  Exit rather than hanging, then put it back.

## Phase 6 — Promote and register

A draft is promoted through `POST /api/tutorial/drafts/promote` (`promote_draft` in
`backend/tutorial_packages.py`). Validation must pass first. It copies the document into
`frontend/src/tutorials/generated/<id>.tutorial.json`, copies the draft's dataset assets into
`backend/data/tutorials/<id>/datasets/`, and **rewrites `generatedTutorials.js` wholesale**
with generated import names — so any hand-edited names in that file are lost; check the diff
and restore readable names if the user wants them.

A promoted document has no JavaScript half, which is correct: the `.js` rollback files exist
only for the two original built-ins.

After promoting, re-run the suites — the newly registered tutorial is now validated by them
for the first time.

## Phase 7 — Documentation

Not optional, and the last thing to do rather than the first:

1. **`docs/TUTORIALS.md` — the spec.** Add any new mechanism, field, target, signal or
   precondition, in the section it belongs to. Write up anything the next person would
   otherwise rediscover, with the reason, in the document's own voice.
2. **`docs/tutorial-builder-genome-playlists-handoff.md` — the handoff.** Add a dated section
   for this tutorial: what it teaches, how many steps, what was built for it, what the sweeps
   measured, what is still open, and any operational caution about the working tree.
3. **The builder documentation.** Every builder capability the tutorial used or added must be
   described so an author can find it without reading JSX — which editor section it lives in,
   what it writes into the document, and why it exists. Keep the builder sections of
   `docs/TUTORIALS.md` ("The visual tutorial builder") and the handoff current with the code;
   if the builder has grown enough to deserve its own document, say so and split it out.
4. **This skill.** If you learned something that will apply to the next tutorial, add it here
   or to a reference file.

## References in this skill

- `references/writing-style.md` — the info-box voice, with real examples. Read before drafting.
- `references/step-schema.md` — the portable step schema, field by field.
- `references/builder.md` — the builder, the target catalogue, and how to extend both.
- `references/demo-data.md` — the bundled-data inventory, reuse before generation, footprint
  budgets, and how data gets into the repository.
- `references/sandbox-lifecycle.md` — starting self-contained, what the override does not
  cover, and handing the session back.
- `references/motion.md` — panning, zooming and scrolling without overshoot or jitter.
- `references/verification.md` — the CDP harness, the three sweeps, the DOM hooks.
- `scripts/tutorial_probe.mjs` — runs the sweeps and reports rings, cards and overlaps.
