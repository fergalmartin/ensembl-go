# Demo data for a tutorial

A tutorial must run offline, on a machine that is not the author's, without the user
downloading a genome first. That is what the bundled data is for. The rule is **reuse
first, generate small, store centrally** — in that order.

## Where the data lives

Everything a shipped tutorial can install lives under `backend/data/`:

| Location | Holds | Size |
| --- | --- | --- |
| `backend/data/demo_genome/` | *Ensemblus welcomus* — 22 kb, two contigs, six genes (Welcome, To, Ensembl, Go, Have, Fun) | 40 K |
| `backend/data/grch38_reg4/` | The real chromosome-1 slice the browser tutorial runs on — 1.65 Mb of real sequence in a 1.68 Mb declared window | 1.0 M |
| `backend/data/demo_tracks/` | The three data tracks the Track Manager tutorial registers — a 220 kb window of real GRCh38 coverage, peaks and variants | 988 K |
| `backend/data/tutorials/<tutorial-id>/datasets/<recipe-id>/` | Per-tutorial dataset recipes, written by promotion | 1.6 M today |

The first two are `BundledGenome` records in `backend/demo_genome.py`, listed by
`GET /api/demo/genome` and installed by `POST /api/demo/genome/install`. The third is the
recipe store, and it is the one a new tutorial writes into.

**Nothing else is a legitimate home.** Data under the author's output directory, next to a
component, or in `test-data/` will not survive promotion and will not exist on anyone
else's machine.

## Reuse before generating

`install_recipe` resolves a recipe id by looking in the draft directory first, then calling
`find_bundled_recipe`, which globs **`backend/data/tutorials/*/datasets/<recipe-id>`** — across
every tutorial, not just the one being played. So a recipe bundled for one tutorial is
directly reusable by another by referencing its id; `save_draft` copies it into the new
draft automatically. No bytes are duplicated in the repository.

**Before generating anything, take the inventory and ask what it already answers:**

```bash
ls backend/data/tutorials/*/datasets/                  # every reusable recipe id
for r in backend/data/tutorials/*/datasets/*/recipe.json; do
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); \
    print(d['id'], d['speciesKey'], d['assembly'], d.get('browsableRange'))" "$r"
done
du -sh backend/data/demo_genome backend/data/grch38_reg4 backend/data/tutorials/*
```

What exists today:

| Recipe / genome | What it is | Good for |
| --- | --- | --- |
| `ensemblus_welcomus` | Synthetic 22 kb genome, six named genes, real ORFs | Teaching download, activation and the basic browser loop with no network |
| `grch38_reg4` | Real chr1 slice, REG4/PHGDH/HMGCS2/TBX15 | Anything about real annotation: transcripts, gene classes, notes, sequence |
| `slice-f2b4e46327a2` etc. (4) | Human Ensembl, human RefSeq, mouse, rat around SAMD11 | Multi-genome comparison, region and gene linking |
| `tmnt-*-v1` (8) | Synthetic 36 kb genomes — four turtles, Splinter, April, Rocksteady, Bebop | Anything needing *several* genomes where the sequence is irrelevant: selection, playlists, pills |
| `demo_tracks/` (3 files) | Real brain RNA-seq, ATAC-seq and variants over `1:119,600,000-119,820,000` | Anything about custom data tracks: they are read against `grch38_reg4`, which they do not duplicate |

Reuse is not only about bytes. A reader who has done another tutorial already knows these
genomes, and a tutorial that teaches a new concept on familiar data is teaching one thing
rather than two. Generate new data only when the existing sets genuinely cannot carry the
lesson — a different assembly, a gene with the right transcript structure, a species
relationship the tutorial is about.

## The two kinds of dataset, and which to choose

**Synthetic fixture** — `fixtureId`, `source.type: 'synthetic-fixture'`,
`containsRealSequence: false`. Generated deterministically by `generate_fixture_pack` in
`backend/tutorial_datasets.py`: a 36 kb chromosome, four small genes, FASTA index, GFF3 and
assembly report per genome. **Choose this whenever the sequence itself does not matter** —
the tutorial is about selecting, organising or comparing *genomes as objects*. It is the
cheapest option and it carries no provenance or licensing question.

**Region recipe** — **Create recipe from region** in the builder, or `generate_recipe`.
Extracts real sequence and complete annotation at the current coordinates, keeping true
coordinates, deterministic hashes, provenance, FASTA indexes, the assembly manifest and a
`browsable_range`. Partial genes may expand the boundary (the default), be omitted, or
cancel generation; expanded real sequence is capped at 5 Mb. **Choose this when the lesson
is about real annotation** — transcript structure, gene classes, synteny, two annotations
of one assembly.

Two things to get right with a region recipe:

- **Declare `browsable_range`.** Without it the reader can pan out into a hundred megabases
  of padding, which reads as the browser being broken rather than as the edge of a slice.
  Only `grch38_reg4` declared one for a long time, and that is why.
- **Warn about what it contains.** A package made from a private or custom genome carries
  that real sequence and annotation. Preserve source provenance and required attribution,
  and say so to the author before exporting.

## Keeping the footprint small

The data ships in the repository, so it has to stay small enough to belong there. Measured
from what is bundled today:

| Data | On disk |
| --- | --- |
| 22 kb synthetic genome | 40 K |
| 36 kb synthetic fixture genome | 52 K each — 416 K for all eight |
| ~180 kb real slice, bgzipped | 96–116 K |
| ~1.65 Mb real slice, bgzipped | 1.0 M |

Budget roughly **100 K per small real slice** and **50 K per synthetic genome**, and treat a
whole tutorial's data going much past **2 MB** as a signal to cut the window rather than a
cost to absorb.

How to stay inside that:

- **Take the smallest window that supports the lesson**, with room to pan and zoom and
  nothing more. 180 kb was enough for four annotations around SAMD11.
- **Prefer a synthetic fixture** wherever the sequence is scenery.
- **Prefer reuse**, which costs nothing at all.
- **Keep the sequence compressed.** Real slices ship as `.fa.bgz` with `.gzi` and `.fai`,
  annotation as `.gff3.gz`. The compressed FASTA padding preserves coordinates for a slice
  far along a chromosome without storing the megabases before it.
- **Measure before committing**: `du -sh backend/data/tutorials/<id>/`. State the figure in
  the handoff entry.
- Everything is **deterministic** — regenerate and commit rather than editing files by hand,
  the way `backend/scripts/build_demo_genome.py` is used.

**A single file can blow the whole budget, and a VCF is the one that will.** The Track Manager
tutorial wanted the browser tutorial's whole 1.68 Mb window; the same window of a dbSNP dump is
648,191 variants and **7.08 MB bgzipped** — four times the budget for one file, where the two
BigWigs beside it came to 0.70 MB for the same window. Cut to 220 kb it is 0.91 MB. Measure the
expensive file *first* and let it choose the window, rather than picking the window and
discovering afterwards.

**Sub-setting the tracks does not mean sub-setting the genome.** Reusing `grch38_reg4`
unchanged and cutting only the tracks added no genome bytes at all. The cost is that the tracks
stop before the genes do — say so in a card rather than letting a reader who pans out think the
app is broken.


## Bundling: the step that is easy to miss

Promotion (`promote_draft`) copies `<draft>/datasets/` into
`backend/data/tutorials/<id>/datasets/`. **Verify it actually landed**, because a document
that references recipes which are not in the repository plays perfectly on the author's
machine — where the draft still exists — and fails everywhere else with
`Tutorial dataset <id> is unavailable.`

```bash
python3 - <<'PY'
import json, pathlib
doc = json.load(open('frontend/src/tutorials/generated/<id>.tutorial.json'))
root = pathlib.Path('backend/data/tutorials')
for dataset in doc.get('datasets', []):
    if not dataset.get('embedded'):
        continue
    rid = dataset['recipeId']
    found = list(root.glob(f'*/datasets/{rid}/recipe.json'))
    print('OK ' if found else 'MISSING ', rid, found[0].parent if found else '')
PY
```

**This is not hypothetical.** The Genome Playlists tutorial (`tutorial-mt8m7a4h`) shipped
this way: it referenced eight `tmnt-*-v1` recipes that existed only in the author's draft
directory, so it played correctly for the author and could not install its genomes on any
other machine. Fixed by copying the recipes into
`backend/data/tutorials/tutorial-mt8m7a4h/datasets/` — see the handoff for the reasoning,
including why re-promoting the draft would have been the wrong fix.

**Run the check after every promotion.** This is the one failure mode that is invisible on
the machine the tutorial was authored on, and walking the tutorial in the running app will
never show it.

**If the check fails, copy the recipes rather than re-promoting** — unless you are certain
the draft and the promoted document have not diverged. Re-promotion overwrites the shipped
document with the draft and regenerates `generatedTutorials.js`. Verify a copy the way that
fix was verified: check every recipe's declared files against their SHA-256s first, then call
`install_recipe` for each against a temporary output directory with **no draft in it**, which
is the path a fresh checkout takes.
