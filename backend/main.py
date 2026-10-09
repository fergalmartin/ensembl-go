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
import os
import re
import shutil
import sqlite3
import time
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from urllib.parse import urlparse, quote, unquote, urlencode
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Set
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
import protein_structure
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
from security_utils import (
    get_with_validated_redirects,
    validate_annotation_service_url,
    require_loopback_client,
    require_path_within,
    safe_export_filename,
    sanitize_leaf_filename,
    validate_backend_bind_host,
)
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
app.include_router(routes.genome_removal.router)
app.include_router(routes.stats.router)
app.include_router(routes.alignment.router)
app.include_router(routes.sv.router)
app.include_router(routes.vcf.router)
app.include_router(routes.bigwig.router)
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
        result = mafft.run_mafft_alignment(local_seq, model_seq)
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
        with routes.vcf.locked_vcf(path) as (handle, _fingerprint, _resolved_path):
            resolved_chrom = routes.vcf._resolve_vcf_chrom(handle, chrom)
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


routes.vcf._VCF_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


routes.vcf._VCF_BLOCK_TILE_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


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
                resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
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
                        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
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
                        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, known_chroms, genome=genome)
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
            resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
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
            resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
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
        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
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
        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available_chroms, genome=genome)
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
