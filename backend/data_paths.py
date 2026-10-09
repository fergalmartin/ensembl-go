"""Where a genome's files live under the output directory, and the checks that
keep user-supplied path segments, file names and download URLs inside it."""

import re
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from genome_identity import (
    DEFAULT_PROVIDER,
    is_assembly_report_filename,
    is_metadata_filename,
    normalize_provider,
    storage_path_parts,
)
from security_utils import sanitize_leaf_filename, validate_remote_download_url


_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_path_segment(name: str, value: str) -> str:
    value = (value or "").strip()
    if not value or value in {".", ".."} or not _SAFE_SEGMENT_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {name}: {value!r}")
    return value


def _resolve_local_data_root(output_dir: str) -> Path:
    output_root = Path(output_dir).expanduser().resolve()
    local_data = output_root / "local_data"
    if local_data.exists() and local_data.is_symlink():
        raise HTTPException(status_code=400, detail="local_data may not be a symlink")
    return local_data.resolve()


def _resolve_species_assembly_dir(
    output_dir: str,
    species_key: str,
    assembly: str,
    provider: str = DEFAULT_PROVIDER,
) -> Path:
    root = _resolve_local_data_root(output_dir)
    safe_species = _validate_path_segment("species_key", species_key)
    safe_assembly = _validate_path_segment("assembly", assembly)
    candidate = root
    normalized_provider = normalize_provider(provider)
    for segment in storage_path_parts(normalized_provider, safe_species, safe_assembly):
        candidate = candidate / _validate_path_segment("path segment", segment)
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid species/assembly path")
    return candidate


def _validate_download_url(url: str) -> str:
    return validate_remote_download_url(url)


def _is_assembly_report_filename(filename: str) -> bool:
    return is_assembly_report_filename(filename)


def _is_metadata_filename(filename: str) -> bool:
    return is_metadata_filename(filename)


def _find_assembly_report_file(assembly_dir: Path) -> Optional[Path]:
    if not assembly_dir or not assembly_dir.is_dir():
        return None
    candidates = sorted(
        [p for p in assembly_dir.iterdir() if p.is_file() and _is_metadata_filename(p.name)],
        key=lambda p: p.name,
    )
    return candidates[0] if candidates else None
    return url


def _sanitize_filename(filename: str) -> str:
    return sanitize_leaf_filename(filename)


def _assembly_report_taxid(path: str) -> int:
    """Taxid from an NCBI-style assembly report header ('# Taxid: 9606')."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.startswith("#"):
                    break
                match = re.match(r"#\s*Taxid:\s*(\d+)", line)
                if match:
                    return int(match.group(1))
    except Exception:
        return 0
    return 0
