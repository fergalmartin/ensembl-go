# Protein translation

Feature Explorer's protein rows are translated on demand from the annotation (CDS rows in
the indexed GFF3) plus the genome FASTA. There is no protein file involved, so the
translation has to reproduce, from coordinates alone, what Ensembl and RefSeq publish in
their protein FASTAs.

Rules live in [`backend/translation.py`](../backend/translation.py) — pure functions, no
FastAPI or SQLite — and the genome plumbing (which genetic code a contig uses, reading CDS
bases out of the FASTA) sits next to the endpoint in `backend/main.py`.

## The rules

1. **CDS fragments are concatenated in biological 5'→3' order**, deduplicated on exact
   coordinates.
2. **The phase of the 5'-most CDS fragment sets the reading frame.** GFF3 phase says how
   many leading bases belong to a codon that started outside the annotated CDS — a
   5'-incomplete CDS (Ensembl `cds_start_NF`, RefSeq `partial=true`). Those bases are
   skipped and the incomplete codon is reported as a single `X`, which is what Ensembl's
   pep file does.
3. **A trailing incomplete codon is dropped**, not padded. Mitochondrial genes whose stop
   codon is completed by polyadenylation (`MT-ND1`, `MT-CO3`, …) rely on this.
4. **A terminal stop is stripped; internal stops are kept.** An internal `*` is real
   information about the annotation — readthrough, a frameshift, a mis-annotation — and
   hiding it would hide the bug. Ensembl's own pep file contains internal stops for 83
   human transcripts.
5. **A valid initiation codon is reported as `M`** even when it is not ATG (CTG/TTG in the
   standard code, ATT/ATA/GTG in the mitochondrial and bacterial codes). Codons that are
   not initiation codons for the code in use keep their own residue.
6. **Non-nuclear contigs use their own genetic code.** The contig's molecule type comes
   from the assembly report (`Assigned-Molecule-Location/Type`), which every downloaded
   Ensembl or NCBI genome ships, and falls back to a contig-name heuristic (`MT`, `chrM`,
   `Pltd`, …). The code itself comes from the species lineage in
   `backend/data/taxonomy_classification.json`: vertebrate mitochondria use NCBI table 2,
   invertebrates 5, yeasts 3, moulds/protozoa/cnidaria 4, echinoderms and flatworms 9,
   plant mitochondria the standard code, plastids 11; bacteria and archaea use table 11 and
   ciliates table 6 for their main contigs.
7. **When the lineage is unknown** — typically a manually imported genome with no taxid —
   an organelle contig falls back to picking the code that leaves no internal stops. On
   human mitochondrial genes this recovers table 2 unaided.

The response carries `translation_table`, `five_prime_partial` and `three_prime_partial`
alongside each row, so a surprising protein can be diagnosed from the API alone.

### Coordinates stay codon-aligned

The client maps a CDS nucleotide to an amino acid with `floor((nt - 1) / 3) + 1`. To keep
that true for a 5'-incomplete CDS, `cds_segments` is expressed in a space padded on the
left by `(3 - phase) % 3` virtual bases: the leading `X` occupies amino-acid position 1,
and the first real base starts at `pad + 1`. Segments are also trimmed so they never
extend past the last whole codon.

## Known divergences from the published proteins

These are annotation the GFF3 does not carry, so they cannot be derived from coordinates:

| Case | Effect |
| --- | --- |
| Selenocysteine (and pyrrolysine) recoding | Ensembl/RefSeq show `U`; we show `*` at that residue. 88 human transcripts. |
| Ensembl curated start-codon substitutions | Ensembl shows `M` for a handful of non-ATG starts that are not initiation codons; we show the encoded residue. 76 human transcripts. |
| RefSeq transcript/genome discrepancies (`exception=annotated by transcript or proteomic data`) | The RefSeq protein comes from the mRNA, which differs from the genome by an indel; ours follows the genome. 2 human transcripts. |

## Checking a genome

[`backend/scripts/validate_translations.py`](../backend/scripts/validate_translations.py)
compares every coding transcript of an installed genome against the provider's proteome —
Ensembl `pep.fa.bgz` or a RefSeq `_protein.faa.gz` — and reports mismatches by category:

```
python backend/scripts/validate_translations.py --genome reference --pep pep.fa.bgz
python backend/scripts/validate_translations.py --genome reference --pep pep.fa.bgz --chrom MT --show 20
```

Measured on GRCh38 with those rules in place:

| Genome | Compared | Exact | Mismatches |
| --- | --- | --- | --- |
| Human, Ensembl 2025_12 (whole genome) | 234 024 | 233 846 | 178, all in the table above |
| Human, RefSeq GCF_000001405.40 (chr21 + MT) | 1 386 | 1 384 | 2 RefSeq indel exceptions |
| *Acanthochitona discrepans*, Ensembl 2025_09 (whole genome) | 28 275 | 28 275 | none |
| *Acinetobacter baumannii*, RefSeq GCF_009035845.1 (whole genome) | 3 682 | 3 682 | none |

The genetic code matters as much as the frame: the same *A. baumannii* genome translated
with the standard code instead of table 11 mismatches 211 proteins (5.7%) on their
initiation codon alone, and human mitochondrial genes come out with internal stops
throughout.

## Tests

* `backend/tests/test_translation.py` — the rules, offline and self-contained.
* `backend/tests/test_translation_reference.py` — a 100 KB fixture cut from real GRCh38
  data (`backend/scripts/build_translation_fixture.py` regenerates it), checked against the
  proteins Ensembl and RefSeq publish. Covers complete CDS on both strands, 5'-incomplete
  CDS at phase 1 and 2, 3'-incomplete CDS, four mitochondrial genes, a selenoprotein, and
  the messy hand-made-GFF3 cases: missing phase, duplicated CDS rows, unsorted rows, and
  coordinates past the end of a contig.
