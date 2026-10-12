# Homology

Homology searches precomputed homology tables and compares the matches reported for one or two selected genes.

## Before you start

Download Ensembl homology TSV files through [Download](DOWNLOAD.md), or supply compatible tables locally. Activate the genomes you want to query. Open the view from Home, or add its shortcut through **Organise Apps** in Configuration.

## Using the view

1. Choose one or two active genomes and search for a gene symbol or stable identifier.
2. Inspect the matched genomes and gene identifiers, together with the available identity, coverage, scores and relationship information.
3. Sort and filter the tables to focus on the matches relevant to your comparison.
4. With two genes selected, inspect their separate result tables and the comparison table showing shared and unique matches.

Use [Neighbourhood](NEIGHBOURHOOD.md) to examine related genes in local gene-order context, or [Gene Trees](GENE_TREES.md) to explore an imported evolutionary tree.

## Things to know

This view reads relationships supplied in the homology files. It does not calculate a new homology assignment. Available fields and their interpretation depend on the method, annotation and reference collection used to produce those files.

A missing result can mean that no matching record exists in the local table. Check the queried identifier and available data before treating it as biological absence.

## Related views

[Download](DOWNLOAD.md) · [Neighbourhood](NEIGHBOURHOOD.md) · [Gene Trees](GENE_TREES.md) · [Statistics](STATISTICS.md)
