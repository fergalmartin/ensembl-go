# Sequence view

Sequence laid out the way a file lays it out: sixty bases to a row, with the
coordinate of the first and last base of each row down either margin, and the
annotation painted onto the bases themselves.

The colours are the Alignment view's, from `frontend/src/utils/featureColors.js`
— the same blue for coding sequence, the same alternating pair for codons, the
same orange for a splice site. A reader who has learned one view can read the
other.

## The two conventions

Both are worth stating before anything else, because most of what could go wrong
here is one of them going wrong quietly.

**Coordinates are 1-based and inclusive of both ends, on the forward genomic
strand.** That holds in `/api/sequence-view/*`, in `backend/sequence_view/`, and
in every frontend module named `sequenceView*`. It is what the annotation tables
hold, what the gutters print and what a FASTA header carries. The one place it is
not true is the `fasta.fetch` call itself, which is 0-based half-open; that
conversion happens in `_read_window` and nowhere else.

`/api/browse/sequence` is 0-based half-open. It is a different dialect, and the
trap it sets is documented at `frontend/src/components/genomeBrowserExonSegments.js:1-17`.
Nothing in this subsystem speaks it.

**Rows are all the same height, except where one carries a lane.** A uniform row
height is what lets the scroller turn a scroll position into a row with one
multiply, and that is still what happens whenever nothing is drawing a lane —
which is every document except a transcript or an exon with the protein switched
on. Where lanes exist, the scroller asks a *height index* instead; see **A row is
only as tall as it needs to be** below. The two costs cannot meet: a lane needs a
single reading frame, and a compressed spacer needs a region fifty times larger
than the largest thing that has one.

## The control bar

The bar across the top is where a control belongs when it is about the *reading*
rather than about the thing being read -- the focus drawer on the right owns the
latter, and the bar floating over the sequence owns the one case where the thing
being read is what the reader came for (see **A transcript read in its own
coordinates**). It is drawn in the app's two existing control-bar idioms rather
than in one of its own:

- **The bar is the genome browser's**: the same background (`#f1f3f5` / `#1E2938`),
  the same rule under it, the same height and padding, so moving between the two
  views does not move the furniture.
- **The controls on it are the alignment explorer's**: one drawn chevron where
  there is a menu behind the control, and the menu drawn over the page and
  pinned to its button by a connector.

The explorer's controls also carry the applied value under their name, and
Features does not. That form earns its place where the value is one word that
changes what the canvas means -- Colour, Zoom, Gaps. Here it was four
independent switches abbreviated to fit a control, which is a worse version of
the menu one click away, and it made the bar's widest control the one saying the
least.

`components/sequence-view/controls.css` states those shapes against the view's own
`--sv-*` tokens rather than importing `alignment-explorer/explorer.css`, which is
scoped to `.alignment-layers` and carries three thousand lines of canvas, sidebar
and modal rules for the dozen this bar needs. The tokens hold the same values, so
the two bars stay the same colour.

The *positioning* is shared rather than copied: `menuPosition` and
`useMenuDismiss` come from the explorer's `menuAnchor.js`, so the two bars cannot
drift about where a menu lands, when it closes on Escape or an outside press, or
that only one toolbar menu in the app is open at a time. `menuPosition` takes the
custom-property prefix to write its answer into, which is the only thing that
differed.

**The tokens live on the view's root, not on the bar.** A menu is portalled into
that root so it inherits them and so the light switch reaches it. The element
rules are scoped to `.sv-bar` and `.sv-menu` for the same reason in reverse: the
root holds the whole view -- the drawer, the base box, the legend -- and a rule
on `.sv-controls button` would restyle every button in all of them.

### The Features menu

Four questions, one button. They are different questions, but they are all the
same *kind* of question -- what the rows show of the thing in focus -- and
splitting them across four buttons would have put four narrow controls on the bar,
each reading as a mode. A reader changing one of them is usually changing two.

**The menu explains itself in as few words as it can.** A line under a switch
saying what the switch plainly says is a line between the switch and the fields
it governs; "intergenic" and "intronic" are not words this menu has to teach
anyone reading sequence. What is kept is the sentence a reader could not have
worked out from the control -- which way round the sequence is being read at the
moment, and why a switch they cannot use is unavailable.

| section | what it holds |
|---|---|
| What to leave out | Collapse intergenic and Collapse intronic, each with its own flank and floor |
| Which way it reads | Reverse complement |
| Flanking sequence | 5' and 3' for a gene, a transcript, and an exon or intron |
| What else to draw | Display amino acid sequence |

**Menu edits are a draft, published by Apply**, the way the explorer's Colour and
Gaps menus work. Every one of these costs something -- a new window to fetch, a
new layout to place every row in, a translation over every codon on screen -- so
applying them a keystroke at a time would refetch and re-lay-out the view while
the reader was still typing the number.

The two toggles that cannot always do what they say report it in place: the
intron collapse where a location is too dense for its exons to have been read,
and the protein lane where there is no single reading frame. Both facts come from
the view rather than being worked out by the reader.

**A kind is reported unavailable only where the answer said why**, never from its
simply being missing. That inference is how a region with twelve genes in it came
to be told there were too many genes to read every isoform: the sentence was
reached by an answer the client could not parse, and the count printed beside it
was real, so it read as a considered refusal. `/spans` now carries
`limited: "gene_count"` when that is what happened, and an answer with no
`offers` array at all is refused as unreadable rather than believed.

What the view has to say about what it is drawing -- a search that failed, an
index still building, what a collapse actually hid, why the colours went coarse
-- is a row under the bar rather than an item in it. These are sentences, and a
sentence in a row of controls either truncates or pushes the controls off the end.

### The Colour menu

What every kind of annotation is drawn in. The defaults and the arguments behind
them stay in `sequenceViewPalette.js` -- why intergenic cannot borrow the
intron's colour, why genic cannot borrow the exon blue; `sequenceViewColours.js`
is the layer over it that a reader can move, and it reads its defaults out of the
palette so the two can never disagree about what "default" means. A test holds
every class to that: switching colours on must not move a colour for a reader
who never touches it.

**Grouped by what is on screen together**, not by class code:

| section | holds |
|---|---|
| Region and gene | coding, UTR, mixed, intergenic, genic, overlapping genes |
| Transcript, exon and intron | CDS, 5′ UTR, 3′ UTR, splice site, start, stop, repeats |
| Highlighting | the selection, the base a box is open about |
| Both | non-coding, intronic |

A location is drawn in the gene classes, so those two are one list; an exon or an
intron is its transcript windowed, so those three are the other. The two kinds
that appear in both are listed once, in their own group — listing them twice with
one value behind them reads as a bug the moment a reader changes one and watches
the other move. A test walks `LEVEL_GROUPS` and fails if any level can draw a
class no section covers, so the menu cannot quietly acquire a hole.

**A choice is stored against the item, not the class.** "Splice site" is a donor
and an acceptor and colours both; "CDS" is the two shades a codon alternates
between, and the second is *derived* from the first rather than asked for — so
the stripe survives any colour, including one too pale for a fixed pale partner.
The shipped colour returns the shipped partner exactly, so nothing repaints by
default.

**Picking opens the app's own colour dialog** — `GenomeColorPicker`, the one the
genome selector uses — with its `renderPreview` hook showing a run of annotated
bases instead of a gene track. That hook was already there for exactly this: a
colour is chosen for how the thing it colours will look, and a stretch of small
lettered cells, filled or outlined, is not the same question as a gene model.
The palette, the custom-colour mixer and *Use default* come with it.

**Applied as it is picked**, not gathered behind an Apply like the Features menu.
Nothing is fetched and no layout changes — a colour is one more thing the
already-drawn rows are painted with — and a colour is judged against the
sequence, so making the reader confirm before they can see it would be asking
them to choose blind.

**Two things drawn the same way are called out, once a reader has caused it.**
The palette's own rule is that no two classes at one level may look alike,
because a reader cannot tell them apart whatever the legend says. That is not
forbidden here — it is their screen — but the menu says *Same as 3′ UTR* under
the offender. A pair that *ships* identical, as 5′ and 3′ UTR do, is not
reported: it is not news, and it is not their doing until they move one.

#### Highlighting

Its own section because a selection and the ring on a base are marks about what
the *reader* is doing rather than about the sequence. They are drawn over
whatever colour a base already wears, they mean the same thing at every level,
and neither is a class — so neither travels in the 60-character class string,
and neither can collide with a class colour however they are set.

**The selection is not a hex.** Its wash and its outline are
`rgb(r g b / var(--…-alpha))`, because the weight each is drawn at belongs to the
view — heavy enough to find, light enough to read the bases through — while the
colour belongs to the reader. The palette builds those two strings from one
colour; the pair that shipped differed by five units of red and three of blue,
which nothing can see and nothing explained.

**The ring follows the theme until somebody picks a colour.** Near-white on a
dark page and near-black on a light one, because reading over a filled cell, an
outlined one and a bare one is the whole of its job, and no single hue does that.
So its stored value is a *behaviour*, `auto`, and not a colour: the menu shows
`Theme` rather than a hex, the dialog opens on whichever colour the theme
currently resolves to, and *Use default* there puts it back to following rather
than pinning today's answer. Choosing a colour is trading the contrast guarantee
for one of their own, which is theirs to trade.

Two marks in this family are **not** yet colourable: the blue rule under the
feature the pointer is resting on in the list, and the amber rules on a gene's
first and last base. Both are arguably annotation rather than highlighting — the
second certainly is — and neither was asked for.

**The palette is built once and handed down**, rather than each component
importing the colours. A row is memoised on what it is given, so the palette has
to keep its identity while the colours do — the same reason the empty overlap
list is frozen. Everything that draws a colour takes it: the rows, the legend,
the highlight switches, the hover readout and the base box.

## Scrolling a chromosome

A location focus can be a whole chromosome. Human chromosome 1 is 4,149,274 rows
of sixty, which at 26 px a row is 107.9 million pixels of content — several times
what a browser will let an element be tall.

So the spacer is capped at `MAX_SCROLL_PX` (12 million) and a row's position is a
proportion of it rather than a multiplication. Below `MAX_SCROLL_PX / rowHeight`
rows — around 27 Mb of sequence — the spacer is the true content height and
`scrollTopForRow` reduces exactly to `row * rowHeight`. Every focus level except a
whole-chromosome location is in that range; the largest human gene is 2.5 Mb.

Two things fall out of the cap, both in `frontend/src/utils/sequenceViewScroll.js`:

- **The wheel is intercepted when the spacer is compressed.** A wheel delta is a
  distance the reader expects the content to move; handing it to the scroll
  position would multiply it by the compression, and on a whole chromosome one
  notch would jump some two kilobases. `wheelTargetRow` translates the delta into
  rows instead. Dragging the scrollbar still traverses the whole region.
- **The anchor row is a fraction.** Under compression many scroll positions map
  into one row, and flooring would make the sequence stick for a few pixels and
  then jump a whole row.

What the view considers itself to be looking at is `anchorCoord`, the coordinate
of the first base of the top row — not a pixel offset. Anything that changes the
geometry restores that, because a pixel offset would mean something different
afterwards.

## Collapsing

The view can leave out the parts a reader is not looking at. Where it does, the
sequence carries a marker saying how much went:

```
CATCTGGTAAGTCAGCACAAGAGTGTATTAA<---- 8,187 bp ---->TTTTTCTCC
```

**Showing everything is collapsing with no gaps.** `utils/sequenceViewDisplay.js`
builds one *layout* for both: an ordered list of items, each either a stretch of
sequence to draw base by base or a gap marker to draw as text, with the column
each begins at. Nothing collapsed is the layout with a single item. Everything
downstream -- the gutter numbers, the hover coordinate, the drag, which sequence
to fetch, where a coordinate jump lands -- asks the layout what is at a column
rather than adding an offset to a row start.

That is the whole reason for the shape. The alternative is two row models, one
arithmetic and one segmented, that have to agree about all six of those things;
they would drift, and the collapsed one would be the one nobody exercised. This
way the collapsing code runs on every row the view has ever drawn.

Positions along a layout are **columns**: column 0 is the first character drawn,
and row N holds columns `[N*60, N*60+59]`. Rows therefore stay a fixed height and
the scroll model above is untouched -- a collapsed chromosome simply has fewer
rows.

### Two kinds, switched separately

**Intergenic** and **intronic** are different questions, so they are different
switches in the Feature menu. Intergenic sequence is what lies between genes, and
a reader hiding it is looking at a region with several genes in it; intronic
sequence is what lies inside one, and a reader hiding that is reading a gene. At
a location both are on offer, and a reader routinely wants one without the other
— the stretch between two genes is the thing they are comparing, or it is the
thing in the way.

Each carries **its own flank and its own floor**, because what is worth keeping
differs: the ends of an intron are its splice sites and are worth reading, the
ends of a megabase of intergenic sequence are not especially. The defaults are
100 bp kept at each end and nothing under 300 bp collapsed.

Neither is derived on the backend. `/spans` answers with the two span lists every
version of the question comes out of, and `collapseKeeps` does the rest:

```
intergenic = the region, minus the genes
intronic   = the genes, minus their exons
hidden     = each kind that is switched on, shrunk by its own flank,
             dropped where the stretch was under its own floor
kept       = the region, minus what is hidden
```

That split is what makes both switches, both flanks and both floors immediate: a
reader changing any of them is changing nothing about the annotation, so the view
re-lays-out without a round trip. `/spans` is asked again only when the region,
the level or the thing in focus changes.

| level | genic is | exonic is |
|---|---|---|
| transcript, exon/intron | the transcript | its exons |
| gene | the gene | the union of every isoform's exons |
| location, few enough genes | the genes | every isoform of every gene in view |
| location, too many genes | the genes | **not answered** — `null` |

The last row is a cost, not a preference. Reading every isoform of every gene in
view out of its JSON blob is quick for the few dozen genes a screenful of
sequence sits among, and minutes for the seven thousand on human chromosome 1.
Over `MAX_INTRON_COLLAPSE_GENES` (100) the answer carries `exonic: null` and
`offers: ["intergenic"]`, and the bar **says so** rather than quietly doing
something other than what was asked.

`null` rather than an empty list, because the two mean opposite things — nothing
is exonic here, against nobody asked — and an empty list would make every base of
every gene collapsible as an intron.

**The payload shape is part of the cache key** (`SPANS_SHAPE`). These answers
outlive a restart on disk, so an answer written by an older version of the
endpoint would otherwise be read after an upgrade as a region that can collapse
nothing -- which is exactly what happened during the change that introduced them,
and it reported itself as a gene count rather than as a stale answer. Raise
`SPANS_SHAPE` whenever the payload changes, and the client refuses anything it
cannot parse rather than drawing a conclusion from what is missing.

### The marker

`gapMarkerText` builds `<` + dashes + label + dashes + `>`, and the label is the
only part that has to be read. A number broken across a row edge is worse than no
number, so rather than shrinking the marker or moving the break, **the dashes
before the label grow until the label fits in the row it lands in** -- which is
what pushes it onto the next row. That terminates: one column of padding shifts
the label one column, so within a row's width it reaches a column where the whole
label fits, and at worst that is the start of a row.

The dashes are drawn rather than typed. A hyphen centred in its own cell leaves a
space either side, so a row of them reads as dots; the cells carry a one-pixel
background rule instead, which joins up. The label's own characters stay as text
and the spaces around it leave the break in the rule.

A gap is only made when it would hide at least `COLLAPSE_MIN_HIDDEN` (30) bases.
Below that the marker is longer than what it replaces, so the sequence is simply
drawn.

### The flank and the floor

The flank is taken off the stretch being collapsed rather than added to the
stretch being kept. The two are the same arithmetic, and doing it that way is
what lets each kind carry its own.

Widening a flank can make two kept stretches meet, and then they are one, with no
marker between them. A flank wider than half the stretch collapses nothing there,
which is the honest answer rather than a marker over a negative range.

The floor is the reader's, but `COLLAPSE_MIN_HIDDEN` (30) is still the hard one
underneath it, applied in `buildDisplayLayout` to whatever gaps survive: a marker
costs about two dozen columns, so collapsing fewer than that would make the
sequence longer than what it replaced.

### What a collapse does not change

- **The region.** Switching modes keeps the reader's place: the anchor is a
  coordinate, and the same coordinate is simply in a different row afterwards.
- **The coordinates.** The gutters print genomic coordinates either side of a
  marker, so they jump across it. Hovering a marker says how much is not shown
  and between which two coordinates.
- **A selection.** Dragging across a marker moves the head in one step -- there
  are no coordinates under it to stop at -- and the selection is the genomic
  range including the hidden bases, which is what makes its FASTA match its own
  coordinates. The marker is drawn as selected so the highlight reads as one
  selection rather than two.
- **Copying.** `/fasta` is given the region, so copy and download still give the
  true genomic sequence, introns and all. A spliced FASTA would be a different
  feature.

### Fetching scattered sequence

Collapsed, the rows on screen can straddle stretches half a megabase apart.
Reading from the first visible coordinate to the last would fetch the whole of
every intron the reader has just hidden, so `coordIntervalsForRows` reports the
stretches themselves and both buffers plan from those --
`planChunksForIntervals` for sequence, and the same rule for the tiled location
classes. Collapsed mode therefore reads *less* sequence than full mode, not more.

## Fitting the width

Sixty bases to a row is the point of the view, so a reader should never have to
scroll sideways to finish a line. The cell width is therefore not a constant: it
is whatever makes gutters-plus-sixty-cells fit the space the panel has left,
clamped between 8 px (below which a base stops being legible) and 16 px (above
which a row starts reading as a table). The row is then centred in that space,
and the letter size follows the cell.

Collapsing the panel gives the width back and the cells grow into it; opening the
settings slot takes width away and they shrink. Neither needs telling: the
scroller is measured with a `ResizeObserver`, and everything follows from its
width.

That observer is attached by a **callback ref, not an effect**. This component
renders nothing at all while a focus is resolving, which unmounts the scroller;
an effect with empty dependencies would run once on the first element and never
see its replacement, freezing both the width and the height at whatever they were
— the cells would stop resizing and the viewport would keep the row count it had.

`rowMetrics` reports `fits: false` when there is no width that works, and the
view allows a sideways scrollbar rather than making the sequence unreadable to
avoid one.

## Buffering

Sequence arrives in fixed 12 kb chunks on a grid anchored at coordinate 1. The
grid is absolute rather than relative to the focus, so moving from a gene to one
of its transcripts and back reuses everything already fetched: the sequence has
not changed, only the window onto it.

A chunk boundary therefore falls inside a row whenever the region does not start
on the grid, which is nearly always. `assembleRowSequence` stitches the row from
the two chunks it spans. A row is sixty bases and a chunk twelve thousand, so it
is never more than two.

Both queues are `TileScheduler` from the alignment explorer
(`frontend/src/components/alignment-explorer/tileScheduler.js`), which already
does bounded LRU, priorities, per-task cancellation and retry with backoff.

**Sequence runs at concurrency 1.** Every read of a genome's FASTA is serialised
behind a lock on the backend (`ThreadSafeFasta`, `backend/main.py:269`), so a
second worker would not read in parallel. It would only let a chunk the reader
has already scrolled past sit in front of the one they are waiting for. At one,
the queue is ours to order and abandoning a stale request genuinely brings the
wanted one forward. The lock turns concurrency into latency; one turns it back
into priority.

**Annotation runs on a separate queue** with its own budget, so it can never
occupy the worker sequence needs. That matters most while a genome's annotation
index is building: class requests are meeting 425 and backing off, and sequence
carries on rendering beside them.

Only a location focus is tiled — it is the only unbounded one. A gene, a
transcript and a feature each ask once, keyed on what is in focus, so scrolling
within one does not refetch.

## What a base is

The backend never sends a class per base. A megabase of intron would be a
megabyte of the letter `i` carrying no information, so a window is described as
runs — `{s, e, c}`, non-overlapping, ascending, with gaps where nothing applies.

Runs are always emitted in forward-genomic order, including for a gene on the
minus strand. Reverse reading is a display transform applied at the very end, by
`orientRowForDisplay`, to the sequence, its classes and any selection together —
so there is exactly one place where the three could fall out of step.

| level | classes |
|---|---|
| `location` | coding, utr, noncoding, intron, mixed — the gene classes, read gene by gene. Plus intergenic, and genic where a tile was too dense to read. |
| `gene` | coding, utr, noncoding, intron, mixed — every isoform at once |
| `transcript` | cds (with a frame), utr5, utr3, noncoding, intron, donor, acceptor, start_codon, stop_codon |
| `feature` | the same as transcript; only the window differs, so there is one code path |

Overlap is resolved by explicit priority, first writer wins — `FEATURE_PRIORITY`
in `backend/sequence_view/classes.py`, in the same order as the Feature
Explorer's, so a base coloured one way there is coloured the same way here. The
order is data you can read and change, rather than being implicit in a `sort`
clause that breaks silently.

### Filled or outlined

Before any hue, a cell says one thing: **filled means the feature itself,
outlined means sequence of that broad kind that is not the feature.**

| class | drawn |
|---|---|
| coding, CDS | filled, exon blue |
| UTR | filled, purple |
| non-coding | **outlined**, exon blue |
| intronic | filled, slate |
| intergenic | **outlined**, lighter slate |
| mixed | filled, pink |
| genic (the coarse answer) | filled, muted blue-grey |
| overlapping genes | a rule **under** the bases, amber — not a class |

Hue alone could not carry it. Non-coding *is* exon, so it belongs in the exon
blue, and a lighter shade of that blue beside a solid CDS is a difference nobody
reliably sees. Intergenic had a worse version of the same problem: it was
borrowing the intron's exact colour out of the shared palette, so two classes
that mean opposite things — outside every gene, inside one — looked identical.

The outline is drawn as one band over a whole run rather than a box per base:
the rule runs along the top and bottom throughout and closes only at the ends,
which a row edge counts as. A box per base reads as beads on a string, and what
is being marked is a stretch of sequence rather than sixty separate ones.

Coding and CDS deliberately share the exon blue. They are the same answer read at
a gene and at a transcript, they are never on screen together, and a reader
moving between the levels should see the blue follow them.
`sequenceViewPalette.test.js` holds both halves of that: no two classes *at one
level* may be drawn the same way, and those two across levels must be.

All of that describes the **defaults**. A reader can move any of them from the
Colour menu, and the two rules become advice rather than law — the first is said
in the menu where it is broken, and the second is a relationship between two
items a reader is free to separate. What the tests hold is the shipped palette.

Genic used to share that blue too, on the grounds that genic is coding seen from
further away. It cannot any more. A location is now drawn in the gene classes, so
a tile that fell back to the coarse answer can sit beside one that did not, and
two identical blues would say the same thing about bases that are not the same at
all. It has its own muted blue-grey, and the legend shows it only where it is
actually being used.

### A location reads like a gene

A region is drawn in the same five classes a gene is, so that reading a location
and reading a gene teach the same thing: moving between them changes the window,
not the vocabulary. Genic and intergenic on their own could only ever answer *is
there a gene here*, which the browser already answers better at that scale — what
a reader opens a sequence view for is what the bases *are*.

It is two passes of one rule. Each gene is asked first, by all of its own
isoforms, exactly as at gene level; then the genes are asked together. That shape
is what makes overlap fall out correctly: an antisense exon lying across another
gene's intron is a disagreement *between genes*, and it comes out `mixed` by the
same rule that already handles a disagreement between isoforms. `combine_votes`
is that rule, and it lives in one place because two copies would drift about what
disagreement looks like.

A gene with no isoforms at all is intronic over its own span — inside a gene, and
claimed by no transcript, which is what the annotation actually says about it.

**The cost is real but small.** The tile has to read every transcript of every
gene in it. The densest 240 kb tile in the human Ensembl annotation holds 84
genes and 225 transcripts and answers in about 70 ms cold, nothing thereafter;
`MAX_LOCATION_DETAIL_GENES = 100` is the guard for annotations denser than that,
and past it the tile falls back to genic and intergenic and the control bar says
why. A tile at a time, so a dense stretch can go coarse while its neighbour does
not.

### Where genes lie on one another

Overlap is a second channel, not a class. A base two genes share is still coding
or still intronic, and saying so is the whole point of the colour; overlap is
common enough — antisense transcripts, nested genes, read-through loci — that
spending the fill on it would blank out the annotation over long stretches.

So it is drawn as an amber rule under the bases, from `overlaps: [{s, e, n}]`
alongside the runs, and the hover readout says how many genes claim the base:

```
1:97,471,989 · G · Mixed · 2 genes
```

It travels in the row's *marks* channel, a base-32 digit per cell — `1` a gene's
first base, `2` its last, `4` a base more than one gene covers, `8` the base a box
is open about, `g` the feature being pointed at. Bits rather than a character per
kind, because a base can be several of those at once: a gene that begins inside
another one carries an edge and an overlap together, and while a reader points at
it, all five. Reversed for minus-strand reading, the two edge bits swap sides and the
overlap bit does not — how many genes cover a base does not depend on which way
it is read.

The rule is painted as a background layer rather than a border, so it takes none
of the cell's width. Every row here is exactly sixty cells wide, and a mark that
changed that would shift the text under it.

### Pointing at a row in the list

Resting the pointer on a gene, a transcript or an exon in the list tints that
feature's bases in the sequence and marks its first and last with the amber edge
the annotation's own boundaries use. It is the quickest answer to *which of these
bases are that one?*, and the only one that does not involve reading a coordinate
off a gutter and counting. Where a gene begins mid-row, the tint begins mid-row.

**A rule under the bases, closed at both ends of the run.** The blue runs under
every base of the feature and turns up the side where the run starts and where it
stops, so the mark has a beginning and an end rather than trailing off. A row in
the middle of a long feature carries the rule and no caps: the feature does not
stop at the edge of a line, and closing a box around every line of it would read
as a series of stretches rather than one.

**And turned up at the ends of the line it leaves.** A row in the middle of a
long feature used to carry the rule and nothing else, which is a two-pixel line
under sixty letters — precise, but hard to pick out of a stack of rows at a
glance. Where the run reaches the edge of a row it now also marks the margin
beside the first or last base, so a reader scanning down the panel can see which
lines carry the feature without following the rule across each one. Only where it
reaches the edge: a feature that begins or ends inside a row is already marked
exactly, at the border of its own first or last base, and a rail out at the
margin would be a vaguer answer to the same question. The rails are drawn as
offset shadows on the end cells rather than as anything of their own, so they
line up with the underline to the pixel and cost the row no width — every row
here is exactly sixty cells wide, and the mark sits in the gutter's padding.

It was a wash over the cells before that, and a pulsing wash before that. A tint
has to compete with whatever the cells are already wearing, and at this size it
loses: a third of a cyan over a mixed pink or a CDS blue is a shade of those
colours rather than a mark on them. That was what the pulsing was solving — by
moving instead of by contrasting — and the pulsing cost what the next section
describes. A line does not have to compete. It is drawn at full strength on the
one edge of the cell nothing else is using, and it reads from across the panel.

**It is the palette's own blue** — `FEATURE_COLORS.exon.bg`, the blue the exon
and CDS fills, the genomic outline and the arrows are all drawn in — so pointing
at a feature marks it in the colour the rest of the app already means *feature*
by. It was a cyan before that, chosen to sit apart from every colour a base can
be wearing; the price was that it read as a colour of its own rather than as this
view speaking. The one place the older argument still bites is a coding base,
which is filled in that same blue: there the rule is a blue line on a blue cell,
and it is the amber caps on the feature's first and last base, and the run's own
closed ends, that carry the mark.

A rule under a base does already mean something here: the amber says more than
one gene covers it. The two share the edge, in different colours, and the blue
wins it for as long as the pointer is on the row — which is the right way round
for a mark that is gone the moment the pointer leaves.

**It used to breathe, and that is what made the list feel sticky.** The tint
pulsed: one clock above the rows animated an inherited custom property, so a gene
rose and fell as one piece rather than in patches whichever rows happened to be
painted when. The idea was sound and the cost was not.

A custom property that inherits is inherited by *everything* under the element
carrying it, and that element was the slab — every mounted row, about sixteen
hundred cells. Changing it sixty times a second meant recalculating the style of
all of them sixty times a second, whether or not anything was highlighted. On a
1500 px window that measured **17% of the main thread, continuously, at rest**.
Scanning the pointer down a gene list cost 20% with the animation and 10%
without, so what a reader felt between one row and the next was the animation
holding the frame — not the work of the highlight, which is cheap.

So the tint no longer moves. It was always the tint that carried the answer: the
note that used to be here said as much about `prefers-reduced-motion`, where it
stopped moving and stayed visible because "the tint is the information, the
breathing only says it is temporary". It is a little heavier now — 0.3 rather
than 0.22 — because it is the whole of the mark rather than the bottom of a
swing, and it needs no clock, no inherited property, and no repaint of anything
that is not under the pointer.

Nothing is fetched and no layout changes. It is one more mark on the rows already
drawn, which is what lets it follow the pointer for nothing. The marks channel
went to **base 32** to hold it — `1` a gene's first base, `2` its last, `4` a
base more than one gene covers, `8` the base a box is open about, `g` the feature
being pointed at — so a row is still four equal-length strings and a memoised row
still decides whether to repaint with four string compares. Below ten the digits
are the same as they were in hex, so nothing that reads a mark had to change.

The preview is cleared when the focus changes, since a row can go out from under
the pointer and then its `mouseleave` never arrives. Not on a scroll, though: it
is about a feature rather than a position, and it should still be there when the
reader has scrolled to the part of it they were looking for.

### Clicking a base

The colours answer one question per base, and where genes overlap or isoforms
disagree the answer is `mixed` — true, and not what the reader wanted to know.
Clicking asks the long question. The box that opens is the genome browser's
transcript popup to the pixel: same panel, same arrow, same type scale, because a
reader who has clicked a transcript there should not have to notice this is a
different view.

```
1:97,472,590  T
Drawn as: Mixed — they disagree, below
— 2 genes cover this base
Gm71560   + · lncRNA · ENSMUSG00000121413
  Here: Intronic
  ENSMUST00000187538   Intronic · intron 3 of 4
  1 of 3 isoforms reach this base
Gm37171   − · TEC · ENSMUSG00000103179
  Here: Non-coding exon
  ENSMUST00000192636 canonical   Non-coding exon · exon 1 of 1
```

`GET /base` answers it, and the class it reports is computed by the *same*
functions that painted the colour, over a window of one base. A test holds the
two together across a row of coordinates, because a box that explained a colour
by disagreeing with it would be worse than no box.

**It answers for the level being read.** At a location that is every gene's
answer together, so `mixed` is a real thing to say; at a gene it is that gene's;
at a transcript it is that transcript's own, because a transcript in focus is the
only thing describing its own bases. Saying "mixed" there would be describing two
isoforms that are not on screen. A gene's flanking sequence gets no class at all,
which is also what the gene view draws.

### Reading into something else from the box

The genes and isoforms are listed whatever the level — that a base is coding in
one isoform and untranslated in another is worth knowing wherever you are
standing — but what the view is *drawing* is marked, and that decides which
control each row gets:

| where you are | what has an eye | what the rest get |
|---|---|---|
| location | every gene, and every isoform of them | — |
| gene | the isoforms of the gene in focus | *Read* the other genes |
| transcript, exon, intron | nothing | *Read* any other isoform or gene |

A transcript view draws exactly one transcript, so there is nothing there to
switch off — hiding it would leave an empty screen, and hiding the others would
be switching off things that are not being drawn. What a reader wants at that
point is the other reading of the base, so the box offers it: *Read
ENSMUST00000149927*, and the view moves there. For an isoform that means two
dispatches, gene then transcript, because the chain is gene → transcript and
entering the transcript alone would leave the drawer showing the gene you came
from. The row you are already reading says `reading` instead of offering
anything.

Three rules it inherits rather than invents:

- **An isoform that does not reach the base is not listed.** The same rule that
  keeps `mixed` meaningful. The count is still shown — *1 of 3 isoforms reach this
  base* — so the short list is explained rather than looking like missing data.
- **Exons are numbered 5′ to 3′**, by the function `/focus/features` numbers with,
  so the box and the drawer never disagree about which one is exon one.
- **UTRs are reported 5′ or 3′** by reading order rather than by position, which
  on the minus strand is the other way round from the screen.

A gene with many isoforms shows the canonical one and three others, then *10
more, all Coding* — a base in a well-annotated gene is in fifteen transcripts
that mostly say the same thing, and a box taller than the screen answers the
question worse than a short one.

Not cached. It is one coordinate, the work is a gene lookup and a handful of
interval tests, and a cache keyed per base would evict everything else in the map
for answers nobody asks for twice.

**Which base.** Two marks say it, from both ends. The box's point meets the side
of the cell, and the base itself is ringed — 2 px, high contrast against the
theme rather than a hue of its own, since it has to read over a filled cell, an
outlined one and a bare one. The ring is drawn *wholly inside* the cell
(`outline-offset: -2px`): at any smaller inset its outer pixel lies over the
neighbouring cell, and the cell to the right — a later sibling, so painted
afterwards — covers that side of it, which made the ring look thinner on one
side than the other. The ring travels in the marks channel as bit `8`,
beside the gene edges and the overlap rule, for the reason all of them are there:
it is true of a base whatever the base is, and must not displace the colour it is
being asked about. A base can carry all three at once.

**Which side.** Right of the base by default — where the eye goes next along a
line of text — flipping left when the right has no room, and staying right but
pushed off the window's edge when neither side has room, since a box pointing the
right way from a little way off beats half a box off the screen. Vertically it is
centred on the base and then pushed back inside the window; the arrow does not go
with it but stays level with the base, sliding along the box's side, so fifteen
isoforms at the bottom of the screen still point at the right row. That arithmetic
is `utils/sequenceViewPopup.js`, pure and tested, because every one of its cases
is an edge nobody reproduces by hand.

**The point is a square on its corner**, not the usual bordered triangle. A CSS
triangle has no outline of its own, and this box is dark against a dark page: over
the sequence its point simply disappeared. A rotated square takes a border on its
two outer sides — drawn harder than the panel's, because eleven pixels of line
need more contrast than three hundred do — and hides its inner half under the
panel.

**The gesture.** A press released within 4 px of where it began is a click;
anything further is a drag and belongs to whatever else wanted it. With the
selection tool in hand there is no box at all — the gesture is the tool's. The box
closes on a scroll, on a resize, on Escape, on a new focus and on a press outside
it. It closes rather than following, because it is anchored in pixels: an arrow
that kept its position while the sequence moved under it would be pointing at the
wrong base.

### Hiding what is in the way

A crowded locus answers every question with `mixed`. Hiding is how a reader takes
the argument apart: silence the antisense gene lying across a protein-coding one
and the stretch they shared stops being contested and reads as what the gene left
says it is. Verified on mouse chr1 — hiding one lncRNA turned 1,185 pink cells
into plain intron.

**Hiding is not a drawing switch.** A hidden feature casts no vote, so the runs
themselves are different, which is why the set travels to the backend as `hide=`
rather than being applied to the answer after it arrives. There is one
computation of what a base is, over the features that are still speaking, and the
box that explains the colour is computed from the same set — so the two cannot
drift apart. The class toggles are the other thing: they change what is painted,
not what is true.

**What can be hidden is what can vote**: a gene, and one isoform of a gene. Exons
and introns have no eyes in the list, deliberately. An exon is not a voter — it
is part of what its transcript says, and a transcript without its third exon is
not an annotation of anything. Turning off exons as a *kind* of sequence is what
the highlight switches are for, and they already do it.

The set is sent only where there is more than one voter — a location and a gene.
A transcript in focus is the only thing describing its own bases, and a reader
who has opened one does not mean "show me nothing"; sending it anyway would mint
a second cache key for the same answer.

Two rules fall out of the vote model rather than being written:

- A gene with every isoform hidden is intronic over its own span, which is what
  the annotation already says about a gene it gives no transcripts for. Better
  than a hole: the gene is still there.
- Hiding a gene takes its overlaps with it, since one gene cannot overlap itself.

The controls are the browser's eye, in three places for one reason each: beside
each row in the list, where a reader is already choosing what to look at; on the
section heading, because hiding forty genes one at a time is not a feature; and
in the base box, because a base under two genes is exactly where a reader finds
out that one of them is in the way. The heading's eye is pulled right by the
heading's own padding so that it lands in the column the row eyes are in — one
column of eyes, with the one at the top meaning all of them.

**In the box the gene's eye governs the gene and everything under it**, and an
isoform's eye means *only this one* while its gene is hidden. Both appear only
where the view is drawing the thing they would silence — see the table above. So **hide the gene,
then show the canonical** is two clicks and leaves that isoform on its own, which
is what a reader wants at a crowded base. There is no separate all-isoforms
control; there was one for a day and it was a button squeezed into a line that
did not need it.

Two halves of one act, not two acts: showing an isoform of a hidden gene has to
show the gene as well, since a gene is silenced whole whatever its isoforms say —
and since the gene is coming back, the reader is asked which isoform they meant
rather than handed all of them again, so the rest of what is listed goes quiet.
`onHiddenChange({show, hide})` applies both at once; doing it as two calls would
paint an in-between state nobody asked for, and fetch the tiles for it. The same
rule holds in the drawer, where showing a transcript shows its gene, or it would
do nothing a reader could see. Hiding from the box re-asks about that base
and leaves it open, with the hidden gene still listed and marked *Hidden — not
counted* — the box is where it gets turned back on, so it is the one place it
must not disappear from.

The set lives for the session and is not saved. A gene that is not drawn, cannot
be seen to be hidden, and survives a restart is a bug report waiting to happen;
the control bar carries `N hidden · Show all` for as long as it lasts.

`hiddenParam` sorts the set, so the same features hidden in a different order are
the same request and the same cached tile — which matters because every toggle
re-asks for every tile on screen, and turning something off and on again should
cost nothing the second time. The backend caps it at `MAX_HIDDEN = 200`: past
that it is a query, not a reading aid.

### Mixed

Each isoform votes on each base it covers: coding, utr, noncoding or intron.
Bases the isoforms agree about take that class, bases they disagree about are
`mixed`, and bases no isoform covers are intronic — inside the gene, outside
every transcript.

**An isoform that does not cover a base does not vote.** Without that rule the 5′
region of any gene with one short isoform would be mixed all the way along, which
tells a reader nothing.

At a location the voters are genes rather than isoforms, and the base with no
voters is intergenic rather than intronic. Everything else about the rule is the
same, and it is the same code.

The answer is swept from interval boundaries rather than walked base by base. A
gene can be 2.5 Mb and carry a hundred isoforms, and touching every base once per
isoform would be a quarter of a billion steps for an answer that only ever
changes at a boundary.

### Reading frame

`cdsFrame` carries one entry per CDS segment, where `o` is the segment's offset in
*spliced* coding sequence. A single anchor would not do: codon index has to be
measured in spliced space, and counting genomic bases from the start codon drifts
by the length of every intron in between.

The list is sorted by coordinate on both strands, like every other run list, so
the client can binary search it; the offsets carry the direction instead.

A CDS whose start codon could not be verified against the bases gets no frame at
all, and is drawn flat rather than striped — which says "the frame is not known"
instead of asserting one that may be wrong.

### The protein over the codons

Switched on in the Feature menu, a lane above each row carries **one letter per
codon, on the codon's middle base**. That is what puts it visually over its codon
without a wider cell or a second row model: the letter is centred in a cell that
is already the right width, and a codon split across a row edge still shows its
letter as long as the middle base is on the row. The row is therefore still sixty
cells of the same width, and the protein is one more equal-length channel beside
the bases, their classes and their marks -- so a memoised row still decides
whether to repaint with a handful of string compares.

### A row is only as tall as it needs to be

The lane is drawn **only on the rows that have a letter to put in it**. At a
transcript with ten exons in twenty kilobases most rows are intronic, and giving
all of them eighteen pixels to serve the coding third is eighteen pixels of
nothing on the rest — about a third of the screen.

That means two row heights, which the scroller was explicitly built not to have.
What makes it affordable is that the rows wanting a lane arrive as **runs**, not
as a list: they come from CDS segments, so a transcript with a hundred coding
exons has at most a hundred runs. `utils/sequenceViewHeights.js` turns those into
a couple of hundred alternating stretches and answers *where does row N begin*
and *which row is at pixel P* with a binary search and one multiply.

**A uniform document is one with no runs**, and then every one of those functions
reduces exactly to the multiplication or the divide it used to be — including the
compressed path, which `sequenceViewHeights.test.js` checks against the formula it
replaced. There is one row model, the arithmetic path is the one almost every
document takes, and it is the same code a document with lanes exercises.

Nothing else had to move. Hit testing is `elementFromPoint` rather than
arithmetic on a row height, so hover, clicks and drags were never affected; the
slab's offset is now computed in pixels rather than in rows of one height, which
is the same number where the heights are equal.

**Which rows are tall is decided by the annotation, not by the bases.** A row's
height has to be settled before it can be placed, and its sequence arrives
afterwards — a row that grew when its chunk landed would reflow the document
under the reader. So `proteinRowRuns` works from the CDS frame, and a row whose
bases are still in flight is a tall row with an empty lane, which is the right
way round. The row draws a lane if and only if the height index made room for
one, so a letter can never land on a row with nowhere to put it; a test holds
those two together over a whole layout.

**One unstable array is all it takes.** The rows that want a lane feed the
document, the document decides the geometry, the geometry decides the viewport,
and the viewport is reported back up — so a dependency that is a fresh object
every render is not a wasted memo but an infinite loop, and it showed up only at
the bottom of a whole chromosome. `useSequenceClasses` returns one frozen empty
array for a focus with no reading frame, for the same reason `EMPTY_OVERLAPS`
exists.

**Translated on the client, from what is already on screen.** `cdsFrame` gives
each CDS segment's offset in spliced coding sequence and the buffer holds the
bases; asking the backend for a protein would be a second description of the same
thing, arriving at a different time and able to disagree with the stripes the
frame already draws.

The three bases of a codon are gathered **by spliced offset, not by adding to a
coordinate**. A codon straddling an exon junction has its halves hundreds of
kilobases apart, and reading genomically from the middle base would translate an
intronic base instead. `spliceIndex` holds the segments ordered both ways -- by
coordinate, to ask what offset a base is at, and by offset, to ask what
coordinate an offset is at -- and is cached on the frame array itself, so a row
repainted while the reader scrolls re-uses it.

Two rules about what is *not* drawn:

- **A codon whose bases have not all arrived is blank, not `X`.** It is a loading
  state, and an X there would read as an annotation about the sequence.
- **A codon with an N in it is `X`, not blank.** It is still a codon, and
  blanking it would read as the end of the coding sequence.

On the minus strand the bases are complemented and the offsets fall as the
coordinate rises, both of which `strand` settles here; the display orientation is
applied afterwards by `orientRowForDisplay`, which flips the lane without
complementing it -- the middle of three is still the middle read either way.

**The lane appears only where one reading frame is being read**: a transcript, an
exon or an intron in focus, or transcript and exon records in a collection. A
gene has as many frames as it has isoforms and a location as many as it has
genes, and the menu says so rather than drawing an empty lane.

### Reading it the other way round

Reverse complement is a switch on top of the reading direction the annotation
already implies, not a replacement for it: `reverse = natural !== toggle`. A gene,
a transcript or one of their features is read in its own direction, which on the
minus strand means from the far end; a location is a stretch of chromosome and is
read forward. So the switch means *the other way round from what I am looking at*
on both strands, rather than meaning nothing on one of them, and the menu's own
wording says which of the two it will do here.

Nothing about the colours changes: `orientRowForDisplay` flips the sequence, its
classes, its marks, its protein and any selection together, so a codon stays a
codon and a splice site stays a splice site over the bases they belong to.

### Codons and splice sites are verified, not assumed

All of them come from `_build_tx_feature_intervals` (`backend/main.py:12614`),
which emits a start codon only where the bases read `ATG`, a stop only where they
read `TAA`, `TAG` or `TGA`, and a splice site only where the dinucleotide is
canonical `GT`/`AG`. A non-canonical junction is therefore not marked, silently.

## Selecting bases

Armed, not always on: the button carries the dashed rectangle every other view
in the app arms a selection with, and shows it is in hand with the browser's
inset ring. A drag with the tool down does nothing, which leaves the gesture
free for whatever else may want it later.

**What is shown while dragging is the selection itself, not a rectangle.** A
rectangle is what the hand does; it is not what gets selected, and drawing both
meant two shapes disagreeing with each other on screen — the box narrow while
the selection ran to the end of the row. The highlight follows the pointer
instead, so there is one shape and it is the true one.

Dragging down takes the base clicked and the rest of its row, every row crossed
whole, and on the last row everything up to the base let go of. Dragging up is
the mirror: the base clicked and everything to its *left*, then the rows
between, then from the release base to the end of its row. A drag inside one row
is just the span between the two points.

None of that is written out anywhere. The selection is held as a **range of
display columns**, and the columns between two points already run to the end of
one row, across the rows between, and up to a point on the last. Dragging up is
the same range with its ends the other way round, so it needs no case of its
own. And a collapsed stretch's marker, having columns of its own inside the
range, comes along without being asked.

### The outline, and the dimming around it

The amber edge is the alignment explorer's, so a selection means the same thing
in both views: a line around the whole of the chosen cells. What is *inside* the
line is left exactly as it was — a wash over the selected bases is the one thing
that cannot be done to a view whose subject is what colour a base is, because
every annotation under it comes out a different shade of the selection. The
region is shown by taking the light off everything else instead: the bases
outside it drop to `DIMMED`, the same 0.22 the pointer's feature dims by, so the
two readings of the page look like one mechanism rather than two.

**The dimming starts with the gesture, not when it finishes.** It used to wait
for the release, on the reasoning that the page going dark under a moving hand
was one thing too many at once. In practice it meant dragging across an unchanged
page and only seeing what had been taken after letting go, with no way to correct
the far end while it was still yours to move. Now `selecting` is simply whether
there is a selection at all, so the stretch lights up from the first move and the
reader is choosing against what they can see.

**It holds for the half-made two-click selection too.** Between the two clicks
the pointer carries the loose end: `extendPending` moves it on every hover, the
anchor stays where the first click put it, and the outline and the dimming grow
with it. The second click therefore lands on a region already on the screen. As
with a drag, an end that has wandered into another record is refused rather than
clamped — see *A selection stays in one record*.

**The amber sits at the bright end of what used to be a swing.** The edge
breathed once, on the same clock as the hover tint, because a fixed amber at the
weight the explorer uses is nearly invisible over a mixed pink or a CDS blue —
those cells are already carrying a colour. The movement went with the clock — see
*Pointing at a row in the list* for what it cost — and the alphas left behind are
the ones `prefers-reduced-motion` already settled it at.

**Rows dim whole wherever they can.** Opacity is a transparency layer the
compositor keeps, and sixty cells a row over forty rows is two thousand of them,
which is what once turned scrolling with a gene held into a slideshow. Almost
every row is wholly in the selection or wholly out of it, so it carries one
opacity; only the two rows an end falls inside are decided cell by cell.

`selectionMask` gives each selected cell a hex digit saying which of its four
sides the region's edge runs along — a side gets an edge where the neighbour is
not also selected. The cell above and below are one row's width away in column
space, so a row between two selected rows carries no horizontal rule at all and
a multi-row selection reads as one shape. That is the explorer's rule, where the
comment reads: *an edge drawn around each drawn piece would cut the region into
parts the reader never made.*

The ends of a row always carry an edge, because the selection turns there rather
than running off the side. Together those two rules draw the staircase:

```
          ┌──────────────────────┐        the click base, and the rest of its row
┌─────────┘                      │
│                                │        a row crossed whole: no rule through it
│                    ┌───────────┘
└────────────────────┘                    up to the base let go of
```

### What a marker does to a drag

Passing over one leaves the head where it was — there is no coordinate under it
to move to — so the selection jumps the collapse in one step.

### Scrolling past the edge

Held **past** the top or bottom of the sequence, the view scrolls on so a
selection can reach further than what is on screen. Past, not near: the trigger
used to be a band a few dozen pixels *inside* the edge, so a drag that began
near the bottom started scrolling the moment it was pressed and moved the
sequence out from under the pointer before anything had been drawn.

It runs on a frame loop keyed to how far past the edge the pointer is, and keeps
going until the pointer comes back inside or the drag ends — not until the
pointer next moves. Keyed to the pointer's movement, it scrolled a little and
then stalled, because a pointer held still outside the sequence is over no cell
and reports nothing. Each frame it also re-reads what is under the held pointer
and extends the selection, which is the point of scrolling at all.

### Why the sequence used to twitch on click

`region` was rebuilt as a fresh object whenever `focus` changed, and a drag
changes `focus` on every pointer move. A new region meant a new layout, and a
new layout is what puts the reader back at their anchor coordinate — which snaps
the scroll to a row boundary. So every press, every move and every release
nudged the sequence by up to a row.

It is now built from its two numbers and memoised on them, so it keeps its
identity while they hold. The re-anchoring still fires when the layout genuinely
changes, which is what it is for: collapsing the introns moves every coordinate
to a different row, and the reader should stay where they were.

## Collecting records

Every list in the panel has a tick beside each row, and every tick means the same
thing at every level: **collect this as a record.** Genes are ticked off a
location, transcripts off a gene, exons and introns off a transcript. The view
then draws what was ticked — each record headed by its name, the way a FASTA file
stacks its entries — in the order they were ticked, because the reader built the
list and it is theirs to have in the order they made it.

The tick and the row are two different acts, deliberately. Ticking collects;
clicking the row reads *into* it, so that what is below it can be listed in turn.
A transcript is to a gene what a gene is to a location.

**A plain region is a document of one unnamed record.** That is why there is no
second code path for the ordinary case: the canvas draws a document either way,
so the collection code runs on every row the view has ever drawn. The same choice
`sequenceViewDisplay` makes about full and collapsed sequence, for the same
reason.

Rows are counted across the whole document, so the scroller is unchanged — one
row space, a fixed row height, a proportional map from scroll position to row.
A heading costs a row like any other, which is why it is one row tall and not a
taller band: a heading of a different height would put a second case into the one
piece of arithmetic the whole view rests on.

### Picks belong to what they were picked from

Tick two transcripts of one gene, open another gene, and they are gone: they
described the first gene and mean nothing under the second. `pickScope` is the
identity of the parent — the region for genes, the gene for transcripts, the
transcript for exons and introns — and a pick set carries the scope it was made
in, so a stale set is recognised rather than remembered.

While anything is ticked the collection replaces the plain view, and the open
section says so with a way back that does not mean unticking things one at a
time.

### What a record carries with it

Each is a named range plus enough to ask about its annotation: a gene asks at
gene level, a transcript at transcript level, and an exon or intron at `feature`
level *with its transcript*, because its classes are the transcript's windowed to
the feature. `useRecordViews` asks once per record — they are bounded things, so
none of them tiles — on the same annotation queue as everything else, which is
what keeps a collection of forty from occupying the single worker sequence reads
through.

Layouts are built there rather than in the view, so widening the collapse flank
re-lays-out every record at once without asking the backend anything.

### A record is read at its own level

A gene ticked off a location is drawn as a *gene*: coding, UTR, non-coding,
intronic, mixed. That has to be said explicitly because the obvious wiring —
paint everything with the switches of the level in focus — is wrong here, and
wrong in a way that looks like nothing at all. A location's vocabulary is genic
and intergenic; a gene's runs say `coding` and `intron`; the two sets are
disjoint, so every run was dropped and the record came out bare, reading as
intergenic sequence with a name on top.

So the switches travel with the runs. `viewFor(key)` returns a record's runs, its
frame, its strand *and* the class codes it may draw with, resolved together,
because a set of runs only means anything against the vocabulary it was computed
in. `SequenceCanvas` no longer takes a set of allowed classes at all.

The rest follows: the legend under the sequence describes the records' level, the
cog offers that level's switches, and turning one off writes it under that level.
Picks all come from one parent, so they are all the same kind of thing and there
is one such level to name. The flank stepper stays with the focus — it widens the
focus's own window, and a record is its own extent.

### A record is not obliged to fit the window it came from

A gene listed at a location usually runs off both ends of the screen, and one of
those ends can be outside the location itself. The chunk planner refuses chunks
outside the region it is given, so a record reaching past the focus drew as
placeholders for ever — annotated correctly, and with no bases under the
annotation. The buffer is therefore given the extent of the records when there
are records, and the focus region only when there are none.

Widening that extent is not the same as fetching it. The planner asks for what is
on screen and a chunk either side; rows from two distant records reach it as two
separate stretches, which `planChunksForIntervals` keeps separate. The extent is
a bound on what may be asked for, not a thing that gets read.

### A selection stays in one record

Two records can be far apart, or overlap. A range of coordinates across them
describes neither, so a drag stays in the record it began in — and the highlight
is only painted in the record the selection's own coordinates fall in, which
`columnAtCoord` would otherwise happily clamp into the nearest column of a
different one.

### Copying a collection

Each record apiece, in the order ticked, and each carrying the stretches actually
drawn: a collapsed record copies as the sequence with its introns taken out,
because that is what is on screen. `/fasta` takes repeated `seg=start-end` pairs
for that, wraps across the joins rather than per segment — what it describes is
one continuous sequence with the dull parts removed, not a record per exon — and
says `spliced:N_segments -Nbp` in the header, because a spliced sequence does not
match its own coordinate range and a reader pasting it elsewhere has to be able
to tell.

One record downloads straight from the backend, streamed, so a whole chromosome
never becomes a string in the browser. A collection cannot: it is several reads
that have to end up in one file. That is affordable only because the things a
reader ticks are bounded — a gene, a transcript, an exon — rather than the
unbounded region a plain view can be.

## A transcript read in its own coordinates

The sequence view is genomic. A transcript has two other readings a reader wants
to see and copy — its exons joined, and the protein those spell — and neither of
them is a stretch of chromosome. A bar over the sequence switches between all
four, and the panel below it draws whichever is chosen.

### The bar over the sequence

Four readings — **Genomic, Transcript, CDS, Protein** — on a floating bar in a band
of its own between the control bar and the first row, centred on the sequence.
Choosing one changes what the whole panel is showing.

**It was a drawer panel first, and that was the mistake.** The reasoning was the
bar's own rule: a control belongs on the control bar when it is about the
*reading* and in the focus drawer when it is about the *thing being read*, and a
transcript's CDS and its protein are the thing being read. The rule is right and
the conclusion was wrong, because it answered the wrong question. Where a control
*belongs* is not where a reader will *find* it, and these three are not a setting
a reader adjusts once — they are most of why somebody opens a transcript at all.
Behind an icon in a drawer they were, in the first report back, "way too hard to
find".

So it is drawn as the floating pill the selection bar is drawn as — same panel
colour, accent border, radius and shadow — because the two are the same kind of
thing: a control belonging to the sequence rather than to the toolbar. It is not
on the control bar, which would have made it a seventh control among six and one
that meant nothing at a location or a gene.

**It keeps a band rather than lying over the rows**, which is the one place it
differs from the genomic view's selection bar: that one is transient and may
cover a row while it lasts; this is always there, and a bar that permanently
covered the top line would take a row from every reader for the whole time they
read. The scroller starts below it.

At a transcript this bar is the only one: the genomic view is told not to draw
its own (`showSelectionBar`), because two bars would be the same four buttons
twice. At a location or a gene, where this one is absent, the genomic view keeps
its bar exactly as it was.

**Absent, not empty, where there is no transcript in focus.** At a location or a
gene there is one reading, so a bar offering four of which three are unusable
would be a control saying nothing and a band of furniture over every screen of
sequence. The mode falls back to genomic the moment the reader leaves a
transcript, decided while rendering rather than from an effect: a protein of the
transcript they have just left is the one thing the screen must not be showing.

### The reading and the highlight are one bar

They were two floating bars for a while, stacked, and both carried copy and
download — the same two actions differing only in how much they acted on. Two
bars, four buttons, two answers to "copy what?".

Merged, there is **one row of actions**, and what they act on is whether anything
is highlighted: the stretch if there is, the whole reading if there is not. Every
button says which in its own title, so nothing is guessed. The highlight's own
facts are a **second row under the first**, present only while there is one, so
the bar grows rather than something appearing elsewhere.

`Set as the location` and `Show in the genome browser` are on that row too, and
they are the two that are not always available:

| | copy, download | set as location, genome browser |
|---|---|---|
| no highlight | the whole reading | refused — "highlight a stretch first" |
| genomic, transcript, CDS | the highlight | the stretch it covers |
| protein | the highlight | refused |

The protein row is a judgement, not a limitation. A residue *does* have a genomic
span, through its codons, and this view works it out — it is what the tip prints
and what carries the highlight between readings. Jumping a genome browser to it
was judged to read as a non-sequitur, so it is refused, and the title says to
switch to CDS rather than leaving a dead control unexplained. Re-enabling it is
removing one term from `placeable`.

**What the actions act on is the reading's own answer, not the mere existence of
a highlight.** A stretch can be held and have no positions in the reading on
screen; then there is nothing of it to take and the actions fall back to the
whole reading. Keying the titles off the stretch existing made them promise "the
highlighted stretch" and hand over ten thousand bases.

### One highlight, in whichever reading is on screen

The highlight is held once, as a stretch of chromosome. `focus.custom` already
was that for the genomic reading, so the spliced ones write to it rather than
keeping one of their own — which is what makes it survive a change of reading,
and what makes the genomic reading's own selection, the drawer's Selection
section and `Set as the location` go on meaning what they always did.

Each reading works out its own positions from the one range: nothing is converted
from one reading's positions into another's, so there is no pair of readings that
has to agree about anything. `splicedRangeFor` clips a genomic range into a
spliced one and `genomicRangeFor` goes back the other way; `highlightFor` is the
pair applied to whichever reading is current, and for a protein it turns CDS
positions into residues **outward**, because a codon the stretch touches at all
is a codon the reader meant.

The same 2,639 bases of chromosome read four ways:

```
Genomic     13:32,316,521-32,319,159   2,639 bases
Transcript  260-349                       90 bases
CDS         61-150                        90 bases
Protein     21-50                         30 residues
```

A stretch that covers none of the reading on screen — a 5′ UTR highlight looked
at as CDS — keeps its range and has no positions, and the bar says *Not in this
CDS* rather than going blank, which would read as the highlight having been lost.

A genomic stretch spanning an intron clips to what is still there when it becomes
a spliced one: 81 genomic bases across an intron are 27 bases of the transcript.
That is what the reader meant, and refusing it because the ends fall in an intron
would be answering a different question.

### It is the view, not a text box

A spliced sequence gets everything the genomic one has: sixty to a row, a number
down either margin, the annotation in the same colours, a drag to select, a bar
over the selection and a tip under the pointer. `SplicedSequenceView` draws with
`SequenceRow` — the same component the genomic reading uses — which takes a handful
of equal-length strings and knows nothing about what a position means, and it
reports what is dragged upward as positions, which is turned into the one
genomic range every reading shares. That is what made this affordable: a second
way of showing sequence in one application is a second set of answers to every
one of those questions.

**It is mounted under a key of the transcript and the reading**, so moving to
either throws it away and builds it again — which resets the pointer and the
scroll position, neither of which means anything in the next reading. The
highlight is deliberately not among them: it is held above as a stretch of
chromosome and survives the move.

**The legend follows the reading, not just the level.** Its own rule is that it
is a key to what is on screen rather than a catalogue of what the view can draw,
and a spliced sequence has no introns or splice sites left in it, no soft-masking
reported on it, and — for a protein — no nucleotide class at all beyond the two
codons that are marked. `legendGroupsFor` says which groups survive each reading.

**Nothing selectable, whatever the cursor says.** The surface takes the press on
both `pointerdown` and `mousedown`. Preventing the pointer event stops this
element's own default; the browser starts its text selection off the compatibility
*mouse* event, which is dispatched whether or not the pointer one was prevented.
Without both, a drag pulls a document selection along behind the one being drawn,
and it does not stop at the sequence — it reaches up and highlights the toolbar.

What it does **not** borrow is the scroll model, the buffering or the collapsing.
A spliced transcript has no introns left to hide, arrives in one piece, and is
short enough that every row can be placed with a multiply — the longest human
one is TTN's, at about 109 kb, which is 1,821 rows. So `utils/transcriptSequenceView.js`
builds its own rows and the panel windows them; `MAX_SPLICED_BP` (250 kb) is a
guard against a malformed annotation rather than a limit anyone should meet.

The gutters are narrower here (`SPLICED_GUTTER_WIDTH`, 64 px against 92). A
genomic coordinate needs room for nine figures; a spliced position counts to
about a hundred thousand and a residue to about thirty. The width saved goes to
the cells, which grow into it — a protein at 16 px a residue is a good deal easier
to read along than one at 11.

### Positions are not coordinates

This is the one place in the subsystem where a position is not a 1-based genomic
coordinate on the forward strand. A **spliced position** counts from the
transcript's first base, 5′ to 3′, introns already gone — so on the minus strand
it rises as the coordinate falls.

`/transcript-sequence` answers in that space, including its class runs.
`spliced_classes` projects each feature interval through the segment map and
*then* paints it, rather than painting genomically and projecting the runs
afterwards: painting first would decide precedence between features that are
adjacent on the genome and may be far apart once the introns are gone, and the
reader is looking at the spliced sequence. Introns and splice sites project to
nothing, which is how they drop out without a special case — neither is in the
sequence being described.

`genomicRangeFor` and `splicedRangeFor` are the only conversions, and everything
above them talks about positions while everything below them talks about
coordinates — the same discipline `flankSides` keeps for 5′ and 3′. They are
tested against each other over both strands rather than only against fixed
answers, because that is what catches the mistakes worth catching: an off-by-one
or a strand mixed up survives every assertion about a single coordinate and fails
a round trip.

A highlight therefore has two spans that are both true and do not match, and the
bar prints both: the positions a reader drew, which is what the gutters beside
them count, and the genomic stretch those cover, which is longer because the
introns the highlight reads across lie between its ends. Printing only the second
would name a range whose length contradicts the count; printing only the first
would leave a reader nothing to look the stretch up by.

### The protein is translated on the backend

The obvious thing is to hand the client the CDS and let it translate what it
already has. The lane over the codons does exactly that, for the reason in
**The protein over the codons** above. It is the wrong answer here, and the first
version of this panel got it wrong.

There is **one** translation in this application, in `backend/translation.py`,
reached here through the `translate_transcript` provider. It is the only one that
knows a mitochondrial contig uses a different genetic code, that Ensembl renders a
non-ATG initiation codon as M, that a terminal stop is stripped and an internal
one kept, and that a CDS beginning mid-codon starts with an X. A browser-side
codon table gets all four wrong, silently, and would disagree with the protein the
Feature Explorer already shows for the same transcript. On real data the
difference is not subtle: every mitochondrial gene comes out full of stops, and
MYC's CTG initiator reads L instead of M.

The lane and the panel are not the same computation and the split is deliberate.
The lane is per row, over bases already on screen, and its job is to sit on its
codons. The panel is a whole protein a reader will copy, and its job is to be the
one Ensembl publishes.

**A residue's segments are in codon-aligned CDS bases, not in residues.** Residue
*n* is always at positions `3n-2 .. 3n`, which is what lets one residue be mapped
back to the three bases that spell it — and they can be in two different exons,
which the readout says when they are. A 5′-incomplete CDS is padded on the left
by `(3 - phase) % 3` virtual bases precisely so that this stays arithmetic; those
positions map to no genomic base, which is the honest answer for bases the
annotation does not have.

Those segments cover the residues **plus the stop codon**, because the stop is in
the CDS and not in the protein. The obvious assertion is three bases per residue
exactly, and it is wrong by one codon on every complete transcript there is.

### What the bar says in words

A row of sentences under the bar, which is where and why the control bar puts
what it has to say about what it is drawing. Only for the protein, and only what
a reader could not work out from the letters:
a CDS that does not begin with ATG, one that begins mid-codon, trailing bases that
do not make a whole codon, an internal stop, and a non-nuclear genetic code. Each
changes how the residues above should be read, and each would otherwise have to
be inferred from a count that does not divide or from an X that looks like a bug
in the view.

The initiator and every stop are marked in the sequence itself, in the same
colours the CDS reading uses for them. A stop still in a protein from this
application is an *internal* one — the terminal one is already stripped — so it is
a readthrough, a frameshift or a mis-annotation, and it is the single thing in a
protein most worth seeing.

### A highlight, not what the pointer is over

The decision worth recording, because it was made the other way first. The
drawer's lists preview on hover and so did the first version of this. What those
rows preview is a *feature*, a stretch worth marking, and marking anything means
dimming everything else — so mirroring a hover dimmed the whole view in order to
point at one base, and did it again for every base the pointer crossed on the way
anywhere. A highlight is a stretch the reader deliberately drew, so the dimming
is proportionate and lasts as long as they want it to.

What the pointer is over is answered by the tip — the same `SequenceHoverTip` the
genomic reading uses. For a spliced reading it leads with the position, then the
letter, then where that lands on the chromosome and in which exon, because the
position is what the gutters beside it are counting.

**Dragging needs no tool here.** The genomic reading arms a rectangle first,
because a drag there might have meant something else; in a spliced reading it
could not, so a drag is always a highlight.

### What is on offer

Genomic always. The other three need a transcript in focus, for the same reason
the protein lane appears only where one reading frame is being read: a gene has
as many readings as it has isoforms, and a location as many as it has genes.

The two coding readings stay available until an answer actually says there is no
CDS, and then both go together, because they are one fact about the transcript
rather than two about the readings. Not guessed from the biotype: a transcript
annotated protein coding whose CDS is missing is a real thing, and so is a
non-coding biotype the annotation gives a CDS to. `modeOffer` is the one place
that is decided, and it answers with the reason as well as the verdict — which is
what a control that cannot be used says in its title.

A reader sitting on a coding reading when an answer says there is none is put
back on the transcript, rather than left looking at a message where a sequence
was.

### One fetch, two readers

`useTranscriptReadings` holds the answers a level above both the bar and the
surface. The bar prints how long each reading is and greys what is not on offer;
the surface draws whichever is chosen. A store inside the surface would have left
the bar unable to see it, and two stores would have fetched everything twice.

Only the reading being drawn is fetched. The other two are a request each that a
reader who never switches would never need, and the bar says nothing about a
length it has not been told rather than a nought — which would be a claim that the
transcript has none.


## How the small facts are written

The same three facts — what kind of thing it is, which strand it is on, how long
it is — appear in the gene list, the transcript list, the record headings, the
box a click opens and the hover readout. They were being written five ways:
`Protein-coding` in one place and `protein coding` in another, a bare `+` here
and `+ strand` there, and middle dots between them in some lists and not others.
`utils/sequenceViewLabels.js` is the one answer:

- **A biotype is the annotation's own word, lower case, underscores as spaces.**
  `protein_coding` is "protein coding" everywhere. Words that carry an acronym
  keep it — lncRNA, snoRNA, TEC, Mt tRNA — because those are not the same words
  in lower case. Only an ordinary capitalised English word is lowered.
- **From the raw biotype, not from a display class**, so the list and the box say
  the same thing about the same gene. The four display classes are a different
  question, and `geneBiotypes.js` answers that one.
- **A strand is "+ strand" or "- strand"**, never a bare sign.
- **Facts are separated by space, not punctuation.** Where the markup is ours
  they are separate spans with a gap; `metaText` is the fallback for the places
  that can only hold a string. A row of middle dots is furniture: it takes a line
  that reads as three facts and makes it read as one sentence with something
  missing.

A fact that another fact already implies is left out: a protein coding transcript
no longer says "protein coding coding 3 exons", which is what happens when each
fact is added by someone who cannot see the others.

**The lists are squared off against their headings at both ends.** A tick lines
up with the "G" of GENES rather than with the drawer's edge — a checkbox brings
its own margins, so those are cleared — and the eye at the other end is pulled
right by the heading's own padding, so the column of eyes runs from the heading
down through every row it governs.

## Levels of focus

Not a nested menu. The focus is a stack of identities — a location, a gene on it,
a transcript of that gene, an exon or intron of that transcript — plus a pointer
at whichever is being read. Descending sets the child and moves the pointer;
ascending moves the pointer only, so the child is still there and coming back
down is free.

In the drawer, position *is* level: the sections stack outermost first, the list
you drill into lives inside the section you are already in, and the levels above
are how you come back out. There is no breadcrumb and no back button because the
stack is both.

### The chevrons fold sections

Each section heading carries a chevron, and it means what it looks like
everywhere else: **down is folded and opens, up is open and folds.**

They used to do what the row beneath them does, which is move the focus. That
made the one on the open section a dead click — it pointed up, which everywhere
in the world means *fold this away*, and did nothing at all. On a section with
nothing chosen it is inert, and says so.

Only one section can be open, because that is what position-is-level means: the
list inside a section is the list of what is inside *it*, so opening another one
is reading into it. The chevron of a section that is not being read therefore
expands it **and** moves the focus there; the chevron of the one being read folds
it away and leaves the focus alone, with the band at the top still saying where
the reader is.

**The heading of the level being read is ringed in the accent.** Four sections
stacked look alike at a glance, and which one the reader was inside was said only
by the band at the top and by which one had a list under it — neither of which is
where the eye is while it is going down the stack. The ring and the label take
the colour the chevrons are drawn in, so the two marks agree.

It follows the *focus*, not the fold: folding the active section hides its list
without moving the focus, and the ring is then the only thing left in the list
saying where the reader is. Drawn as an inset shadow rather than a border, and
the heading's margin and padding add up to the eight pixels its label already sat
at, so nothing moves when it appears.

**A ring means chosen; a fill means the pointer is here.** The row a level is
reading — the gene populating the GENE section, the transcript populating the one
below it — carries the same accent ring its section heading does. It used to
carry a filled box instead, which is the mark the pointer leaves as it goes down
the list: two pixels between `#2b3a55` and `#273449`, so *this is the one the
section below is about* and *your cursor is here* looked alike. They are
different questions, so they are now different marks, and a chosen row still
takes the fill while the pointer is on it, because both can be true at once.

**A fold lasts while the reader stays put and no longer.** Arriving somewhere and
being shown nothing is a drawer that has silently stopped working, so any move to
another level opens it again, however the reader got there — a chevron, a row,
the base box, a search. Keeping the fold against the level it was made at was not
enough: folding a gene, stepping up to the location and coming back brought the
fold with it, so the chevron that said *expand* did not. It is reset while
rendering rather than from an effect, which is React's own answer to state
derived from a prop; an effect would commit the stale fold and then correct it,
a second render for every move the reader makes.

The panel is the genome browser's focus drawer, not something that resembles it.
It takes the same widths (`FOCUS_DRAWER_WIDTH`, `FOCUS_DRAWER_RAIL_WIDTH` from
`FocusGeneDrawer`), the same accent band across the top with the toggle on the
left and the region on the second line, the same uppercase section headings with
a rule and a count, and the same 36 px rail when it is collapsed. The chrome they
share is in `components/focusDrawerStyle.js` and `components/focusDrawerChrome.jsx`
— written out for this drawer, since the two older ones each carry their own copy
and moving them is a separate change.

The settings panel is a wide slot in the same sense: the drawer widens and the
panel sits beside the list rather than covering it.

An ad-hoc selection has no parent and no child, so it is pinned at the foot of
the drawer rather than inserted into the stack, and dismissing it returns the
pointer to wherever it was. It goes when the reader moves to another gene or
transcript, because its coordinates would be off screen.

Flanking sequence carries no class — it is outside the thing in focus, and
describing it as intronic would be wrong.

**How much of it there is, is two numbers, not one.** The Feature menu carries a
5' and a 3' amount for each kind of thing that can be in focus: 60 bp either side
of a gene and of a transcript, 10 bp either side of an exon or an intron. A
location has none — it is already a stretch whose ends the reader chose.

They are named for the ends of the *feature*, not the ends of the screen. A
reader asking for a promoter is asking for the 5' end whichever strand the gene
is on, and one symmetric number made them ask for twice as much sequence as they
wanted in order to get it. `flankSides` is the one place the pair becomes a low
and a high coordinate; everything above it talks about 5' and 3', everything
below it talks about coordinates. The backend does the same conversion in
`apply_strand_flanks`, because it is the party that knows the strand.

`/classes` takes `flank5` and `flank3`, each falling back to the older symmetric
`flank` when it is not sent — so that parameter still means what it used to on
its own.

## API

All under `/api/sequence-view`, from `backend/sequence_view/`, wired in
`backend/main.py` immediately after the alignment explorer's router. The package
never imports `main`; it is handed the eight functions it needs, each as a lambda,
because all of them are defined further down that file than the `include_router`
call.

| route | what |
|---|---|
| `GET /sequence` | one window, ≤100 kb, `softmask=1` to report repeats |
| `GET /classes` | the runs above, for one focus; `flank5`/`flank3` widen its window at the 5' and 3' ends |
| `GET /base` | everything known about one base: the genes on it, and what each of their isoforms calls it |
| | both take `hide=` — the features to leave out of the answer |
| `GET /focus/genes` | how many genes the region holds, and which ones are worth offering where the reader is |
| `GET /focus/transcripts` | a gene's transcripts |
| `GET /focus/features` | a transcript's exons and introns, numbered 5′ to 3′ |
| `GET /spans` | where the genes are and where their exons are, so the client can work out what to collapse |
| `GET /search` | a gene or transcript by symbol or identifier |
| `GET /transcript-sequence` | one transcript in its own coordinates: `kind=transcript\|cds\|protein` |
| `GET /fasta` | the focused region as plain FASTA, streamed; `download=1` for a file |

**Soft-masking is kept as runs, not as case.** The assemblies are soft-masked and
`/api/browse/sequence` discards that with `.upper()`. Here the runs are computed
from the original case and the sequence is then upper-cased, so every consumer of
the bases is unaffected while repeats remain available as one more overlay. It is
off by default. `/api/browse/sequence` is left alone: its `.upper()` is
load-bearing for the browser's own sequence track.

**A genome with no annotation is a state, not an error.** A location focus on a
FASTA-only genome answers `annotation: "absent"` with no runs, and the sequence
still reads. A genome whose index is still building raises 425, which reaches the
client as a retryable error the scheduler backs off on.

FASTA is written server-side rather than assembled in the browser, so copying a
2.5 Mb gene does not depend on which of its chunks happen to be cached. Its
header matches what the location drawer writes, so one pasted back into the
search box returns to the same region.

### Why the spans are their own request

`/spans` is not derived from `/classes`, for two reasons. A location focus tiles
its classes around the window, so it never holds the whole region's shape -- and
the shape is what decides how many rows there are, so nothing can be drawn until
it is known. And the layout has to arrive whether or not the annotation queue is
busy.

It answers the annotation and nothing about the reader's choices: which kinds to
collapse, how much of each stretch's ends to keep and how short a stretch has to
be to be left alone are all the client's, so moving any of those controls
re-lays-out the view without asking anything here. The answers are cached on disk
beside the class runs, keyed the same way plus the payload's own shape.

### Listing genes on a region

A region can be a whole chromosome: human chromosome 1 carries 7,090 genes. A
count on its own says nothing about what is under the cursor, and a list of seven
thousand is not a list, so `/focus/genes` answers both questions separately. The
**count is of the whole region**; the **list is of the window** — the rows
actually on screen.

A screenful is about two kilobases, so the window is usually between genes.
Rather than showing nothing exactly when a reader wants somewhere to go next, the
list is topped up to `NEAREST_GENES` (ten) with the closest genes either side,
found by two index scans rather than by sorting the region — genes are indexed on
both their start and their end. The top-up never reaches outside the region.

The window is quantised to 2 kb before it becomes a request, so scrolling a row
at a time does not re-ask for a list that would come back the same.

Each row names the gene's class using the browser's own four groups
(`utils/geneBiotypes.js`), its strand and its span — `lncRNA + (16 kb)` — then how
far away it is and which way — `5.2 kb ←` — and finally the browser's re-centre
mark, which puts the start of that gene at the top of the screen. On the minus
strand that is its higher coordinate, because reading runs 5′ to 3′.

The distance is measured from the coordinate at the top of the window to the
nearer edge of the gene, so a gene the reader is already inside reads `here`.
Left and right mean back and on along the forward strand — the direction the rows
run at location level — and not the gene's own reading direction.
`utils/sequenceViewDistance.js` is pure arithmetic on two numbers, which is why
it can follow every row scrolled while the list itself deliberately does not.

#### Keeping the list still

The list is asked again as the window moves, and that is what makes
`useFocusChildren` more than a fetch. Two rules:

- **Never blank.** While a reply is in flight the rows on screen stay exactly as
  they are. What is shown is the previous window's answer, or — stepping back up
  a level — the answer that level gave last time the reader was here, kept in a
  small `REMEMBERED` map. Both are very nearly the list about to arrive, and both
  are better than nothing.
- **Only redraw on a difference.** A reply whose rows would draw the same is
  answered by keeping the existing array, so nothing below re-renders.

Each list carries an *identity* coarser than its request: a location's genes are
identified by the region, not by the window within it, so scrolling is a refresh
of a list the reader is already looking at; a gene's transcripts are identified
by the gene, so one gene's transcripts can never appear under another's heading.
Requests for a list of the same identity wait `SETTLE_MS` for the scrolling to
stop; a different identity is something the reader cannot see yet, and goes at
once.

Emptying the list mid-flight was not only a flicker. A button removed between
the press and the release never sees a click at all, so the re-centre mark
appeared to do nothing perhaps one press in three — which is what sent us looking
at the jump, when the bug was in the list.

Ticking a gene collects it as a record — see **Collecting records** above. The
ticks hold the whole gene rather than its id, because the list only offers what
is near the rows on screen and a record has to outlive its row scrolling away.

`/classes` at location level returns no gene list at all. It is tiled against the
region and so does not know where the reader is looking; its runs cover every
gene in the tile however many there are.

### Searching

One box takes both: coordinates, or a gene symbol, gene ID or transcript ID. It
carries the same magnifier button as the browser's search, beside the return key
rather than instead of it, and the button shows a turning mark while the question
is out — a search that takes a moment and says nothing looks exactly like a button
that did nothing. What was found is named when the view lands on it.

Coordinates are answered in the view. A range already inside the region on screen
scrolls to it rather than reframing, so the region does not shrink to the jump; a
bare coordinate is centred on a screenful; a chromosome named in the query
crosses to it, which clears the focus chain, since a gene from the old
chromosome means nothing on the new one.

Anything else is a question for the annotation. `/search` tries an exact symbol,
then an exact identifier, then a prefix — a substring match is never offered,
because "MT" should find MT rather than the four hundred genes with MT in the
middle of their names. A region in view breaks a tie between genes of the same
name on different contigs but never excludes a match.

A match **moves the focus onto the thing found** — a gene to gene level, a
transcript identifier to transcript level — which is what shows its annotation,
rather than leaving the reader on a stretch of genome to find it themselves. Its
edges are marked as well, so it is still visible if they step back up to the
location.

### Copying versus downloading a whole chromosome

The amount asked for is not bounded by anything the reader can see: a location
focus can be human chromosome 1, which is 249 Mb, or 253 MB of FASTA.

Reading that was never the problem — pysam does the whole chromosome in under a
second. Two other things were:

- **Holding it.** Assembling the sequence, joining it and wrapping the join cost
  about five times the payload: 50 Mb of sequence took the API process from 236
  to 487 MB, which extrapolates to some 1.25 GB for chromosome 1. So `/fasta`
  streams. It reads `FASTA_STREAM_BP` at a time — a multiple of 60, so a piece
  boundary is always a line boundary and each piece can be wrapped on its own —
  and yields it. Measured on chromosome 1: 253 MB produced in 0.6 s, peak RSS up
  by 1 MB. On the reverse strand the pieces are taken from the far end backwards
  and complemented individually, which is the whole region's reverse complement
  because `revcomp(A + B) == revcomp(B) + revcomp(A)`.
- **The clipboard.** 253 MB is a string half of what V8 will hold at all, and
  more than most things a reader might paste into will survive. That is a limit
  on the destination, not on the data, so it is enforced as one:
  `MAX_CLIPBOARD_BP` is 20 Mb — comfortably more than the largest gene there is —
  and past it `/fasta` answers **413** with a message naming the size, the limit
  and the alternative. The view shows that message rather than one of its own,
  and puts the download button next to the copy button so the alternative is one
  click away.

A download has no such limit, because nothing ever holds the whole of it: the
backend streams, and the browser writes it straight to a file.

### Caching

Class runs are cached, schema-versioned on disk with a bounded map in front
(`backend/sequence_view/cache.py`). Working out a gene's classes means reading
every isoform out of a JSON blob and resolving the overlaps, and a reader moves
between a gene and its transcripts repeatedly.

**Bump `SCHEMA_VERSION` whenever the payload changes shape.** It is not a nicety:
an old entry is returned verbatim, so a new field arrives empty and a changed
meaning arrives wrong, on exactly the machines that have used the view before —
which is every machine that matters. Drawing a location in the gene classes took
it to `v2`.

**Sequence is not cached, deliberately.** pysam on a bgzipped FASTA is about a
millisecond for the 12 kb the view asks for, and the operating system's page
cache already holds the blocks. A disk cache of raw sequence would be a second,
staler copy of the FASTA.

## Not yet built

- **The same readings for an exon.** A coding exon's own residues are the obvious
  next thing, and the projection and the segment map already answer it; what it
  needs is a decision about the partial codons at each end, which belong as much
  to the neighbouring exon as to this one.
- **RTF download.** There is no rich-text export anywhere in the app yet.
- **Acting from the base box.** It reports; it does nothing. Switching a class
  off from it, or focusing the gene under the cursor, would both fit.
- **Variants**, which want the same extra-lane mechanism the protein uses.
- **The protein over a gene or a location.** A reading frame belongs to one
  transcript — a gene has as many as it has isoforms — so the lane appears only
  where exactly one is being read. Showing one there means answering which
  isoform wins, which is a different question from this one.

## Tests

```
cd frontend && npm test          # node --test over the pure modules
python -m pytest backend/tests -q
```

The pure modules carry the load: `sequenceViewScroll`, `sequenceViewRows`,
`sequenceViewChunks`, `sequenceViewClasses`, `sequenceViewFocus`,
`sequenceViewLayout`, `sequenceViewDistance`, `sequenceViewPalette`,
`sequenceViewDisplay`, `sequenceViewPaint`, `sequenceViewDocument`,
`sequenceViewPicks`, `sequenceViewPopup`, `sequenceViewProtein`,
`sequenceViewPrefs`, `sequenceViewHeights`, `sequenceViewColours`,
`sequenceViewHidden` and `transcriptSequenceView` on the frontend;
`test_sequence_view_classes`, `test_sequence_view_windows`,
`test_sequence_view_spans`, `test_sequence_view_spliced` and
`test_sequence_view_api` on the backend. The API tests drive the endpoint
coroutines directly with a throwaway SQLite database, in the house style, and
pass `main`'s real derivation functions rather than stand-ins — those are the part
that verifies codons against the sequence, and a fake would prove nothing.

The document tests hold the same kind of invariant one level up: every row of a
document resolves to exactly one thing, and none resolves twice.

Hiding is tested where it actually happens — in the runs. A hidden gene's
`mixed` is gone and the sequence it alone covered is intergenic again; a hidden
isoform stops contesting its gene; a gene with everything hidden is intronic; and
the box still agrees with the view, coordinate by coordinate, while things are
hidden. `sequenceViewHidden.test.js` holds the set arithmetic, including the one
that is easy to get wrong: *all hidden* is false for an empty list rather than
vacuously true, or a section with nothing in it would offer to show everything.

`/base` is tested against `/classes` rather than against a fixture: for a row of
coordinates, what the box says must equal the class the view drew there. Its
other tests are the rules it inherits — an isoform that does not reach the base
is absent from the list, a UTR is 5′ or 3′ by reading order, and an exon is
numbered as `/focus/features` numbers it.

The location tests hold the two-pass rule from both ends: a lone gene at a
location reads exactly as it does at gene level, and two genes disagreeing about
a base make it mixed while two agreeing do not. `gene_overlap_spans` is tested
separately, because depth is arithmetic that a nested gene or one reaching in
from outside the tile gets wrong quietly.

The paint tests hold the one that bit: a set of runs drawn through another
level's switches comes out blank, and no level's switches describe another
level's classes — which is why the pair has to be resolved together rather than
passed down two different routes.

Two invariants the layout tests hold, because a collapse breaks quietly rather
than loudly if either goes: every drawn column maps to a **distinct, increasing**
coordinate, and a row's pieces and markers **cover its columns exactly once** --
no column claimed twice, none left unclaimed.

The sharpest end-to-end check is that the CDS segments in `cdsFrame`, assembled
in coordinate order and read off the real assembly, translate cleanly: start
`ATG`, end with a stop, and no internal stop codon. If the frame or the segment
coordinates are wrong by one base, that fails immediately.
