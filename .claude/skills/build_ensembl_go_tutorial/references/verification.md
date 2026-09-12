# Verifying a tutorial

The unit tests are pure logic and source-reading tripwires. **Everything that has ever gone
seriously wrong with a tutorial was found by running it**, and would have passed the suite.
Budget for this phase properly; the browser tutorial's probe found eight problems on its
first run, of which four were real, and that ratio is normal.

## 1. The suites

```bash
npm --prefix frontend test
npm --prefix frontend run lint -- --quiet
npm --prefix frontend run build
cd backend && python3 -m pytest tests/ -q
git diff --check
```

Focused runs while iterating:

```bash
cd frontend
node --test tests/tutorials.test.js tests/tutorialDocument.test.js tests/tutorialTargets.test.js
node --test tests/tutorialBuilder.test.js tests/tutorialOverlay.test.js tests/tutorialModel.test.js
```

The build emits a pre-existing warning about a >500 kB chunk. That is not yours.

What `tutorials.test.js` gives a new tutorial for free: unique reachable id, structural
soundness, every anchor existing in the components, every signal being emitted somewhere,
every actionable step permitting its action, `copy` paired with `overwrite`. Much of the rest
of that file is written against the *specific* shipped tutorials — so add tests for the
invariants your own tutorial depends on rather than assuming they are covered.

## 2. Driving the running app

`run_ensembl_go.sh` starts the backend on `127.0.0.1:8000` and Vite on `127.0.0.1:5173`, with
Electron loading the dev server. Because Vite is a plain HTTP origin, the same UI opens in
headless Chrome and is driven over CDP; that instance has its own React state and does **not**
disturb the user's window. Anything written through to the backend is still shared.

```bash
node .claude/skills/build_ensembl_go_tutorial/scripts/tutorial_probe.mjs \
  --document frontend/src/tutorials/generated/<id>.tutorial.json \
  --mode all --window 1600x1100 --out /tmp/probe.json
```

Point `--document` at a draft under `<output_dir>/tutorials/drafts/<id>/tutorial.json` while
the tutorial is still a draft — the Tutorials view lists drafts too.

> **Tell the user before the first run.** `start()` calls `resetTutorialWorkspace`, which
> removes `<output_dir>/.ensembl_go_tutorial` and reinstalls the tutorial datasets. Drafts
> are untouched, but a builder open in the user's own window needs **Reset scene** after.

### Harness gotchas

- **Keep the page active** (`Page.setWebLifecycleState`). Arrivals wait for animation frames,
  and a page that is not being painted never delivers one — a stalled "getting ready" step is
  all you will see.
- **Vite may bind to `::1` only**, so `curl 127.0.0.1:5173` refuses while `localhost:5173`
  works. Navigate to `localhost`.
- **`element.scrollTop = n` fires no `scroll` event** headlessly (no compositor). Dispatch
  `new Event('scroll')` as well when testing scroll-driven behaviour.
- **Take the step count from the document**, never hard-code it. That mistake has cost half
  an hour before.
- **An output directory must be set**, or every jump link is disabled and the probe reports
  it as such.
- **Restart Chrome between full sweeps.** A long-lived headless instance accumulates enough
  state across many tutorial runs that rings stop resolving and typing slows to a crawl —
  which looks exactly like a regression in the app and is not. If a whole sweep goes wrong at
  once, suspect the browser before the tutorial: a fresh profile was the difference between
  "32 steps with no ring" and a clean run, with no code change in between.
- **`--settle` has to suit the slowest step.** The default 2.5s is far too short for a
  tutorial whose steps wait on real backend work — an analysis, an annotation conversion, an
  index build. Those need 30s or more, and the symptom of too little is a sweep that reports
  failures at step ids that do not match what actually happened.

### DOM hooks worth reading

| Selector | Tells you |
| --- | --- |
| `[data-tutorial-card]` | The card's own box; its value is the current step id |
| `[data-tutorial-card-editing]` | The card is wearing the editing chrome, so it is taller |
| `[data-tutorial-busy]` | The step is still preparing; Next is disabled |
| `[data-tutorial-preparing]` | A deferred step that has not been drawn yet |
| `[data-tutorial-ring]` | Each drawn spotlight, `interactive` or `look`, and its box |
| `[data-tutorial-overlay="complete"]` | The tutorial has finished |
| `[data-tutorial-step-title]`, `[data-tutorial-section-title]` | The card's headings |
| `[data-tutorial-autoplay-trace]` | Autoplay's edge trace is running |
| `[data-tutorial-speed]`, `[data-tutorial-speed-step]` | The chosen speed, and the three buttons |
| `[data-tutorial-next-nudge]` | Next has started breathing for a waiting reader |
| `[data-tutorial-unsaved-prompt]` | Leaving a step with wording edited but unsaved |
| `[data-tutorial-step-list="<tutorialId>"]` | The card's step list (a `<details>`; set `.open`) |
| `[data-tutorial-jump-step="<tutorialId>:<stepId>"]` | Start playback at that step |
| `[data-tour-id="app-button-tutorials"]` | Opens the Tutorials view |

Next, Back, Skip, Exit, Autoplay and Pause carry no data attribute — select them by their
text inside `[data-tutorial-card]`, which is what the probe does.

## 3. The three sweeps

All three must come back clean. The number to drive to zero is **steps with nothing to point
at**.

| Sweep | Finds |
| --- | --- |
| **Forward** | Steps unreachable with Next alone; actions that do not fire |
| **Backward** | State a step inherited rather than declared. Every reversibility bug in the browser tutorial was invisible going forwards |
| **Jump-in** | The same, plus anything that depends on a precondition the step did not name |

The probe diffs forward against backward per step — step id, section, title, ring geometry,
card box. A step whose fingerprint differs between the two directions has an `arrive` that
does not fully describe what its card asserts.

For scale: before the interaction-guard fix, the browser tutorial had 15 steps with no target
walking backwards and 14 jumping in. After it, one. That is what these sweeps are for.

## 4. Watching autoplay

A probe cannot do this. Watch it, at all three speeds, with the card's speed control.

- Does any step move on before its result is legible? It wants a `holdMs`, or a longer one.
- Does any step sit idle after its result? Its body is too long, or `autoplayMs` is too high.
- Does the cursor travel, press, and then **disappear** so the result is not covered?
- Is text typed a character at a time rather than appearing fully formed?
- Does changing speed mid-step continue the trace rather than restarting it?
- Do the browser demonstrations (`autoplayDemo`) scroll their panel into view and pause on
  the result?

Remember the dwell is derived from word count, so a prose pass that shortens bodies also
shortens how long those steps are held — re-watch after editing copy.

## 5. Watching the movement

Overshoot and jitter are timing faults, invisible to a probe. Watch at all three speeds —
every duration is scaled by the speed factor, so a move that reads well at normal speed can
be a jump at fast and a crawl at slow.

- Does any move **overshoot and come back**? It should decelerate into its target. A snap-back
  usually means a destination computed without `frameFocusRange`, or two things moving the
  same panel (an `arrive` and an action).
- Does anything **move twice** where one journey would do?
- Is each ring **struck around a target at rest**, or does it slide into place? A sliding
  highlight is the signal for `deferUntilReady`.
- Does the **card stay still** while it is read? If it drifts, pin it with `align`,
  `placeAgainst` or `cardPosition`.
- Does the **page wander** after arriving? A visible second scroll means something is still
  loading underneath the authored position.
- Do each move **by hand** and then press Next: the right `skipIf…` should make it a no-op
  rather than re-driving what you just did.
- In a **multi-move sequence**, does each move read as its own beat rather than blurring into
  one movement?

`references/motion.md` explains the machinery behind each of these.

## 6. Cards and highlights

The probe reports, per step, the card box, every ring box, the overlapping area, the
overlap as a fraction of the ring, and **whether the card covers the ring's centre**. Centre
coverage is a defect; a small overlap at the periphery is acceptable when nothing else fits.

Card positions are normalised viewport fractions, so overlap is window-size dependent.
Measure at a real working size, and re-place by dragging the card in the running app rather
than nudging fractions blind. Four browser-tutorial steps shipped with the ring centre under
the card because they were placed at one size and read at another.

## 7. Robustness

- Break one step's target reference on purpose. The Tutorials card should report the
  unavailable step, its jump link should disable, sequential and autoplay runs should skip
  it, and playback should offer **Retry / Skip / Exit** rather than hanging. Put it back.
- Check the tutorial at a second window size, and in the Electron build as well as the
  browser.
- Confirm no step's spotlight depends on a control's exact pixel box — a target resolved
  through the catalogue is re-measured every frame and clipped by `visibleElementRect`, so a
  button that moves or resizes keeps its ring.

## 8. Leaving nothing behind

The configuration must be **byte-identical** before and after, no tutorial genomes may leak
into the user's list, and the run should leave nothing but `.ensembl_go_tutorial` — which is
cleared at the start of every run anyway. Diff the config file directly; the sandbox is a
frontend fact and the things it does not cover (notes, the browser's own controls, the
focused gene, anything resolved through `load_config()`) have each leaked at least once.

Check all three exits — Finish, Exit, and navigating away mid-run — then run the tutorial
twice without restarting the app, and once after killing it mid-run. `references/sandbox-lifecycle.md`
has the complete list and the reasoning behind each item.

## 9. The data is actually in the repository

A document referencing recipes that exist only in the author's draft directory plays
perfectly for the author and fails everywhere else. Run the bundling check in
`references/demo-data.md` against the promoted document, and record the data footprint
(`du -sh backend/data/tutorials/<id>/`) in the handoff entry.
