import hashlib
import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urljoin, urlparse, urlunparse

import requests

logger = logging.getLogger(__name__)

TRACKHUB_REGISTRY_BASE_URL = os.environ.get("TRACKHUB_REGISTRY_BASE_URL", "https://www.trackhubregistry.org").rstrip("/")
TRACKHUB_REGISTRY_TIMEOUT_SECONDS = float(os.environ.get("TRACKHUB_REGISTRY_TIMEOUT_SECONDS", "20"))
TRACKHUB_REGISTRY_CACHE_TTL_SECONDS = int(os.environ.get("TRACKHUB_REGISTRY_CACHE_TTL_SECONDS", str(60 * 60)))
TRACKHUB_REGISTRY_SEARCH_PAGE_LIMIT = int(os.environ.get("TRACKHUB_REGISTRY_SEARCH_PAGE_LIMIT", "80"))
TRACKHUB_REGISTRY_TRACKDB_CACHE_TTL_SECONDS = int(os.environ.get("TRACKHUB_REGISTRY_TRACKDB_CACHE_TTL_SECONDS", str(60 * 60 * 6)))
TRACKHUB_REGISTRY_DISK_CACHE_DIR = os.environ.get(
    "TRACKHUB_REGISTRY_DISK_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "cache", "trackhub_registry"),
)
TRACKHUB_REGISTRY_DISK_CACHE_VERSION = 2

TRACKHUB_SEARCH_PATH = "/api/search"

_TRACKHUB_CACHE_LOCK = threading.Lock()
_TRACKHUB_CACHE: Dict[str, Dict[str, Any]] = {}
_TRACKHUB_REFRESHING: set = set()

_TRACKDB_CACHE_LOCK = threading.Lock()
_TRACKDB_CACHE: Dict[str, Dict[str, Any]] = {}

_FORMAT_TO_TRACK_TYPE = {
    "bigwig": "bigwig",
    "bigwigfile": "bigwig",
    "big_wig": "bigwig",
    "bigbed": "bigbed",
    "bigbedfile": "bigbed",
    "big_bed": "bigbed",
}

_ASSEMBLY_ACCESSION_RE = re.compile(r"(GC[AF]_\d+(?:\.\d+)?)", re.IGNORECASE)


def _normalize_token(value: Any) -> str:
    token = str(value or "").strip().lower()
    if not token:
        return ""
    token = token.replace("_", " ")
    token = re.sub(r"\s+", " ", token)
    return token


def _normalize_url(value: Any) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    if token.startswith("//"):
        token = f"https:{token}"
    return token


def _normalize_download_url(value: Any) -> str:
    token = _normalize_url(value)
    if not token:
        return ""
    try:
        parsed = urlparse(token)
    except Exception:
        return token
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
        return urlunparse(parsed)
    return token


def _extract_assembly_accession(value: Any) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    match = _ASSEMBLY_ACCESSION_RE.search(token)
    return match.group(1) if match else ""


def _assembly_identity_tokens(*values: Any) -> set:
    tokens = set()
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        lowered = raw.lower()
        normalized = _normalize_token(raw)
        for token in (lowered, normalized):
            if not token:
                continue
            tokens.add(token)
            if "." in token:
                tokens.add(token.split(".", 1)[0])

        accession = _extract_assembly_accession(raw).lower()
        if accession:
            tokens.add(accession)
            if "." in accession:
                tokens.add(accession.split(".", 1)[0])
    return tokens


def _assembly_match_score(record: Dict[str, Any], genome: Dict[str, str]) -> int:
    record_tokens = _assembly_identity_tokens(
        record.get("assembly"),
        record.get("assembly_name"),
        record.get("assembly_accession"),
    )
    genome_tokens = _assembly_identity_tokens(
        genome.get("assembly"),
        genome.get("assembly_name"),
    )
    if not record_tokens or not genome_tokens:
        return 0

    exact_record_tokens = {
        str(record.get("assembly") or "").strip().lower(),
        str(record.get("assembly_name") or "").strip().lower(),
        str(record.get("assembly_accession") or "").strip().lower(),
    }
    exact_genome_tokens = {
        str(genome.get("assembly") or "").strip().lower(),
        str(genome.get("assembly_name") or "").strip().lower(),
    }
    exact_record_tokens.discard("")
    exact_genome_tokens.discard("")
    if exact_record_tokens.intersection(exact_genome_tokens):
        return 120
    if record_tokens.intersection(genome_tokens):
        return 90
    return 0


def _guess_format_from_url(url: str) -> str:
    lower = (url or "").lower().split("?", 1)[0]
    if lower.endswith(".bw") or lower.endswith(".bigwig"):
        return "bigWig"
    if lower.endswith(".bb") or lower.endswith(".bigbed"):
        return "bigBed"
    return ""


def _canonical_track_format(format_value: Any, data_url: str) -> Tuple[str, str]:
    raw = str(format_value or "").strip()
    token = raw.split()[0] if raw else ""
    token = _normalize_token(token).replace(" ", "").replace("-", "").replace(".", "")
    mapped = _FORMAT_TO_TRACK_TYPE.get(token)
    if not mapped:
        guessed = _guess_format_from_url(data_url)
        token_guess = _normalize_token(guessed).replace(" ", "").replace("-", "").replace(".", "")
        mapped = _FORMAT_TO_TRACK_TYPE.get(token_guess, "")
    if not mapped:
        return "", ""
    return ("bigWig", "bigwig") if mapped == "bigwig" else ("bigBed", "bigbed")


def _compute_import_key(hub_id: Any, track_id: Any, assembly: Any, data_url: Any) -> str:
    payload = "|".join(
        [
            str(hub_id or "").strip(),
            str(track_id or "").strip(),
            str(assembly or "").strip(),
            str(data_url or "").strip(),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _next_page_number(next_url: Any, current_page: int) -> Optional[int]:
    token = str(next_url or "").strip()
    if not token:
        return None
    try:
        parsed = urlparse(token)
        raw_page = parse_qs(parsed.query).get("page", [str(current_page + 1)])[0]
        page = int(raw_page)
    except Exception:
        return current_page + 1
    return page if page > current_page else None


def _search_endpoint() -> str:
    return urljoin(f"{TRACKHUB_REGISTRY_BASE_URL}/", TRACKHUB_SEARCH_PATH.lstrip("/"))


def _disk_cache_path(cache_key: str) -> str:
    return os.path.join(TRACKHUB_REGISTRY_DISK_CACHE_DIR, f"{cache_key}.json")


def _read_disk_cache(cache_key: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_disk_cache_path(cache_key), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if int(payload.get("version") or 0) != TRACKHUB_REGISTRY_DISK_CACHE_VERSION:
        return None
    value = payload.get("value")
    if not isinstance(value, dict):
        return None
    return payload


def _write_disk_cache(cache_key: str, value: Dict[str, Dict[str, Any]], now_ts: Optional[float] = None) -> None:
    now_value = float(now_ts if now_ts is not None else time.time())
    payload = {
        "version": TRACKHUB_REGISTRY_DISK_CACHE_VERSION,
        "saved_at": now_value,
        "expires_at": now_value + TRACKHUB_REGISTRY_CACHE_TTL_SECONDS,
        "value": value,
    }
    try:
        os.makedirs(TRACKHUB_REGISTRY_DISK_CACHE_DIR, exist_ok=True)
        path = _disk_cache_path(cache_key)
        tmp_path = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp_path, path)
    except Exception as exc:
        logger.debug("Failed to write Track Hub Registry disk cache: %s", exc)


def _schedule_background_refresh(cache_key: str, genomes: List[Dict[str, Any]]) -> None:
    with _TRACKHUB_CACHE_LOCK:
        if cache_key in _TRACKHUB_REFRESHING:
            return
        _TRACKHUB_REFRESHING.add(cache_key)

    def _run() -> None:
        try:
            list_tracks_for_genomes(genomes, refresh=True)
        except Exception as exc:
            logger.debug("Background Track Hub Registry refresh failed: %s", exc)
        finally:
            with _TRACKHUB_CACHE_LOCK:
                _TRACKHUB_REFRESHING.discard(cache_key)

    thread = threading.Thread(target=_run, name="trackhub-registry-refresh", daemon=True)
    thread.start()


def _search_registry(filters: Dict[str, str]) -> Tuple[List[Dict[str, Any]], str]:
    endpoint = _search_endpoint()
    items: List[Dict[str, Any]] = []
    page = 1
    total_entries = 0

    try:
        while page <= TRACKHUB_REGISTRY_SEARCH_PAGE_LIMIT:
            response = requests.post(
                endpoint,
                params={"page": page},
                json=filters,
                timeout=TRACKHUB_REGISTRY_TIMEOUT_SECONDS,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            response.raise_for_status()
            payload = response.json()

            page_items = payload.get("items") or []
            if isinstance(page_items, list):
                items.extend(page_items)

            if not total_entries:
                try:
                    total_entries = int(payload.get("total_entries") or 0)
                except Exception:
                    total_entries = 0

            if total_entries > 0 and len(items) >= total_entries:
                break
            if not page_items:
                break

            next_page = _next_page_number(payload.get("next"), page)
            if not next_page:
                break
            page = next_page
    except Exception as exc:
        return [], f"Track Hub search API request failed: {exc}"

    return items, ""


def _normalize_search_result(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    hub = item.get("hub") if isinstance(item.get("hub"), dict) else {}
    assembly = item.get("assembly") if isinstance(item.get("assembly"), dict) else {}
    species = item.get("species") if isinstance(item.get("species"), dict) else {}

    trackdb_url = _normalize_download_url(_normalize_url(source.get("url")))
    if not trackdb_url:
        return None

    hub_id = str(hub.get("url") or item.get("trackdb_id") or hub.get("name") or "").strip()
    hub_name = str(hub.get("name") or hub.get("shortLabel") or "Track Hub").strip()

    assembly_accession = _extract_assembly_accession(assembly.get("accession") or "")
    assembly_name = str(assembly.get("name") or "").strip()

    return {
        "hub_id": hub_id,
        "hub_name": hub_name,
        "hub_long_label": str(hub.get("longLabel") or "").strip(),
        "trackdb_id": str(item.get("trackdb_id") or "").strip(),
        "trackdb_url": trackdb_url,
        "assembly_name": assembly_name,
        "assembly_accession": assembly_accession,
        "species": str(species.get("scientific_name") or species.get("common_name") or "").strip(),
        "type": str(item.get("type") or "").strip(),
    }


def _parse_trackdb_stanzas(trackdb_text: str) -> List[Dict[str, str]]:
    stanzas: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    for raw_line in (trackdb_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                stanzas.append(current)
                current = {}
            continue
        if line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        key = parts[0].strip().lower()
        value = parts[1].strip()
        current[key] = value
    if current:
        stanzas.append(current)
    return stanzas


def _load_trackdb_tracks(meta: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    trackdb_url = str(meta.get("trackdb_url") or "").strip()
    if not trackdb_url:
        return [], ""

    now_ts = time.time()
    with _TRACKDB_CACHE_LOCK:
        cached = _TRACKDB_CACHE.get(trackdb_url)
        if cached and float(cached.get("expires_at", 0)) > now_ts:
            return json.loads(json.dumps(cached.get("tracks") or [])), ""

    try:
        response = requests.get(
            trackdb_url,
            timeout=TRACKHUB_REGISTRY_TIMEOUT_SECONDS,
            headers={"Accept": "text/plain,*/*"},
        )
        response.raise_for_status()
        text = response.text
    except Exception as exc:
        return [], f"Failed to fetch trackDb: {exc}"

    assembly_token = str(meta.get("assembly_accession") or meta.get("assembly_name") or "").strip()
    out: List[Dict[str, Any]] = []
    stanzas = _parse_trackdb_stanzas(text)
    for stanza in stanzas:
        raw_big_data_url = str(stanza.get("bigdataurl") or "").strip()
        if not raw_big_data_url:
            continue
        data_url = _normalize_download_url(urljoin(trackdb_url, raw_big_data_url))
        if not data_url:
            continue

        fmt, track_type = _canonical_track_format(stanza.get("type"), data_url)
        if track_type not in {"bigwig", "bigbed"}:
            continue

        track_id = str(stanza.get("track") or "").strip() or _compute_import_key(meta.get("hub_id"), "", assembly_token, data_url)
        short_label = str(stanza.get("shortlabel") or "").strip()
        long_label = str(stanza.get("longlabel") or "").strip()
        track_name = short_label or long_label or track_id
        description = long_label or str(meta.get("hub_long_label") or "").strip()

        import_key = _compute_import_key(meta.get("hub_id"), track_id, assembly_token, data_url)
        out.append(
            {
                "hub_id": str(meta.get("hub_id") or "").strip(),
                "hub_name": str(meta.get("hub_name") or "").strip(),
                "track_id": track_id,
                "track_name": track_name,
                "assembly": str(meta.get("assembly_name") or meta.get("assembly_accession") or "").strip(),
                "assembly_name": str(meta.get("assembly_name") or "").strip(),
                "assembly_accession": str(meta.get("assembly_accession") or "").strip(),
                "format": fmt,
                "type": track_type,
                "data_url": data_url,
                "description": description,
                "species": str(meta.get("species") or "").strip(),
                "import_key": import_key,
            }
        )

    with _TRACKDB_CACHE_LOCK:
        _TRACKDB_CACHE[trackdb_url] = {
            "expires_at": now_ts + TRACKHUB_REGISTRY_TRACKDB_CACHE_TTL_SECONDS,
            "tracks": json.loads(json.dumps(out)),
        }
    return out, ""


def _add_unique_token(items: List[str], seen: set, value: Any) -> None:
    token = str(value or "").strip()
    if not token:
        return
    key = token.lower()
    if key in seen:
        return
    seen.add(key)
    items.append(token)


def _assembly_query_tokens(genome: Dict[str, str]) -> List[str]:
    seen: set = set()
    tokens: List[str] = []

    assembly = str(genome.get("assembly") or "").strip()
    assembly_name = str(genome.get("assembly_name") or "").strip()

    for value in (assembly_name, assembly):
        _add_unique_token(tokens, seen, value)
        if "." in value:
            _add_unique_token(tokens, seen, value.split(".", 1)[0])
        accession = _extract_assembly_accession(value)
        _add_unique_token(tokens, seen, accession)
        if accession and "." in accession:
            _add_unique_token(tokens, seen, accession.split(".", 1)[0])

    return tokens


def _search_filter_candidates(genome: Dict[str, str]) -> List[Dict[str, str]]:
    seen: set = set()
    filters: List[Dict[str, str]] = []

    def _push(payload: Dict[str, str]) -> None:
        key = tuple(sorted((k, str(v or "").strip()) for k, v in payload.items() if str(v or "").strip()))
        if not key or key in seen:
            return
        seen.add(key)
        filters.append({k: str(v).strip() for k, v in payload.items() if str(v or "").strip()})

    assembly_tokens = _assembly_query_tokens(genome)
    species_tokens = [
        str(genome.get("scientific_name") or "").strip(),
        str(genome.get("common_name") or "").strip(),
        str(genome.get("species_key") or "").strip().replace("_", " "),
    ]

    for token in assembly_tokens:
        _push({"assembly": token})
    for token in assembly_tokens:
        _push({"query": token})
    for token in species_tokens:
        _push({"species": token})
    for token in species_tokens:
        _push({"query": token})

    if not filters:
        _push({})
    return filters


def _record_match_score(record: Dict[str, Any], genome: Dict[str, str]) -> int:
    score = _assembly_match_score(record, genome)
    if score <= 0:
        return 0

    rec_species = _normalize_token(record.get("species"))
    rec_hub = _normalize_token(record.get("hub_name"))
    rec_track = _normalize_token(record.get("track_name"))
    rec_desc = _normalize_token(record.get("description"))
    haystack = " ".join([rec_species, rec_hub, rec_track, rec_desc]).strip()

    species_candidates = [
        _normalize_token(genome.get("scientific_name")),
        _normalize_token(genome.get("common_name")),
        _normalize_token(str(genome.get("species_key") or "").replace("_", " ")),
    ]

    for species_token in species_candidates:
        if not species_token:
            continue
        if haystack and species_token in haystack:
            score += 5
            break

    return score


def _match_records(records: List[Dict[str, Any]], genome: Dict[str, str], allow_fallback: bool = False) -> List[Dict[str, Any]]:
    scored: List[Tuple[int, Dict[str, Any]]] = []
    for record in records:
        score = _record_match_score(record, genome)
        if score > 0:
            scored.append((score, record))
    any_record_has_assembly = any(
        _assembly_identity_tokens(record.get("assembly"), record.get("assembly_name"), record.get("assembly_accession"))
        for record in records
    )
    if not scored and allow_fallback and not any_record_has_assembly:
        scored = [(1, record) for record in records]

    scored.sort(
        key=lambda item: (
            -item[0],
            str(item[1].get("hub_name") or "").lower(),
            str(item[1].get("track_name") or "").lower(),
            str(item[1].get("data_url") or "").lower(),
        )
    )

    unique: List[Dict[str, Any]] = []
    seen: set = set()
    for _, record in scored:
        key = (record.get("import_key"), record.get("data_url"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(record)
    return unique


def _stable_track_sort_key(record: Dict[str, Any]) -> Tuple[str, str, str, str]:
    return (
        str(record.get("hub_name") or "").strip().lower(),
        str(record.get("type") or "").strip().lower(),
        str(record.get("track_name") or "").strip().lower(),
        str(record.get("data_url") or "").strip().lower(),
    )


def _fetch_tracks_for_genome(genome: Dict[str, str]) -> Tuple[List[Dict[str, Any]], str]:
    search_filters = _search_filter_candidates(genome)
    hub_records: List[Dict[str, Any]] = []
    error_message = ""

    for filters in search_filters:
        raw_items, search_error = _search_registry(filters)
        if search_error and not error_message:
            error_message = search_error
        if not raw_items:
            continue

        normalized: List[Dict[str, Any]] = []
        for item in raw_items:
            meta = _normalize_search_result(item)
            if meta and _assembly_match_score(meta, genome) > 0:
                normalized.append(meta)
        if normalized:
            hub_records = normalized
            break

    if not hub_records:
        if not error_message:
            error_message = "No track hub records found from registry API."
        return [], error_message

    collected: List[Dict[str, Any]] = []
    seen: set = set()
    for hub_meta in hub_records:
        tracks, _ = _load_trackdb_tracks(hub_meta)
        for track in tracks:
            key = (track.get("import_key"), track.get("data_url"))
            if key in seen:
                continue
            seen.add(key)
            collected.append(track)

    if not collected:
        return [], "No importable bigWig/bigBed tracks were found in matching Track Hub records."

    matched = _match_records(collected, genome, allow_fallback=True)
    matched.sort(key=_stable_track_sort_key)
    return matched, ""


def list_tracks_for_genomes(genomes: List[Dict[str, Any]], refresh: bool = False) -> Dict[str, Dict[str, Any]]:
    key_parts = []
    for genome in genomes:
        key_parts.append(
            {
                "genome_key": str(genome.get("genome_key") or ""),
                "species_key": str(genome.get("species_key") or ""),
                "scientific_name": str(genome.get("scientific_name") or ""),
                "common_name": str(genome.get("common_name") or ""),
                "assembly": str(genome.get("assembly") or ""),
                "assembly_name": str(genome.get("assembly_name") or ""),
            }
        )
    cache_key = hashlib.sha1(json.dumps(sorted(key_parts, key=lambda x: x["genome_key"]), sort_keys=True).encode("utf-8")).hexdigest()

    now = time.time()
    if not refresh:
        with _TRACKHUB_CACHE_LOCK:
            cached = _TRACKHUB_CACHE.get(cache_key)
            if cached and float(cached.get("expires_at", 0)) > now:
                return json.loads(json.dumps(cached.get("value") or {}))
        disk_cached = _read_disk_cache(cache_key)
        if disk_cached:
            value = json.loads(json.dumps(disk_cached.get("value") or {}))
            expires_at = float(disk_cached.get("expires_at") or 0)
            with _TRACKHUB_CACHE_LOCK:
                _TRACKHUB_CACHE[cache_key] = {
                    "expires_at": expires_at,
                    "value": value,
                }
            if expires_at <= now:
                _schedule_background_refresh(cache_key, genomes)
            return value

    grouped: Dict[str, Dict[str, Any]] = {}
    for raw_genome in genomes:
        genome = {
            "genome_key": str(raw_genome.get("genome_key") or ""),
            "species_key": str(raw_genome.get("species_key") or ""),
            "scientific_name": str(raw_genome.get("scientific_name") or ""),
            "common_name": str(raw_genome.get("common_name") or ""),
            "assembly": str(raw_genome.get("assembly") or ""),
            "assembly_name": str(raw_genome.get("assembly_name") or ""),
        }
        genome_key = genome["genome_key"] or f"{genome['species_key']}::{genome['assembly']}"
        if not genome_key:
            continue
        try:
            tracks, error = _fetch_tracks_for_genome(genome)
        except Exception as exc:
            logger.warning("Track hub registry discovery failed for %s: %s", genome_key, exc)
            tracks, error = [], str(exc)
        grouped[genome_key] = {
            "genome_key": genome_key,
            "tracks": tracks,
            "error": error,
        }

    with _TRACKHUB_CACHE_LOCK:
        _TRACKHUB_CACHE[cache_key] = {
            "expires_at": now + TRACKHUB_REGISTRY_CACHE_TTL_SECONDS,
            "value": grouped,
        }
    _write_disk_cache(cache_key, grouped, now)
    return json.loads(json.dumps(grouped))
