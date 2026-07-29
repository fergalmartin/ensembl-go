# Structural-variation view

The Structural Variation view compares one anchor (reference) genome with one or
two target genomes. Downloading the genomes through the Download view prepares
everything on the genome side automatically. The only thing you supply is the
alignment between them.

## What an alignment needs

| Item | Needed? | Where it comes from |
| --- | --- | --- |
| Genome metadata, FASTA, `.fai` | Yes | Downloaded and indexed automatically. |
| GFF3 and annotation index | For the gene tracks | Downloaded and indexed automatically. |
| BigChain alignment file | One per alignment | You supply it. |
| Which side the chain is indexed on | Yes | Detected from the file name; you can override it. |
| Sequence names | Yes | Derived from the assemblies. Nothing to supply. |
| BigWig / BigBed tracks | No | Optional files you can attach. |

Earlier versions also asked for a pair of `hal_mapping.tsv` files. They are no
longer needed: the sequence names come from the assemblies themselves and from
the chain file. Existing alignments that reference those TSVs keep working — see
[Alignments registered before this format](#alignments-registered-before-this-format).

## The configuration file

An alignment is described by a JSON configuration file. Registering through the
interface writes one; you can also write one by hand, edit one in the app, or
share one with a colleague. It is the same file either way.

```json
{
  "ensembl_go_sv_config": 1,
  "description": "HPRC year-1 human comparisons",

  "genomes": {
    "GRCh38": {
      "accession": "GCA_000001405.29",
      "assembly_name": "GRCh38.p14",
      "species": "Homo sapiens"
    },
    "HG00438.pat": {
      "accession": "GCA_018472595.2",
      "assembly_name": "HG00438_pat_hprc_f2",
      "species": "Homo sapiens",
      "tracks": [
        { "label": "Read depth", "path": "tracks/HG00438.pat.bw" },
        { "label": "SV calls",   "path": "tracks/HG00438.pat.bb" }
      ]
    }
  },

  "pairs": [
    {
      "genomes": ["GRCh38", "HG00438.pat"],
      "alignments": [
        {
          "label": "GRCh38 to HG00438.pat",
          "description": "Cactus chain, target-indexed",
          "reference": "GRCh38",
          "target": "HG00438.pat",
          "chain": "chains/alt_179f190d_to_ref_fd7fea38.bigChain.bb"
        },
        {
          "label": "HG00438.pat to GRCh38",
          "reference": "HG00438.pat",
          "target": "GRCh38",
          "chain": "chains/ref_fd7fea38_to_alt_179f190d.bigChain.bb"
        }
      ]
    }
  ]
}
```

### genomes

Each genome is declared once under a short handle of your choosing (`GRCh38`,
`HG00438.pat`) and referred to by that handle everywhere else.

| Field | Required | Purpose |
| --- | --- | --- |
| `accession` | Yes | The assembly accession, e.g. `GCA_000001405.29`. This is what matches the genome to a local one. |
| `assembly_name` | No | Display name, e.g. `GRCh38.p14`. |
| `species` | No | Scientific name. |
| `aliases` | No | Other names this assembly is known by, such as a RefSeq accession. |
| `tracks` | No | BigWig/BigBed files shown whenever this genome appears. |
| `sequence_aliases` | No | Only when sequence names disagree; see below. |

### pairs and alignments

A pair groups the alignments between two genomes. Both directions of the same
comparison, and alternative alignments of the same pair, belong in one pair.

| Field | Required | Purpose |
| --- | --- | --- |
| `label` | Yes | Identifies the alignment. **Must be unique across the file** — this is what the view lists and what re-registering matches on. |
| `description` | No | Free text, shown in the alignment list. |
| `reference` | Yes | Handle of the anchor genome. |
| `target` | Yes | Handle of the compared genome. |
| `chain` | Yes | Path to the BigChain file. |
| `indexed_side` | No | `reference` or `target`. Detected from the file name when omitted. |
| `tracks` | No | `{ "<handle>": [ ... ] }` for tracks specific to this alignment. |

Paths may be relative to the configuration file, which makes a folder containing
the config and its chain files portable. Absolute paths also work.

A flat top-level `"alignments": [ ... ]` list is accepted as a shorthand when you
do not want to write the `pairs` wrapper; it is grouped into pairs on load.

### Sequence names

Chromosome names are worked out by matching the chain file's own chromosome list
against each assembly's FASTA index. Differences in the `chr` prefix are handled,
so a chain naming `chr1` matches an assembly calling it `1`.

When names genuinely differ — a chain naming a sequence `CM089167.1` where the
assembly calls it `1` — state the exception on the genome:

```json
"HG00438.pat": {
  "accession": "GCA_018472595.2",
  "sequence_aliases": { "CM089167.1": "1" }
}
```

Only the sequences the chain actually contains are considered, so a fragmented
assembly with many contigs costs nothing extra.

## BigChain expectations

The chain input is a BigBed-indexed chain file, conventionally named
`*.bigChain.bb`. A plain UCSC `.chain` text file or an ordinary feature BigBed is
not sufficient.

The BigBed record has three indexed BED fields followed by chain metadata:

```text
chrom  chromStart  chromEnd  chainId  score  strand  indexedSize
oppositeChrom  oppositeSize  oppositeStart  oppositeEnd  [level]
```

Coordinates are zero-based, half-open. The indexed side decides which genome
`chrom` refers to:

- `target`: `chrom/chromStart/chromEnd` describe the target; `oppositeChrom` and
  its coordinates describe the reference.
- `reference`: the reverse.

For a target-indexed GRCh38-to-HG00438 example, a decoded record can look like:

```text
1  78769  79259  1  1000  +  253151619  1  248956422  688854  689344  0
```

The indexed target interval is `1:78769-79259`, mapping to reference interval
`1:688854-689344`.

Ensembl Go infers the indexed side from the file name: `alt_<x>_to_ref_<y>...`
means `target`, `ref_<x>_to_alt_<y>...` means `reference`. If your files do not
follow that convention, set `indexed_side` explicitly. Setting it to a value that
contradicts the file name is allowed but produces a warning, because a wrong
indexed side is the usual reason an alignment saves cleanly and then draws
nothing.

## Registering an alignment in the application

1. Set an output directory in Configuration.
2. Download both genomes through Download and wait for them to complete.
3. Open Structural Variation and choose **Register alignment**.
4. Give the alignment a **Label**. It must be unique; it is how the alignment is
   identified everywhere afterwards.
5. Check the reference and target genomes. They are prefilled from whatever the
   view is currently showing.
6. Choose the BigChain file. Leave **Indexed side** on *Detect from file name*
   unless your files do not follow the naming convention.
7. Optionally attach BigWig and BigBed tracks for either genome.
8. Under **Save to**, choose *This installation* to store it with the app, or
   *A configuration file* to write it to a file you can share. Saving into an
   existing configuration file adds to it rather than replacing it.
9. Choose **Save alignment**, then open **Available alignments** to confirm it is
   listed.

Registering the same label again updates that alignment, including when its files
have moved. Registering under a different label creates a second alignment.

## Loading and editing a configuration

**Configuration** in the SV toolbar opens the configuration editor.

- The dropdown selects what you are looking at: *This installation* (the app's own
  store) or any configuration file you have loaded.
- **Load file** opens a configuration file and starts using its alignments.
- **Stop using** removes a file from the view. The file itself is untouched.
- **Validate** checks the text without writing anything, and reports each problem
  with the line it is on. Clicking a message jumps to that line.
- **Save** writes the file. **Save as** writes to a new one and starts using it.

Nothing is written unless it parses, so a mistake in the editor cannot damage a
working configuration.

### Genomes a configuration names but you do not have

A loaded configuration usually mentions genomes that are not in the top bar. The
view still lists them, grouped by whether they can be used:

- **Selected genomes** — already in the top bar, ready to use.
- **Available locally** — downloaded but not in the top bar. Shown as `(add)`;
  choosing one adds it to the top bar.
- **No local data** — shown as `(missing)`, or `(not downloaded)` when the
  assembly is one Ensembl Go could fetch. These are listed but cannot be chosen,
  so it is clear why an alignment in the configuration is not usable. Use the
  Download view to fetch them.

## Several alignments for one genome pair

A pair can hold more than one alignment: the two directions of a comparison, or
alternative alignments of the same pair. When more than one applies to the current
selection, a **Second alignment** (and **Third alignment**) dropdown appears next
to the genome selectors, listing them by label. This is why labels have to be
unique.

Direction still matters for what the view can show. Registering A as reference and
B as target does not create a B-to-A alignment; register the reverse chain
separately, in the same pair. Trio mode needs two alignments sharing one anchor:
A-to-B and A-to-C.

## Where things are stored

```text
<output directory>/local_data/sv_alignment_registry.json
```

That is the app's own store, written in the configuration format described above.
You can open it in the configuration editor like any other file.

Ensembl Go also scans:

```text
<output directory>/local_data/sv_alignments/
```

for `*.bigChain.bb` files, picking up a sidecar manifest (`sv_alignment.json`,
`<bigchain-name>.json`, or `<bigchain-stem>.sv_alignment.json`) or matching
UUID-based filenames against `*.hal_mapping.tsv` files beside them.

## Alignments registered before this format

Alignments registered by an earlier version load unchanged. When such a registry
is read it is migrated in memory: genome metadata is condensed, the generated id
is preserved, and the mapping TSVs are recorded as `legacy_mappings` and still
used for that alignment's sequence names. The file on disk is only rewritten the
next time you save something.

To stop relying on the TSVs for a migrated alignment, delete its
`legacy_mappings` block in the configuration editor and validate. Names are then
derived from the assemblies, as for any new alignment.

## What a successful test should show

After saving:

- the form reports the alignment was saved;
- **Available alignments** lists the reference-to-target edge as usable;
- the anchor-region selector contains the chromosomes the chain covers;
- moving to a mapped region draws alignment ribbons or blocks; and
- any BigWig/BigBed tracks appear on the relevant genome's row.

Saving confirms that the files exist. Rendering a mapped region is the real check
that the indexed side, sequence names, and coordinates agree.

## Troubleshooting

**The genome is not offered in the registration form**

Download it through the Download view first. Manually imported genomes must be
present in the application's local genome catalogue.

**Registration says `output_dir is required`**

Choose and save an output directory in Configuration, then reopen the SV view.

**The alignment saves but no regions or ribbons appear**

Check the indexed side first. Then compare the chain file's chromosome names with
the sequence names in both assemblies; if they differ by more than a `chr`
prefix, add `sequence_aliases` for the genome concerned.

**A configuration's genome shows as `(missing)`**

There is no local data for that assembly. Download it, or correct the `accession`
in the configuration if it names the wrong assembly.

**An alignment is listed with missing files**

The configuration stores paths, not file contents. Restore the files, or open the
configuration editor and correct the path. Because alignments are identified by
label, correcting a path updates the existing entry rather than creating a new one.

**Genes or bases are missing even though ribbons render**

Confirm both Download tasks completed. A manually imported genome needs FASTA/FAI,
GFF3 and a generated annotation index, and its sequence names must match those in
the chain file.
