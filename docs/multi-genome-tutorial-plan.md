# Multi-genome browsing tutorial — implementation plan

Reviewed against the working tree and local demo datasets on 7 September 2026.
This is a plan only; no application code or tutorial datasets have been changed.

## Scope and existing foundations

Add a fourth shipped tutorial, provisionally **Multi-genome browsing**, following
Getting Started, The Genome Browser, and Genome Playlists. Use the portable tutorial
document/package workflow and existing sandbox, authoring controls, Next, Back, step
jumps, and autoplay. The current browser tutorial is the reference for wording and
pacing; the handoff documents are background, with current code taking precedence.

The working tree already contains edits to the browser tutorial, runtime, target
catalogue, and overlay geometry. Preserve those changes and build on them.

## Verified data and proposed slices

Source root: the installation's own data directory, the one `ENSEMBL_GO_LOCAL_DATA`
points at.
The human and mouse annotations are stored as Ensembl datasets. Use those as the
intended Ensembl/GENCODE sources, retaining the actual provider and release metadata;
verify their GENCODE provenance before assigning a more specific GENCODE release label.

| Tutorial slot | Local annotation | SAMD11 locus, original coordinates | Strand | Indexed transcripts | Fixed colour |
| --- | --- | --- | --- | --- | --- |
| 1 | Human GRCh38.p14, Ensembl 2025_12, GCA_000001405.29 | 1:923,923–944,575 | + | 18 | `#3366cc` |
| 2 | Human GRCh38.p14, RefSeq, GCF_000001405.40, ncbi/current | NC_000001.11:923,923–944,574 | + | 3 | `#00b692` |
| 3 | Mouse GRCm39, Ensembl 2026_04, GCA_000001635.9 | 4:156,331,423–156,341,182 | − | 14 | `#f59e0b` |
| 4 | Rat GRCr8, Ensembl 2024_03, GCA_036323735.1 | 5:172,113,654–172,131,927 | − | 2 | `#ec4899` |

Counts come from the local annotation indexes, not a claim about future releases.
Mouse uses the symbol `Samd11`; retain that spelling and verify uppercase `SAMD11`
search and automatic linking against the actual search endpoint.

SAMD11 itself meets the requested human transcript-count condition, so there is no
need to introduce an unrelated gene. Proposed extraction windows:

- Both human annotations: chromosome 1, 880,000–1,060,000.
- Mouse: chromosome 4, 156,250,000–156,430,000.
- Rat: chromosome 5, 172,030,000–172,210,000.

These are approximately 180 kb per annotation, with room to pan and inspect nearby
genes. Treat them as provisional until complete-gene boundary expansion and linked
viewport checks are run. Human slices must have identical final bounds: expand
against both annotations until neither cuts a gene. Rodent windows cover the
corresponding SAMD11 neighbourhood, not matching chromosome numbers or coordinates.

Reuse `backend/tutorial_datasets.py` to retain complete genes and their descendants,
real sequence, original coordinates, and bounded browsing. Its compressed FASTA
padding preserves coordinates for slices far along a chromosome. Package generated
files and checksums with the tutorial so playback is offline and independent of the
author's Desktop directory. Preserve source provenance and required attribution.

Preserve proper chromosome aliases in the slice metadata. The current report writer
manufactures aliases from the slice chromosome name; that does not connect `1` to
`NC_000001.11`. Link region uses these aliases, so this needs an explicit fix and test.
Keep human annotation identities distinct even though they share a coordinate system.

Copy the four colours above from the saved demo configuration into tutorial-owned
settings. Apply them through the sandbox override in fixed dataset order. Playback,
builder preview, and package import must use this snapshot, regardless of later user
palette changes. Recheck the live configuration when implementation starts in case it
has unsaved palette edits.

## Walkthrough structure

Aim for roughly 30 short cards, grouped by idea. Each important action gets a separate
result card. Exploration cards advance only when the reader presses Next; an incidental
pan or zoom must not end the exercise.

| Cards | Section | What happens |
| --- | --- | --- |
| 1–2 | Starting with four annotations | Open directly in the Genome Browser. All four pills are present in the fixed order; only human Ensembl/GENCODE is active. Introduce active/inactive pills, then highlight its browser panel and explain the small local slices. |
| 3–4 | Two annotations on one genome | Ask the reader to activate human RefSeq. On the next card highlight the new panel, its distinct colour, and the alternative annotation on the same GRCh38 assembly. |
| 5–7 | Finding the controls | Highlight both genome control bars, then the general control bar and multi-genome buttons. Explain that these controls will be explored next. Allow independent panning/zooming of the two canvases; genome bars and other controls stay locked. |
| 8–10 | Linking a region | Prepare a close human Ensembl view around SAMD11, with RefSeq displaced to a nearby region. Explain chromosome-name/coordinate matching and the common GRCh38 coordinate system. Ask for Link region, then show the matching coordinate windows and aligned annotations on a dedicated result card. |
| 11–14 | Linked movement | Highlight the automatically engaged Pan and Zoom buttons separately and explain each. Let the reader try linked movement. Then allow a short exercise toggling Pan and Zoom independently so their separate effects are visible. |
| 15–18 | Adding other genomes | Ask for mouse and rat activation, with a result card highlighting both new panels. Explain their different chromosome locations. Clear the old two-human link group before letting the reader explore all four panels with access only to Pan, Zoom, and canvas movement. |
| 19–20 | Focusing one gene | Establish four unlinked panels and no focused genes. Highlight the human Ensembl search field together with its search icon. Ask for `SAMD11` and accept Return or the icon. Show the resulting focus bar and human panel before introducing another control. |
| 21–23 | Linking a gene | Explain Link gene's symbol/ID matching, including `Samd11` in mouse. Ask the reader to press Link gene. Show all four focused genes, their different coordinates/strands, and automatically linked Pan/Zoom. Let the reader explore with the buttons and per-genome controls locked. |
| 24–27 | Making space | Explain the challenge of fitting several genomes into the window; remind readers of transcript compression/layout controls from the browser tutorial. Introduce the per-genome GF/GR/SL switches. Ask them to hide GR in both human panels and GF in mouse and rat, leaving the SAMD11-bearing strand plus SL. Use two action cards if necessary for scrolling, followed by a clear result card. |
| 28–30 | Unfocus and review | Highlight global Unfocus and distinguish it from clearing one genome's focus. Ask the reader to press it, then show all focus bars removed. Review annotation comparison, region versus gene linking, Pan/Zoom, selective tracks, and global Unfocus. |

Suggested wording, matching the current browser tutorial:

> Each active genome has its own control bar. The two bars highlighted here change
> location and focus for their own genome. The general controls above apply across
> the active genomes.

> Both annotations use GRCh38, so the same coordinates refer to the same place.
> Link region matches region names and coordinates; it doesn't translate coordinates
> between assemblies. For example, position 1,000,000 on chromosome 1 in GRCh38 and
> CHM13v2.0 needn't refer to the same sequence.

> Try panning and zooming the tracks before moving on. The genome control bars aren't
> active for this step.

Avoid describing Link gene as sequence alignment or orthology inference. Its current
implementation searches matching names/IDs and frames linked genes relative to their
5′ positions; different gene lengths and strand directions remain visible.

## Runtime and target work

1. **Address a particular genome.** Extend browser target references with a stable
   tutorial dataset reference, resolved to the installed panel key. Scope toolbars,
   searches, focus bars, canvases, and track switches to that panel. Existing DOM
   `data-focus-panel-key` attributes and the viewport registry provide a foundation;
   many current selectors still select the first panel. Keep existing single-genome
   targets backward-compatible.

2. **Expose multi-genome controls.** Register Pan, Zoom, Link region, and Link gene
   targets with enabled/engaged state. Add semantic read/set operations for linked
   membership, link type, anchor genome, and per-panel focus/view/track visibility.
   Reuse the browser's actual handlers for automatic actions and state restoration.

3. **Separate highlighting from permissions.** Permit pan/zoom only on the requested
   canvases, even when the spotlight surrounds several panels. Restrict hit-tested
   canvas controls too: a pointerdown allowed for dragging must not also enable a
   gutter toggle, selection, transcript manipulation, or gene focus. During the
   relevant exercise, allow only the two named global Pan/Zoom buttons additionally.
   Blocked toolbar clicks should give a brief, non-modal message such as “This control
   bar isn't active for this step”, without advancing or moving the view.

4. **Make track toggles actionable.** Current GF/GR/SL target markers are passive
   overlays on canvas hit areas. Expose stable toggle hit areas/state through the
   existing toggle handler, so manual clicks, Next, and arrivals behave identically.
   Allow only the required four toggles in this exercise; keep SL enabled.

5. **Wait for results.** Completion should depend on the expected active genomes,
   focused genes, linked membership/positions, or hidden-strand state, rather than
   just receipt of a click. Gene linking is asynchronous. Include panel identity in
   signals so an event from the wrong genome cannot complete a step. Retain visible
   action pauses and dedicated result cards.

6. **Freeze tutorial appearance.** Add a validated, allowlisted tutorial settings
   field for the palette and necessary starting browser settings. Carry it through
   document materialisation, preview, export/import, and sandbox start. Preserve it
   when arrivals update active genomes. Do not write it to the user's configuration.

## Back, Next, and direct jumps

Every card declares the scene it needs: selected pills, active panels and their order,
per-panel locus/focus, transcript display, visible GF/GR/SL tracks, link model and group,
Pan/Zoom state, and relevant drawer state. Establish these on every arrival, including
direct jumps and Back. Do not depend on toggling the previous step's state.

Restoration order: stop pending linking/navigation, clear existing links, establish
active panels, await readiness, restore per-panel state, apply the required link model,
then establish scroll framing and reveal the card. Guard late async results with an
arrival generation so old searches cannot overwrite a newer step.

Result cards should preserve the result the reader just produced on normal forward
navigation; use declared fallback scenes when entering backwards or by a jump.
Exploration state stays untouched while the reader is on its card. Next should not
undo completed actions or toggle an already-correct control again.

Two particular pitfalls in the current browser behaviour:

- A region link retains its linked-member set. Simply activating rodents afterwards
  can leave Pan/Zoom acting only on the two humans. Explicitly clear that link before
  the four-genome free-browsing exercise.
- Link gene retains genes already focused in other panels rather than replacing them
  all from the query. Before the SAMD11 exercise, ensure only the first human panel
  has a focus. Global Unfocus also clears links and turns off Pan/Zoom; show this
  actual result in the final result card.

## Scrolling and presentation

Retain the overlay's existing animation-frame measurement, capture-phase scroll
updates, and clipping to visible ancestor bounds. Extend these to all scoped panel
targets and use individual visible rectangles rather than one large rectangle that
exposes unrelated controls between them.

Allow page scrolling independently of canvas zoom: keep wheel behaviour on canvases
consistent with the app, and provide usable page scrollbars/margins and appropriate
keyboard navigation. Do not continually scroll a reader back to the highlighted item.
Scroll targets into view only for an arrival or necessary visibility repair; wait for
layout to settle before showing deferred cards. Re-measure while drawers open, tracks
collapse, panels resize, and sticky bars move. Off-screen panels should not leave a
floating highlight over unrelated content.

Place cards against real two- and four-panel layouts, avoiding the genes, search icon,
and controls being taught. Split the track-switch exercise across cards if necessary
instead of requiring all four panels to fit on a short display.

## Implementation order and acceptance

1. Prepare and validate the four portable slices, aliases, provenance, and frozen
   colours; confirm real `SAMD11` searches resolve in all four installed slices.
2. Add scoped targets, browser state operations, restricted interactions, and
   semantic completion signals. Prove the two-human region-link scene first.
3. Author the document and package; add catalogue registration using the established
   shipped-document workflow. Update `docs/TUTORIALS.md` for the new capabilities and
   current tutorial inventory.
4. Walk through manually and adjust wording, action/result pauses, and card positions.
5. Validate every step forwards, backwards, and by direct jump; exercise Next after
   partially and fully completing multi-action steps, plus autoplay, restart, and exit.

Focused tests should cover scoped selection, permissions including canvas hit areas,
deterministic arrivals, stale async results, alias matching, symbol case handling,
correct retained strands, palette isolation, and complete-gene/sequence extraction.
Run the existing frontend tutorial tests, relevant backend dataset/package tests,
lint, and production build; run the broader suites once shared runtime changes settle.

Browser-driven acceptance is essential: test short and tall desktop windows, resize
mid-step, scroll continuously with several spotlights, pan from each panel, test slice
edges, try every blocked toolbar, and repeat the four track switches after Back.
Check actual visible results, not only source-reading tests or click events. Compare
the user's saved configuration before and after, and verify browser session controls
are restored when leaving. Perform playback QA with a separate output directory so it
does not reset the user's existing tutorial workspace.
