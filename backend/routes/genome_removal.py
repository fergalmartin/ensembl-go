"""Removing genomes: checking which local files exist, deleting single files or a
genome's downloaded files, and planning and carrying out the removal of a genome from
the configuration and disk (with a preview of what will go).
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import app_state
import config_store
import data_paths
import gff_index
import local_inventory
import removal_rules
import routes.achievements
import routes.downloads
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    genome_manifest_filename,
    legacy_genome_key,
    normalize_provider,
    strip_dataset_release_from_selection_key,
)
from security_utils import require_path_within

router = APIRouter()


@router.get("/api/remote/local-files")
def check_local_files(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
    dataset_release_key: str = "",
):
    """Check which file types already exist in local_data for a species/assembly."""
    local_dir = data_paths._resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
    found: List[str] = []
    scanned: Dict[str, Any] = {}
    if local_dir.is_dir():
        scanned = local_inventory._scan_local_assembly(local_dir, assembly)
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


class DeleteLocalFilesRequest(BaseModel):
    output_dir: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    dataset_release_key: str = ""


@router.delete("/api/remote/local-files")
def delete_local_files(request: DeleteLocalFilesRequest):
    """Delete downloaded local files for a species/assembly."""
    provider = normalize_provider(request.provider)
    asm_dir = data_paths._resolve_species_assembly_dir(request.output_dir, request.species_key, request.assembly, provider=provider)
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")
    manifest = local_inventory._load_genome_manifest(asm_dir, request.assembly)
    local_root = data_paths._resolve_local_data_root(request.output_dir)
    if request.dataset_release_key:
        source, date, release_key = routes.downloads._dataset_release_parts(
            provider,
            "gff3",
            release_key=request.dataset_release_key,
        )
        release_dir = asm_dir / "datasets" / source / date
        legacy_release = release_key == local_inventory.LEGACY_DATASET_RELEASE_KEY
        deletable, user_supplied = local_inventory._downloaded_assembly_files(
            asm_dir,
            request.assembly,
            manifest,
            release_dir=None if legacy_release else release_dir,
            legacy_release=legacy_release,
            dataset_release_key=release_key,
        )
        if not deletable:
            if user_supplied:
                raise HTTPException(status_code=400, detail=local_inventory._CUSTOM_FILES_DELETE_DETAIL)
            if not release_dir.is_dir():
                raise HTTPException(status_code=404, detail="Dataset release directory not found")
        deleted_count = routes.downloads._unlink_files(deletable)
        releases = manifest.get("dataset_releases")
        if isinstance(releases, dict):
            releases.pop(release_key, None)
            if manifest.get("active_dataset_release_key") == release_key:
                manifest["active_dataset_release_key"] = next(iter(releases.keys()), "")
            routes.downloads._write_genome_manifest(asm_dir, manifest)
        routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
        return {"status": "deleted", "species_key": request.species_key, "assembly": request.assembly, "dataset_release_key": release_key, "deleted_files": deleted_count}

    deletable, user_supplied = local_inventory._downloaded_assembly_files(asm_dir, request.assembly, manifest)
    if not deletable:
        if user_supplied:
            raise HTTPException(status_code=400, detail=local_inventory._CUSTOM_FILES_DELETE_DETAIL)
        raise HTTPException(status_code=404, detail="No downloaded files found for this assembly")
    deleted_count = routes.downloads._unlink_files(deletable)
    # The manifest describes what is left; drop it only when nothing is.
    manifest_path = asm_dir / genome_manifest_filename(request.assembly)
    if manifest_path.exists() and not user_supplied:
        try:
            manifest_path.unlink()
        except Exception:
            pass
    routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
    # Remove stale download task history for this species/assembly so UI does not
    # continue showing old completed/failed badges after files were deleted.
    remove_task_ids = [
        task_id
        for task_id, task in list(app_state.download_manager.tasks.items())
        if str(task.species_key or "") == str(request.species_key or "")
        and str(task.assembly or "") == str(request.assembly or "")
        and normalize_provider(task.provider) == provider
    ]
    for task_id in remove_task_ids:
        app_state.download_manager.tasks.pop(task_id, None)
    routes.achievements._record_deletion_achievement(
        build_provider_aware_genome_key(request.species_key, request.assembly, provider),
        request.output_dir,
    )
    return {"status": "deleted", "species_key": request.species_key, "assembly": request.assembly, "deleted_files": deleted_count}


class DeleteSingleFileRequest(BaseModel):
    file_path: str
    output_dir: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER


@router.delete("/api/remote/local-file")
async def delete_single_local_file(request: DeleteSingleFileRequest):
    """Delete a single local file from a managed species/assembly directory."""
    asm_dir = data_paths._resolve_species_assembly_dir(
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
    cfg = config if isinstance(config, dict) else config_store.load_config()
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
        asm_dir = data_paths._resolve_species_assembly_dir(
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

    manifest = local_inventory._load_genome_manifest(asm_dir, descriptor.assembly)
    deletable, user_supplied = local_inventory._downloaded_assembly_files(asm_dir, descriptor.assembly, manifest)
    for path in deletable:
        plan.add(path, "downloaded")

    # A custom annotation import copies the user's file into the managed
    # directory and records where it came from. The copy is ours to delete; the
    # original never is, so it is named here rather than silently kept.
    custom_sources = {
        str(record.get("source_path") or "").strip()
        for record in local_inventory._download_manifest_file_records(manifest)
        if str(record.get("source_path") or "").strip()
    }
    for path in user_supplied:
        parts = path.relative_to(asm_dir).parts
        if parts[:2] == ("datasets", "custom"):
            plan.add(path, "app_copy")
        else:
            plan.protect(path, local_inventory._CUSTOM_FILES_DELETE_DETAIL)
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
            cache_root=app_paths.CACHE_DIR,
            foreign_seeds=foreign_seeds,
            index_basename=gff_index._index_basename_for_annotation(gff_path) if gff_path else "genome.gff3.index.db",
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
    config = config_store.load_config()
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


@router.post("/api/genomes/removal-preview")
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


@router.post("/api/genomes/remove-data")
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

        config = config_store.load_config()
        output_dir = str(request.output_dir or config.get("output_dir") or "").strip()
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None

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
                asm_dir = data_paths._resolve_species_assembly_dir(
                    output_dir,
                    descriptor.species_key,
                    descriptor.assembly,
                    provider=normalize_provider(descriptor.provider),
                )
                if local_root is not None and asm_dir.is_dir():
                    routes.downloads._prune_empty_download_dirs(asm_dir, local_root)
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
            if status in {"deleted", "partial"} and not descriptor.is_manual:
                routes.achievements._record_deletion_achievement(
                    build_provider_aware_genome_key(descriptor.species_key, descriptor.assembly, descriptor.provider)
                    or plan.genome_key or descriptor.genome_key,
                    output_dir,
                )
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
        for task_id, task in list(app_state.download_manager.tasks.items()):
            key = (str(task.species_key or ""), str(task.assembly or ""), normalize_provider(task.provider))
            if key in removed_pairs:
                app_state.download_manager.tasks.pop(task_id, None)

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
