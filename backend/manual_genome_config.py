"""Portable JSON configuration for genomes registered from local files.

The document describes any genome the Genome Selector knows about — downloaded,
manually added, or previously imported — with enough metadata and enough file
paths to reproduce the selector row exactly when the files are already present.

Two format names are accepted on read:

``ensembl-local-genomes`` (version 2)
    The current shape. Carries full identity (provider, species key, assembly
    name, dataset release, display names) and every file type in
    :data:`BUNDLE_FILE_TYPES`.

``ensembl-local-manual-genomes`` (version 1)
    The original manual-only shape: species, assembly, accession and the three
    file keys ``fasta`` / ``annotation`` / ``homologies``. Still readable; those
    two legacy file keys alias onto ``gff3`` / ``homology`` so hand-written
    documents keep working.

Only ``files.fasta`` is required. Any other file that is listed but not present
on disk is reported as a warning and recorded in the entry's ``missing_files``
rather than invalidating the whole genome — the caller loads what it can and
shows the user what was missing.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


FORMAT = "ensembl-local-genomes"
LEGACY_FORMAT = "ensembl-local-manual-genomes"
SUPPORTED_FORMATS = frozenset({FORMAT, LEGACY_FORMAT})

VERSION = 2
SUPPORTED_VERSIONS = frozenset({1, 2})

#: Canonical file types a bundle may carry, in the order they are written and
#: displayed. These match the app's internal file-type keys.
BUNDLE_FILE_TYPES: Tuple[str, ...] = (
    "fasta",
    "gff3",
    "homology",
    "index",
    "metadata",
    "cdna",
    "protein",
    "xref",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
    "gtf",
    "embl",
    "alignment",
    "other_annotation",
)
_BUNDLE_FILE_TYPE_SET = frozenset(BUNDLE_FILE_TYPES)

#: Version 1 spelled two of the file keys differently. Both are accepted on read.
FILE_KEY_ALIASES: Dict[str, str] = {
    "annotation": "gff3",
    "homologies": "homology",
}

#: A genome without sequence cannot be opened, so this one is a hard requirement.
REQUIRED_FILE_TYPE = "fasta"

#: A key we accept as a file type even though it is not in BUNDLE_FILE_TYPES.
_FILE_TYPE_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")

_DATASET_RELEASE_FIELDS = ("key", "source", "date", "label", "short_label")

_IDENTITY_FIELDS = (
    "species_key",
    "common_name",
    "display_name",
    "display_name_reason",
    "assembly_name",
    "provider",
    "source_database",
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _diagnostic(
    severity: str,
    message: str,
    *,
    index: Optional[int] = None,
    field: str = "",
) -> Dict[str, Any]:
    result: Dict[str, Any] = {"severity": severity, "message": message}
    if index is not None:
        result["index"] = index
    if field:
        result["field"] = field
    return result


def _resolve_file(
    value: Any,
    base_dir: Path,
    *,
    index: int,
    field: str,
    required: bool,
) -> Tuple[str, List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Resolve one declared file path.

    Returns ``(resolved_path, diagnostics, missing)``. A file that is listed but
    cannot be used yields an empty path plus a ``missing`` record, so the caller
    can distinguish "not listed" from "listed but not found". The severity is an
    error only for the required file; everything else degrades to a warning.
    """
    text = _text(value)
    if not text:
        if required:
            return "", [_diagnostic("error", f"{field} is required.", index=index, field=field)], None
        return "", [], None

    severity = "error" if required else "warning"
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        candidate = base_dir / candidate
    try:
        candidate = candidate.resolve()
    except OSError as exc:
        return (
            "",
            [_diagnostic(severity, f"Invalid {field} path: {exc}", index=index, field=field)],
            {"field": field, "path": text, "reason": "invalid"},
        )

    if not candidate.is_file():
        return (
            "",
            [_diagnostic(severity, f"File not found: {candidate}", index=index, field=field)],
            {"field": field, "path": str(candidate), "reason": "not_found"},
        )
    if not os.access(candidate, os.R_OK):
        return (
            "",
            [_diagnostic(severity, f"File is not readable: {candidate}", index=index, field=field)],
            {"field": field, "path": str(candidate), "reason": "unreadable"},
        )
    return str(candidate), [], None


def _collect_declared_files(raw_files: Dict[str, Any]) -> Dict[str, Any]:
    """Map a document's ``files`` object onto canonical file-type keys.

    Canonical keys win over their legacy aliases when a document carries both.
    Known types come first in :data:`BUNDLE_FILE_TYPES` order; any other
    plausible file-type key is kept afterwards rather than dropped, so a type
    added elsewhere in the app still round-trips without a change here.
    """
    collected: Dict[str, Any] = {}
    for file_type in BUNDLE_FILE_TYPES:
        if _text(raw_files.get(file_type)):
            collected[file_type] = raw_files[file_type]
    for alias, canonical in FILE_KEY_ALIASES.items():
        if canonical not in collected and _text(raw_files.get(alias)):
            collected[canonical] = raw_files[alias]
    known = set(BUNDLE_FILE_TYPES) | set(FILE_KEY_ALIASES)
    for key in sorted(raw_files):
        if key in known or not _FILE_TYPE_KEY_RE.match(str(key)):
            continue
        if _text(raw_files.get(key)):
            collected[str(key)] = raw_files[key]
    return collected


def _normalize_playlists(
    value: Any,
    *,
    index: int,
) -> Tuple[List[str], List[Dict[str, Any]]]:
    if value is None:
        return [], []
    if not isinstance(value, list):
        return [], [
            _diagnostic(
                "error",
                "playlists must be an array of non-empty strings.",
                index=index,
                field="playlists",
            )
        ]

    playlists: List[str] = []
    seen: set[str] = set()
    diagnostics: List[Dict[str, Any]] = []
    for playlist_index, raw_name in enumerate(value):
        if not isinstance(raw_name, str) or not raw_name.strip():
            diagnostics.append(
                _diagnostic(
                    "error",
                    "Playlist names must be non-empty strings.",
                    index=index,
                    field=f"playlists.{playlist_index}",
                )
            )
            continue
        name = " ".join(raw_name.split())
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        playlists.append(name)
    return playlists, diagnostics


def _normalize_playlist_metadata(value: Any) -> List[Dict[str, str]]:
    """Normalize the optional top-level ``playlists`` block.

    Entries may be bare names or ``{name, description}`` objects. Names are
    whitespace-collapsed and deduped case-insensitively, matching the per-genome
    membership rules so the two always agree.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("playlists must be an array of playlist objects.")

    result: List[Dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, str):
            name = " ".join(item.split())
            description = ""
        elif isinstance(item, dict):
            name = " ".join(_text(item.get("name")).split())
            description = _text(item.get("description"))
        else:
            continue
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        entry: Dict[str, str] = {"name": name}
        if description:
            entry["description"] = description
        result.append(entry)
    return result


def _normalize_dataset_release(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    release = {field: _text(value.get(field)) for field in _DATASET_RELEASE_FIELDS}
    if not any(release.values()):
        return {}
    return {field: text for field, text in release.items() if text}


def _normalize_accession_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    result: List[str] = []
    seen: set[str] = set()
    for item in value:
        accession = _text(item).upper()
        if not accession or accession in seen:
            continue
        seen.add(accession)
        result.append(accession)
    return result


def parse_manual_genome_config(path_value: str) -> Dict[str, Any]:
    """Read and validate a portable genome bundle.

    Every source entry is returned so the UI can produce a best-effort summary.
    Valid entries include absolute, resolved file paths for the files that exist,
    and a ``missing_files`` list for the ones that were declared but are not
    usable.
    """
    token = _text(path_value)
    if not token:
        raise ValueError("A configuration path is required.")
    path = Path(token).expanduser()
    try:
        path = path.resolve()
    except OSError as exc:
        raise ValueError(f"Invalid configuration path: {exc}") from exc
    if not path.is_file():
        raise FileNotFoundError(f"Configuration file not found: {path}")

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    except OSError as exc:
        raise ValueError(f"Could not read configuration: {exc}") from exc

    diagnostics: List[Dict[str, Any]] = []
    if not isinstance(payload, dict):
        raise ValueError("The configuration must contain a JSON object.")

    document_format = _text(payload.get("format"))
    if document_format not in SUPPORTED_FORMATS:
        diagnostics.append(
            _diagnostic(
                "error",
                f"format must be one of: {', '.join(sorted(SUPPORTED_FORMATS))}.",
                field="format",
            )
        )
    document_version = payload.get("version")
    if document_version not in SUPPORTED_VERSIONS:
        diagnostics.append(
            _diagnostic(
                "error",
                f"version must be one of: {', '.join(str(item) for item in sorted(SUPPORTED_VERSIONS))}.",
                field="version",
            )
        )

    raw_genomes = payload.get("genomes")
    if not isinstance(raw_genomes, list):
        diagnostics.append(_diagnostic("error", "genomes must be an array.", field="genomes"))
        raw_genomes = []

    try:
        playlist_metadata = _normalize_playlist_metadata(payload.get("playlists"))
    except ValueError as exc:
        playlist_metadata = []
        diagnostics.append(_diagnostic("error", str(exc), field="playlists"))

    top_level_error = any(
        item["severity"] == "error" and "index" not in item for item in diagnostics
    )
    entries: List[Dict[str, Any]] = []
    if not top_level_error:
        for index, raw in enumerate(raw_genomes):
            entries.append(_parse_entry(raw, index=index, base_dir=path.parent))
            diagnostics.extend(entries[-1]["diagnostics"])

    return {
        "ok": not any(item["severity"] == "error" and "index" not in item for item in diagnostics),
        "path": str(path),
        "format": document_format or FORMAT,
        "version": document_version if document_version in SUPPORTED_VERSIONS else VERSION,
        "created_at": _text(payload.get("created_at")),
        "playlists": playlist_metadata,
        "total_count": len(raw_genomes),
        "valid_count": sum(1 for entry in entries if entry["valid"]),
        "entries": entries,
        "diagnostics": diagnostics,
    }


def _parse_entry(raw: Any, *, index: int, base_dir: Path) -> Dict[str, Any]:
    entry_diagnostics: List[Dict[str, Any]] = []
    if not isinstance(raw, dict):
        entry_diagnostics.append(
            _diagnostic("error", "Genome entry must be an object.", index=index)
        )
        return {
            "index": index,
            "valid": False,
            "genome": None,
            "missing_files": [],
            "diagnostics": entry_diagnostics,
        }

    species = _text(raw.get("species"))
    assembly = _text(raw.get("assembly"))
    accession = _text(raw.get("accession"))
    if not species:
        entry_diagnostics.append(
            _diagnostic("error", "species is required.", index=index, field="species")
        )
    if not assembly:
        entry_diagnostics.append(
            _diagnostic("error", "assembly is required.", index=index, field="assembly")
        )

    raw_files = raw.get("files")
    if not isinstance(raw_files, dict):
        entry_diagnostics.append(
            _diagnostic("error", "files must be an object.", index=index, field="files")
        )
        raw_files = {}
    declared_files = _collect_declared_files(raw_files)

    files: Dict[str, str] = {}
    missing_files: List[Dict[str, Any]] = []
    # The required file is resolved first so its diagnostic leads the list;
    # declared_files is already canonical-then-extras ordered.
    resolve_order = [REQUIRED_FILE_TYPE] + [
        file_type for file_type in declared_files if file_type != REQUIRED_FILE_TYPE
    ]
    for file_type in resolve_order:
        required = file_type == REQUIRED_FILE_TYPE
        resolved, file_diagnostics, missing = _resolve_file(
            declared_files.get(file_type),
            base_dir,
            index=index,
            field=f"files.{file_type}",
            required=required,
        )
        entry_diagnostics.extend(file_diagnostics)
        if missing:
            missing_files.append(missing)
        if resolved:
            files[file_type] = resolved

    playlists, playlist_errors = _normalize_playlists(raw.get("playlists"), index=index)
    entry_diagnostics.extend(playlist_errors)

    genome: Dict[str, Any] = {
        "species": species,
        "assembly": assembly,
        "accession": accession,
        "equivalent_accessions": _normalize_accession_list(raw.get("equivalent_accessions")),
        "dataset_release": _normalize_dataset_release(raw.get("dataset_release")),
        "playlists": playlists,
        "files": files,
        "missing_files": missing_files,
    }
    for field in _IDENTITY_FIELDS:
        genome[field] = _text(raw.get(field))
    if not genome["provider"]:
        genome["provider"] = "manual"
    if not genome["assembly_name"]:
        genome["assembly_name"] = assembly

    valid = not any(item["severity"] == "error" for item in entry_diagnostics)
    return {
        "index": index,
        "valid": valid,
        "genome": genome,
        "missing_files": missing_files,
        "diagnostics": entry_diagnostics,
    }


def _portable_path(value: Any, base_dir: Path) -> str:
    text = _text(value)
    if not text:
        return ""
    path = Path(text).expanduser()
    try:
        resolved = path.resolve()
        return str(resolved.relative_to(base_dir))
    except (OSError, ValueError):
        return str(path)


def manual_genome_document(
    genomes: Iterable[Dict[str, Any]],
    destination: Path,
    playlists: Any = None,
) -> Dict[str, Any]:
    """Build the serialisable bundle document.

    Unlike parsing, this fails fast: the caller is the app itself, so a record
    that cannot be described portably is a bug worth surfacing rather than a
    partial export.
    """
    base_dir = destination.parent.resolve()
    result: List[Dict[str, Any]] = []
    for index, raw in enumerate(genomes):
        if not isinstance(raw, dict):
            raise ValueError(f"Genome {index + 1} must be an object.")
        species = _text(raw.get("species"))
        assembly = _text(raw.get("assembly"))
        if not species or not assembly:
            raise ValueError(f"Genome {index + 1} requires species and assembly.")
        raw_files = raw.get("files") if isinstance(raw.get("files"), dict) else {}
        declared_files = _collect_declared_files(raw_files)
        if not _text(declared_files.get(REQUIRED_FILE_TYPE)):
            raise ValueError(f"Genome {index + 1} requires files.fasta.")

        record: Dict[str, Any] = {"species": species, "assembly": assembly}
        for field in _IDENTITY_FIELDS:
            value = _text(raw.get(field))
            if value:
                record[field] = value
        accession = _text(raw.get("accession"))
        if accession:
            record["accession"] = accession
        equivalent = _normalize_accession_list(raw.get("equivalent_accessions"))
        if equivalent:
            record["equivalent_accessions"] = equivalent
        dataset_release = _normalize_dataset_release(raw.get("dataset_release"))
        if dataset_release:
            record["dataset_release"] = dataset_release

        record["files"] = {
            file_type: _portable_path(value, base_dir)
            for file_type, value in declared_files.items()
        }

        genome_playlists, playlist_errors = _normalize_playlists(raw.get("playlists"), index=index)
        if playlist_errors:
            raise ValueError(f"Genome {index + 1}: {playlist_errors[0]['message']}")
        if genome_playlists:
            record["playlists"] = genome_playlists
        result.append(record)

    document: Dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    playlist_metadata = _normalize_playlist_metadata(playlists)
    if playlist_metadata:
        document["playlists"] = playlist_metadata
    document["genomes"] = result
    return document


def _entry_identity(record: Dict[str, Any]) -> Tuple[str, ...]:
    """Identity used to avoid duplicating a genome when amending a bundle.

    Mirrors the selector's own duplicate rule: accession when there is one,
    otherwise the species/assembly labels — and in both cases the dataset
    release, because two releases of one assembly are distinct genomes.
    """
    release = _text((record.get("dataset_release") or {}).get("key"))
    accession = _text(record.get("accession")).upper()
    if accession:
        return ("accession", accession, release)
    species = " ".join(_text(record.get("species")).split()).casefold()
    assembly = " ".join(
        _text(record.get("assembly_name") or record.get("assembly")).split()
    ).casefold()
    return ("label", species, assembly, release)


def _merge_documents(
    existing: Dict[str, Any],
    incoming: Dict[str, Any],
) -> Tuple[Dict[str, Any], int, int]:
    """Fold new genomes into an existing bundle without duplicating anything.

    A genome already in the file is replaced by the incoming record rather than
    appended, so amending refreshes paths instead of leaving a stale copy.
    """
    merged_genomes: List[Dict[str, Any]] = [
        record for record in (existing.get("genomes") or []) if isinstance(record, dict)
    ]
    positions = {_entry_identity(record): index for index, record in enumerate(merged_genomes)}

    added = 0
    updated = 0
    for record in incoming.get("genomes") or []:
        identity = _entry_identity(record)
        if identity in positions:
            merged_genomes[positions[identity]] = record
            updated += 1
        else:
            positions[identity] = len(merged_genomes)
            merged_genomes.append(record)
            added += 1

    # Union the playlist metadata, keeping any description already on file
    # unless the incoming one fills a gap.
    playlists: List[Dict[str, str]] = []
    seen: Dict[str, int] = {}
    for entry in _normalize_playlist_metadata(existing.get("playlists")) + _normalize_playlist_metadata(
        incoming.get("playlists")
    ):
        key = entry["name"].casefold()
        if key in seen:
            current = playlists[seen[key]]
            if not current.get("description") and entry.get("description"):
                current["description"] = entry["description"]
            continue
        seen[key] = len(playlists)
        playlists.append(dict(entry))

    document = dict(incoming)
    if playlists:
        document["playlists"] = playlists
    else:
        document.pop("playlists", None)
    document["genomes"] = merged_genomes
    return document, added, updated


def save_manual_genome_config(
    path_value: str,
    genomes: Iterable[Dict[str, Any]],
    playlists: Any = None,
    mode: str = "overwrite",
) -> Dict[str, Any]:
    """Write a bundle.

    ``mode`` is one of ``create`` (refuse to touch an existing file, raising
    :class:`FileExistsError`), ``overwrite`` or ``merge``.
    """
    normalized_mode = _text(mode).lower() or "overwrite"
    if normalized_mode not in {"create", "overwrite", "merge"}:
        raise ValueError(f"Unknown save mode: {mode}")

    token = _text(path_value)
    if not token:
        raise ValueError("A destination path is required.")
    destination = Path(token).expanduser()
    try:
        destination = destination.resolve()
    except OSError as exc:
        raise ValueError(f"Invalid destination path: {exc}") from exc
    if not destination.suffix:
        destination = destination.with_suffix(".json")
    elif destination.suffix.lower() != ".json":
        raise ValueError(f"Genome configurations must be saved as .json: {destination.name}")
    if not destination.parent.is_dir():
        raise ValueError(f"Destination directory does not exist: {destination.parent}")

    exists = destination.exists()
    if exists and not destination.is_file():
        raise ValueError(f"Destination is not a file: {destination}")
    if exists and normalized_mode == "create":
        raise FileExistsError(str(destination))

    document = manual_genome_document(genomes, destination, playlists)
    added = len(document["genomes"])
    updated = 0
    if exists and normalized_mode == "merge":
        try:
            previous = json.loads(destination.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"Could not amend {destination.name}; it is not readable as JSON: {exc}"
            ) from exc
        if not isinstance(previous, dict):
            raise ValueError(f"Could not amend {destination.name}; it is not a bundle.")
        document, added, updated = _merge_documents(previous, document)

    fd, temp_path = tempfile.mkstemp(
        dir=str(destination.parent),
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2)
            handle.write("\n")
        os.replace(temp_path, destination)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    return {
        "ok": True,
        "path": str(destination),
        "count": len(document["genomes"]),
        "mode": normalized_mode,
        "added": added,
        "updated": updated,
    }
