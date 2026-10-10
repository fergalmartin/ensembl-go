"""Assemble the FastAPI app, middleware, startup tasks and routers.

Endpoints live in routes/ and the feature packages; shared services live in the
modules beside this file. Feature packages receive providers when their routers
are created, rather than importing the app.

Electron runs this file as __main__. Other application modules must not import
main, which would create a second app instance.
"""

import hmac
import logging
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


# Configure logging before imports so startup messages are captured.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

import app_paths
import app_state
import file_io
import genome_context
import local_inventory
import package_providers
import sequence_windows
import transcript_translation
import routes.achievements
import routes.alignment
import routes.bed
import routes.bigwig
import routes.browse
import routes.config
import routes.custom_genomes
import routes.downloads
import routes.feature_explorer
import routes.genome_removal
import routes.homology
import routes.long_reads
import routes.neighbourhood
import routes.notes
import routes.remote_catalog
import routes.sequence_export
import routes.splice
import routes.stats
import routes.structure
import routes.sv
import routes.tracks
import routes.tutorial
import routes.vcf
from alignment_explorer import create_router as create_alignment_explorer_router
from gene_trees import create_router as create_gene_trees_router
from security_utils import require_loopback_client, validate_backend_bind_host
from sequence_view import create_router as create_sequence_view_router


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Fetch the catalogue on a background thread without delaying startup.
    try:
        app_state.download_manager.ensure_catalog_available()
    except Exception:
        logger.exception("Failed to start the initial species catalogue fetch")
    yield


app = FastAPI(title="Ensembl Go API", lifespan=_lifespan)

# Look up providers on each call so patches to their defining modules take effect.
app.include_router(create_alignment_explorer_router(
    annotation_provider=lambda *args, **kwargs: package_providers.alignment_explorer_annotation_features(*args, **kwargs),
    gene_provider=lambda *args, **kwargs: package_providers.alignment_explorer_block_genes(*args, **kwargs),
    availability_provider=lambda *args, **kwargs: package_providers.alignment_explorer_genome_availability(*args, **kwargs)))

# Store the gene-tree library with the genomes and derived protein maps in the cache.
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

# Inject the sequence view's genome and translation providers.
app.include_router(create_sequence_view_router(
    db_provider=lambda *args, **kwargs: genome_context._get_browse_db(*args, **kwargs),
    db_optional_provider=lambda *args, **kwargs: genome_context._get_browse_db_optional(*args, **kwargs),
    fasta_provider=lambda *args, **kwargs: genome_context._get_browse_fasta(*args, **kwargs),
    chrom_resolver=lambda *args, **kwargs: genome_context._resolve_browse_chrom_name(*args, **kwargs),
    tx_feature_intervals=lambda *args, **kwargs: sequence_windows._build_tx_feature_intervals(*args, **kwargs),
    mode_segments=lambda *args, **kwargs: sequence_windows._build_mode_segments(*args, **kwargs),
    # Share translation with Feature Explorer, including organelle codes,
    # non-ATG initiation and incomplete CDS handling.
    translate_transcript=lambda *args, **kwargs: transcript_translation._sequence_view_protein(*args, **kwargs),
    normalize_intervals=lambda *args, **kwargs: sequence_windows._normalize_interval_list(*args, **kwargs),
    ordered_five_to_three=lambda *args, **kwargs: sequence_windows._ordered_five_to_three(*args, **kwargs)))

# Register domain routers. The route-contract test pins registration order
# wherever routes could match the same request.
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
            # Iframe navigation and viewer asset requests cannot attach our token
            # header. Accept a query token only under the structure-viewer prefix.
            provided = (
                request.query_params.get("token", "")
                if framed else
                request.headers.get(app_state.API_TOKEN_HEADER, "")
            )
            if not hmac.compare_digest(provided, app_state.API_TOKEN):
                return JSONResponse(status_code=401, content={"detail": "Missing or invalid local API token"})
    return await call_next(request)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Expose the shared local-genome inventory as an endpoint.
app.get("/api/remote/local-assemblies")(local_inventory.list_local_assemblies)


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
