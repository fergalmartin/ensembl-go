# Genome Browser

Genome Browser displays local sequence, gene annotations and custom tracks along genomic coordinates. Each active genome has its own panel, so you can inspect one assembly or compare several in the same view.

## Before you start

Select and activate genomes in [Genome Selector](GENOME_SELECTOR.md). Gene browsing needs an annotation; the first visit may build its local index. Register additional evidence tracks in [Track Manager](TRACK_MANAGER.md).

## Using the view

1. Search within a genome panel for a gene symbol, stable identifier or region.
2. Pan and zoom to move between chromosome context and individual bases. Drag a region selection to zoom into it.
3. Use the general controls above the panels for shared settings, and a panel's own controls for that genome.
4. Show or hide gene classes, forward and reverse gene tracks, sequence and registered custom tracks. Expand transcripts, use a compressed layout, reorder tracks by dragging, or flip their orientation.
5. Click a gene or focus a region to open its drawer. Inspect details and sequence, write a note, or continue to another view.

A focused gene carries through to views such as [Feature Explorer](FEATURE_EXPLORER.md) and [Sequence](SEQUENCE.md), so you can examine the same feature in more detail.

### Comparing genomes

Activate additional genomes in the top bar to show more panels. Controls can link panning and zooming. **Link gene** looks for matching gene symbols or identifiers in the other genomes. **Link region** looks for matching region names or synonyms and copies coordinates within the available sequence lengths.

## Things to know

Browser gene linking uses name or identifier matches rather than homology inference. Region linking is useful when assemblies share a coordinate system; it does not transfer coordinates through an alignment between species or haplotypes. Use [Structural Variation](STRUCTURAL_VARIATION.md) for chain-based comparisons.

Tracks must refer to the genome and sequence names being viewed. An empty track can reflect missing data or a naming mismatch rather than an absence of biological signal.

## Related views

[Feature Explorer](FEATURE_EXPLORER.md) · [Sequence](SEQUENCE.md) · [Track Manager](TRACK_MANAGER.md) · [Notes](NOTES.md)
