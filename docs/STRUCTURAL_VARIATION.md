# Structural Variation

Structural Variation compares an anchor genome with one or two target genomes through BigChain alignments. Alignment ribbons, gene tracks and optional evidence tracks show the relative position and orientation of corresponding regions.

## Before you start

Make the compared assemblies available locally, with annotation for gene displays. Supply a compatible BigChain file for each anchor-to-target comparison. A plain chain file or ordinary feature BigBed is not a substitute for a BigBed-indexed chain alignment.

Open the view from Home, or add its shortcut through **Organise Apps** in Configuration.

## Using the view

1. Register an alignment through the interface, or load a key-value or JSON configuration describing its genomes, alignment file and optional tracks.
2. For a key-value configuration, copy the [alignment template](examples/sv-alignments.template.cfg), fill in its required fields, and use **Configuration > Load file** within this view.
3. Choose the anchor, region and one or two targets. Check that the registered assemblies and sequence names match your local files.
4. Pan and zoom through the ribbons and annotation. Inspect orientation changes, aligned blocks and gaps, with sequence-level detail available for the anchor.
5. Reposition gene tracks or recentre them on the alignment as needed. Add compatible BigWig or BigBed tracks for additional context.

## Things to know

The chain file's indexed side can be the reference or target; this describes its indexed coordinates and does not change which genome is the anchor. Sequence names can be derived from the files, with aliases or mapping files for naming differences. The template explains these options and relative paths.

Two target panels let you compare changes shared between assemblies or specific to one. Interpret them in light of the assemblies and alignment quality. An unaligned interval alone is not a confirmed structural variant.

## Related views

[Genome Browser](GENOME_BROWSER.md) · [Genome Selector](GENOME_SELECTOR.md) · [Track Manager](TRACK_MANAGER.md)
