# Track Manager tutorial — implementation plan

Written 13 September 2026. Companion reading: [TUTORIALS.md](TUTORIALS.md) for the
architecture and the step schema, [custom-genome-tutorial-plan.md](custom-genome-tutorial-plan.md)
for the closest precedent — it also had to build its whole target surface from nothing —
and [tutorial-builder-genome-playlists-handoff.md](tutorial-builder-genome-playlists-handoff.md)
for the traps. The brief is the author's, reproduced in §1.

## 1. The brief

> Introduce the track manager, get the user to go into that view, highlight the different
> bits in the view and highlight that you can add tracks or you can see what's in the
> registry. Then start by getting the user to add some tracks based off our local demo
> data — an ATAC-seq track, a VCF track, and the expression track. Register these demo
> tracks. Then switch to the genome browser and add these tracks to a genome, show them
> and zoom in and out of each and give some information on each track.
>
> Use the same demo region in human as the genome browser in-depth tutorial. I have local
> files registered in Ensembl Go already for GRCh38 that work on that slice — take the
> same regions of the VCF, the ATAC-seq track and the brain expression BigWig and make
> equivalent slices. Check they're not too big for committing to GitHub; if they are,
> reduce the region further, to maybe one or two genes.
>
> Show how they add the tracks in the genome browser once registered, switch tracks on and
> off, pan and zoom. It's different for the VCF — there are different detail levels when
> you zoom in further, so show a full zoom to base level. For the expression one it'd be
> nice to focus in on a couple of exons of a gene where the expression lines up well, and
> the same with the ATAC-seq. Probably the same gene. For the VCF, when you mouse over the
> elements zoomed in you see the lollipops and individual SNVs, and if you click them or
> the deletions you see the anchor base and what's highlighted. Show that there is metadata
> and highlighting around the zoomed-in track.
>
> For the expression one, it's a zoned heat map showing different orders of magnitude, so
> highlight that there are these different levels, and the colour coding from lighter
> yellowy-orange to darker orange helps signify it. The ATAC-seq is straightforward — a
> normal plot of peaks — so requires less explanation.
>
> For the track hub registry, just scroll down and say that it also links to the Track Hub
> Registry, and if your genomes have files registered there you can import them.
>
> Once they've added the tracks, highlight that the left-hand panel can be used to control
> the tracks, turn them off, and grab and reorder them — but don't do anything past that.
> Then outro.

### Three decisions taken with the author before planning

**The ATAC-seq track is a BigWig, not a BED.** The brief guessed "bed, VCF and BigWig",
but the registered file on disk is `atac_seq_adrenal_gland_m_54_y.bw`, and there is no BED
anywhere in the user's `local_data`. Keeping it as a BigWig is also the better lesson: the
app's own `BIGWIG_DATA_TYPES` gives ATAC-seq a `signal_plot` default and RNA-seq a
`zoned_heatmap` one, so the same file type renders two completely different ways depending
on a choice the registration wizard *forces* the reader to make. That choice earns a step.
The third rendering is the VCF. So: three tracks, two file types, three renderings.

**The track window is 220 kb, not the browser tutorial's 1.68 Mb.** Measured, not guessed —
see §3. The genome is unchanged.

**The VCF metadata panel is reader-driven, not tutorial-driven.** It opens on a canvas
click, which a tutorial cannot perform through a target contract, and the author chose not
to build a selection adapter for it. The consequence is a rule, not a preference: the card
on that step **may not assert that the panel is open**, because a card must only describe
state its `arrive` establishes. It zooms to base level, leaves the canvas live, and
describes what a click will show.

### What the brief does not say, and is added

| Added | Why |
| --- | --- |
| An intro card and a review card, plus `completionBody` | Required of every tutorial |
| A whole-region card for the wizard, the file browser and the track picker when each opens | The whole-then-parts rule. Jumping from "press Add Track" to a ring around one field loses the reader |
| A result beat after each Register, and after the three tracks are added in the browser | The result appears in a list some way from the button that caused it — the canonical case for a result step |
| A step on the **Genome association** field | Not in the brief, and the flow silently fails without it: a track with no genome is registered but never drawn. The field's own help text says so |
| Compressing tracks 2 and 3 | The wizard is taught once, in full, on the expression track. Repeating eleven steps twice more would be a form, not a demonstration |

## 2. The data

Generated by [`backend/scripts/build_demo_tracks.py`](../backend/scripts/build_demo_tracks.py),
deterministic, into `backend/data/demo_tracks/`. Sliced from three real GRCh38 tracks the
app itself has registered; the sources are not in the repository.

| File | Type | Content | On disk |
| --- | --- | --- | --- |
| `brain_expression.bw` | BigWig, RNA-seq | 4,504 intervals | 25 K |
| `atac_seq_peaks.bw` | BigWig, ATAC-seq | 13,145 intervals | 65 K |
| `variants.vcf.gz` (+ `.tbi`) | VCF, tabix | 81,830 variants | 888 K |
| | | **total** | **988 K** |

**The window is `1:119,600,000-119,820,000`** — 220 kb holding ZNF697, PHGDH, HMGCS2 and
REG4 whole, with PHGDH roughly in the middle.

**The genome is `grch38_reg4`, reused unchanged.** It already ships for the browser
tutorial, so this adds no genome bytes, and a reader who has done that tutorial is being
taught one new thing rather than two.

**Why not the whole 1.68 Mb slice.** The same window of the source VCF holds 648,191
variants and comes to 7.08 MB bgzipped — roughly four times the entire existing tutorial
data budget, for one file. At 220 kb it is 0.91 MB. The two BigWigs are cheap either way
(0.70 MB for the full window) but are cut to the same window so the three tracks begin and
end together rather than at three different places.

**The consequence to state in a card:** the tracks cover 220 kb of a 1.68 Mb browsable
range, so a reader who pans outside that window sees empty track. The tutorial says so
rather than letting it read as broken.

**Coordinates are real.** Both BigWig headers declare chromosome `1` at its true length of
248,956,422, and the VCF contig is `1`, so every feature answers at its true GRCh38
coordinate. The source files must use `1` and not `chr1` — the build script asserts this
rather than renaming, because a track whose chromosome does not match the genome's draws
nothing at all, silently. (`RegBuild.bb`, the only other candidate track on this machine,
fails exactly that test.)

## 3. Every factual claim the cards make, and how it was checked

Measured against the **sliced** files, which is what the reader sees.

| Claim | Checked |
| --- | --- |
| The zoned heatmap's four bands are decades — 100, 1,000, 10,000, 100,000 | `ZONED_THRESHOLDS` in `GenomeBrowser.jsx` |
| RNA-seq colours run yellow → orange → dark orange → red | `BIGWIG_DEFAULTS.rna_seq.zoned_colors` = `#f7cd61 #f4a940 #ea7a2d #cc2f1f` |
| Brain expression reaches 1,440 over PHGDH's exons, filling three of the four bands | Max over the MANE transcript's 12 exons; exon 5 (119,727,004-119,727,102) is the peak |
| Expression lines up with the exons | Exon maxima 335–1,440, all above the first band |
| **Not claimed:** a clean exon-versus-intron ratio | Intron maxima reach 1,339 — this is RNA-seq carrying pre-mRNA. Stating a ratio would be confidently wrong |
| The strongest ATAC peak in the window sits in the promoter PHGDH and ZNF697 share | Max 6.5 at 119,648,200 — 211 bp from PHGDH's annotated start, 254 bp from ZNF697's TSS; the two genes point away from each other |
| The VCF has five levels of detail | `VCF_BLOCK_LEVELS` — L0 25 kb blocks, L1 500 bp, L2 and L3 100 bp, L4 individual variants |
| Individual variants need a span under about 5 kb | L4 is `minBpPerPx: 0`, L3 starts at 5 bp/px; at ~1,200 px of track that is ~6,000 bp |
| 81,830 variants in 220 kb, about 370 per kb | Counted from the sliced file |
| A 5 kb detail window holds ~1,900 variants — SNVs, insertions and deletions | 1,925 in 119,726,000-119,731,000: 2,048 SNV, 132 deletion, 69 insertion alleles |
| Custom tracks are labelled `CT` in the gutter | `pushSidebarLabelDescriptor(trackId, …, 'CT')` |

## 4. What has to be built first

Nothing in this flow is authorable. `TrackManagerView.jsx` carries **zero** `data-tour-id`
attributes and has no entry in the target catalogue, and neither does the browser's
Add Custom Track button or its track picker.

| To build | Where |
| --- | --- |
| ~30 target contracts | `frontend/src/tutorialTargets/trackManager.js`, plus additions to `genomeBrowser.js` |
| Anchors | `TrackManagerView.jsx` (view, header, Add Track, filters, list, cards, hub section, the whole registration wizard), `GenomeBrowser.jsx` (Add Custom Track, the track picker and its rows) |
| A `trackRegistry` arrival | Which demo tracks are registered, so every step is self-contained and reversible |
| A `trackWizard` arrival | The wizard's own state — same argument as `customGenome`, for a form filled in over a dozen steps |
| A `browserTracks` arrival | Which registered tracks are added to the panel and visible |
| Demo track files in the workspace | `install_demo_track_files`, `POST /api/tutorial/demo-tracks` — modelled on `install_demo_source_files` |
| **A backend sandbox guard** | See below. This is the one that matters |
| Builder editor sections | One per new arrival |

### The sandbox does not cover the track registry

`GET`/`POST /api/tracks` resolve their store through `_load_track_registry(load_config())` —
the **real** configuration on disk, with no tutorial awareness at all. As it stands a reader
who registered the three demo tracks would write three entries into their own
`track_registry.json`, pointing at files in a workspace that is deleted when the tutorial
ends, and they would still be there afterwards.

That is precisely the category `docs/TUTORIALS.md` warns about — "anything that reaches for
`load_config()` rather than for the frontend's configuration" — and `main._notes_config` is
the precedent to copy exactly: while a tutorial session is registered, the tracks endpoints
resolve their store against the tutorial's workspace, and the user's own registry is left
out entirely so the tutorial's list shows only the tutorial's tracks.

The guard belongs at the backend rather than only in the UI, because the backend refusal is
the only one that is not timing-dependent.

## 5. The step table

Eleven sections, ~40 steps. `T` marks a step the tutorial performs, `R` one the reader is
asked to do, `L` look-only.

| # | Section | Title | | Teaches / does | `arrive` needs |
| --- | --- | --- | --- | --- | --- |
| 1 | Getting started | What this covers | L | Intro; Next advances for anyone reading | — |
| 2 | | Open the Track Manager | R | The app button | — |
| 3 | The Track Manager | What it is for | L | Registering files the browser can draw beside the annotation | view |
| 4 | | Add Track | L | The one control that starts a registration | — |
| 5 | | The Track Hub Registry | L | Scrolls down; hubs your genomes have records in can be imported | `pageScroll` |
| 6 | Registering a track | Start a registration | R | Opens the wizard | wizard `none` |
| 7 | | The registration wizard | L | Whole-then-parts: the region, before its parts | wizard step 1 |
| 8 | | Browse for the file | R | Opens the file browser at the demo folder | browser closed |
| 9 | | The file browser | L | Whole-then-parts again | browser open |
| 10 | | Pick the expression file | R | `brain_expression.bw` | browser open, nothing picked |
| 11 | | What it found | L | Result beat: type auto-detected as BigWig, label filled from the name | file chosen |
| 12 | | Name it | R | The label is what the gutter and the picker show | label empty |
| 13 | | What kind of data | R | RNA-seq — and this choice is required before Register will work | no data type |
| 14 | | Zoned heatmap | L | The four decade bands and their colours | data type RNA-seq |
| 15 | | Which genome | R | Without this the track registers and is never drawn | genome unset |
| 16 | | Register it | R | | not registered |
| 17 | | It is in the list | L | Result beat: the card, its type badge, its genome heading | registered |
| 18 | The other two | The ATAC-seq track | R | Compressed: browse, pick, label | 1 registered |
| 19 | | A different kind of signal | R | ATAC-seq → signal plot, not a heatmap. Same file type, different picture | file chosen |
| 20 | | Register it | R | | 1 registered |
| 21 | | The variant track | R | Compressed: browse, pick `variants.vcf.gz` | 2 registered |
| 22 | | Variant colours | L | Genic and intergenic, and the tabix index it needs | file chosen |
| 23 | | Three registered | L | Result beat | 3 registered |
| 24 | Into the browser | Open the Genome Browser | R | | 3 registered |
| 25 | | Add a track to the panel | L | The toolbar button — registering is not the same as showing | browser scene |
| 26 | | The track picker | L | Whole-then-parts; only tracks for this genome | picker open |
| 27 | | Choose all three | R | | picker open, none chosen |
| 28 | | Three new tracks | L | Result beat: they are drawn under the genes, labelled `CT` | tracks added |
| 29 | Reading expression | Go to PHGDH | T | Moves to the gene | locus |
| 30 | | Orders of magnitude | L | The bands, what a filled band means | locus, tracks |
| 31 | | Down to the exons | T | Zooms so exons and signal are side by side | locus |
| 32 | | Where the reads are | L | Result beat: the peaks sit on the exons | locus |
| 33 | Reading ATAC-seq | A plot of peaks | L | Signal plot, and what open chromatin is | locus |
| 34 | | A shared promoter | T | Moves to 119,648,200; the strongest peak, between two genes facing away | locus |
| 35 | Reading variants | Density, not variants | L | At this zoom each block is a count | locus |
| 36 | | The levels change | T | Zooms; blocks get finer | locus |
| 37 | | Individual variants | T | Under ~5 kb the lollipops appear | locus |
| 38 | | Try one | L | Reader-driven: canvas live, describes hover and click. **Asserts no open panel** | locus |
| 39 | Managing tracks | The left-hand panel | L | Switch a track off, drag to reorder | locus |
| 40 | | Where the tracks stop | L | The demo files cover 220 kb of the slice | locus |
| 41 | Wrapping up | What you have done | L | Review card | — |

### Rules this table was checked against

- Every step that asks for an action names its control in `interactionPolicy.targets`.
- Every step that creates something has a predecessor declaring the empty state —
  `trackRegistry: []`, wizard `none`, picker with nothing chosen, `genome` unset.
- Steps 29–40 all declare a locus, so none inherits the view from the step before it.
- Steps 14, 30, 33 and 35 describe what is on screen, so each declares the tracks *and*
  the view that makes the claim true.
- Step 38 asserts no panel, per §1.
- Every `arrive` puts panels before the views they reframe.

## 6. Open questions

1. Whether the slice genome's key as the wizard's combobox lists it matches the key the
   browser resolves tracks by — the playlists tutorial's record-identity bug (§8 of the
   handoff) is the same shape, and this has to be checked in playback, not in the builder.
2. Whether a VCF of 81,830 variants warms its overview tiles fast enough for step 35 not to
   sit on a loading state; `settleMs` may need raising the way the analysis steps did.
