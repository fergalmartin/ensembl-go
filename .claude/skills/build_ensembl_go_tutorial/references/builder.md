# The visual builder, the target catalogue, and extending both

`frontend/src/components/TutorialBuilderOverlay.jsx` (~2.4k lines) is the builder.
`TUTORIAL_BUILDER_ENABLED` in `frontend/src/tutorials/authoring.js` is the single frontend
switch; the backend applies the same source-checkout gate. Turning it off returns the app to
the previous authoring route without changing any shipped tutorial.

**A hook added to the builder must go above its early return and below `selectedStep`.**
Further down gives "Rendered more hooks than during the previous render" the moment the
builder opens; further up gives "Cannot access 'selectedStep' before initialization" on
mount. Both crash the whole view. This has caught people twice.

## Where a draft lives

`<output directory>/tutorials/drafts/<tutorial id>/`, autosaved, with embedded dataset
assets under `datasets/`. The header shows **Unsaved changes** / **Saving…** / **Saved** /
**Save failed**. **Save & close** waits for the write before refreshing the Tutorials page.

The same file can be written directly — it is one JSON document — but **an open builder will
overwrite a direct write on its next autosave**, so reload it first and take a backup beside
the file. Undo/redo covers field changes; one drag or resize is one undoable operation;
checkpoints are in-session snapshots.

## The editor sections, and what each writes

| Section | Writes |
| --- | --- |
| Information box | `section`, `title`, `body`, card position and size |
| Primary highlighted target / Pick target | `spotlight.target` — or **No primary highlighted target** |
| Additional highlighted targets | `reveals[]`, with rings |
| Allow interaction / Pick live allowed control | `interactionPolicy.targets[]` with capabilities; **Make this step look-only** writes an empty `targets` |
| Scrollable regions | `interactionPolicy` `scroll` — passes scrolling through **without** highlighting or undimming |
| Next/autoplay action | `autoplay.actions[]` — activate, enter a value, set a locus, button state after Next |
| Value offered on the card | `copy` and `copyTarget` (only targets that accept input are offered) |
| Manual completion | `advanceOn` — manual, click, all-clicks, input value, fixed pause, or a signal |
| Progression and autoplay | `holdMs`, `autoplayMs`, `settleMs` |
| Browser arrival state / Multi-genome arrival state | `arrive` `browserView` / `browserControls` / `browserScene`; **Use current browser state** captures the scene |
| Browser state applied by Next | An idempotent `browserScene` action |
| Complete when the browser matches | `completeWhen`, waiting on the `browser.state` signal |
| Autoplay browser demonstration | `autoplayDemo` as a `browserView` move sequence |
| Genome list arrival state | `arrive` `selectorList` — **Frame a fixed, complete genome list** |
| Selected genomes on arrival | `arrive` `genomeSelection` |
| View position on arrival | `arrive` `pageScroll` — **Use current position** |
| Dialog on arrival | `arrive` `dialog` with `fields` |
| Playlists on arrival | `arrive` `playlists` |
| Track Manager on arrival | `arrive` `trackRegistry` — which demo tracks are registered, and the registration wizard's own state |
| Custom tracks on the panel | `arrive` `browserTracks` — which registered tracks a panel draws, and the track picker |
| Tutorial datasets | `datasets[]`, `settings.genomeColors`, `settings.showInactivePills`, **Initially active genomes** |
| Locked-bar message | `blockedControlMessage` |

Plus, outside the step editor: **Record actions**, **Reset scene**, **Transparency**, the
left-edge resize handle, **Export package**, **Checkpoints**, and **Create a portable region
from an active genome**.

## Recording

**Record actions** translates only registered semantic operations: a view change becomes an
activation of `app.viewButton`; entering or submitting a registered input becomes an `input`
action; clicking a registered control becomes an `activate` action; a settled browser pan or
zoom becomes one before/after locus action rather than dozens of pointer events. An element
with no target contract is **not** recorded and cannot silently become a CSS selector.

Target picking and recording use a full-app capture mode: the panel and preview card move
out of the way, leaving a click-through status strip. Escape cancels picking or stops
recording; pressing it while an input is active first commits that pending recorded input.

Recording is a convenience, not a macro system. An action that is meaningful but
unregistered needs a target contract or an adapter before it can be authored at all.

## The builder is a faithful preview of *presentation*, not of everything

This is the general lesson from the playlists work, and it is why Phase 5 exists. Two
reported "it looks different when I run it than in the builder" bugs were real and neither
was visible in the preview: `resetBrowserScroll()` throwing away authored view positions,
and the app's view-alignment effect deleting playlists a step had just created. Verify in
playback, not in the builder.

## Target contracts

`frontend/src/tutorialTargets/` is the stable catalogue — `app.js`, `configuration.js`,
`download.js`, `genomeSelector.js`, `customGenome.js`, `fileBrowser.js`, `trackManager.js`,
`genomeBrowser.js`, assembled by `index.js`.

**A surface that opens over more than one view belongs under `viewId: 'app'`.** The file
browser is the case: `validateTutorialDocument` rejects a step whose `view` disagrees with its
target's `viewId`, and `'app'` is the only value exempt from that check — so `files.*` filed
under `genome_selector` made the same dialog unusable from the Track Manager. There is a test
pinning which views are authorable; adding a module means updating it.

A contract has a stable `id`, `contractVersion`, human `label`, control kind, `viewId`,
optional validated `parameters`, `capabilities` and a safety class. Selectors and
`data-tour-id` values live **only** here; documents store references.

Capabilities a document may use: `spotlight`, `activate`, `input`, `set-state`, `scroll`,
`pan`, `zoom`, `set-locus`, `read-state`.

`index.js` adds an optional `recipeId` parameter to every genome-browser target except the
global controls, which scopes its selector to `[data-tutorial-genome="<recipeId>"]`. That is
how a step addresses one genome's panel rather than the first on the page.

### Adding a target

1. Find or add the element's hook. Prefer an existing semantic attribute
   (`[data-focus-drawer]`, `[data-browser-toolbar]`); otherwise add a `data-tour-id` to the
   owning component — resolution is `document.querySelector`, so no props are threaded and
   it is a one-line diff. Shared subcomponents take a `tourId` prop.
   **Write the id out literally.** The anchor test is plain text matching over source and
   sees `data-tour-id="literal"`, `` data-tour-id={`prefix-${expr}`} `` and `tourId="literal"`
   and nothing else — which is why the three track-gutter markers are written out one by one
   rather than mapped over a list.
2. Give dynamic rows a **parameterised** contract (`anchorTemplate` with `{param}`) rather
   than one id per row, and validate enum parameters where the values are bounded. Anchors
   resolve to the first match, so a per-row anchor must include the row's key.
3. Expose only the capabilities the step genuinely needs. A rich surface (a canvas) needs a
   small adapter for read state, set state, pan, zoom or set locus rather than a raw click.
4. Register it in `tutorialTargets/index.js`, then extend the browser inventory states so
   every advertised target is mounted at more than one viewport size.
5. Run `frontend/tests/tutorialTargets.test.js`. A removed contract or capability must become
   a compatibility report, never a hanging spotlight.

### Pointing at something drawn on the canvas

The browser draws to canvas, so nothing inside the drawing surface has a DOM node. Two
patterns exist:

- **Marker divs.** The 48px track gutter carries `pointer-events: none` marker divs
  positioned from the layout the renderer already computes. They exist only to be measured;
  every click still reaches the canvas. Copy this pattern for another canvas-drawn thing.
- **Real DOM over the surface.** The transcript footer pills are genuine elements positioned
  over the canvas, which buys hit-testing, hover and an accessible name, so they take a
  `data-tour-id` directly.

## Highlighting versus permission — the invariant

| Concern | Document field | Runtime effect |
| --- | --- | --- |
| Primary highlight | `spotlight` | Cutout and optional ring |
| Extra highlights | `reveals` | Extra cutouts; `ring: true` draws rings |
| Allowed clicks/input | `interactionPolicy.targets` | Lets declared events reach the app |
| Allowed scrolling | `interactionPolicy` with `scroll` | Scrolling reaches the region; **no cutout** |
| State on arrival | `arrive` | No highlight, no permission |

In `TutorialOverlay.jsx`, `cutouts` must be built only from `padded` and `revealed`
rectangles. Scroll rectangles belong in `liveArea` only, so the invisible blockers do not sit
over the list — adding them to `cutouts` lights the whole list and defeats a per-row
highlight. Scroll permissions do not participate in `all-clicks`.

## Extending the builder

Extending it is allowed and expected when the tutorial needs something it cannot author.
Keep to the shape it already has:

- **One new editor section per concept**, seeded from the scene in front of the author, with
  an explicit off state that removes the field entirely ("leave whatever is there alone").
- **Write portable fields**, never selectors or raw geometry the document forbids.
- **Make it idempotent.** Anything authored into `arrive` runs on every entry, so it must set
  rather than toggle.
- **Say what it does not do** in the copy, the way **Scrollable regions** says that scrolling
  is passed through without highlighting.
- **Participate in Undo.** Dataset attach/detach does; new operations should too.
- **Add a test** in `frontend/tests/tutorialBuilder.test.js`, and document it in
  `docs/TUTORIALS.md` under "The visual tutorial builder" and in the handoff.

## Promotion

`POST /api/tutorial/drafts/promote` → `promote_draft` in `backend/tutorial_packages.py`.
Validation must pass. It writes
`frontend/src/tutorials/generated/<id>.tutorial.json`, copies `datasets/` into
`backend/data/tutorials/<id>/datasets/`, and **regenerates `generatedTutorials.js` entirely**
with `generatedTutorial1`, `generatedTutorial2`, … import names. Check the diff: readable
hand-edited names in that file do not survive.

Keep the old source definition, if there is one, until the promoted document has completed
Next, Back, direct-step and all-speed autoplay regression runs.

## Packages

`.egtutorial` is a ZIP with `manifest.json`, `tutorial.json`, per-file SHA-256 hashes and
optional generated dataset assets, capped at 100 MB. Import previews read-only first and
rejects traversal paths, links, undeclared files, hash/size mismatches, unsupported schemas
and executable content. **Create recipe from region** extracts real sequence and complete
annotation at the current coordinates — partial genes may expand the boundary (the default),
be omitted, or cancel generation; expanded real sequence is capped at 5 Mb. Warn the author
that a package made from a private genome contains that real sequence and annotation.
