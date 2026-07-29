# Custom genomes & annotation — review and plan

Status: in progress (2026-07-28). Covers the "add your own genome/annotation" path reached
from the Genome Selector, and what needs to change to support arbitrary GFF3/GTF producers.

## Implementation status

| Phase | State |
|---|---|
| 1 — validation reports | **done** — `backend/annotation/`, `/api/custom/validate-*` |
| 2 — genome-only browsing | **done** — FASTA-only genomes load and browse |
| 3 — normaliser + conversion | **done** — dialect → canonical GFF3, wired into import |
| 4 — identifiers | **done** — audit, Ensembl-style minting, `id_map.tsv` |
| 5 — reader convergence | **deferred** — see below |

### Portable genome bundles

See §6 for the document format. Three things are deliberately kept separate:

| Concept | What it holds | What it is for |
|---|---|---|
| **Playlists** | Genome *identity* only — no file paths (`snapshotGenomeForPlaylist`) | Naming a set and switching the active genomes |
| **The local registry** | Downloaded genomes (live scan of `local_data`) ∪ `config.manual_species` | Knowing what is available right now |
| **Bundles** | Full metadata *and* file paths for a set of genomes | Moving a set between machines, or registering pre-prepared files |

A playlist cannot transport a genome: its entries carry no paths, and a missing manual
member is unrecoverable because `canDownloadPlaylistGenome` returns `false` for manual
genomes. The bundle is what carries paths. Playlists remain how sets are *named* —
applying one populates the selection, and export acts on the selection, so "export this
playlist" needs no separate control.

**Export** writes whatever is currently selected. Downloaded genomes are resolved against
the live local-assembly scan and through `config.genome_file_overrides`, so the file map is
the one the app is actually using. Genomes with no local FASTA are named in the result
rather than dropped silently.

**Import** reads the bundle, then either registers everything immediately or — with
**Review genomes before importing** ticked in the file browser — opens a matrix showing one
row per genome and one column per file type the document mentions. A filled dot means the
file is listed and present, a hollow amber ring means it was listed but is not on disk.
Rows are checked by default; entries whose FASTA is missing are disabled.

Declared identity is preserved on import: a genome whose bundle says `provider: "ensembl"`
registers as an Ensembl genome, not a manual one. It lands in `config.manual_species`
(meaning "registered from local files, not managed by the downloader") and shows a **From
file** badge instead of **Manual**, with the real source in the Source column. Because the
genome key is `provider::species_key::assembly`, such a record also collides correctly with
the same genome downloaded later — `allAssemblies` prefers the download-managed one.

Playlist names are matched case-insensitively. Missing playlists are created in config
order, and imported genomes are added without duplicating an existing membership. The
Genome Selector's **Select loaded genomes** option is enabled by default; turning it off
registers valid genomes and applies playlist memberships without adding them to the
selected-genome bar.

Only `files.fasta` is required. Any other file that is listed but not present on disk is a
**warning**, not an error: the genome still registers without it, the expected path is
reported, and the per-genome file editor is how the user repoints it. Earlier versions
failed the whole entry in that case.

196 tests cover the package end to end, including a round-trip suite that converts every
fixture and loads the result through the unmodified `create_gff_index`.

### The existing parser is untouched

`create_gff_index`, `init_index_db`, `ensure_gff_index` and `ensure_fasta_index` are
byte-identical to their committed versions. Conversion works *with* that parser rather
than replacing it: a GTF becomes canonical Ensembl-style GFF3, which is precisely the
dialect the existing indexer already handles best. Ensembl and RefSeq files that need no
repair are still copied verbatim and parsed exactly as before.

Phase 5 — collapsing the six ad-hoc GFF readers onto the shared helpers — is deliberately
left undone. Those readers currently work; rewriting them buys tidiness at the cost of
risk to the download path, and it should wait until the normaliser has been exercised
against real annotation files rather than fixtures.

### Reconstruction from CDS-only files

Some producers emit **nothing but CDS rows** — no gene, no transcript, no exon. Real
Tiberius output is the case that surfaced this: 88 822 CDS lines, zero rows of any other
type, with the entire hierarchy implied by `transcript_id`/`gene_id`. Both the transcript
and the gene level are reconstructed from those attributes, grouping children by parent
identifier *and* sequence region so an identifier reused across contigs does not fuse into
one feature spanning both.

The `tiberius.gtf` fixture originally carried gene and transcript rows, which real output
does not, and that hid the gap. Fixtures for this package must match what the tool actually
writes, not a tidied-up version of it.

### Conversion is decided per file, not per format

`conversion_required()` decides whether a file must be rewritten before it can be indexed.
A GFF3 the existing indexer already handles correctly is passed through **untouched**, so
importing an Ensembl or RefSeq annotation behaves exactly as it did before. Conversion is
triggered by:

- a non-GFF3 dialect (GTF cannot be indexed at all);
- a request to generate identifiers;
- a gene model that has to be rebuilt — no gene rows, orphan CDS/exon rows, or CDS-derived
  exons on a **multi-block** transcript.

That last condition is deliberately narrow. A single-block CDS with no exon row produces
the same model either way, and a gene-parented CDS (RefSeq prokaryote style) is already
handled by the indexer, so neither forces a rewrite. Only a multi-block CDS does, because
there the indexer's fallback draws one exon straight across the introns.

### Where files are written

Converted annotations, their tabix index and any `id_map.tsv` are written **beside the
source file**, in the directory the user chose. Indexes follow the same rule: beside the
annotation they were built from, falling back to `output_dir/indexes/` only when that
directory is not writable. Nothing is written to the working-directory root.

### Concurrent FASTA reads

Not a custom-genome bug, but found through one and worth recording. `pysam.FastaFile`
keeps seek and block-decompression state on the handle. `_get_browse_fasta` caches one
handle per genome and every browse endpoint runs on `run_in_threadpool`, so concurrent
requests were reading through the same handle at once. htslib then reports
`Failed to retrieve block. (Seeking in a compressed, .gzi unindexed, file?)` and the fetch
either raises or returns the wrong bases — a blank sequence track, and runs of N and
protein X in Feature Explorer.

Measured on a 748 MB bgzipped assembly: **23 of 24** concurrent fetches failed. Handles are
now wrapped in `ThreadSafeFasta`, which serialises every access; the same 80 fetches now
all succeed in 0.01 s.

A lock rather than a handle per thread, deliberately: the `.fai` of a fragmented assembly
holds hundreds of thousands of records (13 MB for 371 342 contigs here), and one handle per
worker thread would multiply that resident cost for no real gain — fetches are sub-millisecond.

**The VCF handle does *not* have this defect** — an earlier note in this document claimed
it did, and that was wrong. Both callers of the cached `pysam.VariantFile` already hold a
per-path lock across the whole scan, and there is exactly one place a handle is
constructed, so no unguarded route to it exists.

What was fragile was that the safety held only by convention: nothing stopped a future
caller taking the handle and forgetting the lock. That is now structural. The handle is
reachable only through the `locked_vcf(path)` context manager, and the underlying accessor
is named `_open_vcf_handle_unlocked` so misuse is visible at the call site.

The lock has to span the whole block here, more so than for FASTA:
`FastaFile.fetch()` completes its I/O before returning a string, whereas
`VariantFile.fetch()` returns a lazy iterator that reads as it is consumed — locking only
the call that creates the iterator would leave the actual scan unguarded.
`tests/test_vcf_handle_locking.py` asserts mutual exclusion, per-path independence, lock
release on exception, and that no new caller bypasses the context manager.

### Decisions taken

Two open questions from §8 were resolved to their recommended answers, so the work could
land as one piece:

- `sncRNA` is emitted as a biotype, documented as an Ensembl Go extension. Files also
  carry `biotype_source=` on each transcript recording which rule assigned it, so an
  inferred class is never mistaken for an asserted one.
- Converted files sit beside the original in `datasets/custom/<label>/`, with the source
  copied as `source_<name>` and `id_map.tsv` alongside when identifiers were minted.

Both are cheap to change later if you disagree.

---

## 1. What exists today

### 1.1 Two separate entry points

| Path | UI | Backend | What it does |
|---|---|---|---|
| **Manual genome** | [SpeciesSelectorView.jsx:2210](../frontend/src/components/SpeciesSelectorView.jsx#L2210) `addManualGenome` | *none* | Writes a record into `config.manual_species` / `config.active_species`. No file is read, opened, or checked. |
| **Custom annotation** | [SpeciesSelectorView.jsx:1916](../frontend/src/components/SpeciesSelectorView.jsx#L1916) | [`POST /api/remote/custom-annotation`](../backend/main.py#L6425) | `shutil.copy2` the GFF3 into `<assembly>/datasets/custom/<label>/`, register in the manifest. |

Neither path parses the file. The first time anything is actually read is when the genome
browser asks for a region and [`_get_browse_db`](../backend/main.py#L8580) triggers
[`create_gff_index`](../backend/main.py#L1405) — by which point the user has committed to
the genome and any failure surfaces as an empty gene track, not an error.

### 1.2 The parser

[`create_gff_index`](../backend/main.py#L1405) is a single-pass GFF3 reader that:

- splits attributes on `;` then `=` — **GFF3 syntax only**
- recognises a fixed allowlist of gene-level (12) and transcript-level (24) SO terms,
  plus `gene:`/`gene-`/`rna-` ID-prefix heuristics for Ensembl and RefSeq
- buffers every transcript and its children in memory, then writes `genes` and
  `transcripts` (whole transcript as a JSON blob) into a SQLite index
- synthesises a transcript per gene when a gene has no transcript children
- has narrow biotype normalisation: `normalize_tx_biotype` promotes to `protein_coding`
  when a CDS exists; otherwise the raw attribute value is passed through unchanged

There is no GTF path anywhere. `.gtf` appears only in file-type *classification*
([main.py:6087](../backend/main.py#L6087), [download_manager.py:2614](../backend/download_manager.py#L2614)),
never in the indexer.

### 1.3 Annotation is currently mandatory

Two places hard-require a GFF3, so "genome only" is not reachable:

- [main.py:6955](../backend/main.py#L6955) — `list_local_assemblies` skips any assembly
  without `files["gff3"]`: *"Local assemblies must have a GFF3 to be usable in Genome Selector."*
- [SpeciesSelectorView.jsx:2210](../frontend/src/components/SpeciesSelectorView.jsx#L2210) —
  `addManualGenome` refuses to submit without both FASTA and GFF3.

`/api/browse/regions` already complements gene-derived regions with FASTA contigs
([main.py:8697](../backend/main.py#L8697)), but it calls `_get_browse_db` first, which
404s when no index exists. So the plumbing is nearly there; the gate is at the top.

---

## 2. Findings — measured, not assumed

I built representative single-locus files for each producer and ran them through
`create_gff_index` directly. Results:

| Input | Genes | Transcripts | Outcome |
|---|---:|---:|---|
| StringTie GTF | 0 | 0 | **silent total failure** |
| Scallop GTF | 0 | 0 | **silent total failure** |
| AUGUSTUS native GTF | 0 | 0 | **silent total failure** |
| BRAKER `braker.gtf` | 0 | 0 | **silent total failure** |
| Tiberius GTF | 0 | 0 | **silent total failure** |
| AUGUSTUS `--gff3=on` | 1 | 1 | parses; gene biotype `''` |
| Helixer GFF3 | 1 | 1 | parses; gene biotype `''`; UTRs kept |
| egapx / NCBI GFF3 | 1 | 1 | parses correctly |
| Ensembl GFF3 | 1 | 1 | parses correctly, canonical tag honoured |

Plus these structural defects, all reproducible:

1. **GTF produces an empty index with no error.** `parse_attrs` finds no `=` in
   `gene_id "STRG.1"; transcript_id "STRG.1.1";`, so every attribute dict is empty, every
   ID is blank, and every row is skipped. The index builds "successfully" with zero rows.
   Five of the seven tools you named are affected.

2. **`mRNA` with no `gene` parent yields 0 gene rows.** Common in StringTie-derived GFF3 and
   in `--gff3` output that omits the gene level. `/api/browse/genes` selects from the `genes`
   table, so the gene track renders empty even though a transcript row exists.

3. **CDS-only transcripts get one fake exon spanning the introns.** Given `mRNA` +
   two `CDS` blocks and no `exon` rows, the parser falls through to
   [main.py:1741](../backend/main.py#L1741) and emits a *single* exon covering the whole
   transcript span. The browser then draws a two-CDS gene sitting inside one contiguous
   exon. This is BRAKER/AUGUSTUS/Tiberius' normal shape.

4. **Duplicate IDs across sequence regions silently destroy data.** `INSERT OR IGNORE` on
   genes and `INSERT OR REPLACE` on transcripts: a `g1` on chr1 and a `g1` on chr2 collapse
   to one gene row on chr1 whose transcript now claims chrom `chr2`. Wrong coordinates, no
   warning.

5. **No coordinate validation.** `start > end`, `start < 1`, non-integer coordinates all
   pass straight through into the index and out to the renderer.

6. **Non-coding genes are rendered as coding.** Predictors emit no `biotype`, so gene rows
   get `biotype=''`, and the frontend's `classifyBiotype` returns `'proteinCoding'` for a
   falsy biotype ([GenomeBrowser.jsx:242](../frontend/src/components/GenomeBrowser.jsx#L242)).
   Every unlabelled ncRNA displays as protein coding.

7. **`.gtf` cannot even be selected.** `GFF3_EXTENSIONS`
   ([SpeciesSelectorView.jsx:26](../frontend/src/components/SpeciesSelectorView.jsx#L26)) is
   `['.gff3', '.gff3.gz', '.gff3.bgz']`; the backend's `GFF3_DOWNLOAD_SUFFIXES` allows
   `.gff` but not `.gtf`. Plain `.gff` files are pickable by the backend but not by the
   file browser.

8. **`##FASTA` sections work by accident.** Sequence lines have fewer than 9 tab fields and
   get dropped by the `len(parts) < 9` guard. Nothing explicitly stops at the directive.

9. **Whole-file in-memory buffering.** `transcripts_data` holds every transcript with all
   children until the file ends. Fine for a bacterial GFF; a large plant/amphibian
   annotation with heavy isoform counts will be memory-hungry.

10. **Parsing logic is duplicated.** At least six independent GFF readers exist
    ([main.py:727](../backend/main.py#L727), [:3975](../backend/main.py#L3975),
    [:4033](../backend/main.py#L4033), [:4216](../backend/main.py#L4216),
    [:8443](../backend/main.py#L8443), [:11024](../backend/main.py#L11024)), each with its
    own feature-type set and prefix regexes. Any dialect fix has to be applied N times, or
    the readers have to converge.

---

## 3. Target design

### 3.1 Principle: normalise on ingest, not on read

Convert every accepted input into one canonical Ensembl-style GFF3 **at import time**,
write it beside the source, and index *that*. Everything downstream — the browser, feature
explorer, stats, exports — then sees a single guaranteed shape:
`gene → transcript → exon`, with `CDS` + `five_prime_UTR` + `three_prime_UTR` on coding
transcripts. This is what makes the fix tractable given finding #10: the six existing
readers keep working unchanged because they only ever see canonical files.

### 3.2 New module layout

A new package `backend/annotation/`, kept out of `main.py` (already 18.6k lines):

```
backend/annotation/
  dialect.py      sniff GFF3 / GTF / GFF2; per-dialect attribute parsing
  model.py        Gene / Transcript / Exon / CDS / UTR dataclasses
  normalize.py    hierarchy reconstruction, inference, validation
  biotype.py      biotype synonym table + classification rules
  identifiers.py  ID auditing + Ensembl-style ID minting
  emit.py         canonical GFF3 writer (+ bgzip/tabix)
  fasta_report.py FASTA scanning and statistics
  report.py       report dataclasses shared by validate + convert
```

`create_gff_index` stays, but becomes the consumer of canonical files rather than the
place where dialect handling lives.

### 3.3 Dialect detection

Sniff the first ~200 non-comment lines:

- `##gff-version 3` pragma → GFF3
- attribute column matches `key "value";` → GTF
- attribute column matches `key=value;` → GFF3
- attribute column is a bare token (AUGUSTUS native: `g1`, `g1.t1`) → GTF-like with
  positional ID
- mixed within a file (AUGUSTUS emits bare tokens on `gene`/`transcript` and quoted pairs
  on `CDS`) → handle per-line, not per-file

GTF specifics that must be handled:
- `gene_id` / `transcript_id` carry the hierarchy; there is no `Parent`
- `gene` and `transcript` rows are optional — reconstruct from `exon`/`CDS` grouping
- `stop_codon` is **excluded** from CDS in GTF but **included** in Ensembl GFF3 CDS.
  Conversion must extend the terminal CDS by the stop codon, strand-aware.
- `start_codon` / `stop_codon` / `intron` / `UTR` / `5UTR` / `3UTR` feature names

### 3.4 Hierarchy reconstruction rules

Applied in order, each recorded in the report so the user sees what was inferred:

1. **Transcript with no gene** → synthesise a gene spanning its transcripts. Multiple
   transcripts sharing a `gene_id` (GTF) or an overlapping locus on the same strand (last
   resort) collapse into one gene.
2. **Gene with no transcript** → synthesise one transcript spanning the gene (this already
   exists at [main.py:1790](../backend/main.py#L1790) and is correct behaviour).
3. **Transcript with CDS but no exons** → exons = merged CDS blocks ∪ UTR blocks.
   Fixes finding #3.
4. **Transcript with exons but no CDS** → non-coding, no CDS synthesised. Note this
   contradicts the current `synthesize_cds_from_transcript` fallback
   ([main.py:1515](../backend/main.py#L1515)), which fabricates a CDS whenever the parent
   looks coding; that should be narrowed to the RefSeq gene-parented-CDS case it was
   written for.
5. **Coding transcript, CDS present, UTRs absent** → derive `five_prime_UTR` /
   `three_prime_UTR` by subtracting the CDS interval from the exon blocks, strand-aware.
6. **Phase** → recompute from CDS block order and strand whenever the source has `.`
   (most predictors) or disagrees with the cumulative length.
7. **Canonical transcript** → honour `Ensembl_canonical` / `MANE Select` /
   `RefSeq Select` tags; otherwise longest CDS, tie-break on longest mature length, then
   lexicographic ID. Every gene ends up with exactly one canonical transcript.
8. **Exon rank** → assign 1..n in transcription order.

### 3.5 Biotype rules

Resolution order for a transcript:

1. Explicit `biotype` / `transcript_biotype` / `gene_biotype` / `ncrna_class` / `gbkey`,
   mapped through a synonym table onto the Ensembl vocabulary
   (`mRNA`→`protein_coding`, `ncRNA`→`lncRNA`/`sncRNA` by size, `misc_RNA`→`misc_RNA`,
   `V_gene_segment`→`IG_V_gene`, …). RefSeq and Ensembl inputs stop here.
2. No explicit biotype, CDS present (or `start_codon`/`stop_codon` present) →
   `protein_coding`.
3. No explicit biotype, no CDS, **mature** length (sum of exon lengths, not genomic span)
   ≥ 200 → `lncRNA`.
4. No explicit biotype, no CDS, mature length < 200 → `sncRNA`.

Gene biotype is derived from its transcripts: `protein_coding` if any transcript is
coding, else `lncRNA` if any is `lncRNA`, else `sncRNA`, else `pseudogene` if the source
said so.

Two follow-on edits are needed so the new label is not dropped on the floor:
- add `sncRNA` (and `lncRNA` if missing) to `BIOTYPE_CLASS`
  ([GenomeBrowser.jsx:212](../frontend/src/components/GenomeBrowser.jsx#L212))
- add `sncrna` → `snoncoding` to `_FALLBACK_BIOTYPE_GROUP_BY_NAME`
  ([stats_utils.py:46](../backend/stats_utils.py#L46))
- change `classifyBiotype`'s falsy branch from `'proteinCoding'` to a neutral/unknown
  class, so unlabelled input is never silently coloured as coding (finding #6)

### 3.6 Identifiers

**Audit** (always run): missing IDs, duplicates within a type, duplicates across sequence
regions (finding #4), orphan `Parent` references, self-parenting, IDs needing percent
encoding, IDs > 255 chars.

**Two user choices at import:**

- *Keep source identifiers* — default when the audit is clean. If the audit finds
  blocking problems the user is told exactly which, with counts and up to 20 examples,
  and cannot proceed without either fixing the file or switching to generated IDs.
- *Generate Ensembl-style identifiers* — the user supplies a prefix (e.g. `ENSXYZ`),
  validated as 3–10 uppercase alphanumerics. We mint, ordered by sequence region then
  start coordinate:
  `{PREFIX}G{011d}` gene, `{PREFIX}T{011d}` transcript, `{PREFIX}E{011d}` exon,
  `{PREFIX}P{011d}` protein. Original identifiers are preserved as
  `source_id=` plus `Alias=` on each feature, and a sibling `id_map.tsv`
  (`new_id, old_id, feature_type, seq_region, start, end`) is written next to the
  converted GFF3.

Generated IDs land in the converted file, so they are what the index, the browser, the
exports and any saved playlist all see — stable across re-imports as long as the input is
unchanged.

### 3.7 Canonical output

`<name>.ensembl.gff3.gz` (bgzip) + `.tbi`, written into
`<assembly>/datasets/custom/<label>/` alongside the untouched original:

```
##gff-version 3
##sequence-region <seqid> 1 <length>        # from the FASTA .fai when available
#!ensembl-go-converted <ISO8601> from <source basename> (<dialect>)
seqid  ensembl_go  gene   S  E  .  +  .  ID=gene:X;biotype=protein_coding;Name=...;source_id=...
seqid  ensembl_go  mRNA   S  E  .  +  .  ID=transcript:Y;Parent=gene:X;biotype=protein_coding;tag=Ensembl_canonical
seqid  ensembl_go  exon   S  E  .  +  .  Parent=transcript:Y;rank=1
seqid  ensembl_go  CDS    S  E  .  +  0  Parent=transcript:Y
seqid  ensembl_go  five_prime_UTR ...
```

Sorted by seqid then start then a feature-type rank, so it is tabix-indexable and
diff-stable.

---

## 4. Validation reports

Both are **optional** — a "Validate" button next to each file picker — and both run as
background tasks (`task_id` + poll) reusing the pattern already in
[`_index_worker_loop`](../backend/main.py#L4642), because these are full-file scans.

### 4.1 Genome (FASTA) report — `POST /api/custom/validate-genome`

Everything you asked for, plus the checks that predict downstream breakage:

**Counts**
- number of sequences
- total length; longest, shortest, mean, median sequence length
- N50 / L50, N90 / L90
- number of sequences below a small-contig threshold (informational)

**Composition** — exact counts and percentages
- A, C, G, T
- N and other IUPAC ambiguity codes (R, Y, S, W, K, M, B, D, H, V) broken out individually
- GC% (over ACGT only) and GC% including ambiguity
- soft-masked fraction (lowercase bases) — tells the user whether the assembly is masked
- count of sequences that are 100% N
- any character outside the IUPAC set, with the offending sequence and offset

**Fitness for use**
- compression state: plain / bgzip / gzip. Plain gzip cannot be used by `pysam` and today
  gets silently decompressed to a full-size copy on disk
  ([`ensure_fasta_index`](../backend/main.py#L159)) — the report should state the disk
  cost up front.
- `.fai` present, or creatable
- duplicate sequence names; empty sequences; names containing whitespace (only the first
  token becomes the seqid, a classic source of GFF/FASTA mismatch)
- inconsistent line lengths within a record, which breaks `faidx`

### 4.2 Annotation report — `POST /api/custom/validate-annotation`

Takes the annotation path and, optionally, the FASTA path so the cross-checks can run.

**Detected**
- dialect (GFF3 / GTF / GFF2 / AUGUSTUS-native), compression, `##gff-version`,
  producer guess from column 2 (`StringTie`, `AUGUSTUS`, `Helixer`, `Gnomon`, …)

**Counts** — the headline numbers
- genes, transcripts, exons, CDS features, UTR features
- transcripts per gene: mean, median, max, and the distribution
- exons per transcript: mean, median, max; mono-exonic transcript count
- total exonic bp, total CDS bp
- full feature-type histogram, **including types we do not model**, so nothing is
  invisibly dropped

**Classification** — gene and transcript counts per biotype, shown twice:
*as provided* and *as resolved*, so the user can see exactly what inference did.
Rolled up to the four major classes (coding / lncRNA / sncRNA / pseudogene / other).

**Cross-checks against the FASTA** (when supplied) — the highest-value check here
- seqids in the annotation missing from the FASTA, and vice versa, with counts
- features extending past the end of their sequence
- naming-style mismatch detection (`chr1` vs `1` vs `NC_000001.11`) with a suggested
  mapping, since this is the single most common reason a custom pair silently renders
  nothing
- CDS length not a multiple of 3; missing start/stop codon; internal stop codons

**Structural issues**, each with a count and up to 20 examples
- orphan `Parent`, duplicate IDs, missing IDs, duplicate IDs across seqids
- `start > end`, `start < 1`, coordinates past sequence end
- `.`/`?` strand on a gene or transcript
- transcripts with no exon and no CDS

**What conversion will do** — a preview, so the Convert button is never a surprise
- N genes to be synthesised, N transcripts to be synthesised
- N transcripts whose exons will be inferred from CDS
- N transcripts that will gain computed UTRs
- N features whose phase will be recomputed
- N biotypes to be assigned by inference, broken down by rule
- whether identifiers will be regenerated

Severity is three-level: **error** (conversion cannot produce a valid model),
**warning** (conversion will guess), **info** (recorded, no action).

---

## 5. Genome-only browsing

Currently blocked in three places; all three are small changes.

1. [main.py:6955](../backend/main.py#L6955) — allow an assembly with a FASTA and no GFF3.
   Mark it `has_annotation: false` in the record.
2. [SpeciesSelectorView.jsx:2210](../frontend/src/components/SpeciesSelectorView.jsx#L2210)
   and the disabled-state on the Add button ([:2816](../frontend/src/components/SpeciesSelectorView.jsx#L2816))
   — require FASTA only.
3. `_get_browse_db` / `browse_regions` / `browse_genes` — when no annotation is
   configured, return regions from the FASTA `.fai` alone and an empty gene list, instead
   of a 404. `browse_regions` already has the FASTA complement logic
   ([main.py:8697](../backend/main.py#L8697)); it just needs to survive a missing `db_path`.

The genome browser then shows the sequence track plus whatever BigWig/BigBed/VCF tracks
the user attaches — which is the case you described. Views that genuinely need genes
(Feature Explorer, Homology, Neighbourhood) should be visibly disabled for such a genome
rather than erroring on entry.

---

## 6. API surface

```
POST /api/custom/validate-genome        {fasta_path}                       -> {task_id}
POST /api/custom/validate-annotation    {annotation_path, fasta_path?}     -> {task_id}
GET  /api/custom/validation/{task_id}                                      -> report | progress
POST /api/custom/convert-annotation     {annotation_path, fasta_path?,
                                         id_mode: keep|generate,
                                         id_prefix?, output_dir}           -> {task_id}
GET  /api/custom/conversion/{task_id}                                      -> {converted_path, id_map_path, report}
POST /api/custom/genome-config/read     {path}                              -> {entries, diagnostics}
POST /api/custom/genome-config/save     {path, genomes, playlists?}         -> {path, count}
```

Both take a path through `validate_config_export_path`, so the `.json` extension is
enforced at the API boundary rather than silently rewritten.

Preparation task responses also include `stage`, `message`, and live `counters`
alongside the existing 0–100 `progress` value.

### Portable genome bundle

The Genome Selector loads and exports a versioned JSON document describing any genome it
knows about — downloaded, manually added, or previously imported:

```json
{
  "format": "ensembl-local-genomes",
  "version": 2,
  "created_at": "2026-07-29T10:00:00Z",
  "playlists": [
    { "name": "Primate references", "description": "Great apes" }
  ],
  "genomes": [
    {
      "species": "Homo sapiens",
      "species_key": "Homo_sapiens",
      "common_name": "Human",
      "display_name": "Human",
      "display_name_reason": "common_name",
      "assembly": "GCA_000001405.29",
      "assembly_name": "GRCh38.p14",
      "accession": "GCA_000001405.29",
      "equivalent_accessions": ["GCF_000001405.40"],
      "provider": "ensembl",
      "source_database": "Ensembl",
      "dataset_release": {
        "key": "ensembl/2024_11", "source": "ensembl",
        "date": "2024_11", "label": "Ensembl 2024_11", "short_label": "E113"
      },
      "playlists": ["Primate references"],
      "files": {
        "fasta": "GRCh38.fa.gz",
        "gff3": "genes.gff3.gz",
        "homology": "homologies.tsv.gz",
        "index": "genes.index.db",
        "metadata": "GRCh38_assembly_report.txt"
      }
    }
  ]
}
```

`species`, `assembly` and `files.fasta` are required; everything else is optional. Absent
`provider` means `manual`. Relative paths are resolved from the JSON file's directory, and
export relativises paths that sit under the destination directory so a bundle written
beside its data stays portable.

`files` accepts every canonical file type — `fasta`, `gff3`, `homology`, `index`,
`metadata`, `cdna`, `protein`, `xref`, `gff3_index`, `gtf_index`, `cdna_index`,
`protein_index`, `xref_index`, `gtf`, `embl`, `alignment`, `other_annotation` — defined
once in `BUNDLE_FILE_TYPES` (`backend/manual_genome_config.py` and
`frontend/src/utils/genomeFileTypes.js`; keep the two in step).

**Version 1 documents still load.** The old format name `ensembl-local-manual-genomes` is
accepted, as are its two file keys `annotation` and `homologies`, which alias onto `gff3`
and `homology`. A document carrying both spellings keeps the canonical one. Version 2 is
what gets written.

Imports validate every entry first, skip duplicates, and prepare remaining annotations
serially so one invalid genome does not block the rest. Duplicate detection is
release-aware: two dataset releases of one assembly are distinct genomes in the selector
and must not collapse into one entry.

`import_custom_annotation` gains an optional `convert: true` and, when set, runs the
conversion and registers the *converted* file as the dataset release, keeping the original
as `source_path` in the manifest (that field already exists,
[main.py:6491](../backend/main.py#L6491)).

All paths go through the existing `security_utils` path guards; conversion output is
confined to the assembly directory.

---

## 7. Frontend changes

- **Manual genome panel** — a `Validate` button under the FASTA row and another under the
  GFF3/GTF row, each opening a report panel. GFF3 row becomes optional and is relabelled
  *Annotation file (optional)*.
- **Report panel** — a shared component rendering the report dataclass: headline counts as
  stat tiles, biotype/feature breakdowns as tables, issues grouped by severity with
  expandable examples. Same component serves genome and annotation reports.
- **Identifier controls** — radio (*Use identifiers from file* / *Generate Ensembl-style
  identifiers*) plus a prefix input, shown once an annotation has been validated. The
  generate option is preselected when the audit found blocking ID problems.
- **File pickers** — widen `GFF3_EXTENSIONS` to
  `.gff3 .gff .gtf .gff3.gz .gff.gz .gtf.gz .gff3.bgz .gff.bgz .gtf.bgz`, and add
  `.fna.bgz`-style variants already present for FASTA. Backend
  `GFF3_DOWNLOAD_SUFFIXES` needs the `.gtf` variants to match.
- **Custom annotation dialog** — same Validate button and identifier controls before the
  Import action.

---

## 8. Delivery order

Each phase is independently shippable and testable.

**Phase 1 — visibility.** FASTA report + annotation report on the *existing* parser, with
the counts and cross-checks from §4. No conversion yet. This alone turns every silent
failure in §2 into a message: a StringTie GTF reports "0 genes, 0 transcripts — GTF is not
yet supported", which is already a large improvement over an empty gene track.

**Phase 2 — genome-only.** The three unblocking changes in §5. Small, self-contained,
unlocks the browse-without-annotation case.

**Phase 3 — the normaliser.** `backend/annotation/` with dialect sniffing, hierarchy
reconstruction, biotype rules, canonical emit. Covers GTF (StringTie, Scallop, AUGUSTUS
native, BRAKER, Tiberius) and gene-less GFF3. Conversion endpoint + wiring into import.
This is the bulk of the work.

**Phase 4 — identifiers.** Audit, minting, `id_map.tsv`, UI controls.

**Phase 5 — convergence.** Point the remaining ad-hoc GFF readers (finding #10) at the
shared attribute/dialect helpers, and narrow the CDS-synthesis fallback (§3.4 rule 4).

### Test corpus

The probe files I used are a starting point but not sufficient. Phase 3 needs a fixture
directory `backend/tests/fixtures/annotation/` with one real multi-gene file per producer —
StringTie, Scallop, AUGUSTUS (native GTF and `--gff3=on`), BRAKER, Tiberius, Helixer,
egapx, RefSeq, Ensembl — each with an expected canonical GFF3 output committed alongside,
so conversion is a golden-file comparison. Add the pathological cases as small synthetic
files: duplicate IDs across seqids, `start > end`, CDS-only, orphan `Parent`, `##FASTA`
section, CRLF line endings, missing strand.

### Open questions

1. **`sncRNA` as a biotype string.** Ensembl's vocabulary has no `sncRNA` term — the
   nearest are the specific ones (`miRNA`, `snoRNA`, …) plus `misc_RNA`. Using `sncRNA`
   for the inferred case is clearer for the user but means our converted files carry a
   term real Ensembl files never do. Alternative is `misc_RNA` with an
   `inferred=length_lt_200` attribute. My recommendation is to use `sncRNA` and document
   it as an Ensembl Go extension, because the honesty of the label is worth more here than
   vocabulary purity — but it is your call.
2. **Where converted files live.** Beside the original in `datasets/custom/<label>/` is
   simplest and keeps the manifest shape. The alternative — a `converted/` subdirectory —
   is tidier but touches `_scan_local_assembly`'s directory walk.
3. **Memory ceiling.** Whether Phase 3 should stage to a temporary SQLite table rather
   than an in-memory dict. Recommend deferring until we have a large real annotation that
   actually hurts; the canonical-emit pass can be made seqid-chunked later without
   changing the interface.
