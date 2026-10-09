"""The Genome Browser's data endpoints: genome index status and retry, regions with their
browsable ranges, genes and transcripts in a window, the default locus, gene search,
resolving an identifier to a location, canonical transcripts and the reference
sequence.
"""

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import genome_context
import gff_index

router = APIRouter()


def _genome_browsable_ranges(genome: str) -> Dict[str, Any]:
    """Per-region browsable windows a genome's manifest declares, if any.

    Read from the manifest on disk rather than from the genome record, because the record
    is assembled by ``list_local_assemblies`` and carries only the fields it knows about.
    Empty for everything that does not declare one, which is everything except the
    tutorial's chromosome-1 slice.
    """
    try:
        context = genome_context._resolve_browse_genome_context(genome)
        fasta_path = str(context.get("fasta_path") or "").strip()
        if not fasta_path:
            return {}
        for manifest_path in Path(fasta_path).parent.glob("*.genome_manifest.json"):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            declared = manifest.get("browsable_range") or {}
            if isinstance(declared, dict):
                return declared
    except Exception:
        pass
    return {}


class RegionInfo(BaseModel):
    chrom: str
    gene_count: int
    start: int
    end: int
    length: int
    synonyms: List[str] = []
    display_name: Optional[str] = None
    # The part of this region worth looking at, when the genome says that is narrower than
    # the region itself. Only the bundled tutorial slice declares one: it is a real
    # chromosome coordinate space holding a small window of real sequence, and without
    # this the browser happily pans out into a hundred megabases of padding. Absent for
    # every other genome, which is left exactly as it was.
    browsable_start: Optional[int] = None
    browsable_end: Optional[int] = None


class BrowseGene(BaseModel):
    id: str
    name: Optional[str] = None
    description: Optional[str] = None
    chrom: str
    start: int
    end: int
    strand: str
    biotype: str = ""
    version: str = ""
    is_focal: bool = False


class BrowseTranscript(BaseModel):
    id: str
    chrom: str
    start: int
    end: int
    strand: str
    biotype: str = ""
    version: str = ""
    is_canonical: bool = False
    tags: list = []
    exons: list = []
    cds_list: list = []
    utrs: list = []


class BrowseCanonicalTranscriptEntry(BaseModel):
    gene: BrowseGene
    transcript: BrowseTranscript


class BrowseDefaultLocus(BaseModel):
    chrom: str
    start: int
    end: int
    chrom_length: int
    gene: Optional[BrowseGene] = None
    transcript_count: int = 0


#: What a genome's gene track can expect of its annotation index. The browser
#: renders from the assembly the moment it has one, so these describe what is
#: still missing rather than whether the genome can be shown at all.
INDEX_STATE_READY = "ready"       # built and current; genes are queryable


INDEX_STATE_BUILDING = "building"  # this annotation is being parsed right now


INDEX_STATE_QUEUED = "queued"      # waiting behind another build


INDEX_STATE_FAILED = "failed"      # the last build failed and was not superseded


INDEX_STATE_NONE = "none"          # no annotation configured; there are no genes


INDEX_STATE_ABSENT = "absent"      # an annotation with no index and no build


def _live_index_task_for(gff_path: str, db_path: str) -> Tuple[str, Dict[str, Any]]:
    """The queued or running build for this annotation, with its task id."""
    normalized_gff = gff_index._normalize_fs_path(gff_path)
    normalized_db = gff_index._normalize_fs_path(db_path) if db_path else ""
    with gff_index._index_tasks_guard:
        for task_id, task in gff_index._index_tasks.items():
            if task.get("status") not in {"queued", "running"}:
                continue
            if task.get("gff_path") == normalized_gff or (
                normalized_db and task.get("db_path") == normalized_db
            ):
                return task_id, dict(task)
    return "", {}


def _index_status_for_genome(genome: str) -> Dict[str, Any]:
    """How far along this genome's gene index is, for the browser's meter.

    Deliberately does no work beyond looking: it is polled every second or two
    per panel while a build runs, and it must never be the thing that queues a
    build, or a view that merely watches progress would start one.
    """
    context = genome_context._resolve_browse_genome_context(genome)
    gff_path = str(context.get("gff_path") or "")
    db_path = str(context.get("db_path") or "")

    status: Dict[str, Any] = {
        "genome": genome,
        "state": INDEX_STATE_NONE,
        "percent": None,
        "genes": 0,
        "transcripts": 0,
        "stage": "",
        "queue_position": 0,
        "queue_length": 0,
        "detail": "",
        "error": "",
    }

    if not gff_path or not os.path.exists(gff_path):
        status["detail"] = "This genome has no annotation, so it has no gene track."
        return status

    if db_path and gff_index._is_existing_index_usable(db_path, gff_path):
        status["state"] = INDEX_STATE_READY
        status["percent"] = 100.0
        return status

    task_id, task = _live_index_task_for(gff_path, db_path)
    if task_id:
        positions = gff_index._queued_index_positions()
        status["queue_position"] = int(positions.get(task_id, 0))
        status["queue_length"] = len(positions)
        if task.get("status") == "running":
            status["state"] = INDEX_STATE_BUILDING
            progress = task.get("progress") or {}
            total = int(progress.get("total_bytes") or 0)
            processed = int(progress.get("processed_bytes") or 0)
            status["stage"] = str(progress.get("stage") or "parsing")
            status["genes"] = int(progress.get("genes") or 0)
            status["transcripts"] = int(progress.get("transcripts") or 0)
            if total > 0:
                # Parsing is the long pole but not the whole job: the write-out
                # phase that follows is real time the user waits through. Hold
                # the meter at 96% for it rather than sitting on a finished-
                # looking 100% while transcripts are still being inserted.
                fraction = min(1.0, max(0.0, processed / total))
                status["percent"] = round(
                    96.0 if str(progress.get("stage")) == "writing" else fraction * 96.0,
                    1,
                )
            status["detail"] = f"Reading {os.path.basename(gff_path)}."
        else:
            status["state"] = INDEX_STATE_QUEUED
            status["detail"] = "Waiting for the current index build to finish."
        return status

    build_error = genome_context._index_build_error_for(gff_path, db_path)
    if build_error:
        status["state"] = INDEX_STATE_FAILED
        status["error"] = build_error
        status["detail"] = build_error
        return status

    status["state"] = INDEX_STATE_ABSENT
    status["detail"] = "This annotation has not been indexed yet."
    return status


@router.get("/api/browse/index-status")
async def browse_index_status(genome: str = "reference"):
    """Progress of the gene index behind a genome's browser panel."""
    return await run_in_threadpool(_index_status_for_genome, genome)


class IndexRetryRequest(BaseModel):
    genome: str


@router.post("/api/browse/index-retry")
async def browse_index_retry(request: IndexRetryRequest):
    """Forget a failed build for this genome and start another one.

    A failure is remembered so that polling does not turn an unparseable file
    into an endless rebuild loop; this is the door out of that, so the user is
    not left restarting the backend to retry a build that failed once.
    """
    def _retry() -> Dict[str, Any]:
        context = genome_context._resolve_browse_genome_context(request.genome)
        gff_path = str(context.get("gff_path") or "")
        db_path = str(context.get("db_path") or "")
        if not gff_path or not os.path.exists(gff_path):
            raise HTTPException(
                status_code=404,
                detail=f"No annotation is configured for the {request.genome} genome.",
            )
        forgotten = gff_index.forget_index_failures(gff_path, db_path)
        if not db_path:
            raise HTTPException(
                status_code=500,
                detail=f"Could not work out where to write the index for {request.genome}.",
            )
        task_id, task_status = gff_index.queue_index_build(gff_path, db_path)
        return {"task_id": task_id, "status": task_status, "cleared_failures": forgotten}

    return await run_in_threadpool(_retry)


def _get_browse_db_for_regions(genome: str) -> Tuple[str, bool]:
    """``(index path, is the index still coming)`` for the region list.

    Regions are the assembly, not the annotation: the FASTA has them the moment
    the genome is loaded, and an index build that takes minutes should not hold
    them back. So unlike :func:`_get_browse_db_optional`, a build in flight
    yields no index and a flag saying genes are on their way, and the caller
    serves the assembly now. What kept this honest before was the 425 — the
    caller had no other way to tell "genes are coming" from "there are none".
    ``/api/browse/index-status`` is that way now, and the browser polls it to
    fill the gene track in when the build lands.
    """
    try:
        return genome_context._get_browse_db(genome), False
    except HTTPException as exc:
        if exc.status_code == 404:
            return "", False
        if exc.status_code == genome_context.INDEX_BUILDING_STATUS:
            return "", True
        raise


@router.get("/api/browse/regions")
async def browse_regions(genome: str = "reference", min_length: int = 0):
    """List all regions (chromosomes/scaffolds) with gene counts.
    Includes featureless regions (gene_count=0) so the frontend can show them
    behind a disclosure control. min_length kept for API compatibility only.
    """
    # A genome loaded without an annotation — or with one that is still being
    # indexed — still has regions: they come from the FASTA below. Only the gene
    # counts are unavailable.
    db_path, index_pending = await run_in_threadpool(_get_browse_db_for_regions, genome)

    def _query():
        rows = []
        if db_path:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("""
                SELECT chrom, COUNT(*) as gene_count, MIN(start) as start, MAX(end) as end
                FROM genes
                GROUP BY chrom
            """)
            rows = c.fetchall()
            conn.close()
        results_by_chrom: Dict[str, RegionInfo] = {}
        for r in rows:
            chrom = str(r["chrom"] or "").strip()
            if not chrom:
                continue
            start = int(r["start"] or 1)
            end = int(r["end"] or max(start + 1, 2))
            region = RegionInfo(
                chrom=chrom,
                gene_count=int(r["gene_count"] or 0),
                start=max(1, start),
                end=max(2, end),
                length=max(1, end - max(1, start)),
            )
            results_by_chrom[chrom] = region

        # Use FASTA as canonical region bounds where available, and also
        # complement with FASTA sequences not present in the GFF.
        try:
            fasta = genome_context._get_browse_fasta(genome)
            for seq in fasta.references:
                length = int(fasta.get_reference_length(seq))
                existing = results_by_chrom.get(seq)
                if existing:
                    existing.start = 1
                    existing.end = max(1, length)
                    existing.length = max(1, existing.end - existing.start)
                else:
                    results_by_chrom[seq] = RegionInfo(
                        chrom=seq,
                        gene_count=0,
                        start=1,
                        end=max(1, length),
                        length=max(1, max(1, length) - 1),
                    )
        except Exception:
            pass  # FASTA complement is best-effort

        for chrom, window in (_genome_browsable_ranges(genome) or {}).items():
            region = results_by_chrom.get(str(chrom))
            if not region or not isinstance(window, (list, tuple)) or len(window) != 2:
                continue
            try:
                lo, hi = int(window[0]), int(window[1])
            except (TypeError, ValueError):
                continue
            if lo >= hi:
                continue
            region.browsable_start = max(region.start, lo)
            region.browsable_end = min(region.end, hi)

        results = list(results_by_chrom.values())
        if not results and not db_path:
            if index_pending:
                # No FASTA to fall back on, so there is nothing to draw until the
                # index lands. Keep the caller polling rather than reporting a
                # genome with nothing in it.
                raise HTTPException(
                    status_code=genome_context.INDEX_BUILDING_STATUS,
                    detail=f"The annotation index for the {genome} genome is still being built.",
                )
            # Neither an annotation nor a readable FASTA: there is genuinely
            # nothing configured for this genome.
            raise HTTPException(
                status_code=404,
                detail=f"No annotation or FASTA is configured for the {genome} genome.",
            )

        known_regions = [str(r.chrom or "").strip() for r in results if str(r.chrom or "").strip()]
        synonym_index = genome_context._build_genome_synonym_index(genome, known_regions)
        canonical_to_synonyms = synonym_index.get("canonical_to_synonyms") or {}
        for region in results:
            region.synonyms = list(canonical_to_synonyms.get(region.chrom, []))

        # Populate display_name: for regions named by accession (e.g. NC_000001.11),
        # prefer the human-readable sequence_name (e.g. "1", "X", "MT") from the
        # assembly/sequence report for assembled molecules.
        metadata_path = genome_context._get_genome_metadata_path(genome)
        if metadata_path:
            report_rows = genome_context._load_cached_assembly_report_rows(metadata_path)
            accession_to_display: Dict[str, str] = {}
            for row in report_rows:
                if not row.is_assembled_molecule:
                    continue
                seq_name = (row.sequence_name or "").strip()
                if not seq_name or seq_name.lower() in ("na", "n/a"):
                    continue
                for accession in (row.refseq_accession, row.genbank_accession):
                    if accession and accession != seq_name:
                        accession_to_display[accession] = seq_name
            for region in results:
                preferred = accession_to_display.get(region.chrom)
                if preferred:
                    region.display_name = preferred

        return results

    return await run_in_threadpool(_query)


@router.get("/api/browse/genes")
async def browse_genes(
    genome: str = "reference",
    chrom: str = "",
    start: int = 0,
    end: int = 0,
    include_description: bool = False,
):
    """Fetch genes within a coordinate range."""
    if not chrom:
        raise HTTPException(status_code=400, detail="chrom parameter is required.")

    # Genome-only load: no annotation means no genes, which is an empty track
    # rather than an error.
    db_path = await run_in_threadpool(genome_context._get_browse_db_optional, genome)
    if not db_path:
        return []
    requested_chrom = str(chrom or "").strip()

    def _query():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        resolved_chrom = requested_chrom
        c.execute("SELECT chrom FROM genes WHERE chrom = ? LIMIT 1", (requested_chrom,))
        row = c.fetchone()
        if row and row["chrom"]:
            resolved_chrom = str(row["chrom"])
        else:
            c.execute("SELECT chrom FROM genes WHERE LOWER(chrom) = LOWER(?) LIMIT 1", (requested_chrom,))
            row = c.fetchone()
            if row and row["chrom"]:
                resolved_chrom = str(row["chrom"])
            else:
                c.execute("SELECT DISTINCT chrom FROM genes")
                known_regions = [str(r["chrom"] or "").strip() for r in c.fetchall() if str(r["chrom"] or "").strip()]
                resolved_chrom = genome_context._resolve_browse_chrom_name(genome, requested_chrom, known_regions)

        if include_description:
            try:
                if end > 0:
                    # Overlap query: gene.end >= range.start AND gene.start <= range.end
                    c.execute("""
                        SELECT id, name, description, chrom, start, end, strand, biotype
                        FROM genes
                        WHERE chrom = ? AND end >= ? AND start <= ?
                        ORDER BY start ASC
                    """, (resolved_chrom, start, end))
                else:
                    # All genes on this chrom
                    c.execute("""
                        SELECT id, name, description, chrom, start, end, strand, biotype
                        FROM genes
                        WHERE chrom = ?
                        ORDER BY start ASC
                    """, (resolved_chrom,))
            except sqlite3.OperationalError:
                if end > 0:
                    c.execute("""
                        SELECT id, name, chrom, start, end, strand, biotype
                        FROM genes
                        WHERE chrom = ? AND end >= ? AND start <= ?
                        ORDER BY start ASC
                    """, (resolved_chrom, start, end))
                else:
                    c.execute("""
                        SELECT id, name, chrom, start, end, strand, biotype
                        FROM genes
                        WHERE chrom = ?
                        ORDER BY start ASC
                    """, (resolved_chrom,))
        else:
            # Lightweight path for high-frequency browser tile fetches.
            if end > 0:
                c.execute("""
                    SELECT id, name, chrom, start, end, strand, biotype
                    FROM genes
                    WHERE chrom = ? AND end >= ? AND start <= ?
                    ORDER BY start ASC
                """, (resolved_chrom, start, end))
            else:
                c.execute("""
                    SELECT id, name, chrom, start, end, strand, biotype
                    FROM genes
                    WHERE chrom = ?
                    ORDER BY start ASC
                """, (resolved_chrom,))
        
        rows = c.fetchall()
        conn.close()
        return [BrowseGene(
            id=r['id'], name=r['name'], chrom=r['chrom'],
            start=r['start'], end=r['end'], strand=r['strand'],
            biotype=r['biotype'] or "",
            description=genome_context._normalize_gene_description(r['description']) if include_description and 'description' in r.keys() else None,
        ) for r in rows]
    
    return await run_in_threadpool(_query)


@router.get("/api/browse/default_locus", response_model=BrowseDefaultLocus)
async def browse_default_locus(genome: str = "reference"):
    """Choose an informative default locus for initial browser view.

    Strategy:
    1) choose the largest region containing genes
    2) prefer genes away from first/last 20% of region
    3) prioritize protein_coding + multi-transcript + named(symbol) genes
    """
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        c.execute("""
            SELECT chrom, COUNT(*) as gene_count, MIN(start) as start, MAX(end) as end
            FROM genes
            GROUP BY chrom
        """)
        regions = c.fetchall()
        if not regions:
            conn.close()
            raise HTTPException(status_code=404, detail=f"No genes found for {genome} genome.")

        with_features = [r for r in regions if int(r["gene_count"] or 0) > 0]
        region_rows = with_features if with_features else regions
        chosen_region = max(
            region_rows,
            key=lambda r: (int(r["end"] or 0) - int(r["start"] or 0), int(r["gene_count"] or 0))
        )

        chrom = str(chosen_region["chrom"])
        region_start = int(chosen_region["start"] or 1)
        region_end = int(chosen_region["end"] or max(region_start + 1, 2))
        region_len = max(1, region_end - region_start)
        interior_start = region_start + int(region_len * 0.2)
        interior_end = region_end - int(region_len * 0.2)
        region_mid = region_start + (region_len / 2.0)

        # Gene + transcript-count query in one pass.
        try:
            c.execute("""
                SELECT
                    g.id, g.name, g.description, g.chrom, g.start, g.end, g.strand, g.biotype,
                    COUNT(t.id) as transcript_count
                FROM genes g
                LEFT JOIN transcripts t ON t.parent_gene_id = g.id
                WHERE g.chrom = ?
                GROUP BY g.id
                ORDER BY g.start ASC
            """, (chrom,))
            gene_rows = c.fetchall()
        except sqlite3.OperationalError:
            # Backward compatibility with older indexes that may miss description and/or transcripts.
            try:
                c.execute("""
                    SELECT
                        g.id, g.name, NULL as description, g.chrom, g.start, g.end, g.strand, g.biotype,
                        COUNT(t.id) as transcript_count
                    FROM genes g
                    LEFT JOIN transcripts t ON t.parent_gene_id = g.id
                    WHERE g.chrom = ?
                    GROUP BY g.id
                    ORDER BY g.start ASC
                """, (chrom,))
                gene_rows = c.fetchall()
            except sqlite3.OperationalError:
                c.execute("""
                    SELECT id, name, NULL as description, chrom, start, end, strand, biotype, 0 as transcript_count
                    FROM genes
                    WHERE chrom = ?
                    ORDER BY start ASC
                """, (chrom,))
                gene_rows = c.fetchall()
        conn.close()

        if not gene_rows:
            # Fall back to region center if no genes were returned for this region.
            chrom_length = max(region_end, 2)
            span = min(500000, max(200000, region_len))
            center = region_start + region_len / 2.0
            start = max(1, int(round(center - span / 2.0)))
            end = start + span
            if end > chrom_length:
                end = chrom_length
                start = max(1, end - span)
            return BrowseDefaultLocus(chrom=chrom, start=start, end=end, chrom_length=chrom_length)

        def _has_symbol(row: sqlite3.Row) -> bool:
            name = (row["name"] or "").strip()
            gid = (row["id"] or "").strip()
            return bool(name) and name.lower() != gid.lower()

        def _is_interior(row: sqlite3.Row) -> bool:
            if interior_end <= interior_start:
                return True
            center = (int(row["start"]) + int(row["end"])) / 2.0
            return interior_start <= center <= interior_end

        def _score(row: sqlite3.Row) -> float:
            tx_count = int(row["transcript_count"] or 0)
            biotype = (row["biotype"] or "").strip().lower()
            center = (int(row["start"]) + int(row["end"])) / 2.0
            dist_norm = abs(center - region_mid) / max(1.0, float(region_len))

            score = 0.0
            if biotype == "protein_coding":
                score += 100.0
            if tx_count > 1:
                score += 60.0 + min(20.0, float(tx_count))
            elif tx_count == 1:
                score += 8.0
            if _has_symbol(row):
                score += 35.0
            if _is_interior(row):
                score += 40.0

            # Slight tie-break preference toward region center.
            score += max(0.0, 10.0 - dist_norm * 25.0)
            return score

        interior_rows = [r for r in gene_rows if _is_interior(r)]
        candidate_pool = interior_rows if interior_rows else gene_rows
        chosen_gene = max(
            candidate_pool,
            key=lambda r: (
                _score(r),
                int(r["transcript_count"] or 0),
                int(r["end"] or 0) - int(r["start"] or 0),
            )
        )

        gene_start = int(chosen_gene["start"])
        gene_end = int(chosen_gene["end"])
        gene_span = max(1, gene_end - gene_start)
        center = (gene_start + gene_end) / 2.0

        # Span tuned to usually make transcript pill controls visible if present.
        target_span = int(max(120_000, min(900_000, gene_span * 12)))

        chrom_length = region_end
        try:
            fasta = genome_context._get_browse_fasta(genome)
            chrom_length = int(fasta.get_reference_length(chrom))
        except Exception:
            chrom_length = max(chrom_length, region_end)
        chrom_length = max(2, int(chrom_length))

        if target_span >= (chrom_length - 1):
            start = 1
            end = chrom_length
        else:
            start = max(1, int(round(center - target_span / 2.0)))
            end = start + target_span
            if end > chrom_length:
                end = chrom_length
                start = max(1, end - target_span)
        if end <= start:
            end = min(chrom_length, start + 1)

        gene = BrowseGene(
            id=str(chosen_gene["id"]),
            name=chosen_gene["name"],
            description=genome_context._resolve_gene_description_for_db(db_path, str(chosen_gene["id"]), chosen_gene["description"]),
            chrom=str(chosen_gene["chrom"]),
            start=gene_start,
            end=gene_end,
            strand=str(chosen_gene["strand"]),
            biotype=(chosen_gene["biotype"] or "")
        )

        return BrowseDefaultLocus(
            chrom=chrom,
            start=int(start),
            end=int(end),
            chrom_length=int(chrom_length),
            gene=gene,
            transcript_count=int(chosen_gene["transcript_count"] or 0),
        )

    return await run_in_threadpool(_query)


@router.get("/api/browse/search_gene")
async def browse_search_gene(genome: str = "reference", query: str = ""):
    """Search for a gene by name or ID across all chromosomes."""
    if not query:
        raise HTTPException(status_code=400, detail="query parameter is required.")

    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)
    q = query.strip()

    def _query():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        def _run_one(sql_with_description: str, params: tuple) -> Optional[Dict[str, Any]]:
            try:
                c.execute(sql_with_description, params)
                row = c.fetchone()
                return dict(row) if row else None
            except sqlite3.OperationalError:
                c.execute(sql_with_description.replace(", description", ""), params)
                row = c.fetchone()
                if not row:
                    return None
                data = dict(row)
                data["description"] = None
                return data

        # Exact name match first (case-insensitive)
        row = _run_one(
            "SELECT id, name, description, chrom, start, end, strand, biotype FROM genes WHERE LOWER(name) = LOWER(?) LIMIT 1",
            (q,),
        )
        if not row:
            # Exact ID match
            row = _run_one(
                "SELECT id, name, description, chrom, start, end, strand, biotype FROM genes WHERE LOWER(id) = LOWER(?) LIMIT 1",
                (q,),
            )
        if not row:
            # Partial name match
            row = _run_one(
                "SELECT id, name, description, chrom, start, end, strand, biotype FROM genes WHERE LOWER(name) LIKE LOWER(?) LIMIT 1",
                (f"%{q}%",),
            )
        conn.close()
        if not row:
            return None
        return BrowseGene(
            id=row['id'], name=row['name'], chrom=row['chrom'],
            start=row['start'], end=row['end'], strand=row['strand'],
            biotype=row['biotype'] or "",
            description=genome_context._resolve_gene_description_for_db(db_path, row['id'], row.get('description')),
        )

    result = await run_in_threadpool(_query)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Gene '{query}' not found in {genome} genome.")
    return result


class ResolveResult(BaseModel):
    query: str
    resolved_type: str  # "transcript" or "gene"
    gene: Optional[BrowseGene] = None
    transcripts: list = []  # List[BrowseTranscript]
    selected_transcript_id: str = ""


@router.get("/api/resolve_id")
async def resolve_id(genome: str = "reference", query: str = ""):
    """Resolve a gene name/ID or transcript ID to a gene + its transcripts.

    Tries transcript ID first, then gene name/ID. Returns the parent gene
    and all sibling transcripts with the canonical one pre-selected.
    """
    if not query:
        raise HTTPException(status_code=400, detail="query parameter is required.")

    # Index discovery can validate or (for an outdated/missing index) rebuild a
    # local SQLite database. Do not block the asyncio event loop while that work
    # is in progress; other browse endpoints use the same threadpool pattern.
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)
    q = query.strip()

    def _query():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        gene_row = None
        selected_tx_id = None
        resolved_type = None

        def _run_one(sql: str, params: tuple) -> Optional[Dict[str, Any]]:
            for variant in [sql,
                            sql.replace(", version", ""),
                            sql.replace(", version", "").replace(", description", "")]:
                try:
                    c.execute(variant, params)
                    row = c.fetchone()
                    if row is None:
                        return None
                    data = dict(row)
                    data.setdefault("description", None)
                    data.setdefault("version", "")
                    return data
                except sqlite3.OperationalError:
                    continue
            return None

        # 1) Try as transcript ID (exact match)
        c.execute("SELECT id, chrom, start, end, strand, parent_gene_id, is_canonical, data FROM transcripts WHERE id = ?", (q,))
        tx_row = c.fetchone()
        if tx_row:
            resolved_type = "transcript"
            selected_tx_id = tx_row['id']
            parent_gene_id = tx_row['parent_gene_id']
            if parent_gene_id:
                gene_row = _run_one(
                    "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE id = ?",
                    (parent_gene_id,),
                )
        else:
            # 2) Try as gene name (case-insensitive exact)
            gene_row = _run_one(
                "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE LOWER(name) = LOWER(?) LIMIT 1",
                (q,),
            )
            if not gene_row:
                # 3) Try as gene ID (case-insensitive exact)
                gene_row = _run_one(
                    "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE LOWER(id) = LOWER(?) LIMIT 1",
                    (q,),
                )
            if not gene_row:
                # 4) Partial name match
                gene_row = _run_one(
                    "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE LOWER(name) LIKE LOWER(?) LIMIT 1",
                    (f"%{q}%",),
                )
            if gene_row:
                resolved_type = "gene"

        if not gene_row:
            conn.close()
            return None

        # Fetch all transcripts for the gene
        gene_id = gene_row['id']
        c.execute("""
            SELECT id, chrom, start, end, strand, is_canonical, data
            FROM transcripts
            WHERE parent_gene_id = ?
            ORDER BY is_canonical DESC, start ASC
        """, (gene_id,))
        tx_rows = c.fetchall()
        conn.close()

        gene = BrowseGene(
            id=gene_row['id'], name=gene_row['name'], chrom=gene_row['chrom'],
            start=gene_row['start'], end=gene_row['end'], strand=gene_row['strand'],
            biotype=gene_row['biotype'] or "",
            version=str(gene_row.get('version') or ''),
            description=genome_context._resolve_gene_description_for_db(db_path, gene_row['id'], gene_row.get('description')),
        )

        prepared = []
        missing_tag_ids = set()
        for r in tx_rows:
            tx_data = json.loads(r['data']) if r['data'] else {}
            tx_tags = tx_data.get('tags', [])
            if isinstance(tx_tags, str):
                tx_tags = [t.strip() for t in tx_tags.split(',') if t.strip()]
            elif not isinstance(tx_tags, list):
                tx_tags = []
            # The indexer writes `tags` for every transcript, empty when it has none,
            # so only an index that predates it needs the GFF. Treating an empty list
            # as missing re-scanned the whole annotation on every gene search.
            if 'tags' not in tx_data:
                missing_tag_ids.add(str(r['id']))
            prepared.append((r, tx_data, tx_tags))

        fallback_tags = genome_context._resolve_transcript_tags_for_db(db_path, missing_tag_ids) if missing_tag_ids else {}

        transcripts = []
        for r, tx_data, tx_tags in prepared:
            effective_tags = tx_tags if tx_tags else fallback_tags.get(str(r['id']), [])
            transcripts.append(BrowseTranscript(
                id=r['id'], chrom=r['chrom'], start=r['start'], end=r['end'],
                strand=r['strand'], biotype=tx_data.get('biotype', ''),
                version=str(tx_data.get('version') or ''),
                is_canonical=bool(r['is_canonical']),
                tags=effective_tags,
                exons=tx_data.get('exons', []),
                cds_list=tx_data.get('cds_list', []),
                utrs=tx_data.get('utrs', [])
            ))

        # Auto-select: if transcript lookup, use that ID; if gene lookup, use canonical
        if not selected_tx_id and transcripts:
            canonical = [t for t in transcripts if t.is_canonical]
            selected_tx_id = canonical[0].id if canonical else transcripts[0].id

        return ResolveResult(
            query=q,
            resolved_type=resolved_type,
            gene=gene,
            transcripts=transcripts,
            selected_transcript_id=selected_tx_id or ""
        )

    result = await run_in_threadpool(_query)
    if result is None:
        raise HTTPException(status_code=404, detail=f"'{query}' not found in {genome} genome.")
    return result


@router.get("/api/browse/transcripts")
async def browse_transcripts(
    genome: str = "reference",
    gene_id: str = "",
    include_tags_fallback: bool = False,
):
    """Fetch all transcripts for a gene, with canonical flag."""
    if not gene_id:
        raise HTTPException(status_code=400, detail="gene_id parameter is required.")
    
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)
    
    def _query():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("""
            SELECT id, chrom, start, end, strand, is_canonical, data
            FROM transcripts
            WHERE parent_gene_id = ?
            ORDER BY is_canonical DESC, start ASC
        """, (gene_id,))
        rows = c.fetchall()
        conn.close()
        
        prepared = []
        missing_tag_ids = set()
        for r in rows:
            tx_data = json.loads(r['data']) if r['data'] else {}
            tx_tags = tx_data.get('tags', [])
            if isinstance(tx_tags, str):
                tx_tags = [t.strip() for t in tx_tags.split(',') if t.strip()]
            elif not isinstance(tx_tags, list):
                tx_tags = []
            # The indexer writes `tags` for every transcript, empty when it has none,
            # so only an index that predates it needs the GFF. Treating an empty list
            # as missing re-scanned the whole annotation on every gene search.
            if 'tags' not in tx_data:
                missing_tag_ids.add(str(r['id']))
            prepared.append((r, tx_data, tx_tags))

        fallback_tags = (
            genome_context._resolve_transcript_tags_for_db(db_path, missing_tag_ids)
            if include_tags_fallback and missing_tag_ids
            else {}
        )

        results = []
        for r, tx_data, tx_tags in prepared:
            effective_tags = tx_tags if tx_tags else fallback_tags.get(str(r['id']), [])
            results.append(BrowseTranscript(
                id=r['id'],
                chrom=r['chrom'],
                start=r['start'],
                end=r['end'],
                strand=r['strand'],
                biotype=tx_data.get('biotype', ''),
                is_canonical=bool(r['is_canonical']),
                tags=effective_tags,
                exons=tx_data.get('exons', []),
                cds_list=tx_data.get('cds_list', []),
                utrs=tx_data.get('utrs', [])
            ))
        return results
    
    return await run_in_threadpool(_query)


@router.get("/api/browse/canonical_transcripts")
async def browse_canonical_transcripts(
    genome: str = "reference",
    chrom: str = "",
    start: int = 0,
    end: int = 0,
    limit: int = 10000,
):
    """Fetch one canonical transcript per visible gene for a genomic window."""
    if not chrom or end <= start:
        raise HTTPException(status_code=400, detail="Valid chrom, start, and end required.")

    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        requested_chrom = str(chrom or "").strip()
        resolved_chrom = genome_context._resolve_db_chrom_name_for_genome(db_path, requested_chrom, genome) or requested_chrom
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        try:
            c.execute(
                """
                SELECT
                    g.id,
                    g.name,
                    g.description,
                    g.version,
                    g.chrom,
                    g.start,
                    g.end,
                    g.strand,
                    g.biotype,
                    t.id AS tx_id,
                    t.chrom AS tx_chrom,
                    t.start AS tx_start,
                    t.end AS tx_end,
                    t.strand AS tx_strand,
                    t.is_canonical AS tx_is_canonical,
                    t.data AS tx_data
                FROM genes g
                LEFT JOIN transcripts t
                    ON t.id = (
                        SELECT id
                        FROM transcripts
                        WHERE parent_gene_id = g.id
                        ORDER BY is_canonical DESC, start ASC
                        LIMIT 1
                    )
                WHERE g.chrom = ? AND g.end >= ? AND g.start <= ?
                ORDER BY g.start ASC
                LIMIT ?
                """,
                (resolved_chrom, int(start), int(end), int(max(100, min(20000, limit)))),
            )
            rows = c.fetchall()
        finally:
            conn.close()

        results: List[BrowseCanonicalTranscriptEntry] = []
        for row in rows:
            gene = BrowseGene(
                id=row["id"],
                name=row["name"],
                chrom=row["chrom"],
                start=int(row["start"]),
                end=int(row["end"]),
                strand=row["strand"],
                biotype=row["biotype"] or "",
                version=str(row["version"] or ""),
                description=row["description"],
            )

            tx_data = json.loads(row["tx_data"]) if row["tx_data"] else {}
            transcript = BrowseTranscript(
                id=row["tx_id"] or f"{row['id']}_canonical",
                chrom=row["tx_chrom"] or row["chrom"],
                start=int(row["tx_start"] if row["tx_start"] is not None else row["start"]),
                end=int(row["tx_end"] if row["tx_end"] is not None else row["end"]),
                strand=row["tx_strand"] or row["strand"],
                biotype=tx_data.get("biotype", row["biotype"] or ""),
                version=str(tx_data.get("version") or ""),
                is_canonical=bool(row["tx_is_canonical"]),
                tags=tx_data.get("tags", []) if isinstance(tx_data.get("tags", []), list) else [],
                exons=tx_data.get("exons", []) if isinstance(tx_data.get("exons", []), list) else [],
                cds_list=tx_data.get("cds_list", []) if isinstance(tx_data.get("cds_list", []), list) else [],
                utrs=tx_data.get("utrs", []) if isinstance(tx_data.get("utrs", []), list) else [],
            )
            results.append(BrowseCanonicalTranscriptEntry(gene=gene, transcript=transcript))

        return results

    return await run_in_threadpool(_query)


@router.get("/api/browse/sequence")
async def browse_sequence(genome: str = "reference", chrom: str = "", start: int = 0, end: int = 0):
    """Fetch raw sequence for a coordinate range (max 100kb)."""
    if not chrom or end <= start:
        raise HTTPException(status_code=400, detail="Valid chrom, start, and end required.")

    max_len = 100000
    if (end - start) > max_len:
        raise HTTPException(status_code=400, detail=f"Requested range too large. Max {max_len}bp.")

    def _query():
        fasta = genome_context._get_browse_fasta(genome)
        requested_chrom = str(chrom or "").strip()
        try:
            seq = fasta.fetch(requested_chrom, start, end)
            seq_upper = str(seq).upper()
            return {"sequence": seq_upper, "chrom": requested_chrom, "start": start, "end": end, "length": len(seq_upper)}
        except (ValueError, KeyError) as first_err:
            known_regions = [str(r or "").strip() for r in list(fasta.references or []) if str(r or "").strip()]
            fallback = genome_context._resolve_browse_chrom_name(genome, requested_chrom, known_regions)
            if fallback and fallback != requested_chrom:
                try:
                    seq = fasta.fetch(fallback, start, end)
                    seq_upper = str(seq).upper()
                    return {"sequence": seq_upper, "chrom": fallback, "start": start, "end": end, "length": len(seq_upper)}
                except (ValueError, KeyError) as second_err:
                    raise HTTPException(status_code=404, detail=f"Region not found: {chrom}:{start}-{end}. Error: {second_err}")
            raise HTTPException(status_code=404, detail=f"Region not found: {chrom}:{start}-{end}. Error: {first_err}")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=404, detail=f"Region not found: {chrom}:{start}-{end}. Error: {e}")

    return await run_in_threadpool(_query)
