# Alignment Explorer — engineering handoff

Updated: 10 September 2026. Repository: `/Users/fergal/Desktop/ensembl_local`.

This document describes the current implementation and the decisions needed to continue it. [ALIGNMENT_EXPLORER.md](ALIGNMENT_EXPLORER.md) is the usage guide. The final section proposes efficient local genome association through identifiers, k-mer fingerprints and sequence verification, with explicit TSV precedence. This handoff is a working-tree snapshot, not a release certification or a claim that the original multi-stage proposal is complete.

## Product direction and decisions to preserve

The user rejected the earlier ribbons, divergence-height bundles, comparison-slice and named-set concept as too confusing. **Do not resume that design by default.** The current design is a classical alignment panel placed in 3D space, with selected pieces organised into named layers. The useful interaction is extracting and following sequence chunks, not inferring relationships from a 3D embedding.

Terminology:

| Term | Meaning |
| --- | --- |
| Source block | An alignment block in the input file. Discontinuous MAF blocks retain separate coordinates. |
| Chunk | A user-selected piece of a source block, potentially with different selected intervals per row. Internally usually called a fragment. |
| Original alignment | An immutable, derived view of the source. Always available; not an editable working layer. |
| Working layer | A named, editable collection of chunks. New datasets start with no working layers. |
| Sequence identity | An Explorer ID for a source sequence/copy. It is not an active-genome key. |

Explicit user decisions:

- Always retain the full Original alignment. Extraction from Original copies into a working layer; moving between working layers removes selected cells from the source unless the user chooses Copy.
- Highlighting regions placed in other layers is an **optional, off-by-default** overlay on Original.
- Connection labels default to omitted **alignment columns**, not ungapped bases.
- All rows remain available, even without active or linked genomes. Association enriches rows; it must never filter them out.
- Keep a single compact view toolbar. Loading and secondary actions belong in collapsible left-sidebar sections; the sidebar uses the shared drawer-chevron style.
- Selection is one-shot: after drawing a rectangle or column interval, return to Pan while keeping the selection. The user then drags it to a layer or the new-layer plus target. Dim the rest of the workspace during transfer, leaving layer targets clear.
- Use the Genome Browser's nucleotide palette, typography and navigation conventions. Gaps specifically use background-coloured cells, outlines and light-grey dashes; unknown bases remain visually distinct.
- Cycle should behave like the Genome Browser's rotating layer preview, with press-drag-preview-release and a layer rail.

## Current interaction

The toolbar provides Pan, Select, Columns, Auto arrange, Original block navigation, Reset and Cycle. The sidebar contains Layers, Selection, Alignment & loading, Display & annotations, and Workspace & export.

Wheel behaviour follows the configured Genome Browser scheme. Arrow keys pan and plus/minus zoom. Space-drag pans. The panel starts front-facing; the 3D setting tilts it and exposes the layer stack. Canvas fallback preserves editing without WebGL.

Select cells, release, then drag the highlight into the sidebar. A coordinate-selection dialog is also present. Chunk headers can be dragged to manually position chunks. New chunks are inserted in source order; obstructing successors move horizontally while existing vertical positions are retained. Auto arrange aligns shared identities and provides space for connection labels.

Dragging one working layer onto another opens a choice when intervals overlap: combine overlapping chunks, keep them separate, or cancel. Combining unions selected membership masks; it must not invent cells in the holes between selections. Undo/redo covers layer edits. Removing a working layer is undoable.

Strings connect occurrences of the same sequence ID. Click a cell, name or string to highlight the identity's path. Same-source-block strings can report omitted alignment columns; an overlap uses `↔`. Across discontinuous source blocks the alignment-column distance is unknown, not zero. Original suppresses unknown-distance labels and hides unselected strings in dense views to avoid a tangle. Connections are membership continuity, not inferred ancestry or recombination.

Readable headers expose clipboard FASTA export. Original headers additionally expose a plus action to create a layer from the source block and a row-layout override. Header actions are suppressed when too narrow to be useful. Clipboard export is capped at two million cells and uses `N` for unselected/unavailable cells while preserving source `-` gaps.

## Original layout and zoom levels

Original uses an indexed, stable horizontal layout across the dataset. The artificial spacing between source blocks is a layout device, **not a biological distance**. Source-column rulers remain local to each block.

The default row mode, **Align across source blocks**, assigns every sequence identity a stable row and displays blank-row guides for absent sequences. **Collapse absent rows** compresses each block independently, excluding MAF empty components. A block's row icon can override the global choice; changing the global choice clears overrides.

Original has a fixed left name gutter. In compact mode that gutter describes the nearby block named in its heading; it is not a claim that all neighbouring compact blocks share row positions. Compact blocks now start at the top, rather than alternating into off-screen lanes. Working chunks retain labels beside the leftmost chunk for a path, subject to collision checks.

There are two different overview meanings:

1. **Within a source block:** binned agreement against the fragment's comparison row. Only canonical comparable bases enter mismatch fractions. Gaps and unknown/unavailable data are separate. This is not an evolutionary constraint score.
2. **Across many source blocks:** grouped sequence-presence bars. Filled width represents the fraction of blocks containing the sequence. This is explicitly labelled as presence, not conservation. Sparse headers identify block ranges; clicking a header resolves that range into individual blocks.

**Zoom mode** offers two zooms over the same view. **Alignment** (the default) is the horizontal zoom described above: it changes how many columns a pixel covers and leaves rows 26 pixels tall, which is what reading an alignment wants. **Panel** treats the drawing as one flat sheet and scales all of it, so blocks, names, labels and strings shrink together and whitespace opens around the edges; it is the only way to see a thousand-sequence file end to end, since rows otherwise always outrun the window.

Panel zoom is implemented as a factor on the canvas transform, not as a second layout. The painter works in **plane units** — the coordinates it has always used — and is handed a viewport of `size / plane`, which is where the extra world comes from. Two rules keep it honest and must be preserved when editing `paintLayer`:

- Geometry stays in plane units; anything that should hold its size on screen (glyph legibility thresholds, tick spacing, hairline widths, the dotted ground, the drop indicator) divides by the plane factor.
- Resolution decisions use the **effective** scale, `camera.scale * plane`, not `camera.scale`. That governs `renderResolution`, `visibleRequest`, `denseOriginal` and the letter thresholds; using the raw scale would fetch and draw detail for a view nobody is looking at.

Pointer coordinates are divided by the plane factor once, in `canvasPoint`. Nothing downstream knows about plane zoom, which is why dragging, picking and reordering keep working unchanged at any panel zoom. Below about three pixels a row is drawn as a single presence rect rather than bins, gaps and features, and below about four pixels a glyph is dropped while its hit region is kept — a row still answers to a click when it is too small to carry its name.

`↺` fits the whole panel in Panel mode: the plane comes first, from the rows, and the columns are then fitted to the viewport the plane opens up. Fitting the window first and shrinking afterwards leaves the file a stamp in an empty field.

Base patterns and letters appear at closer zoom. Cached base detail is immediately converted into summaries at subpixel scales so it does not render as thin stripes while network summaries arrive. Wider cached summaries cover edges beneath newer detail where available. Pending data must never force the camera back to an earlier position.

## Code map

Paths below are relative to the repository root.

| File | Responsibility |
| --- | --- |
| `frontend/src/components/alignment-explorer/AlignmentExplorerView.jsx` | Dataset lifecycle, workspace state, history, toolbar/sidebar/dialogs, import/export, integration callbacks. |
| `layers.js` | Pure chunk masks, cut/copy/move/merge, insertion, arrangement, connections, camera bounds, workspace validation/save rebasing. |
| `LayerCanvas.jsx` | Canvas/Three lifecycle, input gestures, hit testing dispatch, screen-to-panel interaction, fallback. |
| `paintLayer.js` | Viewport painting, bases/summaries, headers/gutter, strings, selected paths, hit regions. |
| `originalLayout.js` | Stable versus compact source rows, dense-view detection, whole-curve string hit testing. |
| `useOriginalBlocks.js` | Indexed viewport descriptors, bounded grouping, layout cache and cached fallback selection. |
| `useLayerData.js` | Regional requests, independent tile publication, summary warmup, annotation and distance request budgets. |
| `tileScheduler.js` | Persistent request queue, deduplication, bounded cache, errors, generation cancellation. |
| `renderResolution.js` | WeakMap-cached conversion of detail into coarse summary bins. |
| `regionTransition.js` | Camera-transition compatibility helper; preserves the requested camera rather than holding an old ready camera. |
| `data.js` | API helper, coordinate constants, quantized visible-region requests. |
| `LayerCycle.jsx`, `layout.js`, `explorer.css` | Cycle previews, panel geometry helpers, presentation. |
| `associations.js` | Conservative automatic genome matching. |
| `frontend/src/utils/nucleotideStyle.js` | Shared nucleotide palette and letter threshold. |
| `backend/alignment_explorer/store.py` | Streaming text imports, SQLite sequence chunks, row identity, coordinates, layout index, regional summaries/export. |
| `backend/alignment_explorer/api.py` | API routes, import jobs, source checks, metadata, annotations, workspace persistence. |
| `backend/alignment_explorer/adapters.py` | Optional native/graph adapter infrastructure; not all exposed by this view. |

Application integration:

- `frontend/src/App.jsx`: lazy `alignment_explorer` route, active-genome/config props, MAFFT **Open in Alignment Explorer**, genome-navigation callback.
- `backend/main.py`: registers the router and supplies `alignment_explorer_annotation_features`, using existing local annotation projection.
- Shared toolbar/home/button configuration exposes the view. Existing Cycle and Genome Browser utilities should remain shared rather than duplicated.

## State and coordinate invariants

The current workspace format is **version 2**. Important state includes `layers`, `active`, `original`, `sourceBlock`, `camera`, `selection`, `highlighted`, `tilted`, `annotations`, `originalRows`, `blockRows` and `planeZoom`.

A camera is `{x, y, scale, plane}`. `x` is the left edge in layout columns, `y` the vertical offset in plane pixels, `scale` the plane pixels per column and `plane` the uniform factor applied to the whole drawing (1 is full size). `constrainCamera` takes the floor under `scale` from the window at full size whatever `plane` is doing: deriving it from the shrunken viewport would drive the columns back out to the edges and there would never be any whitespace to see.

A fragment carries `id`, `sourceBlock`, `start`, `end`, `rowIds`, display `x`/`y`, and optionally row `slots`, `layoutRows` and per-row `coverage` interval masks. Source intervals are zero-based and half-open. UI coordinates are labelled one-based. Display placement must never modify source coordinates.

Sequence IDs are derived independently from genome associations. Repeated copies remain distinct. Neither display labels nor species-name resemblance is a safe key for joining paths.

Original fragments are derived from source descriptors; they are not ordinary editable persisted layers. The in-memory Original camera uses indexed global display x. `workspaceForSave` rebases it to the visible source block; load adds that block's `layout_start` back. Preserve this pairing when changing save/load or navigation.

Persistence:

- Local autosave: `alignment-layers:<dataset id>`.
- Last dataset pointer: `alignment-layers:last`.
- Load prefers local storage, then the backend version-2 workspace.
- Explicit Save writes the backend workspace and downloads a `.layers.json` file.
- Workspace import checks source identity and known sequence IDs. Do not silently retarget a workspace to another alignment.

## Backend and API

All endpoints use `/api/alignment-explorer`.

| Endpoint | Purpose |
| --- | --- |
| `GET /capabilities` | Available formats/helpers. |
| `POST /datasets` | Register/import a local path, text or incoming alignment rows. |
| `GET /jobs/{id}`, `POST /jobs/{id}/cancel` | Import progress and cancellation. |
| `GET /datasets/{id}` | Metadata, counts and layout extent. |
| `GET /datasets/{id}/sequences` | Paginated inventory/search. |
| `GET /datasets/{id}/blocks` | Source-block metadata and optional coordinate filtering. |
| `GET /datasets/{id}/layout` | Indexed display interval; bounded individual/group descriptors. |
| `GET /datasets/{id}/blocks/{block}/rows` | Direct block navigation and row membership. |
| `POST /datasets/{id}/region` | Regional bases or summaries, with IDs, bins and focus. |
| `POST /datasets/{id}/connections` | Source spans and distance information. |
| `POST /datasets/{id}/annotations` | Local/embedded projected annotation detail. |
| `POST /datasets/{id}/metadata` | Explicit associations and labels. |
| `POST /datasets/{id}/export` | Regional FASTA or coordinate-aware MAF. |
| `PUT/GET /datasets/{id}/workspace` | Versioned workspace persistence. |

`locate`, `structure`, `graph`, `graph-project` and `native-region` endpoints also exist; their presence does not mean there is a complete corresponding layer-view UI.

Default managed cache: `~/.cache/ensembl-go/alignment-explorer/<dataset id>/`. It can be overridden with `ENSEMBL_ALIGNMENT_CACHE`. Input files stay read-only. Source size/mtime fingerprints detect changes or moves; reopening rebuilds the relevant managed index. Do not delete user caches or datasets to solve a rendering problem.

SQLite stores sequence text in 65,536-column chunks. `source_layout` is a lazily built disposable index containing stable block x/end positions and row counts; layout gaps are currently 32 display units. The API can directly find late blocks without walking from block 1. Native additions invalidate the layout index.

Annotation metadata accepts TSV/JSON with `source` or `id`, `genome_key`, `chrom`, `assembly`, labels and other attributes. Unpositioned FASTA needs explicit compatible coordinates (`genomic_start`, `genomic_end`, `strand`) or saved embedded annotations. Reverse-strand MAF coordinates are preserved. Local GFF3 data must already be available to the app; a matching name alone cannot position annotations.

Text importers include MAF, aligned FASTA, XMFA, Stockholm, Clustal and PHYLIP, including gzip paths. HAL requires `ENSEMBL_HAL_HELPER`; TAF requires the optional Taffy runtime. Helper packaging and the complete earlier format roadmap are not finished by this work.

## Performance design and recent fixes

The previous implementation had three interacting failures: camera hold restored an old ready view, Original geometry/bounds depended on a small incrementally loaded neighbour window, and tile requests were cancelled/replaced as a batch during navigation. One slow block could hold up the entire viewport.

The replacement:

- Uses dataset-level camera bounds and stable indexed block positions.
- Requests a quantized, padded layout region, currently limited to 64 descriptors; wide intervals become groups.
- Chooses one suitable cached layout during transition rather than overlaying incompatible overview levels.
- Publishes each completed regional tile independently.
- Replaces queued tasks on navigation while allowing useful in-flight requests to finish.
- Clears/aborts by generation when the dataset or retry revision changes, preventing stale results from leaking into another dataset.
- Warms wider summaries after visible requests and bins cached detail immediately for coarse rendering.
- Separates annotation/distance scheduling from alignment tiles.
- Marks failed requests explicitly; **Retry loading** clears the failed generation. A failed block must not starve later blocks.

Current scheduler budgets: regional requests default to concurrency 3, 96 entries and approximately 48 MiB serialized-size accounting; layout requests use concurrency 2 and 24 entries; extras use concurrency 2 and 64 entries. Cache eviction is insertion-order, not a full LRU. One oversized response may remain. These limits are not a guarantee of total browser heap usage.

Rendering uses a viewport-sized CanvasTexture on Three.js, not chromosome-sized canvases or per-base DOM nodes. It still paints on the main thread; worker geometry preparation from the original proposal has not been delivered.

## Verification snapshot

The last implementation pass completed:

- Full frontend suite: **988 passed, 1 skipped**, 989 total.
- Alignment backend suites: **24 passed**.
- Targeted model/scheduler tests: **31 passed** (included in the frontend total).
- Scoped Explorer ESLint, production Vite build and `git diff --check` passed. Vite still reports the existing large-bundle warning.
- Browser checks on the actual primate MAF: direct block 180 navigation, repeated zoom out staying near 179–181, whole-file presence overview, clicking a grouped header back into source blocks, global row compaction, block 4 base detail, outlined gaps, and cell path highlighting. No browser console errors were observed in the final check.

The latest visual pass was not a repeat of every earlier feature acceptance exercise. Re-run layer extraction, overlap choices, undo, Cycle and annotations after changes to their respective code paths.

Local real-file reproduction:

```text
Source: /Users/fergal/Downloads/10_primates.epo.1_1.maf.gz
Cached dataset ID: d3fb44a7c283a0bfc68306290171225f
Observed index: 200 blocks; 1,363 sequence IDs
Total block columns: 43,017,264; largest block: 1,000,000 columns
Source fingerprint: size 132283581; mtime_ns 1788973010254629123
```

The file includes ancestor identifiers and missing components. A large identity inventory is expected; do not merge copies merely to make the display shorter. The final source fingerprint was unchanged.

Three local API requests per case measured: late layout 2–7 ms, whole-file grouped layout 11–18 ms, block 180 summaries 96–100 ms, block 4 summaries 61–64 ms. These reused the existing index and do **not** measure cold import, maximum-block cost, camera FPS, full browser update latency, peak memory, or the original 16-GB benchmark targets.

Reproduction commands, from the repository root unless noted:

```sh
node --test frontend/tests/*.test.js
node --test frontend/tests/alignmentExplorer.test.js frontend/tests/alignmentTileScheduler.test.js
python3 -m unittest discover -s backend/tests -p 'test_alignment*.py'
```

From `frontend/`:

```sh
node node_modules/eslint/bin/eslint.js src/components/alignment-explorer
node node_modules/vite/bin/vite.js build
node node_modules/vite/bin/vite.js --host 127.0.0.1
```

From `backend/`, with project Python dependencies available:

```sh
python3 -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The earlier local test environment supplied an extra dependency directory through `PYTHONPATH=/private/tmp/ensembl-explorer-test-deps`. That temporary directory is not a reproducible project dependency installation. Use the project's normal Python environment on another machine. Vite normally uses 5173 and proxies the backend; check its actual reported port if already occupied.

## Remaining work and review priorities

These are limitations or follow-up checks, not all confirmed user-facing defects:

1. **Measure sustained performance.** Record cold/warm timings, largest-block summaries, rapid direction changes, FPS and peak memory. The current API measurements do not prove the original performance targets. Server summaries still scan requested sequence chunks and canonical comparisons; there is no full persistent multiresolution summary pyramid.
2. **Inventory scale.** The API is paginated, but the view currently loads the entire sequence inventory into memory. Some dialogs also generate large lists. Rendering and regional base requests are bounded; total metadata memory is not independent of sequence count. The coordinate-selection row chooser shows at most 200 matching rows at once.
3. **Compact-row clarity.** The fixed gutter names only its indicated compact block. Neighbouring blocks can have different membership/order. Test misleading visual row continuations, per-block expansion, high vertical scroll, and return from an aggregate to compact layout. Do not reintroduce opaque per-block labels over neighbouring data.
4. **Zoom transition completeness.** Cached fallback is immediate where available; a newly exposed uncached region can still briefly be blank/pending. Stress this with slow responses. Do not fix it by freezing or restoring the camera. There is no explicit request timeout in the scheduler.
5. **Coordinate-selection dialog on Original.** Review its use of `active.fragments` versus the derived Original `layer.fragments`; the current code still references the active working layer in parts of this dialog. Test starting with Original alone, switching layers, and aggregate zoom before changing it.
6. **Rapid explicit block jumps.** The direct `sourceBlock()` action should be checked for out-of-order responses when several jump requests are issued quickly. Dataset loading has an epoch guard; do not assume every navigation action has the same protection.
7. **Workspace edge cases.** Recheck restoring an Original camera after panning away from the last explicitly chosen source block, switching back to Original when its requested block is outside the cached descriptors, invalid row-mode overrides, and source files whose contents have changed.
8. **Path and annotation acceptance.** Exercise duplicate IDs/copies, reverse strands, absent components, compact row remapping, masked chunks, merge/cut/export correspondence and GFF3 overlays together. Cross-block connections have no defined alignment-column gap; never invent one.
9. **Native formats and packaging.** HAL/TAF optional dependencies, Windows-through-WSL helper packaging, and a complete native regional browsing UI still need separate work. Similarity space, structural lenses and the earlier ribbon/bundle design are not the current product scope.
10. **Rendering/test coverage.** Model tests cover camera bounds, masks, row layouts, scheduler starvation and curve hit testing; visual interaction checks are manual. There is no comprehensive automated browser/FPS suite.

## Suggested next-session workflow

Read this handoff and the source-layout/data hooks before changing rendering. Reproduce with the supplied MAF, preferably in a separate browser session so the user's working layer layout is not overwritten. Save any existing workspace before changing its state.

For each fix, add a model/API regression test where there is a meaningful invariant, then visually check the actual file at base, source-block and whole-file scales. Check both aligned and compact rows. Preserve the original file and inspect cache/source identity before assuming the index is stale.

The repository currently contains substantial unrelated work and many Explorer files are untracked. This handoff does not establish commit ownership. Inspect `git status` and relevant diffs; do not reset, clean, blanket-stage or overwrite unrelated changes. No commit or deployment was made for this handoff.

## Proposed extension: efficient discovery of links to local genomes

Added at the user's request on 10 September 2026. **Design only; not implemented.** The proposed feature searches locally using region identifiers and sequence fingerprints, while relationships supplied in TSV always take precedence over automatic links.

### Recommended approach: identify, shortlist, verify

Use a cascade rather than comparing each alignment row against every complete genome:

1. Apply explicit relationships first.
2. Resolve assembly-qualified names and contig aliases using existing local metadata.
3. If coordinates are available, fetch and compare a few separated windows from the proposed local interval.
4. For unresolved rows, use a compact, regional k-mer index to shortlist candidate genome intervals.
5. Verify shortlisted intervals with actual sequence alignment, retaining competing mappings.

This separates **which local genome is a plausible match** from **which coordinates are safe for annotation projection**. A close homolog is not proof of the input's original assembly or specimen. Identical local assemblies, conserved primate regions and inferred ancestors can be indistinguishable by sequence. Automatic results must describe measured compatibility, not assert provenance.

A whole-chromosome composition vector or a single small whole-genome sketch is insufficient for local placement. Store regional fingerprints and use query containment rather than whole-genome Jaccard as the retrieval concept. FracMinHash supports containment between differently sized sequences, but sparse sketches lose sensitivity for short queries; this limitation is documented by [sourmash](https://sourmash.readthedocs.io/en/latest/faq.html). A sketch is a candidate filter, not a coordinate map.

### Explicit relationship precedence

Introduce a provenance-aware association store rather than repeatedly overwriting `sequence.metadata.genome_key`:

| Priority | Relationship | Behaviour |
| --- | --- | --- |
| 1 | Explicit TSV/JSON relationship | Authoritative for its scope; automatic searches cannot replace it. |
| 2 | User-confirmed candidate/manual link | Persists across automatic rescans; does not supersede an imported relationship unless the user explicitly edits/removes that relationship. |
| 3 | Unambiguous assembly-qualified identifier, or verified sequence-compatible candidate | May provide an automatic association with its evidence and scope visible. |
| 4 | Name resemblance or unverified fingerprint hit | Suggestion only. |

Keep explicit records and computed candidates separately, resolving effective links by priority. Importing a TSV should immediately supersede lower-priority links for the specified rows and invalidate their projected annotation caches; unrelated rows retain their links. A later background result must recheck the association revision before publication so it cannot overwrite a TSV imported while the search was running.

An invalid or unavailable explicit target remains an explicit unresolved relationship with an actionable message. Do not silently fall back to a different genome. Support an explicit `unlinked` decision that suppresses rediscovery until removed. Conflicting explicit rows for the same scope should be reported before applying that scope, not resolved by arbitrary file order. A specific block/interval override may intentionally take precedence over a broader row default; make that scope rule visible.

Prefer `sequence_id` (the current importer's `id`) to a bare source name. Allow `source` only when it resolves unambiguously, or with explicit block/copy scope. Suggested additional columns: `source_block`, `alignment_start`, `alignment_end`, `genome_key`, `assembly`, `chrom`, `target_start`, `target_end`, `strand`, `action`. Declare coordinate convention in the import UI/schema: proposed external intervals are one-based inclusive, converted to zero-based half-open internally. Existing `genomic_start`/`genomic_end` metadata remains supported; do not reinterpret existing files.

A TSV assigning a genome/contig is authoritative about that relationship, but does not itself prove a coordinate transform. Report coordinate verification separately and enable annotations only where placement is valid.

### Fast path using existing local indexes

Reuse the `.fai`/`.gzi` preparation and `ThreadSafeFasta` infrastructure in `backend/main.py`. Reuse `_build_genome_synonym_index` and the existing chromosome-name resolver; preserve multiple alias candidates rather than guessing. Access these through a small provider interface injected into the Explorer service, avoiding a new circular import from `main.py`.

For coordinate-bearing MAF rows:

- Narrow candidate genomes by assembly identity if supplied; a generic contig name such as `1` is only a hint.
- Convert the source interval and strand correctly, then fetch bounded local windows. Initially try three to five separated 1–2 kb windows where the row has enough canonical sequence; expand if evidence is weak. These are tunable starting values, not validated thresholds.
- Compare in the correct orientation and retain the relationship between ungapped sequence offsets and alignment columns.
- Require informative evidence from separated windows before extending a candidate association across a long row. Verify additional source-block occurrences independently; do not extrapolate one locus's coordinate mapping across the entire source identity.

This path avoids a whole-genome fingerprint scan when identifiers and coordinates already tell us where to look. It should be the first implementation slice for the provided primate MAF.

### Regional fingerprint index for unknown placements

Offer **Build sequence-link index** as a resumable background part of local genome preparation, separate from the critical annotation-index readiness path. Reuse an existing FASTA streaming pass when practical. Existing genomes can be indexed lazily when the user searches; changing the active genome list must not force rebuilding completed indexes.

Prototype a deterministic canonical k-mer hash index:

- Canonicalize each k-mer against its reverse complement. Hash only A/C/G/T runs; reset at unknown bases and unavailable coverage.
- Remove alignment `-` gaps when reconstructing a continuous source sequence, preserving an offset map. Never concatenate across distinct source blocks or unknown coverage to manufacture k-mers spanning discontinuities.
- Partition reference contigs into approximately 16 kb windows, storing the lowest 64 distinct hashes per window as an initial size/sensitivity experiment. Record the window's hash cutoff and eligible-base count. Retain k−1 boundary context and query neighbouring windows so boundary-spanning matches are not lost.
- Start experiments with k=21 or k=31; use the same versioned hash algorithm, seed, k and canonicalization for references and queries. Smaller k improves sensitivity but increases non-specific matches. Do not silently mix incompatible indexes.
- Store an inverted `hash → genome/contig/window` posting list in sorted, compressed or memory-mapped native storage. Keep SQLite for manifests/jobs, not a Python-object or SQLite-row-per-k-mer index of mammalian genomes.
- Query all eligible hashes from bounded query windows against the sparse reference postings. Count distinct matches and spatial support, not repeated copies of the same hash. Downweight or cap high-frequency postings, recording when repeat filtering or search limits reduce completeness.

With bottom-k windows, a raw intersection divided by query k-mer count is **not** a valid containment estimate: reference windows have different sampling cutoffs. Use matched hashes divided by query hashes eligible under each window's stored cutoff, report the sample size, and reject evidence too sparse to score. Alternatively use a fixed hash-threshold sampling scheme with compatible query/reference thresholds, measuring its less predictable index size. Do not equate either score with a calibrated probability.

Rough storage arithmetic for the prototype: 3 billion bases / 16,000 × 64 × 8 bytes ≈ 96 MB of hash payload per genome, before postings, coordinates, overlap, metadata and compression. This is a sizing estimate, not a measured footprint. Under uniform distinct hashes, a 100-base query contributes less than one expected shared sample at that density. Thus **zero sparse hits cannot mean no genomic match** for short queries. Use the coordinate fast path, neighbouring longer source sequence where available, or a denser positional mapper on shortlisted genomes. If none is available, return insufficient evidence.

Genome indexing is necessarily O(reference bases) for a first build; “quick” should mean amortized preparation and bounded subsequent lookups, not an instantaneous scan of every genome. Hashing should run in a native implementation, with cancellation/progress and bounded disk/memory use. Benchmark a library/helper before committing to maintaining a custom index format.

### Verification and coordinate mapping

Merge adjacent hit windows into candidate intervals, fetch their sequence with padding, and verify both orientation and base-level alignment. A reusable minimizer mapper such as [minimap2](https://github.com/lh3/minimap2) is a candidate fallback, subject to local packaging and short-query testing. If used, request detailed alignment output: the [minimap2 FAQ](https://github.com/lh3/minimap2/blob/master/FAQ.md) distinguishes approximate mapping coordinates from base alignment obtained with options such as `-c` or `--cs`. Retain secondary/split mappings for ambiguity assessment.

Store per-occurrence mappings, not only a row-wide genome link:

```text
alignment sequence ID + source block + aligned interval
    → ungapped source offsets
    → target genome/assembly + contig + interval + strand + alignment operations
```

Compose this map when projecting GFF3 coordinates. If the local assembly differs by insertions/deletions, the original MAF coordinates cannot simply be reused with a new `genome_key`. The current annotation callback assumes compatible source coordinates; extending it to consume a verified transform is required before offering annotations on remapped assemblies. Unmapped portions remain unavailable. A small verified window authorizes projection in that window, not across an unverified megabase interval.

Evidence should include canonical query length, distinct informative seed count, supported query spans, comparable-base count, identity, aligned query coverage, orientation, alternative targets, best/runner-up margin, search scope/completeness, and algorithm/index versions. Candidate scoring thresholds require calibration on local fixtures. Prefer **verified compatible**, **ambiguous**, **insufficient evidence**, **no match in searched scope**, and **explicit** to an unexplained percentage-confidence badge.

Do not force inferred ancestor sequences to link to an extant local genome because it is the nearest match. Label such results as similarity suggestions unless explicit metadata establishes a relationship. Search incompleteness, repeat caps, or an unindexed competing genome must prevent claims of global uniqueness.

### Jobs, cache and UI

Add an independent association service (for example `backend/alignment_explorer/association_search.py`) plus an index provider shared with local genome preparation. Proposed endpoints, not existing routes: start/status/cancel association searches, list candidate evidence, accept/reject candidates, and inspect sequence-link index readiness.

Search active genomes by default, with an explicit option to include all locally indexed genomes. The UI should state the scope and excluded/unindexed genomes. Provide **Find local matches** in Genome links & annotations, progress/cancel, grouped candidates and **Accept verified matches**. Keep initial sequence-derived results as reviewable suggestions until confidence rules have been validated. Display an imported-link badge and never make its override a hidden side effect of search.

Start with one bounded background worker; batch queries across rows, deduplicate identical ungapped query windows and keep per-copy output identities separate. Prioritize requested rows without tying matching to every pan/zoom event. Cache candidates by query digest, source fingerprint, candidate-genome fingerprints, search scope and algorithm parameters. Changing TSV relationships invalidates effective association/projection state, while reusable raw sequence-match evidence can remain cached.

Use immutable per-genome index builds with atomic publication and manifests covering FASTA identity, contigs, content digest and hash parameters. File size/mtime can quickly flag changes but should not be the sole long-term content identity. Genome removal or replacement invalidates that genome's derived links without affecting other genomes. No sequence is uploaded; this feature is local.

### Delivery and acceptance

1. Add explicit provenance/precedence and scoped association storage; test TSV overrides, unlinked decisions and in-flight search races.
2. Implement identifier/coordinate-guided verification using existing FASTA indexes. Test the real MAF against available local assemblies and record ambiguous matches rather than assuming the expected human assembly wins.
3. Prototype the regional fingerprint index and positional verification fallback. Compare index build time/size, peak memory, candidate recall and full-query latency against a reusable mapper on a recorded machine. Include both successful and deliberately ambiguous searches.
4. Add annotation-map composition, then enable annotation projection for verified remapped regions. Keep the first release limited to coordinate-compatible associations if this step is not ready.

Acceptance fixtures must cover identical sequences in multiple assemblies, paralogs/repeats, reverse complements, aliases, short sequences, all-N/all-gap rows, indels between assemblies, fragmented/split mappings, ancestor rows, duplicate source copies, tile boundaries, absent indexes, source changes and cancellation. A TSV supplied before or during search must always win. An explicitly linked but unavailable target must remain visible as unresolved. Neither an ambiguous result nor a missing genome may remove an alignment row or alter chunk membership.
