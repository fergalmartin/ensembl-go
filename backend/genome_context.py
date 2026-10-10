"""Resolve configured genomes, browse indexes, FASTA handles and region aliases.

Cache FASTA handles, recovered index paths, assembly reports and synonym
lookups for reuse across browse endpoints.
"""

import os
import sqlite3
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import unquote

from fastapi import HTTPException

import config_store
import data_paths
import demo_genome
import file_io
import gff_index
import local_inventory
from assembly_report import (
    KnownRegions,
    chrom_token_variants,
    build_synonym_index,
    load_assembly_synonym_rows,
    resolve_region_name,
)
from genome_identity import (
    genome_key as build_provider_aware_genome_key,
    legacy_genome_key,
    selection_key_from_record,
    strip_dataset_release_from_selection_key,
)


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
        list(cfg.get("active_species") or []) + demo_genome.tutorial_session_species()
        + list(cfg.get("next_previous_session_genomes") or [])
    )


def _resolve_browse_genome_context(genome: str) -> Dict[str, Any]:
    cfg = config_store.load_config()
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
        # Alignment genome-link files use the assembly accession itself as the
        # stable identity. Resolve that compact public identifier to the full
        # local genome record only at the browser/annotation boundary.
        assembly_token = token.upper()
        species = next(
            (
                s for s in active_species
                if str(s.get("assembly") or s.get("gca") or s.get("assembly_accession") or "").strip().upper() == assembly_token
            ),
            None,
        )
    if not species:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid genome: {genome}. Use 'reference', 'target', an assembly accession, or a genome key such as '<provider>::<species_key>::<assembly>'."
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
    fallback = data_paths._find_assembly_report_file(assembly_dir)
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
    normalized_gff = gff_index._normalize_fs_path(gff_path)
    normalized_db = gff_index._normalize_fs_path(db_path)
    latest: Optional[Dict[str, Any]] = None
    with gff_index._index_tasks_guard:
        for task in gff_index._index_tasks.values():
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
    if recorded_signature and recorded_signature != gff_index._annotation_signature(normalized_gff):
        gff_index.forget_index_failures(normalized_gff, normalized_db)
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
    normalized_gff = gff_index._normalize_fs_path(gff_path)
    if not os.path.exists(normalized_gff):
        return ""

    with _RECOVERED_INDEX_GUARD:
        remembered = _RECOVERED_INDEX_PATHS.get(normalized_gff, "")
    if remembered and os.path.exists(remembered):
        return remembered

    found = local_inventory._resolve_local_gff_index(normalized_gff, assembly)
    if found:
        with _RECOVERED_INDEX_GUARD:
            _RECOVERED_INDEX_PATHS[normalized_gff] = found
        return found

    # Nothing built yet. Point at whatever build is already in flight for this
    # annotation, so a build started from the selector and one queued by the
    # browser converge on the same file.
    with gff_index._index_tasks_guard:
        for task in gff_index._index_tasks.values():
            if task.get("status") in {"queued", "running"} and task.get("gff_path") == normalized_gff:
                return str(task.get("db_path") or "")

    try:
        return str(gff_index._resolve_index_path(
            normalized_gff,
            str(cfg.get("output_dir") or ""),
            gff_index._index_basename_for_annotation(normalized_gff),
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
        if gff_index._is_existing_index_usable(db, gff):
            return gff_index._normalize_fs_path(db)
        build_error = _index_build_error_for(gff, db)
        if build_error:
            raise HTTPException(
                status_code=500,
                detail=f"The annotation index for the {genome} genome could not be built: {build_error}",
            )
        try:
            gff_index.queue_index_build(gff, db)
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
    fasta = file_io.open_indexed_fasta(fasta_path)
    _fasta_cache[cache_key] = (fasta_path, fasta)
    return fasta


def _force_refresh_browse_fasta_index(genome: str, current_fasta: Optional["ThreadSafeFasta"] = None):
    """Force FASTA re-index + handle refresh for a genome cache entry."""
    context = _resolve_browse_genome_context(genome)
    cache_key = str(context.get("cache_key") or str(genome or "").strip() or "reference")
    fasta_path = str(context.get("fasta_path") or "")
    if not fasta_path or not os.path.exists(fasta_path):
        raise HTTPException(status_code=404, detail=f"FASTA not found for {genome} genome.")

    refreshed = file_io.open_indexed_fasta(fasta_path, force_reindex=True)
    _fasta_cache[cache_key] = (fasta_path, refreshed)

    try:
        if current_fasta is not None and current_fasta is not refreshed:
            current_fasta.close()
    except Exception:
        pass
    return refreshed


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
                attrs = gff_index._parse_gff_attributes(parts[8])
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
                attrs = gff_index._parse_gff_attributes(parts[8])
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
