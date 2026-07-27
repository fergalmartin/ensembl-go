# Genome Browser — Implementation Progress

**Status**: Core implementation complete, ready for testing.

## What's Done

### Backend (main.py)
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

### Frontend Components
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

## Design Decisions
- **Pixel-based pan sync** (not genomic coordinates) — per user preference
- **Canonical transcript** identified via `tag=Ensembl_canonical` in GFF3
- **Aesthetic** matches existing app theme system (not strict Ensembl copy)

## What Needs Testing
1. Regenerate GFF3 indexes to pick up new schema (is_canonical, biotype)
2. Start backend + frontend dev servers
3. Click genome browser nav button → verify regions load
4. Select region → verify genes render
5. Zoom in → verify exon/intron detail appears
6. Zoom to sequence level → verify bases render
7. Test dual browser mode with lock controls

## Resume Context
If switching models: the core files are `alignment_viewer/backend/main.py` (browse endpoints near end of file), `alignment_viewer/frontend/src/components/GenomeBrowser.jsx`, `GenomeBrowserView.jsx`, and `App.jsx`.
