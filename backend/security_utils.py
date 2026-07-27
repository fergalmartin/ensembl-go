"""Security helpers for the desktop-local backend.

These helpers intentionally keep policy decisions small and explicit so the
main API file can enforce them consistently at filesystem and URL boundaries.
"""

import ipaddress
import os
import re
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import unquote, urlparse, urlunparse

from fastapi import HTTPException


ENSEMBL_FTP_HOST = "ftp.ebi.ac.uk"
ENSEMBL_PATH_PREFIX = "/pub/ensemblorganisms/"
ENSEMBL_COMPARA_FTP_HOST = "ftp.ensembl.org"
ENSEMBL_PAIRWISE_ALIGNMENT_PATH_RE = re.compile(
    r"^/pub/release-\d+/maf/ensembl-compara/pairwise_alignments/[^/]+\.tar\.gz$"
)
NCBI_FTP_HOST = "ftp.ncbi.nlm.nih.gov"
NCBI_API_HOST = "api.ncbi.nlm.nih.gov"
NCBI_DATASETS_ACCESSION_PATH_RE = re.compile(
    r"^/datasets/v2/genome/accession/GC[AF]_\d+\.\d+/(?:download|sequence_reports)$"
)
NCBI_DATASETS_FETCH_PATH_RE = re.compile(
    r"^/datasets/fetch_h/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$"
)

CONFIG_EXPORT_EXTENSIONS = {".cfg", ".json"}
EXPORT_FORMAT_EXTENSIONS = {
    "svg": ".svg",
    "png": ".png",
    "jpeg": ".jpg",
    "jpg": ".jpg",
    "txt": ".txt",
    "tsv": ".tsv",
    "csv": ".csv",
    "fasta": ".fa",
    "fa": ".fa",
}

PRIVATE_HOST_NAMES = {"localhost", "localhost.localdomain"}


def is_loopback_host(host: Optional[str]) -> bool:
    token = str(host or "").strip().strip("[]").lower()
    if not token:
        return False
    if token in PRIVATE_HOST_NAMES:
        return True
    try:
        return ipaddress.ip_address(token).is_loopback
    except ValueError:
        return False


def is_private_url_host(host: Optional[str]) -> bool:
    token = str(host or "").strip().strip("[]").lower()
    if not token:
        return True
    if token in PRIVATE_HOST_NAMES or token.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(token)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local or address.is_reserved


def require_loopback_client(host: Optional[str]) -> None:
    if os.environ.get("ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK") == "1":
        return
    if not host or is_loopback_host(host):
        return
    raise HTTPException(status_code=403, detail="Only loopback clients are allowed")


def validate_backend_bind_host(host: str) -> str:
    token = str(host or "").strip() or "127.0.0.1"
    if os.environ.get("ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK") == "1":
        return token
    if is_loopback_host(token):
        return token
    raise SystemExit(
        "Refusing to bind Ensembl Go backend to a non-loopback host. "
        "Set ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK=1 only for an intentional local-network test."
    )


def _parse_https_url(url: str, label: str):
    try:
        parsed = urlparse(str(url or "").strip())
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid {label} URL")
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail=f"{label} URL must use https")
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{label} URL host is required")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail=f"{label} URL may not include credentials")
    return parsed


def validate_remote_download_url(url: str) -> str:
    parsed = _parse_https_url(url, "Download")
    host = (parsed.hostname or "").lower()
    path = parsed.path or ""

    if host == ENSEMBL_FTP_HOST:
        if path.startswith(ENSEMBL_PATH_PREFIX):
            return str(url).strip()
        raise HTTPException(status_code=400, detail="Download URL path is not allowed")

    if host == ENSEMBL_COMPARA_FTP_HOST:
        if ENSEMBL_PAIRWISE_ALIGNMENT_PATH_RE.match(path):
            return str(url).strip()
        raise HTTPException(status_code=400, detail="Ensembl Compara URL path is not allowed")

    if host == NCBI_FTP_HOST:
        # NCBI Datasets dehydrated bundles reference concrete files in this tree.
        if (path.startswith("/genomes/all/GCA/") or path.startswith("/genomes/all/GCF/")) and "/../" not in path:
            return str(url).strip()
        raise HTTPException(status_code=400, detail="NCBI FTP URL path is not allowed")

    if host == NCBI_API_HOST:
        if NCBI_DATASETS_ACCESSION_PATH_RE.match(path) or NCBI_DATASETS_FETCH_PATH_RE.match(path):
            return str(url).strip()
        raise HTTPException(status_code=400, detail="NCBI API URL path is not allowed")

    raise HTTPException(status_code=400, detail="Download URL host is not allowed")


def normalize_trackhub_data_url(url: str) -> str:
    token = str(url or "").strip()
    if not token:
        return ""
    if token.startswith("//"):
        token = f"https:{token}"
    try:
        parsed = urlparse(token)
    except Exception:
        return token
    scheme = str(parsed.scheme or "").strip().lower()
    if scheme == "http":
        parsed = parsed._replace(scheme="https")
        return urlunparse(parsed)
    if not scheme and parsed.netloc:
        parsed = parsed._replace(scheme="https")
        return urlunparse(parsed)
    return token


def validate_trackhub_data_url(url: str) -> str:
    normalized = normalize_trackhub_data_url(url)
    parsed = _parse_https_url(normalized, "Track Hub data")
    host = parsed.hostname or ""
    if is_private_url_host(host):
        raise HTTPException(status_code=400, detail="Private or localhost Track Hub data URLs are not allowed")
    return normalized


def ensure_http_response_url_allowed(original_url: str, response_url: str, validator) -> None:
    normalized_original = validator(original_url)
    normalized_response = validator(response_url)
    if normalized_original and normalized_response:
        return


def require_path_within(root: Path, candidate: Path) -> Path:
    root_resolved = Path(root).expanduser().resolve()
    candidate_resolved = Path(candidate).expanduser().resolve()
    try:
        candidate_resolved.relative_to(root_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path is outside the managed data directory")
    return candidate_resolved


def sanitize_leaf_filename(filename: str, allowed_extensions: Optional[Iterable[str]] = None) -> str:
    raw = str(filename or "").strip()
    safe = Path(raw).name
    if not safe or safe in {".", ".."} or safe != raw:
        raise HTTPException(status_code=400, detail="filename must not contain path separators")
    if allowed_extensions:
        lowered = safe.lower()
        allowed = tuple(str(ext).lower() for ext in allowed_extensions)
        if not lowered.endswith(allowed):
            raise HTTPException(status_code=400, detail=f"filename must end with one of: {', '.join(allowed)}")
    return safe


def validate_config_export_path(path_value: str) -> Path:
    candidate = Path(str(path_value or "").strip()).expanduser()
    if not candidate.name:
        raise HTTPException(status_code=400, detail="Configuration export path must include a filename")
    if candidate.suffix.lower() not in CONFIG_EXPORT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Configuration export must use .json or .cfg")
    return candidate


def safe_export_filename(filename: str, file_format: str) -> str:
    safe = sanitize_leaf_filename(filename)
    normalized_format = str(file_format or "").strip().lower() or "svg"
    expected_ext = EXPORT_FORMAT_EXTENSIONS.get(normalized_format, f".{normalized_format}")
    if expected_ext and not safe.lower().endswith(expected_ext):
        safe = f"{safe}{expected_ext}"
    return safe


def safe_url_basename(url_path: str) -> str:
    return Path(unquote(str(url_path or ""))).name
