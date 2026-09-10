# Alignment Explorer: chunks in layers

For architecture, verification history and remaining work, see the [engineering handoff](ALIGNMENT_EXPLORER_HANDOFF.md).

The Explorer is independent of MAFFT. Open it from the application toolbar, load a local alignment, or use **Open in Alignment Explorer** on a MAFFT result. All alignment rows are retained, including rows without an active genome.

## Explore and organise

- The initial panel is front-facing. Wheel controls reuse the configured Genome Browser scheme. Drag with **Pan**, hold Space while dragging, or use the arrow keys. Shift-wheel scrolls rows under the default scheme.
- Zoom from binned agreement to base patterns to nucleotide letters. Agreement compares canonical bases against the first row of each fragment; unknown bases and gaps do not count as comparable. At base resolution, colours and styling match the Genome Browser: A red, T green, C blue, G yellow/orange, with white centred letters. Unknown bases use grey. Gaps match the background with an outline and a light-grey dash; hatching marks unavailable coverage. Canonical summaries without a comparable reference remain coloured. This is observed alignment agreement, not an evolutionary constraint score.
- **Select** selects rows and columns. **Columns** selects all rows intersecting a horizontal interval. **Select by coordinates** provides a keyboard-accessible alternative with sequence search. UI columns are one-based, inclusive; storage uses zero-based, half-open intervals.
- Selection is one-shot: releasing a rectangle or column selection returns to the normal cursor while preserving its highlight. Drag highlighted cells onto a sidebar layer or **＋ New layer**. During the drag, the workspace dims and layer targets stay clear. Dropping elsewhere or pressing Escape cancels the drag without clearing the selection.
- Selection actions are also available in the sidebar’s **Selection** section. Name a new layer or select an existing one there, then **Move to layer**. Selected cells leave the working source layer. **Copy instead** retains them.
- **Original alignment** always exposes untouched source blocks, browsable as a horizontal strip. Placing cells from Original copies them into a working layer. Its optional **Highlight regions in other layers** overlay uses each layer's colour; hover a cell to see layer names. This overlay starts off.
- Drag a chunk header to position it. **Auto arrange** orders chunks by source block and column, aligns shared sequence rows, and spaces the panels. Layout coordinates never change source coordinates.
- Strings connect chunks of the same sequence identity. Midpoint labels count omitted **alignment columns**. Hover for ungapped-base counts. `↔` denotes overlapping columns, and `?` denotes different source blocks with no defined common column distance. Duplicate source copies stay distinct.
- Names appear at each sequence's spatially leftmost chunk. Click a name, sequence cell, or string to highlight that sequence's path across source blocks.
- Drag a working layer onto another. If source intervals overlap, choose **Combine overlapping chunks**, **Keep chunks separate**, or **Cancel**. Combining unions selected cells and row membership; it does not fill previously unselected cells.
- **Cycle layers** supports press-drag-preview-release, click-to-choose, and arrow keys. **3D layers** tilts the active alignment panel and exposes the stack; **Flat view** returns to exact classical presentation. Canvas fallback preserves editing when WebGL is unavailable.
- Undo/redo covers layer edits. Workspace files store fragment membership masks, positions, names, cameras and display settings. Local autosave restores the last layer workspace. Source files remain read-only.

Discontinuous MAF files retain separate source blocks. The block selector opens each block on Original; a block number field handles inventories larger than the first page. Alignment columns are local to each block, never concatenated into a false continuous alignment.

## Genomic annotations

**Genome links & annotations** accepts explicit links or TSV/JSON metadata. Rows with unambiguous assembly-qualified identifiers can link automatically. Species resemblance alone never places features.

Metadata fields: `source` (original header) or `id` (Explorer sequence ID), `genome_key`, `chrom`, `assembly`, and optional `label`. For unpositioned FASTA, `genomic_start` and `genomic_end` are one-based inclusive, with `strand` equal to `+` or `-`. Their span must match the ungapped sequence length. Existing MAF coordinates are preserved. Ensembl Go's saved FASTA/JSON pairs and MAFFT result features are recognised.

The annotation API calls the existing alignment feature mapper against locally indexed GFF3 transcripts and mirrors reverse-strand alignments correctly. Exon/CDS/UTR/splice/start/stop colours reuse the existing alignment legend. Missing links do not remove rows. Zoomed-out summary tiles defer genomic annotation detail; zoom in for features. Local GFF3 must already be available to the app's genome browser.

## Implementation and verification

The React workspace lives in `frontend/src/components/alignment-explorer/`; the API and disposable SQLite indexes live in `backend/alignment_explorer/`. Regional requests include only visible rows (plus the fixed comparison row), and client caching has a bounded entry count. The 3D panel uses a viewport-sized CanvasTexture, recreated on resize; it never allocates a chromosome-sized canvas.

Text inputs: MAF, aligned FASTA, XMFA, Stockholm, Clustal and PHYLIP, including gzip via a local path. HAL requires the external `ENSEMBL_HAL_HELPER`; no HAL binary is bundled by this change. TAF requires the optional Taffy Python runtime. Native-helper packaging and genome-scale performance benchmarks are not claimed by the layer reimplementation.

Run layer-model tests with `node --test frontend/tests/alignmentExplorer.test.js` and backend tests with `python3 -m unittest discover -s backend/tests -p test_alignment_explorer.py`. Browser acceptance covers rectangular extraction, a second connected region, exact bases, header movement, path highlighting, both overlap choices, undo, cycling and the Original overlay.

The alignment workspace now has a single compact toolbar: Pan, Select, Columns,
Auto arrange, Reset view, and Cycle. Loading, selection actions, display options, annotations,
and workspace export live in collapsible sidebar sections. The shared drawer
chevron collapses the sidebar to the left; dragging selected cells temporarily
reveals layer targets. Cycle uses the genome browser's rotating drum styling,
with actual regional alignment previews and a vertical layer rail. Press and drag
Cycle, or click it and use the rail, wheel, or arrow keys; Enter selects and Escape
cancels. Previews show the first visible rows, with bounded regional requests.

Zoom-out stops at the whole horizontal layer extent, with vertical scrolling
retained for larger row inventories. Reset view restores the first rows and whole
horizontal extent. Labels move with their blocks and use text halos rather than
opaque fixed-width panels. Block headings include both interval endpoints, and
connection strings use a thicker, higher-contrast stroke.


New datasets start with **Original alignment** alone. Working layers are created
explicitly; existing saved layers are preserved. The × beside a working layer
removes it, with Undo available and Original unchanged.

“Source blocks” are the input file's alignment blocks; “chunks” are the selected
pieces in working layers. New chunks are inserted in source order. Existing
vertical positions are preserved and obstructing successors shift horizontally.
Default spacing aims for approximately 110 pixels for distance labels when fitted
(with denser overviews when many chunks share a viewport). Auto arrange is in the
top toolbar and aligns shared row identities.

Each fully visible header has a clipboard icon to copy aligned FASTA (up to two
million cells). Source gaps remain `-`; unselected or unavailable cells are `N`.
Headers include stable sequence IDs, original source identifiers, source block,
and column range. Original source blocks also have a **＋** header action to make
a new layer containing that entire block. Block numbers remain above coordinate
ranges even for narrow chunks.

Original browsing uses a stable, indexed horizontal layout across the complete dataset. Pan across boundaries or jump directly to a block. The camera never waits for regional requests or resets to a previously loaded block. Coordinates remain local to each source block.

The default **Align across source blocks** setting gives every sequence identity a consistent row and draws blank-row guides for absent sequences. **Collapse absent rows** compresses each source block independently. A row icon on readable source-block headers overrides this setting for that block. Original uses a fixed left name gutter; compact mode labels the block nearest the left edge. Working chunks retain their leftmost path names.

Dense views suppress overlapping controls and unselected strings. At whole-file scales, bounded groups of source blocks show **sequence presence** (filled width is the fraction of blocks containing that sequence), explicitly distinct from conservation. Sparse headers identify block ranges; click a header to zoom into that range. All sequence identities remain accessible by vertical scrolling.

Regional detail and summary requests use independent bounded queues and caches. Navigation replaces queued work without continually cancelling in-flight requests; each completed tile renders independently. Wider summary tiles warm in the background and cached bases are binned immediately at coarse scales, avoiding subpixel base stripes while summaries arrive. Failed requests do not block other blocks; **Retry loading** restarts them.

Verification on the local `10_primates.epo.1_1.maf.gz` index (200 blocks, 1,363 sequence IDs, 43 million total block columns): late-block layout API requests took 2–7 ms, whole-file layout 11–18 ms, block 180 summaries 96–100 ms, and block 4 summaries 61–64 ms over three local requests. These are API timings, not frame-rate or full desktop performance guarantees. Browser checks cover late-block zoom, whole-file overview, and row compaction. The source gzip remains unchanged.
