# Gene Trees

Gene Trees imports previously inferred trees, links their leaves to local genomes and provides working layers for exploring gene families.

## Before you start

Have a tree file or collection ready. Supported inputs include Newick, NHX, Ensembl JSON and EMF, with compressed files supported. Indexed local annotations are needed to resolve leaves to genes. Open the view from Home, or add its shortcut through **Organise Apps** in Configuration.

MAFFT is needed when you request a new local sequence alignment alongside a tree; it is not needed simply to open a tree.

## Using the view

1. Import trees into the library. Collections are indexed for searching by gene symbol, gene or protein identifier, or tree identifier.
2. Open a tree and review the suggested links between its leaves and local genomes. Use manual mappings where names or identifiers differ.
3. Choose a linear or radial layout. Show branch lengths to scale where the input provides them.
4. Fold, unfold, focus or flip clades to inspect a family. Review event labels and the legend where the source provides speciation, duplication, ambiguous or gene-split annotations.
5. Add data views beside linked leaves to inspect gene and transcript structures, neighbourhoods or sequence alignments.
6. Copy subtrees into working layers. Prune, split, merge or graft selected regions, using undo and redo to explore alternatives.
7. Export a working tree in Newick or NHX form using the available export controls.

## Things to know

Leaf markers distinguish local genome links and whether a gene resolves in an indexed annotation. An unresolved leaf can reflect naming or annotation differences; it does not by itself show that a gene is absent.

Working layers retain the original imported tree. Editing their content organises a comparison; it does not infer or validate a new evolutionary relationship. Branch lengths and event labels retain the meaning supplied by the original analysis.

## Related views

[Homology](HOMOLOGY.md) · [Neighbourhood](NEIGHBOURHOOD.md) · [Feature Explorer](FEATURE_EXPLORER.md) · [Feature Alignment](FEATURE_ALIGNMENT.md)
