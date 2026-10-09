"""Genome downloads: resolving where a file goes (provider, species, assembly and dataset
release), writing download manifests, starting and cancelling download tasks,
importing a custom annotation, choosing a default dataset release, and warming
assembly metadata after a download.
"""

import asyncio
import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import app_state
import data_paths
import local_inventory
import routes.achievements
from annotation import convert_annotation, IdentifierError
from download_manager import DownloadTask
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_manifest_filename,
    NCBI_PROVIDER,
    normalize_provider,
    normalize_source_database,
)
from stats_utils import fetch_ena_metadata, now_iso

router = APIRouter()


_ENSEMBL_HOST = "ftp.ebi.ac.uk"


_ENSEMBL_PATH_PREFIX = "/pub/ensemblorganisms/"


_NCBI_FTP_HOST = "ftp.ncbi.nlm.nih.gov"


_NCBI_API_HOST = "api.ncbi.nlm.nih.gov"


_NCBI_ASSEMBLY_REPORT_RE = re.compile(
    r"^/genomes/all/GCA/(?:\d{3}/)+GCA_\d+\.\d+_[^/]+/GCA_\d+\.\d+_[^/]+_assembly_report\.txt$"
)


class DownloadRequest(BaseModel):
    url: str
    filename: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    file_type: Optional[str] = None
    output_dir: str
    scientific_name: str = ""
    common_name: str = ""
    display_name: str = ""
    display_name_reason: str = ""
    assembly_name: str = ""
    source_database: str = ""
    equivalent_accessions: List[str] = []
    dataset_release_key: str = ""
    dataset_release_source: str = ""
    dataset_release_date: str = ""
    dataset_release_label: str = ""
    # The species' NCBI taxid, when the catalogue the download came from knows it.
    # Kept in the genome manifest so that anything asking what organism this is later
    # (the Achievements view, for one) need not go back to the catalogue.
    taxid: int = 0
    force: bool = False


class CancelDownloadRequest(BaseModel):
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    file_types: List[str] = []
    filenames: List[str] = []


class CustomAnnotationRequest(BaseModel):
    output_dir: str
    provider: str = DEFAULT_PROVIDER
    species_key: str
    assembly: str
    gff3_path: str
    label: str = ""
    #: Normalise the file into canonical Ensembl-style GFF3 before registering
    #: it. Required for GTF and for any file whose gene model needs repair; the
    #: original is copied alongside and kept as `source_path` in the manifest.
    convert: bool = False
    id_mode: str = "keep"
    id_prefix: str = ""
    #: Enables the sequence-region cross-checks during conversion.
    fasta_path: str = ""


class DatasetDefaultRequest(BaseModel):
    output_dir: str
    provider: str = DEFAULT_PROVIDER
    species_key: str
    assembly: str
    dataset_release_key: str


# Formats accepted when a user imports their own annotation. GTF is only usable
# after conversion, which is enforced in import_custom_annotation.
GTF_IMPORT_SUFFIXES = (".gtf", ".gtf.gz", ".gtf.bgz", ".gff2", ".gff2.gz")


ANNOTATION_IMPORT_SUFFIXES = local_inventory.GFF3_DOWNLOAD_SUFFIXES + GTF_IMPORT_SUFFIXES


DEFAULT_NCBI_DATASET_RELEASE_KEY = "ncbi/current"


_ENSEMBL_DATASET_RELEASE_PATH_RE = re.compile(
    r"/(?:GCA|GCF)/(?:\d{3}/){3}\d+/([^/]+)/([^/]+)/",
    flags=re.IGNORECASE,
)


def _safe_dataset_segment(value: str, fallback: str) -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._-")
    return token or fallback


def _dataset_release_parts(
    provider: str,
    file_type: Optional[str],
    release_key: str = "",
    release_source: str = "",
    release_date: str = "",
) -> Tuple[str, str, str]:
    normalized_provider = normalize_provider(provider)
    if file_type in local_inventory.ASSEMBLY_SCOPED_FILE_TYPES:
        return "", "", ""
    if release_key:
        parts = [part for part in str(release_key or "").split("/") if part]
        if len(parts) >= 2:
            return (
                _safe_dataset_segment(parts[0], "ensembl"),
                _safe_dataset_segment("/".join(parts[1:]), "unknown"),
                f"{_safe_dataset_segment(parts[0], 'ensembl')}/{_safe_dataset_segment('/'.join(parts[1:]), 'unknown')}",
            )
    if release_source or release_date:
        source = _safe_dataset_segment(release_source, normalized_provider if normalized_provider == NCBI_PROVIDER else "ensembl")
        date = _safe_dataset_segment(release_date, "current" if normalized_provider == NCBI_PROVIDER else "unknown")
        return source, date, f"{source}/{date}"
    if normalized_provider == NCBI_PROVIDER:
        return "ncbi", "current", DEFAULT_NCBI_DATASET_RELEASE_KEY
    return "legacy", "unknown", local_inventory.LEGACY_DATASET_RELEASE_KEY


def _infer_dataset_release_from_download_url(
    url: str,
    provider: str,
    file_type: Optional[str],
) -> Tuple[str, str, str]:
    """Recover release provenance from managed download URLs.

    Ensembl organism paths encode the provider and release date directly after
    the accession/version path, e.g. ``.../GCA/018/472/595/2/ensembl/2024_10/``.
    This is a defensive fallback for older clients that omitted release fields.
    """
    normalized_provider = normalize_provider(provider)
    if _download_scope_for_type(file_type) == "assembly":
        return "", "", ""
    if normalized_provider == NCBI_PROVIDER:
        return "ncbi", "current", DEFAULT_NCBI_DATASET_RELEASE_KEY
    try:
        parsed = urlparse(str(url or "").strip())
        if (parsed.hostname or "").lower() != _ENSEMBL_HOST:
            return "", "", ""
        match = _ENSEMBL_DATASET_RELEASE_PATH_RE.search(unquote(parsed.path or ""))
    except Exception:
        return "", "", ""
    if not match:
        return "", "", ""
    source = _safe_dataset_segment(match.group(1), "ensembl")
    date = _safe_dataset_segment(match.group(2), "unknown")
    if not source or not date or date == "unknown":
        return "", "", ""
    return source, date, f"{source}/{date}"


def _download_scope_for_type(file_type: Optional[str]) -> str:
    return "assembly" if str(file_type or "") in local_inventory.ASSEMBLY_SCOPED_FILE_TYPES else "dataset"


def _resolve_download_dir(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str,
    file_type: Optional[str],
    dataset_release_key: str = "",
    dataset_release_source: str = "",
    dataset_release_date: str = "",
) -> Tuple[Path, Path, str, str, str]:
    asm_dir = data_paths._resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
    if _download_scope_for_type(file_type) == "assembly":
        return asm_dir, asm_dir / "assembly", "", "", ""
    source, date, release_key = _dataset_release_parts(
        provider,
        file_type,
        release_key=dataset_release_key,
        release_source=dataset_release_source,
        release_date=dataset_release_date,
    )
    return asm_dir, asm_dir / "datasets" / source / date, source, date, release_key


def _gca_prefixed_filename(filename: str, assembly: str, file_type: Optional[str]) -> str:
    """Prefix downloaded files with the assembly accession for clarity."""
    if file_type == "fasta" and filename in ("unmasked.fa.gz", "softmasked.fa.gz", "unmasked.fa.bgz", "softmasked.fa.bgz"):
        return f"{assembly}.{filename}"
    if file_type == "gff3" and filename in ("genes.gff3.gz", "genes.gff3.bgz"):
        return f"{assembly}.gff3{Path(filename).suffix}"
    if file_type == "metadata" and data_paths._is_assembly_report_filename(filename):
        return f"{assembly}.assembly_report.txt"
    return f"{assembly}.{filename}" if not filename.startswith(assembly) else filename


def _write_genome_manifest(assembly_dir: Path, payload: Dict[str, Any]):
    manifest_path = assembly_dir / genome_manifest_filename(payload.get("assembly"))
    manifest_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _unlink_files(paths: Iterable[Path]) -> int:
    deleted = 0
    for path in paths:
        try:
            if path.is_file():
                path.unlink()
                deleted += 1
        except Exception:
            continue
    return deleted


def _prune_empty_download_dirs(asm_dir: Path, stop_dir: Path) -> None:
    if not asm_dir.exists():
        return
    for directory in sorted(
        [p for p in asm_dir.rglob("*") if p.is_dir()],
        key=lambda p: len(p.parts),
        reverse=True,
    ):
        try:
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        except Exception:
            pass
    current = asm_dir
    while current != stop_dir and current.exists():
        try:
            if any(current.iterdir()):
                break
            parent = current.parent
            current.rmdir()
            current = parent
        except Exception:
            break


def _merge_download_manifest(
    assembly_dir: Path,
    request: DownloadRequest,
    provider: str,
    destination: Path,
    local_filename: str,
    release_source: str,
    release_date: str,
    release_key: str,
) -> None:
    now = datetime.utcnow().isoformat() + "Z"
    manifest = local_inventory._load_genome_manifest(assembly_dir, request.assembly)
    manifest.update({
        "manifest_version": local_inventory.LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "source_database": normalize_source_database(request.source_database, provider, request.assembly),
        "species_key": request.species_key,
        "assembly": request.assembly,
        "assembly_name": request.assembly_name or request.assembly,
        "scientific_name": request.scientific_name,
        "common_name": request.common_name,
        "display_name": request.display_name,
        "display_name_reason": request.display_name_reason,
        "gca": request.assembly if str(request.assembly or "").upper().startswith("GC") else "",
        "equivalent_accessions": [str(v).strip() for v in (request.equivalent_accessions or []) if str(v).strip()],
        "updated_at": now,
    })
    if int(request.taxid or 0) > 0:
        manifest["taxid"] = int(request.taxid)
    manifest.setdefault("assembly_files", {})
    manifest.setdefault("dataset_releases", {})
    file_record = {
        "type": request.file_type or "",
        "filename": local_filename,
        "path": str(destination),
        "url": request.url,
        "downloaded_at": now,
    }
    if _download_scope_for_type(request.file_type) == "assembly":
        manifest["assembly_files"][request.file_type or "other"] = file_record
    else:
        release_key = release_key or local_inventory.LEGACY_DATASET_RELEASE_KEY
        release = manifest["dataset_releases"].setdefault(release_key, {
            "key": release_key,
            "source": release_source or "legacy",
            "date": release_date or "unknown",
            "label": local_inventory._release_label(release_source or "legacy", release_date or "unknown", request.dataset_release_label),
            "files": {},
            "created_at": now,
        })
        release.update({
            "key": release_key,
            "source": release_source or release.get("source") or "legacy",
            "date": release_date or release.get("date") or "unknown",
            "label": local_inventory._release_label(release_source or release.get("source") or "legacy", release_date or release.get("date") or "unknown", request.dataset_release_label or release.get("label") or ""),
            "updated_at": now,
        })
        release.setdefault("files", {})
        file_key = request.file_type or "other"
        if request.file_type == "alignment":
            file_key = f"alignment::{local_filename}"
        release["files"][file_key] = file_record
        manifest["active_dataset_release_key"] = release_key
    _write_genome_manifest(assembly_dir, manifest)


async def _download_then_warm_assembly_metadata(
    url: str,
    dest: Path,
    task_id: str,
    accessions: List[str],
    request: Optional["DownloadRequest"] = None,
) -> None:
    """Run a download, then fetch the registry metadata for what was downloaded.

    Assembly metadata is a small, static record, but fetching it takes a network
    round trip. Doing it here means it is already in the cache by the time the
    user opens a genome's overview, rather than being the one thing they wait on.
    Entirely best-effort: nothing here can fail a download.
    """
    await app_state.download_manager.download_file(url, dest, task_id)
    task = app_state.download_manager.tasks.get(task_id)
    if not task or str(getattr(task, "status", "")) != "completed":
        return
    if request is not None:
        await run_in_threadpool(routes.achievements._record_download_achievement, request)
    try:
        await run_in_threadpool(_warm_assembly_metadata, accessions)
    except Exception:
        pass


def _warm_assembly_metadata(accessions: List[str]) -> None:
    for accession in accessions:
        token = str(accession or "").strip()
        if not token:
            continue
        try:
            if fetch_ena_metadata(token, app_paths._ENA_METADATA_CACHE_PATH).get("status") == "ready":
                return
        except Exception:
            continue


@router.post("/api/remote/download")
async def start_download(request: DownloadRequest):
    """Start a background download task.

    The preparation is all blocking work in the output directory — resolving the
    destination, creating it, and reading and rewriting the genome manifest, twice over
    when a metadata file comes along — and the Download view fires one of these per file
    per genome, so a batch put that on the event loop many times over. It runs on a
    worker thread now. Only the spawning stays here, because ``asyncio.create_task``
    needs the running loop.
    """
    response, spawns = await run_in_threadpool(_prepare_download, request)
    for url, dest, spawn_task_id, warm_accessions in spawns:
        asyncio.create_task(
            _download_then_warm_assembly_metadata(url, dest, spawn_task_id, warm_accessions, request)
        )
    return response


def _download_task_names(request: DownloadRequest) -> Dict[str, str]:
    """The names a task carries so the active-downloads lists can label it."""
    return {
        "scientific_name": str(request.scientific_name or ""),
        "common_name": str(request.common_name or ""),
        "display_name": str(request.display_name or ""),
        "assembly_name": str(request.assembly_name or ""),
        "source_database": str(request.source_database or ""),
        "created_at": now_iso(),
    }


def _prepare_download(
    request: DownloadRequest,
) -> Tuple[Dict[str, Any], List[Tuple[str, Path, str, List[str]]]]:
    """Do everything ``start_download`` needs off the event loop.

    Returns the response body and the downloads the caller should spawn, as
    ``(url, destination, task_id, accessions to warm)``.
    """
    import uuid
    spawns: List[Tuple[str, Path, str, List[str]]] = []
    task_id = str(uuid.uuid4())
    data_paths._validate_download_url(request.url)
    provider = normalize_provider(request.provider)
    # Rename file with GCA prefix
    local_filename = data_paths._sanitize_filename(
        _gca_prefixed_filename(request.filename, request.assembly, request.file_type)
    )
    requested_release_key = str(request.dataset_release_key or "").strip()
    requested_release_source = str(request.dataset_release_source or "").strip()
    requested_release_date = str(request.dataset_release_date or "").strip()
    if not requested_release_key or requested_release_key == local_inventory.LEGACY_DATASET_RELEASE_KEY:
        inferred_source, inferred_date, inferred_key = _infer_dataset_release_from_download_url(
            request.url,
            provider,
            request.file_type,
        )
        if inferred_key:
            requested_release_key = inferred_key
            requested_release_source = inferred_source
            requested_release_date = inferred_date
            request = request.model_copy(update={
                "dataset_release_key": inferred_key,
                "dataset_release_source": inferred_source,
                "dataset_release_date": inferred_date,
                "dataset_release_label": local_inventory._release_label(inferred_source, inferred_date),
            })
    asm_dir, dest_dir, release_source, release_date, release_key = _resolve_download_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider,
        request.file_type,
        dataset_release_key=requested_release_key,
        dataset_release_source=requested_release_source,
        dataset_release_date=requested_release_date,
    )
    dest = dest_dir / local_filename

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        _merge_download_manifest(asm_dir, request, provider, dest, local_filename, release_source, release_date, release_key)
    except Exception:
        pass

    if dest.exists() and not request.force:
        try:
            if dest.stat().st_size > 0:
                return {"task_id": "", "status": "already_exists"}, spawns
        except Exception:
            pass

    for existing in app_state.download_manager.tasks.values():
        if request.force:
            continue
        if existing.destination == str(dest) and existing.status in {"pending", "downloading", "completed"}:
            return {"task_id": existing.id, "status": existing.status}, spawns

    task = DownloadTask(
        id=task_id,
        filename=local_filename,
        url=request.url,
        species_key=request.species_key,
        assembly=request.assembly,
        provider=provider,
        file_type=request.file_type,
        dataset_release_key=release_key,
        dataset_release_source=release_source,
        dataset_release_date=release_date,
        dataset_release_label=request.dataset_release_label or local_inventory._release_label(release_source, release_date),
        **_download_task_names(request),
        status="pending",
        destination=str(dest),
    )
    app_state.download_manager.tasks[task_id] = task
    warm_accessions = [request.assembly] + [
        str(v).strip() for v in (request.equivalent_accessions or []) if str(v).strip()
    ]
    spawns.append((request.url, dest, task_id, warm_accessions))

    # Auto-fetch metadata when core genome files are requested.
    if request.file_type in {"fasta", "gff3"}:
        try:
            metadata_files = app_state.download_manager.get_download_urls(
                request.species_key,
                request.assembly,
                file_types=["metadata"],
                provider=provider,
            )
            if metadata_files:
                metadata_file = metadata_files[0]
                metadata_filename = data_paths._sanitize_filename(
                    _gca_prefixed_filename(metadata_file.filename, request.assembly, "metadata")
                )
                metadata_dir = asm_dir / "assembly"
                metadata_dest = metadata_dir / metadata_filename

                already_tracked = any(
                    (
                        t.species_key == request.species_key
                        and t.assembly == request.assembly
                        and t.file_type == "metadata"
                        and t.status in {"pending", "downloading", "completed"}
                    )
                    for t in app_state.download_manager.tasks.values()
                )

                if not metadata_dest.exists() and not already_tracked:
                    metadata_task_id = str(uuid.uuid4())
                    metadata_dir.mkdir(parents=True, exist_ok=True)
                    metadata_request = request.model_copy(update={
                        "url": metadata_file.url,
                        "filename": metadata_file.filename,
                        "file_type": "metadata",
                        "dataset_release_key": "",
                        "dataset_release_source": "",
                        "dataset_release_date": "",
                        "dataset_release_label": "",
                    })
                    try:
                        _merge_download_manifest(asm_dir, metadata_request, provider, metadata_dest, metadata_filename, "", "", "")
                    except Exception:
                        pass
                    metadata_task = DownloadTask(
                        id=metadata_task_id,
                        filename=metadata_filename,
                        url=metadata_file.url,
                        species_key=request.species_key,
                        assembly=request.assembly,
                        provider=provider,
                        file_type="metadata",
                        dataset_release_key="",
                        dataset_release_source="",
                        dataset_release_date="",
                        dataset_release_label="",
                        **_download_task_names(request),
                        status="pending",
                        destination=str(metadata_dest),
                    )
                    app_state.download_manager.tasks[metadata_task_id] = metadata_task
                    spawns.append(
                        (metadata_file.url, metadata_dest, metadata_task_id, warm_accessions)
                    )
        except Exception:
            # Metadata is best-effort and must never block requested downloads.
            pass

    return {"task_id": task_id, "status": "started"}, spawns


@router.post("/api/remote/custom-annotation")
async def import_custom_annotation(request: CustomAnnotationRequest):
    """Copy a user-provided GFF3 into an existing assembly as a managed dataset release."""
    provider = normalize_provider(request.provider)
    asm_dir = data_paths._resolve_species_assembly_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider=provider,
    )
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")

    source = Path(request.gff3_path).expanduser().resolve()
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Custom annotation file not found")
    if not local_inventory._has_any_suffix(source.name.lower(), ANNOTATION_IMPORT_SUFFIXES):
        raise HTTPException(
            status_code=400,
            detail="Custom annotation must be a GFF3, GFF or GTF file",
        )
    needs_conversion = local_inventory._has_any_suffix(source.name.lower(), GTF_IMPORT_SUFFIXES)
    if needs_conversion and not request.convert:
        raise HTTPException(
            status_code=400,
            detail=(
                "GTF cannot be indexed directly. Re-run this import with "
                "conversion enabled to normalise it into GFF3 first."
            ),
        )

    fasta_for_conversion = ""
    if request.convert and request.fasta_path:
        fasta_for_conversion = str(data_paths._resolve_user_file(request.fasta_path, "FASTA"))

    today = datetime.utcnow().date().isoformat()
    label = str(request.label or "").strip() or f"custom {today}"
    if not label.lower().startswith("custom"):
        display_label = label
    else:
        display_label = label
    safe_base = _safe_dataset_segment(display_label.lower().replace(" ", "_"), f"custom_{today}")
    manifest = local_inventory._load_genome_manifest(asm_dir, request.assembly)
    releases = manifest.setdefault("dataset_releases", {})
    suffix = 1
    safe_label = safe_base
    release_key = f"custom/{safe_label}"
    while release_key in releases or (asm_dir / "datasets" / "custom" / safe_label).exists():
        suffix += 1
        safe_label = f"{safe_base}_{suffix}"
        release_key = f"custom/{safe_label}"

    dest_dir = asm_dir / "datasets" / "custom" / safe_label
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_filename = data_paths._sanitize_filename(_gca_prefixed_filename(source.name, request.assembly, "gff3"))
    dest = dest_dir / dest_filename
    conversion_summary: Dict[str, Any] = {}

    if request.convert:
        # Normalise into canonical GFF3 and register that. The original is copied
        # alongside untouched so the import is always traceable back to its input.
        try:
            conversion = await run_in_threadpool(
                convert_annotation,
                str(source),
                str(dest_dir),
                fasta_for_conversion or None,
                request.id_mode or "keep",
                request.id_prefix or "",
            )
        except IdentifierError as exc:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise HTTPException(
                status_code=500, detail=f"Failed to convert custom annotation: {exc}"
            )

        dest = Path(conversion.output_path)
        dest_filename = dest.name
        original_copy = dest_dir / data_paths._sanitize_filename("source_" + source.name)
        try:
            if source.resolve() != original_copy.resolve():
                shutil.copy2(source, original_copy)
        except Exception:
            # The converted file is what matters; keeping the original is a
            # convenience, not a precondition for the import to succeed.
            original_copy = None
        conversion_summary = {
            "converted": True,
            "dialect": (conversion.report.dialect if conversion.report else ""),
            "producer": (conversion.report.producer_guess if conversion.report else ""),
            "gene_count": conversion.gene_count,
            "transcript_count": conversion.transcript_count,
            "exon_count": conversion.exon_count,
            "coding_transcript_count": conversion.coding_transcript_count,
            "id_mode": conversion.id_mode,
            "id_prefix": conversion.id_prefix,
            "id_map_path": conversion.id_map_path,
            "original_path": str(original_copy) if original_copy else "",
            "report": conversion.report.as_dict() if conversion.report else {},
        }
    else:
        try:
            if source.resolve() != dest.resolve():
                shutil.copy2(source, dest)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to copy custom annotation: {exc}")

    now = datetime.utcnow().isoformat() + "Z"
    manifest.update({
        "manifest_version": local_inventory.LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "species_key": request.species_key,
        "assembly": request.assembly,
        "assembly_name": manifest.get("assembly_name") or request.assembly,
        "gca": request.assembly if str(request.assembly or "").upper().startswith("GC") else manifest.get("gca", ""),
        "updated_at": now,
    })
    manifest.setdefault("assembly_files", {})
    releases[release_key] = {
        "key": release_key,
        "source": "custom",
        "date": display_label,
        "label": display_label,
        "files": {
            "gff3": {
                "type": "gff3",
                "filename": dest_filename,
                "path": str(dest),
                "url": "",
                "source_path": str(source),
                "downloaded_at": now,
            }
        },
        "created_at": now,
        "updated_at": now,
    }
    if conversion_summary:
        releases[release_key]["conversion"] = {
            key: value
            for key, value in conversion_summary.items()
            if key != "report"
        }
    _write_genome_manifest(asm_dir, manifest)

    refreshed = await run_in_threadpool(local_inventory.list_local_assemblies, request.output_dir)
    assembly_record = next(
        (
            item for item in refreshed
            if normalize_provider(item.get("provider")) == provider
            and str(item.get("species_key") or "") == str(request.species_key or "")
            and str(item.get("assembly") or "") == str(request.assembly or "")
        ),
        None,
    )
    created = None
    if assembly_record:
        created = next(
            (
                item for item in assembly_record.get("dataset_instances") or []
                if str(item.get("dataset_release_key") or "") == release_key
            ),
            None,
        )
    return {
        "status": "created",
        "dataset_release_key": release_key,
        "dataset_release_label": display_label,
        "path": str(dest),
        "dataset": created,
        "assembly": assembly_record,
        "conversion": conversion_summary,
    }


@router.post("/api/remote/dataset-default")
async def set_dataset_default(request: DatasetDefaultRequest):
    """Remember which annotation dataset should be the default for an assembly."""
    provider = normalize_provider(request.provider)
    release_key = str(request.dataset_release_key or "").strip()
    if not release_key:
        raise HTTPException(status_code=400, detail="dataset_release_key is required")

    asm_dir = data_paths._resolve_species_assembly_dir(
        request.output_dir,
        request.species_key,
        request.assembly,
        provider=provider,
    )
    if not asm_dir.is_dir():
        raise HTTPException(status_code=404, detail="Assembly directory not found")

    manifest = local_inventory._load_genome_manifest(asm_dir, request.assembly)
    scanned = local_inventory._scan_local_assembly(asm_dir, request.assembly, manifest)
    release = next(
        (entry for entry in scanned.get("dataset_releases") or [] if str(entry.get("key") or "") == release_key),
        None,
    )
    if not release:
        raise HTTPException(status_code=404, detail="Dataset release not found")
    if not (release.get("files") or {}).get("gff3"):
        raise HTTPException(status_code=400, detail="Dataset release does not have a GFF3 annotation")

    now = datetime.utcnow().isoformat() + "Z"
    manifest.update({
        "manifest_version": local_inventory.LOCAL_MANIFEST_VERSION,
        "provider": provider,
        "species_key": request.species_key,
        "assembly": request.assembly,
        "default_dataset_release_key": release_key,
        "active_dataset_release_key": release_key,
        "updated_at": now,
    })
    manifest.setdefault("assembly_files", {})
    manifest.setdefault("dataset_releases", {})
    _write_genome_manifest(asm_dir, manifest)

    refreshed = await run_in_threadpool(local_inventory.list_local_assemblies, request.output_dir)
    assembly_record = next(
        (
            item for item in refreshed
            if normalize_provider(item.get("provider")) == provider
            and str(item.get("species_key") or "") == str(request.species_key or "")
            and str(item.get("assembly") or "") == str(request.assembly or "")
        ),
        None,
    )
    dataset_record = None
    if assembly_record:
        dataset_record = next(
            (
                item for item in assembly_record.get("dataset_instances") or []
                if str(item.get("dataset_release_key") or "") == release_key
            ),
            None,
        )
    return {
        "status": "ok",
        "dataset_release_key": release_key,
        "dataset": dataset_record,
        "assembly": assembly_record,
    }


@router.post("/api/remote/download/cancel")
async def cancel_downloads(request: CancelDownloadRequest):
    """Cancel active download tasks for selected files in a species/assembly."""
    provider = normalize_provider(request.provider)
    requested_types = {
        str(value or "").strip()
        for value in (request.file_types or [])
        if str(value or "").strip()
    }
    file_types = set(requested_types)
    implicit_metadata = False
    if {"fasta", "gff3"} & file_types:
        implicit_metadata = "metadata" not in file_types
        file_types.add("metadata")
    filenames = {
        data_paths._sanitize_filename(str(value or "").strip())
        for value in (request.filenames or [])
        if str(value or "").strip()
    }
    canceled_task_ids: List[str] = []
    for task_id, task in list(app_state.download_manager.tasks.items()):
        if str(task.species_key or "") != str(request.species_key or ""):
            continue
        if str(task.assembly or "") != str(request.assembly or ""):
            continue
        if normalize_provider(task.provider) != provider:
            continue
        if str(task.status or "") not in {"pending", "downloading"}:
            continue
        task_type = str(task.file_type or "").strip()
        if file_types and task_type not in file_types:
            continue
        task_filename = data_paths._sanitize_filename(str(task.filename or "").strip())
        if filenames and task_type != "metadata" and task_filename and task_filename not in filenames:
            continue
        if filenames and task_type == "metadata" and not implicit_metadata and task_filename and task_filename not in filenames:
            continue
        _cancel_download_task(task)
        canceled_task_ids.append(task_id)
    return {
        "status": "canceled" if canceled_task_ids else "not_found",
        "task_ids": canceled_task_ids,
        "count": len(canceled_task_ids),
    }


def _cancel_download_task(task: DownloadTask) -> None:
    """Mark a task cancelled and remove whatever it has written so far.

    A running worker notices ``cancel_requested`` and stops; a queued one never
    starts.
    """
    task.cancel_requested = True
    task.status = "canceled"
    task.progress = 0.0
    task.error = None
    for raw_path in (
        task.current_download_path,
        str(Path(task.destination).with_suffix(Path(task.destination).suffix + ".tmp")) if task.destination else "",
    ):
        if not raw_path:
            continue
        try:
            path = Path(raw_path)
            if path.exists():
                path.unlink()
        except Exception:
            pass


def _cancel_download_tasks_by_id(task_ids: List[str], cancel_all: bool = False) -> List[str]:
    """Cancel the given in-progress tasks, or every one when ``cancel_all``.

    Cancelling a genome's FASTA or GFF3 also cancels the assembly metadata that was
    fetched alongside it, as the species-level cancel does; otherwise it would be
    left downloading for a genome the user has just abandoned.
    """
    active_statuses = {"pending", "downloading"}
    wanted = {str(value or "").strip() for value in (task_ids or []) if str(value or "").strip()}
    targets: Dict[str, DownloadTask] = {}
    for task_id, task in list(app_state.download_manager.tasks.items()):
        if str(task.status or "") not in active_statuses:
            continue
        if cancel_all or task_id in wanted:
            targets[task_id] = task

    core_genomes = {
        (str(task.species_key or ""), str(task.assembly or ""), normalize_provider(task.provider))
        for task in targets.values()
        if str(task.file_type or "") in {"fasta", "gff3"}
    }
    if core_genomes:
        for task_id, task in list(app_state.download_manager.tasks.items()):
            if task_id in targets or str(task.file_type or "") != "metadata":
                continue
            if str(task.status or "") not in active_statuses:
                continue
            genome = (str(task.species_key or ""), str(task.assembly or ""), normalize_provider(task.provider))
            if genome in core_genomes:
                targets[task_id] = task

    for task in targets.values():
        _cancel_download_task(task)
    return list(targets.keys())


class CancelDownloadTasksRequest(BaseModel):
    task_ids: List[str] = []
    all: bool = False


@router.post("/api/remote/tasks/cancel")
async def cancel_download_tasks(request: CancelDownloadTasksRequest):
    """Cancel download tasks by id, or every queued and running download."""
    canceled_task_ids = _cancel_download_tasks_by_id(request.task_ids, cancel_all=request.all)
    return {
        "status": "canceled" if canceled_task_ids else "not_found",
        "task_ids": canceled_task_ids,
        "count": len(canceled_task_ids),
    }


@router.get("/api/remote/tasks")
async def list_download_tasks():
    """List all download tasks."""
    return list(app_state.download_manager.tasks.values())
