# Ensembl Go user guides

These guides explain the purpose, requirements and main controls of each view. For installation and platform-specific setup, see [INSTALLATION.md](../INSTALLATION.md).

## Getting started

1. Set an **Output Directory** in [Configuration](CONFIGURATION.md).
2. Use [Download](DOWNLOAD.md) to obtain genome sequence and gene annotation, or import your own files in [Genome Selector](GENOME_SELECTOR.md).
3. Select the genomes you want to work with in Genome Selector.
4. Activate a genome and open [Genome Browser](GENOME_BROWSER.md).
5. Try [Tutorials](TUTORIALS.md) for guided practice in a separate example session.

## View guides

| View | Use it to |
| --- | --- |
| [Achievements](ACHIEVEMENTS.md) | Explore optional rewards and track progress |
| [Alignment Explorer](ALIGNMENT_EXPLORER.md) | Inspect existing alignments and collect regions in layers |
| [Configuration](CONFIGURATION.md) | Set the workspace, preferences, colours and shortcuts |
| [Download](DOWNLOAD.md) | Retrieve Ensembl and RefSeq data for local use |
| [Feature Alignment](FEATURE_ALIGNMENT.md) | Align annotated gene regions with MAFFT |
| [Feature Explorer](FEATURE_EXPLORER.md) | Inspect transcripts, splicing, exons, proteins and structures |
| [Gene Trees](GENE_TREES.md) | Explore imported trees and connect leaves to local genomes |
| [Genome Browser](GENOME_BROWSER.md) | Browse sequence, annotation and evidence across active genomes |
| [Genome Selector](GENOME_SELECTOR.md) | Select local genomes, import data and manage playlists |
| [Help](HELP.md) | Read short explanations of the app's controls |
| [Home](HOME.md) | Find and open available views |
| [Homology](HOMOLOGY.md) | Search and compare precomputed homology tables |
| [Neighbourhood](NEIGHBOURHOOD.md) | Compare gene order around selected genes |
| [Notes](NOTES.md) | Record observations and organise tasks |
| [Sequence](SEQUENCE.md) | Read, search, select and export feature-aware sequence |
| [Statistics](STATISTICS.md) | Compare assembly, annotation and homology summaries |
| [Structural Variation](STRUCTURAL_VARIATION.md) | Compare assemblies through BigChain alignments |
| [Track Manager](TRACK_MANAGER.md) | Register and organise custom evidence tracks |
| [Tutorials](TUTORIALS.md) | Learn workflows through guided examples |

## Shared controls

Selected genomes appear as coloured buttons at the top of the app. Click a genome button to activate or deactivate it. Use its cross to remove it from the selected set; this does not delete its local data. The effect of activation depends on the view, and several views can show multiple active genomes.

**Genome Playlist** loads a saved collection from anywhere in the app. Create and edit playlists in Genome Selector. **Theme Toggle** changes the appearance. **Screenshot** starts capture where a view offers an exportable panel.

Use **Organise Apps** in Configuration to choose the visible shortcuts and their order. Home provides access to views whose shortcuts are hidden. Structural Variation, Homology, Gene Trees and Achievements are absent from the default bar.

## Working locally

Downloaded and imported sequence, annotation, alignments and tracks can be explored offline once their required files and indexes are available. Catalogue updates, downloads, track retrieval, external links and uncached protein structure or assembly metadata lookups need connectivity. MAFFT is required for views that generate new local alignments.

Use the same output directory when returning to a project so its local catalogue and saved records remain available.
