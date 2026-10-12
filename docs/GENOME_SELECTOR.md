# Genome Selector

Genome Selector manages the assemblies available locally and the genomes selected for the current session. It also handles custom genomes, annotations and saved genome playlists.

## Before you start

Download an assembly through [Download](DOWNLOAD.md), or have a local genome FASTA ready to import. Annotation is optional for sequence browsing; gene-based views need a compatible annotation.

## Using the view

1. Find an assembly in the local list and check its data source, accession, annotation dataset, files and index status.
2. Tick its row to add it to the genome buttons at the top of the app. Assign a colour to make it easier to follow across views.
3. Click a genome button to activate or deactivate it. Use its cross to remove it from the selected set.
4. Add genomes to a named **Genome Playlist** when you want to return to the same collection. Playlists can have descriptions and can be chosen from the Genome Playlist action anywhere in the app.

Choosing a playlist replaces the selected set and filters the list. **Previous session** provides the previous selection when one is available.

### Importing your own data

Use the custom-genome controls to add a FASTA, alone or with a GFF3 or GTF annotation. Review the checks for sequence names, feature counts, annotation format and identifier issues before importing.

The importer normalises supported annotations into a gene, transcript and exon hierarchy. Review its reports of repairs and unresolved features. You can retain suitable identifiers or generate Ensembl-style identifiers; a mapping file records identifier changes.

Portable genome bundles describe genomes through metadata and file references. Review missing-file warnings and make the referenced files available on the receiving computer.

## Things to know

Selecting a genome, activating it and deleting its local data are separate actions. Removing a genome button only deselects it; the local assembly remains available.

A playlist records a selection. A genome bundle records metadata and paths. Neither includes the genome sequence or annotation files themselves.

## Related views

[Download](DOWNLOAD.md) · [Genome Browser](GENOME_BROWSER.md) · [Track Manager](TRACK_MANAGER.md)
