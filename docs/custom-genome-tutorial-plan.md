# Custom genome & annotation tutorial — implementation plan

Written 12 September 2026, and **built** the same day — see §1a for what shipped and how it
was verified. The plan below is kept as written, including the bits it got wrong, because the
reasoning is what the next tutorial will want.

Companion reading: [TUTORIALS.md](TUTORIALS.md) for the architecture and the step schema,
[CUSTOM_GENOMES.md](CUSTOM_GENOMES.md) for the feature being taught, and
[tutorial-builder-genome-playlists-handoff.md](tutorial-builder-genome-playlists-handoff.md)
for the traps. The brief is the author's, reproduced in §1.

## 1. The brief

> Introduce the tutorial → click Genome Selector from Home → mention that the selector has
> all local genomes whether downloaded or manually added, and the section to add manually is
> below the local genome list → scroll down to it automatically → give an overview of the
> various fields → start by adding a demo genome, get the user to click the add genome box
> and select it from the demo data folder → show them the Analyse button and get them to run
> it → run through highlighting each of the main sections, scrolling down after each → then
> say we're going to add an annotation, which is technically optional: you can browse the
> genome by itself and add different track types via the track manager → same procedure for
> the demo annotation, Analyse, run through the main fields → highlight the homology and
> index fields, explaining what they're for → say that now we've added the data we can go to
> the genome list and see it's present → get the user to select the genome, show it in the
> top bar, get them to click the Genome Browser → in the browser highlight the genome pill
> and the track with the annotation → outro.

Two decisions were taken with the author before planning:

- **The annotation is a GTF**, not the existing canonical `demo.gff3`, so the Analyse report
  has something real to say in every section — a detected dialect, conversion required, a
  rebuilt gene model and minted identifiers. See §3.
- **The report walkthrough is grouped**, roughly six steps rather than one per section. The
  genome report has four sections and the annotation report six; ten consecutive look-only
  cards is a long stretch with nothing for the reader to do.

### What the brief does not say, and is added

| Added | Why |
| --- | --- |
| An intro card and a review card | Required of every tutorial. The brief's "introduce" and "outro" are these, and `completionBody` is written as well |
| A step typing the **Genome label** and **Assembly label** | **Add genome** is disabled without them, so the flow stops dead. They are also what the genome's identity is built from — see §4 |
| A result beat after each file is chosen | The path lands in a field some way from the Browse button that caused it, which is exactly the case that needs its own step |
| A whole-region card before each report's sections | The whole-then-parts rule. Jumping from "press Analyse" to a ring around one sub-panel loses the reader |
| A card naming the file browser when it opens | Same rule. It is a new region containing the thing the next step asks for |

## 1a. Status — built and shipped

**Done.** Promoted to `frontend/src/tutorials/generated/custom-genome.tutorial.json` (36 steps,
11 sections) and registered in `generatedTutorials.js`. This document is kept as the record of
what was planned and why; `docs/TUTORIALS.md` and the handoff carry what someone needs next.

| Sweep | Result |
| --- | --- |
| Forward | **clean** — 36/36 |
| Backward | **clean** — 36/36 |
| Jump-in | **clean** — 36/36, zero steps with nothing to point at |
| Autoplay | Runs unattended through the slow steps (typing, analysis, file browser) without stalling; a ring on every step and the trace running throughout |
| Sandbox | Configuration byte-identical before and after; workspace swept on Exit; the user's own directories unchanged |

Suites: frontend 1116 passed / 1 skipped / 0 failed, lint clean, production build clean,
`git diff --check` clean. Backend 1073 passed plus 5 new tests for the demo source files.
`tests/test_alignment_explorer.py` cannot be collected in this environment because `httpx` is
not installed — **pre-existing**, reproduced with all of this work stashed.

Data footprint: `backend/data/demo_genome` is 44 K, of which the new `demo_genes.gtf` is 3.9 K.
The tutorial embeds no dataset recipes, so there is nothing for the bundling check to find
missing — the files it installs ship in `backend/data/demo_genome/`, which was already tracked.

## 2. What has to be built before a card can be written

Nothing in this flow is authorable today. These three components carry **no `data-tour-id`
attributes at all** between them, and the portable document may not contain selectors.

### 2.1 Target contracts

A new catalogue module, `frontend/src/tutorialTargets/customGenome.js`, registered in
`tutorialTargets/index.js`. Roughly twenty contracts:

| Target id | Element | Capabilities |
| --- | --- | --- |
| `custom.panel` | The whole "Manually add genomes" card | `spotlight` |
| `custom.panelToggle` | Its fold header | `spotlight`, `activate` |
| `custom.labels` | The three-field label grid | `spotlight` |
| `custom.genomeLabel` | Genome label * | `spotlight`, `input` |
| `custom.assemblyLabel` | Assembly label * | `spotlight`, `input` |
| `custom.accession` | Assembly accession | `spotlight`, `input` |
| `custom.fastaRow` | The FASTA row, field and both buttons | `spotlight` |
| `custom.fastaBrowse` / `custom.fastaAnalyse` | Its two buttons | `spotlight`, `activate` |
| `custom.annotationRow` | The annotation row | `spotlight` |
| `custom.annotationBrowse` / `custom.annotationAnalyse` | Its two buttons | `spotlight`, `activate` |
| `custom.homologyRow` | Homology TSV row | `spotlight` |
| `custom.indexRow` | Suggested index path row | `spotlight` |
| `custom.addGenome` | **Add genome** | `spotlight`, `activate` |
| `custom.report` | A validation report panel, parameterised by `kind` | `spotlight` |
| `custom.reportSection` | One section, parameterised by `section` | `spotlight` |
| `files.modal` | The file browser dialog | `spotlight` |
| `files.path` | Its path bar | `spotlight` |
| `files.entry` | One row, parameterised by `name` | `spotlight`, `activate` |
| `files.close` | Its ✕ | `spotlight`, `activate` |

Notes that follow from the existing rules:

- **Write every id out literally.** The anchor test is plain-text matching over source and
  sees `data-tour-id="literal"` and `` data-tour-id={`prefix-${expr}`} `` and nothing else.
  The report sections must therefore use the template form, not a mapped list of tuples.
- `Section` in `ValidationReportPanel.jsx` is a shared subcomponent, so it takes a `tourId`
  prop spread onto its element — the `PathInput`/`CollapsibleSection` pattern.
- `ManualPathRow` is likewise shared by the FASTA, annotation and homology rows, so it takes
  a `tourId` prop rather than three near-identical copies.
- The file browser's rows are `item.path`-keyed divs. Parameterise on the **file name**, not
  the path: the path is absolute, and absolute paths are rejected in a document.

### 2.2 A `customGenome` arrival

The single most important piece, and the reason this cannot be authored with what exists.
Every step in §5 asserts something about the form, and a step that inherits that state from
the step before it is a step that breaks the moment anyone presses Back.

```json
{
  "type": "customGenome",
  "panel": "open",
  "fields": {
    "genomeLabel": "Ensemblus welcomus",
    "assemblyLabel": "EGTdemo1",
    "accession": "",
    "fasta": "demo:fasta",
    "annotation": "",
    "homology": ""
  },
  "reports": { "genome": "ready", "annotation": "none" },
  "browser": { "state": "closed" },
  "registered": false
}
```

Idempotent by construction, like every other arrival: it **sets** each field rather than
toggling, so re-entering a step re-establishes the same form.

**File paths are symbolic.** `demo:fasta` and `demo:annotation` are resolved by the runtime
against the tutorial's own workspace. The document never contains an absolute path — which
`validateTutorialDocument` rejects outright, and which would be wrong on every other machine
anyway. `browser.directory` works the same way.

`registered: false` on the step before **Add genome** is the standard "declare the empty
state" rule — without it, walking back to that step finds the job already done and the
button does nothing the card describes.

### 2.3 Getting the demo files in front of the reader

The reader has to pick real files out of a real directory. That directory must be inside the
tutorial workspace (nothing else is swept on exit, and the backend refuses files outside it).

- A new dataset kind, or a small install step in `start()`, copies `backend/data/demo_genome/`
  plus the generated GTF (§3) into `<workspace>/demo_data/`.
- The same directory gets a `tutorial_dataset.json` marker declaring the **species key and
  assembly the form will produce** — see §4, which is the part with a sharp edge on it.
- The file browser's initial directory is set from the `customGenome` arrival rather than from
  `config.working_dir`, so the reader never has to navigate a filesystem the tutorial cannot
  predict.

### 2.4 A signal for analysis completing

Analyse is a real backend call. Advancing on the click means the report card is read before
the report exists. Add `custom.analysed`, emitted where the validation result lands, carrying
`{ kind: 'genome' | 'annotation' }`, and give those steps a generous `settleMs`.

Per the existing rule, **a `signal` advance infers no action**, so both Analyse steps spell
their action out or Next will walk straight past without pressing anything.

### 2.5 Builder support

A **Custom genome form** editor section writing the `customGenome` arrival, seeded from the
scene in front of the author with an explicit off state. Required by the skill's Phase 3: the
finished tutorial has to be openable and editable in the builder, not merely playable. Its
hook goes above the early return and below `selectedStep`, which has caught people twice.

## 3. Data

**Reuse, with one small addition — 29 KB in total.**

| File | Source | Size |
| --- | --- | --- |
| `demo.fa`, `demo.fa.fai` | `backend/data/demo_genome/`, unchanged | 22 KB |
| `demo_assembly_report.txt` | the same | 447 B |
| `demo_genes.gtf` | **new**, generated deterministically from `demo.gff3` | ~2 KB |

The genome is *Ensemblus welcomus* — two contigs (`welcome1` 15,682 bp, `welcome2` 6,352 bp;
22,034 bp in total), six protein-coding genes, six transcripts, fifteen exons, fifteen CDS.
A reader who has done Getting Started already knows it, so the tutorial teaches one new thing
rather than two.

The GTF is written by a new `backend/scripts/build_demo_gtf.py`, deterministic, regenerated
and committed rather than hand-edited, in the style of `build_demo_genome.py`. It carries
`transcript`, `exon` and `CDS` rows with `gene_id` / `transcript_id` attributes and **no gene
rows**, which is what real StringTie and BRAKER output looks like. That shape is what makes
the analysis report worth reading:

### What the reports actually say

**Measured, not predicted** — `scan_fasta` and `build_annotation_report` were run against
the two files and the values below are their output. Re-run them after any change to either
file, because a card that is confidently wrong about what is on screen is worse than no card.

The genome report, from `demo.fa`:

| Section | Reads |
| --- | --- |
| Sequences | 2 sequences, 22,034 bp total, longest 15,682, shortest 6,352, mean and median both 11,017, N50 15,682 (L50 1), N90 6,352 (L90 2) |
| Base composition | A 5,447 · C 5,545 · G 5,550 · T 5,492. No `N`, no ambiguity codes, no invalid characters |
| Longest sequences | `welcome1` 15,682 then `welcome2` 6,352 — the whole assembly in two bars |
| Issues | **Empty.** Which is the answer you want, and worth a sentence saying so |

The annotation report, from `demo_genes.gtf` cross-checked against `demo.fa`:

| Section | Reads |
| --- | --- |
| Detected | Format **GTF**, Producer **—**, Compression none, Lines read 36 |
| Model | 6 genes, 6 transcripts, 15 exons, 15 CDS, 6 coding transcripts, 0 mono-exonic, 1.00 transcripts/gene, 2.50 exons/transcript (max 4) |
| Gene classes | 6 coding. Behind *every biotype*: resolved `protein_coding` 6, but **biotypes as provided is `(none)`** — the file declares none and the class was inferred from the CDS |
| Sequence regions | 2 regions used, **0 missing from FASTA**, 0 FASTA regions unannotated. The cross-check ran because the FASTA was chosen first |
| Identifiers | 0 duplicates, 0 across regions, 0 unresolved parents. Generation **not** recommended — so no amber box |
| Issues | One `info`: *"Transcripts had no gene feature; a gene was created to hold them"*, count 6 |

Three of these are better cards than anything invented would have been:

- **Producer reads "—"**, because nothing in the file names a tool the app recognises. The
  card should explain the dash rather than ignore it — a StringTie or BRAKER file would fill
  it in. Do **not** relabel the GTF's source column as a real tool to make the tile populate:
  that is fabricating provenance in shipped data.
- **Biotypes as provided is `(none)`** while the resolved class is `protein_coding`. The file
  never said what these genes are; the app worked it out from the coding sequence.
- **The one issue is `info`, not an error**, and it is the gene reconstruction — the exact
  thing the GTF was chosen to demonstrate, reported in the app's own words.

The "Sequence regions" section carries the best line in the feature, and the tutorial should
quote the sense of it: a sequence-name mismatch between annotation and FASTA is the most
common reason a custom genome renders nothing. Adding the FASTA **before** the annotation is
what lets that check run at all, which is the reason the form is in that order.

## 4. The identity trap

`set_tutorial_session_genome` in `backend/demo_genome.py` will only make a genome browsable
if it is bundled, or if it carries a `tutorial_dataset.json` marker whose `species_key` and
`assembly` match the record. A hand-added genome is neither — and its identity is built from
what the reader types:

```
species_key = toSpeciesKey(<Genome label>)
assembly    = <Assembly accession> || <Assembly label>
```

So the marker in `demo_data/` must declare exactly the values the form will hold, and the
tutorial must **prefill both labels with `overwrite: true`** — this is precisely the "only one
value works and nothing else does" case that `overwrite` and `copy` exist for, and the
`copy` chip should fill the field rather than reach for a clipboard the app cannot paste from.

The alternative — relaxing the backend guard to accept any genome whose files sit inside the
workspace — was rejected. That guard's docstring says it exists so this cannot be used "to
make some other genome resolvable behind the configuration's back", and a tutorial is not a
reason to widen it.

**If the reader types something else anyway**, the genome is added and browsable within the
frontend but the backend will not resolve it, and the last four steps draw an empty track.
The final section's steps therefore carry a precondition that registers whatever was actually
added, and the failure is to be exercised deliberately in Phase 5.

## 5. The step table

36 steps in ten sections. `arrive` is abbreviated: every step also inherits `defaultArrive`.

### Getting started

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 1 | `welcome` | What the tutorial covers; that Next advances it | — | `customGenome` cleared, `genomeSelection: []` |
| 2 | `open-selector` | — | Presses Genome Selector | — |
| 3 | `local-genomes` | The list holds every local genome, downloaded or added by hand | — | `pageScroll` to the list |

### Where your own files go

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 4 | `manual-panel` | The whole add-a-genome region, below the list | — | `pageScroll` to the panel; `panel: open`, fields cleared |
| 5 | `form-labels` | What the two names are for, and that the accession is optional | — | as above |
| 6 | `form-paths` | The three file rows, and that only the FASTA is required | — | as above |

### Naming the genome

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 7 | `type-labels` | The labels are the genome's identity | Types both, or Next | fields cleared. `copy` + `overwrite` |

### Adding the sequence

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 8 | `browse-fasta` | Browse opens the app's own file browser | Presses Browse | labels set, `fasta: ''`, browser closed |
| 9 | `file-browser` | The whole dialog, and where it is pointed | — | browser open at `demo:dir` |
| 10 | `pick-fasta` | — | Clicks `demo.fa` | as above |
| 11 | `fasta-chosen` | **Result** — the path landed, Analyse is live | — | `fasta` set, browser closed, no report |
| 12 | `analyse-fasta` | What Analyse is for: read the file before trusting it | Presses Analyse | as above |
| 13 | `genome-report` | **Result** — the whole report panel | — | `reports.genome: ready` |

### What the sequence report says

| # | id | Covers | `arrive` |
| --- | --- | --- | --- |
| 14 | `genome-sequences` | Sequences + Base composition | report ready, `pageScroll` |
| 15 | `genome-issues` | Longest sequences + Issues | as above |

### Adding the annotation

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 16 | `annotation-optional` | Optional: a genome browses without one, and the track manager adds other track types | — | report ready, `annotation: ''` |
| 17 | `browse-annotation` | — | Presses Browse | as above |
| 18 | `pick-annotation` | — | Clicks `demo_genes.gtf` | browser open at `demo:dir` |
| 19 | `annotation-chosen` | **Result** — and that a GTF is accepted, not only GFF3 | — | `annotation` set, browser closed |
| 20 | `analyse-annotation` | — | Presses Analyse | as above, no report |
| 21 | `annotation-report` | **Result** — the whole report | — | `reports.annotation: ready` |

### What the annotation report says

| # | id | Covers | Why it earns a card |
| --- | --- | --- | --- |
| 22 | `detected-model` | Detected + Model | A GTF with no gene rows; the gene level is rebuilt |
| 23 | `gene-classes` | Gene classes | What the browser's gene-class filter will have to work with |
| 24 | `sequence-regions` | Sequence regions | The name cross-check — the most common reason a custom genome renders nothing |
| 25 | `identifiers-issues` | Identifiers + Issues | Why identifiers may need generating |

### The optional extras

| # | id | Covers |
| --- | --- | --- |
| 26 | `homology` | What a homology TSV buys, and that it is optional |
| 27 | `index-path` | What the index is, that it is suggested rather than chosen, and that it is built on add |

### Registering it

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 28 | `add-genome` | This is the step that commits it; the annotation is converted and indexed here | Presses **Add genome** | everything set, `registered: false` |
| 29 | `added` | **Result** — what the app did while it waited | — | `registered: true` |
| 30 | `in-the-list` | It is now an ordinary genome in the list, badged as added by hand | — | `pageScroll` to its row |

### Using it

| # | id | What it teaches | Reader does | `arrive` |
| --- | --- | --- | --- | --- |
| 31 | `select-genome` | Activating is the same act as for a downloaded genome | Ticks the box | `registered: true`, `genomeSelection: []` |
| 32 | `genome-pill` | **Result** — the pill in the top bar | — | `genomeSelection: [the genome]` |
| 33 | `open-browser` | — | Presses Genome Browser | as above |
| 34 | `browser-pill` | The genome has its own panel and colour | — | `browserScene` with it active |
| 35 | `browser-track` | **Result** — the six genes, drawn from the GTF that was converted | — | as above, at a locus holding genes |

### Wrapping up

| # | id |
| --- | --- |
| 36 | `review` — names what was taught, in the order taught |

## 6. Sandbox obligations

The override already covers the important half: `handleBrowserConfigChange` in `App.jsx`
routes a selector config change to `updateSandboxConfig` while a tutorial runs, so the added
genome lands in the override and never in the user's `manual_species`. What still needs
checking, because each is the kind of thing that has leaked before:

1. **`prepareAnnotation` writes to disk** — the converted GFF3, its tabix index and any
   `id_map.tsv` go *beside the source file*. The source is inside the workspace, so they are
   swept with it. Verify that, rather than assuming it.
2. **The backend session** must be registered for the added genome or the browser draws
   nothing; and cleared on the way out.
3. **Analysis reports** are written into `genome_analysis_reports` on the config. Confirm
   they land in the override and not the real file.
4. **Run it twice without restarting.** The second run must find no genome, an empty form and
   a fresh `demo_data/`.
5. The usual three exits, a byte-identical configuration, and nothing left on disk.

## 7. Verification

The three sweeps, autoplay at all three speeds, the movement checks, card-versus-ring
overlap, and the bundling check. Two things specific to this tutorial:

- **The jump-in sweep is the one that matters most here.** Nearly every step asserts a form
  state, and the `customGenome` arrival is new code. A step that quietly inherits the step
  before it will pass the forward sweep and fail the other two.
- **Deliberately type the wrong label** at step 7 and confirm the tutorial degrades legibly
  rather than reaching step 35 with an empty track.

## 8. Open questions

1. Whether the file browser should also be taught as a thing in its own right — it is used
   by Configuration and by the export path as well. Currently one card.
2. Whether the accession field deserves its own step. It is optional and changes the genome's
   key, which is a real subtlety, but the brief groups it with the labels.
3. Whether to teach **Load JSON** bulk import. Not in the brief; deliberately left out.
