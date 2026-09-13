# The portable step schema

`docs/TUTORIALS.md` is the authority and explains *why* each field exists. This is the
working reference: what to write, in portable-document spelling, and what it becomes.

A document is `{ format: 'ensembl-go-tutorial', schemaVersion: 1, id, revision, title,
blurb, estimatedMinutes, usesDemoGenome, completionBody, author, createdAt, updatedAt,
settings?, datasets, defaultArrive?, steps }`. `validateTutorialDocument` rejects
`selector`, `selectorTemplate`, `script`, `javascript`, `code`, `url`, functions and
absolute local paths anywhere in it.

`materializeTutorialDocument` converts a document into the runtime shape. The mapping is
worth knowing because the runtime names are what `docs/TUTORIALS.md` mostly uses:

| Portable | Runtime | Notes |
| --- | --- | --- |
| `spotlight: { target }` | `anchor` | A target's own `presentation` can set `anchorScroll` and `deferUntilReady` for you |
| `openSectionTarget` | `openSection` | |
| `sectionContentTarget` | `sectionContent` | |
| `placementTarget` | `placeAgainst` | |
| `copyTarget` | `copyInto` | |
| `reveals: [{ target, whenTypedTarget, ring }]` | `reveals` / `reveal` | |
| `interactionPolicy.targets` | `interactive`, `interaction` | An empty `targets` array makes the step look-only |
| `autoplay.actions` | `action` | `activate` → click, `input` → type, `set-locus` → browserView |
| `advanceOn.target(s)` | `advanceOn.anchor(s)` | |
| `arrive[].target` (selectorList, pageScroll) | `arrive[].anchor` | Also implies `deferUntilReady` |

## A target reference

```json
{ "id": "focus.sequenceType", "version": 1, "params": { "featureType": "protein" } }
```

Genome-browser targets take an optional `recipeId` parameter (added automatically by
`tutorialTargets/index.js` to everything except the global controls), which scopes the
selector to `[data-tutorial-genome="<recipeId>"]` — one genome's panel rather than the
first one on the page.

## Step fields

Required: `id` (unique), `title`, `body`. Everything else is optional.

**Placement and presentation**

| Field | Meaning |
| --- | --- |
| `view` | Which app the step belongs to |
| `section` | Chapter heading; contiguous, all-or-nothing across the tutorial |
| `placement` | `top` / `bottom` / `left` / `right` / `center` |
| `align` | `start` / `center` / `end` — and **pins** the card to its own target |
| `placementTarget` | Spotlight one thing, place the card against another |
| `cardPosition` | `{ x, y }` as viewport fractions; overrides automatic placement |
| `cardSize` | `{ width, height }` in CSS pixels; width clamped to 300–620 |
| `deferUntilReady` | Stay dimmed until preconditions, arrival and scroll repair have settled |
| `spotlightRing`, `spotlightRingShadow` | Keep the cutout, drop the ring or its shadow |

**What Next does** — `autoplay.actions`, each `{ target, capability, value?, submit?,
overwrite?, browserView? }`. Usually inferred; a `signal` advance infers **nothing**, so
spell it out there. Runtime action types: `none`, `click` (`anchors`, `pauseMs`,
`endPauseMs`, `skipIfFeatureFramed`, `skipIfEngaged`), `select`, `type` (`submit`,
`overwrite`, `skipIfShowing`), `navigate`, `browserView` (`pan`, `zoom`, `locus`, `moves`,
`durationMs`, `pauseMs`, `skipIfMoved`, `skipIfSequenceVisible`), `browserControls`,
`browserScene`.

**A `<select>` is `set-state` with a `value`**, which materialises to a `select` action.
`activate` opens a drop-down and chooses nothing; `input` types into it. A step that asks the
reader to choose an option and names either of those has **no action at all**, and Next walks
past leaving the field as it found it — the same silent shape as the `signal`-advance trap.

**Adding a new action type means teaching four places**, and missing one is quiet: the model's
`ACTION_TYPES` and its validation, `materializeTutorialDocument` (capability → action),
`refsFromStep` in the compatibility analyser (which capability the action *needs* — it assumes
`activate` for anything that is not typing, so a `select` asked drop-downs for a capability
none advertise and every such step was reported unavailable), and `performAction` in the
runtime.

**What finishes the step** — `advanceOn`:

| Type | Finishes when |
| --- | --- |
| `manual` (default) | Next is pressed. For a step that only explains |
| `view` | That app becomes active |
| `click` | The named target is clicked |
| `all-clicks` | Every named `activate` target has been clicked |
| `signal` | The app reports a state transition (`config.saved`, `genome.activated`, `browser.geneFocused`, `browser.noteCreated`, `browser.regionSearched`, `demoGenome.installed`, `browser.state`) |
| `dwell` | `ms` passes |
| `input` | The field holds `value` for `ms`, or Return is pressed with it right |

`completeWhen` is a sibling field, not an `advanceOn` type: it names a browser scene in the
same state vocabulary as `arrive`, and the step waits on the `browser.state` signal until the
panels actually match. Use it for asynchronous gene linking and multi-button exercises, where
Next should report an unfinished operation rather than advance after an unsuccessful search.

Prefer `signal` when what matters is that something *happened* rather than that a pixel was
pressed. Use `input` whenever typing *is* the step. Do not leave `manual` on a step whose
task is really an action.

**What must already be true** — `arrive`, one object or a list, applied on **every** entry
and idempotent by construction (it sets, never toggles):

| Type | Sets |
| --- | --- |
| `browserView` | `locus`, or `pan` / `zoom` |
| `browserControls` | `detail`, `flatten`, `expanded`, `biotypes`, `drawerTranscripts`, `geneTranscripts`, `hiddenTranscript`, `transcriptDetail`, `noteEditor`, `tutorialNote` |
| `browserScene` | `active`, `pan`, `zoom`, `link`, `panels{locus,focus,tracks}`, `reset`, `preserveView`, `hideInactive` |
| `selectorList` | A stable Genome Selector scene: `fitAllRows`, `preserveOrder`, `lockScroll`, `center` |
| `genomeSelection` | Which embedded genomes are selected, by `recipeId`. `[]` is a real instruction |
| `pageScroll` | `target` plus `offset` px below the top of the scrolling region. Applied last |
| `dialog` | `'playlistMembership'`, `'playlistPopover'`, `'none'`, plus `fields` |
| `playlists` | The whole playlist set, replaced not merged. `[]` is a real instruction |
| `trackRegistry` | The Track Manager: `registered` demo tracks, the `wizard` step, the `file` chosen, `fields`, `dataType`, `displayMode`, `genome`, and whether the file `browser` is open. `registered: []` is a real instruction |
| `browserTracks` | Which registered tracks a panel draws: `added`, which are `visible` (absent means all), `hideInactive`, whether the `picker` is open, and what is `chosen` in it. `added: []` and `picker: 'closed'` are real instructions |

A tutorial-level `defaultArrive` runs before each step's own; `browserControls` from the two
are coalesced with the step's keys winning.

**Preconditions and reversal**

- `ensure`: `demo-genome-installed`, `demo-genome-active`, `slice-genome-installed`,
  `slice-genome-active`, `reg4-gene-focused`, `notifications-clear`.
  **A precondition's result is not visible to the arrival that follows it** if it publishes
  through React state: `ensureSliceGenomeActive` sets the override, and `overrideRef` only
  catches up on the next render, so an arrival reading it immediately saw the old, empty list.
- `undo`: only `unfocus-gene` and `delete-tutorial-note` remain — everything else is
  expressible as `arrive`. It lives on the step being *left*, not the step returned to.
- **A precondition must never undo the step before it.**

**Pacing**

| Field | Meaning |
| --- | --- |
| `holdMs` | How long the result stays up once the step is satisfied |
| `autoplayMs` | Overrides the word-count-derived autoplay dwell |
| `settleMs` | How long Next waits for a `signal` (default 2.5s) |
| `autoplayDemo` | A `browserView` move sequence played before autoplay advances |

**Other**

- `reveals` — extra cutouts; `ring: true` draws a ring; `whenTypedTarget` delays it.
- `copy` / `copyTarget` — a value offered on the card, and the field it fills. Only for
  values where one value works and nothing else does (pair it with `overwrite: true`);
  a test enforces the pairing both ways.
- `prefill`, `openSectionTarget`, `sectionContentTarget`, `blockedControlMessage`,
  `interaction: 'zoom-only'`, `datasets`.

## The failure modes to check every step against

1. Does the step ask for an action while permitting none? (Look-only conversion of a group,
   a row or a wrapper.)
2. Does its card assert state its `arrive` does not establish?
3. Does a multi-target click advance on the last target?
4. Does a `signal` advance have an explicit action?
5. Does a step that creates something have a predecessor declaring the empty state?
6. Is the `arrive` order a dependency order?
7. Does the card cover the centre of what it describes? A subject larger than the card has
   nowhere to put one, and semantic placement then falls back to the centre of the window —
   which *is* the centre of the ring. Author a `cardPosition` on the subject's edge, and check
   it at the smallest window, not the one you authored in.
8. Does a browser step declare everything it needs *registered*, not just displayed? Views
   unmount, so a step in one app cannot inherit what another app's steps set up.
9. Does one step press several controls *and then a different, final one*? That is two steps.
   The reader who does the several cannot reach the final one under the same highlight, and
   pressing Next re-runs the whole action — which, for anything that toggles, undoes exactly
   the work they just did. Split it, use `all-clicks` with `desiredEngaged` on the several, and
   give the final press its own step.
10. Does every control a step asks the reader to *use* have a capability the interaction guard
    accepts for the events that control needs? A `<select>` needs `mousedown` and `change`; the
    guard maps capabilities to event types and a mismatch is silent — Next works and the
    reader's hands do not.
