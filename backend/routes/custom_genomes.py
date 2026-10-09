"""Custom genomes: validating a user's FASTA and annotation on a queued background
worker, converting and preparing annotations, reading and saving manual genome
configs, and the endpoints that build GFF indexes for one genome or many.
"""

import logging
import os
import queue
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import config_store
import data_paths
import file_io
import gff_index
from annotation import (
    build_annotation_report,
    convert_annotation,
    CooperativeYielder,
    IdentifierError,
    normalize_prefix as annotation_normalize_prefix,
    prepare_annotation,
    scan_fasta,
    sniff_annotation,
)
from manual_genome_config import parse_manual_genome_config, save_manual_genome_config
from security_utils import validate_config_export_path
from stats_utils import now_iso

logger = logging.getLogger(__name__)
router = APIRouter()


class IndexRequest(BaseModel):
    generate: bool = True
    output_dir: Optional[str] = None
    ref_gff: Optional[str] = None
    target_gff: Optional[str] = None


# In-memory task registry for custom genome/annotation validation scans. These
# read whole files, so they run on the same queued-worker pattern as indexing
# rather than blocking a request.
_validation_tasks_guard = threading.Lock()


_validation_tasks: Dict[str, Dict[str, Any]] = {}


_validation_task_queue: "queue.Queue[Tuple[str, Dict[str, Any]]]" = queue.Queue()


_validation_worker_guard = threading.Lock()


_validation_worker_started = False


#: Completed validation results are small; keep a bounded history so the UI can
#: re-open a report without re-scanning.
_VALIDATION_TASK_LIMIT = 50


class SingleIndexRequest(BaseModel):
    gff_path: str
    output_dir: Optional[str] = None
    index_path: Optional[str] = None


@router.post("/api/index/generate-for-genome")
def generate_index_for_genome(request: SingleIndexRequest):
    """Start a background GFF3 index build. Returns a task_id immediately.
    Poll GET /api/index/task-status/{task_id} for completion."""
    config = config_store.load_config()
    output_dir = request.output_dir or config.get("output_dir", "")

    if not request.gff_path or not os.path.exists(request.gff_path):
        raise HTTPException(status_code=400, detail=f"GFF3 file not found: {request.gff_path}")

    if request.index_path:
        target_index = Path(request.index_path).expanduser().resolve()
        target_parent = target_index.parent
        if not target_parent.exists():
            raise HTTPException(status_code=400, detail=f"Index directory does not exist: {target_parent}")
    else:
        if not output_dir or not os.path.exists(output_dir):
            raise HTTPException(status_code=400, detail="Output directory not set or does not exist.")
        fallback_name = gff_index._index_basename_for_annotation(request.gff_path)
        target_index = gff_index._resolve_index_path(request.gff_path, output_dir, fallback_name)

    task_id, status = gff_index.queue_index_build(request.gff_path, str(target_index))
    return {"task_id": task_id, "status": status}


@router.get("/api/index/task-status/{task_id}")
def index_task_status(task_id: str):
    """Poll status of a background index build started by /api/index/generate-for-genome."""
    with gff_index._index_tasks_guard:
        task = gff_index._index_tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {
        "task_id": task_id,
        "status": task["status"],
        "index_path": task.get("index_path"),
        "error": task.get("error"),
        "queued_at": task.get("queued_at"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
    }


# ── Custom genome / annotation validation ───────────────────────────────────
# These endpoints are read-only: they scan a user-supplied file and describe it.
# Nothing here writes to the assembly, and nothing here feeds the browsing index,
# which is still built by create_gff_index from the original file.

class ValidateGenomeRequest(BaseModel):
    fasta_path: str


class ValidateAnnotationRequest(BaseModel):
    annotation_path: str
    fasta_path: Optional[str] = None


def _update_validation_task(task_id: str, **updates: Any) -> None:
    with _validation_tasks_guard:
        task = _validation_tasks.get(task_id)
        if task is not None:
            task.update(updates)


def _trim_validation_tasks() -> None:
    """Drop the oldest finished tasks once the registry grows past its limit."""
    with _validation_tasks_guard:
        if len(_validation_tasks) <= _VALIDATION_TASK_LIMIT:
            return
        finished = [
            (task.get("completed_at") or "", task_id)
            for task_id, task in _validation_tasks.items()
            if task.get("status") in {"success", "failed"}
        ]
        finished.sort()
        for _, task_id in finished[: len(_validation_tasks) - _VALIDATION_TASK_LIMIT]:
            _validation_tasks.pop(task_id, None)


def _run_validation_task(task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    kind = str(payload.get("kind") or "")
    # The file-reading phases hand the interpreter back from inside their own
    # loops. The phases that work on what was read — building gene models,
    # summarising — have no such loop to hook, so they yield here, on the
    # progress reports they already make. See annotation/cooperative.py.
    yielder = CooperativeYielder()

    if kind == "genome":
        def _progress(read_bytes: int, total_bytes: int) -> None:
            yielder.tick()
            percent = (read_bytes / float(total_bytes) * 100.0) if total_bytes else 0.0
            # Name the stage as well as the percentage: without it the panel
            # keeps showing "Starting" for the several minutes a whole genome
            # takes to read, which reads as a stall rather than as progress.
            _update_validation_task(
                task_id,
                stage="scanning_genome",
                message="Reading genome sequences",
                progress=round(min(percent, 99.9), 1),
            )

        report = scan_fasta(str(payload["fasta_path"]), progress_callback=_progress)
        return report.as_dict()

    if kind == "prepare":
        def _prepare_progress(
            stage: str,
            progress: float,
            message: str,
            counters: Dict[str, int],
        ) -> None:
            yielder.tick()
            _update_validation_task(
                task_id,
                stage=stage,
                progress=round(max(0.0, min(float(progress), 99.9)), 1),
                message=message,
                counters=dict(counters or {}),
            )

        return prepare_annotation(
            str(payload["annotation_path"]),
            fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
            id_mode=str(payload.get("id_mode") or "keep"),
            id_prefix=str(payload.get("id_prefix") or ""),
            progress_callback=_prepare_progress,
        )

    if kind == "conversion":
        def _conversion_progress(
            stage: str,
            progress: float,
            message: str,
            counters: Dict[str, int],
        ) -> None:
            yielder.tick()
            _update_validation_task(
                task_id,
                stage=stage,
                progress=round(max(0.0, min(float(progress), 99.9)), 1),
                message=message,
                counters=dict(counters or {}),
            )

        result = convert_annotation(
            str(payload["annotation_path"]),
            str(payload["output_dir"]),
            fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
            id_mode=str(payload.get("id_mode") or "keep"),
            id_prefix=str(payload.get("id_prefix") or ""),
            compress=bool(payload.get("compress", True)),
            progress_callback=_conversion_progress,
        )
        return result.as_dict()

    def _annotation_progress(
        stage: str,
        progress: float,
        message: str,
        counters: Dict[str, int],
    ) -> None:
        yielder.tick()
        _update_validation_task(
            task_id,
            stage=stage,
            progress=round(max(0.0, min(float(progress), 99.9)), 1),
            message=message,
            counters=dict(counters or {}),
        )

    report = build_annotation_report(
        str(payload["annotation_path"]),
        fasta_path=str(payload["fasta_path"]) if payload.get("fasta_path") else None,
        progress_callback=_annotation_progress,
    )
    return report.as_dict()


def _validation_worker_loop() -> None:
    while True:
        task_id, payload = _validation_task_queue.get()
        try:
            _update_validation_task(
                task_id,
                status="running",
                stage="starting",
                message="Starting",
                started_at=now_iso(),
                error=None,
            )
            result = _run_validation_task(task_id, payload)
            _update_validation_task(
                task_id,
                status="success",
                report=result,
                progress=100.0,
                stage="complete",
                message="Complete",
                completed_at=now_iso(),
                error=None,
            )
        except Exception as exc:
            logger.error("Validation task %s failed: %s", task_id, exc)
            _update_validation_task(
                task_id, status="failed", error=str(exc), completed_at=now_iso()
            )
        finally:
            _validation_task_queue.task_done()
            _trim_validation_tasks()


def _ensure_validation_worker_started() -> None:
    global _validation_worker_started
    with _validation_worker_guard:
        if _validation_worker_started:
            return
        worker = threading.Thread(
            target=_validation_worker_loop, name="validation-worker", daemon=True
        )
        worker.start()
        _validation_worker_started = True


def _queue_validation(kind: str, payload: Dict[str, Any], target: str) -> Dict[str, str]:
    task_id = str(uuid.uuid4())
    with _validation_tasks_guard:
        _validation_tasks[task_id] = {
            "status": "queued",
            "kind": kind,
            "target": target,
            "progress": 0.0,
            "stage": "queued",
            "message": "Queued",
            "counters": {},
            "report": None,
            "error": None,
            "queued_at": now_iso(),
        }
    _ensure_validation_worker_started()
    _validation_task_queue.put((task_id, dict(payload, kind=kind)))
    return {"task_id": task_id, "status": "queued"}


@router.post("/api/custom/validate-genome")
async def validate_custom_genome(request: ValidateGenomeRequest):
    """Scan a FASTA and report its sequence and base composition statistics."""
    fasta_path = data_paths._resolve_user_file(request.fasta_path, "FASTA")
    return _queue_validation("genome", {"fasta_path": str(fasta_path)}, str(fasta_path))


@router.post("/api/custom/validate-annotation")
async def validate_custom_annotation(request: ValidateAnnotationRequest):
    """Parse an annotation file and report what can be modelled from it.

    Accepts GFF3, GTF and AUGUSTUS-native output. Passing ``fasta_path`` enables
    the sequence-region cross-checks, which is where most silent failures live.
    """
    annotation_path = data_paths._resolve_user_file(request.annotation_path, "Annotation")
    payload: Dict[str, Any] = {"annotation_path": str(annotation_path)}
    if request.fasta_path:
        payload["fasta_path"] = str(data_paths._resolve_user_file(request.fasta_path, "FASTA"))
    return _queue_validation("annotation", payload, str(annotation_path))


@router.get("/api/custom/validation/{task_id}")
def custom_validation_status(task_id: str):
    """Poll a validation task; the report is included once the status is success."""
    with _validation_tasks_guard:
        task = _validation_tasks.get(task_id)
        snapshot = dict(task) if task is not None else None
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Validation task not found")
    return {
        "task_id": task_id,
        "status": snapshot.get("status"),
        "kind": snapshot.get("kind"),
        "target": snapshot.get("target"),
        "progress": snapshot.get("progress"),
        "stage": snapshot.get("stage"),
        "message": snapshot.get("message"),
        "counters": snapshot.get("counters") or {},
        "report": snapshot.get("report"),
        "error": snapshot.get("error"),
        "queued_at": snapshot.get("queued_at"),
        "started_at": snapshot.get("started_at"),
        "completed_at": snapshot.get("completed_at"),
    }


class ConvertAnnotationRequest(BaseModel):
    annotation_path: str
    output_dir: str
    fasta_path: Optional[str] = None
    id_mode: str = "keep"
    id_prefix: str = ""
    compress: bool = True


@router.post("/api/custom/convert-annotation")
async def convert_custom_annotation(request: ConvertAnnotationRequest):
    """Normalise an annotation into canonical GFF3 without registering it.

    Used to preview a conversion, or to produce a file the user can inspect
    before importing. The import path runs the same conversion internally.
    """
    annotation_path = data_paths._resolve_user_file(request.annotation_path, "Annotation")
    output_dir = Path(str(request.output_dir or "").strip()).expanduser()
    if not str(output_dir):
        raise HTTPException(status_code=400, detail="output_dir is required")
    try:
        output_dir = output_dir.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid output_dir: {exc}")
    if output_dir.exists() and not output_dir.is_dir():
        raise HTTPException(status_code=400, detail="output_dir is not a directory")

    payload: Dict[str, Any] = {
        "annotation_path": str(annotation_path),
        "output_dir": str(output_dir),
        "id_mode": request.id_mode or "keep",
        "id_prefix": request.id_prefix or "",
        "compress": bool(request.compress),
    }
    if request.fasta_path:
        payload["fasta_path"] = str(data_paths._resolve_user_file(request.fasta_path, "FASTA"))

    # Fail fast on a bad prefix rather than surfacing it as a task failure.
    if (request.id_mode or "keep").strip().lower() == "generate":
        try:
            annotation_normalize_prefix(request.id_prefix or "")
        except IdentifierError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return _queue_validation("conversion", payload, str(annotation_path))


@router.get("/api/custom/conversion/{task_id}")
def custom_conversion_status(task_id: str):
    """Poll a conversion task; alias of the validation poll for a clearer URL."""
    return custom_validation_status(task_id)


class PrepareAnnotationRequest(BaseModel):
    annotation_path: str
    fasta_path: Optional[str] = None
    id_mode: str = "keep"
    id_prefix: str = ""


@router.post("/api/custom/prepare-annotation")
async def prepare_custom_annotation(request: PrepareAnnotationRequest):
    """Return the annotation path that should be indexed, converting if needed.

    Called when a genome is added from local files. A GFF3 the existing indexer
    already handles is passed straight through; anything that needs its gene
    model rebuilt — GTF, CDS-only output, files with no gene rows — is converted
    into canonical GFF3 next to the source first. Without this the indexer would
    silently produce an empty gene track.
    """
    annotation_path = data_paths._resolve_user_file(request.annotation_path, "Annotation")
    payload: Dict[str, Any] = {
        "annotation_path": str(annotation_path),
        "id_mode": request.id_mode or "keep",
        "id_prefix": request.id_prefix or "",
    }
    if request.fasta_path:
        payload["fasta_path"] = str(data_paths._resolve_user_file(request.fasta_path, "FASTA"))

    if (request.id_mode or "keep").strip().lower() == "generate":
        try:
            annotation_normalize_prefix(request.id_prefix or "")
        except IdentifierError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return _queue_validation("prepare", payload, str(annotation_path))


class ManualGenomeConfigReadRequest(BaseModel):
    path: str


class ManualGenomeConfigSaveRequest(BaseModel):
    path: str
    genomes: List[Dict[str, Any]]
    playlists: Optional[List[Dict[str, Any]]] = None
    # "create" refuses to touch an existing file so the UI can offer a choice.
    mode: str = "create"


@router.post("/api/custom/genome-config/read")
async def read_manual_genome_config(request: ManualGenomeConfigReadRequest):
    """Read and validate a portable genome bundle."""
    source = validate_config_export_path(request.path)
    try:
        return await run_in_threadpool(parse_manual_genome_config, str(source))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/custom/genome-config/save")
async def write_manual_genome_config(request: ManualGenomeConfigSaveRequest):
    """Atomically save a set of registered genomes as a portable bundle."""
    destination = validate_config_export_path(request.path)
    try:
        return await run_in_threadpool(
            save_manual_genome_config,
            str(destination),
            request.genomes,
            request.playlists,
            request.mode,
        )
    except FileExistsError as exc:
        # 409 so the UI can offer replace-or-amend instead of clobbering.
        raise HTTPException(
            status_code=409,
            detail=f"{Path(str(exc)).name} already exists.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not save configuration: {exc}",
        ) from exc


@router.get("/api/custom/sniff-annotation")
def custom_sniff_annotation(path: str):
    """Cheap format probe for the file picker — reads only the head of the file."""
    annotation_path = data_paths._resolve_user_file(path, "Annotation")
    return sniff_annotation(str(annotation_path)).as_dict()


@router.post("/api/index/generate")
async def generate_indexes(request: IndexRequest):
    """Generate GFF3 indices.

    Runs on a worker thread. Building an index takes minutes on a large
    annotation, and doing that on the event loop stopped the process answering
    anything at all for the duration — including the readiness polls that were
    the only sign the build was progressing.
    """
    return await run_in_threadpool(_generate_indexes_blocking, request)


def _generate_indexes_blocking(request: IndexRequest):
    config = config_store.load_config()
    
    # Use request params if provided (for unsaved UI state), else config
    output_dir = request.output_dir or config.get("output_dir")
    
    if not output_dir:
        raise HTTPException(status_code=400, detail="Output directory not set.")
        
    # Validating existence - if it doesn't exist, should we create it?
    # The prompt implied it exists, but let's be safe and try to create it if it doesn't,
    # or just check existence if strictly required.
    # The error message said "not set or does not exist".
    if not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Output directory {output_dir} does not exist and could not be created.")
        
    ref_gff = request.ref_gff or config.get("ref_gff")
    target_gff = request.target_gff or config.get("target_gff")
    
    if not ref_gff or not os.path.exists(ref_gff):
        raise HTTPException(status_code=400, detail="Reference GFF3 not found.")
        
    updated_config = config.copy()
    # Update with the values we actually used, to ensure persistence
    updated_config["output_dir"] = output_dir
    updated_config["ref_gff"] = ref_gff
    if target_gff: updated_config["target_gff"] = target_gff
    
    ref_fasta = updated_config.get("ref_fasta", "")
    target_fasta = updated_config.get("target_fasta", "")

    try:
        # Generate Reference Index
        ref_db = gff_index._resolve_index_path(ref_gff, output_dir, "ref_index.db")
        updated_config["ref_index"] = gff_index.ensure_gff_index(ref_gff, str(ref_db), force_rebuild=True)

        # Prepare Reference FASTA (decompress gzip if needed + index)
        if ref_fasta and os.path.exists(ref_fasta):
            file_io.log_progress("Preparing reference FASTA for sequence browsing...")
            file_io.ensure_fasta_index(ref_fasta)

        # Generate Target Index (if available)
        if target_gff and os.path.exists(target_gff):
            target_db = gff_index._resolve_index_path(target_gff, output_dir, "target_index.db")
            updated_config["target_index"] = gff_index.ensure_gff_index(target_gff, str(target_db), force_rebuild=True)

        # Prepare Target FASTA (decompress gzip if needed + index)
        if target_fasta and os.path.exists(target_fasta):
            file_io.log_progress("Preparing target FASTA for sequence browsing...")
            file_io.ensure_fasta_index(target_fasta)

        # Save config
        config_store.save_config(updated_config)

        return {"status": "success", "message": "Indexes generated successfully", "ref_index": str(ref_db)}

    except Exception as e:
        logger.error(f"Indexing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
