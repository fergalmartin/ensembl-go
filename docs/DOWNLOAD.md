# Download

Download finds public assemblies and retrieves their sequence, annotation and supporting files for local use. The **Ensembl** and **RefSeq** tabs switch between catalogues.

## Before you start

Set an output directory in [Configuration](CONFIGURATION.md). An internet connection is needed to retrieve catalogue updates and download files.

## Using the view

1. Choose Ensembl or RefSeq and search by scientific or common name, assembly name, or GCA/GCF accession. You can also browse the available taxonomic and project groupings.
2. Expand a species with several assemblies to choose the one you want.
3. Choose data types in the toolbar. **Genome** and **Genes** are the usual starting point. Ensembl assemblies may also offer homology, cDNA, protein and cross-reference files.
4. Use the download control beside an assembly, or download the selected data types for all assemblies of a species.
5. Follow progress in the active downloads section. Downloads continue while you use other views.
6. When the files are ready, select the genome in [Genome Selector](GENOME_SELECTOR.md).

For Ensembl data, the exact-file picker lets you select individual files and annotation datasets, including different annotation releases for an assembly.

## Things to know

The available data types depend on the provider and assembly. Homology files are needed for the Homology view and its statistics, but are optional for ordinary genome browsing.

Local indexing prepares files for the analysis views. A large annotation can take time to index on first use. Once the required files and indexes are available, local browsing works offline.

## Related views

[Genome Selector](GENOME_SELECTOR.md) · [Genome Browser](GENOME_BROWSER.md) · [Homology](HOMOLOGY.md)
