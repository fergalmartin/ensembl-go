"""Tutorials and the demo genome: installing the bundled demo genome, the tutorial
sandbox workspace and session, and the tutorial authoring endpoints (drafts,
checkpoints, packages, promotion and demo datasets) that the in-app builder uses.
"""

import json
from pathlib import Path
from typing import Any, Dict, Optional

import pysam
from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import genome_context
import gff_index
import tutorial_authoring
import tutorial_datasets
import tutorial_packages
from demo_genome import (
    clear_tutorial_session_genome,
    demo_index_target,
    demo_install_status,
    demo_install_statuses,
    install_demo_genome,
    install_demo_source_files,
    install_demo_track_files,
    reset_tutorial_workspace,
    set_tutorial_session_genome,
    tutorial_workspace,
)

router = APIRouter()


@router.get("/api/demo/genome")
async def get_demo_genome(output_dir: str = "", genome_id: str = ""):
    """A bundled genome's catalogue entry, and whether it is already installed.

    The download view asks for this while a tutorial is running so it can show the
    tutorials' genomes alongside the real catalogue.

    ``genomes`` is the list; ``species`` and the rest of the top level describe one of
    them — the one asked for, or the demo genome — because that is the shape this
    endpoint had when there was only ever one.
    """
    status = demo_install_status(output_dir, genome_id or None)
    status["genomes"] = demo_install_statuses(output_dir)
    return status


class DemoGenomeInstallRequest(BaseModel):
    output_dir: str
    genome_id: str = ""


@router.post("/api/demo/genome/install")
async def post_demo_genome_install(request: DemoGenomeInstallRequest):
    """Install a bundled genome, standing in for a download during a tutorial.

    Indexes it on the way out. The annotations are small — a few kilobytes for the demo
    genome, a hundred transcripts for the chromosome-1 slice — so building the index here
    rather than in the background costs little and means the browser is ready by the time
    the tutorial's next step arrives.
    """
    output_dir = str(request.output_dir or "").strip()
    if not output_dir:
        raise HTTPException(status_code=400, detail="output_dir is required")
    genome_id = str(request.genome_id or "").strip() or None
    try:
        status = install_demo_genome(output_dir, genome_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    target = demo_index_target(output_dir, genome_id)
    if target:
        gff_path, index_path = target
        try:
            status["index"] = gff_index.ensure_gff_index(gff_path, index_path)
        except Exception as exc:
            # A missing index is recoverable — the browser rebuilds on demand — so the
            # tutorial should carry on rather than fail here.
            status["index_error"] = str(exc)
    return status


class TutorialWorkspaceRequest(BaseModel):
    output_dir: str


@router.post("/api/tutorial/workspace")
async def post_tutorial_workspace(request: TutorialWorkspaceRequest):
    """Create the scratch directory a tutorial runs in, inside the user's output dir.

    A tutorial never writes to the real configuration, so this is the only trace it
    leaves on disk — and it is removed again on the way out.
    """
    try:
        workspace = tutorial_workspace(request.output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    workspace.mkdir(parents=True, exist_ok=True)
    return {"workspace": str(workspace)}


@router.delete("/api/tutorial/workspace")
async def delete_tutorial_workspace(output_dir: str):
    """Remove the tutorial scratch directory.

    Called when a tutorial ends, and again on launch, so a run interrupted by a crash
    does not leave the demo genome sitting in the user's output directory.
    """
    clear_tutorial_session_genome()
    try:
        return reset_tutorial_workspace(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class TutorialSessionRequest(BaseModel):
    genome: Dict[str, Any]


@router.post("/api/tutorial/session")
async def post_tutorial_session(request: TutorialSessionRequest):
    """Tell the browser about the genome the running tutorial has activated.

    The tutorial's active genome lives in the frontend's configuration override and is
    never saved, which is what keeps the user's setup untouched — but the genome browser
    resolves genomes on this side, from the saved configuration, so without this it
    answers every request for the demo genome with "invalid genome" and draws empty
    tracks. This holds it in memory for the life of the process instead.
    """
    try:
        registered = set_tutorial_session_genome(request.genome)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"registered": True, "genome": genome_context._active_species_item_key(registered)}


# ── Editing a tutorial's wording from inside the app ─────────────────────────
#
# A developer tool. `TUTORIAL_AUTHORING` is the switch: set it False and both endpoints
# below refuse, the frontend hides the control, and the feature is gone without anything
# else having to be unpicked. It is off in anything but a source checkout regardless,
# because there is nothing to edit in a packaged build.
TUTORIAL_AUTHORING = True


TUTORIAL_BUILDER = True


def _tutorial_authoring_enabled() -> bool:
    return bool(TUTORIAL_AUTHORING) and tutorial_authoring.is_available()


def _tutorial_builder_enabled() -> bool:
    return bool(TUTORIAL_BUILDER) and _tutorial_authoring_enabled()


@router.get("/api/tutorial/authoring")
async def get_tutorial_authoring():
    """Whether tutorial text can be edited in place, so the frontend can hide the control."""
    return {"enabled": _tutorial_authoring_enabled(), "builder_enabled": _tutorial_builder_enabled()}


class TutorialAuthoringRequest(BaseModel):
    tutorial_id: str
    step_id: str
    field: str
    value: str


class TutorialAuthoringPositionRequest(BaseModel):
    tutorial_id: str
    step_id: str
    x: float
    y: float


class TutorialAuthoringSizeRequest(BaseModel):
    tutorial_id: str
    step_id: str
    width: Optional[float] = None
    height: Optional[float] = None


class TutorialDraftSaveRequest(BaseModel):
    output_dir: str
    tutorial: Dict[str, Any]


class TutorialCheckpointSaveRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    name: str
    tutorial: Dict[str, Any]


class TutorialPackageExportRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    path: str


class TutorialPackageImportRequest(BaseModel):
    output_dir: str
    path: str


class TutorialPromoteRequest(BaseModel):
    output_dir: str
    tutorial_id: str


class TutorialDatasetGenerateRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    fasta_path: str
    annotation_path: str
    chrom: str
    start: int
    end: int
    partial_mode: str = "expand"
    source: Optional[Dict[str, Any]] = None


class TutorialDatasetFixtureRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    fixture_id: str


class TutorialDatasetInstallRequest(BaseModel):
    output_dir: str
    tutorial_id: str
    recipe_id: str
    workspace: str


@router.post("/api/tutorial/authoring/step")
async def post_tutorial_authoring_step(request: TutorialAuthoringRequest):
    """Write one step's wording back into its definition file.

    Narrow on purpose: one named field of one named step, and only the words shown on a
    card. Shared section headings are followed back to their local SECTION constant. See
    backend/tutorial_authoring.py for what stops it doing more.
    """
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_field,
            request.tutorial_id,
            request.step_id,
            request.field,
            request.value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


@router.post("/api/tutorial/authoring/step-position")
async def post_tutorial_authoring_step_position(request: TutorialAuthoringPositionRequest):
    """Persist a normalized card position chosen by dragging its authoring header."""
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_position,
            request.tutorial_id,
            request.step_id,
            request.x,
            request.y,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


@router.post("/api/tutorial/authoring/step-size")
async def post_tutorial_authoring_step_size(request: TutorialAuthoringSizeRequest):
    """Persist card dimensions chosen with its authoring resize handles."""
    if not _tutorial_authoring_enabled():
        raise HTTPException(status_code=404, detail="Tutorial editing is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_authoring.save_step_size,
            request.tutorial_id,
            request.step_id,
            request.width,
            request.height,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write the definition: {exc}")


# ── Declarative tutorial drafts and portable packages ───────────────────────

@router.get("/api/tutorial/drafts")
async def get_tutorial_drafts(output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"drafts": await run_in_threadpool(tutorial_packages.list_drafts, output_dir)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/drafts")
async def post_tutorial_draft(request: TutorialDraftSaveRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.save_draft, request.output_dir, request.tutorial)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not save the tutorial draft: {exc}")


@router.delete("/api/tutorial/drafts/{tutorial_id}")
async def delete_tutorial_draft(tutorial_id: str, output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"deleted": await run_in_threadpool(tutorial_packages.delete_draft, output_dir, tutorial_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/api/tutorial/drafts/{tutorial_id}/checkpoints")
async def get_tutorial_checkpoints(tutorial_id: str, output_dir: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return {"checkpoints": await run_in_threadpool(tutorial_packages.list_checkpoints, output_dir, tutorial_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/drafts/checkpoints")
async def post_tutorial_checkpoint(request: TutorialCheckpointSaveRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_packages.save_checkpoint,
            request.output_dir,
            request.tutorial_id,
            request.name,
            request.tutorial,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/packages/export")
async def post_tutorial_package_export(request: TutorialPackageExportRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_packages.export_package,
            request.output_dir,
            request.tutorial_id,
            request.path,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not export the tutorial package: {exc}")


@router.get("/api/tutorial/packages/scan")
async def get_tutorial_package_scan(path: str = ""):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.scan_package, path)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/packages/import")
async def post_tutorial_package_import(request: TutorialPackageImportRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial building is not enabled.")
    try:
        return await run_in_threadpool(tutorial_packages.import_package, request.path, request.output_dir)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/drafts/promote")
async def post_tutorial_draft_promote(request: TutorialPromoteRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial promotion is not enabled.")
    repository_root = Path(__file__).resolve().parents[1]
    try:
        return await run_in_threadpool(
            tutorial_packages.promote_draft,
            request.output_dir,
            request.tutorial_id,
            repository_root,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not promote the tutorial: {exc}")


@router.post("/api/tutorial/datasets/generate")
async def post_tutorial_dataset_generate(request: TutorialDatasetGenerateRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial dataset authoring is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.generate_recipe,
            request.output_dir,
            request.tutorial_id,
            request.fasta_path,
            request.annotation_path,
            request.chrom,
            request.start,
            request.end,
            request.partial_mode,
            request.source,
        )
    except (ValueError, OSError, pysam.utils.SamtoolsError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/datasets/fixture")
async def post_tutorial_dataset_fixture(request: TutorialDatasetFixtureRequest):
    if not _tutorial_builder_enabled():
        raise HTTPException(status_code=404, detail="Tutorial dataset authoring is not enabled.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.generate_fixture_pack,
            request.output_dir,
            request.tutorial_id,
            request.fixture_id,
        )
    except (ValueError, OSError, pysam.utils.SamtoolsError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/datasets/install")
async def post_tutorial_dataset_install(request: TutorialDatasetInstallRequest):
    expected_workspace = tutorial_workspace(request.output_dir).resolve()
    supplied_workspace = Path(request.workspace).expanduser().resolve()
    if supplied_workspace != expected_workspace:
        raise HTTPException(status_code=400, detail="Tutorial datasets may only be installed in the active tutorial workspace.")
    try:
        return await run_in_threadpool(
            tutorial_datasets.install_recipe,
            request.output_dir,
            request.tutorial_id,
            request.recipe_id,
            request.workspace,
        )
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class TutorialDemoSourceRequest(BaseModel):
    output_dir: str
    workspace: str


@router.post("/api/tutorial/demo-source")
async def post_tutorial_demo_source(request: TutorialDemoSourceRequest):
    """Lay the demo genome's raw files out in the workspace for a reader to pick by hand.

    The custom-genome tutorial teaches importing files you already have, so it has to put
    some files somewhere the reader can browse to. Nothing is registered or indexed here —
    that is the reader's job, through the form the tutorial is about.

    Guarded the same way dataset installation is: the workspace must be the one belonging
    to the output directory given, so this cannot be used to write into anything else.
    """
    expected_workspace = tutorial_workspace(request.output_dir).resolve()
    supplied_workspace = Path(request.workspace).expanduser().resolve()
    if supplied_workspace != expected_workspace:
        raise HTTPException(status_code=400, detail="Demo files may only be written in the active tutorial workspace.")
    try:
        return await run_in_threadpool(install_demo_source_files, request.workspace)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/tutorial/demo-tracks")
async def post_tutorial_demo_tracks(request: TutorialDemoSourceRequest):
    """Lay the demo data tracks out in the workspace for a reader to register by hand.

    The Track Manager tutorial teaches registering data files you already have, so it has
    to put some files somewhere the reader can browse to. Nothing is registered here — that
    is the reader's job, through the wizard the tutorial is about.

    Guarded exactly as ``/api/tutorial/demo-source`` is: the workspace must be the one
    belonging to the output directory given, so this cannot write anywhere else.
    """
    expected_workspace = tutorial_workspace(request.output_dir).resolve()
    supplied_workspace = Path(request.workspace).expanduser().resolve()
    if supplied_workspace != expected_workspace:
        raise HTTPException(status_code=400, detail="Demo files may only be written in the active tutorial workspace.")
    try:
        return await run_in_threadpool(install_demo_track_files, request.workspace)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/api/tutorial/session")
async def delete_tutorial_session():
    """Forget it again, when the tutorial ends."""
    clear_tutorial_session_genome()
    return {"registered": False}
