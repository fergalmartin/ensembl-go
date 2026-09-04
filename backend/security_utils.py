"""Security helpers for the desktop-local backend.

These helpers intentionally keep policy decisions small and explicit so the
main API file can enforce them consistently at filesystem and URL boundaries.
"""

import ipaddress
import os
import re
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import requests
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

# Protein annotation services. These are read-only metadata lookups rather than
# genome downloads, so they get their own validator: the download allowlist is
# about bulk assembly files and should not grow hosts that have nothing to do
# with them.
ALPHAFOLD_HOST = "alphafold.ebi.ac.uk"
ALPHAFOLD_PATH_PREFIXES = ("/api/prediction/", "/files/")
UNIPROT_HOST = "rest.uniprot.org"
UNIPROT_PATH_PREFIXES = ("/uniprotkb/",)
INTERPRO_HOST = "www.ebi.ac.uk"
INTERPRO_PATH_PREFIXES = ("/interpro/api/",)

ANNOTATION_SERVICE_ALLOWLIST = {
    ALPHAFOLD_HOST: ALPHAFOLD_PATH_PREFIXES,
    UNIPROT_HOST: UNIPROT_PATH_PREFIXES,
    INTERPRO_HOST: INTERPRO_PATH_PREFIXES,
}

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


def validate_annotation_service_url(url: str) -> str:
    """Allow only the protein-annotation lookups the Feature Explorer performs.

    Kept separate from ``validate_remote_download_url`` because these are small
    metadata reads against fixed API paths, not genome downloads, and mixing the
    two would let a genome download reach an annotation host or vice versa.
    """
    parsed = _parse_https_url(url, "Annotation service")
    host = (parsed.hostname or "").lower()
    path = parsed.path or ""

    prefixes = ANNOTATION_SERVICE_ALLOWLIST.get(host)
    if prefixes is None:
        raise HTTPException(status_code=400, detail="Annotation service host is not allowed")
    if "/../" in path or not any(path.startswith(prefix) for prefix in prefixes):
        raise HTTPException(status_code=400, detail="Annotation service URL path is not allowed")
    return str(url).strip()


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


MAX_VALIDATED_REDIRECTS = 5


def _redirect_location(response) -> Optional[str]:
    """Return the redirect target of ``response``, or ``None`` if it is not a redirect.

    Derived from the status line and headers rather than ``Response.is_redirect``
    so that any response-like object works here, not only a real
    ``requests.Response``. A redirect status carrying no usable ``Location``
    yields an empty string, which the caller treats as a malformed response
    rather than as success.
    """
    try:
        status = int(getattr(response, "status_code", 0) or 0)
    except (TypeError, ValueError):
        return None
    if status not in requests.models.REDIRECT_STATI:
        return None
    headers = getattr(response, "headers", None) or {}
    try:
        location = headers.get("location") or headers.get("Location") or ""
    except AttributeError:
        location = ""
    return str(location).strip()


def ensure_http_response_url_allowed(original_url: str, response_url: str, validator) -> None:
    """Fail unless both URLs pass ``validator``.

    The validators raise on a disallowed URL, so this normally reports failure by
    propagating that. The explicit check keeps the helper closed rather than open
    if it is ever handed a validator that returns a falsy value instead.
    """
    if not validator(original_url) or not validator(response_url):
        raise HTTPException(status_code=400, detail="Redirect target is not allowed")


def get_with_validated_redirects(url: str, validator, **kwargs):
    """GET ``url``, revalidating every redirect hop before it is followed.

    ``requests`` resolves redirect chains internally, so by the time a caller can
    inspect the response a redirect to a disallowed host has already been
    fetched. That is enough to reach a host the allowlist exists to keep the
    application away from, even though the body is discarded. Walking the chain
    here keeps every hop subject to ``validator`` before a request goes out to
    it. Returns the first non-redirect response, which the caller owns and must
    close (directly or as a context manager).
    """
    kwargs.pop("allow_redirects", None)
    current = validator(url)

    for _ in range(MAX_VALIDATED_REDIRECTS):
        response = requests.get(current, allow_redirects=False, **kwargs)
        location = _redirect_location(response)
        if location is None:
            ensure_http_response_url_allowed(url, getattr(response, "url", current) or current, validator)
            return response

        close = getattr(response, "close", None)
        if callable(close):
            close()
        if not location:
            raise HTTPException(status_code=502, detail="Redirect response is missing a Location header")
        # Location may be relative, so resolve it against the hop it came from
        # before validating the absolute result.
        current = validator(urljoin(current, location))

    raise HTTPException(status_code=502, detail="Too many redirects")


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
