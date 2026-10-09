"""Configuration and file-browser endpoints: reading and saving the configuration (with
its sidecars and warnings), loading a config file, clearing caches and local data, and
the directory listing the app's file picker uses.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import app_paths
import config_store
import data_paths
import file_io
import routes.neighbourhood
from demo_genome import TUTORIAL_WORKSPACE_DIR
from security_utils import sanitize_leaf_filename, validate_config_export_path

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/config")
def get_config():
    return config_store.load_config()


@router.get("/api/config/warnings")
async def get_config_warnings_endpoint():
    """Settings files that could not be read, for the UI to show.

    Kept off /api/config so that a warning never becomes a configuration field that the
    frontend would post back and the sidecar would have to filter out again.
    """
    return {"warnings": config_store.get_config_warnings()}


@router.get("/api/config/output-dir")
def get_output_dir_config(output_dir: str = "", working_dir: str = ""):
    """Load the configuration sidecar for a known output/working directory."""
    current_config = config_store.load_config()
    base_config = {
        **current_config,
        "output_dir": output_dir or current_config.get("output_dir", ""),
        "working_dir": working_dir or current_config.get("working_dir", ""),
    }
    state = config_store._load_config_state_for_config(base_config)
    if not state:
        return {"found": False, "config": base_config}
    path_fields = {
        key: base_config.get(key)
        for key in ("output_dir", "working_dir")
        if str(base_config.get(key) or "").strip()
    }
    merged = {
        **base_config,
        **state,
        **path_fields,
    }
    merged = config_store._merge_output_dir_playlist_state(merged)
    return {"found": True, "config": config_store._enrich_config_genome_labels(merged)}


@router.get("/api/config/playlists")
def get_config_playlists(output_dir: str = "", working_dir: str = ""):
    """Load genome playlists directly from the output/working directory sidecar."""
    current_config = config_store.load_config()
    base_config = {
        **current_config,
        "output_dir": output_dir or current_config.get("output_dir", ""),
        "working_dir": working_dir or current_config.get("working_dir", ""),
    }
    state = config_store._load_playlist_state_for_config(base_config)
    if not state:
        state = {
            "genome_playlists": base_config.get("genome_playlists") or [],
            "selected_genome_playlist_id": base_config.get("selected_genome_playlist_id") or "__all__",
        }
    return state


class ConfigUpdate(BaseModel):
    working_dir: Optional[str] = None
    ref_fasta: Optional[str] = None
    ref_gff: Optional[str] = None
    target_fasta: Optional[str] = None
    target_gff: Optional[str] = None
    homologies_file: Optional[str] = None
    output_dir: Optional[str] = None
    ref_index: Optional[str] = None
    target_index: Optional[str] = None
    default_light_mode: Optional[bool] = None
    dim_non_selected_genes: Optional[bool] = None
    show_fps_counter: Optional[bool] = None
    browsing_control_scheme: Optional[str] = None
    sv_hide_inactive_tracks: Optional[bool] = None
    remember_browser_tracks: Optional[bool] = None
    active_species: Optional[List[Dict[str, Any]]] = None
    next_previous_session_genomes: Optional[List[Dict[str, Any]]] = None
    manual_species: Optional[List[Dict[str, Any]]] = None
    genome_file_overrides: Optional[Dict[str, Dict[str, Any]]] = None
    genome_analysis_reports: Optional[Dict[str, Dict[str, Any]]] = None
    deregistered_genome_keys: Optional[List[str]] = None
    genome_playlists: Optional[List[Dict[str, Any]]] = None
    selected_genome_playlist_id: Optional[str] = None
    genome_browser_colors: Optional[List[str]] = None
    genome_default_color: Optional[str] = None
    genome_colors: Optional[Dict[str, str]] = None
    genome_color_palette: Optional[List[str]] = None
    active_app_buttons: Optional[List[str]] = None
    clear_genome_playlists: Optional[bool] = None
    save_path: Optional[str] = None  # Optional path to save to


def _is_tutorial_workspace_path(value: Any) -> bool:
    """Whether a path is a tutorial's scratch directory rather than a real output dir."""
    text = str(value or "").strip()
    if not text:
        return False
    return Path(text).name == TUTORIAL_WORKSPACE_DIR


@router.post("/api/config")
def update_config(config: ConfigUpdate):
    """Save configuration to disk. If save_path is provided, save there; otherwise save to default cache."""
    # A tutorial runs on a configuration overlay pointing at a scratch directory, and that
    # overlay must never become the saved configuration — it would survive the tutorial and
    # leave the user pointed at a directory that is about to be deleted. The frontend
    # already refuses these writes, but this is the guarantee: it does not depend on which
    # order two effects happen to run in.
    if _is_tutorial_workspace_path(getattr(config, "output_dir", "")):
        logger.warning("Refusing to save a configuration pointing at the tutorial workspace")
        return config_store.load_config()

    # Merge incoming fields over the existing saved config so that fields not present
    # in the ConfigUpdate model (e.g. ref_index / target_index written by generate_indexes)
    # are never silently dropped.
    existing = config_store.load_config()
    incoming = config.model_dump(exclude={"save_path", "clear_genome_playlists"})
    # Overwrite all incoming fields, including empty strings, so that the
    # frontend's cascade logic (clearing stale index paths etc.) is honoured.
    merged = {**existing, **{k: v for k, v in incoming.items() if v is not None}}
    incoming_fields = getattr(config, "model_fields_set", set())
    if "output_dir" in incoming_fields or "working_dir" in incoming_fields:
        previous_output_dir = str(existing.get("output_dir") or "").strip()
        next_output_dir = str(merged.get("output_dir") or "").strip()
        previous_working_dir = str(existing.get("working_dir") or "").strip()
        next_working_dir = str(merged.get("working_dir") or "").strip()
        incoming_playlists = incoming.get("genome_playlists")
        directory_changed = (
            ("output_dir" in incoming_fields and next_output_dir != previous_output_dir) or
            ("working_dir" in incoming_fields and next_working_dir != previous_working_dir)
        )
        if directory_changed:
            output_dir_config_state = config_store._load_config_state_for_config(merged)
            if output_dir_config_state:
                path_fields = {
                    key: merged.get(key)
                    for key in ("output_dir", "working_dir")
                    if str(merged.get(key) or "").strip()
                }
                merged = {
                    **merged,
                    **output_dir_config_state,
                    **path_fields,
                }
                # Adopted, so this configuration may now write these sidecars.
                merged = config_store._record_sidecar_revisions(merged)
                incoming_playlists = incoming_playlists or output_dir_config_state.get("genome_playlists")
        if directory_changed and not incoming_playlists:
            output_dir_state = config_store._load_playlist_state_for_config(merged)
            if output_dir_state and output_dir_state.get("genome_playlists"):
                merged = {
                    **merged,
                    "genome_playlists": output_dir_state["genome_playlists"],
                    "selected_genome_playlist_id": output_dir_state["selected_genome_playlist_id"],
                }
                merged = config_store._record_sidecar_revisions(merged)

    if (
        "genome_playlists" in incoming_fields
        and not config.clear_genome_playlists
        and not (incoming.get("genome_playlists") or [])
    ):
        preserved_playlist_state = None
        if existing.get("genome_playlists"):
            preserved_playlist_state = {
                "genome_playlists": existing.get("genome_playlists") or [],
                "selected_genome_playlist_id": existing.get("selected_genome_playlist_id") or "__all__",
            }
        else:
            preserved_playlist_state = config_store._load_playlist_state_for_config(merged)
        if preserved_playlist_state and preserved_playlist_state.get("genome_playlists"):
            merged = {
                **merged,
                "genome_playlists": preserved_playlist_state["genome_playlists"],
                "selected_genome_playlist_id": preserved_playlist_state["selected_genome_playlist_id"],
            }

    if config.save_path:
        # Save to specific file (Export)
        save_path = validate_config_export_path(config.save_path)
        try:
            config_store.save_config(merged, save_path)
            file_io.log_progress(f"Configuration saved to: {save_path}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save to {save_path}: {e}")
    else:
        # Save to default cache (Auto-save / Session)
        config_store.save_config(merged)
        file_io.log_progress(f"Configuration cached: {merged}")

    return {"status": "ok", "config": merged}


class LoadConfigRequest(BaseModel):
    path: str


@router.post("/api/config/load")
def load_custom_config(request: LoadConfigRequest):
    """Load configuration from a specific file."""
    path = validate_config_export_path(request.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Config file not found: {path}")
    
    try:
        with open(path) as f:
            data = json.load(f)
        # Ensure defaults are merged and ignore fields this version does not recognise.
        loaded_config = config_store._normalize_output_dir_config_state(data)
        merged = {**config_store.DEFAULT_CONFIG, **loaded_config}
        
        # Also update session cache so auto-save works with loaded values. This one
        # overrides the sidecar deliberately: importing a configuration is a request to
        # replace what the directory holds, not to merge with it.
        config_store.save_config(merged, force_sidecar=True)
        
        return merged
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load config: {e}")


@router.post("/api/cache/clear")
async def clear_cache():
    """Delete all cached alignment files."""
    count = 0
    for f in app_paths.CACHE_DIR.glob("*.json"):
        if f.name == "config.json":
            continue  # Don't delete configuration
        try:
            f.unlink()
            count += 1
        except Exception:
            pass
    routes.neighbourhood._neighbourhood_cache.clear()
    file_io.log_progress(f"Cleared {count} cached alignment files and neighbourhood cache")
    return {"status": "ok", "cleared": count}


class ClearDataRequest(BaseModel):
    output_dir: str


@router.post("/api/data/clear")
def clear_local_data(request: ClearDataRequest):
    """Delete all downloaded genomes in the local_data directory."""
    if not request.output_dir:
        raise HTTPException(status_code=400, detail="Output directory not configured")
    
    local_data_dir = data_paths._resolve_local_data_root(request.output_dir)
    
    if not local_data_dir.exists():
        return {"status": "ok", "message": "Directory does not exist, nothing to clear"}
        
    try:
        import shutil
        shutil.rmtree(local_data_dir, ignore_errors=True)
        file_io.log_progress(f"Wiped local_data directory at {local_data_dir}")
        return {"status": "ok", "message": "All downloaded genomes have been cleared successfully"}
    except Exception as e:
        file_io.log_progress(f"Failed to wipe local_data directory: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete directory: {e}")


def _default_file_browser_path() -> Path:
    try:
        config = config_store.load_config()
        output_dir = str(config.get("output_dir") or "").strip()
        if output_dir:
            local_data = data_paths._resolve_local_data_root(output_dir)
            local_data.mkdir(parents=True, exist_ok=True)
            return local_data
    except Exception:
        pass
    return Path.home()


@router.get("/api/files/list")
async def list_files(path: str = "."):
    """List files and directories for the web file browser."""
    try:
        requested_path = str(path or "").strip()
        # Resolve path relative to home or absolute
        if requested_path == "~" or requested_path.startswith("~/"):
            target_path = Path(os.path.expanduser(requested_path))
        elif requested_path in {"", "."}:
            target_path = _default_file_browser_path()
        else:
            target_path = Path(requested_path)

        # The browser deliberately recovers from a missing path by showing its nearest
        # usable parent. Callers that are validating a typed directory still need to know
        # that recovery happened, or a typo such as /outputt silently becomes /.
        requested_path_valid = target_path.exists() and target_path.is_dir()
        
        if not target_path.exists():
             # Try to recover - maybe parent exists?
             if target_path.parent.exists():
                 target_path = target_path.parent
             else:
                 target_path = _default_file_browser_path()
        
        # Ensure we are listing a directory
        if not target_path.is_dir():
             target_path = target_path.parent

        items = []
        # Add parent directory entry
        if target_path.parent != target_path:
             items.append({
                 "name": "..",
                 "path": str(target_path.parent),
                 "is_dir": True,
                 "size": 0
             })

        # List contents. Skip entries we cannot inspect rather than failing the
        # whole browser, which can happen in system-managed folders on macOS.
        try:
            with os.scandir(target_path) as scanner:
                for entry in scanner:
                    if entry.name.startswith('.'):
                        continue
                    try:
                        is_dir = entry.is_dir()
                        size = 0 if is_dir else entry.stat().st_size
                    except OSError:
                        continue
                    items.append({
                        "name": entry.name,
                        "path": entry.path,
                        "is_dir": is_dir,
                        "size": size
                    })
        except PermissionError:
            fallback_path = _default_file_browser_path()
            if fallback_path != target_path and fallback_path.exists() and fallback_path.is_dir():
                return await list_files(str(fallback_path))
            raise
        
        # Sort: directories first, then files
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        
        return {
            "current_path": str(target_path.absolute()),
            "requested_path_valid": requested_path_valid,
            "items": items
        }
    except HTTPException:
        raise
    except Exception as e:
        # The detail is deliberately generic: the exception text carries
        # filesystem paths, which should stay in the local log.
        logger.error(f"Error listing directory {path}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list directory")


class MkdirRequest(BaseModel):
    path: str


@router.post("/api/files/mkdir")
async def create_directory(request: MkdirRequest):
    """Create one new directory inside a directory that already exists.

    The file browser only ever creates a single directory inside the directory the
    user is currently viewing, so the request is held to exactly that: an
    existing parent plus one leaf name. Creating whole nested trees at an
    arbitrary path is refused, which keeps this from being a general "write
    anywhere on disk" primitive while leaving external drives and other
    user-chosen locations usable.
    """
    raw = str(request.path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="path must not be empty")

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="path must be absolute")

    leaf = sanitize_leaf_filename(candidate.name)
    parent = candidate.parent.resolve()
    if not parent.is_dir():
        raise HTTPException(status_code=400, detail="Parent directory does not exist")

    target = parent / leaf
    if target.exists():
        return {"status": "exists", "path": str(target)}

    try:
        target.mkdir()
    except OSError as exc:
        logger.error("Error creating directory %s: %s", target, exc)
        raise HTTPException(status_code=400, detail="Failed to create directory")
    return {"status": "created", "path": str(target)}
