# Feature Alignment

Feature Alignment generates a local alignment of annotated gene regions from two or more active genomes. It combines the aligned bases with gene features so you can compare sequence and annotation together.

## Before you start

Activate at least two genomes with local sequence and indexed annotation. MAFFT must be available locally to generate an alignment. See the [installation guide](../INSTALLATION.md#optional-dependency-mafft) for setup.

## Using the view

1. Focus genes in [Genome Browser](GENOME_BROWSER.md), or search for the gene to use in each active genome within Feature Alignment.
2. Choose the flanking sequence to include and run the alignment.
3. Pan and zoom through the result, from a regional overview down to bases. Feature colouring shows coding regions, UTRs, codons and splice boundaries.
4. Use the minimap to move through the annotated region. Collapse introns when you want to compare exon structure more easily.
5. Inspect the pairwise conservation heatmap or the summary conservation track for larger comparisons.
6. Save the alignment to reload it later. Use **Open in Alignment Explorer** to work with selected regions in named layers.

## Things to know

Inputs are genomic gene regions with optional flanks, so alignments can include introns and intergenic sequence. Confirm the genes and boundaries before running a large comparison.

An alignment provides sequence correspondence for the chosen inputs. It does not establish that the selected genes are orthologues. Gaps can reflect sequence differences, incomplete assemblies or how the alignment was constructed.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Alignment Explorer](ALIGNMENT_EXPLORER.md) · [Homology](HOMOLOGY.md)
