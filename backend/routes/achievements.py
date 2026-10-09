"""Achievements: the persisted progress store (in the output directory, or the
cache when none is set), the download/deletion hooks other endpoints call, and the
/api/achievements endpoints."""

import logging
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import achievements_store
import app_paths
import app_state
import config_store
import data_paths
import demo_genome
import local_inventory
from demo_genome import TUTORIAL_WORKSPACE_DIR
from genome_identity import (
    genome_key as build_provider_aware_genome_key,
    iter_local_assembly_dirs,
    normalize_provider,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
#  Achievements — progress behind the optional Achievements view
# ═══════════════════════════════════════════════════════════════════════════════
#
# The store itself — its format, how copies merge, how it reaches disk — is
# achievements_store.py. What lives here is where the copies are, and the two events
# only the backend sees: a download finishing (often long after the user has left the
# Download view) and a genome being deleted.
#
# Paths come from the configuration on disk, never from a request, and a tutorial's
# scratch workspace is never one of them. The sandbox must not be able to award
# achievements, and must never become the place progress is written.
#
# The copies, in the order they are preferred for writing: the output-directory
# sidecar (beside user_notes.json), the working-directory sidecar, and a fallback in
# the cache directory for anyone who has not set an output directory yet. Loading
# reads them all and merges, so progress made before an output directory was chosen
# follows the user into it on the next write.


DEFAULT_ACHIEVEMENTS_FILE = app_paths.CACHE_DIR / achievements_store.ACHIEVEMENTS_FILENAME


ACHIEVEMENTS_FILE = DEFAULT_ACHIEVEMENTS_FILE


_achievements_lock = threading.Lock()


# Only a genome's sequence or annotation makes it "downloaded" for the count. The
# metadata and homology files ride along with those and would otherwise count the
# same genome several times over — though the set would absorb that anyway.
_ACHIEVEMENT_GENOME_FILE_TYPES = {"fasta", "gff3"}


def _output_dir_achievements_path(output_dir: Any) -> Optional[Path]:
    text = str(output_dir or "").strip()
    if not text:
        return None
    try:
        path = data_paths._resolve_local_data_root(text) / achievements_store.ACHIEVEMENTS_FILENAME
    except Exception:
        return None
    if TUTORIAL_WORKSPACE_DIR in path.parts:
        return None
    return path


def _achievement_store_paths(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    cfg = config if isinstance(config, dict) else config_store.load_config()
    candidates = [
        _output_dir_achievements_path(cfg.get("output_dir")),
        _output_dir_achievements_path(cfg.get("working_dir")),
        ACHIEVEMENTS_FILE,
    ]
    out: List[Path] = []
    seen: Set[str] = set()
    for path in candidates:
        if path is None:
            continue
        try:
            resolved = str(path.expanduser().resolve())
        except Exception:
            resolved = str(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(path)
    return out


def _record_achievement_read_warnings(results: List["achievements_store.StoreReadResult"]) -> None:
    for result in results:
        key = f"achievements:{result.path}"
        if result.status in ("corrupt", "newer"):
            config_store.record_config_warning(key, result.detail, result.path)
        elif result.status == "ok":
            config_store.clear_config_warning(key)
        # "missing" leaves a quarantine warning in place: the file that replaced the
        # corrupt one is new, and the user should still hear about the old one once.


def _load_achievements(config: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], bool]:
    """The merged store, and whether any copy is too new for this version to write."""
    doc, results = achievements_store.load_stores(_achievement_store_paths(config))
    _record_achievement_read_warnings(results)
    readonly = any(result.status == "newer" for result in results)
    return doc, readonly


def _mutate_achievements(
    mutate: Callable[[Dict[str, Any]], bool],
    config: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], bool]:
    """Load, change and save under the lock. Returns the store and whether it is read-only."""
    cfg = config if isinstance(config, dict) else config_store.load_config()
    with _achievements_lock:
        doc, readonly = _load_achievements(cfg)
        if readonly:
            return doc, True
        changed = bool(mutate(doc))
        primary = _achievement_store_paths(cfg)[0]
        # Written when nothing changed but the primary copy is missing, too: that is how
        # progress kept in the cache fallback moves into a newly set output directory.
        if changed or not primary.exists():
            try:
                achievements_store.write_store(primary, doc)
            except Exception as exc:
                logger.warning(f"Failed to save achievements to {primary}: {exc}")
        return doc, False


# ── Which organism a downloaded genome is ─────────────────────────────────────


_achievement_name_taxids: Optional[Dict[str, int]] = None


_achievement_name_taxids_guard = threading.Lock()


def _achievement_name_taxid_index() -> Dict[str, int]:
    """Lower-cased scientific name → a taxid whose lineage the classifier knows.

    Genera are indexed too, from any species in them, so a genome that is not in the
    Ensembl catalogue can still be placed in its clade by its genus. The lineage of a
    sibling species is exactly right for every question an achievement asks.
    """
    global _achievement_name_taxids
    with _achievement_name_taxids_guard:
        if _achievement_name_taxids is not None:
            return _achievement_name_taxids
        index: Dict[str, int] = {}
        genera: Dict[str, int] = {}
        classifier = getattr(app_state.download_manager, "taxonomy_classifier", None)
        records = ((classifier.artifact or {}).get("taxids") or {}) if classifier else {}
        for taxid_text, record in records.items():
            if not isinstance(record, dict):
                continue
            name = str(record.get("scientific_name") or "").strip().lower()
            if not name:
                continue
            try:
                taxid = int(record.get("resolved_taxid") or taxid_text)
            except (TypeError, ValueError):
                continue
            index.setdefault(name, taxid)
            genus = name.split()[0]
            if str(record.get("rank") or "") == "genus":
                genera[genus] = taxid
            else:
                genera.setdefault(genus, taxid)
        for genus, taxid in genera.items():
            index.setdefault(f"genus:{genus}", taxid)
        _achievement_name_taxids = index
        return index


def _achievement_lineage_known(taxid: int) -> bool:
    classifier = getattr(app_state.download_manager, "taxonomy_classifier", None)
    if not classifier or not taxid:
        return False
    try:
        _resolved, lineage = classifier.lineage_for_taxid(int(taxid))
    except Exception:
        return False
    return bool(lineage)


def _achievement_genome_taxid(
    species_key: str,
    scientific_name: str = "",
    manifest: Optional[Dict[str, Any]] = None,
    asm_dir: Optional[Path] = None,
) -> int:
    """Best-effort taxid for a downloaded genome, preferring one with a known lineage."""
    candidates: List[int] = []
    manifest = manifest or {}
    for value in (manifest.get("taxid"), manifest.get("species_taxonomy_id")):
        try:
            if int(value or 0):
                candidates.append(int(value))
        except (TypeError, ValueError):
            pass
    info = (getattr(app_state.download_manager, "species_data", {}) or {}).get(config_store._find_catalog_species_key(species_key)) or {}
    if isinstance(info, dict):
        for field in ("taxid", "species_taxonomy_id"):
            try:
                if int(info.get(field) or 0):
                    candidates.append(int(info.get(field)))
            except (TypeError, ValueError):
                pass
    if asm_dir is not None and asm_dir.is_dir():
        try:
            for report in sorted(asm_dir.rglob("*assembly_report*.txt")):
                taxid = data_paths._assembly_report_taxid(str(report))
                if taxid:
                    candidates.append(taxid)
                    break
        except Exception:
            pass

    for taxid in candidates:
        if _achievement_lineage_known(taxid):
            return taxid

    name = str(scientific_name or manifest.get("scientific_name") or species_key.replace("_", " ")).strip().lower()
    if name:
        index = _achievement_name_taxid_index()
        words = name.split()
        for probe in (name, " ".join(words[:2]), f"genus:{words[0]}"):
            if probe in index:
                return index[probe]
    return candidates[0] if candidates else 0


def _achievement_lineage_taxa(doc: Dict[str, Any]) -> List[int]:
    """Every clade any downloaded genome belongs to — what the taxon achievements test."""
    classifier = getattr(app_state.download_manager, "taxonomy_classifier", None)
    union: Set[int] = set()
    for taxid in set((doc.get("taxa") or {}).values()):
        union.add(int(taxid))
        if classifier is None:
            continue
        try:
            _resolved, lineage = classifier.lineage_for_taxid(int(taxid))
        except Exception:
            continue
        union.update(int(value) for value in lineage)
    return sorted(union)


# ── Events only the backend sees ──────────────────────────────────────────────


def _achievements_sandboxed(output_dir: Any = "") -> bool:
    """Whether an event in ``output_dir`` must not count towards the user's achievements.

    It counts only when it happened in one of the directories the store belongs to — the
    configured output or working directory. That rules out a tutorial's workspace, and
    anything else that happens to call these endpoints with a directory of its own.
    """
    if demo_genome.tutorial_session_workspace():
        return True
    text = str(output_dir or "").strip()
    if not text or TUTORIAL_WORKSPACE_DIR in Path(text).parts:
        return True
    try:
        target = Path(text).expanduser().resolve()
    except Exception:
        return True
    config = config_store.load_config()
    for key in ("output_dir", "working_dir"):
        configured = str(config.get(key) or "").strip()
        if not configured:
            continue
        try:
            if Path(configured).expanduser().resolve() == target:
                return False
        except Exception:
            continue
    return True


def _seed_achievements_from_inventory(doc: Dict[str, Any], config: Dict[str, Any]) -> bool:
    """Credit genomes already on disk, so existing users are not starting from nothing.

    Runs on every load rather than once, which is cheap (one manifest read per genome
    not yet recorded) and means a genome downloaded by an older version — or while the
    backend was not the one doing the downloading — is still counted.
    """
    output_dir = str(config.get("output_dir") or "").strip()
    if not output_dir:
        return False
    try:
        local_root = data_paths._resolve_local_data_root(output_dir)
    except Exception:
        return False
    if not local_root.is_dir():
        return False
    known = set(doc["distinct"].get("genome.downloaded", []))
    changed = False
    for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
        key = build_provider_aware_genome_key(species_key, assembly, provider)
        if not key or (key in known and key in doc["taxa"]):
            continue
        try:
            manifest = local_inventory._load_genome_manifest(asm_dir, assembly)
            if manifest.get("is_demo") or not local_inventory._is_download_managed_assembly(manifest, asm_dir, assembly):
                continue
            files = (local_inventory._scan_local_assembly(asm_dir, assembly, manifest).get("files") or {})
            if not (files.get("fasta") or files.get("gff3")):
                continue
            taxid = _achievement_genome_taxid(species_key, str(manifest.get("scientific_name") or ""), manifest, asm_dir)
            changed |= achievements_store.record_download(
                doc, key, taxid, assembly, str(manifest.get("assembly_name") or "")
            )
        except Exception as exc:
            logger.debug(f"Achievements: skipped {asm_dir}: {exc}")
    return changed


def _record_download_achievement(request: "DownloadRequest") -> None:
    """Called once a download task completes. Never allowed to fail the download."""
    try:
        if (request.file_type or "") not in _ACHIEVEMENT_GENOME_FILE_TYPES:
            return
        if _achievements_sandboxed(request.output_dir):
            return
        provider = normalize_provider(request.provider)
        key = build_provider_aware_genome_key(request.species_key, request.assembly, provider)
        if not key:
            return
        try:
            asm_dir = data_paths._resolve_species_assembly_dir(request.output_dir, request.species_key, request.assembly, provider=provider)
            manifest = local_inventory._load_genome_manifest(asm_dir, request.assembly)
        except Exception:
            asm_dir, manifest = None, {}
        taxid = int(request.taxid or 0) if _achievement_lineage_known(int(request.taxid or 0)) else 0
        if not taxid:
            taxid = _achievement_genome_taxid(request.species_key, request.scientific_name, manifest, asm_dir)
        assembly_name = request.assembly_name or str(manifest.get("assembly_name") or "")
        _mutate_achievements(
            lambda doc: achievements_store.record_download(doc, key, taxid, request.assembly, assembly_name)
        )
    except Exception as exc:
        logger.warning(f"Achievements: could not record download: {exc}")


def _record_deletion_achievement(genome_key: str, output_dir: Any = "") -> None:
    try:
        if not genome_key or _achievements_sandboxed(output_dir):
            return
        _mutate_achievements(lambda doc: achievements_store.record_deletion(doc, genome_key))
    except Exception as exc:
        logger.warning(f"Achievements: could not record deletion: {exc}")


# ── Endpoints ─────────────────────────────────────────────────────────────────


class AchievementsSyncRequest(BaseModel):
    delta: Dict[str, Any] = {}


def _achievements_response(doc: Dict[str, Any], readonly: bool) -> Dict[str, Any]:
    return {
        "store": doc,
        "readonly": readonly,
        "lineage_taxa": _achievement_lineage_taxa(doc),
    }


@router.get("/api/achievements")
async def get_achievements():
    def _work():
        config = config_store.load_config()
        doc, readonly = _mutate_achievements(lambda d: _seed_achievements_from_inventory(d, config), config)
        return _achievements_response(doc, readonly)

    return await run_in_threadpool(_work)


@router.post("/api/achievements/sync")
async def sync_achievements(request: AchievementsSyncRequest):
    """Fold a batch of progress from the frontend into the store and return the result."""
    def _work():
        doc, readonly = _mutate_achievements(lambda d: achievements_store.apply_delta(d, request.delta))
        return _achievements_response(doc, readonly)

    return await run_in_threadpool(_work)


@router.post("/api/achievements/reset")
async def reset_achievements():
    """Start again, keeping a timestamped copy of every store first.

    Every copy is rewritten, not just the primary one: loading merges them all, so a
    reset that left one behind would bring everything straight back. Genomes already on
    disk are credited again at once — they are still downloaded — and the frontend
    re-derives whatever else is still true (notes, playlists, colours) the same way.
    """
    def _work():
        config = config_store.load_config()
        with _achievements_lock:
            doc, readonly = _load_achievements(config)
            if readonly:
                raise HTTPException(
                    status_code=409,
                    detail="Achievements were saved by a newer version of Ensembl Go and cannot be reset here.",
                )
            paths = _achievement_store_paths(config)
            existing = [path for path in paths if path.exists()]
            backups = [str(copy_path) for copy_path in (achievements_store.backup_copy(path) for path in existing) if copy_path]
            fresh = achievements_store.reset_store(doc)
            for path in {str(p): p for p in existing + [paths[0]]}.values():
                achievements_store.write_store(path, fresh, backup=False)
        doc, readonly = _mutate_achievements(lambda d: _seed_achievements_from_inventory(d, config), config)
        return {**_achievements_response(doc, readonly), "backup_paths": backups}

    return await run_in_threadpool(_work)
