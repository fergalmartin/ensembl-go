# Find: pattern preparation and rendering

The interface calls this feature **Find**. Internal `motif` identifiers, storage
keys and `/motif-jobs` routes remain for compatibility with saved workspaces.

`frontend/src/utils/findPatterns.js` defines the shared pattern list, colours,
enabled switches and overlap priority. See **Finding something** in
[SEQUENCE_VIEW.md](SEQUENCE_VIEW.md) for the sequence-view integration.

In the alignment explorer, Find is its own control on the bar, next to Colour,
and works as the sequence view's does: the face opens a find box under the bar,
the chevron opens the saved list, and both are the sequence view's `FindBar`.
Submitting the box (or applying the list, which writes `[P1,P2]` into the box)
starts a preparation; nothing is searched while typing. A submit that changes
only colours reuses the prepared search, since the server's runs name patterns
by their place in the list, not by colour. While the box is open the alignment
is painted in find colours over a neutral sheet; closing it turns Find off and
Colour's own scheme comes back. Previous and next step between matching blocks
on the current sheet. Hiding unmatched blocks and the on-sheet key are toggles
on the box's own row. Cancelling preparation keeps the previous applied view;
remembered patterns remain available for another attempt.

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
adapter lives in `backend/alignment_explorer/motif_jobs.py`; one worker serialises
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
