"""
Ensembl Go Backend - FastAPI server for local genome and alignment views.
Uses lightweight targeted GFF3 lookup instead of full parsing.
"""

import hmac
import json
import logging
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool

# A note on ``def`` versus ``async def`` for route handlers, because it is load-bearing
# here. This process serves everything from a single event loop, so an ``async def``
# handler that does blocking work — reading the configuration, walking the output
# directory, waiting on a remote registry — stops the process answering *any* request
# for as long as it runs. The symptom is never local to the slow endpoint: the whole UI
# goes dead, and the user sees whichever button they happened to press do nothing.
# So a handler that only does blocking work is declared ``def``, which FastAPI runs on
# its worker threadpool; a handler that genuinely needs the loop (to spawn a background
# task, say) stays ``async def`` and hands its blocking part to ``run_in_threadpool``.
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from Bio.Seq import Seq

# Configure logging before importing this application's own modules, so that what
# they log while being imported (the download manager loading its catalogue, say)
# is not lost.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

from assembly_report import chrom_token_variants
from security_utils import require_loopback_client, validate_backend_bind_host
import routes.structure
import transcript_translation
import routes.splice
import sequence_windows
import routes.long_reads
import routes.bed
import routes.bigwig
import routes.vcf
import routes.sv
import routes.alignment
import mafft
import routes.stats
import routes.genome_removal
import routes.downloads
import routes.remote_catalog
import routes.custom_genomes
import routes.config
import routes.neighbourhood
import routes.homology
import routes.tutorial
import routes.tracks
import routes.notes
import routes.achievements
import genome_context
import local_inventory
import gff_index
import config_store
import app_state
import file_io
import data_paths
import app_paths
import routes.sequence_export
import routes.feature_explorer


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Start the catalogue download as soon as the server is up, so it is already under
    # way — usually finished — before the user opens the download view. Non-blocking:
    # the fetch runs on a background thread and startup continues immediately.
    try:
        app_state.download_manager.ensure_catalog_available()
    except Exception:
        logger.exception("Failed to start the initial species catalogue fetch")
    yield


app = FastAPI(title="Ensembl Go API", lifespan=_lifespan)

from alignment_explorer import create_router as create_alignment_explorer_router
app.include_router(create_alignment_explorer_router(
    annotation_provider=lambda *args, **kwargs: alignment_explorer_annotation_features(*args, **kwargs),
    gene_provider=lambda *args, **kwargs: alignment_explorer_block_genes(*args, **kwargs),
    availability_provider=lambda *args, **kwargs: alignment_explorer_genome_availability(*args, **kwargs)))

# Gene trees: the library lives beside the user's genomes, the protein maps it
# builds from their GFFs are derived data and live in the cache.
from gene_trees import create_router as create_gene_trees_router
app.include_router(create_gene_trees_router(
    library_path_provider=lambda: gene_trees_library_path(),
    genomes_provider=lambda: gene_trees_local_genomes(),
    cache_dir=app_paths.CACHE_DIR / "gene_trees",
    neighbourhood_lookup=lambda db_path, gene_id, window: gene_trees_neighbourhood(db_path, gene_id, window),
    alignment_hooks={
        "store_root": lambda: gene_trees_alignments_root(),
        "transcript_lookup": lambda *args: gene_trees_transcript(*args),
        "fetcher_for": lambda genome: gene_trees_fetcher(genome),
        "align_fn": lambda *args: gene_trees_align(*args),
    }))

# The sequence view, wired the same way: a package that never imports this module
# and is handed the functions it needs. Every provider is defined further down
# this file, so each is passed as a lambda that looks it up when called rather
# than as the name, which does not exist yet at this line.
from sequence_view import create_router as create_sequence_view_router
app.include_router(create_sequence_view_router(
    db_provider=lambda *args, **kwargs: genome_context._get_browse_db(*args, **kwargs),
    db_optional_provider=lambda *args, **kwargs: genome_context._get_browse_db_optional(*args, **kwargs),
    fasta_provider=lambda *args, **kwargs: genome_context._get_browse_fasta(*args, **kwargs),
    chrom_resolver=lambda *args, **kwargs: genome_context._resolve_browse_chrom_name(*args, **kwargs),
    tx_feature_intervals=lambda *args, **kwargs: sequence_windows._build_tx_feature_intervals(*args, **kwargs),
    mode_segments=lambda *args, **kwargs: sequence_windows._build_mode_segments(*args, **kwargs),
    # The one translation in this application. It is the Feature Explorer's, and
    # it is the only one that knows about organelle genetic codes, non-ATG
    # initiation and how Ensembl's own pep file renders an incomplete CDS -- so
    # the sequence view asks it rather than carrying a second, simpler answer
    # that would disagree with the protein rows a reader can already see.
    translate_transcript=lambda *args, **kwargs: transcript_translation._sequence_view_protein(*args, **kwargs),
    normalize_intervals=lambda *args, **kwargs: sequence_windows._normalize_interval_list(*args, **kwargs),
    ordered_five_to_three=lambda *args, **kwargs: sequence_windows._ordered_five_to_three(*args, **kwargs)))

# Endpoints that live in backend/routes/, one router per domain. Their position in
# the route table does not matter: no two routes in the app can match one request
# (tests/test_route_contract.py checks that).
app.include_router(routes.achievements.router)
app.include_router(routes.notes.router)
app.include_router(routes.tracks.router)
app.include_router(routes.tutorial.router)
app.include_router(routes.homology.router)
app.include_router(routes.neighbourhood.router)
app.include_router(routes.config.router)
app.include_router(routes.custom_genomes.router)
app.include_router(routes.remote_catalog.router)
app.include_router(routes.downloads.router)
app.include_router(routes.genome_removal.router)
app.include_router(routes.stats.router)
app.include_router(routes.alignment.router)
app.include_router(routes.sv.router)
app.include_router(routes.vcf.router)
app.include_router(routes.bigwig.router)
app.include_router(routes.bed.router)
app.include_router(routes.long_reads.router)
app.include_router(routes.splice.router)
app.include_router(routes.structure.router)
app.include_router(routes.sequence_export.router)
app.include_router(routes.feature_explorer.router)


# Allow only local renderer origins (Electron file origin is "null")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "http://localhost", "http://127.0.0.1"],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_allowed_origin(origin: Optional[str]) -> bool:
    """Accept requests only from local web origins or Electron's null origin."""
    if not origin:
        return True
    origin = origin.strip()
    if origin == "null":
        return True
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}


def _is_allowed_referer(referer: Optional[str]) -> bool:
    if not referer:
        return True
    try:
        parsed = urlparse(referer)
    except Exception:
        return False
    if not parsed.scheme or not parsed.netloc:
        return False
    return _is_allowed_origin(f"{parsed.scheme}://{parsed.netloc}")


@app.middleware("http")
async def enforce_local_origin(request: Request, call_next):
    """Block browser requests coming from non-local origins."""
    path = request.url.path or ""
    client_host = getattr(request.client, "host", "") if request.client else ""
    require_loopback_client(client_host)
    guarded = path.startswith("/api") and path != "/api/health"
    framed = path.startswith(app_state.STRUCTURE_VIEWER_PREFIX)
    if guarded or framed:
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        if not _is_allowed_origin(origin) or not _is_allowed_referer(referer):
            return JSONResponse(status_code=403, content={"detail": "Forbidden origin"})
        if app_state.API_TOKEN and request.method.upper() != "OPTIONS":
            # The structure viewer is loaded as an iframe and then fetches its own
            # assets and model file. Neither a frame navigation nor a fetch the
            # third-party viewer issues on its own behalf can carry a header, so
            # this one prefix accepts the token from the query string instead.
            provided = (
                request.query_params.get("token", "")
                if framed else
                request.headers.get(app_state.API_TOKEN_HEADER, "")
            )
            if not hmac.compare_digest(provided, app_state.API_TOKEN):
                return JSONResponse(status_code=401, content={"detail": "Missing or invalid local API token"})
    return await call_next(request)


# ============ API Endpoints ============

@app.get("/api/health")
async def health():
    return {"status": "ok"}


app.get("/api/remote/local-assemblies")(local_inventory.list_local_assemblies)


# ============ Genome Browser API ============


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


@app.get("/api/browse/index-status")
async def browse_index_status(genome: str = "reference"):
    """Progress of the gene index behind a genome's browser panel."""
    return await run_in_threadpool(_index_status_for_genome, genome)


class IndexRetryRequest(BaseModel):
    genome: str


@app.post("/api/browse/index-retry")
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


@app.get("/api/browse/regions")
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


@app.get("/api/browse/genes")
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


@app.get("/api/browse/default_locus", response_model=BrowseDefaultLocus)
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


@app.get("/api/browse/search_gene")
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


@app.get("/api/resolve_id")
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


@app.get("/api/browse/transcripts")
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


@app.get("/api/browse/canonical_transcripts")
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


def _alignment_explorer_transcript_features(exons, cds_list, utrs, strand):
    """One transcript's parts as zero-based half-open genomic intervals.

    Geometry only: exons, introns between them, CDS and UTR. Splice sites and
    codons are read off the sequence and belong with the measurements, not with
    the shape of the model, so they are not invented here.

    ``strand`` is the transcript's own, which decides what is 5' and what is 3'
    and has nothing to do with the strand the alignment row is on.
    """
    def interval(kind, start, end):
        # GFF3 is one-based inclusive; everything past this function is not.
        return {'type': kind, 'start': int(start) - 1, 'end': int(end)}
    def bounds(item):
        return int(item.get('start', 0) or 0), int(item.get('end', 0) or 0)
    features = []
    ordered = sorted((bounds(item) for item in exons), key=lambda pair: pair[0])
    for exon_start, exon_end in ordered:
        features.append(interval('exon', exon_start, exon_end))
    for (_, first_end), (second_start, _) in zip(ordered, ordered[1:]):
        if second_start - 1 >= first_end + 1:
            features.append(interval('intron', first_end + 1, second_start - 1))
    for cds_start, cds_end in (bounds(item) for item in cds_list):
        features.append(interval('cds', cds_start, cds_end))
    coding = sorted((bounds(item) for item in cds_list), key=lambda pair: pair[0])
    for utr in utrs:
        utr_start, utr_end = bounds(utr)
        tagged = str(utr.get('feature_type') or '')
        kind = 'utr5' if tagged == 'five_prime_UTR' else 'utr3' if tagged == 'three_prime_UTR' else None
        if kind is None and coding:
            # An untagged UTR is named from which side of the CDS it lies on,
            # which is the same fallback the sequence viewer uses.
            before = utr_end < coding[0][0]
            kind = ('utr5' if before else 'utr3') if strand == '+' else ('utr3' if before else 'utr5')
        features.append(interval(kind or 'utr5', utr_start, utr_end))
    return features


def alignment_explorer_block_genes(genome, chrom, start, end, expand=(), gene_limit=200, transcript_limit=8, page=0):
    """Gene models overlapping a genomic interval, for the block context view.

    One representative transcript per gene — canonical where the index says so,
    otherwise the first by position, labelled as a fallback rather than passed
    off as canonical. A gene named in ``expand`` returns a page of its other
    isoforms as well, so opening one gene never means loading every isoform of
    every gene in the window.

    ``start``/``end`` are one-based inclusive, matching the GFF3 index this
    reads. Everything returned is zero-based half-open.
    """
    db_path = genome_context._get_browse_db(genome)
    resolved = genome_context._resolve_db_chrom_name_for_genome(db_path, chrom, genome) or chrom
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        gene_rows = conn.execute(
            'SELECT id,name,start,end,strand,biotype,description FROM genes WHERE chrom=? AND end>=? AND start<=? ORDER BY start LIMIT ?',
            (resolved, int(start), int(end), int(gene_limit) + 1)).fetchall()
        complete = len(gene_rows) <= int(gene_limit)
        gene_rows = gene_rows[:int(gene_limit)]
        if not gene_rows:
            return {'genes': [], 'complete': complete}
        ids = [row['id'] for row in gene_rows]
        # One query for every transcript of every gene in the window. The
        # per-transcript lookup this replaces opened a database connection each
        # time, which at a few thousand isoforms is the whole cost of the call.
        placeholders = ','.join('?' * len(ids))
        transcript_rows = conn.execute(
            'SELECT id,parent_gene_id,chrom,start,end,strand,is_canonical,data FROM transcripts WHERE parent_gene_id IN (%s) ORDER BY is_canonical DESC,start ASC' % placeholders,
            ids).fetchall()
    finally:
        conn.close()
    by_gene = {}
    for row in transcript_rows:
        by_gene.setdefault(row['parent_gene_id'], []).append(row)
    wanted = set(expand or ())
    genes = []
    for gene in gene_rows:
        available = by_gene.get(gene['id'], [])
        if not available:
            continue
        if gene['id'] in wanted:
            window = available[int(page) * int(transcript_limit):(int(page) + 1) * int(transcript_limit)]
            if (int(page) + 1) * int(transcript_limit) < len(available): complete = False
        else:
            window = available[:1]
        transcripts = []
        for row in window:
            data = json.loads(row['data']) if row['data'] else {}
            lists = {key: [item for item in data.get(key, []) if isinstance(item, dict)] for key in ('exons', 'cds_list', 'utrs')}
            tx_strand = row['strand'] or gene['strand'] or '+'
            transcripts.append({
                'transcript_id': row['id'],
                'is_canonical': bool(row['is_canonical']),
                # Where the index names no canonical transcript, the first by
                # position stands in. Saying so is the point: a fallback drawn as
                # canonical is a claim the annotation never made.
                'representative': not bool(row['is_canonical']),
                'biotype': data.get('biotype') or gene['biotype'] or '',
                'tags': data.get('tags', []) if isinstance(data.get('tags', []), list) else [],
                'strand': tx_strand,
                'genomic': {'start': int(row['start']) - 1, 'end': int(row['end'])},
                'features': _alignment_explorer_transcript_features(lists['exons'], lists['cds_list'], lists['utrs'], tx_strand),
            })
        genes.append({
            'gene_id': gene['id'], 'gene_name': gene['name'] or gene['id'],
            'biotype': gene['biotype'] or '', 'strand': gene['strand'] or '+',
            'description': gene['description'] or '',
            'genomic': {'start': int(gene['start']) - 1, 'end': int(gene['end'])},
            'transcript_count': len(available),
            'transcripts': transcripts,
        })
    return {'genes': genes, 'complete': complete}


def alignment_explorer_genome_availability(assembly, region):
    """Whether a linked assembly can answer for a region, and how far.

    Four separate answers, never one boolean. A genome that is not installed,
    one installed without annotation, and one whose annotation simply has no
    genes in a region are three different facts, and a track that showed them
    identically would read as biological absence.
    """
    try:
        genome_context._resolve_browse_genome_context(assembly)
    except Exception:
        return 'unavailable'
    try:
        db_path = genome_context._get_browse_db_optional(assembly)
    except Exception:
        db_path = None
    if not db_path:
        return 'no-annotation'
    try:
        if genome_context._resolve_db_chrom_name_for_genome(db_path, region, assembly) is None:
            return 'no-region'
    except Exception:
        return 'no-region'
    return 'ready'


def gene_trees_library_path() -> Path:
    """``<output_dir>/local_data/gene_trees_index.sqlite``: a file, since every folder there is read as a species.

    (``gene_trees.sqlite`` beside it is the first version's format; the view offers to
    re-index it from its sources and remove it.)

    ``ENSEMBL_GENE_TREES_LIBRARY`` points it elsewhere, so a test backend can load
    trees without touching the user's library.
    """
    override = os.environ.get("ENSEMBL_GENE_TREES_LIBRARY", "").strip()
    if override:
        return Path(override).expanduser()
    output_dir = str(config_store.load_config().get("output_dir") or "").strip()
    if output_dir:
        try:
            return data_paths._resolve_local_data_root(output_dir) / "gene_trees_index.sqlite"
        except Exception:
            logger.warning("Gene trees: output_dir %s is unusable; using the cache", output_dir)
    return app_paths.CACHE_DIR / "gene_trees" / "gene_trees_index.sqlite"


_GENE_TREE_GENOMES: Dict[str, Any] = {"key": None, "at": 0.0, "genomes": []}
_GENE_TREE_GENOMES_TTL = 30.0


def gene_trees_neighbourhood(db_path: str, gene_id: str, window: int):
    """The Neighbourhood view's own index query, as plain dicts for the gene-trees package."""
    genes, center = routes.neighbourhood.get_gene_neighbourhood_index_by_gene(db_path, gene_id, window)
    return [g.model_dump() if hasattr(g, "model_dump") else dict(g) for g in genes], center


def gene_trees_local_genomes() -> List[Dict[str, Any]]:
    """Every genome a tree leaf could link to: the registered ones and those on disk.

    One entry per assembly, preferring a record whose annotation index exists. The
    disk scan is not cheap, so the answer is kept for a few seconds per configuration.
    """
    cfg = config_store.load_config()
    output_dir = str(cfg.get("output_dir") or "").strip()
    registered = genome_context._browsable_active_species(cfg)
    key = (output_dir, tuple(genome_context._active_species_item_key(s) for s in registered))
    now = time.time()
    if _GENE_TREE_GENOMES["key"] == key and now - _GENE_TREE_GENOMES["at"] < _GENE_TREE_GENOMES_TTL:
        return _GENE_TREE_GENOMES["genomes"]
    records = list(registered)
    if output_dir:
        try:
            records += list(local_inventory.list_local_assemblies(output_dir) or [])
        except Exception:
            logger.exception("Gene trees: could not scan local assemblies")
    best: Dict[str, Dict[str, Any]] = {}
    for record in records:
        assembly = str(record.get("assembly") or record.get("gca") or "").strip()
        if not assembly:
            continue
        files = record.get("files") or {}
        index = str(files.get("index") or "").strip()
        has_index = bool(index and os.path.exists(index))
        if assembly in best and (best[assembly]["index_path"] or not has_index):
            if not best[assembly].get("fasta_path") and str(files.get("fasta") or "").strip():
                best[assembly]["fasta_path"] = str(files.get("fasta") or "").strip()
            continue
        best[assembly] = {
            "assembly": assembly,
            "species_key": record.get("species_key"),
            "scientific_name": record.get("scientific_name"),
            "common_name": record.get("common_name"),
            "display_name": record.get("display_name") or record.get("common_name") or record.get("scientific_name"),
            "provider": record.get("provider"),
            "index_path": index if has_index else "",
            "gff_path": str(files.get("gff3") or "").strip(),
            "fasta_path": str(files.get("fasta") or "").strip(),
        }
    genomes = list(best.values())
    _GENE_TREE_GENOMES.update(key=key, at=now, genomes=genomes)
    return genomes


def gene_trees_transcript(index_path: str, gene_id: str, transcript_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """A gene's transcript to align: ``transcript_id`` when it is one of the gene's, else its canonical one."""
    if not index_path or not os.path.exists(index_path):
        return None
    conn = sqlite3.connect(index_path)
    try:
        genes = list(dict.fromkeys(g for g in (gene_id, re.sub(r"\.\d+$", "", gene_id or "")) if g))
        marks = ",".join("?" * len(genes))
        chosen = None
        if transcript_id:
            wanted = list(dict.fromkeys(t for t in (transcript_id, re.sub(r"\.\d+$", "", transcript_id)) if t))
            row = conn.execute(f"SELECT id FROM transcripts WHERE id IN ({','.join('?' * len(wanted))}) "
                               f"AND parent_gene_id IN ({marks}) LIMIT 1", (*wanted, *genes)).fetchone()
            chosen = row[0] if row else None
        if not chosen:
            row = conn.execute(f"SELECT id FROM transcripts WHERE parent_gene_id IN ({marks}) "
                               "ORDER BY is_canonical DESC, start ASC LIMIT 1", genes).fetchone()
            chosen = row[0] if row else None
        name_row = conn.execute(f"SELECT name, start, end FROM genes WHERE id IN ({marks}) LIMIT 1", genes).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    tx = gff_index.find_transcript_in_index(index_path, chosen) if chosen else None
    if tx is None:
        return None
    return {**asdict(tx), "id": chosen, "gene_id": gene_id, "gene_name": (name_row[0] if name_row else "") or "",
            "gene_start": int(name_row[1]) if name_row and name_row[1] else None,
            "gene_end": int(name_row[2]) if name_row and name_row[2] else None}


def gene_trees_fetcher(genome: Dict[str, Any]):
    """``fetch(chrom, start, end) -> (forward sequence, start, end)`` from a local genome's FASTA."""
    fasta_path = str(genome.get("fasta_path") or "")
    if not fasta_path or not os.path.exists(fasta_path):
        raise LookupError("Its genome has no sequence (FASTA) downloaded")
    cache_key = f"path:{fasta_path}"
    cached = genome_context._fasta_cache.get(cache_key)
    fasta = cached[1] if cached and cached[0] == fasta_path else None
    if fasta is None:
        fasta = file_io.open_indexed_fasta(fasta_path)
        genome_context._fasta_cache[cache_key] = (fasta_path, fasta)
    known = set(fasta.references or [])

    def fetch(chrom: str, start: int, end: int):
        name = chrom if chrom in known else next((v for v in chrom_token_variants(chrom) if v in known), None)
        if name is None:
            try:
                name = genome_context._resolve_browse_chrom_name(str(genome.get("assembly") or ""), chrom, list(known)) or None
            except Exception:
                name = None
        if name is None or name not in known:
            raise LookupError(f"{chrom} is not in its genome's FASTA")
        length = int(fasta.get_reference_length(name))
        lo, hi = max(1, int(start)), min(length, int(end))
        if lo > hi:
            return "", lo, lo - 1
        return fasta.fetch(name, lo - 1, hi), lo, hi
    return fetch


def gene_trees_align(ordered: List[Tuple[str, str]], on_progress, cancelled):
    """MAFFT for a tree's transcripts: ``--auto`` for a handful, FFT-NS-2 beyond."""
    lengths = [len(seq) for _, seq in ordered]
    if len(ordered) <= 30 and sum(lengths) <= 300_000 and max(lengths) <= 20_000:
        args, strategy = ["--auto"], "auto"
    else:
        args, strategy = ["--retree", "2", "--maxiterate", "0"], "FFT-NS-2"
    aligned = mafft.run_mafft_alignment_multi_progress(ordered, args, timeout_sec=4 * 3600,
                                                 on_progress=on_progress, cancelled=cancelled)
    return aligned, strategy


def gene_trees_alignments_root() -> Optional[Path]:
    """The alignments folder the MSA view saves to: where the tree's alignments go too."""
    output_dir = str(config_store.load_config().get("output_dir") or "").strip()
    if not output_dir or not os.path.isdir(output_dir):
        return None
    return routes.alignment._alignments_dir(output_dir)


def alignment_explorer_annotation_features(genome, chrom, start, end, sequence, strand, transcript_id=None):
    """Project indexed GFF3 transcript features using the existing MSA annotation mapper."""
    db_path = genome_context._get_browse_db(genome)
    resolved = genome_context._resolve_db_chrom_name_for_genome(db_path, chrom, genome) or chrom
    conn = sqlite3.connect(db_path)
    try:
        if transcript_id:
            records = conn.execute('SELECT id FROM transcripts WHERE id=? AND chrom=? AND end>=? AND start<=?', (transcript_id,resolved,start,end)).fetchall()
        else:
            records = conn.execute("""SELECT t.id FROM genes g JOIN transcripts t ON t.id=(
                SELECT id FROM transcripts WHERE parent_gene_id=g.id ORDER BY is_canonical DESC,start ASC LIMIT 1)
                WHERE g.chrom=? AND g.end>=? AND g.start<=? ORDER BY g.start LIMIT 2000""", (resolved,start,end)).fetchall()
    finally:
        conn.close()
    features = []
    for (tx_id,) in records:
        tx = gff_index.find_transcript_in_index(db_path, tx_id)
        if not tx: continue
        reverse = tx.strand != strand
        aligned = str(Seq(sequence).reverse_complement()) if reverse else sequence
        mapped = routes.alignment.map_features_to_alignment(tx,start,end,aligned,tx.strand,aligned.replace('-', ''))
        for feature in mapped:
            item = feature.model_dump() if hasattr(feature,'model_dump') else feature.dict()
            if reverse:
                item['start'],item['end'] = len(sequence)-1-item['end'],len(sequence)-1-item['start']
            item['transcript_id'] = tx_id
            features.append(item)
    return features


@app.get("/api/browse/sequence")
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


routes.vcf._VCF_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


routes.vcf._VCF_BLOCK_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":

    import uvicorn
    import argparse

    parser = argparse.ArgumentParser(description="Ensembl Go Backend Server")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()
    args.host = validate_backend_bind_host(args.host)

    file_io.log_progress(f"Starting Ensembl Go Backend on {args.host}:{args.port}...")

    # Run uvicorn programmatically
    uvicorn.run(app, host=args.host, port=args.port)
