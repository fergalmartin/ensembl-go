"""Notes import/export: the shapes on the way out, and the arithmetic on the way in.

Deliberately free of FastAPI and of ``main`` — this module does row↔record shape
work and merge arithmetic only, and hands ``main`` candidate records in the JSON
store shape. Every candidate still goes through ``main._normalize_note_record``
before it is saved, so validation has exactly one home and this file can be
unit-tested with nothing but the standard library.

Three formats, and they are not equals:

  * **JSON** is the store's own shape. It round-trips exactly, and it is what a
    backup should use.
  * **CSV/TSV** are a flat table for Excel and Google Sheets, one row per note,
    with the todo-only columns left blank on note rows so todos and notes can
    share one file. They are a *lossy view*: Excel truncates any cell over 32,767
    characters and a note body may be 200,000, so a spreadsheet round-trip can
    quietly drop the tail of a long note. Nothing here can fix that — it is a
    property of the medium — so the scan says so out loud instead.
"""

from __future__ import annotations

import contextlib
import csv
import hashlib
import io
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

TRANSFER_SCHEMA_VERSION = 1
TRANSFER_FORMATS = ("json", "csv", "tsv")
MERGE_STRATEGIES = ("newer_wins", "replace_matching", "add_as_new", "replace_all")

# Excel's hard per-cell limit. A body arriving at exactly this length is near
# certain evidence that a spreadsheet ate the rest of it.
SPREADSHEET_CELL_LIMIT = 32_767
MAX_TRANSFER_FILE_BYTES = 64 * 1024 * 1024

# Mirrors of main.py's caps. Duplicated rather than imported to keep this module
# free of main; main re-applies them anyway, so these only drive warnings.
MAX_NOTE_TITLE_CHARS = 200
MAX_NOTE_BODY_CHARS = 200_000

TRANSFER_COLUMNS = (
    "id",
    "kind",
    "genome_key",
    "genome_selection_key",
    "target_id",
    "target_label",
    "title",
    "body",
    "tags",
    "created_at",
    "updated_at",
    "archived",
    "archived_at",
    "todo_status",
    "todo_priority",
    "todo_completed",
    "todo_completed_at",
    "todo_order",
)

# Without these three a row cannot become a note, so their absence from a header
# is a whole-document failure rather than a per-row one.
REQUIRED_COLUMNS = ("id", "genome_key", "target_id")

# Tags are joined with "|" and never ",": _normalize_note_tags in main already
# rejects a comma inside a tag, so the pipe cannot collide and the split back is
# lossless.
TAG_SEPARATOR = "|"

# The fields the transfer schema actually carries. Comparisons use exactly these,
# so a CSV round-trip reports "identical" rather than "differs" over provenance
# fields (tags_updated_at) that no column holds.
COMPARED_FIELDS = (
    "title",
    "body",
    "tags",
    "created_at",
    "updated_at",
    "archived",
    "archived_at",
    "status",
    "priority",
    "completed",
    "completed_at",
    "todo_order",
)

TODO_STATUSES = frozenset(
    {"backlog", "next", "in_progress", "waiting", "blocked", "completed", "abandoned"}
)
TODO_PRIORITIES = frozenset({"low", "medium", "high"})

# A leading one of these makes a cell a live formula in Excel and Sheets, which
# is how =HYPERLINK and DDE payloads travel in exported data.
FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")

_TRUE_TOKENS = frozenset({"true", "1", "yes", "y", "t"})
_FALSE_TOKENS = frozenset({"false", "0", "no", "n", "f", ""})


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _dataset_stripped(value: Any) -> str:
    """The assembly half of a selection key.

    Mirrors main's _normalize_note_genome_key: notes are filed under the
    assembly, because a gene stable id outlives an annotation release.
    """
    token = _text(value).strip()
    marker = "::dataset::"
    idx = token.find(marker)
    return (token[:idx] if idx >= 0 else token).strip()


# ── spreadsheet safety ────────────────────────────────────────────────────────

def spreadsheet_guard(value: str) -> str:
    """Neutralise a cell that a spreadsheet would otherwise run as a formula."""
    token = _text(value)
    if token and token.startswith(FORMULA_LEAD):
        return "'" + token
    return token


def unguard_spreadsheet(value: str) -> str:
    """Inverse of :func:`spreadsheet_guard`.

    The apostrophe is only dropped when what follows would itself have been
    guarded, so a note that genuinely begins with an apostrophe survives.
    """
    token = _text(value)
    if len(token) > 1 and token[0] == "'" and token[1:].startswith(FORMULA_LEAD):
        return token[1:]
    return token


def _parse_bool(value: Any, *, default: bool = False) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    token = _text(value).strip().lower()
    if token in _TRUE_TOKENS:
        return True
    if token in _FALSE_TOKENS:
        return default if token == "" else False
    return None


def _parse_int(value: Any) -> Optional[int]:
    token = _text(value).strip()
    if not token:
        return 0
    try:
        return int(float(token))
    except (TypeError, ValueError, OverflowError):
        return None


def _looks_numeric(value: str) -> bool:
    """True for a bare number — a timestamp a spreadsheet turned into a serial."""
    token = _text(value).strip()
    if not token:
        return False
    try:
        float(token)
    except (TypeError, ValueError):
        return False
    return True


@contextlib.contextmanager
def _wide_csv_fields():
    """Let one parse read a full note body, then put the limit back.

    csv caps a field at 131,072 characters, which is below MAX_NOTE_BODY_CHARS —
    a long note raises _csv.Error mid-parse. The limit is process-wide global
    state, and main parses other people's TSVs where an enormous field really is
    a red flag, so it is raised only for the length of our own parse.
    """
    previous = csv.field_size_limit()
    csv.field_size_limit(max(previous, MAX_NOTE_BODY_CHARS * 2))
    try:
        yield
    finally:
        csv.field_size_limit(previous)


# ── record ↔ row ──────────────────────────────────────────────────────────────

def note_to_row(note: Mapping[str, Any]) -> Dict[str, str]:
    """One store record as a flat row of strings.

    The todo columns are blank for anything that is not a todo, which is what
    lets a single file carry the todo list and the genome notes together.
    """
    target = note.get("target") if isinstance(note.get("target"), dict) else {}
    kind = _text(target.get("kind")).strip() or "gene"
    is_todo = kind == "todo"

    row = {
        "id": _text(note.get("id")).strip(),
        "kind": kind,
        "genome_key": _dataset_stripped(target.get("genome_key")),
        "genome_selection_key": _text(target.get("genome_selection_key")).strip(),
        "target_id": _text(target.get("id")).strip(),
        "target_label": _text(target.get("label")).strip(),
        "title": _text(note.get("title")),
        "body": _text(note.get("body")),
        "tags": TAG_SEPARATOR.join(_text(tag) for tag in (note.get("tags") or [])),
        "created_at": _text(note.get("created_at")).strip(),
        "updated_at": _text(note.get("updated_at")).strip(),
        "archived": "true" if note.get("archived") else "false",
        "archived_at": _text(note.get("archived_at")).strip(),
        "todo_status": _text(note.get("status")).strip() if is_todo else "",
        "todo_priority": _text(note.get("priority")).strip() if is_todo else "",
        "todo_completed": ("true" if note.get("completed") else "false") if is_todo else "",
        "todo_completed_at": _text(note.get("completed_at")).strip() if is_todo else "",
        "todo_order": _text(note.get("todo_order")).strip() if is_todo else "",
    }
    return {column: row.get(column, "") for column in TRANSFER_COLUMNS}


def row_to_note(
    row: Mapping[str, Any],
    *,
    line: int,
) -> Tuple[Optional[Dict[str, Any]], List[str], List[str]]:
    """A flat row back into a candidate store record.

    Returns ``(note, errors, warnings)``. A row with errors yields ``None`` and
    is never applied. Timestamps are left exactly as they arrived — blank ones
    are filled at merge time, so this stays free of a clock.
    """
    errors: List[str] = []
    warnings: List[str] = []

    get = lambda key: unguard_spreadsheet(_text(row.get(key)))  # noqa: E731

    kind = get("kind").strip() or "gene"
    genome_key = _dataset_stripped(get("genome_key"))
    target_id = get("target_id").strip()

    if not genome_key:
        errors.append("genome_key is required")
    if not target_id:
        errors.append("target_id is required")

    title = get("title")
    body = get("body")

    if kind == "todo" and not title.strip():
        # Matches the rule POST /api/notes already enforces.
        errors.append("todo_title_required: a task needs a title")

    if len(title) > MAX_NOTE_TITLE_CHARS:
        warnings.append(f"title_truncated: over {MAX_NOTE_TITLE_CHARS} characters")
    if len(body) > MAX_NOTE_BODY_CHARS:
        warnings.append(f"body_truncated: over {MAX_NOTE_BODY_CHARS} characters")
    if len(body) == SPREADSHEET_CELL_LIMIT:
        warnings.append(
            "spreadsheet_truncated: body is exactly the Excel cell limit, "
            "so the rest of it was probably lost in a spreadsheet"
        )

    for stamp_field in ("created_at", "updated_at", "archived_at", "todo_completed_at"):
        raw_stamp = get(stamp_field).strip()
        if raw_stamp and _looks_numeric(raw_stamp):
            errors.append(
                f"timestamp_is_number: {stamp_field} is {raw_stamp!r}, which a "
                "spreadsheet converted to a date — re-export and try again"
            )

    archived = _parse_bool(row.get("archived"))
    if archived is None:
        errors.append(f"archived is not a yes/no value: {_text(row.get('archived'))!r}")
        archived = False

    is_todo = kind == "todo"
    completed = _parse_bool(row.get("todo_completed")) if is_todo else False
    if completed is None:
        errors.append(
            f"todo_completed is not a yes/no value: {_text(row.get('todo_completed'))!r}"
        )
        completed = False

    todo_order = _parse_int(row.get("todo_order")) if is_todo else 0
    if todo_order is None:
        warnings.append("todo_order is not a number; treated as 0")
        todo_order = 0

    status = get("todo_status").strip().lower()
    if status and status not in TODO_STATUSES:
        warnings.append(f"unknown todo_status {status!r}; treated as backlog")
        status = ""
    priority = get("todo_priority").strip().lower()
    if priority and priority not in TODO_PRIORITIES:
        warnings.append(f"unknown todo_priority {priority!r}; treated as medium")
        priority = ""

    tags = [tag.strip() for tag in get("tags").split(TAG_SEPARATOR)]
    tags = [tag for tag in tags if tag]

    if errors:
        return None, errors, warnings

    note = {
        "id": get("id").strip(),
        "target": {
            "kind": kind,
            "genome_key": genome_key,
            "id": target_id,
            "label": get("target_label").strip(),
            "genome_selection_key": get("genome_selection_key").strip(),
        },
        "title": title,
        "body": body,
        "tags": tags,
        "created_at": get("created_at").strip(),
        "updated_at": get("updated_at").strip(),
        "archived": archived,
        "archived_at": get("archived_at").strip(),
        "status": status or ("completed" if completed else "backlog"),
        "priority": priority or "medium",
        "completed": completed,
        "completed_at": get("todo_completed_at").strip(),
        "todo_order": todo_order,
    }
    return note, errors, warnings


def _note_from_json_record(
    raw: Any,
    *,
    line: int,
) -> Tuple[Optional[Dict[str, Any]], List[str], List[str]]:
    """A record from a JSON document, validated through the same gate as a row."""
    if not isinstance(raw, dict):
        return None, ["not an object"], []
    target = raw.get("target") if isinstance(raw.get("target"), dict) else {}
    # Route JSON through note_to_row so both formats share one validation path.
    row = note_to_row(
        {
            **raw,
            "target": {
                "kind": target.get("kind") or raw.get("kind") or "gene",
                "genome_key": target.get("genome_key") or raw.get("genome_key") or "",
                "id": target.get("id") or raw.get("target_id") or "",
                "label": target.get("label") or raw.get("target_label") or "",
                "genome_selection_key": target.get("genome_selection_key") or "",
            },
        }
    )
    return row_to_note(row, line=line)


# ── serialising ───────────────────────────────────────────────────────────────

def serialise_json(notes: Sequence[Mapping[str, Any]]) -> str:
    """The lossless format: the store's own shape, plus a little provenance."""
    document = {
        "schema_version": TRANSFER_SCHEMA_VERSION,
        "kind": "ensembl_go_notes",
        "count": len(notes),
        "notes": [dict(note) for note in notes],
    }
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def serialise_delimited(notes: Sequence[Mapping[str, Any]], *, delimiter: str) -> str:
    """The spreadsheet format. Every cell is formula-guarded on the way out."""
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=list(TRANSFER_COLUMNS),
        delimiter=delimiter,
        lineterminator="\r\n",
        quoting=csv.QUOTE_MINIMAL,
    )
    writer.writeheader()
    for note in notes:
        row = note_to_row(note)
        writer.writerow({key: spreadsheet_guard(value) for key, value in row.items()})
    return buffer.getvalue()


def serialise_notes(notes: Sequence[Mapping[str, Any]], *, fmt: str) -> str:
    if fmt == "json":
        return serialise_json(notes)
    if fmt == "csv":
        return serialise_delimited(notes, delimiter=",")
    if fmt == "tsv":
        return serialise_delimited(notes, delimiter="\t")
    raise ValueError(f"unknown transfer format: {fmt}")


# ── parsing ───────────────────────────────────────────────────────────────────

def sniff_transfer_format(filename: str, head: str) -> str:
    """Format from the extension, falling back to what the first bytes look like."""
    lowered = _text(filename).strip().lower()
    for fmt in TRANSFER_FORMATS:
        if lowered.endswith(f".{fmt}"):
            return fmt
    stripped = _text(head).lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    first_line = stripped.split("\n", 1)[0]
    return "tsv" if "\t" in first_line else "csv"


def parse_transfer_text(text: str, *, fmt: str) -> Dict[str, Any]:
    """Parse a whole document into candidate records.

    Returns ``{"format", "rows", "document_errors"}`` where each row is
    ``{"line", "note", "errors", "warnings"}``. A document error means nothing
    in the file can be applied.
    """
    if fmt not in TRANSFER_FORMATS:
        return {"format": fmt, "rows": [], "document_errors": [f"unknown format: {fmt}"]}

    if fmt == "json":
        return _parse_json_text(text)
    return _parse_delimited_text(text, delimiter="\t" if fmt == "tsv" else ",", fmt=fmt)


def _parse_json_text(text: str) -> Dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError as exc:
        return {"format": "json", "rows": [], "document_errors": [f"not valid JSON: {exc}"]}

    if isinstance(data, dict):
        records = data.get("notes")
    elif isinstance(data, list):
        records = data
    else:
        records = None

    if not isinstance(records, list):
        return {
            "format": "json",
            "rows": [],
            "document_errors": ['expected an object with a "notes" list, or a list of notes'],
        }

    rows = []
    for index, raw in enumerate(records):
        note, errors, warnings = _note_from_json_record(raw, line=index + 1)
        rows.append({"line": index + 1, "note": note, "errors": errors, "warnings": warnings})
    return {"format": "json", "rows": rows, "document_errors": []}


def _parse_delimited_text(text: str, *, delimiter: str, fmt: str) -> Dict[str, Any]:
    # A BOM is what Excel leaves behind on "CSV UTF-8"; strip it or the first
    # header cell is named "﻿id" and every row loses its id.
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter=delimiter)
    header = reader.fieldnames or []
    normalized = [_text(name).strip().lstrip("﻿") for name in header]

    if not normalized:
        return {"format": fmt, "rows": [], "document_errors": ["the file has no header row"]}

    missing = [column for column in REQUIRED_COLUMNS if column not in normalized]
    if missing:
        return {
            "format": fmt,
            "rows": [],
            "document_errors": [
                "the header is missing required column(s): " + ", ".join(missing)
            ],
        }

    document_warnings = []
    unknown = [name for name in normalized if name and name not in TRANSFER_COLUMNS]
    if unknown:
        document_warnings.append("ignoring unrecognised column(s): " + ", ".join(unknown))

    rows = []
    with _wide_csv_fields():
        for index, raw_row in enumerate(reader):
            # Header order does not matter — everything downstream is by name.
            row = {
                key: raw_row.get(original, "")
                for key, original in zip(normalized, header)
            }
            note, errors, warnings = row_to_note(row, line=index + 2)
            rows.append({"line": index + 2, "note": note, "errors": errors, "warnings": warnings})

    if not rows:
        return {
            "format": fmt,
            "rows": [],
            "document_errors": ["the file has a header but no data rows"],
        }

    return {
        "format": fmt,
        "rows": rows,
        "document_errors": [],
        "document_warnings": document_warnings,
    }


# ── diffing against what is already stored ────────────────────────────────────

def _comparable(note: Mapping[str, Any]) -> Tuple:
    return tuple(
        tuple(note.get(field) or []) if field == "tags" else note.get(field)
        for field in COMPARED_FIELDS
    )


def _same_target(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    a = left.get("target") or {}
    b = right.get("target") or {}
    return (
        _text(a.get("kind")) == _text(b.get("kind"))
        and _dataset_stripped(a.get("genome_key")) == _dataset_stripped(b.get("genome_key"))
        and _text(a.get("id")) == _text(b.get("id"))
    )


def diff_against_store(
    incoming: Sequence[Mapping[str, Any]],
    existing_by_id: Mapping[str, Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """Classify each incoming record against the store: new, identical or differs.

    This is a *preview* only. The merge is recomputed from a freshly loaded
    store at apply time, because autosave can move the store while the user is
    still reading the scan.
    """
    out = []
    for note in incoming:
        note_id = _text(note.get("id")).strip()
        existing = existing_by_id.get(note_id) if note_id else None
        warnings: List[str] = []

        if existing is None:
            status = "new"
        elif _comparable(note) == _comparable(existing) and _same_target(note, existing):
            status = "identical"
        else:
            status = "differs"
            if not _same_target(note, existing):
                warnings.append(
                    "target_changed: this id is already filed under a different "
                    "gene or genome, and importing will move it"
                )
            if _is_blank(note) and not _is_blank(existing):
                warnings.append(
                    "would_blank_existing: the imported copy is empty where the "
                    "stored one is not"
                )
        out.append({"id": note_id, "status": status, "warnings": warnings})
    return out


def _is_blank(note: Mapping[str, Any]) -> bool:
    return not _text(note.get("title")).strip() and not _text(note.get("body")).strip()


def find_near_duplicates(
    incoming: Sequence[Mapping[str, Any]],
    existing: Sequence[Mapping[str, Any]],
) -> List[Dict[str, str]]:
    """Incoming notes that look like a stored note but carry a different id.

    Reported, never merged. Two people writing about the same gene is normal,
    and silently collapsing their notes into one would destroy prose.
    """
    by_signature: Dict[Tuple[str, str, str, str], List[str]] = {}
    for note in existing:
        target = note.get("target") or {}
        signature = (
            _text(target.get("kind")),
            _dataset_stripped(target.get("genome_key")),
            _text(target.get("id")),
            _text(note.get("title")).strip().lower(),
        )
        by_signature.setdefault(signature, []).append(_text(note.get("id")))

    existing_ids = {_text(note.get("id")) for note in existing}
    out = []
    for note in incoming:
        title = _text(note.get("title")).strip()
        if not title:
            # An empty title is not a signature — every untitled note on a gene
            # would look like every other one.
            continue
        note_id = _text(note.get("id")).strip()
        if note_id in existing_ids:
            continue
        target = note.get("target") or {}
        signature = (
            _text(target.get("kind")),
            _dataset_stripped(target.get("genome_key")),
            _text(target.get("id")),
            title.lower(),
        )
        for match_id in by_signature.get(signature, []):
            out.append(
                {
                    "incoming_id": note_id,
                    "existing_id": match_id,
                    "title": title,
                    "target_id": _text(target.get("id")),
                    "genome_key": _dataset_stripped(target.get("genome_key")),
                }
            )
    return out


# ── merging ───────────────────────────────────────────────────────────────────

def apply_merge(
    existing: Sequence[Mapping[str, Any]],
    incoming: Sequence[Mapping[str, Any]],
    strategy: str,
    *,
    now: str,
    mint_id,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Fold the imported notes into the stored ones.

    ``replace_matching`` stamps ``updated_at = now`` on everything it actually
    changes. That is not cosmetic: ``_load_user_notes`` unions every store it can
    read and keeps the later ``updated_at``, so a file that "wins" has to win
    that union too, or a second store's older copy reappears on the next load.
    ``newer_wins`` and ``add_as_new`` keep the incoming timestamps, which is what
    makes moving notes between machines mean anything.
    """
    if strategy not in MERGE_STRATEGIES:
        raise ValueError(f"unknown merge strategy: {strategy}")

    existing_list = [dict(note) for note in existing]
    existing_by_id = {_text(note.get("id")): note for note in existing_list}
    counts = {"added": 0, "updated": 0, "skipped": 0, "unchanged": 0, "deleted": 0}

    prepared: List[Dict[str, Any]] = []
    for note in incoming:
        candidate = dict(note)
        candidate["target"] = dict(candidate.get("target") or {})
        if not _text(candidate.get("created_at")).strip():
            candidate["created_at"] = now
        if not _text(candidate.get("updated_at")).strip():
            candidate["updated_at"] = candidate["created_at"]
        prepared.append(candidate)

    if strategy == "add_as_new":
        result = existing_list + []
        for candidate in prepared:
            candidate["id"] = mint_id()
            result.append(candidate)
            counts["added"] += 1
        return result, counts

    if strategy == "replace_all":
        kept: Dict[str, Dict[str, Any]] = {}
        for candidate in prepared:
            note_id = _text(candidate.get("id")).strip() or mint_id()
            candidate["id"] = note_id
            if note_id in existing_by_id:
                counts["updated"] += 1
            else:
                counts["added"] += 1
            kept[note_id] = candidate
        counts["deleted"] = sum(1 for note_id in existing_by_id if note_id not in kept)
        return list(kept.values()), counts

    merged: Dict[str, Dict[str, Any]] = {
        _text(note.get("id")): note for note in existing_list
    }
    order: List[str] = [_text(note.get("id")) for note in existing_list]

    for candidate in prepared:
        note_id = _text(candidate.get("id")).strip()
        if not note_id:
            note_id = mint_id()
            candidate["id"] = note_id

        current = merged.get(note_id)
        if current is None:
            merged[note_id] = candidate
            order.append(note_id)
            counts["added"] += 1
            continue

        if strategy == "newer_wins":
            if _is_blank(candidate) and not _is_blank(current):
                # "replace with the more recent timestamp if not empty" — a
                # newer-but-empty row must never wipe a paragraph.
                counts["skipped"] += 1
                continue
            if _text(candidate.get("updated_at")) > _text(current.get("updated_at")):
                merged[note_id] = candidate
                counts["updated"] += 1
            else:
                counts["unchanged"] += 1
            continue

        # replace_matching: the file wins, but only where it actually differs,
        # so a no-op import does not reshuffle a list sorted by updated_at.
        if _comparable(candidate) == _comparable(current) and _same_target(candidate, current):
            counts["unchanged"] += 1
            continue
        candidate["updated_at"] = now
        merged[note_id] = candidate
        counts["updated"] += 1

    return [merged[note_id] for note_id in order], counts


def store_digest(notes: Sequence[Mapping[str, Any]]) -> str:
    """A fingerprint of what is stored, so apply can tell if it moved mid-review."""
    lines = sorted(
        f"{_text(note.get('id'))}\t{_text(note.get('updated_at'))}" for note in notes
    )
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def file_digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def valid_notes(parsed: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """The records from a parse result that are actually applicable."""
    if parsed.get("document_errors"):
        return []
    return [row["note"] for row in parsed.get("rows", []) if row.get("note") is not None]
