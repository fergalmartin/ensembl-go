# Find: pattern preparation and rendering

> **The word is Find.** This engine was built for the alignment explorer under
> the name *motif*, which named what a biologist looks for rather than what the
> control does — and left the sequence view with nothing to call the same thing
> when it grew one. Everything a reader sees now says Find.
>
> The identifiers did not change: the colour scheme's id, the storage key and
> the `/motif-jobs` routes below are all still `motif`. They are written into
> stored workspaces and into a running server, and renaming them would cost a
> migration to change a word nobody sees.
>
> The *model* — the ordered list of patterns, their colours and switches, and
> which of two overlapping patterns wins a base — is now
> `frontend/src/utils/findPatterns.js`, shared with the sequence view. See
> **Finding something** in `SEQUENCE_VIEW.md` for the other half.

The alignment explorer's Colour, Select, Zoom and Hide menus use draft settings
with Apply and Cancel. Colour → Find remembers patterns on Apply. Cancelling
preparation keeps the previous applied view; remembered patterns remain
available for another attempt.

## Pipeline

1. Apply starts a background job over every source block/sequence occurrence.
   The current colouring and block layout remain visible while it runs.
2. For each sequence, reuse cached motif searches or search the ungapped text.
   Matches map back to aligned coordinates, preserving gaps. Strings and regular
   expressions are case insensitive, include overlapping occurrences, and search
   the displayed strand within each source block. Empty regex matches add no colour.
3. Resolve priority once (the top enabled motif wins), then prepare compressed
   colour masks at multiple resolutions. Each mask contains palette indices;
   actual colours belong to the view.
4. Commit that sequence's new searches and prepared tiles in one SQLite
   transaction. Cancellation or an error before completion saves none of that
   sequence's new work. Previously completed sequences remain cached.
5. Publish the completed snapshot and optional matching-block layout together.
   Canvas navigation requests prepared tiles only; it cannot initiate searches.

A small cancellable status appears immediately. After two seconds it becomes a
progress dialog showing sequence-region and motif progress, new searches, reused
searches and already prepared regions. Both status displays sit outside the
canvas layout, preventing their updates from resizing it.

## Rendering cost

The browser requests aligned tiles of 1,024 bins and at most 16 rows, with two
requests in flight and a 24 MiB / 256-entry memory cache. Requests remain stable
across small pans. The server reads only the relevant compressed tiles and emits
disjoint colour runs. The browser paints those runs without sorting all matches
or iterating every underlying base at overview scale.

At base resolution, colours are exact. At overview resolution, the highest
priority motif present in each pixel-sized bin supplies its colour. This makes
dense motifs visible without sending hundreds of thousands of occurrences to
the browser.

## Reuse in another sequence view

`backend/motif_engine` has no alignment, HTTP or colour-picker dependencies:

```python
from types import SimpleNamespace
from motif_engine import MotifCache, composition_key

motifs = [SimpleNamespace(pattern='ATG', kind='literal')]
cache = MotifCache('sequence-motifs.sqlite')
key = 'source-revision:sequence-id'
cache.prepare(key, lambda: 'CATG--ATG', motifs)
runs = cache.region(key, composition_key(motifs), 0, 9, step=1)
# [start, end, palette_index], using zero-based half-open sequence coordinates
```

An adapter supplies immutable sequence revision keys, a lazy sequence loader,
ordered motifs, a cancellation callback and a progress callback. The alignment
adapter lives in `backend/alignment_explorer/motif_jobs.py`; one worker serializes
preparation without blocking HTTP request handling. Separate views do not cancel
one another's jobs.

The frontend's `components/motifs/useMotifPreparation.js` owns the cancellable
prepare/publish lifecycle through a transport with `start`, `status`, `cancel`
and `finish` methods. `components/motifs/render.js` paints sorted colour spans on
any sequence canvas. Alignment-specific source selection and viewport planning
stay in `motifTransport.js` and `motifTiles.js`.

## Cache lifetime and limits

Search keys include the engine version and pattern semantics, but exclude motif
ID, colour and order. Recolouring reuses prepared masks; reordering composes new
masks from cached searches. Adding a motif searches only that new pattern.
Alignment cache keys include the source index revision, so a changed index
cannot reuse stale sequence matches.

Each alignment's persistent cache is `motif-cache-v2.sqlite` in its dataset
directory. It survives application restarts. Disk entries are currently retained
for the dataset lifetime; there is no automatic disk-size eviction. With the
application stopped, this derived cache can be removed to reclaim space; a later
Apply recreates it. Browser tile caches are bounded independently.

The alignment adapter allows 100 motifs, 500 characters per pattern, and source
blocks up to 50 million columns. Regex evaluation has a two-second timeout per
sequence/pattern. Preparation retains one sequence's work in memory. Failed or
cancelled jobs never publish partial results. Recent job handles are kept in
memory; after a backend restart or handle expiry, Apply restores them from the
persistent cache. Older synchronous motif endpoints remain for compatibility;
the explorer uses only the background pipeline.

## Verification and benchmark

`backend/tests/test_motif_engine.py` covers gap mapping, overlaps, exact and
overview colours, tile boundaries, cache reuse/invalidation, cancellation,
timeout atomicity and independent jobs. Frontend motif tests cover clipped
painting and stable, bounded viewport requests.

Run `python3 backend/scripts/benchmark_motifs.py --sequences 64 --columns 1000000`
for a dense synthetic ATG/GC workload. A local run over 64 million columns took
15.5 seconds cold and 0.017 seconds with prepared results cached; reading overview
runs for all 64 sequences took 0.044 seconds. These measure the engine on synthetic
data, not end-to-end browser latency or a guarantee for other alignments.
