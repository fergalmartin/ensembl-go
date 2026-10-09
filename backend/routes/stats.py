"""Genome statistics: the annotation, structural, homology and assembly summaries for the
active genomes (read from per-genome stats caches), the background structural-stats
task with progress and cancellation, and the /api/stats endpoints.
"""

import asyncio
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import config_store
import genome_context
import local_inventory
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    selection_key_from_record,
)
from stats_utils import (
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
    STATS_SCHEMA_VERSION,
    STRUCTURAL_PROFILE,
    update_stats_cache,
)

router = APIRouter()


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


@router.post("/api/stats/summary")
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


@router.post("/api/stats/structural/generate")
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


@router.post("/api/stats/structural/cancel")
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


@router.get("/api/stats/tasks")
async def stats_list_tasks():
    return _list_stats_tasks()


@router.get("/api/stats/tasks/{task_id}")
async def stats_get_task(task_id: str):
    task = _read_stats_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Stats task not found: {task_id}")
    return task
