"""Homology tables: the in-memory homology map and the per-file homology index (an LRU of
open tables), validation of homology file paths against the configuration, and the
/api/homologs and /api/homology search endpoints.
"""

import csv
import hashlib
import logging
import math
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import config_store
import data_paths
import file_io
import genome_context
import local_inventory
from genome_identity import DEFAULT_PROVIDER, selection_key_from_record
from homology_search import HomologySearchStore

logger = logging.getLogger(__name__)
router = APIRouter()


def _resolve_allowed_homology_path(path_value: str) -> Path:
    """Resolve and validate a homology table path from configured local data."""
    candidate = Path(path_value).expanduser().resolve()
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Homology file not found: {candidate}")

    name = candidate.name.lower()
    if not (name.endswith(".tsv") or name.endswith(".tsv.gz")):
        raise HTTPException(status_code=400, detail="Homology file must be .tsv or .tsv.gz")

    cfg = config_store.load_config()
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
            local_root = data_paths._resolve_local_data_root(output_dir)
            candidate.relative_to(local_root)
            return candidate
        except Exception:
            pass

    raise HTTPException(status_code=400, detail="Homology path is not part of configured local genomes")


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

        file_io.log_progress(f"Loading homology map: {Path(file_path).name}")
        self.ref_to_targets = {}
        self.target_to_ref = {}
        
        try:
            with file_io.open_maybe_gz(file_path, 'r') as f:
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
            file_io.log_progress(f"  ✓ Loaded {len(self.ref_to_targets)} reference entries")

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
        with file_io.open_maybe_gz(file_path, 'rt') as f:
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

        file_io.log_progress(f"Indexing homology file: {Path(resolved).name}")
        index = self._load(resolved)

        with self._lock:
            self._cache[resolved] = (fingerprint, index)
            self._cache.move_to_end(resolved)
            while len(self._cache) > self._max_entries:
                self._cache.popitem(last=False)
        file_io.log_progress(f"  ✓ Indexed {len(index)} genes from {Path(resolved).name}")
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


@router.get("/api/homologs")
def get_homologs(transcript_id: str):
    """Look up homologous transcripts for a given ID."""
    config = config_store.load_config()
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


class HomologySearchRequest(BaseModel):
    genome_key: str
    gene_query: str
    min_identity: Optional[float] = None
    min_coverage: Optional[float] = None
    types: Optional[List[str]] = None
    target_assemblies: Optional[List[str]] = None
    offset: int = 0
    limit: int = 100
    query_gene_id: str = ""
    target_key: str = ""
    sort_key: str = "score"
    direction: str = "desc"
    include_evidence: bool = True
    focus_query_gene_id: str = ""
    focus_target_key: str = ""


homology_search_store = HomologySearchStore(app_paths.CACHE_DIR / "homology_search")


def _homology_source_path(species: Dict[str, Any], cfg: Dict[str, Any]) -> str:
    """Find newly downloaded evidence for the selected release, without changing config."""
    configured = str((species.get("files") or {}).get("homology") or "").strip()
    if configured:
        return configured
    output_dir = str(cfg.get("output_dir") or "").strip()
    if not output_dir or species.get("is_manual"):
        return ""
    assembly = str(species.get("assembly") or species.get("gca") or "").strip()
    local_dir = data_paths._resolve_species_assembly_dir(output_dir, species.get("species_key") or "", assembly,
                                            provider=species.get("provider") or DEFAULT_PROVIDER)
    release = str(species.get("dataset_release_key") or "").strip()
    if not release:
        selected = selection_key_from_record(species)
        release = selected.split("::dataset::", 1)[1] if "::dataset::" in selected else ""
    if release and release != local_inventory.LEGACY_DATASET_RELEASE_KEY:
        parts = release.split("/")
        if len(parts) != 2:
            return ""
        directory = local_dir / "datasets"
        for part in parts:
            directory = directory / data_paths._validate_path_segment("dataset release", part)
    else:
        # Older session records may identify their release only through the annotation.
        directory = local_dir
        annotation = str((species.get("files") or {}).get("gff3") or "").strip()
        if not release and annotation:
            parent = Path(annotation).expanduser().resolve().parent
            try:
                parent.relative_to(local_dir / "datasets")
                directory = parent
            except ValueError:
                pass
    directory = directory.resolve()
    try:
        directory.relative_to(local_dir)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid homology dataset path")
    _, files = local_inventory._scan_local_release_dir(directory)
    return str(files.get("homology") or "")


@router.get("/api/homology/sources")
def homology_search_sources():
    sources = {}
    cfg = config_store.load_config()
    for species in genome_context._browsable_active_species(cfg):
        key = genome_context._active_species_item_key(species)
        path = ""
        try:
            path = _homology_source_path(species, cfg)
            if not path:
                sources[key] = {"status": "missing", "path": "", "source_token": ""}
                continue
            allowed = _resolve_allowed_homology_path(path)
            fingerprint = homology_search_store.fingerprint(allowed)
            token = hashlib.sha256((str(allowed) + str(fingerprint)).encode()).hexdigest()
            sources[key] = {"status": "ready", "path": str(allowed), "source_token": token}
        except (HTTPException, OSError) as exc:
            sources[key] = {"status": "missing", "path": path, "source_token": "",
                            "detail": str(getattr(exc, "detail", exc))}
    return {"sources": sources}


@router.post("/api/homology/search")
def search_homology_table(request: HomologySearchRequest):
    # Selection keys include the release. Never resolve a release-specific request
    # to the first genome sharing its assembly accession.
    cfg = config_store.load_config()
    species = next((item for item in genome_context._browsable_active_species(cfg)
                    if genome_context._active_species_item_key(item) == request.genome_key), None)
    if species is None:
        raise HTTPException(status_code=404, detail="Genome is not part of the configured session.")
    path = _homology_source_path(species, cfg)
    if not path:
        raise HTTPException(status_code=404, detail="No homology file configured for this genome.")
    allowed = _resolve_allowed_homology_path(path)
    for threshold in (request.min_identity, request.min_coverage):
        if threshold is not None and (not math.isfinite(threshold) or not 0 <= threshold <= 100):
            raise HTTPException(status_code=400, detail="Identity and coverage thresholds must be between 0 and 100.")
    try:
        result = homology_search_store.search(
            allowed, request.gene_query,
            filters={"min_identity": request.min_identity, "min_coverage": request.min_coverage,
                     "types": request.types, "target_assemblies": request.target_assemblies},
            offset=request.offset, limit=request.limit, query_gene_id=request.query_gene_id,
            target_key=request.target_key, sort_key=request.sort_key, direction=request.direction,
            include_evidence=request.include_evidence,
            focus_query_gene_id=request.focus_query_gene_id, focus_target_key=request.focus_target_key,
        )
        return {**result, "genome_key": request.genome_key}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"Cannot read homology file: {exc}") from exc


@router.get("/api/homology/query")
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
        with file_io.open_maybe_gz(table_path, "rt") as handle:
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
