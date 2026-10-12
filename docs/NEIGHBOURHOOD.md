# Neighbourhood

Neighbourhood compares the genes surrounding a chosen gene in each active genome. It simplifies gene sizes and spacing to make differences in gene order and orientation easier to follow.

## Before you start

Activate genomes with indexed annotations and choose a gene of focus in each. Local homology tables are optional; they enable homology-based links where suitable data are available.

## Using the view

1. Search for a gene in each genome row, or use the genes already selected in the browser.
2. Compare the order and direction of the surrounding genes. Use gene-class filters to concentrate on the features relevant to your question.
3. Follow links between adjacent rows. The default links use matching gene symbols or identifiers; choose homology-based linking when the relevant tables are available.
4. Pan through the neighbourhoods. Adjust a row's offset independently by dragging, or recentre on its chosen gene.
5. Reorder genomes to compare different adjacent pairs. Flip a neighbourhood or a selected subregion when examining an inversion.
6. Use the selection control to emphasise a region and dim genes outside it.

## Things to know

Genes are drawn at a fixed size and intergenic spacing is removed. This view compares order and orientation, rather than genomic distances or gene lengths. Open [Genome Browser](GENOME_BROWSER.md) for those details.

Name-based links can be missing or misleading when annotations use different naming conventions. Homology-based links depend on the supplied tables. Differences in gene content can also arise from annotation or assembly differences.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Homology](HOMOLOGY.md) · [Gene Trees](GENE_TREES.md)
