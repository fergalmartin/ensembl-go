"""The application configuration: defaults, the cache-dir config file, the
output-directory sidecars (configuration and playlists) with their schema
migrations and revision guards, and the cached load_config / atomic save_config.

Refer to this module's names as `config_store.<name>`; tests patch
`config_store.CONFIG_FILE` and must reach every reader.
"""

import copy
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import app_paths
import app_state
import data_paths
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    genome_key_candidates,
    legacy_genome_key,
    normalize_provider,
    parse_genome_key,
    strip_dataset_release_from_selection_key,
)

logger = logging.getLogger(__name__)


CONFIG_FILE = app_paths.CACHE_DIR / "config.json"


OUTPUT_DIR_CONFIG_FILENAME = "configuration.json"


OUTPUT_DIR_PLAYLISTS_FILENAME = "genome_playlists.json"


DEFAULT_CONFIG = {
    "working_dir": "",
    "ref_fasta": "",
    "ref_gff": "",
    "target_fasta": "",
    "target_gff": "",
    "homologies_file": "",
    "output_dir": "",
    "ref_index": "",
    "target_index": "",
    "default_light_mode": False,
    "dim_non_selected_genes": True,
    "show_fps_counter": False,
    # How pan/zoom gestures behave in the genome browser. One of the ids in
    # frontend/src/utils/browsingControls.js; unknown values fall back to
    # "default" on the frontend, so no server-side validation is needed.
    "browsing_control_scheme": "default",
    "sv_hide_inactive_tracks": False,
    # Reopen each genome's custom tracks and track groups in the Genome Browser as they
    # were left. What was open is kept beside the track registry, not in here.
    "remember_browser_tracks": True,
    # Paths of SV alignment config files the user has attached. Persisted so a
    # loaded config survives a restart rather than having to be re-opened.
    "sv_config_paths": [],
    "active_species": [],
    "next_previous_session_genomes": [],
    "manual_species": [],
    "genome_file_overrides": {},
    "genome_analysis_reports": {},
    "deregistered_genome_keys": [],
    "genome_playlists": [],
    "selected_genome_playlist_id": "__all__",
    # Superseded by the three keys below: colour used to be a property of a
    # genome's position among the active set. Kept so that a configuration
    # written before the change can still be read, and migrated on the frontend
    # the first time it is loaded (see genomeColorSchemes.js).
    "genome_browser_colors": [],
    # The colour a genome is drawn in until it is given one of its own.
    "genome_default_color": "#3366cc",
    # assembly key -> hex colour, for the genomes that have been given one.
    "genome_colors": {},
    # Colours the user mixed themselves, offered beside the built-in palette.
    "genome_color_palette": [],
    # Keep in step with DEFAULT_ACTIVE_APP_BUTTONS in
    # frontend/src/appButtonConfig.js, which is the authority — the frontend
    # normalises whatever it reads against that list. This copy is what a
    # configuration written before the frontend has ever run will carry.
    "active_app_buttons": [
        "home",
        "genome_selector",
        "genome_browser",
        "download",
        "sequence",
        "feature_explorer",
        "track_manager",
        "alignment",
        "alignment_explorer",
        "neighbourhood",
        "stats",
        "notes",
        "tutorials",
        "help",
        "configuration",
        "genome_playlist",
        "theme_toggle",
        "screenshot_toggle",
    ],
}


RECOGNIZED_CONFIG_KEYS = set(DEFAULT_CONFIG.keys())


def _looks_like_assembly_accession(value: Any) -> bool:
    return bool(re.match(r"^GC[AF]_\d+(?:\.\d+)?$", str(value or "").strip(), re.IGNORECASE))


def _is_useful_assembly_name(value: Any, accession: Any = "") -> bool:
    token = str(value or "").strip()
    if not token:
        return False
    if _looks_like_assembly_accession(token):
        return False
    return token.lower() != str(accession or "").strip().lower()


def _format_species_key_for_display(value: Any) -> str:
    words = [part for part in re.split(r"[_\s]+", str(value or "").strip()) if part]
    return " ".join(word[:1].upper() + word[1:].lower() for word in words)


def _find_catalog_species_key(species_key: Any) -> str:
    key = str(species_key or "").strip()
    if not key:
        return ""
    species_data = getattr(app_state.download_manager, "species_data", {}) or {}
    if key in species_data:
        return key
    lowered = key.lower()
    for candidate in species_data.keys():
        if str(candidate).lower() == lowered:
            return str(candidate)
    return key


def _catalog_genome_metadata(species_key: Any, assembly: Any, provider: Any = DEFAULT_PROVIDER) -> Dict[str, str]:
    if normalize_provider(str(provider or DEFAULT_PROVIDER)) != DEFAULT_PROVIDER:
        return {}
    key = _find_catalog_species_key(species_key)
    assembly_token = str(assembly or "").strip()
    if not key or not assembly_token:
        return {}
    info = (getattr(app_state.download_manager, "species_data", {}) or {}).get(key) or {}
    if not isinstance(info, dict):
        return {}
    assemblies = info.get("assemblies") or {}
    assembly_info = assemblies.get(assembly_token) or {}
    if not isinstance(assembly_info, dict):
        assembly_info = {}
    display = {}
    try:
        summary = next((item for item in (app_state.download_manager._species_cache or []) if item.key == key), None)
        # Configuration needs labels for its saved genomes, not summaries and
        # taxonomy diagnostics for every species in the download catalogue.
        display = app_state.download_manager.species_display_name(key) if summary is None else {
            "display_name": summary.display_name,
            "display_name_reason": summary.display_name_reason,
        }
    except Exception:
        pass
    return {
        "species_key": key,
        "assembly": assembly_token,
        "scientific_name": str(info.get("scientific_name") or "").strip(),
        "common_name": str(info.get("common_name") or "").strip(),
        "display_name": str(display.get("display_name") or info.get("display_name") or "").strip(),
        "display_name_reason": str(display.get("display_name_reason") or info.get("display_name_reason") or "").strip(),
        "assembly_name": str(assembly_info.get("name") or "").strip(),
    }


def _genome_key_match_candidates(item: Any) -> Set[str]:
    candidates: Set[str] = set()
    if isinstance(item, str):
        token = item.strip()
        if token:
            candidates.add(token)
            assembly_token = strip_dataset_release_from_selection_key(token)
            if assembly_token and assembly_token != token:
                candidates.add(assembly_token)
            provider, species_key, assembly = parse_genome_key(token)
            if species_key and assembly:
                candidates.add(build_provider_aware_genome_key(species_key, assembly, provider))
                candidates.add(legacy_genome_key(species_key, assembly))
                candidates.add(assembly)
        return {candidate for candidate in candidates if candidate}
    if isinstance(item, dict):
        for candidate in genome_key_candidates(item):
            candidates.add(candidate)
        key = str(item.get("key") or "").strip()
        if key:
            candidates.update(_genome_key_match_candidates(key))
        selection = str(item.get("selection_key") or "").strip()
        if selection:
            candidates.update(_genome_key_match_candidates(selection))
        assembly_key = str(item.get("assembly_key") or "").strip()
        if assembly_key:
            candidates.update(_genome_key_match_candidates(assembly_key))
        assembly = str(item.get("assembly") or item.get("gca") or "").strip()
        if assembly:
            candidates.add(assembly)
    return {candidate for candidate in candidates if candidate}


def _genome_keys_match_local(left: Any, right: Any) -> bool:
    left_candidates = _genome_key_match_candidates(left)
    right_candidates = _genome_key_match_candidates(right)
    return bool(left_candidates and right_candidates and left_candidates.intersection(right_candidates))


def _genome_key_display_metadata(genome_key: Any, config: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    provider, species_key, assembly = parse_genome_key(str(genome_key or ""))
    if not species_key or not assembly:
        return {}

    def _candidate_from_item(item: Dict[str, Any]) -> Optional[Dict[str, str]]:
        if not isinstance(item, dict):
            return None
        try:
            if not _genome_keys_match_local(item, str(genome_key or "")):
                return None
        except Exception:
            return None
        return {
            "species_key": str(item.get("species_key") or species_key).strip(),
            "assembly": str(item.get("assembly") or item.get("gca") or assembly).strip(),
            "scientific_name": str(item.get("scientific_name") or "").strip(),
            "common_name": str(item.get("common_name") or "").strip(),
            "display_name": str(item.get("display_name") or "").strip(),
            "display_name_reason": str(item.get("display_name_reason") or "").strip(),
            "assembly_name": str(item.get("assembly_name") or "").strip(),
        }

    candidates: List[Dict[str, str]] = []
    if isinstance(config, dict):
        for item in list(config.get("active_species") or []) + list(config.get("manual_species") or []):
            candidate = _candidate_from_item(item)
            if candidate:
                candidates.append(candidate)
        for playlist in config.get("genome_playlists") or []:
            for item in (playlist or {}).get("genomes") or []:
                candidate = _candidate_from_item(item)
                if candidate:
                    candidates.append(candidate)

    catalog = _catalog_genome_metadata(species_key, assembly, provider)
    if catalog:
        candidates.append(catalog)

    species_label = ""
    common_name = ""
    scientific_name = ""
    display_name = ""
    display_name_reason = ""
    assembly_name = ""
    for candidate in candidates:
        if not display_name and candidate.get("display_name"):
            display_name = candidate["display_name"]
            display_name_reason = candidate.get("display_name_reason") or ""
        if not common_name and candidate.get("common_name"):
            common_name = candidate["common_name"]
        if not scientific_name and candidate.get("scientific_name"):
            scientific_name = candidate["scientific_name"]
        candidate_assembly_name = candidate.get("assembly_name")
        if not assembly_name and _is_useful_assembly_name(candidate_assembly_name, assembly):
            assembly_name = candidate_assembly_name
    if catalog.get("scientific_name"):
        scientific_name = catalog["scientific_name"]
    if catalog.get("common_name"):
        common_name = catalog["common_name"]
    if catalog.get("display_name"):
        display_name = catalog["display_name"]
        display_name_reason = catalog.get("display_name_reason") or display_name_reason

    species_label = display_name or common_name or scientific_name or _format_species_key_for_display(species_key)
    assembly_label = assembly_name or assembly
    display_parts = [species_label]
    if assembly_label:
        display_parts.append(assembly_label)
    if assembly and assembly.lower() != str(assembly_label or "").lower():
        display_parts.append(assembly)
    return {
        "species_key": species_key,
        "assembly": assembly,
        "scientific_name": scientific_name or _format_species_key_for_display(species_key),
        "common_name": common_name,
        "display_name": display_name or species_label,
        "display_name_reason": display_name_reason or ("unique_common" if common_name and species_label == common_name else "missing_common"),
        "assembly_name": assembly_label,
        "species_label": species_label,
        "label": " - ".join(display_parts),
    }


def _enrich_config_genome_labels(config: Dict[str, Any]) -> Dict[str, Any]:
    enriched = json.loads(json.dumps(config))
    collections: List[List[Dict[str, Any]]] = []
    for section in ("active_species", "next_previous_session_genomes", "manual_species"):
        items = enriched.get(section)
        if isinstance(items, list):
            collections.append(items)
    for playlist in enriched.get("genome_playlists") or []:
        genomes = playlist.get("genomes") if isinstance(playlist, dict) else None
        if isinstance(genomes, list):
            collections.append(genomes)

    for items in collections:
        for item in items:
            if not isinstance(item, dict):
                continue
            genome_key = build_provider_aware_genome_key(
                item.get("species_key"),
                item.get("assembly") or item.get("gca") or item.get("assembly_name"),
                item.get("provider"),
                is_manual=bool(item.get("is_manual")),
            ) or legacy_genome_key(item.get("species_key"), item.get("assembly") or item.get("gca") or item.get("assembly_name"))
            metadata = _genome_key_display_metadata(genome_key, enriched)
            if not metadata:
                continue
            if metadata.get("scientific_name"):
                item["scientific_name"] = metadata["scientific_name"]
            if metadata.get("common_name"):
                item["common_name"] = metadata["common_name"]
            if metadata.get("display_name"):
                item["display_name"] = metadata["display_name"]
            if metadata.get("display_name_reason"):
                item["display_name_reason"] = metadata["display_name_reason"]
            if _is_useful_assembly_name(metadata.get("assembly_name"), item.get("assembly")):
                item["assembly_name"] = metadata["assembly_name"]
    return enriched


def _output_dir_playlist_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / OUTPUT_DIR_PLAYLISTS_FILENAME
    except Exception:
        return None


# --- Sidecar schema version, migrations, and load warnings -----------------------
#
# The sidecar has always written ``"version": 1`` and nothing has ever read it, so a
# format change had no hook to hang a conversion on and no test to catch the breakage.
# Reading it costs little and buys two things: an old file can be converted on the way
# in, and a file written by a *newer* version is recognised as unreadable rather than
# being parsed on a guess and then overwritten with a downgrade.
#
# The rule for an unreadable file — wrong version, corrupt JSON, anything — is the same
# throughout: say so, decline to load it, and leave it alone. A working directory whose
# settings cannot be read still holds the genomes, indices and notes that took hours to
# build, and must stay usable.
SIDECAR_SCHEMA_VERSION = 1


#: from-version -> converter, applied in ascending order until the current version.
_SIDECAR_MIGRATIONS: Dict[int, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}


def sidecar_migration(from_version: int):
    """Register a converter from ``from_version`` to ``from_version + 1``.

    When the sidecar format changes: raise SIDECAR_SCHEMA_VERSION, and register one of
    these for the version it replaced. Old directories then convert on first read.
    """
    def register(fn):
        _SIDECAR_MIGRATIONS[from_version] = fn
        return fn
    return register


_config_warnings_guard = threading.Lock()


#: key -> warning. Keyed so that re-reading the same bad file does not pile up.
_config_warnings: Dict[str, Dict[str, Any]] = {}


def record_config_warning(key: str, message: str, path: Any = None) -> None:
    with _config_warnings_guard:
        _config_warnings[key] = {
            "key": key,
            "message": message,
            "path": str(path) if path else "",
            "at": time.time(),
        }
    logger.warning(message)


def clear_config_warning(key: str) -> None:
    with _config_warnings_guard:
        _config_warnings.pop(key, None)


def get_config_warnings() -> List[Dict[str, Any]]:
    with _config_warnings_guard:
        return sorted(_config_warnings.values(), key=lambda item: item["at"])


def _migrate_sidecar_document(doc: Any, path: Path) -> Optional[Dict[str, Any]]:
    """Bring a sidecar document up to the current schema, or refuse it.

    Returns None when the document cannot be read at this version, having recorded a
    warning for the user. Callers treat None as "there is no sidecar here" and carry on.
    """
    key = f"sidecar:{path}"
    if not isinstance(doc, dict):
        record_config_warning(key, f"{path.name} is not a configuration document; ignoring it.", path)
        return None

    try:
        version = int(doc.get("version") or SIDECAR_SCHEMA_VERSION)
    except (TypeError, ValueError):
        record_config_warning(key, f"{path.name} has an unreadable version; ignoring it.", path)
        return None

    if version > SIDECAR_SCHEMA_VERSION:
        record_config_warning(
            key,
            f"{path.name} was written by a newer version of Ensembl Go "
            f"(format {version}, this version reads {SIDECAR_SCHEMA_VERSION}). "
            f"Its settings have not been loaded and the file has been left unchanged.",
            path,
        )
        return None

    while version < SIDECAR_SCHEMA_VERSION:
        migrate = _SIDECAR_MIGRATIONS.get(version)
        if migrate is None:
            record_config_warning(
                key,
                f"{path.name} uses format {version}, which this version cannot convert. "
                f"Its settings have not been loaded.",
                path,
            )
            return None
        try:
            doc = migrate(doc)
        except Exception as exc:
            record_config_warning(key, f"Could not convert {path.name} from format {version}: {exc}", path)
            return None
        version += 1

    clear_config_warning(key)
    return doc


def _read_sidecar_document(path: Path) -> Optional[Dict[str, Any]]:
    """Parse and migrate a sidecar, or record why it could not be read."""
    key = f"sidecar:{path}"
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as exc:
        record_config_warning(
            key,
            f"{path.name} could not be read ({exc}). Its settings have not been loaded "
            f"and the file has been left unchanged; the rest of this directory is unaffected.",
            path,
        )
        return None
    return _migrate_sidecar_document(doc, path)


def _output_dir_config_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / OUTPUT_DIR_CONFIG_FILENAME
    except Exception:
        return None


def _config_store_paths_for_config(config: Dict[str, Any]) -> List[Path]:
    paths: List[Path] = []
    seen: Set[str] = set()
    for key in ("output_dir", "working_dir"):
        path = _output_dir_config_store_path(config.get(key))
        if not path:
            continue
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        paths.append(path)
    return paths


def _playlist_store_paths_for_config(config: Dict[str, Any]) -> List[Path]:
    paths: List[Path] = []
    seen: Set[str] = set()
    for key in ("output_dir", "working_dir"):
        path = _output_dir_playlist_store_path(config.get(key))
        if not path:
            continue
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        paths.append(path)
    return paths


def _normalize_output_dir_playlist_state(data: Any) -> Dict[str, Any]:
    if isinstance(data, list):
        playlists = data
        selected_id = "__all__"
    elif isinstance(data, dict):
        playlists = data.get("genome_playlists") or []
        selected_id = str(data.get("selected_genome_playlist_id") or "__all__").strip() or "__all__"
    else:
        playlists = []
        selected_id = "__all__"

    if not isinstance(playlists, list):
        playlists = []
    playlist_ids = {
        str(playlist.get("id") or "").strip()
        for playlist in playlists
        if isinstance(playlist, dict) and str(playlist.get("id") or "").strip()
    }
    if selected_id != "__all__" and selected_id not in playlist_ids:
        selected_id = "__all__"
    return {
        "genome_playlists": playlists,
        "selected_genome_playlist_id": selected_id,
    }


def _normalize_output_dir_config_state(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    candidate = data.get("config") if isinstance(data.get("config"), dict) else data
    return {
        key: value
        for key, value in candidate.items()
        if key in RECOGNIZED_CONFIG_KEYS
    }


def _load_config_state_from_path(path: Path) -> Optional[Dict[str, Any]]:
    doc = _read_sidecar_document(path)
    if doc is None:
        return None
    return _normalize_output_dir_config_state(doc) or None


def _load_config_state_for_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for path in _config_store_paths_for_config(config):
        if not path.exists() or not path.is_file():
            continue
        state = _load_config_state_from_path(path)
        if state:
            return state
    return None


def _merge_output_dir_config_state(config: Dict[str, Any]) -> Dict[str, Any]:
    state = _load_config_state_for_config(config)
    if not state:
        return config
    path_fields = {
        key: config.get(key)
        for key in ("output_dir", "working_dir")
        if str(config.get(key) or "").strip()
    }
    return {
        **config,
        **state,
        **path_fields,
    }


# Whether a configuration is allowed to rewrite the sidecar.
#
# Every key is rewritten on every save from whatever is in memory, so the question that
# decides whether a save is safe is not what the values are — it is whether this
# configuration has read what is already in the directory. A configuration that has is
# entitled to write anything, including emptiness: deselecting every genome, clearing a
# playlist and putting the colours back to the default are all states the user chose and
# expects to find again. A configuration that has not read the directory has defaults for
# a quite different reason, and used to write them straight over the real thing.
#
# Guessing from the values cannot tell those apart. It also cannot see most of the
# settings at all: a fresh configuration has ``dim_non_selected_genes=True`` and the stock
# ``active_app_buttons``, which are not empty and not distinguishable from a deliberate
# choice. So the sidecar carries a revision, a configuration records the revision it
# adopted, and a write is refused unless the two agree.
SIDECAR_REVISION_KEY = "_sidecar_revisions"


def _sidecar_paths_for_config(config: Dict[str, Any]) -> List[Path]:
    return _config_store_paths_for_config(config) + _playlist_store_paths_for_config(config)


def _read_sidecar_revision(path: Path) -> Optional[int]:
    """The revision stored in a sidecar, or None if it cannot be read.

    None is what protects a damaged file: no revision can be matched against it, so no
    write is permitted, and the bytes stay on disk for the user to recover rather than
    being replaced by whatever this process happens to hold.
    """
    doc = _read_sidecar_document(path)
    if doc is None:
        return None
    try:
        return int(doc.get("revision") or 0)
    except (TypeError, ValueError):
        return None


def _record_sidecar_revisions(config: Dict[str, Any]) -> Dict[str, Any]:
    """Record the revisions this configuration has now read. Call after adopting them."""
    revisions = dict(config.get(SIDECAR_REVISION_KEY) or {})
    for path in _sidecar_paths_for_config(config):
        if not path.exists():
            continue
        revision = _read_sidecar_revision(path)
        if revision is not None:
            revisions[str(path)] = revision
    if not revisions:
        return config
    return {**config, SIDECAR_REVISION_KEY: revisions}


def _may_write_sidecar(config: Dict[str, Any], path: Path, force: bool) -> Optional[int]:
    """The revision to write, or None to leave the file alone."""
    if not path.exists():
        return 1
    stored = _read_sidecar_revision(path)
    if stored is None:
        if force:
            return 1
        return None
    if force:
        return stored + 1
    adopted = (config.get(SIDECAR_REVISION_KEY) or {}).get(str(path))
    if adopted != stored:
        logger.warning(
            f"Not rewriting {path}: this configuration has not read it "
            f"(adopted revision {adopted!r}, on disk {stored!r})"
        )
        return None
    return stored + 1


def _note_written_revision(config: Dict[str, Any], path: Path, revision: int) -> None:
    """Keep the in-memory configuration current so consecutive saves are allowed."""
    revisions = config.get(SIDECAR_REVISION_KEY)
    if not isinstance(revisions, dict):
        revisions = {}
        config[SIDECAR_REVISION_KEY] = revisions
    revisions[str(path)] = revision


def _backup_sidecar(path: Path) -> None:
    """Keep the previous sidecar beside the new one.

    The revision check stops the known way of flattening these settings; this is for the
    ones not yet known. A single `.bak` turns any future clobber into something the user
    can recover by hand rather than something they discover months later.
    """
    if not path.exists():
        return
    try:
        shutil.copy2(path, path.parent / f"{path.name}.bak")
    except OSError as exc:
        logger.warning(f"Failed to back up {path}: {exc}")


def _save_output_dir_config_state(
    config: Dict[str, Any], force: bool = False
) -> None:
    paths = _config_store_paths_for_config(config)
    if not paths:
        return
    payload = {
        key: config.get(key, default)
        for key, default in DEFAULT_CONFIG.items()
    }
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            revision = _may_write_sidecar(config, path, force)
            if revision is None:
                continue
            _backup_sidecar(path)
            tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                    json.dump({
                        "version": SIDECAR_SCHEMA_VERSION,
                        "revision": revision,
                        "config": payload,
                    }, f, indent=2)
                os.replace(tmp_path, path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            _note_written_revision(config, path, revision)
        except Exception as exc:
            logger.warning(f"Failed to persist configuration to {path}: {exc}")


def _ensure_output_dir_config_state(config: Dict[str, Any]) -> None:
    paths = _config_store_paths_for_config(config)
    if not paths:
        return
    if all(path.exists() for path in paths):
        return
    _save_output_dir_config_state(config)


def _load_output_dir_playlist_state(output_dir: Any) -> Optional[Dict[str, Any]]:
    path = _output_dir_playlist_store_path(output_dir)
    if not path or not path.exists() or not path.is_file():
        return None
    return _load_playlist_state_from_path(path)


def _load_playlist_state_from_path(path: Path) -> Optional[Dict[str, Any]]:
    doc = _read_sidecar_document(path)
    if doc is None:
        return None
    return _normalize_output_dir_playlist_state(doc)


def _load_playlist_state_for_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    empty_state: Optional[Dict[str, Any]] = None
    for path in _playlist_store_paths_for_config(config):
        if not path.exists() or not path.is_file():
            continue
        state = _load_playlist_state_from_path(path)
        if not state:
            continue
        if state.get("genome_playlists"):
            return state
        if empty_state is None:
            empty_state = state
    return empty_state


def _merge_output_dir_playlist_state(config: Dict[str, Any]) -> Dict[str, Any]:
    state = _load_playlist_state_for_config(config)
    if not state:
        return config
    if not state.get("genome_playlists") and config.get("genome_playlists"):
        return config
    return {
        **config,
        "genome_playlists": state["genome_playlists"],
        "selected_genome_playlist_id": state["selected_genome_playlist_id"],
    }


def _save_output_dir_playlist_state(
    config: Dict[str, Any], force: bool = False
) -> None:
    """Persist the playlists beside the data they refer to.

    Emptying them is a real thing a user does, so this writes whatever it is given —
    but only once the configuration has read what is already there. See
    SIDECAR_REVISION_KEY.
    """
    paths = _playlist_store_paths_for_config(config)
    if not paths:
        return
    state = _normalize_output_dir_playlist_state({
        "genome_playlists": config.get("genome_playlists") or [],
        "selected_genome_playlist_id": config.get("selected_genome_playlist_id") or "__all__",
    })
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = dict(state)
            revision = _may_write_sidecar(config, path, force)
            if revision is None:
                continue
            _backup_sidecar(path)
            tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                    json.dump({
                        "version": SIDECAR_SCHEMA_VERSION,
                        "revision": revision,
                        **payload,
                    }, f, indent=2)
                os.replace(tmp_path, path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            _note_written_revision(config, path, revision)
        except Exception as exc:
            logger.warning(f"Failed to persist genome playlists to {path}: {exc}")


def _ensure_output_dir_playlist_state(config: Dict[str, Any]) -> None:
    if not config.get("genome_playlists"):
        return
    if all(path.exists() for path in _playlist_store_paths_for_config(config)):
        return
    _save_output_dir_playlist_state(config)


#: How long a loaded configuration may be reused. Long enough to collapse the
#: burst of reads a single round of browser polling causes, short enough that a
#: change made anywhere — including in the sidecar files this merges in, which
#: have no mtime of their own to watch — is picked up before anyone notices.
CONFIG_CACHE_TTL_SECONDS = 0.5


_config_cache_guard = threading.Lock()


#: ``(config file signature, loaded at, config)``
_config_cache: Optional[Tuple[Tuple[int, int], float, dict]] = None


def _config_file_signature() -> Tuple[int, int]:
    try:
        stat = CONFIG_FILE.stat()
    except OSError:
        return (0, 0)
    return (stat.st_mtime_ns, stat.st_size)


def invalidate_config_cache() -> None:
    """Drop the cached configuration. Called whenever the file is written."""
    global _config_cache
    with _config_cache_guard:
        _config_cache = None


def _preserve_unreadable_config(path: Path) -> Optional[Path]:
    """Move a configuration we cannot parse aside so the next save cannot erase it."""
    target = path.parent / f"{path.name}.corrupt"
    try:
        if target.exists():
            target.unlink()
        shutil.copy2(path, target)
        return target
    except OSError as exc:
        logger.warning(f"Could not preserve the unreadable configuration {path}: {exc}")
        return None


def _load_config_uncached() -> dict:
    """Read the saved configuration, falling back to defaults.

    A configuration that cannot be read used to be swallowed whole: the exception was
    discarded and a *default* configuration returned, with nothing said to anyone. The
    user then saw an app that had forgotten them, and the next save wrote those defaults
    over the copy in their working directory — turning one damaged file into two. So the
    two failures are now kept apart. Nothing saved yet is ordinary and silent. A file
    that exists and will not parse is reported, kept (under `.corrupt`), and does not
    become the authority for anything: the sidecars refuse writes from a configuration
    that has not read them, so the working directory survives intact.
    """
    saved: Optional[dict] = None
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                saved = json.load(f)
            if not isinstance(saved, dict):
                raise ValueError("configuration is not an object")
            clear_config_warning("config-file")
        except Exception as exc:
            saved = None
            kept = _preserve_unreadable_config(CONFIG_FILE)
            record_config_warning(
                "config-file",
                f"Your saved settings could not be read ({exc}). Ensembl Go has started "
                f"with default settings"
                + (f"; the file was kept as {kept.name}" if kept else "")
                + ". Any settings stored in your working directory are unaffected and "
                "will be loaded when you point at it again.",
                CONFIG_FILE,
            )

    merged = {**DEFAULT_CONFIG, **(saved or {})}
    try:
        merged = _merge_output_dir_config_state(merged)
        merged = _merge_output_dir_playlist_state(merged)
        merged = _record_sidecar_revisions(merged)
        _ensure_output_dir_config_state(merged)
        _ensure_output_dir_playlist_state(merged)
    except Exception as exc:
        # The sidecars are best-effort: their own readers already report what they could
        # not read. Never let one stop the application starting.
        logger.warning(f"Could not merge the working directory configuration: {exc}")
    return _enrich_config_genome_labels(merged)


def load_config() -> dict:
    """Load config from disk, falling back to defaults.

    Reads are cached for :data:`CONFIG_CACHE_TTL_SECONDS`, keyed on the config
    file's mtime and size. Nearly every endpoint starts by loading the
    configuration, and while a genome indexes the browser polls several of them
    a second per panel; each of those was re-reading the file, re-merging two
    sidecars and re-deriving every genome's labels.

    Callers get a deep copy. Several of them mutate what they are handed, and a
    cache that returned the same object would let one endpoint's edits show up
    in another's.
    """
    global _config_cache
    signature = _config_file_signature()
    now = time.monotonic()
    with _config_cache_guard:
        cached = _config_cache
        if (
            cached is not None
            and cached[0] == signature
            and now - cached[1] < CONFIG_CACHE_TTL_SECONDS
        ):
            return copy.deepcopy(cached[2])

    loaded = _load_config_uncached()
    with _config_cache_guard:
        _config_cache = (signature, time.monotonic(), loaded)
    return copy.deepcopy(loaded)


def save_config(
    config: dict, path: Optional[Path] = None, *, force_sidecar: bool = False
):
    """Persist config to disk using an atomic write (temp file + rename).

    ``force_sidecar`` writes the output-directory sidecars even though this
    configuration has not adopted them — for importing a configuration file, where
    overwriting what is in the directory is the whole point.
    """
    if path is None:
        path = CONFIG_FILE
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(config, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    invalidate_config_cache()
    if path == CONFIG_FILE:
        _save_output_dir_config_state(config, force=force_sidecar)
        _save_output_dir_playlist_state(config, force=force_sidecar)
