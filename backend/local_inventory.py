"""The genomes present under the output directory: scanning assembly and release
folders, classifying their files, reading download manifests, and building the
local-assemblies listing the whole app reads."""

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import app_state
import config_store
import data_paths
import gff_index
from genome_identity import (
    DEFAULT_PROVIDER,
    NCBI_PROVIDER,
    genome_key as build_provider_aware_genome_key,
    genome_manifest_filename,
    iter_local_assembly_dirs,
    normalize_source_database,
    selection_key as build_dataset_selection_key,
)
from security_utils import require_path_within


FASTA_DOWNLOAD_SUFFIXES = (
    ".fa",
    ".fna",
    ".fasta",
    ".fa.gz",
    ".fna.gz",
    ".fasta.gz",
    ".fa.bgz",
    ".fna.bgz",
    ".fasta.bgz",
)


GFF3_DOWNLOAD_SUFFIXES = (".gff3", ".gff", ".gff3.gz", ".gff.gz", ".gff3.bgz", ".gff.bgz")


CDNA_DOWNLOAD_SUFFIXES = (".fa", ".fa.gz", ".fa.bgz", ".fasta", ".fasta.gz", ".fasta.bgz")


PROTEIN_DOWNLOAD_SUFFIXES = (".fa", ".fa.gz", ".fa.bgz", ".fasta", ".fasta.gz", ".fasta.bgz")


ASSEMBLY_SCOPED_FILE_TYPES = {"fasta", "metadata"}


DATASET_SCOPED_FILE_TYPES = {
    "gff3",
    "homology",
    "cdna",
    "protein",
    "xref",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
    "gtf",
    "embl",
    "alignment",
    "other_annotation",
    "other",
    "index",
}


DATASET_INDEX_ONLY_TYPES = {
    "index",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
}


LOCAL_MANIFEST_VERSION = 2


LEGACY_DATASET_RELEASE_KEY = "legacy/unknown"


def _has_any_suffix(filename: str, suffixes: Iterable[str]) -> bool:
    lower = str(filename or "").strip().lower()
    return any(lower.endswith(suffix) for suffix in suffixes)


def _classify_local_download_file(path: Path) -> str:
    name = path.name
    lower = name.lower()
    if lower.endswith(".index.db"):
        return "index"
    if lower.endswith(".tar.gz") and any(token in lower for token in (".lastz_net.", ".lastz_patch.", ".cactus_hal_pw.")):
        return "alignment"
    if lower.endswith((".gff3.bgz.csi", ".gff3.gz.tbi", ".gff3.csi", ".gff3.tbi")):
        return "gff3_index"
    if lower.endswith((".gtf.bgz.csi", ".gtf.gz.tbi", ".gtf.csi", ".gtf.tbi")):
        return "gtf_index"
    if "cdna" in lower and lower.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")):
        return "cdna_index"
    if ("pep" in lower or "protein" in lower) and lower.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")):
        return "protein_index"
    if data_paths._is_metadata_filename(lower):
        return "metadata"
    if _has_any_suffix(lower, GFF3_DOWNLOAD_SUFFIXES):
        return "gff3"
    if "cdna" in lower and _has_any_suffix(lower, CDNA_DOWNLOAD_SUFFIXES):
        return "cdna"
    if ("pep" in lower or "protein" in lower) and _has_any_suffix(lower, PROTEIN_DOWNLOAD_SUFFIXES):
        return "protein"
    if "xref" in lower and (lower.endswith(".tsv.gz") or lower.endswith(".tsv")):
        return "xref"
    if lower.endswith(".tsv.gz") or lower.endswith(".tsv"):
        return "homology"
    if _has_any_suffix(lower, FASTA_DOWNLOAD_SUFFIXES):
        return "fasta"
    if lower.endswith((".gtf.gz", ".gtf.bgz", ".gtf")):
        return "gtf"
    if lower.endswith((".embl.gz", ".embl")):
        return "embl"
    return ""


def _load_genome_manifest(assembly_dir: Path, assembly: str) -> Dict[str, Any]:
    manifest_path = assembly_dir / genome_manifest_filename(assembly)
    if not manifest_path.exists():
        return {}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _download_manifest_file_records(manifest: Dict[str, Any], dataset_release_key: str = "") -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    assembly_files = manifest.get("assembly_files") or {}
    if not dataset_release_key and isinstance(assembly_files, dict):
        for raw in assembly_files.values():
            if isinstance(raw, dict):
                records.append(raw)
    releases = manifest.get("dataset_releases") or {}
    if isinstance(releases, dict):
        for key, release in releases.items():
            if dataset_release_key and str(key or "") != str(dataset_release_key or ""):
                continue
            files = release.get("files") if isinstance(release, dict) else {}
            if isinstance(files, dict):
                for raw in files.values():
                    if isinstance(raw, dict):
                        records.append(raw)
    return records


def _is_download_managed_assembly(
    manifest: Dict[str, Any],
    asm_dir: Optional[Path] = None,
    assembly: str = "",
) -> bool:
    """Whether this assembly's files were downloaded by us, and so can be deleted.

    With a directory to look at, the answer is simply whether it holds any file we
    downloaded — which is what the delete endpoint acts on. The manifest alone can
    only answer for genomes downloaded after manifests started recording individual
    files; the ones before that list nothing at all.
    """
    if asm_dir is not None:
        deletable, _user_supplied = _downloaded_assembly_files(asm_dir, assembly, manifest or {})
        return bool(deletable)
    if not manifest:
        return False
    try:
        manifest_version = int(manifest.get("manifest_version") or 0)
    except Exception:
        manifest_version = 0
    if manifest_version >= LOCAL_MANIFEST_VERSION:
        return any(str(record.get("url") or "").strip() for record in _download_manifest_file_records(manifest))
    return False


def _user_supplied_manifest_paths(manifest: Dict[str, Any]) -> Set[str]:
    """Files the user brought in, which a delete must never remove.

    A custom annotation import records the file it copied with an empty ``url``;
    downloads always carry the URL they came from.
    """
    kept: Set[str] = set()
    for record in _download_manifest_file_records(manifest):
        if str(record.get("url") or "").strip():
            continue
        raw_path = str(record.get("path") or "").strip()
        if raw_path:
            kept.add(str(Path(raw_path)))
    return kept


def _downloaded_assembly_files(
    asm_dir: Path,
    assembly: str,
    manifest: Dict[str, Any],
    release_dir: Optional[Path] = None,
    legacy_release: bool = False,
    dataset_release_key: str = "",
) -> Tuple[List[Path], List[Path]]:
    """(deletable, user_supplied) files inside a managed assembly directory.

    The manifest is not enough on its own: genomes downloaded before manifests
    recorded individual files list nothing, and even a current manifest does not
    mention the sidecars we generate afterwards (``.fai``, ``.gzi``, tabix indexes,
    ``.index.db``). Every downloaded file is named after the assembly it belongs to
    (``GCA_000001405.29.gff3.gz``, ``GCF_000001405.40_GRCh38.p14_genomic.fna``)
    wherever it lands, so that prefix is what marks a file as ours to delete.
    User-supplied files are excluded: they live under ``datasets/custom/`` and are
    recorded in the manifest without a URL.
    """
    deletable: List[Path] = []
    user_supplied: List[Path] = []
    if not asm_dir.is_dir():
        return deletable, user_supplied

    accession = str(assembly or "").strip()
    # "<accession>." for our own naming, "<accession>_" for the NCBI names we keep
    # as downloaded; a bare prefix would also match a different assembly version.
    prefixes = (f"{accession}.", f"{accession}_")
    protected = _user_supplied_manifest_paths(manifest)

    # Only the directories downloads land in, so a large attached track hub is
    # neither walked nor touched.
    candidates: List[Path] = [p for p in asm_dir.iterdir() if p.is_file()] if asm_dir.is_dir() else []
    candidates.extend(p for p in (asm_dir / "assembly").rglob("*") if p.is_file())
    candidates.extend(p for p in (asm_dir / "datasets").rglob("*") if p.is_file())

    for path in sorted(candidates):
        if path.name.endswith(".genome_manifest.json"):
            continue
        parts = path.relative_to(asm_dir).parts
        if str(path) in protected or parts[:2] == ("datasets", "custom"):
            user_supplied.append(path)
            continue
        if not path.name.startswith(prefixes):
            continue
        if legacy_release:
            # Pre-manifest downloads sit directly in the assembly directory, and
            # only the annotation-scoped ones belong to that pseudo-release — the
            # genome FASTA and its sidecars stay.
            if path.parent != asm_dir:
                continue
            if _classify_local_download_file(path) not in DATASET_SCOPED_FILE_TYPES:
                continue
        elif release_dir is not None and not path.is_relative_to(release_dir):
            continue
        deletable.append(path)

    # Anything the manifest recorded with a URL but that does not carry the
    # prefix (an older naming convention) is ours too.
    for record in _download_manifest_file_records(manifest, dataset_release_key=dataset_release_key):
        if not str(record.get("url") or "").strip():
            continue
        raw_path = str(record.get("path") or "").strip()
        if not raw_path:
            continue
        try:
            path = require_path_within(asm_dir, Path(raw_path))
        except Exception:
            continue
        if path.is_file() and path not in deletable and str(path) not in protected:
            deletable.append(path)

    return deletable, user_supplied


_CUSTOM_FILES_DELETE_DETAIL = (
    "These files were supplied by you rather than downloaded, so they are left alone. "
    "Remove them from disk yourself."
)


def _release_label(source: str, date: str, explicit_label: str = "") -> str:
    if explicit_label:
        return explicit_label
    if source == NCBI_PROVIDER:
        return "RefSeq current" if date == "current" else f"RefSeq {date}"
    return f"{source or 'ensembl'} {date or 'unknown'}"


def _release_short_label(source: str, date: str, label: str = "") -> str:
    source_text = str(source or "").strip().lower()
    date_text = str(date or "").strip()
    label_text = str(label or "").strip()
    if source_text == "custom":
        return label_text or (f"custom {date_text.replace('_', '-')}" if date_text else "custom")
    # A demo release has only ever one version, so its date ("current") says nothing worth
    # the badge space; the label does.
    if source_text == "demo":
        return label_text or "Demo"
    if date_text and date_text != "unknown":
        return date_text.replace("_", "-")
    if label_text:
        return re.sub(r"^(ensembl|refseq)\s+", "", label_text, flags=re.IGNORECASE)
    return ""


def _prefer_local_file(existing: str, candidate: Path, file_type: str) -> str:
    if not existing:
        return str(candidate.resolve())
    lower = candidate.name.lower()
    current = Path(existing).name.lower()
    if file_type == "fasta":
        if "softmasked" in lower and "softmasked" not in current:
            return str(candidate.resolve())
        if "softmasked" not in current and len(lower) < len(current):
            return str(candidate.resolve())
    if file_type == "gff3":
        if lower.endswith("genes.gff3.gz") and not current.endswith("genes.gff3.gz"):
            return str(candidate.resolve())
        if lower.endswith("genes.gff3.bgz") and not current.endswith(("genes.gff3.gz", "genes.gff3.bgz")):
            return str(candidate.resolve())
    return existing


def _record_local_file(files: Dict[str, str], types: List[str], file_type: str, path: Path) -> None:
    if not file_type:
        return
    types.append(file_type)
    candidate = str(path.resolve())
    if file_type in files:
        files[file_type] = _prefer_local_file(files[file_type], path, file_type)
    else:
        files[file_type] = candidate


def _resolve_local_gff_index(gff_path: str, assembly: str = "") -> str:
    gff_text = str(gff_path or "").strip()
    if not gff_text:
        return ""
    try:
        gff = Path(gff_text).resolve()
        if not gff.is_file():
            return ""
        candidates = [
            p for p in gff.parent.iterdir()
            if p.is_file() and p.name.endswith(".index.db") and p.stat().st_size > 0
        ]
    except Exception:
        return ""
    if not candidates:
        return ""
    usable: List[str] = []
    for candidate in candidates:
        candidate_path = str(candidate.resolve())
        try:
            if gff_index._is_existing_index_usable(candidate_path, str(gff)):
                usable.append(candidate_path)
        except Exception:
            continue
    if usable:
        canonical_name = f"{assembly}.gff3.index.db" if assembly else ""
        return sorted(
            usable,
            key=lambda path: (
                bool(canonical_name) and Path(path).name != canonical_name,
                len(Path(path).name),
                Path(path).name,
            ),
        )[0]
    return str(sorted(candidates, key=lambda path: path.name)[0].resolve())


def _iter_nonempty_files(directory: Path) -> Iterable[Path]:
    if not directory.is_dir():
        return []
    results = []
    for f in sorted(directory.iterdir(), key=lambda p: p.name):
        if not f.is_file() or f.name.endswith(".tmp") or f.name.endswith(".genome_manifest.json"):
            continue
        try:
            if f.stat().st_size <= 0:
                continue
        except Exception:
            continue
        results.append(f)
    return results


def _scan_local_release_dir(release_dir: Path) -> Tuple[List[str], Dict[str, str]]:
    types: List[str] = []
    files: Dict[str, str] = {}
    for f in _iter_nonempty_files(release_dir):
        _record_local_file(files, types, _classify_local_download_file(f), f)
    return list(set(types)), files


def _scan_local_assembly(asm_dir: Path, assembly: str, manifest: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    manifest = manifest or _load_genome_manifest(asm_dir, assembly)
    assembly_types: List[str] = []
    assembly_files: Dict[str, str] = {}
    dataset_map: Dict[str, Dict[str, Any]] = {}

    def _ensure_release(key: str, source: str, date: str, label: str = "") -> Dict[str, Any]:
        entry = dataset_map.setdefault(key, {
            "key": key,
            "source": source,
            "date": date,
            "label": label or _release_label(source, date),
            "types": [],
            "files": {},
        })
        return entry

    for f in _iter_nonempty_files(asm_dir / "assembly"):
        file_type = _classify_local_download_file(f)
        if file_type in ASSEMBLY_SCOPED_FILE_TYPES:
            _record_local_file(assembly_files, assembly_types, file_type, f)

    for f in _iter_nonempty_files(asm_dir):
        file_type = _classify_local_download_file(f)
        if not file_type:
            continue
        if file_type in ASSEMBLY_SCOPED_FILE_TYPES:
            _record_local_file(assembly_files, assembly_types, file_type, f)
        elif file_type in DATASET_SCOPED_FILE_TYPES:
            rel = _ensure_release(LEGACY_DATASET_RELEASE_KEY, "legacy", "unknown", "Legacy local files")
            _record_local_file(rel["files"], rel["types"], file_type, f)

    datasets_root = asm_dir / "datasets"
    if datasets_root.is_dir():
        for source_dir in sorted(datasets_root.iterdir(), key=lambda p: p.name):
            if not source_dir.is_dir():
                continue
            for date_dir in sorted(source_dir.iterdir(), key=lambda p: p.name, reverse=True):
                if not date_dir.is_dir():
                    continue
                source = source_dir.name
                date = date_dir.name
                key = f"{source}/{date}"
                rel = _ensure_release(key, source, date)
                release_types, release_files = _scan_local_release_dir(date_dir)
                for t in release_types:
                    rel["types"].append(t)
                for t, path in release_files.items():
                    if t in rel["files"]:
                        rel["files"][t] = _prefer_local_file(rel["files"][t], Path(path), t)
                    else:
                        rel["files"][t] = path

    manifest_releases = manifest.get("dataset_releases") or {}
    if isinstance(manifest_releases, dict):
        for key, raw in manifest_releases.items():
            if not isinstance(raw, dict):
                continue
            parts = [part for part in str(key or "").split("/") if part]
            source = str(raw.get("source") or (parts[0] if parts else "legacy"))
            date = str(raw.get("date") or (parts[1] if len(parts) > 1 else "unknown"))
            rel = _ensure_release(str(key or f"{source}/{date}"), source, date, str(raw.get("label") or ""))
            rel["label"] = str(raw.get("label") or rel.get("label") or _release_label(source, date))

    dataset_releases = []
    for key, rel in list(dataset_map.items()):
        rel["types"] = sorted(set(rel.get("types") or []))
        files = rel.get("files") or {}
        # A generated/remote index without its parent annotation is not a usable
        # dataset release. This commonly occurs when a folder is manually removed
        # while an older index build is finishing; do not expose it as
        # "legacy unknown" in the selector.
        if files and set(files.keys()).issubset(DATASET_INDEX_ONLY_TYPES):
            dataset_map.pop(key, None)
            continue
        if files.get("gff3") and not files.get("index"):
            index_path = _resolve_local_gff_index(str(files.get("gff3") or ""), assembly)
            if index_path:
                files["index"] = index_path
                rel["files"] = files
                rel["types"] = sorted(set(list(rel.get("types") or []) + ["index"]))
        source = str(rel.get("source") or "")
        date = str(rel.get("date") or "")
        label = str(rel.get("label") or "")
        rel["label"] = label or _release_label(source, date)
        rel["short_label"] = _release_short_label(source, date, rel["label"])
        dataset_releases.append(rel)
    dataset_releases.sort(key=lambda r: (r.get("source") == "legacy", str(r.get("date") or "")))
    non_legacy = [r for r in dataset_releases if r.get("source") != "legacy"]
    legacy = [r for r in dataset_releases if r.get("source") == "legacy"]
    dataset_releases = sorted(non_legacy, key=lambda r: str(r.get("date") or ""), reverse=True) + legacy

    computed_default_release = next(
        (r for r in dataset_releases if r.get("source") not in {"legacy", "custom"} and (r.get("files") or {}).get("gff3")),
        None,
    ) or next(
        (r for r in dataset_releases if (r.get("files") or {}).get("gff3")),
        None,
    ) or (dataset_releases[0] if dataset_releases else None)
    saved_default_key = str(manifest.get("default_dataset_release_key") or "").strip()
    saved_default_release = dataset_map.get(saved_default_key) if saved_default_key else None
    if saved_default_release and (saved_default_release.get("files") or {}).get("gff3"):
        default_release = saved_default_release
    else:
        default_release = computed_default_release
    default_key = str((default_release or {}).get("key") or "")

    active_key = str(manifest.get("active_dataset_release_key") or "")
    if active_key not in dataset_map and dataset_releases:
        active_key = default_key or str(dataset_releases[0].get("key") or "")

    active_release = dataset_map.get(default_key) if default_key else (dataset_map.get(active_key) if active_key else None)
    files = dict(assembly_files)
    types = list(assembly_types)
    if active_release:
        files.update(active_release.get("files") or {})
        types.extend(active_release.get("types") or [])

    return {
        "assembly_files": assembly_files,
        "assembly_types": sorted(set(assembly_types)),
        "dataset_releases": dataset_releases,
        "active_dataset_release_key": active_key,
        "default_dataset_release_key": default_key,
        "files": files,
        "types": sorted(set(types)),
    }


def list_local_assemblies(output_dir: str):
    """Scan output_dir/local_data/ and return all locally downloaded assemblies with file paths.

    On a worker thread. This walks the whole local data directory, reading a manifest
    and scanning the files of every assembly it finds, and six different views fire it
    on mount — so on the event loop a single large or slow-disk collection stalled the
    entire backend every time the user moved between views.
    """
    local_root = data_paths._resolve_local_data_root(output_dir)
    results = []
    if not local_root.is_dir():
        return results

    # Build a lookup from species_key -> display info
    # Ensure cache is populated — it may be empty if /api/remote/species hasn't been called yet
    species_lookup = {}
    if not app_state.download_manager._species_cache and app_state.download_manager.species_data:
        app_state.download_manager._build_cache()

    if app_state.download_manager._species_cache:
        for s in app_state.download_manager._species_cache:
            species_lookup[s.key] = s
    else:
        # Fallback: build from raw data dict directly
        for key, info in app_state.download_manager.species_data.items():
            species_lookup[key] = {
                "scientific_name": info.get("scientific_name", key),
                "common_name": info.get("common_name", ""),
                "assemblies": {
                    gca: asm_data.get("name", gca)
                    for gca, asm_data in info.get("assemblies", {}).items()
                },
            }

    for provider, species_key, assembly, asm_dir in iter_local_assembly_dirs(local_root):
        manifest = _load_genome_manifest(asm_dir, assembly)
        scanned = _scan_local_assembly(asm_dir, assembly, manifest)
        download_managed = _is_download_managed_assembly(manifest, asm_dir, assembly)
        is_demo = bool(manifest.get("is_demo"))
        types = list(scanned.get("types") or [])
        files = dict(scanned.get("files") or {})

        # A genome is usable with a FASTA alone: the browser can show the
        # sequence plus any BigWig/BigBed/VCF tracks the user attaches. An
        # annotation adds the gene track but is not a precondition for browsing.
        if not types or not (files.get("gff3") or files.get("fasta")):
            continue
        has_annotation = bool(files.get("gff3"))

        gff_path = files.get("gff3") or ""
        if gff_path:
            default_release_key = str(scanned.get("default_dataset_release_key") or scanned.get("active_dataset_release_key") or "")
            default_release = next(
                (rel for rel in scanned.get("dataset_releases") or [] if rel.get("key") == default_release_key),
                None,
            )
            index_candidates = []
            if default_release:
                index_path = (default_release.get("files") or {}).get("index")
                if index_path:
                    index_candidates.append(Path(index_path))
            if not index_candidates:
                try:
                    gff_parent = Path(gff_path).resolve().parent
                    index_candidates = [
                        p for p in gff_parent.iterdir()
                        if p.is_file() and p.name.endswith(".index.db") and p.stat().st_size > 0
                    ]
                except Exception:
                    index_candidates = []
            if index_candidates:
                usable_indexes = []
                for candidate in index_candidates:
                    candidate_path = str(candidate.resolve())
                    try:
                        if gff_index._is_existing_index_usable(candidate_path, gff_path):
                            usable_indexes.append(candidate_path)
                    except Exception:
                        continue
                if usable_indexes:
                    canonical_name = f"{assembly}.gff3.index.db"
                    files["index"] = sorted(
                        usable_indexes,
                        key=lambda path: (Path(path).name != canonical_name, len(Path(path).name), Path(path).name),
                    )[0]
                elif "index" not in files and not default_release:
                    files["index"] = str(sorted(index_candidates, key=lambda path: path.name)[0].resolve())

        # Resolve display info
        scientific_name = str(manifest.get("scientific_name") or species_key.replace("_", " ").title()).strip()
        common_name = str(manifest.get("common_name") or "").strip()
        display_name = str(manifest.get("display_name") or "").strip()
        display_name_reason = str(manifest.get("display_name_reason") or "").strip()
        assembly_name = str(manifest.get("assembly_name") or assembly).strip()
        source_database = normalize_source_database(manifest.get("source_database"), provider, assembly)
        equivalent_accessions = [
            str(v).strip() for v in (manifest.get("equivalent_accessions") or []) if str(v).strip()
        ]

        sp = species_lookup.get(species_key)
        if sp:
            if hasattr(sp, "scientific_name"):
                scientific_name = sp.scientific_name or scientific_name
                common_name = sp.common_name or common_name
                display_name = getattr(sp, "display_name", "") or display_name
                display_name_reason = getattr(sp, "display_name_reason", "") or display_name_reason
                for a in sp.assemblies:
                    if a.gca == assembly or getattr(a, "accession", "") == assembly:
                        assembly_name = assembly_name or a.name
                        source_database = source_database or normalize_source_database(
                            getattr(a, "source_database", ""),
                            provider,
                            assembly,
                        )
                        equivalent_accessions = equivalent_accessions or list(getattr(a, "equivalent_accessions", []) or [])
                        break
            elif isinstance(sp, dict):
                scientific_name = sp.get("scientific_name") or scientific_name
                common_name = sp.get("common_name") or common_name
                display_name = sp.get("display_name") or display_name
                display_name_reason = sp.get("display_name_reason") or display_name_reason
                assembly_name = assembly_name or sp.get("assemblies", {}).get(assembly, assembly)

        genome_key = build_provider_aware_genome_key(species_key, assembly, provider)
        metadata = config_store._genome_key_display_metadata(genome_key)
        if metadata:
            # `_genome_key_display_metadata` always answers something: with nothing in the
            # configuration and nothing in the catalogue it falls back to a title-cased
            # species key. That is a reasonable last resort, but it must not overwrite a
            # manifest that knows the real name — a genome actually called "Ensemblus
            # welcomus" was being listed everywhere as "Ensemblus Welcomus".
            derived_only = (
                not metadata.get("common_name")
                and metadata.get("scientific_name") == config_store._format_species_key_for_display(species_key)
            )
            if not (derived_only and scientific_name):
                scientific_name = metadata.get("scientific_name") or scientific_name
                common_name = metadata.get("common_name") or common_name
                display_name = metadata.get("display_name") or display_name
                display_name_reason = metadata.get("display_name_reason") or display_name_reason
            if config_store._is_useful_assembly_name(metadata.get("assembly_name"), assembly):
                assembly_name = metadata["assembly_name"]
        if not display_name:
            display_name = common_name or scientific_name
            display_name_reason = "unique_common" if common_name else "missing_common"

        assembly_key = build_provider_aware_genome_key(species_key, assembly, provider)
        default_release_key = str(scanned.get("default_dataset_release_key") or scanned.get("active_dataset_release_key") or "")
        default_release = next(
            (rel for rel in scanned.get("dataset_releases") or [] if rel.get("key") == default_release_key),
            None,
        )
        default_release_source = str((default_release or {}).get("source") or "")
        default_release_date = str((default_release or {}).get("date") or "")
        default_release_label = str((default_release or {}).get("label") or "")
        default_release_short_label = str((default_release or {}).get("short_label") or _release_short_label(default_release_source, default_release_date, default_release_label))
        default_selection_key = build_dataset_selection_key(
            species_key,
            assembly,
            provider,
            default_release_key,
            False,
        )

        base_record = {
            "provider": provider,
            "source_database": source_database,
            "species_key": species_key,
            "assembly": assembly,
            "gca": assembly if assembly.upper().startswith("GC") else "",
            "scientific_name": scientific_name,
            "common_name": common_name,
            "display_name": display_name,
            "display_name_reason": display_name_reason,
            "assembly_name": assembly_name,
            "equivalent_accessions": equivalent_accessions,
            "types": list(set(types)),
            "files": files,
            "has_annotation": has_annotation,
            "assembly_files": scanned.get("assembly_files") or {},
            "assembly_types": scanned.get("assembly_types") or [],
            "assembly_key": assembly_key,
            "selection_key": default_selection_key,
            "dataset_release_key": default_release_key,
            "dataset_release_source": default_release_source,
            "dataset_release_date": default_release_date,
            "dataset_release_label": default_release_label,
            "dataset_release_short_label": default_release_short_label,
            "active_dataset_release_key": scanned.get("active_dataset_release_key") or "",
            "default_dataset_release_key": default_release_key,
            "dataset_releases": scanned.get("dataset_releases") or [],
            "download_managed": download_managed,
            "delete_blocked_reason": "" if download_managed else _CUSTOM_FILES_DELETE_DETAIL,
            "is_demo": is_demo,
            # Carried through from the manifest so the record stays self-describing. A
            # tutorial's genomes are held as the catalogue's records rather than the
            # records the install returned, and registering one as browsable is refused
            # unless it can say which generated dataset it is — dropping this here left
            # every re-registration answering 400 and the genome browser unable to
            # recover the tutorial's genomes after a backend restart.
            "tutorial_dataset_id": str(manifest.get("tutorial_dataset_id") or ""),
            # The demo genome is not in any remote catalogue and never will be, so the
            # usual "we could not find this upstream" reasoning does not apply to it.
            "retired_remote": (not is_demo) and not (
                species_key in species_lookup
                and (
                    (
                        hasattr(species_lookup.get(species_key), "assemblies")
                        and any(
                            a.gca == assembly or getattr(a, "accession", "") == assembly
                            for a in getattr(species_lookup.get(species_key), "assemblies", []) or []
                        )
                    )
                    or (
                        isinstance(species_lookup.get(species_key), dict)
                        and assembly in ((species_lookup.get(species_key) or {}).get("assemblies") or {})
                    )
                )
            ) and provider == DEFAULT_PROVIDER,
        }

        dataset_instances = []
        for release in scanned.get("dataset_releases") or []:
            release_files = dict(release.get("files") or {})
            if not release_files.get("gff3"):
                continue
            release_key = str(release.get("key") or "")
            release_source = str(release.get("source") or "")
            release_date = str(release.get("date") or "")
            release_label = str(release.get("label") or _release_label(release_source, release_date))
            instance_files = {
                **(scanned.get("assembly_files") or {}),
                **release_files,
            }
            instance_types = sorted(set(list(scanned.get("assembly_types") or []) + list(release.get("types") or [])))
            dataset_instances.append({
                **base_record,
                "types": instance_types,
                "files": instance_files,
                "selection_key": build_dataset_selection_key(
                    species_key,
                    assembly,
                    provider,
                    release_key,
                    False,
                ),
                "dataset_release_key": release_key,
                "dataset_release_source": release_source,
                "dataset_release_date": release_date,
                "dataset_release_label": release_label,
                "dataset_release_short_label": str(release.get("short_label") or _release_short_label(release_source, release_date, release_label)),
                "is_default_dataset": release_key == default_release_key,
                "dataset_release": release,
            })
        base_record["dataset_instances"] = dataset_instances
        results.append(base_record)
    return results
