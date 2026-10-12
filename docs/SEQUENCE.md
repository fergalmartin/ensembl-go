# Sequence

Sequence reads local sequence base by base, from a genomic region down to a gene, transcript, exon or intron. It provides feature colouring, pattern searches and sequence selection for copying or export.

## Before you start

Activate a genome with local sequence. Annotation is needed for feature-based reading and colouring. Focus a gene or region in [Genome Browser](GENOME_BROWSER.md), or use the focus panel within Sequence.

## Using the view

1. Move through the focus hierarchy from location to gene, transcript and exon or intron. Moving back up retains your choices.
2. Read the interactive display, which shows sixty bases per row, or switch to plain text or FASTA. Hover over a base for its position and annotation.
3. Use the settings cog to choose feature highlights, flanking sequence and display orientation. Fold intronic or intergenic stretches when you want to concentrate on annotated sequence.
4. At transcript level, switch between genomic, spliced, CDS and protein readings where available.
5. Select a stretch by dragging across bases or choosing endpoints. Use **Find** to search literal strings or regular expressions and move between matches. Several patterns can have separate colours and priorities.
6. Copy or export the focused record, selected stretch or feature records. FASTA and plain text suit sequence analysis; HTML and rich text retain feature colouring. Choose headers that identify the genome and feature or location.

## Things to know

Colours depend on the focus level. Gene-level colouring compares transcript usage; transcript-level colouring can show UTRs, coding sequence, codons and splice boundaries.

Genomic coordinates and positions along spliced sequence describe different spaces. Check the displayed reading and coordinate labels when recording a selection or comparing exports.

The amino acid overlay on genomic CDS bases uses the standard genetic code. Spliced protein readings also handle supported organelle codes and partial CDS annotations. Use the appropriate reading when checking such proteins.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Feature Explorer](FEATURE_EXPLORER.md) · [Feature Alignment](FEATURE_ALIGNMENT.md)
