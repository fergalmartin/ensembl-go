# Track Manager

Track Manager registers local evidence files against genomes so they can be displayed in Genome Browser. It also organises track groups and retrieves supported tracks through the Track Hub Registry.

## Before you start

Have the target genome available locally and check that each track uses its assembly coordinates and sequence names. Indexed formats need their required indexes.

Supported types include BigWig signal, BED and BigBed intervals, GFF3/GTF features, indexed VCF variants, STAR splice junctions, and indexed short-read or long-read BAM files.

## Using the view

1. Register a file against its genome, choosing its track type, label and display settings. Use batch registration when adding several files.
2. Search and edit registrations, and organise related tracks into named groups for repeated use.
3. For quantitative tracks, choose a suitable display preset. RNA-seq BigWig can use a zoned coverage heatmap; ATAC-seq can use a conventional signal plot. Adjust style, scale, thresholds and colours to fit the data.
4. Open **Track Hub Registry** to browse supported BigWig and BigBed tracks and retrieve them for local use. This requires connectivity.
5. In [Genome Browser](GENOME_BROWSER.md), use **Add Custom Track** on the matching genome panel. Activate individual tracks or groups, reorder them by dragging, and show or hide them as needed.

## Things to know

Registration makes a track available; adding it to a browser panel controls its display. Keep the source file and any index available at the registered location.

VCF displays change with zoom, from a broader overview to individual variants with allele and coordinate details. STAR junction and BAM tracks provide evidence alongside annotation; differences between them and a gene model need to be assessed in the context of the underlying experiment.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Genome Selector](GENOME_SELECTOR.md) · [Feature Explorer](FEATURE_EXPLORER.md)
