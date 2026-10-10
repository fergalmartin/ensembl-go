"""The Track Manager: the custom-track registry (output-directory sidecar first), per-
type display settings and their normalisation, track-hub discovery and import, track
groups, the browser's remembered session tracks, and the /api/tracks, /api/track-
groups and session endpoints.
"""

import asyncio
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import config_store
import data_paths
import routes.notes
from bed_index import looks_like_gene_models
from demo_genome import (
    is_inside_tutorial_workspace,
    tutorial_session_workspace,
    TUTORIAL_WORKSPACE_DIR,
)
from genome_identity import DEFAULT_PROVIDER, normalize_provider
from security_utils import (
    get_with_validated_redirects,
    normalize_trackhub_data_url,
    safe_url_basename,
    validate_trackhub_data_url,
)
from stats_utils import now_iso
from trackhub_registry import list_tracks_for_genomes

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
#  Track Manager — Registry & Data Endpoints
# ═══════════════════════════════════════════════════════════════════════════════

OUTPUT_DIR_TRACK_REGISTRY_FILENAME = "track_registry.json"


DEFAULT_TRACK_REGISTRY_FILE = app_paths.CACHE_DIR / OUTPUT_DIR_TRACK_REGISTRY_FILENAME


TRACK_REGISTRY_FILE = DEFAULT_TRACK_REGISTRY_FILE


TRACK_EXTENSION_MAP: Dict[str, str] = {
    ".bw":         "bigwig",
    ".bigwig":     "bigwig",
    ".bb":         "bigbed",
    ".bigbed":     "bigbed",
    ".vcf.gz":     "vcf",
    ".vcf":        "vcf",
    ".bed.gz":     "bed",
    ".bed":        "bed",
    # GFF3 and GTF as generic interval tracks (regulatory features, repeats, ...).
    ".gff":        "gff",
    ".gff3":       "gff",
    ".gtf":        "gff",
    ".gff.gz":     "gff",
    ".gff3.gz":    "gff",
    ".gtf.gz":     "gff",
    ".bam":        "bam",
    ".sj.out.tab": "splice_junctions",
}


TRACK_DISPLAY_MODES: Dict[str, List[str]] = {
    "bigwig":           ["zoned_heatmap", "signal_plot"],
    "bigbed":           ["intervals", "density"],
    "vcf":              ["density_lollipop", "adaptive", "ensembl", "lollipop", "density"],
    "bed":              ["intervals", "density"],
    # "transcripts" draws gene models assembled from exon/CDS/UTR lines.
    "gff":              ["intervals", "transcripts", "density"],
    "bam":              ["coverage", "reads_coverage"],
    "long_reads":       ["collapsed_transcripts"],
    "splice_junctions": ["arcs"],
}


_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


_BIGWIG_DATA_TYPES: Set[str] = {"rna_seq", "atac_seq", "chip_seq", "custom"}


BIGWIG_DATA_TYPE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "rna_seq": {
        "display_mode": "zoned_heatmap",
        "plot_color": "#3b82f6",
        "zoned_colors": ["#f7cd61", "#f4a940", "#ea7a2d", "#cc2f1f"],
        # Read coverage: the fixed 100 / 1k / 10k / 100k zones were made for it.
        "zone_scale": "fixed",
    },
    "atac_seq": {
        "display_mode": "signal_plot",
        "plot_color": "#b52aa1",
        "zoned_colors": ["#86efac", "#4ade80", "#22c55e", "#15803d"],
        # Signal in the file's own units (an ATAC track can top out below 10), so
        # the zones are set from the file's peaks rather than read coverage.
        "zone_scale": "file",
    },
    "chip_seq": {
        "display_mode": "signal_plot",
        "plot_color": "#8b5cf6",
        "zoned_colors": ["#c4b5fd", "#a78bfa", "#8b5cf6", "#6d28d9"],
        # Signal in the file's own units (an ATAC track can top out below 10), so
        # the zones are set from the file's peaks rather than read coverage.
        "zone_scale": "file",
    },
    "custom": {
        "display_mode": "signal_plot",
        "plot_color": "#14b8a6",
        "zoned_colors": ["#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8"],
        # Signal in the file's own units (an ATAC track can top out below 10), so
        # the zones are set from the file's peaks rather than read coverage.
        "zone_scale": "file",
    },
}


BIGWIG_ZONE_SCALES: Set[str] = {"fixed", "file", "files", "custom"}


def _normalize_bigwig_custom_zones(raw: Any) -> Optional[List[float]]:
    """Four user-set zone edges, positive and increasing, or None when they are not."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        zones = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) and v > 0 for v in zones):
        return None
    if any(b <= a for a, b in zip(zones, zones[1:])):
        return None
    return zones


VCF_DISPLAY_MODES: Set[str] = {"density_lollipop", "adaptive"}


VCF_SETTINGS_DEFAULTS: Dict[str, str] = {
    "genic_color": "#00b692",
    "intergenic_color": "#96d0c9",
}


def _detect_track_type(path: str) -> Optional[str]:
    p = path.lower()
    # Check compound suffixes first
    for ext, ttype in sorted(TRACK_EXTENSION_MAP.items(), key=lambda x: -len(x[0])):
        if p.endswith(ext):
            return ttype
    return None


def _detect_long_read_bam(path: str) -> bool:
    """Heuristic: if BAM path contains 'long', 'ont', 'pacbio', 'isoseq', 'nanopore', treat as long-read."""
    lower = path.lower()
    return any(k in lower for k in ("long_read", "longreads", "ont", "pacbio", "isoseq", "nanopore", "minimap", "flair"))


def _tracks_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The configuration the track registry should be resolved against.

    Normally the user's own. While a tutorial is running it is that configuration with its
    output directory swapped for the tutorial's workspace, so a track registered during a
    tutorial is written into the scratch directory and swept away with it.

    This has to happen here rather than in the frontend's config override. The override is
    a frontend fact; every tracks endpoint resolves its store from the configuration *on
    disk*, so without this the three demo tracks the Track Manager tutorial asks the reader
    to register land in the user's own ``track_registry.json`` and outlive the tutorial —
    pointing, by then, at files inside a workspace that has been deleted. Same shape as
    ``_notes_config`` and ``_browsable_active_species``, and for the same reason.
    """
    cfg = dict(config or config_store.load_config())
    workspace = tutorial_session_workspace()
    if workspace:
        cfg["output_dir"] = workspace
    return cfg


def _output_dir_track_registry_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / OUTPUT_DIR_TRACK_REGISTRY_FILENAME
    except Exception:
        return None


def _track_registry_store_paths_for_config(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    cfg = config or {}
    paths: List[Path] = []
    use_output_sidecar = str(TRACK_REGISTRY_FILE) == str(DEFAULT_TRACK_REGISTRY_FILE)
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    if sidecar:
        paths.append(sidecar)
    if sidecar and TUTORIAL_WORKSPACE_DIR in sidecar.parts:
        # A tutorial's tracks are its own. Falling back to the global registry would list
        # the user's real tracks inside the tutorial — pointing at genomes the sandbox has
        # hidden — and, because the registry is written back out, could copy them into a
        # scratch directory that is about to be deleted.
        return [sidecar]
    paths.append(TRACK_REGISTRY_FILE)

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


def _load_track_registry_from_path(path: Path) -> Optional[Dict[str, Any]]:
    if path.exists():
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                tracks = data.get("tracks")
                if isinstance(tracks, list):
                    return data
        except Exception:
            return None
    return None


def _load_track_registry(config: Optional[Dict[str, Any]] = None) -> Dict:
    cfg = config or _tracks_config()
    empty_registry: Optional[Dict[str, Any]] = None
    for path in _track_registry_store_paths_for_config(cfg):
        registry = _load_track_registry_from_path(path)
        if not registry:
            continue
        if registry.get("tracks"):
            return registry
        if empty_registry is None:
            empty_registry = registry
    if empty_registry is not None:
        return empty_registry
    return {"tracks": []}


def _primary_track_registry_store_path(config: Optional[Dict[str, Any]] = None) -> Path:
    cfg = config or {}
    use_output_sidecar = str(TRACK_REGISTRY_FILE) == str(DEFAULT_TRACK_REGISTRY_FILE)
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir")) if use_output_sidecar else None
    return sidecar or TRACK_REGISTRY_FILE


def _save_track_registry(registry: Dict, config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or config_store.load_config()
    path = _primary_track_registry_store_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass


def _ensure_track_registry_sidecar(config: Optional[Dict[str, Any]] = None) -> None:
    cfg = config or config_store.load_config()
    sidecar = _output_dir_track_registry_store_path(cfg.get("output_dir"))
    if not sidecar:
        return
    registry = _load_track_registry(cfg)
    if not registry.get("tracks") and sidecar.exists():
        return
    try:
        _save_track_registry(registry, cfg)
    except Exception:
        pass


_track_registry_lock = threading.Lock()


DEFAULT_SPLICE_SETTINGS: Dict[str, Any] = {
    "min_support": 1,
    "canonical_mode": "all",     # all | canonical | non_canonical
    "annotated_mode": "all",     # all | annotated | novel
    "show_arrows": True,
    "max_junctions": 5000,
    "weak_max_support": 2,
    "low_max_support": 4,
    "medium_max_support": 9,
}


_CANONICAL_SPLICE_MODES = {"all", "canonical", "non_canonical"}


_ANNOTATED_SPLICE_MODES = {"all", "annotated", "novel"}


_CANONICAL_SPLICE_MOTIFS = {
    "GT/AG", "CT/AC",
    "GC/AG", "CT/GC",
    "AT/AC", "GT/AT",
    "GT-AG", "CT-AC",
    "GC-AG", "CT-GC",
    "AT-AC", "GT-AT",
}


def _to_int_or_default(value: Any, default: int, minimum: Optional[int] = None, maximum: Optional[int] = None) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _to_bool_or_default(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _normalize_hex_color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    if _HEX_COLOR_RE.match(text):
        return text.lower()
    return str(fallback).strip().lower()


def _normalize_bigwig_data_type(value: Any, default: str = "rna_seq") -> str:
    token = str(value or "").strip().lower()
    return token if token in _BIGWIG_DATA_TYPES else default


def _normalize_bigwig_display_mode(mode: Any, data_type: str = "rna_seq") -> str:
    token = str(mode or "").strip().lower()
    if token in {"line_plot", "bar_chart"}:
        token = "signal_plot"
    if token in {"zoned_heatmap", "signal_plot"}:
        return token
    normalized_type = _normalize_bigwig_data_type(data_type, "rna_seq")
    return str(BIGWIG_DATA_TYPE_DEFAULTS[normalized_type]["display_mode"])


def _normalize_bigwig_zoned_colors(raw: Any, fallback: List[str]) -> List[str]:
    base = list(fallback) if isinstance(fallback, list) and len(fallback) >= 4 else list(BIGWIG_DATA_TYPE_DEFAULTS["rna_seq"]["zoned_colors"])
    if not isinstance(raw, list):
        return [str(c).lower() for c in base[:4]]
    out: List[str] = []
    for i in range(4):
        fallback_color = str(base[i] if i < len(base) else base[-1]).lower()
        value = raw[i] if i < len(raw) else fallback_color
        out.append(_normalize_hex_color(value, fallback_color))
    return out


def _normalize_bigwig_settings(raw: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prev_data_type = _normalize_bigwig_data_type((previous or {}).get("data_type"), "rna_seq")
    prev_defaults = BIGWIG_DATA_TYPE_DEFAULTS[prev_data_type]
    prev_plot = _normalize_hex_color((previous or {}).get("plot_color"), prev_defaults["plot_color"])
    prev_zones = _normalize_bigwig_zoned_colors((previous or {}).get("zoned_colors"), list(prev_defaults["zoned_colors"]))
    prev_use_plot_default = _to_bool_or_default((previous or {}).get("use_default_plot_color"), True)
    prev_use_zoned_defaults = _to_bool_or_default((previous or {}).get("use_default_zoned_colors"), True)

    settings = raw if isinstance(raw, dict) else {}
    data_type = _normalize_bigwig_data_type(settings.get("data_type"), prev_data_type)
    defaults = BIGWIG_DATA_TYPE_DEFAULTS[data_type]

    use_default_plot_color = _to_bool_or_default(settings.get("use_default_plot_color"), prev_use_plot_default)
    use_default_zoned_colors = _to_bool_or_default(settings.get("use_default_zoned_colors"), prev_use_zoned_defaults)

    if use_default_plot_color:
        plot_color = str(defaults["plot_color"]).lower()
    else:
        plot_color = _normalize_hex_color(settings.get("plot_color"), prev_plot)

    if use_default_zoned_colors:
        zoned_colors = [str(c).lower() for c in defaults["zoned_colors"]]
    else:
        zoned_colors = _normalize_bigwig_zoned_colors(settings.get("zoned_colors"), prev_zones)

    # How the zoned heatmap's zones are placed: "fixed" (100 / 1k / 10k / 100k, for read
    # coverage), "file" (from this file's own peak heights), "files" (from the peaks of
    # every file registered with it, stored in shared_zones, so they compare directly) or
    # "custom" (edges the user typed, in custom_zones). Unset — every track registered
    # before the choice existed — takes its data type's default.
    zone_scale = str(settings.get("zone_scale") or (previous or {}).get("zone_scale") or defaults["zone_scale"]).strip().lower()
    if zone_scale not in BIGWIG_ZONE_SCALES:
        zone_scale = defaults["zone_scale"]

    custom_zones = _normalize_bigwig_custom_zones(settings.get("custom_zones"))
    if custom_zones is None:
        custom_zones = _normalize_bigwig_custom_zones((previous or {}).get("custom_zones"))
    shared_zones = _normalize_bigwig_custom_zones(settings.get("shared_zones"))
    if shared_zones is None:
        shared_zones = _normalize_bigwig_custom_zones((previous or {}).get("shared_zones"))
    # Shared zones exist only as computed from a set of files; without them there is
    # nothing to share, and the file's own peaks are the nearest thing.
    if zone_scale == "files" and shared_zones is None:
        zone_scale = "file"

    return {
        "data_type": data_type,
        "plot_color": plot_color,
        "zoned_colors": zoned_colors,
        "use_default_plot_color": use_default_plot_color,
        "use_default_zoned_colors": use_default_zoned_colors,
        "zone_scale": zone_scale,
        # Kept whichever scale is in use, so switching back to custom finds them again.
        "custom_zones": custom_zones,
        "shared_zones": shared_zones,
    }


def _normalize_vcf_display_mode(mode: Any) -> str:
    token = str(mode or "").strip().lower()
    if token in {"block_lollipop", "block-lollipop"}:
        token = "adaptive"
    if token in {"ensembl", "lollipop", "density"}:
        token = "density_lollipop"
    return token if token in VCF_DISPLAY_MODES else "density_lollipop"


def _normalize_vcf_settings(raw: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    prev = previous if isinstance(previous, dict) else {}
    base = {
        "genic_color": _normalize_hex_color(prev.get("genic_color"), VCF_SETTINGS_DEFAULTS["genic_color"]),
        "intergenic_color": _normalize_hex_color(prev.get("intergenic_color"), VCF_SETTINGS_DEFAULTS["intergenic_color"]),
    }
    source = raw if isinstance(raw, dict) else {}
    return {
        "genic_color": _normalize_hex_color(source.get("genic_color"), base["genic_color"]),
        "intergenic_color": _normalize_hex_color(source.get("intergenic_color"), base["intergenic_color"]),
    }


def _normalize_bed_settings(raw: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """A BED/BigBed track's colour. Empty means automatic: the file's own itemRgb
    colours where it has them, and the default track colour where it does not."""
    prev = previous if isinstance(previous, dict) else {}
    base = _normalize_hex_color(prev.get("color"), "")
    source = raw if isinstance(raw, dict) else {}
    if "color" in source and not str(source.get("color") or "").strip():
        return {"color": ""}
    return {"color": _normalize_hex_color(source.get("color"), base)}


def _normalize_splice_settings(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    settings = dict(DEFAULT_SPLICE_SETTINGS)
    if isinstance(raw, dict):
        settings.update(raw)

    canonical_mode = str(settings.get("canonical_mode", "all")).strip().lower()
    if canonical_mode not in _CANONICAL_SPLICE_MODES:
        canonical_mode = "all"

    annotated_mode = str(settings.get("annotated_mode", "all")).strip().lower()
    if annotated_mode not in _ANNOTATED_SPLICE_MODES:
        annotated_mode = "all"

    min_support = _to_int_or_default(settings.get("min_support"), 1, minimum=1, maximum=1_000_000)
    weak_max_support = _to_int_or_default(
        settings.get("weak_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["weak_max_support"]),
        minimum=min_support,
        maximum=1_000_000,
    )
    low_max_support = _to_int_or_default(
        settings.get("low_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["low_max_support"]),
        minimum=weak_max_support + 1,
        maximum=1_000_000,
    )
    medium_max_support = _to_int_or_default(
        settings.get("medium_max_support"),
        int(DEFAULT_SPLICE_SETTINGS["medium_max_support"]),
        minimum=low_max_support + 1,
        maximum=1_000_000,
    )

    return {
        "min_support": min_support,
        "canonical_mode": canonical_mode,
        "annotated_mode": annotated_mode,
        "show_arrows": _to_bool_or_default(settings.get("show_arrows"), True),
        "max_junctions": _to_int_or_default(settings.get("max_junctions"), 5000, minimum=100, maximum=100_000),
        "weak_max_support": weak_max_support,
        "low_max_support": low_max_support,
        "medium_max_support": medium_max_support,
    }


def _hydrate_track_defaults(track: Dict[str, Any]) -> Dict[str, Any]:
    hydrated = dict(track)
    track_type = hydrated.get("type")
    source_token = str(hydrated.get("source") or "").strip().lower()
    if source_token:
        hydrated["source"] = source_token
    if source_token == "trackhub":
        hydrated["source_meta"] = _normalize_trackhub_source_meta(hydrated.get("source_meta")) or {}
    elif "source_meta" in hydrated and hydrated.get("source_meta") is None:
        hydrated["source_meta"] = None
    if track_type == "bigwig":
        bigwig_settings = _normalize_bigwig_settings(hydrated.get("bigwig_settings"))
        hydrated["bigwig_settings"] = bigwig_settings
        hydrated["display_mode"] = _normalize_bigwig_display_mode(hydrated.get("display_mode"), bigwig_settings["data_type"])
    if track_type == "vcf":
        had_vcf_settings = isinstance(hydrated.get("vcf_settings"), dict)
        hydrated["vcf_settings"] = _normalize_vcf_settings(hydrated.get("vcf_settings"))
        # Auto-migrate legacy VCF tracks without vcf_settings to Density-Lollipop.
        if not had_vcf_settings:
            hydrated["display_mode"] = "density_lollipop"
        else:
            hydrated["display_mode"] = _normalize_vcf_display_mode(hydrated.get("display_mode"))
    if track_type == "splice_junctions":
        hydrated["splice_settings"] = _normalize_splice_settings(hydrated.get("splice_settings"))
        hydrated["display_mode"] = "arcs"
    if track_type in ("bed", "bigbed", "gff"):
        hydrated["bed_settings"] = _normalize_bed_settings(hydrated.get("bed_settings"))
    return hydrated


def _hydrate_track_genome_label(track: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    hydrated = dict(track)
    genome_key = str(hydrated.get("genome_key") or "").strip()
    if not genome_key:
        return hydrated
    metadata = config_store._genome_key_display_metadata(genome_key, config)
    if metadata:
        hydrated["genome_label"] = metadata.get("label", "")
        hydrated["genome_species_label"] = metadata.get("species_label", "")
        hydrated["display_name"] = metadata.get("display_name", "")
        hydrated["display_name_reason"] = metadata.get("display_name_reason", "")
        hydrated["genome_assembly_name"] = metadata.get("assembly_name", "")
        hydrated["genome_assembly_accession"] = metadata.get("assembly", "")
    return hydrated


def _get_registered_track(track_id: str) -> Optional[Dict[str, Any]]:
    if not track_id:
        return None
    try:
        registry = _load_track_registry()
        for track in registry.get("tracks", []):
            if str(track.get("id")) == str(track_id):
                return _hydrate_track_defaults(track)
    except Exception:
        return None
    return None


def _is_canonical_splice_motif(motif: str) -> bool:
    token = str(motif or "").strip().upper()
    return token in _CANONICAL_SPLICE_MOTIFS


TRACKHUB_IMPORT_TASK_TTL_SECONDS = 60 * 60 * 24


_trackhub_import_tasks_guard = threading.Lock()


_trackhub_import_tasks: Dict[str, Dict[str, Any]] = {}


def _prune_trackhub_import_tasks() -> None:
    now_ts = time.time()
    with _trackhub_import_tasks_guard:
        stale_ids = []
        for task_id, task in _trackhub_import_tasks.items():
            status = str(task.get("status") or "")
            updated_at = float(task.get("_updated_ts") or now_ts)
            if status in {"completed", "failed"} and (now_ts - updated_at) > TRACKHUB_IMPORT_TASK_TTL_SECONDS:
                stale_ids.append(task_id)
        for task_id in stale_ids:
            _trackhub_import_tasks.pop(task_id, None)


def _read_trackhub_import_tasks() -> List[Dict[str, Any]]:
    _prune_trackhub_import_tasks()
    with _trackhub_import_tasks_guard:
        out = []
        for task in _trackhub_import_tasks.values():
            payload = {k: v for k, v in task.items() if not k.startswith("_")}
            out.append(json.loads(json.dumps(payload)))
    out.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
    return out


def _set_trackhub_import_task(task_id: str, **changes: Any) -> None:
    with _trackhub_import_tasks_guard:
        task = _trackhub_import_tasks.get(task_id)
        if task is None:
            return
        task.update(changes)
        task["updated_at"] = now_iso()
        task["_updated_ts"] = time.time()


def _compute_trackhub_import_key(hub_id: Any, track_id: Any, assembly: Any, data_url: Any) -> str:
    payload = "|".join(
        [
            str(hub_id or "").strip(),
            str(track_id or "").strip(),
            str(assembly or "").strip(),
            str(data_url or "").strip(),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _normalize_trackhub_format(format_value: Any, data_url: str = "") -> Tuple[str, str]:
    token = str(format_value or "").strip().lower().replace("_", "").replace("-", "").replace(".", "")
    if token in {"bigwig", "bigwigfile"}:
        return "bigWig", "bigwig"
    if token in {"bigbed", "bigbedfile"}:
        return "bigBed", "bigbed"

    lower_url = str(data_url or "").strip().lower()
    if lower_url.endswith(".bw") or lower_url.endswith(".bigwig"):
        return "bigWig", "bigwig"
    if lower_url.endswith(".bb") or lower_url.endswith(".bigbed"):
        return "bigBed", "bigbed"
    return "", ""


def _normalize_trackhub_source_meta(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    hub_id = str(raw.get("hub_id") or "").strip()
    track_id = str(raw.get("track_id") or "").strip()
    assembly = str(raw.get("assembly") or "").strip()
    data_url = _normalize_trackhub_data_url(str(raw.get("data_url") or "").strip())
    format_name, _ = _normalize_trackhub_format(raw.get("format"), data_url)
    raw_import_key = str(raw.get("import_key") or "").strip()
    import_key = raw_import_key
    if not import_key and (hub_id or track_id or assembly or data_url):
        import_key = _compute_trackhub_import_key(hub_id, track_id, assembly, data_url)
    return {
        "hub_id": hub_id,
        "hub_name": str(raw.get("hub_name") or "").strip(),
        "track_id": track_id,
        "track_name": str(raw.get("track_name") or "").strip(),
        "assembly": assembly,
        "format": format_name or str(raw.get("format") or "").strip(),
        "data_url": data_url,
        "description": str(raw.get("description") or "").strip(),
        "import_key": import_key,
    }


def _normalize_trackhub_data_url(url: str) -> str:
    return normalize_trackhub_data_url(url)


def _validate_trackhub_data_url(url: str) -> str:
    return validate_trackhub_data_url(url)


def _trackhub_output_filename(source_meta: Dict[str, Any], data_url: str, track_type: str) -> str:
    parsed = urlparse(data_url)
    basename = safe_url_basename(parsed.path or "")
    if basename:
        stem = Path(basename).stem
        ext = Path(basename).suffix
    else:
        stem = ""
        ext = ""

    if track_type == "bigwig":
        wanted_ext = ".bw"
    elif track_type == "bigbed":
        wanted_ext = ".bb"
    else:
        wanted_ext = ".dat"

    if not stem:
        stem = str(source_meta.get("track_name") or source_meta.get("track_id") or "trackhub_track").strip()
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    if not safe_stem:
        safe_stem = "trackhub_track"

    if ext.lower() not in {".bw", ".bigwig", ".bb", ".bigbed"}:
        ext = wanted_ext
    return f"{safe_stem}{ext}"


def _trackhub_download_sync(task_id: str, url: str, destination: Path) -> None:
    temp_file = destination.with_suffix(destination.suffix + ".tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_progress_emit = 0.0
    max_bytes = 2 * 1024 * 1024 * 1024
    try:
        _set_trackhub_import_task(task_id, status="downloading", progress=0.0, error="")
        with get_with_validated_redirects(
            url, validate_trackhub_data_url, stream=True, timeout=90
        ) as response:
            response.raise_for_status()
            total_size = int(response.headers.get("content-length", 0))
            if total_size > max_bytes:
                raise RuntimeError("Track Hub file is larger than the 2 GB import limit")
            downloaded = 0
            with open(temp_file, "wb") as fh:
                for chunk in response.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise RuntimeError("Track Hub file exceeded the 2 GB import limit")
                    if total_size > 0:
                        progress = min(0.99, downloaded / total_size)
                        if (progress - last_progress_emit) >= 0.01:
                            last_progress_emit = progress
                            _set_trackhub_import_task(task_id, progress=progress)

        if destination.suffix.lower() in {".gz", ".bw", ".bb", ".bigwig", ".bigbed"}:
            if temp_file.stat().st_size <= 0:
                raise RuntimeError("Downloaded file is empty")

        temp_file.replace(destination)
        _set_trackhub_import_task(task_id, progress=1.0)
    except Exception:
        if temp_file.exists():
            temp_file.unlink()
        raise


def _find_existing_trackhub_track(genome_key: str, source_meta: Dict[str, Any], destination: Path) -> Optional[Dict[str, Any]]:
    data_url = str(source_meta.get("data_url") or "").strip()
    import_key = str(source_meta.get("import_key") or "").strip()
    dest_resolved = str(destination.resolve())
    registry = _load_track_registry()
    for track in registry.get("tracks", []):
        if str(track.get("genome_key") or "") != str(genome_key or ""):
            continue
        source = str(track.get("source") or "").strip().lower()
        if source == "trackhub":
            existing_meta = _normalize_trackhub_source_meta(track.get("source_meta"))
            if existing_meta:
                if import_key and str(existing_meta.get("import_key") or "").strip() == import_key:
                    return _hydrate_track_defaults(track)
                if data_url and str(existing_meta.get("data_url") or "").strip() == data_url:
                    return _hydrate_track_defaults(track)
        try:
            if str(Path(track.get("path") or "").expanduser().resolve()) == dest_resolved:
                return _hydrate_track_defaults(track)
        except Exception:
            continue
    return None


class TrackHubGenomeRequest(BaseModel):
    genome_key: str
    species_key: str = ""
    scientific_name: str = ""
    common_name: str = ""
    assembly: str = ""
    assembly_name: str = ""


class TrackHubDiscoverRequest(BaseModel):
    genomes: List[TrackHubGenomeRequest]
    refresh: bool = False


class TrackHubImportItem(BaseModel):
    genome_key: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    label: Optional[str] = None
    source_meta: Dict[str, Any]


class TrackHubImportRequest(BaseModel):
    output_dir: str
    items: List[TrackHubImportItem]


class TrackRegistryEntry(BaseModel):
    path: str
    label: str
    type: Optional[str] = None       # auto-detected if None
    display_mode: Optional[str] = None
    genome_key: Optional[str] = None  # provider-aware key or free-text assembly accession
    splice_settings: Optional[Dict[str, Any]] = None
    bigwig_settings: Optional[Dict[str, Any]] = None
    vcf_settings: Optional[Dict[str, Any]] = None
    bed_settings: Optional[Dict[str, Any]] = None
    source: Optional[str] = None
    source_meta: Optional[Dict[str, Any]] = None


class TrackRegistryUpdateEntry(BaseModel):
    label: Optional[str] = None
    display_mode: Optional[str] = None
    genome_key: Optional[str] = None
    splice_settings: Optional[Dict[str, Any]] = None
    bigwig_settings: Optional[Dict[str, Any]] = None
    vcf_settings: Optional[Dict[str, Any]] = None
    bed_settings: Optional[Dict[str, Any]] = None


@router.get("/api/tracks")
def list_tracks(genome_key: Optional[str] = None):
    """Return all registered tracks, optionally filtered by genome_key.

    On a worker thread: it reads the track registry and its sidecar from disk.
    """
    config = _tracks_config()
    registry = _load_track_registry(config)
    _ensure_track_registry_sidecar(config)
    tracks = [_hydrate_track_genome_label(_hydrate_track_defaults(t), config) for t in registry.get("tracks", [])]
    groups = _hydrate_track_groups(registry)
    if genome_key:
        tracks = [t for t in tracks if t.get("genome_key") == genome_key]
        groups = [g for g in groups if _track_assembly_key(g.get("genome_key")) == _track_assembly_key(genome_key)]
    return {"tracks": tracks, "groups": groups}


@router.post("/api/tracks/trackhub/discover")
async def discover_trackhub_tracks(request: TrackHubDiscoverRequest):
    genomes = []
    for genome in request.genomes:
        genome_key = str(genome.genome_key or "").strip()
        if not genome_key:
            continue
        genomes.append({
            "genome_key": genome_key,
            "species_key": str(genome.species_key or "").strip(),
            "scientific_name": str(genome.scientific_name or "").strip(),
            "common_name": str(genome.common_name or "").strip(),
            "assembly": str(genome.assembly or "").strip(),
            "assembly_name": str(genome.assembly_name or "").strip(),
        })

    # Registry discovery can require many paginated requests on a cache miss.
    # Keep this handler on a worker thread so it cannot block the API event loop.
    grouped = await run_in_threadpool(list_tracks_for_genomes, genomes, bool(request.refresh))
    items = []
    for genome in genomes:
        genome_key = genome["genome_key"]
        payload = grouped.get(genome_key) or {"genome_key": genome_key, "tracks": [], "error": ""}
        tracks = payload.get("tracks") or []
        normalized_tracks = []
        for track in tracks:
            fmt, ttype = _normalize_trackhub_format(track.get("format"), track.get("data_url"))
            if ttype not in {"bigwig", "bigbed"}:
                continue
            meta = _normalize_trackhub_source_meta(track) or {}
            normalized_tracks.append({
                "hub_id": meta.get("hub_id", ""),
                "hub_name": meta.get("hub_name", ""),
                "track_id": meta.get("track_id", ""),
                "track_name": meta.get("track_name", ""),
                "assembly": meta.get("assembly", ""),
                "format": fmt or meta.get("format", ""),
                "type": ttype,
                "data_url": meta.get("data_url", ""),
                "description": meta.get("description", ""),
                "import_key": str(
                    meta.get("import_key")
                    or track.get("import_key")
                    or _compute_trackhub_import_key(
                        meta.get("hub_id"),
                        meta.get("track_id"),
                        meta.get("assembly"),
                        meta.get("data_url"),
                    )
                ),
            })
        normalized_tracks.sort(
            key=lambda t: (
                str(t.get("hub_name") or "").lower(),
                str(t.get("track_name") or "").lower(),
                str(t.get("data_url") or "").lower(),
            )
        )
        items.append({
            "genome_key": genome_key,
            "tracks": normalized_tracks,
            "error": str(payload.get("error") or ""),
        })

    return {
        "genomes": items,
        "fetched_at": now_iso(),
    }


async def _run_trackhub_import_task(task_id: str, output_dir: str, item: TrackHubImportItem):
    try:
        source_meta = _normalize_trackhub_source_meta(item.source_meta) or {}
        data_url = _validate_trackhub_data_url(source_meta.get("data_url") or "")
        source_meta = _normalize_trackhub_source_meta({**source_meta, "data_url": data_url}) or source_meta
        format_name, track_type = _normalize_trackhub_format(source_meta.get("format"), data_url)
        if track_type not in {"bigwig", "bigbed"}:
            raise RuntimeError("Only bigWig and bigBed track hub formats are supported.")

        genome_key = str(item.genome_key or "").strip()
        species_key = str(item.species_key or "").strip()
        assembly = str(item.assembly or "").strip()
        provider = normalize_provider(item.provider)
        if not species_key or not assembly:
            raise RuntimeError("species_key and assembly are required for track hub imports.")

        filename = _trackhub_output_filename(source_meta, data_url, track_type)
        asm_dir = data_paths._resolve_species_assembly_dir(output_dir, species_key, assembly, provider=provider)
        trackhub_dir = asm_dir / "trackhub"
        destination = (trackhub_dir / filename).resolve()
        try:
            destination.relative_to(trackhub_dir.resolve())
        except ValueError:
            raise RuntimeError("Invalid destination path for track hub import.")

        existing_track = None
        with _track_registry_lock:
            existing_track = _find_existing_trackhub_track(genome_key, source_meta, destination)
        if existing_track:
            _set_trackhub_import_task(
                task_id,
                status="completed",
                progress=1.0,
                registered_track=existing_track,
                message="Track already registered.",
            )
            return

        await asyncio.to_thread(_trackhub_download_sync, task_id, data_url, destination)
        _set_trackhub_import_task(task_id, status="registering", progress=1.0)

        label = str(item.label or "").strip() or str(source_meta.get("track_name") or source_meta.get("track_id") or Path(filename).stem)
        display_mode = None
        bigwig_settings = None
        if track_type == "bigwig":
            # Track Hub signal tracks should default to the generic signal profile.
            display_mode = "signal_plot"
            bigwig_settings = {
                "data_type": "custom",
                "use_default_plot_color": True,
                "use_default_zoned_colors": True,
            }
        registered = await register_track(
            TrackRegistryEntry(
                path=str(destination),
                label=label,
                type=track_type,
                display_mode=display_mode,
                genome_key=genome_key,
                bigwig_settings=bigwig_settings,
                source="trackhub",
                source_meta={
                    **source_meta,
                    "format": format_name,
                },
            )
        )
        _set_trackhub_import_task(
            task_id,
            status="completed",
            progress=1.0,
            registered_track=registered,
            message="Track imported.",
        )
    except Exception as exc:
        _set_trackhub_import_task(
            task_id,
            status="failed",
            error=str(exc),
            message="Import failed.",
        )


@router.post("/api/tracks/trackhub/import")
async def import_trackhub_tracks(request: TrackHubImportRequest):
    if not request.output_dir:
        raise HTTPException(status_code=400, detail="output_dir is required")
    if not request.items:
        raise HTTPException(status_code=400, detail="items are required")

    task_ids: List[str] = []
    for item in request.items:
        source_meta = _normalize_trackhub_source_meta(item.source_meta) or {}
        _, track_type = _normalize_trackhub_format(source_meta.get("format"), source_meta.get("data_url"))
        if track_type not in {"bigwig", "bigbed"}:
            raise HTTPException(status_code=400, detail="Only bigWig and bigBed imports are supported")

        task_id = str(uuid.uuid4())
        with _trackhub_import_tasks_guard:
            _trackhub_import_tasks[task_id] = {
                "id": task_id,
                "status": "queued",
                "progress": 0.0,
                "error": "",
                "message": "Queued",
                "genome_key": str(item.genome_key or "").strip(),
                "species_key": str(item.species_key or "").strip(),
                "assembly": str(item.assembly or "").strip(),
                "track_name": str(source_meta.get("track_name") or source_meta.get("track_id") or ""),
                "track_type": track_type,
                "import_key": str(
                    source_meta.get("import_key")
                    or _compute_trackhub_import_key(
                        source_meta.get("hub_id"),
                        source_meta.get("track_id"),
                        source_meta.get("assembly"),
                        source_meta.get("data_url"),
                    )
                ),
                "created_at": now_iso(),
                "updated_at": now_iso(),
                "_updated_ts": time.time(),
            }
        task_ids.append(task_id)
        asyncio.create_task(_run_trackhub_import_task(task_id, str(request.output_dir), item))

    return {"task_ids": task_ids, "status": "started"}


@router.get("/api/tracks/trackhub/import_tasks")
async def list_trackhub_import_tasks():
    return {"tasks": _read_trackhub_import_tasks()}


@router.post("/api/tracks")
async def register_track(entry: TrackRegistryEntry):
    """Register a new custom track. Validates file existence and auto-detects type."""
    path = str(entry.path).strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    # Tutorial files belong only in their workspace's registry. Check the path
    # even if a delayed request arrives after the tutorial session has ended.
    config = _tracks_config()
    if is_inside_tutorial_workspace(path) and not is_inside_tutorial_workspace(
        _primary_track_registry_store_path(config)
    ):
        raise HTTPException(
            status_code=400,
            detail="A tutorial's data track cannot be registered outside its own workspace.",
        )

    # Auto-detect type
    detected_type = entry.type or _detect_track_type(path)

    # For BAM, check if it should be long_reads
    if detected_type == "bam" and _detect_long_read_bam(path):
        detected_type = "long_reads"

    if not detected_type:
        raise HTTPException(
            status_code=422,
            detail="Could not auto-detect track type from file extension. Specify 'type' in the request."
        )

    # ── Auto-index files that need it (uses pysam's bundled htslib — no external tools needed) ──
    index_note = ""

    if detected_type == "vcf":
        tbi = Path(path + ".tbi")
        csi = Path(path + ".csi")
        if not tbi.exists() and not csi.exists():
            try:
                import pysam, asyncio

                # bgzip-compress if not already a .gz file
                if not path.endswith(".gz"):
                    gz_path = path + ".gz"
                    await asyncio.to_thread(
                        pysam.tabix_compress, path, gz_path, force=True
                    )
                    path = gz_path
                    p = Path(path)

                # Build tabix index (.tbi)
                await asyncio.to_thread(
                    pysam.tabix_index, path, preset="vcf", force=True
                )
                index_note = "bgzip + tabix index created automatically."
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Auto-indexing failed: {exc}. Ensure the VCF is valid."
                )

    elif detected_type in ("bam", "long_reads"):
        bai = Path(path + ".bai")
        bai2 = p.with_suffix(".bai")
        if not bai.exists() and not bai2.exists():
            try:
                import pysam, asyncio
                await asyncio.to_thread(pysam.index, path)
                index_note = "BAM index (.bai) created automatically."
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Auto-indexing failed: {exc}. Try running: samtools index {path}"
                )


    splice_settings = None
    bigwig_settings = None
    vcf_settings = None
    bed_settings = None
    display_mode = entry.display_mode

    if detected_type == "bigwig":
        bigwig_settings = _normalize_bigwig_settings(entry.bigwig_settings)
        if display_mode is None:
            display_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[bigwig_settings["data_type"]]["display_mode"])
        else:
            display_mode = _normalize_bigwig_display_mode(display_mode, bigwig_settings["data_type"])
    elif detected_type == "vcf":
        vcf_settings = _normalize_vcf_settings(entry.vcf_settings)
        display_mode = _normalize_vcf_display_mode(display_mode)
    else:
        if not display_mode:
            modes = TRACK_DISPLAY_MODES.get(detected_type, [])
            display_mode = modes[0] if modes else "default"

    if detected_type == "splice_junctions":
        display_mode = "arcs"
        splice_settings = _normalize_splice_settings(entry.splice_settings)
    if detected_type in ("bed", "bigbed", "gff"):
        bed_settings = _normalize_bed_settings(entry.bed_settings)
        allowed_modes = TRACK_DISPLAY_MODES.get(detected_type, [])
        # A GFF/GTF of transcripts opens as gene models unless a mode was asked for.
        if detected_type == "gff" and not entry.display_mode and looks_like_gene_models(p):
            display_mode = "transcripts"
        if allowed_modes and display_mode not in allowed_modes:
            display_mode = allowed_modes[0]

    track_id = f"trk_{uuid.uuid4().hex[:12]}"
    # Suggest label from filename if blank
    label = (entry.label or "").strip() or p.stem.replace("_", " ").replace("-", " ")
    source = str(entry.source or "").strip().lower()
    if source and source != "trackhub":
        source = ""
    source_meta = None
    if source == "trackhub":
        source_meta = _normalize_trackhub_source_meta(entry.source_meta)

    new_track = {
        "id": track_id,
        "path": path,
        "label": label,
        "type": detected_type,
        "display_mode": display_mode,
        "genome_key": entry.genome_key or "",
        "splice_settings": splice_settings,
        "bigwig_settings": bigwig_settings,
        "vcf_settings": vcf_settings,
        "bed_settings": bed_settings,
        "source": source or "",
        "source_meta": source_meta,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "index_note": index_note,
    }

    with _track_registry_lock:
        registry = _load_track_registry(config)
        registry.setdefault("tracks", []).append(new_track)
        _save_track_registry(registry, config)

    return _hydrate_track_defaults(new_track)


def _apply_track_settings_update(track: Dict[str, Any], entry: "TrackRegistryUpdateEntry") -> None:
    """Apply an update's display mode and type settings to a track dict, in place.

    Shared by track edits and by a track group's own settings for a member, so a group
    member's settings are normalised exactly as the track's would be.
    """
    track_type = track.get("type")
    if track_type == "bigwig":
        prev_settings = _normalize_bigwig_settings(track.get("bigwig_settings"))
        prev_data_type = prev_settings["data_type"]
        prev_default_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[prev_data_type]["display_mode"])
        prev_mode = _normalize_bigwig_display_mode(track.get("display_mode"), prev_data_type)

        next_settings = prev_settings
        data_type_changed = False
        if entry.bigwig_settings is not None:
            next_settings = _normalize_bigwig_settings(entry.bigwig_settings, previous=prev_settings)
            track["bigwig_settings"] = next_settings
            data_type_changed = next_settings["data_type"] != prev_data_type
        else:
            track["bigwig_settings"] = prev_settings

        if entry.display_mode is not None:
            track["display_mode"] = _normalize_bigwig_display_mode(entry.display_mode, next_settings["data_type"])
        elif data_type_changed:
            next_default_mode = str(BIGWIG_DATA_TYPE_DEFAULTS[next_settings["data_type"]]["display_mode"])
            track["display_mode"] = next_default_mode if prev_mode == prev_default_mode else prev_mode
        elif not track.get("display_mode"):
            track["display_mode"] = str(BIGWIG_DATA_TYPE_DEFAULTS[next_settings["data_type"]]["display_mode"])
        else:
            track["display_mode"] = _normalize_bigwig_display_mode(track.get("display_mode"), next_settings["data_type"])
    elif track_type == "vcf":
        prev_vcf_settings = _normalize_vcf_settings(track.get("vcf_settings"))
        if entry.vcf_settings is not None:
            track["vcf_settings"] = _normalize_vcf_settings(entry.vcf_settings, previous=prev_vcf_settings)
        else:
            track["vcf_settings"] = prev_vcf_settings

        if entry.display_mode is not None:
            track["display_mode"] = _normalize_vcf_display_mode(entry.display_mode)
        elif not track.get("display_mode"):
            track["display_mode"] = "density_lollipop"
        else:
            track["display_mode"] = _normalize_vcf_display_mode(track.get("display_mode"))
    else:
        if entry.display_mode is not None:
            if track_type == "splice_junctions":
                track["display_mode"] = "arcs"
            else:
                track["display_mode"] = entry.display_mode

    if track_type in ("bed", "bigbed", "gff"):
        prev_bed_settings = _normalize_bed_settings(track.get("bed_settings"))
        track["bed_settings"] = (
            _normalize_bed_settings(entry.bed_settings, previous=prev_bed_settings)
            if entry.bed_settings is not None
            else prev_bed_settings
        )
        allowed_modes = TRACK_DISPLAY_MODES.get(track_type, [])
        if allowed_modes and track.get("display_mode") not in allowed_modes:
            track["display_mode"] = allowed_modes[0]

    if entry.splice_settings is not None:
        if track_type == "splice_junctions":
            track["splice_settings"] = _normalize_splice_settings(entry.splice_settings)
        else:
            track["splice_settings"] = entry.splice_settings
    elif track_type == "splice_junctions" and not isinstance(track.get("splice_settings"), dict):
        track["splice_settings"] = _normalize_splice_settings(None)


@router.put("/api/tracks/{track_id}")
def update_track(track_id: str, entry: TrackRegistryUpdateEntry):
    """Update label, display_mode, or genome_key for an existing track."""
    config = _tracks_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        tracks = registry.get("tracks", [])
        idx = next((i for i, t in enumerate(tracks) if t.get("id") == track_id), None)
        if idx is None:
            raise HTTPException(status_code=404, detail=f"Track not found: {track_id}")
        if entry.label is not None:
            tracks[idx]["label"] = entry.label
        if entry.genome_key is not None:
            tracks[idx]["genome_key"] = entry.genome_key

        _apply_track_settings_update(tracks[idx], entry)
        if entry.genome_key is not None:
            _prune_track_from_other_genome_groups(registry, track_id, tracks[idx].get("genome_key"))

        _save_track_registry(registry, config)
        return _hydrate_track_defaults(tracks[idx])


@router.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    """Remove a track registration (does not delete the file)."""
    config = _tracks_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        tracks = registry.get("tracks", [])
        new_tracks = [t for t in tracks if t.get("id") != track_id]
        if len(new_tracks) == len(tracks):
            raise HTTPException(status_code=404, detail=f"Track not found: {track_id}")
        registry["tracks"] = new_tracks
        # Groups hold tracks by id; a deleted track leaves every group it was in.
        for group in registry.get("groups") or []:
            if isinstance(group, dict) and isinstance(group.get("members"), list):
                group["members"] = [m for m in group["members"] if not (isinstance(m, dict) and m.get("track_id") == track_id)]
        _save_track_registry(registry, config)
    return {"deleted": track_id}


# ── Track groups ──────────────────────────────────────────────────────────────
#
# A named, ordered set of one genome's registered tracks, kept in the track registry
# beside the tracks as ``{"groups": [...]}``. A member's ``settings`` is None to use the
# track's own settings (edits to the track then reach the group), or the group's own copy
# of display_mode and the type's settings, normalised as the track's would be.

TRACK_GROUP_LAYOUTS = ("separate", "joined")


TRACK_GROUP_SETTING_FIELDS = ("display_mode", "bigwig_settings", "vcf_settings", "bed_settings", "splice_settings")


DATASET_SELECTION_SEPARATOR = "::dataset::"


def _track_assembly_key(genome_key: Any) -> str:
    """A genome key without its dataset suffix: the same assembly, however it was chosen."""
    token = str(genome_key or "").strip()
    idx = token.find(DATASET_SELECTION_SEPARATOR)
    return token[:idx] if idx >= 0 else token


class TrackGroupMember(BaseModel):
    track_id: str
    settings: Optional[Dict[str, Any]] = None


class TrackGroupEntry(BaseModel):
    label: str
    genome_key: Optional[str] = None
    layout: Optional[str] = "separate"
    members: List[TrackGroupMember] = []


class TrackGroupUpdateEntry(BaseModel):
    label: Optional[str] = None
    layout: Optional[str] = None
    members: Optional[List[TrackGroupMember]] = None


def _normalize_group_member_settings(track: Dict[str, Any], settings: Any) -> Optional[Dict[str, Any]]:
    """A group's own settings for one member, normalised against that track's type."""
    if not isinstance(settings, dict):
        return None
    candidate = _hydrate_track_defaults(track)
    fields = {k: settings[k] for k in TRACK_GROUP_SETTING_FIELDS if k in settings}
    _apply_track_settings_update(candidate, TrackRegistryUpdateEntry(**fields))
    return {k: candidate[k] for k in TRACK_GROUP_SETTING_FIELDS if k in candidate}


def _normalize_group_members(members: List[Any], tracks_by_id: Dict[str, Dict[str, Any]], assembly: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()
    for member in members:
        raw = member.model_dump() if hasattr(member, "model_dump") else member
        if not isinstance(raw, dict):
            continue
        track_id = str(raw.get("track_id") or "").strip()
        if not track_id or track_id in seen:
            continue
        track = tracks_by_id.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail=f"Track not found: {track_id}")
        if _track_assembly_key(track.get("genome_key")) != assembly:
            raise HTTPException(
                status_code=400,
                detail=f"Track {track.get('label') or track_id} belongs to a different genome; a group holds one genome's tracks.",
            )
        seen.add(track_id)
        out.append({"track_id": track_id, "settings": _normalize_group_member_settings(track, raw.get("settings"))})
    return out


def _normalize_group_label(label: Any) -> str:
    text = " ".join(str(label or "").split())
    if not text:
        raise HTTPException(status_code=400, detail="A group needs a name")
    return text[:120]


def _normalize_group_layout(layout: Any) -> str:
    token = str(layout or "separate").strip().lower()
    return token if token in TRACK_GROUP_LAYOUTS else "separate"


def _hydrate_track_groups(registry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Groups as listed: members whose track is gone are left out, the rest in order."""
    track_ids = {str(t.get("id")) for t in registry.get("tracks", []) if isinstance(t, dict)}
    groups = []
    for group in registry.get("groups") or []:
        if not isinstance(group, dict) or not group.get("id"):
            continue
        members = [
            {"track_id": str(m.get("track_id")), "settings": m.get("settings") if isinstance(m.get("settings"), dict) else None}
            for m in group.get("members") or []
            if isinstance(m, dict) and str(m.get("track_id") or "") in track_ids
        ]
        groups.append({
            "id": group["id"],
            "label": str(group.get("label") or ""),
            "genome_key": str(group.get("genome_key") or ""),
            "layout": _normalize_group_layout(group.get("layout")),
            "members": members,
            "created_at": group.get("created_at"),
            "updated_at": group.get("updated_at"),
        })
    return groups


def _prune_track_from_other_genome_groups(registry: Dict[str, Any], track_id: str, genome_key: Any) -> None:
    """A track moved to another genome leaves the groups of the genome it left."""
    assembly = _track_assembly_key(genome_key)
    for group in registry.get("groups") or []:
        if not isinstance(group, dict) or _track_assembly_key(group.get("genome_key")) == assembly:
            continue
        if isinstance(group.get("members"), list):
            group["members"] = [m for m in group["members"] if not (isinstance(m, dict) and m.get("track_id") == track_id)]


@router.post("/api/track-groups")
def create_track_group(entry: TrackGroupEntry):
    """Create a group from a name and an ordered list of one genome's tracks."""
    config = _tracks_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        tracks_by_id = {str(t.get("id")): t for t in registry.get("tracks", []) if isinstance(t, dict)}
        genome_key = str(entry.genome_key or "").strip()
        if not genome_key and entry.members:
            first = tracks_by_id.get(str(entry.members[0].track_id))
            genome_key = str((first or {}).get("genome_key") or "").strip()
        if not genome_key:
            raise HTTPException(status_code=400, detail="A group belongs to a genome; choose tracks with one set")
        now = routes.notes._utc_now_iso()
        group = {
            "id": f"grp_{uuid.uuid4().hex[:12]}",
            "label": _normalize_group_label(entry.label),
            "genome_key": genome_key,
            "layout": _normalize_group_layout(entry.layout),
            "members": _normalize_group_members(entry.members, tracks_by_id, _track_assembly_key(genome_key)),
            "created_at": now,
            "updated_at": now,
        }
        registry.setdefault("groups", []).append(group)
        _save_track_registry(registry, config)
    return group


@router.put("/api/track-groups/{group_id}")
def update_track_group(group_id: str, entry: TrackGroupUpdateEntry):
    """Rename a group, change its layout, or replace its members (order and settings)."""
    config = _tracks_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        groups = registry.get("groups") or []
        group = next((g for g in groups if isinstance(g, dict) and g.get("id") == group_id), None)
        if group is None:
            raise HTTPException(status_code=404, detail=f"Group not found: {group_id}")
        if entry.label is not None:
            group["label"] = _normalize_group_label(entry.label)
        if entry.layout is not None:
            group["layout"] = _normalize_group_layout(entry.layout)
        if entry.members is not None:
            tracks_by_id = {str(t.get("id")): t for t in registry.get("tracks", []) if isinstance(t, dict)}
            group["members"] = _normalize_group_members(entry.members, tracks_by_id, _track_assembly_key(group.get("genome_key")))
        group["updated_at"] = routes.notes._utc_now_iso()
        _save_track_registry(registry, config)
    return next(g for g in _hydrate_track_groups(registry) if g["id"] == group_id)


@router.delete("/api/track-groups/{group_id}")
def delete_track_group(group_id: str):
    """Remove a group. Its tracks stay registered."""
    config = _tracks_config()
    with _track_registry_lock:
        registry = _load_track_registry(config)
        groups = registry.get("groups") or []
        remaining = [g for g in groups if not (isinstance(g, dict) and g.get("id") == group_id)]
        if len(remaining) == len(groups):
            raise HTTPException(status_code=404, detail=f"Group not found: {group_id}")
        registry["groups"] = remaining
        _save_track_registry(registry, config)
    return {"deleted": group_id}


# ── Browser session tracks ────────────────────────────────────────────────────
#
# Which custom tracks and track groups each genome had open in the Genome Browser, so the
# next session opens with them. Kept beside the track registry the ids refer to, so a
# tutorial's workspace has its own and never touches the user's. Keyed by assembly; each
# genome's entries are its custom rows top to bottom:
#   {"type": "track", "track_id", "visible"}            a track on its own
#   {"type": "group_track", "group_id", "track_id", "visible"}  one of a group's tracks
#   {"type": "group", "group_id", "visible"}            a group shown joined, as one row

BROWSER_SESSION_TRACKS_FILENAME = "browser_session_tracks.json"


BROWSER_SESSION_ENTRY_TYPES = ("track", "group_track", "group")


BROWSER_SESSION_MAX_ENTRIES = 400


_browser_session_lock = threading.Lock()


class BrowserSessionTracksEntry(BaseModel):
    genome_key: str
    # Anything; entries that do not make sense are dropped one by one, not the request.
    entries: List[Any] = []


def _browser_session_tracks_path(config: Optional[Dict[str, Any]] = None) -> Path:
    return _primary_track_registry_store_path(config or _tracks_config()).with_name(BROWSER_SESSION_TRACKS_FILENAME)


def _normalize_browser_session_entry(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type") or "").strip()
    if kind not in BROWSER_SESSION_ENTRY_TYPES:
        return None
    out: Dict[str, Any] = {"type": kind, "visible": raw.get("visible") is not False}
    if kind in ("track", "group_track"):
        track_id = str(raw.get("track_id") or "").strip()
        if not track_id:
            return None
        out["track_id"] = track_id
    if kind in ("group", "group_track"):
        group_id = str(raw.get("group_id") or "").strip()
        if not group_id:
            return None
        out["group_id"] = group_id
    return out


def _load_browser_session_tracks(path: Path) -> Dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        genomes = data.get("genomes") if isinstance(data, dict) else None
        return {"genomes": genomes if isinstance(genomes, dict) else {}}
    except Exception:
        return {"genomes": {}}


@router.get("/api/browser/session-tracks")
def get_browser_session_tracks():
    """The custom tracks and groups each genome had open in the Genome Browser."""
    return _load_browser_session_tracks(_browser_session_tracks_path())


@router.put("/api/browser/session-tracks")
def put_browser_session_tracks(entry: BrowserSessionTracksEntry):
    """Replace one genome's open tracks. No entries forgets the genome."""
    genome = _track_assembly_key(entry.genome_key)
    if not genome:
        raise HTTPException(status_code=400, detail="genome_key is required")
    entries = [e for e in (_normalize_browser_session_entry(raw) for raw in entry.entries) if e]
    path = _browser_session_tracks_path()
    with _browser_session_lock:
        state = _load_browser_session_tracks(path)
        if entries:
            state["genomes"][genome] = {"entries": entries[:BROWSER_SESSION_MAX_ENTRIES], "updated_at": routes.notes._utc_now_iso()}
        else:
            state["genomes"].pop(genome, None)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            os.replace(tmp_path, path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    return {"genome_key": genome, "entries": state["genomes"].get(genome, {}).get("entries", [])}


@router.delete("/api/browser/session-tracks")
def clear_browser_session_tracks():
    """Forget every genome's open tracks: remembering them was switched off."""
    path = _browser_session_tracks_path()
    with _browser_session_lock:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return {"cleared": True}


@router.get("/api/tracks/type_info")
async def track_type_info():
    """Return the supported track types, their extension hints, and display modes."""
    return {
        "extension_map": TRACK_EXTENSION_MAP,
        "display_modes": TRACK_DISPLAY_MODES,
    }
