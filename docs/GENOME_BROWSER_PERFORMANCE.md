# Genome browser performance review

## Changes

The primary genome reports its viewport through App, which re-renders the browser
view. Previously the view created a new biotype filter array and new callbacks
for every panel each time. The filter invalidated gene layout, which in turn
repainted every canvas, including unrelated genomes. Stable filter and callback
props plus React's ordinary shallow memoization now isolate unchanged panels.
No custom comparator ignores callback or data changes.

Canvas painting pauses when a panel is outside the viewport plus a 600px margin.
The margin is measured against the nearest `overflow-y: auto|scroll` ancestor
(the app's content area), not the window: `rootMargin` only grows the observer's
root, so against the window a nested scroll box clipped at its own edge and
panels woke only once they were already scrolling into view. Layout heights stay current,
so scrolling and cycling retain their geometry. Approaching the viewport paints
the latest state; screenshot export also explicitly paints before reading the
canvas. High-DPI resolution is unchanged. Browsers without IntersectionObserver
continue painting normally.

Transcript display rows are resolved once per gene for each cache/display-policy
generation instead of repeatedly for row packing, painting, hit testing and
footers. The cache is discarded when transcript data, expansion, ordering,
hidden rows or ghost previews change. Footer viewport observers now survive
horizontal pans instead of being torn down and rebuilt each time.

Off-screen linked panels no longer follow every frame. A panel that does not
paint still cost most of a visible panel's work to re-render and lay out each
frame. While pan-locked, a panel beyond the margin is held at its last position
and caught up at most every 200ms, so its data keeps loading along the way; it
goes back to live positions as soon as it is inside the margin. Zoom-only lock
stays live because it zooms each panel from that panel's last reported position.

App no longer re-renders on every frame. The browser's primary viewport is only
read by the Structural Variation view, which is unmounted while browsing, so it
is committed 150ms after the viewport settles. Clearing it is still immediate
and cancels a pending report.

Ruler and coordinate labels share one `Intl.NumberFormat` rather than calling
`toLocaleString`, which builds a formatter per call. The output is identical.

## Linked-panning crash

Continuous linked input reproduced React's `Maximum update depth exceeded` error.
The old layout effect synchronized a recipient's coordinates after committing
its previous viewport. Its data and focus effects then scheduled more updates,
while incoming linked frames kept the nested commit chain alive.

Changed linked commands now reconcile the panel's own state during a guarded
render, before committing effects. The guard compares all former synchronization
inputs; ordinary local moves do not reapply an old command. Existing chromosome
bounds and pan/zoom-lock rules are retained. Chromosome changes retire pending
requests through the existing cleanup; cached tiles remain keyed by chromosome.

Manual input also preserves the previous broadcast source until the next frame
establishes the new one, preventing stale linked positions from being sent back
to the active source. Empty focus notifications no longer schedule parent updates
on every pan. Comparing positions now treats two absent zoom anchors as equal,
rather than comparing `NaN === NaN` and spuriously publishing unchanged positions.

## Measurements

Measured on the development laptop in headless Chromium, a 1400×900 viewport,
DPR 1, using 1,500 synthetic genes per genome and eight transcripts per gene.
Both linked and independent paths were warmed before each 90-frame measurement.
The same alternating horizontal wheel gesture was used before and after.
These are development-mode synthetic measurements, not a guarantee for every
track mix or device. No data requests occurred during the measured warm runs.

95th-percentile frame interval in milliseconds (lower is better):

| Genomes | Independent, before | Independent, after | Linked, before | Linked, after |
| --- | ---: | ---: | ---: | ---: |
| 1 | 18.5 | 17.3 | 18.6 | 16.9 |
| 4 | 18.3 | 17.5 | 28.1 | 18.7 |
| 8 | 23.0 | 17.2 | 46.8 | 21.8 |
| 12 | 31.4 | 17.2 | 66.7 | 28.6 |

At 12 genomes, independent panning went from 1,170 canvas paints to 180 across
the measurement. Linked panning went from 3,150 to 1,106. Visible panels are not
frame-rate limited, and buffering distances and data detail are unchanged.
Off-screen panels still compute layout and fetch data, so sufficiently large
sessions can still be limited by those costs or backend I/O.

### Per-frame main-thread time

CPU busy time per frame for a linked pan, 12 genomes (about 6 of them on
screen), same fixture. Single runs, so treat ±0.5ms as noise:

| Build | Before | After |
| --- | ---: | ---: |
| Development | 13.9 | 9.9 |
| Development + StrictMode (as `main.jsx`) | 16.4 | 11.1 |
| Production | 9.6 | 7.1 |

The app runs from the Vite dev server under StrictMode, which renders and
memoizes twice, so it pays roughly 1.5× the production cost. Going from 8 to 12
genomes now adds almost nothing; the remaining cost scales with panels on screen.

## Repeatable browser regression check

Start the existing Vite development server, then run from the repository root:

```sh
CHROMIUM_PATH='/path/to/chrome-or-chromium' node frontend/scripts/benchmark-genome-browser.mjs
```

Set `GENOME_BENCHMARK_URL` if Vite uses another origin. Add `&strict` to a
fixture URL to render it under StrictMode like the app. The runner uses Node's
built-in WebSocket client and a temporary Chromium profile. Its fixture mocks
all API requests and never reads or changes the user's saved configuration,
files, notes or sessions. No browser automation dependency is added.

The runner reports timing separately from correctness assertions. It checks:

- Independent panning moves and paints only the affected panel.
- Linked pan/zoom, source switching, and zoom-only lock retain their behavior.
  Panels inside the wake margin must match within 100ms, all panels within 300ms.
- Off-screen linked panels retain coordinates and paint when scrolled into view.
- Two 450-frame linked-input stress runs switch among 12 genomes while panning,
  zooming and scrolling, with both delayed and immediately resolved responses.
- Off-screen export matches the subsequently visible canvas, including DPR 2.
- Inactive panels resume painting, and the observer-free fallback works.

The stress scenario reproduced the crash before the synchronization fix and
completed without browser errors afterward. The frontend unit suite and
production build are also part of validation; timing thresholds are deliberately
not assertions because CPU load and refresh rate vary.
