# Structural-variation view

The Structural Variation view compares one anchor (reference) genome with one
or two target genomes. For the normal workflow, Ensembl Go prepares the genome
data automatically when the genomes are downloaded. The additional user input
is the structural-variation alignment bundle for each reference-to-target
comparison.

## Requirements and what Ensembl Go handles

| Item | Needed? | Default handling |
| --- | --- | --- |
| Genome metadata | Yes | Registered automatically by the Download view. |
| FASTA and `.fai` | Yes | Downloaded and indexed automatically. |
| GFF3 and annotation index | Yes | Downloaded and indexed automatically. |
| BigChain alignment | One per reference-to-target comparison | Supplied by the user when registering a custom SV alignment. |
| Reference and target mapping TSVs | One pair per comparison | Supplied with the custom SV alignment. |
| BigWig or BigBed tracks | No | Optional files the user can add during registration. |

In other words, downloading the two genomes is normally enough preparation for
the genome side of the view. The detailed file list below documents what the
application manages internally and what is needed for manual imports.

### Genomes

Normally, the only setup is to download both genomes through the Download view
and wait for the downloads to finish. Ensembl Go registers the genome metadata,
downloads the sequence and annotation, and prepares the indexes needed by the
SV view automatically.

Internally, this produces a FASTA and `.fai`, a GFF3 annotation, and an Ensembl
Go SQLite annotation index. These file-level requirements matter only if you
are importing a genome manually or diagnosing an incomplete download.

### Alignment files

For each custom reference-to-target alignment, the user supplies:

- one BigChain file in indexed BigBed form;
- one reference mapping TSV;
- one target mapping TSV; and
- the correct indexed side (`reference` or `target`).

The registration screen records paths to these alignment files rather than
copying them. Keeping the bundle in a stable folder is therefore the main
file-management step for the user.

The following are optional:

- a BigWig signal track;
- a BigBed interval/SV track; and
- a human-readable alignment label.

The current registration form exposes optional tracks for the target genome.
The backend format also supports reference-side BigWig and BigBed tracks when
an alignment is registered through the API or a manifest.

MAFFT is optional and unrelated to this view. It enables multiple alignments of
genic regions with annotation overlaid on the aligned sequence, but is not
required to inspect an existing SV alignment.

## Mapping TSV format

Use a UTF-8, tab-delimited file with a header row. The expected columns are:

| Column | Purpose |
| --- | --- |
| `hal_genome_name` | Genome name used in the source HAL alignment. Recommended metadata. |
| `assembly_uuid` | UUID used by the alignment-production pipeline. Recommended metadata and used for automatic file matching. |
| `hal_sequence_name` | Sequence name in HAL, for example `chr1` or `CM089167.1`. Required for sequence resolution. |
| `assembly_sequence` | Sequence name used by the registered FASTA/GFF and BigChain, for example `1`. Required for sequence resolution. |

Example reference mapping:

```tsv
hal_genome_name	assembly_uuid	hal_sequence_name	assembly_sequence
GRCh38	fd7fea38-981a-4d73-a879-6f9daef86f08	chr1	1
GRCh38	fd7fea38-981a-4d73-a879-6f9daef86f08	chr2	2
GRCh38	fd7fea38-981a-4d73-a879-6f9daef86f08	chrX	X
```

Example target mapping:

```tsv
hal_genome_name	assembly_uuid	hal_sequence_name	assembly_sequence
HG00438.1	179f190d-17f9-4692-9353-374976c62e20	CM089167.1	1
HG00438.1	179f190d-17f9-4692-9353-374976c62e20	CM089168.1	2
HG00438.1	179f190d-17f9-4692-9353-374976c62e20	CM089185.1	X
```

Use the exact header names above. Rows without both `hal_sequence_name` and
`assembly_sequence` are ignored. Include every sequence that should be
navigable in the SV view. The `assembly_sequence` values must agree with the
sequence naming used by the local assembly and the BigChain records; aliases
such as `1` and `chr1` are resolved where possible, but consistent naming is
safer. Use the same canonical `assembly_sequence` labels on both sides for
corresponding chromosomes (for example `1` on both sides), because the
anchor-region list is built from the intersection of the two mappings.

These mapping TSVs are not the pairwise-alignment manifest TSV and not the
homology TSV used elsewhere in the application.

## BigChain expectations

The BigChain input is a BigBed-indexed chain file, conventionally named
`*.bigChain.bb`. A plain UCSC `.chain` text file or an ordinary feature BigBed
is not sufficient.

The BigBed record has three indexed BED fields followed by chain metadata:

```text
chrom  chromStart  chromEnd  chainId  score  strand  indexedSize
oppositeChrom  oppositeSize  oppositeStart  oppositeEnd  [level]
```

In the actual BigBed entry, the fields after `chromEnd` are tab-separated in
the record payload. Coordinates are zero-based, half-open.

Choose the indexed side according to the file:

- `target`: `chrom/chromStart/chromEnd` describe the target; `oppositeChrom`
  and its coordinates describe the reference.
- `reference`: `chrom/chromStart/chromEnd` describe the reference;
  `oppositeChrom` and its coordinates describe the target.

For a target-indexed GRCh38-to-HG00438 example, a decoded record can look like:

```text
1  78769  79259  1  1000  +  253151619  1  248956422  688854  689344  0
```

Here the indexed target interval is `1:78769-79259`, and it maps to reference
interval `1:688854-689344`.

At minimum, the indexed BigChain chromosome names must overlap the
`assembly_sequence` values in the indexed genome's TSV. The
`oppositeChrom` values must overlap the other TSV.

## Register an alignment in the application

1. Set an output directory in Configuration.
2. Download both genomes through Download and wait for them to complete.
   Ensembl Go prepares their sequence, annotation, and indexes automatically.
3. Open Structural Variation.
4. Select the reference genome first and the target genome second.
5. Under **Alignments**, choose **Register alignment**.
6. Select the same reference and target genomes in the form.
7. Choose the BigChain file and the two mapping TSVs.
8. Set **Indexed side** to match the BigChain layout described above.
9. Optionally select target BigWig and BigBed tracks.
10. Choose **Save alignment**.
11. Open **Available alignments** and confirm the new directed edge is listed.
12. Select an anchor region and inspect the ribbons/blocks in the view.

Registration is directional. Registering A as reference and B as target does
not create a B-to-A edge. Trio mode therefore needs two registrations with the
same anchor: A-to-B and A-to-C.

The registry is stored at:

```text
<output directory>/local_data/sv_alignment_registry.json
```

Re-registering the same generated alignment ID updates that entry. The UI
generates the ID from the three required paths, so selecting different file
paths creates a separate entry.

## What a successful test should show

After saving:

- the form reports `Alignment registered`;
- **Available alignments** lists the reference-to-target edge as local;
- the alignment reports all three required files as present;
- the anchor-region selector contains regions from the mapping/BigChain
  intersection;
- moving to a mapped region draws alignment ribbons or blocks; and
- optional BigWig/BigBed tracks appear on the target row.

Saving confirms that the paths exist, but it is not a complete semantic
validation of every BigChain record. Rendering a mapped region is the final
check that the indexed side, sequence names, and coordinates agree.

## Automatic bundle discovery

Manual registration is the clearest first test. Ensembl Go can also scan:

```text
<output directory>/local_data/sv_alignments/
```

It searches recursively for `*.bigChain.bb`. There are two supported ways to
associate a BigChain with its mappings:

1. Put a manifest beside it, named `sv_alignment.json`,
   `<bigchain-name>.json`, or `<bigchain-stem>.sv_alignment.json`.
2. Use UUID-based filenames such as
   `alt_<target-uuid>_to_ref_<reference-uuid>....bigChain.bb`, with
   `*.hal_mapping.tsv` files containing the matching `assembly_uuid` values.

Example manifest using paths relative to the manifest:

```json
{
  "id": "grch38_to_hg00438",
  "label": "GRCh38 to HG00438",
  "indexed_side": "target",
  "chain_path": "alt_target_to_ref.bigChain.bb",
  "ref_mapping_path": "GRCh38.hal_mapping.tsv",
  "tgt_mapping_path": "HG00438.1.hal_mapping.tsv",
  "reference_genome": {
    "assembly": "GCA_000001405.29",
    "assembly_name": "GRCh38.p14",
    "aliases": ["GRCh38"]
  },
  "target_genome": {
    "assembly": "GCA_018472595.2",
    "assembly_name": "HG00438_pat_hprc_f2",
    "aliases": ["HG00438.1"]
  },
  "target_bigwig_path": "HG00438_pat_hprc_f2.bw",
  "target_bigbed_path": "HG00438_pat_hprc_f2.bb"
}
```

Manual registration writes absolute paths. Manifest paths may be relative to
the manifest directory.

## Troubleshooting

**The genome is not offered in the registration form**

Download it through the Download view first and wait for the download to
complete. Manually imported genomes must be present in the application's local
genome catalogue.

**Registration says `output_dir is required`**

Choose and save an output directory in Configuration, then reopen the SV view.

**The alignment saves but no regions or ribbons appear**

Check the indexed side first. Then compare the indexed BigChain chromosome
names with `assembly_sequence` in that side's TSV and compare the BigChain
opposite chromosome names with the other TSV.

**The edge is listed as unsupported or files are missing**

The registry stores paths rather than file contents. Restore the files, or
register the alignment again at its new paths.

**Genes or bases are missing even though ribbons render**

First check that both Download tasks completed successfully. If either genome
was imported manually, confirm that it has FASTA/FAI, GFF3, and a generated
annotation index. Also confirm that its sequence names match the TSV's
`assembly_sequence` values.

**The wrong pair is selected**

Confirm the registration direction and the reference/target genome metadata.
Assembly accessions and aliases are used to match a selected pair to a
registered edge.
