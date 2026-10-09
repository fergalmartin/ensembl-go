"""Structural variation: the SV dataset catalogue (built-in datasets, registered
alignments, attached SV config files), alignment registration and config editing, and
the /api/sv view, alignment and variant endpoints that read bigChain/bigBed alignment
files between genomes.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

import config_store
import genome_context
import local_inventory
from security_utils import validate_config_export_path
from sv_config import (
    config_to_datasets as sv_config_to_datasets,
    config_to_document as sv_config_to_document,
    CONFIG_VERSION_KEY as SV_CONFIG_VERSION_KEY,
    has_errors as sv_config_has_errors,
    is_sv_key_value_text,
    locate_pointer_lines as sv_locate_pointer_lines,
    merge_sv_config,
    parse_sv_config,
    remove_alignment as sv_remove_alignment,
    serialize_sv_config,
    serialize_sv_key_value_config,
)
import sv_datasets

router = APIRouter()


@router.get("/api/sv/catalog")
async def sv_catalog(output_dir: str = ""):
    output_dir_text = sv_datasets._sv_effective_output_dir(output_dir)
    datasets, incomplete_scans = sv_datasets._list_sv_datasets(output_dir_text)
    try:
        local_assemblies = await run_in_threadpool(local_inventory.list_local_assemblies, output_dir_text) if output_dir_text else []
    except Exception:
        local_assemblies = []

    public_alignments = [sv_datasets._sv_public_dataset(dataset) for dataset in datasets]
    genomes_by_id: Dict[str, Dict[str, Any]] = {}
    edges: List[Dict[str, Any]] = []

    for dataset, alignment in zip(datasets, public_alignments):
        ref_entry = sv_datasets._sv_catalog_genome_entry(dataset.get("reference_genome") or {}, local_assemblies)
        tgt_entry = sv_datasets._sv_catalog_genome_entry(dataset.get("target_genome") or {}, local_assemblies)
        ref_id = ref_entry["id"]
        tgt_id = tgt_entry["id"]
        genomes_by_id[ref_id] = sv_datasets._merge_sv_catalog_genome(genomes_by_id.get(ref_id, {}), ref_entry)
        genomes_by_id[tgt_id] = sv_datasets._merge_sv_catalog_genome(genomes_by_id.get(tgt_id, {}), tgt_entry)
        alignment["reference_genome"] = genomes_by_id[ref_id]
        alignment["target_genome"] = genomes_by_id[tgt_id]
        alignment["reference_genome_id"] = ref_id
        alignment["target_genome_id"] = tgt_id
        edges.append({
            "alignment_id": alignment["id"],
            "label": alignment.get("label") or alignment["id"],
            "reference_genome_id": ref_id,
            "target_genome_id": tgt_id,
            "source": alignment.get("source") or "",
            "supported": bool(alignment.get("supported")),
            "local": bool(alignment.get("local")),
            "missing_files": alignment.get("missing_files") or [],
        })

    registry_path = sv_datasets._sv_registry_store_path(output_dir_text)
    scan_dir = sv_datasets._sv_alignment_scan_dir(output_dir_text)
    return {
        "alignments": public_alignments,
        "genomes": sorted(genomes_by_id.values(), key=lambda item: (str(item.get("display_name") or ""), str(item.get("id") or ""))),
        "edges": edges,
        "incomplete_scans": incomplete_scans,
        "configs": list(sv_datasets._sv_registry_cache.get("configs") or []),
        "registry_path": str(registry_path) if registry_path else "",
        "scan_dir": str(scan_dir) if scan_dir else "",
    }


def _sv_require_existing_file(label: str, raw_path: Any, required: bool = True) -> str:
    text = str(raw_path or "").strip()
    if not text:
        if required:
            raise HTTPException(status_code=400, detail=f"{label} is required.")
        return ""
    path = Path(text).expanduser()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=400, detail=f"{label} not found: {path}")
    return str(path)


def _sv_read_config_file(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], str]:
    """Read and parse a config file, returning ``(config, diagnostics, text)``."""
    if not path.exists():
        return {SV_CONFIG_VERSION_KEY: 1, "genomes": {}, "pairs": []}, [], ""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read {path}: {exc}")
    config, diagnostics = parse_sv_config(text, base_dir=path.parent)
    return config, sv_locate_pointer_lines(text, diagnostics), text


def _sv_write_config_file(path: Path, config: Dict[str, Any], source_text: Optional[str] = None) -> str:
    """Write a config atomically, under the same lock every SV write takes."""
    existing_text = path.read_text(encoding="utf-8") if path.exists() else ""
    use_records = path.suffix.lower() == ".cfg" and (
        not existing_text or is_sv_key_value_text(existing_text) or
        (source_text is not None and is_sv_key_value_text(source_text))
    )
    if use_records:
        # An editor replacement has already passed validation. Preserve comments,
        # ordering, and blank optional fields exactly as the user wrote them.
        text = source_text if source_text is not None and is_sv_key_value_text(source_text) else serialize_sv_key_value_config(config, base_dir=path.parent)
    else:
        text = serialize_sv_config(sv_config_to_document(config, base_dir=path.parent))
    with sv_datasets._sv_config_write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(f"{path.name}.tmp")
        tmp_path.write_text(text, encoding="utf-8")
        tmp_path.replace(path)
    sv_datasets._sv_registry_cache["signature"] = None
    return text


def _sv_registration_config(payload: "SvAlignmentRegisterRequest", base_dir: Optional[Path]) -> Dict[str, Any]:
    """Turn one registration into a single-alignment config, ready to be merged."""
    label = str(payload.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="An alignment label is required. Labels identify an alignment, so each must be unique.")

    reference_genome = payload.reference_genome or {}
    target_genome = payload.target_genome or {}
    ref_handle = _sv_config_handle(reference_genome)
    tgt_handle = _sv_config_handle(target_genome)
    if not ref_handle or not tgt_handle:
        raise HTTPException(status_code=400, detail="A reference and a target genome are both required.")
    if ref_handle == tgt_handle:
        raise HTTPException(status_code=400, detail="The reference and target must be different genomes.")

    chain = _sv_require_existing_file("BigChain file", payload.chain_path)
    indexed_side = str(payload.indexed_side or "").strip().lower()
    if indexed_side and indexed_side not in {"reference", "target"}:
        raise HTTPException(status_code=400, detail="indexed_side must be 'reference', 'target', or empty to detect it.")

    tracks: Dict[str, List[Dict[str, Any]]] = {ref_handle: [], tgt_handle: []}
    for handle, label_text, raw in (
        (ref_handle, "Reference BigWig", payload.reference_bigwig_path),
        (ref_handle, "Reference BigBed", payload.reference_bigbed_path),
        (tgt_handle, "Target BigWig", payload.target_bigwig_path),
        (tgt_handle, "Target BigBed", payload.target_bigbed_path),
    ):
        resolved = _sv_require_existing_file(label_text, raw, required=False)
        if resolved:
            tracks[handle].append({"path": resolved})

    alignment: Dict[str, Any] = {
        "label": label,
        "reference": ref_handle,
        "target": tgt_handle,
        "chain": chain,
    }
    if str(payload.id or "").strip():
        alignment["id"] = str(payload.id).strip()
    if str(payload.description or "").strip():
        alignment["description"] = str(payload.description).strip()
    if indexed_side:
        alignment["indexed_side"] = indexed_side
    populated = {handle: items for handle, items in tracks.items() if items}
    if populated:
        alignment["tracks"] = populated

    config = {
        SV_CONFIG_VERSION_KEY: 1,
        "genomes": {
            ref_handle: _sv_config_genome_entry(reference_genome),
            tgt_handle: _sv_config_genome_entry(target_genome),
        },
        "pairs": [{"genomes": [ref_handle, tgt_handle], "alignments": [alignment]}],
    }

    parsed, diagnostics = parse_sv_config(config, base_dir=base_dir)
    if sv_config_has_errors(diagnostics):
        detail = "; ".join(item["message"] for item in diagnostics if item["severity"] == "error")
        raise HTTPException(status_code=400, detail=detail)
    return parsed


def _sv_config_handle(genome: Dict[str, Any]) -> str:
    for field in ("assembly_name", "display_name", "accession", "assembly", "gca"):
        text = str((genome or {}).get(field) or "").strip()
        if text:
            return text
    return ""


def _sv_config_genome_entry(genome: Dict[str, Any]) -> Dict[str, Any]:
    source = genome or {}
    accession = str(source.get("accession") or source.get("assembly") or source.get("gca") or "").strip()
    entry: Dict[str, Any] = {"accession": accession}
    assembly_name = str(source.get("assembly_name") or "").strip()
    if assembly_name and assembly_name != accession:
        entry["assembly_name"] = assembly_name
    species = str(source.get("scientific_name") or "").strip()
    if species:
        entry["species"] = species
    equivalents = [str(value).strip() for value in (source.get("equivalent_accessions") or []) if str(value).strip()]
    if equivalents:
        entry["aliases"] = equivalents
    return entry


@router.post("/api/sv/alignments/register")
async def register_sv_alignment(payload: sv_datasets.SvAlignmentRegisterRequest):
    """Add one alignment to the registry, or to a config file the user names.

    Registration and hand-writing a config now produce the same file in the same
    format, so a setup built through the interface can be read, edited and shared
    without an export step.
    """
    output_dir_text = sv_datasets._sv_effective_output_dir(payload.output_dir)

    target_kind = str((payload.target or {}).get("kind") or "registry").strip().lower()
    if target_kind == "config":
        raw_path = str((payload.target or {}).get("path") or "").strip()
        if not raw_path:
            raise HTTPException(status_code=400, detail="A config file path is required when saving to a config.")
        destination = validate_config_export_path(raw_path)
        mode = str((payload.target or {}).get("mode") or "merge").strip().lower()
    else:
        destination = sv_datasets._sv_registry_store_path(output_dir_text)
        if not destination:
            raise HTTPException(status_code=400, detail="output_dir is required to register SV alignments.")
        mode = "merge"

    incoming = _sv_registration_config(payload, base_dir=destination.parent)
    existing, diagnostics, _text = _sv_read_config_file(destination)
    if sv_config_has_errors(diagnostics):
        raise HTTPException(
            status_code=400,
            detail=f"{destination} could not be parsed, so it was left untouched. Fix it in the configuration editor first.",
        )

    merged = merge_sv_config(existing, incoming, mode=mode)
    _sv_write_config_file(destination, merged)

    datasets = [
        sv_datasets._normalize_sv_dataset(raw, source="registered", base_dir=destination.parent)
        for raw in sv_config_to_datasets(incoming, source="registered", config_path=str(destination))
    ]
    assembly_index = sv_datasets._sv_local_assembly_index(output_dir_text)
    saved = [sv_datasets._sv_attach_assembly_paths(dataset, assembly_index) for dataset in datasets if dataset]

    return {
        "ok": True,
        "alignment": sv_datasets._sv_public_dataset(saved[0]) if saved else None,
        "registry_path": str(destination),
        "config_path": str(destination),
    }


class SvAlignmentDeleteRequest(BaseModel):
    output_dir: str = ""
    config_path: str = ""


@router.post("/api/sv/alignments/{alignment_id}/delete")
async def delete_sv_alignment(alignment_id: str, payload: SvAlignmentDeleteRequest):
    """Remove one alignment from whichever config holds it.

    A POST rather than a DELETE so the request can name the config file it applies
    to; the app's own registry is the default.
    """
    output_dir_text = sv_datasets._sv_effective_output_dir(payload.output_dir)
    if str(payload.config_path or "").strip():
        destination = validate_config_export_path(payload.config_path)
    else:
        destination = sv_datasets._sv_registry_store_path(output_dir_text)
    if not destination or not destination.exists():
        raise HTTPException(status_code=404, detail="No SV configuration file to remove this alignment from.")

    existing, diagnostics, _text = _sv_read_config_file(destination)
    if sv_config_has_errors(diagnostics):
        raise HTTPException(
            status_code=400,
            detail=f"{destination} could not be parsed, so it was left untouched.",
        )

    updated, removed = sv_remove_alignment(existing, alignment_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"No alignment '{alignment_id}' in {destination.name}.")

    _sv_write_config_file(destination, updated)
    return {"ok": True, "config_path": str(destination)}


class SvConfigValidateRequest(BaseModel):
    text: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    base_dir: str = ""


@router.post("/api/sv/config/validate")
async def validate_sv_config(payload: SvConfigValidateRequest):
    """Check a configuration without writing anything.

    Backs the editor's Validate button, so it has to tolerate whatever half-finished
    text is in the box and answer with diagnostics rather than an error status.
    """
    base_dir = Path(payload.base_dir).expanduser() if str(payload.base_dir or "").strip() else None
    source: Any = payload.text if payload.text is not None else (payload.config or {})
    config, diagnostics = parse_sv_config(source, base_dir=base_dir)
    if isinstance(source, str):
        diagnostics = sv_locate_pointer_lines(source, diagnostics)

    datasets = sv_config_to_datasets(config)
    missing_files: List[str] = []
    for dataset in datasets:
        chain = str(dataset.get("chain_path") or "")
        if chain and not Path(chain).expanduser().exists():
            missing_files.append(chain)
        for field in ("ref_mapping_path", "tgt_mapping_path"):
            path = str(dataset.get(field) or "")
            if path and not Path(path).expanduser().exists():
                missing_files.append(path)
        for side in ("reference", "target"):
            for track in (dataset.get("tracks") or {}).get(side) or []:
                path = str(track.get("path") or "")
                if path and not Path(path).expanduser().exists():
                    missing_files.append(path)

    return {
        "ok": not sv_config_has_errors(diagnostics),
        "config": config,
        "diagnostics": diagnostics,
        "alignment_count": len(datasets),
        "missing_files": missing_files,
    }


@router.get("/api/sv/config")
async def read_sv_config(path: str = "", output_dir: str = ""):
    """Return a config file as text, or the app's registry rendered as one."""
    if str(path or "").strip():
        target = validate_config_export_path(path)
    else:
        target = sv_datasets._sv_registry_store_path(sv_datasets._sv_effective_output_dir(output_dir))
        if not target:
            raise HTTPException(status_code=400, detail="output_dir is required to read the SV registry.")

    if not target.exists():
        empty = {SV_CONFIG_VERSION_KEY: 1, "genomes": {}, "pairs": []}
        return {"path": str(target), "exists": False, "text": serialize_sv_config(empty), "config": empty, "diagnostics": []}

    config, diagnostics, text = _sv_read_config_file(target)
    # A file already in the current format is returned exactly as written, so the
    # editor does not silently reformat what the user typed. A legacy registry has
    # no such form to preserve, so show the migrated document -- rendered the same
    # way a write would render it, not the parsed structure, which carries derived
    # fields nobody should have to read.
    rendered = (
        serialize_sv_config(sv_config_to_document(config, base_dir=target.parent))
        if _sv_config_is_legacy_text(text)
        else text
    )
    return {"path": str(target), "exists": True, "text": rendered, "config": config, "diagnostics": diagnostics}


def _sv_config_is_legacy_text(text: str) -> bool:
    try:
        payload = json.loads(text or "{}")
    except Exception:
        return False
    return isinstance(payload, dict) and SV_CONFIG_VERSION_KEY not in payload


class SvConfigSaveRequest(BaseModel):
    path: str
    text: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    mode: str = "replace"
    attach: bool = False


@router.post("/api/sv/config/save")
async def save_sv_config(payload: SvConfigSaveRequest):
    """Validate, then write. A config that does not parse is never written."""
    destination = validate_config_export_path(payload.path)
    source: Any = payload.text if payload.text is not None else (payload.config or {})
    incoming, diagnostics = parse_sv_config(source, base_dir=destination.parent)
    if isinstance(source, str):
        diagnostics = sv_locate_pointer_lines(source, diagnostics)
    if sv_config_has_errors(diagnostics):
        return {"ok": False, "diagnostics": diagnostics, "path": str(destination)}

    mode = str(payload.mode or "replace").strip().lower()
    if mode == "merge" and destination.exists():
        existing, existing_diagnostics, _text = _sv_read_config_file(destination)
        if sv_config_has_errors(existing_diagnostics):
            raise HTTPException(
                status_code=400,
                detail=f"{destination} could not be parsed, so it was left untouched.",
            )
        final = merge_sv_config(existing, incoming, mode="merge")
    else:
        final = incoming

    text = _sv_write_config_file(destination, final, source_text=source if isinstance(source, str) and mode != "merge" else None)
    if payload.attach:
        _sv_attach_config_path(destination)
    return {"ok": True, "path": str(destination), "text": text, "diagnostics": diagnostics}


class SvConfigAttachRequest(BaseModel):
    path: str


def _sv_attach_config_path(path: Path) -> List[str]:
    config = config_store.load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip()]
    if str(path) not in paths:
        paths.append(str(path))
    config["sv_config_paths"] = paths
    config_store.save_config(config)
    sv_datasets._sv_registry_cache["signature"] = None
    return paths


@router.post("/api/sv/config/attach")
async def attach_sv_config(payload: SvConfigAttachRequest):
    """Add a config file to the set the SV view reads from."""
    target = validate_config_export_path(payload.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Configuration file not found: {target}")
    _config, diagnostics, _text = _sv_read_config_file(target)
    if sv_config_has_errors(diagnostics):
        return {"ok": False, "diagnostics": diagnostics, "path": str(target)}
    return {"ok": True, "path": str(target), "paths": _sv_attach_config_path(target), "diagnostics": diagnostics}


@router.post("/api/sv/config/detach")
def detach_sv_config(payload: SvConfigAttachRequest):
    """Stop reading a config file. The file itself is left alone."""
    target = str(Path(str(payload.path or "").strip()).expanduser())
    config = config_store.load_config()
    paths = [str(item) for item in (config.get("sv_config_paths") or []) if str(item or "").strip() and str(item) != target]
    config["sv_config_paths"] = paths
    config_store.save_config(config)
    sv_datasets._sv_registry_cache["signature"] = None
    return {"ok": True, "paths": paths}


@router.get("/api/sv/view")
async def structural_variation_view(
    ref_assembly: str = "",
    tgt_assembly: str = "",
    ref_chrom: str = "",
    ref_start: int = 0,
    ref_end: int = 0,
    tgt_chrom: str = "",
    tgt_start: Optional[int] = None,
    tgt_end: Optional[int] = None,
    ref_browse_genome: str = "reference",
    tgt_browse_genome: str = "target",
    max_blocks: int = 2000,
    alignment_id: str = "",
    output_dir: str = "",
):
    if not ref_chrom:
        raise HTTPException(status_code=400, detail="ref_chrom is required.")
    if ref_end <= ref_start:
        raise HTTPException(status_code=400, detail="ref_end must be greater than ref_start.")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigChain support requires pyBigWig.")

    dataset = sv_datasets._select_sv_dataset(
        ref_assembly,
        tgt_assembly,
        alignment_id=alignment_id,
        output_dir=sv_datasets._sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return {
            "supported": False,
            "detail": "No registered SV alignment is available for this genome pair.",
        }

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, missing = sv_datasets._sv_dataset_file_status(dataset)
        if not supported:
            return {
                "supported": False,
                "detail": f"SV dataset files not found: {', '.join(missing)}",
            }

        try:
            resolved_ref_browse_genome = str(ref_browse_genome or "reference").strip() or "reference"
            resolved_tgt_browse_genome = str(tgt_browse_genome or "target").strip() or "target"
            ref_db_path = genome_context._get_browse_db(resolved_ref_browse_genome)
            tgt_db_path = genome_context._get_browse_db(resolved_tgt_browse_genome)
        except HTTPException as e:
            return {"supported": False, "detail": e.detail}

        ref_map = sv_datasets._sv_side_mapping(dataset, "reference")
        tgt_map = sv_datasets._sv_side_mapping(dataset, "target")

        ref_seq = sv_datasets._resolve_sv_sequence(ref_map, ref_chrom)
        if not ref_seq:
            return {
                "supported": False,
                "detail": f"Reference chromosome '{ref_chrom}' is not aligned in '{dataset.get('label') or dataset.get('id')}'.",
            }

        tgt_seq = sv_datasets._resolve_sv_sequence(tgt_map, tgt_chrom) if tgt_chrom else None
        if not tgt_seq:
            tgt_seq = str(ref_seq)
        if tgt_seq not in tgt_map["assembly_to_hal"]:
            tgt_seq = sv_datasets._resolve_sv_sequence(tgt_map, str(ref_seq))
        if not tgt_seq:
            return {
                "supported": False,
                "detail": "Could not resolve a target chromosome for this SV dataset.",
            }

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return {"supported": False, "detail": f"Failed to open BigChain file: {chain_path}"}
        if bw is None:
            return {"supported": False, "detail": f"Failed to open BigChain file: {chain_path}"}

        try:
            chrom_sizes = bw.chroms() or {}
            indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()
            if indexed_side not in {"reference", "target"}:
                indexed_side = "target"

            chain_lookup_seq = str(ref_seq) if indexed_side == "reference" else str(tgt_seq)
            chain_chrom = genome_context._resolve_bigwig_chrom_name(chain_lookup_seq, chrom_sizes)
            if not chain_chrom:
                return {
                    "supported": False,
                    "detail": f"Indexed sequence '{chain_lookup_seq}' is not present in the BigChain file.",
                }

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return {"supported": False, "detail": f"Invalid BigChain chromosome length for {chain_chrom}."}

            ref_s = max(0, int(ref_start))
            ref_e = max(ref_s + 1, int(ref_end))
            ref_span = max(1, ref_e - ref_s)

            has_target_window = (
                tgt_start is not None
                and tgt_end is not None
                and int(tgt_end) > int(tgt_start)
            )
            query_tgt_start = max(0, int(tgt_start)) if has_target_window else 0
            query_tgt_end = max(query_tgt_start + 1, int(tgt_end)) if has_target_window else 0

            def _load_entries(start_pos: int, end_pos: int) -> List[Tuple[int, int, str]]:
                s = max(0, int(start_pos))
                e = min(chain_len, int(end_pos))
                if e <= s:
                    return []
                return bw.entries(chain_chrom, s, e) or []

            if indexed_side == "reference":
                query_ref_start = max(0, int(ref_s))
                query_ref_end = min(chain_len, int(ref_e))
                if query_ref_end <= query_ref_start:
                    query_ref_end = min(chain_len, query_ref_start + 1)
                raw_entries = _load_entries(query_ref_start, query_ref_end)
            else:
                if has_target_window:
                    query_tgt_start = max(0, int(tgt_start))
                    query_tgt_end = min(chain_len, int(tgt_end))
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)
                else:
                    # Heuristic seed around the same numeric locus as reference.
                    # This avoids scanning full chromosome on first draw and keeps panning responsive.
                    pad = max(250000, int(ref_span * 2.0))
                    center_guess = (ref_s + ref_e) // 2
                    query_tgt_start = max(0, center_guess - pad)
                    query_tgt_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)

            def _entries_to_blocks(entries: List[Tuple[int, int, str]]) -> List[dict]:
                parsed_blocks: List[dict] = []
                for chrom_start, chrom_end, rest in entries:
                    parsed = sv_datasets._parse_bigchain_entry_rest(rest)
                    if not parsed:
                        continue

                    if indexed_side == "reference":
                        # In this mode, BigChain bed coordinates are on the reference side.
                        if str(parsed["ref_seq"]) != str(tgt_seq):
                            continue
                        ref_block_start = int(chrom_start)
                        ref_block_end = int(chrom_end)
                        tgt_block_start = int(parsed["ref_start"])
                        tgt_block_end = int(parsed["ref_end"])
                    else:
                        # In this mode, BigChain bed coordinates are on the target side.
                        if str(parsed["ref_seq"]) != str(ref_seq):
                            continue
                        ref_block_start = int(parsed["ref_start"])
                        ref_block_end = int(parsed["ref_end"])
                        tgt_block_start = int(chrom_start)
                        tgt_block_end = int(chrom_end)

                    if ref_block_end < ref_block_start:
                        ref_block_start, ref_block_end = ref_block_end, ref_block_start
                    if tgt_block_end < tgt_block_start:
                        tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                    if ref_block_end < ref_s or ref_block_start > ref_e:
                        continue
                    tgt_span = max(1, tgt_block_end - tgt_block_start)
                    ref_block_span = max(1, ref_block_end - ref_block_start)
                    block_type = sv_datasets._classify_sv_block(parsed["strand"], tgt_span, ref_block_span)

                    parsed_blocks.append(
                        {
                            "chain_id": parsed["chain_id"],
                            "score": parsed["score"],
                            "strand": parsed["strand"],
                            "ref_start": ref_block_start,
                            "ref_end": ref_block_end,
                            "tgt_start": tgt_block_start,
                            "tgt_end": tgt_block_end,
                            "target_span": tgt_span,
                            "ref_span": ref_block_span,
                            "type": block_type,
                        }
                    )
                parsed_blocks.sort(key=lambda b: (b["ref_start"], b["tgt_start"]))
                return parsed_blocks

            blocks = _entries_to_blocks(raw_entries)
            segments = sv_datasets._build_sv_segments(blocks, ref_span)
            feature_blocks = sv_datasets._build_sv_feature_blocks(blocks, ref_span)
            if not has_target_window and not blocks:
                # Fallback wider fetch once if the seeded indexed window missed mappings.
                pad = max(1000000, int(ref_span * 5.0))
                center_guess = (ref_s + ref_e) // 2
                if indexed_side == "reference":
                    query_ref_start = max(0, center_guess - pad)
                    query_ref_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_ref_start, query_ref_end)
                else:
                    query_tgt_start = max(0, center_guess - pad)
                    query_tgt_end = min(chain_len, center_guess + pad)
                    raw_entries = _load_entries(query_tgt_start, query_tgt_end)
                blocks = _entries_to_blocks(raw_entries)
                segments = sv_datasets._build_sv_segments(blocks, ref_span)
                feature_blocks = sv_datasets._build_sv_feature_blocks(blocks, ref_span)

            # Keep the target window large enough to include all mapped blocks in the
            # current reference window. This prevents flanking match blocks from
            # disappearing after an inversion-focused drag/zoom.
            if blocks:
                min_t = min(int(b["tgt_start"]) for b in blocks)
                max_t = max(int(b["tgt_end"]) for b in blocks)
                query_tgt_start = min(int(query_tgt_start), int(min_t))
                query_tgt_end = max(int(query_tgt_end), int(max_t))
            max_blocks_limit = max(200, min(5000, int(max_blocks)))
            if len(blocks) > max_blocks_limit:
                step = max(1, len(blocks) // max_blocks_limit)
                blocks = blocks[::step][:max_blocks_limit]

            if not has_target_window:
                if blocks:
                    min_t = min(b["tgt_start"] for b in blocks)
                    max_t = max(b["tgt_end"] for b in blocks)
                    pad = max(10000, int((max_t - min_t) * 0.15))
                    query_tgt_start = max(0, min_t - pad)
                    query_tgt_end = max_t + pad
                else:
                    query_tgt_start = 0
                    query_tgt_end = max(1, ref_span)

            if query_tgt_end <= query_tgt_start:
                query_tgt_end = min(chain_len, query_tgt_start + 1)

            ref_display = ref_map["assembly_to_hal"].get(str(ref_seq), str(ref_seq))
            tgt_display = tgt_map["assembly_to_hal"].get(str(tgt_seq), str(tgt_seq))

            ref_db_chrom = (
                genome_context._resolve_db_chrom_name_for_genome(ref_db_path, ref_chrom, resolved_ref_browse_genome)
                or genome_context._resolve_db_chrom_name_for_genome(ref_db_path, ref_display, resolved_ref_browse_genome)
                or genome_context._resolve_db_chrom_name_for_genome(ref_db_path, str(ref_seq), resolved_ref_browse_genome)
                or ref_chrom
            )
            tgt_db_chrom = (
                genome_context._resolve_db_chrom_name_for_genome(tgt_db_path, tgt_chrom, resolved_tgt_browse_genome) if tgt_chrom else None
            ) or genome_context._resolve_db_chrom_name_for_genome(tgt_db_path, tgt_display, resolved_tgt_browse_genome) or genome_context._resolve_db_chrom_name_for_genome(tgt_db_path, str(tgt_seq), resolved_tgt_browse_genome) or tgt_display

            ref_fasta_chrom, ref_chrom_length = genome_context._resolve_genome_chrom_length(
                resolved_ref_browse_genome,
                ref_db_chrom,
                ref_chrom,
                ref_display,
                str(ref_seq),
            )
            tgt_fasta_chrom, tgt_chrom_length = genome_context._resolve_genome_chrom_length(
                resolved_tgt_browse_genome,
                tgt_db_chrom,
                tgt_chrom,
                tgt_display,
                str(tgt_seq),
            )
            # Fall back to bigchain chromosome length when FASTA is not configured
            if ref_chrom_length == 0 and indexed_side == "reference":
                ref_chrom_length = chain_len
            if tgt_chrom_length == 0 and indexed_side == "target":
                tgt_chrom_length = chain_len
            ref_chrom_sizes = sv_datasets._build_sv_chrom_size_aliases(
                ref_chrom_length,
                ref_db_chrom,
                ref_chrom,
                ref_display,
                str(ref_seq),
                ref_fasta_chrom,
            )
            tgt_chrom_sizes = sv_datasets._build_sv_chrom_size_aliases(
                tgt_chrom_length,
                tgt_db_chrom,
                tgt_chrom,
                tgt_display,
                str(tgt_seq),
                tgt_fasta_chrom,
            )

            def _gene_limit(s, e):
                span = max(1, e - s)
                if span <= 500_000:
                    return 1200
                if span <= 5_000_000:
                    return 400
                return 150

            ref_genes = sv_datasets._fetch_genes_for_window(ref_db_path, ref_db_chrom, ref_s, ref_e, limit=_gene_limit(ref_s, ref_e))
            tgt_genes = sv_datasets._fetch_genes_for_window(tgt_db_path, tgt_db_chrom, query_tgt_start, query_tgt_end, limit=_gene_limit(query_tgt_start, query_tgt_end))

            return {
                "supported": True,
                "detail": "",
                "alignment_id": str(dataset.get("id") or dataset.get("alignment_id") or ""),
                "dataset_label": dataset.get("label", "Structural variation"),
                "ref_chrom": ref_db_chrom,
                "ref_display_chrom": ref_display,
                "ref_sequence": str(ref_seq),
                "ref_chrom_length": int(ref_chrom_length),
                "ref_chrom_sizes": ref_chrom_sizes,
                "ref_start": ref_s,
                "ref_end": ref_e,
                "tgt_chrom": tgt_db_chrom,
                "tgt_display_chrom": tgt_display,
                "tgt_sequence": str(tgt_seq),
                "tgt_chrom_length": int(tgt_chrom_length),
                "tgt_chrom_sizes": tgt_chrom_sizes,
                "tgt_start": int(query_tgt_start),
                "tgt_end": int(query_tgt_end),
                "tracks": sv_datasets._sv_public_data_tracks(dataset),
                "blocks": blocks,
                "segments": segments,
                "feature_blocks": feature_blocks,
                "ref_genes": ref_genes,
                "tgt_genes": tgt_genes,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


def _parse_sv_viewport(viewport: str):
    """Parse '{chrom}:{start}-{end}' into (chrom, start, end) or None."""
    if not viewport:
        return None
    colon = viewport.find(":")
    if colon < 1:
        return None
    chrom = viewport[:colon]
    rest = viewport[colon + 1:]
    dash = rest.find("-")
    if dash < 0:
        return None
    try:
        start = int(rest[:dash])
        end = int(rest[dash + 1:])
    except ValueError:
        return None
    if end <= start:
        return None
    return chrom, start, end


def _sv_ranges_overlap(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return end_a > start_b and end_b > start_a


def _sv_expand_range(start: int, end: int, min_start: int = 0, pad_ratio: float = 1.5, min_pad: int = 500_000) -> Tuple[int, int]:
    span = max(1, int(end) - int(start))
    pad = max(int(min_pad), int(span * pad_ratio))
    expanded_start = max(int(min_start), int(start) - pad)
    expanded_end = int(end) + pad
    return expanded_start, expanded_end


@router.get("/api/sv/alignments")
async def sv_alignments(
    reference_genome_id: str = "",
    alt_genome_id: str = "",
    reference_viewport: str = "",
    alt_viewport: str = "",
    query_side: str = "",
    alignment_id: str = "",
    output_dir: str = "",
):
    """Return Alignment[] objects for the Beta ens-sv-alignments web component."""
    if pyBigWig is None:
        return []

    use_ref_vp = _parse_sv_viewport(reference_viewport)
    use_alt_vp = _parse_sv_viewport(alt_viewport)
    if not use_ref_vp and not use_alt_vp:
        return []

    dataset = sv_datasets._select_sv_dataset(
        reference_genome_id,
        alt_genome_id,
        alignment_id=alignment_id,
        output_dir=sv_datasets._sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return []

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, _missing = sv_datasets._sv_dataset_file_status(dataset)
        if not supported:
            return []

        ref_map = sv_datasets._sv_side_mapping(dataset, "reference")
        tgt_map = sv_datasets._sv_side_mapping(dataset, "target")
        indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()

        ref_query_chrom = use_ref_vp[0] if use_ref_vp else ""
        tgt_query_chrom = use_alt_vp[0] if use_alt_vp else ""
        ref_query_start = int(use_ref_vp[1]) if use_ref_vp else 0
        ref_query_end = int(use_ref_vp[2]) if use_ref_vp else 0
        tgt_query_start = int(use_alt_vp[1]) if use_alt_vp else 0
        tgt_query_end = int(use_alt_vp[2]) if use_alt_vp else 0

        ref_seq = sv_datasets._resolve_sv_sequence(ref_map, ref_query_chrom) or sv_datasets._resolve_sv_sequence(ref_map, tgt_query_chrom)
        tgt_seq = sv_datasets._resolve_sv_sequence(tgt_map, tgt_query_chrom) or sv_datasets._resolve_sv_sequence(tgt_map, ref_query_chrom)

        normalized_query_side = str(query_side or "").strip().lower()
        preferred_ref_query = normalized_query_side == "reference"
        preferred_alt_query = normalized_query_side == "alt"

        if preferred_ref_query and use_ref_vp:
            query_chrom, query_start, query_end = use_ref_vp
            is_ref_query = True
        elif preferred_alt_query and use_alt_vp:
            query_chrom, query_start, query_end = use_alt_vp
            is_ref_query = False
        elif indexed_side == "reference":
            if use_ref_vp:
                query_chrom, query_start, query_end = use_ref_vp
                is_ref_query = True
            elif use_alt_vp:
                query_chrom, query_start, query_end = use_alt_vp
                is_ref_query = False
            else:
                return []
        else:
            if use_alt_vp:
                query_chrom, query_start, query_end = use_alt_vp
                is_ref_query = False
            elif use_ref_vp:
                query_chrom, query_start, query_end = use_ref_vp
                is_ref_query = True
            else:
                return []

        # Determine which chromosome name to look up depending on query side.
        if is_ref_query:
            lookup_seq = ref_seq
        else:
            lookup_seq = tgt_seq or ref_seq

        if not lookup_seq:
            return []

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return []
        if bw is None:
            return []

        try:
            chrom_sizes = bw.chroms() or {}

            # Resolve the sequence name used in the BigChain index.
            if indexed_side == "reference":
                chain_seq = ref_seq or lookup_seq
            else:
                chain_seq = tgt_seq or lookup_seq

            chain_chrom = genome_context._resolve_bigwig_chrom_name(chain_seq, chrom_sizes)
            if not chain_chrom:
                return []

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return []

            indexed_query_side = "reference" if indexed_side == "reference" else "alt"
            requested_span = max(
                1,
                int(ref_query_end - ref_query_start) if is_ref_query else int(tgt_query_end - tgt_query_start),
            )
            cross_index_query = (indexed_side == "reference") != is_ref_query

            if cross_index_query and requested_span <= 250_000:
                # For sequence-level colouring, the queried side can be the non-indexed
                # side of the BigChain. A stale or inverted opposite viewport can miss
                # the relevant blocks, so scan the indexed chromosome and filter below.
                q_s = 0
                q_e = chain_len
            elif indexed_side == "reference" and use_ref_vp:
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
            elif indexed_side != "reference" and use_alt_vp:
                q_s = max(0, int(tgt_query_start))
                q_e = min(chain_len, int(tgt_query_end))
            else:
                q_s = max(0, query_start)
                q_e = min(chain_len, query_end)
                if q_e <= q_s:
                    return []

                # When we don't have the indexed-side viewport, seed around the
                # same numeric locus as a fallback.
                if (indexed_side == "reference") != is_ref_query:
                    span = max(1, q_e - q_s)
                    pad = max(250_000, int(span * 2.0))
                    center = (q_s + q_e) // 2
                    q_s = max(0, center - pad)
                    q_e = min(chain_len, center + pad)

            if q_e <= q_s:
                return []

            if normalized_query_side and normalized_query_side != indexed_query_side and not (
                cross_index_query and requested_span <= 250_000
            ):
                cross_query_span = max(
                    1,
                    int(ref_query_end - ref_query_start) if normalized_query_side == "reference" else int(tgt_query_end - tgt_query_start),
                )
                q_s, q_e = _sv_expand_range(
                    q_s,
                    q_e,
                    1 if indexed_side == "reference" else 0,
                    pad_ratio=4.0,
                    min_pad=max(1_000_000, cross_query_span * 3),
                )
                q_e = min(chain_len, int(q_e))

            raw_entries = bw.entries(chain_chrom, q_s, q_e) or []

            ref_seq_for_filter = ref_seq or ""
            tgt_seq_for_filter = tgt_seq or lookup_seq or ""

            alignments = []
            seen_ids: set = set()
            for chrom_start, chrom_end, rest in raw_entries:
                parsed = sv_datasets._parse_bigchain_entry_rest(rest)
                if not parsed:
                    continue

                if indexed_side == "reference":
                    if str(parsed["ref_seq"]) != str(tgt_seq_for_filter):
                        continue
                    ref_block_start = int(chrom_start)
                    ref_block_end = int(chrom_end)
                    tgt_block_start = int(parsed["ref_start"])
                    tgt_block_end = int(parsed["ref_end"])
                    ref_chrom_name = str(chain_seq)
                    tgt_chrom_name = str(parsed["ref_seq"])
                else:
                    if str(parsed["ref_seq"]) != str(ref_seq_for_filter):
                        continue
                    ref_block_start = int(parsed["ref_start"])
                    ref_block_end = int(parsed["ref_end"])
                    tgt_block_start = int(chrom_start)
                    tgt_block_end = int(chrom_end)
                    ref_chrom_name = str(parsed["ref_seq"])
                    tgt_chrom_name = str(chain_seq)

                if ref_block_end < ref_block_start:
                    ref_block_start, ref_block_end = ref_block_end, ref_block_start
                if tgt_block_end < tgt_block_start:
                    tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                if is_ref_query:
                    if not _sv_ranges_overlap(ref_block_start, ref_block_end, query_start, query_end):
                        continue
                elif not _sv_ranges_overlap(tgt_block_start, tgt_block_end, query_start, query_end):
                    continue

                ref_visible = False
                alt_visible = False
                if use_ref_vp:
                    relaxed_ref_start, relaxed_ref_end = _sv_expand_range(
                        ref_query_start,
                        ref_query_end,
                        1,
                        pad_ratio=1.0,
                        min_pad=max(250_000, int((ref_query_end - ref_query_start) * 0.5)),
                    )
                    ref_visible = _sv_ranges_overlap(ref_block_start, ref_block_end, relaxed_ref_start, relaxed_ref_end)
                if use_alt_vp:
                    relaxed_tgt_start, relaxed_tgt_end = _sv_expand_range(
                        tgt_query_start,
                        tgt_query_end,
                        0,
                        pad_ratio=1.0,
                        min_pad=max(250_000, int((tgt_query_end - tgt_query_start) * 0.5)),
                    )
                    alt_visible = _sv_ranges_overlap(tgt_block_start, tgt_block_end, relaxed_tgt_start, relaxed_tgt_end)

                if use_ref_vp and use_alt_vp:
                    if not (ref_visible or alt_visible):
                        continue
                elif use_ref_vp and not ref_visible:
                    continue
                elif use_alt_vp and not alt_visible:
                    continue

                ref_len = max(1, ref_block_end - ref_block_start)
                tgt_len = max(1, tgt_block_end - tgt_block_start)
                strand = str(parsed.get("strand") or "+")
                alt_strand = "reverse" if strand == "-" else "forward"

                aln_id = f"{parsed['chain_id']}:{ref_block_start}:{tgt_block_start}"
                if aln_id in seen_ids:
                    continue
                seen_ids.add(aln_id)

                # Resolve user-facing chromosome names from the mapping tables.
                ref_display = ref_map["hal_to_assembly"].get(ref_chrom_name, ref_chrom_name)
                tgt_display = tgt_map["hal_to_assembly"].get(tgt_chrom_name, tgt_chrom_name)

                alignments.append({
                    "id": aln_id,
                    "reference": {
                        "region_name": ref_display,
                        "start": ref_block_start,
                        "strand": "forward",
                        "length": ref_len,
                    },
                    "alt": {
                        "region_name": tgt_display,
                        "start": tgt_block_start,
                        "strand": alt_strand,
                        "length": tgt_len,
                    },
                })

            alignments.sort(key=lambda a: a["reference"]["start"])
            return alignments

        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


@router.get("/api/sv/variants")
async def sv_variants(
    reference_genome_id: str = "",
    alt_genome_id: str = "",
    viewport: str = "",
    reference_viewport: str = "",
    alt_viewport: str = "",
    alignment_id: str = "",
    output_dir: str = "",
):
    """Return haplotype-variant markers derived from local chain gaps."""
    if pyBigWig is None:
        return []

    ref_viewport = _parse_sv_viewport(reference_viewport) or _parse_sv_viewport(viewport)
    tgt_viewport = _parse_sv_viewport(alt_viewport)
    if not ref_viewport and not tgt_viewport:
        return []

    dataset = sv_datasets._select_sv_dataset(
        reference_genome_id,
        alt_genome_id,
        alignment_id=alignment_id,
        output_dir=sv_datasets._sv_effective_output_dir(output_dir),
    )
    if not dataset:
        return []

    def _query():
        chain_path: Path = dataset["chain_path"]

        supported, _missing = sv_datasets._sv_dataset_file_status(dataset)
        if not supported:
            return []

        ref_map = sv_datasets._sv_side_mapping(dataset, "reference")
        tgt_map = sv_datasets._sv_side_mapping(dataset, "target")
        indexed_side = str(dataset.get("indexed_side") or "target").strip().lower()

        ref_query_chrom = ref_viewport[0] if ref_viewport else ""
        ref_query_start = int(ref_viewport[1]) if ref_viewport else 0
        ref_query_end = int(ref_viewport[2]) if ref_viewport else 0
        tgt_query_chrom = tgt_viewport[0] if tgt_viewport else ""
        tgt_query_start = int(tgt_viewport[1]) if tgt_viewport else 0
        tgt_query_end = int(tgt_viewport[2]) if tgt_viewport else 0

        ref_seq = sv_datasets._resolve_sv_sequence(ref_map, ref_query_chrom)
        tgt_seq = sv_datasets._resolve_sv_sequence(tgt_map, tgt_query_chrom) if tgt_query_chrom else sv_datasets._resolve_sv_sequence(tgt_map, ref_query_chrom)
        if not ref_seq:
            return []

        try:
            bw = pyBigWig.open(str(chain_path))
        except Exception:
            return []
        if bw is None:
            return []

        try:
            chrom_sizes = bw.chroms() or {}
            chain_seq = ref_seq if indexed_side == "reference" else (tgt_seq or str(ref_seq))

            chain_chrom = genome_context._resolve_bigwig_chrom_name(chain_seq, chrom_sizes)
            if not chain_chrom:
                return []

            chain_len = int(chrom_sizes.get(chain_chrom, 0))
            if chain_len <= 0:
                return []

            if indexed_side == "reference":
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
            elif tgt_viewport:
                q_s = max(0, int(tgt_query_start))
                q_e = min(chain_len, int(tgt_query_end))
            else:
                q_s = max(0, int(ref_query_start))
                q_e = min(chain_len, int(ref_query_end))
                span = max(1, q_e - q_s)
                pad = max(250_000, int(span * 2.0))
                center = (q_s + q_e) // 2
                q_s = max(0, center - pad)
                q_e = min(chain_len, center + pad)

            if q_e <= q_s:
                return []

            raw_entries = bw.entries(chain_chrom, q_s, q_e) or []
            blocks: List[Dict[str, Any]] = []

            for chrom_start, chrom_end, rest in raw_entries:
                parsed = sv_datasets._parse_bigchain_entry_rest(rest)
                if not parsed:
                    continue

                if indexed_side == "reference":
                    if tgt_seq and str(parsed["ref_seq"]) != str(tgt_seq):
                        continue
                    ref_block_start = int(chrom_start)
                    ref_block_end = int(chrom_end)
                    tgt_block_start = int(parsed["ref_start"])
                    tgt_block_end = int(parsed["ref_end"])
                    tgt_seq_name = str(parsed["ref_seq"])
                else:
                    if str(parsed["ref_seq"]) != str(ref_seq):
                        continue
                    ref_block_start = int(parsed["ref_start"])
                    ref_block_end = int(parsed["ref_end"])
                    tgt_block_start = int(chrom_start)
                    tgt_block_end = int(chrom_end)
                    tgt_seq_name = chain_seq

                if ref_block_end < ref_block_start:
                    ref_block_start, ref_block_end = ref_block_end, ref_block_start
                if tgt_block_end < tgt_block_start:
                    tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

                if ref_viewport and not _sv_ranges_overlap(ref_block_start, ref_block_end, ref_query_start, ref_query_end):
                    continue
                if tgt_viewport and not _sv_ranges_overlap(tgt_block_start, tgt_block_end, tgt_query_start, tgt_query_end):
                    continue

                tgt_span = max(1, tgt_block_end - tgt_block_start)
                ref_span = max(1, ref_block_end - ref_block_start)
                blocks.append(
                    {
                        "chain_id": parsed["chain_id"],
                        "score": parsed["score"],
                        "strand": parsed["strand"],
                        "ref_start": ref_block_start,
                        "ref_end": ref_block_end,
                        "tgt_start": tgt_block_start,
                        "tgt_end": tgt_block_end,
                        "target_span": tgt_span,
                        "ref_span": ref_span,
                        "type": sv_datasets._classify_sv_block(parsed["strand"], tgt_span, ref_span),
                        "tgt_seq": tgt_seq_name,
                    }
                )

            ref_display = ref_map["hal_to_assembly"].get(str(ref_seq), ref_query_chrom)
            return sv_datasets._build_sv_gap_variants(
                blocks=blocks,
                ref_chrom=ref_display,
                ref_start=int(ref_query_start),
                ref_end=int(ref_query_end),
            )
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)
