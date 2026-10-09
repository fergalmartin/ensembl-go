"""Structural-variation datasets: the built-in SV datasets and the user's registered
alignments and attached SV config files, resolved against local genomes (with
signature-checked caches); reading bigChain alignments and sequence mappings, and
building the alignment segments, feature blocks and gap-derived variants the SV view
draws.
"""

import csv
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from fastapi import HTTPException
from pydantic import BaseModel

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

import app_state
import config_store
import data_paths
import file_io
import genome_context
import local_inventory
from genome_identity import (
    DEFAULT_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    iter_local_assembly_dirs,
    legacy_genome_key,
    normalize_provider,
)
from sv_config import (
    config_to_datasets as sv_config_to_datasets,
    derive_sequence_map as sv_derive_sequence_map,
    locate_pointer_lines as sv_locate_pointer_lines,
    parse_sv_config,
)


# Local fixtures used while developing the structural-variation view. Distributions leave
# ENSEMBL_GO_SV_TEST_DATA_DIR unset, in which case the built-in datasets below are not
# offered at all; real datasets are registered through the SV view instead (see
# docs/STRUCTURAL_VARIATION.md). Point the variable at a directory of .bigChain.bb and
# mapping TSVs to re-enable them.
_SV_TEST_DATA_DIR_SETTING = os.environ.get("ENSEMBL_GO_SV_TEST_DATA_DIR", "").strip()


SV_BUILTIN_DATASETS_ENABLED = bool(_SV_TEST_DATA_DIR_SETTING)


SV_TEST_DATA_DIR = (
    Path(_SV_TEST_DATA_DIR_SETTING).expanduser()
    if _SV_TEST_DATA_DIR_SETTING
    else Path("sv_view_data")
)


SV_ALIGNMENT_REGISTRY_FILENAME = "sv_alignment_registry.json"


SV_ALIGNMENT_SCAN_DIRNAME = "sv_alignments"


SV_DATASETS = {
    "grch38_hg00438": {
        "id": "builtin_grch38_hg00438",
        "source": "builtin",
        "label": "GRCh38 vs HG00438",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_000001405.29",
            "assembly_name": "GRCh38.p14",
            "aliases": [
                "GRCh38",
                "GRCh38.p14",
                "GCA_000001405.29",
                "GCF_000001405.40",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018472595.2",
            "assembly_name": "HG00438_pat_hprc_f2",
            "aliases": [
                "HG00438",
                "HG00438_pat_hprc_f2",
                "GCA_018472595.2",
            ],
        },
        "ref_aliases": [
            "grch38",
            "grch38p14",
            "grch38.p14",
            "gca00000140529",
            "gcf00000140540",
        ],
        "tgt_aliases": [
            "hg00438",
            "hg00438pat_hprcf2",
            "hg00438_pat_hprc_f2",
            "gca0184725952",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "GRCh38.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00438.1.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "alt_179f190d-17f9-4692-9353-374976c62e20_to_ref_fd7fea38-981a-4d73-a879-6f9daef86f08.20251215.bigChain.bb",
        "target_bigwig_path": SV_TEST_DATA_DIR / "HG00438_pat_hprc_f2.bw",
        "target_bigbed_path": SV_TEST_DATA_DIR / "HG00438_pat_hprc_f2.bb",
        "indexed_side": "target",
    },
    "grch38_hg00733": {
        "id": "builtin_grch38_hg00733",
        "source": "builtin",
        "label": "GRCh38 vs HG00733",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_000001405.29",
            "assembly_name": "GRCh38.p14",
            "aliases": [
                "GRCh38",
                "GRCh38.p14",
                "GCA_000001405.29",
                "GCF_000001405.40",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018506975.2",
            "assembly_name": "HG00733_mat_hprc_f2",
            "aliases": [
                "HG00733.2",
                "HG00733_mat",
                "HG00733_mat_hprc_f2",
                "GCA_018506975.2",
                "GCA_018506975.3",
                "0fb76cdf-6c6b-4c20-beef-7f7d4151651b",
            ],
        },
        "ref_aliases": [
            "grch38",
            "grch38p14",
            "grch38.p14",
            "gca00000140529",
            "gcf00000140540",
        ],
        "tgt_aliases": [
            "hg00733.2",
            "hg00733_mat",
            "hg00733_mat_hprc_f2",
            "hg00733mathprcf2",
            "gca0185069752",
            "gca0185069753",
            "0fb76cdf6c6b4c20beef7f7d4151651b",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "GRCh38.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00733.2.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "alt_0fb76cdf-6c6b-4c20-beef-7f7d4151651b_to_ref_fd7fea38-981a-4d73-a879-6f9daef86f08.20251215.bigChain.bb",
        "target_bigwig_path": SV_TEST_DATA_DIR / "HG00733_mat_hprc_f2.bw",
        "target_bigbed_path": SV_TEST_DATA_DIR / "HG00733_mat_hprc_f2.bb",
        "indexed_side": "target",
    },
    "chm13_hg00438": {
        "id": "builtin_chm13_hg00438",
        "source": "builtin",
        "label": "T2T-CHM13v2.0 vs HG00438",
        "reference_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_009914755.4",
            "assembly_name": "T2T-CHM13v2.0",
            "aliases": [
                "CHM13",
                "T2T-CHM13v2.0",
                "GCA_009914755.4",
                "GCF_009914755.1",
            ],
        },
        "target_genome": {
            "provider": DEFAULT_PROVIDER,
            "species_key": "homo_sapiens",
            "assembly": "GCA_018472595.2",
            "assembly_name": "HG00438_pat_hprc_f2",
            "aliases": [
                "HG00438",
                "HG00438_pat_hprc_f2",
                "GCA_018472595.2",
            ],
        },
        "ref_aliases": [
            "chm13",
            "t2tchm13",
            "t2tchm13v2",
            "t2tchm13v20",
            "t2t-chm13v2.0",
            "gca0099147554",
            "gcf0099147551",
        ],
        "tgt_aliases": [
            "hg00438",
            "hg00438pat_hprcf2",
            "hg00438_pat_hprc_f2",
            "gca0184725952",
        ],
        "ref_mapping_path": SV_TEST_DATA_DIR / "CHM13.hal_mapping.tsv",
        "tgt_mapping_path": SV_TEST_DATA_DIR / "HG00438.1.hal_mapping.tsv",
        "chain_path": SV_TEST_DATA_DIR / "ref_fc20ebd6-f756-45da-b941-b3b17e11515f_to_alt_179f190d-17f9-4692-9353-374976c62e20.20251216.bigChain.bb",
        "indexed_side": "reference",
    },
}


_sv_mapping_cache: Dict[str, Dict[str, Any]] = {}


_sv_bigchain_chrom_cache: Dict[str, Dict[str, Any]] = {}


_sv_registry_cache: Dict[str, Any] = {
    "signature": None,
    "datasets": None,
    "incomplete": None,
    "configs": None,
}


# Registration used to write the registry with no lock at all, so two saves
# arriving together could each read the same file and one lose its entry.
_sv_config_write_lock = threading.Lock()


def _normalize_dataset_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())


def _sv_unique_strings(values: Iterable[Any]) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _sv_registry_store_path(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_REGISTRY_FILENAME
    except Exception:
        return None


def _sv_alignment_scan_dir(output_dir: Any) -> Optional[Path]:
    output_dir_text = str(output_dir or "").strip()
    if not output_dir_text:
        return None
    try:
        return data_paths._resolve_local_data_root(output_dir_text) / SV_ALIGNMENT_SCAN_DIRNAME
    except Exception:
        return None


def _sv_attached_config_paths(config: Optional[Dict[str, Any]] = None) -> List[Path]:
    """Config files the user has attached, in the order they were attached."""
    state = config if isinstance(config, dict) else config_store.load_config()
    out: List[Path] = []
    seen: Set[str] = set()
    for raw in state.get("sv_config_paths") or []:
        text = str(raw or "").strip()
        if not text:
            continue
        try:
            path = Path(text).expanduser()
        except Exception:
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


# Sequence names per FASTA, keyed by path and invalidated on (mtime, size) of the
# index rather than the FASTA itself: the .fai is what actually carries the names,
# and it is rewritten whenever they change.
_sv_assembly_sequence_cache: Dict[str, Dict[str, Any]] = {}


# Derived sequence maps, keyed by (alignment id, side). Rebuilt when either the
# chain or the assembly index changes underneath.
_sv_derived_mapping_cache: Dict[Tuple[str, str], Dict[str, Any]] = {}


def _sv_fasta_signature(fasta_path: Path) -> Tuple[int, int]:
    for candidate in (Path(f"{fasta_path}.fai"), fasta_path):
        try:
            stat = candidate.stat()
            return int(stat.st_mtime_ns), int(stat.st_size)
        except Exception:
            continue
    return (0, 0)


def _sv_assembly_sequence_names(fasta_path: Any) -> List[str]:
    """Sequence names of a local assembly, read from its FASTA index.

    This is what replaced the mapping TSVs: the assembly already states its own
    sequence names, so asking the user to restate them in a side file was never
    buying anything the app could not work out.
    """
    text = str(fasta_path or "").strip()
    if not text:
        return []
    path = Path(text).expanduser()
    signature = _sv_fasta_signature(path)
    cached = _sv_assembly_sequence_cache.get(str(path))
    if cached and cached.get("signature") == signature:
        return list(cached.get("names") or [])

    names: List[str] = []
    if path.exists() and path.is_file():
        try:
            handle = file_io.open_indexed_fasta(str(path))
            names = [str(name).strip() for name in (handle.references or []) if str(name).strip()]
        except Exception:
            names = []
    _sv_assembly_sequence_cache[str(path)] = {"signature": signature, "names": list(names)}
    return names


def _sv_local_fasta_for_genome(genome: Dict[str, Any], local_assemblies: List[Dict[str, Any]]) -> str:
    match = _sv_local_species_match(genome, local_assemblies)
    if not isinstance(match, dict):
        return ""
    return str((match.get("files") or {}).get("fasta") or "")


def _sv_side_mapping(dataset: Dict[str, Any], side: str) -> Dict[str, Any]:
    """Sequence-name map for one side of an alignment.

    Two sources, in order. A mapping TSV if the record still names one -- old
    registry entries and sidecar manifests do, and they must keep working. Otherwise
    the names are derived from the BigChain's own chromosome list and the local
    assembly's FASTA index, which is what a config written in the current format
    relies on.
    """
    normalized = "reference" if str(side or "").strip().lower().startswith("ref") else "target"
    mapping_key = "ref_mapping_path" if normalized == "reference" else "tgt_mapping_path"
    mapping_path = _sv_path_text(dataset.get(mapping_key))
    if mapping_path:
        candidate = Path(mapping_path).expanduser()
        if candidate.exists() and candidate.is_file():
            return _load_sv_mapping(candidate)

    cache_key = (str(dataset.get("id") or ""), normalized)
    chain_path = Path(_sv_path_text(dataset.get("chain_path"))).expanduser()
    fasta_path = _sv_path_text(dataset.get(f"{normalized}_fasta_path"))
    signature = (_sv_fasta_signature(chain_path), _sv_fasta_signature(Path(fasta_path)) if fasta_path else (0, 0))
    cached = _sv_derived_mapping_cache.get(cache_key)
    if cached and cached.get("signature") == signature:
        return cached["mapping"]

    alias_key = "reference_sequence_aliases" if normalized == "reference" else "target_sequence_aliases"
    mapping = sv_derive_sequence_map(
        _load_sv_bigchain_chrom_sizes(chain_path).keys(),
        _sv_assembly_sequence_names(fasta_path),
        explicit_aliases=dataset.get(alias_key) or {},
    )
    _sv_derived_mapping_cache[cache_key] = {"signature": signature, "mapping": mapping}
    return mapping


def _sv_genome_key_from_record(record: Dict[str, Any]) -> str:
    key = str(record.get("genome_key") or record.get("key") or "").strip()
    if key:
        return key
    return build_provider_aware_genome_key(
        record.get("species_key"),
        record.get("assembly") or record.get("gca") or record.get("accession") or record.get("assembly_name"),
        record.get("provider") or DEFAULT_PROVIDER,
        is_manual=bool(record.get("is_manual")),
    ) or legacy_genome_key(
        record.get("species_key"),
        record.get("assembly") or record.get("gca") or record.get("accession") or record.get("assembly_name"),
    )


def _sv_genome_aliases(record: Optional[Dict[str, Any]], extra_aliases: Optional[Iterable[Any]] = None) -> List[str]:
    raw = record or {}
    values: List[Any] = [
        raw.get("genome_key"),
        raw.get("key"),
        _sv_genome_key_from_record(raw),
        raw.get("assembly"),
        raw.get("gca"),
        raw.get("accession"),
        raw.get("assembly_name"),
        raw.get("name"),
    ]
    weak_tokens = {
        token
        for token in (
            _normalize_dataset_token(raw.get("provider")),
            _normalize_dataset_token(raw.get("species_key")),
            _normalize_dataset_token(raw.get("display_name")),
            _normalize_dataset_token(raw.get("common_name")),
            _normalize_dataset_token(raw.get("scientific_name")),
        )
        if token
    }
    identity_aliases = list(raw.get("aliases") or []) + list(raw.get("equivalent_accessions") or [])
    if extra_aliases:
        identity_aliases.extend(extra_aliases)
    values.extend(
        value
        for value in identity_aliases
        if _normalize_dataset_token(value) not in weak_tokens
    )
    return _sv_unique_strings(values)


def _normalize_sv_genome_record(raw: Any, aliases: Optional[Iterable[Any]] = None) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    assembly = str(source.get("assembly") or source.get("gca") or source.get("accession") or "").strip()
    provider = normalize_provider(source.get("provider") or DEFAULT_PROVIDER, is_manual=bool(source.get("is_manual")))
    out = {
        "provider": provider,
        "species_key": str(source.get("species_key") or "").strip(),
        "assembly": assembly,
        "gca": str(source.get("gca") or (assembly if assembly.upper().startswith("GC") else "")).strip(),
        "accession": str(source.get("accession") or assembly).strip(),
        "assembly_name": str(source.get("assembly_name") or source.get("name") or assembly).strip(),
        "scientific_name": str(source.get("scientific_name") or "").strip(),
        "common_name": str(source.get("common_name") or "").strip(),
        "display_name": str(source.get("display_name") or "").strip(),
        "is_manual": bool(source.get("is_manual")),
    }
    genome_key = _sv_genome_key_from_record({**source, **out})
    if genome_key:
        out["genome_key"] = genome_key
    out["aliases"] = _sv_genome_aliases({**source, **out}, aliases)
    return out


def _sv_path_text(value: Any) -> str:
    """Path-or-string to text, treating an unset path as unset.

    ``_normalize_sv_dataset`` stores absent paths as ``Path("")``, which stringifies
    to ``"."`` -- a real, existing directory. Anything testing "is this path set?"
    on the raw value therefore sees a path that is present but not a file.
    """
    text = str(value or "").strip()
    return "" if text in {"", "."} else text


def _sv_dataset_file_status(dataset: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Which of an alignment's files are actually on disk.

    The chain is the only hard requirement. Mapping TSVs are checked only when a
    record still names them -- a config in the current format derives those names
    from the assembly instead, and treating an absent TSV as a missing file there
    would report every such alignment as broken.
    """
    missing: List[str] = []

    chain = _sv_path_text(dataset.get("chain_path"))
    if not chain:
        missing.append("")
    else:
        try:
            path = Path(chain).expanduser()
        except Exception:
            missing.append(chain)
        else:
            if not path.exists() or not path.is_file():
                missing.append(str(path))

    for raw in (dataset.get("ref_mapping_path"), dataset.get("tgt_mapping_path")):
        text = _sv_path_text(raw)
        if not text:
            continue
        try:
            path = Path(text).expanduser()
        except Exception:
            missing.append(text)
            continue
        if not path.exists() or not path.is_file():
            missing.append(str(path))

    return len(missing) == 0, missing


def _sv_track_type_from_path(path: str) -> str:
    lower = str(path or "").strip().lower()
    if lower.endswith(".bw") or lower.endswith(".bigwig"):
        return "bigwig"
    if lower.endswith(".bb") or lower.endswith(".bigbed"):
        return "bigbed"
    return ""


def _normalize_sv_data_tracks(raw: Dict[str, Any], base_dir: Optional[Path] = None) -> Dict[str, List[Dict[str, Any]]]:
    def _path(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        path = Path(text).expanduser()
        if not path.is_absolute() and base_dir:
            path = base_dir / path
        return str(path)

    def _append(out: Dict[str, List[Dict[str, Any]]], side: str, value: Any, track_type: str = "", label: str = ""):
        path = _path(value)
        if not path:
            return
        resolved_type = track_type or _sv_track_type_from_path(path)
        if resolved_type not in {"bigwig", "bigbed"}:
            return
        normalized_side = "reference" if str(side or "").strip().lower() in {"ref", "reference", "primary"} else "target"
        track_label = str(label or "").strip()
        if not track_label:
            track_label = "Signal" if resolved_type == "bigwig" else "SV intervals"
        out[normalized_side].append({
            "id": hashlib.sha1(f"{normalized_side}|{resolved_type}|{path}".encode("utf-8")).hexdigest()[:16],
            "side": normalized_side,
            "type": resolved_type,
            "label": track_label,
            "path": path,
            "display_mode": "flatten",
        })

    out: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    _append(out, "reference", raw.get("reference_bigwig_path") or raw.get("ref_bigwig_path") or raw.get("reference_bw_path") or raw.get("ref_bw_path"), "bigwig", raw.get("reference_bigwig_label") or raw.get("ref_bigwig_label"))
    _append(out, "reference", raw.get("reference_bigbed_path") or raw.get("ref_bigbed_path") or raw.get("reference_bb_path") or raw.get("ref_bb_path"), "bigbed", raw.get("reference_bigbed_label") or raw.get("ref_bigbed_label"))
    _append(out, "target", raw.get("target_bigwig_path") or raw.get("tgt_bigwig_path") or raw.get("target_bw_path") or raw.get("tgt_bw_path"), "bigwig", raw.get("target_bigwig_label") or raw.get("tgt_bigwig_label"))
    _append(out, "target", raw.get("target_bigbed_path") or raw.get("tgt_bigbed_path") or raw.get("target_bb_path") or raw.get("tgt_bb_path"), "bigbed", raw.get("target_bigbed_label") or raw.get("tgt_bigbed_label"))

    for side_key, side in (("reference_tracks", "reference"), ("ref_tracks", "reference"), ("target_tracks", "target"), ("tgt_tracks", "target")):
        for item in raw.get(side_key) or []:
            if not isinstance(item, dict):
                continue
            _append(
                out,
                side,
                item.get("path") or item.get("url") or item.get("data_url"),
                str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
                item.get("label") or item.get("name") or item.get("track_name") or "",
            )

    grouped_tracks = raw.get("tracks")
    if isinstance(grouped_tracks, dict):
        for grouped_side in ("reference", "target"):
            for item in grouped_tracks.get(grouped_side) or []:
                if not isinstance(item, dict):
                    continue
                _append(
                    out,
                    grouped_side,
                    item.get("path") or item.get("url") or item.get("data_url"),
                    str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
                    item.get("label") or item.get("name") or item.get("track_name") or "",
                )

    flat_tracks = raw.get("data_tracks") or (grouped_tracks if isinstance(grouped_tracks, list) else [])
    for item in flat_tracks or []:
        if not isinstance(item, dict):
            continue
        _append(
            out,
            item.get("side") or item.get("genome") or "target",
            item.get("path") or item.get("url") or item.get("data_url"),
            str(item.get("type") or item.get("format") or "").strip().lower().replace("bigwig", "bigwig").replace("bigbed", "bigbed"),
            item.get("label") or item.get("name") or item.get("track_name") or "",
        )

    deduped: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    for side, tracks in out.items():
        seen: Set[Tuple[str, str]] = set()
        for track in tracks:
            key = (str(track.get("type") or ""), str(track.get("path") or ""))
            if key in seen:
                continue
            seen.add(key)
            deduped[side].append(track)
    return deduped


def _normalize_sv_dataset(raw: Dict[str, Any], source: str = "registered", base_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    def _path(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        path = Path(text).expanduser()
        if not path.is_absolute() and base_dir:
            path = base_dir / path
        return str(path)

    ref_aliases = raw.get("ref_aliases") or raw.get("reference_aliases") or []
    tgt_aliases = raw.get("tgt_aliases") or raw.get("target_aliases") or []
    reference_genome = _normalize_sv_genome_record(
        raw.get("reference_genome") or raw.get("reference") or {},
        ref_aliases,
    )
    target_genome = _normalize_sv_genome_record(
        raw.get("target_genome") or raw.get("target") or raw.get("alt_genome") or {},
        tgt_aliases,
    )

    chain_path = _path(raw.get("chain_path") or raw.get("bigchain_path") or raw.get("bigchain"))
    ref_mapping_path = _path(raw.get("ref_mapping_path") or raw.get("reference_mapping_path") or raw.get("reference_map"))
    tgt_mapping_path = _path(raw.get("tgt_mapping_path") or raw.get("target_mapping_path") or raw.get("target_map"))
    alignment_id = str(raw.get("id") or raw.get("alignment_id") or "").strip()
    if not alignment_id:
        seed = "|".join([chain_path, ref_mapping_path, tgt_mapping_path, source])
        alignment_id = f"sv_{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:16]}"

    indexed_side = str(raw.get("indexed_side") or "target").strip().lower()
    if indexed_side not in {"reference", "target"}:
        indexed_side = "target"

    dataset = {
        **raw,
        "id": alignment_id,
        "alignment_id": alignment_id,
        "source": str(raw.get("source") or source),
        "label": str(raw.get("label") or raw.get("name") or alignment_id).strip() or alignment_id,
        "reference_genome": reference_genome,
        "target_genome": target_genome,
        "ref_aliases": _sv_genome_aliases(reference_genome, ref_aliases),
        "tgt_aliases": _sv_genome_aliases(target_genome, tgt_aliases),
        "chain_path": Path(chain_path) if chain_path else Path(""),
        "ref_mapping_path": Path(ref_mapping_path) if ref_mapping_path else Path(""),
        "tgt_mapping_path": Path(tgt_mapping_path) if tgt_mapping_path else Path(""),
        "indexed_side": indexed_side,
        "tracks": _normalize_sv_data_tracks(raw, base_dir=base_dir),
    }
    supported, missing = _sv_dataset_file_status(dataset)
    dataset["supported"] = supported
    dataset["missing_files"] = missing
    return dataset


def _load_sv_config_file(path: Optional[Path], source: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Read one config file into datasets, plus any diagnostics worth surfacing.

    Legacy registry payloads are recognised and migrated by ``parse_sv_config``, so
    a registry written before this format existed loads through exactly this path.
    """
    if not path or not path.exists():
        return [], []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return [], [diagnostic_for_config(path, f"Could not read the file: {exc}")]

    config, diagnostics = parse_sv_config(text, base_dir=path.parent)
    diagnostics = sv_locate_pointer_lines(text, diagnostics)
    datasets: List[Dict[str, Any]] = []
    for raw in sv_config_to_datasets(config, source=source, config_path=str(path)):
        dataset = _normalize_sv_dataset(raw, source=source, base_dir=path.parent)
        if dataset:
            datasets.append(dataset)
    return datasets, diagnostics


def diagnostic_for_config(path: Path, message: str) -> Dict[str, Any]:
    return {"severity": "error", "pointer": "", "line": 0, "message": message, "path": str(path)}


def _load_sv_alignment_registry_from_path(path: Optional[Path]) -> List[Dict[str, Any]]:
    datasets, _diagnostics = _load_sv_config_file(path, source="registered")
    return datasets


def _load_sv_mapping_info(mapping_path: Path) -> Optional[Dict[str, Any]]:
    try:
        mapping = _load_sv_mapping(mapping_path)
    except Exception:
        return None
    return {
        "path": mapping_path,
        "genome_name": str(mapping.get("genome_name") or mapping_path.stem).strip(),
        "assembly_uuid": str(mapping.get("assembly_uuid") or "").strip(),
    }


def _guess_sv_indexed_side_from_filename(bigchain_path: Path) -> Optional[str]:
    name = bigchain_path.name.lower()
    if name.startswith("alt_") and "_to_ref_" in name:
        return "target"
    if name.startswith("ref_") and "_to_alt_" in name:
        return "reference"
    return None


def _auto_pick_sv_maps_from_filename(
    bigchain_path: Path,
    mapping_infos: List[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    by_uuid = {
        str(info.get("assembly_uuid") or "").lower(): info
        for info in mapping_infos
        if str(info.get("assembly_uuid") or "").strip()
    }
    name = bigchain_path.name.lower()
    match = re.search(r"alt_([0-9a-f-]+)_to_ref_([0-9a-f-]+)", name)
    if match:
        target_uuid = match.group(1).lower()
        reference_uuid = match.group(2).lower()
        return by_uuid.get(reference_uuid), by_uuid.get(target_uuid)
    match = re.search(r"ref_([0-9a-f-]+)_to_alt_([0-9a-f-]+)", name)
    if match:
        reference_uuid = match.group(1).lower()
        target_uuid = match.group(2).lower()
        return by_uuid.get(reference_uuid), by_uuid.get(target_uuid)
    return None, None


def _manifest_candidates_for_bigchain(bigchain_path: Path) -> List[Path]:
    return [
        bigchain_path.with_suffix(bigchain_path.suffix + ".json"),
        bigchain_path.with_suffix(".json"),
        bigchain_path.parent / f"{bigchain_path.stem}.sv_alignment.json",
        bigchain_path.parent / "sv_alignment.json",
    ]


def _scan_sv_alignment_dir(scan_dir: Optional[Path]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not scan_dir or not scan_dir.exists() or not scan_dir.is_dir():
        return [], []
    datasets: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()

    for bigchain_path in sorted(scan_dir.rglob("*.bigChain.bb")):
        manifest_payload: Optional[Dict[str, Any]] = None
        for manifest_path in _manifest_candidates_for_bigchain(bigchain_path):
            if not manifest_path.exists():
                continue
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception as exc:
                incomplete.append({
                    "path": str(bigchain_path),
                    "reason": f"Failed to parse manifest {manifest_path.name}: {exc}",
                })
                continue
            if isinstance(payload, dict):
                manifest_payload = payload
                break

        if manifest_payload:
            raw = {**manifest_payload, "chain_path": manifest_payload.get("chain_path") or str(bigchain_path)}
            dataset = _normalize_sv_dataset(raw, source="scanned", base_dir=bigchain_path.parent)
            if dataset and dataset["id"] not in seen_ids:
                seen_ids.add(dataset["id"])
                datasets.append(dataset)
            continue

        mapping_infos = [
            info for info in (
                _load_sv_mapping_info(path)
                for path in sorted(bigchain_path.parent.glob("*.hal_mapping.tsv"))
            )
            if info
        ]
        ref_map, tgt_map = _auto_pick_sv_maps_from_filename(bigchain_path, mapping_infos)
        indexed_side = _guess_sv_indexed_side_from_filename(bigchain_path) or "target"
        if not ref_map or not tgt_map:
            incomplete.append({
                "path": str(bigchain_path),
                "reason": "Could not infer reference/target mapping TSVs. Add an sv_alignment.json manifest or register this alignment in the SV view.",
            })
            continue

        raw = {
            "id": f"scan_{hashlib.sha1(str(bigchain_path).encode('utf-8')).hexdigest()[:16]}",
            "label": bigchain_path.stem,
            "chain_path": str(bigchain_path),
            "ref_mapping_path": str(ref_map["path"]),
            "tgt_mapping_path": str(tgt_map["path"]),
            "indexed_side": indexed_side,
            "reference_genome": {
                "assembly_name": ref_map.get("genome_name") or "",
                "aliases": [ref_map.get("genome_name") or "", ref_map.get("assembly_uuid") or ""],
            },
            "target_genome": {
                "assembly_name": tgt_map.get("genome_name") or "",
                "aliases": [tgt_map.get("genome_name") or "", tgt_map.get("assembly_uuid") or ""],
            },
        }
        dataset = _normalize_sv_dataset(raw, source="scanned", base_dir=bigchain_path.parent)
        if dataset and dataset["id"] not in seen_ids:
            seen_ids.add(dataset["id"])
            datasets.append(dataset)

    return datasets, incomplete


def _sv_stat_signature(path: Optional[Path]) -> Tuple[str, int, int]:
    if not path:
        return "", 0, 0
    try:
        stat = path.stat()
        return str(path), int(stat.st_mtime_ns), int(stat.st_size)
    except Exception:
        return str(path), 0, 0


def _sv_local_assembly_signature(output_dir: Any) -> Tuple[Any, ...]:
    """Cheap fingerprint of the local genomes, so a new download is picked up.

    Only the ``assembly`` subdirectory is stat'ed: that is where the FASTA and its
    index land, and it is the only thing the sequence-name derivation reads.
    """
    try:
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None
    except Exception:
        return ()
    if not local_root or not local_root.is_dir():
        return ()
    out: List[Tuple[str, int, int]] = []
    try:
        for _provider, _species_key, _assembly, asm_dir in iter_local_assembly_dirs(local_root):
            out.append(_sv_stat_signature(asm_dir / "assembly"))
    except Exception:
        return ()
    return tuple(out)


_sv_local_assembly_index_cache: Dict[str, Any] = {"signature": None, "entries": []}


def _sv_local_assembly_index(output_dir: Any) -> List[Dict[str, Any]]:
    """Local genomes reduced to what SV needs: identity plus a FASTA path.

    ``list_local_assemblies`` produces a far richer record, but it is an async route
    handler and this runs from synchronous dataset assembly. Matching only needs the
    accession and its aliases, so the cheaper scan here is sufficient.
    """
    signature = _sv_local_assembly_signature(output_dir)
    if _sv_local_assembly_index_cache.get("signature") == signature:
        return list(_sv_local_assembly_index_cache.get("entries") or [])

    entries: List[Dict[str, Any]] = []
    try:
        local_root = data_paths._resolve_local_data_root(output_dir) if output_dir else None
    except Exception:
        local_root = None
    if local_root and local_root.is_dir():
        for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
            try:
                manifest = local_inventory._load_genome_manifest(asm_dir, assembly)
                scanned = local_inventory._scan_local_assembly(asm_dir, assembly, manifest)
            except Exception:
                continue
            fasta_path = str((scanned.get("files") or {}).get("fasta") or "")
            if not fasta_path:
                continue
            entries.append({
                "provider": provider,
                "species_key": species_key,
                "assembly": assembly,
                "accession": assembly,
                "gca": assembly if str(assembly).upper().startswith("GC") else "",
                "assembly_name": str(manifest.get("assembly_name") or assembly),
                "scientific_name": str(manifest.get("scientific_name") or ""),
                "common_name": str(manifest.get("common_name") or ""),
                "display_name": str(manifest.get("display_name") or ""),
                "equivalent_accessions": list(manifest.get("equivalent_accessions") or []),
                "files": {"fasta": fasta_path},
            })

    _sv_local_assembly_index_cache["signature"] = signature
    _sv_local_assembly_index_cache["entries"] = list(entries)
    return entries


def _sv_attach_assembly_paths(dataset: Dict[str, Any], assembly_index: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Resolve each side's FASTA once, here, rather than per request.

    ``/api/sv/view`` runs on every pan and zoom; walking the local data directory
    there would be a directory scan per frame. Doing it while datasets are being
    assembled puts it behind the same cache that guards the rest of this work.
    """
    for side, key in (("reference", "reference_genome"), ("target", "target_genome")):
        if dataset.get(f"{side}_fasta_path"):
            continue
        dataset[f"{side}_fasta_path"] = _sv_local_fasta_for_genome(dataset.get(key) or {}, assembly_index)
    return dataset


def _sv_registry_signature(output_dir: Any) -> Tuple[Any, ...]:
    registry_path = _sv_registry_store_path(output_dir)
    scan_dir = _sv_alignment_scan_dir(output_dir)

    scan_sig: List[Tuple[str, int, int]] = []
    if scan_dir and scan_dir.exists() and scan_dir.is_dir():
        for path in sorted(scan_dir.rglob("*")):
            if path.is_file() and (
                path.name.endswith(".bigChain.bb")
                or path.name.endswith(".hal_mapping.tsv")
                or path.name.endswith(".json")
            ):
                scan_sig.append(_sv_stat_signature(path))

    attached_sig = tuple(_sv_stat_signature(path) for path in _sv_attached_config_paths())
    return (
        _sv_stat_signature(registry_path),
        tuple(scan_sig),
        attached_sig,
        _sv_local_assembly_signature(output_dir),
    )


def _list_sv_datasets(output_dir: Any = "") -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    signature = _sv_registry_signature(output_dir)
    if _sv_registry_cache.get("signature") == signature:
        return list(_sv_registry_cache.get("datasets") or []), list(_sv_registry_cache.get("incomplete") or [])

    datasets: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()
    config_reports: List[Dict[str, Any]] = []

    def take(candidates: Iterable[Dict[str, Any]]) -> int:
        added = 0
        for dataset in candidates:
            if not dataset or dataset["id"] in seen_ids:
                continue
            seen_ids.add(dataset["id"])
            datasets.append(dataset)
            added += 1
        return added

    if SV_BUILTIN_DATASETS_ENABLED:
        take(_normalize_sv_dataset(raw, source="builtin") for raw in SV_DATASETS.values())

    take(_load_sv_alignment_registry_from_path(_sv_registry_store_path(output_dir)))

    scanned, incomplete = _scan_sv_alignment_dir(_sv_alignment_scan_dir(output_dir))
    take(scanned)

    # Attached configs come last so a locally registered alignment keeps precedence
    # over one arriving from a shared file with the same id.
    for path in _sv_attached_config_paths():
        loaded, diagnostics = _load_sv_config_file(path, source="config")
        count = take(loaded)
        config_reports.append({
            "path": str(path),
            "label": path.name,
            "exists": path.exists(),
            "alignment_count": count,
            "diagnostics": diagnostics,
        })

    assembly_index = _sv_local_assembly_index(output_dir)
    datasets = [_sv_attach_assembly_paths(dataset, assembly_index) for dataset in datasets]

    _sv_registry_cache["signature"] = signature
    _sv_registry_cache["datasets"] = list(datasets)
    _sv_registry_cache["incomplete"] = list(incomplete)
    _sv_registry_cache["configs"] = list(config_reports)
    return datasets, incomplete


def _sv_genome_matches_text(genome: Dict[str, Any], text: Any) -> bool:
    query = _normalize_dataset_token(str(text or ""))
    if not query:
        return False
    aliases = [_normalize_dataset_token(alias) for alias in _sv_genome_aliases(genome)]
    return any(alias and (alias in query or query in alias) for alias in aliases)


def _sv_dataset_matches(dataset: Dict[str, Any], ref_assembly: str, tgt_assembly: str) -> bool:
    ref_norm = _normalize_dataset_token(ref_assembly)
    tgt_norm = _normalize_dataset_token(tgt_assembly)
    if not ref_norm or not tgt_norm:
        return False

    ref_aliases = [_normalize_dataset_token(a) for a in dataset.get("ref_aliases", [])]
    tgt_aliases = [_normalize_dataset_token(a) for a in dataset.get("tgt_aliases", [])]
    return (
        any(alias and (alias == ref_norm or alias in ref_norm) for alias in ref_aliases)
        and any(alias and (alias == tgt_norm or alias in tgt_norm) for alias in tgt_aliases)
    )


def _select_sv_dataset(ref_assembly: str, tgt_assembly: str, alignment_id: str = "", output_dir: Any = "") -> Optional[dict]:
    datasets, _ = _list_sv_datasets(output_dir)
    requested_id = str(alignment_id or "").strip()
    if requested_id:
        for dataset in datasets:
            if str(dataset.get("id") or "") == requested_id or str(dataset.get("alignment_id") or "") == requested_id:
                return dataset
        return None

    for dataset in datasets:
        if _sv_dataset_matches(dataset, ref_assembly, tgt_assembly):
            return dataset
    return None


def _load_sv_mapping(mapping_path: Path) -> Dict[str, Any]:
    """Parse a legacy mapping TSV.

    Kept for records that still name one -- registry entries written before the
    config format, and sidecar manifests. Current configs derive these names from
    the assembly instead; see ``_sv_side_mapping``.
    """
    cache_key = str(mapping_path)
    try:
        stat = mapping_path.stat()
        signature = (int(stat.st_mtime_ns), int(stat.st_size))
    except Exception:
        signature = (0, 0)
    cached = _sv_mapping_cache.get(cache_key)
    # Keyed by path alone this used to serve stale names forever after an edit.
    if cached is not None and cached.get("signature") == signature:
        return cached["mapping"]

    if not mapping_path.exists():
        raise HTTPException(status_code=404, detail=f"SV mapping TSV not found: {mapping_path}")

    hal_to_assembly: Dict[str, str] = {}
    assembly_to_hal: Dict[str, str] = {}
    alias_to_assembly: Dict[str, str] = {}
    genome_name = ""
    assembly_uuid = ""

    with open(mapping_path, "r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            genome_name = (row.get("hal_genome_name") or genome_name).strip()
            assembly_uuid = (row.get("assembly_uuid") or assembly_uuid).strip()
            hal_seq = (row.get("hal_sequence_name") or "").strip()
            assembly_seq = (row.get("assembly_sequence") or "").strip()
            if not hal_seq or not assembly_seq:
                continue
            hal_to_assembly[hal_seq] = assembly_seq
            assembly_to_hal.setdefault(assembly_seq, hal_seq)
            for alias in genome_context._sv_aliases_for_sequence(hal_seq) + genome_context._sv_aliases_for_sequence(assembly_seq):
                alias_to_assembly[alias.lower()] = assembly_seq

    result = {
        "hal_to_assembly": hal_to_assembly,
        "assembly_to_hal": assembly_to_hal,
        "alias_to_assembly": alias_to_assembly,
        "genome_name": genome_name,
        "assembly_uuid": assembly_uuid,
    }
    _sv_mapping_cache[cache_key] = {"signature": signature, "mapping": result}
    return result


def _sv_sort_region_key(region_name: Any) -> Tuple[int, int, str]:
    text = str(region_name or "").strip()
    lowered = text.lower()
    core = lowered[3:] if lowered.startswith("chr") else lowered
    if core.isdigit():
        return (0, int(core), text)
    special = {"x": 23, "y": 24, "m": 25, "mt": 25}
    if core in special:
        return (0, special[core], text)
    return (1, 0, text)


def _load_sv_bigchain_chrom_sizes(chain_path: Path) -> Dict[str, int]:
    path = Path(chain_path).expanduser()
    cache_key = str(path)
    try:
        stat = path.stat()
        signature = (int(stat.st_mtime_ns), int(stat.st_size))
    except Exception:
        signature = (0, 0)

    cached = _sv_bigchain_chrom_cache.get(cache_key)
    if cached and cached.get("signature") == signature:
        return dict(cached.get("chrom_sizes") or {})

    chrom_sizes: Dict[str, int] = {}
    if pyBigWig is not None and path.exists() and path.is_file():
        bw = None
        try:
            bw = pyBigWig.open(str(path))
            chrom_sizes = {str(k): int(v) for k, v in (bw.chroms() or {}).items()}
        except Exception:
            chrom_sizes = {}
        finally:
            try:
                if bw is not None:
                    bw.close()
            except Exception:
                pass

    _sv_bigchain_chrom_cache[cache_key] = {
        "signature": signature,
        "chrom_sizes": dict(chrom_sizes),
    }
    return chrom_sizes


def _sv_alignment_reference_regions(dataset: Dict[str, Any], limit: int = 500) -> List[Dict[str, Any]]:
    supported, _missing = _sv_dataset_file_status(dataset)
    if not supported:
        return []
    try:
        ref_map = _sv_side_mapping(dataset, "reference")
        tgt_map = _sv_side_mapping(dataset, "target")
    except Exception:
        return []

    chrom_sizes = _load_sv_bigchain_chrom_sizes(Path(dataset["chain_path"]))
    if not chrom_sizes:
        return []

    indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()
    if indexed_side not in {"reference", "target"}:
        indexed_side = "target"

    target_regions = set(str(item) for item in (tgt_map.get("assembly_to_hal") or {}).keys())
    out: List[Dict[str, Any]] = []
    for ref_region in sorted((ref_map.get("assembly_to_hal") or {}).keys(), key=_sv_sort_region_key):
        if indexed_side == "reference":
            indexed_region = str(ref_region)
        else:
            if str(ref_region) not in target_regions:
                continue
            indexed_region = str(ref_region)

        chain_chrom = genome_context._resolve_bigwig_chrom_name(indexed_region, chrom_sizes)
        if not chain_chrom:
            continue
        out.append({
            "id": str(ref_region),
            "chrom": str(ref_region),
            "label": str(ref_region),
            "indexed_chrom": chain_chrom,
            "indexed_length": int(chrom_sizes.get(chain_chrom, 0) or 0),
        })
        if len(out) >= limit:
            break
    return out


def _resolve_sv_sequence(mapping: Dict[str, Any], token: str) -> Optional[str]:
    t = (token or "").strip()
    if not t:
        return None
    if t in mapping["assembly_to_hal"]:
        return t
    if t in mapping["hal_to_assembly"]:
        return mapping["hal_to_assembly"][t]
    return mapping["alias_to_assembly"].get(t.lower())


def _build_sv_chrom_size_aliases(chrom_length: int, *tokens: Optional[str]) -> Dict[str, int]:
    if int(chrom_length or 0) <= 0:
        return {}

    out: Dict[str, int] = {}
    for token in tokens:
        raw = str(token or "").strip()
        if not raw:
            continue
        for alias in genome_context._sv_aliases_for_sequence(raw):
            out[alias] = int(chrom_length)
    return out


def _fetch_genes_for_window(db_path: str, chrom: str, start: int, end: int, limit: int = 1000) -> List[dict]:
    if not chrom or end <= start:
        return []

    resolved = genome_context._resolve_db_chrom_name(db_path, chrom) or chrom
    q_start = max(0, int(start))
    q_end = max(q_start + 1, int(end))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute(
            """
            SELECT id, name, chrom, start, end, strand, biotype
            FROM genes
            WHERE chrom = ? AND end >= ? AND start <= ?
            ORDER BY start ASC
            LIMIT ?
            """,
            (resolved, q_start, q_end, int(max(100, limit))),
        )
        rows = c.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": r["id"],
            "name": r["name"],
            "chrom": r["chrom"],
            "start": int(r["start"]),
            "end": int(r["end"]),
            "strand": r["strand"],
            "biotype": r["biotype"] or "",
        }
        for r in rows
    ]


def _parse_bigchain_entry_rest(rest: str) -> Optional[Dict[str, Any]]:
    parts = (rest or "").split("\t")
    if len(parts) < 8:
        return None
    try:
        indexed_size = int(parts[3])
        query_size = int(parts[5])
        query_start = int(parts[6])
        query_end = int(parts[7])
    except Exception:
        return None

    strand = parts[2] if parts[2] in {"+", "-"} else "+"
    if strand == "-":
        ref_start = query_size - query_end
        ref_end = query_size - query_start
    else:
        ref_start = query_start
        ref_end = query_end

    return {
        "chain_id": parts[0],
        "score": int(parts[1]) if parts[1].isdigit() else 0,
        "strand": strand,
        "indexed_size": indexed_size,
        "q_size": query_size,
        "ref_seq": parts[4],
        "ref_size": query_size,
        "ref_start": ref_start,
        "ref_end": ref_end,
        "raw_query_start": query_start,
        "raw_query_end": query_end,
        "level": int(parts[8]) if len(parts) >= 9 and parts[8].isdigit() else 0,
    }


def _classify_sv_block(strand: str, target_span: int, ref_span: int) -> str:
    if strand == "-":
        return "inverted_match"
    ratio = float(target_span) / max(1.0, float(ref_span))
    if ratio > 1.2:
        return "gain_or_insertion"
    if ratio < 0.8:
        return "deletion_or_loss"
    return "match"


def _build_sv_segments(blocks: List[Dict[str, Any]], ref_window_span: int) -> List[Dict[str, Any]]:
    if not blocks:
        return []

    gap_ref = max(250, int(max(1, ref_window_span) * 0.015))
    gap_tgt = max(250, int(max(1, ref_window_span) * 0.015))
    sorted_blocks = sorted(blocks, key=lambda b: (int(b["ref_start"]), int(b["tgt_start"])))

    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def _flush(cur: Optional[Dict[str, Any]]):
        if not cur:
            return
        block_count = max(1, int(cur.get("block_count", 1)))
        score_sum = int(cur.get("score_sum", 0))
        cur["score"] = int(round(score_sum / block_count)) if score_sum > 0 else int(cur.get("score", 0))
        cur.pop("score_sum", None)
        segments.append(cur)

    for block in sorted_blocks:
        b_ref_s = int(block["ref_start"])
        b_ref_e = int(block["ref_end"])
        b_tgt_s = int(block["tgt_start"])
        b_tgt_e = int(block["tgt_end"])
        b_type = str(block.get("type") or "match")
        b_strand = str(block.get("strand") or "+")
        b_score = int(block.get("score") or 0)

        if current:
            same_type = b_type == current["type"]
            same_strand = b_strand == current["strand"]
            ref_gap = b_ref_s - int(current["ref_end"])
            if b_strand == "+":
                tgt_gap = b_tgt_s - int(current["tgt_end"])
            else:
                tgt_gap = int(current["tgt_start"]) - b_tgt_e
            can_merge = (
                same_type
                and same_strand
                and ref_gap <= gap_ref
                and tgt_gap <= gap_tgt
            )
            if can_merge:
                current["ref_end"] = max(int(current["ref_end"]), b_ref_e)
                current["tgt_start"] = min(int(current["tgt_start"]), b_tgt_s)
                current["tgt_end"] = max(int(current["tgt_end"]), b_tgt_e)
                current["target_span"] = int(current["tgt_end"]) - int(current["tgt_start"])
                current["ref_span"] = int(current["ref_end"]) - int(current["ref_start"])
                current["block_count"] = int(current.get("block_count", 1)) + 1
                current["score_sum"] = int(current.get("score_sum", 0)) + b_score
                continue

        _flush(current)
        current = {
            "chain_id": block.get("chain_id"),
            "score": b_score,
            "score_sum": b_score,
            "strand": b_strand,
            "ref_start": b_ref_s,
            "ref_end": b_ref_e,
            "tgt_start": b_tgt_s,
            "tgt_end": b_tgt_e,
            "target_span": max(1, b_tgt_e - b_tgt_s),
            "ref_span": max(1, b_ref_e - b_ref_s),
            "type": b_type,
            "block_count": 1,
        }

    _flush(current)

    if len(segments) > 320:
        segments.sort(key=lambda s: ((int(s["ref_end"]) - int(s["ref_start"])) + (int(s["tgt_end"]) - int(s["tgt_start"])), int(s.get("score") or 0)), reverse=True)
        segments = segments[:320]
        segments.sort(key=lambda s: (int(s["ref_start"]), int(s["tgt_start"])))
    return segments


def _build_sv_feature_blocks(blocks: List[Dict[str, Any]], ref_window_span: int) -> List[Dict[str, Any]]:
    if not blocks:
        return []

    feature_candidates = [
        {
            "ref_start": int(b["ref_start"]),
            "ref_end": int(b["ref_end"]),
            "type": str(b.get("type") or "match"),
            "score": int(b.get("score") or 0),
        }
        for b in blocks
        if str(b.get("type") or "match") != "match"
    ]
    if not feature_candidates:
        return []

    feature_candidates.sort(key=lambda f: (f["type"], f["ref_start"], f["ref_end"]))
    gap_ref = max(80, int(max(1, ref_window_span) * 0.003))
    merged: List[Dict[str, Any]] = []

    for feat in feature_candidates:
        if not merged:
            merged.append(dict(feat))
            continue
        last = merged[-1]
        if feat["type"] == last["type"] and feat["ref_start"] <= (last["ref_end"] + gap_ref):
            last["ref_end"] = max(int(last["ref_end"]), int(feat["ref_end"]))
            last["score"] = max(int(last.get("score") or 0), int(feat.get("score") or 0))
        else:
            merged.append(dict(feat))

    if len(merged) > 480:
        merged.sort(key=lambda f: ((int(f["ref_end"]) - int(f["ref_start"])), int(f.get("score") or 0)), reverse=True)
        merged = merged[:480]
        merged.sort(key=lambda f: int(f["ref_start"]))
    return merged


def _build_sv_gap_variants(
    blocks: List[Dict[str, Any]],
    ref_chrom: str,
    ref_start: int,
    ref_end: int,
    max_variants: int = 2500,
) -> List[Dict[str, Any]]:
    if not blocks or ref_end <= ref_start:
        return []

    variants: List[Dict[str, Any]] = []
    consequence_labels = {
        "deletion": "Deletion or loss",
        "insertion": "Gain or insertion",
        "snv": "SNV",
    }
    sorted_blocks = sorted(blocks, key=lambda b: (int(b["ref_start"]), int(b["tgt_start"])))

    for previous, current in zip(sorted_blocks, sorted_blocks[1:]):
        prev_ref_end = int(previous["ref_end"])
        curr_ref_start = int(current["ref_start"])
        if curr_ref_start < (ref_start - 1) or prev_ref_end > (ref_end + 1):
            continue

        prev_strand = str(previous.get("strand") or "+")
        curr_strand = str(current.get("strand") or "+")
        same_reverse = prev_strand == curr_strand == "-"

        ref_gap_start = prev_ref_end + 1
        ref_gap_end = curr_ref_start - 1
        ref_gap = max(0, ref_gap_end - ref_gap_start + 1)

        if same_reverse:
            alt_gap = max(0, int(previous["tgt_start"]) - int(current["tgt_end"]) - 1)
        else:
            alt_gap = max(0, int(current["tgt_start"]) - int(previous["tgt_end"]) - 1)

        if prev_strand != curr_strand:
            continue

        gap_delta = alt_gap - ref_gap
        if ref_gap == 1 and alt_gap == 1:
            variant_type = "snv"
        elif gap_delta >= 1:
            variant_type = "insertion"
        elif gap_delta <= -1:
            variant_type = "deletion"
        else:
            continue

        if ref_gap > 0:
            variant_start = max(int(ref_start), ref_gap_start)
            variant_end = min(int(ref_end), ref_gap_end)
            if variant_end < variant_start:
                continue
        else:
            anchor = min(max(prev_ref_end, int(ref_start)), int(ref_end))
            if anchor < ref_start or anchor > ref_end:
                continue
            variant_start = anchor
            variant_end = anchor

        extent = max(1, ref_gap, alt_gap)
        variants.append(
            {
                "name": f"sv-gap-{previous.get('chain_id', 'block')}-{current.get('chain_id', 'block')}-{variant_start}",
                "type": variant_type,
                "consequence": consequence_labels[variant_type],
                "extent": extent,
                "ref_length": max(0, ref_gap),
                "alt_length": max(0, alt_gap),
                "location": {
                    "region_name": ref_chrom,
                    "start": int(variant_start),
                    "end": int(variant_end),
                },
            }
        )

    variants.sort(key=lambda item: (int(item["location"]["start"]), int(item["location"]["end"]), str(item["type"])))
    if len(variants) > max_variants:
        step = max(1, math.ceil(len(variants) / max_variants))
        variants = variants[::step][:max_variants]
    return variants


def _sv_effective_output_dir(output_dir: Any = "") -> str:
    output_dir_text = str(output_dir or "").strip()
    if output_dir_text:
        return output_dir_text
    try:
        return str(config_store.load_config().get("output_dir") or "").strip()
    except Exception:
        return ""


def _sv_path_status(path_value: Any) -> Dict[str, Any]:
    path = Path(str(path_value or "")).expanduser()
    exists = bool(str(path_value or "").strip()) and path.exists() and path.is_file()
    out: Dict[str, Any] = {
        "path": str(path) if str(path_value or "").strip() else "",
        "exists": exists,
        "size": 0,
        "mtime": 0,
    }
    if exists:
        try:
            stat = path.stat()
            out["size"] = int(stat.st_size)
            out["mtime"] = float(stat.st_mtime)
        except Exception:
            pass
    return out


def _sv_public_data_tracks(dataset: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    tracks = dataset.get("tracks") if isinstance(dataset.get("tracks"), dict) else {}
    out: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    for side in ("reference", "target"):
        for track in tracks.get(side) or []:
            if not isinstance(track, dict):
                continue
            path = str(track.get("path") or "").strip()
            if not path:
                continue
            out[side].append({
                "id": str(track.get("id") or hashlib.sha1(f"{side}|{path}".encode("utf-8")).hexdigest()[:16]),
                "side": side,
                "type": str(track.get("type") or "").strip().lower(),
                "label": str(track.get("label") or "").strip(),
                "path": path,
                "display_mode": str(track.get("display_mode") or "flatten").strip() or "flatten",
                "file": _sv_path_status(path),
            })
    return out


def _sv_record_tokens(record: Optional[Dict[str, Any]]) -> Set[str]:
    if not isinstance(record, dict):
        return set()
    values: List[Any] = [
        record.get("genome_key"),
        record.get("key"),
        _sv_genome_key_from_record(record),
        record.get("assembly"),
        record.get("gca"),
        record.get("accession"),
        record.get("assembly_name"),
    ]
    values.extend(_sv_genome_aliases(record))
    return {token for token in (_normalize_dataset_token(v) for v in values) if token}


def _sv_records_match(left: Optional[Dict[str, Any]], right: Optional[Dict[str, Any]]) -> bool:
    left_tokens = _sv_record_tokens(left)
    right_tokens = _sv_record_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    if left_tokens & right_tokens:
        return True
    for left_token in left_tokens:
        if len(left_token) < 5:
            continue
        for right_token in right_tokens:
            if len(right_token) >= 5 and (left_token in right_token or right_token in left_token):
                return True
    return False


def _sv_catalog_genome_id(genome: Dict[str, Any]) -> str:
    key = str(genome.get("genome_key") or "").strip()
    if key:
        return key
    # The accession before the alias set. Hashing aliases made the id depend on how
    # thoroughly a record happened to be described, so the same assembly reached the
    # catalog twice when one source listed more names for it than another.
    accession = _normalize_dataset_token(
        genome.get("accession") or genome.get("assembly") or genome.get("gca")
    )
    if accession:
        return f"sv_catalog_{accession}"
    aliases = _sv_genome_aliases(genome)
    seed = "|".join(sorted(_normalize_dataset_token(alias) for alias in aliases if alias))
    if not seed:
        seed = str(genome.get("assembly_name") or genome.get("assembly") or genome.get("display_name") or "genome")
    return f"sv_catalog_{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:12]}"


def _sv_public_genome(genome: Dict[str, Any]) -> Dict[str, Any]:
    aliases = _sv_genome_aliases(genome)
    display_name = (
        str(genome.get("display_name") or "").strip()
        or str(genome.get("assembly_name") or "").strip()
        or str(genome.get("assembly") or "").strip()
        or str(genome.get("common_name") or "").strip()
        or str(genome.get("scientific_name") or "").strip()
        or "Genome"
    )
    out = {
        "id": _sv_catalog_genome_id(genome),
        "genome_key": str(genome.get("genome_key") or "").strip(),
        "provider": str(genome.get("provider") or DEFAULT_PROVIDER).strip(),
        "species_key": str(genome.get("species_key") or "").strip(),
        "assembly": str(genome.get("assembly") or genome.get("gca") or "").strip(),
        "gca": str(genome.get("gca") or "").strip(),
        "accession": str(genome.get("accession") or genome.get("assembly") or "").strip(),
        "assembly_name": str(genome.get("assembly_name") or "").strip(),
        "scientific_name": str(genome.get("scientific_name") or "").strip(),
        "common_name": str(genome.get("common_name") or "").strip(),
        "display_name": display_name,
        "aliases": aliases,
    }
    return out


def _sv_pair_id_for_dataset(dataset: Dict[str, Any]) -> str:
    """Identify the genome pair an alignment belongs to, ignoring direction.

    Two alignments between the same assemblies share a pair id whichever way round
    they run, which is what lets the view offer both directions under one entry.
    Datasets built from a config carry this already; scanned and legacy ones do not.
    """
    tokens = sorted(
        _normalize_dataset_token(
            (dataset.get(field) or {}).get("accession")
            or (dataset.get(field) or {}).get("assembly")
            or (dataset.get(field) or {}).get("assembly_name")
        )
        for field in ("reference_genome", "target_genome")
    )
    return "__".join(token for token in tokens if token)


def _sv_public_dataset(dataset: Dict[str, Any]) -> Dict[str, Any]:
    supported, missing = _sv_dataset_file_status(dataset)
    data_tracks = _sv_public_data_tracks(dataset)
    return {
        "id": str(dataset.get("id") or dataset.get("alignment_id") or "").strip(),
        "alignment_id": str(dataset.get("id") or dataset.get("alignment_id") or "").strip(),
        "label": str(dataset.get("label") or "").strip(),
        "description": str(dataset.get("description") or "").strip(),
        "source": str(dataset.get("source") or "").strip(),
        "config_path": str(dataset.get("config_path") or "").strip(),
        "pair_id": str(dataset.get("pair_id") or _sv_pair_id_for_dataset(dataset)).strip(),
        "indexed_side": str(dataset.get("indexed_side") or "target").strip().lower(),
        "reference_genome": _sv_public_genome(dataset.get("reference_genome") or {}),
        "target_genome": _sv_public_genome(dataset.get("target_genome") or {}),
        "ref_aliases": _sv_genome_aliases(dataset.get("reference_genome") or {}, dataset.get("ref_aliases") or []),
        "tgt_aliases": _sv_genome_aliases(dataset.get("target_genome") or {}, dataset.get("tgt_aliases") or []),
        "files": {
            "bigchain": _sv_path_status(dataset.get("chain_path")),
            "reference_mapping": _sv_path_status(dataset.get("ref_mapping_path")),
            "target_mapping": _sv_path_status(dataset.get("tgt_mapping_path")),
            "reference_tracks": data_tracks["reference"],
            "target_tracks": data_tracks["target"],
        },
        "tracks": data_tracks,
        "supported": supported,
        "local": supported,
        "missing_files": missing,
        "reference_regions": _sv_alignment_reference_regions(dataset) if supported else [],
    }


def _sv_local_species_match(genome: Dict[str, Any], local_assemblies: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for assembly in local_assemblies:
        if _sv_records_match(genome, assembly):
            return assembly
    return None


def _sv_downloadable_match(genome: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        if not app_state.download_manager._species_cache and app_state.download_manager.species_data:
            app_state.download_manager._build_cache()
    except Exception:
        pass

    if app_state.download_manager._species_cache:
        for species in app_state.download_manager._species_cache:
            species_key = getattr(species, "key", "") or ""
            for assembly in getattr(species, "assemblies", []) or []:
                candidate = {
                    "provider": DEFAULT_PROVIDER,
                    "species_key": species_key,
                    "scientific_name": getattr(species, "scientific_name", "") or "",
                    "common_name": getattr(species, "common_name", "") or "",
                    "display_name": getattr(species, "display_name", "") or "",
                    "assembly": getattr(assembly, "gca", "") or getattr(assembly, "accession", "") or "",
                    "accession": getattr(assembly, "accession", "") or getattr(assembly, "gca", "") or "",
                    "assembly_name": getattr(assembly, "name", "") or "",
                    "equivalent_accessions": list(getattr(assembly, "equivalent_accessions", []) or []),
                }
                if _sv_records_match(genome, candidate):
                    return candidate

    for species_key, species_info in (app_state.download_manager.species_data or {}).items():
        if not isinstance(species_info, dict):
            continue
        for accession, assembly_info in (species_info.get("assemblies") or {}).items():
            candidate = {
                "provider": DEFAULT_PROVIDER,
                "species_key": species_key,
                "scientific_name": species_info.get("scientific_name") or "",
                "common_name": species_info.get("common_name") or "",
                "display_name": species_info.get("display_name") or "",
                "assembly": accession,
                "accession": accession,
                "assembly_name": assembly_info.get("name") if isinstance(assembly_info, dict) else "",
                "equivalent_accessions": assembly_info.get("equivalent_accessions", []) if isinstance(assembly_info, dict) else [],
            }
            if _sv_records_match(genome, candidate):
                return candidate
    return None


def _sv_catalog_genome_entry(
    genome: Dict[str, Any],
    local_assemblies: List[Dict[str, Any]],
) -> Dict[str, Any]:
    public = _sv_public_genome(genome)
    local_match = _sv_local_species_match(genome, local_assemblies)
    downloadable_match = None if local_match else _sv_downloadable_match(genome)
    local_files = local_match.get("files", {}) if isinstance(local_match, dict) else {}
    public["local"] = bool(local_match)
    public["local_usable"] = bool(local_files.get("gff3") and local_files.get("index") and local_files.get("fasta"))
    public["local_species"] = local_match if local_match else None
    public["downloadable"] = bool(downloadable_match)
    public["download_species"] = downloadable_match
    return public


def _merge_sv_catalog_genome(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    merged = {**existing}
    for key in ("local", "local_usable", "downloadable"):
        merged[key] = bool(existing.get(key) or incoming.get(key))
    for key in ("local_species", "download_species"):
        if not merged.get(key) and incoming.get(key):
            merged[key] = incoming.get(key)
    merged["aliases"] = _sv_unique_strings(list(existing.get("aliases") or []) + list(incoming.get("aliases") or []))
    for key, value in incoming.items():
        if key not in merged or not merged.get(key):
            merged[key] = value
    return merged


class SvAlignmentRegisterRequest(BaseModel):
    output_dir: str = ""
    id: Optional[str] = None
    label: str = ""
    chain_path: str
    description: str = ""
    # Mapping TSVs are no longer part of registration; the fields remain so an
    # older client's payload is accepted rather than rejected outright.
    ref_mapping_path: str = ""
    tgt_mapping_path: str = ""
    # Empty means "work it out from the file name and the assemblies".
    indexed_side: str = ""
    reference_bigwig_path: str = ""
    reference_bigbed_path: str = ""
    target_bigwig_path: str = ""
    target_bigbed_path: str = ""
    tracks: Optional[Dict[str, Any]] = None
    reference_genome: Optional[Dict[str, Any]] = None
    target_genome: Optional[Dict[str, Any]] = None
    ref_aliases: Optional[List[str]] = None
    tgt_aliases: Optional[List[str]] = None
    # Where to save: {"kind": "registry"} or {"kind": "config", "path", "mode"}.
    target: Optional[Dict[str, Any]] = None
