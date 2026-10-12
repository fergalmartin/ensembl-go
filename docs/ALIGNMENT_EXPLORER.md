# Alignment Explorer

Alignment Explorer inspects existing sequence alignments and their connected blocks. Named layers let you collect regions of interest while keeping the imported alignment available.

## Before you start

Have an alignment file ready, use the built-in example, or open a result from [Feature Alignment](FEATURE_ALIGNMENT.md). Supported formats include MAF, aligned FASTA, XMFA, Stockholm, Clustal and PHYLIP, including compressed local files.

Local genomes are optional. They are needed only when you want to connect aligned rows to genomic context.

## Using the view

1. Choose **Open an alignment** or **Explore example**. Check the detected format; if detection fails, choose the appropriate format when reopening the file.
2. Pan and zoom through sequence rows and blocks. Follow connectors to neighbouring blocks or use jump connectors when a sequence skips blocks.
3. Filter sequences and blocks in the sidebar. Link rows to local genomes where you want to open the corresponding genomic region in Genome Browser.
4. Select regions and copy them into a new layer. Name and colour the layer, then adjust its sequence colouring and gap filters.
5. Highlight layer components in the original alignment to see where they came from.
6. Save and load a workspace to return to the comparison. Export a selected region or layer as sequence data in an available format.

## Things to know

Filters and working layers change what you examine; the original alignment remains available. A workspace retains the exploration state, while a sequence export contains the chosen alignment content.

Genome navigation needs a valid link and genomic coordinates in the source alignment. A transcript or protein alignment may be useful without providing enough information to locate every position in a genome.

## Related views

[Feature Alignment](FEATURE_ALIGNMENT.md) · [Genome Browser](GENOME_BROWSER.md) · [Gene Trees](GENE_TREES.md)
