# Alignment Explorer: chunks in layers

For architecture, verification history and remaining work, see the [engineering handoff](ALIGNMENT_EXPLORER_HANDOFF.md).

The Explorer is independent of MAFFT. Open it from the application toolbar, load a local alignment, or use **Open in Alignment Explorer** on a MAFFT result. All alignment rows are retained, including rows without an active genome.

## Explore and organise

- The initial panel is front-facing. Wheel controls reuse the configured Genome Browser scheme. Drag with **Pan**, hold Space while dragging, or use the arrow keys. Shift-wheel scrolls rows under the default scheme. In Original, a wheel over the name gutter scrolls the row list, but only while that list is taller than the window; anywhere else near the left edge the wheel zooms as it does over the sequence.
- Zoom from binned agreement to base patterns to nucleotide letters. Agreement compares canonical bases against the first row of each fragment; unknown bases and gaps do not count as comparable. At base resolution, colours and styling match the Genome Browser: A red, T green, C blue, G yellow/orange, with white centred letters. Unknown bases use grey. A gap is drawn as the page with a blue outline around the whole run and a blue dash in each column once columns are wide enough to carry one - the same blue the Feature Explorer outlines unannotated genomic sequence in, since a gap is the same kind of statement. Hatching marks unavailable coverage, which is a different thing again: nothing is known there, rather than nothing being there. Canonical summaries without a comparable reference remain coloured. This is observed alignment agreement, not an evolutionary constraint score.
- The control bar carries one button per decision, each titled with that decision and carrying an arrow to the settings behind it: **Select**, **Zoom** and **Colour**. The titles do not change with the mode - a label that rewrote itself made the bar shuffle and read as a different control appearing. The main half of each does the obvious thing: Select turns the tool on with whichever kind was last used, Zoom switches between the two zooms, Colour moves to the next scheme. Those last two say what they landed on in a word that appears above the button and fades, since neither button carries its own mode. The arrow is where the alternatives, their explanations and everything else live. Escape or a press anywhere else closes an open menu.
- **Colour** opens on a tab per scheme, and the tab is the choice: moving to it recolours the sheet. Each tab carries what belongs to that scheme - what its colours mean, the palettes it can be drawn in, and its key. Four palettes per scheme, shown as themselves and not named, since a swatch is the thing itself where a name is a word about it: four sets of base colours, and four ramps for the two column schemes - one of them a single hue, which survives greyscale and printing. Every palette has a light and a dark form, and each ramp gains contrast against its own page as the quantity rises. The choice is kept per scheme and saved with the workspace.
- The key can also sit on the alignment itself. It is off unless asked for - the key is always in the Colour menu, and the window is for the alignment - and **Show this key on the alignment** turns it on. Reaching for an overlaid key puts a **×** on it that turns it off again. It is the same key either way.
- **Colour** chooses what a cell's colour means, over three schemes: **Bases**, **Conservation** and **Presence**. Bases carries a second choice, **shading**, for what stands in for the sequence once a column is too narrow to be a base. *Relative* is what this view has always done - agreement with each block's comparison row. *Uniform* fills every block with one flat colour instead: where the sequence is, and nothing about what it says, which leaves shape, links, picks and annotations as the only things on the sheet. Either way the sequence itself is still drawn as soon as the bases are big enough to see, and each row's own gaps show at both sizes. **Conservation** and **Presence** colour by the column rather than by the base, over a *cohort*: the sequences the blocks on the sheet hold, narrowing to whatever is picked. Conservation carries two quantities on channels that cannot be confused. Colour is **agreement** between the sequences actually present, running blue for little through purple to red for a lot; the default ramp avoids green so it stays readable with red-green colour blindness. Bar height is **representation**, the share of the cohort that is there at all: a block holding three of ten sequences draws a thin bar however perfectly those three agree, and picking just those three redraws it full height - the same sequences, a different question. Agreement is built only from columns where two or more canonical bases met, and counts are summed before they are divided, never averaged as fractions. The ramp is fitted to the range of identity actually loaded and the legend prints that range, because real alignments occupy a narrow band of it: over a 44-mammal block, per-bin identity runs from about 86% to 100%, and a fixed nought-to-one ramp paints all of that one colour. This is observed column identity among the sequences in view, not an evolutionary constraint score.
- Opening an alignment shows its progress in a dialog of its own, with the proportion of the file read where the reader knows the file's size, a running count of blocks or sequences, and a cancel button. Indexing a large alignment takes minutes; the file chooser closes as soon as the import is accepted.
- **Select** draws a rectangle over the cells it should cover. **Columns**, behind the same button's arrow, takes every row a horizontal interval crosses instead. Which of the two the button offers is the one last used, because a completed selection puts the mode back to Pan and the alternative is one press away either way. The menu also says how much is picked and can clear it. **Select by coordinates**, in the sidebar, is the keyboard-accessible alternative with sequence search. UI columns are one-based, inclusive; storage uses zero-based, half-open intervals.
- **Select** and **Columns** work over the sequence names as well as over the sequence. A rectangle drawn entirely within the names picks those sequences, exactly as clicking each name would, and in Columns mode touching the names takes every name on screen, since the names are one column. Every name the box covers is taken, including sequences the open block does not hold: those have no cells to pick, so the name itself is lit instead, and picking them out of the list is the same act whichever block happens to be on screen. Carry the drag on past the names into the alignment and it is an ordinary region selection again. Only **Pan** takes hold of what is under the press - a name to reorder, a block header to pick or move, a connector or jump marker to drag. With Select or Columns armed, a press anywhere starts the rectangle instead, which is what those modes are for. And nothing behind the Original's name gutter can be pressed at all: the gutter is painted over the blocks, so a press there used to find the header of a block whose drawn header was far off to the right, and no rectangle was drawn.
- Everything picked is marked in one gold, whether it was picked by its name, by its block header, or as a region drawn with Select or Columns - they are the same act, and the region used to be told apart in teal as though it were not. A region carries a gold wash inside its edge, which is what still separates a picked stretch of a row from a row that is merely lit. The rectangle being dragged is the same gold, dashed. Each edge is drawn over a dark line, because gold alone disappears into the warm half of the base palette. The provenance overlay on the Original keeps each layer's own colour, since the colour is what says which layer, but is drawn with the same weight and the same dark backing.
- Pointing at a picked region puts a **×** on its top-right corner, which drops that region from the selection. Regions accumulate as you pick them and a drag over one starts moving it rather than unpicking it, so this is the way to take a single region back out without clearing everything. It appears on regions drawn with Select or Columns or entered by coordinates, on the Original alignment as well as in a layer, since dropping a pick changes nothing but what is picked. A picked name or block header is still dropped by clicking it again.
- In a working layer, the **×** in a block header takes that chunk back out, and the **×** beside a picked sequence name takes that sequence out of every chunk in the layer. A chunk left holding no sequences goes with it, freed row lanes close up, and the connecting strings are rebuilt: removing a chunk from the middle of a path rejoins the chunks either side rather than leaving a loose end. Both are ordinary edits, so Undo puts them back. Neither appears on the Original alignment, which is a derived view of the source with nothing in it that was put there - use **Hide** to set blocks or sequences aside there instead.
- Moving picked sequences into a layer gives one chunk per source block, carrying the rows picked from it, laid out left to right on one row per sequence — the shape the alignment itself has.
- Selection is one-shot: releasing a rectangle or column selection returns to the normal cursor while preserving its highlight. Drag highlighted cells onto a sidebar layer or **＋ New layer**. During the drag, the workspace dims and layer targets stay clear. Dropping elsewhere or pressing Escape cancels the drag without clearing the selection.
- Selection actions are also available in the sidebar’s **Selection** section. Name a new layer or select an existing one there, then **Move to layer**. Selected cells leave the working source layer. **Copy instead** retains them.
- **Original alignment** always exposes untouched source blocks, browsable as a horizontal strip. Placing cells from Original copies them into a working layer. Its optional **Highlight regions in other layers** overlay uses each layer's colour; hover a cell to see layer names. This overlay starts off.
- Drag a chunk header to position it. **Auto arrange** orders chunks by source block and column, aligns shared sequence rows, and spaces the panels. Layout coordinates never change source coordinates.
- Strings connect chunks of the same sequence identity. Midpoint labels count omitted **alignment columns**. Hover for ungapped-base counts. `↔` denotes overlapping columns, and `?` denotes different source blocks with no defined common column distance. Duplicate source copies stay distinct.
- Names appear at each sequence's spatially leftmost chunk. Click a name, sequence cell, or string to highlight that sequence's path across source blocks.
  Highlights add up: lighting a second and a third sequence leaves the first lit. Clicking a lit sequence puts it out, by its name or by one of its cells — whichever way it was lit. Clear selection puts them all out.
- Drag a working layer onto another. If source intervals overlap, choose **Combine overlapping chunks**, **Keep chunks separate**, or **Cancel**. Combining unions selected cells and row membership; it does not fill previously unselected cells.
- **Cycle layers** supports press-drag-preview-release, click-to-choose, and arrow keys. Canvas fallback preserves editing when WebGL is unavailable.
- Undo/redo covers layer edits. Workspace files store fragment membership masks, positions, names, cameras and display settings. Local autosave restores the last layer workspace. Source files remain read-only.

Discontinuous MAF files retain separate source blocks. The control bar's block field opens each block on Original. Alignment columns are local to each block, never concatenated into a false continuous alignment.

## Genomic annotations

**Link local genomes** accepts explicit links or TSV/JSON metadata. Rows with unambiguous assembly-qualified identifiers can link automatically. Species resemblance alone never places features.

Metadata fields: `source` (original header) or `id` (Explorer sequence ID), `genome_key`, `chrom`, `assembly`, and optional `label`. For unpositioned FASTA, `genomic_start` and `genomic_end` are one-based inclusive, with `strand` equal to `+` or `-`. Their span must match the ungapped sequence length. Existing MAF coordinates are preserved. Ensembl Go's saved FASTA/JSON pairs and MAFFT result features are recognised.

The annotation API calls the existing alignment feature mapper against locally indexed GFF3 transcripts and mirrors reverse-strand alignments correctly. Exon/CDS/UTR/splice/start/stop colours reuse the existing alignment legend. Missing links do not remove rows. Zoomed-out summary tiles defer genomic annotation detail; zoom in for features. Local GFF3 must already be available to the app's genome browser.

## Implementation and verification

The React workspace lives in `frontend/src/components/alignment-explorer/`; the API and disposable SQLite indexes live in `backend/alignment_explorer/`. Regional requests include only visible rows (plus the fixed comparison row), and client caching has a bounded entry count. The 3D panel uses a viewport-sized CanvasTexture, recreated on resize; it never allocates a chromosome-sized canvas.

Text inputs: MAF, aligned FASTA, XMFA, Stockholm, Clustal and PHYLIP, including gzip via a local path. HAL requires the external `ENSEMBL_HAL_HELPER`; no HAL binary is bundled by this change. TAF requires the optional Taffy Python runtime. Native-helper packaging and genome-scale performance benchmarks are not claimed by the layer reimplementation.

Run layer-model tests with `node --test frontend/tests/alignmentExplorer.test.js` and backend tests with `python3 -m unittest discover -s backend/tests -p test_alignment_explorer.py`. Browser acceptance covers rectangular extraction, a second connected region, exact bases, header movement, path highlighting, both overlap choices, undo, cycling and the Original overlay.

The alignment workspace now has a single compact toolbar: block navigation
stacked over Auto arrange, then Pan, Select, Columns, zoom mode, the filter
flag, and Cycle.

Block navigation is not Original's alone. In a layer the same field and arrows
walk the blocks that layer actually holds - neither contiguous nor complete -
so typing a block number in the layer jumps to it and the arrows step between
them; a number that is not on the sheet says so rather than moving. Which block
the window is over is decided differently in the two: Original's blocks run
along one line, so the nearest one sideways is the one being read, while a
layer's chunks are placed in two dimensions and `layerViewAnchor` measures from
the middle of the view in both axes. A block that has been cut into several
chunks is framed as a whole.

Every control is as wide as its own longest value and no wider, and they share
out whatever width is left over, so the bar fills its space without a pool of
dead room at one end. None of them may shrink below that natural width: when the
window is too narrow for all of them the bar scrolls sideways instead of
wrapping, since a second row pushed the alignment down and put half the controls
below the fold. Because the platform's overlay scrollbar only appears once a
scroll is already under way, the edge with controls behind it is faded and
carries the same chevron the block navigator uses. Cycle stays last: its wheel
opens on a rail centred under the button, which needs the room to the right.

The **Select** and **Zoom** menus have no Apply. Each offers one choice among a
handful, so picking one takes effect where the pick was made and closes the
menu; Close is there for a menu opened to look rather than to change. **Colour**
keeps Apply, being several settings edited together, one of which starts a motif
search. Block navigation and Auto arrange share one control's height because they
are never both live — Auto arrange is dead in Original, the only place the block
navigator appears — and side by side they were what pushed the bar to a second
row. Cycle carries its name alone rather than the active layer's, as in the
genome browser; the layer is named in the sidebar and in the button's tooltip. The flag
switches the filter on and off; the filter itself is kept until it is explicitly
cleared. Neither switch carries its counts in the bar — a wide one pushed Cycle
off the end and left the bar needing a sideways scroll to reach its own buttons.
What is being held back is a line under the totals on the **Original alignment**
card (`Showing 56 of 140 blocks · 2 of 32 sequences`), and each switch repeats it
in its tooltip. **Hide** is a split control, and which half is pressed decides
what happens. Off, either half opens the menu, since there is nothing yet to
switch. On, the face is the way off - the press lands on the word saying it is
on, rather than a menu away from it - and the arrow opens the menu to change
what is hidden. On, it also wears the same accent Filter does, so a narrowed
sheet says so from the bar rather than only from the sidebar's counts.

The menu behind it: *What* hides
blocks, sequences or both, and *Condition* combines the picks where blocks are
being hidden — *Or* keeps the blocks picked out and every block the picked
sequences run through, *And* keeps only blocks holding everything picked, among
the picked blocks where any were picked. Hidden blocks are packed together and
still carry their own block numbers, with the survivors linked by ordinary
connection strings however far apart they were in the file — but only where they
end up side by side: a sequence that skips a block still on screen keeps its jump
markers, since a string drawn across that block would read as a sequence running
through it. Hiding sequences
takes the blocks they leave empty with them, so no bare headers are left standing
between the blocks that still hold something. *Previous* repeats the last hide from the picks it used.
**Show** brings everything back. If nothing satisfies the conditions, nothing is
hidden and the view says so.

Hide belongs to the sheet being read, not to the alignment. The filter is the
narrowing of the alignment behind every view; Hide is the quick way to read one
sheet down to what has been picked out on it, and each layer keeps its own,
Original keeps its own, and Show everything puts back only the one in front of
you. A hide applied in a layer therefore stays in that layer and does not move
the view - it used to force `original:true` and drop the reader onto Original's
whole-file sheet, having resolved their picks against Original's fragments,
where a pick made in a layer matched no fragment at all and so contributed
nothing.

The two sheets answer a hide differently because they are different kinds of
thing. Original asks the server which blocks hold the picked sequences, since a
sequence runs the length of the file and most of its blocks are not loaded, then
fetches the survivors' layout and packs them shoulder to shoulder: its
arrangement is the file's. A layer answers from its own chunks, which are the
whole truth about which of its blocks carry which sequences, and moves nothing -
its arrangement is the reader's work. Chunks that go are simply not drawn, rows
keep their slots so the rows shared across chunks still line up, and Auto
arrange is there when the gaps want closing.

*Rows*, offered in a layer wherever sequences are being hidden, decides where
the survivors sit. **Compact**, the default, gives them one line each in the
layer's row order - the same numbering `tidyLayer` gives a whole layer - so they
rise to the top of every chunk while a sequence shared by two chunks stays on
one line across both. Renumbering each chunk on its own would also close the
gaps, but it would put that shared sequence on a different line in each chunk,
and those lines are what the connection strings are drawn along. **Keep
positions** leaves every survivor where it was, gap above it and all, for a
layer whose vertical arrangement means something. Original does not offer it:
its row placement is recomputed from the narrowed set anyway, and the sidebar's
*Sequence rows* already says how. Loading,
selection actions, display options and workspace export live in collapsible
sidebar sections, under a header row carrying the Layers title, ＋ and the drawer
chevron that collapses the sidebar to the left; dragging selected cells
temporarily reveals layer targets. Cycle uses the genome browser's rotating
drum styling, with actual regional alignment previews and a vertical layer rail. Press and drag
Cycle, or click it and use the rail, wheel, or arrow keys; Enter selects and Escape
cancels. Previews show the first visible rows, with bounded regional requests.

Zoom-out stops at the whole horizontal layer extent, with vertical scrolling
retained for larger row inventories. Labels move with their blocks and use text
halos rather than opaque fixed-width panels. Block headings include both interval endpoints, and
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
