"""User notes: the notes store (output-directory sidecar first, cache fallback), its
normalisation and quarantine of unreadable files, and the /api/notes endpoints
including export and import.
"""

import json
import os
import shutil
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import config_store
import data_paths
import notes_transfer
from demo_genome import tutorial_session_workspace, TUTORIAL_WORKSPACE_DIR
from genome_identity import strip_dataset_release_from_selection_key
from security_utils import safe_export_filename

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
#  User Notes — free-text annotations the user attaches to a feature
# ═══════════════════════════════════════════════════════════════════════════════
#
# Sibling of the track registry above, and deliberately built from the same
# parts: the same sidecar-first path resolution, the same tolerant load, the
# same mkstemp/os.replace write. Two divergences, both because a note is prose
# the user typed rather than a file path they can re-add — see _load_user_notes
# and _quarantine_unparseable_notes_store.
#
# The store is keyed by (kind, genome_key, id) rather than by gene, so notes on
# transcripts or regions need no migration when they arrive.

OUTPUT_DIR_USER_NOTES_FILENAME = "user_notes.json"


DEFAULT_USER_NOTES_FILE = app_paths.CACHE_DIR / OUTPUT_DIR_USER_NOTES_FILENAME


USER_NOTES_FILE = DEFAULT_USER_NOTES_FILE


USER_NOTES_STORE_VERSION = 2


MAX_NOTE_TITLE_CHARS = 200


MAX_NOTE_BODY_CHARS = 200_000


MAX_NOTE_TAGS = 20


MAX_NOTE_TAG_CHARS = 50


TODO_STATUSES = {"backlog", "next", "in_progress", "waiting", "blocked", "completed", "abandoned"}


TODO_PRIORITIES = {"low", "medium", "high"}


_user_notes_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _new_note_id() -> str:
    return f"note_{uuid.uuid4().hex[:12]}"


def _normalize_note_genome_key(value: Any) -> str:
    """The lookup key is the assembly, not the dataset release.

    Gene stable ids survive an annotation release (ENSG… is the same gene in
    Ensembl 115 and 116), so keying notes by the full selection key would make
    every note vanish the moment the user updated their genome — the worst
    possible failure for text they wrote themselves.
    """
    return strip_dataset_release_from_selection_key(value)


def _normalize_note_target(raw: Any) -> Dict[str, str]:
    data = raw if isinstance(raw, dict) else {}
    kind = str(data.get("kind") or "gene").strip() or "gene"
    genome_key = _normalize_note_genome_key(data.get("genome_key"))
    target_id = str(data.get("id") or "").strip()
    if not target_id:
        raise HTTPException(status_code=400, detail="target.id is required")
    if not genome_key:
        raise HTTPException(status_code=400, detail="target.genome_key is required")
    return {
        "kind": kind,
        "genome_key": genome_key,
        "id": target_id,
        "label": str(data.get("label") or "").strip(),
        # Provenance only. Which release the note was written against can be
        # worth knowing later; it is never used to find the note again.
        "genome_selection_key": str(data.get("genome_selection_key") or "").strip(),
    }


def _normalize_todo_status(value: Any) -> str:
    token = str(value or "").strip().lower()
    return token if token in TODO_STATUSES else "backlog"


def _normalize_todo_priority(value: Any) -> str:
    token = str(value or "").strip().lower()
    if token == "normal":
        return "medium"
    if token == "urgent":
        return "high"
    return token if token in TODO_PRIORITIES else "medium"


def _normalize_todo_order(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _normalize_note_tags(value: Any, *, strict: bool = False) -> List[str]:
    """Trim and case-insensitively deduplicate a note's short tag phrases."""
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise HTTPException(status_code=400, detail="tags must be a list")
        return []

    tags: List[str] = []
    seen: Set[str] = set()
    for raw in value:
        source = raw if isinstance(raw, str) else str(raw or "")
        invalid = "," in source or any(ord(char) < 32 or ord(char) == 127 for char in source)
        token = " ".join(source.split()).strip()
        if invalid or not token:
            if strict:
                raise HTTPException(status_code=400, detail="tags cannot be empty or contain commas or control characters")
            continue
        if len(token) > MAX_NOTE_TAG_CHARS:
            if strict:
                raise HTTPException(
                    status_code=400,
                    detail=f"tags cannot exceed {MAX_NOTE_TAG_CHARS} characters",
                )
            token = token[:MAX_NOTE_TAG_CHARS].rstrip()
        key = token.lower()
        if key in seen:
            continue
        if len(tags) >= MAX_NOTE_TAGS:
            if strict:
                raise HTTPException(status_code=400, detail=f"a note can have at most {MAX_NOTE_TAGS} tags")
            break
        seen.add(key)
        tags.append(token)
    return tags


def _normalize_note_record(raw: Any) -> Optional[Dict[str, Any]]:
    """Coerce one stored record. Returns None for anything unusable."""
    if not isinstance(raw, dict):
        return None
    note_id = str(raw.get("id") or "").strip()
    if not note_id:
        return None
    target = raw.get("target")
    if not isinstance(target, dict):
        return None
    target_id = str(target.get("id") or "").strip()
    genome_key = _normalize_note_genome_key(target.get("genome_key"))
    if not target_id or not genome_key:
        return None
    created_at = str(raw.get("created_at") or "").strip() or _utc_now_iso()
    updated_at = str(raw.get("updated_at") or "").strip() or created_at
    status = _normalize_todo_status(raw.get("status"))
    completed = bool(raw.get("completed", False)) or status == "completed"
    if completed:
        status = "completed"
    tags = _normalize_note_tags(raw.get("tags"))
    return {
        "id": note_id,
        "target": {
            "kind": str(target.get("kind") or "gene").strip() or "gene",
            "genome_key": genome_key,
            "id": target_id,
            "label": str(target.get("label") or "").strip(),
            "genome_selection_key": str(target.get("genome_selection_key") or "").strip(),
        },
        "title": str(raw.get("title") or "")[:MAX_NOTE_TITLE_CHARS],
        "body": str(raw.get("body") or "")[:MAX_NOTE_BODY_CHARS],
        "tags": tags,
        "tags_updated_at": (str(raw.get("tags_updated_at") or "").strip() or updated_at) if tags else "",
        "created_at": created_at,
        "updated_at": updated_at,
        "archived": bool(raw.get("archived", False)),
        "archived_at": str(raw.get("archived_at") or "").strip() if bool(raw.get("archived", False)) else "",
        "status": status,
        "priority": _normalize_todo_priority(raw.get("priority")),
        "completed": completed,
        "completed_at": (str(raw.get("completed_at") or "").strip() or updated_at) if completed else "",
        "todo_order": _normalize_todo_order(raw.get("todo_order")),
    }


def _note_target_matches(note: Dict[str, Any], kind: str, genome_key: str, target_id: str) -> bool:
    target = note.get("target") or {}
    if kind and str(target.get("kind") or "") != kind:
        return False
    if genome_key and str(target.get("genome_key") or "") != _normalize_note_genome_key(genome_key):
        return False
    if target_id and str(target.get("id") or "") != target_id:
        return False
    return True


def _notes_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The configuration the notes store should be resolved against.

    Normally the user's own. While a tutorial is running it is that configuration with
    its output directory swapped for the tutorial's workspace, so a note taken during a
    tutorial is written into the scratch directory and swept away with it.

    This has to happen here rather than in the frontend's config override. The override
    is a frontend fact; every notes endpoint resolves its store from the configuration
    *on disk*, so without this a note taken during a tutorial lands in the user's real
    notes file and outlives the tutorial — the one thing the sandbox promises cannot
    happen. Same shape as ``_browsable_active_species``, and for the same reason.
    """
    cfg = dict(config or config_store.load_config())
    workspace = tutorial_session_workspace()
    if workspace:
        cfg["output_dir"] = workspace
    return cfg


def _output_dir_user_notes_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / OUTPUT_DIR_USER_NOTES_FILENAME
    except Exception:
        return None


def _user_notes_store_paths_for_config(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    cfg = config or {}
    paths: List[Path] = []
    use_output_sidecar = str(USER_NOTES_FILE) == str(DEFAULT_USER_NOTES_FILE)
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    if sidecar:
        paths.append(sidecar)
    if sidecar and TUTORIAL_WORKSPACE_DIR in sidecar.parts:
        # A tutorial's notes are its own. Merging the global store in would show the
        # user's notes inside the tutorial, and — because a merged store is written back
        # out — could copy them into a scratch directory that is about to be deleted.
        return [sidecar]
    paths.append(USER_NOTES_FILE)

    out: List[Path] = []
    seen: Set[str] = set()
    for path in paths:
        try:
            resolved = str(path.expanduser().resolve())
        except Exception:
            resolved = str(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(path)
    return out


def _quarantine_unparseable_notes_store(path: Path) -> None:
    """Move a store we cannot read aside before anything overwrites it.

    The track registry just writes over a corrupt file — losing it costs the
    user a few clicks to re-add their tracks. Here the same bytes are the only
    copy of something they wrote, so they get renamed, not replaced.
    """
    try:
        if not path.exists() or path.stat().st_size == 0:
            return
        path.rename(path.with_name(f"{path.name}.corrupt-{int(time.time())}"))
    except Exception:
        pass


def _load_user_notes_from_path(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("notes"), list):
            return data
    except Exception:
        _quarantine_unparseable_notes_store(path)
        return None
    # Parsed, but not a store — same treatment as unparseable.
    _quarantine_unparseable_notes_store(path)
    return None


def _merge_user_note_lists(*note_lists: Any) -> List[Dict[str, Any]]:
    """Union by note id, keeping whichever copy was edited last."""
    merged: Dict[str, Dict[str, Any]] = {}
    for notes in note_lists:
        for raw in (notes or []):
            note = _normalize_note_record(raw)
            if not note:
                continue
            existing = merged.get(note["id"])
            if existing is None or note["updated_at"] >= existing["updated_at"]:
                merged[note["id"]] = note
    return sorted(merged.values(), key=lambda n: n["updated_at"], reverse=True)


def _load_user_notes(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge every store we can read rather than picking a winner.

    The track registry returns the first populated store it finds. Doing that
    here would hide every note written under a previous output_dir the moment
    the user repointed it. Notes are cheap to merge and expensive to lose.
    """
    cfg = config or config_store.load_config()
    collected: List[Any] = []
    for path in _user_notes_store_paths_for_config(cfg):
        store = _load_user_notes_from_path(path)
        if store:
            collected.append(store.get("notes"))
    return {"version": USER_NOTES_STORE_VERSION, "notes": _merge_user_note_lists(*collected)}


def _primary_user_notes_store_path(config: Optional[Dict[str, Any]] = None) -> Path:
    cfg = config or {}
    use_output_sidecar = str(USER_NOTES_FILE) == str(DEFAULT_USER_NOTES_FILE)
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    return sidecar or USER_NOTES_FILE


def _save_user_notes(store: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or config_store.load_config()
    path = _primary_user_notes_store_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass


def _save_user_notes_to_all_stores(
    store: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
) -> List[Path]:
    """Write the store to every file that currently holds notes.

    _save_user_notes writes only the primary path, which is right for an edit:
    _load_user_notes unions every store it can read, so an edit that lands in one
    of them still wins on the next load. It is wrong for a deletion. "Delete
    everything and replace" that only rewrites the primary leaves a second store
    untouched, and the union brings every deleted note straight back — so a
    destructive import writes everywhere or it has not happened at all.
    """
    cfg = config or config_store.load_config()
    written: List[Path] = []
    targets = [path for path in _user_notes_store_paths_for_config(cfg) if path.exists()]
    primary = _primary_user_notes_store_path(cfg)
    if not any(str(path) == str(primary) for path in targets):
        targets.append(primary)

    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(store, f, indent=2)
            os.replace(tmp_path, path)
            written.append(path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass
    return written


def _backup_user_notes_stores(config: Optional[Dict[str, Any]] = None) -> List[str]:
    """Copy every store aside before a destructive import.

    Same reasoning as _quarantine_unparseable_notes_store: these bytes are the
    only copy of something the user wrote, so nothing overwrites them without
    leaving a way back.
    """
    cfg = config or config_store.load_config()
    stamp = int(time.time())
    saved: List[str] = []
    for path in _user_notes_store_paths_for_config(cfg):
        try:
            if not path.exists() or path.stat().st_size == 0:
                continue
            backup = path.with_name(f"{path.name}.backup-{stamp}")
            shutil.copy2(path, backup)
            saved.append(str(backup))
        except Exception:
            continue
    return saved


def _ensure_user_notes_sidecar(config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or config_store.load_config()
    sidecar = _output_dir_user_notes_store_path(cfg.get("output_dir"))
    if not sidecar:
        return
    store = _load_user_notes(cfg)
    if not store.get("notes") and sidecar.exists():
        return
    try:
        _save_user_notes(store, cfg)
    except Exception:
        pass


class NoteTargetModel(BaseModel):
    kind: str = "gene"
    genome_key: str = ""
    id: str = ""
    label: str = ""
    genome_selection_key: str = ""


class UserNoteModel(BaseModel):
    id: str
    target: NoteTargetModel
    title: str = ""
    body: str = ""
    tags: List[str] = []
    tags_updated_at: str = ""
    created_at: str
    updated_at: str
    archived: bool = False
    archived_at: str = ""
    status: str = "backlog"
    priority: str = "medium"
    completed: bool = False
    completed_at: str = ""
    todo_order: int = 0


class UserNoteCreateRequest(BaseModel):
    target: NoteTargetModel
    title: str = ""
    body: str = ""
    tags: List[str] = []
    status: str = "backlog"
    priority: str = "medium"
    completed: bool = False
    todo_order: int = 0


class UserNoteUpdateRequest(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    completed: Optional[bool] = None
    todo_order: Optional[int] = None
    # The updated_at the client last saw. Omit to force-write.
    updated_at: Optional[str] = None


class UserNoteArchiveRequest(BaseModel):
    archived: bool = True


class UserNoteBulkDeleteRequest(BaseModel):
    note_ids: List[str] = []


class UserNotesResponse(BaseModel):
    notes: List[UserNoteModel]


class UserNotesIndexEntry(BaseModel):
    kind: str
    genome_key: str
    target_id: str
    label: str = ""
    count: int
    updated_at: str


class UserNotesIndexResponse(BaseModel):
    entries: List[UserNotesIndexEntry]


@router.get("/api/notes", response_model=UserNotesResponse)
async def list_user_notes(kind: str = "", genome_key: str = "", target_id: str = ""):
    """Notes, most recently edited first. Every filter is optional and narrowing."""
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        _ensure_user_notes_sidecar(config)
        notes = [
            note for note in store.get("notes", [])
            if _note_target_matches(note, kind.strip(), genome_key.strip(), target_id.strip())
        ]
        return {"notes": notes}

    return await run_in_threadpool(_run)


@router.get("/api/notes/index", response_model=UserNotesIndexResponse)
async def user_notes_index(kind: str = "gene", genome_key: str = ""):
    """One row per annotated feature: how many notes it has, and when it last changed.

    This is all the genome browser canvas needs to decide where to draw a note
    bubble. Pulling the notes themselves would ship every body the user has ever
    written just to place a 14px mark.
    """
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        grouped: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        for note in store.get("notes", []):
            # Archived notes remain browseable in the Notes view, but do not
            # advertise themselves as active annotations in the genome canvas.
            if bool(note.get("archived", False)):
                continue
            if not _note_target_matches(note, kind.strip(), genome_key.strip(), ""):
                continue
            target = note.get("target") or {}
            key = (
                str(target.get("kind") or ""),
                str(target.get("genome_key") or ""),
                str(target.get("id") or ""),
            )
            entry = grouped.get(key)
            if entry is None:
                grouped[key] = {
                    "kind": key[0],
                    "genome_key": key[1],
                    "target_id": key[2],
                    "label": str(target.get("label") or ""),
                    "count": 1,
                    "updated_at": note.get("updated_at") or "",
                }
                continue
            entry["count"] += 1
            if (note.get("updated_at") or "") > entry["updated_at"]:
                entry["updated_at"] = note.get("updated_at") or ""
                # The freshest note carries the most current symbol for the feature.
                entry["label"] = str(target.get("label") or "") or entry["label"]
        entries = sorted(grouped.values(), key=lambda e: e["updated_at"], reverse=True)
        return {"entries": entries}

    return await run_in_threadpool(_run)


@router.post("/api/notes", response_model=UserNoteModel)
async def create_user_note(request: UserNoteCreateRequest):
    """Create a note. Ids are minted here so a client bug cannot choose one."""
    target = _normalize_note_target(request.target.model_dump())
    title = str(request.title or "")[:MAX_NOTE_TITLE_CHARS]
    tags = _normalize_note_tags(request.tags, strict=True)
    if target["kind"] == "todo" and not title.strip():
        raise HTTPException(status_code=400, detail="A todo title is required")

    def _run():
        config = _notes_config()
        now = _utc_now_iso()
        status = _normalize_todo_status(request.status)
        completed = bool(request.completed) or status == "completed"
        if completed:
            status = "completed"
        note = {
            "id": _new_note_id(),
            "target": target,
            "title": title,
            "body": str(request.body or "")[:MAX_NOTE_BODY_CHARS],
            "tags": tags,
            "tags_updated_at": now if tags else "",
            "created_at": now,
            "updated_at": now,
            "archived": False,
            "archived_at": "",
            "status": status,
            "priority": _normalize_todo_priority(request.priority),
            "completed": completed,
            "completed_at": now if completed else "",
            "todo_order": int(request.todo_order or 0),
        }
        with _user_notes_lock:
            store = _load_user_notes(config)
            store["notes"] = [note] + list(store.get("notes", []))
            _save_user_notes(store, config)
        return note

    return await run_in_threadpool(_run)


@router.put("/api/notes/{note_id}/archive", response_model=UserNoteModel)
async def set_user_note_archived(note_id: str, request: UserNoteArchiveRequest):
    """Move a note into or out of the archive without changing its text."""
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
            if idx is None:
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            updated = dict(notes[idx])
            now = _utc_now_iso()
            updated["archived"] = bool(request.archived)
            updated["archived_at"] = now if request.archived else ""
            # Archive state participates in cross-store merge ordering and in
            # the client's compare-and-swap token just like any other edit.
            updated["updated_at"] = now
            notes[idx] = updated
            store["notes"] = notes
            _save_user_notes(store, config)
        return updated

    return await run_in_threadpool(_run)


@router.post("/api/notes/bulk-delete")
async def bulk_delete_user_notes(request: UserNoteBulkDeleteRequest):
    """Permanently delete an explicit set of note ids in one atomic write."""
    requested = list(dict.fromkeys(str(note_id or "").strip() for note_id in request.note_ids))
    requested = [note_id for note_id in requested if note_id]

    def _run():
        config = _notes_config()
        wanted = set(requested)
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            deleted = [note["id"] for note in notes if note.get("id") in wanted]
            if deleted:
                store["notes"] = [note for note in notes if note.get("id") not in wanted]
                _save_user_notes(store, config)
        return {"deleted": deleted, "count": len(deleted)}

    return await run_in_threadpool(_run)


@router.put("/api/notes/{note_id}", response_model=UserNoteModel)
async def update_user_note(note_id: str, request: UserNoteUpdateRequest):
    """Update a note's title or body.

    `updated_at` is a compare-and-swap against what the client last saw. It is
    what stops one window's autosave from silently overwriting an edit made in
    another — or in the file itself.
    """
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
            if idx is None:
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            current = notes[idx]
            expected = (request.updated_at or "").strip()
            if expected and expected != current.get("updated_at"):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "This note changed somewhere else since you loaded it.",
                        "note": current,
                    },
                )
            updated = dict(current)
            if request.title is not None:
                next_title = str(request.title)[:MAX_NOTE_TITLE_CHARS]
                if str((current.get("target") or {}).get("kind") or "") == "todo" and not next_title.strip():
                    raise HTTPException(status_code=400, detail="A todo title is required")
                updated["title"] = next_title
            if request.body is not None:
                updated["body"] = str(request.body)[:MAX_NOTE_BODY_CHARS]
            if request.tags is not None:
                tags = _normalize_note_tags(request.tags, strict=True)
                if tags != list(current.get("tags") or []):
                    updated["tags"] = tags
                    updated["tags_updated_at"] = _utc_now_iso()
            if request.status is not None:
                status = _normalize_todo_status(request.status)
                completed = status == "completed"
                updated["status"] = status
                updated["completed"] = completed
                updated["completed_at"] = _utc_now_iso() if completed else ""
            if request.priority is not None:
                updated["priority"] = _normalize_todo_priority(request.priority)
            if request.completed is not None:
                completed = bool(request.completed)
                updated["completed"] = completed
                updated["completed_at"] = _utc_now_iso() if completed else ""
                if completed:
                    updated["status"] = "completed"
                elif updated.get("status") == "completed":
                    updated["status"] = "in_progress"
            if request.todo_order is not None:
                updated["todo_order"] = int(request.todo_order)
            updated["updated_at"] = _utc_now_iso()
            notes[idx] = updated
            store["notes"] = notes
            _save_user_notes(store, config)
        return updated

    return await run_in_threadpool(_run)


@router.delete("/api/notes/{note_id}")
async def delete_user_note(note_id: str):
    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            notes = list(store.get("notes", []))
            remaining = [n for n in notes if n.get("id") != note_id]
            if len(remaining) == len(notes):
                raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
            store["notes"] = remaining
            _save_user_notes(store, config)
        return {"deleted": note_id}

    return await run_in_threadpool(_run)


# ═══════════════════════════════════════════════════════════════════════════════
#  Notes Transfer — export a selection, and import one back
# ═══════════════════════════════════════════════════════════════════════════════
#
# Notes are the one thing in this app the user cannot recreate: a genome can be
# re-downloaded and an annotation re-derived, but prose someone typed is gone.
# So the shape of this is deliberately cautious — an import is always scanned
# before it is applied, the destructive strategy takes a backup first, and the
# merge is recomputed at apply time rather than trusted from the scan.
#
# The serialising and the merge arithmetic live in notes_transfer, which imports
# nothing from here. Everything it produces is still run through
# _normalize_note_record before it is saved, so validation has one home.

MAX_EXPORT_NOTE_IDS = 50_000


# Todos first, then general notes, then genes — so a spreadsheet reads in the
# same order the Notes view does.
_NOTE_KIND_RANK = {"todo": 0, "genome": 1, "gene": 2}


class NotesExportRequest(BaseModel):
    directory: str
    filename: str
    format: str = "json"
    note_ids: List[str] = []
    # "create" refuses to touch an existing file so the UI can offer a choice,
    # matching the genome-config export.
    mode: str = "create"


class NotesImportScanRequest(BaseModel):
    path: str


class NotesImportApplyRequest(BaseModel):
    path: str
    # The file digest the scan reported. Apply refuses if the file moved since.
    digest: str = ""
    # The store digest the scan reported. Apply proceeds either way — autosave
    # fires every 600ms, so refusing would be maddening — but says whether the
    # notes moved under the user while they were reading the scan.
    store_digest: str = ""
    strategy: str = "newer_wins"


def _note_export_sort_key(note: Dict[str, Any]) -> Tuple[int, str, str, str]:
    target = note.get("target") or {}
    kind = str(target.get("kind") or "gene")
    return (
        _NOTE_KIND_RANK.get(kind, 3),
        str(target.get("genome_key") or ""),
        str(target.get("id") or ""),
        str(note.get("updated_at") or ""),
    )


def _read_transfer_file(path_value: str) -> Tuple[Path, bytes, str]:
    """Resolve, size-check and decode a file the user picked."""
    resolved = data_paths._resolve_user_file(path_value, "Notes")
    size = resolved.stat().st_size
    if size > notes_transfer.MAX_TRANSFER_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"That file is {size} bytes; the limit is {notes_transfer.MAX_TRANSFER_FILE_BYTES}.",
        )
    data = resolved.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"That file is not UTF-8 text, so it cannot be read as notes: {exc}",
        )
    return resolved, data, text


def _parse_transfer_file(path_value: str) -> Tuple[Path, bytes, Dict[str, Any], str]:
    resolved, data, text = _read_transfer_file(path_value)
    fmt = notes_transfer.sniff_transfer_format(resolved.name, text[:4096])
    parsed = notes_transfer.parse_transfer_text(text, fmt=fmt)
    return resolved, data, parsed, fmt


@router.post("/api/notes/export")
async def export_user_notes(payload: NotesExportRequest):
    directory_raw = str(payload.directory or "").strip()
    filename = str(payload.filename or "").strip()
    fmt = str(payload.format or "").strip().lower()
    mode = str(payload.mode or "create").strip().lower()
    note_ids = [str(note_id or "").strip() for note_id in (payload.note_ids or [])]
    note_ids = [note_id for note_id in note_ids if note_id]

    # Checked before safe_export_filename: its unknown-format fallback appends
    # ".{format}" verbatim, which is how ".json" works without a table entry —
    # and also how "exe" would sneak through if nothing validated first.
    if fmt not in notes_transfer.TRANSFER_FORMATS:
        raise HTTPException(
            status_code=400,
            detail="format must be one of: " + ", ".join(notes_transfer.TRANSFER_FORMATS),
        )
    if not directory_raw:
        raise HTTPException(status_code=400, detail="directory must not be empty")
    if not filename:
        raise HTTPException(status_code=400, detail="filename must not be empty")
    if not note_ids:
        raise HTTPException(status_code=400, detail="Select at least one note to export")
    if len(note_ids) > MAX_EXPORT_NOTE_IDS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many notes in one export; the limit is {MAX_EXPORT_NOTE_IDS}",
        )
    if mode not in {"create", "overwrite"}:
        raise HTTPException(status_code=400, detail="mode must be create or overwrite")

    def _run():
        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
            by_id = {str(note.get("id")): note for note in store.get("notes", [])}

        wanted = list(dict.fromkeys(note_ids))
        selected = [by_id[note_id] for note_id in wanted if note_id in by_id]
        missing = [note_id for note_id in wanted if note_id not in by_id]
        if not selected:
            raise HTTPException(status_code=404, detail="None of those notes are in the store")
        selected.sort(key=_note_export_sort_key)

        directory = Path(directory_raw).expanduser().resolve()
        safe_filename = safe_export_filename(filename, fmt)
        out_path = directory / safe_filename
        if mode == "create" and out_path.exists():
            raise HTTPException(status_code=409, detail=f"{safe_filename} already exists.")

        text = notes_transfer.serialise_notes(selected, fmt=fmt)
        directory.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
            os.replace(tmp_path, out_path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass

        return {
            "ok": True,
            "path": str(out_path),
            "filename": safe_filename,
            "format": fmt,
            "count": len(selected),
            "missing_ids": missing,
        }

    return await run_in_threadpool(_run)


@router.post("/api/notes/import/scan")
async def scan_user_notes_import(payload: NotesImportScanRequest):
    """Read a file and say what is in it, without changing anything.

    The statuses here are a preview, not a decision. Autosave can move the store
    while the user reads this, so apply recomputes the whole merge from a fresh
    load — see apply_user_notes_import.
    """

    def _run():
        resolved, data, parsed, fmt = _parse_transfer_file(payload.path)

        config = _notes_config()
        with _user_notes_lock:
            store = _load_user_notes(config)
        existing = list(store.get("notes", []))
        existing_by_id = {str(note.get("id")): note for note in existing}

        rows: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []
        summary = {
            "new": 0, "identical": 0, "differs": 0, "invalid": 0,
            "todos": 0, "notes": 0, "archived": 0,
        }

        for row in parsed.get("rows", []):
            note = row.get("note")
            errors = list(row.get("errors") or [])
            warnings = list(row.get("warnings") or [])

            if note is not None:
                # The same gate the create endpoint uses, so nothing can be
                # accepted here that the store would then reject.
                normalized = _normalize_note_record({**note, "id": note.get("id") or "pending"})
                if normalized is None:
                    note = None
                    errors.append("this row cannot be stored as a note")

            if note is None:
                summary["invalid"] += 1
                rows.append({
                    "line": row.get("line"),
                    "id": "",
                    "kind": "",
                    "genome_key": "",
                    "target_id": "",
                    "target_label": "",
                    "title": "",
                    "preview": "",
                    "tags": [],
                    "archived": False,
                    "updated_at": "",
                    "status": "invalid",
                    "errors": errors,
                    "warnings": warnings,
                })
                continue

            candidates.append(note)
            target = note.get("target") or {}
            kind = str(target.get("kind") or "gene")
            if kind == "todo":
                summary["todos"] += 1
            else:
                summary["notes"] += 1
            if note.get("archived"):
                summary["archived"] += 1
            body = str(note.get("body") or "")
            rows.append({
                "line": row.get("line"),
                "id": str(note.get("id") or ""),
                "kind": kind,
                "genome_key": str(target.get("genome_key") or ""),
                "target_id": str(target.get("id") or ""),
                "target_label": str(target.get("label") or ""),
                "title": str(note.get("title") or ""),
                "preview": body[:200],
                "tags": list(note.get("tags") or []),
                "archived": bool(note.get("archived")),
                "updated_at": str(note.get("updated_at") or ""),
                "status": "new",
                "errors": errors,
                "warnings": warnings,
            })

        diffs = notes_transfer.diff_against_store(candidates, existing_by_id)
        diff_iter = iter(diffs)
        for row in rows:
            if row["status"] == "invalid":
                continue
            diff = next(diff_iter)
            row["status"] = diff["status"]
            row["warnings"] = list(row["warnings"]) + list(diff["warnings"])
            summary[diff["status"]] += 1

        return {
            "format": fmt,
            "path": str(resolved),
            "filename": resolved.name,
            "bytes": len(data),
            "digest": notes_transfer.file_digest(data),
            "store_digest": notes_transfer.store_digest(existing),
            "schema_version": notes_transfer.TRANSFER_SCHEMA_VERSION,
            "total": len(rows),
            "applicable": len(candidates),
            "stored_total": len(existing),
            "rows": rows,
            "summary": summary,
            "near_duplicates": notes_transfer.find_near_duplicates(candidates, existing),
            "document_errors": list(parsed.get("document_errors") or []),
            "document_warnings": list(parsed.get("document_warnings") or []),
        }

    return await run_in_threadpool(_run)


@router.post("/api/notes/import/apply")
async def apply_user_notes_import(payload: NotesImportApplyRequest):
    strategy = str(payload.strategy or "").strip().lower()
    if strategy not in notes_transfer.MERGE_STRATEGIES:
        raise HTTPException(
            status_code=400,
            detail="strategy must be one of: " + ", ".join(notes_transfer.MERGE_STRATEGIES),
        )
    expected_digest = str(payload.digest or "").strip()
    scanned_store_digest = str(payload.store_digest or "").strip()

    def _run():
        # Parsing happens outside the lock: it can be slow, and it needs nothing
        # from the store.
        resolved, data, parsed, fmt = _parse_transfer_file(payload.path)

        if expected_digest and notes_transfer.file_digest(data) != expected_digest:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "file_changed",
                    "message": "That file changed after it was scanned. Scan it again before importing.",
                },
            )
        if parsed.get("document_errors"):
            raise HTTPException(status_code=400, detail="; ".join(parsed["document_errors"]))

        incoming: List[Dict[str, Any]] = []
        for note in notes_transfer.valid_notes(parsed):
            normalized = _normalize_note_record({
                **note,
                "id": str(note.get("id") or "").strip() or _new_note_id(),
            })
            if normalized is None:
                continue
            if normalized["target"]["kind"] == "todo" and not normalized["title"].strip():
                continue
            if not str(note.get("id") or "").strip():
                # Keep it blank so the merge mints an id under its own rules.
                normalized["id"] = ""
            incoming.append(normalized)

        if not incoming:
            raise HTTPException(status_code=400, detail="That file has no notes that can be imported")

        destructive = strategy == "replace_all"
        now = _utc_now_iso()
        config = _notes_config()

        with _user_notes_lock:
            store = _load_user_notes(config)
            existing = list(store.get("notes", []))
            before_digest = notes_transfer.store_digest(existing)

            merged, counts = notes_transfer.apply_merge(
                existing,
                incoming,
                strategy,
                now=now,
                mint_id=_new_note_id,
            )
            final = [
                record for record in (_normalize_note_record(note) for note in merged)
                if record is not None
            ]

            backup_paths: List[str] = []
            if destructive:
                backup_paths = _backup_user_notes_stores(config)

            store["version"] = USER_NOTES_STORE_VERSION
            store["notes"] = sorted(final, key=lambda n: n["updated_at"], reverse=True)

            if destructive:
                # Every store, or the union on the next load undoes the deletion.
                _save_user_notes_to_all_stores(store, config)
            else:
                _save_user_notes(store, config)

        return {
            "ok": True,
            "strategy": strategy,
            "format": fmt,
            "path": str(resolved),
            "total": len(incoming),
            "stored_total": len(store["notes"]),
            "backup_paths": backup_paths,
            "store_changed": bool(scanned_store_digest) and scanned_store_digest != before_digest,
            **counts,
        }

    return await run_in_threadpool(_run)
