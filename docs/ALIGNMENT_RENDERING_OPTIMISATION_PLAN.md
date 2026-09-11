# Alignment Explorer rendering optimisation plan

Reviewed 11 September 2026. Scope: current Original alignment and working-layer rendering, both Alignment and Panel zoom. This is a code review and targeted backend benchmark; it is not a browser frame trace or a claim that the reported whole-view flash has been reproduced. Application behaviour has not been changed.

The recommended design is a persistent, coverage-aware view backed by fixed multiresolution tiles. Navigation should immediately reproject compatible cached content, fill newly exposed areas with inexpensive coarse data, and replace that data locally as detail arrives. A smaller response alone will not solve the current backend cost.

## Evidence and likely causes

### 1. Summary computation grows with the underlying alignment

`backend/alignment_explorer/store.py:482` reads raw sequence chunks across the requested region. Summary generation counts bases and compares canonical bases against the focus row. Reducing `bins` reduces output but still traverses the underlying bases, including a Python comparison loop for non-reference rows. No persistent regional summary pyramid or result cache exists in this path.

Read-only benchmark against the existing primate dataset `d3fb44a7c283a0bfc68306290171225f`, block 16, 19 non-empty rows, first returned row as focus:

| Requested columns | Requested bins | Median store time | Three runs, ms | JSON size, approximately |
| --- | ---: | ---: | --- | ---: |
| 16,384 | 128 | 31 ms | 44.8 / 31.2 / 31.4 | 267 KB |
| 131,072 | 128 | 190 ms | 188.7 / 189.6 / 190.1 | 283 KB |
| 1,000,000 | 128 | 1,567 ms | 1557.1 / 1566.6 / 1599.3 | 319 KB |
| 1,000,000 | 2,048 | 1,572 ms | 1573.8 / 1571.5 / 1561.1 | 4.30 MB |

These are direct `AlignmentStore.region` calls using SQLite `mode=ro`, Python 3.9, three sequential runs per case. Timings exclude HTTP, JSON serialization, client parsing and painting; JSON sizes use Python's default serializer. They reuse an existing index and are not cold-import timings. They establish the scaling problem, not the exact delay for every gesture.

`useLayerData.js` also asks for a wider, 128-bin fallback covering up to five times the primary request's span. That fallback is small on the wire but can be expensive to compute. Simply fetching more of these earlier could increase contention.

### 2. Available cached coverage is not fully used

`useLayerData.js:50` selects one exact response or one overlapping response, plus one overview. Fallback matching checks block, focus and horizontal overlap, but does not establish coverage of all requested rows. It prefers the widest response rather than composing the best available intervals per row. Consequently, one response can displace another useful response while leaving holes that other cached responses could fill.

`useOriginalBlocks.js:32` likewise chooses one cached layout response. When an exact layout arrives, it immediately replaces the fallback, independently of sequence readiness. Transitioning from grouped presence to individual blocks can remove already visible presence before individual sequence summaries arrive. Selecting one partial layout can also discard useful neighbouring descriptors.

`regionTransition.js` has coverage helpers and tests, but no production caller. Its tests do not validate the live hook-to-painter coverage transition. Camera independence is correct and must remain: solving missing coverage must never roll navigation back to an earlier camera.

`paintLayer.js` clears and repaints the viewport every time. A clear followed by a synchronous draw is not, by itself, proof of a visible flash; the problem is that the replacement drawing can have less content. A live trace is still needed to distinguish missing geometry, missing row data, buffer resets and slow frames in the reported whole-view disappearance.

### 3. Request scheduling and cache retention can lose the race with navigation

`tileScheduler.js` already deduplicates in-flight requests, publishes completions independently and limits requests. These are foundations to preserve. However:

- All primary requests precede wider fallbacks. Missing coarse coverage has no reserved budget.
- Every in-flight request survives navigation, including work that is no longer useful. A new viewport can wait behind slow obsolete work.
- Requests are padded, quantized viewport envelopes, rather than independent fixed tiles. Overlapping requests duplicate computation and storage as spans or row sets change.
- There is no velocity/latency-based lookahead or explicit adjacent-zoom warmup.
- Eviction is insertion order, not LRU; visible responses and essential fallbacks are not protected. `get` does not refresh recency.
- The request effect is not driven by eviction notifications, so an evicted wanted response is not necessarily rescheduled immediately.
- Failed requests stay failed until a broad retry revision, which also clears good cached content.
- Regional caches belong to hook instances. Cycle mounts a separate hook for every layer preview, potentially duplicating requests and multiplying memory/concurrency budgets.

### 4. Navigation performs avoidable main-thread work

- `AlignmentExplorerView.jsx:127`: autosave cleanup calls `persist()` on every dependency change, including camera changes. The nominal 300 ms debounce therefore still serializes and synchronously writes the previous workspace during navigation.
- `useLayerData.js:54`: every render rescans matching cached responses through `rememberGaps`. Detail responses are scanned character by character, even when previously processed. Gap memory also grows independently of tile eviction.
- `LayerCanvas.jsx`: broad effect dependencies trigger whole-canvas painting and a whole-texture upload for navigation, data and hover changes. There is no explicit animation-frame coalescing in this path.
- `LayerCanvas.jsx`: `renderer.setSize` runs on every paint. The installed Three.js implementation assigns canvas width and height even when unchanged. Resize only when dimensions or DPR change; measure whether this contributes to observed flashes.
- Tilted backplates are destroyed and recreated during repaint. They can be retained until layer/style/size changes.
- `renderResolution.js` computes its first local summary synchronously in the painter. WeakMap caching helps subsequent frames, but first-use work still lands on an interaction frame.
- Per-fragment cache searches, row lookups, bin reductions, geometry and hit-region construction repeat extensively. Optimise the measured dominant work rather than replacing the renderer wholesale.

### 5. Panel zoom increases the visible workload deliberately

The code correctly uses effective scale (`camera.scale * plane`) for sequence resolution and an expanded viewport for panel zoom. Panel mode requests `merge=0`, `limit=256`, and `detail=256` to preserve individual blocks. This product behaviour should be retained.

The server still falls back to grouping above its descriptor budget, so 256 is not a guarantee that all panel views stay individual. Resolve overload through tiled descriptor loading and inexpensive individual-block representations. Do not silently reintroduce grouped presence bars as the normal Panel presentation. The current three-pixel flat-row shortcut is also below the usual reachable minimum: 26 px rows at `PLANE_MIN=0.15` are 3.9 px tall.

## Implementation sequence

### Phase 0 — Establish a reproducible baseline

Add a small opt-in performance harness before changing behaviour. Record request queue wait, service time, parsing/preparation, frame time, texture uploads, cache hit rate, total memory, and visible coverage separately for layout, summaries and bases.

Replay the same paths in both zoom modes: rapid zoom out/in; boundary-crossing pan; immediate reversal; vertical row scrolling; direct block jump; and zoom-level oscillation. Use the primate file's largest block and late blocks, a many-short-block fixture, and a working layer containing disjoint chunks from the same source. Compare first open, repeat traversal, view remount and application restart. Include delayed/out-of-order responses and failed requests.

Inspect a frame trace of the reported flash before treating a particular mechanism as its sole cause. Existing index timings in the handoff document do not measure this interaction path.

### Phase 1 — Preserve coverage and remove obvious frame costs

1. Replace one-response selection with a per-block, per-row interval resolver. Draw compatible coarse coverage first, then finer coverage only over intervals it actually supplies. Combine adjacent cached responses. Missing data, verified absence and real gaps must remain distinct.
2. Apply the same principle to layout. Merge compatible neighbouring descriptor tiles; during a representation change retain the old representation only over regions not yet represented by the replacement. Avoid drawing incompatible layouts on top of one another. Keep block coordinates and row slots stable.
3. Keep the requested camera immediate. Any retained imagery must be reprojected to that camera with matching hit-test geometry. Never freeze navigation pending data. Never retain content across dataset/source changes or show filtered-out rows.
4. Fix autosave debounce: ordinary dependency cleanup cancels the timer; a separate unmount/page-exit flush reads the latest workspace. Avoid serializing a complete workspace for every camera event.
5. Coalesce camera updates and data publications to at most one animation-frame commit, accumulating input against an immediate camera ref. This follows the Genome Browser's `scheduleInteractiveViewport` pattern and avoids losing multiple wheel deltas between React commits.
6. Guard canvas/WebGL resizing; retain backplates; process gaps once at tile ingestion and cache that result. Memoize row indexes and prepared bin colours. Keep expensive preparation out of React render and the painter.
7. Add targeted retry with backoff for transient failures. Preserve healthy tiles while retrying a failed region. Source changes and invalid requests need different handling.

Deliverable: cached content no longer drops out merely because a narrower/partial response arrives, and repeat navigation avoids known unnecessary work. This phase can improve continuity before backend summary acceleration lands.

### Phase 2 — Fixed tiles, persistent summaries and bounded scheduling

Use a stable tile identity: source/index version, block, resolution level, tile coordinate, row identity or stable row batch, and focus identity where the metric depends on it. Keep mutable annotation/label revisions separate from immutable sequence summaries. Request stable row batches and compose visible rows from them; reordering rows should not invalidate nucleotide content.

Use fixed alignment-column grids with power-of-two bin widths and fixed bins per tile. Derive parent summaries from children. Include overlap/edge handling for cropped chunks, arbitrary selections and the final partial bin; do not redefine a bin's position on every pan. Return coverage metadata and explicit available/pending/absent/error status.

Add a disposable disk-backed summary index alongside the existing SQLite source index:

- Persist base composition, gap/unknown counts and sufficient agreement counts. Combine comparable/different counts, then calculate fractions; never average fractions without their weights.
- Precompute the common default reference comparison. Build other focus-row comparisons lazily with a bounded cache; do not build all sequence pairs.
- Choose the finest stored summary level from measured storage/build cost. Read raw sequence only for base detail and unresolved boundary pieces. Coarse responses should scale with returned tiles/bins, not all underlying columns.
- Build reusable layout/presence summaries where profiling justifies them. Presently, grouped layout queries still aggregate memberships over the queried block range.
- Use compact count arrays and avoid repeating row metadata in every tile. Validate exact equivalence for gaps, ambiguous bases, missing reference, missing rows and chunk boundaries.

Change the scheduler to share a dataset-level request/cache service across the main view and previews, with consumer-aware priority and deduplication. Schedule visible missing coverage first, visible refinement next, predicted neighbours next, then idle warmup. Reserve bounded capacity for coverage so expensive detail cannot starve it. Reprioritize useful in-flight work and stop obsolete work only when this releases resources; browser abort alone may not stop a synchronous server calculation. Backend jobs need bounded work units and cancellation checks if cancellation is introduced.

Use true LRU with byte budgets, separate coarse/detail allowances and protection for visible coverage plus its fallback. Size the minimum working set to fit the budget, reducing requested detail if necessary; pinning must not permit unbounded memory. Account for prepared arrays, gap indexes and rendered tiles as well as JSON. Coalesce duplicate backend builds and publish completed cache entries atomically.

### Phase 3 — Predictive buffering and progressive level of detail

Predict a bounded future viewport from recent pan/zoom velocity and measured response latency. Maintain a small buffer on both sides; grow the leading side during motion and shrink speculative work when idle. Prefetch layouts as well as sequence tiles to avoid a layout-then-sequence waterfall. Warm one coarser parent level and, near a threshold, relevant finer children. Cap both bytes and CPU work.

Add hysteresis around resolution thresholds so small gestures do not repeatedly change levels. Make decisions from actual screen pixels and total visible work, including row count, not only columns per pixel.

| View | Representation |
| --- | --- |
| Broad Alignment overview | Existing explicitly labelled grouped block-presence view, backed by cached layout summaries |
| Panel overview | Individual block geometry and membership, with lightweight per-row rendering; suppress unreadable labels and unnecessary decoration |
| Within-block overview | Cached agreement/composition bins with explicit gap and unknown semantics |
| Near base scale | Base colours; refine only the visible intervals |
| Readable base scale | Letters and eligible annotations after coverage is available |

Use known block membership to draw an honest provisional presence representation before sequence bins arrive, visually distinct from agreement or base detail. Do not infer sequence continuity or exact gap positions from that membership.

Keep selected paths visible. Defer nonessential connection counts, hover work and annotation refinement during fast gestures, then restore promptly on settling. Render only the selected Cycle preview and nearby previews, sharing cached content and giving the active alignment priority.

### Phase 4 — Warmup and future-session reuse

The existing imported alignment chunks and source layout already persist on disk; the missing persistent asset is the multiresolution rendering data. Keep derived caches with the backend source index, avoiding a second full copy in browser storage.

On first open, load enough layout and coarse data for the current viewport, then warm adjacent layout tiles and parent summaries. Make this bounded and incremental, not a full-file prerequisite before the user can navigate. For large datasets, offer progress while coarse indexes build in the background. Only consider building more during initial import after measuring the startup penalty.

On later visits, reuse memory tiles across view remounts and disk summaries across application restarts. Version by source fingerprint/index identity, summary algorithm, bin grid and relevant reference identity. Retain the current source-change checks; invalidate derived data when native additions change the source contents. Metadata-only edits should invalidate annotations/labels rather than all sequence data.

Specify a configurable total derived-cache budget, eviction by recent use, last-access metadata, crash recovery and a rebuild path. Incomplete builds must never masquerade as valid empty coverage. Evict only disposable derived artifacts; do not delete user input, saved workspaces or the existing source index as a rendering workaround. Measure actual storage amplification before choosing default limits.

### Phase 5 — Further renderer work only where profiles justify it

Start by separating static sequence content from hover, selection and drag overlays, so pointer motion does not repaint and upload every base. Cache prepared row/bin data and bounded offscreen tiles. Evaluate worker preparation or OffscreenCanvas if long tasks remain after Phases 1–3. Use generation-tagged results and retain the existing Canvas fallback, exports and hit testing.

A full GPU alignment renderer is not a prerequisite. The existing viewport-sized CanvasTexture is a reasonable foundation once coverage, summary computation and update frequency are corrected. Any transient texture reprojection must respect Alignment zoom's fixed row heights and Panel zoom's whole-sheet scaling.

## Acceptance criteria and rollout

Treat the following as proposed targets to validate on a named reference machine, not guarantees established by this review:

- No all-content blank frame or loading placeholder replaces compatible, previously covered visible content during normal pan/zoom. Newly visited uncached regions and deliberate source/filter changes are measured separately.
- Warm pan/zoom targets a 60 Hz interaction budget: p95 frame work below 16.7 ms and no repeated main-thread tasks over 50 ms. Record actual frame intervals as well as CPU paint duration.
- With coarse summaries ready, aim for p95 visible coarse coverage within 100 ms; after settling, aim for requested visible refinement within 250 ms on the reference workloads. Report initial summary-index build separately.
- A second traversal has high cache reuse, fewer backend base scans, no repeated summaries for identical tiles, and bounded memory/disk usage over a sustained navigation run.
- Restarting the app reuses completed summaries without rescanning whole blocks. Interrupted builds resume or rebuild safely.
- No regression in source coordinates, cropped masks, row ordering/compaction, gaps, missing components, comparison focus, selection, annotations, exports, panel centring or the 15% panel floor.

Add focused resolver/scheduler tests for adjacent and partial-row coverage, out-of-order completion, LOD transitions, visible-entry eviction, rapid reversal and retry without clearing healthy data. Test backend parent aggregation against raw results, reference changes, version invalidation, partial bins and incomplete-cache recovery. Add browser gesture replays with frame/coverage instrumentation: pure camera helpers are insufficient to catch a disappearing rendered view.

Ship as reviewable increments: baseline plus immediate frame fixes; coverage resolver and retention; summary index and fixed tiles; prediction/warmup; then any measured renderer follow-up. Keep a benchmark table per increment so each change has demonstrated benefit.

## Verification performed for this review

- Read the Explorer components, request scheduler, backend store/API, current engineering handoff, and relevant Genome Browser tile/cascade and animation-frame paths.
- Ran the existing targeted frontend suites: **66 tests passed**.
- Attempted the existing backend suite; the available Python environment lacks `httpx`, so test collection failed. No dependencies were installed for this review.
- Ran the direct read-only backend benchmark above, independently of the unavailable test client dependency.
- Did not run a browser gesture replay or measure actual desktop frame times. Those are Phase 0 work.

Relevant starting points in the Genome Browser are its fixed LOD definitions, `projectVcfBlockTilesCascadeToView` (fills uncovered intervals from coarser data), LRU cache handling and `scheduleInteractiveViewport`. Reuse those patterns, while preserving the Explorer's row/focus semantics and two zoom modes.
