"""
Ensembl Go Backend - FastAPI server for pairwise alignment visualization.
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
import copy
import csv
import shutil
import subprocess
import sys
import tempfile
import sqlite3
import time
import threading
import uuid
import queue
from collections import Counter, OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from urllib.parse import urlparse, quote, unquote, urlencode, urlunparse
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, IO, Set
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

import pysam
import requests
from Bio.Seq import Seq
import asyncio

try:
    import fcntl  # Unix/macOS cross-process file locking
except ImportError:  # pragma: no cover - unavailable on Windows
    fcntl = None

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

from download_manager import DownloadManager, SpeciesSummary, FileInfo, DownloadTask, GroupCount
from assembly_report import (
    KnownRegions,
    build_synonym_index,
    chrom_token_variants,
    load_assembly_synonym_rows,
    parse_assembly_report_file,
    resolve_region_name,
)
import tutorial_authoring
import tutorial_packages
import tutorial_datasets
from demo_genome import (
    TUTORIAL_WORKSPACE_DIR,
    clear_tutorial_session_genome,
    demo_index_target,
    demo_install_status,
    demo_install_statuses,
    install_demo_genome,
    install_demo_source_files,
    reset_tutorial_workspace,
    set_tutorial_session_genome,
    tutorial_session_species,
    tutorial_session_workspace,
    tutorial_workspace,
)
from genome_identity import (
    DEFAULT_PROVIDER,
    NCBI_PROVIDER,
    annotation_name_stem,
    genome_key as build_provider_aware_genome_key,
    genome_key_candidates,
    genome_manifest_filename,
    infer_source_database,
    is_assembly_report_filename,
    is_metadata_filename,
    is_sequence_report_filename,
    iter_local_assembly_dirs,
    legacy_genome_key,
    normalize_provider,
    normalize_source_database,
    parse_genome_key,
    parse_local_data_relative_parts,
    selection_key as build_dataset_selection_key,
    selection_key_from_record,
    strip_dataset_release_from_selection_key,
    storage_path_parts,
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
    save_stats_cache,
)
from trackhub_registry import list_tracks_for_genomes
from annotation import (
    CooperativeYielder,
    IdentifierError,
    build_annotation_report,
    convert_annotation,
    normalize_prefix as annotation_normalize_prefix,
    prepare_annotation,
    scan_fasta,
    sniff_annotation,
)
from manual_genome_config import (
    parse_manual_genome_config,
    save_manual_genome_config,
)
import notes_transfer
import protein_structure
import removal_rules
from translation import (
    MOLECULE_NUCLEAR,
    TABLE_STANDARD,
    TranslationLayout,
    autodetect_organelle_table,
    build_translation_layout,
    classify_contig_molecule,
    translate_cds_dna,
    translation_table_for_lineage,
)
from sv_config import (
    CONFIG_VERSION_KEY as SV_CONFIG_VERSION_KEY,
    config_to_datasets as sv_config_to_datasets,
    config_to_document as sv_config_to_document,
    derive_sequence_map as sv_derive_sequence_map,
    has_errors as sv_config_has_errors,
    locate_pointer_lines as sv_locate_pointer_lines,
    merge_sv_config,
    parse_sv_config,
    remove_alignment as sv_remove_alignment,
    serialize_sv_config,
)
from security_utils import (
    get_with_validated_redirects,
    normalize_trackhub_data_url,
    validate_annotation_service_url,
    require_loopback_client,
    require_path_within,
    safe_export_filename,
    safe_url_basename,
    sanitize_leaf_filename,
    validate_backend_bind_host,
    validate_config_export_path,
    validate_remote_download_url,
    validate_trackhub_data_url,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

def log_progress(msg: str):
    """Print progress message with flush for immediate output."""
    print(f"[PROGRESS] {msg}", flush=True)


def open_maybe_gz(filepath, mode: str = 'r') -> IO:
    """Open a file, transparently handling gzip compression.

    Detects gzip/BGZF by extension (.gz/.bgz) and opens accordingly.
    Works for both compressed and uncompressed files.
    Accepts both str and Path objects.
    """
    filepath = str(filepath)
    is_text = 'b' not in mode
    if filepath.endswith(('.gz', '.bgz')):
        gz_mode = mode if ('t' in mode or 'b' in mode) else mode + 't'
        return gzip.open(filepath, gz_mode, encoding='utf-8' if is_text else None)
    return open(filepath, mode, encoding='utf-8' if is_text else None)


def _is_bgzipped(filepath: str) -> bool:
    """Check if a file is bgzip-compressed (not plain gzip)."""
    try:
        with open(filepath, 'rb') as f:
            header = f.read(4)
            # bgzip files start with the gzip magic bytes 1f 8b,
            # followed by 08 (deflate) and 04 (FEXTRA flag set)
            return header[:4] == b'\x1f\x8b\x08\x04'
    except Exception:
        return False


def ensure_fasta_index(fasta_path: str, force_reindex: bool = False) -> str:
    """Ensure a FASTA file is indexed for pysam access.

    Handles plain FASTA, bgzipped (.fa.gz), and regular gzipped (.fa.gz) files.
    Regular gzip files are decompressed to plain FASTA since pysam requires
    either plain or bgzip format.
    Returns the path to use with pysam.FastaFile().
    """
    # If the file is gzipped but NOT bgzipped, decompress it first
    if fasta_path.endswith('.gz') and not _is_bgzipped(fasta_path):
        plain_path = fasta_path[:-3]  # Remove .gz extension
        if not os.path.exists(plain_path):
            log_progress(f"Decompressing {Path(fasta_path).name} (gzip → plain FASTA for indexing)...")
            try:
                with gzip.open(fasta_path, 'rb') as gz_in, open(plain_path, 'wb') as f_out:
                    while True:
                        chunk = gz_in.read(1024 * 1024 * 16)  # 16MB chunks
                        if not chunk:
                            break
                        f_out.write(chunk)
                log_progress(f"  ✓ Decompressed to {Path(plain_path).name}")
            except Exception as e:
                # Clean up partial file on failure
                if os.path.exists(plain_path):
                    os.remove(plain_path)
                logger.error(f"Failed to decompress FASTA {fasta_path}: {e}")
                raise
        fasta_path = plain_path

    fai_path = fasta_path + '.fai'
    if force_reindex and os.path.exists(fai_path):
        try:
            os.remove(fai_path)
        except Exception:
            pass
    if not os.path.exists(fai_path):
        log_progress(f"Creating FASTA index for {Path(fasta_path).name}...")
        try:
            pysam.faidx(fasta_path)
            log_progress("  ✓ FASTA index created")
        except Exception as e:
            logger.error(f"Failed to index FASTA {fasta_path}: {e}")
            raise
    return fasta_path


class ThreadSafeFasta:
    """Serialises access to a ``pysam.FastaFile``.

    htslib keeps seek and block-decompression state on the handle, so two threads
    fetching from the same ``FastaFile`` corrupt each other. htslib then reports
    ``Failed to retrieve block. (Seeking in a compressed, .gzi unindexed, file?)``
    and the fetch either raises or hands back the wrong bases — which surfaces as
    a blank sequence track, or as runs of N and protein X in Feature Explorer.

    Handles are cached per genome and every browse endpoint runs on a threadpool,
    so sharing one unguarded handle is exactly the situation that triggers it.

    A lock rather than one handle per thread: the ``.fai`` of a fragmented
    assembly can hold hundreds of thousands of records, and a handle per worker
    thread would multiply that resident cost.
    """

    __slots__ = ("_fasta", "_lock")

    def __init__(self, fasta):
        self._fasta = fasta
        self._lock = threading.Lock()

    def fetch(self, *args, **kwargs):
        with self._lock:
            return self._fasta.fetch(*args, **kwargs)

    def get_reference_length(self, *args, **kwargs):
        with self._lock:
            return self._fasta.get_reference_length(*args, **kwargs)

    @property
    def references(self):
        with self._lock:
            return self._fasta.references

    @property
    def lengths(self):
        with self._lock:
            return self._fasta.lengths

    def close(self):
        with self._lock:
            self._fasta.close()

    def __getattr__(self, name):
        # Anything not wrapped explicitly still reads under the lock.
        with self._lock:
            return getattr(self._fasta, name)


def open_indexed_fasta(fasta_path: str, force_reindex: bool = False) -> ThreadSafeFasta:
    """Index a FASTA if needed and open it for safe concurrent reads."""
    indexed_path = ensure_fasta_index(fasta_path, force_reindex=force_reindex)
    return ThreadSafeFasta(pysam.FastaFile(indexed_path))


# Configuration
def get_base_path():
    """Get the base path for bundled resources (data files etc), handling PyInstaller."""
    if getattr(sys, 'frozen', False):
        # Running as PyInstaller bundle — _MEIPASS has bundled data files
        return Path(sys._MEIPASS)
    else:
        # Running as script
        return Path(__file__).parent

def get_cache_dir():
    """Get a persistent, writable cache directory.

    In dev mode: <backend_dir>/cache
    In packaged mode: ~/Library/Application Support/Ensembl Go/cache (macOS)
                      %LOCALAPPDATA%/Ensembl Go/cache (Windows)
                      or ~/.ensembl_go/cache (other platforms)
    """
    user_data_override = (
        os.environ.get("ENSEMBL_GO_USER_DATA_DIR")
        or os.environ.get("ENSEMBL_LOCAL_USER_DATA_DIR")
        or ""
    ).strip()
    if user_data_override:
        cache = Path(user_data_override).expanduser().resolve() / "cache"
    elif getattr(sys, 'frozen', False):
        # Packaged app — use a stable user-writable location
        if sys.platform == 'darwin':
            app_data = Path.home() / "Library" / "Application Support" / "Ensembl Go"
        elif sys.platform == 'win32':
            local_app_data = os.environ.get("LOCALAPPDATA")
            app_data = Path(local_app_data) / "Ensembl Go" if local_app_data else Path.home() / "AppData" / "Local" / "Ensembl Go"
        else:
            app_data = Path.home() / ".ensembl_go"
        cache = app_data / "cache"
    else:
        # Dev mode — use <backend_dir>/cache as before
        cache = Path(__file__).parent / "cache"
    cache.mkdir(exist_ok=True, parents=True)
    return cache

BASE_PATH = get_base_path()
CACHE_DIR = get_cache_dir()

# MAFFT Path handling
def find_mafft() -> Tuple[str, Dict[str, str]]:
    env_overrides: Dict[str, str] = {}
    executable_names = ["mafft"]
    if sys.platform == "win32":
        executable_names = ["mafft.bat", "mafft.exe", "mafft.cmd", "mafft"]

    # Electron passes explicit bundled MAFFT locations in packaged builds.
    env_mafft_path = os.environ.get("ENSEMBL_LOCAL_MAFFT_PATH")
    env_mafft_binaries = os.environ.get("ENSEMBL_LOCAL_MAFFT_BINARIES")
    if env_mafft_binaries:
        env_overrides["MAFFT_BINARIES"] = env_mafft_binaries
    if env_mafft_path and os.path.exists(env_mafft_path):
        return env_mafft_path, env_overrides

    candidates = []

    if getattr(sys, 'frozen', False):
        exe_dir = Path(sys.executable).resolve().parent
        for executable_name in executable_names:
            candidates.extend([
                str(exe_dir / "mafft_bin" / "bin" / executable_name),
                str(exe_dir / "mafft" / "bin" / executable_name),
                str(BASE_PATH / executable_name),
            ])

        bundled_binaries = [
            str(exe_dir / "mafft_bin" / "libexec" / "mafft"),
            str(exe_dir / "mafft" / "libexec" / "mafft"),
        ]
        for binaries in bundled_binaries:
            if os.path.isdir(binaries):
                env_overrides["MAFFT_BINARIES"] = binaries
                break

    candidates.extend([
        "/opt/homebrew/bin/mafft",
        "/usr/local/bin/mafft",
    ])
    candidates.extend(executable_names)

    for path in candidates:
        try:
            if os.path.isabs(path) or os.path.sep in path or (os.path.altsep and os.path.altsep in path):
                if os.path.exists(path):
                    return path, env_overrides
                continue
            resolved = shutil.which(path)
            if resolved:
                return resolved, env_overrides
        except Exception:
            continue

    return ("mafft.exe" if sys.platform == "win32" else "mafft"), env_overrides


def _mafft_missing_error() -> RuntimeError:
    return RuntimeError(
        "MAFFT executable was not found. Install MAFFT on this machine or bundle it into the packaged app."
    )


MAFFT_PATH, MAFFT_ENV = find_mafft()

# Default test data paths (relative to project root)
# When running as standalone app, we generally expect files to be provided or selected via UI.
# However, we bundle cluster_test_data for the default example.
# Default test data paths (relative to project root)
if getattr(sys, 'frozen', False):
    # Running as frozen bundle — data files are inside _MEIPASS
    PROJECT_ROOT = BASE_PATH
else:
    # Running from source
    PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Initialize Download Manager
def _resolve_species_json_path() -> Path:
    env_path = os.environ.get("ENSEMBL_LOCAL_SPECIES_JSON")
    if env_path:
        p = Path(env_path).expanduser()
        if p.exists():
            return p

    # Distributions do not bundle a species catalogue; it is downloaded from Ensembl on
    # first run (see DownloadManager.ensure_catalog_available). These paths only serve
    # development and offline use, where a catalogue can be placed in the repository or
    # pointed at with ENSEMBL_LOCAL_SPECIES_JSON.
    candidates = [
        BASE_PATH / "cluster_test_data" / "species.new_ftp_structure.json",
        BASE_PATH / "cluster_test_data" / "species.json",
        PROJECT_ROOT / "cluster_test_data" / "species.new_ftp_structure.json",
        PROJECT_ROOT / "cluster_test_data" / "species.json",
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]


SPECIES_JSON_PATH = _resolve_species_json_path()
download_manager = DownloadManager(SPECIES_JSON_PATH, cache_dir=CACHE_DIR)

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Start the catalogue download as soon as the server is up, so it is already under
    # way — usually finished — before the user opens the download view. Non-blocking:
    # the fetch runs on a background thread and startup continues immediately.
    try:
        download_manager.ensure_catalog_available()
    except Exception:
        logger.exception("Failed to start the initial species catalogue fetch")
    yield


app = FastAPI(title="Ensembl Go API", lifespan=_lifespan)

from alignment_explorer import create_router as create_alignment_explorer_router
app.include_router(create_alignment_explorer_router(annotation_provider=lambda *args: alignment_explorer_annotation_features(*args)))
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

_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_ENSEMBL_HOST = "ftp.ebi.ac.uk"
_ENSEMBL_PATH_PREFIX = "/pub/ensemblorganisms/"
_NCBI_FTP_HOST = "ftp.ncbi.nlm.nih.gov"
_NCBI_API_HOST = "api.ncbi.nlm.nih.gov"
_NCBI_ASSEMBLY_REPORT_RE = re.compile(
    r"^/genomes/all/GCA/(?:\d{3}/)+GCA_\d+\.\d+_[^/]+/GCA_\d+\.\d+_[^/]+_assembly_report\.txt$"
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


def _validate_path_segment(name: str, value: str) -> str:
    value = (value or "").strip()
    if not value or value in {".", ".."} or not _SAFE_SEGMENT_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {name}: {value!r}")
    return value


def _resolve_local_data_root(output_dir: str) -> Path:
    output_root = Path(output_dir).expanduser().resolve()
    local_data = output_root / "local_data"
    if local_data.exists() and local_data.is_symlink():
        raise HTTPException(status_code=400, detail="local_data may not be a symlink")
    return local_data.resolve()


def _resolve_species_assembly_dir(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
) -> Path:
    root = _resolve_local_data_root(output_dir)
    safe_species = _validate_path_segment("species_key", species_key)
    safe_assembly = _validate_path_segment("assembly", assembly)
    candidate = root
    normalized_provider = normalize_provider(provider)
    for segment in storage_path_parts(normalized_provider, safe_species, safe_assembly):
        candidate = candidate / _validate_path_segment("path segment", segment)
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid species/assembly path")
    return candidate


def _validate_download_url(url: str) -> str:
    return validate_remote_download_url(url)


def _is_assembly_report_filename(filename: str) -> bool:
    return is_assembly_report_filename(filename)


def _is_metadata_filename(filename: str) -> bool:
    return is_metadata_filename(filename)


def _find_assembly_report_file(assembly_dir: Path) -> Optional[Path]:
    if not assembly_dir or not assembly_dir.is_dir():
        return None
    candidates = sorted(
        [p for p in assembly_dir.iterdir() if p.is_file() and _is_metadata_filename(p.name)],
        key=lambda p: p.name,
    )
    return candidates[0] if candidates else None
    return url


def _sanitize_filename(filename: str) -> str:
    return sanitize_leaf_filename(filename)


def _resolve_allowed_homology_path(path_value: str) -> Path:
    """Resolve and validate a homology table path from configured local data."""
    candidate = Path(path_value).expanduser().resolve()
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Homology file not found: {candidate}")

    name = candidate.name.lower()
    if not (name.endswith(".tsv") or name.endswith(".tsv.gz")):
        raise HTTPException(status_code=400, detail="Homology file must be .tsv or .tsv.gz")

    cfg = load_config()
    allowed_files = set()

    cfg_homology = (cfg.get("homologies_file") or "").strip()
    if cfg_homology:
        try:
            allowed_files.add(Path(cfg_homology).expanduser().resolve())
        except Exception:
            pass

    for species in (cfg.get("active_species") or []):
        h_path = (species.get("files") or {}).get("homology")
        if h_path:
            try:
                allowed_files.add(Path(h_path).expanduser().resolve())
            except Exception:
                continue

    if candidate in allowed_files:
        return candidate

    output_dir = (cfg.get("output_dir") or "").strip()
    if output_dir:
        try:
            local_root = _resolve_local_data_root(output_dir)
            candidate.relative_to(local_root)
            return candidate
        except Exception:
            pass

    raise HTTPException(status_code=400, detail="Homology path is not part of configured local genomes")


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


class GeneSummary(BaseModel):
    id: str
    name: Optional[str] = None
    chrom: str
    start: int
    end: int
    strand: str
    biotype: str = ""
    is_focal: bool = False  # True if this is the query gene


class HomologyLink(BaseModel):
    ref_gene_id: str
    target_gene_id: str
    homology_type: str = ""
    is_rbh: bool = False
    perc_id: Optional[float] = None
    perc_cov: Optional[float] = None


class NeighbourhoodResponse(BaseModel):
    reference_genes: List[GeneSummary]
    target_genes: List[GeneSummary]
    center_ref_id: Optional[str]
    center_target_id: Optional[str]
    homologies: List[Tuple[str, str]] = []  # List of (source_id, target_id) pairs
    homology_links: List[HomologyLink] = []  # Real Compara homology TSV-derived links (only when use_homology=true)
    ref_homology_available: bool = False
    target_homology_available: bool = False
    request_transcript_id: Optional[str] = None
    request_target_transcript_id: Optional[str] = None
    request_ref_gene_id: Optional[str] = None
    request_target_gene_id: Optional[str] = None


class IndexRequest(BaseModel):
    generate: bool = True
    output_dir: Optional[str] = None
    ref_gff: Optional[str] = None
    target_gff: Optional[str] = None


# ============ Lightweight GFF3 Parser ============

@dataclass
class SimpleFeature:
    """Generic genomic feature."""
    feature_type: str  # exon, CDS, five_prime_UTR, three_prime_UTR
    start: int
    end: int
    strand: str
    phase: Optional[int] = None

@dataclass
class SimpleTranscript:
    feature_id: str
    seq_region: str
    start: int
    end: int
    strand: str
    exons: List[SimpleFeature]
    cds_list: List[SimpleFeature]
    utrs: List[SimpleFeature]
    biotype: str = ""


def find_transcript_fast(gff_path: str, transcript_id: str) -> Optional[SimpleTranscript]:
    """Use grep to quickly find a transcript in a GFF3 file."""
    
    # Normalize ID for searching
    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    
    log_progress(f"  Searching for {search_id} in {Path(gff_path).name}...")

    # Use grep to find matching lines. The ID is a literal, so -F matches it as a
    # fixed string rather than a regex, and "--" keeps an ID that starts with "-"
    # from being parsed as a grep option.
    try:
        result = subprocess.run(
            ["grep", "-F", "--", search_id, gff_path],
            capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired:
        log_progress(f"  ✗ Grep timeout")
        return None
    
    if result.returncode != 0 or not result.stdout.strip():
        log_progress(f"  ✗ Not found")
        return None
    
    lines = result.stdout.strip().split('\n')
    
    # Parse the lines
    transcript_line = None
    exon_lines = []
    cds_lines = []
    utr_lines = []
    
    # Feature types that represent transcripts
    transcript_types = {'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA', 
                        'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
                        'processed_transcript', 'unconfirmed_transcript'}
    
    for line in lines:
        if line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) < 9:
            continue
        
        feature_type = parts[2]
        attrs = parts[8]
        
        # Check if this is our transcript - check multiple ways
        if feature_type in transcript_types:
            # Method 1: Check ID attribute
            id_match = re.search(r'ID=([^;]+)', attrs)
            if id_match:
                line_id = id_match.group(1).replace("transcript:", "").replace("mapped_transcript:", "")
                if line_id == search_id:
                    transcript_line = parts
                    continue
            
            # Method 2: Check transcript_id attribute (used in mapped files)
            tx_id_match = re.search(r'transcript_id=([^;]+)', attrs)
            if tx_id_match:
                tx_id = tx_id_match.group(1)
                if tx_id == search_id:
                    transcript_line = parts
                    continue
        
        # Check Parent for child features (exon, CDS, UTR)
        parent_match = re.search(r'Parent=([^;]+)', attrs)
        if parent_match:
            parent_id = parent_match.group(1).replace("mapped_transcript:", "").replace("transcript:", "")
            if parent_id == search_id:
                if feature_type == 'exon':
                    exon_lines.append(parts)
                elif feature_type == 'CDS':
                    cds_lines.append(parts)
                elif feature_type in ('five_prime_UTR', 'three_prime_UTR'):
                    utr_lines.append((feature_type, parts))
    
    if not transcript_line:
        log_progress(f"  ✗ Transcript line not found")
        return None
    
    # Build transcript object
    chrom = transcript_line[0]
    start = int(transcript_line[3])
    end = int(transcript_line[4])
    strand = transcript_line[6]
    
    # Parse biotype from attributes
    biotype = ""
    biotype_match = re.search(r'biotype=([^;]+)', transcript_line[8])
    if biotype_match:
        biotype = biotype_match.group(1)
    
    # Build exons
    exons = []
    for exon_parts in exon_lines:
        exons.append(SimpleFeature(
            feature_type="exon",
            start=int(exon_parts[3]),
            end=int(exon_parts[4]),
            strand=exon_parts[6]
        ))
    exons.sort(key=lambda e: e.start)
    
    # Build CDS
    cds_list = []
    for cds_parts in cds_lines:
        phase_raw = str(cds_parts[7]).strip() if len(cds_parts) > 7 else "."
        phase_value: Optional[int] = None
        if phase_raw in {"0", "1", "2"}:
            phase_value = int(phase_raw)
        cds_list.append(SimpleFeature(
            feature_type="CDS",
            start=int(cds_parts[3]),
            end=int(cds_parts[4]),
            strand=cds_parts[6],
            phase=phase_value,
        ))
    cds_list.sort(key=lambda c: c.start)
    
    # Build UTRs
    utrs = []
    for utr_type, utr_parts in utr_lines:
        utrs.append(SimpleFeature(
            feature_type=utr_type,
            start=int(utr_parts[3]),
            end=int(utr_parts[4]),
            strand=utr_parts[6]
        ))
    
    log_progress(f"  ✓ Found: {chrom}:{start}-{end} ({strand}) with {len(exons)} exons, {len(cds_list)} CDS, {len(utrs)} UTRs")
    
    return SimpleTranscript(
        feature_id=search_id,
        seq_region=chrom,
        start=start,
        end=end,
        strand=strand,
        exons=exons,
        cds_list=cds_list,
        utrs=utrs,
        biotype=biotype
    )


def find_transcript_in_index(db_path: str, transcript_id: str) -> Optional[SimpleTranscript]:
    """Look up transcript in SQLite index."""
    if not db_path or not os.path.exists(db_path):
        return None
        
    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT data FROM transcripts WHERE id=?", (search_id,))
        row = c.fetchone()
        conn.close()
        
        if row:
            data = json.loads(row[0])
            # Reconstruct SimpleTranscript
            exons = [SimpleFeature(**x) for x in data['exons']]
            cds_list = [SimpleFeature(**x) for x in data['cds_list']]
            utrs = [SimpleFeature(**x) for x in data['utrs']]
            
            return SimpleTranscript(
                feature_id=data['feature_id'],
                seq_region=data['seq_region'],
                start=data['start'],
                end=data['end'],
                strand=data['strand'],
                exons=exons,
                cds_list=cds_list,
                utrs=utrs,
                biotype=data.get('biotype', '')
            )
    except Exception as e:
        logger.error(f"Index lookup failed: {e}")
        
    return None


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
            log_progress(f"Loading reference FASTA: {Path(ref_fasta).name}")
            self.ref_fasta = open_indexed_fasta(ref_fasta)
            self.ref_fasta_path = ref_fasta
            log_progress("  ✓ Reference FASTA loaded")

        if self.target_fasta_path != target_fasta:
            log_progress(f"Loading target FASTA: {Path(target_fasta).name}")
            self.target_fasta = open_indexed_fasta(target_fasta)
            self.target_fasta_path = target_fasta
            log_progress("  ✓ Target FASTA loaded")


genome_data = GenomeData()
recent_transcripts: List[RecentItem] = []


# ============ Homology Map ============

class HomologyMap:
    """Parse and cache a homology TSV file for bidirectional transcript lookup.
    
    TSV format: ref_transcript_id<TAB>target_id_1<TAB>target_id_2<TAB>...
    Each row maps one reference transcript to 1..N target transcripts.
    """
    def __init__(self):
        self._file_path: Optional[str] = None
        self.ref_to_targets: Dict[str, List[str]] = {}  # ref_id -> [target_ids]
        self.target_to_ref: Dict[str, str] = {}          # target_id -> ref_id
    
    def load(self, file_path: str):
        """Load/reload the homology TSV if the path has changed."""
        if not file_path:
            self._file_path = None
            self.ref_to_targets = {}
            self.target_to_ref = {}
            return

        if self._file_path == file_path and len(self.ref_to_targets) > 0:
            return  # Already loaded

        log_progress(f"Loading homology map: {Path(file_path).name}")
        self.ref_to_targets = {}
        self.target_to_ref = {}
        
        try:
            with open_maybe_gz(file_path, 'r') as f:
                for line in f:
                    if line.startswith('#'): continue
                    parts = line.strip().split('\t')
                    if len(parts) < 2:
                        continue

                    ref_id = parts[0].strip()
                    target_ids = [t.strip() for t in parts[1:] if t.strip()]

                    if ref_id and target_ids:
                        self.ref_to_targets[ref_id] = target_ids
                        for tid in target_ids:
                            self.target_to_ref[tid] = ref_id

            self._file_path = file_path
            log_progress(f"  ✓ Loaded {len(self.ref_to_targets)} reference entries")

        except Exception as e:
            logger.error(f"Failed to load homology file: {e}")
            self._file_path = None
    
    def lookup(self, transcript_id: str) -> dict:
        """Look up a transcript ID in both directions.
        
        Returns dict with: query_id, ref_id, target_ids, source ('reference'|'target'|None)
        """
        # Check if it's a reference ID
        if transcript_id in self.ref_to_targets:
            return {
                "query_id": transcript_id,
                "ref_id": transcript_id,
                "target_ids": self.ref_to_targets[transcript_id],
                "source": "reference"
            }
        
        # Check if it's a target ID
        if transcript_id in self.target_to_ref:
            ref_id = self.target_to_ref[transcript_id]
            return {
                "query_id": transcript_id,
                "ref_id": ref_id,
                "target_ids": self.ref_to_targets.get(ref_id, []),
                "source": "target"
            }
        
        # Not found in homology map
        return {
            "query_id": transcript_id,
            "ref_id": None,
            "target_ids": [],
            "source": None
        }
    
    @property
    def is_loaded(self) -> bool:
        return self._file_path is not None and len(self.ref_to_targets) > 0


homology_map = HomologyMap()

_MAX_HOMOLOGY_FILE_INDEXES = 6


class HomologyFileIndex:
    """Parse and cache per-genome Ensembl Compara homology TSVs, indexed by
    the file's own gene IDs for fast lookups against a neighbourhood window.

    Each genome's homology TSV lists, for every gene in that genome
    (the constant `query_*` columns), its homologous genes in every other
    compared genome (the per-row `ref_*` columns). Parsing a full file is
    too slow to repeat per request (whole-genome files can be 700k+ rows),
    so each file is indexed once and cached until its mtime/size changes,
    with an LRU cap since a session may touch several genomes' files.
    """

    def __init__(self, max_entries: int = _MAX_HOMOLOGY_FILE_INDEXES):
        self._max_entries = max_entries
        self._cache: "OrderedDict[str, Tuple[Tuple[float, int], Dict[str, List[Dict[str, str]]]]]" = OrderedDict()
        self._lock = threading.Lock()

    def _load(self, file_path: str) -> Dict[str, List[Dict[str, str]]]:
        index: Dict[str, List[Dict[str, str]]] = {}
        with open_maybe_gz(file_path, 'rt') as f:
            reader = csv.DictReader(f, delimiter='\t')
            for row in reader:
                query_id = (row.get('query_gene_stable_id') or '').strip()
                if not query_id:
                    continue
                index.setdefault(query_id, []).append({
                    'ref_gene_stable_id': (row.get('ref_gene_stable_id') or '').strip(),
                    'ref_gene_name': (row.get('ref_gene_name') or '').strip(),
                    'ref_species': (row.get('ref_species') or '').strip(),
                    'ref_assembly': (row.get('ref_assembly') or '').strip(),
                    'homology_type': (row.get('homology_type') or '').strip(),
                    'query_perc_id': row.get('query_perc_id') or '',
                    'query_perc_cov': row.get('query_perc_cov') or '',
                })
        return index

    def _get_index(self, file_path: str) -> Dict[str, List[Dict[str, str]]]:
        resolved = str(Path(file_path).expanduser().resolve())
        try:
            stat = os.stat(resolved)
            fingerprint = (stat.st_mtime, stat.st_size)
        except OSError:
            return {}

        with self._lock:
            cached = self._cache.get(resolved)
            if cached and cached[0] == fingerprint:
                self._cache.move_to_end(resolved)
                return cached[1]

        log_progress(f"Indexing homology file: {Path(resolved).name}")
        index = self._load(resolved)

        with self._lock:
            self._cache[resolved] = (fingerprint, index)
            self._cache.move_to_end(resolved)
            while len(self._cache) > self._max_entries:
                self._cache.popitem(last=False)
        log_progress(f"  ✓ Indexed {len(index)} genes from {Path(resolved).name}")
        return index

    def find_homology_pairs(
        self,
        file_path: str,
        query_gene_ids: Set[str],
        other_assembly_name: str,
    ) -> List[Dict[str, str]]:
        """Return homology rows from `file_path` for genes in `query_gene_ids`
        whose `ref_assembly` matches `other_assembly_name` (case-insensitive).

        Must be called from a threadpool — a cold parse can take ~1-2s for a
        large genome's file.
        """
        if not file_path or not query_gene_ids:
            return []
        target_assembly = str(other_assembly_name or '').strip().lower()
        if not target_assembly:
            return []
        index = self._get_index(file_path)
        if not index:
            return []
        out: List[Dict[str, str]] = []
        for gene_id in query_gene_ids:
            rows = index.get(gene_id)
            if not rows:
                continue
            for row in rows:
                if row['ref_assembly'].strip().lower() != target_assembly:
                    continue
                out.append({'query_gene_id': gene_id, **row})
        return out


homology_file_index = HomologyFileIndex()


def _parse_optional_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _homology_row_score(row: Dict[str, str]) -> Tuple[int, float]:
    """Rank a homology row: reciprocal-best-hit first, then by identity/coverage."""
    is_rbh = str(row.get("homology_type", "")).strip().lower() == "homolog_rbbh"
    perc_id = _parse_optional_float(row.get("query_perc_id")) or 0.0
    perc_cov = _parse_optional_float(row.get("query_perc_cov")) or 0.0
    return (1 if is_rbh else 0, (perc_id * 0.6) + (perc_cov * 0.4))

# In-memory cache for neighbourhood results. Keyed by (ref_gene_id, target_gene_id, window_size).
# Neighbourhoods are stable data so a 10-minute TTL is safe.
_neighbourhood_cache: dict = {}
_NEIGHBOURHOOD_CACHE_TTL = 600  # seconds

# Serialize GFF index builds per database path to prevent concurrent writers
# from clobbering the same SQLite file.
_index_build_locks_guard = threading.Lock()
_index_build_locks: Dict[str, threading.Lock] = {}
# The parser retains transcript models while indexing and is deliberately
# memory-heavy. Limit full rebuilds to one per backend process; normal reads of
# existing indexes do not acquire this semaphore.
_index_rebuild_guard = threading.Semaphore(1)

# In-memory task registry for background structural stats generation.
_stats_tasks_guard = threading.Lock()
_stats_tasks: Dict[str, Dict[str, Any]] = {}

# In-memory task registry for background GFF index builds.
_index_tasks_guard = threading.Lock()
_index_tasks: Dict[str, Dict[str, Any]] = {}  # task_id -> {status, index_path, error}
_index_task_queue: "queue.Queue[Tuple[str, str, str]]" = queue.Queue()
_index_worker_guard = threading.Lock()
_index_worker_started = False

# In-memory task registry for custom genome/annotation validation scans. These
# read whole files, so they run on the same queued-worker pattern as indexing
# rather than blocking a request.
_validation_tasks_guard = threading.Lock()
_validation_tasks: Dict[str, Dict[str, Any]] = {}
_validation_task_queue: "queue.Queue[Tuple[str, Dict[str, Any]]]" = queue.Queue()
_validation_worker_guard = threading.Lock()
_validation_worker_started = False
#: Completed validation results are small; keep a bounded history so the UI can
#: re-open a report without re-scanning.
_VALIDATION_TASK_LIMIT = 50

_STATS_DEFAULT_SECTIONS = ["annotation", "structural", "homology", "assembly"]
_STATS_ANNOTATION_DEPS = ("gff3", "index")
_STATS_STRUCTURAL_DEPS = ("gff3", "index", "fasta")
_STATS_HOMOLOGY_DEPS = ("homology",)
_STATS_ASSEMBLY_DEPS = ("fasta",)
GFF_INDEX_FORMAT_VERSION = "6"
# Version 6 changes how child-before-parent GFF records are populated, but not
# the SQLite schema. Version 5 indexes therefore remain safe to read and must
# not trigger a destructive, multi-genome rebuild during application startup.
GFF_INDEX_COMPATIBLE_VERSIONS = frozenset({"5", GFF_INDEX_FORMAT_VERSION})
_ENA_METADATA_CACHE_PATH = CACHE_DIR / "ena_metadata_cache.json"

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


# ============ SQLite Indexing ============

def _normalize_fs_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _get_index_build_lock(db_path: str) -> threading.Lock:
    normalized = _normalize_fs_path(db_path)
    with _index_build_locks_guard:
        lock = _index_build_locks.get(normalized)
        if lock is None:
            lock = threading.Lock()
            _index_build_locks[normalized] = lock
        return lock


def _is_existing_index_usable(db_path: str, gff_path: str) -> bool:
    """Return True when an existing SQLite index is readable and compatible.

    Old indexes without metadata are accepted if core tables are present.
    """
    normalized_db = _normalize_fs_path(db_path)
    normalized_gff = _normalize_fs_path(gff_path)
    if not normalized_db or not os.path.exists(normalized_db):
        return False

    conn = None
    try:
        conn = sqlite3.connect(f"file:{normalized_db}?mode=ro", uri=True, timeout=5)
        c = conn.cursor()
        c.execute("""
            SELECT name
            FROM sqlite_master
            WHERE type='table' AND name IN ('genes', 'transcripts')
        """)
        table_names = {row[0] for row in c.fetchall()}
        if "genes" not in table_names or "transcripts" not in table_names:
            return False

        source_gff = None
        source_mtime_ns = None
        source_size = None
        index_format_version = None
        try:
            c.execute("SELECT key, value FROM metadata WHERE key IN ('source_gff', 'source_mtime_ns', 'source_size', 'index_format_version')")
            meta = {row[0]: row[1] for row in c.fetchall()}
            source_gff = meta.get('source_gff')
            source_mtime_ns = meta.get('source_mtime_ns')
            source_size = meta.get('source_size')
            index_format_version = meta.get('index_format_version')
        except sqlite3.OperationalError:
            # Legacy index without metadata table.
            source_gff = None

        if not source_gff or _normalize_fs_path(source_gff) != normalized_gff:
            return False

        # Older indexes with missing file metadata are rebuilt once so we can
        # reliably detect updated GFF3 files going forward.
        if source_mtime_ns is None or source_size is None:
            return False
        if str(index_format_version or "") not in GFF_INDEX_COMPATIBLE_VERSIONS:
            return False

        try:
            stat = os.stat(normalized_gff)
        except OSError:
            return False

        if str(stat.st_mtime_ns) != str(source_mtime_ns):
            return False
        if str(stat.st_size) != str(source_size):
            return False

        return True
    except sqlite3.Error:
        return False
    finally:
        if conn:
            conn.close()


def ensure_gff_index(
    gff_path: str,
    db_path: str,
    force_rebuild: bool = False,
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> str:
    """Build a GFF index once per path, reusing existing compatible DB when possible.

    Rebuilds are written to a private temporary database and atomically swapped
    into place only after a successful parse. A sidecar file lock prevents two
    backend processes (for example across a development-server reload) from
    rebuilding the same index simultaneously.
    """
    normalized_db = _normalize_fs_path(db_path)
    abs_gff = _normalize_fs_path(gff_path)

    # Keep the overwhelmingly common startup/read path lock-free. Besides
    # avoiding filesystem churn, this permits a valid index in a read-only data
    # directory to be used without attempting to create a sidecar lock file.
    if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
        return normalized_db

    lock = _get_index_build_lock(normalized_db)
    with lock:
        lock_path = f"{normalized_db}.build.lock"
        Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a+b") as process_lock:
            if fcntl is not None:
                fcntl.flock(process_lock.fileno(), fcntl.LOCK_EX)
            try:
                # Re-check after taking the process lock: another backend may
                # have completed the index while this request was waiting.
                if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
                    return normalized_db

                with _index_rebuild_guard:
                    if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
                        return normalized_db

                    build_path = (
                        f"{normalized_db}.building-{os.getpid()}-"
                        f"{uuid.uuid4().hex}.tmp"
                    )
                    try:
                        create_gff_index(abs_gff, build_path, progress_cb=progress_cb)
                        os.replace(build_path, normalized_db)
                    finally:
                        for suffix in ("", "-journal", "-wal", "-shm"):
                            candidate = f"{build_path}{suffix}"
                            try:
                                if os.path.exists(candidate):
                                    os.remove(candidate)
                            except OSError:
                                pass
                return normalized_db
            finally:
                if fcntl is not None:
                    fcntl.flock(process_lock.fileno(), fcntl.LOCK_UN)

def init_index_db(db_path: str):
    """Initialize the SQLite index database schema."""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Metadata table to track which GFF this index was built from
    c.execute('''
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')

    # Table for transcripts (fast lookup by ID)
    c.execute('''
        CREATE TABLE IF NOT EXISTS transcripts (
            id TEXT PRIMARY KEY,
            chrom TEXT,
            start INTEGER,
            end INTEGER,
            strand TEXT,
            parent_gene_id TEXT,
            data JSON,  -- Full transcript object as JSON
            is_canonical INTEGER DEFAULT 0  -- 1 if tagged Ensembl_canonical
        )
    ''')

    # Table for genes (spatial lookup for neighbourhood and genome browser)
    c.execute('''
        CREATE TABLE IF NOT EXISTS genes (
            id TEXT PRIMARY KEY,
            chrom TEXT,
            start INTEGER,
            end INTEGER,
            strand TEXT,
            name TEXT,
            biotype TEXT DEFAULT '',
            description TEXT DEFAULT ''
        )
    ''')

    # Backward-compatible schema upgrade for existing indexes.
    c.execute("PRAGMA table_info(genes)")
    gene_cols = {str(row[1]) for row in (c.fetchall() or [])}
    if "description" not in gene_cols:
        c.execute("ALTER TABLE genes ADD COLUMN description TEXT DEFAULT ''")
    if "version" not in gene_cols:
        c.execute("ALTER TABLE genes ADD COLUMN version TEXT DEFAULT ''")

    # Indices for speed
    c.execute('CREATE INDEX IF NOT EXISTS idx_genes_chrom_start ON genes (chrom, start)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_genes_chrom_end ON genes (chrom, end)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_transcripts_parent ON transcripts (parent_gene_id)')

    conn.commit()
    conn.close()

def _read_position_source(handle):
    """The object whose ``tell()`` tracks how far through the file we have read.

    For a plain text handle that is its own buffer; for a gzip handle it is the
    compressed file underneath, so progress is measured in bytes of the file on
    disk in both cases and can be compared against its size. Returns ``None``
    when nothing in the chain reports a position, which is the signal to report
    an indeterminate build rather than a wrong percentage.
    """
    buffer = getattr(handle, "buffer", handle)
    for candidate in (getattr(buffer, "fileobj", None), getattr(buffer, "myfileobj", None), buffer):
        if candidate is None:
            continue
        try:
            candidate.tell()
        except Exception:
            continue
        return candidate
    return None


#: Lines between progress reports while parsing. Large enough that the check is
#: lost in the noise of parsing a line, small enough that the meter still moves
#: several times a second on a big annotation.
INDEX_PROGRESS_LINE_INTERVAL = 20000


def create_gff_index(gff_path: str, db_path: str, progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None):
    """Parse GFF3 and populate the SQLite index.

    ``progress_cb`` is called every :data:`INDEX_PROGRESS_LINE_INTERVAL` lines
    with the stage, the bytes read so far, and the running feature counts. The
    browser draws a meter from it: a multi-gigabyte annotation takes minutes,
    and an indeterminate spinner for that long is indistinguishable from a hang.
    """
    log_progress(f"Indexing {Path(gff_path).name} to {Path(db_path).name}...")

    def report(stage: str, position: int = 0, total: int = 0) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb({
                "stage": stage,
                "processed_bytes": int(position),
                "total_bytes": int(total),
                "genes": int(count_genes),
                "transcripts": len(transcripts_data),
            })
        except Exception:
            pass  # Progress is decoration; never let it fail a build.
    
    if os.path.exists(db_path):
        os.remove(db_path)
        
    init_index_db(db_path)

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Store source GFF metadata so we can validate/reuse indexes safely.
    stat = os.stat(gff_path)
    c.executemany(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        [
            ('source_gff', os.path.abspath(gff_path)),
            ('source_mtime_ns', str(stat.st_mtime_ns)),
            ('source_size', str(stat.st_size)),
            ('index_format_version', GFF_INDEX_FORMAT_VERSION),
        ],
    )

    # We need to collect genes and transcripts
    # Transcripts need their exons/CDS/UTRs for the full object
    
    # First pass: identify genes and transcripts, store raw lines or objects
    # This is complex because GFF3 is hierarchical.
    # To keep it simple and memory-efficient for this "lightweight" backend:
    # We will use the existing parsing logic but iterate through the whole file.
    
    # Actually, a single pass line-reader is best.
    
    genes_batch = []
    gene_coords_map = {}  # g_id -> (chrom, start, end, strand, biotype)
    gene_child_features = {}  # g_id -> {exons:[], cds:[], utrs:[]}
    transcripts_data = {} # id -> {parts, exons:[], cds:[], utrs:[]}
    # GFF3 only requires parents to exist somewhere in the document; it does not
    # require a transcript row to precede its exons/CDS/UTRs. Some Ensembl HPRC
    # files put the first exon before the transcript, so retain such children
    # until their parent is encountered instead of misclassifying them as gene
    # children.
    pending_transcript_child_features = {}
    pending_explicit_transcript_parents = set()
    
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

    feature_types = {'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA',
                    'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
                    'processed_transcript', 'unconfirmed_transcript',
                    'V_gene_segment', 'J_gene_segment', 'D_gene_segment', 'C_gene_segment',
                    'scRNA', 'tRNA', 'antisense_RNA', 'primary_transcript',
                    'guide_RNA', 'vault_RNA', 'RNase_P_RNA', 'RNase_MRP_RNA',
                    'SRP_RNA', 'telomerase_RNA'}
    child_feature_types = {'exon', 'CDS', 'five_prime_UTR', 'three_prime_UTR'}
    
    count_genes = 0
    count_tx = 0
    
    def parse_attrs(attr_str):
        return {k: v for k, v in [x.split('=', 1) for x in attr_str.split(';') if '=' in x]}

    def new_child_bucket():
        return {'exons': [], 'cds': [], 'utrs': []}

    def append_child(bucket, feature_type, feature_parts):
        if feature_type == 'exon':
            bucket['exons'].append(feature_parts)
        elif feature_type == 'CDS':
            bucket['cds'].append(feature_parts)
        else:
            bucket['utrs'].append((feature_type, feature_parts))

    def normalize_tx_biotype(raw_biotype, feature_type, has_cds):
        value = str(raw_biotype or "").strip()
        lowered = value.lower()
        generic_values = {"", "gene", "mrna", "transcript", "rna", "cds"}
        if has_cds and (lowered in generic_values or feature_type == "mRNA"):
            return "protein_coding"
        return value

    def is_protein_coding_biotype(raw_biotype):
        lowered = str(raw_biotype or "").strip().lower().replace(" ", "_")
        if "cds_not_defined" in lowered:
            return False
        return lowered == "protein_coding" or lowered.startswith("protein_coding")

    def transcript_raw_biotype(parts):
        raw_attrs = parts[8]
        for attr_name in ('biotype', 'gene_biotype', 'gbkey', 'ncrna_class'):
            pattern = rf'{attr_name}=([^;]+)'
            m = re.search(pattern, raw_attrs)
            if m:
                return m.group(1)
        return ""

    def synthesize_cds_from_transcript(exons, parts, strand):
        source = exons if exons else [{
            'feature_type': 'exon',
            'start': int(parts[3]),
            'end': int(parts[4]),
            'strand': strand,
        }]
        return [
            {
                'feature_type': 'CDS',
                'start': int(item['start']),
                'end': int(item['end']),
                'strand': str(item.get('strand') or strand),
            }
            for item in source
        ]

    # An index build runs for minutes on a large annotation, on a worker thread
    # inside the API process. Without this it starves the event loop for its
    # whole duration and the rest of the app looks hung — the very thing moving
    # the build off the request path was meant to avoid.
    yielder = CooperativeYielder()

    try:
        total_bytes = os.path.getsize(gff_path)
    except OSError:
        total_bytes = 0

    with open_maybe_gz(gff_path, 'r') as f:
        position_source = _read_position_source(f)
        lines_until_report = INDEX_PROGRESS_LINE_INTERVAL
        report("parsing", 0, total_bytes)
        for line in f:
            yielder.tick()
            lines_until_report -= 1
            if lines_until_report <= 0:
                lines_until_report = INDEX_PROGRESS_LINE_INTERVAL
                position = 0
                if position_source is not None:
                    try:
                        position = position_source.tell()
                    except Exception:
                        position_source = None
                report("parsing", position, total_bytes)
            if line.startswith('#'): continue
            parts = line.strip().split('\t')
            if len(parts) < 9: continue

            ftype = parts[2]
            # Skip features that can never be gene-/transcript-/exon-level to avoid
            # parsing their (often long) attribute strings unnecessarily.
            if ftype not in gene_feature_types and ftype not in feature_types and ftype not in child_feature_types:
                # Might still be a transcript-level feature with a gene parent (RefSeq
                # uses non-standard feature types).  Only skip if the ID column does NOT
                # start with 'gene-' / 'rna-', which would indicate a real gene/RNA entry.
                id_col = parts[8]
                if 'ID=gene-' not in id_col and 'ID=rna-' not in id_col and 'Parent=gene-' not in id_col and 'Parent=gene:' not in id_col:
                    continue
            attrs_str = parts[8]
            attrs = parse_attrs(attrs_str)
            raw_id = attrs.get('ID', '')
            parent_attr = attrs.get('Parent', '')
            # ID prefix normalisation: Ensembl uses 'gene:' / 'transcript:' (colon),
            # RefSeq uses 'gene-' / 'rna-' (hyphen).  Strip both forms so IDs are clean.
            has_gene_id = raw_id.startswith('gene:') or raw_id.startswith('gene-')
            is_gene_level = (ftype in gene_feature_types) or (has_gene_id and not parent_attr)

            # 1. Gene
            if is_gene_level:
                g_id = re.sub(r'^gene[:\-]', '', raw_id)
                if not g_id:
                    g_id = attrs.get('gene_id', '')
                if not g_id:
                    continue
                g_name = attrs.get('Name') or attrs.get('gene_name') or attrs.get('gene') or attrs.get('locus_tag') or g_id
                g_biotype = attrs.get('biotype') or attrs.get('gene_biotype') or attrs.get('gbkey', '')
                g_description = unquote(str(
                    attrs.get('description')
                    or attrs.get('gene_description')
                    or attrs.get('product')
                    or ''
                )).strip()
                g_version = attrs.get('version', '')
                genes_batch.append((
                    g_id, parts[0], int(parts[3]), int(parts[4]), parts[6], g_name, g_biotype, g_description, g_version
                ))
                gene_coords_map[g_id] = (parts[0], int(parts[3]), int(parts[4]), parts[6], g_biotype)
                gene_child_features.setdefault(g_id, new_child_bucket())
                count_genes += 1

                if len(genes_batch) > 1000:
                    c.executemany(
                        'INSERT OR IGNORE INTO genes (id, chrom, start, end, strand, name, biotype, description, version) VALUES (?,?,?,?,?,?,?,?,?)',
                        genes_batch
                    )
                    genes_batch = []

            # 2. Transcript-level features
            is_parent_gene_feature = parent_attr.startswith('gene:') or parent_attr.startswith('gene-')
            is_transcript_level = (
                ftype in feature_types
                or (is_parent_gene_feature and ftype not in child_feature_types and bool(raw_id))
            )
            if is_transcript_level:
                # Strip Ensembl ('transcript:'/'mapped_transcript:') and RefSeq ('rna-') ID prefixes.
                t_id = re.sub(r'^(?:transcript|mapped_transcript|rna)[:\-]', '', raw_id)
                if not t_id:
                     t_id = attrs.get('transcript_id', '')
                if not t_id:
                    continue

                p_id = re.sub(r'^gene[:\-]', '', parent_attr.split(',')[0])
                if not p_id: p_id = t_id
                
                # Check for Ensembl_canonical tag
                tags = attrs.get('tag', '')
                is_canonical = any(
                    token in tags
                    for token in ('Ensembl_canonical', 'RefSeq Select', 'MANE Select', 'MANE Plus Clinical')
                )
                tag_list = [t.strip() for t in str(tags).split(',') if t.strip()]
                
                previously_attached = transcripts_data.get(t_id, new_child_bucket())
                pending_children = pending_transcript_child_features.pop(t_id, new_child_bucket())
                pending_explicit_transcript_parents.discard(t_id)
                transcripts_data[t_id] = {
                    'parts': parts,
                    'parent': p_id,
                    'exons': [*previously_attached.get('exons', []), *pending_children['exons']],
                    'cds': [*previously_attached.get('cds', []), *pending_children['cds']],
                    'utrs': [*previously_attached.get('utrs', []), *pending_children['utrs']],
                    'is_canonical': is_canonical,
                    'tags': tag_list,
                    'version': attrs.get('version', ''),
                }
                
            # 3. Child features (Exon, CDS, UTR)
            elif ftype in child_feature_types:
                parent_str = parent_attr
                parent_ids = [p.strip() for p in parent_str.split(',') if p.strip()]
                for raw_parent in parent_ids:
                    is_explicit_transcript_parent = bool(
                        re.match(r'^(?:transcript|mapped_transcript|rna)[:\-]', raw_parent)
                    )
                    is_explicit_gene_parent = bool(re.match(r'^gene[:\-]', raw_parent))
                    parent = re.sub(r'^(?:transcript|mapped_transcript|rna)[:\-]', '', raw_parent)
                    if not parent:
                        continue

                    if is_explicit_gene_parent:
                        gene_parent = re.sub(r'^gene[:\-]', '', raw_parent)
                        append_child(
                            gene_child_features.setdefault(gene_parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                        continue

                    if parent in transcripts_data:
                        append_child(transcripts_data[parent], ftype, parts)
                    elif not is_explicit_transcript_parent and parent in gene_coords_map:
                        append_child(
                            gene_child_features.setdefault(parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                    else:
                        append_child(
                            pending_transcript_child_features.setdefault(parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                        if is_explicit_transcript_parent:
                            pending_explicit_transcript_parents.add(parent)

    # Resolve unprefixed child parents that turned out to be genes declared later
    # in the file. Explicit transcript parents with a missing transcript remain
    # unattached rather than contaminating an unrelated gene with the same ID.
    for parent, bucket in list(pending_transcript_child_features.items()):
        if (
            parent not in pending_explicit_transcript_parents
            and parent not in transcripts_data
            and parent in gene_coords_map
        ):
            gene_bucket = gene_child_features.setdefault(parent, new_child_bucket())
            gene_bucket['exons'].extend(bucket['exons'])
            gene_bucket['cds'].extend(bucket['cds'])
            gene_bucket['utrs'].extend(bucket['utrs'])

    # Commit remaining genes
    if genes_batch:
        c.executemany(
            'INSERT OR IGNORE INTO genes (id, chrom, start, end, strand, name, biotype, description, version) VALUES (?,?,?,?,?,?,?,?,?)',
            genes_batch
        )
    
    # Process and insert transcripts
    report("writing", total_bytes, total_bytes)
    tx_batch = []
    
    for t_id, data in transcripts_data.items():
        yielder.tick()
        parts = data['parts']
        parent_gene = gene_coords_map.get(data['parent'])
        parent_gene_biotype = parent_gene[4] if parent_gene else ""
        gene_bucket = gene_child_features.get(data['parent'], new_child_bucket())
        raw_biotype = transcript_raw_biotype(parts)
        effective_raw_biotype = raw_biotype or parent_gene_biotype
        should_inherit_gene_cds = (
            parts[2] == 'mRNA'
            or is_protein_coding_biotype(effective_raw_biotype)
        )
        
        # Build SimpleTranscript object (reusing logic from find_transcript_fast)
        # Exons
        exons = []
        for ep in data['exons']:
            exons.append({'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]})
        if not exons:
            for ep in gene_bucket.get('exons', []):
                exons.append({'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]})
        exons.sort(key=lambda x: x['start'])
        
        # CDS
        cds_list = []
        for cp in data['cds']:
            phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
            phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
            cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
            if phase_value is not None:
                cds_item['phase'] = phase_value
            cds_list.append(cds_item)
        if not cds_list and should_inherit_gene_cds:
            for cp in gene_bucket.get('cds', []):
                phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
                phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
                cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
                if phase_value is not None:
                    cds_item['phase'] = phase_value
                cds_list.append(cds_item)
        cds_list.sort(key=lambda x: x['start'])
        
        # UTRs
        utrs = []
        for ut, up in data['utrs']:
            utrs.append({'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]})
        if not utrs:
            for ut, up in gene_bucket.get('utrs', []):
                utrs.append({'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]})
            
        # Biotype
        biotype = raw_biotype

        if not exons:
            # A real transcript with no explicit exon should never inherit the
            # whole gene span: that can extend beyond this isoform and renders a
            # false terminal exon. Its own feature bounds are the safe fallback.
            exons = [{
                'feature_type': 'exon',
                'start': int(parts[3]),
                'end': int(parts[4]),
                'strand': parts[6],
            }]

        if not cds_list and should_inherit_gene_cds:
            cds_list = synthesize_cds_from_transcript(exons, parts, parts[6])

        biotype = normalize_tx_biotype(effective_raw_biotype, parts[2], bool(cds_list))

        # Check canonical flag
        is_canonical = 1 if data.get('is_canonical', False) else 0
        
        # Construct JSON-serializable dict
        tx_obj = {
            'feature_id': t_id,
            'seq_region': parts[0],
            'start': int(parts[3]),
            'end': int(parts[4]),
            'strand': parts[6],
            'exons': exons,
            'cds_list': cds_list,
            'utrs': utrs,
            'biotype': biotype,
            'is_canonical': bool(is_canonical),
            'tags': data.get('tags', []),
            'version': data.get('version', ''),
        }
        
        tx_batch.append((
            t_id, parts[0], int(parts[3]), int(parts[4]), parts[6], data['parent'], json.dumps(tx_obj), is_canonical
        ))
        
        if len(tx_batch) > 500:
             c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', tx_batch)
             tx_batch = []
             
    if tx_batch:
        c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', tx_batch)

    # For genes that have no transcript children in the GFF3 (e.g. processed pseudogenes
    # or other single-feature entries), synthesise one transcript spanning the gene so the
    # genome browser and feature explorer always have something to render.
    genes_with_transcripts = {data['parent'] for data in transcripts_data.values()}
    synthetic_batch = []
    for g_id, (chrom, g_start, g_end, strand, biotype) in gene_coords_map.items():
        yielder.tick()
        if g_id in genes_with_transcripts:
            continue
        bucket = gene_child_features.get(g_id, new_child_bucket())
        exons = [
            {'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]}
            for ep in bucket.get('exons', [])
        ]
        exons.sort(key=lambda x: x['start'])
        if not exons:
            exons = [{'feature_type': 'exon', 'start': g_start, 'end': g_end, 'strand': strand}]

        cds_list = []
        for cp in bucket.get('cds', []):
            phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
            phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
            cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
            if phase_value is not None:
                cds_item['phase'] = phase_value
            cds_list.append(cds_item)
        cds_list.sort(key=lambda x: x['start'])
        if not cds_list and is_protein_coding_biotype(biotype):
            cds_list = [{
                'feature_type': 'CDS',
                'start': g_start,
                'end': g_end,
                'strand': strand,
            }]

        utrs = [
            {'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]}
            for ut, up in bucket.get('utrs', [])
        ]

        syn_biotype = normalize_tx_biotype(biotype, 'transcript', bool(cds_list))
        syn_id = g_id
        syn_obj = {
            'feature_id': syn_id,
            'seq_region': chrom,
            'start': g_start,
            'end': g_end,
            'strand': strand,
            'exons': exons,
            'cds_list': cds_list,
            'utrs': utrs,
            'biotype': syn_biotype,
            'is_canonical': True,
            'tags': [],
            'version': '',
        }
        synthetic_batch.append((syn_id, chrom, g_start, g_end, strand, g_id, json.dumps(syn_obj), 1))
        if len(synthetic_batch) >= 500:
            c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', synthetic_batch)
            synthetic_batch = []
    if synthetic_batch:
        c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', synthetic_batch)

    # Sanity check for immune receptor loci, which often use unusual transcript feature types.
    try:
        c.execute("SELECT COUNT(*) FROM genes WHERE biotype LIKE 'IG_%' OR biotype LIKE 'TR_%'")
        igtr_gene_count = int(c.fetchone()[0] or 0)
        c.execute("""
            SELECT COUNT(*)
            FROM transcripts t
            JOIN genes g ON g.id = t.parent_gene_id
            WHERE g.biotype LIKE 'IG_%' OR g.biotype LIKE 'TR_%'
        """)
        igtr_tx_count = int(c.fetchone()[0] or 0)
        if igtr_gene_count > 0 and igtr_tx_count == 0:
            log_progress("  ! IG/TR sanity check: genes detected but no linked transcripts were indexed")
        else:
            log_progress(f"  ✓ IG/TR sanity check: {igtr_gene_count} genes, {igtr_tx_count} transcripts")
    except Exception as e:
        log_progress(f"  ! IG/TR sanity check skipped: {e}")

    conn.commit()
    conn.close()
    log_progress(f"  ✓ Indexing complete: {count_genes} genes, {len(transcripts_data)} transcripts")


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
    log_progress(f"Running MAFFT alignment ({len(seq1)}bp vs {len(seq2)}bp)...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        f.write(f">seq1\n{seq1}\n>seq2\n{seq2}\n")
    
    try:
        # --auto automatically converts to the most appropriate method
        # --quiet suppresses output
        cmd = [MAFFT_PATH, "--auto", "--quiet", input_file]
        log_progress(f"  Running MAFFT...")
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
                env={**os.environ, **MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise _mafft_missing_error() from exc
        
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
        
        log_progress(f"  ✓ MAFFT complete ({len(aligned.get('seq1', ''))} positions)")
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

    log_progress(f"Running MAFFT MSA ({len(ordered_sequences)} sequences)...")
    with tempfile.NamedTemporaryFile(mode='w', suffix='.fa', delete=False) as f:
        input_file = f.name
        for seq_id, seq in ordered_sequences:
            f.write(f">{seq_id}\n{seq}\n")

    try:
        cmd = [MAFFT_PATH, *mafft_args, input_file]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(30, int(timeout_sec)),
                env={**os.environ, **MAFFT_ENV},
            )
        except FileNotFoundError as exc:
            raise _mafft_missing_error() from exc
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
    tx: SimpleTranscript,
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
        context = _resolve_browse_genome_context(genome)
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


def _find_transcript_for_genome(genome: str, transcript_id: str) -> Optional[SimpleTranscript]:
    context = _resolve_browse_genome_context(genome)
    db_path = str(context.get("db_path") or "").strip()
    gff_path = str(context.get("gff_path") or "").strip()

    tx: Optional[SimpleTranscript] = None
    if db_path and os.path.exists(db_path):
        tx = find_transcript_in_index(db_path, transcript_id)
    if tx is None and gff_path and os.path.exists(gff_path):
        tx = find_transcript_fast(gff_path, transcript_id)
    return tx


def _resolve_transcript_id_for_genome_query(genome: str, query: str) -> str:
    q = str(query or "").strip()
    if not q:
        return ""
    try:
        context = _resolve_browse_genome_context(genome)
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
            resolved = _resolve_browse_chrom_name(genome, requested_chrom, known_regions)
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
            context = _resolve_browse_genome_context(genome)
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

        with open_maybe_gz(source_path, "rt") as handle:
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
    transcript: SimpleTranscript,
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
    return CACHE_DIR / f"{safe_id}_vs_{safe_target}_rf{ref_flank}_tf{tgt_flank}.json"


def get_max_flanking_cache(transcript_id: str, target_id: str) -> Optional[Tuple[Path, int, int]]:
    """Find the cached alignment with the largest flanking for this transcript pair."""
    import re
    safe_id = transcript_id.replace(":", "_").replace("/", "_")
    safe_target = target_id.replace(":", "_").replace("/", "_")
    pattern = f"{safe_id}_vs_{safe_target}_rf*_tf*.json"
    
    best_path = None
    best_ref_flank = -1
    best_tgt_flank = -1
    
    for path in CACHE_DIR.glob(pattern):
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
                log_progress("  ✓ Found exact cache match")
                return AlignmentResult(**data)
        except Exception:
            pass
    
    # Try to find a larger cached alignment
    larger = get_max_flanking_cache(transcript_id, target_id)
    if larger:
        path, cached_ref_flank, cached_tgt_flank = larger
        if cached_ref_flank >= ref_flank and cached_tgt_flank >= tgt_flank:
            log_progress(f"  ✓ Found larger cache (rf{cached_ref_flank}, tf{cached_tgt_flank}), can subset")
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
        log_progress(f"  ✓ Saved to cache: {cache_path.name}")
    except Exception as e:
        log_progress(f"  ✗ Failed to save cache: {e}")


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
    try:
        with open("debug_backend.txt", "a") as dbg:
            dbg.write(f"Searching cache: dir={output_dir}, ref={ref_id}, tgt={tgt_id}, req=({req_ref},{req_tgt})\n")
    except:
        pass

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
                    
                    try:
                        with open("debug_backend.txt", "a") as dbg:
                            dbg.write(f"  Checking candidate: {f.name} -> ({c_ref_flank}, {c_tgt_flank})\n")
                    except:
                        pass
                    
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
async def align_transcripts(request: AlignmentRequest):
    """Align two transcripts with flanking sequences."""
    config = load_config()
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
            with open("debug_backend.txt", "a") as dbg:
                dbg.write(f"Attempting to load cache: {cache_path}\n")
                
            log_progress(f"Found compatible cache: {Path(cache_path).name} ({c_ref}/{c_tgt} vs {ref_flank}/{tgt_flank})")
            with open(cache_path, 'r') as f:
                data = json.load(f)
                cached_result = AlignmentResult(**data)
                
            # Truncate if necessary (if cached flanks > requested)
            log_progress(f"Adapting cache: {c_ref}->{ref_flank}, {c_tgt}->{tgt_flank}")
            final_result = truncate_and_mask_alignment(cached_result, c_ref, c_tgt, ref_flank, tgt_flank)
            log_progress("  ✓ Loaded and adapted from cache")
            return final_result
            
        except Exception as e:
            import traceback
            error_msg = f"ERROR processing cache: {e}"
            trace_msg = traceback.format_exc()
            
            # Log to file
            try:
                with open("debug_backend.txt", "a") as dbg:
                    dbg.write(f"{error_msg}\n")
                    dbg.write(trace_msg)
            except:
                pass
            
            # Log to console/logger
            logger.error(f"Failed to load/adapt cache: {e}")
            logger.error(trace_msg)
            log_progress(f"  ✗ Cache adaptation failed: {e}")
            # Continue to re-run alignment if cache load fails
    
    ref_fasta = config.get("ref_fasta")
    ref_gff = config.get("ref_gff")

    log_progress(f"\n{'='*60}")
    log_progress(f"Alignment request: {request.transcript_id}")
    log_progress(f"{'='*60}")
    
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
    log_progress(f"Searching for transcript in reference GFF3 ({ref_id})...")
    
    # Try index first
    ref_tx = None
    ref_index = config.get("ref_index")
    if ref_index and os.path.exists(ref_index):
        ref_tx = find_transcript_in_index(ref_index, ref_id)
        if ref_tx: log_progress("  ✓ Found in index")
        
    if not ref_tx:
        ref_tx = find_transcript_fast(ref_gff, ref_id)
        
    if not ref_tx:
        raise HTTPException(
            status_code=404,
            detail=f"Transcript {ref_id} not found in reference"
        )
    
    # Find transcript in target
    log_progress(f"Searching for transcript in target GFF3 ({target_id})...")
    
    target_tx = None
    target_index = config.get("target_index")
    if target_index and os.path.exists(target_index):
        target_tx = find_transcript_in_index(target_index, target_id)
        if target_tx: log_progress("  ✓ Found in index")
        
    if not target_tx:
        target_tx = find_transcript_fast(target_gff, target_id)

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
    log_progress(f"Extracting sequences (ref: {ref_flank}bp, target: {tgt_flank}bp flanking)...")
    try:
        ref_seq = extract_genomic_sequence(
            genome_data.ref_fasta, ref_tx.seq_region, ref_start, ref_end, ref_strand, uppercase=False
        )
        log_progress(f"  ✓ Reference: {len(ref_seq)}bp")
        target_seq = extract_genomic_sequence(
            genome_data.target_fasta, target_tx.seq_region, target_start, target_end, target_strand, uppercase=False
        )
        log_progress(f"  ✓ Target: {len(target_seq)}bp")
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
            log_progress(f"  ✓ Saved alignment to cache: {Path(new_cache_path).name}")
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


@app.post("/api/align/multi", response_model=MultiAlignmentResult)
async def align_multi(request: MultiAlignmentRequest):
    if not request.rows:
        raise HTTPException(status_code=400, detail="At least one row is required.")

    config = load_config()
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
            fasta = _get_browse_fasta(row_genome)
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

    if cache_path:
        try:
            with cache_path.open("w") as f:
                json.dump(result.model_dump(), f)
        except Exception:
            pass

    return result


@app.get("/api/align/check")
async def check_alignment_status(
    transcript_id: str, 
    ref_flank: int, 
    tgt_flank: int,
    target_transcript_id: Optional[str] = None
):
    """Check if a compatible alignment exists in cache."""
    config = load_config()
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
async def save_alignment(payload: SaveAlignmentRequest):
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
async def list_alignments(output_dir: str = ""):
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
async def load_alignment(payload: LoadAlignmentRequest):
    """Reconstruct a MultiAlignmentResult from a saved alignment, filtered to genome_keys."""
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


@app.get("/api/homologs")
async def get_homologs(transcript_id: str):
    """Look up homologous transcripts for a given ID."""
    config = load_config()
    homology_file = config.get("homologies_file", "")
    
    if not homology_file:
        return {
            "query_id": transcript_id,
            "ref_id": None,
            "target_ids": [],
            "source": None
        }
    
    # Load/reload the homology file if needed
    homology_map.load(homology_file)
    
    return homology_map.lookup(transcript_id)


@app.get("/api/homology/query")
async def query_homology_table(path: str = "", gene_query: str = "", limit: int = 5000):
    """Query a homology TSV(.gz) table for rows linked to a gene symbol/stable ID."""
    query = (gene_query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="gene_query parameter is required.")
    if not path:
        raise HTTPException(status_code=400, detail="path parameter is required.")

    table_path = _resolve_allowed_homology_path(path)
    row_limit = max(50, min(50000, int(limit)))

    def _query():
        with open_maybe_gz(table_path, "rt") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            columns = reader.fieldnames or []
            if not columns:
                raise HTTPException(status_code=400, detail="Homology file is missing a header row.")

            lower_to_col = {col.lower(): col for col in columns}
            query_match_cols = [
                c for c in [
                    lower_to_col.get("query_gene_stable_id"),
                    lower_to_col.get("query_gene_name"),
                ] if c
            ]
            ref_match_cols = [
                c for c in [
                    lower_to_col.get("ref_gene_stable_id"),
                    lower_to_col.get("ref_gene_name"),
                ] if c
            ]

            q_lower = query.lower()
            stable_id_like = bool(re.match(r"^ENS[A-Z0-9]*(?:G|T|P)\d+(?:\.\d+)?$", query, flags=re.IGNORECASE))

            query_exact_rows: list[dict] = []
            query_contains_rows: list[dict] = []
            ref_exact_rows: list[dict] = []
            ref_contains_rows: list[dict] = []
            generic_exact_rows: list[dict] = []
            generic_contains_rows: list[dict] = []

            generic_match_cols: list[str] = []
            if not query_match_cols and not ref_match_cols:
                generic_match_cols = [c for c in columns if "gene" in c.lower()]

            for raw_row in reader:
                if not raw_row:
                    continue
                row = {col: (raw_row.get(col, "") or "").strip() for col in columns}
                query_values = [row.get(col, "") for col in query_match_cols]
                query_value_lowers = [v.lower() for v in query_values if v]
                ref_values = [row.get(col, "") for col in ref_match_cols]
                ref_value_lowers = [v.lower() for v in ref_values if v]
                generic_values = [row.get(col, "") for col in generic_match_cols]
                generic_value_lowers = [v.lower() for v in generic_values if v]

                if query_value_lowers:
                    if any(v == q_lower for v in query_value_lowers):
                        query_exact_rows.append(row)
                    elif any(q_lower in v for v in query_value_lowers):
                        query_contains_rows.append(row)

                if stable_id_like and ref_value_lowers:
                    if any(v == q_lower for v in ref_value_lowers):
                        ref_exact_rows.append(row)
                    elif any(q_lower in v for v in ref_value_lowers):
                        ref_contains_rows.append(row)

                if generic_value_lowers:
                    if any(v == q_lower for v in generic_value_lowers):
                        generic_exact_rows.append(row)
                    elif any(q_lower in v for v in generic_value_lowers):
                        generic_contains_rows.append(row)

            matched_by = "none"
            match_scope = "query"
            all_matches: list[dict] = []

            if query_exact_rows:
                matched_by = "exact"
                match_scope = "query"
                all_matches = query_exact_rows
            elif query_contains_rows:
                matched_by = "contains"
                match_scope = "query"
                all_matches = query_contains_rows
            elif stable_id_like and ref_exact_rows:
                matched_by = "exact"
                match_scope = "ref"
                all_matches = ref_exact_rows
            elif stable_id_like and ref_contains_rows:
                matched_by = "contains"
                match_scope = "ref"
                all_matches = ref_contains_rows
            elif generic_exact_rows:
                matched_by = "exact"
                match_scope = "generic"
                all_matches = generic_exact_rows
            elif generic_contains_rows:
                matched_by = "contains"
                match_scope = "generic"
                all_matches = generic_contains_rows

            truncated = len(all_matches) > row_limit
            rows = all_matches[:row_limit]

            return {
                "path": str(table_path),
                "query": query,
                "columns": columns,
                "rows": rows,
                "match_scope": match_scope,
                "matched_by": matched_by,
                "total_matches": len(all_matches),
                "returned_rows": len(rows),
                "truncated": truncated,
            }

    return await run_in_threadpool(_query)


def _normalize_gene_id(raw: Optional[str]) -> str:
    return (raw or "").strip().replace("gene:", "")


def _normalize_transcript_id(raw: Optional[str]) -> str:
    return (raw or "").strip().replace("transcript:", "").replace("mapped_transcript:", "")


def _parse_gff_attrs(attr_str: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for item in (attr_str or "").strip().split(";"):
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        attrs[k] = unquote(v)
    return attrs


def resolve_gene_anchor(db_path: str, gene_id: Optional[str] = None, transcript_id: Optional[str] = None) -> Optional[str]:
    """Resolve/validate a gene-focused neighbourhood anchor from gene or transcript input."""
    if not db_path or not os.path.exists(db_path):
        return None

    gene_query = _normalize_gene_id(gene_id)
    tx_query = _normalize_transcript_id(transcript_id)

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        if gene_query:
            c.execute("SELECT id FROM genes WHERE id = ? LIMIT 1", (gene_query,))
            row = c.fetchone()
            if row:
                conn.close()
                return row["id"]

        if tx_query:
            c.execute("SELECT parent_gene_id FROM transcripts WHERE id = ? LIMIT 1", (tx_query,))
            row = c.fetchone()
            if row and row["parent_gene_id"]:
                parent_gene_id = _normalize_gene_id(row["parent_gene_id"])
                c.execute("SELECT id FROM genes WHERE id = ? LIMIT 1", (parent_gene_id,))
                g_row = c.fetchone()
                conn.close()
                if g_row:
                    return g_row["id"]
                return None

        conn.close()
        return None
    except Exception as e:
        logger.error(f"resolve_gene_anchor failed for {db_path}: {e}")
        return None


def resolve_gene_anchor_gff(gff_path: str, gene_id: Optional[str] = None, transcript_id: Optional[str] = None) -> Optional[str]:
    """No-index fallback anchor resolution for neighbourhood gene queries."""
    if not gff_path or not os.path.exists(gff_path):
        return None

    gene_query = _normalize_gene_id(gene_id)
    tx_query = _normalize_transcript_id(transcript_id)

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
    transcript_types = {
        'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA',
        'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
        'processed_transcript', 'unconfirmed_transcript',
        'antisense_RNA', 'primary_transcript', 'guide_RNA', 'vault_RNA',
        'RNase_P_RNA', 'RNase_MRP_RNA', 'SRP_RNA', 'telomerase_RNA',
    }

    try:
        with open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9:
                    continue
                attrs = _parse_gff_attrs(parts[8])
                feature_type = parts[2]
                raw_id = attrs.get("ID", "")
                parent_attr = attrs.get("Parent", "")
                has_gene_id = raw_id.startswith("gene:")
                is_gene_level = (feature_type in gene_feature_types) or (has_gene_id and not parent_attr)
                if gene_query and is_gene_level:
                    row_gene = _normalize_gene_id(raw_id or attrs.get("gene_id", ""))
                    if row_gene == gene_query:
                        return row_gene
                if tx_query and feature_type in transcript_types:
                    row_tx = _normalize_transcript_id(raw_id)
                    row_tx_alt = _normalize_transcript_id(attrs.get("transcript_id", ""))
                    if row_tx == tx_query or row_tx_alt == tx_query:
                        return _normalize_gene_id(attrs.get("Parent", ""))
    except Exception as e:
        logger.error(f"resolve_gene_anchor_gff failed for {gff_path}: {e}")
    return None


def get_gene_neighbourhood_by_gene(gff_path: str, gene_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    """No-index fallback neighbourhood query using only gene features."""
    search_gene = _normalize_gene_id(gene_id)
    if not search_gene:
        return [], None

    center_chrom: Optional[str] = None
    center_start = 0
    center_end = 0
    center_strand = "+"
    center_name = search_gene
    center_biotype = ""

    try:
        with open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9 or parts[2] != "gene":
                    continue
                attrs = _parse_gff_attrs(parts[8])
                row_gene = _normalize_gene_id(attrs.get("ID", ""))
                if row_gene != search_gene:
                    continue
                center_chrom = parts[0]
                center_start = int(parts[3])
                center_end = int(parts[4])
                center_strand = parts[6]
                center_name = attrs.get("Name", row_gene) or row_gene
                center_biotype = attrs.get("biotype", "") or attrs.get("gene_biotype", "")
                break
    except Exception as e:
        logger.error(f"GFF neighbourhood center lookup failed: {e}")
        return [], None

    if not center_chrom:
        return [], None

    genes: List[GeneSummary] = []
    try:
        with open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9 or parts[2] != "gene" or parts[0] != center_chrom:
                    continue
                attrs = _parse_gff_attrs(parts[8])
                row_gene = _normalize_gene_id(attrs.get("ID", ""))
                if not row_gene:
                    continue
                genes.append(GeneSummary(
                    id=row_gene,
                    name=attrs.get("Name", row_gene) or row_gene,
                    chrom=parts[0],
                    start=int(parts[3]),
                    end=int(parts[4]),
                    strand=parts[6],
                    biotype=attrs.get("biotype", "") or attrs.get("gene_biotype", ""),
                    is_focal=False,
                ))
    except Exception as e:
        logger.error(f"GFF neighbourhood chromosome scan failed: {e}")
        return [], None

    if not genes:
        return [], None

    genes.sort(key=lambda g: (g.start, g.id))
    center_idx = -1
    for idx, g in enumerate(genes):
        if g.id == search_gene:
            center_idx = idx
            genes[idx].is_focal = True
            break
    if center_idx == -1:
        for idx, g in enumerate(genes):
            if g.start <= center_start and g.end >= center_end:
                center_idx = idx
                genes[idx].is_focal = True
                search_gene = g.id
                break
    if center_idx == -1:
        dummy = GeneSummary(
            id=search_gene,
            name=center_name,
            chrom=center_chrom,
            start=center_start,
            end=center_end,
            strand=center_strand,
            biotype=center_biotype,
            is_focal=True,
        )
        genes.append(dummy)
        genes.sort(key=lambda g: g.start)
        center_idx = genes.index(dummy)

    start_idx = max(0, center_idx - window_size)
    end_idx = min(len(genes), center_idx + window_size + 1)
    return genes[start_idx:end_idx], search_gene


def get_gene_neighbourhood_index_by_gene(db_path: str, gene_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    """Get neighbourhood from index by focal gene ID."""
    search_gene = _normalize_gene_id(gene_id)
    if not search_gene:
        return [], None

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        c.execute(
            "SELECT id, name, chrom, start, end, strand, biotype FROM genes WHERE id = ? LIMIT 1",
            (search_gene,)
        )
        center_row = c.fetchone()
        if not center_row:
            conn.close()
            return [], None

        chrom = center_row["chrom"]
        center_start = int(center_row["start"] or 0)

        c.execute(
            "SELECT COUNT(*) FROM genes "
            "WHERE chrom = ? AND (start < ? OR (start = ? AND id < ?))",
            (chrom, center_start, center_start, search_gene)
        )
        preceding_count = int(c.fetchone()[0] or 0)
        window_start_index = max(0, preceding_count - window_size)
        left_count = preceding_count - window_start_index
        limit_count = left_count + 1 + window_size

        c.execute(
            "SELECT id, name, chrom, start, end, strand, biotype FROM genes "
            "WHERE chrom = ? ORDER BY start ASC, id ASC LIMIT ? OFFSET ?",
            (chrom, limit_count, window_start_index)
        )
        neighbourhood_rows = c.fetchall()
        conn.close()

        def make_summary(row: sqlite3.Row) -> GeneSummary:
            return GeneSummary(
                id=row["id"],
                name=row["name"],
                chrom=row["chrom"],
                start=row["start"],
                end=row["end"],
                strand=row["strand"],
                biotype=row["biotype"] or "",
                is_focal=False,
            )

        combined = [make_summary(r) for r in neighbourhood_rows]
        found_center = False
        for gene in combined:
            if gene.id == center_row["id"]:
                gene.is_focal = True
                found_center = True
                break
        if not found_center:
            center_gene = GeneSummary(
                id=center_row["id"],
                name=center_row["name"] or center_row["id"],
                chrom=center_row["chrom"],
                start=center_row["start"],
                end=center_row["end"],
                strand=center_row["strand"],
                biotype=center_row["biotype"] or "",
                is_focal=True,
            )
            combined.append(center_gene)
            combined.sort(key=lambda g: (g.start, g.id))
        return combined, center_row["id"]
    except Exception as e:
        logger.error(f"Index neighbourhood error for {search_gene}: {e}")
        return [], None


# Backward-compatible wrappers for older call sites that pass transcript IDs.
def get_gene_neighbourhood(gff_path: str, transcript_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    gene_id = resolve_gene_anchor_gff(gff_path, transcript_id=transcript_id)
    if not gene_id:
        return [], None
    return get_gene_neighbourhood_by_gene(gff_path, gene_id, window_size)


def get_gene_neighbourhood_index(db_path: str, transcript_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    gene_id = resolve_gene_anchor(db_path, transcript_id=transcript_id) or resolve_gene_anchor(db_path, gene_id=transcript_id)
    if not gene_id:
        return [], None
    return get_gene_neighbourhood_index_by_gene(db_path, gene_id, window_size)


@app.get("/api/neighbourhood", response_model=NeighbourhoodResponse)
async def get_neighbourhood(
    ref_gene_id: Optional[str] = None,
    target_gene_id: Optional[str] = None,
    transcript_id: Optional[str] = None,
    target_transcript_id: Optional[str] = None,
    ref_genome: str = "reference",
    target_genome: str = "target",
    window_size: int = 25,
    use_homology: bool = False,
):
    """Get gene-level neighbourhood for reference and optional target anchors."""
    window_size = max(1, min(600, int(window_size)))
    req_started = time.perf_counter()

    ref_context = _resolve_browse_genome_context(ref_genome)
    target_context = _resolve_browse_genome_context(target_genome)
    ref_gff = str(ref_context.get("gff_path") or "").strip()
    target_gff = str(target_context.get("gff_path") or "").strip()
    ref_index = str(ref_context.get("db_path") or "").strip()
    target_index = str(target_context.get("db_path") or "").strip()

    if not ref_gff:
        raise HTTPException(status_code=400, detail="Reference GFF file not configured")

    anchor_started = time.perf_counter()
    has_ref_index = bool(ref_index and os.path.exists(ref_index))
    has_tgt_index = bool(target_index and os.path.exists(target_index))

    resolved_ref_gene = None
    if has_ref_index:
        resolved_ref_gene = await run_in_threadpool(resolve_gene_anchor, ref_index, ref_gene_id, transcript_id)
    else:
        resolved_ref_gene = await run_in_threadpool(resolve_gene_anchor_gff, ref_gff, ref_gene_id, transcript_id)

    if not resolved_ref_gene:
        raise HTTPException(status_code=400, detail="Reference gene anchor missing or invalid.")

    resolved_target_gene: Optional[str] = None
    if target_gene_id or target_transcript_id:
        if target_gff:
            if has_tgt_index:
                resolved_target_gene = await run_in_threadpool(
                    resolve_gene_anchor, target_index, target_gene_id, target_transcript_id
                )
            else:
                resolved_target_gene = await run_in_threadpool(
                    resolve_gene_anchor_gff, target_gff, target_gene_id, target_transcript_id
                )
    anchor_ms = (time.perf_counter() - anchor_started) * 1000

    # Fast path: return cached result if still fresh.
    _cache_key = (
        str(ref_genome or "reference").strip() or "reference",
        str(target_genome or "target").strip() or "target",
        resolved_ref_gene,
        resolved_target_gene or "",
        window_size,
        bool(use_homology),
    )
    _cached = _neighbourhood_cache.get(_cache_key)
    if _cached:
        _ts, _result = _cached
        if time.time() - _ts < _NEIGHBOURHOOD_CACHE_TTL:
            cached_ref = getattr(_result, "reference_genes", []) or []
            cached_tgt = getattr(_result, "target_genes", []) or []
            all_cached = list(cached_ref) + list(cached_tgt)
            has_genes = len(all_cached) > 0
            has_any_biotype = any(bool((getattr(g, "biotype", "") or "").strip()) for g in all_cached)
            if (not has_genes) or has_any_biotype:
                logger.info(
                    "Neighbourhood cache hit ref=%s target=%s window=%s (anchor %.1fms total %.1fms)",
                    resolved_ref_gene,
                    resolved_target_gene or "",
                    window_size,
                    anchor_ms,
                    (time.perf_counter() - req_started) * 1000,
                )
                return _result

    log_progress(f"Fetching neighbourhood for {resolved_ref_gene}...")

    ref_started = time.perf_counter()
    if has_ref_index:
        log_progress("  ✓ Using Reference Index")
        ref_genes, ref_center = await run_in_threadpool(
            get_gene_neighbourhood_index_by_gene,
            ref_index,
            resolved_ref_gene,
            window_size,
        )
    else:
        log_progress("  Using GFF gene scan (Reference)...")
        ref_genes, ref_center = await run_in_threadpool(
            get_gene_neighbourhood_by_gene,
            ref_gff,
            resolved_ref_gene,
            window_size,
        )
    ref_ms = (time.perf_counter() - ref_started) * 1000

    if not ref_center or not ref_genes:
        raise HTTPException(status_code=400, detail=f"Reference gene anchor '{resolved_ref_gene}' could not be loaded.")

    target_genes: List[GeneSummary] = []
    target_center: Optional[str] = None
    tgt_ms = 0.0
    if resolved_target_gene and target_gff:
        tgt_started = time.perf_counter()
        if has_tgt_index:
            log_progress("  ✓ Using Target Index")
            target_genes, target_center = await run_in_threadpool(
                get_gene_neighbourhood_index_by_gene,
                target_index,
                resolved_target_gene,
                window_size,
            )
        else:
            log_progress("  Using GFF gene scan (Target)...")
            target_genes, target_center = await run_in_threadpool(
                get_gene_neighbourhood_by_gene,
                target_gff,
                resolved_target_gene,
                window_size,
            )
        tgt_ms = (time.perf_counter() - tgt_started) * 1000

    link_started = time.perf_counter()
    final_homologies: List[Tuple[str, str]] = []
    if ref_genes and target_genes:
        tgt_by_id = {g.id: g for g in target_genes}
        ref_order = {g.id: idx for idx, g in enumerate(sorted(ref_genes, key=lambda g: g.start))}
        tgt_order = {g.id: idx for idx, g in enumerate(sorted(target_genes, key=lambda g: g.start))}
        used_ref_ids: Set[str] = set()
        used_tgt_ids: Set[str] = set()
        seen_pairs: Set[Tuple[str, str]] = set()

        def add_pair(ref_id: str, tgt_id: str) -> bool:
            if not ref_id or not tgt_id:
                return False
            if ref_id in used_ref_ids or tgt_id in used_tgt_ids:
                return False
            pair = (ref_id, tgt_id)
            if pair in seen_pairs:
                return False
            final_homologies.append(pair)
            seen_pairs.add(pair)
            used_ref_ids.add(ref_id)
            used_tgt_ids.add(tgt_id)
            return True

        def normalized_symbol(gene: GeneSummary) -> str:
            return (gene.name or "").strip().lower()

        def pair_group_by_neighbourhood(ref_candidates: List[GeneSummary], tgt_candidates: List[GeneSummary]):
            remaining_tgts = sorted(tgt_candidates, key=lambda g: tgt_order.get(g.id, 10**9))
            for r_gene in sorted(ref_candidates, key=lambda g: ref_order.get(g.id, 10**9)):
                if r_gene.id in used_ref_ids:
                    continue
                if not remaining_tgts:
                    break
                r_idx = ref_order.get(r_gene.id, 0)
                best_idx = min(
                    range(len(remaining_tgts)),
                    key=lambda idx: abs(r_idx - tgt_order.get(remaining_tgts[idx].id, 0))
                )
                best_tgt = remaining_tgts.pop(best_idx)
                add_pair(r_gene.id, best_tgt.id)

        # Priority 1: exact gene ID matches.
        for r_gene in sorted(ref_genes, key=lambda g: ref_order.get(g.id, 10**9)):
            if r_gene.id in tgt_by_id:
                add_pair(r_gene.id, r_gene.id)

        # Priority 2: symbol matches with neighbourhood-order disambiguation.
        ref_symbol_groups: Dict[str, List[GeneSummary]] = {}
        tgt_symbol_groups: Dict[str, List[GeneSummary]] = {}
        for g in ref_genes:
            if g.id in used_ref_ids:
                continue
            sym = normalized_symbol(g)
            if sym:
                ref_symbol_groups.setdefault(sym, []).append(g)
        for g in target_genes:
            if g.id in used_tgt_ids:
                continue
            sym = normalized_symbol(g)
            if sym:
                tgt_symbol_groups.setdefault(sym, []).append(g)

        shared_symbols = set(ref_symbol_groups.keys()) & set(tgt_symbol_groups.keys())
        for sym in sorted(shared_symbols):
            refs = ref_symbol_groups[sym]
            tgts = tgt_symbol_groups[sym]
            if len(refs) == 1 and len(tgts) == 1:
                add_pair(refs[0].id, tgts[0].id)
        for sym in sorted(shared_symbols):
            refs = [g for g in ref_symbol_groups[sym] if g.id not in used_ref_ids]
            tgts = [g for g in tgt_symbol_groups[sym] if g.id not in used_tgt_ids]
            if refs and tgts:
                pair_group_by_neighbourhood(refs, tgts)

        if not final_homologies and ref_center and target_center:
            final_homologies.append((ref_center, target_center))
    link_ms = (time.perf_counter() - link_started) * 1000

    homology_links: List[HomologyLink] = []
    ref_homology_available = False
    target_homology_available = False
    if use_homology and ref_genes and target_genes:
        homology_started = time.perf_counter()

        ref_species_info = ref_context.get("species") or {}
        target_species_info = target_context.get("species") or {}
        ref_homology_path = str((ref_species_info.get("files") or {}).get("homology") or "").strip()
        target_homology_path = str((target_species_info.get("files") or {}).get("homology") or "").strip()
        ref_assembly_name = str(ref_species_info.get("assembly_name") or ref_species_info.get("assembly") or "").strip()
        target_assembly_name = str(target_species_info.get("assembly_name") or target_species_info.get("assembly") or "").strip()

        ref_homology_available = bool(ref_homology_path and os.path.exists(ref_homology_path))
        target_homology_available = bool(target_homology_path and os.path.exists(target_homology_path))

        ref_gene_id_set = {g.id for g in ref_genes}
        target_gene_id_set = {g.id for g in target_genes}
        merged_links: Dict[Tuple[str, str], Dict[str, Any]] = {}

        def merge_homology_row(ref_id: str, target_id: str, homology_type: str, perc_id: Any, perc_cov: Any):
            if ref_id not in ref_gene_id_set or target_id not in target_gene_id_set:
                return
            key = (ref_id, target_id)
            is_rbh = str(homology_type or "").strip().lower() == "homolog_rbbh"
            existing = merged_links.get(key)
            if existing is None:
                merged_links[key] = {
                    "ref_gene_id": ref_id,
                    "target_gene_id": target_id,
                    "homology_type": homology_type or "",
                    "is_rbh": is_rbh,
                    "perc_id": _parse_optional_float(perc_id),
                    "perc_cov": _parse_optional_float(perc_cov),
                }
            elif is_rbh and not existing["is_rbh"]:
                existing["is_rbh"] = True
                existing["homology_type"] = homology_type or existing["homology_type"]

        if ref_homology_available and target_assembly_name:
            ref_rows = await run_in_threadpool(
                homology_file_index.find_homology_pairs,
                ref_homology_path,
                ref_gene_id_set,
                target_assembly_name,
            )
            for row in ref_rows:
                merge_homology_row(
                    row["query_gene_id"],
                    row["ref_gene_stable_id"],
                    row.get("homology_type", ""),
                    row.get("query_perc_id"),
                    row.get("query_perc_cov"),
                )

        if target_homology_available and ref_assembly_name:
            target_rows = await run_in_threadpool(
                homology_file_index.find_homology_pairs,
                target_homology_path,
                target_gene_id_set,
                ref_assembly_name,
            )
            for row in target_rows:
                merge_homology_row(
                    row["ref_gene_stable_id"],
                    row["query_gene_id"],
                    row.get("homology_type", ""),
                    row.get("query_perc_id"),
                    row.get("query_perc_cov"),
                )

        homology_links = [HomologyLink(**link) for link in merged_links.values()]
        homology_ms = (time.perf_counter() - homology_started) * 1000
        log_progress(
            f"  Homology links: {len(homology_links)} (ref_available={ref_homology_available} "
            f"target_available={target_homology_available}, {homology_ms:.1f}ms)"
        )

    result = NeighbourhoodResponse(
        reference_genes=ref_genes,
        target_genes=target_genes,
        center_ref_id=ref_center,
        center_target_id=target_center,
        homologies=final_homologies,
        homology_links=homology_links,
        ref_homology_available=ref_homology_available,
        target_homology_available=target_homology_available,
        request_transcript_id=transcript_id,
        request_target_transcript_id=target_transcript_id,
        request_ref_gene_id=resolved_ref_gene,
        request_target_gene_id=resolved_target_gene,
    )
    _neighbourhood_cache[_cache_key] = (time.time(), result)

    total_ms = (time.perf_counter() - req_started) * 1000
    logger.info(
        "Neighbourhood timings ref=%s target=%s window=%s anchor=%.1fms ref=%.1fms target=%.1fms links=%.1fms total=%.1fms",
        resolved_ref_gene,
        resolved_target_gene or "",
        window_size,
        anchor_ms,
        ref_ms,
        tgt_ms,
        link_ms,
        total_ms,
    )
    return result


class HomologyAnchorHit(BaseModel):
    gene_id: str
    gene_name: str = ""
    homology_type: str = ""
    is_rbh: bool = False
    perc_id: Optional[float] = None
    perc_cov: Optional[float] = None


class HomologyAnchorResponse(BaseModel):
    primary_homology_available: bool = False
    hits: Dict[str, Optional[HomologyAnchorHit]] = {}


@app.get("/api/neighbourhood/homology_anchor", response_model=HomologyAnchorResponse)
async def get_neighbourhood_homology_anchor(
    genome: str,
    gene_id: str,
    target_genomes: str = "",
):
    """Given a focus gene already chosen in one genome, find its single best homology
    hit (by RBH preference, then identity/coverage) in each of several other genomes —
    used to auto-populate Neighbourhood View tracks that don't yet have a focus gene."""
    gid = str(gene_id or "").strip()
    if not gid:
        raise HTTPException(status_code=400, detail="gene_id is required")

    primary_context = _resolve_browse_genome_context(genome)
    primary_species = primary_context.get("species") or {}
    primary_homology_path = str((primary_species.get("files") or {}).get("homology") or "").strip()
    primary_available = bool(primary_homology_path and os.path.exists(primary_homology_path))

    target_keys = [t.strip() for t in str(target_genomes or "").split(",") if t.strip()]
    hits: Dict[str, Optional[HomologyAnchorHit]] = {key: None for key in target_keys}

    if primary_available:
        for target_key in target_keys:
            target_context = _resolve_browse_genome_context(target_key)
            target_species = target_context.get("species") or {}
            target_assembly_name = str(target_species.get("assembly_name") or target_species.get("assembly") or "").strip()
            if not target_assembly_name:
                continue
            rows = await run_in_threadpool(
                homology_file_index.find_homology_pairs,
                primary_homology_path,
                {gid},
                target_assembly_name,
            )
            if not rows:
                continue
            best = max(rows, key=_homology_row_score)
            hits[target_key] = HomologyAnchorHit(
                gene_id=best.get("ref_gene_stable_id", ""),
                gene_name=best.get("ref_gene_name", ""),
                homology_type=best.get("homology_type", ""),
                is_rbh=str(best.get("homology_type", "")).strip().lower() == "homolog_rbbh",
                perc_id=_parse_optional_float(best.get("query_perc_id")),
                perc_cov=_parse_optional_float(best.get("query_perc_cov")),
            )

    return HomologyAnchorResponse(primary_homology_available=primary_available, hits=hits)


def _resolve_index_path(gff_path: str, output_dir: str, fallback_name: str) -> Path:
    """Determine where to store a GFF3 index.

    If the GFF3 file lives inside the local_data directory tree
    (for example ``output_dir/local_data/<species>/<assembly>/`` or
    ``output_dir/local_data/ncbi/<species>/<assembly>/``), the index is placed
    alongside it as ``<assembly>.gff3.index.db``.

    Otherwise the index is kept next to the annotation it was built from, which
    is where users look for it and keeps a custom genome self-contained. Only
    when that directory cannot be written to does it fall back to a managed
    ``output_dir/indexes/`` folder — never to the bare output directory root,
    where index files for unrelated genomes used to accumulate.
    """
    gff = Path(gff_path).resolve()
    local_root = Path(output_dir).resolve() / "local_data"
    try:
        rel = gff.relative_to(local_root)
        provider, species_key, assembly = parse_local_data_relative_parts(rel.parts)
        if species_key and assembly:
            return gff.parent / f"{assembly}.gff3.index.db"
    except ValueError:
        pass  # gff_path is not under local_data

    if os.access(str(gff.parent), os.W_OK):
        return gff.parent / fallback_name

    managed = Path(output_dir) / "indexes"
    try:
        managed.mkdir(parents=True, exist_ok=True)
    except OSError:
        return Path(output_dir) / fallback_name
    return managed / fallback_name


def _index_basename_for_annotation(gff_path: str) -> str:
    """`braker.gtf.gz` -> `braker.gff3.index.db`."""
    return f"{annotation_name_stem(Path(gff_path).name)}.gff3.index.db"


class SingleIndexRequest(BaseModel):
    gff_path: str
    output_dir: Optional[str] = None
    index_path: Optional[str] = None


def _update_index_task(task_id: str, **updates: Any) -> None:
    with _index_tasks_guard:
        task = _index_tasks.get(task_id)
        if task is not None:
            task.update(updates)


def _index_worker_loop() -> None:
    while True:
        task_id, gff_path_str, target_index_str = _index_task_queue.get()
        try:
            _update_index_task(task_id, status="running", started_at=now_iso(), error=None)

            def on_progress(progress: Dict[str, Any], _task_id: str = task_id) -> None:
                _update_index_task(_task_id, progress=progress)

            db_path = ensure_gff_index(
                gff_path_str,
                target_index_str,
                force_rebuild=False,
                progress_cb=on_progress,
            )
            _update_index_task(task_id, status="success", index_path=db_path, completed_at=now_iso(), error=None)
        except Exception as exc:
            logger.error(f"Index generation failed for {gff_path_str}: {exc}")
            _update_index_task(task_id, status="failed", error=str(exc), completed_at=now_iso())
        finally:
            _prune_finished_index_tasks()
            _index_task_queue.task_done()


def _ensure_index_worker_started() -> None:
    global _index_worker_started
    with _index_worker_guard:
        if _index_worker_started:
            return
        worker = threading.Thread(target=_index_worker_loop, name="gff-index-worker", daemon=True)
        worker.start()
        _index_worker_started = True


#: Finished index tasks kept in the registry. They are the only record of why a
#: build failed, so a handful are retained, but the registry is process-lifetime
#: state and used to grow without limit.
MAX_FINISHED_INDEX_TASKS = 40


def _prune_finished_index_tasks() -> None:
    """Drop the oldest finished tasks once the registry has more than it needs."""
    with _index_tasks_guard:
        finished = [
            (str(task.get("completed_at") or ""), task_id)
            for task_id, task in _index_tasks.items()
            if task.get("status") in {"success", "failed"}
        ]
        if len(finished) <= MAX_FINISHED_INDEX_TASKS:
            return
        finished.sort()
        for _, task_id in finished[:len(finished) - MAX_FINISHED_INDEX_TASKS]:
            _index_tasks.pop(task_id, None)


def _annotation_signature(gff_path: str) -> str:
    """``mtime:size`` for an annotation, or ``""`` when it cannot be read.

    Recorded against a build so a failure can be tied to the exact file that
    produced it. Replace or repair the annotation and the signature moves on,
    which is what lets a genome recover from a bad download without a restart.
    """
    try:
        stat = os.stat(_normalize_fs_path(gff_path))
    except OSError:
        return ""
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def forget_index_failures(gff_path: str, db_path: str = "") -> int:
    """Discard remembered failures for an annotation. Returns how many went.

    Without this a single failed build wedges the genome for the lifetime of the
    process: :func:`_index_build_error_for` keeps finding the failed task, so
    browsing keeps reporting the old error and never queues another attempt.
    """
    normalized_gff = _normalize_fs_path(gff_path)
    normalized_db = _normalize_fs_path(db_path) if db_path else ""
    with _index_tasks_guard:
        doomed = [
            task_id
            for task_id, task in _index_tasks.items()
            if task.get("status") == "failed"
            and (
                task.get("gff_path") == normalized_gff
                or (normalized_db and task.get("db_path") == normalized_db)
            )
        ]
        for task_id in doomed:
            _index_tasks.pop(task_id, None)
    return len(doomed)


def _queued_index_positions() -> Dict[str, int]:
    """Task id -> its place in the queue, 1 for the build that is running.

    Indexing is deliberately serial — two multi-gigabyte parses at once starve
    everything else in the process — so a genome can sit untouched for minutes
    behind another one. Telling the browser where it is in the line is the
    difference between "queued behind Mus musculus" and an unexplained wait.
    """
    with _index_tasks_guard:
        running = [tid for tid, task in _index_tasks.items() if task.get("status") == "running"]
        queued = sorted(
            (
                (str(task.get("queued_at") or ""), tid)
                for tid, task in _index_tasks.items()
                if task.get("status") == "queued"
            )
        )
    positions = {tid: 1 for tid in running}
    offset = len(running) + 1
    for index, (_, tid) in enumerate(queued):
        positions[tid] = offset + index
    return positions


def queue_index_build(gff_path: str, db_path: str) -> Tuple[str, str]:
    """Hand a GFF3 index build to the background worker, reusing a live task.

    Returns ``(task_id, status)``. This is deliberately cheap and never waits for
    the build: it is called from request handlers that must answer immediately,
    including the browse endpoints, which report "not ready yet" rather than
    holding a connection open for the minutes a large annotation takes.

    A build already running for the same annotation is reused even when it is
    writing to a differently named index file. The selector and the browse path
    do not always name the target identically, and parsing a multi-gigabyte GFF3
    twice at once to produce two equivalent indexes helps nobody.
    """
    normalized_target = _normalize_fs_path(db_path)
    normalized_gff = _normalize_fs_path(gff_path)
    with _index_tasks_guard:
        for tid, task in _index_tasks.items():
            if task.get("status") not in {"queued", "running"}:
                continue
            if task.get("db_path") == normalized_target or task.get("gff_path") == normalized_gff:
                return tid, str(task.get("status") or "queued")

        task_id = str(uuid.uuid4())
        _index_tasks[task_id] = {
            "status": "queued",
            "db_path": normalized_target,
            "gff_path": normalized_gff,
            "gff_signature": _annotation_signature(normalized_gff),
            "index_path": None,
            "error": None,
            "progress": None,
            "queued_at": now_iso(),
        }

    _ensure_index_worker_started()
    _index_task_queue.put((task_id, str(gff_path), str(db_path)))
    return task_id, "queued"


@app.post("/api/index/generate-for-genome")
async def generate_index_for_genome(request: SingleIndexRequest):
    """Start a background GFF3 index build. Returns a task_id immediately.
    Poll GET /api/index/task-status/{task_id} for completion."""
    config = load_config()
    output_dir = request.output_dir or config.get("output_dir", "")

    if not request.gff_path or not os.path.exists(request.gff_path):
        raise HTTPException(status_code=400, detail=f"GFF3 file not found: {request.gff_path}")

    if request.index_path:
        target_index = Path(request.index_path).expanduser().resolve()
        target_parent = target_index.parent
        if not target_parent.exists():
            raise HTTPException(status_code=400, detail=f"Index directory does not exist: {target_parent}")
    else:
        if not output_dir or not os.path.exists(output_dir):
            raise HTTPException(status_code=400, detail="Output directory not set or does not exist.")
        fallback_name = _index_basename_for_annotation(request.gff_path)
        target_index = _resolve_index_path(request.gff_path, output_dir, fallback_name)

    task_id, status = queue_index_build(request.gff_path, str(target_index))
    return {"task_id": task_id, "status": status}


@app.get("/api/index/task-status/{task_id}")
def index_task_status(task_id: str):
    """Poll status of a background index build started by /api/index/generate-for-genome."""
    with _index_tasks_guard:
        task = _index_tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {
        "task_id": task_id,
        "status": task["status"],
        "index_path": task.get("index_path"),
        "error": task.get("error"),
        "queued_at": task.get("queued_at"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
    }


# ── Custom genome / annotation validation ───────────────────────────────────
# These endpoints are read-only: they scan a user-supplied file and describe it.
# Nothing here writes to the assembly, and nothing here feeds the browsing index,
# which is still built by create_gff_index from the original file.

class ValidateGenomeRequest(BaseModel):
    fasta_path: str


class ValidateAnnotationRequest(BaseModel):
    annotation_path: str
    fasta_path: Optional[str] = None


def _resolve_user_file(path_value: str, label: str) -> Path:
    """Resolve a user-supplied path and confirm it is a readable file."""
    token = str(path_value or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="{0} path is required".format(label))
    resolved = Path(token).expanduser()
    try:
        resolved = resolved.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="Invalid {0} path: {1}".format(label, exc))
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="{0} file not found: {1}".format(label, resolved))
    if not os.access(str(resolved), os.R_OK):
        raise HTTPException(status_code=403, detail="{0} file is not readable".format(label))
    return resolved


def _update_validation_task(task_id: str, **updates: Any) -> None:
    with _validation_tasks_guard:
        task = _validation_tasks.get(task_id)
        if task is not None:
            task.update(updates)


def _trim_validation_tasks() -> None:
    """Drop the oldest finished tasks once the registry grows past its limit."""
    with _validation_tasks_guard:
        if len(_validation_tasks) <= _VALIDATION_TASK_LIMIT:
            return
        finished = [
            (task.get("completed_at") or "", task_id)
            for task_id, task in _validation_tasks.items()
            if task.get("status") in {"success", "failed"}
        ]
        finished.sort()
        for _, task_id in finished[: len(_validation_tasks) - _VALIDATION_TASK_LIMIT]:
            _validation_tasks.pop(task_id, None)


def _run_validation_task(task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    kind = str(payload.get("kind") or "")
    # The file-reading phases hand the interpreter back from inside their own
    # loops. The phases that work on what was read — building gene models,
    # summarising — have no such loop to hook, so they yield here, on the
    # progress reports they already make. See annotation/cooperative.py.
    yielder = CooperativeYielder()

    if kind == "genome":
        def _progress(read_bytes: int, total_bytes: int) -> None:
            yielder.tick()
            percent = (read_bytes / float(total_bytes) * 100.0) if total_bytes else 0.0
            # Name the stage as well as the percentage: without it the panel
            # keeps showing "Starting" for the several minutes a whole genome
            # takes to read, which reads as a stall rather than as progress.
            _update_validation_task(
                task_id,
                stage="scanning_genome",
                message="Reading genome sequences",
                progress=round(min(percent, 99.9), 1),
            )

        report = scan_fasta(str(payload["fasta_path"]), progress_callback=_progress)
        return report.as_dict()

    if kind == "prepare":
        def _prepare_progress(
            stage: str,
            progress: float,
            message: str,
            counters: Dict[str, int],
        ) -> None:
            yielder.tick()
            _update_validation_task(
                task_id,
                stage=stage,
                progress=round(max(0.0, min(float(progress), 99.9)), 1),
                message=message,
                counters=dict(counters or {}),
            )

        return prepare_annotation(
            str(payload["annotation_path"]),
            fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
            id_mode=str(payload.get("id_mode") or "keep"),
            id_prefix=str(payload.get("id_prefix") or ""),
            progress_callback=_prepare_progress,
        )

    if kind == "conversion":
        def _conversion_progress(
            stage: str,
            progress: float,
            message: str,
            counters: Dict[str, int],
        ) -> None:
            yielder.tick()
            _update_validation_task(
                task_id,
                stage=stage,
                progress=round(max(0.0, min(float(progress), 99.9)), 1),
                message=message,
                counters=dict(counters or {}),
            )

        result = convert_annotation(
            str(payload["annotation_path"]),
            str(payload["output_dir"]),
            fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
            id_mode=str(payload.get("id_mode") or "keep"),
            id_prefix=str(payload.get("id_prefix") or ""),
            compress=bool(payload.get("compress", True)),
            progress_callback=_conversion_progress,
        )
        return result.as_dict()

    def _annotation_progress(
        stage: str,
        progress: float,
        message: str,
        counters: Dict[str, int],
    ) -> None:
        yielder.tick()
        _update_validation_task(
            task_id,
            stage=stage,
            progress=round(max(0.0, min(float(progress), 99.9)), 1),
            message=message,
            counters=dict(counters or {}),
        )

    report = build_annotation_report(
        str(payload["annotation_path"]),
        fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
        progress_callback=_annotation_progress,
    )
    return report.as_dict()


def _validation_worker_loop() -> None:
    while True:
        task_id, payload = _validation_task_queue.get()
        try:
            _update_validation_task(
                task_id,
                status="running",
                stage="starting",
                message="Starting",
                started_at=now_iso(),
                error=None,
            )
            result = _run_validation_task(task_id, payload)
            _update_validation_task(
                task_id,
                status="success",
                report=result,
                progress=100.0,
                stage="complete",
                message="Complete",
                completed_at=now_iso(),
                error=None,
            )
        except Exception as exc:
            logger.error("Validation task %s failed: %s", task_id, exc)
            _update_validation_task(
                task_id, status="failed", error=str(exc), completed_at=now_iso()
            )
        finally:
            _validation_task_queue.task_done()
            _trim_validation_tasks()


def _ensure_validation_worker_started() -> None:
    global _validation_worker_started
    with _validation_worker_guard:
        if _validation_worker_started:
            return
        worker = threading.Thread(
            target=_validation_worker_loop, name="validation-worker", daemon=True
        )
        worker.start()
        _validation_worker_started = True


def _queue_validation(kind: str, payload: Dict[str, Any], target: str) -> Dict[str, str]:
    task_id = str(uuid.uuid4())
    with _validation_tasks_guard:
        _validation_tasks[task_id] = {
            "status": "queued",
            "kind": kind,
            "target": target,
            "progress": 0.0,
            "stage": "queued",
            "message": "Queued",
            "counters": {},
            "report": None,
            "error": None,
            "queued_at": now_iso(),
        }
    _ensure_validation_worker_started()
    _validation_task_queue.put((task_id, dict(payload, kind=kind)))
    return {"task_id": task_id, "status": "queued"}


@app.post("/api/custom/validate-genome")
async def validate_custom_genome(request: ValidateGenomeRequest):
    """Scan a FASTA and report its sequence and base composition statistics."""
    fasta_path = _resolve_user_file(request.fasta_path, "FASTA")
    return _queue_validation("genome", {"fasta_path": str(fasta_path)}, str(fasta_path))


@app.post("/api/custom/validate-annotation")
async def validate_custom_annotation(request: ValidateAnnotationRequest):
    """Parse an annotation file and report what can be modelled from it.

    Accepts GFF3, GTF and AUGUSTUS-native output. Passing ``fasta_path`` enables
    the sequence-region cross-checks, which is where most silent failures live.
    """
    annotation_path = _resolve_user_file(request.annotation_path, "Annotation")
    payload: Dict[str, Any] = {"annotation_path": str(annotation_path)}
    if request.fasta_path:
        payload["fasta_path"] = str(_resolve_user_file(request.fasta_path, "FASTA"))
    return _queue_validation("annotation", payload, str(annotation_path))


@app.get("/api/custom/validation/{task_id}")
def custom_validation_status(task_id: str):
    """Poll a validation task; the report is included once the status is success."""
    with _validation_tasks_guard:
        task = _validation_tasks.get(task_id)
        snapshot = dict(task) if task is not None else None
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Validation task not found")
    return {
        "task_id": task_id,
        "status": snapshot.get("status"),
        "kind": snapshot.get("kind"),
        "target": snapshot.get("target"),
        "progress": snapshot.get("progress"),
        "stage": snapshot.get("stage"),
        "message": snapshot.get("message"),
        "counters": snapshot.get("counters") or {},
        "report": snapshot.get("report"),
        "error": snapshot.get("error"),
        "queued_at": snapshot.get("queued_at"),
        "started_at": snapshot.get("started_at"),
        "completed_at": snapshot.get("completed_at"),
    }


class ConvertAnnotationRequest(BaseModel):
    annotation_path: str
    output_dir: str
    fasta_path: Optional[str] = None
    id_mode: str = "keep"
    id_prefix: str = ""
    compress: bool = True


@app.post("/api/custom/convert-annotation")
async def convert_custom_annotation(request: ConvertAnnotationRequest):
    """Normalise an annotation into canonical GFF3 without registering it.

    Used to preview a conversion, or to produce a file the user can inspect
    before importing. The import path runs the same conversion internally.
    """
    annotation_path = _resolve_user_file(request.annotation_path, "Annotation")
    output_dir = Path(str(request.output_dir or "").strip()).expanduser()
    if not str(output_dir):
        raise HTTPException(status_code=400, detail="output_dir is required")
    try:
        output_dir = output_dir.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid output_dir: {exc}")
    if output_dir.exists() and not output_dir.is_dir():
        raise HTTPException(status_code=400, detail="output_dir is not a directory")

    payload: Dict[str, Any] = {
        "annotation_path": str(annotation_path),
        "output_dir": str(output_dir),
        "id_mode": request.id_mode or "keep",
        "id_prefix": request.id_prefix or "",
        "compress": bool(request.compress),
    }
    if request.fasta_path:
        payload["fasta_path"] = str(_resolve_user_file(request.fasta_path, "FASTA"))

    # Fail fast on a bad prefix rather than surfacing it as a task failure.
    if (request.id_mode or "keep").strip().lower() == "generate":
        try:
            annotation_normalize_prefix(request.id_prefix or "")
        except IdentifierError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return _queue_validation("conversion", payload, str(annotation_path))


@app.get("/api/custom/conversion/{task_id}")
def custom_conversion_status(task_id: str):
    """Poll a conversion task; alias of the validation poll for a clearer URL."""
    return custom_validation_status(task_id)


class PrepareAnnotationRequest(BaseModel):
    annotation_path: str
    fasta_path: Optional[str] = None
    id_mode: str = "keep"
    id_prefix: str = ""


@app.post("/api/custom/prepare-annotation")
async def prepare_custom_annotation(request: PrepareAnnotationRequest):
    """Return the annotation path that should be indexed, converting if needed.

    Called when a genome is added from local files. A GFF3 the existing indexer
    already handles is passed straight through; anything that needs its gene
    model rebuilt — GTF, CDS-only output, files with no gene rows — is converted
    into canonical GFF3 next to the source first. Without this the indexer would
    silently produce an empty gene track.
    """
    annotation_path = _resolve_user_file(request.annotation_path, "Annotation")
    payload: Dict[str, Any] = {
        "annotation_path": str(annotation_path),
        "id_mode": request.id_mode or "keep",
        "id_prefix": request.id_prefix or "",
    }
    if request.fasta_path:
        payload["fasta_path"] = str(_resolve_user_file(request.fasta_path, "FASTA"))

    if (request.id_mode or "keep").strip().lower() == "generate":
        try:
            annotation_normalize_prefix(request.id_prefix or "")
        except IdentifierError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return _queue_validation("prepare", payload, str(annotation_path))


class ManualGenomeConfigReadRequest(BaseModel):
    path: str


class ManualGenomeConfigSaveRequest(BaseModel):
    path: str
    genomes: List[Dict[str, Any]]
    playlists: Optional[List[Dict[str, Any]]] = None
    # "create" refuses to touch an existing file so the UI can offer a choice.
    mode: str = "create"


@app.post("/api/custom/genome-config/read")
async def read_manual_genome_config(request: ManualGenomeConfigReadRequest):
    """Read and validate a portable genome bundle."""
    source = validate_config_export_path(request.path)
    try:
        return await run_in_threadpool(parse_manual_genome_config, str(source))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/custom/genome-config/save")
async def write_manual_genome_config(request: ManualGenomeConfigSaveRequest):
    """Atomically save a set of registered genomes as a portable bundle."""
    destination = validate_config_export_path(request.path)
    try:
        return await run_in_threadpool(
            save_manual_genome_config,
            str(destination),
            request.genomes,
            request.playlists,
            request.mode,
        )
    except FileExistsError as exc:
        # 409 so the UI can offer replace-or-amend instead of clobbering.
        raise HTTPException(
            status_code=409,
            detail=f"{Path(str(exc)).name} already exists.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not save configuration: {exc}",
        ) from exc


@app.get("/api/custom/sniff-annotation")
def custom_sniff_annotation(path: str):
    """Cheap format probe for the file picker — reads only the head of the file."""
    annotation_path = _resolve_user_file(path, "Annotation")
    return sniff_annotation(str(annotation_path)).as_dict()


@app.post("/api/index/generate")
async def generate_indexes(request: IndexRequest):
    """Generate GFF3 indices.

    Runs on a worker thread. Building an index takes minutes on a large
    annotation, and doing that on the event loop stopped the process answering
    anything at all for the duration — including the readiness polls that were
    the only sign the build was progressing.
    """
    return await run_in_threadpool(_generate_indexes_blocking, request)


def _generate_indexes_blocking(request: IndexRequest):
    config = load_config()
    
    # Use request params if provided (for unsaved UI state), else config
    output_dir = request.output_dir or config.get("output_dir")
    
    if not output_dir:
        raise HTTPException(status_code=400, detail="Output directory not set.")
        
    # Validating existence - if it doesn't exist, should we create it?
    # The prompt implied it exists, but let's be safe and try to create it if it doesn't,
    # or just check existence if strictly required.
    # The error message said "not set or does not exist".
    if not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Output directory {output_dir} does not exist and could not be created.")
        
    ref_gff = request.ref_gff or config.get("ref_gff")
    target_gff = request.target_gff or config.get("target_gff")
    
    if not ref_gff or not os.path.exists(ref_gff):
        raise HTTPException(status_code=400, detail="Reference GFF3 not found.")
        
    updated_config = config.copy()
    # Update with the values we actually used, to ensure persistence
    updated_config["output_dir"] = output_dir
    updated_config["ref_gff"] = ref_gff
    if target_gff: updated_config["target_gff"] = target_gff
    
    ref_fasta = updated_config.get("ref_fasta", "")
    target_fasta = updated_config.get("target_fasta", "")

    try:
        # Generate Reference Index
        ref_db = _resolve_index_path(ref_gff, output_dir, "ref_index.db")
        updated_config["ref_index"] = ensure_gff_index(ref_gff, str(ref_db), force_rebuild=True)

        # Prepare Reference FASTA (decompress gzip if needed + index)
        if ref_fasta and os.path.exists(ref_fasta):
            log_progress("Preparing reference FASTA for sequence browsing...")
            ensure_fasta_index(ref_fasta)

        # Generate Target Index (if available)
        if target_gff and os.path.exists(target_gff):
            target_db = _resolve_index_path(target_gff, output_dir, "target_index.db")
            updated_config["target_index"] = ensure_gff_index(target_gff, str(target_db), force_rebuild=True)

        # Prepare Target FASTA (decompress gzip if needed + index)
        if target_fasta and os.path.exists(target_fasta):
            log_progress("Preparing target FASTA for sequence browsing...")
            ensure_fasta_index(target_fasta)

        # Save config
        save_config(updated_config)

        return {"status": "success", "message": "Indexes generated successfully", "ref_index": str(ref_db)}

    except Exception as e:
        logger.error(f"Indexing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


CONFIG_FILE = CACHE_DIR / "config.json"
OUTPUT_DIR_CONFIG_FILENAME = "configuration.json"
OUTPUT_DIR_PLAYLISTS_FILENAME = "genome_playlists.json"

DEFAULT_CONFIG = {
    "working_dir": "",
    "ref_fasta": "",
    "ref_gff": "",
    "target_fasta": "",
    "target_gff": "",
    "homologies_file": "",
    "output_dir": "",
    "ref_index": "",
    "target_index": "",
    "default_light_mode": False,
    "dim_non_selected_genes": True,
    "show_fps_counter": False,
    # How pan/zoom gestures behave in the genome browser. One of the ids in
    # frontend/src/utils/browsingControls.js; unknown values fall back to
    # "default" on the frontend, so no server-side validation is needed.
    "browsing_control_scheme": "default",
    "sv_hide_inactive_tracks": False,
    "enable_sv_rust_render_bar": False,
    # Paths of SV alignment config files the user has attached. Persisted so a
    # loaded config survives a restart rather than having to be re-opened.
    "sv_config_paths": [],
    "active_species": [],
    "next_previous_session_genomes": [],
    "manual_species": [],
    "genome_file_overrides": {},
    "genome_analysis_reports": {},
    "deregistered_genome_keys": [],
    "genome_playlists": [],
    "selected_genome_playlist_id": "__all__",
    # Superseded by the three keys below: colour used to be a property of a
    # genome's position among the active set. Kept so that a configuration
    # written before the change can still be read, and migrated on the frontend
    # the first time it is loaded (see genomeColorSchemes.js).
    "genome_browser_colors": [],
    # The colour a genome is drawn in until it is given one of its own.
    "genome_default_color": "#3366cc",
    # assembly key -> hex colour, for the genomes that have been given one.
    "genome_colors": {},
    # Colours the user mixed themselves, offered beside the built-in palette.
    "genome_color_palette": [],
    "active_app_buttons": [
        "home",
        "genome_selector",
        "genome_browser",
        "track_manager",
        "feature_explorer",
        "alignment",
        "neighbourhood",
        "structural_variation",
        "homology",
        "stats",
        "notes",
        "download",
        "configuration",
        "help",
        "genome_playlist",
        "theme_toggle",
        "screenshot_toggle",
    ],
}

RECOGNIZED_CONFIG_KEYS = set(DEFAULT_CONFIG.keys())


def _looks_like_assembly_accession(value: Any) -> bool:
    return bool(re.match(r"^GC[AF]_\d+(?:\.\d+)?$", str(value or "").strip(), re.IGNORECASE))


def _is_useful_assembly_name(value: Any, accession: Any = "") -> bool:
    token = str(value or "").strip()
    if not token:
        return False
    if _looks_like_assembly_accession(token):
        return False
    return token.lower() != str(accession or "").strip().lower()


def _format_species_key_for_display(value: Any) -> str:
    words = [part for part in re.split(r"[_\s]+", str(value or "").strip()) if part]
    return " ".join(word[:1].upper() + word[1:].lower() for word in words)


def _find_catalog_species_key(species_key: Any) -> str:
    key = str(species_key or "").strip()
    if not key:
        return ""
    species_data = getattr(download_manager, "species_data", {}) or {}
    if key in species_data:
        return key
    lowered = key.lower()
    for candidate in species_data.keys():
        if str(candidate).lower() == lowered:
            return str(candidate)
    return key


def _catalog_genome_metadata(species_key: Any, assembly: Any, provider: Any = DEFAULT_PROVIDER) -> Dict[str, str]:
    if normalize_provider(str(provider or DEFAULT_PROVIDER)) != DEFAULT_PROVIDER:
        return {}
    key = _find_catalog_species_key(species_key)
    assembly_token = str(assembly or "").strip()
    if not key or not assembly_token:
        return {}
    info = (getattr(download_manager, "species_data", {}) or {}).get(key) or {}
    if not isinstance(info, dict):
        return {}
    assemblies = info.get("assemblies") or {}
    assembly_info = assemblies.get(assembly_token) or {}
    if not isinstance(assembly_info, dict):
        assembly_info = {}
    try:
        if getattr(download_manager, "_species_cache", None) is None:
            download_manager._build_cache()
        summary = next((item for item in (download_manager._species_cache or []) if item.key == key), None)
    except Exception:
        summary = None
    return {
        "species_key": key,
        "assembly": assembly_token,
        "scientific_name": str(info.get("scientific_name") or "").strip(),
        "common_name": str(info.get("common_name") or "").strip(),
        "display_name": str(getattr(summary, "display_name", "") or info.get("display_name") or "").strip(),
        "display_name_reason": str(getattr(summary, "display_name_reason", "") or info.get("display_name_reason") or "").strip(),
        "assembly_name": str(assembly_info.get("name") or "").strip(),
    }


def _genome_key_match_candidates(item: Any) -> Set[str]:
    candidates: Set[str] = set()
    if isinstance(item, str):
        token = item.strip()
        if token:
            candidates.add(token)
            assembly_token = strip_dataset_release_from_selection_key(token)
            if assembly_token and assembly_token != token:
                candidates.add(assembly_token)
            provider, species_key, assembly = parse_genome_key(token)
            if species_key and assembly:
                candidates.add(build_provider_aware_genome_key(species_key, assembly, provider))
                candidates.add(legacy_genome_key(species_key, assembly))
                candidates.add(assembly)
        return {candidate for candidate in candidates if candidate}
    if isinstance(item, dict):
        for candidate in genome_key_candidates(item):
            candidates.add(candidate)
        key = str(item.get("key") or "").strip()
        if key:
            candidates.update(_genome_key_match_candidates(key))
        selection = str(item.get("selection_key") or "").strip()
        if selection:
            candidates.update(_genome_key_match_candidates(selection))
        assembly_key = str(item.get("assembly_key") or "").strip()
        if assembly_key:
            candidates.update(_genome_key_match_candidates(assembly_key))
        assembly = str(item.get("assembly") or item.get("gca") or "").strip()
        if assembly:
            candidates.add(assembly)
    return {candidate for candidate in candidates if candidate}


def _genome_keys_match_local(left: Any, right: Any) -> bool:
    left_candidates = _genome_key_match_candidates(left)
    right_candidates = _genome_key_match_candidates(right)
    return bool(left_candidates and right_candidates and left_candidates.intersection(right_candidates))


def _genome_key_display_metadata(genome_key: Any, config: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    provider, species_key, assembly = parse_genome_key(str(genome_key or ""))
    if not species_key or not assembly:
        return {}

    def _candidate_from_item(item: Dict[str, Any]) -> Optional[Dict[str, str]]:
        if not isinstance(item, dict):
            return None
        try:
            if not _genome_keys_match_local(item, str(genome_key or "")):
                return None
        except Exception:
            return None
        return {
            "species_key": str(item.get("species_key") or species_key).strip(),
            "assembly": str(item.get("assembly") or item.get("gca") or assembly).strip(),
            "scientific_name": str(item.get("scientific_name") or "").strip(),
            "common_name": str(item.get("common_name") or "").strip(),
            "display_name": str(item.get("display_name") or "").strip(),
            "display_name_reason": str(item.get("display_name_reason") or "").strip(),
            "assembly_name": str(item.get("assembly_name") or "").strip(),
        }

    candidates: List[Dict[str, str]] = []
    if isinstance(config, dict):
        for item in list(config.get("active_species") or []) + list(config.get("manual_species") or []):
            candidate = _candidate_from_item(item)
            if candidate:
                candidates.append(candidate)
        for playlist in config.get("genome_playlists") or []:
            for item in (playlist or {}).get("genomes") or []:
                candidate = _candidate_from_item(item)
                if candidate:
                    candidates.append(candidate)

    catalog = _catalog_genome_metadata(species_key, assembly, provider)
    if catalog:
        candidates.append(catalog)

    species_label = ""
    common_name = ""
    scientific_name = ""
    display_name = ""
    display_name_reason = ""
    assembly_name = ""
    for candidate in candidates:
        if not display_name and candidate.get("display_name"):
            display_name = candidate["display_name"]
            display_name_reason = candidate.get("display_name_reason") or ""
        if not common_name and candidate.get("common_name"):
            common_name = candidate["common_name"]
        if not scientific_name and candidate.get("scientific_name"):
            scientific_name = candidate["scientific_name"]
        candidate_assembly_name = candidate.get("assembly_name")
        if not assembly_name and _is_useful_assembly_name(candidate_assembly_name, assembly):
            assembly_name = candidate_assembly_name
    if catalog.get("scientific_name"):
        scientific_name = catalog["scientific_name"]
    if catalog.get("common_name"):
        common_name = catalog["common_name"]
    if catalog.get("display_name"):
        display_name = catalog["display_name"]
        display_name_reason = catalog.get("display_name_reason") or display_name_reason

    species_label = display_name or common_name or scientific_name or _format_species_key_for_display(species_key)
    assembly_label = assembly_name or assembly
    display_parts = [species_label]
    if assembly_label:
        display_parts.append(assembly_label)
    if assembly and assembly.lower() != str(assembly_label or "").lower():
        display_parts.append(assembly)
    return {
        "species_key": species_key,
        "assembly": assembly,
        "scientific_name": scientific_name or _format_species_key_for_display(species_key),
        "common_name": common_name,
        "display_name": display_name or species_label,
        "display_name_reason": display_name_reason or ("unique_common" if common_name and species_label == common_name else "missing_common"),
        "assembly_name": assembly_label,
        "species_label": species_label,
        "label": " - ".join(display_parts),
    }


def _enrich_config_genome_labels(config: Dict[str, Any]) -> Dict[str, Any]:
    enriched = json.loads(json.dumps(config))
    collections: List[List[Dict[str, Any]]] = []
    for section in ("active_species", "next_previous_session_genomes", "manual_species"):
        items = enriched.get(section)
        if isinstance(items, list):
            collections.append(items)
    for playlist in enriched.get("genome_playlists") or []:
        genomes = playlist.get("genomes") if isinstance(playlist, dict) else None
        if isinstance(genomes, list):
            collections.append(genomes)

    for items in collections:
        for item in items:
            if not isinstance(item, dict):
                continue
            genome_key = build_provider_aware_genome_key(
                item.get("species_key"),
                item.get("assembly") or item.get("gca") or item.get("assembly_name"),
                item.get("provider"),
                is_manual=bool(item.get("is_manual")),
            ) or legacy_genome_key(item.get("species_key"), item.get("assembly") or item.get("gca") or item.get("assembly_name"))
            metadata = _genome_key_display_metadata(genome_key, enriched)
            if not metadata:
                continue
            if metadata.get("scientific_name"):
                item["scientific_name"] = metadata["scientific_name"]
            if metadata.get("common_name"):
                item["common_name"] = metadata["common_name"]
            if metadata.get("display_name"):
                item["display_name"] = metadata["display_name"]
            if metadata.get("display_name_reason"):
                item["display_name_reason"] = metadata["display_name_reason"]
            if _is_useful_assembly_name(metadata.get("assembly_name"), item.get("assembly")):
                item["assembly_name"] = metadata["assembly_name"]
    return enriched


def _output_dir_playlist_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return _resolve_local_data_root(output_dir_text) / OUTPUT_DIR_PLAYLISTS_FILENAME
    except Exception:
        return None


def _output_dir_config_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return _resolve_local_data_root(output_dir_text) / OUTPUT_DIR_CONFIG_FILENAME
    except Exception:
        return None


def _config_store_paths_for_config(config: Dict[str, Any]) -> List[Path]:
    paths: List[Path] = []
    seen: Set[str] = set()
    for key in ("output_dir", "working_dir"):
        path = _output_dir_config_store_path(config.get(key))
        if not path:
            continue
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        paths.append(path)
    return paths


def _playlist_store_paths_for_config(config: Dict[str, Any]) -> List[Path]:
    paths: List[Path] = []
    seen: Set[str] = set()
    for key in ("output_dir", "working_dir"):
        path = _output_dir_playlist_store_path(config.get(key))
        if not path:
            continue
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        paths.append(path)
    return paths


def _normalize_output_dir_playlist_state(data: Any) -> Dict[str, Any]:
    if isinstance(data, list):
        playlists = data
        selected_id = "__all__"
    elif isinstance(data, dict):
        playlists = data.get("genome_playlists") or []
        selected_id = str(data.get("selected_genome_playlist_id") or "__all__").strip() or "__all__"
    else:
        playlists = []
        selected_id = "__all__"

    if not isinstance(playlists, list):
        playlists = []
    playlist_ids = {
        str(playlist.get("id") or "").strip()
        for playlist in playlists
        if isinstance(playlist, dict) and str(playlist.get("id") or "").strip()
    }
    if selected_id != "__all__" and selected_id not in playlist_ids:
        selected_id = "__all__"
    return {
        "genome_playlists": playlists,
        "selected_genome_playlist_id": selected_id,
    }


def _normalize_output_dir_config_state(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    candidate = data.get("config") if isinstance(data.get("config"), dict) else data
    return {
        key: value
        for key, value in candidate.items()
        if key in RECOGNIZED_CONFIG_KEYS
    }


def _load_config_state_from_path(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as f:
            state = _normalize_output_dir_config_state(json.load(f))
        return state or None
    except Exception as exc:
        logger.warning(f"Failed to load configuration from {path}: {exc}")
        return None


def _load_config_state_for_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for path in _config_store_paths_for_config(config):
        if not path.exists() or not path.is_file():
            continue
        state = _load_config_state_from_path(path)
        if state:
            return state
    return None


def _merge_output_dir_config_state(config: Dict[str, Any]) -> Dict[str, Any]:
    state = _load_config_state_for_config(config)
    if not state:
        return config
    path_fields = {
        key: config.get(key)
        for key in ("output_dir", "working_dir")
        if str(config.get(key) or "").strip()
    }
    return {
        **config,
        **state,
        **path_fields,
    }


def _save_output_dir_config_state(config: Dict[str, Any]) -> None:
    paths = _config_store_paths_for_config(config)
    if not paths:
        return
    state = {
        key: config.get(key, default)
        for key, default in DEFAULT_CONFIG.items()
    }
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                    json.dump({
                        "version": 1,
                        "config": state,
                    }, f, indent=2)
                os.replace(tmp_path, path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as exc:
            logger.warning(f"Failed to persist configuration to {path}: {exc}")


def _ensure_output_dir_config_state(config: Dict[str, Any]) -> None:
    paths = _config_store_paths_for_config(config)
    if not paths:
        return
    if all(path.exists() for path in paths):
        return
    _save_output_dir_config_state(config)


def _load_output_dir_playlist_state(output_dir: Any) -> Optional[Dict[str, Any]]:
    path = _output_dir_playlist_store_path(output_dir)
    if not path or not path.exists() or not path.is_file():
        return None
    return _load_playlist_state_from_path(path)


def _load_playlist_state_from_path(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as f:
            return _normalize_output_dir_playlist_state(json.load(f))
    except Exception as exc:
        logger.warning(f"Failed to load genome playlists from {path}: {exc}")
        return None


def _load_playlist_state_for_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    empty_state: Optional[Dict[str, Any]] = None
    for path in _playlist_store_paths_for_config(config):
        if not path.exists() or not path.is_file():
            continue
        state = _load_playlist_state_from_path(path)
        if not state:
            continue
        if state.get("genome_playlists"):
            return state
        if empty_state is None:
            empty_state = state
    return empty_state


def _merge_output_dir_playlist_state(config: Dict[str, Any]) -> Dict[str, Any]:
    state = _load_playlist_state_for_config(config)
    if not state:
        return config
    if not state.get("genome_playlists") and config.get("genome_playlists"):
        return config
    return {
        **config,
        "genome_playlists": state["genome_playlists"],
        "selected_genome_playlist_id": state["selected_genome_playlist_id"],
    }


def _save_output_dir_playlist_state(config: Dict[str, Any]) -> None:
    paths = _playlist_store_paths_for_config(config)
    if not paths:
        return
    state = _normalize_output_dir_playlist_state({
        "genome_playlists": config.get("genome_playlists") or [],
        "selected_genome_playlist_id": config.get("selected_genome_playlist_id") or "__all__",
    })
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump({
                    "version": 1,
                    **state,
                }, f, indent=2)
        except Exception as exc:
            logger.warning(f"Failed to persist genome playlists to {path}: {exc}")


def _ensure_output_dir_playlist_state(config: Dict[str, Any]) -> None:
    if not config.get("genome_playlists"):
        return
    if all(path.exists() for path in _playlist_store_paths_for_config(config)):
        return
    _save_output_dir_playlist_state(config)


#: How long a loaded configuration may be reused. Long enough to collapse the
#: burst of reads a single round of browser polling causes, short enough that a
#: change made anywhere — including in the sidecar files this merges in, which
#: have no mtime of their own to watch — is picked up before anyone notices.
CONFIG_CACHE_TTL_SECONDS = 0.5

_config_cache_guard = threading.Lock()
#: ``(config file signature, loaded at, config)``
_config_cache: Optional[Tuple[Tuple[int, int], float, dict]] = None


def _config_file_signature() -> Tuple[int, int]:
    try:
        stat = CONFIG_FILE.stat()
    except OSError:
        return (0, 0)
    return (stat.st_mtime_ns, stat.st_size)


def invalidate_config_cache() -> None:
    """Drop the cached configuration. Called whenever the file is written."""
    global _config_cache
    with _config_cache_guard:
        _config_cache = None


def _load_config_uncached() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                saved = json.load(f)
            # Merge with defaults so new keys are always present
            merged = {**DEFAULT_CONFIG, **saved}
            merged = _merge_output_dir_config_state(merged)
            merged = _merge_output_dir_playlist_state(merged)
            _ensure_output_dir_config_state(merged)
            _ensure_output_dir_playlist_state(merged)
            return _enrich_config_genome_labels(merged)
        except Exception:
            pass
    return _enrich_config_genome_labels(dict(DEFAULT_CONFIG))


def load_config() -> dict:
    """Load config from disk, falling back to defaults.

    Reads are cached for :data:`CONFIG_CACHE_TTL_SECONDS`, keyed on the config
    file's mtime and size. Nearly every endpoint starts by loading the
    configuration, and while a genome indexes the browser polls several of them
    a second per panel; each of those was re-reading the file, re-merging two
    sidecars and re-deriving every genome's labels.

    Callers get a deep copy. Several of them mutate what they are handed, and a
    cache that returned the same object would let one endpoint's edits show up
    in another's.
    """
    global _config_cache
    signature = _config_file_signature()
    now = time.monotonic()
    with _config_cache_guard:
        cached = _config_cache
        if (
            cached is not None
            and cached[0] == signature
            and now - cached[1] < CONFIG_CACHE_TTL_SECONDS
        ):
            return copy.deepcopy(cached[2])

    loaded = _load_config_uncached()
    with _config_cache_guard:
        _config_cache = (signature, time.monotonic(), loaded)
    return copy.deepcopy(loaded)


def save_config(config: dict, path: Optional[Path] = None):
    """Persist config to disk using an atomic write (temp file + rename)."""
    if path is None:
        path = CONFIG_FILE
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(config, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    invalidate_config_cache()
    if path == CONFIG_FILE:
        _save_output_dir_config_state(config)
        _save_output_dir_playlist_state(config)


@app.get("/api/config")
async def get_config():
    return load_config()


@app.get("/api/config/output-dir")
async def get_output_dir_config(output_dir: str = "", working_dir: str = ""):
    """Load the configuration sidecar for a known output/working directory."""
    current_config = load_config()
    base_config = {
        **current_config,
        "output_dir": output_dir or current_config.get("output_dir", ""),
        "working_dir": working_dir or current_config.get("working_dir", ""),
    }
    state = _load_config_state_for_config(base_config)
    if not state:
        return {"found": False, "config": base_config}
    path_fields = {
        key: base_config.get(key)
        for key in ("output_dir", "working_dir")
        if str(base_config.get(key) or "").strip()
    }
    merged = {
        **base_config,
        **state,
        **path_fields,
    }
    merged = _merge_output_dir_playlist_state(merged)
    return {"found": True, "config": _enrich_config_genome_labels(merged)}


@app.get("/api/config/playlists")
async def get_config_playlists(output_dir: str = "", working_dir: str = ""):
    """Load genome playlists directly from the output/working directory sidecar."""
    current_config = load_config()
    base_config = {
        **current_config,
        "output_dir": output_dir or current_config.get("output_dir", ""),
        "working_dir": working_dir or current_config.get("working_dir", ""),
    }
    state = _load_playlist_state_for_config(base_config)
    if not state:
        state = {
            "genome_playlists": base_config.get("genome_playlists") or [],
            "selected_genome_playlist_id": base_config.get("selected_genome_playlist_id") or "__all__",
        }
    return state


class ConfigUpdate(BaseModel):
    working_dir: Optional[str] = None
    ref_fasta: Optional[str] = None
    ref_gff: Optional[str] = None
    target_fasta: Optional[str] = None
    target_gff: Optional[str] = None
    homologies_file: Optional[str] = None
    output_dir: Optional[str] = None
    ref_index: Optional[str] = None
    target_index: Optional[str] = None
    default_light_mode: Optional[bool] = None
    dim_non_selected_genes: Optional[bool] = None
    show_fps_counter: Optional[bool] = None
    browsing_control_scheme: Optional[str] = None
    sv_hide_inactive_tracks: Optional[bool] = None
    enable_sv_rust_render_bar: Optional[bool] = None
    active_species: Optional[List[Dict[str, Any]]] = None
    next_previous_session_genomes: Optional[List[Dict[str, Any]]] = None
    manual_species: Optional[List[Dict[str, Any]]] = None
    genome_file_overrides: Optional[Dict[str, Dict[str, Any]]] = None
    genome_analysis_reports: Optional[Dict[str, Dict[str, Any]]] = None
    deregistered_genome_keys: Optional[List[str]] = None
    genome_playlists: Optional[List[Dict[str, Any]]] = None
    selected_genome_playlist_id: Optional[str] = None
    genome_browser_colors: Optional[List[str]] = None
    genome_default_color: Optional[str] = None
    genome_colors: Optional[Dict[str, str]] = None
    genome_color_palette: Optional[List[str]] = None
    active_app_buttons: Optional[List[str]] = None
    clear_genome_playlists: Optional[bool] = None
    save_path: Optional[str] = None  # Optional path to save to


def _is_tutorial_workspace_path(value: Any) -> bool:
    """Whether a path is a tutorial's scratch directory rather than a real output dir."""
    text = str(value or "").strip()
    if not text:
        return False
    return Path(text).name == TUTORIAL_WORKSPACE_DIR


@app.post("/api/config")
async def update_config(config: ConfigUpdate):
    """Save configuration to disk. If save_path is provided, save there; otherwise save to default cache."""
    # A tutorial runs on a configuration overlay pointing at a scratch directory, and that
    # overlay must never become the saved configuration — it would survive the tutorial and
    # leave the user pointed at a directory that is about to be deleted. The frontend
    # already refuses these writes, but this is the guarantee: it does not depend on which
    # order two effects happen to run in.
    if _is_tutorial_workspace_path(getattr(config, "output_dir", "")):
        logger.warning("Refusing to save a configuration pointing at the tutorial workspace")
        return load_config()

    # Merge incoming fields over the existing saved config so that fields not present
    # in the ConfigUpdate model (e.g. ref_index / target_index written by generate_indexes)
    # are never silently dropped.
    existing = load_config()
    incoming = config.model_dump(exclude={"save_path", "clear_genome_playlists"})
    # Overwrite all incoming fields, including empty strings, so that the
    # frontend's cascade logic (clearing stale index paths etc.) is honoured.
    merged = {**existing, **{k: v for k, v in incoming.items() if v is not None}}
    incoming_fields = getattr(config, "model_fields_set", set())
    if "output_dir" in incoming_fields or "working_dir" in incoming_fields:
        previous_output_dir = str(existing.get("output_dir") or "").strip()
        next_output_dir = str(merged.get("output_dir") or "").strip()
        previous_working_dir = str(existing.get("working_dir") or "").strip()
        next_working_dir = str(merged.get("working_dir") or "").strip()
        incoming_playlists = incoming.get("genome_playlists")
        directory_changed = (
            ("output_dir" in incoming_fields and next_output_dir != previous_output_dir) or
            ("working_dir" in incoming_fields and next_working_dir != previous_working_dir)
        )
        if directory_changed:
            output_dir_config_state = _load_config_state_for_config(merged)
            if output_dir_config_state:
                path_fields = {
                    key: merged.get(key)
                    for key in ("output_dir", "working_dir")
                    if str(merged.get(key) or "").strip()
                }
                merged = {
                    **merged,
                    **output_dir_config_state,
                    **path_fields,
                }
                incoming_playlists = incoming_playlists or output_dir_config_state.get("genome_playlists")
        if directory_changed and not incoming_playlists:
            output_dir_state = _load_playlist_state_for_config(merged)
            if output_dir_state and output_dir_state.get("genome_playlists"):
                merged = {
                    **merged,
                    "genome_playlists": output_dir_state["genome_playlists"],
                    "selected_genome_playlist_id": output_dir_state["selected_genome_playlist_id"],
                }

    if (
        "genome_playlists" in incoming_fields
        and not config.clear_genome_playlists
        and not (incoming.get("genome_playlists") or [])
    ):
        preserved_playlist_state = None
        if existing.get("genome_playlists"):
            preserved_playlist_state = {
                "genome_playlists": existing.get("genome_playlists") or [],
                "selected_genome_playlist_id": existing.get("selected_genome_playlist_id") or "__all__",
            }
        else:
            preserved_playlist_state = _load_playlist_state_for_config(merged)
        if preserved_playlist_state and preserved_playlist_state.get("genome_playlists"):
            merged = {
                **merged,
                "genome_playlists": preserved_playlist_state["genome_playlists"],
                "selected_genome_playlist_id": preserved_playlist_state["selected_genome_playlist_id"],
            }

    if config.save_path:
        # Save to specific file (Export)
        save_path = validate_config_export_path(config.save_path)
        try:
            save_config(merged, save_path)
            log_progress(f"Configuration saved to: {save_path}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save to {save_path}: {e}")
    else:
        # Save to default cache (Auto-save / Session)
        save_config(merged)
        log_progress(f"Configuration cached: {merged}")

    return {"status": "ok", "config": merged}


class LoadConfigRequest(BaseModel):
    path: str


@app.post("/api/config/load")
async def load_custom_config(request: LoadConfigRequest):
    """Load configuration from a specific file."""
    path = validate_config_export_path(request.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Config file not found: {path}")
    
    try:
        with open(path) as f:
            data = json.load(f)
        # Ensure defaults are merged and ignore fields this version does not recognise.
        loaded_config = _normalize_output_dir_config_state(data)
        merged = {**DEFAULT_CONFIG, **loaded_config}
        
        # Also update session cache so auto-save works with loaded values
        save_config(merged)
        
        return merged
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load config: {e}")


@app.post("/api/cache/clear")
async def clear_cache():
    """Delete all cached alignment files."""
    count = 0
    for f in CACHE_DIR.glob("*.json"):
        if f.name == "config.json":
            continue  # Don't delete configuration
        try:
            f.unlink()
            count += 1
        except Exception:
            pass
    _neighbourhood_cache.clear()
    log_progress(f"Cleared {count} cached alignment files and neighbourhood cache")
    return {"status": "ok", "cleared": count}


class ClearDataRequest(BaseModel):
    output_dir: str


@app.post("/api/data/clear")
async def clear_local_data(request: ClearDataRequest):
    """Delete all downloaded genomes in the local_data directory."""
    if not request.output_dir:
        raise HTTPException(status_code=400, detail="Output directory not configured")
    
    local_data_dir = _resolve_local_data_root(request.output_dir)
    
    if not local_data_dir.exists():
        return {"status": "ok", "message": "Directory does not exist, nothing to clear"}
        
    try:
        import shutil
        shutil.rmtree(local_data_dir, ignore_errors=True)
        log_progress(f"Wiped local_data directory at {local_data_dir}")
        return {"status": "ok", "message": "All downloaded genomes have been cleared successfully"}
    except Exception as e:
        log_progress(f"Failed to wipe local_data directory: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete directory: {e}")
def _default_file_browser_path() -> Path:
    try:
        config = load_config()
        output_dir = str(config.get("output_dir") or "").strip()
        if output_dir:
            local_data = _resolve_local_data_root(output_dir)
            local_data.mkdir(parents=True, exist_ok=True)
            return local_data
    except Exception:
        pass
    return Path.home()


@app.get("/api/files/list")
async def list_files(path: str = "."):
    """List files and directories for the web file browser."""
    try:
        requested_path = str(path or "").strip()
        # Resolve path relative to home or absolute
        if requested_path == "~" or requested_path.startswith("~/"):
            target_path = Path(os.path.expanduser(requested_path))
        elif requested_path in {"", "."}:
            target_path = _default_file_browser_path()
        else:
            target_path = Path(requested_path)

        # The browser deliberately recovers from a missing path by showing its nearest
        # usable parent. Callers that are validating a typed directory still need to know
        # that recovery happened, or a typo such as /outputt silently becomes /.
        requested_path_valid = target_path.exists() and target_path.is_dir()
        
        if not target_path.exists():
             # Try to recover - maybe parent exists?
             if target_path.parent.exists():
                 target_path = target_path.parent
             else:
                 target_path = _default_file_browser_path()
        
        # Ensure we are listing a directory
        if not target_path.is_dir():
             target_path = target_path.parent

        items = []
        # Add parent directory entry
        if target_path.parent != target_path:
             items.append({
                 "name": "..",
                 "path": str(target_path.parent),
                 "is_dir": True,
                 "size": 0
             })

        # List contents. Skip entries we cannot inspect rather than failing the
        # whole browser, which can happen in system-managed folders on macOS.
        try:
            with os.scandir(target_path) as scanner:
                for entry in scanner:
                    if entry.name.startswith('.'):
                        continue
                    try:
                        is_dir = entry.is_dir()
                        size = 0 if is_dir else entry.stat().st_size
                    except OSError:
                        continue
                    items.append({
                        "name": entry.name,
                        "path": entry.path,
                        "is_dir": is_dir,
                        "size": size
                    })
        except PermissionError:
            fallback_path = _default_file_browser_path()
            if fallback_path != target_path and fallback_path.exists() and fallback_path.is_dir():
                return await list_files(str(fallback_path))
            raise
        
        # Sort: directories first, then files
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        
        return {
            "current_path": str(target_path.absolute()),
            "requested_path_valid": requested_path_valid,
            "items": items
        }
    except HTTPException:
        raise
    except Exception as e:
        # The detail is deliberately generic: the exception text carries
        # filesystem paths, which should stay in the local log.
        logger.error(f"Error listing directory {path}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list directory")


class MkdirRequest(BaseModel):
    path: str


@app.post("/api/files/mkdir")
async def create_directory(request: MkdirRequest):
    """Create one new directory inside a directory that already exists.

    The file browser only ever creates a single directory inside the directory the
    user is currently viewing, so the request is held to exactly that: an
    existing parent plus one leaf name. Creating whole nested trees at an
    arbitrary path is refused, which keeps this from being a general "write
    anywhere on disk" primitive while leaving external drives and other
    user-chosen locations usable.
    """
    raw = str(request.path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="path must not be empty")

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="path must be absolute")

    leaf = sanitize_leaf_filename(candidate.name)
    parent = candidate.parent.resolve()
    if not parent.is_dir():
        raise HTTPException(status_code=400, detail="Parent directory does not exist")

    target = parent / leaf
    if target.exists():
        return {"status": "exists", "path": str(target)}

    try:
        target.mkdir()
    except OSError as exc:
        logger.error("Error creating directory %s: %s", target, exc)
        raise HTTPException(status_code=400, detail="Failed to create directory")
    return {"status": "created", "path": str(target)}



# ============ Download / Remote Data API ============

@app.get("/api/remote/groups")
async def list_remote_groups(provider: str = DEFAULT_PROVIDER):
    """Return taxonomic groups with species counts."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        download_manager.schedule_catalog_refresh_if_stale()
    return download_manager.list_groups(provider=provider)

@app.get("/api/remote/species", response_model=List[SpeciesSummary])
async def list_remote_species(
    group: Optional[str] = None,
    sub_group: Optional[str] = None,
    provider: str = DEFAULT_PROVIDER,
):
    """List species, optionally filtered by group/sub_group."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        download_manager.schedule_catalog_refresh_if_stale()
    return download_manager.list_species(provider=provider, group=group, sub_group=sub_group)

@app.get("/api/remote/species/{key}")
async def get_remote_species_details(key: str, provider: str = DEFAULT_PROVIDER):
    """Get full details for a specific species."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        download_manager.schedule_catalog_refresh_if_stale()
    return download_manager.get_species_details(key, provider=provider)


@app.get("/api/remote/files/{key}/{assembly}/availability")
async def get_remote_file_availability(
    key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    include_directory_listing: bool = False,
):
    """Return assembly files plus dated dataset release file groups."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        download_manager.schedule_catalog_refresh_if_stale()
    return await asyncio.to_thread(
        download_manager.get_file_availability,
        key,
        assembly,
        provider,
        include_directory_listing,
    )


@app.get("/api/remote/files/{key}/{assembly}", response_model=List[FileInfo])
async def get_remote_files(
    key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    file_types: str = "",
):
    """Get download URLs for a specific species assembly."""
    if normalize_provider(provider) == DEFAULT_PROVIDER:
        download_manager.schedule_catalog_refresh_if_stale()
    requested_types = [part.strip() for part in str(file_types or "").split(",") if part.strip()]
    return download_manager.get_download_urls(
        key,
        assembly,
        file_types=requested_types or None,
        provider=provider,
    )


@app.get("/api/remote/ncbi/search")
async def search_remote_ncbi_species(
    query: str,
    assembly_source: str = "all",
    page_size: int = 100,
):
    """Search NCBI genome assemblies via the Datasets API."""
    try:
        result = await asyncio.to_thread(
            download_manager.search_ncbi_species,
            query,
            assembly_source,
            page_size,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to search NCBI genomes: {exc}")


@app.get("/api/remote/ncbi/featured")
async def list_featured_remote_ncbi_species(assembly_source: str = "all"):
    """Return a curated set of NCBI genomes, preferring paired RefSeq accessions where possible."""
    try:
        result = await asyncio.to_thread(
            download_manager.list_featured_ncbi_species,
            assembly_source,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load featured NCBI genomes: {exc}")


@app.post("/api/remote/ncbi/refresh")
async def refresh_remote_ncbi_cache():
    """Clear cached RefSeq browse metadata so the next requests fetch fresh NCBI results."""
    try:
        return await asyncio.to_thread(download_manager.refresh_ncbi_cache)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to refresh RefSeq browse cache: {exc}")


@app.get("/api/remote/ncbi/browse")
async def browse_remote_ncbi_group(group: str = "Featured", page_token: Optional[str] = None, page_size: int = 100):
    """Return a paginated list of RefSeq species for the given taxonomic group."""
    try:
        result = await asyncio.to_thread(
            download_manager.browse_ncbi_group,
            group,
            page_token,
            page_size,
        )
        return {
            **result,
            "species": [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in (result.get("species") or [])
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to browse RefSeq group '{group}': {exc}")


class CatalogAcknowledgeRequest(BaseModel):
    token: str = ""


@app.get("/api/remote/catalog/status")
async def get_remote_catalog_status():
    """Return the current remote catalogue refresh status and latest change summary."""
    download_manager.schedule_catalog_refresh_if_stale()
    return download_manager.get_catalog_status()


@app.post("/api/remote/catalog/refresh")
async def refresh_remote_catalog():
    """Force a remote catalogue refresh now."""
    try:
        return await asyncio.to_thread(download_manager.refresh_catalog, True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to refresh remote catalogue: {exc}")


@app.post("/api/remote/catalog/acknowledge")
async def acknowledge_remote_catalog_change(request: CatalogAcknowledgeRequest):
    """Mark the latest catalogue change notification as seen."""
    return download_manager.acknowledge_catalog_change(request.token)

class DownloadRequest(BaseModel):
    url: str
    filename: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    file_type: Optional[str] = None
    output_dir: str
    scientific_name: str = ""
    common_name: str = ""
    display_name: str = ""
    display_name_reason: str = ""
    assembly_name: str = ""
    source_database: str = ""
    equivalent_accessions: List[str] = []
    dataset_release_key: str = ""
    dataset_release_source: str = ""
    dataset_release_date: str = ""
    dataset_release_label: str = ""
    force: bool = False


class CancelDownloadRequest(BaseModel):
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    file_types: List[str] = []
    filenames: List[str] = []


class CustomAnnotationRequest(BaseModel):
    output_dir: str
    provider: str = DEFAULT_PROVIDER
    species_key: str
    assembly: str
    gff3_path: str
    label: str = ""
    #: Normalise the file into canonical Ensembl-style GFF3 before registering
    #: it. Required for GTF and for any file whose gene model needs repair; the
    #: original is copied alongside and kept as `source_path` in the manifest.
    convert: bool = False
    id_mode: str = "keep"
    id_prefix: str = ""
    #: Enables the sequence-region cross-checks during conversion.
    fasta_path: str = ""


class DatasetDefaultRequest(BaseModel):
    output_dir: str
    provider: str = DEFAULT_PROVIDER
    species_key: str
    assembly: str
    dataset_release_key: str


FASTA_DOWNLOAD_SUFFIXES = (
    ".fa",
    ".fna",
    ".fasta",
    ".fa.gz",
    ".fna.gz",
    ".fasta.gz",
    ".fa.bgz",
    ".fna.bgz",
    ".fasta.bgz",
)
GFF3_DOWNLOAD_SUFFIXES = (".gff3", ".gff", ".gff3.gz", ".gff.gz", ".gff3.bgz", ".gff.bgz")
# Formats accepted when a user imports their own annotation. GTF is only usable
# after conversion, which is enforced in import_custom_annotation.
GTF_IMPORT_SUFFIXES = (".gtf", ".gtf.gz", ".gtf.bgz", ".gff2", ".gff2.gz")
ANNOTATION_IMPORT_SUFFIXES = GFF3_DOWNLOAD_SUFFIXES + GTF_IMPORT_SUFFIXES
CDNA_DOWNLOAD_SUFFIXES = (".fa", ".fa.gz", ".fa.bgz", ".fasta", ".fasta.gz", ".fasta.bgz")
PROTEIN_DOWNLOAD_SUFFIXES = (".fa", ".fa.gz", ".fa.bgz", ".fasta", ".fasta.gz", ".fasta.bgz")
ASSEMBLY_SCOPED_FILE_TYPES = {"fasta", "metadata"}
DATASET_SCOPED_FILE_TYPES = {
    "gff3",
    "homology",
    "cdna",
    "protein",
    "xref",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
    "gtf",
    "embl",
    "alignment",
    "other_annotation",
    "other",
    "index",
}
DATASET_INDEX_ONLY_TYPES = {
    "index",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
}
LOCAL_MANIFEST_VERSION = 2
LEGACY_DATASET_RELEASE_KEY = "legacy/unknown"
DEFAULT_NCBI_DATASET_RELEASE_KEY = "ncbi/current"
_ENSEMBL_DATASET_RELEASE_PATH_RE = re.compile(
    r"/(?:GCA|GCF)/(?:\d{3}/){3}\d+/([^/]+)/([^/]+)/",
    flags=re.IGNORECASE,
)


def _has_any_suffix(filename: str, suffixes: Iterable[str]) -> bool:
    lower = str(filename or "").strip().lower()
    return any(lower.endswith(suffix) for suffix in suffixes)


def _safe_dataset_segment(value: str, fallback: str) -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._-")
    return token or fallback


def _dataset_release_parts(
    provider: str,
    file_type: Optional[str],
    release_key: str = "",
    release_source: str = "",
    release_date: str = "",
) -> Tuple[str, str, str]:
    normalized_provider = normalize_provider(provider)
    if file_type in ASSEMBLY_SCOPED_FILE_TYPES:
        return "", "", ""
    if release_key:
        parts = [part for part in str(release_key or "").split("/") if part]
        if len(parts) >= 2:
            return (
                _safe_dataset_segment(parts[0], "ensembl"),
                _safe_dataset_segment("/".join(parts[1:]), "unknown"),
                f"{_safe_dataset_segment(parts[0], 'ensembl')}/{_safe_dataset_segment('/'.join(parts[1:]), 'unknown')}",
            )
    if release_source or release_date:
        source = _safe_dataset_segment(release_source, normalized_provider if normalized_provider == NCBI_PROVIDER else "ensembl")
        date = _safe_dataset_segment(release_date, "current" if normalized_provider == NCBI_PROVIDER else "unknown")
        return source, date, f"{source}/{date}"
    if normalized_provider == NCBI_PROVIDER:
        return "ncbi", "current", DEFAULT_NCBI_DATASET_RELEASE_KEY
    return "legacy", "unknown", LEGACY_DATASET_RELEASE_KEY


def _infer_dataset_release_from_download_url(
    url: str,
    provider: str,
    file_type: Optional[str],
) -> Tuple[str, str, str]:
    """Recover release provenance from managed download URLs.

    Ensembl organism paths encode the provider and release date directly after
    the accession/version path, e.g. ``.../GCA/018/472/595/2/ensembl/2024_10/``.
    This is a defensive fallback for older clients that omitted release fields.
    """
    normalized_provider = normalize_provider(provider)
    if _download_scope_for_type(file_type) == "assembly":
        return "", "", ""
    if normalized_provider == NCBI_PROVIDER:
        return "ncbi", "current", DEFAULT_NCBI_DATASET_RELEASE_KEY
    try:
        parsed = urlparse(str(url or "").strip())
        if (parsed.hostname or "").lower() != _ENSEMBL_HOST:
            return "", "", ""
        match = _ENSEMBL_DATASET_RELEASE_PATH_RE.search(unquote(parsed.path or ""))
    except Exception:
        return "", "", ""
    if not match:
        return "", "", ""
    source = _safe_dataset_segment(match.group(1), "ensembl")
    date = _safe_dataset_segment(match.group(2), "unknown")
    if not source or not date or date == "unknown":
        return "", "", ""
    return source, date, f"{source}/{date}"


def _download_scope_for_type(file_type: Optional[str]) -> str:
    return "assembly" if str(file_type or "") in ASSEMBLY_SCOPED_FILE_TYPES else "dataset"


def _resolve_download_dir(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str,
    file_type: Optional[str],
    dataset_release_key: str = "",
    dataset_release_source: str = "",
    dataset_release_date: str = "",
) -> Tuple[Path, Path, str, str, str]:
    asm_dir = _resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
    if _download_scope_for_type(file_type) == "assembly":
        return asm_dir, asm_dir / "assembly", "", "", ""
    source, date, release_key = _dataset_release_parts(
        provider,
        file_type,
        release_key=dataset_release_key,
        release_source=dataset_release_source,
        release_date=dataset_release_date,
    )
    return asm_dir, asm_dir / "datasets" / source / date, source, date, release_key


def _classify_local_download_file(path: Path) -> str:
    name = path.name
    lower = name.lower()
    if lower.endswith(".index.db"):
        return "index"
    if lower.endswith(".tar.gz") and any(token in lower for token in (".lastz_net.", ".lastz_patch.", ".cactus_hal_pw.")):
        return "alignment"
    if lower.endswith((".gff3.bgz.csi", ".gff3.gz.tbi", ".gff3.csi", ".gff3.tbi")):
        return "gff3_index"
    if lower.endswith((".gtf.bgz.csi", ".gtf.gz.tbi", ".gtf.csi", ".gtf.tbi")):
        return "gtf_index"
    if "cdna" in lower and lower.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")):
        return "cdna_index"
    if ("pep" in lower or "protein" in lower) and lower.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")):
        return "protein_index"
    if _is_metadata_filename(lower):
        return "metadata"
    if _has_any_suffix(lower, GFF3_DOWNLOAD_SUFFIXES):
        return "gff3"
    if "cdna" in lower and _has_any_suffix(lower, CDNA_DOWNLOAD_SUFFIXES):
        return "cdna"
    if ("pep" in lower or "protein" in lower) and _has_any_suffix(lower, PROTEIN_DOWNLOAD_SUFFIXES):
        return "protein"
    if "xref" in lower and (lower.endswith(".tsv.gz") or lower.endswith(".tsv")):
        return "xref"
    if lower.endswith(".tsv.gz") or lower.endswith(".tsv"):
        return "homology"
    if _has_any_suffix(lower, FASTA_DOWNLOAD_SUFFIXES):
        return "fasta"
    if lower.endswith((".gtf.gz", ".gtf.bgz", ".gtf")):
        return "gtf"
    if lower.endswith((".embl.gz", ".embl")):
        return "embl"
    return ""


def _gca_prefixed_filename(filename: str, assembly: str, file_type: Optional[str]) -> str:
    """Prefix downloaded files with the assembly accession for clarity."""
    if file_type == "fasta" and filename in ("unmasked.fa.gz", "softmasked.fa.gz", "unmasked.fa.bgz", "softmasked.fa.bgz"):
        return f"{assembly}.{filename}"
    if file_type == "gff3" and filename in ("genes.gff3.gz", "genes.gff3.bgz"):
        return f"{assembly}.gff3{Path(filename).suffix}"
    if file_type == "metadata" and _is_assembly_report_filename(filename):
        return f"{assembly}.assembly_report.txt"
    return f"{assembly}.{filename}" if not filename.startswith(assembly) else filename


def _write_genome_manifest(assembly_dir: Path, payload: Dict[str, Any]):
    manifest_path = assembly_dir / genome_manifest_filename(payload.get("assembly"))
    manifest_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _load_genome_manifest(assembly_dir: Path, assembly: str) -> Dict[str, Any]:
    manifest_path = assembly_dir / genome_manifest_filename(assembly)
    if not manifest_path.exists():
        return {}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _download_manifest_file_records(manifest: Dict[str, Any], dataset_release_key: str = "") -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    assembly_files = manifest.get("assembly_files") or {}
    if not dataset_release_key and isinstance(assembly_files, dict):
        for raw in assembly_files.values():
            if isinstance(raw, dict):
                records.append(raw)
    releases = manifest.get("dataset_releases") or {}
    if isinstance(releases, dict):
        for key, release in releases.items():
            if dataset_release_key and str(key or "") != str(dataset_release_key or ""):
                continue
            files = release.get("files") if isinstance(release, dict) else {}
            if isinstance(files, dict):
                for raw in files.values():
                    if isinstance(raw, dict):
                        records.append(raw)
    return records


def _is_download_managed_assembly(
    manifest: Dict[str, Any],
    asm_dir: Optional[Path] = None,
    assembly: str = "",
) -> bool:
    """Whether this assembly's files were downloaded by us, and so can be deleted.

    With a directory to look at, the answer is simply whether it holds any file we
    downloaded — which is what the delete endpoint acts on. The manifest alone can
    only answer for genomes downloaded after manifests started recording individual
    files; the ones before that list nothing at all.
    """
    if asm_dir is not None:
        deletable, _user_supplied = _downloaded_assembly_files(asm_dir, assembly, manifest or {})
        return bool(deletable)
    if not manifest:
        return False
    try:
        manifest_version = int(manifest.get("manifest_version") or 0)
    except Exception:
        manifest_version = 0
    if manifest_version >= LOCAL_MANIFEST_VERSION:
        return any(str(record.get("url") or "").strip() for record in _download_manifest_file_records(manifest))
    return False


def _user_supplied_manifest_paths(manifest: Dict[str, Any]) -> Set[str]:
    """Files the user brought in, which a delete must never remove.

    A custom annotation import records the file it copied with an empty ``url``;
    downloads always carry the URL they came from.
    """
    kept: Set[str] = set()
    for record in _download_manifest_file_records(manifest):
        if str(record.get("url") or "").strip():
            continue
        raw_path = str(record.get("path") or "").strip()
        if raw_path:
            kept.add(str(Path(raw_path)))
    return kept


def _downloaded_assembly_files(
    asm_dir: Path,
    assembly: str,
    manifest: Dict[str, Any],
    release_dir: Optional[Path] = None,
    legacy_release: bool = False,
    dataset_release_key: str = "",
) -> Tuple[List[Path], List[Path]]:
    """(deletable, user_supplied) files inside a managed assembly directory.

    The manifest is not enough on its own: genomes downloaded before manifests
    recorded individual files list nothing, and even a current manifest does not
    mention the sidecars we generate afterwards (``.fai``, ``.gzi``, tabix indexes,
    ``.index.db``). Every downloaded file is named after the assembly it belongs to
    (``GCA_000001405.29.gff3.gz``, ``GCF_000001405.40_GRCh38.p14_genomic.fna``)
    wherever it lands, so that prefix is what marks a file as ours to delete.
    User-supplied files are excluded: they live under ``datasets/custom/`` and are
    recorded in the manifest without a URL.
    """
    deletable: List[Path] = []
    user_supplied: List[Path] = []
    if not asm_dir.is_dir():
        return deletable, user_supplied

    accession = str(assembly or "").strip()
    # "<accession>." for our own naming, "<accession>_" for the NCBI names we keep
    # as downloaded; a bare prefix would also match a different assembly version.
    prefixes = (f"{accession}.", f"{accession}_")
    protected = _user_supplied_manifest_paths(manifest)

    # Only the directories downloads land in, so a large attached track hub is
    # neither walked nor touched.
    candidates: List[Path] = [p for p in asm_dir.iterdir() if p.is_file()] if asm_dir.is_dir() else []
    candidates.extend(p for p in (asm_dir / "assembly").rglob("*") if p.is_file())
    candidates.extend(p for p in (asm_dir / "datasets").rglob("*") if p.is_file())

    for path in sorted(candidates):
        if path.name.endswith(".genome_manifest.json"):
            continue
        parts = path.relative_to(asm_dir).parts
        if str(path) in protected or parts[:2] == ("datasets", "custom"):
            user_supplied.append(path)
            continue
        if not path.name.startswith(prefixes):
            continue
        if legacy_release:
            # Pre-manifest downloads sit directly in the assembly directory, and
            # only the annotation-scoped ones belong to that pseudo-release — the
            # genome FASTA and its sidecars stay.
            if path.parent != asm_dir:
                continue
            if _classify_local_download_file(path) not in DATASET_SCOPED_FILE_TYPES:
                continue
        elif release_dir is not None and not path.is_relative_to(release_dir):
            continue
        deletable.append(path)

    # Anything the manifest recorded with a URL but that does not carry the
    # prefix (an older naming convention) is ours too.
    for record in _download_manifest_file_records(manifest, dataset_release_key=dataset_release_key):
        if not str(record.get("url") or "").strip():
            continue
        raw_path = str(record.get("path") or "").strip()
        if not raw_path:
            continue
        try:
            path = require_path_within(asm_dir, Path(raw_path))
        except Exception:
            continue
        if path.is_file() and path not in deletable and str(path) not in protected:
            deletable.append(path)

    return deletable, user_supplied


_CUSTOM_FILES_DELETE_DETAIL = (
    "These files were supplied by you rather than downloaded, so they are left alone. "
    "Remove them from disk yourself."
)


def _unlink_files(paths: Iterable[Path]) -> int:
    deleted = 0
    for path in paths:
        try:
            if path.is_file():
                path.unlink()
                deleted += 1
        except Exception:
            continue
    return deleted


def _prune_empty_download_dirs(asm_dir: Path, stop_dir: Path) -> None:
    if not asm_dir.exists():
        return
    for directory in sorted(
        [p for p in asm_dir.rglob("*") if p.is_dir()],
        key=lambda p: len(p.parts),
        reverse=True,
    ):
        try:
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        except Exception:
            pass
    current = asm_dir
    while current != stop_dir and current.exists():
        try:
            if any(current.iterdir()):
                break
            parent = current.parent
            current.rmdir()
            current = parent
        except Exception:
            break


def _release_label(source: str, date: str, explicit_label: str = "") -> str:
    if explicit_label:
        return explicit_label
    if source == NCBI_PROVIDER:
        return "RefSeq current" if date == "current" else f"RefSeq {date}"
    return f"{source or 'ensembl'} {date or 'unknown'}"


def _release_short_label(source: str, date: str, label: str = "") -> str:
    source_text = str(source or "").strip().lower()
    date_text = str(date or "").strip()
    label_text = str(label or "").strip()
    if source_text == "custom":
        return label_text or (f"custom {date_text.replace('_', '-')}" if date_text else "custom")
    # A demo release has only ever one version, so its date ("current") says nothing worth
    # the badge space; the label does.
    if source_text == "demo":
        return label_text or "Demo"
    if date_text and date_text != "unknown":
        return date_text.replace("_", "-")
    if label_text:
        return re.sub(r"^(ensembl|refseq)\s+", "", label_text, flags=re.IGNORECASE)
    return ""


def _merge_download_manifest(
    assembly_dir: Path,
    request: DownloadRequest,
    provider: str,
    destination: Path,
    local_filename: str,
    release_source: str,
    release_date: str,
    release_key: str,
) -> None:
    now = datetime.utcnow().isoformat() + "Z"
    manifest = _load_genome_manifest(assembly_dir, request.assembly)
    manifest.update({
        "manifest_version": LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "source_database": normalize_source_database(request.source_database, provider, request.assembly),
        "species_key": request.species_key,
        "assembly": request.assembly,
        "assembly_name": request.assembly_name or request.assembly,
        "scientific_name": request.scientific_name,
        "common_name": request.common_name,
        "display_name": request.display_name,
        "display_name_reason": request.display_name_reason,
        "gca": request.assembly if str(request.assembly or "").upper().startswith("GC") else "",
        "equivalent_accessions": [str(v).strip() for v in (request.equivalent_accessions or []) if str(v).strip()],
        "updated_at": now,
    })
    manifest.setdefault("assembly_files", {})
    manifest.setdefault("dataset_releases", {})
    file_record = {
        "type": request.file_type or "",
        "filename": local_filename,
        "path": str(destination),
        "url": request.url,
        "downloaded_at": now,
    }
    if _download_scope_for_type(request.file_type) == "assembly":
        manifest["assembly_files"][request.file_type or "other"] = file_record
    else:
        release_key = release_key or LEGACY_DATASET_RELEASE_KEY
        release = manifest["dataset_releases"].setdefault(release_key, {
            "key": release_key,
            "source": release_source or "legacy",
            "date": release_date or "unknown",
            "label": _release_label(release_source or "legacy", release_date or "unknown", request.dataset_release_label),
            "files": {},
            "created_at": now,
        })
        release.update({
            "key": release_key,
            "source": release_source or release.get("source") or "legacy",
            "date": release_date or release.get("date") or "unknown",
            "label": _release_label(release_source or release.get("source") or "legacy", release_date or release.get("date") or "unknown", request.dataset_release_label or release.get("label") or ""),
            "updated_at": now,
        })
        release.setdefault("files", {})
        file_key = request.file_type or "other"
        if request.file_type == "alignment":
            file_key = f"alignment::{local_filename}"
        release["files"][file_key] = file_record
        manifest["active_dataset_release_key"] = release_key
    _write_genome_manifest(assembly_dir, manifest)


async def _download_then_warm_assembly_metadata(url: str, dest: Path, task_id: str, accessions: List[str]) -> None:
    """Run a download, then fetch the registry metadata for what was downloaded.

    Assembly metadata is a small, static record, but fetching it takes a network
    round trip. Doing it here means it is already in the cache by the time the
    user opens a genome's overview, rather than being the one thing they wait on.
    Entirely best-effort: nothing here can fail a download.
    """
    await download_manager.download_file(url, dest, task_id)
    task = download_manager.tasks.get(task_id)
    if not task or str(getattr(task, "status", "")) != "completed":
        return
    try:
        await run_in_threadpool(_warm_assembly_metadata, accessions)
    except Exception:
        pass


def _warm_assembly_metadata(accessions: List[str]) -> None:
    for accession in accessions:
        token = str(accession or "").strip()
        if not token:
            continue
        try:
            if fetch_ena_metadata(token, _ENA_METADATA_CACHE_PATH).get("status") == "ready":
                return
        except Exception:
            continue


@app.post("/api/remote/download")
async def start_download(request: DownloadRequest):
    """Start a background download task."""
    import uuid
    task_id = str(uuid.uuid4())
    _validate_download_url(request.url)
    provider = normalize_provider(request.provider)
    # Rename file with GCA prefix
    local_filename = _sanitize_filename(
        _gca_prefixed_filename(request.filename, request.assembly, request.file_type)
    )
    requested_release_key = str(request.dataset_release_key or "").strip()
    requested_release_source = str(request.dataset_release_source or "").strip()
    requested_release_date = str(request.dataset_release_date or "").strip()
    if not requested_release_key or requested_release_key == LEGACY_DATASET_RELEASE_KEY:
        inferred_source, inferred_date, inferred_key = _infer_dataset_release_from_download_url(
            request.url,
            provider,
            request.file_type,
        )
        if inferred_key:
            requested_release_key = inferred_key
            requested_release_source = inferred_source
            requested_release_date = inferred_date
            request = request.model_copy(update={
                "dataset_release_key": inferred_key,
                "dataset_release_source": inferred_source,
                "dataset_release_date": inferred_date,
                "dataset_release_label": _release_label(inferred_source, inferred_date),
            })
    asm_dir, dest_dir, release_source, release_date, release_key = _resolve_download_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider,
        request.file_type,
        dataset_release_key=requested_release_key,
        dataset_release_source=requested_release_source,
        dataset_release_date=requested_release_date,
    )
    dest = dest_dir / local_filename

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        _merge_download_manifest(asm_dir, request, provider, dest, local_filename, release_source, release_date, release_key)
    except Exception:
        pass

    if dest.exists() and not request.force:
        try:
            if dest.stat().st_size > 0:
                return {"task_id": "", "status": "already_exists"}
        except Exception:
            pass

    for existing in download_manager.tasks.values():
        if request.force:
            continue
        if existing.destination == str(dest) and existing.status in {"pending", "downloading", "completed"}:
            return {"task_id": existing.id, "status": existing.status}

    task = DownloadTask(
        id=task_id,
        filename=local_filename,
        url=request.url,
        species_key=request.species_key,
        assembly=request.assembly,
        provider=provider,
        file_type=request.file_type,
        dataset_release_key=release_key,
        dataset_release_source=release_source,
        dataset_release_date=release_date,
        dataset_release_label=request.dataset_release_label or _release_label(release_source, release_date),
        status="pending",
        destination=str(dest),
    )
    download_manager.tasks[task_id] = task
    warm_accessions = [request.assembly] + [
        str(v).strip() for v in (request.equivalent_accessions or []) if str(v).strip()
    ]
    asyncio.create_task(
        _download_then_warm_assembly_metadata(request.url, dest, task_id, warm_accessions)
    )

    # Auto-fetch metadata when core genome files are requested.
    if request.file_type in {"fasta", "gff3"}:
        try:
            metadata_files = download_manager.get_download_urls(
                request.species_key,
                request.assembly,
                file_types=["metadata"],
                provider=provider,
            )
            if metadata_files:
                metadata_file = metadata_files[0]
                metadata_filename = _sanitize_filename(
                    _gca_prefixed_filename(metadata_file.filename, request.assembly, "metadata")
                )
                metadata_dir = asm_dir / "assembly"
                metadata_dest = metadata_dir / metadata_filename

                already_tracked = any(
                    (
                        t.species_key == request.species_key
                        and t.assembly == request.assembly
                        and t.file_type == "metadata"
                        and t.status in {"pending", "downloading", "completed"}
                    )
                    for t in download_manager.tasks.values()
                )

                if not metadata_dest.exists() and not already_tracked:
                    metadata_task_id = str(uuid.uuid4())
                    metadata_dir.mkdir(parents=True, exist_ok=True)
                    metadata_request = request.model_copy(update={
                        "url": metadata_file.url,
                        "filename": metadata_file.filename,
                        "file_type": "metadata",
                        "dataset_release_key": "",
                        "dataset_release_source": "",
                        "dataset_release_date": "",
                        "dataset_release_label": "",
                    })
                    try:
                        _merge_download_manifest(asm_dir, metadata_request, provider, metadata_dest, metadata_filename, "", "", "")
                    except Exception:
                        pass
                    metadata_task = DownloadTask(
                        id=metadata_task_id,
                        filename=metadata_filename,
                        url=metadata_file.url,
                        species_key=request.species_key,
                        assembly=request.assembly,
                        provider=provider,
                        file_type="metadata",
                        dataset_release_key="",
                        dataset_release_source="",
                        dataset_release_date="",
                        dataset_release_label="",
                        status="pending",
                        destination=str(metadata_dest),
                    )
                    download_manager.tasks[metadata_task_id] = metadata_task
                    asyncio.create_task(
                        _download_then_warm_assembly_metadata(
                            metadata_file.url, metadata_dest, metadata_task_id, warm_accessions
                        )
                    )
        except Exception:
            # Metadata is best-effort and must never block requested downloads.
            pass

    return {"task_id": task_id, "status": "started"}


@app.post("/api/remote/custom-annotation")
async def import_custom_annotation(request: CustomAnnotationRequest):
    """Copy a user-provided GFF3 into an existing assembly as a managed dataset release."""
    provider = normalize_provider(request.provider)
    asm_dir = _resolve_species_assembly_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider=provider,
    )
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")

    source = Path(request.gff3_path).expanduser().resolve()
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Custom annotation file not found")
    if not _has_any_suffix(source.name.lower(), ANNOTATION_IMPORT_SUFFIXES):
        raise HTTPException(
            status_code=400,
            detail="Custom annotation must be a GFF3, GFF or GTF file",
        )
    needs_conversion = _has_any_suffix(source.name.lower(), GTF_IMPORT_SUFFIXES)
    if needs_conversion and not request.convert:
        raise HTTPException(
            status_code=400,
            detail=(
                "GTF cannot be indexed directly. Re-run this import with "
                "conversion enabled to normalise it into GFF3 first."
            ),
        )

    fasta_for_conversion = ""
    if request.convert and request.fasta_path:
        fasta_for_conversion = str(_resolve_user_file(request.fasta_path, "FASTA"))

    today = datetime.utcnow().date().isoformat()
    label = str(request.label or "").strip() or f"custom {today}"
    if not label.lower().startswith("custom"):
        display_label = label
    else:
        display_label = label
    safe_base = _safe_dataset_segment(display_label.lower().replace(" ", "_"), f"custom_{today}")
    manifest = _load_genome_manifest(asm_dir, request.assembly)
    releases = manifest.setdefault("dataset_releases", {})
    suffix = 1
    safe_label = safe_base
    release_key = f"custom/{safe_label}"
    while release_key in releases or (asm_dir / "datasets" / "custom" / safe_label).exists():
        suffix += 1
        safe_label = f"{safe_base}_{suffix}"
        release_key = f"custom/{safe_label}"

    dest_dir = asm_dir / "datasets" / "custom" / safe_label
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_filename = _sanitize_filename(_gca_prefixed_filename(source.name, request.assembly, "gff3"))
    dest = dest_dir / dest_filename
    conversion_summary: Dict[str, Any] = {}

    if request.convert:
        # Normalise into canonical GFF3 and register that. The original is copied
        # alongside untouched so the import is always traceable back to its input.
        try:
            conversion = await run_in_threadpool(
                convert_annotation,
                str(source),
                str(dest_dir),
                fasta_for_conversion or None,
                request.id_mode or "keep",
                request.id_prefix or "",
            )
        except IdentifierError as exc:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise HTTPException(
                status_code=500, detail=f"Failed to convert custom annotation: {exc}"
            )

        dest = Path(conversion.output_path)
        dest_filename = dest.name
        original_copy = dest_dir / _sanitize_filename("source_" + source.name)
        try:
            if source.resolve() != original_copy.resolve():
                shutil.copy2(source, original_copy)
        except Exception:
            # The converted file is what matters; keeping the original is a
            # convenience, not a precondition for the import to succeed.
            original_copy = None
        conversion_summary = {
            "converted": True,
            "dialect": (conversion.report.dialect if conversion.report else ""),
            "producer": (conversion.report.producer_guess if conversion.report else ""),
            "gene_count": conversion.gene_count,
            "transcript_count": conversion.transcript_count,
            "exon_count": conversion.exon_count,
            "coding_transcript_count": conversion.coding_transcript_count,
            "id_mode": conversion.id_mode,
            "id_prefix": conversion.id_prefix,
            "id_map_path": conversion.id_map_path,
            "original_path": str(original_copy) if original_copy else "",
            "report": conversion.report.as_dict() if conversion.report else {},
        }
    else:
        try:
            if source.resolve() != dest.resolve():
                shutil.copy2(source, dest)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to copy custom annotation: {exc}")

    now = datetime.utcnow().isoformat() + "Z"
    manifest.update({
        "manifest_version": LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "species_key": request.species_key,
        "assembly": request.assembly,
        "assembly_name": manifest.get("assembly_name") or request.assembly,
        "gca": request.assembly if str(request.assembly or "").upper().startswith("GC") else manifest.get("gca", ""),
        "updated_at": now,
    })
    manifest.setdefault("assembly_files", {})
    releases[release_key] = {
        "key": release_key,
        "source": "custom",
        "date": display_label,
        "label": display_label,
        "files": {
            "gff3": {
                "type": "gff3",
                "filename": dest_filename,
                "path": str(dest),
                "url": "",
                "source_path": str(source),
                "downloaded_at": now,
            }
        },
        "created_at": now,
        "updated_at": now,
    }
    if conversion_summary:
        releases[release_key]["conversion"] = {
            key: value
            for key, value in conversion_summary.items()
            if key != "report"
        }
    _write_genome_manifest(asm_dir, manifest)

    refreshed = await list_local_assemblies(request.output_dir)
    assembly_record = next(
        (
            item for item in refreshed
            if normalize_provider(item.get("provider")) == provider
            and str(item.get("species_key") or "") == str(request.species_key or "")
            and str(item.get("assembly") or "") == str(request.assembly or "")
        ),
        None,
    )
    created = None
    if assembly_record:
        created = next(
            (
                item for item in assembly_record.get("dataset_instances") or []
                if str(item.get("dataset_release_key") or "") == release_key
            ),
            None,
        )
    return {
        "status": "created",
        "dataset_release_key": release_key,
        "dataset_release_label": display_label,
        "path": str(dest),
        "dataset": created,
        "assembly": assembly_record,
        "conversion": conversion_summary,
    }


@app.post("/api/remote/dataset-default")
async def set_dataset_default(request: DatasetDefaultRequest):
    """Remember which annotation dataset should be the default for an assembly."""
    provider = normalize_provider(request.provider)
    release_key = str(request.dataset_release_key or "").strip()
    if not release_key:
        raise HTTPException(status_code=400, detail="dataset_release_key is required")

    asm_dir = _resolve_species_assembly_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider=provider,
    )
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")

    manifest = _load_genome_manifest(asm_dir, request.assembly)
    scanned = _scan_local_assembly(asm_dir, request.assembly, manifest)
    release = next(
        (entry for entry in scanned.get("dataset_releases") or [] if str(entry.get("key") or "") == release_key),
        None,
    )
    if not release:
        raise HTTPException(status_code=404, detail="Dataset release not found")
    if not (release.get("files") or {}).get("gff3"):
        raise HTTPException(status_code=400, detail="Dataset release does not have a GFF3 annotation")

    now = datetime.utcnow().isoformat() + "Z"
    manifest.update({
        "manifest_version": LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "species_key": request.species_key,
        "assembly": request.assembly,
        "default_dataset_release_key": release_key,
        "active_dataset_release_key": release_key,
        "updated_at": now,
    })
    manifest.setdefault("assembly_files", {})
    manifest.setdefault("dataset_releases", {})
    _write_genome_manifest(asm_dir, manifest)

    refreshed = await list_local_assemblies(request.output_dir)
    assembly_record = next(
        (
            item for item in refreshed
            if normalize_provider(item.get("provider")) == provider
            and str(item.get("species_key") or "") == str(request.species_key or "")
            and str(item.get("assembly") or "") == str(request.assembly or "")
        ),
        None,
    )
    dataset_record = None
    if assembly_record:
        dataset_record = next(
            (
                item for item in assembly_record.get("dataset_instances") or []
                if str(item.get("dataset_release_key") or "") == release_key
            ),
            None,
        )
    return {
        "status": "ok",
        "dataset_release_key": release_key,
        "dataset": dataset_record,
        "assembly": assembly_record,
    }


@app.post("/api/remote/download/cancel")
async def cancel_downloads(request: CancelDownloadRequest):
    """Cancel active download tasks for selected files in a species/assembly."""
    provider = normalize_provider(request.provider)
    requested_types = {
        str(value or "").strip()
        for value in (request.file_types or [])
        if str(value or "").strip()
    }
    file_types = set(requested_types)
    implicit_metadata = False
    if {"fasta", "gff3"} & file_types:
        implicit_metadata = "metadata" not in file_types
        file_types.add("metadata")
    filenames = {
        _sanitize_filename(str(value or "").strip())
        for value in (request.filenames or [])
        if str(value or "").strip()
    }
    canceled_task_ids: List[str] = []
    for task_id, task in list(download_manager.tasks.items()):
        if str(task.species_key or "") != str(request.species_key or ""):
            continue
        if str(task.assembly or "") != str(request.assembly or ""):
            continue
        if normalize_provider(task.provider) != provider:
            continue
        if str(task.status or "") not in {"pending", "downloading"}:
            continue
        task_type = str(task.file_type or "").strip()
        if file_types and task_type not in file_types:
            continue
        task_filename = _sanitize_filename(str(task.filename or "").strip())
        if filenames and task_type != "metadata" and task_filename and task_filename not in filenames:
            continue
        if filenames and task_type == "metadata" and not implicit_metadata and task_filename and task_filename not in filenames:
            continue
        task.cancel_requested = True
        task.status = "canceled"
        task.progress = 0.0
        task.error = None
        canceled_task_ids.append(task_id)
        for raw_path in (
            task.current_download_path,
            str(Path(task.destination).with_suffix(Path(task.destination).suffix + ".tmp")) if task.destination else "",
        ):
            if not raw_path:
                continue
            try:
                path = Path(raw_path)
                if path.exists():
                    path.unlink()
            except Exception:
                pass
    return {
        "status": "canceled" if canceled_task_ids else "not_found",
        "task_ids": canceled_task_ids,
        "count": len(canceled_task_ids),
    }


def _prefer_local_file(existing: str, candidate: Path, file_type: str) -> str:
    if not existing:
        return str(candidate.resolve())
    lower = candidate.name.lower()
    current = Path(existing).name.lower()
    if file_type == "fasta":
        if "softmasked" in lower and "softmasked" not in current:
            return str(candidate.resolve())
        if "softmasked" not in current and len(lower) < len(current):
            return str(candidate.resolve())
    if file_type == "gff3":
        if lower.endswith("genes.gff3.gz") and not current.endswith("genes.gff3.gz"):
            return str(candidate.resolve())
        if lower.endswith("genes.gff3.bgz") and not current.endswith(("genes.gff3.gz", "genes.gff3.bgz")):
            return str(candidate.resolve())
    return existing


def _record_local_file(files: Dict[str, str], types: List[str], file_type: str, path: Path) -> None:
    if not file_type:
        return
    types.append(file_type)
    candidate = str(path.resolve())
    if file_type in files:
        files[file_type] = _prefer_local_file(files[file_type], path, file_type)
    else:
        files[file_type] = candidate


def _resolve_local_gff_index(gff_path: str, assembly: str = "") -> str:
    gff_text = str(gff_path or "").strip()
    if not gff_text:
        return ""
    try:
        gff = Path(gff_text).resolve()
        if not gff.is_file():
            return ""
        candidates = [
            p for p in gff.parent.iterdir()
            if p.is_file() and p.name.endswith(".index.db") and p.stat().st_size > 0
        ]
    except Exception:
        return ""
    if not candidates:
        return ""
    usable: List[str] = []
    for candidate in candidates:
        candidate_path = str(candidate.resolve())
        try:
            if _is_existing_index_usable(candidate_path, str(gff)):
                usable.append(candidate_path)
        except Exception:
            continue
    if usable:
        canonical_name = f"{assembly}.gff3.index.db" if assembly else ""
        return sorted(
            usable,
            key=lambda path: (
                bool(canonical_name) and Path(path).name != canonical_name,
                len(Path(path).name),
                Path(path).name,
            ),
        )[0]
    return str(sorted(candidates, key=lambda path: path.name)[0].resolve())


def _iter_nonempty_files(directory: Path) -> Iterable[Path]:
    if not directory.is_dir():
        return []
    results = []
    for f in sorted(directory.iterdir(), key=lambda p: p.name):
        if not f.is_file() or f.name.endswith(".tmp") or f.name.endswith(".genome_manifest.json"):
            continue
        try:
            if f.stat().st_size <= 0:
                continue
        except Exception:
            continue
        results.append(f)
    return results


def _scan_local_release_dir(release_dir: Path) -> Tuple[List[str], Dict[str, str]]:
    types: List[str] = []
    files: Dict[str, str] = {}
    for f in _iter_nonempty_files(release_dir):
        _record_local_file(files, types, _classify_local_download_file(f), f)
    return list(set(types)), files


def _scan_local_assembly(asm_dir: Path, assembly: str, manifest: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    manifest = manifest or _load_genome_manifest(asm_dir, assembly)
    assembly_types: List[str] = []
    assembly_files: Dict[str, str] = {}
    dataset_map: Dict[str, Dict[str, Any]] = {}

    def _ensure_release(key: str, source: str, date: str, label: str = "") -> Dict[str, Any]:
        entry = dataset_map.setdefault(key, {
            "key": key,
            "source": source,
            "date": date,
            "label": label or _release_label(source, date),
            "types": [],
            "files": {},
        })
        return entry

    for f in _iter_nonempty_files(asm_dir / "assembly"):
        file_type = _classify_local_download_file(f)
        if file_type in ASSEMBLY_SCOPED_FILE_TYPES:
            _record_local_file(assembly_files, assembly_types, file_type, f)

    for f in _iter_nonempty_files(asm_dir):
        file_type = _classify_local_download_file(f)
        if not file_type:
            continue
        if file_type in ASSEMBLY_SCOPED_FILE_TYPES:
            _record_local_file(assembly_files, assembly_types, file_type, f)
        elif file_type in DATASET_SCOPED_FILE_TYPES:
            rel = _ensure_release(LEGACY_DATASET_RELEASE_KEY, "legacy", "unknown", "Legacy local files")
            _record_local_file(rel["files"], rel["types"], file_type, f)

    datasets_root = asm_dir / "datasets"
    if datasets_root.is_dir():
        for source_dir in sorted(datasets_root.iterdir(), key=lambda p: p.name):
            if not source_dir.is_dir():
                continue
            for date_dir in sorted(source_dir.iterdir(), key=lambda p: p.name, reverse=True):
                if not date_dir.is_dir():
                    continue
                source = source_dir.name
                date = date_dir.name
                key = f"{source}/{date}"
                rel = _ensure_release(key, source, date)
                release_types, release_files = _scan_local_release_dir(date_dir)
                for t in release_types:
                    rel["types"].append(t)
                for t, path in release_files.items():
                    if t in rel["files"]:
                        rel["files"][t] = _prefer_local_file(rel["files"][t], Path(path), t)
                    else:
                        rel["files"][t] = path

    manifest_releases = manifest.get("dataset_releases") or {}
    if isinstance(manifest_releases, dict):
        for key, raw in manifest_releases.items():
            if not isinstance(raw, dict):
                continue
            parts = [part for part in str(key or "").split("/") if part]
            source = str(raw.get("source") or (parts[0] if parts else "legacy"))
            date = str(raw.get("date") or (parts[1] if len(parts) > 1 else "unknown"))
            rel = _ensure_release(str(key or f"{source}/{date}"), source, date, str(raw.get("label") or ""))
            rel["label"] = str(raw.get("label") or rel.get("label") or _release_label(source, date))

    dataset_releases = []
    for key, rel in list(dataset_map.items()):
        rel["types"] = sorted(set(rel.get("types") or []))
        files = rel.get("files") or {}
        # A generated/remote index without its parent annotation is not a usable
        # dataset release. This commonly occurs when a folder is manually removed
        # while an older index build is finishing; do not expose it as
        # "legacy unknown" in the selector.
        if files and set(files.keys()).issubset(DATASET_INDEX_ONLY_TYPES):
            dataset_map.pop(key, None)
            continue
        if files.get("gff3") and not files.get("index"):
            index_path = _resolve_local_gff_index(str(files.get("gff3") or ""), assembly)
            if index_path:
                files["index"] = index_path
                rel["files"] = files
                rel["types"] = sorted(set(list(rel.get("types") or []) + ["index"]))
        source = str(rel.get("source") or "")
        date = str(rel.get("date") or "")
        label = str(rel.get("label") or "")
        rel["label"] = label or _release_label(source, date)
        rel["short_label"] = _release_short_label(source, date, rel["label"])
        dataset_releases.append(rel)
    dataset_releases.sort(key=lambda r: (r.get("source") == "legacy", str(r.get("date") or "")))
    non_legacy = [r for r in dataset_releases if r.get("source") != "legacy"]
    legacy = [r for r in dataset_releases if r.get("source") == "legacy"]
    dataset_releases = sorted(non_legacy, key=lambda r: str(r.get("date") or ""), reverse=True) + legacy

    computed_default_release = next(
        (r for r in dataset_releases if r.get("source") not in {"legacy", "custom"} and (r.get("files") or {}).get("gff3")),
        None,
    ) or next(
        (r for r in dataset_releases if (r.get("files") or {}).get("gff3")),
        None,
    ) or (dataset_releases[0] if dataset_releases else None)
    saved_default_key = str(manifest.get("default_dataset_release_key") or "").strip()
    saved_default_release = dataset_map.get(saved_default_key) if saved_default_key else None
    if saved_default_release and (saved_default_release.get("files") or {}).get("gff3"):
        default_release = saved_default_release
    else:
        default_release = computed_default_release
    default_key = str((default_release or {}).get("key") or "")

    active_key = str(manifest.get("active_dataset_release_key") or "")
    if active_key not in dataset_map and dataset_releases:
        active_key = default_key or str(dataset_releases[0].get("key") or "")

    active_release = dataset_map.get(default_key) if default_key else (dataset_map.get(active_key) if active_key else None)
    files = dict(assembly_files)
    types = list(assembly_types)
    if active_release:
        files.update(active_release.get("files") or {})
        types.extend(active_release.get("types") or [])

    return {
        "assembly_files": assembly_files,
        "assembly_types": sorted(set(assembly_types)),
        "dataset_releases": dataset_releases,
        "active_dataset_release_key": active_key,
        "default_dataset_release_key": default_key,
        "files": files,
        "types": sorted(set(types)),
    }


@app.get("/api/remote/local-files")
async def check_local_files(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    dataset_release_key: str = "",
):
    """Check which file types already exist in local_data for a species/assembly."""
    local_dir = _resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
    found: List[str] = []
    scanned: Dict[str, Any] = {}
    if local_dir.is_dir():
        scanned = _scan_local_assembly(local_dir, assembly)
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


@app.get("/api/demo/genome")
async def get_demo_genome(output_dir: str = "", genome_id: str = ""):
    """A bundled genome's catalogue entry, and whether it is already installed.

    The download view asks for this while a tutorial is running so it can show the
    tutorials' genomes alongside the real catalogue.

    ``genomes`` is the list; ``species`` and the rest of the top level describe one of
    them — the one asked for, or the demo genome — because that is the shape this
    endpoint had when there was only ever one.
    """
    status = demo_install_status(output_dir, genome_id or None)
    status["genomes"] = demo_install_statuses(output_dir)
    return status


class DemoGenomeInstallRequest(BaseModel):
    output_dir: str
    genome_id: str = ""


@app.post("/api/demo/genome/install")
async def post_demo_genome_install(request: DemoGenomeInstallRequest):
    """Install a bundled genome, standing in for a download during a tutorial.

    Indexes it on the way out. The annotations are small — a few kilobytes for the demo
    genome, a hundred transcripts for the chromosome-1 slice — so building the index here
    rather than in the background costs little and means the browser is ready by the time
    the tutorial's next step arrives.
    """
    output_dir = str(request.output_dir or "").strip()
    if not output_dir:
        raise HTTPException(status_code=400, detail="output_dir is required")
    genome_id = str(request.genome_id or "").strip() or None
    try:
        status = install_demo_genome(output_dir, genome_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    target = demo_index_target(output_dir, genome_id)
    if target:
        gff_path, index_path = target
        try:
            status["index"] = ensure_gff_index(gff_path, index_path)
        except Exception as exc:
            # A missing index is recoverable — the browser rebuilds on demand — so the
            # tutorial should carry on rather than fail here.
            status["index_error"] = str(exc)
    return status


class TutorialWorkspaceRequest(BaseModel):
    output_dir: str


@app.post("/api/tutorial/workspace")
async def post_tutorial_workspace(request: TutorialWorkspaceRequest):
    """Create the scratch directory a tutorial runs in, inside the user's output dir.

    A tutorial never writes to the real configuration, so this is the only trace it
    leaves on disk — and it is removed again on the way out.
    """
    try:
        workspace = tutorial_workspace(request.output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    workspace.mkdir(parents=True, exist_ok=True)
    return {"workspace": str(workspace)}


@app.delete("/api/tutorial/workspace")
async def delete_tutorial_workspace(output_dir: str):
    """Remove the tutorial scratch directory.

    Called when a tutorial ends, and again on launch, so a run interrupted by a crash
    does not leave the demo genome sitting in the user's output directory.
    """
    clear_tutorial_session_genome()
    try:
        return reset_tutorial_workspace(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class TutorialSessionRequest(BaseModel):
    genome: Dict[str, Any]


@app.post("/api/tutorial/session")
async def post_tutorial_session(request: TutorialSessionRequest):
    """Tell the browser about the genome the running tutorial has activated.

    The tutorial's active genome lives in the frontend's configuration override and is
    never saved, which is what keeps the user's setup untouched — but the genome browser
    resolves genomes on this side, from the saved configuration, so without this it
    answers every request for the demo genome with "invalid genome" and draws empty
    tracks. This holds it in memory for the life of the process instead.
    """
    try:
        registered = set_tutorial_session_genome(request.genome)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"registered": True, "genome": _active_species_item_key(registered)}


# ── Editing a tutorial's wording from inside the app ─────────────────────────
#
# A developer tool. `TUTORIAL_AUTHORING` is the switch: set it False and both endpoints
# below refuse, the frontend hides the control, and the feature is gone without anything
# else having to be unpicked. It is off in anything but a source checkout regardless,
# because there is nothing to edit in a packaged build.
TUTORIAL_AUTHORING = True
TUTORIAL_BUILDER = True


def _tutorial_authoring_enabled() -> bool:
    return bool(TUTORIAL_AUTHORING) and tutorial_authoring.is_available()


def _tutorial_builder_enabled() -> bool:
    return bool(TUTORIAL_BUILDER) and _tutorial_authoring_enabled()


@app.get("/api/tutorial/authoring")
async def get_tutorial_authoring():
    """Whether tutorial text can be edited in place, so the frontend can hide the control."""
    return {"enabled": _tutorial_authoring_enabled(), "builder_enabled": _tutorial_builder_enabled()}


class TutorialAuthoringRequest(BaseModel):
    tutorial_id: str
    step_id: str
    field: str
    value: str


class TutorialAuthoringPositionRequest(BaseModel):
    tutorial_id: str
    step_id: str
    x: float
    y: float


class TutorialAuthoringSizeRequest(BaseModel):
    tutorial_id: str
    step_id: str
    width: Optional[float] = None
    height: Optional[float] = None


class TutorialDraftSaveRequest(BaseModel):
    output_dir: str
    tutorial: Dict[str, Any]


class TutorialCheckpointSaveRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    name: str
    tutorial: Dict[str, Any]


class TutorialPackageExportRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    path: str


class TutorialPackageImportRequest(BaseModel):
    output_dir: str
    path: str


class TutorialPromoteRequest(BaseModel):
    output_dir: str
    tutorial_id: str


class TutorialDatasetGenerateRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    fasta_path: str
    annotation_path: str
    chrom: str
    start: int
    end: int
    partial_mode: str = "expand"
    source: Optional[Dict[str, Any]] = None


class TutorialDatasetFixtureRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    fixture_id: str


class TutorialDatasetInstallRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    recipe_id: str
    workspace: str


@app.post("/api/tutorial/authoring/step")
async def post_tutorial_authoring_step(request: TutorialAuthoringRequest):
    """Write one step's wording back into its definition file.

    Narrow on purpose: one named field of one named step, and only the words shown on a
    card. Shared section headings are followed back to their local SECTION constant. See
    backend/tutorial_authoring.py for what stops it doing more.
    """
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_field,
            request.tutorial_id,
            request.step_id,
            request.field,
            request.value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


@app.post("/api/tutorial/authoring/step-position")
async def post_tutorial_authoring_step_position(request: TutorialAuthoringPositionRequest):
    """Persist a normalized card position chosen by dragging its authoring header."""
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_position,
            request.tutorial_id,
            request.step_id,
            request.x,
            request.y,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


@app.post("/api/tutorial/authoring/step-size")
async def post_tutorial_authoring_step_size(request: TutorialAuthoringSizeRequest):
    """Persist card dimensions chosen with its authoring resize handles."""
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_size,
            request.tutorial_id,
            request.step_id,
            request.width,
            request.height,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


# ── Declarative tutorial drafts and portable packages ───────────────────────

@app.get("/api/tutorial/drafts")
async def get_tutorial_drafts(output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"drafts": await run_in_threadpool(tutorial_packages.list_drafts, output_dir)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/drafts")
async def post_tutorial_draft(request: TutorialDraftSaveRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.save_draft, request.output_dir, request.tutorial)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not save the tutorial draft: {exc}")


@app.delete("/api/tutorial/drafts/{tutorial_id}")
async def delete_tutorial_draft(tutorial_id: str, output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"deleted": await run_in_threadpool(tutorial_packages.delete_draft, output_dir, tutorial_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/tutorial/drafts/{tutorial_id}/checkpoints")
async def get_tutorial_checkpoints(tutorial_id: str, output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"checkpoints": await run_in_threadpool(tutorial_packages.list_checkpoints, output_dir, tutorial_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/drafts/checkpoints")
async def post_tutorial_checkpoint(request: TutorialCheckpointSaveRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_packages.save_checkpoint,
            request.output_dir,
            request.tutorial_id,
            request.name,
            request.tutorial,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/packages/export")
async def post_tutorial_package_export(request: TutorialPackageExportRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_packages.export_package,
            request.output_dir,
            request.tutorial_id,
            request.path,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not export the tutorial package: {exc}")


@app.get("/api/tutorial/packages/scan")
async def get_tutorial_package_scan(path: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.scan_package, path)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/packages/import")
async def post_tutorial_package_import(request: TutorialPackageImportRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.import_package, request.path, request.output_dir)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/drafts/promote")
async def post_tutorial_draft_promote(request: TutorialPromoteRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial promotion is not enabled.")
    repository_root = Path(__file__).resolve().parents[1]
    try:
        return await run_in_threadpool(
            tutorial_packages.promote_draft,
            request.output_dir,
            request.tutorial_id,
            repository_root,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not promote the tutorial: {exc}")


@app.post("/api/tutorial/datasets/generate")
async def post_tutorial_dataset_generate(request: TutorialDatasetGenerateRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial dataset authoring is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.generate_recipe,
            request.output_dir,
            request.tutorial_id,
            request.fasta_path,
            request.annotation_path,
            request.chrom,
            request.start,
            request.end,
            request.partial_mode,
            request.source,
        )
    except (ValueError, OSError, pysam.utils.SamtoolsError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/datasets/fixture")
async def post_tutorial_dataset_fixture(request: TutorialDatasetFixtureRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial dataset authoring is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.generate_fixture_pack,
            request.output_dir,
            request.tutorial_id,
            request.fixture_id,
        )
    except (ValueError, OSError, pysam.utils.SamtoolsError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/tutorial/datasets/install")
async def post_tutorial_dataset_install(request: TutorialDatasetInstallRequest):
    expected_workspace = tutorial_workspace(request.output_dir).resolve()
    supplied_workspace = Path(request.workspace).expanduser().resolve()
    if supplied_workspace != expected_workspace:
        raise HTTPException(status_code=400, detail="Tutorial datasets may only be installed in the active tutorial workspace.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.install_recipe,
            request.output_dir,
            request.tutorial_id,
            request.recipe_id,
            request.workspace,
        )
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class TutorialDemoSourceRequest(BaseModel):
    output_dir: str
    workspace: str


@app.post("/api/tutorial/demo-source")
async def post_tutorial_demo_source(request: TutorialDemoSourceRequest):
    """Lay the demo genome's raw files out in the workspace for a reader to pick by hand.

    The custom-genome tutorial teaches importing files you already have, so it has to put
    some files somewhere the reader can browse to. Nothing is registered or indexed here —
    that is the reader's job, through the form the tutorial is about.

    Guarded the same way dataset installation is: the workspace must be the one belonging
    to the output directory given, so this cannot be used to write into anything else.
    """
    expected_workspace = tutorial_workspace(request.output_dir).resolve()
    supplied_workspace = Path(request.workspace).expanduser().resolve()
    if supplied_workspace != expected_workspace:
        raise HTTPException(status_code=400, detail="Demo files may only be written in the active tutorial workspace.")
    try:
        return await run_in_threadpool(install_demo_source_files, request.workspace)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/tutorial/session")
async def delete_tutorial_session():
    """Forget it again, when the tutorial ends."""
    clear_tutorial_session_genome()
    return {"registered": False}


@app.get("/api/remote/local-assemblies")
async def list_local_assemblies(output_dir: str):
    """Scan output_dir/local_data/ and return all locally downloaded assemblies with file paths."""
    local_root = _resolve_local_data_root(output_dir)
    results = []
    if not local_root.is_dir():
        return results

    # Build a lookup from species_key -> display info
    # Ensure cache is populated — it may be empty if /api/remote/species hasn't been called yet
    species_lookup = {}
    if not download_manager._species_cache and download_manager.species_data:
        download_manager._build_cache()

    if download_manager._species_cache:
        for s in download_manager._species_cache:
            species_lookup[s.key] = s
    else:
        # Fallback: build from raw data dict directly
        for key, info in download_manager.species_data.items():
            species_lookup[key] = {
                "scientific_name": info.get("scientific_name", key),
                "common_name": info.get("common_name", ""),
                "assemblies": {
                    gca: asm_data.get("name", gca)
                    for gca, asm_data in info.get("assemblies", {}).items()
                },
            }

    for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
        manifest = _load_genome_manifest(asm_dir, assembly)
        scanned = _scan_local_assembly(asm_dir, assembly, manifest)
        download_managed = _is_download_managed_assembly(manifest, asm_dir, assembly)
        is_demo = bool(manifest.get("is_demo"))
        types = list(scanned.get("types") or [])
        files = dict(scanned.get("files") or {})

        # A genome is usable with a FASTA alone: the browser can show the
        # sequence plus any BigWig/BigBed/VCF tracks the user attaches. An
        # annotation adds the gene track but is not a precondition for browsing.
        if not types or not (files.get("gff3") or files.get("fasta")):
            continue
        has_annotation = bool(files.get("gff3"))

        gff_path = files.get("gff3") or ""
        if gff_path:
            default_release_key = str(scanned.get("default_dataset_release_key") or scanned.get("active_dataset_release_key") or "")
            default_release = next(
                (rel for rel in scanned.get("dataset_releases") or [] if rel.get("key") == default_release_key),
                None,
            )
            index_candidates = []
            if default_release:
                index_path = (default_release.get("files") or {}).get("index")
                if index_path:
                    index_candidates.append(Path(index_path))
            if not index_candidates:
                try:
                    gff_parent = Path(gff_path).resolve().parent
                    index_candidates = [
                        p for p in gff_parent.iterdir()
                        if p.is_file() and p.name.endswith(".index.db") and p.stat().st_size > 0
                    ]
                except Exception:
                    index_candidates = []
            if index_candidates:
                usable_indexes = []
                for candidate in index_candidates:
                    candidate_path = str(candidate.resolve())
                    try:
                        if _is_existing_index_usable(candidate_path, gff_path):
                            usable_indexes.append(candidate_path)
                    except Exception:
                        continue
                if usable_indexes:
                    canonical_name = f"{assembly}.gff3.index.db"
                    files["index"] = sorted(
                        usable_indexes,
                        key=lambda path: (Path(path).name != canonical_name, len(Path(path).name), Path(path).name),
                    )[0]
                elif "index" not in files and not default_release:
                    files["index"] = str(sorted(index_candidates, key=lambda path: path.name)[0].resolve())

        # Resolve display info
        scientific_name = str(manifest.get("scientific_name") or species_key.replace("_", " ").title()).strip()
        common_name = str(manifest.get("common_name") or "").strip()
        display_name = str(manifest.get("display_name") or "").strip()
        display_name_reason = str(manifest.get("display_name_reason") or "").strip()
        assembly_name = str(manifest.get("assembly_name") or assembly).strip()
        source_database = normalize_source_database(manifest.get("source_database"), provider, assembly)
        equivalent_accessions = [
            str(v).strip() for v in (manifest.get("equivalent_accessions") or []) if str(v).strip()
        ]

        sp = species_lookup.get(species_key)
        if sp:
            if hasattr(sp, "scientific_name"):
                scientific_name = sp.scientific_name or scientific_name
                common_name = sp.common_name or common_name
                display_name = getattr(sp, "display_name", "") or display_name
                display_name_reason = getattr(sp, "display_name_reason", "") or display_name_reason
                for a in sp.assemblies:
                    if a.gca == assembly or getattr(a, "accession", "") == assembly:
                        assembly_name = assembly_name or a.name
                        source_database = source_database or normalize_source_database(
                            getattr(a, "source_database", ""),
                            provider,
                            assembly,
                        )
                        equivalent_accessions = equivalent_accessions or list(getattr(a, "equivalent_accessions", []) or [])
                        break
            elif isinstance(sp, dict):
                scientific_name = sp.get("scientific_name") or scientific_name
                common_name = sp.get("common_name") or common_name
                display_name = sp.get("display_name") or display_name
                display_name_reason = sp.get("display_name_reason") or display_name_reason
                assembly_name = assembly_name or sp.get("assemblies", {}).get(assembly, assembly)

        genome_key = build_provider_aware_genome_key(species_key, assembly, provider)
        metadata = _genome_key_display_metadata(genome_key)
        if metadata:
            # `_genome_key_display_metadata` always answers something: with nothing in the
            # configuration and nothing in the catalogue it falls back to a title-cased
            # species key. That is a reasonable last resort, but it must not overwrite a
            # manifest that knows the real name — a genome actually called "Ensemblus
            # welcomus" was being listed everywhere as "Ensemblus Welcomus".
            derived_only = (
                not metadata.get("common_name")
                and metadata.get("scientific_name") == _format_species_key_for_display(species_key)
            )
            if not (derived_only and scientific_name):
                scientific_name = metadata.get("scientific_name") or scientific_name
                common_name = metadata.get("common_name") or common_name
                display_name = metadata.get("display_name") or display_name
                display_name_reason = metadata.get("display_name_reason") or display_name_reason
            if _is_useful_assembly_name(metadata.get("assembly_name"), assembly):
                assembly_name = metadata["assembly_name"]
        if not display_name:
            display_name = common_name or scientific_name
            display_name_reason = "unique_common" if common_name else "missing_common"

        assembly_key = build_provider_aware_genome_key(species_key, assembly, provider)
        default_release_key = str(scanned.get("default_dataset_release_key") or scanned.get("active_dataset_release_key") or "")
        default_release = next(
            (rel for rel in scanned.get("dataset_releases") or [] if rel.get("key") == default_release_key),
            None,
        )
        default_release_source = str((default_release or {}).get("source") or "")
        default_release_date = str((default_release or {}).get("date") or "")
        default_release_label = str((default_release or {}).get("label") or "")
        default_release_short_label = str((default_release or {}).get("short_label") or _release_short_label(default_release_source, default_release_date, default_release_label))
        default_selection_key = build_dataset_selection_key(
            species_key,
            assembly,
            provider,
            default_release_key,
            False,
        )

        base_record = {
            "provider": provider,
            "source_database": source_database,
            "species_key": species_key,
            "assembly": assembly,
            "gca": assembly if assembly.upper().startswith("GC") else "",
            "scientific_name": scientific_name,
            "common_name": common_name,
            "display_name": display_name,
            "display_name_reason": display_name_reason,
            "assembly_name": assembly_name,
            "equivalent_accessions": equivalent_accessions,
            "types": list(set(types)),
            "files": files,
            "has_annotation": has_annotation,
            "assembly_files": scanned.get("assembly_files") or {},
            "assembly_types": scanned.get("assembly_types") or [],
            "assembly_key": assembly_key,
            "selection_key": default_selection_key,
            "dataset_release_key": default_release_key,
            "dataset_release_source": default_release_source,
            "dataset_release_date": default_release_date,
            "dataset_release_label": default_release_label,
            "dataset_release_short_label": default_release_short_label,
            "active_dataset_release_key": scanned.get("active_dataset_release_key") or "",
            "default_dataset_release_key": default_release_key,
            "dataset_releases": scanned.get("dataset_releases") or [],
            "download_managed": download_managed,
            "delete_blocked_reason": "" if download_managed else _CUSTOM_FILES_DELETE_DETAIL,
            "is_demo": is_demo,
            # Carried through from the manifest so the record stays self-describing. A
            # tutorial's genomes are held as the catalogue's records rather than the
            # records the install returned, and registering one as browsable is refused
            # unless it can say which generated dataset it is — dropping this here left
            # every re-registration answering 400 and the genome browser unable to
            # recover the tutorial's genomes after a backend restart.
            "tutorial_dataset_id": str(manifest.get("tutorial_dataset_id") or ""),
            # The demo genome is not in any remote catalogue and never will be, so the
            # usual "we could not find this upstream" reasoning does not apply to it.
            "retired_remote": (not is_demo) and not (
                species_key in species_lookup
                and (
                    (
                        hasattr(species_lookup.get(species_key), "assemblies")
                        and any(
                            a.gca == assembly or getattr(a, "accession", "") == assembly
                            for a in getattr(species_lookup.get(species_key), "assemblies", []) or []
                        )
                    )
                    or (
                        isinstance(species_lookup.get(species_key), dict)
                        and assembly in ((species_lookup.get(species_key) or {}).get("assemblies") or {})
                    )
                )
            ) and provider == DEFAULT_PROVIDER,
        }

        dataset_instances = []
        for release in scanned.get("dataset_releases") or []:
            release_files = dict(release.get("files") or {})
            if not release_files.get("gff3"):
                continue
            release_key = str(release.get("key") or "")
            release_source = str(release.get("source") or "")
            release_date = str(release.get("date") or "")
            release_label = str(release.get("label") or _release_label(release_source, release_date))
            instance_files = {
                **(scanned.get("assembly_files") or {}),
                **release_files,
            }
            instance_types = sorted(set(list(scanned.get("assembly_types") or []) + list(release.get("types") or [])))
            dataset_instances.append({
                **base_record,
                "types": instance_types,
                "files": instance_files,
                "selection_key": build_dataset_selection_key(
                    species_key,
                    assembly,
                    provider,
                    release_key,
                    False,
                ),
                "dataset_release_key": release_key,
                "dataset_release_source": release_source,
                "dataset_release_date": release_date,
                "dataset_release_label": release_label,
                "dataset_release_short_label": str(release.get("short_label") or _release_short_label(release_source, release_date, release_label)),
                "is_default_dataset": release_key == default_release_key,
                "dataset_release": release,
            })
        base_record["dataset_instances"] = dataset_instances
        results.append(base_record)
    return results


class DeleteLocalFilesRequest(BaseModel):
    output_dir: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    dataset_release_key: str = ""


@app.delete("/api/remote/local-files")
async def delete_local_files(request: DeleteLocalFilesRequest):
    """Delete downloaded local files for a species/assembly."""
    provider = normalize_provider(request.provider)
    asm_dir = _resolve_species_assembly_dir(request.output_dir, request.species_key, request.assembly, provider=provider)
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")
    manifest = _load_genome_manifest(asm_dir, request.assembly)
    local_root = _resolve_local_data_root(request.output_dir)
    if request.dataset_release_key:
        source, date, release_key = _dataset_release_parts(
            provider,
            "gff3",
            release_key=request.dataset_release_key,
        )
        release_dir = asm_dir / "datasets" / source / date
        legacy_release = release_key == LEGACY_DATASET_RELEASE_KEY
        deletable, user_supplied = _downloaded_assembly_files(
            asm_dir,
            request.assembly,
            manifest,
            release_dir=None if legacy_release else release_dir,
            legacy_release=legacy_release,
            dataset_release_key=release_key,
        )
        if not deletable:
            if user_supplied:
                raise HTTPException(status_code=400, detail=_CUSTOM_FILES_DELETE_DETAIL)
            if not release_dir.is_dir():
                raise HTTPException(status_code=404, detail="Dataset release directory not found")
        deleted_count = _unlink_files(deletable)
        releases = manifest.get("dataset_releases")
        if isinstance(releases, dict):
            releases.pop(release_key, None)
            if manifest.get("active_dataset_release_key") == release_key:
                manifest["active_dataset_release_key"] = next(iter(releases.keys()), "")
            _write_genome_manifest(asm_dir, manifest)
        _prune_empty_download_dirs(asm_dir, local_root)
        return {"status": "deleted", "species_key": request.species_key, "assembly": request.assembly, "dataset_release_key": release_key, "deleted_files": deleted_count}

    deletable, user_supplied = _downloaded_assembly_files(asm_dir, request.assembly, manifest)
    if not deletable:
        if user_supplied:
            raise HTTPException(status_code=400, detail=_CUSTOM_FILES_DELETE_DETAIL)
        raise HTTPException(status_code=404, detail="No downloaded files found for this assembly")
    deleted_count = _unlink_files(deletable)
    # The manifest describes what is left; drop it only when nothing is.
    manifest_path = asm_dir / genome_manifest_filename(request.assembly)
    if manifest_path.exists() and not user_supplied:
        try:
            manifest_path.unlink()
        except Exception:
            pass
    _prune_empty_download_dirs(asm_dir, local_root)
    # Remove stale download task history for this species/assembly so UI does not
    # continue showing old completed/failed badges after files were deleted.
    remove_task_ids = [
        task_id
        for task_id, task in list(download_manager.tasks.items())
        if str(task.species_key or "") == str(request.species_key or "")
        and str(task.assembly or "") == str(request.assembly or "")
        and normalize_provider(task.provider) == provider
    ]
    for task_id in remove_task_ids:
        download_manager.tasks.pop(task_id, None)
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
    asm_dir = _resolve_species_assembly_dir(
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
    cfg = config if isinstance(config, dict) else load_config()
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
        asm_dir = _resolve_species_assembly_dir(
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

    manifest = _load_genome_manifest(asm_dir, descriptor.assembly)
    deletable, user_supplied = _downloaded_assembly_files(asm_dir, descriptor.assembly, manifest)
    for path in deletable:
        plan.add(path, "downloaded")

    # A custom annotation import copies the user's file into the managed
    # directory and records where it came from. The copy is ours to delete; the
    # original never is, so it is named here rather than silently kept.
    custom_sources = {
        str(record.get("source_path") or "").strip()
        for record in _download_manifest_file_records(manifest)
        if str(record.get("source_path") or "").strip()
    }
    for path in user_supplied:
        parts = path.relative_to(asm_dir).parts
        if parts[:2] == ("datasets", "custom"):
            plan.add(path, "app_copy")
        else:
            plan.protect(path, _CUSTOM_FILES_DELETE_DETAIL)
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
            cache_root=CACHE_DIR,
            foreign_seeds=foreign_seeds,
            index_basename=_index_basename_for_annotation(gff_path) if gff_path else "genome.gff3.index.db",
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
    config = load_config()
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

        config = load_config()
        output_dir = str(request.output_dir or config.get("output_dir") or "").strip()
        local_root = _resolve_local_data_root(output_dir) if output_dir else None

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
                asm_dir = _resolve_species_assembly_dir(
                    output_dir,
                    descriptor.species_key,
                    descriptor.assembly,
                    provider=normalize_provider(descriptor.provider),
                )
                if local_root is not None and asm_dir.is_dir():
                    _prune_empty_download_dirs(asm_dir, local_root)
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
        for task_id, task in list(download_manager.tasks.items()):
            key = (str(task.species_key or ""), str(task.assembly or ""), normalize_provider(task.provider))
            if key in removed_pairs:
                download_manager.tasks.pop(task_id, None)

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


@app.get("/api/remote/tasks")
async def list_download_tasks():
    """List all download tasks."""
    return list(download_manager.tasks.values())


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
        task["progress"] = min(1.0, float(task["completed"]) / total)
        task["updated_at"] = now_iso()


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
        cache_path = choose_stats_cache_path(species, output_dir, CACHE_DIR)
        cache = load_stats_cache(cache_path)
        sections = cache.get("sections") or {}
        computed_at = cache.get("computed_at") or {}
        changed = False
        if "structural" in sections:
            sections.pop("structural", None)
            changed = True
        if "structural" in computed_at:
            computed_at.pop("structural", None)
            changed = True
        if changed:
            cache["sections"] = sections
            cache["computed_at"] = computed_at
            save_stats_cache(cache_path, cache)
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
        manifest = _load_genome_manifest(candidate_dir, assembly)
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
        result = fetch_ena_metadata(accession, _ENA_METADATA_CACHE_PATH)
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
    resolved = _resolve_annotation_index(
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
        cache_path = choose_stats_cache_path(species, output_dir, CACHE_DIR)
        existing_cache = load_stats_cache(cache_path)
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
            save_stats_cache(cache_path, cache)

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

            cache_path = choose_stats_cache_path(species, output_dir, CACHE_DIR)
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
                {"status": "running", "message": "Computing core structural metrics..."},
                mark_complete=False,
            )

            quick = await asyncio.to_thread(
                compute_structural_stats,
                str(idx.get("path")),
                str(fasta.get("path")),
                structural_profile,
                False,
            )
            if _is_task_genome_cancelled(task_id, genome_key_value):
                _clear_structural_cache_for_species(species, output_dir)
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "canceled", "message": "Canceled by user."},
                )
                continue
            cache.setdefault("sections", {})["structural"] = quick
            cache.setdefault("computed_at", {})["structural"] = now_iso()
            save_stats_cache(cache_path, cache)
            _update_stats_task_result(
                task_id,
                genome_key_value,
                {"status": "running", "message": "Core metrics ready. Calculating sequence checks...", "cache_path": str(cache_path)},
                mark_complete=False,
            )

            computed = await asyncio.to_thread(
                compute_structural_stats,
                str(idx.get("path")),
                str(fasta.get("path")),
                structural_profile,
                True,
            )
            if _is_task_genome_cancelled(task_id, genome_key_value):
                _clear_structural_cache_for_species(species, output_dir)
                _update_stats_task_result(
                    task_id,
                    genome_key_value,
                    {"status": "canceled", "message": "Canceled by user."},
                )
                continue
            cache.setdefault("sections", {})["structural"] = computed
            cache.setdefault("computed_at", {})["structural"] = now_iso()
            save_stats_cache(cache_path, cache)
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

    config = load_config()
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
    structural_profile = str(request.structural_profile or STRUCTURAL_PROFILE)
    if structural_profile != STRUCTURAL_PROFILE:
        raise HTTPException(status_code=400, detail=f"Unsupported structural profile: {structural_profile}")

    config = load_config()
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
async def stats_cancel_structural(request: StructuralStatsCancelRequest):
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
    config = load_config()
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

_ASSEMBLY_REPORT_ROWS_CACHE: Dict[str, Dict[str, Any]] = {}
_ASSEMBLY_REPORT_ROWS_CACHE_GUARD = threading.Lock()


def _load_cached_assembly_report_rows(path: str) -> List[Any]:
    fp = Path(path).expanduser().resolve()
    if not fp.exists() or not fp.is_file():
        return []
    try:
        st = fp.stat()
    except Exception:
        return []

    key = str(fp)
    with _ASSEMBLY_REPORT_ROWS_CACHE_GUARD:
        cached = _ASSEMBLY_REPORT_ROWS_CACHE.get(key)
        if cached and int(cached.get("mtime_ns") or 0) == int(st.st_mtime_ns) and int(cached.get("size") or 0) == int(st.st_size):
            return list(cached.get("rows") or [])

    rows = load_assembly_synonym_rows(str(fp))
    with _ASSEMBLY_REPORT_ROWS_CACHE_GUARD:
        _ASSEMBLY_REPORT_ROWS_CACHE[key] = {
            "mtime_ns": int(st.st_mtime_ns),
            "size": int(st.st_size),
            "rows": rows,
        }
    return rows


def _active_species_item_key(species: Optional[Dict[str, Any]]) -> str:
    raw = species or {}
    return selection_key_from_record(raw) or build_provider_aware_genome_key(
        str(raw.get("species_key") or "").strip(),
        str(raw.get("assembly") or raw.get("gca") or "").strip(),
        raw.get("provider"),
        bool(raw.get("is_manual")),
    )


def _dedupe_active_species(species_list: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for species in list(species_list or []):
        if not isinstance(species, dict):
            continue
        key = _active_species_item_key(species)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(species)
    return out


def _find_species_for_gff(cfg: Dict[str, Any], gff_path: str) -> Optional[Dict[str, Any]]:
    target = str(gff_path or "").strip()
    if not target:
        return None
    for species in _dedupe_active_species(cfg.get("active_species") or []):
        files = species.get("files") or {}
        if str(files.get("gff3") or "").strip() == target:
            return species
    return None


def _browse_index_for(gff_path: str, db_path: str, cfg: Dict[str, Any], species: Optional[Dict[str, Any]]) -> str:
    """The index to browse ``gff_path`` with: the saved one, or one from disk."""
    saved = str(db_path or "").strip()
    if saved and os.path.exists(saved):
        return saved
    assembly = str((species or {}).get("assembly") or (species or {}).get("gca") or "").strip()
    return _resolve_annotation_index(gff_path, cfg, assembly) or saved


def _browsable_active_species(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The genomes the browser may be asked to resolve.

    Include the selected session pool so Cycle can preview an inactive genome without
    changing the active selection. Active records win over saved session snapshots.
    Tutorial genomes remain registered separately from the user's configuration.
    """
    return _dedupe_active_species(
        list(cfg.get("active_species") or []) + tutorial_session_species()
        + list(cfg.get("next_previous_session_genomes") or [])
    )


def _resolve_browse_genome_context(genome: str) -> Dict[str, Any]:
    cfg = load_config()
    token = str(genome or "reference").strip() or "reference"
    legacy = token.lower()
    active_species = _browsable_active_species(cfg)

    if legacy in {"reference", "target"}:
        if legacy == "reference":
            gff_path = str(cfg.get("ref_gff") or "").strip()
            species = _find_species_for_gff(cfg, gff_path)
            return {
                "request": token,
                "cache_key": "reference",
                "db_path": _browse_index_for(gff_path, str(cfg.get("ref_index") or "").strip(), cfg, species),
                "gff_path": gff_path,
                "fasta_path": str(cfg.get("ref_fasta") or "").strip(),
                "species": species,
            }
        gff_path = str(cfg.get("target_gff") or "").strip()
        species = _find_species_for_gff(cfg, gff_path)
        return {
            "request": token,
            "cache_key": "target",
            "db_path": _browse_index_for(gff_path, str(cfg.get("target_index") or "").strip(), cfg, species),
            "gff_path": gff_path,
            "fasta_path": str(cfg.get("target_fasta") or "").strip(),
            "species": species,
        }

    species = next((s for s in active_species if _active_species_item_key(s) == token), None)
    if not species:
        assembly_token = strip_dataset_release_from_selection_key(token)
        species = next(
            (
                s for s in active_species
                if str(s.get("assembly_key") or "").strip() == assembly_token
                or build_provider_aware_genome_key(
                    s.get("species_key"),
                    s.get("assembly") or s.get("gca"),
                    s.get("provider"),
                    bool(s.get("is_manual")),
                ) == assembly_token
            ),
            None,
        )
    if not species:
        species = next(
            (
                s for s in active_species
                if legacy_genome_key(s.get("species_key"), s.get("assembly") or s.get("gca")) == token
            ),
            None,
        )
    if not species:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid genome: {genome}. Use 'reference', 'target', or a genome key such as '<provider>::<species_key>::<assembly>'."
        )

    files = species.get("files") or {}
    gff_path = str(files.get("gff3") or "").strip()
    db_path = str(files.get("index") or "").strip()
    fasta_path = str(files.get("fasta") or "").strip()

    ref_gff = str(cfg.get("ref_gff") or "").strip()
    tgt_gff = str(cfg.get("target_gff") or "").strip()
    if not db_path and gff_path:
        if gff_path == ref_gff:
            db_path = str(cfg.get("ref_index") or "").strip()
        elif gff_path == tgt_gff:
            db_path = str(cfg.get("target_index") or "").strip()
    if not fasta_path and gff_path:
        if gff_path == ref_gff:
            fasta_path = str(cfg.get("ref_fasta") or "").strip()
        elif gff_path == tgt_gff:
            fasta_path = str(cfg.get("target_fasta") or "").strip()

    return {
        "request": token,
        "cache_key": token,
        "db_path": _browse_index_for(gff_path, db_path, cfg, species),
        "gff_path": gff_path,
        "fasta_path": fasta_path,
        "species": species,
    }


def _genome_browsable_ranges(genome: str) -> Dict[str, Any]:
    """Per-region browsable windows a genome's manifest declares, if any.

    Read from the manifest on disk rather than from the genome record, because the record
    is assembled by ``list_local_assemblies`` and carries only the fields it knows about.
    Empty for everything that does not declare one, which is everything except the
    tutorial's chromosome-1 slice.
    """
    try:
        context = _resolve_browse_genome_context(genome)
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


def _get_genome_metadata_path(genome: str) -> Optional[str]:
    context = _resolve_browse_genome_context(genome)
    species = context.get("species") or {}
    files = species.get("files") or {}

    metadata_path = str(files.get("metadata") or "").strip()
    if metadata_path:
        mp = Path(metadata_path).expanduser().resolve()
        if mp.exists() and mp.is_file():
            return str(mp)

    gff_path = str(context.get("gff_path") or "").strip()
    if not gff_path:
        return None

    assembly_dir = Path(gff_path).expanduser().resolve().parent
    fallback = _find_assembly_report_file(assembly_dir)
    if fallback:
        return str(fallback.resolve())
    return None


#: Prepared region-name lookups and synonym indexes, keyed by the exact region
#: list they describe. Small: a handful of entries, one per genome being browsed.
_KNOWN_REGIONS_CACHE: "OrderedDict[Tuple[str, ...], KnownRegions]" = OrderedDict()
_KNOWN_REGIONS_CACHE_GUARD = threading.Lock()
_SYNONYM_INDEX_CACHE: "OrderedDict[Tuple[Any, ...], Dict[str, Dict[str, List]]]" = OrderedDict()
_SYNONYM_INDEX_CACHE_GUARD = threading.Lock()
_REGION_CACHE_LIMIT = 8


def _trim_region_cache(cache: "OrderedDict[Any, Any]", key: Any, value: Any) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > _REGION_CACHE_LIMIT:
        cache.popitem(last=False)


def _known_regions_lookup(known_regions: Iterable[str]) -> KnownRegions:
    """Prepared name lookups for a genome's regions, reused across requests.

    Preparing these walks every sequence in the assembly. Each browse request
    resolves the chromosome it was asked for, so on a genome with hundreds of
    thousands of scaffolds that walk was being repeated on every pan and zoom.
    """
    regions = tuple(known_regions)
    with _KNOWN_REGIONS_CACHE_GUARD:
        cached = _KNOWN_REGIONS_CACHE.get(regions)
        if cached is not None:
            _KNOWN_REGIONS_CACHE.move_to_end(regions)
            return cached

    prepared = KnownRegions(regions)
    with _KNOWN_REGIONS_CACHE_GUARD:
        _trim_region_cache(_KNOWN_REGIONS_CACHE, regions, prepared)
    return prepared


def _synonym_index_cache_key(metadata_path: str, known_regions: Iterable[str]) -> Optional[Tuple[Any, ...]]:
    try:
        st = Path(metadata_path).stat()
    except OSError:
        return None
    return (metadata_path, int(st.st_mtime_ns), int(st.st_size), tuple(known_regions))


def _build_genome_synonym_index(genome: str, known_regions: List[str]) -> Dict[str, Dict[str, List]]:
    """Alias/canonical name mapping for a genome's regions.

    Cached, because building it pairs every sequence in the assembly with every
    row of its assembly report. A scaffold-level genome has hundreds of
    thousands of both, and /api/browse/regions and /api/browse/genes would
    otherwise rebuild it on every single request — including the browser's
    readiness poll, which repeats every 1.5 seconds until the view loads, so the
    backend ran out of request threads before the first one ever finished.

    The cached value is shared between callers and must be treated as read-only.
    """
    metadata_path = _get_genome_metadata_path(genome)
    if not metadata_path:
        return {"canonical_to_synonyms": {}, "alias_to_candidates": {}}

    cache_key = _synonym_index_cache_key(metadata_path, known_regions)
    if cache_key is not None:
        with _SYNONYM_INDEX_CACHE_GUARD:
            cached = _SYNONYM_INDEX_CACHE.get(cache_key)
            if cached is not None:
                _SYNONYM_INDEX_CACHE.move_to_end(cache_key)
                return cached

    rows = _load_cached_assembly_report_rows(metadata_path)
    # Built outside the lock: it is slow, and two callers racing to build the
    # same index is far cheaper than every other genome waiting behind one.
    index = (
        build_synonym_index(rows, _known_regions_lookup(known_regions))
        if rows
        else {"canonical_to_synonyms": {}, "alias_to_candidates": {}}
    )

    if cache_key is not None:
        with _SYNONYM_INDEX_CACHE_GUARD:
            _trim_region_cache(_SYNONYM_INDEX_CACHE, cache_key, index)
    return index


def _resolve_browse_chrom_name(genome: str, requested: str, known_regions: List[str]) -> str:
    token = str(requested or "").strip()
    if not token:
        return token
    synonym_index = _build_genome_synonym_index(genome, known_regions)
    resolved = resolve_region_name(
        token,
        _known_regions_lookup(known_regions),
        synonym_index.get("alias_to_candidates"),
    )
    return resolved or token

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
        with open_maybe_gz(gff_path, 'r') as f:
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
        with open_maybe_gz(gff_path, 'r') as f:
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


#: "Too Early" — the annotation index this request needs is still being built.
#: Distinct from 404 so callers can tell "come back shortly" from "there is no
#: annotation at all", and so the browser keeps polling instead of giving up.
INDEX_BUILDING_STATUS = 425


#: Index paths recovered from disk for annotations whose saved entry has none,
#: keyed by annotation path. Only successful lookups are remembered: a genome
#: that has no index yet must keep looking, or it would never notice the build
#: landing next to its GFF.
_RECOVERED_INDEX_PATHS: Dict[str, str] = {}
_RECOVERED_INDEX_GUARD = threading.Lock()


def _index_build_error_for(gff_path: str, db_path: str) -> str:
    """The error from the last finished build of this annotation, if it failed.

    Browsing queues a build for an annotation that has no index, and the browser
    polls until it lands. An annotation the indexer cannot read would turn that
    into an endless rebuild loop, so a failure has to be reported rather than
    retried on every poll.

    A failure is tied to the exact bytes that caused it. Replace the annotation —
    re-download a truncated file, repair a malformed one — and the recorded
    signature no longer matches, so the genome starts building again by itself
    instead of holding on to an error about a file that is no longer there.
    :func:`forget_index_failures` is the manual way out for everything else.
    """
    normalized_gff = _normalize_fs_path(gff_path)
    normalized_db = _normalize_fs_path(db_path)
    latest: Optional[Dict[str, Any]] = None
    with _index_tasks_guard:
        for task in _index_tasks.values():
            if task.get("status") not in {"success", "failed"}:
                continue
            if task.get("gff_path") != normalized_gff and task.get("db_path") != normalized_db:
                continue
            completed = str(task.get("completed_at") or "")
            if latest is None or completed >= str(latest.get("completed_at") or ""):
                latest = task
    if latest is None or latest.get("status") != "failed":
        return ""

    recorded_signature = str(latest.get("gff_signature") or "")
    if recorded_signature and recorded_signature != _annotation_signature(normalized_gff):
        forget_index_failures(normalized_gff, normalized_db)
        return ""
    return str(latest.get("error") or "The annotation index could not be built.")


def _resolve_annotation_index(gff_path: str, cfg: Dict[str, Any], assembly: str = "") -> str:
    """Find, or name, the index for an annotation whose saved entry has none.

    A genome's ``files`` block is a snapshot taken when it was registered, so a
    genome activated before its index existed carries an empty ``index`` for
    ever: the build finishes, the file lands beside the GFF, and browsing still
    reports a genome with no genes. RefSeq downloads hit this every time, since
    the annotation arrives with no index and the browser is usually the next
    place the user goes.

    Reading the directory keeps browsing honest about what is actually on disk.
    When nothing is there yet, naming the path the build would write lets
    :func:`_get_browse_db` queue it and answer "still building" — which the
    browser already polls on — instead of "no annotation".
    """
    # Guard on the raw value: _normalize_fs_path("") resolves to the working
    # directory, which exists, and would send everything below off hunting for
    # an index for a genome that has no annotation at all.
    if not str(gff_path or "").strip():
        return ""
    normalized_gff = _normalize_fs_path(gff_path)
    if not os.path.exists(normalized_gff):
        return ""

    with _RECOVERED_INDEX_GUARD:
        remembered = _RECOVERED_INDEX_PATHS.get(normalized_gff, "")
    if remembered and os.path.exists(remembered):
        return remembered

    found = _resolve_local_gff_index(normalized_gff, assembly)
    if found:
        with _RECOVERED_INDEX_GUARD:
            _RECOVERED_INDEX_PATHS[normalized_gff] = found
        return found

    # Nothing built yet. Point at whatever build is already in flight for this
    # annotation, so a build started from the selector and one queued by the
    # browser converge on the same file.
    with _index_tasks_guard:
        for task in _index_tasks.values():
            if task.get("status") in {"queued", "running"} and task.get("gff_path") == normalized_gff:
                return str(task.get("db_path") or "")

    try:
        return str(_resolve_index_path(
            normalized_gff,
            str(cfg.get("output_dir") or ""),
            _index_basename_for_annotation(normalized_gff),
        ))
    except Exception:
        return ""


def _get_browse_db(genome: str) -> str:
    """Resolve the SQLite index path for a given genome from config.

    Validates that the index was built from the currently configured GFF.

    Browsing never builds the index itself. Building one takes minutes on a
    large annotation, and doing it inside a request blocked every other request
    behind it: the selector could not list genomes, and the browser's own
    readiness poll — which is what would have shown the build finishing — could
    not be answered either. A missing or stale index is handed to the background
    index worker and reported as :data:`INDEX_BUILDING_STATUS`.
    """
    context = _resolve_browse_genome_context(genome)
    db = str(context.get("db_path") or "")
    gff = str(context.get("gff_path") or "")
    if not db:
        raise HTTPException(status_code=404, detail=f"Index not found for {genome} genome. Generate indexes first.")

    if gff and os.path.exists(gff):
        if _is_existing_index_usable(db, gff):
            return _normalize_fs_path(db)
        build_error = _index_build_error_for(gff, db)
        if build_error:
            raise HTTPException(
                status_code=500,
                detail=f"The annotation index for the {genome} genome could not be built: {build_error}",
            )
        try:
            queue_index_build(gff, db)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to prepare index for {genome} genome: {exc}",
            )
        raise HTTPException(
            status_code=INDEX_BUILDING_STATUS,
            detail=f"The annotation index for the {genome} genome is still being built.",
        )

    if not os.path.exists(db):
        raise HTTPException(status_code=404, detail=f"Index not found for {genome} genome. Generate indexes first.")
    return db


def _get_browse_db_optional(genome: str) -> str:
    """Like :func:`_get_browse_db` but returns ``''`` when there is no annotation.

    A genome may be loaded with a FASTA alone, in which case the sequence track
    and any attached data tracks still work and only the gene track is empty.
    Callers that can render without genes use this instead of 404ing.

    A genome that *does* have an annotation whose index is not built yet still
    raises :data:`INDEX_BUILDING_STATUS`. Returning "" there would render the
    genome as though it had no genes and never correct itself once the build
    finished; the status keeps the caller polling.
    """
    try:
        return _get_browse_db(genome)
    except HTTPException as exc:
        if exc.status_code == 404:
            return ""
        raise


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
    normalized_gff = _normalize_fs_path(gff_path)
    normalized_db = _normalize_fs_path(db_path) if db_path else ""
    with _index_tasks_guard:
        for task_id, task in _index_tasks.items():
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
    context = _resolve_browse_genome_context(genome)
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

    if db_path and _is_existing_index_usable(db_path, gff_path):
        status["state"] = INDEX_STATE_READY
        status["percent"] = 100.0
        return status

    task_id, task = _live_index_task_for(gff_path, db_path)
    if task_id:
        positions = _queued_index_positions()
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

    build_error = _index_build_error_for(gff_path, db_path)
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
        context = _resolve_browse_genome_context(request.genome)
        gff_path = str(context.get("gff_path") or "")
        db_path = str(context.get("db_path") or "")
        if not gff_path or not os.path.exists(gff_path):
            raise HTTPException(
                status_code=404,
                detail=f"No annotation is configured for the {request.genome} genome.",
            )
        forgotten = forget_index_failures(gff_path, db_path)
        if not db_path:
            raise HTTPException(
                status_code=500,
                detail=f"Could not work out where to write the index for {request.genome}.",
            )
        task_id, task_status = queue_index_build(gff_path, db_path)
        return {"task_id": task_id, "status": task_status, "cleared_failures": forgotten}

    return await run_in_threadpool(_retry)


_fasta_cache = {}  # genome -> (config_path, pysam.FastaFile)


def _get_browse_fasta(genome: str):
    """Resolve and load FASTA for a given genome from config. Caches the file handle."""
    context = _resolve_browse_genome_context(genome)
    cache_key = str(context.get("cache_key") or str(genome or "").strip() or "reference")
    fasta_path = str(context.get("fasta_path") or "")
    if not fasta_path or not os.path.exists(fasta_path):
        species = context.get("species") or {}
        label = (
            str(species.get("assembly_name") or "").strip()
            or str(species.get("assembly") or species.get("gca") or "").strip()
            or cache_key
        )
        if not fasta_path:
            detail = f"FASTA not configured for {label} ({genome}) genome."
        else:
            detail = f"FASTA not found for {label} ({genome}) genome: {fasta_path}"
        raise HTTPException(status_code=404, detail=detail)

    # Return cached handle if path hasn't changed
    cached = _fasta_cache.get(cache_key)
    if cached and cached[0] == fasta_path:
        return cached[1]

    # ensure_fasta_index may return a decompressed path if the original was gzip (not bgzip)
    fasta = open_indexed_fasta(fasta_path)
    _fasta_cache[cache_key] = (fasta_path, fasta)
    return fasta


def _force_refresh_browse_fasta_index(genome: str, current_fasta: Optional["ThreadSafeFasta"] = None):
    """Force FASTA re-index + handle refresh for a genome cache entry."""
    context = _resolve_browse_genome_context(genome)
    cache_key = str(context.get("cache_key") or str(genome or "").strip() or "reference")
    fasta_path = str(context.get("fasta_path") or "")
    if not fasta_path or not os.path.exists(fasta_path):
        raise HTTPException(status_code=404, detail=f"FASTA not found for {genome} genome.")

    refreshed = open_indexed_fasta(fasta_path, force_reindex=True)
    _fasta_cache[cache_key] = (fasta_path, refreshed)

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
        return _get_browse_db(genome), False
    except HTTPException as exc:
        if exc.status_code == 404:
            return "", False
        if exc.status_code == INDEX_BUILDING_STATUS:
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
            fasta = _get_browse_fasta(genome)
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
                    status_code=INDEX_BUILDING_STATUS,
                    detail=f"The annotation index for the {genome} genome is still being built.",
                )
            # Neither an annotation nor a readable FASTA: there is genuinely
            # nothing configured for this genome.
            raise HTTPException(
                status_code=404,
                detail=f"No annotation or FASTA is configured for the {genome} genome.",
            )

        known_regions = [str(r.chrom or "").strip() for r in results if str(r.chrom or "").strip()]
        synonym_index = _build_genome_synonym_index(genome, known_regions)
        canonical_to_synonyms = synonym_index.get("canonical_to_synonyms") or {}
        for region in results:
            region.synonyms = list(canonical_to_synonyms.get(region.chrom, []))

        # Populate display_name: for regions named by accession (e.g. NC_000001.11),
        # prefer the human-readable sequence_name (e.g. "1", "X", "MT") from the
        # assembly/sequence report for assembled molecules.
        metadata_path = _get_genome_metadata_path(genome)
        if metadata_path:
            report_rows = _load_cached_assembly_report_rows(metadata_path)
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
    db_path = await run_in_threadpool(_get_browse_db_optional, genome)
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
                resolved_chrom = _resolve_browse_chrom_name(genome, requested_chrom, known_regions)

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
    db_path = await run_in_threadpool(_get_browse_db, genome)

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
            fasta = _get_browse_fasta(genome)
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

    db_path = await run_in_threadpool(_get_browse_db, genome)
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
    db_path = await run_in_threadpool(_get_browse_db, genome)
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
            if not tx_tags:
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
    
    db_path = await run_in_threadpool(_get_browse_db, genome)
    
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
            if not tx_tags:
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

    db_path = await run_in_threadpool(_get_browse_db, genome)

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


def alignment_explorer_annotation_features(genome, chrom, start, end, sequence, strand, transcript_id=None):
    """Project indexed GFF3 transcript features using the existing MSA annotation mapper."""
    db_path = _get_browse_db(genome)
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
        tx = find_transcript_in_index(db_path, tx_id)
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
        fasta = _get_browse_fasta(genome)
        requested_chrom = str(chrom or "").strip()
        try:
            seq = fasta.fetch(requested_chrom, start, end)
            seq_upper = str(seq).upper()
            return {"sequence": seq_upper, "chrom": requested_chrom, "start": start, "end": end, "length": len(seq_upper)}
        except (ValueError, KeyError) as first_err:
            known_regions = [str(r or "").strip() for r in list(fasta.references or []) if str(r or "").strip()]
            fallback = _resolve_browse_chrom_name(genome, requested_chrom, known_regions)
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
    db_path = _get_browse_db(genome)
    gene, transcripts = _feature_explorer_load_gene_and_transcripts(db_path, gene_id)
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{gene_id}' not found in {genome} genome.")

    ordered_transcripts, active_set = _feature_explorer_order_transcripts(transcripts, transcript_ids, include_inactive)
    total_transcripts = len(ordered_transcripts)
    fasta = _get_browse_fasta(genome) if include_sequence_fields else None

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
        fasta = _get_browse_fasta(genome)
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
    db_path = await run_in_threadpool(_get_browse_db, genome)

    def _query():
        fasta = _get_browse_fasta(genome)
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
        with open_maybe_gz(gff_path, 'r') as f:
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


def _assembly_report_taxid(path: str) -> int:
    """Taxid from an NCBI-style assembly report header ('# Taxid: 9606')."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.startswith("#"):
                    break
                match = re.match(r"#\s*Taxid:\s*(\d+)", line)
                if match:
                    return int(match.group(1))
    except Exception:
        return 0
    return 0


def _genome_taxid(genome: str, species: Dict[str, Any]) -> int:
    """Best-effort NCBI taxid for a configured genome."""
    for key in ("taxid", "species_taxonomy_id", "taxonomy_id"):
        try:
            value = int(species.get(key) or 0)
        except Exception:
            value = 0
        if value:
            return value

    catalog_key = _find_catalog_species_key(species.get("species_key"))
    info = (getattr(download_manager, "species_data", {}) or {}).get(catalog_key) or {}
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
        metadata_path = _get_genome_metadata_path(genome)
    except Exception:
        metadata_path = None
    if metadata_path:
        return _assembly_report_taxid(metadata_path)
    return 0


def _genome_lineage(genome: str, species: Dict[str, Any]) -> Tuple[int, ...]:
    taxid = _genome_taxid(genome, species)
    if not taxid:
        return ()
    classifier = getattr(download_manager, "taxonomy_classifier", None)
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
    context = _resolve_browse_genome_context(genome)
    species = context.get("species") or {}
    try:
        metadata_path = _get_genome_metadata_path(genome)
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
        for row in _load_cached_assembly_report_rows(metadata_path):
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
    db_path = await run_in_threadpool(_get_browse_db, genome)

    def _query():
        fasta = _get_browse_fasta(genome)

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
STRUCTURE_ASSET_DIR = BASE_PATH / "static" / "structure"

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
    path = CACHE_DIR / "structures"
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
        section = (load_config() or {}).get(STRUCTURE_CONFIG_KEY) or {}
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
        context = _resolve_browse_genome_context(genome)
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

    db_path = _get_browse_db(genome)
    fasta = _get_browse_fasta(genome)

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
        dna = _cds_dna_from_layout(_get_browse_fasta(genome), chrom, strand, layout)

        config = load_config()
        registry = _load_track_registry(config)
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

        config = load_config() or {}
        config[STRUCTURE_CONFIG_KEY] = {
            **(config.get(STRUCTURE_CONFIG_KEY) or {}),
            "uniprot_map_path": str(destination),
            "uniprot_map_origin": str(source),
            "uniprot_map_imported_at": datetime.now().isoformat(timespec="seconds"),
        }
        save_config(config)

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
        config = load_config() or {}
        section = dict(config.get(STRUCTURE_CONFIG_KEY) or {})
        section.pop("uniprot_map_path", None)
        section.pop("uniprot_map_origin", None)
        section.pop("uniprot_map_imported_at", None)
        config[STRUCTURE_CONFIG_KEY] = section
        save_config(config)
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
    await run_in_threadpool(_get_browse_db, genome)

    bw_path = Path(path).expanduser()
    if not bw_path.exists() or not bw_path.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig file not found: {bw_path}")

    bins = max(20, min(4000, int(bins)))
    requested_chrom_len: Optional[int] = None
    try:
        fasta = _get_browse_fasta(genome)
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

            raw_stats = bw.stats(resolved_chrom, q_start, q_end, nBins=bins, type="mean") or []
            if len(raw_stats) < bins:
                raw_stats = raw_stats + [None] * (bins - len(raw_stats))
            elif len(raw_stats) > bins:
                raw_stats = raw_stats[:bins]

            values: List[Optional[float]] = []
            for value in raw_stats:
                if value is None:
                    values.append(None)
                elif isinstance(value, float) and math.isnan(value):
                    values.append(None)
                else:
                    values.append(float(value))

            observed = [v for v in values if v is not None]
            has_data = len(observed) > 0

            return {
                "path": str(bw_path),
                "chrom": chrom,
                "resolved_chrom": resolved_chrom,
                "start": q_start,
                "end": q_end,
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
        return _resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_REGISTRY_FILENAME
    except Exception:
        return None


def _sv_alignment_scan_dir(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return _resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_SCAN_DIRNAME
    except Exception:
        return None


def _sv_attached_config_paths(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    """Config files the user has attached, in the order they were attached."""
    state = config if isinstance(config, dict) else load_config()
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
            handle = open_indexed_fasta(str(path))
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
        local_root = _resolve_local_data_root(output_dir) if output_dir else None
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
        local_root = _resolve_local_data_root(output_dir) if output_dir else None
    except Exception:
        local_root = None
    if local_root and local_root.is_dir():
        for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
            try:
                manifest = _load_genome_manifest(asm_dir, assembly)
                scanned = _scan_local_assembly(asm_dir, assembly, manifest)
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
    resolved = _resolve_browse_chrom_name(genome, token, known_regions)
    if resolved and resolved in known_regions:
        return resolved
    if resolved:
        return _resolve_db_chrom_name(db_path, resolved)
    return None


def _resolve_genome_chrom_length(genome: str, *tokens: Optional[str]) -> Tuple[Optional[str], int]:
    try:
        fasta = _get_browse_fasta(genome)
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
        return str(load_config().get("output_dir") or "").strip()
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
        if not download_manager._species_cache and download_manager.species_data:
            download_manager._build_cache()
    except Exception:
        pass

    if download_manager._species_cache:
        for species in download_manager._species_cache:
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

    for species_key, species_info in (download_manager.species_data or {}).items():
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
        local_assemblies = await list_local_assemblies(output_dir_text) if output_dir_text else []
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


def _sv_write_config_file(path: Path, config: Dict[str, Any]) -> str:
    """Write a config atomically, under the same lock every SV write takes."""
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

    text = _sv_write_config_file(destination, final)
    if payload.attach:
        _sv_attach_config_path(destination)
    return {"ok": True, "path": str(destination), "text": text, "diagnostics": diagnostics}


class SvConfigAttachRequest(BaseModel):
    path: str


def _sv_attach_config_path(path: Path) -> List[str]:
    config = load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip()]
    if str(path) not in paths:
        paths.append(str(path))
    config["sv_config_paths"] = paths
    save_config(config)
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
async def detach_sv_config(payload: SvConfigAttachRequest):
    """Stop reading a config file. The file itself is left alone."""
    target = str(Path(str(payload.path or "").strip()).expanduser())
    config = load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip() and str(item) != target]
    config["sv_config_paths"] = paths
    save_config(config)
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
            ref_db_path = _get_browse_db(resolved_ref_browse_genome)
            tgt_db_path = _get_browse_db(resolved_tgt_browse_genome)
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

    db_path = await run_in_threadpool(_get_browse_db, genome)

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
        fasta = _get_browse_fasta(genome)

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
        db_path = _get_browse_db(genome)
        fasta   = _get_browse_fasta(genome)

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



# ═══════════════════════════════════════════════════════════════════════════════
#  Track Manager — Registry & Data Endpoints
# ═══════════════════════════════════════════════════════════════════════════════

OUTPUT_DIR_TRACK_REGISTRY_FILENAME = "track_registry.json"
DEFAULT_TRACK_REGISTRY_FILE = CACHE_DIR / OUTPUT_DIR_TRACK_REGISTRY_FILENAME
TRACK_REGISTRY_FILE = DEFAULT_TRACK_REGISTRY_FILE

TRACK_EXTENSION_MAP: Dict[str, str] = {
    ".bw":         "bigwig",
    ".bigwig":     "bigwig",
    ".bb":         "bigbed",
    ".bigbed":     "bigbed",
    ".vcf.gz":     "vcf",
    ".vcf":        "vcf",
    ".bed.gz":     "bed",
    ".bed":        "bed",
    ".bam":        "bam",
    ".sj.out.tab": "splice_junctions",
}

TRACK_DISPLAY_MODES: Dict[str, List[str]] = {
    "bigwig":           ["zoned_heatmap", "signal_plot"],
    "bigbed":           ["intervals"],
    "vcf":              ["density_lollipop", "adaptive", "ensembl", "lollipop", "density"],
    "bed":              ["intervals", "density"],
    "bam":              ["coverage", "reads_coverage"],
    "long_reads":       ["collapsed_transcripts"],
    "splice_junctions": ["arcs"],
}

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_BIGWIG_DATA_TYPES: Set[str] = {"rna_seq", "atac_seq", "chip_seq", "custom"}
BIGWIG_DATA_TYPE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "rna_seq": {
        "display_mode": "zoned_heatmap",
        "plot_color": "#3b82f6",
        "zoned_colors": ["#f7cd61", "#f4a940", "#ea7a2d", "#cc2f1f"],
    },
    "atac_seq": {
        "display_mode": "signal_plot",
        "plot_color": "#b52aa1",
        "zoned_colors": ["#86efac", "#4ade80", "#22c55e", "#15803d"],
    },
    "chip_seq": {
        "display_mode": "signal_plot",
        "plot_color": "#8b5cf6",
        "zoned_colors": ["#c4b5fd", "#a78bfa", "#8b5cf6", "#6d28d9"],
    },
    "custom": {
        "display_mode": "signal_plot",
        "plot_color": "#14b8a6",
        "zoned_colors": ["#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8"],
    },
}

VCF_DISPLAY_MODES: Set[str] = {"density_lollipop", "adaptive"}
VCF_SETTINGS_DEFAULTS: Dict[str, str] = {
    "genic_color": "#00b692",
    "intergenic_color": "#96d0c9",
}


def _detect_track_type(path: str) -> Optional[str]:
    p = path.lower()
    # Check compound suffixes first
    for ext, ttype in sorted(TRACK_EXTENSION_MAP.items(), key=lambda x: -len(x[0])):
        if p.endswith(ext):
            return ttype
    return None


def _detect_long_read_bam(path: str) -> bool:
    """Heuristic: if BAM path contains 'long', 'ont', 'pacbio', 'isoseq', 'nanopore', treat as long-read."""
    lower = path.lower()
    return any(k in lower for k in ("long_read", "longreads", "ont", "pacbio", "isoseq", "nanopore", "minimap", "flair"))


def _output_dir_track_registry_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return _resolve_local_data_root(output_dir_text) / OUTPUT_DIR_TRACK_REGISTRY_FILENAME
    except Exception:
        return None


def _track_registry_store_paths_for_config(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    cfg = config or {}
    paths: List[Path] = []
    use_output_sidecar = str(TRACK_REGISTRY_FILE) == str(DEFAULT_TRACK_REGISTRY_FILE)
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    if sidecar:
        paths.append(sidecar)
    paths.append(TRACK_REGISTRY_FILE)

    out: List[Path] = []
    seen: Set[str] = set()
    for path in paths:
        try:
            resolved = str(path.expanduser().resolve())
        except Exception:
            resolved = str(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(path)
    return out


def _load_track_registry_from_path(path: Path) -> Optional[Dict[str, Any]]:
    if path.exists():
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                tracks = data.get("tracks")
                if isinstance(tracks, list):
                    return data
        except Exception:
            return None
    return None


def _load_track_registry(config: Optional[Dict[str, Any]] = None) -> Dict:
    cfg = config or load_config()
    empty_registry: Optional[Dict[str, Any]] = None
    for path in _track_registry_store_paths_for_config(cfg):
        registry = _load_track_registry_from_path(path)
        if not registry:
            continue
        if registry.get("tracks"):
            return registry
        if empty_registry is None:
            empty_registry = registry
    if empty_registry is not None:
        return empty_registry
    return {"tracks": []}


def _primary_track_registry_store_path(config: Optional[Dict[str, Any]] = None) -> Path:
    cfg = config or {}
    use_output_sidecar = str(TRACK_REGISTRY_FILE) == str(DEFAULT_TRACK_REGISTRY_FILE)
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    return sidecar or TRACK_REGISTRY_FILE


def _save_track_registry(registry: Dict, config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or load_config()
    path = _primary_track_registry_store_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass


def _ensure_track_registry_sidecar(config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or load_config()
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir"))
    if not sidecar:
        return
    registry = _load_track_registry(cfg)
    if not registry.get("tracks") and sidecar.exists():
        return
    try:
        _save_track_registry(registry, cfg)
    except Exception:
        pass


_track_registry_lock = threading.Lock()


# ═══════════════════════════════════════════════════════════════════════════════
#  User Notes — free-text annotations the user attaches to a feature
# ═══════════════════════════════════════════════════════════════════════════════
#
# Sibling of the track registry above, and deliberately built from the same
# parts: the same sidecar-first path resolution, the same tolerant load, the
# same mkstemp/os.replace write. Two divergences, both because a note is prose
# the user typed rather than a file path they can re-add — see _load_user_notes
# and _quarantine_unparseable_notes_store.
#
# The store is keyed by (kind, genome_key, id) rather than by gene, so notes on
# transcripts or regions need no migration when they arrive.

OUTPUT_DIR_USER_NOTES_FILENAME = "user_notes.json"
DEFAULT_USER_NOTES_FILE = CACHE_DIR / OUTPUT_DIR_USER_NOTES_FILENAME
USER_NOTES_FILE = DEFAULT_USER_NOTES_FILE
USER_NOTES_STORE_VERSION = 2
MAX_NOTE_TITLE_CHARS = 200
MAX_NOTE_BODY_CHARS = 200_000
MAX_NOTE_TAGS = 20
MAX_NOTE_TAG_CHARS = 50
TODO_STATUSES = {"backlog", "next", "in_progress", "waiting", "blocked", "completed", "abandoned"}
TODO_PRIORITIES = {"low", "medium", "high"}

_user_notes_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _new_note_id() -> str:
    return f"note_{uuid.uuid4().hex[:12]}"


def _normalize_note_genome_key(value: Any) -> str:
    """The lookup key is the assembly, not the dataset release.

    Gene stable ids survive an annotation release (ENSG… is the same gene in
    Ensembl 115 and 116), so keying notes by the full selection key would make
    every note vanish the moment the user updated their genome — the worst
    possible failure for text they wrote themselves.
    """
    return strip_dataset_release_from_selection_key(value)


def _normalize_note_target(raw: Any) -> Dict[str, str]:
    data = raw if isinstance(raw, dict) else {}
    kind = str(data.get("kind") or "gene").strip() or "gene"
    genome_key = _normalize_note_genome_key(data.get("genome_key"))
    target_id = str(data.get("id") or "").strip()
    if not target_id:
        raise HTTPException(status_code=400, detail="target.id is required")
    if not genome_key:
        raise HTTPException(status_code=400, detail="target.genome_key is required")
    return {
        "kind": kind,
        "genome_key": genome_key,
        "id": target_id,
        "label": str(data.get("label") or "").strip(),
        # Provenance only. Which release the note was written against can be
        # worth knowing later; it is never used to find the note again.
        "genome_selection_key": str(data.get("genome_selection_key") or "").strip(),
    }


def _normalize_todo_status(value: Any) -> str:
    token = str(value or "").strip().lower()
    return token if token in TODO_STATUSES else "backlog"


def _normalize_todo_priority(value: Any) -> str:
    token = str(value or "").strip().lower()
    if token == "normal":
        return "medium"
    if token == "urgent":
        return "high"
    return token if token in TODO_PRIORITIES else "medium"


def _normalize_todo_order(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _normalize_note_tags(value: Any, *, strict: bool = False) -> List[str]:
    """Trim and case-insensitively deduplicate a note's short tag phrases."""
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise HTTPException(status_code=400, detail="tags must be a list")
        return []

    tags: List[str] = []
    seen: Set[str] = set()
    for raw in value:
        source = raw if isinstance(raw, str) else str(raw or "")
        invalid = "," in source or any(ord(char) < 32 or ord(char) == 127 for char in source)
        token = " ".join(source.split()).strip()
        if invalid or not token:
            if strict:
                raise HTTPException(status_code=400, detail="tags cannot be empty or contain commas or control characters")
            continue
        if len(token) > MAX_NOTE_TAG_CHARS:
            if strict:
                raise HTTPException(
                    status_code=400,
                    detail=f"tags cannot exceed {MAX_NOTE_TAG_CHARS} characters",
                )
            token = token[:MAX_NOTE_TAG_CHARS].rstrip()
        key = token.lower()
        if key in seen:
            continue
        if len(tags) >= MAX_NOTE_TAGS:
            if strict:
                raise HTTPException(status_code=400, detail=f"a note can have at most {MAX_NOTE_TAGS} tags")
            break
        seen.add(key)
        tags.append(token)
    return tags


def _normalize_note_record(raw: Any) -> Optional[Dict[str, Any]]:
    """Coerce one stored record. Returns None for anything unusable."""
    if not isinstance(raw, dict):
        return None
    note_id = str(raw.get("id") or "").strip()
    if not note_id:
        return None
    target = raw.get("target")
    if not isinstance(target, dict):
        return None
    target_id = str(target.get("id") or "").strip()
    genome_key = _normalize_note_genome_key(target.get("genome_key"))
    if not target_id or not genome_key:
        return None
    created_at = str(raw.get("created_at") or "").strip() or _utc_now_iso()
    updated_at = str(raw.get("updated_at") or "").strip() or created_at
    status = _normalize_todo_status(raw.get("status"))
    completed = bool(raw.get("completed", False)) or status == "completed"
    if completed:
        status = "completed"
    tags = _normalize_note_tags(raw.get("tags"))
    return {
        "id": note_id,
        "target": {
            "kind": str(target.get("kind") or "gene").strip() or "gene",
            "genome_key": genome_key,
            "id": target_id,
            "label": str(target.get("label") or "").strip(),
            "genome_selection_key": str(target.get("genome_selection_key") or "").strip(),
        },
        "title": str(raw.get("title") or "")[:MAX_NOTE_TITLE_CHARS],
        "body": str(raw.get("body") or "")[:MAX_NOTE_BODY_CHARS],
        "tags": tags,
        "tags_updated_at": (str(raw.get("tags_updated_at") or "").strip() or updated_at) if tags else "",
        "created_at": created_at,
        "updated_at": updated_at,
        "archived": bool(raw.get("archived", False)),
        "archived_at": str(raw.get("archived_at") or "").strip() if bool(raw.get("archived", False)) else "",
        "status": status,
        "priority": _normalize_todo_priority(raw.get("priority")),
        "completed": completed,
        "completed_at": (str(raw.get("completed_at") or "").strip() or updated_at) if completed else "",
        "todo_order": _normalize_todo_order(raw.get("todo_order")),
    }


def _note_target_matches(note: Dict[str, Any], kind: str, genome_key: str, target_id: str) -> bool:
    target = note.get("target") or {}
    if kind and str(target.get("kind") or "") != kind:
        return False
    if genome_key and str(target.get("genome_key") or "") != _normalize_note_genome_key(genome_key):
        return False
    if target_id and str(target.get("id") or "") != target_id:
        return False
    return True


def _notes_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The configuration the notes store should be resolved against.

    Normally the user's own. While a tutorial is running it is that configuration with
    its output directory swapped for the tutorial's workspace, so a note taken during a
    tutorial is written into the scratch directory and swept away with it.

    This has to happen here rather than in the frontend's config override. The override
    is a frontend fact; every notes endpoint resolves its store from the configuration
    *on disk*, so without this a note taken during a tutorial lands in the user's real
    notes file and outlives the tutorial — the one thing the sandbox promises cannot
    happen. Same shape as ``_browsable_active_species``, and for the same reason.
    """
    cfg = dict(config or load_config())
    workspace = tutorial_session_workspace()
    if workspace:
        cfg["output_dir"] = workspace
    return cfg


def _output_dir_user_notes_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return _resolve_local_data_root(output_dir_text) / OUTPUT_DIR_USER_NOTES_FILENAME
    except Exception:
        return None


def _user_notes_store_paths_for_config(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    cfg = config or {}
    paths: List[Path] = []
    use_output_sidecar = str(USER_NOTES_FILE) == str(DEFAULT_USER_NOTES_FILE)
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    if sidecar:
        paths.append(sidecar)
    if sidecar and TUTORIAL_WORKSPACE_DIR in sidecar.parts:
        # A tutorial's notes are its own. Merging the global store in would show the
        # user's notes inside the tutorial, and — because a merged store is written back
        # out — could copy them into a scratch directory that is about to be deleted.
        return [sidecar]
    paths.append(USER_NOTES_FILE)

    out: List[Path] = []
    seen: Set[str] = set()
    for path in paths:
        try:
            resolved = str(path.expanduser().resolve())
        except Exception:
            resolved = str(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(path)
    return out


def _quarantine_unparseable_notes_store(path: Path) -> None:
    """Move a store we cannot read aside before anything overwrites it.

    The track registry just writes over a corrupt file — losing it costs the
    user a few clicks to re-add their tracks. Here the same bytes are the only
    copy of something they wrote, so they get renamed, not replaced.
    """
    try:
        if not path.exists() or path.stat().st_size == 0:
            return
        path.rename(path.with_name(f"{path.name}.corrupt-{int(time.time())}"))
    except Exception:
        pass


def _load_user_notes_from_path(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("notes"), list):
            return data
    except Exception:
        _quarantine_unparseable_notes_store(path)
        return None
    # Parsed, but not a store — same treatment as unparseable.
    _quarantine_unparseable_notes_store(path)
    return None


def _merge_user_note_lists(*note_lists: Any) -> List[Dict[str, Any]]:
    """Union by note id, keeping whichever copy was edited last."""
    merged: Dict[str, Dict[str, Any]] = {}
    for notes in note_lists:
        for raw in (notes or []):
            note = _normalize_note_record(raw)
            if not note:
                continue
            existing = merged.get(note["id"])
            if existing is None or note["updated_at"] >= existing["updated_at"]:
                merged[note["id"]] = note
    return sorted(merged.values(), key=lambda n: n["updated_at"], reverse=True)


def _load_user_notes(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge every store we can read rather than picking a winner.

    The track registry returns the first populated store it finds. Doing that
    here would hide every note written under a previous output_dir the moment
    the user repointed it. Notes are cheap to merge and expensive to lose.
    """
    cfg = config or load_config()
    collected: List[Any] = []
    for path in _user_notes_store_paths_for_config(cfg):
        store = _load_user_notes_from_path(path)
        if store:
            collected.append(store.get("notes"))
    return {"version": USER_NOTES_STORE_VERSION, "notes": _merge_user_note_lists(*collected)}


def _primary_user_notes_store_path(config: Optional[Dict[str, Any]] = None) -> Path:
    cfg = config or {}
    use_output_sidecar = str(USER_NOTES_FILE) == str(DEFAULT_USER_NOTES_FILE)
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    return sidecar or USER_NOTES_FILE


def _save_user_notes(store: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or load_config()
    path = _primary_user_notes_store_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass


def _save_user_notes_to_all_stores(
    store: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
) -> List[Path]:
    """Write the store to every file that currently holds notes.

    _save_user_notes writes only the primary path, which is right for an edit:
    _load_user_notes unions every store it can read, so an edit that lands in one
    of them still wins on the next load. It is wrong for a deletion. "Delete
    everything and replace" that only rewrites the primary leaves a second store
    untouched, and the union brings every deleted note straight back — so a
    destructive import writes everywhere or it has not happened at all.
    """
    cfg = config or load_config()
    written: List[Path] = []
    targets = [path for path in _user_notes_store_paths_for_config(cfg) if path.exists()]
    primary = _primary_user_notes_store_path(cfg)
    if not any(str(path) == str(primary) for path in targets):
        targets.append(primary)

    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(store, f, indent=2)
            os.replace(tmp_path, path)
            written.append(path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass
    return written


def _backup_user_notes_stores(config: Optional[Dict[str, Any]] = None) -> List[str]:
    """Copy every store aside before a destructive import.

    Same reasoning as _quarantine_unparseable_notes_store: these bytes are the
    only copy of something the user wrote, so nothing overwrites them without
    leaving a way back.
    """
    cfg = config or load_config()
    stamp = int(time.time())
    saved: List[str] = []
    for path in _user_notes_store_paths_for_config(cfg):
        try:
            if not path.exists() or path.stat().st_size == 0:
                continue
            backup = path.with_name(f"{path.name}.backup-{stamp}")
            shutil.copy2(path, backup)
            saved.append(str(backup))
        except Exception:
            continue
    return saved


def _ensure_user_notes_sidecar(config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or load_config()
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir"))
    if not sidecar:
        return
    store = _load_user_notes(cfg)
    if not store.get("notes") and sidecar.exists():
        return
    try:
        _save_user_notes(store, cfg)
    except Exception:
        pass


class NoteTargetModel(BaseModel):
    kind: str = "gene"
    genome_key: str = ""
    id: str = ""
    label: str = ""
    genome_selection_key: str = ""


class UserNoteModel(BaseModel):
    id: str
    target: NoteTargetModel
    title: str = ""
    body: str = ""
    tags: List[str] = []
    tags_updated_at: str = ""
    created_at: str
    updated_at: str
    archived: bool = False
    archived_at: str = ""
    status: str = "backlog"
    priority: str = "medium"
    completed: bool = False
    completed_at: str = ""
    todo_order: int = 0


class UserNoteCreateRequest(BaseModel):
    target: NoteTargetModel
    title: str = ""
    body: str = ""
    tags: List[str] = []
    status: str = "backlog"
    priority: str = "medium"
    completed: bool = False
    todo_order: int = 0


class UserNoteUpdateRequest(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    completed: Optional[bool] = None
    todo_order: Optional[int] = None
    # The updated_at the client last saw. Omit to force-write.
    updated_at: Optional[str] = None


class UserNoteArchiveRequest(BaseModel):
    archived: bool = True


class UserNoteBulkDeleteRequest(BaseModel):
    note_ids: List[str] = []


class UserNotesResponse(BaseModel):
    notes: List[UserNoteModel]


class UserNotesIndexEntry(BaseModel):
    kind: str
    genome_key: str
    target_id: str
    label: str = ""
    count: int
    updated_at: str


class UserNotesIndexResponse(BaseModel):
    entries: List[UserNotesIndexEntry]


@app.get("/api/notes", response_model=UserNotesResponse)
async def list_user_notes(kind: str = "", genome_key: str = "", target_id: str = ""):
    """Notes, most recently edited first. Every filter is optional and narrowing."""
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        _ensure_user_notes_sidecar(config)
        notes = [
            note for note in store.get("notes", [])
            if _note_target_matches(note, kind.strip(), genome_key.strip(), target_id.strip())
        ]
        return {"notes": notes}

    return await run_in_threadpool(_run)


@app.get("/api/notes/index", response_model=UserNotesIndexResponse)
async def user_notes_index(kind: str = "gene", genome_key: str = ""):
    """One row per annotated feature: how many notes it has, and when it last changed.

    This is all the genome browser canvas needs to decide where to draw a note
    bubble. Pulling the notes themselves would ship every body the user has ever
    written just to place a 14px mark.
    """
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        grouped: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        for note in store.get("notes", []):
            # Archived notes remain browseable in the Notes view, but do not
            # advertise themselves as active annotations in the genome canvas.
            if bool(note.get("archived", False)):
                continue
            if not _note_target_matches(note, kind.strip(), genome_key.strip(), ""):
                continue
            target = note.get("target") or {}
            key = (
                str(target.get("kind") or ""),
                str(target.get("genome_key") or ""),
                str(target.get("id") or ""),
            )
            entry = grouped.get(key)
            if entry is None:
                grouped[key] = {
                    "kind": key[0],
                    "genome_key": key[1],
                    "target_id": key[2],
                    "label": str(target.get("label") or ""),
                    "count": 1,
                    "updated_at": note.get("updated_at") or "",
                }
                continue
            entry["count"] += 1
            if (note.get("updated_at") or "") > entry["updated_at"]:
                entry["updated_at"] = note.get("updated_at") or ""
                # The freshest note carries the most current symbol for the feature.
                entry["label"] = str(target.get("label") or "") or entry["label"]
        entries = sorted(grouped.values(), key=lambda e: e["updated_at"], reverse=True)
        return {"entries": entries}

    return await run_in_threadpool(_run)


@app.post("/api/notes", response_model=UserNoteModel)
async def create_user_note(request: UserNoteCreateRequest):
    """Create a note. Ids are minted here so a client bug cannot choose one."""
    target = _normalize_note_target(request.target.model_dump())
    title = str(request.title or "")[:MAX_NOTE_TITLE_CHARS]
    tags = _normalize_note_tags(request.tags, strict=True)
    if target["kind"] == "todo" and not title.strip():
        raise HTTPException(status_code=400, detail="A todo title is required")

    def _run():
        config = _notes_config()
        now = _utc_now_iso()
        status = _normalize_todo_status(request.status)
        completed = bool(request.completed) or status == "completed"
        if completed:
            status = "completed"
        note = {
            "id": _new_note_id(),
            "target": target,
            "title": title,
            "body": str(request.body or "")[:MAX_NOTE_BODY_CHARS],
            "tags": tags,
            "tags_updated_at": now if tags else "",
            "created_at": now,
            "updated_at": now,
            "archived": False,
            "archived_at": "",
            "status": status,
            "priority": _normalize_todo_priority(request.priority),
            "completed": completed,
            "completed_at": now if completed else "",
            "todo_order": int(request.todo_order or 0),
        }
        with _user_notes_lock:
            store = _load_user_notes(config)
            store["notes"] = [note] + list(store.get("notes", []))
            _save_user_notes(store, config)
        return note

    return await run_in_threadpool(_run)


@app.put("/api/notes/{note_id}/archive", response_model=UserNoteModel)
async def set_user_note_archived(note_id: str, request: UserNoteArchiveRequest):
    """Move a note into or out of the archive without changing its text."""
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
            if idx is None:
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            updated = dict(notes[idx])
            now = _utc_now_iso()
            updated["archived"] = bool(request.archived)
            updated["archived_at"] = now if request.archived else ""
            # Archive state participates in cross-store merge ordering and in
            # the client's compare-and-swap token just like any other edit.
            updated["updated_at"] = now
            notes[idx] = updated
            store["notes"] = notes
            _save_user_notes(store, config)
        return updated

    return await run_in_threadpool(_run)


@app.post("/api/notes/bulk-delete")
async def bulk_delete_user_notes(request: UserNoteBulkDeleteRequest):
    """Permanently delete an explicit set of note ids in one atomic write."""
    requested = list(dict.fromkeys(str(note_id or "").strip() for note_id in request.note_ids))
    requested = [note_id for note_id in requested if note_id]

    def _run():
        config = _notes_config()
        wanted = set(requested)
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            deleted = [note["id"] for note in notes if note.get("id") in wanted]
            if deleted:
                store["notes"] = [note for note in notes if note.get("id") not in wanted]
                _save_user_notes(store, config)
        return {"deleted": deleted, "count": len(deleted)}

    return await run_in_threadpool(_run)


@app.put("/api/notes/{note_id}", response_model=UserNoteModel)
async def update_user_note(note_id: str, request: UserNoteUpdateRequest):
    """Update a note's title or body.

    `updated_at` is a compare-and-swap against what the client last saw. It is
    what stops one window's autosave from silently overwriting an edit made in
    another — or in the file itself.
    """
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
            if idx is None:
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            current = notes[idx]
            expected = (request.updated_at or "").strip()
            if expected and expected != current.get("updated_at"):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "This note changed somewhere else since you loaded it.",
                        "note": current,
                    },
                )
            updated = dict(current)
            if request.title is not None:
                next_title = str(request.title)[:MAX_NOTE_TITLE_CHARS]
                if str((current.get("target") or {}).get("kind") or "") == "todo" and not next_title.strip():
                    raise HTTPException(status_code=400, detail="A todo title is required")
                updated["title"] = next_title
            if request.body is not None:
                updated["body"] = str(request.body)[:MAX_NOTE_BODY_CHARS]
            if request.tags is not None:
                tags = _normalize_note_tags(request.tags, strict=True)
                if tags != list(current.get("tags") or []):
                    updated["tags"] = tags
                    updated["tags_updated_at"] = _utc_now_iso()
            if request.status is not None:
                status = _normalize_todo_status(request.status)
                completed = status == "completed"
                updated["status"] = status
                updated["completed"] = completed
                updated["completed_at"] = _utc_now_iso() if completed else ""
            if request.priority is not None:
                updated["priority"] = _normalize_todo_priority(request.priority)
            if request.completed is not None:
                completed = bool(request.completed)
                updated["completed"] = completed
                updated["completed_at"] = _utc_now_iso() if completed else ""
                if completed:
                    updated["status"] = "completed"
                elif updated.get("status") == "completed":
                    updated["status"] = "in_progress"
            if request.todo_order is not None:
                updated["todo_order"] = int(request.todo_order)
            updated["updated_at"] = _utc_now_iso()
            notes[idx] = updated
            store["notes"] = notes
            _save_user_notes(store, config)
        return updated

    return await run_in_threadpool(_run)


@app.delete("/api/notes/{note_id}")
async def delete_user_note(note_id: str):
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            remaining = [n for n in notes if n.get("id") != note_id]
            if len(remaining) == len(notes):
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            store["notes"] = remaining
            _save_user_notes(store, config)
        return {"deleted": note_id}

    return await run_in_threadpool(_run)



# ═══════════════════════════════════════════════════════════════════════════════
#  Notes Transfer — export a selection, and import one back
# ═══════════════════════════════════════════════════════════════════════════════
#
# Notes are the one thing in this app the user cannot recreate: a genome can be
# re-downloaded and an annotation re-derived, but prose someone typed is gone.
# So the shape of this is deliberately cautious — an import is always scanned
# before it is applied, the destructive strategy takes a backup first, and the
# merge is recomputed at apply time rather than trusted from the scan.
#
# The serialising and the merge arithmetic live in notes_transfer, which imports
# nothing from here. Everything it produces is still run through
# _normalize_note_record before it is saved, so validation has one home.

MAX_EXPORT_NOTE_IDS = 50_000

# Todos first, then general notes, then genes — so a spreadsheet reads in the
# same order the Notes view does.
_NOTE_KIND_RANK = {"todo": 0, "genome": 1, "gene": 2}


class NotesExportRequest(BaseModel):
    directory: str
    filename: str
    format: str = "json"
    note_ids: List[str] = []
    # "create" refuses to touch an existing file so the UI can offer a choice,
    # matching the genome-config export.
    mode: str = "create"


class NotesImportScanRequest(BaseModel):
    path: str


class NotesImportApplyRequest(BaseModel):
    path: str
    # The file digest the scan reported. Apply refuses if the file moved since.
    digest: str = ""
    # The store digest the scan reported. Apply proceeds either way — autosave
    # fires every 600ms, so refusing would be maddening — but says whether the
    # notes moved under the user while they were reading the scan.
    store_digest: str = ""
    strategy: str = "newer_wins"


def _note_export_sort_key(note: Dict[str, Any]) -> Tuple[int, str, str, str]:
    target = note.get("target") or {}
    kind = str(target.get("kind") or "gene")
    return (
        _NOTE_KIND_RANK.get(kind, 3),
        str(target.get("genome_key") or ""),
        str(target.get("id") or ""),
        str(note.get("updated_at") or ""),
    )


def _read_transfer_file(path_value: str) -> Tuple[Path, bytes, str]:
    """Resolve, size-check and decode a file the user picked."""
    resolved = _resolve_user_file(path_value, "Notes")
    size = resolved.stat().st_size
    if size > notes_transfer.MAX_TRANSFER_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"That file is {size} bytes; the limit is {notes_transfer.MAX_TRANSFER_FILE_BYTES}.",
        )
    data = resolved.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"That file is not UTF-8 text, so it cannot be read as notes: {exc}",
        )
    return resolved, data, text


def _parse_transfer_file(path_value: str) -> Tuple[Path, bytes, Dict[str, Any], str]:
    resolved, data, text = _read_transfer_file(path_value)
    fmt = notes_transfer.sniff_transfer_format(resolved.name, text[:4096])
    parsed = notes_transfer.parse_transfer_text(text, fmt=fmt)
    return resolved, data, parsed, fmt


@app.post("/api/notes/export")
async def export_user_notes(payload: NotesExportRequest):
    directory_raw = str(payload.directory or "").strip()
    filename = str(payload.filename or "").strip()
    fmt = str(payload.format or "").strip().lower()
    mode = str(payload.mode or "create").strip().lower()
    note_ids = [str(note_id or "").strip() for note_id in (payload.note_ids or [])]
    note_ids = [note_id for note_id in note_ids if note_id]

    # Checked before safe_export_filename: its unknown-format fallback appends
    # ".{format}" verbatim, which is how ".json" works without a table entry —
    # and also how "exe" would sneak through if nothing validated first.
    if fmt not in notes_transfer.TRANSFER_FORMATS:
        raise HTTPException(
            status_code=400,
            detail="format must be one of: " + ", ".join(notes_transfer.TRANSFER_FORMATS),
        )
    if not directory_raw:
        raise HTTPException(status_code=400, detail="directory must not be empty")
    if not filename:
        raise HTTPException(status_code=400, detail="filename must not be empty")
    if not note_ids:
        raise HTTPException(status_code=400, detail="Select at least one note to export")
    if len(note_ids) > MAX_EXPORT_NOTE_IDS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many notes in one export; the limit is {MAX_EXPORT_NOTE_IDS}",
        )
    if mode not in {"create", "overwrite"}:
        raise HTTPException(status_code=400, detail="mode must be create or overwrite")

    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            by_id = {str(note.get("id")): note for note in store.get("notes", [])}

        wanted = list(dict.fromkeys(note_ids))
        selected = [by_id[note_id] for note_id in wanted if note_id in by_id]
        missing = [note_id for note_id in wanted if note_id not in by_id]
        if not selected:
            raise HTTPException(status_code=404, detail="None of those notes are in the store")
        selected.sort(key=_note_export_sort_key)

        directory = Path(directory_raw).expanduser().resolve()
        safe_filename = safe_export_filename(filename, fmt)
        out_path = directory / safe_filename
        if mode == "create" and out_path.exists():
            raise HTTPException(status_code=409, detail=f"{safe_filename} already exists.")

        text = notes_transfer.serialise_notes(selected, fmt=fmt)
        directory.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
            os.replace(tmp_path, out_path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass

        return {
            "ok": True,
            "path": str(out_path),
            "filename": safe_filename,
            "format": fmt,
            "count": len(selected),
            "missing_ids": missing,
        }

    return await run_in_threadpool(_run)


@app.post("/api/notes/import/scan")
async def scan_user_notes_import(payload: NotesImportScanRequest):
    """Read a file and say what is in it, without changing anything.

    The statuses here are a preview, not a decision. Autosave can move the store
    while the user reads this, so apply recomputes the whole merge from a fresh
    load — see apply_user_notes_import.
    """

    def _run():
        resolved, data, parsed, fmt = _parse_transfer_file(payload.path)

        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        existing = list(store.get("notes", []))
        existing_by_id = {str(note.get("id")): note for note in existing}

        rows: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []
        summary = {
            "new": 0, "identical": 0, "differs": 0, "invalid": 0,
            "todos": 0, "notes": 0, "archived": 0,
        }

        for row in parsed.get("rows", []):
            note = row.get("note")
            errors = list(row.get("errors") or [])
            warnings = list(row.get("warnings") or [])

            if note is not None:
                # The same gate the create endpoint uses, so nothing can be
                # accepted here that the store would then reject.
                normalized = _normalize_note_record({**note, "id": note.get("id") or "pending"})
                if normalized is None:
                    note = None
                    errors.append("this row cannot be stored as a note")

            if note is None:
                summary["invalid"] += 1
                rows.append({
                    "line": row.get("line"),
                    "id": "",
                    "kind": "",
                    "genome_key": "",
                    "target_id": "",
                    "target_label": "",
                    "title": "",
                    "preview": "",
                    "tags": [],
                    "archived": False,
                    "updated_at": "",
                    "status": "invalid",
                    "errors": errors,
                    "warnings": warnings,
                })
                continue

            candidates.append(note)
            target = note.get("target") or {}
            kind = str(target.get("kind") or "gene")
            if kind == "todo":
                summary["todos"] += 1
            else:
                summary["notes"] += 1
            if note.get("archived"):
                summary["archived"] += 1
            body = str(note.get("body") or "")
            rows.append({
                "line": row.get("line"),
                "id": str(note.get("id") or ""),
                "kind": kind,
                "genome_key": str(target.get("genome_key") or ""),
                "target_id": str(target.get("id") or ""),
                "target_label": str(target.get("label") or ""),
                "title": str(note.get("title") or ""),
                "preview": body[:200],
                "tags": list(note.get("tags") or []),
                "archived": bool(note.get("archived")),
                "updated_at": str(note.get("updated_at") or ""),
                "status": "new",
                "errors": errors,
                "warnings": warnings,
            })

        diffs = notes_transfer.diff_against_store(candidates, existing_by_id)
        diff_iter = iter(diffs)
        for row in rows:
            if row["status"] == "invalid":
                continue
            diff = next(diff_iter)
            row["status"] = diff["status"]
            row["warnings"] = list(row["warnings"]) + list(diff["warnings"])
            summary[diff["status"]] += 1

        return {
            "format": fmt,
            "path": str(resolved),
            "filename": resolved.name,
            "bytes": len(data),
            "digest": notes_transfer.file_digest(data),
            "store_digest": notes_transfer.store_digest(existing),
            "schema_version": notes_transfer.TRANSFER_SCHEMA_VERSION,
            "total": len(rows),
            "applicable": len(candidates),
            "stored_total": len(existing),
            "rows": rows,
            "summary": summary,
            "near_duplicates": notes_transfer.find_near_duplicates(candidates, existing),
            "document_errors": list(parsed.get("document_errors") or []),
            "document_warnings": list(parsed.get("document_warnings") or []),
        }

    return await run_in_threadpool(_run)


@app.post("/api/notes/import/apply")
async def apply_user_notes_import(payload: NotesImportApplyRequest):
    strategy = str(payload.strategy or "").strip().lower()
    if strategy not in notes_transfer.MERGE_STRATEGIES:
        raise HTTPException(
            status_code=400,
            detail="strategy must be one of: " + ", ".join(notes_transfer.MERGE_STRATEGIES),
        )
    expected_digest = str(payload.digest or "").strip()
    scanned_store_digest = str(payload.store_digest or "").strip()

    def _run():
        # Parsing happens outside the lock: it can be slow, and it needs nothing
        # from the store.
        resolved, data, parsed, fmt = _parse_transfer_file(payload.path)

        if expected_digest and notes_transfer.file_digest(data) != expected_digest:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "file_changed",
                    "message": "That file changed after it was scanned. Scan it again before importing.",
                },
            )
        if parsed.get("document_errors"):
            raise HTTPException(status_code=400, detail="; ".join(parsed["document_errors"]))

        incoming: List[Dict[str, Any]] = []
        for note in notes_transfer.valid_notes(parsed):
            normalized = _normalize_note_record({
                **note,
                "id": str(note.get("id") or "").strip() or _new_note_id(),
            })
            if normalized is None:
                continue
            if normalized["target"]["kind"] == "todo" and not normalized["title"].strip():
                continue
            if not str(note.get("id") or "").strip():
                # Keep it blank so the merge mints an id under its own rules.
                normalized["id"] = ""
            incoming.append(normalized)

        if not incoming:
            raise HTTPException(status_code=400, detail="That file has no notes that can be imported")

        destructive = strategy == "replace_all"
        now = _utc_now_iso()
        config = _notes_config()

        with _user_notes_lock:
            store = _load_user_notes(config)
            existing = list(store.get("notes", []))
            before_digest = notes_transfer.store_digest(existing)

            merged, counts = notes_transfer.apply_merge(
                existing,
                incoming,
                strategy,
                now=now,
                mint_id=_new_note_id,
            )
            final = [
                record for record in (_normalize_note_record(note) for note in merged)
                if record is not None
            ]

            backup_paths: List[str] = []
            if destructive:
                backup_paths = _backup_user_notes_stores(config)

            store["version"] = USER_NOTES_STORE_VERSION
            store["notes"] = sorted(final, key=lambda n: n["updated_at"], reverse=True)

            if destructive:
                # Every store, or the union on the next load undoes the deletion.
                _save_user_notes_to_all_stores(store, config)
            else:
                _save_user_notes(store, config)

        return {
            "ok": True,
            "strategy": strategy,
            "format": fmt,
            "path": str(resolved),
            "total": len(incoming),
            "stored_total": len(store["notes"]),
            "backup_paths": backup_paths,
            "store_changed": bool(scanned_store_digest) and scanned_store_digest != before_digest,
            **counts,
        }

    return await run_in_threadpool(_run)


DEFAULT_SPLICE_SETTINGS: Dict[str, Any] = {
    "min_support": 1,
    "canonical_mode": "all",     # all | canonical | non_canonical
    "annotated_mode": "all",     # all | annotated | novel
    "show_arrows": True,
    "max_junctions": 5000,
    "weak_max_support": 2,
    "low_max_support": 4,
    "medium_max_support": 9,
}

_CANONICAL_SPLICE_MODES = {"all", "canonical", "non_canonical"}
_ANNOTATED_SPLICE_MODES = {"all", "annotated", "novel"}
_CANONICAL_SPLICE_MOTIFS = {
    "GT/AG", "CT/AC",
    "GC/AG", "CT/GC",
    "AT/AC", "GT/AT",
    "GT-AG", "CT-AC",
    "GC-AG", "CT-GC",
    "AT-AC", "GT-AT",
}


def _to_int_or_default(value: Any, default: int, minimum: Optional[int] = None, maximum: Optional[int] = None) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _to_bool_or_default(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _normalize_hex_color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    if _HEX_COLOR_RE.match(text):
        return text.lower()
    return str(fallback).strip().lower()


def _normalize_bigwig_data_type(value: Any, default: str = "rna_seq") -> str:
    token = str(value or "").strip().lower()
    return token if token in _BIGWIG_DATA_TYPES else default


def _normalize_bigwig_display_mode(mode: Any, data_type: str = "rna_seq") -> str:
    token = str(mode or "").strip().lower()
    if token in {"line_plot", "bar_chart"}:
        token = "signal_plot"
    if token in {"zoned_heatmap", "signal_plot"}:
        return token
    normalized_type = _normalize_bigwig_data_type(data_type, "rna_seq")
    return str(BIGWIG_DATA_TYPE_DEFAULTS[normalized_type]["display_mode"])


def _normalize_bigwig_zoned_colors(raw: Any, fallback: List[str]) -> List[str]:
    base = list(fallback) if isinstance(fallback, list) and len(fallback) >= 4 else list(BIGWIG_DATA_TYPE_DEFAULTS["rna_seq"]["zoned_colors"])
    if not isinstance(raw, list):
        return [str(c).lower() for c in base[:4]]
    out: List[str] = []
    for i in range(4):
        fallback_color = str(base[i] if i < len(base) else base[-1]).lower()
        value = raw[i] if i < len(raw) else fallback_color
        out.append(_normalize_hex_color(value, fallback_color))
    return out


def _normalize_bigwig_settings(raw: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prev_data_type = _normalize_bigwig_data_type((previous or {}).get("data_type"), "rna_seq")
    prev_defaults = BIGWIG_DATA_TYPE_DEFAULTS[prev_data_type]
    prev_plot = _normalize_hex_color((previous or {}).get("plot_color"), prev_defaults["plot_color"])
    prev_zones = _normalize_bigwig_zoned_colors((previous or {}).get("zoned_colors"), list(prev_defaults["zoned_colors"]))
    prev_use_plot_default = _to_bool_or_default((previous or {}).get("use_default_plot_color"), True)
    prev_use_zoned_defaults = _to_bool_or_default((previous or {}).get("use_default_zoned_colors"), True)

    settings = raw if isinstance(raw, dict) else {}
    data_type = _normalize_bigwig_data_type(settings.get("data_type"), prev_data_type)
    defaults = BIGWIG_DATA_TYPE_DEFAULTS[data_type]

    use_default_plot_color = _to_bool_or_default(settings.get("use_default_plot_color"), prev_use_plot_default)
    use_default_zoned_colors = _to_bool_or_default(settings.get("use_default_zoned_colors"), prev_use_zoned_defaults)

    if use_default_plot_color:
        plot_color = str(defaults["plot_color"]).lower()
    else:
        plot_color = _normalize_hex_color(settings.get("plot_color"), prev_plot)

    if use_default_zoned_colors:
        zoned_colors = [str(c).lower() for c in defaults["zoned_colors"]]
    else:
        zoned_colors = _normalize_bigwig_zoned_colors(settings.get("zoned_colors"), prev_zones)

    return {
        "data_type": data_type,
        "plot_color": plot_color,
        "zoned_colors": zoned_colors,
        "use_default_plot_color": use_default_plot_color,
        "use_default_zoned_colors": use_default_zoned_colors,
    }


def _normalize_vcf_display_mode(mode: Any) -> str:
    token = str(mode or "").strip().lower()
    if token in {"block_lollipop", "block-lollipop"}:
        token = "adaptive"
    if token in {"ensembl", "lollipop", "density"}:
        token = "density_lollipop"
    return token if token in VCF_DISPLAY_MODES else "density_lollipop"


def _normalize_vcf_settings(raw: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    prev = previous if isinstance(previous, dict) else {}
    base = {
        "genic_color": _normalize_hex_color(prev.get("genic_color"), VCF_SETTINGS_DEFAULTS["genic_color"]),
        "intergenic_color": _normalize_hex_color(prev.get("intergenic_color"), VCF_SETTINGS_DEFAULTS["intergenic_color"]),
    }
    source = raw if isinstance(raw, dict) else {}
    return {
        "genic_color": _normalize_hex_color(source.get("genic_color"), base["genic_color"]),
        "intergenic_color": _normalize_hex_color(source.get("intergenic_color"), base["intergenic_color"]),
    }


def _normalize_splice_settings(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    settings = dict(DEFAULT_SPLICE_SETTINGS)
    if isinstance(raw, dict):
        settings.update(raw)

    canonical_mode = str(settings.get("canonical_mode", "all")).strip().lower()
    if canonical_mode not in _CANONICAL_SPLICE_MODES:
        canonical_mode = "all"

    annotated_mode = str(settings.get("annotated_mode", "all")).strip().lower()
    if annotated_mode not in _ANNOTATED_SPLICE_MODES:
        annotated_mode = "all"

    min_support = _to_int_or_default(settings.get("min_support"), 1, minimum=1, maximum=1_000_000)
    weak_max_support = _to_int_or_default(
        settings.get("weak_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["weak_max_support"]),
        minimum=min_support,
        maximum=1_000_000,
    )
    low_max_support = _to_int_or_default(
        settings.get("low_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["low_max_support"]),
        minimum=weak_max_support + 1,
        maximum=1_000_000,
    )
    medium_max_support = _to_int_or_default(
        settings.get("medium_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["medium_max_support"]),
        minimum=low_max_support + 1,
        maximum=1_000_000,
    )

    return {
        "min_support": min_support,
        "canonical_mode": canonical_mode,
        "annotated_mode": annotated_mode,
        "show_arrows": _to_bool_or_default(settings.get("show_arrows"), True),
        "max_junctions": _to_int_or_default(settings.get("max_junctions"), 5000, minimum=100, maximum=100_000),
        "weak_max_support": weak_max_support,
        "low_max_support": low_max_support,
        "medium_max_support": medium_max_support,
    }


def _hydrate_track_defaults(track: Dict[str, Any]) -> Dict[str, Any]:
    hydrated = dict(track)
    track_type = hydrated.get("type")
    source_token = str(hydrated.get("source") or "").strip().lower()
    if source_token:
        hydrated["source"] = source_token
    if source_token == "trackhub":
        hydrated["source_meta"] = _normalize_trackhub_source_meta(hydrated.get("source_meta")) or {}
    elif "source_meta" in hydrated and hydrated.get("source_meta") is None:
        hydrated["source_meta"] = None
    if track_type == "bigwig":
        bigwig_settings = _normalize_bigwig_settings(hydrated.get("bigwig_settings"))
        hydrated["bigwig_settings"] = bigwig_settings
        hydrated["display_mode"] = _normalize_bigwig_display_mode(hydrated.get("display_mode"), bigwig_settings["data_type"])
    if track_type == "vcf":
        had_vcf_settings = isinstance(hydrated.get("vcf_settings"), dict)
        hydrated["vcf_settings"] = _normalize_vcf_settings(hydrated.get("vcf_settings"))
        # Auto-migrate legacy VCF tracks without vcf_settings to Density-Lollipop.
        if not had_vcf_settings:
            hydrated["display_mode"] = "density_lollipop"
        else:
            hydrated["display_mode"] = _normalize_vcf_display_mode(hydrated.get("display_mode"))
    if track_type == "splice_junctions":
        hydrated["splice_settings"] = _normalize_splice_settings(hydrated.get("splice_settings"))
        hydrated["display_mode"] = "arcs"
    return hydrated


def _hydrate_track_genome_label(track: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    hydrated = dict(track)
    genome_key = str(hydrated.get("genome_key") or "").strip()
    if not genome_key:
        return hydrated
    metadata = _genome_key_display_metadata(genome_key, config)
    if metadata:
        hydrated["genome_label"] = metadata.get("label", "")
        hydrated["genome_species_label"] = metadata.get("species_label", "")
        hydrated["display_name"] = metadata.get("display_name", "")
        hydrated["display_name_reason"] = metadata.get("display_name_reason", "")
        hydrated["genome_assembly_name"] = metadata.get("assembly_name", "")
        hydrated["genome_assembly_accession"] = metadata.get("assembly", "")
    return hydrated


def _get_registered_track(track_id: str) -> Optional[Dict[str, Any]]:
    if not track_id:
        return None
    try:
        registry = _load_track_registry()
        for track in registry.get("tracks", []):
            if str(track.get("id")) == str(track_id):
                return _hydrate_track_defaults(track)
    except Exception:
        return None
    return None


def _is_canonical_splice_motif(motif: str) -> bool:
    token = str(motif or "").strip().upper()
    return token in _CANONICAL_SPLICE_MOTIFS


TRACKHUB_IMPORT_TASK_TTL_SECONDS = 60 * 60 * 24
_trackhub_import_tasks_guard = threading.Lock()
_trackhub_import_tasks: Dict[str, Dict[str, Any]] = {}


def _prune_trackhub_import_tasks() -> None:
    now_ts = time.time()
    with _trackhub_import_tasks_guard:
        stale_ids = []
        for task_id, task in _trackhub_import_tasks.items():
            status = str(task.get("status") or "")
            updated_at = float(task.get("_updated_ts") or now_ts)
            if status in {"completed", "failed"} and (now_ts - updated_at) > TRACKHUB_IMPORT_TASK_TTL_SECONDS:
                stale_ids.append(task_id)
        for task_id in stale_ids:
            _trackhub_import_tasks.pop(task_id, None)


def _read_trackhub_import_tasks() -> List[Dict[str, Any]]:
    _prune_trackhub_import_tasks()
    with _trackhub_import_tasks_guard:
        out = []
        for task in _trackhub_import_tasks.values():
            payload = {k: v for k, v in task.items() if not k.startswith("_")}
            out.append(json.loads(json.dumps(payload)))
    out.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
    return out


def _set_trackhub_import_task(task_id: str, **changes: Any) -> None:
    with _trackhub_import_tasks_guard:
        task = _trackhub_import_tasks.get(task_id)
        if task is None:
            return
        task.update(changes)
        task["updated_at"] = now_iso()
        task["_updated_ts"] = time.time()


def _compute_trackhub_import_key(hub_id: Any, track_id: Any, assembly: Any, data_url: Any) -> str:
    payload = "|".join(
        [
            str(hub_id or "").strip(),
            str(track_id or "").strip(),
            str(assembly or "").strip(),
            str(data_url or "").strip(),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _normalize_trackhub_format(format_value: Any, data_url: str = "") -> Tuple[str, str]:
    token = str(format_value or "").strip().lower().replace("_", "").replace("-", "").replace(".", "")
    if token in {"bigwig", "bigwigfile"}:
        return "bigWig", "bigwig"
    if token in {"bigbed", "bigbedfile"}:
        return "bigBed", "bigbed"

    lower_url = str(data_url or "").strip().lower()
    if lower_url.endswith(".bw") or lower_url.endswith(".bigwig"):
        return "bigWig", "bigwig"
    if lower_url.endswith(".bb") or lower_url.endswith(".bigbed"):
        return "bigBed", "bigbed"
    return "", ""


def _normalize_trackhub_source_meta(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    hub_id = str(raw.get("hub_id") or "").strip()
    track_id = str(raw.get("track_id") or "").strip()
    assembly = str(raw.get("assembly") or "").strip()
    data_url = _normalize_trackhub_data_url(str(raw.get("data_url") or "").strip())
    format_name, _ = _normalize_trackhub_format(raw.get("format"), data_url)
    raw_import_key = str(raw.get("import_key") or "").strip()
    import_key = raw_import_key
    if not import_key and (hub_id or track_id or assembly or data_url):
        import_key = _compute_trackhub_import_key(hub_id, track_id, assembly, data_url)
    return {
        "hub_id": hub_id,
        "hub_name": str(raw.get("hub_name") or "").strip(),
        "track_id": track_id,
        "track_name": str(raw.get("track_name") or "").strip(),
        "assembly": assembly,
        "format": format_name or str(raw.get("format") or "").strip(),
        "data_url": data_url,
        "description": str(raw.get("description") or "").strip(),
        "import_key": import_key,
    }


def _normalize_trackhub_data_url(url: str) -> str:
    return normalize_trackhub_data_url(url)


def _validate_trackhub_data_url(url: str) -> str:
    return validate_trackhub_data_url(url)


def _trackhub_output_filename(source_meta: Dict[str, Any], data_url: str, track_type: str) -> str:
    parsed = urlparse(data_url)
    basename = safe_url_basename(parsed.path or "")
    if basename:
        stem = Path(basename).stem
        ext = Path(basename).suffix
    else:
        stem = ""
        ext = ""

    if track_type == "bigwig":
        wanted_ext = ".bw"
    elif track_type == "bigbed":
        wanted_ext = ".bb"
    else:
        wanted_ext = ".dat"

    if not stem:
        stem = str(source_meta.get("track_name") or source_meta.get("track_id") or "trackhub_track").strip()
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    if not safe_stem:
        safe_stem = "trackhub_track"

    if ext.lower() not in {".bw", ".bigwig", ".bb", ".bigbed"}:
        ext = wanted_ext
    return f"{safe_stem}{ext}"


def _trackhub_download_sync(task_id: str, url: str, destination: Path) -> None:
    temp_file = destination.with_suffix(destination.suffix + ".tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_progress_emit = 0.0
    max_bytes = 2 * 1024 * 1024 * 1024
    try:
        _set_trackhub_import_task(task_id, status="downloading", progress=0.0, error="")
        with get_with_validated_redirects(
            url, validate_trackhub_data_url, stream=True, timeout=90
        ) as response:
            response.raise_for_status()
            total_size = int(response.headers.get("content-length", 0))
            if total_size > max_bytes:
                raise RuntimeError("Track Hub file is larger than the 2 GB import limit")
            downloaded = 0
            with open(temp_file, "wb") as fh:
                for chunk in response.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise RuntimeError("Track Hub file exceeded the 2 GB import limit")
                    if total_size > 0:
                        progress = min(0.99, downloaded / total_size)
                        if (progress - last_progress_emit) >= 0.01:
                            last_progress_emit = progress
                            _set_trackhub_import_task(task_id, progress=progress)

        if destination.suffix.lower() in {".gz", ".bw", ".bb", ".bigwig", ".bigbed"}:
            if temp_file.stat().st_size <= 0:
                raise RuntimeError("Downloaded file is empty")

        temp_file.replace(destination)
        _set_trackhub_import_task(task_id, progress=1.0)
    except Exception:
        if temp_file.exists():
            temp_file.unlink()
        raise


def _find_existing_trackhub_track(genome_key: str, source_meta: Dict[str, Any], destination: Path) -> Optional[Dict[str, Any]]:
    data_url = str(source_meta.get("data_url") or "").strip()
    import_key = str(source_meta.get("import_key") or "").strip()
    dest_resolved = str(destination.resolve())
    registry = _load_track_registry()
    for track in registry.get("tracks", []):
        if str(track.get("genome_key") or "") != str(genome_key or ""):
            continue
        source = str(track.get("source") or "").strip().lower()
        if source == "trackhub":
            existing_meta = _normalize_trackhub_source_meta(track.get("source_meta"))
            if existing_meta:
                if import_key and str(existing_meta.get("import_key") or "").strip() == import_key:
                    return _hydrate_track_defaults(track)
                if data_url and str(existing_meta.get("data_url") or "").strip() == data_url:
                    return _hydrate_track_defaults(track)
        try:
            if str(Path(track.get("path") or "").expanduser().resolve()) == dest_resolved:
                return _hydrate_track_defaults(track)
        except Exception:
            continue
    return None


class TrackHubGenomeRequest(BaseModel):
    genome_key: str
    species_key: str = ""
    scientific_name: str = ""
    common_name: str = ""
    assembly: str = ""
    assembly_name: str = ""


class TrackHubDiscoverRequest(BaseModel):
    genomes: List[TrackHubGenomeRequest]
    refresh: bool = False


class TrackHubImportItem(BaseModel):
    genome_key: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    label: Optional[str] = None
    source_meta: Dict[str, Any]


class TrackHubImportRequest(BaseModel):
    output_dir: str
    items: List[TrackHubImportItem]


class TrackRegistryEntry(BaseModel):
    path: str
    label: str
    type: Optional[str] = None       # auto-detected if None
    display_mode: Optional[str] = None
    genome_key: Optional[str] = None  # provider-aware key or free-text assembly accession
    splice_settings: Optional[Dict[str, Any]] = None
    bigwig_settings: Optional[Dict[str, Any]] = None
    vcf_settings: Optional[Dict[str, Any]] = None
    source: Optional[str] = None
    source_meta: Optional[Dict[str, Any]] = None


class TrackRegistryUpdateEntry(BaseModel):
    label: Optional[str] = None
    display_mode: Optional[str] = None
    genome_key: Optional[str] = None
    splice_settings: Optional[Dict[str, Any]] = None
    bigwig_settings: Optional[Dict[str, Any]] = None
    vcf_settings: Optional[Dict[str, Any]] = None


@app.get("/api/tracks")
async def list_tracks(genome_key: Optional[str] = None):
    """Return all registered tracks, optionally filtered by genome_key."""
    config = load_config()
    registry = _load_track_registry(config)
    _ensure_track_registry_sidecar(config)
    tracks = [_hydrate_track_genome_label(_hydrate_track_defaults(t), config) for t in registry.get("tracks", [])]
    if genome_key:
        tracks = [t for t in tracks if t.get("genome_key") == genome_key]
    return {"tracks": tracks}


@app.post("/api/tracks/trackhub/discover")
async def discover_trackhub_tracks(request: TrackHubDiscoverRequest):
    genomes = []
    for genome in request.genomes:
        genome_key = str(genome.genome_key or "").strip()
        if not genome_key:
            continue
        genomes.append({
            "genome_key": genome_key,
            "species_key": str(genome.species_key or "").strip(),
            "scientific_name": str(genome.scientific_name or "").strip(),
            "common_name": str(genome.common_name or "").strip(),
            "assembly": str(genome.assembly or "").strip(),
            "assembly_name": str(genome.assembly_name or "").strip(),
        })

    grouped = list_tracks_for_genomes(genomes, refresh=bool(request.refresh))
    items = []
    for genome in genomes:
        genome_key = genome["genome_key"]
        payload = grouped.get(genome_key) or {"genome_key": genome_key, "tracks": [], "error": ""}
        tracks = payload.get("tracks") or []
        normalized_tracks = []
        for track in tracks:
            fmt, ttype = _normalize_trackhub_format(track.get("format"), track.get("data_url"))
            if ttype not in {"bigwig", "bigbed"}:
                continue
            meta = _normalize_trackhub_source_meta(track) or {}
            normalized_tracks.append({
                "hub_id": meta.get("hub_id", ""),
                "hub_name": meta.get("hub_name", ""),
                "track_id": meta.get("track_id", ""),
                "track_name": meta.get("track_name", ""),
                "assembly": meta.get("assembly", ""),
                "format": fmt or meta.get("format", ""),
                "type": ttype,
                "data_url": meta.get("data_url", ""),
                "description": meta.get("description", ""),
                "import_key": str(
                    meta.get("import_key")
                    or track.get("import_key")
                    or _compute_trackhub_import_key(
                        meta.get("hub_id"),
                        meta.get("track_id"),
                        meta.get("assembly"),
                        meta.get("data_url"),
                    )
                ),
            })
        normalized_tracks.sort(
            key=lambda t: (
                str(t.get("hub_name") or "").lower(),
                str(t.get("track_name") or "").lower(),
                str(t.get("data_url") or "").lower(),
            )
        )
        items.append({
            "genome_key": genome_key,
            "tracks": normalized_tracks,
            "error": str(payload.get("error") or ""),
        })

    return {
        "genomes": items,
        "fetched_at": now_iso(),
    }


async def _run_trackhub_import_task(task_id: str, output_dir: str, item: TrackHubImportItem):
    try:
        source_meta = _normalize_trackhub_source_meta(item.source_meta) or {}
        data_url = _validate_trackhub_data_url(source_meta.get("data_url") or "")
        source_meta = _normalize_trackhub_source_meta({**source_meta, "data_url": data_url}) or source_meta
        format_name, track_type = _normalize_trackhub_format(source_meta.get("format"), data_url)
        if track_type not in {"bigwig", "bigbed"}:
            raise RuntimeError("Only bigWig and bigBed track hub formats are supported.")

        genome_key = str(item.genome_key or "").strip()
        species_key = str(item.species_key or "").strip()
        assembly = str(item.assembly or "").strip()
        provider = normalize_provider(item.provider)
        if not species_key or not assembly:
            raise RuntimeError("species_key and assembly are required for track hub imports.")

        filename = _trackhub_output_filename(source_meta, data_url, track_type)
        asm_dir = _resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
        trackhub_dir = asm_dir / "trackhub"
        destination = (trackhub_dir / filename).resolve()
        try:
            destination.relative_to(trackhub_dir.resolve())
        except ValueError:
            raise RuntimeError("Invalid destination path for track hub import.")

        existing_track = None
        with _track_registry_lock:
            existing_track = _find_existing_trackhub_track(genome_key, source_meta, destination)
        if existing_track:
            _set_trackhub_import_task(
                task_id,
                status="completed",
                progress=1.0,
                registered_track=existing_track,
                message="Track already registered.",
            )
            return

        await asyncio.to_thread(_trackhub_download_sync, task_id, data_url, destination)
        _set_trackhub_import_task(task_id, status="registering", progress=1.0)

        label = str(item.label or "").strip() or str(source_meta.get("track_name") or source_meta.get("track_id") or Path(filename).stem)
        display_mode = None
        bigwig_settings = None
        if track_type == "bigwig":
            # Track Hub signal tracks should default to the generic signal profile.
            display_mode = "signal_plot"
            bigwig_settings = {
                "data_type": "custom",
                "use_default_plot_color": True,
                "use_default_zoned_colors": True,
            }
        registered = await register_track(
            TrackRegistryEntry(
                path=str(destination),
                label=label,
                type=track_type,
                display_mode=display_mode,
                genome_key=genome_key,
                bigwig_settings=bigwig_settings,
                source="trackhub",
                source_meta={
                    **source_meta,
                    "format": format_name,
                },
            )
        )
        _set_trackhub_import_task(
            task_id,
            status="completed",
            progress=1.0,
            registered_track=registered,
            message="Track imported.",
        )
    except Exception as exc:
        _set_trackhub_import_task(
            task_id,
            status="failed",
            error=str(exc),
            message="Import failed.",
        )


@app.post("/api/tracks/trackhub/import")
async def import_trackhub_tracks(request: TrackHubImportRequest):
    if not request.output_dir:
        raise HTTPException(status_code=400, detail="output_dir is required")
    if not request.items:
        raise HTTPException(status_code=400, detail="items are required")

    task_ids: List[str] = []
    for item in request.items:
        source_meta = _normalize_trackhub_source_meta(item.source_meta) or {}
        _, track_type = _normalize_trackhub_format(source_meta.get("format"), source_meta.get("data_url"))
        if track_type not in {"bigwig", "bigbed"}:
            raise HTTPException(status_code=400, detail="Only bigWig and bigBed imports are supported")

        task_id = str(uuid.uuid4())
        with _trackhub_import_tasks_guard:
            _trackhub_import_tasks[task_id] = {
                "id": task_id,
                "status": "queued",
                "progress": 0.0,
                "error": "",
                "message": "Queued",
                "genome_key": str(item.genome_key or "").strip(),
                "species_key": str(item.species_key or "").strip(),
                "assembly": str(item.assembly or "").strip(),
                "track_name": str(source_meta.get("track_name") or source_meta.get("track_id") or ""),
                "track_type": track_type,
                "import_key": str(
                    source_meta.get("import_key")
                    or _compute_trackhub_import_key(
                        source_meta.get("hub_id"),
                        source_meta.get("track_id"),
                        source_meta.get("assembly"),
                        source_meta.get("data_url"),
                    )
                ),
                "created_at": now_iso(),
                "updated_at": now_iso(),
                "_updated_ts": time.time(),
            }
        task_ids.append(task_id)
        asyncio.create_task(_run_trackhub_import_task(task_id, str(request.output_dir), item))

    return {"task_ids": task_ids, "status": "started"}


@app.get("/api/tracks/trackhub/import_tasks")
async def list_trackhub_import_tasks():
    return {"tasks": _read_trackhub_import_tasks()}


@app.post("/api/tracks")
async def register_track(entry: TrackRegistryEntry):
    """Register a new custom track. Validates file existence and auto-detects type."""
    path = str(entry.path).strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    # Auto-detect type
    detected_type = entry.type or _detect_track_type(path)

    # For BAM, check if it should be long_reads
    if detected_type == "bam" and _detect_long_read_bam(path):
        detected_type = "long_reads"

    if not detected_type:
        raise HTTPException(
            status_code=422,
            detail="Could not auto-detect track type from file extension. Specify 'type' in the request."
        )

    # ── Auto-index files that need it (uses pysam's bundled htslib — no external tools needed) ──
    index_note = ""

    if detected_type == "vcf":
        tbi = Path(path + ".tbi")
        csi = Path(path + ".csi")
        if not tbi.exists() and not csi.exists():
            try:
                import pysam, asyncio

                # bgzip-compress if not already a .gz file
                if not path.endswith(".gz"):
                    gz_path = path + ".gz"
                    await asyncio.to_thread(
                        pysam.tabix_compress, path, gz_path, force=True
                    )
                    path = gz_path
                    p = Path(path)

                # Build tabix index (.tbi)
                await asyncio.to_thread(
                    pysam.tabix_index, path, preset="vcf", force=True
                )
                index_note = "bgzip + tabix index created automatically."
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Auto-indexing failed: {exc}. Ensure the VCF is valid."
                )

    elif detected_type in ("bam", "long_reads"):
        bai = Path(path + ".bai")
        bai2 = p.with_suffix(".bai")
        if not bai.exists() and not bai2.exists():
            try:
                import pysam, asyncio
                await asyncio.to_thread(pysam.index, path)
                index_note = "BAM index (.bai) created automatically."
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Auto-indexing failed: {exc}. Try running: samtools index {path}"
                )


    splice_settings = None
    bigwig_settings = None
    vcf_settings = None
    display_mode = entry.display_mode

    if detected_type == "bigwig":
        bigwig_settings = _normalize_bigwig_settings(entry.bigwig_settings)
        if display_mode is None:
            display_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[bigwig_settings["data_type"]]["display_mode"])
        else:
            display_mode = _normalize_bigwig_display_mode(display_mode, bigwig_settings["data_type"])
    elif detected_type == "vcf":
        vcf_settings = _normalize_vcf_settings(entry.vcf_settings)
        display_mode = _normalize_vcf_display_mode(display_mode)
    else:
        if not display_mode:
            modes = TRACK_DISPLAY_MODES.get(detected_type, [])
            display_mode = modes[0] if modes else "default"

    if detected_type == "splice_junctions":
        display_mode = "arcs"
        splice_settings = _normalize_splice_settings(entry.splice_settings)

    track_id = f"trk_{uuid.uuid4().hex[:12]}"
    # Suggest label from filename if blank
    label = (entry.label or "").strip() or p.stem.replace("_", " ").replace("-", " ")
    source = str(entry.source or "").strip().lower()
    if source and source != "trackhub":
        source = ""
    source_meta = None
    if source == "trackhub":
        source_meta = _normalize_trackhub_source_meta(entry.source_meta)

    new_track = {
        "id": track_id,
        "path": path,
        "label": label,
        "type": detected_type,
        "display_mode": display_mode,
        "genome_key": entry.genome_key or "",
        "splice_settings": splice_settings,
        "bigwig_settings": bigwig_settings,
        "vcf_settings": vcf_settings,
        "source": source or "",
        "source_meta": source_meta,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "index_note": index_note,
    }

    config = load_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        registry.setdefault("tracks", []).append(new_track)
        _save_track_registry(registry, config)

    return _hydrate_track_defaults(new_track)


@app.put("/api/tracks/{track_id}")
async def update_track(track_id: str, entry: TrackRegistryUpdateEntry):
    """Update label, display_mode, or genome_key for an existing track."""
    config = load_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        tracks = registry.get("tracks", [])
        idx = next((i for i, t in enumerate(tracks) if t.get("id") == track_id), None)
        if idx is None:
            raise HTTPException(status_code=404, detail=f"Track not found: {track_id}")
        track_type = tracks[idx].get("type")
        if entry.label is not None:
            tracks[idx]["label"] = entry.label
        if entry.genome_key is not None:
            tracks[idx]["genome_key"] = entry.genome_key

        if track_type == "bigwig":
            prev_settings = _normalize_bigwig_settings(tracks[idx].get("bigwig_settings"))
            prev_data_type = prev_settings["data_type"]
            prev_default_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[prev_data_type]["display_mode"])
            prev_mode = _normalize_bigwig_display_mode(tracks[idx].get("display_mode"), prev_data_type)

            next_settings = prev_settings
            data_type_changed = False
            if entry.bigwig_settings is not None:
                next_settings = _normalize_bigwig_settings(entry.bigwig_settings, previous=prev_settings)
                tracks[idx]["bigwig_settings"] = next_settings
                data_type_changed = next_settings["data_type"] != prev_data_type
            else:
                tracks[idx]["bigwig_settings"] = prev_settings

            if entry.display_mode is not None:
                tracks[idx]["display_mode"] = _normalize_bigwig_display_mode(entry.display_mode, next_settings["data_type"])
            elif data_type_changed:
                next_default_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[next_settings["data_type"]]["display_mode"])
                tracks[idx]["display_mode"] = next_default_mode if prev_mode == prev_default_mode else prev_mode
            elif not tracks[idx].get("display_mode"):
                tracks[idx]["display_mode"] = str(BIGWIG_DATA_TYPE_DEFAULTS[next_settings["data_type"]]["display_mode"])
            else:
                tracks[idx]["display_mode"] = _normalize_bigwig_display_mode(tracks[idx].get("display_mode"), next_settings["data_type"])
        elif track_type == "vcf":
            prev_vcf_settings = _normalize_vcf_settings(tracks[idx].get("vcf_settings"))
            if entry.vcf_settings is not None:
                tracks[idx]["vcf_settings"] = _normalize_vcf_settings(entry.vcf_settings, previous=prev_vcf_settings)
            else:
                tracks[idx]["vcf_settings"] = prev_vcf_settings

            if entry.display_mode is not None:
                tracks[idx]["display_mode"] = _normalize_vcf_display_mode(entry.display_mode)
            elif not tracks[idx].get("display_mode"):
                tracks[idx]["display_mode"] = "density_lollipop"
            else:
                tracks[idx]["display_mode"] = _normalize_vcf_display_mode(tracks[idx].get("display_mode"))
        else:
            if entry.display_mode is not None:
                if track_type == "splice_junctions":
                    tracks[idx]["display_mode"] = "arcs"
                else:
                    tracks[idx]["display_mode"] = entry.display_mode

        if entry.splice_settings is not None:
            if track_type == "splice_junctions":
                tracks[idx]["splice_settings"] = _normalize_splice_settings(entry.splice_settings)
            else:
                tracks[idx]["splice_settings"] = entry.splice_settings
        elif track_type == "splice_junctions" and not isinstance(tracks[idx].get("splice_settings"), dict):
            tracks[idx]["splice_settings"] = _normalize_splice_settings(None)

        _save_track_registry(registry, config)
        return _hydrate_track_defaults(tracks[idx])


@app.delete("/api/tracks/{track_id}")
async def delete_track(track_id: str):
    """Remove a track registration (does not delete the file)."""
    config = load_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        tracks = registry.get("tracks", [])
        new_tracks = [t for t in tracks if t.get("id") != track_id]
        if len(new_tracks) == len(tracks):
            raise HTTPException(status_code=404, detail=f"Track not found: {track_id}")
        registry["tracks"] = new_tracks
        _save_track_registry(registry, config)
    return {"deleted": track_id}


@app.get("/api/tracks/type_info")
async def track_type_info():
    """Return the supported track types, their extension hints, and display modes."""
    return {
        "extension_map": TRACK_EXTENSION_MAP,
        "display_modes": TRACK_DISPLAY_MODES,
    }


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
_VCF_TILE_DISK_CACHE_DIR = CACHE_DIR / "vcf_tiles"
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
_VCF_BLOCK_TILE_DISK_CACHE_DIR = CACHE_DIR / "vcf_block_tiles"
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
        db_path = _get_browse_db(g)
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
    resolved = _resolve_browse_chrom_name(genome, token, known)
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

    resolved = _resolve_browse_chrom_name(genome, token, known)
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
    track = _get_registered_track(track_id or "")
    registry_settings = None
    if track and track.get("type") == "splice_junctions":
        same_path = str(track.get("path") or "").strip() == str(path or "").strip()
        if same_path:
            registry_settings = _normalize_splice_settings(track.get("splice_settings"))

    applied = _normalize_splice_settings(registry_settings)
    applied["min_support"] = max(
        _to_int_or_default(min_reads, 1, minimum=1),
        _to_int_or_default(min_support, applied["min_support"], minimum=1),
    )
    if canonical_mode is not None:
        mode = str(canonical_mode).strip().lower()
        if mode in _CANONICAL_SPLICE_MODES:
            applied["canonical_mode"] = mode
    if annotated_mode is not None:
        mode = str(annotated_mode).strip().lower()
        if mode in _ANNOTATED_SPLICE_MODES:
            applied["annotated_mode"] = mode
    if max_junctions is not None:
        applied["max_junctions"] = _to_int_or_default(max_junctions, applied["max_junctions"], minimum=100, maximum=100_000)
    return applied


def _load_splice_local_annotation_pairs(genome: str, resolved_chrom: str, requested_chrom: str) -> Optional[Set[Tuple[int, int]]]:
    local_annotated_pairs: Optional[Set[Tuple[int, int]]] = None
    try:
        db_path = _get_browse_db(genome)
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
            canonical = _is_canonical_splice_motif(motif)
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
                # Linear scan
                opener = gzip.open if str(path).endswith(".gz") else open
                known_chroms: Set[str] = set()
                overlapping_by_chrom: Dict[str, List[Dict]] = {}
                try:
                    with opener(str(p), "rt") as fh:
                        for line in fh:
                            rec = _parse_bed_line(line)
                            if not rec:
                                continue
                            rec_chrom = str(rec["chrom"])
                            known_chroms.add(rec_chrom)
                            if rec["end"] < start or rec["start"] > end:
                                continue
                            bucket = overlapping_by_chrom.setdefault(rec_chrom, [])
                            if len(bucket) < max_intervals:
                                bucket.append(rec)
                    if known_chroms:
                        resolved_chrom = _resolve_track_chrom_with_aliases(chrom, sorted(known_chroms), genome=genome)
                        intervals = overlapping_by_chrom.get(resolved_chrom, [])
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


@app.post("/api/browse/bigbed/block_tiles")
async def browse_bigbed_block_tiles(payload: BigBedBlockTilesRequest):
    def _run():
        if not payload.tiles:
            raise HTTPException(status_code=400, detail="tiles must not be empty")
        if pyBigWig is None:
            raise HTTPException(status_code=503, detail="BigBed support is unavailable. Install pyBigWig.")

        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BigBed not found: {path}")
        if not _is_bigbed_path(p):
            raise HTTPException(status_code=400, detail="path is not a BigBed file")

        try:
            bb = pyBigWig.open(str(p))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
        if bb is None:
            raise HTTPException(status_code=400, detail="Failed to open BigBed file.")

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
                features, _ = _select_bigbed_tile_entries(
                    bb=bb,
                    resolved_chrom=resolved_chrom,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    max_features=250_000,
                    schema_info=schema_info,
                )
                block_bp = _to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
                block_spans, painted_bp = _build_bigbed_block_spans_from_features(
                    features=features,
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
        if pyBigWig is None:
            raise HTTPException(status_code=503, detail="BigBed support is unavailable. Install pyBigWig.")

        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BigBed not found: {path}")
        if not _is_bigbed_path(p):
            raise HTTPException(status_code=400, detail="path is not a BigBed file")

        try:
            bb = pyBigWig.open(str(p))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
        if bb is None:
            raise HTTPException(status_code=400, detail="Failed to open BigBed file.")

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
            request_limit = _to_int_or_default(payload.max_features_per_tile, 3000, minimum=100, maximum=50_000)
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

                max_features = _to_int_or_default(tile.max_features, request_limit, minimum=100, maximum=50_000)
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
            block_bp = _to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
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

    await run_in_threadpool(_get_browse_db, genome)
    p = Path(path).expanduser()
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig not found: {p}")

    requested_chrom_len: Optional[int] = None
    try:
        fasta = _get_browse_fasta(genome)
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
                if e <= s:
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
                    raw = bw.stats(resolved_chrom, s, e, type="mean", nBins=tile_bins, exact=False) or []
                    if len(raw) < tile_bins:
                        raw = raw + [None] * (tile_bins - len(raw))
                    elif len(raw) > tile_bins:
                        raw = raw[:tile_bins]
                    bins = [
                        None if value is None or (isinstance(value, float) and math.isnan(value)) else float(value)
                        for value in raw
                    ]
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

    log_progress(f"Starting Ensembl Go Backend on {args.host}:{args.port}...")

    # Run uvicorn programmatically
    uvicorn.run(app, host=args.host, port=args.port)
