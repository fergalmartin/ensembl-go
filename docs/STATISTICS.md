# Statistics

Statistics summarises active genomes and annotations through **Annotation**, **Structural** and **Homology** modes. Assembly cards add local sequence statistics and available assembly metadata.

## Before you start

Activate the genomes you want to compare. Annotation and structural summaries need local annotation; homology summaries need local homology tables. Retrieving assembly metadata that are not cached requires connectivity.

## Using the view

1. Choose **Annotation** to compare gene and transcript counts across major classes. Inspect a genome's Sankey plot for a more detailed biotype breakdown.
2. Choose **Structural** to compare measurements such as exon counts, exon and intron lengths, and CDS lengths. Mean and median values provide different summaries of the distributions.
3. Select a genome to highlight its differences from the other annotations.
4. Choose **Homology** to inspect the available identity and coverage summaries. Use the zoom controls and per-genome summaries to examine the distributions.
5. Review assembly cards for local sequence statistics and metadata where available.

## Things to know

Some structural measurements are calculated on first request and cached, so an initial visit can take longer.

Counts and distributions describe the supplied assemblies, annotations and homology tables. Differences can reflect annotation methods, releases or completeness as well as biology. These summaries provide context for comparison rather than a direct score of biological accuracy.

## Related views

[Genome Selector](GENOME_SELECTOR.md) · [Feature Explorer](FEATURE_EXPLORER.md) · [Homology](HOMOLOGY.md)
