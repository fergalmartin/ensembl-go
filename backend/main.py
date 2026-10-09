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
import routes.browse


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
