#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from taxonomy_classifier import ANCHOR_TAXIDS, TaxonomyLineageClassifier  # noqa: E402


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _catalog_fingerprint(payload: Dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


def _read_catalog(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict) or not isinstance(payload.get("species"), dict):
        raise ValueError(f"{path} is not a valid Ensembl species catalog")
    return payload


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _catalog_taxids(catalog: Dict[str, Any]) -> List[int]:
    out = set()
    for info in (catalog.get("species") or {}).values():
        if not isinstance(info, dict):
            continue
        for field in ("species_taxonomy_id", "taxid"):
            taxid = _int_or_zero(info.get(field))
            if taxid:
                out.add(taxid)
    return sorted(out)


def _split_dmp_line(line: str) -> List[str]:
    return [part.strip() for part in line.rstrip("\n").split("|")]


def _iter_taxdump_member_lines(taxdump_path: Path, member_name: str):
    with tarfile.open(taxdump_path, "r:*") as archive:
        member = archive.getmember(member_name)
        extracted = archive.extractfile(member)
        if extracted is None:
            raise ValueError(f"{member_name} could not be read from {taxdump_path}")
        for raw_line in extracted:
            yield raw_line.decode("utf-8", errors="replace")


def _load_nodes(taxdump_path: Path) -> Tuple[Dict[int, int], Dict[int, str]]:
    parents: Dict[int, int] = {}
    ranks: Dict[int, str] = {}
    for line in _iter_taxdump_member_lines(taxdump_path, "nodes.dmp"):
        parts = _split_dmp_line(line)
        if len(parts) < 3:
            continue
        taxid = _int_or_zero(parts[0])
        parent = _int_or_zero(parts[1])
        if not taxid:
            continue
        parents[taxid] = parent
        ranks[taxid] = parts[2]
    return parents, ranks


def _load_merged(taxdump_path: Path) -> Dict[int, int]:
    merged: Dict[int, int] = {}
    try:
        lines = _iter_taxdump_member_lines(taxdump_path, "merged.dmp")
        for line in lines:
            parts = _split_dmp_line(line)
            if len(parts) < 2:
                continue
            old_taxid = _int_or_zero(parts[0])
            new_taxid = _int_or_zero(parts[1])
            if old_taxid and new_taxid:
                merged[old_taxid] = new_taxid
    except KeyError:
        pass
    return merged


def _load_scientific_names(taxdump_path: Path, wanted_taxids: Iterable[int]) -> Dict[int, str]:
    wanted = {int(value) for value in wanted_taxids if int(value or 0)}
    names: Dict[int, str] = {}
    if not wanted:
        return names
    for line in _iter_taxdump_member_lines(taxdump_path, "names.dmp"):
        parts = _split_dmp_line(line)
        if len(parts) < 4:
            continue
        taxid = _int_or_zero(parts[0])
        if taxid not in wanted or parts[3] != "scientific name":
            continue
        names[taxid] = parts[1]
    return names


def _resolve_taxid(taxid: int, merged: Dict[int, int]) -> int:
    seen = set()
    current = taxid
    while current in merged and current not in seen:
        seen.add(current)
        current = merged[current]
    return current


def _lineage_for_taxid(taxid: int, parents: Dict[int, int], merged: Dict[int, int]) -> List[int]:
    resolved = _resolve_taxid(taxid, merged)
    if resolved not in parents:
        return []
    lineage: List[int] = []
    seen = set()
    current = resolved
    while current and current not in seen:
        seen.add(current)
        lineage.append(current)
        parent = parents.get(current)
        if not parent or parent == current:
            break
        current = parent
    return list(reversed(lineage))


def _build_artifact(catalog_path: Path, taxdump_path: Path) -> Dict[str, Any]:
    catalog = _read_catalog(catalog_path)
    requested_taxids = _catalog_taxids(catalog)
    required_taxids = sorted(set(requested_taxids).union(ANCHOR_TAXIDS))
    parents, ranks = _load_nodes(taxdump_path)
    merged = _load_merged(taxdump_path)

    taxid_records: Dict[str, Dict[str, Any]] = {}
    lineage_taxids = set()
    missing_taxids = []
    for taxid in required_taxids:
        resolved = _resolve_taxid(taxid, merged)
        lineage = _lineage_for_taxid(taxid, parents, merged)
        if not lineage:
            missing_taxids.append(taxid)
            continue
        lineage_taxids.update(lineage)
        taxid_records[str(taxid)] = {
            "resolved_taxid": resolved,
            "lineage": lineage,
            "rank": ranks.get(resolved, ""),
        }

    names = _load_scientific_names(taxdump_path, lineage_taxids.union(required_taxids))
    for record in taxid_records.values():
        resolved = _int_or_zero(record.get("resolved_taxid"))
        record["scientific_name"] = names.get(resolved, "")

    merged_subset = {
        str(old): new
        for old, new in sorted(merged.items())
        if old in required_taxids or new in required_taxids
    }

    artifact = {
        "schema_version": 1,
        "metadata": {
            "generated_at": _now_iso_utc(),
            "generator": "backend/scripts/generate_taxonomy_classification.py",
            # Filenames only: these are informational, and the absolute build
            # paths they used to hold leaked the operator's home directory into a
            # tracked artifact.
            "source_catalog": Path(catalog_path).name,
            "source_catalog_fingerprint": _catalog_fingerprint(catalog),
            "source_catalog_last_updated": str(catalog.get("last_updated") or ""),
            "source_taxdump": Path(taxdump_path).name,
        },
        "coverage": {
            "catalog_species_count": len(catalog.get("species") or {}),
            "requested_taxid_count": len(requested_taxids),
            "required_taxid_count": len(required_taxids),
            "lineage_record_count": len(taxid_records),
            "lineage_taxid_count": len(lineage_taxids),
            "missing_taxid_count": len(missing_taxids),
            "missing_taxids": missing_taxids[:200],
        },
        "anchor_taxids": ANCHOR_TAXIDS,
        "merged_taxids": merged_subset,
        "taxids": taxid_records,
    }
    return artifact


def _audit_catalog(catalog_path: Path, artifact: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _read_catalog(catalog_path)
    classifier = TaxonomyLineageClassifier(artifact=artifact)
    new_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    other_samples: List[Dict[str, Any]] = []
    legacy_other_count = 0

    try:
        from download_manager import _classify_species  # noqa: WPS433
    except Exception:
        _classify_species = None

    for key, info in (catalog.get("species") or {}).items():
        scientific_name = str((info or {}).get("scientific_name") or key)
        common_name = str((info or {}).get("common_name") or "")
        taxid = _int_or_zero((info or {}).get("taxid"))
        species_taxonomy_id = _int_or_zero((info or {}).get("species_taxonomy_id"))
        fallback = _classify_species if _classify_species is not None else None
        result = classifier.classify(scientific_name, common_name, taxid, species_taxonomy_id, fallback_classifier=fallback)
        new_counts[result.group] += 1
        source_counts[result.source] += 1
        if result.group == "Other" and len(other_samples) < 20:
            other_samples.append({
                "key": key,
                "scientific_name": scientific_name,
                "common_name": common_name,
                "taxid": taxid,
                "species_taxonomy_id": species_taxonomy_id,
                "source": result.source,
            })
        if _classify_species is not None:
            legacy_group, _legacy_sub_group = _classify_species(scientific_name, common_name, taxid, species_taxonomy_id)
            if legacy_group == "Other":
                legacy_other_count += 1

    return {
        "species_count": len(catalog.get("species") or {}),
        "legacy_other_count": legacy_other_count,
        "new_other_count": new_counts.get("Other", 0),
        "new_group_counts": dict(sorted(new_counts.items())),
        "classification_source_counts": dict(sorted(source_counts.items())),
        "other_samples": other_samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate compact taxonomy lineage data for Ensembl download groups.")
    parser.add_argument("--catalog", type=Path, default=BACKEND_DIR / "cache" / "remote_species_catalog.json")
    parser.add_argument("--taxdump", type=Path, required=True, help="Path to NCBI taxdump.tar.gz.")
    parser.add_argument("--output", type=Path, default=BACKEND_DIR / "data" / "taxonomy_classification.json")
    parser.add_argument("--audit-only", action="store_true", help="Build and audit but do not write the artifact.")
    args = parser.parse_args()

    artifact = _build_artifact(args.catalog, args.taxdump)
    audit = _audit_catalog(args.catalog, artifact)
    artifact["audit"] = audit

    if not args.audit_only:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "output": str(args.output),
        "wrote": not args.audit_only,
        "coverage": artifact.get("coverage", {}),
        "audit": audit,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
