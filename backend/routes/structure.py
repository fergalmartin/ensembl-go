"""The 3D structure panel: resolving a protein to a UniProt accession (typed, imported
mapping, genome xrefs, then the UniProt API, with memory and disk caches), fetching
AlphaFold models, mapping residues to exons via MAFFT, overlaying VCF variants, the
mapping-file import, and serving the sandboxed Mol* viewer page and assets.
"""

import hashlib
import json
import logging
import re
import shutil
import sqlite3
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import quote, urlencode

from Bio.Seq import Seq
from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

import app_paths
import app_state
import config_store
import genome_context
import gff_index
import mafft
import protein_structure
import routes.tracks
import routes.vcf
import transcript_translation
from security_utils import (
    get_with_validated_redirects,
    require_path_within,
    sanitize_leaf_filename,
    validate_annotation_service_url,
)
from translation import TABLE_STANDARD

router = APIRouter()


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

    protein_ids = gff_index._extract_protein_ids_from_gff(
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
        table, molecule, table_resolved = transcript_translation._resolve_translation_table(genome, chrom)
        protein, layout, used_table = transcript_translation._translate_transcript(
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
        model_url=f"{app_state.STRUCTURE_VIEWER_PREFIX}model/{quote(model.accession)}{query}",
        afdb_url=ALPHAFOLD_ENTRY_URL.format(accession=model.accession),
    )


@router.post("/api/structure/resolve", response_model=StructureResolveResponse)
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
            model=_model_info(model, app_state.API_TOKEN),
        )

    return await run_in_threadpool(_query)


@router.post("/api/structure/residue_map", response_model=StructureResidueMapResponse)
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


@router.post("/api/structure/transcripts", response_model=StructureTranscriptsResponse)
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


@router.post("/api/structure/variants", response_model=StructureVariantsResponse)
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
        dna = transcript_translation._cds_dna_from_layout(genome_context._get_browse_fasta(genome), chrom, strand, layout)

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


@router.get("/api/structure/mapping", response_model=StructureMappingStatusResponse)
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


@router.post("/api/structure/mapping/import", response_model=StructureMappingStatusResponse)
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


@router.post("/api/structure/mapping/clear", response_model=StructureMappingStatusResponse)
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


@router.get("/structure/viewer")
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
    query = f"?token={quote(app_state.API_TOKEN)}" if app_state.API_TOKEN else ""
    markup = page.read_text(encoding="utf-8").replace("__STRUCTURE_QUERY__", query)
    return HTMLResponse(
        content=markup,
        headers=_structure_no_store({"Content-Security-Policy": STRUCTURE_VIEWER_CSP}),
    )


@router.get("/structure/assets/{filename}")
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


@router.get("/structure/model/{accession}")
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
