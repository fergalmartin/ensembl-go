"""
Ensembl Go Backend - FastAPI server for local genome and alignment views.
Uses lightweight targeted GFF3 lookup instead of full parsing.
"""

import hmac
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

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


# Configure logging before importing this application's own modules, so that what
# they log while being imported (the download manager loading its catalogue, say)
# is not lost.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

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
import app_state
import file_io
import app_paths
import routes.sequence_export
import routes.feature_explorer
import routes.browse
import package_providers


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
    annotation_provider=lambda *args, **kwargs: package_providers.alignment_explorer_annotation_features(*args, **kwargs),
    gene_provider=lambda *args, **kwargs: package_providers.alignment_explorer_block_genes(*args, **kwargs),
    availability_provider=lambda *args, **kwargs: package_providers.alignment_explorer_genome_availability(*args, **kwargs)))

# Gene trees: the library lives beside the user's genomes, the protein maps it
# builds from their GFFs are derived data and live in the cache.
from gene_trees import create_router as create_gene_trees_router
app.include_router(create_gene_trees_router(
    library_path_provider=lambda: package_providers.gene_trees_library_path(),
    genomes_provider=lambda: package_providers.gene_trees_local_genomes(),
    cache_dir=app_paths.CACHE_DIR / "gene_trees",
    neighbourhood_lookup=lambda db_path, gene_id, window: package_providers.gene_trees_neighbourhood(db_path, gene_id, window),
    alignment_hooks={
        "store_root": lambda: package_providers.gene_trees_alignments_root(),
        "transcript_lookup": lambda *args: package_providers.gene_trees_transcript(*args),
        "fetcher_for": lambda genome: package_providers.gene_trees_fetcher(genome),
        "align_fn": lambda *args: package_providers.gene_trees_align(*args),
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
app.include_router(routes.browse.router)


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
