# Feature Explorer

Feature Explorer examines a gene through its metadata, transcripts, splicing, exons, protein products and sequence exports.

## Before you start

Activate a genome with indexed annotation and local sequence. Search for a gene symbol or stable identifier, or focus a gene in [Genome Browser](GENOME_BROWSER.md) before opening this view. Protein structure lookup needs connectivity when the required data are not cached.

## Using the view

1. Read the **Gene** section for identifiers, biotype, description and feature counts.
2. Choose the transcripts to show from the transcript list. The initial selection is limited; add other isoforms when you need a broader comparison.
3. Pan and zoom through transcript structures. The rulers relate genomic coordinates to positions along a transcript. Canonical, Ensembl Select and MANE labels appear where supplied by the annotation.
4. Use the splicing heatmap to compare exon paths. Click an exon to highlight downstream paths, then hover over or select a transcript to follow its individual path.
5. Use the exon atlas to inspect how the same interval is used across transcripts, including non-coding, partly coding and coding exons.
6. Open the sequence and **Protein** sections to inspect genomic, spliced or coding sequence and translated products. Protein tracks can show exon boundaries, hydrophobicity and disorder.
7. Use **Structure** where an AlphaFold model can be matched. Colour by confidence or coding exon, highlight exons, and inspect coding variants from registered VCF tracks.
8. Use the Sequence Exporter to choose feature records and FASTA header content, or continue to [Sequence](SEQUENCE.md) for detailed base selection.

## Things to know

Heatmap colours describe exon use within the selected transcript set. They do not measure expression: changing that set changes the comparison.

Proteins are translated locally from genomic sequence and annotated CDS features, following strand and phase. They can differ from provider protein records that include transcript corrections or special recoding.

Structure availability depends on identifying a corresponding protein and model. Check sequence and VCF reference mismatch messages before interpreting projected variants. AlphaFold confidence describes confidence in the model, rather than experimental validation.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Sequence](SEQUENCE.md) · [Track Manager](TRACK_MANAGER.md) · [Gene Trees](GENE_TREES.md)
