import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


SPECIES_NAME_POLICY_VERSION = 1
PROKARYOTE_GROUPS = {"bacteria", "archaea"}


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_common_name(value: Any) -> str:
    token = str(value or "").strip().lower()
    if not token:
        return ""
    token = token.replace("&", " and ")
    token = re.sub(r"['’]", "", token)
    token = re.sub(r"[^a-z0-9]+", " ", token)
    token = re.sub(r"\s+", " ", token).strip()
    return token


def species_record_key(record: Dict[str, Any]) -> str:
    provider = str(record.get("provider") or "ensembl").strip().lower() or "ensembl"
    key = str(record.get("key") or record.get("species_key") or "").strip()
    return f"{provider}::{key}" if key else ""


def is_prokaryote_record(record: Dict[str, Any]) -> bool:
    group = str(record.get("group") or "").strip().lower()
    sub_group = str(record.get("sub_group") or "").strip().lower()
    return group in PROKARYOTE_GROUPS or sub_group in PROKARYOTE_GROUPS


def species_record_from_summary(summary: Any) -> Dict[str, Any]:
    getter = summary.get if isinstance(summary, dict) else lambda key, default=None: getattr(summary, key, default)
    return {
        "key": str(getter("key", "") or "").strip(),
        "provider": str(getter("provider", "ensembl") or "ensembl").strip().lower(),
        "scientific_name": str(getter("scientific_name", "") or "").strip(),
        "common_name": str(getter("common_name", "") or "").strip(),
        "taxid": int(getter("taxid", 0) or 0),
        "species_taxonomy_id": int(getter("species_taxonomy_id", 0) or 0),
        "group": str(getter("group", "") or "").strip(),
        "sub_group": str(getter("sub_group", "") or "").strip(),
    }


def catalog_fingerprint(payload: Dict[str, Any]) -> str:
    encoded = json.dumps(payload or {}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


def build_species_name_policy(
    records: Iterable[Dict[str, Any]],
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    normalized_records = [dict(record) for record in records if isinstance(record, dict)]

    common_to_species: Dict[str, Dict[str, Any]] = {}
    species_by_common: Dict[str, set] = defaultdict(set)
    raw_names_by_common: Dict[str, set] = defaultdict(set)
    for record in normalized_records:
        common_name = str(record.get("common_name") or "").strip()
        scientific_name = str(record.get("scientific_name") or "").strip()
        normalized_common = normalize_common_name(common_name)
        if not normalized_common or not scientific_name:
            continue
        species_by_common[normalized_common].add(scientific_name.lower())
        raw_names_by_common[normalized_common].add(common_name)

    ambiguous_common_names: Dict[str, Dict[str, Any]] = {}
    for normalized_common, scientific_names in species_by_common.items():
        if len(scientific_names) <= 1:
            continue
        display_common = sorted(raw_names_by_common[normalized_common], key=lambda item: (len(item), item.lower()))[0]
        original_scientific_names = sorted(
            {
                str(record.get("scientific_name") or "").strip()
                for record in normalized_records
                if normalize_common_name(record.get("common_name")) == normalized_common
            },
            key=lambda item: item.lower(),
        )
        ambiguous_common_names[normalized_common] = {
            "common_name": display_common,
            "species_count": len(scientific_names),
            "scientific_names": original_scientific_names,
        }

    species_overrides: Dict[str, Dict[str, str]] = {}
    taxid_overrides: Dict[str, Dict[str, str]] = {}
    for record in normalized_records:
        scientific_name = str(record.get("scientific_name") or "").strip()
        if not scientific_name:
            continue
        normalized_common = normalize_common_name(record.get("common_name"))
        reason = ""
        if is_prokaryote_record(record):
            reason = "prokaryote"
        elif normalized_common and normalized_common in ambiguous_common_names:
            reason = "ambiguous_common"
        if not reason:
            continue

        override = {"display_name": scientific_name, "reason": reason}
        key = species_record_key(record)
        if key:
            species_overrides[key] = override
        for taxid_key in ("taxid", "species_taxonomy_id"):
            taxid = int(record.get(taxid_key) or 0)
            if taxid:
                taxid_overrides[str(taxid)] = override

    source_meta = dict(metadata or {})
    source_meta.update(
        {
            "generated_at": source_meta.get("generated_at") or now_iso_utc(),
            "record_count": len(normalized_records),
            "ambiguous_common_name_count": len(ambiguous_common_names),
            "species_override_count": len(species_overrides),
        }
    )
    return {
        "version": SPECIES_NAME_POLICY_VERSION,
        "metadata": source_meta,
        "ambiguous_common_names": dict(sorted(ambiguous_common_names.items())),
        "species_overrides": dict(sorted(species_overrides.items())),
        "taxid_overrides": dict(sorted(taxid_overrides.items())),
    }


def load_species_name_policy(path: Path) -> Dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    if int(payload.get("version") or 0) != SPECIES_NAME_POLICY_VERSION:
        return {}
    return payload


def save_species_name_policy(path: Path, policy: Dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(policy, indent=2, sort_keys=True), encoding="utf-8")


def preferred_species_display_name(record: Dict[str, Any], policy: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    scientific_name = str(record.get("scientific_name") or record.get("key") or record.get("species_key") or "").strip()
    common_name = str(record.get("common_name") or "").strip()
    resolved_policy = policy if isinstance(policy, dict) else {}

    if is_prokaryote_record(record):
        return {"display_name": scientific_name or common_name, "display_name_reason": "prokaryote"}

    if not common_name:
        return {"display_name": scientific_name, "display_name_reason": "missing_common"}

    key = species_record_key(record)
    override = (resolved_policy.get("species_overrides") or {}).get(key) if key else None
    if isinstance(override, dict) and override.get("display_name"):
        return {
            "display_name": str(override.get("display_name") or scientific_name),
            "display_name_reason": str(override.get("reason") or "species_override"),
        }

    for taxid_key in ("taxid", "species_taxonomy_id"):
        taxid = int(record.get(taxid_key) or 0)
        override = (resolved_policy.get("taxid_overrides") or {}).get(str(taxid)) if taxid else None
        if isinstance(override, dict) and override.get("display_name"):
            return {
                "display_name": str(override.get("display_name") or scientific_name),
                "display_name_reason": str(override.get("reason") or "taxid_override"),
            }

    normalized_common = normalize_common_name(common_name)
    if normalized_common and normalized_common in (resolved_policy.get("ambiguous_common_names") or {}):
        return {"display_name": scientific_name, "display_name_reason": "ambiguous_common"}

    return {"display_name": common_name, "display_name_reason": "unique_common"}
