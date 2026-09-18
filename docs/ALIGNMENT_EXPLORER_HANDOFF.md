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

The toolbar provides Original block navigation stacked over Arrange, then Cursor (Move view, Free select, Columns in one control), Zoom, Colour, Filter, Hide, Gaps and Cycle. The sidebar contains Layers, Filter, Load data, and Workspace & export.

Wheel behaviour follows the configured Genome Browser scheme. Arrow keys pan and plus/minus zoom. Space-drag pans. The panel starts front-facing; the 3D setting tilts it and exposes the layer stack. Canvas fallback preserves editing without WebGL.

Select cells, release, then drag the highlight into the sidebar. A coordinate-selection dialog is also present. Chunk headers can be dragged to manually position chunks. New chunks are inserted in source order; obstructing successors move horizontally while existing vertical positions are retained. Three rules keep a large move readable, all learned from one that was not — three sequences of a 200-block file arriving as 480 chunks in a staircase of hairlines. A row keeps one slot for the whole layer (chunks used to inherit their neighbour's rows and put the rest below them, so the same sequences stepped a row lower at every block); `chunkGap` stops bidding 110px per connection label once there are too many chunks for them all to fit, rather than clamping the divisor and returning a gap hundreds of times wider than the chunks; and `moveSelection` combines the pieces cut from one source fragment, so a block arrives as one chunk carrying the rows taken from it rather than one chunk per pick. That last one matters more than it looks: picking sequences by name puts a pick on every block holding each of them, and a chunk per pick meant a stack of one-row panels at the same place, each painting its panel background over the rows above it, so every block showed one row and the rest went blank while the strings still ran through them. Two fragments must never share a column for that reason — a fragment's panel spans from its top to its lowest slot, and whichever is painted last wins. Auto arrange aligns shared identities and provides space for connection labels.

Dragging one working layer onto another opens a choice when intervals overlap: combine overlapping chunks, keep them separate, or cancel. Combining unions selected membership masks; it must not invent cells in the holes between selections. Undo/redo covers layer edits. Removing a working layer is undoable.

Strings connect occurrences of the same sequence ID, and only for rows a fragment actually holds sequence in: `presentRows` narrows `rowIds` by `availableRows`, because a source block also lists rows it has nothing in (MAF `e` lines) and a string out of one of those claims a path that is not there.  Click a cell, name or string to highlight the identity's path. `highlighted` is a list of row ids, not one: a name pick and a cell click light a row in the same gold, so holding only the last row clicked meant lighting a third sequence silently put out the second. A row is lit by a pick, by a click on one of its cells, or by both, in the same gold either way — `litRows` is the single answer to what is gold, and every gesture that puts a row out goes through `unlightRow`, which drops the picks *and* the highlight. Clearing only one half was the bug: a name click dropped the picks and left the row gold, and a cell click toggled a highlight that was not what was lighting it, so a row lit both ways could not be put out at all. `addHighlight` answers a jump marker, which moves along a row rather than voting on whether it should be lit. A workspace saved when this was a single id still reads: `highlightedRows` takes a string as the one row it lit. Same-source-block strings can report omitted alignment columns; an overlap uses `↔`. Across discontinuous source blocks the alignment-column distance is unknown, not zero. Original suppresses unknown-distance labels and hides unselected strings in dense views to avoid a tangle. Connections are membership continuity, not inferred ancestry or recombination.

Readable headers expose clipboard FASTA export. Original headers additionally expose a plus action to create a layer from the source block and a row-layout override. Header actions are suppressed when too narrow to be useful. Clipboard export is capped at two million cells and uses `N` for unselected/unavailable cells while preserving source `-` gaps.

## Original layout and zoom levels

Original uses an indexed, stable horizontal layout across the dataset. The artificial spacing between source blocks is a layout device, **not a biological distance**. Source-column rulers remain local to each block.

The default row mode, **Align across source blocks**, assigns every sequence identity a stable row and displays blank-row guides for absent sequences. **Collapse absent rows** compresses each block independently, excluding MAF empty components. A block's row icon can override the global choice; changing the global choice clears overrides.

Original has a fixed left name gutter. In compact mode that gutter describes the nearby block named in its heading; it is not a claim that all neighbouring compact blocks share row positions. Compact blocks now start at the top, rather than alternating into off-screen lanes. Working chunks retain labels beside the leftmost chunk for a path, subject to collision checks.

There are two different overview meanings:

1. **Within a source block:** binned agreement against the fragment's comparison row. Only canonical comparable bases enter mismatch fractions. Gaps and unknown/unavailable data are separate. This is not an evolutionary constraint score.
2. **Across many source blocks:** grouped sequence-presence bars. Filled width represents the fraction of blocks containing the sequence. This is explicitly labelled as presence, not conservation. Sparse headers identify block ranges; clicking a header resolves that range into individual blocks.

**Colour schemes** live in `colourSchemes.js` as a list, read once per paint. A scheme carries a ramp, an index function and a legend; `bases` carries none of those, which is precisely what keeps it on the original path - `paintLayer` tests for a ramp and otherwise does not know another scheme exists. The test sits between the loading check and the flat-row check, once per span rather than once per cell, so the base and bin branches under it are byte-for-byte what they were.

Cohort statistics are computed on the server, not the client. Sequence tiles are batched sixteen rows at a time and arrive independently; a column statistic assembled from those would be a different statistic each time a batch landed, and the view would reshade behind the reader. `summary_cache.py` keeps a second prefix table beside the per-row one, keyed by a hash of the sorted cohort, holding five running totals per 64-column leaf: majority, canonical, comparable columns, occupied and columns. It is one entry per block chunk rather than per row, so it costs a fraction of what its members already cost individually, and it shares the sidecar's locks, LRU and fail-soft disable. `POST /conservation` answers arbitrary bins from it.

Three properties are easy to get wrong and are pinned by tests.

A column carrying one canonical base agrees with itself by definition; counting it lifts every sparse region toward perfect conservation, so it enters neither side of identity while still counting toward representation.

The ramp is fitted to the data, not to the range a ratio theoretically has. Measured over a 44-mammal EPO block, per-bin identity sits between .86 and 1.00; stretched over 0..1 the entire alignment lands in the top eighth of any ramp and every region comes out the same colour. `conservationScale` therefore takes a column-weighted 2nd and 98th percentile over the loaded tiles, bucketed so it moves in steps rather than jittering on every pan, and the legend prints the range it fitted. An adaptive scale that did not say what it had done would be worse than a fixed one.

The two axes are colour and bar height, not colour and saturation. Saturation was tried and failed in the same way: with a cohort of any size most bins sit near a tenth of it, which washed every colour out to the same grey and hid agreement entirely. Relatedly, the cohort is the sequences the laid-out blocks hold, never the whole inventory - a 200-block MAF names a distinct identity per sequence per block, 3,881 of them for 44 mammals, against which a block holding 45 reads as holding about one per cent.

The ramp goes blue to red through purple, not through green and yellow. The usual sweep is close to unreadable with red-green colour blindness, and its yellow shoulder also collided with the gold reserved for a lit row. Tests assert that green never wins a channel and that luminance moves monotonically across the ramp, so it still carries its order in greyscale - upward on the dark theme and downward on the light one, since either way more agreement should mean more contrast against the ground.

Rendering is cheaper than `bases`, not dearer: a colour belongs to a column, so neighbouring columns in the same bucket merge into one rectangle, and a quantised lookup table replaces the per-bin `hsl()` string and two `reduce` calls. Measured on the live canvas at `?alignmentPerf` over the 44-mammal alignment, median paint was 2.4ms against 4.6ms for `bases` on the same camera.

**Import progress.** `open_tracked` in `store.py` returns the text handle alongside the position of the raw file beneath it, which works for both plain and gzipped sources because the gzip reader pulls from that same handle. Row and block counts cannot say how much is left; compressed bytes consumed is a denominator that exists before anything is parsed and holds whether the file has one block or a hundred thousand. It is reported on a 200ms schedule, so a file of small blocks does not spend its time writing progress. `ImportProgress.jsx` shows it, and falls back to an indeterminate bar for pasted content and MAFFT results, which have no file behind them. Starting an import closes the file chooser: left open beside a line of status text it read as the file never having been accepted, and the obvious response - choosing it again - is the one thing that does not help.

**Selecting names.** `namesInRect` and `rectEntersCells` in `layers.js` decide this, and `LayerCanvas.pointerUp` applies it: a rectangle that covered names and never reached the sequence picks those rows with `rowPicks`, which is the same thing clicking each name produces, so they toggle the same way and light the same gold. Anything else falls through to `selectRectangle` unchanged.

A name whose sequence is not in any block on the sheet has no cells to pick - `rowPicks` returns nothing for it, and `togglePicks` of an empty list is a no-op - so a rectangle over the gutter used to take some of the names it covered and silently drop the rest. Those names go to `highlighted` instead, through `toggleHighlights`, which adds them or takes them all out the way picks toggle. `onSelection` carries them as a second argument so both land in one patch. A click on a single name does the same thing, and for the same reason: before this it did nothing at all, which read as the name not being a control.

Three details matter. The test is done in screen space, because the names are drawn there and have no column of their own to express it in. It is inclusive on every edge, so a press that never travelled still covers the name under it - in Select mode a click on a name has to go on meaning that name, and a click is a rectangle of no width. And `rectEntersCells` takes a left bound: the Original paints an opaque name gutter over the blocks behind it, so a block scrolled under that gutter is not something the reader can see or mean, and without the bound a drag over the names would always count as having reached the sequence and would never pick a name at all.

Only Pan takes hold of content. `pointerDown` computes `grabs = !isSelectMode(state.mode)` and gates every branch that would carry something off - a name into a reorder, a header into a block pick or a panel move, a connector or jump marker into a row drag. Without it, dragging from any of those in Select drew nothing, which is the one thing those modes are not for. The icon hits (the crosses, the copy and layer buttons, the aggregate band) are deliberately not gated: they are buttons, and a button is a button in every mode.

`hitAtPoint` in `originalLayout.js` is the other half, and the cause of the bug that surfaced it. Original paints its name gutter *over* the blocks, so every hit region behind the gutter - headers, connectors, jump markers - is a target nobody can see. A block header's region spans the whole block, so for a block scrolled left, a press in the gutter above the first name found that header and was taken as a click on it. The rule is one line and covers every kind, present and future: **under the gutter only the gutter's own names answer**. Three call sites in `LayerCanvas` go through it, so the hover title and the deselect cross obey it too.

**The wheel near the left edge.** `wheelScrollsRowList` gives a vertically dominant wheel left of the gutter edge to the row list, so a long list of sequences can be scrolled where the horizontal controls would otherwise take every notch. It now asks first whether there is a list there at all: `LayerCanvas` passes `state.original && rowListScrolls(layer, camera, size)`, and `rowListScrolls` measures the sheet against the same window height `constrainCamera` clamps `camera.y` by. A working layer draws no gutter and has sequence under the cursor there, and a list wholly on screen is pinned by that clamp, so the wheel moved nothing. Under the default controls a plain vertical wheel is the zoom, which is how the whole left edge of the canvas came to scroll - or sit dead - instead of zooming. A wheel carrying Ctrl, Shift or Alt is never the list's either: those mean over the names what they mean over the sequence.

The gutter claims the whole band rather than only the rows with names in them, which is deliberate. Keying it on the label hits looks more precise and is worse: scrolling a long list until its names have passed the top of the window leaves the cursor over empty gutter, the wheel silently becomes a zoom, and there is no way to scroll back.

**A note on testing gestures here.** Drags cannot be driven end to end in headless Chrome: `pointerDown` calls `setPointerCapture`, and a release synthesised through `Input.dispatchMouseEvent` never reaches the handler afterwards, so the gesture hangs half-finished and the marquee stays on screen. Clicks on hit regions are unaffected, because those branches return before capture. To exercise a release, drive the press and moves with real input and then dispatch `pointerup` at the element with canvas-relative coordinates. Note also that completing a selection sets the mode back to Pan, so a second drag needs the mode re-armed or it pans instead - and re-arming it only works if the *browser's* capture was released too. A synthetic `pointerup` satisfies the handler but not the browser, which goes on retargeting every later press to the canvas: the toolbar click that should re-arm Select lands on the sheet instead, and the second drag looks like a broken toggle. Follow the synthetic release with `releasePointerCapture` and a real `Input.dispatchMouseEvent` mouseReleased.

**The control bar's split buttons.** `CursorTool`, `ZoomTool`, `ColourTool` and `GapTool` are the same shape: a `.al-split` pair sharing one border, the main half doing the obvious thing and the arrow opening a menu. Each is titled with its decision and keeps that title whatever the mode - labels that rewrote themselves (`Free select` becoming `Columns`, `Zoom` becoming `Zoom Panel`) changed the bar's width and read as a control appearing rather than one changing. The consequence is that Zoom and Colour have no visible mode, so both flash the mode they land on above the button: `ToolToast`, positioned by `toastPosition` and cleared by its own `animationend` rather than a timer, so there is no timer to cancel when the next press arrives. Colour's main half cycles the schemes, because comparing two of them means going back and forth and doing that through a menu is three actions each way. The menu is a portal into `explorerRoot`, not a child of the bar - the bar scrolls sideways and would clip it - and `menuAnchor.js` holds the two pieces that entails. `menuPosition` is called when the menu opens rather than measured in an effect: the bar does not move while a menu is open, and measuring in an effect would cost a second render on every open. `useMenuDismiss` watches `pointerdown` in the capture phase so a press that lands on the canvas closes the menu instead of starting a gesture with it.

Select is split rather than plain for a specific reason: completing a selection sets `mode` back to `pan`, so without a remembered kind the reader would have to say which of the two they wanted before every drag. `selectKind` in the component's own state is that memory; it is UI, not workspace, and deliberately does not survive a reload.

**Palettes.** `palettes.js` holds what a scheme can be drawn in, apart from what a scheme means. Two kinds: `bases` takes four unordered colours, the column schemes take one ordered ramp, and `COLOUR_SCHEMES[].palettes` says which. They are offered unnamed - a swatch is the thing itself, where a name is a word about it, and four names across a row read as things to understand before one can be picked. Both are chosen once per paint - `basePalette(...)` for the base table, `scheme.ramp(light, palette)` for the ramp LUT - so the inner loops are unchanged and still read one table by key. `buildRamp` memoises on palette *and* theme; keying it on theme alone would have served one palette's ramp for all of them, which a test now pins.

Every palette carries both themes explicitly rather than deriving one from the other, because a ramp has to gain contrast against its own page as the quantity rises: darkening toward the high end on a light ground and brightening on a dark one. That is a property worth testing rather than trusting, and `alignmentPalettes.test.js` measures the luminance of both ends of every ramp in both themes. It also checks every ramp stays clear of the gold reserved for what is picked.

**Uniform shading.** Not a scheme of its own - it was one for an afternoon, and a scheme that could not show the bases at all meant two places to go for the same sequence. It is what `bases` does where a column is too narrow to be a base: `SHADING_MODES` in `colourSchemes.js`, `state.shading` in the workspace, and `scheme.shading` marking the one scheme the choice belongs to. Relative is the agreement-with-the-comparison-row colouring this view has always had; uniform fills the block flat instead.

The painter branch is guarded `if (uniform && !data.detail)` and sits *after* the thin-row case and *before* the detail branch, so the sequence is painted exactly as it always was as soon as the bases are big enough to draw. It is the cheapest branch there is: a span with no gaps is one rectangle.

Gaps are the one thing it still draws. Without them a sequence missing half a block would be indistinguishable from one running the whole way through, which is the shape this shading exists to show. `uniformRuns` is that decision, pulled out of the painter so it can be tested without a canvas: at bin resolution only a bin every sequence was absent from is a gap - half a bin of bases is still sequence, and calling it one would invent an absence.

The colour is `presenceColour`, which is what this view already meant by bare presence: the fill a row too thin to read gets, and the fallback for a bin with no comparison to make. Both of those now read the same constant, so the three cannot drift apart. A palette of flat colours was tried and dropped - it was a fifth thing to choose in a menu whose point was to have fewer.

**The Colour menu's tabs are the choice.** Moving to a tab recolours the sheet. A tab strip that only previewed a scheme, with a separate control to apply it, would be two ways of saying one thing and a state where the two disagree. The saved palette is per scheme (`state.palette[schemeId]`), since the two kinds are not interchangeable; `validPalettes` sanitises each against its own scheme's kind, so a ramp id saved under `bases` falls back rather than painting nothing.

**The key, in two places.** `ColourLegend` draws whatever `scheme.legend(light, scale, palette)` returns, told apart by `kind`: a `ramp` is one ordered bar with labelled ends, `swatches` is an unordered set that labels each one. `bases` had no legend at all before and now has the second kind, which is what let the menu open on a tab that says something for every scheme. `inline` is the copy in the menu; without it, it is the overlay on the alignment.

The overlay used to be `pointer-events: none` so the canvas under it stayed draggable. It takes the pointer now, because the cross that dismisses it only exists while it is being reached for and an element that cannot be hovered cannot offer one. The corner it covers is why `legendOverlay` defaults to **off**: the key is always a click away in the menu, and the window is for the alignment. The workspace remembers it either way.

**Gaps are drawn once, by the pass that paints last.** The gap-memory overlay (`visibleGaps`, at the end of each row) exists so a gap resolved at one zoom is not filled back in by a coarser tile. It paints *over* the cells, which is why the dash a gap cell used to draw for itself was never visible: at full opacity the overlay covered it, and on a dimmed row - where that paint is translucent - it showed through. That is exactly the "only when another sequence is highlighted" symptom it was reported with.

So the overlay now owns the whole treatment: the background, the outline around the run, and the dashes. The cell keeps only its background fill, and neither the cell outline nor the cell dash exists any more. That also settles the inconsistency, since one run is one box at every zoom where an outline per cell drew a row of little boxes close up and a single long one further out. The box is placed on `detailRow` - whether the row was actually drawn from a detail tile - because the detail and bin branches use different insets, and a box on the wrong one left a sliver of the cells it was meant to cover showing above and below.

The colour is `colors.gap`, taken from `FEATURE_COLORS.genomic` rather than written out again: the Feature Explorer outlines unannotated genomic sequence in that blue, a gap is the same kind of statement, and one source means the two views cannot drift apart. The conservation and uniform painters take it from the same `colors` object, so all four paths outline a gap identically. A span with no statistic yet keeps the neutral border, because that is not a gap - nothing is known there, rather than nothing being there.

**One gold for everything picked.** `PICKED_EDGE` is the edge of a pick and `WASH_ALPHA` the fill inside it, in `paintLayer.js`. Regions from Free select and Columns, the live marquee and the deselect ring were teal; a name, a block header and a lit row were gold. They are one act, so they are now one colour, and the wash rather than the hue is what tells a picked stretch from a lit row.

`armedEdge` draws every one of them: a dark line at half alpha and `hair(3)`, then the colour at `hair(1.5)` over it, dashed for the marquee with the backing left solid so the gold is never on bare bases in a dash gap. The backing is the constant `EDGE_SHADOW`, not `colors.background`, and that is deliberate - it is read against the bases, which are the same saturated colours in either theme, and a pale backing in light mode left the gold with nothing behind it. This is the same arming the gold jump-marker labels have always used, for the same reason.

The provenance overlay on the Original passes `placed.color` to the same function instead. The layer's colour is the whole point of that mark - it says which layer - so only the weight and the backing are shared. None of this is unit-tested: it is canvas, and there is no decision in it that a pure module could hold. It was checked by driving the live canvas and reading the screenshots in both themes.

**Dropping a picked region.** The cross on a region's corner is drawn by `paintLayer` when `hoverPick` is that pick, tracked in `LayerCanvas` by `pickAt` - which returns the pick by reference, since an index would name a different pick if the selection changed between the paint that drew the control and the click that pressed it. The state is set only when the pointer crosses a region's edge, because the canvas repaints whole and setting it per pixel would repaint per pixel. A pick's own hit region counts as part of it, so reaching for a cross that overhangs a narrow region does not decide the region is no longer hovered and take the cross away mid-reach.

Which picks get one is stated by exclusion - anything that is not `kind: 'row'` or `kind: 'block'` - and that is deliberate. Picks reach state in three shapes: `blockPick` and `rowPicks` stamp their kind in `layers.js`, a drag is stamped `'region'` by `LayerCanvas.pointerUp`, and Select by coordinates stamps nothing at all. Two attempts at a rule naming the kinds it wanted each matched one region source and silently missed the other; the test asserts all three shapes so a fourth source cannot quietly lose its control. Row and block picks are excluded because clicking the name or header again already drops them, and a name carries its own cross a few pixels away that removes the sequence from the layer - a different act entirely.

The corner is the region's, not the block's, since several regions can share a block. It is held inside whatever of the region is on screen: a wide selection scrolled past its own corner would otherwise put its only way out somewhere the pointer cannot reach. Getting that clamp wrong is easy - written as a max of the two ends it sat on the bottom corner of any region taller than itself, which looked deliberate and was not.

**Removing from a layer.** `removeFragment` and `removeRowFromLayer` in `layers.js` are the whole of it, and both are pure. Three things have to happen together or the layer is left inconsistent: `slots` runs parallel to `rowIds` so it loses the same position, while `coverage` and `availableRows` are keyed by row and lose the entry; a chunk left with no rows is dropped rather than kept as an empty panel; and `compactSlots` renumbers the lanes, because a row keeps one slot for the whole layer and a slot freed by a removal is freed in every chunk - left alone, each removal would make the layer permanently taller by one blank lane.

Connections need no separate handling, which is worth knowing before someone adds some. `layerConnections` rebuilds from the fragment list every time, grouping by row and joining consecutive occurrences, so taking a chunk out of the middle of a path rejoins its neighbours on its own. Both helpers return a new layer object when they change anything and the same one when they do not, which is what `useLayerData`'s `useMemo(..., [layer])` keys on - returning a fresh object unconditionally would rebuild connections on every no-op, and mutating in place would leave the old ones on screen. Tests in `alignmentLayerRemoval.test.js` pin both directions.

Neither gesture is offered on the Original. It is a derived view of the source, so nothing in it was put there and nothing can be taken back out; Hide is the reversible equivalent and already exists. The block action is guarded on `state.original` in the painter, and the row cross sits in the label loop, which the Original never enters.

**Zoom mode** offers two zooms over the same view. **Alignment** (the default) is the horizontal zoom described above: it changes how many columns a pixel covers and leaves rows 26 pixels tall, which is what reading an alignment wants. **Panel** treats the drawing as one flat sheet and scales all of it, so blocks, names, labels and strings shrink together and whitespace opens around the edges; it is the only way to see a thousand-sequence file end to end, since rows otherwise always outrun the window.

Panel zoom is implemented as a factor on the canvas transform, not as a second layout. The painter works in **plane units** — the coordinates it has always used — and is handed a viewport of `size / plane`, which is where the extra world comes from. Two rules keep it honest and must be preserved when editing `paintLayer`:

- Geometry stays in plane units; anything that should hold its size on screen (glyph legibility thresholds, tick spacing, hairline widths, the dotted ground, the drop indicator) divides by the plane factor.
- Resolution decisions use the **effective** scale, `camera.scale * plane`, not `camera.scale`. That governs `renderResolution`, `visibleRequest`, `denseOriginal` and the letter thresholds; using the raw scale would fetch and draw detail for a view nobody is looking at.

Pointer coordinates are divided by the plane factor once, in `canvasPoint`. Nothing downstream knows about plane zoom, which is why dragging, picking and reordering keep working unchanged at any panel zoom. Below about three pixels a row is drawn as a single presence rect rather than bins, gaps and features, and below about four pixels a glyph is dropped while its hit region is kept — a row still answers to a click when it is too small to carry its name.

Three rules bound the mode, all learned from it being wrong first:

- **`PLANE_MIN` is 0.15, for every view.** Past roughly there rows fall under a pixel and a block is a few pixels of bar; what is left is a scatter of marks that can be neither read nor clicked. The same limit applies to a small layer as to Original — deriving a floor from the content made a layer stop at 75% and look broken.
- **Panel mode shows blocks, and zoom is a ladder, not a scale factor.** `panelZoom` spends the horizontal magnification first and only then shrinks the sheet, so leaving sequence detail walks down through bases and binned columns to whole blocks instead of jumping to a low-detail overview. `enterPanelZoom` magnifies out of a merged overview back to individual blocks: merged bars are a summary of a summary and shrinking them is where the drawing fell apart. Blocks are then never merged again while the mode is on, which takes three things together and needs all three: `blockFitScale` stops widening the columns at `BLOCK_DETAIL_SPAN` as well as at the anchor block, because a source block can be twice that wide and fitting one to the window is on its own enough to ask for an overview; `useOriginalBlocks` asks for `merge=0`; and it raises `detail` to the whole response, because the server coarsens by block count when a range holds more than `limit`, and the enlarged viewport brings far more blocks into range than the window holds.
- **Panel zoom is anchored on the middle of the window, never the cursor,** and `constrainCamera` lets the sheet sit up to half a window down while `plane < 1`. Together those are what centre the drawing and open whitespace above it; anchoring on the cursor with the old 10% margin left the blocks pinned under the ruler with all the space underneath. Sideways the ordinary margins still hold, so the first block begins near the gutter rather than out in an empty window. At full size the sheet returns to the top edge, and `exitPanelZoom` puts it there while keeping the column that was in the middle of the window.

`↺` fits the same thing in either mode; in Panel it also takes the sheet to the far end of its travel.

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
| `colourSchemes.js`, `palettes.js` | What a cell's colour means, and the colours it can mean it in. |
| `paintConservation.js`, `paintUniform.js` | The cohort and uniform-shading span painters: siblings of the base path, never changes to it. |
| `CursorTool.jsx`, `ZoomTool.jsx`, `ColourTool.jsx`, `GapTool.jsx`, `menuAnchor.js`, `selectKinds.js` | The control bar's split buttons and the menus behind their arrows. |
| `ColourLegend.jsx` | The key for whichever scheme is active, in the menu and optionally over the alignment. |
| `LayerCycle.jsx`, `layout.js`, `explorer.css` | Cycle previews, panel geometry helpers, presentation. |
| `associations.js` | Conservative automatic genome matching. |
| `detail.js` | Block context's whole model: included rows, reference, mode, order, active pair, lane groups, request planning. Pure; no React, no canvas. |
| `useBlockContext.js` | Block context's own request budget: block identities, gene models, pairwise measurements. |
| `paintBlockContext.js`, `comparisonBands.js` | The overlay over the sheet - track lanes, reference guides, comparison bands - and what a band's colours mean. |
| `paintBases.js` | The per-column base cells, shared by the sheet and by block context so a base cannot look like two things. |
| `BlockContextGenomic.jsx`, `genomicContext.js` | The genomic half: real lengths, real coordinates, its own transform. |
| `regionRequests.js` | Which regional reads a fragment needs, and which comparison row each is relative to. |
| `backend/alignment_explorer/projection.py` | Alignment columns to genomic coordinates and back, from runs of sequence rather than a per-base map. |
| `backend/alignment_explorer/comparison.py` | What two rows differ by, counted. Observational and directional by construction. |
| `frontend/src/utils/nucleotideStyle.js` | Shared nucleotide palette and letter threshold. |
| `backend/alignment_explorer/store.py` | Streaming text imports, SQLite sequence chunks, row identity, coordinates, layout index, regional summaries/export. |
| `backend/alignment_explorer/api.py` | API routes, import jobs, source checks, metadata, annotations, workspace persistence. |
| `backend/alignment_explorer/adapters.py` | Optional native/graph adapter infrastructure; not all exposed by this view. |

Application integration:

- `frontend/src/App.jsx`: lazy `alignment_explorer` route, active-genome/config props, MAFFT **Open in Alignment Explorer**, genome-navigation callback.
- `backend/main.py`: registers the router and supplies `alignment_explorer_annotation_features`, using existing local annotation projection.
- Shared toolbar/home/button configuration exposes the view. Existing Cycle and Genome Browser utilities should remain shared rather than duplicated.

## State and coordinate invariants

The current workspace format is **version 2**. Important state includes `layers`, `active`, `original`, `sourceBlock`, `camera`, `selection`, `highlighted` (a list of row ids), `annotations`, `originalRows`, `blockRows`, `planeZoom` and `filterOff`. A filter is two things: `filter` holds the chosen sequences and blocks, and `filterOff` says whether it is being applied. The control bar's flag switches `filterOff`; only Clear discards `filter`, so a reader can take a narrowing off and put it back without rebuilding it, and the panel opens seeded from whatever `filter` holds. `tilted` was dropped with the 3D layer stack; saved workspaces that still carry the key are simply ignored. `annotations` survives with no control to set it — see *Annotations are built but unreachable* below.

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
| `POST /datasets/{id}/block-context` | Block context: row identities, genomic spans, orientation, resolved assembly/region, and why a row can or cannot be annotated. |
| `POST /datasets/{id}/block-features` | Gene models over a column window, in genomic coordinates and as projected column pieces. |
| `POST /datasets/{id}/block-comparison` | Measured difference between named pairs, and optional selected-feature measurements. |
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

### Block context

See [the corrective review](ALIGNMENT_BLOCK_CONTEXT_REVIEW.md) for the latest behaviour, tests and remaining gaps in the original proposal.

A lens onto one source block, added on 14 September 2026. It is **not** a layer and
**not** part of the workspace: `blockContext` is React state in
`AlignmentExplorerView`, never `state`, so nothing it does can be committed, undone
or saved. A lens onto a block is not a statement about the alignment, and a saved
one could name a block, a row or a transcript that has since gone. `origin` carries
the camera, sheet, picks and row order to put back on closing.

Load-bearing decisions, each of which was a bug before it was a rule:

- **Lanes come from complete row groups.** `rowGroups` assigns cumulative slots so a
  reorder moves a sequence together with its own annotation lanes, and expanding one
  gene moves the rows below it and nobody else. `layoutRows` is set explicitly
  because `rowCount` would otherwise stop one lane short of the last group.
- **Removal is stood down inside the lens.** `compactSlots` (`layers.js`) renumbers
  the used-slot set densely, which would collapse every track lane onto its
  sequence. `LayerCanvas` suppresses `removeBlock`, `removeRow` and row reorder, and
  `paintLayer` draws no header actions at all while `state.blockContext` is set -
  an icon that is drawn but inert is worse than one that is absent.
- **Pinning is one flag in `panelRect`.** A pinned fragment keeps the horizontal
  transform and drops the vertical one. Painting and hit testing both read that one
  function, so they cannot disagree about where a pinned row is.
- **One palette.** `explorerColors` is shared by both painters. When the overlay
  built its own it was short of `text`, and every name it drew silently kept
  whichever fill happened to be current.
- **The gutter is painted last and text is clamped to its edge.** The block slides
  under the gutter as the camera moves, so anything written left of `MARGIN_X` is
  painted over by the names. `paintLayer`'s floating labels are suppressed here for
  the same reason Original suppresses them: two sets of names is worse than either.
- **The comparison band is drawn before the annotation, and independently of it.**
  It was inside the early return for a row with no gene models, so exactly the rows
  that most needed measuring showed none.

**Comparison rows are per request, not per block.** `visibleRequests` and
`planTiles` take a `focusOf` function and group by it; `rowCoverage` takes the
expected comparator and drops a binned tile built against any other, leaving a hole
that reads as loading rather than showing agreement with a reference nobody chose.
Detail tiles are comparator-independent and always kept. Without `focusOf`
everything behaves exactly as before, against the block's first row.

**Coordinates.** The new endpoints are zero-based half-open throughout. The GFF3
index is one-based inclusive and is converted at the provider boundary
(`alignment_explorer_block_genes`) and nowhere else. `/api/browse/sequence` is
zero-based half-open and caps at 100 kb. Row strand decides projection; transcript
strand decides biological ordering and sequence orientation, and the two are never
conflated.

**Projection is from runs, not from a map.** `row_segments` walks only the chunks a
column window touches and returns the runs of non-gap bases in it, with each run's
count over the whole row. Both directions are then a bisect. This is what bounds a
block of millions of columns: 44 real rows over a 16,384-column window index in
1-4 ms each, and every column of every row round-trips against `locate_column` on
both strands. `project` returns an envelope **and** the base-bearing pieces inside
it: mapping only the two boundaries would fill this row's gaps with another row's
insertions and draw them as exon. Introns are the one exception and collapse to
their envelope, because an intron is the statement that two exons are joined and
its pieces run to the thousands.

**A gap column has no genomic coordinate.** `at_column` returns an explicit gap with
the coordinates either side rather than the nearest base. Inventing one would make
an insertion in another row read as sequence in this one.

**Bounds are request bounds, and everything held back says so.** Eight rows or pairs
per request, 65,536 columns per detailed window, 200 genes per row, eight
transcripts per expansion page, 20,000 projected segments per response - with
`truncated` and `next_page` in the reply. There is no whole-block entry limit:
large blocks stay navigable and the work is bounded by window and row count.

**The measurements are observations.** `comparison.py` has no insertion, no
deletion and no inversion in its vocabulary, and its tests assert that those words
do not appear in what it produces. Double-gap columns are excluded from every
comparable total; unknown bases and absent coverage are never counted as
difference. Entirely-gapped is reported as entirely-gapped, not as exon loss.

**What is not done.** Tree import, inferred phylogenies and automatic homology
matching are deferred, as is dragging a row group on the canvas - ordering is by
the bar's keyboard controls. The genomic panel fetches models through
`/api/browse/canonical_transcripts` and does not yet draw genomic sequence letters
at base zoom.

### Annotations are built but unreachable

**Deliberately parked, not abandoned — the intent is to bring this back.** The
genomic annotation feature is complete end to end and still wired up; only the
control that switches it on was taken out of the sidebar, because the Display
section was too crowded to judge the rest of the UI against. `state.annotations`
now stays `false` for a session that does not load an older workspace, so nothing
downstream ever runs.

What is still in place and must not be removed as dead code:

- `useLayerData(..., state.annotations, ...)` requests feature tiles and returns
  `annotations` and `warnings`; `LayerCanvas` and `paintLayer` draw them
  (`FEATURE_COLORS` is imported from `FeatureLegend` by `paintLayer`).
- The annotation warning strip under the canvas, keyed on `warnings.length`.
- `annotations: false` in `emptyWorkspace()`, so the flag round-trips through
  saved workspaces.
- **Link local genomes** (formerly *Genome links & annotations*) still sets
  `annotations: true` when a link is applied, which is currently the only way to
  turn the feature on.
- The whole backend feature-mapping path and its tests.

To restore the control, put this back into the Display section of
`AlignmentExplorerView.jsx`:

```jsx
<label className="al-check"><input type="checkbox" checked={state.annotations}
  onChange={e=>patch({annotations:e.target.checked})}/>Annotations</label>
```

The feature colour key that used to sit beside it was
`{state.annotations&&<FeatureLegend theme={theme} horizontal/>}` inside a
`div.al-legend`; both that import and the `.al-legend` rules in `explorer.css`
were removed with the base-colour legend, so a restored legend needs them back.

### Block headers are chosen, not laid out

`headerPlan.js` decides what a block header says at the width it has, and
`paintLayer` draws that decision inside a clip on the block's own header band.
The rungs run: name with interval and actions, name with actions, name, the
abbreviation `Blk N`, the bare number, nothing. Two properties matter and are
tested in `alignmentExplorer.test.js`: a plan never asks for more room than it
was given, so a header cannot run over its block's edge into its neighbour; and
the rungs only improve as room grows, so zooming in cannot take away a header a
narrower block was already showing. The code this replaced reserved a flat
85–150px per header whatever it drew, which is what made headers blank out at
some zooms and reappear at others.

`rulerTicks`, in the same module, answers the other half of the header: where
the column ruler puts its marks and which of them can be named. A tick is inside
the block by construction, but the number beside it is not, and the clip cuts
whatever crosses the block's edge — so the last tick of a block was labelled with
half a number. A number is written only where it fits inside the edge, and the
mark goes down either way: it still says where the column is, and the interval's
two ends are already named in the header. The same limit takes the viewport's
edge when a block runs past it.

Room is the block's own visible span, and `denseOriginal` has no say in it. That
verdict is about the view as a whole — over twelve blocks on screen, or most of
them under 90px — and using it to gate a header meant one wide block among
slivers was cut back to its bare number with several hundred pixels of header
going spare. `dense` still chooses the coarse row rendering and still suppresses
the `· compact` suffix; the ruler now follows the header's own verdict, so a
block too narrow to name its interval does not tick it either.

### Dropping a row is read against the block, not the gutter

`rowDrop.js` decides where a row dragged over Original lands. The rows to aim
between are the ones on screen under the cursor, and on compact layouts those are
not the gutter's: the gutter names the file-wide order, or — once a compact block
claims it — that one block's rows, while every other compact block packs the
sequences it holds from its own top. Reading the drop off the gutter therefore
offered as many positions as the *anchor* block had rows and inserted before
whichever sequence the gutter had at that height, not the one being pointed at.

An aligned block is the one case where the gutter is still right: it draws its
rows on the file-wide slots the gutter publishes, and the gutter also offers the
empty slots between them, which belong to sequences that block does not hold. So
the gutter's label hits carry `anchor` — the block whose rows they are, or null
for the file-wide list — and the drop uses the block's own rows whenever the
block is compact or the gutter has been claimed.

A dragged jump marker is the stronger case: the block it points into owns the
whole drag, and the cursor's column chooses nothing. A marker sits in the channel
between blocks, so a drag from one is usually over no block at all, and letting
the cursor's column claim the insertion meant the target — and the marking with
it — changed under the hand as it crossed a neighbour. `jumpBlock` names the
block; only the cursor's height is read.

Most markers name a block that is **not loaded**: `blockJumpMarkers` builds them
from `offWindowLinks` as well as from occluded connections, and an off-window
link points outside the window by definition. Those have no rows on screen to aim
between, so the drag falls back to the block the marker is drawn on, which does
hold the sequence — never to whatever the cursor is over. A block that does not
carry this row is never a place to put it, and falling through to `under` was how
the insertion ended up on an unrelated block.

Clicking a marker opens the block it names **on the sequence it belongs to**.
`blockRowLines` works out which line that sequence will occupy once Original has
laid the block out — the same reading of aligned slots and compact packing that
`layoutOriginal` takes — and `centreOnRow` puts the camera there. Both live in
`originalLayout.js` beside the layout they mirror, and a test asserts they agree
with it. The centring is best-effort by design: a block that fits on screen is
not scrolled at all, since sliding a fourteen-row block half off the top to
centre one of its rows reads as a broken jump. Deep blocks, where the row could
be anywhere down a thousand rows, get the middle of the window.

A press on a marker that moves at all is a drag of that row: it skips both the
half-a-row vertical threshold and the sideways-means-pan escape that connection
strings still use. The marker names a block to put the row in, so there is
nothing else the gesture could mean, and a release that never moved is still the
click that opens the block.

The indicator is drawn on the blocks the move shows in and nowhere else: the
block being dragged into, bold, and the blocks downstream of it that carry the
same sequence, faint. Each is marked at its own height, because a compact block
packs only the sequences it holds and one position in the file-wide order is a
different row in each of them. A line of one weight straight across the window is
read against the gutter's names, which are a different list again, and promises a
place the drop will not honour.

### Hiding replaces Original's layout rather than filtering it

The control bar's **Hide** keeps the blocks the reader has picked out, and the
blocks their picked sequences run through, and packs the survivors shoulder to
shoulder; **Show** puts the file back on the view it was left at. The state is
`state.hidden = {blocks, camera}`, saved with the workspace and sanitised by
`validateLayerWorkspace`.

The button opens a small menu rather than acting on its own. **What** chooses
between hiding blocks, sequences or both. The row half composes with the filter
rather than fighting it, by narrowing the same `sequences` list the filter uses,
so what survives is what both allow.

Every mode hides blocks, including the one that sets out to hide only sequences:
`hideResult` drops any block left holding none of the surviving rows. Hiding a
sequence empties the blocks it was the only visible thing in, and an empty block
is not something to keep — it is the header of a block whose contents were just
hidden, standing between the blocks that do still hold something and pushing them
apart. That was the shape of a real bug: hiding one sequence left the emptied
blocks in place, which both showed bare headers and kept the surviving blocks
from becoming adjacent, so their links stayed jump markers. **Condition** appears only where blocks are being hidden.
**Apply** acts; **Previous** repeats the last hide from the picks it used, which
is why `state.hideMemory` outlives the hide itself — the picks are stored as
block numbers and sequence ids, so they survive Show, a reload and a saved
workspace. Once anything is hidden the button is simply **Show**, and the menu
does not open.

The menu is portalled into the explorer's own root, not the body: the control bar
scrolls sideways and would clip it, and its colours are custom properties scoped
to that root, so a portal to the body renders it transparent.

The rule beside the button decides how the picks combine. `or` takes the union —
the picked blocks, and every block the picked sequences run through — and answers
"show me everything I marked". `and` reads the picks as conditions on one block:
picked blocks become the only candidates, and each has to hold every picked
sequence, so two blocks and three sequences keep whichever of those two blocks
holds all three. With no sequences picked the blocks stand alone; with no blocks
picked the whole file is the candidate list. A condition nothing satisfies keeps
nothing, which is reported rather than acted on, and the rule in force stays the
one that produced the sheet on screen — the control snaps back.

It is not the filter. A filter drops fragments from a layout whose coordinates
are still the file's, leaving the survivors where they were with gaps between
them; hiding rebuilds the layout. `hiding.js` holds the pure parts — which blocks
a selection keeps, and packing descriptors into fragments — and `blocks-layout`
on the server answers "where are exactly these blocks", which no range endpoint
can: the survivors are scattered, and asking for the ranges between them would
fetch the very blocks being hidden. Each descriptor keeps its true `x`, so the
client packs and every block still carries the number it has in the file.

Consequences to keep in mind when changing this:

- `useOriginalBlocks` is stood down while hiding (`enabled` goes false). It reads
  the camera as file coordinates, and on a packed sheet they are not.
- The Original layer carries `packed: true`, and a packed sheet answers the
  burial question from what it draws, the way a layer does: `linkIsBuried` drops
  the "Original holds every block" shortcut, so a gap in the numbering is no
  longer a buried link by itself. Blocks hidden on purpose are out of the way and
  their neighbours are joined by ordinary strings — that is what hiding was meant
  to clear away. A block still standing between the two ends is a different
  matter and still buries the link: drawn as a line it would run behind that
  block and read as a sequence passing through one it is not in, which is the bug
  that "a packed sheet buries nothing" produced. Off-window neighbours are not
  requested, since the blocks beyond the sheet's edges are the ones just hidden,
  and `blockJumpMarkers` makes no stubs for them.
- `linkIsBuried` is one rule for both passes, and must stay that way. The painter
  draws the lines first and the panels over them, then adds markers for the
  buried ones. When the two passes asked the question differently — as they did
  briefly, one reading "Original holds every block" and the other reading what
  was drawn — a link could be dropped by the first as buried and by the second
  as not, and disappear from the picture altogether.
- `sourceBlock()` fits the camera to the fragment already laid out, and the block
  stepper walks the kept list. A block that is not on the sheet says so.
- The camera is fitted to the whole packed sheet when a hide is *made*, never
  when one is loaded: a saved workspace already carries a camera in these
  coordinates.

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
