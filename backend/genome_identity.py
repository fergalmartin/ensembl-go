from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, Iterator, List, Optional, Tuple


DEFAULT_PROVIDER = "ensembl"
NCBI_PROVIDER = "ncbi"
MANUAL_PROVIDER = "manual"
DEMO_PROVIDER = "demo"
DATASET_SELECTION_SEPARATOR = "::dataset::"
_STORAGE_PROVIDER_DIRS = {NCBI_PROVIDER}


def normalize_provider(value: Any, is_manual: bool = False) -> str:
    raw = str(value or "").strip().lower()
    if raw:
        return raw
    return MANUAL_PROVIDER if is_manual else DEFAULT_PROVIDER


def infer_source_database(provider: Any, assembly: Any = "") -> str:
    normalized_provider = normalize_provider(provider)
    accession = str(assembly or "").strip().upper()
    if normalized_provider == DEFAULT_PROVIDER:
        return "Ensembl"
    if normalized_provider == MANUAL_PROVIDER:
        return "Manual"
    if normalized_provider == NCBI_PROVIDER:
        if accession.startswith("GCF_"):
            return "RefSeq"
        if accession.startswith("GCA_"):
            return "GenBank"
        return "NCBI"
    return normalized_provider.replace("_", " ").title()


def normalize_source_database(value: Any, provider: Any = "", assembly: Any = "") -> str:
    raw = str(value or "").strip()
    if raw:
        return raw
    return infer_source_database(provider, assembly)


def get_assembly_accession(value: Any, fallback: Any = "") -> str:
    primary = str(value or "").strip()
    if primary:
        return primary
    return str(fallback or "").strip()


def legacy_genome_key(species_key: Any, assembly: Any) -> str:
    species = str(species_key or "").strip()
    accession = str(assembly or "").strip()
    if not species or not accession:
        return ""
    return f"{species}::{accession}"


def genome_key(
    species_key: Any,
    assembly: Any,
    provider: Any = "",
    is_manual: bool = False,
) -> str:
    species = str(species_key or "").strip()
    accession = str(assembly or "").strip()
    if not species or not accession:
        return ""
    normalized_provider = normalize_provider(provider, is_manual=is_manual)
    return f"{normalized_provider}::{species}::{accession}"


def strip_dataset_release_from_selection_key(value: Any) -> str:
    token = str(value or "").strip()
    marker = DATASET_SELECTION_SEPARATOR
    if marker in token:
        return token.split(marker, 1)[0].strip()
    return token


def dataset_release_key_from_selection_key(value: Any) -> str:
    token = str(value or "").strip()
    marker = DATASET_SELECTION_SEPARATOR
    if marker in token:
        return token.split(marker, 1)[1].strip()
    return ""


def selection_key(
    species_key: Any,
    assembly: Any,
    provider: Any = "",
    dataset_release_key: Any = "",
    is_manual: bool = False,
) -> str:
    base = genome_key(species_key, assembly, provider, is_manual=is_manual)
    release = str(dataset_release_key or "").strip()
    if not base:
        return ""
    return f"{base}{DATASET_SELECTION_SEPARATOR}{release}" if release else base


def selection_key_from_record(record: Optional[dict]) -> str:
    raw = record or {}
    explicit = str(raw.get("selection_key") or "").strip()
    if explicit:
        return explicit
    species_key = str(raw.get("species_key") or "").strip()
    assembly = str(raw.get("assembly") or raw.get("gca") or "").strip()
    release_key = str(raw.get("dataset_release_key") or "").strip()
    return selection_key(
        species_key,
        assembly,
        raw.get("provider"),
        release_key,
        bool(raw.get("is_manual")),
    )


def genome_key_candidates(record: Optional[dict]) -> List[str]:
    raw = record or {}
    species_key = str(raw.get("species_key") or "").strip()
    assembly = str(raw.get("assembly") or raw.get("gca") or "").strip()
    if not species_key or not assembly:
        return []
    provider = normalize_provider(raw.get("provider"), is_manual=bool(raw.get("is_manual")))
    keys = []
    selected = selection_key_from_record(raw)
    if selected:
        keys.append(selected)
    assembly_key = genome_key(species_key, assembly, provider, bool(raw.get("is_manual")))
    if assembly_key and assembly_key not in keys:
        keys.append(assembly_key)
    legacy = legacy_genome_key(species_key, assembly)
    if legacy and legacy not in keys:
        keys.append(legacy)
    return keys


def parse_genome_key(value: Any, default_provider: str = DEFAULT_PROVIDER) -> Tuple[str, str, str]:
    token = strip_dataset_release_from_selection_key(value)
    if not token:
        return normalize_provider(default_provider), "", ""
    parts = token.split("::")
    if len(parts) >= 3:
        provider = normalize_provider(parts[0])
        species_key = parts[1].strip()
        assembly = "::".join(parts[2:]).strip()
        return provider, species_key, assembly
    if len(parts) == 2:
        return normalize_provider(default_provider), parts[0].strip(), parts[1].strip()
    return normalize_provider(default_provider), "", token


def storage_path_parts(provider: Any, species_key: Any, assembly: Any) -> Tuple[str, ...]:
    normalized_provider = normalize_provider(provider)
    species = str(species_key or "").strip()
    accession = str(assembly or "").strip()
    if normalized_provider in {"", DEFAULT_PROVIDER}:
        return species, accession
    return normalized_provider, species, accession


def parse_local_data_relative_parts(parts: Iterable[str]) -> Tuple[str, str, str]:
    values = [str(part or "").strip() for part in parts if str(part or "").strip()]
    if len(values) >= 3 and values[0] in _STORAGE_PROVIDER_DIRS:
        return values[0], values[1], values[2]
    if len(values) >= 2:
        return DEFAULT_PROVIDER, values[0], values[1]
    return DEFAULT_PROVIDER, "", ""


def iter_local_assembly_dirs(local_root: Path) -> Iterator[Tuple[str, str, str, Path]]:
    if not local_root or not local_root.is_dir():
        return
    for first_level in sorted(local_root.iterdir()):
        if not first_level.is_dir():
            continue
        name = first_level.name
        # Demo is a provider directory only inside the disposable tutorial workspace.
        # Treating every top-level `local_data/demo` directory this way would reclassify
        # a perfectly valid legacy species whose key happened to be "demo".
        is_tutorial_demo_provider = name == DEMO_PROVIDER and ".ensembl_go_tutorial" in local_root.parts
        if name in _STORAGE_PROVIDER_DIRS or is_tutorial_demo_provider:
            provider = name
            for species_dir in sorted(first_level.iterdir()):
                if not species_dir.is_dir():
                    continue
                for asm_dir in sorted(species_dir.iterdir()):
                    if asm_dir.is_dir():
                        yield provider, species_dir.name, asm_dir.name, asm_dir
            continue
        for asm_dir in sorted(first_level.iterdir()):
            if asm_dir.is_dir():
                yield DEFAULT_PROVIDER, first_level.name, asm_dir.name, asm_dir


def is_assembly_report_filename(filename: Any) -> bool:
    name = str(filename or "").strip().lower()
    return name.endswith("assembly_report.txt") or name.endswith("assembly_report.txt.gz")


def is_sequence_report_filename(filename: Any) -> bool:
    name = str(filename or "").strip().lower()
    return "sequence_report" in name and (
        name.endswith(".json")
        or name.endswith(".jsonl")
        or name.endswith(".tsv")
        or name.endswith(".tsv.gz")
    )


def is_metadata_filename(filename: Any) -> bool:
    return is_assembly_report_filename(filename) or is_sequence_report_filename(filename)


def genome_manifest_filename(assembly: Any) -> str:
    accession = str(assembly or "").strip() or "genome"
    return f"{accession}.genome_manifest.json"


#: Annotation extensions stripped when naming a file derived from an annotation,
#: so a GTF does not produce `<name>.gtf.gz.gff3.index.db` and a RefSeq `.gff`
#: does not produce `<name>.gff.stats.v1.json`.
_ANNOTATION_SUFFIX_RE = re.compile(
    r"\.(?:ensembl\.)?(gff3|gff|gtf|gff2)(\.(?:gz|bgz))?$", re.IGNORECASE
)


def annotation_name_stem(filename: Any, fallback: str = "genome") -> str:
    """`braker.gtf.gz` -> `braker`; the stem derived files are named from."""
    name = Path(str(filename or "")).name
    return _ANNOTATION_SUFFIX_RE.sub("", name) or fallback
