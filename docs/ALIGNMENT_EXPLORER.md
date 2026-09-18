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
- **Cursor** is one control for what the pointer does, with three choices behind its arrow: **Move view** drags the sheet, **Free select** draws a rectangle over the cells it should cover, and **Columns** takes every row a horizontal interval crosses instead. Move view and Select were two buttons, which cost two slots in the bar to express a single choice among three and still did not say they were alternatives. The face switches between moving and selecting and shows which is in hand; the shape last used is remembered, because a completed selection puts the cursor back to Move view and the reader should come back to the shape they chose rather than to a default. The menu also says how much is picked and can clear it. UI columns are one-based, inclusive; storage uses zero-based, half-open intervals.
- **Select** and **Columns** work over the sequence names as well as over the sequence. A rectangle drawn entirely within the names picks those sequences, exactly as clicking each name would, and in Columns mode touching the names takes every name on screen, since the names are one column. Every name the box covers is taken, including sequences the open block does not hold: those have no cells to pick, so the name itself is lit instead, and picking them out of the list is the same act whichever block happens to be on screen. Carry the drag on past the names into the alignment and it is an ordinary region selection again. Only **Pan** takes hold of what is under the press - a name to reorder, a block header to pick or move, a connector or jump marker to drag. With Select or Columns armed, a press anywhere starts the rectangle instead, which is what those modes are for. And nothing behind the Original's name gutter can be pressed at all: the gutter is painted over the blocks, so a press there used to find the header of a block whose drawn header was far off to the right, and no rectangle was drawn.
- Everything picked is marked in one gold, whether it was picked by its name, by its block header, or as a region drawn with Select or Columns - they are the same act, and the region used to be told apart in teal as though it were not. A region carries a gold wash inside its edge, which is what still separates a picked stretch of a row from a row that is merely lit. The rectangle being dragged is the same gold, dashed. Each edge is drawn over a dark line, because gold alone disappears into the warm half of the base palette. The provenance overlay on the Original keeps each layer's own colour, since the colour is what says which layer, but is drawn with the same weight and the same dark backing.
- Pointing at a picked region puts a **×** on its top-right corner, which drops that region from the selection. Regions accumulate as you pick them and a drag over one starts moving it rather than unpicking it, so this is the way to take a single region back out without clearing everything. It appears on regions drawn with Select or Columns or entered by coordinates, on the Original alignment as well as in a layer, since dropping a pick changes nothing but what is picked. A picked name or block header is still dropped by clicking it again.
- In a working layer, the **×** in a block header takes that chunk back out, and the **×** beside a picked sequence name takes that sequence out of every chunk in the layer. A chunk left holding no sequences goes with it, freed row lanes close up, and the connecting strings are rebuilt: removing a chunk from the middle of a path rejoins the chunks either side rather than leaving a loose end. Both are ordinary edits, so Undo puts them back. Neither appears on the Original alignment, which is a derived view of the source with nothing in it that was put there - use **Hide** to set blocks or sequences aside there instead.
- Moving sequences picked by name into a layer resolves their complete file-wide path, not just the source blocks currently loaded in the Original viewport. It gives one chunk per source block, carrying the rows picked from it, laid out left to right on one row per sequence — the shape the alignment itself has. Rectangular and column picks still move only the exact regions drawn.
- Selection is one-shot: releasing a rectangle or column selection returns to the normal cursor while preserving its highlight. Drag highlighted cells onto a sidebar layer or **＋ New layer**. During the drag, the workspace dims and layer targets stay clear. Dropping elsewhere or pressing Escape cancels the drag without clearing the selection.
- A drop always copies. The layer the cells came from keeps them, whether that is Original or another working layer, because a layer is a way of looking at the alignment rather than a box the cells are kept in: taking a set of sequences into a layer of their own used to leave the layer behind them holding the blank lane those rows had filled. Taking something out of a layer is its own act — the **×** in a chunk header, or the **×** beside a sequence name.
- A new layer is named one past the highest number already in use, not by counting the layers. Counting landed on a name the sidebar already carried as soon as a layer was deleted or one arrived named for what made it — `Filtered 2`, `Block 12` — so two layers answered to `Layer 5` and the numbers stopped climbing. The name is read off the layers at the moment of the drop, so a drop made after an undo is named against the list as it then stands.
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

**Link local genomes** accepts a strict, portable TSV/JSON mapping. Rows with unambiguous assembly-qualified identifiers can link automatically. Species resemblance alone never places features. The import dialog reports links already in the top bar, links to other locally available genomes (which can be added there), assemblies that are not downloaded, and source identifiers that did not resolve.

The required fields are `source` (the original alignment header), `assembly` (the assembly accession and sole genome identity), and `region`. Optional fields are `strand`, `assembly_name`, and `label`; JSON requests made by the Explorer may use its internal sequence `id` instead of `source`. `region` accepts either a region name such as `1` or a one-based interval such as `1:10,000-50,000`. A bare region places a sequence-only alignment from base 1. For an explicit interval, the supplied start is authoritative and the effective end is derived from the ungapped sequence length; the import report warns if that differs from the declared end. `strand` accepts `+`, `-`, `1`, or `-1` and defaults to `+`. Existing coordinate-aware MAF placement and strand are preserved.

The annotation API calls the existing alignment feature mapper against locally indexed GFF3 transcripts and mirrors reverse-strand alignments correctly. Exon/CDS/UTR/splice/start/stop colours reuse the existing alignment legend. Missing links do not remove rows. Zoomed-out summary tiles defer genomic annotation detail; zoom in for features. Local GFF3 must already be available to the app's genome browser.

In Original and working layers, a block header gains the Genome Browser button when the block contains a highlighted sequence linked to a genome in the top bar with local GFF3 data, or when a selected subregion crosses one of those sequences. A highlighted sequence opens its whole present span in that block; a subregion opens only the selected, non-gap alignment cells. The button projects those cells back to their strand-aware genomic intervals, opens every represented genome at its interval as a location focus, and leaves the other top-bar genomes inactive. Location focus keeps these regions distinct from genes and frames each region in the space left by its primary location drawer; opening secondary detail or notes panes does not move the genomic view. The first implementation opens one region per assembly; if a selection spans more than one region of the same assembly, it opens the region containing the most selected bases and reports that choice.

## Block context

The [implementation review](ALIGNMENT_BLOCK_CONTEXT_REVIEW.md) records the corrective pass, verification and remaining work, including shared-gap folding.

**Block context** opens one source block on its own, with each genome's gene models drawn under its own sequence. It is on every block header and on every working chunk, and it is a lens rather than an edit: nothing it does reaches the workspace, and closing it puts back the layer, camera, selection and row order it was opened from. Escape closes it. Entering from a chunk opens the complete source block and frames the chunk's interval, because reading a gene against the alignment means reading it against the alignment the block actually has.

All the block's rows appear, in the order the sheet has them. Rows picked individually — by name, by highlight, or as a region — narrow it to those, and the bar says `3 of 17 rows` with **Show all rows** beside it; picking the block itself is not a narrowing, since a block pick carries every row by construction. Duplicate copies of one source stay separate rows. Rows can be reordered and taken out of the view locally; layer editing and transfer are stood down for the duration.

Three separate things, which are easy to confuse and are kept apart here: the **reference** is what everything is compared against, the **order** is where the rows sit, and the **pair** is the two rows being inspected in detail. Changing any one leaves the other two alone — moving a row never changes what it is compared against, and choosing a new reference never rearranges the stack.

**Compare** offers **Reference** and **Adjacent rows**. **Inspect pair** selects the detailed comparison; **Show only this pair** reduces the stack without editing the underlying layer. Gene models and measured comparisons load when the visible window is at most 65,536 columns; wider views offer **Show annotation detail**. In reference mode the reference is pinned above the scrolling stack, since scrolling to a target whose reference has gone off the top compares it with nothing visible; in adjacent mode there is nothing to pin and the whole stack scrolls. The reference starts as the top row, falls back to the first row with alignment coverage and says so when it does, and may be a sequence with no genome link at all — an inferred ancestral row is a reference like any other. A block where no row has coverage is shown without directional comparisons.

Each row carries its sequence, a compact transcript track and a labelled comparison band. The track shows one representative transcript per overlapping gene — canonical where the annotation says so, otherwise the first by position and labelled *representative* rather than passed off as canonical — and a gene can be expanded to inspect its other isoforms, a page at a time. Exons, CDS and UTR keep the browser's own conventions: coding filled, UTR hollow. A feature is drawn as the columns its bases actually occupy, with the gaps inside it left as gaps, because filling them would paint another row's insertion as exon. A feature running past the block or past the loaded window is marked at that edge rather than drawn as though it ended there.

Selecting the reference's transcript paints its features on its own sequence and draws faint outlined **reference guides** over the same alignment columns on the other rows. The guide is the reference's feature, projected; it is never the target's annotation, and the target's own models stay solid and separately identifiable. In adjacent mode guides appear only on the active pair. Selecting a target's transcript changes nothing about the reference, and no relationship between two transcripts is inferred from matching names, exon numbers or overlapping columns.

An empty track always says which kind of nothing it is: no genome link for the sequence, an assembly that is not installed, a genome without annotation, a region the installed genome does not have, an annotation that could not be read, or no annotated feature over these columns. None of them means the genome has no gene there.

### What is measured, and what is not

The comparison band reports observations, in one direction, and stops there. It distinguishes substituted columns, gap columns in the row, gap columns in the comparison row, unknown bases and absent coverage; agreement is left blank, so what is drawn is what differs. Columns gapped in both rows are excluded from every count — they belong to the other rows in the block and say nothing about this pair — and neither unknown sequence nor absent coverage is ever counted as difference, because not knowing is not the same as differing.

There is no insertion and no deletion here. Which of those a column would be depends on a history neither row records, so what is said instead is that one row has a base where the other has a gap, and which row is which: *“12 target gap columns opposite reference CDS bases”*, never *“12 bp deletion”*. Selecting a feature opens a table comparing the loaded rows against that feature’s own row, and maps the active pair into genomic context. A feature clipped by the loaded window is labelled partial. Picking a row in the table makes the feature’s row the reference and activates that comparison. A feature’s genomic length is reported separately from its alignment-column span. Boundary-offset measurements are not yet implemented. A target gapped over every column of a reference exon is said to be exactly that — it is not a search of that genome, and it is not exon loss. Relative orientation between two rows is reported as the fact the rows carry; a single reversed block is not called a resolved inversion, which would need surrounding alignment structure MAF records separately.

### Genomic context

**Genomic context** opens a panel below the sheet showing the active pair — or one row where there is no pair — at their own genomic coordinates. This is where an exon's real length becomes visible: above, a short exon can occupy as many shared columns as a long one, because columns are what the alignment made of them. Both tracks are drawn to one bases-per-pixel scale so they are comparable, and each is centred on its own selection, so two unequal genomic spans stay visibly unequal. Each track follows its alignment row's direction, with coordinates that count down on a reverse-aligned row and a strand arrow per gene model, since a transcript's strand is a separate matter from the row's. The part of the window the block covers is outlined; the sequence either side is shaded as outside this block's alignment — real sequence with no alignment behind it, not sequence the alignment found nothing in. Context runs from none to 100 kb either side. **Fit block** resets the genomic panel to the block spans. Clicking a genomic track recentres it independently; reverse selection back into the alignment and genomic sequence letters are not yet implemented. **Open Genome Browser** opens the current genomic windows for linked top-bar genomes.

## Implementation and verification

The React workspace lives in `frontend/src/components/alignment-explorer/`; the API and disposable SQLite indexes live in `backend/alignment_explorer/`. Regional requests include only visible rows (plus the fixed comparison row), and client caching has a bounded entry count. The 3D panel uses a viewport-sized CanvasTexture, recreated on resize; it never allocates a chromosome-sized canvas.

Text inputs: MAF, aligned FASTA, XMFA, Stockholm, Clustal and PHYLIP, including gzip via a local path. HAL requires the external `ENSEMBL_HAL_HELPER`; no HAL binary is bundled by this change. TAF requires the optional Taffy Python runtime. Native-helper packaging and genome-scale performance benchmarks are not claimed by the layer reimplementation.

Run layer-model tests with `node --test frontend/tests/alignmentExplorer.test.js`, block-context model tests with `node --test frontend/tests/alignmentBlockContext.test.js`, and backend tests with `python3 -m unittest discover -s backend/tests -p 'test_alignment*.py'` (the FastAPI test client needs `httpx`, which is not in `backend/requirements.txt`; the projection and comparison tests run without it). Browser acceptance covers rectangular extraction, a second connected region, exact bases, header movement, path highlighting, both overlap choices, undo, cycling and the Original overlay.

The alignment workspace now has a single compact toolbar: block navigation
stacked over Arrange, then the cursor mode, zoom mode, colour, the filter
flag, Hide, Gaps and Cycle.

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

Hide is about the reader's picks and nothing else: it takes away what is not
among them, and until something is picked there is nothing for it to do. Closing
up gap-only columns used to sit in the same menu, and the two could not share
one Apply - Hide's is gated on there being picks, so the gap settings needed a
selection that had nothing to do with them, and pressing Apply without one did
nothing at all. They are two controls now. The menu behind Hide: *What* hides
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

**Gaps** is a control of its own, beside Hide, and is the one narrowing that is
about columns rather than about blocks and sequences. Its face is the switch,
the way the cursor's is, so hiding gaps is one press and never depends
on anything being picked. The menu behind the chevron asks the whole question:
*Show gap-only columns* or *Hide gap-only columns*, and, where they are hidden,
how. It used to hold only the how, which left a reader who had opened it to turn
gaps off with no way to do it from where they were standing — the only way back
was a button they had no reason to read as a switch — and it gated Apply on
settings they had not come to change. The choice is part of the draft, so Apply
lights up for it like any other change and publishes both halves in one commit,
which is one step for Undo. With *Show* chosen the settings below are greyed and
out of the tab order: they describe how gaps are hidden, and lighting Apply up
for a change it would not publish is worse than not offering it. A column
every sequence on screen is a gap in says nothing to the reader looking at them:
it is usually an insertion carried by a sequence they have just hidden or
filtered away. Switched on, runs of such columns are drawn out of the panel and
the header names how many columns it is not drawing
(`1–140 · 20 columns collapsed`), dropping that note before the range itself
when the header narrows - a bare signed number in its place was a quantity with
no unit and no verb beside a range it looked like part of. Two settings sit on one line in its menu. *Show gap boundaries*, on by default, draws a hairline where each
collapsed stretch was - a hairline, and none in the header, because a real
alignment read down to a few sequences collapses in thousands of short runs and
a heavier mark turns the block into a barcode; marks closer together than they
are wide are drawn as one, with the header's count carrying the total.
*Shortest run* keeps runs below it; it is what to raise for a sheet where a scatter of
single empty columns would be a scatter of marks. The threshold defaults to one, because a column nobody has a base in is
uninformative whether it stands alone or in a run of a thousand, and it is typed
rather than stepped - a column count is not something to walk to one column at a
time.

Above those sits the question of *which* columns, on a slider: **gap in at least
N% of the sequences**, from 5% to 100% in steps of five. A hundred is the
default and the answer the control gave for its whole life before the slider
existed - every sequence on screen is a gap there, so the column carries no
sequence at all and nothing that was ever drawn stops being drawn. Below a
hundred it is a different kind of statement, and the menu says so plainly: a
hidden column still holds bases, and those bases go out of the drawing. That is
a perfectly reasonable thing to ask an alignment for - a column where forty of
forty-four mammals have nothing is mostly an insertion in a handful of them -
which is why it is asked for rather than assumed.

The share is of the sequences **each block actually holds**, not of the cohort
the reader sent: a sequence the block does not carry has no gap there and no
base there either, so letting its absence count towards a threshold would let a
block's non-members decide what its members are allowed to see. It is met in
whole sequences, rounded up, so half of five sequences is three - one and a half
of them is not a thing a column can be - and the menu says what the slider works
out to for the sheet in front of the reader (`50% · 8 of the 16 on screen`)
rather than leaving them to do the arithmetic. At 100% the rounding lands on
every row, which is the intersection the all-gap answer already gives, so the
two agree where they meet.

Both thresholds are part of the question and so part of the cache key: the same
cohort at two shares has two answers, and a key that left the share out would
serve one the other's.

The two shares are answered by two different algorithms, because they are two
different problems. At 100% the answer is the intersection of the rows' gap
runs, folded a row at a time and abandoned the moment nothing is left — which is
most of the work saved on the sheets where nothing is closable at all, and those
are the common ones. Below 100% there is no such early answer, since a column
can still cross the threshold after any number of rows that have a base there,
so every row is counted into a difference array four bytes a column wide and the
runs are read off one running sum. Collecting the ends of every gap run and
sorting them instead is quicker on a wide window that is barely gapped, and far
worse where it matters: a heavily fragmented block of half a million columns
produced millions of entries to sort and over a hundred megabytes to hold them,
where the tally holds two megabytes and answers in a quarter of a second.

Everything in the menu is a draft until its **Apply**, which lights up as soon as
any of it differs from what is applied. Checking a large cohort is not instant, and
after a second or so of it a bar appears over the sheet counting the blocks
answered for - over the sheet rather than only in the menu, because Apply closes
the menu. A block whose answer fails is drawn whole, said so, and offered again;
what it must never do is sit claiming to still be working, which is what an
absent answer used to be read as. Turned off there is no mark at all and
the bases either side are drawn as one continuous run — which is the point of
turning it off, and why every shape that spans a collapse (a gap's box, a picked
region's edge, an overlay's outline) is drawn as one shape rather than one per
piece: an outline around each drawn piece would put a seam exactly where the
sequence is meant to read as continuous.

On Original the blocks after a collapsed one move up by what was taken out of it,
so every channel keeps the width it had rather than swallowing the space the
collapse freed, and the camera moves with them so the sheet stays still under the
reader. A layer is left where it is — its arrangement is the reader's own work,
and Auto arrange is there for closing its gaps.

The columns are removed from the drawing and from nothing else - at any share.
They are still in
the alignment, still inside any selection that spans them, still exported, and
the ruler still numbers every column by its real position — which is why a
collapsed panel's ticks are not evenly spaced. Nothing about a collapse is
stored: what is uninformative is a fact about the cohort on screen, so it is
asked again whenever that cohort changes - and at a share below 100% the cohort
is the denominator too, so hiding a sequence can push a column over the
threshold that was under it a moment before. Show a sequence again and the columns
it fills come straight back, with no state anywhere that has to notice and undo
the collapse. While the answer is being worked out the panel is drawn whole,
because a collapse guessed from the previous cohort would hide columns the reader
has just asked to see. Very large sheets are not asked at all — the answer is an
intersection over every base on screen — and the menu says so rather than
stalling. A sheet drawn as merged runs of blocks is a different thing again and
says so in its own words: those panels stand for groups rather than for columns,
so there is nothing to ask about until the reader zooms in, and the control reads
**Zoom in** rather than **Too big**. Both were one message once, and it named the
one cause the reader could do nothing about.

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
