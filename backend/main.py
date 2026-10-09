"""
Ensembl Go Backend - FastAPI server for local genome and alignment views.
Uses lightweight targeted GFF3 lookup instead of full parsing.
"""

import base64
import gzip
import hmac
import hashlib
import json
import logging
import math
import os
import re
import csv
import shutil
import subprocess
import tempfile
import sqlite3
import time
import threading
import uuid
from collections import Counter, OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from urllib.parse import urlparse, quote, unquote, urlencode
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, Set
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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

import pysam
from Bio.Seq import Seq
import asyncio

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

# Configure logging before importing this application's own modules, so that what
# they log while being imported (the download manager loading its catalogue, say)
# is not lost.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

from bed_index import get_plain_bed_index, is_gff_path, is_plain_bed_path, open_plain_bed
from assembly_report import chrom_token_variants
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    genome_manifest_filename,
    iter_local_assembly_dirs,
    legacy_genome_key,
    normalize_provider,
    selection_key_from_record,
    strip_dataset_release_from_selection_key,
)
from stats_utils import (
    STATS_SCHEMA_VERSION,
    STRUCTURAL_PROFILE,
    build_annotation_aggregate,
    build_homology_aggregate,
    build_structural_aggregate,
    choose_stats_cache_path,
    clean_species_record,
    compute_annotation_stats,
    compute_fasta_assembly_stats,
    compute_homology_stats,
    compute_source_fingerprints,
    compute_structural_stats,
    ensure_stats_cache_base,
    fetch_ena_metadata,
    fingerprints_equal,
    load_stats_cache,
    now_iso,
    update_stats_cache,
)
import protein_structure
import removal_rules
from translation import (
    MOLECULE_NUCLEAR,
    TABLE_STANDARD,
    TranslationLayout,
    autodetect_organelle_table,
    build_translation_layout,
    classify_contig_molecule,
    internal_stop_count,
    translate_cds_dna,
    translation_table_for_lineage,
)
from sv_config import (
    CONFIG_VERSION_KEY as SV_CONFIG_VERSION_KEY,
    config_to_datasets as sv_config_to_datasets,
    config_to_document as sv_config_to_document,
    derive_sequence_map as sv_derive_sequence_map,
    has_errors as sv_config_has_errors,
    is_sv_key_value_text,
    locate_pointer_lines as sv_locate_pointer_lines,
    merge_sv_config,
    parse_sv_config,
    remove_alignment as sv_remove_alignment,
    serialize_sv_config,
    serialize_sv_key_value_config,
)
from security_utils import (
    get_with_validated_redirects,
    validate_annotation_service_url,
    require_loopback_client,
    require_path_within,
    safe_export_filename,
    sanitize_leaf_filename,
    validate_backend_bind_host,
    validate_config_export_path,
)
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
import transcript_msa
from transcript_msa.regions import params_of as _tmsa_params_of, structure_hash as _tmsa_structure_hash, window_region as _tmsa_window_region
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
    tx_feature_intervals=lambda *args, **kwargs: _build_tx_feature_intervals(*args, **kwargs),
    mode_segments=lambda *args, **kwargs: _build_mode_segments(*args, **kwargs),
    # The one translation in this application. It is the Feature Explorer's, and
    # it is the only one that knows about organelle genetic codes, non-ATG
    # initiation and how Ensembl's own pep file renders an incomplete CDS -- so
    # the sequence view asks it rather than carrying a second, simpler answer
    # that would disagree with the protein rows a reader can already see.
    translate_transcript=lambda *args, **kwargs: _sequence_view_protein(*args, **kwargs),
    normalize_intervals=lambda *args, **kwargs: _normalize_interval_list(*args, **kwargs),
    ordered_five_to_three=lambda *args, **kwargs: _ordered_five_to_three(*args, **kwargs)))

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
API_TOKEN = os.environ.get("ENSEMBL_LOCAL_API_TOKEN", "").strip()
API_TOKEN_HEADER = "x-ensembl-local-token"
# Routes serving the sandboxed 3D structure viewer. Kept off /api because these
# are framed navigations and third-party subresource fetches rather than calls
# the app's own fetch wrapper makes; see enforce_local_origin.
STRUCTURE_VIEWER_PREFIX = "/structure/"

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
    framed = path.startswith(STRUCTURE_VIEWER_PREFIX)
    if guarded or framed:
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        if not _is_allowed_origin(origin) or not _is_allowed_referer(referer):
            return JSONResponse(status_code=403, content={"detail": "Forbidden origin"})
        if API_TOKEN and request.method.upper() != "OPTIONS":
            # The structure viewer is loaded as an iframe and then fetches its own
            # assets and model file. Neither a frame navigation nor a fetch the
            # third-party viewer issues on its own behalf can carry a header, so
            # this one prefix accepts the token from the query string instead.
            provided = (
                request.query_params.get("token", "")
                if framed else
                request.headers.get(API_TOKEN_HEADER, "")
            )
            if not hmac.compare_digest(provided, API_TOKEN):
                return JSONResponse(status_code=401, content={"detail": "Missing or invalid local API token"})
    return await call_next(request)


# ============ Data Models ============

class AlignmentRequest(BaseModel):
    transcript_id: str
    target_transcript_id: Optional[str] = None  # If set, use this ID for target GFF3 lookup
    ref_flank_bp: int = 100  # Flanking for reference sequence
    tgt_flank_bp: int = 100  # Flanking for target sequence
    flank_bp: int = 100  # Legacy: used if ref/tgt not provided
    ref_fasta: Optional[str] = None
    ref_gff: Optional[str] = None
    target_fasta: Optional[str] = None
    target_gff: Optional[str] = None


class Feature(BaseModel):
    type: str
    start: int
    end: int
    original_start: int
    original_end: int
    codon_phase: Optional[int] = None


class AlignedRegion(BaseModel):
    name: str
    sequence: str
    features: List[Feature]
    chrom: str
    genomic_start: int
    genomic_end: int
    strand: str


class AlignmentResult(BaseModel):
    transcript_id: str
    reference: AlignedRegion
    target: AlignedRegion
    alignment_length: int
    identity: float
    gaps: int
    timestamp: str


class MultiAlignmentRowRequest(BaseModel):
    genome: str
    genome_key: Optional[str] = None
    tag: Optional[str] = None
    query: Optional[str] = None
    transcript_id: Optional[str] = None
    selected_transcript_id: Optional[str] = None
    include: bool = True
    flank_5_bp: int = 100
    flank_3_bp: int = 100
    overlay_annotation: bool = True
    use_gene_boundaries: bool = True


class MultiAlignmentRunSettings(BaseModel):
    profile: str = "balanced"  # accurate | balanced | fast
    soft_warn_sequences: int = 6
    hard_cap_sequences: int = 10
    max_total_bp: int = 500_000
    timeout_sec: int = 300
    divergence_mode: str = "auto"  # auto | detail | summary


class MultiAlignmentRequest(BaseModel):
    rows: List[MultiAlignmentRowRequest]
    run_settings: MultiAlignmentRunSettings = MultiAlignmentRunSettings()
    run_scope: str = "resolved_subset"


class MultiAlignmentExcludedRow(BaseModel):
    genome: str
    genome_key: str = ""
    tag: str = ""
    query: str = ""
    transcript_id: str = ""
    reason: str


class MultiAlignedRow(BaseModel):
    genome: str
    genome_key: str = ""
    tag: str = ""
    query: str = ""
    transcript_id: str
    chrom: str
    genomic_start: int
    genomic_end: int
    strand: str
    aligned_sequence: str
    raw_length: int
    flank_5_bp: int = 100
    flank_3_bp: int = 100
    overlay_annotation: bool = True
    use_gene_boundaries: bool = True
    features: List[Feature] = []
    identity_to_consensus: float = 0.0
    gap_fraction: float = 0.0


class MultiAlignmentResult(BaseModel):
    timestamp: str
    alignment_length: int
    requested_count: int
    included_count: int
    profile: str
    strategy: str
    consensus: str
    average_identity: float = 0.0
    warnings: List[str] = []
    rows: List[MultiAlignedRow]
    excluded_rows: List[MultiAlignmentExcludedRow] = []
    cache_hit: bool = False


class RecentItem(BaseModel):
    transcript_id: str
    target_transcript_id: str = ""
    timestamp: str
    identity: float


# ============ Global State (lightweight) ============

class GenomeData:
    """Cached FASTA handles only - GFF3 is searched on demand."""
    def __init__(self):
        self.ref_fasta: Optional["ThreadSafeFasta"] = None
        self.target_fasta: Optional["ThreadSafeFasta"] = None
        self.ref_fasta_path: Optional[str] = None
        self.target_fasta_path: Optional[str] = None

    def load_fasta(self, ref_fasta: str, target_fasta: str):
        """Load FASTA files if not already loaded. Handles both plain and bgzipped (.gz) FASTA."""
        if self.ref_fasta_path != ref_fasta:
            file_io.log_progress(f"Loading reference FASTA: {Path(ref_fasta).name}")
            self.ref_fasta = file_io.open_indexed_fasta(ref_fasta)
            self.ref_fasta_path = ref_fasta
            file_io.log_progress("  ✓ Reference FASTA loaded")

        if self.target_fasta_path != target_fasta:
            file_io.log_progress(f"Loading target FASTA: {Path(target_fasta).name}")
            self.target_fasta = file_io.open_indexed_fasta(target_fasta)
            self.target_fasta_path = target_fasta
            file_io.log_progress("  ✓ Target FASTA loaded")


genome_data = GenomeData()
recent_transcripts: List[RecentItem] = []


# In-memory task registry for background structural stats generation.
_stats_tasks_guard = threading.Lock()
_stats_tasks: Dict[str, Dict[str, Any]] = {}


_STATS_DEFAULT_SECTIONS = ["annotation", "structural", "homology", "assembly"]
_STATS_ANNOTATION_DEPS = ("gff3", "index")
_STATS_STRUCTURAL_DEPS = ("gff3", "index", "fasta")
_STATS_HOMOLOGY_DEPS = ("homology",)
_STATS_ASSEMBLY_DEPS = ("fasta",)

_STRUCTURAL_REQUIRED_FIELDS = (
    "regular_cds_count",
    "regular_cds_fraction",
    "small_intron_gap_fraction",
    "small_intron_gap_count",
    "non_canonical_splice_fraction",
    "non_canonical_splice_count",
    "sequence_metrics_status",
)
_STRUCTURAL_TASK_TERMINAL_STATUSES = {"ready", "failed", "missing", "canceled"}


def _is_stats_cache_schema_current(cache: Dict[str, Any]) -> bool:
    return str((cache or {}).get("schema_version") or "") == STATS_SCHEMA_VERSION


def _has_required_structural_fields(structural: Dict[str, Any]) -> bool:
    if not isinstance(structural, dict):
        return False
    for field in _STRUCTURAL_REQUIRED_FIELDS:
        if field not in structural:
            return False
    if str(structural.get("sequence_metrics_status") or "") != "ready":
        return False
    if structural.get("regular_cds_count") is None:
        return False
    if structural.get("non_canonical_splice_count") is None:
        return False
    return True


def extract_genomic_sequence(
    fasta: pysam.FastaFile,
    chrom: str,
    start: int,
    end: int,
    strand: str,
    uppercase: bool = True,
) -> str:
    """Extract sequence from FASTA, reverse complement if needed."""
    seq = fasta.fetch(chrom, start - 1, end)
    if strand == "-":
        seq = str(Seq(seq).reverse_complement())
    return seq.upper() if uppercase else str(seq)


def run_mafft_alignment(seq1: str, seq2: str) -> Tuple[str, str]:
    """Run MAFFT pairwise alignment."""
    file_io.log_progress(f"Running MAFFT alignment ({len(seq1)}bp vs {len(seq2)}bp)...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        f.write(f">seq1\n{seq1}\n>seq2\n{seq2}\n")
    
    try:
        # --auto automatically converts to the most appropriate method
        # --quiet suppresses output
        cmd = [app_paths.MAFFT_PATH, "--auto", "--quiet", input_file]
        file_io.log_progress(f"  Running MAFFT...")
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
                env={**os.environ, **app_paths.MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        
        if result.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {result.stderr}")
        
        # Parse FASTA output from stdout
        aligned = {}
        current_id = None
        current_seq = []
        
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if current_id:
                    aligned[current_id] = "".join(current_seq)
                current_id = line[1:].strip()
                current_seq = []
            else:
                current_seq.append(line)
        if current_id:
            aligned[current_id] = "".join(current_seq)
        
        file_io.log_progress(f"  ✓ MAFFT complete ({len(aligned.get('seq1', ''))} positions)")
        return aligned.get("seq1", ""), aligned.get("seq2", "")
    
    finally:
        os.unlink(input_file)


def _normalize_multi_profile(raw_profile: str) -> str:
    token = str(raw_profile or "").strip().lower()
    if token in {"accurate", "balanced", "fast"}:
        return token
    return "balanced"


def _normalize_multi_divergence_mode(raw_mode: str) -> str:
    token = str(raw_mode or "").strip().lower()
    if token in {"auto", "detail", "summary"}:
        return token
    return "auto"


def _choose_msa_strategy(
    profile: str,
    seq_count: int,
    max_seq_len: int,
    total_bp: int,
    strict_balanced: bool = False,
) -> Tuple[str, List[str], List[str]]:
    warnings: List[str] = []
    p = _normalize_multi_profile(profile)

    if p == "accurate":
        if seq_count <= 4 and max_seq_len <= 12_000:
            return "accurate", warnings, ["--localpair", "--maxiterate", "1000", "--quiet"]
        warnings.append("Requested accurate profile exceeds small-job limits; using balanced strategy.")
        return "balanced", warnings, ["--auto", "--quiet"]

    if p == "fast":
        return "fast", warnings, ["--retree", "1", "--maxiterate", "0", "--quiet"]

    # balanced default
    if strict_balanced:
        return "balanced", warnings, ["--auto", "--quiet"]
    if max_seq_len > 30_000 or total_bp > 200_000 or seq_count > 6:
        warnings.append("Input size is large; using fast memory-efficient MAFFT settings.")
        return "fast", warnings, ["--retree", "1", "--maxiterate", "0", "--quiet"]
    return "balanced", warnings, ["--auto", "--quiet"]


def run_mafft_alignment_multi(
    ordered_sequences: List[Tuple[str, str]],
    mafft_args: List[str],
    timeout_sec: int,
) -> Dict[str, str]:
    if len(ordered_sequences) < 2:
        raise RuntimeError("Need at least two sequences for MSA.")

    file_io.log_progress(f"Running MAFFT MSA ({len(ordered_sequences)} sequences)...")
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        for seq_id, seq in ordered_sequences:
            f.write(f">{seq_id}\n{seq}\n")

    try:
        cmd = [app_paths.MAFFT_PATH, *mafft_args, input_file]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(30, int(timeout_sec)),
                env={**os.environ, **app_paths.MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        if result.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {result.stderr}")

        aligned: Dict[str, str] = {}
        current_id: Optional[str] = None
        current_seq: List[str] = []
        for line in result.stdout.splitlines():
            token = str(line or "").strip()
            if not token:
                continue
            if token.startswith(">"):
                if current_id is not None:
                    aligned[current_id] = "".join(current_seq)
                current_id = token[1:].strip()
                current_seq = []
            else:
                current_seq.append(token)
        if current_id is not None:
            aligned[current_id] = "".join(current_seq)

        if len(aligned) != len(ordered_sequences):
            raise RuntimeError("MAFFT output is missing one or more aligned sequences.")
        return aligned
    finally:
        try:
            os.unlink(input_file)
        except Exception:
            pass


_MAFFT_COUNT = re.compile(r"(\d+)\s*/\s*(\d+)")
_MAFFT_PASS = re.compile(r"Progressive alignment\s+(\d+)\s*/\s*(\d+)", re.I)
# Where each MAFFT stage falls within one pass of its progressive alignment.
_MAFFT_STAGES = {"distances": (0.0, 0.3), "tree": (0.3, 0.4), "progressive": (0.4, 0.95), "refining": (0.95, 1.0)}


def run_mafft_alignment_multi_progress(
    ordered_sequences: List[Tuple[str, str]],
    mafft_args: List[str],
    timeout_sec: int,
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, str]:
    """:func:`run_mafft_alignment_multi`, reporting MAFFT's own progress and stoppable.

    MAFFT (without ``--quiet``) counts through each stage on stderr: ``Making a distance
    matrix ..  37 / 120``, ``STEP  54 / 119`` in each progressive pass. Those counts become
    ``{stage, pass, passes, done, total, fraction}``; ``cancelled()`` kills the run.
    """
    if len(ordered_sequences) < 2:
        raise RuntimeError("Need at least two sequences for MSA.")
    args = [a for a in mafft_args if a != "--quiet"]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".fa", delete=False) as f:
        input_file = f.name
        for seq_id, seq in ordered_sequences:
            f.write(f">{seq_id}\n{seq}\n")
    state = {"stage": "starting", "pass": 1, "passes": 1, "done": 0, "total": 0, "fraction": 0.0}
    last_report = [0.0]

    def publish(force: bool = False) -> None:
        low, high = _MAFFT_STAGES.get(state["stage"], (0.0, 0.0))
        within = low + (high - low) * (state["done"] / state["total"] if state["total"] else 0.0)
        # Never backwards: a second pass starts again at its distance matrix.
        state["fraction"] = max(state["fraction"], min(1.0, ((state["pass"] - 1) + within) / max(1, state["passes"])))
        now = time.time()
        if on_progress and (force or now - last_report[0] > 0.25):
            last_report[0] = now
            on_progress(dict(state))

    def read_progress(stream) -> None:
        buffer = b""
        while True:
            chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
            if not chunk:
                break
            buffer += chunk
            *lines, buffer = re.split(rb"[\r\n]", buffer)
            for raw in lines:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                tail.append(line)
                passed = _MAFFT_PASS.search(line)
                lower = line.lower()
                if passed:
                    state.update(stage="progressive", done=0, total=0,
                                 **{"pass": int(passed.group(1)), "passes": max(int(passed.group(2)), state["passes"])})
                elif lower.startswith("progressive alignment"):
                    state.update(stage="progressive", done=0, total=0)
                elif "distance matrix" in lower or "all-to-all" in lower:
                    state.update(stage="distances", done=0, total=0)
                elif "constructing" in lower and "tree" in lower:
                    state.update(stage="tree", done=0, total=0)
                elif lower.startswith("iterative refinement") or lower.startswith("segment"):
                    state.update(stage="refining", done=0, total=0)
                count = _MAFFT_COUNT.search(line)
                if count and not passed:
                    state.update(done=int(count.group(1)), total=max(1, int(count.group(2))))
                publish()

    tail: "deque[str]" = deque(maxlen=40)
    output: List[bytes] = []
    try:
        try:
            proc = subprocess.Popen([app_paths.MAFFT_PATH, *args, input_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={**os.environ, **app_paths.MAFFT_ENV})
        except FileNotFoundError as exc:
            raise app_paths._mafft_missing_error() from exc
        readers = [threading.Thread(target=lambda: output.append(proc.stdout.read()), daemon=True),
                   threading.Thread(target=read_progress, args=(proc.stderr,), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.time() + max(30, int(timeout_sec))
        while proc.poll() is None:
            if cancelled and cancelled():
                proc.kill()
                proc.wait()
                raise InterruptedError("cancelled")
            if time.time() > deadline:
                proc.kill()
                proc.wait()
                raise RuntimeError(f"MAFFT took longer than {int(timeout_sec)} seconds and was stopped.")
            time.sleep(0.2)
        for reader in readers:
            reader.join(timeout=10)
        if proc.returncode != 0:
            raise RuntimeError(f"MAFFT failed: {' / '.join(list(tail)[-5:])}")
        state.update(stage="refining", done=1, total=1, **{"pass": state["passes"]})
        publish(force=True)

        aligned: Dict[str, str] = {}
        current_id: Optional[str] = None
        current_seq: List[str] = []
        for line in b"".join(output).decode("utf-8", "replace").splitlines():
            token = line.strip()
            if not token:
                continue
            if token.startswith(">"):
                if current_id is not None:
                    aligned[current_id] = "".join(current_seq)
                current_id = token[1:].strip()
                current_seq = []
            else:
                current_seq.append(token)
        if current_id is not None:
            aligned[current_id] = "".join(current_seq)
        if len(aligned) != len(ordered_sequences):
            raise RuntimeError("MAFFT output is missing one or more aligned sequences.")
        return aligned
    finally:
        try:
            os.unlink(input_file)
        except Exception:
            pass


def _multi_alignment_cache_dir(output_dir: Optional[str]) -> Optional[Path]:
    root = str(output_dir or "").strip()
    if not root:
        return None
    try:
        cache_dir = Path(root).expanduser().resolve() / "alignment_cache_multi"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir
    except Exception:
        return None


def _stable_json_hash(payload: Dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _transcript_window_with_oriented_flanks(
    tx: gff_index.SimpleTranscript,
    flank_5_bp: int,
    flank_3_bp: int,
) -> Tuple[int, int]:
    return _interval_window_with_oriented_flanks(int(tx.start), int(tx.end), str(tx.strand or "+"), flank_5_bp, flank_3_bp)


def _interval_window_with_oriented_flanks(
    start: int,
    end: int,
    strand: str,
    flank_5_bp: int,
    flank_3_bp: int,
) -> Tuple[int, int]:
    f5 = max(0, int(flank_5_bp))
    f3 = max(0, int(flank_3_bp))
    left = min(int(start), int(end))
    right = max(int(start), int(end))
    if str(strand or "+") == "-":
        start = max(1, left - f3)
        end = right + f5
    else:
        start = max(1, left - f5)
        end = right + f3
    return start, end

def _find_parent_gene_boundaries(genome: str, transcript_id: str) -> Tuple[Optional[int], Optional[int]]:
    """Look up the parent gene's genomic boundaries for a transcript.

    Returns (gene_start, gene_end) or (None, None) if not found.
    """
    try:
        context = genome_context._resolve_browse_genome_context(genome)
    except Exception:
        return None, None
    db_path = str(context.get("db_path") or "").strip()
    if not db_path or not os.path.exists(db_path):
        return None, None

    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(
            "SELECT parent_gene_id FROM transcripts WHERE id = ?",
            (search_id,),
        )
        tx_row = c.fetchone()
        if not tx_row or not tx_row["parent_gene_id"]:
            conn.close()
            return None, None
        parent_gene_id = str(tx_row["parent_gene_id"])
        c.execute(
            "SELECT start, end FROM genes WHERE id = ?",
            (parent_gene_id,),
        )
        gene_row = c.fetchone()
        conn.close()
        if not gene_row:
            return None, None
        return int(gene_row["start"]), int(gene_row["end"])
    except Exception:
        return None, None


def _find_transcript_for_genome(genome: str, transcript_id: str) -> Optional[gff_index.SimpleTranscript]:
    context = genome_context._resolve_browse_genome_context(genome)
    db_path = str(context.get("db_path") or "").strip()
    gff_path = str(context.get("gff_path") or "").strip()

    tx: Optional[gff_index.SimpleTranscript] = None
    if db_path and os.path.exists(db_path):
        tx = gff_index.find_transcript_in_index(db_path, transcript_id)
    if tx is None and gff_path and os.path.exists(gff_path):
        tx = gff_index.find_transcript_fast(gff_path, transcript_id)
    return tx


def _resolve_transcript_id_for_genome_query(genome: str, query: str) -> str:
    q = str(query or "").strip()
    if not q:
        return ""
    try:
        context = genome_context._resolve_browse_genome_context(genome)
    except Exception:
        return ""
    db_path = str(context.get("db_path") or "").strip()
    if not db_path or not os.path.exists(db_path):
        return ""

    conn = None
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        # 1) Transcript ID exact / case-insensitive
        c.execute("SELECT id FROM transcripts WHERE id = ? LIMIT 1", (q,))
        row = c.fetchone()
        if row and row.get("id"):
            return str(row["id"])
        c.execute("SELECT id FROM transcripts WHERE LOWER(id) = LOWER(?) LIMIT 1", (q,))
        row = c.fetchone()
        if row and row.get("id"):
            return str(row["id"])

        # 2) Resolve gene id by name/id, then pick canonical (or earliest) transcript
        gene_id = None
        for sql, params in [
            ("SELECT id FROM genes WHERE LOWER(name) = LOWER(?) LIMIT 1", (q,)),
            ("SELECT id FROM genes WHERE LOWER(id) = LOWER(?) LIMIT 1", (q,)),
            ("SELECT id FROM genes WHERE LOWER(name) LIKE LOWER(?) LIMIT 1", (f"%{q}%",)),
        ]:
            try:
                c.execute(sql, params)
                row = c.fetchone()
            except sqlite3.OperationalError:
                row = None
            if row and row.get("id"):
                gene_id = str(row["id"])
                break

        if not gene_id:
            return ""

        try:
            c.execute(
                "SELECT id FROM transcripts WHERE parent_gene_id = ? ORDER BY is_canonical DESC, start ASC LIMIT 1",
                (gene_id,),
            )
            row = c.fetchone()
            if row and row.get("id"):
                return str(row["id"])
        except sqlite3.OperationalError:
            pass

        try:
            c.execute(
                "SELECT id FROM transcripts WHERE parent_gene_id = ? LIMIT 1",
                (gene_id,),
            )
            row = c.fetchone()
            if row and row.get("id"):
                return str(row["id"])
        except sqlite3.OperationalError:
            pass
    except Exception:
        return ""
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass
    return ""


def _extract_sequence_for_alignment_row(
    genome: str,
    fasta: pysam.FastaFile,
    chrom: str,
    start: int,
    end: int,
    strand: str,
) -> Tuple[str, str, int, int]:
    requested_chrom = str(chrom or "").strip()
    if not requested_chrom:
        raise RuntimeError("missing chromosome/region name")

    def _build_candidates(known_regions: List[str]) -> List[str]:
        known_by_lower = {k.lower(): k for k in known_regions}
        out: List[str] = []

        def _add(value: Optional[str]) -> None:
            token = str(value or "").strip()
            if not token:
                return
            if token not in out:
                out.append(token)
            mapped = known_by_lower.get(token.lower())
            if mapped and mapped not in out:
                out.append(mapped)

        _add(requested_chrom)
        try:
            resolved = genome_context._resolve_browse_chrom_name(genome, requested_chrom, known_regions)
        except Exception:
            resolved = ""
        _add(resolved)
        for token in chrom_token_variants(requested_chrom):
            _add(token)
        return out or [requested_chrom]

    def _try_fetch(handle: pysam.FastaFile, candidates: List[str]) -> Tuple[Optional[Tuple[str, str, int, int]], List[str], bool]:
        errors: List[str] = []
        all_unknown_region = True
        for candidate in candidates:
            try:
                chrom_len = int(handle.get_reference_length(candidate))
                all_unknown_region = False
            except Exception as exc:
                errors.append(f"{candidate}: unknown region ({exc})")
                continue

            lo = max(1, int(start or 1))
            hi = max(1, int(end or lo))
            if hi < lo:
                lo, hi = hi, lo

            if chrom_len <= 0:
                errors.append(f"{candidate}: empty contig")
                continue

            lo = min(lo, chrom_len)
            hi = min(max(lo, hi), chrom_len)

            try:
                seq = extract_genomic_sequence(handle, candidate, lo, hi, strand, uppercase=False)
            except Exception as exc:
                errors.append(f"{candidate}:{lo}-{hi} ({exc})")
                continue

            if seq:
                return (seq, candidate, lo, hi), errors, all_unknown_region
            errors.append(f"{candidate}:{lo}-{hi} (empty)")
        return None, errors, all_unknown_region

    def _stream_fetch_fallback(candidates: List[str]) -> Optional[Tuple[str, str, int, int]]:
        try:
            context = genome_context._resolve_browse_genome_context(genome)
            source_path = str(context.get("fasta_path") or "").strip()
        except Exception:
            source_path = ""
        if not source_path or not os.path.exists(source_path):
            return None

        lo = max(1, int(start or 1))
        hi = max(1, int(end or lo))
        if hi < lo:
            lo, hi = hi, lo

        candidate_lookup = {str(c or "").strip().lower() for c in candidates if str(c or "").strip()}
        if not candidate_lookup:
            candidate_lookup = {requested_chrom.lower()}

        current_name = ""
        in_target = False
        pos = 1
        chunks: List[str] = []

        with file_io.open_maybe_gz(source_path, "rt") as handle:
            for raw_line in handle:
                line = str(raw_line or "").strip()
                if not line:
                    continue
                if line.startswith(">"):
                    header_name = line[1:].strip().split()[0] if line[1:].strip() else ""
                    if in_target:
                        break
                    current_name = header_name
                    in_target = header_name.lower() in candidate_lookup
                    pos = 1
                    continue

                if not in_target:
                    continue

                seq_line = line
                line_len = len(seq_line)
                if line_len <= 0:
                    continue
                line_start = pos
                line_end = pos + line_len - 1
                if line_end < lo:
                    pos += line_len
                    continue
                if line_start > hi:
                    break

                left = max(0, lo - line_start)
                right = min(line_len, hi - line_start + 1)
                if right > left:
                    chunks.append(seq_line[left:right])
                pos += line_len
                if pos > hi:
                    break

        if not chunks:
            return None

        seq = "".join(chunks)
        if strand == "-":
            seq = str(Seq(seq).reverse_complement())
        return str(seq), current_name, lo, hi

    known_regions = [str(r or "").strip() for r in list(fasta.references or []) if str(r or "").strip()]
    first_candidates = _build_candidates(known_regions)
    result, first_errors, first_all_unknown = _try_fetch(fasta, first_candidates)
    if result is not None:
        return result

    # Recovery path for stale/truncated FASTA index files: force reindex once and retry.
    if first_all_unknown:
        try:
            refreshed_fasta = _force_refresh_browse_fasta_index(genome, current_fasta=fasta)
            refreshed_regions = [
                str(r or "").strip()
                for r in list(refreshed_fasta.references or [])
                if str(r or "").strip()
            ]
            retry_candidates = _build_candidates(refreshed_regions)
            retry_result, retry_errors, _ = _try_fetch(refreshed_fasta, retry_candidates)
            if retry_result is not None:
                return retry_result
            first_errors.extend([f"retry:{msg}" for msg in retry_errors[:8]])
        except Exception as exc:
            first_errors.append(f"retry_failed: {exc}")

        streamed = _stream_fetch_fallback(first_candidates)
        if streamed is not None:
            return streamed
        first_errors.append("stream_fallback_failed: no matching FASTA contig sequence found")

    detail = "; ".join(first_errors[:8]) if first_errors else "unknown fetch failure"
    raise RuntimeError(f"unable to fetch sequence for {requested_chrom}:{start}-{end} ({detail})")


def _build_consensus_from_aligned_rows(aligned_sequences: List[str]) -> str:
    if not aligned_sequences:
        return ""
    aln_len = len(aligned_sequences[0])
    if aln_len <= 0:
        return ""
    out: List[str] = []
    for i in range(aln_len):
        col = [seq[i] for seq in aligned_sequences if i < len(seq)]
        non_gap = [c for c in col if c != "-"]
        if not non_gap:
            out.append("-")
            continue
        counts = Counter(non_gap)
        best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        out.append(best)
    return "".join(out)


def _identity_to_consensus(seq: str, consensus: str) -> float:
    if not seq or not consensus:
        return 0.0
    matches = 0
    denom = 0
    for a, c in zip(seq, consensus):
        if a == "-" and c == "-":
            continue
        if c == "-":
            continue
        denom += 1
        if a == c:
            matches += 1
    if denom <= 0:
        return 0.0
    return float(matches) / float(denom) * 100.0


def _gap_fraction(seq: str) -> float:
    if not seq:
        return 0.0
    return float(seq.count("-")) / float(max(1, len(seq)))


def map_features_to_alignment(
    transcript: gff_index.SimpleTranscript,
    genomic_start: int,
    genomic_end: int,
    aligned_seq: str,
    strand: str,
    raw_genomic_seq: str = ""
) -> List[Feature]:
    """Map genomic features to alignment coordinates with priority ordering.
    
    Priority (highest first): start/stop/splice > UTR/CDS > exon/intron
    """
    features = []
    
    genomic_len = genomic_end - genomic_start + 1
    genomic_to_aln = {}
    
    genomic_pos = 0
    for aln_pos, base in enumerate(aligned_seq):
        if base != '-':
            genomic_to_aln[genomic_pos] = aln_pos
            genomic_pos += 1
    
    def genomic_to_alignment_range(gstart: int, gend: int) -> Tuple[int, int]:
        if strand == "+":
            rel_start = gstart - genomic_start
            rel_end = gend - genomic_start
        else:
            rel_start = genomic_end - gend
            rel_end = genomic_end - gstart
        
        rel_start = max(0, min(rel_start, genomic_len - 1))
        rel_end = max(0, min(rel_end, genomic_len - 1))
        
        aln_start = genomic_to_aln.get(rel_start, 0)
        aln_end = genomic_to_aln.get(rel_end, len(aligned_seq) - 1)
        
        return aln_start, aln_end
    
    def add_feature(ftype: str, gstart: int, gend: int, priority: int):
        if gstart > genomic_end or gend < genomic_start:
            return
        aln_start, aln_end = genomic_to_alignment_range(gstart, gend)
        features.append({
            'type': ftype,
            'start': aln_start,
            'end': aln_end,
            'original_start': gstart,
            'original_end': gend,
            'priority': priority
        })
    
    # Priority 3: Exons and Introns (lowest)
    for exon in transcript.exons:
        add_feature('exon', exon.start, exon.end, 3)
    
    # Infer introns between exons
    sorted_exons = sorted(transcript.exons, key=lambda e: e.start)
    for i in range(len(sorted_exons) - 1):
        intron_start = sorted_exons[i].end + 1
        intron_end = sorted_exons[i + 1].start - 1
        if intron_end >= intron_start:
            add_feature('intron', intron_start, intron_end, 3)
    
    # Priority 2: CDS and UTRs
    for cds in transcript.cds_list:
        add_feature('cds', cds.start, cds.end, 2)
    
    for utr in transcript.utrs:
        utr_type = 'utr5' if utr.feature_type == 'five_prime_UTR' else 'utr3'
        add_feature(utr_type, utr.start, utr.end, 2)
    
    # Priority 1: Splice sites, Start/Stop codons (highest)
    # Infer splice sites from exon boundaries (check canonical GT/AG)
    # Sort exons biologically:
    # (+) strand: start -> end (Ascending)
    # (-) strand: end -> start (Descending)
    sorted_exons = sorted(transcript.exons, key=lambda e: e.start, reverse=(strand == '-'))
    
    for i, exon in enumerate(sorted_exons):
        # Donor (5' splice site) - after exon
        if i < len(sorted_exons) - 1:
            if strand == '+':
                # (+) Donor: GT at exon.end + 1, + 2
                gstart, gend = exon.end + 1, exon.end + 2
                # (+) Index: gstart - genomic_start
                seq_idx = gstart - genomic_start
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'GT':
                        add_feature('donor', gstart, gend, 1)
            else:
                # (-) Donor: GT (flanking exon 3' end, which is exon.start)
                # Genomic coords: exon.start - 1, exon.start - 2 (High -> Low)
                # RC Index: genomic_end - coord
                # Base 1 (GT[0]): exon.start - 1 (gend) -> index = genomic_end - (exon.start - 1)
                gstart, gend = exon.start - 2, exon.start - 1
                seq_idx = genomic_end - gend
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'GT': # Check GT directly in RC sequence
                        add_feature('donor', gstart, gend, 1)

        # Acceptor (3' splice site) - before exon
        if i > 0:
            if strand == '+':
                # (+) Acceptor: AG at exon.start - 2, - 1
                gstart, gend = exon.start - 2, exon.start - 1
                seq_idx = gstart - genomic_start
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'AG':
                        add_feature('acceptor', gstart, gend, 1)
            else:
                # (-) Acceptor: AG (flanking exon 5' start, which is exon.end)
                # Genomic coords: exon.end + 2, exon.end + 1 (High -> Low)
                # RC Index: genomic_end - coord
                # Base 1 (AG[0]): exon.end + 2 (gend) -> index = genomic_end - (exon.end + 2)
                gstart, gend = exon.end + 1, exon.end + 2
                seq_idx = genomic_end - gend
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'AG': # Check AG directly in RC sequence
                        add_feature('acceptor', gstart, gend, 1)
    
    # Infer start/stop codons from CDS boundaries
    if transcript.cds_list:
        sorted_cds = sorted(transcript.cds_list, key=lambda c: c.start)
        if strand == '+':
            # Start codon at beginning of first CDS
            cds_start = sorted_cds[0].start
            add_feature('start_codon', cds_start, cds_start + 2, 1)
            # Stop codon at end of last CDS
            cds_end = sorted_cds[-1].end
            add_feature('stop_codon', cds_end - 2, cds_end, 1)
        else:
            # For minus strand, start is at the end, stop at the beginning
            cds_end = sorted_cds[-1].end
            add_feature('start_codon', cds_end - 2, cds_end, 1)
            cds_start = sorted_cds[0].start
            add_feature('stop_codon', cds_start, cds_start + 2, 1)
    
    # Sort features by priority (lower number = higher priority) so higher priority drawn last
    features.sort(key=lambda f: -f['priority'])
    
    # Convert to Feature objects
    result = []
    for f in features:
        result.append(Feature(
            type=f['type'],
            start=f['start'],
            end=f['end'],
            original_start=f['original_start'],
            original_end=f['original_end']
        ))
    
    return result


def calculate_identity(seq1: str, seq2: str) -> Tuple[float, int]:
    """Calculate identity and gap count between aligned sequences."""
    matches = 0
    gaps = 0
    total = 0
    
    for a, b in zip(seq1, seq2):
        if a == '-' or b == '-':
            gaps += 1
        else:
            total += 1
            if a == b:
                matches += 1
    
    identity = (matches / total * 100) if total > 0 else 0
    return identity, gaps


def get_cache_path(transcript_id: str, target_id: str, ref_flank: int = 0, tgt_flank: int = 0) -> Path:
    """Get cache path including flanking info and target ID."""
    safe_id = transcript_id.replace(":", "_").replace("/", "_")
    safe_target = target_id.replace(":", "_").replace("/", "_")
    return app_paths.CACHE_DIR / f"{safe_id}_vs_{safe_target}_rf{ref_flank}_tf{tgt_flank}.json"


def get_max_flanking_cache(transcript_id: str, target_id: str) -> Optional[Tuple[Path, int, int]]:
    """Find the cached alignment with the largest flanking for this transcript pair."""
    import re
    safe_id = transcript_id.replace(":", "_").replace("/", "_")
    safe_target = target_id.replace(":", "_").replace("/", "_")
    pattern = f"{safe_id}_vs_{safe_target}_rf*_tf*.json"
    
    best_path = None
    best_ref_flank = -1
    best_tgt_flank = -1
    
    for path in app_paths.CACHE_DIR.glob(pattern):
        # Extract flanking values from filename
        match = re.search(r'_rf(\d+)_tf(\d+)\.json$', path.name)
        if match:
            ref_flank = int(match.group(1))
            tgt_flank = int(match.group(2))
            # Prefer larger cached alignments
            if ref_flank >= best_ref_flank and tgt_flank >= best_tgt_flank:
                best_path = path
                best_ref_flank = ref_flank
                best_tgt_flank = tgt_flank
    
    if best_path:
        return best_path, best_ref_flank, best_tgt_flank
    return None


def load_from_cache(transcript_id: str, target_id: str, ref_flank: int, tgt_flank: int) -> Optional[AlignmentResult]:
    """Load from cache if exact match exists or if a larger cached alignment can be subset."""
    # First try exact match
    cache_path = get_cache_path(transcript_id, target_id, ref_flank, tgt_flank)
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                data = json.load(f)
                file_io.log_progress("  ✓ Found exact cache match")
                return AlignmentResult(**data)
        except Exception:
            pass
    
    # Try to find a larger cached alignment
    larger = get_max_flanking_cache(transcript_id, target_id)
    if larger:
        path, cached_ref_flank, cached_tgt_flank = larger
        if cached_ref_flank >= ref_flank and cached_tgt_flank >= tgt_flank:
            file_io.log_progress(f"  ✓ Found larger cache (rf{cached_ref_flank}, tf{cached_tgt_flank}), can subset")
            # For now, just return the larger alignment - client handles display
            # A full implementation would extract sub-alignment here
            try:
                with open(path) as f:
                    data = json.load(f)
                    return AlignmentResult(**data)
            except Exception:
                pass
    
    return None


def save_to_cache(result: AlignmentResult, target_id: str, ref_flank: int, tgt_flank: int):
    """Save alignment to cache with flanking info in filename."""
    cache_path = get_cache_path(result.transcript_id, target_id, ref_flank, tgt_flank)
    try:
        with open(cache_path, 'w') as f:
            json.dump(result.model_dump(), f)
        file_io.log_progress(f"  ✓ Saved to cache: {cache_path.name}")
    except Exception as e:
        file_io.log_progress(f"  ✗ Failed to save cache: {e}")


# ============ API Endpoints ============

@app.get("/api/health")
async def health():
    return {"status": "ok"}

def get_alignment_cache_path(output_dir: str, ref_id: str, tgt_id: str, ref_flank: int, tgt_flank: int) -> Optional[str]:
    """Generate a consistent cache file path for an alignment."""
    if not output_dir:
        return None
        
    # Sanitize IDs for filenames
    safe_ref = ref_id.replace(":", "_").replace("/", "_")
    safe_tgt = tgt_id.replace(":", "_").replace("/", "_")
    
    filename = f"align_{safe_ref}_{safe_tgt}_{ref_flank}_{tgt_flank}.json"
    cache_dir = os.path.join(output_dir, "alignment_cache")
    
    if not os.path.exists(cache_dir):
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except:
            return None
            
    return os.path.join(cache_dir, filename)

def find_compatible_cache(output_dir: str, ref_id: str, tgt_id: str, req_ref: int, req_tgt: int) -> Tuple[Optional[str], int, int]:
    """Find a cache file that covers at least the requested flanking regions."""
    logger.debug("Searching alignment cache: dir=%s, ref=%s, tgt=%s, req=(%s,%s)", output_dir, ref_id, tgt_id, req_ref, req_tgt)

    if not output_dir:
        return None, 0, 0
        
    cache_dir = Path(output_dir) / "alignment_cache"
    if not cache_dir.exists():
        return None, 0, 0
        
    safe_ref = ref_id.replace(":", "_").replace("/", "_")
    safe_tgt = tgt_id.replace(":", "_").replace("/", "_")
    prefix = f"align_{safe_ref}_{safe_tgt}_"
    
    best_path = None
    best_area = float('inf')
    found_ref = 0
    found_tgt = 0
    
    try:
        for f in cache_dir.iterdir():
            if f.name.startswith(prefix) and f.name.endswith(".json"):
                # Parse flanks from filename: align_{ref}_{tgt}_{ref_flank}_{tgt_flank}.json
                try:
                    parts = f.stem.split('_')
                    # We expect at least 4 parts, but ref/tgt might have underscores.
                    # We know the suffixes are the last 2 digits
                    c_tgt_flank = int(parts[-1])
                    c_ref_flank = int(parts[-2])
                    
                    logger.debug("  Checking alignment cache candidate: %s -> (%s, %s)", f.name, c_ref_flank, c_tgt_flank)
                    
                    if c_ref_flank >= req_ref and c_tgt_flank >= req_tgt:
                        # Found compatible cache
                        # Prefer smaller area to minimize truncation overhead? 
                        # Or larger? Doesn't matter much, just pick one.
                        area = c_ref_flank * c_tgt_flank
                        if area < best_area:
                            best_area = area
                            best_path = str(f)
                            found_ref = c_ref_flank
                            found_tgt = c_tgt_flank
                except:
                    continue
    except Exception as e:
        logger.error(f"Error searching cache: {e}")
        
    return best_path, found_ref, found_tgt

def truncate_and_mask_alignment(result: AlignmentResult, cached_ref: int, cached_tgt: int, req_ref: int, req_tgt: int) -> AlignmentResult:
    """Mask excess flanking regions with gaps and trim empty columns."""
    
    # Calculate how much to trim (per side) from the ORIGINAL sequence perspective
    trim_r = cached_ref - req_ref
    trim_t = cached_tgt - req_tgt
    
    if trim_r == 0 and trim_t == 0:
        return result
        
    # We need to mask the characters that correspond to the outer `trim` bases
    # This preserves alignment but hides the specific sequence
    
    # Helper to mask a sequence string
    # We need to know which characters are "real" bases vs gaps
    def mask_sequence(aligned_seq: str, trim_amount: int) -> str:
        if trim_amount <= 0:
            return aligned_seq
            
        chars = list(aligned_seq)
        orig_len = len([c for c in chars if c != '-'])
        
        current_idx = 0
        for i, char in enumerate(chars):
            if char != '-':
                # Check if this base is in the trim region
                # Left trim: 0 to trim_amount - 1
                # Right trim: (orig_len - trim_amount) to orig_len - 1
                if current_idx < trim_amount or current_idx >= (orig_len - trim_amount):
                    chars[i] = '-'
                current_idx += 1
        return "".join(chars)

    # Mask both sequences
    # Note: result.reference.sequence is the ALIGNED sequence
    new_ref_seq = mask_sequence(result.reference.sequence, trim_r)
    new_tgt_seq = mask_sequence(result.target.sequence, trim_t)
    
    # Now valid characters might be surrounded by gap-only columns
    # We can trim columns where BOTH sequences are gaps
    # But ONLY at the ends (flanking regions), to assume internal gaps are real alignment features
    
    # Logic: 
    # Zip sequences -> identify columns
    # Find first column that is NOT (-,-)
    # Find last column that is NOT (-,-)
    # Slice
    
    # Wait: internal gaps might be (-,-) if aligner inserted them? Unlikely/impossible for MAFFT (gap-gap).
    # But if we masked separate regions (e.g. Ref masked but Tgt present), we keep those.
    # We only drop columns that are effectively "padding" now.
    
    cols = []
    for r, t in zip(new_ref_seq, new_tgt_seq):
        cols.append((r, t))
        
    first_valid = 0
    last_valid = len(cols) - 1
    
    # scan forward
    for i, (r, t) in enumerate(cols):
        if r != '-' or t != '-':
            first_valid = i
            break
            
    # scan backward
    for i in range(len(cols) - 1, -1, -1):
        r, t = cols[i]
        if r != '-' or t != '-':
            last_valid = i
            break
            
    if last_valid < first_valid:
        # Empty alignment? fallback
        return result
        
    # Slice
    sliced_ref = new_ref_seq[first_valid : last_valid+1]
    sliced_tgt = new_tgt_seq[first_valid : last_valid+1]
    
    # Update Genomic Start/End
    # Ref start increases by trim_r
    # Ref end decreases by trim_r
    # (Extract logic: start = tx.start - flank. If shrink flank by N, start increases by N)
    
    # Fix Features: shift alignment coordinates now that we sliced the sequence.
    # Features have 'start'/'end' in ALIGNED coordinates (0-indexed).
    # We dropped `first_valid` columns from the left, so every coordinate
    # needs to be decremented by that amount.
    def shift_features(features, shift):
        new_feats = []
        new_len = len(sliced_ref)
        for f in features:
            s = f.start - shift
            e = f.end - shift

            # Drop features that fall entirely outside the new window
            if e < 0 or s >= new_len:
                continue

            # Clamp to valid range
            s = max(0, s)
            e = min(new_len - 1, e)

            if s <= e:
                # Use model_copy(update={}) – the Pydantic v2 safe way to
                # produce a modified copy without mutating the original.
                new_feats.append(f.model_copy(update={"start": s, "end": e}))
        return new_feats

    ref_features_shifted = shift_features(result.reference.features, first_valid)
    tgt_features_shifted = shift_features(result.target.features, first_valid)

    # Build updated AlignedRegion objects using model_copy(update={}) so we
    # never attempt in-place mutation on a potentially immutable Pydantic model.
    new_ref_reg = result.reference.model_copy(update={
        "sequence": sliced_ref,
        "genomic_start": result.reference.genomic_start + trim_r,
        "genomic_end": result.reference.genomic_end - trim_r,
        "features": ref_features_shifted,
    })
    new_tgt_reg = result.target.model_copy(update={
        "sequence": sliced_tgt,
        "genomic_start": result.target.genomic_start + trim_t,
        "genomic_end": result.target.genomic_end - trim_t,
        "features": tgt_features_shifted,
    })
    
    # Recalculate stats
    ident, gaps = calculate_identity(sliced_ref, sliced_tgt)
    
    return AlignmentResult(
        transcript_id=result.transcript_id,
        reference=new_ref_reg,
        target=new_tgt_reg,
        alignment_length=len(sliced_ref),
        identity=ident,
        gaps=gaps,
        timestamp=result.timestamp
    )


@app.post("/api/align", response_model=AlignmentResult)
def align_transcripts(request: AlignmentRequest):
    """Align two transcripts with flanking sequences.

    Defined with ``def`` rather than ``async def`` so FastAPI runs it on a worker
    thread. Nothing in here awaits, and an alignment takes anything from seconds to
    minutes; on the event loop that was minutes in which the process answered no
    request at all, including the ones the rest of the UI needs to stay responsive.
    """
    config = config_store.load_config()
    output_dir = config.get("output_dir")
    
    # Determine flanking values.
    # ref_flank_bp / tgt_flank_bp are the per-sequence sliders (default 100).
    # flank_bp is the legacy single-slider (default 100).
    # Per-sequence fields take priority; only fall back to the legacy field
    # when the per-sequence field still equals the shared default (100) and
    # the legacy field has been explicitly set to something different.
    ref_flank = request.ref_flank_bp if (request.ref_flank_bp != 100 or request.flank_bp == 100) else request.flank_bp
    tgt_flank = request.tgt_flank_bp if (request.tgt_flank_bp != 100 or request.flank_bp == 100) else request.flank_bp
    
    # Determine target ID early for cache lookup
    target_id = request.target_transcript_id or request.transcript_id

    # Check cache first (smart lookup)
    cache_path, c_ref, c_tgt = find_compatible_cache(
        output_dir, 
        request.transcript_id, 
        target_id,
        ref_flank,
        tgt_flank
    )
    
    
    if cache_path and os.path.exists(cache_path):
        try:
            logger.debug("Attempting to load alignment cache: %s", cache_path)
            file_io.log_progress(f"Found compatible cache: {Path(cache_path).name} ({c_ref}/{c_tgt} vs {ref_flank}/{tgt_flank})")
            with open(cache_path, 'r') as f:
                data = json.load(f)
                cached_result = AlignmentResult(**data)
                
            # Truncate if necessary (if cached flanks > requested)
            file_io.log_progress(f"Adapting cache: {c_ref}->{ref_flank}, {c_tgt}->{tgt_flank}")
            final_result = truncate_and_mask_alignment(cached_result, c_ref, c_tgt, ref_flank, tgt_flank)
            file_io.log_progress("  ✓ Loaded and adapted from cache")
            return final_result
            
        except Exception as e:
            import traceback
            trace_msg = traceback.format_exc()
            
            # Log to console/logger
            logger.error(f"Failed to load/adapt cache: {e}")
            logger.error(trace_msg)
            file_io.log_progress(f"  ✗ Cache adaptation failed: {e}")
            # Continue to re-run alignment if cache load fails
    
    ref_fasta = config.get("ref_fasta")
    ref_gff = config.get("ref_gff")

    file_io.log_progress(f"\n{'='*60}")
    file_io.log_progress(f"Alignment request: {request.transcript_id}")
    file_io.log_progress(f"{'='*60}")
    
    # Get config if not provided in request
    ref_fasta = request.ref_fasta or config.get("ref_fasta")
    ref_gff = request.ref_gff or config.get("ref_gff")
    target_fasta = request.target_fasta or config.get("target_fasta")
    target_gff = config.get("target_gff") # Always from config for now as UI doesn't send separate target GFF path usually?
    if request.target_gff: target_gff = request.target_gff

    # Validate paths
    if not (ref_fasta and ref_gff and target_fasta and target_gff):
        raise HTTPException(
            status_code=400, 
            detail="Genome files not configured. Please set paths in Configuration View."
        )
    
    # Load FASTA files
    try:
        genome_data.load_fasta(ref_fasta, target_fasta)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load FASTA: {e}")
    
    # Determine which transcript IDs to use for ref and target
    ref_id = request.transcript_id
    # target_id already determined above
    
    # Find transcript in reference (fast grep-based lookup)
    file_io.log_progress(f"Searching for transcript in reference GFF3 ({ref_id})...")
    
    # Try index first
    ref_tx = None
    ref_index = config.get("ref_index")
    if ref_index and os.path.exists(ref_index):
        ref_tx = gff_index.find_transcript_in_index(ref_index, ref_id)
        if ref_tx: file_io.log_progress("  ✓ Found in index")
        
    if not ref_tx:
        ref_tx = gff_index.find_transcript_fast(ref_gff, ref_id)
        
    if not ref_tx:
        raise HTTPException(
            status_code=404,
            detail=f"Transcript {ref_id} not found in reference"
        )
    
    # Find transcript in target
    file_io.log_progress(f"Searching for transcript in target GFF3 ({target_id})...")
    
    target_tx = None
    target_index = config.get("target_index")
    if target_index and os.path.exists(target_index):
        target_tx = gff_index.find_transcript_in_index(target_index, target_id)
        if target_tx: file_io.log_progress("  ✓ Found in index")
        
    if not target_tx:
        target_tx = gff_index.find_transcript_fast(target_gff, target_id)

    if not target_tx:
        raise HTTPException(
            status_code=404,
            detail=f"Transcript {target_id} not found in target (may be unmapped)"
        )
    
    # Calculate extraction regions (flanking values already calculated above)
    ref_start = max(1, ref_tx.start - ref_flank)
    ref_end = ref_tx.end + ref_flank
    ref_strand = ref_tx.strand
    
    target_start = max(1, target_tx.start - tgt_flank)
    target_end = target_tx.end + tgt_flank
    target_strand = target_tx.strand
    
    # Extract sequences
    file_io.log_progress(f"Extracting sequences (ref: {ref_flank}bp, target: {tgt_flank}bp flanking)...")
    try:
        ref_seq = extract_genomic_sequence(
            genome_data.ref_fasta, ref_tx.seq_region, ref_start, ref_end, ref_strand, uppercase=False
        )
        file_io.log_progress(f"  ✓ Reference: {len(ref_seq)}bp")
        target_seq = extract_genomic_sequence(
            genome_data.target_fasta, target_tx.seq_region, target_start, target_end, target_strand, uppercase=False
        )
        file_io.log_progress(f"  ✓ Target: {len(target_seq)}bp")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract sequences: {e}")
    
    # Run alignment
    try:
        ref_aligned, target_aligned = run_mafft_alignment(ref_seq, target_seq)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Alignment failed: {e}")
    
    # Map features
    ref_features = map_features_to_alignment(ref_tx, ref_start, ref_end, ref_aligned, ref_strand, ref_seq)
    target_features = map_features_to_alignment(target_tx, target_start, target_end, target_aligned, target_strand, target_seq)
    
    # Calculate stats
    identity, gaps = calculate_identity(ref_aligned, target_aligned)
    
    result = AlignmentResult(
        transcript_id=request.transcript_id,
        reference=AlignedRegion(
            name="reference",
            sequence=ref_aligned,
            features=ref_features,
            chrom=ref_tx.seq_region,
            genomic_start=ref_start,
            genomic_end=ref_end,
            strand=ref_strand
        ),
        target=AlignedRegion(
            name="target",
            sequence=target_aligned,
            features=target_features,
            chrom=target_tx.seq_region,
            genomic_start=target_start,
            genomic_end=target_end,
            strand=target_strand
        ),
        alignment_length=len(ref_aligned),
        identity=identity,
        gaps=gaps,
        timestamp=datetime.now().isoformat()
    )
    
    # Save to cache
    if output_dir and os.path.exists(output_dir):
        # Always construct a new, correctly-named cache file for this specific
        # flank combination.  Never reuse cache_path here: it may point to a
        # *larger* compatible cache that was found by find_compatible_cache,
        # and writing the smaller result there would corrupt it.
        safe_ref = ref_id.replace(":", "_").replace("/", "_")
        safe_tgt = target_id.replace(":", "_").replace("/", "_")
        filename = f"align_{safe_ref}_{safe_tgt}_{ref_flank}_{tgt_flank}.json"

        save_cache_dir = os.path.join(output_dir, "alignment_cache")
        os.makedirs(save_cache_dir, exist_ok=True)

        new_cache_path = os.path.join(save_cache_dir, filename)
        try:
            with open(new_cache_path, 'w') as f:
                f.write(result.model_dump_json())
            file_io.log_progress(f"  ✓ Saved alignment to cache: {Path(new_cache_path).name}")
        except Exception as e:
            logger.error(f"Failed to write cache: {e}")
            
    # Add to recent
    recent_transcripts.insert(0, RecentItem(
        transcript_id=request.transcript_id,
        target_transcript_id=request.target_transcript_id or "",
        timestamp=result.timestamp,
        identity=identity
    ))
    while len(recent_transcripts) > 20:
        recent_transcripts.pop()
            
    return result


_SHARED_ALIGNMENT_STORES: Dict[str, "transcript_msa.AlignmentStore"] = {}


def _shared_alignment_store(output_dir: Optional[str]) -> Optional["transcript_msa.AlignmentStore"]:
    """The alignments folder the Gene Trees view shares: ``local_data/alignments``."""
    root = str(output_dir or "").strip()
    if not root or not os.path.isdir(root):
        return None
    folder = _alignments_dir(root)
    if str(folder) not in _SHARED_ALIGNMENT_STORES:
        _SHARED_ALIGNMENT_STORES[str(folder)] = transcript_msa.AlignmentStore(folder)
    return _SHARED_ALIGNMENT_STORES[str(folder)]


def _msa_shared_rows(prepared_rows: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """Each MSA row as the shared store knows rows: key, region, signature. None if one has no assembly."""
    out = []
    for item in prepared_rows:
        try:
            species = genome_context._resolve_browse_genome_context(item["genome"]).get("species") or {}
        except Exception:
            return None
        assembly = str(species.get("assembly") or species.get("gca") or "").strip()
        if not assembly:
            return None
        tx = item["tx"]
        region = _tmsa_window_region(asdict(tx), int(item["window_start"]), int(item["window_end"]),
                                     int(item["flank_5_bp"]), int(item["flank_3_bp"]))
        region["chrom"] = str(item.get("fetched_chrom") or tx.seq_region or "")
        row_key = f"{assembly}:{item['transcript_id']}"
        input_hash = transcript_msa.sequence_hash(str(item["raw_seq"] or ""))
        structure = _tmsa_structure_hash(asdict(tx))
        out.append({"row_key": row_key, "assembly": assembly, "region": region, "input_hash": input_hash, "structure": structure,
                    "signature": transcript_msa.row_signature(row_key, _tmsa_params_of(region), input_hash, structure)})
    return out


def _msa_result_from_store(store, stem: str, prepared_rows, shared, requested_rows, excluded_rows, warnings, profile):
    """A stored alignment (the Gene Trees', say) holding every row asked for, cut down to them."""
    alignment = transcript_msa.project(store.load(stem), [r["row_key"] for r in shared])
    by_key = {r["row_key"]: r for r in alignment["rows"]}
    rows: List[MultiAlignedRow] = []
    for item, row_id in zip(prepared_rows, shared):
        row = by_key.get(row_id["row_key"])
        if not row:
            return None
        features = [Feature(**{k: f[k] for k in ("type", "start", "end", "original_start", "original_end")})
                    for f in row.get("features") or [] if f.get("type") != "intron_cut"] if item["overlay_annotation"] else []
        rows.append(MultiAlignedRow(
            genome=str(item["genome"] or ""), genome_key=str(item["genome_key"] or ""), tag=str(item["tag"] or ""),
            query=str(item["query"] or ""), transcript_id=str(item["transcript_id"] or ""),
            chrom=str(item.get("fetched_chrom") or item["tx"].seq_region or ""),
            genomic_start=int(item["window_start"]), genomic_end=int(item["window_end"]), strand=str(item["tx"].strand or "+"),
            aligned_sequence=row["aligned"], raw_length=len(str(item["raw_seq"] or "")),
            flank_5_bp=int(item["flank_5_bp"]), flank_3_bp=int(item["flank_3_bp"]),
            overlay_annotation=bool(item["overlay_annotation"]), use_gene_boundaries=bool(item.get("use_gene_boundaries", True)),
            features=features, identity_to_consensus=float(row.get("identity") or 0), gap_fraction=float(row.get("gap_fraction") or 0)))
    return MultiAlignmentResult(
        timestamp=datetime.now().isoformat(), alignment_length=int(alignment["alignment_length"]),
        requested_count=len(requested_rows), included_count=len(rows), profile=profile,
        strategy=str(alignment.get("strategy") or "stored"), consensus=alignment["consensus"],
        average_identity=float(alignment.get("average_identity") or 0),
        warnings=[*warnings, f"Reused a stored alignment ({alignment.get('name') or stem})."],
        rows=rows, excluded_rows=excluded_rows, cache_hit=True)


def _msa_save_shared(store, prepared_rows, shared, ordered_aligned_rows, strategy: str, consensus: str) -> None:
    """Keep an MSA run in the shared folder, so the Gene Trees view can reuse it (and this view, later)."""
    shared_by_item = {id(item): row_id for item, row_id in zip(prepared_rows, shared)}
    rows = []
    for item, aligned_seq in ordered_aligned_rows:
        row_id = shared_by_item.get(id(item))
        if row_id is None:
            return
        aligned = str(aligned_seq).upper()
        raw = str(item["raw_seq"] or "").upper()
        rows.append({**row_id, "genome_key": str(item["genome_key"] or ""), "tag": str(item["tag"] or ""),
                     "gene_id": str(item["query"] or ""), "gene_symbol": str(item["tag"] or ""),
                     "transcript_id": str(item["transcript_id"] or ""), "chrom": row_id["region"]["chrom"],
                     "strand": str(item["tx"].strand or "+"), "genomic_start": int(item["window_start"]),
                     "genomic_end": int(item["window_end"]), "flank_5_bp": int(item["flank_5_bp"]),
                     "flank_3_bp": int(item["flank_3_bp"]), "raw_length": len(raw),
                     "features": transcript_msa.map_features(asdict(item["tx"]), row_id["region"], aligned, raw),
                     "aligned": aligned})
    if len(rows) < 2:
        return
    summary = transcript_msa.project({"rows": rows, "alignment_length": len(rows[0]["aligned"])}, [r["row_key"] for r in rows])
    store.save({**summary, "params": _tmsa_params_of(rows[0]["region"]), "strategy": strategy},
               "msa " + " ".join(r["tag"] for r in rows)[:60], source="multi_alignment", auto=True)


def _trim_multi_to_transcripts(result: "MultiAlignmentResult", prepared_rows: List[Dict[str, Any]]) -> "MultiAlignmentResult":
    """Cut an alignment down to the selected transcripts, each with its row's flanks.

    With gene boundaries on, a row's window is its whole gene, which can run far past the
    transcript chosen (a longer transcript of the same gene, say) and stretch the alignment
    with sequence no selected transcript has. The columns kept run from the first to the last
    that any row's transcript (plus its flanks) reaches; each row's coordinates, features,
    identity and the consensus are worked out again for what is left.
    """
    rows = list(result.rows or [])
    length = int(result.alignment_length or 0)
    if not rows or length <= 0:
        return result
    items = {(str(i["genome_key"] or ""), str(i["transcript_id"] or "")): i for i in prepared_rows}
    first_col, last_col = None, None
    for row in rows:
        item = items.get((row.genome_key, row.transcript_id))
        if item is None:
            return result  # which transcript a row is cannot be told: leave the alignment whole
        tx = item["tx"]
        lo, hi = _interval_window_with_oriented_flanks(int(tx.start), int(tx.end), row.strand, row.flank_5_bp, row.flank_3_bp)
        lo, hi = max(lo, int(row.genomic_start)), min(hi, int(row.genomic_end))
        if hi < lo:
            continue
        if row.strand == "-":
            i0, i1 = int(row.genomic_end) - hi, int(row.genomic_end) - lo
        else:
            i0, i1 = lo - int(row.genomic_start), hi - int(row.genomic_start)
        columns = [c for c, ch in enumerate(row.aligned_sequence) if ch != "-"]
        if not columns:
            continue
        i0, i1 = max(0, i0), min(len(columns) - 1, i1)
        if i0 > i1:
            continue
        first_col = columns[i0] if first_col is None else min(first_col, columns[i0])
        last_col = columns[i1] if last_col is None else max(last_col, columns[i1])
    if first_col is None or (first_col == 0 and last_col == length - 1):
        return result

    trimmed_seqs = [row.aligned_sequence[first_col:last_col + 1] for row in rows]
    consensus = _build_consensus_from_aligned_rows(trimmed_seqs)
    new_rows = []
    for row, seq in zip(rows, trimmed_seqs):
        before = sum(1 for ch in row.aligned_sequence[:first_col] if ch != "-")
        kept = sum(1 for ch in seq if ch != "-")
        if row.strand == "-":
            end = int(row.genomic_end) - before
            start = end - kept + 1
        else:
            start = int(row.genomic_start) + before
            end = start + kept - 1
        features = []
        for f in row.features or []:
            fs, fe = max(int(f.start), first_col), min(int(f.end), last_col)
            if fs <= fe:
                features.append(f.model_copy(update={"start": fs - first_col, "end": fe - first_col}))
        new_rows.append(row.model_copy(update={
            "aligned_sequence": seq, "genomic_start": start, "genomic_end": end, "raw_length": kept, "features": features,
            "identity_to_consensus": _identity_to_consensus(seq, consensus), "gap_fraction": _gap_fraction(seq)}))
    left_out = length - (last_col - first_col + 1)
    return result.model_copy(update={
        "alignment_length": len(consensus), "consensus": consensus, "rows": new_rows,
        "average_identity": float(sum(r.identity_to_consensus for r in new_rows) / max(1, len(new_rows))),
        "warnings": [*(result.warnings or []), f"Trimmed to the selected transcripts and their flanks: {left_out:,} column{'' if left_out == 1 else 's'} of gene sequence beyond them left out."]})


@app.post("/api/align/multi", response_model=MultiAlignmentResult)
def align_multi(request: MultiAlignmentRequest):
    """Align several genomes at once.

    On a worker thread for the same reason as :func:`align_transcripts`, and more so:
    this one's cost scales with the number of genomes in the alignment.
    """
    if not request.rows:
        raise HTTPException(status_code=400, detail="At least one row is required.")

    config = config_store.load_config()
    settings = request.run_settings or MultiAlignmentRunSettings()
    requested_profile = _normalize_multi_profile(settings.profile)
    profile = "balanced"
    divergence_mode = _normalize_multi_divergence_mode(settings.divergence_mode)
    soft_warn = max(1, int(settings.soft_warn_sequences or 6))
    hard_cap = max(2, int(settings.hard_cap_sequences or 10))
    max_total_bp = max(1000, int(settings.max_total_bp or 500_000))
    timeout_sec = max(30, int(settings.timeout_sec or 300))

    requested_rows = list(request.rows or [])
    excluded_rows: List[MultiAlignmentExcludedRow] = []
    warnings: List[str] = []
    if requested_profile != "balanced":
        warnings.append("Alignment profile overridden to balanced for this view.")
    prepared_rows: List[Dict[str, Any]] = []

    for idx, row in enumerate(requested_rows):
        row_genome = str(row.genome or row.genome_key or "").strip()
        row_key = str(row.genome_key or row_genome or "").strip()
        row_tag = str(row.tag or f"G{idx + 1}").strip() or f"G{idx + 1}"
        row_query = str(row.query or "").strip()
        row_tx = str(row.selected_transcript_id or row.transcript_id or "").strip()
        include = bool(row.include)

        if not row_tx and row_query:
            row_tx = _resolve_transcript_id_for_genome_query(row_genome, row_query)

        if not include:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome or row_key,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Excluded by user",
            ))
            continue
        if not row_genome:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome or row_key,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Missing genome identifier",
            ))
            continue
        if not row_tx:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="No transcript selected",
            ))
            continue

        try:
            tx = _find_transcript_for_genome(row_genome, row_tx)
        except HTTPException as e:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=str(e.detail or "Genome context not available"),
            ))
            continue
        except Exception:
            tx = None

        if tx is None:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Transcript not found for genome",
            ))
            continue

        try:
            fasta = genome_context._get_browse_fasta(row_genome)
        except HTTPException as e:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=str(e.detail or "FASTA unavailable"),
            ))
            continue

        flank_5_bp = max(0, int(row.flank_5_bp or 0))
        flank_3_bp = max(0, int(row.flank_3_bp or 0))
        use_gene_boundaries = bool(row.use_gene_boundaries)
        if use_gene_boundaries:
            gene_start, gene_end = _find_parent_gene_boundaries(row_genome, row_tx)
            if gene_start is not None and gene_end is not None:
                window_start, window_end = _interval_window_with_oriented_flanks(
                    gene_start,
                    gene_end,
                    str(tx.strand or "+"),
                    flank_5_bp,
                    flank_3_bp,
                )
            else:
                window_start, window_end = _transcript_window_with_oriented_flanks(tx, flank_5_bp, flank_3_bp)
                warnings.append(f"{row_tag}: gene boundaries unavailable, used selected transcript boundaries instead.")
        else:
            window_start, window_end = _transcript_window_with_oriented_flanks(tx, flank_5_bp, flank_3_bp)

        try:
            raw_seq, fetched_chrom, fetched_start, fetched_end = _extract_sequence_for_alignment_row(
                row_genome,
                fasta,
                tx.seq_region,
                window_start,
                window_end,
                tx.strand,
            )
        except Exception as exc:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=f"Failed to extract sequence: {exc}",
            ))
            continue

        if not raw_seq:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Extracted sequence is empty",
            ))
            continue

        prepared_rows.append({
            "genome": row_genome,
            "genome_key": row_key,
            "tag": row_tag,
            "query": row_query,
            "transcript_id": row_tx,
            "flank_5_bp": flank_5_bp,
            "flank_3_bp": flank_3_bp,
            "overlay_annotation": bool(row.overlay_annotation),
            "use_gene_boundaries": use_gene_boundaries,
            "tx": tx,
            "window_start": int(fetched_start),
            "window_end": int(fetched_end),
            "fetched_chrom": str(fetched_chrom),
            "raw_seq": raw_seq,
        })

    included_count = len(prepared_rows)
    if included_count < 2:
        return MultiAlignmentResult(
            timestamp=datetime.now().isoformat(),
            alignment_length=0,
            requested_count=len(requested_rows),
            included_count=included_count,
            profile=profile,
            strategy="none",
            consensus="",
            average_identity=0.0,
            warnings=["Need at least two resolved genomes to run alignment."],
            rows=[],
            excluded_rows=excluded_rows,
            cache_hit=False,
        )

    if included_count > hard_cap:
        raise HTTPException(
            status_code=400,
            detail=f"Requested {included_count} sequences exceeds hard cap ({hard_cap}). Increase cap in Alignment Advanced or include fewer genomes."
        )
    if included_count > soft_warn:
        warnings.append(f"Aligning {included_count} sequences may be slow on laptop hardware.")

    if excluded_rows:
        preview = ", ".join([
            f"{(r.tag or r.genome_key or r.genome)} ({r.reason})"
            for r in excluded_rows[:5]
        ])
        if len(excluded_rows) > 5:
            preview = f"{preview} +{len(excluded_rows) - 5} more"
        warnings.append(f"Excluded rows: {preview}")

    total_bp = sum(len(str(item["raw_seq"] or "")) for item in prepared_rows)
    max_len = max(len(str(item["raw_seq"] or "")) for item in prepared_rows)
    if total_bp > max_total_bp:
        raise HTTPException(
            status_code=400,
            detail=f"Total input size {total_bp}bp exceeds max_total_bp ({max_total_bp}). Increase limit or reduce flanking/genomes."
        )

    strategy, strategy_warnings, mafft_args = _choose_msa_strategy(
        profile,
        included_count,
        max_len,
        total_bp,
        strict_balanced=True,
    )
    warnings.extend(strategy_warnings)
    if divergence_mode != "auto":
        warnings.append(f"Divergence display mode preference: {divergence_mode}")

    cache_dir = _multi_alignment_cache_dir(config.get("output_dir"))
    cache_hit = False
    cache_payload = {
        "profile": profile,
        "strategy": strategy,
        # Results are cut down to the selected transcripts (see _trim_multi_to_transcripts):
        # untrimmed ones cached before that are not reused.
        "trim": "selected_transcripts",
        "settings": {
            "soft_warn_sequences": soft_warn,
            "hard_cap_sequences": hard_cap,
            "max_total_bp": max_total_bp,
            "timeout_sec": timeout_sec,
            "divergence_mode": divergence_mode,
        },
        "rows": [
            {
                "genome": item["genome"],
                "genome_key": item["genome_key"],
                "tag": item["tag"],
                "transcript_id": item["transcript_id"],
                "flank_5_bp": item["flank_5_bp"],
                "flank_3_bp": item["flank_3_bp"],
                "overlay_annotation": item["overlay_annotation"],
                "use_gene_boundaries": item["use_gene_boundaries"],
                "raw_seq_hash": hashlib.md5(str(item["raw_seq"]).encode("utf-8")).hexdigest(),
            }
            for item in prepared_rows
        ],
    }
    cache_path: Optional[Path] = None
    if cache_dir:
        cache_key = _stable_json_hash(cache_payload)
        cache_path = cache_dir / f"{cache_key}.json"
        if cache_path.exists():
            try:
                with cache_path.open("r") as f:
                    data = json.load(f)
                cached = MultiAlignmentResult(**data)
                return cached.model_copy(update={"cache_hit": True})
            except Exception:
                cache_hit = False

    # An alignment another view (the Gene Trees') already made of exactly these rows.
    shared_store = _shared_alignment_store(config.get("output_dir"))
    shared_rows = None
    if shared_store is not None:
        try:
            shared_rows = _msa_shared_rows(prepared_rows)
            stem = shared_store.find_covering([r["signature"] for r in shared_rows]) if shared_rows else None
            reused = _msa_result_from_store(shared_store, stem, prepared_rows, shared_rows, requested_rows,
                                            excluded_rows, warnings, profile) if stem else None
            if reused is not None:
                return _trim_multi_to_transcripts(reused, prepared_rows)
        except Exception:
            logger.warning("Could not look in the shared alignments folder", exc_info=True)

    ordered_sequences: List[Tuple[str, str]] = []
    seq_id_to_row: Dict[str, Dict[str, Any]] = {}
    for idx, item in enumerate(prepared_rows):
        seq_id = f"row{idx + 1}_{re.sub(r'[^A-Za-z0-9_.-]', '_', str(item['tag']))}"
        ordered_sequences.append((seq_id, str(item["raw_seq"])))
        seq_id_to_row[seq_id] = item

    started = time.time()
    try:
        aligned_map = run_mafft_alignment_multi(ordered_sequences, mafft_args, timeout_sec=timeout_sec)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MSA failed: {e}")
    elapsed = time.time() - started
    warnings.append(f"MSA completed in {elapsed:.1f}s using {strategy} strategy.")

    ordered_aligned_rows: List[Tuple[Dict[str, Any], str]] = []
    for seq_id, _ in ordered_sequences:
        aligned_seq = str(aligned_map.get(seq_id) or "")
        if not aligned_seq:
            continue
        ordered_aligned_rows.append((seq_id_to_row[seq_id], aligned_seq))

    if len(ordered_aligned_rows) < 2:
        raise HTTPException(status_code=500, detail="MSA returned fewer than two aligned sequences.")

    aligned_seqs = [aligned_seq for _, aligned_seq in ordered_aligned_rows]
    consensus = _build_consensus_from_aligned_rows(aligned_seqs)
    alignment_length = len(consensus)

    row_results: List[MultiAlignedRow] = []
    identity_values: List[float] = []
    for item, aligned_seq in ordered_aligned_rows:
        features: List[Feature] = []
        if bool(item["overlay_annotation"]):
            try:
                features = map_features_to_alignment(
                    item["tx"],
                    int(item["window_start"]),
                    int(item["window_end"]),
                    aligned_seq,
                    str(item["tx"].strand or "+"),
                    str(item["raw_seq"] or ""),
                )
            except Exception:
                features = []
        ident = _identity_to_consensus(aligned_seq, consensus)
        gap_frac = _gap_fraction(aligned_seq)
        identity_values.append(ident)
        row_results.append(MultiAlignedRow(
            genome=str(item["genome"] or ""),
            genome_key=str(item["genome_key"] or ""),
            tag=str(item["tag"] or ""),
            query=str(item["query"] or ""),
            transcript_id=str(item["transcript_id"] or ""),
            # Preserve feature mapping from transcript model, but report
            # the effective chromosome used for sequence extraction when aliased.
            chrom=str(item.get("fetched_chrom") or item["tx"].seq_region or ""),
            genomic_start=int(item["window_start"]),
            genomic_end=int(item["window_end"]),
            strand=str(item["tx"].strand or "+"),
            aligned_sequence=aligned_seq,
            raw_length=len(str(item["raw_seq"] or "")),
            flank_5_bp=int(item["flank_5_bp"]),
            flank_3_bp=int(item["flank_3_bp"]),
            overlay_annotation=bool(item["overlay_annotation"]),
            use_gene_boundaries=bool(item.get("use_gene_boundaries", True)),
            features=features,
            identity_to_consensus=ident,
            gap_fraction=gap_frac,
        ))

    avg_identity = float(sum(identity_values) / max(1, len(identity_values)))
    result = MultiAlignmentResult(
        timestamp=datetime.now().isoformat(),
        alignment_length=alignment_length,
        requested_count=len(requested_rows),
        included_count=len(row_results),
        profile=profile,
        strategy=strategy,
        consensus=consensus,
        average_identity=avg_identity,
        warnings=warnings,
        rows=row_results,
        excluded_rows=excluded_rows,
        cache_hit=cache_hit,
    )
    result = _trim_multi_to_transcripts(result, prepared_rows)

    if cache_path:
        try:
            with cache_path.open("w") as f:
                json.dump(result.model_dump(), f)
        except Exception:
            pass
    if shared_store is not None and shared_rows:
        try:
            _msa_save_shared(shared_store, prepared_rows, shared_rows, ordered_aligned_rows, strategy, consensus)
        except Exception:
            logger.warning("Could not keep the alignment in the shared folder", exc_info=True)

    return result


@app.get("/api/align/check")
def check_alignment_status(
    transcript_id: str, 
    ref_flank: int, 
    tgt_flank: int,
    target_transcript_id: Optional[str] = None
):
    """Check if a compatible alignment exists in cache."""
    config = config_store.load_config()
    output_dir = config.get("output_dir")
    
    tgt_id = target_transcript_id or transcript_id
    
    path, _, _ = find_compatible_cache(output_dir, transcript_id, tgt_id, ref_flank, tgt_flank)
    
    if path:
        return {"status": "found", "type": "Load alignment"}
    else:
        return {"status": "missing", "type": "Run alignment"}


# ── Saved-alignment persistence ────────────────────────────────────────────────

def _alignments_dir(output_dir: str) -> Path:
    """Returns the directory used to persist named alignment files."""
    return Path(output_dir).expanduser().resolve() / "local_data" / "alignments"


def _safe_alignment_name(name: str) -> str:
    """Sanitise alignment name: keep alphanumerics, hyphens, underscores, dots."""
    import re as _re
    cleaned = _re.sub(r"[^\w\-.]", "_", name.strip())
    return cleaned[:200] or "alignment"


class AlignmentSaveGenomeInfo(BaseModel):
    genome_key: str
    species_key: str = ""
    assembly: str = ""
    assembly_name: str = ""
    scientific_name: str = ""
    common_name: str = ""
    gene_symbol: str = ""
    gene_id: str = ""
    transcript_id: str = ""
    tag: str = ""
    chrom: str = ""
    genomic_start: int = 0
    genomic_end: int = 0
    strand: str = "+"
    raw_length: int = 0
    flank_5_bp: int = 0
    flank_3_bp: int = 0
    use_gene_boundaries: bool = True
    identity_to_consensus: float = 0.0
    gap_fraction: float = 0.0
    features: List[Any] = []


class SaveAlignmentRequest(BaseModel):
    name: str
    output_dir: str
    genomes: List[AlignmentSaveGenomeInfo]
    aligned_sequences: Dict[str, str]   # genome_key → gapped aligned sequence
    stats: Dict[str, Any] = {}
    consensus: str = ""


class LoadAlignmentRequest(BaseModel):
    name: str
    output_dir: str
    genome_keys: List[str]              # which genomes to reconstruct


@app.post("/api/alignments/save")
def save_alignment(payload: SaveAlignmentRequest):
    """Persist a multi-alignment to local_data/alignments/ as a FASTA + JSON pair."""
    if not payload.output_dir or not os.path.exists(payload.output_dir):
        raise HTTPException(status_code=400, detail="output_dir is not set or does not exist")

    name = _safe_alignment_name(payload.name)
    aln_dir = _alignments_dir(payload.output_dir)
    try:
        aln_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot create alignments directory: {exc}")

    fasta_path = aln_dir / f"{name}.fasta"
    meta_path  = aln_dir / f"{name}.json"

    # Write FASTA (gapped aligned sequences)
    try:
        with open(fasta_path, "w") as fh:
            for genome in payload.genomes:
                seq = payload.aligned_sequences.get(genome.genome_key, "")
                if seq:
                    fh.write(f">{genome.genome_key}\n")
                    # Wrap at 60 chars
                    for i in range(0, len(seq), 60):
                        fh.write(seq[i:i+60] + "\n")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot write FASTA: {exc}")

    # Write JSON metadata
    meta = {
        "version": "1",
        "name": name,
        "created": datetime.utcnow().isoformat() + "Z",
        "fasta_file": fasta_path.name,
        "stats": payload.stats,
        "consensus": payload.consensus,
        "genomes": [g.model_dump() for g in payload.genomes],
    }
    try:
        with open(meta_path, "w") as fh:
            json.dump(meta, fh, indent=2)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot write metadata: {exc}")

    return {
        "status": "ok",
        "name": name,
        "fasta_path": str(fasta_path),
        "meta_path": str(meta_path),
    }


@app.get("/api/alignments/list")
def list_alignments(output_dir: str = ""):
    """List saved alignments in local_data/alignments/, newest first."""
    if not output_dir or not os.path.exists(output_dir):
        return {"alignments": []}

    aln_dir = _alignments_dir(output_dir)
    if not aln_dir.exists():
        return {"alignments": []}

    results = []
    for meta_file in sorted(aln_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with open(meta_file) as fh:
                meta = json.load(fh)
            if meta.get("auto"):
                continue  # kept by the views as a cache, not saved by the user
            # Return all fields except the per-genome features arrays (too large)
            slim_genomes = []
            for g in meta.get("genomes", []):
                entry = {k: v for k, v in g.items() if k != "features"}
                slim_genomes.append(entry)
            results.append({
                **{k: v for k, v in meta.items() if k not in ("genomes", "consensus")},
                "genomes": slim_genomes,
                "genome_keys": [g.get("genome_key", "") for g in slim_genomes],
                "file_stem": meta_file.stem,
            })
        except Exception:
            pass  # Skip corrupt files

    return {"alignments": results}


@app.post("/api/alignments/load")
def load_alignment(payload: LoadAlignmentRequest):
    """Reconstruct a MultiAlignmentResult from a saved alignment, filtered to genome_keys.

    On a worker thread: rebuilding a stored alignment is blocking work, and a large
    one is not quick.
    """
    if not payload.output_dir or not os.path.exists(payload.output_dir):
        raise HTTPException(status_code=400, detail="output_dir is not set or does not exist")

    name = _safe_alignment_name(payload.name)
    aln_dir = _alignments_dir(payload.output_dir)
    meta_path  = aln_dir / f"{name}.json"
    fasta_path = aln_dir / f"{name}.fasta"

    if not meta_path.exists():
        raise HTTPException(status_code=404, detail=f"Alignment '{name}' not found")

    try:
        with open(meta_path) as fh:
            meta = json.load(fh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read metadata: {exc}")

    # Parse FASTA → {genome_key: aligned_sequence}
    sequences: Dict[str, str] = {}
    if fasta_path.exists():
        try:
            current_key = None
            buf: List[str] = []
            with open(fasta_path) as fh:
                for line in fh:
                    line = line.rstrip("\n")
                    if line.startswith(">"):
                        if current_key is not None:
                            sequences[current_key] = "".join(buf)
                        current_key = line[1:].strip()
                        buf = []
                    else:
                        buf.append(line)
            if current_key is not None:
                sequences[current_key] = "".join(buf)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Cannot read FASTA: {exc}")

    all_genome_meta = {g["genome_key"]: g for g in meta.get("genomes", [])}

    # Filter to requested genomes that exist in the file
    selected_keys = [k for k in payload.genome_keys if k in all_genome_meta and k in sequences]
    excluded_count = len(all_genome_meta) - len(selected_keys)

    if len(selected_keys) < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 genomes; only {len(selected_keys)} found in file for the requested set."
        )

    # Recalculate consensus and stats for the selected subset
    selected_seqs = [sequences[k] for k in selected_keys]
    consensus = _build_consensus_from_aligned_rows(selected_seqs)

    rows_out = []
    for k in selected_keys:
        gm = all_genome_meta[k]
        seq = sequences[k]
        identity = _identity_to_consensus(seq, consensus)
        gap_frac  = _gap_fraction(seq)
        rows_out.append({
            "genome": gm.get("genome_key", k),
            "genome_key": gm.get("genome_key", k),
            "tag": gm.get("tag", ""),
            "query": gm.get("gene_symbol") or gm.get("gene_id") or gm.get("transcript_id", ""),
            "transcript_id": gm.get("transcript_id", ""),
            "chrom": gm.get("chrom", ""),
            "genomic_start": gm.get("genomic_start", 0),
            "genomic_end": gm.get("genomic_end", 0),
            "strand": gm.get("strand", "+"),
            "aligned_sequence": seq,
            "raw_length": gm.get("raw_length", 0),
            "flank_5_bp": gm.get("flank_5_bp", 0),
            "flank_3_bp": gm.get("flank_3_bp", 0),
            "use_gene_boundaries": gm.get("use_gene_boundaries", True),
            "overlay_annotation": True,
            "features": gm.get("features", []),
            "identity_to_consensus": round(identity, 4),
            "gap_fraction": round(gap_frac, 6),
        })

    avg_identity = (
        sum(r["identity_to_consensus"] for r in rows_out) / len(rows_out)
        if rows_out else 0.0
    )
    saved_stats = meta.get("stats", {})
    aln_len = len(selected_seqs[0]) if selected_seqs else 0

    result = {
        "timestamp": meta.get("created", datetime.utcnow().isoformat() + "Z"),
        "alignment_length": aln_len,
        "requested_count": len(payload.genome_keys),
        "included_count": len(rows_out),
        "profile": saved_stats.get("profile", "balanced"),
        "strategy": saved_stats.get("strategy", "loaded"),
        "consensus": consensus,
        "average_identity": round(avg_identity, 4),
        "warnings": [],
        "rows": rows_out,
        "excluded_rows": [],
        "cache_hit": False,
        "loaded_from_file": name,
        "excluded_count": excluded_count,
    }
    return result


@app.get("/api/recent", response_model=List[RecentItem])
async def get_recent():
    return recent_transcripts


@app.post("/api/recent/clear")
async def clear_recent():
    """Clear the recent transcripts history."""
    recent_transcripts.clear()
    return {"status": "ok", "message": "Recent transcripts cleared"}


@app.get("/api/remote/local-files")
def check_local_files(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    dataset_release_key: str = "",
):
    """Check which file types already exist in local_data for a species/assembly."""
    local_dir = data_paths._resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
    found: List[str] = []
    scanned: Dict[str, Any] = {}
    if local_dir.is_dir():
        scanned = local_inventory._scan_local_assembly(local_dir, assembly)
        found.extend(scanned.get("assembly_types") or [])
        target_release_key = dataset_release_key or str(scanned.get("default_dataset_release_key") or scanned.get("active_dataset_release_key") or "")
        for release in scanned.get("dataset_releases") or []:
            if not target_release_key or release.get("key") == target_release_key:
                found.extend(release.get("types") or [])
    return {
        "types": sorted(set(found)),
        "dataset_release_key": dataset_release_key or "",
        "active_dataset_release_key": scanned.get("active_dataset_release_key") or "",
        "default_dataset_release_key": scanned.get("default_dataset_release_key") or "",
        "files": scanned.get("files") or {},
        "assembly_files": scanned.get("assembly_files") or {},
        "assembly_types": scanned.get("assembly_types") or [],
        "dataset_releases": scanned.get("dataset_releases") or [],
    }


app.get("/api/remote/local-assemblies")(local_inventory.list_local_assemblies)


class DeleteLocalFilesRequest(BaseModel):
    output_dir: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    dataset_release_key: str = ""


@app.delete("/api/remote/local-files")
def delete_local_files(request: DeleteLocalFilesRequest):
    """Delete downloaded local files for a species/assembly."""
    provider = normalize_provider(request.provider)
    asm_dir = data_paths._resolve_species_assembly_dir(request.output_dir, request.species_key, request.assembly, provider=provider)
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")
    manifest = local_inventory._load_genome_manifest(asm_dir, request.assembly)
    local_root = data_paths._resolve_local_data_root(request.output_dir)
    if request.dataset_release_key:
        source, date, release_key = routes.downloads._dataset_release_parts(
            provider,
            "gff3",
            release_key=request.dataset_release_key,
        )
        release_dir = asm_dir / "datasets" / source / date
        legacy_release = release_key == local_inventory.LEGACY_DATASET_RELEASE_KEY
        deletable, user_supplied = local_inventory._downloaded_assembly_files(
            asm_dir,
            request.assembly,
            manifest,
            release_dir=None if legacy_release else release_dir,
            legacy_release=legacy_release,
            dataset_release_key=release_key,
        )
        if not deletable:
            if user_supplied:
                raise HTTPException(status_code=400, detail=local_inventory._CUSTOM_FILES_DELETE_DETAIL)
            if not release_dir.is_dir():
                raise HTTPException(status_code=404, detail="Dataset release directory not found")
        deleted_count = routes.downloads._unlink_files(deletable)
        releases = manifest.get("dataset_releases")
        if isinstance(releases, dict):
            releases.pop(release_key, None)
            if manifest.get("active_dataset_release_key") == release_key:
                manifest["active_dataset_release_key"] = next(iter(releases.keys()), "")
            routes.downloads._write_genome_manifest(asm_dir, manifest)
        routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
        return {"status": "deleted", "species_key": request.species_key, "assembly": request.assembly, "dataset_release_key": release_key, "deleted_files": deleted_count}

    deletable, user_supplied = local_inventory._downloaded_assembly_files(asm_dir, request.assembly, manifest)
    if not deletable:
        if user_supplied:
            raise HTTPException(status_code=400, detail=local_inventory._CUSTOM_FILES_DELETE_DETAIL)
        raise HTTPException(status_code=404, detail="No downloaded files found for this assembly")
    deleted_count = routes.downloads._unlink_files(deletable)
    # The manifest describes what is left; drop it only when nothing is.
    manifest_path = asm_dir / genome_manifest_filename(request.assembly)
    if manifest_path.exists() and not user_supplied:
        try:
            manifest_path.unlink()
        except Exception:
            pass
    routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
    # Remove stale download task history for this species/assembly so UI does not
    # continue showing old completed/failed badges after files were deleted.
    remove_task_ids = [
        task_id
        for task_id, task in list(app_state.download_manager.tasks.items())
        if str(task.species_key or "") == str(request.species_key or "")
        and str(task.assembly or "") == str(request.assembly or "")
        and normalize_provider(task.provider) == provider
    ]
    for task_id in remove_task_ids:
        app_state.download_manager.tasks.pop(task_id, None)
    routes.achievements._record_deletion_achievement(
        build_provider_aware_genome_key(request.species_key, request.assembly, provider),
        request.output_dir,
    )
    return {"status": "deleted", "species_key": request.species_key, "assembly": request.assembly, "deleted_files": deleted_count}


class DeleteSingleFileRequest(BaseModel):
    file_path: str
    output_dir: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER


@app.delete("/api/remote/local-file")
async def delete_single_local_file(request: DeleteSingleFileRequest):
    """Delete a single local file from a managed species/assembly directory."""
    asm_dir = data_paths._resolve_species_assembly_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider=normalize_provider(request.provider),
    )
    path = require_path_within(asm_dir, Path(request.file_path))
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    path.unlink()
    return {"deleted": str(path)}


# ── genome removal: preview then delete ───────────────────────────────────────
#
# Deleting a genome's data has to answer for two very different layouts. A
# downloaded genome owns a directory under local_data, so the question is which
# of its files we put there (see _downloaded_assembly_files). A manually added
# genome owns nothing: its FASTA and annotation are the user's, sitting wherever
# they chose, with our index, sidecars and converted annotation written beside
# them. backend/removal_rules.py holds those rules, each with a proof.
#
# Both endpoints run the same planner. The preview never writes, and the delete
# re-derives the plan rather than trusting the paths the client sends back.


class GenomeRemovalDescriptor(BaseModel):
    genome_key: str = ""
    species_key: str = ""
    assembly: str = ""
    provider: str = DEFAULT_PROVIDER
    is_manual: bool = False


class GenomeRemovalRequest(BaseModel):
    output_dir: str = ""
    genomes: List[GenomeRemovalDescriptor] = []
    plan_token: str = ""


def _manual_species_entries(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    cfg = config if isinstance(config, dict) else config_store.load_config()
    entries = cfg.get("manual_species") or []
    return [entry for entry in entries if isinstance(entry, dict)]


def _genome_descriptor_keys(descriptor: "GenomeRemovalDescriptor") -> Set[str]:
    """Every key form a stored genome record might carry for this descriptor."""
    keys: Set[str] = set()
    for value in (descriptor.genome_key,):
        text = str(value or "").strip()
        if text:
            keys.add(text)
            keys.add(strip_dataset_release_from_selection_key(text))
    provider = normalize_provider(descriptor.provider)
    species_key = str(descriptor.species_key or "").strip()
    assembly = str(descriptor.assembly or "").strip()
    if species_key and assembly:
        keys.add(build_provider_aware_genome_key(species_key, assembly, provider, descriptor.is_manual))
        keys.add(legacy_genome_key(species_key, assembly))
    return {key for key in keys if key}


def _find_manual_entry(
    descriptor: "GenomeRemovalDescriptor",
    entries: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    wanted = _genome_descriptor_keys(descriptor)
    species_key = str(descriptor.species_key or "").strip().lower()
    assembly = str(descriptor.assembly or "").strip().lower()
    for entry in entries:
        candidates = {
            str(entry.get("selection_key") or "").strip(),
            str(entry.get("assembly_key") or "").strip(),
            str(entry.get("key") or "").strip(),
            build_provider_aware_genome_key(
                entry.get("species_key"),
                entry.get("assembly") or entry.get("gca"),
                entry.get("provider"),
                bool(entry.get("is_manual", True)),
            ),
            legacy_genome_key(entry.get("species_key"), entry.get("assembly") or entry.get("gca")),
        }
        if wanted & {candidate for candidate in candidates if candidate}:
            return entry
        if (
            species_key
            and assembly
            and str(entry.get("species_key") or "").strip().lower() == species_key
            and str(entry.get("assembly") or entry.get("gca") or "").strip().lower() == assembly
        ):
            return entry
    return None


def _plan_downloaded_removal(
    descriptor: "GenomeRemovalDescriptor",
    output_dir: str,
    plan: removal_rules.RemovalPlan,
) -> None:
    """Add a download-managed assembly directory's files to *plan*."""
    try:
        asm_dir = data_paths._resolve_species_assembly_dir(
            output_dir,
            descriptor.species_key,
            descriptor.assembly,
            provider=normalize_provider(descriptor.provider),
        )
    except HTTPException:
        raise
    except Exception:
        return
    if not asm_dir.is_dir():
        return

    manifest = local_inventory._load_genome_manifest(asm_dir, descriptor.assembly)
    deletable, user_supplied = local_inventory._downloaded_assembly_files(asm_dir, descriptor.assembly, manifest)
    for path in deletable:
        plan.add(path, "downloaded")

    # A custom annotation import copies the user's file into the managed
    # directory and records where it came from. The copy is ours to delete; the
    # original never is, so it is named here rather than silently kept.
    custom_sources = {
        str(record.get("source_path") or "").strip()
        for record in local_inventory._download_manifest_file_records(manifest)
        if str(record.get("source_path") or "").strip()
    }
    for path in user_supplied:
        parts = path.relative_to(asm_dir).parts
        if parts[:2] == ("datasets", "custom"):
            plan.add(path, "app_copy")
        else:
            plan.protect(path, local_inventory._CUSTOM_FILES_DELETE_DETAIL)
    for source in sorted(custom_sources):
        plan.protect(source, "the annotation you imported, left where you put it")

    manifest_path = asm_dir / genome_manifest_filename(descriptor.assembly)
    if manifest_path.is_file():
        plan.add(manifest_path, "manifest")

    # Attached track hubs are the user's doing and can be large; they are left
    # alone, but the dialog should say so rather than leave a surprise directory.
    hub_dir = asm_dir / "trackhub"
    if hub_dir.is_dir():
        plan.left_in_place.append({
            "path": str(hub_dir),
            "reason": "attached track hub files stay on disk",
            # Do not recursively size a directory we are not deleting. Large
            # attached hubs made a simple removal preview appear to hang.
            "bytes": 0,
        })


def _plan_genome_removal(
    descriptor: "GenomeRemovalDescriptor",
    output_dir: str,
    manual_entries: List[Dict[str, Any]],
    foreign_seeds: Set[Path],
) -> removal_rules.RemovalPlan:
    """What removing one genome would delete.

    A genome can be both downloaded and manually registered (a bundle registered
    after a download), so both planners run and their results merge. Every rule
    is a whitelist, so a union stays safe.
    """
    plan = removal_rules.RemovalPlan(genome_key=str(descriptor.genome_key or ""))
    _plan_downloaded_removal(descriptor, output_dir, plan)

    entry = _find_manual_entry(descriptor, manual_entries)
    if entry is not None:
        files = entry.get("files") or {}
        gff_path = str(files.get("gff3") or "")
        manual_plan = removal_rules.plan_manual_genome_removal(
            entry,
            output_dir=output_dir,
            cache_root=app_paths.CACHE_DIR,
            foreign_seeds=foreign_seeds,
            index_basename=gff_index._index_basename_for_annotation(gff_path) if gff_path else "genome.gff3.index.db",
            genome_key=plan.genome_key,
        )
        for candidate in manual_plan.deletable:
            plan.add(Path(candidate.path), candidate.kind)
        for protected in manual_plan.protected:
            plan.protect(protected.get("path"), str(protected.get("reason") or ""))
        plan.notes.extend(note for note in manual_plan.notes if note not in plan.notes)

    # Never delete something another genome still points at.
    own_seeds = removal_rules.collect_seed_paths([entry] if entry else [])
    keep = {path for path in foreign_seeds if path not in own_seeds}
    if keep:
        filtered = []
        for candidate in plan.deletable:
            if Path(candidate.path) in keep:
                plan.protect(candidate.path, "another genome uses this file")
                continue
            filtered.append(candidate)
        plan.deletable = filtered
    return plan


def _build_removal_plans(request: "GenomeRemovalRequest") -> List[removal_rules.RemovalPlan]:
    config = config_store.load_config()
    output_dir = str(request.output_dir or config.get("output_dir") or "").strip()
    manual_entries = _manual_species_entries(config)
    # Seeds of every genome still registered, so removing one never breaks
    # another that shares a directory or a FASTA.
    requested_keys: Set[str] = set()
    for descriptor in request.genomes:
        requested_keys |= _genome_descriptor_keys(descriptor)

    def _is_being_removed(entry: Dict[str, Any]) -> bool:
        entry_keys = {
            str(entry.get("selection_key") or "").strip(),
            str(entry.get("assembly_key") or "").strip(),
            str(entry.get("key") or "").strip(),
            build_provider_aware_genome_key(
                entry.get("species_key"),
                entry.get("assembly") or entry.get("gca"),
                entry.get("provider"),
                bool(entry.get("is_manual")),
            ),
            legacy_genome_key(entry.get("species_key"), entry.get("assembly") or entry.get("gca")),
        }
        return bool(requested_keys & {key for key in entry_keys if key})

    # Both lists are filtered: a genome being removed is usually also the one
    # selected, and treating its own files as another genome's would leave its
    # artifacts behind.
    keep_entries = [
        entry
        for entry in list(manual_entries) + [
            item for item in (config.get("active_species") or []) if isinstance(item, dict)
        ]
        if not _is_being_removed(entry)
    ]
    foreign_seeds = removal_rules.collect_seed_paths(keep_entries)

    plans: List[removal_rules.RemovalPlan] = []
    for descriptor in request.genomes:
        plans.append(_plan_genome_removal(descriptor, output_dir, manual_entries, foreign_seeds))
    return plans


@app.post("/api/genomes/removal-preview")
async def preview_genome_removal(request: GenomeRemovalRequest):
    """List what deleting these genomes' data would remove. Writes nothing."""
    if not request.genomes:
        raise HTTPException(status_code=400, detail="genomes must not be empty")
    if len(request.genomes) > 500:
        raise HTTPException(status_code=400, detail="genome limit exceeded (max 500)")

    def _work():
        plans = _build_removal_plans(request)
        return {
            "plans": [plan.as_dict() for plan in plans],
            "plan_token": removal_rules.plan_token(plans),
            "totals": {
                "genomes": len(plans),
                "files": sum(len(plan.deletable) for plan in plans),
                "bytes": sum(plan.total_bytes for plan in plans),
                "protected": sum(len(plan.protected) for plan in plans),
            },
        }

    return await run_in_threadpool(_work)


@app.post("/api/genomes/remove-data")
async def remove_genome_data(request: GenomeRemovalRequest):
    """Delete the files a preview listed, reporting per-genome results.

    Returns 200 even when some files could not be removed: a batch that stops at
    the first failure leaves the rest of the user's selection silently untouched.
    """
    if not request.genomes:
        raise HTTPException(status_code=400, detail="genomes must not be empty")
    if len(request.genomes) > 500:
        raise HTTPException(status_code=400, detail="genome limit exceeded (max 500)")

    def _work():
        plans = _build_removal_plans(request)
        token = removal_rules.plan_token(plans)
        if request.plan_token and request.plan_token != token:
            raise HTTPException(
                status_code=409,
                detail="The files on disk changed since this was previewed. Review the removal again.",
            )

        config = config_store.load_config()
        output_dir = str(request.output_dir or config.get("output_dir") or "").strip()
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None

        results: List[Dict[str, Any]] = []
        for descriptor, plan in zip(request.genomes, plans):
            paths: List[str] = []
            skipped: List[Dict[str, str]] = []
            for candidate in plan.deletable:
                if candidate.kind == "index_db" and removal_rules.is_index_lock_held(candidate.path):
                    skipped.append({"path": candidate.path, "error": "an index build is using this file"})
                    continue
                paths.append(candidate.path)

            freed = sum(item.bytes for item in plan.deletable if item.path in set(paths))
            deleted, failed = removal_rules.unlink_paths(paths)
            failed.extend(skipped)

            try:
                asm_dir = data_paths._resolve_species_assembly_dir(
                    output_dir,
                    descriptor.species_key,
                    descriptor.assembly,
                    provider=normalize_provider(descriptor.provider),
                )
                if local_root is not None and asm_dir.is_dir():
                    routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
            except Exception:
                pass

            if not plan.deletable:
                status = "nothing_to_delete"
            elif failed and deleted:
                status = "partial"
            elif failed:
                status = "failed"
            else:
                status = "deleted"
            if status in {"deleted", "partial"} and not descriptor.is_manual:
                routes.achievements._record_deletion_achievement(
                    build_provider_aware_genome_key(descriptor.species_key, descriptor.assembly, descriptor.provider)
                    or plan.genome_key or descriptor.genome_key,
                    output_dir,
                )
            results.append({
                "genome_key": plan.genome_key or descriptor.genome_key,
                "status": status,
                "deleted": deleted,
                "failed": failed,
                "protected": plan.protected,
                "freed_bytes": freed if status in {"deleted", "partial"} else 0,
            })

        # Stale download badges for a genome whose files are gone.
        removed_pairs = {
            (str(descriptor.species_key or ""), str(descriptor.assembly or ""), normalize_provider(descriptor.provider))
            for descriptor in request.genomes
        }
        for task_id, task in list(app_state.download_manager.tasks.items()):
            key = (str(task.species_key or ""), str(task.assembly or ""), normalize_provider(task.provider))
            if key in removed_pairs:
                app_state.download_manager.tasks.pop(task_id, None)

        return {
            "results": results,
            "totals": {
                "genomes": len(results),
                "deleted": sum(len(item["deleted"]) for item in results),
                "failed": sum(len(item["failed"]) for item in results),
                "bytes": sum(int(item["freed_bytes"]) for item in results),
            },
        }

    return await run_in_threadpool(_work)


# ============ Stats API ============

class StatsGenomeInput(BaseModel):
    selection_key: str = ""
    assembly_key: str = ""
    species_key: str = ""
    assembly: str = ""
    assembly_name: str = ""
    scientific_name: str = ""
    common_name: str = ""
    provider: str = DEFAULT_PROVIDER
    source_database: str = ""
    gca: str = ""
    dataset_release_key: str = ""
    dataset_release_source: str = ""
    dataset_release_date: str = ""
    dataset_release_label: str = ""
    dataset_release_short_label: str = ""
    # Carried so assembly metadata can be looked up under the GCA a RefSeq
    # genome is equivalent to; ENA has no record of a GCF accession.
    equivalent_accessions: List[str] = []
    files: Dict[str, str] = {}


class StatsSummaryRequest(BaseModel):
    genomes: List[StatsGenomeInput] = []
    sections: Optional[List[str]] = None
    structural_profile: Optional[str] = STRUCTURAL_PROFILE


class StructuralStatsGenerateRequest(BaseModel):
    genomes: List[StatsGenomeInput] = []
    genome_keys: List[str] = []
    force: bool = False
    structural_profile: Optional[str] = STRUCTURAL_PROFILE


class StructuralStatsCancelRequest(BaseModel):
    task_id: str = ""
    genome_key: str = ""


class StatsTaskRecord(BaseModel):
    id: str
    status: str
    created_at: str
    updated_at: str
    progress: float
    message: str
    genome_keys: List[str] = []
    results: Dict[str, Any] = {}


def _normalize_stats_sections(raw_sections: Optional[List[str]]) -> List[str]:
    allowed = set(_STATS_DEFAULT_SECTIONS)
    if not raw_sections:
        return list(_STATS_DEFAULT_SECTIONS)
    out = []
    seen = set()
    for section in raw_sections:
        value = str(section or "").strip().lower()
        if value in allowed and value not in seen:
            seen.add(value)
            out.append(value)
    return out or list(_STATS_DEFAULT_SECTIONS)


def _read_stats_task(task_id: str) -> Optional[Dict[str, Any]]:
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id)
        if task is None:
            return None
        return json.loads(json.dumps(task))


def _list_stats_tasks() -> List[Dict[str, Any]]:
    with _stats_tasks_guard:
        tasks = [json.loads(json.dumps(task)) for task in _stats_tasks.values()]
    tasks.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
    return tasks


def _update_stats_task(task_id: str, **changes):
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id)
        if task is None:
            return
        task.update(changes)
        task["updated_at"] = now_iso()


def _update_stats_task_result(
    task_id: str,
    genome_key_value: str,
    payload: Dict[str, Any],
    mark_complete: bool = False,
):
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id)
        if task is None:
            return
        results = task.setdefault("results", {})
        prev_status = str((results.get(genome_key_value) or {}).get("status") or "")
        next_status = str((payload or {}).get("status") or "")
        results[genome_key_value] = payload

        terminal_transition = (
            next_status in _STRUCTURAL_TASK_TERMINAL_STATUSES
            and prev_status not in _STRUCTURAL_TASK_TERMINAL_STATUSES
        )
        if mark_complete or terminal_transition:
            task["completed"] = int(task.get("completed", 0)) + 1
        total = max(1, int(task.get("total", 1)))
        # Count the genome still running by how far it has got, so moving it on to
        # its next pass does not drop the task back to its finished genomes alone.
        running = sum(
            float(r.get("progress") or 0.0)
            for r in results.values()
            if str((r or {}).get("status") or "") == "running"
        )
        task["progress"] = min(1.0, (float(task.get("completed", 0)) + running) / total)
        task["updated_at"] = now_iso()


# A genome's structural run is two passes over its canonical coding transcripts: a
# quick one over the annotation alone, then one that reads the genome sequence to check
# every CDS and splice site, which takes about three times as long. Progress is split
# between them in that proportion so the bar moves at a steady rate.
_STRUCTURAL_QUICK_PASS_SHARE = 0.25
_STRUCTURAL_QUICK_PASS_MESSAGE = "Measuring exons, introns, CDS and UTRs"
_STRUCTURAL_SEQUENCE_PASS_MESSAGE = "Checking CDS and splice sites against the genome sequence"


class _StructuralRunCancelled(Exception):
    """Raised from a progress report to stop a pass the user has cancelled."""


def _set_stats_task_genome_progress(task_id: str, genome_key_value: str, fraction: float, message: str):
    """Record how far one genome's run has got, and the task's progress with it."""
    fraction = max(0.0, min(1.0, float(fraction)))
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id)
        if task is None:
            return
        result = task.setdefault("results", {}).setdefault(genome_key_value, {})
        result["progress"] = fraction
        result["message"] = message
        total = max(1, int(task.get("total", 1)))
        task["progress"] = min(1.0, (int(task.get("completed", 0)) + fraction) / total)
        task["message"] = message
        task["updated_at"] = now_iso()


def _structural_progress_reporter(task_id: str, genome_key_value: str, start: float, share: float, message: str):
    """An ``on_progress`` for ``compute_structural_stats`` covering one pass."""
    def report(done: int, total: int):
        if _is_task_genome_cancelled(task_id, genome_key_value):
            raise _StructuralRunCancelled()
        pass_fraction = (float(done) / total) if total else 1.0
        _set_stats_task_genome_progress(task_id, genome_key_value, start + (share * pass_fraction), message)
    return report


def _is_task_genome_cancelled(task_id: str, genome_key_value: str) -> bool:
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id) or {}
        cancelled = set(task.get("cancelled_genome_keys") or [])
        return genome_key_value in cancelled


def _cancel_stats_task_genome(task_id: str, genome_key_value: str) -> bool:
    with _stats_tasks_guard:
        task = _stats_tasks.get(task_id)
        if task is None:
            return False
        if str(task.get("task_type") or "") != "structural":
            return False
        if str(task.get("status") or "") not in {"queued", "running"}:
            return False
        if genome_key_value not in (task.get("genome_keys") or []):
            return False

        cancelled = set(task.get("cancelled_genome_keys") or [])
        cancelled.add(genome_key_value)
        task["cancelled_genome_keys"] = sorted(cancelled)

        result = (task.setdefault("results", {}).get(genome_key_value) or {})
        result_status = str(result.get("status") or "")
        if result_status in {"queued", ""}:
            task["results"][genome_key_value] = {
                "status": "canceled",
                "message": "Canceled by user.",
            }
            total = max(1, int(task.get("total", 1)))
            task["completed"] = min(total, int(task.get("completed", 0)) + 1)
        elif result_status not in _STRUCTURAL_TASK_TERMINAL_STATUSES:
            task["results"][genome_key_value] = {
                "status": "canceling",
                "message": "Cancel requested; stopping after current step.",
            }

        total = max(1, int(task.get("total", 1)))
        task["progress"] = min(1.0, float(task.get("completed", 0)) / total)
        task["updated_at"] = now_iso()
        return True


def _clear_structural_cache_for_species(species: Dict[str, Any], output_dir: str):
    try:
        cache_path = choose_stats_cache_path(species, output_dir, app_paths.CACHE_DIR)
        if not cache_path.exists():
            return
        update_stats_cache(cache_path, None, None, drop=("structural",))
    except Exception:
        return


def _get_structural_genomes_in_progress() -> set:
    pending = set()
    with _stats_tasks_guard:
        for task in _stats_tasks.values():
            if str(task.get("task_type") or "") != "structural":
                continue
            if str(task.get("status") or "") not in {"queued", "running"}:
                continue
            for key in task.get("genome_keys") or []:
                result = (task.get("results") or {}).get(key) or {}
                if str(result.get("status") or "") in {"ready", "failed", "missing", "canceled"}:
                    continue
                pending.add(key)
    return pending


def _stats_section_status_from_parts(has_data: bool, has_error: bool, has_missing: bool) -> str:
    if has_data:
        return "ready"
    if has_error and not has_data:
        return "error"
    if has_missing:
        return "missing"
    return "missing"


def _manifest_equivalent_accessions(species: Dict[str, Any]) -> List[str]:
    """Accessions this assembly is also published under, from its download manifest."""
    assembly = str(species.get("assembly") or species.get("gca") or "").strip()
    fasta = str((species.get("files") or {}).get("fasta") or "").strip()
    if not assembly or not fasta:
        return []
    try:
        fasta_path = Path(fasta).expanduser().resolve()
    except OSError:
        return []
    # `<assembly dir>/assembly/<file>` for a managed download, or the assembly
    # directory itself for the flatter layouts older versions produced.
    for candidate_dir in (fasta_path.parent.parent, fasta_path.parent):
        manifest = local_inventory._load_genome_manifest(candidate_dir, assembly)
        values = [str(v).strip() for v in (manifest.get("equivalent_accessions") or []) if str(v).strip()]
        if values:
            return values
    return []


def _fetch_assembly_metadata_for_species(species: Dict[str, Any]) -> Dict[str, Any]:
    """Assembly metadata for a genome, under whichever accession the registry knows.

    ENA indexes assemblies by GCA. A RefSeq genome is a GCF, which ENA has never
    heard of, so asking under its own accession always came back empty — the
    equivalent GCA recorded at download time is the accession that resolves.
    """
    equivalents = list(species.get("equivalent_accessions") or [])
    if not equivalents:
        # The saved genome record does not always carry them, but the manifest
        # written at download time always does.
        equivalents = _manifest_equivalent_accessions(species)

    candidates: List[str] = []
    for value in [species.get("gca"), species.get("assembly")] + equivalents:
        token = str(value or "").strip()
        if token and token not in candidates:
            candidates.append(token)

    last: Dict[str, Any] = {
        "status": "missing",
        "message": "No assembly accession provided.",
        "data": None,
        "source": "none",
    }
    for accession in candidates:
        result = fetch_ena_metadata(accession, app_paths._ENA_METADATA_CACHE_PATH)
        if result.get("status") == "ready":
            if accession != str(species.get("gca") or "").strip():
                result = {**result, "accession": accession, "message": (
                    result.get("message") or ""
                ) or f"Metadata for the equivalent assembly {accession}."}
            return result
        last = result
    return last


def _stats_species_with_index(species: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Fill in an annotation index the caller's record does not know about.

    Stats read ``files.index`` straight from the record the client sent, and that
    record is the snapshot taken when the genome was registered — so it is empty
    for every genome whose index was built afterwards, which is every RefSeq
    download. Left alone, annotation stats report "missing" and a structural
    generation run gives up the instant it starts, both for a genome whose index
    is sitting right beside its GFF3.
    """
    files = dict(species.get("files") or {})
    gff = str(files.get("gff3") or "").strip()
    if not gff:
        return species
    saved = str(files.get("index") or "").strip()
    if saved and os.path.exists(saved):
        return species
    resolved = genome_context._resolve_annotation_index(
        gff,
        cfg,
        str(species.get("assembly") or species.get("gca") or "").strip(),
    )
    # Only an index that already exists is any use here. Browsing can name a
    # path that has yet to be built because the browser polls until it lands;
    # stats have nothing to poll on, and would report a genome as ready and then
    # fail to read it.
    if not resolved or not os.path.exists(resolved):
        return species
    files["index"] = resolved
    return {**species, "files": files}


def _clean_stats_genomes(raw_genomes: Iterable[Any], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        _stats_species_with_index(clean_species_record(g.model_dump()), cfg)
        for g in (raw_genomes or [])
    ]


def _compute_stats_summary_sync(
    genomes: List[Dict[str, Any]],
    sections: List[str],
    structural_profile: str,
    output_dir: str,
) -> Dict[str, Any]:
    records: List[Dict[str, Any]] = []
    structural_in_progress = _get_structural_genomes_in_progress()

    for raw in genomes:
        species = clean_species_record(raw)
        files = species.get("files") or {}
        gkey = selection_key_from_record(species) or build_provider_aware_genome_key(
            species.get("species_key", ""),
            species.get("assembly", ""),
            species.get("provider", ""),
            bool(species.get("is_manual")),
        )
        cache_path = choose_stats_cache_path(species, output_dir, app_paths.CACHE_DIR)
        existing_cache = load_stats_cache(cache_path)
        loaded_sections = dict(existing_cache.get("sections") or {})
        previous_fingerprints = existing_cache.get("source_fingerprints") or {}
        fingerprints = compute_source_fingerprints(files)
        cache = ensure_stats_cache_base(existing_cache, species, fingerprints)
        cache_dirty = cache.get("source_fingerprints") != previous_fingerprints

        record = {
            "genome_key": gkey,
            "species_key": species.get("species_key"),
            "assembly": species.get("assembly"),
            "assembly_name": species.get("assembly_name"),
            "scientific_name": species.get("scientific_name"),
            "common_name": species.get("common_name"),
            "provider": species.get("provider"),
            "source_database": species.get("source_database"),
            "gca": species.get("gca"),
            "files": files,
            "statuses": {},
            "annotation": None,
            "structural": None,
            "homology": None,
            "assembly_info": None,
            "cache_path": str(cache_path),
        }

        if "annotation" in sections:
            idx = fingerprints.get("index") or {}
            if not idx.get("exists"):
                record["statuses"]["annotation"] = "missing"
            else:
                cached_ann = (cache.get("sections") or {}).get("annotation")
                ann_has_core_group_maps = bool(cached_ann) and all(
                    isinstance((cached_ann or {}).get(key), dict)
                    for key in (
                        "gene_biotype_group_map",
                        "gene_biotype_major_class_map",
                        "transcript_biotype_group_map",
                        "transcript_biotype_major_class_map",
                    )
                )
                ann_fresh = bool(cached_ann) and ann_has_core_group_maps and fingerprints_equal(previous_fingerprints, fingerprints, _STATS_ANNOTATION_DEPS)
                if ann_fresh:
                    record["statuses"]["annotation"] = "ready"
                    record["annotation"] = cached_ann
                else:
                    try:
                        computed = compute_annotation_stats(str(idx.get("path")))
                        cache.setdefault("sections", {})["annotation"] = computed
                        cache.setdefault("computed_at", {})["annotation"] = now_iso()
                        cache_dirty = True
                        record["statuses"]["annotation"] = "ready"
                        record["annotation"] = computed
                    except Exception as exc:
                        record["statuses"]["annotation"] = "error"
                        record["annotation"] = None
                        record["annotation_error"] = str(exc)

        if "homology" in sections:
            hom = fingerprints.get("homology") or {}
            if not hom.get("exists"):
                record["statuses"]["homology"] = "missing"
            else:
                cached_hom = (cache.get("sections") or {}).get("homology")
                hom_fresh = bool(cached_hom) and fingerprints_equal(previous_fingerprints, fingerprints, _STATS_HOMOLOGY_DEPS)
                if hom_fresh:
                    record["statuses"]["homology"] = "ready"
                    record["homology"] = cached_hom
                else:
                    try:
                        computed = compute_homology_stats(str(hom.get("path")))
                        cache.setdefault("sections", {})["homology"] = computed
                        cache.setdefault("computed_at", {})["homology"] = now_iso()
                        cache_dirty = True
                        record["statuses"]["homology"] = "ready"
                        record["homology"] = computed
                    except Exception as exc:
                        record["statuses"]["homology"] = "error"
                        record["homology"] = None
                        record["homology_error"] = str(exc)

        if "assembly" in sections:
            cached_assembly = dict((cache.get("sections") or {}).get("assembly") or {})
            has_data = False
            has_error = False
            has_missing = False

            fasta_fp = fingerprints.get("fasta") or {}
            if fasta_fp.get("exists"):
                fasta_cached = cached_assembly.get("fasta")
                fasta_fresh = bool(fasta_cached) and fingerprints_equal(previous_fingerprints, fingerprints, _STATS_ASSEMBLY_DEPS)
                if not fasta_fresh:
                    try:
                        cached_assembly["fasta"] = compute_fasta_assembly_stats(
                            str(fasta_fp.get("path")),
                            str((fingerprints.get("metadata") or {}).get("path") or ""),
                        )
                        cache_dirty = True
                    except Exception as exc:
                        has_error = True
                        cached_assembly["fasta_error"] = str(exc)
                if cached_assembly.get("fasta"):
                    has_data = True
            else:
                has_missing = True

            try:
                ena_info = _fetch_assembly_metadata_for_species(species)
                cached_assembly["ena"] = ena_info
                cache_dirty = True
                if ena_info.get("status") == "ready":
                    has_data = True
                elif ena_info.get("status") == "missing":
                    has_missing = True
                else:
                    has_error = True
            except Exception as exc:
                has_error = True
                cached_assembly["ena"] = {
                    "status": "error",
                    "message": str(exc),
                    "source": "none",
                    "data": None,
                }

            cache.setdefault("sections", {})["assembly"] = cached_assembly
            cache.setdefault("computed_at", {})["assembly"] = now_iso()
            record["statuses"]["assembly"] = _stats_section_status_from_parts(has_data, has_error, has_missing)
            record["assembly_info"] = cached_assembly

        if "structural" in sections:
            record["structural"] = (cache.get("sections") or {}).get("structural")
            has_structural = bool(record["structural"])
            idx = fingerprints.get("index") or {}
            fasta = fingerprints.get("fasta") or {}
            if not idx.get("exists") or not fasta.get("exists"):
                record["statuses"]["structural"] = "ready" if has_structural else "missing"
            elif gkey in structural_in_progress:
                record["statuses"]["structural"] = "computing"
            else:
                structural_fresh = (
                    has_structural
                    and _is_stats_cache_schema_current(cache)
                    and _has_required_structural_fields(record["structural"] or {})
                    and fingerprints_equal(previous_fingerprints, fingerprints, _STATS_STRUCTURAL_DEPS)
                )
                if structural_fresh:
                    record["statuses"]["structural"] = "ready"
                elif has_structural:
                    record["statuses"]["structural"] = "stale"
                else:
                    record["statuses"]["structural"] = "missing"

        if cache_dirty:
            # Only what this request computed: a structural run may have saved since
            # this cache was loaded, and saving the old copy would throw that away.
            cached_sections = cache.get("sections") or {}
            cached_computed = cache.get("computed_at") or {}
            written = [name for name, value in cached_sections.items() if loaded_sections.get(name) is not value]
            update_stats_cache(
                cache_path,
                species,
                fingerprints,
                sections={name: cached_sections[name] for name in written},
                computed_at={name: cached_computed[name] for name in written if name in cached_computed},
            )

        records.append(record)

    return {
        "sections": sections,
        "structural_profile": structural_profile,
        "records": records,
        "aggregates": {
            "annotation": build_annotation_aggregate(records),
            "structural": build_structural_aggregate(records),
            "homology": build_homology_aggregate(records),
        },
    }


async def _run_structural_stats_task(
    task_id: str,
    genomes_by_key: Dict[str, Dict[str, Any]],
    output_dir: str,
    structural_profile: str,
    force: bool,
):
    task = _read_stats_task(task_id)
    if task is None:
        return
    genome_keys = task.get("genome_keys") or []
    _update_stats_task(task_id, status="running", message="Generating structural stats...")

    failures = 0
    for genome_key_value in genome_keys:
        current_task = _read_stats_task(task_id) or {}
        existing_result = (current_task.get("results") or {}).get(genome_key_value) or {}
        if str(existing_result.get("status") or "") in _STRUCTURAL_TASK_TERMINAL_STATUSES:
            continue
        species = genomes_by_key.get(genome_key_value)
        if species is None:
            failures += 1
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "failed", "message": "Genome key not found in request payload."},
            )
            continue
        if _is_task_genome_cancelled(task_id, genome_key_value):
            _clear_structural_cache_for_species(species, output_dir)
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "canceled", "message": "Canceled by user."},
            )
            continue

        try:
            files = species.get("files") or {}
            fingerprints = compute_source_fingerprints(files)
            idx = fingerprints.get("index") or {}
            fasta = fingerprints.get("fasta") or {}
            if not idx.get("exists") or not fasta.get("exists"):
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "missing", "message": "Index and FASTA are required for structural stats."},
                )
                continue

            cache_path = choose_stats_cache_path(species, output_dir, app_paths.CACHE_DIR)
            existing_cache = load_stats_cache(cache_path)
            previous_fingerprints = existing_cache.get("source_fingerprints") or {}
            cache = ensure_stats_cache_base(existing_cache, species, fingerprints)
            cached_structural = (cache.get("sections") or {}).get("structural")
            structural_fresh = (
                bool(cached_structural)
                and _is_stats_cache_schema_current(cache)
                and _has_required_structural_fields(cached_structural or {})
                and fingerprints_equal(previous_fingerprints, fingerprints, _STATS_STRUCTURAL_DEPS)
            )

            if structural_fresh and not force:
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "ready", "message": "Structural stats already up to date."},
                )
                continue

            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "running", "message": _STRUCTURAL_QUICK_PASS_MESSAGE, "progress": 0.0},
                mark_complete=False,
            )

            quick = await asyncio.to_thread(
                compute_structural_stats,
                str(idx.get("path")),
                str(fasta.get("path")),
                structural_profile,
                False,
                _structural_progress_reporter(
                    task_id, genome_key_value, 0.0, _STRUCTURAL_QUICK_PASS_SHARE, _STRUCTURAL_QUICK_PASS_MESSAGE,
                ),
            )
            if _is_task_genome_cancelled(task_id, genome_key_value):
                _clear_structural_cache_for_species(species, output_dir)
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "canceled", "message": "Canceled by user."},
                )
                continue
            update_stats_cache(cache_path, species, fingerprints, {"structural": quick}, {"structural": now_iso()})
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {
                    "status": "running",
                    "message": _STRUCTURAL_SEQUENCE_PASS_MESSAGE,
                    "progress": _STRUCTURAL_QUICK_PASS_SHARE,
                    "cache_path": str(cache_path),
                },
                mark_complete=False,
            )

            computed = await asyncio.to_thread(
                compute_structural_stats,
                str(idx.get("path")),
                str(fasta.get("path")),
                structural_profile,
                True,
                _structural_progress_reporter(
                    task_id,
                    genome_key_value,
                    _STRUCTURAL_QUICK_PASS_SHARE,
                    1.0 - _STRUCTURAL_QUICK_PASS_SHARE,
                    _STRUCTURAL_SEQUENCE_PASS_MESSAGE,
                ),
            )
            if _is_task_genome_cancelled(task_id, genome_key_value):
                _clear_structural_cache_for_species(species, output_dir)
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "canceled", "message": "Canceled by user."},
                )
                continue
            update_stats_cache(cache_path, species, fingerprints, {"structural": computed}, {"structural": now_iso()})
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "ready", "message": "Structural stats generated.", "cache_path": str(cache_path)},
            )
        except Exception as exc:
            if _is_task_genome_cancelled(task_id, genome_key_value):
                _clear_structural_cache_for_species(species, output_dir)
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "canceled", "message": "Canceled by user."},
                )
                continue
            failures += 1
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "failed", "message": str(exc)},
            )

    final_status = "failed" if failures > 0 else "completed"
    _update_stats_task(task_id, status=final_status, message="Structural stats task finished.")


@app.post("/api/stats/summary")
async def stats_summary(request: StatsSummaryRequest):
    sections = _normalize_stats_sections(request.sections)
    structural_profile = str(request.structural_profile or STRUCTURAL_PROFILE)
    if structural_profile != STRUCTURAL_PROFILE:
        raise HTTPException(status_code=400, detail=f"Unsupported structural profile: {structural_profile}")

    config = config_store.load_config()
    genomes = _clean_stats_genomes(request.genomes, config)
    if not genomes:
        return {
            "sections": sections,
            "structural_profile": structural_profile,
            "records": [],
            "aggregates": {"annotation": {}, "structural": {}, "homology": {}},
        }

    output_dir = str(config.get("output_dir") or "")
    return await run_in_threadpool(_compute_stats_summary_sync, genomes, sections, structural_profile, output_dir)


@app.post("/api/stats/structural/generate")
async def stats_generate_structural(request: StructuralStatsGenerateRequest):
    """Queue a structural statistics run.

    Stays ``async`` because it spawns the run on the event loop, but the one piece of
    blocking work here — reading the configuration, which merges both output-directory
    sidecars and re-derives every genome's labels — goes to a worker thread. Everything
    after it is in-memory bookkeeping.
    """
    structural_profile = str(request.structural_profile or STRUCTURAL_PROFILE)
    if structural_profile != STRUCTURAL_PROFILE:
        raise HTTPException(status_code=400, detail=f"Unsupported structural profile: {structural_profile}")

    config = await run_in_threadpool(config_store.load_config)
    genomes = _clean_stats_genomes(request.genomes, config)
    if not genomes:
        raise HTTPException(status_code=400, detail="No genomes provided.")

    genomes_by_key = {
        (selection_key_from_record(g) or build_provider_aware_genome_key(
            g.get("species_key", ""),
            g.get("assembly", ""),
            g.get("provider", ""),
            bool(g.get("is_manual")),
        )): g
        for g in genomes
    }
    requested_keys = [str(k or "").strip() for k in (request.genome_keys or []) if str(k or "").strip()]
    genome_keys = requested_keys if requested_keys else list(genomes_by_key.keys())
    genome_keys = [k for k in genome_keys if k in genomes_by_key]
    if not genome_keys:
        raise HTTPException(status_code=400, detail="No valid genome keys selected.")

    task_id = str(uuid.uuid4())
    created = now_iso()
    initial_results = {k: {"status": "queued", "message": "Queued"} for k in genome_keys}
    with _stats_tasks_guard:
        _stats_tasks[task_id] = {
            "id": task_id,
            "task_type": "structural",
            "status": "queued",
            "created_at": created,
            "updated_at": created,
            "progress": 0.0,
            "message": "Queued",
            "genome_keys": genome_keys,
            "results": initial_results,
            "total": len(genome_keys),
            "completed": 0,
            "structural_profile": structural_profile,
            "force": bool(request.force),
            "cancelled_genome_keys": [],
            "genomes_by_key": genomes_by_key,
        }

    output_dir = str(config.get("output_dir") or "")
    asyncio.create_task(
        _run_structural_stats_task(
            task_id,
            genomes_by_key,
            output_dir,
            structural_profile,
            bool(request.force),
        )
    )
    return {"task_id": task_id, "status": "queued", "genome_keys": genome_keys}


@app.post("/api/stats/structural/cancel")
def stats_cancel_structural(request: StructuralStatsCancelRequest):
    genome_key_value = str(request.genome_key or "").strip()
    if not genome_key_value:
        raise HTTPException(status_code=400, detail="genome_key is required.")

    cancelled_task_ids: List[str] = []
    candidate_task_ids: List[str] = []
    if str(request.task_id or "").strip():
        candidate_task_ids = [str(request.task_id).strip()]
    else:
        with _stats_tasks_guard:
            for tid, task in _stats_tasks.items():
                if str(task.get("task_type") or "") != "structural":
                    continue
                if str(task.get("status") or "") not in {"queued", "running"}:
                    continue
                if genome_key_value in (task.get("genome_keys") or []):
                    candidate_task_ids.append(tid)

    for tid in candidate_task_ids:
        if _cancel_stats_task_genome(tid, genome_key_value):
            cancelled_task_ids.append(tid)

    if not cancelled_task_ids:
        raise HTTPException(status_code=404, detail="No active structural generation found for genome.")

    # For queued or partially generated runs we clear the structural section immediately.
    config = config_store.load_config()
    output_dir = str(config.get("output_dir") or "")
    for tid in cancelled_task_ids:
        task = _read_stats_task(tid) or {}
        species = (task.get("genomes_by_key") or {}).get(genome_key_value)
        if species:
            _clear_structural_cache_for_species(species, output_dir)

    return {
        "status": "cancel_requested",
        "genome_key": genome_key_value,
        "task_ids": cancelled_task_ids,
    }


@app.get("/api/stats/tasks")
async def stats_list_tasks():
    return _list_stats_tasks()


@app.get("/api/stats/tasks/{task_id}")
async def stats_get_task(task_id: str):
    task = _read_stats_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Stats task not found: {task_id}")
    return task


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


class FeatureExplorerSequenceRowRequest(BaseModel):
    transcript_id: str
    window_start: int
    window_end: int


class FeatureExplorerSequencesRequest(BaseModel):
    genome: str = "reference"
    sequence_type: str = "genomic"  # genomic | transcript | cds
    rows: List[FeatureExplorerSequenceRowRequest]
    include_features: bool = True


class FeatureSlice(BaseModel):
    type: str
    start: int  # 1-based, inclusive, relative to returned window
    end: int    # 1-based, inclusive, relative to returned window
    coord_start: Optional[int] = None  # absolute coord in selected sequence space
    coord_end: Optional[int] = None    # absolute coord in selected sequence space
    genomic_start: Optional[int] = None
    genomic_end: Optional[int] = None


class FeatureExplorerSequenceRowResponse(BaseModel):
    transcript_id: str
    status: str  # ok | no_cds | not_found | error
    message: Optional[str] = None
    chrom: str
    strand: str
    coord_min: int
    coord_max: int
    window_start: int
    window_end: int
    sequence: str
    features: List[FeatureSlice] = []


class FeatureExplorerSequencesResponse(BaseModel):
    sequence_type: str
    rows: List[FeatureExplorerSequenceRowResponse]


class FeatureExplorerExonsSummaryRequest(BaseModel):
    genome: str = "reference"
    gene_id: str
    transcript_ids: Optional[List[str]] = None
    include_inactive: bool = False


class ExonSummaryGene(BaseModel):
    gene_id: str
    symbol: str = ""
    chrom: str = ""
    start: int = 0
    end: int = 0
    strand: str = "+"
    biotype: str = ""


class ExonSummaryTranscript(BaseModel):
    transcript_id: str
    biotype: str = ""
    is_canonical: bool = False
    is_active: bool = True


class ExonStateRecord(BaseModel):
    exon_state_key: str
    exon_label: str
    boundary_key: str
    chrom: str
    start: int
    end: int
    strand: str
    length: int
    state_class: str  # non_coding | partial_coding | coding
    coding_start: Optional[int] = None
    coding_end: Optional[int] = None
    coding_segments: List[Tuple[int, int]] = []
    transcript_ids: List[str] = []
    transcript_states: Dict[str, str] = {}
    inclusion_count: int = 0
    inclusion_fraction: float = 0.0
    is_constitutive: bool = False
    alt_five_prime: bool = False
    alt_three_prime: bool = False


class ExonAggregateStats(BaseModel):
    total_unique_boundaries: int = 0
    total_unique_exon_states: int = 0
    constitutive_exon_states: int = 0
    alternative_exon_states: int = 0
    coding_exon_states: int = 0
    partial_exon_states: int = 0
    non_coding_exon_states: int = 0
    microexon_count: int = 0
    mean_exon_length: float = 0.0
    median_exon_length: float = 0.0


class FeatureExplorerExonsSummaryResponse(BaseModel):
    gene: ExonSummaryGene
    transcripts: List[ExonSummaryTranscript]
    exons: List[ExonStateRecord]
    stats: ExonAggregateStats


class FeatureExplorerExonsDetailRequest(BaseModel):
    genome: str = "reference"
    gene_id: str
    exon_state_key: str
    transcript_ids: Optional[List[str]] = None
    flank_bp: int = 20


class ExonDetailSelected(BaseModel):
    exon_state_key: str
    exon_label: str
    boundary_key: str
    chrom: str
    start: int
    end: int
    strand: str
    length: int
    state_class: str
    coding_start: Optional[int] = None
    coding_end: Optional[int] = None
    coding_segments: List[Tuple[int, int]] = []


class ExonDetailSequence(BaseModel):
    flank_bp: int
    window_start: int
    window_end: int
    sequence: str
    exon_start_index: int
    exon_end_index: int
    feature_transcript_id: Optional[str] = None
    features: List[FeatureSlice] = []


class ExonDetailJunctions(BaseModel):
    donor_motif: str = ""
    donor_total: int = 0
    donor_canonical_count: int = 0
    donor_is_canonical: bool = False
    acceptor_motif: str = ""
    acceptor_total: int = 0
    acceptor_canonical_count: int = 0
    acceptor_is_canonical: bool = False
    start_codon_inclusion_count: int = 0
    stop_codon_inclusion_count: int = 0


class ExonTranscriptInstance(BaseModel):
    transcript_id: str
    exon_rank: int
    total_exons: int
    state_class: str
    transcript_coord_start: int
    transcript_coord_end: int
    exon_sequence: str = ""
    transcript_sequence: str = ""
    cds_sequence: str = ""
    cds_overlap_length: int = 0
    cds_coord_start: Optional[int] = None
    cds_coord_end: Optional[int] = None
    cds_phase_5p: Optional[int] = None
    cds_phase_3p: Optional[int] = None
    protein_aa_start: Optional[int] = None
    protein_aa_end: Optional[int] = None
    donor_motif: str = ""
    acceptor_motif: str = ""
    includes_start_codon: bool = False
    includes_stop_codon: bool = False


class FeatureExplorerExonsDetailResponse(BaseModel):
    selected_exon: ExonDetailSelected
    sequence: ExonDetailSequence
    junctions: ExonDetailJunctions
    instances: List[ExonTranscriptInstance]


class ExportSequencesRequest(BaseModel):
    genome: str = "reference"
    gene_id: str = ""
    transcript_ids: List[str]
    feature_types: List[str]          # genomic | transcript | cds | exons | utr5 | utr3 | introns
    orientations: List[str] = ["fwd"] # fwd (5'→3') | rev (3'→5', reverse complement)
    output_dir: str
    output_structure: str = "per_transcript"  # single | per_transcript | per_feature
    filename: Optional[str] = None            # used when output_structure == "single"
    compress: bool = False
    header_fields: Optional[Dict[str, bool]] = None


class ExportSequencesResponse(BaseModel):
    files: List[str]
    errors: List[str]


class TranscriptSequencesRequest(BaseModel):
    genome: str = "reference"
    gene_id: str = ""
    transcript_id: str
    # Any of the export feature types; omitted means "everything available".
    feature_types: Optional[List[str]] = None
    reverse_complement: bool = False


class TranscriptSequenceRecord(BaseModel):
    feature_type: str
    header: str
    sequence: str
    length: int
    unit: str = "bp"
    # 1-based ordinal in 5'→3' order, for the types that yield one record per
    # feature (exons, introns). None for the single-record types.
    rank: Optional[int] = None


class TranscriptSequencesResponse(BaseModel):
    transcript_id: str
    # feature_type -> whether this transcript can offer it at all, so the caller
    # can show the unavailable ones greyed rather than hiding them.
    available: Dict[str, bool]
    records: List[TranscriptSequenceRecord]
    errors: List[str] = []


class SaveExportRequest(BaseModel):
    directory: str
    filename: str
    format: str = "svg"
    mime_type: str = ""
    encoding: str = "utf8"  # utf8 | base64
    data: str


class SaveExportResponse(BaseModel):
    ok: bool = True
    path: str
    filename: str


class FeatureExplorerProteinRowRequest(BaseModel):
    transcript_id: str
    window_start: int   # 1-based amino-acid position
    window_end: int     # 1-based amino-acid position


class FeatureExplorerProteinsRequest(BaseModel):
    genome: str = "reference"
    rows: List[FeatureExplorerProteinRowRequest]


class CdsSegmentInfo(BaseModel):
    """One contiguous coding-exon segment in 5'→3' CDS coordinate order."""
    coord_start: int    # 1-based CDS nucleotide position (start of segment)
    coord_end: int      # 1-based CDS nucleotide position (end of segment)
    genomic_start: int  # always ≤ genomic_end regardless of strand
    genomic_end: int
    phase: Optional[int] = None  # GFF phase (0/1/2) where available


class FeatureExplorerProteinRowResponse(BaseModel):
    transcript_id: str
    protein_id: str = ""
    status: str              # ok | no_cds | not_found | error
    message: Optional[str] = None
    coord_min: int = 1
    coord_max: int = 1       # = protein length in amino acids
    window_start: int = 1
    window_end: int = 1
    sequence: str = ""       # amino-acid sequence for the requested window
    cds_segments: List[CdsSegmentInfo] = []  # used by the client for alignment
    strand: str = "+"
    translation_table: int = 1        # NCBI genetic code used (2 = vertebrate mito, …)
    five_prime_partial: bool = False  # CDS starts mid-codon; sequence begins with X
    three_prime_partial: bool = False # trailing incomplete codon was dropped


class FeatureExplorerProteinsResponse(BaseModel):
    rows: List[FeatureExplorerProteinRowResponse]


# ── InterPro domain annotation models ──────────────────────────────────────────

class ProteinDomainEntry(BaseModel):
    accession: str = ""        # e.g. PF00069
    name: str = ""             # e.g. Protein kinase domain
    database: str = ""         # e.g. Pfam, SMART, CDD
    start: int = 0             # 1-based protein residue start
    end: int = 0               # 1-based protein residue end
    description: str = ""

class ProteinDomainRow(BaseModel):
    protein_id: str
    uniprot_id: str = ""
    status: str = "ok"         # ok | not_found | error
    message: str = ""
    domains: List[ProteinDomainEntry] = []

class ProteinDomainsRequest(BaseModel):
    protein_ids: List[str]
    genome: str = "reference"

class ProteinDomainsResponse(BaseModel):
    rows: List[ProteinDomainRow]


# ── 3D structure models ────────────────────────────────────────────────────────

class StructureModelInfo(BaseModel):
    """The AlphaFold entry backing a structure view."""
    accession: str = ""
    model_entity_id: str = ""
    version: int = 0
    sequence_length: int = 0
    sequence_start: int = 1
    sequence_end: int = 0
    fragment_count: int = 1
    model_url: str = ""            # local, backend-proxied mmCIF the viewer loads
    afdb_url: str = ""             # AlphaFold DB page, for attribution and link-out

class StructureResolveRequest(BaseModel):
    genome: str = "reference"
    transcript_id: str = ""
    protein_id: str = ""
    accession_override: str = ""

class StructureResolveResponse(BaseModel):
    transcript_id: str = ""
    protein_id: str = ""
    uniprot_accession: str = ""
    source: str = ""               # manual | custom_tsv | xref | uniprot_api
    status: str = "ok"             # ok | no_cds | no_accession | no_model | error
    message: str = ""
    protein_length: int = 0
    model: Optional[StructureModelInfo] = None

class StructureResidueSegment(BaseModel):
    """One run of model residues contributed by a single coding exon."""
    exon_index: int = 0            # 0-based index into the transcript's CDS segments
    aa_start: int = 0              # 1-based position in the local translation
    aa_end: int = 0
    model_start: int = 0           # 1-based residue number in the AlphaFold model
    model_end: int = 0
    genomic_start: Optional[int] = None
    genomic_end: Optional[int] = None

class StructureResidueMapRequest(BaseModel):
    genome: str = "reference"
    transcript_id: str = ""
    accession: str = ""

class StructureResidueMapResponse(BaseModel):
    transcript_id: str = ""
    accession: str = ""
    status: str = "ok"             # ok | no_cds | no_model | error
    message: str = ""
    identical: bool = False        # local translation equals the modelled sequence
    aligned: bool = False          # an alignment was needed to reconcile them
    identity: float = 0.0
    coverage: float = 0.0          # fraction of local residues present in the model
    local_length: int = 0
    model_length: int = 0
    exon_count: int = 0
    unmapped_residues: int = 0
    strand: str = "+"
    segments: List[StructureResidueSegment] = []
    warnings: List[str] = []

class StructureTranscriptOption(BaseModel):
    """Whether one transcript has a structure worth offering in the dropdown."""
    transcript_id: str = ""
    protein_id: str = ""
    status: str = "unknown"        # ok | no_cds | no_accession | no_model | unknown | error
    accession: str = ""
    source: str = ""
    model_version: int = 0
    protein_length: int = 0
    model_length: int = 0
    identical: bool = False        # translation length matches the modelled sequence
    message: str = ""

class StructureTranscriptsRequest(BaseModel):
    genome: str = "reference"
    transcript_ids: List[str] = []

class StructureTranscriptsResponse(BaseModel):
    # probed: every transcript was checked. partial: some lookups did not finish
    # in time. canonical_only: the set was too large to probe at all.
    mode: str = "probed"
    checked: int = 0
    message: str = ""
    entries: List[StructureTranscriptOption] = []

class StructureVariant(BaseModel):
    track_id: str = ""
    chrom: str = ""
    pos: int = 0                   # 1-based genomic position of the REF allele
    ref: str = ""
    alt: str = ""
    variant_id: str = ""
    aa_index: int = 0              # 1-based position in the local translation
    model_residue: int = 0         # 1-based residue number in the AlphaFold model
    exon_index: int = 0
    ref_aa: str = ""
    alt_aa: str = ""
    consequence: str = ""          # synonymous | missense | stop_gained | …
    impact: str = "other"          # silent | missense | truncating | other
    ref_mismatch: bool = False     # the VCF REF disagrees with the loaded genome

class StructureVariantsRequest(BaseModel):
    genome: str = "reference"
    transcript_id: str = ""
    accession: str = ""
    track_ids: List[str] = []

class StructureVariantTrackResult(BaseModel):
    track_id: str = ""
    label: str = ""
    status: str = "ok"             # ok | not_found | wrong_type | unreadable
    message: str = ""
    variants: List[StructureVariant] = []
    truncated: bool = False
    ref_mismatches: int = 0

class StructureVariantsResponse(BaseModel):
    transcript_id: str = ""
    accession: str = ""
    status: str = "ok"             # ok | no_cds | no_model | error
    message: str = ""
    tracks: List[StructureVariantTrackResult] = []
    warnings: List[str] = []

class StructureMappingImportRequest(BaseModel):
    path: str = ""

class StructureMappingStatusResponse(BaseModel):
    configured: bool = False
    path: str = ""
    format: str = ""
    entry_count: int = 0
    row_count: int = 0
    message: str = ""


def _parse_gff_attributes(attr_str: str) -> dict:
    attrs = {}
    for piece in str(attr_str or "").split(';'):
        if '=' not in piece:
            continue
        k, v = piece.split('=', 1)
        key = str(k).strip()
        if not key:
            continue
        attrs[key] = str(v).strip()
    return attrs


def _extract_transcript_tags_from_gff(gff_path: str, transcript_ids: set) -> dict:
    remaining = {str(tid).strip() for tid in (transcript_ids or set()) if str(tid).strip()}
    if not remaining or not gff_path or not os.path.exists(gff_path):
        return {}

    tag_map = {}
    try:
        with file_io.open_maybe_gz(gff_path, 'r') as f:
            for line in f:
                if not remaining:
                    break
                if not line or line.startswith('#'):
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) < 9:
                    continue
                attrs = _parse_gff_attributes(parts[8])
                raw_id = attrs.get('ID', '')
                t_id = raw_id.replace('transcript:', '').replace('mapped_transcript:', '')
                if not t_id:
                    t_id = attrs.get('transcript_id', '')
                if t_id not in remaining:
                    continue
                tags = attrs.get('tag', '')
                tag_map[t_id] = [t.strip() for t in str(tags).split(',') if t.strip()]
                remaining.discard(t_id)
    except Exception:
        return {}
    return tag_map


def _resolve_transcript_tags_for_db(db_path: str, transcript_ids: set) -> dict:
    if not transcript_ids:
        return {}
    source_gff = ""
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT value FROM metadata WHERE key = 'source_gff'")
        row = c.fetchone()
        conn.close()
        source_gff = str(row[0]) if row and row[0] else ""
    except Exception:
        source_gff = ""
    return _extract_transcript_tags_from_gff(source_gff, transcript_ids)


_gene_description_cache: Dict[Tuple[str, str], Optional[str]] = {}
MAX_DESCRIPTION_FALLBACK_SCAN_LINES = 200000
MAX_DESCRIPTION_FALLBACK_SCAN_BYTES = 12 * 1024 * 1024


def _normalize_gene_description(value: Any) -> Optional[str]:
    text = unquote(str(value or "")).strip()
    return text or None


def _extract_gene_description_from_gff(gff_path: str, gene_id: str) -> Optional[str]:
    target_gene_id = str(gene_id or "").strip()
    if not target_gene_id or not gff_path or not os.path.exists(gff_path):
        return None

    gene_feature_types = {
        'gene',
        'pseudogene',
        'ncRNA_gene',
        'rRNA_gene',
        'snRNA_gene',
        'snoRNA_gene',
        'miRNA_gene',
        'misc_RNA_gene',
        'tRNA_gene',
        'transposable_element_gene',
        'scRNA_gene',
        'vault_RNA_gene',
    }

    try:
        scanned_lines = 0
        scanned_bytes = 0
        with file_io.open_maybe_gz(gff_path, 'r') as f:
            for line in f:
                scanned_lines += 1
                scanned_bytes += len(line)
                if scanned_lines > MAX_DESCRIPTION_FALLBACK_SCAN_LINES or scanned_bytes > MAX_DESCRIPTION_FALLBACK_SCAN_BYTES:
                    # Keep lazy fallback bounded so resolve/search requests stay responsive.
                    return None
                if not line or line.startswith('#'):
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) < 9:
                    continue
                attrs = _parse_gff_attributes(parts[8])
                raw_id = attrs.get('ID', '')
                parent_attr = attrs.get('Parent', '')
                has_gene_id = raw_id.startswith('gene:')
                is_gene_level = (parts[2] in gene_feature_types) or (has_gene_id and not parent_attr)
                if not is_gene_level:
                    continue
                row_gene_id = raw_id.replace('gene:', '') or attrs.get('gene_id', '')
                if row_gene_id != target_gene_id:
                    continue
                return _normalize_gene_description(
                    attrs.get('description') or attrs.get('gene_description') or attrs.get('product')
                )
    except Exception:
        return None
    return None


def _resolve_gene_description_for_db(db_path: str, gene_id: str, current_description: Any = None) -> Optional[str]:
    existing = _normalize_gene_description(current_description)
    if existing:
        return existing

    source_gff = ""
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT value FROM metadata WHERE key = 'source_gff'")
        row = c.fetchone()
        conn.close()
        source_gff = str(row[0]) if row and row[0] else ""
    except Exception:
        source_gff = ""
    if not source_gff:
        return None

    cache_key = (os.path.abspath(source_gff), str(gene_id or ""))
    if cache_key in _gene_description_cache:
        return _gene_description_cache[cache_key]

    desc = _extract_gene_description_from_gff(source_gff, str(gene_id or ""))
    _gene_description_cache[cache_key] = desc
    return desc


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


def _force_refresh_browse_fasta_index(genome: str, current_fasta: Optional["ThreadSafeFasta"] = None):
    """Force FASTA re-index + handle refresh for a genome cache entry."""
    context = genome_context._resolve_browse_genome_context(genome)
    cache_key = str(context.get("cache_key") or str(genome or "").strip() or "reference")
    fasta_path = str(context.get("fasta_path") or "")
    if not fasta_path or not os.path.exists(fasta_path):
        raise HTTPException(status_code=404, detail=f"FASTA not found for {genome} genome.")

    refreshed = file_io.open_indexed_fasta(fasta_path, force_reindex=True)
    genome_context._fasta_cache[cache_key] = (fasta_path, refreshed)

    try:
        if current_fasta is not None and current_fasta is not refreshed:
            current_fasta.close()
    except Exception:
        pass
    return refreshed


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
            description=_normalize_gene_description(r['description']) if include_description and 'description' in r.keys() else None,
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
            description=_resolve_gene_description_for_db(db_path, str(chosen_gene["id"]), chosen_gene["description"]),
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
            description=_resolve_gene_description_for_db(db_path, row['id'], row.get('description')),
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
            description=_resolve_gene_description_for_db(db_path, gene_row['id'], gene_row.get('description')),
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

        fallback_tags = _resolve_transcript_tags_for_db(db_path, missing_tag_ids) if missing_tag_ids else {}

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
            _resolve_transcript_tags_for_db(db_path, missing_tag_ids)
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
        resolved_chrom = _resolve_db_chrom_name_for_genome(db_path, requested_chrom, genome) or requested_chrom
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
    resolved = _resolve_db_chrom_name_for_genome(db_path, chrom, genome) or chrom
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
        if _resolve_db_chrom_name_for_genome(db_path, region, assembly) is None:
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
    aligned = run_mafft_alignment_multi_progress(ordered, args, timeout_sec=4 * 3600,
                                                 on_progress=on_progress, cancelled=cancelled)
    return aligned, strategy


def gene_trees_alignments_root() -> Optional[Path]:
    """The alignments folder the MSA view saves to: where the tree's alignments go too."""
    output_dir = str(config_store.load_config().get("output_dir") or "").strip()
    if not output_dir or not os.path.isdir(output_dir):
        return None
    return _alignments_dir(output_dir)


def alignment_explorer_annotation_features(genome, chrom, start, end, sequence, strand, transcript_id=None):
    """Project indexed GFF3 transcript features using the existing MSA annotation mapper."""
    db_path = genome_context._get_browse_db(genome)
    resolved = _resolve_db_chrom_name_for_genome(db_path, chrom, genome) or chrom
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
        mapped = map_features_to_alignment(tx,start,end,aligned,tx.strand,aligned.replace('-', ''))
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


def _normalize_interval_list(raw_features: Any, default_type: str, default_strand: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in (raw_features or []):
        if not isinstance(item, dict):
            continue
        start = int(item.get("start", 0) or 0)
        end = int(item.get("end", 0) or 0)
        if start <= 0 or end <= 0:
            continue
        if end < start:
            start, end = end, start
        ftype = str(item.get("feature_type") or default_type or "").strip() or default_type
        strand = str(item.get("strand") or default_strand or "+").strip() or "+"
        normalized = {
            "start": start,
            "end": end,
            "feature_type": ftype,
            "strand": strand,
        }
        raw_phase = item.get("phase")
        if raw_phase not in (None, "", "."):
            try:
                phase_value = int(raw_phase)
            except Exception:
                phase_value = None
            if phase_value in (0, 1, 2):
                normalized["phase"] = phase_value
        out.append(normalized)
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def _ordered_five_to_three(intervals: List[Dict[str, Any]], strand: str) -> List[Dict[str, Any]]:
    ordered = sorted(intervals, key=lambda x: (x["start"], x["end"]))
    if strand == "-":
        ordered.reverse()
    return ordered


def _build_mode_segments(
    tx_start: int,
    tx_end: int,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    sequence_type: str,
) -> Tuple[int, int, List[Dict[str, int]], str]:
    """
    Returns (coord_min, coord_max, segments, status)
    status: ok | no_cds | error
    segments are in 5'->3' order with fields:
      coord_start, coord_end, genomic_start, genomic_end
    """
    if sequence_type == "genomic":
        start = min(tx_start, tx_end)
        end = max(tx_start, tx_end)
        if end < start or start <= 0:
            return 1, 1, [], "error"
        return start, end, [{
            "coord_start": start,
            "coord_end": end,
            "genomic_start": start,
            "genomic_end": end,
        }], "ok"

    source = exons if sequence_type == "transcript" else cds_list
    if sequence_type == "cds" and len(source) == 0:
        return 1, 1, [], "no_cds"
    if len(source) == 0:
        return 1, 1, [], "error"

    ordered = _ordered_five_to_three(source, strand)
    cursor = 1
    segments: List[Dict[str, int]] = []
    for seg in ordered:
        g_start = int(seg["start"])
        g_end = int(seg["end"])
        seg_len = (g_end - g_start) + 1
        if seg_len <= 0:
            continue
        segment = {
            "coord_start": cursor,
            "coord_end": cursor + seg_len - 1,
            "genomic_start": g_start,
            "genomic_end": g_end,
        }
        if sequence_type == "cds":
            raw_phase = seg.get("phase")
            if raw_phase in (0, 1, 2):
                segment["phase"] = int(raw_phase)
        segments.append(segment)
        cursor += seg_len

    if len(segments) == 0:
        return 1, 1, [], "error"
    return 1, segments[-1]["coord_end"], segments, "ok"


def _fetch_oriented_piece(fasta, chrom: str, genomic_start: int, genomic_end: int, strand: str) -> str:
    lo = min(genomic_start, genomic_end)
    hi = max(genomic_start, genomic_end)
    if lo <= 0 or hi < lo:
        return ""
    try:
        seq = str(fasta.fetch(chrom, lo - 1, hi)).upper()
    except Exception:
        return ""
    if strand == "-":
        return str(Seq(seq).reverse_complement()).upper()
    return seq


def _extract_window_sequence_from_segments(
    fasta,
    chrom: str,
    strand: str,
    segments: List[Dict[str, int]],
    coord_min: int,
    coord_max: int,
    window_start: int,
    window_end: int,
    placeholder: str = "-",
) -> str:
    length = max(0, (window_end - window_start) + 1)
    if length <= 0:
        return ""
    out = [placeholder] * length
    if coord_max < coord_min or len(segments) == 0:
        return "".join(out)

    effective_start = max(window_start, coord_min)
    effective_end = min(window_end, coord_max)
    if effective_end < effective_start:
        return "".join(out)

    for seg in segments:
        c_start = int(seg["coord_start"])
        c_end = int(seg["coord_end"])
        if c_end < effective_start or c_start > effective_end:
            continue
        ov_start = max(c_start, effective_start)
        ov_end = min(c_end, effective_end)
        if ov_end < ov_start:
            continue

        g_lo = min(int(seg["genomic_start"]), int(seg["genomic_end"]))
        g_hi = max(int(seg["genomic_start"]), int(seg["genomic_end"]))
        # Offset is measured in 5'->3' order within this segment.
        offset_start = ov_start - c_start
        offset_end = ov_end - c_start

        if strand == "+":
            piece_g_start = g_lo + offset_start
            piece_g_end = g_lo + offset_end
        else:
            piece_g_start = g_hi - offset_end
            piece_g_end = g_hi - offset_start

        piece = _fetch_oriented_piece(fasta, chrom, piece_g_start, piece_g_end, strand)
        if not piece:
            continue
        dst = ov_start - window_start
        for i, base in enumerate(piece):
            idx = dst + i
            if 0 <= idx < length:
                out[idx] = base

    return "".join(out)


def _extract_genomic_window_sequence(
    fasta,
    chrom: str,
    strand: str,
    tx_start: int,
    tx_end: int,
    window_start: int,
    window_end: int,
    placeholder: str = "-",
) -> str:
    length = max(0, (window_end - window_start) + 1)
    if length <= 0:
        return ""
    out = [placeholder] * length
    try:
        chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        chrom_len = 0
    if chrom_len <= 0:
        return "".join(out)

    ov_start = max(1, window_start)
    ov_end = min(window_end, chrom_len)
    if ov_end < ov_start:
        return "".join(out)

    piece = _fetch_oriented_piece(fasta, chrom, ov_start, ov_end, strand)
    if not piece:
        return "".join(out)
    if strand == "+":
        dst_start = ov_start - window_start
    else:
        # In 5'->3' display for '-' strand, leftmost base corresponds to window_end.
        dst_start = window_end - ov_end

    for i, base in enumerate(piece):
        idx = dst_start + i
        if 0 <= idx < length:
            out[idx] = base
    return "".join(out)


def _oriented_coords_for_interval(start: int, end: int, strand: str) -> List[int]:
    lo = min(int(start), int(end))
    hi = max(int(start), int(end))
    if hi < lo:
        return []
    if strand == "-":
        return list(range(hi, lo - 1, -1))
    return list(range(lo, hi + 1))


def _group_coords_to_intervals(coords: List[int]) -> List[Tuple[int, int]]:
    if len(coords) == 0:
        return []
    grouped: List[Tuple[int, int]] = []
    run = [int(coords[0])]
    for coord in coords[1:]:
        c = int(coord)
        prev = int(run[-1])
        if abs(c - prev) == 1:
            run.append(c)
            continue
        grouped.append((min(run), max(run)))
        run = [c]
    grouped.append((min(run), max(run)))
    return grouped


def _oriented_sequence_from_coords(fasta, chrom: str, coords: List[int], strand: str) -> str:
    if len(coords) == 0:
        return ""
    out: List[str] = []
    for coord in coords:
        c = int(coord)
        if c <= 0:
            return ""
        try:
            base = str(fasta.fetch(chrom, c - 1, c)).upper()
        except Exception:
            return ""
        if len(base) != 1:
            return ""
        if strand == "-":
            out.append(str(Seq(base).reverse_complement()).upper())
        else:
            out.append(base)
    return "".join(out)


def _build_tx_feature_intervals(
    fasta,
    chrom: str,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    feats: List[Dict[str, Any]] = []

    # Exons and introns
    for exon in exons:
        feats.append({"type": "exon", "start": int(exon["start"]), "end": int(exon["end"])})

    exons_genomic = sorted(exons, key=lambda x: (x["start"], x["end"]))
    for i in range(len(exons_genomic) - 1):
        intron_start = int(exons_genomic[i]["end"]) + 1
        intron_end = int(exons_genomic[i + 1]["start"]) - 1
        if intron_end >= intron_start:
            feats.append({"type": "intron", "start": intron_start, "end": intron_end})

    # CDS and UTRs
    for cds in cds_list:
        feats.append({"type": "cds", "start": int(cds["start"]), "end": int(cds["end"])})

    for utr in utrs:
        ftype = str(utr.get("feature_type", "")).lower()
        if "five" in ftype or "5_prime" in ftype:
            out_type = "utr5"
        elif "three" in ftype or "3_prime" in ftype:
            out_type = "utr3"
        else:
            out_type = "utr3"
        feats.append({"type": out_type, "start": int(utr["start"]), "end": int(utr["end"])})

    # Start / stop codons from CDS boundaries, only when canonical codons are present.
    bio_cds = _ordered_five_to_three(cds_list, strand)
    cds_coords: List[int] = []
    for cds_seg in bio_cds:
        cds_coords.extend(_oriented_coords_for_interval(int(cds_seg["start"]), int(cds_seg["end"]), strand))

    if len(cds_coords) >= 3:
        start_coords = cds_coords[:3]
        stop_coords = cds_coords[-3:]

        start_seq = _oriented_sequence_from_coords(fasta, chrom, start_coords, strand)
        stop_seq = _oriented_sequence_from_coords(fasta, chrom, stop_coords, strand)

        if start_seq == "ATG":
            for codon_start, codon_end in _group_coords_to_intervals(start_coords):
                feats.append({"type": "start_codon", "start": codon_start, "end": codon_end})
        if stop_seq in {"TAA", "TAG", "TGA"}:
            for codon_start, codon_end in _group_coords_to_intervals(stop_coords):
                feats.append({"type": "stop_codon", "start": codon_start, "end": codon_end})

    # Canonical splice donor/acceptor checks around exon boundaries (GT/AG only).
    bio_exons = _ordered_five_to_three(exons, strand)
    for i in range(len(bio_exons) - 1):
        curr = bio_exons[i]
        nxt = bio_exons[i + 1]
        c_start = int(curr["start"])
        c_end = int(curr["end"])
        n_start = int(nxt["start"])
        n_end = int(nxt["end"])

        if strand == "+":
            d_start, d_end = c_end + 1, c_end + 2
            a_start, a_end = n_start - 2, n_start - 1
        else:
            d_start, d_end = c_start - 2, c_start - 1
            a_start, a_end = n_end + 1, n_end + 2

        donor_motif = _fetch_oriented_piece(fasta, chrom, d_start, d_end, strand)
        if donor_motif == "GT":
            feats.append({"type": "donor", "start": min(d_start, d_end), "end": max(d_start, d_end)})

        acceptor_motif = _fetch_oriented_piece(fasta, chrom, a_start, a_end, strand)
        if acceptor_motif == "AG":
            feats.append({"type": "acceptor", "start": min(a_start, a_end), "end": max(a_start, a_end)})

    return feats


def _project_feature_to_window_slices(
    ftype: str,
    g_start: int,
    g_end: int,
    sequence_type: str,
    strand: str,
    segments: List[Dict[str, int]],
    window_start: int,
    window_end: int,
) -> List[Dict[str, int]]:
    slices: List[Dict[str, int]] = []
    if window_end < window_start:
        return slices

    if sequence_type == "genomic":
        ov_start = max(g_start, window_start)
        ov_end = min(g_end, window_end)
        if ov_end < ov_start:
            return slices
        if strand == "-":
            rel_start = (window_end - ov_end) + 1
            rel_end = (window_end - ov_start) + 1
        else:
            rel_start = (ov_start - window_start) + 1
            rel_end = (ov_end - window_start) + 1
        slices.append({
            "type": ftype,
            "start": min(rel_start, rel_end),
            "end": max(rel_start, rel_end),
            "coord_start": ov_start,
            "coord_end": ov_end,
            "genomic_start": ov_start,
            "genomic_end": ov_end,
        })
        return slices

    for seg in segments:
        seg_g_lo = min(int(seg["genomic_start"]), int(seg["genomic_end"]))
        seg_g_hi = max(int(seg["genomic_start"]), int(seg["genomic_end"]))
        ov_start = max(seg_g_lo, g_start)
        ov_end = min(seg_g_hi, g_end)
        if ov_end < ov_start:
            continue

        c_start = int(seg["coord_start"])
        if strand == "+":
            proj_start = c_start + (ov_start - seg_g_lo)
            proj_end = c_start + (ov_end - seg_g_lo)
        else:
            proj_start = c_start + (seg_g_hi - ov_end)
            proj_end = c_start + (seg_g_hi - ov_start)
        coord_start = min(proj_start, proj_end)
        coord_end = max(proj_start, proj_end)

        clip_start = max(coord_start, window_start)
        clip_end = min(coord_end, window_end)
        if clip_end < clip_start:
            continue
        rel_start = (clip_start - window_start) + 1
        rel_end = (clip_end - window_start) + 1
        if strand == "+":
            g_clip_start = seg_g_lo + (clip_start - c_start)
            g_clip_end = seg_g_lo + (clip_end - c_start)
        else:
            g_clip_start = seg_g_hi - (clip_end - c_start)
            g_clip_end = seg_g_hi - (clip_start - c_start)
        slices.append({
            "type": ftype,
            "start": rel_start,
            "end": rel_end,
            "coord_start": clip_start,
            "coord_end": clip_end,
            "genomic_start": min(g_clip_start, g_clip_end),
            "genomic_end": max(g_clip_start, g_clip_end),
        })

    return slices


def _merge_feature_slices(slices: List[Dict[str, int]]) -> List[FeatureSlice]:
    if len(slices) == 0:
        return []
    grouped: Dict[str, List[Dict[str, int]]] = {}
    for slc in slices:
        ftype = str(slc.get("type", "")).strip()
        start = int(slc.get("start", 0) or 0)
        end = int(slc.get("end", 0) or 0)
        if not ftype or start <= 0 or end <= 0:
            continue
        if end < start:
            start, end = end, start
        coord_start = int(slc.get("coord_start", 0) or 0)
        coord_end = int(slc.get("coord_end", 0) or 0)
        if coord_start > 0 and coord_end > 0 and coord_end < coord_start:
            coord_start, coord_end = coord_end, coord_start
        genomic_start = int(slc.get("genomic_start", 0) or 0)
        genomic_end = int(slc.get("genomic_end", 0) or 0)
        if genomic_start > 0 and genomic_end > 0 and genomic_end < genomic_start:
            genomic_start, genomic_end = genomic_end, genomic_start
        grouped.setdefault(ftype, []).append({
            "start": start,
            "end": end,
            "coord_start": coord_start,
            "coord_end": coord_end,
            "genomic_start": genomic_start,
            "genomic_end": genomic_end,
        })

    merged_out: List[FeatureSlice] = []
    for ftype, ranges in grouped.items():
        ranges.sort(key=lambda x: (x["start"], x["end"]))
        cur = dict(ranges[0])
        for item in ranges[1:]:
            can_merge_display = item["start"] <= (cur["end"] + 1)
            can_merge_coord = (
                cur["coord_start"] > 0 and cur["coord_end"] > 0
                and item["coord_start"] > 0 and item["coord_end"] > 0
                and item["coord_start"] <= (cur["coord_end"] + 1)
            )
            can_merge_genomic = (
                cur["genomic_start"] > 0 and cur["genomic_end"] > 0
                and item["genomic_start"] > 0 and item["genomic_end"] > 0
                and item["genomic_start"] <= (cur["genomic_end"] + 1)
            )
            if can_merge_display and can_merge_coord and can_merge_genomic:
                cur["end"] = max(cur["end"], item["end"])
                cur["coord_start"] = min(cur["coord_start"], item["coord_start"])
                cur["coord_end"] = max(cur["coord_end"], item["coord_end"])
                cur["genomic_start"] = min(cur["genomic_start"], item["genomic_start"])
                cur["genomic_end"] = max(cur["genomic_end"], item["genomic_end"])
            else:
                merged_out.append(FeatureSlice(
                    type=ftype,
                    start=cur["start"],
                    end=cur["end"],
                    coord_start=cur["coord_start"] or None,
                    coord_end=cur["coord_end"] or None,
                    genomic_start=cur["genomic_start"] or None,
                    genomic_end=cur["genomic_end"] or None,
                ))
                cur = dict(item)
        merged_out.append(FeatureSlice(
            type=ftype,
            start=cur["start"],
            end=cur["end"],
            coord_start=cur["coord_start"] or None,
            coord_end=cur["coord_end"] or None,
            genomic_start=cur["genomic_start"] or None,
            genomic_end=cur["genomic_end"] or None,
        ))
    merged_out.sort(key=lambda x: (x.start, x.end, x.type))
    return merged_out


def _feature_explorer_interval_length(start: int, end: int) -> int:
    s = int(start)
    e = int(end)
    if e < s:
        s, e = e, s
    return max(0, (e - s) + 1)


def _feature_explorer_merge_intervals(intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not intervals:
        return []
    ordered = sorted(
        [
            (min(int(start), int(end)), max(int(start), int(end)))
            for start, end in intervals
            if int(start) > 0 and int(end) > 0
        ],
        key=lambda x: (x[0], x[1]),
    )
    if not ordered:
        return []
    merged: List[Tuple[int, int]] = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= (prev_end + 1):
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _feature_explorer_classify_exon_state(
    exon_start: int,
    exon_end: int,
    cds_list: List[Dict[str, Any]],
) -> Dict[str, Any]:
    ex_start = min(int(exon_start), int(exon_end))
    ex_end = max(int(exon_start), int(exon_end))
    overlaps: List[Tuple[int, int]] = []
    for cds in cds_list:
        cds_start = min(int(cds.get("start", 0) or 0), int(cds.get("end", 0) or 0))
        cds_end = max(int(cds.get("start", 0) or 0), int(cds.get("end", 0) or 0))
        if cds_start <= 0 or cds_end <= 0:
            continue
        ov_start = max(ex_start, cds_start)
        ov_end = min(ex_end, cds_end)
        if ov_end >= ov_start:
            overlaps.append((ov_start, ov_end))
    merged = _feature_explorer_merge_intervals(overlaps)
    if not merged:
        return {
            "state_class": "non_coding",
            "coding_start": None,
            "coding_end": None,
            "coding_segments": [],
        }

    exon_len = _feature_explorer_interval_length(ex_start, ex_end)
    coding_len = sum(_feature_explorer_interval_length(start, end) for start, end in merged)
    if len(merged) == 1 and coding_len >= exon_len and merged[0][0] <= ex_start and merged[0][1] >= ex_end:
        return {
            "state_class": "coding",
            "coding_start": ex_start,
            "coding_end": ex_end,
            "coding_segments": [(ex_start, ex_end)],
        }

    return {
        "state_class": "partial_coding",
        "coding_start": min(seg[0] for seg in merged),
        "coding_end": max(seg[1] for seg in merged),
        "coding_segments": merged,
    }


def _feature_explorer_oriented_boundaries(start: int, end: int, strand: str) -> Tuple[int, int]:
    s = min(int(start), int(end))
    e = max(int(start), int(end))
    if strand == "-":
        return e, s
    return s, e


def _feature_explorer_boundary_key(chrom: str, start: int, end: int, strand: str) -> str:
    s = min(int(start), int(end))
    e = max(int(start), int(end))
    return f"{chrom}:{s}:{e}:{strand}"


def _feature_explorer_partial_signature(coding_segments: List[Tuple[int, int]]) -> str:
    if not coding_segments:
        return ""
    ordered = sorted(
        [(min(int(a), int(b)), max(int(a), int(b))) for a, b in coding_segments],
        key=lambda x: (x[0], x[1]),
    )
    return ",".join(f"{start}-{end}" for start, end in ordered)


def _feature_explorer_exon_state_key(
    chrom: str,
    start: int,
    end: int,
    strand: str,
    state_class: str,
    coding_segments: List[Tuple[int, int]],
) -> str:
    boundary = _feature_explorer_boundary_key(chrom, start, end, strand)
    signature = _feature_explorer_partial_signature(coding_segments) if state_class == "partial_coding" else ""
    return f"{boundary}|{state_class}|{signature}"


def _feature_explorer_state_sort_rank(state_class: str) -> int:
    key = str(state_class or "").strip().lower()
    if key == "coding":
        return 0
    if key == "partial_coding":
        return 1
    return 2


def _feature_explorer_median(values: List[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _feature_explorer_load_gene_and_transcripts(
    db_path: str,
    gene_id: str,
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    gene_id_value = str(gene_id or "").strip()
    if not gene_id_value:
        return None, []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    def _run_gene_query(sql: str, params: tuple) -> Optional[Dict[str, Any]]:
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

    gene_row = _run_gene_query(
        "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE id = ? LIMIT 1",
        (gene_id_value,),
    )
    if not gene_row:
        conn.close()
        return None, []

    c.execute(
        """
        SELECT id, chrom, start, end, strand, is_canonical, data
        FROM transcripts
        WHERE parent_gene_id = ?
        ORDER BY is_canonical DESC, start ASC, id ASC
        """,
        (gene_id_value,),
    )
    tx_rows = c.fetchall()
    conn.close()

    transcripts: List[Dict[str, Any]] = []
    for row in tx_rows:
        raw_data = row["data"]
        try:
            tx_data = json.loads(raw_data) if raw_data else {}
        except Exception:
            tx_data = {}
        tx_data = tx_data if isinstance(tx_data, dict) else {}
        strand = str(row["strand"] or "+").strip() or "+"
        transcripts.append({
            "id": str(row["id"] or ""),
            "chrom": str(row["chrom"] or ""),
            "start": int(row["start"] or 0),
            "end": int(row["end"] or 0),
            "strand": strand,
            "is_canonical": bool(row["is_canonical"]),
            "biotype": str(tx_data.get("biotype", "") or ""),
            "version": str(tx_data.get("version", "") or ""),
            "exons": _normalize_interval_list(tx_data.get("exons", []), "exon", strand),
            "cds_list": _normalize_interval_list(tx_data.get("cds_list", []), "cds", strand),
            "utrs": _normalize_interval_list(tx_data.get("utrs", []), "utr", strand),
        })

    gene = {
        "gene_id": str(gene_row.get("id") or ""),
        "symbol": str(gene_row.get("name") or ""),
        "description": _resolve_gene_description_for_db(db_path, gene_row.get("id"), gene_row.get("description")),
        "chrom": str(gene_row.get("chrom") or ""),
        "start": int(gene_row.get("start") or 0),
        "end": int(gene_row.get("end") or 0),
        "strand": str(gene_row.get("strand") or "+"),
        "biotype": str(gene_row.get("biotype") or ""),
        "version": str(gene_row.get("version") or ""),
    }
    return gene, transcripts


def _feature_explorer_order_transcripts(
    transcripts: List[Dict[str, Any]],
    requested_ids: Optional[List[str]],
    include_inactive: bool,
) -> Tuple[List[Dict[str, Any]], Set[str]]:
    tx_by_id = {str(tx.get("id") or ""): tx for tx in transcripts if str(tx.get("id") or "")}
    default_ids = sorted(
        tx_by_id.keys(),
        key=lambda tx_id: (
            -int(bool(tx_by_id[tx_id].get("is_canonical"))),
            int(tx_by_id[tx_id].get("start") or 0),
            tx_id,
        ),
    )

    requested: List[str] = []
    for raw in (requested_ids or []):
        tid = str(raw or "").strip()
        if not tid or tid not in tx_by_id or tid in requested:
            continue
        requested.append(tid)

    if requested:
        if include_inactive:
            ordered_ids = requested + [tid for tid in default_ids if tid not in set(requested)]
        else:
            ordered_ids = list(requested)
        active_set: Set[str] = set(requested)
    else:
        ordered_ids = list(default_ids)
        active_set = set(default_ids)

    ordered_transcripts: List[Dict[str, Any]] = []
    for tid in ordered_ids:
        tx = dict(tx_by_id[tid])
        tx["is_active"] = tid in active_set
        ordered_transcripts.append(tx)
    return ordered_transcripts, active_set


def _feature_explorer_cds_overlap_span(
    cds_segments: List[Dict[str, int]],
    strand: str,
    exon_start: int,
    exon_end: int,
) -> Dict[str, Any]:
    ex_lo = min(int(exon_start), int(exon_end))
    ex_hi = max(int(exon_start), int(exon_end))
    coord_ranges: List[Tuple[int, int]] = []
    overlap_intervals: List[Tuple[int, int]] = []
    for seg in cds_segments:
        seg_lo = min(int(seg.get("genomic_start", 0) or 0), int(seg.get("genomic_end", 0) or 0))
        seg_hi = max(int(seg.get("genomic_start", 0) or 0), int(seg.get("genomic_end", 0) or 0))
        if seg_lo <= 0 or seg_hi <= 0:
            continue
        ov_start = max(seg_lo, ex_lo)
        ov_end = min(seg_hi, ex_hi)
        if ov_end < ov_start:
            continue
        overlap_intervals.append((ov_start, ov_end))
        c_start = int(seg.get("coord_start", 1) or 1)
        if strand == "+":
            proj_start = c_start + (ov_start - seg_lo)
            proj_end = c_start + (ov_end - seg_lo)
        else:
            proj_start = c_start + (seg_hi - ov_end)
            proj_end = c_start + (seg_hi - ov_start)
        coord_ranges.append((min(proj_start, proj_end), max(proj_start, proj_end)))

    if not coord_ranges:
        return {
            "cds_overlap_length": 0,
            "cds_coord_start": None,
            "cds_coord_end": None,
            "overlap_intervals": [],
        }

    return {
        "cds_overlap_length": int(sum(_feature_explorer_interval_length(start, end) for start, end in overlap_intervals)),
        "cds_coord_start": int(min(start for start, _ in coord_ranges)),
        "cds_coord_end": int(max(end for _, end in coord_ranges)),
        "overlap_intervals": overlap_intervals,
    }


def _feature_explorer_start_stop_intervals(cds_list: List[Dict[str, Any]], strand: str) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]]]:
    ordered_cds = _ordered_five_to_three(cds_list, strand)
    coords: List[int] = []
    for seg in ordered_cds:
        coords.extend(_oriented_coords_for_interval(int(seg["start"]), int(seg["end"]), strand))
    if len(coords) < 3:
        return [], []
    return _group_coords_to_intervals(coords[:3]), _group_coords_to_intervals(coords[-3:])


def _feature_explorer_collect_exon_dataset(
    genome: str,
    gene_id: str,
    transcript_ids: Optional[List[str]] = None,
    include_inactive: bool = False,
    include_sequence_fields: bool = False,
) -> Dict[str, Any]:
    db_path = genome_context._get_browse_db(genome)
    gene, transcripts = _feature_explorer_load_gene_and_transcripts(db_path, gene_id)
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{gene_id}' not found in {genome} genome.")

    ordered_transcripts, active_set = _feature_explorer_order_transcripts(transcripts, transcript_ids, include_inactive)
    total_transcripts = len(ordered_transcripts)
    fasta = genome_context._get_browse_fasta(genome) if include_sequence_fields else None

    records_by_key: Dict[str, Dict[str, Any]] = {}
    instances_by_key: Dict[str, List[Dict[str, Any]]] = {}
    seen_boundaries: Set[str] = set()
    five_to_three: Dict[int, Set[int]] = {}
    three_to_five: Dict[int, Set[int]] = {}

    for tx in ordered_transcripts:
        tx_id = str(tx.get("id") or "")
        tx_strand = str(tx.get("strand") or gene.get("strand") or "+")
        tx_exons = _ordered_five_to_three(list(tx.get("exons") or []), tx_strand)
        tx_cds_list = list(tx.get("cds_list") or [])
        tx_cds_min = min([int(c.get("start", 0) or 0) for c in tx_cds_list] + [int(c.get("end", 0) or 0) for c in tx_cds_list] + [0])
        tx_cds_max = max([int(c.get("start", 0) or 0) for c in tx_cds_list] + [int(c.get("end", 0) or 0) for c in tx_cds_list] + [0])
        _, _, cds_segments, cds_status = _build_mode_segments(
            tx_start=tx_cds_min if tx_cds_min > 0 else int(tx.get("start", 0) or 0),
            tx_end=tx_cds_max if tx_cds_max > 0 else int(tx.get("end", 0) or 0),
            strand=tx_strand,
            exons=[],
            cds_list=tx_cds_list,
            sequence_type="cds",
        )
        if cds_status != "ok":
            cds_segments = []

        start_codon_intervals, stop_codon_intervals = _feature_explorer_start_stop_intervals(tx_cds_list, tx_strand)
        transcript_cursor = 1
        exon_total = len(tx_exons)

        for exon_index, exon in enumerate(tx_exons):
            ex_start = min(int(exon.get("start", 0) or 0), int(exon.get("end", 0) or 0))
            ex_end = max(int(exon.get("start", 0) or 0), int(exon.get("end", 0) or 0))
            if ex_start <= 0 or ex_end <= 0 or ex_end < ex_start:
                continue
            exon_len = _feature_explorer_interval_length(ex_start, ex_end)
            tx_coord_start = transcript_cursor
            tx_coord_end = transcript_cursor + exon_len - 1
            transcript_cursor = tx_coord_end + 1

            state = _feature_explorer_classify_exon_state(ex_start, ex_end, tx_cds_list)
            state_class = str(state.get("state_class") or "non_coding")
            coding_segments = list(state.get("coding_segments") or [])
            coding_start = state.get("coding_start")
            coding_end = state.get("coding_end")

            chrom = str(tx.get("chrom") or gene.get("chrom") or "")
            strand = tx_strand
            five_prime, three_prime = _feature_explorer_oriented_boundaries(ex_start, ex_end, strand)
            boundary_key = _feature_explorer_boundary_key(chrom, ex_start, ex_end, strand)
            exon_state_key = _feature_explorer_exon_state_key(chrom, ex_start, ex_end, strand, state_class, coding_segments)

            if boundary_key not in seen_boundaries:
                seen_boundaries.add(boundary_key)
                five_to_three.setdefault(int(five_prime), set()).add(int(three_prime))
                three_to_five.setdefault(int(three_prime), set()).add(int(five_prime))

            record = records_by_key.get(exon_state_key)
            if not record:
                record = {
                    "exon_state_key": exon_state_key,
                    "exon_label": "",
                    "boundary_key": boundary_key,
                    "chrom": chrom,
                    "start": ex_start,
                    "end": ex_end,
                    "strand": strand,
                    "length": exon_len,
                    "state_class": state_class,
                    "coding_start": int(coding_start) if coding_start is not None else None,
                    "coding_end": int(coding_end) if coding_end is not None else None,
                    "coding_segments": [(int(a), int(b)) for a, b in coding_segments],
                    "transcript_ids_set": set(),
                    "transcript_states": {},
                    "inclusion_count": 0,
                    "inclusion_fraction": 0.0,
                    "is_constitutive": False,
                    "alt_five_prime": False,
                    "alt_three_prime": False,
                    "_five_prime": int(five_prime),
                    "_three_prime": int(three_prime),
                }
                records_by_key[exon_state_key] = record

            record["transcript_ids_set"].add(tx_id)
            record["transcript_states"][tx_id] = state_class

            cds_info = _feature_explorer_cds_overlap_span(cds_segments, strand, ex_start, ex_end)
            cds_coord_start = cds_info.get("cds_coord_start")
            cds_coord_end = cds_info.get("cds_coord_end")
            cds_overlap_length = int(cds_info.get("cds_overlap_length") or 0)
            cds_phase_5p = int((cds_coord_start - 1) % 3) if cds_coord_start is not None else None
            cds_phase_3p = int((cds_coord_end - 1) % 3) if cds_coord_end is not None else None
            aa_start = int(((cds_coord_start - 1) // 3) + 1) if cds_coord_start is not None else None
            aa_end = int(((cds_coord_end - 1) // 3) + 1) if cds_coord_end is not None else None

            includes_start = any(max(ex_start, s) <= min(ex_end, e) for s, e in start_codon_intervals)
            includes_stop = any(max(ex_start, s) <= min(ex_end, e) for s, e in stop_codon_intervals)

            donor_motif = ""
            acceptor_motif = ""
            if exon_index < (exon_total - 1):
                if strand == "+":
                    donor_motif = _fetch_oriented_piece(fasta, chrom, ex_end + 1, ex_end + 2, strand) if fasta else ""
                else:
                    donor_motif = _fetch_oriented_piece(fasta, chrom, ex_start - 2, ex_start - 1, strand) if fasta else ""
            if exon_index > 0:
                if strand == "+":
                    acceptor_motif = _fetch_oriented_piece(fasta, chrom, ex_start - 2, ex_start - 1, strand) if fasta else ""
                else:
                    acceptor_motif = _fetch_oriented_piece(fasta, chrom, ex_end + 1, ex_end + 2, strand) if fasta else ""

            exon_sequence = _fetch_oriented_piece(fasta, chrom, ex_start, ex_end, strand) if fasta else ""
            cds_sequence = ""
            if fasta and cds_overlap_length > 0:
                pieces: List[str] = []
                for ov_start, ov_end in cds_info.get("overlap_intervals") or []:
                    piece = _fetch_oriented_piece(fasta, chrom, int(ov_start), int(ov_end), strand)
                    if piece:
                        pieces.append(piece)
                cds_sequence = "".join(pieces)

            instance = {
                "transcript_id": tx_id,
                "exon_rank": exon_index + 1,
                "total_exons": exon_total,
                "state_class": state_class,
                "transcript_coord_start": int(tx_coord_start),
                "transcript_coord_end": int(tx_coord_end),
                "exon_sequence": exon_sequence,
                "transcript_sequence": exon_sequence,
                "cds_sequence": cds_sequence,
                "cds_overlap_length": cds_overlap_length,
                "cds_coord_start": int(cds_coord_start) if cds_coord_start is not None else None,
                "cds_coord_end": int(cds_coord_end) if cds_coord_end is not None else None,
                "cds_phase_5p": cds_phase_5p,
                "cds_phase_3p": cds_phase_3p,
                "protein_aa_start": aa_start,
                "protein_aa_end": aa_end,
                "donor_motif": donor_motif,
                "acceptor_motif": acceptor_motif,
                "includes_start_codon": bool(includes_start),
                "includes_stop_codon": bool(includes_stop),
            }
            instances_by_key.setdefault(exon_state_key, []).append(instance)

    ordered_ids = [str(tx.get("id") or "") for tx in ordered_transcripts]
    for record in records_by_key.values():
        transcript_ids_for_record = [tid for tid in ordered_ids if tid in record["transcript_ids_set"]]
        inclusion_count = len(transcript_ids_for_record)
        inclusion_fraction = (inclusion_count / total_transcripts) if total_transcripts > 0 else 0.0
        record["transcript_ids"] = transcript_ids_for_record
        record["inclusion_count"] = inclusion_count
        record["inclusion_fraction"] = float(inclusion_fraction)
        record["is_constitutive"] = bool(total_transcripts > 0 and inclusion_count == total_transcripts)
        record["alt_five_prime"] = len(three_to_five.get(int(record["_three_prime"]), set())) > 1
        record["alt_three_prime"] = len(five_to_three.get(int(record["_five_prime"]), set())) > 1

    gene_strand = str(gene.get("strand") or "+")
    records_sorted = sorted(
        records_by_key.values(),
        key=lambda rec: (
            -int(rec["_five_prime"]) if gene_strand == "-" else int(rec["_five_prime"]),
            -int(rec["_three_prime"]) if gene_strand == "-" else int(rec["_three_prime"]),
            _feature_explorer_state_sort_rank(rec.get("state_class", "")),
            _feature_explorer_partial_signature(rec.get("coding_segments") or []),
        ),
    )

    boundary_order: List[str] = []
    for rec in records_sorted:
        boundary = str(rec.get("boundary_key") or "")
        if boundary and boundary not in boundary_order:
            boundary_order.append(boundary)
    boundary_rank = {boundary: idx + 1 for idx, boundary in enumerate(boundary_order)}

    for boundary in boundary_order:
        same_boundary = [rec for rec in records_sorted if rec.get("boundary_key") == boundary]
        same_boundary.sort(
            key=lambda rec: (
                _feature_explorer_state_sort_rank(rec.get("state_class", "")),
                _feature_explorer_partial_signature(rec.get("coding_segments") or []),
            )
        )
        base_rank = boundary_rank.get(boundary, 0)
        for idx, rec in enumerate(same_boundary):
            if len(same_boundary) == 1:
                suffix = ""
            elif idx < 26:
                suffix = chr(ord("a") + idx)
            else:
                suffix = str(idx + 1)
            rec["exon_label"] = f"E{base_rank}{suffix}"

    exons_out: List[ExonStateRecord] = []
    for rec in records_sorted:
        exons_out.append(ExonStateRecord(
            exon_state_key=rec["exon_state_key"],
            exon_label=rec["exon_label"],
            boundary_key=rec["boundary_key"],
            chrom=rec["chrom"],
            start=int(rec["start"]),
            end=int(rec["end"]),
            strand=rec["strand"],
            length=int(rec["length"]),
            state_class=rec["state_class"],
            coding_start=rec["coding_start"],
            coding_end=rec["coding_end"],
            coding_segments=[(int(a), int(b)) for a, b in (rec.get("coding_segments") or [])],
            transcript_ids=list(rec.get("transcript_ids") or []),
            transcript_states=dict(rec.get("transcript_states") or {}),
            inclusion_count=int(rec.get("inclusion_count") or 0),
            inclusion_fraction=float(rec.get("inclusion_fraction") or 0.0),
            is_constitutive=bool(rec.get("is_constitutive")),
            alt_five_prime=bool(rec.get("alt_five_prime")),
            alt_three_prime=bool(rec.get("alt_three_prime")),
        ))

    lengths = [float(exon.length) for exon in exons_out]
    coding_count = sum(1 for exon in exons_out if exon.state_class == "coding")
    partial_count = sum(1 for exon in exons_out if exon.state_class == "partial_coding")
    non_coding_count = sum(1 for exon in exons_out if exon.state_class == "non_coding")
    constitutive_count = sum(1 for exon in exons_out if exon.is_constitutive)
    microexon_count = sum(1 for exon in exons_out if exon.length < 27)
    stats = ExonAggregateStats(
        total_unique_boundaries=len(boundary_order),
        total_unique_exon_states=len(exons_out),
        constitutive_exon_states=constitutive_count,
        alternative_exon_states=max(0, len(exons_out) - constitutive_count),
        coding_exon_states=coding_count,
        partial_exon_states=partial_count,
        non_coding_exon_states=non_coding_count,
        microexon_count=microexon_count,
        mean_exon_length=round((sum(lengths) / len(lengths)) if lengths else 0.0, 2),
        median_exon_length=round(_feature_explorer_median(lengths), 2),
    )

    tx_out = [
        ExonSummaryTranscript(
            transcript_id=str(tx.get("id") or ""),
            biotype=str(tx.get("biotype") or ""),
            is_canonical=bool(tx.get("is_canonical")),
            is_active=bool(str(tx.get("id") or "") in active_set),
        )
        for tx in ordered_transcripts
    ]

    return {
        "gene": ExonSummaryGene(
            gene_id=str(gene.get("gene_id") or ""),
            symbol=str(gene.get("symbol") or ""),
            chrom=str(gene.get("chrom") or ""),
            start=int(gene.get("start") or 0),
            end=int(gene.get("end") or 0),
            strand=str(gene.get("strand") or "+"),
            biotype=str(gene.get("biotype") or ""),
        ),
        "transcripts": tx_out,
        "exons": exons_out,
        "stats": stats,
        "instances_by_key": instances_by_key,
        "_ordered_transcripts": ordered_transcripts,
    }


@app.post("/api/feature_explorer/exons/summary", response_model=FeatureExplorerExonsSummaryResponse)
async def feature_explorer_exons_summary(payload: FeatureExplorerExonsSummaryRequest):
    gene_id = str(payload.gene_id or "").strip()
    if not gene_id:
        raise HTTPException(status_code=400, detail="gene_id is required")

    genome = str(payload.genome or "reference").strip() or "reference"

    def _query():
        dataset = _feature_explorer_collect_exon_dataset(
            genome=genome,
            gene_id=gene_id,
            transcript_ids=payload.transcript_ids,
            include_inactive=bool(payload.include_inactive),
            include_sequence_fields=False,
        )
        return FeatureExplorerExonsSummaryResponse(
            gene=dataset["gene"],
            transcripts=dataset["transcripts"],
            exons=dataset["exons"],
            stats=dataset["stats"],
        )

    return await run_in_threadpool(_query)


@app.post("/api/feature_explorer/exons/detail", response_model=FeatureExplorerExonsDetailResponse)
async def feature_explorer_exons_detail(payload: FeatureExplorerExonsDetailRequest):
    gene_id = str(payload.gene_id or "").strip()
    exon_state_key = str(payload.exon_state_key or "").strip()
    if not gene_id:
        raise HTTPException(status_code=400, detail="gene_id is required")
    if not exon_state_key:
        raise HTTPException(status_code=400, detail="exon_state_key is required")

    genome = str(payload.genome or "reference").strip() or "reference"
    flank_bp = max(0, min(5000, int(payload.flank_bp or 20)))

    def _query():
        dataset = _feature_explorer_collect_exon_dataset(
            genome=genome,
            gene_id=gene_id,
            transcript_ids=payload.transcript_ids,
            include_inactive=True,
            include_sequence_fields=True,
        )
        exons: List[ExonStateRecord] = dataset.get("exons") or []
        selected = next((exon for exon in exons if exon.exon_state_key == exon_state_key), None)
        if not selected:
            raise HTTPException(status_code=404, detail=f"Exon state '{exon_state_key}' not found for gene '{gene_id}'.")

        chrom = str(selected.chrom or "")
        strand = str(selected.strand or "+")
        exon_start = int(selected.start)
        exon_end = int(selected.end)
        fasta = genome_context._get_browse_fasta(genome)
        try:
            chrom_len = int(fasta.get_reference_length(chrom))
        except Exception:
            chrom_len = 0

        if chrom_len > 0:
            window_start = max(1, exon_start - flank_bp)
            window_end = min(chrom_len, exon_end + flank_bp)
        else:
            window_start = max(1, exon_start - flank_bp)
            window_end = max(window_start, exon_end + flank_bp)

        sequence = _fetch_oriented_piece(fasta, chrom, window_start, window_end, strand) if chrom else ""
        if strand == "-":
            exon_start_index = (window_end - exon_end) + 1
            exon_end_index = (window_end - exon_start) + 1
        else:
            exon_start_index = (exon_start - window_start) + 1
            exon_end_index = (exon_end - window_start) + 1
        exon_start_index = max(1, int(exon_start_index))
        exon_end_index = max(exon_start_index, int(exon_end_index))

        instances_raw: List[Dict[str, Any]] = list(dataset.get("instances_by_key", {}).get(exon_state_key) or [])
        instances_raw.sort(key=lambda x: (str(x.get("transcript_id") or ""), int(x.get("exon_rank") or 0)))
        instances = [ExonTranscriptInstance(**item) for item in instances_raw]

        ordered_transcripts_raw = list(dataset.get("_ordered_transcripts") or [])
        ordered_tx_by_id = {
            str(tx.get("id") or ""): tx
            for tx in ordered_transcripts_raw
            if str(tx.get("id") or "").strip()
        }
        selected_instance_ids = [str(item.get("transcript_id") or "").strip() for item in instances_raw if str(item.get("transcript_id") or "").strip()]
        selected_instance_id_set = set(selected_instance_ids)
        feature_transcript_id = ""
        for tx in ordered_transcripts_raw:
            tx_id = str(tx.get("id") or "").strip()
            if not tx_id or tx_id not in selected_instance_id_set:
                continue
            if bool(tx.get("is_canonical")):
                feature_transcript_id = tx_id
                break
        if not feature_transcript_id and selected_instance_ids:
            feature_transcript_id = selected_instance_ids[0]

        feature_slices: List[FeatureSlice] = []
        if feature_transcript_id and feature_transcript_id in ordered_tx_by_id and chrom:
            tx = ordered_tx_by_id.get(feature_transcript_id) or {}
            tx_exons = list(tx.get("exons") or [])
            tx_cds_list = list(tx.get("cds_list") or [])
            tx_utrs = list(tx.get("utrs") or [])
            tx_features = _build_tx_feature_intervals(
                fasta=fasta,
                chrom=chrom,
                strand=strand,
                exons=tx_exons,
                cds_list=tx_cds_list,
                utrs=tx_utrs,
            )
            feature_priority = {
                "start_codon": 1,
                "stop_codon": 2,
                "donor": 3,
                "acceptor": 4,
                "utr5": 5,
                "utr3": 6,
                "cds": 7,
                "exon": 8,
                "intron": 9,
            }
            allowed_types = {
                "start_codon", "stop_codon", "donor", "acceptor",
                "utr5", "utr3", "cds", "exon", "intron",
            }
            raw_feature_slices: List[Dict[str, int]] = []
            for feat in sorted(
                tx_features,
                key=lambda x: (feature_priority.get(str(x.get("type", "")), 99), int(x.get("start", 0)))
            ):
                ftype = str(feat.get("type", "")).strip()
                if ftype not in allowed_types:
                    continue
                g_start = int(feat.get("start", 0) or 0)
                g_end = int(feat.get("end", 0) or 0)
                if g_start <= 0 or g_end <= 0:
                    continue
                if g_end < g_start:
                    g_start, g_end = g_end, g_start
                raw_feature_slices.extend(_project_feature_to_window_slices(
                    ftype=ftype,
                    g_start=g_start,
                    g_end=g_end,
                    sequence_type="genomic",
                    strand=strand,
                    segments=[],
                    window_start=int(window_start),
                    window_end=int(window_end),
                ))
            feature_slices = _merge_feature_slices(raw_feature_slices)

        donor_motifs = [str(item.donor_motif or "").upper() for item in instances if str(item.donor_motif or "").strip()]
        acceptor_motifs = [str(item.acceptor_motif or "").upper() for item in instances if str(item.acceptor_motif or "").strip()]
        donor_canonical_count = sum(1 for motif in donor_motifs if motif == "GT")
        acceptor_canonical_count = sum(1 for motif in acceptor_motifs if motif == "AG")
        donor_mode = max(set(donor_motifs), key=donor_motifs.count) if donor_motifs else ""
        acceptor_mode = max(set(acceptor_motifs), key=acceptor_motifs.count) if acceptor_motifs else ""
        start_inclusion_count = sum(1 for item in instances if item.includes_start_codon)
        stop_inclusion_count = sum(1 for item in instances if item.includes_stop_codon)

        return FeatureExplorerExonsDetailResponse(
            selected_exon=ExonDetailSelected(
                exon_state_key=selected.exon_state_key,
                exon_label=selected.exon_label,
                boundary_key=selected.boundary_key,
                chrom=selected.chrom,
                start=selected.start,
                end=selected.end,
                strand=selected.strand,
                length=selected.length,
                state_class=selected.state_class,
                coding_start=selected.coding_start,
                coding_end=selected.coding_end,
                coding_segments=selected.coding_segments,
            ),
            sequence=ExonDetailSequence(
                flank_bp=flank_bp,
                window_start=int(window_start),
                window_end=int(window_end),
                sequence=sequence,
                exon_start_index=int(exon_start_index),
                exon_end_index=int(exon_end_index),
                feature_transcript_id=feature_transcript_id or None,
                features=feature_slices,
            ),
            junctions=ExonDetailJunctions(
                donor_motif=donor_mode,
                donor_total=len(donor_motifs),
                donor_canonical_count=donor_canonical_count,
                donor_is_canonical=bool(len(donor_motifs) > 0 and donor_canonical_count == len(donor_motifs)),
                acceptor_motif=acceptor_mode,
                acceptor_total=len(acceptor_motifs),
                acceptor_canonical_count=acceptor_canonical_count,
                acceptor_is_canonical=bool(len(acceptor_motifs) > 0 and acceptor_canonical_count == len(acceptor_motifs)),
                start_codon_inclusion_count=start_inclusion_count,
                stop_codon_inclusion_count=stop_inclusion_count,
            ),
            instances=instances,
        )

    return await run_in_threadpool(_query)


@app.post("/api/feature_explorer/sequences", response_model=FeatureExplorerSequencesResponse)
async def feature_explorer_sequences(payload: FeatureExplorerSequencesRequest):
    sequence_type = str(payload.sequence_type or "").strip().lower()
    if sequence_type not in {"genomic", "transcript", "cds"}:
        raise HTTPException(status_code=400, detail="sequence_type must be one of: genomic, transcript, cds")
    if not payload.rows:
        raise HTTPException(status_code=400, detail="rows must not be empty")
    if len(payload.rows) > 50:
        raise HTTPException(status_code=400, detail="rows limit exceeded (max 50)")

    genome = str(payload.genome or "reference").strip() or "reference"
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        fasta = genome_context._get_browse_fasta(genome)
        tx_ids = []
        for row in payload.rows:
            tx_id = str(row.transcript_id or "").strip()
            if tx_id and tx_id not in tx_ids:
                tx_ids.append(tx_id)

        tx_map: Dict[str, Dict[str, Any]] = {}
        if tx_ids:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            placeholders = ",".join("?" for _ in tx_ids)
            c.execute(
                f"SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id IN ({placeholders})",
                tx_ids
            )
            for row in c.fetchall():
                tx_id = str(row["id"])
                raw_data = row["data"]
                try:
                    tx_data = json.loads(raw_data) if raw_data else {}
                except Exception:
                    tx_data = {}
                tx_map[tx_id] = {
                    "id": tx_id,
                    "chrom": str(row["chrom"] or ""),
                    "start": int(row["start"] or 0),
                    "end": int(row["end"] or 0),
                    "strand": str(row["strand"] or "+"),
                    "data": tx_data if isinstance(tx_data, dict) else {},
                }
            conn.close()

        feature_priority = {
            "start_codon": 1,
            "stop_codon": 1,
            "donor": 1,
            "acceptor": 1,
            "utr5": 2,
            "utr3": 2,
            "cds": 2,
            "exon": 3,
            "intron": 3,
        }

        rows_out: List[FeatureExplorerSequenceRowResponse] = []
        seg_cache: Dict[Tuple[str, str], Tuple[int, int, List[Dict[str, int]], str]] = {}
        tx_feature_cache: Dict[str, List[Dict[str, Any]]] = {}

        for row_req in payload.rows:
            tx_id = str(row_req.transcript_id or "").strip()
            w_start = int(row_req.window_start or 0)
            w_end = int(row_req.window_end or 0)
            row_len = (w_end - w_start) + 1

            if row_len <= 0:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="window_end must be >= window_start",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="",
                    features=[],
                ))
                continue
            if row_len > 50000:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="Requested window too large (max 50,000 bp)",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="",
                    features=[],
                ))
                continue

            tx = tx_map.get(tx_id)
            if not tx:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="not_found",
                    message="Transcript not found in current genome index",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            chrom = str(tx["chrom"] or "")
            strand = str(tx["strand"] or "+")
            t_start = int(tx["start"] or 0)
            t_end = int(tx["end"] or 0)
            tx_data = tx["data"] if isinstance(tx.get("data"), dict) else {}

            exons = _normalize_interval_list(tx_data.get("exons", []), "exon", strand)
            cds_list = _normalize_interval_list(tx_data.get("cds_list", []), "cds", strand)
            utrs = _normalize_interval_list(tx_data.get("utrs", []), "utr", strand)

            seg_key = (tx_id, sequence_type)
            if seg_key not in seg_cache:
                seg_cache[seg_key] = _build_mode_segments(
                    tx_start=t_start,
                    tx_end=t_end,
                    strand=strand,
                    exons=exons,
                    cds_list=cds_list,
                    sequence_type=sequence_type,
                )
            coord_min, coord_max, segments, seg_status = seg_cache[seg_key]

            if seg_status == "no_cds":
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="no_cds",
                    message="No CDS is defined for this transcript",
                    chrom=chrom,
                    strand=strand,
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue
            if seg_status != "ok":
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="Unable to build coordinate segments for transcript",
                    chrom=chrom,
                    strand=strand,
                    coord_min=coord_min,
                    coord_max=coord_max,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            try:
                if sequence_type == "genomic":
                    seq = _extract_genomic_window_sequence(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        tx_start=t_start,
                        tx_end=t_end,
                        window_start=w_start,
                        window_end=w_end,
                        placeholder="-",
                    )
                else:
                    seq = _extract_window_sequence_from_segments(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        segments=segments,
                        coord_min=coord_min,
                        coord_max=coord_max,
                        window_start=w_start,
                        window_end=w_end,
                        placeholder="-",
                    )
            except Exception as e:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message=f"Sequence fetch failed: {e}",
                    chrom=chrom,
                    strand=strand,
                    coord_min=coord_min,
                    coord_max=coord_max,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            feature_slices: List[FeatureSlice] = []
            if payload.include_features:
                if tx_id not in tx_feature_cache:
                    tx_feature_cache[tx_id] = _build_tx_feature_intervals(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        exons=exons,
                        cds_list=cds_list,
                        utrs=utrs,
                    )
                tx_features = tx_feature_cache[tx_id]

                if sequence_type == "genomic":
                    allowed_types = {
                        "start_codon", "stop_codon", "donor", "acceptor",
                        "utr5", "utr3", "cds", "exon", "intron"
                    }
                elif sequence_type == "transcript":
                    allowed_types = {"start_codon", "stop_codon", "utr5", "utr3", "cds", "exon"}
                else:
                    allowed_types = {"start_codon", "stop_codon", "cds"}

                raw_slices: List[Dict[str, int]] = []
                for feat in sorted(
                    tx_features,
                    key=lambda x: (feature_priority.get(str(x.get("type", "")), 99), int(x.get("start", 0)))
                ):
                    ftype = str(feat.get("type", "")).strip()
                    if ftype not in allowed_types:
                        continue
                    g_start = int(feat.get("start", 0) or 0)
                    g_end = int(feat.get("end", 0) or 0)
                    if g_start <= 0 or g_end <= 0:
                        continue
                    if g_end < g_start:
                        g_start, g_end = g_end, g_start
                    raw_slices.extend(_project_feature_to_window_slices(
                        ftype=ftype,
                        g_start=g_start,
                        g_end=g_end,
                        sequence_type=sequence_type,
                        strand=strand,
                        segments=segments,
                        window_start=w_start,
                        window_end=w_end,
                    ))
                feature_slices = _merge_feature_slices(raw_slices)

            rows_out.append(FeatureExplorerSequenceRowResponse(
                transcript_id=tx_id,
                status="ok",
                message=None,
                chrom=chrom,
                strand=strand,
                coord_min=coord_min,
                coord_max=coord_max,
                window_start=w_start,
                window_end=w_end,
                sequence=seq,
                features=feature_slices,
            ))

        return FeatureExplorerSequencesResponse(
            sequence_type=sequence_type,
            rows=rows_out,
        )

    return await run_in_threadpool(_query)


def _extract_protein_ids_from_gff(
    gff_path: str,
    transcript_ids: set,
    transcript_to_gene: Optional[Dict[str, str]] = None,
) -> dict:
    """Returns {transcript_id: protein_id} by scanning CDS lines in the GFF."""
    result: dict = {}
    remaining = {str(tid).strip() for tid in (transcript_ids or set()) if str(tid).strip()}
    gene_to_tx_ids: Dict[str, List[str]] = {}
    for tx_id, gene_id in (transcript_to_gene or {}).items():
        clean_tx = str(tx_id or "").strip()
        clean_gene = str(gene_id or "").strip()
        if not clean_tx or not clean_gene:
            continue
        gene_to_tx_ids.setdefault(clean_gene, []).append(clean_tx)
    if not remaining or not gff_path or not os.path.exists(gff_path):
        return result
    try:
        with file_io.open_maybe_gz(gff_path, 'r') as f:
            for line in f:
                if not remaining:
                    break
                if not line or line.startswith('#'):
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) < 9 or parts[2] != 'CDS':
                    continue
                attrs = _parse_gff_attributes(parts[8])
                protein_id = attrs.get('protein_id', '')
                if not protein_id:
                    continue

                matched_tx_ids: List[str] = []
                parent_values = [p.strip() for p in str(attrs.get('Parent', '')).split(',') if p.strip()]
                for raw_parent in parent_values:
                    tx_id = re.sub(r'^(?:transcript|mapped_transcript|rna)[:\-]', '', raw_parent)
                    if tx_id and tx_id in remaining:
                        matched_tx_ids.append(tx_id)
                        continue
                    gene_id = re.sub(r'^gene[:\-]', '', raw_parent)
                    for linked_tx_id in gene_to_tx_ids.get(gene_id, []):
                        if linked_tx_id in remaining:
                            matched_tx_ids.append(linked_tx_id)

                if not matched_tx_ids:
                    tx_id = attrs.get('transcript_id', '')
                    if tx_id and tx_id in remaining:
                        matched_tx_ids.append(tx_id)

                for matched_tx_id in matched_tx_ids:
                    if matched_tx_id in result:
                        continue
                    result[matched_tx_id] = protein_id
                    remaining.discard(matched_tx_id)
    except Exception:
        pass
    return result


# ── protein translation ───────────────────────────────────────────────────────
#
# The translation rules themselves live in backend/translation.py; what is here
# is the genome plumbing: which genetic code a contig uses, and how CDS bases are
# read out of the FASTA.

_TRANSLATION_CONTEXT_CACHE: Dict[str, Dict[str, Any]] = {}
_TRANSLATION_CONTEXT_GUARD = threading.Lock()


def _genome_taxid(genome: str, species: Dict[str, Any]) -> int:
    """Best-effort NCBI taxid for a configured genome."""
    for key in ("taxid", "species_taxonomy_id", "taxonomy_id"):
        try:
            value = int(species.get(key) or 0)
        except Exception:
            value = 0
        if value:
            return value

    catalog_key = config_store._find_catalog_species_key(species.get("species_key"))
    info = (getattr(app_state.download_manager, "species_data", {}) or {}).get(catalog_key) or {}
    if isinstance(info, dict):
        for key in ("taxid", "species_taxonomy_id"):
            try:
                value = int(info.get(key) or 0)
            except Exception:
                value = 0
            if value:
                return value

    metadata_path = None
    try:
        metadata_path = genome_context._get_genome_metadata_path(genome)
    except Exception:
        metadata_path = None
    if metadata_path:
        return data_paths._assembly_report_taxid(metadata_path)
    return 0


def _genome_lineage(genome: str, species: Dict[str, Any]) -> Tuple[int, ...]:
    taxid = _genome_taxid(genome, species)
    if not taxid:
        return ()
    classifier = getattr(app_state.download_manager, "taxonomy_classifier", None)
    if classifier is None:
        return ()
    try:
        _resolved, lineage = classifier.lineage_for_taxid(taxid)
    except Exception:
        return ()
    return tuple(lineage)


def _translation_context(genome: str) -> Dict[str, Any]:
    """Per-genome translation settings: contig molecule types and species lineage.

    Cached per genome because it reads the assembly report and the taxonomy
    artifact, and the answer is the same for every transcript of that genome.
    """
    context = genome_context._resolve_browse_genome_context(genome)
    species = context.get("species") or {}
    try:
        metadata_path = genome_context._get_genome_metadata_path(genome)
    except Exception:
        metadata_path = None

    # Keyed on the files too, so re-pointing a genome at a different assembly or
    # annotation does not keep the previous answer.
    cache_key = "\x1f".join([
        str(context.get("cache_key") or genome or "reference"),
        str(context.get("fasta_path") or ""),
        str(metadata_path or ""),
    ])
    with _TRANSLATION_CONTEXT_GUARD:
        cached = _TRANSLATION_CONTEXT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    molecules: Dict[str, str] = {}
    if metadata_path:
        for row in genome_context._load_cached_assembly_report_rows(metadata_path):
            molecule = classify_contig_molecule(row.sequence_name, getattr(row, "molecule_type", ""))
            if molecule == MOLECULE_NUCLEAR:
                continue
            for alias in row.ordered_aliases():
                molecules[str(alias).strip().lower()] = molecule

    resolved = {
        "molecules": molecules,
        "lineage": _genome_lineage(genome, species),
    }
    with _TRANSLATION_CONTEXT_GUARD:
        _TRANSLATION_CONTEXT_CACHE[cache_key] = resolved
    return resolved


def _resolve_translation_table(genome: str, chrom: str) -> Tuple[int, str, bool]:
    """Genetic code for *chrom* of *genome*.

    Returns ``(table, molecule, resolved)`` where ``resolved`` is False when the
    species lineage was unavailable, which lets organelle callers fall back to
    auto-detection instead of silently using the wrong code.
    """
    try:
        context = _translation_context(genome)
    except Exception:
        context = {"molecules": {}, "lineage": ()}

    molecules = context.get("molecules") or {}
    lineage = context.get("lineage") or ()
    molecule = molecules.get(str(chrom or "").strip().lower())
    if not molecule:
        molecule = classify_contig_molecule(chrom)

    table = translation_table_for_lineage(molecule, lineage)
    if table is None:
        return TABLE_STANDARD, molecule, False
    return table, molecule, True


def _cds_dna_from_layout(fasta, chrom: str, strand: str, layout: TranslationLayout) -> str:
    """Concatenate the translated CDS bases in 5'→3' order.

    A segment that cannot be read (contig missing from the FASTA, coordinates off
    the end) is padded with Ns rather than skipped: dropping bases would shift the
    reading frame of everything downstream.
    """
    pieces: List[str] = []
    for segment in layout.segments:
        expected = segment.coord_end - segment.coord_start + 1
        piece = _fetch_oriented_piece(
            fasta, chrom, segment.genomic_start, segment.genomic_end, strand
        )
        if len(piece) < expected:
            piece = piece + ("N" * (expected - len(piece)))
        pieces.append(piece[:expected])
    return "".join(pieces)


def _translate_cds(
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
    table: Optional[int] = None,
) -> str:
    """Amino-acid sequence for a CDS, following Ensembl/RefSeq pep conventions.

    See backend/translation.py for the rules. ``table`` defaults to the standard
    genetic code; callers with a genome in hand should pass the code resolved by
    :func:`_resolve_translation_table` so that organelle genes are not translated
    with the nuclear code.
    """
    protein, _layout, _table = _translate_transcript(
        fasta, chrom, strand, cds_list, table=table
    )
    return protein


def _sequence_view_protein(
    genome: str,
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """One transcript's protein, for the sequence view's panel.

    The genetic code is resolved here rather than by the caller because resolving
    it needs the genome's lineage and its assembly report, which is knowledge this
    module has and ``sequence_view`` deliberately does not -- the package is
    handed the functions it needs instead of importing this one.

    The same call the Feature Explorer's protein rows go through, so the two
    views cannot disagree about a residue. What comes back alongside the protein
    is what the panel has to say about it in words: which code was used, and
    whether the CDS begins mid-codon.
    """
    table, molecule, resolved = _resolve_translation_table(genome, chrom)
    protein, layout, used_table = _translate_transcript(
        fasta, chrom, strand, cds_list,
        table=table, molecule=molecule, autodetect=not resolved,
    )
    return {
        "protein": protein,
        "phase": int(layout.start_phase or 0),
        # Virtual bases standing in for the codon that began outside the CDS, so
        # that residue n is always at positions 3n-2..3n. The padded positions
        # map to no genomic base, which is the honest answer for bases the
        # annotation does not have.
        "pad": int(layout.pad or 0),
        "cds_length": int(layout.cds_length or 0),
        "dropped_trailing": int(layout.dropped_trailing or 0),
        "table": int(used_table),
        "molecule": str(molecule),
        # An internal stop is real information about the annotation -- a
        # readthrough, a frameshift, a mis-annotation -- and the panel says so
        # rather than letting a reader find it by eye.
        "internal_stops": internal_stop_count(protein),
        # Plain dicts rather than the dataclass: `sequence_view` is handed the
        # functions it needs instead of importing this module, and a dataclass
        # crossing that line would be one more thing it had to know about.
        "segments": [
            {
                "coord_start": int(segment.coord_start),
                "coord_end": int(segment.coord_end),
                "genomic_start": int(segment.genomic_start),
                "genomic_end": int(segment.genomic_end),
            }
            for segment in layout.segments
        ],
    }


def _translate_transcript(
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
    table: Optional[int] = None,
    molecule: str = MOLECULE_NUCLEAR,
    autodetect: bool = False,
) -> Tuple[str, TranslationLayout, int]:
    """Translate a transcript, returning the protein, CDS layout and code used."""
    layout = build_translation_layout(cds_list, strand)
    if not layout.segments:
        return "", layout, int(table or TABLE_STANDARD)

    dna = _cds_dna_from_layout(fasta, chrom, strand, layout)
    if not dna:
        return "", layout, int(table or TABLE_STANDARD)

    resolved_table = int(table or TABLE_STANDARD)
    if autodetect and molecule != MOLECULE_NUCLEAR:
        resolved_table = autodetect_organelle_table(dna, start_phase=layout.start_phase)

    protein = translate_cds_dna(dna, start_phase=layout.start_phase, table=resolved_table)
    return protein, layout, resolved_table


@app.post("/api/feature_explorer/proteins", response_model=FeatureExplorerProteinsResponse)
async def feature_explorer_proteins(payload: FeatureExplorerProteinsRequest):
    """Fetch amino-acid sequences for coding transcripts, windowed for panning."""
    if not payload.rows:
        raise HTTPException(status_code=400, detail="rows must not be empty")
    if len(payload.rows) > 50:
        raise HTTPException(status_code=400, detail="rows limit exceeded (max 50)")

    genome = str(payload.genome or "reference").strip() or "reference"
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        fasta = genome_context._get_browse_fasta(genome)

        tx_ids: List[str] = []
        for row in payload.rows:
            tx_id = str(row.transcript_id or "").strip()
            if tx_id and tx_id not in tx_ids:
                tx_ids.append(tx_id)

        # Fetch transcript data from DB
        tx_map: Dict[str, Dict[str, Any]] = {}
        if tx_ids:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            placeholders = ",".join("?" for _ in tx_ids)
            c.execute(
                f"SELECT id, chrom, strand, parent_gene_id, data FROM transcripts WHERE id IN ({placeholders})",
                tx_ids,
            )
            for row in c.fetchall():
                raw_data = row["data"]
                try:
                    tx_data = json.loads(raw_data) if raw_data else {}
                except Exception:
                    tx_data = {}
                tx_map[str(row["id"])] = {
                    "chrom": str(row["chrom"] or ""),
                    "strand": str(row["strand"] or "+"),
                    "parent_gene_id": str(row["parent_gene_id"] or ""),
                    "data": tx_data if isinstance(tx_data, dict) else {},
                }
            conn.close()

        # Read source GFF path to look up protein_id attributes
        source_gff = ""
        try:
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute("SELECT value FROM metadata WHERE key = 'source_gff'")
            row = c.fetchone()
            conn.close()
            source_gff = str(row[0]) if row and row[0] else ""
        except Exception:
            pass
        protein_id_map = _extract_protein_ids_from_gff(
            source_gff,
            set(tx_ids),
            {
                tx_id: str((tx_map.get(tx_id) or {}).get("parent_gene_id") or "")
                for tx_id in tx_ids
            },
        )

        # Translate CDS sequences and cache results per tx_id (avoid re-translating for multiple windows)
        protein_seq_cache: Dict[str, str] = {}
        # Codon-aligned CDS layout per tx_id, reused for the client-side alignment
        layout_cache: Dict[str, TranslationLayout] = {}
        table_cache: Dict[str, int] = {}

        rows_out: List[FeatureExplorerProteinRowResponse] = []
        for row_req in payload.rows:
            tx_id = str(row_req.transcript_id or "").strip()
            w_start = max(1, int(row_req.window_start or 1))
            w_end = max(w_start, int(row_req.window_end or w_start))

            tx = tx_map.get(tx_id)
            if not tx:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id="",
                    status="not_found", message="Transcript not found",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                ))
                continue

            cds_list = tx["data"].get("cds_list", [])
            if not cds_list:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id="",
                    status="no_cds", message="No CDS — non-coding transcript",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                ))
                continue

            if tx_id not in protein_seq_cache:
                # Organelle contigs use their own genetic code; when the species
                # lineage is unknown (manual genomes) fall back to detecting it.
                table, molecule, table_resolved = _resolve_translation_table(genome, tx["chrom"])
                aa, layout, used_table = _translate_transcript(
                    fasta,
                    tx["chrom"],
                    tx["strand"],
                    cds_list,
                    table=table,
                    molecule=molecule,
                    autodetect=not table_resolved,
                )
                protein_seq_cache[tx_id] = aa
                layout_cache[tx_id] = layout
                table_cache[tx_id] = used_table
            aa_seq = protein_seq_cache[tx_id]
            layout = layout_cache[tx_id]

            if not aa_seq:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id=protein_id_map.get(tx_id, ""),
                    status="error", message="Failed to translate CDS sequence",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                    cds_segments=[], strand=tx["strand"],
                    translation_table=table_cache.get(tx_id, TABLE_STANDARD),
                ))
                continue

            protein_len = len(aa_seq)
            w_start = max(1, min(w_start, protein_len))
            w_end = min(w_end, protein_len)
            window_seq = aa_seq[w_start - 1:w_end]
            # Coordinates are codon-aligned: amino acid n covers CDS nucleotides
            # 3n-2..3n, including when a 5'-incomplete CDS shifts the frame.
            seg_objs = [
                CdsSegmentInfo(
                    coord_start=s.coord_start,
                    coord_end=s.coord_end,
                    genomic_start=s.genomic_start,
                    genomic_end=s.genomic_end,
                    phase=s.phase,
                )
                for s in layout.segments
            ]

            rows_out.append(FeatureExplorerProteinRowResponse(
                transcript_id=tx_id,
                protein_id=protein_id_map.get(tx_id, ""),
                status="ok",
                coord_min=1,
                coord_max=protein_len,
                window_start=w_start,
                window_end=w_end,
                sequence=window_seq,
                cds_segments=seg_objs,
                strand=tx["strand"],
                translation_table=table_cache.get(tx_id, TABLE_STANDARD),
                five_prime_partial=layout.five_prime_partial,
                three_prime_partial=layout.three_prime_partial,
            ))

        return FeatureExplorerProteinsResponse(rows=rows_out)

    return await run_in_threadpool(_query)


# ── InterPro domain annotation helpers ─────────────────────────────────────────

# In-memory cache: {protein_id -> ProteinDomainRow}
_domain_cache: Dict[str, "ProteinDomainRow"] = {}
# In-memory cache: {ensp_id -> uniprot_accession}
_uniprot_id_cache: Dict[str, str] = {}


def _lookup_uniprot_id(ensp_id: str) -> str:
    """Map an Ensembl or RefSeq protein ID to a UniProt accession."""
    protein_id = str(ensp_id or "").strip()
    if not protein_id:
        return ""
    cache_key = protein_structure.strip_id_version(protein_id).upper()
    if cache_key in _uniprot_id_cache:
        return _uniprot_id_cache[cache_key]
    try:
        accession = _uniprot_accession_from_api(protein_id)
    except Exception as exc:
        logging.debug("UniProt lookup failed for %s: %s", protein_id, exc)
        return ""
    _uniprot_id_cache[cache_key] = accession
    return accession


def _fetch_interpro_domains(uniprot_id: str) -> List[ProteinDomainEntry]:
    """Fetch domain annotations from InterPro for a UniProt accession."""
    if not uniprot_id:
        return []
    accession = protein_structure.normalize_accession(uniprot_id)
    if not accession:
        return []
    try:
        # Routed through the annotation allowlist rather than a raw urlopen, so
        # this call is subject to the same host and redirect rules as every other
        # outbound request the backend makes.
        url = f"https://www.ebi.ac.uk/interpro/api/entry/all/protein/uniprot/{accession}?format=json"
        data = _annotation_get_json(url) or {}

        domains: List[ProteinDomainEntry] = []
        for result in data.get("results", []):
            meta = result.get("metadata", {})
            acc = meta.get("accession", "")
            name = meta.get("name", "")
            db = meta.get("source_database", "").replace("_", " ").title()
            desc = meta.get("description", "")
            if isinstance(desc, list):
                desc = desc[0].get("text", "") if desc else ""

            # Extract protein locations
            for protein_entry in result.get("proteins", []):
                for loc_group in protein_entry.get("entry_protein_locations", []):
                    for fragment in loc_group.get("fragments", []):
                        start = int(fragment.get("start", 0))
                        end = int(fragment.get("end", 0))
                        if start > 0 and end > 0:
                            domains.append(ProteinDomainEntry(
                                accession=acc,
                                name=name,
                                database=db,
                                start=start,
                                end=end,
                                description=str(desc)[:300],
                            ))

        # Sort by start position
        domains.sort(key=lambda d: (d.start, d.end))
        return domains
    except Exception as exc:
        logging.debug("InterPro fetch failed for %s: %s", uniprot_id, exc)
        return []


@app.post("/api/feature_explorer/protein_domains", response_model=ProteinDomainsResponse)
async def feature_explorer_protein_domains(payload: ProteinDomainsRequest):
    """Fetch InterPro domain annotations for Ensembl protein IDs."""
    if not payload.protein_ids:
        raise HTTPException(status_code=400, detail="protein_ids must not be empty")
    if len(payload.protein_ids) > 20:
        raise HTTPException(status_code=400, detail="protein_ids limit exceeded (max 20)")

    def _query():
        rows_out: List[ProteinDomainRow] = []

        for pid in payload.protein_ids:
            pid = str(pid or "").strip()
            if not pid:
                continue

            # Check cache
            if pid in _domain_cache:
                rows_out.append(_domain_cache[pid])
                continue

            # Map ENSP -> UniProt
            uniprot_id = _lookup_uniprot_id(pid)
            if not uniprot_id:
                row = ProteinDomainRow(
                    protein_id=pid, uniprot_id="",
                    status="not_found",
                    message="Could not map to UniProt accession",
                )
                _domain_cache[pid] = row
                rows_out.append(row)
                continue

            # Fetch domains from InterPro
            domains = _fetch_interpro_domains(uniprot_id)
            row = ProteinDomainRow(
                protein_id=pid,
                uniprot_id=uniprot_id,
                status="ok",
                domains=domains,
            )
            _domain_cache[pid] = row
            rows_out.append(row)

        return ProteinDomainsResponse(rows=rows_out)

    return await run_in_threadpool(_query)


# ── 3D protein structure ───────────────────────────────────────────────────────
#
# AlphaFold DB is keyed by UniProt accession; the annotation this app reads gives
# Ensembl or RefSeq protein IDs. Bridging the two is the bulk of what follows.
# The rules themselves live in backend/protein_structure.py so they can be tested
# without a socket; this layer adds the allowlisted HTTP, the caches, and the
# routes that serve the sandboxed viewer.

STRUCTURE_CONFIG_KEY = "protein_structure"
STRUCTURE_METADATA_TTL_SECONDS = 7 * 24 * 3600
MAX_STRUCTURE_MODEL_BYTES = 96 * 1024 * 1024
ALPHAFOLD_ENTRY_URL = "https://alphafold.ebi.ac.uk/entry/{accession}"
# Marks a cached "no such prediction" answer, so it is not mistaken for a model.
STRUCTURE_ABSENT_KEY = "__absent__"
STRUCTURE_ASSET_DIR = app_paths.BASE_PATH / "static" / "structure"

# A remote accession lookup is the only expensive step in deciding whether a
# transcript has a structure at all, and the answer barely changes. Persisting it
# turns the second visit to a gene into a purely local operation. Misses are
# cached too, on a much shorter clock: "UniProt has nothing for this protein"
# is worth remembering for a day, not for a month.
STRUCTURE_ACCESSION_TTL_SECONDS = 30 * 24 * 3600
STRUCTURE_ACCESSION_MISS_TTL_SECONDS = 24 * 3600
# Probing every coding transcript of a gene costs one lookup each on a cold
# cache, and human genes routinely carry twenty-odd coding transcripts, so the
# ceiling has to clear that or the filter never runs where it is most wanted.
# Past it the panel offers the canonical transcript alone rather than making the
# user wait on a burst of requests.
STRUCTURE_PROBE_MAX_TRANSCRIPTS = 30
STRUCTURE_PROBE_DEADLINE_SECONDS = 8.0
STRUCTURE_PROBE_WORKERS = 6
# Ceilings for the variant overlay. Both are about what a reader can take in on
# a structure, not about what the files hold.
STRUCTURE_VARIANT_LIMIT = 2000
STRUCTURE_VARIANT_TRACK_LIMIT = 8
STRUCTURE_ALIGNMENT_CACHE_SIZE = 32

_structure_lock = threading.Lock()
_alphafold_model_cache: Dict[str, Optional["protein_structure.AlphaFoldModel"]] = {}
_uniprot_accession_cache: Dict[str, str] = {}
_uniprot_accession_disk: Optional[Dict[str, Dict[str, Any]]] = None
_structure_alignment_cache: "OrderedDict[str, Tuple[str, str]]" = OrderedDict()
# {path -> (mtime, mapping)}; a re-imported file is picked up without a restart.
_uniprot_mapping_cache: Dict[str, Tuple[float, "protein_structure.UniProtMapping"]] = {}


def _structure_cache_dir() -> Path:
    path = app_paths.CACHE_DIR / "structures"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _accession_cache_path() -> Path:
    return _structure_cache_dir() / "uniprot_accessions.json"


def _accession_disk_cache() -> Dict[str, Dict[str, Any]]:
    """The persisted protein-ID to accession cache, read once per process."""
    global _uniprot_accession_disk
    with _structure_lock:
        if _uniprot_accession_disk is not None:
            return _uniprot_accession_disk
    loaded: Dict[str, Dict[str, Any]] = {}
    try:
        raw = json.loads(_accession_cache_path().read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for key, entry in raw.items():
                if isinstance(entry, dict):
                    loaded[str(key)] = entry
    except (OSError, ValueError):
        loaded = {}
    with _structure_lock:
        if _uniprot_accession_disk is None:
            _uniprot_accession_disk = loaded
        return _uniprot_accession_disk


def _accession_disk_lookup(key: str) -> Optional[str]:
    """A cached accession, ``""`` for a cached miss, or ``None`` when unknown."""
    entry = _accession_disk_cache().get(key)
    if not isinstance(entry, dict):
        return None
    accession = protein_structure.normalize_accession(entry.get("accession"))
    try:
        stamp = float(entry.get("ts") or 0)
    except (TypeError, ValueError):
        return None
    ttl = STRUCTURE_ACCESSION_TTL_SECONDS if accession else STRUCTURE_ACCESSION_MISS_TTL_SECONDS
    if (time.time() - stamp) > ttl:
        return None
    return accession


def _accession_disk_store(key: str, accession: str) -> None:
    cache = _accession_disk_cache()
    with _structure_lock:
        cache[key] = {"accession": accession or "", "ts": time.time()}
        snapshot = json.dumps(cache)
    path = _accession_cache_path()
    temp = path.with_suffix(".json.tmp")
    try:
        temp.write_text(snapshot, encoding="utf-8")
        temp.replace(path)
    except OSError:
        # A cache that cannot be written is a slower panel, not a broken one.
        temp.unlink(missing_ok=True)


def _annotation_get_json(url: str, timeout: int = 20) -> Any:
    """GET an allowlisted annotation endpoint, returning ``None`` for a 404."""
    with get_with_validated_redirects(
        url,
        validate_annotation_service_url,
        timeout=timeout,
        headers={"Accept": "application/json"},
    ) as response:
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()


def _uniprot_accession_from_api(protein_id: str, preferred_length: int = 0) -> str:
    """Find the UniProt accession that cross-references ``protein_id``."""
    if not str(protein_id or "").strip():
        return ""
    params = protein_structure.uniprot_search_params(protein_id)
    url = f"{protein_structure.UNIPROT_SEARCH_URL}?{urlencode(params)}"
    try:
        payload = _annotation_get_json(url)
    except HTTPException:
        raise
    except Exception as exc:
        logging.debug("UniProt cross-reference lookup failed for %s: %s", protein_id, exc)
        return ""
    return protein_structure.extract_search_accession(payload, preferred_length)


def _load_uniprot_mapping(path: Path) -> Optional["protein_structure.UniProtMapping"]:
    key = str(path)
    try:
        stamp = path.stat().st_mtime
    except OSError:
        return None

    with _structure_lock:
        cached = _uniprot_mapping_cache.get(key)
        if cached and cached[0] == stamp:
            return cached[1]

    try:
        mapping = protein_structure.load_uniprot_mapping_file(path)
    except Exception as exc:
        logging.warning("Could not read UniProt mapping file %s: %s", path, exc)
        return None

    with _structure_lock:
        _uniprot_mapping_cache[key] = (stamp, mapping)
    return mapping


def _configured_mapping_path() -> Optional[Path]:
    try:
        section = (config_store.load_config() or {}).get(STRUCTURE_CONFIG_KEY) or {}
    except Exception:
        return None
    raw = str(section.get("uniprot_map_path") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_file() else None


def _genome_xref_mapping(genome: str) -> Optional["protein_structure.UniProtMapping"]:
    """A UniProt cross-reference table sitting alongside the genome's annotation.

    Ensembl publishes these as an ``xref`` TSV, which the download view already
    knows how to fetch. Finding one makes the lookup fully local.
    """
    try:
        context = genome_context._resolve_browse_genome_context(genome)
    except Exception:
        return None
    gff_path = str(context.get("gff_path") or "")
    if not gff_path:
        return None

    directory = Path(gff_path).parent
    try:
        candidates = sorted(
            entry for entry in directory.glob("*xref*")
            if entry.is_file() and entry.name.lower().endswith((".tsv", ".tsv.gz"))
        )
    except OSError:
        return None

    for candidate in candidates:
        mapping = _load_uniprot_mapping(candidate)
        if mapping and mapping.by_id:
            return mapping
    return None


def _resolve_structure_accession(
    genome: str, protein_id: str, override: str, preferred_length: int = 0
) -> Tuple[str, str]:
    """Find a UniProt accession for ``protein_id``, returning ``(accession, source)``.

    Ordered most trusted first: an accession the user typed, then their own
    mapping file, then a cross-reference shipped with the genome, and only then a
    remote lookup. The first three need no network at all.
    """
    manual = protein_structure.normalize_accession(override)
    if manual:
        return manual, protein_structure.SOURCE_MANUAL

    protein_id = str(protein_id or "").strip()
    if not protein_id:
        return "", ""

    custom_path = _configured_mapping_path()
    if custom_path:
        mapping = _load_uniprot_mapping(custom_path)
        hit = mapping.lookup(protein_id) if mapping else ""
        if hit:
            return hit, protein_structure.SOURCE_CUSTOM_TSV

    xref = _genome_xref_mapping(genome)
    hit = xref.lookup(protein_id) if xref else ""
    if hit:
        return hit, protein_structure.SOURCE_XREF

    cache_key = protein_structure.strip_id_version(protein_id).upper()
    with _structure_lock:
        cached = _uniprot_accession_cache.get(cache_key)
    if cached is None:
        cached = _accession_disk_lookup(cache_key)
    if cached is None:
        cached = _uniprot_accession_from_api(protein_id, preferred_length)
        _accession_disk_store(cache_key, cached)
    with _structure_lock:
        _uniprot_accession_cache[cache_key] = cached

    return (cached, protein_structure.SOURCE_UNIPROT_API) if cached else ("", "")


def _alphafold_model(accession: str) -> Optional["protein_structure.AlphaFoldModel"]:
    """AFDB prediction metadata for ``accession``, memoised in memory and on disk."""
    with _structure_lock:
        if accession in _alphafold_model_cache:
            return _alphafold_model_cache[accession]

    safe = re.sub(r"[^A-Za-z0-9_-]", "", accession)
    meta_path = _structure_cache_dir() / f"AF-{safe}-prediction.json"

    payload: Any = None
    try:
        stat = meta_path.stat()
        age = time.time() - stat.st_mtime
        cached = json.loads(meta_path.read_text(encoding="utf-8"))
        # "AlphaFold has nothing for this accession" is recorded too, on the
        # shorter clock a miss deserves. Without it the dropdown probe repeats a
        # handful of 404s on every restart, for every gene the user revisits.
        absent = isinstance(cached, dict) and cached.get(STRUCTURE_ABSENT_KEY) is True
        ttl = STRUCTURE_ACCESSION_MISS_TTL_SECONDS if absent else STRUCTURE_METADATA_TTL_SECONDS
        if age < ttl:
            if absent:
                with _structure_lock:
                    _alphafold_model_cache[accession] = None
                return None
            payload = cached
    except (OSError, ValueError):
        payload = None

    if payload is None:
        payload = _annotation_get_json(
            protein_structure.ALPHAFOLD_PREDICTION_URL.format(accession=accession)
        )
        temp = meta_path.with_suffix(".json.tmp")
        try:
            body = json.dumps(payload if payload is not None else {STRUCTURE_ABSENT_KEY: True})
            temp.write_text(body, encoding="utf-8")
            temp.replace(meta_path)
        except OSError:
            temp.unlink(missing_ok=True)

    model = protein_structure.parse_alphafold_prediction(payload, accession)
    with _structure_lock:
        _alphafold_model_cache[accession] = model
    return model


def _ensure_model_file(model: "protein_structure.AlphaFoldModel") -> Path:
    """Return the cached mmCIF for ``model``, downloading it once if needed."""
    filename = protein_structure.model_cache_filename(model.accession, model.version)
    destination = _structure_cache_dir() / filename
    if destination.is_file() and destination.stat().st_size > 0:
        return destination

    url = model.cif_url or f"https://alphafold.ebi.ac.uk/files/{filename}"
    temp = destination.with_suffix(".cif.tmp")
    written = 0
    try:
        with get_with_validated_redirects(
            url, validate_annotation_service_url, timeout=60, stream=True
        ) as response:
            response.raise_for_status()
            with open(temp, "wb") as handle:
                for chunk in response.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > MAX_STRUCTURE_MODEL_BYTES:
                        raise HTTPException(
                            status_code=502,
                            detail="AlphaFold model exceeded the size limit",
                        )
                    handle.write(chunk)
        if written <= 0:
            raise HTTPException(status_code=502, detail="AlphaFold returned an empty model file")
        # Atomic: a reader either sees no file or a complete one, never a partial
        # mmCIF that Mol* would fail to parse and then cache as broken.
        temp.replace(destination)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return destination


def _structure_transcript_contexts(
    genome: str, transcript_ids: Sequence[str]
) -> Dict[str, Dict[str, Any]]:
    """Translation, coding-segment layout and protein ID for several transcripts.

    Batched deliberately. ``_extract_protein_ids_from_gff`` scans the source GFF
    until every requested transcript is found, so calling it once per transcript
    would turn a dropdown probe into one full pass over the annotation per
    option. One pass covers the whole set instead.
    """
    wanted: List[str] = []
    for raw in transcript_ids or ():
        token = str(raw or "").strip()
        if token and token not in wanted:
            wanted.append(token)
    if not wanted:
        return {}

    db_path = genome_context._get_browse_db(genome)
    fasta = genome_context._get_browse_fasta(genome)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in wanted)
        cursor.execute(
            f"SELECT id, chrom, strand, parent_gene_id, data FROM transcripts WHERE id IN ({placeholders})",
            wanted,
        )
        rows = {str(row["id"]): row for row in cursor.fetchall()}
        source_gff = ""
        cursor.execute("SELECT value FROM metadata WHERE key = 'source_gff'")
        meta = cursor.fetchone()
        if meta and meta[0]:
            source_gff = str(meta[0])
    finally:
        conn.close()

    protein_ids = _extract_protein_ids_from_gff(
        source_gff,
        set(rows.keys()),
        {tx_id: str(row["parent_gene_id"] or "") for tx_id, row in rows.items()},
    )

    contexts: Dict[str, Dict[str, Any]] = {}
    for transcript_id in wanted:
        row = rows.get(transcript_id)
        if not row:
            contexts[transcript_id] = {"status": "not_found", "message": "Transcript not found"}
            continue

        try:
            data = json.loads(row["data"]) if row["data"] else {}
        except Exception:
            data = {}
        cds_list = (data or {}).get("cds_list") or []
        if not cds_list:
            contexts[transcript_id] = {"status": "no_cds", "message": "No CDS — non-coding transcript"}
            continue

        chrom = str(row["chrom"] or "")
        strand = str(row["strand"] or "+")
        table, molecule, table_resolved = _resolve_translation_table(genome, chrom)
        protein, layout, used_table = _translate_transcript(
            fasta, chrom, strand, cds_list,
            table=table, molecule=molecule, autodetect=not table_resolved,
        )
        if not protein:
            contexts[transcript_id] = {"status": "error", "message": "Failed to translate CDS sequence"}
            continue

        contexts[transcript_id] = {
            "status": "ok",
            "message": "",
            "protein": protein,
            "protein_id": protein_ids.get(transcript_id, ""),
            "chrom": chrom,
            "strand": strand,
            "table": used_table,
            "layout": layout,
            "segments": [
                {
                    "coord_start": segment.coord_start,
                    "coord_end": segment.coord_end,
                    "genomic_start": segment.genomic_start,
                    "genomic_end": segment.genomic_end,
                    "phase": segment.phase,
                }
                for segment in layout.segments
            ],
        }

    return contexts


def _structure_transcript_context(genome: str, transcript_id: str) -> Dict[str, Any]:
    """Translation, coding-segment layout and protein ID for one transcript."""
    transcript_id = str(transcript_id or "").strip()
    if not transcript_id:
        return {"status": "not_found", "message": "transcript_id is required"}
    contexts = _structure_transcript_contexts(genome, [transcript_id])
    return contexts.get(transcript_id) or {"status": "not_found", "message": "Transcript not found"}


def _model_info(model: "protein_structure.AlphaFoldModel", token: str) -> StructureModelInfo:
    query = f"?token={quote(token)}" if token else ""
    return StructureModelInfo(
        accession=model.accession,
        model_entity_id=model.model_entity_id,
        version=model.version,
        sequence_length=len(model.sequence or ""),
        sequence_start=model.sequence_start,
        sequence_end=model.sequence_end,
        fragment_count=model.fragment_count,
        model_url=f"{STRUCTURE_VIEWER_PREFIX}model/{quote(model.accession)}{query}",
        afdb_url=ALPHAFOLD_ENTRY_URL.format(accession=model.accession),
    )


@app.post("/api/structure/resolve", response_model=StructureResolveResponse)
async def structure_resolve(payload: StructureResolveRequest):
    """Find the AlphaFold model for a transcript's translation."""
    genome = str(payload.genome or "reference").strip() or "reference"
    transcript_id = str(payload.transcript_id or "").strip()
    override = str(payload.accession_override or "").strip()

    if not transcript_id and not str(payload.protein_id or "").strip() and not override:
        raise HTTPException(status_code=400, detail="transcript_id, protein_id or accession_override is required")

    def _query() -> StructureResolveResponse:
        protein_id = str(payload.protein_id or "").strip()
        protein_length = 0

        if transcript_id:
            context = _structure_transcript_context(genome, transcript_id)
            if context.get("status") != "ok":
                return StructureResolveResponse(
                    transcript_id=transcript_id,
                    status=str(context.get("status") or "error"),
                    message=str(context.get("message") or ""),
                )
            protein_id = protein_id or str(context.get("protein_id") or "")
            protein_length = len(str(context.get("protein") or ""))

        accession, source = _resolve_structure_accession(
            genome, protein_id, override, preferred_length=protein_length
        )
        if not accession:
            return StructureResolveResponse(
                transcript_id=transcript_id,
                protein_id=protein_id,
                status="no_accession",
                protein_length=protein_length,
                message=(
                    "No UniProt accession found for this protein. Enter one manually, or "
                    "import a mapping file, to load a structure."
                ),
            )

        model = _alphafold_model(accession)
        if model is None or not model.sequence:
            return StructureResolveResponse(
                transcript_id=transcript_id,
                protein_id=protein_id,
                uniprot_accession=accession,
                source=source,
                status="no_model",
                protein_length=protein_length,
                message=f"AlphaFold DB has no model for {accession}.",
            )

        _ensure_model_file(model)
        return StructureResolveResponse(
            transcript_id=transcript_id,
            protein_id=protein_id,
            uniprot_accession=accession,
            source=source,
            status="ok",
            protein_length=protein_length,
            model=_model_info(model, API_TOKEN),
        )

    return await run_in_threadpool(_query)


@app.post("/api/structure/residue_map", response_model=StructureResidueMapResponse)
async def structure_residue_map(payload: StructureResidueMapRequest):
    """Project each coding exon of a transcript onto model residue ranges."""
    genome = str(payload.genome or "reference").strip() or "reference"
    transcript_id = str(payload.transcript_id or "").strip()
    accession = protein_structure.normalize_accession(payload.accession)
    if not transcript_id:
        raise HTTPException(status_code=400, detail="transcript_id is required")
    if not accession:
        raise HTTPException(status_code=400, detail="A valid UniProt accession is required")

    def _query() -> StructureResidueMapResponse:
        context = _structure_transcript_context(genome, transcript_id)
        if context.get("status") != "ok":
            return StructureResidueMapResponse(
                transcript_id=transcript_id,
                accession=accession,
                status=str(context.get("status") or "error"),
                message=str(context.get("message") or ""),
            )

        model = _alphafold_model(accession)
        if model is None or not model.sequence:
            return StructureResidueMapResponse(
                transcript_id=transcript_id,
                accession=accession,
                status="no_model",
                message=f"AlphaFold DB has no model for {accession}.",
            )

        segments = context["segments"]
        strand = str(context.get("strand") or "+")
        residue_map = protein_structure.build_residue_map(
            str(context.get("protein") or ""),
            model,
            segments,
            strand,
            align_fn=_structure_align,
        )

        return StructureResidueMapResponse(
            transcript_id=transcript_id,
            accession=accession,
            status="ok",
            identical=residue_map.identical,
            aligned=residue_map.aligned,
            identity=residue_map.identity,
            coverage=residue_map.coverage,
            local_length=residue_map.local_length,
            model_length=residue_map.model_length,
            exon_count=residue_map.exon_count,
            unmapped_residues=residue_map.unmapped_residues,
            strand=strand,
            segments=[
                StructureResidueSegment(
                    exon_index=item.exon_index,
                    aa_start=item.aa_start,
                    aa_end=item.aa_end,
                    model_start=item.model_start,
                    model_end=item.model_end,
                    genomic_start=item.genomic_start,
                    genomic_end=item.genomic_end,
                )
                for item in residue_map.segments
            ],
            warnings=residue_map.warnings,
        )

    return await run_in_threadpool(_query)


def _structure_align(local_seq: str, model_seq: str) -> Tuple[str, str]:
    """Pairwise-align a translation against a model sequence with the bundled MAFFT.

    Memoised on the sequence pair: reconciling a non-canonical isoform takes
    seconds, and the exon overlay and the variant overlay both need the very same
    alignment. Returns empty strings when MAFFT is unavailable or fails, which the
    residue mapper reports as an unreconciled pair rather than a broken request:
    an isoform we cannot align is a caveat to show, not an error to raise.
    """
    key = hashlib.sha1(f"{local_seq}\n{model_seq}".encode("utf-8")).hexdigest()
    with _structure_lock:
        cached = _structure_alignment_cache.get(key)
        if cached is not None:
            _structure_alignment_cache.move_to_end(key)
            return cached

    try:
        result = run_mafft_alignment(local_seq, model_seq)
    except Exception as exc:
        logging.warning("MAFFT alignment for structure mapping failed: %s", exc)
        result = ("", "")

    with _structure_lock:
        _structure_alignment_cache[key] = result
        _structure_alignment_cache.move_to_end(key)
        while len(_structure_alignment_cache) > STRUCTURE_ALIGNMENT_CACHE_SIZE:
            _structure_alignment_cache.popitem(last=False)
    return result


def _probe_structure_option(
    genome: str, transcript_id: str, context: Dict[str, Any], deadline: float
) -> StructureTranscriptOption:
    """Decide whether one transcript has a model, without raising."""
    status = str(context.get("status") or "error")
    if status != "ok":
        return StructureTranscriptOption(
            transcript_id=transcript_id,
            status=status,
            message=str(context.get("message") or ""),
        )

    protein = str(context.get("protein") or "")
    protein_id = str(context.get("protein_id") or "")
    option = StructureTranscriptOption(
        transcript_id=transcript_id,
        protein_id=protein_id,
        protein_length=len(protein),
    )

    if time.monotonic() > deadline:
        option.status = "unknown"
        option.message = "Lookup did not finish in time"
        return option

    try:
        accession, source = _resolve_structure_accession(genome, protein_id, "", len(protein))
    except Exception as exc:
        logging.debug("Structure probe accession lookup failed for %s: %s", transcript_id, exc)
        option.status = "unknown"
        option.message = "Could not reach the accession lookup"
        return option

    if not accession:
        option.status = "no_accession"
        option.message = "No UniProt accession found for this translation"
        return option

    option.accession = accession
    option.source = source

    try:
        model = _alphafold_model(accession)
    except Exception as exc:
        logging.debug("Structure probe model lookup failed for %s: %s", accession, exc)
        option.status = "unknown"
        option.message = "Could not reach AlphaFold DB"
        return option

    if model is None or not model.sequence:
        option.status = "no_model"
        option.message = f"AlphaFold DB has no model for {accession}"
        return option

    option.status = "ok"
    option.model_version = model.version
    option.model_length = len(model.sequence)
    option.identical = protein == model.sequence
    return option


@app.post("/api/structure/transcripts", response_model=StructureTranscriptsResponse)
async def structure_transcripts(payload: StructureTranscriptsRequest):
    """Report which of a gene's transcripts actually have an AlphaFold model.

    The panel uses this to stop offering transcripts that lead nowhere. Every
    answer here is bounded: a large transcript set is not probed at all, and a
    slow network yields ``unknown`` entries rather than a hanging request, so the
    caller can always fall back to the canonical transcript.
    """
    genome = str(payload.genome or "reference").strip() or "reference"

    def _query() -> StructureTranscriptsResponse:
        wanted: List[str] = []
        for raw in payload.transcript_ids or []:
            token = str(raw or "").strip()
            if token and token not in wanted:
                wanted.append(token)

        if not wanted:
            return StructureTranscriptsResponse(mode="probed", checked=0)
        if len(wanted) > STRUCTURE_PROBE_MAX_TRANSCRIPTS:
            return StructureTranscriptsResponse(
                mode="canonical_only",
                checked=0,
                message=(
                    f"{len(wanted)} coding transcripts is more than this panel checks "
                    "one by one; showing the canonical transcript."
                ),
            )

        contexts = _structure_transcript_contexts(genome, wanted)
        deadline = time.monotonic() + STRUCTURE_PROBE_DEADLINE_SECONDS
        workers = max(1, min(STRUCTURE_PROBE_WORKERS, len(wanted)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            entries = list(pool.map(
                lambda tid: _probe_structure_option(
                    genome, tid, contexts.get(tid) or {"status": "not_found"}, deadline,
                ),
                wanted,
            ))

        unknown = sum(1 for entry in entries if entry.status == "unknown")
        if unknown == len(entries):
            return StructureTranscriptsResponse(
                mode="canonical_only",
                checked=len(entries),
                message="Could not check which transcripts have models; showing the canonical transcript.",
                entries=entries,
            )
        return StructureTranscriptsResponse(
            mode="partial" if unknown else "probed",
            checked=len(entries),
            message=(
                f"{unknown} transcript(s) could not be checked in time."
                if unknown else ""
            ),
            entries=entries,
        )

    return await run_in_threadpool(_query)


def _structure_local_to_model(
    protein: str, model: "protein_structure.AlphaFoldModel",
) -> Dict[int, int]:
    """Local amino-acid index -> model residue number, fragment offset included."""
    mapping, _identity, _aligned, _matches = protein_structure.align_local_to_model(
        protein, model.sequence, align_fn=_structure_align,
    )
    offset = max(0, int(model.sequence_start or 1) - 1)
    return {local: residue + offset for local, residue in mapping.items()}


def _translate_codon(codon: str, table: int) -> str:
    """One amino acid for a three-base codon; ``*`` for a stop, ``""`` on failure."""
    try:
        return str(Seq(str(codon).upper()).translate(table=int(table)))
    except Exception:
        return ""


def _structure_variant_from_record(
    rec,
    track_id: str,
    chrom: str,
    strand: str,
    table: int,
    segments: List[Dict[str, Any]],
    pad: int,
    dna: str,
    local_to_model: Dict[int, int],
) -> Optional[StructureVariant]:
    """Project one VCF record onto a model residue, or ``None`` if it misses the CDS."""
    ref = str(rec.ref or "")
    alts = [str(a) for a in (rec.alts or []) if a]
    if not ref or not alts:
        return None

    # A deletion's REF begins on a padding base that may sit in an intron, so the
    # first position of the record is not necessarily the first coding one.
    coord = None
    position = int(rec.pos)
    span_end = position + max(1, len(ref)) - 1
    for candidate in range(position, span_end + 1):
        coord = protein_structure.genomic_to_cds_coord(segments, strand, candidate)
        if coord is not None:
            position = candidate
            break
    if coord is None:
        return None

    aa_index = (coord + 2) // 3
    model_residue = local_to_model.get(aa_index, 0)
    if not model_residue:
        return None

    variant = StructureVariant(
        track_id=track_id,
        chrom=chrom,
        pos=int(rec.pos),
        ref=ref[:40],
        alt=",".join(alts)[:80],
        variant_id=str(rec.id or ""),
        aa_index=aa_index,
        model_residue=model_residue,
        exon_index=protein_structure.exon_index_for_coord(segments, coord),
    )

    minus = str(strand or "+") == "-"
    is_snv = len(ref) == 1 and all(len(alt) == 1 for alt in alts)
    if not is_snv:
        variant.consequence = protein_structure.classify_indel(ref, alts[0])
        variant.impact = protein_structure.variant_impact(variant.consequence)
        return variant

    codon_start = (aa_index - 1) * 3 + 1
    first = codon_start - pad
    last = first + 2
    if first < 1 or last > len(dna):
        # A codon that runs off the 5' pad or the end of the read sequence cannot
        # be retranslated; the position is still worth showing.
        variant.consequence = "protein_altering"
        variant.impact = protein_structure.variant_impact(variant.consequence)
        return variant

    codon = dna[first - 1:last].upper()
    offset = coord - codon_start
    ref_base = protein_structure.reverse_complement(ref) if minus else ref.upper()
    alt_base = protein_structure.reverse_complement(alts[0]) if minus else alts[0].upper()
    variant.ref_mismatch = codon[offset] != ref_base

    alt_codon = codon[:offset] + alt_base + codon[offset + 1:]
    variant.ref_aa = _translate_codon(codon, table)
    variant.alt_aa = _translate_codon(alt_codon, table)
    variant.consequence = protein_structure.classify_substitution(
        variant.ref_aa, variant.alt_aa, aa_index,
    )
    variant.impact = protein_structure.variant_impact(variant.consequence)
    return variant


def _structure_variants_for_track(
    track: Dict[str, Any],
    chrom: str,
    strand: str,
    table: int,
    segments: List[Dict[str, Any]],
    pad: int,
    dna: str,
    local_to_model: Dict[int, int],
    limit: int,
) -> StructureVariantTrackResult:
    """Read one registered VCF over a transcript's coding exons."""
    result = StructureVariantTrackResult(
        track_id=str(track.get("id") or ""),
        label=str(track.get("label") or ""),
    )
    path = str(track.get("path") or "")

    try:
        with locked_vcf(path) as (handle, _fingerprint, _resolved_path):
            resolved_chrom = _resolve_vcf_chrom(handle, chrom)
            if not resolved_chrom:
                result.status = "unreadable"
                result.message = f"{chrom} is not present in this VCF"
                return result

            seen: Set[Tuple[int, str, str]] = set()
            for segment in segments:
                if len(result.variants) >= limit:
                    result.truncated = True
                    break
                start = int(segment.get("genomic_start") or 0)
                end = int(segment.get("genomic_end") or 0)
                if start <= 0 or end < start:
                    continue
                # Reach one base to the left so a deletion whose padding base sits
                # just outside the exon still surfaces.
                for rec in handle.fetch(resolved_chrom, max(0, start - 2), end):
                    if len(result.variants) >= limit:
                        result.truncated = True
                        break
                    key = (int(rec.pos), str(rec.ref or ""), ",".join(str(a) for a in (rec.alts or [])))
                    if key in seen:
                        continue
                    seen.add(key)
                    variant = _structure_variant_from_record(
                        rec, result.track_id, chrom, strand, table,
                        segments, pad, dna, local_to_model,
                    )
                    if variant is None:
                        continue
                    if variant.ref_mismatch:
                        result.ref_mismatches += 1
                    result.variants.append(variant)
    except HTTPException as exc:
        result.status = "unreadable"
        result.message = str(exc.detail)
        return result
    except Exception as exc:
        logging.warning("Reading VCF %s for the structure panel failed: %s", path, exc)
        result.status = "unreadable"
        result.message = "Could not read this VCF"
        return result

    result.variants.sort(key=lambda item: (item.aa_index, item.pos))
    return result


@app.post("/api/structure/variants", response_model=StructureVariantsResponse)
async def structure_variants(payload: StructureVariantsRequest):
    """Project variants from registered VCFs onto a transcript's modelled residues.

    Only the transcript's coding exons are read, and every consequence is derived
    from the codon itself rather than from a CSQ/ANN field, so an unannotated VCF
    is just as informative as an annotated one.
    """
    genome = str(payload.genome or "reference").strip() or "reference"
    transcript_id = str(payload.transcript_id or "").strip()
    accession = protein_structure.normalize_accession(payload.accession)
    if not transcript_id:
        raise HTTPException(status_code=400, detail="transcript_id is required")
    if not accession:
        raise HTTPException(status_code=400, detail="A valid UniProt accession is required")

    track_ids: List[str] = []
    for raw in payload.track_ids or []:
        token = str(raw or "").strip()
        if token and token not in track_ids:
            track_ids.append(token)
    if len(track_ids) > STRUCTURE_VARIANT_TRACK_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"At most {STRUCTURE_VARIANT_TRACK_LIMIT} variant tracks can be shown at once",
        )

    def _query() -> StructureVariantsResponse:
        response = StructureVariantsResponse(transcript_id=transcript_id, accession=accession)
        if not track_ids:
            return response

        context = _structure_transcript_context(genome, transcript_id)
        if context.get("status") != "ok":
            response.status = str(context.get("status") or "error")
            response.message = str(context.get("message") or "")
            return response

        model = _alphafold_model(accession)
        if model is None or not model.sequence:
            response.status = "no_model"
            response.message = f"AlphaFold DB has no model for {accession}."
            return response

        protein = str(context.get("protein") or "")
        local_to_model = _structure_local_to_model(protein, model)
        if not local_to_model:
            response.status = "error"
            response.message = "Could not align the translation to the model."
            return response

        layout = context.get("layout")
        chrom = str(context.get("chrom") or "")
        strand = str(context.get("strand") or "+")
        dna = _cds_dna_from_layout(genome_context._get_browse_fasta(genome), chrom, strand, layout)

        # Tutorial-aware, like every other reader of the registry: during a tutorial the
        # only VCF tracks in scope are the tutorial's own.
        config = routes.tracks._tracks_config()
        registry = routes.tracks._load_track_registry(config)
        by_id = {str(item.get("id") or ""): item for item in registry.get("tracks", [])}

        remaining = STRUCTURE_VARIANT_LIMIT
        for track_id in track_ids:
            track = by_id.get(track_id)
            if not track:
                response.tracks.append(StructureVariantTrackResult(
                    track_id=track_id, status="not_found", message="Track is no longer registered",
                ))
                continue
            if str(track.get("type") or "") != "vcf":
                response.tracks.append(StructureVariantTrackResult(
                    track_id=track_id,
                    label=str(track.get("label") or ""),
                    status="wrong_type",
                    message="Not a VCF track",
                ))
                continue
            if not str(track.get("genome_key") or "").strip():
                # A track with no assembly recorded cannot be checked against the
                # genome in view, and plotting it would be a guess.
                response.tracks.append(StructureVariantTrackResult(
                    track_id=track_id,
                    label=str(track.get("label") or ""),
                    status="wrong_type",
                    message="This VCF is not registered against an assembly",
                ))
                continue

            result = _structure_variants_for_track(
                track, chrom, strand, int(context.get("table") or TABLE_STANDARD),
                context["segments"], int(getattr(layout, "pad", 0) or 0),
                dna, local_to_model, remaining,
            )
            remaining = max(0, remaining - len(result.variants))
            if result.ref_mismatches:
                response.warnings.append(
                    f"{result.label or track_id}: {result.ref_mismatches} variant(s) have a REF allele "
                    "that disagrees with the loaded genome — check the VCF is on this assembly."
                )
            response.tracks.append(result)

        return response

    return await run_in_threadpool(_query)


@app.get("/api/structure/mapping", response_model=StructureMappingStatusResponse)
async def structure_mapping_status():
    """Report the user-supplied protein-ID to UniProt mapping file, if any."""
    def _query() -> StructureMappingStatusResponse:
        path = _configured_mapping_path()
        if not path:
            return StructureMappingStatusResponse(configured=False)
        mapping = _load_uniprot_mapping(path)
        if mapping is None:
            return StructureMappingStatusResponse(
                configured=True, path=str(path),
                message="The mapping file could not be read.",
            )
        return StructureMappingStatusResponse(
            configured=True,
            path=str(path),
            format=mapping.format,
            entry_count=len(mapping.by_id),
            row_count=mapping.row_count,
        )

    return await run_in_threadpool(_query)


@app.post("/api/structure/mapping/import", response_model=StructureMappingStatusResponse)
async def structure_mapping_import(payload: StructureMappingImportRequest):
    """Adopt a user's own protein-ID to UniProt-accession table."""
    raw = str(payload.path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="path is required")

    def _query() -> StructureMappingStatusResponse:
        source = Path(raw).expanduser()
        if not source.is_file():
            raise HTTPException(status_code=404, detail=f"Mapping file not found: {source}")

        mapping = protein_structure.load_uniprot_mapping_file(source)
        if not mapping.by_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No protein-ID to UniProt-accession pairs were found. Expected either an "
                    "Ensembl xref TSV or two columns of protein_id and accession."
                ),
            )

        destination = _structure_cache_dir() / f"uniprot_map{''.join(source.suffixes[-2:]) or '.tsv'}"
        try:
            shutil.copy2(source, destination)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to copy mapping file: {exc}")

        config = config_store.load_config() or {}
        config[STRUCTURE_CONFIG_KEY] = {
            **(config.get(STRUCTURE_CONFIG_KEY) or {}),
            "uniprot_map_path": str(destination),
            "uniprot_map_origin": str(source),
            "uniprot_map_imported_at": datetime.now().isoformat(timespec="seconds"),
        }
        config_store.save_config(config)

        with _structure_lock:
            _uniprot_accession_cache.clear()
        return StructureMappingStatusResponse(
            configured=True,
            path=str(destination),
            format=mapping.format,
            entry_count=len(mapping.by_id),
            row_count=mapping.row_count,
        )

    return await run_in_threadpool(_query)


@app.post("/api/structure/mapping/clear", response_model=StructureMappingStatusResponse)
async def structure_mapping_clear():
    """Stop using the imported mapping file and fall back to the other sources."""
    def _query() -> StructureMappingStatusResponse:
        config = config_store.load_config() or {}
        section = dict(config.get(STRUCTURE_CONFIG_KEY) or {})
        section.pop("uniprot_map_path", None)
        section.pop("uniprot_map_origin", None)
        section.pop("uniprot_map_imported_at", None)
        config[STRUCTURE_CONFIG_KEY] = section
        config_store.save_config(config)
        with _structure_lock:
            _uniprot_accession_cache.clear()
        return StructureMappingStatusResponse(configured=False)

    return await run_in_threadpool(_query)


# ── Sandboxed viewer ───────────────────────────────────────────────────────────
#
# Mol* needs 'unsafe-eval', which the app's own renderer must not grant. These
# routes serve the viewer from the backend origin so it runs under its own,
# separate policy with no access to the renderer's context or its API token.

STRUCTURE_VIEWER_CSP = (
    "default-src 'none'; "
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    # Mol* instantiates a WebAssembly module from a data: URI via fetch, which
    # connect-src governs; without data: here the viewer loads but cannot render.
    "connect-src 'self' data:; "
    "worker-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'"
)
STRUCTURE_ASSET_CONTENT_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}
# The hand-written page and the vendored bundle sit in separate directories but
# are addressed by leaf name, so a viewer asset never carries a path separator.
STRUCTURE_ASSET_ROOTS = ("", "vendor")


def _structure_no_store(headers: Dict[str, str]) -> Dict[str, str]:
    headers.setdefault("Cache-Control", "no-store")
    headers.setdefault("X-Content-Type-Options", "nosniff")
    return headers


@app.get("/structure/viewer")
async def structure_viewer_page():
    """The iframe page hosting the Mol* viewer."""
    page = STRUCTURE_ASSET_DIR / "viewer.html"
    if not page.is_file():
        raise HTTPException(
            status_code=503,
            detail=(
                "The structure viewer assets are not installed. Run "
                "'npm run prepare:structure-viewer' in the frontend directory."
            ),
        )
    query = f"?token={quote(API_TOKEN)}" if API_TOKEN else ""
    markup = page.read_text(encoding="utf-8").replace("__STRUCTURE_QUERY__", query)
    return HTMLResponse(
        content=markup,
        headers=_structure_no_store({"Content-Security-Policy": STRUCTURE_VIEWER_CSP}),
    )


@app.get("/structure/assets/{filename}")
async def structure_viewer_asset(filename: str):
    """Serve one vendored viewer asset from the structure directory."""
    safe = sanitize_leaf_filename(filename)
    suffix = Path(safe).suffix.lower()
    if suffix not in STRUCTURE_ASSET_CONTENT_TYPES:
        raise HTTPException(status_code=404, detail="Unknown viewer asset")

    path = None
    for root in STRUCTURE_ASSET_ROOTS:
        candidate = require_path_within(STRUCTURE_ASSET_DIR, STRUCTURE_ASSET_DIR / root / safe)
        if candidate.is_file():
            path = candidate
            break
    if path is None:
        raise HTTPException(status_code=404, detail=f"Viewer asset not found: {safe}")

    return FileResponse(
        path,
        media_type=STRUCTURE_ASSET_CONTENT_TYPES[suffix],
        headers=_structure_no_store({"Content-Security-Policy": STRUCTURE_VIEWER_CSP}),
    )


@app.get("/structure/model/{accession}")
async def structure_model_file(accession: str):
    """Serve the cached AlphaFold mmCIF the viewer loads.

    Proxied rather than linked so the viewer never reaches the network itself:
    its own CSP restricts it to ``connect-src 'self'``.
    """
    normalized = protein_structure.normalize_accession(accession)
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid UniProt accession")

    def _query() -> Path:
        model = _alphafold_model(normalized)
        if model is None or not model.sequence:
            raise HTTPException(status_code=404, detail=f"AlphaFold DB has no model for {normalized}")
        return _ensure_model_file(model)

    path = await run_in_threadpool(_query)
    return FileResponse(
        path,
        media_type="chemical/x-mmcif",
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


def _normalize_chrom_token(token: str) -> str:
    t = (token or "").strip()
    if t.lower().startswith("chr"):
        t = t[3:]
    upper = t.upper()
    if upper in {"M", "MT", "CHRM", "CHRMT"}:
        return "MT"
    return upper


def _resolve_bigwig_chrom_name(
    requested_chrom: str,
    chrom_sizes: Dict[str, int],
    requested_chrom_len: Optional[int] = None,
) -> Optional[str]:
    if requested_chrom in chrom_sizes:
        return requested_chrom

    if requested_chrom.startswith("chr"):
        alt = requested_chrom[3:]
        if alt in chrom_sizes:
            return alt
    else:
        alt = f"chr{requested_chrom}"
        if alt in chrom_sizes:
            return alt

    mt_alts = {
        "MT": ["chrM", "M", "chrMT"],
        "chrM": ["MT", "M", "chrMT"],
        "M": ["MT", "chrM", "chrMT"],
        "chrMT": ["MT", "chrM", "M"],
    }
    for alt in mt_alts.get(requested_chrom, []):
        if alt in chrom_sizes:
            return alt

    # Case-insensitive exact name fallback.
    req_lower = requested_chrom.lower()
    for key in chrom_sizes.keys():
        if key.lower() == req_lower:
            return key

    # Ensembl-style BigWig names often look like:
    # chromosome:GRCm39:4:1:156860686:1
    # scaffold:GRCm39:GL456239.1:1:40056:1
    req_norm = _normalize_chrom_token(requested_chrom)
    token_matches: List[str] = []
    for key in chrom_sizes.keys():
        parts = key.split(":")
        if len(parts) >= 3 and _normalize_chrom_token(parts[2]) == req_norm:
            token_matches.append(key)
    if token_matches:
        token_matches.sort(key=lambda k: (0 if k.startswith("chromosome:") else 1, len(k)))
        return token_matches[0]

    # Last-resort fallback by chromosome length if provided by the active genome FASTA.
    if requested_chrom_len and requested_chrom_len > 0:
        len_matches = [k for k, v in chrom_sizes.items() if int(v) == int(requested_chrom_len)]
        if len_matches:
            len_matches.sort(key=lambda k: (0 if k.startswith("chromosome:") else 1, len(k)))
            return len_matches[0]

    return None


def _bigwig_binned_means(
    bw: Any,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    chrom_len: int,
    exact: bool = False,
) -> List[Optional[float]]:
    """Mean signal in `bins` equal bins spanning [start, end), None past the chromosome.

    Callers place bin i at start + i * (end - start) / bins, so the bins must keep that
    width even where the range runs off the end of the chromosome. Asking pyBigWig for
    `bins` bins over the clipped range instead squeezed them into the part that exists,
    and the browser then drew the last tile of every chromosome stretched to the right.
    """
    out: List[Optional[float]] = [None] * bins
    q_start = max(0, start)
    q_end = min(end, chrom_len) if chrom_len > 0 else end
    if bins <= 0 or end <= start or q_end <= q_start:
        return out

    bin_size = (end - start) / bins
    edge = lambda index: start + int(round(index * bin_size))  # noqa: E731
    # Bins wholly inside the chromosome, then the part-bins at either edge of it.
    lo = math.ceil((q_start - start) / bin_size)
    hi = math.floor((q_end - start) / bin_size)
    spans: List[Tuple[int, int, int, int]] = []  # (first bin, bin count, query start, query end)
    if hi > lo:
        spans.append((lo, hi - lo, edge(lo), edge(hi)))
    if lo > 0 and q_start < edge(lo):
        spans.append((lo - 1, 1, q_start, min(edge(lo), q_end)))
    if hi < bins and edge(hi) < q_end and hi >= lo:
        spans.append((hi, 1, edge(hi), q_end))

    for first, count, q0, q1 in spans:
        if q1 <= q0:
            continue
        raw = bw.stats(chrom, q0, q1, type="mean", nBins=count, exact=exact) or []
        for offset, value in enumerate(raw[:count]):
            if value is None or (isinstance(value, float) and math.isnan(value)):
                continue
            out[first + offset] = float(value)
    return out


# Zone edges for a zoned heatmap scaled to the file: the 50th, 90th, 99th and 99.9th
# percentile of its peak heights, sampled as the maximum of ~50 kb bins across every
# chromosome. Percentiles rather than the maximum, because one spike (a 564k pile-up in
# an RNA-seq file) would otherwise flatten everything else. Cached per file version.
_BIGWIG_ZONE_SCALE_CACHE: Dict[str, Tuple[Tuple[int, int], Dict[str, Any]]] = {}
_BIGWIG_ZONE_SCALE_LOCK = threading.Lock()
_BIGWIG_ZONE_QUANTILES = (0.5, 0.9, 0.99, 0.999)


def _bigwig_zone_edges(bin_maxima: List[float]) -> List[float]:
    """Four increasing zone edges from sampled peak heights."""
    values = sorted(v for v in bin_maxima if v is not None and math.isfinite(v) and v > 0)
    if not values:
        return []
    edges: List[float] = []
    for q in _BIGWIG_ZONE_QUANTILES:
        edge = float(values[min(len(values) - 1, int(q * len(values)))])
        # Strictly increasing, so no zone is empty even where the percentiles coincide.
        if edges and edge <= edges[-1]:
            edge = edges[-1] * 1.05 if edges[-1] > 0 else 1e-6
        edges.append(edge)
    return edges


def _bigwig_peak_samples(p: Path) -> Tuple[List[float], float]:
    """A file's peak heights (max of each ~50 kb bin) and its maximum, cached per version."""
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"BigWig not found: {p}")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigWig support is unavailable. Install pyBigWig.")
    st = p.stat()
    sig = (int(st.st_mtime_ns), int(st.st_size))
    key = str(p.resolve())
    with _BIGWIG_ZONE_SCALE_LOCK:
        cached = _BIGWIG_ZONE_SCALE_CACHE.get(key)
        if cached and cached[0] == sig:
            return cached[1]
    bw = pyBigWig.open(str(p))
    if bw is None:
        raise HTTPException(status_code=400, detail="Failed to open BigWig file.")
    try:
        samples: List[float] = []
        for chrom, length in (bw.chroms() or {}).items():
            bins = max(1, min(2000, int(length) // 50_000))
            try:
                samples.extend(v for v in (bw.stats(chrom, 0, int(length), type="max", nBins=bins) or []) if v)
            except Exception:
                continue
        header = bw.header() or {}
    finally:
        bw.close()
    result = (samples, float(header.get("maxVal") or 0.0))
    with _BIGWIG_ZONE_SCALE_LOCK:
        _BIGWIG_ZONE_SCALE_CACHE[key] = (sig, result)
    return result


def _bigwig_zone_scale_for(paths: List[str]) -> Dict[str, Any]:
    """Zone edges from the peaks of one file, or of several pooled, so they share a scale."""
    samples: List[float] = []
    top = 0.0
    for path in paths:
        file_samples, file_max = _bigwig_peak_samples(Path(path))
        samples.extend(file_samples)
        top = max(top, file_max)
    return {
        "thresholds": _bigwig_zone_edges(samples),
        "quantiles": list(_BIGWIG_ZONE_QUANTILES),
        "max": top,
        "samples": len(samples),
        "files": len(paths),
    }


class BigWigZoneScaleRequest(BaseModel):
    paths: List[str]


@app.get("/api/browse/bigwig/zone_scale")
async def browse_bigwig_zone_scale(path: str):
    return await run_in_threadpool(lambda: _bigwig_zone_scale_for([path]))


@app.post("/api/browse/bigwig/zone_scale")
async def browse_bigwig_zone_scale_shared(payload: BigWigZoneScaleRequest):
    """Zone edges shared by several files: their peaks pooled, so tracks compare directly."""
    paths = [str(p).strip() for p in (payload.paths or []) if str(p or "").strip()]
    if not paths:
        raise HTTPException(status_code=400, detail="paths must not be empty")
    return await run_in_threadpool(lambda: _bigwig_zone_scale_for(paths))


@app.get("/api/browse/bigwig")
async def browse_bigwig(
    genome: str = "reference",
    path: str = "",
    chrom: str = "",
    start: int = 0,
    end: int = 0,
    bins: int = 600
):
    """Fetch binned signal values for a BigWig file over a genomic range."""
    if not path:
        raise HTTPException(status_code=400, detail="path parameter is required.")
    if not chrom:
        raise HTTPException(status_code=400, detail="chrom parameter is required.")
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be greater than start.")

    # Ensure selected genome is valid/configured (same guardrails as other browse APIs).
    await run_in_threadpool(genome_context._get_browse_db, genome)

    bw_path = Path(path).expanduser()
    if not bw_path.exists() or not bw_path.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig file not found: {bw_path}")

    bins = max(20, min(4000, int(bins)))
    requested_chrom_len: Optional[int] = None
    try:
        fasta = genome_context._get_browse_fasta(genome)
        requested_chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        requested_chrom_len = None

    def _query():
        if pyBigWig is None:
            raise HTTPException(
                status_code=503,
                detail="BigWig support is unavailable. Install pyBigWig in the backend environment."
            )

        try:
            bw = pyBigWig.open(str(bw_path))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigWig: {e}")

        if bw is None:
            raise HTTPException(status_code=400, detail="Failed to open BigWig file.")

        try:
            chrom_sizes = bw.chroms() or {}
            resolved_chrom = _resolve_bigwig_chrom_name(chrom, chrom_sizes, requested_chrom_len=requested_chrom_len)

            if not resolved_chrom:
                return {
                    "path": str(bw_path),
                    "chrom": chrom,
                    "resolved_chrom": None,
                    "start": start,
                    "end": end,
                    "bins": [None] * bins,
                    "has_data": False,
                    "detail": "Chromosome not present in BigWig file.",
                    "min": None,
                    "max": None,
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0))
            q_start = max(0, int(start))
            q_end = min(int(end), chrom_len)
            if q_end <= q_start:
                return {
                    "path": str(bw_path),
                    "chrom": chrom,
                    "resolved_chrom": resolved_chrom,
                    "start": q_start,
                    "end": q_end,
                    "bins": [None] * bins,
                    "has_data": False,
                    "detail": "Requested region is outside the chromosome bounds in BigWig.",
                    "min": None,
                    "max": None,
                }

            values = _bigwig_binned_means(bw, resolved_chrom, int(start), int(end), bins, chrom_len)

            observed = [v for v in values if v is not None]
            has_data = len(observed) > 0

            # The requested range, not the clipped one: every bin is (end - start) / bins
            # wide, and the browser places bin i at start + i * that width.
            return {
                "path": str(bw_path),
                "chrom": chrom,
                "resolved_chrom": resolved_chrom,
                "start": int(start),
                "end": int(end),
                "bins": values,
                "has_data": has_data,
                "detail": "" if has_data else "No data in this region.",
                "min": min(observed) if observed else None,
                "max": max(observed) if observed else None,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


# Local fixtures used while developing the structural-variation view. Distributions leave
# ENSEMBL_GO_SV_TEST_DATA_DIR unset, in which case the built-in datasets below are not
# offered at all; real datasets are registered through the SV view instead (see
# docs/STRUCTURAL_VARIATION.md). Point the variable at a directory of .bigChain.bb and
# mapping TSVs to re-enable them.
_SV_TEST_DATA_DIR_SETTING = os.environ.get("ENSEMBL_GO_SV_TEST_DATA_DIR", "").strip()
SV_BUILTIN_DATASETS_ENABLED = bool(_SV_TEST_DATA_DIR_SETTING)
SV_TEST_DATA_DIR = (
    Path(_SV_TEST_DATA_DIR_SETTING).expanduser()
    if _SV_TEST_DATA_DIR_SETTING
    else Path("sv_view_data")
)
SV_ALIGNMENT_REGISTRY_FILENAME = "sv_alignment_registry.json"
SV_ALIGNMENT_SCAN_DIRNAME = "sv_alignments"
SV_DATASETS = {
    "grch38_hg00438": {
        "id": "builtin_grch38_hg00438",
        "source": "builtin",
        "label": "GRCh38 vs HG00438",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_000001405.29",
            "assembly_name": "GRCh38.p14",
            "aliases": [
                "GRCh38",
                "GRCh38.p14",
                "GCA_000001405.29",
                "GCF_000001405.40",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018472595.2",
            "assembly_name": "HG00438_pat_hprc_f2",
            "aliases": [
                "HG00438",
                "HG00438_pat_hprc_f2",
                "GCA_018472595.2",
            ],
        },
        "ref_aliases": [
            "grch38",
            "grch38p14",
            "grch38.p14",
            "gca00000140529",
            "gcf00000140540",
        ],
        "tgt_aliases": [
            "hg00438",
            "hg00438pat_hprcf2",
            "hg00438_pat_hprc_f2",
            "gca0184725952",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "GRCh38.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00438.1.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "alt_179f190d-17f9-4692-9353-374976c62e20_to_ref_fd7fea38-981a-4d73-a879-6f9daef86f08.20251215.bigChain.bb",
        "target_bigwig_path": SV_TEST_DATA_DIR / "HG00438_pat_hprc_f2.bw",
        "target_bigbed_path": SV_TEST_DATA_DIR / "HG00438_pat_hprc_f2.bb",
        "indexed_side": "target",
    },
    "grch38_hg00733": {
        "id": "builtin_grch38_hg00733",
        "source": "builtin",
        "label": "GRCh38 vs HG00733",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_000001405.29",
            "assembly_name": "GRCh38.p14",
            "aliases": [
                "GRCh38",
                "GRCh38.p14",
                "GCA_000001405.29",
                "GCF_000001405.40",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018506975.2",
            "assembly_name": "HG00733_mat_hprc_f2",
            "aliases": [
                "HG00733.2",
                "HG00733_mat",
                "HG00733_mat_hprc_f2",
                "GCA_018506975.2",
                "GCA_018506975.3",
                "0fb76cdf-6c6b-4c20-beef-7f7d4151651b",
            ],
        },
        "ref_aliases": [
            "grch38",
            "grch38p14",
            "grch38.p14",
            "gca00000140529",
            "gcf00000140540",
        ],
        "tgt_aliases": [
            "hg00733.2",
            "hg00733_mat",
            "hg00733_mat_hprc_f2",
            "hg00733mathprcf2",
            "gca0185069752",
            "gca0185069753",
            "0fb76cdf6c6b4c20beef7f7d4151651b",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "GRCh38.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00733.2.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "alt_0fb76cdf-6c6b-4c20-beef-7f7d4151651b_to_ref_fd7fea38-981a-4d73-a879-6f9daef86f08.20251215.bigChain.bb",
        "target_bigwig_path": SV_TEST_DATA_DIR / "HG00733_mat_hprc_f2.bw",
        "target_bigbed_path": SV_TEST_DATA_DIR / "HG00733_mat_hprc_f2.bb",
        "indexed_side": "target",
    },
    "chm13_hg00438": {
        "id": "builtin_chm13_hg00438",
        "source": "builtin",
        "label": "T2T-CHM13v2.0 vs HG00438",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_009914755.4",
            "assembly_name": "T2T-CHM13v2.0",
            "aliases": [
                "CHM13",
                "T2T-CHM13v2.0",
                "GCA_009914755.4",
                "GCF_009914755.1",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018472595.2",
            "assembly_name": "HG00438_pat_hprc_f2",
            "aliases": [
                "HG00438",
                "HG00438_pat_hprc_f2",
                "GCA_018472595.2",
            ],
        },
        "ref_aliases": [
            "chm13",
            "t2tchm13",
            "t2tchm13v2",
            "t2tchm13v20",
            "t2t-chm13v2.0",
            "gca0099147554",
            "gcf0099147551",
        ],
        "tgt_aliases": [
            "hg00438",
            "hg00438pat_hprcf2",
            "hg00438_pat_hprc_f2",
            "gca0184725952",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "CHM13.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00438.1.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "ref_fc20ebd6-f756-45da-b941-b3b17e11515f_to_alt_179f190d-17f9-4692-9353-374976c62e20.20251216.bigChain.bb",
        "indexed_side": "reference",
    },
}
_sv_mapping_cache: Dict[str, Dict[str, Any]] = {}
_sv_bigchain_chrom_cache: Dict[str, Dict[str, Any]] = {}
_sv_registry_cache: Dict[str, Any] = {
    "signature": None,
    "datasets": None,
    "incomplete": None,
    "configs": None,
}
# Registration used to write the registry with no lock at all, so two saves
# arriving together could each read the same file and one lose its entry.
_sv_config_write_lock = threading.Lock()


def _normalize_dataset_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())


def _sv_unique_strings(values: Iterable[Any]) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _sv_registry_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_REGISTRY_FILENAME
    except Exception:
        return None


def _sv_alignment_scan_dir(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_SCAN_DIRNAME
    except Exception:
        return None


def _sv_attached_config_paths(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    """Config files the user has attached, in the order they were attached."""
    state = config if isinstance(config, dict) else config_store.load_config()
    out: List[Path] = []
    seen: Set[str] = set()
    for raw in state.get("sv_config_paths") or []:
        text = str(raw or "").strip()
        if not text:
            continue
        try:
            path = Path(text).expanduser()
        except Exception:
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


# Sequence names per FASTA, keyed by path and invalidated on (mtime, size) of the
# index rather than the FASTA itself: the .fai is what actually carries the names,
# and it is rewritten whenever they change.
_sv_assembly_sequence_cache: Dict[str, Dict[str, Any]] = {}

# Derived sequence maps, keyed by (alignment id, side). Rebuilt when either the
# chain or the assembly index changes underneath.
_sv_derived_mapping_cache: Dict[Tuple[str, str], Dict[str, Any]] = {}


def _sv_fasta_signature(fasta_path: Path) -> Tuple[int, int]:
    for candidate in (Path(f"{fasta_path}.fai"), fasta_path):
        try:
            stat = candidate.stat()
            return int(stat.st_mtime_ns), int(stat.st_size)
        except Exception:
            continue
    return (0, 0)


def _sv_assembly_sequence_names(fasta_path: Any) -> List[str]:
    """Sequence names of a local assembly, read from its FASTA index.

    This is what replaced the mapping TSVs: the assembly already states its own
    sequence names, so asking the user to restate them in a side file was never
    buying anything the app could not work out.
    """
    text = str(fasta_path or "").strip()
    if not text:
        return []
    path = Path(text).expanduser()
    signature = _sv_fasta_signature(path)
    cached = _sv_assembly_sequence_cache.get(str(path))
    if cached and cached.get("signature") == signature:
        return list(cached.get("names") or [])

    names: List[str] = []
    if path.exists() and path.is_file():
        try:
            handle = file_io.open_indexed_fasta(str(path))
            names = [str(name).strip() for name in (handle.references or []) if str(name).strip()]
        except Exception:
            names = []
    _sv_assembly_sequence_cache[str(path)] = {"signature": signature, "names": list(names)}
    return names


def _sv_local_fasta_for_genome(genome: Dict[str, Any], local_assemblies: List[Dict[str, Any]]) -> str:
    match = _sv_local_species_match(genome, local_assemblies)
    if not isinstance(match, dict):
        return ""
    return str((match.get("files") or {}).get("fasta") or "")


def _sv_side_mapping(dataset: Dict[str, Any], side: str) -> Dict[str, Any]:
    """Sequence-name map for one side of an alignment.

    Two sources, in order. A mapping TSV if the record still names one -- old
    registry entries and sidecar manifests do, and they must keep working. Otherwise
    the names are derived from the BigChain's own chromosome list and the local
    assembly's FASTA index, which is what a config written in the current format
    relies on.
    """
    normalized = "reference" if str(side or "").strip().lower().startswith("ref") else "target"
    mapping_key = "ref_mapping_path" if normalized == "reference" else "tgt_mapping_path"
    mapping_path = _sv_path_text(dataset.get(mapping_key))
    if mapping_path:
        candidate = Path(mapping_path).expanduser()
        if candidate.exists() and candidate.is_file():
            return _load_sv_mapping(candidate)

    cache_key = (str(dataset.get("id") or ""), normalized)
    chain_path = Path(_sv_path_text(dataset.get("chain_path"))).expanduser()
    fasta_path = _sv_path_text(dataset.get(f"{normalized}_fasta_path"))
    signature = (_sv_fasta_signature(chain_path), _sv_fasta_signature(Path(fasta_path)) if fasta_path else (0, 0))
    cached = _sv_derived_mapping_cache.get(cache_key)
    if cached and cached.get("signature") == signature:
        return cached["mapping"]

    alias_key = "reference_sequence_aliases" if normalized == "reference" else "target_sequence_aliases"
    mapping = sv_derive_sequence_map(
        _load_sv_bigchain_chrom_sizes(chain_path).keys(),
        _sv_assembly_sequence_names(fasta_path),
        explicit_aliases=dataset.get(alias_key) or {},
    )
    _sv_derived_mapping_cache[cache_key] = {"signature": signature, "mapping": mapping}
    return mapping


def _sv_genome_key_from_record(record: Dict[str, Any]) -> str:
    key = str(record.get("genome_key") or record.get("key") or "").strip()
    if key:
        return key
    return build_provider_aware_genome_key(
        record.get("species_key"),
        record.get("assembly") or record.get("gca") or record.get("accession") or record.get("assembly_name"),
        record.get("provider") or DEFAULT_PROVIDER,
        is_manual=bool(record.get("is_manual")),
    ) or legacy_genome_key(
        record.get("species_key"),
        record.get("assembly") or record.get("gca") or record.get("accession") or record.get("assembly_name"),
    )


def _sv_genome_aliases(record: Optional[Dict[str, Any]], extra_aliases: Optional[Iterable[Any]] = None) -> List[str]:
    raw = record or {}
    values: List[Any] = [
        raw.get("genome_key"),
        raw.get("key"),
        _sv_genome_key_from_record(raw),
        raw.get("assembly"),
        raw.get("gca"),
        raw.get("accession"),
        raw.get("assembly_name"),
        raw.get("name"),
    ]
    weak_tokens = {
        token
        for token in (
            _normalize_dataset_token(raw.get("provider")),
            _normalize_dataset_token(raw.get("species_key")),
            _normalize_dataset_token(raw.get("display_name")),
            _normalize_dataset_token(raw.get("common_name")),
            _normalize_dataset_token(raw.get("scientific_name")),
        )
        if token
    }
    identity_aliases = list(raw.get("aliases") or []) + list(raw.get("equivalent_accessions") or [])
    if extra_aliases:
        identity_aliases.extend(extra_aliases)
    values.extend(
        value
        for value in identity_aliases
        if _normalize_dataset_token(value) not in weak_tokens
    )
    return _sv_unique_strings(values)


def _normalize_sv_genome_record(raw: Any, aliases: Optional[Iterable[Any]] = None) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    assembly = str(source.get("assembly") or source.get("gca") or source.get("accession") or "").strip()
    provider = normalize_provider(source.get("provider") or DEFAULT_PROVIDER, is_manual=bool(source.get("is_manual")))
    out = {
        "provider": provider,
        "species_key": str(source.get("species_key") or "").strip(),
        "assembly": assembly,
        "gca": str(source.get("gca") or (assembly if assembly.upper().startswith("GC") else "")).strip(),
        "accession": str(source.get("accession") or assembly).strip(),
        "assembly_name": str(source.get("assembly_name") or source.get("name") or assembly).strip(),
        "scientific_name": str(source.get("scientific_name") or "").strip(),
        "common_name": str(source.get("common_name") or "").strip(),
        "display_name": str(source.get("display_name") or "").strip(),
        "is_manual": bool(source.get("is_manual")),
    }
    genome_key = _sv_genome_key_from_record({**source, **out})
    if genome_key:
        out["genome_key"] = genome_key
    out["aliases"] = _sv_genome_aliases({**source, **out}, aliases)
    return out


def _sv_path_text(value: Any) -> str:
    """Path-or-string to text, treating an unset path as unset.

    ``_normalize_sv_dataset`` stores absent paths as ``Path("")``, which stringifies
    to ``"."`` -- a real, existing directory. Anything testing "is this path set?"
    on the raw value therefore sees a path that is present but not a file.
    """
    text = str(value or "").strip()
    return "" if text in {"", "."} else text


def _sv_dataset_file_status(dataset: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Which of an alignment's files are actually on disk.

    The chain is the only hard requirement. Mapping TSVs are checked only when a
    record still names them -- a config in the current format derives those names
    from the assembly instead, and treating an absent TSV as a missing file there
    would report every such alignment as broken.
    """
    missing: List[str] = []

    chain = _sv_path_text(dataset.get("chain_path"))
    if not chain:
        missing.append("")
    else:
        try:
            path = Path(chain).expanduser()
        except Exception:
            missing.append(chain)
        else:
            if not path.exists() or not path.is_file():
                missing.append(str(path))

    for raw in (dataset.get("ref_mapping_path"), dataset.get("tgt_mapping_path")):
        text = _sv_path_text(raw)
        if not text:
            continue
        try:
            path = Path(text).expanduser()
        except Exception:
            missing.append(text)
            continue
        if not path.exists() or not path.is_file():
            missing.append(str(path))

    return len(missing) == 0, missing


def _sv_track_type_from_path(path: str) -> str:
    lower = str(path or "").strip().lower()
    if lower.endswith(".bw") or lower.endswith(".bigwig"):
        return "bigwig"
    if lower.endswith(".bb") or lower.endswith(".bigbed"):
        return "bigbed"
    return ""


def _normalize_sv_data_tracks(raw: Dict[str, Any], base_dir: Optional[Path] = None) -> Dict[str, List[Dict[str, Any]]]:
    def _path(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        path = Path(text).expanduser()
        if not path.is_absolute() and base_dir:
            path = base_dir / path
        return str(path)

    def _append(out: Dict[str, List[Dict[str, Any]]], side: str, value: Any, track_type: str = "", label: str = ""):
        path = _path(value)
        if not path:
            return
        resolved_type = track_type or _sv_track_type_from_path(path)
        if resolved_type not in {"bigwig", "bigbed"}:
            return
        normalized_side = "reference" if str(side or "").strip().lower() in {"ref", "reference", "primary"} else "target"
        track_label = str(label or "").strip()
        if not track_label:
            track_label = "Signal" if resolved_type == "bigwig" else "SV intervals"
        out[normalized_side].append({
            "id": hashlib.sha1(f"{normalized_side}|{resolved_type}|{path}".encode("utf-8")).hexdigest()[:16],
            "side": normalized_side,
            "type": resolved_type,
            "label": track_label,
            "path": path,
            "display_mode": "flatten",
        })

    out: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    _append(out, "reference", raw.get("reference_bigwig_path") or raw.get("ref_bigwig_path") or raw.get("reference_bw_path") or raw.get("ref_bw_path"), "bigwig", raw.get("reference_bigwig_label") or raw.get("ref_bigwig_label"))
    _append(out, "reference", raw.get("reference_bigbed_path") or raw.get("ref_bigbed_path") or raw.get("reference_bb_path") or raw.get("ref_bb_path"), "bigbed", raw.get("reference_bigbed_label") or raw.get("ref_bigbed_label"))
    _append(out, "target", raw.get("target_bigwig_path") or raw.get("tgt_bigwig_path") or raw.get("target_bw_path") or raw.get("tgt_bw_path"), "bigwig", raw.get("target_bigwig_label") or raw.get("tgt_bigwig_label"))
    _append(out, "target", raw.get("target_bigbed_path") or raw.get("tgt_bigbed_path") or raw.get("target_bb_path") or raw.get("tgt_bb_path"), "bigbed", raw.get("target_bigbed_label") or raw.get("tgt_bigbed_label"))

    for side_key, side in (("reference_tracks", "reference"), ("ref_tracks", "reference"), ("target_tracks", "target"), ("tgt_tracks", "target")):
        for item in raw.get(side_key) or []:
            if not isinstance(item, dict):
                continue
            _append(
                out,
                side,
                item.get("path") or item.get("url") or item.get("data_url"),
                str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
                item.get("label") or item.get("name") or item.get("track_name") or "",
            )

    grouped_tracks = raw.get("tracks")
    if isinstance(grouped_tracks, dict):
        for grouped_side in ("reference", "target"):
            for item in grouped_tracks.get(grouped_side) or []:
                if not isinstance(item, dict):
                    continue
                _append(
                    out,
                    grouped_side,
                    item.get("path") or item.get("url") or item.get("data_url"),
                    str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
                    item.get("label") or item.get("name") or item.get("track_name") or "",
                )

    flat_tracks = raw.get("data_tracks") or (grouped_tracks if isinstance(grouped_tracks, list) else [])
    for item in flat_tracks or []:
        if not isinstance(item, dict):
            continue
        _append(
            out,
            item.get("side") or item.get("genome") or "target",
            item.get("path") or item.get("url") or item.get("data_url"),
            str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
            item.get("label") or item.get("name") or item.get("track_name") or "",
        )

    deduped: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    for side, tracks in out.items():
        seen: Set[Tuple[str, str]] = set()
        for track in tracks:
            key = (str(track.get("type") or ""), str(track.get("path") or ""))
            if key in seen:
                continue
            seen.add(key)
            deduped[side].append(track)
    return deduped


def _normalize_sv_dataset(raw: Dict[str, Any], source: str = "registered", base_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    def _path(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        path = Path(text).expanduser()
        if not path.is_absolute() and base_dir:
            path = base_dir / path
        return str(path)

    ref_aliases = raw.get("ref_aliases") or raw.get("reference_aliases") or []
    tgt_aliases = raw.get("tgt_aliases") or raw.get("target_aliases") or []
    reference_genome = _normalize_sv_genome_record(
        raw.get("reference_genome") or raw.get("reference") or {},
        ref_aliases,
    )
    target_genome = _normalize_sv_genome_record(
        raw.get("target_genome") or raw.get("target") or raw.get("alt_genome") or {},
        tgt_aliases,
    )

    chain_path = _path(raw.get("chain_path") or raw.get("bigchain_path") or raw.get("bigchain"))
    ref_mapping_path = _path(raw.get("ref_mapping_path") or raw.get("reference_mapping_path") or raw.get("reference_map"))
    tgt_mapping_path = _path(raw.get("tgt_mapping_path") or raw.get("target_mapping_path") or raw.get("target_map"))
    alignment_id = str(raw.get("id") or raw.get("alignment_id") or "").strip()
    if not alignment_id:
        seed = "|".join([chain_path, ref_mapping_path, tgt_mapping_path, source])
        alignment_id = f"sv_{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:16]}"

    indexed_side = str(raw.get("indexed_side") or "target").strip().lower()
    if indexed_side not in {"reference", "target"}:
        indexed_side = "target"

    dataset = {
        **raw,
        "id": alignment_id,
        "alignment_id": alignment_id,
        "source": str(raw.get("source") or source),
        "label": str(raw.get("label") or raw.get("name") or alignment_id).strip() or alignment_id,
        "reference_genome": reference_genome,
        "target_genome": target_genome,
        "ref_aliases": _sv_genome_aliases(reference_genome, ref_aliases),
        "tgt_aliases": _sv_genome_aliases(target_genome, tgt_aliases),
        "chain_path": Path(chain_path) if chain_path else Path(""),
        "ref_mapping_path": Path(ref_mapping_path) if ref_mapping_path else Path(""),
        "tgt_mapping_path": Path(tgt_mapping_path) if tgt_mapping_path else Path(""),
        "indexed_side": indexed_side,
        "tracks": _normalize_sv_data_tracks(raw, base_dir=base_dir),
    }
    supported, missing = _sv_dataset_file_status(dataset)
    dataset["supported"] = supported
    dataset["missing_files"] = missing
    return dataset


def _load_sv_config_file(path: Optional[Path], source: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Read one config file into datasets, plus any diagnostics worth surfacing.

    Legacy registry payloads are recognised and migrated by ``parse_sv_config``, so
    a registry written before this format existed loads through exactly this path.
    """
    if not path or not path.exists():
        return [], []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return [], [diagnostic_for_config(path, f"Could not read the file: {exc}")]

    config, diagnostics = parse_sv_config(text, base_dir=path.parent)
    diagnostics = sv_locate_pointer_lines(text, diagnostics)
    datasets: List[Dict[str, Any]] = []
    for raw in sv_config_to_datasets(config, source=source, config_path=str(path)):
        dataset = _normalize_sv_dataset(raw, source=source, base_dir=path.parent)
        if dataset:
            datasets.append(dataset)
    return datasets, diagnostics


def diagnostic_for_config(path: Path, message: str) -> Dict[str, Any]:
    return {"severity": "error", "pointer": "", "line": 0, "message": message, "path": str(path)}


def _load_sv_alignment_registry_from_path(path: Optional[Path]) -> List[Dict[str, Any]]:
    datasets, _diagnostics = _load_sv_config_file(path, source="registered")
    return datasets


def _load_sv_mapping_info(mapping_path: Path) -> Optional[Dict[str, Any]]:
    try:
        mapping = _load_sv_mapping(mapping_path)
    except Exception:
        return None
    return {
        "path": mapping_path,
        "genome_name": str(mapping.get("genome_name") or mapping_path.stem).strip(),
        "assembly_uuid": str(mapping.get("assembly_uuid") or "").strip(),
    }


def _guess_sv_indexed_side_from_filename(bigchain_path: Path) -> Optional[str]:
    name = bigchain_path.name.lower()
    if name.startswith("alt_") and "_to_ref_" in name:
        return "target"
    if name.startswith("ref_") and "_to_alt_" in name:
        return "reference"
    return None


def _auto_pick_sv_maps_from_filename(
    bigchain_path: Path,
    mapping_infos: List[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    by_uuid = {
        str(info.get("assembly_uuid") or "").lower(): info
        for info in mapping_infos
        if str(info.get("assembly_uuid") or "").strip()
    }
    name = bigchain_path.name.lower()
    match = re.search(r"alt_([0-9a-f-]+)_to_ref_([0-9a-f-]+)", name)
    if match:
        target_uuid = match.group(1).lower()
        reference_uuid = match.group(2).lower()
        return by_uuid.get(reference_uuid), by_uuid.get(target_uuid)
    match = re.search(r"ref_([0-9a-f-]+)_to_alt_([0-9a-f-]+)", name)
    if match:
        reference_uuid = match.group(1).lower()
        target_uuid = match.group(2).lower()
        return by_uuid.get(reference_uuid), by_uuid.get(target_uuid)
    return None, None


def _manifest_candidates_for_bigchain(bigchain_path: Path) -> List[Path]:
    return [
        bigchain_path.with_suffix(bigchain_path.suffix + ".json"),
        bigchain_path.with_suffix(".json"),
        bigchain_path.parent / f"{bigchain_path.stem}.sv_alignment.json",
        bigchain_path.parent / "sv_alignment.json",
    ]


def _scan_sv_alignment_dir(scan_dir: Optional[Path]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not scan_dir or not scan_dir.exists() or not scan_dir.is_dir():
        return [], []
    datasets: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()

    for bigchain_path in sorted(scan_dir.rglob("*.bigChain.bb")):
        manifest_payload: Optional[Dict[str, Any]] = None
        for manifest_path in _manifest_candidates_for_bigchain(bigchain_path):
            if not manifest_path.exists():
                continue
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception as exc:
                incomplete.append({
                    "path": str(bigchain_path),
                    "reason": f"Failed to parse manifest {manifest_path.name}: {exc}",
                })
                continue
            if isinstance(payload, dict):
                manifest_payload = payload
                break

        if manifest_payload:
            raw = {**manifest_payload, "chain_path": manifest_payload.get("chain_path") or str(bigchain_path)}
            dataset = _normalize_sv_dataset(raw, source="scanned", base_dir=bigchain_path.parent)
            if dataset and dataset["id"] not in seen_ids:
                seen_ids.add(dataset["id"])
                datasets.append(dataset)
            continue

        mapping_infos = [
            info for info in (
                _load_sv_mapping_info(path)
                for path in sorted(bigchain_path.parent.glob("*.hal_mapping.tsv"))
            )
            if info
        ]
        ref_map, tgt_map = _auto_pick_sv_maps_from_filename(bigchain_path, mapping_infos)
        indexed_side = _guess_sv_indexed_side_from_filename(bigchain_path) or "target"
        if not ref_map or not tgt_map:
            incomplete.append({
                "path": str(bigchain_path),
                "reason": "Could not infer reference/target mapping TSVs. Add an sv_alignment.json manifest or register this alignment in the SV view.",
            })
            continue

        raw = {
            "id": f"scan_{hashlib.sha1(str(bigchain_path).encode('utf-8')).hexdigest()[:16]}",
            "label": bigchain_path.stem,
            "chain_path": str(bigchain_path),
            "ref_mapping_path": str(ref_map["path"]),
            "tgt_mapping_path": str(tgt_map["path"]),
            "indexed_side": indexed_side,
            "reference_genome": {
                "assembly_name": ref_map.get("genome_name") or "",
                "aliases": [ref_map.get("genome_name") or "", ref_map.get("assembly_uuid") or ""],
            },
            "target_genome": {
                "assembly_name": tgt_map.get("genome_name") or "",
                "aliases": [tgt_map.get("genome_name") or "", tgt_map.get("assembly_uuid") or ""],
            },
        }
        dataset = _normalize_sv_dataset(raw, source="scanned", base_dir=bigchain_path.parent)
        if dataset and dataset["id"] not in seen_ids:
            seen_ids.add(dataset["id"])
            datasets.append(dataset)

    return datasets, incomplete


def _sv_stat_signature(path: Optional[Path]) -> Tuple[str, int, int]:
    if not path:
        return "", 0, 0
    try:
        stat = path.stat()
        return str(path), int(stat.st_mtime_ns), int(stat.st_size)
    except Exception:
        return str(path), 0, 0


def _sv_local_assembly_signature(output_dir: Any) -> Tuple[Any, ...]:
    """Cheap fingerprint of the local genomes, so a new download is picked up.

    Only the ``assembly`` subdirectory is stat'ed: that is where the FASTA and its
    index land, and it is the only thing the sequence-name derivation reads.
    """
    try:
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None
    except Exception:
        return ()
    if not local_root or not local_root.is_dir():
        return ()
    out: List[Tuple[str, int, int]] = []
    try:
        for _provider, _species_key, _assembly, asm_dir in iter_local_assembly_dirs(local_root):
            out.append(_sv_stat_signature(asm_dir / "assembly"))
    except Exception:
        return ()
    return tuple(out)


_sv_local_assembly_index_cache: Dict[str, Any] = {"signature": None, "entries": []}


def _sv_local_assembly_index(output_dir: Any) -> List[Dict[str, Any]]:
    """Local genomes reduced to what SV needs: identity plus a FASTA path.

    ``list_local_assemblies`` produces a far richer record, but it is an async route
    handler and this runs from synchronous dataset assembly. Matching only needs the
    accession and its aliases, so the cheaper scan here is sufficient.
    """
    signature = _sv_local_assembly_signature(output_dir)
    if _sv_local_assembly_index_cache.get("signature") == signature:
        return list(_sv_local_assembly_index_cache.get("entries") or [])

    entries: List[Dict[str, Any]] = []
    try:
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None
    except Exception:
        local_root = None
    if local_root and local_root.is_dir():
        for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
            try:
                manifest = local_inventory._load_genome_manifest(asm_dir, assembly)
                scanned = local_inventory._scan_local_assembly(asm_dir, assembly, manifest)
            except Exception:
                continue
            fasta_path = str((scanned.get("files") or {}).get("fasta") or "")
            if not fasta_path:
                continue
            entries.append({
                "provider": provider,
                "species_key": species_key,
                "assembly": assembly,
                "accession": assembly,
                "gca": assembly if str(assembly).upper().startswith("GC") else "",
                "assembly_name": str(manifest.get("assembly_name") or assembly),
                "scientific_name": str(manifest.get("scientific_name") or ""),
                "common_name": str(manifest.get("common_name") or ""),
                "display_name": str(manifest.get("display_name") or ""),
                "equivalent_accessions": list(manifest.get("equivalent_accessions") or []),
                "files": {"fasta": fasta_path},
            })

    _sv_local_assembly_index_cache["signature"] = signature
    _sv_local_assembly_index_cache["entries"] = list(entries)
    return entries


def _sv_attach_assembly_paths(dataset: Dict[str, Any], assembly_index: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Resolve each side's FASTA once, here, rather than per request.

    ``/api/sv/view`` runs on every pan and zoom; walking the local data directory
    there would be a directory scan per frame. Doing it while datasets are being
    assembled puts it behind the same cache that guards the rest of this work.
    """
    for side, key in (("reference", "reference_genome"), ("target", "target_genome")):
        if dataset.get(f"{side}_fasta_path"):
            continue
        dataset[f"{side}_fasta_path"] = _sv_local_fasta_for_genome(dataset.get(key) or {}, assembly_index)
    return dataset


def _sv_registry_signature(output_dir: Any) -> Tuple[Any, ...]:
    registry_path = _sv_registry_store_path(output_dir)
    scan_dir = _sv_alignment_scan_dir(output_dir)

    scan_sig: List[Tuple[str, int, int]] = []
    if scan_dir and scan_dir.exists() and scan_dir.is_dir():
        for path in sorted(scan_dir.rglob("*")):
            if path.is_file() and (
                path.name.endswith(".bigChain.bb")
                or path.name.endswith(".hal_mapping.tsv")
                or path.name.endswith(".json")
            ):
                scan_sig.append(_sv_stat_signature(path))

    attached_sig = tuple(_sv_stat_signature(path) for path in _sv_attached_config_paths())
    return (
        _sv_stat_signature(registry_path),
        tuple(scan_sig),
        attached_sig,
        _sv_local_assembly_signature(output_dir),
    )


def _list_sv_datasets(output_dir: Any = "") -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    signature = _sv_registry_signature(output_dir)
    if _sv_registry_cache.get("signature") == signature:
        return list(_sv_registry_cache.get("datasets") or []), list(_sv_registry_cache.get("incomplete") or [])

    datasets: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()
    config_reports: List[Dict[str, Any]] = []

    def take(candidates: Iterable[Dict[str, Any]]) -> int:
        added = 0
        for dataset in candidates:
            if not dataset or dataset["id"] in seen_ids:
                continue
            seen_ids.add(dataset["id"])
            datasets.append(dataset)
            added += 1
        return added

    if SV_BUILTIN_DATASETS_ENABLED:
        take(_normalize_sv_dataset(raw, source="builtin") for raw in SV_DATASETS.values())

    take(_load_sv_alignment_registry_from_path(_sv_registry_store_path(output_dir)))

    scanned, incomplete = _scan_sv_alignment_dir(_sv_alignment_scan_dir(output_dir))
    take(scanned)

    # Attached configs come last so a locally registered alignment keeps precedence
    # over one arriving from a shared file with the same id.
    for path in _sv_attached_config_paths():
        loaded, diagnostics = _load_sv_config_file(path, source="config")
        count = take(loaded)
        config_reports.append({
            "path": str(path),
            "label": path.name,
            "exists": path.exists(),
            "alignment_count": count,
            "diagnostics": diagnostics,
        })

    assembly_index = _sv_local_assembly_index(output_dir)
    datasets = [_sv_attach_assembly_paths(dataset, assembly_index) for dataset in datasets]

    _sv_registry_cache["signature"] = signature
    _sv_registry_cache["datasets"] = list(datasets)
    _sv_registry_cache["incomplete"] = list(incomplete)
    _sv_registry_cache["configs"] = list(config_reports)
    return datasets, incomplete


def _sv_genome_matches_text(genome: Dict[str, Any], text: Any) -> bool:
    query = _normalize_dataset_token(str(text or ""))
    if not query:
        return False
    aliases = [_normalize_dataset_token(alias) for alias in _sv_genome_aliases(genome)]
    return any(alias and (alias in query or query in alias) for alias in aliases)


def _sv_dataset_matches(dataset: Dict[str, Any], ref_assembly: str, tgt_assembly: str) -> bool:
    ref_norm = _normalize_dataset_token(ref_assembly)
    tgt_norm = _normalize_dataset_token(tgt_assembly)
    if not ref_norm or not tgt_norm:
        return False

    ref_aliases = [_normalize_dataset_token(a) for a in dataset.get("ref_aliases", [])]
    tgt_aliases = [_normalize_dataset_token(a) for a in dataset.get("tgt_aliases", [])]
    return (
        any(alias and (alias == ref_norm or alias in ref_norm) for alias in ref_aliases)
        and any(alias and (alias == tgt_norm or alias in tgt_norm) for alias in tgt_aliases)
    )


def _select_sv_dataset(ref_assembly: str, tgt_assembly: str, alignment_id: str = "", output_dir: Any = "") -> Optional[dict]:
    datasets, _ = _list_sv_datasets(output_dir)
    requested_id = str(alignment_id or "").strip()
    if requested_id:
        for dataset in datasets:
            if str(dataset.get("id") or "") == requested_id or str(dataset.get("alignment_id") or "") == requested_id:
                return dataset
        return None

    for dataset in datasets:
        if _sv_dataset_matches(dataset, ref_assembly, tgt_assembly):
            return dataset
    return None


def _sv_aliases_for_sequence(token: str) -> List[str]:
    t = (token or "").strip()
    if not t:
        return []
    out = {t}
    out.add(t.lower())
    out.add(t.upper())
    if t.lower().startswith("chr") and len(t) > 3:
        out.add(t[3:])
    else:
        out.add(f"chr{t}")
    return [v for v in out if v]


def _load_sv_mapping(mapping_path: Path) -> Dict[str, Any]:
    """Parse a legacy mapping TSV.

    Kept for records that still name one -- registry entries written before the
    config format, and sidecar manifests. Current configs derive these names from
    the assembly instead; see ``_sv_side_mapping``.
    """
    cache_key = str(mapping_path)
    try:
        stat = mapping_path.stat()
        signature = (int(stat.st_mtime_ns), int(stat.st_size))
    except Exception:
        signature = (0, 0)
    cached = _sv_mapping_cache.get(cache_key)
    # Keyed by path alone this used to serve stale names forever after an edit.
    if cached is not None and cached.get("signature") == signature:
        return cached["mapping"]

    if not mapping_path.exists():
        raise HTTPException(status_code=404, detail=f"SV mapping TSV not found: {mapping_path}")

    hal_to_assembly: Dict[str, str] = {}
    assembly_to_hal: Dict[str, str] = {}
    alias_to_assembly: Dict[str, str] = {}
    genome_name = ""
    assembly_uuid = ""

    with open(mapping_path, "r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            genome_name = (row.get("hal_genome_name") or genome_name).strip()
            assembly_uuid = (row.get("assembly_uuid") or assembly_uuid).strip()
            hal_seq = (row.get("hal_sequence_name") or "").strip()
            assembly_seq = (row.get("assembly_sequence") or "").strip()
            if not hal_seq or not assembly_seq:
                continue
            hal_to_assembly[hal_seq] = assembly_seq
            assembly_to_hal.setdefault(assembly_seq, hal_seq)
            for alias in _sv_aliases_for_sequence(hal_seq) + _sv_aliases_for_sequence(assembly_seq):
                alias_to_assembly[alias.lower()] = assembly_seq

    result = {
        "hal_to_assembly": hal_to_assembly,
        "assembly_to_hal": assembly_to_hal,
        "alias_to_assembly": alias_to_assembly,
        "genome_name": genome_name,
        "assembly_uuid": assembly_uuid,
    }
    _sv_mapping_cache[cache_key] = {"signature": signature, "mapping": result}
    return result


def _sv_sort_region_key(region_name: Any) -> Tuple[int, int, str]:
    text = str(region_name or "").strip()
    lowered = text.lower()
    core = lowered[3:] if lowered.startswith("chr") else lowered
    if core.isdigit():
        return (0, int(core), text)
    special = {"x": 23, "y": 24, "m": 25, "mt": 25}
    if core in special:
        return (0, special[core], text)
    return (1, 0, text)


def _load_sv_bigchain_chrom_sizes(chain_path: Path) -> Dict[str, int]:
    path = Path(chain_path).expanduser()
    cache_key = str(path)
    try:
        stat = path.stat()
        signature = (int(stat.st_mtime_ns), int(stat.st_size))
    except Exception:
        signature = (0, 0)

    cached = _sv_bigchain_chrom_cache.get(cache_key)
    if cached and cached.get("signature") == signature:
        return dict(cached.get("chrom_sizes") or {})

    chrom_sizes: Dict[str, int] = {}
    if pyBigWig is not None and path.exists() and path.is_file():
        bw = None
        try:
            bw = pyBigWig.open(str(path))
            chrom_sizes = {str(k): int(v) for k, v in (bw.chroms() or {}).items()}
        except Exception:
            chrom_sizes = {}
        finally:
            try:
                if bw is not None:
                    bw.close()
            except Exception:
                pass

    _sv_bigchain_chrom_cache[cache_key] = {
        "signature": signature,
        "chrom_sizes": dict(chrom_sizes),
    }
    return chrom_sizes


def _sv_alignment_reference_regions(dataset: Dict[str, Any], limit: int = 500) -> List[Dict[str, Any]]:
    supported, _missing = _sv_dataset_file_status(dataset)
    if not supported:
        return []
    try:
        ref_map = _sv_side_mapping(dataset, "reference")
        tgt_map = _sv_side_mapping(dataset, "target")
    except Exception:
        return []

    chrom_sizes = _load_sv_bigchain_chrom_sizes(Path(dataset["chain_path"]))
    if not chrom_sizes:
        return []

    indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()
    if indexed_side not in {"reference", "target"}:
        indexed_side = "target"

    target_regions = set(str(item) for item in (tgt_map.get("assembly_to_hal") or {}).keys())
    out: List[Dict[str, Any]] = []
    for ref_region in sorted((ref_map.get("assembly_to_hal") or {}).keys(), key=_sv_sort_region_key):
        if indexed_side == "reference":
            indexed_region = str(ref_region)
        else:
            if str(ref_region) not in target_regions:
                continue
            indexed_region = str(ref_region)

        chain_chrom = _resolve_bigwig_chrom_name(indexed_region, chrom_sizes)
        if not chain_chrom:
            continue
        out.append({
            "id": str(ref_region),
            "chrom": str(ref_region),
            "label": str(ref_region),
            "indexed_chrom": chain_chrom,
            "indexed_length": int(chrom_sizes.get(chain_chrom, 0) or 0),
        })
        if len(out) >= limit:
            break
    return out


def _resolve_sv_sequence(mapping: Dict[str, Any], token: str) -> Optional[str]:
    t = (token or "").strip()
    if not t:
        return None
    if t in mapping["assembly_to_hal"]:
        return t
    if t in mapping["hal_to_assembly"]:
        return mapping["hal_to_assembly"][t]
    return mapping["alias_to_assembly"].get(t.lower())


def _resolve_db_chrom_name(db_path: str, chrom: str) -> Optional[str]:
    token = (chrom or "").strip()
    if not token:
        return None

    candidates = _sv_aliases_for_sequence(token)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        for candidate in candidates:
            c.execute("SELECT chrom FROM genes WHERE chrom = ? LIMIT 1", (candidate,))
            row = c.fetchone()
            if row:
                return str(row["chrom"])

        token_l = token.lower()
        c.execute("SELECT chrom FROM genes WHERE LOWER(chrom) = ? LIMIT 1", (token_l,))
        row = c.fetchone()
        if row:
            return str(row["chrom"])

        for candidate in candidates:
            c.execute("SELECT chrom FROM genes WHERE LOWER(chrom) = ? LIMIT 1", (candidate.lower(),))
            row = c.fetchone()
            if row:
                return str(row["chrom"])
    finally:
        conn.close()
    return None


_DB_GENE_CHROMS_CACHE: Dict[str, Dict[str, Any]] = {}
_DB_GENE_CHROMS_CACHE_LOCK = threading.Lock()


def _get_db_gene_chrom_names(db_path: str) -> List[str]:
    path = str(db_path or "").strip()
    try:
        st = os.stat(path)
        sig = (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        sig = (0, 0)

    with _DB_GENE_CHROMS_CACHE_LOCK:
        cached = _DB_GENE_CHROMS_CACHE.get(path)
        if cached and cached.get("sig") == sig:
            return list(cached.get("chroms") or [])

    chroms: List[str] = []
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute("SELECT DISTINCT chrom FROM genes")
        chroms = [str(r["chrom"] or "").strip() for r in c.fetchall() if str(r["chrom"] or "").strip()]
    finally:
        conn.close()

    with _DB_GENE_CHROMS_CACHE_LOCK:
        _DB_GENE_CHROMS_CACHE[path] = {"sig": sig, "chroms": chroms}
    return list(chroms)


def _resolve_db_chrom_name_for_genome(db_path: str, chrom: str, genome: str) -> Optional[str]:
    direct = _resolve_db_chrom_name(db_path, chrom)
    if direct:
        return direct
    token = str(chrom or "").strip()
    if not token:
        return None
    known_regions = _get_db_gene_chrom_names(db_path)
    resolved = genome_context._resolve_browse_chrom_name(genome, token, known_regions)
    if resolved and resolved in known_regions:
        return resolved
    if resolved:
        return _resolve_db_chrom_name(db_path, resolved)
    return None


def _resolve_genome_chrom_length(genome: str, *tokens: Optional[str]) -> Tuple[Optional[str], int]:
    try:
        fasta = genome_context._get_browse_fasta(genome)
    except Exception:
        return None, 0

    available = [str(name or "").strip() for name in (fasta.references or []) if str(name or "").strip()]
    if not available:
        return None, 0

    resolved: Optional[str] = None
    for token in tokens:
        requested = str(token or "").strip()
        if not requested:
            continue
        candidate = _resolve_track_chrom_with_aliases(requested, available, genome=genome)
        if candidate in available:
            resolved = candidate
            break

    if not resolved:
        return None, 0

    try:
        chrom_length = int(fasta.get_reference_length(resolved))
    except Exception:
        chrom_length = 0

    return resolved, max(0, chrom_length)


def _build_sv_chrom_size_aliases(chrom_length: int, *tokens: Optional[str]) -> Dict[str, int]:
    if int(chrom_length or 0) <= 0:
        return {}

    out: Dict[str, int] = {}
    for token in tokens:
        raw = str(token or "").strip()
        if not raw:
            continue
        for alias in _sv_aliases_for_sequence(raw):
            out[alias] = int(chrom_length)
    return out


def _fetch_genes_for_window(db_path: str, chrom: str, start: int, end: int, limit: int = 1000) -> List[dict]:
    if not chrom or end <= start:
        return []

    resolved = _resolve_db_chrom_name(db_path, chrom) or chrom
    q_start = max(0, int(start))
    q_end = max(q_start + 1, int(end))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute(
            """
            SELECT id, name, chrom, start, end, strand, biotype
            FROM genes
            WHERE chrom = ? AND end >= ? AND start <= ?
            ORDER BY start ASC
            LIMIT ?
            """,
            (resolved, q_start, q_end, int(max(100, limit))),
        )
        rows = c.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": r["id"],
            "name": r["name"],
            "chrom": r["chrom"],
            "start": int(r["start"]),
            "end": int(r["end"]),
            "strand": r["strand"],
            "biotype": r["biotype"] or "",
        }
        for r in rows
    ]


def _parse_bigchain_entry_rest(rest: str) -> Optional[Dict[str, Any]]:
    parts = (rest or "").split("\t")
    if len(parts) < 8:
        return None
    try:
        indexed_size = int(parts[3])
        query_size = int(parts[5])
        query_start = int(parts[6])
        query_end = int(parts[7])
    except Exception:
        return None

    strand = parts[2] if parts[2] in {"+", "-"} else "+"
    if strand == "-":
        ref_start = query_size - query_end
        ref_end = query_size - query_start
    else:
        ref_start = query_start
        ref_end = query_end

    return {
        "chain_id": parts[0],
        "score": int(parts[1]) if parts[1].isdigit() else 0,
        "strand": strand,
        "indexed_size": indexed_size,
        "q_size": query_size,
        "ref_seq": parts[4],
        "ref_size": query_size,
        "ref_start": ref_start,
        "ref_end": ref_end,
        "raw_query_start": query_start,
        "raw_query_end": query_end,
        "level": int(parts[8]) if len(parts) >= 9 and parts[8].isdigit() else 0,
    }


def _classify_sv_block(strand: str, target_span: int, ref_span: int) -> str:
    if strand == "-":
        return "inverted_match"
    ratio = float(target_span) / max(1.0, float(ref_span))
    if ratio > 1.2:
        return "gain_or_insertion"
    if ratio < 0.8:
        return "deletion_or_loss"
    return "match"


def _build_sv_segments(blocks: List[Dict[str, Any]], ref_window_span: int) -> List[Dict[str, Any]]:
    if not blocks:
        return []

    gap_ref = max(250, int(max(1, ref_window_span) * 0.015))
    gap_tgt = max(250, int(max(1, ref_window_span) * 0.015))
    sorted_blocks = sorted(blocks, key=lambda b: (int(b["ref_start"]), int(b["tgt_start"])))

    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def _flush(cur: Optional[Dict[str, Any]]):
        if not cur:
            return
        block_count = max(1, int(cur.get("block_count", 1)))
        score_sum = int(cur.get("score_sum", 0))
        cur["score"] = int(round(score_sum / block_count)) if score_sum > 0 else int(cur.get("score", 0))
        cur.pop("score_sum", None)
        segments.append(cur)

    for block in sorted_blocks:
        b_ref_s = int(block["ref_start"])
        b_ref_e = int(block["ref_end"])
        b_tgt_s = int(block["tgt_start"])
        b_tgt_e = int(block["tgt_end"])
        b_type = str(block.get("type") or "match")
        b_strand = str(block.get("strand") or "+")
        b_score = int(block.get("score") or 0)

        if current:
            same_type = b_type == current["type"]
            same_strand = b_strand == current["strand"]
            ref_gap = b_ref_s - int(current["ref_end"])
            if b_strand == "+":
                tgt_gap = b_tgt_s - int(current["tgt_end"])
            else:
                tgt_gap = int(current["tgt_start"]) - b_tgt_e
            can_merge = (
                same_type
                and same_strand
                and ref_gap <= gap_ref
                and tgt_gap <= gap_tgt
            )
            if can_merge:
                current["ref_end"] = max(int(current["ref_end"]), b_ref_e)
                current["tgt_start"] = min(int(current["tgt_start"]), b_tgt_s)
                current["tgt_end"] = max(int(current["tgt_end"]), b_tgt_e)
                current["target_span"] = int(current["tgt_end"]) - int(current["tgt_start"])
                current["ref_span"] = int(current["ref_end"]) - int(current["ref_start"])
                current["block_count"] = int(current.get("block_count", 1)) + 1
                current["score_sum"] = int(current.get("score_sum", 0)) + b_score
                continue

        _flush(current)
        current = {
            "chain_id": block.get("chain_id"),
            "score": b_score,
            "score_sum": b_score,
            "strand": b_strand,
            "ref_start": b_ref_s,
            "ref_end": b_ref_e,
            "tgt_start": b_tgt_s,
            "tgt_end": b_tgt_e,
            "target_span": max(1, b_tgt_e - b_tgt_s),
            "ref_span": max(1, b_ref_e - b_ref_s),
            "type": b_type,
            "block_count": 1,
        }

    _flush(current)

    if len(segments) > 320:
        segments.sort(key=lambda s: ((int(s["ref_end"]) - int(s["ref_start"])) + (int(s["tgt_end"]) - int(s["tgt_start"])), int(s.get("score") or 0)), reverse=True)
        segments = segments[:320]
        segments.sort(key=lambda s: (int(s["ref_start"]), int(s["tgt_start"])))
    return segments


def _build_sv_feature_blocks(blocks: List[Dict[str, Any]], ref_window_span: int) -> List[Dict[str, Any]]:
    if not blocks:
        return []

    feature_candidates = [
        {
            "ref_start": int(b["ref_start"]),
            "ref_end": int(b["ref_end"]),
            "type": str(b.get("type") or "match"),
            "score": int(b.get("score") or 0),
        }
        for b in blocks
        if str(b.get("type") or "match") != "match"
    ]
    if not feature_candidates:
        return []

    feature_candidates.sort(key=lambda f: (f["type"], f["ref_start"], f["ref_end"]))
    gap_ref = max(80, int(max(1, ref_window_span) * 0.003))
    merged: List[Dict[str, Any]] = []

    for feat in feature_candidates:
        if not merged:
            merged.append(dict(feat))
            continue
        last = merged[-1]
        if feat["type"] == last["type"] and feat["ref_start"] <= (last["ref_end"] + gap_ref):
            last["ref_end"] = max(int(last["ref_end"]), int(feat["ref_end"]))
            last["score"] = max(int(last.get("score") or 0), int(feat.get("score") or 0))
        else:
            merged.append(dict(feat))

    if len(merged) > 480:
        merged.sort(key=lambda f: ((int(f["ref_end"]) - int(f["ref_start"])), int(f.get("score") or 0)), reverse=True)
        merged = merged[:480]
        merged.sort(key=lambda f: int(f["ref_start"]))
    return merged


def _build_sv_gap_variants(
    blocks: List[Dict[str, Any]],
    ref_chrom: str,
    ref_start: int,
    ref_end: int,
    max_variants: int = 2500,
) -> List[Dict[str, Any]]:
    if not blocks or ref_end <= ref_start:
        return []

    variants: List[Dict[str, Any]] = []
    consequence_labels = {
        "deletion": "Deletion or loss",
        "insertion": "Gain or insertion",
        "snv": "SNV",
    }
    sorted_blocks = sorted(blocks, key=lambda b: (int(b["ref_start"]), int(b["tgt_start"])))

    for previous, current in zip(sorted_blocks, sorted_blocks[1:]):
        prev_ref_end = int(previous["ref_end"])
        curr_ref_start = int(current["ref_start"])
        if curr_ref_start < (ref_start - 1) or prev_ref_end > (ref_end + 1):
            continue

        prev_strand = str(previous.get("strand") or "+")
        curr_strand = str(current.get("strand") or "+")
        same_reverse = prev_strand == curr_strand == "-"

        ref_gap_start = prev_ref_end + 1
        ref_gap_end = curr_ref_start - 1
        ref_gap = max(0, ref_gap_end - ref_gap_start + 1)

        if same_reverse:
            alt_gap = max(0, int(previous["tgt_start"]) - int(current["tgt_end"]) - 1)
        else:
            alt_gap = max(0, int(current["tgt_start"]) - int(previous["tgt_end"]) - 1)

        if prev_strand != curr_strand:
            continue

        gap_delta = alt_gap - ref_gap
        if ref_gap == 1 and alt_gap == 1:
            variant_type = "snv"
        elif gap_delta >= 1:
            variant_type = "insertion"
        elif gap_delta <= -1:
            variant_type = "deletion"
        else:
            continue

        if ref_gap > 0:
            variant_start = max(int(ref_start), ref_gap_start)
            variant_end = min(int(ref_end), ref_gap_end)
            if variant_end < variant_start:
                continue
        else:
            anchor = min(max(prev_ref_end, int(ref_start)), int(ref_end))
            if anchor < ref_start or anchor > ref_end:
                continue
            variant_start = anchor
            variant_end = anchor

        extent = max(1, ref_gap, alt_gap)
        variants.append(
            {
                "name": f"sv-gap-{previous.get('chain_id', 'block')}-{current.get('chain_id', 'block')}-{variant_start}",
                "type": variant_type,
                "consequence": consequence_labels[variant_type],
                "extent": extent,
                "ref_length": max(0, ref_gap),
                "alt_length": max(0, alt_gap),
                "location": {
                    "region_name": ref_chrom,
                    "start": int(variant_start),
                    "end": int(variant_end),
                },
            }
        )

    variants.sort(key=lambda item: (int(item["location"]["start"]), int(item["location"]["end"]), str(item["type"])))
    if len(variants) > max_variants:
        step = max(1, math.ceil(len(variants) / max_variants))
        variants = variants[::step][:max_variants]
    return variants


def _sv_effective_output_dir(output_dir: Any = "") -> str:
    output_dir_text = str(output_dir or "").strip()
    if output_dir_text:
        return output_dir_text
    try:
        return str(config_store.load_config().get("output_dir") or "").strip()
    except Exception:
        return ""


def _sv_path_status(path_value: Any) -> Dict[str, Any]:
    path = Path(str(path_value or "")).expanduser()
    exists = bool(str(path_value or "").strip()) and path.exists() and path.is_file()
    out: Dict[str, Any] = {
        "path": str(path) if str(path_value or "").strip() else "",
        "exists": exists,
        "size": 0,
        "mtime": 0,
    }
    if exists:
        try:
            stat = path.stat()
            out["size"] = int(stat.st_size)
            out["mtime"] = float(stat.st_mtime)
        except Exception:
            pass
    return out


def _sv_public_data_tracks(dataset: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    tracks = dataset.get("tracks") if isinstance(dataset.get("tracks"), dict) else {}
    out: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    for side in ("reference", "target"):
        for track in tracks.get(side) or []:
            if not isinstance(track, dict):
                continue
            path = str(track.get("path") or "").strip()
            if not path:
                continue
            out[side].append({
                "id": str(track.get("id") or hashlib.sha1(f"{side}|{path}".encode("utf-8")).hexdigest()[:16]),
                "side": side,
                "type": str(track.get("type") or "").strip().lower(),
                "label": str(track.get("label") or "").strip(),
                "path": path,
                "display_mode": str(track.get("display_mode") or "flatten").strip() or "flatten",
                "file": _sv_path_status(path),
            })
    return out


def _sv_record_tokens(record: Optional[Dict[str, Any]]) -> Set[str]:
    if not isinstance(record, dict):
        return set()
    values: List[Any] = [
        record.get("genome_key"),
        record.get("key"),
        _sv_genome_key_from_record(record),
        record.get("assembly"),
        record.get("gca"),
        record.get("accession"),
        record.get("assembly_name"),
    ]
    values.extend(_sv_genome_aliases(record))
    return {token for token in (_normalize_dataset_token(v) for v in values) if token}


def _sv_records_match(left: Optional[Dict[str, Any]], right: Optional[Dict[str, Any]]) -> bool:
    left_tokens = _sv_record_tokens(left)
    right_tokens = _sv_record_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    if left_tokens & right_tokens:
        return True
    for left_token in left_tokens:
        if len(left_token) < 5:
            continue
        for right_token in right_tokens:
            if len(right_token) >= 5 and (left_token in right_token or right_token in left_token):
                return True
    return False


def _sv_catalog_genome_id(genome: Dict[str, Any]) -> str:
    key = str(genome.get("genome_key") or "").strip()
    if key:
        return key
    # The accession before the alias set. Hashing aliases made the id depend on how
    # thoroughly a record happened to be described, so the same assembly reached the
    # catalog twice when one source listed more names for it than another.
    accession = _normalize_dataset_token(
        genome.get("accession") or genome.get("assembly") or genome.get("gca")
    )
    if accession:
        return f"sv_catalog_{accession}"
    aliases = _sv_genome_aliases(genome)
    seed = "|".join(sorted(_normalize_dataset_token(alias) for alias in aliases if alias))
    if not seed:
        seed = str(genome.get("assembly_name") or genome.get("assembly") or genome.get("display_name") or "genome")
    return f"sv_catalog_{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:12]}"


def _sv_public_genome(genome: Dict[str, Any]) -> Dict[str, Any]:
    aliases = _sv_genome_aliases(genome)
    display_name = (
        str(genome.get("display_name") or "").strip()
        or str(genome.get("assembly_name") or "").strip()
        or str(genome.get("assembly") or "").strip()
        or str(genome.get("common_name") or "").strip()
        or str(genome.get("scientific_name") or "").strip()
        or "Genome"
    )
    out = {
        "id": _sv_catalog_genome_id(genome),
        "genome_key": str(genome.get("genome_key") or "").strip(),
        "provider": str(genome.get("provider") or DEFAULT_PROVIDER).strip(),
        "species_key": str(genome.get("species_key") or "").strip(),
        "assembly": str(genome.get("assembly") or genome.get("gca") or "").strip(),
        "gca": str(genome.get("gca") or "").strip(),
        "accession": str(genome.get("accession") or genome.get("assembly") or "").strip(),
        "assembly_name": str(genome.get("assembly_name") or "").strip(),
        "scientific_name": str(genome.get("scientific_name") or "").strip(),
        "common_name": str(genome.get("common_name") or "").strip(),
        "display_name": display_name,
        "aliases": aliases,
    }
    return out


def _sv_pair_id_for_dataset(dataset: Dict[str, Any]) -> str:
    """Identify the genome pair an alignment belongs to, ignoring direction.

    Two alignments between the same assemblies share a pair id whichever way round
    they run, which is what lets the view offer both directions under one entry.
    Datasets built from a config carry this already; scanned and legacy ones do not.
    """
    tokens = sorted(
        _normalize_dataset_token(
            (dataset.get(field) or {}).get("accession")
            or (dataset.get(field) or {}).get("assembly")
            or (dataset.get(field) or {}).get("assembly_name")
        )
        for field in ("reference_genome", "target_genome")
    )
    return "__".join(token for token in tokens if token)


def _sv_public_dataset(dataset: Dict[str, Any]) -> Dict[str, Any]:
    supported, missing = _sv_dataset_file_status(dataset)
    data_tracks = _sv_public_data_tracks(dataset)
    return {
        "id": str(dataset.get("id") or dataset.get("alignment_id") or "").strip(),
        "alignment_id": str(dataset.get("id") or dataset.get("alignment_id") or "").strip(),
        "label": str(dataset.get("label") or "").strip(),
        "description": str(dataset.get("description") or "").strip(),
        "source": str(dataset.get("source") or "").strip(),
        "config_path": str(dataset.get("config_path") or "").strip(),
        "pair_id": str(dataset.get("pair_id") or _sv_pair_id_for_dataset(dataset)).strip(),
        "indexed_side": str(dataset.get("indexed_side") or "target").strip().lower(),
        "reference_genome": _sv_public_genome(dataset.get("reference_genome") or {}),
        "target_genome": _sv_public_genome(dataset.get("target_genome") or {}),
        "ref_aliases": _sv_genome_aliases(dataset.get("reference_genome") or {}, dataset.get("ref_aliases") or []),
        "tgt_aliases": _sv_genome_aliases(dataset.get("target_genome") or {}, dataset.get("tgt_aliases") or []),
        "files": {
            "bigchain": _sv_path_status(dataset.get("chain_path")),
            "reference_mapping": _sv_path_status(dataset.get("ref_mapping_path")),
            "target_mapping": _sv_path_status(dataset.get("tgt_mapping_path")),
            "reference_tracks": data_tracks["reference"],
            "target_tracks": data_tracks["target"],
        },
        "tracks": data_tracks,
        "supported": supported,
        "local": supported,
        "missing_files": missing,
        "reference_regions": _sv_alignment_reference_regions(dataset) if supported else [],
    }


def _sv_local_species_match(genome: Dict[str, Any], local_assemblies: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for assembly in local_assemblies:
        if _sv_records_match(genome, assembly):
            return assembly
    return None


def _sv_downloadable_match(genome: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        if not app_state.download_manager._species_cache and app_state.download_manager.species_data:
            app_state.download_manager._build_cache()
    except Exception:
        pass

    if app_state.download_manager._species_cache:
        for species in app_state.download_manager._species_cache:
            species_key = getattr(species, "key", "") or ""
            for assembly in getattr(species, "assemblies", []) or []:
                candidate = {
                    "provider": DEFAULT_PROVIDER,
                    "species_key": species_key,
                    "scientific_name": getattr(species, "scientific_name", "") or "",
                    "common_name": getattr(species, "common_name", "") or "",
                    "display_name": getattr(species, "display_name", "") or "",
                    "assembly": getattr(assembly, "gca", "") or getattr(assembly, "accession", "") or "",
                    "accession": getattr(assembly, "accession", "") or getattr(assembly, "gca", "") or "",
                    "assembly_name": getattr(assembly, "name", "") or "",
                    "equivalent_accessions": list(getattr(assembly, "equivalent_accessions", []) or []),
                }
                if _sv_records_match(genome, candidate):
                    return candidate

    for species_key, species_info in (app_state.download_manager.species_data or {}).items():
        if not isinstance(species_info, dict):
            continue
        for accession, assembly_info in (species_info.get("assemblies") or {}).items():
            candidate = {
                "provider": DEFAULT_PROVIDER,
                "species_key": species_key,
                "scientific_name": species_info.get("scientific_name") or "",
                "common_name": species_info.get("common_name") or "",
                "display_name": species_info.get("display_name") or "",
                "assembly": accession,
                "accession": accession,
                "assembly_name": assembly_info.get("name") if isinstance(assembly_info, dict) else "",
                "equivalent_accessions": assembly_info.get("equivalent_accessions", []) if isinstance(assembly_info, dict) else [],
            }
            if _sv_records_match(genome, candidate):
                return candidate
    return None


def _sv_catalog_genome_entry(
    genome: Dict[str, Any],
    local_assemblies: List[Dict[str, Any]],
) -> Dict[str, Any]:
    public = _sv_public_genome(genome)
    local_match = _sv_local_species_match(genome, local_assemblies)
    downloadable_match = None if local_match else _sv_downloadable_match(genome)
    local_files = local_match.get("files", {}) if isinstance(local_match, dict) else {}
    public["local"] = bool(local_match)
    public["local_usable"] = bool(local_files.get("gff3") and local_files.get("index") and local_files.get("fasta"))
    public["local_species"] = local_match if local_match else None
    public["downloadable"] = bool(downloadable_match)
    public["download_species"] = downloadable_match
    return public


def _merge_sv_catalog_genome(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    merged = {**existing}
    for key in ("local", "local_usable", "downloadable"):
        merged[key] = bool(existing.get(key) or incoming.get(key))
    for key in ("local_species", "download_species"):
        if not merged.get(key) and incoming.get(key):
            merged[key] = incoming.get(key)
    merged["aliases"] = _sv_unique_strings(list(existing.get("aliases") or []) + list(incoming.get("aliases") or []))
    for key, value in incoming.items():
        if key not in merged or not merged.get(key):
            merged[key] = value
    return merged


class SvAlignmentRegisterRequest(BaseModel):
    output_dir: str = ""
    id: Optional[str] = None
    label: str = ""
    chain_path: str
    description: str = ""
    # Mapping TSVs are no longer part of registration; the fields remain so an
    # older client's payload is accepted rather than rejected outright.
    ref_mapping_path: str = ""
    tgt_mapping_path: str = ""
    # Empty means "work it out from the file name and the assemblies".
    indexed_side: str = ""
    reference_bigwig_path: str = ""
    reference_bigbed_path: str = ""
    target_bigwig_path: str = ""
    target_bigbed_path: str = ""
    tracks: Optional[Dict[str, Any]] = None
    reference_genome: Optional[Dict[str, Any]] = None
    target_genome: Optional[Dict[str, Any]] = None
    ref_aliases: Optional[List[str]] = None
    tgt_aliases: Optional[List[str]] = None
    # Where to save: {"kind": "registry"} or {"kind": "config", "path", "mode"}.
    target: Optional[Dict[str, Any]] = None


@app.get("/api/sv/catalog")
async def sv_catalog(output_dir: str = ""):
    output_dir_text = _sv_effective_output_dir(output_dir)
    datasets, incomplete_scans = _list_sv_datasets(output_dir_text)
    try:
        local_assemblies = await run_in_threadpool(local_inventory.list_local_assemblies, output_dir_text) if output_dir_text else []
    except Exception:
        local_assemblies = []

    public_alignments = [_sv_public_dataset(dataset) for dataset in datasets]
    genomes_by_id: Dict[str, Dict[str, Any]] = {}
    edges: List[Dict[str, Any]] = []

    for dataset, alignment in zip(datasets, public_alignments):
        ref_entry = _sv_catalog_genome_entry(dataset.get("reference_genome") or {}, local_assemblies)
        tgt_entry = _sv_catalog_genome_entry(dataset.get("target_genome") or {}, local_assemblies)
        ref_id = ref_entry["id"]
        tgt_id = tgt_entry["id"]
        genomes_by_id[ref_id] = _merge_sv_catalog_genome(genomes_by_id.get(ref_id, {}), ref_entry)
        genomes_by_id[tgt_id] = _merge_sv_catalog_genome(genomes_by_id.get(tgt_id, {}), tgt_entry)
        alignment["reference_genome"] = genomes_by_id[ref_id]
        alignment["target_genome"] = genomes_by_id[tgt_id]
        alignment["reference_genome_id"] = ref_id
        alignment["target_genome_id"] = tgt_id
        edges.append({
            "alignment_id": alignment["id"],
            "label": alignment.get("label") or alignment["id"],
            "reference_genome_id": ref_id,
            "target_genome_id": tgt_id,
            "source": alignment.get("source") or "",
            "supported": bool(alignment.get("supported")),
            "local": bool(alignment.get("local")),
            "missing_files": alignment.get("missing_files") or [],
        })

    registry_path = _sv_registry_store_path(output_dir_text)
    scan_dir = _sv_alignment_scan_dir(output_dir_text)
    return {
        "alignments": public_alignments,
        "genomes": sorted(genomes_by_id.values(), key=lambda item: (str(item.get("display_name") or ""), str(item.get("id") or ""))),
        "edges": edges,
        "incomplete_scans": incomplete_scans,
        "configs": list(_sv_registry_cache.get("configs") or []),
        "registry_path": str(registry_path) if registry_path else "",
        "scan_dir": str(scan_dir) if scan_dir else "",
    }


def _sv_require_existing_file(label: str, raw_path: Any, required: bool = True) -> str:
    text = str(raw_path or "").strip()
    if not text:
        if required:
            raise HTTPException(status_code=400, detail=f"{label} is required.")
        return ""
    path = Path(text).expanduser()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=400, detail=f"{label} not found: {path}")
    return str(path)


def _sv_read_config_file(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], str]:
    """Read and parse a config file, returning ``(config, diagnostics, text)``."""
    if not path.exists():
        return {SV_CONFIG_VERSION_KEY: 1, "genomes": {}, "pairs": []}, [], ""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read {path}: {exc}")
    config, diagnostics = parse_sv_config(text, base_dir=path.parent)
    return config, sv_locate_pointer_lines(text, diagnostics), text


def _sv_write_config_file(path: Path, config: Dict[str, Any], source_text: Optional[str] = None) -> str:
    """Write a config atomically, under the same lock every SV write takes."""
    existing_text = path.read_text(encoding="utf-8") if path.exists() else ""
    use_records = path.suffix.lower() == ".cfg" and (
        not existing_text or is_sv_key_value_text(existing_text) or
        (source_text is not None and is_sv_key_value_text(source_text))
    )
    if use_records:
        # An editor replacement has already passed validation. Preserve comments,
        # ordering, and blank optional fields exactly as the user wrote them.
        text = source_text if source_text is not None and is_sv_key_value_text(source_text) else serialize_sv_key_value_config(config, base_dir=path.parent)
    else:
        text = serialize_sv_config(sv_config_to_document(config, base_dir=path.parent))
    with _sv_config_write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(f"{path.name}.tmp")
        tmp_path.write_text(text, encoding="utf-8")
        tmp_path.replace(path)
    _sv_registry_cache["signature"] = None
    return text


def _sv_registration_config(payload: "SvAlignmentRegisterRequest", base_dir: Optional[Path]) -> Dict[str, Any]:
    """Turn one registration into a single-alignment config, ready to be merged."""
    label = str(payload.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="An alignment label is required. Labels identify an alignment, so each must be unique.")

    reference_genome = payload.reference_genome or {}
    target_genome = payload.target_genome or {}
    ref_handle = _sv_config_handle(reference_genome)
    tgt_handle = _sv_config_handle(target_genome)
    if not ref_handle or not tgt_handle:
        raise HTTPException(status_code=400, detail="A reference and a target genome are both required.")
    if ref_handle == tgt_handle:
        raise HTTPException(status_code=400, detail="The reference and target must be different genomes.")

    chain = _sv_require_existing_file("BigChain file", payload.chain_path)
    indexed_side = str(payload.indexed_side or "").strip().lower()
    if indexed_side and indexed_side not in {"reference", "target"}:
        raise HTTPException(status_code=400, detail="indexed_side must be 'reference', 'target', or empty to detect it.")

    tracks: Dict[str, List[Dict[str, Any]]] = {ref_handle: [], tgt_handle: []}
    for handle, label_text, raw in (
        (ref_handle, "Reference BigWig", payload.reference_bigwig_path),
        (ref_handle, "Reference BigBed", payload.reference_bigbed_path),
        (tgt_handle, "Target BigWig", payload.target_bigwig_path),
        (tgt_handle, "Target BigBed", payload.target_bigbed_path),
    ):
        resolved = _sv_require_existing_file(label_text, raw, required=False)
        if resolved:
            tracks[handle].append({"path": resolved})

    alignment: Dict[str, Any] = {
        "label": label,
        "reference": ref_handle,
        "target": tgt_handle,
        "chain": chain,
    }
    if str(payload.id or "").strip():
        alignment["id"] = str(payload.id).strip()
    if str(payload.description or "").strip():
        alignment["description"] = str(payload.description).strip()
    if indexed_side:
        alignment["indexed_side"] = indexed_side
    populated = {handle: items for handle, items in tracks.items() if items}
    if populated:
        alignment["tracks"] = populated

    config = {
        SV_CONFIG_VERSION_KEY: 1,
        "genomes": {
            ref_handle: _sv_config_genome_entry(reference_genome),
            tgt_handle: _sv_config_genome_entry(target_genome),
        },
        "pairs": [{"genomes": [ref_handle, tgt_handle], "alignments": [alignment]}],
    }

    parsed, diagnostics = parse_sv_config(config, base_dir=base_dir)
    if sv_config_has_errors(diagnostics):
        detail = "; ".join(item["message"] for item in diagnostics if item["severity"] == "error")
        raise HTTPException(status_code=400, detail=detail)
    return parsed


def _sv_config_handle(genome: Dict[str, Any]) -> str:
    for field in ("assembly_name", "display_name", "accession", "assembly", "gca"):
        text = str((genome or {}).get(field) or "").strip()
        if text:
            return text
    return ""


def _sv_config_genome_entry(genome: Dict[str, Any]) -> Dict[str, Any]:
    source = genome or {}
    accession = str(source.get("accession") or source.get("assembly") or source.get("gca") or "").strip()
    entry: Dict[str, Any] = {"accession": accession}
    assembly_name = str(source.get("assembly_name") or "").strip()
    if assembly_name and assembly_name != accession:
        entry["assembly_name"] = assembly_name
    species = str(source.get("scientific_name") or "").strip()
    if species:
        entry["species"] = species
    equivalents = [str(value).strip() for value in (source.get("equivalent_accessions") or []) if str(value).strip()]
    if equivalents:
        entry["aliases"] = equivalents
    return entry


@app.post("/api/sv/alignments/register")
async def register_sv_alignment(payload: SvAlignmentRegisterRequest):
    """Add one alignment to the registry, or to a config file the user names.

    Registration and hand-writing a config now produce the same file in the same
    format, so a setup built through the interface can be read, edited and shared
    without an export step.
    """
    output_dir_text = _sv_effective_output_dir(payload.output_dir)

    target_kind = str((payload.target or {}).get("kind") or "registry").strip().lower()
    if target_kind == "config":
        raw_path = str((payload.target or {}).get("path") or "").strip()
        if not raw_path:
            raise HTTPException(status_code=400, detail="A config file path is required when saving to a config.")
        destination = validate_config_export_path(raw_path)
        mode = str((payload.target or {}).get("mode") or "merge").strip().lower()
    else:
        destination = _sv_registry_store_path(output_dir_text)
        if not destination:
            raise HTTPException(status_code=400, detail="output_dir is required to register SV alignments.")
        mode = "merge"

    incoming = _sv_registration_config(payload, base_dir=destination.parent)
    existing, diagnostics, _text = _sv_read_config_file(destination)
    if sv_config_has_errors(diagnostics):
        raise HTTPException(
            status_code=400,
            detail=f"{destination} could not be parsed, so it was left untouched. Fix it in the configuration editor first.",
        )

    merged = merge_sv_config(existing, incoming, mode=mode)
    _sv_write_config_file(destination, merged)

    datasets = [
        _normalize_sv_dataset(raw, source="registered", base_dir=destination.parent)
        for raw in sv_config_to_datasets(incoming, source="registered", config_path=str(destination))
    ]
    assembly_index = _sv_local_assembly_index(output_dir_text)
    saved = [_sv_attach_assembly_paths(dataset, assembly_index) for dataset in datasets if dataset]

    return {
        "ok": True,
        "alignment": _sv_public_dataset(saved[0]) if saved else None,
        "registry_path": str(destination),
        "config_path": str(destination),
    }


class SvAlignmentDeleteRequest(BaseModel):
    output_dir: str = ""
    config_path: str = ""


@app.post("/api/sv/alignments/{alignment_id}/delete")
async def delete_sv_alignment(alignment_id: str, payload: SvAlignmentDeleteRequest):
    """Remove one alignment from whichever config holds it.

    A POST rather than a DELETE so the request can name the config file it applies
    to; the app's own registry is the default.
    """
    output_dir_text = _sv_effective_output_dir(payload.output_dir)
    if str(payload.config_path or "").strip():
        destination = validate_config_export_path(payload.config_path)
    else:
        destination = _sv_registry_store_path(output_dir_text)
    if not destination or not destination.exists():
        raise HTTPException(status_code=404, detail="No SV configuration file to remove this alignment from.")

    existing, diagnostics, _text = _sv_read_config_file(destination)
    if sv_config_has_errors(diagnostics):
        raise HTTPException(
            status_code=400,
            detail=f"{destination} could not be parsed, so it was left untouched.",
        )

    updated, removed = sv_remove_alignment(existing, alignment_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"No alignment '{alignment_id}' in {destination.name}.")

    _sv_write_config_file(destination, updated)
    return {"ok": True, "config_path": str(destination)}


class SvConfigValidateRequest(BaseModel):
    text: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    base_dir: str = ""


@app.post("/api/sv/config/validate")
async def validate_sv_config(payload: SvConfigValidateRequest):
    """Check a configuration without writing anything.

    Backs the editor's Validate button, so it has to tolerate whatever half-finished
    text is in the box and answer with diagnostics rather than an error status.
    """
    base_dir = Path(payload.base_dir).expanduser() if str(payload.base_dir or "").strip() else None
    source: Any = payload.text if payload.text is not None else (payload.config or {})
    config, diagnostics = parse_sv_config(source, base_dir=base_dir)
    if isinstance(source, str):
        diagnostics = sv_locate_pointer_lines(source, diagnostics)

    datasets = sv_config_to_datasets(config)
    missing_files: List[str] = []
    for dataset in datasets:
        chain = str(dataset.get("chain_path") or "")
        if chain and not Path(chain).expanduser().exists():
            missing_files.append(chain)
        for field in ("ref_mapping_path", "tgt_mapping_path"):
            path = str(dataset.get(field) or "")
            if path and not Path(path).expanduser().exists():
                missing_files.append(path)
        for side in ("reference", "target"):
            for track in (dataset.get("tracks") or {}).get(side) or []:
                path = str(track.get("path") or "")
                if path and not Path(path).expanduser().exists():
                    missing_files.append(path)

    return {
        "ok": not sv_config_has_errors(diagnostics),
        "config": config,
        "diagnostics": diagnostics,
        "alignment_count": len(datasets),
        "missing_files": missing_files,
    }


@app.get("/api/sv/config")
async def read_sv_config(path: str = "", output_dir: str = ""):
    """Return a config file as text, or the app's registry rendered as one."""
    if str(path or "").strip():
        target = validate_config_export_path(path)
    else:
        target = _sv_registry_store_path(_sv_effective_output_dir(output_dir))
        if not target:
            raise HTTPException(status_code=400, detail="output_dir is required to read the SV registry.")

    if not target.exists():
        empty = {SV_CONFIG_VERSION_KEY: 1, "genomes": {}, "pairs": []}
        return {"path": str(target), "exists": False, "text": serialize_sv_config(empty), "config": empty, "diagnostics": []}

    config, diagnostics, text = _sv_read_config_file(target)
    # A file already in the current format is returned exactly as written, so the
    # editor does not silently reformat what the user typed. A legacy registry has
    # no such form to preserve, so show the migrated document -- rendered the same
    # way a write would render it, not the parsed structure, which carries derived
    # fields nobody should have to read.
    rendered = (
        serialize_sv_config(sv_config_to_document(config, base_dir=target.parent))
        if _sv_config_is_legacy_text(text)
        else text
    )
    return {"path": str(target), "exists": True, "text": rendered, "config": config, "diagnostics": diagnostics}


def _sv_config_is_legacy_text(text: str) -> bool:
    try:
        payload = json.loads(text or "{}")
    except Exception:
        return False
    return isinstance(payload, dict) and SV_CONFIG_VERSION_KEY not in payload


class SvConfigSaveRequest(BaseModel):
    path: str
    text: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    mode: str = "replace"
    attach: bool = False


@app.post("/api/sv/config/save")
async def save_sv_config(payload: SvConfigSaveRequest):
    """Validate, then write. A config that does not parse is never written."""
    destination = validate_config_export_path(payload.path)
    source: Any = payload.text if payload.text is not None else (payload.config or {})
    incoming, diagnostics = parse_sv_config(source, base_dir=destination.parent)
    if isinstance(source, str):
        diagnostics = sv_locate_pointer_lines(source, diagnostics)
    if sv_config_has_errors(diagnostics):
        return {"ok": False, "diagnostics": diagnostics, "path": str(destination)}

    mode = str(payload.mode or "replace").strip().lower()
    if mode == "merge" and destination.exists():
        existing, existing_diagnostics, _text = _sv_read_config_file(destination)
        if sv_config_has_errors(existing_diagnostics):
            raise HTTPException(
                status_code=400,
                detail=f"{destination} could not be parsed, so it was left untouched.",
            )
        final = merge_sv_config(existing, incoming, mode="merge")
    else:
        final = incoming

    text = _sv_write_config_file(destination, final, source_text=source if isinstance(source, str) and mode != "merge" else None)
    if payload.attach:
        _sv_attach_config_path(destination)
    return {"ok": True, "path": str(destination), "text": text, "diagnostics": diagnostics}


class SvConfigAttachRequest(BaseModel):
    path: str


def _sv_attach_config_path(path: Path) -> List[str]:
    config = config_store.load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip()]
    if str(path) not in paths:
        paths.append(str(path))
    config["sv_config_paths"] = paths
    config_store.save_config(config)
    _sv_registry_cache["signature"] = None
    return paths


@app.post("/api/sv/config/attach")
async def attach_sv_config(payload: SvConfigAttachRequest):
    """Add a config file to the set the SV view reads from."""
    target = validate_config_export_path(payload.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Configuration file not found: {target}")
    _config, diagnostics, _text = _sv_read_config_file(target)
    if sv_config_has_errors(diagnostics):
        return {"ok": False, "diagnostics": diagnostics, "path": str(target)}
    return {"ok": True, "path": str(target), "paths": _sv_attach_config_path(target), "diagnostics": diagnostics}


@app.post("/api/sv/config/detach")
def detach_sv_config(payload: SvConfigAttachRequest):
    """Stop reading a config file. The file itself is left alone."""
    target = str(Path(str(payload.path or "").strip()).expanduser())
    config = config_store.load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip() and str(item) != target]
    config["sv_config_paths"] = paths
    config_store.save_config(config)
    _sv_registry_cache["signature"] = None
    return {"ok": True, "paths": paths}


@app.get("/api/sv/view")
async def structural_variation_view(
    ref_assembly: str = "",
    tgt_assembly: str = "",
    ref_chrom: str = "",
    ref_start: int = 0,
    ref_end: int = 0,
    tgt_chrom: str = "",
    tgt_start: Optional[int] = None,
    tgt_end: Optional[int] = None,
    ref_browse_genome: str = "reference",
    tgt_browse_genome: str = "target",
    max_blocks: int = 2000,
    alignment_id: str = "",
    output_dir: str = "",
):
    if not ref_chrom:
        raise HTTPException(status_code=400, detail="ref_chrom is required.")
    if ref_end <= ref_start:
        raise HTTPException(status_code=400, detail="ref_end must be greater than ref_start.")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigChain support requires pyBigWig.")

    dataset = _select_sv_dataset(
        ref_assembly,
        tgt_assembly,
        alignment_id=alignment_id,
        output_dir=_sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return {
            "supported": False,
            "detail": "No registered SV alignment is available for this genome pair.",
        }

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, missing = _sv_dataset_file_status(dataset)
        if not supported:
            return {
                "supported": False,
                "detail": f"SV dataset files not found: {', '.join(missing)}",
            }

        try:
            resolved_ref_browse_genome = str(ref_browse_genome or "reference").strip() or "reference"
            resolved_tgt_browse_genome = str(tgt_browse_genome or "target").strip() or "target"
            ref_db_path = genome_context._get_browse_db(resolved_ref_browse_genome)
            tgt_db_path = genome_context._get_browse_db(resolved_tgt_browse_genome)
        except HTTPException as e:
            return {"supported": False, "detail": e.detail}

        ref_map = _sv_side_mapping(dataset, "reference")
        tgt_map = _sv_side_mapping(dataset, "target")

        ref_seq = _resolve_sv_sequence(ref_map, ref_chrom)
        if not ref_seq:
            return {
                "supported": False,
                "detail": f"Reference chromosome '{ref_chrom}' is not aligned in '{dataset.get('label') or dataset.get('id')}'.",
            }

        tgt_seq = _resolve_sv_sequence(tgt_map, tgt_chrom) if tgt_chrom else None
        if not tgt_seq:
            tgt_seq = str(ref_seq)
        if tgt_seq not in tgt_map["assembly_to_hal"]:
            tgt_seq = _resolve_sv_sequence(tgt_map, str(ref_seq))
        if not tgt_seq:
            return {
                "supported": False,
                "detail": "Could not resolve a target chromosome for this SV dataset.",
            }

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return {"supported": False, "detail": f"Failed to open BigChain file: {chain_path}"}
        if bw is None:
            return {"supported": False, "detail": f"Failed to open BigChain file: {chain_path}"}

        try:
            chrom_sizes = bw.chroms() or {}
            indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()
            if indexed_side not in {"reference", "target"}:
                indexed_side = "target"

            chain_lookup_seq = str(ref_seq) if indexed_side == "reference" else str(tgt_seq)
            chain_chrom = _resolve_bigwig_chrom_name(chain_lookup_seq, chrom_sizes)
            if not chain_chrom:
                return {
                    "supported": False,
                    "detail": f"Indexed sequence '{chain_lookup_seq}' is not present in the BigChain file.",
                }

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return {"supported": False, "detail": f"Invalid BigChain chromosome length for {chain_chrom}."}

            ref_s = max(0, int(ref_start))
            ref_e = max(ref_s + 1, int(ref_end))
            ref_span = max(1, ref_e - ref_s)

            has_target_window = (
                tgt_start is not None
                and tgt_end is not None
                and int(tgt_end) > int(tgt_start)
            )
            query_tgt_start = max(0, int(tgt_start)) if has_target_window else 0
            query_tgt_end = max(query_tgt_start + 1, int(tgt_end)) if has_target_window else 0

            def _load_entries(start_pos: int, end_pos: int) -> List[Tuple[int, int, str]]:
                s = max(0, int(start_pos))
                e = min(chain_len, int(end_pos))
                if e <= s:
                    return []
                return bw.entries(chain_chrom, s, e) or []

            if indexed_side == "reference":
                query_ref_start = max(0, int(ref_s))
                query_ref_end = min(chain_len, int(ref_e))
                if query_ref_end <= query_ref_start:
                    query_ref_end = min(chain_len, query_ref_start + 1)
                raw_entries = _load_entries(query_ref_start, query_ref_end)
            else:
                if has_target_window:
                    query_tgt_start = max(0, int(tgt_start))
                    query_tgt_end = min(chain_len, int(tgt_end))
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)
                else:
                    # Heuristic seed around the same numeric locus as reference.
                    # This avoids scanning full chromosome on first draw and keeps panning responsive.
                    pad = max(250000, int(ref_span * 2.0))
                    center_guess = (ref_s + ref_e) // 2
                    query_tgt_start = max(0, center_guess - pad)
                    query_tgt_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)

            def _entries_to_blocks(entries: List[Tuple[int, int, str]]) -> List[dict]:
                parsed_blocks: List[dict] = []
                for chrom_start, chrom_end, rest in entries:
                    parsed = _parse_bigchain_entry_rest(rest)
                    if not parsed:
                        continue

                    if indexed_side == "reference":
                        # In this mode, BigChain bed coordinates are on the reference side.
                        if str(parsed["ref_seq"]) != str(tgt_seq):
                            continue
                        ref_block_start = int(chrom_start)
                        ref_block_end = int(chrom_end)
                        tgt_block_start = int(parsed["ref_start"])
                        tgt_block_end = int(parsed["ref_end"])
                    else:
                        # In this mode, BigChain bed coordinates are on the target side.
                        if str(parsed["ref_seq"]) != str(ref_seq):
                            continue
                        ref_block_start = int(parsed["ref_start"])
                        ref_block_end = int(parsed["ref_end"])
                        tgt_block_start = int(chrom_start)
                        tgt_block_end = int(chrom_end)

                    if ref_block_end < ref_block_start:
                        ref_block_start, ref_block_end = ref_block_end, ref_block_start
                    if tgt_block_end < tgt_block_start:
                        tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                    if ref_block_end < ref_s or ref_block_start > ref_e:
                        continue
                    tgt_span = max(1, tgt_block_end - tgt_block_start)
                    ref_block_span = max(1, ref_block_end - ref_block_start)
                    block_type = _classify_sv_block(parsed["strand"], tgt_span, ref_block_span)

                    parsed_blocks.append(
                        {
                            "chain_id": parsed["chain_id"],
                            "score": parsed["score"],
                            "strand": parsed["strand"],
                            "ref_start": ref_block_start,
                            "ref_end": ref_block_end,
                            "tgt_start": tgt_block_start,
                            "tgt_end": tgt_block_end,
                            "target_span": tgt_span,
                            "ref_span": ref_block_span,
                            "type": block_type,
                        }
                    )
                parsed_blocks.sort(key=lambda b: (b["ref_start"], b["tgt_start"]))
                return parsed_blocks

            blocks = _entries_to_blocks(raw_entries)
            segments = _build_sv_segments(blocks, ref_span)
            feature_blocks = _build_sv_feature_blocks(blocks, ref_span)
            if not has_target_window and not blocks:
                # Fallback wider fetch once if the seeded indexed window missed mappings.
                pad = max(1000000, int(ref_span * 5.0))
                center_guess = (ref_s + ref_e) // 2
                if indexed_side == "reference":
                    query_ref_start = max(0, center_guess - pad)
                    query_ref_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_ref_start, query_ref_end)
                else:
                    query_tgt_start = max(0, center_guess - pad)
                    query_tgt_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)
                blocks = _entries_to_blocks(raw_entries)
                segments = _build_sv_segments(blocks, ref_span)
                feature_blocks = _build_sv_feature_blocks(blocks, ref_span)

            # Keep the target window large enough to include all mapped blocks in the
            # current reference window. This prevents flanking match blocks from
            # disappearing after an inversion-focused drag/zoom.
            if blocks:
                min_t = min(int(b["tgt_start"]) for b in blocks)
                max_t = max(int(b["tgt_end"]) for b in blocks)
                query_tgt_start = min(int(query_tgt_start), int(min_t))
                query_tgt_end = max(int(query_tgt_end), int(max_t))
            max_blocks_limit = max(200, min(5000, int(max_blocks)))
            if len(blocks) > max_blocks_limit:
                step = max(1, len(blocks) // max_blocks_limit)
                blocks = blocks[::step][:max_blocks_limit]

            if not has_target_window:
                if blocks:
                    min_t = min(b["tgt_start"] for b in blocks)
                    max_t = max(b["tgt_end"] for b in blocks)
                    pad = max(10000, int((max_t - min_t) * 0.15))
                    query_tgt_start = max(0, min_t - pad)
                    query_tgt_end = max_t + pad
                else:
                    query_tgt_start = 0
                    query_tgt_end = max(1, ref_span)

            if query_tgt_end <= query_tgt_start:
                query_tgt_end = min(chain_len, query_tgt_start + 1)

            ref_display = ref_map["assembly_to_hal"].get(str(ref_seq), str(ref_seq))
            tgt_display = tgt_map["assembly_to_hal"].get(str(tgt_seq), str(tgt_seq))

            ref_db_chrom = (
                _resolve_db_chrom_name_for_genome(ref_db_path, ref_chrom, resolved_ref_browse_genome)
                or _resolve_db_chrom_name_for_genome(ref_db_path, ref_display, resolved_ref_browse_genome)
                or _resolve_db_chrom_name_for_genome(ref_db_path, str(ref_seq), resolved_ref_browse_genome)
                or ref_chrom
            )
            tgt_db_chrom = (
                _resolve_db_chrom_name_for_genome(tgt_db_path, tgt_chrom, resolved_tgt_browse_genome) if tgt_chrom else None
            ) or _resolve_db_chrom_name_for_genome(tgt_db_path, tgt_display, resolved_tgt_browse_genome) or _resolve_db_chrom_name_for_genome(tgt_db_path, str(tgt_seq), resolved_tgt_browse_genome) or tgt_display

            ref_fasta_chrom, ref_chrom_length = _resolve_genome_chrom_length(
                resolved_ref_browse_genome,
                ref_db_chrom,
                ref_chrom,
                ref_display,
                str(ref_seq),
            )
            tgt_fasta_chrom, tgt_chrom_length = _resolve_genome_chrom_length(
                resolved_tgt_browse_genome,
                tgt_db_chrom,
                tgt_chrom,
                tgt_display,
                str(tgt_seq),
            )
            # Fall back to bigchain chromosome length when FASTA is not configured
            if ref_chrom_length == 0 and indexed_side == "reference":
                ref_chrom_length = chain_len
            if tgt_chrom_length == 0 and indexed_side == "target":
                tgt_chrom_length = chain_len
            ref_chrom_sizes = _build_sv_chrom_size_aliases(
                ref_chrom_length,
                ref_db_chrom,
                ref_chrom,
                ref_display,
                str(ref_seq),
                ref_fasta_chrom,
            )
            tgt_chrom_sizes = _build_sv_chrom_size_aliases(
                tgt_chrom_length,
                tgt_db_chrom,
                tgt_chrom,
                tgt_display,
                str(tgt_seq),
                tgt_fasta_chrom,
            )

            def _gene_limit(s, e):
                span = max(1, e - s)
                if span <= 500_000:
                    return 1200
                if span <= 5_000_000:
                    return 400
                return 150

            ref_genes = _fetch_genes_for_window(ref_db_path, ref_db_chrom, ref_s, ref_e, limit=_gene_limit(ref_s, ref_e))
            tgt_genes = _fetch_genes_for_window(tgt_db_path, tgt_db_chrom, query_tgt_start, query_tgt_end, limit=_gene_limit(query_tgt_start, query_tgt_end))

            return {
                "supported": True,
                "detail": "",
                "alignment_id": str(dataset.get("id") or dataset.get("alignment_id") or ""),
                "dataset_label": dataset.get("label", "Structural variation"),
                "ref_chrom": ref_db_chrom,
                "ref_display_chrom": ref_display,
                "ref_sequence": str(ref_seq),
                "ref_chrom_length": int(ref_chrom_length),
                "ref_chrom_sizes": ref_chrom_sizes,
                "ref_start": ref_s,
                "ref_end": ref_e,
                "tgt_chrom": tgt_db_chrom,
                "tgt_display_chrom": tgt_display,
                "tgt_sequence": str(tgt_seq),
                "tgt_chrom_length": int(tgt_chrom_length),
                "tgt_chrom_sizes": tgt_chrom_sizes,
                "tgt_start": int(query_tgt_start),
                "tgt_end": int(query_tgt_end),
                "tracks": _sv_public_data_tracks(dataset),
                "blocks": blocks,
                "segments": segments,
                "feature_blocks": feature_blocks,
                "ref_genes": ref_genes,
                "tgt_genes": tgt_genes,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


def _parse_sv_viewport(viewport: str):
    """Parse '{chrom}:{start}-{end}' into (chrom, start, end) or None."""
    if not viewport:
        return None
    colon = viewport.find(":")
    if colon < 1:
        return None
    chrom = viewport[:colon]
    rest = viewport[colon + 1:]
    dash = rest.find("-")
    if dash < 0:
        return None
    try:
        start = int(rest[:dash])
        end = int(rest[dash + 1:])
    except ValueError:
        return None
    if end <= start:
        return None
    return chrom, start, end


def _sv_ranges_overlap(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return end_a > start_b and end_b > start_a


def _sv_expand_range(start: int, end: int, min_start: int = 0, pad_ratio: float = 1.5, min_pad: int = 500_000) -> Tuple[int, int]:
    span = max(1, int(end) - int(start))
    pad = max(int(min_pad), int(span * pad_ratio))
    expanded_start = max(int(min_start), int(start) - pad)
    expanded_end = int(end) + pad
    return expanded_start, expanded_end


@app.get("/api/sv/alignments")
async def sv_alignments(
    reference_genome_id: str = "",
    alt_genome_id: str = "",
    reference_viewport: str = "",
    alt_viewport: str = "",
    query_side: str = "",
    alignment_id: str = "",
    output_dir: str = "",
):
    """Return Alignment[] objects for the Beta ens-sv-alignments web component."""
    if pyBigWig is None:
        return []

    use_ref_vp = _parse_sv_viewport(reference_viewport)
    use_alt_vp = _parse_sv_viewport(alt_viewport)
    if not use_ref_vp and not use_alt_vp:
        return []

    dataset = _select_sv_dataset(
        reference_genome_id,
        alt_genome_id,
        alignment_id=alignment_id,
        output_dir=_sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return []

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, _missing = _sv_dataset_file_status(dataset)
        if not supported:
            return []

        ref_map = _sv_side_mapping(dataset, "reference")
        tgt_map = _sv_side_mapping(dataset, "target")
        indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()

        ref_query_chrom = use_ref_vp[0] if use_ref_vp else ""
        tgt_query_chrom = use_alt_vp[0] if use_alt_vp else ""
        ref_query_start = int(use_ref_vp[1]) if use_ref_vp else 0
        ref_query_end = int(use_ref_vp[2]) if use_ref_vp else 0
        tgt_query_start = int(use_alt_vp[1]) if use_alt_vp else 0
        tgt_query_end = int(use_alt_vp[2]) if use_alt_vp else 0

        ref_seq = _resolve_sv_sequence(ref_map, ref_query_chrom) or _resolve_sv_sequence(ref_map, tgt_query_chrom)
        tgt_seq = _resolve_sv_sequence(tgt_map, tgt_query_chrom) or _resolve_sv_sequence(tgt_map, ref_query_chrom)

        normalized_query_side = str(query_side or "").strip().lower()
        preferred_ref_query = normalized_query_side == "reference"
        preferred_alt_query = normalized_query_side == "alt"

        if preferred_ref_query and use_ref_vp:
            query_chrom, query_start, query_end = use_ref_vp
            is_ref_query = True
        elif preferred_alt_query and use_alt_vp:
            query_chrom, query_start, query_end = use_alt_vp
            is_ref_query = False
        elif indexed_side == "reference":
            if use_ref_vp:
                query_chrom, query_start, query_end = use_ref_vp
                is_ref_query = True
            elif use_alt_vp:
                query_chrom, query_start, query_end = use_alt_vp
                is_ref_query = False
            else:
                return []
        else:
            if use_alt_vp:
                query_chrom, query_start, query_end = use_alt_vp
                is_ref_query = False
            elif use_ref_vp:
                query_chrom, query_start, query_end = use_ref_vp
                is_ref_query = True
            else:
                return []

        # Determine which chromosome name to look up depending on query side.
        if is_ref_query:
            lookup_seq = ref_seq
        else:
            lookup_seq = tgt_seq or ref_seq

        if not lookup_seq:
            return []

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return []
        if bw is None:
            return []

        try:
            chrom_sizes = bw.chroms() or {}

            # Resolve the sequence name used in the BigChain index.
            if indexed_side == "reference":
                chain_seq = ref_seq or lookup_seq
            else:
                chain_seq = tgt_seq or lookup_seq

            chain_chrom = _resolve_bigwig_chrom_name(chain_seq, chrom_sizes)
            if not chain_chrom:
                return []

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return []

            indexed_query_side = "reference" if indexed_side == "reference" else "alt"
            requested_span = max(
                1,
                int(ref_query_end - ref_query_start) if is_ref_query else int(tgt_query_end - tgt_query_start),
            )
            cross_index_query = (indexed_side == "reference") != is_ref_query

            if cross_index_query and requested_span <= 250_000:
                # For sequence-level colouring, the queried side can be the non-indexed
                # side of the BigChain. A stale or inverted opposite viewport can miss
                # the relevant blocks, so scan the indexed chromosome and filter below.
                q_s = 0
                q_e = chain_len
            elif indexed_side == "reference" and use_ref_vp:
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
            elif indexed_side != "reference" and use_alt_vp:
                q_s = max(0, int(tgt_query_start))
                q_e = min(chain_len, int(tgt_query_end))
            else:
                q_s = max(0, query_start)
                q_e = min(chain_len, query_end)
                if q_e <= q_s:
                    return []

                # When we don't have the indexed-side viewport, seed around the
                # same numeric locus as a fallback.
                if (indexed_side == "reference") != is_ref_query:
                    span = max(1, q_e - q_s)
                    pad = max(250_000, int(span * 2.0))
                    center = (q_s + q_e) // 2
                    q_s = max(0, center - pad)
                    q_e = min(chain_len, center + pad)

            if q_e <= q_s:
                return []

            if normalized_query_side and normalized_query_side != indexed_query_side and not (
                cross_index_query and requested_span <= 250_000
            ):
                cross_query_span = max(
                    1,
                    int(ref_query_end - ref_query_start) if normalized_query_side == "reference" else int(tgt_query_end - tgt_query_start),
                )
                q_s, q_e = _sv_expand_range(
                    q_s,
                    q_e,
                    1 if indexed_side == "reference" else 0,
                    pad_ratio=4.0,
                    min_pad=max(1_000_000, cross_query_span * 3),
                )
                q_e = min(chain_len, int(q_e))

            raw_entries = bw.entries(chain_chrom, q_s, q_e) or []

            ref_seq_for_filter = ref_seq or ""
            tgt_seq_for_filter = tgt_seq or lookup_seq or ""

            alignments = []
            seen_ids: set = set()
            for chrom_start, chrom_end, rest in raw_entries:
                parsed = _parse_bigchain_entry_rest(rest)
                if not parsed:
                    continue

                if indexed_side == "reference":
                    if str(parsed["ref_seq"]) != str(tgt_seq_for_filter):
                        continue
                    ref_block_start = int(chrom_start)
                    ref_block_end = int(chrom_end)
                    tgt_block_start = int(parsed["ref_start"])
                    tgt_block_end = int(parsed["ref_end"])
                    ref_chrom_name = str(chain_seq)
                    tgt_chrom_name = str(parsed["ref_seq"])
                else:
                    if str(parsed["ref_seq"]) != str(ref_seq_for_filter):
                        continue
                    ref_block_start = int(parsed["ref_start"])
                    ref_block_end = int(parsed["ref_end"])
                    tgt_block_start = int(chrom_start)
                    tgt_block_end = int(chrom_end)
                    ref_chrom_name = str(parsed["ref_seq"])
                    tgt_chrom_name = str(chain_seq)

                if ref_block_end < ref_block_start:
                    ref_block_start, ref_block_end = ref_block_end, ref_block_start
                if tgt_block_end < tgt_block_start:
                    tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                if is_ref_query:
                    if not _sv_ranges_overlap(ref_block_start, ref_block_end, query_start, query_end):
                        continue
                elif not _sv_ranges_overlap(tgt_block_start, tgt_block_end, query_start, query_end):
                    continue

                ref_visible = False
                alt_visible = False
                if use_ref_vp:
                    relaxed_ref_start, relaxed_ref_end = _sv_expand_range(
                        ref_query_start,
                        ref_query_end,
                        1,
                        pad_ratio=1.0,
                        min_pad=max(250_000, int((ref_query_end - ref_query_start) * 0.5)),
                    )
                    ref_visible = _sv_ranges_overlap(ref_block_start, ref_block_end, relaxed_ref_start, relaxed_ref_end)
                if use_alt_vp:
                    relaxed_tgt_start, relaxed_tgt_end = _sv_expand_range(
                        tgt_query_start,
                        tgt_query_end,
                        0,
                        pad_ratio=1.0,
                        min_pad=max(250_000, int((tgt_query_end - tgt_query_start) * 0.5)),
                    )
                    alt_visible = _sv_ranges_overlap(tgt_block_start, tgt_block_end, relaxed_tgt_start, relaxed_tgt_end)

                if use_ref_vp and use_alt_vp:
                    if not (ref_visible or alt_visible):
                        continue
                elif use_ref_vp and not ref_visible:
                    continue
                elif use_alt_vp and not alt_visible:
                    continue

                ref_len = max(1, ref_block_end - ref_block_start)
                tgt_len = max(1, tgt_block_end - tgt_block_start)
                strand = str(parsed.get("strand") or "+")
                alt_strand = "reverse" if strand == "-" else "forward"

                aln_id = f"{parsed['chain_id']}:{ref_block_start}:{tgt_block_start}"
                if aln_id in seen_ids:
                    continue
                seen_ids.add(aln_id)

                # Resolve user-facing chromosome names from the mapping tables.
                ref_display = ref_map["hal_to_assembly"].get(ref_chrom_name, ref_chrom_name)
                tgt_display = tgt_map["hal_to_assembly"].get(tgt_chrom_name, tgt_chrom_name)

                alignments.append({
                    "id": aln_id,
                    "reference": {
                        "region_name": ref_display,
                        "start": ref_block_start,
                        "strand": "forward",
                        "length": ref_len,
                    },
                    "alt": {
                        "region_name": tgt_display,
                        "start": tgt_block_start,
                        "strand": alt_strand,
                        "length": tgt_len,
                    },
                })

            alignments.sort(key=lambda a: a["reference"]["start"])
            return alignments

        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


@app.get("/api/sv/variants")
async def sv_variants(
    reference_genome_id: str = "",
    alt_genome_id: str = "",
    viewport: str = "",
    reference_viewport: str = "",
    alt_viewport: str = "",
    alignment_id: str = "",
    output_dir: str = "",
):
    """Return haplotype-variant markers derived from local chain gaps."""
    if pyBigWig is None:
        return []

    ref_viewport = _parse_sv_viewport(reference_viewport) or _parse_sv_viewport(viewport)
    tgt_viewport = _parse_sv_viewport(alt_viewport)
    if not ref_viewport and not tgt_viewport:
        return []

    dataset = _select_sv_dataset(
        reference_genome_id,
        alt_genome_id,
        alignment_id=alignment_id,
        output_dir=_sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return []

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, _missing = _sv_dataset_file_status(dataset)
        if not supported:
            return []

        ref_map = _sv_side_mapping(dataset, "reference")
        tgt_map = _sv_side_mapping(dataset, "target")
        indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()

        ref_query_chrom = ref_viewport[0] if ref_viewport else ""
        ref_query_start = int(ref_viewport[1]) if ref_viewport else 0
        ref_query_end = int(ref_viewport[2]) if ref_viewport else 0
        tgt_query_chrom = tgt_viewport[0] if tgt_viewport else ""
        tgt_query_start = int(tgt_viewport[1]) if tgt_viewport else 0
        tgt_query_end = int(tgt_viewport[2]) if tgt_viewport else 0

        ref_seq = _resolve_sv_sequence(ref_map, ref_query_chrom)
        tgt_seq = _resolve_sv_sequence(tgt_map, tgt_query_chrom) if tgt_query_chrom else _resolve_sv_sequence(tgt_map, ref_query_chrom)
        if not ref_seq:
            return []

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return []
        if bw is None:
            return []

        try:
            chrom_sizes = bw.chroms() or {}
            chain_seq = ref_seq if indexed_side == "reference" else (tgt_seq or str(ref_seq))

            chain_chrom = _resolve_bigwig_chrom_name(chain_seq, chrom_sizes)
            if not chain_chrom:
                return []

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return []

            if indexed_side == "reference":
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
            elif tgt_viewport:
                q_s = max(0, int(tgt_query_start))
                q_e = min(chain_len, int(tgt_query_end))
            else:
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
                span = max(1, q_e - q_s)
                pad = max(250_000, int(span * 2.0))
                center = (q_s + q_e) // 2
                q_s = max(0, center - pad)
                q_e = min(chain_len, center + pad)

            if q_e <= q_s:
                return []

            raw_entries = bw.entries(chain_chrom, q_s, q_e) or []
            blocks: List[Dict[str, Any]] = []

            for chrom_start, chrom_end, rest in raw_entries:
                parsed = _parse_bigchain_entry_rest(rest)
                if not parsed:
                    continue

                if indexed_side == "reference":
                    if tgt_seq and str(parsed["ref_seq"]) != str(tgt_seq):
                        continue
                    ref_block_start = int(chrom_start)
                    ref_block_end = int(chrom_end)
                    tgt_block_start = int(parsed["ref_start"])
                    tgt_block_end = int(parsed["ref_end"])
                    tgt_seq_name = str(parsed["ref_seq"])
                else:
                    if str(parsed["ref_seq"]) != str(ref_seq):
                        continue
                    ref_block_start = int(parsed["ref_start"])
                    ref_block_end = int(parsed["ref_end"])
                    tgt_block_start = int(chrom_start)
                    tgt_block_end = int(chrom_end)
                    tgt_seq_name = chain_seq

                if ref_block_end < ref_block_start:
                    ref_block_start, ref_block_end = ref_block_end, ref_block_start
                if tgt_block_end < tgt_block_start:
                    tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                if ref_viewport and not _sv_ranges_overlap(ref_block_start, ref_block_end, ref_query_start, ref_query_end):
                    continue
                if tgt_viewport and not _sv_ranges_overlap(tgt_block_start, tgt_block_end, tgt_query_start, tgt_query_end):
                    continue

                tgt_span = max(1, tgt_block_end - tgt_block_start)
                ref_span = max(1, ref_block_end - ref_block_start)
                blocks.append(
                    {
                        "chain_id": parsed["chain_id"],
                        "score": parsed["score"],
                        "strand": parsed["strand"],
                        "ref_start": ref_block_start,
                        "ref_end": ref_block_end,
                        "tgt_start": tgt_block_start,
                        "tgt_end": tgt_block_end,
                        "target_span": tgt_span,
                        "ref_span": ref_span,
                        "type": _classify_sv_block(parsed["strand"], tgt_span, ref_span),
                        "tgt_seq": tgt_seq_name,
                    }
                )

            ref_display = ref_map["hal_to_assembly"].get(str(ref_seq), ref_query_chrom)
            return _build_sv_gap_variants(
                blocks=blocks,
                ref_chrom=ref_display,
                ref_start=int(ref_query_start),
                ref_end=int(ref_query_end),
            )
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


# ─────────────────────────────────────────────────────────────────────────────
# Sequence export helpers
# ─────────────────────────────────────────────────────────────────────────────

_FEATURE_SLUGS: Dict[str, str] = {
    "genomic":    "genomic",
    "transcript": "transcript",
    "cds":        "cds",
    "exons":      "exons",
    "utr5":       "5primeutr",
    "utr3":       "3primeutr",
    "introns":    "introns",
    "protein":    "protein",
    "utr":        "utr",
}


def _is_five_prime_utr(utr: Dict[str, Any]) -> bool:
    ft = str(utr.get("feature_type", "") or "").lower()
    return "five" in ft or "5_prime" in ft or "5prime" in ft


def _is_three_prime_utr(utr: Dict[str, Any]) -> bool:
    ft = str(utr.get("feature_type", "") or "").lower()
    return "three" in ft or "3_prime" in ft or "3prime" in ft


def _compute_utr_intervals(
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    strand: str,
    which: str,  # "utr5" | "utr3"
) -> List[Dict[str, Any]]:
    """Derive UTR intervals from exon / CDS overlap when explicit UTR records are absent."""
    if not exons or not cds_list:
        return []
    cds_min = min(int(c["start"]) for c in cds_list)
    cds_max = max(int(c["end"])   for c in cds_list)
    result: List[Dict[str, Any]] = []
    for exon in exons:
        e_start = int(exon["start"])
        e_end   = int(exon["end"])
        if strand == "+":
            if which == "utr5" and e_start < cds_min:
                result.append({"start": e_start, "end": min(e_end, cds_min - 1)})
            elif which == "utr3" and e_end > cds_max:
                result.append({"start": max(e_start, cds_max + 1), "end": e_end})
        else:  # minus strand: 5' UTR is genomically after CDS, 3' UTR is before
            if which == "utr5" and e_end > cds_max:
                result.append({"start": max(e_start, cds_max + 1), "end": e_end})
            elif which == "utr3" and e_start < cds_min:
                result.append({"start": e_start, "end": min(e_end, cds_min - 1)})
    return result


def _compute_introns_from_exons(exons: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return intron intervals (genomic) sorted ascending by start position."""
    if len(exons) < 2:
        return []
    sorted_exons = sorted(exons, key=lambda e: int(e["start"]))
    introns: List[Dict[str, Any]] = []
    for i in range(len(sorted_exons) - 1):
        i_start = int(sorted_exons[i]["end"]) + 1
        i_end   = int(sorted_exons[i + 1]["start"]) - 1
        if i_end >= i_start:
            introns.append({"start": i_start, "end": i_end})
    return introns


def _wrap_sequence(seq: str, width: int = 60) -> str:
    return "\n".join(seq[i:i + width] for i in range(0, max(1, len(seq)), width))


def _build_fasta_header(
    tx_id: str,
    gene_id: str,
    feature_name: str,
    chrom: str,
    g_start: int,
    g_end: int,
    strand: str,
    seq_len: int,
    header_fields: Dict[str, bool],
    biotype: str,
    canonical_info: str,
    rank: Optional[int] = None,
    length_unit: str = "bp",
) -> str:
    parts: List[str] = [f">{tx_id}"]
    if gene_id and gene_id != tx_id:
        parts.append(f"gene={gene_id}")
    parts.append(f"feature={feature_name}")
    # Rank is its own field rather than a suffix on the feature name, so the
    # feature stays greppable as "exon" and the ordinal is machine-readable.
    if rank is not None and header_fields.get("exon_number", True):
        parts.append(f"{feature_name}_rank:{rank}")
    if header_fields.get("location"):
        parts.append(f"{chrom}:{g_start}-{g_end}")
    if header_fields.get("strand"):
        parts.append(f"strand={'forward' if strand == '+' else 'reverse'}")
    if header_fields.get("length"):
        parts.append(f"len={seq_len}{length_unit}")
    if header_fields.get("biotype") and biotype:
        parts.append(f"biotype={biotype}")
    if header_fields.get("canonical_status") and canonical_info:
        parts.append(f"[{canonical_info}]")
    return " ".join(parts)


def _apply_orientations(records: List[str], orientations: List[str]) -> List[str]:
    """Expand records to include forward and/or reverse-complement orientations."""
    include_fwd = "fwd" in orientations
    include_rev = "rev" in orientations
    if not include_fwd and not include_rev:
        return records  # fallback: return as-is
    _rc_table = str.maketrans("ACGTNacgtn", "TGCANtgcan")

    def _rev_comp(seq: str) -> str:
        return seq.translate(_rc_table)[::-1]

    result: List[str] = []
    for rec in records:
        header, _, seq_block = rec.partition("\n")
        seq = seq_block.replace("\n", "")
        if include_fwd:
            result.append(rec)
        if include_rev:
            result.append(f"{header} [rc]\n{_wrap_sequence(_rev_comp(seq))}")
    return result


def _extract_feature_records(
    fasta,
    chrom: str,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
    feature_type: str,
    tx_id: str,
    gene_id: str,
    header_fields: Dict[str, bool],
    biotype: str,
    canonical_info: str,
    tx_genomic_span: Optional[Tuple[int, int]] = None,
    genome: str = "reference",
) -> List[str]:
    """Return a list of FASTA record strings (header + wrapped sequence) for one feature type."""
    records: List[str] = []
    include_num = header_fields.get("exon_number", True)

    if feature_type == "genomic":
        if tx_genomic_span and tx_genomic_span[0] and tx_genomic_span[1]:
            g_start = min(tx_genomic_span)
            g_end   = max(tx_genomic_span)
        elif exons:
            g_start = min(int(e["start"]) for e in exons)
            g_end   = max(int(e["end"])   for e in exons)
        else:
            return []
        seq = _fetch_oriented_piece(fasta, chrom, g_start, g_end, strand)
        if not seq:
            return []
        hdr = _build_fasta_header(tx_id, gene_id, "genomic", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "transcript":
        if not exons:
            return []
        ordered = _ordered_five_to_three(exons, strand)
        seq = "".join(_fetch_oriented_piece(fasta, chrom, e["start"], e["end"], strand) for e in ordered)
        if not seq:
            return []
        g_start = min(int(e["start"]) for e in exons)
        g_end   = max(int(e["end"])   for e in exons)
        hdr = _build_fasta_header(tx_id, gene_id, "transcript", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "cds":
        if not cds_list:
            return []
        ordered = _ordered_five_to_three(cds_list, strand)
        seq = "".join(_fetch_oriented_piece(fasta, chrom, c["start"], c["end"], strand) for c in ordered)
        if not seq:
            return []
        g_start = min(int(c["start"]) for c in cds_list)
        g_end   = max(int(c["end"])   for c in cds_list)
        hdr = _build_fasta_header(tx_id, gene_id, "cds", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "exons":
        if not exons:
            return []
        ordered = _ordered_five_to_three(exons, strand)
        for i, exon in enumerate(ordered, 1):
            seq = _fetch_oriented_piece(fasta, chrom, exon["start"], exon["end"], strand)
            if not seq:
                continue
            hdr = _build_fasta_header(tx_id, gene_id, "exon", chrom, int(exon["start"]), int(exon["end"]), strand, len(seq), header_fields, biotype, canonical_info, rank=i if include_num else None)
            records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "utr":
        # Both ends under one heading, 5' first: a reader asking for "the UTR"
        # wants whichever this transcript has, in reading order.
        for side in ("utr5", "utr3"):
            records.extend(_extract_feature_records(
                fasta, chrom, strand, exons, cds_list, utrs,
                side, tx_id, gene_id, header_fields, biotype, canonical_info,
                tx_genomic_span=tx_genomic_span, genome=genome,
            ))

    elif feature_type in ("utr5", "utr3"):
        # Prefer explicit UTR annotations; fall back to computed intervals.
        if feature_type == "utr5":
            explicit = [u for u in utrs if _is_five_prime_utr(u)]
        else:
            explicit = [u for u in utrs if _is_three_prime_utr(u)]

        intervals = _ordered_five_to_three(explicit, strand) if explicit else \
                    _ordered_five_to_three(_compute_utr_intervals(exons, cds_list, strand, feature_type), strand)
        if not intervals:
            return []
        seq = "".join(_fetch_oriented_piece(fasta, chrom, u["start"], u["end"], strand) for u in intervals)
        if not seq:
            return []
        g_start = min(int(u["start"]) for u in intervals)
        g_end   = max(int(u["end"])   for u in intervals)
        label   = "5primeutr" if feature_type == "utr5" else "3primeutr"
        hdr = _build_fasta_header(tx_id, gene_id, label, chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "introns":
        if len(exons) < 2:
            return []
        raw_introns = _compute_introns_from_exons(exons)
        ordered = _ordered_five_to_three(raw_introns, strand)
        for i, intron in enumerate(ordered, 1):
            seq = _fetch_oriented_piece(fasta, chrom, intron["start"], intron["end"], strand)
            if not seq:
                continue
            hdr = _build_fasta_header(tx_id, gene_id, "intron", chrom, int(intron["start"]), int(intron["end"]), strand, len(seq), header_fields, biotype, canonical_info, rank=i if include_num else None)
            records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "protein":
        if not cds_list:
            return []
        # Same translator the Feature Explorer's protein track uses, so an
        # organelle gene is not read with the nuclear code here and the
        # mitochondrial one there.
        table, molecule, _resolved = _resolve_translation_table(genome or "reference", chrom)
        seq, _layout, _table = _translate_transcript(
            fasta, chrom, strand, cds_list, table=table, molecule=molecule,
        )
        if not seq:
            return []
        g_start = min(int(c["start"]) for c in cds_list)
        g_end   = max(int(c["end"])   for c in cds_list)
        hdr = _build_fasta_header(tx_id, gene_id, "protein", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info, length_unit="aa")
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    return records


#: Every feature type the record extractor can produce, in the order a reader
#: would want them offered.
_ALL_FEATURE_TYPES: List[str] = [
    "genomic", "transcript", "cds", "protein", "utr", "exons", "introns",
]

#: The record extractor yields a record per feature for these; everything else
#: is a single concatenated record.
_RANKED_FEATURE_TYPES = frozenset({"exons", "introns"})


def _available_feature_types(
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
    strand: str,
    has_span: bool,
) -> Dict[str, bool]:
    """Which feature types this transcript can offer, from annotation alone.

    Deliberately free of sequence reads: the caller needs this to grey out the
    options it cannot show, and waiting on the FASTA for that would be absurd.
    """
    def _utr_available(kind: str) -> bool:
        predicate = _is_five_prime_utr if kind == "utr5" else _is_three_prime_utr
        if any(predicate(u) for u in utrs):
            return True
        # No explicit annotation: the same fallback the extractor itself uses.
        return bool(_compute_utr_intervals(exons, cds_list, strand, kind))

    five_prime = _utr_available("utr5")
    three_prime = _utr_available("utr3")

    return {
        "genomic":    bool(has_span or exons),
        "transcript": bool(exons),
        "cds":        bool(cds_list),
        "protein":    bool(cds_list),
        "utr5":       five_prime,
        "utr3":       three_prime,
        # The viewer offers one combined UTR entry; either end is enough.
        "utr":        five_prime or three_prime,
        "exons":      bool(exons),
        "introns":    len(exons) >= 2,
    }


def _canonical_info_for_header(tx_data: Dict[str, Any]) -> str:
    """The "[canonical, MANE-select]" note a FASTA header carries.

    MANE status arrives as a GFF tag far more often than as a `mane_status`
    field, so read both — keying off the field alone dropped the note from every
    MANE transcript.
    """
    parts: List[str] = []
    if tx_data.get("is_canonical"):
        parts.append("canonical")

    raw_tags = tx_data.get("tags", [])
    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t) for t in raw_tags]
    else:
        tags = []
    mane_text = " ".join([str(tx_data.get("mane_status", "") or ""), *tags]).lower()
    if "mane" in mane_text and "select" in mane_text:
        parts.append("MANE-select")
    return ", ".join(parts)


def _split_fasta_record(record: str) -> Tuple[str, str]:
    """Split one ``header\\nwrapped sequence`` record into its two halves."""
    header, _, body = record.partition("\n")
    return header, body


@app.post("/api/feature_explorer/transcript_sequences", response_model=TranscriptSequencesResponse)
async def transcript_sequences(payload: TranscriptSequencesRequest):
    """Feature sequences for one transcript, returned rather than written to disk.

    Shares `_extract_feature_records` with /api/feature_explorer/export, so what
    a viewer shows and what an export writes are the same bytes.
    """
    genome = str(payload.genome or "reference").strip() or "reference"
    gene_id = str(payload.gene_id or "").strip()
    tx_id = str(payload.transcript_id or "").strip()
    if not tx_id:
        raise HTTPException(status_code=400, detail="transcript_id must not be empty")

    requested = [str(f).strip() for f in (payload.feature_types or _ALL_FEATURE_TYPES)]
    requested = [f for f in requested if f in set(_ALL_FEATURE_TYPES)]
    if not requested:
        raise HTTPException(status_code=400, detail="feature_types must name at least one known type")

    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _run():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(
            "SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id = ?",
            (tx_id,),
        )
        row = c.fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail=f"Transcript {tx_id} not found in this genome's index")

        chrom = str(row["chrom"] or "")
        strand = str(row["strand"] or "+")
        tx_start = int(row["start"] or 0)
        tx_end = int(row["end"] or 0)
        try:
            tx_data = json.loads(row["data"]) if row["data"] else {}
        except Exception:
            tx_data = {}

        exons    = _normalize_interval_list(tx_data.get("exons",    []), "exon", strand)
        cds_list = _normalize_interval_list(tx_data.get("cds_list", []), "cds",  strand)
        utrs     = _normalize_interval_list(tx_data.get("utrs",     []), "utr",  strand)
        biotype  = str(tx_data.get("biotype", "") or "")

        canonical_info = _canonical_info_for_header(tx_data)

        available = _available_feature_types(
            exons, cds_list, utrs, strand, bool(tx_start and tx_end)
        )

        # Every field on: this is a viewer, and the header is the only place the
        # coordinates and rank are carried.
        header_fields = {
            "exon_number": True, "location": True, "strand": True,
            "length": True, "biotype": True, "canonical_status": True,
        }
        tx_span = (tx_start, tx_end) if tx_start and tx_end else None
        fasta = genome_context._get_browse_fasta(genome)

        records: List[TranscriptSequenceRecord] = []
        errors: List[str] = []
        for feature_type in requested:
            if not available.get(feature_type):
                continue
            try:
                raw = _extract_feature_records(
                    fasta, chrom, strand, exons, cds_list, utrs,
                    feature_type, tx_id, gene_id, header_fields, biotype, canonical_info,
                    tx_genomic_span=tx_span,
                    genome=genome,
                )
                # Amino acids have no complement; reversing one would be noise
                # dressed up as a sequence.
                if payload.reverse_complement and feature_type != "protein":
                    raw = _apply_orientations(raw, ["rev"])
            except Exception as exc:
                errors.append(f"{feature_type}: {exc}")
                continue

            ranked = feature_type in _RANKED_FEATURE_TYPES
            for index, record in enumerate(raw, 1):
                header, body = _split_fasta_record(record)
                records.append(TranscriptSequenceRecord(
                    feature_type=feature_type,
                    header=header,
                    sequence=body,
                    length=len(body.replace("\n", "")),
                    unit="aa" if feature_type == "protein" else "bp",
                    rank=index if ranked else None,
                ))

        return TranscriptSequencesResponse(
            transcript_id=tx_id,
            available=available,
            records=records,
            errors=errors,
        )

    return await run_in_threadpool(_run)


# ─────────────────────────────────────────────────────────────────────────────
# /api/feature_explorer/export
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/feature_explorer/export", response_model=ExportSequencesResponse)
async def export_sequences(payload: ExportSequencesRequest):
    """Export transcript feature sequences to FASTA files."""
    genome           = str(payload.genome or "reference").strip() or "reference"
    gene_id          = str(payload.gene_id or "").strip()
    output_structure = str(payload.output_structure or "per_transcript").strip()
    compress         = bool(payload.compress)
    header_fields    = dict(payload.header_fields or {
        "exon_number": True, "location": True, "strand": True,
        "length": True, "biotype": False, "canonical_status": False,
    })

    valid_structures = {"single", "per_transcript", "per_feature"}
    if output_structure not in valid_structures:
        raise HTTPException(status_code=400, detail=f"output_structure must be one of: {', '.join(valid_structures)}")

    transcript_ids = [str(t).strip() for t in (payload.transcript_ids or []) if str(t).strip()]
    feature_types  = [str(f).strip() for f in (payload.feature_types or [])  if str(f).strip()]
    valid_features = {"genomic", "transcript", "cds", "exons", "utr", "utr5", "utr3", "introns", "protein"}
    feature_types  = [f for f in feature_types if f in valid_features]
    orientations   = [str(o).strip() for o in (payload.orientations or ["fwd"]) if str(o).strip() in ("fwd", "rev")]
    if not orientations:
        orientations = ["fwd"]

    if not transcript_ids:
        raise HTTPException(status_code=400, detail="transcript_ids must not be empty")
    if not feature_types:
        raise HTTPException(status_code=400, detail="feature_types must not be empty")
    if not payload.output_dir:
        raise HTTPException(status_code=400, detail="output_dir must not be empty")

    output_dir = Path(str(payload.output_dir)).expanduser().resolve()

    def _run():
        db_path = genome_context._get_browse_db(genome)
        fasta   = genome_context._get_browse_fasta(genome)

        # ── Fetch transcript records from DB ──────────────────────────────────
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        placeholders = ",".join("?" for _ in transcript_ids)
        c.execute(
            f"SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id IN ({placeholders})",
            transcript_ids,
        )
        tx_rows = {
            str(row["id"]): row for row in c.fetchall()
        }
        conn.close()

        # ── Create output directory ───────────────────────────────────────────
        output_dir.mkdir(parents=True, exist_ok=True)

        files_written: List[str] = []
        errors: List[str] = []

        # ── Build per-transcript FASTA records ────────────────────────────────
        # records_by_tx: { tx_id: { feature_type: [fasta_record_str, ...] } }
        records_by_tx: Dict[str, Dict[str, List[str]]] = {}

        # Preserve requested order
        for tx_id in transcript_ids:
            row = tx_rows.get(tx_id)
            if not row:
                errors.append(f"{tx_id}: not found in index — skipped")
                continue

            chrom    = str(row["chrom"] or "")
            strand   = str(row["strand"] or "+")
            tx_start = int(row["start"] or 0)
            tx_end   = int(row["end"]   or 0)
            try:
                tx_data = json.loads(row["data"]) if row["data"] else {}
            except Exception:
                tx_data = {}

            exons    = _normalize_interval_list(tx_data.get("exons",    []), "exon", strand)
            cds_list = _normalize_interval_list(tx_data.get("cds_list", []), "cds",  strand)
            utrs     = _normalize_interval_list(tx_data.get("utrs",     []), "utr",  strand)
            biotype  = str(tx_data.get("biotype", "") or "")

            # Canonical / MANE label for header
            canonical_info = _canonical_info_for_header(tx_data)

            tx_span = (tx_start, tx_end) if tx_start and tx_end else None

            tx_records: Dict[str, List[str]] = {}
            for ft in feature_types:
                try:
                    recs = _extract_feature_records(
                        fasta, chrom, strand, exons, cds_list, utrs,
                        ft, tx_id, gene_id, header_fields, biotype, canonical_info,
                        tx_genomic_span=tx_span,
                        genome=genome,
                    )
                    recs = _apply_orientations(recs, orientations)
                    if recs:
                        tx_records[ft] = recs
                except Exception as e:
                    errors.append(f"{tx_id}/{ft}: {e}")

            if tx_records:
                records_by_tx[tx_id] = tx_records

        if not records_by_tx and not errors:
            errors.append("No sequence records could be extracted for the selected transcripts and features.")

        # ── Write files according to output_structure ─────────────────────────
        ext = ".fa.gz" if compress else ".fa"

        def _open_output(path: Path):
            if compress:
                return gzip.open(path, "wt", encoding="utf-8")
            return open(path, "w", encoding="utf-8")

        def _slug_for_keys(keys: List[str]) -> str:
            if len(keys) == 1:
                return _FEATURE_SLUGS.get(keys[0], keys[0])
            return "mixed_features"

        if output_structure == "single":
            # All records → one file
            filename = str(payload.filename or "").strip()
            if not filename:
                slug = _slug_for_keys(feature_types)
                ts   = datetime.now().strftime("%Y%m%d")
                filename = f"{gene_id or 'export'}_{slug}_{ts}.fa"
                if compress:
                    filename += ".gz"
            out_path = output_dir / filename
            with _open_output(out_path) as fh:
                for tx_id in transcript_ids:
                    tx_recs = records_by_tx.get(tx_id, {})
                    for ft in feature_types:
                        for rec in tx_recs.get(ft, []):
                            fh.write(rec + "\n")
            if out_path.exists() and out_path.stat().st_size > 0:
                files_written.append(str(out_path))
            else:
                errors.append(f"Output file is empty: {out_path}")

        elif output_structure == "per_transcript":
            for tx_id in transcript_ids:
                tx_recs = records_by_tx.get(tx_id)
                if not tx_recs:
                    continue
                present_types = [ft for ft in feature_types if ft in tx_recs]
                slug = _slug_for_keys(present_types)
                out_path = output_dir / f"{tx_id}_{slug}{ext}"
                with _open_output(out_path) as fh:
                    for ft in feature_types:
                        for rec in tx_recs.get(ft, []):
                            fh.write(rec + "\n")
                files_written.append(str(out_path))

        elif output_structure == "per_feature":
            for tx_id in transcript_ids:
                tx_recs = records_by_tx.get(tx_id)
                if not tx_recs:
                    continue
                for ft in feature_types:
                    recs = tx_recs.get(ft)
                    if not recs:
                        continue
                    slug = _FEATURE_SLUGS.get(ft, ft)
                    out_path = output_dir / f"{tx_id}_{slug}{ext}"
                    with _open_output(out_path) as fh:
                        for rec in recs:
                            fh.write(rec + "\n")
                    files_written.append(str(out_path))

        return ExportSequencesResponse(files=files_written, errors=errors)

    return await run_in_threadpool(_run)


@app.post("/api/exports/save", response_model=SaveExportResponse)
async def save_export_file(payload: SaveExportRequest):
    directory_raw = str(payload.directory or "").strip()
    filename = str(payload.filename or "").strip()
    file_format = str(payload.format or "").strip().lower() or "svg"
    encoding = str(payload.encoding or "utf8").strip().lower() or "utf8"
    data = payload.data if isinstance(payload.data, str) else ""

    if not filename:
        raise HTTPException(status_code=400, detail="filename must not be empty")
    if not directory_raw:
        raise HTTPException(status_code=400, detail="directory must not be empty")
    if encoding not in {"utf8", "base64"}:
        raise HTTPException(status_code=400, detail="encoding must be one of: utf8, base64")
    if len(data) > 128 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="export payload is too large")

    directory = Path(directory_raw).expanduser().resolve()
    safe_filename = safe_export_filename(filename, file_format)

    out_path = directory / safe_filename

    def _run():
        directory.mkdir(parents=True, exist_ok=True)
        try:
            if encoding == "base64":
                binary = base64.b64decode(data.encode("utf-8"), validate=True)
                with open(out_path, "wb") as handle:
                    handle.write(binary)
            else:
                with open(out_path, "w", encoding="utf-8") as handle:
                    handle.write(data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 payload: {exc}") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to write export file: {exc}") from exc

        return SaveExportResponse(ok=True, path=str(out_path), filename=safe_filename)

    return await run_in_threadpool(_run)


# ── VCF endpoint ─────────────────────────────────────────────────────────────

_VCF_EFFECT_GROUPS = (
    "protein_altering",
    "splicing",
    "transcript",
    "regulatory",
    "intergenic",
    "other",
)

_VCF_PROTEIN_TERMS = {
    "missense_variant", "stop_gained", "stop_lost", "start_lost",
    "frameshift_variant", "inframe_insertion", "inframe_deletion",
    "protein_altering_variant", "coding_sequence_variant",
}
_VCF_SPLICING_TERMS = {
    "splice_acceptor_variant", "splice_donor_variant", "splice_region_variant",
    "splice_donor_5th_base_variant", "splice_polypyrimidine_tract_variant",
}
_VCF_REGULATORY_TERMS = {
    "regulatory_region_variant", "tf_binding_site_variant",
    "regulatory_region_amplification", "regulatory_region_ablation",
}
_VCF_INTERGENIC_TERMS = {
    "intergenic_variant", "upstream_gene_variant", "downstream_gene_variant",
}
_VCF_TRANSCRIPT_TERMS = {
    "transcript_variant", "synonymous_variant", "intron_variant",
    "non_coding_transcript_variant", "5_prime_utr_variant", "3_prime_utr_variant",
    "nmd_transcript_variant", "mature_mirna_variant", "coding_transcript_variant",
}

_VCF_HANDLE_CACHE: Dict[str, Dict[str, Any]] = {}
_VCF_HANDLE_CACHE_GUARD = threading.Lock()
_VCF_HANDLE_LOCKS: Dict[str, threading.Lock] = {}
_VCF_HANDLE_LOCKS_GUARD = threading.Lock()
_VCF_TILE_DISK_CACHE_DIR = app_paths.CACHE_DIR / "vcf_tiles"
_VCF_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
_VCF_TILE_CACHE_SCHEMA = "v6"


class VcfCoverageSpan(BaseModel):
    start: int
    end: int
    class_name: str  # intergenic | transcript
    coverage_fraction: float


class VcfTileRequest(BaseModel):
    start: int
    end: int
    lod: str = "L2"
    mode: str = "summary"  # summary | detail
    bins: int = 512
    max_variants: int = 3000
    block_window_bp: Optional[int] = None
    block_stride_bp: Optional[int] = None
    block_coverage_threshold: Optional[float] = 0.5
    block_mode: Optional[str] = "coverage_spans"


class VcfTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[VcfTileRequest]
    include_effects: bool = True
    genome: Optional[str] = None


# ── New block-tile endpoint models ──────────────────────────────────────────

VCF_BLOCK_DENSITY_BIN_BP = 100
_VCF_BLOCK_TILE_CACHE_SCHEMA = "v5"
_VCF_BLOCK_TILE_DISK_CACHE_DIR = app_paths.CACHE_DIR / "vcf_block_tiles"
_VCF_BLOCK_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


class VcfBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str        # e.g. "L0" .. "L3" – used only in cache key
    block_bp: int        # size of each block stride (genomic bp)
    window_bp: int       # smoothing window around each stride centre


class VcfBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    genome: Optional[str] = None
    coverage_threshold: float = 0.25
    tiles: List[VcfBlockTileRequest]


class SpliceBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "L0"
    block_bp: int = 5000


class SpliceBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[SpliceBlockTileRequest]
    genome: str = "reference"
    track_id: Optional[str] = None
    min_reads: int = 1
    min_support: Optional[int] = None
    canonical_mode: Optional[str] = None
    annotated_mode: Optional[str] = None
    max_junctions: Optional[int] = None


class BigBedBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "L0"
    block_bp: int = 5000


class BigBedBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[BigBedBlockTileRequest]
    genome: str = "reference"
    # Per-block feature counts, for drawing a density histogram rather than spans.
    include_counts: bool = False
    # "transcripts": read a GFF/GTF as gene models rather than one interval per line.
    feature_model: str = ""


class BigBedFeatureTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "detail"
    max_features: int = 3000


class BigBedFeatureTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[BigBedFeatureTileRequest]
    genome: str = "reference"
    max_features_per_tile: int = 3000
    feature_model: str = ""


def _vcf_file_fingerprint(path: Path) -> Tuple[int, int]:
    st = path.stat()
    return int(st.st_mtime_ns), int(st.st_size)


def _vcf_has_tabix_index(path: Path) -> bool:
    return Path(str(path) + ".tbi").exists() or Path(str(path) + ".csi").exists()


def _get_vcf_lock(path: str) -> threading.Lock:
    with _VCF_HANDLE_LOCKS_GUARD:
        lock = _VCF_HANDLE_LOCKS.get(path)
        if lock is None:
            lock = threading.Lock()
            _VCF_HANDLE_LOCKS[path] = lock
        return lock


def _open_vcf_handle_unlocked(path: str):
    """Open or reuse the cached ``pysam.VariantFile`` for ``path``.

    Callers must hold the handle's lock — use :func:`locked_vcf` rather than
    calling this directly. htslib keeps seek state on the handle, and
    ``VariantFile.fetch()`` returns a lazy iterator, so the lock has to cover the
    whole scan and not merely the call that starts it.
    """
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")
    if str(p).lower().endswith(".gz") and not _vcf_has_tabix_index(p):
        raise HTTPException(
            status_code=400,
            detail=f"VCF index not found for {path}. Expected a matching .tbi or .csi file.",
        )
    fp = _vcf_file_fingerprint(p)
    key = str(p.resolve())
    with _VCF_HANDLE_CACHE_GUARD:
        cached = _VCF_HANDLE_CACHE.get(key)
        if cached and cached.get("fingerprint") == fp:
            return cached["handle"], fp, key

        if cached:
            try:
                cached["handle"].close()
            except Exception:
                pass

        try:
            handle = pysam.VariantFile(key)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not open VCF: {e}")

        _VCF_HANDLE_CACHE[key] = {"fingerprint": fp, "handle": handle}
        return handle, fp, key


@contextmanager
def locked_vcf(path: str):
    """Yield ``(handle, fingerprint, resolved_path)`` with exclusive access.

    The only supported way to reach a cached VCF handle. Holding the lock for the
    whole block matters more here than it does for FASTA: ``FastaFile.fetch()``
    does all its I/O before returning a string, whereas ``VariantFile.fetch()``
    hands back a lazy iterator that reads as it is consumed. Locking just the
    call that creates the iterator would leave the actual scan unguarded.

    The lock is per resolved path, so unrelated VCFs never block each other.
    """
    resolved = str(Path(path).resolve())
    lock = _get_vcf_lock(resolved)
    with lock:
        yield _open_vcf_handle_unlocked(path)


def _resolve_vcf_chrom(vcf_handle, chrom: str) -> Optional[str]:
    name = str(chrom or "").strip()
    if not name:
        return None
    contigs = set(vcf_handle.header.contigs.keys())
    if name in contigs:
        return name
    if name.startswith("chr") and name[3:] in contigs:
        return name[3:]
    prefixed = f"chr{name}"
    if prefixed in contigs:
        return prefixed
    return None


def _classify_vcf_type(ref: str, alts: List[str]) -> str:
    if len(ref) == 1 and all(len(a) == 1 for a in alts):
        return "snv"
    if any(len(a) > len(ref) for a in alts):
        return "ins"
    if any(len(a) < len(ref) for a in alts):
        return "del"
    return "other"


def _extract_consequence_terms(info: Any) -> List[str]:
    if not info:
        return []
    try:
        csq = info.get("CSQ")
    except Exception:
        csq = None
    try:
        ann = info.get("ANN")
    except Exception:
        ann = None
    source = csq if csq is not None else ann
    if source is None:
        return []
    entries = list(source) if isinstance(source, (tuple, list)) else [source]
    terms: List[str] = []
    for entry in entries:
        if entry is None:
            continue
        text = str(entry)
        chunks = text.split(",")
        for chunk in chunks:
            fields = chunk.split("|")
            if csq is not None:
                consequence = fields[1] if len(fields) > 1 else fields[0]
            else:
                consequence = fields[1] if len(fields) > 1 else fields[0]
            for term in consequence.replace("&", ",").split(","):
                t = term.strip().lower()
                if t:
                    terms.append(t)
    return terms


def _effect_group_from_terms(terms: List[str]) -> str:
    if not terms:
        return "other"
    term_set = set(terms)
    if term_set & _VCF_PROTEIN_TERMS:
        return "protein_altering"
    if term_set & _VCF_SPLICING_TERMS:
        return "splicing"
    if term_set & _VCF_REGULATORY_TERMS:
        return "regulatory"
    if term_set & _VCF_INTERGENIC_TERMS:
        return "intergenic"
    if term_set & _VCF_TRANSCRIPT_TERMS:
        return "transcript"
    # Lightweight fallback buckets by lexical hints
    if any("splice" in t for t in term_set):
        return "splicing"
    if any("intergenic" in t or "upstream" in t or "downstream" in t for t in term_set):
        return "intergenic"
    if any("regulatory" in t or "tf_binding" in t for t in term_set):
        return "regulatory"
    if any("protein" in t or "coding" in t for t in term_set):
        return "protein_altering"
    if any("transcript" in t or "intron" in t or "utr" in t for t in term_set):
        return "transcript"
    return "other"


def _vcf_effect_group(rec, include_effects: bool) -> str:
    if not include_effects:
        return "other"
    try:
        terms = _extract_consequence_terms(rec.info)
    except Exception:
        return "other"
    return _effect_group_from_terms(terms)


def _vcf_type_counts_dict() -> Dict[str, int]:
    return {"snv": 0, "ins": 0, "del": 0, "other": 0}


def _load_vcf_gene_intervals(genome: Optional[str], chrom: str, start: int, end: int) -> List[Tuple[int, int]]:
    g = str(genome or "").strip()
    if not g:
        return []
    try:
        db_path = genome_context._get_browse_db(g)
    except Exception:
        return []
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute(
        """
        SELECT start, end
        FROM genes
        WHERE chrom = ? AND end >= ? AND start <= ?
        ORDER BY start ASC
        """,
        (chrom, start, end),
    )
    rows = c.fetchall()
    conn.close()
    out: List[Tuple[int, int]] = []
    for r in rows:
        try:
            s = int(r[0])
            e = int(r[1])
        except Exception:
            continue
        if e >= s:
            out.append((s, e))
    return out


def _make_gene_overlap_checker(gene_intervals: List[Tuple[int, int]]):
    intervals = sorted(gene_intervals, key=lambda x: x[0])
    state = {"idx": 0, "last_start": -1}

    def overlaps(q_start: int, q_end: int) -> bool:
        if not intervals:
            return False
        q_start_i = int(q_start)
        q_end_i = int(q_end)
        if q_end_i < q_start_i:
            q_start_i, q_end_i = q_end_i, q_start_i

        idx = int(state["idx"])
        if q_start_i < int(state["last_start"]):
            idx = 0
        n = len(intervals)
        while idx < n and intervals[idx][1] < q_start_i:
            idx += 1
        state["idx"] = idx
        state["last_start"] = q_start_i
        j = idx
        while j < n and intervals[j][0] <= q_end_i:
            if intervals[j][1] >= q_start_i:
                return True
            j += 1
        return False

    return overlaps


def _classify_variant_context(rec, include_effects: bool, gene_overlap_fn=None) -> str:
    terms: List[str] = []
    if include_effects:
        try:
            terms = _extract_consequence_terms(rec.info)
        except Exception:
            terms = []
    if terms:
        term_set = set(terms)
        if term_set & _VCF_INTERGENIC_TERMS:
            return "intergenic"
        if term_set & (_VCF_TRANSCRIPT_TERMS | _VCF_PROTEIN_TERMS | _VCF_SPLICING_TERMS | _VCF_REGULATORY_TERMS):
            return "transcript"
        if any("intergenic" in t or "upstream" in t or "downstream" in t for t in term_set):
            return "intergenic"
        if any("transcript" in t or "intron" in t or "utr" in t or "coding" in t or "splice" in t for t in term_set):
            return "transcript"

    if gene_overlap_fn is not None:
        pos = int(rec.pos)
        ref_len = max(1, len(str(rec.ref or "")))
        rec_end = int(getattr(rec, "stop", pos + ref_len - 1))
        if gene_overlap_fn(pos, max(pos, rec_end)):
            return "transcript"
    return "intergenic"


def _build_vcf_block_spans(
    tile_start: int,
    tile_end: int,
    block_window_bp: int,
    block_stride_bp: int,
    block_coverage_threshold: float,
    variant_intervals: List[Tuple[int, int, str]],
) -> List[Dict[str, Any]]:
    span = max(1, int(tile_end) - int(tile_start))
    stride_bp = max(1, int(block_stride_bp))
    window_bp = max(1, int(block_window_bp))
    threshold = max(0.0, min(1.0, float(block_coverage_threshold)))
    slot_count = max(1, math.ceil(span / stride_bp))

    any_cov = [0.0] * slot_count
    tx_cov = [0.0] * slot_count
    inter_cov = [0.0] * slot_count

    def slot_bounds(i: int) -> Tuple[int, int]:
        s = tile_start + i * stride_bp
        e = min(tile_end, s + stride_bp)
        return s, e

    for v_start, v_end, cls in variant_intervals:
        s = max(tile_start, int(v_start))
        e = min(tile_end, int(v_end))
        if e <= s:
            continue
        i1 = max(0, min(slot_count - 1, int((s - tile_start) // stride_bp)))
        i2 = max(0, min(slot_count - 1, int((max(s, e - 1) - tile_start) // stride_bp)))
        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            ov = max(0.0, min(float(e), float(se)) - max(float(s), float(ss)))
            if ov <= 0:
                continue
            slot_len = max(1.0, float(se - ss))
            any_cov[i] = min(slot_len, any_cov[i] + ov)
            if cls == "transcript":
                tx_cov[i] = min(slot_len, tx_cov[i] + ov)
            else:
                inter_cov[i] = min(slot_len, inter_cov[i] + ov)

    effective_window = min(window_bp, span)
    starts: List[int] = []
    if span <= effective_window:
        starts = [tile_start]
    else:
        s = tile_start
        last = tile_end - effective_window
        while s <= last:
            starts.append(s)
            s += stride_bp
        if not starts or starts[-1] != last:
            starts.append(last)

    painted_class: List[Optional[str]] = [None] * slot_count
    painted_cov: List[float] = [0.0] * slot_count

    for ws in starts:
        we = min(tile_end, ws + effective_window)
        i1 = max(0, min(slot_count - 1, int((ws - tile_start) // stride_bp)))
        i2 = max(0, min(slot_count - 1, int((max(ws, we - 1) - tile_start) // stride_bp)))
        any_bp = 0.0
        tx_bp = 0.0
        inter_bp = 0.0
        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            slot_ov = max(0.0, min(float(we), float(se)) - max(float(ws), float(ss)))
            if slot_ov <= 0:
                continue
            slot_len = max(1.0, float(se - ss))
            frac = slot_ov / slot_len
            any_bp += any_cov[i] * frac
            tx_bp += tx_cov[i] * frac
            inter_bp += inter_cov[i] * frac
        window_len = max(1.0, float(we - ws))
        cov_frac = max(0.0, min(1.0, any_bp / window_len))
        state = None
        if cov_frac >= threshold:
            state = "transcript" if tx_bp >= inter_bp else "intergenic"

        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            if se <= ws or ss >= we:
                continue
            painted_class[i] = state
            painted_cov[i] = cov_frac

    spans_out: List[Dict[str, Any]] = []
    run_class: Optional[str] = None
    run_start = 0
    run_cov_sum = 0.0
    run_n = 0
    for i, cls in enumerate(painted_class):
        if cls is None:
            if run_class is not None:
                s0, _ = slot_bounds(run_start)
                _, e0 = slot_bounds(i - 1)
                spans_out.append({
                    "start": int(s0),
                    "end": int(e0),
                    "class_name": run_class,
                    "coverage_fraction": float(run_cov_sum / max(1, run_n)),
                })
                run_class = None
            continue
        if run_class is None:
            run_class = cls
            run_start = i
            run_cov_sum = painted_cov[i]
            run_n = 1
        elif cls == run_class:
            run_cov_sum += painted_cov[i]
            run_n += 1
        else:
            s0, _ = slot_bounds(run_start)
            _, e0 = slot_bounds(i - 1)
            spans_out.append({
                "start": int(s0),
                "end": int(e0),
                "class_name": run_class,
                "coverage_fraction": float(run_cov_sum / max(1, run_n)),
            })
            run_class = cls
            run_start = i
            run_cov_sum = painted_cov[i]
            run_n = 1
    if run_class is not None:
        s0, _ = slot_bounds(run_start)
        _, e0 = slot_bounds(slot_count - 1)
        spans_out.append({
            "start": int(s0),
            "end": int(e0),
            "class_name": run_class,
            "coverage_fraction": float(run_cov_sum / max(1, run_n)),
        })
    return spans_out


def _build_vcf_summary_tile(
    vcf_handle,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    max_variants: int,
    include_effects: bool,
    block_window_bp: int,
    block_stride_bp: int,
    block_coverage_threshold: float,
    block_mode: str,
    gene_intervals: Optional[List[Tuple[int, int]]] = None,
) -> Dict[str, Any]:
    span = max(1, end - start)
    block_mode_norm = str(block_mode or "coverage_spans").strip().lower()
    counts = [0] * bins
    occupancy = [0] * bins
    type_counts_bins = [_vcf_type_counts_dict() for _ in range(bins)]
    effect_counts_bins = [{g: 0 for g in _VCF_EFFECT_GROUPS} for _ in range(bins)]
    effect_obs_bins = [0] * bins
    truncated = False
    seen = 0

    variant_intervals: List[Tuple[int, int, str]] = []
    overlap_checker = _make_gene_overlap_checker(gene_intervals or []) if gene_intervals else None

    def process_record(rec):
        nonlocal seen
        seen += 1

        pos = int(rec.pos)
        idx = int((pos - start) / span * bins)
        idx = max(0, min(bins - 1, idx))
        counts[idx] += 1
        occupancy[idx] = 1

        ref = str(rec.ref or "")
        alts = [str(a) for a in (rec.alts or [])]
        vtype = _classify_vcf_type(ref, alts)
        type_counts_bins[idx][vtype] = int(type_counts_bins[idx].get(vtype, 0)) + 1

        if include_effects:
            # Bound effect parsing work per bin for dense tiles while preserving
            # dominant consequence trends.
            if effect_obs_bins[idx] < 256:
                group = _vcf_effect_group(rec, include_effects)
                effect_counts_bins[idx][group] = int(effect_counts_bins[idx].get(group, 0)) + 1
                effect_obs_bins[idx] += 1

        pos = int(rec.pos)
        ref_len = max(1, len(str(rec.ref or "")))
        rec_end = int(getattr(rec, "stop", pos + ref_len - 1))
        s = max(start, pos)
        e_excl = min(end, max(pos, rec_end) + 1)
        if e_excl > s:
            cls = _classify_variant_context(rec, include_effects, overlap_checker)
            variant_intervals.append((s, e_excl, cls))

    # Bounded, window-distributed sampling avoids expensive full scans on dense
    # files while preventing the old left-biased "first N records only" artefact.
    # Keep this for all block modes so VCF work doesn't starve core gene/transcript
    # browsing responsiveness.
    if max_variants > 0:
        window_count = max(16, min(400, bins))
        window_span = max(1, math.ceil(span / window_count))
        per_window_budget = max(32, math.ceil(max_variants / window_count))
        for wi in range(window_count):
            w_start = start + wi * window_span
            if w_start >= end:
                break
            w_end = min(end, w_start + window_span)
            fetch_start = max(0, (w_start - 1) if wi == 0 else w_start)
            idx_lo = max(0, min(bins - 1, int(((w_start - start) / span) * bins)))
            idx_hi = max(0, min(bins - 1, int((((w_end - 1) - start) / span) * bins)))
            if idx_hi < idx_lo:
                idx_lo, idx_hi = idx_hi, idx_lo
            bin_total = max(1, idx_hi - idx_lo + 1)
            per_bin_budget = max(8, math.ceil(per_window_budget / bin_total))
            window_counts: Dict[int, int] = {}
            saturated: Set[int] = set()
            for rec in vcf_handle.fetch(chrom, fetch_start, w_end):
                pos = int(rec.pos)
                idx = int((pos - start) / span * bins)
                idx = max(0, min(bins - 1, idx))
                existing = int(window_counts.get(idx, 0))
                if existing >= per_bin_budget:
                    continue
                process_record(rec)
                next_count = existing + 1
                window_counts[idx] = next_count
                if next_count >= per_bin_budget:
                    saturated.add(idx)
                    if len(saturated) >= bin_total:
                        truncated = True
                        break
    else:
        for rec in vcf_handle.fetch(chrom, max(0, start - 1), end):
            process_record(rec)

    dominant_effect_bins: List[str] = []
    for i in range(bins):
        bucket = effect_counts_bins[i]
        if sum(bucket.values()) <= 0:
            dominant_effect_bins.append("other")
            continue
        best_group = max(_VCF_EFFECT_GROUPS, key=lambda g: bucket.get(g, 0))
        dominant_effect_bins.append(best_group)

    block_window = max(1, int(block_window_bp or 10000))
    block_stride = max(1, int(block_stride_bp or max(1, block_window // 10)))
    block_threshold = max(0.0, min(1.0, float(block_coverage_threshold)))
    block_spans = _build_vcf_block_spans(
        start,
        end,
        block_window,
        block_stride,
        block_threshold,
        variant_intervals,
    ) if block_mode_norm == "coverage_spans" else []

    return {
        "has_data": bool(seen > 0),
        "bins": counts,
        "max_count": max(counts) if counts else 0,
        "occupancy": occupancy,
        "dominant_effect_bins": dominant_effect_bins,
        "type_counts_bins": type_counts_bins,
        "truncated": truncated,
        "block_window_bp": int(block_window),
        "block_stride_bp": int(block_stride),
        "block_coverage_threshold": float(block_threshold),
        "block_spans": block_spans,
    }


def _build_vcf_detail_tile(vcf_handle, chrom: str, start: int, end: int, max_variants: int, include_effects: bool) -> Dict[str, Any]:
    variants: List[Dict[str, Any]] = []
    truncated = False

    for rec in vcf_handle.fetch(chrom, max(0, start - 1), end):
        if len(variants) >= max_variants:
            truncated = True
            break
        ref = str(rec.ref or "")
        alts = [str(a) for a in (rec.alts or [])]
        vtype = _classify_vcf_type(ref, alts)
        effect_group = _vcf_effect_group(rec, include_effects)
        label = "SNV" if vtype == "snv" else ("INS" if vtype == "ins" else ("DEL" if vtype == "del" else "VAR"))
        rec_end = int(getattr(rec, "stop", rec.pos + max(1, len(ref)) - 1))
        variants.append({
            "pos": int(rec.pos),
            "end": max(int(rec.pos), rec_end),
            "ref": ref[:40],
            "alt": ",".join(alts)[:80],
            "type": vtype,
            "id": str(rec.id or "."),
            "effect_group": effect_group,
            "label": label,
        })

    return {
        "has_data": bool(variants),
        "variants": variants,
        "truncated": truncated,
    }


def _vcf_disk_cache_key(
    vcf_path: str,
    fingerprint: Tuple[int, int],
    chrom: str,
    tile: VcfTileRequest,
    include_effects: bool,
) -> str:
    payload = "|".join([
        _VCF_TILE_CACHE_SCHEMA,
        str(vcf_path),
        str(fingerprint[0]),
        str(fingerprint[1]),
        str(chrom),
        str(tile.start),
        str(tile.end),
        str(tile.lod),
        str(tile.mode),
        str(tile.bins),
        str(tile.max_variants),
        str(tile.block_window_bp or ""),
        str(tile.block_stride_bp or ""),
        str(tile.block_coverage_threshold if tile.block_coverage_threshold is not None else ""),
        str(tile.block_mode or ""),
        "1" if include_effects else "0",
    ])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _vcf_disk_cache_path(key: str) -> Path:
    return _VCF_TILE_DISK_CACHE_DIR / f"{key}.json"


def _load_vcf_tile_disk_cache(key: str) -> Optional[Dict[str, Any]]:
    p = _vcf_disk_cache_path(key)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _save_vcf_tile_disk_cache(key: str, payload: Dict[str, Any]) -> None:
    p = _vcf_disk_cache_path(key)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except Exception:
        pass


# ── Block-tile disk cache helpers ────────────────────────────────────────────

def _vcf_block_tile_disk_cache_key(
    vcf_path: str,
    fingerprint: Tuple[int, int],
    chrom: str,
    tile: "VcfBlockTileRequest",
    coverage_threshold: float,
) -> str:
    payload = "|".join([
        _VCF_BLOCK_TILE_CACHE_SCHEMA,
        str(vcf_path),
        str(fingerprint[0]),
        str(fingerprint[1]),
        str(chrom),
        str(tile.start),
        str(tile.end),
        str(tile.level_id),
        str(tile.block_bp),
        str(tile.window_bp),
        f"{coverage_threshold:.4f}",
    ])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _vcf_block_tile_cache_path(key: str) -> Path:
    return _VCF_BLOCK_TILE_DISK_CACHE_DIR / f"{key}.json"


def _load_vcf_block_tile_cache(key: str) -> Optional[Dict[str, Any]]:
    p = _vcf_block_tile_cache_path(key)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _save_vcf_block_tile_cache(key: str, payload: Dict[str, Any]) -> None:
    p = _vcf_block_tile_cache_path(key)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except Exception:
        pass


# ── Core block-span computation (full scan + prefix-sum sliding window) ──────

def _build_vcf_block_spans_fast(
    vcf_handle,
    chrom: str,
    tile_start: int,
    tile_end: int,
    block_bp: int,
    window_bp: int,
    coverage_threshold: float,
    gene_intervals: List[Tuple[int, int]],
    level_id: str = "",
) -> Dict[str, Any]:
    """
    Full-tile scan with 100 bp density bins and prefix-sum sliding window.

    Returns:
      - block_spans: merged {start, end, class_name} spans for coarse block rendering
      - density_bins: local variant enrichment per stride (>=0, ~1 means baseline)
      - density_classes: class per stride ('genic' | 'intergenic')
      - density_stride_bp: genomic width of each density stride
    """
    BIN = VCF_BLOCK_DENSITY_BIN_BP
    tile_span = max(1, tile_end - tile_start)
    block_bp = max(BIN, int(block_bp))
    window_bp = max(block_bp, int(window_bp))
    threshold = max(0.0, min(1.0, float(coverage_threshold)))

    n_bins = (tile_span + BIN - 1) // BIN

    # ── 1. Build occupancy + count arrays per 100 bp bin ─────────────────
    # `occupied` is binary for stable block-span thresholding.
    # `variant_counts` captures local rate differences for the density profile.
    occupied: List[int] = [0] * n_bins
    variant_counts: List[int] = [0] * n_bins
    for rec in vcf_handle.fetch(chrom, max(0, tile_start - 1), tile_end):
        pos = int(rec.pos)
        if pos < tile_start or pos >= tile_end:
            continue

        b = min(n_bins - 1, (pos - tile_start) // BIN)
        occupied[b] = 1   # binary: mark bin as occupied
        variant_counts[b] += 1

    # ── 2. Occupancy/count prefix sums ────────────────────────────────────
    var_psum: List[int] = [0] * (n_bins + 1)
    count_psum: List[int] = [0] * (n_bins + 1)
    for i in range(n_bins):
        var_psum[i + 1] = var_psum[i] + occupied[i]
        count_psum[i + 1] = count_psum[i] + variant_counts[i]
    global_mean_per_bin = (count_psum[n_bins] / max(1, n_bins)) if n_bins > 0 else 0.0

    # ── 3. Gene mask (1 if any gene covers any position in this bin) ──────
    gene_bins: List[int] = [0] * n_bins
    for g_start, g_end in gene_intervals:
        lo = max(0, (g_start - tile_start) // BIN)
        hi = min(n_bins - 1, (g_end - tile_start) // BIN)
        for b in range(lo, hi + 1):
            gene_bins[b] = 1

    gene_psum: List[int] = [0] * (n_bins + 1)
    for i in range(n_bins):
        gene_psum[i + 1] = gene_psum[i] + gene_bins[i]

    def _query_psum(psum: List[int], rel_lo: int, rel_hi: int) -> int:
        """Sum psum over [rel_lo, rel_hi) genomic coords relative to tile_start."""
        b_lo = max(0, rel_lo // BIN)
        b_hi = min(n_bins, (rel_hi + BIN - 1) // BIN)
        return psum[b_hi] - psum[b_lo]

    # ── 4. Walk strides, classify, merge into spans ───────────────────────
    n_strides = max(1, (tile_span + block_bp - 1) // block_bp)
    win_half = window_bp // 2

    spans_out: List[Dict[str, Any]] = []
    density_bins: List[float] = []
    density_classes: List[str] = []
    run_cls: Optional[str] = None
    run_start = tile_start

    for si in range(n_strides):
        stride_start = tile_start + si * block_bp
        stride_end = min(tile_end, stride_start + block_bp)
        stride_center = (stride_start + stride_end) // 2

        win_lo = max(tile_start, stride_center - win_half)
        win_hi = min(tile_end, stride_center + win_half)
        # Number of 100 bp bins in this window (denominator for occupancy fraction)
        win_bins = max(1, (win_hi - win_lo + BIN - 1) // BIN)

        # Coverage fraction drives block spans (kept as binary occupancy fraction).
        occ_count = _query_psum(var_psum, win_lo - tile_start, win_hi - tile_start)
        cov_frac = occ_count / win_bins

        # Density profile uses local enrichment relative to tile-wide background.
        # Around 1.0 means baseline density, >1 hotspot, <1 depleted.
        var_count = _query_psum(count_psum, win_lo - tile_start, win_hi - tile_start)
        local_mean_per_bin = var_count / max(1, win_bins)
        if global_mean_per_bin > 0:
            enrichment = local_mean_per_bin / global_mean_per_bin
        else:
            enrichment = 0.0

        gene_count = _query_psum(gene_psum, win_lo - tile_start, win_hi - tile_start)
        stride_cls = "genic" if gene_count > win_bins * 0.5 else "intergenic"
        density_bins.append(max(0.0, min(16.0, float(enrichment))))
        density_classes.append(stride_cls)

        if cov_frac >= threshold:
            cls: Optional[str] = stride_cls
        else:
            cls = None   # gap

        if cls != run_cls:
            if run_cls is not None:
                spans_out.append({"start": run_start, "end": stride_start, "class_name": run_cls})
            run_cls = cls
            run_start = stride_start

    if run_cls is not None:
        spans_out.append({"start": run_start, "end": tile_end, "class_name": run_cls})

    return {
        "block_spans": spans_out,
        "density_bins": density_bins,
        "density_classes": density_classes,
        "density_stride_bp": int(block_bp),
    }


def _browse_vcf_block_tiles_sync(payload: "VcfBlockTilesRequest") -> Dict[str, Any]:
    if not payload.tiles:
        raise HTTPException(status_code=400, detail="tiles must not be empty")

    path = str(payload.path or "").strip()
    chrom_req = str(payload.chrom or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    if not chrom_req:
        raise HTTPException(status_code=400, detail="chrom is required")

    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold or 0.5)))

    t_total0 = time.perf_counter()
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")

    with locked_vcf(path) as (vcf_handle, fingerprint, resolved_path):
        resolved_chrom = _resolve_vcf_chrom(vcf_handle, chrom_req)
        if not resolved_chrom:
            raise HTTPException(status_code=400, detail=f"Chromosome '{chrom_req}' not present in VCF")

        # Load gene intervals for the whole batch at once
        req_tile_start = min(max(0, int(t.start)) for t in payload.tiles)
        req_tile_end = max(max(int(t.start) + 1, int(t.end)) for t in payload.tiles)
        try:
            gene_intervals = _load_vcf_gene_intervals(payload.genome, resolved_chrom, req_tile_start, req_tile_end)
        except Exception:
            gene_intervals = []

        out_tiles: List[Dict[str, Any]] = []

        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))

            cache_key = _vcf_block_tile_disk_cache_key(
                resolved_path, fingerprint, resolved_chrom, tile, coverage_threshold
            )
            cached = _load_vcf_block_tile_cache(cache_key)
            if cached is not None:
                out_tiles.append(cached)
                continue

            try:
                block_payload = _build_vcf_block_spans_fast(
                    vcf_handle,
                    resolved_chrom,
                    tile_start,
                    tile_end,
                    int(tile.block_bp),
                    int(tile.window_bp),
                    coverage_threshold,
                    gene_intervals,
                    str(tile.level_id or ""),
                )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not fetch VCF block tile. Ensure the VCF is bgzip-compressed and has a matching .tbi or .csi index: {exc}",
                )

            tile_payload: Dict[str, Any] = {
                "start": tile_start,
                "end": tile_end,
                "level_id": str(tile.level_id),
                "block_bp": int(tile.block_bp),
                "window_bp": int(tile.window_bp),
                "coverage_threshold": coverage_threshold,
                "block_spans": block_payload.get("block_spans", []),
                "density_bins": block_payload.get("density_bins", []),
                "density_classes": block_payload.get("density_classes", []),
                "density_stride_bp": int(block_payload.get("density_stride_bp") or int(tile.block_bp)),
            }
            _save_vcf_block_tile_cache(cache_key, tile_payload)
            out_tiles.append(tile_payload)

        total_ms = (time.perf_counter() - t_total0) * 1000.0
        logger.info(
            "VCF block tiles chrom=%s tiles=%d total=%.1fms",
            resolved_chrom, len(out_tiles), total_ms,
        )
        return {"chrom": resolved_chrom, "tiles": out_tiles}


def _browse_vcf_tiles_sync(payload: VcfTilesRequest) -> Dict[str, Any]:
    if not payload.tiles:
        raise HTTPException(status_code=400, detail="tiles must not be empty")

    path = str(payload.path or "").strip()
    chrom_req = str(payload.chrom or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    if not chrom_req:
        raise HTTPException(status_code=400, detail="chrom is required")

    t_total0 = time.perf_counter()
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")

    open_t0 = time.perf_counter()
    with locked_vcf(path) as (vcf_handle, fingerprint, resolved_path):
        resolved_chrom = _resolve_vcf_chrom(vcf_handle, chrom_req)
        if not resolved_chrom:
            raise HTTPException(status_code=400, detail=f"Chromosome '{chrom_req}' not present in VCF")
        open_ms = (time.perf_counter() - open_t0) * 1000.0

        req_tile_start = min(max(0, int(t.start)) for t in payload.tiles)
        req_tile_end = max(max(int(t.start) + 1, int(t.end)) for t in payload.tiles)
        gene_intervals: List[Tuple[int, int]] = []
        try:
            gene_intervals = _load_vcf_gene_intervals(payload.genome, resolved_chrom, req_tile_start, req_tile_end)
        except Exception:
            gene_intervals = []

        fetch_ms = 0.0
        agg_ms = 0.0
        serialize_ms = 0.0
        out_tiles: List[Dict[str, Any]] = []

        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))
            tile_mode = str(tile.mode or "summary").strip().lower()
            if tile_mode not in {"summary", "detail"}:
                tile_mode = "summary"
            tile_bins = max(20, min(4000, int(tile.bins or 512)))
            tile_max_variants = max(100, min(1_000_000, int(tile.max_variants or 3000)))

            tile_req = VcfTileRequest(
                start=tile_start,
                end=tile_end,
                lod=str(tile.lod or "L2"),
                mode=tile_mode,
                bins=tile_bins,
                max_variants=tile_max_variants,
                block_window_bp=(int(tile.block_window_bp) if tile.block_window_bp is not None else None),
                block_stride_bp=(int(tile.block_stride_bp) if tile.block_stride_bp is not None else None),
                block_coverage_threshold=(
                    float(tile.block_coverage_threshold)
                    if tile.block_coverage_threshold is not None
                    else 0.5
                ),
                block_mode=str(tile.block_mode or "coverage_spans"),
            )
            lod_id = str(tile_req.lod or "").upper()
            want_effects = bool(payload.include_effects) and not (tile_mode == "summary" and lod_id in {"L0", "L1"})
            cache_key = _vcf_disk_cache_key(resolved_path, fingerprint, resolved_chrom, tile_req, want_effects)
            cached_payload = _load_vcf_tile_disk_cache(cache_key) if tile_mode == "summary" else None
            if cached_payload:
                out_tiles.append(cached_payload)
                continue

            t_fetch0 = time.perf_counter()
            t_agg0 = time.perf_counter()
            try:
                if tile_mode == "summary":
                    built = _build_vcf_summary_tile(
                        vcf_handle,
                        resolved_chrom,
                        tile_start,
                        tile_end,
                        tile_bins,
                        tile_max_variants,
                        want_effects,
                        int(tile_req.block_window_bp or 10000),
                        int(tile_req.block_stride_bp or max(1, int(tile_req.block_window_bp or 10000) // 10)),
                        float(tile_req.block_coverage_threshold if tile_req.block_coverage_threshold is not None else 0.5),
                        str(tile_req.block_mode or "coverage_spans"),
                        gene_intervals,
                    )
                else:
                    built = _build_vcf_detail_tile(
                        vcf_handle,
                        resolved_chrom,
                        tile_start,
                        tile_end,
                        tile_max_variants,
                        want_effects,
                    )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not fetch VCF tile. Ensure the VCF is bgzip-compressed and has a matching .tbi or .csi index: {exc}",
                )
            agg_ms += (time.perf_counter() - t_agg0) * 1000.0
            fetch_ms += (time.perf_counter() - t_fetch0) * 1000.0

            t_ser0 = time.perf_counter()
            tile_payload = {
                "start": tile_start,
                "end": tile_end,
                "lod": str(tile_req.lod or "L2"),
                "mode": tile_mode,
                **built,
            }
            serialize_ms += (time.perf_counter() - t_ser0) * 1000.0

            if tile_mode == "summary":
                _save_vcf_tile_disk_cache(cache_key, tile_payload)
            out_tiles.append(tile_payload)

        total_ms = (time.perf_counter() - t_total0) * 1000.0
        logger.info(
            "VCF tile timings chrom=%s tiles=%d open=%.1fms fetch=%.1fms agg=%.1fms serialize=%.1fms total=%.1fms",
            resolved_chrom,
            len(out_tiles),
            open_ms,
            fetch_ms,
            agg_ms,
            serialize_ms,
            total_ms,
        )
        return {"chrom": resolved_chrom, "tiles": out_tiles}


@app.post("/api/browse/vcf/tiles")
async def browse_vcf_tiles(payload: VcfTilesRequest):
    return await run_in_threadpool(_browse_vcf_tiles_sync, payload)


@app.post("/api/browse/vcf/block_tiles")
async def browse_vcf_block_tiles(payload: VcfBlockTilesRequest):
    return await run_in_threadpool(_browse_vcf_block_tiles_sync, payload)


@app.get("/api/browse/vcf")
async def browse_vcf(
    path: str,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    level: str = "fine",          # 'overview'|'region'|'gene'|'fine'
    max_variants: int = 5000,
):
    mode = "detail" if str(level).lower() == "fine" else "summary"
    req = VcfTilesRequest(
        path=path,
        chrom=chrom,
        include_effects=True,
        tiles=[VcfTileRequest(
            start=start,
            end=end,
            lod=str(level or "L2"),
            mode=mode,
            bins=bins,
            max_variants=max_variants,
        )],
    )
    result = await run_in_threadpool(_browse_vcf_tiles_sync, req)
    tile = result.get("tiles", [{}])[0] if result.get("tiles") else {}

    if mode == "detail":
        return {
            "level": level,
            "start": start,
            "end": end,
            "variants": tile.get("variants", []),
            "truncated": bool(tile.get("truncated")),
            "has_data": bool(tile.get("has_data")),
        }

    return {
        "level": level,
        "start": start,
        "end": end,
        "bins": tile.get("bins", []),
        "max_count": tile.get("max_count", 0),
        "occupancy": tile.get("occupancy", []),
        "dominant_effect_bins": tile.get("dominant_effect_bins", []),
        "type_counts_bins": tile.get("type_counts_bins", []),
        "truncated": bool(tile.get("truncated")),
        "has_data": bool(tile.get("has_data")),
    }


# ── BED endpoint ─────────────────────────────────────────────────────────────

def _parse_bed_line(line: str) -> Optional[Dict]:
    """Parse one BED line into a dict. Returns None for comment/header/empty lines."""
    line = line.strip()
    if not line or line.startswith("#") or line.startswith("track") or line.startswith("browser"):
        return None
    cols = line.split("\t")
    if len(cols) < 3:
        return None
    try:
        chrom = cols[0]
        start = int(cols[1])  # 0-based
        end = int(cols[2])    # exclusive
    except ValueError:
        return None
    name = cols[3] if len(cols) > 3 else ""
    score = cols[4] if len(cols) > 4 else "0"
    strand = cols[5] if len(cols) > 5 else "."
    color = cols[8] if len(cols) > 8 else ""
    return {"chrom": chrom, "start": start, "end": end, "name": name, "score": score, "strand": strand, "color": color}


def _bed_density_bins(intervals: List[Dict], start: int, end: int, bins: int) -> List[int]:
    span = max(1, end - start)
    counts = [0] * bins
    for iv in intervals:
        i1 = int((iv["start"] - start) / span * bins)
        i2 = int((iv["end"] - start) / span * bins)
        i1 = max(0, min(bins - 1, i1))
        i2 = max(i1, min(bins - 1, i2))
        for i in range(i1, i2 + 1):
            counts[i] += 1
    return counts


def _is_bigbed_path(path: Path) -> bool:
    lower = str(path.name or "").strip().lower()
    return lower.endswith(".bb") or lower.endswith(".bigbed")


_BIGBED_SCHEMA_CACHE: Dict[str, Dict[str, Any]] = {}
_BIGBED_SCHEMA_CACHE_LOCK = threading.Lock()


def _bigbed_path_signature(path: Path) -> Tuple[int, int]:
    try:
        st = path.stat()
        return (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        return (0, 0)


def _canonical_bigbed_field_name(token: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(token or "").strip().lower())


def _parse_bigbed_sql_field_order(sql_raw: Any) -> List[str]:
    if sql_raw is None:
        return []
    if isinstance(sql_raw, (bytes, bytearray)):
        text = sql_raw.decode("utf-8", errors="replace")
    else:
        text = str(sql_raw)
    if not text.strip():
        return []
    start = text.find("(")
    end = text.rfind(")")
    if start < 0 or end <= start:
        return []
    body = text[start + 1:end]
    out: List[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        prefix = line.split('"', 1)[0].strip()
        if ";" not in prefix:
            continue
        token = prefix.split(";", 1)[0].strip()
        if not token:
            continue
        field = re.split(r"\s+", token)[-1].strip()
        if field:
            out.append(field)
    return out


def _get_bigbed_schema_info(path: Path, bb: Any) -> Dict[str, Any]:
    cache_key = str(path.resolve())
    sig = _bigbed_path_signature(path)
    with _BIGBED_SCHEMA_CACHE_LOCK:
        cached = _BIGBED_SCHEMA_CACHE.get(cache_key)
        if cached and cached.get("sig") == sig:
            return cached

    try:
        sql_raw = bb.SQL()
    except Exception:
        sql_raw = None
    field_order = _parse_bigbed_sql_field_order(sql_raw)
    rest_index: Dict[str, int] = {}
    for idx, field_name in enumerate(field_order):
        if idx < 3:
            continue
        canon = _canonical_bigbed_field_name(field_name)
        if canon and canon not in rest_index:
            rest_index[canon] = idx - 3
    parsed = {
        "sig": sig,
        "field_order": field_order,
        "rest_index": rest_index,
    }
    with _BIGBED_SCHEMA_CACHE_LOCK:
        _BIGBED_SCHEMA_CACHE[cache_key] = parsed
    return parsed


def _parse_csv_ints(value: Any) -> List[int]:
    token = str(value or "").strip().strip(",")
    if not token:
        return []
    out: List[int] = []
    for part in token.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except Exception:
            return []
    return out


def _parse_bigbed_rest(
    rest: Any,
    schema_info: Optional[Dict[str, Any]] = None,
    chrom_start: Optional[int] = None,
    chrom_end: Optional[int] = None,
) -> Dict[str, Any]:
    token = rest.decode("utf-8", errors="replace") if isinstance(rest, (bytes, bytearray)) else str(rest or "")
    cols = token.split("\t") if token else []
    rest_index = schema_info.get("rest_index") if isinstance(schema_info, dict) else None
    rest_index = rest_index if isinstance(rest_index, dict) else {}
    field_order = schema_info.get("field_order") if isinstance(schema_info, dict) else None
    field_order = field_order if isinstance(field_order, list) else []
    allow_positional_bed_fallback = not field_order

    def _find_col(field_names: List[str], fallback_idx: Optional[int] = None) -> str:
        for name in field_names:
            idx = rest_index.get(_canonical_bigbed_field_name(name))
            if idx is None:
                continue
            if 0 <= idx < len(cols):
                return cols[idx]
        if allow_positional_bed_fallback and fallback_idx is not None and 0 <= fallback_idx < len(cols):
            return cols[fallback_idx]
        return ""

    out: Dict[str, Any] = {
        "name": "",
        "score": "0",
        "strand": ".",
        "color": "",
        "itemRgb": "",
        "thick_start": None,
        "thick_end": None,
        "block_count": None,
        "block_sizes": "",
        "block_starts": "",
        "extra_fields": [],
        "extra_field_names": [],
        "extra_fields_map": {},
        "has_name": False,
        "has_score": False,
        "has_strand": False,
        "render_kind": "interval",
        "structure_valid": False,
        "exon_blocks": [],
        "cds_blocks": [],
    }
    raw_name = _find_col(["name"], fallback_idx=0)
    raw_score = _find_col(["score"], fallback_idx=1)
    raw_strand = _find_col(["strand"], fallback_idx=2)
    raw_thick_start = _find_col(["thickStart", "thick_start"], fallback_idx=3)
    raw_thick_end = _find_col(["thickEnd", "thick_end"], fallback_idx=4)
    raw_color = _find_col(["itemRgb", "item_rgb", "reserved", "color"], fallback_idx=5)
    raw_block_count = _find_col(["blockCount", "block_count"], fallback_idx=6)
    raw_block_sizes = _find_col(["blockSizes", "block_sizes"], fallback_idx=7)
    raw_block_starts = _find_col(["blockStarts", "block_starts", "chromStarts", "chrom_starts"], fallback_idx=8)

    if raw_name:
        out["name"] = raw_name
        out["has_name"] = True
    if raw_score:
        out["score"] = raw_score
        out["has_score"] = True
    if raw_strand:
        out["strand"] = raw_strand
        out["has_strand"] = True
    try:
        out["thick_start"] = int(raw_thick_start) if str(raw_thick_start).strip() else None
    except Exception:
        out["thick_start"] = None
    try:
        out["thick_end"] = int(raw_thick_end) if str(raw_thick_end).strip() else None
    except Exception:
        out["thick_end"] = None
    if raw_color:
        out["color"] = raw_color
        out["itemRgb"] = raw_color
    try:
        out["block_count"] = int(raw_block_count) if str(raw_block_count).strip() else None
    except Exception:
        out["block_count"] = None
    if raw_block_sizes:
        out["block_sizes"] = raw_block_sizes
    if raw_block_starts:
        out["block_starts"] = raw_block_starts

    known_indexes: Set[int] = set()
    for canon_name in (
        "name",
        "score",
        "strand",
        "thickstart",
        "thickend",
        "itemrgb",
        "reserved",
        "color",
        "blockcount",
        "blocksizes",
        "blockstarts",
        "chromstarts",
    ):
        idx = rest_index.get(canon_name)
        if isinstance(idx, int) and 0 <= idx < len(cols):
            known_indexes.add(idx)
    if not rest_index:
        known_indexes = {i for i in range(min(9, len(cols)))}
    extra_fields: List[str] = []
    extra_field_names: List[str] = []
    extra_fields_map: Dict[str, str] = {}
    for i in range(len(cols)):
        value = str(cols[i]).strip()
        if i in known_indexes or not value:
            continue
        field_name = str(field_order[i + 3] if i + 3 < len(field_order) else f"extra_{i + 1}").strip()
        extra_fields.append(value)
        extra_field_names.append(field_name)
        if field_name:
            extra_fields_map[field_name] = value
    out["extra_fields"] = extra_fields
    out["extra_field_names"] = extra_field_names
    out["extra_fields_map"] = extra_fields_map

    block_count = out["block_count"]
    block_sizes = _parse_csv_ints(out["block_sizes"])
    block_starts = _parse_csv_ints(out["block_starts"])
    if block_count is None and block_sizes and len(block_sizes) == len(block_starts):
        block_count = len(block_sizes)

    exon_blocks: List[Dict[str, int]] = []
    structure_valid = False
    if (
        isinstance(block_count, int)
        and block_count > 0
        and len(block_sizes) == block_count
        and len(block_starts) == block_count
        and chrom_start is not None
    ):
        cs = int(chrom_start)
        ce = int(chrom_end) if chrom_end is not None else None
        valid = True
        for size, rel_start in zip(block_sizes, block_starts):
            if size <= 0:
                valid = False
                break
            b_start = cs + int(rel_start)
            b_end = b_start + int(size)
            if ce is not None:
                b_start = max(cs, b_start)
                b_end = min(ce, b_end)
            if b_end <= b_start:
                continue
            exon_blocks.append({"start": int(b_start), "end": int(b_end)})
        if valid and exon_blocks:
            structure_valid = True

    cds_blocks: List[Dict[str, int]] = []
    thick_start = out["thick_start"]
    thick_end = out["thick_end"]
    if structure_valid and thick_start is not None and thick_end is not None and int(thick_end) > int(thick_start):
        ts = int(thick_start)
        te = int(thick_end)
        for block in exon_blocks:
            cds_start = max(int(block["start"]), ts)
            cds_end = min(int(block["end"]), te)
            if cds_end > cds_start:
                cds_blocks.append({"start": int(cds_start), "end": int(cds_end)})

    out["structure_valid"] = structure_valid
    out["render_kind"] = "transcript" if structure_valid else "interval"
    out["exon_blocks"] = exon_blocks
    out["cds_blocks"] = cds_blocks
    return out


def _bigbed_score_value(score: Any) -> float:
    try:
        return float(score)
    except Exception:
        return 0.0


def _parse_item_rgb(color_value: Any) -> Optional[Tuple[int, int, int]]:
    token = str(color_value or "").strip()
    if not token:
        return None
    parts = token.split(",")
    if len(parts) != 3:
        return None
    try:
        rgb = tuple(max(0, min(255, int(p))) for p in parts)
    except Exception:
        return None
    if len(rgb) != 3:
        return None
    return rgb  # type: ignore[return-value]


_SJ_CHROM_CACHE: Dict[str, Dict[str, Any]] = {}
_SJ_CHROM_CACHE_LOCK = threading.Lock()
_SPLICE_DB_CHROMS_CACHE: Dict[str, Dict[str, Any]] = {}
_SPLICE_DB_CHROMS_CACHE_LOCK = threading.Lock()
_SPLICE_ANNOTATED_INTRON_CACHE: Dict[str, Dict[str, Any]] = {}
_SPLICE_ANNOTATED_INTRON_CACHE_LOCK = threading.Lock()


def _get_sj_available_chroms(path: Path) -> List[str]:
    key = str(path.resolve())
    try:
        st = path.stat()
        sig = (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        sig = (0, 0)

    with _SJ_CHROM_CACHE_LOCK:
        cached = _SJ_CHROM_CACHE.get(key)
        if cached and cached.get("sig") == sig:
            return list(cached.get("chroms") or [])

    chroms: Set[str] = set()
    opener = gzip.open if str(path).endswith(".gz") else open
    try:
        with opener(str(path), "rt") as fh:
            for line in fh:
                raw = line.strip()
                if not raw:
                    continue
                cols = raw.split("\t")
                if not cols:
                    continue
                name = str(cols[0] or "").strip()
                if name:
                    chroms.add(name)
    except Exception:
        chroms = set()

    ordered = sorted(chroms)
    with _SJ_CHROM_CACHE_LOCK:
        _SJ_CHROM_CACHE[key] = {"sig": sig, "chroms": ordered}
    return ordered


def _resolve_track_chrom_with_aliases(requested: str, available: List[str], genome: str = "reference") -> str:
    token = str(requested or "").strip()
    if not token:
        return token
    known = [str(v or "").strip() for v in available if str(v or "").strip()]
    if not known:
        return token

    if token in known:
        return token

    lower_map: Dict[str, str] = {}
    for name in known:
        lower_map.setdefault(name.lower(), name)
    lower_hit = lower_map.get(token.lower())
    if lower_hit:
        return lower_hit

    query_tokens = chrom_token_variants(token)
    variant_matches = [name for name in known if chrom_token_variants(name) & query_tokens]
    if len(variant_matches) == 1:
        return variant_matches[0]

    # Assembly-report aware resolver (RefSeq/GenBank/UCSC/canonical aliases).
    resolved = genome_context._resolve_browse_chrom_name(genome, token, known)
    if resolved in known:
        return resolved
    resolved_l = str(resolved or "").lower()
    if resolved_l and resolved_l in lower_map:
        return lower_map[resolved_l]

    # Deterministic fallback when token-variant matching is ambiguous.
    if variant_matches:
        return sorted(variant_matches, key=lambda v: (len(v), v.lower()))[0]
    return token


def _db_file_signature(path: str) -> Tuple[int, int]:
    try:
        st = os.stat(path)
        return (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        return (0, 0)


def _get_transcript_db_chroms(db_path: str) -> List[str]:
    resolved = str(Path(db_path).expanduser().resolve())
    sig = _db_file_signature(resolved)
    with _SPLICE_DB_CHROMS_CACHE_LOCK:
        cached = _SPLICE_DB_CHROMS_CACHE.get(resolved)
        if cached and cached.get("sig") == sig:
            return list(cached.get("chroms") or [])

    chroms: List[str] = []
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute("SELECT DISTINCT chrom FROM transcripts")
        chroms = [str(r["chrom"] or "").strip() for r in c.fetchall() if str(r["chrom"] or "").strip()]
    except Exception:
        chroms = []
    finally:
        conn.close()

    with _SPLICE_DB_CHROMS_CACHE_LOCK:
        _SPLICE_DB_CHROMS_CACHE[resolved] = {"sig": sig, "chroms": chroms}
    return chroms


def _resolve_splice_annotation_chrom(genome: str, db_path: str, requested: str) -> Optional[str]:
    token = str(requested or "").strip()
    if not token:
        return None
    known = _get_transcript_db_chroms(db_path)
    if not known:
        return None
    if token in known:
        return token

    lower = token.lower()
    for name in known:
        if name.lower() == lower:
            return name

    query_tokens = chrom_token_variants(token)
    variant_matches = [name for name in known if chrom_token_variants(name) & query_tokens]
    if len(variant_matches) == 1:
        return variant_matches[0]

    resolved = genome_context._resolve_browse_chrom_name(genome, token, known)
    if resolved in known:
        return resolved
    resolved_l = str(resolved or "").lower()
    if resolved_l:
        for name in known:
            if name.lower() == resolved_l:
                return name

    if variant_matches:
        return sorted(variant_matches, key=lambda v: (len(v), v.lower()))[0]
    return None


def _load_splice_annotated_intron_pairs(db_path: str, chrom: str) -> Set[Tuple[int, int]]:
    resolved_db = str(Path(db_path).expanduser().resolve())
    token = str(chrom or "").strip()
    if not token:
        return set()

    sig = _db_file_signature(resolved_db)
    cache_key = f"{resolved_db}|{token}"
    with _SPLICE_ANNOTATED_INTRON_CACHE_LOCK:
        cached = _SPLICE_ANNOTATED_INTRON_CACHE.get(cache_key)
        if cached and cached.get("sig") == sig:
            return set(cached.get("pairs") or [])

    pairs: Set[Tuple[int, int]] = set()
    conn = sqlite3.connect(resolved_db)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute("SELECT strand, data FROM transcripts WHERE chrom = ?", (token,))
        rows = c.fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()

    for row in rows:
        strand = str(row["strand"] or "+").strip() or "+"
        raw_data = row["data"]
        try:
            tx_data = json.loads(raw_data) if raw_data else {}
        except Exception:
            tx_data = {}
        tx_data = tx_data if isinstance(tx_data, dict) else {}
        exons = _normalize_interval_list(tx_data.get("exons", []), "exon", strand)
        if len(exons) < 2:
            continue
        ordered = sorted(exons, key=lambda e: (int(e.get("start", 0) or 0), int(e.get("end", 0) or 0)))
        for idx in range(len(ordered) - 1):
            left = ordered[idx]
            right = ordered[idx + 1]
            intron_start = int(left.get("end", 0) or 0) + 1
            intron_end = int(right.get("start", 0) or 0) - 1
            if intron_start > 0 and intron_end >= intron_start:
                pairs.add((intron_start, intron_end))

    with _SPLICE_ANNOTATED_INTRON_CACHE_LOCK:
        _SPLICE_ANNOTATED_INTRON_CACHE[cache_key] = {
            "sig": sig,
            "pairs": list(pairs),
        }
    return pairs


def _resolve_splice_applied_settings(
    path: str,
    track_id: Optional[str],
    min_reads: int,
    min_support: Optional[int],
    canonical_mode: Optional[str],
    annotated_mode: Optional[str],
    max_junctions: Optional[int],
) -> Dict[str, Any]:
    track = routes.tracks._get_registered_track(track_id or "")
    registry_settings = None
    if track and track.get("type") == "splice_junctions":
        same_path = str(track.get("path") or "").strip() == str(path or "").strip()
        if same_path:
            registry_settings = routes.tracks._normalize_splice_settings(track.get("splice_settings"))

    applied = routes.tracks._normalize_splice_settings(registry_settings)
    applied["min_support"] = max(
        routes.tracks._to_int_or_default(min_reads, 1, minimum=1),
        routes.tracks._to_int_or_default(min_support, applied["min_support"], minimum=1),
    )
    if canonical_mode is not None:
        mode = str(canonical_mode).strip().lower()
        if mode in routes.tracks._CANONICAL_SPLICE_MODES:
            applied["canonical_mode"] = mode
    if annotated_mode is not None:
        mode = str(annotated_mode).strip().lower()
        if mode in routes.tracks._ANNOTATED_SPLICE_MODES:
            applied["annotated_mode"] = mode
    if max_junctions is not None:
        applied["max_junctions"] = routes.tracks._to_int_or_default(max_junctions, applied["max_junctions"], minimum=100, maximum=100_000)
    return applied


def _load_splice_local_annotation_pairs(genome: str, resolved_chrom: str, requested_chrom: str) -> Optional[Set[Tuple[int, int]]]:
    local_annotated_pairs: Optional[Set[Tuple[int, int]]] = None
    try:
        db_path = genome_context._get_browse_db(genome)
        db_chrom = _resolve_splice_annotation_chrom(genome, db_path, resolved_chrom)
        if not db_chrom:
            db_chrom = _resolve_splice_annotation_chrom(genome, db_path, requested_chrom)
        if db_chrom:
            local_annotated_pairs = _load_splice_annotated_intron_pairs(db_path, db_chrom)
    except HTTPException:
        local_annotated_pairs = None
    except Exception:
        local_annotated_pairs = None
    return local_annotated_pairs


def _collect_splice_junctions(
    sj_path: Path,
    resolved_chrom: str,
    start: int,
    end: int,
    applied: Dict[str, Any],
    local_annotated_pairs: Optional[Set[Tuple[int, int]]],
) -> List[Dict[str, Any]]:
    motif_map = {
        "0": "non-canonical",
        "1": "GT/AG",
        "2": "CT/AC",
        "3": "GC/AG",
        "4": "CT/GC",
        "5": "AT/AC",
        "6": "GT/AT",
    }
    junctions: List[Dict[str, Any]] = []
    opener = gzip.open if str(sj_path).endswith(".gz") else open
    with opener(str(sj_path), "rt") as fh:
        for line in fh:
            cols = line.strip().split("\t")
            if len(cols) < 7:
                continue
            jchrom = cols[0]
            if jchrom != resolved_chrom:
                continue
            try:
                jstart = int(cols[1])   # 1-based intron start
                jend = int(cols[2])     # 1-based intron end
            except ValueError:
                continue
            if jend < start or jstart > end:
                continue
            n_unique = int(cols[6]) if cols[6].isdigit() else 0
            n_multi = int(cols[7]) if len(cols) > 7 and cols[7].isdigit() else 0
            n_total = n_unique + n_multi
            if n_total < applied["min_support"]:
                continue
            strand_code = cols[3]  # 0=undefined,1=+,2=-
            strand = "." if strand_code == "0" else ("+" if strand_code == "1" else "-")
            motif = motif_map.get(cols[4], "unknown")
            star_annotated = cols[5] == "1"
            annotated = ((jstart, jend) in local_annotated_pairs) if local_annotated_pairs is not None else star_annotated
            canonical = routes.tracks._is_canonical_splice_motif(motif)
            if applied["canonical_mode"] == "canonical" and not canonical:
                continue
            if applied["canonical_mode"] == "non_canonical" and canonical:
                continue
            if applied["annotated_mode"] == "annotated" and not annotated:
                continue
            if applied["annotated_mode"] == "novel" and annotated:
                continue
            junctions.append({
                "chrom": jchrom,
                "start": jstart,  # 1-based, intron start
                "end": jend,      # 1-based, intron end
                "strand": strand,
                "motif": motif,
                "canonical": canonical,
                "annotated": annotated,
                "star_annotated": star_annotated,
                "n_unique": n_unique,
                "n_multi": n_multi,
                "n_total": n_total,
            })

    junctions.sort(
        key=lambda j: (
            -int(j.get("n_total", 0)),
            int(j.get("start", 0)),
            int(j.get("end", 0)),
            str(j.get("strand", ".")),
        )
    )
    if len(junctions) > applied["max_junctions"]:
        junctions = junctions[:applied["max_junctions"]]
    return junctions


def _build_splice_block_spans_from_junctions(
    junctions: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> Tuple[List[Dict[str, Any]], int]:
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    active = [0] * slot_count
    max_support = [0] * slot_count

    for jn in junctions:
        jstart = int(jn.get("start", 0) or 0)
        jend = int(jn.get("end", 0) or 0)
        if jend <= tile_start or jstart >= tile_end:
            continue
        ov_start = max(tile_start, jstart)
        ov_end = min(tile_end, jend)
        if ov_end <= ov_start:
            continue
        b0 = max(0, min(slot_count - 1, (ov_start - tile_start) // block_size))
        b1 = max(0, min(slot_count - 1, (max(ov_start, ov_end - 1) - tile_start) // block_size))
        support = max(0, int(jn.get("n_total", 0) or 0))
        for idx in range(b0, b1 + 1):
            active[idx] = 1
            if support > max_support[idx]:
                max_support[idx] = support

    spans: List[Dict[str, Any]] = []
    painted_bp = 0
    idx = 0
    while idx < slot_count:
        if active[idx] == 0:
            idx += 1
            continue
        run_start = idx
        run_max = max_support[idx]
        idx += 1
        while idx < slot_count and active[idx] == 1:
            run_max = max(run_max, max_support[idx])
            idx += 1
        run_end = idx - 1
        start_bp = tile_start + run_start * block_size
        end_bp = min(tile_end, tile_start + (run_end + 1) * block_size)
        if end_bp > start_bp:
            spans.append({
                "start": int(start_bp),
                "end": int(end_bp),
                "max_support": int(run_max),
            })
            painted_bp += (end_bp - start_bp)

    return spans, painted_bp


@app.get("/api/browse/bed")
async def browse_bed(
    path: str,
    chrom: str,
    start: int,
    end: int,
    genome: str = "reference",
    bins: int = 500,
    level: str = "fine",
    max_intervals: int = 10000,
):
    """
    Query a BED/BigBed file for intervals overlapping [start, end).
    Performs a linear scan (BED is not always indexed). For large files a tabix
    index will be used if present (.tbi alongside the .bed.gz).
    """
    def _run():
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BED not found: {path}")

        intervals: List[Dict] = []
        resolved_chrom = str(chrom or "")

        if _is_bigbed_path(p):
            if pyBigWig is None:
                raise HTTPException(
                    status_code=503,
                    detail="BigBed support is unavailable. Install pyBigWig in the backend environment.",
                )
            try:
                bb = pyBigWig.open(str(p))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
            if bb is None:
                raise HTTPException(status_code=400, detail="Failed to open BigBed file.")
            try:
                chrom_sizes = bb.chroms() or {}
                available_chroms = list(chrom_sizes.keys())
                resolved_chrom = _resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
                schema_info = _get_bigbed_schema_info(p, bb)
                if resolved_chrom not in chrom_sizes:
                    if level == "fine":
                        return {
                            "level": level,
                            "start": start,
                            "end": end,
                            "intervals": [],
                            "features": [],
                            "resolved_chrom": None,
                            "has_data": False,
                            "detail": "Chromosome not present in BigBed file.",
                        }
                    return {
                        "level": level,
                        "start": start,
                        "end": end,
                        "bins": [0] * bins,
                        "max_count": 0,
                        "resolved_chrom": None,
                        "has_data": False,
                        "detail": "Chromosome not present in BigBed file.",
                    }

                chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
                q_start = max(0, int(start))
                q_end = min(int(end), chrom_len) if chrom_len > 0 else int(end)
                if q_end > q_start:
                    rows = bb.entries(resolved_chrom, q_start, q_end) or []
                    for row in rows:
                        if not isinstance(row, (tuple, list)) or len(row) < 2:
                            continue
                        iv_start = int(row[0])
                        iv_end = int(row[1])
                        if iv_end < q_start or iv_start > q_end:
                            continue
                        rec = {
                            "chrom": resolved_chrom,
                            "start": iv_start,
                            "end": iv_end,
                            "name": "",
                            "score": "0",
                            "strand": ".",
                            "color": "",
                        }
                        if len(row) > 2:
                            rec.update(
                                _parse_bigbed_rest(
                                    row[2],
                                    schema_info=schema_info,
                                    chrom_start=iv_start,
                                    chrom_end=iv_end,
                                )
                            )
                        intervals.append(rec)
                        if len(intervals) >= max_intervals:
                            break
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"BigBed read error: {e}")
            finally:
                try:
                    bb.close()
                except Exception:
                    pass

        else:
            # Try tabix if available
            tbi = Path(str(path) + ".tbi")
            if tbi.exists():
                try:
                    import pysam  # type: ignore
                    tbx = pysam.TabixFile(str(p))
                    try:
                        available_chroms = list(tbx.contigs or [])
                        resolved_chrom = _resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
                        if resolved_chrom in set(available_chroms):
                            for row in tbx.fetch(resolved_chrom, max(0, start - 1), end):
                                rec = _parse_bed_line(row)
                                if rec and len(intervals) < max_intervals:
                                    intervals.append(rec)
                    finally:
                        tbx.close()
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"BED tabix query error: {e}")
            else:
                # The file is read once into a cached in-memory index, not scanned per request.
                try:
                    index = get_plain_bed_index(p)
                    known_chroms = sorted(index.chroms().keys())
                    if known_chroms:
                        resolved_chrom = _resolve_track_chrom_with_aliases(chrom, known_chroms, genome=genome)
                        for f_start, f_end, rest in index.entries(resolved_chrom, max(0, start), end):
                            rec = _parse_bed_line(f"{resolved_chrom}\t{f_start}\t{f_end}\t{rest}")
                            if rec:
                                intervals.append(rec)
                            if len(intervals) >= max_intervals:
                                break
                    else:
                        intervals = []
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"BED read error: {e}")

        if level == "fine":
            return {
                "level": level,
                "start": start,
                "end": end,
                "intervals": intervals,
                "features": intervals,
                "resolved_chrom": resolved_chrom,
                "has_data": len(intervals) > 0,
            }
        else:
            density = _bed_density_bins(intervals, start, end, bins)
            return {
                "level": level,
                "start": start,
                "end": end,
                "bins": density,
                "max_count": max(density) if density else 0,
                "resolved_chrom": resolved_chrom,
                "has_data": any(v > 0 for v in density),
            }

    return await run_in_threadpool(_run)


def _open_bed_tile_source(p: Path, feature_model: str = "") -> Any:
    """A BigBed handle, or a plain BED or GFF/GTF file answering the same calls.

    Plain BED and GFF go through an in-memory index (or their tabix index) built once
    per file, so the tile endpoints serve every interval format with the same tiling
    and summaries.
    """
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Track file not found: {p}")
    if is_plain_bed_path(p) or is_gff_path(p):
        try:
            return open_plain_bed(p, feature_model)
        except Exception as e:
            kind = "GFF" if is_gff_path(p) else "BED"
            raise HTTPException(status_code=400, detail=f"Failed to read {kind}: {e}")
    if not _is_bigbed_path(p):
        raise HTTPException(status_code=400, detail="path is not a BED, GFF or BigBed file")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigBed support is unavailable. Install pyBigWig.")
    try:
        bb = pyBigWig.open(str(p))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
    if bb is None:
        raise HTTPException(status_code=400, detail="Failed to open BigBed file.")
    return bb


def _bed_block_counts(
    features: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> List[int]:
    """How many features overlap each block of a tile."""
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    counts = [0] * slot_count
    for feature in features:
        ov_start = max(tile_start, int(feature.get("start", 0) or 0))
        ov_end = min(tile_end, int(feature.get("end", 0) or 0))
        if ov_end <= ov_start:
            continue
        b0 = (ov_start - tile_start) // block_size
        b1 = min(slot_count - 1, (ov_end - 1 - tile_start) // block_size)
        for idx in range(b0, b1 + 1):
            counts[idx] += 1
    return counts


def _build_bigbed_block_spans_from_features(
    features: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> Tuple[List[Dict[str, Any]], int]:
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    active = [0] * slot_count
    feature_counts = [0] * slot_count
    max_score = [0.0] * slot_count
    color_hint = [""] * slot_count

    for feature in features:
        f_start = int(feature.get("start", 0) or 0)
        f_end = int(feature.get("end", 0) or 0)
        if f_end <= tile_start or f_start >= tile_end:
            continue
        ov_start = max(tile_start, f_start)
        ov_end = min(tile_end, f_end)
        if ov_end <= ov_start:
            continue
        b0 = max(0, min(slot_count - 1, (ov_start - tile_start) // block_size))
        b1 = max(0, min(slot_count - 1, (max(ov_start, ov_end - 1) - tile_start) // block_size))
        score = _bigbed_score_value(feature.get("score"))
        color = str(feature.get("itemRgb") or feature.get("color") or "").strip()
        for idx in range(b0, b1 + 1):
            active[idx] = 1
            feature_counts[idx] += 1
            if score >= max_score[idx]:
                max_score[idx] = score
                if color:
                    color_hint[idx] = color

    spans: List[Dict[str, Any]] = []
    painted_bp = 0
    idx = 0
    while idx < slot_count:
        if active[idx] == 0:
            idx += 1
            continue
        run_start = idx
        run_max_score = max_score[idx]
        run_max_count = feature_counts[idx]
        run_color = color_hint[idx]
        idx += 1
        while idx < slot_count and active[idx] == 1:
            run_max_score = max(run_max_score, max_score[idx])
            run_max_count = max(run_max_count, feature_counts[idx])
            if not run_color and color_hint[idx]:
                run_color = color_hint[idx]
            idx += 1
        run_end = idx - 1
        start_bp = tile_start + run_start * block_size
        end_bp = min(tile_end, tile_start + (run_end + 1) * block_size)
        if end_bp > start_bp:
            spans.append({
                "start": int(start_bp),
                "end": int(end_bp),
                "feature_count": int(run_max_count),
                "max_score": float(run_max_score),
                "color_hint": run_color,
            })
            painted_bp += (end_bp - start_bp)
    return spans, painted_bp


def _select_bigbed_tile_entries(
    bb: Any,
    resolved_chrom: str,
    tile_start: int,
    tile_end: int,
    max_features: int,
    schema_info: Optional[Dict[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], bool]:
    rows = bb.entries(resolved_chrom, tile_start, tile_end) or []
    features: List[Dict[str, Any]] = []
    truncated = False
    for row in rows:
        if not isinstance(row, (tuple, list)) or len(row) < 2:
            continue
        try:
            f_start = int(row[0])
            f_end = int(row[1])
        except Exception:
            continue
        if f_end <= tile_start or f_start >= tile_end:
            continue
        rec: Dict[str, Any] = {
            "chrom": resolved_chrom,
            "start": f_start,
            "end": f_end,
            "name": "",
            "score": "0",
            "strand": ".",
            "color": "",
            "itemRgb": "",
            "thick_start": None,
            "thick_end": None,
            "block_count": None,
            "block_sizes": "",
            "block_starts": "",
            "extra_fields": [],
        }
        if len(row) > 2:
            rec.update(
                _parse_bigbed_rest(
                    row[2],
                    schema_info=schema_info,
                    chrom_start=f_start,
                    chrom_end=f_end,
                )
            )
        features.append(rec)
        if len(features) >= max_features:
            truncated = True
            break

    features.sort(
        key=lambda f: (
            int(f.get("start", 0) or 0),
            int(f.get("end", 0) or 0),
            str(f.get("name") or ""),
            -_bigbed_score_value(f.get("score")),
            str(f.get("strand") or "."),
        )
    )
    return features, truncated


def _select_bigbed_block_entries(
    bb: Any,
    resolved_chrom: str,
    tile_start: int,
    tile_end: int,
    max_features: int,
    schema_info: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Just what a summary block needs from each row: its span, score and colour.

    The full row parse (names, blocks, extra fields) cost ~20µs a row, which a whole-
    chromosome summary of a dense file — 40k regulatory features — turned into most of
    a second, all of it thrown away when the rows were folded into blocks.
    """
    rest_index = (schema_info or {}).get("rest_index") or {}
    score_idx = rest_index.get("score", 1 if not rest_index else None)
    colour_idx = rest_index.get("itemrgb", rest_index.get("reserved", 5 if not rest_index else None))
    out: List[Dict[str, Any]] = []
    for row in bb.entries(resolved_chrom, tile_start, tile_end) or []:
        if not isinstance(row, (tuple, list)) or len(row) < 2:
            continue
        try:
            f_start = int(row[0])
            f_end = int(row[1])
        except Exception:
            continue
        if f_end <= tile_start or f_start >= tile_end:
            continue
        score = "0"
        colour = ""
        if len(row) > 2 and (score_idx is not None or colour_idx is not None):
            rest = row[2]
            cols = (rest.decode("utf-8", errors="replace") if isinstance(rest, (bytes, bytearray)) else str(rest or "")).split("\t")
            if score_idx is not None and score_idx < len(cols) and cols[score_idx]:
                score = cols[score_idx]
            if colour_idx is not None and colour_idx < len(cols):
                colour = cols[colour_idx]
        out.append({"start": f_start, "end": f_end, "score": score, "itemRgb": colour})
        if len(out) >= max_features:
            break
    return out


@app.post("/api/browse/bigbed/block_tiles")
async def browse_bigbed_block_tiles(payload: BigBedBlockTilesRequest):
    def _run():
        if not payload.tiles:
            raise HTTPException(status_code=400, detail="tiles must not be empty")
        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        bb = _open_bed_tile_source(p, str(payload.feature_model or ""))

        try:
            chrom_sizes = bb.chroms() or {}
            available = list(chrom_sizes.keys())
            resolved_chrom = _resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
            schema_info = _get_bigbed_schema_info(p, bb)
            if resolved_chrom not in chrom_sizes:
                return {
                    "chrom": chrom_req,
                    "resolved_chrom": None,
                    "tiles": [
                        {
                            "start": max(0, int(tile.start)),
                            "end": max(max(0, int(tile.start)) + 1, int(tile.end)),
                            "level_id": str(tile.level_id or "L0"),
                            "block_bp": int(max(1, int(tile.block_bp))),
                            "block_spans": [],
                            "has_data": False,
                            "coverage": 0.0,
                        }
                        for tile in payload.tiles
                    ],
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
            out_tiles: List[Dict[str, Any]] = []
            for tile in payload.tiles:
                tile_start = max(0, int(tile.start))
                tile_end = max(tile_start + 1, int(tile.end))
                tile_end = min(tile_end, chrom_len) if chrom_len > 0 else tile_end
                if tile_end <= tile_start:
                    out_tiles.append({
                        "start": tile_start,
                        "end": tile_end,
                        "level_id": str(tile.level_id or "L0"),
                        "block_bp": int(max(1, int(tile.block_bp))),
                        "block_spans": [],
                        "has_data": False,
                        "coverage": 0.0,
                    })
                    continue

                # Summary mode intentionally tolerates high row counts; cap to avoid pathological stalls.
                features = _select_bigbed_block_entries(
                    bb=bb,
                    resolved_chrom=resolved_chrom,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    max_features=250_000,
                    schema_info=schema_info,
                )
                block_bp = routes.tracks._to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
                block_spans, painted_bp = _build_bigbed_block_spans_from_features(
                    features=features,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    block_bp=block_bp,
                )
                tile_span = max(1, tile_end - tile_start)
                out_tile = {
                    "start": tile_start,
                    "end": tile_end,
                    "level_id": str(tile.level_id or "L0"),
                    "block_bp": int(block_bp),
                    "block_spans": block_spans,
                    "has_data": bool(block_spans),
                    "coverage": float(max(0.0, min(1.0, painted_bp / tile_span))),
                }
                if payload.include_counts:
                    out_tile["counts"] = _bed_block_counts(features, tile_start, tile_end, block_bp)
                out_tiles.append(out_tile)

            return {"chrom": resolved_chrom, "resolved_chrom": resolved_chrom, "tiles": out_tiles}
        finally:
            try:
                bb.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)


@app.post("/api/browse/bigbed/feature_tiles")
async def browse_bigbed_feature_tiles(payload: BigBedFeatureTilesRequest):
    def _run():
        if not payload.tiles:
            raise HTTPException(status_code=400, detail="tiles must not be empty")
        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        bb = _open_bed_tile_source(p, str(payload.feature_model or ""))

        try:
            chrom_sizes = bb.chroms() or {}
            available = list(chrom_sizes.keys())
            resolved_chrom = _resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
            schema_info = _get_bigbed_schema_info(p, bb)
            if resolved_chrom not in chrom_sizes:
                return {
                    "chrom": chrom_req,
                    "resolved_chrom": None,
                    "tiles": [
                        {
                            "start": max(0, int(tile.start)),
                            "end": max(max(0, int(tile.start)) + 1, int(tile.end)),
                            "level_id": str(tile.level_id or "detail"),
                            "features": [],
                            "has_data": False,
                            "coverage": 0.0,
                            "truncated": False,
                        }
                        for tile in payload.tiles
                    ],
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
            request_limit = routes.tracks._to_int_or_default(payload.max_features_per_tile, 3000, minimum=100, maximum=50_000)
            out_tiles: List[Dict[str, Any]] = []

            for tile in payload.tiles:
                tile_start = max(0, int(tile.start))
                tile_end = max(tile_start + 1, int(tile.end))
                tile_end = min(tile_end, chrom_len) if chrom_len > 0 else tile_end
                if tile_end <= tile_start:
                    out_tiles.append({
                        "start": tile_start,
                        "end": tile_end,
                        "level_id": str(tile.level_id or "detail"),
                        "features": [],
                        "has_data": False,
                        "coverage": 0.0,
                        "truncated": False,
                    })
                    continue

                max_features = routes.tracks._to_int_or_default(tile.max_features, request_limit, minimum=100, maximum=50_000)
                features, truncated = _select_bigbed_tile_entries(
                    bb=bb,
                    resolved_chrom=resolved_chrom,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    max_features=max_features,
                    schema_info=schema_info,
                )
                covered_bp = 0
                if features:
                    sorted_feats = sorted(features, key=lambda f: (int(f.get("start", 0) or 0), int(f.get("end", 0) or 0)))
                    run_start = int(sorted_feats[0].get("start", 0) or 0)
                    run_end = int(sorted_feats[0].get("end", 0) or 0)
                    for feature in sorted_feats[1:]:
                        s = int(feature.get("start", 0) or 0)
                        e = int(feature.get("end", 0) or 0)
                        if s <= run_end:
                            run_end = max(run_end, e)
                        else:
                            covered_bp += max(0, run_end - run_start)
                            run_start, run_end = s, e
                    covered_bp += max(0, run_end - run_start)
                tile_span = max(1, tile_end - tile_start)
                out_tiles.append({
                    "start": tile_start,
                    "end": tile_end,
                    "level_id": str(tile.level_id or "detail"),
                    "features": features,
                    "has_data": bool(features),
                    "coverage": float(max(0.0, min(1.0, covered_bp / tile_span))),
                    "truncated": bool(truncated),
                })

            return {"chrom": resolved_chrom, "resolved_chrom": resolved_chrom, "tiles": out_tiles}
        finally:
            try:
                bb.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)


# ── STAR Splice Junctions endpoint ───────────────────────────────────────────

@app.get("/api/browse/splice_junctions")
async def browse_splice_junctions(
    path: str,
    chrom: str,
    start: int,
    end: int,
    genome: str = "reference",
    track_id: Optional[str] = None,
    min_reads: int = 1,
    min_support: Optional[int] = None,
    canonical_mode: Optional[str] = None,   # all | canonical | non_canonical
    annotated_mode: Optional[str] = None,   # all | annotated | novel
    bins: int = 500,
    level: str = "fine",
    max_junctions: Optional[int] = None,
):
    """
    Parse a STAR SJ.out.tab file and return splice junctions overlapping [start, end).
    SJ.out.tab columns: chrom, intron_start(1-based), intron_end(1-based), strand, intron_motif,
                         annotated, n_unique_mapped, n_multi_mapped, max_overhang.
    """
    def _run():
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"SJ file not found: {path}")

        applied = _resolve_splice_applied_settings(
            path=path,
            track_id=track_id,
            min_reads=min_reads,
            min_support=min_support,
            canonical_mode=canonical_mode,
            annotated_mode=annotated_mode,
            max_junctions=max_junctions,
        )

        available_chroms = _get_sj_available_chroms(p)
        resolved_chrom = _resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
        local_annotated_pairs = _load_splice_local_annotation_pairs(genome, resolved_chrom, chrom)

        try:
            junctions = _collect_splice_junctions(
                sj_path=p,
                resolved_chrom=resolved_chrom,
                start=start,
                end=end,
                applied=applied,
                local_annotated_pairs=local_annotated_pairs,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"SJ parse error: {e}")

        if level == "fine":
            return {
                "level": level,
                "chrom": resolved_chrom,
                "start": start,
                "end": end,
                "junctions": junctions,
                "applied_filters": applied,
            }

        # Density: count junctions per bin, weighted by read count
        span = max(1, end - start)
        density = [0.0] * bins
        for jn in junctions:
            mid = (jn["start"] + jn["end"]) / 2
            idx = int((mid - start) / span * bins)
            idx = max(0, min(bins - 1, idx))
            density[idx] += jn["n_total"]
        max_count = max(density) if density else 0
        return {
            "level": level,
            "chrom": resolved_chrom,
            "start": start,
            "end": end,
            "bins": density,
            "max_count": max_count,
            "applied_filters": applied,
        }

    return await run_in_threadpool(_run)


@app.post("/api/browse/splice_junctions/block_tiles")
async def browse_splice_junctions_block_tiles(payload: SpliceBlockTilesRequest):
    def _run():
        if not payload.tiles:
            raise HTTPException(status_code=400, detail="tiles must not be empty")

        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"SJ file not found: {path}")

        applied = _resolve_splice_applied_settings(
            path=path,
            track_id=payload.track_id,
            min_reads=int(payload.min_reads),
            min_support=payload.min_support,
            canonical_mode=payload.canonical_mode,
            annotated_mode=payload.annotated_mode,
            max_junctions=payload.max_junctions,
        )

        req_start = min(max(0, int(tile.start)) for tile in payload.tiles)
        req_end = max(max(int(tile.start) + 1, int(tile.end)) for tile in payload.tiles)

        available_chroms = _get_sj_available_chroms(p)
        resolved_chrom = _resolve_track_chrom_with_aliases(chrom_req, available_chroms, genome=genome)
        local_annotated_pairs = _load_splice_local_annotation_pairs(genome, resolved_chrom, chrom_req)
        try:
            junctions = _collect_splice_junctions(
                sj_path=p,
                resolved_chrom=resolved_chrom,
                start=req_start,
                end=req_end,
                applied=applied,
                local_annotated_pairs=local_annotated_pairs,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"SJ parse error: {e}")

        out_tiles: List[Dict[str, Any]] = []
        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))
            block_bp = routes.tracks._to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
            block_spans, painted_bp = _build_splice_block_spans_from_junctions(
                junctions=junctions,
                tile_start=tile_start,
                tile_end=tile_end,
                block_bp=block_bp,
            )
            tile_span = max(1, tile_end - tile_start)
            out_tiles.append({
                "start": tile_start,
                "end": tile_end,
                "level_id": str(tile.level_id or "L0"),
                "block_bp": int(block_bp),
                "block_spans": block_spans,
                "has_data": bool(block_spans),
                "coverage": float(max(0.0, min(1.0, painted_bp / tile_span))),
            })

        return {
            "chrom": resolved_chrom,
            "tiles": out_tiles,
            "applied_filters": applied,
        }

    return await run_in_threadpool(_run)


# ── Long Reads / minimap2 BAM endpoint ───────────────────────────────────────

def _get_bam_coverage_bins(bam_path: str, chrom: str, start: int, end: int, bins: int) -> List[float]:
    """Compute per-bin average coverage from a BAM pileup (requires pysam)."""
    try:
        import pysam  # type: ignore
    except ImportError:
        return []
    span = max(1, end - start)
    counts = [0.0] * bins
    try:
        bam = pysam.AlignmentFile(bam_path, "rb")
        for pileup_col in bam.pileup(chrom, max(0, start - 1), end, min_base_quality=0):
            pos = pileup_col.reference_pos  # 0-based
            if pos < start or pos >= end:
                continue
            idx = int((pos - start) / span * bins)
            idx = max(0, min(bins - 1, idx))
            counts[idx] += pileup_col.nsegments
        bam.close()
    except Exception:
        pass
    return counts


def _collapse_long_reads(reads: List[Dict]) -> List[Dict]:
    """
    Collapse minimap2 long reads by splice pattern (exon blocks).
    Reads with identical block structures are merged into a 'transcript model'
    with a read count. Returns a list of collapsed models sorted by start.
    """
    pattern_map: Dict[str, Dict] = {}
    for read in reads:
        blocks = read.get("blocks", [])
        key = "|".join(f"{b[0]}-{b[1]}" for b in blocks)
        if key not in pattern_map:
            pattern_map[key] = {
                "start": read["start"],
                "end": read["end"],
                "strand": read.get("strand", "."),
                "blocks": blocks,
                "count": 0,
                "name": read.get("name", ""),
            }
        pattern_map[key]["count"] += 1

    collapsed = sorted(pattern_map.values(), key=lambda x: x["start"])
    # Sort by count descending within the same region
    collapsed.sort(key=lambda x: (-x["count"], x["start"]))
    return collapsed


@app.get("/api/browse/long_reads")
async def browse_long_reads(
    path: str,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    level: str = "fine",
    max_reads: int = 2000,
    collapse: bool = True,
):
    """
    Query a minimap2 BAM for long reads overlapping [start, end).
    - For fine levels: returns collapsed read models (grouped by splice pattern)
    - For coarse levels: returns coverage bins
    """
    def _run():
        try:
            import pysam  # type: ignore
        except ImportError:
            raise HTTPException(status_code=503, detail="pysam not installed. Run: pip install pysam")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BAM not found: {path}")

        if level != "fine":
            cov = _get_bam_coverage_bins(str(p), chrom, start, end, bins)
            max_cov = max(cov) if cov else 0
            return {"level": level, "start": start, "end": end, "bins": cov, "max_count": max_cov}

        # Fine level: return individual reads (collapsed)
        reads = []
        try:
            bam = pysam.AlignmentFile(str(p), "rb")
            for aln in bam.fetch(chrom, max(0, start - 1), end):
                if aln.is_unmapped or aln.is_secondary or aln.is_supplementary:
                    continue
                if aln.reference_start is None or aln.reference_end is None:
                    continue
                # Extract aligned blocks (exon-level)
                blocks = aln.get_blocks()  # list of (start, end) 0-based half-open
                strand = "-" if aln.is_reverse else "+"
                reads.append({
                    "name": aln.query_name or "",
                    "start": aln.reference_start,
                    "end": aln.reference_end,
                    "strand": strand,
                    "blocks": [[b[0], b[1]] for b in blocks],
                    "mapq": aln.mapping_quality or 0,
                })
                if len(reads) >= max_reads:
                    break
            bam.close()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"BAM query error: {e}")

        if collapse:
            models = _collapse_long_reads(reads)
        else:
            models = reads

        return {
            "level": level,
            "start": start,
            "end": end,
            "reads": models,
            "collapsed": collapse,
            "total_input_reads": len(reads),
        }

    return await run_in_threadpool(_run)


# ── BigWig batch / overview endpoint ─────────────────────────────────────────

class BigWigBatchTile(BaseModel):
    start: int
    end: int
    bins: int


class BigWigBatchRequest(BaseModel):
    path: str
    chrom: str
    genome: str = "reference"
    tiles: List[BigWigBatchTile]


@app.post("/api/browse/bigwig_batch")
async def browse_bigwig_batch(payload: BigWigBatchRequest):
    """
    Fetch multiple BigWig tiles in one request to reduce HTTP round-trips.
    Returns a list of tile results in the same order as requested.
    """
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigWig support is unavailable. Install pyBigWig.")

    path = str(payload.path or "").strip()
    chrom = str(payload.chrom or "").strip()
    genome = str(payload.genome or "reference").strip() or "reference"
    if not path:
        raise HTTPException(status_code=400, detail="path is required.")
    if not chrom:
        raise HTTPException(status_code=400, detail="chrom is required.")

    await run_in_threadpool(genome_context._get_browse_db, genome)
    p = Path(path).expanduser()
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig not found: {p}")

    requested_chrom_len: Optional[int] = None
    try:
        fasta = genome_context._get_browse_fasta(genome)
        requested_chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        requested_chrom_len = None

    def _run():
        try:
            bw = pyBigWig.open(str(p))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigWig: {e}")
        if bw is None:
            raise HTTPException(status_code=400, detail="Failed to open BigWig file.")

        try:
            chrom_sizes = bw.chroms() or {}
            resolved_chrom = _resolve_bigwig_chrom_name(
                chrom,
                chrom_sizes,
                requested_chrom_len=requested_chrom_len,
            )
            results = []
            for tile in payload.tiles:
                tile_bins = max(20, min(4000, int(tile.bins)))
                if resolved_chrom is None:
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [None] * tile_bins,
                        "min": None,
                        "max": None,
                    })
                    continue
                chrom_len = int(chrom_sizes.get(resolved_chrom, 0))
                s = max(0, int(tile.start))
                e = min(chrom_len, int(tile.end)) if chrom_len > 0 else int(tile.end)
                if e <= s or int(tile.end) <= int(tile.start):
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [None] * tile_bins,
                        "min": None,
                        "max": None,
                    })
                    continue
                try:
                    bins = _bigwig_binned_means(
                        bw, resolved_chrom, int(tile.start), int(tile.end), tile_bins, chrom_len,
                    )
                    valid = [value for value in bins if value is not None]
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": bool(valid),
                        "bins": bins,
                        "min": min(valid) if valid else None,
                        "max": max(valid) if valid else None,
                    })
                except Exception as e2:
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [],
                        "error": str(e2),
                    })
            return {
                "path": str(p),
                "chrom": chrom,
                "resolved_chrom": resolved_chrom,
                "tiles": results,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)


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
