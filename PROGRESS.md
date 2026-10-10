# Genome Browser implementation notes

This records the initial browser implementation and its acceptance checklist.
It is a historical snapshot, not a statement of release readiness. The browser
now supports multiple genomes; Reference / Target / Both below describes the
original two-genome layout.

See [DEVELOPMENT.md](DEVELOPMENT.md) for current module ownership and
[the performance review](docs/GENOME_BROWSER_PERFORMANCE.md) for later changes
and regression checks.

## Initial implementation

### Backend
- **GFF3 Indexer** updated:
  - `is_canonical` column on `transcripts` table (from `tag=Ensembl_canonical`)
  - `biotype` column on `genes` table
  - New `idx_genes_chrom_end` index for range queries
- **4 Browse API endpoints**:
  - `GET /api/browse/regions` — list chromosomes with gene counts and size filter
  - `GET /api/browse/genes` — spatial overlap query for genes in a range
  - `GET /api/browse/transcripts` — all transcripts for a gene (canonical first)
  - `GET /api/browse/sequence` — raw sequence fetch (max 10kb)
- All endpoints use `run_in_threadpool` for non-blocking I/O

### Frontend
- **GenomeBrowser.jsx** — Canvas-based browser:
  - Coordinate ruler with adaptive tick spacing
  - Forward/reverse strand gene tracks
  - Multi-zoom: block → exon/intron structure → sequence bases
  - Gene selection with red dashed focus lines
  - `+N transcripts` pill buttons (HTML overlay)
  - Region selector dropdown with ≥10kb filter
  - Coordinate search (gene name or chr:start-end)
  - Pan (drag + momentum) and zoom (wheel/pinch)
- **GenomeBrowserView.jsx** — Dual browser container:
  - Mode toggle: Reference / Target / Both
  - Lock Pan (pixel-based sync) and Lock Zoom buttons
  - Split layout with divider bar
- **App.jsx** — Integrated:
  - Import + chromosome icon nav button + view switch case

## Design decisions
- **Pixel-based pan sync** (not genomic coordinates) — per user preference
- **Canonical transcript** identified via `tag=Ensembl_canonical` in GFF3
- **Aesthetic** matches existing app theme system (not strict Ensembl copy)

## Original acceptance checks
1. Regenerate GFF3 indexes to pick up new schema (is_canonical, biotype)
2. Start backend + frontend dev servers
3. Click genome browser nav button → verify regions load
4. Select region → verify genes render
5. Zoom in → verify exon/intron detail appears
6. Zoom to sequence level → verify bases render
7. Test dual browser mode with lock controls

## Current source locations

| Area | Location |
| --- | --- |
| Annotation index and worker | `backend/gff_index.py` |
| Browse endpoints | `backend/routes/browse.py` |
| Genome resolution and FASTA access | `backend/genome_context.py`, `backend/file_io.py` |
| Single-panel browser and helpers | `frontend/src/components/genome-browser/` |
| Multi-panel view helpers | `frontend/src/components/genome-browser/view/` |
| App state and layout | `frontend/src/App.jsx`, `frontend/src/app/`, `frontend/src/components/app-shell/` |
